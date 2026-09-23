import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const KITS_FILE = path.join(DATA_DIR, 'kits.json');

let client;
let database;
let mongoUnavailable = false;

async function getMongoDatabase() {
  if (!process.env.MONGODB_URI || mongoUnavailable) return null;
  if (!database) {
    try {
      client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      database = client.db(process.env.MONGODB_DB || 'interview_prep');
    } catch (error) {
      mongoUnavailable = true;
      console.warn(`MongoDB unavailable; using local persistence fallback: ${error.message}`);
      await client?.close().catch(() => {});
      client = undefined;
      database = undefined;
    }
  }
  return database;
}

async function readJson(filePath, fallback) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    await fs.writeFile(filePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

export async function loadStores() {
  const db = await getMongoDatabase();
  if (db) {
    try {
      const users = Object.fromEntries((await db.collection('users').find({}).toArray()).map(({ _id, ...user }) => [_id, user]));
      const kits = Object.fromEntries((await db.collection('kits').find({}).toArray()).map(({ _id, ...entry }) => [_id, entry.items]));
      return { users: new Map(Object.entries(users)), kitsByUser: new Map(Object.entries(kits)), durable: true };
    } catch (error) {
      mongoUnavailable = true;
      console.warn(`MongoDB read failed; using local persistence fallback: ${error.message}`);
    }
  }

  return {
    users: new Map(Object.entries(await readJson(USERS_FILE, {}))),
    kitsByUser: new Map(Object.entries(await readJson(KITS_FILE, {}))),
    durable: false,
  };
}

export async function saveUsers(users) {
  const entries = [...users.entries()];
  const db = await getMongoDatabase();
  if (db) {
    const collection = db.collection('users');
    await collection.deleteMany({});
    if (entries.length) await collection.insertMany(entries.map(([id, user]) => ({ _id: id, ...user })));
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USERS_FILE, JSON.stringify(Object.fromEntries(entries), null, 2));
}

export async function saveKits(kitsByUser) {
  const entries = [...kitsByUser.entries()];
  const db = await getMongoDatabase();
  if (db) {
    const collection = db.collection('kits');
    await collection.deleteMany({});
    if (entries.length) await collection.insertMany(entries.map(([id, items]) => ({ _id: id, items })));
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(KITS_FILE, JSON.stringify(Object.fromEntries(entries), null, 2));
}
