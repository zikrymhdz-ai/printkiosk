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

  /* Identify a file from its own bytes, not from its name.
   *
   * Trusting the extension broke as soon as one step produced a file whose
   * name no longer matched its contents: a photo adjusted in the browser is
   * re-encoded as PNG, and handing those bytes to embedJpg() failed with
   * "SOI not found in JPEG". A name is a label; these bytes are the truth.
   */
  function sniffFormat(buf) {
    var b = new Uint8Array(buf);
    if (b.length > 3 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
    if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    if (b.length > 2 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    return null;
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

        return file.arrayBuffer().then(function (buf) {
          var real = sniffFormat(buf);

          if (real === 'pdf') {
            return PDFLib.PDFDocument.load(buf).then(function (src) {
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

          if (real === 'png' || real === 'jpeg') {
            var ready2 = out ? Promise.resolve(out) : PDFLib.PDFDocument.create();
            return ready2.then(function (doc) {
              out = doc;
              // Dispatch on the sniffed format, never on the file name.
              return (real === 'png' ? out.embedPng(buf) : out.embedJpg(buf))
                .then(function (img) {
                  // pdf-lib's addPage takes POINTS, but img.width/height are
                  // PIXELS. Passing them straight through turned a 12MP phone
                  // photo into a 55 x 41 inch page - six times A4 - and the
                  // printer sat on "Receiving data" and never printed anything.
                  // A single photo was fine because the worker converts those
                  // itself at 300dpi, which is why only merged batches stalled.
                  //
                  // The page is sized to the image's own aspect ratio, bounded
                  // by A4 in either orientation, and the image fills it. That is
                  // always printable - a 1px thumbnail no longer produces a
                  // 0.24pt page - and a landscape photo gets a landscape sheet
                  // rather than being squashed onto portrait.
                  var A4_LONG = 842, A4_SHORT = 595;
                  var ar = img.width / img.height;
                  if (!isFinite(ar) || ar <= 0) ar = 1;
                  var pageW, pageH;
                  if (ar >= 1) {
                    pageW = Math.min(A4_LONG, A4_SHORT * ar);
                    pageH = pageW / ar;
                  } else {
                    pageH = Math.min(A4_SHORT, A4_LONG / ar);
                    pageW = pageH * ar;
                  }
                  // Guard against a degenerate page even for a 1-pixel image.
                  pageW = Math.max(1, pageW);
                  pageH = Math.max(1, pageH);
                  var page = out.addPage([pageW, pageH]);
                  page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
                  images++;
                  pages += 1;
                  sources[sources.length - 1].pages = 1;
                });
            });
          }

          // Unreadable, or a DOC/DOCX which has no client-side renderer. A
          // single such file needs no merging, so let it through; refuse it
          // only when it would have to be combined with something else.
          if (items.length === 1) {
            return { file: file, pages: null, images: 0, sources: sources };
          }

          if (ext === 'doc' || ext === 'docx') {
            return Promise.reject(new Error(
              name + ': DOC and DOCX cannot be combined with other documents. '
              + 'Upload it on its own.'));
          }

          return Promise.reject(new Error(
            name + ': this file is not a readable PDF, JPG or PNG, so it cannot '
            + 'be combined. Please upload it on its own.'));
        });
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

  function canAdjustPixels() {
    return typeof document !== 'undefined'
      && typeof document.createElement === 'function'
      && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  }

  /* Bake brightness/contrast into an image, in the browser.
   *
   * The print worker applies these only when the file it downloads is still an
   * image. Combining photos into one PDF would therefore silently discard the
   * customer's adjustments, so they are applied here first - using the same
   * formulas, and the same order, as the preview and the worker:
   * grayscale, then brightness (a plain multiply), then contrast (linear about
   * mid grey). Grayscale itself is left to the print option, exactly as it is
   * for a document, so colour handling stays consistent across both kinds.
   */
  function adjustImageFile(file, brightness, contrast, grayscale) {
    return new Promise(function (resolve, reject) {
      var url;
      try {
        url = URL.createObjectURL(file);
      } catch (e) {
        reject(new Error('Could not read ' + (file.name || 'image')));
        return;
      }
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          var b = _clamp(brightness) / 100;
          var c = _clamp(contrast) / 100;
          if (b || c || grayscale) {
            var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var px = data.data;
            for (var i = 0; i < px.length; i += 4) {
              var r = px[i], g = px[i + 1], bl = px[i + 2];
              if (grayscale) {
                // Rec. 601 luma, the same weighting the preview's CSS
                // grayscale filter uses.
                var y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
                r = g = bl = y;
              }
              if (b) { r *= 1 + b; g *= 1 + b; bl *= 1 + b; }
              if (c) {
                r = (r - 127.5) * (1 + c) + 127.5;
                g = (g - 127.5) * (1 + c) + 127.5;
                bl = (bl - 127.5) * (1 + c) + 127.5;
              }
              px[i] = r < 0 ? 0 : (r > 255 ? 255 : r);
              px[i + 1] = g < 0 ? 0 : (g > 255 ? 255 : g);
              px[i + 2] = bl < 0 ? 0 : (bl > 255 ? 255 : bl);
            }
            ctx.putImageData(data, 0, 0);
          }

          var wasJpegOutput = extOf(file.name) === 'jpg' || extOf(file.name) === 'jpeg';
          canvas.toBlob(function (blob) {
            if (!blob) { reject(new Error('Could not adjust ' + (file.name || 'image'))); return; }
            // Keep the source's format. This used to always write PNG, which is
            // lossless and therefore enormous next to a JPEG - a phone photo
            // could balloon from a few MB to tens of MB, and the combined
            // document was then rejected on upload with "object exceeded the
            // maximum allowed size". JPEG in, JPEG out: the printed result is
            // indistinguishable at 0.92 and the file stays about the same size
            // the customer chose to upload.
            //
            // The name must match the bytes, or mergeIntoPdf()'s sniffer and
            // the JPEG branch disagree - that mismatch previously produced
            // "SOI not found in JPEG".
            var wasJpeg = wasJpegOutput;
            var stem = String(file.name || 'image').replace(/\.[^.]*$/, '');
            var type = wasJpeg ? 'image/jpeg' : 'image/png';
            resolve(new File([blob], wasJpeg ? stem + '.jpg' : stem + '.png', { type: type }));
          }, wasJpegOutput ? 'image/jpeg' : 'image/png', wasJpegOutput ? 0.92 : undefined);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read ' + (file.name || 'image')));
      };
      img.src = url;
    });
  }

  function _clamp(v) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return 0;
    return Math.max(-100, Math.min(100, n));
  }

  /* Combine photos into ONE document.
   *
   * Each photo is rendered first with whatever the customer chose for it:
   * brightness/contrast, and greyscale when it was set to black and white.
   * Baking the greyscale in is what lets photos with DIFFERENT colour modes
   * share one job - the combined PDF is printed as colour, and the pages the
   * customer wanted in black and white are already black and white in the
   * pixels. The price is then worked out per page, not per job.
   *
   * If that cannot be done - no canvas, or the read fails - the photos stay
   * separate rather than being merged and losing what was chosen.
   */
  function combineImages(items) {
    var needsCanvas = items.some(function (it) {
      var s = it.settings || {};
      return _clamp(s.brightness) !== 0 || _clamp(s.contrast) !== 0
        || (s.color || 'bw') !== 'color';
    });
    if (needsCanvas && !canAdjustPixels()) return Promise.resolve(null);

    return items.reduce(function (chain, it) {
      return chain.then(function (acc) {
        var s = it.settings || {};
        var b = _clamp(s.brightness);
        var c = _clamp(s.contrast);
        var gray = (s.color || 'bw') !== 'color';
        var src = (s.crop_mode === 'manual' && it.croppedFile) ? it.croppedFile : it.file;
        if (!b && !c && !gray) { acc.push(src); return acc; }
        return adjustImageFile(src, b, c, gray).then(function (f) { acc.push(f); return acc; });
      });
    }, Promise.resolve([])).then(function (files) {
      return mergeIntoPdf(files);
    });
  }

  /* Combine a batch BY TYPE, keeping the two kinds apart.
   *
   * Within a type the files genuinely are one document, so they are merged:
   * several PDFs become one paged document, several photos become one sheet
   * sequence. A document and a photo are never combined - the page is expected
   * to refuse that up front with mixedTypes().
   *
   * A DOC/DOCX has no client-side renderer, so a document group is only merged
   * when every member is a PDF. Anything else is left as its own job rather
   * than failing the whole batch.
   *
   * Returns items shaped like the originals, so the upload loop is unchanged.
   */
  /* Split a batch into groups that can safely be combined.
   *
   * PHOTOS: grouped by sides and copies only. Photos may differ in colour,
   * because a black-and-white one is baked into the pixels before merging, so
   * one combined job can hold both - and the price is worked out per page.
   * Sides and copies are per-job, not per-page, so those must still agree.
   *
* DOCUMENTS: also grouped without colour, and deliberately. Documents used to
   * be split on colour, on the reasoning that a PDF page cannot be made black
   * and white without rasterising it, which would degrade the print. That is
   * true of the CONTENT, but it was never a reason to refuse the merge: a
   * combined job is printed with a single colour mode, so a B&W document
   * sharing a job with a colour one prints in colour mode.
   *
   * The trade is now explicit rather than avoided. The shop pays for the colour
   * pages it was going to print anyway plus the B&W pages that join them, and
   * the customer gets one document instead of two, with the price still split
   * per page. Separating them was never cheaper for the customer - it was two
   * documents instead of one - and B&W pages look the same printed in colour
   * mode, because black text is black either way. Refusing to merge was
   * optimising for a complaint nobody had made, at the cost of the one they had.
   *
   * Sides and copies remain per-job, not per-page, so those must still agree.
   *
   * File type is part of the key: a document and a photo are printed
   * differently, and the page refuses that batch up front via mixedTypes().
   *
   * Returns [[items...], [items...], ...] in first-seen order.
   */
  function combineGroups(items) {
    var groups = [];
    var byKey = {};
    (items || []).forEach(function (it) {
      var s = it.settings || {};
      var photo = isImage(it.file.name);
var key = photo
        ? 'image|' + (s.sides || 'single') + '|' + (s.copies || 1)
        : 'document|' + (s.sides || 'single') + '|' + (s.copies || 1);
      if (!byKey[key]) {
        byKey[key] = [];
        groups.push(byKey[key]);
      }
      byKey[key].push(it);
    });
    return groups;
  }

  function combineByType(items) {
    var groups = combineGroups(items);

    return groups.reduce(function (chain, group) {
      return chain.then(function (acc) {
        // A single file has nothing to combine with.
        if (group.length < 2) return acc.concat(group);

        var kind = isImage(group[0].file.name) ? 'image' : 'document';

        if (kind === 'image') {
          return combineImages(group).then(function (merged) {
            // Could not bake the adjustments in: keep them separate rather than
            // merging and silently losing what the customer dialled in.
            if (!merged) return acc.concat(group);
            return acc.concat([mergedItem(group, merged)]);
          });
        }

        // A DOC/DOCX has no client-side renderer, so documents are only merged
        // when every member is a PDF.
        var allPdf = group.every(function (it) { return extOf(it.file.name) === 'pdf'; });
        if (!allPdf) return acc.concat(group);

        return prepareForMerge(group).then(function (files) {
          return mergeIntoPdf(files).then(function (merged) {
            return acc.concat([mergedItem(group, merged)]);
          });
        });
      });
    }, Promise.resolve([]));
  }

/* Settings for a combined group.
   *
   * Every member shares sides and copies - the grouping guarantees it. Colour may
   * differ, so the combined job is printed in colour mode whenever any page
   * wanted colour, and colorPages records how MANY so the price is worked out per
   * page instead of charging the colour rate for all of them.
   */
  function mergedItem(members, merged) {
    var first = (members[0] && members[0].settings) || {};

    // How many pages this member actually contributes to the merge.
    //
    // settings.pages is what the customer is billed for - already reduced by any
    // page selection - so that is the number to count, not the file's full
    // length. Falling back to pdfPages covers a member whose selection has not
    // been resolved yet.
    function pagesOf(it) {
      var s = it.settings || {};
      var n = parseInt(s.pages, 10);
      if (!isFinite(n) || n < 1) n = parseInt(it.pdfPages, 10);
      return (isFinite(n) && n > 0) ? n : 1;
    }

    var colorPages = 0;
    members.forEach(function (it) {
      var s = it.settings || {};
      if ((s.color || 'bw') === 'color') colorPages += pagesOf(it);
    });

    // Never claim more colour pages than the merged document has. An
    // over-count bills the customer the colour rate for pages that are not
    // there, and it would be a silent overcharge rather than a visible one.
    if (colorPages > merged.pages) colorPages = merged.pages;

    return {
      file: merged.file,
      thumb: null,
      croppedFile: null,
      pdfPages: merged.pages,
      _mergedFrom: members.map(function (it) { return it.file.name; }),
      settings: {
        color: colorPages > 0 ? 'color' : 'bw',
        copies: first.copies || 1,
        sides: first.sides || 'single',
        pages: merged.pages,
        page_spec: 'all',
        brightness: 0,
        contrast: 0,
        crop_mode: 'none',
        color_pages: colorPages
      }
    };
  }

  /* Which kinds of file are in this batch?
   *
   * Documents and photos are printed differently - a PDF is paged and gets
   * combined, a photo is a single sheet the worker adjusts in its own right -
   * so mixing them in one order produces a document belonging to neither.
   * Returns the distinct extensions found on each side plus a mixed flag, so
   * the page can name the actual types in its message.
   */
  function mixedTypes(items) {
    var docs = [];
    var images = [];
    (items || []).forEach(function (it) {
      var name = (it && it.file && it.file.name) || '';
      var ext = extOf(name).toUpperCase() || 'FILE';
      var bucket = isImage(name) ? images : docs;
      if (bucket.indexOf(ext) === -1) bucket.push(ext);
    });
    return {
      docs: docs,
      images: images,
      mixed: docs.length > 0 && images.length > 0,
      all: docs.concat(images)
    };
  }

  return {
    parse: parse,
    compress: compress,
    extractPdfPages: extractPdfPages,
    mergeIntoPdf: mergeIntoPdf,
    prepareForMerge: prepareForMerge,
    sniffFormat: sniffFormat,
    combineByType: combineByType,
    combineGroups: combineGroups,
    mergedItem: mergedItem,
    combineImages: combineImages,
    adjustImageFile: adjustImageFile,
    shareableSettings: shareableSettings,
    mixedTypes: mixedTypes,
    isImage: isImage,
    extOf: extOf
  };
})();