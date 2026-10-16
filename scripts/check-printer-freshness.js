// Printer status must not lie about "now".
//
// The problem this guards: admin showed a green ONLINE badge over a reading
// that was 25 hours old, and reported four full toners for a printer that had
// never been heard from at all. Two separate faults fed that:
//
//   1. Freshness was judged in the browser against a hardcoded 15 minutes,
//      with no relationship to how often the worker actually polls (300 by
//      default). Nothing recorded the expected cadence, so a worker that
//      stopped reporting entirely still looked healthy.
//   2. With no printer_status row, getStats() invented status 'online' and
//      100% on every toner.
//
// And one that made the misdiagnosis hard to act on: a reply carrying only a
// Brother serial ("BRW145A41F176AD") was reported as a confident "wrong
// printer" verdict, sending staff after a second Brother that was never
// involved.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const worker = read('pi/print-worker.py');
const backend = read('netlify/functions/printer.js');
const adminFn = read('netlify/functions/admin.js');
const admin = read('admin/admin.html');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

// --- the worker must say how often it polls --------------------------------
ok(/"poll_interval":\s*CONFIG\["supply_seconds"\]/.test(worker),
  'the worker reports its own poll interval with each reading');

// The old default meant a printer that had just gone offline stayed green for
// five minutes, because nothing updates until the next poll.
const interval = worker.match(/PRINT_SUPPLY_SECONDS",\s*"(\d+)"/);
ok(!!interval && Number(interval[1]) <= 60,
  'the default poll interval is short enough to notice an offline printer ('
  + (interval ? interval[1] + 's' : 'not found') + ')');

ok(/def _names_a_model/.test(worker),
  'a helper distinguishes a model string from a bare serial');
ok(/_names_a_model\(identity\)/.test(worker),
  'the wrong-printer verdict is only reached when a model was actually named');
// The old code lumped both together, so a serial-only reply accused the shop
// of pointing at the wrong machine.
ok(/reported no model/.test(worker) && /cannot be confirmed/.test(worker),
  'a serial-only reply says the model is unconfirmed, not "wrong printer"');

// --- the backend must store and judge freshness ----------------------------
ok(/row\.poll_interval\s*=/.test(backend),
  'the backend stores the reported interval');
ok(/migrations\/20261016_printer_status_poll_interval/.test(adminFn + backend),
  'the interval column is documented by a migration');
ok(/function freshnessOf/.test(adminFn),
  'freshness is computed on the server, not guessed per page');
ok(/printer_freshness: printerFreshness/.test(adminFn),
  'the stats response carries the freshness verdict');
ok(/DEFAULT_POLL_SECONDS/.test(adminFn),
  'a fallback interval exists for a worker that has never reported one');

// Jitter tolerance: one late poll must not paint a working printer red, but
// three silent polls must.
ok(/every \* 2\.5/.test(adminFn),
  'stale means two and a half missed polls, so a late poll is not a false alarm');

// --- the admin must not present a stale reading as current -----------------
ok(/window\.__printerFresh\s*=\s*data\.printer_freshness/.test(admin),
  'admin uses the server verdict rather than re-deriving it');
ok(/badge\.textContent = 'STALE'/.test(admin),
  'the badge itself reports STALE, not just a small line underneath it');
// This was the misleading part: the badge kept saying ONLINE while only the
// caption admitted the reading was old. Staff read the badge.
ok(/badge\.title = 'Last known: '/.test(admin),
  'the stale badge still surfaces the last known state');
ok(!/mins > 15/.test(admin),
  'admin no longer hardcodes a 15-minute freshness window');
ok(/const level = \(v\) => \(\(v === null[\s\S]{0,80}isStale\)/.test(admin),
  'levels from a stale reading render as Unknown, not as live numbers');
ok(/function ageFormat/.test(admin),
  'age is formatted in seconds/minutes/hours/days');

// --- absent data must never read as healthy -------------------------------
ok(!/status: 'online', paper_level: 100, toner_black: 100/.test(adminFn),
  'getStats no longer invents online + full toners when there is no row');
ok(/printer has never reported/i.test(adminFn),
  'an absent printer row carries a reason rather than a reassuring default');

// --- and the rule must actually behave, not merely read correctly ---------
// Asserting on source text proves the code says the right thing. It does not
// prove the arithmetic is right, and the arithmetic is the whole point: a
// threshold that is too tight paints a working printer red, and one that is
// too loose is the original bug wearing a new hat. So run it.
const body = adminFn.match(/function freshnessOf[\s\S]*?\n\}/);
const constant = adminFn.match(/const DEFAULT_POLL_SECONDS = \d+;/);
ok(!!body && !!constant, 'freshnessOf and its fallback constant were found');

if (body && constant) {
  const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
  // Built as a real function so DEFAULT_POLL_SECONDS is in scope, which is why
  // this could not simply be eval'd inline.
  const freshnessOf = new Function(
    constant[0].replace(/^const /, '') + '\n' + body[0] + '\nreturn freshnessOf;')();
  const f = (row) => freshnessOf(row);

  ok(f({ last_checked: null, poll_interval: null }).stale === true,
    'a printer that has never reported is stale, not healthy');
  ok(f({ last_checked: ago(60), poll_interval: 60 }).stale === false,
    'a reading one poll old is current');
  // The jitter allowance. A poll landing a moment late must not alarm staff.
  ok(f({ last_checked: ago(120), poll_interval: 60 }).stale === false,
    'one missed poll is tolerated rather than raising a false alarm');
  ok(f({ last_checked: ago(240), poll_interval: 60 }).stale === true,
    'two and a half missed polls is stale');
  // The window must follow the worker, not a constant. With a 300s poll, five
  // minutes is on time; with a 60s poll it is five missed polls.
  ok(f({ last_checked: ago(300), poll_interval: 300 }).stale === false,
    'the window follows the reported interval, so a legacy 300s worker is not punished');
  // The actual reading from the reported bug: a day old, must never read live.
  ok(f({ last_checked: ago(1512), poll_interval: 300 }).stale === true,
    'the 25-hour-old reading that started this is correctly stale');
  ok(f({ last_checked: ago(1512), poll_interval: 300 }).age_seconds > 1500,
    'the age is reported so the dashboard can say how old it is');
  // Absent interval must not produce a zero-length window that marks
  // everything stale, nor an infinite one that marks nothing stale.
  ok(f({ last_checked: ago(60), poll_interval: null }).stale === false,
    'a worker that has not reported an interval yet falls back sensibly');
}

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      printer status is current when it is current, and admits when it is not');