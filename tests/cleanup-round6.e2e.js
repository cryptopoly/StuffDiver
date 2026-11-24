// Windows-portability round: sync roots from the environment, package-manager install roots, diagnostics.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const cf = require('../cleanup-folders');
const { launch, scanViaUi, fixtureParent, autoMarkers } = require('./helpers');

const OLD = new Date(Date.now() - 90 * 86400000);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent(), 'sd-r6-')));
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
const proj = (root, rel) => { mk(root, `${rel}/package.json`, '{}'); mk(root, `${rel}/package-lock.json`, '{}'); mk(root, `${rel}/node_modules/dep/index.js`); };
async function withApp(prep, fn) {
  const root = tmp(); prep(root); age(root);
  const { app, page, userData } = await launch(root);
  try { await scanViaUi(page); await fn({ app, page, root, userData }); }
  finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('T3. OneDrive/SharePoint roots from the environment, tenant-named libraries and "- Documents" folders are refused', () => {
  const saved = { a: process.env.OneDriveCommercial, b: process.env.OneDrive, c: process.env.OneDriveConsumer };
  try {
    process.env.OneDriveCommercial = 'C:\\Users\\dan\\Contoso';
    process.env.OneDrive = 'C:\\Users\\dan\\OneDrive - Contoso';
    delete process.env.OneDriveConsumer;
    const o = { win: true, systemDrive: 'C:', home: 'C:\\Users\\dan', tmp: 'C:\\nope', uid: null };
    for (const p of ['C:\\Users\\dan\\Contoso\\Team Site - Documents\\proj\\node_modules', 'C:\\Users\\dan\\Contoso\\anything\\proj\\node_modules', 'C:\\Users\\dan\\SharePoint\\x\\node_modules', 'C:\\Users\\dan\\Fabrikam\\Shared - Documents\\p\\node_modules', 'C:\\Users\\dan\\Fabrikam\\Team - Shared Documents\\p\\node_modules'])
      expect(cf.blockedLocation(p, o), p).toBe(cf.CLOUD_REASON);
    expect(cf.blockedLocation('C:\\Users\\dan\\Contosoish\\proj\\node_modules', o)).toBeNull();   // a different folder with the same prefix is not the root
    expect(cf.cloudSyncedReason('c:/users/dan/contoso/x/a.log')).toBe(cf.CLOUD_REASON);   // loose-file presets use the same test
    expect(cf.cloudSyncedReason('C:\\Users\\dan\\work\\a.log')).toBeNull();
  } finally {
    for (const [k, v] of [['OneDriveCommercial', saved.a], ['OneDrive', saved.b], ['OneDriveConsumer', saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('T3. package-manager and toolchain install roots are refused (scoop, choco, rustup, cargo, nvm, fnm, nodejs, conda, winget)', () => {
  const o = { win: true, systemDrive: 'C:', home: 'C:\\Users\\dan', tmp: 'C:\\nope', uid: null, elevated: false };
  for (const [seg, re] of [['scoop', /scoop/], ['chocolatey', /chocolatey/], ['choco', /choco/], ['.rustup', /\.rustup/], ['.cargo', /\.cargo/], ['.nvm', /\.nvm/], ['fnm_multishells', /fnm_multishells/], ['nodejs', /nodejs/], ['Anaconda3', /anaconda3/i], ['miniconda3', /miniconda3/], ['winget', /winget/]])
    expect(cf.blockedLocation(`C:\\Users\\dan\\${seg}\\apps\\x\\current\\node_modules\\y\\node_modules`, o) , seg).toBeTruthy();
  expect(cf.blockedLocation('C:\\Users\\dan\\scoop\\apps\\nodejs\\current\\lib\\x\\target', o)).toBe('is inside scoop, which holds installed tools');
  expect(cf.blockedLocation('C:\\Users\\dan\\work\\app\\node_modules', o)).toBeNull();
});

test('T3. "could not check for running processes" is only shown when the check could have run', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'p/node_modules'), { recursive: true }); fs.writeFileSync(path.join(root, 'p/package.json'), '{}');
    const dir = path.join(root, 'p/node_modules'); const home = path.join(root, 'none');
    expect(cf.projectSignals(dir, 'node_modules', { home, cwds: null }).warnings).toContain('could not check for running processes');
    expect(cf.projectSignals(dir, 'node_modules', { home, cwds: undefined }).warnings.join(' ')).not.toMatch(/could not check/);
    expect(cf.projectSignals(dir, 'node_modules', { home, cwds: [] }).warnings.join(' ')).not.toMatch(/could not check/);
    if (process.platform === 'win32') expect(cf.runningCwds()).toBeUndefined();
    else expect(cf.runningCwds() === null || Array.isArray(cf.runningCwds())).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T2. mount and cwd checks accept either path separator', () => {
  const dir = path.join('C:\\', 'u', 'proj', 'node_modules').split(path.sep).join('\\');
  expect(cf.mountConflict(['C:\\u\\proj\\node_modules'], ['/', 'C:/u/proj/node_modules/pkg/data'], true)).toBe('contains the mount point C:/u/proj/node_modules/pkg/data');
  expect(cf.mountConflict(['C:/u/proj/node_modules'], ['C:\\u\\proj\\node_modules'], true)).toBe('is itself a mount point (C:\\u\\proj\\node_modules)');
  expect(cf.mountConflict([dir], ['/'], true)).toBeNull();
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'p/node_modules'), { recursive: true }); fs.writeFileSync(path.join(root, 'p/package.json'), '{}');
    const d = path.join(root, 'p/node_modules'); const home = path.join(root, 'none');
    const flip = (v) => v.split(path.sep).join(path.sep === '/' ? '\\' : '/');
    const alt = path.sep === '/' ? d : d.split('\\').join('/');
    expect(cf.projectSignals(d, 'node_modules', { home, cwds: [alt + '/dep'] }).severe).toMatch(/running process is using this folder/);
    expect(cf.projectSignals(d, 'node_modules', { home, cwds: [d.split(path.sep).join('/') + '/dep'] }).severe).toMatch(/running process/);
    void flip;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T4. failures get a best-effort diagnosis (first file that cannot be opened for writing, or a plain-language hint)', async () => {
  test.skip(process.platform === 'win32' || (process.getuid && process.getuid() === 0), 'needs POSIX permission semantics');
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); mk(r, 'b/node_modules/dep/locked.dat'); }, async ({ app, page, root, userData }) => {
    const a = path.join(root, 'a/node_modules'), b = path.join(root, 'b/node_modules');
    const locked = path.join(b, 'dep/locked.dat');
    fs.chmodSync(locked, 0o444);
    // a trash API that fails without any OS code, like Electron's on Windows
    await app.evaluate(() => { global.__e2eTrash = async () => { throw new Error('Operation was aborted'); }; });
    const res = await page.evaluate((x) => window.api.deleteFolders(x, 'test'), [a, b]);
    fs.chmodSync(locked, 0o644);
    expect(res.deleted).toBe(0);
    const byPath = Object.fromEntries(res.failures.map(f => [f.path, f.reason]));
    expect(byPath[b]).toBe(`Operation was aborted (EACCES: ${locked} cannot be opened for writing (in use or no permission))`);
    expect(byPath[a]).toBe('Operation was aborted (a file in the folder is open in another program, or you lack permission)');
    expect(fs.existsSync(locked)).toBe(true);
  });
});

test('T4. a cancelled run says "Cancelled." once in the panel', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, async ({ app, page }) => {
    await app.evaluate(() => { global.__e2eBeforeTrash = () => new Promise(r => setTimeout(r, 1200)); });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('.cleanup-folder-check').nth(0).check();
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-progress')).toContainText('Moving to Trash');
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText('Cancelled.', { timeout: 20000 });
    const t = await page.locator('#cleanup-result').innerText();
    expect(t.match(/Cancelled\./g)).toHaveLength(1);
    expect(t).not.toContain('Nothing was moved. Cancelled');
  });
});

test('T2(a). the last scanned file being cleaned still shows the summary (no "scan a folder first" alert)', async () => {
  await withApp((r) => { mk(r, 'only/.DS_Store'); }, async ({ page }) => {
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('#cleanup-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText(/Moved 1 file|removed 1|failed 1/, { timeout: 15000 });
    expect(dialogs).toEqual([]);
  });
});

test('X1. delete-files refuses cloud-synced files at delete time (all-or-nothing), using the same rule as the scan list', async () => {
  const names = ['Dropbox', 'MEGA', 'Nextcloud', 'ownCloud', 'pCloudDrive', 'Sync', 'Seafile', 'Syncthing', 'Insync', 'Tresorit', 'SpiderOak', 'iDrive', 'Backblaze', 'OneDrive - Corp', 'Google Drive', 'iCloud Drive', 'Box', 'Team Site - Documents'];
  await withApp((r) => { for (const n of names) mk(r, `${n}/x/a.log`); mk(r, 'plain/ok.tmp'); }, async ({ page, root, userData }) => {
    const cloud = names.map(n => path.join(root, n, 'x/a.log'));
    const ok = path.join(root, 'plain/ok.tmp');
    const res = await page.evaluate((x) => window.api.deleteFiles(x, 'test'), [ok, ...cloud]);
    expect(res.deleted).toBe(0);
    expect(res.blocked).toHaveLength(names.length);
    expect(res.blocked.every(b => b.reason === 'in a cloud-synced folder: deleting here deletes it everywhere')).toBe(true);
    expect(res.error).toContain('Nothing was moved');
    for (const f of [ok, ...cloud]) expect(fs.existsSync(f), f).toBe(true);
    const log = fs.readFileSync(path.join(userData, 'deletion-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(log.filter(e => e.status === 'blocked')).toHaveLength(names.length);
    // the scan list never offers them either, and the plain file is deletable on its own
    const cats = await page.evaluate(() => window.api.cleanupScan());
    expect(cats.flatMap(c => c.paths).filter(p => cloud.includes(p))).toEqual([]);
    const solo = await page.evaluate((x) => window.api.deleteFiles(x, 'test'), [ok]);
    expect(solo.error).toBeUndefined();
  });
});

test('X1. the OneDrive environment roots are enforced by delete-files too', async () => {
  const root = tmp(); mk(root, 'Contoso/Docs/b.tmp'); mk(root, 'plain/c.tmp'); age(root);
  const { app, page } = await launch(root, { OneDriveCommercial: path.join(root, 'Contoso') });
  try {
    await scanViaUi(page);
    const res = await page.evaluate((x) => window.api.deleteFiles(x, 'test'), [path.join(root, 'plain/c.tmp'), path.join(root, 'Contoso/Docs/b.tmp')]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toBe('in a cloud-synced folder: deleting here deletes it everywhere');
    expect(fs.existsSync(path.join(root, 'Contoso/Docs/b.tmp'))).toBe(true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
