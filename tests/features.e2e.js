const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFixture, launch, scanViaUi } = require('./helpers');

async function withApp(fn, { env, prepare } = {}) {
  const fx = makeFixture();
  if (prepare) prepare(fx);
  const { app, page } = await launch(fx.root, env);
  try {
    await fn({ app, page, fx });
  } finally {
    await app.close();
  }
}

test('hard links are counted once; sizes are allocated size >= logical size', async () => {
  await withApp(async ({ page, fx }) => {
    await scanViaUi(page);
    await expect(page.locator('#stats')).toContainText(`Files: ${fx.fileCount}`);
    const res = await page.evaluate((r) => window.api.scanFolder(r, {}), fx.root);
    expect(res.totalFiles).toBe(fx.fileCount);
    expect(res.totalSize).toBeGreaterThanOrEqual(res.totalLogicalSize);
    expect(res.totalLogicalSize).toBe(fx.expected);
    expect(res.extStats.find(e => e.ext === '.txt').count).toBe(3);
  });
});

test('free space is shown in the stats bar', async () => {
  await withApp(async ({ page }) => {
    await scanViaUi(page);
    await expect(page.locator('.stat-free')).toContainText('Free:', { timeout: 10000 });
    await expect(page.locator('.stat-free')).toContainText(' of ');
  });
});

test('exclusions skip names, globs and paths (settings -> scan)', async () => {
  await withApp(async ({ page, fx }) => {
    await page.evaluate(() => window.api.saveSettings({ scanExclusions: ['node_modules', '.hid*'] }));
    await scanViaUi(page);
    // 7 files minus node_modules/pkg/index.js and .hidden/cache.bin
    await expect(page.locator('#stats')).toContainText('Files: 5');
    await expect(page.locator('#stats')).toContainText('Excluded: 2');

    const byPath = await page.evaluate(
      ([r, p]) => window.api.scanFolder(r, { exclude: [p] }), [fx.root, path.join(fx.root, 'docs')]);
    expect(byPath.totalFiles).toBe(fx.fileCount - 3);
  });
});

test('exclusions can be edited in the settings dialog', async () => {
  await withApp(async ({ page }) => {
    await page.locator('#settings-btn').click();
    await page.locator('#settings-exclusions').fill('node_modules\n*.tmp');
    await page.locator('#settings-save').click();
    await expect(page.locator('#settings-save-status')).toHaveText('Saved!');
    const saved = await page.evaluate(() => window.api.loadSettings());
    expect(saved.scanExclusions).toEqual(['node_modules', '*.tmp']);
  });
});

test('a running scan can be cancelled and reports a partial result', async () => {
  await withApp(async ({ page }) => {
    await page.locator('#empty-state-btn').click();
    const cancel = page.locator('#scan-cancel');
    await expect(cancel).toBeVisible({ timeout: 10000 });
    await cancel.click();
    await expect(page.locator('#stats')).toContainText('Partial scan', { timeout: 15000 });
    const text = await page.locator('#stats').innerText();
    expect(Number(/Files:\s*([\d,]+)/.exec(text)[1].replace(/,/g, ''))).toBeLessThan(7);
  }, { env: { STUFFDIVER_E2E_SCAN_DELAY_MS: '500' } });
});

test('folder treemap draws nested folders and drills down on click', async () => {
  await withApp(async ({ page }) => {
    await scanViaUi(page);
    await page.locator('#view-foldermap').click();
    await expect(page.locator('.fm-container, .fm-leaf').first()).toBeVisible();
    const big = page.locator('.fm-container[data-folder-path="big"], .fm-leaf[data-folder-path="big"]').first();
    await expect(big).toBeVisible();
    await big.click();
    await expect(page.locator('#treemap-breadcrumb')).toContainText('big');
    // folder filter must work with Windows paths too: big/ holds 2 distinct files
    await expect(page.locator('#stats')).toContainText('Showing top: 2');
    const bg = await page.locator('.fm-leaf').first().evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgb(255, 255, 255)');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    await page.screenshot({ path: 'tests/out-foldermap.png' });
    await page.locator('#treemap-breadcrumb .tb-root').click();
    await expect(page.locator('#treemap-breadcrumb')).toBeHidden();
  });
});

test('extension panel lists extensions and filters to one extension', async () => {
  await withApp(async ({ page }) => {
    await scanViaUi(page);
    await page.locator('#view-table').click();
    await page.locator('#stats-toggle').click();
    const row = page.locator('.ext-row[data-ext=".txt"]');
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('#ext-filter-chip')).toContainText('.txt');
    await expect(page.locator('#stats')).toContainText('Showing top: 3');
    await page.locator('#ext-filter-chip').click();
    await expect(page.locator('#ext-filter-chip')).toHaveCount(0);
    await expect(page.locator('#stats')).toContainText('Showing top: 7');
  });
});

test('smart cleanup scans the full file list (incl. Windows-style separators)', async () => {
  await withApp(async ({ page }) => {
    await scanViaUi(page);
    const cats = await page.evaluate(() => window.api.cleanupScan());
    const nm = cats.find(c => c.id === 'node_modules');
    expect(nm.count).toBe(1);
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('#cleanup-body')).toContainText('node_modules');
  });
});

test('duplicate finder reports the exact copy as a gold match', async () => {
  await withApp(async ({ page }) => {
    await scanViaUi(page);
    await page.locator('#view-duplicates').click();
    await page.locator('.dup-scan-btn').click();
    await expect(page.locator('#visualization')).toContainText('copy-of-a.txt', { timeout: 20000 });
    const dupes = await page.evaluate(() => window.api.findDuplicates());
    const gold = dupes.find(g => g.tier === 'gold');
    expect(gold.files.map(f => f.name).sort()).toEqual(['a.txt', 'copy-of-a.txt']);
  });
});

test('query-files-by-ext and is-elevated IPCs behave', async () => {
  await withApp(async ({ page, fx }) => {
    await scanViaUi(page);
    const txt = await page.evaluate(() => window.api.queryFilesByExt('.txt', 10));
    expect(txt.map(f => f.name)).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    expect(txt[0].size).toBeGreaterThanOrEqual(txt[txt.length - 1].size);
    expect(typeof (await page.evaluate(() => window.api.isElevated()))).toBe('boolean');
  });
});

test('unreadable folders raise the access banner', async () => {
  const lockedName = 'locked-dir';
  let lockedPath;
  let restore = () => {};
  await withApp(async ({ page }) => {
    await scanViaUi(page);
    await expect(page.locator('#access-banner')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#access-msg')).toContainText("couldn't be read");
    await expect(page.locator('#stats')).toContainText('Inaccessible: 1');
    await page.locator('#access-dismiss').click();
    await expect(page.locator('#access-banner')).toBeHidden();
  }, {
    prepare: (fx) => {
      lockedPath = path.join(fx.root, lockedName);
      fs.mkdirSync(lockedPath);
      fs.writeFileSync(path.join(lockedPath, 'secret.txt'), 'x');
      if (process.platform === 'win32') {
        const user = os.userInfo().username;
        execFileSync('icacls', [lockedPath, '/deny', `${user}:(OI)(CI)(RD,X)`]);
        restore = () => execFileSync('icacls', [lockedPath, '/remove:d', user]);
      } else {
        test.skip(process.getuid && process.getuid() === 0, 'root can read everything');
        fs.chmodSync(lockedPath, 0o000);
        restore = () => fs.chmodSync(lockedPath, 0o755);
      }
    }
  }).finally(() => { try { restore(); } catch (e) { /* ignore */ } });
});
