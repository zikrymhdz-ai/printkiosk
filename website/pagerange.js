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

  /* Combine several documents into ONE pdf, so a multi-file upload becomes a
   * single job with a single, correctly-counted page total.
   *
   * Why: each file used to create its own print job, so a customer uploading
   * three documents paid once for three jobs and the amount had to be
   * attributed to the set. Combining client-side makes it one job, one order
   * and one amount - which is what "I uploaded several files" actually means.
   *
   * Only PDF and images can be merged here. DOC/DOCX have no client-side
   * renderer, so they are refused with a clear reason rather than silently
   * dropping pages.
   *
   * Returns { file, pages, images, sources }.
   */
  function extOf(name) {
    var parts = String(name || '').split('.');
    return (parts.pop() || '').toLowerCase();
  }

  function mergeIntoPdf(items) {
    if (typeof PDFLib === 'undefined') {
      return Promise.reject(new Error('PDF library not loaded'));
    }

    var out = null;
    var pages = 0;
    var images = 0;
    var sources = [];

    return items.reduce(function (chain, item) {
      return chain.then(function () {
        var file = item && item.file ? item.file : item;
        var name = file.name || 'document';
        var ext = extOf(name);
        sources.push({ name: name, pages: null });

        if (ext === 'pdf') {
          return file.arrayBuffer()
            .then(function (buf) { return PDFLib.PDFDocument.load(buf); })
            .then(function (src) {
              var count = src.getPageCount();
              sources[sources.length - 1].pages = count;
              pages += count;
              // PDFDocument.create() is ASYNC since pdf-lib 1.17.0 and returns
              // a Promise. Assigning it straight to `out` gives a Promise, and
              // out.copyPages is then undefined - the exact error this had.
              var ready = out ? Promise.resolve(out) : PDFLib.PDFDocument.create();
              return ready.then(function (doc) {
                out = doc;
                // copyPages is also async on 1.17.x.
                return Promise.resolve(out.copyPages(src, src.getPageIndices()))
                  .then(function (copied) {
                    copied.forEach(function (p) { out.addPage(p); });
                  });
              });
            });
        }

        if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') {
          return file.arrayBuffer().then(function (buf) {
            var ready = out ? Promise.resolve(out) : PDFLib.PDFDocument.create();
            return ready.then(function (doc) {
              out = doc;
              return (ext === 'png' ? out.embedPng(buf) : out.embedJpg(buf))
                .then(function (img) {
                  // Page in points, from the image's pixel size.
                  var page = out.addPage([img.width, img.height]);
                  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
                  images++;
                  pages += 1;
                  sources[sources.length - 1].pages = 1;
                });
            });
          });
        }

        // A DOC/DOCX sent on its own needs no merging, so let it through. Only
        // refuse it when it would have to be combined with something else.
        if (items.length === 1) {
          return { file: file, pages: null, images: 0, sources: sources };
        }

        return Promise.reject(new Error(
          name + ': DOC and DOCX cannot be combined with other documents. '
          + 'Upload it on its own.'));
      });
    }, Promise.resolve()).then(function () {
      if (!out || !pages) throw new Error('Nothing to combine');
      return out.save().then(function (bytes) {
        var label = items.length + '-documents.pdf';
        return {
          file: new File([bytes], label, { type: 'application/pdf' }),
          pages: pages,
          images: images,
          sources: sources
        };
      });
    });
  }

  return {
    parse: parse,
    compress: compress,
    extractPdfPages: extractPdfPages,
    mergeIntoPdf: mergeIntoPdf,
    extOf: extOf
  };
})();