// Regression tests for the fourth review round (L1-L5, R1-R10).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cf = require('../cleanup-folders');
const { launch, scanViaUi, fixtureParent, autoMarkers } = require('./helpers');

const OLD = new Date(Date.now() - 90 * 86400000);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent(), 'sd-r4-')));
function mk(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content === undefined ? 'x'.repeat(2048) : content);
  autoMarkers(root, rel);
  return p;
}
function age(root) {
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(f); try { fs.utimesSync(f, OLD, OLD); } catch (er) { /* ignore */ } } };
  walk(root);
}
const proj = (root, rel, extra = {}) => {
  mk(root, `${rel}/package.json`, extra.pkg || '{}'); mk(root, `${rel}/package-lock.json`, extra.lock || '{}'); mk(root, `${rel}/node_modules/dep/index.js`);
  for (const [k, v] of Object.entries(extra.files || {})) mk(root, `${rel}/${k}`, v);
};
const readLog = (userData) => { try { return fs.readFileSync(path.join(userData, 'deletion-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
async function withApp(prep, fn, { dev = true, env } = {}) {
  const root = tmp(); prep(root); age(root);
  const { app, page, userData } = await launch(root, env);
  try { await scanViaUi(page, { dev }); await fn({ app, page, root, userData }); }
  finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const del = (page, p) => page.evaluate((x) => window.api.deleteFolders(x, 'test'), p);
const cls = (d) => { const c = cf.classifyFolder(d); return c && (c.kind || 'refused:' + c.refused); };
const catPaths = (cats, root) => Object.fromEntries(cats.map(c => [c.id, c.paths.map(p => path.relative(root, p).split(path.sep).join('/')).sort()]));

const CLOUD = 'is a cloud-synced folder: deleting here deletes it everywhere';
test('L1/R8. every known sync client folder is refused (any path component, any case)', () => {
  const o = { uid: 501, home: '/Users/bob', tmp: '/nope' };
  for (const n of ['MEGA', 'MEGAsync', 'Nextcloud', 'ownCloud', 'pCloudDrive', 'pCloud Drive', 'Sync', 'Seafile', 'Syncthing', 'Resilio Sync', 'Insync', 'Tresorit', 'SpiderOak', 'iDrive', 'Backblaze', 'SynologyDrive', 'Creative Cloud Files', 'Yandex.Disk', 'iCloudDrive', 'iCloud Drive', 'Google Drive', 'OneDrive - Corp', 'Dropbox (Personal)'])
    expect(cf.blockedLocation(`/Users/bob/${n}/proj/node_modules`, o), n).toBe(CLOUD);
  expect(cf.blockedLocation('/Users/bob/MEGA/deep/er/proj/node_modules', o)).toBe(CLOUD);
  expect(cf.cloudSyncedReason('C:\\Users\\bob\\Nextcloud\\notes\\a.log')).toBe(CLOUD);
  expect(cf.cloudSyncedReason('/Users/bob/work/a.log')).toBeNull();
});

test('R8. loose-file presets never offer files inside cloud-synced or Trash folders; Trash items cannot be re-trashed', async () => {
  await withApp((r) => {
    mk(r, 'Dropbox/notes/.DS_Store'); mk(r, 'MEGA/x/Thumbs.db'); mk(r, 'OneDrive/a/.DS_Store'); mk(r, 'fine/.DS_Store');
    mk(r, '.Trash/old/.DS_Store'); mk(r, '$Recycle.Bin/S-1/x/Thumbs.db'); mk(r, 'trashed/a.txt');
  }, async ({ page, root }) => {
    const c = catPaths(await page.evaluate(() => window.api.cleanupScan()), root);
    expect(c.dsstore).toEqual(['fine/.DS_Store']);
    expect(c.thumbs).toBeUndefined();
    const res = await page.evaluate((p) => window.api.deleteFiles([p], 'test'), path.join(root, '.Trash/old/.DS_Store'));
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toBe('already in a Trash or Recycle Bin (it cannot be moved to the Trash again)');
    expect(fs.existsSync(path.join(root, '.Trash/old/.DS_Store'))).toBe(true);
  });
});

test('R1/R2/R7/L4. file presets: cache folders only, desktop.ini and models/chat logs/Office lock files never ticked or offered', async () => {
  await withApp((r) => {
    mk(r, 'AppData/Local/pnpm/pnpm.exe'); mk(r, 'AppData/Local/Yarn/bin/yarn.cmd'); mk(r, '.m2/repository/com/x/x.jar');
    mk(r, 'AppData/Local/pnpm/store/v3/files/ab'); mk(r, 'AppData/Local/pip/Cache/http/x'); mk(r, 'AppData/Local/Yarn/Cache/v6/x'); mk(r, '.cargo/registry/cache/x.crate'); mk(r, '.gradle/caches/modules-2/x');
    mk(r, 'docs/Documents/desktop.ini'); mk(r, 'Start Menu/Programs/desktop.ini'); mk(r, 'Users/bob/desktop.ini'); mk(r, 'plain/desktop.ini');
    mk(r, '.cache/huggingface/token'); mk(r, '.cache/huggingface/hub/models/x.bin'); mk(r, '.cache/huggingface/datasets/d'); mk(r, '.cache/lm-studio/models/a.gguf'); mk(r, '.ollama/models/blobs/sha');
    mk(r, 'chat/irclogs/freenode/#x.log'); mk(r, 'docs/~WRL0001.tmp'); mk(r, 'docs/~$report.docx'); mk(r, 'docs/real.tmp');
    mk(r, 'kafka/00000000000000000000.log'); mk(r, 'kafka/0000012.log'); mk(r, 'app/server.log');
    mk(r, 'dumps/MEMORY.DMP');
  }, async ({ page, root }) => {
    const c = catPaths(await page.evaluate(() => window.api.cleanupScan()), root);
    expect(c.pkgcache).toEqual(['.cargo/registry/cache/x.crate', '.gradle/caches/modules-2/x', 'AppData/Local/Yarn/Cache/v6/x', 'AppData/Local/pip/Cache/http/x', 'AppData/Local/pnpm/store/v3/files/ab']);
    expect(c.desktopini).toEqual(['plain/desktop.ini']);
    expect(c.aimodels).toEqual(['.cache/huggingface/datasets/d', '.cache/huggingface/hub/models/x.bin']);
    expect(c.temp).toEqual(['docs/real.tmp']);
    expect(c.logs).toEqual(['app/server.log']);
    expect(c.crash).toBeUndefined();
    const all = Object.values(c).flat();
    for (const bad of ['AppData/Local/pnpm/pnpm.exe', 'AppData/Local/Yarn/bin/yarn.cmd', '.m2/repository/com/x/x.jar', 'docs/Documents/desktop.ini', 'Start Menu/Programs/desktop.ini', 'Users/bob/desktop.ini',
      '.cache/huggingface/token', '.cache/lm-studio/models/a.gguf', '.ollama/models/blobs/sha', 'chat/irclogs/freenode/#x.log', 'docs/~WRL0001.tmp', 'kafka/00000000000000000000.log', 'kafka/0000012.log', 'dumps/MEMORY.DMP'])
      expect(all, bad).not.toContain(bad);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('.cleanup-check').first()).toBeVisible();
    expect(await page.locator('.cleanup-check:checked').count()).toBe(0);   // no .DS_Store / Thumbs.db here, and desktop.ini is never ticked
  });
});

test('R9. a capped category says so in the row; summary labels freed space "up to"', async () => {
  await withApp((r) => { for (let i = 0; i < 5; i++) mk(r, `d${i}/.DS_Store`); }, async ({ app, page }) => {
    await app.evaluate(() => { global.__e2ePathCap = 2; });
    const cats = await page.evaluate(() => window.api.cleanupScan());
    expect(cats[0]).toMatchObject({ id: 'dsstore', count: 5, capped: true, cap: 2 });
    expect(cats[0].paths).toHaveLength(2);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('#cleanup-body')).toContainText('handles only the first 2 found; run it again for the rest');
    await page.locator('#cleanup-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText(/Moved 2 files to the Trash|failed 2/, { timeout: 15000 });
  });
});

// ---- R3: markers inside, VCS, documents, Xcode ----
test.describe('R3 markers inside the folder', () => {
  let root;
  test.beforeEach(() => { root = tmp(); });
  test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  test('node_modules needs an install marker written by the package manager', () => {
    for (const marker of ['.package-lock.json', '.modules.yaml', '.yarn-integrity']) {
      fs.mkdirSync(path.join(root, marker, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(root, marker, 'package.json'), '{}'); fs.writeFileSync(path.join(root, marker, 'yarn.lock'), '');
      fs.writeFileSync(path.join(root, marker, 'node_modules', marker), '');
      expect(cls(path.join(root, marker, 'node_modules')), marker).toBe('node_modules');
    }
    fs.mkdirSync(path.join(root, 'bare/node_modules/dep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bare/package.json'), '{}'); fs.writeFileSync(path.join(root, 'bare/yarn.lock'), '');
    expect(cls(path.join(root, 'bare/node_modules'))).toBe('refused:has no package-manager install marker (.package-lock.json, .modules.yaml or .yarn-integrity)');
  });
  test('cargo target needs CACHEDIR.TAG, maven target needs build output, .next needs BUILD_ID', () => {
    fs.mkdirSync(path.join(root, 'c/target/debug'), { recursive: true }); fs.writeFileSync(path.join(root, 'c/Cargo.toml'), '');
    expect(cls(path.join(root, 'c/target'))).toBe('refused:has no CACHEDIR.TAG written by cargo');
    fs.writeFileSync(path.join(root, 'c/target/CACHEDIR.TAG'), ''); expect(cls(path.join(root, 'c/target'))).toBe('target');
    fs.mkdirSync(path.join(root, 'm/target/stuff'), { recursive: true }); fs.writeFileSync(path.join(root, 'm/pom.xml'), '');
    expect(cls(path.join(root, 'm/target'))).toBe('refused:has no Maven build output folders');
    fs.mkdirSync(path.join(root, 'm/target/classes')); expect(cls(path.join(root, 'm/target'))).toBe('target');
    fs.mkdirSync(path.join(root, 'n/.next'), { recursive: true }); fs.writeFileSync(path.join(root, 'n/next.config.js'), '');
    expect(cls(path.join(root, 'n/.next'))).toMatch(/^refused:has no BUILD_ID/);
    fs.writeFileSync(path.join(root, 'n/.next/BUILD_ID'), 'x'); expect(cls(path.join(root, 'n/.next'))).toBe('next');
  });
  test('DerivedData only at Library/Developer/Xcode/DerivedData, never with archives', async () => {
    const good = path.join(root, 'Library/Developer/Xcode/DerivedData');
    fs.mkdirSync(path.join(good, 'App-1/Build'), { recursive: true });
    expect(cls(good)).toBe('derived_data');
    fs.mkdirSync(path.join(root, 'Library/Developer/Other/DerivedData'), { recursive: true });
    expect(cls(path.join(root, 'Library/Developer/Other/DerivedData'))).toBeNull();
    const kind = cf.classifyFolder(good);
    expect((await cf.inspectFolder(good, fs, false, null, kind)).forbidden).toBeNull();
    fs.mkdirSync(path.join(good, 'App-1/Build/Release.xcarchive'), { recursive: true });
    expect((await cf.inspectFolder(good, fs, false, null, kind)).forbidden).toContain('Release.xcarchive');
    fs.rmSync(path.join(good, 'App-1/Build/Release.xcarchive'), { recursive: true });
    fs.mkdirSync(path.join(good, 'Archives'));
    expect((await cf.inspectFolder(good, fs, false, null, kind)).forbidden).toContain('Archives');
  });
  test('version-control folders are found case-insensitively (.GIT .hg .jj .svn .bzr .fossil)', async () => {
    for (const v of ['.GIT', '.Git', '.hg', '.jj', '.svn', '.bzr', '.fossil']) {
      const d = path.join(root, 'v' + v); fs.mkdirSync(path.join(d, 'pkg', v), { recursive: true });
      expect((await cf.inspectFolder(d)).git, v).toContain(v);
    }
    mk(root, 'p/package.json', '{}'); mk(root, 'p/yarn.lock', ''); mk(root, 'p/node_modules/x/.GIT/HEAD'); mk(root, 'p/node_modules/x/i.js');
    const dir = path.join(root, 'p/node_modules');
    const files = [{ path: path.join(dir, 'x/.GIT/HEAD'), name: 'HEAD', size: 1, mtime: 1 }];
    expect(cf.findCandidates(files, root, false, fs, ['/'], [])[0].hasGit).toBe(true);
  });
  test('user documents inside target/.next/__pycache__/DerivedData refuse the folder', async () => {
    mk(root, 'c/Cargo.toml', ''); mk(root, 'c/target/debug/x.o'); mk(root, 'c/target/thesis.docx');
    const t = path.join(root, 'c/target'); const kind = cf.classifyFolder(t);
    expect(kind.kind).toBe('target');
    expect((await cf.inspectFolder(t, fs, false, null, kind)).userDoc).toBe(path.join(t, 'thesis.docx'));
    mk(root, 'n/next.config.js', ''); mk(root, 'n/.next/BUILD_ID', 'x'); mk(root, 'n/.next/my-drafts/post.md');
    const nx = path.join(root, 'n/.next');
    expect((await cf.inspectFolder(nx, fs, false, null, cf.classifyFolder(nx))).userDoc).toContain('post.md');
    const files = [{ path: path.join(t, 'thesis.docx'), name: 'thesis.docx', size: 1, mtime: 1 }, { path: path.join(t, 'debug/x.o'), name: 'x.o', size: 1, mtime: 1 }];
    expect(cf.findCandidates(files, root, false, fs, ['/'], [])[0].userDoc).toBe(path.join(t, 'thesis.docx'));
  });
});

test('R3 (app): document inside target is shown as refused with its exact reason, and delete refuses it too', async () => {
  await withApp((r) => { mk(r, 'c/Cargo.toml', ''); mk(r, 'c/target/debug/x.o'); mk(r, 'c/target/thesis.docx'); proj(r, 'ok'); }, async ({ page, root }) => {
    const t = path.join(root, 'c/target');
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(scan.candidates.find(c => c.path === t).refused).toBe(`contains ${path.join(t, 'thesis.docx')}, a document that does not belong in Build output (target)`);
    const res = await del(page, [t]);
    expect(res.blocked[0].reason).toBe(`contains ${path.join(t, 'thesis.docx')}, a document that does not belong in Build output (target)`);
    expect(fs.existsSync(path.join(t, 'thesis.docx'))).toBe(true);
  });
});

// ---- R5: could this break something / is it in use ----
test.describe('R5 project signals', () => {
  let root;
  test.beforeEach(() => { root = tmp(); });
  test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const sev = (rel, o = {}) => cf.projectSignals(path.join(root, rel, 'node_modules'), 'node_modules', { home: path.join(root, 'nohome'), ...o });
  const mkp = (rel, files = {}, pkg = '{"name":"x"}') => { fs.mkdirSync(path.join(root, rel, 'node_modules'), { recursive: true }); fs.writeFileSync(path.join(root, rel, 'package.json'), pkg); for (const [k, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel, k)), { recursive: true }); fs.writeFileSync(path.join(root, rel, k), v); } };
  test('lockfile registries and non-registry dependencies', () => {
    mkp('ok', { 'package-lock.json': '{"packages":{"a":{"resolved":"https://registry.npmjs.org/a/-/a-1.tgz"}}}' });
    expect(sev('ok').severe).toBeNull();
    mkp('priv', { 'package-lock.json': '{"packages":{"a":{"resolved":"https://npm.corp.example/a/-/a-1.tgz"}}}' });
    expect(sev('priv').severe).toBe('lockfile has packages from a registry other than npmjs.org (npm.corp.example)');
    mkp('gitdep', { 'package-lock.json': '{"packages":{"a":{"resolved":"git+ssh://git@github.com/x/a.git#abc"}}}' });
    expect(sev('gitdep').severe).toMatch(/^lockfile has a git\+ssh dependency/);
    mkp('yarn', { 'yarn.lock': 'a@1:\n  resolved "https://registry.yarnpkg.com/a/-/a-1.tgz#abc"\n' });
    expect(sev('yarn').severe).toBeNull();
    mkp('pnpm', { 'pnpm-lock.yaml': "packages:\n  a@1:\n    resolution: {tarball: https://mirror.example/a.tgz}\n" });
    expect(sev('pnpm').severe).toMatch(/other than npmjs\.org \(mirror\.example\)/);
    mkp('filedep', {}, '{"dependencies":{"local":"file:../local"}}');
    expect(sev('filedep').severe).toBe('package.json has a local, git or workspace dependency (file:../local) that may not be reinstallable');
    mkp('ws-member', {}, '{"dependencies":{"sib":"workspace:*"}}');
    expect(sev('ws-member').severe).toMatch(/workspace:\*/);
    mkp('ws-root', {}, '{"workspaces":["packages/*"],"dependencies":{"sib":"workspace:*"}}');
    expect(sev('ws-root').severe).toBeNull();   // a workspace root is fine
  });
  test('custom registry, patches, service configs', () => {
    mkp('rc', { '.npmrc': '@corp:registry=https://npm.corp.example/\n' });
    expect(sev('rc').severe).toBe('.npmrc points to a custom registry (https://npm.corp.example/)');
    mkp('rc-ok', { '.npmrc': 'registry=https://registry.npmjs.org/\n' }); expect(sev('rc-ok').severe).toBeNull();
    fs.mkdirSync(path.join(root, 'nohome'), { recursive: true }); fs.writeFileSync(path.join(root, 'nohome/.npmrc'), 'registry=https://home.example/\n');
    mkp('rc-home'); expect(sev('rc-home').severe).toMatch(/custom registry \(https:\/\/home\.example\/\)/);
    fs.rmSync(path.join(root, 'nohome'), { recursive: true });
    mkp('pat', { 'patches/a.patch': 'x' }); expect(sev('pat').severe).toBe('the project has a patches/ folder (patched dependencies)');
    mkp('pat2', {}, '{"pnpm":{"patchedDependencies":{"a@1":"p"}}}'); expect(sev('pat2').severe).toBe('the project patches its dependencies (patchedDependencies)');
    mkp('pm2', { 'ecosystem.config.js': 'module.exports={}' }); expect(sev('pm2').severe).toBe('ecosystem.config.js suggests this project is managed by pm2 / a service');
    mkp('dc', { 'docker-compose.yml': 'volumes:\n  - ./node_modules:/app/node_modules' }); expect(sev('dc').severe).toBe('docker-compose.yml mounts node_modules into a container');
    mkp('dcw', { 'docker-compose.yml': 'services: {}', 'Dockerfile': 'FROM node' }); const w = sev('dcw');
    expect(w.severe).toBeNull(); expect(w.warnings.join(' ')).toMatch(/Dockerfile|containers may depend/);
    mkp('svc', { 'app.service': '[Service]\nWorkingDirectory=' + path.join(root, 'svc') }); expect(sev('svc').severe).toBe('app.service (a service unit) refers to this folder');
  });
  test('running processes and recently edited projects', () => {
    mkp('run');
    const dir = path.join(root, 'run/node_modules');
    expect(sev('run', { cwds: ['/elsewhere'] }).severe).toBeNull();
    expect(sev('run', { cwds: [path.join(dir, 'dep/bin')] }).severe).toBe(`a running process is using this folder (working directory ${path.join(dir, 'dep/bin')})`);
    expect(sev('run', { cwds: [dir] }).severe).toMatch(/running process/);
    expect(sev('run', { cwds: null }).warnings).toContain('could not check for running processes');
    expect(sev('run').warnings.join(' ')).toMatch(/project files were modified today/);   // fresh fixture
    const old = new Date(Date.now() - 90 * 86400000);
    for (const f of ['package.json', 'node_modules']) fs.utimesSync(path.join(root, 'run', f), old, old);
    fs.utimesSync(path.join(root, 'run'), old, old);
    expect(sev('run').warnings.join(' ')).not.toMatch(/project files/);
  });
});

test('R5 (app): a running process inside the folder greys the row out, and delete refuses it', async () => {
  await withApp((r) => { proj(r, 'busy'); proj(r, 'idle'); }, async ({ app, page, root }) => {
    const busy = path.join(root, 'busy/node_modules');
    await app.evaluate((_e, c) => { global.__e2eCwds = () => [c + '/dep']; }, busy);
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(scan.candidates.find(c => c.path === busy).refused).toBe(`a running process is using this folder (working directory ${busy}/dep)`);
    expect(scan.candidates.find(c => c.relPath === 'idle/node_modules').refused).toBeNull();
    const res = await del(page, [busy]);
    expect(res.blocked[0].reason).toBe(`a running process is using this folder (working directory ${busy}/dep)`);
  });
});

// ---- R6 ----
test('R6. elevated Windows runs are limited to the current profile; packaged-app layouts are refused', () => {
  const o = { win: true, systemDrive: 'C:', home: 'C:\\Users\\bob', tmp: 'C:\\Users\\bob\\AppData\\Local\\Temp', uid: null, elevated: true };
  expect(cf.blockedLocation('C:\\Users\\alice\\p\\node_modules', o)).toBe('is outside your user profile and this app is running elevated (Administrator)');
  expect(cf.blockedLocation('D:\\proj\\node_modules', o)).toBe('is outside your user profile and this app is running elevated (Administrator)');
  expect(cf.blockedLocation('C:\\Users\\bob\\work\\p\\node_modules', o)).toBeNull();
  expect(cf.blockedLocation('D:\\proj\\node_modules', { ...o, elevated: false })).toBeNull();
  expect(cf.blockedLocation('C:\\inetpub\\wwwroot\\site\\node_modules', { ...o, elevated: false })).toBe('is outside your user folders');
  expect(cf.blockedLocation('C:\\tools\\app\\node_modules', { ...o, elevated: false })).toBe('is outside your user folders');
  for (const p of ['/Users/bob/work/Foo/resources/app/node_modules', 'D:\\portable\\App\\resources\\app.asar.unpacked\\node_modules'])
    expect(cf.blockedLocation(p, { uid: 501, home: '/Users/bob', win: false }), p).toBe('is inside a packaged application (resources/app)');
  cf.setElevated(true);
  expect(cf.blockedLocation('C:\\Users\\alice\\p\\node_modules', { ...o, elevated: undefined })).toMatch(/running elevated/);
  cf.setElevated(false);
});

// ---- R10: off by default ----
test('R10. developer folder cleanup is OFF by default, switchable in the wizard, and persisted', async () => {
  await withApp((r) => { proj(r, 'p'); mk(r, 'x/.DS_Store'); }, async ({ page, root, userData }) => {
    expect((await page.evaluate(() => window.api.loadSettings())).developerFolderCleanup).toBeUndefined();
    const off = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(off).toMatchObject({ disabled: true, candidates: [] });
    const refused = await del(page, [path.join(root, 'p/node_modules')]);
    expect(refused.error).toBe('Refused: developer folder cleanup is switched off. Nothing was moved.');
    expect(fs.existsSync(path.join(root, 'p/node_modules'))).toBe(true);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('#cleanup-body')).toContainText('Developer folders (advanced)');
    await expect(page.locator('#cleanup-body')).toContainText('switched off');
    await expect(page.locator('#cleanup-dev-toggle')).not.toBeChecked();
    await expect(page.locator('.cleanup-folder')).toHaveCount(0);
    await expect(page.locator('#cleanup-body')).toContainText('.DS_Store files');   // loose-file presets still work
    await page.locator('#cleanup-dev-toggle').check();
    await expect(page.locator('.cleanup-folder')).toHaveCount(1);
    await expect(page.locator('#cleanup-dev-toggle')).toBeChecked();
    expect((await page.evaluate(() => window.api.loadSettings())).developerFolderCleanup).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).developerFolderCleanup).toBe(true);
    await page.locator('#cleanup-dev-toggle').uncheck();
    await expect(page.locator('.cleanup-folder')).toHaveCount(0);
    expect((await page.evaluate(() => window.api.loadSettings())).developerFolderCleanup).toBe(false);
  }, { dev: false });
});

// ---- L2 / L5 / R4 / L3 ----
test('L2/L5. cancelling logs every unmoved item as skipped, and is shown inline (no alert dialog)', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); proj(r, 'c'); }, async ({ app, page, root, userData }) => {
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await app.evaluate(() => { global.__e2eBeforeTrash = () => new Promise(r => setTimeout(r, 1500)); });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    for (let i = 0; i < 3; i++) await page.locator('.cleanup-folder-check').nth(i).check();
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-folders-execute')).toHaveText('Cancel');
    await expect(page.locator('#cleanup-progress')).toContainText('Moving to Trash');
    await page.locator('#cleanup-folders-execute').click();   // Cancel
    await expect(page.locator('#cleanup-result')).toContainText(/Cancelled\. Moved 0 folders to the Trash, failed 0, skipped 3/, { timeout: 20000 });
    await expect(page.locator('#cleanup-result')).toContainText('Failed and skipped items were not changed');
    expect(dialogs).toEqual([]);
    const log = readLog(userData).filter(e => e.type === 'folder');
    expect(log.map(e => e.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(log.every(e => e.reason === 'cancelled before it was moved')).toBe(true);
    for (const n of ['a', 'b', 'c']) expect(fs.existsSync(path.join(root, n, 'node_modules/dep/index.js'))).toBe(true);
    // the viewer can filter them
    await page.locator('#cleanup-close').click();
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="dellog"]').click();
    await page.locator('#dellog-status').selectOption('skipped');
    await expect(page.locator('.dellog-row')).toHaveCount(3);
    await expect(page.locator('.dellog-badge.dellog-skipped').first()).toBeVisible();
  });
});

test('L2. a cancel that lands before the pre-move re-check is logged as skipped, never as "blocked"', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, async ({ app, page, root, userData }) => {
    await app.evaluate(() => { global.__e2eBeforeTrash = () => new Promise(r => setTimeout(r, 1200)); });
    const p = page.evaluate((x) => window.api.deleteFolders(x, 'test'), [path.join(root, 'a/node_modules'), path.join(root, 'b/node_modules')]);
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => window.api.cancelFolderDelete());
    const res = await p;
    expect(res.cancelled).toBe(true);
    expect(res.failures.map(f => f.state)).toEqual(['skipped', 'skipped']);
    const log = readLog(userData);
    expect(log.some(e => e.status === 'blocked')).toBe(false);
    expect(log.filter(e => e.status === 'skipped')).toHaveLength(2);
  });
});

test('L2. cancelling during verification logs every requested folder as skipped', async () => {
  await withApp((r) => { for (let i = 0; i < 6; i++) proj(r, 'p' + i); }, async ({ app, page, root, userData }) => {
    // slow the verify phase so the cancel lands inside it
    await app.evaluate(() => { global.__e2eCwds = () => { const t = Date.now(); while (Date.now() - t < 150) { /* busy wait */ } return []; }; });
    const paths = [0, 1, 2, 3, 4, 5].map(i => path.join(root, 'p' + i, 'node_modules'));
    const p = page.evaluate((x) => window.api.deleteFolders(x, 'test'), paths);
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => window.api.cancelFolderDelete());
    const res = await p;
    expect(res).toMatchObject({ cancelled: true, deleted: 0, skipped: 6 });
    const log = readLog(userData);
    expect(log.map(e => e.status)).toEqual(Array(6).fill('skipped'));
    expect(log[0].reason).toBe('cancelled before anything was moved');
  });
});

test('L3/R4. rows label on-disk size vs scan count; the dialog/log use logical size; failures list the OS reason and final state', async () => {
  test.skip(process.platform === 'win32' || (process.getuid && process.getuid() === 0), 'needs POSIX permission semantics');
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, async ({ app, page, root, userData }) => {
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('.cleanup-folder').first()).toContainText(/files in the scan · .* on disk/);
    await expect(page.locator('.cleanup-total-label').first()).toContainText('size on disk');
    const b = path.join(root, 'b/node_modules');
    await app.evaluate((_e, a) => { global.__e2eBeforeTrash = (p) => { if (p === a.b) global.__e2eRequire('fs').chmodSync(a.parent, 0o555); }; }, { b, parent: path.join(root, 'b') });
    await page.locator('.cleanup-folder-check').nth(0).check();
    await page.locator('.cleanup-folder-check').nth(1).check();
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText('failed 1', { timeout: 15000 });
    fs.chmodSync(path.join(root, 'b'), 0o755);
    const txt = await page.locator('#cleanup-result').innerText();
    expect(txt).toMatch(/Moved 1 folder to the Trash \(up to /);
    expect(txt).toContain('failed: ' + b);
    expect(txt).toContain('Failed and skipped items were not changed');
    const e = readLog(userData).find(x => x.path === b);
    expect(e).toMatchObject({ status: 'failed', finalState: 'untouched' });
    expect(e.size).toBeGreaterThan(0);
    // the log viewer shows the final state
    await page.locator('#cleanup-close').click();
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="dellog"]').click();
    await expect(page.locator('.dellog-row', { hasText: b })).toContainText('final state: untouched');
  });
});

test('R4. a clean file run reports "Moved N files" inline', async () => {
  await withApp((r) => { mk(r, 'q/.DS_Store'); mk(r, 'w/.DS_Store'); }, async ({ page }) => {
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('.cleanup-check:checked')).toHaveCount(1);
    await page.locator('#cleanup-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText(/Moved 2 files to the Trash|failed 2/, { timeout: 15000 });
    expect(dialogs).toEqual([]);
  });
});
