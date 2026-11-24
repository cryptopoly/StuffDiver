const { _electron: electron, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Folder cleanup refuses locations outside home folders when running as root, so root fixtures live under $HOME.
function fixtureParent() { return process.getuid && process.getuid() === 0 ? os.homedir() : os.tmpdir(); }

// Build a small fixture tree with known sizes.
function makeFixture() {
  const root = fs.mkdtempSync(path.join(fixtureParent(), 'sd-fixture-'));
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

// Run the headless CLI (`electron . --scan ...`) and return { status, stdout, stderr }.
function runCli(args, extraEnv = {}) {
  const r = spawnSync(require('electron'), [path.join(__dirname, '..'), ...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...args], {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 60000
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Symlinks need Developer Mode/admin on Windows: skip the calling test with a clear reason instead of failing.
// Directory links use junctions on Windows (no privilege needed).
function linkOrSkip(test, target, linkPath, type) {
  try { fs.symlinkSync(target, linkPath, process.platform === 'win32' && type === 'dir' ? 'junction' : type); }
  catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') test.skip(true, 'creating links needs Developer Mode or admin on this Windows account');
    throw e;
  }
}

module.exports = { linkOrSkip, fixtureParent, makeFixture, launch, scanViaUi, runCli };
