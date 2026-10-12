/**
 * Scheduled housekeeping for the kiosk tables.
 *
 * Runs once a day (see the schedule in netlify.toml). Keeps the face detection
 * log - including the stored face snapshots - to FACE_LOG_RETENTION_DAYS so an
 * always-on shop screen cannot grow the table forever.
 *
 * Safe to run when a table has not been migrated yet: the delete is simply a
 * no-op and the function still reports success.
 */

const { supabaseRequest, json } = require('./_shared');

const FACE_LOG_RETENTION_DAYS = 30;
const DELETE_BATCH = 500; // PostgREST caps a single DELETE by URL length

async function pruneFaceDetections(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let deleted = 0;
  // Loop in batches so a large backlog is fully cleared without one huge URL.
  for (let pass = 0; pass < 40; pass++) {
    const result = await supabaseRequest(
      'DELETE',
      '/face_detections?created_at=lt.' + encodeURIComponent(cutoff),
      null,
      { select: 'id', limit: String(DELETE_BATCH) }
    );

    if (result.error) {
      // Table missing or not migrated - nothing to prune.
      if (String(result.message || '').match(/does not exist|schema cache|404/i)) {
        return { deleted, skipped: true };
      }
      return { deleted, error: result.message || 'delete failed' };
    }

    const n = (result.data || []).length;
    deleted += n;
    if (n < DELETE_BATCH) break; // nothing left to prune
  }

  return { deleted };
}

async function pruneStaleHeartbeats() {
  // Heartbeats are diagnostic only; anything older than 7 days is noise.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await supabaseRequest(
    'DELETE',
    '/kiosk_heartbeats?seen_at=lt.' + encodeURIComponent(cutoff),
    null,
    { select: 'id', limit: '500' }
  );
  if (result.error) return { deleted: 0, skipped: true };
  return { deleted: (result.data || []).length };
}

exports.handler = async function (event) {
  const faces = await pruneFaceDetections(FACE_LOG_RETENTION_DAYS);
  const beats = await pruneStaleHeartbeats();

  return json({
    success: !faces.error,
    retention_days: FACE_LOG_RETENTION_DAYS,
    face_detections_deleted: faces.deleted,
    face_detections_skipped: !!faces.skipped,
    heartbeats_deleted: beats.deleted,
    error: faces.error || null
  });
};