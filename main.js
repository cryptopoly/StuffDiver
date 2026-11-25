const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
// Plain filesystem access (no .asar archive handling) for hashing and size walks.
const rawFs = process.versions.electron ? require('original-fs') : fs;
const crypto = require('crypto');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { exec, execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { runScan, mapLimit, isPseudoFilesystemPath } = require('./scanner');
const { parseCliArgs, runCli, UsageError, USAGE } = require('./cli');
const cleanupFolders = require('./cleanup-folders');
const quarantine = require('./quarantine');

// Set the app name so macOS permission dialogs show "Stuff Diver"
app.setName('Stuff Diver');

// End-to-end test mode (Playwright): isolated user data, no native dialogs,
// no auto-updater. Never enabled unless the env var is set explicitly.
// Test mode can never be switched on in a packaged (shipped) build.
const E2E = !app.isPackaged && process.env.STUFFDIVER_E2E === '1';
if (E2E) global.__e2eRequire = require; // lets E2E tests reach Node modules from app.evaluate
const E2E_SCAN_DELAY = E2E ? (Number(process.env.STUFFDIVER_E2E_SCAN_DELAY_MS) || 0) : 0;
if (E2E && process.env.STUFFDIVER_USER_DATA) {
  app.setPath('userData', process.env.STUFFDIVER_USER_DATA);
}

// Headless CLI mode (--scan ...). Parsed before any window exists. Packaged
// builds have argv [exe, ...args]; `electron .` has [electron, '.', ...args].
let cliOpts = null;
try {
  cliOpts = parseCliArgs(process.argv.slice(process.defaultApp ? 2 : 1));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  process.stderr.write(`Error: ${e.message}\n\n${USAGE}`);
  process.exit(2);
}
if (cliOpts && process.platform === 'darwin') app.dock && app.dock.hide();

let mainWindow;
let tray = null;
let monitorTimer = null;
let approvedFolderPaths = new Set();
const APP_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const ALLOWED_EXTERNAL_HOSTS = new Set(['buymeacoffee.com', 'www.paypal.com', 'paypal.com']);

function isTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return false;
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  return senderUrl === APP_URL;
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event)) {
    throw new Error('Untrusted IPC sender');
  }
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...args);
  });
}

function setActiveFolderState(folderPath, files) {
  lastScanAllFiles = Array.isArray(files) ? files.slice() : [];
  lastScanFolder = folderPath;
}

function assertAllowedFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Invalid file path');
  }
  const resolved = path.resolve(filePath);
  // Windows and macOS volumes are case-insensitive by default
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const cmp = (v) => ci ? v.toLowerCase() : v;
  for (const root of approvedFolderPaths) {
    if (cmp(resolved) === cmp(root)) return resolved;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (cmp(resolved).startsWith(cmp(prefix))) return resolved;
  }
  throw new Error('Path is outside approved folders');
}

function assertDirectoryPath(folderPath) {
  if (typeof folderPath !== 'string' || folderPath.length === 0) {
    throw new Error('Invalid folder path');
  }
  const resolved = path.resolve(folderPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    throw new Error('Folder not found or inaccessible');
  }
  if (!stat.isDirectory()) {
    throw new Error('Folder path must be a directory');
  }
  return resolved;
}

const MONITOR_INTERVAL_MIN = 3600000;
const MONITOR_INTERVAL_MAX = 30 * 86400000;
const MONITOR_INTERVAL_DEFAULT = 86400000;

function clampMonitorInterval(intervalMs) {
  if (!Number.isFinite(intervalMs)) return MONITOR_INTERVAL_DEFAULT;
  return Math.max(MONITOR_INTERVAL_MIN, Math.min(intervalMs, MONITOR_INTERVAL_MAX));
}

// Paths that lead to SIP-protected, bind-mounted, or otherwise hostile trees
// for a file-size scanner. We warn before scanning these because a naive walk
// can produce millions of inaccessible entries and exhaust memory.
const DANGEROUS_POSIX_ROOTS = [
  '/System', '/Volumes', '/private', '/usr', '/bin', '/sbin',
  '/dev', '/etc', '/var', '/tmp', '/cores', '/Library'
];

function isDangerousPath(folderPath) {
  const resolved = path.resolve(folderPath);
  if (process.platform === 'win32') {
    if (/^[A-Za-z]:[\\/]?$/.test(resolved)) return true;
    const lower = resolved.toLowerCase();
    if (lower === 'c:\\windows' || lower.startsWith('c:\\windows\\')) return true;
    if (lower === 'c:\\program files' || lower.startsWith('c:\\program files\\')) return true;
    if (lower === 'c:\\program files (x86)' || lower.startsWith('c:\\program files (x86)\\')) return true;
    return false;
  }
  if (resolved === '/') return true;
  for (const root of DANGEROUS_POSIX_ROOTS) {
    if (resolved === root || resolved.startsWith(root + '/')) return true;
  }
  return false;
}

async function confirmDangerousScan(folderPath) {
  if (E2E) return true;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Scan Anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'System Folder Warning',
    message: 'This looks like a system folder.',
    detail: `${folderPath}\n\nScanning system folders can include millions of files Stuff Diver cannot open, double-count via APFS firmlinks, and cause the app to run out of memory. Pick a subfolder (for example your Documents or Downloads) for faster, more useful results.`
  });
  return result.response === 1;
}


let activeScan = null;

function approveFolderPath(folderPath) {
  const resolved = assertDirectoryPath(folderPath);
  approvedFolderPaths.add(resolved);
  try { approvedFolderPaths.add(fs.realpathSync.native(resolved)); } catch (e) { /* keep the typed form */ }   // the real location of a symlinked root is protected and checked too
  return resolved;
}

function assertApprovedFolder(folderPath) {
  const resolved = assertDirectoryPath(folderPath);
  if (!approvedFolderPaths.has(resolved)) {
    throw new Error('Folder access has not been approved');
  }
  return resolved;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Stuff Diver',
    icon: path.join(__dirname, 'logo.png'),
    backgroundColor: '#0f0f1a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Remove menu bar on Windows/Linux (macOS uses system menu bar)
  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.loadFile('index.html');
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_URL) event.preventDefault();
  });
}

// Two app instances must not run cleanups or empty the quarantine at once (the in-process lock would not see each other).
if (!cliOpts && !E2E) {
  if (!app.requestSingleInstanceLock()) app.quit();
  else app.on('second-instance', () => showMainWindow());
}
// Brings the window forward, or opens a new one when it was closed (the monitor/tray keeps the app alive without a window).
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  } else if (app.isReady()) createWindow();
}
if (E2E) global.__e2eShowMainWindow = showMainWindow;

app.whenReady().then(async () => {
  if (cliOpts) {
    const code = await runCli(cliOpts, { version: app.getVersion() }).catch((e) => {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    });
    app.exit(code);
    return;
  }
  createWindow();
  if (!E2E) setupAutoUpdater();
  // Auto-start folder monitor if enabled. The folder was explicitly approved
  // by the user when the monitor was set up; re-approve in-memory so the
  // monitor can run without prompting again on each app launch.
  const settings = loadSettings();
  if (settings.monitorEnabled && settings.monitorFolder) {
    try {
      approveFolderPath(settings.monitorFolder);
      startMonitor();
    } catch (e) {
      console.error('Could not resume monitor:', e.message);
    }
  }
});

app.on('window-all-closed', () => {
  // Keep running if monitoring is active (tray stays)
  if (process.platform !== 'darwin' && !monitorTimer) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Full file list from last scan (kept in main process for duplicate detection)
let lastScanAllFiles = [];
let lastScanFolder = null;

// IPC Handlers

handleTrusted('select-folder', async () => {
  if (E2E && process.env.STUFFDIVER_E2E_FOLDER) return approveFolderPath(process.env.STUFFDIVER_E2E_FOLDER);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  const picked = result.filePaths[0];
  if (isDangerousPath(picked) && !(await confirmDangerousScan(picked))) return null;
  return approveFolderPath(picked);
});

handleTrusted('approve-folder', async (event, folderPath) => {
  const resolved = assertDirectoryPath(folderPath);
  if (approvedFolderPaths.has(resolved)) return true;
  if (E2E) { approveFolderPath(resolved); return true; }
  if (isDangerousPath(resolved)) {
    if (!(await confirmDangerousScan(resolved))) return false;
    approveFolderPath(resolved);
    return true;
  }
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Cancel', 'Allow'],
    defaultId: 1,
    cancelId: 0,
    title: 'Allow Folder Access',
    message: 'Allow Stuff Diver to access this folder?',
    detail: resolved
  });
  if (result.response !== 1) return false;
  approveFolderPath(resolved);
  return true;
});

handleTrusted('cancel-scan', async () => {
  if (activeScan) activeScan.cancelled = true;
  return true;
});

handleTrusted('scan-folder', async (event, folderPath, options) => {
  folderPath = assertApprovedFolder(folderPath);
  const scanState = { cancelled: false };
  activeScan = scanState;
  const send = (channel, payload) => { try { event.sender.send(channel, payload); } catch (e) { /* window closed */ } };
  const { allFiles, ...result } = await runScan(folderPath, {
    exclude: options && options.exclude,
    mftFastScan: loadSettings().mftFastScan === true,
    scanState,
    delayMs: E2E_SCAN_DELAY,
    onBatch: (p) => send('scan-batch', p),
    onProgress: (p) => send('scan-progress', p)
  });
  // Store full list for duplicate detection
  setActiveFolderState(folderPath, allFiles);
  if (activeScan === scanState) activeScan = null;
  return result;
});

// Largest files with a given extension from the full scan (the renderer only
// holds the top ~500 overall, so extension views are answered here).
handleTrusted('query-files-by-ext', async (event, ext, limit) => {
  const key = typeof ext === 'string' ? ext : '';
  const cap = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const norm = key === '(none)' ? '' : key.toLowerCase();
  const out = [];
  for (const f of lastScanAllFiles) {
    if ((f.ext || '') === norm) out.push(f);
  }
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, cap);
});

// Is the process running with elevated rights? (Windows: Administrator;
// POSIX: root.) Used to explain "inaccessible" counts.
let elevatedCache = null;
handleTrusted('is-elevated', async () => detectElevated());
async function detectElevated() {
  if (elevatedCache !== null) return elevatedCache;
  if (process.platform !== 'win32') {
    elevatedCache = typeof process.getuid === 'function' && process.getuid() === 0;
    return elevatedCache;
  }
  try {
    const { stdout } = await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ], { windowsHide: true });
    elevatedCache = /true/i.test(stdout);
  } catch (e) {
    elevatedCache = false;
  }
  return elevatedCache;
}

// Windows: restart the app with a UAC prompt so protected folders can be read.
// macOS: open the Full Disk Access pane. Other platforms: no-op.
handleTrusted('elevate-access', async () => {
  if (process.platform === 'win32') {
    const args = app.isPackaged ? [] : [app.getAppPath()];
    const argList = args.length ? `-ArgumentList '${args[0].replace(/'/g, "''")}'` : '';
    const exe = process.execPath.replace(/'/g, "''");
    try {
      // The elevated copy must not meet our single-instance lock and quit: release it before it starts.
      app.releaseSingleInstanceLock();
      await execFileP('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath '${exe}' ${argList} -Verb RunAs`
      ], { windowsHide: true });
      app.quit();
      return 'relaunching';
    } catch (e) {
      if (!E2E && !cliOpts) app.requestSingleInstanceLock();   // still running: take the lock back
      return 'cancelled'; // user declined the UAC prompt
    }
  }
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    return 'opened-settings';
  }
  return 'unsupported';
});

// === Smart Cleanup ===
// Patterns run over the FULL scan list here in the main process (the renderer
// only holds the ~500 largest files). Paths are matched as '/'-separated and
// relative to the scanned folder, on every platform. First match wins, so
// specific patterns come before generic ones.
const CLEANUP_PATTERNS = [
  // Recycle Bin / Trash contents are not offered: moving them to the trash again is meaningless and is refused.
  { id: 'wintemp', label: 'Windows temp files', icon: '\u{1F550}', re: /(^\/Windows\/Temp\/|\/AppData\/Local\/Temp\/)/i },
  { id: 'winupdate', label: 'Windows Update downloads', icon: '\u{1FA9F}', re: /^\/Windows\/SoftwareDistribution\/Download\//i },
  // Crash dumps only inside known crash folders; MEMORY.DMP only as C:\Windows\MEMORY.DMP.
  { id: 'crash', label: 'Crash dumps', icon: '\u{1F4A5}', re: /(\/CrashDumps\/|\/Crashpad\/|^\/Windows\/Minidump\/|(^|\/)MEMORY\.DMP$|^\/var\/crash\/)/,
    skip: (full) => /(^|\/)MEMORY\.DMP$/.test(full) && !/^[A-Za-z]:\/Windows\/MEMORY\.DMP$/i.test(full) },
  // Re-downloadable caches only: not the Hugging Face token, not LM Studio models, not Ollama models (may come from local files).
  { id: 'aimodels', label: 'AI model caches (re-downloadable)', icon: '\u{1F9E0}', re: /(\/\.cache\/huggingface\/(hub|datasets)\/|\/\.cache\/(torch|whisper)\/)/i },
  // Cache/store folders only: not pnpm.exe / global CLIs (AppData/Local/pnpm), not Yarn global installs, not ~/.m2/repository (mvn-installed artifacts).
  { id: 'pkgcache', label: 'Package manager caches', icon: '\u{1F4E6}', re: /(\/AppData\/Local\/(pip\/Cache|npm-cache|NuGet\/(v3-cache|http-cache)|pnpm\/store|Yarn\/Cache)\/|\/\.nuget\/packages\/|\/\.gradle\/caches\/|\/\.cargo\/registry\/(cache|src)\/|\/Library\/Caches\/(pip|Homebrew)\/|\/var\/cache\/apt\/archives\/)/i },
  { id: 'syscache', label: 'System & app caches', icon: '\u{1F5C4}', re: /(\/(\.cache|\.npm|INetCache|GPUCache|Code Cache)\/|\/Library\/Caches\/)/i,
    skip: (full) => /\/\.cache\/(lm-studio|lmstudio|huggingface\/(?!hub\/|datasets\/))/i.test(full) },
  { id: 'temp', label: 'Temp files', icon: '\u{1F550}', re: /\.(tmp|temp)$/i,
    skip: (full) => /^~/.test(full.split('/').pop()) },   // Office ~WRL*.tmp / ~$ recovery and lock files
  // .log is also the write-ahead file of LevelDB/SQLite-style stores (extensions, wallets, Slack, Chrome sync, VS Code state),
  // and chat clients keep their history as .log. Offered only when clearly a log.
  { id: 'logs', label: 'Log files', icon: '\u{1F4DD}', re: /\.log$/i,
    skip: (full, ctx) => {
      const parts = full.split('/');
      const name = parts[parts.length - 1], parent = parts[parts.length - 2] || '';
      if (/^\d{6,}\.log$/.test(name)) return true;   // LevelDB / Kafka-style numbered segments
      if (/\/(leveldb|Local Storage|IndexedDB|Local Extension Settings|Sync Extension Settings|Session Storage|Sync Data|GCM Store|WebCache|databases|Service Worker|File System|blob_storage)\//i.test(full)) return true;
      if (/\/(irclogs?|chatlogs?|ChatStorage|Slack|Discord|Teams|Skype|WhatsApp|Telegram|Signal|Zoom|Pidgin|Adium|HexChat|weechat|Messages)\//i.test(full)) return true;
      if (ctx && ctx.dbDirs.has(parts.slice(0, -1).join('/'))) return true;
      if (/\/(Application Support|AppData|\.config|\.local\/share)\//i.test(full) && !/^(logs?)$/i.test(parent)) return true;
      return false;
    } },
  { id: 'junkdirs', label: 'Spotlight index & thumbnail caches', icon: '\u{1F5C2}', re: /(\/\.Spotlight-V100\/|\/\.cache\/thumbnails\/)/ },
  // desktop.ini names Documents/Start Menu folders and sets their icons: never pre-ticked, never in special folders.
  { id: 'desktopini', label: 'desktop.ini files', icon: '\u{1F5D1}', re: /(^|\/)desktop\.ini$/i,
    skip: (full, ctx) => /\/(Documents|My Documents|Start Menu|Desktop|Pictures|Music|Videos|Downloads|Favorites|Links|Saved Games|Searches|Contacts|AppData|Windows|Program Files[^/]*|ProgramData)\//i.test(ctx.belowTemp(full)) || /\/(Users|home)\/[^/]+\/desktop\.ini$/i.test(full) },
  // Pre-ticked presets: whole-name anchors only, so "MyThumbs.dbs" or "x.Spotlight.project" can never match.
  { id: 'dsstore', label: '.DS_Store files', icon: '\u{1F47B}', re: /(^|\/)\.DS_Store$/ },
  { id: 'thumbs', label: 'Thumbs.db files', icon: '\u{1F5D1}', re: /(^|\/)Thumbs\.db$/i }
];
const CLEANUP_PATH_CAP = 20000;

handleTrusted('cleanup-scan', async () => {
  const cats = CLEANUP_PATTERNS.map(p => ({ id: p.id, label: p.label, icon: p.icon, re: p.re, skip: p.skip, count: 0, totalSize: 0, paths: [] }));
  // Folders holding LevelDB/RocksDB state: any .log inside is a write-ahead log, not a log.
  const dbDirs = new Set();
  for (const f of lastScanAllFiles) {
    if (f.name === 'CURRENT' || (f.name && f.name.startsWith('MANIFEST-'))) dbDirs.add(f.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/'));
  }
  // %TEMP% sits inside AppData on Windows: judge special-folder names only on the part below the temp folder.
  const tmpPrefixes = [];
  for (const t of [require('os').tmpdir(), (() => { try { return fs.realpathSync.native(require('os').tmpdir()); } catch (e) { return ''; } })()]) if (t) tmpPrefixes.push(t.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/');
  const belowTemp = (full) => { const l = full.toLowerCase(); const pre = tmpPrefixes.find(t => l.startsWith(t)); return pre ? '/' + full.slice(pre.length) : full; };
  const ctx = { dbDirs, belowTemp };
  let realRoot = null;
  try { const rr = fs.realpathSync.native(lastScanFolder); if (rr !== lastScanFolder) realRoot = rr.replace(/\\/g, '/'); } catch (e) { /* no root */ }
  const pathCap = (E2E && global.__e2ePathCap) || CLEANUP_PATH_CAP; // E2E-only override so tests can exercise the cap cheaply
  for (const f of lastScanAllFiles) {
    if (f.cloudStatus === 'icloud-only') continue;
    const rp = '/' + String(f.relativePath || f.name).replace(/\\/g, '/');
    for (const c of cats) {
      if (c.re.test(rp)) {
        const full = f.path.replace(/\\/g, '/');
        if (c.skip && c.skip(full, ctx)) break;
        // Files in cloud-synced folders or already in a Trash are never offered (a delete there is felt everywhere / is meaningless).
        if (fileLocationReason(f.path)) break;
        if (realRoot && fileLocationReason(realRoot + '/' + rp.slice(1))) break;   // a symlinked scan root must not hide a blocked place
        // Never offer paths the delete guard would refuse (a single one refuses the whole request).
        if (protectedReason(f.path, true)) break;
        c.count++;
        c.totalSize += f.size;
        if (c.paths.length < pathCap) c.paths.push(f.path);
        break;
      }
    }
  }
  return cats.filter(c => c.count > 0).map(({ re, skip, ...rest }) => ({ ...rest, capped: rest.count > rest.paths.length, cap: pathCap, chunk: (E2E && global.__e2eChunk) || 40000 })).sort((a, b) => b.totalSize - a.totalSize);
});

handleTrusted('find-duplicates', async (event) => {
  const MIN_SIZE = 4096;
  const candidates = lastScanAllFiles.filter(f => f.size >= MIN_SIZE && f.cloudStatus !== 'icloud-only');

  // Full-content hash, streamed with a large buffer.
  function hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = rawFs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on('data', d => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  // Cheap fingerprint: first and last 64KB. Same-size files that differ almost
  // always differ at the head or tail, so this avoids most full reads.
  const SAMPLE = 64 * 1024;
  async function sampleHash(filePath, size) {
    const fh = await rawFs.promises.open(filePath, 'r');
    try {
      const hash = crypto.createHash('sha256');
      const buf = Buffer.alloc(SAMPLE);
      let r = await fh.read(buf, 0, SAMPLE, 0);
      hash.update(buf.subarray(0, r.bytesRead));
      if (size > SAMPLE) {
        r = await fh.read(buf, 0, SAMPLE, Math.max(SAMPLE, size - SAMPLE));
        hash.update(buf.subarray(0, r.bytesRead));
      }
      return hash.digest('hex');
    } finally {
      await fh.close();
    }
  }

  // --- Gold: exact content duplicates ---
  // Step 1: group by size
  const bySize = new Map();
  for (const f of candidates) {
    const key = f.logicalSize;
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key).push(f);
  }

  const sizeGroups = [...bySize.values()].filter(g => g.length >= 2);
  const goldGroups = [];
  let hashed = 0;
  const totalToHash = sizeGroups.reduce((s, g) => s + g.length, 0);

  for (const group of sizeGroups) {
    // Step 2: sample hash (head + tail), several files at once
    const samples = await mapLimit(group, 6, async (f) => {
      try { return await sampleHash(f.path, f.logicalSize); } catch (e) { return null; }
    });
    const quickMap = new Map();
    group.forEach((f, i) => {
      if (samples[i] == null) return;
      if (!quickMap.has(samples[i])) quickMap.set(samples[i], []);
      quickMap.get(samples[i]).push(f);
    });
    hashed += group.length;
    try { event.sender.send('duplicate-progress', { phase: 'hashing', hashed, total: totalToHash }); } catch (e) { /* window closed */ }

    // Step 3: full hash only where the samples matched 2+
    for (const qGroup of quickMap.values()) {
      if (qGroup.length < 2) continue;
      const fulls = await mapLimit(qGroup, 3, async (f) => {
        try { return await hashFile(f.path); } catch (e) { return null; }
      });
      const fullMap = new Map();
      qGroup.forEach((f, i) => {
        if (fulls[i] == null) return;
        if (!fullMap.has(fulls[i])) fullMap.set(fulls[i], []);
        fullMap.get(fulls[i]).push(f);
      });
      for (const fGroup of fullMap.values()) {
        if (fGroup.length >= 2) goldGroups.push(fGroup);
      }
    }
  }

  // Track gold file paths so we don't duplicate them in silver
  const goldPaths = new Set();
  for (const g of goldGroups) {
    for (const f of g) goldPaths.add(f.path);
  }

  // --- Silver & Bronze: name-based grouping ---
  const byName = new Map();
  for (const f of candidates) {
    // Case-sensitive file systems (Linux) can hold README and readme as different files: compare exact names there.
    const key = process.platform === 'linux' ? f.name : f.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }

  const silverGroups = [];
  const bronzeGroups = [];

  for (const [, nameGroup] of byName) {
    if (nameGroup.length < 2) continue;

    // Sub-group by logical size
    const bySz = new Map();
    for (const f of nameGroup) {
      const key = f.logicalSize;
      if (!bySz.has(key)) bySz.set(key, []);
      bySz.get(key).push(f);
    }

    for (const szGroup of bySz.values()) {
      if (szGroup.length >= 2) {
        // Same name + same size: silver (exclude any already in gold)
        const filtered = szGroup.filter(f => !goldPaths.has(f.path));
        if (filtered.length >= 2) {
          silverGroups.push(filtered);
        }
      }
    }

    // If there are multiple different sizes for same name: bronze
    if (bySz.size >= 2) {
      const allInGroup = nameGroup.filter(f => !goldPaths.has(f.path));
      // Only include if we haven't already captured all of them as silver
      const silverPaths = new Set(silverGroups.flat().map(f => f.path));
      const bronzeCandidates = allInGroup.filter(f => !silverPaths.has(f.path));
      if (allInGroup.length >= 2 && bronzeCandidates.length > 0) {
        bronzeGroups.push(allInGroup);
      }
    }
  }

  // Build result with tier labels, sorted by wasted space
  const results = [];
  for (const g of goldGroups) {
    const wasted = g[0].size * (g.length - 1);
    results.push({ tier: 'gold', files: g, wasted, size: g[0].size });
  }
  for (const g of silverGroups) {
    const wasted = g[0].size * (g.length - 1);
    results.push({ tier: 'silver', files: g, wasted, size: g[0].size });
  }
  for (const g of bronzeGroups) {
    const totalSize = g.reduce((s, f) => s + f.size, 0);
    results.push({ tier: 'bronze', files: g, wasted: 0, size: totalSize });
  }

  results.sort((a, b) => b.size - a.size);

  return results;
});

handleTrusted('open-file', async (event, filePath) => {
  filePath = assertAllowedFilePath(filePath);
  return shell.openPath(filePath);
});

handleTrusted('show-in-folder', (event, filePath) => {
  filePath = assertAllowedFilePath(filePath);
  shell.showItemInFolder(filePath);
});

handleTrusted('preview-file', async (event, filePath) => {
  filePath = assertAllowedFilePath(filePath);
  if (process.platform === 'darwin') {
    execFile('qlmanage', ['-p', filePath], (err) => { /* non-fatal */ });
  } else {
    return shell.openPath(filePath);
  }
});

// === File Preview ===

handleTrusted('read-file-preview', async (event, filePath, maxBytes, asDataUrl) => {
  try {
    filePath = assertAllowedFilePath(filePath);
    const stat = await fs.promises.stat(filePath);
    if (asDataUrl) {
      // For images/media, read entire file (up to maxBytes limit if set) and return as data URL
      const limit = maxBytes > 0 ? Math.min(stat.size, maxBytes) : stat.size;
      if (limit > 50 * 1024 * 1024) return null; // Skip files > 50MB for preview
      const buffer = Buffer.alloc(limit);
      const fd = await fs.promises.open(filePath, 'r');
      await fd.read(buffer, 0, limit, 0);
      await fd.close();
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
        tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic', avif: 'image/avif',
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
        mkv: 'video/x-matroska', m4v: 'video/mp4',
        mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
        aac: 'audio/aac', m4a: 'audio/mp4', opus: 'audio/opus'
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      return 'data:' + mime + ';base64,' + buffer.toString('base64');
    } else {
      // For text, read first maxBytes
      const limit = Math.min(stat.size, maxBytes || 10240);
      const buffer = Buffer.alloc(limit);
      const fd = await fs.promises.open(filePath, 'r');
      await fd.read(buffer, 0, limit, 0);
      await fd.close();
      // Check if binary
      for (let i = 0; i < Math.min(limit, 512); i++) {
        if (buffer[i] === 0) return null; // Binary file
      }
      return buffer.toString('utf8');
    }
  } catch (e) {
    return null;
  }
});

// === Disk Space ===

handleTrusted('get-disk-space', async (event, folderPath) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    // statfs works on Windows, macOS and Linux. (wmic, used previously on
    // Windows, is removed from current Windows 11 builds.)
    try {
      const s = await fs.promises.statfs(folderPath, { bigint: true });
      const total = Number(s.blocks * s.bsize);
      const available = Number(s.bavail * s.bsize);
      if (total > 0) return { total, available };
    } catch (e) { /* fall back below */ }
    if (process.platform === 'win32') {
      const drive = path.parse(folderPath).root.replace(/\\/g, '').slice(0, 2);
      if (!/^[A-Za-z]:$/.test(drive)) return null;
      const { stdout } = await execFileP('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$d=[System.IO.DriveInfo]::new('${drive}'); "$($d.TotalSize),$($d.AvailableFreeSpace)"`
      ], { windowsHide: true });
      const [total, available] = stdout.trim().split(',').map(n => parseInt(n, 10) || 0);
      return total > 0 ? { total, available } : null;
    } else {
      const { stdout } = await execFileP('df', ['-k', folderPath]);
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) return null;
      const parts = lines[1].split(/\s+/);
      if (parts.length < 4) return null;
      return { total: (parseInt(parts[1]) || 0) * 1024, available: (parseInt(parts[3]) || 0) * 1024 };
    }
  } catch (e) {
    return null;
  }
});

// === Delete files (Collector) ===

// Hard safety net for deletion. These paths can never be trashed from the app,
// no matter what the user selected, which preset matched, or which folder was
// approved. Checked on both the given path and its symlink-resolved form.
const PROTECTED_HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Movies', 'Videos',
  'Library', 'Applications', 'AppData', 'AppData/Local', 'AppData/Roaming', 'AppData/LocalLow', 'OneDrive', 'iCloud Drive', 'Public'];
const PROTECTED_HOME_SECRETS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config/gcloud', '.azure',
  'Library/Keychains', 'Library/Mobile Documents', 'AppData/Roaming/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Protect', 'AppData/Local/Microsoft/Credentials',
  '.gradle/gradle.properties', '.m2/settings.xml', '.npmrc', '.pypirc', '.netrc', '.config/gh', '.docker/config.json', '.git-credentials', '.terraform.d'];

const WIN_SYS_ROOTS = ['c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata/microsoft',
  'c:/system volume information', 'c:/$recycle.bin', 'c:/boot', 'c:/recovery'];
const POSIX_SYS_ROOTS = ['/system', '/usr', '/bin', '/sbin', '/etc', '/dev', '/cores', '/private/etc', '/private/var/db',
  '/opt/homebrew/bin', '/boot', '/proc', '/sys', '/lib', '/lib64', '/var/lib', '/var/db'];

// lexical: skip the filesystem lookup (used when classifying many scanned paths).
function protectedReason(inputPath, lexical, allowQuarantine) {
  if (!allowQuarantine && quarantine.isQuarantinePath(inputPath)) return 'inside the Stuff Diver quarantine folder';
  const stripLongPrefix = (v) => v.replace(/^\\\\[?.]\\/, '');
  const variants = new Set([path.resolve(stripLongPrefix(inputPath))]);
  // \\host\C$\Windows is the same folder as C:\Windows
  for (const v of [...variants]) {
    const share = /^\\\\[^\\]+\\([a-z])\$(\\.*)?$/i.exec(v);
    if (share) variants.add(path.resolve(share[1] + ':' + (share[2] || '\\')));
  }
  // native realpath also expands Windows 8.3 short names (PROGRA~1)
  if (!lexical) { try { variants.add(stripLongPrefix(fs.realpathSync.native(path.resolve(stripLongPrefix(inputPath))))); } catch (e) { /* missing: judge by name */ } }
  const win = process.platform === 'win32';
  // Windows and macOS volumes are case-insensitive by default
  const ci = win || process.platform === 'darwin';
  const norm = (v) => { const x = v.split(path.sep).join('/').replace(/\/+$/, ''); return ci ? x.toLowerCase() : x; };
  const home = norm(require('os').homedir());
  const insideOrEq = (p, root) => p === root || p.startsWith(root + '/');
  for (const raw of variants) {
    const p = norm(raw) || '/';
    // Windows system folders are protected on every drive letter.
    const pw = win ? p.replace(/^[a-z]:/, 'c:') : p;
    if (p === '/' || /^[a-z]:$/i.test(p)) return 'a drive or filesystem root';
    if (p === home) return 'your home folder';
    for (const r of approvedFolderPaths) if (norm(r) === p) return 'the folder you scanned (delete items inside it instead)';
    if (win) {
      // Folders Smart Cleanup legitimately empties: allowed even though they sit under system roots.
      const cleanable = ['c:/windows/temp', 'c:/windows/softwaredistribution/download', 'c:/windows/minidump', 'c:/$recycle.bin'];
      const exempt = cleanable.some(r => pw !== r && pw.startsWith(r + '/')) || pw === 'c:/windows/memory.dmp';
      const sysRoots = exempt ? [] : WIN_SYS_ROOTS;
      for (const r of sysRoots) if (insideOrEq(pw, r)) return 'a Windows system folder';
      if (/^[a-z]:\/(pagefile|hiberfil|swapfile)\.sys$/.test(p)) return 'a Windows system file';
      if (/^[a-z]:\/users$/.test(p) || /^[a-z]:\/users\/[^/]+$/.test(p)) return 'a user profile folder';
    } else {
      const sysRoots = POSIX_SYS_ROOTS;
      for (const r of sysRoots) if (insideOrEq(p, r)) return 'an operating-system folder';
      if (['/users', '/home', '/volumes', '/applications', '/library', '/private', '/var', '/opt', '/srv', '/mnt', '/media', '/snap', '/root', '/tmp', '/lost+found', '/run'].includes(p)) return 'a top-level system folder';
    }
    // Home-folder rules apply to every user profile, not just the current user
    // (the app may run as SYSTEM, or the path may belong to another account).
    const profile = win ? /^[a-z]:\/users\/[^/]+(\/.*)?$/.exec(p) : process.platform === 'darwin' ? /^\/users\/[^/]+(\/.*)?$/.exec(p) : /^\/home\/[^/]+(\/.*)?$/.exec(p);
    let rel = null;
    if (insideOrEq(p, home)) rel = p.slice(home.length + 1);
    else if (profile) rel = p.split('/').slice(win || process.platform === 'darwin' ? 3 : 3).join('/');
    if (win && pw === 'c:/programdata') return 'the ProgramData folder';
    if (profile && p.split('/').length === 3) return 'a user home folder';
    if (rel) {
      for (const f of PROTECTED_HOME_FOLDERS) if (rel === norm(f)) return `a user's ${f} folder`;
      for (const f of PROTECTED_HOME_SECRETS) if (insideOrEq(rel, norm(f))) return 'a credentials or keychain location';
    }
  }
  return null;
}

// Append-only record of everything trashed (or refused), kept in user data.
// Rotated at ~20 MB (3 files: deletion-log.jsonl, .1, .2).
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const LOG_KEEP = 3;
const LOG_TAIL_BYTES = 20 * 1024 * 1024; // never load more than this from one file
function deletionLogPath(idx = 0) { return path.join(app.getPath('userData'), 'deletion-log.jsonl' + (idx ? '.' + idx : '')); }
let logCache = new Map(); // idx -> { key, entries (oldest first) }
// Returns null on success, else an error message (callers surface it; logging never blocks the delete itself).
async function logDeletion(entries) {
  if (!entries.length) return null;
  try {
    const p = deletionLogPath();
    let size = 0;
    try { size = (await fs.promises.stat(p)).size; } catch (e) { /* new log */ }
    if (size > LOG_ROTATE_BYTES) {
      for (let i = LOG_KEEP - 1; i >= 1; i--) {
        const from = deletionLogPath(i - 1);
        if (fs.existsSync(from)) await fs.promises.rename(from, deletionLogPath(i));
      }
      logCache = new Map();
    }
    await fs.promises.appendFile(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    return null;
  } catch (e) { return 'Could not write the deletion log: ' + (e.message || e); }
}

// Parsed log (oldest first), cached until the file changes. Reads at most the last LOG_TAIL_BYTES.
async function readLogEntries(idx) {
  const p = deletionLogPath(idx);
  let st;
  try { st = await fs.promises.stat(p); } catch (e) { return []; }
  const key = st.size + ':' + st.mtimeMs;
  const hit = logCache.get(idx);
  if (hit && hit.key === key) return hit.entries;
  let text;
  if (st.size > LOG_TAIL_BYTES) {
    const fh = await fs.promises.open(p, 'r');
    try {
      const buf = Buffer.alloc(LOG_TAIL_BYTES);
      await fh.read(buf, 0, LOG_TAIL_BYTES, st.size - LOG_TAIL_BYTES);
      text = buf.toString('utf8');
      text = text.slice(text.indexOf('\n') + 1); // drop the cut first line
    } finally { await fh.close(); }
  } else text = await fs.promises.readFile(p, 'utf8');
  const entries = [];
  for (const l of text.split('\n')) { if (!l) continue; try { entries.push(JSON.parse(l)); } catch (e) { /* skip bad line */ } }
  logCache.set(idx, { key, entries });
  return entries;
}

handleTrusted('get-deletion-log', async (event, limit) => {
  const n = Math.max(1, Math.min(Number(limit) || 500, 5000));
  return (await readLogEntries(0)).slice(-n).reverse();
});

handleTrusted('reveal-deletion-log', async () => {
  const p = deletionLogPath();
  if (fs.existsSync(p)) shell.showItemInFolder(p);
  return fs.existsSync(p);
});

const FILE_REQUEST_CAP = 50000;
const trashFn = (p) => (E2E && typeof global.__e2eTrash === 'function') ? global.__e2eTrash(p) : shell.trashItem(p); // E2E-only hook can simulate platform quirks
// Location rules shared by the Smart Cleanup file list and delete-files: ONE function, no flags, so the two can never drift.
function fileLocationReason(fp) {
  if (quarantine.isQuarantinePath(fp)) return 'inside the Stuff Diver quarantine folder (restore or move it to the Trash from the Quarantine window)';
  if (cleanupFolders.cloudSyncedReason(fp)) return 'in a cloud-synced folder: deleting here deletes it everywhere';
  if (cleanupFolders.trashReason(fp)) return 'already in a Trash or Recycle Bin (it cannot be moved to the Trash again)';
  const app = cleanupFolders.installedAppReason(fp);
  if (app) return app + ' (removing files there breaks the app\'s signature or install)';
  return null;
}
// The same rules applied to where the file REALLY is (a symlinked parent or scan root must not hide a blocked place).
function realFileLocation(fp, dirCache) {
  const dir = path.dirname(fp);
  let rd = dirCache.get(dir);
  if (rd === undefined) { try { rd = fs.realpathSync.native(dir); } catch (e) { rd = null; } dirCache.set(dir, rd); }
  return rd ? path.join(rd, path.basename(fp)) : null;
}
// Per-file checks shared by the first pass and the re-check after the confirmation dialog.
function checkFilePaths(paths) {
  const blocked = [];
  const dirCache = new Map();
  for (const fp of paths) {
    const reason = protectedReason(fp);
    if (reason) { blocked.push({ path: fp, reason }); continue; }
    const loc = fileLocationReason(fp);
    if (loc) { blocked.push({ path: fp, reason: loc }); continue; }
    const real = realFileLocation(fp, dirCache);
    if (real && real !== fp) {
      const pr2 = protectedReason(real, true); if (pr2) { blocked.push({ path: fp, reason: `${pr2} (it resolves to ${real})` }); continue; }
      const loc2 = fileLocationReason(real);
      if (loc2) { blocked.push({ path: fp, reason: `${loc2} (it resolves to ${real})` }); continue; }
    }
    // This handler only trashes files. Folders go through delete-folders and its safeguards.
    try {
      const st = fs.lstatSync(fp);
      if (st.isSymbolicLink()) {
        // A link is trashed as the link itself, but only when it points at a file.
        let tstat = null; try { tstat = fs.statSync(fp); } catch (e) { /* dangling */ }
        if (tstat && !tstat.isFile()) blocked.push({ path: fp, reason: 'a link to a folder (folders are only cleaned through Smart Cleanup folder checks)' });
      } else if (!st.isFile()) {
        blocked.push({ path: fp, reason: st.isDirectory() ? 'a folder, not a file (folders are only cleaned through Smart Cleanup folder checks)' : 'not a regular file' });
      }
    } catch (e) { /* missing: trashItem will report it as failed */ }
  }
  return blocked;
}

let fileDeleteBusy = false;
handleTrusted('delete-files', async (event, filePaths, source) => {
  if (!Array.isArray(filePaths) || !filePaths.length) return { deleted: 0, deletedPaths: [] };
  if (fileDeleteBusy) return { deleted: 0, deletedPaths: [], error: 'Another cleanup is already running. Nothing was moved.' };
  fileDeleteBusy = true;
  try { return await deleteFilesImpl(filePaths, source); } finally { fileDeleteBusy = false; }
});
// The path as it is spelled on disk (matters on case-insensitive volumes where the request may be lower-cased).
function onDiskPath(fp, listCache) {
  const ciFs = process.platform === 'win32' || process.platform === 'darwin';
  if (!ciFs) return fp;
  const real = realFileLocation(fp, listCache.dirs);
  if (!real) return fp;
  const dir = path.dirname(real);
  let names = listCache.names.get(dir);
  if (!names) { try { names = fs.readdirSync(dir); } catch (e) { names = []; } listCache.names.set(dir, names); }
  const base = path.basename(real).toLowerCase();
  const exact = names.find(n => n.toLowerCase() === base);
  const cand = exact ? path.join(dir, exact) : real;
  // Only the spelling is corrected: a different real location (symlinked root) keeps the path the user saw.
  return cand.toLowerCase() === fp.toLowerCase() ? cand : fp;
}
async function deleteFilesImpl(filePaths, source) {
  // Cheap request-level checks first, before any per-path work.
  if (filePaths.length > FILE_REQUEST_CAP) return { deleted: 0, deletedPaths: [], error: `Refused: ${filePaths.length} files in one request, the limit is ${FILE_REQUEST_CAP}. Nothing was moved.` };
  if (!filePaths.every(p => typeof p === 'string')) return { deleted: 0, deletedPaths: [], error: 'Refused: invalid file path in request. Nothing was moved.' };
  if (filePaths.some(p => p.includes('\0'))) return { deleted: 0, deletedPaths: [], error: 'Refused: a path contains a NUL character. Nothing was moved.' };
  if (!filePaths.every(p => path.isAbsolute(p))) {
    return { deleted: 0, deletedPaths: [], error: 'Refused: file paths must be absolute. Nothing was moved.' };
  }
  const safePaths = [];
  const seen = new Set();
  const ciFiles = process.platform === 'win32' || process.platform === 'darwin';
  try {
    for (const fp of filePaths) {
      const r = assertAllowedFilePath(fp);
      const key = ciFiles ? r.toLowerCase() : r;
      if (seen.has(key)) continue; // the same file listed twice is one file
      seen.add(key);
      safePaths.push(r);
    }
  } catch (e) {
    return { deleted: 0, deletedPaths: [], error: e.message || 'Invalid file path' };
  }

  // All-or-nothing: one protected path refuses the whole request.
  const blocked = checkFilePaths(safePaths);
  if (blocked.length) {
    const now = Date.now();
    const logError = await logDeletion(blocked.map(b => ({ t: now, path: b.path, status: 'blocked', reason: b.reason, source: source || 'collector' })));
    return {
      deleted: 0, deletedPaths: [], blocked, ...(logError ? { logError } : {}),
      error: `Refused: ${cleanupFolders.safeText(blocked[0].path)} is ${blocked[0].reason}.` + (blocked.length > 1 ? ` (+${blocked.length - 1} more refused)` : '') + ' Nothing was moved.'
    };
  }

  const sizeByPath = new Map();
  const infoByPath = new Map();
  const want = new Set(safePaths);
  for (const f of lastScanAllFiles) if (want.has(f.path)) { sizeByPath.set(f.path, f.size); infoByPath.set(f.path, { rel: f.relativePath, size: f.size, logicalSize: f.logicalSize }); }
  const listCache = { dirs: new Map(), names: new Map() };

  const hidden = safePaths.some(p => /(^|[\\/])(\.DS_Store|Thumbs\.db)$/i.test(p));
  const result = E2E ? { response: 1 } : await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Move to Trash'],
    defaultId: 0,
    cancelId: 0,
    title: 'Delete Files',
    message: `Move ${safePaths.length} file${safePaths.length > 1 ? 's' : ''} (${formatSizeMain(safePaths.reduce((a, p) => a + (sizeByPath.get(p) || 0), 0))}) to trash?`,
    detail: (hidden ? 'This includes hidden metadata files (.DS_Store / Thumbs.db) that the system recreates when needed.\n\n' : '') +
      `Largest ${Math.min(10, safePaths.length)}:\n` + [...safePaths].sort((a, b) => (sizeByPath.get(b) || 0) - (sizeByPath.get(a) || 0)).slice(0, 10).map(p => `${formatSizeMain(sizeByPath.get(p) || 0)}  ${cleanupFolders.safeText(p)}`).join('\n') +
      '\n\nThey are moved to the Trash (macOS/Linux) or Recycle Bin (Windows); nothing is permanently deleted, and you can restore them from there. Each one is recorded in the deletion log.'
  });

  if (result.response !== 1) return { deleted: 0, deletedPaths: [] };

  // The dialog can sit open for a long time: check everything again before touching anything.
  if (E2E && typeof global.__e2eAfterDialog === 'function') await global.__e2eAfterDialog();
  const changed = checkFilePaths(safePaths);
  if (changed.length) {
    const now = Date.now();
    const logError = await logDeletion(changed.map(b => ({ t: now, path: b.path, status: 'blocked', reason: 'changed before delete: ' + b.reason, source: source || 'collector' })));
    return { deleted: 0, deletedPaths: [], blocked: changed, ...(logError ? { logError } : {}), error: `Refused: ${cleanupFolders.safeText(changed[0].path)} changed before it could be deleted (${changed[0].reason}). Nothing was moved.` };
  }

  const deletedPaths = [], removedPaths = [], goneBefore = [], failures = [];
  let logError = null;
  for (const fp of safePaths) {
    const entry = { t: Date.now(), path: onDiskPath(fp, listCache), size: sizeByPath.get(fp) ?? null, source: source || 'collector' };
    let rec;
    // A stale list can name files that vanished before this run: say so instead of calling it a removal.
    let existsNow = true; try { fs.lstatSync(fp); } catch (e) { existsNow = e.code !== 'ENOENT'; }
    if (!existsNow) {
      goneBefore.push(fp);
      logError = (await logDeletion([{ ...entry, status: 'gone', reason: 'already gone before this run (stale list); nothing was moved' }])) || logError;
      continue;
    }
    try {
      await trashFn(fp);
      deletedPaths.push(fp);
      rec = { ...entry, status: 'trashed' };
    } catch (e) {
      console.error('Failed to trash:', fp, e.message);
      // Some platforms (macOS with .DS_Store) report an error although the file is gone: record what is really there now.
      let gone = false; try { fs.lstatSync(fp); } catch (er) { gone = er.code === 'ENOENT'; }
      if (gone) {
        removedPaths.push(fp);
        rec = { ...entry, status: 'removed', reason: 'the system reported an error but the file is gone; it may not be in the Trash (' + osErrorReason(e) + ')' };
      } else {
        rec = { ...entry, status: 'failed', finalState: 'untouched', reason: await trashFailureReason(e, fp, sizeByPath.get(fp)) };
        failures.push({ path: fp, reason: rec.reason, state: 'failed', finalState: 'untouched' });
      }
    }
    logError = (await logDeletion([rec])) || logError; // written per item: a crash mid-batch loses nothing
  }
  if (deletedPaths.length || removedPaths.length || goneBefore.length) {
    const gone = new Set([...deletedPaths, ...removedPaths, ...goneBefore]);
    lastScanAllFiles = lastScanAllFiles.filter(f => !gone.has(f.path));
  }
  return { deleted: deletedPaths.length, deletedPaths, removed: removedPaths.length, removedPaths, alreadyGone: goneBefore.length, alreadyGonePaths: goneBefore, goneInfo: [...deletedPaths, ...removedPaths, ...goneBefore].map(p => infoByPath.get(p)).filter(Boolean), failures, ...(logError ? { logError } : {}) };
}


// === Folder-level Smart Cleanup ===

// Reason if `folder` IS or CONTAINS a location protectedReason() guards: the
// folder equals/encloses home, a standard home folder, a credentials store,
// an OS folder or the scanned folder. (protectedReason covers "inside of".)
function containsProtected(folder) {
  const win = process.platform === 'win32';
  const ci = win || process.platform === 'darwin';
  const norm = (v) => { let x = v.split(path.sep).join('/').replace(/\/+$/, ''); if (ci) x = x.toLowerCase(); return win ? x.replace(/^[a-z]:/, 'c:') : x; };
  const f = norm(path.resolve(folder));
  const home = require('os').homedir();
  const anchors = [[home, 'your home folder']];
  for (const n of PROTECTED_HOME_FOLDERS) anchors.push([path.join(home, n), `a user's ${n} folder`]);
  for (const n of PROTECTED_HOME_SECRETS) anchors.push([path.join(home, n), 'a credentials or keychain location']);
  for (const r of approvedFolderPaths) anchors.push([r, 'the folder you scanned']);
  for (const r of win ? WIN_SYS_ROOTS : POSIX_SYS_ROOTS) anchors.push([r, 'an operating-system folder']);
  for (const [a, why] of anchors) {
    const n = norm(a);
    if (n === f || n.startsWith(f + '/')) return `contains ${why} (${a})`;
  }
  return null;
}

const walkFs = () => (E2E && global.__e2eFs) || rawFs; // E2E tests can inject a fake filesystem (mount-point simulation)
const mountList = () => (E2E && typeof global.__e2eMounts === 'function') ? global.__e2eMounts() : cleanupFolders.getMountPoints(); // fresh on every call
const sendFolderProgress = (phase, done, total, p) => {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('folder-delete-progress', { phase, done, total, path: p }); } catch (e) { /* UI gone */ }
};
const osErrorReason = (e) => {
  const code = e.code || (/\b(E[A-Z]{3,}|ERROR_[A-Z_]+)\b/.exec(e.message || '') || [])[1];
  return (code && !String(e.message).includes(code) ? code + ': ' : '') + (e.message || String(e));
};
const devFoldersOn = () => loadSettings().developerFolderCleanup === true;
// Windows' trash API only says "Operation was aborted": find out cheaply WHY (first file that cannot be opened for writing).
async function diagnoseTrashFailure(p, size) {
  const started = Date.now();
  let cap = null;
  try { const sf = fs.statfsSync(p); cap = cleanupFolders.capacityHint(size, Number(sf.blocks) * Number(sf.bsize)); } catch (e) { /* statfs unavailable */ }
  const generic = (cap ? cap + '; otherwise ' : '') + 'a file in the folder is open in another program, you lack permission, or it is too large for the Recycle Bin';
  try {
    const st = fs.lstatSync(p);
    const stack = [p]; let budget = 5000;
    while (stack.length && budget > 0 && Date.now() - started < 1500) {
      const cur = stack.pop();
      let ents;
      if (cur === p && !st.isDirectory()) ents = [{ name: '', isDirectory: () => false, isSymbolicLink: () => false }];
      else { try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { return `${e.code || 'error'} reading ${cur}`; } }
      for (const e of ents) {
        if (--budget < 0) break;
        const full = e.name ? path.join(cur, e.name) : cur;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { stack.push(full); continue; }
        try { fs.closeSync(fs.openSync(full, 'r+')); } catch (er) { if (['EBUSY', 'EPERM', 'EACCES'].includes(er.code)) return `${er.code}: ${full} cannot be opened for writing (in use or no permission)`; }
      }
      if (cur !== p || st.isDirectory()) await new Promise(r => setImmediate(r));
    }
  } catch (e) { /* fall through */ }
  return generic;
}
const trashFailureReason = async (e, p, size) => {
  const base = osErrorReason(e);
  return (process.platform === 'win32' || !(e && e.code)) ? `${base} (${await diagnoseTrashFailure(p, size)})` : base;
};
const FOLDER_BATCH_CAP = 500;
const FOLDER_SCAN_CAP = 2000;

// Full delete-time verification of one folder. Returns {ok:true, ...info} or {ok:false, reason}.
let folderDeleteCancel = false;
// Working directories of running processes, memoised for a few seconds (lsof is slow on big machines).
let cwdMemo = { t: 0, v: null };
function currentCwds() {
  if (E2E && typeof global.__e2eCwds === 'function') return global.__e2eCwds();
  if (Date.now() - cwdMemo.t > 3000) cwdMemo = { t: Date.now(), v: cleanupFolders.runningCwds() };
  return cwdMemo.v;
}
async function evaluateFolder(fp) {
  cleanupFolders.setElevated(await detectElevated());
  let resolved;
  try { resolved = assertAllowedFilePath(fp); } catch (e) { return { ok: false, path: String(fp), reason: 'is outside the scanned folder' }; }
  const fail = (reason) => ({ ok: false, path: resolved, reason });
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const eq = (a, b) => ci ? a.toLowerCase() === b.toLowerCase() : a === b;
  const pr = protectedReason(resolved);
  if (pr) return fail(`is ${pr}`);
  const cp = containsProtected(resolved);
  if (cp) return fail(cp);
  // The real location (symlinked ancestors, 8.3 short names, subst drives) is judged by the same rules.
  let realNow = null;
  try { realNow = fs.realpathSync.native(resolved); } catch (e) { /* handled below */ }
  if (realNow && realNow !== resolved) {
    const rp2 = protectedReason(realNow, true); if (rp2) return fail(`resolves to ${realNow}, which is ${rp2}`);
    const cp2 = containsProtected(realNow); if (cp2) return fail(`resolves to ${realNow}, which ${cp2}`);
  }
  const c = cleanupFolders.classifyFolder(resolved, walkFs());
  if (!c) return fail('is not a recognised regenerable folder (marker missing or changed)');
  if (c.refused) return fail(c.refused);
  // Real location must be exactly where the scan saw it: no symlinked ancestor swapped in below the scanned root.
  try {
    const root = [...approvedFolderPaths].find(r => cleanupFolders.isInside(resolved, r, ci));
    const expected = path.join(fs.realpathSync.native(root), path.relative(root, resolved));
    if (!eq(fs.realpathSync.native(resolved), expected)) return fail('resolves to a different location than the scanned path (symlink or junction involved)');
  } catch (e) { return fail('cannot be resolved (' + (e.code || e.message) + ')'); }
  const mc = cleanupFolders.mountConflict([resolved, realNow], mountList(), ci);
  if (mc) return fail(mc);
  if (cleanupFolders.deviceDiffersFromParent(resolved, walkFs())) return fail('is on a different device than its parent folder (mount or volume boundary)');
  const w = await cleanupFolders.inspectFolder(resolved, walkFs(), undefined, () => folderDeleteCancel, c);
  if (w.error) return fail(w.error);
  if (w.git) return fail(`contains a version-control folder or file (${w.git}), so it may hold a repository`);
  if (w.userDoc) return fail(`contains ${w.userDoc}, a document that does not belong in ${c.label}`);
  if (w.forbidden) return fail(`contains ${w.forbidden}, an Xcode archive that cannot be rebuilt`);
  for (const d of w.dirs) {
    const dr = protectedReason(d, true);
    if (dr) return fail(`contains ${d}, which is ${dr}`);
  }
  const sig = cleanupFolders.projectSignals(resolved, c.kind, { fsx: walkFs(), cwds: currentCwds() });
  if (sig.severe) return fail(sig.severe);
  return { ok: true, path: resolved, logPath: realNow || resolved, kind: c.kind, label: c.label, reason: c.reason, size: w.bytes, files: w.files, newest: w.newest, warnings: sig.warnings };
}

// === Quarantine (developer-folder cleanup): same-volume rename into a hidden dated folder, with a manifest ===
const quarantineOn = () => loadSettings().useQuarantine !== false;
const quarantineHome = () => (E2E && process.env.STUFFDIVER_E2E_QHOME) || require('os').homedir();
function quarantineRootProblem(root) {
  const c = cleanupFolders.cloudSyncedReason(root); if (c) return 'is cloud-synced';
  const t = cleanupFolders.trashReason(root); if (t) return t;
  const a = cleanupFolders.installedAppReason(root); if (a) return a;
  const pr = protectedReason(root, false, true); if (pr) return 'is ' + pr;
  try { // judge where the parent really is (symlinked home, subst drives, 8.3 names)
    const real = fs.realpathSync.native(path.dirname(root));
    const rc = cleanupFolders.cloudSyncedReason(real) ? 'is cloud-synced' : (cleanupFolders.trashReason(real) || null); if (rc) return rc;
  } catch (e) { /* parent missing: the volume probe handles it */ }
  return null;
}
// Rules a restore destination must pass (same family as evaluateFolder: protected, cloud, trash, bundle, mount, real path).
function restoreDestProblem(dest) {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const pr = protectedReason(dest); if (pr) return pr;
  const cp = containsProtected(dest); if (cp) return cp;
  if (cleanupFolders.cloudSyncedReason(dest)) return 'in a cloud-synced folder';
  const tr = cleanupFolders.trashReason(dest); if (tr) return tr.replace(/^is /, 'in a Trash: ');
  const ia = cleanupFolders.installedAppReason(dest); if (ia) return ia;
  let real = null;
  try { real = path.join(fs.realpathSync.native(path.dirname(dest)), path.basename(dest)); } catch (e) { return 'in a folder that cannot be resolved'; }
  if (real !== dest) {
    const r2 = protectedReason(real, true); if (r2) return `at ${real}, which is ${r2}`;
    const c2 = containsProtected(real); if (c2) return `at ${real}, which ${c2}`;
    if (cleanupFolders.cloudSyncedReason(real)) return `at ${real}, a cloud-synced folder`;
    if (cleanupFolders.trashReason(real)) return `at ${real}, a Trash`;
  }
  const mc = cleanupFolders.mountConflict([dest, real], mountList(), ci); if (mc) return mc;
  return null;
}
// Identifies this account on a shared volume top (every user of the machine shares D:\.StuffDiverQuarantine or /Volumes/X/...).
let sidCache = null;
function currentSid() {
  if (sidCache) return sidCache;
  try {
    const out = execFileSyncText('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
    const m = /"(S-1-[0-9-]+)"/.exec(out);
    if (m) sidCache = m[1];
  } catch (e) { /* unknown */ }
  return sidCache;
}
function legacyOwnerHash() {
  let name = ''; try { name = require('os').userInfo().username; } catch (e) { /* unknown */ }
  return 'u-' + crypto.createHash('sha256').update(name.toLowerCase() + '|' + require('os').homedir().toLowerCase()).digest('hex').slice(0, 12);
}
function quarantineOwner() {
  if (typeof process.getuid === 'function') return 'uid-' + process.getuid();
  const sid = currentSid();   // the account's SID survives renames and profile moves
  return sid ? 'sid-' + sid : legacyOwnerHash();
}
// Makes a per-user folder on a shared drive private to this account (explicit ACL, no inheritance) and checks who owns it.
function secureWindowsDir(dir) {
  const sid = currentSid();
  if (!sid) throw new Error('the account SID cannot be determined');
  execFileSyncText('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  const owner = execFileSyncText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${dir.replace(/'/g, "''")}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value`]).trim();
  if (owner !== sid && owner !== 'S-1-5-32-544') throw new Error(`${dir} is owned by ${owner}, not by this account`);
}
// Windows: only FIXED local disks are used (mapped network drives, removable drives and anything unknown are not).
const driveTypeCache = new Map();
function quarantineDriveType(letter) {
  if (!/^[A-Z]$/.test(letter)) return null;
  if (E2E && typeof global.__e2eDriveType === 'function') return global.__e2eDriveType(letter);
  return driveTypeCache.has(letter) ? driveTypeCache.get(letter) : null;   // filled by prefetchDriveTypes(); a miss means "not allowed"
}
// Async (3 s limit per drive) so a slow or failing PowerShell never blocks the main process; failures are cached as "unknown".
// USB / FireWire / SD buses count as removable even though Windows reports the drive as Fixed.
async function prefetchDriveTypes(paths) {
  if (process.platform !== 'win32' || (E2E && typeof global.__e2eDriveType === 'function')) return;
  for (const l of new Set(paths.map(p => (/^([a-zA-Z]):[\\/]/.exec(p) || [])[1]).filter(Boolean).map(x => x.toUpperCase()))) {
    if (driveTypeCache.has(l)) continue;
    const script = `$t=(New-Object System.IO.DriveInfo('${l}')).DriveType; $b=''; try { $b=(Get-Partition -DriveLetter ${l} -ErrorAction Stop | Get-Disk -ErrorAction Stop).BusType } catch {}; "$t|$b"`;
    const out = await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 3000, windowsHide: true }, (e, so) => res(e ? '' : String(so).trim())));
    const m = /^(Fixed|Removable|Network|CDRom|Ram|NoRootDirectory|Unknown)\|(.*)$/.exec(out);
    let t = m ? m[1] : 'Unknown';
    if (m && t === 'Fixed' && /^(USB|1394|SD|MMC|iSCSI)$/i.test(m[2])) t = 'Removable (' + m[2] + ' disk)';
    driveTypeCache.set(l, t);
  }
}
// macOS/Linux: network, FUSE and removable/external volumes are never used as a quarantine root.
const BAD_FSTYPES = /^(nfs\d*|cifs|smb3?|smbfs|afpfs|webdav|fuse(\..*)?|fuseblk|macfuse|osxfuse|sshfs|9p|davfs|afs|ceph|glusterfs|vboxsf|vfat|exfat|msdos|ntfs3?)$/i;
function quarantineVolumeProblem(root) {
  if (E2E && typeof global.__e2eVolumeProblem === 'function') { const r = global.__e2eVolumeProblem(root); if (r !== undefined) return r; }
  const inside = (m) => root === m || root.startsWith(m.endsWith('/') ? m : m + '/');
  try {
    let best = null; // longest mount point containing root
    if (process.platform === 'linux') {
      for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
        const f = line.split(' '), dash = f.indexOf('-');
        if (f.length < 8 || dash < 0) continue;
        const mp = f[4].replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
        if (inside(mp) && (!best || mp.length > best.mp.length)) best = { mp, fstype: f[dash + 1], majmin: f[2] };
      }
      if (best && BAD_FSTYPES.test(best.fstype)) return `is on a ${best.fstype} volume (network, FUSE or removable-type filesystem)`;
      if (best && best.majmin) {   // removable media / USB device behind the mount
        try {
          const real = fs.realpathSync('/sys/dev/block/' + best.majmin);
          const seg = real.split('/'), bi = seg.lastIndexOf('block');
          const disk = bi >= 0 ? seg[bi + 1] : seg[seg.length - 1];
          let removable = '0'; try { removable = fs.readFileSync(`/sys/block/${disk}/removable`, 'utf8').trim(); } catch (e) { /* not a disk */ }
          if (removable === '1' || /\/usb\d/.test(real)) return 'is on removable or USB media';
        } catch (e) { /* virtual device (overlay, tmpfs): not removable media */ }
      }
    } else if (process.platform === 'darwin') {
      for (const line of execFileSyncText('/sbin/mount', []).split('\n')) {
        const m = /^(.+?) on (\/.*?) \(([^)]*)\)$/.exec(line);
        if (m && inside(m[2]) && (!best || m[2].length > best.mp.length)) best = { mp: m[2], opts: m[3].split(',').map(x => x.trim()) };
      }
      if (best) {
        if (BAD_FSTYPES.test(best.opts[0]) || !best.opts.includes('local')) return `is on a network or non-local volume (${best.opts[0]})`;
        if (best.mp !== '/' && !best.mp.startsWith('/System/Volumes/')) {
          const info = execFileSyncText('/usr/sbin/diskutil', ['info', best.mp]);
          if (/Removable Media:\s+Removable/i.test(info) || /Device Location:\s+External/i.test(info) || /Protocol:\s+USB/i.test(info)) return 'is on a removable or external disk';
        }
      }
    }
  } catch (e) { return 'the volume type cannot be determined'; }
  return null;
}
const execFileSyncText = (cmd, args) => require('child_process').execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 });
function quarantineCtx() {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  return {
    owner: quarantineOwner(), legacyOwners: process.platform === 'win32' ? [legacyOwnerHash()] : [], secureDir: (E2E && typeof global.__e2eSecureDir === 'function') ? global.__e2eSecureDir : (process.platform === 'win32' ? secureWindowsDir : null), driveType: quarantineDriveType, volumeProblem: quarantineVolumeProblem,
    platform: process.platform, home: quarantineHome(), fsx: rawFs, uid: typeof process.getuid === 'function' ? process.getuid() : null,
    mounts: () => mountList(), rootOk: quarantineRootProblem, destReason: restoreDestProblem,
    rename: (E2E && typeof global.__e2eRename === 'function') ? global.__e2eRename : null,
    hide: (dir) => { if (process.platform === 'win32') execFile('attrib', ['+h', dir], () => {}); },
    inspect: (dir) => cleanupFolders.inspectFolder(dir, rawFs, undefined, null, null),
    // A restore may only land inside a folder approved in this session or inside the (unprotected) scan root recorded in the manifest.
    destAllowed: (dest, scanRoot) => {
      if ([...approvedFolderPaths].some(r => cleanupFolders.isInside(dest, r, ci))) return true;
      return !!(scanRoot && path.isAbsolute(scanRoot) && cleanupFolders.isInside(dest, scanRoot, ci) && !protectedReason(scanRoot, true) && !containsProtected(scanRoot));
    },
    canRecreate: (parent, scanRoot) => {
      if (!scanRoot || !path.isAbsolute(scanRoot) || !cleanupFolders.isInside(parent, scanRoot, ci)) return false;
      try { if (!fs.statSync(scanRoot).isDirectory()) return false; } catch (e) { return false; }
      if (protectedReason(parent) || containsProtected(parent) || cleanupFolders.cloudSyncedReason(parent) || cleanupFolders.trashReason(parent) || cleanupFolders.installedAppReason(parent)) return false;
      let anc = parent;   // the folders to create do not exist yet: judge the nearest one that does
      while (!fs.existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
      return !restoreDestProblem(path.join(anc, '.sd-probe'));
    }
  };
}
function quarantineRoots() {
  const roots = quarantine.readRegistry(app.getPath('userData'));
  const home = path.join(quarantineHome(), quarantine.QDIR);
  if (!roots.includes(home)) roots.push(home);
  return roots;
}

handleTrusted('cleanup-folders-scan', async () => {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  if (!devFoldersOn()) return { candidates: [], totalFound: 0, shown: 0, cap: FOLDER_SCAN_CAP, disabled: true };
  if (!lastScanFolder) return { candidates: [], totalFound: 0, shown: 0, cap: FOLDER_SCAN_CAP };
  cleanupFolders.setElevated(await detectElevated());
  const found = cleanupFolders.findCandidates(lastScanAllFiles, lastScanFolder, ci, walkFs(), mountList(), currentCwds());
  const now = Date.now();
  const out = found.map(c => {
    let refused = protectedReason(c.path, true) ? `is ${protectedReason(c.path, true)}` : containsProtected(c.path);
    if (!refused && c.refusedReason) refused = c.refusedReason;
    if (!refused && c.hasGit) refused = 'contains a .git or other version-control folder, so it may hold a repository';
    if (!refused && c.userDoc) refused = `contains ${c.userDoc}, a document that does not belong in ${c.label}`;
    if (!refused && c.forbidden) refused = `contains ${c.forbidden}, an Xcode archive that cannot be rebuilt`;
    const ageDays = c.newest ? Math.max(0, Math.floor((now - c.newest) / 86400000)) : null;
    const recent = ageDays !== null && ageDays < cleanupFolders.RECENT_DAYS;
    const many = c.files > cleanupFolders.MANY_FILES;
    const warnings = [...(c.signals || [])];
    if (recent) warnings.push(`modified ${ageDays === 0 ? 'today' : ageDays + ' day(s) ago'}: probably in use`);
    if (many) warnings.push(`${c.files.toLocaleString()} files: review before cleaning`);
    if (c.defaultOff) warnings.push('may contain packages installed by hand');
    return {
      path: c.path, relPath: path.relative(lastScanFolder, c.path).split(path.sep).join('/'),
      kind: c.kind, label: c.label, icon: c.icon, reason: c.reason, restore: c.restore,
      size: c.size, files: c.files, newest: c.newest, ageDays, warnings,
      refused: refused || null,
      // Nothing is pre-ticked: every folder is the user's deliberate choice.
      defaultChecked: false
    };
  }).sort((a, b) => b.size - a.size);
  return { candidates: out.slice(0, FOLDER_SCAN_CAP), totalFound: out.length, shown: Math.min(out.length, FOLDER_SCAN_CAP), cap: FOLDER_SCAN_CAP };
});

let folderDeleteBusy = false;
handleTrusted('cancel-folder-delete', async () => { folderDeleteCancel = true; return folderDeleteBusy; });
handleTrusted('delete-folders', async (event, folderPaths, source) => {
  const src = source || 'smart-cleanup-folders';
  const nothing = { deleted: 0, deletedPaths: [], freedBytes: 0 };
  if (!Array.isArray(folderPaths) || !folderPaths.length) return nothing;
  // Request-level checks first, before any per-path work (a huge array must not freeze the main process).
  if (folderPaths.length > FOLDER_BATCH_CAP) return { ...nothing, error: `Refused: ${folderPaths.length} folders selected, the limit is ${FOLDER_BATCH_CAP} per run. Nothing was changed.` };
  if (!devFoldersOn()) return { ...nothing, error: 'Refused: developer folder cleanup is switched off. Nothing was moved.' };
  if (folderDeleteBusy) return { ...nothing, error: 'Another folder cleanup is already running.' };
  folderDeleteBusy = true;
  try {
    const ci = process.platform === 'win32' || process.platform === 'darwin';
    const strings = folderPaths.filter(p => typeof p === 'string' && p);
    if (strings.length !== folderPaths.length) return { ...nothing, error: 'Refused: invalid folder path in request.' };
    if (strings.some(p => p.includes('\0'))) return { ...nothing, error: 'Refused: a path contains a NUL character. Nothing was moved.' };
    if (!strings.every(p => path.isAbsolute(p))) return { ...nothing, error: 'Refused: folder paths must be absolute. Nothing was moved.' };
    const { kept, dropped } = cleanupFolders.dedupeNested(strings.map(p => path.resolve(p)), ci);
    if (kept.length > FOLDER_BATCH_CAP) {
      return { ...nothing, error: `Refused: ${kept.length} folders selected, the limit is ${FOLDER_BATCH_CAP} per run. Nothing was changed.` };
    }
    folderDeleteCancel = false;
    // Cancelled before anything moved: every requested item is accounted for in the log.
    const cancelledEarly = async () => {
      const t = Date.now();
      const le = await logDeletion(kept.map(k => ({ t, path: k, type: 'folder', status: 'skipped', reason: 'cancelled before anything was moved', source: src })));
      return { ...nothing, cancelled: true, skipped: kept.length, ...(le ? { logError: le } : {}), error: 'Cancelled. Nothing was moved.' };
    };
    const checks = [];
    for (const k of kept) {
      sendFolderProgress('verify', checks.length, kept.length, k);
      checks.push(await evaluateFolder(k));
      if (folderDeleteCancel) return cancelledEarly();
    }
    const blocked = checks.filter(c => !c.ok);
    if (blocked.length) {
      const now = Date.now();
      const le = await logDeletion(blocked.map(b => ({ t: now, path: b.path, status: 'blocked', reason: b.reason, source: src, type: 'folder' })));
      const list = blocked.slice(0, 10).map(b => `${b.path} ${b.reason}`);
      return {
        ...nothing, blocked: blocked.map(b => ({ path: b.path, reason: b.reason })), ...(le ? { logError: le } : {}),
        error: `Refused: ${blocked.length} of ${kept.length} folder(s) failed the safety checks, so nothing was moved.\n` + list.join('\n') + (blocked.length > 10 ? `\n(+${blocked.length - 10} more)` : '')
      };
    }
    const total = checks.reduce((a, c) => a + c.size, 0);
    const useQ = quarantineOn();
    const plans = new Map();
    if (useQ) { await prefetchDriveTypes(checks.map(c => c.path)); const qc = quarantineCtx(); for (const c of checks) plans.set(c.path, quarantine.chooseRoot(c.path, qc)); }
    const nQ = [...plans.values()].filter(x => x.root).length;
    const nT = checks.length - nQ;
    {
      const top = [...checks].sort((a, b) => b.size - a.size).slice(0, 10).map(c => `${formatSizeMain(c.size)}  ${cleanupFolders.safeText(c.path)}`);
      const recent = checks.filter(c => c.newest && Date.now() - c.newest < cleanupFolders.RECENT_DAYS * 86400000).length;
      const warned = checks.filter(c => c.warnings && c.warnings.length);
      const where = nQ
        ? `Nothing is deleted. ${nQ === checks.length ? 'These folders are' : nQ + ' of them are'} moved to a hidden quarantine folder (${quarantine.QDIR}) next to your files, and you can put every one back exactly where it was from Tools > Quarantine. Quarantined folders keep using disk space until you empty the quarantine, which moves them to the Trash.` +
          (nT ? ` ${nT} cannot be quarantined and go to the Trash instead:\n` + checks.filter(c => !(plans.get(c.path) || {}).root).slice(0, 5).map(c => `- ${cleanupFolders.safeText(c.path)}: ${cleanupFolders.safeText((plans.get(c.path) || {}).error || 'quarantine is switched off', 200)}`).join('\n') + (nT > 5 ? `\n(+${nT - 5} more)` : '') + '\n' : '')
        : 'They are moved to the Trash (macOS/Linux) or Recycle Bin (Windows); nothing is permanently deleted, and you can restore them from there.' +
          (useQ ? ' Quarantine could not be used, so they go to the Trash instead:\n' + checks.slice(0, 5).map(c => `- ${cleanupFolders.safeText(c.path)}: ${cleanupFolders.safeText((plans.get(c.path) || {}).error || 'unknown', 200)}`).join('\n') + (checks.length > 5 ? `\n(+${checks.length - 5} more)` : '') + '\n' : '');
      const opts = {
        type: 'warning', buttons: ['Cancel', nQ ? 'Move to quarantine' : 'Move to Trash'], defaultId: 0, cancelId: 0,
        title: 'Clean up folders',
        message: `Move ${checks.length} folder${checks.length > 1 ? 's' : ''} (${formatSizeMain(total)} logical size, ${checks.reduce((a, c) => a + c.files, 0).toLocaleString()} entries counted just now) ${nQ ? 'to quarantine' : 'to the trash'}?`,
        detail: (recent ? `${recent} of them were modified in the last ${cleanupFolders.RECENT_DAYS} days.\n\n` : '') +
          (warned.length ? `Warnings (${warned.length} folder${warned.length > 1 ? 's' : ''}):\n` + warned.slice(0, 5).map(c => `- ${cleanupFolders.safeText(c.path)}: ${cleanupFolders.safeText(c.warnings.join('; '), 300)}`).join('\n') + (warned.length > 5 ? `\n(+${warned.length - 5} more)` : '') + '\n\n' : '') +
          `Largest ${top.length}:\n${top.join('\n')}\n\nSizes are logical sizes; space actually freed can be less (shared or compressed files). ${where} Each one is recorded in the deletion log.`
      };
      if (E2E) { if (typeof global.__e2eConfirm === 'function' && !(await global.__e2eConfirm(opts))) return nothing; }
      else { const r = await dialog.showMessageBox(mainWindow, opts); if (r.response !== 1) return nothing; }
    }
    // The dialog can sit open for a long time: verify everything again before touching anything.
    const again = [];
    for (const c of checks) {
      sendFolderProgress('verify', again.length, checks.length, c.path);
      again.push(await evaluateFolder(c.path));
      if (folderDeleteCancel) return cancelledEarly();
    }
    const changed = again.filter(c => !c.ok);
    if (changed.length) {
      const now = Date.now();
      await logDeletion(changed.map(b => ({ t: now, path: b.path, status: 'blocked', reason: 'changed before delete: ' + b.reason, source: src, type: 'folder' })));
      return { ...nothing, blocked: changed.map(b => ({ path: b.path, reason: b.reason })), error: `Refused: ${changed[0].path} changed before it could be deleted (${changed[0].reason}). Nothing was moved.` };
    }
    const deletedPaths = [], removedPaths = [], failed = [], failures = [];
    const quarantinedPaths = [], trashedInsteadPaths = [], fallbackReasons = [], trashedInsteadItems = [];
    let freedBytes = 0, quarantinedBytes = 0, logError = null;
    // Quarantine runs: one folder + manifest per volume root, all written (status planned) BEFORE the first move.
    const runId = quarantine.newRunId(), runT = Date.now(), qctx = quarantineCtx();
    const qItem = new Map(); // folder path -> { manifest, item }
    const fallbackWhy = new Map(); // folder path -> why it goes to the Trash
    if (useQ) {
      const groups = new Map();
      for (const c of checks) {
        const pl = quarantine.chooseRoot(c.path, qctx);
        if (!pl.root) { fallbackWhy.set(c.path, pl.error); continue; }
        if (!groups.has(pl.root)) groups.set(pl.root, []);
        groups.get(pl.root).push(c);
      }
      let n = 0;
      const scanRootOf = (p) => [...approvedFolderPaths].find(r => cleanupFolders.isInside(p, r, ci)) || lastScanFolder || null;
      for (const [root, list] of groups) {
        try {
          const items = list.map(c => {
            let dev = ''; try { dev = fs.lstatSync(c.path, { bigint: true }).dev; } catch (e) { throw new Error('cannot read ' + c.path); }
            return { n: ++n, originalPath: c.path, originalRealPath: c.logPath || c.path, dev, size: c.size, files: c.files, category: c.kind };
          });
          const expectDev = fs.lstatSync(list[0].path, { bigint: true }).dev;
          const manifest = quarantine.createRun({ root, runId, t: runT, appVersion: app.getVersion(), scanRoot: scanRootOf(list[0].path), source: src, items, expectDev }, qctx);
          quarantine.addRegistry(app.getPath('userData'), root);
          manifest.items.forEach((item, i) => qItem.set(list[i].path, { manifest, item }));
        } catch (e) { for (const c of list) fallbackWhy.set(c.path, 'could not create the quarantine folder (' + osErrorReason(e) + ')'); }
      }
    }
    const setQ = (c, status, extra) => { const q = qItem.get(c.path); if (q) { try { quarantine.setItemStatus(q.manifest, q.item, status, extra, qctx); } catch (e) { /* the log below still records it */ } } };
    for (const c of checks) {
      sendFolderProgress('trash', deletedPaths.length + failed.length, checks.length, c.path);
      const entry = { t: Date.now(), path: c.logPath || c.path, type: 'folder', size: c.size, files: c.files, category: c.kind, source: src };
      let rec;
      if (E2E && typeof global.__e2eBeforeTrash === 'function') await global.__e2eBeforeTrash(c.path); // test hook, E2E only
      const skip = (why) => { failed.push(c.path); failures.push({ path: c.path, reason: why, state: 'skipped' }); return { ...entry, status: 'skipped', reason: why }; };
      if (folderDeleteCancel) rec = skip('cancelled before it was moved');
      else {
        // Full re-verification (symlinks, real location, marker, version control, protected paths) immediately before EVERY move.
        const last = await evaluateFolder(c.path);
        if (!last.ok && folderDeleteCancel && last.reason === 'cancelled') rec = skip('cancelled before it was moved');
        else if (!last.ok) {
          rec = { ...entry, status: 'blocked', reason: 'changed just before delete: ' + last.reason };
          failed.push(c.path); failures.push({ path: c.path, reason: rec.reason, state: 'blocked' });
        } else {
          let moved = null;
          const q = qItem.get(c.path);
          if (q) {
            // What restore will compare against is what is in the folder NOW (the first check ran before the dialog).
            Object.assign(q.item, { size: last.size, files: last.files, originalRealPath: last.logPath || last.path });
            try { q.item.dev = String(fs.lstatSync(c.path, { bigint: true }).dev); } catch (e) { /* the move will report it */ }
            entry.size = last.size; entry.files = last.files;
            try {
              quarantine.moveIn(q.manifest, q.item, qctx);
              moved = { ok: true };
            } catch (e) {
              let origThere = true; try { fs.lstatSync(c.path); } catch (er) { origThere = er.code !== 'ENOENT'; }
              let inQ = false; try { fs.lstatSync(q.item.quarantinePath); inQ = true; } catch (er) { /* not there */ }
              // Renamed but the manifest write failed: the folder IS in quarantine (status stays planned, which restore accepts).
              if (!origThere && inQ) moved = { ok: true, manifestError: osErrorReason(e) };
              else fallbackWhy.set(c.path, 'moving it to quarantine failed (' + osErrorReason(e) + ')');
            }
          }
          if (moved) {
            deletedPaths.push(c.path); quarantinedPaths.push(c.path); quarantinedBytes += c.size;
            rec = { ...entry, status: 'quarantined', runId, quarantinePath: q.item.quarantinePath, reason: c.reason + (moved.manifestError ? ` (manifest update failed: ${moved.manifestError}; it is in quarantine and can still be restored)` : '') };
          } else try {
            await trashFn(c.path);
            deletedPaths.push(c.path); freedBytes += c.size;
            const why = fallbackWhy.get(c.path);
            if (useQ && why) { trashedInsteadPaths.push(c.path); fallbackReasons.push(why); trashedInsteadItems.push({ path: c.path, reason: why }); }
            rec = { ...entry, status: 'trashed', reason: c.reason + (useQ && why ? ` (sent to the Trash instead of quarantine: ${why})` : '') };
            setQ(c, 'trashed-fallback');
          } catch (e) {
            // Some platforms report an error although the item was moved: record what is really there now.
            let gone = false; try { fs.lstatSync(c.path); } catch (er) { gone = er.code === 'ENOENT'; }
            if (gone) {
              removedPaths.push(c.path);
              rec = { ...entry, status: 'removed', reason: 'the system reported an error but the folder is gone; it may not be in the Trash (' + osErrorReason(e) + ')' };
              setQ(c, 'failed', { note: 'gone, not confirmed in the Trash' });
            } else {
              failed.push(c.path);
              rec = { ...entry, status: 'failed', finalState: 'untouched', reason: await trashFailureReason(e, c.path, c.size) };
              failures.push({ path: c.path, reason: rec.reason, state: 'failed', finalState: 'untouched' });
              setQ(c, 'failed');
            }
          }
        }
      }
      logError = (await logDeletion([rec])) || logError; // per item, right after the move
    }
    // Items that were never moved (cancelled, blocked): the manifest must not claim they are planned forever.
    for (const [fp, q] of qItem) {
      if (q.item.status !== 'planned') continue;
      let orig = false; try { fs.lstatSync(fp); orig = true; } catch (e) { /* not at its original place */ }
      if (orig) { try { quarantine.setItemStatus(q.manifest, q.item, 'skipped', null, qctx); } catch (e) { /* best effort */ } }
    }
    if (deletedPaths.length || removedPaths.length) {
      const gone = [...deletedPaths, ...removedPaths].map(p => p + path.sep);
      const lc = ci ? (v) => v.toLowerCase() : (v) => v;
      const goneL = gone.map(lc);
      lastScanAllFiles = lastScanAllFiles.filter(f => { const fl = lc(f.path); return !goneL.some(g => fl.startsWith(g)); });
    }
    return { deleted: deletedPaths.length, deletedPaths, quarantined: quarantinedPaths.length, quarantinedPaths, quarantinedBytes, runId: quarantinedPaths.length ? runId : undefined, trashedInstead: trashedInsteadPaths.length, trashedInsteadPaths, trashedInsteadReason: fallbackReasons[0], trashedInsteadItems, removed: removedPaths.length, removedPaths, freedBytes, failed, failures, cancelled: folderDeleteCancel || undefined, dedupedNested: dropped, ...(logError ? { logError } : {}) };
  } finally {
    folderDeleteBusy = false;
  }
});

// === Quarantine: list, restore, move to Trash ===
const QUARANTINE_ID_RE = /^[0-9a-f]{8}$/;
const nowMs = () => (E2E && typeof global.__e2eNow === 'function') ? global.__e2eNow() : Date.now();
// Total bytes in a folder tree (lstat only, capped), for runs whose manifest cannot be read.
async function folderBytes(dir) {
  let bytes = 0, seen = 0; const stack = [dir];
  while (stack.length && seen < 200000) {
    const cur = stack.pop();
    let ents; try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (++seen > 200000) break;
      const f = path.join(cur, e.name);
      try { const st = fs.lstatSync(f); if (e.isDirectory() && !e.isSymbolicLink()) stack.push(f); else bytes += st.size; } catch (er) { /* vanished */ }
    }
    await new Promise(r => setImmediate(r));
  }
  return { bytes, capped: seen >= 200000 };
}
handleTrusted('quarantine-list', async () => {
  const r = quarantine.listRuns(quarantineRoots(), quarantineCtx(), nowMs());
  const unreadableRuns = [];
  for (const b of r.broken) { const sz = await folderBytes(b.runDir); unreadableRuns.push({ name: b.name, path: b.runDir, error: b.error, size: sz.bytes, capped: sz.capped }); }
  return {
    enabled: quarantineOn(), retentionDays: quarantine.RETENTION_DAYS, totalSize: r.totalSize + unreadableRuns.reduce((a, u) => a + u.size, 0), unreadable: r.broken.length, unreadableRuns, busy: folderDeleteBusy,
    runs: r.runs.map(run => ({
      runId: run.runId, t: run.t, size: run.size, heldCount: run.heldCount, expired: run.expired,
      items: run.items.map(i => ({ id: i.n, name: i.name, originalPath: i.originalPath, category: i.category, size: i.size, files: i.files, status: i.status, present: i.present, restoredTo: i.restoredTo || null }))
    }))
  };
});
// Run folders whose manifest cannot be read are still listed (they use disk space): reveal them or move them to the Trash.
const brokenByName = (p) => quarantine.listRuns(quarantineRoots(), quarantineCtx(), nowMs()).broken.find(b => b.runDir === p);   // keyed by full path: a multi-volume run has same-named copies
handleTrusted('quarantine-reveal-broken', async (event, name) => {
  const b = typeof name === 'string' ? brokenByName(name) : null;
  if (!b) return false;
  shell.showItemInFolder(b.runDir);
  return true;
});
handleTrusted('quarantine-trash-broken', async (event, name) => {
  const b = typeof name === 'string' ? brokenByName(name) : null;
  if (!b) return { error: 'That folder is no longer listed as unreadable.' };
  if (folderDeleteBusy) return { error: 'A cleanup or restore is already running. Nothing was moved.' };
  folderDeleteBusy = true;
  try {
    const opts = { type: 'warning', buttons: ['Cancel', 'Move to Trash'], defaultId: 0, cancelId: 0, title: 'Unreadable quarantine run', message: 'Move this unreadable quarantine run to the Trash?', detail: `${b.runDir}\n\nIts manifest cannot be read (${b.error}), so Stuff Diver cannot put its folders back. Nothing is permanently deleted: the folder moves to the Trash and can be restored from there.` };
    if (E2E) { if (typeof global.__e2eConfirm === 'function' && !(await global.__e2eConfirm(opts))) return { trashed: 0, cancelled: true }; }
    else { const r = await dialog.showMessageBox(mainWindow, opts); if (r.response !== 1) return { trashed: 0, cancelled: true }; }
    let ok = true, reason = null, removed = false;
    try { await trashFn(b.runDir); } catch (e) { let gone = false; try { fs.lstatSync(b.runDir); } catch (er) { gone = er.code === 'ENOENT'; } if (gone) removed = true; else { ok = false; reason = osErrorReason(e); } }
    const logError = await logDeletion([{ t: Date.now(), path: b.runDir, type: 'quarantine-run', status: ok ? (removed ? 'removed' : 'trashed') : 'failed', source: 'quarantine-unreadable', reason: ok ? (removed ? 'the system reported an error but the folder is gone; it may not be in the Trash' : 'unreadable quarantine run moved to the Trash') : reason, ...(ok ? {} : { finalState: 'untouched' }) }]);
    return { trashed: ok && !removed ? 1 : 0, removed: removed ? 1 : 0, failed: ok ? 0 : 1, reason, ...(logError ? { logError } : {}) };
  } finally { folderDeleteBusy = false; }
});

// opts: { ids?: number[] (default: every item still held), beside?: bool, recreateParent?: bool } applied to the listed ids.
handleTrusted('quarantine-restore', async (event, runId, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (typeof runId !== 'string' || !QUARANTINE_ID_RE.test(runId)) return { error: 'Invalid run.' };
  if (o.ids != null && (!Array.isArray(o.ids) || o.ids.some(n => !Number.isInteger(n)))) return { error: 'Invalid item list.' };
  if (folderDeleteBusy) return { error: 'A cleanup or restore is already running. Nothing was restored.' };
  folderDeleteBusy = true;
  try {
    const qctx = quarantineCtx();
    const run = quarantine.listRuns(quarantineRoots(), qctx, nowMs()).runs.find(r => r.runId === runId);
    if (!run) return { error: 'That quarantine run no longer exists (it may have been moved to the Trash).' };
    const held = (i) => i.status === 'quarantined' || (i.status === 'planned' && i.present);   // planned and absent = never moved (crash or cancel)
    const targets = o.ids ? run.items.filter(i => o.ids.includes(i.n)) : run.items.filter(held);
    if (!targets.length) return { error: 'Nothing to restore in this run.', results: [] };
    const results = [], restoredPaths = [];
    let logError = null;
    for (const it of targets) {
      const res = await quarantine.restoreItem(it, qctx, { beside: o.beside === true, recreateParent: o.recreateParent === true, anyway: o.anyway === true, confirmDestination: typeof o.confirmDestination === 'string' ? o.confirmDestination : null });
      const base = { id: it.n, name: it.name, originalPath: it.originalPath };
      const meta = { t: Date.now(), type: 'folder', runId, size: it.size, files: it.files, category: it.category, source: 'quarantine-restore' };
      if (res.ok) {
        let warning = null;
        try { if (!quarantine.markRestored(it, res.restoredTo, qctx)) warning = 'the manifest could not be updated'; } catch (e) { warning = 'the manifest could not be updated (' + osErrorReason(e) + ')'; }
        restoredPaths.push(res.restoredTo);
        results.push({ ...base, ok: true, restoredTo: res.restoredTo, beside: res.beside, ...(warning ? { warning: warning + '; the folder IS back in place' } : {}) });
        logError = (await logDeletion([{ ...meta, path: res.restoredTo, from: it.quarantinePath, status: 'restored', reason: res.beside ? 'put back next to the folder that already exists there' : 'put back where it was' }])) || logError;
      } else {
        results.push({ ...base, ok: false, state: res.state, reason: res.reason, canRestoreBeside: !!res.canRestoreBeside, canRecreateParent: !!res.canRecreateParent, canRestoreAnyway: !!res.canRestoreAnyway, canConfirmDestination: !!res.canConfirmDestination, destination: res.destination, recorded: res.recorded, now: res.now });
        logError = (await logDeletion([{ ...meta, path: it.originalPath, status: 'blocked', reason: 'restore refused: ' + res.reason }])) || logError;
      }
    }
    return { runId, restored: restoredPaths.length, restoredPaths, failed: results.filter(r => !r.ok).length, results, ...(logError ? { logError } : {}) };
  } finally { folderDeleteBusy = false; }
});

// runIds: array of ids, or 'all'. Moves whole run folders to the OS Trash (never removes anything itself).
handleTrusted('quarantine-trash', async (event, runIds) => {
  const all = runIds === 'all';
  if (!all && (!Array.isArray(runIds) || !runIds.length || runIds.some(r => typeof r !== 'string' || !QUARANTINE_ID_RE.test(r)))) return { error: 'Invalid run list.' };
  if (folderDeleteBusy) return { error: 'A cleanup or restore is already running. Nothing was moved.' };
  folderDeleteBusy = true;
  try {
    const qctx = quarantineCtx();
    const runs = quarantine.listRuns(quarantineRoots(), qctx, nowMs()).runs.filter(r => all || runIds.includes(r.runId));
    if (!runs.length) return { error: 'Nothing to move.', trashed: 0, results: [] };
    const total = runs.reduce((a, r) => a + r.size, 0), held = runs.reduce((a, r) => a + r.heldCount, 0);
    const opts = {
      type: 'warning', buttons: ['Cancel', 'Move to Trash'], defaultId: 0, cancelId: 0, title: 'Empty quarantine',
      message: `Move ${runs.length} quarantine run${runs.length > 1 ? 's' : ''} (${formatSizeMain(total)}, ${held} folder${held === 1 ? '' : 's'}) to the Trash?`,
      detail: 'Nothing is permanently deleted: the whole quarantine run moves to the Trash (macOS/Linux) or Recycle Bin (Windows). After that, Stuff Diver can no longer put these folders back for you; you can still restore them from the Trash yourself until you empty it.'
    };
    if (E2E) { if (typeof global.__e2eConfirm === 'function' && !(await global.__e2eConfirm(opts))) return { trashed: 0, cancelled: true, results: [] }; }
    else { const r = await dialog.showMessageBox(mainWindow, opts); if (r.response !== 1) return { trashed: 0, cancelled: true, results: [] }; }
    const results = []; let logError = null;
    for (const run of runs) {
      for (const dir of run.dirs) {
        let ok = true, reason = null, removed = false;
        try { await trashFn(dir); } catch (e) {
          let gone = false; try { fs.lstatSync(dir); } catch (er) { gone = er.code === 'ENOENT'; }
          if (gone) { removed = true; reason = osErrorReason(e); } else { ok = false; reason = osErrorReason(e); }
        }
        results.push({ runId: run.runId, ok, removed, reason });
        logError = (await logDeletion([{ t: Date.now(), path: dir, type: 'quarantine-run', runId: run.runId, size: run.size, files: run.heldCount, status: !ok ? 'failed' : removed ? 'removed' : 'trashed', source: 'quarantine-empty', reason: !ok ? reason : removed ? 'the system reported an error but the run folder is gone; it may not be in the Trash (' + reason + ')' : (run.expired ? 'expired quarantine run moved to the Trash' : 'quarantine run moved to the Trash'), ...(ok ? {} : { finalState: 'untouched' }) }])) || logError;
      }
    }
    return { trashed: results.filter(r => r.ok && !r.removed).length, removed: results.filter(r => r.removed).length, failed: results.filter(r => !r.ok).length, results, ...(logError ? { logError } : {}) };
  } finally { folderDeleteBusy = false; }
});

// Filtered, paginated view of the deletion log (newest first). opts.file: 0 = current, 1..2 = rotated.
handleTrusted('query-deletion-log', async (event, opts) => {
  const o = opts || {};
  const limit = Math.max(1, Math.min(Number(o.limit) || 200, 1000));
  const offset = Math.max(0, Number(o.offset) || 0);
  const file = Math.max(0, Math.min(Number(o.file) || 0, LOG_KEEP - 1));
  const status = ['trashed', 'quarantined', 'restored', 'failed', 'blocked', 'skipped', 'removed', 'gone'].includes(o.status) ? o.status : null;
  const q = typeof o.search === 'string' ? o.search.trim().toLowerCase() : '';
  const all = await readLogEntries(file);
  const counts = { trashed: 0, quarantined: 0, restored: 0, failed: 0, blocked: 0, skipped: 0, removed: 0, gone: 0 };
  const matched = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (counts[e.status] !== undefined) counts[e.status]++;
    if (status && e.status !== status) continue;
    if (q && !`${e.path || ''} ${e.reason || ''} ${e.source || ''} ${e.category || ''}`.toLowerCase().includes(q)) continue;
    matched.push(e);
  }
  const rotated = [];
  for (let i = 1; i < LOG_KEEP; i++) if (fs.existsSync(deletionLogPath(i))) rotated.push(i);
  return { entries: matched.slice(offset, offset + limit), matched: matched.length, total: all.length, counts, rotated, file, logPath: deletionLogPath(file) };
});

// === Scan cache ===

function getCacheDir() {
  const dir = path.join(app.getPath('userData'), 'scan-cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Bump when scan results change meaning so stale caches are ignored.
// v2: exact (bigint) file IDs, locked Windows system files, Linux pseudo-FS skip.
// v3: allocated sizes on Windows, '/'-separated relative paths, extension stats.
// v4: full file list stored in a gzip sidecar; previous scan kept for compare.
// v5: Windows scans no longer trust garbage allocation sizes (caches could hold absurd totals).
const SCAN_CACHE_VERSION = 5;

function getCacheKey(folderPath) {
  return crypto.createHash('md5').update(folderPath).digest('hex');
}

function cachePaths(folderPath) {
  const base = path.join(getCacheDir(), getCacheKey(folderPath));
  return {
    result: base + '.json', files: base + '.files.ndjson.gz',
    prevResult: base + '.prev.json', prevFiles: base + '.prev.files.ndjson.gz'
  };
}

// The renderer only receives the top files; the full list lives here so
// Duplicates, Smart Cleanup, extension views and compare keep working from cache.
async function writeFilesSidecar(file, files) {
  const tmp = file + '.tmp';
  async function* lines() {
    let buf = [];
    for (const f of files) {
      buf.push(JSON.stringify(f));
      if (buf.length >= 5000) { yield buf.join('\n') + '\n'; buf = []; }
    }
    if (buf.length) yield buf.join('\n') + '\n';
  }
  await pipeline(lines(), zlib.createGzip(), fs.createWriteStream(tmp));
  await fs.promises.rename(tmp, file);
}

async function readFilesSidecar(file) {
  const out = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity
  });
  for await (const line of rl) { if (line) out.push(JSON.parse(line)); }
  return out;
}

async function renameIfExists(from, to) {
  try { await fs.promises.rename(from, to); } catch (e) { /* nothing to rotate */ }
}

handleTrusted('load-cache', async (event, folderPath) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    const cp = cachePaths(folderPath);
    if (!fs.existsSync(cp.result) || !fs.existsSync(cp.files)) return null;
    const raw = await fs.promises.readFile(cp.result, 'utf8');
    const cached = JSON.parse(raw);
    if (cached.scanVersion !== SCAN_CACHE_VERSION) return null;
    setActiveFolderState(folderPath, await readFilesSidecar(cp.files));
    return cached;
  } catch (e) {
    return null;
  }
});

// One save at a time per folder: a quick rescan must not interleave rotation and writes.
const saveCacheChains = new Map();
handleTrusted('save-cache', async (event, folderPath, result) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    if (lastScanFolder !== folderPath) return false; // full list belongs to another scan
    const files = lastScanAllFiles; // snapshot: the array is replaced, not mutated, by later scans
    const prior = saveCacheChains.get(folderPath) || Promise.resolve();
    const job = prior.catch(() => {}).then(async () => {
      const cp = cachePaths(folderPath);
      await renameIfExists(cp.result, cp.prevResult);
      await renameIfExists(cp.files, cp.prevFiles);
      await writeFilesSidecar(cp.files, files);
      const data = { ...result, cachedAt: Date.now(), folderPath, scanVersion: SCAN_CACHE_VERSION };
      await fs.promises.writeFile(cp.result, JSON.stringify(data));
      return true;
    });
    saveCacheChains.set(folderPath, job);
    return await job;
  } catch (e) {
    return false;
  }
});

// Summary of the scan before the current one (for Forecast).
handleTrusted('load-previous-cache', async (event, folderPath) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    const cp = cachePaths(folderPath);
    const prev = JSON.parse(await fs.promises.readFile(cp.prevResult, 'utf8'));
    if (prev.scanVersion !== SCAN_CACHE_VERSION) return null;
    return { cachedAt: prev.cachedAt, totalSize: prev.totalSize, totalFiles: prev.totalFiles };
  } catch (e) {
    return null;
  }
});

// Diff the current full scan against the previous one, entirely in main.
handleTrusted('compare-scan', async (event, folderPath) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    if (lastScanFolder !== folderPath || !lastScanAllFiles.length) return { error: 'noscan' };
    const cp = cachePaths(folderPath);
    let prevMeta;
    try { prevMeta = JSON.parse(await fs.promises.readFile(cp.prevResult, 'utf8')); } catch (e) { return { error: 'noprev' }; }
    if (prevMeta.scanVersion !== SCAN_CACHE_VERSION || !fs.existsSync(cp.prevFiles)) return { error: 'noprev' };
    const key = (f) => f.relativePath || f.path;
    const old = new Map();
    for (const f of await readFilesSidecar(cp.prevFiles)) old.set(key(f), f);
    const cats = { added: [], removed: [], grown: [], shrunk: [] };
    const totals = { added: 0, removed: 0, grown: 0, shrunk: 0 };
    const counts = { added: 0, removed: 0, grown: 0, shrunk: 0 };
    const TOP = 20;
    const keep = (cat, item) => {
      counts[cat]++; totals[cat] += item.diff;
      const arr = cats[cat];
      arr.push(item);
      if (arr.length > TOP * 8) { arr.sort((a, b) => b.diff - a.diff); arr.length = TOP; }
    };
    const seen = new Set();
    for (const f of lastScanAllFiles) {
      const k = key(f); seen.add(k);
      const o = old.get(k);
      if (!o) keep('added', { ...f, diff: f.size });
      else if (f.size > o.size) keep('grown', { ...f, diff: f.size - o.size, oldSize: o.size });
      else if (f.size < o.size) keep('shrunk', { ...f, diff: o.size - f.size, oldSize: o.size });
    }
    for (const [k, f] of old) if (!seen.has(k)) keep('removed', { ...f, diff: f.size });
    for (const c of Object.keys(cats)) { cats[c].sort((a, b) => b.diff - a.diff); cats[c].length = Math.min(cats[c].length, TOP); }
    return { prevDate: prevMeta.cachedAt, lists: cats, counts, totals };
  } catch (e) {
    return { error: 'failed' };
  }
});

handleTrusted('clear-cache', async (event, folderPath) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    const cp = cachePaths(folderPath);
    for (const f of Object.values(cp)) { try { await fs.promises.unlink(f); } catch (e) { /* absent */ } }
    return true;
  } catch (e) {
    return false;
  }
});

// === File Tags ===

function getTagsDir() {
  const dir = path.join(app.getPath('userData'), 'file-tags');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

handleTrusted('load-tags', async (event, folderPath) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    const file = path.join(getTagsDir(), getCacheKey(folderPath) + '.json');
    if (!fs.existsSync(file)) return {};
    const raw = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load tags:', e.message);
    return {};
  }
});

handleTrusted('save-tags', async (event, folderPath, tags) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    const file = path.join(getTagsDir(), getCacheKey(folderPath) + '.json');
    await fs.promises.writeFile(file, JSON.stringify(tags));
    return true;
  } catch (e) {
    console.error('Failed to save tags:', e.message);
    return false;
  }
});

// === Settings ===

const DEFAULT_SETTINGS = {};

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

const ALLOWED_SETTINGS_KEYS = ['developerFolderCleanup', 'recentFolders', 'theme', 'monitorFolder', 'monitorInterval', 'monitorEnabled', 'lastViewMode', 'scanExclusions', 'mftFastScan', 'useQuarantine'];

function saveSettings(settings) {
  const existing = loadSettings();
  const filtered = {};
  for (const key of ALLOWED_SETTINGS_KEYS) {
    if (key in settings) filtered[key] = settings[key];
  }
  const merged = { ...existing, ...filtered };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2));
}

handleTrusted('get-app-version', () => {
  return app.getVersion();
});

handleTrusted('load-settings', () => {
  return loadSettings();
});

handleTrusted('save-settings', (event, settings) => {
  try {
    saveSettings(settings);
    return true;
  } catch (e) {
    return false;
  }
});

// === Auto-update (electron-updater) ===

const { autoUpdater } = require('electron-updater');

// Disable auto-download — we want user to confirm first
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUpdaterStatusCode(error) {
  if (typeof error?.statusCode === 'number') return error.statusCode;
  const match = /\b([45]\d{2})\b/.exec(String(error?.message || ''));
  return match ? Number(match[1]) : null;
}

function isTransientUpdaterError(error) {
  const statusCode = getUpdaterStatusCode(error);
  if (statusCode != null && statusCode >= 500) return true;
  const message = String(error?.message || '');
  return /timed out|aborted|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message);
}

function formatUpdaterError(error, fallback) {
  const statusCode = getUpdaterStatusCode(error);
  if (statusCode != null && statusCode >= 500) {
    return `GitHub update server returned ${statusCode}. This is usually temporary. Please try again in a minute.`;
  }

  const message = String(error?.message || '');
  if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(message)) {
    return 'The update manifest is not available yet. Please try again in a minute.';
  }
  if (/ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(message)) {
    return 'Could not read the latest GitHub release. Please try again shortly.';
  }
  if (/timed out|aborted|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) {
    return 'Network error while contacting the update server. Please try again.';
  }

  const firstLine = message.split('\n').map((line) => line.trim()).find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 180 ? firstLine.slice(0, 177) + '...' : firstLine;
}

async function checkForUpdatesWithRetry() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await autoUpdater.checkForUpdates();
    } catch (error) {
      if (!isTransientUpdaterError(error) || attempt === maxAttempts) throw error;
      await delay(1200 * attempt);
    }
  }
}

function setupAutoUpdater() {
  // Use the packaged app-update.yml generated by electron-builder.
  // That keeps the runtime provider config aligned with the shipped build.

  // Forward events to renderer
  autoUpdater.on('checking-for-update', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', {
      status: 'available',
      version: info.version,
      notes: info.releaseNotes || ''
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', {
      status: 'up-to-date',
      version: info.version
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('update-status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', {
      status: 'ready',
      version: info.version
    });
  });

  autoUpdater.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('update-status', {
      status: 'error',
      error: formatUpdaterError(err, 'Update error')
    });
  });
}

handleTrusted('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { ok: false, error: 'Update checks only work in packaged builds.' };
  }
  try {
    await checkForUpdatesWithRetry();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: formatUpdaterError(e, 'Could not check for updates') };
  }
});

handleTrusted('download-update', async () => {
  if (!app.isPackaged) {
    return { ok: false, error: 'Update downloads only work in packaged builds.' };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: formatUpdaterError(e, 'Download failed') };
  }
});

handleTrusted('install-update', () => {
  app.releaseSingleInstanceLock();
  autoUpdater.quitAndInstall(false, true);
});

handleTrusted('open-external', async (event, url) => {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(target.hostname)) {
    throw new Error('External URL is not allowed');
  }
  await shell.openExternal(target.toString());
  return true;
});

// === Folder Monitor ===

function formatSizeMain(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

async function quickScanSize(folderPath) {
  // Lightweight scan — just total size and file count
  let totalSize = 0;
  let fileCount = 0;

  async function walk(dir, depth) {
    if (depth > 80) return;
    let entries;
    try {
      entries = await rawFs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (isPseudoFilesystemPath(fullPath)) continue;
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await rawFs.promises.stat(fullPath);
          let sz = stat.blocks != null ? stat.blocks * 512 : stat.size;
          if (process.platform === 'win32' && sz > stat.size + 4 * 1024 * 1024) sz = stat.size; // garbage NTFS allocation
          totalSize += sz;
          fileCount++;
        } catch (e) { /* skip */ }
      }
    }
  }

  await walk(folderPath, 0);
  return { totalSize, fileCount };
}

async function runMonitorCheck() {
  const settings = loadSettings();
  const folder = settings.monitorFolder;
  if (!folder || !fs.existsSync(folder)) return;

  try {
    // Load cached scan for comparison
    const cacheFile = path.join(getCacheDir(), getCacheKey(folder) + '.json');
    let cachedSize = 0;
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      cachedSize = cached.totalSize || 0;
    }

    // Quick scan
    const current = await quickScanSize(folder);
    const diff = current.totalSize - cachedSize;
    const folderName = path.basename(folder);

    // Only notify if growth exceeds 100MB
    if (diff > 100 * 1024 * 1024) {
      new Notification({
        title: 'Stuff Diver',
        body: `${folderName} grew ${formatSizeMain(diff)} since last scan (now ${formatSizeMain(current.totalSize)})`,
        silent: false
      }).show();
    } else if (diff < -(100 * 1024 * 1024)) {
      new Notification({
        title: 'Stuff Diver',
        body: `${folderName} shrank ${formatSizeMain(Math.abs(diff))} since last scan`,
        silent: true
      }).show();
    }

    // Update tray tooltip
    if (tray) {
      tray.setToolTip(`Stuff Diver — ${folderName}: ${formatSizeMain(current.totalSize)}`);
    }
  } catch (e) {
    console.error('Monitor check failed:', e.message);
  }
}

function setupTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'logo.png');
    let icon = nativeImage.createFromPath(iconPath);
    icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    const settings = loadSettings();
    const folderName = settings.monitorFolder ? path.basename(settings.monitorFolder) : 'None';
    tray.setToolTip(`Stuff Diver — Watching: ${folderName}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Stuff Diver', click: () => showMainWindow() },
      { type: 'separator' },
      { label: 'Check Now', click: () => runMonitorCheck() },
      { label: 'Quit', click: () => { stopMonitor(); app.quit(); } }
    ]));
  } catch (e) {
    console.error('Tray setup failed:', e.message);
  }
}

function startMonitor() {
  const settings = loadSettings();
  const interval = clampMonitorInterval(settings.monitorInterval);
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(runMonitorCheck, interval);
  setupTray();
}

function stopMonitor() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  if (tray) { tray.destroy(); tray = null; }
}

handleTrusted('start-monitor', async (event, folderPath, intervalMs) => {
  folderPath = assertApprovedFolder(folderPath);
  saveSettings({
    monitorFolder: folderPath,
    monitorInterval: clampMonitorInterval(intervalMs),
    monitorEnabled: true
  });
  startMonitor();
  return true;
});

handleTrusted('stop-monitor', async () => {
  stopMonitor();
  saveSettings({ monitorEnabled: false });
  return true;
});

handleTrusted('get-monitor-status', async () => {
  const settings = loadSettings();
  return {
    enabled: !!monitorTimer,
    folder: settings.monitorFolder || null,
    interval: clampMonitorInterval(settings.monitorInterval)
  };
});
