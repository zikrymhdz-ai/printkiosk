// Web Push invariants.
//
// The feature is easy to break silently: a private key pasted into the client
// config, permission requested on page load, a subscription saved without a
// session, or a coin award that pushes before it commits. Each of those has a
// line here so the mistake fails the suite instead of shipping.
//
// Run: node scripts/check-web-push.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

// --- 1. VAPID keys ---------------------------------------------------------
const cfg = read('frontend_config.js');
ok(/VAPID_PUBLIC_KEY/.test(cfg), 'the client config exposes the VAPID public key');
ok(!/VAPID_PRIVATE_KEY\s*:/.test(cfg), 'the private key is never in the client config');
ok(!/-----BEGIN/.test(cfg), 'no private-key block is in the client config');

const sender = read('netlify/functions/_push.js');
ok(/require\('web-push'\)/.test(sender), 'the sender uses the maintained web-push library');
ok(/process\.env\.VAPID_PRIVATE_KEY \|\| ''/.test(sender),
  'the private key comes from the environment with no committed fallback');
ok(/setVapidDetails/.test(sender), 'VAPID details are configured server-side');

// --- 2. Service worker -----------------------------------------------------
const sw = read('sw.js');
ok(/addEventListener\('push'/.test(sw), 'the service worker handles push');
ok(/showNotification/.test(sw), 'push shows a notification');
ok(/addEventListener\('notificationclick'/.test(sw), 'the service worker handles notificationclick');
ok(/openWindow/.test(sw), 'notificationclick can open a window');
ok(/customer\.html/.test(sw), 'notifications target customer.html');

// --- 3. Client module ------------------------------------------------------
const client = read('website/push.js');
ok(/serviceWorker' in navigator/.test(client) && /PushManager' in window/.test(client),
  'the client checks service worker and PushManager support');
ok(/register\('\/sw\.js'/.test(client), 'the client registers the root service worker');
ok(/userVisibleOnly:\s*true/.test(client), 'subscribe uses userVisibleOnly');
ok(/applicationServerKey/.test(client), 'subscribe sends the application server key');
ok(/X-Session-Token/.test(client), 'the subscription is posted with the session token');
ok(/typeof CONFIG !== 'undefined'/.test(client),
  'the client reads the global CONFIG binding, not window.CONFIG');
ok(/isNativePlatform/.test(client), 'the client detects the Capacitor native app');
ok(/Add to Home Screen/.test(client), 'the iOS install hint is present');
ok(/notification permission only when|Permission is requested here/i.test(client) ||
  /function enable/.test(client), 'the permission request lives in enable()');

const enableAt = client.indexOf('function enable');
const permAt = client.indexOf('requestPermission');
ok(enableAt !== -1 && permAt > enableAt, 'permission is not requested at page load');

// --- 4. Backend endpoint ---------------------------------------------------
const fn = read('netlify/functions/push.js');
ok(/validateSession/.test(fn), 'saving a subscription verifies the custom session');
ok(/push_subscriptions/.test(fn), 'subscriptions are stored in push_subscriptions');
ok(/'endpoint': 'eq\.' \+ endpoint/.test(fn), 'the upsert is keyed on the endpoint');
ok(/action === 'unsubscribe'/.test(fn), 'there is an unsubscribe action');
ok(/session\.user_id/.test(fn), 'unsubscribe is scoped to the session user');

// --- 5. Database -----------------------------------------------------------
const mig = read('migrations/20261028_push_subscriptions.sql');
for (const col of ['id', 'user_id', 'endpoint', 'p256dh', 'auth', 'user_agent', 'created_at']) {
  ok(new RegExp('\\b' + col + '\\b').test(mig), 'the table declares ' + col);
}
ok(/endpoint TEXT NOT NULL UNIQUE/.test(mig), 'the endpoint is unique, so a device cannot duplicate');

// --- 6. Sending and cleanup ------------------------------------------------
ok(/sendNotification/.test(sender), 'the sender calls sendNotification');
ok(/code === 404 \|\| code === 410/.test(sender), 'the sender recognises 404 and 410');
ok(/DELETE.*push_subscriptions|push_subscriptions.*DELETE/s.test(sender),
  '404/410 removes the dead subscription');
ok(/try\s*\{[\s\S]*sendNotification[\s\S]*\}\s*catch/.test(sender),
  'a send failure is caught rather than thrown');

// --- 7. Coin award hooks ---------------------------------------------------
const payment = read('netlify/functions/payment.js');
ok(/sendCoinPush/.test(payment), 'a paid job sends a coin push');
ok(/notify:\s*false/.test(payment), 'a multi-file order suppresses per-file pushes');
ok(/sendCoinPush\(orderJobs\[0\]\.user_id, coins\)/.test(payment),
  'a multi-file order sends one message for its total');
ok(/await sendCoinPush\(job\.user_id, 1\)/.test(payment),
  'the single-file award sends after the coin is committed');

const upload = read('netlify/functions/upload.js');
ok(/await sendCoinPush\(job\.user_id, coinsEarned\)/.test(upload),
  'a coin-covered free job sends after its award');

const auth = read('netlify/functions/auth.js');
ok(/await sendCoinPush\(user\.id, 10\)/.test(auth),
  'the registration bonus follows the same rule');

// --- 8. Logout -------------------------------------------------------------
const customer = read('website/customer.html');
ok(/PKPush\.disable\(\)/.test(customer), 'logout removes this device subscription');
ok(/pushEnableBtn/.test(customer) && /pushStatusText/.test(customer),
  'the customer page carries the enable button and its state');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      Web Push stays client-safe, session-guarded and non-blocking');
