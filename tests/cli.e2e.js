const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFixture, runCli } = require('./helpers');

function outDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cli-out-')); }

function parseCsv(text) {
  const [head, ...rows] = text.trim().split('\n');
  return { head, rows: rows.map(r => r.split(',')) };
}

test('CLI exports CSV with every file and matches the GUI file count', async () => {
  const fx = makeFixture();
  const out = path.join(outDir(), 'out.csv');
  const r = runCli(['--scan', fx.root, '--export', out]);
  expect(r.status).toBe(0);
  expect(r.stderr).toContain('Scan done');
  const { head, rows } = parseCsv(fs.readFileSync(out, 'utf8'));
  expect(head).toBe('path,size_on_disk,logical_size,mtime,ext');
  expect(rows).toHaveLength(fx.fileCount); // hardlink deduped, dot-folders kept
  const logical = rows.reduce((s, c) => s + Number(c[2]), 0);
  expect(logical).toBe(fx.expected);
  expect(rows.some(c => c[0].includes('.hidden'))).toBe(true);
  for (const c of rows) expect(Number(c[1])).toBeGreaterThanOrEqual(0);
});

test('CLI honours --exclude and --top, writes JSON and HTML', async () => {
  const fx = makeFixture();
  const dir = outDir();
  const json = path.join(dir, 'out.json');
  const html = path.join(dir, 'out.html');
  const r = runCli(['--scan', fx.root, '--exclude', 'node_modules', '--exclude', '*.zip', '--top', '2', '--export', json, '--export', html]);
  expect(r.status).toBe(0);
  const s = JSON.parse(fs.readFileSync(json, 'utf8'));
  expect(s.totalFiles).toBe(fx.fileCount - 2);
  expect(s.excludedCount).toBe(2);
  expect(s.largestFiles).toHaveLength(2);
  expect(s.largestFolders.length).toBeLessThanOrEqual(2);
  expect(s.largestFolders[0].path).toBe('big');
  expect(JSON.stringify([s.largestFolders, s.largestFiles])).not.toContain('node_modules');
  const h = fs.readFileSync(html, 'utf8');
  expect(h).toContain('<!doctype html>');
  expect(h).toContain('Largest folders');
});

test('CLI never modifies the scanned tree and exits non-zero on bad input', async () => {
  const fx = makeFixture();
  const snap = () => fs.readdirSync(fx.root, { recursive: true }).sort().join('|');
  const before = snap();
  const out = path.join(outDir(), 'x.csv');
  expect(runCli(['--scan', fx.root, '--export', out]).status).toBe(0);
  expect(snap()).toBe(before);

  expect(runCli(['--scan', path.join(fx.root, 'nope'), '--export', out]).status).toBe(1);
  expect(runCli(['--scan', fx.root]).status).toBe(2);
  expect(runCli(['--scan', fx.root, '--export', 'x.txt']).status).toBe(2);
  expect(runCli(['--scan', fx.root, '--export', out, '--delete']).status).toBe(2);
  const bad = runCli(['--scan', fx.root, '--export', path.join(os.tmpdir(), 'no-such-dir-sd', 'o.csv')]);
  expect(bad.status).toBe(1);
  expect(runCli(['--help']).stdout).toContain('Usage:');
});
