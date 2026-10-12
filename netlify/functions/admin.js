const { json, err, supabaseRequest, validateSession, supabaseStorageDelete, JOB_PAYABLE_WINDOW_MIN } = require('./_shared');

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
      case 'face-snapshot': return getFaceSnapshot(url);
      case 'kiosk-settings': return getKioskSettingsAdmin();
      case 'kiosk-status': return getKioskStatus();
      case 'watcher-status': return getWatcherStatus();
      case 'payment-log': return getPaymentLog(url);
      case 'payment-review': return getPaymentReview(url);
      case 'pending-payable': return getPendingPayableJobs();
      default: return err('Invalid action');
    }
  } else if (event.httpMethod === 'POST') {
    switch (action) {
      case 'mark-alert-read': return markAlertRead(event);
      case 'mark-all-alerts-read': return markAllAlertsRead();
      case 'delete-user': return deleteUser(event);
      // Must be POST: this deletes rows, so it must never run on a GET.
      case 'delete-face-detections': return deleteFaceDetections(event);
      case 'set-kiosk-settings': return setKioskSettingsAdmin(event, session);
      case 'delete-payment-log': return deletePaymentLog(event);
      // Both of these move money, so they must never run on a GET - a stray
      // page visit or prefetch would otherwise confirm or reverse a payment.
      case 'payment-manual-confirm': return manualConfirmPayment(event, session);
      case 'set-job-paid': return setJobPaidStatus(event, session);
      case 'delete-print-jobs': return deletePrintJobs(event, session);
      case 'delete-coin-transactions': return deleteCoinTransactions(event, session);
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
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 200);
  const date = url.searchParams.get('date') || '';
  const sort = url.searchParams.get('sort') || 'newest';
  const paidFilter = url.searchParams.get('paid') || '';

  const params = {
    'select': '*,users(name,email)',
    // Staff work through the backlog oldest-first, so this is opt-in rather than
    // changing the default view.
    'order': sort === 'oldest' ? 'created_at.asc' : 'created_at.desc',
    'limit': String(limit)
  };

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    params['created_at'] = 'gte.' + date + 'T00:00:00Z';
    params['and'] = '(created_at.lte.' + date + 'T23:59:59Z)';
  }

  if (paidFilter === 'paid') params['paid'] = 'eq.true';
  else if (paidFilter === 'unpaid') params['paid'] = 'eq.false';

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
  // Raised so the admin can select and clear a meaningful chunk of history in one
  // pass rather than only the first 100 rows.
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 500);
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
const FACE_LOG_RETENTION_DAYS = 30;
// Netlify runs the kiosk-cleanup function daily, but scheduled functions are
// unavailable on some plans. This opportunistic prune is the safety net: it runs
// at most once an hour whenever an admin opens the log.
let lastFaceLogPrune = 0;

async function pruneFaceDetectionsIfDue() {
  if (Date.now() - lastFaceLogPrune < 60 * 60 * 1000) return;
  lastFaceLogPrune = Date.now();
  const cutoff = new Date(Date.now() - FACE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await supabaseRequest('DELETE', '/face_detections?created_at=lt.' + encodeURIComponent(cutoff), null, {
    'select': 'id', 'limit': '500'
  });
}

// Delete selected rows, or the whole log when no ids are supplied.
async function deleteFaceDetections(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  let ids = Array.isArray(body.ids) ? body.ids.filter(function (id) { return typeof id === 'string' && id.length > 0; }) : [];

  if (ids.length > 500) return err('Too many ids selected', 400);

  if (ids.length === 0) {
    if (!body.all) return err('No rows selected');
    const all = await supabaseRequest('GET', '/face_detections', null, { 'select': 'id', 'limit': '1000' });
    if (all.error) return err('Could not read the log', 500);
    ids = (all.data || []).map(function (r) { return r.id; });
    if (!ids.length) return json({ success: true, deleted: 0, message: 'Log already empty' });
  }

  const result = await supabaseRequest('DELETE', '/face_detections?id=in.(' + ids.join(',') + ')', null);
  if (result.error) return err('Failed to delete: ' + (result.message || ''), 500);

  return json({ success: true, deleted: ids.length, message: 'Deleted ' + ids.length + ' entr' + (ids.length === 1 ? 'y' : 'ies') });
}

async function getFaceDetections(url) {
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
  const dateStr = url.searchParams.get('date') || '';

  pruneFaceDetectionsIfDue(); // fire-and-forget, must not delay the response

  const params = {
    'select': 'id,user_id,user_name,matched,confidence,kiosk_id,created_at,face_snapshot',
    'order': 'created_at.desc',
    'limit': String(limit)
  };
  if (dateStr) params['created_at'] = 'gte.' + dateStr + 'T00:00:00Z';

  const result = await supabaseRequest('GET', '/face_detections', null, params);

  // Table not migrated yet - show an empty log instead of an error.
  if (result.error) {
    return json({ success: true, detections: [], unavailable: true });
  }

  const detections = (result.data || []).map(d => {
    // Never ship the base64 image in the list payload - it would bloat the
    // response by hundreds of KB per row. Return a flag and let the admin fetch
    // the single image it actually renders, lazily, via ?action=face-snapshot.
    const has = !!d.face_snapshot;
    delete d.face_snapshot;
    d.has_snapshot = has;
    return d;
  });

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

// Serve one stored snapshot as a real image so the admin can <img> it.
async function getFaceSnapshot(url) {
  const id = String(url.searchParams.get('id') || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return json({ success: false, error: 'Invalid id' }, 400);

  const result = await supabaseRequest('GET', '/face_detections', null, {
    'select': 'face_snapshot', 'id': 'eq.' + id, 'limit': '1'
  });
  if (result.error || !result.data || !result.data.length || !result.data[0].face_snapshot) {
    return json({ success: false, error: 'No image' }, 404);
  }

  const m = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/.exec(result.data[0].face_snapshot);
  if (!m) return json({ success: false, error: 'Bad image' }, 404);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': m[1],
      'Cache-Control': 'private, max-age=31536000, immutable'
    },
    body: m[2],
    isBase64Encoded: true
  };
}

/* ===== PAYMENT WATCHER (mobile) ===== */
// Is the phone that watches for TnG payments actually alive?
//
// This is the single most important status in the product. If the watcher is
// dead, customers still hand over real money at the counter but nothing marks
// their job as paid, so printing silently fails until someone complains. The
// heartbeat arrives every 30s; anything older than 90s means it is not reporting.
const WATCHER_OFFLINE_AFTER_SEC = 90;

async function getWatcherStatus() {
  const result = await supabaseRequest('GET', '/watcher_heartbeats', null, {
    'order': 'seen_at.desc',
    'limit': '1'
  });

  if (result.error || !result.data || result.data.length === 0) {
    return json({
      success: true, online: false, never_reported: true,
      message: 'The payment watcher has never reported in. Install it on the staff phone and grant notification access.'
    });
  }

  const b = result.data[0];
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(b.seen_at).getTime()) / 1000));
  const online = ageSeconds <= WATCHER_OFFLINE_AFTER_SEC;

  return json({
    success: true,
    online: online,
    // Offline means: no heartbeat, OR alive but the notification listener is
    // unbound (Android revoked it). Both stop payments being detected, so both
    // must be surfaced loudly rather than treated as fine.
    listening: !!b.listening,
    access_granted: !!b.access_granted,
    status: {
      watcher_id: b.watcher_id,
      app_version: b.app_version,
      seen_at: b.seen_at,
      age_seconds: ageSeconds,
      notifications_seen: b.notifications_seen,
      payments_matched: b.payments_matched,
      queued_pending: b.queued_pending,
      last_post: b.last_post,
      detail: b.detail
    },
    message: online
      ? (!b.listening || !b.access_granted
        ? 'The watcher app is running but notification access is OFF, so no payment can be detected. Grant it in Android settings.'
        : 'Watcher is online and listening.')
      : 'The payment watcher stopped reporting ' + ageSeconds + 's ago. Payments are being taken but NOT auto-confirmed.'
  });
}

// Every notification the watcher saw, matched or not. This is the evidence needed
// to fix the parser: TnG changes its wording without warning.
async function getPaymentLog(url) {
  const limit = Math.min(300, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
  const statusFilter = url.searchParams.get('status') || '';

  const params = {
    'select': 'id,package_name,title,raw_text,gate_text,amount,amount_raw,reference,incoming,status,job_id,detail,posted_at,seen_at',
    'order': 'seen_at.desc',
    'limit': String(limit)
  };
  if (statusFilter) params['status'] = 'eq.' + statusFilter;

  const result = await supabaseRequest('GET', '/payment_log', null, params);
  if (result.error) {
    return json({ success: true, rows: [], unavailable: true });
  }

  const rows = result.data || [];
  return json({
    success: true,
    rows: rows,
    stats: {
      total: rows.length,
      incoming: rows.filter(r => r.incoming).length,
      matched: rows.filter(r => r.status === 'matched').length,
      ignored: rows.filter(r => r.status === 'ignored').length
    }
  });
}

async function deletePaymentLog(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  let ids = Array.isArray(body.ids) ? body.ids.filter(id => typeof id === 'string' && id.length > 0) : [];
  if (ids.length > 500) return err('Too many rows selected', 400);

  if (!ids.length) {
    if (!body.all) return err('No rows selected');
    const all = await supabaseRequest('GET', '/payment_log', null, { 'select': 'id', 'limit': '1000' });
    if (all.error) return err('Could not read the log', 500);
    ids = (all.data || []).map(r => r.id);
    if (!ids.length) return json({ success: true, deleted: 0 });
  }

  const result = await supabaseRequest('DELETE', '/payment_log?id=in.(' + ids.join(',') + ')', null);
  if (result.error) return err('Failed to delete', 500);
  return json({ success: true, deleted: ids.length });
}

// Payments that were ambiguous and parked for a human. This is the fallback that
// keeps an unresolvable match from ever releasing the wrong customer's document.
async function getPaymentReview(url) {
  const status = url.searchParams.get('status') || 'pending';
  const result = await supabaseRequest('GET', '/payment_review_queue', null, {
    'status': 'eq.' + status,
    'order': 'created_at.desc',
    'limit': '100'
  });
  if (result.error) {
    return json({ success: true, items: [], unavailable: true });
  }
  return json({ success: true, items: result.data || [] });
}

// Jobs a customer could still legitimately be paying for right now. Used by the
// manual confirm dropdown so staff have an exact list to choose from instead of
// hunting through the full job table.
async function getPendingPayableJobs() {
  const cutoff = new Date(Date.now() - JOB_PAYABLE_WINDOW_MIN * 60 * 1000).toISOString();
  const result = await supabaseRequest('GET', '/print_jobs', null, {
    'paid': 'eq.false',
    'status': 'eq.pending',
    'created_at': 'gte.' + cutoff,
    'select': 'id,job_id,total_price,pages,copies,color_mode,created_at',
    'order': 'created_at.desc',
    'limit': '50'
  });

  if (result.error) return json({ success: false, jobs: [] });

  const now = Date.now();
  const jobs = (result.data || []).map(j => ({
    id: j.id,
    job_id: j.job_id,
    total_price: parseFloat(j.total_price),
    pages: j.pages,
    copies: j.copies,
    color_mode: j.color_mode,
    created_at: j.created_at,
    age_minutes: j.created_at ? Math.round((now - new Date(j.created_at).getTime()) / 60000) : null
  }));

  return json({ success: true, jobs, window_minutes: JOB_PAYABLE_WINDOW_MIN });
}

// Flip a job's paid flag from the Transactions table.
//
// Marking paid reuses the same confirmJobPaid() the watcher uses, so the coin,
// the payment record and the status transition stay consistent - flipping the
// column directly would print the job but never credit the customer.
//
// Un-marking has to undo all of that, otherwise a job could be reverted while
// the customer keeps a coin they did not earn. Jobs already printed or refunded
// are refused: un-paying those would let the document be collected twice.
async function setJobPaidStatus(event, session) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const jobId = String(body.job_id || '');
  const makePaid = !!body.paid;
  if (!jobId) return err('job_id required');

  const job = await findPrintJob(jobId);
  if (!job) return err('Print job not found', 404);

  if (!!job.paid === makePaid) {
    return json({ success: true, job_id: job.job_id, paid: !!job.paid, unchanged: true });
  }

  const actor = (session.users && (session.users.email || session.users.name)) || 'admin';
  const who = 'manual_admin';

  if (makePaid) {
    const { confirmJobPaid } = require('./payment');
    const res = await confirmJobPaid(job, who, 'ADMIN-' + job.job_id);
    if (!res.ok) return err(res.error || 'Failed to mark paid', 500);

    await supabaseRequest('POST', '/alerts', {
      type: 'kiosk_control',
      message: actor + ' marked ' + job.job_id + ' as paid manually (RM ' + parseFloat(job.total_price).toFixed(2) + ')',
      severity: 'warning',
      is_read: false
    });

    // Read the row back so the UI can report what was actually persisted rather
    // than just echoing the request. Staff marking money by hand need to see the
    // database state, not just that the request was accepted.
    const after = await supabaseRequest('GET', '/print_jobs', null, {
      'id': 'eq.' + job.id, 'select': 'job_id,paid,status,payment_ref,total_price,user_id', 'limit': '1'
    });
    const now = after.data && after.data.length ? after.data[0] : null;

    let coinsNow = null;
    if (job.user_id) {
      const u = await supabaseRequest('GET', '/users', null, {
        'id': 'eq.' + job.user_id, 'select': 'coins', 'limit': '1'
      });
      if (!u.error && u.data && u.data.length > 0) coinsNow = parseInt(u.data[0].coins, 10) || 0;
    }

    return json({
      success: true,
      job_id: job.job_id,
      paid: true,
      coins_earned: res.coinsEarned,
      coins_balance: coinsNow,
      database: now ? {
        job_id: now.job_id,
        paid: !!now.paid,
        status: now.status,
        payment_ref: now.payment_ref,
        total_price: parseFloat(now.total_price)
      } : null,
      verified: !!(now && now.paid === true)
    });
  }

  // ---- reversing a payment ----
  if (job.status === 'completed' || job.status === 'refund_issued') {
    return err('That job is already ' + job.status.replace('_', ' ') + '. Use a refund instead of clearing payment.', 409);
  }

  // Remove the payment record this job earned.
  await supabaseRequest('DELETE', '/payments?print_job_id=eq.' + job.id + '&status=eq.confirmed', null);

  // Take the coin back, but only if it is still there. Floor at zero: a customer
  // who already spent the coin cannot go negative.
  if (job.user_id) {
    const u = await supabaseRequest('GET', '/users', null, {
      'id': 'eq.' + job.user_id, 'select': 'coins', 'limit': '1'
    });
    if (!u.error && u.data && u.data.length > 0) {
      const current = parseInt(u.data[0].coins, 10) || 0;
      const take = current > 0 ? 1 : 0;
      const balance = current - take;
      await supabaseRequest('PATCH', '/users?id=eq.' + job.user_id, { coins: balance });
      await supabaseRequest('POST', '/coin_transactions', {
        user_id: job.user_id,
        print_job_id: job.id,
        type: 'spent',
        amount: take,
        description: 'Payment cleared by admin for job ' + job.job_id,
        balance_after: balance
      });
    }
  }

  const updated = await supabaseRequest('PATCH', '/print_jobs?id=eq.' + job.id, {
    status: 'pending',
    paid: false,
    payment_ref: null,
    updated_at: new Date().toISOString()
  });
  if (updated.error) return err('Failed to update job status', 500);

  await supabaseRequest('POST', '/alerts', {
    type: 'kiosk_control',
    message: actor + ' cleared payment on ' + job.job_id + ' - now unpaid again',
    severity: 'warning',
    is_read: false
  });

  const after = await supabaseRequest('GET', '/print_jobs', null, {
    'id': 'eq.' + job.id, 'select': 'job_id,paid,status,payment_ref', 'limit': '1'
  });
  const now = after.data && after.data.length ? after.data[0] : null;

  return json({
    success: true,
    job_id: job.job_id,
    paid: false,
    database: now ? { job_id: now.job_id, paid: !!now.paid, status: now.status, payment_ref: now.payment_ref } : null,
    verified: !!(now && now.paid === false)
  });
}

/**
 * Resolve a print job from either identifier.
 *
 * The dashboard shows staff the human-readable job_id (PRN-2026...), while rows
 * carry a UUID in `id`. Callers used to send one and look up the other, which
 * silently produced "Print job not found". Accepting both keeps the API usable
 * from the table, from the kiosk, and from anything holding a UUID.
 */
async function findPrintJob(ref) {
  if (!ref) return null;

  // print_jobs.id is a uuid column. Sending a job code like PRN-2026... to it is
  // rejected by PostgREST with 400, not an empty result, so only try the uuid
  // lookup when the value actually looks like a uuid.
  const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(ref);

  if (isUuid) {
    const byId = await supabaseRequest('GET', '/print_jobs', null, {
      'id': 'eq.' + ref, 'select': '*', 'limit': '1'
    });
    if (!byId.error && byId.data && byId.data.length) return byId.data[0];
    return null;
  }

  const byJobId = await supabaseRequest('GET', '/print_jobs', null, {
    'job_id': 'eq.' + ref, 'select': '*', 'limit': '1'
  });
  if (!byJobId.error && byJobId.data && byJobId.data.length) return byJobId.data[0];

  // Last resort: a uuid sent with odd casing or whitespace still failed isUuid.
  const byId2 = await supabaseRequest('GET', '/print_jobs', null, {
    'id': 'eq.' + ref, 'select': '*', 'limit': '1'
  });
  if (!byId2.error && byId2.data && byId2.data.length) return byId2.data[0];

  return null;
}

/* ===== DELETING JOBS AND TRANSACTION HISTORY ===== */
// Resolve the bucket/path out of a stored file_path. Copied from the customer-side
// delete so both remove uploads from the bucket rather than orphaning them.
function storageTarget(filePath) {
  if (!filePath || filePath.indexOf('/storage/v1/object/') === -1) return null;
  const storageUrl = filePath.split('/storage/v1/object/')[1];
  const parts = storageUrl.split('/');
  if (parts[0] === 'public') return { bucket: parts[1], path: parts.slice(2).join('/') };
  return { bucket: parts[0], path: parts.slice(1).join('/') };
}

/**
 * Delete print jobs, cascading to the rows that point at them.
 *
 * payments and coin_transactions both carry print_job_id. Removing the job first
 * would leave those rows referencing a job that no longer exists, so they go in
 * the same operation. The uploaded file is removed from storage too - otherwise
 * every deleted job keeps costing bucket space forever.
 */
async function deletePrintJobs(event, session) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  let ids = Array.isArray(body.ids) ? body.ids.filter(id => typeof id === 'string' && id.length > 0) : [];
  if (ids.length > 300) return err('Too many jobs selected', 400);

  let jobs = [];
  if (!ids.length) {
    if (!body.all) return err('No jobs selected');
    const all = await supabaseRequest('GET', '/print_jobs', null, { 'select': 'id', 'limit': '1000' });
    if (all.error) return err('Could not read jobs', 500);
    ids = (all.data || []).map(r => r.id);
    if (!ids.length) return json({ success: true, deleted: 0, message: 'No jobs to delete' });
  }

  const found = await supabaseRequest('GET', '/print_jobs', null, {
    'id': 'in.(' + ids.join(',') + ')',
    'select': 'id,job_id,file_path',
    'limit': String(ids.length)
  });
  if (!found.error) jobs = found.data || [];

  // Cascade first, so nothing is left pointing at a job that is about to vanish.
  await supabaseRequest('DELETE', '/payments?print_job_id=in.(' + ids.join(',') + ')', null);
  await supabaseRequest('DELETE', '/coin_transactions?print_job_id=in.(' + ids.join(',') + ')', null);

  const del = await supabaseRequest('DELETE', '/print_jobs?id=in.(' + ids.join(',') + ')', null);
  if (del.error) return err('Failed to delete jobs', 500);

  let filesRemoved = 0;
  for (const j of jobs) {
    const t = storageTarget(j.file_path);
    if (!t) continue;
    try { await supabaseStorageDelete(t.bucket, t.path); filesRemoved++; } catch (e) {}
  }

  const actor = (session.users && (session.users.email || session.users.name)) || 'admin';
  await supabaseRequest('POST', '/alerts', {
    type: 'kiosk_control',
    message: actor + ' deleted ' + ids.length + ' print job(s)' + (filesRemoved ? ' and ' + filesRemoved + ' uploaded file(s)' : ''),
    severity: 'warning',
    is_read: false
  });

  return json({
    success: true,
    deleted: ids.length,
    files_removed: filesRemoved,
    message: 'Deleted ' + ids.length + ' job' + (ids.length === 1 ? '' : 's')
  });
}

/**
 * Clear coin/transaction history.
 *
 * Only the ledger rows are removed - the customer's balance lives on users.coins
 * and is left untouched, so this tidies the history without changing what anyone
 * has actually earned.
 */
async function deleteCoinTransactions(event, session) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  let ids = Array.isArray(body.ids) ? body.ids.filter(id => typeof id === 'string' && id.length > 0) : [];
  if (ids.length > 500) return err('Too many rows selected', 400);

  if (!ids.length) {
    if (!body.all) return err('No rows selected');
    const all = await supabaseRequest('GET', '/coin_transactions', null, { 'select': 'id', 'limit': '2000' });
    if (all.error) return err('Could not read history', 500);
    ids = (all.data || []).map(r => r.id);
    if (!ids.length) return json({ success: true, deleted: 0 });
  }

  // Batch so a large clear does not build one oversized PostgREST URL.
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await supabaseRequest('DELETE', '/coin_transactions?id=in.(' + chunk.join(',') + ')', null);
    if (r.error) return err('Failed to delete history', 500);
    deleted += chunk.length;
  }

  const actor = (session.users && (session.users.email || session.users.name)) || 'admin';
  await supabaseRequest('POST', '/alerts', {
    type: 'kiosk_control',
    message: actor + ' cleared ' + deleted + ' transaction history entr' + (deleted === 1 ? 'y' : 'ies'),
    severity: 'warning',
    is_read: false
  });

  return json({ success: true, deleted });
}

async function manualConfirmPayment(event, session) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const jobId = String(body.job_id || '');
  const reviewId = String(body.review_id || '');
  if (!jobId) return err('job_id required');

  const job = await findPrintJob(jobId);
  if (!job) return err('Print job not found', 404);

  if (job.paid) return err('That job is already confirmed as paid');

  const { confirmJobPaid } = require('./payment');
  const res = await confirmJobPaid(job, 'manual_admin', 'MANUAL-' + job.job_id);
  if (!res.ok) return err(res.error || 'Failed to confirm', 500);

  if (reviewId) {
    await supabaseRequest('PATCH', '/payment_review_queue?id=eq.' + reviewId, {
      status: 'resolved',
      resolved_job: job.job_id,
      resolved_by: session.users.email || 'admin',
      resolved_at: new Date().toISOString()
    });
  }

  return json({ success: true, job_id: job.job_id, coins_earned: res.coinsEarned });
}

/* ===== REMOTE KIOSK CONTROL ===== */
// Latest heartbeat from the shop screen: is it alive, did it load face-api,
// did the camera open? Answers "why is the kiosk screen black" remotely.
async function getKioskStatus() {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = await supabaseRequest('GET', '/kiosk_heartbeats', null, {
    'order': 'seen_at.desc',
    'limit': '1'
  });

  if (result.error || !result.data || result.data.length === 0) {
    return json({ success: true, online: false, unavailable: true, message: 'No heartbeat received' });
  }

  const hb = result.data[0];
  const ageMs = Date.now() - new Date(hb.seen_at).getTime();
  const online = ageMs < 90 * 1000;

  return json({
    success: true,
    online: online,
    unavailable: false,
    status: {
      kiosk_id: hb.kiosk_id,
      app_version: hb.app_version,
      state: hb.state,
      detail: hb.detail,
      last_log: hb.last_log,
      face_lib: hb.face_lib,
      camera: hb.camera,
      camera_size: hb.camera_size,
      models_loaded: hb.models_loaded,
      cam_label: hb.cam_label,
      seen_at: hb.seen_at,
      age_seconds: Math.round(ageMs / 1000)
    }
  });
}

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
