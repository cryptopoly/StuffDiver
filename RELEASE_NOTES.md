# Stuff Diver 0.4.5

Big accuracy and usability update. Whole-drive scans on Windows now match what WinDirStat reports, and there are several new tools for finding what is eating your disk.

## Highlights

- **Folders view**: a nested, WinDirStat-style treemap of your folders. Click a folder to zoom in; a Free Space block shows what is left on a whole-drive scan.
- **Accurate Windows totals**: on a 465 GB drive, a scan that used to report about 170 GB now reports about 374 GB, close to WinDirStat. See the fixes below.
- **Cancel a scan**: stop a long scan at any time and keep the partial result.
- **Faster scans**: files are read in parallel. A 850,000-file C: drive scans in about 90 seconds.
- **File extensions panel**: open Summary to see which extensions use the most space across the whole scan, and click one to list its largest files.
- **Scan exclusions**: skip names (`node_modules`), patterns (`*.tmp`) or full paths in Settings.
- **Free space in the stats bar**: "Free: 39.2 GB of 464.7 GB" is shown for every scan.
- **Protected-folder banner**: when folders cannot be read, Stuff Diver says why. On Windows it offers **Restart as admin**; on macOS it opens the Full Disk Access settings.

## Fixes

- Fixed whole-drive scans silently skipping large folders. Windows file IDs are 64-bit and were being rounded, so unrelated folders looked like duplicates of each other.
- Windows: `pagefile.sys`, `hiberfil.sys` and `swapfile.sys` are now counted (about 43 GB on a typical machine).
- Windows: sizes are now what files occupy on disk (cluster size, compression, sparse files) instead of their logical size. OneDrive online-only files are recognised and no longer counted as local space.
- Windows: free space and drive usage were not shown at all, because they relied on `wmic`, which current Windows 11 does not include. They now work on Windows, macOS and Linux.
- Windows: clicking a folder in the sidebar showed no files, because relative paths used backslashes. Paths are now consistent on every platform.
- Hidden folders such as `.cache` and `.ollama` are included in scans, so AI model caches are counted. (Earlier in this release cycle.)
- Smart Cleanup searched only the 500 largest files and never matched anything on Windows. It now checks every scanned file.
- The treemap breadcrumb disappeared after the first render.
- Linux: scanning `/` no longer walks `/proc`, `/sys`, `/dev` and `/run`.
- Update checks and the in-app update flow are more reliable.

## Smaller improvements

- Smart Cleanup has new presets: Windows temp files, Windows Update downloads, crash dumps, AI model caches, package-manager caches, and Linux and macOS cache folders.
- Duplicate finder compares the start and end of each file first and reads several files at once, so large libraries finish sooner.
- Cloud-only files are now labelled "Cloud only" rather than "iCloud only", since they also apply to OneDrive.
- Whole-drive scans show scanned, drive-used and other-used totals with percentages.
- Old cached scans are discarded automatically so you do not see outdated totals; the first open of a folder will rescan.
- An end-to-end test suite (Playwright) now runs on Windows, macOS and Linux for every push.

## Notes

- Some folders (for example System Volume Information) can only be read as administrator, so "Other used" will not reach zero without elevation.
- Release installers: Windows (x64 and arm64), macOS (Apple silicon and Intel), Linux (AppImage and deb).
