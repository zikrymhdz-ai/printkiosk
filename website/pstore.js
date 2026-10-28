window.PKS = (function() {
  // Capacitor 3+ exposes plugins on window.Capacitor.Plugins, not directly on
  // window.Capacitor. The old check looked at window.Capacitor.Preferences,
  // which is always undefined - so nothing was ever written to Preferences and
  // a native install silently kept only the WebView's localStorage.
  var cap = window.Capacitor || {};
  var prefs = (typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()
    && cap.Plugins && cap.Plugins.Preferences)
    ? cap.Plugins.Preferences
    : null;
  var mem = null;
  var hydrating = false;
  var loadPromise = null;

  // Only the session may leave localStorage. remembered_login contains a
  // plaintext password, so it must never be copied into Preferences; keeping it
  // in localStorage means it is gone as soon as the WebView's storage is reset.
  // The filter also runs on load, which drops anything an earlier build wrote.
  var PERSIST_KEYS = { session_token: true, user: true };

  function persistedOnly(obj) {
    var out = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && PERSIST_KEYS[k]) out[k] = obj[k];
    }
    return out;
  }

  function load() {
    if (mem) return Promise.resolve(mem);
    if (hydrating) return loadPromise;
    if (!prefs) { mem = {}; return Promise.resolve(mem); }
    hydrating = true;
    loadPromise = prefs.get({ key: 'pk_store' }).then(function(r) {
      var saved = {};
      try { if (r && r.value) saved = JSON.parse(r.value) || {}; } catch (e) { saved = {}; }
      mem = persistedOnly(saved);
      // If the stored blob held a key outside the allowlist, rewrite it so the
      // password does not sit in Preferences waiting to be read again.
      if (Object.keys(mem).length !== Object.keys(saved).length) {
        prefs.set({ key: 'pk_store', value: JSON.stringify(mem) }).catch(function() {});
      }
      return mem;
    }).catch(function() { mem = {}; return mem; });
    return loadPromise;
  }

  function flush() {
    if (!prefs || !mem) return;
    prefs.set({ key: 'pk_store', value: JSON.stringify(mem) }).catch(function() {});
  }

  return {
    isNative: !!prefs,
    init: function() {
      return load().then(function(m) {
        for (var k in m) {
          try { localStorage.setItem(k, m[k]); } catch (e) {}
        }
        return m;
      });
    },
    set: function(key, val) {
      try { localStorage.setItem(key, val); } catch (e) {}
      if (prefs && PERSIST_KEYS[key]) {
        load().then(function(m) {
          m[key] = val;
          flush();
        });
      }
    },
    remove: function(key) {
      try { localStorage.removeItem(key); } catch (e) {}
      if (prefs && PERSIST_KEYS[key]) {
        load().then(function(m) {
          delete m[key];
          flush();
        });
      }
    },
    clear: function() {
      try { localStorage.clear(); } catch (e) {}
      if (prefs) {
        load().then(function(m) {
          mem = {};
          prefs.remove({ key: 'pk_store' }).catch(function() {});
        });
      }
    }
  };
})();