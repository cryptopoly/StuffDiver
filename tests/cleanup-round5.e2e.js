// Release-gate round: bundles/installed apps (B1), "removed, not in Trash" (S1) and the small hardening items.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const cf = require('../cleanup-folders');
const { launch, scanViaUi, fixtureParent, autoMarkers } = require('./helpers');

const OLD = new Date(Date.now() - 90 * 86400000);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent(), 'sd-r5-')));
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
const readLog = (userData) => { try { return fs.readFileSync(path.join(userData, 'deletion-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
async function withApp(prep, fn) {
  const root = tmp(); prep(root); age(root);
  const { app, page, userData } = await launch(root);
  try { await scanViaUi(page); await fn({ app, page, root, userData }); }
  finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const delFiles = (page, p) => page.evaluate((x) => window.api.deleteFiles(x, 'test'), p);
const catPaths = (cats, root) => Object.fromEntries(cats.map(c => [c.id, c.paths.map(p => path.relative(root, p).split(path.sep).join('/')).sort()]));

test('B1. bundle-like and installed-app paths are recognised', () => {
  for (const ext of ['app', 'framework', 'bundle', 'plugin', 'component', 'vst', 'vst3', 'appex', 'kext', 'xpc', 'prefPane', 'saver', 'mdimporter', 'qlgenerator', 'wdgt', 'xcarchive', 'photoslibrary', 'musiclibrary', 'imovielibrary', 'tvlibrary', 'band', 'logicx', 'fcpbundle', 'sparsebundle', 'pkg'])
    expect(cf.installedAppReason(`/Users/bob/Stuff/Thing.${ext}/Contents/x/Thumbs.db`, true), ext).toBe('inside an application bundle');
  expect(cf.installedAppReason('/Applications/PowerDirector.app/Contents/Resources/Effects/Bad TV/Thumbs.db')).toBe('inside an application bundle');
  expect(cf.installedAppReason('/Users/bob/notes.app.txt')).toBeNull();            // only a bundle FOLDER counts
  expect(cf.installedAppReason('/Users/bob/Pictures/Photos Library.photoslibrary')).toBeNull();   // the bundle itself is not "inside" one
  expect(cf.installedAppReason('/Users/bob/work/.DS_Store')).toBeNull();
  const w = 'inside an installed Windows application folder';
  for (const p of ['C:\\Program Files\\App\\a\\Thumbs.db', 'C:\\Program Files (x86)\\App\\Thumbs.db', 'C:\\Program Files\\WindowsApps\\X\\Thumbs.db', 'C:\\ProgramData\\Package Cache\\x\\Thumbs.db'])
    expect(cf.installedAppReason(p), p).toBe(w);
  const l = 'inside an installed application location';
  for (const p of ['/usr/share/x/.DS_Store', '/opt/app/Thumbs.db', '/snap/x/1/Thumbs.db', '/var/lib/flatpak/app/x/Thumbs.db', '/tmp/.mount_AppImgXyz/usr/Thumbs.db'])
    expect(cf.installedAppReason(p), p).toBe(l);
  expect(cf.installedAppReason('/home/bob/.var/app/org.x/cache/x/.DS_Store')).toBeNull();   // flatpak user data stays offerable
  expect(cf.installedAppReason('/home/bob/usr-notes/Thumbs.db')).toBeNull();
});

test('B1. no preset (ticked or not) offers files inside bundles; delete-files refuses them and nothing is moved', async () => {
  await withApp((r) => {
    mk(r, 'Fake.app/Contents/Resources/Effects/Bad TV/Thumbs.db'); mk(r, 'Fake.app/Contents/.DS_Store');
    mk(r, 'Lib.framework/Versions/A/.DS_Store'); mk(r, 'Plug.vst3/Contents/x/desktop.ini'); mk(r, 'Plug.vst3/Contents/y.tmp'); mk(r, 'Plug.vst3/Contents/z.log');
    mk(r, 'Photos.photoslibrary/database/.DS_Store');
    mk(r, 'ok/.DS_Store'); mk(r, 'ok/Thumbs.db'); mk(r, 'fine/x.tmp');
  }, async ({ page, root, userData }) => {
    const c = catPaths(await page.evaluate(() => window.api.cleanupScan()), root);
    expect(Object.values(c).flat().sort()).toEqual(['fine/x.tmp', 'ok/.DS_Store', 'ok/Thumbs.db']);
    const bad = path.join(root, 'Fake.app/Contents/Resources/Effects/Bad TV/Thumbs.db');
    const res = await delFiles(page, [path.join(root, 'ok/.DS_Store'), bad]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toMatch(/^inside an application bundle/);
    expect(res.error).toContain('is inside an application bundle');
    expect(res.error).toContain('Nothing was moved');
    expect(fs.existsSync(bad) && fs.existsSync(path.join(root, 'ok/.DS_Store'))).toBe(true);
    expect(readLog(userData).filter(e => e.status === 'blocked')).toHaveLength(1);
  });
});

test('S1. an item the system reports as failed but that is gone is counted as "removed, not in Trash", not as failed or moved', async () => {
  await withApp((r) => { mk(r, 'a/.DS_Store'); mk(r, 'b/.DS_Store'); mk(r, 'c/Thumbs.db'); mk(r, 'keep/x.txt'); }, async ({ app, page, root, userData }) => {
    // Simulate the macOS quirk deterministically: the file disappears, then trashItem throws "doesn't exist".
    await app.evaluate(() => { global.__e2eTrash = async (p) => { if (/\.DS_Store$/.test(p)) { global.__e2eRequire('fs').unlinkSync(p); throw new Error('The file “.DS_Store” doesn’t exist.'); } /* Thumbs.db: really fails */ throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); }; });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('.cleanup-check[data-id="thumbs"]').check();
    await page.locator('#cleanup-execute').click();
    const box = page.locator('#cleanup-result');
    await expect(box).toContainText('Moved 0 files to the Trash', { timeout: 15000 });
    await expect(box).toContainText('removed 2 (gone, but not confirmed to be in the Trash');
    await expect(box).toContainText('failed 1, skipped 0');
    await expect(box).toContainText('failed: ' + path.join(root, 'c/Thumbs.db'));
    await expect(box).not.toContainText('moved to the Trash (');
    const log = readLog(userData);
    expect(log.filter(e => e.status === 'removed')).toHaveLength(2);
    expect(log.find(e => e.status === 'removed').reason).toMatch(/may not be in the Trash/);
    expect(log.find(e => e.status === 'failed')).toMatchObject({ finalState: 'untouched', reason: expect.stringContaining('EPERM') });
    // the gone files are dropped from the next scan instead of being offered (still ticked) again
    const again = catPaths(await page.evaluate(() => window.api.cleanupScan()), root);
    expect(again.dsstore).toBeUndefined();
    expect(again.thumbs).toEqual(['c/Thumbs.db']);
    // viewer: filter and badge
    await page.locator('#cleanup-close').click();
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="dellog"]').click();
    await page.locator('#dellog-status').selectOption('removed');
    await expect(page.locator('.dellog-row')).toHaveCount(2);
    await expect(page.locator('.dellog-badge.dellog-removed').first()).toBeVisible();
  });
});

test('S1 (folders). a gone folder after a reported error is "removed" and leaves the tree', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, async ({ app, page, root, userData }) => {
    await app.evaluate(() => { global.__e2eTrash = async (p) => { global.__e2eRequire('fs').rmSync(p, { recursive: true }); throw new Error('boom'); }; });
    const res = await page.evaluate((x) => window.api.deleteFolders(x, 'test'), [path.join(root, 'a/node_modules')]);
    expect(res).toMatchObject({ deleted: 0, removed: 1, failures: [] });
    expect(res.removedPaths).toEqual([path.join(root, 'a/node_modules')]);
    expect(readLog(userData).find(e => e.type === 'folder').status).toBe('removed');
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(scan.candidates.map(c => c.relPath)).toEqual(['b/node_modules']);
  });
});

test('hardening: NUL paths, duplicate paths, oversized requests are refused before any work', async () => {
  await withApp((r) => { mk(r, 'a/.DS_Store'); proj(r, 'p'); }, async ({ page, root, userData }) => {
    const f = path.join(root, 'a/.DS_Store');
    const nul = await delFiles(page, [f + '\0.txt']);
    expect(nul.error).toBe('Refused: a path contains a NUL character. Nothing was moved.');
    const nulF = await page.evaluate((x) => window.api.deleteFolders(x, 'test'), [path.join(root, 'p/node_modules') + '\0']);
    expect(nulF.error).toBe('Refused: a path contains a NUL character. Nothing was moved.');
    expect(fs.existsSync(f)).toBe(true);
    // duplicates count once
    const dup = await delFiles(page, [f, f, f.toUpperCase() === f ? f : f]);
    expect(dup.deleted + (dup.removed || 0) + (dup.failures || []).length).toBe(1);
    expect(readLog(userData).filter(e => e.path === f)).toHaveLength(1);
    // oversized requests are rejected immediately (no per-path work)
    const t0 = Date.now();
    const many = await page.evaluate(() => { const a = []; for (let i = 0; i < 30000; i++) a.push('/nonexistent/x' + i + '/node_modules'); return window.api.deleteFolders(a, 'test'); });
    expect(many.error).toBe('Refused: 30000 folders selected, the limit is 500 per run. Nothing was changed.');
    const huge = await page.evaluate(() => { const a = []; for (let i = 0; i < 50001; i++) a.push('/nonexistent/f' + i); return window.api.deleteFiles(a, 'test'); });
    expect(huge.error).toMatch(/^Refused: 50001 files in one request, the limit is 50000/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

test('hardening: delete-files re-checks after the dialog (a file swapped for a folder is refused)', async () => {
  await withApp((r) => { mk(r, 'a/.DS_Store'); mk(r, 'a/inner/keep.txt'); }, async ({ app, page, root, userData }) => {
    const f = path.join(root, 'a/.DS_Store');
    await app.evaluate((_e, p) => { global.__e2eAfterDialog = () => { const fsx = global.__e2eRequire('fs'); fsx.rmSync(p); fsx.mkdirSync(p); fsx.writeFileSync(p + '/precious.txt', 'x'); }; }, f);
    const res = await delFiles(page, [f]);
    expect(res.deleted).toBe(0);
    expect(res.error).toMatch(/changed before it could be deleted \(a folder, not a file/);
    expect(fs.existsSync(path.join(f, 'precious.txt'))).toBe(true);
    expect(readLog(userData).find(e => e.path === f).reason).toMatch(/^changed before delete: a folder, not a file/);
  });
});

test('hardening: dialog text is sanitised (control/bidi characters, newlines, very long names)', () => {
  expect(cf.safeText('a\nb\r\nc\u0000d\u202Eevil\u2066x\u2069')).toBe('a b c d evil x');
  expect(cf.safeText('  tab\there  ')).toBe('tab here');
  const long = '/home/' + 'x'.repeat(400) + '/file.txt';
  const t = cf.safeText(long, 100);
  expect(t.length).toBeLessThanOrEqual(100);
  expect(t).toContain('\u2026');
  expect(t.startsWith('/home/')).toBe(true);
  expect(t.endsWith('/file.txt')).toBe(true);
  expect(cf.safeText('short')).toBe('short');
});

test('hardening: a future mtime never shows a negative age', async () => {
  const root = tmp();
  try {
    proj(root, 'p'); mk(root, 'q/Cargo.toml', '');
    age(root);
    const future = new Date(Date.now() + 3 * 86400000);
    fs.utimesSync(path.join(root, 'p/node_modules/dep/index.js'), future, future);
    fs.utimesSync(path.join(root, 'p/package.json'), future, future);
    const s = cf.projectSignals(path.join(root, 'p/node_modules'), 'node_modules', { home: path.join(root, 'none') });
    expect(s.warnings.join(' ')).toMatch(/project files were modified today/);
    expect(s.warnings.join(' ')).not.toMatch(/-\d/);
    const { app, page } = await launch(root);
    try {
      await scanViaUi(page);
      const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
      const c = scan.candidates.find(x => x.relPath === 'p/node_modules');
      expect(c.ageDays).toBe(0);
      expect(c.warnings.join(' ')).toMatch(/modified today/);
      expect(c.warnings.join(' ')).not.toMatch(/-\d/);
    } finally { await app.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cannot-reinstall: pnpm git/local resolutions are severe; a process in the project root only warns', () => {
  expect(cf.lockfileProblem("packages:\n  x@1:\n    resolution: {commit: abc123, repo: 'https://github.com/a/x', type: git}\n")).toBe('lockfile has a dependency without an npm registry tarball (git or local)');
  expect(cf.lockfileProblem("packages:\n  y@1:\n    resolution: {directory: ../local, type: directory}\n")).toBe('lockfile has a dependency without an npm registry tarball (git or local)');
  expect(cf.lockfileProblem("packages:\n  z@1:\n    resolution:\n      commit: abc\n      repo: https://x\n")).toBe('lockfile has a dependency without an npm registry tarball (git or local)');
  expect(cf.lockfileProblem("packages:\n  ok@1:\n    resolution: {integrity: sha512-abc}\n")).toBeNull();
  expect(cf.lockfileProblem('"resolved": "https://registry.npmjs.org/a/-/a-1.tgz"')).toBeNull();
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'p/node_modules'), { recursive: true }); fs.writeFileSync(path.join(root, 'p/package.json'), '{}');
    const dir = path.join(root, 'p/node_modules');
    const o = { home: path.join(root, 'none') };
    const a = cf.projectSignals(dir, 'node_modules', { ...o, cwds: [path.join(root, 'p')] });
    expect(a.severe).toBeNull();
    expect(a.warnings).toContain(`a running process has its working directory in this project (${path.join(root, 'p')})`);
    expect(cf.projectSignals(dir, 'node_modules', { ...o, cwds: [path.join(root, 'p/src')] }).warnings.join(' ')).toMatch(/working directory in this project/);
    expect(cf.projectSignals(dir, 'node_modules', { ...o, cwds: [path.join(root, 'other')] }).warnings.join(' ')).not.toMatch(/working directory/);
    expect(cf.projectSignals(dir, 'node_modules', { ...o, cwds: [path.join(dir, 'x')] }).severe).toMatch(/running process is using this folder/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('user-document check also covers node_modules (office/design files), .gradle, .nuxt, .pytest_cache', async () => {
  const root = tmp();
  try {
    const check = async (dir, docName) => {
      const kind = cf.classifyFolder(dir);
      expect(kind && kind.kind, dir).toBeTruthy();
      const w = await cf.inspectFolder(dir, fs, false, null, kind);
      return w.userDoc;
    };
    mk(root, 'n/package.json', '{}'); mk(root, 'n/yarn.lock', ''); mk(root, 'n/node_modules/dep/README.md'); mk(root, 'n/node_modules/dep/docs.pdf'); mk(root, 'n/node_modules/dep/i.js');
    expect(await check(path.join(root, 'n/node_modules'))).toBeNull();      // READMEs and pdfs ship inside packages
    mk(root, 'n/node_modules/budget.xlsx');
    expect(await check(path.join(root, 'n/node_modules'))).toBe(path.join(root, 'n/node_modules/budget.xlsx'));
    mk(root, 'n/node_modules/dep/logo.psd');
    mk(root, 'g/build.gradle', ''); mk(root, 'g/.gradle/x'); mk(root, 'g/.gradle/notes.md');
    expect(await check(path.join(root, 'g/.gradle'))).toBe(path.join(root, 'g/.gradle/notes.md'));
    mk(root, 'u/nuxt.config.ts', ''); mk(root, 'u/.nuxt/x'); mk(root, 'u/.nuxt/thesis.docx');
    expect(await check(path.join(root, 'u/.nuxt'))).toBe(path.join(root, 'u/.nuxt/thesis.docx'));
    mk(root, 't/.pytest_cache/CACHEDIR.TAG'); mk(root, 't/.pytest_cache/v/draft.pages');
    expect(await check(path.join(root, 't/.pytest_cache'))).toBe(path.join(root, 't/.pytest_cache/v/draft.pages'));
    // scan-time (file list) check agrees
    const files = [{ path: path.join(root, 'n/node_modules/budget.xlsx'), name: 'budget.xlsx', size: 1, mtime: 1 }, { path: path.join(root, 'n/node_modules/dep/README.md'), name: 'README.md', size: 1, mtime: 1 }];
    const found = cf.findCandidates(files, root, false, fs, ['/'], [])[0];
    expect(found.userDoc).toBe(path.join(root, 'n/node_modules/budget.xlsx'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
