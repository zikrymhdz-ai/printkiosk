// Multi-file uploads are combined into ONE document.
//
// Each file used to create its own print job, so paying once for three
// documents meant attributing one payment across three jobs - which is what
// kept failing. Now they are merged client-side into a single PDF with a single
// correctly counted page total, which is what "I uploaded several files" means.
//
// Runs against the REAL pdf-lib 1.17.1 and the REAL mergeIntoPdf from
// website/pagerange.js, in a single realm, because the whole failure mode this
// guards against is a library that behaves differently than expected.
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
  const prSrc = fs.readFileSync('website/pagerange.js', 'utf8');

  let failed = 0;
  const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

  // IMPORTANT: pdf-lib validates arrays with a realm-sensitive check
  // (`instanceof Array`). If pagerange.js ran in a separate vm context, every
  // array it built - including the [width, height] page size - would come from
  // the WRONG realm and addPage would reject it as NaN. A browser has exactly
  // one realm, so the test must too: run both scripts in this realm.
  globalThis.window = globalThis;
  vm.runInThisContext(libSrc, { filename: 'pdf-lib.min.js' });
  const PDFLib = globalThis.PDFLib;
  vm.runInThisContext(prSrc, { filename: 'pagerange.js' });
  const PK = globalThis.PKPageRange;

  ok(!!PK && typeof PK.mergeIntoPdf === 'function', 'mergeIntoPdf is exposed for both pages');
  ok(typeof PK.extOf === 'function', 'extOf helper is exposed');
  if (!PK) { process.exit(1); }

  // Helpers that build real documents.
  const PDFDoc = PDFLib.PDFDocument;
  async function pdfOf(pages, name) {
    const d = await PDFDoc.create();
    for (let i = 0; i < pages; i++) d.addPage([200, 300]);
    const bytes = await d.save();
    return new File([bytes], name, { type: 'application/pdf' });
  }
  // A tiny valid PNG (1x1).
  async function pngOf(name) {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return new File([Buffer.from(b64, 'base64')], name, { type: 'image/png' });
  }
  // A tiny valid PNG (1x1).
  async function pngOf(name) {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return new File([Buffer.from(b64, 'base64')], name, { type: 'image/png' });
  }

  // 1. Two PDFs, 2 and 3 pages -> one 5-page document.
  {
    const r = await PK.mergeIntoPdf([{ file: await pdfOf(2, 'a.pdf') }, { file: await pdfOf(3, 'b.pdf') }]);
    ok(r.pages === 5, 'two PDFs (2 + 3 pages) combine to 5 pages, got ' + r.pages);
    const back = await PDFDoc.load(await r.file.arrayBuffer());
    ok(back.getPageCount() === 5, 'the merged file really has 5 pages');
    ok(r.sources.length === 2 && r.sources[0].pages === 2 && r.sources[1].pages === 3,
       'per-file page counts are reported: ' + JSON.stringify(r.sources.map(s => s.pages)));
  }

  // 2. Three PDFs of 1 page each -> 3 pages. This is the reported scenario.
  {
    const files = [];
    for (let i = 0; i < 3; i++) files.push({ file: await pdfOf(1, 'doc' + (i + 1) + '.pdf') });
    const r = await PK.mergeIntoPdf(files);
    ok(r.pages === 3, 'three single-page files combine to 3 pages, got ' + r.pages);
    const back = await PDFDoc.load(await r.file.arrayBuffer());
    ok(back.getPageCount() === 3, 'the merged file has 3 pages');
  }

  // 3. Images become real pages.
  {
    const r = await PK.mergeIntoPdf([
      { file: await pdfOf(1, 'a.pdf') },
      { file: await pngOf('photo.png') },
      { file: await pngOf('other.png') },
    ]);
    ok(r.pages === 3, 'a PDF plus two images combine to 3 pages, got ' + r.pages);
    ok(r.images === 2, 'both images were embedded as pages');
    const back = await PDFDoc.load(await r.file.arrayBuffer());
    ok(back.getPageCount() === 3, 'the merged file has 3 pages including images');
  }

  // 4. A single file needs no merge at all.
  {
    const r = await PK.mergeIntoPdf([{ file: await pdfOf(4, 'solo.pdf') }]);
    ok(r.pages === 4, 'a single file is its own merge, pages preserved');
  }

  // 5. DOCX cannot be merged client-side and must say so rather than
  //    silently dropping the document.
  {
    const docx = new File([new Uint8Array([80, 75, 3, 4])], 'letter.docx',
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    let msg = '';
    try { await PK.mergeIntoPdf([{ file: docx }, { file: await pdfOf(1, 'a.pdf') }]); }
    catch (e) { msg = String(e && e.message); }
    ok(/DOCX cannot be combined/.test(msg), 'a DOCX in a batch is refused with a clear reason: ' + msg);
  }

  // 6. A lone DOCX must NOT be refused -- it uploads on its own.
  {
    const docx = new File([new Uint8Array([80, 75, 3, 4])], 'letter.docx',
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    let msg = '';
    try { await PK.mergeIntoPdf([{ file: docx }]); } catch (e) { msg = String(e && e.message); }
    ok(!/cannot be combined/.test(msg), 'a DOCX on its own is not blocked by the merge');
  }

  // 7. The batch cap is still 5, and that cap is about ORDER SIZE.
  {
    const files = [];
    for (let i = 0; i < 5; i++) files.push({ file: await pdfOf(1, 'f' + i + '.pdf') });
    const r = await PK.mergeIntoPdf(files);
    ok(r.pages === 5, 'five files (the cap) combine cleanly');
  }

  // 8. THE REPORTED CASE: one image plus one PDF where the customer picked
  //    pages 3,5 of 5. The selection must survive the merge, or the customer is
  //    billed and printed for all 5 pages - and then pays the 2-page amount,
  //    which is why their payment stopped matching.
  {
    const pdf = await pdfOf(5, 'report.pdf');
    const img = await pngOf('photo.png');
    const prepared = await PK.prepareForMerge([
      { file: img, settings: { page_spec: 'all' } },
      { file: pdf, settings: { page_spec: '3,5' } },
    ]);
    ok(prepared.length === 2, 'both documents are prepared for the merge');

    const r = await PK.mergeIntoPdf(prepared);
    ok(r.pages === 3, 'image + selected pages 3,5 come to 3 pages, got ' + r.pages);

    const back = await PDFDoc.load(await r.file.arrayBuffer());
    ok(back.getPageCount() === 3, 'the merged file really has 3 pages, not 6');

    // The image is 1x1px, so its page is 1x1pt; the PDF sheets are 200x300pt.
    // Checking the sizes proves the image was kept and the order is right.
    const p1 = back.getPage(0).getSize();
    const p2 = back.getPage(1).getSize();
    ok(p1.width === 1 && p1.height === 1, 'page 1 is the image, not a blank sheet');
    ok(p2.width === 200 && p2.height === 300, 'page 2 is a sheet taken from the PDF');
    ok(back.getPageCount() === 3, 'page 3 is the PDF sheet for page 5');
  }

  // 9. Every page selected explicitly is the whole document, so nothing is lost.
  {
    const pdf = await pdfOf(3, 'three.pdf');
    const prepared = await PK.prepareForMerge([
      { file: pdf, settings: { page_spec: '1,2,3' } },
    ]);
    const r = await PK.mergeIntoPdf(prepared);
    ok(r.pages === 3, 'selecting 1,2,3 of 3 pages keeps all 3, got ' + r.pages);
  }

  // 10. A selection on an image is ignored - an image is one page anyway - and
  //     must not throw or drop the file.
  {
    const img = await pngOf('photo.png');
    const prepared = await PK.prepareForMerge([
      { file: img, settings: { page_spec: '2,4' } },
    ]);
    ok(prepared.length === 1, 'an image is kept despite a page selection');
    const r = await PK.mergeIntoPdf(prepared);
    ok(r.pages === 1, 'an image stays one page');
  }

  // 11. A manual crop must be what gets merged, not the original.
  {
    const original = await pdfOf(2, 'uncropped.pdf');
    const cropped = await pdfOf(1, 'uncropped.pdf');
    const prepared = await PK.prepareForMerge([
      { file: original, croppedFile: cropped, settings: { crop_mode: 'manual', page_spec: 'all' } },
    ]);
    const r = await PK.mergeIntoPdf(prepared);
    ok(r.pages === 1, 'the cropped file is merged instead of the original (1 page, got ' + r.pages + ')');
  }

  if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
  console.log('  ok      multiple documents become one job with the right page count');
})().catch(e => { console.log('  ERROR ' + (e && e.message)); console.log(e && e.stack); process.exit(1); });
