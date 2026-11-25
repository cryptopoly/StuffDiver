// Electron patches `fs` to treat .asar files as archives (size 0, or an error for
// invalid ones); the scanner must see them as the plain files they are.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// Shared scanner: used by the GUI (scan-folder IPC) and the headless CLI.
// Read-only: only readdir/stat. Nothing in here modifies or deletes files.

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
// macOS: scanning / must not wander into other mounted volumes, the /net
// automount, or the system's auxiliary APFS volumes (VM, Preboot, ...).
const DARWIN_SKIP_ROOTS = new Set(['/Volumes', '/net', '/Network']);
// Linux: network, FUSE, VM-share and snap (squashfs) mounts are not local disk
// usage; scanning / would otherwise walk shared Mac/Windows homes and NFS.
const LINUX_FOREIGN_FSTYPES = /^(nfs\d*|cifs|smb3|smbfs|9p|squashfs|prl_fs|vboxsf|vmhgfs|fuse(\..*)?|sshfs|davfs|afs|ceph|glusterfs)$/;
let linuxForeignMounts = null;
function getLinuxForeignMounts() {
  if (linuxForeignMounts) return linuxForeignMounts;
  linuxForeignMounts = new Set();
  try {
    for (const line of fs.readFileSync('/proc/self/mounts', 'utf8').split('\n')) {
      const parts = line.split(' ');
      if (parts.length < 3 || !LINUX_FOREIGN_FSTYPES.test(parts[2])) continue;
      // /proc/mounts escapes spaces and tabs as octal
      linuxForeignMounts.add(parts[1].replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8))));
    }
  } catch (e) { /* no /proc: nothing to skip */ }
  return linuxForeignMounts;
}
function isPseudoFilesystemPath(fullPath) {
  if (process.platform === 'linux') return LINUX_PSEUDO_FS_ROOTS.has(fullPath) || getLinuxForeignMounts().has(fullPath);
  if (process.platform === 'darwin') {
    return DARWIN_SKIP_ROOTS.has(fullPath) ||
      (fullPath.startsWith('/System/Volumes/') && fullPath !== '/System/Volumes/Data');
  }
  return false;
}

// macOS: files with 0 blocks but a size are either evicted iCloud files
// (SF_DATALESS flag) or small compressed files stored in an xattr. Returns the
// set of paths that are really dataless; on stat failure assume dataless.
const SF_DATALESS = 0x40000000;
async function findDatalessDarwin(paths) {
  const dataless = new Set();
  const CHUNK = 200;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const known = new Set();
    let stdout = '';
    try {
      stdout = (await execFileP('/usr/bin/stat', ['-f', '%Xf\t%N', '--', ...chunk], { maxBuffer: 64 * 1024 * 1024 })).stdout;
    } catch (e) { stdout = (e && e.stdout) || ''; } // non-zero exit if a path vanished; keep partial output
    for (const line of stdout.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const p = line.slice(tab + 1);
      known.add(p);
      if ((parseInt(line.slice(0, tab), 16) & SF_DATALESS) !== 0) dataless.add(p);
    }
    for (const p of chunk) if (!known.has(p)) dataless.add(p);
  }
  return dataless;
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
    if (/[\\/]/.test(pat) || pat === '~') {
      const expanded = pat === '~' || pat.startsWith('~/') || pat.startsWith('~\\')
        ? path.join(os.homedir(), pat.slice(1)) : pat;
      prefixes.push(norm(path.resolve(expanded)));
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

// Walk folderPath and build the file list + folder tree.
// options: { exclude, scanState: {cancelled}, onBatch, onProgress, delayMs }
async function runScan(folderPath, options = {}) {
  const scanState = options.scanState || { cancelled: false };
  const onBatch = options.onBatch || (() => {});
  const onProgress = options.onProgress || (() => {});
  const delayMs = options.delayMs || 0;
  const isExcluded = buildExcluder(options.exclude);
  let excludedCount = 0;
  const extStatsMap = new Map();
  const files = [];
  const seen = new Set();
  let count = 0;
  let skipped = 0;
  let cloudOnlyCount = 0;
  const darwinZeroBlock = [];

  // Folder tree for bubble map — accumulates sizes during walk
  const folderTree = { name: path.basename(folderPath), size: 0, logicalSize: 0, fileCount: 0, mtime: 0, children: Object.create(null), extSizes: Object.create(null) };

  function addToTree(relativePath, diskSize, logSize, ext, mtime) {
    const parts = relativePath.replace(/\\/g, '/').split('/');
    let node = folderTree;
    // Walk/create intermediate folder nodes (all but last element which is the file)
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.children[name]) {
        const nodePath = parts.slice(0, i + 1).join('/');
        node.children[name] = { name, path: nodePath, size: 0, logicalSize: 0, fileCount: 0, mtime: 0, children: Object.create(null), extSizes: Object.create(null) };
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
      onBatch({ files: batchBuffer, count, skipped });
    } catch (e) { /* listener gone */ }
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
      try { onProgress({ count, skipped }); } catch (e) { /* listener gone */ }
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
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    const dirEntries = [];
    const fileEntries = [];
    for (const entry of entries) {
      // Detect iCloud placeholder files: hidden files ending with .icloud
      // e.g. ".Document.pdf.icloud" represents "Document.pdf" stored only in iCloud
      const isICloudPlaceholder = process.platform === 'darwin' &&
        entry.name.startsWith('.') && entry.name.endsWith('.icloud') && entry.name.length > 8;
      const fullPath = path.join(dir, entry.name);
      if (entry.name.toLowerCase() === '.stuffdiverquarantine') continue;   // our own quarantine folder is never scanned
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
        if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES' || error.code === 'EINVAL') &&
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
      // Windows: libuv can report a garbage AllocationSize (~1e15 blocks) for
      // small NTFS-compressed files resident in the MFT. Allocation never
      // exceeds the file size by more than a cluster, so distrust anything bigger.
      if (process.platform === 'win32' && diskSize > stat.size + 4 * 1024 * 1024) diskSize = stat.size;
      let cloudStatus;
      if (process.platform === 'darwin' && stat.blocks === 0 && stat.size > 0) {
        // Evicted iCloud file or small compressed file; decided after the walk.
        darwinZeroBlock.push({ fullPath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
        continue;
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

  // Optional NTFS fast scan (Windows, whole volume, setting OFF by default).
  // STUFFDIVER_MFT_SCAN=1/0 overrides the setting (manual compare script).
  // Any problem leaves nothing recorded and falls through to the normal walk.
  let mftWanted = options.mftFastScan === true;
  if (process.env.STUFFDIVER_MFT_SCAN === '1') mftWanted = true;
  if (process.env.STUFFDIVER_MFT_SCAN === '0') mftWanted = false;
  let fastScanInfo = null;
  if (process.platform === 'win32' && mftWanted && !(options.exclude && options.exclude.length) &&
      /^[A-Za-z]:\\$/.test(folderPath)) {
    fastScanInfo = { engine: 'walk', fallbackReason: null };
    try {
      const t0 = Date.now();
      const r = await require('./mft-scan').scanNtfsVolume(folderPath, { isCancelled: () => scanState.cancelled });
      for (let i = 0; i < r.count; i++) {
        // Yield now and then so cancel and IPC stay responsive on multi-million-file volumes.
        if (i % 50000 === 49999) { await new Promise(res => setImmediate(res)); if (scanState.cancelled) break; }
        if (r.fullPaths[i].toLowerCase().split(/[\\/]/).includes('.stuffdiverquarantine')) continue;   // never scan the quarantine (whole folder names only)
        if (r.cloud[i]) cloudOnlyCount++;
        recordFile(r.fullPaths[i], r.names[i], r.cloud[i] ? 0 : r.diskSize[i], r.logicalSize[i], r.mtimeMs[i], r.cloud[i] ? 'icloud-only' : undefined);
      }
      skipped += r.stats.orphans + r.stats.torn;
      fastScanInfo = { engine: 'mft', ms: Date.now() - t0, stats: r.stats };
    } catch (e) {
      fastScanInfo = { engine: 'walk', fallbackReason: String(e && e.message || e) };
      console.warn('MFT fast scan unavailable, using normal scan:', fastScanInfo.fallbackReason);
    }
  }
  if (!fastScanInfo || fastScanInfo.engine !== 'mft') await walk(folderPath, 0);
  if (darwinZeroBlock.length && !scanState.cancelled) {
    const dataless = await findDatalessDarwin(darwinZeroBlock.map(f => f.fullPath));
    for (const f of darwinZeroBlock) {
      if (dataless.has(f.fullPath)) {
        cloudOnlyCount++;
        recordFile(f.fullPath, f.name, 0, f.size, f.mtimeMs, 'icloud-only');
      } else {
        recordFile(f.fullPath, f.name, f.size, f.size, f.mtimeMs);
      }
    }
  }
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
  const extStats = [...extStatsMap.values()].sort((x, y) => y.size - x.size).slice(0, 100);
  return {
    files: mergedFiles, totalFiles: files.length, totalSize, totalLogicalSize, totalCloudLogicalSize,
    skippedDirs: skipped, folderTree, cloudOnlyCount, extStats,
    cancelled: scanState.cancelled, excludedCount, allFiles: files,
    ...(fastScanInfo ? { fastScan: fastScanInfo } : {})
  };
}

module.exports = { runScan, buildExcluder, mapLimit, isPseudoFilesystemPath, statForScan };
