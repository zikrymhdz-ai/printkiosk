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

  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

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
    'select': 'id,job_id,user_id,total_price,file_name,created_at,page_spec,pages,copies,color_mode',
    'created_at': 'gte.' + cutoff,
    'order': 'created_at.desc'
  });
  const jobs = jobsResult.error ? [] : (jobsResult.data || []);

  // AMOUNT IS PRIMARY. The unique match fee (0.00-0.09) makes each live job's
  // total distinct, so the amount is the strongest signal we have.
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

  let job = matches[0];
  let disambiguatedBy = 'amount';

  if (matches.length > 1) {
    // Rare: two live jobs share a total. The payer's name is only a tie-breaker,
    // never the primary key, because the name on a bank account very often
    // differs from the name on the account (nicknames, different ordering,
    // truncated, romanisation). If it cannot separate them, do NOT guess.
    await attachUserNames(matches);
    const payer = extractPayerName(rawText);
    if (payer) {
      const named = matches.filter(j => jobBelongsToName(j, payer));
      if (named.length === 1) {
        job = named[0];
        disambiguatedBy = 'amount+name';
      } else if (named.length > 1) {
        return await parkForReview(amount, amountRaw, payer, ref, rawText, named,
          'amount matched ' + named.length + ' jobs and the payer name matched all of them');
      }
    }

    if (disambiguatedBy === 'amount') {
      // Could not pick safely. Park it instead of confirming somebody's document
      // against somebody else's money.
      return await parkForReview(amount, amountRaw, payer, ref, rawText, matches,
        matches.length + ' pending jobs share RM ' + amount.toFixed(2) + ' and the payer name did not identify one');
    }
  }

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
    matched_by: disambiguatedBy
  });
}

// Fetch the account name for each candidate so the payer name can break a tie.
// Guest jobs have no user, so they can never be matched this way - by design,
// guests rely on the unique amount alone.
async function attachUserNames(jobs) {
  const ids = jobs.map(j => j.user_id).filter(Boolean);
  if (!ids.length) return;
  const result = await supabaseRequest('GET', '/users', null, {
    'id': 'in.(' + ids.join(',') + ')',
    'select': 'id,name',
    'limit': String(ids.length)
  });
  if (result.error || !result.data) return;
  const byId = {};
  for (const u of result.data) byId[u.id] = u.name;
  for (const j of jobs) j._userName = j.user_id ? byId[j.user_id] : null;
}

// "MUHAMMAD ZIKRY BIN MOHD H has transferred RM0.21 to you"
// Pull out the payer's name. Deliberately conservative: returns null rather than
// a wrong guess, because a bad name match is worse than no name match.
function extractPayerName(rawText) {
  if (!rawText) return null;
  const patterns = [
    /(.{2,60}?)\s+has transferred\s+RM/i,
    /from\s+(.{2,60}?)(?:\s+via|\s*$)/im,
    /by\s+(.{2,60}?)(?:\s+via|\s*$)/im
  ];
  for (const re of patterns) {
    const m = re.exec(rawText);
    if (!m) continue;
    let name = String(m[1]).trim()
      .replace(/^You've recieved money!\s*/i, '')
      .replace(/^You received money!\s*/i, '')
      .replace(/[!.,:;]\s*$/, '')
      .trim();
    // A real name, not another sentence.
    if (name.length >= 3 && name.length <= 60 && /[A-Za-z]{2}/.test(name) && !/\b(rm|money|received|payment)\b/i.test(name)) {
      return name;
    }
  }
  return null;
}

// Compare loosely on purpose: the customer signed up one way, the bank shows
// another. Case and spacing must not matter; we are only breaking a tie that the
// amount alone could not.
function jobBelongsToName(job, payerName) {
  if (!job.user_id || !payerName) return false;
  return job._userName ? sameName(job._userName, payerName) : false;
}

function sameName(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // One contained in the other covers truncation ("Muhammad Zikry" vs
  // "Muhammad Zikry Bin Mohd H") and reordered/middle-name variants.
  return na.includes(nb) || nb.includes(na);
}

// Park an ambiguous payment for a human instead of force-matching it.
async function parkForReview(amount, amountRaw, payerName, ref, rawText, candidates, reason) {
  const candidateJobs = candidates.map(c => ({
    id: c.id,
    job_id: c.job_id,
    total_price: c.total_price,
    pages: c.pages,
    copies: c.copies,
    color_mode: c.color_mode,
    file_name: c.file_name,
    created_at: c.created_at
  }));

  const inserted = await supabaseRequest('POST', '/payment_review_queue', {
    amount: amount,
    amount_raw: amountRaw,
    payer_name: payerName || '',
    reference: ref || '',
    raw_text: rawText || '',
    candidate_jobs: JSON.stringify(candidateJobs),
    reason: reason,
    status: 'pending'
  });

  await supabaseRequest('POST', '/alerts', {
    type: 'payment_received',
    // The admin review card is gone - Mark Paid on the Transactions table is the
    // single way staff settle a job. So the alert has to say what to do, otherwise
    // a parked payment becomes invisible and the customer is stuck at the kiosk.
    message: 'Payment RM ' + amount.toFixed(2) + ' could not be matched automatically ('
      + reason + '). Open Admin > Transactions, find the job, and click Mark Paid.'
      + (candidates.length ? ' Candidates: ' + candidates.map(c => c.job_id).join(', ') + '.' : ''),
    severity: 'warning',
    is_read: false
  });

  return json({
    success: false,
    matched: false,
    needs_review: true,
    reason: reason,
    amount: amount,
    candidates: inserted.error ? null : candidateJobs
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

// Exported so the admin dashboard can confirm a parked (ambiguous) payment
// without duplicating the coins/job/settlement logic.
module.exports.confirmJobPaid = confirmJobPaid;