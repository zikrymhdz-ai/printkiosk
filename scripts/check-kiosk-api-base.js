// Guards the kiosk's link to its backend, and its refusal to navigate anywhere.
//
// Two failures this exists to prevent:
//
// 1. PRINTKIOSK_API_BASE shipped without "https://". Every kiosk call then
//    resolved to a path relative to the page -
//      http://localhost:8000/kiosk/printkioskfyp.netlify.app/.netlify/...
//    - which 404s against the Pi's static server. The kiosk looked healthy while
//    having no printer status (the toner panel just read "Not reported"), no
//    admin settings and no heartbeat at all.
//
// 2. The header site address was an <a target="_blank">. On a locked-down shop
//    screen a tap opened a browser on top of kiosk mode, which the customer
//    could not close.
//
// Run: node scripts/check-kiosk-api-base.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

const kiosk = read('kiosk/walkin.html');
const config = read('frontend_config.js');

// --- the API base must be absolute -----------------------------------------
const baseLine = kiosk.match(/PRINTKIOSK_API_BASE = '([^']*)'/) || [];
ok(baseLine.length > 0, 'the kiosk sets a remote API base');
ok(/^https:\/\/[a-z0-9.-]+$/i.test(baseLine[1] || ''),
  'it is an absolute https URL (got "' + (baseLine[1] || '') + '")');
ok(!/'\.?\/?\.netlify\.app/.test(baseLine[1] || '') ||
   /^https:\/\//i.test(baseLine[1] || ''),
  'it never resolves to a relative path');

// The config repairs a scheme-less base instead of trusting it.
ok(/if \(!window\.PRINTKIOSK_API_BASE\)/.test(kiosk),
  'the base is set on every host, not only when the page thinks it is a Pi');
ok(/function normaliseRemoteBase/.test(config), 'frontend_config normalises the base');
ok(/if \(\/\^https\?:\\\/\\\/\/i\.test\(base\)\) return base;/.test(config),
  'an absolute base is left alone');
ok(/return 'https:\/\/' \+ base/.test(config),
  'a scheme-less base is given https:// rather than silently becoming relative');
ok(/REMOTE_API_BASE: normaliseRemoteBase\(/.test(config),
  'the normaliser is what REMOTE_API_BASE is built from');

// --- the shop screen must not navigate anywhere ----------------------------
const header = (kiosk.match(/<header class="kiosk-header">[\s\S]*?<\/header>/) || [''])[0];
ok(header.length > 0, 'the kiosk header is present');
ok(!/<a\s[^>]*href=/i.test(header), 'the kiosk header contains no links');
ok(/<span class="kh-site">printkioskfyp\.netlify\.app<\/span>/.test(header),
  'the site address is plain text');
ok(/\.kh-site\s*\{[^}]*pointer-events:\s*none/.test(kiosk),
  'even if it became a link again it could not be tapped');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('\nkiosk API base + header checks passed.');
