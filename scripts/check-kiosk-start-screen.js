// Guards the kiosk's start screen: the card that says "Touch screen to
// continue", and the 30-minute rule that brings it back.
//
// This screen has no error path of its own. If the markup loses its copy, or
// the overlay stops resetting the flow underneath it, the kiosk still looks
// alive -- it just quietly shows a stranger's PIN screen or an abandoned
// payment QR to the next person in the shop. Nothing else in the suite would
// notice, so the guarantees are asserted here.
//
// Run: node scripts/check-kiosk-start-screen.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'kiosk', 'walkin.html'), 'utf8');

let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok      ' + msg); return; }
  failed++;
  console.error('  FAILED  ' + msg);
}

// --- the card itself --------------------------------------------------------
ok(/<div id="startScreen"/.test(page), 'the start screen element exists');
ok(/Hi, Welcome to PrintKiosk/.test(page), 'the welcome copy is present');
ok(/Touch screen to continue/i.test(page), 'the screen tells the customer to touch it');

// --- dismissal --------------------------------------------------------------
// pointerdown, not just click: the first tap has to register while the finger
// is still down, and a drag counts too.
ok(/pointerdown/.test(page), 'a pointerdown dismisses the screen');
ok(/window\.pkShowStartScreen\s*=/.test(page), 'the screen can be shown again from the page');
ok(/window\.pkIsStartScreenVisible\s*=/.test(page), 'other code can ask whether the screen is up');

// --- the 30-minute rule -----------------------------------------------------
ok(/IDLE_RESET_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/.test(page),
   'the idle limit is 30 minutes, written as a multiplication');
ok(/Date\.now\(\)\s*-\s*lastTouch\s*>=\s*IDLE_RESET_MS/.test(page),
   'the timer compares the real idle gap against that limit');

// --- the flow underneath is actually cleared --------------------------------
const reset = (page.match(/window\.pkResetToStart\s*=\s*function[\s\S]*?\n\};/) || [''])[0];
ok(reset.length > 0, 'pkResetToStart is defined');
for (const id of ['confirmOverlay', 'jobsOverlay', 'qrOverlay', 'pinJobOverlay',
                  'paymentOverlay', 'receiptOverlay']) {
  ok(reset.indexOf(id) !== -1, 'returning to the start screen closes ' + id);
}
ok(/matchedUser\s*=\s*null/.test(reset), 'it drops the matched user');
ok(/resetFaceStreak\(\)/.test(reset), 'it clears the face streak');
ok(/pinInput/.test(reset), 'it clears the PIN field');

// A print already on its way to the printer must NOT be hidden: that overlay is
// the only thing that tells the customer their document came out.
ok(reset.indexOf('printingOverlay') === -1,
   'it leaves the printing overlay alone');

// --- face login must not run behind the welcome card ------------------------
ok(/pkIsStartScreenVisible[\s\S]{0,120}return;/.test(page),
   'face detection stops while the start screen is up');

// --- layering ---------------------------------------------------------------
const startZ = (page.match(/\.start-screen\s*\{[^}]*z-index:\s*(\d+)/) || [])[1];
const overlayZ = (page.match(/\.confirm-overlay\s*\{[^}]*z-index:\s*(\d+)/) || [])[1];
ok(!!startZ && !!overlayZ && Number(startZ) > Number(overlayZ),
   'the start screen sits above the flow overlays (' + startZ + ' > ' + overlayZ + ')');

// --- maintenance mode owns the glass when it is on --------------------------
ok(/pkHideStartScreen/.test(page), 'maintenance mode can take the screen down');
ok(/pkShowStartScreen/.test(page), 'leaving maintenance mode brings the screen back');

// --- the kiosk font ---------------------------------------------------------
// System UI sans, no webfont: the Pi is offline half the time and the request
// used to hold up first paint.
ok(!/fonts\.googleapis\.com/.test(page), 'the kiosk loads no Google font');
ok(/-apple-system[\s\S]{0,120}BlinkMacSystemFont/.test(page),
   'the kiosk falls back to the system UI font stack');

console.log(failed ? '\n' + failed + ' problem(s).' : '\nstart screen checks passed.');
process.exit(failed ? 1 : 0);
