const crypto = require('crypto');
const { json, err, supabaseRequest, NOTIFICATION_SECRET } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  switch (action) {
    case 'confirm': return handlePaymentConfirm(event);
    case 'simulate': return handlePaymentSimulate(event);
    case 'check-status': return handleCheckStatus(event);
    case 'nls-received': return handleNlsReceived(event);
    default: return err('Invalid action');
  }
};

async function confirmJobPaid(job, method, reference) {
  const paymentResult = await supabaseRequest('POST', '/payments', {
    print_job_id: job.id,
    user_id: job.user_id,
    amount: job.total_price,
    method,
    reference,
    status: 'confirmed',
    notified_at: new Date().toISOString()
  });

  if (paymentResult.error) return { ok: false, error: 'Failed to create payment record' };

  const updateResult = await supabaseRequest('PATCH', '/print_jobs?id=eq.' + job.id, {
    status: 'ready_to_print',
    paid: true,
    payment_ref: reference,
    updated_at: new Date().toISOString()
  });

  if (updateResult.error) return { ok: false, error: 'Failed to update job status' };

  let coinsEarned = 0;
  if (job.user_id) {
    coinsEarned = 1;

    const userResult = await supabaseRequest('GET', '/users', null, {
      'id': 'eq.' + job.user_id,
      'select': 'coins'
    });

    if (!userResult.error && userResult.data && userResult.data.length > 0) {
      const currentCoins = userResult.data[0].coins;
      const newBalance = currentCoins + coinsEarned;

      await supabaseRequest('PATCH', '/users?id=eq.' + job.user_id, { coins: newBalance });
      await supabaseRequest('POST', '/coin_transactions', {
        user_id: job.user_id,
        print_job_id: job.id,
        type: 'earned',
        amount: coinsEarned,
        description: 'Print job ' + job.job_id,
        balance_after: newBalance
      });
    }
  }

  await supabaseRequest('POST', '/alerts', {
    type: 'payment_received',
    message: 'Payment received for job ' + job.job_id + ' - RM ' + Number(job.total_price).toFixed(2),
    severity: 'info',
    is_read: false
  });

  return { ok: true, coinsEarned };
}

async function handlePaymentConfirm(event) {
  const body = JSON.parse(event.body || '{}');
  const jobId = body.job_id || '';
  const reference = body.reference || 'PAY-' + require('crypto').randomBytes(8).toString('hex').toUpperCase();

  if (!jobId) return err('Job ID required');

  const jobResult = await supabaseRequest('GET', '/print_jobs', null, {
    'job_id': 'eq.' + jobId,
    'select': '*'
  });

  if (jobResult.error || !jobResult.data || jobResult.data.length === 0) {
    return err('Print job not found', 404);
  }

  const job = jobResult.data[0];
  if (job.paid) return json({ success: true, message: 'Print job already paid', job });

  const res = await confirmJobPaid(job, 'maybank_qr', reference);
  if (!res.ok) return err(res.error, 500);

  return json({
    success: true,
    message: 'Payment confirmed',
    job_id: jobId,
    reference,
    coins_earned: res.coinsEarned
  });
}

async function handleNlsReceived(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const hmac = String(event.headers['x-notify-hmac'] || '').toLowerCase();
  const ts = String(body.posted_at || '');
  const rawText = String(body.raw_text || '');
  const amountRaw = String(body.amount_raw || '');
  const ref = String(body.ref || '');
  const amount = Math.round((parseFloat(body.amount) || 0) * 100) / 100;

  if (!amount || amount <= 0) return json({ success: false, matched: false, reason: 'no_amount' });

  // Verify the signature (exact same message as the APK: amountRaw|postedAt|rawText)
  const message = [amountRaw, ts, rawText].join('|');
  const expected = crypto.createHmac('sha256', NOTIFICATION_SECRET).update(message).digest('hex');
  if (!hmac || expected !== hmac) return err('Invalid signature', 401);

  const jobsResult = await supabaseRequest('GET', '/print_jobs', null, {
    'paid': 'eq.false',
    'status': 'eq.pending',
    'select': 'id,job_id,user_id,total_price,file_name',
    'order': 'created_at.desc'
  });

  const jobs = jobsResult.error ? [] : (jobsResult.data || []);
  const matches = jobs.filter(j => Math.abs(parseFloat(j.total_price) - amount) < 0.005);

  if (!matches.length) {
    await supabaseRequest('POST', '/alerts', {
      type: 'payment_received',
      message: 'Payment detected RM ' + amount.toFixed(2) + ' (REF ' + ref + ' or ' + ts + ') but no matching pending job',
      severity: 'info',
      is_read: false
    });
    return json({ success: false, matched: false, reason: 'no_match', amount });
  }

  const job = matches[0];

  // Idempotency: already confirmed elsewhere?
  const dupResult = await supabaseRequest('GET', '/payments', null, {
    'print_job_id': 'eq.' + job.id,
    'status': 'eq.confirmed',
    'select': 'id',
    'limit': '1'
  });
  if (!dupResult.error && dupResult.data && dupResult.data.length > 0) {
    return json({ success: true, matched: true, job_id: job.job_id, amount, already: true });
  }

  const res = await confirmJobPaid(job, 'maybank2u_detected', ref || ('DET-' + job.job_id));
  if (!res.ok) return err(res.error, 500);

  if (matches.length > 1) {
    await supabaseRequest('POST', '/alerts', {
      type: 'payment_received',
      message: 'Multiple pending jobs matched RM ' + amount.toFixed(2) + ' - confirmed the most recent (' + job.job_id + ')',
      severity: 'info',
      is_read: false
    });
  }

  return json({
    success: true,
    matched: true,
    job_id: job.job_id,
    amount,
    coins_earned: res.coinsEarned,
    ambiguous: matches.length > 1
  });
}

async function handlePaymentSimulate(event) {
  const body = JSON.parse(event.body || '{}');
  const jobId = body.job_id || '';

  if (!jobId) return err('Job ID required');

  const jobResult = await supabaseRequest('GET', '/print_jobs', null, {
    'job_id': 'eq.' + jobId,
    'select': '*'
  });

  if (jobResult.error || !jobResult.data || jobResult.data.length === 0) {
    return err('Print job not found', 404);
  }

  const job = jobResult.data[0];
  if (job.paid) return json({ success: true, message: 'Print job already paid', job });

  const reference = 'SIM-' + require('crypto').randomBytes(8).toString('hex').toUpperCase();

  const updateResult = await supabaseRequest('PATCH', '/print_jobs?id=eq.' + job.id, {
    status: 'ready_to_print',
    paid: true,
    payment_ref: reference,
    updated_at: new Date().toISOString()
  });

  if (updateResult.error) return err('Failed to update job status', 500);

  return json({
    success: true,
    message: 'Payment simulated - job marked as paid',
    job_id: jobId,
    reference
  });
}

async function handleCheckStatus(event) {
  let jobId;
  if (event.httpMethod === 'GET') {
    const url = new URL(event.rawUrl);
    jobId = url.searchParams.get('job_id') || '';
  } else {
    const body = JSON.parse(event.body || '{}');
    jobId = body.job_id || '';
  }

  if (!jobId) return err('Job ID required');

  const result = await supabaseRequest('GET', '/print_jobs', null, {
    'job_id': 'eq.' + jobId,
    'select': 'status,paid,payment_ref,total_price'
  });

  if (result.error || !result.data || result.data.length === 0) {
    return err('Print job not found', 404);
  }

  return json({ success: true, job: result.data[0] });
}