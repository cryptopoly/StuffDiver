// Optional fast scan of a whole NTFS volume by reading the raw $MFT.
// Windows only, needs Administrator (raw volume read). See docs/mft-scan-design.md.
//
// scanNtfsVolume() returns the same facts the directory walk gathers per file
// (path, name, allocated size, logical size, mtime, cloud-only flag) so main.js
// can feed them through recordFile unchanged. It throws on anything it does not
// understand; the caller then falls back to the normal walk.
'use strict';

const fs = require('fs');
const path = require('path');

const FIRST_USER_RECORD = 24; // records 0-23 are NTFS metadata ($MFT, $Bitmap, $Extend, ...)
const ROOT_RECORD = 5;
const MAX_DEPTH = 256;
const CLOUD_MIN_SIZE = 4096; // same rule as the walk: 0 clusters + bigger than this = placeholder

// Per-record flag bits.
const F_USED = 1, F_DIR = 2, F_LINK = 4, F_HASNAME = 8;

const FILETIME_UNIX_EPOCH = 116444736000000000;

function u64(buf, off) {
  return buf.readUInt32LE(off) + buf.readUInt32LE(off + 4) * 4294967296;
}

function parseBootSector(b) {
  if (b.length < 512) throw new Error('short boot sector');
  if (b.toString('latin1', 3, 11) !== 'NTFS    ') throw new Error('not NTFS');
  if (b.readUInt16LE(510) !== 0xAA55) throw new Error('bad boot signature');
  const bytesPerSector = b.readUInt16LE(0x0B);
  let spc = b.readUInt8(0x0D);
  if (spc > 0x80) spc = 2 ** (256 - spc);
  const clustersPerFrs = b.readInt8(0x40);
  const clusterSize = bytesPerSector * spc;
  const frsSize = clustersPerFrs > 0 ? clustersPerFrs * clusterSize : 2 ** (-clustersPerFrs);
  const mftLcn = u64(b, 0x30);
  if (![512, 1024, 2048, 4096].includes(bytesPerSector)) throw new Error('odd sector size ' + bytesPerSector);
  if (!(spc >= 1) || clusterSize > 2 * 1024 * 1024) throw new Error('odd cluster size');
  if (frsSize < 512 || frsSize > 65536 || frsSize % bytesPerSector) throw new Error('odd record size ' + frsSize);
  return { bytesPerSector, clusterSize, frsSize, mftLcn, totalSectors: u64(b, 0x28) };
}

// Undo the update-sequence-array protection in place. False = record is torn/corrupt.
function applyFixups(buf, off, frsSize) {
  const usaOff = buf.readUInt16LE(off + 4);
  const usaCount = buf.readUInt16LE(off + 6);
  if (usaCount < 2 || usaOff + usaCount * 2 > frsSize || (usaCount - 1) * 512 > frsSize) return false;
  const usn0 = buf[off + usaOff], usn1 = buf[off + usaOff + 1];
  for (let i = 1; i < usaCount; i++) {
    const end = off + i * 512 - 2;
    if (buf[end] !== usn0 || buf[end + 1] !== usn1) return false;
    buf[end] = buf[off + usaOff + i * 2];
    buf[end + 1] = buf[off + usaOff + i * 2 + 1];
  }
  return true;
}

// Decode a runlist into [{lcn, len}] (len in clusters; lcn null = sparse hole).
function parseRuns(buf, start, end) {
  const runs = [];
  let p = start, lcn = 0;
  while (p < end && buf[p] !== 0) {
    const lenBytes = buf[p] & 0x0F, offBytes = buf[p] >> 4;
    p++;
    if (lenBytes === 0 || lenBytes > 8 || offBytes > 8 || p + lenBytes + offBytes > end) throw new Error('bad runlist');
    let len = 0;
    for (let i = lenBytes - 1; i >= 0; i--) len = len * 256 + buf[p + i];
    p += lenBytes;
    if (offBytes === 0) {
      runs.push({ lcn: null, len });
    } else {
      let delta = 0;
      for (let i = offBytes - 1; i >= 0; i--) delta = delta * 256 + buf[p + i];
      if (buf[p + offBytes - 1] & 0x80) delta -= 2 ** (8 * offBytes);
      p += offBytes;
      lcn += delta;
      runs.push({ lcn, len });
    }
  }
  return runs;
}

// Locate $MFT's own extents from record 0.
function readMftExtents(buf, geo) {
  if (buf.toString('latin1', 0, 4) !== 'FILE') throw new Error('record 0 has no FILE signature');
  if (!applyFixups(buf, 0, geo.frsSize)) throw new Error('record 0 fixup failed');
  let a = buf.readUInt16LE(0x14);
  while (a + 8 <= geo.frsSize) {
    const type = buf.readUInt32LE(a);
    if (type === 0xFFFFFFFF) break;
    const len = buf.readUInt32LE(a + 4);
    if (len < 16 || a + len > geo.frsSize) break;
    if (type === 0x80 && buf[a + 9] === 0) { // unnamed $DATA
      if (buf[a + 8] !== 1) throw new Error('$MFT $DATA is resident');
      if (u64(buf, a + 0x10) !== 0) throw new Error('$MFT $DATA does not start at VCN 0');
      const allocSize = u64(buf, a + 0x28);
      const realSize = u64(buf, a + 0x30);
      const runs = parseRuns(buf, a + buf.readUInt16LE(a + 0x20), a + len);
      let clusters = 0;
      for (const r of runs) {
        if (r.lcn === null) throw new Error('sparse $MFT');
        clusters += r.len;
      }
      // $MFT extents spilling into an $ATTRIBUTE_LIST extension record: not handled.
      if (clusters * geo.clusterSize < allocSize) throw new Error('$MFT runlist incomplete (attribute list)');
      return { runs, realSize };
    }
    a += len;
  }
  throw new Error('$MFT $DATA not found');
}

function yieldToLoop() { return new Promise((r) => setImmediate(r)); }

// Entry point. volumeRoot is the path prefix for results ("C:\\"); devicePath is
// what to open for raw reads ("\\\\.\\C:", or an image file in tests).
async function scanNtfsVolume(volumeRoot, opts = {}) {
  const isCancelled = opts.isCancelled || (() => false);
  const devicePath = opts.devicePath || `\\\\.\\${volumeRoot.slice(0, 2)}`;
  const fh = await fs.promises.open(devicePath, 'r');
  try {
    const boot = Buffer.alloc(512);
    await fh.read(boot, 0, 512, 0);
    const geo = parseBootSector(boot);
    const { frsSize, clusterSize } = geo;

    const rec0 = Buffer.alloc(frsSize);
    await fh.read(rec0, 0, frsSize, geo.mftLcn * clusterSize);
    const { runs, realSize } = readMftExtents(rec0, geo);
    const numRecords = Math.floor(realSize / frsSize);
    if (numRecords < FIRST_USER_RECORD + 1 || numRecords > 2 ** 31) throw new Error('implausible MFT size ' + numRecords);

    // Per-record state, indexed by record number.
    const flags = new Uint8Array(numRecords);
    const seq = new Uint16Array(numRecords);
    const parent = new Uint32Array(numRecords);
    const parentSeq = new Uint16Array(numRecords);
    const nameRank = new Uint8Array(numRecords);
    const alloc = new Float64Array(numRecords);
    const real = new Float64Array(numRecords);
    const mtime = new Float64Array(numRecords);
    const names = new Array(numRecords);
    const stats = { records: numRecords, inUse: 0, torn: 0, extension: 0 };

    function parseAttributes(buf, off, n, base) {
      const t = base; // record that receives the attributes
      if (t >= numRecords) return;
      let a = off + buf.readUInt16LE(off + 0x14);
      const end = off + frsSize;
      while (a + 8 <= end) {
        const type = buf.readUInt32LE(a);
        if (type === 0xFFFFFFFF) break;
        const len = buf.readUInt32LE(a + 4);
        if (len < 16 || a + len > end) break;
        const nonRes = buf[a + 8];
        const nameLen = buf[a + 9];
        if (type === 0x10 && nonRes === 0) { // $STANDARD_INFORMATION
          const c = a + buf.readUInt16LE(a + 0x14);
          const ft = u64(buf, c + 8); // last write time
          mtime[t] = ft > 0 ? (ft - FILETIME_UNIX_EPOCH) / 10000 : 0;
        } else if (type === 0x30 && nonRes === 0) { // $FILE_NAME
          const c = a + buf.readUInt16LE(a + 0x14);
          const ns = buf[c + 0x41];
          const rank = ns === 2 ? 1 : 2; // DOS 8.3 names only if nothing else exists
          if (rank > nameRank[t]) {
            nameRank[t] = rank;
            parent[t] = buf.readUInt32LE(c); // low 32 bits of the 48-bit record number
            parentSeq[t] = buf.readUInt16LE(c + 6);
            names[t] = buf.toString('utf16le', c + 0x42, c + 0x42 + buf[c + 0x40] * 2);
            flags[t] |= F_HASNAME;
          }
        } else if (type === 0xC0 && nonRes === 0) { // $REPARSE_POINT: only symlinks/junctions are skipped (as the walk does)
          const c = a + buf.readUInt16LE(a + 0x14);
          const tag = buf.readUInt32LE(c);
          if (tag === 0xA000000C || tag === 0xA0000003) flags[t] |= F_LINK;
        } else if (type === 0x80 && nameLen === 0) { // unnamed $DATA
          if (nonRes === 0) {
            real[t] = buf.readUInt32LE(a + 0x10);
            alloc[t] = 0; // resident in the MFT: no clusters, like the walk
          } else if (u64(buf, a + 0x10) === 0) { // segment holding VCN 0 carries the sizes
            const compUnit = buf.readUInt16LE(a + 0x22);
            real[t] = u64(buf, a + 0x30);
            alloc[t] = compUnit > 0 ? u64(buf, a + 0x40) : u64(buf, a + 0x28);
          }
        }
        a += len;
      }
    }

    // Phase 1: stream the whole $MFT.
    const CHUNK_RECORDS = Math.max(1, Math.floor((1024 * 1024) / frsSize));
    const chunkBuf = Buffer.alloc(CHUNK_RECORDS * frsSize);
    let runIdx = 0, runStartByte = 0; // logical byte offset where runs[runIdx] begins
    for (let n0 = 0; n0 < numRecords; n0 += CHUNK_RECORDS) {
      if (isCancelled()) throw new Error('cancelled');
      const want = Math.min(CHUNK_RECORDS, numRecords - n0) * frsSize;
      // Fill chunkBuf from the runlist (a chunk may span runs).
      let filled = 0, logical = n0 * frsSize;
      while (filled < want) {
        while (runIdx < runs.length && logical >= runStartByte + runs[runIdx].len * clusterSize) {
          runStartByte += runs[runIdx].len * clusterSize;
          runIdx++;
        }
        if (runIdx >= runs.length) throw new Error('MFT read past end of runlist');
        const run = runs[runIdx];
        const inRun = logical - runStartByte;
        const take = Math.min(want - filled, run.len * clusterSize - inRun);
        const { bytesRead } = await fh.read(chunkBuf, filled, take, run.lcn * clusterSize + inRun);
        if (bytesRead !== take) throw new Error('short read from volume');
        filled += take;
        logical += take;
      }
      for (let i = 0; i * frsSize < want; i++) {
        const off = i * frsSize;
        const n = n0 + i;
        if (chunkBuf.readUInt32LE(off) !== 0x454C4946) continue; // 'FILE'
        const rflags = chunkBuf.readUInt16LE(off + 0x16);
        if (!(rflags & 1)) continue; // not in use
        if (!applyFixups(chunkBuf, off, frsSize)) { stats.torn++; continue; }
        // 48-bit record number; u64() would lose low bits once the sequence number (top 16 bits) is >= 32
        const baseRef = chunkBuf.readUInt32LE(off + 0x20) + chunkBuf.readUInt16LE(off + 0x24) * 4294967296;
        if (baseRef === 0) {
          flags[n] |= F_USED | (rflags & 2 ? F_DIR : 0);
          seq[n] = chunkBuf.readUInt16LE(off + 0x10);
          stats.inUse++;
          parseAttributes(chunkBuf, off, n, n);
        } else {
          stats.extension++;
          parseAttributes(chunkBuf, off, n, baseRef);
        }
      }
      await yieldToLoop();
    }

    // Phase 2: resolve paths (pure in-memory, no I/O).
    const dirPaths = new Map();
    dirPaths.set(ROOT_RECORD, volumeRoot);
    function resolveDir(n, depth) {
      if (dirPaths.has(n)) return dirPaths.get(n);
      let result = null;
      if (depth < MAX_DEPTH && n >= FIRST_USER_RECORD && n < numRecords &&
          (flags[n] & (F_USED | F_DIR | F_HASNAME)) === (F_USED | F_DIR | F_HASNAME) && !(flags[n] & F_LINK)) {
        const p = parent[n];
        if (p < numRecords && (flags[p] & F_USED) && seq[p] === parentSeq[n]) {
          const pp = p === n ? null : resolveDir(p, depth + 1);
          if (pp !== null) result = path.win32.join(pp, names[n]);
        }
      }
      dirPaths.set(n, result);
      return result;
    }

    const out = { count: 0, fullPaths: [], names: [], diskSize: [], logicalSize: [], mtimeMs: [], cloud: [], stats };
    for (let n = FIRST_USER_RECORD; n < numRecords; n++) {
      const f = flags[n];
      if ((f & (F_USED | F_DIR | F_HASNAME)) !== (F_USED | F_HASNAME)) continue; // free, directory, or nameless
      if (f & F_LINK) continue; // file symlink: the walk does not record it
      const p = parent[n];
      if (p >= numRecords || !(flags[p] & F_USED) || seq[p] !== parentSeq[n]) { stats.orphans = (stats.orphans || 0) + 1; continue; }
      const dir = resolveDir(p, 0);
      if (dir === null) { stats.orphans = (stats.orphans || 0) + 1; continue; }
      let disk = alloc[n];
      let cloud = false;
      if (disk === 0 && real[n] > CLOUD_MIN_SIZE) cloud = true; // OneDrive / on-demand placeholder
      out.fullPaths.push(path.win32.join(dir, names[n]));
      out.names.push(names[n]);
      out.diskSize.push(disk);
      out.logicalSize.push(real[n]);
      out.mtimeMs.push(mtime[n]);
      out.cloud.push(cloud);
      out.count++;
      if ((n & 0xFFFF) === 0) { if (isCancelled()) throw new Error('cancelled'); await yieldToLoop(); }
    }
    stats.orphans = stats.orphans || 0;
    return out;
  } finally {
    await fh.close().catch(() => {});
  }
}

module.exports = { scanNtfsVolume, parseBootSector, applyFixups, parseRuns, readMftExtents };
