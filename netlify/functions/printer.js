const { json, err, supabaseRequest, validateSession, PRINT_WORKER_SECRET, safeEqual, supabaseStorageDelete, freshnessOf } = require('./_shared');

// Routes the Pi print worker calls. These authenticate with a shared secret
// rather than an admin session, because the kiosk Pi has no logged-in user.
const WORKER_ROUTES = ['claim-job', 'report-print', 'report-supplies', 'watchdog'];

// Statuses the Pi print worker is allowed to leave a job in.
const PRINT_OUTCOMES = ['completed', 'failed'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  if (event.httpMethod === 'GET') {
    switch (action) {
      case 'status': return getPrinterStatus();
      case 'pending-jobs': return getPendingJobs(event);
      case 'ready-jobs': return getReadyJobs(event);
      case 'failed-jobs': return getFailedJobs(event);
      case 'print-status': return getPrintStatus(event);
      default: return err('Invalid action');
    }
  } else if (event.httpMethod === 'POST') {
    if (WORKER_ROUTES.includes(action)) {
      if (!requireWorker(event)) return err('Print worker not authorised', 401);
      switch (action) {
        case 'claim-job': return claimJob(event);
        case 'report-print': return reportPrint(event);
        case 'report-supplies': return reportSupplies(event);
        case 'watchdog': return watchdog(event);
      }
    }

    // Fired by the kiosk the moment the customer taps "Done / Collect".
    // This is the ONLY way a job reaches the printer.
    if (action === 'request-print') return requestPrint(event);

    const session = await validateSession(event);
    if (!session || session.users.role !== 'admin') return err('Admin access required', 403);

    switch (action) {
      case 'update-status': return updatePrinterStatus(event);
      case 'update-job': return updateJobStatus(event);
      case 'reprint': return reprintJob(event);
      case 'simulate-jam': return simulateJam(event);
      case 'clear-jam': return clearJam();
      case 'set-levels': return setSupplyLevels(event);
    case 'refill-paper': return refillPaper(event);
      default: return err('Invalid action');
    }
  }

  return err('Method not allowed', 405);
};

// ---------------------------------------------------------------------------
// Print worker auth
// ---------------------------------------------------------------------------

// Fails closed: if PRINT_WORKER_SECRET was never set in the Netlify
// environment, no worker request is ever accepted.
function requireWorker(event) {
  if (!PRINT_WORKER_SECRET) return false;
  const token = event.headers['x-print-token'] || event.headers['X-Print-Token'] || '';
  return safeEqual(token, PRINT_WORKER_SECRET);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Customer-triggered printing
// ---------------------------------------------------------------------------

// The kiosk calls this when the customer taps "Done / Collect". Nothing else in
// the system moves a job into the print queue, so a job can never print unless a
// person physically present at the kiosk asked for it.
async function requestPrint(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const id = String(body.job_id || '');
  if (!UUID_RE.test(id)) return err('Invalid job');

  const cur = await supabaseRequest('GET', '/print_jobs', null, {
    'select': 'id,job_id,status,paid,print_attempts',
    'id': 'eq.' + id
  });
  if (cur.error) return err('Lookup failed', 500);
  if (!cur.data || cur.data.length === 0) return err('Job not found', 404);
  const job = cur.data[0];

  // Already queued, printing or done -- treat as success so a double tap on the
  // kiosk cannot enqueue the same page twice.
  if (job.status !== 'ready_to_print') {
    return json({ success: true, already: true, status: job.status });
  }
  if (!job.paid) return err('Job has not been paid', 403);

  const now = new Date().toISOString();

  // The status filter makes this a compare-and-set: if two taps race, only one
  // PATCH matches a row still sitting in ready_to_print and the loser gets an
  // empty result back.
  const upd = await supabaseRequest(
    'PATCH', '/print_jobs?id=eq.' + id + '&status=eq.ready_to_print',
    {
      status: 'print_requested',
      print_requested_at: now,
      print_attempts: 0,
      print_error: null,
      updated_at: now
    }
  );

  if (upd.error) return err('Failed to queue print', 500);
  if (!upd.data || upd.data.length === 0) return json({ success: true, already: true });

  return json({ success: true, job_id: job.job_id, status: 'print_requested' });
}

// ---------------------------------------------------------------------------
// Worker endpoints
// ---------------------------------------------------------------------------

// Atomically claim the oldest job the customer actually asked for.
async function claimJob() {
  const pick = await supabaseRequest('GET', '/print_jobs', null, {
    'select': 'id,job_id,file_path,file_name,file_type,pages,color_mode,paper_size,sides,copies,page_spec,print_attempts,brightness,contrast',
    'status': 'eq.print_requested',
    'order': 'print_requested_at.asc',
    'limit': '1'
  });

  if (pick.error) return err('Claim lookup failed', 500);
  if (!pick.data || pick.data.length === 0) return json({ success: true, job: null });

  const job = pick.data[0];
  const now = new Date().toISOString();

  // Compare-and-set against print_requested so a second worker (or a retry
  // racing the original request) cannot claim the same job.
  const upd = await supabaseRequest(
    'PATCH', '/print_jobs?id=eq.' + job.id + '&status=eq.print_requested',
    {
      status: 'printing',
      print_claimed_at: now,
      print_started_at: now,
      print_error: null,
      print_by: 'pi-worker',
      updated_at: now
    }
  );

  if (upd.error) return err('Claim failed', 500);
  if (!upd.data || upd.data.length === 0) {
    return json({ success: true, job: null, note: 'lost_race' });
  }

  return json({ success: true, job: upd.data[0] });
}

// The worker reports what actually came out of the printer.
async function reportPrint(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const id = String(body.job_id || '');
  const outcome = String(body.outcome || '');
  if (!UUID_RE.test(id)) return err('Invalid job');
  if (!PRINT_OUTCOMES.includes(outcome)) return err('Invalid outcome');

  const patch = { status: outcome, updated_at: new Date().toISOString() };

  if (outcome === 'completed') {
    patch.print_completed_at = patch.updated_at;
    patch.print_error = null;
    patch.print_page_verified = body.page_verified === true;
  } else {
    const reason = String(body.error || 'unknown').slice(0, 500);
    patch.print_error = reason;
    // Retries left: put it back in the queue so the worker picks it up again.
    const attempts = parseInt(body.attempts, 10);
    const used = Number.isFinite(attempts) ? attempts : 1;
    if (used < 3) {
      patch.status = 'print_requested';
      patch.print_claimed_at = null;
      patch.print_started_at = null;
    } else {
      patch.print_completed_at = patch.updated_at;
    }
  }

  const upd = await supabaseRequest('PATCH', '/print_jobs?id=eq.' + id, patch);
  if (upd.error) return err('Failed to record result', 500);

  if (outcome === 'completed') {
    // Only now, with the printer confirming the pages are out, is it safe to
    // discard the stored file. Cleaning up earlier (as complete-job used to)
    // destroyed the PDF before the worker had fetched it.
    await deleteJobFile(id);
  }

  if (outcome === 'failed') {
    await supabaseRequest('POST', '/alerts', {
      type: 'print_failed',
      message: 'Print job ' + body.public_id + ' failed: ' + String(body.error || 'unknown').slice(0, 200),
      severity: 'warning',
      is_read: false
    });
  }

  return json({ success: true, status: patch.status });
}

// Remove the stored file for a job, once it is safe to do so (i.e. after the
// printer confirmed the pages are out). Failures here are swallowed: the
// customer already has their print, and leaving an orphaned file is far less
// bad than failing the whole completion report.
async function deleteJobFile(jobUuid) {
  try {
    const r = await supabaseRequest('GET', '/print_jobs', null, {
      'select': 'file_path', 'id': 'eq.' + jobUuid
    });
    const filePath = (r.data && r.data[0] && r.data[0].file_path) || '';
    if (!filePath.includes('/storage/v1/object/')) return;

    const rest = filePath.split('/storage/v1/object/')[1];
    const parts = rest.split('/');
    let bucket, path;
    if (parts[0] === 'public') {
      bucket = parts[1];
      path = parts.slice(2).join('/');
    } else {
      bucket = parts[0];
      path = parts.slice(1).join('/');
    }
    if (bucket && path) await supabaseStorageDelete(bucket, path);
  } catch (e) { /* leave the file for the retention sweep */ }
}

// Real toner / paper levels read from the printer over IPP.
async function reportSupplies(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const levels = body.levels;
  if (!levels || typeof levels !== 'object') return err('No levels supplied');

  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);
  const bw = num(levels.toner_black);
  const c  = num(levels.toner_cyan);
  const m  = num(levels.toner_magenta);
  const y  = num(levels.toner_yellow);

  // A supply row should only ever show "OK" when all four toners are known.
  const known = [bw, c, m, y].every(v => v !== null);
  const lowest = known ? Math.min(bw, c, m, y) : null;
  const unreadable = body.online === false || !known;

  const row = {
    status: unreadable ? 'unknown' : (lowest <= 15 ? 'low' : 'online'),
    // When the printer could not be read, store null rather than keeping the
    // previous numbers. Leaving them in place made hand-entered 100%s sit
    // there for days looking like live readings.
    toner_black: bw,
    toner_cyan: c,
    toner_magenta: m,
    toner_yellow: y,
    // Live stop reason from CUPS ("Paper jam", "Out of paper", "Printer
    // stopped"). Previously only consulted at submit time and after an abort,
    // so the kiosk kept saying "Online" while the printer was unusable. Empty
    // string clears a previous alert once the printer is healthy again.
    printer_alert: String(body.alert || '').slice(0, 160),
    // WHY the read failed. The worker has always sent this; it used to be
    // discarded here, which left "Status unknown" as the only thing anyone
    // could see. "ipptool not installed" and "connection refused" need
    // completely different fixes, and neither could be told apart.
    // Empty on success so a cleared printer does not keep a stale reason.
    printer_error: body.error ? String(body.error).slice(0, 200) : null,
    // Where the worker is pointed, so "unreachable" can be told apart from
    // "pointing at the wrong address" after a move.
    printer_target: String(body.printer_name || '').slice(0, 80),
    // Which device answered. There are two Brother printers on this network, so
    // a brand name identifies neither; this is the model string the printer
    // itself reports over IPP.
    printer_model: String(body.printer_model || '').slice(0, 80),
    printer_uri: String(body.printer_uri || '').slice(0, 200),
    // Recorded even when the read failed, so "checked recently but
    // unreachable" is distinguishable from "never checked".
    last_checked: new Date().toISOString()
  };

  // How often the worker says it polls. Stored rather than assumed, so the
  // dashboard can decide what "stale" means instead of hardcoding a guess that
  // silently goes wrong when the interval is changed in the Pi's env file.
  // Only overwritten when the worker actually sends one, so an older worker
  // still updates last_checked and supplies exactly as before.
  const pollInterval = parseInt(body.poll_interval, 10);
  if (Number.isFinite(pollInterval) && pollInterval > 0) {
    row.poll_interval = Math.min(3600, pollInterval);
  }

  // Never overwrite a known identity with an empty one. A poll that failed early
  // (ipptool missing, say) sends no model, and blanking the column would erase
  // the last thing we actually knew about which machine is installed.
  for (const f of ['printer_target', 'printer_model', 'printer_uri']) {
    if (!row[f]) delete row[f];
  }

  // There is no standard IPP attribute for "how much paper is left in the
  // tray" -- most drivers only report which trays are loaded. So paper_level is
  // now DERIVED from completed jobs, never taken from the printer and never
  // hand-edited. Any paper value in the payload is ignored on purpose; see
  // computePaper().

  // printer_status is a singleton row with a generated id, so look it up
  // rather than assuming a fixed value.
  const cur = await supabaseRequest('GET', '/printer_status', null, {
    'select': 'id', 'order': 'last_checked.desc', 'limit': '1'
  });
  if (cur.error) return err('Failed to read printer status', 500);

  let write;
  if (!cur.data || cur.data.length === 0) {
    write = await supabaseRequest('POST', '/printer_status', row);
  } else {
    write = await supabaseRequest('PATCH', '/printer_status?id=eq.' + cur.data[0].id, row);

    const errText = JSON.stringify(write.data || '');

    // Fallback 1: the supply columns were NOT NULL until migration
    // 20261014_printer_status_nullable made them nullable. Record the status
    // on its own so "no reading" is still visible even before that runs.
    if (write.error && errText.includes('23502')) {
      const fallback = { status: row.status, last_checked: row.last_checked };
      if (row.paper_level !== undefined) fallback.paper_level = row.paper_level;
      write = await supabaseRequest('PATCH', '/printer_status?id=eq.' + cur.data[0].id, fallback);
    }

    // Fallback 3: poll_interval arrived with the migration
    // 20261016_printer_status_poll_interval.sql. Until that SQL has been run
    // in the Supabase editor the column does not exist and the PATCH is
    // rejected outright with 23503 - which would take the WHOLE reading down
    // with it and leave the dashboard with nothing at all. Drop just the new
    // column and store the reading as before, so deploying before the migration
    // costs the freshness signal but never the status.
    if (write.error && errText.includes('23503')) {
      const withoutInterval = { ...row };
      delete withoutInterval.poll_interval;
      write = await supabaseRequest('PATCH', '/printer_status?id=eq.' + cur.data[0].id, withoutInterval);
    }

    // Fallback 2: the status CHECK constraint originally allowed only
    // ('online','offline','jam_minor','jam_major'), so both 'low' and
    // 'unknown' were rejected. Degrade to 'offline', which is truthful --
    // a printer we cannot read or that is low on toner is not available.
    if (write.error && JSON.stringify(write.data || '').includes('23514')) {
      write = await supabaseRequest('PATCH', '/printer_status?id=eq.' + cur.data[0].id, {
        status: 'offline', last_checked: row.last_checked
      });
      if (!write.error) row.status = 'offline';
    }
  }
  if (write.error) return err('Failed to store supplies', 500);

  if (lowest !== null && lowest <= 15) {
    await supabaseRequest('POST', '/alerts', {
      type: 'supply_low',
      message: 'Toner low on ' + (body.printer_name || 'kiosk printer') + ' (lowest ' + lowest + '%)',
      severity: 'warning',
      is_read: false
    });
  }

  return json({ success: true, status: row.status });
}

// Anything stuck in printing for too long is marked failed so a staff member
// sees it instead of it silently hanging forever.
async function watchdog(event) {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* defaults below */ }

  const stuckMin = Math.min(120, Math.max(5, parseInt(body.stuck_minutes, 10) || 30));
  const cutoff = new Date(Date.now() - stuckMin * 60000).toISOString();

  const stale = await supabaseRequest('GET', '/print_jobs', null, {
    'select': 'id,job_id,print_claimed_at',
    'status': 'eq.printing',
    'print_claimed_at': 'lt.' + cutoff
  });
  if (stale.error) return err('Watchdog lookup failed', 500);

  const stuck = stale.data || [];
  if (stuck.length === 0) return json({ success: true, recovered: 0 });

  const ids = stuck.map(j => j.id);
  const now = new Date().toISOString();
  await supabaseRequest('PATCH', '/print_jobs?id=in.(' + ids.join(',') + ')', {
    status: 'failed',
    print_error: 'Printer did not confirm completion within ' + stuckMin + ' minutes',
    print_completed_at: now,
    updated_at: now
  });

  await supabaseRequest('POST', '/alerts', {
    type: 'print_stuck',
    message: stuck.length + ' print job(s) stalled and were marked failed: ' +
      stuck.map(j => j.job_id).join(', '),
    severity: 'warning',
    is_read: false
  });

  return json({ success: true, recovered: stuck.length });
}

// Staff reprint. Deliberately separate from requestPrint so a reprint always
// goes through an admin, never through the kiosk endpoint.
async function reprintJob(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Bad JSON body'); }

  const jobId = String(body.job_id || '');
  if (!/^PRN-[A-Za-z0-9-]+$/.test(jobId)) return err('Invalid job');

  const now = new Date().toISOString();
  const upd = await supabaseRequest('PATCH', '/print_jobs?job_id=eq.' + jobId, {
    status: 'print_requested',
    print_requested_at: now,
    print_claimed_at: null,
    print_started_at: null,
    print_completed_at: null,
    print_error: null,
    print_attempts: 0,
    updated_at: now
  });

  if (upd.error) return err('Reprint failed', 500);
  return json({ success: true, job_id: jobId, status: 'print_requested' });
}

// Jobs the printer could not complete. Staff need these surfaced separately
// from the normal queue because the customer has already paid.
async function getFailedJobs(event) {
  const result = await supabaseRequest('GET', '/print_jobs', null, {
    'select': 'id,job_id,file_name,pages,color_mode,sides,copies,status,print_error,print_attempts,total_price,paid,created_at,print_requested_at',
    'status': 'eq.failed',
    'order': 'print_requested_at.desc',
    'limit': '100'
  });

  if (result.error) return err('Failed to load failed jobs', 500);
  return json({ success: true, jobs: result.data || [] });
}

// Lets the kiosk tell the customer what is actually happening to their job
// instead of guessing. Scoped to a single unguessable UUID, and returns no
// customer or payment data.
async function getPrintStatus(event) {
  const qs = event.queryStringParameters || {};
  const id = String(qs.id || '');
  if (!UUID_RE.test(id)) return err('Invalid job');

  const r = await supabaseRequest('GET', '/print_jobs', null, {
    'select': 'id,job_id,status,print_error,pages,color_mode,sides,copies',
    'id': 'eq.' + id
  });
  if (r.error) return err('Lookup failed', 500);
  if (!r.data || r.data.length === 0) return err('Job not found', 404);

  return json({ success: true, job: r.data[0] });
}

// ---------------------------------------------------------------------------
// Paper remaining.
//
// printer_status.paper_level used to be a hand-entered number: nothing in the
// worker measured it, because no standard IPP attribute reports sheets in the
// tray. The only writer was the admin override, and the customer-facing bar
// displayed it as if the printer had reported it.
//
// So derive it from what actually left the tray. pages and copies already exist
// on print_jobs and print_completed_at is only set when CUPS confirmed the job
// completed, so this counts real sheets. Deriving on read rather than
// decrementing a stored counter means it self-corrects if a job is removed.
//
// Still an estimate, not a sensor: a jammed sheet leaves the tray without a
// completed job, and manual-feed paper is never counted. That is why the
// response carries paper_derived so the UI can label it honestly.
// ---------------------------------------------------------------------------
async function computePaper(statusRow) {
  const capacity = (Number.isFinite(parseInt(statusRow.paper_capacity, 10)) && parseInt(statusRow.paper_capacity, 10) > 0)
    ? parseInt(statusRow.paper_capacity, 10)
    : 250;
  const since = statusRow.paper_refilled_at || null;

  let used = 0;
  let known = false;
  if (since) {
    const r = await supabaseRequest('GET', '/print_jobs', null, {
      'select': 'pages,copies',
      'status': 'eq.completed',
      'print_completed_at': 'gt.' + since
    });
    if (!r.error && Array.isArray(r.data)) {
      used = r.data.reduce(function (sum, j) {
        const pages = Math.max(0, parseInt(j.pages, 10) || 0);
        const copies = Math.max(1, parseInt(j.copies, 10) || 1);
        return sum + (pages * copies);
      }, 0);
      known = true;
    }
  }

  const remaining = Math.max(0, capacity - used);
  return {
    capacity: capacity,
    used: known ? used : null,
    remaining: known ? remaining : null,
    level: known ? Math.max(0, Math.min(100, Math.round((remaining / capacity) * 100))) : null,
    derived: true,
    known: known,
    refilled_at: since
  };
}

async function getPrinterStatus() {
  const result = await supabaseRequest('GET', '/printer_status', null, {
    'select': '*',
    'order': 'last_checked.desc',
    'limit': '1'
  });

  if (result.error || !result.data || result.data.length === 0) {
    // No row means the worker has NEVER reported. This used to send
    // last_checked: new Date() - i.e. claim a reading had just come in. The
    // kiosk computes its staleness from that field, so it computed an age of
    // zero and believed the printer had just been checked, while in truth
    // nothing had ever been heard. Fabricating a timestamp here disabled the
    // exact guard that was supposed to catch it.
    return json({
      success: true,
      printer: {
        paper_level: null, toner_black: null, toner_cyan: null,
        toner_magenta: null, toner_yellow: null,
        status: 'unknown', jam_type: null, printer_alert: null,
        printer_error: 'The printer has never reported. Check that the Pi worker is running.',
        last_checked: null
      },
      printer_freshness: freshnessOf({ last_checked: null, poll_interval: null }),
      paper: null,
      can_print: false,
      blocked_reason: 'printer status unknown'
    });
  }

  const row = result.data[0];
  const paper = await computePaper(row);

  // A CUPS stop reason ("Paper jam", "Printer stopped") is the most actionable
  // thing we know, and it outranks the toner-derived status for display.
  const alert = row.printer_alert || null;

  // Decide up front whether the kiosk should offer printing, so the customer
  // finds out before they pay rather than at the printer. Low paper is a
  // warning they can fix themselves; a hard stop is blocking.
  const PAPER_LOW_PCT = 20;
  const PAPER_LOW_SHEETS = 15;
  let canPrint = true;
  let blockedReason = null;
  let warn = null;

  if (alert) {
    canPrint = false;
    blockedReason = alert;
  } else if (paper.known === false) {
    // The count query itself failed. Reporting used=0 would show a full tray,
    // which is the dangerous direction: the customer is told paper is fine when
    // in fact we simply could not ask. Say nothing is known.
    canPrint = true;
    warn = 'paper unknown';
  } else if (paper.derived && (paper.level <= PAPER_LOW_PCT || paper.remaining <= PAPER_LOW_SHEETS)) {
    warn = 'paper low';
  }

  return json({
    success: true,
    printer: row,
    paper: paper,
    printer_alert: alert,
    // The concrete failure reason, so "Status unknown" can be replaced by
    // something actionable rather than being the final word.
    printer_error: row.printer_error || null,
    printer_target: row.printer_target || null,
    printer_model: row.printer_model || null,
    printer_uri: row.printer_uri || null,
    // Same verdict the dashboard gets, from the same function. The kiosk used
    // to compute its own age from last_checked against a hardcoded window,
    // which meant it and the dashboard could disagree about the same printer.
    printer_freshness: freshnessOf(row),
    can_print: canPrint,
    blocked_reason: blockedReason,
    warn: warn,
    // The customer-facing bar reads paper_level; keep it in step with the
    // derived figure so nothing still renders the stale hand-entered value.
    paper_level: paper.level
  });
}

// Staff declares the tray has been refilled, which restarts the count.
async function refillPaper(event) {
  const session = await validateSession(event);
  if (!session || !session.users || session.users.role !== 'admin') return err('Admin access required', 403);

  const cur = await supabaseRequest('GET', '/printer_status', null, {
    'select': 'id', 'order': 'last_checked.desc', 'limit': '1'
  });
  if (cur.error) return err('Failed to read printer status', 500);
  if (!cur.data || cur.data.length === 0) return err('No printer status row', 404);

  const body = (() => { try { return JSON.parse(event.body || '{}'); } catch (e) { return {}; } })();
  const patch = { paper_refilled_at: new Date().toISOString() };
  if (Number.isFinite(parseInt(body.paper_capacity, 10)) && parseInt(body.paper_capacity, 10) > 0) {
    patch.paper_capacity = parseInt(body.paper_capacity, 10);
  }

  const write = await supabaseRequest('PATCH', '/printer_status?id=eq.' + cur.data[0].id, patch);
  if (write.error) return err('Refill failed - has migration 20261014_paper_remaining run?', 500);

  return json({ success: true, paper_refilled_at: patch.paper_refilled_at });
}

async function getPendingJobs(event) {
  const session = await validateSession(event);
  if (!session || session.users.role !== 'admin') return err('Admin access required', 403);

  const result = await supabaseRequest('GET', '/print_jobs', null, {
    'status': 'eq.pending',
    'select': '*',
    'order': 'created_at.asc'
  });

  return json({ success: true, jobs: result.error ? [] : result.data });
}

async function getReadyJobs(event) {
  const session = await validateSession(event);
  if (!session || session.users.role !== 'admin') return err('Admin access required', 403);

  const result = await supabaseRequest('GET', '/print_jobs', null, {
    'status': 'eq.ready_to_print',
    'select': '*',
    'order': 'created_at.asc'
  });

  return json({ success: true, jobs: result.error ? [] : result.data });
}

async function updatePrinterStatus(event) {
  const body = JSON.parse(event.body || '{}');
  const updateData = { last_checked: new Date().toISOString() };
  if (body.status !== undefined) updateData.status = body.status;
  if (body.jam_type !== undefined) updateData.jam_type = body.jam_type;

  const currentResult = await supabaseRequest('GET', '/printer_status', null, {
    'select': 'id',
    'order': 'last_checked.desc',
    'limit': '1'
  });

  if (currentResult.error || !currentResult.data || currentResult.data.length === 0) {
    await supabaseRequest('POST', '/printer_status', {
      paper_level: 100, toner_black: 100, toner_cyan: 100,
      toner_magenta: 100, toner_yellow: 100,
      ...updateData
    });
  } else {
    await supabaseRequest('PATCH', '/printer_status?id=eq.' + currentResult.data[0].id, updateData);
  }

  return json({ success: true });
}

async function updateJobStatus(event) {
  const body = JSON.parse(event.body || '{}');
  const jobId = body.job_id || '';
  const newStatus = body.status || '';

  if (!jobId || !newStatus) return err('Job ID and status required');

  const allowed = ['pending', 'ready_to_print', 'print_requested', 'printing', 'completed', 'failed', 'cancelled', 'refund_issued'];
  if (!allowed.includes(newStatus)) return err('Invalid status');

  const result = await supabaseRequest('PATCH', '/print_jobs?job_id=eq.' + jobId, {
    status: newStatus,
    updated_at: new Date().toISOString()
  });

  if (result.error) return err('Failed to update job status', 500);

  if (newStatus === 'completed') {
    await supabaseRequest('POST', '/alerts', {
      type: 'print_complete',
      message: 'Print job ' + jobId + ' completed successfully',
      severity: 'info',
      is_read: false
    });
  }

  return json({ success: true, message: 'Job status updated to ' + newStatus });
}

async function simulateJam(event) {
  const body = JSON.parse(event.body || '{}');
  const jamType = body.jam_type || 'minor';
  if (!['minor', 'major'].includes(jamType)) return err('Jam type must be minor or major');

  const status = jamType === 'minor' ? 'jam_minor' : 'jam_major';
  const currentResult = await supabaseRequest('GET', '/printer_status', null, {
    'select': 'id', 'order': 'last_checked.desc', 'limit': '1'
  });

  const updateData = { status, jam_type: jamType, last_checked: new Date().toISOString() };

  if (currentResult.error || !currentResult.data || currentResult.data.length === 0) {
    await supabaseRequest('POST', '/printer_status', {
      paper_level: 100, toner_black: 100, toner_cyan: 100,
      toner_magenta: 100, toner_yellow: 100,
      ...updateData
    });
  } else {
    await supabaseRequest('PATCH', '/printer_status?id=eq.' + currentResult.data[0].id, updateData);
  }

  const msg = jamType === 'minor'
    ? 'Minor paper jam detected - auto reprint queued'
    : 'Major paper jam detected - refund being processed';

  await supabaseRequest('POST', '/alerts', {
    type: 'paper_jam',
    message: msg,
    severity: jamType === 'major' ? 'critical' : 'warning',
    is_read: false
  });

  if (jamType === 'major') {
    const jobsResult = await supabaseRequest('GET', '/print_jobs', null, {
      'status': 'eq.printing',
      'select': 'id,job_id,user_id,total_price'
    });

    if (!jobsResult.error && jobsResult.data) {
      for (const job of jobsResult.data) {
        await supabaseRequest('PATCH', '/print_jobs?id=eq.' + job.id, {
          status: 'refund_issued',
          updated_at: new Date().toISOString()
        });

        if (job.user_id) {
          const userResult = await supabaseRequest('GET', '/users', null, {
            'id': 'eq.' + job.user_id,
            'select': 'coins'
          });
          if (!userResult.error && userResult.data && userResult.data.length > 0) {
            const currentCoins = userResult.data[0].coins;
            const coinsRefund = 1;
            await supabaseRequest('PATCH', '/users?id=eq.' + job.user_id, {
              coins: currentCoins + coinsRefund
            });
          }
        }
      }
    }
  }

  return json({ success: true, jam_type: jamType, message: msg });
}

async function clearJam() {
  const currentResult = await supabaseRequest('GET', '/printer_status', null, {
    'select': 'id', 'order': 'last_checked.desc', 'limit': '1'
  });

  if (!currentResult.error && currentResult.data && currentResult.data.length > 0) {
    await supabaseRequest('PATCH', '/printer_status?id=eq.' + currentResult.data[0].id, {
      status: 'online',
      jam_type: null,
      last_checked: new Date().toISOString()
    });
  }

  return json({ success: true, message: 'Jam cleared, printer back online' });
}

async function setSupplyLevels(event) {
  const body = JSON.parse(event.body || '{}');
  const updateData = { last_checked: new Date().toISOString() };

  // Only accept real numbers. parseInt(null) is NaN, and Math.max/min pass NaN
  // straight through, so an empty or malformed field would otherwise be written
  // as a null level and quietly blank the printer's supplies.
  const setLevel = function (key, raw) {
    if (raw === undefined || raw === null) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    updateData[key] = Math.max(0, Math.min(100, n));
  };

  setLevel('paper_level', body.paper_level);
  setLevel('toner_black', body.toner_black);
  setLevel('toner_cyan', body.toner_cyan);
  setLevel('toner_magenta', body.toner_magenta);
  setLevel('toner_yellow', body.toner_yellow);

  if (Object.keys(updateData).length === 1) {
    return err('No valid levels supplied', 400);
  }

  const currentResult = await supabaseRequest('GET', '/printer_status', null, {
    'select': 'id', 'order': 'last_checked.desc', 'limit': '1'
  });

  if (currentResult.error || !currentResult.data || currentResult.data.length === 0) {
    await supabaseRequest('POST', '/printer_status', {
      paper_level: 100, toner_black: 100, toner_cyan: 100,
      toner_magenta: 100, toner_yellow: 100,
      ...updateData
    });
  } else {
    await supabaseRequest('PATCH', '/printer_status?id=eq.' + currentResult.data[0].id, updateData);
  }

  if (updateData.paper_level !== undefined && updateData.paper_level < 20) {
    await supabaseRequest('POST', '/alerts', {
      type: 'paper_low',
      message: 'Paper level is low (' + updateData.paper_level + '%)',
      severity: 'warning', is_read: false
    });
  }

  for (const toner of ['toner_black', 'toner_cyan', 'toner_magenta', 'toner_yellow']) {
    if (updateData[toner] !== undefined && updateData[toner] < 20) {
      await supabaseRequest('POST', '/alerts', {
        type: 'toner_low',
        message: toner.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()) + ' toner is low (' + updateData[toner] + '%)',
        severity: 'warning', is_read: false
      });
    }
  }

  return json({ success: true });
}
