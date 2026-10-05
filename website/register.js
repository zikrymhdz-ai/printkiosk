const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_KEY = CONFIG.SUPABASE_KEY;

let faceDescriptors = [];
let faceImages = [];
let faceCaptures = 0;
let videoStream = null;
let isFaceModelLoaded = false;
let faceDetectionInterval = null;
let faceSkipped = false;

let pendingEmail = '';
let pendingName = '';
let pendingPassword = '';
let pendingPhone = '';
let pendingPin = '';

// --- Gmail validation ---
function validateGmailInput() {
  const el = document.getElementById('email');
  const val = el.value.trim().toLowerCase();
  el.value = val;
  if (val && !/^[a-zA-Z0-9._%+\-]+@gmail\.com$/.test(val)) {
    el.style.borderColor = '#dc2626';
  } else {
    el.style.borderColor = '';
  }
}

// --- Malaysian phone validation ---
function validatePhoneInput() {
  const el = document.getElementById('phone');
  const val = el.value.trim();
  const clean = val.replace(/[\s\-]/g, '');
  const valid = /^(?:\+?60|0)?1[0-9]{8,9}$/.test(clean);
  el.style.borderColor = (val && !valid) ? '#dc2626' : '';
}

// --- Face capture ---
async function initFaceBackend() {
  try {
    if (faceapi.tf.setWasmPaths) faceapi.tf.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
    if (faceapi.tf.env && faceapi.tf.env().set) {
      faceapi.tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
      faceapi.tf.env().set('WASM_HAS_SIMD_SUPPORT', false);
    }
  } catch (e) {}
  const isApple = /iP(hone|ad|od)|Macintosh/.test(navigator.userAgent);
  const backends = isApple ? ['wasm', 'webgl', 'cpu'] : ['webgl', 'wasm', 'cpu'];
  for (const b of backends) {
    try { await faceapi.tf.setBackend(b); await faceapi.tf.ready(); return true; } catch (e) {}
  }
  return false;
}

async function loadFaceModels() {
  const modelUrls = [
    'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model',
    '../models'
  ];
  await initFaceBackend();
  for (const url of modelUrls) {
    try {
      await faceapi.nets.ssdMobilenetv1.loadFromUri(url);
      await faceapi.nets.faceLandmark68Net.loadFromUri(url);
      await faceapi.nets.faceRecognitionNet.loadFromUri(url);
      isFaceModelLoaded = true;
      return;
    } catch (e) {}
  }
  console.warn('Face models failed to load');
}

document.getElementById('startCamBtn').addEventListener('click', async () => {
  if (!isFaceModelLoaded) {
    document.getElementById('faceStatus').textContent = 'Loading face detection...';
    await loadFaceModels();
    if (!isFaceModelLoaded) {
      document.getElementById('faceStatus').textContent = 'Face detection unavailable. You can skip.';
      return;
    }
  }
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
    const videoEl = document.getElementById('video');
    videoEl.srcObject = videoStream;
    try { await videoEl.play(); } catch(e) {}
    document.getElementById('startCamBtn').disabled = true;
    document.getElementById('startCamBtn').textContent = 'Camera Active';
    document.getElementById('faceStatus').textContent = 'Detecting face... Look at the camera.';
    startAutoDetection();
  } catch (e) {
    document.getElementById('faceStatus').textContent = 'Camera access denied. You can skip face capture.';
  }
});

function startAutoDetection() {
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const status = document.getElementById('faceStatus');
  const frameCanvas = document.createElement('canvas');
  const frameCtx = frameCanvas.getContext('2d');
  let lastCaptureTime = 0;
  let lastBlockedAt = 0;

  faceDetectionInterval = setInterval(async () => {
    if (faceCaptures >= 3 || !videoStream || video.ended) {
      clearInterval(faceDetectionInterval);
      return;
    }
    if (video.paused) {
      const now2 = Date.now();
      if (!lastBlockedAt) lastBlockedAt = now2;
      if (now2 - lastBlockedAt > 5000) { clearInterval(faceDetectionInterval); status.textContent = 'Camera stream stalled. Tap Start again.'; return; }
      try { video.play(); } catch(e) {}
      return;
    }
    lastBlockedAt = 0;

    try {
      frameCanvas.width = video.videoWidth;
      frameCanvas.height = video.videoHeight;
      frameCtx.drawImage(video, 0, 0);
      const detections = await faceapi.detectSingleFace(frameCanvas)
        .withFaceLandmarks()
        .withFaceDescriptor();

      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);

      if (detections) {
        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        const resized = faceapi.resizeResults(detections, displaySize);

        const box = resized.detection.box;
        const scaleX = overlay.width / displaySize.width;
        const scaleY = overlay.height / displaySize.height;
        const x = box.x * scaleX;
        const y = box.y * scaleY;
        const w = box.width * scaleX;
        const h = box.height * scaleY;

        const now = Date.now();
        const confidence = resized.detection.score;

        if (confidence > 0.85 && (now - lastCaptureTime) > 2000) {
          ctx.strokeStyle = '#16a34a';
          ctx.lineWidth = 3;
          ctx.strokeRect(x, y, w, h);
          status.textContent = 'Face detected! Capturing...';
          status.style.color = '#16a34a';

          lastCaptureTime = now;
          await autoCapture(video, detections);
        } else {
          ctx.strokeStyle = confidence > 0.7 ? '#f59e0b' : 'rgba(255,255,255,0.4)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, h);
          if (confidence > 0.7) {
            status.textContent = 'Hold still... capturing soon.';
            status.style.color = '#f59e0b';
          } else {
            status.textContent = 'Move closer to the camera.';
            status.style.color = '';
          }
        }
      } else {
        status.textContent = 'No face detected. Look at the camera.';
        status.style.color = '';
      }
    } catch (e) {
      console.warn('face detect error', e);
      status.textContent = 'Face scanning error';
    }
  }, 300);
}

async function autoCapture(video, detection) {
  if (faceCaptures >= 3) return;
  faceCaptures++;
  faceDescriptors.push(Array.from(detection.descriptor));

  const captureCanvas = document.createElement('canvas');
  captureCanvas.width = 320;
  captureCanvas.height = 240;
  const captureCtx = captureCanvas.getContext('2d');
  captureCtx.drawImage(video, 0, 0, 320, 240);
  faceImages.push(captureCanvas.toDataURL('image/jpeg', 0.8));

  const preview = document.getElementById('preview' + faceCaptures);
  preview.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
  preview.style.border = '2px solid #16a34a';
  preview.style.background = '#f0fdf4';

  const status = document.getElementById('faceStatus');
  if (faceCaptures >= 3) {
    status.textContent = 'Face data captured! Complete registration below.';
    status.style.color = '#16a34a';
    clearInterval(faceDetectionInterval);
    if (videoStream) {
      videoStream.getTracks().forEach(t => t.stop());
      videoStream = null;
    }
  } else {
    status.textContent = 'Photo ' + faceCaptures + '/3 captured. Keep looking...';
    status.style.color = '#16a34a';
  }
}

document.getElementById('skipFaceBtn').addEventListener('click', function() {
  faceSkipped = true;
  if (videoStream) {
    videoStream.getTracks().forEach(t => t.stop());
    videoStream = null;
  }
  clearInterval(faceDetectionInterval);
  document.getElementById('faceStep').style.display = 'none';
  document.getElementById('skipFaceBtn').textContent = 'Face capture skipped';
  document.getElementById('skipFaceBtn').disabled = true;
});

// --- Phase 1: Register ---
document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('registerError');
  errorEl.style.display = 'none';

  if (document.getElementById('verifyStep').style.display !== 'none') return;

  const name = document.getElementById('name').value.trim();
  const email = document.getElementById('email').value.trim().toLowerCase();
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  const phone = document.getElementById('phone').value.trim();
  const btn = document.getElementById('registerBtn');

  if (!name) { showError(errorEl, 'Name is required'); return; }

  if (!/^[a-zA-Z0-9._%+\-]+@gmail\.com$/.test(email)) {
    showError(errorEl, 'Only Gmail addresses are accepted');
    return;
  }

  if (!/^(?:\+?60|0)?1[0-9]{8,9}$/.test(phone.replace(/[\s\-]/g, ''))) {
    showError(errorEl, 'Enter a valid Malaysian mobile number (e.g. 010-1234567)');
    return;
  }

  if (password.length < 6) { showError(errorEl, 'Password must be at least 6 characters'); return; }
  if (password !== confirm) { showError(errorEl, 'Passwords do not match'); return; }

  if (!document.getElementById('termsAccepted') || !document.getElementById('termsAccepted').checked) {
    showError(errorEl, 'Please accept the Terms and Conditions to continue');
    return;
  }

  pendingName = name;
  pendingEmail = email;
  pendingPassword = password;
  pendingPhone = phone;

  btn.disabled = true;
  btn.textContent = 'Registering...';

  try {
    const res = await fetch(API('auth', 'register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, phone })
    });

    const data = await res.json();

    if (!data.success) {
      showError(errorEl, data.error || 'Registration failed');
      btn.disabled = false;
      btn.textContent = 'Create Account';
      return;
    }

    if (!data.verification_required) {
      PKS.set('session_token', data.session_token);
      PKS.set('user', JSON.stringify(data.user));
      await saveFaceIfCaptured(data.session_token);
      window.location.href = 'customer.html';
      return;
    }

    // Show OTP step
    document.getElementById('verifyEmailDisplay').textContent = email;
    document.getElementById('verifyStep').style.display = 'block';
    btn.style.display = 'none';
    document.getElementById('faceStep').style.display = 'none';
    document.getElementById('skipFaceBtn').style.display = 'none';
    document.getElementById('verifyError').style.display = 'none';
    document.getElementById('verifyCode').value = '';
    document.getElementById('verifyCode').focus();
  } catch (err) {
    showError(errorEl, 'Connection error. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});

// --- Phase 2: Verify email ---
async function verifyEmail() {
  const code = document.getElementById('verifyCode').value.trim();
  const errorEl = document.getElementById('verifyError');
  const btn = document.getElementById('verifyBtn');

  errorEl.style.display = 'none';

  if (!code || code.length !== 6) {
    errorEl.textContent = 'Enter the 6-digit code';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying...';

  try {
    const res = await fetch(API('auth', 'verify-email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, code })
    });

    const data = await res.json();

    if (!data.success) {
      errorEl.style.color = '#dc2626';
      errorEl.textContent = data.error || 'Verification failed';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Verify & Complete';
      return;
    }

    PKS.set('session_token', data.session_token);
    PKS.set('user', JSON.stringify(data.user));

    await saveFaceIfCaptured(data.session_token);
    window.location.href = 'customer.html';
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Verify & Complete';
  }
}

async function resendCode() {
  const btn = document.getElementById('resendBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const res = await fetch(API('auth', 'resend-code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Failed to resend code');
      btn.textContent = 'Resend Code';
      btn.disabled = false;
      return;
    }
    btn.textContent = 'Sent! Check inbox';
    setTimeout(() => { btn.textContent = 'Resend Code'; btn.disabled = false; }, 5000);
  } catch (e) {
    btn.textContent = 'Resend Code';
    btn.disabled = false;
  }
}

async function saveFaceIfCaptured(sessionToken) {
  if (faceSkipped || faceDescriptors.length === 0 || !sessionToken) return;
  try {
    const avg = averageDescriptors(faceDescriptors);
    await fetch(API('auth', 'save-face'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ descriptor: avg, face_images: faceImages })
    });
  } catch (e) {}
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

function averageDescriptors(descs) {
  if (descs.length === 0) return [];
  const avg = new Array(128).fill(0);
  for (const desc of descs) {
    for (let i = 0; i < 128; i++) {
      avg[i] += desc[i];
    }
  }
  return avg.map(v => v / descs.length);
}
