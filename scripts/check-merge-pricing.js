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
  // One photo in colour, one in black and white.
  const mixedCase = [
    { file: await pdf(1, 'a.pdf'), settings: settings({ color: 'color' }) },
    { file: await pdf(1, 'b.pdf'), settings: settings({ color: 'bw' }) },
  ];
  const groups = PK.combineGroups(mixedCase);
  ok(groups.length === 2,
    'a colour file and a B&W file are NOT combined (groups: ' + groups.length + ')');

  const combined = await PK.combineByType(mixedCase);
  ok(combined.length === 2,
    'they stay two jobs, so each keeps its own colour and price');

  // Every job must still be exactly what it would have cost on its own.
  let totalCombined = 0;
  let totalSeparate = 0;
  for (const job of combined) {
    totalCombined += calculatePrice(job.settings.pages, job.settings.color, 'a4', job.settings.sides, job.settings.copies);
  }
  for (const it of mixedCase) {
    totalSeparate += calculatePrice(it.settings.pages, it.settings.color, 'a4', it.settings.sides, it.settings.copies);
  }
  ok(Math.abs(totalCombined - totalSeparate) < 0.005,
    'the charge is unchanged: combined ' + totalCombined.toFixed(2) + ' vs separate ' + totalSeparate.toFixed(2));

  // The colour job must not have absorbed the B&W one's colour.
  const colorJob = combined.find(j => j.settings.color === 'color');
  const bwJob = combined.find(j => j.settings.color === 'bw');
  ok(!!colorJob && !!bwJob, 'one colour job and one B&W job exist');
  ok(bwJob && calculatePrice(bwJob.settings.pages, 'bw', 'a4', bwJob.settings.sides, bwJob.settings.copies) < calculatePrice(1, 'color', 'a4', 'single', 1),
    'the B&W job is charged the B&W rate, not the colour rate');

  // --- the invariant, across every combination -----------------------------
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

  // Differing settings must never be merged, whatever differs.
  const diffs = [
    ['colour', { color: 'color' }, { color: 'bw' }],
    ['sides', { sides: 'double' }, { sides: 'single' }],
    ['copies', { copies: 3 }, { copies: 1 }],
  ];
  for (const [label, a, b] of diffs) {
    const pair = [
      { file: await pdf(1, 'x.pdf'), settings: settings(a) },
      { file: await pdf(1, 'y.pdf'), settings: settings(b) },
    ];
    const g = PK.combineGroups(pair);
    ok(g.length === 2, 'files differing in ' + label + ' are kept apart (groups: ' + g.length + ')');
  }

  // Photos follow the same rule.
  const photos = [
    { file: png('c.png'), settings: settings({ color: 'color' }) },
    { file: png('w.png'), settings: settings({ color: 'bw' }) },
  ];
  const pg = PK.combineGroups(photos);
  ok(pg.length === 2, 'a colour photo and a B&W photo are kept apart');

  // Unchanged: matching settings still merge, including several files.
  const alike = [];
  for (let i = 0; i < 5; i++) {
    alike.push({ file: await pdf(2, 'a' + i + '.pdf'), settings: settings({ color: 'color' }) });
  }
  const mergedAlike = await PK.combineByType(alike);
  ok(mergedAlike.length === 1, 'five matching PDFs still become one job');
  ok(mergedAlike[0].pdfPages === 10, 'and it has 10 pages, got ' + mergedAlike[0].pdfPages);

  if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
  console.log('  ok      combining never changes what the customer is charged');
})().catch(e => { console.log('  ERROR ' + e.message); console.log(e.stack); process.exit(1); });
