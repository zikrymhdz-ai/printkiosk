// A delete and an upload must both LOOK like work is happening, and must never
// blame the network for a server answer.
//
// Two live complaints, 2026-10-27:
//
//   1. "if customer want to delete JOBS its say can't reach server"
//      Every delete ended in `.catch(() => alert('Could not reach the server'))`.
//      That catch also fired when the server answered with something that was
//      not JSON - a 502/504 HTML page from the platform - and when the request
//      was refused with a perfectly good reason. The customer was told their
//      connection was at fault when it was not, and could do nothing about it.
//   2. "add loading when uploading jobs/file"
//      upload.html changed the button text of a button at the bottom of the
//      settings step. On a phone that button is usually off screen, so tapping
//      Upload & Pay looked like nothing had happened.
//
// Run: node scripts/check-delete-ui.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

const page = read('website/customer.html');
const upload = read('website/upload.html');

// ---------------------------------------------------------------------------
// 1. ONE WAY TO POST, AND IT KNOWS WHAT WENT WRONG
// ---------------------------------------------------------------------------
ok(/function postJson\(/.test(page), 'the page has one POST helper');
ok(/AbortController/.test(page) && /POST_TIMEOUT_MS/.test(page),
   'and it gives up on its own instead of hanging for ever');
ok(/r\.text\(\)[\s\S]{0,120}JSON\.parse/.test(page),
   'it reads the body as text before parsing, so an HTML error page cannot throw');

const postJsonSrc = page.slice(page.indexOf('function postJson('), page.indexOf('function setJobDeleteBusy'));
for (const reason of ['timeout', 'offline', 'bad-response', 'refused']) {
  ok(postJsonSrc.includes("'" + reason + "'"),
     'it can report "' + reason + '" as its own case');
}
ok(/HTTP ' \+ r\.status/.test(postJsonSrc),
   'a non-API answer names the HTTP status instead of blaming the connection');

// The bare pattern that caused the complaint must be gone from the handlers.
const handlers = page.slice(page.indexOf('function deleteJob'), page.indexOf('function returnToPayment'));
ok(handlers.length > 1000, 'the delete handlers are where this test expects them');
ok(!/\.catch\(function \(\) \{ alert\('Could not reach the server/.test(handlers),
   'no delete handler reports a network failure it did not observe');
ok((handlers.match(/postJson\(/g) || []).length >= 4,
   'all the delete requests go through postJson()');

// ---------------------------------------------------------------------------
// 2. A DELETE SHOWS THAT IT IS WORKING
// ---------------------------------------------------------------------------
ok(/function setJobDeleteBusy\(/.test(page), 'a single delete has a busy state');
ok(/\.job-del\.busy/.test(page), 'the bin is styled as busy while the server works');
ok(/\.job-del \.job-spin/.test(page) && /@keyframes spin/.test(page),
   'and it turns into a spinner');
ok(/data-del-job-id=/.test(page),
   'each row carries the id the loader needs to find it again');
ok(/deletingJobIds\[jobId\]/.test(page),
   'a second tap cannot send a second request for the same job');

// setJobDeleteBusy must actually be called on the way in AND out.
const deleteJobSrc = page.slice(page.indexOf('function deleteJob'), page.indexOf('// Delete the jobs the customer ticked'));
ok(/setJobDeleteBusy\(jobId, true\)/.test(deleteJobSrc), 'deleteJob() marks the row busy before posting');
ok(/\.finally\([\s\S]{0,200}setJobDeleteBusy\(jobId, false\)/.test(deleteJobSrc),
   'and clears it afterwards even when the request failed');

// Bulk actions: disabled, renamed, and restored from one place.
ok(/function setJobsToolbarBusy\(/.test(page), 'the bulk actions have a busy state');
ok(/btn\.dataset\.idleLabel/.test(page),
   'the pressed button keeps its own label, so one action cannot rename another');
ok(/jobsToolbarBusy\) return/.test(page),
   'a bulk delete cannot be started twice while one is running');
const BOUNDS = {
  deleteSelectedJobs: ['function deleteSelectedJobs(', '// Clear everything the customer is allowed to clear'],
  clearAllJobs: ['function clearAllJobs(', 'function returnToPayment'],
};
for (const fn of Object.keys(BOUNDS)) {
  const from = page.indexOf(BOUNDS[fn][0]);
  const to = page.indexOf(BOUNDS[fn][1]);
  const body = page.slice(from, to > from ? to : from + 4000);
  ok(/setJobsToolbarBusy\(true/.test(body), fn + ' disables the toolbar while it works');
  ok(/\.finally\(/.test(body) && /setJobsToolbarBusy\(false/.test(body),
     fn + ' always restores it');
  ok(!/\.catch\(function \(\) \{ alert\('Could not reach the server/.test(body),
     fn + ' does not invent a network error');
}

// A partial clear has to be reported as partial: "nothing was deleted" is a lie
// when half of them went.
ok(/if \(cleared\.length\)/.test(handlers) && /but not all of them/.test(handlers),
   'a partial clear says what it did, not that nothing happened');

// ---------------------------------------------------------------------------
// 3. THE UPLOAD LOADER
// ---------------------------------------------------------------------------
ok(/id="uploadOverlay"/.test(upload), 'the upload page has a loader');
ok(/\.pk-overlay \{ position: fixed/.test(upload),
   'it is fixed to the viewport, so scrolling cannot hide it');
ok(/\.pk-overlay\.hidden \{ display: none; \}/.test(upload), 'and it can be hidden');

ok(/function showUploadOverlay\(/.test(upload), 'there is one function that shows it');
ok(/function hideUploadOverlay\(/.test(upload), 'and one that hides it');
ok(/function setUploadProgress\(/.test(upload), 'progress can be set from one place');

const submitSrc = upload.slice(upload.indexOf('async function submitPhoneUpload'), upload.indexOf('/* ===== PAYMENT (ALL JOBS) ===== */'));
ok(/showUploadOverlay\(\{/.test(submitSrc),
   'submitPhoneUpload shows it before doing any work');
ok(/hideUploadOverlay\(\)/.test(submitSrc),
   'and hides it on the paths that return early');

// Every exit must drop it: the failure alert, the empty-result alert, and the
// step that shows the QR code the customer has to scan.
ok(/function uploadFail\(msg\) \{[\s\S]{0,120}hideUploadOverlay\(\)/.test(upload),
   'uploadFail() hides it before alerting, so the alert is not behind it');
ok(/function goStep3\(\) \{[\s\S]{0,300}hideUploadOverlay\(\)/.test(upload),
   'goStep3() hides it - a loader left over the QR code hides the QR code');
ok(/function resetUpload\(\) \{[\s\S]{0,80}hideUploadOverlay\(\)/.test(upload),
   'and starting a new upload clears any leftover loader');

// Real byte progress: fetch() cannot report upload progress.
ok(/function putWithProgress\(/.test(upload), 'the storage PUT reports real progress');
ok(/xhr\.upload\.onprogress/.test(upload), 'from the bytes actually sent');
ok(/putWithProgress\(\s*signD\.upload_url/.test(upload),
   'and the signed-upload path uses it');
ok(!/body: upFile\n\s*\}\);/.test(upload),
   'the silence-prone fetch() PUT of the file bytes is gone');
ok(/Math\.round\(frac \* 100\)/.test(upload),
   'the loader shows a percentage while the bytes move');

// A file that fails mid-upload must say so, not look stuck.
ok(/connection dropped while sending/.test(upload),
   'a dropped connection names the file and says nothing was charged');

if (failed) { console.log('  -> failed'); process.exit(1); }
console.log('  ok      deletes and uploads both show work, and report the real failure');
