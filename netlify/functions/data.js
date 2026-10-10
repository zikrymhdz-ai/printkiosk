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

  switch (action) {
    case 'get-jobs': {
      const userId = url.searchParams.get('user_id') || '';
      if (!userId) return err('User ID required');
      const result = await supabaseRequest('GET', '/print_jobs', null, {
        'user_id': 'eq.' + userId,
        'select': '*',
        'status': 'not.in.(completed,refund_issued)',
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

  const result = await supabaseRequest('POST', '/face_detections', {
    user_id: userId,
    user_name: userName,
    matched: matched,
    confidence: confidence,
    kiosk_id: String(body.kiosk_id || 'kiosk-1').slice(0, 40),
    source: 'kiosk'
  });

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
