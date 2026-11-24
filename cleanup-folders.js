// Folder-level Smart Cleanup: structural classifier + safe inspection walk.
// Pure Node (no Electron) so it can be unit-tested. Every candidate is
// recognised by a marker on disk, never by its name alone, and the same
// classifier runs at scan time and again at delete time.
const fs = require('fs');
const path = require('path');

const RECENT_DAYS = 14;
const MANY_FILES = 50000;
const WALK_ENTRY_CAP = 1000000;

const exists = (p, fsx) => { try { return fsx.lstatSync(p).isFile(); } catch (e) { return false; } };
const anyFile = (dir, names, fsx) => names.some(n => exists(path.join(dir, n), fsx));

// Each kind: name test (cheap, used to pick candidates from the scan list) and
// marker test (structural, run against the real filesystem).
const KINDS = [
  {
    id: 'node_modules', label: 'node_modules', icon: '\u{1F4E6}',
    name: n => n === 'node_modules',
    marker: (d, fsx) => exists(path.join(path.dirname(d), 'package.json'), fsx),
    reason: 'node_modules next to package.json',
    restore: 'Reinstall with npm install (or yarn / pnpm install). Restoring from the trash also works.'
  },
  {
    id: 'pycache', label: 'Python bytecode cache', icon: '\u{1F40D}',
    name: n => n === '__pycache__',
    marker: (d, fsx) => {
      const entries = fsx.readdirSync(d);
      return entries.length > 0 && entries.every(e => /\.py[co]$/i.test(e));
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
    marker: (d, fsx) => exists(path.join(d, 'pyvenv.cfg'), fsx),
    reason: 'virtualenv (contains pyvenv.cfg)',
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
function inspectFolder(dir, fsx = fs) {
  const out = { files: 0, bytes: 0, newest: 0, git: null, dirs: [], error: null };
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fsx.readdirSync(cur, { withFileTypes: true }); } catch (e) { out.error = 'cannot read ' + cur + ' (' + (e.code || e.message) + ')'; return out; }
    for (const e of entries) {
      if (++seen > WALK_ENTRY_CAP) { out.error = 'too many entries to verify safely'; return out; }
      const full = path.join(cur, e.name);
      if (e.name === '.git' && !out.git) out.git = full;
      if (e.isSymbolicLink()) { out.files++; continue; }
      if (e.isDirectory()) { out.dirs.push(full); stack.push(full); continue; }
      out.files++;
      try { const s = fsx.lstatSync(full); out.bytes += s.size; if (s.mtimeMs > out.newest) out.newest = s.mtimeMs; } catch (er) { /* vanished */ }
    }
  }
  return out;
}

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
function findCandidates(files, scanRoot, ci, fsx = fs) {
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
  const owners = new Map(kept.map(d => [dirKey(d), { ...valid.get(dirKey(d)), path: d, size: 0, files: 0, newest: 0, hasGit: false }]));
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
    o.files++;
    if ((f.mtime || 0) > o.newest) o.newest = f.mtime;
    const rel = path.relative(o.path, f.path).split(path.sep);
    if (rel.slice(0, -1).includes('.git') || rel[rel.length - 1] === '.git') o.hasGit = true;
  }
  return [...owners.values()];
}

module.exports = { KINDS, CANDIDATE_NAMES, RECENT_DAYS, MANY_FILES, classifyFolder, inspectFolder, dedupeNested, findCandidates, isInside };
