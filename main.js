const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Stuff Diver',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC Handlers

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('scan-folder', async (event, folderPath) => {
  const files = [];
  const seen = new Set();
  let count = 0;
  let skipped = 0;

  // Folder tree for bubble map — accumulates sizes during walk
  const folderTree = { name: path.basename(folderPath), size: 0, fileCount: 0, mtime: 0, children: {}, extSizes: {} };

  function addToTree(relativePath, diskSize, ext, mtime) {
    const parts = relativePath.replace(/\\/g, '/').split('/');
    let node = folderTree;
    // Walk/create intermediate folder nodes (all but last element which is the file)
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.children[name]) {
        const nodePath = parts.slice(0, i + 1).join('/');
        node.children[name] = { name, path: nodePath, size: 0, fileCount: 0, mtime: 0, children: {}, extSizes: {} };
      }
      node = node.children[name];
    }
    // Accumulate into deepest folder
    node.size += diskSize;
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
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          const fileId = `${stat.dev}:${stat.ino}`;
          if (seen.has(fileId)) continue;
          seen.add(fileId);
          const diskSize = stat.blocks != null ? stat.blocks * 512 : stat.size;
          const rel = path.relative(folderPath, fullPath);
          const ext = path.extname(entry.name).toLowerCase();
          files.push({
            path: fullPath,
            relativePath: rel,
            name: entry.name,
            size: diskSize,
            logicalSize: stat.size,
            ext,
            mtime: stat.mtimeMs
          });
          addToTree(rel, diskSize, ext, stat.mtimeMs);
          count++;
          if (count % 1000 === 0) {
            event.sender.send('scan-progress', { count, skipped });
          }
        } catch (e) {
          skipped++;
        }
      }
    }
  }

  await walk(folderPath, 0);
  try {
    propagate(folderTree);
    cleanupTree(folderTree);
  } catch (e) {
    // Tree build error — non-fatal, continue with flat file list
  }

  files.sort((a, b) => b.size - a.size);
  return { files: files.slice(0, 500), totalFiles: files.length, totalSize: files.reduce((s, f) => s + f.size, 0), skippedDirs: skipped, folderTree };
});

ipcMain.handle('find-duplicates', async (event, files) => {
  const MIN_SIZE = 4096;
  const candidates = files.filter(f => f.size >= MIN_SIZE);

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
        event.sender.send('duplicate-progress', { phase: 'hashing', hashed, total: totalToHash });
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

ipcMain.handle('open-file', async (event, filePath) => {
  return shell.openPath(filePath);
});

ipcMain.handle('show-in-folder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('preview-file', async (event, filePath) => {
  if (process.platform === 'darwin') {
    exec(`qlmanage -p "${filePath.replace(/"/g, '\\"')}"`);
  } else {
    return shell.openPath(filePath);
  }
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

ipcMain.handle('load-cache', async (event, folderPath) => {
  try {
    const file = path.join(getCacheDir(), getCacheKey(folderPath) + '.json');
    if (!fs.existsSync(file)) return null;
    const raw = await fs.promises.readFile(file, 'utf8');
    const cached = JSON.parse(raw);
    return cached;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('save-cache', async (event, folderPath, result) => {
  try {
    const file = path.join(getCacheDir(), getCacheKey(folderPath) + '.json');
    const data = { ...result, cachedAt: Date.now(), folderPath };
    await fs.promises.writeFile(file, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('clear-cache', async (event, folderPath) => {
  try {
    const file = path.join(getCacheDir(), getCacheKey(folderPath) + '.json');
    if (fs.existsSync(file)) await fs.promises.unlink(file);
    return true;
  } catch (e) {
    return false;
  }
});
