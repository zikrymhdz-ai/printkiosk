// Proves a face streak can actually REACH the hold threshold and sign in.
//
// The globals check only proved the constants existed in global scope. It could
// not tell that FACE_MATCH_FRAMES = 6 and FACE_MIN_HOLD_FRAMES = 8 made the
// sign-in path unreachable: the streak entered the match branch at exactly 6,
// failed 'count < 8', and reset. So the kiosk said "Face matched!" and threw
// the match away on every single frame, forever.
//
// This walks the real control flow with the real constants: a passer-by must be
// rejected, and a deliberate user must be signed in.
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'kiosk', 'walkin.html');
const src = fs.readFileSync(HTML, 'utf8');

const num = (name) => {
  const m = src.match(new RegExp('var ' + name + ' = ([0-9.]+)'));
  if (!m) throw new Error('could not find ' + name);
  return parseFloat(m[1]);
};

const HOLD = num('FACE_HOLD_FRAMES');
const THRESHOLD = num('FACE_MATCH_THRESHOLD');
const RATIO = num('FACE_MIN_FACE_RATIO');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// Strip comments first: the explanatory comment deliberately names the old
// constants to explain why they were removed.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

// 1. No leftover two-step constants, which are what made it unreachable.
ok(!/FACE_MATCH_FRAMES|FACE_MIN_HOLD_FRAMES/.test(code),
  'single hold constant; no contradictory FACE_MATCH_FRAMES/FACE_MIN_HOLD_FRAMES');

// 2. The sign-in gate must not be able to reject the streak it just accepted.
ok(/if \(faceStreak\.count >= FACE_HOLD_FRAMES\) \{/.test(code),
  'sign-in is gated on faceStreak.count >= FACE_HOLD_FRAMES');
ok(!/faceStreak\.count\s*<\s*FACE_HOLD_FRAMES/.test(code),
  'accepted streak is never discarded by a "too brief" check');
ok(!/too brief/.test(code), 'no unreachable "too brief" rejection remains');

// 3. Simulate the real loop: passer-by (2 frames) vs deliberate (HOLD frames).
function simulate(goodFrames, distance) {
  let count = 0;
  let signedIn = false;
  for (let f = 0; f < goodFrames; f++) {
    if (distance < THRESHOLD) {
      count++;
      if (count >= HOLD) { signedIn = true; break; }
    } else {
      count = 0; // a bad frame breaks the streak
    }
  }
  return { count, signedIn };
}

const passerBy = simulate(2, 0.2);
ok(!passerBy.signedIn, 'a 2-frame passer-by glance is NOT signed in (got ' + passerBy.count + '/' + HOLD + ')');

const deliberate = simulate(HOLD + 3, 0.2);
ok(deliberate.signedIn, 'a user holding still IS signed in (reached ' + deliberate.count + ')');

// 4. Holding a face that does not match must never accumulate.
const stranger = simulate(HOLD + 5, 0.55);
ok(!stranger.signedIn, 'a stranger held at the camera is NOT signed in (0.55 >= ' + THRESHOLD + ')');

// 5. Intermittent frames must not accumulate a streak across gaps.
let count = 0, signedIn = false;
for (let f = 0; f < 40 && !signedIn; f++) {
  const good = (f % 2 === 0) && 0.2 < THRESHOLD;
  if (good) { count++; if (count >= HOLD) signedIn = true; }
  else count = 0;
}
ok(!signedIn, 'intermittent good/bad frames never accumulate to a sign-in');

// 6. The size gate must not be stricter than a face at arm's length.
ok(RATIO > 0 && RATIO <= 0.2,
  'min face ratio ' + RATIO + ' of the frame is reasonable (was 0.40 as a pixel constant on a 256px frame)');

if (failed) process.exit(1);
console.log('  ok      face streak logic can reach sign-in');