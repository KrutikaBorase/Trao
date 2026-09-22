import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { buildKitFromCase } from './pipeline.js';
import { createSessionToken, verifySessionToken } from '../lib/session.js';
import { validateKitStructure } from '../lib/validate.js';

const app = express();
const PORT = Number(process.env.PORT || 3001);
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-session-secret';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const KITS_FILE = path.join(DATA_DIR, 'kits.json');

let users = new Map();
let kitsByUser = new Map();

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET must be configured in production');
}

async function ensureJsonFile(filePath, fallback) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    await fs.writeFile(filePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

async function saveUsers() {
  const serialized = Object.fromEntries([...users.entries()].map(([id, user]) => [id, { ...user, password: user.password || '' }]));
  await fs.writeFile(USERS_FILE, JSON.stringify(serialized, null, 2));
}

async function saveKits() {
  const serialized = Object.fromEntries([...kitsByUser.entries()].map(([userId, items]) => [userId, items]));
  await fs.writeFile(KITS_FILE, JSON.stringify(serialized, null, 2));
}

async function hydrateStores() {
  const persistedUsers = await ensureJsonFile(USERS_FILE, {
    'demo-user': { email: 'demo@example.com', password: 'password123' },
  });
  users = new Map(Object.entries(persistedUsers));

  for (const [userId, user] of users.entries()) {
    if (user.password && !user.password.startsWith('$2')) {
      user.password = await bcrypt.hash(user.password, 12);
      users.set(userId, user);
    }
  }

  const persistedKits = await ensureJsonFile(KITS_FILE, {});
  kitsByUser = new Map(Object.entries(persistedKits));

  if (!users.has('demo-user')) {
    users.set('demo-user', { email: 'demo@example.com', password: await bcrypt.hash('password123', 12) });
    await saveUsers();
  }

  await saveUsers();
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8,
  };
}

function getUserFromRequest(req) {
  const token = req.cookies?.session || req.headers['x-session'];
  if (!token) return null;

  const verified = verifySessionToken(token, SESSION_SECRET);
  if (!verified) return null;

  const userRecord = users.get(verified.id);
  if (!userRecord) return null;

  return { ...userRecord, id: verified.id };
}

const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',').map((origin) => origin.trim());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, environment: process.env.NODE_ENV || 'development' });
});

app.get('/api/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  return res.json({ user: { id: user.id, email: user.email } });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  for (const existing of users.values()) {
    if (existing.email === normalizedEmail) {
      return res.status(409).json({ message: 'A user with that email already exists.' });
    }
  }

  const userId = `user_${Date.now()}`;
  if (String(password).length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }
  users.set(userId, { email: normalizedEmail, password: await bcrypt.hash(String(password), 12) });
  await saveUsers();

  const token = createSessionToken({ id: userId, email: normalizedEmail }, SESSION_SECRET, 1000 * 60 * 60 * 8);
  res.cookie('session', token, getCookieOptions());
  return res.status(201).json({ user: { id: userId, email: normalizedEmail } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const matchedUser = (await Promise.all([...users.entries()].map(async ([userId, entry]) => {
    const matches = entry.email === normalizedEmail && await bcrypt.compare(String(password), entry.password);
    return matches ? [userId, entry] : null;
  }))).find(Boolean);

  if (!matchedUser) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const [userId, userRecord] = matchedUser;
  const token = createSessionToken({ id: userId, email: userRecord.email }, SESSION_SECRET, 1000 * 60 * 60 * 8);
  res.cookie('session', token, getCookieOptions());
  return res.status(200).json({ user: { id: userId, email: userRecord.email } });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  return res.status(200).json({ ok: true });
});

app.get('/api/kits', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  const list = kitsByUser.get(user.id) || [];
  return res.json({ kits: list });
});

app.patch('/api/kits/:kitId', async (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const kit = req.body?.kit;
  try {
    validateKitStructure(kit);
  } catch (error) {
    return res.status(400).json({ message: error.message || 'Invalid kit.' });
  }

  const userKits = kitsByUser.get(user.id) || [];
  const kitIndex = userKits.findIndex((entry) => entry.id === req.params.kitId);
  if (kitIndex < 0) {
    return res.status(404).json({ message: 'Kit not found.' });
  }

  const nextKits = [...userKits];
  nextKits[kitIndex] = { ...nextKits[kitIndex], kit };
  kitsByUser.set(user.id, nextKits);
  await saveKits();
  return res.json({ id: req.params.kitId, kit });
});

app.post('/api/kits/generate', async (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const { jd, company_url, days = 5, id = 'case-01' } = req.body || {};
    if (!jd || !company_url) {
      return res.status(400).json({ message: 'job description and company URL are required.' });
    }

    const result = await buildKitFromCase({ id, jd, company_url, days });
    const userKits = kitsByUser.get(user.id) || [];
    const nextList = [...userKits.filter((entry) => entry.id !== result.id), { id: result.id, kit: result.kit, status: result.status, error: result.error }];
    kitsByUser.set(user.id, nextList);
    await saveKits();

    return res.json({ id: result.id, status: result.status, kit: result.kit, error: result.error });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Generation failed.' });
  }
});

async function startServer() {
  await hydrateStores();
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

startServer();
