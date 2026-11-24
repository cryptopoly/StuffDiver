// Builds a tiny synthetic NTFS image (boot sector + $MFT) so the $MFT parser can
// be exercised on any OS. It encodes the on-disk layout as documented, so it
// proves the parser logic, NOT that it matches real Windows volumes.
const SECTOR = 512, SPC = 8, CLUSTER = SECTOR * SPC, FRS = 1024;
const FT_EPOCH = 116444736000000000;

function u64(b, off, v) { b.writeUInt32LE(v % 4294967296, off); b.writeUInt32LE(Math.floor(v / 4294967296), off + 4); }
const pad8 = (n) => (n + 7) & ~7;

function attrResident(type, content, name = '') {
  const nameBytes = Buffer.from(name, 'utf16le');
  const contentOff = pad8(0x18 + nameBytes.length);
  const b = Buffer.alloc(pad8(contentOff + content.length));
  b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length, 4); b[8] = 0; b[9] = name.length;
  b.writeUInt16LE(0x18, 0x0A); b.writeUInt32LE(content.length, 0x10); b.writeUInt16LE(contentOff, 0x14);
  nameBytes.copy(b, 0x18); content.copy(b, contentOff);
  return b;
}

function runlist(runs) { // [{lcn,len}] absolute lcn
  const parts = []; let prev = 0;
  for (const r of runs) {
    const delta = r.lcn - prev; prev = r.lcn;
    const lb = Buffer.alloc(8); u64(lb, 0, r.len);
    let ln = 8; while (ln > 1 && lb[ln - 1] === 0) ln--;
    const db = Buffer.alloc(8); db.writeBigInt64LE(BigInt(delta));
    let dn = 8; while (dn > 1 && ((db[dn - 1] === 0 && !(db[dn - 2] & 0x80)) || (db[dn - 1] === 0xFF && (db[dn - 2] & 0x80)))) dn--;
    parts.push(Buffer.from([(dn << 4) | ln]), lb.subarray(0, ln), db.subarray(0, dn));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function attrNonResident({ type = 0x80, startVcn = 0, alloc, real, compressed, runs = [], name = '' }) {
  const rl = runlist(runs);
  const nameBytes = Buffer.from(name, 'utf16le');
  const hdr = 0x40 + (compressed !== undefined ? 8 : 0);
  const runOff = pad8(hdr + nameBytes.length);
  const b = Buffer.alloc(pad8(runOff + rl.length));
  b.writeUInt16LE(hdr, 0x0A); b[9] = name.length; nameBytes.copy(b, hdr);
  b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length, 4); b[8] = 1;
  u64(b, 0x10, startVcn); u64(b, 0x18, 0);
  b.writeUInt16LE(runOff, 0x20); b.writeUInt16LE(compressed !== undefined ? 4 : 0, 0x22);
  u64(b, 0x28, alloc); u64(b, 0x30, real); u64(b, 0x38, real);
  if (compressed !== undefined) u64(b, 0x40, compressed);
  rl.copy(b, runOff);
  return b;
}

const stdInfo = (mtimeMs) => { const c = Buffer.alloc(0x48); u64(c, 8, Math.round(mtimeMs * 10000 + FT_EPOCH)); return attrResident(0x10, c); };
function fileName(parent, parentSeq, name, ns = 1) {
  const nb = Buffer.from(name, 'utf16le');
  const c = Buffer.alloc(0x42 + nb.length);
  u64(c, 0, parent); c.writeUInt16LE(parentSeq, 6); c[0x40] = name.length; c[0x41] = ns; nb.copy(c, 0x42);
  return attrResident(0x30, c);
}
const reparse = (tag) => { const c = Buffer.alloc(8); c.writeUInt32LE(tag, 0); return attrResident(0xC0, c); };

function record({ seq = 1, dir = false, inUse = true, base = 0, baseSeq = 0, attrs = [], corrupt = false }) {
  const b = Buffer.alloc(FRS);
  b.write('FILE', 0, 'latin1');
  const usaCount = FRS / 512 + 1;
  b.writeUInt16LE(0x30, 4); b.writeUInt16LE(usaCount, 6);
  b.writeUInt16LE(seq, 0x10);
  const first = 0x38;
  b.writeUInt16LE(first, 0x14); b.writeUInt16LE((inUse ? 1 : 0) | (dir ? 2 : 0), 0x16);
  b.writeUInt32LE(FRS, 0x1C); b.writeUInt32LE(base, 0x20); b.writeUInt16LE(baseSeq, 0x26);
  let p = first;
  for (const a of attrs) { a.copy(b, p); p += a.length; }
  b.writeUInt32LE(0xFFFFFFFF, p);
  // fixups: save the last 2 bytes of each sector in the USA, stamp the USN
  b.writeUInt16LE(0x7777, 0x30);
  for (let i = 1; i < usaCount; i++) {
    b.copy(b, 0x30 + i * 2, i * 512 - 2, i * 512);
    b.writeUInt16LE(corrupt && i === 1 ? 0x1111 : 0x7777, i * 512 - 2);
  }
  return b;
}

// spec: [{rec, ...recordOpts}] by record number; records not listed are free (zeroed).
// fragmentMft: put the second half of the MFT in a separate, non-adjacent run.
function buildImage(specs, { totalRecords = 64, fragmentMft = false } = {}) {
  const mftClusters = Math.ceil(totalRecords * FRS / CLUSTER);
  const mftLcn = 4;
  const half = Math.floor(mftClusters / 2);
  const runs = fragmentMft
    ? [{ lcn: mftLcn, len: half }, { lcn: mftLcn + mftClusters + 10, len: mftClusters - half }]
    : [{ lcn: mftLcn, len: mftClusters }];
  const totalClusters = mftLcn + mftClusters + 40;
  const img = Buffer.alloc(totalClusters * CLUSTER);

  const boot = img.subarray(0, 512);
  boot.write('NTFS    ', 3, 'latin1');
  boot.writeUInt16LE(SECTOR, 0x0B); boot[0x0D] = SPC;
  u64(boot, 0x28, totalClusters * SPC); u64(boot, 0x30, mftLcn);
  boot.writeInt8(FRS >= CLUSTER ? FRS / CLUSTER : -Math.log2(FRS), 0x40);
  boot.writeUInt16LE(0xAA55, 510);

  const recs = new Array(totalRecords).fill(null);
  recs[0] = record({ attrs: [attrNonResident({ alloc: mftClusters * CLUSTER, real: totalRecords * FRS, runs })] });
  recs[5] = record({ dir: true, attrs: [stdInfo(0), fileName(5, 5, '.')] });
  for (const s of specs) recs[s.rec] = record(s);

  const mft = Buffer.alloc(mftClusters * CLUSTER);
  recs.forEach((r, i) => { if (r) r.copy(mft, i * FRS); });
  let off = 0;
  for (const r of runs) { mft.copy(img, r.lcn * CLUSTER, off, off + r.len * CLUSTER); off += r.len * CLUSTER; }
  return img;
}

module.exports = { buildImage, attrNonResident, attrResident, stdInfo, fileName, reparse, CLUSTER, FRS };
