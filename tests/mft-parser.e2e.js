// Unit test for mft-scan.js against a synthetic NTFS image. Pure JS, runs on every OS.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanNtfsVolume } = require('../mft-scan');
const S = require('./mft-synth');

const data = (alloc, real, runs = [{ lcn: 100, len: 1 }]) => S.attrNonResident({ alloc, real, runs });
const resident = (n) => S.attrResident(0x80, Buffer.alloc(n));
const MT = 1700000000000;

function specs() {
  return [
    { rec: 30, dir: true, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'Users')] },
    { rec: 31, dir: true, attrs: [S.stdInfo(MT), S.fileName(30, 1, 'dan')] },
    { rec: 32, attrs: [S.stdInfo(MT), S.fileName(31, 1, 'big.bin'), data(8192, 5000)] },
    { rec: 33, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'tiny.txt'), resident(20)] },
    // hardlink: two Win32 names in different dirs + DOS name; must appear once
    { rec: 34, attrs: [S.stdInfo(MT), S.fileName(30, 1, 'linked-a.dat'), S.fileName(31, 1, 'linked-b.dat'), S.fileName(30, 1, 'LINKED~1.DAT', 2), data(4096, 4000)] },
    // compressed: allocation comes from the compressed-size field
    { rec: 35, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'comp.log'), S.attrNonResident({ alloc: 1048576, real: 1000000, compressed: 262144, runs: [{ lcn: 100, len: 1 }] })] },
    // OneDrive-style placeholder: no clusters, big logical size
    { rec: 36, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'cloud.pdf'), data(0, 2000000, [])] },
    // file symlink and junction dir with a (bogus) child: neither is recorded
    { rec: 37, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'link.txt'), S.reparse(0xA000000C), resident(0)] },
    { rec: 38, dir: true, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'junction'), S.reparse(0xA0000003)] },
    { rec: 39, attrs: [S.stdInfo(MT), S.fileName(38, 1, 'inside.txt'), data(4096, 10)] },
    // orphan: parent record 50 is free
    { rec: 40, attrs: [S.stdInfo(MT), S.fileName(50, 1, 'orphan.txt'), data(4096, 10)] },
    // parent sequence mismatch (stale reference)
    { rec: 41, attrs: [S.stdInfo(MT), S.fileName(30, 9, 'stale.txt'), data(4096, 10)] },
    // sizes live in an extension record (attribute list case)
    { rec: 42, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'ext.bin')] },
    { rec: 43, base: 42, baseSeq: 40, attrs: [data(65536, 60000)] }, // seq >= 32: a double-based u64 would corrupt the record number
    // WOF / Compact OS file: unnamed $DATA is sparse with no clusters, payload is in the named WofCompressedData stream
    { rec: 48, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'wof.pak'), S.attrNonResident({ alloc: 1245184, real: 1232185, compressed: 0, runs: [] }), S.attrNonResident({ name: 'WofCompressedData', alloc: 397312, real: 396172, runs: [{ lcn: 100, len: 1 }] }), S.reparse(0x80000017)] },
    // torn record (fixup mismatch) is skipped
    { rec: 44, corrupt: true, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'torn.txt'), data(4096, 10)] },
    // metadata area: anything under $Extend (record 11) must not appear
    { rec: 11, dir: true, attrs: [S.stdInfo(MT), S.fileName(5, 1, '$Extend')] },
    { rec: 45, attrs: [S.stdInfo(MT), S.fileName(11, 1, '$UsnJrnl'), data(4096, 10)] },
    // corrupt attribute: FILE_NAME claims a 200-char name but the attribute is shorter; must be skipped, not read past
    { rec: 47, attrs: [S.stdInfo(MT), (() => { const c = Buffer.alloc(0x44); c[0x40] = 200; c[0x41] = 1; return S.attrResident(0x30, c); })(), data(4096, 10)] },
    // deleted record
    { rec: 46, inUse: false, attrs: [S.stdInfo(MT), S.fileName(5, 1, 'deleted.txt'), data(4096, 10)] }
  ];
}

async function run(opts) {
  const img = S.buildImage(specs(), opts);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-mft-')), 'vol.img');
  fs.writeFileSync(file, img);
  const r = await scanNtfsVolume('C:\\', { devicePath: file });
  const byPath = {};
  for (let i = 0; i < r.count; i++) {
    byPath[r.fullPaths[i]] = { disk: r.diskSize[i], logical: r.logicalSize[i], cloud: r.cloud[i], mtime: r.mtimeMs[i], name: r.names[i] };
  }
  return { r, byPath };
}

for (const fragmentMft of [false, true]) {
  test(`synthetic MFT parses as the walk would (fragmentMft=${fragmentMft})`, async () => {
    const { r, byPath } = await run({ fragmentMft });
    expect(Object.keys(byPath).sort()).toEqual([
      'C:\\Users\\dan\\big.bin',
      'C:\\Users\\linked-a.dat',
      'C:\\comp.log',
      'C:\\cloud.pdf',
      'C:\\ext.bin',
      'C:\\wof.pak',
      'C:\\tiny.txt'
    ].sort());
    expect(byPath['C:\\Users\\dan\\big.bin']).toMatchObject({ disk: 8192, logical: 5000, cloud: false, mtime: MT });
    expect(byPath['C:\\tiny.txt']).toMatchObject({ disk: 0, logical: 20, cloud: false });
    expect(byPath['C:\\Users\\linked-a.dat']).toMatchObject({ disk: 4096, logical: 4000 });
    expect(byPath['C:\\comp.log']).toMatchObject({ disk: 262144, logical: 1000000 });
    expect(byPath['C:\\cloud.pdf']).toMatchObject({ disk: 0, logical: 2000000, cloud: true });
    expect(byPath['C:\\wof.pak']).toMatchObject({ disk: 397312, logical: 1232185, cloud: false });
    expect(byPath['C:\\ext.bin']).toMatchObject({ disk: 65536, logical: 60000 });
    expect(r.stats.torn).toBe(1);
    expect(r.stats.badAttrs).toBe(1);
    expect(r.stats.orphans).toBe(4); // orphan, stale parent seq, inside junction, under $Extend
  });
}

test('rejects a non-NTFS image so the caller can fall back', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-mft-')), 'bad.img');
  fs.writeFileSync(file, Buffer.alloc(4096));
  await expect(scanNtfsVolume('C:\\', { devicePath: file })).rejects.toThrow(/not NTFS/);
});

test('cancel aborts with an error instead of partial results', async () => {
  const img = S.buildImage(specs());
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-mft-')), 'vol.img');
  fs.writeFileSync(file, img);
  await expect(scanNtfsVolume('C:\\', { devicePath: file, isCancelled: () => true })).rejects.toThrow(/cancelled/);
});
