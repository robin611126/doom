import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

// In-memory key store backed by JSON file
let keysStore = new Map();
let isInitialized = false;

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('[KeysDB] Warning: Could not create data directory:', err.message);
  }
}

export function initKeys() {
  if (isInitialized) return;
  ensureDataDir();
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const raw = fs.readFileSync(KEYS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        keysStore.clear();
        for (const item of parsed) {
          if (item && item.key) {
            keysStore.set(item.key, item);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[KeysDB] Error reading keys.json:', err.message);
  }
  isInitialized = true;
}

export function saveKeys() {
  ensureDataDir();
  try {
    const list = Array.from(keysStore.values());
    fs.writeFileSync(KEYS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.warn('[KeysDB] Warning: Could not write keys.json:', err.message);
  }
}

export function addKey(entry) {
  initKeys();
  const record = {
    key: entry.key,
    label: entry.label,
    createdAt: entry.createdAt || Date.now(),
    expiresAt: entry.expiresAt || null,
    expiresReadable: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : 'Never',
    permissions: {
      text: entry.permissions?.text !== false,
      image: entry.permissions?.image !== false,
      cinema: entry.permissions?.cinema !== false,
      effects: entry.permissions?.effects !== false,
    },
    isRevoked: false,
    usageCount: 0,
    lastUsed: null,
  };
  keysStore.set(entry.key, record);
  saveKeys();
  return record;
}

export function getKey(keyStr) {
  initKeys();
  return keysStore.get(keyStr) || null;
}

export function verifyKeyStatus(keyStr) {
  initKeys();
  const entry = keysStore.get(keyStr);
  if (!entry) {
    return { status: 'not_found', entry: null };
  }
  if (entry.isRevoked) {
    return { status: 'revoked', entry };
  }
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    return { status: 'expired', entry };
  }
  return { status: 'valid', entry };
}

export function recordUsage(keyStr) {
  initKeys();
  const entry = keysStore.get(keyStr);
  if (entry) {
    entry.usageCount = (entry.usageCount || 0) + 1;
    entry.lastUsed = Date.now();
    saveKeys();
  }
}

export function revokeKey(keyStr) {
  initKeys();
  const entry = keysStore.get(keyStr);
  if (!entry) return false;
  entry.isRevoked = true;
  saveKeys();
  return true;
}

export function unrevokeKey(keyStr) {
  initKeys();
  const entry = keysStore.get(keyStr);
  if (!entry) return false;
  entry.isRevoked = false;
  saveKeys();
  return true;
}

export function deleteKey(keyStr) {
  initKeys();
  const deleted = keysStore.delete(keyStr);
  if (deleted) saveKeys();
  return deleted;
}

export function updatePermissions(keyStr, perms) {
  initKeys();
  const entry = keysStore.get(keyStr);
  if (!entry) return null;
  entry.permissions = {
    text: perms.text !== false,
    image: perms.image !== false,
    cinema: perms.cinema !== false,
    effects: perms.effects !== false,
  };
  saveKeys();
  return entry;
}

export function listKeys() {
  initKeys();
  return Array.from(keysStore.values()).map((item) => {
    const isExpired = item.expiresAt ? Date.now() > item.expiresAt : false;
    return {
      ...item,
      status: item.isRevoked ? 'revoked' : isExpired ? 'expired' : 'active',
    };
  });
}

export function getStats() {
  initKeys();
  const keys = Array.from(keysStore.values());
  const total = keys.length;
  let active = 0;
  let revoked = 0;
  let expired = 0;
  let totalUsage = 0;

  const now = Date.now();
  for (const k of keys) {
    totalUsage += k.usageCount || 0;
    if (k.isRevoked) {
      revoked++;
    } else if (k.expiresAt && now > k.expiresAt) {
      expired++;
    } else {
      active++;
    }
  }

  return { total, active, revoked, expired, totalUsage };
}
