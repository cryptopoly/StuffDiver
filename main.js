const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
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

// Set the app name so macOS permission dialogs show "Stuff Diver"
app.setName('Stuff Diver');

// End-to-end test mode (Playwright): isolated user data, no native dialogs,
// no auto-updater. Never enabled unless the env var is set explicitly.
const E2E = process.env.STUFFDIVER_E2E === '1';
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
  for (const root of approvedFolderPaths) {
    if (resolved === root) return resolved;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved.startsWith(prefix)) return resolved;
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
handleTrusted('is-elevated', async () => {
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
});

// Windows: restart the app with a UAC prompt so protected folders can be read.
// macOS: open the Full Disk Access pane. Other platforms: no-op.
handleTrusted('elevate-access', async () => {
  if (process.platform === 'win32') {
    const args = app.isPackaged ? [] : [app.getAppPath()];
    const argList = args.length ? `-ArgumentList '${args[0].replace(/'/g, "''")}'` : '';
    const exe = process.execPath.replace(/'/g, "''");
    try {
      await execFileP('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath '${exe}' ${argList} -Verb RunAs`
      ], { windowsHide: true });
      app.quit();
      return 'relaunching';
    } catch (e) {
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
  { id: 'recycle', label: 'Recycle Bin', icon: '\u{1F5D1}', re: /^\/\$Recycle\.Bin\//i },
  { id: 'wintemp', label: 'Windows temp files', icon: '\u{1F550}', re: /(^\/Windows\/Temp\/|\/AppData\/Local\/Temp\/)/i },
  { id: 'winupdate', label: 'Windows Update downloads', icon: '\u{1FA9F}', re: /^\/Windows\/SoftwareDistribution\/Download\//i },
  { id: 'crash', label: 'Crash dumps', icon: '\u{1F4A5}', re: /(\/CrashDumps\/|\/Crashpad\/|^\/Windows\/Minidump\/|\/MEMORY\.DMP$|\.dmp$)/i },
  { id: 'aimodels', label: 'AI model caches (re-downloadable)', icon: '\u{1F9E0}', re: /(\/\.cache\/(huggingface|torch|whisper|lm-studio)\/|\/\.ollama\/models\/|\/\.lmstudio\/models\/)/i },
  { id: 'pkgcache', label: 'Package manager caches', icon: '\u{1F4E6}', re: /(\/AppData\/Local\/(pip|npm-cache|NuGet|Yarn|pnpm)\/|\/\.nuget\/packages\/|\/\.gradle\/caches\/|\/\.m2\/repository\/|\/\.cargo\/registry\/|\/Library\/Caches\/(pip|Homebrew)\/|\/var\/cache\/apt\/archives\/)/i },
  { id: 'node_modules', label: 'node_modules', icon: '\u{1F4E6}', re: /\/node_modules\// },
  { id: 'git', label: '.git directories', icon: '\u{1F500}', re: /\/\.git\// },
  { id: 'syscache', label: 'System & app caches', icon: '\u{1F5C4}', re: /(\/(cache|\.cache|__pycache__|\.pytest_cache|\.npm|\.yarn|INetCache|GPUCache|Code Cache)\/|\/Library\/Caches\/|\/\.local\/share\/Trash\/|\/\.Trash\/)/i },
  { id: 'temp', label: 'Temp files', icon: '\u{1F550}', re: /\.(tmp|temp|swp|swo|bak|old)$/i },
  { id: 'xcode', label: 'Xcode DerivedData', icon: '\u{1F528}', re: /\/DerivedData\// },
  { id: 'build', label: 'Build artifacts', icon: '\u{1F3D7}', re: /\/(dist|\.next|\.nuxt|target|\.build)\//i },
  { id: 'logs', label: 'Log files', icon: '\u{1F4DD}', re: /\.log$/i },
  { id: 'dsstore', label: '.DS_Store files', icon: '\u{1F47B}', re: /\.DS_Store$/ },
  { id: 'thumbs', label: 'Thumbnails & junk', icon: '\u{1F5D1}', re: /(Thumbs\.db|desktop\.ini|\.Spotlight|\.Trashes|\/\.cache\/thumbnails\/)/i }
];
const CLEANUP_PATH_CAP = 20000;

handleTrusted('cleanup-scan', async () => {
  const cats = CLEANUP_PATTERNS.map(p => ({ id: p.id, label: p.label, icon: p.icon, re: p.re, count: 0, totalSize: 0, paths: [] }));
  for (const f of lastScanAllFiles) {
    if (f.cloudStatus === 'icloud-only') continue;
    const rp = '/' + String(f.relativePath || f.name).replace(/\\/g, '/');
    for (const c of cats) {
      if (c.re.test(rp)) {
        c.count++;
        c.totalSize += f.size;
        if (c.paths.length < CLEANUP_PATH_CAP) c.paths.push(f.path);
        break;
      }
    }
  }
  return cats.filter(c => c.count > 0).map(({ re, ...rest }) => rest).sort((a, b) => b.totalSize - a.totalSize);
});

handleTrusted('find-duplicates', async (event) => {
  const MIN_SIZE = 4096;
  const candidates = lastScanAllFiles.filter(f => f.size >= MIN_SIZE && f.cloudStatus !== 'icloud-only');

  // Full-content hash, streamed with a large buffer.
  function hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on('data', d => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  // Cheap fingerprint: first and last 64KB. Same-size files that differ almost
  // always differ at the head or tail, so this avoids most full reads.
  const SAMPLE = 64 * 1024;
  async function sampleHash(filePath, size) {
    const fh = await fs.promises.open(filePath, 'r');
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
    const key = f.name.toLowerCase();
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
  'Library', 'Applications', 'AppData', 'OneDrive', 'iCloud Drive', 'Public'];
const PROTECTED_HOME_SECRETS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config/gcloud', '.azure',
  'Library/Keychains', 'Library/Mobile Documents', 'AppData/Roaming/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Protect', 'AppData/Local/Microsoft/Credentials'];

function protectedReason(inputPath) {
  const variants = new Set([path.resolve(inputPath)]);
  try { variants.add(fs.realpathSync(path.resolve(inputPath))); } catch (e) { /* missing: judge by name */ }
  const win = process.platform === 'win32';
  const norm = (v) => { const x = v.split(path.sep).join('/').replace(/\/+$/, ''); return win ? x.toLowerCase() : x; };
  const home = norm(require('os').homedir());
  const insideOrEq = (p, root) => p === root || p.startsWith(root + '/');
  for (const raw of variants) {
    const p = norm(raw) || '/';
    if (p === '/' || /^[a-z]:$/i.test(p)) return 'a drive or filesystem root';
    if (p === home) return 'your home folder';
    for (const r of approvedFolderPaths) if (norm(r) === p) return 'the folder you scanned (delete items inside it instead)';
    if (win) {
      // Folders Smart Cleanup legitimately empties: allowed even though they sit under system roots.
      const cleanable = ['c:/windows/temp', 'c:/windows/softwaredistribution/download', 'c:/windows/minidump', 'c:/$recycle.bin'];
      const exempt = cleanable.some(r => p !== r && p.startsWith(r + '/')) || p === 'c:/windows/memory.dmp';
      const sysRoots = exempt ? [] : ['c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata/microsoft',
        'c:/system volume information', 'c:/$recycle.bin', 'c:/boot', 'c:/recovery'];
      for (const r of sysRoots) if (insideOrEq(p, r)) return 'a Windows system folder';
      if (/^[a-z]:\/(pagefile|hiberfil|swapfile)\.sys$/.test(p)) return 'a Windows system file';
      if (/^[a-z]:\/users$/.test(p) || /^[a-z]:\/users\/[^/]+$/.test(p)) return 'a user profile folder';
    } else {
      const sysRoots = ['/system', '/usr', '/bin', '/sbin', '/etc', '/dev', '/cores', '/private/etc', '/private/var/db',
        '/opt/homebrew/bin', '/boot', '/proc', '/sys', '/lib', '/lib64', '/var/lib', '/var/db'];
      for (const r of sysRoots) if (insideOrEq(p, r)) return 'an operating-system folder';
      if (p === '/users' || p === '/home' || p === '/volumes' || p === '/applications' || p === '/library' || p === '/private' || p === '/var') return 'a top-level system folder';
    }
    if (insideOrEq(p, home)) {
      const rel = p.slice(home.length + 1);
      for (const f of PROTECTED_HOME_FOLDERS) if (rel === norm(f)) return `your ${f} folder`;
      for (const f of PROTECTED_HOME_SECRETS) if (insideOrEq(rel, norm(f))) return 'a credentials or keychain location';
    }
  }
  return null;
}

// Append-only record of everything trashed (or refused), kept in user data.
function deletionLogPath() { return path.join(app.getPath('userData'), 'deletion-log.jsonl'); }
async function logDeletion(entries) {
  if (!entries.length) return;
  try {
    await fs.promises.appendFile(deletionLogPath(), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  } catch (e) { /* logging must never block the user */ }
}

handleTrusted('get-deletion-log', async (event, limit) => {
  try {
    const lines = (await fs.promises.readFile(deletionLogPath(), 'utf8')).split('\n').filter(Boolean);
    const n = Math.max(1, Math.min(Number(limit) || 500, 5000));
    return lines.slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) {
    return [];
  }
});

handleTrusted('reveal-deletion-log', async () => {
  const p = deletionLogPath();
  if (fs.existsSync(p)) shell.showItemInFolder(p);
  return fs.existsSync(p);
});

handleTrusted('delete-files', async (event, filePaths, source) => {
  if (!Array.isArray(filePaths) || !filePaths.length) return { deleted: 0, deletedPaths: [] };
  const safePaths = [];
  try {
    for (const fp of filePaths) {
      safePaths.push(assertAllowedFilePath(fp));
    }
  } catch (e) {
    return { deleted: 0, deletedPaths: [], error: e.message || 'Invalid file path' };
  }

  // All-or-nothing: one protected path refuses the whole request.
  const blocked = [];
  for (const fp of safePaths) {
    const reason = protectedReason(fp);
    if (reason) blocked.push({ path: fp, reason });
  }
  if (blocked.length) {
    const now = Date.now();
    await logDeletion(blocked.map(b => ({ t: now, path: b.path, status: 'blocked', reason: b.reason, source: source || 'collector' })));
    return {
      deleted: 0, deletedPaths: [], blocked,
      error: `Refused: ${blocked[0].path} is ${blocked[0].reason}.` + (blocked.length > 1 ? ` (+${blocked.length - 1} more protected)` : '')
    };
  }

  const result = E2E ? { response: 1 } : await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Move to Trash'],
    defaultId: 0,
    cancelId: 0,
    title: 'Delete Files',
    message: `Move ${filePaths.length} file${filePaths.length > 1 ? 's' : ''} to trash?`,
    detail: 'This will move the selected files to your system trash. You can restore them from the trash, and each one is recorded in the deletion log.'
  });

  if (result.response !== 1) return { deleted: 0, deletedPaths: [] };

  const sizeByPath = new Map();
  const want = new Set(safePaths);
  for (const f of lastScanAllFiles) if (want.has(f.path)) sizeByPath.set(f.path, f.size);

  const deletedPaths = [];
  const log = [];
  const now = Date.now();
  for (const fp of safePaths) {
    const entry = { t: now, path: fp, size: sizeByPath.get(fp) ?? null, source: source || 'collector' };
    try {
      await shell.trashItem(fp);
      deletedPaths.push(fp);
      log.push({ ...entry, status: 'trashed' });
    } catch (e) {
      console.error('Failed to trash:', fp, e.message);
      log.push({ ...entry, status: 'failed', reason: e.message });
    }
  }
  await logDeletion(log);
  if (deletedPaths.length) {
    const gone = new Set(deletedPaths);
    lastScanAllFiles = lastScanAllFiles.filter(f => !gone.has(f.path));
  }
  return { deleted: deletedPaths.length, deletedPaths };
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

handleTrusted('save-cache', async (event, folderPath, result) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    if (lastScanFolder !== folderPath) return false; // full list belongs to another scan
    const cp = cachePaths(folderPath);
    await renameIfExists(cp.result, cp.prevResult);
    await renameIfExists(cp.files, cp.prevFiles);
    await writeFilesSidecar(cp.files, lastScanAllFiles);
    const data = { ...result, cachedAt: Date.now(), folderPath, scanVersion: SCAN_CACHE_VERSION };
    await fs.promises.writeFile(cp.result, JSON.stringify(data));
    return true;
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

const ALLOWED_SETTINGS_KEYS = ['recentFolders', 'theme', 'monitorFolder', 'monitorInterval', 'monitorEnabled', 'lastViewMode', 'scanExclusions', 'mftFastScan'];

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
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (isPseudoFilesystemPath(fullPath)) continue;
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          totalSize += stat.blocks != null ? stat.blocks * 512 : stat.size;
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
      { label: 'Open Stuff Diver', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
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
