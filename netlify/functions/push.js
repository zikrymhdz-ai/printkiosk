// Push subscription endpoint.
//
// Saving a subscription requires the same custom session the rest of the app
// uses (the sessions table + session_token). There is no Supabase Auth here.
// Upsert is keyed on the endpoint, so re-enabling on one device can never leave
// duplicate rows, and switching accounts on a shared device moves the row to
// the current user rather than creating a second one.
const { json, err, supabaseRequest, validateSession } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  if (action === 'subscribe') return handleSubscribe(event);
  if (action === 'unsubscribe') return handleUnsubscribe(event);

  return err('Invalid action');
};

function text(value, max) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s.length > max) return '';
  return s;
}

async function handleSubscribe(event) {
  const session = await validateSession(event);
  if (!session || !session.users) return err('Sign in required', 403);
  const userId = session.user_id;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Invalid request body'); }

  const sub = body.subscription || {};
  const endpoint = text(sub.endpoint, 2048);
  const keys = sub.keys || {};
  const p256dh = text(keys.p256dh, 512);
  const auth = text(keys.auth, 512);
  const userAgent = text(body.user_agent, 512) || null;

  if (!/^https:\/\//i.test(endpoint)) return err('Invalid push endpoint');
  if (!p256dh || !auth) return err('Missing push keys');

  // One row per endpoint. A PATCH keeps created_at from the first enrolment.
  const existing = await supabaseRequest('GET', '/push_subscriptions', null, {
    'endpoint': 'eq.' + endpoint,
    'select': 'id',
    'limit': '1'
  });
  if (existing.error) return err('Failed to read subscriptions', 500);

  if (Array.isArray(existing.data) && existing.data.length) {
    const upd = await supabaseRequest('PATCH', '/push_subscriptions?id=eq.' + existing.data[0].id, {
      user_id: userId,
      p256dh: p256dh,
      auth: auth,
      user_agent: userAgent
    });
    if (upd.error) return err('Failed to update subscription', 500);
    return json({ success: true, updated: true });
  }

  const ins = await supabaseRequest('POST', '/push_subscriptions', {
    user_id: userId,
    endpoint: endpoint,
    p256dh: p256dh,
    auth: auth,
    user_agent: userAgent
  });
  if (ins.error) {
    // A simultaneous enable from the same device won the unique constraint.
    // Retry as an update instead of failing the request.
    const again = await supabaseRequest('GET', '/push_subscriptions', null, {
      'endpoint': 'eq.' + endpoint,
      'select': 'id',
      'limit': '1'
    });
    if (!again.error && Array.isArray(again.data) && again.data.length) {
      await supabaseRequest('PATCH', '/push_subscriptions?id=eq.' + again.data[0].id, {
        user_id: userId,
        p256dh: p256dh,
        auth: auth,
        user_agent: userAgent
      });
      return json({ success: true, updated: true });
    }
    return err('Failed to save subscription', 500);
  }

  return json({ success: true, created: true });
}

async function handleUnsubscribe(event) {
  const session = await validateSession(event);
  if (!session || !session.users) return err('Sign in required', 403);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Invalid request body'); }

  const endpoint = text(body.endpoint, 2048);
  if (!/^https:\/\//i.test(endpoint)) return err('Invalid push endpoint');

  // Scoped to this user, so one account can never remove another's device.
  const del = await supabaseRequest('DELETE', '/push_subscriptions', null, {
    'endpoint': 'eq.' + endpoint,
    'user_id': 'eq.' + session.user_id
  });
  if (del.error) return err('Failed to remove subscription', 500);

  return json({ success: true });
}
