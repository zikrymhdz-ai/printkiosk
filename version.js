// Single source of truth for the kiosk app version.
//
// netlify/functions/_shared.js reads this at build time, and the version is
// injected into kiosk/walkin.html by scripts/sync-version.js. Previously both
// files carried a hand-copied string, and forgetting one of them made the
// kiosk reload itself in an endless loop.
//
// Bump APP_VERSION here, run `npm run version`, commit both files.

module.exports = { APP_VERSION: '2026.10.14-79' };
