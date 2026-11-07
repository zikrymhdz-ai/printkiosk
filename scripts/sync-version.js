// Keeps netlify/functions/_shared.js and kiosk/walkin.html on the same version.
//
// Run after bumping version.js:  node scripts/sync-version.js
//
// Exits non-zero if the two ever drift, so CI (or a habit) catches it before
// the kiosk is deployed into an infinite reload loop.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'version.js');
const SHARED = path.join(ROOT, 'netlify', 'functions', '_shared.js');
const WALKIN = path.join(ROOT, 'kiosk', 'walkin.html');

// Pages that load behaviour-carrying JS by a bare relative path.
const STAMPED = [
  path.join(ROOT, 'website', 'customer.html'),
  path.join(ROOT, 'website', 'upload.html'),
];
// Replaced with the app version so a new deploy cannot be served a stale copy
// out of the browser or the CDN cache. Without it the old pagerange.js kept
// loading, so mergeIntoPdf was undefined and uploads stayed split into one job
// per file even though the server had been fixed.
const BUILD_TOKEN = '__PK_BUILD__';

const target = require(VERSION_FILE).APP_VERSION;

const SHARED_RE = /const APP_VERSION = '([^']+)'/;
const WALKIN_RE = /var KIOSK_APP_VERSION = '([^']+)'/;

function rewrite(file, re, name, value) {
  const before = fs.readFileSync(file, 'utf8');
  const m = before.match(re);
  if (!m) throw new Error(name + ' not found in ' + path.relative(ROOT, file));

  if (m[1] === value) {
    console.log('  ok       ' + path.relative(ROOT, file) + '  ' + value);
    return false;
  }

  fs.writeFileSync(file, before.replace(re, function (full, _old) {
    return full.replace(_old, value);
  }));
  console.log('  updated  ' + path.relative(ROOT, file) + '  ' + m[1] + ' -> ' + value);
  return true;
}

// Stamp the cache-busting query on every page that carries the placeholder.
// Also rewrites an EXISTING stamp, because the placeholder is consumed on the
// first run - matching only the token meant every later bump silently left the
// pages pointing at the previous build.
const ASSET_STAMP_RE = /(pagerange\.js|pstore\.js|push\.js)\?v=[^"']*/g;

function stampBuild(file) {
  const rel = path.relative(ROOT, file);
  const before = fs.readFileSync(file, 'utf8');
  const hasToken = before.indexOf(BUILD_TOKEN) !== -1;
  const hasStamp = ASSET_STAMP_RE.test(before);
  ASSET_STAMP_RE.lastIndex = 0;

  if (!hasToken && !hasStamp) {
    throw new Error('neither ' + BUILD_TOKEN + ' nor a ?v= stamp found in ' + rel);
  }

  const after = before
    .split(BUILD_TOKEN).join(target)
    .replace(ASSET_STAMP_RE, '$1?v=' + target);

  if (after === before) return false;
  fs.writeFileSync(file, after);
  console.log('  stamped  ' + rel + '  ?v=' + target);
  return true;
}

console.log('syncing app version -> ' + target);
const changed = [
  rewrite(SHARED, SHARED_RE, 'APP_VERSION', target),
  rewrite(WALKIN, WALKIN_RE, 'KIOSK_APP_VERSION', target),
];

let stamped = 0;
for (const file of STAMPED) {
  if (stampBuild(file)) stamped++;
}

// Verify by re-reading, so a regex that silently failed to match cannot pass.
const check = [
  [SHARED, SHARED_RE],
  [WALKIN, WALKIN_RE],
].map(function (pair) {
  const found = fs.readFileSync(pair[0], 'utf8').match(pair[1]);
  return found ? found[1] : null;
});

const bad = check.filter(function (v) { return v !== target; });
if (bad.length) {
  console.error('\nFAILED: version drift remains -> ' + JSON.stringify(check));
  process.exit(1);
}

// No page may be left holding the placeholder, or it would request a script
// literally named "?v=__PK_BUILD__" and get a 404.
const unstamped = STAMPED.filter(function (f) {
  return fs.readFileSync(f, 'utf8').indexOf(BUILD_TOKEN) !== -1;
});
if (unstamped.length) {
  console.error('\nFAILED: build placeholder left in '
    + unstamped.map(function (f) { return path.relative(ROOT, f); }).join(', '));
  process.exit(1);
}

console.log(changed.length || stamped
  ? '\nversion synced.'
  : '\nalready in sync.');
