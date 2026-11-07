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
const path = require('path');
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

    // The image is 1x1px, so its page is fitted to A4 (never 1x1pt); the PDF
    // sheets keep their own 200x300pt size. Checking both proves the image was
    // kept and the order is right.
    const p1 = back.getPage(0).getSize();
    const p2 = back.getPage(1).getSize();
    ok(p1.width === 595 && p1.height === 595, 'page 1 is the image, fitted to A4, got '
      + Math.round(p1.width) + 'x' + Math.round(p1.height));
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

  // 11b. Copies are baked into the page sequence so different copy counts can
  //      still become one job. v129
  {
    const mk = (name, pages, copies) => ({
      file: null,
      settings: { color: 'bw', copies, sides: 'single', pages, page_spec: 'all',
        brightness: 0, contrast: 0, crop_mode: 'none' },
      _name: name,
    });
    const a = Object.assign(mk('a.pdf', 2, 2), { file: await pdfOf(2, 'a.pdf') });
    const b = Object.assign(mk('b.pdf', 3, 1), { file: await pdfOf(3, 'b.pdf') });
    const r = await PK.combineByType([a, b]);
    ok(r.length === 1, 'different copy counts still become one job, got ' + r.length);
    ok(r[0] && r[0].pdfPages === 7,
      '2 pages x2 + 3 pages = 7, got ' + (r[0] && r[0].pdfPages));
    ok(r[0] && r[0].settings.copies === 1, 'the combined job itself is one copy');
  }

  // 12. Documents and images are kept apart.
  {
    ok(typeof PK.combineByType === 'function', 'combineByType is exposed');
    ok(typeof PK.shareableSettings === 'function', 'shareableSettings is exposed');
    ok(typeof PK.isImage === 'function', 'isImage is exposed');

    const item = (name, settings) => ({
      file: null, settings: Object.assign(
        { color: 'bw', copies: 1, sides: 'single', pages: 1, page_spec: 'all',
          brightness: 0, contrast: 0, crop_mode: 'none' }, settings || {}),
      _name: name,
    });

    // Two PDFs become one document.
    const twoPdf = [
      Object.assign(item('a.pdf'), { file: await pdfOf(2, 'a.pdf') }),
      Object.assign(item('b.pdf'), { file: await pdfOf(3, 'b.pdf') }),
    ];
    const merged = await PK.combineByType(twoPdf);
    ok(merged.length === 1, 'two PDFs become one document, got ' + merged.length);
    ok(merged[0].pdfPages === 5, 'the combined PDF has 5 pages, got ' + merged[0].pdfPages);
    ok(merged[0].settings.brightness === 0 && merged[0].settings.contrast === 0,
      'the combined document carries no adjustment, because nothing can apply one to it');

    // Colour photos need no baking at all, so they combine into ONE job here.
    const twoPlain = [
      Object.assign(item('p1.png'), { file: await pngOf('p1.png'), settings: { color: 'color' } }),
      Object.assign(item('p2.png'), { file: await pngOf('p2.png'), settings: { color: 'color' } }),
    ];
    const joined = await PK.combineByType(twoPlain);
    ok(joined.length === 1, 'two colour photos become one job, got ' + joined.length);
    ok(joined[0].pdfPages === 2, 'the combined photos have 2 pages, got ' + joined[0].pdfPages);
    ok(joined[0].settings.brightness === 0 && joined[0].settings.contrast === 0,
      'the combined job carries no adjustment, because none was set');

    // A black-and-white photo has to be converted before merging, and there is
    // no canvas under Node. It must NOT be merged anyway, or the greyscale
    // conversion would be silently skipped.
    const twoBw = [
      Object.assign(item('p1.png'), { file: await pngOf('p1.png'), settings: { color: 'bw' } }),
      Object.assign(item('p2.png'), { file: await pngOf('p2.png'), settings: { color: 'bw' } }),
    ];
    const keptBw = await PK.combineByType(twoBw);
    ok(keptBw.length === 2,
      'black-and-white photos stay separate when they cannot be converted here, got ' + keptBw.length);
    ok(keptBw.every(i => PK.isImage(i.file.name)),
      'and they are still uploaded as images, so the worker prints them black and white');

    // Photos WITH adjustments still merge when the pixels can be baked in.
    // There is no canvas under Node, so this exercises the safe path instead:
    // an adjustment that cannot be baked must NOT be silently dropped.
    const twoImg = [
      Object.assign(item('p1.png'), { file: await pngOf('p1.png'), settings: { brightness: 30, contrast: 10 } }),
      Object.assign(item('p2.png'), { file: await pngOf('p2.png'), settings: { brightness: -20, contrast: 5 } }),
    ];
    const kept = await PK.combineByType(twoImg);
    ok(typeof document === 'undefined', 'no canvas in this environment');
    ok(kept.length === 2,
      'with adjustments and no canvas the photos are kept separate, not merged and lost');
    ok(kept[0].settings.brightness === 30 && kept[0].settings.contrast === 10,
      'the first photo keeps its own adjustment');
    ok(kept[1].settings.brightness === -20 && kept[1].settings.contrast === 5,
      'the second photo keeps its own, different adjustment');
    ok(kept.every(i => PK.isImage(i.file.name)),
      'they are still uploaded as images, so the worker can adjust them');

    // A document and a photo are never combined.
    const mixed = [
      Object.assign(item('a.pdf'), { file: await pdfOf(2, 'a.pdf') }),
      Object.assign(item('p1.png'), { file: await pngOf('p1.png'), settings: { brightness: 40 } }),
    ];
    const split = await PK.combineByType(mixed);
    ok(split.length === 2, 'a PDF and a photo stay two files, got ' + split.length);
    ok(split.some(i => PK.isImage(i.file.name)), 'the photo is still there as an image');
    ok(split.some(i => PK.extOf(i.file.name) === 'pdf'), 'the document is still there as a PDF');
    const img = split.find(i => PK.isImage(i.file.name));
    ok(img.settings.brightness === 40,
      'the photo keeps its adjustment instead of losing it to the merge');

    // A DOCX cannot be merged, so it must not take the whole batch down.
    const withDoc = [
      Object.assign(item('a.pdf'), { file: await pdfOf(2, 'a.pdf') }),
      { file: new File([new Uint8Array([80, 75, 3, 4])], 'l.docx',
          { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
        settings: item('l.docx').settings },
    ];
    const safe = await PK.combineByType(withDoc);
    ok(safe.length === 2, 'a DOCX in the batch is left on its own, got ' + safe.length);
  }

  // 13. shareableSettings must not hand image-only settings to a document, and
  // must not hand out copies or sides either - those are per file.
  //
  // Copies and sides used to be in the shared set. Every print_jobs row has
  // always carried its own copies and sides and the price is summed per row, so
  // pushing one file's copy count onto every other file served nothing except to
  // make the control look order-wide while discarding what each file asked for.
  {
    const all = { color: 'color', copies: 3, sides: 'double', pages: 4,
      page_spec: 'all', brightness: 50, contrast: 25, crop_mode: 'manual' };
    const shared = PK.shareableSettings(all);
    ok(shared.color === 'color' && shared.pages === 4 && shared.page_spec === 'all',
      'colour and pages are shared');
    ok(!('brightness' in shared), 'brightness is not shared');
    ok(!('contrast' in shared), 'contrast is not shared');
    ok(!('crop_mode' in shared), 'crop mode is not shared');
    ok(!('copies' in shared), 'copies is per file, so it is not shared');
    ok(!('sides' in shared), 'duplex is per file, so it is not shared');
    // And it must leave each file's own values untouched rather than blanking
    // them, which is what would happen if sharing replaced settings wholesale.
    const kept = PK.shareableSettings({ copies: 1, sides: 'single', color: 'bw' });
    ok(!('copies' in kept) && !('sides' in kept) && kept.color === 'bw',
      'sharing from one file cannot erase the copies another file asked for');
  }

  // 14. A mixed batch must be DETECTED so the page can refuse it by name.
  {
    ok(typeof PK.mixedTypes === 'function', 'mixedTypes is exposed');
    const it = (name) => ({ file: { name: name } });

    ok(PK.mixedTypes([it('a.pdf'), it('b.pdf')]).mixed === false,
      'two PDFs are not a mixed batch');
    ok(PK.mixedTypes([it('a.png'), it('b.jpg')]).mixed === false,
      'two images are not a mixed batch');
    ok(PK.mixedTypes([it('a.pdf'), it('b.png')]).mixed === true,
      'a PDF and a photo IS a mixed batch');
    ok(PK.mixedTypes([it('a.pdf'), it('b.docx'), it('c.png')]).mixed === true,
      'a document and a photo is mixed even with a DOCX present');

    const m = PK.mixedTypes([it('a.pdf'), it('b.png')]);
    ok(m.docs.join() === 'PDF' && m.images.join() === 'PNG',
      'the real types are reported so the message can name them');
    ok(m.all.indexOf('PDF') !== -1 && m.all.indexOf('PNG') !== -1,
      'both types are listed for the message');

    // Repeats collapse, so the message does not read "PDF and PDF".
    const dup = PK.mixedTypes([it('a.pdf'), it('b.pdf'), it('c.png')]);
    ok(dup.all.join() === 'PDF,PNG', 'repeated types collapse: ' + dup.all.join());

    ok(PK.mixedTypes([]).mixed === false, 'an empty batch is not mixed');
    ok(PK.mixedTypes([it('a.pdf')]).mixed === false, 'a single document is not mixed');
    ok(PK.mixedTypes([it('a.png')]).mixed === false, 'a single photo is not mixed');

    // Case must not matter: a .PDF and a .PNG are still mixed.
    ok(PK.mixedTypes([it('a.PDF'), it('b.PNG')]).mixed === true,
      'uppercase extensions are still detected as mixed');
  }

  // 15. A file whose name does not match its bytes.
  //     Adjusting a photo in the browser re-encodes it as PNG but used to keep
  //     the original ".jpg" name, so mergeIntoPdf() handed PNG bytes to
  //     embedJpg() and failed with "SOI not found in JPEG". The format is now
  //     taken from the bytes, so a misleading name is harmless.
  {
    ok(typeof PK.sniffFormat === 'function', 'sniffFormat is exposed');

    const pngBytes = new Uint8Array(await (await pngOf('real.png')).arrayBuffer());
    const pdfBytes = new Uint8Array(await (await pdfOf(1, 'real.pdf')).arrayBuffer());

    ok(PK.sniffFormat(pngBytes.buffer) === 'png', 'PNG bytes are recognised as PNG');
    ok(PK.sniffFormat(pdfBytes.buffer) === 'pdf', 'PDF bytes are recognised as PDF');
    ok(PK.sniffFormat(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).buffer) === 'jpeg',
      'JPEG bytes are recognised as JPEG');
    ok(PK.sniffFormat(new Uint8Array([80, 75, 3, 4]).buffer) === null,
      'a DOCX is not mistaken for an image or a PDF');

    // PNG bytes wearing a .jpg name must still merge.
    const misnamed = new File([pngBytes], 'holiday.jpg', { type: 'image/jpeg' });
    const merged = await PK.mergeIntoPdf([misnamed]);
    ok(merged.pages === 1, 'a PNG named .jpg still becomes one page');

    const pair = await PK.mergeIntoPdf([
      new File([pdfBytes], 'doc.pdf', { type: 'application/pdf' }),
      misnamed,
    ]);
    ok(pair.pages === 2, 'and still merges with a PDF alongside it, got ' + pair.pages);

    // Genuinely unreadable bytes are refused with a usable message rather than
    // a raw library error.
    let msg = '';
    try {
      await PK.mergeIntoPdf([
        { file: new File([pdfBytes], 'a.pdf') },
        { file: new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'broken.png') },
      ]);
    } catch (e) { msg = String(e && e.message); }
    ok(/not a readable PDF, JPG or PNG/.test(msg),
      'unreadable bytes give a clear reason: ' + msg);

    // A lone unreadable file still passes through - it has nothing to merge with.
    let soloOk = false;
    try {
      const solo = await PK.mergeIntoPdf([{ file: new File([pdfBytes], 'a.pdf') }]);
      soloOk = solo && solo.pages === 1;
    } catch (e) { /* ignore */ }
    ok(soloOk, 'a single file is unaffected');
  }

  // 16. Baking an adjustment must not balloon the file.
  //     Converting a photo to black and white re-encodes it, and re-encoding
  //     everything as PNG made a real grainy photo about 2.7x larger than the
  //     JPEG the customer uploaded. Combined with a second photo, the document
  //     was rejected by storage with "object exceeded the maximum allowed
  //     size". The output format now follows the input format.
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'pagerange.js'), 'utf8');
    const bake = src.slice(src.indexOf('function adjustImageFile'), src.indexOf('function _clamp'));

    ok(!/}, 'image\/png'\);\s*$/m.test(bake) || /wasJpegOutput/.test(bake),
      'the output format depends on the source, not hardcoded to PNG');
    ok(/wasJpegOutput \? 'image\/jpeg' : 'image\/png'/.test(bake),
      'a JPEG is written back as JPEG');
    ok(/wasJpegOutput \? 0\.92 : undefined/.test(bake),
      'and at a print-quality setting');
    ok(/wasJpeg \? stem \+ '\.jpg' : stem \+ '\.png'/.test(bake),
      'and the file name follows the bytes it contains');

    // A storage rejection must not be shown to the customer verbatim.
    for (const page of ['website/customer.html', 'website/upload.html']) {
      const p = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
      ok(/function storageErrorMessage\(/.test(p), page + ' translates storage errors');
      ok(/exceeded the maximum allowed size/.test(p),
        page + ' recognises the oversized-object message');
      ok(/storageErrorMessage\(upMsg/.test(p), page + ' uses it on the upload failure');
    }

    const helper = /function storageErrorMessage\([\s\S]*?\n\}/.exec(
      fs.readFileSync(path.join(__dirname, '..', 'website', 'customer.html'), 'utf8'))[0];
    const fn = vm.runInNewContext('(' + helper.replace(/^function storageErrorMessage/, 'function') + ')');
    const raw = fn('object exceeded the maximum allowed size', 413, 52 * 1024 * 1024);
    ok(!/exceeded the maximum/.test(raw), 'the raw Supabase text is not shown to the customer');
    ok(/too large/i.test(raw) && /fewer photos|smaller images/i.test(raw),
      'the customer is told what to do instead: ' + raw);
    ok(fn('some other failure', 500, 10) === 'some other failure',
      'unrelated errors are left alone rather than rewritten');
  }

  // 17. Image pages must be a printable size.
  //     pdf-lib's addPage takes POINTS, but an image's width/height are PIXELS.
  //     Passing them straight through made a 12MP phone photo into a 55 x 41
  //     inch page - six times A4 - and the printer sat on "Receiving data" and
  //     printed nothing. A single photo was fine because the worker converts
  //     those itself at 300dpi, which is why only merged batches stalled.
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'pagerange.js'), 'utf8');
    const start = src.indexOf('var A4_LONG = 842');
    const branch = src.slice(start, src.indexOf('images++;', start));

    ok(start !== -1, 'the image branch computes a corrected page size');
    ok(!/addPage\(\[img\.width, img\.height\]\)/.test(src),
      'pixels are never passed to addPage as if they were points');
    ok(/A4_LONG = 842, A4_SHORT = 595/.test(branch),
      'the page is bounded by A4 in either orientation');
    ok(/Math\.max\(1, pageW\)[\s\S]*Math\.max\(1, pageH\)/.test(branch),
      'even a 1px thumbnail cannot produce a zero-sized page');
    ok(/addPage\(\[pageW, pageH\]\)/.test(branch), 'the corrected size is what gets used');

    // The arithmetic, for a real 12MP phone photo and a thumbnail.
    const fit = (w0, h0) => {
      const ar = w0 / h0;
      let pageW, pageH;
      if (ar >= 1) { pageW = Math.min(842, 595 * ar); pageH = pageW / ar; }
      else { pageH = Math.min(595, 842 / ar); pageW = pageH * ar; }
      return [Math.max(1, pageW), Math.max(1, pageH)];
    };
    const [pw, ph] = fit(4000, 3000);
    ok(pw <= 842 && ph <= 595,
      'a 4000x3000 landscape photo becomes ' + Math.round(pw) + 'x' + Math.round(ph)
      + 'pt, which fits A4 landscape');
    ok(Math.abs(pw / ph - 4000 / 3000) < 0.01, 'with its aspect ratio intact');
    const [tw, th] = fit(1, 1);
    ok(tw === 595 && th === 595, 'a square photo becomes 595x595pt');
    const [nw, nh] = fit(1, 1000000);
    ok(nw >= 1 && nh >= 1 && nw <= 595, 'an extreme portrait still yields a valid page');
    ok(595 * 842 < (4000 * 3000), 'the old behaviour would have produced a page '
      + Math.round(4000 / 72) + 'x' + Math.round(3000 / 72) + ' inches');
  }

  if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
  console.log('  ok      multiple documents become one job with the right page count');
})().catch(e => { console.log('  ERROR ' + (e && e.message)); console.log(e && e.stack); process.exit(1); });
