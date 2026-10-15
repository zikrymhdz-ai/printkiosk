// Fails if version.js and the files sync-version.js rewrites have drifted.
//
// A version bump that is committed without the generated copies leaves the
// functions layer serving an older APP_VERSION than the page, which is
// indistinguishable from a failed deploy when you are checking whether a fix
// is live. sync-version.js rewrites these files as a side effect of being run,
// so the copy that gets missed is whichever one you forgot to `git add`.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const expected = require(path.join(ROOT, 'version.js')).APP_VERSION;

const TARGETS = [
  ['netlify/functions/_shared.js', /const APP_VERSION = '([^']+)'/],
  ['kiosk/walkin.html', /var KIOSK_APP_VERSION = '([^']+)'/],
];

let failed = false;
for (const [rel, re] of TARGETS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.log('  FAILED  ' + rel + ' is missing');
    failed = true;
    continue;
  }
  const found = (fs.readFileSync(full, 'utf8').match(re) || [])[1];
  if (found !== expected) {
    console.log('  FAILED  ' + rel + ' says ' + found + ', version.js says ' + expected);
    console.log('          run: node scripts/sync-version.js');
    failed = true;
  } else {
    console.log('  ok      ' + rel + '  ' + found);
  }
}

// The upload pages must request their scripts with the build stamp. A stale
// pagerange.js means mergeIntoPdf is undefined, and uploads quietly stay split
// into one job per file - which looks exactly like an unfixed server bug.
for (const rel of ['website/customer.html', 'website/upload.html']) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const asset of ['pagerange.js', 'pstore.js']) {
    const stamped = src.indexOf(asset + '?v=' + expected) !== -1;
    if (!stamped) {
      console.log('  FAILED  ' + rel + ' does not load ' + asset + '?v=' + expected);
      console.log('          run: node scripts/sync-version.js');
      failed = true;
    }
  }
  if (src.indexOf('__PK_BUILD__') !== -1) {
    console.log('  FAILED  ' + rel + ' still contains the raw __PK_BUILD__ placeholder');
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('  ok      all version copies in sync at ' + expected);
console.log('  ok      upload pages are cache-busted at the same version');