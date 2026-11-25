<p align="center">
  <img src="StuffDiver v8 LogoOnly.png" width="128" alt="Stuff Diver logo">
</p>

<h1 align="center">Stuff Diver</h1>

<p align="center">
  <strong>Dive deep into your disk space</strong><br>
  Interactive visualisations, duplicate detection, and smart cleanup tools for macOS, Windows, and Linux.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.5-blue" alt="Version">
  <img src="https://img.shields.io/badge/electron-41-teal" alt="Electron">
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-green" alt="Platforms">
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="License">
  <br>
  <a href="https://stuffdiver.com">🌐 stuffdiver.com</a>
</p>

---

## What is Stuff Diver?

Stuff Diver is a desktop app that helps you understand where your disk space is going. Select any folder and instantly see its contents brought to life through eight interactive visualisation modes, find duplicate files wasting space, and clean up with intelligent pattern-based tools.

## Features

### 8 Visualisation Modes

| View | Description |
|------|-------------|
| **Rings** | Concentric rings showing folder hierarchy at a glance |
| **Treemap** | Space-filling rectangles sized by file size, with a Free Space block |
| **Folders** | Nested, WinDirStat-style treemap of folders; click to zoom in |
| **Pie Chart** | Circular breakdown of top files |
| **Bubbles** | Interactive circle packing with drill-down navigation |
| **Table** | Sortable list with full file details |
| **Histogram** | File size distribution across 9 size buckets |
| **Timeline** | Files grouped by modification date |

### 3 Colour Modes

- **By Age** -- gradient showing how recently files were modified
- **By Type** -- colour-coded file categories (images, video, audio, documents, code, archives, data, executables)
- **By Folder** -- distinct colours per top-level folder

### Duplicate Finder

Three-tier duplicate detection:

- **Gold** -- exact content matches (SHA-256 hash verification)
- **Silver** -- same name + same size
- **Bronze** -- same name, different sizes

Each group shows how much space is wasted so you can prioritise cleanup.

### Smart Cleanup

Finds files you can usually remove safely and moves them to the system Trash / Recycle Bin (nothing is permanently deleted, and every action is written to the deletion log). Loose-file presets: `.DS_Store` and `Thumbs.db` (the only ones pre-ticked), temp files, clearly-named log files, crash dumps, Windows temp and update downloads, package-manager and app caches, re-downloadable AI model caches, Spotlight indexes and `desktop.ini`. Files inside app bundles, installed-app folders, cloud-synced folders (Dropbox, OneDrive, iCloud, ...) and the Trash are never offered.

**Developer folders (advanced)** is off by default. When you switch it on, whole `node_modules`, build output (`target`, `.next`, `.nuxt`), caches (`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.gradle`), Xcode `DerivedData` and Python virtualenvs can be moved to the Trash, nothing pre-ticked. Each folder must carry the marker a real install or build leaves behind, is re-checked right before it moves, and is refused when it holds a repository, user documents, mounts, links, or something in use or not reinstallable.

Open **Tools > Deletion Log** to see every item that was trashed, failed, skipped or refused, and how to restore it.

### Storage Forecast

Compares current and previous scans to project growth trends -- daily/monthly rates and an estimate of when your drive will fill up.

### Watch Folder

Background monitoring with configurable intervals (6h / daily / weekly). Get system notifications when a folder grows significantly. Runs in the system tray when minimised.

### Accurate on every platform

- Windows: allocated (on-disk) sizes, pagefile/hiberfil/swapfile included, OneDrive placeholders detected, hard links counted once
- Exact 64-bit file IDs, so no folders are skipped as false duplicates
- Free space and drive usage read from the OS (Windows, macOS, Linux)
- Linux: `/proc`, `/sys`, `/dev`, `/run` skipped
- Protected folders: banner with *Restart as admin* (Windows) or Full Disk Access shortcut (macOS)

### More

- **Cancel scans** -- stop a long scan and keep the partial result
- **Scan exclusions** -- skip names, `*` patterns or full paths (Settings)
- **File extensions panel** -- space per extension across the whole scan; click to list the largest files

- **Cloud file detection** -- identifies iCloud placeholders and online-only files
- **Cloud filter** -- show All Files, Local Only, or Online Only
- **Interactive folder tree** -- sortable by size or name
- **File tags** -- colour-coded Keep / Reviewed / Delete tags
- **File preview** -- Quick Look integration for images, text, and media
- **Collector** -- staging area for batch deletions
- **Export** -- CSV, HTML report, and tags report
- **Scan comparison** -- diff two scans to see what changed
- **Drag and drop** -- drop a folder anywhere to scan it
- **Dark/light theme** -- toggle with one click
- **Auto-updates** -- built-in update mechanism

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- npm

### Install

```bash
git clone https://github.com/cryptopoly/StuffDiver.git
cd StuffDiver
npm install
```

### Run

```bash
npm start
```

### Test

End-to-end tests drive the real Electron app with Playwright:

```bash
npm test
```

### Command line (headless)

Scan a folder with no window, e.g. from a scheduled task or a script. The CLI is read-only: it never deletes or modifies scanned files and only writes the report files you name.

```bash
# From source
npx electron . --scan ~/Projects --export report.csv --export report.json --export report.html

# Packaged app (macOS / Windows / Linux)
"/Applications/Stuff Diver.app/Contents/MacOS/Stuff Diver" --scan /data --export out.csv
"C:\Program Files\Stuff Diver\Stuff Diver.exe" --scan D:\data --export out.json
```

| Option | Meaning |
|---|---|
| `--scan PATH` | Folder to scan (required) |
| `--export FILE` | Report to write; format from extension `.csv`, `.json` or `.html` (repeatable, at least one required) |
| `--exclude PAT` | Name/glob (`node_modules`, `*.tmp`) or path prefix to skip (repeatable) |
| `--top N` | Entries in the JSON/HTML summaries (default 20) |
| `--help`, `--version` | Show usage / version |

- **CSV** lists every scanned file: `path,size_on_disk,logical_size,mtime,ext` (mtime is ISO 8601 UTC).
- **JSON / HTML** hold totals plus the largest folders, largest files and size by extension. Folder paths are relative to the scanned folder; the folder list comes from the same tree the app shows, which prunes tiny folders on very large scans.
- Same scanner as the app: same exclusion rules, hard-link/firmlink dedupe and size-on-disk accounting.
- Progress and errors go to stderr. Exit code `0` = success, `1` = scan or export failed, `2` = bad usage.
- On Windows the app is a GUI program, so `cmd` and PowerShell return immediately. To get the exit code, use `Start-Process -Wait -PassThru` (then read `.ExitCode`), or run it as `& 'Stuff Diver.exe' --scan ... ; $LASTEXITCODE`. Do not pipe the output through `more`.
- On macOS, grant Full Disk Access to the app (or the terminal running it) to read protected folders; unreadable folders are counted as skipped.

### Build

```bash
# Current platform
npm run build

# Platform-specific (arm64 + x64)
npm run build:mac
npm run build:win
npm run build:linux
```

Builds output to the `dist/` directory.

## Tech Stack

- **Electron** 35 -- cross-platform desktop shell
- **Vanilla JS / HTML / CSS** -- no frontend framework, fast and lightweight
- **electron-builder** -- packaging and distribution
- **electron-updater** -- auto-update support

## Project Structure

```
StuffDiver/
├── main.js          # Electron main process (IPC, tray, updates)
├── scanner.js       # Folder scanner shared by the app and the CLI
├── cli.js           # Headless CLI: argument parsing and CSV/JSON/HTML export
├── renderer.js      # UI, visualisations, and all frontend logic
├── index.html       # Application shell
├── styles.css       # All styling including dark/light themes
├── preload.js       # Secure IPC bridge
├── logo.png         # App logo
├── build/           # Build assets and platform icons
├── scripts/         # Notarisation and build scripts
└── package.json
```

## Support the Project

Stuff Diver is built with passion and released for free. If you find it useful, consider supporting development via the GitHub Sponsor button or directly here:

<p align="center">
  <a href="https://buymeacoffee.com/cryptoraptor"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee"></a>
  <a href="https://www.paypal.com/donate/?hosted_button_id=YN9VHK856RZES"><img src="https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="PayPal"></a>
</p>

## License

MIT
