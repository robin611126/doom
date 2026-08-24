import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from './db.js';

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

export async function addKey(entry) {
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

  if (supabase) {
    try {
      const { error } = await supabase.from('api_keys').insert({
        key: record.key,
        label: record.label,
        created_at: new Date(record.createdAt).toISOString(),
        expires_at: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
        permissions: record.permissions,
        is_revoked: false,
        usage_count: 0
      });
      if (error) console.error('[Supabase Insert Error]:', error);
    } catch (err) {
      console.error('[Supabase Insert Ex]:', err.message);
    }
  }

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

export async function recordUsage(keyStr) {
  initKeys();
  const entry = keysStore.get(keyStr);
  if (entry) {
    entry.usageCount = (entry.usageCount || 0) + 1;
    entry.lastUsed = Date.now();
    saveKeys();
  }
  if (supabase) {
    try {
      await supabase.rpc('increment_key_usage', { key_str: keyStr });
    } catch {}
  }
}

export async function revokeKey(keyStr) {
  initKeys();
  const entry = keysStore.get(keyStr);
  if (entry) {
    entry.isRevoked = true;
    saveKeys();
  }
  if (supabase) {
    try {
      await supabase.from('api_keys').update({ is_revoked: true }).eq('key', keyStr);
    } catch (err) {
      console.error('[Supabase Revoke Ex]:', err.message);
    }
  }
  return true;
}

export async function unrevokeKey(keyStr) {
  initKeys();
  const entry = keysStore.get(keyStr);
  if (entry) {
    entry.isRevoked = false;
    saveKeys();
  }
  if (supabase) {
    try {
      await supabase.from('api_keys').update({ is_revoked: false }).eq('key', keyStr);
    } catch (err) {
      console.error('[Supabase Unrevoke Ex]:', err.message);
    }
  }
  return true;
}

export async function deleteKey(keyStr) {
  initKeys();
  const deleted = keysStore.delete(keyStr);
  if (deleted) saveKeys();
  if (supabase) {
    try {
      await supabase.from('api_keys').delete().eq('key', keyStr);
    } catch (err) {
      console.error('[Supabase Delete Ex]:', err.message);
    }
  }
  return true;
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

export async function listKeys() {
  initKeys();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('api_keys').select('*').order('created_at', { ascending: false });
      if (!error && Array.isArray(data) && data.length > 0) {
        return data.map((item) => {
          const expiresAt = item.expires_at ? new Date(item.expires_at).getTime() : null;
          const isExpired = expiresAt ? Date.now() > expiresAt : false;
          return {
            key: item.key,
            label: item.label,
            createdAt: new Date(item.created_at).getTime(),
            expiresAt,
            expiresReadable: item.expires_at || 'Never',
            permissions: item.permissions || { text: true, image: true, cinema: true, effects: true },
            isRevoked: item.is_revoked || false,
            usageCount: item.usage_count || 0,
            status: item.is_revoked ? 'revoked' : isExpired ? 'expired' : 'active',
          };
        });
      }
    } catch (err) {
      console.error('[Supabase listKeys Error]:', err.message);
    }
  }

  return Array.from(keysStore.values()).map((item) => {
    const isExpired = item.expiresAt ? Date.now() > item.expiresAt : false;
    return {
      ...item,
      status: item.isRevoked ? 'revoked' : isExpired ? 'expired' : 'active',
    };
  });
}

export async function getStats() {
  const keys = await listKeys();
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
