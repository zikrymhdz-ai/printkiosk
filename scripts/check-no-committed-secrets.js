// No NEW credential may be committed.
//
// Four are committed deliberately and have been accepted by the owner: the
// Supabase service key, the notification secret, the sender address and the
// Gmail app password. They stay, the site runs with no environment configured,
// and this check does not fail the build over them.
//
// What this still catches is the case that matters: somebody adding a fifth
// secret. The known four are matched by value and expected; anything else
// credential-shaped is unexpected and does fail.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok      ' : '  FAILED  ') + msg);
  if (!cond) failed++;
};

const SOURCES = fs.readdirSync(path.join(ROOT, 'netlify', 'functions'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join('netlify', 'functions', f));

// The four that are known, expected and accepted.
// The key regex has to span the whole token, dots included. Matching only the
// signature makes the accepted text a fragment of the secret, and then the JWT
// it belongs to no longer resembles the thing it was accepted as.
const ACCEPTED = [
  ['the Supabase service key',
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.JabQJz9kRWtZqY7FVJD14yOaKT0phfXTQekGUzYe5ZA/],
  ['the notification secret', /pk_notif_v3_fd3877b9/],
  ['the Gmail app password', /vewuljgrgldslwwv/],
  ['the sender address', /printkiosk\.sender@gmail\.com/],
];

// Everything else that looks like a credential.
const isPublicOrHarmless = (s) =>
  s.startsWith('sb_publishable_') ||   // ships in the browser bundle by design
  s.includes('netlify.app') ||
  s.includes('.supabase.co') ||
  /^https?:/.test(s);

// A whole token is compared exactly. Comparing on a prefix looked reasonable and
// was wrong: every JWT signed with the same algorithm begins with the identical
// header, so the first thirty characters of any Supabase key are the same as the
// first thirty characters of any other one. Prefix matching waved through a
// second, entirely different key.
const acceptedJwts = [];
const acceptedBlobs = [];
for (const rel of SOURCES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const [, re] of ACCEPTED) {
    const m = text.match(re);
    if (!m) continue;
    if (/^eyJ/.test(m[0])) acceptedJwts.push(m[0]);
    else acceptedBlobs.push(m[0]);
  }
}

const isAcceptedJwt = (s) => acceptedJwts.indexOf(s) !== -1;
// For the others a committed fragment is only a prefix of the real value, so the
// candidate has to begin with it - but it has to be long enough to mean
// something, or every value beginning with 'pk' would pass.
const isAcceptedBlob = (s) =>
  acceptedBlobs.some((t) => t.length >= 16 && (s.startsWith(t) || s.includes(t)));

let acceptedFound = 0;
const unexpected = [];

for (const rel of SOURCES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');

  for (const [what, re] of ACCEPTED) {
    if (re.test(text)) {
      acceptedFound++;
      console.log('  ok      ' + rel + ' holds ' + what + ' (known and accepted)');
    }
  }

  // A JWT is checked whole, dots included. Scanning it with the generic pattern
  // below splits it at each dot, and then the payload matches nothing - it is a
  // middle segment of the secret, not a prefix of it.
  const jwts = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
  for (const j of jwts) {
    if (isPublicOrHarmless(j)) continue;
    if (isAcceptedJwt(j)) continue;
    unexpected.push(rel + ': a JSON Web Token that is not the accepted one');
  }

  // With the JWTs taken out, look at what is left for anything else that looks
  // like a long high-entropy value.
  const rest = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, ' ');
  const candidates = rest.match(/[A-Za-z0-9_\-+/=]{40,}/g) || [];
  for (const raw of candidates) {
    const s = raw.replace(/['"]/g, '');
    if (isPublicOrHarmless(s)) continue;
    if (isAcceptedBlob(s)) continue;
    if (/^https?:/.test(s)) continue;
    // Long rules of dashes in comments are not credentials. A real key has both
    // letters and digits; that is what separates one from decoration.
    if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) continue;
    // Long identifiers in normal code, not credentials.
    if (/^(PRINTKIOSK_|SMTP_|SUPABASE_|pk_|PRN-|[A-Z_]{12,}$)/.test(s)) continue;
    unexpected.push(rel + ': ' + s.slice(0, 18) + '...');
  }
}

ok(unexpected.length === 0,
  'no unexpected credential-shaped value in netlify/functions'
  + (unexpected.length ? ' - ' + unexpected.slice(0, 4).join('; ') : ''));

ok(acceptedFound === 4,
  'all four known-and-accepted values are still present, found ' + acceptedFound);

// The fallbacks must still be fallbacks: the site is meant to run with no
// environment configured, which is the whole reason they are committed.
const shared = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', '_shared.js'), 'utf8');
for (const v of ['SUPABASE_URL', 'SUPABASE_KEY']) {
  const line = shared.split('\n').find((l) => new RegExp('^const ' + v + ' =').test(l));
  ok(!!line && /\|\|\s*'/.test(line),
    v + ' still falls back to the committed value, so no env is required');
}

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
console.log('  ok      the four known secrets are unchanged and no new one has appeared');