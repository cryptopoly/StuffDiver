// Regression tests for the adversarial-review findings (see numbered comments).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cf = require('../cleanup-folders');
const { launch, scanViaUi } = require('./helpers');

const OLD = new Date(Date.now() - 90 * 86400000);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cs-')));
function mk(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (rel.endsWith('/')) { fs.mkdirSync(p, { recursive: true }); return p; }
  fs.writeFileSync(p, content === undefined ? 'x'.repeat(2048) : content);
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
    fs.symlinkSync(path.join(root, 'c/real.txt'), path.join(root, 'c/__pycache__/link.pyc'));
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
    mk(r, 'f/real.txt'); fs.symlinkSync(path.join(r, 'plain'), path.join(r, 'f/dirlink'), 'dir'); fs.symlinkSync(path.join(r, 'f/real.txt'), path.join(r, 'f/filelink'));
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
        if (p === args.a) { fsx.rmSync(args.b, { recursive: true }); fsx.symlinkSync(args.precious, args.b, 'dir'); }
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

test('A. a mount point inside a candidate refuses it (walk and scan-time check)', () => {
  const root = tmp();
  try {
    proj(root, 'p'); mk(root, 'p/node_modules/pkg/mnt/data.db');
    const dir = path.join(root, 'p/node_modules');
    expect(cf.inspectFolder(dir).error).toBeNull();
    const w = cf.inspectFolder(dir, fakeMountFs(path.join('pkg', 'mnt')));
    expect(w.error).toBe(`contains ${path.join(dir, 'pkg/mnt')}, which is on a different filesystem or a mount point`);
    const files = [{ path: path.join(dir, 'pkg/mnt/data.db'), name: 'data.db', size: 1, mtime: 1 }, { path: path.join(dir, 'dep/index.js'), name: 'index.js', size: 1, mtime: 1 }];
    const found = cf.findCandidates(files, root, false, fakeMountFs(path.join('pkg', 'mnt')));
    expect(found[0].refusedReason).toMatch(/different filesystem or a mount point/);
    expect(cf.findCandidates(files, root, false)[0].refusedReason).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('A. Windows: a directory link/junction anywhere inside is refused; file links are fine', () => {
  const root = tmp();
  try {
    proj(root, 'p'); mk(root, 'other/x.txt'); mk(root, 'p/node_modules/dep/real.txt');
    const dir = path.join(root, 'p/node_modules');
    fs.symlinkSync(path.join(root, 'p/node_modules/dep/real.txt'), path.join(dir, 'filelink'));
    expect(cf.inspectFolder(dir, fs, true).error).toBeNull();
    fs.symlinkSync(path.join(root, 'other'), path.join(dir, 'dep/dirlink'), 'dir');
    expect(cf.inspectFolder(dir, fs, true).error).toBe(`contains ${path.join(dir, 'dep/dirlink')}, a junction or directory link`);
    expect(cf.inspectFolder(dir, fs, false).error).toBeNull(); // POSIX: symlinks are not followed, so they are harmless
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
