// End-to-end check of PKPageRange.extractPdfPages against the REAL pdf-lib.
//
// This bug was invisible to source inspection and to a syntax check: it only
// appears at runtime, because pdf-lib 1.17.1 made PDFDocument.create() async,
// so the un-awaited call produced a Promise and `out.copyPages` was undefined.
// A source-level assertion would have passed while the feature was broken, so
// this actually builds PDFs and counts pages.
const fs = require('fs');
const https = require('https');
const vm = require('vm');

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return get(r.headers.location).then(res, rej);
      }
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => res(Buffer.concat(c)));
    }).on('error', rej);
  });
}

(async () => {
  const libSrc = (await get('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js')).toString('utf8');

  // Everything must run in ONE realm. An earlier version of this test used a
  // vm sandbox, which produced "indices must be of type Array, but was actually
  // of type Array" - pdf-lib's guard is instanceof-based, and an array built in
  // a separate realm has a different prototype. That failure was an artefact of
  // the harness, not a bug in pagerange.js. A browser has a single realm, so
  // this is the faithful setup.
  vm.runInThisContext(libSrc, { filename: 'pdf-lib.min.js' });
  globalThis.window = globalThis;
  vm.runInThisContext(fs.readFileSync('website/pagerange.js', 'utf8'), { filename: 'pagerange.js' });
  const PK = globalThis.PKPageRange;

  let failed = 0;
  const ok = (cond, msg) => { console.log((cond ? '  ok      ' : '  FAILED  ') + msg); if (!cond) failed++; };

  // Document the root cause so a future reader does not undo the await.
  const createRet = PDFLib.PDFDocument.create();
  ok(createRet && typeof createRet.then === 'function',
    'pdf-lib 1.17.1 create() is async (this is why the un-awaited call broke)');

  const bytes = await PDFLib.PDFDocument.create().then(function (doc) {
    for (let i = 1; i <= 3; i++) doc.addPage();
    return doc.save();
  });
  const input = new File([bytes], 'document.pdf', { type: 'application/pdf' });

  ok(!!PK && typeof PK.extractPdfPages === 'function', 'PKPageRange.extractPdfPages is exposed');

  async function pageCount(file) {
    const d = await PDFLib.PDFDocument.load(await file.arrayBuffer());
    return d.getPageCount();
  }

  // 1 page selected from a 3-page document.
  const one = await PK.extractPdfPages(input, [2]);
  ok(await pageCount(one) === 1, 'selecting page 2 of 3 produces a 1-page PDF');

  // 2 pages, out of order - order must be preserved.
  const two = await PK.extractPdfPages(input, [3, 1]);
  ok(await pageCount(two) === 2, 'selecting pages 3,1 produces a 2-page PDF');

  // All pages.
  const all = await PK.extractPdfPages(input, [1, 2, 3]);
  ok(await pageCount(all) === 3, 'selecting all 3 pages produces a 3-page PDF');

  // Out-of-range page must be dropped, not crash.
  const oor = await PK.extractPdfPages(input, [2, 99]);
  ok(await pageCount(oor) === 1, 'an out-of-range page is dropped, valid one kept');

  // Output is a usable PDF File with a sensible name.
  ok(oor instanceof File && oor.type === 'application/pdf', 'output is an application/pdf File');
  ok(/_pages\.pdf$/.test(oor.name), 'output filename is ' + oor.name);

  if (failed) { console.log('  -> ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('  ok      page selection produces the right pages');
})().catch(e => { console.log('  ERROR ' + e.message); console.log(e.stack); process.exit(1); });