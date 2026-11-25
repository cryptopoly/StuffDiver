// Quarantine with one-click undo for developer-folder cleanup.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const q = require('../quarantine');
const { requireUsableFixtures, launch, scanViaUi, fixtureParent, autoMarkers } = require('./helpers');

const OLD = new Date(Date.now() - 90 * 86400000);
const WIN = process.platform === 'win32';
const tmp = () => { requireUsableFixtures(test); return fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent(), 'sd-q-'))); };
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
const proj = (root, rel) => { mk(root, `${rel}/package.json`, '{}'); mk(root, `${rel}/package-lock.json`, '{}'); mk(root, `${rel}/node_modules/dep/index.js`, 'module.exports = ' + JSON.stringify(rel) + ';'); };
const readLog = (userData) => { try { return fs.readFileSync(path.join(userData, 'deletion-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
const runDirs = (qhome) => { const r = path.join(qhome, q.QDIR); try { return fs.readdirSync(r).filter(n => q.RUN_RE.test(n)).map(n => path.join(r, n)); } catch (e) { return []; } };
const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const del = (page, p) => page.evaluate((x) => window.api.deleteFolders(x, 'test'), p);
const list = (page) => page.evaluate(() => window.api.listQuarantine());
const restore = (page, run, opts) => page.evaluate(([r, o]) => window.api.restoreQuarantine(r, o), [run, opts || {}]);
// A trash stand-in that really moves the item aside (the desktop trash is unavailable on CI).
const FAKE_TRASH = async (app, dir) => app.evaluate((_e, d) => { const fsx = global.__e2eRequire('fs'); fsx.mkdirSync(d, { recursive: true }); let n = 0; global.__e2eTrash = async (p) => { fsx.renameSync(p, d + '/' + (++n) + '-' + p.split(/[\\/]/).pop()); }; }, dir);

async function withApp(prep, fn, { env = {}, dev = true } = {}) {
  const root = tmp();
  prep(root); age(root);
  const { app, page, userData, qhome } = await launch(root, { SD_TEST_QUARANTINE: '1', ...env });
  const trashDir = path.join(root + '-trash');
  try { await scanViaUi(page, { dev }); await fn({ app, page, root, userData, qhome, trashDir }); }
  finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(trashDir, { recursive: true, force: true }); if (qhome) fs.rmSync(qhome, { recursive: true, force: true }); }
}
const two = (r) => { proj(r, 'a'); proj(r, 'b'); };

// ---------- unit tests with stubs (no Electron; Windows rules included) ----------
function fakeFs(map) { // map: path -> { dev, dir, link, uid }
  const get = (p) => { const m = map[p]; if (!m) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { dev: BigInt(m.dev), uid: m.uid == null ? 501 : m.uid, isSymbolicLink: () => !!m.link, isDirectory: () => m.dir !== false }; };
  return { lstatSync: get, statSync: get, realpathSync: (p) => p };
}
test.describe('unit: where the quarantine goes', () => {
  const none = () => null;
  test('quarantine paths are recognised on every platform spelling', () => {
    for (const p of ['/Users/a/.StuffDiverQuarantine/2025-01-01_000000_ab12cd34/1/node_modules', 'C:\\Users\\a\\.StuffDiverQuarantine\\x', 'D:\\.stuffdiverquarantine', '/mnt/d/.StuffDiverQuarantine']) expect(q.isQuarantinePath(p), p).toBe(true);
    for (const p of ['/Users/a/proj/node_modules', 'C:\\Users\\a\\.StuffDiver', '/x/StuffDiverQuarantine']) expect(q.isQuarantinePath(p), p).toBe(false);
  });
  test('Windows: system drive uses the profile, other drives use their own top folder, UNC is refused', () => {
    const fsx = fakeFs({ 'C:\\Users\\bob\\proj\\node_modules': { dev: 1 }, 'C:\\Users\\bob': { dev: 1 }, 'C:\\Users\\bob\\.StuffDiverQuarantine': { dev: 1 }, 'D:\\work\\node_modules': { dev: 2 }, 'D:\\': { dev: 2 } });
    const ctx = { platform: 'win32', home: 'C:\\Users\\bob', fsx, rootOk: none, mounts: () => [] };
    expect(q.chooseRoot('C:\\Users\\bob\\proj\\node_modules', ctx).root).toBe('C:\\Users\\bob\\.StuffDiverQuarantine');
    expect(q.chooseRoot('D:\\work\\node_modules', ctx).root).toBe('D:\\.StuffDiverQuarantine');
    expect(q.chooseRoot('\\\\server\\share\\x\\node_modules', { ...ctx, fsx: fakeFs({ '\\\\server\\share\\x\\node_modules': { dev: 3 } }) }).error).toMatch(/drive letter/);
  });
  test('Windows: a drive that differs in case still counts as the system drive; a cloud-synced or protected root is refused', () => {
    const fsx = fakeFs({ 'c:\\Users\\bob\\p\\node_modules': { dev: 1 }, 'C:\\Users\\bob': { dev: 1 } });
    const ctx = { platform: 'win32', home: 'C:\\Users\\bob', fsx, rootOk: none, mounts: () => [] };
    expect(q.chooseRoot('c:\\Users\\bob\\p\\node_modules', ctx).root).toBe('C:\\Users\\bob\\.StuffDiverQuarantine');
    const refused = q.chooseRoot('c:\\Users\\bob\\p\\node_modules', { ...ctx, rootOk: () => 'is cloud-synced' });
    expect(refused.error).toMatch(/no safe location.*cloud-synced/);
  });
  test('Windows: same drive letter but a different volume (mounted folder) is refused, not renamed across', () => {
    const fsx = fakeFs({ 'C:\\mnt\\vol\\node_modules': { dev: 9 }, 'C:\\Users\\bob': { dev: 1 } });
    expect(q.chooseRoot('C:\\mnt\\vol\\node_modules', { platform: 'win32', home: 'C:\\Users\\bob', fsx, rootOk: none, mounts: () => [] }).error).toMatch(/different volume/);
  });
  test('POSIX: home first, else the volume top from the mount table, never "/" and never a foreign-owned root', () => {
    const fsx = fakeFs({ '/Volumes/X/p/node_modules': { dev: 7 }, '/Volumes/X': { dev: 7 }, '/Users/a': { dev: 1 } });
    const ctx = { platform: 'darwin', home: '/Users/a', fsx, rootOk: none, uid: 501, mounts: () => ['/', '/Volumes/X'] };
    expect(q.chooseRoot('/Volumes/X/p/node_modules', ctx).root).toBe('/Volumes/X/.StuffDiverQuarantine');
    expect(q.chooseRoot('/Volumes/X/p/node_modules', { ...ctx, mounts: () => ['/'] }).error).toMatch(/different volume/);
    const owned = fakeFs({ '/Volumes/X/p/node_modules': { dev: 7 }, '/Volumes/X/.StuffDiverQuarantine': { dev: 7, uid: 0 }, '/Users/a': { dev: 1 } });
    expect(q.chooseRoot('/Volumes/X/p/node_modules', { ...ctx, fsx: owned }).error).toMatch(/belongs to another user/);
    const link = fakeFs({ '/Volumes/X/p/node_modules': { dev: 7 }, '/Volumes/X/.StuffDiverQuarantine': { dev: 7, link: true }, '/Users/a': { dev: 1 } });
    expect(q.chooseRoot('/Volumes/X/p/node_modules', { ...ctx, fsx: link }).error).toMatch(/not a plain folder/);
  });
  test('the volume probe uses the nearest existing ancestor when the root does not exist yet', () => {
    const fsx = fakeFs({ '/home/a/p/node_modules': { dev: 4 }, '/home/a': { dev: 4 } });
    expect(q.chooseRoot('/home/a/p/node_modules', { platform: 'linux', home: '/home/a', fsx, rootOk: none, uid: 501, mounts: () => ['/'] }).root).toBe('/home/a/.StuffDiverQuarantine');
  });
});

test.describe('unit: manifests are never trusted blindly', () => {
  test('a tampered manifest cannot redirect the quarantine path, and a mismatched run id is rejected', () => {
    const root = tmp();
    try {
      const ctx = { platform: process.platform, fsx: fs, home: root };
      const plan = { root: path.join(root, q.QDIR), runId: 'ab12cd34', t: Date.now(), appVersion: '0', scanRoot: root, items: [{ originalPath: path.join(root, 'p', 'node_modules'), dev: 1, size: 5, files: 1, category: 'node_modules' }] };
      const m = q.createRun(plan, ctx);
      expect(m.items[0].status).toBe('planned');
      const evil = JSON.parse(fs.readFileSync(path.join(m.runDir, 'manifest.json'), 'utf8'));
      evil.items[0].quarantinePath = path.join(root, 'somewhere-else');
      evil.items.push({ n: 2, name: '..', originalPath: path.join(root, '..'), status: 'quarantined' });
      fs.writeFileSync(path.join(m.runDir, 'manifest.json'), JSON.stringify(evil));
      const r = q.readRun(m.runDir, ctx);
      expect(r.ok).toBe(true);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].quarantinePath).toBe(path.join(m.runDir, '1', 'node_modules'));
      evil.runId = 'ffffffff'; fs.writeFileSync(path.join(m.runDir, 'manifest.json'), JSON.stringify(evil));
      expect(q.readRun(m.runDir, ctx).ok).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

test('nothing in the app removes user data: no rm/unlink/rmdir except the app\'s own scan cache', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  const hit = (f) => strip(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).split('\n').filter(l => /\b(rmSync|rmdirSync|unlinkSync|rmdir|unlink|fs\.rm|promises\.rm|\.rm\()/.test(l));
  expect(hit('quarantine.js')).toEqual([]);
  expect(hit('cleanup-folders.js')).toEqual([]);
  expect(hit('scanner.js')).toEqual([]);
  const m = hit('main.js');
  expect(m).toHaveLength(1);
  expect(m[0]).toMatch(/cachePaths|Object\.values\(cp\)/);   // the scan-cache sidecar files in userData, as before
});

// ---------- end to end ----------
test('round trip: content, mtime, permissions and links inside survive quarantine and restore', async () => {
  await withApp((r) => {
    proj(r, 'p');
    const nm = path.join(r, 'p/node_modules');
    fs.writeFileSync(path.join(nm, 'dep/run.sh'), '#!/bin/sh\necho hi\n'); if (!WIN) fs.chmodSync(path.join(nm, 'dep/run.sh'), 0o755);
    fs.writeFileSync(path.join(nm, 'dep/data.bin'), Buffer.from([0, 1, 2, 250, 251, 252]));
    try { fs.symlinkSync('index.js', path.join(nm, 'dep/link.js')); } catch (e) { /* no link rights on this Windows account */ }
  }, async ({ page, root, userData, qhome }) => {
    const nm = path.join(root, 'p/node_modules');
    const snap = (d) => { const o = {}; const w = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); const st = fs.lstatSync(f); o[path.relative(d, f)] = { link: st.isSymbolicLink() ? fs.readlinkSync(f) : null, mode: st.mode & 0o777, mtime: Math.floor(st.mtimeMs / 1000), data: st.isFile() ? fs.readFileSync(f).toString('hex') : null }; if (e.isDirectory()) w(f); } }; w(d); return o; };
    const before = snap(nm);
    const res = await del(page, [nm]);
    expect(res).toMatchObject({ deleted: 1, quarantined: 1, trashedInstead: 0 });
    expect(res.runId).toMatch(/^[0-9a-f]{8}$/);
    expect(fs.existsSync(nm)).toBe(false);
    expect(fs.existsSync(path.join(root, 'p/package.json'))).toBe(true);
    const dirs = runDirs(qhome);
    expect(dirs).toHaveLength(1);
    expect(path.basename(dirs[0])).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{8}$/);
    const man = manifestOf(dirs[0]);
    expect(man.items[0]).toMatchObject({ originalPath: nm, status: 'quarantined', category: 'node_modules', name: 'node_modules' });
    expect(man.items[0].originalRealPath).toBeTruthy();
    expect(man.runId).toBe(res.runId); expect(man.appVersion).toBeTruthy(); expect(man.items[0].size).toBeGreaterThan(0); expect(man.items[0].files).toBeGreaterThan(0);
    expect(fs.existsSync(man.items[0].quarantinePath)).toBe(true);
    expect(readLog(userData).find(e => e.status === 'quarantined')).toMatchObject({ path: nm, runId: res.runId, type: 'folder' });
    const l = await list(page);
    expect(l.totalSize).toBeGreaterThan(0);
    expect(l.runs[0]).toMatchObject({ runId: res.runId, expired: false, heldCount: 1 });
    const back = await restore(page, res.runId);
    expect(back).toMatchObject({ restored: 1, failed: 0 });
    expect(snap(nm)).toEqual(before);
    expect(manifestOf(dirs[0]).items[0].status).toBe('restored');
    expect(readLog(userData).filter(e => e.status === 'restored')).toHaveLength(1);
    expect((await restore(page, res.runId)).error).toBe('Nothing to restore in this run.');   // second click does nothing
  });
});

test('the manifest is on disk (all items planned) BEFORE the first move, and a crash between items leaves a consistent state', async () => {
  const root = tmp(); two(root); age(root);
  const { app, page, qhome, userData } = await launch(root, { SD_TEST_QUARANTINE: '1' });
  try {
    await scanViaUi(page);
    await app.evaluate(() => {
      const fsx = global.__e2eRequire('fs'), path = global.__e2eRequire('path');
      let n = 0;
      global.__e2eBeforeTrash = () => {
        n++;
        const base = path.join(process.env.STUFFDIVER_E2E_QHOME, '.StuffDiverQuarantine');
        const run = fsx.readdirSync(base)[0];
        const m = JSON.parse(fsx.readFileSync(path.join(base, run, 'manifest.json'), 'utf8'));
        if (n === 1 && m.items.some(i => i.status !== 'planned')) throw new Error('manifest not planned before the first move');
        if (n === 2) process.kill(process.pid, 'SIGKILL');   // power cut between item 1 and item 2
      };
    });
    await del(page, [path.join(root, 'a/node_modules'), path.join(root, 'b/node_modules')]).catch(() => 'app died');
    await app.close().catch(() => {});
    const dirs = runDirs(qhome);
    expect(dirs).toHaveLength(1);
    const man = manifestOf(dirs[0]);
    expect(man.items.map(i => i.status).sort()).toEqual(['planned', 'quarantined']);
    for (const it of man.items) {
      const orig = fs.existsSync(it.originalPath), inQ = fs.existsSync(it.quarantinePath);
      expect(orig !== inQ, `${it.originalPath} must be in exactly one place`).toBe(true);   // never lost, never in both
      expect(inQ).toBe(it.status === 'quarantined');
    }
    expect(fs.existsSync(path.join(dirs[0], 'manifest.json.tmp'))).toBe(false);
    // The surviving state is restorable after the next start.
    const again = await launch(root, { SD_TEST_QUARANTINE: '1', STUFFDIVER_E2E_QHOME: qhome });
    try {
      const l = await list(again.page);
      expect(l.runs).toHaveLength(1);
      expect(l.runs[0].heldCount).toBe(1);
      const r = await restore(again.page, l.runs[0].runId);
      expect(r).toMatchObject({ restored: 1, failed: 0 });
      expect(fs.existsSync(path.join(root, 'a/node_modules'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'b/node_modules'))).toBe(true);
    } finally { await again.app.close().catch(() => {}); }
  } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(qhome, { recursive: true, force: true }); }
  void userData;
});

test('the manifest written before the first move lists every item as planned', async () => {
  await withApp(two, async ({ app, page, root }) => {
    await app.evaluate(() => {
      const fsx = global.__e2eRequire('fs'), path = global.__e2eRequire('path');
      global.__seen = null;
      global.__e2eBeforeTrash = () => {
        if (global.__seen) return;
        const base = path.join(process.env.STUFFDIVER_E2E_QHOME, '.StuffDiverQuarantine');
        const run = fsx.readdirSync(base)[0];
        global.__seen = JSON.parse(fsx.readFileSync(path.join(base, run, 'manifest.json'), 'utf8')).items.map(i => i.status);
      };
    });
    const res = await del(page, [path.join(root, 'a/node_modules'), path.join(root, 'b/node_modules')]);
    expect(res.quarantined).toBe(2);
    expect(await app.evaluate(() => global.__seen)).toEqual(['planned', 'planned']);
  });
});

test('restore refuses when the destination exists, offers "(restored)" beside it, and never overwrites or merges', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root }) => {
    const nm = path.join(root, 'p/node_modules');
    const res = await del(page, [nm]);
    fs.mkdirSync(nm); fs.writeFileSync(path.join(nm, 'precious.txt'), 'new work');
    const r1 = await restore(page, res.runId);
    expect(r1).toMatchObject({ restored: 0, failed: 1 });
    expect(r1.results[0]).toMatchObject({ ok: false, state: 'exists', canRestoreBeside: true });
    expect(r1.results[0].reason).toMatch(/already exists/);
    expect(fs.readdirSync(nm)).toEqual(['precious.txt']);
    const r2 = await restore(page, res.runId, { ids: [1], beside: true });
    expect(r2.restored).toBe(1);
    expect(r2.restoredPaths[0]).toBe(nm + ' (restored)');
    expect(fs.existsSync(path.join(nm + ' (restored)', 'dep/index.js'))).toBe(true);
    expect(fs.readdirSync(nm)).toEqual(['precious.txt']);
  });
});

test('restore refuses when the parent is gone, recreates it only inside the scanned root, and never anywhere else', async () => {
  await withApp((r) => { mk(r, 'deep/er/package.json', '{}'); mk(r, 'deep/er/package-lock.json', '{}'); mk(r, 'deep/er/node_modules/d/i.js'); proj(r, 'p'); }, async ({ page, root, qhome }) => {
    const a = path.join(root, 'deep/er/node_modules'), b = path.join(root, 'p/node_modules');
    const res = await del(page, [a, b]);
    expect(res.quarantined).toBe(2);
    fs.renameSync(path.join(root, 'deep'), path.join(root, 'deep-moved'));
    const r1 = await restore(page, res.runId, { ids: [1, 2] });
    const gone = r1.results.find(x => x.originalPath === a);
    expect(gone).toMatchObject({ ok: false, state: 'parent-missing', canRecreateParent: true });
    expect(fs.existsSync(path.join(root, 'deep'))).toBe(false);                       // not recreated behind the user's back
    expect(r1.results.find(x => x.originalPath === b).ok).toBe(true);                // the other item is independent
    // The manifest says the scanned root is elsewhere: recreating would leave it, so it is refused.
    const dir = runDirs(qhome)[0], man = manifestOf(dir);
    man.scanRoot = path.join(root, 'p'); fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    const r2 = await restore(page, res.runId, { ids: [gone.id], recreateParent: true });
    expect(r2.results[0]).toMatchObject({ ok: false, state: 'refused' });
    expect(fs.existsSync(path.join(root, 'deep'))).toBe(false);
    man.scanRoot = root; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    const r3 = await restore(page, res.runId, { ids: [gone.id], recreateParent: true });
    expect(r3.results[0]).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(a, 'd/i.js'))).toBe(true);
  });
});

test('restore refuses protected destinations and anything inside a quarantine folder', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome }) => {
    const nm = path.join(root, 'p/node_modules');
    const res = await del(page, [nm]);
    const dir = runDirs(qhome)[0], file = path.join(dir, 'manifest.json');
    const tamper = (orig) => { const m = manifestOf(dir); m.items[0].originalPath = orig; m.items[0].originalRealPath = orig; fs.writeFileSync(file, JSON.stringify(m)); };
    const sys = WIN ? 'C:\\Windows\\node_modules' : '/usr/node_modules';
    for (const target of [sys, path.join(qhome, q.QDIR, 'x', 'node_modules')]) {
      tamper(target);
      const r = await restore(page, res.runId);
      expect(r.restored, target).toBe(0);
      expect(r.results[0].ok, target).toBe(false);
      expect(fs.existsSync(target), target).toBe(false);
      expect(fs.existsSync(manifestOf(dir).items[0].quarantinePath)).toBe(true);   // still safely in quarantine
    }
  });
});

test('restore reports a changed quarantine item and a missing one, and still restores the rest', async () => {
  await withApp(two, async ({ page, root, qhome, trashDir }) => {
    const res = await del(page, [path.join(root, 'a/node_modules'), path.join(root, 'b/node_modules')]);
    const dir = runDirs(qhome)[0], man = manifestOf(dir);
    const [x, y] = man.items;
    fs.writeFileSync(path.join(x.quarantinePath, 'dep/extra.txt'), 'someone added a file');   // content no longer matches the manifest
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(y.quarantinePath, path.join(trashDir, 'moved-away'));                            // missing item
    const r = await restore(page, res.runId);
    expect(r.restored).toBe(0);
    expect(r.results.find(v => v.id === x.n)).toMatchObject({ ok: false, state: 'mismatch' });
    expect(r.results.find(v => v.id === x.n).reason).toMatch(/no longer matches the manifest/);
    expect(r.results.find(v => v.id === y.n)).toMatchObject({ ok: false, state: 'missing' });
    expect(fs.existsSync(path.join(x.quarantinePath, 'dep/extra.txt'))).toBe(true);               // left untouched
    expect(fs.existsSync(x.originalPath)).toBe(false);
  });
});

test('EXDEV on rename falls back to the Trash for that item, says so in the result, the log and the manifest', async () => {
  await withApp(two, async ({ app, page, root, qhome, userData, trashDir }) => {
    await FAKE_TRASH(app, trashDir);
    await app.evaluate(() => { global.__e2eRename = (from, to) => { if (/[\\/]b[\\/]node_modules$/.test(from)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); global.__e2eRequire('fs').renameSync(from, to); }; });
    const res = await del(page, [path.join(root, 'a/node_modules'), path.join(root, 'b/node_modules')]);
    expect(res).toMatchObject({ deleted: 2, quarantined: 1, trashedInstead: 1 });
    expect(res.trashedInsteadReason).toMatch(/EXDEV/);
    expect(fs.existsSync(path.join(root, 'b/node_modules'))).toBe(false);
    expect(fs.readdirSync(trashDir)).toHaveLength(1);
    const log = readLog(userData);
    expect(log.find(e => e.status === 'quarantined').path).toBe(path.join(root, 'a/node_modules'));
    expect(log.find(e => e.status === 'trashed').reason).toMatch(/instead of quarantine.*EXDEV/);
    expect(manifestOf(runDirs(qhome)[0]).items.map(i => i.status).sort()).toEqual(['quarantined', 'trashed-fallback']);
    expect((await list(page)).runs[0].heldCount).toBe(1);
  });
});

test('no safe same-volume location (cloud-synced home): everything goes to the Trash exactly as before, and the result says why', async () => {
  const cloudHome = path.join(fixtureParent(), 'OneDrive - SdTest-' + process.pid);
  fs.mkdirSync(cloudHome, { recursive: true });
  try {
    await withApp((r) => proj(r, 'p'), async ({ app, page, root, trashDir }) => {
      await FAKE_TRASH(app, trashDir);
      const res = await del(page, [path.join(root, 'p/node_modules')]);
      expect(res).toMatchObject({ deleted: 1, quarantined: 0, trashedInstead: 1 });
      expect(res.trashedInsteadReason).toMatch(/no safe location/);
      expect(fs.readdirSync(trashDir)).toHaveLength(1);
      expect(fs.existsSync(path.join(cloudHome, q.QDIR))).toBe(false);
    }, { env: { STUFFDIVER_E2E_QHOME: cloudHome } });
  } finally { fs.rmSync(cloudHome, { recursive: true, force: true }); }
});

test('useQuarantine=false behaves exactly as before (Trash), and the setting persists', async () => {
  await withApp((r) => proj(r, 'p'), async ({ app, page, root, qhome, trashDir }) => {
    await FAKE_TRASH(app, trashDir);
    expect(await page.evaluate(() => window.api.saveSettings({ useQuarantine: false }))).toBe(true);
    expect((await page.evaluate(() => window.api.loadSettings())).useQuarantine).toBe(false);
    const res = await del(page, [path.join(root, 'p/node_modules')]);
    expect(res.deleted).toBe(1); expect(res.quarantined).toBe(0); expect(res.trashedInstead).toBe(0);
    expect(fs.readdirSync(trashDir)).toHaveLength(1);
    expect(runDirs(qhome)).toEqual([]);
  });
});

test('the quarantine folder is never scanned and never offered, whatever it contains', async () => {
  const root = tmp();
  try {
    proj(root, 'real');
    // a perfect-looking project hidden inside a quarantine folder
    proj(root, '.StuffDiverQuarantine/2025-01-01_000000_aabbccdd/1/fake');
    age(root);
    const { runScan } = require('../scanner');
    const r = await runScan(root, {});
    expect(r.allFiles.some(f => q.isQuarantinePath(f.path))).toBe(false);
    expect(r.allFiles.some(f => f.path.includes(path.join('real', 'node_modules')))).toBe(true);
    const { app, page, userData, qhome } = await launch(root, { SD_TEST_QUARANTINE: '1' });
    try {
      await scanViaUi(page);
      const c = await page.evaluate(() => window.api.cleanupFoldersScan());
      expect(c.candidates.map(x => x.relPath)).toEqual(['real/node_modules']);
      const direct = path.join(root, '.StuffDiverQuarantine/2025-01-01_000000_aabbccdd/1/fake/node_modules');
      const res = await del(page, [direct]);
      expect(res.error).toMatch(/quarantine folder/);
      expect(fs.existsSync(direct)).toBe(true);
      const files = await page.evaluate((p) => window.api.deleteFiles([p], 'test'), path.join(direct, 'dep/index.js'));
      expect(files.deleted || 0).toBe(0);
      expect(fs.existsSync(path.join(direct, 'dep/index.js'))).toBe(true);
      expect(readLog(userData).some(e => e.status === 'blocked')).toBe(true);
    } finally { await app.close().catch(() => {}); fs.rmSync(qhome, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('expired runs (older than 14 days) offer only "move to Trash"; Empty quarantine confirms with the total size and uses the Trash', async () => {
  await withApp(two, async ({ app, page, root, qhome, trashDir, userData }) => {
    await FAKE_TRASH(app, trashDir);
    const res = await del(page, [path.join(root, 'a/node_modules')]);
    const dir = runDirs(qhome)[0], man = manifestOf(dir);
    man.t = Date.now() - 20 * 86400000; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    const fresh = await del(page, [path.join(root, 'b/node_modules')]);
    expect(fresh.runId).not.toBe(res.runId);
    const l = await list(page);
    expect(l.retentionDays).toBe(14);
    expect(l.runs.find(r => r.runId === res.runId).expired).toBe(true);
    expect(l.runs.find(r => r.runId === fresh.runId).expired).toBe(false);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await expect(page.locator('#quar-overlay')).toBeVisible();
    const old = page.locator(`.quar-run[data-run="${res.runId}"]`), nw = page.locator(`.quar-run[data-run="${fresh.runId}"]`);
    await expect(old).toContainText('Expired: tap to move to Trash');
    await expect(old.locator('.quar-restore-run, .quar-restore-item')).toHaveCount(0);
    await expect(nw.locator('.quar-restore-run')).toHaveCount(1);
    await expect(nw.locator('.quar-restore-item')).toHaveCount(1);
    await expect(page.locator('#quar-summary')).toContainText('Quarantined items still use disk space until emptied');
    await expect(page.locator('#quar-empty-btn')).toHaveText('Empty quarantine (moves it to Trash)');
    // Cancel at the native confirmation: nothing moves; the dialog shows the size.
    await app.evaluate(() => { global.__asked = []; global.__e2eConfirm = async (o) => { global.__asked.push(o); return false; }; });
    await page.locator('#quar-empty-btn').click();
    await expect.poll(() => app.evaluate(() => global.__asked.length)).toBe(1);
    const asked = await app.evaluate(() => global.__asked[0]);
    expect(asked.message).toMatch(/Move 2 quarantine runs \(.*(B|KB|MB)/);
    expect(asked.detail).toMatch(/Nothing is permanently deleted/);
    expect(runDirs(qhome)).toHaveLength(2);
    // Expired run: tap to move to the Trash (it is moved whole; nothing is removed).
    await app.evaluate(() => { global.__e2eConfirm = async () => true; });
    await old.locator('.quar-trash-run').click();
    await expect(page.locator('#quar-notice')).toContainText('Moved 1 quarantine run folder to the Trash');
    expect(runDirs(qhome)).toHaveLength(1);
    const moved = fs.readdirSync(trashDir).find(n => q.RUN_RE.test(n.replace(/^\d+-/, '')));
    expect(fs.existsSync(path.join(trashDir, moved, '1', 'node_modules', 'dep', 'index.js'))).toBe(true);   // contents intact in the Trash
    expect(readLog(userData).find(e => e.type === 'quarantine-run')).toMatchObject({ status: 'trashed', runId: res.runId });
  });
});

test('restore and cleanup cannot run at the same time', async () => {
  await withApp(two, async ({ app, page, root }) => {
    const first = await del(page, [path.join(root, 'a/node_modules')]);
    await app.evaluate(() => { global.__e2eBeforeTrash = () => new Promise(r => setTimeout(r, 1500)); });
    const running = del(page, [path.join(root, 'b/node_modules')]);
    await new Promise(r => setTimeout(r, 400));
    const refused = await restore(page, first.runId);
    expect(refused.error).toMatch(/already running/);
    expect(fs.existsSync(path.join(root, 'a/node_modules'))).toBe(false);
    expect((await page.evaluate(() => window.api.trashQuarantine('all'))).error).toMatch(/already running/);
    expect((await running).quarantined).toBe(1);
    await app.evaluate(() => { global.__e2eBeforeTrash = null; });
    expect((await restore(page, first.runId)).restored).toBe(1);
  });
});

test('the confirmation says nothing is deleted, names the quarantine, and Cancel moves nothing', async () => {
  await withApp((r) => proj(r, 'p'), async ({ app, page, root }) => {
    await app.evaluate(() => { global.__asked = []; global.__e2eConfirm = async (o) => { global.__asked.push(o); return false; }; });
    const res = await del(page, [path.join(root, 'p/node_modules')]);
    expect(res.deleted).toBe(0);
    expect(fs.existsSync(path.join(root, 'p/node_modules'))).toBe(true);
    const o = await app.evaluate(() => global.__asked[0]);
    expect(o.buttons).toEqual(['Cancel', 'Move to quarantine']);
    expect(o.message).toMatch(/to quarantine\?/);
    for (const s of ['Nothing is deleted', 'hidden quarantine folder', 'next to your files', 'Tools > Quarantine', 'still use disk space until you empty the quarantine']) expect(o.detail).toContain(s);
    expect(o.detail).not.toMatch(/trashed/);
  });
});

// ---------- UI ----------
test('UI: results panel offers "Restore this run", and the Quarantine window lists, restores and shows log statuses', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root }) => {
    const nm = path.join(root, 'p/node_modules');
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('#cleanup-quar-toggle')).toBeChecked();
    await expect(page.locator('#cleanup-folders-execute')).toHaveText('Move Selected Folders to Quarantine');
    await expect(page.locator('#cleanup-quar-note')).toContainText('still use disk space until');
    await page.locator('.cleanup-folder-check').first().check();
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText(/Moved 1 folder to quarantine \(.*still using disk space/, { timeout: 20000 });
    await expect(page.locator('#cleanup-restore-run')).toBeVisible();
    expect(fs.existsSync(nm)).toBe(false);
    // Quarantine window
    await page.locator('#cleanup-close').click();
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await expect(page.locator('.quar-run')).toHaveCount(1);
    await expect(page.locator('.quar-item')).toContainText(nm);
    await expect(page.locator('.quar-item')).toContainText('in quarantine');
    // Deletion Log shows the quarantined status
    await page.locator('#quar-close').click();
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="dellog"]').click();
    await expect(page.locator('#dellog-list .dellog-quarantined')).toHaveCount(1);
    await page.locator('#dellog-status').selectOption('quarantined');
    await expect(page.locator('#dellog-list .dellog-row')).toHaveCount(1);
    await page.locator('#dellog-close').click();
    // Restore from the results panel
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await page.locator('.quar-restore-run').click();
    await expect(page.locator('#quar-notice')).toContainText('Restored 1 of 1 folder');
    expect(fs.existsSync(path.join(nm, 'dep/index.js'))).toBe(true);
    await expect(page.locator('.quar-item')).toContainText('restored');
    await expect(page.locator('.quar-restore-item')).toHaveCount(0);
    await page.locator('#quar-close').click();
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="dellog"]').click();
    await page.locator('#dellog-status').selectOption('restored');
    await expect(page.locator('#dellog-list .dellog-restored')).toHaveCount(1);
  });
});

test('UI: "Restore this run" in the results panel puts the folders back; a fallback item is reported as "went to the Trash instead"', async () => {
  await withApp(two, async ({ app, page, root, trashDir }) => {
    await FAKE_TRASH(app, trashDir);
    await app.evaluate(() => { global.__e2eRename = (from, to) => { if (/[\\/]b[\\/]node_modules$/.test(from)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); global.__e2eRequire('fs').renameSync(from, to); }; });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('.cleanup-folder-check').nth(0).check();
    await page.locator('.cleanup-folder-check').nth(1).check();
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText(/Moved 1 folder to quarantine.*1 went to the Trash instead \(.*EXDEV/, { timeout: 20000 });
    await page.locator('#cleanup-restore-run').click();
    await expect(page.locator('#cleanup-result')).toContainText('Restored 1 of 1 folder');
    expect(fs.existsSync(path.join(root, 'a/node_modules/dep/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'b/node_modules'))).toBe(false);   // went to the (fake) Trash, not to quarantine
  });
});

test('UI: a refused restore shows the reason and offers "Restore beside it"', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root }) => {
    const nm = path.join(root, 'p/node_modules');
    await del(page, [nm]);
    fs.mkdirSync(nm); fs.writeFileSync(path.join(nm, 'mine.txt'), 'x');
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await page.locator('.quar-restore-item').click();
    await expect(page.locator('#quar-notice')).toContainText('Restored 0 of 1');
    await expect(page.locator('.quar-item')).toContainText('already exists');
    await page.locator('.quar-restore-beside').click();
    await expect(page.locator('#quar-notice')).toContainText('Restored 1 of 1');
    expect(fs.existsSync(nm + ' (restored)')).toBe(true);
    expect(fs.readdirSync(nm)).toEqual(['mine.txt']);
  });
});
