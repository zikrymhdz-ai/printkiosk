const CACHE_NAME = 'printkiosk-v1';
const SHELL_CACHE = 'printkiosk-shell-v1';

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function(cache) {
      return cache.addAll([
        '/manifest.webmanifest',
        '/assets/apple-touch-icon.png',
        '/assets/icon-192.png',
        '/assets/icon-512.png',
        '/styles.css',
        '/frontend_config.js',
        '/website/splash.html',
        '/website/login.html'
      ]);
    }).catch(function() {})
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== SHELL_CACHE && k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request).then(function(res) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(function(cache) { cache.put(e.request, copy); });
          return res;
        });
      })
    );
    return;
  }

  e.respondWith(
    fetch(e.request).then(function(res) {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, copy); });
      }
      return res;
    }).catch(function() {
      return caches.match(e.request).then(function(cached) {
        return cached || caches.match('/website/login.html');
      });
    })
  );
});

// ---- Web Push -------------------------------------------------------------
// Web Push only: no Firebase and no FCM. The payload is written by the Netlify
// function in netlify/functions/_push.js.
self.addEventListener('push', function(e) {
  var payload = {};
  try {
    payload = e.data ? e.data.json() : {};
  } catch (err) {
    try { payload = { body: e.data.text() }; } catch (err2) { payload = {}; }
  }
  var extra = payload.data || {};
  var title = payload.title || 'PrintKiosk';
  var options = {
    body: payload.body || 'You received coins.',
    icon: payload.icon || '/assets/icon-192.png',
    badge: payload.badge || '/assets/icon-192.png',
    data: { url: extra.url || '/website/customer.html' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || '/website/customer.html';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      // Prefer a window already showing the destination.
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(target) !== -1 && 'focus' in list[i]) return list[i].focus();
      }
      // Otherwise reuse any open PrintKiosk page and navigate it.
      for (var j = 0; j < list.length; j++) {
        if (list[j].url.indexOf('/website/') !== -1 && 'focus' in list[j]) {
          if ('navigate' in list[j]) {
            return list[j].navigate(target).then(function(client) {
              return client && typeof client.focus === 'function' ? client.focus() : undefined;
            });
          }
          return list[j].focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});