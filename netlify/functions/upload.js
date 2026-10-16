const { json, err, supabaseRequest, validateSession, generateJobId, calculatePrice, assignUniqueMatchAmount, createJobWithUniqueFee, assignUniqueOrderTotal, ALLOWED_EXTENSIONS, SUPABASE_URL, supabaseStorageSignedUrl, parseMultipartFormData, EXT_MIME_MAP, JOB_PAYABLE_WINDOW_MIN, supabaseStorageUpload } = require('./_shared');

// A guest uploading without an account gets one file only: they have no
// identity, so a bundle of theirs could not be attributed to them when a
// payment arrives, and their PIN is collected on paper. Members may bundle up
// to MAX_BUNDLE_FILES.
const MAX_BUNDLE_FILES = 5;
// Per-file upload ceiling. The client checks the same number before it starts,
// and check-order-payment.js fails if the two ever drift - a limit that is
// enforced in only one place produces "it worked on one page" bugs.
//
// Kept as one constant in MB so the message and the byte count cannot disagree.
const MAX_FILE_MB = 50;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

// Validate and normalise the order reference a file belongs to.
//
// Guests get one file per order and no order at all, because an unattributable
// guest bundle cannot be matched to a payment later. Members may bundle up to
// MAX_BUNDLE_FILES.
//
// This never rejects. An earlier version returned "Missing order reference" when
// a signed-in upload arrived without one, which turned any disagreement between
// what the client thought it was sending and what the server saw into a hard
// upload failure. The real case was upload.html opened via the kiosk guest QR
// (?guest=1 clears the token) while a session was still present server-side, so
// the client withheld order_id, the server saw a member, and refused.
//
// Instead: guests have the reference stripped and are always a single file;
// members use whatever the client sent, and a missing one simply means a
// single-file order. Only the bundle cap is a hard limit, because exceeding it
// would build an order the payment step could not settle.
async function resolveOrderId(raw, userId) {
  const sent = String(raw || '').trim().slice(0, 40);

  if (!userId) {
    // A guest is always single-file. Any order reference they sent is dropped
    // rather than refused.
    return { orderId: null };
  }

  if (!sent || !/^[A-Za-z0-9_-]{8,40}$/.test(sent)) {
    return { orderId: null };
  }

  const existing = await supabaseRequest('GET', '/print_jobs', null, {
    'order_id': 'eq.' + sent,
    'select': 'id'
  });
  const already = !existing.error && Array.isArray(existing.data) ? existing.data.length : 0;
  if (already >= MAX_BUNDLE_FILES) {
    return { error: 'An order can contain at most ' + MAX_BUNDLE_FILES + ' files. Start a new upload to send more.' };
  }

  return { orderId: sent };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  const url = new URL(event.rawUrl);

  if (event.httpMethod === 'GET' && url.searchParams.get('action') === 'lookup-pin') {
    return handleLookupPin(url);
  }

  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  if (url.searchParams.get('action') === 'sign-upload') {
    return handleSignUpload(event);
  }

  // Final step of a batch: computes what the customer must actually pay for the
  // whole order and records it against every file in it.
  if (url.searchParams.get('action') === 'seal-order') {
    return handleSealOrder(event);
  }

  return handleUpload(event);
};

// Returns a signed upload URL so the browser can PUT bytes directly to Supabase
// Storage, bypassing Netlify's 6MB request-body limit entirely.
async function handleSignUpload(event) {
  const session = await validateSession(event);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return err('Invalid request body');
  }

  const fileName = String(body.file_name || '');
  if (!fileName || !ALLOWED_EXTENSIONS.includes(getExtension(fileName))) {
    return err('File type not allowed. Allowed: ' + ALLOWED_EXTENSIONS.join(', '));
  }

  const size = parseInt(body.file_size, 10);
  if (!size || size <= 0) return err('file_size required');
  if (size > MAX_FILE_BYTES) return err('File too large. Maximum ' + MAX_FILE_MB + 'MB.');

  const ext = getExtension(fileName);
  const contentType = EXT_MIME_MAP[ext] || 'application/octet-stream';

  const jobId = generateJobId();
  const safeName = 'print_' + Date.now() + '_' + fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = jobId + '/' + safeName;

  const signed = await supabaseStorageSignedUrl('print-jobs', storagePath);
  if (signed.error) {
    return err('Failed to create upload URL: ' + signed.message, 500);
  }

  return json({
    success: true,
    job_id: jobId,
    storage_path: storagePath,
    upload_url: signed.uploadUrl,
    public_url: SUPABASE_URL + '/storage/v1/object/public/print-jobs/' + storagePath,
    content_type: contentType
  });
}

async function handleLookupPin(url) {
  const pin = url.searchParams.get('pin') || '';
  if (!pin || !/^\d{6}$/.test(pin)) return err('Invalid PIN');

  const result = await supabaseRequest('GET', '/print_jobs', null, {
    'print_pin': 'eq.' + pin,
    'select': '*',
    'status': 'not.in.(completed,refund_issued,cancelled,failed)',
    'order': 'created_at.asc'
  });

  if (result.error || !result.data || result.data.length === 0) {
    return json({ success: false, 'error': 'No job found with this PIN' });
  }

  return json({ success: true, jobs: result.data, job: result.data[0] });
}

function getExtension(filename) {
  return (filename || '').split('.').pop().toLowerCase();
}

function isImage(ext) {
  return ['jpg', 'jpeg', 'png'].includes(ext);
}

// Seal an order: work out exactly what the customer must pay for the whole
// batch, and record it against every file in it.
//
// The amount is computed from the DATABASE's own job totals, never from what
// the browser claims. The client only says which files belong together; the sum
// and the unique offset are ours.
//
// A single-file order keeps its existing job total untouched, so the amount a
// one-file customer is quoted does not change with this feature.
async function handleSealOrder(event) {
  const session = await validateSession(event);
  const userId = session ? session.user_id : null;
  if (!userId) return err('Only signed-in customers can place a multi-file order', 403);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Invalid request body'); }

  const orderId = String(body.order_id || '').trim().slice(0, 40);
  if (!orderId || !/^[A-Za-z0-9_-]{8,40}$/.test(orderId)) return err('Invalid order reference');

  const found = await supabaseRequest('GET', '/print_jobs', null, {
    'order_id': 'eq.' + orderId,
    'user_id': 'eq.' + userId,
    'select': 'id,job_id,total_price,base_price,match_fee,paid,status'
  });
  if (found.error) return err('Failed to read order', 500);
  const jobs = Array.isArray(found.data) ? found.data : [];

  if (!jobs.length) return err('No files found for this order', 404);
  if (jobs.length > MAX_BUNDLE_FILES) {
    return err('An order can contain at most ' + MAX_BUNDLE_FILES + ' files');
  }
  if (jobs.some(j => j.paid === true)) return err('This order has already been paid');

  // Charge the items plus ONE matching fee for the whole payment.
  //
  // Every job was given its own small match fee when it was created, so two
  // live jobs could never share a total. That was the right unit when one
  // payment settled one job. For a multi-file order the customer makes ONE
  // payment, so the fee is charged once - not once per file.
  //
  // Summing the inflated job totals charged RM0.86 for four files whose items
  // totalled RM0.80: four separate fees of 0.01-0.03 stacked up, pushing the
  // overhead towards 10% of a small order. The order total is therefore built
  // from base_price, which excludes every per-job fee, plus one order fee.
  const sumBase = jobs.reduce(function (s, j) {
    const b = parseFloat(j.base_price);
    return s + (Number.isNaN(b) ? (parseFloat(j.total_price) || 0) : b);
  }, 0);
  // Reserve every amount that could still be matched to a payment, so this
  // order's total cannot collide with another live one.
  //
  // Both fields are reserved, and the window is the same 60 minutes the matcher
  // uses. Reserving only order_total let a single-file job's total_price equal
  // a multi-file order's order_total; reserving for a shorter window than the
  // matcher let an amount be re-issued while the original order was still a
  // candidate. Either way two orders ended up on one figure, and the matcher
  // parks such a payment for staff review rather than guessing - so the
  // customer paid the amount they were shown and it never settled.
  const sealCutoff = new Date(Date.now() - JOB_PAYABLE_WINDOW_MIN * 60 * 1000).toISOString();
  const liveOrders = await supabaseRequest('GET', '/print_jobs', null, {
    'paid': 'eq.false',
    'status': 'eq.pending',
    // No "order_total is not null" filter: unsealed single-file orders are
    // matched against their job total and must be reserved too.
    'select': 'order_total,total_price',
    'created_at': 'gte.' + sealCutoff,
    'limit': '500'
  });

  const usedTotals = [];
  if (!liveOrders.error && Array.isArray(liveOrders.data)) {
    for (const j of liveOrders.data) {
      for (const field of ['order_total', 'total_price']) {
        const v = parseFloat(j[field]);
        if (!Number.isNaN(v)) usedTotals.push(v);
      }
    }
  }
  // This order's own current total must not block it.
  for (const j of jobs) {
    const v = parseFloat(j.total_price);
    if (!Number.isNaN(v)) usedTotals.push(v);
  }

  let orderTotal;
  if (jobs.length === 1) {
    // One file: its job total is already unique, and adding a fee here would
    // charge a single-file customer something they were never quoted.
    orderTotal = parseFloat(jobs[0].total_price);
  } else {
    orderTotal = assignUniqueOrderTotal(sumBase, usedTotals).total;
  }

  const ids = jobs.map(j => j.job_id);
  const upd = await supabaseRequest('PATCH', '/print_jobs?order_id=eq.' + orderId, {
    'order_total': orderTotal
  });
  if (upd.error) {
    return err('Failed to record the order total. Has migration 20261015_orders run?', 500);
  }

  return json({
    success: true,
    order_id: orderId,
    order_total: orderTotal,
    item_total: Math.round(sumBase * 100) / 100,
    fee: Math.round((orderTotal - sumBase) * 100) / 100,
    files: jobs.length,
    job_ids: ids
  });
}

async function handleUpload(event) {
  const session = await validateSession(event);
  const userId = session ? session.user_id : null;

  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

  let fileUrl = '';
  let fileName = '';
  let fileType = 'document';
  let colorMode = 'bw';
  let paperSize = 'a4';
  let sides = 'single';
  let copies = 1;
  let pages = 1;
  let brightness = 0;
  let contrast = 0;
  let cropMode = 'none';
  let finish = 'none';
  let printPin = '';

  const requestedPin = (value) => {
    const pin = String(value || '').trim();
    return /^\d{6}$/.test(pin) ? pin : '';
  };

  if (contentType.includes('multipart/form-data')) {
    let rawBody;
    if (event.isBase64Encoded) {
      rawBody = Buffer.from(event.body, 'base64');
    } else {
      rawBody = Buffer.from(event.body || '', 'binary');
    }

    const { fields, file } = parseMultipartFormData(rawBody, contentType);

    if (!file || !file.data || file.data.length === 0) {
      return err('No file uploaded');
    }

    const ext = getExtension(file.filename);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return err('File type not allowed. Allowed: ' + ALLOWED_EXTENSIONS.join(', '));
    }
    if (file.data.length > MAX_FILE_BYTES) {
      return err('File too large. Maximum ' + MAX_FILE_MB + 'MB.');
    }

    // Order identity. Every file in one upload batch carries the same order_id,
    // which is what lets a single payment settle the whole order.
    const order = await resolveOrderId(fields.order_id, userId);
    if (order.error) return err(order.error);
    const orderId = order.orderId;

    colorMode = ['bw', 'color'].includes(fields.color_mode) ? fields.color_mode : 'bw';
    paperSize = ['a4', 'a3'].includes(fields.paper_size) ? fields.paper_size : 'a4';
    sides = ['single', 'double'].includes(fields.sides) ? fields.sides : 'single';
    copies = Math.max(1, parseInt(fields.copies) || 1);
    pages = Math.max(1, parseInt(fields.pages) || 1);
    brightness = parseInt(fields.brightness) || 0;
    contrast = parseInt(fields.contrast) || 0;
    // How many pages of a combined job the customer wanted in colour.
    let colorPages = parseInt(fields.color_pages);
    if (!Number.isFinite(colorPages)) colorPages = null;
    if (colorPages !== null && (colorPages < 0 || colorPages > pages)) colorPages = null;
    cropMode = fields.crop_mode || 'none';
    finish = fields.finish || 'none';
    printPin = requestedPin(fields.print_pin);

    const jobId = generateJobId();
    const safeName = 'print_' + Date.now() + '_' + (file.filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = jobId + '/' + safeName;

    const storageResult = await supabaseStorageUpload('print-jobs', storagePath, file.data, file.contentType);
    if (storageResult.error) {
      return err('Failed to store file: ' + storageResult.message, 500);
    }

    fileUrl = SUPABASE_URL + '/storage/v1/object/public/print-jobs/' + storagePath;
    fileName = file.filename || 'upload.' + ext;
    fileType = isImage(ext) ? 'image' : 'document';

    if (!printPin) printPin = String(Math.floor(100000 + Math.random() * 900000));

    const pageSpec = String(fields.page_spec || '').trim() || 'all';
    const selectionMode = pageSpec === 'all' ? 'all' : 'custom';
    const basePrice = calculatePrice(pages, colorMode, paperSize, sides, copies, colorPages);
    const pricing = await assignUniqueMatchAmount(basePrice);

    const jobData = {
      job_id: jobId,
      user_id: userId,
      session_id: require('crypto').randomBytes(16).toString('hex'),
      // Null for a guest's single file; shared by every file in a member's order.
      order_id: orderId || null,
      file_name: fileName,
      file_path: fileUrl,
      file_type: fileType,
      pages, color_mode: colorMode, paper_size: paperSize, sides, copies,
      brightness, contrast, crop_mode: cropMode, finish,
      __basePrice: basePrice,
      total_price: pricing.total,
      status: 'pending',
      paid: false,
      print_pin: printPin
    };

    // Allocate a unique total and insert atomically-ish: if another upload took
    // this exact total in the same instant, retry with the next free slot
    // instead of creating a second job with an identical price.
    const { result, pricing: usedPricing } = await createJobWithUniqueFee(jobData, {
      page_spec: pageSpec,
      selection_mode: selectionMode
    });

    if (result.error) {
      // Fall back to the pre-migration column set so the site keeps working if
      // the lifecycle columns are not present yet.
      const legacy = Object.assign({}, jobData, { total_price: usedPricing ? usedPricing.total : basePrice });
      result = await supabaseRequest('POST', '/print_jobs', legacy);
      if (result.error) {
        return err('Failed to create print job: ' + (result.message || ''), 500);
      }
    }

    const createdJob = result.data[0];

    // Fully covered by coins (or zero-value) -> no payment needed at all.
    if (Number(createdJob.total_price) === 0) {
      await autoConfirmFreeJob(createdJob);
      const refreshed = await supabaseRequest('GET', '/print_jobs', null, {
        'job_id': 'eq.' + jobId, 'select': '*', 'limit': '1'
      });
      const finalJob = (!refreshed.error && refreshed.data && refreshed.data[0]) ? refreshed.data[0] : createdJob;

      return json({
        success: true,
        job: finalJob,
        print_pin: printPin,
        auto_paid: true,
        message: 'Fully covered by coins - no payment needed'
      });
    }

    return json({
      success: true,
      job: finalSafeJob(createdJob, pricing, colorPages),
      print_pin: printPin,
      message: 'File uploaded successfully'
    });

  } else {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return err('Invalid request body');
    }

    fileUrl = body.file_url || '';
    fileName = body.file_name || '';
    const ext = getExtension(fileName);
    fileType = body.file_type || (isImage(ext) ? 'image' : 'document');

if (!fileUrl || !fileName) return err('file_url and file_name required');
    if (!ALLOWED_EXTENSIONS.includes(ext)) return err('File type not allowed');
    if (fileType !== 'image' && fileType !== 'document') return err('file_type must be image or ');

    const order2 = await resolveOrderId(body.order_id, userId);
    if (order2.error) return err(order2.error);
    const orderId = order2.orderId;

    colorMode = ['bw', 'color'].includes(body.color_mode) ? body.color_mode : 'bw';
    paperSize = ['a4', 'a3'].includes(body.paper_size) ? body.paper_size : 'a4';
    sides = ['single', 'double'].includes(body.sides) ? body.sides : 'single';
    copies = Math.max(1, parseInt(body.copies) || 1);
    pages = Math.max(1, parseInt(body.pages) || 1);
    brightness = parseInt(body.brightness) || 0;
    contrast = parseInt(body.contrast) || 0;
// How many pages of a combined job the customer wanted in colour.
let colorPages = parseInt(body.color_pages);
if (!Number.isFinite(colorPages)) colorPages = null;
if (colorPages !== null && (colorPages < 0 || colorPages > pages)) colorPages = null;

    // Which pages are in which colour mode, for a merged job that holds more than
    // one. This is what makes the PRINT match the price: without it the whole
    // document goes to CUPS as one submission with one ColorModel, and the
    // black-and-white pages print in colour too.
    //
    // Validated hard and then dropped rather than trusted. It arrives from a
    // browser, and a malformed run would otherwise become -o page-ranges on a
    // real lp command line. Anything not a clean, ordered, in-bounds cover of
    // 1..pages is discarded, and the job simply prints in one mode - the
    // previous behaviour, and safe.
    let colorRuns = null;
    {
      const raw = body.color_runs;
      let parsed = null;
      if (typeof raw === 'string' && raw.trim()) {
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      } else if (Array.isArray(raw)) {
        parsed = raw;
      }
      colorRuns = sanitiseColorRuns(parsed, pages);
    }
    cropMode = body.crop_mode || 'none';
    finish = body.finish || 'none';
    printPin = requestedPin(body.print_pin);
    if (!printPin) printPin = String(Math.floor(100000 + Math.random() * 900000));

    const jobId = body.job_id || generateJobId();

    const pageSpec = String(body.page_spec || '').trim() || 'all';
    const selectionMode = pageSpec === 'all' ? 'all' : 'custom';
    const basePrice = calculatePrice(pages, colorMode, paperSize, sides, copies, colorPages);
    const pricing = await assignUniqueMatchAmount(basePrice);

    const jobData = {
      job_id: jobId,
      user_id: userId,
      session_id: require('crypto').randomBytes(16).toString('hex'),
      // Null for a guest's single file; shared by every file in a member's order.
      order_id: orderId || null,
      file_name: fileName,
      file_path: fileUrl,
      file_type: fileType,
      pages, color_mode: colorMode, paper_size: paperSize, sides, copies,
      brightness, contrast, crop_mode: cropMode, finish,
      __basePrice: basePrice,
      total_price: pricing.total,
      status: 'pending',
      paid: false,
      print_pin: printPin
    };

    const { result, pricing: usedPricing } = await createJobWithUniqueFee(jobData, {
      page_spec: pageSpec,
      selection_mode: selectionMode
    });

    if (result.error) {
      const legacy = Object.assign({}, jobData, { total_price: usedPricing ? usedPricing.total : basePrice });
      result = await supabaseRequest('POST', '/print_jobs', legacy);
      if (result.error) {
        return err('Failed to create print job: ' + (result.message || ''), 500);
      }
    }
    const createdJob = result.data[0];

    if (Number(createdJob.total_price) === 0) {
      await autoConfirmFreeJob(createdJob);
      const refreshed = await supabaseRequest('GET', '/print_jobs', null, {
        'job_id': 'eq.' + jobId, 'select': '*', 'limit': '1'
      });
      const finalJob = (!refreshed.error && refreshed.data && refreshed.data[0]) ? refreshed.data[0] : createdJob;

      return json({
        success: true,
        job: finalJob,
        print_pin: printPin,
        auto_paid: true,
        message: 'Fully covered by coins - no payment needed'
      });
    }

    return json({
      success: true,
      job: finalSafeJob(createdJob, pricing, colorPages),
      print_pin: printPin,
      message: 'File uploaded successfully'
    });
  }
}

// Attach the pricing breakdown so the client can show "RM0.20 + RM0.01 match fee".
/**
 * Accept a colour-run layout only if it is a clean, ordered, gapless cover of
 * 1..pages with both modes present. Returns null for anything else, so a
 * malformed payload degrades to printing the whole document in one mode rather
 * than to a bad page-ranges argument.
 */
function sanitiseColorRuns(parsed, pages) {
  const total = parseInt(pages, 10) || 0;
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  if (total < 2) return null;

  const runs = [];
  let cursor = 1;
  for (const r of parsed) {
    if (!r || typeof r !== 'object') return null;
    const from = parseInt(r.from, 10);
    const to = parseInt(r.to, 10);
    const color = r.color === 'color' ? 'color' : (r.color === 'bw' ? 'bw' : null);
    if (!color) return null;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (from !== cursor) return null;          // must be contiguous and in order
    if (to < from || to > total) return null;
    runs.push({ from, to, color });
    cursor = to + 1;
  }
  if (cursor !== total + 1) return null;       // must cover every page exactly once

  // Only worth sending when it actually changes something. A single mode keeps
  // the single-submission path.
  if (!runs.some((r) => r.color === 'color') || !runs.some((r) => r.color === 'bw')) {
    return null;
  }
  return JSON.stringify(runs);
}

function finalSafeJob(job, pricing, colorPages) {
  return Object.assign({}, job, {
    base_price: job.base_price != null ? job.base_price : pricing.base,
    match_fee: job.match_fee != null ? job.match_fee : pricing.fee,
    // How many pages are colour, echoed back rather than stored.
    //
    // There is no color_pages column, so the split lives only in the request that
    // priced this job. The page then had no way to tell a wholly-colour job from
    // one that is half colour and half black and white, and showed "Color" for
    // both - so a customer who merged a B&W document with a colour one was told
    // the whole job was colour.
    //
    // Not persisted deliberately: it is a property of this request, and a column
    // nothing reads back is a second place for the two to disagree.
    color_pages: (colorPages === undefined) ? null : colorPages
  });
}

// A job whose total is RM0.00 needs no QR scan - mark it ready immediately.
async function autoConfirmFreeJob(job) {
  const reference = 'FREE-' + job.job_id;

  await supabaseRequest('POST', '/payments', {
    print_job_id: job.id,
    user_id: job.user_id,
    amount: 0,
    method: 'coins_full',
    reference,
    status: 'confirmed',
    notified_at: new Date().toISOString()
  });

  const updateResult = await supabaseRequest('PATCH', '/print_jobs?id=eq.' + job.id, {
    status: 'ready_to_print',
    paid: true,
    payment_ref: reference,
    updated_at: new Date().toISOString()
  });

  if (updateResult.error) return;

  let coinsEarned = 0;
  if (job.user_id) {
    coinsEarned = 1;
    const userResult = await supabaseRequest('GET', '/users', null, {
      'id': 'eq.' + job.user_id, 'select': 'coins'
    });
    if (!userResult.error && userResult.data && userResult.data.length > 0) {
      const currentCoins = userResult.data[0].coins;
      const newBalance = currentCoins + coinsEarned;
      await supabaseRequest('PATCH', '/users?id=eq.' + job.user_id, { coins: newBalance });
      await supabaseRequest('POST', '/coin_transactions', {
        user_id: job.user_id,
        print_job_id: job.id,
        type: 'earned',
        amount: coinsEarned,
        description: 'Print job ' + job.job_id,
        balance_after: newBalance
      });
    }
  }

  await supabaseRequest('POST', '/alerts', {
    type: 'payment_received',
    message: 'Print job ' + job.job_id + ' fully covered by coins - no payment required',
    severity: 'info',
    is_read: false
  });
}
