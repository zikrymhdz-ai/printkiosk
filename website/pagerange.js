/* PrintKiosk - page range selection helper.
 * Lets the customer print only chosen pages, e.g. "1,3,5", "1-4", "1,3-5,8" or "all".
 * When a custom selection is used the PDF is rebuilt in the browser so the shop
 * receives (and is billed for) exactly those pages.
 */
window.PKPageRange = (function () {
  'use strict';

  var MAX_PAGES = 999;

  /* Parse a spec into a sorted, de-duplicated page list.
   * Returns { ok, isAll, pages:[], count, error, label } */
  function parse(spec, totalPages) {
    totalPages = parseInt(totalPages, 10) || 0;
    var raw = String(spec == null ? '' : spec).trim();

    if (raw === '' || raw.toLowerCase() === 'all' || raw === '*') {
      return {
        ok: true, isAll: true, pages: [], count: totalPages || 1,
        label: 'All pages (' + (totalPages || '?') + ')',
        error: ''
      };
    }

    if (!/^[0-9,\-\s]+$/.test(raw)) {
      return { ok: false, isAll: false, pages: [], count: 0, label: '', error: 'Use numbers and ranges only, e.g. 1,3,5 or 1-4' };
    }

    var picked = {};
    var parts = raw.split(',');

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (part === '') continue;

      var m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) {
        return { ok: false, isAll: false, pages: [], count: 0, label: '', error: '"' + part + '" is not a valid page or range' };
      }

      var from = parseInt(m[1], 10);
      var to = m[2] ? parseInt(m[2], 10) : from;

      if (from < 1 || to < 1) {
        return { ok: false, isAll: false, pages: [], count: 0, label: '', error: 'Pages start at 1' };
      }
      if (from > to) {
        var tmp = from; from = to; to = tmp;
      }
      if (totalPages > 0 && to > totalPages) {
        return { ok: false, isAll: false, pages: [], count: 0, label: '', error: 'Page ' + to + ' is outside this document (' + totalPages + ' pages)' };
      }
      if (to - from + 1 > MAX_PAGES) {
        return { ok: false, isAll: false, pages: [], count: 0, label: '', error: 'That range is too large' };
      }

      for (var p = from; p <= to; p++) picked[p] = true;
    }

    var list = Object.keys(picked).map(Number).sort(function (a, b) { return a - b; });
    if (!list.length) {
      return { ok: false, isAll: false, pages: [], count: 0, label: '', error: 'Enter at least one page, or leave blank for all pages' };
    }

    return {
      ok: true,
      isAll: false,
      pages: list,
      count: list.length,
      label: compress(list),
      error: ''
    };
  }

  /* Turn [1,2,3,5] into "1-3, 5" */
  function compress(list) {
    var out = [];
    var start = null, prev = null;

    function flush() {
      if (start === null) return;
      if (start === prev) out.push(String(start));
      else if (prev === start + 1) out.push(start + ', ' + (start + 1));
      else out.push(start + '-' + prev);
      start = null; prev = null;
    }

    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (start === null) { start = n; prev = n; continue; }
      if (n === prev + 1) { prev = n; continue; }
      flush();
      start = n; prev = n;
    }
    flush();

    return out.join(', ');
  }

  // pdf-lib changed these to async in 1.17.0: PDFDocument.create() returns a
    // Promise<PDFDocument>, not a document. It was called without await here, so
    // `out` was a Promise and `out.copyPages` was undefined, producing
    // "copyPages is not a function" whenever a customer picked specific pages.
    //
    // toPromise() accepts either shape so this keeps working across pdf-lib
    // versions rather than being pinned to whichever one happens to be loaded.
    function toPromise(v) {
      return (v && typeof v.then === 'function') ? v : Promise.resolve(v);
    }

  /* Build a new PDF containing only the selected pages (1-based). */
  function extractPdfPages(file, pages) {
    if (typeof PDFLib === 'undefined') {
      return Promise.reject(new Error('PDF library not loaded'));
    }
    if (!file || !pages || !pages.length) return Promise.resolve(file);

    var name = (file.name || 'document.pdf').replace(/\.pdf$/i, '') + '_pages.pdf';

    return file.arrayBuffer()
      .then(function (buf) { return toPromise(PDFLib.PDFDocument.load(buf)); })
      .then(function (src) {
        return toPromise(PDFLib.PDFDocument.create()).then(function (out) {
          var indexes = [];
          for (var i = 0; i < pages.length; i++) {
            var idx = pages[i] - 1;
            if (idx >= 0 && idx < src.getPageCount()) indexes.push(idx);
          }
          if (!indexes.length) throw new Error('No valid pages selected');

          // copyPages is async on 1.17.x and synchronous on older builds.
          return toPromise(out.copyPages(src, indexes)).then(function (copied) {
            copied.forEach(function (pg) { out.addPage(pg); });
            return out.save();
          });
        });
      })
      .then(function (bytes) {
        return new File([bytes], name, { type: 'application/pdf' });
      });
  }

  return { parse: parse, compress: compress, extractPdfPages: extractPdfPages };
})();