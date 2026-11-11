const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron, expect } = require('@playwright/test');

(async () => {
  const { createServer } = await import('vite');
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-dev-smoke-'));
  const server = await createServer({ configFile: path.join(root, 'vite.config.mjs') });
  let app;
  try {
    await server.listen();
    app = await electron.launch({ args: [root, '--dev'], env: { ...process.env, PRESENCE_TEST: '1', PRESENCE_DATA_DIR: dataDir } });
    const page = await app.firstWindow();
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 30000 });
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Classroom at a glance' })).toBeVisible({ timeout: 10000 });
    console.log('Development server, React interface, desktop login, and dashboard passed.');
  } finally {
    if (app) await app.close();
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
