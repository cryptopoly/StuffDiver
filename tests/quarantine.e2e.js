// Quarantine with one-click undo for developer-folder cleanup.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const q = require('../quarantine');
const { requireUsableFixtures, launch, scanViaUi, fixtureParent, autoMarkers, linkOrSkip } = require('./helpers');

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
    const ctx = { platform: 'win32', home: 'C:\\Users\\bob', fsx, rootOk: none, mounts: () => [], driveType: () => 'Fixed', owner: 'u-abc123' };
    expect(q.chooseRoot('C:\\Users\\bob\\proj\\node_modules', ctx).root).toBe('C:\\Users\\bob\\.StuffDiverQuarantine');
    expect(q.chooseRoot('D:\\work\\node_modules', ctx).root).toBe('D:\\.StuffDiverQuarantine\\u-abc123');   // shared drive top: per-user subfolder
    expect(q.chooseRoot('\\\\server\\share\\x\\node_modules', { ...ctx, fsx: fakeFs({ '\\\\server\\share\\x\\node_modules': { dev: 3 } }) }).error).toMatch(/drive letter/);
    for (const t of ['Network', 'Removable', 'CDRom']) expect(q.chooseRoot('D:\\work\\node_modules', { ...ctx, driveType: () => t }).error, String(t)).toMatch(/not a fixed local disk/);
    const unknown = q.chooseRoot('C:\\Users\\bob\\proj\\node_modules', { ...ctx, driveType: () => null, driveTypeReason: () => 'timed out after 10 s' }).error;
    expect(unknown).toMatch(/could not determine the drive type of C:.*timed out after 10 s.*Recycle Bin/);
  });
  test('Windows: a drive that differs in case still counts as the system drive; a cloud-synced or protected root is refused', () => {
    const fsx = fakeFs({ 'c:\\Users\\bob\\p\\node_modules': { dev: 1 }, 'C:\\Users\\bob': { dev: 1 } });
    const ctx = { platform: 'win32', home: 'C:\\Users\\bob', fsx, rootOk: none, mounts: () => [], driveType: () => 'Fixed' };
    expect(q.chooseRoot('c:\\Users\\bob\\p\\node_modules', ctx).root).toBe('C:\\Users\\bob\\.StuffDiverQuarantine');
    const refused = q.chooseRoot('c:\\Users\\bob\\p\\node_modules', { ...ctx, rootOk: () => 'is cloud-synced' });
    expect(refused.error).toMatch(/no safe location.*cloud-synced/);
  });
  test('Windows: same drive letter but a different volume (mounted folder) is refused, not renamed across', () => {
    const fsx = fakeFs({ 'C:\\mnt\\vol\\node_modules': { dev: 9 }, 'C:\\Users\\bob': { dev: 1 } });
    expect(q.chooseRoot('C:\\mnt\\vol\\node_modules', { platform: 'win32', home: 'C:\\Users\\bob', fsx, rootOk: none, mounts: () => [], driveType: () => 'Fixed' }).error).toMatch(/different volume/);
  });
  test('POSIX: home first, else the volume top from the mount table, never "/" and never a foreign-owned root', () => {
    const fsx = fakeFs({ '/Volumes/X/p/node_modules': { dev: 7 }, '/Volumes/X': { dev: 7 }, '/Users/a': { dev: 1 } });
    const ctx = { platform: 'darwin', home: '/Users/a', fsx, rootOk: none, uid: 501, mounts: () => ['/', '/Volumes/X'] };
    expect(q.chooseRoot('/Volumes/X/p/node_modules', ctx).root).toBe('/Volumes/X/.StuffDiverQuarantine');
    expect(q.chooseRoot('/Volumes/X/p/node_modules', { ...ctx, mounts: () => ['/'] }).error).toMatch(/different volume/);
    const owned = fakeFs({ '/Volumes/X/p/node_modules': { dev: 7 }, '/Volumes/X/.StuffDiverQuarantine': { dev: 7, uid: 0 }, '/Users/a': { dev: 1 } });
    expect(q.chooseRoot('/Volumes/X/p/node_modules', { ...ctx, fsx: owned }).error).toMatch(/belongs to another user/);
    expect(q.chooseRoot('/Volumes/X/p/node_modules', { ...ctx, owner: 'uid-501', fsx: fakeFs({ '/Volumes/X/p/node_modules': { dev: 7 }, '/Volumes/X': { dev: 7 }, '/Users/a': { dev: 1 } }) }).root).toBe('/Volumes/X/.StuffDiverQuarantine/uid-501');
    expect(q.chooseRoot('/Volumes/X/p/node_modules', { ...ctx, volumeProblem: (r) => (r.startsWith('/Volumes/X') ? 'is on a network or non-local volume (smbfs)' : null) }).error).toMatch(/smbfs/);
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
      q.setItemStatus(m, m.items[0], 'skipped', null, ctx);
      expect(fs.readdirSync(m.runDir).sort()).toEqual(['manifest.json', 'manifest.json.bak']);   // previous good copy kept, no stray temp files
      m.items[0].status = 'planned';
      const evil = JSON.parse(fs.readFileSync(path.join(m.runDir, 'manifest.json'), 'utf8'));
      evil.items[0].quarantinePath = path.join(root, 'somewhere-else');
      evil.items.push({ n: 2, name: '..', originalPath: path.join(root, '..'), status: 'quarantined' });
      fs.writeFileSync(path.join(m.runDir, 'manifest.json'), JSON.stringify(evil));
      const r = q.readRun(m.runDir, ctx);
      expect(r.ok).toBe(true);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].quarantinePath).toBe(path.join(m.runDir, '1', 'node_modules'));
      evil.runId = 'ffffffff'; fs.writeFileSync(path.join(m.runDir, 'manifest.json'), JSON.stringify(evil));
      expect(q.readRun(m.runDir, ctx).usedBackup).toBe(true);   // the mismatching file is ignored, the good .bak is used
      fs.writeFileSync(path.join(m.runDir, 'manifest.json.bak'), JSON.stringify(evil));
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
    expect(fs.readdirSync(dirs[0]).filter(n => n.endsWith('.tmp'))).toEqual([]);
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
    expect(r.results.find(v => v.id === x.n).reason).toMatch(/differs from what was moved in/);
    expect(r.results.find(v => v.id === y.n)).toMatchObject({ ok: false, state: 'missing' });
    expect(r.results.find(v => v.id === x.n)).toMatchObject({ canRestoreAnyway: true });
    expect(fs.existsSync(path.join(x.quarantinePath, 'dep/extra.txt'))).toBe(true);               // left untouched
    expect(fs.existsSync(x.originalPath)).toBe(false);
    // A mismatch never makes restore impossible: after explicit confirmation it is put back, extra file included.
    const forced = await restore(page, res.runId, { ids: [x.n], anyway: true });
    expect(forced.restored).toBe(1);
    expect(fs.existsSync(path.join(x.originalPath, 'dep/extra.txt'))).toBe(true);
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

test('expired runs (older than 14 days) keep Restore and add "move to Trash"; Empty quarantine confirms with the total size and uses the Trash', async () => {
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
    await expect(old.locator('.quar-restore-run')).toHaveCount(1);   // expired only adds the move-to-Trash suggestion
    await expect(old.locator('.quar-restore-item')).toHaveCount(1);
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
    for (const s of ['Nothing is deleted', 'hidden quarantine folder', 'next to your files', 'Tools > Quarantine', 'keep using disk space until you empty the quarantine']) expect(o.detail).toContain(s);
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

// ---------- adversarial-review fixes ----------
test('Q1: a file written while the confirmation was open does not make restore impossible', async () => {
  await withApp((r) => proj(r, 'p'), async ({ app, page, root }) => {
    const nm = path.join(root, 'p/node_modules');
    await app.evaluate((_e, d) => { global.__e2eConfirm = async () => { global.__e2eRequire('fs').writeFileSync(d + '/dep/late.txt', 'written while the dialog was open'); return true; }; }, nm);
    const res = await del(page, [nm]);
    expect(res.quarantined).toBe(1);
    const r = await restore(page, res.runId);
    expect(r).toMatchObject({ restored: 1, failed: 0 });
    expect(fs.readFileSync(path.join(nm, 'dep/late.txt'), 'utf8')).toMatch(/dialog was open/);
  });
});

test('Q1: a later change shows recorded vs now and offers "Restore anyway" in the window (with a confirm)', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome }) => {
    const nm = path.join(root, 'p/node_modules');
    await del(page, [nm]);
    const man = manifestOf(runDirs(qhome)[0]);
    fs.writeFileSync(path.join(man.items[0].quarantinePath, 'dep/dev-server.log'), 'wrote through an open file');
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await page.locator('.quar-restore-item').click();
    await expect(page.locator('.quar-item')).toContainText('differs from what was moved in');
    await page.locator('.quar-restore-anyway').click();
    await expect(page.locator('#quar-notice')).toContainText('Restored 1 of 1');
    expect(dialogs[0]).toMatch(/files .* bytes now/);
    expect(fs.existsSync(path.join(nm, 'dep/dev-server.log'))).toBe(true);
  });
});

test('Q2: runs owned by another account (in a shared folder) are neither listed, restored nor emptied', () => {
  const root = tmp();
  try {
    const ctxFor = (owner) => ({ platform: process.platform, fsx: fs, home: path.join(root, 'home'), owner });
    const shared = path.join(root, q.QDIR, 'uid-1000');   // another account's per-user folder on a shared volume
    q.createRun({ root: shared, runId: 'ab12cd34', t: Date.now(), appVersion: '0', items: [{ originalPath: path.join(root, 'p', 'node_modules'), dev: 1, size: 5, files: 1, category: 'node_modules' }] }, ctxFor('uid-1000'));
    const mine = q.listRuns([shared], ctxFor('uid-2000'));
    expect(mine.runs).toHaveLength(0); expect(mine.broken).toHaveLength(0);
    expect(q.listRuns([shared], ctxFor('uid-1000')).runs).toHaveLength(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('N4: in the account\'s OWN folder a changed owner id is listed ("owner changed") and restore needs a confirmation; the legacy id is accepted', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome }) => {
    const nm = path.join(root, 'p/node_modules');
    const res = await del(page, [nm]);
    const dir = runDirs(qhome)[0], man = manifestOf(dir);
    expect(man.owner).toBeTruthy();
    man.owner = 'renamed-account-id'; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    const l = await list(page);
    expect(l.runs).toHaveLength(1);                                  // not hidden as foreign
    const r1 = await restore(page, res.runId);
    expect(r1.results[0]).toMatchObject({ ok: false, state: 'mismatch', canRestoreAnyway: true });
    expect(r1.results[0].reason).toMatch(/different account id/);
    expect(fs.existsSync(nm)).toBe(false);
    expect((await restore(page, res.runId, { anyway: true })).restored).toBe(1);
  });
});

test('N4: per-user folders on a shared volume are secured and verified before use (failure means no quarantine there)', () => {
  const root = tmp();
  try {
    const calls = [];
    const ctx = { platform: process.platform, fsx: fs, home: path.join(root, 'home'), owner: 'sid-S-1-5-21-1', secureDir: (d) => { calls.push(d); }, hide: (d) => calls.push('hide:' + d), legacyOwners: ['u-legacy'] };
    const plan = { root: path.join(root, q.QDIR, 'sid-S-1-5-21-1'), runId: 'ab12cd34', t: Date.now(), appVersion: '0', items: [{ originalPath: path.join(root, 'p', 'node_modules'), dev: 1, size: 5, files: 1, category: 'node_modules' }] };
    q.createRun(plan, ctx);
    expect(calls).toEqual([plan.root, 'hide:' + plan.root, 'hide:' + path.dirname(plan.root)]);   // shared top is hidden too
    const bad = { ...ctx, secureDir: () => { throw new Error('owned by someone else'); } };
    expect(() => q.createRun({ ...plan, runId: 'ab12cd35', root: path.join(root, q.QDIR, 'sid-S-1-5-21-1') }, bad)).toThrow(/owned by someone else/);
    // a run written under the legacy hash id is still ours
    const m = q.createRun({ ...plan, runId: 'ab12cd36', root: path.join(root, q.QDIR, 'sid-S-1-5-21-1') }, { ...ctx, owner: 'u-legacy' });
    const own = q.listRuns([plan.root], ctx);
    expect(own.runs.map(r => r.runId)).toContain('ab12cd36');
    void m;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('N1: relaunching while only the tray is alive opens a new window instead of failing on a destroyed one', async () => {
  const root = tmp();
  const { app } = await launch(root, {});
  try {
    const n = await app.evaluate(async ({ BrowserWindow }) => {
      const keep = new BrowserWindow({ show: false });                 // something keeps the app alive (tray/monitor in real life)
      BrowserWindow.getAllWindows().filter(w => w !== keep).forEach(w => w.destroy());
      const before = BrowserWindow.getAllWindows().filter(w => w !== keep).length;
      global.__e2eShowMainWindow();                                    // what second-instance and the tray menu call
      await new Promise(r => setTimeout(r, 500));
      return { before, after: BrowserWindow.getAllWindows().filter(w => w !== keep && !w.isDestroyed()).length };
    });
    expect(n).toEqual({ before: 0, after: 1 });
  } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});

test('N2: the single-instance lock is released before an elevated or updater restart starts a new process', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  expect(src.indexOf('app.releaseSingleInstanceLock()')).toBeGreaterThan(-1);
  const el = src.indexOf("-Verb RunAs");
  expect(src.lastIndexOf('app.releaseSingleInstanceLock()', el)).toBeGreaterThan(src.lastIndexOf("handleTrusted('elevate-access'", el));
  expect(src.lastIndexOf('app.releaseSingleInstanceLock()', src.indexOf('autoUpdater.quitAndInstall'))).toBeGreaterThan(src.lastIndexOf('function', src.indexOf('autoUpdater.quitAndInstall')));
});

test('N3: an empty slot (item dragged out, crash between mkdir and rename) is "missing from quarantine", not restorable', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome, trashDir }) => {
    const res = await del(page, [path.join(root, 'p/node_modules')]);
    const dir = runDirs(qhome)[0], man = manifestOf(dir);
    fs.mkdirSync(trashDir, { recursive: true }); fs.renameSync(man.items[0].quarantinePath, path.join(trashDir, 'dragged-out'));   // slot stays, item gone
    const l = await list(page);
    expect(l.runs[0].items[0]).toMatchObject({ present: false });
    expect(l.runs[0].heldCount).toBe(0); expect(l.runs[0].size).toBe(0);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await expect(page.locator('.quar-item')).toContainText('missing from quarantine');
    await expect(page.locator('.quar-restore-item')).toHaveCount(0);
    void res;
  });
});

test('N6/Q8: a parent replaced by a link to an ancestor is refused BEFORE anything is created', async () => {
  await withApp((r) => { mk(r, 'deep/er/package.json', '{}'); mk(r, 'deep/er/package-lock.json', '{}'); mk(r, 'deep/er/node_modules/d/i.js'); }, async ({ page, root }) => {
    const res = await del(page, [path.join(root, 'deep/er/node_modules')]);
    fs.renameSync(path.join(root, 'deep'), path.join(root, 'deep-moved'));
    linkOrSkip(test, root, path.join(root, 'deep'), 'dir');              // deep -> the scanned root itself (an ancestor)
    const before = fs.readdirSync(root).sort();
    const r = await restore(page, res.runId, { recreateParent: true });
    expect(r.results[0]).toMatchObject({ ok: false });
    expect(fs.readdirSync(root).sort()).toEqual(before);                 // no stray "er" folder was created
  });
});

test('N6: unreadable-run wording says so when the system errored but the folder is gone', async () => {
  await withApp((r) => proj(r, 'p'), async ({ app, page, root, qhome, trashDir }) => {
    await del(page, [path.join(root, 'p/node_modules')]);
    const dir = runDirs(qhome)[0];
    fs.writeFileSync(path.join(dir, 'manifest.json'), 'x'); fs.writeFileSync(path.join(dir, 'manifest.json.bak'), 'x');
    await app.evaluate((_e, d) => { const fsx = global.__e2eRequire('fs'); fsx.mkdirSync(d, { recursive: true }); global.__e2eTrash = async (p) => { fsx.renameSync(p, d + '/x'); throw new Error('aborted'); }; }, trashDir);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await page.locator('.quar-trash-broken').click();
    await expect(page.locator('#quar-notice')).toContainText('may not be in the Trash');
  });
});


test('Q3: network, removable or unknown volumes are never used: the item goes to the Trash and the result says why', async () => {
  await withApp((r) => proj(r, 'p'), async ({ app, page, root, trashDir, qhome }) => {
    await FAKE_TRASH(app, trashDir);
    await app.evaluate(() => { global.__e2eDriveType = () => 'Network'; global.__e2eVolumeProblem = () => 'is on a network or non-local volume (smbfs)'; });
    const res = await del(page, [path.join(root, 'p/node_modules')]);
    expect(res).toMatchObject({ deleted: 1, quarantined: 0, trashedInstead: 1 });
    expect(res.trashedInsteadReason).toMatch(/network|not a fixed local disk/);
    expect(runDirs(qhome)).toEqual([]);
  });
});

test('Q4: a run whose manifest is corrupt is still listed (path, size, actions); manifest.json.bak is used when the main file is damaged', async () => {
  await withApp(two, async ({ app, page, root, qhome, trashDir, userData }) => {
    await FAKE_TRASH(app, trashDir);
    const res = await del(page, [path.join(root, 'a/node_modules'), path.join(root, 'b/node_modules')]);
    const dir = runDirs(qhome)[0];
    expect(fs.existsSync(path.join(dir, 'manifest.json.bak'))).toBe(true);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json');
    const viaBak = await list(page);
    expect(viaBak.runs).toHaveLength(1); expect(viaBak.unreadableRuns).toHaveLength(0);
    fs.writeFileSync(path.join(dir, 'manifest.json.bak'), 'garbage too');
    const l = await list(page);
    expect(l.runs).toHaveLength(0);
    expect(l.unreadableRuns).toHaveLength(1);
    expect(l.unreadableRuns[0]).toMatchObject({ name: path.basename(dir), path: dir });
    expect(l.unreadableRuns[0].size).toBeGreaterThan(0);
    expect(l.totalSize).toBeGreaterThan(0);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await expect(page.locator('.quar-unreadable')).toContainText('Unreadable quarantine run');
    await expect(page.locator('#quar-empty')).toBeHidden();
    await expect(page.locator('.quar-reveal-broken')).toHaveCount(1);
    await page.locator('.quar-trash-broken').click();
    await expect(page.locator('#quar-notice')).toContainText('Moved the unreadable run to the Trash');
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readdirSync(trashDir)).toHaveLength(1);
    expect(readLog(userData).find(e => e.source === 'quarantine-unreadable')).toMatchObject({ status: 'trashed', type: 'quarantine-run' });
    void res;
  });
});

test('Q5: an expired run can still be restored (UI and IPC)', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome }) => {
    const nm = path.join(root, 'p/node_modules');
    const res = await del(page, [nm]);
    const dir = runDirs(qhome)[0], man = manifestOf(dir);
    man.t = Date.now() - 40 * 86400000; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await expect(page.locator('.quar-run')).toContainText('expired');
    await page.locator('.quar-restore-run').click();
    await expect(page.locator('#quar-notice')).toContainText('Restored 1 of 1');
    expect(fs.existsSync(path.join(nm, 'dep/index.js'))).toBe(true);
    void res;
  });
});

test('Q6: a link planted in a run slot cannot redirect what restore moves', async () => {
  await withApp((r) => { proj(r, 'p'); mk(r, 'elsewhere/node_modules/x.txt', 'precious'); }, async ({ page, root, qhome }) => {
    const nm = path.join(root, 'p/node_modules');
    const res = await del(page, [nm]);
    const dir = runDirs(qhome)[0], slot = path.join(dir, '1');
    const aside = path.join(root, 'aside-slot');
    fs.renameSync(slot, aside);
    linkOrSkip(test, path.join(root, 'elsewhere'), slot, 'dir');
    const man = manifestOf(dir); delete man.items[0].files; delete man.items[0].size; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    const r = await restore(page, res.runId, { anyway: true });
    expect(r.restored).toBe(0);
    expect(r.results[0]).toMatchObject({ ok: false });
    expect(r.results[0].state).toMatch(/refused|missing/);
    expect(fs.existsSync(path.join(root, 'elsewhere/node_modules/x.txt'))).toBe(true);
    expect(fs.existsSync(nm)).toBe(false);
  });
});

test('Q6: missing size/file count in the manifest cannot be verified: refused unless the user confirms "restore anyway"', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome }) => {
    const nm = path.join(root, 'p/node_modules');
    const res = await del(page, [nm]);
    const dir = runDirs(qhome)[0], man = manifestOf(dir); delete man.items[0].files; delete man.items[0].size;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    const r1 = await restore(page, res.runId);
    expect(r1.results[0]).toMatchObject({ ok: false, state: 'mismatch', canRestoreAnyway: true });
    expect((await restore(page, res.runId, { ids: [1], anyway: true })).restored).toBe(1);
  });
});

test('Q7: a planted link at the old fixed temp-file name is never written through', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome }) => {
    const res = await del(page, [path.join(root, 'p/node_modules')]);
    const dir = runDirs(qhome)[0], victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    linkOrSkip(test, victim, path.join(dir, 'manifest.json.tmp'), 'file');
    expect((await restore(page, res.runId)).restored).toBe(1);   // rewrites the manifest
    expect(fs.readFileSync(victim, 'utf8')).toBe('original');
  });
});

test('Q8: recreating a missing parent never goes through a link', async () => {
  await withApp((r) => { mk(r, 'deep/er/package.json', '{}'); mk(r, 'deep/er/package-lock.json', '{}'); mk(r, 'deep/er/node_modules/d/i.js'); fs.mkdirSync(path.join(r, 'outside')); }, async ({ page, root }) => {
    const a = path.join(root, 'deep/er/node_modules');
    const res = await del(page, [a]);
    fs.renameSync(path.join(root, 'deep'), path.join(root, 'deep-moved'));
    linkOrSkip(test, path.join(root, 'outside'), path.join(root, 'deep'), 'dir');
    const r = await restore(page, res.runId, { recreateParent: true });
    expect(r.restored).toBe(0);
    expect(r.results[0]).toMatchObject({ ok: false });
    expect(fs.readdirSync(path.join(root, 'outside'))).toEqual([]);   // nothing was created behind the link
  });
});

test('Q9: when the Trash call errors but the run folder is gone, the log says "removed", not "trashed"', async () => {
  await withApp((r) => proj(r, 'p'), async ({ app, page, root, qhome, userData, trashDir }) => {
    const res = await del(page, [path.join(root, 'p/node_modules')]);
    await app.evaluate((_e, d) => { const fsx = global.__e2eRequire('fs'); fsx.mkdirSync(d, { recursive: true }); global.__e2eTrash = async (p) => { fsx.renameSync(p, d + '/x'); throw new Error('The operation was aborted'); }; }, trashDir);
    const r = await page.evaluate(() => window.api.trashQuarantine('all'));
    expect(r).toMatchObject({ trashed: 0, removed: 1, failed: 0 });
    expect(readLog(userData).find(e => e.type === 'quarantine-run')).toMatchObject({ status: 'removed' });
    expect(runDirs(qhome)).toEqual([]);
    void res;
  });
});

test('restoring an item that was never moved says so', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome, trashDir }) => {
    const res = await del(page, [path.join(root, 'p/node_modules')]);
    const dir = runDirs(qhome)[0], man = manifestOf(dir);
    man.items[0].status = 'planned'; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    fs.mkdirSync(trashDir, { recursive: true }); fs.renameSync(path.join(dir, '1'), path.join(trashDir, 'slot'));
    const r = await restore(page, res.runId, { ids: [1] });
    expect(r.results[0]).toMatchObject({ ok: false, state: 'never-moved' });
    expect(r.results[0].reason).toMatch(/never moved/);
  });
});

// ---------- UX round ----------
test('U1: every item that goes to the Trash instead is named with its reason, in the confirmation and in the results', async () => {
  await withApp(two, async ({ app, page, root, trashDir }) => {
    await FAKE_TRASH(app, trashDir);
    await app.evaluate(() => { global.__asked = []; global.__e2eConfirm = async (o) => { global.__asked.push(o); return true; }; global.__e2eVolumeProblem = () => 'is on a network or non-local volume (smbfs)'; global.__e2eDriveType = () => 'Network'; });
    const a = path.join(root, 'a/node_modules'), b = path.join(root, 'b/node_modules');
    const res = await del(page, [a, b]);
    const o = await app.evaluate(() => global.__asked[0]);
    expect(o.detail).toMatch(/go to the Trash instead|Trash instead/);
    expect(o.detail).toContain(a); expect(o.detail).toContain(b);
    expect(o.detail).toMatch(/smbfs|not a fixed local disk/);
    expect(res.trashedInsteadItems.map(i => i.path).sort()).toEqual([a, b].sort());
    for (const i of res.trashedInsteadItems) expect(i.reason).toMatch(/smbfs|not a fixed local disk|no safe location/);
  });
});

test('U2: on Windows a folder with a junction/link inside is greyed out at scan time with the reason', () => {
  const root = tmp();
  try {
    mk(root, 'p/package.json', '{}'); mk(root, 'p/package-lock.json', '{}'); mk(root, 'p/node_modules/d/i.js'); fs.mkdirSync(path.join(root, 'target'));
    linkOrSkip(test, path.join(root, 'target'), path.join(root, 'p/node_modules/d/lnk'), 'dir');
    const cf = require('../cleanup-folders');
    const files = [{ path: path.join(root, 'p/node_modules/d/i.js'), name: 'i.js', size: 5, mtime: 1 }, { path: path.join(root, 'p/node_modules/.package-lock.json'), name: '.package-lock.json', size: 1, mtime: 1 }];
    const asWin = cf.findCandidates(files, root, false, fs, ['/'], [], true).find(c => c.path.endsWith('node_modules'));
    expect(asWin.refusedReason).toMatch(/contains .*lnk, a junction or directory link/);
    const asPosix = cf.findCandidates(files, root, false, fs, ['/'], [], false).find(c => c.path.endsWith('node_modules'));
    expect(asPosix.refusedReason).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('restore only lands inside an approved or recorded scan folder; anything else needs the exact destination confirmed', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome }) => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent(), 'sd-other-')));
    try {
      const res = await del(page, [path.join(root, 'p/node_modules')]);
      const dir = runDirs(qhome)[0], man = manifestOf(dir);
      const dest = path.join(other, 'node_modules');
      man.items[0].originalPath = dest; man.items[0].originalRealPath = dest; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
      const r1 = await restore(page, res.runId);
      expect(r1.results[0]).toMatchObject({ ok: false, state: 'confirm-destination', canConfirmDestination: true, destination: dest });
      expect(fs.existsSync(dest)).toBe(false);
      const r2 = await restore(page, res.runId, { ids: [1], confirmDestination: path.join(other, 'something-else') });
      expect(r2.results[0].ok).toBe(false);
      const r3 = await restore(page, res.runId, { ids: [1], confirmDestination: dest });
      expect(r3.restored).toBe(1);
      expect(fs.existsSync(path.join(dest, 'dep/index.js'))).toBe(true);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
});

// ---------- Windows per-user folder securing (injectable runner, pure unit tests) ----------
test.describe('unit: per-user folder ACL', () => {
  const SID = 'S-1-5-21-111-222-333-1001';
  const GOOD = `D:PAI(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
  function setup(over = {}) {
    const root = tmp();
    const calls = [];
    const run = over.run || (async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('/save')) fs.writeFileSync(args[args.indexOf('/save') + 1], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('shared\r\n' + (over.sddl || GOOD) + '\r\n', 'utf16le')]));
      if (cmd === 'cmd.exe') return `01/01/2026  10:00    <DIR>          ${over.owner || 'PC\\bob'}  ${path.basename(over.dirName || 'sid-x')}\r\n`;
      return '';
    });
    const sec = q.createDirSecurer({ fsx: fs, run, getSid: async () => SID, getUserName: async () => 'PC\\bob', scratch: path.join(root, 'acl.txt'), now: over.now });
    return { root, calls, sec, dir: path.join(root, q.QDIR, 'sid-x') };
  }
  test('SDDL parsing: protected, only the three SIDs, no inherited or deny entries', () => {
    expect(q.parseSddl(GOOD)).toMatchObject({ protected: true, inheritedAce: false, denyAce: false, allFull: true, trustees: [SID, 'S-1-5-18', 'S-1-5-32-544'] });
    expect(q.parseSddl('D:AI(A;OICIID;FA;;;AU)')).toMatchObject({ protected: false, inheritedAce: true });
    expect(q.parseSddl('nothing here')).toBeNull();
  });
  test('a new folder is created exclusively, gets the icacls grant, is verified and then cached for the session', async () => {
    const { root, calls, sec, dir } = setup();
    try {
      await sec.ensure(dir);
      expect(fs.existsSync(dir)).toBe(true);
      expect(calls[0].slice(0, 4)).toEqual(['icacls.exe', dir, '/inheritance:r', '/grant:r']);
      expect(calls[0]).toContain(`*${SID}:(OI)(CI)F`); expect(calls[0]).toContain('*S-1-5-18:(OI)(CI)F'); expect(calls[0]).toContain('*S-1-5-32-544:(OI)(CI)F');
      const n = calls.length; await sec.ensure(dir);
      expect(calls.length).toBe(n); expect(sec.isVerified(dir)).toBe(true);   // cached: no more processes
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('an ACL that did not apply as expected (extra principal, inherited entry) is refused', async () => {
    for (const sddl of [`D:PAI(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)`, `D:AI(A;OICIID;FA;;;${SID})`, `D:PAI(A;OICI;FA;;;SY)`]) {
      const { root, sec, dir } = setup({ sddl });
      try { await expect(sec.ensure(dir)).rejects.toThrow(/could not secure the quarantine folder \(the permissions did not apply/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  });
  test('a folder that already existed must match exactly (no new grant is applied) and be owned by this account or Administrators', async () => {
    let { root, calls, sec, dir } = setup();
    try { fs.mkdirSync(dir, { recursive: true }); await sec.ensure(dir); expect(calls.some(c => c.includes('/grant:r'))).toBe(false); expect(calls.some(c => c[0] === 'cmd.exe')).toBe(true); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    ({ root, sec, dir } = setup({ owner: 'PC\\mallory' }));
    try { fs.mkdirSync(dir, { recursive: true }); await expect(sec.ensure(dir)).rejects.toThrow(/owned by another account/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    ({ root, sec, dir } = setup({ owner: 'BUILTIN\\Administrators' }));
    try { fs.mkdirSync(dir, { recursive: true }); await sec.ensure(dir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    ({ root, sec, dir } = setup({ sddl: `D:AI(A;OICI;FA;;;AU)` }));
    try { fs.mkdirSync(dir, { recursive: true }); await expect(sec.ensure(dir)).rejects.toThrow(/existing folder has other permissions/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('a timeout gives the short reason, is not cached beyond 30 s, and works on retry', async () => {
    let t = 0, slow = true;
    const base = setup();
    const sec = q.createDirSecurer({ fsx: fs, now: () => t, getSid: async () => SID, getUserName: async () => 'PC\\bob', scratch: path.join(base.root, 'acl.txt'),
      run: async (cmd, args) => { if (slow) throw new Error('timed out after 5 s'); if (args.includes('/save')) fs.writeFileSync(args[args.indexOf('/save') + 1], GOOD); return ''; } });
    try {
      await expect(sec.ensure(base.dir)).rejects.toThrow('could not secure the quarantine folder (timed out)');
      slow = false; t += 5000;
      await expect(sec.ensure(base.dir)).rejects.toThrow(/timed out/);   // still inside the 30 s window: same answer, no new process
      t += 31000;
      expect(fs.existsSync(base.dir)).toBe(true);                         // made by the failed try: still ours, so the retry applies the grant
      await sec.ensure(base.dir);
      expect(sec.isVerified(base.dir)).toBe(true);
    } finally { fs.rmSync(base.root, { recursive: true, force: true }); }
  });
  test('processes run strictly one at a time', async () => {
    let active = 0, max = 0;
    const { root, sec, dir } = setup({ run: async (cmd, args) => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 15)); if (args.includes('/save')) fs.writeFileSync(args[args.indexOf('/save') + 1], GOOD); active--; return ''; } });
    try { await Promise.all([sec.ensure(dir), sec.ensure(dir + '-b')]); expect(max).toBe(1); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------- W1/P1/P2: drive-type probe (pure unit tests, no windows) ----------
test.describe('unit: drive-type probe', () => {
  const mk2 = (o) => q.createDriveProbe({ systemDrive: 'C', runFsutil: async (l) => `${l}: - Fixed Drive`, runDotnet: async () => 'C|Fixed|\nS|Fixed|\n', runBus: async () => 'S|SATA\nD|USB\n', ...o });
  test('fsutil output is parsed for every drive kind; unknown or localized text is not understood', () => {
    expect(['C: - Fixed Drive', 'D: - CD-ROM Drive', 'E: - Removable Drive', 'Z: - Remote/Network Drive', 'R: - RAM Disk'].map(q.parseFsutilDriveType)).toEqual(['Fixed', 'CDRom', 'Removable', 'Network', 'Ram']);
    expect(q.parseFsutilDriveType('C: - Festplatte')).toBeNull();
    expect(q.parseFsutilDriveType('')).toBeNull();
    expect([...q.parseBusList('S|SATA\r\nD|USB\r\njunk')]).toEqual([['S', 'SATA'], ['D', 'USB']]);
    expect([...q.parseDriveList('C|Fixed|NVMe\nD|Fixed|USB\nE|Network|\n')]).toEqual([['C', 'Fixed'], ['D', 'Removable (USB disk)'], ['E', 'Network']]);
  });
  test('the system drive is allowed as soon as fsutil says Fixed, without waiting for the bus check', async () => {
    let busCalls = 0;
    const p = mk2({ runBus: async () => { busCalls++; return 'S|SATA\n'; } });
    await p.prefetch(['C:\\x']);
    expect(p.type('C')).toBe('Fixed');
    expect(busCalls).toBe(0);                             // not even needed for C:
  });
  test('a non-system disk stays "not allowed" until the bus type is known, then follows it (USB is removable)', async () => {
    let release; const gate = new Promise(r => { release = r; });
    const p = mk2({ runBus: async () => { await gate; return 'S|SATA\nD|USB\n'; } });
    await p.prefetch(['S:\\x', 'D:\\x']);   // the bus check runs in the background; prefetch does not wait for it
    expect(p.type('S')).toBeNull(); expect(p.reason('S')).toMatch(/USB\/SD media/);
    release(); await p.startBusCheck();
    expect(p.type('S')).toBe('Fixed'); expect(p.type('D')).toBe('Removable (USB disk)');
  });
  test('a failed bus check never blocks the system drive; non-system disks are retried after 30 s', async () => {
    let t = 0, fail = true, calls = 0;
    const p = mk2({ now: () => t, runBus: async () => { calls++; if (fail) throw new Error('timed out after 15 s'); return 'S|SATA\n'; } });
    await p.prefetch(['C:\\a', 'S:\\b']);
    await p.startBusCheck();                               // let the failing background check finish
    expect(p.type('C')).toBe('Fixed'); expect(p.type('S')).toBeNull(); expect(p.reason('S')).toMatch(/failed/);
    t += 5000; await p.startBusCheck(); expect(calls).toBe(1);
    t += 31000; fail = false; await p.startBusCheck();
    expect(calls).toBe(2); expect(p.type('S')).toBe('Fixed');
  });
  test('an fsutil timeout or unreadable (localized) output falls back to the .NET listing; both failing gives a short reason', async () => {
    const p1 = mk2({ runFsutil: async () => 'C: - Festplatte', runDotnet: async () => 'C|Fixed|\n' });
    await p1.prefetch(['C:\\x']); expect(p1.type('C')).toBe('Fixed');
    const p2 = mk2({ runFsutil: async () => { throw new Error('timed out after 5 s'); }, runDotnet: async () => { throw new Error('timed out after 10 s'); } });
    await p2.prefetch(['C:\\x']);
    expect(p2.type('C')).toBeNull();
    expect(p2.reason('C')).toBe('timed out after 5 s; then timed out after 10 s');
    const p3 = mk2({ runFsutil: async () => { throw new Error('boom'); }, runDotnet: async () => 'S|Fixed|\n' });
    await p3.prefetch(['Z:\\x']); expect(p3.reason('Z')).toMatch(/not listed/);
  });
  test('probes never overlap and a failure is retried only after 30 s', async () => {
    let active = 0, max = 0, runs = 0, t = 0, mode = 'fail';
    const p = mk2({ now: () => t, runFsutil: async (l) => { runs++; active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 20)); active--; if (mode === 'fail') throw new Error('x'); return l + ': - Fixed Drive'; }, runDotnet: async () => { throw new Error('y'); } });
    await Promise.all([p.prefetch(['C:\\a']), p.prefetch(['S:\\a']), p.prefetch(['D:\\a'])]);
    expect(max).toBe(1);
    const n = runs; await p.prefetch(['C:\\a']); expect(runs).toBe(n);   // inside the 30 s window
    t += 31000; mode = 'ok'; await p.prefetch(['C:\\a']); expect(p.type('C')).toBe('Fixed');
    const m = runs; await p.prefetch(['C:\\a']); expect(runs).toBe(m);   // a success is remembered
  });
});

test('W2: the Quarantine list labels an owner-changed run before any restore attempt', async () => {
  await withApp((r) => proj(r, 'p'), async ({ page, root, qhome }) => {
    await del(page, [path.join(root, 'p/node_modules')]);
    const dir = runDirs(qhome)[0], man = manifestOf(dir);
    man.owner = 'old-account-id'; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man));
    expect((await list(page)).runs[0].ownerChanged).toBe(true);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="quarantine"]').click();
    await expect(page.locator('.quar-run')).toContainText('owner changed');
    await expect(page.locator('.quar-run')).toContainText('different account id');
  });
});
