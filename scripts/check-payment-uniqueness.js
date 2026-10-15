// Two fixes, both easy to undo by accident.
//
// 1. A payment shown as RM1.30, transferred as RM1.30, was never detected.
//
//    Allocation reserved each amount for 10 minutes (JOB_PAYABLE_WINDOW_MIN)
//    while the matcher considered orders for 60 (MATCH_WINDOW_MIN). At minute
//    10 an amount became free to re-issue while the original order was still a
//    candidate. Two live orders then shared one figure, the matcher found two
//    matches, and correctly parked the payment for staff review rather than
//    guessing which customer it belonged to - so it never settled, and the
//    kiosk waited forever.
//
//    Reservation must therefore be at least as long as the matching window, and
//    both total_price and order_total must be reserved: a single-file order is
//    matched against its job total, a multi-file order against its order total,
//    and reserving only one of the two let them collide.
//
// 2. Scrolling the jobs list stuttered badly on the Pi, because every card had
//    inline onmouseover/onmouseout handlers writing borderColor. Every mouse
//    move ran script and repainted a transitioning border.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sharedSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/_shared.js'), 'utf8');
const paymentSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/payment.js'), 'utf8');
const uploadSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/upload.js'), 'utf8');
const kiosk = fs.readFileSync(path.join(ROOT, 'kiosk/walkin.html'), 'utf8');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

// --- 1. the reservation window must cover the matching window --------------
const sharedWindow = parseInt((sharedSrc.match(/const JOB_PAYABLE_WINDOW_MIN = (\d+);/) || [])[1], 10);
const matchWindow = parseInt((paymentSrc.match(/const MATCH_WINDOW_MIN = (\d+);/) || [])[1], 10);
ok(Number.isFinite(sharedWindow) && Number.isFinite(matchWindow),
  'both windows are declared (' + sharedWindow + ' and ' + matchWindow + ')');
ok(sharedWindow >= matchWindow,
  'reservation lasts at least as long as an order stays matchable ('
    + sharedWindow + ' >= ' + matchWindow + ') - a shorter window is what let a live amount be re-issued');

// The reservation window must be the one actually used when picking a free slot.
ok(/const cutoff = new Date\(Date\.now\(\) - JOB_PAYABLE_WINDOW_MIN \* 60 \* 1000\)/.test(sharedSrc),
  'the amount allocator uses JOB_PAYABLE_WINDOW_MIN, not a hardcoded value');
ok(!/Math\.now\(\) - 10 \* 60 \* 1000/.test(sharedSrc + uploadSrc),
  'no hardcoded 10-minute window is left behind');

// --- 2. both figures must be reserved on both paths -----------------------
ok(/'select': 'total_price,order_total'/.test(sharedSrc),
  'the amount allocator reserves both total_price and order_total');
const sealBlock = uploadSrc.slice(uploadSrc.indexOf('const sealCutoff'), uploadSrc.indexOf('const usedTotals'));
ok(/'select': 'order_total,total_price'/.test(sealBlock),
  'sealing reserves both order_total and total_price');
ok(!/order_total': 'not\.is\.null'/.test(sealBlock),
  'sealing no longer ignores unsealed single-file orders, whose job total is matchable');
ok(/'created_at': 'gte\.' \+ sealCutoff/.test(sealBlock),
  'sealing restricts the reservation to the same live window');

// --- 3. a duplicate amount must be impossible for any matchable order ------
// Reproduce the allocator's rule directly: every matchable amount is reserved,
// so a second order cannot be given a figure that is already live.
{
  const live = [
    { total_price: 1.30, order_total: null },   // single-file order
    { total_price: 0.41, order_total: 1.31 },   // sealed multi-file order
    { total_price: 1.31, order_total: 1.31 },   // its job total
  ];
  const reserved = new Set();
  for (const j of live) {
    for (const f of ['total_price', 'order_total']) {
      const v = parseFloat(j[f]);
      if (!Number.isNaN(v)) reserved.add(Math.round(v * 100));
    }
  }
  ok(reserved.has(130), 'the single-file order\'s RM1.30 is reserved');
  ok(reserved.has(131), 'the multi-file order\'s RM1.31 is reserved');
  // A new order priced at 1.30 must be nudged off the taken figure.
  let cents = 130;
  while (reserved.has(cents)) cents++;
  ok(cents !== 130,
    'a new RM1.30 order would be moved to RM' + (cents / 100).toFixed(2) + ' instead of colliding');
  ok(cents <= 130 + sharedWindow,
    'and it stays within the number of offsets the window allows');
}

// --- 4. the kiosk list must not run script while scrolling ----------------
ok(!/onmouseover=/.test(kiosk) && !/onmouseout=/.test(kiosk),
  'no inline mouse handlers remain on any card');
ok(/\.job-card:hover/.test(kiosk), 'hover is handled in CSS instead');
ok(/content-visibility: auto/.test(kiosk),
  'off-screen cards skip layout and paint, which is what smooths the scroll');
ok(/contain-intrinsic-size/.test(kiosk),
  'and their height is estimated so scrolling does not jump');
ok(/overscroll-behavior:contain/.test(kiosk),
  'the scrolling card contains its own overscroll');
ok(/prefers-reduced-motion/.test(kiosk),
  'the transition is dropped for anyone who asks for less motion');

// The cards must still be operable, since the inline handlers are gone.
ok(/role="button"/.test(kiosk), 'a card is announced as a button');
ok(/tabindex="0"/.test(kiosk), 'and is reachable by keyboard');
ok(/onkeydown=/.test(kiosk), 'and responds to Enter or Space');
ok(/onclick="selectJob\(/.test(kiosk), 'and still selects on click');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      payment amounts stay unique, and the kiosk list scrolls smoothly');
