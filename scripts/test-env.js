// Placeholders so a test can require netlify/functions/_shared.js.
//
// _shared.js reads its Supabase settings through requireEnv(), which throws on
// purpose when they are absent - that is how a missing deployment variable is
// made visible instead of being papered over with a committed copy. The test
// suite requires that module for its pure helpers (calculatePrice,
// freshnessOf), which have nothing to do with Supabase, so it needs the settings
// to EXIST without needing them to be real.
//
// Only ever fills a variable that is not already set, so a developer running the
// suite against their own environment is unaffected, and nothing here is a
// credential: these are dummies, and nothing in the suite performs a network
// call.
const PLACEHOLDERS = {
  SUPABASE_URL: 'https://placeholder.supabase.co',
  SUPABASE_KEY: 'placeholder-key-for-local-tests-not-a-credential',
};

for (const [name, value] of Object.entries(PLACEHOLDERS)) {
  if (!process.env[name]) process.env[name] = value;
}

module.exports = PLACEHOLDERS;