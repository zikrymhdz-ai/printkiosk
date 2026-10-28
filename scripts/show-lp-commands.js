// Print the lp command lines the worker would run, for a named scenario.
//
// Executes the real send_to_printer() from pi/print-worker.py with run_lp()
// replaced by a recorder, so what is checked is the actual argument list the
// printer receives, not a description of it.
//
//   node scripts/show-lp-commands.js [scenario]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WORKER = path.join(__dirname, '..', 'pi', 'print-worker.py');

const SCENARIOS = {
  merged: {
    label: 'merged: 3 B&W pages then 2 colour pages (the reported case)',
    job: {
      job_id: 'PRN-TEST', pages: 5, color_mode: 'color', sides: 'single', copies: 1,
      color_runs: '[{"from":1,"to":3,"color":"bw"},{"from":4,"to":5,"color":"color"}]',
    },
  },
  colourfirst: {
    label: 'merged: 2 colour pages then 2 B&W pages',
    job: {
      job_id: 'PRN-TEST', pages: 4, color_mode: 'color', sides: 'single', copies: 1,
      color_runs: '[{"from":1,"to":2,"color":"color"},{"from":3,"to":4,"color":"bw"}]',
    },
  },
  threeruns: {
    label: 'merged: colour, B&W, colour',
    job: {
      job_id: 'PRN-TEST', pages: 6, color_mode: 'color', sides: 'single', copies: 1,
      color_runs: '[{"from":1,"to":2,"color":"color"},{"from":3,"to":4,"color":"bw"},{"from":5,"to":6,"color":"color"}]',
    },
  },
  plain: {
    label: 'an ordinary single-mode colour job (must stay ONE submission)',
    job: { job_id: 'PRN-TEST', pages: 2, color_mode: 'color', sides: 'single', copies: 2 },
  },
  bw: {
    label: 'an ordinary single-mode B&W job',
    job: { job_id: 'PRN-TEST', pages: 1, color_mode: 'bw', sides: 'double', copies: 1 },
  },
  broken: {
    label: 'a corrupt layout falls back to one submission, never a bad page range',
    job: {
      job_id: 'PRN-TEST', pages: 5, color_mode: 'color', sides: 'single', copies: 1,
      color_runs: '[{"from":1,"to":3,"color":"bw"},{"from":9,"to":12,"color":"color"}]',
    },
  },
  onemode: {
    label: 'a layout that is all one mode must not be split',
    job: {
      job_id: 'PRN-TEST', pages: 4, color_mode: 'bw', sides: 'single', copies: 1,
      color_runs: '[{"from":1,"to":2,"color":"bw"},{"from":3,"to":4,"color":"bw"}]',
    },
  },
};

const src = fs.readFileSync(WORKER, 'utf8');
const start = src.indexOf('def _color_runs(');
const end = src.indexOf('def read_supplies');
if (start < 0 || end < 0) throw new Error('could not locate the print functions in the worker');

// The real functions, lifted verbatim, with the three things they touch
// replaced. printer_option_names() decides whether colour is sent as the
// Brother PPD option (ColorModel) or the IPP Everywhere one
// (print-color-mode); both queue kinds are exercised below.
function makeScript(queueOptions) {
  return [
    'import json, sys, re',
    '',
    'calls = []',
    '',
    'class _P:',
    '    returncode = 0',
    '    stdout = "request id is Brother-99 (1 file(s))"',
    '    stderr = ""',
    '',
    'def run_lp(args, timeout=None):',
    '    calls.append(args)',
    '    return _P()',
    '',
    'def printer_option_names(printer):',
    '    return set(' + JSON.stringify(queueOptions) + ')',
    '',
    'def log(msg):',
    '    pass',
    '',
    'CONFIG = {',
    '    "printer": "Brother",',
    '    "printer_uri": "ipp://10.100.138.65:631/ipp/print",',
    '    "queue_timeout": 180,',
    '}',
    '',
    src.slice(start, end),
    '',
    'ok, res = send_to_printer("/tmp/job.pdf", json.loads(sys.argv[1]))',
    'print(json.dumps({"ok": ok, "result": res, "calls": calls}))',
    '',
  ].join('\n');
}

// A driverless IPP Everywhere queue (what `lpadmin -v ipp://...` creates) and a
// Brother-driver PPD queue do not accept the same colour option name.
const QUEUES = {
  ppd: ['colormodel', 'pagesize'],
  ipp: ['print-color-mode', 'media', 'sides'],
};

const COLOR = {
  ppd: { bw: 'ColorModel=Gray', color: 'ColorModel=RGB' },
  ipp: { bw: 'print-color-mode=monochrome', color: 'print-color-mode=color' },
};

const argsOf = (c) => {
  const opts = [];
  for (let i = 0; i < c.length - 1; i++) {
    if (c[i] === '-o') opts.push(c[i + 1]);
    if (c[i] === '-n') opts.push('copies=' + c[i + 1]);
  }
  return opts;
};

function runOne(name, queue) {
  const sc = SCENARIOS[name];
  const tmp = path.join(os.tmpdir(), 'pk-lp-probe-' + process.pid + '-' + name + '-' + queue + '.py');
  fs.writeFileSync(tmp, makeScript(QUEUES[queue]), 'utf8');
  try {
    const out = execFileSync('python', [tmp, JSON.stringify(sc.job)], { encoding: 'utf8' });
    return { label: sc.label, result: JSON.parse(out.trim().split('\n').pop()) };
  } finally {
    fs.unlinkSync(tmp);
  }
}

// --check asserts every scenario on BOTH queue kinds, so this doubles as the
// test that the printer receives what the merge promised AND that colour is
// spelled the way that queue accepts it. @bw / @color are replaced per queue.
const EXPECTED = {
  merged: [
    ['media=A4', '@bw', 'page-ranges=1-3', 'sides=one-sided'],
    ['media=A4', '@color', 'page-ranges=4-5', 'sides=one-sided'],
  ],
  colourfirst: [
    ['media=A4', '@color', 'page-ranges=1-2', 'sides=one-sided'],
    ['media=A4', '@bw', 'page-ranges=3-4', 'sides=one-sided'],
  ],
  threeruns: [
    ['media=A4', '@color', 'page-ranges=1-2', 'sides=one-sided'],
    ['media=A4', '@bw', 'page-ranges=3-4', 'sides=one-sided'],
    ['media=A4', '@color', 'page-ranges=5-6', 'sides=one-sided'],
  ],
  plain: [['copies=2', 'media=A4', '@color', 'sides=one-sided']],
  bw: [['media=A4', '@bw', 'sides=two-sided-long-edge']],
  // The point of the validator: a bad layout must never reach an lp command line.
  broken: [['media=A4', '@color', 'sides=one-sided']],
  onemode: [['media=A4', '@bw', 'sides=one-sided']],
};

if (process.argv.includes('--check')) {
  let failed = 0;
  for (const queue of Object.keys(QUEUES)) {
    for (const name of Object.keys(SCENARIOS)) {
      let r;
      try {
        r = runOne(name, queue).result;
      } catch (e) {
        console.log('  FAILED  ' + name + ' [' + queue + '] - the worker raised while printing');
        failed++;
        continue;
      }
      const got = r.calls.map(argsOf);
      const want = EXPECTED[name].map(opts => opts.map(o =>
        o === '@bw' ? COLOR[queue].bw : o === '@color' ? COLOR[queue].color : o));
      const same = got.length === want.length
        && got.every((opts, i) => opts.join(' ') === want[i].join(' '));
      console.log((same ? '  ok      ' : '  FAILED  ') + name + ' [' + queue + '] -> ' + r.calls.length + ' lp call(s)');
      if (!same) {
        console.log('      want ' + JSON.stringify(want));
        console.log('      got  ' + JSON.stringify(got));
        failed++;
      }
    }
  }
  if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
  console.log('  ok      the printer receives one colour mode per colour run, spelled for its queue');
  process.exit(0);
}

const key = process.argv[2] || 'merged';
const queue = process.argv[3] || 'ipp';

if (!SCENARIOS[key]) {
  console.error('  unknown scenario: ' + key);
  console.error('  available: ' + Object.keys(SCENARIOS).join(', '));
  process.exit(1);
}

const r = runOne(key, queue).result;
console.log('  ' + SCENARIOS[key].label);
console.log('  ok=' + r.ok + (r.ok ? '' : '   error=' + r.result));
console.log('  lp invocations: ' + r.calls.length);
for (const c of r.calls) {
  console.log('    ' + argsOf(c).join('  ') + '   ' + path.basename(c[c.length - 1]));
}