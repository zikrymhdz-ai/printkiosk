// Every figure in the "1 colour photo + 1 black-and-white photo" flow must be
// the same number: what the website quotes, what sealing records, what the kiosk
// shows, and what the payment matcher searches for.
//
// These have drifted apart before, and every time they did the customer paid
// exactly what the screen said and nothing matched:
//
//   - the kiosk summed per-job total_price (which carries one match fee per
//     job) while the matcher waits for order_total (one fee for the payment);
//   - a merged job's page count or colour split could be priced differently
//     from the way the browser summed its own preview.
//
// This runs the real calculatePrice, the real orderAmountOf from payment.js,
// the real orderAmountOf from the kiosk, and the real mergedItem, then checks
// they agree for both the merged case and the case where the photos stay apart.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const shared = require(path.join(ROOT, 'netlify/functions/_shared.js'));
const paymentSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/payment.js'), 'utf8');
const kioskSrc = fs.readFileSync(path.join(ROOT, 'kiosk/walkin.html'), 'utf8');

let failed = 0;
const ok = (c, msg) => { console.log((c ? '  ok      ' : '  FAILED  ') + msg); if (!c) failed++; };

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

function getLib() {
  return new Promise((res, rej) => {
    https.get('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', r => {
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end', () => res(Buffer.concat(c).toString('utf8')));
    }).on('error', rej);
  });
}

(async () => {
  const lib = await getLib();
  const m = globalThis.module, e = globalThis.exports;
  delete globalThis.module; delete globalThis.exports;
  globalThis.window = globalThis; globalThis.self = globalThis;
  vm.runInThisContext(lib, { filename: 'pdf-lib.min.js' });
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'website/pagerange.js'), 'utf8'),
    { filename: 'pagerange.js' });
  const PK = globalThis.PKPageRange;
  globalThis.module = m; globalThis.exports = e;

  const matcherAmount = vm.runInNewContext(
    extractFn(paymentSrc, 'orderAmountOf') + '; orderAmountOf;', {}, { timeout: 2000 });
  const kioskAmount = vm.runInNewContext(
    extractFn(kioskSrc, 'orderAmountOf') + '; orderAmountOf;', {}, { timeout: 2000 });

  const settings = (o) => Object.assign({
    color: 'bw', copies: 1, sides: 'single', pages: 1, page_spec: 'all',
    brightness: 0, contrast: 0, crop_mode: 'none',
  }, o);

  // --- the browser's own preview, before anything is merged ---------------
  // What the customer sees on the settings screen for 1 colour + 1 B&W photo.
  function browserPreview(items) {
    return items.reduce((sum, it) => {
      const s = it.settings;
      const mult = s.sides === 'double' ? 0.7 : 1.0;
      return sum + s.pages * s.copies * (s.color === 'color' ? 1.10 : 0.20) * mult;
    }, 0);
  }

  const colour = { file: { name: 'colour.png' }, settings: settings({ color: 'color', pages: 1 }) };
  const bw = { file: { name: 'bw.png' }, settings: settings({ color: 'bw', pages: 1 }) };

  const preview = browserPreview([colour, bw]);
  ok(Math.abs(preview - 1.30) < 0.005, 'the browser preview is RM1.30, got ' + preview.toFixed(2));

  // --- CASE A: the photos merge into one job ------------------------------
  {
    const merged = PK.mergedItem([colour, bw], { file: { name: 'c.pdf' }, pages: 2 });
    ok(merged.settings.color_pages === 1, 'the merged job records 1 colour page of 2');
    ok(merged.settings.pages === 2, 'and 2 pages in total');

    const base = shared.calculatePrice(merged.settings.pages, merged.settings.color,
      'a4', merged.settings.sides, merged.settings.copies, merged.settings.color_pages);
    ok(Math.abs(base - 1.30) < 0.005, 'the server prices the merged job at RM1.30, got ' + base.toFixed(2));
    ok(Math.abs(base - preview) < 0.005,
      'which equals the browser preview, so the quote did not drift from the charge');

    // Seal: a single job keeps its own total, and that becomes order_total.
    for (const fee of [0, 1, 2]) {
      const total = Math.round((base + fee / 100) * 100) / 100;
      const job = { job_id: 'A', order_id: 'o1', order_total: total, total_price: total };
      const kiosk = kioskAmount([job]);
      const matcher = matcherAmount([job]);
      ok(Math.abs(kiosk - total) < 0.005 && Math.abs(matcher - total) < 0.005,
        'fee ' + fee + 'c -> kiosk RM' + kiosk.toFixed(2) + ', matcher RM' + matcher.toFixed(2)
        + ', sealed RM' + total.toFixed(2) + ': all equal');
    }
  }

  // --- CASE B: the photos stay as two jobs in one order -------------------
  // Same customer, same outcome. The kiosk used to quote the SUM of the job
  // totals here, which carries a match fee per job, while the matcher waits for
  // the single order fee. That difference is what made payments invisible.
  {
    const baseColour = shared.calculatePrice(1, 'color', 'a4', 'single', 1);
    const baseBw = shared.calculatePrice(1, 'bw', 'a4', 'single', 1);
    ok(Math.abs((baseColour + baseBw) - 1.30) < 0.005,
      'two separate jobs still come to RM1.30 in items');

    const sumBase = baseColour + baseBw;
    // One order fee for the whole payment.
    const orderTotal = Math.round((sumBase + 0.01) * 100) / 100;
    const jobs = [
      { job_id: 'A', order_id: 'o1', order_total: orderTotal, total_price: Math.round((baseColour + 0.01) * 100) / 100 },
      { job_id: 'B', order_id: 'o1', order_total: orderTotal, total_price: Math.round((baseBw + 0.01) * 100) / 100 },
    ];

    const kiosk = kioskAmount(jobs);
    const matcher = matcherAmount(jobs);
    const naiveSum = jobs.reduce((s, j) => s + j.total_price, 0);

    ok(Math.abs(kiosk - orderTotal) < 0.005,
      'the kiosk quotes the sealed order total RM' + kiosk.toFixed(2));
    ok(Math.abs(matcher - orderTotal) < 0.005,
      'the matcher searches for the same RM' + matcher.toFixed(2));
    ok(Math.abs(kiosk - matcher) < 0.005, 'kiosk and matcher agree exactly');
    ok(Math.abs(naiveSum - orderTotal) > 0.005,
      'and this is why the old sum was wrong: RM' + naiveSum.toFixed(2)
      + ' vs RM' + orderTotal.toFixed(2));
  }

  // --- the kiosk must never be a stale build -----------------------------
  // The kiosk reloads on a version mismatch but only once every ten minutes,
  // and a cached reload returns the same old page. So the amount code can be
  // correct on the server and still wrong on the machine.
  const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
  ok(/\/kiosk\/walkin\.html[\s\S]{0,120}must-revalidate/.test(headers),
    'the kiosk page is served must-revalidate, so a reload really picks up a new build');
  ok(/\/kiosk\/\*/.test(headers), 'and so are the rest of the kiosk assets');

  if (failed) { console.log('  -> ' + failed + ' failed'); process.exit(1); }
  console.log('  ok      colour + B&W: one amount, quoted and matched everywhere');
})().catch(e => { console.log('  ERROR ' + e.message); console.log(e.stack); process.exit(1); });
