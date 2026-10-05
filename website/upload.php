<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>PrintKiosk - Quick Upload</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../styles.css">
<link href="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.css" rel="stylesheet">
<script src="../frontend_config.js"></script>
<script src="pstore.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.js"></script>
<script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>
<style>
  body { background: var(--gray-50); }
  .container { max-width: 480px; margin: 0 auto; padding: 16px; min-height: 100vh; }
  .step { display: none; }
  .step.active { display: block; animation: fadeIn 0.3s ease-out; }
  .step-indicator { display: flex; gap: 8px; justify-content: center; margin-bottom: 24px; }
  .step-dot { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; background: var(--gray-200); color: var(--gray-500); transition: all 0.3s; }
  .step-dot.active { background: var(--primary); color: white; box-shadow: 0 4px 12px rgba(37,99,235,0.3); }
  .step-dot.done { background: var(--success); color: white; }
  .step-line { flex: 1; height: 2px; background: var(--gray-200); align-self: center; }
  .step-line.done { background: var(--success); }
  .nav-back { background:none; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; width:36px; height:36px; margin-right:4px; color:var(--gray-700); border-radius:8px; flex-shrink:0; }
  .nav-back:hover { background:var(--gray-100); }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>

<div class="nav">
  <div class="nav-inner">
    <div class="nav-left">
      <button class="nav-back" onclick="window.location.href='login.html'" aria-label="Back">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <span class="logo"><span class="logo-mark"><svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="ubg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#4C7CFF"/><stop offset="100%" stop-color="#1C2740"/></linearGradient><linearGradient id="ufold" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#E4EBFA"/><stop offset="100%" stop-color="#C7D4EE"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#ubg)"/><g transform="rotate(-7 256 256)"><rect x="149" y="352" width="214" height="32" rx="16" fill="#22C7B8"/><path d="M179 136L305 136L351 182L351 358Q351 376 333 376L179 376Q161 376 161 358L161 154Q161 136 179 136Z" fill="#FFF"/><path d="M305 136L351 182L305 182Z" fill="url(#ufold)"/></g></svg></span>PrintKiosk</span>
      <span class="nav-title">Quick Upload</span>
    </div>
  </div>
</div>

<div class="container">
  <div style="text-align:center; padding:16px 0; margin-bottom:8px;">
    <p class="text-sm text-muted">Scan this from the kiosk to upload from your phone</p>
  </div>

  <div class="card" style="border-radius:var(--radius-xl);">
    <div class="step-indicator">
      <div class="step-dot active" id="step1Dot">1</div>
      <div class="step-line" id="line1"></div>
      <div class="step-dot" id="step2Dot">2</div>
      <div class="step-line" id="line2"></div>
      <div class="step-dot" id="step3Dot">3</div>
    </div>

    <!-- Step 1: Upload -->
    <div class="step active" id="step1">
      <div style="text-align:center; margin-bottom:16px;">
        <h3 style="font-size:18px; font-weight:600;">Upload Your File</h3>
        <p class="text-sm text-muted" style="margin-top:4px;">Select a file from your device</p>
      </div>
      <div class="upload-zone" onclick="document.getElementById('phoneFile').click()" style="padding:32px 16px;">
        <div class="upload-zone-icon" style="margin-bottom:12px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <div class="upload-zone-text">Tap to select file</div>
        <div class="upload-zone-hint">PDF, DOC, DOCX, JPG, PNG -- 20MB max</div>
      </div>
      <input type="file" id="phoneFile" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" style="display:none">
      <div id="phoneFileInfo" style="display:none; margin-top:12px; padding:12px; background:var(--success-light); border-radius:var(--radius); font-size:14px; border:1px solid #bbf7d0;"></div>
      <button class="btn btn-primary btn-block btn-lg" style="margin-top:16px;" onclick="goStep2()" id="step1Btn" disabled>Next -- Settings</button>
    </div>

    <!-- Step 2: Settings -->
    <div class="step" id="step2">
      <div class="form-group" style="margin-bottom:20px;">
        <label>Color Mode</label>
        <select id="pColorMode" class="input" onchange="updatePhoneSummary(); updatePhonePreview()">
          <option value="bw">Black & White (RM 0.20/page)</option>
          <option value="color">Color (RM 1.10/page)</option>
        </select>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label>Copies</label>
          <input type="number" id="pCopies" class="input" value="1" min="1" onchange="updatePhoneSummary()">
        </div>
        <div class="form-group">
          <label>Pages</label>
          <input type="number" id="pPages" class="input" value="1" min="1" onchange="updatePhoneSummary()">
        </div>
      </div>

      <div id="pImageSettings">
        <p class="text-sm text-muted" style="margin:16px 0 12px; padding-top:12px; border-top:1px solid var(--gray-100);">Image adjustments (JPG/PNG)</p>
        <div class="form-group">
          <label>Brightness (<span id="pBrightnessVal">0</span>)</label>
          <input type="range" id="pBrightness" min="-100" max="100" value="0" oninput="document.getElementById('pBrightnessVal').textContent=this.value; updatePhonePreview()" style="width:100%;">
        </div>
        <div class="form-group">
          <label>Contrast (<span id="pContrastVal">0</span>)</label>
          <input type="range" id="pContrast" min="-100" max="100" value="0" oninput="document.getElementById('pContrastVal').textContent=this.value; updatePhonePreview()" style="width:100%;">
        </div>
        <div class="form-group">
          <label>Crop Mode</label>
          <select id="pCropMode" class="input" onchange="updatePhonePreview()">
            <option value="none">None</option>
            <option value="auto">Auto Crop</option>
            <option value="manual">Manual Crop</option>
          </select>
        </div>
      </div>
      <p id="pImageSettingsNote" class="hidden text-sm text-muted">Image settings only available for image files.</p>

<div id="phoneLivePreview" style="background:var(--gray-50); border:1px solid var(--gray-200); border-radius:var(--radius); overflow:visible; margin-top:16px; text-align:center; min-height:160px; display:flex; align-items:center; justify-content:center; position:relative; padding:8px;">
          <p class="text-sm text-muted" id="phonePreviewPlaceholder">Preview will appear here</p>
          <div id="phonePreviewContent" style="display:none; width:100%;"></div>
        </div>
        <div id="phoneCropToolbar" style="display:none; margin-top:10px; flex-wrap:wrap; gap:6px; align-items:center; justify-content:center;">
          <select id="phoneCropRatioSel" class="input" style="width:auto; font-size:12px; padding:5px 8px;" onchange="setPhoneCropRatio()">
            <option value="free" selected>Free</option>
            <option value="a4">A4 (210:297)</option>
            <option value="1:1">1:1</option>
          </select>
          <button class="btn btn-secondary" style="font-size:12px; padding:5px 10px;" onclick="phoneCropZoom(-0.1)">-</button>
          <button class="btn btn-secondary" style="font-size:12px; padding:5px 10px;" onclick="phoneCropZoom(0.1)">+</button>
          <button class="btn btn-secondary" style="font-size:12px; padding:5px 10px;" onclick="phoneCropRotate()">Rotate</button>
          <button class="btn btn-secondary" style="font-size:12px; padding:5px 10px;" onclick="resetPhoneCrop()">Reset</button>
          <button class="btn btn-primary" style="font-size:12px; padding:5px 14px;" onclick="applyPhoneCrop()">Apply Crop</button>
        </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:8px;">
        <div style="padding:6px 8px; background:var(--gray-50); border-radius:var(--radius); border:1px solid var(--gray-100); text-align:center;">
          <p class="text-xs text-muted">Color</p>
          <p class="text-sm" style="font-weight:600;" id="phonePreviewColor">B&W</p>
        </div>
        <div style="padding:6px 8px; background:var(--gray-50); border-radius:var(--radius); border:1px solid var(--gray-100); text-align:center;">
          <p class="text-xs text-muted">Brightness</p>
          <p class="text-sm" style="font-weight:600;" id="phonePreviewBright">0</p>
        </div>
        <div style="padding:6px 8px; background:var(--gray-50); border-radius:var(--radius); border:1px solid var(--gray-100); text-align:center;">
          <p class="text-xs text-muted">Contrast</p>
          <p class="text-sm" style="font-weight:600;" id="phonePreviewContrast">0</p>
        </div>
        <div style="padding:6px 8px; background:var(--gray-50); border-radius:var(--radius); border:1px solid var(--gray-100); text-align:center;">
          <p class="text-xs text-muted">Crop</p>
          <p class="text-sm" style="font-weight:600;" id="phonePreviewCrop">None</p>
        </div>
      </div>

      <div class="order-summary" style="margin-top:16px;">
        <div class="row"><span>File</span><span id="pSummaryFile">-</span></div>
        <div class="row total"><span>Estimated Total</span><span id="pSummaryTotal">RM 0.00</span></div>
      </div>

      <div style="display:flex; gap:8px; margin-top:16px;">
        <button class="btn btn-secondary" style="flex:1;" onclick="goStep1()">Back</button>
        <button class="btn btn-primary" style="flex:1;" onclick="submitPhoneUpload()">Upload & Pay</button>
      </div>
    </div>

    <!-- Step 3: Payment -->
    <div class="step" id="step3" style="text-align:center;">
      <!-- Payment phase: QR -->
      <div id="phonePaySection">
        <h3 style="font-size:18px; font-weight:600; margin-bottom:4px;">Complete Payment</h3>
        <p class="text-sm text-muted" style="margin-bottom:16px;">Scan the QR code below to pay</p>

        <div id="phonePreview" style="display:none; margin-bottom:16px; border-radius:var(--radius-lg); overflow:hidden; border:1px solid var(--gray-200); background:var(--gray-50); text-align:center;"></div>

        <div style="background:var(--gray-50); border-radius:var(--radius-lg); padding:16px; margin-bottom:12px; border:1px solid var(--gray-100); text-align:left;">
          <p class="text-xs text-muted" style="margin-bottom:8px; font-weight:500; text-transform:uppercase; letter-spacing:0.05em;">Order Details</p>
          <div style="display:flex; justify-content:space-between; padding:6px 0;"><span class="text-sm text-muted">Job ID</span><span class="text-sm" style="font-weight:600;" id="phoneJobId">-</span></div>
          <div style="display:flex; justify-content:space-between; padding:6px 0;"><span class="text-sm text-muted">File</span><span class="text-sm" style="font-weight:600; text-align:right; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" id="phoneReceiptFile">-</span></div>
          <div style="display:flex; justify-content:space-between; padding:6px 0;"><span class="text-sm text-muted">Pages</span><span class="text-sm" style="font-weight:600;" id="phoneReceiptPages">-</span></div>
          <div style="display:flex; justify-content:space-between; padding:6px 0;"><span class="text-sm text-muted">Color</span><span class="text-sm" style="font-weight:600;" id="phoneReceiptColor">-</span></div>
          <div style="display:flex; justify-content:space-between; padding:6px 0;"><span class="text-sm text-muted">Copies</span><span class="text-sm" style="font-weight:600;" id="phoneReceiptCopies">-</span></div>
          <div style="display:flex; justify-content:space-between; padding:8px 0 4px; border-top:1px solid var(--gray-200); margin-top:4px;"><span style="font-size:14px; font-weight:600;">Total</span><span style="font-size:16px; font-weight:700; color:var(--primary);" id="phoneAmount">RM 0.00</span></div>
        </div>

        <img src="../maybank_qr.jpeg" alt="Pay" style="width:180px; border-radius:var(--radius); margin-bottom:12px; border:1px solid var(--gray-200);">

        <button class="btn btn-primary btn-block" style="margin-bottom:8px;" onclick="confirmPhonePayment()" id="phoneConfirmPayBtn">Confirm Payment</button>
        <button class="btn btn-secondary btn-block" onclick="cancelPhonePayment()">Cancel</button>
      </div>

      <!-- Receipt phase: PIN -->
      <div id="phoneReceiptSection" style="display:none;">
        <div style="width:56px; height:56px; border-radius:50%; background:var(--success-light); display:flex; align-items:center; justify-content:center; margin:0 auto 16px;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <h3 style="font-size:18px; font-weight:600; margin-bottom:4px;">Payment Confirmed</h3>
        <p class="text-sm text-muted" style="margin-bottom:16px;">Use the PIN below at the kiosk to print.</p>

        <div style="background:var(--warning-light); border-radius:var(--radius-lg); padding:20px; margin-bottom:12px; border:2px dashed var(--warning);">
          <p class="text-xs" style="color:#92400e; margin-bottom:4px; font-weight:500;">Print PIN</p>
          <p style="font-size:42px; font-weight:900; color:var(--primary); letter-spacing:10px; font-family:monospace;" id="phonePrintPin">------</p>
        </div>

        <div style="background:var(--gray-50); border-radius:var(--radius-lg); padding:16px; margin-bottom:16px; border:1px solid var(--gray-100); text-align:left;">
          <p class="text-xs text-muted" style="margin-bottom:8px; font-weight:500; text-transform:uppercase; letter-spacing:0.05em;">Receipt</p>
          <div style="display:flex; justify-content:space-between; padding:6px 0;"><span class="text-sm text-muted">Job ID</span><span class="text-sm" style="font-weight:600;" id="phoneReceiptJobId">-</span></div>
          <div style="display:flex; justify-content:space-between; padding:6px 0;"><span class="text-sm text-muted">File</span><span class="text-sm" style="font-weight:600; text-align:right; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" id="phoneReceiptFile2">-</span></div>
          <div style="display:flex; justify-content:space-between; padding:6px 0;"><span class="text-sm text-muted">Total</span><span style="font-weight:700; color:var(--primary);" id="phoneReceiptTotal">RM 0.00</span></div>
        </div>

        <button class="btn btn-primary btn-block" onclick="window.location.href='upload.php'">Upload Another</button>
      </div>
    </div>
  </div>
</div>

<script>
let phoneFile = null;
let phoneFileDataUrl = null;
let phonePrice = 0;
let phonePdfDoc = null;
let phonePdfPages = 1;
let phoneCurrentPreviewPage = 1;
let phoneCurrentJobId = null;
let phoneUploadedJob = null;
let qToken = '';

PKS.init().then(function() { qToken = localStorage.getItem('session_token') || ''; });

document.getElementById('phoneFile').addEventListener('change', function() {
  if (this.files.length) {
    phoneFile = this.files[0];
    phoneFileDataUrl = null;
    phonePdfDoc = null;
    phonePdfPages = 1;
    const info = document.getElementById('phoneFileInfo');
    info.style.display = 'block';
    info.innerHTML = '<strong>' + phoneFile.name + '</strong> (' + (phoneFile.size/1024/1024).toFixed(2) + ' MB)';
    document.getElementById('step1Btn').disabled = false;
    document.getElementById('pSummaryFile').textContent = phoneFile.name;

    const ext = phoneFile.name.split('.').pop().toLowerCase();
    const isImg = ['jpg','jpeg','png'].includes(ext);
    const isPdf = ext === 'pdf';
    document.getElementById('pImageSettings').style.display = isImg ? 'block' : 'none';
    document.getElementById('pImageSettingsNote').className = isImg ? 'hidden text-sm text-muted' : 'text-sm text-muted';

    if (isImg) {
      const reader = new FileReader();
      reader.onload = function(e) { phoneFileDataUrl = e.target.result; };
      reader.readAsDataURL(phoneFile);
      document.getElementById('pPages').value = 1;
    } else if (isPdf && typeof pdfjsLib !== 'undefined') {
      const reader = new FileReader();
      reader.onload = async function(e) {
        try {
          const pdf = await pdfjsLib.getDocument({ data: e.target.result }).promise;
          phonePdfDoc = pdf;
          phonePdfPages = pdf.numPages;
          document.getElementById('pPages').value = pdf.numPages;
        } catch(err) {}
      };
      reader.readAsArrayBuffer(phoneFile);
    }
  }
});

function goStep1() {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById('step1').classList.add('active');
  document.getElementById('step1Dot').className = 'step-dot active';
  document.getElementById('step2Dot').className = 'step-dot';
  document.getElementById('step3Dot').className = 'step-dot';
  document.getElementById('line1').className = 'step-line';
  document.getElementById('line2').className = 'step-line';
}

function goStep2() {
  if (!phoneFile) { alert('Please select a file'); return; }
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById('step2').classList.add('active');
  document.getElementById('step1Dot').className = 'step-dot done';
  document.getElementById('step2Dot').className = 'step-dot active';
  document.getElementById('step3Dot').className = 'step-dot';
  document.getElementById('line1').className = 'step-line done';
  document.getElementById('line2').className = 'step-line';
  updatePhoneSummary();
  initPhonePreview();
}

function goStep3() {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById('step3').classList.add('active');
  document.getElementById('step1Dot').className = 'step-dot done';
  document.getElementById('step2Dot').className = 'step-dot done';
  document.getElementById('step3Dot').className = 'step-dot active';
  document.getElementById('line1').className = 'step-line done';
  document.getElementById('line2').className = 'step-line done';
}

function updatePhoneSummary() {
  const colorMode = document.getElementById('pColorMode').value;
  const copies = parseInt(document.getElementById('pCopies').value) || 1;
  const pages = parseInt(document.getElementById('pPages').value) || 1;
  let pagePrice = colorMode === 'color' ? 1.10 : 0.20;
  phonePrice = Math.round(pages * pagePrice * copies * 100) / 100;
  document.getElementById('pSummaryTotal').textContent = 'RM ' + phonePrice.toFixed(2);
}

function initPhonePreview() {
  var placeholder = document.getElementById('phonePreviewPlaceholder');
  var content = document.getElementById('phonePreviewContent');
  if (!phoneFile) { placeholder.style.display = 'block'; content.style.display = 'none'; return; }
  placeholder.style.display = 'none';
  content.style.display = 'block';
  content.innerHTML = '';
  destroyPhoneCropper();
  phoneCroppedFile = null;

  var ext = phoneFile.name.split('.').pop().toLowerCase();
  var isImg = ['jpg','jpeg','png'].includes(ext);
  var isPdf = ext === 'pdf';

  if (isImg) {
    var reader = new FileReader();
    reader.onload = function(e) {
      content.innerHTML = '<div class="preview-wrap"><img id="phonePreviewImg" src="" style="transition: filter 0.3s ease; max-height:260px;"></div>';
      var img = document.getElementById('phonePreviewImg');
      img.onload = function() { updatePhonePreview(); phoneSyncManualCrop(); };
      img.src = e.target.result;
    };
    reader.readAsDataURL(phoneFile);
  } else if (isPdf && typeof pdfjsLib !== 'undefined') {
    content.innerHTML = '<canvas id="phonePreviewCanvas" style="display:block; max-width:100%; max-height:300px;"></canvas>';
    var reader = new FileReader();
    reader.onload = async function(e) {
      try {
        phonePdfDoc = await pdfjsLib.getDocument({ data: e.target.result }).promise;
        phonePdfPages = phonePdfDoc.numPages;
        phoneCurrentPreviewPage = 1;
        if (phonePdfPages > 1) {
          var nav = document.createElement('div');
          nav.style.cssText = 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);padding:5px 14px;border-radius:20px;font-size:12px;color:white;display:flex;align-items:center;gap:10px;z-index:5;';
          nav.innerHTML = '<button onclick="changePhonePdfPage(-1)" style="background:none;border:none;color:white;cursor:pointer;font-size:16px;padding:2px 6px;">&#8592;</button>' +
            '<span id="phonePdfPageInfo" style="font-weight:600;min-width:50px;text-align:center;"></span>' +
            '<button onclick="changePhonePdfPage(1)" style="background:none;border:none;color:white;cursor:pointer;font-size:16px;padding:2px 6px;">&#8594;</button>';
          document.getElementById('phoneLivePreview').appendChild(nav);
        }
        renderPhonePdfPage();
      } catch(err) { content.innerHTML = '<p class="text-sm text-muted">Cannot preview PDF</p>'; }
    };
    reader.readAsArrayBuffer(phoneFile);
  } else {
    content.innerHTML = '<div style="padding:20px;text-align:center;"><p style="font-weight:600;color:var(--gray-700);">' + phoneFile.name + '</p><p class="text-xs text-muted">' + (phoneFile.size/1024/1024).toFixed(2) + ' MB</p></div>';
  }
}

function renderPhonePdfPage() {
  if (!phonePdfDoc) return;
  phonePdfDoc.getPage(phoneCurrentPreviewPage).then(function(page) {
    var canvas = document.getElementById('phonePreviewCanvas');
    var container = document.getElementById('phoneLivePreview');
    if (!canvas || !container) return;
    var maxW = container.clientWidth - 32;
    var scale = Math.min(maxW / page.getViewport({ scale: 1 }).width, 2);
    var vp = page.getViewport({ scale: scale });
    canvas.width = vp.width;
    canvas.height = vp.height;
    page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function() {
      var info = document.getElementById('phonePdfPageInfo');
      if (info) info.textContent = phoneCurrentPreviewPage + ' / ' + phonePdfPages;
    });
  });
}

function changePhonePdfPage(delta) {
  var newPage = phoneCurrentPreviewPage + delta;
  if (newPage < 1 || newPage > phonePdfPages) return;
  phoneCurrentPreviewPage = newPage;
  renderPhonePdfPage();
}

function updatePhonePreview() {
  var img = document.getElementById('phonePreviewImg');
  if (!img) return;
  var canvas = document.getElementById('phonePreviewCanvas');
  var el = img || canvas;
  var colorMode = document.getElementById('pColorMode').value;
  var brightness = parseInt(document.getElementById('pBrightness').value) || 0;
  var contrast = parseInt(document.getElementById('pContrast').value) || 0;
  var cropMode = document.getElementById('pCropMode').value;
  var brightnessPct = 100 + brightness;
  var contrastPct = 100 + contrast;
  var grayscale = colorMode === 'bw' ? 'grayscale(100%)' : 'grayscale(0%)';
  el.style.filter = grayscale + ' brightness(' + brightnessPct + '%) contrast(' + contrastPct + '%)';
  document.getElementById('phonePreviewColor').textContent = colorMode === 'color' ? 'Color' : 'B&W';
  document.getElementById('phonePreviewBright').textContent = brightness;
  document.getElementById('phonePreviewContrast').textContent = contrast;
  document.getElementById('phonePreviewCrop').textContent = cropMode === 'none' ? 'None' : cropMode === 'auto' ? 'Auto' : 'Manual';
  phoneSyncManualCrop();
}

/* ===== MANUAL CROP (PHONE - CROPPER.JS) ===== */
let phoneCropper = null;
let phoneCroppedFile = null;

function phoneInitCropper() {
  destroyPhoneCropper();
  var img = document.getElementById('phonePreviewImg');
  if (!img || typeof Cropper === 'undefined') return false;
  phoneCropper = new Cropper(img, {
    viewMode: 1,
    dragMode: 'move',
    autoCropArea: 0.9,
    background: false,
    minContainerWidth: 200,
    minContainerHeight: 120,
    ready: function() { setPhoneCropRatio(); }
  });
  return true;
}

function destroyPhoneCropper() {
  if (phoneCropper) { phoneCropper.destroy(); phoneCropper = null; }
}

function phoneSyncManualCrop() {
  var toolbar = document.getElementById('phoneCropToolbar');
  var isManual = document.getElementById('pCropMode').value === 'manual';
  var img = document.getElementById('phonePreviewImg');
  if (toolbar) toolbar.style.display = (isManual && img) ? 'flex' : 'none';
  if (isManual && img) {
    if (!phoneCropper) phoneInitCropper();
  } else {
    destroyPhoneCropper();
  }
}

function setPhoneCropRatio() {
  if (!phoneCropper) return;
  var v = document.getElementById('phoneCropRatioSel').value;
  var ratio = NaN;
  if (v === 'a4') ratio = 210 / 297;
  else if (v === '1:1') ratio = 1;
  phoneCropper.setAspectRatio(ratio);
}

function phoneCropZoom(delta) {
  if (phoneCropper) phoneCropper.zoom(delta);
}

function phoneCropRotate() {
  if (phoneCropper) phoneCropper.rotate(90);
}

function resetPhoneCrop() {
  if (phoneCropper) phoneCropper.reset();
}

function applyPhoneCrop() {
  if (!phoneCropper || !phoneFile) return;
  var ext = (phoneFile.name.split('.').pop() || '').toLowerCase();
  var isPng = ext === 'png';
  var type = isPng ? 'image/png' : 'image/jpeg';
  var quality = isPng ? 1 : 0.92;
  var canvas = phoneCropper.getCroppedCanvas({ imageSmoothingQuality: 'high', maxWidth: 4096, maxHeight: 4096 });
  canvas.toBlob(function(blob) {
    if (!blob) { alert('Failed to crop image'); return; }
    phoneCroppedFile = new File([blob], phoneFile.name, { type: type });
    toastMsg('Crop applied');
  }, type, quality);
}

function toastMsg(msg) {
  var t = document.getElementById('toastMsg');
  if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.style.opacity = '1';
  t.style.display = 'block';
  setTimeout(function() { t.style.display = 'none'; }, 2200);
}

async function submitPhoneUpload() {
  if (!phoneFile) return;
  var btn = document.querySelector('#step2 .btn-primary');
  btn.disabled = true;
  btn.textContent = 'Uploading...';

  var formData = new FormData();
  var cropModeVal = document.getElementById('pCropMode').value;
  var upFile = (cropModeVal === 'manual' && phoneCroppedFile) ? phoneCroppedFile : phoneFile;
  var blob = await upFile.arrayBuffer().then(function(b) { return new Blob([b], { type: upFile.type || 'application/octet-stream' }); });
  formData.append('file', blob, upFile.name || 'file');
  formData.append('color_mode', document.getElementById('pColorMode').value);
  formData.append('paper_size', 'a4');
  formData.append('sides', 'single');
  formData.append('copies', document.getElementById('pCopies').value);
  formData.append('pages', document.getElementById('pPages').value);
  formData.append('brightness', document.getElementById('pBrightness').value);
  formData.append('contrast', document.getElementById('pContrast').value);
  formData.append('crop_mode', cropModeVal);
  formData.append('finish', 'none');

  function parseRes(res) {
    return res.text().then(function(raw) {
      try { return JSON.parse(raw); } catch (e) { return { success: false, error: 'Server returned an invalid response (HTTP ' + res.status + ')' }; }
    });
  }

  function uploadFail(msg) {
    alert(msg);
    btn.disabled = false;
    btn.textContent = 'Upload & Pay';
  }

  try {
    var fileName = upFile.name || 'file';
    var data;
    if (IS_NETLIFY) {
      // Signed upload: bytes go directly to Supabase Storage (Netlify's 6MB cap never applies)
      var signRes = await fetch(API('upload', 'sign-upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': qToken },
        body: JSON.stringify({ file_name: fileName, file_size: upFile.size || 1 })
      });
      var signD = await parseRes(signRes);
      if (!signRes.ok && !signD.success) { uploadFail(signD.error || 'Upload failed'); return; }

      var upRes = await fetch(signD.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': signD.content_type || upFile.type || 'application/octet-stream', 'x-upsert': 'true' },
        body: upFile
      });
      if (!upRes.ok) {
        var upMsg = 'Storage upload failed (HTTP ' + upRes.status + ')';
        try { var upJ = JSON.parse(await upRes.text()); upMsg = upJ.message || upJ.error || upMsg; } catch (e) {}
        uploadFail(upMsg);
        return;
      }

      var jobRes = await fetch(API('upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': qToken },
        body: JSON.stringify({
          job_id: signD.job_id,
          file_url: signD.public_url,
          file_name: fileName,
          print_pin: '',
          color_mode: document.getElementById('pColorMode').value,
          paper_size: 'a4',
          sides: 'single',
          copies: document.getElementById('pCopies').value,
          pages: document.getElementById('pPages').value,
          brightness: document.getElementById('pBrightness').value,
          contrast: document.getElementById('pContrast').value,
          crop_mode: document.getElementById('pCropMode').value,
          finish: 'none'
        })
      });
      data = await parseRes(jobRes);
      if (!jobRes.ok && !data.success) { uploadFail(data.error || 'Upload failed'); return; }
    } else {
      var res = await fetch(API('upload'), {
        method: 'POST',
        headers: { 'X-Session-Token': qToken },
        body: formData
      });
      data = await parseRes(res);
    }
    if (data.success) {
      phoneUploadedJob = data.job;
      phoneCurrentJobId = data.job.job_id;
      document.getElementById('phoneJobId').textContent = data.job.job_id;
      document.getElementById('phoneAmount').textContent = 'RM ' + parseFloat(data.job.total_price).toFixed(2);
      document.getElementById('phoneReceiptFile').textContent = phoneFile ? phoneFile.name : '-';
      document.getElementById('phoneReceiptPages').textContent = document.getElementById('pPages').value + ' pages';
      document.getElementById('phoneReceiptColor').textContent = document.getElementById('pColorMode').value === 'color' ? 'Color' : 'B&W';
      document.getElementById('phoneReceiptCopies').textContent = 'x' + document.getElementById('pCopies').value;
      if (phoneFileDataUrl) {
        var pv = document.getElementById('phonePreview');
        pv.style.display = 'block';
        pv.innerHTML = '<img src="' + phoneFileDataUrl + '" style="max-width:100%;max-height:160px;object-fit:contain;display:block;margin:0 auto;">';
      }
      document.getElementById('phonePaySection').style.display = 'block';
      document.getElementById('phoneReceiptSection').style.display = 'none';
      document.getElementById('phoneConfirmPayBtn').disabled = false;
      document.getElementById('phoneConfirmPayBtn').textContent = 'Confirm Payment';
      goStep3();
    } else {
      alert(data.error || 'Upload failed');
      btn.disabled = false;
      btn.textContent = 'Upload & Pay';
    }
  } catch(e) {
    alert('Upload failed');
    btn.disabled = false;
    btn.textContent = 'Upload & Pay';
  }
}

async function confirmPhonePayment() {
  if (!phoneCurrentJobId) return;
  var btn = document.getElementById('phoneConfirmPayBtn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  var paid = false;
  try {
    var r = await fetch(API('payment', 'confirm'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: phoneCurrentJobId })
    });
    var d = await r.json();
    paid = !!(d && d.success);
  } catch(e) {}

  if (!paid) {
    try {
      var r2 = await fetch(API('payment', 'simulate'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: phoneCurrentJobId })
      });
      var d2 = await r2.json();
      paid = !!(d2 && d2.success);
    } catch(e) {}
  }

  var uploadedJobs = JSON.parse(localStorage.getItem('uploadedJobs') || '[]');
  var job = uploadedJobs.find(j => j.job_id === phoneCurrentJobId);
  if (job) {
    job.paid = true;
    job.status = 'ready_to_print';
    if (phoneUploadedJob && phoneUploadedJob.print_pin) job.print_pin = phoneUploadedJob.print_pin;
    localStorage.setItem('uploadedJobs', JSON.stringify(uploadedJobs));
  } else if (phoneUploadedJob) {
    uploadedJobs.push({
      job_id: phoneCurrentJobId,
      print_pin: phoneUploadedJob.print_pin,
      file_name: phoneUploadedJob.file_name || (phoneFile ? phoneFile.name : 'Upload'),
      pages: phoneUploadedJob.pages,
      copies: phoneUploadedJob.copies || 1,
      total_price: phoneUploadedJob.total_price,
      paid: true,
      status: 'ready_to_print',
      user_id: qToken ? (JSON.parse(localStorage.getItem('user') || 'null') || {}).id : null,
      created_at: new Date().toISOString()
    });
    localStorage.setItem('uploadedJobs', JSON.stringify(uploadedJobs));
  }

  var pinEl = document.getElementById('phonePrintPin');
  var serverPin = phoneUploadedJob ? phoneUploadedJob.print_pin : '';
  if (serverPin) pinEl.textContent = serverPin;
  else pinEl.textContent = '------';
  document.getElementById('phoneReceiptJobId').textContent = phoneCurrentJobId;
  document.getElementById('phoneReceiptFile2').textContent = phoneFile ? phoneFile.name : '-';
  document.getElementById('phoneReceiptTotal').textContent = 'RM ' + (phoneUploadedJob ? parseFloat(phoneUploadedJob.total_price).toFixed(2) : phonePrice.toFixed(2));

  document.getElementById('phonePaySection').style.display = 'none';
  document.getElementById('phoneReceiptSection').style.display = 'block';
}

function cancelPhonePayment() {
  document.getElementById('step3').classList.remove('active');
  document.getElementById('step2').classList.add('active');
  document.getElementById('step2Dot').className = 'step-dot active';
  document.getElementById('step3Dot').className = 'step-dot';
  document.getElementById('line2').className = 'step-line';
}

document.querySelector('.upload-zone').addEventListener('dragover', function(e) { e.preventDefault(); });
document.querySelector('.upload-zone').addEventListener('drop', function(e) {
  e.preventDefault();
  if (e.dataTransfer.files.length) {
    document.getElementById('phoneFile').files = e.dataTransfer.files;
    document.getElementById('phoneFile').dispatchEvent(new Event('change'));
  }
});
</script>
<div id="toastMsg" style="display:none; position:fixed; bottom:60px; left:50%; transform:translateX(-50%); background:rgba(17,24,39,0.92); color:white; padding:10px 18px; border-radius:10px; font-size:13px; z-index:9999; max-width:90vw; text-align:center;"></div>
</body>
</html>
