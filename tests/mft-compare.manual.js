// Manual check, not part of the suite. Windows only, run from an ELEVATED terminal:
//   node tests/mft-compare.manual.js C:/ [--depth 2]
// Scans the volume twice (normal walk, then NTFS MFT fast scan) and diffs the
// totals, file counts and per-folder sizes. Exit code 1 if the fast scan fell
// back to the walk or totals differ by more than 1%.
const { launch } = require('./helpers');

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--')) || 'C:/';
const depthIdx = args.indexOf('--depth');
const maxDepth = depthIdx >= 0 ? Number(args[depthIdx + 1]) || 1 : 1;
const TOLERANCE = 0.01;

async function scan(mode) {
  const { app, page } = await launch(folder, { STUFFDIVER_MFT_SCAN: mode });
  try {
    await page.evaluate(() => window.api.selectFolder()); // E2E mode approves the folder
    const t0 = Date.now();
    const r = await page.evaluate((f) => window.api.scanFolder(f, { exclude: [] }), folder);
    const seconds = (Date.now() - t0) / 1000;
    const folders = {};
    (function walk(node, depth, prefix) {
      for (const c of Object.values(node.children || {})) {
        const p = prefix + '/' + c.name;
        if (depth <= maxDepth) folders[p.toLowerCase()] = c.size;
        walk(c, depth + 1, p);
      }
    })(r.folderTree, 1, '');
    return { seconds, folders, r: {
      totalFiles: r.totalFiles, totalSize: r.totalSize, totalLogicalSize: r.totalLogicalSize,
      cloudOnlyCount: r.cloudOnlyCount, skippedDirs: r.skippedDirs, fastScan: r.fastScan || null
    } };
  } finally {
    await app.close();
  }
}

const gb = (n) => (n / 1024 ** 3).toFixed(2) + ' GB';
const pct = (a, b) => (b ? (((a - b) / b) * 100).toFixed(3) + '%' : 'n/a');

(async () => {
  console.log('Scanning with the normal walk...');
  const walk = await scan('0');
  console.log('Scanning with the MFT fast scan...');
  const fast = await scan('1');

  console.log(`\nwalk: ${walk.seconds.toFixed(1)} s   mft: ${fast.seconds.toFixed(1)} s`);
  console.log('fast scan engine:', JSON.stringify(fast.r.fastScan));
  for (const k of ['totalFiles', 'totalSize', 'totalLogicalSize', 'cloudOnlyCount', 'skippedDirs']) {
    const w = walk.r[k], f = fast.r[k];
    const fmt = k.includes('Size') ? gb : (n) => n.toLocaleString();
    console.log(`${k.padEnd(18)} walk=${fmt(w)}  mft=${fmt(f)}  diff=${pct(f, w)}`);
  }

  const rows = [];
  for (const p of new Set([...Object.keys(walk.folders), ...Object.keys(fast.folders)])) {
    const w = walk.folders[p] || 0, f = fast.folders[p] || 0;
    if (w !== f) rows.push({ p, w, f, d: f - w });
  }
  rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`\nLargest folder differences (depth <= ${maxDepth}, mft - walk):`);
  for (const r of rows.slice(0, 15)) console.log(`${(r.d / 1024 ** 2).toFixed(1).padStart(10)} MB  ${r.p}  (walk ${gb(r.w)}, mft ${gb(r.f)})`);
  if (!rows.length) console.log('none');

  const used = fast.r.fastScan && fast.r.fastScan.engine === 'mft';
  const sizeDiff = Math.abs(fast.r.totalSize - walk.r.totalSize) / (walk.r.totalSize || 1);
  const ok = used && sizeDiff <= TOLERANCE;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: ${used ? 'mft engine used' : 'fell back to walk (' + (fast.r.fastScan && fast.r.fastScan.fallbackReason) + ')'}, ` +
    `size diff ${(sizeDiff * 100).toFixed(3)}% (limit ${TOLERANCE * 100}%)`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
