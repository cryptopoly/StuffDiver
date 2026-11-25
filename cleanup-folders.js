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
const VCS_NAMES = new Set(['.git', '.hg', '.jj', '.svn', '.bzr', '.fossil', '_fossil_']);
// Documents people write by hand: never found in tool output such as target/, .next/, __pycache__ or DerivedData.
const USER_DOC_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|pdf|pages|numbers|key|psd|ai|sketch|fig|md|markdown|rtf)$/i;
const USER_DOC_STRICT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|pages|numbers|key|psd|ai|sketch|fig|rtf)$/i; // node_modules legitimately ships README.md / pdf docs
const docRe = (mode) => mode === 'strict' ? USER_DOC_STRICT : USER_DOC_EXT;
const BUNDLE_EXT = /\.(app|framework|bundle|plugin|component|vst|vst3|appex|kext|xpc|prefpane|saver|mdimporter|qlgenerator|wdgt|xcarchive|photoslibrary|musiclibrary|imovielibrary|tvlibrary|band|logicx|fcpbundle|sparsebundle|pkg|aaxplugin|clap|systemextension|dext|workflow|scptd|xcplugin|xcframework|rtfd|docset|nib|lbaction|mdimporter|osax|service|action)$/i;
// Files inside signed bundles and installed-app locations: removing even junk-looking files breaks signatures/installs.
function installedAppReason(p, bundleOnly = false) {
  const norm = String(p).replace(/\\/g, '/').toLowerCase();
  const segs = norm.split('/').filter(Boolean);
  if (segs.slice(0, -1).some(x => BUNDLE_EXT.test(x))) return 'inside an application bundle';
  if (bundleOnly) return null;
  if (segs.some(x => x === 'windowsapps' || x === 'program files' || x === 'program files (x86)') || /\/programdata\/(package cache|microsoft)(\/|$)/.test(norm)) return 'inside an installed Windows application folder';
  // Installed-app folders in user space (Windows per-user installs, scoop, Steam, user flatpaks).
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] === 'appdata' && segs[i + 1] === 'local' && segs[i + 2] === 'programs') return 'inside an installed Windows application folder';
    if (segs[i] === 'scoop' && segs[i + 1] === 'apps') return 'inside an installed Windows application folder';
    if (segs[i] === 'steamapps' && segs[i + 1] === 'common') return 'inside an installed game folder';
    if (segs[i] === '.local' && segs[i + 1] === 'share' && segs[i + 2] === 'flatpak') return 'inside an installed application location';
  }
  if (/^\/(usr|opt|snap)(\/|$)/.test(norm) || /^\/var\/lib\/flatpak(\/|$)/.test(norm) || /^\/tmp\/\.mount_[^/]+(\/|$)/.test(norm) || /^\/app(\/|$)/.test(norm)) return 'inside an installed application location';
  return null;
}
// Why a trash call may fail for size reasons: the Windows Recycle Bin has a per-volume size limit (a share of the volume).
function capacityHint(size, volumeTotal) {
  if (!(size > 0) || !(volumeTotal > 0)) return null;
  const pct = size / volumeTotal * 100;
  return pct >= 5 ? `it is about ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of the volume, which may exceed the Recycle Bin size limit` : null;
}
// Text safe to put in a native dialog: no control or bidi-override characters, one line, long names shortened in the middle.
function safeText(v, max = 160) {
  let t = String(v).replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) { const k = Math.floor((max - 1) / 2); t = t.slice(0, k) + '\u2026' + t.slice(t.length - k); }
  return t;
}
let elevated = false; // set by the app: Windows Administrator / POSIX root
function setElevated(v) { elevated = !!v; }
const CLOUD_RE = /^(cloudstorage|mobile documents|icloud drive.*|iclouddrive|dropbox.*|google drive.*|googledrive|my drive|box|box sync|onedrive.*|sharepoint.*|nextcloud.*|owncloud.*|pcloud.*|mega.*|synologydrive.*|syncthing.*|sync|seafile.*|creative cloud files.*|yandex\.disk.*|resilio.*|insync.*|tresorit.*|spideroak.*|backblaze.*|idrive.*)$/;
// Reason if any path component is a cloud-synced root (trashing there deletes the cloud copy everywhere).
const CLOUD_REASON = 'is a cloud-synced folder: deleting here deletes it everywhere';
const slashNorm = (v) => String(v).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// OneDrive/SharePoint libraries live in tenant-named folders: the sync client publishes their real roots in the environment.
function cloudEnvRoots() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) if (/^onedrive/i.test(k) && v) out.push(slashNorm(v));
  return out;
}
function cloudSyncedReason(p) {
  const norm = slashNorm(p);
  const segs = norm.split('/').filter(Boolean);
  if (segs.some(x => CLOUD_RE.test(x) || / - (shared )?documents$/.test(x))) return CLOUD_REASON;   // "Team Site - Documents"
  if (cloudEnvRoots().some(r => norm === r || norm.startsWith(r + '/'))) return CLOUD_REASON;
  return null;
}
const TRASH_RE_TEST = (norm, segs) => segs.some(x => x === '$recycle.bin' || x === 'recycler' || /^\.trash(-\d+)?$/.test(x) || x === '.trashes') || /\/\.local\/share\/trash(\/|$)/.test(norm);
function trashReason(p) {
  const norm = String(p).replace(/\\/g, '/').toLowerCase();
  return TRASH_RE_TEST(norm, norm.split('/').filter(Boolean)) ? 'is already in a Trash or Recycle Bin' : null;
}
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
  const tool = parentSegs.find(x => /^(\.nvm|\.volta|\.fnm|\.asdf|\.pyenv|pyenv-win|\.sdkman|\.rustup|\.cargo|\.conda|\.cursor|\.windsurf|\.vscode.*|scoop|chocolatey|choco|fnm_multishells|nodejs|winget|pipx|venvs|miniconda\d*|anaconda\d*|miniforge\d*|mambaforge)$/.test(x));
  if (tool) return `is inside ${tool}, which holds installed tools`;
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].endsWith('.app') && segs[i + 1] === 'contents') return 'is inside an application bundle';
    if (segs[i] === 'appdata' && segs[i + 1] === 'local' && segs[i + 2] === 'programs') return 'is inside an installed Windows program';
    if (segs[i] === 'appdata' && segs[i + 1] === 'roaming' && segs[i + 2] === 'npm') return 'is a global npm install location';
  }
  if (/^[a-z]:\/(program files( \(x86\))?|programdata|windows)(\/|$)/.test(norm)) return 'is inside a Windows system or program folder';
  for (let i = 0; i < segs.length - 1; i++) if (segs[i] === 'resources' && (segs[i + 1] === 'app' || segs[i + 1] === 'app.asar.unpacked')) return 'is inside a packaged application (resources/app)';
  // On the system drive only user folders qualify; tool installs like C:\node22 or C:\tools are not projects.
  const win = opts.win !== undefined ? opts.win : process.platform === 'win32';
  const sysDrive = (opts.systemDrive || process.env.SystemDrive || 'C:').toLowerCase().replace(/[\\/]+$/, '');
  if (win && norm.startsWith(sysDrive + '/') && !/^[a-z]:\/users\/[^/]+\//.test(norm) && !tmps.some(t => norm.startsWith(t + '/'))) return 'is outside your user folders';
  for (const r of ['/opt', '/usr', '/srv', '/var/www', '/snap', '/lib', '/lib64', '/var/lib']) {
    if (norm === r || norm.startsWith(r + '/')) return `is under ${r}, which holds system or server software`;
  }
  if (homes.includes(parent) || /^(\/users\/[^/]+|\/home\/[^/]+|[a-z]:\/users\/[^/]+|\/root)$/.test(parent)) return 'sits directly in a user home folder, not in a project';
  // Allow-by-location: folder cleanup is for project areas, not for where tools, apps and sync clients live.
  const inTmp = tmps.some(t => norm.startsWith(t + '/'));
  // Already-trashed items are never candidates (the Recycle Bin / Trash presets handle them as files).
  if (TRASH_RE_TEST(norm, segs)) return 'is already in a Trash or Recycle Bin';
  if (cloudSyncedReason(dir)) return CLOUD_REASON;
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
  if (win && (opts.elevated !== undefined ? opts.elevated : elevated) && !homes.some(h => norm.startsWith(h + '/')) && !inTmp) return 'is outside your user profile and this app is running elevated (Administrator)';
  if (uid === 0 && !/^(\/root|\/home\/|\/users\/|[a-z]:\/users\/)/.test(norm)) return 'is outside home folders and this app is running as root/administrator';
  return null;
}

// Each kind: name test (cheap, used to pick candidates from the scan list) and
// marker test (structural, run against the real filesystem).
const KINDS = [
  {
    id: 'node_modules', label: 'node_modules', icon: '\u{1F4E6}', denyDocs: 'strict',
    name: n => n === 'node_modules',
    marker: (d, fsx) => {
      if (!(anyFile(path.dirname(d), ['package.json'], fsx) && anyFile(path.dirname(d), LOCKFILES, fsx))) return false;
      // The package manager itself writes one of these inside node_modules; hand-made or shipped folders lack them.
      return anyFile(d, ['.package-lock.json', '.modules.yaml', '.yarn-integrity'], fsx) || 'has no package-manager install marker (.package-lock.json, .modules.yaml or .yarn-integrity)';
    },
    reason: 'node_modules next to package.json and a lockfile (a project you installed, not a shipped package)',
    restore: 'Reinstall with npm install (or yarn / pnpm install). Restoring from the trash also works.'
  },
  {
    id: 'pycache', label: 'Python bytecode cache', icon: '\u{1F40D}',
    denyDocs: true,
    name: n => n === '__pycache__',
    marker: (d, fsx) => {
      const entries = fsx.readdirSync(d, { withFileTypes: true });
      return entries.length > 0 && entries.every(e => e.isFile() && /\.py[co]$/.test(e.name));
    },
    reason: '__pycache__ containing only .pyc/.pyo files',
    restore: 'Python rebuilds it automatically the next time the code runs.'
  },
  {
    id: 'pytest_cache', label: 'pytest cache', icon: '\u{1F9EA}', denyDocs: true,
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
    denyDocs: true, forbidNames: (n) => /\.xcarchive$/i.test(n) || n.toLowerCase() === 'archives',
    marker: (d) => /[\\/]Library[\\/]Developer[\\/]Xcode[\\/]DerivedData$/.test(d),
    reason: 'DerivedData inside a Library/Developer folder',
    restore: 'Xcode rebuilds it on the next build (the first build is slower).'
  },
  {
    id: 'target', label: 'Build output (target)', icon: '\u{1F3D7}',
    name: n => n === 'target',
    denyDocs: true,
    marker: (d, fsx) => {
      const up = path.dirname(d);
      if (anyFile(up, ['Cargo.toml'], fsx)) return anyFile(d, ['CACHEDIR.TAG'], fsx) || 'has no CACHEDIR.TAG written by cargo';
      if (anyFile(up, ['pom.xml'], fsx)) return entriesOf(d, fsx).some(e => e.isDirectory() && ['classes', 'maven-status', 'generated-sources', 'maven-archiver'].includes(e.name)) || 'has no Maven build output folders';
      return false;
    },
    reason: 'target next to Cargo.toml or pom.xml',
    restore: 'Rebuild with cargo build or mvn package.'
  },
  {
    id: 'gradle_cache', label: 'Gradle project cache', icon: '\u{1F418}', denyDocs: true,
    name: n => n === '.gradle',
    marker: (d, fsx) => anyFile(path.dirname(d), ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], fsx),
    reason: '.gradle next to a Gradle build file',
    restore: 'Gradle recreates it on the next build.'
  },
  {
    id: 'next', label: 'Next.js build cache', icon: '\u{1F3D7}',
    name: n => n === '.next',
    denyDocs: true,
    marker: (d, fsx) => anyFile(path.dirname(d), ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'], fsx) && (anyFile(d, ['BUILD_ID'], fsx) || 'has no BUILD_ID written by next build'),
    reason: '.next next to next.config.*',
    restore: 'Rebuild with next build (or next dev).'
  },
  {
    id: 'nuxt', label: 'Nuxt build cache', icon: '\u{1F3D7}', denyDocs: true,
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
  try { fsx.readdirSync(dir); } catch (e) { return { unreadable: true, refused: `cannot be read (${e.code || e.message})` }; }
  for (const k of KINDS) {
    const named = k.name(base) || k.byMarkerFile;
    if (!named) continue;
    let ok = false;
    try { ok = k.marker(dir, fsx); } catch (e) { ok = false; }
    if (typeof ok === 'string') return { refused: ok };
    if (ok) return { kind: k.id, label: k.label, icon: k.icon, reason: k.reason, restore: k.restore, defaultOff: !!k.defaultOff, denyDocs: k.denyDocs || false, forbidNames: k.forbidNames || null };
  }
  return null;
}

// Walk a folder without following links. Reports file count, bytes, newest
// mtime, whether any `.git` exists inside, and every directory seen (for the
// protected-path check). Returns {error} if the walk cannot be trusted.
async function inspectFolder(dir, fsx = fs, isWin = process.platform === 'win32', shouldCancel = null, kindInfo = null) {
  const out = { files: 0, bytes: 0, newest: 0, git: null, dirs: [], error: null, userDoc: null, forbidden: null };
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
      if (VCS_NAMES.has(e.name.toLowerCase()) && !out.git) out.git = full;
      if (kindInfo && kindInfo.denyDocs && !out.userDoc && !e.isDirectory() && docRe(kindInfo.denyDocs).test(e.name)) out.userDoc = full;
      if (kindInfo && kindInfo.forbidNames && !out.forbidden && kindInfo.forbidNames(e.name)) out.forbidden = full;
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
  const norm = (v) => { const x = String(v).replace(/\\/g, '/').replace(/\/+$/, '') || '/'; return ci ? x.toLowerCase() : x; };
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

// ---- "could this break something that cannot simply be reinstalled / is in use?" (R5) ----
const SAFE_HOSTS = /^https?:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com)\//i;
function readCapped(p, max, fsx) {
  try { const st = fsx.statSync(p); if (!st.isFile()) return null; if (st.size > max) return false; return fsx.readFileSync(p, 'utf8'); } catch (e) { return null; }
}
function lockfileProblem(text) {
  // pnpm: a resolution without an npm tarball/integrity is a git, local or hosted-tarball dependency.
  let rm;
  const rr = /resolution:\s*\{([^}]*)\}/g;
  while ((rm = rr.exec(text))) {
    if (/\b(commit|repo|directory|type)\s*:/.test(rm[1]) || !/\b(integrity|tarball)\s*:/.test(rm[1])) return 'lockfile has a dependency without an npm registry tarball (git or local)';
  }
  if (/resolution:\s*\n\s+(commit|repo|directory|type)\s*:/.test(text)) return 'lockfile has a dependency without an npm registry tarball (git or local)';
  const re = /(?:resolved|tarball)["']?\s*[:=]?\s*["']?((?:[a-z+]+:\/\/|file:|link:|git\+)[^\s"',)]*)/gi;
  let m;
  while ((m = re.exec(text))) {
    const u = m[1];
    if (/^(file:|link:|git\+|git:)/i.test(u)) return `lockfile has a ${u.split(':')[0]} dependency that cannot be reinstalled from a registry`;
    if (!SAFE_HOSTS.test(u)) { let h = u; try { h = new URL(u).host; } catch (e) { /* keep raw */ } return `lockfile has packages from a registry other than npmjs.org (${h})`; }
  }
  return null;
}
function npmrcProblem(text) {
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:@[^:=\s]+:)?registry\s*=\s*(\S+)/i.exec(line);
    if (m && !SAFE_HOSTS.test(m[1].replace(/\/?$/, '/'))) return `.npmrc points to a custom registry (${m[1]})`;
  }
  return null;
}
// Returns { severe: reason|null, warnings: [] }. Severe ones make the folder "not offered".
function projectSignals(dir, kindId, opts = {}) {
  const fsx = opts.fsx || fs;
  const out = { severe: null, warnings: [] };
  const sev = (r) => { if (!out.severe) out.severe = r; };
  const up = path.dirname(dir);
  const ents = entriesOf(up, fsx);
  const names = new Set(ents.map(e => e.name));
  if (kindId === 'node_modules') {
    const pkgText = readCapped(path.join(up, 'package.json'), 2 * 1024 * 1024, fsx);
    let pkg = null;
    try { pkg = pkgText ? JSON.parse(pkgText) : null; } catch (e) { /* unparsable: ignore */ }
    if (pkg) {
      const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies);
      for (const v of Object.values(deps)) {
        if (typeof v !== 'string') continue;
        if (/^(file:|link:|git\+|git:|github:|git@)/i.test(v) || (v.startsWith('workspace:') && !pkg.workspaces)) { sev(`package.json has a local, git or workspace dependency (${v}) that may not be reinstallable`); break; }
      }
      if (pkg.patchedDependencies || (pkg.pnpm && pkg.pnpm.patchedDependencies)) sev('the project patches its dependencies (patchedDependencies)');
    }
    if (ents.some(e => e.name === 'patches' && e.isDirectory())) sev('the project has a patches/ folder (patched dependencies)');
    for (const lock of LOCKFILES.filter(n => names.has(n) && !n.startsWith('bun'))) {
      const t = readCapped(path.join(up, lock), 25 * 1024 * 1024, fsx);
      if (t === false) sev(`${lock} is too large to verify`);
      else if (t) { const p = lockfileProblem(t); if (p) sev(p); }
    }
    for (const rc of [path.join(up, '.npmrc'), path.join(opts.home || os.homedir(), '.npmrc')]) {
      const t = readCapped(rc, 256 * 1024, fsx);
      const p = t && npmrcProblem(t);
      if (p) sev(p);
    }
    for (const n of names) {
      if (/^(ecosystem|pm2)\.config\.[a-z]+$/i.test(n)) sev(`${n} suggests this project is managed by pm2 / a service`);
      else if (/^docker-compose.*\.ya?ml$/i.test(n)) { const t = readCapped(path.join(up, n), 512 * 1024, fsx); if (t && /node_modules/.test(t)) sev(`${n} mounts node_modules into a container`); else out.warnings.push(`${n} found: containers may depend on this folder`); }
      else if (/^dockerfile/i.test(n)) out.warnings.push('a Dockerfile is next to it: image builds may expect this folder');
      else if (/\.service$/.test(n)) { const t = readCapped(path.join(up, n), 128 * 1024, fsx); if (t && (t.includes(up) || /node_modules/.test(t))) sev(`${n} (a service unit) refers to this folder`); }
    }
  }
  // Recently edited project files (not just the folder itself) mean active work.
  let newest = 0;
  for (const e of ents.slice(0, 300)) {
    if (e.name === path.basename(dir) || e.name.startsWith('.')) continue;
    try { const st = fsx.lstatSync(path.join(up, e.name)); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (er) { /* gone */ }
  }
  if (newest && Date.now() - newest < RECENT_DAYS * 86400000) out.warnings.push(`project files were modified ${Math.max(0, Math.floor((Date.now() - newest) / 86400000)) === 0 ? 'today' : Math.floor((Date.now() - newest) / 86400000) + ' day(s) ago'}: you are probably working on it`);
  // A running process whose working directory is inside the folder (best effort).
  if (Array.isArray(opts.cwds)) {
    const ci = process.platform !== 'linux';
    const nz = (v) => { const x = String(v).replace(/\\/g, '/').replace(/\/+$/, ''); return ci ? x.toLowerCase() : x; };
    const d = nz(dir);
    const hit = opts.cwds.find(c => { const x = nz(c); return x === d || x.startsWith(d + '/'); });
    if (hit) sev(`a running process is using this folder (working directory ${hit})`);
    else {
      const u = nz(up);
      const proj = opts.cwds.find(c => { const x = nz(c); return x === u || x.startsWith(u + '/'); });
      if (proj) out.warnings.push(`a running process has its working directory in this project (${proj})`);
    }
  } else if (opts.cwds === null) out.warnings.push('could not check for running processes');
  return out;
}
// Working directories of running processes; null when it cannot be determined.
function runningCwds() {
  try {
    if (process.platform === 'linux') {
      const out = [];
      for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) { try { out.push(fs.readlinkSync('/proc/' + pid + '/cwd')); } catch (e) { /* not ours */ } }
      return out;
    }
    if (process.platform === 'darwin') {
      const txt = require('child_process').execFileSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 8000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      return txt.split('\n').filter(l => l.startsWith('n/')).map(l => l.slice(1));
    }
  } catch (e) {
    if (e && e.stdout) return String(e.stdout).split('\n').filter(l => l.startsWith('n/')).map(l => l.slice(1)); // lsof exits 1 when some processes are unreadable
  }
  if (process.platform === 'linux' || process.platform === 'darwin') return null;   // supported but failed
  return undefined;                                                                  // unsupported here: nothing to warn about
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
function findCandidates(files, scanRoot, ci, fsx = fs, mounts = getMountPoints(), cwds = runningCwds()) {
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
    else if (c && c.unreadable) {
      // Unreadable after the scan (permissions changed): still listed, greyed out with the reason.
      const k = KINDS.find(x => x.name(path.basename(d)) || x.byMarkerFile);
      if (k) valid.set(dirKey(d), { dir: d, kind: k.id, label: k.label, icon: k.icon, reason: k.reason, restore: k.restore, defaultOff: !!k.defaultOff, denyDocs: k.denyDocs || false, forbidNames: k.forbidNames || null });
    }
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
    if (rel.some(x => VCS_NAMES.has(x.toLowerCase()))) o.hasGit = true;
    if (o.denyDocs && !o.userDoc && docRe(o.denyDocs).test(f.name || '')) o.userDoc = f.path;
    if (o.forbidNames && !o.forbidden && rel.some(x => o.forbidNames(x))) o.forbidden = f.path;
  }
  // One lstat per distinct folder: unreadable folders and mount points inside a candidate are flagged now, not only at delete time.
  for (const o of owners.values()) {
    // Independent of what the scan happened to visit: use the OS mount table and the parent's device.
    o.refusedReason = mountConflict([o.path, realOf(o.path, fsx)], mounts, ci)
      || (deviceDiffersFromParent(o.path, fsx) ? 'is on a different device than its parent folder (mount or volume boundary)' : null);
    const sig = projectSignals(o.path, o.kind, { fsx, cwds });
    o.signals = sig.warnings;
    if (!o.refusedReason && sig.severe) o.refusedReason = sig.severe;
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

module.exports = { capacityHint, CLOUD_REASON, installedAppReason, safeText, projectSignals, runningCwds, lockfileProblem, npmrcProblem, setElevated, cloudSyncedReason, trashReason, VCS_NAMES, parseMountinfo, parseMacMount, getMountPoints, mountConflict, deviceDiffersFromParent, blockedLocation, KINDS, CANDIDATE_NAMES, RECENT_DAYS, MANY_FILES, classifyFolder, inspectFolder, dedupeNested, findCandidates, isInside };
