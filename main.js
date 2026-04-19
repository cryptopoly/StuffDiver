const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// Set the app name so macOS permission dialogs show "Stuff Diver"
app.setName('Stuff Diver');

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
  setupAutoUpdater();
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

handleTrusted('scan-folder', async (event, folderPath) => {
  folderPath = assertApprovedFolder(folderPath);
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

  async function walk(dir, depth) {
    if (depth > 80) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      skipped++;
      return;
    }
    for (const entry of entries) {
      // Detect iCloud placeholder files: hidden files ending with .icloud
      // e.g. ".Document.pdf.icloud" represents "Document.pdf" stored only in iCloud
      const isICloudPlaceholder = process.platform === 'darwin' &&
        entry.name.startsWith('.') && entry.name.endsWith('.icloud') && entry.name.length > 8;

      const fullPath = path.join(dir, entry.name);

      if (!isICloudPlaceholder && entry.isDirectory() && !entry.isSymbolicLink()) {
        // Dedupe by dev:ino so APFS firmlinks / bind mounts don't walk the
        // same tree twice (e.g. /System/Volumes/Data mirrors /).
        try {
          const dirStat = await fs.promises.stat(fullPath);
          const dirId = `${dirStat.dev}:${dirStat.ino}`;
          if (seen.has(dirId)) continue;
          seen.add(dirId);
        } catch (e) {
          skipped++;
          continue;
        }
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() || isICloudPlaceholder) {
        try {
          const stat = await fs.promises.stat(fullPath);
          const fileId = `${stat.dev}:${stat.ino}`;
          if (seen.has(fileId)) continue;
          seen.add(fileId);

          let name, ext, diskSize, logicalSize, cloudStatus;
          if (isICloudPlaceholder) {
            // Strip leading '.' and trailing '.icloud' (7 chars) to recover real filename
            name = entry.name.slice(1, -7);
            ext = path.extname(name).toLowerCase();
            diskSize = 0; // No local disk space used
            logicalSize = 0;
            cloudStatus = 'icloud-only';
            cloudOnlyCount++;
          } else {
            name = entry.name;
            ext = path.extname(entry.name).toLowerCase();
            // On Windows, stat.blocks is unreliable — use stat.size (logical bytes) directly.
            // On macOS/Linux, stat.blocks * 512 gives true on-disk usage (accounts for compression, sparse files, etc.)
            diskSize = process.platform === 'win32'
              ? stat.size
              : (stat.blocks != null ? stat.blocks * 512 : stat.size);
            logicalSize = stat.size;
            // Modern macOS: evicted iCloud files keep their original name but have 0 data blocks
            if (process.platform === 'darwin' && stat.blocks === 0 && stat.size > 0) {
              cloudStatus = 'icloud-only';
              cloudOnlyCount++;
              diskSize = 0;
            }
          }

          const virtualPath = isICloudPlaceholder ? path.join(dir, name) : fullPath;
          const rel = path.relative(folderPath, virtualPath);
          const fileObj = {
            path: virtualPath,
            relativePath: rel,
            name,
            size: diskSize,
            logicalSize,
            ext,
            mtime: stat.mtimeMs,
            ...(cloudStatus ? { cloudStatus } : {})
          };
          files.push(fileObj);
          batchBuffer.push(fileObj);
          addToTree(rel, diskSize, logicalSize || diskSize, ext, stat.mtimeMs);
          count++;
          if (batchBuffer.length >= 500 || (Date.now() - lastBatchTime) > 250) {
            flushBatch();
          }
          if (count % 1000 === 0) {
            try { event.sender.send('scan-progress', { count, skipped }); } catch (e) { /* window closed */ }
          }
        } catch (e) {
          skipped++;
        }
      }
    }
  }

  await walk(folderPath, 0);
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
  return { files: mergedFiles, totalFiles: files.length, totalSize, totalLogicalSize, totalCloudLogicalSize, skippedDirs: skipped, folderTree, cloudOnlyCount };
});

handleTrusted('find-duplicates', async (event) => {
  const MIN_SIZE = 4096;
  const candidates = lastScanAllFiles.filter(f => f.size >= MIN_SIZE && f.cloudStatus !== 'icloud-only');

  async function hashFile(filePath, maxBytes) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, maxBytes ? { start: 0, end: maxBytes - 1 } : undefined);
      stream.on('data', d => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
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
    // Quick hash: first 8KB
    const quickMap = new Map();
    for (const f of group) {
      try {
        const qh = await hashFile(f.path, 8192);
        if (!quickMap.has(qh)) quickMap.set(qh, []);
        quickMap.get(qh).push(f);
      } catch (e) { /* skip unreadable */ }
      hashed++;
      if (hashed % 20 === 0) {
        try { event.sender.send('duplicate-progress', { phase: 'hashing', hashed, total: totalToHash }); } catch (e) { /* window closed */ }
      }
    }

    // Full hash only where quick hash matched 2+
    for (const qGroup of quickMap.values()) {
      if (qGroup.length < 2) continue;
      const fullMap = new Map();
      for (const f of qGroup) {
        try {
          const fh = await hashFile(f.path);
          if (!fullMap.has(fh)) fullMap.set(fh, []);
          fullMap.get(fh).push(f);
        } catch (e) { /* skip */ }
      }
      for (const fGroup of fullMap.values()) {
        if (fGroup.length >= 2) {
          goldGroups.push(fGroup);
        }
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
    if (process.platform === 'win32') {
      const drive = path.parse(folderPath).root.replace(/\\/g, '').slice(0, 2);
      if (!/^[A-Za-z]:$/.test(drive)) return null;
      const { stdout } = await execFileP('wmic', ['logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'Size,FreeSpace', '/format:csv']);
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const last = lines[lines.length - 1].split(',');
      return { total: parseInt(last[1]) || 0, available: parseInt(last[2]) || 0 };
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

  const result = await dialog.showMessageBox(mainWindow, {
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
  return { deleted: deletedPaths.length, deletedPaths };
});

// === Scan cache ===

function getCacheDir() {
  const dir = path.join(app.getPath('userData'), 'scan-cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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
    const data = { ...result, cachedAt: Date.now(), folderPath };
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

const ALLOWED_SETTINGS_KEYS = ['recentFolders', 'theme', 'monitorFolder', 'monitorInterval', 'monitorEnabled', 'lastViewMode'];

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
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          totalSize += process.platform === 'win32' ? stat.size : (stat.blocks != null ? stat.blocks * 512 : stat.size);
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
