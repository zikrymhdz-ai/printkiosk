const { json, err, supabaseRequest, validateSession } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  const session = await validateSession(event);
  if (!session) return err('Unauthorized', 401);

  const userId = session.user_id;
  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  if (event.httpMethod === 'GET') {
    switch (action) {
      case 'balance': return getBalance(userId);
      case 'history': return getHistory(userId);
      case 'transactions': return getTransactions(userId);
      case 'discount': return getDiscount(userId);
      default: return err('Invalid action');
    }
  } else if (event.httpMethod === 'POST') {
    switch (action) {
      case 'redeem': return redeemCoins(userId, event);
      default: return err('Invalid action');
    }
  }

  return err('Method not allowed', 405);
};

async function getBalance(userId) {
  const result = await supabaseRequest('GET', '/users', null, {
    'id': 'eq.' + userId,
    'select': 'coins'
  });

  if (result.error || !result.data || result.data.length === 0) {
    return err('Failed to get balance', 500);
  }

  const coins = result.data[0].coins;
  const discountValue = Math.round(coins * 0.01 * 100) / 100;

  return json({
    success: true,
    coins,
    discount_rm: discountValue,
    can_redeem: coins >= 10
  });
}

async function getHistory(userId) {
  const result = await supabaseRequest('GET', '/coin_transactions', null, {
    'user_id': 'eq.' + userId,
    'select': '*',
    'order': 'created_at.desc',
    'limit': '50'
  });

  return json({
    success: true,
    transactions: result.error ? [] : result.data
  });
}

// One history for the customer: coins earned/spent/bonus AND the money they
// paid for prints. These live in two tables, so the page used to show only half
// the story - a customer could see "earned 1 coin" but not the RM1.30 payment
// that earned it. The two lists are normalised here so the page renders one
// table sorted by time.
async function getTransactions(userId) {
  const jobIdFrom = function (text) {
    const m = String(text || '').match(/PRN-\d{8}-[A-F0-9]{4}/);
    return m ? m[0] : null;
  };

  const [coinRes, payRes] = await Promise.all([
    supabaseRequest('GET', '/coin_transactions', null, {
      'user_id': 'eq.' + userId,
      'select': 'id,type,amount,description,balance_after,created_at',
      'order': 'created_at.desc',
      'limit': '200'
    }),
    supabaseRequest('GET', '/payments', null, {
      'user_id': 'eq.' + userId,
      'select': 'id,amount,method,reference,status,created_at',
      'order': 'created_at.desc',
      'limit': '200'
    })
  ]);

  const coins = (coinRes.error ? [] : (coinRes.data || [])).map(function (t) {
    return {
      id: 'coin-' + t.id,
      kind: 'coin',
      type: t.type,
      amount: parseInt(t.amount, 10) || 0,
      job_id: jobIdFrom(t.description),
      description: t.description || '',
      balance_after: t.balance_after,
      reference: null,
      status: null,
      created_at: t.created_at
    };
  });

  const payments = (payRes.error ? [] : (payRes.data || [])).map(function (p) {
    const amount = Math.round((parseFloat(p.amount) || 0) * 100) / 100;
    let label = 'Print payment';
    if (p.method === 'coins_full' || amount === 0) label = 'Fully paid with coins';
    else if (p.method === 'manual_admin') label = 'Payment (staff)';
    return {
      id: 'pay-' + p.id,
      kind: 'money',
      type: 'payment',
      amount: amount,
      job_id: jobIdFrom(p.reference),
      description: label + (p.reference ? ' - ' + p.reference : ''),
      balance_after: null,
      reference: p.reference || null,
      status: p.status || null,
      created_at: p.created_at
    };
  });

  const all = coins.concat(payments).sort(function (a, b) {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return json({ success: true, transactions: all });
}

async function getDiscount(userId) {
  const result = await supabaseRequest('GET', '/users', null, {
    'id': 'eq.' + userId,
    'select': 'coins'
  });

  if (result.error || !result.data || result.data.length === 0) {
    return json({ success: true, can_redeem: false, coins: 0, max_discount: 0 });
  }

  const coins = result.data[0].coins;
  return json({
    success: true,
    can_redeem: coins >= 10,
    coins,
    max_discount: Math.floor(coins / 10) * 0.1
  });
}

async function redeemCoins(userId, event) {
  const body = JSON.parse(event.body || '{}');
  const jobId = body.job_id || '';
  const redeemAmount = Math.round((parseFloat(body.amount) || 0) * 100) / 100;
  const coinsNeeded = Math.round(redeemAmount * 100);

  if (!jobId || redeemAmount <= 0) return err('Job ID and redeem amount required');

  if (coinsNeeded < 10 || coinsNeeded % 10 !== 0) {
    return err('Redeem amount must be in RM 0.10 steps (minimum 10 coins)');
  }

  const userResult = await supabaseRequest('GET', '/users', null, {
    'id': 'eq.' + userId,
    'select': 'coins'
  });

  if (userResult.error || !userResult.data || userResult.data.length === 0) {
    return err('Failed to get user data', 500);
  }

  const currentCoins = userResult.data[0].coins;

  if (currentCoins < coinsNeeded) return err('Insufficient coins', 400);

  const jobResult = await supabaseRequest('GET', '/print_jobs', null, {
    'job_id': 'eq.' + jobId,
    'select': '*'
  });

  if (jobResult.error || !jobResult.data || jobResult.data.length === 0) {
    return err('Print job not found', 404);
  }

const job = jobResult.data[0];

  // The match fee (a few sen that makes this job's amount unique) must survive a
  // coin discount - otherwise two jobs could collapse back onto the same amount.
  const storedBase = parseFloat(job.base_price);
  const storedFee = parseFloat(job.match_fee);
  const basePrice = Number.isFinite(storedBase) ? storedBase : parseFloat(job.total_price);
  const matchFee = Number.isFinite(storedFee) ? storedFee : 0;

  const newBase = Math.max(0, basePrice - redeemAmount);
  const newCoins = currentCoins - coinsNeeded;

  // Fully covered by coins -> total is RM0.00, so drop the fee and confirm straight away.
  const fullyCovered = newBase <= 0;
  const newFee = fullyCovered ? 0 : matchFee;
  const newPrice = Math.round((newBase + newFee) * 100) / 100;

  const patch = { total_price: newPrice, updated_at: new Date().toISOString() };
  const extendedPatch = Object.assign({}, patch, { base_price: newBase, match_fee: newFee });

  let patchResult = await supabaseRequest('PATCH', '/print_jobs?id=eq.' + job.id, extendedPatch);
  if (patchResult.error) {
    patchResult = await supabaseRequest('PATCH', '/print_jobs?id=eq.' + job.id, patch);
    if (patchResult.error) return err('Failed to update job price', 500);
  }

  if (fullyCovered) {
    await autoConfirmFreeJob(job);
  }

  await supabaseRequest('PATCH', '/users?id=eq.' + userId, { coins: newCoins });

  await supabaseRequest('POST', '/coin_transactions', {
    user_id: userId,
    print_job_id: job.id,
    type: 'spent',
    amount: coinsNeeded,
    description: 'Redeemed RM ' + redeemAmount.toFixed(2) + ' discount for job ' + jobId,
    balance_after: newCoins
  });

  return json({
    success: true,
    message: fullyCovered ? 'Fully covered by coins - no payment needed' : 'Discount applied successfully',
    new_price: newPrice,
    base_price: newBase,
    match_fee: newFee,
    fully_covered: fullyCovered,
    coins_remaining: newCoins,
    coins_spent: coinsNeeded
  });
}

// Zero-value job: no QR scan required.
async function autoConfirmFreeJob(job) {
  if (job.paid) return;

  const reference = 'FREE-' + job.job_id;

  await supabaseRequest('POST', '/payments', {
    print_job_id: job.id,
    user_id: job.user_id,
    amount: 0,
    method: 'coins_full',
    reference,
    status: 'confirmed',
    notified_at: new Date().toISOString()
  });

  await supabaseRequest('PATCH', '/print_jobs?id=eq.' + job.id, {
    status: 'ready_to_print',
    paid: true,
    payment_ref: reference,
    updated_at: new Date().toISOString()
  });

  await supabaseRequest('POST', '/alerts', {
    type: 'payment_received',
    message: 'Print job ' + job.job_id + ' fully covered by coins - no payment required',
    severity: 'info',
    is_read: false
  });
}
