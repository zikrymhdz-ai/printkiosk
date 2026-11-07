// The customer's Transactions page must show BOTH halves of the story: coins
// (earned / spent / bonus) and the money paid for prints. They live in two
// tables, and the original history endpoint only read coin_transactions.
//
// Run: node scripts/check-transactions.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

const coins = read('netlify/functions/coins.js');
const page = read('website/customer.html');

ok(/case 'transactions': return getTransactions\(userId\)/.test(coins),
  'the coins function exposes a transactions action');
ok(/\/coin_transactions/.test(coins) && /\/payments/.test(coins),
  'it reads both coin_transactions and payments');
ok(/kind: 'coin'/.test(coins) && /kind: 'money'/.test(coins),
  'it normalises both into one list');
ok(/sort\(function \(a, b\)/.test(coins),
  'the merged list is sorted by time');

// Exercise the real function with stubbed Supabase responses.
const body = (coins.match(/async function getTransactions[\s\S]*?\n\}/) || [])[0];
ok(!!body, 'getTransactions body found');

if (body) {
  const calls = [];
  async function fakeSupabase(method, endpoint, data, params) {
    calls.push(endpoint);
    if (endpoint === '/coin_transactions') {
      return { error: false, data: [
        { id: 'c1', type: 'earned', amount: 1, description: 'Print job PRN-20261103-A1B2', balance_after: 5, created_at: '2026-11-03T10:00:00Z' },
        { id: 'c2', type: 'spent', amount: 10, description: 'Redeemed RM 0.10', balance_after: 4, created_at: '2026-11-03T09:00:00Z' }
      ] };
    }
    if (endpoint === '/payments') {
      return { error: false, data: [
        { id: 'p1', amount: '1.30', method: 'tng_detected', reference: 'DET-PRN-20261103-9999', status: 'confirmed', created_at: '2026-11-03T10:05:00Z' },
        { id: 'p2', amount: '0.00', method: 'coins_full', reference: 'FREE-A', status: 'confirmed', created_at: '2026-11-03T08:00:00Z' }
      ] };
    }
    return { error: true, data: [] };
  }
  let result = null;
  function fakeJson(payload) { result = payload; return payload; }

  const fn = new Function('supabaseRequest', 'json', body + '\nreturn getTransactions;')(fakeSupabase, fakeJson);

  (async () => {
    await fn('user-1');
    ok(calls.indexOf('/coin_transactions') !== -1 && calls.indexOf('/payments') !== -1,
      'both tables are queried');
    const rows = result && result.transactions;
    ok(Array.isArray(rows) && rows.length === 4, 'all four rows are returned, got ' + (rows && rows.length));
    ok(rows && rows[0].kind === 'money' && rows[0].amount === 1.3,
      'the newest money payment comes first, sorted by time');
    ok(rows && rows[0].job_id === 'PRN-20261103-9999',
      'the payment carries the job id parsed from its reference');
    ok(rows && rows[1].kind === 'coin' && rows[1].type === 'earned',
      'the coin row keeps its type');
    ok(rows && rows[1].job_id === 'PRN-20261103-A1B2',
      'the coin row carries the job id parsed from its description');
    const free = rows && rows.find(r => r.id === 'pay-p2');
    ok(free && /Fully paid with coins/.test(free.description),
      'a zero-value coin-covered payment is labelled, not shown as a mystery RM0');
    ok(free && free.amount === 0, 'and its amount stays 0');

    // --- the page side -----------------------------------------------------
    ok(/data-page="coins"[^>]*>\s*<svg[\s\S]{0,400}?Transactions\s*<\/div>/.test(page),
      'the desktop nav says Transactions');
    ok(/API\('coins', 'transactions'\)/.test(page),
      'the page requests the merged transactions action');
    ok(/t\.kind === 'money'/.test(page), 'the list renders money rows');
    ok(/class="tx-row"/.test(page) && /tx-title/.test(page) && /tx-meta/.test(page),
      'rows show a bold title with a small date underneath');
    ok(/const spent = t\.type === 'spent'/.test(page) && /spent \? '-' : '\+'/.test(page),
      'coin spending is negative and earning is positive');
    ok(/data-filter="coin"/.test(page) && /data-filter="money"/.test(page),
      'the page offers All / Coins / Payments filters');
    ok(/function setTransactionFilter/.test(page) && /function renderTransactions/.test(page),
      'the filter is wired to the rows');
    ok(/@keyframes txSwap/.test(page) && /tx-swap/.test(page),
      'switching filters animates the list');

    if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
    console.log('  ok      Transactions show coins and money in one list');
  })();
} else {
  process.exit(1);
}
