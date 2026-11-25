// Final gate round: symlinked roots (G1), more bundles/app folders (G2), busy guard & stale lists (G3),
// chunked runs (G4), Collector results (G5), exact names on case-sensitive systems (G7).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const cf = require('../cleanup-folders');
const { requireUsableFixtures, launch, scanViaUi, fixtureParent, autoMarkers, linkOrSkip } = require('./helpers');
const link = (target, p, type) => linkOrSkip(test, target, p, type);

const OLD = new Date(Date.now() - 90 * 86400000);
const tmp = () => { requireUsableFixtures(test); return fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent(), 'sd-r7-'))); };
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
const readLog = (userData) => { try { return fs.readFileSync(path.join(userData, 'deletion-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
async function withRoot(prep, scanRootOf, fn) {
  const base = tmp(); prep(base); age(base);
  const scanRoot = scanRootOf(base);
  const { app, page, userData } = await launch(scanRoot);
  try { await scanViaUi(page); await fn({ app, page, base, scanRoot, userData }); }
  finally { await app.close(); fs.rmSync(base, { recursive: true, force: true }); }
}
const delFiles = (page, p) => page.evaluate((x) => window.api.deleteFiles(x, 'test'), p);

test('G1. a symlinked scan root cannot hide a bundle or cloud location (scan list and delete-files)', async () => {
  for (const [realRel, label, re] of [
    ['Foo.app/Contents', 'bundle', /inside an application bundle/],
    ['Dropbox/work', 'cloud', /in a cloud-synced folder/],
    ['Library/CloudStorage/OneDrive-X/p', 'cloud storage', /in a cloud-synced folder/]
  ]) {
    await withRoot((b) => { mk(b, `${realRel}/Resources/.DS_Store`); mk(b, `${realRel}/Resources/x.tmp`); mk(b, 'plain/.DS_Store'); },
      (b) => { const l = path.join(b, 'linkroot'); link(path.join(b, realRel), l, 'dir'); return l; },
      async ({ page, scanRoot, base }) => {
        const cats = await page.evaluate(() => window.api.cleanupScan());
        expect(cats.flatMap(c => c.paths), label).toEqual([]);
        const f = path.join(scanRoot, 'Resources/.DS_Store');
        const res = await delFiles(page, [f]);
        expect(res.deleted, label).toBe(0);
        expect(res.blocked[0].reason, label).toMatch(re);
        expect(res.blocked[0].reason).toContain('it resolves to');
        expect(fs.existsSync(path.join(base, realRel, 'Resources/.DS_Store')), label).toBe(true);
      });
  }
});

test('G1. a symlink INSIDE the root that leads to a cloud/bundle location is refused by delete-files', async () => {
  await withRoot((b) => { mk(b, 'scan/ok/.DS_Store'); mk(b, 'Dropbox/real/a.tmp'); mk(b, 'Z.app/Contents/b.tmp'); },
    (b) => { link(path.join(b, 'Dropbox/real'), path.join(b, 'scan/cloudlink'), 'dir'); link(path.join(b, 'Z.app/Contents'), path.join(b, 'scan/applink'), 'dir'); return path.join(b, 'scan'); },
    async ({ page, scanRoot, base }) => {
      const a = await delFiles(page, [path.join(scanRoot, 'ok/.DS_Store'), path.join(scanRoot, 'cloudlink/a.tmp')]);
      expect(a.deleted).toBe(0);
      expect(a.blocked[0].reason).toMatch(/^in a cloud-synced folder.*it resolves to/);
      const b2 = await delFiles(page, [path.join(scanRoot, 'applink/b.tmp')]);
      expect(b2.blocked[0].reason).toMatch(/^inside an application bundle.*it resolves to/);
      expect(fs.existsSync(path.join(base, 'Dropbox/real/a.tmp')) && fs.existsSync(path.join(scanRoot, 'ok/.DS_Store'))).toBe(true);
    });
});

test('G2. more bundle types and per-user installed-app folders; scan list and delete-files use the same rules', async () => {
  for (const ext of ['aaxplugin', 'clap', 'systemextension', 'dext', 'workflow', 'scptd', 'xcplugin', 'xcframework', 'rtfd', 'bundle'])
    expect(cf.installedAppReason(`/Users/bob/Stuff/Thing.${ext}/Contents/x/Thumbs.db`), ext).toBe('inside an application bundle');
  for (const p of ['C:\\Users\\bob\\AppData\\Local\\Programs\\Code\\x\\Thumbs.db', 'C:\\Users\\bob\\scoop\\apps\\git\\current\\Thumbs.db'])
    expect(cf.installedAppReason(p), p).toBe('inside an installed Windows application folder');
  expect(cf.installedAppReason('D:\\SteamLibrary\\steamapps\\common\\Game\\Thumbs.db')).toBe('inside an installed game folder');
  expect(cf.installedAppReason('/home/bob/.local/share/flatpak/app/x/.DS_Store')).toBe('inside an installed application location');
  await withRoot((b) => { for (const d of ['AppData/Local/Programs/App', 'scoop/apps/git', 'steamapps/common/Game', '.local/share/flatpak/app', 'Plug.aaxplugin/Contents']) mk(b, `${d}/.DS_Store`); mk(b, 'ok/.DS_Store'); },
    (b) => b, async ({ page, scanRoot }) => {
      const cats = await page.evaluate(() => window.api.cleanupScan());
      expect(cats.flatMap(c => c.paths).map(p => path.relative(scanRoot, p).split(path.sep).join('/'))).toEqual(['ok/.DS_Store']);
      for (const d of ['AppData/Local/Programs/App', 'scoop/apps/git', 'steamapps/common/Game', '.local/share/flatpak/app', 'Plug.aaxplugin/Contents']) {
        const res = await delFiles(page, [path.join(scanRoot, d, '.DS_Store')]);
        expect(res.deleted, d).toBe(0);
        expect(res.blocked[0].reason, d).toMatch(/installed|application bundle/);
      }
    });
});

test('G3. a second run is refused while one is in progress, and the button is disabled meanwhile', async () => {
  await withRoot((b) => { mk(b, 'a/.DS_Store'); mk(b, 'b/.DS_Store'); mk(b, 'keep/x.txt'); }, (b) => b, async ({ app, page, scanRoot }) => {
    await app.evaluate(() => { global.__e2eAfterDialog = () => new Promise(r => setTimeout(r, 1500)); });
    const first = delFiles(page, [path.join(scanRoot, 'a/.DS_Store')]);
    await new Promise(r => setTimeout(r, 300));
    const second = await delFiles(page, [path.join(scanRoot, 'b/.DS_Store')]);
    expect(second).toMatchObject({ deleted: 0, error: 'Another cleanup is already running. Nothing was moved.' });
    expect(fs.existsSync(path.join(scanRoot, 'b/.DS_Store'))).toBe(true);
    await first;
    const third = await delFiles(page, [path.join(scanRoot, 'b/.DS_Store')]);   // free again afterwards
    expect(third.error).toBeUndefined();
  });
  await withRoot((b) => { mk(b, 'a/.DS_Store'); mk(b, 'keep/x.txt'); }, (b) => b, async ({ app, page }) => {
    await app.evaluate(() => { global.__e2eAfterDialog = () => new Promise(r => setTimeout(r, 1500)); });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('#cleanup-execute').click();
    await expect(page.locator('#cleanup-execute')).toBeDisabled();
    await expect(page.locator('#cleanup-result')).toContainText(/Moved 1 file|removed 1/, { timeout: 15000 });
  });
});

test('G3. a file that vanished before the run is "already gone" (not "removed") and logged as such', async () => {
  await withRoot((b) => { mk(b, 'a/.DS_Store'); mk(b, 'b/.DS_Store'); mk(b, 'keep/x.txt'); }, (b) => b, async ({ page, scanRoot, userData }) => {
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    fs.unlinkSync(path.join(scanRoot, 'a/.DS_Store'));   // the list is now stale
    await page.locator('#cleanup-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText('already gone 1 (missing before this run, nothing was moved)', { timeout: 15000 });
    const log = readLog(userData);
    expect(log.find(e => e.path.endsWith(path.join('a', '.DS_Store')))).toMatchObject({ status: 'gone', reason: expect.stringContaining('already gone before this run') });
    expect(log.find(e => e.path.endsWith(path.join('b', '.DS_Store'))).status).not.toBe('gone');
    const cats = await page.evaluate(() => window.api.cleanupScan());
    expect(cats.flatMap(c => c.paths)).toEqual([]);   // neither is offered again
  });
});

test('G4. a selection above the chunk size runs in chunks and the results are merged', async () => {
  await withRoot((b) => { for (let i = 0; i < 5; i++) mk(b, `d${i}/.DS_Store`); mk(b, 'keep/x.txt'); }, (b) => b, async ({ app, page, userData }) => {
    await app.evaluate(() => { global.__e2eChunk = 2; });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('#cleanup-execute').click();
    const box = page.locator('#cleanup-result');
    await expect(box).toContainText(/(Moved|removed) 5|Moved 5/, { timeout: 20000 });
    expect(readLog(userData).filter(e => e.status === 'trashed' || e.status === 'removed')).toHaveLength(5);
    const q = await page.evaluate(() => window.api.queryDeletionLog({ limit: 10 }));
    expect(q.total).toBe(5);
  });
});

test('G5. the Collector shows a results panel on success and failure, and drops gone items', async () => {
  await withRoot((b) => { mk(b, 'a/one.dat'); mk(b, 'a/two.dat'); mk(b, 'a/three.dat'); }, (b) => b, async ({ app, page, scanRoot }) => {
    await page.locator('#view-table').click();
    const rows = page.locator('.file-table tbody tr');
    await expect(rows.first()).toBeVisible();
    // collect all three via the context menu
    for (let i = 0; i < 3; i++) { await rows.nth(i).click({ button: 'right' }); await page.locator('#context-menu button[data-action="collect"], .context-menu button[data-action="collect"]').first().click(); }
    await expect(page.locator('#collector-count')).toContainText('3 items');
    // make one vanish and one fail, one succeed
    const items = ['one.dat', 'two.dat', 'three.dat'].map(n => path.join(scanRoot, 'a', n));
    fs.unlinkSync(items[0]);
    await app.evaluate((_e, bad) => { global.__e2eTrash = async (p) => { if (p === bad) throw Object.assign(new Error('EPERM: nope'), { code: 'EPERM' }); global.__e2eRequire('fs').unlinkSync(p); }; }, items[1]);
    await page.locator('#collector-delete').click();
    const box = page.locator('#collector-result');
    await expect(box).toBeVisible({ timeout: 15000 });
    await expect(box).toContainText('already gone 1');
    await expect(box).toContainText('failed 1');
    await expect(box).toContainText('EPERM');
    await expect(page.locator('#collector-delete')).toBeEnabled();
    await expect(page.locator('#collector-count')).toContainText('1 item');   // only the failed item stays listed
    expect(fs.existsSync(items[1])).toBe(true);
  });
});

test('G7. duplicate-by-name grouping keeps names that differ only in case apart on case-sensitive systems', async () => {
  test.skip(process.platform !== 'linux', 'Linux file systems are case-sensitive');
  await withRoot((b) => { mk(b, 'a/Report.txt', 'aaa'); mk(b, 'b/report.txt', 'bbbb'); mk(b, 'c/Report.txt', 'ccc'); mk(b, 'd/Report.txt', 'ddd'); }, (b) => b, async ({ page }) => {
    const groups = await page.evaluate(() => window.api.findDuplicates());
    const names = groups.flatMap(g => g.files.map(f => f.name));
    // Report.txt (3 same-size copies) forms a group; report.txt (different file) must not be pulled into it
    const withLower = groups.filter(g => g.files.some(f => f.name === 'report.txt'));
    expect(withLower.every(g => g.files.every(f => f.name === 'report.txt'))).toBe(true);
    expect(names.filter(n => n === 'Report.txt').length).toBe(3);
  });
});
