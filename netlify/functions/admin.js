const { json, err, supabaseRequest, validateSession, supabaseStorageDelete } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  const session = await validateSession(event);
  if (!session || session.users.role !== 'admin') {
    return err('Admin access required', 403);
  }

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  if (event.httpMethod === 'GET') {
    switch (action) {
      case 'stats': return getStats();
      case 'transactions': return getTransactions(url);
      case 'alerts': return getAlerts(url);
      case 'coin-transactions': return getCoinTransactions(url);
      case 'all-users': return getAllUsers();
      case 'viewer-data': return getViewerData();
      case 'face-detections': return getFaceDetections(url);
      case 'kiosk-settings': return getKioskSettingsAdmin();
      default: return err('Invalid action');
    }
  } else if (event.httpMethod === 'POST') {
    switch (action) {
      case 'mark-alert-read': return markAlertRead(event);
      case 'mark-all-alerts-read': return markAllAlertsRead();
      case 'delete-user': return deleteUser(event);
      case 'set-kiosk-settings': return setKioskSettingsAdmin(event, session);
      default: return err('Invalid action');
    }
  }

  return err('Method not allowed', 405);
};

async function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const startToday = today + 'T00:00:00Z';
  const endToday = today + 'T23:59:59Z';

  const todayJobsResult = await supabaseRequest('GET', '/print_jobs', null, {
    'created_at': 'gte.' + startToday,
    'select': 'id,total_price,status,paid'
  });

  let totalJobs = 0, totalRevenue = 0;
  if (!todayJobsResult.error && todayJobsResult.data) {
    for (const job of todayJobsResult.data) {
      totalJobs++;
      if (job.paid) totalRevenue += parseFloat(job.total_price);
    }
  }

  const allJobsResult = await supabaseRequest('GET', '/print_jobs', null, {
    'select': 'id,total_price,status,paid'
  });

  let allTimeJobs = 0, allTimeRevenue = 0, pendingJobs = 0, printingJobs = 0;
  if (!allJobsResult.error && allJobsResult.data) {
    for (const job of allJobsResult.data) {
      allTimeJobs++;
      if (job.paid) allTimeRevenue += parseFloat(job.total_price);
      if (job.status === 'pending') pendingJobs++;
      if (job.status === 'printing') printingJobs++;
    }
  }

  const printerResult = await supabaseRequest('GET', '/printer_status', null, {
    'select': '*',
    'order': 'last_checked.desc',
    'limit': '1'
  });

  const printer = !printerResult.error && printerResult.data && printerResult.data.length > 0
    ? printerResult.data[0]
    : { paper_level: 100, toner_black: 100, toner_cyan: 100, toner_magenta: 100, toner_yellow: 100, status: 'online' };

  const usersResult = await supabaseRequest('GET', '/users', null, {
    'select': 'id',
    'role': 'eq.customer'
  });
  const totalCustomers = !usersResult.error && usersResult.data ? usersResult.data.length : 0;

  const alertsResult = await supabaseRequest('GET', '/alerts', null, {
    'is_read': 'eq.false',
    'select': 'id'
  });
  const unreadAlerts = !alertsResult.error && alertsResult.data ? alertsResult.data.length : 0;

  return json({
    success: true,
    stats: {
      today_jobs: totalJobs,
      today_revenue: Math.round(totalRevenue * 100) / 100,
      all_time_jobs: allTimeJobs,
      all_time_revenue: Math.round(allTimeRevenue * 100) / 100,
      pending_jobs: pendingJobs,
      printing_jobs: printingJobs,
      total_customers: totalCustomers,
      unread_alerts: unreadAlerts
    },
    printer
  });
}

async function getTransactions(url) {
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 100);
  const date = url.searchParams.get('date') || '';

  const params = {
    'select': '*,users(name,email)',
    'order': 'created_at.desc',
    'limit': String(limit)
  };

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    params['created_at'] = 'gte.' + date + 'T00:00:00Z';
    params['and'] = '(created_at.lte.' + date + 'T23:59:59Z)';
  }

  const result = await supabaseRequest('GET', '/print_jobs', null, params);

  const transactions = [];
  if (!result.error && result.data) {
    for (const job of result.data) {
      transactions.push({
        id: job.id,
        job_id: job.job_id,
        customer_name: (job.users && job.users.name) || 'Guest',
        file_name: job.file_name,
        pages: job.pages,
        total_price: job.total_price,
        status: job.status,
        paid: job.paid,
        created_at: job.created_at
      });
    }
  }

  return json({ success: true, transactions });
}

async function getAlerts(url) {
  const date = url.searchParams.get('date') || '';

  const params = {
    'select': '*',
    'order': 'created_at.desc',
    'limit': '50'
  };

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    params['created_at'] = 'gte.' + date + 'T00:00:00Z';
    params['and'] = '(created_at.lte.' + date + 'T23:59:59Z)';
  }

  const result = await supabaseRequest('GET', '/alerts', null, params);

  return json({ success: true, alerts: result.error ? [] : result.data });
}

async function getCoinTransactions(url) {
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 100);
  const date = url.searchParams.get('date') || '';

  const params = {
    'select': '*,users(name,email)',
    'order': 'created_at.desc',
    'limit': String(limit)
  };

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    params['created_at'] = 'gte.' + date + 'T00:00:00Z';
    params['and'] = '(created_at.lte.' + date + 'T23:59:59Z)';
  }

  const result = await supabaseRequest('GET', '/coin_transactions', null, params);

  return json({ success: true, transactions: result.error ? [] : result.data });
}

async function getAllUsers() {
  const result = await supabaseRequest('GET', '/users', null, {
    'select': 'id,name,email,role,coins,created_at',
    'order': 'created_at.desc'
  });

  return json({ success: true, users: result.error ? [] : result.data });
}

async function getViewerData() {
  const result = await supabaseRequest('GET', '/users', null, {
    'select': 'id,name,username,email,phone,role,coins,created_at,email_verified,pin_code,password_hash,face_descriptor,face_images,profile_picture',
    'order': 'created_at.desc',
    'role': 'eq.customer'
  });

  return json({ success: true, users: result.error ? [] : result.data });
}

async function deleteUser(event) {
  const body = JSON.parse(event.body || '{}');
  const userId = body.user_id || '';
  if (!userId) return err('user_id required');

  const userResult = await supabaseRequest('GET', '/users', null, {
    'id': 'eq.' + userId,
    'select': 'id,role'
  });
  const target = userResult.data && userResult.data[0];
  if (!target) return err('User not found', 404);
  if (target.role === 'admin') return err('Admin accounts cannot be deleted', 403);

  const jobsResult = await supabaseRequest('GET', '/print_jobs', null, {
    'user_id': 'eq.' + userId,
    'select': 'file_path'
  });
  if (!jobsResult.error && jobsResult.data) {
    for (const job of jobsResult.data) {
      const filePath = job.file_path || '';
      if (filePath.includes('/storage/v1/object/')) {
        try {
          const parts = filePath.split('/storage/v1/object/')[1].split('/');
          let bucket, path;
          if (parts[0] === 'public') { bucket = parts[1]; path = parts.slice(2).join('/'); }
          else { bucket = parts[0]; path = parts.slice(1).join('/'); }
          await supabaseStorageDelete(bucket, path);
        } catch (e) {}
      }
    }
  }

  await supabaseRequest('DELETE', '/sessions', null, { 'user_id': 'eq.' + userId });
  await supabaseRequest('DELETE', '/payments', null, { 'user_id': 'eq.' + userId });
  await supabaseRequest('DELETE', '/coin_transactions', null, { 'user_id': 'eq.' + userId });
  await supabaseRequest('DELETE', '/print_jobs', null, { 'user_id': 'eq.' + userId });

  const result = await supabaseRequest('DELETE', '/users', null, { 'id': 'eq.' + userId });
  if (result.error) return err('Failed to delete account', 500);

  return json({ success: true, message: 'Account deleted successfully' });
}

async function markAlertRead(event) {
  const body = JSON.parse(event.body || '{}');
  const alertId = body.alert_id || '';
  if (!alertId) return err('Alert ID required');

  await supabaseRequest('PATCH', '/alerts?id=eq.' + alertId, { is_read: true });
  return json({ success: true });
}

async function markAllAlertsRead() {
  const result = await supabaseRequest('GET', '/alerts', null, {
    'is_read': 'eq.false',
    'select': 'id'
  });

  if (!result.error && result.data) {
    for (const alert of result.data) {
      await supabaseRequest('PATCH', '/alerts?id=eq.' + alert.id, { is_read: true });
    }
  }

  return json({ success: true, count: (result.data || []).length });
}

/* ===== FACE DETECTION AUDIT LOG ===== */
async function getFaceDetections(url) {
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
  const dateStr = url.searchParams.get('date') || '';

  const params = {
    'select': 'id,user_id,user_name,matched,confidence,kiosk_id,created_at',
    'order': 'created_at.desc',
    'limit': String(limit)
  };
  if (dateStr) params['created_at'] = 'gte.' + dateStr + 'T00:00:00Z';

  const result = await supabaseRequest('GET', '/face_detections', null, params);

  // Table not migrated yet - show an empty log instead of an error.
  if (result.error) {
    return json({ success: true, detections: [], unavailable: true });
  }

  const detections = result.data || [];
  return json({
    success: true,
    detections: detections,
    stats: {
      total: detections.length,
      matched: detections.filter(d => d.matched).length,
      unknown: detections.filter(d => !d.matched).length
    }
  });
}

/* ===== REMOTE KIOSK CONTROL ===== */
async function getKioskSettingsAdmin() {
  const result = await supabaseRequest('GET', '/kiosk_settings', null, {
    'id': 'eq.default', 'select': '*', 'limit': '1'
  });

  if (result.error) {
    return json({
      success: true,
      unavailable: true,
      settings: {
        face_login_enabled: true,
        maintenance_mode: false,
        maintenance_message: 'Kiosk temporarily unavailable for maintenance. Please see staff.'
      }
    });
  }

  const row = (result.data && result.data[0]) || null;
  return json({
    success: true,
    unavailable: false,
    settings: {
      face_login_enabled: row ? row.face_login_enabled !== false : true,
      maintenance_mode: row ? !!row.maintenance_mode : false,
      maintenance_message: row && row.maintenance_message
        ? row.maintenance_message
        : 'Kiosk temporarily unavailable for maintenance. Please see staff.',
      updated_at: row ? row.updated_at : null,
      updated_by: row ? row.updated_by : null
    }
  });
}

async function setKioskSettingsAdmin(event, session) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const update = { id: 'default', updated_at: new Date().toISOString(), updated_by: session.users.name || 'admin' };

  if (body.face_login_enabled !== undefined) {
    update.face_login_enabled = !!body.face_login_enabled;
  }
  if (body.maintenance_mode !== undefined) {
    update.maintenance_mode = !!body.maintenance_mode;
  }
  if (body.maintenance_message !== undefined) {
    const msg = String(body.maintenance_message || '').slice(0, 300);
    update.maintenance_message = msg;
  }

  if (Object.keys(update).length <= 3) return err('No settings supplied');

  let result = await supabaseRequest('PATCH', '/kiosk_settings?id=eq.default', update);
  if (result.error) {
    // Default row may not exist yet.
    result = await supabaseRequest('POST', '/kiosk_settings', Object.assign({
      face_login_enabled: true,
      maintenance_mode: false,
      maintenance_message: 'Kiosk temporarily unavailable for maintenance. Please see staff.'
    }, update));
    if (result.error) return err('Failed to save kiosk settings: ' + (result.message || ''), 500);
  }

  // Maintenance changes are audit-worthy.
  if (update.maintenance_mode !== undefined || update.face_login_enabled !== undefined) {
    await supabaseRequest('POST', '/alerts', {
      type: 'kiosk_control',
      message: 'Kiosk settings updated by ' + update.updated_by +
        (update.maintenance_mode !== undefined ? ' - maintenance mode ' + (update.maintenance_mode ? 'ON' : 'OFF') : '') +
        (update.face_login_enabled !== undefined ? ' - face login ' + (update.face_login_enabled ? 'ON' : 'OFF') : ''),
      severity: update.maintenance_mode ? 'warning' : 'info',
      is_read: false
    });
  }

  return json({ success: true, message: 'Kiosk settings saved' });
}
