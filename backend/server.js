import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { buildKitFromCase } from './pipeline.js';
import { researchCompany } from './research.js';
import { createSessionToken, verifySessionToken } from '../lib/session.js';
import { validateKitStructure } from '../lib/validate.js';
import { loadStores, saveKits, saveUsers } from './store.js';

const app = express();
const PORT = Number(process.env.PORT || 3001);
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-session-secret';
let users = new Map();
let kitsByUser = new Map();

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET must be configured in production');
}

async function hydrateStores() {
  const stores = await loadStores();
  users = stores.users;
  kitsByUser = stores.kitsByUser;

  if (!users.size) {
    users.set('demo-user', { email: 'demo@example.com', password: await bcrypt.hash('password123', 12) });
  }

  for (const [userId, user] of users.entries()) {
    if (user.password && !user.password.startsWith('$2')) {
      user.password = await bcrypt.hash(user.password, 12);
      users.set(userId, user);
    }
  }

  await saveUsers(users);
  return stores.durable;
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
function isAllowedOrigin(origin) {
  if (!origin) return true;
  return allowedOrigins.includes(origin) || (process.env.NODE_ENV === 'production' && /^https:\/\/ai-interview-prep-web-[a-z0-9]+\.onrender\.com$/i.test(origin));
}
app.use(cors({ origin: (origin, callback) => callback(null, isAllowedOrigin(origin) ? origin : false), credentials: true }));
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
  await saveUsers(users);

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
  await saveKits(kitsByUser);
  return res.json({ id: req.params.kitId, kit });
});

app.post('/api/kits/:kitId/regenerate', async (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Authentication required.' });

  const section = req.body?.section;
  const userKits = kitsByUser.get(user.id) || [];
  const kitIndex = userKits.findIndex((entry) => entry.id === req.params.kitId);
  if (kitIndex < 0) return res.status(404).json({ message: 'Kit not found.' });
  if (section !== 'company-brief') return res.status(400).json({ message: 'Only company-brief regeneration is handled by this endpoint.' });

  const current = userKits[kitIndex].kit;
  const research = await researchCompany(current.source.company_url);
  const nextKit = {
    ...current,
    source: { ...current.source, researched_at: new Date().toISOString(), pages_used: research.sources.length ? research.sources : current.source.pages_used },
    company_brief: {
      ...current.company_brief,
      summary: research.summary,
      what_they_do: research.what_they_do,
      sources: research.sources.length ? research.sources : current.company_brief.sources,
      interview_process_sources: research.discussionSources || [],
      retrieval_failures: research.retrievalFailures || [],
    },
  };
  try {
    validateKitStructure(nextKit);
  } catch (error) {
    return res.status(422).json({ message: error.message || 'Regenerated brief made the kit invalid.' });
  }
  const nextKits = [...userKits];
  nextKits[kitIndex] = { ...nextKits[kitIndex], kit: nextKit };
  kitsByUser.set(user.id, nextKits);
  await saveKits(kitsByUser);
  return res.json({ id: req.params.kitId, kit: nextKit });
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
    await saveKits(kitsByUser);

    return res.json({ id: result.id, status: result.status, kit: result.kit, error: result.error });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Generation failed.' });
  }
});

async function startServer() {
  const durable = await hydrateStores();
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT} (${durable ? 'mongodb' : 'local file'} persistence)`);
  });
}

startServer();
