// Guards the live camera on the admin overview.
//
// There is no socket between the Pi and the dashboard: the Pi is behind the
// shop's NAT and Netlify only runs functions. So the kiosk publishes a still
// frame every ~1.5s and the overview shows the newest one. Three things have to
// stay true or the feature silently degrades into an empty rectangle:
//
//   1. the kiosk actually captures from its own camera element (see the
//      getElementById('video') bug that killed face snapshots),
//   2. it only publishes while the shop switched the feed on, and
//   3. the dashboard stops polling when nobody is looking at it.
//
// Run: node scripts/check-kiosk-live-camera.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

// --- migration --------------------------------------------------------------
const mig = read('migrations/20261104_kiosk_live_frames.sql');
ok(/CREATE TABLE IF NOT EXISTS kiosk_frames/.test(mig),
  'the migration creates the frames table');
ok(/created_at TIMESTAMPTZ/.test(mig), 'frames carry a timestamp, so age can be shown');
ok(/ADD COLUMN IF NOT EXISTS camera_stream_enabled/.test(mig),
  'the migration adds the live-camera switch to kiosk_settings');

// --- kiosk: capture --------------------------------------------------------
const kiosk = read('kiosk/walkin.html');
const capture = (kiosk.match(/function captureLiveFrame\(\)[\s\S]*?\n\}/) || [''])[0];
ok(capture.length > 0, 'captureLiveFrame() exists');
ok(/getElementById\('kioskCam'\)/.test(capture),
  'the live frame is captured from the kiosk camera element');
ok(/Math\.min\(480, v\.videoWidth\)/.test(capture),
  'frames are downscaled to 480px so one upload is ~20-30KB');
ok(/toDataURL\('image\/jpeg'/.test(capture), 'frames are JPEG data URIs');
ok(!/captureFaceSnapshot/.test(capture),
  'the live view is the whole frame, not the face crop');

// --- kiosk: publishing ------------------------------------------------------
ok(/function startLiveStream\(\)/.test(kiosk) && /function stopLiveStream\(\)/.test(kiosk),
  'the stream can be started and stopped');
ok(/setInterval\(sendLiveFrame, 1500\)/.test(kiosk),
  'a frame is published every 1.5s');
ok(/if \(liveFrameSending\) return;/.test(kiosk),
  'frames never queue up behind a slow upload');
// A request that never settles must not leave the flag stuck on: on shop wifi a
// half-open connection used to stop the feed until the page was reloaded.
ok(/setTimeout\(done, 8000\)/.test(kiosk),
  'a watchdog releases the send flag when a request hangs');
ok(/action === 'kiosk-frame'/.test(read('netlify/functions/data.js')) ||
   /'kiosk-frame'/.test(kiosk), 'the kiosk posts to the kiosk-frame endpoint');

// The camera is customer-controlled: the kiosk must never open it by itself.
// The shop asked for that explicitly, and reopening it from a settings poll also
// stole the frame from whoever was mid-login.
const apply = (kiosk.match(/function applyKioskSettings\(s\)[\s\S]*?\n\}/) || [''])[0];
ok(!/toggleCamera/.test(apply),
  'settings never switch the kiosk camera on - only the button does');
ok(/syncLiveStream\(\)/.test(apply), 'settings changes resync the publisher');
ok(/function startGuest\(\)[\s\S]{0,400}cameraOn = false;/.test(kiosk),
  'guest mode clears the camera state it just stopped');

const camUi = (kiosk.match(/function applyCameraUi\(\)[\s\S]*?\n\}/) || [''])[0];
ok(/syncLiveStream\(\)/.test(camUi),
  'tapping Turn on camera starts publishing (every camera change funnels here)');

const sync = (kiosk.match(/function syncLiveStream\(\)[\s\S]*?\n\}/) || [''])[0];
ok(/cameraOn && !inMaintenance/.test(sync),
  'publishing follows the camera actually running');
ok(/startLiveStream\(\)/.test(sync) && /stopLiveStream\(\)/.test(sync),
  'it can start and stop the publisher');

// --- backend ----------------------------------------------------------------
const data = read('netlify/functions/data.js');
const handler = (data.match(/async function handleKioskFrame\(event\)[\s\S]*?\n\}/) || [''])[0];
ok(handler.length > 0, 'handleKioskFrame() exists');
ok(/data:\(image/.test(handler) && /base64/.test(handler),
  'only image data URIs are accepted');
ok(/LIVE_FRAME_MAX_CHARS/.test(handler), 'frames are size capped');
ok(/created_at.*lt\./.test(handler), 'old frames are pruned');

// One home for the retention window, and retention that survives the publisher
// stopping: pruning only on write left the last pictures in the table forever
// once the shop switched the feed off.
const shared = read('netlify/functions/_shared.js');
ok(/const LIVE_FRAME_WINDOW_MIN = \d+/.test(shared),
  'the retention window is defined once, in _shared.js');
ok(/LIVE_FRAME_WINDOW_MIN/.test(shared.match(/module\.exports[\s\S]{0,600}/) || ''),
  'the retention window is exported');
ok(!/const LIVE_FRAME_WINDOW_MIN = \d+/.test(data),
  'data.js imports the window instead of redefining it');

const adminJs = read('netlify/functions/admin.js');
ok(/function pruneLiveFrames\(\)/.test(adminJs), 'the reader prunes as well as the writer');
ok(/async function getKioskFrameLatest\(\) \{\s*pruneLiveFrames\(\)/.test(adminJs),
  'fetching the newest frame prunes expired ones first');
ok(/async function getKioskFrames\(url\) \{\s*pruneLiveFrames\(\)/.test(adminJs),
  'listing recent frames prunes expired ones first');
for (const action of ['kiosk-frame-latest', 'kiosk-frames', 'kiosk-frame']) {
  ok(adminJs.indexOf("'" + action + "'") !== -1, 'the admin API exposes ' + action);
}
ok(/'Cache-Control': 'no-store/.test(adminJs), 'a live frame is never cached');
ok(/camera_stream_enabled/.test(adminJs), 'kiosk settings carry the switch');

// --- admin page -------------------------------------------------------------
const admin = read('admin/admin.html');
ok(/id="liveCamImg"/.test(admin), 'the overview has an image element for the feed');
ok(/id="liveCamStrip"/.test(admin), 'recent captures are listed');
// The camera is customer-controlled now, so the admin must not carry a control
// that claims to switch it on - and nothing may dereference that missing input.
ok(!/kioskCameraStream/.test(admin),
  'the admin has no "keep camera on" switch left to disagree with the kiosk');
ok(/function downloadLiveFrame\(\)/.test(admin) && /function downloadFrameById\(/.test(admin),
  'the current frame and any listed frame can be downloaded');
ok(/X-Session-Token/.test(admin), 'frames are fetched with the session token');

// Polling must not run when nobody is looking: this is a Pi burning CPU and a
// function invocation budget, not a decoration.
ok(/overviewOnScreen\(\)/.test(admin), 'polling is tied to the overview section');
ok(/document\.hidden/.test(admin), 'polling stops when the tab is hidden');
ok(/if \(name === 'overview'\) refreshLiveCam\(\); else stopLiveCam\(\);/.test(admin),
  'leaving the overview stops the poll');

// The feed is discovered by polling, not gated on the admin switch, otherwise a
// customer tapping "Turn on camera" would never show up on the dashboard.
ok(!/if \(!liveCamEnabled \|\| !overviewOnScreen\(\)/.test(admin),
  'polling does not require the admin switch to be on');
ok(/liveCamMisses/.test(admin) && /Math\.pow\(1\.5, liveCamMisses\)/.test(admin),
  'polling backs off while the kiosk camera is off');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('\nlive camera checks passed.');
