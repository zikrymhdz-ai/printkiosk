// No credential may be committed to the repository, ever again.
//
// Four of them were. _shared.js carried a live fallback for the Supabase key, the
// notification secret, the sender address and the Gmail app password, so anyone
// with a clone had the database and the mailbox - and, worse, the site kept
// working from the committed copy, which made an unconfigured environment look
// like a configured one. That is how they stayed there unnoticed.
//
// A committed credential cannot be un-committed; it has to be rotated. This
// stops the next one.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

// Files that run on Netlify and therefore hold secrets in the environment.
const SOURCES = fs.readdirSync(path.join(ROOT, 'netlify', 'functions'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join('netlify', 'functions', f));

// Anything long, mixed-case-and-digit, that is not obviously harmless. The
// published Supabase key is public by design and ships in the browser bundle, so
// it is named as allowed rather than pattern-matched away.
const isHarmless = (s) =>
  s.startsWith('sb_publishable_') ||
  s.includes('netlify.app') ||
  s.includes('.supabase.co') ||
  /^(printkioskfyp)/.test(s);

const SHAPES = [
  // A JWT, which is what a Supabase service key looks like.
  { re: /eyJ[A-Za-z0-9_-]{40,}/g, what: 'a JSON Web Token (Supabase key)' },
  // A high-entropy hex or base64 blob.
  { re: /['"][A-Za-z0-9_\-+/=]{40,}['"]/g, what: 'a long high-entropy secret' },
];

const SECRET_VARS = ['SUPABASE_KEY', 'NOTIFICATION_SECRET', 'SMTP_PASS', 'SMTP_USER', 'PRINT_WORKER_SECRET'];

for (const rel of SOURCES.concat(['frontend_config.js'])) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');

  for (const { re, what } of SHAPES) {
    const found = (text.match(re) || [])
      .map((s) => s.replace(/['"]/g, ''))
      .filter((s) => !isHarmless(s) && !/^(https?|ftp):/.test(s));
    ok(found.length === 0,
      rel + ' holds no ' + what
      + (found.length ? ' - found: ' + found.map((s) => s.slice(0, 12) + '...').join(', ') : ''));
  }
}

// The specific values that were committed. Named so a regression is unmistakable
// rather than looking like any other long string.
const KNOWN = [
  ['the Supabase service key', /JabQJz9kRWtZqY7FVJD14yOaKT0phfXTQekGUzYe5ZA/],
  ['the notification secret', /pk_notif_v3_fd3877b9/],
  ['the Gmail app password', /vewuljgrgldslwwv/],
  ['the sender address', /printkiosk\.sender@gmail\.com/],
];
for (const [what, re] of KNOWN) {
  let anywhere = false;
  for (const rel of SOURCES) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full) && re.test(fs.readFileSync(full, 'utf8'))) anywhere = true;
  }
  ok(!anywhere, what + ' is no longer committed anywhere in netlify/functions');
}

// A missing required variable must be loud, not a silent fallback.
const shared = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', '_shared.js'), 'utf8');
ok(/function requireEnv/.test(shared), 'there is a helper that requires an env var');
for (const v of ['SUPABASE_URL', 'SUPABASE_KEY']) {
  const line = shared.split('\n').find((l) => new RegExp('^const ' + v + ' =').test(l));
  ok(!!line && !/\|\|\s*'/.test(line),
    v + ' is read from the environment with no committed fallback'
    + (!line ? ' (NOT FOUND)' : ''));
}
for (const v of SECRET_VARS) {
  const line = shared.split('\n').find((l) => new RegExp('^const ' + v + ' =').test(l));
  if (!line) continue;
  ok(!/\|\|\s*'[^']{8,}'/.test(line), v + ' has no hardcoded fallback');
}

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      no credential is committed, and a missing one fails loudly');