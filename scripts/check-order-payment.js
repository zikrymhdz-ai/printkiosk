// Order-level payment matching.
//
// A payment settles ONE order. Previously it was matched against a single job's
// total_price, so a two-file order of RM0.41 + RM1.11 = RM1.52 matched nothing
// and the customer paid without getting a PIN. A subset search was tried and
// removed: session_id is generated per job so guest files were never grouped,
// it needed a 5-file cap to bound the combinatorics, and two combinations can
// sum to the same amount.
//
// These assertions cover the rules that replaced it, using the real shipped
// functions extracted from payment.js and _shared.js.
const fs = require('fs');
const vm = require('vm');

const ROOT = __dirname.replace(/scripts$/, '');
const payment = fs.readFileSync(ROOT + 'netlify/functions/payment.js', 'utf8');
const shared = fs.readFileSync(ROOT + 'netlify/functions/_shared.js', 'utf8');
const upload = fs.readFileSync(ROOT + 'netlify/functions/upload.js', 'utf8');
const guestPage = fs.readFileSync(ROOT + 'website/upload.html', 'utf8');
const memberPage = fs.readFileSync(ROOT + 'website/customer.html', 'utf8');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

// Pull the real implementations out of the shipped files.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function evalIn(src, names, extra) {
  const ctx = Object.assign({ Math, parseFloat, parseInt, console }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(names.map(n => extractFn(src, n)).filter(Boolean).join('\n'), ctx);
  return ctx;
}

const pctx = evalIn(payment, ['orderKeyOf', 'orderAmountOf']);
const sctx = evalIn(shared, ['pickFreeOffset'], {
  MAX_MATCH_OFFSETS: parseInt((shared.match(/const MAX_MATCH_OFFSETS = (\d+)/) || [])[1], 10),
});

const orderKeyOf = pctx.orderKeyOf;
const orderAmountOf = pctx.orderAmountOf;
const pickFreeOffset = sctx.pickFreeOffset;
ok(typeof orderKeyOf === 'function', 'orderKeyOf extracted');
ok(typeof orderAmountOf === 'function', 'orderAmountOf extracted');
ok(typeof pickFreeOffset === 'function', 'pickFreeOffset extracted');

// --- files of one order are grouped together ------------------------------
const A = { job_id: 'PRN-A', order_id: 'o1', total_price: 0.41, order_total: 1.52 };
const B = { job_id: 'PRN-B', order_id: 'o1', total_price: 1.11, order_total: 1.52 };
const C = { job_id: 'PRN-C', order_id: 'o2', total_price: 1.52, order_total: 1.52 };
ok(orderKeyOf(A) === orderKeyOf(B), 'two files of one order share a key');
ok(orderKeyOf(A) !== orderKeyOf(C), 'a different order gets a different key');
ok(Math.abs(orderAmountOf([A, B]) - 1.52) < 0.005,
  'an order is worth its order_total (' + orderAmountOf([A, B]) + ')');

// --- a partial payment must not settle anything ---------------------------
ok(Math.abs(orderAmountOf([A, B]) - 0.41) > 0.005,
  'paying for one file of two does not equal the order total, so it cannot match');

// --- legacy rows with no order_id are single-file orders -------------------
const legacy = { job_id: 'PRN-L', order_id: null, total_price: 0.55, order_total: null };
ok(orderKeyOf(legacy) === 'j:PRN-L', 'a row with no order_id is its own order');
ok(Math.abs(orderAmountOf([legacy]) - 0.55) < 0.005,
  'a legacy single-file order is worth its job total');

// --- slots run in blocks of ten, as the amounts read ----------------------
// RM0.20 base: 0.20-0.29 first, then 0.30-0.39, then 0.40-0.49.
const usedFirstBlock = new Set([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
const second = pickFreeOffset(20, usedFirstBlock);
ok(second && second.cents === 30,
  'with 0.20-0.29 taken, the next slot is 0.30 (second block), not a repeat');
const third = pickFreeOffset(20, new Set([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39]));
ok(third && third.cents === 40, 'and with 0.30-0.39 taken too, it moves to 0.40 (third block)');
const first = pickFreeOffset(20, new Set());
ok(first && first.offset === 0, 'the very first slot is offset 0');
// An eleventh concurrent job used to be handed a colliding "top" slot.
const eleven = new Set(Array.from({ length: 10 }, (_, i) => 20 + i));
const eleventh = pickFreeOffset(20, eleven);
ok(eleventh && eleventh.offset === 10,
  'an 11th same-priced job gets a genuinely free slot instead of colliding');

// --- guests are limited to one file, members to five ----------------------
ok(/const MAX_BUNDLE_FILES = 5/.test(upload), 'server caps an order at 5 files');

// resolveOrderId must never reject a valid upload. An earlier version returned
// "Missing order reference" whenever a signed-in upload arrived without one,
// which made any client/server disagreement a hard failure - the real case was
// a signed-in customer opening the kiosk guest link, where ?guest=1 clears the
// local token but the session is still valid server-side.
const rid = upload.match(/async function resolveOrderId[\s\S]*?\n\}/);
ok(!!rid, 'resolveOrderId found');
if (rid) {
  ok(!/Missing order reference/.test(rid[0]), 'no missing-order-reference rejection');
  ok(!/Guests can upload one file at a time/.test(rid[0]),
    'a guest order reference is stripped, not refused');
  ok(/if \(!userId\) \{[\s\S]{0,120}return \{ orderId: null \}/.test(rid[0]),
    'a guest is always a single-file order');
  ok(/if \(!sent \|\| !\/\^/.test(rid[0]),
    'a member with no usable reference falls back to a single-file order');
  ok(/already >= MAX_BUNDLE_FILES/.test(rid[0]),
    'only the bundle cap is a hard limit');
}

// The client must send the reference unconditionally: the server decides what
// it means. Gating it on the client's own guest guess is what caused this.
ok(/formData\.append\('order_id', currentOrderId\(\)\);/.test(guestPage)
   && !/if \(currentOrderId\(\)\) formData\.append\('order_id'/.test(guestPage),
  'upload.html always sends order_id instead of gating it on its guest guess');
ok(/return !localStorage\.getItem\('session_token'\) && !sessionStorage\.getItem\('pk_token'\)/.test(guestPage),
  'the file limit follows the token, which is what the server also sees');

const guestLimit = parseInt((guestPage.match(/var MAX_FILES_GUEST = (\d+)/) || [])[1], 10);
ok(guestLimit === 1, 'guest page allows exactly 1 file (' + guestLimit + ')');
const memberLimit = parseInt((memberPage.match(/var MAX_ORDER_FILES = (\d+)/) || [])[1], 10);
ok(memberLimit === 5, 'member page allows 5 files (' + memberLimit + ')');
ok(/20 \* 1024 \* 1024/.test(upload), 'the 20MB per-file limit is still enforced server-side');

// --- the amount shown is the amount the server priced ---------------------
ok(/seal-order/.test(guestPage) && /seal-order/.test(memberPage), 'both pages seal the order');
ok(/phoneOrderTotal = sealData\.order_total/.test(guestPage), 'guest page uses the sealed total');
ok(/sealedOrderTotal = sealData\.order_total/.test(memberPage), 'member page uses the sealed total');
ok(/has migration 20261015_orders run\?/i.test(upload),
  'a missing migration is reported clearly rather than silently mis-pricing');

// --- coins are per FILE, not per payment ----------------------------------
// Corrected: this was briefly changed to one coin per order on the reasoning
// that the customer makes a single payment. The reward is for having something
// printed, so five files earn five coins even when they arrive together in one
// order and one transfer.
ok(/async function awardFileCoin/.test(payment), 'the coin rule lives in one function');
const award = extractFn(payment, 'awardFileCoin') || '';
ok(/\+ 1\b/.test(award), 'exactly one coin is credited');
ok(!/fileCount|orderFiles|\* order/i.test(award),
  'the coin is never scaled by the number of files in an order');
ok(!/skipCoins/.test(payment), 'there is no way to suppress a file\'s coin');
// Each file of an order must go through confirmJobPaid, which awards its own.
const loop = payment.match(/for \(let i = 0; i < orderJobs\.length; i\+\+\) \{[\s\S]*?\n\s*\}/);
ok(!!loop, 'per-file settlement loop found');
if (loop) {
  ok(/confirmJobPaid\(orderJobs\[i\]/.test(loop[0]),
    'every file is settled individually, so every file earns its coin');
  ok(!/skipCoins/.test(loop[0]), 'the loop does not skip coins');
}
ok(/coins \+= r\.coinsEarned \|\| 0/.test(payment),
  'the order total coins are summed from each file');

// A guest must never reach seal-order: it is member-only, and calling it
// failed the upload with "Only signed-in customers can place a multi-file
// order" so a guest could never get past step 1.
ok(/if \(!uploadPageIsGuest\(\)\) \{/.test(guestPage),
  'seal-order is skipped for guests');
ok(!/if \(currentOrderId\(\)\) \{[\s\S]{0,80}seal-order/.test(guestPage),
  'seal-order is not gated on the order id, which every visitor now has');

// Guests are always single file, server-side, regardless of what they send.
ok(/if \(!userId\) \{[\s\S]{0,120}return \{ orderId: null \}/.test(upload),
  'a guest order reference is discarded, so a guest cannot form a bundle');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      orders settle as one payment and earn a coin per file');