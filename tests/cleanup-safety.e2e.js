// Regression tests for the adversarial-review findings (see numbered comments).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cf = require('../cleanup-folders');
const { launch, scanViaUi, fixtureParent, linkOrSkip, autoMarkers } = require('./helpers');
const link = (target, p, type) => linkOrSkip(test, target, p, type);

const OLD = new Date(Date.now() - 90 * 86400000);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(fixtureParent(), 'sd-cs-')));
function mk(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (rel.endsWith('/')) { fs.mkdirSync(p, { recursive: true }); return p; }
  fs.writeFileSync(p, content === undefined ? 'x'.repeat(2048) : content);
  autoMarkers(root, rel);
  return p;
}
function age(root) {
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(f); try { fs.utimesSync(f, OLD, OLD); } catch (er) { /* ignore */ } } };
  walk(root);
}
const proj = (root, rel) => { mk(root, `${rel}/package.json`, '{}'); mk(root, `${rel}/package-lock.json`, '{}'); mk(root, `${rel}/node_modules/dep/index.js`); };
const readLog = (userData, f = 'deletion-log.jsonl') => { try { return fs.readFileSync(path.join(userData, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
async function withApp(prep, env, fn) {
  const root = tmp();
  prep(root); age(root);
  const { app, page, userData } = await launch(root, env);
  try { await scanViaUi(page); await fn({ app, page, root, userData }); }
  finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const del = (page, p) => page.evaluate((x) => window.api.deleteFolders(x, 'test'), p);
const cls = (dir) => { const c = cf.classifyFolder(dir); return c && (c.kind || 'refused:' + c.refused); };

test.describe('1. node_modules of installed tools and apps is never offered', () => {
  let root;
  test.beforeEach(() => { root = tmp(); });
  test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = (rel) => { mk(root, `${rel}/package.json`, '{}'); mk(root, `${rel}/package-lock.json`, '{}'); mk(root, `${rel}/node_modules/x/i.js`); return path.join(root, rel, 'node_modules'); };

  test('ancestor node_modules (npm inside nvm, nested deps)', () => {
    const d = installed('.nvm/versions/node/v20/lib/node_modules/npm');
    expect(cls(d)).toBe('refused:is inside another node_modules (an installed package, not your project)');
    const n = installed('proj/node_modules/dep');
    expect(cls(n)).toMatch(/^refused:is inside another node_modules/);
  });
  test('installed-tool and app locations', () => {
    expect(cls(installed('.vscode/extensions/ms.python-1/x'))).toMatch(/^refused:is inside \.vscode/);
    expect(cls(installed('.cursor/extensions/x'))).toMatch(/^refused:is inside \.cursor/);
    expect(cls(installed('.volta/tools/x'))).toMatch(/^refused:is inside \.volta/);
    expect(cls(installed('Foo.app/Contents/Resources/app'))).toBe('refused:is inside an application bundle');
    expect(cls(installed('AppData/Local/Programs/Thing/resources/app'))).toBe('refused:is inside an installed Windows program');
  });
  test('system, server and global locations (path rules)', () => {
    for (const [p, re] of [
      ['/opt/homebrew/lib/node_modules/npm/node_modules', /node_modules/],
      ['/opt/app/node_modules', /under \/opt/], ['/srv/app/node_modules', /under \/srv/], ['/var/www/app/node_modules', /under \/var\/www/],
      ['/usr/local/lib/node_modules/x/node_modules', /node_modules|\/usr/], ['/snap/x/current/node_modules', /under \/snap/],
      ['C:\\Program Files\\App\\resources\\app\\node_modules', /Windows system or program folder/],
      ['C:\\Users\\bob\\AppData\\Roaming\\npm\\node_modules', /global npm/]
    ]) expect(cf.blockedLocation(p, { uid: 501, home: '/Users/bob' }), p).toMatch(re);
    expect(cf.blockedLocation('/Users/bob/work/app/node_modules', { uid: 501, home: '/Users/bob' })).toBeNull();
  });
  test('a lockfile is required next to package.json', () => {
    mk(root, 'nolock/package.json', '{}'); mk(root, 'nolock/node_modules/x/i.js');
    expect(cls(path.join(root, 'nolock/node_modules'))).toBeNull();
    for (const lock of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']) {
      mk(root, `l-${lock}/package.json`, '{}'); mk(root, `l-${lock}/${lock}`, ''); mk(root, `l-${lock}/node_modules/x`);
      expect(cls(path.join(root, `l-${lock}/node_modules`)), lock).toBe('node_modules');
    }
  });
});

test('3. a project folder turned into a venv (python -m venv .) and tool-managed envs are not offered', () => {
  const root = tmp();
  try {
    mk(root, 'proj/pyvenv.cfg', ''); mk(root, 'proj/src/app.py'); mk(root, 'proj/bin/python'); mk(root, 'proj/lib/x');
    expect(cls(path.join(root, 'proj'))).toBeNull();
    mk(root, 'real/pyvenv.cfg', ''); mk(root, 'real/bin/python'); mk(root, 'real/lib/x'); mk(root, 'real/.gitignore', '*');
    expect(cls(path.join(root, 'real'))).toBe('venv');
    mk(root, 'withdoc/pyvenv.cfg', ''); mk(root, 'withdoc/lib/x'); mk(root, 'withdoc/thesis.docx');
    expect(cls(path.join(root, 'withdoc'))).toBeNull();
    for (const p of ['/h/.local/pipx/venvs/black', '/h/.pyenv/versions/3.11/envs/x', '/h/miniconda3/envs/ml', '/h/anaconda3/envs/ml'])
      expect(cf.blockedLocation(p, { uid: 501, home: '/h' }), p).toMatch(/holds installed tools/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('4. folders directly in a home folder are not offered (~/.gradle, ~/node_modules)', async () => {
  const root = tmp();
  const home = path.join(root, 'h');
  mk(home, 'build.gradle', ''); mk(home, '.gradle/gradle.properties', 'signing.password=secret'); mk(home, '.gradle/caches/x');
  mk(home, 'package.json', '{}'); mk(home, 'package-lock.json', '{}'); mk(home, 'node_modules/x/i.js');
  proj(home, 'work/app');
  age(root);
  const { app, page } = await launch(root, { HOME: home, USERPROFILE: home });
  try {
    await scanViaUi(page);
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(scan.candidates.map(c => c.path)).toEqual([path.join(home, 'work/app/node_modules')]);
    expect(cf.blockedLocation(path.join(home, '.gradle'), { uid: 501, home })).toBe('sits directly in a user home folder, not in a project');
    expect(cf.blockedLocation('/Users/other/node_modules', { uid: 501, home })).toBe('sits directly in a user home folder, not in a project');
    // direct delete attempts are refused for the same reason, and the credentials file is protected
    const res = await del(page, [path.join(home, 'node_modules')]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toBe('sits directly in a user home folder, not in a project');
    for (const f of ['.gradle/gradle.properties']) {
      const r = await page.evaluate((x) => window.api.deleteFiles([x], 'test'), path.join(home, f));
      expect(r.blocked[0].reason).toBe('a credentials or keychain location');
    }
    // every credential file name is in the protected list
    for (const f of ['.m2/settings.xml', '.npmrc', '.pypirc', '.netrc', '.config/gh/hosts.yml', '.docker/config.json', '.git-credentials', '.terraform.d/credentials.tfrc.json']) {
      const r = await page.evaluate((x) => window.api.deleteFiles([x], 'test'), path.join(home, f));
      expect(r.blocked && r.blocked[0].reason, f).toBe('a credentials or keychain location');
    }
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('5. running as root refuses folders outside home folders; /opt /srv /var/www never offered', () => {
  expect(cf.blockedLocation('/data/proj/node_modules', { uid: 0, home: '/root' })).toBe('is outside home folders and this app is running as root/administrator');
  expect(cf.blockedLocation('/data/proj/node_modules', { uid: 501, home: '/Users/a' })).toBeNull();
  expect(cf.blockedLocation('/home/alice/proj/node_modules', { uid: 0, home: '/root' })).toBeNull();
  expect(cf.blockedLocation('/root/proj/node_modules', { uid: 0, home: '/root' })).toBeNull();
  for (const p of ['/opt/app/node_modules', '/srv/app/node_modules', '/var/www/app/node_modules', '/usr/local/app/node_modules'])
    expect(cf.blockedLocation(p, { uid: 501, home: '/Users/a' }), p).toMatch(/holds system or server software/);
});

test('6. __pycache__ must hold only regular .pyc files (no sneaky.pyc folder, no links)', () => {
  const root = tmp();
  try {
    mk(root, 'a/__pycache__/ok.cpython-311.pyc');
    expect(cls(path.join(root, 'a/__pycache__'))).toBe('pycache');
    mk(root, 'b/__pycache__/sneaky.pyc/thesis.docx');
    expect(cls(path.join(root, 'b/__pycache__'))).toBeNull();
    mk(root, 'c/real.txt'); fs.mkdirSync(path.join(root, 'c/__pycache__'));
    link(path.join(root, 'c/real.txt'), path.join(root, 'c/__pycache__/link.pyc'));
    expect(cls(path.join(root, 'c/__pycache__'))).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('12. markers are exact and case-sensitive (PACKAGE.JSON / uppercase lockfile do not count)', () => {
  const root = tmp();
  try {
    mk(root, 'a/PACKAGE.JSON', '{}'); mk(root, 'a/package-lock.json', '{}'); mk(root, 'a/node_modules/x');
    mk(root, 'b/package.json', '{}'); mk(root, 'b/PACKAGE-LOCK.JSON', '{}'); mk(root, 'b/node_modules/x');
    mk(root, 'c/CARGO.TOML', ''); mk(root, 'c/target/x');
    mk(root, 'd/package.json', '{}'); mk(root, 'd/package-lock.json', '{}'); mk(root, 'd/node_modules/x');
    for (const r of ['a/node_modules', 'b/node_modules', 'c/target']) expect(cls(path.join(root, r)), r).toBeNull();
    expect(cls(path.join(root, 'd/node_modules'))).toBe('node_modules');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('2. loose-file presets never match LevelDB logs, .bak/.old/.swp or dist; only .DS_Store/thumbs are pre-ticked', async () => {
  await withApp((r) => {
    mk(r, 'Library/Application Support/Chrome/Default/Local Extension Settings/abc/000003.log');
    mk(r, 'Library/Application Support/Slack/IndexedDB/x/000004.log');
    mk(r, 'Library/Application Support/Code/Local Storage/leveldb/000005.log');
    mk(r, 'Library/Application Support/App/state.log');
    mk(r, 'Library/Application Support/App/logs/app.log');
    mk(r, 'Library/Logs/thing.log');
    mk(r, 'work/backup.sql.bak'); mk(r, 'work/old.old'); mk(r, 'work/notes.swp'); mk(r, 'work/x.tmp');
    mk(r, 'site/dist/index.html'); mk(r, 'site/build/x.js');
    mk(r, 'junk/.DS_Store'); mk(r, 'junk/Thumbs.db');
  }, {}, async ({ page, root }) => {
    const cats = await page.evaluate(() => window.api.cleanupScan());
    const rel = (c) => (c ? c.paths.map(p => path.relative(root, p).split(path.sep).join('/')).sort() : []);
    const byId = Object.fromEntries(cats.map(c => [c.id, c]));
    expect(rel(byId.logs)).toEqual(['Library/Application Support/App/logs/app.log', 'Library/Logs/thing.log']);
    expect(rel(byId.temp)).toEqual(['work/x.tmp']);
    expect(byId.build).toBeUndefined();
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('#cleanup-body')).toContainText('Log files');
    const ticked = await page.locator('.cleanup-check:checked').evaluateAll(els => els.map(e => e.dataset.id).sort());
    expect(ticked).toEqual(['dsstore', 'thumbs']);
    expect(await page.locator('.cleanup-check').count()).toBeGreaterThan(2);
  });
});

test('7. delete-files refuses folders (and links to folders); a link to a file is trashed as a link', async () => {
  await withApp((r) => {
    mk(r, 'repo/.git/HEAD'); mk(r, 'repo/src/a.js'); mk(r, 'plain/a.txt');
    mk(r, 'f/real.txt'); link(path.join(r, 'plain'), path.join(r, 'f/dirlink'), 'dir'); link(path.join(r, 'f/real.txt'), path.join(r, 'f/filelink'));
  }, {}, async ({ page, root, userData }) => {
    const call = (p) => page.evaluate((x) => window.api.deleteFiles(x, 'test'), p);
    const a = await call([path.join(root, 'plain/a.txt'), path.join(root, 'repo')]);
    expect(a.deleted).toBe(0);
    expect(a.blocked).toHaveLength(1);
    expect(a.blocked[0].reason).toMatch(/^a folder, not a file/);
    expect(a.error).toMatch(/Nothing was moved/);
    expect(fs.existsSync(path.join(root, 'repo/.git/HEAD')) && fs.existsSync(path.join(root, 'plain/a.txt'))).toBe(true);
    const b = await call([path.join(root, 'f/dirlink')]);
    expect(b.deleted).toBe(0);
    expect(b.blocked[0].reason).toMatch(/^a link to a folder/);
    expect(fs.existsSync(path.join(root, 'plain/a.txt'))).toBe(true);
    expect(readLog(userData).filter(e => e.status === 'blocked').map(e => path.basename(e.path)).sort()).toEqual(['dirlink', 'repo']);
    const c = await call([path.join(root, 'f/filelink')]);
    expect(c.error).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'f/real.txt'))).toBe(true); // the target is never touched
  });
});

test('8. every folder is fully re-verified immediately before its own trash call', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); mk(r, 'precious/family.jpg'); }, {}, async ({ app, page, root, userData }) => {
    const a = path.join(root, 'a/node_modules'), b = path.join(root, 'b/node_modules');
    // Test hook (E2E only): when the first folder is about to be processed, swap the second one for a symlink.
    await app.evaluate((_e, args) => {
      const fsx = global.__e2eRequire('fs');
      global.__e2eBeforeTrash = (p) => {
        if (p === args.a) { fsx.rmSync(args.b, { recursive: true }); fsx.symlinkSync(args.precious, args.b, process.platform === 'win32' ? 'junction' : 'dir'); }
      };
    }, { a, b, precious: path.join(root, 'precious') });
    const res = await del(page, [a, b]);
    expect(res.failed).toContain(b);
    expect(res.deletedPaths).not.toContain(b);
    expect(fs.existsSync(path.join(root, 'precious/family.jpg'))).toBe(true);
    const e = readLog(userData).find(x => x.path === b);
    expect(e.status).toBe('blocked');
    expect(e.reason).toMatch(/^changed just before delete: is a symlink/);
  });
});

test('10. log is written per item, write errors are surfaced, and it rotates at ~20 MB', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, {}, async ({ page, root, userData }) => {
    const logFile = path.join(userData, 'deletion-log.jsonl');
    // rotation: seed an oversized log
    const line = JSON.stringify({ t: 1, path: '/old/' + 'x'.repeat(900), status: 'trashed', source: 'seed' }) + '\n';
    fs.writeFileSync(logFile, line.repeat(Math.ceil(21 * 1024 * 1024 / line.length)));
    const r1 = await del(page, [path.join(root, 'a/node_modules')]);
    expect(r1.error).toBeUndefined();
    expect(fs.existsSync(logFile + '.1')).toBe(true);
    expect(readLog(userData).filter(e => e.source === 'seed')).toHaveLength(0);
    expect(readLog(userData)).toHaveLength(1);
    const q = await page.evaluate(() => window.api.queryDeletionLog({ file: 1, limit: 5 }));
    expect(q.rotated).toEqual([1]);
    expect(q.entries[0].source).toBe('seed');
    expect(q.total).toBeGreaterThan(20000);
    // write failure is reported to the caller instead of being swallowed
    fs.rmSync(logFile); fs.rmSync(logFile + '.1');
    fs.mkdirSync(logFile);
    const r2 = await del(page, [path.join(root, 'b/node_modules')]);
    expect(r2.logError).toMatch(/Could not write the deletion log/);
  });
});

test('10b. an existing log far larger than the read cap still opens (tail only)', async () => {
  await withApp((r) => mk(r, 'a.txt'), {}, async ({ page, userData }) => {
    const logFile = path.join(userData, 'deletion-log.jsonl');
    const chunk = (JSON.stringify({ t: 1, path: '/p/' + 'y'.repeat(1000), status: 'blocked', source: 'big' }) + '\n').repeat(10000);
    const fd = fs.openSync(logFile, 'w');
    for (let i = 0; i < 4; i++) fs.writeSync(fd, chunk); // ~40 MB
    fs.closeSync(fd);
    const q = await page.evaluate(() => window.api.queryDeletionLog({ limit: 3 }));
    expect(q.total).toBeGreaterThan(10000);
    expect(q.entries).toHaveLength(3);
    const again = await page.evaluate(() => window.api.queryDeletionLog({ limit: 3, search: 'big' }));
    expect(again.matched).toBe(q.total);
  });
});

test('11. wizard and log viewer escape every interpolated value', async () => {
  test.skip(process.platform === 'win32', 'file names with < are invalid on Windows');
  await withApp((r) => { proj(r, 'p<i id="inj">x</i>'); }, {}, async ({ page, userData }) => {
    fs.writeFileSync(path.join(userData, 'deletion-log.jsonl'), JSON.stringify({
      t: 1, path: '<img id="inj2" src=x onerror="window.__pwn=1">', status: 'trashed', source: '<b id="inj3">s</b>', reason: '<u id="inj4">r</u>', size: '<b id="inj5">1</b>', files: '<b id="inj6">2</b>', type: 'folder'
    }) + '\n');
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('#cleanup-body')).toContainText('p<i id="inj">x</i>/node_modules');
    expect(await page.locator('#cleanup-body #inj').count()).toBe(0);
    await page.locator('#cleanup-close').click();
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="dellog"]').click();
    await expect(page.locator('.dellog-row')).toHaveCount(1);
    await expect(page.locator('.dellog-row')).toContainText('<img id="inj2"');
    for (const id of ['inj2', 'inj3', 'inj4', 'inj5', 'inj6']) expect(await page.locator('#' + id).count(), id).toBe(0);
    expect(await page.evaluate(() => window.__pwn)).toBeUndefined();
  });
});

// ---- second review round ----
function fakeMountFs(mountSuffix) {
  // Real fs, except directories whose path ends with mountSuffix report a different device (a mount point).
  return {
    readdirSync: fs.readdirSync, statSync: fs.statSync,
    lstatSync: (p, o) => {
      const st = fs.lstatSync(p, o);
      if (!String(p).endsWith(mountSuffix)) return st;
      return new Proxy(st, { get: (t, k) => k === 'dev' ? (o && o.bigint ? t.dev + 1n : t.dev + 1) : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    }
  };
}

test('A. a mount point inside a candidate refuses it (walk and scan-time check)', async () => {
  const root = tmp();
  try {
    proj(root, 'p'); mk(root, 'p/node_modules/pkg/mnt/data.db');
    const dir = path.join(root, 'p/node_modules');
    expect((await cf.inspectFolder(dir)).error).toBeNull();
    const w = await cf.inspectFolder(dir, fakeMountFs(path.join('pkg', 'mnt')));
    expect(w.error).toBe(`contains ${path.join(dir, 'pkg/mnt')}, which is on a different filesystem or a mount point`);
    const files = [{ path: path.join(dir, 'pkg/mnt/data.db'), name: 'data.db', size: 1, mtime: 1 }, { path: path.join(dir, 'dep/index.js'), name: 'index.js', size: 1, mtime: 1 }];
    const found = cf.findCandidates(files, root, false, fakeMountFs(path.join('pkg', 'mnt')));
    expect(found[0].refusedReason).toMatch(/different filesystem or a mount point/);
    expect(cf.findCandidates(files, root, false)[0].refusedReason).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('A. Windows: a directory link/junction anywhere inside is refused; file links are fine', async () => {
  const root = tmp();
  try {
    proj(root, 'p'); mk(root, 'other/x.txt'); mk(root, 'p/node_modules/dep/real.txt');
    const dir = path.join(root, 'p/node_modules');
    link(path.join(root, 'p/node_modules/dep/real.txt'), path.join(dir, 'filelink'));
    expect((await cf.inspectFolder(dir, fs, true)).error).toBeNull();
    link(path.join(root, 'other'), path.join(dir, 'dep/dirlink'), 'dir');
    expect((await cf.inspectFolder(dir, fs, true)).error).toBe(`contains ${path.join(dir, 'dep/dirlink')}, a junction or directory link`);
    expect((await cf.inspectFolder(dir, fs, false)).error).toBeNull(); // POSIX: symlinks are not followed, so they are harmless
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('A. the app refuses a folder with a (simulated) mount inside, at scan and delete time', async () => {
  await withApp((r) => { proj(r, 'p'); mk(r, 'p/node_modules/pkg/mnt/data.db'); proj(r, 'ok'); }, {}, async ({ app, page, root, userData }) => {
    await app.evaluate(() => {
      const fsx = global.__e2eRequire('fs');
      global.__e2eFs = {
        readdirSync: fsx.readdirSync, statSync: fsx.statSync,
        lstatSync: (p, o) => { const st = fsx.lstatSync(p, o); return String(p).endsWith('mnt') ? new Proxy(st, { get: (t, k) => k === 'dev' ? t.dev + 1n : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : st; }
      };
    });
    const target = path.join(root, 'p/node_modules');
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    const c = scan.candidates.find(x => x.path === target);
    expect(c.refused).toMatch(/different filesystem or a mount point/);
    expect(c.defaultChecked).toBe(false);
    expect(scan.candidates.find(x => x.relPath === 'ok/node_modules').refused).toBeNull();
    const res = await del(page, [target]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toMatch(/different filesystem or a mount point/);
    expect(fs.existsSync(path.join(target, 'pkg/mnt/data.db'))).toBe(true);
    expect(readLog(userData).find(e => e.path === target).status).toBe('blocked');
  });
});

test('B. relative paths are refused by delete-folders and delete-files', async () => {
  await withApp((r) => { proj(r, 'p'); mk(r, 'p/a.txt'); }, {}, async ({ page, root }) => {
    const f = await page.evaluate(() => window.api.deleteFolders(['p/node_modules', './x'], 'test'));
    expect(f.deleted).toBe(0);
    expect(f.error).toMatch(/must be absolute/);
    const g = await page.evaluate(() => window.api.deleteFiles(['p/a.txt'], 'test'));
    expect(g.deleted).toBe(0);
    expect(g.error).toMatch(/must be absolute/);
    expect(fs.existsSync(path.join(root, 'p/a.txt'))).toBe(true);
  });
});

test('D. log entry without a path renders a placeholder; unreadable candidates are listed as refused', async () => {
  test.skip(process.platform === 'win32' || (process.getuid && process.getuid() === 0), 'needs chmod semantics');
  await withApp((r) => { proj(r, 'p'); proj(r, 'q'); }, {}, async ({ page, root, userData }) => {
    const locked = path.join(root, 'q/node_modules');
    fs.chmodSync(locked, 0o000);
    try {
      const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
      expect(scan.candidates.find(c => c.path === locked).refused).toMatch(/^cannot be read \(EACCES\)/);
    } finally { fs.chmodSync(locked, 0o755); }
    fs.writeFileSync(path.join(userData, 'deletion-log.jsonl'), JSON.stringify({ t: 1, status: 'failed', source: 'x' }) + '\n');
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="dellog"]').click();
    await expect(page.locator('.dellog-row')).toContainText('(no path recorded)');
    await expect(page.locator('.dellog-row')).not.toContainText('undefined');
  });
});

// ---- third review round ----
const catPaths = (cats, root) => Object.fromEntries(cats.map(c => [c.id, c.paths.map(p => path.relative(root, p).split(path.sep).join('/')).sort()]));

test('R3-1/6. file presets use whole-name anchors and offer only clearly regenerable files', async () => {
  await withApp((r) => {
    mk(r, 'art/Desktop.ini-backup/design.psd'); mk(r, 'docs/my.Spotlight.project/plan.docx'); mk(r, 'photos/MyThumbs.dbs/IMG_1.jpg');
    mk(r, 'x/notThumbs.db'); mk(r, 'x/my.DS_Store'); mk(r, 'x/old.DS_Store.bak');
    mk(r, 'ok/Thumbs.db'); mk(r, 'ok/desktop.ini'); mk(r, 'ok/.DS_Store');
    mk(r, 'vol/.Spotlight-V100/x'); mk(r, 'vol/.Trashes/501/x');
    mk(r, 'data/memory.dmp'); mk(r, 'sys/CrashDumps/a.dmp'); mk(r, 'sys/Crashpad/b.dmp');
    mk(r, '.lmstudio/models/me/model.gguf'); mk(r, '.cache/huggingface/hub/x.bin'); 
    mk(r, 'cr/Default/Sync Extension Settings/ext/000003.log'); mk(r, 'cr/Default/GCM Store/000003.log'); mk(r, 'cr/WebCache/V01.log');
    mk(r, 'db/CURRENT'); mk(r, 'db/data.log'); mk(r, 'proj/000123.log'); mk(r, 'proj/app.log');
    mk(r, 'Library/Application Support/App/state.log'); mk(r, 'Library/Application Support/App/logs/app.log');
    mk(r, '.yarn/releases/yarn.cjs'); mk(r, 'stuff/cache/data.bin');
  }, {}, async ({ page, root }) => {
    const c = catPaths(await page.evaluate(() => window.api.cleanupScan()), root);
    expect(c.thumbs).toEqual(['ok/Thumbs.db']);
    expect(c.desktopini).toEqual(['ok/desktop.ini']);   // its own unticked preset
    expect(c.dsstore).toEqual(['ok/.DS_Store']);
    expect(c.junkdirs).toEqual(['vol/.Spotlight-V100/x']);   // .Trashes content is already trash: never re-offered
    expect(c.crash).toEqual(['sys/CrashDumps/a.dmp', 'sys/Crashpad/b.dmp']);
    expect(c.aimodels).toEqual(['.cache/huggingface/hub/x.bin']);
    expect(c.logs).toEqual(['Library/Application Support/App/logs/app.log', 'proj/app.log']);
    const all = Object.values(c).flat();
    for (const bad of ['art/Desktop.ini-backup/design.psd', 'docs/my.Spotlight.project/plan.docx', 'photos/MyThumbs.dbs/IMG_1.jpg', 'x/notThumbs.db', 'x/my.DS_Store', 'data/memory.dmp', '.lmstudio/models/me/model.gguf', 'db/data.log', 'proj/000123.log', '.yarn/releases/yarn.cjs', 'stuff/cache/data.bin'])
      expect(all, bad).not.toContain(bad);
    // the wizard pre-ticks only the exact-name presets
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('#cleanup-body')).toContainText('Log files');
    expect(await page.locator('.cleanup-check:checked').evaluateAll(els => els.map(e => e.dataset.id).sort())).toEqual(['dsstore', 'thumbs']);
  });
});

test('R3-2/5. only project areas are offered: tool, app-data, cloud and volume locations are refused with exact reasons', async () => {
  const o = { uid: 501, home: '/Users/bob', tmp: '/nonexistent-tmp' };
  const hidden = 'is inside a hidden folder in your home (tools and settings live there)';
  const lib = 'is inside your Library folder (app data), not a project';
  const cloud = 'is a cloud-synced folder: deleting here deletes it everywhere';
  const vol = 'is on an external, network or mounted volume';
  for (const [p, why] of [
    ['/Users/bob/.claude/local/node_modules', hidden], ['/Users/bob/.config/yarn/global/node_modules', hidden], ['/Users/bob/.local/share/pnpm/global/5/node_modules', hidden],
    ['/Users/bob/.bun/install/global/node_modules', hidden], ['/Users/bob/.node-red/node_modules', hidden], ['/Users/bob/.local/share/uv/tools/ruff/lib/x/target', hidden],
    ['/Users/bob/Library/pnpm/global/5/node_modules', lib], ['/Users/bob/Library/Application Support/nvim/mason/packages/x/node_modules', lib], ['/Users/bob/Library/Application Support/Zed/languages/x/node_modules', lib],
    ['/Users/bob/Dropbox/app/node_modules', cloud], ['/Users/bob/OneDrive - Corp/app/node_modules', cloud], ['/Users/bob/Library/CloudStorage/GoogleDrive-x/app/node_modules', cloud],
    ['/Users/bob/Library/Mobile Documents/com~apple~CloudDocs/app/node_modules', cloud], ['/Users/bob/Google Drive/app/node_modules', cloud], ['/Users/bob/Box/app/node_modules', cloud],
    ['/Volumes/Backup/proj/node_modules', vol], ['/mnt/data/proj/node_modules', vol], ['/media/bob/usb/proj/node_modules', vol], ['\\\\server\\share\\proj\\node_modules', vol],
    ['/home/linuxbrew/.linuxbrew/Cellar/node/20/libexec/lib/node_modules/x/node_modules', null], ['C:\\Users\\bob\\AppData\\Roaming\\x\\node_modules', 'is inside AppData (installed apps and settings), not a project']
  ]) {
    const got = cf.blockedLocation(p, o);
    if (why) expect(got, p).toBe(why); else expect(got, p).toBeTruthy();
  }
  for (const ok of ['/Users/bob/work/app/node_modules', '/Users/bob/Library/Developer/Xcode/DerivedData', '/Users/bob/dev/x/target'])
    expect(cf.blockedLocation(ok, o), ok).toBeNull();
  // and in the running app: only the project folder is offered
  const root = tmp(); const home = path.join(root, 'h');
  proj(home, '.claude/local'); proj(home, 'Library/pnpm/global/5'); proj(home, '.local/share/uv/tools/x'); proj(home, 'Dropbox/p'); proj(home, 'OneDrive - Corp/p'); proj(home, 'Library/CloudStorage/GoogleDrive-x/p'); proj(home, 'work/app');
  mk(home, 'Library/Developer/Xcode/DerivedData/App-1/x.o');
  age(root);
  const { app, page } = await launch(root, { HOME: home, USERPROFILE: home });
  try {
    await scanViaUi(page);
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(scan.candidates.map(c => path.relative(home, c.path).split(path.sep).join('/')).sort()).toEqual(['Library/Developer/Xcode/DerivedData', 'work/app/node_modules']);
    expect(scan.candidates.every(c => c.defaultChecked === false)).toBe(true);
    const bad = await del(page, [path.join(home, 'Dropbox/p/node_modules')]);
    expect(bad.blocked[0].reason).toBe(cloud);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('R3-3. a scan through a symlink cannot hide a blocked location (real path is judged too)', async () => {
  const root = tmp();
  proj(root, 'real/.nvm/versions/p');   // real path sits inside .nvm
  mk(root, 'real/.nvm/versions/p/x.txt');
  link(path.join(root, 'real/.nvm/versions'), path.join(root, 'link'), 'dir');
  age(root);
  const { app, page } = await launch(path.join(root, 'link'));
  try {
    await scanViaUi(page);
    const typed = path.join(root, 'link/p/node_modules');
    expect(cf.blockedLocation(typed, { uid: 501 })).toBeNull();   // the typed path alone looks fine
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(scan.candidates.map(c => c.path)).not.toContain(typed);
    const res = await del(page, [typed]);
    expect(res.deleted).toBe(0);
    expect(res.blocked[0].reason).toBe('is inside .nvm, which holds installed tools');
    expect(fs.existsSync(path.join(root, 'real/.nvm/versions/p/node_modules/dep/index.js'))).toBe(true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('R3-4. test mode cannot be enabled in a packaged build (source-level guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  expect(src).toMatch(/const E2E = !app\.isPackaged && process\.env\.STUFFDIVER_E2E === '1';/);
  // every test hook is behind E2E
  for (const hook of ['__e2eFs', '__e2eBeforeTrash', '__e2eRequire']) {
    for (const line of src.split('\n').filter(l => l.includes(hook))) expect(line, line).toMatch(/E2E/);
  }
  const lines = src.split('\n');
  lines.forEach((l, i) => { if (l.includes('process.env.STUFFDIVER_')) expect(l + ' ' + lines[i - 1], l).toMatch(/E2E/); });
});

test('R3-7. folder cleanup is cancellable and nothing is moved when cancelled', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, {}, async ({ app, page, root }) => {
    expect(await page.evaluate(() => window.api.cancelFolderDelete())).toBe(false);   // idle
    await app.evaluate(() => { global.__e2eBeforeTrash = () => new Promise(r => setTimeout(r, 1500)); });
    const run = page.evaluate((p) => window.api.deleteFolders(p, 'test'), [path.join(root, 'a/node_modules'), path.join(root, 'b/node_modules')]);
    await new Promise(r => setTimeout(r, 500));
    expect(await page.evaluate(() => window.api.cancelFolderDelete())).toBe(true);
    const res = await run;
    expect(res.deleted).toBe(0);
    expect(res.failed.length).toBe(2);
    expect(res.cancelled).toBe(true);
    expect(fs.existsSync(path.join(root, 'a/node_modules/dep/index.js')) && fs.existsSync(path.join(root, 'b/node_modules/dep/index.js'))).toBe(true);
  });
});

test('R3-8. there is no permanent-delete fallback anywhere in the delete handlers, and the dialogs state the undo story', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const a = src.indexOf("handleTrusted('delete-files'"), b = src.indexOf('// === Scan cache ===');
  const region = src.slice(a, b);
  expect(region).not.toMatch(/\b(rmSync|rmdirSync|unlinkSync|\.rm\(|\.unlink\(|\.rmdir\(|rimraf|emptyTrash)\b/);
  expect(region.match(/Recycle Bin \(Windows\); nothing is permanently deleted/g)).toHaveLength(2);
  expect(region.match(/status: 'failed', finalState: 'untouched', reason: osErrorReason\(e\)/g)).toHaveLength(2);
});

// ---- bind mounts (same st_dev, so only the OS mount table reveals them) ----
test('M1. mount table parsing: Linux mountinfo (octal escapes) and macOS mount output', () => {
  const info = [
    '36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue',
    '40 1 8:1 / / rw - ext4 /dev/sda1 rw',
    '41 40 8:2 /data /home/u/proj/node_modules/pkg/my\\040data rw - ext4 /dev/sda2 rw',
    '42 40 8:2 /d /srv/tab\\011x rw - ext4 /dev/sda2 rw'
  ].join('\n');
  expect(cf.parseMountinfo(info)).toEqual(['/mnt2', '/', '/home/u/proj/node_modules/pkg/my data', '/srv/tab\tx']);
  const mac = '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)\nserver:/x on /Users/u/proj/node_modules/mnt point (nfs, nodev)';
  expect(cf.parseMacMount(mac)).toEqual(['/', '/System/Volumes/Data', '/Users/u/proj/node_modules/mnt point']);
  const m = ['/', '/home/u/proj/node_modules/pkg/data', '/home/u/other'];
  expect(cf.mountConflict(['/home/u/proj/node_modules'], m, false)).toBe('contains the mount point /home/u/proj/node_modules/pkg/data');
  expect(cf.mountConflict(['/home/u/proj/node_modules/pkg/data'], m, false)).toBe('is itself a mount point (/home/u/proj/node_modules/pkg/data)');
  expect(cf.mountConflict(['/home/u/proj/node_modules/pkg/database'], m, false)).toBeNull();   // prefix of a name is not containment
  expect(cf.mountConflict(['/Home/U/Proj'], ['/home/u/proj/x'], true)).toMatch(/contains the mount point/);
  expect(cf.mountConflict(['/anything'], null, false)).toMatch(/mount table unreadable/);
  expect(cf.getMountPoints() === null || Array.isArray(cf.getMountPoints())).toBe(true);
});

test('M1/M2. a same-device mount inside, or at, a candidate is greyed out and refused (scan, delete and per-item recheck)', async () => {
  await withApp((r) => { proj(r, 'inside'); mk(r, 'inside/node_modules/pkg/data/db.sqlite'); proj(r, 'at'); proj(r, 'fine'); proj(r, 'late'); }, {}, async ({ app, page, root, userData }) => {
    const inside = path.join(root, 'inside/node_modules'), at = path.join(root, 'at/node_modules');
    const fine = path.join(root, 'fine/node_modules'), late = path.join(root, 'late/node_modules');
    await app.evaluate((_e, a) => { global.__e2eMounts = () => ['/', a.m1, a.m2]; }, { m1: path.join(inside, 'pkg/data'), m2: at });
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    const by = (p) => scan.candidates.find(c => c.path === p);
    expect(by(inside).refused).toBe(`contains the mount point ${path.join(inside, 'pkg/data')}`);
    expect(by(at).refused).toBe(`is itself a mount point (${at})`);
    expect(by(fine).refused).toBeNull();
    const bad = await del(page, [inside, at]);
    expect(bad.deleted).toBe(0);
    expect(bad.blocked.map(b => b.reason).sort()).toEqual([`contains the mount point ${path.join(inside, 'pkg/data')}`, `is itself a mount point (${at})`].sort());
    expect(fs.existsSync(path.join(inside, 'pkg/data/db.sqlite'))).toBe(true);
    expect(readLog(userData).filter(e => e.status === 'blocked').length).toBe(2);
    // The mount table is re-read at delete time: a mount that appears after the scan, and even
    // one that appears while the batch is already running, is caught right before that folder's move.
    await app.evaluate((_e, a) => {
      global.__e2eMounts = () => ['/'];
      global.__e2eBeforeTrash = (p) => { if (p === a.fine) global.__e2eMounts = () => ['/', a.late + '/dep']; };
    }, { fine, late });
    const res = await del(page, [fine, late]);
    expect(res.failed).toContain(late);
    expect(res.deletedPaths).not.toContain(late);
    expect(fs.existsSync(path.join(late, 'dep/index.js'))).toBe(true);
    const e = readLog(userData).find(x => x.path === late);
    expect(e).toMatchObject({ status: 'blocked' });
    expect(e.reason).toBe(`changed just before delete: contains the mount point ${late}/dep`);
  });
});

test('M2. a candidate on a different device than its parent is refused (does not depend on scan visit order)', async () => {
  const root = tmp();
  try {
    proj(root, 'p');
    const dir = path.join(root, 'p/node_modules');
    expect(cf.deviceDiffersFromParent(dir)).toBe(false);
    const fake = { lstatSync: (p, o) => { const st = fs.lstatSync(p, o); return p === dir ? new Proxy(st, { get: (t, k) => k === 'dev' ? t.dev + 1n : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : st; }, readdirSync: fs.readdirSync, statSync: fs.statSync, realpathSync: fs.realpathSync };
    expect(cf.deviceDiffersFromParent(dir, fake)).toBe(true);
    const files = [{ path: path.join(dir, 'dep/index.js'), name: 'index.js', size: 1, mtime: 1 }];
    expect(cf.findCandidates(files, root, false, fake, ['/'])[0].refusedReason).toBe('is on a different device than its parent folder (mount or volume boundary)');
    expect(cf.findCandidates(files, root, false, fs, ['/'])[0].refusedReason).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- Windows-VM round ----
test('W3. on the system drive only user folders qualify; per-user apps and global npm stay refused', () => {
  const o = { win: true, systemDrive: 'C:', home: 'C:\\Users\\bob', tmp: 'C:\\Users\\bob\\AppData\\Local\\Temp', uid: null };
  for (const p of ['C:\\node22\\node_modules', 'C:\\tools\\x\\target', 'C:\\dev\\app\\node_modules', 'C:\\work\\app\\node_modules'])
    expect(cf.blockedLocation(p, o), p).toBe('is outside your user folders');
  expect(cf.blockedLocation('C:\\node22\\node_modules\\npm\\node_modules', o)).toBeTruthy();
  for (const p of ['D:\\dev\\app\\node_modules', 'E:\\app\\target', 'C:\\Users\\bob\\work\\app\\node_modules', 'C:\\Users\\alice\\code\\x\\node_modules', 'C:\\Users\\bob\\AppData\\Local\\Temp\\sd-1\\p\\node_modules'])
    expect(cf.blockedLocation(p, o), p).toBeNull();
  expect(cf.blockedLocation('C:\\Users\\bob\\AppData\\Local\\Programs\\Code\\resources\\app\\node_modules', o)).toBe('is inside an installed Windows program');
  expect(cf.blockedLocation('C:\\Users\\bob\\AppData\\Roaming\\npm\\node_modules', o)).toBe('is a global npm install location');
  expect(cf.blockedLocation('C:\\Users\\bob\\AppData\\Roaming\\npm\\node_modules\\x\\node_modules', o)).toBeTruthy();
  expect(cf.blockedLocation('C:\\Program Files\\App\\resources\\app\\node_modules', o)).toBe('is inside a Windows system or program folder');
  expect(cf.blockedLocation('C:\\ProgramData\\x\\node_modules', o)).toBe('is inside a Windows system or program folder');
  expect(cf.blockedLocation('C:\\Users\\bob\\node_modules', o)).toBe('sits directly in a user home folder, not in a project');
  // not applied on other systems
  expect(cf.blockedLocation('/work/app/node_modules', { win: false, uid: 501, home: '/Users/bob' })).toBeNull();
});

test('W4. anything already inside a Trash / Recycle Bin is never a candidate', async () => {
  const why = 'is already in a Trash or Recycle Bin';
  const o = { uid: 501, home: '/Users/bob', tmp: '/nope' };
  for (const p of ['C:\\$Recycle.Bin\\S-1-5-21-1\\$R1ABC\\.venv', '/Users/bob/.Trash/proj/node_modules', '/home/bob/.local/share/Trash/files/p/node_modules', '/mnt/usb/.Trash-1000/files/p/node_modules', '/Volumes/X/.Trashes/501/p/node_modules'])
    expect(cf.blockedLocation(p, o), p).toBe(why);
  await withApp((r) => { proj(r, '$Recycle.Bin/S-1-5-21/$R1ABC'); proj(r, '.Trash/old'); proj(r, 'real'); }, {}, async ({ page, root }) => {
    const scan = await page.evaluate(() => window.api.cleanupFoldersScan());
    expect(scan.candidates.map(c => c.relPath)).toEqual(['real/node_modules']);
  });
});

test('W5. progress is reported to the UI while folders are verified and moved, and the button becomes Cancel', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, {}, async ({ app, page, root }) => {
    await page.evaluate(() => { window.__prog = []; window.api.onFolderDeleteProgress(d => window.__prog.push(d)); });
    await app.evaluate(() => { global.__e2eBeforeTrash = () => new Promise(r => setTimeout(r, 1200)); });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await expect(page.locator('.cleanup-folder')).toHaveCount(2);
    await page.locator('.cleanup-folder-check').first().check();
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-folders-execute')).toHaveText('Cancel');
    await expect(page.locator('#cleanup-progress')).toContainText(/Moving to Trash 1 of 1: .*node_modules/);
    expect(await page.evaluate(() => 1 + 1)).toBe(2);   // renderer stays responsive during the work
    await expect(page.locator('#cleanup-result')).toContainText(/Moved 1 folder/, { timeout: 15000 });
    const prog = await page.evaluate(() => window.__prog);
    expect(prog.some(p => p.phase === 'verify')).toBe(true);
    expect(prog.some(p => p.phase === 'trash' && p.total === 1)).toBe(true);
  });
});

test('W6. after a move the folder disappears from the tree at once, and the summary is honest', async () => {
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, {}, async ({ page, root, userData }) => {
    await expect(page.locator('#stats')).toContainText('Files: 8');
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('.cleanup-folder', { hasText: 'a/node_modules' }).locator('input').check();
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-result')).toBeVisible({ timeout: 15000 });
    const entry = readLog(userData).find(e => e.path.endsWith(path.join('a', 'node_modules')));
    if (entry.status === 'trashed') {
      await expect(page.locator('#cleanup-result')).toContainText('Moved 1 folder to the Trash');
      await page.locator('#cleanup-close').click();
      const text = await page.locator('#folder-tree').innerText();
      expect(text).not.toMatch(/node_modules/);       // the moved folder is gone from the tree
      await expect(page.locator('#stats')).toContainText('Files: 6');      // 8 before; the moved folder's two files are gone
      await page.locator('#tools-btn').click();
      await page.locator('[data-tool="cleanup"]').click();
      await expect(page.locator('.cleanup-folder')).toHaveCount(1);        // only b/node_modules is still offered
      await expect(page.locator('.cleanup-folder')).not.toContainText('a/node_modules');
    } else {
      await expect(page.locator('#cleanup-result')).toContainText('failed 1');   // trash unavailable: reported, not hidden
    }
  });
});

test('W6b. a mixed batch is reported as "N moved, M failed" with the reason and never as a cancellation', async () => {
  test.skip(process.platform === 'win32' || (process.getuid && process.getuid() === 0), 'needs POSIX permission semantics');
  await withApp((r) => { proj(r, 'a'); proj(r, 'b'); }, {}, async ({ app, page, root, userData }) => {
    const a = path.join(root, 'a/node_modules'), b = path.join(root, 'b/node_modules');
    // Make the second folder impossible to move AFTER verification passed (parent loses write permission).
    await app.evaluate((_e, args) => { global.__e2eBeforeTrash = (p) => { if (p === args.b) global.__e2eRequire('fs').chmodSync(args.parent, 0o555); }; }, { b, parent: path.join(root, 'b') });
    await page.locator('#tools-btn').click();
    await page.locator('[data-tool="cleanup"]').click();
    await page.locator('.cleanup-folder-check').nth(0).check();
    await page.locator('.cleanup-folder-check').nth(1).check();
    await page.locator('#cleanup-folders-execute').click();
    await expect(page.locator('#cleanup-result')).toBeVisible({ timeout: 15000 });
    fs.chmodSync(path.join(root, 'b'), 0o755);
    const txt = await page.locator('#cleanup-result').innerText();
    expect(txt).not.toMatch(/Cancel/i);
    const log = readLog(userData);
    const eb = log.find(e => e.path.endsWith(path.join('b', 'node_modules')));
    if (eb.status === 'failed' || eb.status === 'blocked') {
      expect(txt).toMatch(/failed 1, skipped 0/);
      expect(eb.finalState).toBe('untouched');
      expect(txt).toContain(eb.reason);
      expect(eb.reason.length).toBeGreaterThan(5);
    }
  });
});

test('W6c. logs carry the on-disk case of the path (case-insensitive file systems)', async () => {
  test.skip(process.platform === 'linux', 'only meaningful on case-insensitive file systems');
  await withApp((r) => { proj(r, 'proj'); }, {}, async ({ page, root, userData }) => {
    const typed = path.join(root, 'PROJ', 'node_modules');
    const real = path.join(root, 'proj', 'node_modules');
    const res = await del(page, [typed]);
    expect(res.error).toBeUndefined();
    const entry = readLog(userData).find(e => e.path.toLowerCase() === real.toLowerCase());
    expect(entry.path).toBe(real);
  });
});
