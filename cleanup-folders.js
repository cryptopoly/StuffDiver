// Folder-level Smart Cleanup: structural classifier + safe inspection walk.
// Pure Node (no Electron) so it can be unit-tested. Every candidate is
// recognised by a marker on disk, never by its name alone, and the same
// classifier runs at scan time and again at delete time.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RECENT_DAYS = 14;
const MANY_FILES = 50000;
const WALK_ENTRY_CAP = 1000000;

// Marker lookups compare EXACT, case-sensitive names read from the directory listing,
// so PACKAGE.JSON never counts (on any filesystem) and a symlinked marker is not trusted.
const entriesOf = (dir, fsx) => { try { return fsx.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; } };
const anyFile = (dir, names, fsx) => entriesOf(dir, fsx).some(e => names.includes(e.name) && e.isFile());
const exists = (p, fsx) => anyFile(path.dirname(p), [path.basename(p)], fsx);
const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const VENV_ENTRIES = new Set(['bin', 'Scripts', 'lib', 'Lib', 'lib64', 'include', 'Include', 'share', 'pyvenv.cfg', '.gitignore', 'CACHEDIR.TAG', '.gitkeep']);

// Locations where a matching folder belongs to an installed tool/app/system, or
// where a mistake is too costly. Path-based, so it needs no filesystem access.
function blockedLocation(dir, opts = {}) {
  const uid = opts.uid !== undefined ? opts.uid : (process.getuid ? process.getuid() : null);
  const normHome = (h) => h.split(path.sep).join('/').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const homes = [];
  for (const h of opts.home ? [opts.home] : [os.homedir()]) {
    homes.push(normHome(h));
    if (!opts.home) { try { homes.push(normHome(fs.realpathSync.native(h))); } catch (e) { /* ignore */ } }
  }
  const tmps = [];
  for (const t of opts.tmp ? [opts.tmp] : [os.tmpdir()]) {
    tmps.push(normHome(t));
    try { tmps.push(normHome(fs.realpathSync.native(t))); } catch (e) { /* ignore */ }
  }
  const norm = dir.split(path.sep).join('/').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const segs = norm.split('/').filter(Boolean);
  const parentSegs = segs.slice(0, -1);
  const parent = norm.slice(0, norm.lastIndexOf('/')) || '/';
  if (parentSegs.includes('node_modules')) return 'is inside another node_modules (an installed package, not your project)';
  if (/(^|\/)lib\/node_modules$/.test(norm)) return 'is a global npm install location';
  const tool = parentSegs.find(x => /^(\.nvm|\.volta|\.fnm|\.asdf|\.pyenv|pyenv-win|\.sdkman|\.rustup|\.cargo|\.conda|\.cursor|\.windsurf|\.vscode.*|pipx|venvs|miniconda\d*|anaconda\d*|miniforge\d*|mambaforge)$/.test(x));
  if (tool) return `is inside ${tool}, which holds installed tools`;
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].endsWith('.app') && segs[i + 1] === 'contents') return 'is inside an application bundle';
    if (segs[i] === 'appdata' && segs[i + 1] === 'local' && segs[i + 2] === 'programs') return 'is inside an installed Windows program';
    if (segs[i] === 'appdata' && segs[i + 1] === 'roaming' && segs[i + 2] === 'npm') return 'is a global npm install location';
  }
  if (/^[a-z]:\/(program files( \(x86\))?|programdata|windows)(\/|$)/.test(norm)) return 'is inside a Windows system or program folder';
  for (const r of ['/opt', '/usr', '/srv', '/var/www', '/snap', '/lib', '/lib64', '/var/lib']) {
    if (norm === r || norm.startsWith(r + '/')) return `is under ${r}, which holds system or server software`;
  }
  if (homes.includes(parent) || /^(\/users\/[^/]+|\/home\/[^/]+|[a-z]:\/users\/[^/]+|\/root)$/.test(parent)) return 'sits directly in a user home folder, not in a project';
  // Allow-by-location: folder cleanup is for project areas, not for where tools, apps and sync clients live.
  const inTmp = tmps.some(t => norm.startsWith(t + '/'));
  if (segs.some(x => /^(cloudstorage|mobile documents|icloud drive.*|dropbox.*|google drive.*|googledrive|my drive|box|box sync|onedrive.*)$/.test(x))) return 'is a cloud-synced folder: deleting here deletes it everywhere';
  if (/^\/(volumes|mnt|media|run\/media)\//.test(norm) || /^(\\\\|\/\/)/.test(dir)) return 'is on an external, network or mounted volume';
  if (segs.some(x => /^(linuxbrew|\.linuxbrew|homebrew|cellar)$/.test(x))) return 'is inside a Homebrew install';
  if (!inTmp && segs.includes('appdata')) return 'is inside AppData (installed apps and settings), not a project';
  let rel = null;
  for (const h of homes) if (norm.startsWith(h + '/')) { rel = norm.slice(h.length + 1).split('/'); break; }
  if (!rel) { const m = /^(?:\/users\/[^/]+|\/home\/[^/]+|[a-z]:\/users\/[^/]+)\/(.*)$/.exec(norm); if (m) rel = m[1].split('/'); }
  if (rel) {
    if (rel[0].startsWith('.')) return 'is inside a hidden folder in your home (tools and settings live there)';
    if (rel[0] === 'library' && rel[1] !== 'developer') return 'is inside your Library folder (app data), not a project';
  }
  if (uid === 0 && !/^(\/root|\/home\/|\/users\/|[a-z]:\/users\/)/.test(norm)) return 'is outside home folders and this app is running as root/administrator';
  return null;
}

// Each kind: name test (cheap, used to pick candidates from the scan list) and
// marker test (structural, run against the real filesystem).
const KINDS = [
  {
    id: 'node_modules', label: 'node_modules', icon: '\u{1F4E6}',
    name: n => n === 'node_modules',
    marker: (d, fsx) => anyFile(path.dirname(d), ['package.json'], fsx) && anyFile(path.dirname(d), LOCKFILES, fsx),
    reason: 'node_modules next to package.json and a lockfile (a project you installed, not a shipped package)',
    restore: 'Reinstall with npm install (or yarn / pnpm install). Restoring from the trash also works.'
  },
  {
    id: 'pycache', label: 'Python bytecode cache', icon: '\u{1F40D}',
    name: n => n === '__pycache__',
    marker: (d, fsx) => {
      const entries = fsx.readdirSync(d, { withFileTypes: true });
      return entries.length > 0 && entries.every(e => e.isFile() && /\.py[co]$/.test(e.name));
    },
    reason: '__pycache__ containing only .pyc/.pyo files',
    restore: 'Python rebuilds it automatically the next time the code runs.'
  },
  {
    id: 'pytest_cache', label: 'pytest cache', icon: '\u{1F9EA}',
    name: n => n === '.pytest_cache',
    marker: (d, fsx) => exists(path.join(d, 'CACHEDIR.TAG'), fsx),
    reason: '.pytest_cache with a CACHEDIR.TAG marker',
    restore: 'pytest recreates it on the next run.'
  },
  {
    id: 'mypy_cache', label: 'mypy cache', icon: '\u{1F9EA}',
    name: n => n === '.mypy_cache',
    marker: (d, fsx) => exists(path.join(d, 'CACHEDIR.TAG'), fsx),
    reason: '.mypy_cache with a CACHEDIR.TAG marker',
    restore: 'mypy recreates it on the next run (the first run is slower).'
  },
  {
    id: 'derived_data', label: 'Xcode DerivedData', icon: '\u{1F528}',
    name: n => n === 'DerivedData',
    marker: (d) => /[\\/]Library[\\/]Developer[\\/]/.test(d),
    reason: 'DerivedData inside a Library/Developer folder',
    restore: 'Xcode rebuilds it on the next build (the first build is slower).'
  },
  {
    id: 'target', label: 'Build output (target)', icon: '\u{1F3D7}',
    name: n => n === 'target',
    marker: (d, fsx) => anyFile(path.dirname(d), ['Cargo.toml', 'pom.xml'], fsx),
    reason: 'target next to Cargo.toml or pom.xml',
    restore: 'Rebuild with cargo build or mvn package.'
  },
  {
    id: 'gradle_cache', label: 'Gradle project cache', icon: '\u{1F418}',
    name: n => n === '.gradle',
    marker: (d, fsx) => anyFile(path.dirname(d), ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], fsx),
    reason: '.gradle next to a Gradle build file',
    restore: 'Gradle recreates it on the next build.'
  },
  {
    id: 'next', label: 'Next.js build cache', icon: '\u{1F3D7}',
    name: n => n === '.next',
    marker: (d, fsx) => anyFile(path.dirname(d), ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'], fsx),
    reason: '.next next to next.config.*',
    restore: 'Rebuild with next build (or next dev).'
  },
  {
    id: 'nuxt', label: 'Nuxt build cache', icon: '\u{1F3D7}',
    name: n => n === '.nuxt',
    marker: (d, fsx) => anyFile(path.dirname(d), ['nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.cjs', 'nuxt.config.ts'], fsx),
    reason: '.nuxt next to nuxt.config.*',
    restore: 'Rebuild with nuxt build (or nuxt dev).'
  },
  {
    // Any name: recognised by the pyvenv.cfg file Python writes into every virtualenv.
    id: 'venv', label: 'Python virtual environment', icon: '\u{1F40D}',
    name: () => false, byMarkerFile: 'pyvenv.cfg', defaultOff: true,
    marker: (d, fsx) => {
      const es = entriesOf(d, fsx);
      return es.some(e => e.name === 'pyvenv.cfg' && e.isFile()) && es.every(e => VENV_ENTRIES.has(e.name));
    },
    reason: 'virtualenv (pyvenv.cfg and only standard venv folders, no project files)',
    restore: 'Recreate with python -m venv and reinstall your requirements. Anything installed by hand is lost.'
  }
];

const CANDIDATE_NAMES = new Set(['node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', 'DerivedData', 'target', '.gradle', '.next', '.nuxt']);

// Returns {kind, reason, restore, ...} when `dir` is a real directory carrying
// a valid marker for an allowlisted kind; otherwise {refused: why} or null.
function classifyFolder(dir, fsx = fs) {
  let st;
  try { st = fsx.lstatSync(dir); } catch (e) { return { refused: 'folder no longer exists' }; }
  if (st.isSymbolicLink()) return { refused: 'is a symlink or junction, not a real folder' };
  if (!st.isDirectory()) return { refused: 'is not a folder' };
  const blocked = blockedLocation(dir) || (() => {
    // Judge the real location too: a symlinked ancestor must not hide a blocked place (also expands Windows 8.3 names).
    try {
      const real = fsx.realpathSync && fsx.realpathSync.native ? fsx.realpathSync.native(dir) : null;
      return real && real !== dir ? blockedLocation(real) : null;
    } catch (e) { return null; }
  })();
  if (blocked) return { refused: blocked };
  const base = path.basename(dir);
  for (const k of KINDS) {
    const named = k.name(base) || k.byMarkerFile;
    if (!named) continue;
    let ok = false;
    try { ok = k.marker(dir, fsx); } catch (e) { ok = false; }
    if (ok) return { kind: k.id, label: k.label, icon: k.icon, reason: k.reason, restore: k.restore, defaultOff: !!k.defaultOff };
  }
  return null;
}

// Walk a folder without following links. Reports file count, bytes, newest
// mtime, whether any `.git` exists inside, and every directory seen (for the
// protected-path check). Returns {error} if the walk cannot be trusted.
async function inspectFolder(dir, fsx = fs, isWin = process.platform === 'win32', shouldCancel = null) {
  const out = { files: 0, bytes: 0, newest: 0, git: null, dirs: [], error: null };
  const devOf = (p) => { try { return fsx.lstatSync(p, { bigint: true }).dev; } catch (e) { return null; } };
  const rootDev = devOf(dir);
  if (rootDev === null) { out.error = 'cannot read ' + dir; return out; }
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const cur = stack.pop();
    await new Promise(r => setImmediate(r)); // keep the app responsive during big walks
    if (shouldCancel && shouldCancel()) { out.error = 'cancelled'; return out; }
    let entries;
    try { entries = fsx.readdirSync(cur, { withFileTypes: true }); } catch (e) { out.error = 'cannot read ' + cur + ' (' + (e.code || e.message) + ')'; return out; }
    for (const e of entries) {
      if (++seen > WALK_ENTRY_CAP) { out.error = 'too many entries to verify safely'; return out; }
      const full = path.join(cur, e.name);
      if (e.name === '.git' && !out.git) out.git = full;
      if (e.isSymbolicLink()) {
        // Windows junctions and directory links report as links: refuse them anywhere inside.
        if (isWin) { let isDir = true; try { isDir = fsx.statSync(full).isDirectory(); } catch (er) { /* dangling: treat as unsafe */ } if (isDir) { out.error = `contains ${full}, a junction or directory link`; return out; } }
        out.files++; continue;
      }
      if (e.isDirectory()) {
        // A different device means a mount point: trashing would carry live mounted data along.
        const d = devOf(full);
        if (d === null || d !== rootDev) { out.error = `contains ${full}, which is on a different filesystem or a mount point`; return out; }
        out.dirs.push(full); stack.push(full); continue;
      }
      out.files++;
      try { const s = fsx.lstatSync(full); out.bytes += s.size; if (s.mtimeMs > out.newest) out.newest = s.mtimeMs; } catch (er) { /* vanished */ }
    }
  }
  return out;
}

// ---- mount points (bind mounts share st_dev, so only the OS mount table can see them) ----
const unescapeMountinfo = (v) => v.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
function parseMountinfo(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.split(' ');
    if (f.length > 5 && f[4]) out.push(unescapeMountinfo(f[4]));
  }
  return out;
}
function parseMacMount(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = / on (\/.*) \([^()]*\)$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}
// Fresh every call (never cached): mounts can appear between scan and delete.
function getMountPoints() {
  try {
    if (process.platform === 'linux') return parseMountinfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
    if (process.platform === 'darwin') return parseMacMount(require('child_process').execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5000 }));
  } catch (e) { return null; } // unknown: callers treat null as "cannot verify" and refuse
  return []; // Windows: reparse points/junctions and volume serials are checked instead
}
// Reason if `dir` is, or contains, a mount point other than "/" (checked for each given spelling of the path).
function mountConflict(dirs, mounts, ci) {
  if (mounts === null) return 'cannot be checked for mount points (mount table unreadable)';
  const norm = (v) => { const x = v.replace(/\/+$/, '') || '/'; return ci ? x.toLowerCase() : x; };
  for (const d of dirs.filter(Boolean).map(norm)) {
    for (const m of mounts) {
      if (m === '/') continue;
      const n = norm(m);
      if (n === d) return `is itself a mount point (${m})`;
      if (n.startsWith(d + '/')) return `contains the mount point ${m}`;
    }
  }
  return null;
}
// A candidate on a different device than its parent is a mount (or volume) boundary.
function deviceDiffersFromParent(dir, fsx = fs) {
  try {
    return fsx.lstatSync(dir, { bigint: true }).dev !== fsx.lstatSync(path.dirname(dir), { bigint: true }).dev;
  } catch (e) { return true; }
}
const realOf = (dir, fsx) => { try { return fsx.realpathSync && fsx.realpathSync.native ? fsx.realpathSync.native(dir) : null; } catch (e) { return null; } };

function isInside(child, parent, ci) {
  const c = ci ? child.toLowerCase() : child;
  const p = ci ? parent.toLowerCase() : parent;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Keep only the outermost of nested paths. Returns {kept, dropped}.
function dedupeNested(paths, ci) {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const kept = [], dropped = [];
  for (const p of sorted) {
    if (kept.some(k => isInside(p, k, ci))) dropped.push(p); else kept.push(p);
  }
  return { kept, dropped };
}

// Find candidate folders in the full scan list. `files` entries need
// {path, size, mtime}. Marker checks hit the real filesystem, but only for
// folders whose name could qualify, so this stays cheap on huge scans.
function findCandidates(files, scanRoot, ci, fsx = fs, mounts = getMountPoints()) {
  const root = path.resolve(scanRoot);
  const possible = new Set();
  const dirKey = (d) => ci ? d.toLowerCase() : d;
  const seenDirs = new Map(); // dir -> true/false (possible candidate by name)
  for (const f of files) {
    if (f.cloudStatus === 'icloud-only') continue;
    let d = path.dirname(f.path);
    if (f.name === 'pyvenv.cfg' && isInside(d, root, ci)) possible.add(d);
    while (d && isInside(d, root, ci)) {
      const key = dirKey(d);
      if (seenDirs.has(key)) break;
      seenDirs.set(key, true);
      if (CANDIDATE_NAMES.has(path.basename(d))) possible.add(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  const valid = new Map();
  for (const d of possible) {
    const c = classifyFolder(d, fsx);
    if (c && c.kind) valid.set(dirKey(d), { dir: d, ...c });
  }
  const { kept } = dedupeNested([...valid.values()].map(v => v.dir), ci);
  const owners = new Map(kept.map(d => [dirKey(d), { ...valid.get(dirKey(d)), path: d, size: 0, files: 0, newest: 0, hasGit: false, dirs: new Set(), refusedReason: null }]));
  const ownerOf = new Map();
  const find = (d) => {
    const key = dirKey(d);
    if (ownerOf.has(key)) return ownerOf.get(key);
    let r = null;
    if (owners.has(key)) r = owners.get(key);
    else if (isInside(d, root, ci) && path.dirname(d) !== d) r = find(path.dirname(d));
    ownerOf.set(key, r);
    return r;
  };
  for (const f of files) {
    const o = find(path.dirname(f.path));
    if (!o) continue;
    o.size += f.size || 0;
    o.dirs.add(path.dirname(f.path));
    o.files++;
    if ((f.mtime || 0) > o.newest) o.newest = f.mtime;
    const rel = path.relative(o.path, f.path).split(path.sep);
    if (rel.slice(0, -1).includes('.git') || rel[rel.length - 1] === '.git') o.hasGit = true;
  }
  // One lstat per distinct folder: unreadable folders and mount points inside a candidate are flagged now, not only at delete time.
  for (const o of owners.values()) {
    // Independent of what the scan happened to visit: use the OS mount table and the parent's device.
    o.refusedReason = mountConflict([o.path, realOf(o.path, fsx)], mounts, ci)
      || (deviceDiffersFromParent(o.path, fsx) ? 'is on a different device than its parent folder (mount or volume boundary)' : null);
    if (o.refusedReason) { o.dirs = undefined; continue; }
    let rootDev;
    try { rootDev = fsx.lstatSync(o.path, { bigint: true }).dev; fsx.readdirSync(o.path); } catch (e) { o.refusedReason = 'cannot be read (' + (e.code || e.message) + ')'; continue; }
    for (const d of o.dirs) {
      let dev;
      try { dev = fsx.lstatSync(d, { bigint: true }).dev; } catch (e) { o.refusedReason = `contains ${d}, which cannot be read (${e.code || e.message})`; break; }
      if (dev !== rootDev) { o.refusedReason = `contains ${d}, which is on a different filesystem or a mount point`; break; }
    }
    o.dirs = undefined;
  }
  return [...owners.values()];
}

module.exports = { parseMountinfo, parseMacMount, getMountPoints, mountConflict, deviceDiffersFromParent, blockedLocation, KINDS, CANDIDATE_NAMES, RECENT_DAYS, MANY_FILES, classifyFolder, inspectFolder, dedupeNested, findCandidates, isInside };
