// Manual check, not part of the suite: scans a real drive through the app.
// Usage: node tests/realdrive.manual.js C:/
const { launch } = require('./helpers');

(async () => {
  const folder = process.argv[2] || 'C:/';
  const { app, page } = await launch(folder);
  const t0 = Date.now();
  await page.locator('#empty-state-btn').click();
  await page.locator('#stats').waitFor({ state: 'visible', timeout: 20 * 60 * 1000 });
  await page.waitForFunction(() => /Free:/.test(document.getElementById('stats').innerText), null, { timeout: 60000 });
  console.log('seconds:', ((Date.now() - t0) / 1000).toFixed(0));
  console.log((await page.locator('#stats').innerText()).replace(/\s+/g, ' '));
  await page.locator('#view-foldermap').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/out-realdrive.png' });
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
