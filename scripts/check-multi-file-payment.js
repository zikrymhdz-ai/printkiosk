// Multi-file payment matching.
//
// Uploading two files creates two print_jobs, but the customer pays ONCE for
// the combined total. handleNlsReceived compared the payment amount against a
// single job's total_price, so a two-file payment of RM1.52 matched nothing at
// all - no job carries that total - and was reported as "no_match" while the
// customer waited at the kiosk.
//
// findBundles() searches for a subset of one customer's pending jobs whose
// totals sum to the payment. This exercises the real shipped functions,
// extracted from payment.js so it cannot drift from the implementation.
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('netlify/functions/payment.js', 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('cannot find ' + name);
  // Walk braces to find the true end.
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const MAX = parseInt((src.match(/const MAX_BUNDLE_FILES = (\d+)/) || [])[1], 10);
const ctx = { module: { exports: {} }, Math, parseFloat, console };
ctx.MAX_BUNDLE_FILES = MAX;
vm.createContext(ctx);
// MAX_BUNDLE_FILES and CENT are read by the extracted function, so they are
// supplied from the real values parsed out of payment.js rather than retyped.
vm.runInContext(extract('toCents') + '\n' + extract('findBundles'), ctx);
const { toCents, findBundles } = ctx.module.exports
  ? ctx.module.exports
  : (ctx.findBundles ? ctx : {});

const findBundlesFn = ctx.findBundles || findBundles;
const toCentsFn = ctx.toCents || toCents;

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };
ok(typeof findBundlesFn === 'function', 'findBundles extracted from payment.js');
ok(typeof toCentsFn === 'function', 'toCents extracted from payment.js');

const cents = (v) => toCentsFn(v);
const cands = (list) => list.map(v => ({ job: { job_id: v.job_id || String(v.c), total_price: v.p }, cents: cents(v.p) }));

// The exact reported case: RM0.41 + RM1.11 for a two-file order.
let found = findBundlesFn(cands([{ p: 0.41 }, { p: 1.11 }]), cents(1.52));
ok(found.length === 1 && found[0].length === 2,
  'the reported case resolves: 0.41 + 1.11 = 1.52 (' + found.length + ' bundle)');

// Three files.
found = findBundlesFn(cands([{ p: 0.20 }, { p: 0.41 }, { p: 1.11 }]), cents(1.72));
ok(found.length === 1 && found[0].length === 3, 'three files sum correctly (0.20+0.41+1.11 = 1.72)');

// Single file still matches as a one-element subset.
found = findBundlesFn(cands([{ p: 1.10 }]), cents(1.10));
ok(found.length === 1 && found[0].length === 1, 'a single job is found as a 1-file bundle');

// Float safety - the whole reason toCents exists.
ok(cents(0.41) + cents(1.11) === cents(1.52), '0.41 + 1.11 is exact in cents');
found = findBundlesFn(cands([{ p: 0.07 }, { p: 0.07 }, { p: 0.07 }]), cents(0.21));
ok(found.length === 1 && found[0].length === 3, '0.07 x 3 = 0.21 does not lose a cent to float error');

// An amount nothing adds up to must return nothing - never guess.
found = findBundlesFn(cands([{ p: 0.41 }, { p: 1.11 }]), cents(9.99));
ok(found.length === 0, 'an unmatched amount returns no bundle');

// A near-miss must not match.
found = findBundlesFn(cands([{ p: 0.41 }, { p: 1.11 }]), cents(1.53));
ok(found.length === 0, 'a 1-cent near-miss does not match');

// Ambiguity must be visible, so the caller parks it instead of guessing.
found = findBundlesFn(cands([{ p: 0.5 }, { p: 0.5 }, { p: 1.0 }]), cents(1.0));
ok(found.length >= 2, 'two readings of 1.00 are both found (' + found.length + ') so it gets parked');

// The file cap is enforced, so a large customer order cannot blow up the search.
ok(MAX >= 2 && MAX <= 5, 'bundle size cap is ' + MAX);
found = findBundlesFn(cands(Array.from({ length: 7 }, (_, i) => ({ p: 0.10 }))), cents(0.70));
ok(found.every(b => b.length <= MAX), 'no bundle exceeds the cap of ' + MAX);

// Every candidate must actually be part of the reported total - a matcher that
// returns jobs not summing to the amount would credit wrong documents.
found = findBundlesFn(cands([{ p: 0.41 }, { p: 1.11 }]), cents(1.52));
ok(found.every(b => Math.abs(b.reduce((s, j) => s + toCentsFn(j.total_price), 0) - cents(1.52)) < 0.5),
  'every returned bundle really sums to the payment amount');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      multi-file payments resolve to their files');