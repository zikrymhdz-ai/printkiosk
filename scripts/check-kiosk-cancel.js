// The kiosk receipt screen offers a way out.
//
// A customer who typed the wrong code lands on "payment confirmed" with only
// "Print My Document". Without an escape they either print a document that is
// not theirs, or they are stuck.
//
// The danger is in HOW the escape behaves. A cancel that called request-print
// would print the very document the customer meant to refuse. A cancel that
// voided or refunded the job would take their money back and lose the file. The
// job must stay paid and pending so the correct code - or staff - can still
// print it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const kiosk = fs.readFileSync(path.join(ROOT, 'kiosk/walkin.html'), 'utf8');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

// Pull a function body out by brace counting, so an assertion cannot pass by
// matching a word that only appears in a comment somewhere else on the page.
function bodyOf(name) {
  const start = kiosk.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let i = kiosk.indexOf('{', start);
  let depth = 0;
  for (; i < kiosk.length; i++) {
    if (kiosk[i] === '{') depth++;
    else if (kiosk[i] === '}') { depth--; if (!depth) break; }
  }
  return kiosk.slice(start, i + 1);
}

// --- there is a way out -----------------------------------------------------
ok(/id="receiptCancelBtn"/.test(kiosk), 'the receipt screen has a cancel button');
ok(/onclick="cancelPrintTapped\(\)"[^>]*id="receiptCancelBtn"/.test(kiosk)
  || /id="receiptCancelBtn"[^>]*onclick="cancelPrintTapped\(\)"/.test(kiosk),
  'the cancel button is wired to cancelPrintTapped()');
ok(/id="receiptCancelBtn"[^>]*btn-secondary-kiosk|btn-secondary-kiosk[^>]*id="receiptCancelBtn"/.test(kiosk),
  'it is styled as a secondary action, so it does not compete with Print');

// The escape has to sit on the same screen as the print button it cancels.
// Assert the order of the controls inside the receipt card rather than a
// character distance, which a comment between them would break.
const overlayIdx = kiosk.indexOf('id="receiptOverlay"');
const printIdx = kiosk.indexOf('id="receiptDoneBtn"');
const cancelIdx = kiosk.indexOf('id="receiptCancelBtn"');
const paperWarnIdx = kiosk.indexOf('id="paperWarn"');
ok(overlayIdx !== -1 && printIdx > overlayIdx,
  'the print button lives on the receipt overlay');
ok(cancelIdx > printIdx && cancelIdx < paperWarnIdx,
  'the cancel button sits with the other receipt controls, between Print and the paper warning');

const cancel = bodyOf('cancelPrintTapped');
ok(!!cancel, 'cancelPrintTapped exists');

// --- cancelling must never release the document ----------------------------
const printSites = (kiosk.match(/action=print|request-print'/g) || []).length;
ok(printSites === 1, 'there is exactly one place that can queue a print, found ' + printSites);

for (const forbidden of ['request-print', 'delete-job', 'clear-jobs', 'complete-job', 'refund', 'cancel-job', 'location.reload']) {
  ok(cancel && cancel.indexOf(forbidden) === -1,
    'cancelling never calls ' + forbidden);
}

// --- the job stays alive so the right code can still print it --------------
ok(cancel && /currentPinJob = null/.test(cancel), 'the held job is released from the screen');
ok(cancel && /currentPinJobId = null/.test(cancel), 'the single-job reference is cleared');
ok(cancel && /currentPinJobs = \[\]/.test(cancel), 'the multi-job list is cleared');

// --- and the customer is told what happened, and sent somewhere useful -----
ok(cancel && /receiptOverlay/.test(cancel), 'the receipt screen is closed');
ok(cancel && /pinInput/.test(cancel), 'focus returns to the code entry');
ok(cancel && /kioskPinHint/.test(cancel), 'the customer is told the document was not printed');
ok(cancel && /payment is safe/i.test(cancel),
  'the customer is reassured their payment is not affected');

// --- the kiosk must not be left stuck for the next person ------------------
ok(cancel && /receiptDoneBtn/.test(cancel), 'the print button is restored for the next customer');
ok(cancel && /disabled = false/.test(cancel), 'and is re-enabled, not left greyed out');
ok(cancel && /textContent = 'Print My Document'/.test(cancel),
  'and its label goes back to Print My Document');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      a wrong code can be cancelled without losing the document or the payment');
