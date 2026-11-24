const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cf = require('../cleanup-folders');
const { launch, scanViaUi } = require('./helpers');

const OLD = new Date(Date.now() - 90 * 86400000);
function mk(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (rel.endsWith('/')) { fs.mkdirSync(p, { recursive: true }); return p; }
  fs.writeFileSync(p, content === undefined ? 'x'.repeat(2048) : content);
  return p;
}
function age(root) { // make everything old so nothing counts as "recent"
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(f); try { fs.utimesSync(f, OLD, OLD); } catch (er) { /* ignore */ } } };
  walk(root);
}
function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cf-'))); }

// ---------- classifier (no Electron) ----------
test.describe('classifier', () => {
  let root;
  test.beforeEach(() => { root = tmp(); });
  test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const kind = (rel) => { const c = cf.classifyFolder(path.join(root, rel)); return c && (c.kind || ('refused:' + c.refused)); };

  test('accepts every allowlisted kind with its structural marker', () => {
    mk(root, 'a/package.json', '{}'); mk(root, 'a/node_modules/x/i.js');
    mk(root, 'b/__pycache__/m.cpython-311.pyc');
    mk(root, 'c/.pytest_cache/CACHEDIR.TAG');
    mk(root, 'd/.mypy_cache/CACHEDIR.TAG');
    mk(root, 'Library/Developer/Xcode/DerivedData/App-abc/x.o');
    mk(root, 'e/Cargo.toml'); mk(root, 'e/target/debug/x');
    mk(root, 'f/pom.xml'); mk(root, 'f/target/classes/x');
    mk(root, 'g/build.gradle'); mk(root, 'g/.gradle/x');
    mk(root, 'h/next.config.js'); mk(root, 'h/.next/cache/x');
    mk(root, 'i/nuxt.config.ts'); mk(root, 'i/.nuxt/x');
    mk(root, 'j/env/pyvenv.cfg'); mk(root, 'j/env/lib/x');
    expect(kind('a/node_modules')).toBe('node_modules');
    expect(kind('b/__pycache__')).toBe('pycache');
    expect(kind('c/.pytest_cache')).toBe('pytest_cache');
    expect(kind('d/.mypy_cache')).toBe('mypy_cache');
    expect(kind('Library/Developer/Xcode/DerivedData')).toBe('derived_data');
    expect(kind('e/target')).toBe('target');
    expect(kind('f/target')).toBe('target');
    expect(kind('g/.gradle')).toBe('gradle_cache');
    expect(kind('h/.next')).toBe('next');
    expect(kind('i/.nuxt')).toBe('nuxt');
    expect(kind('j/env')).toBe('venv');
  });

  test('rejects look-alikes: right name, wrong or missing marker', () => {
    mk(root, 'a/node_modules/x/i.js');                                  // no package.json
    mk(root, 'b/__pycache__/real.py');                                  // not bytecode
    mk(root, 'b2/__pycache__/');                                        // empty
    mk(root, 'c/.pytest_cache/other');                                  // no CACHEDIR.TAG
    mk(root, 'd/target/x');                                             // no Cargo.toml / pom.xml
    mk(root, 'e/.next/x');                                              // no next.config
    mk(root, 'f/.nuxt/x'); mk(root, 'f/next.config.js');               // wrong framework config
    mk(root, 'g/.gradle/x');                                            // no gradle build file
    mk(root, 'h/DerivedData/x');                                        // not under Library/Developer
    mk(root, 'i/venv/lib/x');                                           // no pyvenv.cfg
    for (const rel of ['a/node_modules', 'b/__pycache__', 'b2/__pycache__', 'c/.pytest_cache', 'd/target', 'e/.next', 'f/.nuxt', 'g/.gradle', 'h/DerivedData', 'i/venv']) {
      expect(kind(rel), rel).toBeNull();
    }
  });

  test('never classifies generic dist/build/.git/logs/.bak folders, even with markers around', () => {
    for (const n of ['dist', 'build', '.git', 'logs', 'old.bak', 'out', 'cache']) {
      mk(root, `p/package.json`, '{}'); mk(root, `p/Cargo.toml`, ''); mk(root, `p/${n}/x`);
      expect(kind(`p/${n}`), n).toBeNull();
    }
  });

  test('refuses a symlink to a folder and a plain file', () => {
    mk(root, 'real/package.json', '{}'); mk(root, 'real/node_modules/x');
    mk(root, 'p/package.json', '{}'); mk(root, 'p/node_modules', 'file, not folder');
    mk(root, 'q/package.json', '{}');
    fs.symlinkSync(path.join(root, 'real/node_modules'), path.join(root, 'q/node_modules'), 'dir');
    expect(kind('q/node_modules')).toMatch(/^refused:.*symlink/);
    expect(kind('p/node_modules')).toMatch(/^refused:.*not a folder/);
    expect(kind('missing/node_modules')).toMatch(/^refused:.*no longer exists/);
  });

  test('refuses a Windows junction', () => {
    test.skip(process.platform !== 'win32', 'junctions are Windows-only');
    mk(root, 'real/package.json', '{}'); mk(root, 'real/node_modules/x');
    mk(root, 'q/package.json', '{}');
    fs.symlinkSync(path.join(root, 'real/node_modules'), path.join(root, 'q/node_modules'), 'junction');
    expect(kind('q/node_modules')).toMatch(/^refused:/);
  });

  test('inspectFolder finds a nested .git dir or file and counts honestly', () => {
    mk(root, 'n/a.js'); mk(root, 'n/sub/b.js');
    let w = cf.inspectFolder(path.join(root, 'n'));
    expect(w).toMatchObject({ files: 2, git: null, error: null });
    expect(w.bytes).toBe(4096);
    mk(root, 'n/pkg/.git/HEAD');
    expect(cf.inspectFolder(path.join(root, 'n')).git).toContain('.git');
    fs.rmSync(path.join(root, 'n/pkg'), { recursive: true });
    mk(root, 'n/wt/.git', 'gitdir: /elsewhere');   // worktree/submodule pointer file
    expect(cf.inspectFolder(path.join(root, 'n')).git).toContain('.git');
  });

  test('dedupeNested keeps the outermost; findCandidates reports sizes, nesting and .git', () => {
    mk(root, 'p/package.json', '{}');
    mk(root, 'p/node_modules/a/index.js');
    mk(root, 'p/node_modules/a/node_modules/b/package.json', '{}');
    mk(root, 'p/node_modules/a/node_modules/b/node_modules/c/i.js');
    mk(root, 'q/package.json', '{}'); mk(root, 'q/node_modules/repo/.git/HEAD'); mk(root, 'q/node_modules/repo/i.js');
    mk(root, 'r/node_modules/x/i.js');   // no package.json: not a candidate
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { const s = fs.statSync(f); files.push({ path: f, name: e.name, size: s.size, mtime: s.mtimeMs }); } } };
    walk(root);
    const found = cf.findCandidates(files, root, false);
    const byRel = Object.fromEntries(found.map(c => [path.relative(root, c.path), c]));
    expect(Object.keys(byRel).sort()).toEqual([path.join('p', 'node_modules'), path.join('q', 'node_modules')]);
    expect(byRel[path.join('p', 'node_modules')]).toMatchObject({ kind: 'node_modules', files: 3, hasGit: false });
    expect(byRel[path.join('q', 'node_modules')].hasGit).toBe(true);
    const d = cf.dedupeNested(['/a/b/c', '/a/b', '/a/bc', '/a/b'], false);
    expect(d.kept.sort()).toEqual(['/a/b', '/a/bc']);
    expect(d.dropped).toEqual(['/a/b/c']);
  });
});

// ---------- app integration ----------
function project(root, name, extra = {}) {
  mk(root, `${name}/package.json`, '{}');
  mk(root, `${name}/node_modules/dep/index.js`);
  for (const [rel, c] of Object.entries(extra)) mk(root, `${name}/${rel}`, c);
}
async function withFolders(fn, { prepare, env } = {}) {
  const root = tmp();
  if (prepare) prepare(root);
  age(root);
  const { app, page, userData } = await launch(root, env);
  try { await scanViaUi(page); await fn({ app, page, root, userData }); }
  finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const readLog = (userData) => { try { return fs.readFileSync(path.join(userData, 'deletion-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
const del = (page, paths) => page.evaluate((p) => window.api.deleteFolders(p, 'test'), paths);

test('folder scan offers only marker-verified folders, with details and defaults', async () => {
  await withFolders(async ({ page, root }) => {
    const res = await page.evaluate(() => window.api.cleanupFoldersScan());
    const rel = res.candidates.map(c => c.relPath).sort();
    expect(rel).toEqual(['proj/node_modules', 'rust/target', 'venvs/env']);
    const nm = res.candidates.find(c => c.kind === 'node_modules');
    expect(nm).toMatchObject({ files: 1, defaultChecked: true, refused: null });
    expect(nm.size).toBeGreaterThan(0);
    expect(nm.reason).toMatch(/package\.json/);
    expect(nm.restore).toMatch(/npm install/);
    expect(res.candidates.find(c => c.kind === 'venv').defaultChecked).toBe(false); // venv: may hold hand-installed packages
    const cats = await page.evaluate(() => window.api.cleanupScan());
    expect(cats.find(c => c.id === 'node_modules')).toBeUndefined();
    expect(cats.find(c => c.id === 'git')).toBeUndefined();
  }, { prepare: (r) => {
    project(r, 'proj', { 'dist/out.js': 'x', 'build/o.js': 'x' });
    mk(r, 'lonely/node_modules/x/i.js');          // no package.json
    mk(r, 'rust/Cargo.toml', ''); mk(r, 'rust/target/debug/x');
    mk(r, 'venvs/env/pyvenv.cfg', ''); mk(r, 'venvs/env/lib/x');
    mk(r, 'misc/target/x'); mk(r, 'misc/.git/HEAD');
  } });
});

test('recently modified folders are unchecked by default', async () => {
  const root = tmp();
  project(root, 'fresh');             // not aged: modified just now
  project(root, 'stale'); age(path.join(root, 'stale'));
  const { app, page } = await launch(root);
  try {
    await scanViaUi(page);
    const res = await page.evaluate(() => window.api.cleanupFoldersScan());
    const fresh = res.candidates.find(c => c.relPath === 'fresh/node_modules');
    const stale = res.candidates.find(c => c.relPath === 'stale/node_modules');
    expect(fresh.defaultChecked).toBe(false);
    expect(fresh.warnings.join(' ')).toMatch(/modified today/);
    expect(stale.defaultChecked).toBe(true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a valid folder is moved as one unit and logged with category, size and file count', async () => {
  await withFolders(async ({ page, root, userData }) => {
    const target = path.join(root, 'proj/node_modules');
    const res = await del(page, [target]);
    expect(res.error).toBeUndefined();
    const entry = readLog(userData).find(e => e.path === target);
    expect(entry).toMatchObject({ type: 'folder', category: 'node_modules', source: 'test', files: 2 });
    expect(entry.size).toBeGreaterThan(0);
    expect(['trashed', 'failed']).toContain(entry.status);   // trash may be unavailable on CI
    if (entry.status === 'trashed') { expect(fs.existsSync(target)).toBe(false); expect(res.deleted).toBe(1); }
    expect(fs.existsSync(path.join(root, 'proj/package.json'))).toBe(true);
  }, { prepare: (r) => project(r, 'proj', { 'node_modules/dep/b.js': 'y' }) });
});

test('batch is all-or-nothing: one bad folder refuses everything, and every refusal is logged', async () => {
  await withFolders(async ({ page, root, userData }) => {
    const good = path.join(root, 'proj/node_modules');
    const hasGit = path.join(root, 'q/node_modules');
    const noMarker = path.join(root, 'lonely/node_modules');
    const generic = path.join(root, 'proj/dist');
    const res = await del(page, [good, hasGit, noMarker, generic]);
    expect(res.deleted).toBe(0);
    expect(res.error).toMatch(/nothing was moved/);
    expect(res.blocked.map(b => b.path).sort()).toEqual([hasGit, noMarker, generic].sort());
    expect(res.blocked.find(b => b.path === hasGit).reason).toMatch(/\.git/);
    expect(res.blocked.find(b => b.path === noMarker).reason).toMatch(/marker/);
    expect(fs.existsSync(good)).toBe(true);
    const log = readLog(userData).filter(e => e.status === 'blocked' && e.type === 'folder');
    expect(log.map(e => e.path).sort()).toEqual([hasGit, noMarker, generic].sort());
    expect(log.every(e => e.reason && e.source === 'test')).toBe(true);
    expect(readLog(userData).some(e => e.path === good)).toBe(false);
    // The scanned folder itself is refused (and an enclosing folder swallows nested ones, so test it alone).
    const rootRes = await del(page, [root]);
    expect(rootRes.deleted).toBe(0);
    expect(rootRes.blocked[0].reason).toMatch(/scanned/);
  }, { prepare: (r) => {
    project(r, 'proj', { 'dist/o.js': 'x' });
    project(r, 'q', { 'node_modules/repo/.git/HEAD': 'ref' });
    mk(r, 'lonely/node_modules/x/i.js');
  } });
});

test('a symlink to a folder is refused, and the real target is untouched', async () => {
  await withFolders(async ({ page, root }) => {
    const res = await del(page, [path.join(root, 'link-proj/node_modules')]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toMatch(/symlink/);
    expect(fs.existsSync(path.join(root, 'proj/node_modules/dep/index.js'))).toBe(true);
  }, { prepare: (r) => {
    project(r, 'proj'); mk(r, 'link-proj/package.json', '{}');
    fs.symlinkSync(path.join(r, 'proj/node_modules'), path.join(r, 'link-proj/node_modules'), 'dir');
  } });
});

test('TOCTOU: folder swapped for a symlink after the scan is refused', async () => {
  await withFolders(async ({ page, root, userData }) => {
    const target = path.join(root, 'proj/node_modules');
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(scan.candidates.some(c => c.path === target && !c.refused)).toBe(true);
    // Attacker/race: replace the scanned folder by a link to precious data.
    fs.rmSync(target, { recursive: true });
    fs.symlinkSync(path.join(root, 'precious'), target, 'dir');
    const res = await del(page, [target]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toMatch(/symlink/);
    expect(fs.existsSync(path.join(root, 'precious/family.jpg'))).toBe(true);
    expect(readLog(userData).find(e => e.path === target)).toMatchObject({ status: 'blocked' });
  }, { prepare: (r) => { project(r, 'proj'); mk(r, 'precious/family.jpg'); } });
});

test('TOCTOU: ancestor swapped for a symlink after the scan is refused', async () => {
  await withFolders(async ({ page, root }) => {
    const target = path.join(root, 'proj/node_modules');
    await page.evaluate(() => window.api.cleanupFoldersScan());
    fs.renameSync(path.join(root, 'proj'), path.join(root, 'moved'));
    fs.symlinkSync(path.join(root, 'decoy'), path.join(root, 'proj'), 'dir');
    const res = await del(page, [target]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toMatch(/different location|symlink/);
    expect(fs.existsSync(path.join(root, 'decoy/node_modules/keep.txt'))).toBe(true);
  }, { prepare: (r) => { project(r, 'proj'); mk(r, 'decoy/package.json', '{}'); mk(r, 'decoy/node_modules/keep.txt'); } });
});

test('TOCTOU: marker removed or .git added after the scan is refused', async () => {
  await withFolders(async ({ page, root }) => {
    const a = path.join(root, 'a/node_modules'), b = path.join(root, 'b/node_modules');
    await page.evaluate(() => window.api.cleanupFoldersScan());
    fs.unlinkSync(path.join(root, 'a/package.json'));
    mk(root, 'b/node_modules/dep/.git/HEAD', 'ref');
    const ra = await del(page, [a]);
    expect(ra.deleted).toBe(0); expect(ra.blocked[0].reason).toMatch(/marker/);
    const rb = await del(page, [b]);
    expect(rb.deleted).toBe(0); expect(rb.blocked[0].reason).toMatch(/\.git/);
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
  }, { prepare: (r) => { project(r, 'a'); project(r, 'b'); } });
});

test('a folder that contains a protected location (fake ~/.ssh under overridden HOME) is refused', async () => {
  const root = tmp();
  project(root, 'proj');
  const fakeHome = path.join(root, 'proj/node_modules/fakehome');
  mk(root, 'proj/node_modules/fakehome/.ssh/id_rsa', 'PRIVATE KEY');
  age(root);
  const { app, page, userData } = await launch(root, { HOME: fakeHome, USERPROFILE: fakeHome });
  try {
    await scanViaUi(page);
    const target = path.join(root, 'proj/node_modules');
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    const cand = scan.candidates.find(c => c.path === target);
    expect(cand.refused).toMatch(/contains/);
    expect(cand.defaultChecked).toBe(false);
    const res = await del(page, [target]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toMatch(/contains/);
    expect(fs.existsSync(path.join(fakeHome, '.ssh/id_rsa'))).toBe(true);
    expect(readLog(userData).some(e => e.status === 'blocked' && e.path === target)).toBe(true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a folder containing a protected folder deeper down (e.g. a Documents folder in a fake home) is refused', async () => {
  const root = tmp();
  project(root, 'proj');
  const fakeHome = path.join(root, 'proj/node_modules/h');
  mk(root, 'proj/node_modules/h/Documents/thesis.txt', 'precious');
  age(root);
  const { app, page } = await launch(root, { HOME: fakeHome, USERPROFILE: fakeHome });
  try {
    await scanViaUi(page);
    const res = await del(page, [path.join(root, 'proj/node_modules')]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toMatch(/contains/);
    expect(fs.existsSync(path.join(fakeHome, 'Documents/thesis.txt'))).toBe(true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('nested selections are deduped to the outermost; oversized batches and junk input are refused', async () => {
  await withFolders(async ({ page, root }) => {
    const outer = path.join(root, 'proj/node_modules');
    const inner = path.join(outer, 'dep/node_modules');
    const res = await del(page, [inner, outer]);
    expect(res.error).toBeUndefined();
    expect(res.dedupedNested).toEqual([inner]);
    expect(res.deleted + (res.failed || []).length).toBe(1);

    const many = Array.from({ length: 501 }, (_, i) => path.join(root, `n${i}/node_modules`));
    const big = await del(page, many);
    expect(big.deleted).toBe(0);
    expect(big.error).toMatch(/501.*limit is 500/);
    const junk = await page.evaluate(() => window.api.deleteFolders([42], 'test'));
    expect(junk.error).toMatch(/invalid/i);
    const outside = await del(page, [path.join(os.tmpdir(), 'not-scanned/node_modules')]);
    expect(outside.deleted).toBe(0);
    expect(outside.blocked[0].reason).toMatch(/outside the scanned folder/);
  }, { prepare: (r) => { project(r, 'proj', { 'node_modules/dep/node_modules/x/package.json': '{}' }); } });
});

test('wizard shows folder rows with size/age/files/reason, greys out refused ones, and cleans selected', async () => {
  await withFolders(async ({ page, root }) => {
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    const body = page.locator('#cleanup-body');
    await expect(body).toContainText('Folders you can regenerate');
    const ok = page.locator('.cleanup-folder', { hasText: 'proj/node_modules' });
    await expect(ok).toContainText('node_modules next to package.json');
    await expect(ok).toContainText('files');
    await expect(ok).toContainText('last modified');
    await expect(ok).toContainText('If you restore or regenerate');
    await expect(ok.locator('input')).toBeChecked();
    const git = page.locator('.cleanup-folder', { hasText: 'q/node_modules' });
    await expect(git).toHaveClass(/cleanup-refused/);
    await expect(git.locator('input')).toBeDisabled();
    await expect(git).toContainText('Not offered');
    await expect(git).toContainText('.git');
    await expect(page.locator('#cleanup-folder-total')).toContainText('1 folder');
    await page.locator('#cleanup-folders-execute').click();
    // trash may be unavailable on CI, so assert on the log; the untouched repo folder must survive either way
    await expect.poll(async () => (await page.evaluate(() => window.api.queryDeletionLog({ search: 'smart-cleanup-folders' }))).matched).toBe(1);
    expect(fs.existsSync(path.join(root, 'q/node_modules/repo/.git/HEAD'))).toBe(true);
  }, { prepare: (r) => { project(r, 'proj'); project(r, 'q', { 'node_modules/repo/.git/HEAD': 'ref' }); } });
});

// ---------- deletion log viewer ----------
async function openLog(page) {
  await page.locator('#tools-btn').click();
  await page.locator('[data-tool="dellog"]').click();
  await expect(page.locator('#dellog-overlay')).toBeVisible();
}
function seedLog(userData, n) {
  const statuses = ['trashed', 'failed', 'blocked'];
  const lines = [];
  for (let i = 0; i < n; i++) {
    const status = statuses[i % 3];
    lines.push(JSON.stringify({ t: 1700000000000 + i * 1000, path: `/data/item-${i}${i === 7 ? '-special' : ''}`, size: 1000 + i, status, source: i % 2 ? 'collector' : 'smart-cleanup', ...(status !== 'trashed' ? { reason: status === 'blocked' ? 'is your home folder' : 'EPERM nope' } : {}) }));
  }
  fs.writeFileSync(path.join(userData, 'deletion-log.jsonl'), lines.join('\n') + '\n');
}

test('deletion log viewer: empty state, then entries newest-first with filters, search, paging and copy', async () => {
  const root = tmp(); mk(root, 'a.txt');
  const { app, page, userData } = await launch(root);
  try {
    await openLog(page);
    await expect(page.locator('#dellog-empty')).toHaveText('No deletions recorded yet.');
    await expect(page.locator('.dellog-row')).toHaveCount(0);
    await expect(page.locator('.dellog-restore')).toContainText('Put Back');
    await expect(page.locator('.dellog-restore')).toContainText('Recycle Bin');
    await expect(page.locator('#dellog-reveal')).toBeVisible();
    await page.locator('#dellog-close').click();

    seedLog(userData, 450);
    await openLog(page);
    await expect(page.locator('.dellog-row')).toHaveCount(200);
    await expect(page.locator('.dellog-row').first()).toContainText('/data/item-449');   // newest first
    await expect(page.locator('#dellog-summary')).toContainText('450 total');
    await page.locator('#dellog-more').click();
    await expect(page.locator('.dellog-row')).toHaveCount(400);
    await page.locator('#dellog-more').click();
    await expect(page.locator('.dellog-row')).toHaveCount(450);
    await expect(page.locator('#dellog-more')).toBeHidden();

    await page.locator('#dellog-status').selectOption('blocked');
    await expect(page.locator('.dellog-row')).toHaveCount(150);
    await expect(page.locator('.dellog-badge.dellog-blocked').first()).toBeVisible();
    await expect(page.locator('.dellog-row').first()).toContainText('is your home folder');
    await page.locator('#dellog-status').selectOption('');

    await page.locator('#dellog-search').fill('special');
    await expect(page.locator('.dellog-row')).toHaveCount(1);
    await expect(page.locator('.dellog-row')).toContainText('/data/item-7-special');
    await page.locator('#dellog-search').fill('no-such-thing-xyz');
    await expect(page.locator('#dellog-empty')).toHaveText('No entries match the current filter.');

    await page.locator('#dellog-search').fill('special');
    await expect(page.locator('.dellog-row')).toHaveCount(1);
    await page.context().grantPermissions?.(['clipboard-read', 'clipboard-write']).catch(() => {});
    await page.locator('.dellog-copy').click();
    await expect(page.locator('.dellog-copy')).toHaveText(/Copied|Copy path/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#dellog-overlay')).toBeHidden();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('query-deletion-log IPC filters, pages and counts', async () => {
  const root = tmp(); mk(root, 'a.txt');
  const { app, page, userData } = await launch(root);
  try {
    seedLog(userData, 30);
    fs.appendFileSync(path.join(userData, 'deletion-log.jsonl'), 'not json\n');
    const r = await page.evaluate(() => window.api.queryDeletionLog({ status: 'failed', limit: 4, offset: 2 }));
    expect(r).toMatchObject({ matched: 10, total: 30, counts: { trashed: 10, failed: 10, blocked: 10 } });
    expect(r.entries).toHaveLength(4);
    expect(r.entries.every(e => e.status === 'failed')).toBe(true);
    const bogus = await page.evaluate(() => window.api.queryDeletionLog({ status: 'weird', limit: 99999 }));
    expect(bogus.matched).toBe(30);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
