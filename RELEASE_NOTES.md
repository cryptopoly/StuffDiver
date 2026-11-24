# Stuff Diver 0.4.6

Accuracy and safety update. Scans are more accurate on all three platforms, deleting is much safer, and there is a new command-line mode.

## Highlights

- **Safer deleting**: Stuff Diver now refuses to move anything to the trash that could break your computer: drive roots, your home folder, Windows and macOS system folders, standard folders such as Documents and Desktop, other users' profiles, and credential stores such as `.ssh`, `.aws` and Keychains. If any item in a request is protected, nothing is deleted.
- **Deletion log**: every item moved to the trash, failed or refused is recorded in `deletion-log.jsonl` in the app's data folder, with the path, size and time. Files always go to the system trash, so you can put them back.
- **Command-line mode**: scan a folder with no window and write CSV, JSON or HTML reports, for scripts and scheduled tasks. See the README for usage.
- **Cached scans are complete**: opening a cached scan now keeps every file, so Duplicates, Smart Cleanup and the Extensions panel see the whole scan instead of only the largest files.
- **Compare Scans works again**: it now compares the current scan with the previous one. Before, it compared a scan with itself. Forecast uses the same previous scan.

## Fixes

- macOS and all platforms: `.asar` files, which every Electron app contains, were counted as 0 bytes or skipped. They are now counted at their real size.
- macOS: small compressed system files were counted as 0 bytes and wrongly marked as cloud-only. Only files that are really stored in iCloud are marked now.
- macOS: scanning `/` no longer walks other drives, network mounts or the system's helper volumes, so the total can no longer exceed the size of your disk.
- Windows: some compressed files made the scanner report absurd sizes (billions of GB). Fixed.
- Linux: scanning `/` no longer walks network shares, FUSE mounts, VM shared folders or snap packages.
- Windows: Smart Cleanup no longer offers files in protected system folders, which used to cancel the whole clean-up.
- The folder monitor no longer reports false growth caused by bad file sizes.
- A quick rescan can no longer corrupt the saved scan.
- Exclusions accept `~` for your home folder.
- Scans no longer fail on folders named `constructor`, `toString`, `valueOf` or `hasOwnProperty` (found inside some npm packages).

## Notes

- Old cached scans are discarded automatically (the first open of a folder rescans).
- macOS asks for access to protected folders such as Desktop and Documents the first time you scan them. Grant Full Disk Access to avoid repeated prompts.
