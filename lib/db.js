import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.VERCEL ? '/tmp/doom_data' : path.join(__dirname, '..', 'data');

// Try loading .env locally if process.env isn't populated
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
      const parts = line.trim().split('=');
      if (parts.length >= 2 && !parts[0].startsWith('#')) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch {}

// Initialize Supabase strictly from environment variables
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY
                 || process.env.SUPABASE_SERVICE_ROLE_KEY
                 || process.env.SUPABASE_PUBLISHABLE_KEY
                 || process.env.SUPABASE_ANON_KEY || '';

export const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// Local JSON File Database Fallback (when Supabase env vars are not set)
function ensureFile(filename, defaultContent = '[]') {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf8');
  }
  return filePath;
}

export function readLocalData(filename) {
  const filePath = ensureFile(filename, '[]');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

export function writeLocalData(filename, data) {
  const filePath = ensureFile(filename, '[]');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
