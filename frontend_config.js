const CONFIG = {
  SUPABASE_URL: 'https://ninsrrallzwmkqyosqeu.supabase.co',
  SUPABASE_KEY: 'sb_publishable_Xqvr6eqcgIxQD8ZYGHSetw_YeIly-oO',
  BASE_URL: window.location.origin,
  // Set window.PRINTKIOSK_API_BASE before this file loads to proxy every API call
  // to a remote Netlify deployment. The Raspberry Pi kiosk is served from
  // localhost, so it has neither Netlify functions nor PHP to talk to.
  REMOTE_API_BASE: (typeof window.PRINTKIOSK_API_BASE === 'string' ? window.PRINTKIOSK_API_BASE : '').replace(/\/+$/, '')
};

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