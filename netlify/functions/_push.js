// Web Push sender for coin awards.
//
// The award logic runs in Netlify Functions (Node), so the maintained Node
// library `web-push` is the match here - not pywebpush (no Flask in this app)
// and not a Supabase Edge Function (coins are not awarded in the database).
//
// Sending MUST never break the award: every path below is wrapped, and a
// missing library, missing VAPID env or a dead endpoint only logs. The award
// has already been committed before this is called.
const { supabaseRequest } = require('./_shared');

// web-push is loaded lazily so a missing dependency cannot stop the payment
// function from loading at all. A push is a bonus, not part of settling money.
let webpush = null;
let configured = false;

function lib() {
  if (webpush) return webpush;
  try { webpush = require('web-push'); } catch (e) { webpush = null; }
  return webpush;
}

function configure() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || 'mailto:noreply@printkiosk.local';
  if (!pub || !priv) return false;
  const wp = lib();
  if (!wp) return false;
  try {
    wp.setVapidDetails(subject, pub, priv);
    configured = true;
    return true;
  } catch (e) {
    console.error('[push] VAPID configuration failed:', e && e.message);
    return false;
  }
}

function pdfMessage(amount) {
  const n = Math.max(1, parseInt(amount, 10) || 1);
  return {
    title: 'You received ' + n + ' Coin' + (n === 1 ? '' : 's'),
    body: 'Thanks for printing with PrintKiosk. Open your jobs to see your balance.',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    data: { url: '/website/customer.html' }
  };
}

// Send to every device this user has registered. Returns { sent } and never
// rejects.
async function sendCoinPush(userId, amount) {
  try {
    if (!userId) return { sent: 0 };
    const n = parseInt(amount, 10) || 0;
    if (n <= 0) return { sent: 0 };
    if (!configure()) {
      // No VAPID env: the feature is simply off. Do not log the keys.
      return { sent: 0, skipped: 'vapid_not_configured' };
    }

    const rows = await supabaseRequest('GET', '/push_subscriptions', null, {
      'user_id': 'eq.' + userId,
      'select': 'id,endpoint,p256dh,auth',
      'limit': '50'
    });
    if (rows.error || !Array.isArray(rows.data) || !rows.data.length) {
      return { sent: 0 };
    }

    const wp = lib();
    const payload = JSON.stringify(pdfMessage(n));
    let sent = 0;
    let gone = 0;

    await Promise.all(rows.data.map(async function (s) {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth }
      };
      try {
        // Bounded so a slow push service cannot hold the payment response.
        await wp.sendNotification(subscription, payload, { timeout: 5000 });
        sent++;
      } catch (e) {
        const code = e && (e.statusCode || e.status);
        // 404/410 mean the browser dropped this subscription for good.
        if (code === 404 || code === 410) {
          gone++;
          await supabaseRequest('DELETE', '/push_subscriptions', null, { 'id': 'eq.' + s.id });
        } else {
          console.error('[push] send failed for subscription ' + s.id + ':', code || '', e && e.message);
        }
      }
    }));

    return { sent: sent, removed: gone };
  } catch (e) {
    console.error('[push] coin notification failed:', e && e.message);
    return { sent: 0, error: true };
  }
}

module.exports = { sendCoinPush };
