<p align="center">
  <img src="StuffDiver v8 LogoOnly.png" width="128" alt="Stuff Diver logo">
</p>

<h1 align="center">Stuff Diver</h1>

<p align="center">
  <strong>Dive deep into your disk space</strong><br>
  Interactive visualisations, duplicate detection, and smart cleanup tools for macOS, Windows, and Linux.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.2-blue" alt="Version">
  <img src="https://img.shields.io/badge/electron-35-teal" alt="Electron">
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-green" alt="Platforms">
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="License">
  <br>
  <a href="https://stuffdiver.com">🌐 stuffdiver.com</a>
</p>

---

## What is Stuff Diver?

Stuff Diver is a desktop app that helps you understand where your disk space is going. Select any folder and instantly see its contents brought to life through seven interactive visualisation modes, find duplicate files wasting space, and clean up with intelligent pattern-based tools.

## Features

### 7 Visualisation Modes

| View | Description |
|------|-------------|
| **Rings** | Concentric rings showing folder hierarchy at a glance |
| **Treemap** | Space-filling rectangles sized by file/folder size |
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

Pattern-based cleanup that detects and categorises:

- System caches and temp files
- Log files and thumbnail caches
- Old downloads and broken shortcuts
- Duplicate applications

Preview what will be removed and how much space you'll recover before committing.

### Storage Forecast

Compares current and previous scans to project growth trends -- daily/monthly rates and an estimate of when your drive will fill up.

### Watch Folder

Background monitoring with configurable intervals (6h / daily / weekly). Get system notifications when a folder grows significantly. Runs in the system tray when minimised.

### More

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
├── main.js          # Electron main process (scanning, IPC, tray, updates)
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
