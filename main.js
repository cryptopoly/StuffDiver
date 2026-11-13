const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// Set the app name so macOS permission dialogs show "Stuff Diver"
app.setName('Stuff Diver');

// End-to-end test mode (Playwright): isolated user data, no native dialogs,
// no auto-updater. Never enabled unless the env var is set explicitly.
const E2E = process.env.STUFFDIVER_E2E === '1';
const E2E_SCAN_DELAY = E2E ? (Number(process.env.STUFFDIVER_E2E_SCAN_DELAY_MS) || 0) : 0;
if (E2E && process.env.STUFFDIVER_USER_DATA) {
  app.setPath('userData', process.env.STUFFDIVER_USER_DATA);
}

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

// Stat for the scanner. Uses bigint so file IDs stay exact: NTFS file IDs are
// 64-bit (sequence number in the high bits), and converting them to a JS
// Number rounds away the low bits. Unrelated files/folders then share a
// dev:ino key and get dropped as "duplicates" — on a whole-drive scan that
// silently discards entire subtrees.
async function statForScan(filePath) {
  const s = await fs.promises.stat(filePath, { bigint: true });
  return {
    id: `${s.dev}:${s.ino}`,
    size: Number(s.size),
    blocks: s.blocks != null ? Number(s.blocks) : null,
    mtimeMs: Number(s.mtimeMs),
    nlink: Number(s.nlink)
  };
}

// Linux virtual filesystems report fake sizes (/proc/kcore claims ~128 TB)
// and contain no real disk usage; skip them when walking from /.
const LINUX_PSEUDO_FS_ROOTS = new Set(['/proc', '/sys', '/dev', '/run']);
function isPseudoFilesystemPath(fullPath) {
  return process.platform === 'linux' && LINUX_PSEUDO_FS_ROOTS.has(fullPath);
}

// Windows: read sizes of files the OS holds open exclusively (pagefile.sys,
// hiberfil.sys, ...). FileInfo reads attributes from the directory entry, so
// it works where opening the file fails. Returns Map<lowercasePath, {size, mtimeMs}>.
function statLockedWindowsFiles(paths) {
  return new Promise((resolve) => {
    const result = new Map();
    if (process.platform !== 'win32' || !paths.length) return resolve(result);
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      '[Console]::InputEncoding=[Text.Encoding]::UTF8',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      '$paths=[Console]::In.ReadToEnd() | ConvertFrom-Json',
      '$epoch=[datetime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)',
      '$out=foreach($p in $paths){ $i=[System.IO.FileInfo]::new($p); if($i.Exists){ [pscustomobject]@{p=$p;s=$i.Length;m=[int64]($i.LastWriteTimeUtc-$epoch).TotalMilliseconds} } }',
      'ConvertTo-Json -Compress -InputObject @($out)'
    ].join('; ');
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    } catch (e) {
      return resolve(result);
    }
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, 30000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => { clearTimeout(timer); resolve(result); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim() || '[]');
        for (const r of (Array.isArray(parsed) ? parsed : [parsed])) {
          if (r && typeof r.p === 'string' && Number.isFinite(r.s)) {
            result.set(r.p.toLowerCase(), { size: r.s, mtimeMs: Number(r.m) || 0 });
          }
        }
      } catch (e) { /* ignore */ }
      resolve(result);
    });
    child.stdin.on('error', () => { /* ignore */ });
    child.stdin.end(JSON.stringify(paths));
  });
}

// Scan exclusions. A pattern is either a bare name/glob ("node_modules",
// "*.tmp") matched against each entry name, or a path (contains a separator)
// matched as a prefix of the full path. Case-insensitive on Windows/macOS.
function buildExcluder(patterns) {
  const ci = process.platform !== 'linux';
  const norm = (v) => (ci ? v.toLowerCase() : v);
  const names = [];
  const prefixes = [];
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    if (typeof raw !== 'string') continue;
    const pat = raw.trim();
    if (!pat) continue;
    if (/[\\/]/.test(pat)) {
      prefixes.push(norm(path.resolve(pat)));
    } else {
      const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      names.push(new RegExp('^' + escaped + '$', ci ? 'i' : ''));
    }
  }
  if (!names.length && !prefixes.length) return null;
  return (fullPath, name) => {
    if (names.some(re => re.test(name))) return true;
    if (!prefixes.length) return false;
    const p = norm(fullPath);
    return prefixes.some(x => p === x || p.startsWith(x + path.sep));
  };
}

// Run fn over items with at most `limit` in flight; results keep input order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

app.whenReady().then(() => {
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
  const isExcluded = buildExcluder(options && options.exclude);
  let excludedCount = 0;
  const extStatsMap = new Map();
  const files = [];
  const seen = new Set();
  let count = 0;
  let skipped = 0;
  let cloudOnlyCount = 0;

  // Folder tree for bubble map — accumulates sizes during walk
  const folderTree = { name: path.basename(folderPath), size: 0, logicalSize: 0, fileCount: 0, mtime: 0, children: {}, extSizes: {} };

  function addToTree(relativePath, diskSize, logSize, ext, mtime) {
    const parts = relativePath.replace(/\\/g, '/').split('/');
    let node = folderTree;
    // Walk/create intermediate folder nodes (all but last element which is the file)
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.children[name]) {
        const nodePath = parts.slice(0, i + 1).join('/');
        node.children[name] = { name, path: nodePath, size: 0, logicalSize: 0, fileCount: 0, mtime: 0, children: {}, extSizes: {} };
      }
      node = node.children[name];
    }
    // Accumulate into deepest folder
    node.size += diskSize;
    node.logicalSize += logSize;
    node.fileCount++;
    if (mtime > node.mtime) node.mtime = mtime;
    const e = ext || '(none)';
    node.extSizes[e] = (node.extSizes[e] || 0) + diskSize;
  }

  function propagate(node) {
    if (!node || !node.children) return;
    for (const child of Object.values(node.children)) {
      propagate(child);
      node.size += child.size;
      node.logicalSize += child.logicalSize;
      node.fileCount += child.fileCount;
      if (child.mtime > node.mtime) node.mtime = child.mtime;
      if (child.extSizes) {
        for (const [ext, sz] of Object.entries(child.extSizes)) {
          node.extSizes[ext] = (node.extSizes[ext] || 0) + sz;
        }
      }
    }
    let maxExt = null, maxSz = 0;
    if (node.extSizes) {
      for (const [ext, sz] of Object.entries(node.extSizes)) {
        if (sz > maxSz) { maxSz = sz; maxExt = ext; }
      }
    }
    node.dominantExt = maxExt;
  }

  function cleanupTree(node) {
    if (!node) return;
    delete node.extSizes;
    if (node.children) {
      for (const child of Object.values(node.children)) {
        cleanupTree(child);
      }
    }
  }

  // Caps the folder tree at TREE_NODE_CAP nodes by pruning the smallest
  // folders. Parent aggregates (size, fileCount) are preserved, so the chart
  // totals stay accurate — only drill-down detail into tiny folders is lost.
  const TREE_NODE_CAP = 2000;

  function countTreeNodes(node) {
    let n = 1;
    if (node.children) {
      for (const c of Object.values(node.children)) n += countTreeNodes(c);
    }
    return n;
  }

  function pruneByMinSize(node, minSize) {
    if (!node.children) return;
    for (const key of Object.keys(node.children)) {
      const child = node.children[key];
      if (child.size < minSize) {
        delete node.children[key];
      } else {
        pruneByMinSize(child, minSize);
      }
    }
  }

  function capTreeNodes(root) {
    if (countTreeNodes(root) <= TREE_NODE_CAP) return;
    const sizes = [];
    (function collect(n) {
      sizes.push(n.size);
      if (n.children) for (const c of Object.values(n.children)) collect(c);
    })(root);
    sizes.sort((a, b) => b - a);
    const threshold = sizes[Math.min(TREE_NODE_CAP - 1, sizes.length - 1)];
    pruneByMinSize(root, threshold);
  }

  let batchBuffer = [];
  let lastBatchTime = Date.now();

  function flushBatch() {
    if (batchBuffer.length === 0) return;
    try {
      event.sender.send('scan-batch', { files: batchBuffer, count, skipped });
    } catch (e) { /* window closed */ }
    batchBuffer = [];
    lastBatchTime = Date.now();
  }

  function recordFile(virtualPath, name, diskSize, logicalSize, mtime, cloudStatus) {
    const ext = path.extname(name).toLowerCase();
    // Always '/'-separated so folder filters and searches behave the same on every OS.
    const rel = path.relative(folderPath, virtualPath).split(path.sep).join('/');
    const fileObj = {
      path: virtualPath,
      relativePath: rel,
      name,
      size: diskSize,
      logicalSize,
      ext,
      mtime,
      ...(cloudStatus ? { cloudStatus } : {})
    };
    files.push(fileObj);
    batchBuffer.push(fileObj);
    const extKey = ext || '(none)';
    const es = extStatsMap.get(extKey);
    if (es) { es.size += diskSize; es.count++; } else extStatsMap.set(extKey, { ext: extKey, size: diskSize, count: 1 });
    addToTree(rel, diskSize, logicalSize || diskSize, ext, mtime);
    count++;
    if (batchBuffer.length >= 500 || (Date.now() - lastBatchTime) > 250) {
      flushBatch();
    }
    if (count % 1000 === 0) {
      try { event.sender.send('scan-progress', { count, skipped }); } catch (e) { /* window closed */ }
    }
  }

  // Windows: files held open by the OS (pagefile.sys, hiberfil.sys,
  // swapfile.sys, ...) can't be opened for stat, but their size is still
  // readable from the directory entry. Retry those after the walk.
  const lockedFiles = [];
  const LOCKED_FILE_CAP = 5000;

  const STAT_CONCURRENCY = 24;

  async function walk(dir, depth) {
    if (depth > 80 || scanState.cancelled) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      skipped++;
      return;
    }
    if (E2E_SCAN_DELAY) await new Promise(r => setTimeout(r, E2E_SCAN_DELAY));
    const dirEntries = [];
    const fileEntries = [];
    for (const entry of entries) {
      // Detect iCloud placeholder files: hidden files ending with .icloud
      // e.g. ".Document.pdf.icloud" represents "Document.pdf" stored only in iCloud
      const isICloudPlaceholder = process.platform === 'darwin' &&
        entry.name.startsWith('.') && entry.name.endsWith('.icloud') && entry.name.length > 8;
      const fullPath = path.join(dir, entry.name);
      if (isExcluded && isExcluded(fullPath, entry.name)) { excludedCount++; continue; }
      if (!isICloudPlaceholder && entry.isDirectory() && !entry.isSymbolicLink()) {
        if (isPseudoFilesystemPath(fullPath)) continue;
        dirEntries.push({ entry, fullPath });
      } else if (entry.isFile() || isICloudPlaceholder) {
        fileEntries.push({ entry, fullPath, isICloudPlaceholder });
      }
    }

    // Stat files in parallel (the OS overlaps the I/O), then record in order.
    const stats = await mapLimit(fileEntries, STAT_CONCURRENCY, async (f) => {
      try { return { stat: await statForScan(f.fullPath) }; } catch (e) { return { error: e }; }
    });
    for (let i = 0; i < fileEntries.length; i++) {
      const { entry, fullPath, isICloudPlaceholder } = fileEntries[i];
      const { stat, error } = stats[i];
      if (isICloudPlaceholder) {
        // Strip leading '.' and trailing '.icloud' (7 chars) to recover real filename.
        // No local disk space used.
        const name = entry.name.slice(1, -7);
        cloudOnlyCount++;
        recordFile(path.join(dir, name), name, 0, 0, stat ? stat.mtimeMs : 0, 'icloud-only');
        continue;
      }
      if (error) {
        if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES') &&
            lockedFiles.length < LOCKED_FILE_CAP) {
          lockedFiles.push({ fullPath, name: entry.name });
        } else {
          skipped++;
        }
        continue;
      }
      // Only hard-linked files can appear twice; skip tracking the rest to
      // keep memory flat on multi-million-file scans.
      if (stat.nlink > 1) {
        if (seen.has(stat.id)) continue;
        seen.add(stat.id);
      }
      // blocks * 512 is the allocated size on every platform. On Windows libuv
      // fills it from the NTFS AllocationSize, so cluster rounding, compression
      // and sparse files are accounted for (small "resident" files that live
      // inside the MFT report 0).
      let diskSize = stat.blocks != null ? stat.blocks * 512 : stat.size;
      let cloudStatus;
      if (process.platform === 'darwin' && stat.blocks === 0 && stat.size > 0) {
        // Modern macOS: evicted iCloud files keep their name but have 0 data blocks
        cloudStatus = 'icloud-only';
      } else if (process.platform === 'win32' && stat.blocks === 0 && stat.size > 4096) {
        // Windows: OneDrive / Files-On-Demand placeholders report their full
        // size but occupy no clusters. Anything this big can't be MFT-resident.
        cloudStatus = 'icloud-only';
      }
      if (cloudStatus) {
        cloudOnlyCount++;
        diskSize = 0;
      }
      recordFile(fullPath, entry.name, diskSize, stat.size, stat.mtimeMs, cloudStatus);
    }

    for (const { fullPath } of dirEntries) {
      if (scanState.cancelled) return;
      // Dedupe by dev:ino so APFS firmlinks / bind mounts don't walk the
      // same tree twice (e.g. /System/Volumes/Data mirrors /).
      try {
        const dirStat = await statForScan(fullPath);
        if (seen.has(dirStat.id)) continue;
        seen.add(dirStat.id);
      } catch (e) {
        skipped++;
        continue;
      }
      await walk(fullPath, depth + 1);
    }
  }

  await walk(folderPath, 0);
  if (lockedFiles.length && !scanState.cancelled) {
    const sizes = await statLockedWindowsFiles(lockedFiles.map(f => f.fullPath));
    for (const f of lockedFiles) {
      const info = sizes.get(f.fullPath.toLowerCase());
      if (!info) { skipped++; continue; }
      recordFile(f.fullPath, f.name, info.size, info.size, info.mtimeMs);
    }
  }
  flushBatch(); // send any remaining files
  try {
    propagate(folderTree);
    capTreeNodes(folderTree);
    cleanupTree(folderTree);
  } catch (e) {
    // Tree build error — non-fatal, continue with flat file list
  }

  // Store full list for duplicate detection
  setActiveFolderState(folderPath, files);
  // Send top 500 local files + top 500 cloud files (merged) so both filter modes have data
  const localFiles = files.filter(f => !f.cloudStatus).sort((a, b) => b.size - a.size).slice(0, 500);
  const cloudFiles = files.filter(f => f.cloudStatus === 'icloud-only').sort((a, b) => (b.logicalSize || 0) - (a.logicalSize || 0)).slice(0, 500);
  const sentPaths = new Set();
  const mergedFiles = [];
  for (const f of localFiles) { sentPaths.add(f.path); mergedFiles.push(f); }
  for (const f of cloudFiles) { if (!sentPaths.has(f.path)) mergedFiles.push(f); }
  mergedFiles.sort((a, b) => Math.max(b.size, b.logicalSize || 0) - Math.max(a.size, a.logicalSize || 0));
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const totalLogicalSize = files.reduce((s, f) => s + (f.logicalSize || f.size), 0);
  const totalCloudLogicalSize = files
    .filter(f => f.cloudStatus === 'icloud-only')
    .reduce((s, f) => s + (f.logicalSize || 0), 0);
  if (activeScan === scanState) activeScan = null;
  const extStats = [...extStatsMap.values()].sort((x, y) => y.size - x.size).slice(0, 100);
  return {
    files: mergedFiles, totalFiles: files.length, totalSize, totalLogicalSize, totalCloudLogicalSize,
    skippedDirs: skipped, folderTree, cloudOnlyCount, extStats,
    cancelled: scanState.cancelled, excludedCount
  };
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

handleTrusted('delete-files', async (event, filePaths) => {
  if (!Array.isArray(filePaths) || !filePaths.length) return { deleted: 0, deletedPaths: [] };
  const safePaths = [];
  try {
    for (const fp of filePaths) {
      safePaths.push(assertAllowedFilePath(fp));
    }
  } catch (e) {
    return { deleted: 0, deletedPaths: [], error: e.message || 'Invalid file path' };
  }

  const result = E2E ? { response: 1 } : await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Move to Trash'],
    defaultId: 0,
    cancelId: 0,
    title: 'Delete Files',
    message: `Move ${filePaths.length} file${filePaths.length > 1 ? 's' : ''} to trash?`,
    detail: 'This will move the selected files to your system trash.'
  });

  if (result.response !== 1) return { deleted: 0, deletedPaths: [] };

  const deletedPaths = [];
  for (const fp of safePaths) {
    try {
      await shell.trashItem(fp);
      deletedPaths.push(fp);
    } catch (e) {
      console.error('Failed to trash:', fp, e.message);
    }
  }
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
const SCAN_CACHE_VERSION = 3;

function getCacheKey(folderPath) {
  return crypto.createHash('md5').update(folderPath).digest('hex');
}

handleTrusted('load-cache', async (event, folderPath) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    const file = path.join(getCacheDir(), getCacheKey(folderPath) + '.json');
    if (!fs.existsSync(file)) return null;
    const raw = await fs.promises.readFile(file, 'utf8');
    const cached = JSON.parse(raw);
    if (cached.scanVersion !== SCAN_CACHE_VERSION) return null;
    setActiveFolderState(folderPath, Array.isArray(cached.files) ? cached.files : []);
    return cached;
  } catch (e) {
    return null;
  }
});

handleTrusted('save-cache', async (event, folderPath, result) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    const file = path.join(getCacheDir(), getCacheKey(folderPath) + '.json');
    const data = { ...result, cachedAt: Date.now(), folderPath, scanVersion: SCAN_CACHE_VERSION };
    await fs.promises.writeFile(file, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
});

handleTrusted('clear-cache', async (event, folderPath) => {
  try {
    folderPath = assertApprovedFolder(folderPath);
    const file = path.join(getCacheDir(), getCacheKey(folderPath) + '.json');
    if (fs.existsSync(file)) await fs.promises.unlink(file);
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

const ALLOWED_SETTINGS_KEYS = ['recentFolders', 'theme', 'monitorFolder', 'monitorInterval', 'monitorEnabled', 'lastViewMode', 'scanExclusions'];

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
