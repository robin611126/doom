import crypto from 'node:crypto';
import {
  addKey,
  getKey,
  verifyKeyStatus,
  recordUsage,
  revokeKey,
  unrevokeKey,
  deleteKey,
  updatePermissions,
  listKeys,
  getStats,
} from '../lib/keys.js';

export const config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: '12mb' } },
};

const BACKEND  = 'https://shark-app-qm22v.ondigitalocean.app';
const MASTER   = String(process.env.MASTER_KEY || 'masterstroke123').trim();
const TIMEOUT  = 30_000;

// ── Caches ─────────────────────────────────────────────────────────────────
const cache      = new Map();   // catalog cache
const registered = new Set();   // deviceIds registered this instance

// ── Crypto helpers ───────────────────────────────────────────────────────────
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac   = (k, d) => crypto.createHmac('sha256', k).update(d).digest('hex');
const enc    = (s) => Buffer.from(s, 'utf8').toString('base64url');
const dec    = (s) => Buffer.from(s, 'base64url').toString('utf8');

/** Create a deterministic, HMAC-signed API key from a label */
const makeKey = (label) =>
  `master-${enc(label)}_${hmac(MASTER, 'k:' + label).slice(0, 32)}`;

/** Returns the label if key is valid HMAC, false otherwise. Timing-safe. */
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

/** Calculate expiry timestamp from amount + unit. Returns null = unlimited. */
function calculateExpiresAt(amount, unit) {
  if (!amount || unit === 'unlimited') return null;
  const num = Number(amount);
  if (isNaN(num) || num <= 0 || num > 1_000_000) return null;
  const ms = { seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5, months: 30 * 864e5, years: 365 * 864e5 }[unit];
  if (!ms) return null;
  return Date.now() + num * ms;
}

// ── Catalog helpers ──────────────────────────────────────────────────────────
const cached = (k, ttl, fn) => {
  const h = cache.get(k);
  if (h && Date.now() - h.t < ttl) return h.v;
  return fn().then((v) => { cache.set(k, { t: Date.now(), v }); return v; });
};

// ── Upstream fetch with anti-leak sanitization ────────────────────────────────
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
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: 'Upstream request failed' };
    }
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

// Catalog endpoints
const fetchModels    = () => cached('models',    6e5, () => call('GET', '/V3/aiServices/models'));
const fetchWorkflows = () => cached('workflows', 6e5, () => call('GET', '/V3/aiServices/homeWorkflowsV4'));
const fetchEffects   = () => cached('effects',   6e5, () => call('GET', '/V3/aiServices/aiEffects'));

// Allowed generation types with required fields (whitelist approach - no injection)
const GENERATE_SPECS = {
  text:     { path: '/V3/aiServices/textToVideo',        fields: ['model', 'prompt'], permKey: 'text' },
  image:    { path: '/V3/aiServices/imageToVideo',       fields: ['model', 'image_input', 'prompt'], permKey: 'image' },
  template: { path: '/V3/aiServices/templateGeneration',  fields: ['workflow_id', 'workflow_name', 'input_style'], permKey: 'cinema' },
  effect:   { path: '/V3/aiServices/effectGeneration',   fields: ['workflow_id', 'workflow_name', 'input_style'], permKey: 'effects' },
};

// Allowed optional fields per type
const ALLOWED_OPTIONAL = {
  text:     ['aspect_ratio', 'duration', 'quality', 'negative_prompt', 'seed'],
  image:    ['aspect_ratio', 'duration', 'quality', 'negative_prompt', 'seed'],
  template: ['image_input', 'image_input2', 'prompt', 'negative_prompt'],
  effect:   ['image_input', 'prompt', 'negative_prompt'],
};

// ── Response helper with hardened security headers ─────────────────────────
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

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Always handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-admin');
    res.status(204).end();
    return;
  }

  const url = new URL(req.url, 'https://x');
  const p   = url.pathname.replace(/\/+$/, '') || '/';
  const m   = req.method;

  // Health check — no auth needed
  if (m === 'GET' && (p === '/api/health' || p === '/health')) {
    send(res, 200, { ok: true, ts: Date.now() });
    return;
  }

  // ── ADMIN ENDPOINTS (/api/admin/*) ────────────────────────────────────────
  if (p.startsWith('/api/admin')) {
    const adminHeader = String(req.headers['x-admin'] || '').trim();
    // Constant-time compare to prevent timing attacks on the admin secret
    let match = false;
    try {
      const a = Buffer.from(adminHeader.padEnd(64, '\0').slice(0, 64));
      const b = Buffer.from(MASTER.padEnd(64, '\0').slice(0, 64));
      match = crypto.timingSafeEqual(a, b) && adminHeader === MASTER;
    } catch { match = false; }
    if (!match) {
      send(res, 403, { error: 'Forbidden: invalid admin secret' });
      return;
    }

    // GET /api/admin/data — dashboard stats & metrics
    if (m === 'GET' && p === '/api/admin/data') {
      send(res, 200, {
        stats: {
          serverTime: Date.now(),
          ...getStats(),
        },
      });
      return;
    }

    // GET /api/admin/keys — list all managed keys
    if (m === 'GET' && p === '/api/admin/keys') {
      send(res, 200, { keys: listKeys() });
      return;
    }

    // POST /api/admin/mint — generate a signed key and save to store
    if (m === 'POST' && p === '/api/admin/mint') {
      const label = String((req.body || {}).label || '').trim().slice(0, 64);
      if (!label || !/^[a-zA-Z0-9_\-\.@]+$/.test(label)) {
        send(res, 400, { error: 'Label required (alphanumeric, dash, underscore, dot, @ only)' });
        return;
      }
      const perms = (req.body || {}).permissions || {};
      const permissions = {
        text:    perms.text    !== false,
        image:   perms.image   !== false,
        cinema:  perms.cinema  !== false,
        effects: perms.effects !== false,
      };
      const { durationAmount, durationUnit } = req.body || {};
      const expiresAt = calculateExpiresAt(durationAmount, durationUnit);
      const key = makeKey(label);

      const entry = addKey({
        key,
        label,
        createdAt: Date.now(),
        expiresAt,
        permissions,
      });

      send(res, 200, { key, entry });
      return;
    }

    // POST /api/admin/revoke — revoke an API key
    if (m === 'POST' && p === '/api/admin/revoke') {
      const keyToRevoke = String((req.body || {}).key || '').trim();
      const success = revokeKey(keyToRevoke);
      if (!success) { send(res, 404, { error: 'Key not found' }); return; }
      send(res, 200, { success: true, message: 'Key revoked successfully' });
      return;
    }

    // POST /api/admin/unrevoke — restore a revoked API key
    if (m === 'POST' && p === '/api/admin/unrevoke') {
      const keyToRestore = String((req.body || {}).key || '').trim();
      const success = unrevokeKey(keyToRestore);
      if (!success) { send(res, 404, { error: 'Key not found' }); return; }
      send(res, 200, { success: true, message: 'Key restored successfully' });
      return;
    }

    // POST /api/admin/delete — permanently delete an API key
    if (m === 'POST' && p === '/api/admin/delete') {
      const keyToDelete = String((req.body || {}).key || '').trim();
      const success = deleteKey(keyToDelete);
      if (!success) { send(res, 404, { error: 'Key not found' }); return; }
      send(res, 200, { success: true, message: 'Key deleted successfully' });
      return;
    }

    // POST /api/admin/update-permissions — update permissions for a key
    if (m === 'POST' && p === '/api/admin/update-permissions') {
      const { key: keyToUpdate, permissions } = req.body || {};
      if (!keyToUpdate || !permissions) { send(res, 400, { error: 'Key and permissions required' }); return; }
      const updated = updatePermissions(keyToUpdate, permissions);
      if (!updated) { send(res, 404, { error: 'Key not found' }); return; }
      send(res, 200, { success: true, entry: updated });
      return;
    }

    // POST /api/admin/verify-key — check key validity & status
    if (m === 'POST' && p === '/api/admin/verify-key') {
      const keyToCheck = String((req.body || {}).key || '').trim();
      const label = verifyKey(keyToCheck);
      if (!label) {
        send(res, 200, { valid: false, reason: 'Invalid cryptographic signature', key: keyToCheck });
        return;
      }
      const v = verifyKeyStatus(keyToCheck);
      send(res, 200, {
        valid: v.status === 'valid',
        status: v.status,
        label,
        key: keyToCheck,
        entry: v.entry || null,
      });
      return;
    }

    send(res, 404, { error: 'Admin endpoint not found' });
    return;
  }

  // ── USER AUTH GATE ────────────────────────────────────────────────────────
  const rawKey = req.headers['x-api-key'];
  const cleanKey = rawKey ? String(rawKey).trim() : '';
  const label = cleanKey ? verifyKey(cleanKey) : false;

  if (!label) {
    send(res, 401, { error: 'Unauthorized: invalid or missing API key' });
    return;
  }

  // Check persistent store status (expiration, revocation)
  let keyStatusInfo = verifyKeyStatus(cleanKey);
  if (keyStatusInfo.status === 'not_found') {
    // Automatically register HMAC-valid key in DB if not present
    addKey({ key: cleanKey, label, createdAt: Date.now(), permissions: { text: true, image: true, cinema: true, effects: true } });
    keyStatusInfo = verifyKeyStatus(cleanKey);
  }

  if (keyStatusInfo.status === 'revoked') {
    send(res, 401, { error: 'Unauthorized: API key has been revoked by admin' });
    return;
  }

  if (keyStatusInfo.status === 'expired') {
    send(res, 401, { error: 'Unauthorized: API key has expired' });
    return;
  }

  // Record key usage count & timestamp
  recordUsage(cleanKey);
  const keyEntry = keyStatusInfo.entry || getKey(cleanKey);
  const perms = keyEntry?.permissions || { text: true, image: true, cinema: true, effects: true };

  const deviceId = deviceFor(cleanKey);

  // ── CATALOG ──────────────────────────────────────────────────────────────
  if (m === 'GET' && p === '/api/models')    { const x = await fetchModels();    send(res, x.status, x.data); return; }
  if (m === 'GET' && p === '/api/workflows') { const x = await fetchWorkflows(); send(res, x.status, x.data); return; }
  if (m === 'GET' && p === '/api/effects')   { const x = await fetchEffects();   send(res, x.status, x.data); return; }

  // ── UPLOAD ───────────────────────────────────────────────────────────────
  if (m === 'POST' && p === '/api/upload') {
    if (perms.image === false) {
      send(res, 403, { error: 'Forbidden: API key does not have image upload permission' });
      return;
    }
    const b64 = String((req.body || {}).base64Image || (req.body || {}).image || '');
    if (!b64) { send(res, 400, { error: 'base64Image is required' }); return; }
    if (b64.length > 10_000_000) { send(res, 413, { error: 'Image too large' }); return; }
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) { send(res, 400, { error: 'Invalid base64 data' }); return; }
    await ensureDevice(deviceId);
    const x = await call('POST', '/aiServices/upload-url', { deviceId, base64Image: b64 });
    if (!x.ok) { send(res, 502, { error: 'Image upload failed' }); return; }
    send(res, 200, x.data);
    return;
  }

  // ── GENERATE ─────────────────────────────────────────────────────────────
  if (m === 'POST' && p === '/api/generate') {
    const body = req.body || {};
    const type = String(body.type || 'text').toLowerCase();
    const spec = GENERATE_SPECS[type];
    if (!spec) {
      send(res, 400, { error: `Unknown type. Valid: ${Object.keys(GENERATE_SPECS).join(', ')}` });
      return;
    }

    // Permission Gate Check
    if (perms[spec.permKey] === false) {
      send(res, 403, { error: `Forbidden: API key does not have permission for ${spec.permKey} feature` });
      return;
    }

    // Validate required fields exist and are non-empty strings
    for (const f of spec.fields) {
      if (!body[f] || typeof body[f] !== 'string' || !body[f].trim()) {
        send(res, 400, { error: `Missing or empty required field: "${f}"` });
        return;
      }
    }

    // Sanitize prompt — strip control chars
    if (body.prompt) body.prompt = String(body.prompt).replace(/[\x00-\x1F\x7F]/g, '').slice(0, 1000);

    // Build upstream payload from WHITELISTED fields only
    const allowed = [...spec.fields, ...(ALLOWED_OPTIONAL[type] || [])];
    const payload = { deviceId, creditCost: 0.0000000000001 };
    for (const f of allowed) {
      if (body[f] != null) payload[f] = body[f];
    }

    await ensureDevice(deviceId);
    const x = await call('POST', spec.path, payload);
    if (!x.ok) {
      send(res, 502, { error: 'Generation request failed. Please try again.' });
      return;
    }
    send(res, 200, x.data);
    return;
  }

  // ── WORKS (video history) ─────────────────────────────────────────────────
  if (m === 'GET' && p === '/api/works') {
    const x = await call('GET', `/V3/user/${deviceId}`);
    if (!x.ok) { send(res, x.status, { error: 'Could not fetch history' }); return; }
    const u = x.data?.user;
    const works = (u && (u.recentWorks || u.history)) || [];
    send(res, 200, { works, credit: u?.credit || 0 });
    return;
  }

  send(res, 404, { error: 'Not found' });
}
