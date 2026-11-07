const CONFIG = {
  SUPABASE_URL: 'https://ninsrrallzwmkqyosqeu.supabase.co',
  SUPABASE_KEY: 'sb_publishable_Xqvr6eqcgIxQD8ZYGHSetw_YeIly-oO',
  BASE_URL: window.location.origin,
  // Web Push VAPID PUBLIC key. Generate a pair once with:
  //   npx web-push generate-vapid-keys
  // Paste the public key below. The private key is server-side only
  // (Netlify env VAPID_PRIVATE_KEY) and must never appear in this file.
  VAPID_PUBLIC_KEY: 'BE6VMmwreR9iicbrWqjmVVd7NuNdi5LarXS1qjWlwXGYy8z7wbFsFs0XhKx7dXMjtgjWdwb6rSWFo1QGDkAxXJA',
  // Set window.PRINTKIOSK_API_BASE before this file loads to proxy every API call
  // to a remote Netlify deployment. The Raspberry Pi kiosk is served from
  // localhost, so it has neither Netlify functions nor PHP to talk to.
  //
  // A missing scheme is repaired rather than trusted: a base without "https://"
  // turns every call into a path relative to the kiosk page, which 404s against
  // the local static server. That is exactly how the kiosk ended up showing no
  // toner levels, no admin settings and no heartbeat while the page looked fine.
  REMOTE_API_BASE: normaliseRemoteBase(
    (typeof window.PRINTKIOSK_API_BASE === 'string' ? window.PRINTKIOSK_API_BASE : '')
  )
};

function normaliseRemoteBase(raw) {
  const base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/^https?:\/\//i.test(base)) return base;
  return 'https://' + base.replace(/^\/+/, '');
}

// True when this page proxies API calls to a Netlify deployment it is not served from.
const IS_REMOTE_API = CONFIG.REMOTE_API_BASE !== '';

const IS_NETLIFY = IS_REMOTE_API
  || window.location.hostname.includes('netlify.app')
  || window.location.hostname.includes('netlify');

function API(fn, action) {
  if (IS_NETLIFY) {
    let url = (IS_REMOTE_API ? CONFIG.REMOTE_API_BASE : CONFIG.BASE_URL) + '/.netlify/functions/' + fn;
    if (action) url += '?action=' + action;
    return url;
  } else {
    const phpMap = { auth: 'auth.php', upload: 'upload_handler.php', payment: 'payment_handler.php', coins: 'coins_api.php', data: 'data_api.php', admin: 'admin_api.php', printer: 'printer_api.php' };
    const php = phpMap[fn] || fn + '.php';
    let url = '../' + php;
    if (action) url += '?action=' + action;
    return url;
  }
}

// The upload QR is scanned with the customer's own phone, so it must always point at
// the public site and never at a kiosk that happens to be running on localhost.
const QR_SITE_BASE = IS_REMOTE_API
  ? CONFIG.REMOTE_API_BASE
  : (IS_NETLIFY ? CONFIG.BASE_URL : 'https://printkioskfyp.netlify.app');

if ('serviceWorker' in navigator && IS_NETLIFY && window.location.protocol.startsWith('https')) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').catch(function() {});
  });
}

// Pinch-zoom lock for the kiosk and the installed PWA.
//
// The viewport meta covers Android and the installed PWA. iOS Safari ignores
// user-scalable=no, so its gesture events and multi-touch moves are blocked as
// well. Panning and scrolling still work; only the two-finger zoom is removed.
(function () {
  function blockMultiTouch(e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }
  document.addEventListener('touchmove', blockMultiTouch, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('gesturechange', function (e) { e.preventDefault(); });
  document.addEventListener('gestureend', function (e) { e.preventDefault(); });
  window.addEventListener('wheel', function (e) {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
})();