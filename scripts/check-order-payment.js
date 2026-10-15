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

// The member page must watch for payment on its own. checkPaymentStatus()
// existed but only ran from a button click, so a customer who paid sat on
// "pay RM x" and concluded the payment was not detected - while the order was
// in fact already settled server-side.
ok(/startBackgroundPaymentWatch\(allJobIds\)/.test(memberPage),
  'the member page starts watching for payment on its own, without pressing anything');
ok(/!payPollTimer/.test(memberPage),
  'the automatic watch does not stack on top of a manual one');

// --- printer output format ------------------------------------------------
const workerSrc = fs.readFileSync(ROOT + 'pi/print-worker.py', 'utf8');
// ipptool builds differ: some emit "    [12] name (syntax) = value", others a
// named group with no index at all. Matching only the indexed form made a good
// response look like a request that never completed.
// Substring rather than a regex: these assertions are about a literal pattern
// in the source, and a regex for a regex has repeatedly proven fussier than the
// fact it asserts.
ok(workerSrc.includes('[^\\n]*?=\\s*\\S'),
  'attribute detection accepts both ipptool output shapes');
ok(!workerSrc.includes('^\\s*\\[\\d+\\]'),
  'detection no longer requires an [n] index prefix');

// --- a guest is walked straight through, and cannot add a second file -----
ok(/function applyGuestFileLimit\(\)/.test(guestPage), 'guest file limit is applied');
ok(/input\.removeAttribute\('multiple'\)/.test(guestPage),
  "a guest's picker drops `multiple`, so the OS chooser offers one file");
ok(/one file/i.test(guestPage), 'the hint tells a guest it is one file');
ok(/if \(added && uploadPageIsGuest\(\)\)/.test(guestPage),
  'choosing their file advances a guest to step 2 automatically');
ok(/goStep2\(\);[\s\S]{0,80}\}, 350\)/.test(guestPage),
  'the automatic advance happens after the thumbnail renders');
ok(guestPage.includes('id="continueStep1"') && /btn\.style\.display = 'none'/.test(guestPage),
  "a guest's Continue button is hidden");
ok(guestPage.includes('id="backToStep1"') && /back\.style\.display = 'none'/.test(guestPage),
  'a guest cannot go back to file selection');
// Members must be untouched by all of this.
ok(/applyGuestFileLimit\(\);\s*\n\}/.test(guestPage), 'the limit is applied after session restore');
ok(/if \(!uploadPageIsGuest\(\)\) return;/.test(guestPage),
  'every guest-only change is skipped for a signed-in customer');

// --- ONE fee per payment, not one per file ---------------------------------
// Four files of RM0.20 were charged RM0.86 because each carried its own match
// fee. The fee exists to make a payment identifiable; a customer makes one
// payment, so it is charged once.
ok(/const sumBase = jobs\.reduce/.test(upload),
  'the order total is built from base_price, which excludes per-job fees');
ok(!/const sum = jobs\.reduce/.test(upload),
  'the inflated per-job totals are no longer summed for the customer');
ok(/assignUniqueOrderTotal\(sumBase, usedTotals\)/.test(upload),
  'the order fee is added once, on top of the item prices');
ok(/'select': 'id,job_id,total_price,base_price,match_fee/.test(upload),
  'base_price is selected so the fee can be excluded');
ok(/item_total: Math\.round\(sumBase \* 100\) \/ 100/.test(upload),
  'item_total reports the true item price');
ok(!/pendingUploadJobs\.reduce\(function\(a, j\) \{ return a \+ \(parseFloat\(j\.match_fee\)/.test(memberPage),
  'the receipt no longer sums per-file fees as if it were the order fee');

// --- the member page must not click its own button ------------------------
// Calling checkPaymentStatus() is the button handler, so the page appeared to
// press "I've paid" itself, and the 5 minute timer it started always ended in
// "we could not confirm".
ok(!/checkPaymentStatus\(\)[\s\S]{0,60}\}, \d+\);/.test(memberPage),
  'the payment watch does not call the button handler');
ok(!/try \{ checkPaymentStatus\(\); \}/.test(memberPage),
  'no automatic invocation of checkPaymentStatus');
ok(/function startBackgroundPaymentWatch\(jobIds\)/.test(memberPage),
  'a silent background watcher exists instead');
ok(/get-all-jobs&user_id=/.test(memberPage) && /allPaid/.test(memberPage),
  'the watcher polls the same endpoint the button uses');
ok(/if \(payPollTimer\) \{ clearInterval\(tick\); return; \}/.test(memberPage),
  'the watcher stands aside when the customer starts a manual poll');

// --- the printer must not be rejected for reporting a serial ---------------
// Brother returns the SERIAL as printer-name ("BRW145A41F176AD"), so comparing
// EXPECTED_MODEL against printer-name alone rejected the correct printer.
ok(/MAKE_MODEL_RE = re\.compile/.test(workerSrc), 'printer-make-and-model is parsed');
ok(/INFO_RE = re\.compile/.test(workerSrc), 'printer-info is parsed');
ok(/not any\(expected\.lower\(\) in s\.lower\(\) for s in identity\)/.test(workerSrc),
  'the expected model may appear in ANY identity attribute');
ok(!/expected\.lower\(\) not in model\.lower\(\)/.test(workerSrc),
  'printer-name alone is no longer decisive');

// --- the matcher must SELECT order_total ----------------------------------
// Omitting it from the query is invisible at read time: orderAmountOf() then
// falls back to summing the per-job totals, which carry each job's own match
// fee. An order sealed at RM0.40 was searched for as RM0.41, so a payment of
// exactly RM0.40 matched nothing and was reported as "no matching order" while
// the customer waited at the kiosk.
const notifier = payment;
const jobsQuery = notifier.match(/jobsResult = await supabaseRequest\('GET', '\/print_jobs', null, \{[\s\S]*?'select': '([^']*)'/);
ok(!!jobsQuery, "the notifier's job query found");
if (jobsQuery) {
  ok(jobsQuery[1].split(',').map(s => s.trim()).includes('order_total'),
    'order_total is selected by the notifier');
}
ok(!/select': 'id,job_id,user_id,session_id,total_price,file_name/.test(notifier),
  'the old select without order_total is gone');

// orderAmountOf must prefer the sealed value.
ok(/const sealed = jobs\.map\(j => parseFloat\(j\.order_total\)\)/.test(payment),
  'orderAmountOf reads order_total');
ok(/sealed\.length === jobs\.length/.test(payment),
  'and uses it only when every file agrees');

// --- the arithmetic from the reported order -------------------------------
// 0.20 + 0.21 of items, one 0.00 order fee, sealed at 0.40, paid 0.40.
{
  const sealed = [{ total_price: 0.21, order_total: 0.40 },
                  { total_price: 0.20, order_total: 0.40 }];
  const sumTotals = sealed.reduce((s, j) => s + j.total_price, 0);
  ok(Math.abs(sumTotals - 0.41) < 0.005,
    'the per-job totals still sum to 0.41 (they carry per-file fees)');
  ok(Math.abs(sealed[0].order_total - 0.40) < 0.005,
    'while the sealed order total is the 0.40 the customer was actually charged');
  ok(Math.abs(sealed[0].order_total - sumTotals) > 0.005,
    'so the two differ by exactly the amount that caused the miss');
}

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      orders settle as one payment and earn a coin per file');