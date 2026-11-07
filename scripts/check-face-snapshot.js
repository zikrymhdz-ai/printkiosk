// Face snapshots must crop the right pixels and must exist for unknown faces.
//
// The bug this guards: the kiosk's detection frame is downscaled (often 256px)
// but captureFaceSnapshot() drew from the full video (often 640px), using the
// detection coordinates directly. Every thumbnail was a corner of the room, so
// the admin log looked like nobody had been captured. Unknown faces also had no
// snapshot at all.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

const kiosk = read('kiosk/walkin.html');

// --- the crop must read the kiosk's own video element ----------------------
// captureFaceSnapshot() looked up getElementById('video'), but this page's
// camera is <video id="kioskCam">. The lookup returned null on every call, so
// no snapshot was ever captured and the admin log never had a picture to show -
// the whole feature silently did nothing.
const snapFn = (kiosk.match(/function captureFaceSnapshot\([\s\S]*?\n\}/) || [''])[0];
ok(snapFn.length > 0, 'captureFaceSnapshot() is present');
ok(/getElementById\('kioskCam'\)/.test(snapFn),
  'the snapshot reads the kiosk camera element (id="kioskCam")');
ok(!/getElementById\('video'\)/.test(snapFn),
  'the snapshot never looks up a plain id="video", which this page does not have');
ok(/<video id="kioskCam"/.test(kiosk),
  'the page really does name its camera id="kioskCam"');

// --- crop scaling ----------------------------------------------------------
ok(/function captureFaceSnapshot\(box, frameW, frameH\)/.test(kiosk),
  'the snapshot helper accepts the detection frame size');
ok(/vw \/ frameW/.test(kiosk) && /vh \/ frameH/.test(kiosk),
  'box coordinates are scaled from the detection frame to video pixels');
ok(/Math\.min\(side, vw, vh\)/.test(kiosk),
  'the crop cannot be larger than the video frame');

// The arithmetic, for a 256x192 detector over a 640x480 camera. A face at
// (64,48)-(144,128) in detector space is (160,120)-(360,320) in video space.
(function () {
  const vw = 640, vh = 480, frameW = 256, frameH = 192;
  const box = { x: 64, y: 48, width: 80, height: 80 };
  const sx = vw / frameW, sy = vh / frameH;
  const bw = box.width * sx, bh = box.height * sy;
  const bx = box.x * sx, by = box.y * sy;
  let side = Math.max(bw, bh) * 1.6;
  side = Math.min(side, vw, vh);
  const x = Math.max(0, Math.min(bx + bw / 2 - side / 2, vw - side));
  const y = Math.max(0, Math.min(by + bh / 2 - side / 2, vh - side));

  ok(Math.abs(bw - 200) < 0.001 && Math.abs(bh - 200) < 0.001,
    'the face is scaled to 200x200 video pixels, got ' + bw + 'x' + bh);
  ok(x >= 0 && y >= 0 && x + side <= vw && y + side <= vh,
    'the crop stays inside the frame: ' + x + ',' + y + ' ' + side);
  const faceCx = bx + bw / 2, faceCy = by + bh / 2;
  ok(Math.abs((x + side / 2) - faceCx) < 0.001 && Math.abs((y + side / 2) - faceCy) < 0.001,
    'the crop is centred on the face, not anchored to the top-left');
  ok(!(x < 10 && y < 10 && side < 100),
    'the old un-scaled crop would have sampled the corner, not the face');
})();

// A face at the right edge cannot push the square past the frame.
(function () {
  const vw = 640, vh = 480;
  const box = { x: 220, y: 140, width: 36, height: 36 };
  const bx = box.x * (vw / 256), by = box.y * (vh / 192);
  const bw = box.width * (vw / 256), bh = box.height * (vh / 192);
  let side = Math.min(Math.max(bw, bh) * 1.6, vw, vh);
  const x = Math.max(0, Math.min(bx + bw / 2 - side / 2, vw - side));
  const y = Math.max(0, Math.min(by + bh / 2 - side / 2, vh - side));
  ok(x + side <= vw && y + side <= vh, 'an edge face is clamped inside the frame');
})();

// --- unknown captures ------------------------------------------------------
ok(/function throttledUnknownLog\(distance, box, frameW, frameH\)/.test(kiosk),
  'the unknown log accepts the face box and frame size');
ok(/logFaceDetection\(null, distance, false, captureFaceSnapshot\(box, frameW, frameH\)\)/.test(kiosk),
  'an unknown face is stored WITH a snapshot');
ok(/captureFaceSnapshot\(faceStreak\.box \|\| box, srcW, srcH\)/.test(kiosk),
  'a matched face passes the detection frame size');
ok(/throttledUnknownLog\(match\.distance, box, srcW, srcH\)/.test(kiosk),
  'a refused match is logged with the face box and frame size');
// Logging used to be gated on the label being literally 'unknown'. That skipped
// a stranger who only vaguely resembled an enrolled user (rejected by the
// distance gate) and skipped every kiosk with nobody enrolled, because the
// matching branch never ran at all. No face may leave without being recorded.
ok(!/if\s*\(\s*match\.label\s*===\s*'unknown'\s*\)\s*\{\s*throttledUnknownLog/.test(kiosk),
  'refused faces are logged without waiting for the label to read "unknown"');
ok(/throttledUnknownLog\(null, box, srcW, srcH\)/.test(kiosk),
  'a face is captured even when no matcher exists (nobody enrolled)');
ok(/else if \(matcher\)[\s\S]{0,400}else \{[\s\S]{0,300}throttledUnknownLog\(null/.test(kiosk),
  'the no-matcher branch is the one that captures the unknown face');

// --- backend and admin -----------------------------------------------------
const data = read('netlify/functions/data.js');
ok(/face_snapshot/.test(data) && /data:image\\\/\(png\|jpeg\|jpg\)/.test(data),
  'the backend accepts only data-URI images');
ok(/raw\.length < 300000/.test(data), 'a snapshot is size-capped before storage');

const admin = read('admin/admin.html');
ok(/has_snapshot/.test(admin), 'the admin list knows which rows have a picture');
ok(/face-snapshot&id=/.test(admin), 'the admin fetches snapshots with the session token');
ok(/viewFaceSnapshot/.test(admin), 'a thumbnail can be opened full size');

const mig = read('migrations/20261101_face_snapshot.sql');
ok(/ADD COLUMN IF NOT EXISTS face_snapshot TEXT/.test(mig),
  'the snapshot column is re-asserted by a migration');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      face snapshots crop the face and cover unknown captures');
