const { json, err, supabaseRequest, validateSession } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  if (event.httpMethod === 'GET') {
    switch (action) {
      case 'status': return getPrinterStatus();
      case 'pending-jobs': return getPendingJobs(event);
      case 'ready-jobs': return getReadyJobs(event);
      default: return err('Invalid action');
    }
  } else if (event.httpMethod === 'POST') {
    const session = await validateSession(event);
    if (!session || session.users.role !== 'admin') return err('Admin access required', 403);

    switch (action) {
      case 'update-status': return updatePrinterStatus(event);
      case 'update-job': return updateJobStatus(event);
      case 'simulate-jam': return simulateJam(event);
      case 'clear-jam': return clearJam();
      case 'set-levels': return setSupplyLevels(event);
      default: return err('Invalid action');
    }
  }

  return err('Method not allowed', 405);
};

async function getPrinterStatus() {
  const result = await supabaseRequest('GET', '/printer_status', null, {
    'select': '*',
    'order': 'last_checked.desc',
    'limit': '1'
  });

  if (result.error || !result.data || result.data.length === 0) {
    return json({
      success: true,
      printer: {
        paper_level: 100, toner_black: 100, toner_cyan: 100,
        toner_magenta: 100, toner_yellow: 100,
        status: 'online', jam_type: null, last_checked: new Date().toISOString()
      }
    });
  }

  return json({ success: true, printer: result.data[0] });
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

  const allowed = ['pending', 'ready_to_print', 'printing', 'completed', 'refund_issued'];
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
