// Face recognition cost checks.
//
// One performance defect was fixed here (the sampling-gap ratchet). A second
// "optimisation" in the same commit was wrong and has been reverted -- see the
// landmark section, which now guards the correct behaviour.
//
// The ratchet: a pass slower than slowPassMs added 150ms up to an adaptiveMax
// of 1400ms, and could only shrink if a pass came in under 120ms. A Pi pass
// realistically takes 200-400ms, so it ratcheted to the ceiling and stayed
// there, making sign-in 3 x 1400ms = 4.2s and getting slower the longer the
// kiosk ran.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'kiosk', 'walkin.html'), 'utf8');
// Comments are stripped for "is this still referenced" checks: the history of
// the ratchet is documented in prose naming the old identifiers.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// --- 1. the landmark net is REQUIRED, do not "optimise" it away -------------
// I removed faceLandmark68Net on the reasoning that none of the 68 points are
// ever read, so the inference was wasted. The Pi disproved it immediately:
//
//   PROMISE ERROR: FaceLandmark68Net - load model before inference
//
// withFaceDescriptor() is not defined on the detectSingleFace() result; it
// lives on the class withFaceLandmarks() returns. The landmark step is the only
// route to a descriptor, and the original comment in the file was correct.
ok(/faceLandmark68Net\.loadFromUri/.test(src),
  'faceLandmark68Net IS loaded (removing it breaks face detection)');
ok(/withFaceLandmarks\(\)\s*\n?\s*\.withFaceDescriptor\(\)/.test(src),
  'the landmark -> descriptor chain is intact');
ok(!/typeof raw\.withFaceDescriptor === 'function'/.test(src),
  'the incorrect landmark-skipping fast path is gone');

// The chain is load-bearing, so assert the model and the call are both present.
// A partial revert (model loaded, chain removed) would fail at runtime only.
ok(/faceLandmark68Net\.loadFromUri[\s\S]*?faceRecognitionNet\.loadFromUri/.test(code),
  'landmark net loads before the recognition net');

// --- 2. the sampling gap must be self-tuning, not a ratchet -----------------
ok(!/detectGap \+ 150/.test(code), 'the +150ms ratchet is gone');
ok(!/slowPassMs/.test(code), 'slowPassMs is no longer referenced in code');
ok(/lastPassMs \* \(1 \+ gapSlack\)/.test(code),
  'the gap is derived from the measured pass time');
ok(/detectGap \+ \(targetGap - detectGap\) \* 0\.5/.test(code),
  'the gap is smoothed so one slow outlier cannot yank it');

const maxMatch = code.match(/FACE_ADAPTIVE_MAX_MS \|\| (\d+)/);
ok(!!maxMatch && parseInt(maxMatch[1], 10) <= 500,
  'in-function ceiling is ' + (maxMatch ? maxMatch[1] : 'unknown') + 'ms (was 1400)');
// The window.* overrides take precedence over the in-function defaults, which is
// how the ratchet kept its 1400ms ceiling after the controller was rewritten.
const winMax = code.match(/window\.FACE_ADAPTIVE_MAX_MS\s*=\s*(\d+)/);
ok(!!winMax && parseInt(winMax[1], 10) <= 500,
  'window.FACE_ADAPTIVE_MAX_MS is ' + (winMax ? winMax[1] : 'unset') + 'ms, not 1400');
const winMin = code.match(/window\.FACE_ADAPTIVE_MIN_MS\s*=\s*(\d+)/);
ok(!!winMin && parseInt(winMin[1], 10) <= 250,
  'window.FACE_ADAPTIVE_MIN_MS is ' + (winMin ? winMin[1] : 'unset') + 'ms, not 400');
ok(/FACE_GAP_SLACK/.test(code), 'slack is configurable');

// --- 3. it must settle, not run away ---------------------------------------
function settle(passMs, startGap) {
  let gap = startGap;
  const min = 200, max = 450, slack = 0.35;
  for (let i = 0; i < 8; i++) {
    const target = Math.max(min, Math.min(max, passMs * (1 + slack)));
    gap = gap + (target - gap) * 0.5;
  }
  return gap;
}
for (const passMs of [120, 250, 400, 600]) {
  ok(settle(passMs, 200) <= 451,
    'a ' + passMs + 'ms pass settles to ' + Math.round(settle(passMs, 200)) + 'ms gap (not runaway)');
}
ok(Math.min(1400, 200 + 150 * 9) === 1400,
  'for contrast the old ratchet reached 1400ms -> 4200ms to sign in');

if (failed) process.exit(1);
console.log('  ok      sampling is bounded and the landmark net is left alone');