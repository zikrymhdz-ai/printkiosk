// Read-only diagnostic: show the most recent print jobs with their outcome.
//
// Uses the same credentials and REST shape the live code uses, so it can see
// exactly what the kiosk and the worker saw. This only issues GETs.
//
// The key is read out of _shared.js at runtime rather than pasted in here, so
// this diagnostic never becomes a second copy of the secret on disk.
const path = require('path');

const src = require('fs').readFileSync(
  path.join(__dirname, '..', 'netlify', 'functions', '_shared.js'), 'utf8');
const url = (src.match(/SUPABASE_URL\s*\|\|\s*'([^']+)'/) || [])[1];
const key = (src.match(/SUPABASE_KEY\s*\|\|\s*'([^']+)'/) || [])[1];

if (!url || !key) {
  console.log('  could not read Supabase credentials from _shared.js');
  process.exit(1);
}

const fields = [
  'created_at', 'job_id', 'pages', 'color_mode', 'file_name',
  'status', 'paid', 'print_attempts', 'print_error', 'print_requested_at',
].join(',');

const qs = new URLSearchParams({
  select: fields,
  order: 'created_at.desc',
  limit: '25',
});

fetch(url + '/rest/v1/print_jobs?' + qs, {
  headers: { apikey: key, Authorization: 'Bearer ' + key },
})
  .then(async (r) => {
    if (!r.ok) {
      console.log('  HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      process.exit(1);
    }
    return r.json();
  })
  .then((rows) => {
    if (!rows.length) return console.log('  no rows');
    const pad = (v, n) => String(v === null || v === undefined ? '-' : v).slice(0, n).padEnd(n);
    console.log('  ' + pad('created', 17) + pad('job_id', 10) + pad('pg', 3)
      + pad('color', 7) + pad('c_pg', 5) + pad('status', 16) + pad('paid', 5) + 'attempts');
    for (const r of rows) {
      console.log('  ' + pad((r.created_at || '').slice(0, 16).replace('T', ' '), 17)
        + pad(r.job_id, 10) + pad(r.pages, 3) + pad(r.color_mode, 7)
        + pad(r.color_pages, 5) + pad(r.status, 16) + pad(r.paid, 5) + (r.print_attempts || 0));
      if (r.print_error) console.log('      error: ' + String(r.print_error).slice(0, 160));
    }
  })
  .catch((e) => console.log('  request failed: ' + e.message));