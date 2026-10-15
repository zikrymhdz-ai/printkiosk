// The kiosk must quote the SAME amount the payment matcher is waiting for.
//
// This is the failure that made payments invisible: the kiosk added up the
// per-job total_price, while the matcher decides what to look for from
// order_total. For an order of several jobs those two figures differ, because
// the sum carries every job's own small match fee while order_total is the
// items plus ONE fee for the whole payment. The customer paid what the kiosk
// showed and nothing matched.
//
// Rather than assert that both files mention order_total, this runs BOTH
// implementations - the real one from payment.js and the real one from the
// kiosk - over the same orders and requires identical answers.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const paymentSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/payment.js'), 'utf8');
const kioskSrc = fs.readFileSync(path.join(ROOT, 'kiosk/walkin.html'), 'utf8');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

const serverAmount = vm.runInNewContext(
  extractFn(paymentSrc, 'orderAmountOf') + '; orderAmountOf;', {}, { timeout: 2000 });
const kioskAmount = vm.runInNewContext(
  extractFn(kioskSrc, 'orderAmountOf') + '; orderAmountOf;', {}, { timeout: 2000 });

ok(typeof serverAmount === 'function' && typeof kioskAmount === 'function',
  'both implementations were extracted');

// --- the orders that actually occur ----------------------------------------
const cases = [
  // One sealed job: order_total is authoritative.
  { name: 'one sealed job', jobs: [{ job_id: 'A', order_total: 1.31, total_price: 1.31 }] },
  // THE REPORTED CASE: two jobs in one order. The sum of the job totals carries
  // two match fees; order_total carries one.
  { name: 'colour + B&W, sealed', jobs: [
    { job_id: 'A', order_id: 'o1', order_total: 1.31, total_price: 1.11 },
    { job_id: 'B', order_id: 'o1', order_total: 1.31, total_price: 0.21 },
  ] },
  // Three jobs, sealed.
  { name: 'three sealed jobs', jobs: [
    { job_id: 'A', order_id: 'o1', order_total: 2.05, total_price: 1.02 },
    { job_id: 'B', order_id: 'o1', order_total: 2.05, total_price: 1.02 },
    { job_id: 'C', order_id: 'o1', order_total: 2.05, total_price: 0.01 },
  ] },
  // Legacy rows with no sealed total: both must fall back the same way.
  { name: 'unsealed legacy job', jobs: [{ job_id: 'A', total_price: 0.41 }] },
  { name: 'unsealed legacy, two jobs', jobs: [
    { job_id: 'A', total_price: 0.21 }, { job_id: 'B', total_price: 0.21 },
  ] },
  // Explicit null is "not sealed", which is different from absent.
  { name: 'explicit null order_total', jobs: [{ job_id: 'A', order_total: null, total_price: 0.41 }] },
  // A partially sealed order must fall back rather than half-apply.
  { name: 'only one of two sealed', jobs: [
    { job_id: 'A', order_total: 1.00, total_price: 1.00 },
    { job_id: 'B', order_total: null, total_price: 1.00 },
  ] },
  { name: 'single page colour job', jobs: [{ job_id: 'A', order_total: 1.11, total_price: 1.11 }] },
];

for (const c of cases) {
  const server = serverAmount(c.jobs);
  const kiosk = kioskAmount(c.jobs);
  ok(Math.abs(server - kiosk) < 0.000001,
    c.name + ': kiosk RM' + kiosk.toFixed(2) + ' = matcher RM' + server.toFixed(2));
}

// --- the reported case must actually differ from the old sum ---------------
{
  const jobs = [
    { job_id: 'A', order_id: 'o1', order_total: 1.31, total_price: 1.11 },
    { job_id: 'B', order_id: 'o1', order_total: 1.31, total_price: 0.21 },
  ];
  const oldSum = jobs.reduce((s, j) => s + j.total_price, 0);
  const correct = kioskAmount(jobs);
  ok(Math.abs(oldSum - correct) > 0.005,
    'summing total_price really did give a different number (RM' + oldSum.toFixed(2)
    + ' vs RM' + correct.toFixed(2) + ') - this is the bug that was fixed');
}

// --- nothing else on the kiosk may quote its own arithmetic ----------------
// The only remaining sum of total_price is the documented fallback INSIDE the
// helper. Anywhere else would be a second, independent quote.
// Comments are stripped first: the helper's explanation names total_price on
// purpose, and prose is not a quote.
const codeOnly = kioskSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '');
const helper = extractFn(codeOnly, 'orderAmountOf');
const insideHelper = (helper.match(/total_price/g) || []).length;
const outsideHelper = (codeOnly.match(/total_price/g) || []).length - insideHelper;
ok(insideHelper === 1, 'the fallback sum lives inside the helper, found ' + insideHelper);
ok(outsideHelper === 0,
  'no code outside the helper reads total_price, so there is no second quote (found ' + outsideHelper + ')');

ok(/order_total/.test(helper), 'the kiosk helper reads order_total');
ok(/netlify\/functions\/payment\.js/.test(kioskSrc),
  'the kiosk names the implementation it is mirroring, so the next reader knows');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      the kiosk always quotes the amount the matcher is waiting for');
