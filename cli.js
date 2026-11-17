// Headless command-line mode. Read-only: scans a folder and writes report
// files. Nothing here deletes, moves or modifies scanned files; the only
// writes are the --export output files the caller names.
const fs = require('fs');
const path = require('path');
const { runScan } = require('./scanner');

const USAGE = `Usage: Stuff Diver --scan PATH --export FILE [--export FILE ...] [options]

  --scan PATH       Folder to scan (required)
  --export FILE     Write a report; format from extension: .csv, .json or .html
                    (repeatable)
  --exclude PAT     Exclude a name/glob ("node_modules", "*.tmp") or a path
                    prefix (repeatable)
  --top N           Entries in the JSON/HTML summaries (default 20)
  --help            Show this help
  --version         Show version

CSV: every scanned file (path, size_on_disk, logical_size, mtime, ext).
JSON/HTML: totals, largest folders, largest files, size by extension.
Progress goes to stderr. Exit code: 0 ok, 1 scan/export failure, 2 bad usage.
The CLI never deletes or modifies scanned files.
`;

class UsageError extends Error {}

// Returns null when argv holds no CLI flags (normal GUI launch).
function parseCliArgs(args) {
  const cliFlags = ['--scan', '--export', '--exclude', '--top', '--help', '--version'];
  if (!args.some(a => cliFlags.some(f => a === f || a.startsWith(f + '=')))) return null;
  const opts = { scan: null, exports: [], exclude: [], top: 20, help: false, version: false };
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let inline = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    const val = () => {
      if (inline !== null) return inline;
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      i++;
      return v;
    };
    switch (a) {
      case '--scan': opts.scan = val(); break;
      case '--export': opts.exports.push(val()); break;
      case '--exclude': opts.exclude.push(val()); break;
      case '--top': {
        const n = Number(val());
        if (!Number.isInteger(n) || n < 1) throw new UsageError('--top needs a positive integer');
        opts.top = n; break;
      }
      case '--help': opts.help = true; break;
      case '--version': opts.version = true; break;
      case '--no-sandbox': break; // Chromium flag some Linux setups pass
      default:
        if (a.startsWith('-')) throw new UsageError(`Unknown option: ${a}`);
        throw new UsageError(`Unexpected argument: ${a}`);
    }
  }
  if (!opts.help && !opts.version) {
    if (!opts.scan) throw new UsageError('--scan PATH is required');
    if (!opts.exports.length) throw new UsageError('at least one --export FILE is required');
    for (const e of opts.exports) {
      if (!['.csv', '.json', '.html'].includes(path.extname(e).toLowerCase())) {
        throw new UsageError(`Unsupported export format: ${e} (use .csv, .json or .html)`);
      }
    }
  }
  return opts;
}

function csvCell(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(files) {
  const lines = ['path,size_on_disk,logical_size,mtime,ext'];
  for (const f of files) {
    const mtime = f.mtime ? new Date(f.mtime).toISOString() : '';
    lines.push([f.path, f.size, f.logicalSize || f.size, mtime, f.ext].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

function flattenFolders(node, prefix, out) {
  for (const c of Object.values(node.children || {})) {
    const p = prefix ? `${prefix}/${c.name}` : c.name;
    out.push({ path: p, size: c.size, logicalSize: c.logicalSize, fileCount: c.fileCount });
    flattenFolders(c, p, out);
  }
  return out;
}

function buildSummary(folder, result, opts) {
  const largestFolders = flattenFolders(result.folderTree, '', [])
    .sort((a, b) => b.size - a.size).slice(0, opts.top);
  const largestFiles = result.allFiles.slice().sort((a, b) => b.size - a.size).slice(0, opts.top)
    .map(f => ({
      path: f.path, size: f.size, logicalSize: f.logicalSize || f.size,
      mtime: f.mtime ? new Date(f.mtime).toISOString() : null, ext: f.ext
    }));
  return {
    scannedFolder: folder,
    generatedAt: new Date().toISOString(),
    exclusions: opts.exclude,
    totalFiles: result.totalFiles,
    totalSizeOnDisk: result.totalSize,
    totalLogicalSize: result.totalLogicalSize,
    skippedDirs: result.skippedDirs,
    excludedCount: result.excludedCount,
    cloudOnlyCount: result.cloudOnlyCount,
    largestFolders, // paths relative to scannedFolder
    largestFiles,
    byExtension: result.extStats.slice(0, opts.top)
  };
}

const esc = (v) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtSize(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
}

function toHtml(s) {
  const table = (head, rows) => `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stuff Diver report</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse;margin:0 0 2rem}
th,td{border:1px solid #ccc;padding:4px 10px;text-align:left}th{background:#f0f0f0}td{word-break:break-all}</style></head><body>
<h1>Stuff Diver report</h1>
<p>Folder: <code>${esc(s.scannedFolder)}</code><br>Generated: ${esc(s.generatedAt)}</p>
<p>${s.totalFiles} files, ${esc(fmtSize(s.totalSizeOnDisk))} on disk, ${esc(fmtSize(s.totalLogicalSize))} logical.
Skipped (unreadable) folders: ${s.skippedDirs}. Excluded entries: ${s.excludedCount}.</p>
<h2>Largest folders</h2>
${table(['Folder (relative)', 'Size on disk', 'Logical size', 'Files'], s.largestFolders.map(f => [f.path, fmtSize(f.size), fmtSize(f.logicalSize), f.fileCount]))}
<h2>Largest files</h2>
${table(['Path', 'Size on disk', 'Logical size', 'Modified'], s.largestFiles.map(f => [f.path, fmtSize(f.size), fmtSize(f.logicalSize), f.mtime || '']))}
<h2>Size by extension</h2>
${table(['Extension', 'Size on disk', 'Files'], s.byExtension.map(e => [e.ext, fmtSize(e.size), e.count]))}
</body></html>
`;
}

// Runs the CLI; resolves to the process exit code.
async function runCli(opts, { version }) {
  const err = (m) => process.stderr.write(m + '\n');
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.version) { process.stdout.write(version + '\n'); return 0; }
  const folder = path.resolve(opts.scan);
  try {
    if (!fs.statSync(folder).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    err(`Error: cannot scan ${folder}: ${e.code || e.message}`);
    return 1;
  }
  err(`Scanning ${folder} ...`);
  let result;
  try {
    result = await runScan(folder, {
      exclude: opts.exclude,
      onProgress: ({ count, skipped }) => err(`  ${count} files scanned, ${skipped} unreadable`)
    });
  } catch (e) {
    err(`Error: scan failed: ${e.message}`);
    return 1;
  }
  err(`Scan done: ${result.totalFiles} files, ${fmtSize(result.totalSize)} on disk, ${result.skippedDirs} unreadable, ${result.excludedCount} excluded`);
  let summary = null;
  try {
    for (const out of opts.exports) {
      const ext = path.extname(out).toLowerCase();
      let text;
      if (ext === '.csv') text = toCsv(result.allFiles);
      else {
        summary = summary || buildSummary(folder, result, opts);
        text = ext === '.json' ? JSON.stringify(summary, null, 2) + '\n' : toHtml(summary);
      }
      fs.writeFileSync(path.resolve(out), text);
      err(`Wrote ${path.resolve(out)}`);
    }
  } catch (e) {
    err(`Error: export failed: ${e.message}`);
    return 1;
  }
  return 0;
}

module.exports = { parseCliArgs, runCli, UsageError, USAGE };
