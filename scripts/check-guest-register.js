// Guards the way out of guest mode.
//
// A guest arrives by scanning the kiosk QR, which opens upload.html?guest=1.
// That page used to offer no way to become a member: the only exit was knowing
// register.html existed and typing it on a phone, standing at a kiosk. The
// "Register" call to action must exist, must stay hidden for signed-in
// customers, and must land somewhere that actually finishes the job.
//
// Run: node scripts/check-guest-register.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

const upload = read('website/upload.html');

// --- the button -------------------------------------------------------------
ok(/id="qGuestUpsell"/.test(upload), 'the guest upsell block exists');
ok(/id="qGuestUpsell" style="display:none/.test(upload),
  'it is hidden until the page knows it is a guest');
ok(/onclick="window\.location\.href='register\.html'"[^>]*>Register</.test(upload),
  'the button says Register and goes to register.html');
ok(/Already have an account\?[\s\S]{0,80}login\.html/.test(upload),
  'an existing customer is offered the sign-in path instead');

// --- only guests see it -----------------------------------------------------
ok(/upsellEl\.style\.display = qGuest \? 'block' : 'none'/.test(upload),
  'the upsell is shown for guest mode only');
ok(/let qGuest = false;/.test(upload) && /params\.get\('guest'\) === '1'/.test(upload),
  'guest mode is still detected from ?guest=1');

// --- the destination works ---------------------------------------------------
const register = read('website/register.html');
ok(/register\.js/.test(register), 'register.html is a real signup page');
const registerJs = read('website/register.js');
ok(/window\.location\.href = 'customer\.html'/.test(registerJs),
  'signing up lands the customer on the member dashboard, not back in guest mode');

// --- and it must not break the guest flow itself ----------------------------
ok(/MAX_FILES_GUEST = 1/.test(upload), 'guests are still limited to one file');
ok(/applyGuestFileLimit\(\)/.test(upload), 'the guest file limit is still applied');

// --- house rule: pure ASCII -------------------------------------------------
ok(!/[^\x00-\x7F]/.test(upload), 'upload.html is still pure ASCII');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('\nguest register checks passed.');
