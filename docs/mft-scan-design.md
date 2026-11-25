# NTFS fast scan (MFT): design and prototype

Status: prototype, default OFF, Windows only, **never run on a real NTFS volume yet** (written and unit-tested on macOS only).

## Goal

Scan a whole NTFS volume in seconds, like WizTree / WinDirStat 2.5, without changing the default scanner. The walk reports ~374 GB on the 465 GB C: drive; the fast path must match within ~1% (`totalSize`) or the walk stays the answer.

## What the current walk reports (the thing to match)

Per file, from `fs.stat` (libuv):

| Field | Source | Rule in `main.js` |
|---|---|---|
| allocated size | `blocks*512` = NTFS AllocationSize | cluster-rounded; compressed/sparse = actual clusters; MFT-resident files = 0 |
| logical size | `stat.size` | |
| placeholder | `blocks==0 && size>4096` | `cloudStatus='icloud-only'`, diskSize 0 |
| hardlinks | `nlink>1` dedupe by dev:ino | counted once, first path met |
| symlinks / junctions | `Dirent.isSymbolicLink()` | neither file nor dir recorded or followed |
| locked files (pagefile, hiberfil) | PowerShell `FileInfo` retry | size = logical |
| unreadable dirs | `skipped++` | |

## Options

### A. FSCTL_ENUM_USN_DATA (USN / change journal enumeration)

Returns FRN, parent FRN, name, attributes for every file in one fast pass. **No sizes.** Sizes need an open or query per file (`OpenFileById` + `GetFileInformationByHandleEx`): millions of syscalls, i.e. about the speed of the walk. Also lists only records known to the journal enumeration, and needs a handle to the volume (admin). Rejected: gives names fast, not the numbers we need.

### B. Parse the raw `$MFT`

Open `\\.\C:`, read boot sector (MFT location, record size), read record 0 to find `$MFT`'s extents, stream all records, undo fixups, read `$STANDARD_INFORMATION` (mtime), `$FILE_NAME` (name, parent), unnamed `$DATA` (sizes, compression), `$REPARSE_POINT` (tag). Build paths from parent references. Gives every field the walk reports, in one sequential read. Needs admin (raw volume handle). Cost: we own an NTFS parser; correctness risks listed below.

### C. How to run B

| | Prebuilt helper exe | Native Node addon | PowerShell + `Add-Type` C# | Pure JS in main process (chosen) |
|---|---|---|---|---|
| Admin | same (volume read) | same | same | same |
| x64 + arm64 | two binaries; CI must build both | two prebuilds (node-gyp/N-API, electron ABI) | none (runs on .NET Framework) | none |
| Signing / AV | extra signed exe; unsigned helpers trip SmartScreen/AV | extra signed .node | `Add-Type` compiles at run time, AV heuristics dislike it, slow start (~1-2 s) | nothing new |
| electron-builder | `extraResources`, per-arch config, asarUnpack | native rebuild per arch, `asarUnpack` | none | one file in `files` |
| Debuggability | separate process, JSON/stdio protocol | crashes take down main | stdout parsing | same process, plain stack traces |
| Perf | best | best | good | ~5-30 s per 5M records (estimate, unmeasured) |

Node's `fs.promises.open('\\\\.\\C:')` plus `read` at sector-aligned offsets is enough to read the raw volume: no FSCTL, no native code. That removes the whole per-arch build and signing question. The main-process cost is parse CPU; the prototype yields to the event loop every 1 MiB of MFT and checks cancel.

## Recommendation

**B in pure JS (`mft-scan.js`).** Effort: prototype done (~350 lines); real validation on a few Windows machines (system drive, data drive, 4Kn disk, OneDrive, Compact OS, hardlink-heavy WinSxS) about 2-4 days, plus a UI toggle and an "elevate" hint (~0.5 day). Fallbacks: if parse CPU proves too heavy for the main thread, move `scanNtfsVolume` to a `worker_threads` worker (same file, no build change). A C# helper is the next step only if JS is too slow; it changes the build/signing story and is not recommended up front.

## Behaviour of the prototype

- Setting `mftFastScan` (settings.json, default absent = off). `STUFFDIVER_MFT_SCAN=1|0` env overrides (used by the compare script). No UI yet.
- Used only when: Windows, scan target is a whole drive root (`C:\`), no scan exclusions, setting on.
- Falls back to the normal walk, with nothing recorded, on any throw: not elevated / open fails, not NTFS (boot sector check), odd geometry, `$MFT` fragmented through an `$ATTRIBUTE_LIST`, short read, cancel, parse error. Results are fully computed before any `recordFile` call, so a failed fast scan cannot leave half a result.
- Result gains an extra field `fastScan: {engine:'mft'|'walk', ms, stats | fallbackReason}` only when a fast scan was attempted. Non-Windows and setting-off results are unchanged.
- Record shape: same `recordFile(virtualPath, name, diskSize, logicalSize, mtime, cloudStatus)`; tree, ext stats, duplicate cache all downstream and untouched.

## Semantics, one by one

- **Allocated vs logical.** Non-resident `$DATA`: allocated = header AllocationSize (`+0x28`); logical = real size (`+0x30`). Compressed or sparse (`compression unit != 0`): allocated = CompressedSize (`+0x40`), as Windows reports "size on disk". Resident `$DATA` (small files stored inside the MFT record): allocated 0, logical = content length, matching the walk's "resident reports 0".
- **Placeholders (OneDrive, Files On Demand).** Same rule as the walk: allocated 0 and logical > 4096 -> `icloud-only`, diskSize 0. Side effect (pre-existing in the walk too): Compact OS / WOF-compressed files may also fit this rule. Same rule on both paths keeps them equal; worth reviewing separately.
- **Hardlinks.** One MFT record = one file, emitted once, with the first non-DOS name. Walk also counts once (path may differ; totals equal). DOS 8.3 names are ignored unless nothing else exists.
- **Extension records.** Attributes of records with a non-zero base reference are merged into the base (sizes from the segment with starting VCN 0), so `$ATTRIBUTE_LIST` files get right sizes.
- **Reparse points.** Symlink (`0xA000000C`) and mount point (`0xA0000003`) entries are skipped, so junction children are never reached through the junction. Other reparse tags (OneDrive, dedup, WOF, appexec) are treated as regular files like libuv does for `isFile()`. **Unverified:** exactly which tags libuv reports as symlink; the compare script will show it as a diff.
- **Metadata files.** Records 0-23 and anything under `$Extend` are not emitted (walk cannot list them either). `$MFT`, `$LogFile` etc. therefore are not counted by either path (WinDirStat shows them; not needed for parity).
- **System Volume Information.** The walk cannot enter it (access denied even as admin), so the fast scan skips it and its children. Found by the Windows compare run: without this the total was 1.98% high (about 4 GB of restore points and VSS data).
- **Orphans.** Parent chain broken, parent not in use, or parent sequence number mismatch -> skipped and counted in `skippedDirs`.
- **Locked system files.** pagefile/hiberfil are plain records in the MFT; no PowerShell retry. Their allocated size is reported (walk reports logical). Expected diff: small.
- **Live-volume consistency.** Raw reads bypass the cache; recently written metadata may be stale or torn. Torn records fail the fixup check and are skipped (`stats.torn`). Expect tiny, non-deterministic differences vs. the walk on a busy system drive.
- **Dedup, ADS, VSS.** Named streams (ADS) ignored, as in the walk. Dedup'd/other-volume data not followed.
- **Exclusions.** Not implemented in the fast path; any exclusion disables it (simplest-correct). Applying them per ancestor path is possible later.
- **Memory.** Typed arrays by record number plus a name string per record; for 5M records roughly 400-600 MB transient peak. Unmeasured.

## Not tested (macOS only)

Everything touching real NTFS: opening `\\.\C:` from Electron (assumed to work as admin; sector alignment assumed satisfied because reads are at cluster-aligned offsets with lengths of whole records), the 4Kn disk case, real fixup/attribute layout in the wild (the synthetic image in `tests/mft-synth.js` encodes my reading of the format, so it proves parser logic, not fidelity), libuv's reparse/`blocks` semantics on compressed/WOF/OneDrive files, parse speed, memory, UI behaviour, the packaged build including `mft-scan.js`. The unit test `tests/mft-parser.e2e.js` (synthetic image, pure JS) runs on all CI platforms.

## How to validate on Windows

Elevated terminal:

```
node tests/mft-compare.manual.js C:/ --depth 2
```

Scans with the walk, then with the MFT, prints totals, file counts, seconds, and the largest per-folder differences; exit 1 if the fast scan fell back or sizes differ more than 1%. Enable for real use by adding `"mftFastScan": true` to the app's `settings.json` (only after the compare passes).

## Open risks

1. Real-volume layouts the synthetic test cannot cover (first thing to find on the first Windows run).
2. Main-thread CPU and memory on 5M+ record volumes (mitigation: worker thread).
3. Equivalence rests on matching libuv quirks (reparse tags, placeholder rule); the compare script is the gate.
4. Needs Administrator; non-elevated users never get it (the app already has an elevate flow).
