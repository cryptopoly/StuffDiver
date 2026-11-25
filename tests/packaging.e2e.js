const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// A module missing from build.files crashes the packaged app at startup while every
// source-run test still passes (quarantine.js once shipped like that). Walk the local
// require() graph from the entry points and require every file to be packaged.
test('every local module required at startup is listed in build.files', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = new Set(pkg.build.files);
  const seen = new Set();
  const missing = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (!files.has(rel)) missing.push(rel);
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
      let dep = m[1].replace(/^\.\//, '');
      if (!/\.[a-z]+$/i.test(dep)) dep += '.js';
      if (fs.existsSync(path.join(root, dep))) walk(dep);
    }
  };
  for (const entry of ['main.js', 'preload.js']) walk(entry);
  expect(missing).toEqual([]);
  for (const f of files) expect(fs.existsSync(path.join(root, f)), f + ' is listed but missing').toBe(true);
});
