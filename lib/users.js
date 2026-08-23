import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase, readLocalData, writeLocalData } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'doom_secret_jwt_key_2026_x';
const VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days validity across all packages

// ── PAY-AS-YOU-GO PACKAGES ──────────────────────────────────────────────────
export const PACKAGES = {
  starter: { id: 'starter', name: 'Starter', price: 149, credits: 500, validityDays: 30, queue: 'Standard' },
  creator: { id: 'creator', name: 'Creator', price: 399, credits: 1500, validityDays: 30, queue: 'Priority' },
  studio:  { id: 'studio',  name: 'Studio',  price: 999, credits: 5000, validityDays: 30, queue: 'Highest' },
};

// ── TIERED MODEL CREDIT RATES (PER GENERATION) ────────────────────────────────
export const MODEL_RATES = {
  pixverse:    { default: 25, starter: 25, creator: 20, studio: 15 },
  hailuo:      { default: 40, starter: 40, creator: 30, studio: 25 },
  kling_pro:   { default: 50, starter: 50, creator: 40, studio: 30 },
  grok:        { default: 50, starter: 50, creator: 40, studio: 30 },
  wan:         { default: 100, starter: 100, creator: 75, studio: 55 },
  veo_fast:    { default: 120, starter: 120, creator: 95, studio: 70 },
  veo:         { default: 125, starter: 125, creator: 100, studio: 75 },
  kling:       { default: 125, starter: 125, creator: 100, studio: 75 },
  sora:        { default: 125, starter: 125, creator: 100, studio: 75 },
  seedance:    { default: 140, starter: 140, creator: 100, studio: 75 },
};

/** Get credit cost for a model based on user package tier */
export function getModelCost(modelName = '', tier = 'starter') {
  const m = String(modelName).toLowerCase();
  let rateKey = 'veo';

  if (m.includes('pixverse')) rateKey = 'pixverse';
  else if (m.includes('hailuo') || m.includes('minimax')) rateKey = 'hailuo';
  else if (m.includes('kling') && m.includes('pro')) rateKey = 'kling_pro';
  else if (m.includes('grok')) rateKey = 'grok';
  else if (m.includes('wan')) rateKey = 'wan';
  else if (m.includes('veo') && m.includes('fast')) rateKey = 'veo_fast';
  else if (m.includes('veo')) rateKey = 'veo';
  else if (m.includes('kling')) rateKey = 'kling';
  else if (m.includes('sora')) rateKey = 'sora';
  else if (m.includes('seedance')) rateKey = 'seedance';

  const rates = MODEL_RATES[rateKey] || MODEL_RATES.veo;
  return rates[tier] || rates.starter || rates.default;
}

// ── USER AUTHENTICATION & CREATION ───────────────────────────────────────────
export async function signupUser({ email, password, name = '' }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) throw new Error('Valid email required');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');

  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();

  // Try Supabase first if available
  if (supabase) {
    const { data: existing } = await supabase.from('users').select('id').eq('email', cleanEmail).single();
    if (existing) throw new Error('Account with this email already exists');

    const { data: user, error } = await supabase.from('users').insert({
      email: cleanEmail,
      password_hash: passwordHash,
      name,
      plan: 'free',
      credits: 50, // 50 welcome bonus credits
      validity_expires_at: new Date(now + VALIDITY_MS).toISOString(),
      created_at: new Date(now).toISOString(),
    }).select().single();

    if (error) throw new Error(error.message);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    return { token, user: sanitizeUser(user) };
  }

  // Fallback to local storage
  const users = readLocalData('users.json');
  if (users.find((u) => u.email === cleanEmail)) {
    throw new Error('Account with this email already exists');
  }

  const newUser = {
    id: 'usr_' + crypto.randomBytes(8).toString('hex'),
    email: cleanEmail,
    passwordHash,
    name: name || cleanEmail.split('@')[0],
    plan: 'free',
    credits: 50,
    validityExpiresAt: now + VALIDITY_MS,
    createdAt: now,
  };

  users.push(newUser);
  writeLocalData('users.json', users);

  const token = jwt.sign({ userId: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '30d' });
  return { token, user: sanitizeUser(newUser) };
}

export async function loginUser({ email, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) throw new Error('Email and password required');

  if (supabase) {
    const { data: user, error } = await supabase.from('users').select('*').eq('email', cleanEmail).single();
    if (error || !user) throw new Error('Invalid email or password');

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) throw new Error('Invalid email or password');

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    return { token, user: sanitizeUser(user) };
  }

  const users = readLocalData('users.json');
  const user = users.find((u) => u.email === cleanEmail);
  if (!user) throw new Error('Invalid email or password');

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) throw new Error('Invalid email or password');

  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  return { token, user: sanitizeUser(user) };
}

export async function verifyUserToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.userId;

    if (supabase) {
      const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
      return user ? sanitizeUser(user) : null;
    }

    const users = readLocalData('users.json');
    const user = users.find((u) => u.id === userId);
    return user ? sanitizeUser(user) : null;
  } catch {
    return null;
  }
}

// ── CREDIT & PACKAGE PURCHASES ──────────────────────────────────────────────
export async function addPackageCredits(userId, packageId, paymentId = '') {
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new Error('Invalid package selected');

  const now = Date.now();
  const newExpiry = now + VALIDITY_MS; // 30 days validity

  if (supabase) {
    const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    if (!user) throw new Error('User not found');

    const updatedCredits = (user.credits || 0) + pkg.credits;

    const { data: updated, error } = await supabase
      .from('users')
      .update({
        credits: updatedCredits,
        plan: pkg.id,
        validity_expires_at: new Date(newExpiry).toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Record order in transactions
    await supabase.from('orders').insert({
      user_id: userId,
      package_id: pkg.id,
      amount: pkg.price,
      credits_added: pkg.credits,
      payment_id: paymentId,
      created_at: new Date(now).toISOString(),
    });

    return sanitizeUser(updated);
  }

  const users = readLocalData('users.json');
  const index = users.findIndex((u) => u.id === userId);
  if (index === -1) throw new Error('User not found');

  users[index].credits = (users[index].credits || 0) + pkg.credits;
  users[index].plan = pkg.id;
  users[index].validityExpiresAt = newExpiry;

  writeLocalData('users.json', users);

  const orders = readLocalData('orders.json');
  orders.push({
    id: 'ord_' + crypto.randomBytes(8).toString('hex'),
    userId,
    packageId: pkg.id,
    amount: pkg.price,
    creditsAdded: pkg.credits,
    paymentId,
    createdAt: now,
  });
  writeLocalData('orders.json', orders);

  return sanitizeUser(users[index]);
}

export async function deductCredits(userId, amount) {
  if (amount <= 0) return true;

  if (supabase) {
    const { data: user } = await supabase.from('users').select('credits, validity_expires_at').eq('id', userId).single();
    if (!user) throw new Error('User not found');

    const exp = user.validity_expires_at ? new Date(user.validity_expires_at).getTime() : 0;
    if (exp && Date.now() > exp) {
      throw new Error('Package validity has expired (30 days). Please purchase a package to continue.');
    }

    if ((user.credits || 0) < amount) {
      throw new Error(`Insufficient credits (${user.credits || 0} credits available, ${amount} required)`);
    }

    const { error } = await supabase
      .from('users')
      .update({ credits: user.credits - amount })
      .eq('id', userId);

    if (error) throw new Error(error.message);
    return true;
  }

  const users = readLocalData('users.json');
  const user = users.find((u) => u.id === userId);
  if (!user) throw new Error('User not found');

  if (user.validityExpiresAt && Date.now() > user.validityExpiresAt) {
    throw new Error('Package validity has expired (30 days). Please purchase a package to continue.');
  }

  if ((user.credits || 0) < amount) {
    throw new Error(`Insufficient credits (${user.credits || 0} credits available, ${amount} required)`);
  }

  user.credits -= amount;
  writeLocalData('users.json', users);
  return true;
}

export async function refundCredits(userId, amount) {
  if (amount <= 0) return;
  try {
    if (supabase) {
      const { data: user } = await supabase.from('users').select('credits').eq('id', userId).single();
      if (user) {
        await supabase.from('users').update({ credits: (user.credits || 0) + amount }).eq('id', userId);
      }
      return;
    }
    const users = readLocalData('users.json');
    const user = users.find((u) => u.id === userId);
    if (user) {
      user.credits = (user.credits || 0) + amount;
      writeLocalData('users.json', users);
    }
  } catch {}
}

function sanitizeUser(u) {
  const exp = u.validity_expires_at ? new Date(u.validity_expires_at).getTime() : u.validityExpiresAt;
  return {
    id: u.id,
    email: u.email,
    name: u.name || u.email?.split('@')[0] || '',
    plan: u.plan || 'free',
    credits: u.credits || 0,
    validityExpiresAt: exp || (Date.now() + VALIDITY_MS),
    isExpired: exp ? Date.now() > exp : false,
  };
}
