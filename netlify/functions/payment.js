const crypto = require('crypto');
const { json, err, supabaseRequest, NOTIFICATION_SECRET, validateSession, safeEqual } = require('./_shared');

// How long after upload a payment can still settle the job. Generous on
// purpose: this is the difference between "customer paid" and "customer paid
// and was never credited".
const MATCH_WINDOW_MIN = 60;

// Development convenience only. Off unless explicitly switched on, because a
// public "mark this job paid" endpoint is a free-print button for anyone.
const SIMULATE_ENABLED = process.env.PAYMENT_ALLOW_SIMULATE === 'true';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  // check-status is a read-only "has the payment landed yet" poll that the
  // customer page calls repeatedly, so it has to accept GET. Everything else
  // here settles money and is POST-only.
  if (action !== 'check-status' && event.httpMethod !== 'POST') {
    return err('Method not allowed', 405);
  }

  // Both of these settle money, so both require a logged-in staff session.
  // They used to be open to the internet: anyone could POST a job id and get
  // it marked paid -- and credited a coin -- without paying anything.
  if (action === 'confirm' || action === 'simulate') {
    const session = await validateSession(event);
    if (!session || session.users.role !== 'admin') {
      return err('Payment settlement requires staff sign-in', 403);
    }
    if (action === 'simulate' && !SIMULATE_ENABLED) {
      return err('Payment simulation is disabled', 403);
    }
  }

  switch (action) {
    case 'confirm': return handlePaymentConfirm(event);
    case 'simulate': return handlePaymentSimulate(event);
    case 'check-status': return handleCheckStatus(event);
    case 'nls-received': return handleNlsReceived(event);
    default: return err('Invalid action');
  }
};

// Credit one coin for an order, recorded against the job that anchors it.
//
// Kept as its own function so the per-order rule lives in exactly one place:
// confirmJobPaid() calls it for a single-file order, and the multi-file path
// calls it once after settling every file.
// One coin per FILE printed, not per payment.
//
// This was briefly changed to one coin per order on the reasoning that a
// customer makes a single payment. That was wrong: the reward is for having
// something printed, so five files earn five coins even when they arrive
// together in one order and one transfer. Reverted to per file.
async function awardFileCoin(job) {
  if (!job || !job.user_id) return 0;

  const userResult = await supabaseRequest('GET', '/users', null, {
    'id': 'eq.' + job.user_id,
    'select': 'coins'
  });

  if (userResult.error || !userResult.data || userResult.data.length === 0) {
    return 0;
  }

  const newBalance = (parseInt(userResult.data[0].coins, 10) || 0) + 1;

  await supabaseRequest('PATCH', '/users?id=eq.' + job.user_id, { coins: newBalance });
  await supabaseRequest('POST', '/coin_transactions', {
    user_id: job.user_id,
    print_job_id: job.id,
    type: 'earned',
    amount: 1,
    description: 'Print job ' + job.job_id,
    balance_after: newBalance
  });

  return 1;
}

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
  // One coin per file. In a multi-file order confirmJobPaid runs once per file,
  // so each one is credited separately - which is the intended behaviour.
  coinsEarned = await awardFileCoin(job);

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

  const res = await confirmJobPaid(job, 'tng_qr', reference);
  if (!res.ok) return err(res.error, 500);

  return json({
    success: true,
    message: 'Payment confirmed',
    job_id: jobId,
    reference,
    coins_earned: res.coinsEarned
  });
}

// The amount allocator (_shared) holds a unique match fee only while a job is
// still payable. That window stays short so the ten cent-slots do not run out;
// matching below uses a much longer window of its own.
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

  // Two different windows, deliberately.
  //
  // JOB_PAYABLE_WINDOW_MIN decides which jobs compete for a unique match fee,
  // so it stays short: only ten cent-slots exist, and if it were long enough to
  // collect abandoned jobs there would not be enough slots to go round.
  //
  // MATCH_WINDOW_MIN decides which jobs a payment may settle. That has to be
  // far more forgiving. Someone who uploads, opens their banking app, and pays
  // fifteen minutes later has handed over real money, and under the old single
  // ten-minute window that payment was recorded as "no matching pending job"
  // while their job sat unpaid forever. The customer paid and got nothing.
  //
  // Widening this is safe because the total still has to match exactly, and any
  // genuine ambiguity is parked for staff review rather than guessed at.
  const matchCutoff = new Date(Date.now() - MATCH_WINDOW_MIN * 60 * 1000).toISOString();
  const cutoff = matchCutoff;

  const jobsResult = await supabaseRequest('GET', '/print_jobs', null, {
    'paid': 'eq.false',
    'status': 'eq.pending',
    // session_id is needed to group GUEST jobs by owner. Without it a guest's
      // files all fell into one shared bucket and could be combined across
      // unrelated customers.
      'select': 'id,job_id,user_id,session_id,total_price,file_name,created_at,page_spec,pages,copies,color_mode',
    'created_at': 'gte.' + cutoff,
    'order': 'created_at.desc'
  });
  const jobs = jobsResult.error ? [] : (jobsResult.data || []);

  // Group into orders. Each order is settled as a unit, so the payment is
  // matched against an ORDER's total, not an individual job's.
  const byOrder = new Map();
  for (const j of jobs) {
    const k = orderKeyOf(j);
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k).push(j);
  }

  const candidates = [];
  for (const [k, group] of byOrder) {
    // Every file in an order shares one amount; treat them as one candidate.
    candidates.push({ key: k, jobs: group, amount: orderAmountOf(group) });
  }

  const matches = candidates.filter(c => Math.abs(c.amount - amount) < 0.005);

  if (!matches.length) {
    await supabaseRequest('POST', '/alerts', {
      type: 'payment_received',
      message: 'Payment detected RM ' + amount.toFixed(2) + ' (REF ' + ref + ' or ' + ts + ') but no matching order was found. Orders must be paid in full; a partial payment does not settle.',
      severity: 'info',
      is_read: false
    });
    return json({ success: false, matched: false, reason: 'no_match', amount });
  }

  if (matches.length > 1) {
    // Two orders genuinely cost the same. Do not guess which documents the
    // money paid for - releasing the wrong customer's files is a free print.
    await supabaseRequest('POST', '/payment_review_queue', {
      amount: amount,
      payer_text: rawText,
      notification_ref: ref,
      reason: matches.length + ' orders each total RM ' + amount.toFixed(2)
        + ' - staff must decide which order this paid for'
    });
    await supabaseRequest('POST', '/alerts', {
      type: 'payment_received',
      message: 'Payment detected RM ' + amount.toFixed(2) + ' (REF ' + ref + ') matches '
        + matches.length + ' different orders - parked for review',
      severity: 'warning',
      is_read: false
    });
    return json({ success: false, matched: false, reason: 'ambiguous_order', amount: amount });
  }

  // Exactly one order carries this amount.
  const order = matches[0];
  const orderJobs = order.jobs;

  if (orderJobs.length > 1) {
    // Settle every file in the order. confirmJobPaid credits one coin per file,
    // so a five-file order earns five coins even though the customer paid once.
    let coins = 0;
    for (let i = 0; i < orderJobs.length; i++) {
      const r = await confirmJobPaid(orderJobs[i], 'DuitNow (order)', ref);
      if (!r.ok) {
        await supabaseRequest('POST', '/alerts', {
          type: 'payment_received',
          message: 'Order payment for ' + orderJobs.map(j => j.job_id).join(' + ')
            + ' failed partway: ' + r.error + '. Check these jobs by hand.',
          severity: 'error',
          is_read: false
        });
        return json({ success: false, matched: false, reason: 'settle_failed', amount: amount });
      }
      coins += r.coinsEarned || 0;
    }

    await supabaseRequest('POST', '/alerts', {
      type: 'payment_received',
      message: 'Payment RM ' + amount.toFixed(2) + ' settled an order of '
        + orderJobs.length + ' files: ' + orderJobs.map(j => j.job_id).join(', ')
        + ' (' + coins + ' coins)',
      severity: 'info',
      is_read: false
    });

    return json({
      success: true,
      matched: true,
      order: true,
      job_ids: orderJobs.map(j => j.job_id),
      amount: amount,
      // One coin per file, so the total scales with what was printed.
      coins_earned: coins
    });
  }

  // Exactly one order, and it holds a single file: the ordinary path.
  const job = orderJobs[0];

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

  const res = await confirmJobPaid(job, 'tng_detected', ref || ('DET-' + job.job_id));
  if (!res.ok) return err(res.error, 500);

  return json({
    success: true,
    matched: true,
    job_id: job.job_id,
    amount,
    coins_earned: res.coinsEarned,
    matched_by: 'amount'
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

  // A multi-file upload sends its ids comma-joined ("PRN-A,PRN-B"). This used
  // to build 'eq.' + jobId, so PostgREST compared that whole string against a
  // single job_id column and matched nothing - every poll of a two-file order
  // 404'd and the payment screen never advanced, even once the money landed.
  const ids = String(jobId).split(',').map(function (s) { return s.trim(); })
    .filter(Boolean);
  if (!ids.length) return err('Job ID required');

  const result = ids.length === 1
    ? await supabaseRequest('GET', '/print_jobs', null, {
      'job_id': 'eq.' + ids[0],
      'select': 'job_id,status,paid,payment_ref,total_price'
    })
    : await supabaseRequest('GET', '/print_jobs', null, {
      'job_id': 'in.(' + ids.join(',') + ')',
      'select': 'job_id,status,paid,payment_ref,total_price'
    });

  if (result.error || !result.data || result.data.length === 0) {
    return err('Print job not found', 404);
  }

  // Report the whole order, not just the first row. The order is settled when
  // every file is paid, so the client can stop polling.
  const rows = result.data;
  const allPaid = rows.length === ids.length && rows.every(function (r) { return r.paid === true; });
  const anyUnpaid = rows.some(function (r) { return r.paid !== true; });

  return json({
    success: true,
    job: rows[0],
    jobs: rows,
    total_jobs: ids.length,
    paid_count: rows.filter(function (r) { return r.paid === true; }).length,
    // true only when every file in the order is settled.
    all_paid: allPaid,
    pending: anyUnpaid
  });
}

module.exports.confirmJobPaid = confirmJobPaid;
// Exported so the admin dashboard can confirm a parked (ambiguous) payment
// without duplicating the coins/job/settlement logic.
// ---------------------------------------------------------------------------
// Matching an order
//
// A payment settles ONE order. An order is the set of files sharing an order_id,
// and the amount the customer pays is that order's order_total, computed and
// stored by upload.js at seal time.
//
// Matching used to compare the amount against a single job's total_price, which
// meant a two-file order of RM0.41 + RM1.11 = RM1.52 matched nothing and the
// customer paid without receiving a PIN. A subset search was added as a
// workaround and then removed: session_id is generated fresh per job so a
// guest's files were never grouped, it needed a 5-file cap to bound the
// combinatorics, and two different combinations can sum to the same amount,
// which is unresolvable without guessing.
//
// With order_id this is an equality test - no search, no ambiguity, no cap, and
// identical behaviour for guests and members.
//
// Jobs with no order_id predate this and are treated as single-file orders of
// their own, so existing single-file payments keep matching with no backfill.
//
// Whole-order payment only: a partial amount simply does not equal order_total,
// so it never matches and the order stays pending. That is intentional.
function orderKeyOf(j) {
  return j.order_id ? 'o:' + j.order_id : 'j:' + j.job_id;
}

function orderAmountOf(jobs) {
  // order_total is authoritative once sealed. Fall back to the job total for
  // legacy unsealed rows.
  const sealed = jobs.map(j => parseFloat(j.order_total))
    .filter(v => !Number.isNaN(v) && v !== null);
  if (sealed.length === jobs.length && sealed.length) {
    return sealed[0];
  }
  return jobs.reduce(function (s, j) { return s + (parseFloat(j.total_price) || 0); }, 0);
}
