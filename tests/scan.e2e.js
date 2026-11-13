const { test, expect } = require('@playwright/test');
const { makeFixture, launch } = require('./helpers');

test('scan counts every file incl. dot-folders, and free space is reported', async () => {
  const fx = makeFixture();
  const { app, page } = await launch(fx.root);
  try {
    await page.locator('#empty-state-btn').click();
    await expect(page.locator('#stats')).toContainText('Files:', { timeout: 30000 });
    await expect(page.locator('#stats')).toContainText(`Files: ${fx.fileCount}`);
    const disk = await page.evaluate((r) => window.api.getDiskSpace(r), fx.root);
    expect(disk.total).toBeGreaterThan(disk.available);
    expect(disk.available).toBeGreaterThan(0);
    await page.screenshot({ path: 'tests/out-scan.png' });
  } finally {
    await app.close();
  }
});

test('treemap shows a Free Space block', async () => {
  const fx = makeFixture();
  const { app, page } = await launch(fx.root);
  try {
    await page.locator('#empty-state-btn').click();
    await expect(page.locator('#stats')).toContainText('Files:', { timeout: 30000 });
    await page.getByRole('button', { name: 'Treemap' }).click();
    await expect(page.locator('.free-space-block')).toHaveCount(1, { timeout: 10000 });
    await page.screenshot({ path: 'tests/out-treemap.png' });
  } finally {
    await app.close();
  }
});
