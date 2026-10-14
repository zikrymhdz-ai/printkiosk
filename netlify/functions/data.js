const { json, err, supabaseRequest, supabaseStorageDelete, APP_VERSION } = require('./_shared');

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
  if (event.httpMethod === 'POST' && action === 'submit-report') {
    return await handleSubmitReport(event);
  }
  if (event.httpMethod === 'POST' && action === 'log-face-detection') {
    return await handleLogFaceDetection(event);
  }
  if (event.httpMethod === 'POST' && action === 'kiosk-heartbeat') {
    return await handleKioskHeartbeat(event);
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
    'print_pin': null
  });

  const filePath = job.file_path || '';
  if (filePath && filePath.includes('/storage/v1/object/')) {
    try {
      const storageUrl = filePath.split('/storage/v1/object/')[1];
      const parts = storageUrl.split('/');
      let bucket, path;
      if (parts[0] === 'public') {
        bucket = parts[1];
        path = parts.slice(2).join('/');
      } else {
        bucket = parts[0];
        path = parts.slice(1).join('/');
      }
      await supabaseStorageDelete(bucket, path);
    } catch(e) {}
  }

  return json({ success: true, message: 'Job completed and cleaned up' });
}

async function handleDeleteJob(event) {
  const body = JSON.parse(event.body || '{}');
  const jobId = body.job_id || '';
  if (!jobId) return err('job_id required');

  const jobResult = await supabaseRequest('GET', '/print_jobs', null, {
    'job_id': 'eq.' + jobId,
    'select': 'id,file_path'
  });
  const job = jobResult.data && jobResult.data[0];
  if (!job) return err('Job not found', 404);

  await supabaseRequest('PATCH', '/print_jobs?job_id=eq.' + jobId, {
    'status': 'completed',
    'print_pin': null
  });

  const filePath = job.file_path || '';
  if (filePath && filePath.includes('/storage/v1/object/')) {
    try {
      const storageUrl = filePath.split('/storage/v1/object/')[1];
      const parts = storageUrl.split('/');
      let bucket, path;
      if (parts[0] === 'public') {
        bucket = parts[1];
        path = parts.slice(2).join('/');
      } else {
        bucket = parts[0];
        path = parts.slice(1).join('/');
      }
      await supabaseStorageDelete(bucket, path);
    } catch(e) {}
  }

  return json({ success: true, message: 'Job deleted' });
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
