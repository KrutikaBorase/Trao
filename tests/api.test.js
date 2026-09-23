import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

let port;
let server;

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('API did not become healthy in time');
}

test.before(async () => {
  port = 3200 + Math.floor(Math.random() * 500);
  server = spawn(process.execPath, ['backend/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', SESSION_SECRET: 'api-test-secret', GEMINI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupError = '';
  let startupOutput = '';
  server.stdout.on('data', (chunk) => { startupOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { startupError += chunk.toString(); });
  server.on('exit', (code) => {
    if (code && !startupError) startupError = `backend exited with code ${code}`;
  });
  try {
    await waitForHealth();
  } catch (error) {
    throw new Error(`${error.message} on ${port}: ${startupError || startupOutput}`);
  }
});

test.after(() => {
  server?.kill();
});

test('API protects kits and authenticates a user session', async () => {
  const unauthenticated = await fetch(`http://localhost:${port}/api/kits`);
  assert.equal(unauthenticated.status, 401);

  const login = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'password123' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie?.includes('session='));

  const kits = await fetch(`http://localhost:${port}/api/kits`, { headers: { cookie } });
  assert.equal(kits.status, 200);
  assert.ok(Array.isArray((await kits.json()).kits));
});
