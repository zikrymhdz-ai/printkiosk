// Web Push client for PrintKiosk.
//
// No Firebase/FCM and no Supabase Auth: the subscription is posted with the
// same custom session_token the rest of the app uses. Nothing is stored
// client-side by this module; the token is read from the localStorage mirror
// that PKS (pstore.js) hydrates from @capacitor/preferences.
window.PKPush = (function () {
  // frontend_config.js declares CONFIG with `const`, which is a global lexical
  // binding, NOT a property of window. Reading window.CONFIG silently produced
  // an empty key and disabled the button on every supported browser.
  var VAPID = (typeof CONFIG !== 'undefined' && CONFIG.VAPID_PUBLIC_KEY) || '';
  var registered = null;
  var ui = {};

  function token() {
    try { return localStorage.getItem('session_token') || ''; } catch (e) { return ''; }
  }

  function apiUrl(action) {
    if (typeof API === 'function') return API('push', action);
    return '/.netlify/functions/push?action=' + action;
  }

  function isNative() {
    return !!(window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform());
  }

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function supports() {
    return ('serviceWorker' in navigator) &&
      ('PushManager' in window) &&
      ('Notification' in window);
  }

  // base64url -> Uint8Array, which is what applicationServerKey expects.
  function keyBytes(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function post(action, payload) {
    var t = token();
    if (!t) return Promise.reject(new Error('Please sign in first.'));
    return fetch(apiUrl(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': t },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.text().then(function (raw) {
        var d = null;
        try { d = JSON.parse(raw); } catch (e) { d = null; }
        if (!r.ok || !d || !d.success) {
          throw new Error((d && d.error) || ('Request failed (HTTP ' + r.status + ')'));
        }
        return d;
      });
    });
  }

  function paint(state, text) {
    if (ui.card) ui.card.style.display = '';
    if (ui.status) ui.status.textContent = text || '';
    if (!ui.btn) return;
    if (state === 'ready') {
      ui.btn.style.display = '';
      ui.btn.disabled = false;
      ui.btn.textContent = 'Enable notifications';
    } else {
      // enabled / blocked / unsupported / native / ios-hint / unconfigured
      ui.btn.style.display = 'none';
    }
  }

  function register() {
    if (registered) return Promise.resolve(registered);
    return navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
      registered = reg;
      return navigator.serviceWorker.ready.then(function () { return reg; });
    });
  }

  function refresh() {
    if (isNative()) {
      paint('native', 'Notifications work in the web version only. Open printkioskfyp.netlify.app in Chrome on this phone to enable them.');
      return Promise.resolve('native');
    }
    if (typeof IS_NETLIFY !== 'undefined' && !IS_NETLIFY) {
      paint('unconfigured', 'Notifications are available on the deployed site.');
      return Promise.resolve('local');
    }
    if (isIOS() && !isStandalone()) {
      paint('ios-hint', 'On iPhone or iPad, tap Share then Add to Home Screen. Open the PrintKiosk icon and enable notifications there (iOS 16.4 or newer).');
      return Promise.resolve('ios-hint');
    }
    if (!supports()) {
      paint('unsupported', 'This browser does not support notifications.');
      return Promise.resolve('unsupported');
    }
    if (!VAPID) {
      paint('unconfigured', 'Notifications are not set up yet.');
      return Promise.resolve('unconfigured');
    }
    if (Notification.permission === 'denied') {
      paint('blocked', 'Notifications are blocked. Allow them for this site in your browser settings.');
      return Promise.resolve('blocked');
    }

    return register().then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (sub && Notification.permission === 'granted') {
        // Keep the server row fresh (keys can rotate). A failure here must not
        // change the local state - the device really is subscribed.
        post('subscribe', { subscription: sub.toJSON(), user_agent: navigator.userAgent })
          .catch(function () {});
        paint('enabled', 'Notifications are enabled on this device.');
        return 'enabled';
      }
      paint('ready', 'Get a notification when you earn coins, even when this page is closed.');
      return 'ready';
    }).catch(function () {
      paint('ready', 'Get a notification when you earn coins, even when this page is closed.');
      return 'ready';
    });
  }

  function enable() {
    // Permission is requested here, from the tap, and nowhere else. iOS refuses
    // a request that is not tied to a user gesture, and a page-load prompt is
    // treated as spam on every platform.
    if (isNative() || !supports() || !VAPID) return refresh();

    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') {
        paint(perm === 'denied' ? 'blocked' : 'ready', perm === 'denied'
          ? 'Notifications are blocked. Allow them for this site in your browser settings.'
          : 'Notifications were not enabled.');
        return perm;
      }

      return register().then(function (reg) {
        return reg.pushManager.getSubscription().then(function (existing) {
          if (existing) return existing;
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(VAPID)
          });
        });
      }).then(function (sub) {
        return post('subscribe', { subscription: sub.toJSON(), user_agent: navigator.userAgent });
      }).then(function () {
        paint('enabled', 'Notifications are enabled on this device.');
        return 'enabled';
      }).catch(function (e) {
        paint('ready', 'Could not enable notifications: ' + (e && e.message ? e.message : 'please try again.'));
        return 'error';
      });
    });
  }

  // Called from logout before the session token is discarded.
  function disable() {
    if (isNative() || !supports()) return Promise.resolve(false);
    return register().then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return false;
      var endpoint = sub.endpoint;
      var localOnly = function () { return sub.unsubscribe().catch(function () { return false; }); };
      if (!token()) return localOnly();
      return post('unsubscribe', { endpoint: endpoint })
        .catch(function () {})
        .then(localOnly);
    }).catch(function () { return false; });
  }

  function init() {
    ui.card = document.getElementById('pushCard');
    ui.btn = document.getElementById('pushEnableBtn');
    ui.status = document.getElementById('pushStatusText');
    if (!ui.card || !ui.btn) return;
    ui.btn.addEventListener('click', function () { enable(); });
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    init: init,
    enable: enable,
    disable: disable,
    refresh: refresh,
    isNative: isNative,
    supported: supports
  };
})();
