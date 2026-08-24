import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import {
  addKey,
  getKey,
  verifyKeyStatus,
  recordUsage,
  revokeKey,
  unrevokeKey,
  deleteKey,
  listKeys,
  getStats,
} from '../lib/keys.js';
import {
  signupUser,
  loginUser,
  loginOrSignupWithGoogle,
  verifyUserToken,
  addPackageCredits,
  deductCredits,
  refundCredits,
  getModelCost,
  PACKAGES,
} from '../lib/users.js';

export const config = {
  maxDuration: 10,
  api: { bodyParser: { sizeLimit: '12mb' } },
};

const BACKEND  = 'https://shark-app-qm22v.ondigitalocean.app';
const MASTER   = String(process.env.MASTER_KEY || 'masterstroke123').trim();
const TIMEOUT  = 30_000;

// Razorpay SDK setup
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

// Caches & Crypto & Cookies
const cache      = new Map();
const registered = new Set();
const sha256     = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac       = (k, d) => crypto.createHmac('sha256', k).update(d).digest('hex');
const enc        = (s) => Buffer.from(s, 'utf8').toString('base64url');

function parseCookies(header = '') {
  const list = {};
  if (!header) return list;
  header.split(';').forEach((cookie) => {
    const p = cookie.split('=');
    if (p.length >= 2) list[p[0].trim()] = decodeURIComponent(p.slice(1).join('=').trim());
  });
  return list;
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', `doom_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
}
const dec        = (s) => Buffer.from(s, 'base64url').toString('utf8');

function verifyKey(key) {
  if (typeof key !== 'string' || !key.startsWith('master-')) return false;
  const i = key.lastIndexOf('_');
  if (i < 8) return false;
  const tag = key.slice(i + 1);
  if (!/^[0-9a-f]{32}$/.test(tag)) return false;
  let label;
  try { label = dec(key.slice(7, i)); } catch { return false; }
  if (!label || label.length > 128) return false;
  const expected = hmac(MASTER, 'k:' + label).slice(0, 32);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(tag, 'hex'), Buffer.from(expected, 'hex'))) return false;
  } catch { return false; }
  return label;
}

const cached = (k, ttl, fn) => {
  const h = cache.get(k);
  if (h && Date.now() - h.t < ttl) return h.v;
  return fn().then((v) => { cache.set(k, { t: Date.now(), v }); return v; });
};

async function call(method, path, body) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(BACKEND + path, {
      method,
      signal:  ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    body != null ? JSON.stringify(body) : undefined,
    });
    clearTimeout(tid);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: 'Upstream request failed' }; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    clearTimeout(tid);
    const isTimeout = e?.name === 'AbortError';
    return { ok: false, status: 504, data: { error: isTimeout ? 'Upstream request timeout' : 'Service temporarily unavailable' } };
  }
}

async function ensureDevice(deviceId) {
  if (registered.has(deviceId)) return;
  await call('POST', '/V3/user/deviceId', { deviceId, platformName: 'android' });
  await call('POST', `/V3/user/${deviceId}/dailyCheckin/claim`, {});
  registered.add(deviceId);
}

const deviceFor = (key) => 'd_' + sha256('dev:' + key).slice(0, 22);

const fetchModels    = () => cached('models',    6e5, () => call('GET', '/V3/aiServices/models'));
const fetchWorkflows = () => cached('workflows', 6e5, () => call('GET', '/V3/aiServices/homeWorkflowsV4'));
const fetchEffects   = () => cached('effects',   6e5, () => call('GET', '/V3/aiServices/aiEffects'));

const GENERATE_SPECS = {
  text:     { path: '/V3/aiServices/textToVideo',        fields: ['model', 'prompt'], permKey: 'text' },
  image:    { path: '/V3/aiServices/imageToVideo',       fields: ['model', 'image_input', 'prompt'], permKey: 'image' },
  template: { path: '/V3/aiServices/templateGeneration',  fields: ['workflow_id', 'workflow_name', 'input_style'], permKey: 'cinema' },
  effect:   { path: '/V3/aiServices/effectGeneration',   fields: ['workflow_id', 'workflow_name', 'input_style'], permKey: 'effects' },
};

const ALLOWED_OPTIONAL = {
  text:     ['aspect_ratio', 'duration', 'quality', 'negative_prompt', 'seed'],
  image:    ['aspect_ratio', 'duration', 'quality', 'negative_prompt', 'seed'],
  template: ['image_input', 'image_input2', 'prompt', 'negative_prompt'],
  effect:   ['image_input', 'prompt', 'negative_prompt'],
};

function send(res, status, data) {
  res
    .status(status)
    .setHeader('Content-Type', 'application/json')
    .setHeader('X-Content-Type-Options', 'nosniff')
    .setHeader('X-Frame-Options', 'DENY')
    .setHeader('Referrer-Policy', 'no-referrer')
    .setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-admin');
    res.status(204).end();
    return;
  }

  const url = new URL(req.url, 'https://x');
  const p   = url.pathname.replace(/\/+$/, '') || '/';
  const m   = req.method;

  const matchPath = (target) => p === target || p === '/api' + target || p.endsWith(target);

  // ── HEALTH & CONFIG (PUBLIC) ──────────────────────────────────────────────
  if (m === 'GET' && (matchPath('/health'))) {
    send(res, 200, { ok: true, ts: Date.now(), razorpayKeyId: RAZORPAY_KEY_ID || null });
    return;
  }

  // ── PUBLIC AUTH ENDPOINTS (NO KEY NEEDED) ──────────────────────────────────
  if (m === 'POST' && matchPath('/auth/signup')) {
    try {
      const result = await signupUser(req.body || {});
      if (result?.token) setAuthCookie(res, result.token);
      send(res, 200, result);
    } catch (err) {
      send(res, 400, { error: err.message });
    }
    return;
  }

  if (m === 'POST' && matchPath('/auth/login')) {
    try {
      const result = await loginUser(req.body || {});
      if (result?.token) setAuthCookie(res, result.token);
      send(res, 200, result);
    } catch (err) {
      send(res, 400, { error: err.message });
    }
    return;
  }

  if (m === 'POST' && matchPath('/auth/google')) {
    try {
      const { credential, email, name } = req.body || {};
      let userEmail = email;
      let userName = name;

      // Parse JWT payload from Google Credential token if present
      if (credential && !userEmail) {
        try {
          const payloadB64 = credential.split('.')[1];
          const payloadJson = Buffer.from(payloadB64, 'base64').toString('utf8');
          const payload = JSON.parse(payloadJson);
          userEmail = payload.email;
          userName = payload.name || payload.given_name;
        } catch (e) {
          console.error('Failed to parse Google JWT payload:', e.message);
        }
      }

      if (!userEmail) throw new Error('Could not retrieve email from Google Account');

      const result = await loginOrSignupWithGoogle({ email: userEmail, name: userName });
      if (result?.token) setAuthCookie(res, result.token);
      send(res, 200, result);
    } catch (err) {
      send(res, 400, { error: err.message });
    }
    return;
  }

  if (m === 'POST' && matchPath('/auth/logout')) {
    res.setHeader('Set-Cookie', 'doom_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    send(res, 200, { ok: true });
    return;
  }

  // ── PUBLIC CATALOG ENDPOINTS (NO KEY NEEDED FOR PREVIEW) ───────────────────
  if (m === 'GET' && matchPath('/models'))    { const x = await fetchModels();    send(res, x.status, x.data); return; }
  if (m === 'GET' && matchPath('/workflows')) { const x = await fetchWorkflows(); send(res, x.status, x.data); return; }
  if (m === 'GET' && matchPath('/effects'))   { const x = await fetchEffects();   send(res, x.status, x.data); return; }

  // ── ADMIN ENDPOINTS (/api/admin/*) ────────────────────────────────────────
  if (p.includes('/admin')) {
    const adminHeader = String(req.headers['x-admin'] || '').trim();
    let match = false;
    try {
      const a = Buffer.from(adminHeader.padEnd(64, '\0').slice(0, 64));
      const b = Buffer.from(MASTER.padEnd(64, '\0').slice(0, 64));
      match = crypto.timingSafeEqual(a, b) && adminHeader === MASTER;
    } catch { match = false; }
    if (!match) { send(res, 403, { error: 'Forbidden: invalid admin secret' }); return; }

    if (m === 'POST' && (matchPath('/admin/mint') || matchPath('/admin/create-key'))) {
      const { label, durationAmount, durationUnit, permissions } = req.body || {};
      if (!label || typeof label !== 'string' || label.length > 64) {
        send(res, 400, { error: 'User label is required (max 64 chars)' });
        return;
      }

      let expiresAt = null;
      const amount = parseInt(durationAmount, 10);
      if (amount > 0 && durationUnit && durationUnit !== 'unlimited') {
        const unitMs = {
          seconds: 1000,
          minutes: 60 * 1000,
          hours: 60 * 60 * 1000,
          days: 24 * 60 * 60 * 1000,
          months: 30 * 24 * 60 * 60 * 1000,
          years: 365 * 24 * 60 * 60 * 1000,
        }[durationUnit] || (24 * 60 * 60 * 1000);
        expiresAt = Date.now() + (amount * unitMs);
      }

      const tag = hmac(MASTER, 'k:' + label).slice(0, 32);
      const key = `master-${enc(label)}_${tag}`;
      const entry = addKey({ key, label, expiresAt, permissions });
      send(res, 200, { key, label, entry });
      return;
    }

    if (m === 'POST' && matchPath('/admin/revoke')) {
      const { key } = req.body || {};
      if (!key) { send(res, 400, { error: 'Key required' }); return; }
      const ok = revokeKey(key);
      send(res, 200, { ok });
      return;
    }

    if (m === 'POST' && matchPath('/admin/unrevoke')) {
      const { key } = req.body || {};
      if (!key) { send(res, 400, { error: 'Key required' }); return; }
      const ok = unrevokeKey(key);
      send(res, 200, { ok });
      return;
    }

    if (m === 'POST' && matchPath('/admin/delete')) {
      const { key } = req.body || {};
      if (!key) { send(res, 400, { error: 'Key required' }); return; }
      const ok = deleteKey(key);
      send(res, 200, { ok });
      return;
    }

    if (m === 'POST' && matchPath('/admin/verify-key')) {
      const { key } = req.body || {};
      if (!key) { send(res, 400, { error: 'Key required' }); return; }
      const validHMAC = verifyKey(key);
      const statusObj = verifyKeyStatus(key);
      send(res, 200, {
        valid: Boolean(validHMAC),
        label: validHMAC || statusObj.entry?.label || 'Unknown',
        status: statusObj.status,
        entry: statusObj.entry
      });
      return;
    }

    if (m === 'GET' && matchPath('/admin/data')) {
      send(res, 200, { stats: { serverTime: Date.now(), ...getStats() } });
      return;
    }
    if (m === 'GET' && matchPath('/admin/keys')) { send(res, 200, { keys: listKeys() }); return; }

    send(res, 404, { error: 'Admin endpoint not found' });
    return;
  }

  // ── AUTH & SESSION VERIFICATION FOR PROTECTED ENDPOINTS ─────────────────
  let userSession = null;
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.doom_session) {
    userSession = await verifyUserToken(cookies.doom_session);
  }

  if (!userSession) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      userSession = await verifyUserToken(token);
    }
  }

  // Backwards-compatible API key header fallback
  const rawKey = req.headers['x-api-key'];
  const cleanKey = rawKey ? String(rawKey).trim() : '';
  const label = cleanKey ? verifyKey(cleanKey) : false;

  if (!userSession && !label) {
    send(res, 401, { error: 'Unauthorized: Please log in or provide a valid API key' });
    return;
  }

  // GET /api/auth/me — Return current user profile
  if (m === 'GET' && matchPath('/auth/me')) {
    if (!userSession) { send(res, 401, { error: 'Unauthorized' }); return; }
    send(res, 200, { user: userSession, packages: PACKAGES });
    return;
  }

  // Device ID selection (User account or API Key)
  const deviceId = userSession ? deviceFor(userSession.id) : deviceFor(cleanKey);

  // ── RAZORPAY PAYMENT ENDPOINTS ────────────────────────────────────────────
  if (m === 'POST' && matchPath('/payment/create-order')) {
    if (!userSession) { send(res, 401, { error: 'Login required to purchase credits' }); return; }
    const packageId = String((req.body || {}).packageId || '').toLowerCase();
    const pkg = PACKAGES[packageId];
    if (!pkg) { send(res, 400, { error: 'Invalid package selected' }); return; }

    if (!razorpay) {
      const mockOrder = {
        id: 'order_mock_' + crypto.randomBytes(8).toString('hex'),
        amount: pkg.price * 100,
        currency: 'INR',
        packageId: pkg.id,
        key: 'rzp_test_mock_key',
        isMock: true,
      };
      send(res, 200, mockOrder);
      return;
    }

    try {
      const order = await razorpay.orders.create({
        amount: pkg.price * 100,
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`,
        notes: { userId: String(userSession.id), packageId: pkg.id },
      });
      send(res, 200, { ...order, key: RAZORPAY_KEY_ID, packageId: pkg.id });
    } catch (err) {
      console.error('Razorpay Order Error:', err);
      const errMsg = err?.description || err?.error?.description || err?.message || 'Invalid Razorpay key or order parameter';
      send(res, 500, { error: 'Razorpay Error: ' + errMsg });
    }
    return;
  }

  if (m === 'POST' && matchPath('/payment/verify')) {
    if (!userSession) { send(res, 401, { error: 'Login required' }); return; }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, packageId, isMock } = req.body || {};

    if (isMock || !razorpay) {
      try {
        const updatedUser = await addPackageCredits(userSession.id, packageId, razorpay_payment_id || 'pay_mock');
        send(res, 200, { success: true, message: 'Payment verified! Credits added.', user: updatedUser });
      } catch (e) {
        send(res, 400, { error: e.message });
      }
      return;
    }

    if (!razorpay_payment_id) {
      send(res, 400, { error: 'Invalid payment parameters: payment_id missing' });
      return;
    }

    let isVerified = false;

    // 1. Primary verification: HMAC Signature Check
    if (razorpay_order_id && razorpay_signature) {
      const expectedSig = hmac(RAZORPAY_KEY_SECRET, razorpay_order_id + '|' + razorpay_payment_id);
      if (expectedSig === razorpay_signature) {
        isVerified = true;
      }
    }

    // 2. Secondary Bulletproof verification: Fetch Payment status directly from Razorpay API
    if (!isVerified && razorpay) {
      try {
        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        if (payment && (payment.status === 'captured' || payment.status === 'authorized')) {
          isVerified = true;
        }
      } catch (err) {
        console.error('Razorpay fetch payment error:', err);
      }
    }

    if (!isVerified) {
      send(res, 400, { error: 'Payment signature verification failed' });
      return;
    }

    try {
      const updatedUser = await addPackageCredits(userSession.id, packageId, razorpay_payment_id);
      send(res, 200, { success: true, message: 'Payment verified! Credits added.', user: updatedUser });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
    return;
  }

  // ── UPLOAD ───────────────────────────────────────────────────────────────
  if (m === 'POST' && matchPath('/upload')) {
    const b64 = String((req.body || {}).base64Image || (req.body || {}).image || '');
    if (!b64) { send(res, 400, { error: 'base64Image is required' }); return; }
    if (b64.length > 10_000_000) { send(res, 413, { error: 'Image too large' }); return; }
    await ensureDevice(deviceId);
    const x = await call('POST', '/aiServices/upload-url', { deviceId, base64Image: b64 });
    if (!x.ok) { send(res, 502, { error: 'Image upload failed' }); return; }
    send(res, 200, x.data);
    return;
  }

  // ── GENERATE WITH TIERED CREDIT DEDUCTION ───────────────────────────────
  if (m === 'POST' && matchPath('/generate')) {
    const body = req.body || {};
    const type = String(body.type || 'text').toLowerCase();
    const spec = GENERATE_SPECS[type];
    if (!spec) { send(res, 400, { error: `Unknown type. Valid: ${Object.keys(GENERATE_SPECS).join(', ')}` }); return; }

    for (const f of spec.fields) {
      if (!body[f] || typeof body[f] !== 'string' || !body[f].trim()) {
        send(res, 400, { error: `Missing or empty required field: "${f}"` });
        return;
      }
    }

    const modelName = body.model || body.workflow_name || '';
    const userTier = userSession?.plan || 'starter';
    const creditCost = getModelCost(modelName, userTier);

    if (userSession) {
      try {
        await deductCredits(userSession.id, creditCost);
      } catch (err) {
        send(res, 402, { error: err.message });
        return;
      }
    }

    if (body.prompt) body.prompt = String(body.prompt).replace(/[\x00-\x1F\x7F]/g, '').slice(0, 1000);

    const allowed = [...spec.fields, ...(ALLOWED_OPTIONAL[type] || [])];
    const payload = { deviceId, creditCost: 0.0000000000001 };
    for (const f of allowed) {
      if (body[f] != null) payload[f] = body[f];
    }

    await ensureDevice(deviceId);
    const x = await call('POST', spec.path, payload);

    if (!x.ok) {
      if (userSession) await refundCredits(userSession.id, creditCost);
      send(res, 502, { error: 'Generation request failed. Credits refunded.' });
      return;
    }

    send(res, 200, { ...x.data, creditCostDeducted: creditCost });
    return;
  }

  // ── WORKS (video history) ─────────────────────────────────────────────────
  if (m === 'GET' && matchPath('/works')) {
    const x = await call('GET', `/V3/user/${deviceId}`);
    if (!x.ok) { send(res, x.status, { error: 'Could not fetch history' }); return; }
    const u = x.data?.user;
    const works = (u && (u.recentWorks || u.history)) || [];
    send(res, 200, { works, credit: userSession ? userSession.credits : (u?.credit || 0) });
    return;
  }

  send(res, 404, { error: 'Not found' });
}
