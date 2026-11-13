const { _electron: electron, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Build a small fixture tree with known sizes.
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fixture-'));
  const w = (rel, bytes, fill = 'a') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, fill));
  };
  w('big/video.mp4', 5 * 1024 * 1024);
  w('big/archive.zip', 3 * 1024 * 1024);
  w('docs/a.txt', 100 * 1024, 'x');
  w('docs/copy-of-a.txt', 100 * 1024, 'x'); // exact duplicate of a.txt
  w('docs/b.txt', 50 * 1024, 'y');
  w('.hidden/cache.bin', 2 * 1024 * 1024); // dot-folder must be counted
  w('node_modules/pkg/index.js', 10 * 1024);
  try { fs.linkSync(path.join(root, 'big/video.mp4'), path.join(root, 'big/video-hardlink.mp4')); } catch (e) { /* no hardlinks */ }
  const expected = (5 + 3 + 2) * 1024 * 1024 + (100 + 100 + 50 + 10) * 1024;
  return { root, expected, fileCount: 7 };
}

async function launch(folder, extraEnv = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-userdata-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: {
      ...process.env,
      STUFFDIVER_E2E: '1',
      STUFFDIVER_USER_DATA: userData,
      STUFFDIVER_E2E_FOLDER: folder || '',
      ...extraEnv
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}

async function scanViaUi(page) {
  await page.locator('#empty-state-btn').click();
  await expect(page.locator('#stats')).toContainText('Files:', { timeout: 30000 });
}

module.exports = { makeFixture, launch, scanViaUi };
