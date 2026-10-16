// Inspect one job end to end: the database row, and the stored PDF if it
// still exists.
//
// A completed job normally has its file deleted from storage (the worker owns
// the terminal transition and storage is only cleared once paper is out), so
// this often cannot fetch the bytes. It reports that plainly rather than
// guessing, because "the file is gone" is itself the answer to a question about
// what the printer was actually handed.
//
// Read-only: GET requests only.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'netlify', 'functions', '_shared.js'), 'utf8');
const url = (src.match(/SUPABASE_URL\s*\|\|\s*'([^']+)'/) || [])[1];
const key = (src.match(/SUPABASE_KEY\s*\|\|\s*'([^']+)'/) || [])[1];

const JOB_ID = process.argv[2] || 'PRN-20261015-4E6F';
const headers = { apikey: key, Authorization: 'Bearer ' + key };

const row = (r) => {
  for (const k of Object.keys(r).sort()) {
    let v = r[k];
    if (v === null) v = 'NULL';
    else if (typeof v === 'string' && v.length > 58) v = v.slice(0, 58) + '...';
    console.log('    ' + k.padEnd(22) + v);
  }
};

// Page count and page boxes straight from the raw PDF, so this works without
// pulling pdf-lib into a project that only depends on bcryptjs.
function describePdf(buf) {
  const text = buf.toString('latin1');
  const typePage = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const count = (text.match(/\/Count\s+(\d+)/g) || [])
    .map((m) => parseInt(m.replace(/\D+/g, ''), 10));
  const boxes = [...new Set((text.match(/\/MediaBox\s*\[[^\]]*\]/g) || []))];
  const images = (text.match(/\/Subtype\s*\/Image/g) || []).length;
  return {
    typePage,
    countHint: count.length ? Math.max(...count) : null,
    boxes,
    images,
    kb: Math.round(buf.length / 1024),
  };
}

(async () => {
  const qr = new URLSearchParams({ job_id: 'eq.' + JOB_ID, limit: '1' });
  const res = await fetch(url + '/rest/v1/print_jobs?' + qr, { headers });
  const rows = await res.json();

  if (!rows.length) return console.log('  no job with id ' + JOB_ID);
  const j = rows[0];

  console.log('  === job row ===');
  row(j);

  console.log('\n  === siblings in the same order ===');
  if (!j.order_id) {
    console.log('    (order_id is NULL - this job stands alone)');
  } else {
    const or = new URLSearchParams({ order_id: 'eq.' + j.order_id, select: 'job_id,pages,color_mode,status,file_name' });
    const oj = await (await fetch(url + '/rest/v1/print_jobs?' + or, { headers })).json();
    for (const s of oj) {
      console.log('    ' + String(s.job_id).padEnd(22) + String(s.pages).padEnd(4)
        + String(s.color_mode).padEnd(8) + String(s.status).padEnd(16) + s.file_name);
    }
  }

  console.log('\n  === stored file ===');
  const filePath = j.file_path || '';
  console.log('    path: ' + filePath);

  // The path is a public-bucket object URL. Sending the project's apikey header
  // to a plain storage object URL is what produced the HTTP 400 on the first
  // attempt, so this deliberately fetches with no headers at all.
  let buf;
  try {
    const r = await fetch(filePath);
    console.log('    fetch: HTTP ' + r.status);
    if (r.ok) buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.log('    fetch failed: ' + e.message);
  }

  if (!buf) {
    console.log('    -> bytes unavailable, cannot verify what was sent to the printer');
    return;
  }

  const d = describePdf(buf);
  console.log('    size            : ' + d.kb + ' KB');
  console.log('    /Type /Page objs: ' + d.typePage + '   (worker compares this to pages=' + j.pages + ')');
  console.log('    /Count hint     : ' + d.countHint);
  console.log('    embedded images : ' + d.images);
  console.log('    MediaBoxes      : ' + (d.boxes.length ? d.boxes.join(' | ') : '(none found)'));
})();