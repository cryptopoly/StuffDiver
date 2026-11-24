const { _electron: electron, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Folder cleanup refuses locations outside user folders (and outside home folders when running as root),
// so fixtures must live somewhere a real project could: under the user's profile, never under AppData/Temp.
function fixtureParent() {
  if (process.platform === 'win32') {
    const base = (dir) => { const d = path.join(dir, 'StuffDiverTestFixtures'); fs.mkdirSync(d, { recursive: true }); return d; };
    const home = os.homedir();
    if (!/[\\/]windows[\\/]|systemprofile/i.test(home)) return base(home);
    // Running as SYSTEM: use the first real user profile (not Public/Default).
    const usersDir = path.join(process.env.SystemDrive ? process.env.SystemDrive + '\\' : 'C:\\', 'Users');
    try {
      const u = fs.readdirSync(usersDir, { withFileTypes: true }).find(e => e.isDirectory() && !/^(public|default.*|all users)$/i.test(e.name));
      if (u) return base(path.join(usersDir, u.name));
    } catch (e) { /* fall through */ }
    return os.tmpdir();   // no suitable profile: fixtures will be refused by the product, which the failures will make obvious
  }
  // Linux: the desktop trash refuses tmpfs (/tmp), so fixtures must sit on the user's real disk. macOS trashes from the temp folder fine.
  if (process.platform === 'linux' || (process.getuid && process.getuid() === 0)) { const d = path.join(os.homedir(), 'StuffDiverTestFixtures'); fs.mkdirSync(d, { recursive: true }); return d; }
  return os.tmpdir();
}

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
  const start = async () => {
    const app = await electron.launch({
      args: [path.join(__dirname, '..'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
      timeout: 60000,
      env: {
        ...process.env,
        STUFFDIVER_E2E: '1',
        STUFFDIVER_USER_DATA: userData,
        STUFFDIVER_E2E_FOLDER: folder || '',
        ...extraEnv
      }
    });
    try {
      const page = await Promise.race([app.firstWindow(), new Promise((_, rej) => setTimeout(() => rej(new Error('firstWindow timeout')), 45000))]);
      await page.waitForLoadState('domcontentloaded');
      return { app, page };
    } catch (e) { await app.close().catch(() => {}); throw e; }
  };
  let r;
  try { r = await start(); } catch (e) { r = await start(); }   // one retry: first-window start-up can be slow on busy VMs
  return { app: r.app, page: r.page, userData };
}

async function scanViaUi(page, { dev = true } = {}) {
  await page.locator('#empty-state-btn').click();
  await expect(page.locator('#stats')).toContainText('Files:', { timeout: 30000 });
  if (dev) await page.evaluate(() => window.api.saveSettings({ developerFolderCleanup: true }));
}

// Tool-written markers that real installs/builds leave inside these folders, so fixtures look like the real thing.
function autoMarkers(root, rel) {
  const r = rel.split('\\').join('/');
  const put = (relDir, name) => { const f = path.join(root, relDir, name); if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); } };
  let m = /^(.*?node_modules)\//.exec(r); if (m) put(m[1], '.package-lock.json');
  m = /^(.*?)\/target\//.exec(r); if (m && fs.existsSync(path.join(root, m[1], 'Cargo.toml'))) put(m[1] + '/target', 'CACHEDIR.TAG');
  m = /^(.*?\/\.next)\//.exec(r); if (m) put(m[1], 'BUILD_ID');
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

module.exports = { autoMarkers, linkOrSkip, fixtureParent, makeFixture, launch, scanViaUi, runCli };
