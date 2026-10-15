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

  // Brightness, contrast and cropping are applied by the worker in
  // image_to_pdf(), so they only ever affect JPG/PNG. A PDF cannot use them.
  var IMAGE_EXT = ['jpg', 'jpeg', 'png'];

  function isImage(name) {
    return IMAGE_EXT.indexOf(extOf(name)) !== -1;
  }

  /* Settings that every file in a batch may share: colour, sides, copies,
   * pages. The image-only adjustments are deliberately left out, so spreading
   * settings across files cannot hand a PDF a brightness it can never apply.
   */
  function shareableSettings(settings) {
    var s = settings || {};
    var out = {};
    for (var k in s) {
      if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
      if (k === 'brightness' || k === 'contrast' || k === 'crop_mode') continue;
      out[k] = s[k];
    }
    return out;
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

  /* Reduce a batch to the files that should actually be combined.
   *
   * Each item may carry its own page selection ("3,5"). That has to be applied
   * BEFORE the merge. Merging first and setting page_spec to 'all' silently
   * threw the selection away: the customer asked for 2 pages, was billed and
   * printed all 5, then paid the 2-page amount - which is why their payment no
   * longer matched anything the system was waiting for.
   */
  function prepareForMerge(items) {
    return items.reduce(function (chain, item) {
      return chain.then(function (acc) {
        var file = (item && item.file) ? item.file : item;
        var s = (item && item.settings) || {};
        var src = (s.crop_mode === 'manual' && item.croppedFile) ? item.croppedFile : file;
        var spec = (s.page_spec && s.page_spec !== 'all') ? String(s.page_spec) : 'all';

        // Only a PDF can be trimmed; an image is a single page either way.
        if (spec === 'all' || extOf(src.name) !== 'pdf') {
          acc.push(src);
          return acc;
        }
        var nums = spec.split(',').map(function (n) { return parseInt(n, 10); })
          .filter(function (n) { return n > 0; });
        if (!nums.length) { acc.push(src); return acc; }

        return extractPdfPages(src, nums).then(function (trimmed) {
          acc.push(trimmed);
          return acc;
        });
      });
    }, Promise.resolve([]));
  }

  /* Combine a batch BY TYPE, keeping the two kinds apart.
   *
   * PDFs are paged documents, so several of them genuinely are one document
   * and are merged - after each file's own page selection has been applied.
   *
   * Images are NOT merged. Brightness and contrast are applied by the print
   * worker, and only when the file it downloads is still an image; merging
   * photos into one PDF would silently drop the adjustments the customer set.
   * Keeping them separate also means each photo keeps its OWN settings, which
   * is what "independent settings" means - two photos with different
   * adjustments cannot share one combined document.
   *
   * A DOC/DOCX has no client-side renderer, so a document group is only merged
   * when every member is a PDF. Anything else is left as its own job rather
   * than failing the whole batch.
   *
   * Returns items shaped like the originals, so the upload loop is unchanged.
   */
  function combineByType(items) {
    var docs = [];
    var images = [];
    items.forEach(function (it) {
      (isImage(it.file.name) ? images : docs).push(it);
    });

    if (!docs.length) return Promise.resolve(images);

    var allPdf = docs.every(function (it) { return extOf(it.file.name) === 'pdf'; });
    if (docs.length < 2 || !allPdf) {
      return Promise.resolve(docs.concat(images));
    }

    return prepareForMerge(docs).then(function (files) {
      return mergeIntoPdf(files).then(function (merged) {
        var anyColor = docs.some(function (it) {
          return it.settings && it.settings.color === 'color';
        });
        var first = (docs[0] && docs[0].settings) || {};
        return [{
          file: merged.file,
          thumb: null,
          croppedFile: null,
          pdfPages: merged.pages,
          _mergedFrom: docs.map(function (it) { return it.file.name; }),
          settings: {
            color: anyColor ? 'color' : (first.color || 'bw'),
            copies: first.copies || 1,
            sides: first.sides || 'single',
            pages: merged.pages,
            page_spec: 'all',
            // A merged document is no longer an image, so it carries no
            // adjustment: sending one would be a value nothing can apply.
            brightness: 0,
            contrast: 0,
            crop_mode: 'none'
          }
        }].concat(images);
      });
    });
  }

  return {
    parse: parse,
    compress: compress,
    extractPdfPages: extractPdfPages,
    mergeIntoPdf: mergeIntoPdf,
    prepareForMerge: prepareForMerge,
    combineByType: combineByType,
    shareableSettings: shareableSettings,
    isImage: isImage,
    extOf: extOf
  };
})();