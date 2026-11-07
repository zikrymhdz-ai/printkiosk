// Combining files must not change what the customer is charged.
//
// A job carries one colour_mode column and calculatePrice() takes a single mode
// for all of its pages, so files can only be combined when they price the same
// way. This checks the real calculatePrice() from the server against the real
// grouping from pagerange.js, over every combination of colour, sides and
// copies, rather than asserting the algebra on paper.
const fs = require('fs');
const https = require('https');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
require('./test-env');
const { calculatePrice } = require(path.join(ROOT, 'netlify/functions/_shared.js'));

function getLib() {
  return new Promise((res, rej) => {
    https.get('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', r => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => res(Buffer.concat(c).toString('utf8')));
    }).on('error', rej);
  });
}

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

(async () => {
  const lib = await getLib();
  const pr = fs.readFileSync(path.join(ROOT, 'website/pagerange.js'), 'utf8');

  const m = globalThis.module, e = globalThis.exports;
  delete globalThis.module; delete globalThis.exports;
  globalThis.window = globalThis; globalThis.self = globalThis;
  vm.runInThisContext(lib, { filename: 'pdf-lib.min.js' });
  const PDFDoc = globalThis.PDFLib.PDFDocument;
  vm.runInThisContext(pr, { filename: 'pagerange.js' });
  const PK = globalThis.PKPageRange;
  globalThis.module = m; globalThis.exports = e;

  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  async function pdf(p, name) {
    const d = await PDFDoc.create();
    for (let i = 0; i < p; i++) d.addPage([200, 300]);
    return new File([await d.save()], name, { type: 'application/pdf' });
  }
  const png = (name) => new File([Buffer.from(b64, 'base64')], name, { type: 'image/png' });

  const settings = (o) => Object.assign({
    color: 'bw', copies: 1, sides: 'single', pages: 1, page_spec: 'all',
    brightness: 0, contrast: 0, crop_mode: 'none',
  }, o);

// --- the reported case ---------------------------------------------------
// One document in colour, one in black and white. These merge into ONE job: a
// combined job prints in a single colour mode, but the price is still split per
// page, so the customer gets one document instead of two without paying more
// for it.
const mixedCase = [
  { file: await pdf(1, 'a.pdf'), settings: settings({ color: 'color' }) },
  { file: await pdf(1, 'b.pdf'), settings: settings({ color: 'bw' }) },
];
const groups = PK.combineGroups(mixedCase);
ok(groups.length === 1,
  'a colour file and a B&W file are combined into one group (groups: ' + groups.length + ')');

const combined = await PK.combineByType(mixedCase);
ok(combined.length === 1,
  'and therefore into one job, got ' + combined.length);

// The invariant that matters most, and the reason the split exists at all:
// merging must NEVER cost the customer more than the files would have cost on
// their own. Billing both pages at the colour rate would be 2.20 instead of
// 1.10 + 0.20, so a customer who merged to save time would be charged more for
// it - the worst possible outcome for this feature.
let totalCombined = 0;
for (const job of combined) {
  totalCombined += calculatePrice(job.settings.pages, job.settings.color, 'a4', job.settings.sides,
    job.settings.copies, job.settings.color_pages);
}
let totalSeparate = 0;
for (const it of mixedCase) {
  totalSeparate += calculatePrice(it.settings.pages, it.settings.color, 'a4', it.settings.sides,
    it.settings.copies);
}
ok(Math.abs(totalCombined - totalSeparate) < 0.005,
  'the charge is unchanged: combined ' + totalCombined.toFixed(2) + ' vs separate ' + totalSeparate.toFixed(2));

// The split must be visible in the job itself, not merely implied by the total.
const mergedJob = combined[0];
ok(mergedJob && mergedJob.settings.color_pages === 1,
  'exactly one page is counted as colour, got ' + (mergedJob && mergedJob.settings.color_pages));
ok(mergedJob && mergedJob.settings.color === 'color',
  'the job prints in colour mode because one member wanted colour');

  // --- the page layout the printer needs, and the validation of it ----------
  // The price split was already correct, but the PRINT was not: a merged job was
  // one CUPS submission with one ColorModel, so B&W pages printed in colour too.
  // color_pages is a count and cannot fix that; the page ranges can.
  const PKmerged = PK.mergeIntoPdf; // keep the reference used above obvious
  const mergedItemSrc = fs.readFileSync(path.join(ROOT, 'website', 'pagerange.js'), 'utf8');
  ok(/color_runs: mixedModes \? colorRuns : null/.test(mergedItemSrc),
    'a mixed merge records its colour runs');
  ok(/mixedModes/.test(mergedItemSrc),
    'and only when the runs genuinely differ, so one-mode jobs stay unsplit');

  const upFn = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'upload.js'), 'utf8');
  ok(/function sanitiseColorRuns/.test(upFn), 'the backend validates colour runs');
  ok(/color_runs/.test(upFn) && /row|jobData/.test(upFn),
    'and the validated layout is stored on the job');

  const sanitise = new Function(
    upFn.match(/function sanitiseColorRuns[\s\S]*?\n\}/)[0] + '\nreturn sanitiseColorRuns;')();

  // Anything from a browser ends up in an lp command line, so the bar is high:
  // a clean, ordered, gapless cover of 1..pages with both modes present.
  const accepted = [
    ['B&W then colour', [{ from: 1, to: 3, color: 'bw' }, { from: 4, to: 5, color: 'color' }], 5],
    ['colour then B&W', [{ from: 1, to: 2, color: 'color' }, { from: 3, to: 5, color: 'bw' }], 5],
  ];
  for (const [name, runs, pages] of accepted) {
    const got = sanitise(runs, pages);
    let back = null;
    try { back = got ? JSON.parse(got) : null; } catch (e) { /* asserted below */ }
    ok(got !== null && back && back.length === 2
      && back[0].from === runs[0].from && back[1].to === runs[1].to,
      'accepts a valid layout: ' + name);
  }

  const rejected = [
    ['a gap in coverage', [{ from: 1, to: 2, color: 'bw' }, { from: 4, to: 5, color: 'color' }], 5],
    ['pages out of order', [{ from: 3, to: 4, color: 'bw' }, { from: 1, to: 2, color: 'color' }], 4],
    ['a run past the page count', [{ from: 1, to: 3, color: 'bw' }, { from: 4, to: 9, color: 'color' }], 5],
    ['pages not fully covered', [{ from: 1, to: 2, color: 'bw' }, { from: 3, to: 4, color: 'color' }], 5],
    ['only one colour mode', [{ from: 1, to: 2, color: 'bw' }, { from: 3, to: 5, color: 'bw' }], 5],
    ['a single run', [{ from: 1, to: 5, color: 'color' }], 5],
    ['zero or negative pages', [{ from: 0, to: 3, color: 'bw' }, { from: 4, to: 5, color: 'color' }], 5],
    ['a reversed run', [{ from: 3, to: 1, color: 'bw' }, { from: 4, to: 5, color: 'color' }], 5],
    ['not an array', 'nonsense', 5],
    ['null', null, 5],
    ['an unknown colour word', [{ from: 1, to: 3, color: 'bw' }, { from: 4, to: 5, color: 'red' }], 5],
    ['a one-page job', [{ from: 1, to: 1, color: 'bw' }, { from: 2, to: 2, color: 'color' }], 1],
  ];
  for (const [name, runs, pages] of rejected) {
    ok(sanitise(runs, pages) === null,
      'rejects ' + name + ' and falls back to one mode');
  }

  // The worker has to act on it, or storing it changes nothing.
  const workerSrc = fs.readFileSync(path.join(ROOT, 'pi', 'print-worker.py'), 'utf8');
  ok(/color_runs/.test(workerSrc), 'the worker reads the colour runs');
  ok(/page-ranges/.test(workerSrc),
    'and prints each run as its own submission with a page range');
  // A merged job prints in colour mode whenever any page wanted colour, so its
  // color_mode is 'color' even when only some pages are. Labelling that "Color"
  // misrepresents what the customer chose; labelling a wholly-colour job "Mixed"
  // is the opposite error and was what the summary did.
  const cust = fs.readFileSync(require('path').join(__dirname, '..', 'website', 'customer.html'), 'utf8');
  const labelOf = new Function(
    cust.match(/function colorLabelOf[\s\S]*?\n\}/)[0] + '\n' +
    cust.match(/function colorLabelForBatch[\s\S]*?\n\}/)[0] +
    '\nreturn colorLabelForBatch;')();

  const labelCases = [
    ['one colour document', [{ settings: { color: 'color', pages: 2 } }], 'Color'],
    ['one B&W document', [{ settings: { color: 'bw', pages: 2 } }], 'B&W'],
    ['a merged half-colour job', [{ color_mode: 'color', pages: 2, color_pages: 1 }], 'Mixed'],
    ['a merged all-colour job', [{ color_mode: 'color', pages: 2, color_pages: 2 }], 'Color'],
    ['a merged all-B&W job', [{ color_mode: 'bw', pages: 3, color_pages: 0 }], 'B&W'],
    ['two jobs, one colour one B&W',
      [{ settings: { color: 'color', pages: 1 } }, { settings: { color: 'bw', pages: 1 } }], 'Mixed'],
    ['a colour job with no split sent', [{ color_mode: 'color', pages: 4 }], 'Color'],
    ['a merged job 2 colour pages of 5', [{ color_mode: 'color', pages: 5, color_pages: 2 }], 'Mixed'],
  ];
  for (const [name, items, want] of labelCases) {
    let got;
    try { got = labelOf(items); } catch (e) { got = 'threw: ' + e.message; }
    ok(got === want, 'labelled ' + name + ' as ' + want + ', got ' + got);
  }

  // The kiosk and the summary must not be the only places that know about a
  // partial split: the whole point is that one fact has one answer.
  ok(/colorLabelForBatch\(serverJobs\)/.test(cust),
    'the receipt labels colour from the page split, not from color_mode');
  ok(/colorLabelForBatch\(bulkFiles\)/.test(cust),
    'the summary uses the same helper, so the two cannot disagree');

  // Removing a file must be possible from the settings step too, and must not
  // silently discard the settings the customer had just dialled in.
  ok(/function removeFile/.test(cust), 'removeFile exists');
  const rf = cust.match(/function removeFile\(idx\) \{[\s\S]*?\n\}/);
  ok(!!rf, 'removeFile body found');
  if (rf) {
    ok(/saveCurrentSettings\(\)/.test(rf[0]),
      'removing a file saves the in-progress settings first');
    ok(/renderFileSelector\(\)/.test(rf[0]),
      'and redraws the per-file chips, which is where the customer was');
    ok(/selectedFileIndex/.test(rf[0]),
      'and repairs the selection index, which the splice invalidated');
    ok(/removeFile\(' \+ i \+ '\)/.test(cust),
      'the settings chips carry their own remove button');
  }
  const modes = ['bw', 'color'];
  const sideList = ['single', 'double'];
  const copyList = [1, 2, 3];
  let checked = 0;
  let broke = 0;

  for (const color of modes) {
    for (const sides of sideList) {
      for (const copies of copyList) {
        // Same settings -> must be one group, and must cost the same.
        const same = [];
        for (let i = 0; i < 4; i++) {
          same.push({
            file: await pdf(2, 'f' + i + '.pdf'),
            settings: settings({ color, sides, copies, pages: 2 }),
          });
        }
        const g = PK.combineGroups(same);
        if (g.length !== 1) { broke++; console.log('    same-settings split: ' + color + '/' + sides + '/' + copies); }
        else {
          const merged = await PK.combineByType(same);
          if (merged.length !== 1) { broke++; console.log('    merge failed: ' + color + '/' + sides + '/' + copies); }
          else {
            const asMerged = calculatePrice(merged[0].settings.pages, merged[0].settings.color, 'a4', merged[0].settings.sides, merged[0].settings.copies);
            const asSeparate = same.reduce((s, it) =>
              s + calculatePrice(it.settings.pages, it.settings.color, 'a4', it.settings.sides, it.settings.copies), 0);
            if (Math.abs(asMerged - asSeparate) > 0.005) {
              broke++;
              console.log('    price drift: ' + color + '/' + sides + '/' + copies
                + ' merged ' + asMerged.toFixed(2) + ' vs separate ' + asSeparate.toFixed(2));
            }
          }
        }
        checked++;
      }
    }
  }
  ok(broke === 0, 'all ' + checked + ' same-setting combinations merge to one job at an identical price');

  // Sides are per-job, not per-page, so they must never merge. Copies are no
  // longer a split reason: they are baked into the merged page sequence.
  const diffs = [
    ['sides', { sides: 'double' }, { sides: 'single' }],
  ];
  for (const [label, a, b] of diffs) {
    const pair = [
      { file: await pdf(1, 'x.pdf'), settings: settings(a) },
      { file: await pdf(1, 'y.pdf'), settings: settings(b) },
    ];
    const g = PK.combineGroups(pair);
    ok(g.length === 2, 'files differing in ' + label + ' are kept apart (groups: ' + g.length + ')');
  }

  // Copies now combine by repeating pages.
  {
    const copiesPair = [
      { file: await pdf(2, 'c1.pdf'), settings: settings({ copies: 2, pages: 2 }) },
      { file: await pdf(1, 'c2.pdf'), settings: settings({ copies: 1, pages: 1 }) },
    ];
    ok(PK.combineGroups(copiesPair).length === 1,
      'files differing only in copies are grouped into one job');
    const mergedCopies = await PK.combineByType(copiesPair);
    ok(mergedCopies.length === 1, 'and become one job, got ' + mergedCopies.length);
    if (mergedCopies.length === 1) {
      ok(mergedCopies[0].pdfPages === 5,
        'the 2-page file with 2 copies contributes 4 pages, plus 1 (got ' + mergedCopies[0].pdfPages + ')');
      ok(mergedCopies[0].settings.copies === 1, 'the combined job itself carries one copy');
      const price = calculatePrice(mergedCopies[0].settings.pages, 'bw', 'a4', 'single', mergedCopies[0].settings.copies);
      ok(Math.abs(price - 1.00) < 0.005,
        'five resulting B&W pages cost RM1.00, got RM' + price.toFixed(2));
    }
  }

  // Documents differing only in colour merge into one job, exactly as photos do.
  const docsMixedColour = [
    { file: await pdf(2, 'colour.pdf'), settings: settings({ color: 'color', pages: 2 }) },
    { file: await pdf(3, 'bw.pdf'), settings: settings({ color: 'bw', pages: 3 }) },
  ];
  ok(PK.combineGroups(docsMixedColour).length === 1,
    'documents differing only in colour are grouped into one job');

  // And the price of that one job must still be split per page: 2 colour pages
  // at 1.10 and 3 B&W pages at 0.20 is 2.80, not 5 pages of colour (5.50).
  const mergedDocs = await PK.combineByType(docsMixedColour);
  ok(mergedDocs.length === 1, 'the mixed-colour documents become one job, got ' + mergedDocs.length);
  if (mergedDocs.length === 1) {
    const s = mergedDocs[0].settings;
    ok(mergedDocs[0].pdfPages === 5, 'and it has all 5 pages, got ' + mergedDocs[0].pdfPages);
    ok(s.color_pages === 2,
      'only the colour pages are counted as colour, got ' + s.color_pages);
    ok(s.color === 'color',
      'the job prints in colour mode because one member wanted colour');
    const price = calculatePrice(s.pages, s.color, 'a4', s.sides, s.copies, s.color_pages);
    ok(Math.abs(price - 2.80) < 0.005,
      'the merged job is priced per page, not all-colour: RM' + price.toFixed(2));
    // The over-count guard: color_pages must never exceed the pages present,
    // which would bill the colour rate for pages that are not there.
    const manyColour = [
      { file: await pdf(1, 'c1.pdf'), settings: settings({ color: 'color', pages: 1 }) },
      { file: await pdf(9, 'c2.pdf'), settings: settings({ color: 'color', pages: 9 }) },
    ];
    const over = await PK.combineByType(manyColour);
    if (over.length === 1) {
      ok(over[0].settings.color_pages <= over[0].pdfPages,
        'colour pages never exceed the pages actually in the document (' +
        over[0].settings.color_pages + ' of ' + over[0].pdfPages + ')');
    }
  }

  // Photos follow the same rule: a black-and-white photo is baked into the
  // pixels before merging, so photos differing only in colour do belong in one
  // job. Sides and copies are per-job, so they still must match.
  const photosMixedColour = [
    { file: png('c.png'), settings: settings({ color: 'color' }) },
    { file: png('w.png'), settings: settings({ color: 'bw' }) },
  ];
  ok(PK.combineGroups(photosMixedColour).length === 1,
    'photos differing only in colour are grouped into one job');

  for (const [label, a, b] of [['sides', { sides: 'double' }, { sides: 'single' }]]) {
    const pair = [
      { file: png('p1.png'), settings: settings(a) },
      { file: png('p2.png'), settings: settings(b) },
    ];
    ok(PK.combineGroups(pair).length === 2,
      'photos differing in ' + label + ' stay in separate jobs');
  }

  {
    const photoCopies = [
      { file: png('p1.png'), settings: settings({ copies: 2, color: 'color' }) },
      { file: png('p2.png'), settings: settings({ copies: 1, color: 'color' }) },
    ];
    ok(PK.combineGroups(photoCopies).length === 1,
      'photos differing only in copies are grouped into one job');
  }

  // Unchanged: matching settings still merge, including several files.
  const alike = [];
  for (let i = 0; i < 5; i++) {
    alike.push({ file: await pdf(2, 'a' + i + '.pdf'), settings: settings({ color: 'color' }) });
  }
  const mergedAlike = await PK.combineByType(alike);
  ok(mergedAlike.length === 1, 'five matching PDFs still become one job');
  ok(mergedAlike[0].pdfPages === 10, 'and it has 10 pages, got ' + mergedAlike[0].pdfPages);

  // --- the requested behaviour: ONE job, mixed colour ----------------------
  // Photos may differ in colour because the black-and-white ones are baked
  // into the pixels first, so a single job can hold both and be priced per
  // page. Node has no canvas, so combineImages declines and these stay separate
  // here; the grouping rule is what is under test.
  {
    const mixedPhotos = [
      { file: png('colour.png'), settings: settings({ color: 'color' }) },
      { file: png('bw.png'), settings: settings({ color: 'bw' }) },
    ];
    // Grouping puts them together: colour is deliberately not part of the key.
    const grouped = PK.combineGroups(mixedPhotos);
    ok(grouped.length === 1,
      'photos differing only in colour are grouped into ONE job (groups: ' + grouped.length + ')');

    // The item that job would become, and what it must cost.
    const merged = PK.mergedItem(mixedPhotos, { file: new File([new Uint8Array()], 'c.pdf'), pages: 2 });
    ok(merged.settings.color_pages === 1,
      'the job records 1 colour page of 2, got ' + merged.settings.color_pages);
    ok(merged.settings.color === 'color',
      'the job prints as colour, so the baked black-and-white page stays that way');

    const price = calculatePrice(2, merged.settings.color, 'a4', merged.settings.sides, merged.settings.copies, merged.settings.color_pages);
    const expected = 1 * 1.10 + 1 * 0.20;
    ok(Math.abs(price - expected) < 0.005,
      'it is charged 1 colour + 1 black-and-white page (RM' + price.toFixed(2) + ', expected RM' + expected.toFixed(2) + ')');

    const naive = calculatePrice(2, 'color', 'a4', 'single', 1);
    ok(price < naive,
      'which is less than charging both pages at the colour rate (RM' + naive.toFixed(2) + ')');

    // All-colour and all-bw stay exact.
    const allColour = PK.mergedItem(
      [{ file: png('a.png'), settings: settings({ color: 'color' }) },
       { file: png('b.png'), settings: settings({ color: 'color' }) }],
      { file: new File([new Uint8Array()], 'c.pdf'), pages: 2 });
    ok(allColour.settings.color_pages === 2, 'two colour pages are recorded as 2');
    ok(Math.abs(calculatePrice(2, 'color', 'a4', 'single', 1, 2) - 2.20) < 0.005,
      'two colour pages cost 2 x RM1.10');

    const allBw = PK.mergedItem(
      [{ file: png('a.png'), settings: settings({ color: 'bw' }) },
       { file: png('b.png'), settings: settings({ color: 'bw' }) }],
      { file: new File([new Uint8Array()], 'c.pdf'), pages: 2 });
    ok(allBw.settings.color_pages === 0, 'two black-and-white pages record 0 colour');
    ok(Math.abs(calculatePrice(2, 'bw', 'a4', 'single', 1, 0) - 0.40) < 0.005,
      'two black-and-white pages cost 2 x RM0.20');
  }

  // --- the server must not trust a nonsense split --------------------------
  {
    ok(Math.abs(calculatePrice(5, 'color', 'a4', 'single', 1, 99) - 5.50) < 0.005,
      'a colour_pages larger than the page count falls back to all colour');
    ok(Math.abs(calculatePrice(5, 'bw', 'a4', 'single', 1, -3) - 1.00) < 0.005,
      'a negative colour_pages cannot make pages free');
    ok(Math.abs(calculatePrice(3, 'bw', 'a4', 'single', 1, undefined) - 0.60) < 0.005,
      'no split at all behaves exactly as before');
    ok(Math.abs(calculatePrice(3, 'color', 'a4', 'single', 1, null) - 3.30) < 0.005,
      'a null split behaves exactly as before');
    // The split still respects sides and copies.
    ok(Math.abs(calculatePrice(2, 'color', 'a4', 'double', 1, 1) - (1.10 + 0.20) * 0.7) < 0.005,
      'the split is combined with double-sided, not applied to the flat total');
    ok(Math.abs(calculatePrice(2, 'color', 'a4', 'single', 2, 1) - (1.10 + 0.20) * 2) < 0.005,
      'the split is combined with copies, not applied to the flat total');
  }

  // --- a split must be explained, not silent ---------------------------------
  // combineByType() parts a batch on sides and copies. It used to do so without
  // a word, so a customer who set copies on one file got two jobs and concluded
  // their copies had been ignored - when in fact the files no longer belonged in
  // one document.
  ok(typeof PK.describeGroupSplit === 'function', 'describeGroupSplit is exposed');

  if (typeof PK.describeGroupSplit === 'function') {
    // A batch item: a name and settings, which is all combineGroups reads.
    const gitem = (name, s) => ({
      file: { name },
      settings: Object.assign({ color: 'bw', copies: 1, sides: 'single', pages: 1 }, s),
    });
    const g = (items) => PK.describeGroupSplit(items);

    // Copies are baked into the page sequence, so they are no longer a split
    // reason and must not be reported as one.
    ok(g([gitem('a.pdf', { copies: 2 }), gitem('b.pdf', { copies: 1 })]).length === 0,
      'a copies difference alone is not a reason to split');

    const sidesNote = g([gitem('a.pdf', { sides: 'double' }), gitem('b.pdf', { sides: 'single' })])[0] || '';
    ok(/sides/.test(sidesNote), 'differing sides are explained: ' + sidesNote);

    // Colour alone must NOT split, so it must not be reported as a reason.
    ok(g([gitem('a.pdf', { color: 'color' }), gitem('b.pdf', { color: 'bw' })]).length === 0,
      'a colour difference alone is not a reason to split');

    ok(g([gitem('a.pdf', {}), gitem('b.pdf', {})]).length === 0,
      'identical settings are not reported as a split');

    // Never answer "nothing" for a split that happened - that is the bug.
    ok(g([gitem('a.pdf', { sides: 'double' }), gitem('b.pdf', { sides: 'single' }), gitem('c.pdf', { sides: 'single' })]).length >= 1,
      'an outlier in a three-file batch is still explained');
  }

  // The merged layout must survive a later save of that item's settings.
  ok(/_mergedColorRuns/.test(fs.readFileSync(path.join(ROOT, 'website', 'pagerange.js'), 'utf8')),
    'a merged item keeps its colour layout outside settings');
  ok(/_mergedColorRuns && !item\.settings\.color_runs/.test(cust),
    'saveCurrentSettings carries the layout across, so a re-save cannot lose it');

if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
  console.log('  ok      combining never changes what the customer is charged');
})().catch(e => { console.log('  ERROR ' + e.message); console.log(e.stack); process.exit(1); });
