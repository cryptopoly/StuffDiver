# Stuff Diver 0.5.1

Build fix: the macOS release is built on a pinned macOS 15 runner so signing works again. No app changes since 0.5.0, whose notes follow.

## Stuff Diver 0.5.0

Accuracy and safety update. Scans are more accurate on all three platforms, cleaning up is much safer, and there is a new command-line mode.

## Highlights

- **Safer clean-up**: Smart Cleanup was reworked so it cannot suggest things that break your computer or your apps.
  - Only `.DS_Store` and `Thumbs.db` files are ticked by default. Everything else you tick yourself.
  - Files inside app bundles and installed-app folders are never offered, so apps keep their signatures.
  - Cloud-synced folders (iCloud, Dropbox, OneDrive, Google Drive and others) and the Trash are never offered and are refused if requested.
  - Risky presets were removed or narrowed: backup and swap files, `dist` folders, `.git` folders, database and chat logs, AI model folders you imported yourself, and tool installs.
  - After every clean-up you see exactly what was moved, what failed and why, and what was skipped.
- **Protected locations**: Stuff Diver refuses to remove drive roots, your home folder, Windows and macOS system folders, standard folders such as Documents and Desktop, other users' profiles, and credential stores such as `.ssh`, `.aws` and Keychains. If one item in a request is protected, nothing is removed.
- **Developer folders (advanced, off by default)**: an optional switch in Smart Cleanup lets you move `node_modules`, Python virtualenvs, build caches and similar re-creatable folders to the Trash in one step. Every folder is unticked, must carry its tool's own marker, and is re-checked just before it is moved. A folder is refused if it contains a Git or other version-control folder, your own documents, a mount point or a link to somewhere else, if it uses private or local packages, or if it sits in a cloud-synced, system or tool folder.
- **Undo for developer-folder cleanup**: with the Developer folders switch on, each cleanup moves folders into a hidden quarantine folder next to your files by a same-drive rename (instant, no extra copy) instead of the Trash, and the new Quarantine window (Tools menu) restores a whole run or a single folder exactly where it came from. Restore never overwrites anything, and a restore after the folder changed asks you to confirm. Nothing is purged automatically: emptying the quarantine moves it to the Trash, and quarantined folders keep using disk space until then. If a safe place on the same drive cannot be found (network, external or removable drives), the folder goes to the Trash instead and the results say why. On Windows the quarantine folder is used on the system drive only in this version; other Windows drives use the Recycle Bin.
- **Tighter app security**: other programs can no longer start Stuff Diver as a Node.js process or attach a debugger to it, and a second copy of the app now opens the existing window instead of starting again.
- **Deletion Log**: every item moved, removed, failed, skipped or refused is recorded, and the new Deletion Log window (Tools menu) lets you filter and search it.
- **Command-line mode**: scan a folder with no window and write CSV, JSON or HTML reports, for scripts and scheduled tasks. See the README for usage.
- **Cached scans are complete**: opening a cached scan now keeps every file, so Duplicates, Smart Cleanup and the Extensions panel see the whole scan instead of only the largest files.
- **Compare Scans works again**: it now compares the current scan with the previous one. Before, it compared a scan with itself. Forecast uses the same previous scan.

## Fixes

- All platforms: `.asar` files, which every Electron app contains, were counted as 0 bytes or skipped. They are now counted at their real size.
- All platforms: scans no longer fail on folders named `constructor`, `toString`, `valueOf` or `hasOwnProperty` (found inside some npm packages).
- macOS: small compressed system files were counted as 0 bytes and wrongly marked as cloud-only. Only files that are really stored in iCloud are marked now.
- macOS: scanning `/` no longer walks other drives, network mounts or the system's helper volumes, so the total can no longer exceed the size of your disk.
- Windows: some compressed files made the scanner report absurd sizes (billions of GB). Fixed.
- Linux: scanning `/` no longer walks network shares, FUSE mounts, VM shared folders or snap packages.
- The folder monitor no longer reports false growth caused by bad file sizes.
- A quick rescan can no longer corrupt the saved scan.
- Exclusions accept `~` for your home folder.
- The command-line mode no longer shows an error dialog when its output is piped into a program that closes early (for example `| head`).

## Notes

- Stuff Diver moves items to the system Trash or Recycle Bin and never deletes permanently itself. The one exception to a Trash copy is macOS, where removing a hidden `.DS_Store` file may not leave a copy; the results panel says "removed" instead of "moved" when that happens.
- Old cached scans are discarded automatically (the first open of a folder rescans).
- macOS asks for access to protected folders such as Desktop and Documents the first time you scan them. Grant Full Disk Access to avoid repeated prompts.
