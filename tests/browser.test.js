import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const frontendPort = 3310;
const backendPort = 3311;
let backend;
let frontend;

async function waitFor(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test.before(async () => {
  const sharedEnv = { ...process.env, NODE_ENV: 'test', SESSION_SECRET: 'browser-test-secret', GEMINI_API_KEY: '', FRONTEND_ORIGIN: `http://localhost:${frontendPort}` };
  backend = spawn(process.execPath, ['backend/server.js'], { cwd: process.cwd(), env: { ...sharedEnv, PORT: String(backendPort) }, stdio: 'ignore' });
  frontend = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', String(frontendPort)], { cwd: process.cwd(), env: { ...sharedEnv, NEXT_PUBLIC_API_URL: `http://localhost:${backendPort}` }, stdio: 'ignore' });
  await waitFor(`http://localhost:${backendPort}/api/health`);
  await waitFor(`http://localhost:${frontendPort}/`);
});

test.after(() => {
  backend?.kill();
  frontend?.kill();
});

test('browser workflow logs in and creates a kit', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const responses = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/')) responses.push(`${response.status()} ${response.url()}`);
  });
  try {
    await page.goto(`http://localhost:${frontendPort}/`, { waitUntil: 'domcontentloaded' });
    await assert.doesNotReject(() => page.getByRole('heading', { name: 'Access your prep kit' }).waitFor());
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Continue' }).click();
    try {
      await page.getByRole('heading', { name: 'Turn the role into your advantage.' }).waitFor();
    } catch (error) {
      throw new Error(`${error.message}\nAPI responses: ${responses.join(' | ')}\nBrowser body after login: ${(await page.locator('body').innerText()).slice(0, 600)}`);
    }
    await page.getByRole('button', { name: 'Generate kit' }).click();
    await page.getByRole('heading', { name: 'Question bank' }).waitFor({ timeout: 60_000 });
    assert.match(await page.locator('body').innerText(), /Company brief/i);
  } finally {
    await browser.close();
  }
});
