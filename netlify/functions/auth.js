const { json, err, supabaseRequest, validateSession, generateSessionToken, SESSION_DURATION,
  VERIFICATION_CODE_LENGTH, VERIFICATION_CODE_TTL, SMTP_FROM_NAME, SMTP_USER,
  generateVerificationCode, isValidGmail, isValidMalaysianPhone, normalizePhone, sendVerificationEmail, smtpSend } = require('./_shared');
const { sendCoinPush } = require('./_push');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json({});

  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const url = new URL(event.rawUrl);
  const action = url.searchParams.get('action');

  switch (action) {
    case 'login': return handleLogin(event);
    case 'register': return handleRegister(event);
    case 'verify-email': return handleVerifyEmail(event);
    case 'resend-code': return handleResendCode(event);
    case 'logout': return handleLogout(event);
    case 'verify-session': return handleVerifySession(event);
    case 'save-face': return handleSaveFace(event);
    case 'remove-face': return handleRemoveFace(event);
    case 'verify-pin': return handleVerifyPin(event);
    case 'face-login': return handleFaceLogin(event);
    case 'set-pin': return handleSetPin(event);
    case 'change-password': return handleChangePassword(event);
    case 'update-profile': return handleUpdateProfile(event);
    case 'forgot-password': return handleForgotPassword(event);
    case 'reset-password': return handleResetPassword(event);
    case 'delete-account': return handleDeleteAccount(event);
    default: return err('Invalid action');
  }
};

async function handleLogin(event) {
  const body = JSON.parse(event.body || '{}');
  const email = (body.email || '').trim();
  const password = body.password || '';

  if (!email || !password) return err('Email and password required');

  const result = await supabaseRequest('GET', '/users', null, {
    'email': 'eq.' + email,
    'select': '*'
  });

  if (result.error || !result.data || result.data.length === 0) {
    return err('Invalid email or password', 401);
  }

  const user = result.data[0];
  const bcrypt = require('bcryptjs');
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return err('Invalid email or password', 401);

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();

  const sessionResult = await supabaseRequest('POST', '/sessions', {
    session_token: token,
    user_id: user.id,
    expires_at: expiresAt
  });

  if (sessionResult.error) return err('Failed to create session', 500);

  return json({
    success: true,
    user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, coins: user.coins,
      has_face: !!user.face_descriptor,
      username: user.username || null,
      nickname: user.nickname || null,
      account_number: user.account_number || null,
      profile_picture: user.profile_picture || null,
      google_id: user.google_id || null
    },
    session_token: token,
    expires_at: expiresAt
  });
}

async function handleRegister(event) {
  const body = JSON.parse(event.body || '{}');
  const name = (body.name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const pin_code = body.pin_code || '';
  const phone = (body.phone || '').trim();

  if (!name || !email || !password) return err('Name, email, and password required');
  if (!isValidGmail(email)) return err('Only Gmail addresses are accepted');
  if (!isValidMalaysianPhone(phone)) return err('Enter a valid Malaysian mobile number (e.g. 010-1234567)');
  if (pin_code && !/^\d{4}$/.test(pin_code)) return err('PIN must be 4 digits');
  if (password.length < 6) return err('Password must be at least 6 characters');

  const checkResult = await supabaseRequest('GET', '/users', null, {
    'email': 'eq.' + email,
    'select': 'id'
  });

  if (!checkResult.error && checkResult.data && checkResult.data.length > 0) {
    return err('Email already registered', 409);
  }

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 10);
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL * 1000).toISOString();

  const insertData = {
    name, email, password_hash: hash, role: 'customer', coins: 0,
    phone: normalizePhone(phone), email_verified: false,
    verification_code: code, verification_expires_at: expiresAt
  };
  if (pin_code) insertData.pin_code = pin_code;

  const insertResult = await supabaseRequest('POST', '/users', insertData);
  if (insertResult.error) return err('Registration failed: ' + (insertResult.message || ''), 500);

  const user = insertResult.data[0];
  const sent = await sendVerificationEmail(email, code, name);

  if (!sent) {
    await supabaseRequest('DELETE', '/users', null, { 'id': 'eq.' + user.id });
    return err('Failed to send verification email. Check SMTP_USER / SMTP_PASS (Gmail App Password) are configured.', 500);
  }

  return json({ success: true, verification_required: true, message: 'Verification code sent to ' + email, email });
}

async function handleVerifyEmail(event) {
  const body = JSON.parse(event.body || '{}');
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.code || '').trim();

  if (!email || !code) return err('Email and verification code required');
  if (!new RegExp('^\\d{' + VERIFICATION_CODE_LENGTH + '}$').test(code)) return err('Invalid verification code format');

  const userResult = await supabaseRequest('GET', '/users', null, {
    'email': 'eq.' + email,
    'select': '*'
  });

  if (userResult.error || !userResult.data || !userResult.data.length) return err('User not found', 404);

  const user = userResult.data[0];

  if (user.email_verified) return err('Email already verified');

  if (!user.verification_code || user.verification_code !== code) return err('Invalid verification code');

  const expiresAt = user.verification_expires_at ? new Date(user.verification_expires_at).getTime() : 0;
  if (expiresAt < Date.now()) return err('Verification code expired. Resend a new code.');

  const patchResult = await supabaseRequest('PATCH', '/users?id=eq.' + user.id, {
    email_verified: true, verification_code: null, verification_expires_at: null
  });
  if (patchResult.error) return err('Failed to verify email', 500);

  await supabaseRequest('POST', '/coin_transactions', {
    user_id: user.id, type: 'bonus', amount: 10,
    description: 'Welcome bonus - first registration', balance_after: 10
  });
  const bonus = await supabaseRequest('PATCH', '/users?id=eq.' + user.id, { coins: 10 });

  // No subscription exists yet at registration, so this is normally a no-op;
  // it keeps every coin-award path sending the same way, after the write.
  if (!bonus.error) await sendCoinPush(user.id, 10);

  const token = generateSessionToken();
  const sessionExpiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();

  await supabaseRequest('POST', '/sessions', {
    session_token: token, user_id: user.id, expires_at: sessionExpiresAt
  });

  return json({
    success: true, message: 'Registration successful! You earned 10 bonus coins.',
    user: { id: user.id, name: user.name, email: user.email, role: user.role, coins: 10, has_face: false },
    session_token: token, expires_at: sessionExpiresAt
  });
}

async function handleResendCode(event) {
  const body = JSON.parse(event.body || '{}');
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return err('Email required');

  const userResult = await supabaseRequest('GET', '/users', null, {
    'email': 'eq.' + email,
    'select': '*'
  });

  if (userResult.error || !userResult.data || !userResult.data.length) return err('User not found', 404);

  const user = userResult.data[0];
  if (user.email_verified) return err('Email already verified');

  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL * 1000).toISOString();

  await supabaseRequest('PATCH', '/users?id=eq.' + user.id, {
    verification_code: code, verification_expires_at: expiresAt
  });

  const sent = await sendVerificationEmail(email, code, user.name);

  if (!sent) return err('Failed to send verification email. Check SMTP_USER / SMTP_PASS (Gmail App Password) are configured.', 500);

  return json({ success: true, message: 'Verification code sent to ' + email });
}

async function handleLogout(event) {
  const token = (event.headers || {})['x-session-token'] || '';
  if (token) {
    await supabaseRequest('DELETE', '/sessions', null, { 'session_token': 'eq.' + token });
  }
  return json({ success: true });
}

async function handleVerifySession(event) {
  const session = await validateSession(event);
  if (!session) return err('Invalid or expired session', 401);

  const user = session.users;
  return json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, coins: user.coins, has_face: !!user.face_descriptor,
      username: user.username || null, nickname: user.nickname || null, account_number: user.account_number || null,
      profile_picture: user.profile_picture || null, google_id: user.google_id || null }
  });
}

async function handleSaveFace(event) {
  const session = await validateSession(event);
  if (!session) return err('Unauthorized', 401);

  const body = JSON.parse(event.body || '{}');
  const descriptor = body.descriptor || [];
  const faceImages = body.face_images || [];

  if (!descriptor.length) return err('Face descriptor required');

  const patchData = { face_descriptor: descriptor };
  if (faceImages.length > 0) patchData.face_images = faceImages;

  let result = await supabaseRequest('PATCH', '/users?id=eq.' + session.user_id, patchData);

  if (result.error && 'face_images' in patchData) {
    delete patchData.face_images;
    result = await supabaseRequest('PATCH', '/users?id=eq.' + session.user_id, patchData);
  }

  if (result.error) return err('Failed to save face data', 500);
  return json({ success: true, message: 'Face data saved successfully' });
}

async function handleRemoveFace(event) {
  const session = await validateSession(event);
  if (!session) return err('Unauthorized', 401);

  let result = await supabaseRequest('PATCH', '/users?id=eq.' + session.user_id, {
    face_descriptor: null,
    face_images: null
  });

  if (result.error && result.error.message && result.error.message.includes('face_images')) {
    result = await supabaseRequest('PATCH', '/users?id=eq.' + session.user_id, {
      face_descriptor: null
    });
  }

  if (result.error) return err('Failed to remove face data', 500);
  return json({ success: true, message: 'Face data removed successfully' });
}

async function handleVerifyPin(event) {
  const body = JSON.parse(event.body || '{}');
  const email = (body.email || '').trim();
  const pin = body.pin || '';

  if (!email || !pin) return err('Email and PIN required');
  if (!/^\d{4}$/.test(pin)) return err('PIN must be 4 digits');

  const result = await supabaseRequest('GET', '/users', null, {
    'email': 'eq.' + email,
    'select': '*'
  });

  if (result.error || !result.data || result.data.length === 0) return err('Invalid email or PIN', 401);

  const user = result.data[0];
  if (!user.pin_code || user.pin_code !== pin) return err('Invalid email or PIN', 401);

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();

  await supabaseRequest('POST', '/sessions', {
    session_token: token, user_id: user.id, expires_at: expiresAt
  });

  return json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, coins: user.coins, has_face: !!user.face_descriptor },
    session_token: token,
    expires_at: expiresAt
  });
}

async function handleFaceLogin(event) {
  const body = JSON.parse(event.body || '{}');
  const userId = body.user_id || '';

  if (!userId) return err('User ID required');

  const result = await supabaseRequest('GET', '/users', null, {
    'id': 'eq.' + userId,
    'select': '*'
  });

  if (result.error || !result.data || result.data.length === 0) return err('User not found', 401);

  const user = result.data[0];
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();

  await supabaseRequest('POST', '/sessions', {
    session_token: token, user_id: user.id, expires_at: expiresAt
  });

  return json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, coins: user.coins, has_face: !!user.face_descriptor },
    session_token: token,
    expires_at: expiresAt
  });
}

async function handleSetPin(event) {
  const session = await validateSession(event);
  if (!session) return err('Unauthorized', 401);

  const body = JSON.parse(event.body || '{}');
  const pin = body.pin || '';

  if (!/^\d{4}$/.test(pin)) return err('PIN must be 4 digits');

  const result = await supabaseRequest('PATCH', '/users?id=eq.' + session.user_id, { pin_code: pin });
  if (result.error) return err('Failed to save PIN', 500);

  return json({ success: true, message: 'PIN saved successfully' });
}

async function handleChangePassword(event) {
  const session = await validateSession(event);
  if (!session) return err('Unauthorized', 401);

  const body = JSON.parse(event.body || '{}');
  const currentPassword = body.current_password || '';
  const newPassword = body.new_password || '';

  if (!currentPassword || !newPassword) return err('Current and new password required');
  if (newPassword.length < 6) return err('New password must be at least 6 characters');

  const bcrypt = require('bcryptjs');

  const userResult = await supabaseRequest('GET', '/users', null, {
    'id': 'eq.' + session.user_id,
    'select': '*'
  });

  if (userResult.error || !userResult.data || userResult.data.length === 0) return err('User not found', 401);

  const user = userResult.data[0];
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return err('Current password is incorrect', 401);

  const hash = await bcrypt.hash(newPassword, 10);
  const result = await supabaseRequest('PATCH', '/users?id=eq.' + session.user_id, { password_hash: hash });
  if (result.error) return err('Failed to change password', 500);

  return json({ success: true, message: 'Password updated successfully' });
}

async function handleUpdateProfile(event) {
  const session = await validateSession(event);
  if (!session) return err('Unauthorized', 401);

  const body = JSON.parse(event.body || '{}');
  const patchData = {};

  if ('username' in body) patchData.username = body.username === null ? null : String(body.username).trim();
  if ('nickname' in body) patchData.nickname = body.nickname === null ? null : String(body.nickname).trim();
  if ('account_number' in body) patchData.account_number = body.account_number === null ? null : String(body.account_number).trim();
  if ('profile_picture' in body) patchData.profile_picture = body.profile_picture === null ? null : String(body.profile_picture);
  if ('google_id' in body) patchData.google_id = body.google_id === null ? null : String(body.google_id).trim().toLowerCase();

  if (Object.keys(patchData).length === 0) return err('No fields to update');

  const result = await supabaseRequest('PATCH', '/users?id=eq.' + session.user_id, patchData);
  if (result.error) return err('Failed to update profile. If this persists, run the profile fields migration.', 500);

  return json({ success: true, message: 'Profile updated successfully' });
}

async function handleForgotPassword(event) {
  const body = JSON.parse(event.body || '{}');
  const email = (body.email || '').trim().toLowerCase();
  const site = (body.site || '').trim().replace(/\/+$/, '');
  if (!email) return err('Email required');
  if (!isValidGmail(email)) return err('Only Gmail addresses are accepted');
  if (!site || !/^https?:\/\//.test(site)) return err('Invalid request origin');

  const userResult = await supabaseRequest('GET', '/users', null, {
    'email': 'eq.' + email,
    'select': '*'
  });

  if (userResult.error || !userResult.data || !userResult.data.length) {
    return json({ success: true, message: 'If an account exists, a reset link has been sent.' });
  }

  const user = userResult.data[0];

  const token = require('crypto').randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const patch = await supabaseRequest('PATCH', '/users?id=eq.' + user.id, {
    verification_code: token,
    verification_expires_at: expiresAt
  });
  if (patch.error) return err('Failed to send reset email. Please try again.', 500);

  const resetUrl = site + '/website/reset-password.html?token=' + token;

  const html = '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;">'
    + '<h2 style="color:#0f172a;margin:0 0 8px;">Reset your password</h2>'
    + '<p style="color:#475569;font-size:14px;">Hi ' + String(user.name).replace(/[<>&]/g, '') + ',</p>'
    + '<p style="color:#475569;font-size:14px;line-height:1.6;">We received a request to reset your password. Click the button below to create a new one. This link expires in 30 minutes.</p>'
    + '<div style="text-align:center;margin:24px 0;">'
    + '<a href="' + resetUrl.replace(/[<>&"']/g, '') + '" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px;">Reset Password</a>'
    + '</div>'
    + '<p style="color:#475569;font-size:13px;line-height:1.6;">If the button does not work, copy and paste this link into your browser:</p>'
    + '<p style="color:#2563eb;font-size:12px;word-break:break-all;">' + resetUrl.replace(/[<>&"']/g, '') + '</p>'
    + '<p style="color:#94a3b8;font-size:12px;margin-top:16px;">If you did not request this, you can safely ignore this email.</p>'
    + '</div>';

  const sent = await smtpSend(email, 'PrintKiosk - Reset your password', html);
  if (!sent) return err('Failed to send reset email. Check SMTP_USER / SMTP_PASS (Gmail App Password) are configured.', 500);

  return json({ success: true, message: 'If an account exists, a reset link has been sent.' });
}

async function handleResetPassword(event) {
  const body = JSON.parse(event.body || '{}');
  const token = (body.token || '').trim();
  const newPassword = body.newPassword || '';

  if (!token || !newPassword) return err('Reset link and new password required');
  if (!/^[a-f0-9]{48}$/.test(token)) return err('Invalid or expired reset link');
  if (newPassword.length < 6) return err('New password must be at least 6 characters');

  const userResult = await supabaseRequest('GET', '/users', null, {
    'verification_code': 'eq.' + token,
    'select': '*'
  });
  if (userResult.error || !userResult.data || !userResult.data.length) return err('Invalid or expired reset link');

  const user = userResult.data[0];

  const expiresAt = user.verification_expires_at ? new Date(user.verification_expires_at).getTime() : 0;
  if (expiresAt < Date.now()) return err('This reset link has expired. Request a new one.');

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(newPassword, 10);

  const result = await supabaseRequest('PATCH', '/users?id=eq.' + user.id, {
    password_hash: hash,
    email_verified: true,
    verification_code: null,
    verification_expires_at: null
  });
  if (result.error) return err('Failed to reset password. Please try again.', 500);

  return json({ success: true, message: 'Password reset successful. You can now log in.', email: user.email });
}

async function handleDeleteAccount(event) {
  const session = await validateSession(event);
  if (!session) return err('Unauthorized', 401);

  const userId = session.user_id;

  await supabaseRequest('DELETE', '/sessions', null, { 'user_id': 'eq.' + userId });
  await supabaseRequest('DELETE', '/payments', null, { 'user_id': 'eq.' + userId });
  await supabaseRequest('DELETE', '/coin_transactions', null, { 'user_id': 'eq.' + userId });
  await supabaseRequest('DELETE', '/print_jobs', null, { 'user_id': 'eq.' + userId });

  const result = await supabaseRequest('DELETE', '/users', null, { 'id': 'eq.' + userId });
  if (result.error) return err('Failed to delete account', 500);

  return json({ success: true, message: 'Account deleted successfully' });
}
