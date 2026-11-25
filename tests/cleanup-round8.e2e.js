// Last round: elevated CI profile rule (V1), installed-app locations at delete time (V2),
// Recycle Bin capacity hint (V3), tree/stat updates and on-disk case for loose files (V4).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const cf = require('../cleanup-folders');
const { requireUsableFixtures, launch, scanViaUi, fixtureParent, autoMarkers } = require('./helpers');

const OLD = new Date(Date.now() - 90 * 86400000);
const tmp = () => { requireUsableFixtures(test); return fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent(), 'sd-r8-'))); };
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
async function withApp(prep, fn) {
  const root = tmp(); prep(root); age(root);
  const { app, page, userData } = await launch(root);
  try { await scanViaUi(page); await fn({ app, page, root, userData }); }
  finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('V1. elevated runs may use their OWN profile (GitHub windows-latest "runneradmin") but not another user\'s or SYSTEM\'s', () => {
  const runner = { win: true, systemDrive: 'C:', home: 'C:\\Users\\runneradmin', tmp: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp', uid: null, elevated: true };
  const own = 'C:\\Users\\runneradmin\\StuffDiverTestFixtures\\sd-1\\p\\node_modules';
  expect(cf.blockedLocation(own, runner)).toBeNull();
  expect(cf.blockedLocation('C:\\Users\\runneradmin\\work\\app\\node_modules', runner)).toBeNull();
  expect(cf.blockedLocation('C:\\Users\\dan\\StuffDiverTestFixtures\\sd-1\\p\\node_modules', runner)).toBe('is outside your user profile and this app is running elevated (Administrator)');
  expect(cf.blockedLocation('D:\\build\\p\\node_modules', runner)).toBe('is outside your user profile and this app is running elevated (Administrator)');
  // the SYSTEM account's profile is under C:\Windows: nothing there qualifies
  const system = { ...runner, home: 'C:\\Windows\\system32\\config\\systemprofile', tmp: 'C:\\Windows\\TEMP' };
  expect(cf.blockedLocation('C:\\Windows\\TEMP\\sd-1\\p\\node_modules', system)).toBeTruthy();
  expect(cf.blockedLocation('C:\\Users\\dan\\p\\node_modules', system)).toBe('is outside your user profile and this app is running elevated (Administrator)');
  // not elevated: any user folder on the system drive is fine
  expect(cf.blockedLocation('C:\\Users\\dan\\p\\node_modules', { ...runner, home: 'C:\\Users\\dan', elevated: false })).toBeNull();
});

test('V2. installed-app locations are refused at delete time by the same shared function as the scan', () => {
  const win = 'inside an installed Windows application folder';
  for (const p of ['C:\\Program Files\\App\\setup.msi', 'C:\\Program Files (x86)\\App\\x.dll', 'C:\\Program Files\\WindowsApps\\X_1\\a.png', 'C:\\ProgramData\\Package Cache\\{GUID}\\setup.msi', 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\x.lnk'])
    expect(cf.installedAppReason(p), p).toBe(win);
  const lin = 'inside an installed application location';
  for (const p of ['/opt/app/lib/x.so', '/snap/core/1/x', '/app/bin/x', '/var/lib/flatpak/app/x/y', '/usr/share/x', '/tmp/.mount_abc/usr/x'])
    expect(cf.installedAppReason(p), p).toBe(lin);
  expect(cf.installedAppReason('C:\\Users\\bob\\Documents\\setup.msi')).toBeNull();
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // one function, no flags: the delete path and the scan list must call it identically
  expect(src.match(/fileLocationReason\(/g).length).toBeGreaterThanOrEqual(4);
  expect(src).not.toMatch(/installedAppReason\([^)]*,\s*true\)/);
  expect(src).not.toMatch(/fileLocationReason\([^)]*,/);
  expect(src).toMatch(/const loc = fileLocationReason\(fp\);/);          // delete-files
  expect(src).toMatch(/if \(fileLocationReason\(f\.path\)\) break;/);   // scan list
});

test('V3. a large folder gets a Recycle Bin capacity hint; others get the generic hint', () => {
  const TB = 1e12;
  expect(cf.capacityHint(0.4 * TB, 1 * TB)).toBe('it is about 40% of the volume, which may exceed the Recycle Bin size limit');
  expect(cf.capacityHint(0.06 * TB, 1 * TB)).toBe('it is about 6.0% of the volume, which may exceed the Recycle Bin size limit');
  expect(cf.capacityHint(0.01 * TB, 1 * TB)).toBeNull();
  expect(cf.capacityHint(0, 1 * TB)).toBeNull();
  expect(cf.capacityHint(5, 0)).toBeNull();
});

test('V4. after a loose-file cleanup the Files stat and the tree follow immediately', async () => {
  await withApp((r) => { mk(r, 'a/.DS_Store'); mk(r, 'b/.DS_Store'); mk(r, 'c/keep.txt'); mk(r, 'c/also.txt'); }, async ({ app, page }) => {
    await expect(page.locator('#stats')).toContainText('Files: 4');
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('#cleanup-execute').click();
    await expect(page.locator('#cleanup-result')).toContainText(/Moved 2 files|removed 2/, { timeout: 15000 });
    await expect(page.locator('#stats')).toContainText('Files: 2');
    await page.locator('#cleanup-close').click();
    const tree = await page.locator('#folder-tree').innerText();
    expect(tree).toMatch(/2 items/);        // root now holds the two remaining files
    expect(tree).not.toMatch(/\b4 items/);
  });
});

test('V4. log paths carry the on-disk case (case-insensitive file systems)', async () => {
  test.skip(process.platform === 'linux', 'only meaningful on case-insensitive file systems');
  await withApp((r) => { mk(r, 'proj/.DS_Store'); mk(r, 'keep/x.txt'); }, async ({ page, root, userData }) => {
    const typed = path.join(root, 'PROJ', '.DS_STORE');
    const real = path.join(root, 'proj', '.DS_Store');
    const res = await page.evaluate((x) => window.api.deleteFiles(x, 'test'), [typed]);
    expect(res.error).toBeUndefined();
    const e = readLog(userData).find(x => x.path.toLowerCase() === real.toLowerCase());
    expect(e.path).toBe(real);
  });
});
