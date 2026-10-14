// Checks that the kiosk's inline script actually puts its functions and
// constants on the global scope.
//
// `node --check` cannot catch this class of bug. walkin.html contains one
// giant classic <script>, and a function declared inside another function is
// perfectly valid JavaScript -- it just is not global. The face-matching
// guards were written next to detect(), which lives inside
// startFaceDetection(), so resetFaceStreak and the FACE_* constants became
// function-scoped. The page parsed fine, the kiosk loaded fine, and
// toggleCamera() threw "resetFaceStreak is not defined" the moment anybody
// tapped the camera button.
//
// So: evaluate the script in real global scope (vm.runInThisContext, not
// require(), which would wrap it in a CommonJS module) behind a stubbed DOM,
// then assert the names that are called from inline handlers actually exist.
//
// Run: node scripts/check-kiosk-globals.js

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Optional path argument, so the checker can be pointed at a deliberately
// broken copy to confirm it actually fails on that class of bug.
const HTML = process.argv[2] || path.join(ROOT, 'kiosk', 'walkin.html');

// Names reached from inline onclick/onchange attributes, or from global
// timers and async callbacks. If any of these is missing, the kiosk breaks in
// a way that looks like an unrelated failure.
const REQUIRED_GLOBALS = [
  'resetFaceStreak', 'applyCameraUi', 'toggleCamera', 'setFaceStatus',
  'openCamera', 'stopCamera', 'startFaceDetection', 'restartCamera',
  'lookupPin', 'pkKeypadPress', 'pkKeypadBack', 'pkKeypadClear',
  'showPrintingScreen', 'finishPrintScreen', 'confirmPayment',
  'closeReceipt', 'startGuest', 'bootKiosk',
];

const REQUIRED_VALUES = [
  'FACE_MATCH_THRESHOLD', 'FACE_HOLD_FRAMES',
  'FACE_MIN_FACE_RATIO', 'faceStreak', 'cameraOn', 'KIOSK_APP_VERSION',
];

// Deliberately NOT required: detect() and overlayBlocking() are nested inside
// startFaceDetection() on purpose -- they capture that function's locals
// (matcher, video, ctx) and cannot be lifted out.

function mkEl() {
  return {
    textContent: '', innerHTML: '', value: '', srcObject: null,
    style: {}, dataset: {}, children: [], className: '',
    videoWidth: 0, videoHeight: 0, paused: true,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    getContext() { return { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {} }; },
    play() { return Promise.resolve(); },
    getBoundingClientRect() { return { width: 640, height: 480, left: 0, top: 0 }; },
    querySelector() { return mkEl(); }, querySelectorAll() { return []; },
    focus() {}, click() {},
  };
}

function installShim() {
  const el = mkEl();
  globalThis.document = {
    getElementById() { return el; },
    querySelector() { return el; },
    querySelectorAll() { return []; },
    createElement() { return mkEl(); },
    body: mkEl(), documentElement: mkEl(),
    addEventListener() {}, removeEventListener() {}, cookie: '',
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.navigator = { mediaDevices: null, serviceWorker: null, userAgent: 'check' };
  globalThis.location = { href: 'http://localhost:8000/kiosk/walkin.html', search: '', hostname: 'localhost' };
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.sessionStorage = globalThis.localStorage;
  globalThis.performance = { now: () => Date.now() };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.setInterval = () => 0;
  globalThis.clearTimeout = () => {};
  globalThis.clearInterval = () => {};
  globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  globalThis.Image = function () { return { onload: null }; };
  globalThis.AudioContext = function () { return { createMediaStreamDestination() { return {}; }, destination: {} }; };
  globalThis.webkitAudioContext = globalThis.AudioContext;
  globalThis.MediaRecorder = function () { return { start() {}, stop() {}, ondataavailable: null }; };
  globalThis.piLog = () => {};
}

function main() {
  const html = fs.readFileSync(HTML, 'utf8');
  const blocks = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  if (!blocks.length) {
    console.error('  FAILED  no inline script found in walkin.html');
    return 1;
  }

  // The main block is the largest one; the others are small config shims.
  let main = '';
  for (const b of blocks) {
    const code = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    if (code.length > main.length) main = code;
  }

  installShim();
  try {
    vm.runInThisContext(main, { filename: 'walkin-inline.js' });
  } catch (e) {
    // A throw here is fine -- the DOM is stubbed. What matters is what got
    // defined before the throw.
    console.log('  (script stopped early on the stubbed DOM: ' + String(e.message).split('\n')[0] + ')');
  }

  let bad = 0;

  for (const name of REQUIRED_GLOBALS) {
    if (typeof globalThis[name] !== 'function') {
      bad++;
      console.error('  FAILED  function ' + name + ' is not global (' + typeof globalThis[name] + ')');
      console.error('          it is almost certainly nested inside another function');
    }
  }

  for (const name of REQUIRED_VALUES) {
    if (typeof globalThis[name] === 'undefined') {
      bad++;
      console.error('  FAILED  value ' + name + ' is not reachable globally');
      console.error('          it is almost certainly nested inside another function');
    }
  }

  if (bad === 0) {
    console.log('  ok      all ' + (REQUIRED_GLOBALS.length + REQUIRED_VALUES.length) +
      ' kiosk globals are genuinely global');
  }
  return bad ? 1 : 0;
}

process.exit(main());
