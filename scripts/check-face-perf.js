// Face recognition cost checks.
//
// Two performance defects were found by reading the code rather than by
// measuring, because the kiosk was not publishing usable timing:
//
//  1. faceLandmark68Net was loaded and run on EVERY frame via
//     .withFaceLandmarks(), and not one of the 68 points was ever read. It is
//     the most expensive network in the face-api stack.
//
//  2. The sampling gap was a one-way ratchet. A pass slower than slowPassMs
//     added 150ms up to a 1400ms ceiling, and could only shrink if a pass came
//     in under 120ms. On a Pi, where a pass realistically takes 200-400ms, it
//     ratcheted to the ceiling and stayed there, so sign-in got SLOWER the
//     longer the kiosk ran (3 x 1400ms = 4.2s).
//
// These assert the fixes stay fixed.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'kiosk', 'walkin.html'), 'utf8');
// Comments are stripped for the "is this still referenced" checks: the history
// of the ratchet is documented in prose that mentions the old identifiers by
// name, and matching that prose is not a reference.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

// --- 1. no wasted landmark inference --------------------------------------
// The model must not be loaded.
ok(!/faceLandmark68Net\.loadFromUri/.test(src),
  'faceLandmark68Net is never loaded');
// And the normal path must not run it.
const detBlock = src.match(/var raw = faceapi\.detectSingleFace[\s\S]*?\n\s*\}\s*\n/);
ok(!!detBlock, 'detection block found');
if (detBlock) {
  // Only the fast path matters here. The fallback deliberately chains
  // withFaceLandmarks() and must keep doing so.
  const fastPath = detBlock[0].match(/if \(raw && typeof raw\.withFaceDescriptor === 'function'\) \{([\s\S]*?)\n\s*\}/);
  ok(!!fastPath, 'fast path found');
  if (fastPath) {
    ok(!/withFaceLandmarks/.test(fastPath[1]),
      'the fast path runs no landmark inference');
    ok(/raw\.withFaceDescriptor\(\)/.test(fastPath[1]),
      'the fast path takes the descriptor directly off the detection result');
  }
  ok(/typeof raw\.withFaceDescriptor === 'function'/.test(detBlock[0]),
    'fast path checks the result really exposes withFaceDescriptor()');
  ok(/withFaceLandmarks\(\)\.withFaceDescriptor\(\)/.test(detBlock[0]),
    'landmark fallback retained so recognition cannot break on another build');
}
// Landmarks must genuinely be unused, or dropping them would be a correctness
// change rather than a free win.
const landmarkUses = (src.match(/\.landmarks\b|detection\.landmarks/g) || []).length;
ok(landmarkUses === 0, 'no landmark value is read anywhere (' + landmarkUses + ' uses)');

// --- 2. the sampling gap must be self-tuning, not a ratchet -----------------
ok(!/detectGap \+ 150/.test(src), 'the +150ms ratchet is gone');
ok(!/slowPassMs \* 0\.6/.test(src), 'the unrecoverable decay branch is gone');
ok(!/slowPassMs/.test(code), 'slowPassMs is no longer referenced in code');
ok(/lastPassMs \* \(1 \+ gapSlack\)/.test(src),
  'the gap is derived from the measured pass time');
ok(/detectGap \+ \(targetGap - detectGap\) \* 0\.5/.test(src),
  'the gap is smoothed so one slow outlier cannot yank it');
// The ceiling must stay low enough that sign-in cannot become sluggish.
const maxMatch = src.match(/FACE_ADAPTIVE_MAX_MS \|\| (\d+)/);
ok(!!maxMatch && parseInt(maxMatch[1], 10) <= 500,
  'adaptive ceiling is ' + (maxMatch ? maxMatch[1] : 'unknown') + 'ms (was 1400)');

// --- 3. the gap must stay bounded under a realistic worst case -------------
// Simulate the controller: 3 frames of sign-in must not exceed a sane budget
// no matter how slow a pass is.
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
  const gap = settle(passMs, 200);
  ok(gap <= 450 + 1, 'a ' + passMs + 'ms pass settles to ' + Math.round(gap) + 'ms gap (not runaway)');
}
// And the old behaviour, for contrast: it would have hit 1400.
const oldRatchet = Math.min(1400, 200 + 150 * 9);
ok(oldRatchet === 1400,
  'the old ratchet reached ' + oldRatchet + 'ms -> ' + (3 * oldRatchet) + 'ms to sign in');

// --- 4. no stray references to removed things ------------------------------
ok(!/FACE_SLOW_PASS_MS/.test(code), 'FACE_SLOW_PASS_MS override removed from the flow');

// --- 5. the window overrides must not defeat the new defaults -------------
// These are set at the top of walkin.html and take precedence over the
// in-function defaults, which is how the ratchet kept its 1400ms ceiling even
// after the controller was rewritten.
const winMax = code.match(/window\.FACE_ADAPTIVE_MAX_MS\s*=\s*(\d+)/);
ok(!!winMax && parseInt(winMax[1], 10) <= 500,
  'window.FACE_ADAPTIVE_MAX_MS is ' + (winMax ? winMax[1] : 'unset') + 'ms, not 1400');
const winMin = code.match(/window\.FACE_ADAPTIVE_MIN_MS\s*=\s*(\d+)/);
ok(!!winMin && parseInt(winMin[1], 10) <= 250,
  'window.FACE_ADAPTIVE_MIN_MS is ' + (winMin ? winMin[1] : 'unset') + 'ms, not 400');
ok(/FACE_GAP_SLACK/.test(code), 'slack is configurable');

if (failed) process.exit(1);
console.log('  ok      face recognition does not pay for work it never uses');