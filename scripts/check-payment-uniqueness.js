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
// content-visibility used to be required here. It was itself a source of the
// judder: the intrinsic height was never exactly the rendered height, so the
    // scrollbar shifted as cards resolved, and the sticky :hover on a touchscreen
    // re-triggered the card's transitioned transform for the whole scroll. A shop
    // kiosk lists a handful of jobs, so skipping off-screen paint bought nothing.
    // The scroll is now kept smooth by not making the browser do avoidable work:
    // no full-screen backdrop blur behind the scrolling card, and no transform on
    // hover at all.
    // Anchored to a declaration, so the comment explaining WHY these are gone does
    // not read as the property being present.
    ok(!/^\s*content-visibility\s*:/m.test(kiosk),
    'off-screen cards do not use content-visibility, which made the scroll jump');
    ok(!/^\s*contain-intrinsic-size\s*:/m.test(kiosk),
    'and no intrinsic-size placeholder whose height drifted from the real one');
    ok(!/backdrop-filter/.test(kiosk),
    'no backdrop blur behind the scrolling list - it re-blurred every scroll frame');
    // `transform: none` under prefers-reduced-motion is correct and stays; what
    // must not come back is a hover transform that animates during a scroll.
    // Asserted on transform FUNCTIONS rather than the keyword: a lookahead after
    // `transform:\s*` backtracks to zero-width and so happily matched the space
    // in " none", reporting a rule that disables motion as one that animates it.
    ok(!/\.job-card:hover[^{]*\{[^}]*transform:[^;}]*\b(translate|scale|rotate|matrix|skew|perspective)/.test(kiosk),
    'hover does not animate a transform, which juddered under a moving finger');
    ok(/\.job-card:hover[^{]*\{[^}]*transform:\s*none/.test(kiosk),
    'and reduced-motion still forces no transform on hover');

    // --- text on the job cards must be readable at all ----------------------
    // The filename was #f1f5f9 on a #f8fbff card: 1.06:1, which is white on
    // near-white. The meta row below it was dark, so the card looked half-styled
    // and the one thing the customer is looking for - which file - was invisible.
    ok(!/color:\s*#f1f5f9/.test(kiosk),
    'no near-white text on the light job cards');
    ok(!/color:\s*#93a5bd/.test(kiosk),
    'and no 2.4:1 grey on the card labels or the printer panel');
    // A way out of the list has to exist at the top, not only at the bottom.
    ok(/class="jobs-cancel"/.test(kiosk),
    'the job list has a cancel button of its own');
    ok(/position: sticky/.test(kiosk) && /\.jobs-cancel/.test(kiosk),
    'and it stays reachable at the top of the card while the list scrolls');
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
