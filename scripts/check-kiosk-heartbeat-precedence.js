// The admin page must read the KIOSK's status, not the diagnostic probe's.
//
// Three writers share kiosk_heartbeats:
//
//   kiosk-1      the real report, every 20 s, from the main inline script
//   kiosk-error  the diagnostic probe, every 20 s, from its own script block
//   canary       one row per page load
//
// getKioskStatus() took the newest row of ANY kiosk_id. The probe posts on its
// own 20 s clock, out of phase with the real report, so it won roughly half the
// time and admin announced "The screen is alive but has not sent a status
// update yet" while kiosk-1 was reporting perfectly. Seen live 2026-10-27, with
// a probe line that itself said main=RAN config=yes api=yes.
//
// Run: node scripts/check-kiosk-heartbeat-precedence.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const backend = read('netlify/functions/admin.js');
const adminHtml = read('admin/admin.html');
const walkin = read('kiosk/walkin.html');

let failed = false;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed = true;
};

const fn = backend.match(/async function getKioskStatus[\s\S]*?\n\}/);
ok(!!fn, 'getKioskStatus found');
const body = fn ? fn[0] : '';

// --- the real kiosk must be asked for BY NAME ------------------------------
ok(/'kiosk_id': 'eq\.' \+ KIOSK_ID/.test(body),
  'the status query is filtered to the real kiosk id');
ok(/'kiosk_id': 'in\.\(' \+ PROBE_IDS\.join/.test(body),
  'the probe rows are queried separately, not mixed in');

// The old shape: newest row of any id. If this comes back, the bug comes back.
ok(!/supabaseRequest\('GET', '\/kiosk_heartbeats', null, \{\s*'order'/.test(backend),
  'no unfiltered "newest heartbeat of any kind" query remains');

ok(/'kiosk_id': 'eq\.' \+ KIOSK_ID, 'order': 'seen_at\.desc'/.test(body),
  'the real report is the one ordered by seen_at');

// --- the verdict must say WHICH kind of row it is --------------------------
ok(/probeOnly = !realRow/.test(body), 'probe_only is derived from the real row being absent');
ok(/probe_only: probeOnly/.test(body), 'the response carries probe_only');
ok(/probe: probeRow \?/.test(body), 'the response carries the probe row separately');

// --- and the admin page must use that verdict -----------------------------
ok(/d\.probe_only/.test(adminHtml),
  'admin uses probe_only rather than re-deriving it from the row id');
ok(/escHtml\(String\(s\.state/.test(adminHtml),
  'probe text is escaped before it reaches the dashboard HTML');
ok(/d\.probe && d\.probe\.state/.test(adminHtml),
  'the probe stays visible as evidence when the real status is healthy');

// --- the probe itself must not cry wolf -----------------------------------
// 800 ms after load the heartbeat fetch is normally still in flight. Showing
// that as "0ok st=-" looked like a broken heartbeat on a working screen.
ok(/in-flight/.test(walkin), 'the probe distinguishes "not answered yet" from a failure');
ok(!/\+ ' st=' \+ \(hb\.lastStatus \|\| '-'\)/.test(walkin),
  'a pending heartbeat is no longer reported as a bare dash');
ok(/camEl=/.test(walkin),
  'the camera line says the ELEMENT is present, not that the camera opened');

if (failed) process.exit(1);
console.log('  ok      admin reads the kiosk, not its own diagnostic probe');
