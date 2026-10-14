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
const MEAN = num('FACE_MEAN_THRESHOLD');

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
ok(/faceStreak\.count >= FACE_HOLD_FRAMES/.test(code),
  'sign-in is gated on faceStreak.count >= FACE_HOLD_FRAMES');
ok(/count >= FACE_HOLD_FRAMES\s*&&\s*meanDistance\s*<=\s*FACE_MEAN_THRESHOLD/.test(code),
  'sign-in also requires the mean distance to clear FACE_MEAN_THRESHOLD');
ok(!/faceStreak\.count\s*<\s*FACE_HOLD_FRAMES/.test(code),
  'accepted streak is never discarded by a "too brief" check');
ok(!/too brief/.test(code), 'no unreachable "too brief" rejection remains');

// 3. Simulate the real loop: passer-by (2 frames) vs deliberate (HOLD frames).
// Mirrors the shipped gate: per-frame threshold to enter the streak, then a
// MEAN distance check to commit.
function simulate(frames) {
  let count = 0, sum = 0, signedIn = false;
  for (const distance of frames) {
    if (distance < THRESHOLD) {
      count++;
      sum += distance;
      if (count >= HOLD && sum / count <= MEAN) { signedIn = true; break; }
    } else {
      count = 0; sum = 0; // a bad frame breaks the streak
    }
  }
  return { count, mean: count ? sum / count : null, signedIn };
}

const passerBy = simulate([0.2, 0.2]);
ok(!passerBy.signedIn, 'a 2-frame passer-by glance is NOT signed in (got ' + passerBy.count + '/' + HOLD + ')');

const deliberate = simulate([0.2, 0.2, 0.2, 0.2, 0.2]);
ok(deliberate.signedIn, 'a user holding still IS signed in (reached ' + deliberate.count + ')');

// 4. Holding a face that does not match must never accumulate.
const stranger = simulate(Array(HOLD + 5).fill(0.55));
ok(!stranger.signedIn, 'a stranger held at the camera is NOT signed in (0.55 >= ' + THRESHOLD + ')');

// 5. Intermittent frames must not accumulate a streak across gaps.
const flicker = simulate(Array.from({length: 40}, (_, i) => (i % 2 === 0 ? 0.2 : 0.9)));
ok(!flicker.signedIn, 'intermittent good/bad frames never accumulate to a sign-in');

// 6. The mean gate is the point of the change. Every frame here is individually
// under the per-frame threshold, so a plain count would have signed the person
// in -- but the average is not a confident match. This is the ride-along the
// mean gate exists to reject.
const rideAlong = simulate([0.45, 0.45, 0.45]);
ok(!rideAlong.signedIn,
  'frames that each pass 0.48 but average 0.45 are REJECTED by the mean gate'
  + ' (mean=' + rideAlong.mean.toFixed(3) + ' > ' + MEAN + ')');
// And confirm the old count-only logic really would have accepted them,
// otherwise this test proves nothing.
const rideAlongFrames = [0.45, 0.45, 0.45];
const countOnly = rideAlongFrames.length >= HOLD && rideAlongFrames.every(function (d) { return d < THRESHOLD; });
ok(countOnly,
  'the rejected ride-along WOULD have passed a plain count-only gate (' + HOLD + ' frames)');
const goodMean = simulate([0.35, 0.35, 0.38]);
ok(goodMean.signedIn,
  'a consistent confident match still signs in (mean=' + goodMean.mean.toFixed(3) + ')');

// 7. The reset must clear the accumulator, or a stale sum drags the mean down.
ok(/faceStreak\.sum = 0/.test(src),
  'resetFaceStreak clears the distance accumulator');
ok(/faceStreak\.sum \+= match\.distance/.test(src),
  'the streak accumulates distance rather than keeping only the last frame');

// 8. Mean gate must be tighter than the per-frame threshold, or it is not
// doing any work.
ok(MEAN < THRESHOLD,
  'mean threshold ' + MEAN + ' is tighter than the per-frame ' + THRESHOLD);

// 9. Faster than the old 5 frames @ 400ms, without loosening the bar.
const interval = (src.match(/FACE_MIN_INTERVAL_MS = (\d+)/) || [])[1];
if (interval) {
  const holdMs = HOLD * parseInt(interval, 10);
  ok(holdMs <= 1000, 'sign-in budget ' + holdMs + 'ms (was 2000ms at 5x400)');
}

// 10. The size gate must not be stricter than a face at arm's length.
ok(RATIO > 0 && RATIO <= 0.2,
  'min face ratio ' + RATIO + ' of the frame is reasonable (was 0.40 as a pixel constant on a 256px frame)');

if (failed) process.exit(1);
console.log('  ok      face streak logic can reach sign-in');