const { json, err, supabaseRequest, supabaseStorageDelete, validateSession, APP_VERSION, LIVE_FRAME_WINDOW_MIN } = require('./_shared');

// How many rows one clear-jobs PATCH may carry. The UI caps a selection at 300,
// so this only splits a very large "Clear finished & unpaid" into a few writes
// instead of one URL long enough to be rejected by the API gateway.
const CLEAR_BATCH = 100;

// Split a stored file URL into the bucket and object path Supabase Storage needs
// for a delete. Both clear paths used to do this inline and identically; one
// copy is enough, and a second copy is a second chance to get it wrong.
function storageTargetOf(filePath) {
  if (!filePath || !String(filePath).includes('/storage/v1/object/')) return null;
  const parts = String(filePath).split('/storage/v1/object/')[1].split('/');
  if (parts[0] === 'public') {
    return parts.length >= 3 ? { bucket: parts[1], path: parts.slice(2).join('/') } : null;
  }
  return parts.length >= 2 ? { bucket: parts[0], path: parts.slice(1).join('/') } : null;
}


exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  if (event.httpMethod === 'POST' && action === 'complete-job') {
    return await handleCompleteJob(event);
  }
if (event.httpMethod === 'POST' && action === 'delete-job') {
      return await handleDeleteJob(event);
    }
    if (event.httpMethod === 'POST' && action === 'clear-jobs') {
      return await handleClearJobs(event);
    }
  if (event.httpMethod === 'POST' && action === 'submit-report') {
    return await handleSubmitReport(event);
  }
  if (event.httpMethod === 'POST' && action === 'log-face-detection') {
    return await handleLogFaceDetection(event);
  }
  if (event.httpMethod === 'POST' && action === 'kiosk-heartbeat') {
    return await handleKioskHeartbeat(event);
  }
  if (event.httpMethod === 'POST' && action === 'kiosk-frame') {
    return await handleKioskFrame(event);
  }
  if (event.httpMethod === 'POST' && action === 'watcher-heartbeat') {
    return await handleWatcherHeartbeat(event);
  }
  if (event.httpMethod === 'POST' && action === 'log-notification') {
    return await handleLogNotification(event);
  }

  switch (action) {
    case 'get-jobs': {
      const userId = url.searchParams.get('user_id') || '';
      if (!userId) return err('User ID required');
      const result = await supabaseRequest('GET', '/print_jobs', null, {
        'user_id': 'eq.' + userId,
        'select': '*',
        'status': 'not.in.(completed,refund_issued,cancelled,failed)',
        'cleared_at': 'is.null',
        'order': 'created_at.desc'
      });
      return json({ success: true, data: result.error ? [] : result.data });
    }

    case 'get-all-jobs': {
      const userId = url.searchParams.get('user_id') || '';
      if (!userId) return err('User ID required');
      const result = await supabaseRequest('GET', '/print_jobs', null, {
        'user_id': 'eq.' + userId,
        'select': '*',
        // Cleared jobs are excluded here specifically. This query deliberately
        // returns finished work - a customer needs to see what already printed -
        // so without the filter a job they had just deleted came back on the
        // next load and Delete looked like it had done nothing.
        //
        // is.null is what "was never cleared" means in PostgREST; a plain eq
        // filter cannot express it.
        'cleared_at': 'is.null',
        'order': 'created_at.desc'
      });
      return json({ success: true, data: result.error ? [] : result.data });
    }

    case 'kiosk-settings': {
      const s = await getKioskSettings();
      return json({ success: true, settings: s, app_version: APP_VERSION });
    }

    case 'get-face-users': {
      const result = await supabaseRequest('GET', '/users', null, {
        'select': 'id,name,face_descriptor',
        'face_descriptor': 'not.is.null',
        'role': 'eq.customer'
      });
      return json({ success: true, data: result.error ? [] : result.data });
    }

    case 'get-user': {
      const userId = url.searchParams.get('id') || '';
      if (!userId) return err('User ID required');
      const result = await supabaseRequest('GET', '/users', null, {
        'id': 'eq.' + userId,
        'select': '*'
      });
      return json({ success: true, data: result.error || !result.data || !result.data.length ? null : result.data[0] });
    }

    case 'get-users-with-face': {
      const result = await supabaseRequest('GET', '/users', null, {
        'select': 'id,name,face_descriptor',
        'face_descriptor': 'not.is.null'
      });
      return json({ success: true, data: result.error ? [] : result.data });
    }

    default:
      return err('Invalid action');
  }
};

// Default kiosk behaviour if the settings table has not been migrated yet.
const DEFAULT_KIOSK_SETTINGS = {
  face_login_enabled: true,
  maintenance_mode: false,
  camera_stream_enabled: false,
  maintenance_message: 'Kiosk temporarily unavailable for maintenance. Please see staff.'
};

async function getKioskSettings() {
  const result = await supabaseRequest('GET', '/kiosk_settings', null, {
    'id': 'eq.default', 'select': '*', 'limit': '1'
  });
  if (!result.error && result.data && result.data.length > 0) {
    const row = result.data[0];
    return {
      face_login_enabled: row.face_login_enabled !== false,
      maintenance_mode: !!row.maintenance_mode,
      camera_stream_enabled: !!row.camera_stream_enabled,
      maintenance_message: row.maintenance_message || DEFAULT_KIOSK_SETTINGS.maintenance_message,
      updated_at: row.updated_at || null
    };
  }
  return Object.assign({}, DEFAULT_KIOSK_SETTINGS);
}

// The kiosk posts a periodic heartbeat so the admin page can see whether the
// screen is alive, which face lib it loaded and whether the camera opened.
async function handleKioskHeartbeat(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const logs = Array.isArray(body.last_log) ? body.last_log.slice(-12).map(String).join(' | ') : '';
  const errors = Array.isArray(body.js_errors) ? body.js_errors.slice(-3).map(String).join(' || ') : '';
  // Why the last detected face was rejected (distance vs threshold, face size
  // vs the minimum). Folded into the existing free-text `detail` column so
  // this needs no migration and still shows up in the admin dashboard.
  const faceDiag = body.face_diag ? ' FACE[' + String(body.face_diag).slice(0, 160) + ']' : '';

  const result = await supabaseRequest('POST', '/kiosk_heartbeats', {
    kiosk_id: String(body.kiosk_id || 'kiosk-1').slice(0, 40),
    app_version: String(body.app_version || '').slice(0, 20),
    state: String(body.state || '').slice(0, 120),
    detail: (String(body.detail || '') + faceDiag + (errors ? ' || ERR: ' + errors : '')).slice(0, 600),
    last_log: logs.slice(0, 500),
    face_lib: !!body.face_lib,
    camera: !!body.camera,
    camera_size: String(body.camera_size || '').slice(0, 20),
    models_loaded: !!body.models_loaded,
    cam_label: String(body.cam_label || '').slice(0, 80),
    // Measured face-detection cost, so "the kiosk is laggy" can be checked
    // against the device's own numbers.
    face_pass_ms: (Number.isFinite(parseInt(body.face_pass_ms, 10)) ? parseInt(body.face_pass_ms, 10) : null),
    face_gap_ms: (Number.isFinite(parseInt(body.face_gap_ms, 10)) ? parseInt(body.face_gap_ms, 10) : null),
    seen_at: new Date().toISOString()
  });

  if (result.error) {
    return json({ success: false, logged: false, error: 'Heartbeat table unavailable' });
  }
  return json({ success: true, logged: true });
}

// The watcher APK posts a heartbeat every 30s. This is the single most important
// signal in the whole app: if the watcher is dead, real customers pay at the
// counter but nothing auto-confirms, and staff only discover it when a customer
// complains. Admin raises a prominent banner when this stops arriving.
async function handleWatcherHeartbeat(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const int = (v) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : 0);

  const result = await supabaseRequest('POST', '/watcher_heartbeats', {
    watcher_id: String(body.watcher_id || 'watcher-1').slice(0, 40),
    app_version: String(body.app_version || '').slice(0, 20),
    listening: !!body.listening,
    access_granted: !!body.access_granted,
    notifications_seen: int(body.notifications_seen),
    payments_matched: int(body.payments_matched),
    queued_pending: int(body.queued_pending),
    last_post: String(body.last_post || '').slice(0, 120),
    detail: String(body.detail || '').slice(0, 600),
    seen_at: new Date().toISOString()
  });

  if (result.error) {
    // Table not migrated yet - never break the watcher over a heartbeat.
    return json({ success: false, logged: false, error: 'Watcher heartbeat table unavailable' });
  }
  return json({ success: true, logged: true });
}

// Every watched notification is recorded here, matched or not. The whole point is
// evidence: the TnG wording changes without warning, and guessing at a regex is
// how payments get missed. Staff can read the exact text admin-side and we fix
// the parser against what the app actually received.
async function handleLogNotification(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const clientRef = String(body.client_ref || '').slice(0, 80) || null;
  const amountRaw = String(body.amount_raw || '');
  const amount = parseFloat(amountRaw);
  const safeAmount = Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;

  // Idempotency: a retried notification (app was killed mid-request, or the
  // response was lost and WorkManager resent it) must not become two rows.
  if (clientRef) {
    const existing = await supabaseRequest('GET', '/payment_log', null, {
      'client_ref': 'eq.' + clientRef, 'select': 'id', 'limit': '1'
    });
    if (!existing.error && existing.data && existing.data.length > 0) {
      return json({ success: true, logged: false, duplicate: true, id: existing.data[0].id });
    }
  }

  const result = await supabaseRequest('POST', '/payment_log', {
    package_name: String(body.package_name || '').slice(0, 80),
    title: String(body.title || '').slice(0, 200),
    raw_text: String(body.raw_text || '').slice(0, 2000),
    gate_text: String(body.gate_text || '').slice(0, 2000),
    amount: safeAmount,
    amount_raw: amountRaw.slice(0, 40),
    reference: String(body.reference || '').slice(0, 60),
    incoming: !!body.incoming,
    status: String(body.status || 'seen').slice(0, 40),
    job_id: String(body.job_id || '').slice(0, 40),
    detail: String(body.detail || '').slice(0, 400),
    client_ref: clientRef,
    posted_at: String(body.posted_at || '').slice(0, 30),
    seen_at: new Date().toISOString()
  });

  if (result.error) {
    return json({ success: false, logged: false, error: 'Payment log table unavailable' });
  }
  return json({ success: true, logged: true });
}

// The kiosk posts every face scan so the admin can audit who used face login.
async function handleLogFaceDetection(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const matched = !!body.matched;
  const userId = body.user_id || null;
  const confidence = Number.isFinite(parseFloat(body.confidence)) ? parseFloat(body.confidence) : null;

  // Resolve the display name server-side so the kiosk cannot spoof it.
  let userName = '';
  if (matched && userId) {
    const u = await supabaseRequest('GET', '/users', null, {
      'id': 'eq.' + userId, 'select': 'name', 'limit': '1'
    });
    if (!u.error && u.data && u.data.length > 0) userName = u.data[0].name;
  }

  // Optional camera snapshot of the recognised face (data-URI), capped so a log
  // row can never balloon. Ignored if the column has not been migrated yet.
  let snapshot = null;
  const raw = String(body.face_snapshot || '');
  if (/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(raw) && raw.length < 300000) {
    snapshot = raw;
  }

  const record = {
    user_id: userId,
    user_name: userName,
    matched: matched,
    confidence: confidence,
    kiosk_id: String(body.kiosk_id || 'kiosk-1').slice(0, 40),
    source: 'kiosk'
  };

  let result = snapshot
    ? await supabaseRequest('POST', '/face_detections', Object.assign({ face_snapshot: snapshot }, record))
    : { error: true };
  if (result.error) {
    result = await supabaseRequest('POST', '/face_detections', record);
  }

  if (result.error) {
    // Table not migrated yet - never break the kiosk over an audit log.
    return json({ success: false, logged: false, error: 'Audit log unavailable' });
  }

  // Successful face matches also raise an alert so they stand out on the dashboard.
  if (matched && userName) {
    await supabaseRequest('POST', '/alerts', {
      type: 'face_login',
      message: 'Face login detected for ' + userName + (confidence != null ? ' (distance ' + confidence.toFixed(3) + ')' : ''),
      severity: 'info',
      is_read: false
    });
  }

  return json({ success: true, logged: true });
}

// ---- Live camera frames ----------------------------------------------------
//
// There is no socket between the Pi and the dashboard: the Pi sits behind the
// shop's NAT and Netlify only runs functions. So the kiosk publishes a small
// JPEG every ~1.5s and the dashboard reads the newest one. A still frame
// repeated at that rate reads as live, and - unlike a video stream - every frame
// is already a file the admin can download, which is the CCTV half of this.
//
// Retention is short on purpose. These are pictures of customers standing in a
// shop, so the table only ever holds the last few minutes and the kiosk only
// publishes while the shop has switched the feed on.
const LIVE_FRAME_MAX_CHARS = 200000; // ~150KB of image, after base64 inflation

let lastFramePruneAt = 0;

async function handleKioskFrame(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const raw = String(body.frame || '');
  const m = /^data:(image\/(?:png|jpeg|jpg));base64,[A-Za-z0-9+/=]+$/.exec(raw);
  if (!m) return err('frame must be a data:image base64 URI');
  if (raw.length > LIVE_FRAME_MAX_CHARS) return err('frame too large', 413);

  const now = Date.now();
  const result = await supabaseRequest('POST', '/kiosk_frames', {
    kiosk_id: String(body.kiosk_id || 'kiosk-1').slice(0, 40),
    mime: m[1],
    data: raw
  });

  if (result.error) {
    // Table not migrated yet - never break the kiosk over a live view.
    return json({ success: false, live: false, error: 'Live frames table unavailable' });
  }

  // Prune on a cadence, not on every frame: a DELETE every 1.5s would double the
  // request count for a table that only ever needs trimming.
  if (now - lastFramePruneAt > 60000) {
    lastFramePruneAt = now;
    const cutoff = new Date(now - LIVE_FRAME_WINDOW_MIN * 60 * 1000).toISOString();
    supabaseRequest('DELETE', '/kiosk_frames', null, { 'created_at': 'lt.' + cutoff })
      .catch(function () {});
  }

  return json({ success: true, live: true });
}

async function handleCompleteJob(event) {
  const body = JSON.parse(event.body || '{}');
  const jobId = body.job_id || '';
  if (!jobId) return err('job_id required');

  const jobResult = await supabaseRequest('GET', '/print_jobs', null, {
    'job_id': 'eq.' + jobId,
    'select': 'id,file_path,status,paid'
  });
  const job = jobResult.data && jobResult.data[0];
  if (!job) return err('Job not found', 404);

  // Jobs in the print lifecycle are owned by the Pi worker, which marks them
  // completed only after the printer confirms the job actually finished.
  // Letting this endpoint touch them would skip the print entirely AND delete
  // the source file before the worker had a chance to fetch it.
  if (['print_requested', 'printing', 'failed'].includes(job.status)) {
    return err('Job is owned by the print worker and cannot be completed from here', 409);
  }

  await supabaseRequest('PATCH', '/print_jobs?job_id=eq.' + jobId, {
    'status': 'completed',
    'print_pin': null,
    // Marks this CLEARED rather than printed, so the customer's own list stops
    // handing it back. See the comment in handleDeleteJob.
    'cleared_at': new Date().toISOString()
  });

  const filePath = job.file_path || '';
  const pkStorage = storageTargetOf(filePath);
  if (pkStorage) {
    try {
      await supabaseStorageDelete(pkStorage.bucket, pkStorage.path);
    } catch(e) {}
  }

  return json({ success: true, message: 'Job completed and cleaned up' });
}

// What a customer is allowed to clear from their own list.
//
// Deliberately narrow. A PIN means the document is still collectable at the
// kiosk, so clearing it would destroy a document someone can still legitimately
// claim -- and it strips the PIN that is the only proof of entitlement. Jobs
// that are paid but failed/refunded are excluded too: those are the ones a
// customer may need staff to act on, and quietly removing them hides the record
// of a problem.
//
// Only these are clearable:
//   completed              - printed, nothing left to do
//   cancelled              - already dead, shown to explain itself
//   pending + not paid     - abandoned at checkout, no money involved
function clearableReason(job) {
  const status = job.status || '';
  const paid = job.paid === true || job.paid === 'true';

  // Finished work first, PIN or not.
  //
  // A PIN is only meaningful while the document is still waiting at the kiosk.
  // Once it has printed there is nothing left to collect, so the PIN is dead
  // weight - but it is not cleared from the row, so testing it first locked away
  // every printed job that still carried one: 28 of 65 in the live table, none
  // of them deletable, and no reason a customer could act on.
  if (status === 'completed' || status === 'cancelled') return null;

  // Anything unpaid is the customer's to remove. A PIN is assigned when the job
  // is CREATED, so testing it first refused every unpaid job - the jobs with the
  // least at stake were the only ones a customer could not delete. The one
  // exception is a job already handed to the printer: deleting that row now
  // would pull it out from under the worker.
  if (!paid) {
    if (status === 'printing' || status === 'print_requested') {
      return 'already sent to the printer';
    }
    return null;
  }

  // Paid jobs still waiting at the kiosk are protected by their PIN.
  if (job.print_pin) return 'has a print PIN and can still be collected';

  if (status === 'failed' || status === 'refund_issued') return 'needs staff to arrange a refund or reprint';
  if (status === 'pending') return 'paid and awaiting print';
  return 'status "' + status + '" is still active';
}

async function handleDeleteJob(event) {
  const body = JSON.parse(event.body || '{}');
  const jobId = body.job_id || '';
  if (!jobId) return err('job_id required');

  // Ownership check. Previously this endpoint took any job_id and cleared it
  // with no authentication at all, so anyone who learned or guessed an ID
  // could wipe another customer's job.
  const session = await validateSession(event);
  if (!session || !session.users) return err('Sign in required', 403);

  const jobResult = await supabaseRequest('GET', '/print_jobs', null, {
    'job_id': 'eq.' + jobId,
    'select': 'id,file_path,user_id,status,paid,print_pin'
  });
  const job = jobResult.data && jobResult.data[0];
  if (!job) return err('Job not found', 404);

  if (!job.user_id || job.user_id !== session.users.id) return err('Not your job', 403);

  // Enforced here, not just hidden in the UI. A client-side check is a
  // suggestion; this is the rule.
  const blocked = clearableReason(job);
  if (blocked) return err('This job cannot be cleared: ' + blocked, 409);

  await supabaseRequest('PATCH', '/print_jobs?job_id=eq.' + jobId, {
    'status': 'completed',
    'print_pin': null,
    // Marks this CLEARED rather than printed. Without it the row is
    // indistinguishable from a job that really did come out of the printer, so
    // the customer's own list - get-all-jobs, which deliberately includes
    // finished work - handed the job straight back and Delete did nothing.
    // get-jobs already hid it, by excluding completed; this is the query the
    // customer page actually reads.
    'cleared_at': new Date().toISOString()
  });

  const filePath = job.file_path || '';
  const pkStorage = storageTargetOf(filePath);
  if (pkStorage) {
    try {
      await supabaseStorageDelete(pkStorage.bucket, pkStorage.path);
    } catch(e) {}
  }

  return json({ success: true, message: 'Job deleted' });
}

// Bulk clear: everything the customer is allowed to remove, in one action.
// The per-job rules live in clearableReason() so both this and the single
// delete path agree, and so the UI can be told exactly what will be kept.
async function handleClearJobs(event) {
  const session = await validateSession(event);
  if (!session || !session.users) return err('Sign in required', 403);

  const userId = session.users.id;

  const result = await supabaseRequest('GET', '/print_jobs', null, {
    'user_id': 'eq.' + userId,
    'select': 'id,job_id,status,paid,print_pin,file_path'
  });
  if (result.error) return err('Failed to load jobs', 500);
  const jobs = Array.isArray(result.data) ? result.data : [];

  const body = JSON.parse(event.body || '{}');

  // An optional selection: clear THESE rather than everything clearable.
  //
  // Scoped to the caller's own rows, which is what the query above already
  // enforces - so a job id belonging to somebody else is not merely rejected,
  // it never appears in the candidate set at all. That is why the ids are
  // intersected here rather than trusted: the selection can narrow what happens,
  // it cannot widen it.
  const selection = Array.isArray(body.job_ids)
    ? new Set(body.job_ids.filter((v) => typeof v === 'string' && v.length > 0 && v.length < 64))
    : null;
  if (selection && selection.size > 300) return err('Too many jobs selected', 400);

  const clearable = [];
  const kept = [];
  let notSelected = 0;
  for (const j of jobs) {
    if (selection && !selection.has(j.job_id)) { notSelected++; continue; }
    const reason = clearableReason(j);
    if (reason === null) clearable.push(j);
    else kept.push({ job_id: j.job_id, reason: reason });
  }

  // Nothing was asked for, so this was a dry run: report the split without
  // deleting anything. Lets the UI say "3 will be cleared, 2 kept" accurately.
  if (body.confirm !== true) {
    return json({
      success: true,
      dry_run: true,
      clearable: clearable.map(j => j.job_id),
      kept: kept,
      not_selected: notSelected
    });
  }

  // Clear them in ONE write.
  //
  // This used to call handleDeleteJob() once per job, and that handler validates
  // the session, reads the row, patches it and deletes its stored object: four
  // Supabase round trips, one after another. Timed against the live site on
  // 2026-10-27 - 10 jobs 7.0 s, 16 jobs 10.7 s, 30 jobs 21.3 s. The cost is
  // linear and unbounded, so a customer with a few months of history waits
  // through a request that can outlive the function timeout; Netlify then
  // answers with an HTML error page, and the page reported that as "Could not
  // reach the server" even though half the jobs had been cleared.
  //
  // One PATCH per CLEAR_BATCH jobs (300 is the most a selection can be), then
  // the stored objects in parallel. The rows are scoped to the caller again in
  // the where-clause, so a job id belonging to somebody else can never be
  // touched even if it were in the list.
  const cleared = [];
  const clearedAt = new Date().toISOString();
  const ids = clearable.map(j => j.job_id);

  for (let i = 0; i < ids.length; i += CLEAR_BATCH) {
    const chunk = ids.slice(i, i + CLEAR_BATCH);
    const patch = await supabaseRequest(
      'PATCH',
      '/print_jobs?user_id=eq.' + encodeURIComponent(userId)
        + '&job_id=in.(' + chunk.map(encodeURIComponent).join(',') + ')',
      {
        // 'completed' + cleared_at is the existing definition of a cleared row
        // (see handleDeleteJob). Kept identical so the two paths cannot disagree
        // about what a cleared job looks like.
        'status': 'completed',
        'print_pin': null,
        'cleared_at': clearedAt
      }
    );

    if (patch.error) {
      // Report what DID happen rather than a flat failure: earlier chunks are
      // already cleared, and a customer who is told "nothing was deleted" and
      // then finds half their list gone will not trust either answer.
      return json({
        success: false,
        error: 'Cleared ' + cleared.length + ' of ' + ids.length + ' jobs, then failed: ' + patch.message,
        cleared: cleared,
        kept: kept
      }, 502);
    }

    const rows = Array.isArray(patch.data) ? patch.data : null;
    if (rows) {
      for (const r of rows) if (r && r.job_id) cleared.push(r.job_id);
    } else {
      // No representation came back, but the write itself succeeded.
      for (const id of chunk) cleared.push(id);
    }
  }

  // Stored files last, and at the same time. They are already unreachable to the
  // customer (the row is cleared), so one slow storage delete must not hold the
  // response - but it still must not be forgotten either, which is why every
  // one is attempted and the failures are only logged.
  //
  // Bounded by a deadline: a customer with months of history can clear hundreds
  // of rows, and waiting on every object put the whole request past the
  // platform's function timeout. When that happened Netlify answered with an
  // HTML page without CORS headers, so the browser saw a failed fetch and the
  // page said "Could not reach the server" - even though the rows were already
  // cleared. The rows are the source of truth; an orphaned object is harmless
  // (the worker already deletes files it prints), so the cleanup yields after a
  // few seconds rather than risking the response.
  const doomed = clearable.filter(j => j && j.file_path);
  const cleanup = Promise.all(doomed.map(async (j) => {
    const target = storageTargetOf(j.file_path);
    if (!target) return;
    try {
      await supabaseStorageDelete(target.bucket, target.path);
    } catch (e) {}
  }));
  const CLEANUP_BUDGET_MS = 4000;
  await Promise.race([
    cleanup,
    new Promise(resolve => setTimeout(resolve, CLEANUP_BUDGET_MS))
  ]);

  return json({
    success: true,
    cleared: cleared,
    kept: kept
  });
}

async function handleSubmitReport(event) {
  const body = JSON.parse(event.body || '{}');
  const type = (body.type || '').trim();
  const description = (body.description || '').trim();
  const jobId = (body.job_id || '').trim();
  const userEmail = (body.user_email || '').trim();

  if (!description) return err('Description required');

  const typeLabels = {
    print_error: 'Print Error', payment_issue: 'Payment Issue',
    machine_problem: 'Machine Problem', quality_issue: 'Quality Issue', other: 'Other'
  };
  const typeLabel = typeLabels[type] || (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'General');

  const parts = ['[Report] ' + typeLabel, description];
  if (jobId) parts.push('Job: ' + jobId);
  if (userEmail) parts.push('From: ' + userEmail);
  const message = parts.join(' | ');

  const alertTypes = {
    print_error: 'print_complete', payment_issue: 'payment_received',
    machine_problem: 'paper_jam', quality_issue: 'print_complete', other: 'paper_low'
  };

  let result = await supabaseRequest('POST', '/alerts', {
    type: 'user_report', message, severity: 'warning', is_read: false
  });

  if (result.error) {
    result = await supabaseRequest('POST', '/alerts', {
      type: alertTypes[type] || 'print_complete', message, severity: 'warning', is_read: false
    });
  }

  if (result.error) return err('Failed to submit report', 500);
  return json({ success: true, message: 'Report submitted' });
}
