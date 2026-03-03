(function () {
  'use strict';

  // === Constants ===
  const MAX_TREEMAP = 200;
  const MAX_PIE = 20;
  const GAP = 2;

  const EXT_COLORS = {
    image: '#34d399',
    video: '#f87171',
    audio: '#fbbf24',
    document: '#60a5fa',
    code: '#a78bfa',
    archive: '#c084fc',
    data: '#22d3ee',
    executable: '#fb7185',
    default: '#64748b'
  };

  const EXT_MAP = {
    image: ['jpg','jpeg','png','gif','svg','bmp','webp','ico','tiff','tif','heic','avif','raw'],
    video: ['mp4','mov','avi','mkv','wmv','flv','webm','m4v','mpg','mpeg','3gp'],
    audio: ['mp3','wav','flac','aac','ogg','wma','m4a','opus','aiff'],
    document: ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','rtf','odt','ods','odp','pages','numbers','key','epub'],
    code: ['js','ts','jsx','tsx','py','rb','go','rs','java','c','cpp','h','hpp','cs','css','html','htm','json','xml','yaml','yml','sh','bash','zsh','php','swift','kt','scala','lua','r','sql','md','toml','ini','cfg','conf','vue','svelte','astro','zig','asm','wasm'],
    archive: ['zip','tar','gz','bz2','7z','rar','xz','dmg','iso','tgz','zst','lz4'],
    data: ['csv','tsv','parquet','arrow','sqlite','db','mdb','sav'],
    executable: ['exe','app','msi','deb','rpm','appimage','bin','dll','so','dylib']
  };

  // === State ===
  let allFiles = [];
  let displayFiles = [];
  let selectedFile = null;
  let viewMode = 'rings';
  let lastChartMode = 'rings';
  let totalFiles = 0;
  let totalSize = 0;
  let skippedDirs = 0;
  let cloudOnlyCount = 0;
  let cloudFilter = 'all'; // 'all' | 'local' | 'online'
  let totalLogicalSize = 0;
  let totalCloudLogicalSize = 0;
  let ringsAnimDir = null; // 'in' | 'out' | null
  let duplicateResults = null; // null = not scanned, [] = scanned
  let dupFilterTiers = new Set(['gold', 'silver', 'bronze']); // which tiers to show
  let dupSortBy = 'size'; // 'tier', 'files', 'size', 'wasted'
  let dupSortAsc = false; // descending by default
  let dupFolderFilter = null; // folder path prefix to filter duplicate groups
  let colorMode = 'age';
  let folderTree = null;       // hierarchical tree from scan
  let bubblePath = [];         // current drill-down path segments
  let bubbleCurrentNode = null; // current tree node being displayed

  // === DOM ===
  let viz, detailPanel, detailName, detailPath, detailSize;
  let actionOpen, actionPreview, actionShow;
  let tooltip, loading, loadingText, statsEl;
  let btnSelectFolder, btnTreemap, btnPie, btnBubblemap, btnRings, btnDuplicates, folderPathEl;
  let btnColorAge, btnColorType, btnColorFolder;
  let btnTable, btnHistogram, btnTimeline;
  let collectorItems = []; // files staged for deletion
  let fileTags = {}; // relativePath → [tag strings]
  let tagSaveTimer = null;
  const TAG_DEFS = { keep: '#4ade80', reviewed: '#60a5fa', 'delete': '#f87171' };
  let diskSpaceInfo = null;
  let scanAnimating = false;
  let scanTopFiles = []; // top 200 files by size during animated scan
  let lastAnimRenderTime = 0;
  let selectedFiles = []; // multi-select support
  let folderSortMode = 'size'; // 'size' or 'name'
  let recentFolders = []; // last 10 scanned folders
  let tableSortCol = 'size';
  let pieOffset = 0;
  let selectedFolderPath = null; // null = show all, string = folder prefix filter
  let tableSortAsc = false;
  let filterTypes = null; // null = all types, Set = selected types
  let filterMinSize = 0;
  let filterBarOpen = false;
  let bubbleBreadcrumb, breadcrumbTrail;
  let folderPanel, folderTreeEl;

  // === Utilities ===

  function effectiveSize(file) {
    if (cloudFilter === 'online') return file.logicalSize || file.size;
    if (cloudFilter === 'local') return file.size;
    // 'all': use logicalSize if available (covers both local diskSize and cloud file sizes)
    return Math.max(file.size, file.logicalSize || 0);
  }

  function effectiveNodeSize(node) {
    if (cloudFilter === 'online') return node.logicalSize || node.size;
    if (cloudFilter === 'local') return node.size;
    // 'all': logicalSize includes both local and cloud files' true sizes
    return node.logicalSize || node.size;
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function formatRelativeDate(mtimeMs) {
    if (!mtimeMs) return '';
    const now = Date.now();
    const diffMs = now - mtimeMs;
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return '1 day';
    if (days < 7) return days + ' days';
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return weeks === 1 ? '1 week' : weeks + ' weeks';
    const months = Math.floor(days / 30);
    if (months < 12) return months === 1 ? '1 month' : months + ' months';
    const years = Math.floor(days / 365);
    return years === 1 ? '1 year' : years + ' years';
  }

  // macOS package/bundle extensions — used for display names
  const PACKAGE_EXTS = ['.app','.utm','.photoslibrary','.xcarchive','.xcodeproj',
    '.xcworkspace','.bundle','.framework','.pkg','.lproj','.dSYM','.vmwarevm',
    '.sparsebundle','.backupdb','.fcpbundle','.theater','.band','.emlx',
    '.rtfd','.nib','.playground','.localized','.download'];

  function getDisplayName(file) {
    const parts = file.relativePath.replace(/\\/g, '/').split('/');
    // Find the deepest (last) macOS package in the path — that's the meaningful name
    for (let i = parts.length - 1; i >= 0; i--) {
      const lower = parts[i].toLowerCase();
      if (PACKAGE_EXTS.some(ext => lower.endsWith(ext))) {
        return parts[i];
      }
    }
    return file.name;
  }

  function getDisplayContext(file) {
    const parts = file.relativePath.replace(/\\/g, '/').split('/');
    // Context = parent of the deepest package, or parent of the file
    for (let i = parts.length - 1; i >= 0; i--) {
      const lower = parts[i].toLowerCase();
      if (PACKAGE_EXTS.some(ext => lower.endsWith(ext))) {
        return i > 0 ? parts[i - 1] : '';
      }
    }
    return parts.length > 1 ? parts[parts.length - 2] : '';
  }

  function getTopFolder(file) {
    const parts = file.relativePath.replace(/\\/g, '/').split('/');
    return parts.length > 1 ? parts[0] : '(root)';
  }

  function getFileCategory(ext) {
    const e = (ext || '').replace('.', '').toLowerCase();
    for (const [cat, exts] of Object.entries(EXT_MAP)) {
      if (exts.includes(e)) return cat;
    }
    return e ? e : 'other';
  }

  // --- Color by type (improved: unknown exts get unique hashed colors) ---

  function getFileColor(ext) {
    const e = (ext || '').replace('.', '').toLowerCase();
    for (const [cat, exts] of Object.entries(EXT_MAP)) {
      if (exts.includes(e)) return EXT_COLORS[cat];
    }
    if (!e) return EXT_COLORS.default;
    // Hash the extension to a unique hue so unknowns aren't all grey
    let hash = 0;
    for (let i = 0; i < e.length; i++) hash = e.charCodeAt(i) + ((hash << 5) - hash);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 40%, 42%)`;
  }

  // --- Color by folder ---

  const FOLDER_PALETTE = [
    '#f87171','#34d399','#60a5fa','#fbbf24','#a78bfa',
    '#22d3ee','#f472b6','#a3e635','#fb923c','#2dd4bf',
    '#c084fc','#e879f9','#38bdf8','#facc15','#4ade80',
    '#f97316','#818cf8','#fb7185','#a8a29e','#67e8f9'
  ];

  let folderColorMap = null;

  function buildFolderColorMap(files) {
    const folders = [...new Set(files.map(getTopFolder))];
    const map = new Map();
    folders.forEach((f, i) => map.set(f, FOLDER_PALETTE[i % FOLDER_PALETTE.length]));
    return map;
  }

  function getColorByFolder(file) {
    if (!folderColorMap) folderColorMap = buildFolderColorMap(displayFiles);
    return folderColorMap.get(getTopFolder(file)) || '#64748b';
  }

  // --- Color by age ---

  let ageRange = null;

  function buildAgeRange(files) {
    let min = Infinity, max = -Infinity;
    for (const f of files) {
      if (f.mtime != null) {
        if (f.mtime < min) min = f.mtime;
        if (f.mtime > max) max = f.mtime;
      }
    }
    // Fallback if no valid mtime found (empty array or no mtime)
    if (min === Infinity || max === -Infinity) {
      return { min: 0, max: 1 };
    }
    return { min, max };
  }

  function getColorByAge(file) {
    if (!ageRange) ageRange = buildAgeRange(displayFiles);
    if (!file.mtime || ageRange.max === ageRange.min) return '#64748b';
    const t = (file.mtime - ageRange.min) / (ageRange.max - ageRange.min);
    // Old = cool blue, recent = warm orange/red
    const hue = (1 - t) * 220 + t * 10; // 220 (blue) → 10 (red)
    const sat = 50 + t * 20;
    const lig = 35 + t * 15;
    return `hsl(${hue}, ${sat}%, ${lig}%)`;
  }

  // --- Dispatch ---

  function getBlockColor(file) {
    if (colorMode === 'folder') return getColorByFolder(file);
    if (colorMode === 'age') return getColorByAge(file);
    return getFileColor(file.ext);
  }

  function getShowLabel() {
    if (window.api.platform === 'darwin') return 'Show in Finder';
    if (window.api.platform === 'win32') return 'Show in Explorer';
    return 'Show in Files';
  }

  function getPreviewLabel() {
    return window.api.platform === 'darwin' ? 'Quick Look' : 'Preview';
  }

  // === Export ===

  function exportCSV() {

    if (!displayFiles.length) return;
    const escape = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const rows = ['Name,Path,Size (bytes),Size,Extension,Type,Modified'];
    for (const f of displayFiles) {
      const cat = getFileCategory(f.ext);
      const date = f.mtime ? new Date(f.mtime).toISOString() : '';
      rows.push([
        escape(f.name),
        escape(f.relativePath),
        f.size,
        escape(formatSize(f.size)),
        escape((f.ext || '').replace('.', '')),
        escape(cat.charAt(0).toUpperCase() + cat.slice(1)),
        escape(date)
      ].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stuffdiver-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // === Filters ===

  const SIZE_THRESHOLDS = [
    { label: 'All sizes', value: 0 },
    { label: '> 1 MB', value: 1048576 },
    { label: '> 10 MB', value: 10485760 },
    { label: '> 100 MB', value: 104857600 },
    { label: '> 500 MB', value: 524288000 },
    { label: '> 1 GB', value: 1073741824 }
  ];

  function applyFilters() {
    displayFiles = allFiles.filter(f => {
      if (cloudFilter === 'local' && f.cloudStatus === 'icloud-only') return false;
      if (cloudFilter === 'online' && f.cloudStatus !== 'icloud-only') return false;
      if (selectedFolderPath && !f.relativePath.startsWith(selectedFolderPath + '/') && f.relativePath !== selectedFolderPath) return false;
      if (filterMinSize > 0 && effectiveSize(f) < filterMinSize) return false;
      if (filterTypes) {
        const cat = getFileCategory(f.ext);
        if (!filterTypes.has(cat)) return false;
      }
      return true;
    });
    folderColorMap = null;
    ageRange = null;
    pieOffset = 0;
    updateStats();
    renderFolderTree();
    renderVisualization();
  }

  function selectFolder(folderPath) {
    selectedFolderPath = folderPath;
    selectedFile = null;
    selectedFiles = [];
    detailPanel.classList.remove('visible');
    // Also navigate bubble/rings into this folder
    if (folderPath) {
      const segments = folderPath.split('/');
      ringsAnimDir = segments.length > bubblePath.length ? 'in' : segments.length < bubblePath.length ? 'out' : null;
      bubblePath = segments;
      let node = folderTree;
      for (const seg of segments) {
        if (node.children && node.children[seg]) node = node.children[seg];
      }
      bubbleCurrentNode = node;
    } else {
      ringsAnimDir = bubblePath.length > 0 ? 'out' : null;
      bubblePath = [];
      bubbleCurrentNode = folderTree;
    }
    highlightFolderTree();
    applyFilters();
  }

  function buildFilterBar() {
    // Redirect to advanced search
    buildAdvancedSearch();
  }

  // === Squarified Treemap ===

  function worstRatio(row, side) {
    const area = row.reduce((s, r) => s + r.area, 0);
    const w = area / side;
    let worst = 0;
    for (const item of row) {
      const h = item.area / w;
      const r = Math.max(w / h, h / w);
      if (r > worst) worst = r;
    }
    return worst;
  }

  function computeTreemap(items, rect) {
    if (!items.length) return [];
    const total = items.reduce((s, i) => s + i.size, 0);
    if (total === 0) return [];

    const area = rect.w * rect.h;
    const withArea = items.map(i => ({ ...i, area: (i.size / total) * area }));

    const result = [];
    let remaining = withArea;
    let cr = { ...rect };

    while (remaining.length > 0) {
      if (cr.w <= 0.5 || cr.h <= 0.5) break;

      const side = Math.min(cr.w, cr.h);
      let row = [remaining[0]];
      remaining = remaining.slice(1);

      while (remaining.length > 0) {
        const candidate = [...row, remaining[0]];
        if (worstRatio(candidate, side) <= worstRatio(row, side)) {
          row = candidate;
          remaining = remaining.slice(1);
        } else {
          break;
        }
      }

      const rowArea = row.reduce((s, i) => s + i.area, 0);
      const horiz = cr.w >= cr.h;
      const thickness = rowArea / side;
      let offset = 0;

      for (const item of row) {
        const len = item.area / thickness;
        if (horiz) {
          result.push({ ...item, x: cr.x, y: cr.y + offset, w: thickness, h: len });
        } else {
          result.push({ ...item, x: cr.x + offset, y: cr.y, w: len, h: thickness });
        }
        offset += len;
      }

      if (horiz) {
        cr = { x: cr.x + thickness, y: cr.y, w: cr.w - thickness, h: cr.h };
      } else {
        cr = { x: cr.x, y: cr.y + thickness, w: cr.w, h: cr.h - thickness };
      }
    }

    return result;
  }

  // === Rendering: Treemap ===

  function renderTreemap() {
    viz.innerHTML = '';
    const files = displayFiles.slice(0, MAX_TREEMAP).filter(f => effectiveSize(f) > 0);
    if (!files.length) { renderEmpty('No files found'); return; }

    const rect = { x: 0, y: 0, w: viz.clientWidth, h: viz.clientHeight };
    if (rect.w < 10 || rect.h < 10) return;

    // Build items array, optionally including free space
    let items = files.map(f => ({ ...f, size: effectiveSize(f) }));
    let freeSpaceSize = 0;
    if (diskSpaceInfo && diskSpaceInfo.available > 0 && !selectedFolderPath) {
      const filesTotal = items.reduce((s, f) => s + f.size, 0);
      freeSpaceSize = diskSpaceInfo.available;
      // Cap so file blocks remain visible
      if (freeSpaceSize > filesTotal * 10) freeSpaceSize = filesTotal * 10;
      items.push({ name: 'Free Space', size: freeSpaceSize, _isFreeSpace: true, path: '', ext: '', mtime: 0 });
    }

    const blocks = computeTreemap(items, rect);

    for (const b of blocks) {
      const el = document.createElement('div');
      const bw = b.w - GAP;
      const bh = b.h - GAP;

      if (b._isFreeSpace) {
        el.className = 'treemap-block free-space-block';
        el.style.left = (b.x + GAP / 2) + 'px';
        el.style.top = (b.y + GAP / 2) + 'px';
        el.style.width = Math.max(0, bw) + 'px';
        el.style.height = Math.max(0, bh) + 'px';
        if (bw > 55 && bh > 28) {
          const nameEl = document.createElement('div');
          nameEl.className = 'filename';
          const label = freeSpaceSize < diskSpaceInfo.available ? 'Free Space (capped)' : 'Free Space';
          nameEl.textContent = label;
          el.appendChild(nameEl);
        }
        if (bw > 55 && bh > 42) {
          const sizeEl = document.createElement('div');
          sizeEl.className = 'filesize';
          sizeEl.textContent = formatSize(diskSpaceInfo.available);
          el.appendChild(sizeEl);
        }
        viz.appendChild(el);
        continue;
      }

      el.className = 'treemap-block' + (isFileSelected(b) ? ' selected' : '');
      el.dataset.filePath = b.path;
      el.style.left = (b.x + GAP / 2) + 'px';
      el.style.top = (b.y + GAP / 2) + 'px';
      el.style.width = Math.max(0, bw) + 'px';
      el.style.height = Math.max(0, bh) + 'px';
      el.style.backgroundColor = getBlockColor(b);

      const displayName = getDisplayName(b);
      const context = getDisplayContext(b);
      if (bw > 55 && bh > 55 && context) {
        const ctxEl = document.createElement('div');
        ctxEl.className = 'file-context';
        ctxEl.textContent = context;
        el.appendChild(ctxEl);
      }
      if (bw > 55 && bh > 28) {
        const nameEl = document.createElement('div');
        nameEl.className = 'filename';
        nameEl.textContent = displayName;
        el.appendChild(nameEl);
      }
      if (bw > 55 && bh > 42) {
        const sizeEl = document.createElement('div');
        sizeEl.className = 'filesize';
        sizeEl.textContent = formatSize(b.size);
        el.appendChild(sizeEl);
      }

      el.addEventListener('click', (ev) => selectFile(b, ev));
      el.addEventListener('dblclick', () => window.api.openFile(b.path));
      el.addEventListener('mouseenter', (e) => showTooltip(e, b));
      el.addEventListener('mousemove', moveTooltip);
      el.addEventListener('mouseleave', hideTooltip);

      const tagDots = renderTagDots(b);
      if (tagDots) el.appendChild(tagDots);

      viz.appendChild(el);
    }
  }

  // === Rendering: Pie Chart ===

  function renderPieChart() {
    viz.innerHTML = '';
    const files = displayFiles.filter(f => effectiveSize(f) > 0).map(f => ({ ...f, size: effectiveSize(f) }));
    if (!files.length) { renderEmpty('No files found'); return; }

    const container = document.createElement('div');
    container.className = 'pie-container';

    const svgWrap = document.createElement('div');
    svgWrap.className = 'pie-svg-wrap';

    const legend = document.createElement('div');
    legend.className = 'pie-legend';

    const w = Math.floor(viz.clientWidth * 0.55);
    const h = viz.clientHeight;
    const radius = Math.min(w, h) * 0.45;
    const cx = w / 2;
    const cy = h / 2;

    const start = pieOffset;
    const end = pieOffset + MAX_PIE;
    const topFiles = files.slice(start, end);
    const otherSize = files.slice(end).reduce((s, f) => s + f.size, 0);
    const prevSize = files.slice(0, start).reduce((s, f) => s + f.size, 0);
    const items = [...topFiles];
    if (otherSize > 0) {
      const remaining = files.length - end;
      items.push({ name: `Other (${remaining} files)`, size: otherSize, ext: '', path: '', relativePath: '', _isOther: true });
    }
    if (prevSize > 0) {
      items.unshift({ name: `Back (${start} files)`, size: prevSize, ext: '', path: '', relativePath: '', _isBack: true });
    }
    const pieTotal = items.reduce((s, i) => s + i.size, 0);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    let startAngle = -Math.PI / 2;

    items.forEach((file, i) => {
      const sliceAngle = (file.size / pieTotal) * Math.PI * 2;
      const endAngle = startAngle + sliceAngle;
      const isOther = file._isOther;
      const isBack = file._isBack;
      const isSpecial = isOther || isBack;
      const color = isOther ? '#8d6e99' : isBack ? '#6e8d99' : getBlockColor(file);

      // Arc path
      const x1 = cx + radius * Math.cos(startAngle);
      const y1 = cy + radius * Math.sin(startAngle);
      const x2 = cx + radius * Math.cos(endAngle);
      const y2 = cy + radius * Math.sin(endAngle);
      const large = sliceAngle > Math.PI ? 1 : 0;

      let d;
      if (items.length === 1) {
        // Full circle
        d = `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.001} ${cy - radius} Z`;
      } else {
        d = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
      }

      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', color);
      path.setAttribute('stroke', getComputedStyle(document.body).getPropertyValue('--chart-stroke').trim() || '#080c14');
      path.setAttribute('stroke-width', '2');
      path.classList.add('pie-slice');

      path.addEventListener('click', () => {
        if (isOther) { pieOffset += MAX_PIE; renderPieChart(); }
        else if (isBack) { pieOffset = Math.max(0, pieOffset - MAX_PIE); renderPieChart(); }
        else if (file.path) selectFile(file);
      });
      path.addEventListener('mouseenter', (e) => { if (!isSpecial) showTooltip(e, file); });
      path.addEventListener('mousemove', moveTooltip);
      path.addEventListener('mouseleave', hideTooltip);

      svg.appendChild(path);
      startAngle = endAngle;

      // Legend item
      const item = document.createElement('div');
      item.className = 'pie-legend-item' + (selectedFile && selectedFile.path === file.path ? ' selected' : '');

      const swatch = document.createElement('div');
      swatch.className = 'pie-legend-swatch';
      swatch.style.backgroundColor = color;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'pie-legend-name';
      nameSpan.textContent = file.name;

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'pie-legend-size';
      sizeSpan.textContent = formatSize(file.size);

      item.appendChild(swatch);
      item.appendChild(nameSpan);
      item.appendChild(sizeSpan);
      if (isOther) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => { pieOffset += MAX_PIE; renderPieChart(); });
      } else if (isBack) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => { pieOffset = Math.max(0, pieOffset - MAX_PIE); renderPieChart(); });
      } else if (file.path) {
        item.addEventListener('click', () => selectFile(file));
      }
      legend.appendChild(item);
    });

    svgWrap.appendChild(svg);
    container.appendChild(svgWrap);
    container.appendChild(legend);
    viz.appendChild(container);
  }

  // === Rendering: Table ===

  const TABLE_COLUMNS = [
    { key: 'name', label: 'Name' },
    { key: 'type', label: 'Type' },
    { key: 'size', label: 'Size' },
    { key: 'mtime', label: 'Modified' },
    { key: 'path', label: 'Path' }
  ];

  function sortTableFiles(files) {
    const sorted = [...files];
    sorted.sort((a, b) => {
      let va, vb;
      switch (tableSortCol) {
        case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case 'type': va = getFileCategory(a.ext); vb = getFileCategory(b.ext); break;
        case 'size': va = effectiveSize(a); vb = effectiveSize(b); break;
        case 'mtime': va = a.mtime || 0; vb = b.mtime || 0; break;
        case 'path': va = a.relativePath.toLowerCase(); vb = b.relativePath.toLowerCase(); break;
        default: va = a.size; vb = b.size;
      }
      if (va < vb) return tableSortAsc ? -1 : 1;
      if (va > vb) return tableSortAsc ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  function renderTable() {
    viz.innerHTML = '';
    const files = displayFiles.filter(f => effectiveSize(f) > 0 || f.cloudStatus === 'icloud-only');
    if (!files.length) { renderEmpty('No files found'); return; }

    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';

    const table = document.createElement('table');
    table.className = 'file-table';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    TABLE_COLUMNS.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.dataset.col = col.key;
      if (tableSortCol === col.key) {
        th.classList.add('sorted');
        th.classList.add(tableSortAsc ? 'asc' : 'desc');
      }
      th.addEventListener('click', () => {
        if (tableSortCol === col.key) {
          tableSortAsc = !tableSortAsc;
        } else {
          tableSortCol = col.key;
          tableSortAsc = col.key === 'name' || col.key === 'type' || col.key === 'path';
        }
        renderTable();
      });
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    const sorted = sortTableFiles(files);

    sorted.forEach(file => {
      const tr = document.createElement('tr');
      tr.style.borderLeft = `3px solid ${getBlockColor(file)}`;
      tr.dataset.filePath = file.path;
      if (isFileSelected(file)) {
        tr.classList.add('selected');
      }
      tr.addEventListener('click', (ev) => selectFile(file, ev));

      const tdName = document.createElement('td');
      tdName.className = 'td-name';
      const tags = getFileTags(file);
      if (tags.length) {
        for (const t of tags) {
          const dot = document.createElement('span');
          dot.className = 'tag-dot-inline';
          dot.style.backgroundColor = TAG_DEFS[t] || '#888';
          dot.title = t.charAt(0).toUpperCase() + t.slice(1);
          tdName.appendChild(dot);
        }
      }
      if (file.cloudStatus === 'icloud-only') {
        const cloudIcon = document.createElement('span');
        cloudIcon.className = 'cloud-icon';
        cloudIcon.title = 'iCloud only — not on your local drive';
        cloudIcon.textContent = '☁';
        tdName.appendChild(cloudIcon);
      }
      tdName.appendChild(document.createTextNode(file.name));

      const tdType = document.createElement('td');
      tdType.className = 'td-type';
      const cat = getFileCategory(file.ext);
      tdType.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);

      const tdSize = document.createElement('td');
      tdSize.className = 'td-size';
      tdSize.textContent = file.cloudStatus === 'icloud-only'
        ? (file.logicalSize ? '☁ ' + formatSize(file.logicalSize) : '☁ iCloud')
        : formatSize(file.size);

      const tdMtime = document.createElement('td');
      tdMtime.className = 'td-mtime';
      tdMtime.textContent = formatRelativeDate(file.mtime);

      const tdPath = document.createElement('td');
      tdPath.className = 'td-path';
      tdPath.textContent = file.relativePath;
      tdPath.title = file.relativePath;

      tr.appendChild(tdName);
      tr.appendChild(tdType);
      tr.appendChild(tdSize);
      tr.appendChild(tdMtime);
      tr.appendChild(tdPath);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    viz.appendChild(wrap);
  }

  // === Rendering: Duplicates ===

  const TIER_LABELS = { gold: 'Exact', silver: 'Likely', bronze: 'Possible' };

  function renderDuplicates() {
    viz.innerHTML = '';
    detailPanel.classList.remove('visible');

    if (!displayFiles.length) {
      renderEmpty('Select a folder first');
      return;
    }

    if (duplicateResults === null) {
      // Not yet scanned — show prompt
      const prompt = document.createElement('div');
      prompt.className = 'dup-scan-prompt';
      prompt.innerHTML = `
        <p>Scan all ${totalFiles.toLocaleString()} files for duplicates</p>
        <p style="font-size:12px;color:var(--text-tertiary)">Compares file content using SHA-256 hashing</p>
      `;
      const btn = document.createElement('button');
      btn.className = 'dup-scan-btn';
      btn.textContent = 'Find Duplicates';
      btn.addEventListener('click', handleFindDuplicates);
      prompt.appendChild(btn);
      viz.appendChild(prompt);
      return;
    }

    if (duplicateResults.length === 0) {
      renderEmpty('No duplicates found');
      return;
    }

    const container = document.createElement('div');
    container.className = 'dup-container';

    // Filter results by selected tiers and folder
    const filteredResults = duplicateResults.filter(g => {
      if (!dupFilterTiers.has(g.tier)) return false;
      if (dupFolderFilter) {
        return g.files.some(f => f.relativePath.startsWith(dupFolderFilter + '/') || f.relativePath.startsWith(dupFolderFilter + '\\'));
      }
      return true;
    });

    // Summary with clickable tier filter buttons
    const allGoldCount = duplicateResults.filter(g => g.tier === 'gold').length;
    const allSilverCount = duplicateResults.filter(g => g.tier === 'silver').length;
    const allBronzeCount = duplicateResults.filter(g => g.tier === 'bronze').length;
    const totalWasted = filteredResults.reduce((s, g) => s + g.wasted, 0);
    const totalDupFiles = filteredResults.reduce((s, g) => s + g.files.length, 0);

    const summary = document.createElement('div');
    summary.className = 'dup-summary';

    const statsSpan = document.createElement('span');
    statsSpan.innerHTML = `Groups: <span class="stat-value">${filteredResults.length}</span>`;
    summary.appendChild(statsSpan);

    const filesSpan = document.createElement('span');
    filesSpan.innerHTML = `Files: <span class="stat-value">${totalDupFiles}</span>`;
    summary.appendChild(filesSpan);

    const wastedSpan = document.createElement('span');
    wastedSpan.innerHTML = `Wasted: <span class="stat-value" style="color:#f44336">${formatSize(totalWasted)}</span>`;
    summary.appendChild(wastedSpan);

    // Tier filter buttons
    function makeTierBtn(tier, label, count) {
      if (count === 0) return;
      const btn = document.createElement('button');
      btn.className = `dup-tier-filter ${tier}${dupFilterTiers.has(tier) ? ' active' : ''}`;
      btn.innerHTML = `<span class="dup-tier ${tier}" style="display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span> ${label}: ${count}`;
      btn.addEventListener('click', () => {
        if (dupFilterTiers.has(tier)) {
          if (dupFilterTiers.size > 1) dupFilterTiers.delete(tier);
        } else {
          dupFilterTiers.add(tier);
        }
        renderDuplicates();
      });
      summary.appendChild(btn);
    }
    makeTierBtn('gold', 'Exact', allGoldCount);
    makeTierBtn('silver', 'Likely', allSilverCount);
    makeTierBtn('bronze', 'Possible', allBronzeCount);

    container.appendChild(summary);

    // Sort controls
    const sortBar = document.createElement('div');
    sortBar.className = 'dup-sort-bar';
    const sortLabel = document.createElement('span');
    sortLabel.className = 'dup-sort-label';
    sortLabel.textContent = 'Sort by:';
    sortBar.appendChild(sortLabel);

    const sortOptions = [
      { key: 'tier', label: 'Tier' },
      { key: 'files', label: 'Files' },
      { key: 'size', label: 'Size' },
      { key: 'wasted', label: 'Wasted' },
    ];
    for (const opt of sortOptions) {
      const btn = document.createElement('button');
      btn.className = `dup-sort-btn${dupSortBy === opt.key ? ' active' : ''}`;
      const arrow = dupSortBy === opt.key ? (dupSortAsc ? ' ▲' : ' ▼') : '';
      btn.textContent = opt.label + arrow;
      btn.addEventListener('click', () => {
        if (dupSortBy === opt.key) {
          dupSortAsc = !dupSortAsc;
        } else {
          dupSortBy = opt.key;
          dupSortAsc = false;
        }
        renderDuplicates();
      });
      sortBar.appendChild(btn);
    }
    container.appendChild(sortBar);

    // Apply sorting
    const tierOrder = { gold: 0, silver: 1, bronze: 2 };
    const sortedResults = [...filteredResults].sort((a, b) => {
      let cmp = 0;
      if (dupSortBy === 'tier') cmp = tierOrder[a.tier] - tierOrder[b.tier];
      else if (dupSortBy === 'files') cmp = a.files.length - b.files.length;
      else if (dupSortBy === 'size') cmp = a.size - b.size;
      else if (dupSortBy === 'wasted') cmp = a.wasted - b.wasted;
      // For tier, ascending = Exact first (natural order); for others, descending = largest first
      if (dupSortBy === 'tier') return dupSortAsc ? -cmp : cmp;
      return dupSortAsc ? cmp : -cmp;
    });

    const showLabel = getShowLabel();
    const previewLabel = getPreviewLabel();

    for (const group of sortedResults) {
      const groupEl = document.createElement('div');
      groupEl.className = 'dup-group';

      const header = document.createElement('div');
      header.className = 'dup-group-header';

      const tier = document.createElement('div');
      tier.className = `dup-tier ${group.tier}`;

      const tierLabel = document.createElement('span');
      tierLabel.className = `dup-tier-label ${group.tier}`;
      tierLabel.textContent = TIER_LABELS[group.tier];

      const name = document.createElement('span');
      name.className = 'dup-group-name';
      // Use first file's name as group name
      name.textContent = group.files[0].name;

      const meta = document.createElement('span');
      meta.className = 'dup-group-meta';
      meta.innerHTML = `
        <span>${group.files.length} files</span>
        <span>${formatSize(group.size)}</span>
        ${group.wasted > 0 ? `<span class="wasted">${formatSize(group.wasted)} wasted</span>` : ''}
      `;

      const chevron = document.createElement('span');
      chevron.className = 'dup-group-chevron';
      chevron.textContent = '\u25B6';

      header.appendChild(tier);
      header.appendChild(tierLabel);
      header.appendChild(name);
      header.appendChild(meta);
      header.appendChild(chevron);

      header.addEventListener('click', () => {
        groupEl.classList.toggle('expanded');
      });

      // File list
      const fileList = document.createElement('div');
      fileList.className = 'dup-file-list';

      for (const file of group.files) {
        const row = document.createElement('div');
        row.className = 'dup-file-row';

        const pathSpan = document.createElement('span');
        pathSpan.className = 'dup-file-path';
        pathSpan.textContent = file.relativePath;
        pathSpan.title = file.path;

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'dup-file-size';
        sizeSpan.textContent = formatSize(file.size);

        const actions = document.createElement('div');
        actions.className = 'dup-file-actions';

        const btnOpen = document.createElement('button');
        btnOpen.textContent = 'Open';
        btnOpen.addEventListener('click', (e) => { e.stopPropagation(); window.api.openFile(file.path); });

        const btnPreview = document.createElement('button');
        btnPreview.textContent = previewLabel;
        btnPreview.addEventListener('click', (e) => { e.stopPropagation(); window.api.previewFile(file.path); });

        const btnShow = document.createElement('button');
        btnShow.textContent = showLabel;
        btnShow.addEventListener('click', (e) => { e.stopPropagation(); window.api.showInFolder(file.path); });

        actions.appendChild(btnOpen);
        actions.appendChild(btnPreview);
        actions.appendChild(btnShow);

        row.appendChild(pathSpan);
        row.appendChild(sizeSpan);
        row.appendChild(actions);
        fileList.appendChild(row);
      }

      groupEl.appendChild(header);
      groupEl.appendChild(fileList);
      container.appendChild(groupEl);
    }

    viz.appendChild(container);
  }

  async function handleFindDuplicates() {
    loading.classList.remove('hidden');
    loadingText.textContent = 'Hunting for duplicates...';

    try {
      dupFolderFilter = null;
      duplicateResults = await window.api.findDuplicates();
      renderDupFolderTree();
      renderDuplicates();
    } catch (err) {
      renderEmpty('Error finding duplicates');
    } finally {
      loading.classList.add('hidden');
    }
  }

  // === Rendering: Bubble Map ===

  const MAX_BUBBLES = 150;

  function packCircles(items, width, height) {
    if (!items.length) return [];
    const centerX = width / 2;
    const centerY = height / 2;
    const GAP_B = 3;

    // Radii proportional to sqrt(size) so area ~ size
    const totalSize = items.reduce((s, i) => s + i.size, 0);
    const targetArea = 0.70 * width * height;
    const scale = Math.sqrt(targetArea / (Math.PI * totalSize));

    const circles = items.map(item => ({
      ...item,
      r: Math.max(4, Math.sqrt(item.size) * scale),
      cx: 0, cy: 0
    }));

    if (circles.length === 1) {
      circles[0].cx = centerX;
      circles[0].cy = centerY;
      circles[0].r = Math.min(circles[0].r, Math.min(width, height) * 0.42);
      return circles;
    }

    // Place first at center
    circles[0].cx = centerX;
    circles[0].cy = centerY;

    // Place second to the right
    circles[1].cx = centerX + circles[0].r + circles[1].r + GAP_B;
    circles[1].cy = centerY;

    function overlaps(cx, cy, r, upTo) {
      for (let i = 0; i < upTo; i++) {
        const dx = cx - circles[i].cx;
        const dy = cy - circles[i].cy;
        const minD = r + circles[i].r + GAP_B;
        if (dx * dx + dy * dy < minD * minD) return true;
      }
      return false;
    }

    // Place remaining: try tangent to each placed circle, pick closest to center
    for (let i = 2; i < circles.length; i++) {
      const r = circles[i].r;
      let bestCx = centerX, bestCy = centerY + 9999, bestDist = Infinity;

      for (let j = 0; j < i; j++) {
        const dist = circles[j].r + r + GAP_B;
        for (let a = 0; a < 24; a++) {
          const angle = (a / 24) * Math.PI * 2;
          const cx = circles[j].cx + dist * Math.cos(angle);
          const cy = circles[j].cy + dist * Math.sin(angle);
          if (!overlaps(cx, cy, r, i)) {
            const d = Math.hypot(cx - centerX, cy - centerY);
            if (d < bestDist) { bestDist = d; bestCx = cx; bestCy = cy; }
          }
        }
      }
      circles[i].cx = bestCx;
      circles[i].cy = bestCy;
    }

    // Normalize: fit all circles within container
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of circles) {
      minX = Math.min(minX, c.cx - c.r);
      maxX = Math.max(maxX, c.cx + c.r);
      minY = Math.min(minY, c.cy - c.r);
      maxY = Math.max(maxY, c.cy + c.r);
    }
    const packW = maxX - minX;
    const packH = maxY - minY;
    const scaleFit = Math.min((width * 0.92) / packW, (height * 0.92) / packH, 1.0);
    const packCx = (minX + maxX) / 2;
    const packCy = (minY + maxY) / 2;
    for (const c of circles) {
      c.cx = centerX + (c.cx - packCx) * scaleFit;
      c.cy = centerY + (c.cy - packCy) * scaleFit;
      c.r *= scaleFit;
    }
    return circles;
  }

  function getBubbleColor(node) {
    if (!node.isFolder) return getBlockColor(node);
    if (colorMode === 'type') return getFileColor(node.dominantExt);
    if (colorMode === 'folder') {
      const topFolder = node.path ? node.path.split('/')[0] : node.name;
      if (!folderColorMap) folderColorMap = buildFolderColorMap(displayFiles);
      return folderColorMap.get(topFolder) || '#64748b';
    }
    if (colorMode === 'age') {
      if (!ageRange) ageRange = buildAgeRange(displayFiles);
      if (!node.mtime || ageRange.max === ageRange.min) return '#64748b';
      const t = Math.max(0, Math.min(1, (node.mtime - ageRange.min) / (ageRange.max - ageRange.min)));
      const hue = (1 - t) * 220 + t * 10;
      return `hsl(${hue}, ${50 + t * 20}%, ${35 + t * 15}%)`;
    }
    return '#64748b';
  }

  function navigateBubble(pathSegments) {
    const prevLen = bubblePath.length;
    ringsAnimDir = pathSegments.length > prevLen ? 'in' : pathSegments.length < prevLen ? 'out' : null;
    bubblePath = pathSegments;
    let node = folderTree;
    for (const seg of pathSegments) {
      if (node.children && node.children[seg]) {
        node = node.children[seg];
      }
    }
    bubbleCurrentNode = node;
    // Sync folder filter with bubble navigation
    selectedFolderPath = pathSegments.length ? pathSegments.join('/') : null;
    displayFiles = allFiles.filter(f => {
      if (cloudFilter === 'local' && f.cloudStatus === 'icloud-only') return false;
      if (cloudFilter === 'online' && f.cloudStatus !== 'icloud-only') return false;
      if (selectedFolderPath && !f.relativePath.startsWith(selectedFolderPath + '/') && f.relativePath !== selectedFolderPath) return false;
      if (filterMinSize > 0 && effectiveSize(f) < filterMinSize) return false;
      if (filterTypes) {
        const cat = getFileCategory(f.ext);
        if (!filterTypes.has(cat)) return false;
      }
      return true;
    });
    folderColorMap = null;
    ageRange = null;
    pieOffset = 0;
    updateBreadcrumb();
    highlightFolderTree();
    updateStats();
    if (viewMode === 'rings') renderRingsChart();
    else if (viewMode === 'bubblemap') renderBubbleMap();
    else renderVisualization();
  }

  function updateBreadcrumb() {
    if ((viewMode !== 'bubblemap' && viewMode !== 'rings') || bubblePath.length === 0) {
      bubbleBreadcrumb.classList.add('hidden');
      return;
    }
    bubbleBreadcrumb.classList.remove('hidden');
    breadcrumbTrail.innerHTML = '';

    const rootSpan = document.createElement('span');
    rootSpan.className = 'breadcrumb-segment';
    rootSpan.textContent = '\u2302 Root';
    rootSpan.addEventListener('click', () => navigateBubble([]));
    breadcrumbTrail.appendChild(rootSpan);

    for (let i = 0; i < bubblePath.length; i++) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-separator';
      sep.textContent = ' / ';
      breadcrumbTrail.appendChild(sep);

      const seg = document.createElement('span');
      seg.textContent = bubblePath[i];
      if (i < bubblePath.length - 1) {
        seg.className = 'breadcrumb-segment';
        const targetPath = bubblePath.slice(0, i + 1);
        seg.addEventListener('click', () => navigateBubble(targetPath));
      } else {
        seg.className = 'breadcrumb-current';
      }
      breadcrumbTrail.appendChild(seg);
    }
  }

  function showBubbleTooltip(e, item) {
    const sz = item.logicalSize != null ? effectiveNodeSize(item) : item.size;
    tooltip.innerHTML = `
      <strong>${item.name}/</strong><br>
      <span class="tip-path">${item.path || '(root)'}</span><br>
      <span class="tip-size">${formatSize(sz)}</span>
      <span class="tip-path"> \u00b7 ${item.fileCount} files</span><br>
      <span class="tip-path" style="font-size:10px">Click to explore</span>
    `;
    tooltip.style.display = 'block';
    moveTooltip(e);
  }

  function renderBubbleMap() {
    viz.innerHTML = '';

    if (!folderTree) {
      renderEmpty('Select a folder to dive into');
      return;
    }

    if (!bubbleCurrentNode) bubbleCurrentNode = folderTree;
    const node = bubbleCurrentNode;

    const w = viz.clientWidth;
    const h = viz.clientHeight;
    if (w < 10 || h < 10) return;

    // Build items: subfolders + direct files at this level
    const items = [];
    const children = node.children || {};

    for (const child of Object.values(children)) {
      if (effectiveNodeSize(child) <= 0) continue;
      items.push({
        size: effectiveNodeSize(child),
        name: child.name,
        path: child.path || child.name,
        isFolder: true,
        fileCount: child.fileCount,
        mtime: child.mtime,
        dominantExt: child.dominantExt,
        children: child.children
      });
    }

    // Also find direct files at this level from allFiles
    const nodePath = bubblePath.join('/');
    for (const file of allFiles) {
      const rel = file.relativePath.replace(/\\/g, '/');
      const parts = rel.split('/');
      // File is a direct child if its parent path matches current node
      const parentPath = parts.slice(0, -1).join('/');
      if (parentPath === nodePath) {
        items.push({ ...file, isFolder: false });
      }
    }

    items.sort((a, b) => b.size - a.size);
    const displayItems = items.slice(0, MAX_BUBBLES);

    if (!displayItems.length) {
      renderEmpty('Empty folder');
      return;
    }

    const packed = packCircles(displayItems, w, h);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    // Text shadow filter
    const defs = document.createElementNS(ns, 'defs');
    const filter = document.createElementNS(ns, 'filter');
    filter.setAttribute('id', 'txt-shadow');
    filter.setAttribute('x', '-20%');
    filter.setAttribute('y', '-20%');
    filter.setAttribute('width', '140%');
    filter.setAttribute('height', '140%');
    const shadow = document.createElementNS(ns, 'feDropShadow');
    shadow.setAttribute('dx', '0');
    shadow.setAttribute('dy', '1');
    shadow.setAttribute('stdDeviation', '1.5');
    shadow.setAttribute('flood-color', '#000');
    shadow.setAttribute('flood-opacity', '0.85');
    filter.appendChild(shadow);
    defs.appendChild(filter);
    svg.appendChild(defs);

    for (const circle of packed) {
      const g = document.createElementNS(ns, 'g');

      const circ = document.createElementNS(ns, 'circle');
      circ.setAttribute('cx', circle.cx);
      circ.setAttribute('cy', circle.cy);
      circ.setAttribute('r', Math.max(circle.r, 0));
      circ.setAttribute('fill', getBubbleColor(circle));
      circ.classList.add('bubble-circle');
      if (circle.isFolder) circ.classList.add('is-folder');
      if (selectedFile && !circle.isFolder && selectedFile.path === circle.path) {
        circ.classList.add('selected');
      }
      g.appendChild(circ);

      // Labels only when circle is large enough
      if (circle.r > 18) {
        const fontSize = Math.min(13, Math.max(9, circle.r / 4));
        const maxChars = Math.floor(circle.r * 2 / (fontSize * 0.6));
        const displayName = circle.name.length > maxChars
          ? circle.name.substring(0, maxChars - 1) + '\u2026'
          : circle.name;

        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', circle.cx);
        label.setAttribute('y', circle.cy - (circle.r > 30 ? 5 : 1));
        label.setAttribute('font-size', fontSize);
        label.setAttribute('filter', 'url(#txt-shadow)');
        label.classList.add('bubble-label');
        label.textContent = displayName;
        g.appendChild(label);

        if (circle.r > 30) {
          const sizeLabel = document.createElementNS(ns, 'text');
          sizeLabel.setAttribute('x', circle.cx);
          sizeLabel.setAttribute('y', circle.cy + fontSize * 0.8);
          sizeLabel.setAttribute('font-size', Math.max(8, fontSize - 2));
          sizeLabel.setAttribute('filter', 'url(#txt-shadow)');
          sizeLabel.classList.add('bubble-label-size');
          sizeLabel.textContent = formatSize(circle.size);
          g.appendChild(sizeLabel);
        }

        if (circle.isFolder && circle.r > 38) {
          const hint = document.createElementNS(ns, 'text');
          hint.setAttribute('x', circle.cx);
          hint.setAttribute('y', circle.cy + fontSize * 1.8);
          hint.setAttribute('font-size', Math.max(8, fontSize - 3));
          hint.setAttribute('filter', 'url(#txt-shadow)');
          hint.classList.add('bubble-label-hint');
          hint.textContent = circle.fileCount + ' files';
          g.appendChild(hint);
        }
      }

      // Events
      if (circle.isFolder) {
        circ.addEventListener('click', (e) => {
          e.stopPropagation();
          navigateBubble(circle.path.split('/'));
        });
        circ.addEventListener('mouseenter', (e) => showBubbleTooltip(e, circle));
      } else {
        circ.addEventListener('click', (e) => {
          e.stopPropagation();
          selectFile(circle);
        });
        circ.addEventListener('dblclick', () => window.api.openFile(circle.path));
        circ.addEventListener('mouseenter', (e) => showTooltip(e, circle));
      }
      circ.addEventListener('mousemove', moveTooltip);
      circ.addEventListener('mouseleave', hideTooltip);

      svg.appendChild(g);
    }

    // Click background to go up
    svg.addEventListener('click', (e) => {
      if (e.target === svg) {
        if (bubblePath.length > 0) {
          navigateBubble(bubblePath.slice(0, -1));
        } else {
          selectedFile = null;
          detailPanel.classList.remove('visible');
        }
      }
    });

    const container = document.createElement('div');
    container.className = 'bubble-container';
    container.appendChild(svg);
    viz.appendChild(container);

    updateBreadcrumb();
  }

  // === Rendering: Rings Chart (Sunburst) ===

  function renderRingsChart() {
    viz.innerHTML = '';

    if (!folderTree) {
      renderEmpty('Select a folder to dive into');
      return;
    }

    if (!bubbleCurrentNode) bubbleCurrentNode = folderTree;
    const rootNode = bubbleCurrentNode;

    const w = viz.clientWidth;
    const h = viz.clientHeight;
    if (w < 10 || h < 10) return;

    const cx = w / 2;
    const cy = h / 2;
    const maxRadius = Math.min(w, h) * 0.49;
    const MAX_DEPTH = 5;
    const MIN_ANGLE = 0.008; // ~0.46 degrees
    const RING_GAP = 1.5;

    const centerRadius = maxRadius * 0.16;
    const ringWidth = (maxRadius - centerRadius) / MAX_DEPTH;

    // Build arc data recursively
    const arcs = [];

    function buildArcs(node, depth, startAngle, endAngle) {
      if (depth > MAX_DEPTH) return;
      if (!node.children) return;

      const children = Object.values(node.children)
        .filter(c => effectiveNodeSize(c) > 0)
        .sort((a, b) => effectiveNodeSize(b) - effectiveNodeSize(a));

      if (!children.length) return;

      let currentAngle = startAngle;
      const nodeEff = effectiveNodeSize(node);

      for (const child of children) {
        const childSpan = (effectiveNodeSize(child) / nodeEff) * (endAngle - startAngle);
        if (childSpan < MIN_ANGLE) continue;

        const childStart = currentAngle;
        const childEnd = currentAngle + childSpan;
        const innerR = centerRadius + (depth - 1) * ringWidth + RING_GAP;
        const outerR = centerRadius + depth * ringWidth - RING_GAP;

        arcs.push({
          node: child,
          depth,
          startAngle: childStart,
          endAngle: childEnd,
          innerR,
          outerR
        });

        buildArcs(child, depth + 1, childStart, childEnd);
        currentAngle = childEnd;
      }
    }

    buildArcs(rootNode, 1, 0, Math.PI * 2);

    // SVG
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    // Text shadow filter
    const defs = document.createElementNS(ns, 'defs');
    const filter = document.createElementNS(ns, 'filter');
    filter.setAttribute('id', 'rings-shadow');
    filter.setAttribute('x', '-20%');
    filter.setAttribute('y', '-20%');
    filter.setAttribute('width', '140%');
    filter.setAttribute('height', '140%');
    const shadow = document.createElementNS(ns, 'feDropShadow');
    shadow.setAttribute('dx', '0');
    shadow.setAttribute('dy', '1');
    shadow.setAttribute('stdDeviation', '1.5');
    shadow.setAttribute('flood-color', '#000');
    shadow.setAttribute('flood-opacity', '0.85');
    filter.appendChild(shadow);
    defs.appendChild(filter);
    svg.appendChild(defs);

    // Center circle (click to go up)
    const centerGroup = document.createElementNS(ns, 'g');
    centerGroup.style.cursor = bubblePath.length > 0 ? 'zoom-out' : 'default';

    const centerCircle = document.createElementNS(ns, 'circle');
    centerCircle.setAttribute('cx', cx);
    centerCircle.setAttribute('cy', cy);
    centerCircle.setAttribute('r', centerRadius);
    centerCircle.setAttribute('fill', '#0e1525');
    centerCircle.setAttribute('stroke', 'rgba(0, 210, 255, 0.15)');
    centerCircle.setAttribute('stroke-width', '2');
    centerCircle.classList.add('rings-center');
    centerGroup.appendChild(centerCircle);

    // Center label: folder name
    const centerName = document.createElementNS(ns, 'text');
    centerName.setAttribute('x', cx);
    centerName.setAttribute('y', cy - 6);
    centerName.setAttribute('text-anchor', 'middle');
    centerName.setAttribute('dominant-baseline', 'central');
    centerName.setAttribute('fill', '#e0e0e0');
    centerName.setAttribute('font-size', Math.min(13, centerRadius / 4));
    centerName.setAttribute('font-weight', '600');
    centerName.setAttribute('filter', 'url(#rings-shadow)');
    centerName.classList.add('rings-center-label');
    const maxCenterChars = Math.floor(centerRadius * 2 / 8);
    const rootName = rootNode.name || '(root)';
    centerName.textContent = rootName.length > maxCenterChars
      ? rootName.substring(0, maxCenterChars - 1) + '\u2026'
      : rootName;
    centerGroup.appendChild(centerName);

    // Center sub-label: total size
    const centerSize = document.createElementNS(ns, 'text');
    centerSize.setAttribute('x', cx);
    centerSize.setAttribute('y', cy + 10);
    centerSize.setAttribute('text-anchor', 'middle');
    centerSize.setAttribute('dominant-baseline', 'central');
    centerSize.setAttribute('fill', '#00d2ff');
    centerSize.setAttribute('font-size', Math.min(11, centerRadius / 5));
    centerSize.setAttribute('font-weight', '600');
    centerSize.setAttribute('filter', 'url(#rings-shadow)');
    centerSize.textContent = formatSize(effectiveNodeSize(rootNode));
    centerGroup.appendChild(centerSize);

    // Hint: click to go up
    if (bubblePath.length > 0) {
      const upHint = document.createElementNS(ns, 'text');
      upHint.setAttribute('x', cx);
      upHint.setAttribute('y', cy + 24);
      upHint.setAttribute('text-anchor', 'middle');
      upHint.setAttribute('dominant-baseline', 'central');
      upHint.setAttribute('fill', 'rgba(255,255,255,0.35)');
      upHint.setAttribute('font-size', Math.min(9, centerRadius / 6));
      upHint.setAttribute('filter', 'url(#rings-shadow)');
      upHint.textContent = '\u2191 click to go up';
      centerGroup.appendChild(upHint);
    }

    centerGroup.addEventListener('click', (e) => {
      e.stopPropagation();
      if (bubblePath.length > 0) navigateBubble(bubblePath.slice(0, -1));
    });
    centerGroup.addEventListener('mouseenter', (e) => {
      if (bubblePath.length > 0) centerCircle.setAttribute('fill', '#222240');
      showBubbleTooltip(e, {
        name: rootNode.name || '(root)',
        path: rootNode.path || '',
        size: effectiveNodeSize(rootNode),
        fileCount: rootNode.fileCount
      });
    });
    centerGroup.addEventListener('mousemove', moveTooltip);
    centerGroup.addEventListener('mouseleave', () => {
      centerCircle.setAttribute('fill', '#0e1525');
      hideTooltip();
    });

    svg.appendChild(centerGroup);

    // Arc path helper
    function arcPath(startAngle, endAngle, innerR, outerR) {
      const a1 = startAngle - Math.PI / 2;
      const a2 = endAngle - Math.PI / 2;

      const x1i = cx + innerR * Math.cos(a1);
      const y1i = cy + innerR * Math.sin(a1);
      const x2i = cx + innerR * Math.cos(a2);
      const y2i = cy + innerR * Math.sin(a2);
      const x1o = cx + outerR * Math.cos(a1);
      const y1o = cy + outerR * Math.sin(a1);
      const x2o = cx + outerR * Math.cos(a2);
      const y2o = cy + outerR * Math.sin(a2);

      const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;

      return [
        `M ${x1i} ${y1i}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 1 ${x2i} ${y2i}`,
        `L ${x2o} ${y2o}`,
        `A ${outerR} ${outerR} 0 ${largeArc} 0 ${x1o} ${y1o}`,
        'Z'
      ].join(' ');
    }

    // Render arcs
    for (const arc of arcs) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', arcPath(arc.startAngle, arc.endAngle, arc.innerR, arc.outerR));
      path.setAttribute('fill', getBubbleColor({ ...arc.node, isFolder: true }));
      path.setAttribute('stroke', getComputedStyle(document.body).getPropertyValue('--chart-stroke').trim() || '#080c14');
      path.setAttribute('stroke-width', '0.5');
      path.classList.add('rings-arc');

      path.addEventListener('mouseenter', (e) => {
        showBubbleTooltip(e, arc.node);
      });
      path.addEventListener('mousemove', moveTooltip);
      path.addEventListener('mouseleave', hideTooltip);

      path.addEventListener('click', (e) => {
        e.stopPropagation();
        if (arc.node.children && Object.keys(arc.node.children).length > 0) {
          navigateBubble(arc.node.path.split('/'));
        }
      });

      svg.appendChild(path);
    }

    // Arc labels for large enough segments (depth 1-2 only)
    for (const arc of arcs) {
      if (arc.depth > 2) continue;

      const angularSpan = arc.endAngle - arc.startAngle;
      const midAngle = (arc.startAngle + arc.endAngle) / 2 - Math.PI / 2;
      const midR = (arc.innerR + arc.outerR) / 2;
      const arcLen = angularSpan * midR;

      if (arcLen < 40 || (arc.outerR - arc.innerR) < 16) continue;

      const tx = cx + midR * Math.cos(midAngle);
      const ty = cy + midR * Math.sin(midAngle);

      const fontSize = Math.min(11, Math.max(8, (arc.outerR - arc.innerR) / 3));
      const maxChars = Math.floor(arcLen / (fontSize * 0.55));

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', tx);
      label.setAttribute('y', ty);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('fill', '#fff');
      label.setAttribute('font-size', fontSize);
      label.setAttribute('font-weight', '600');
      label.setAttribute('filter', 'url(#rings-shadow)');
      label.setAttribute('pointer-events', 'none');
      const name = arc.node.name;
      label.textContent = name.length > maxChars
        ? name.substring(0, maxChars - 1) + '\u2026'
        : name;

      svg.appendChild(label);
    }

    // Click SVG background to go up
    svg.addEventListener('click', (e) => {
      if (e.target === svg) {
        if (bubblePath.length > 0) {
          navigateBubble(bubblePath.slice(0, -1));
        }
      }
    });

    const container = document.createElement('div');
    container.className = 'rings-container';
    if (ringsAnimDir === 'in') container.classList.add('rings-zoom-in');
    else if (ringsAnimDir === 'out') container.classList.add('rings-zoom-out');
    ringsAnimDir = null;
    container.appendChild(svg);
    viz.appendChild(container);

    updateBreadcrumb();
  }

  // === Rendering: Folder Tree Panel ===

  function getPctColor(pct) {
    // Gradient: small=blue, medium=green/yellow, large=orange/red
    if (pct >= 25) return { bg: 'rgba(244,67,54,0.2)', fg: '#f44336' };
    if (pct >= 15) return { bg: 'rgba(255,152,0,0.2)', fg: '#ff9800' };
    if (pct >= 8) return { bg: 'rgba(255,193,7,0.2)', fg: '#ffc107' };
    if (pct >= 3) return { bg: 'rgba(76,175,80,0.2)', fg: '#4caf50' };
    return { bg: 'rgba(33,150,243,0.18)', fg: '#5c99d4' };
  }

  // Build a folder tree from duplicate file paths with dup group counts
  function buildDupFolderTree() {
    if (!duplicateResults || !duplicateResults.length) return null;
    const root = { name: folderTree ? folderTree.name : '(root)', path: '', dupGroups: 0, dupFiles: 0, wasted: 0, children: {} };

    for (const group of duplicateResults) {
      // Track which folders this group touches
      const touchedFolders = new Set();
      for (const f of group.files) {
        const parts = f.relativePath.replace(/\\/g, '/').split('/');
        let node = root;
        // Walk folder segments (skip the filename)
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i];
          const nodePath = parts.slice(0, i + 1).join('/');
          if (!node.children[seg]) {
            node.children[seg] = { name: seg, path: nodePath, dupGroups: 0, dupFiles: 0, wasted: 0, children: {} };
          }
          node = node.children[seg];
          node.dupFiles++;
          if (!touchedFolders.has(node.path)) {
            touchedFolders.add(node.path);
            node.dupGroups++;
            node.wasted += group.wasted;
          }
        }
        // Count root too
        root.dupFiles++;
      }
      root.dupGroups++;
      root.wasted += group.wasted;
    }

    // Prune empty branches
    function prune(node) {
      if (!node.children) return;
      for (const [key, child] of Object.entries(node.children)) {
        if (child.dupFiles === 0) {
          delete node.children[key];
        } else {
          prune(child);
        }
      }
    }
    prune(root);
    return root;
  }

  function renderDupFolderTree() {
    if (!folderTreeEl) return;
    const tree = buildDupFolderTree();
    if (!tree) return;
    folderTreeEl.innerHTML = '';

    const rootItem = document.createElement('div');
    rootItem.className = 'folder-item expanded';

    const rootRow = document.createElement('div');
    rootRow.className = 'folder-row' + (!dupFolderFilter ? ' active' : '');
    rootRow.dataset.path = '';

    const rootChevron = document.createElement('span');
    rootChevron.className = 'folder-chevron';
    rootChevron.textContent = '\u25B6';

    const rootName = document.createElement('span');
    rootName.className = 'folder-row-name';
    rootName.textContent = tree.name || '(root)';

    const rootGroups = document.createElement('span');
    rootGroups.className = 'folder-row-size';
    rootGroups.textContent = tree.dupGroups + ' groups';

    const rootFiles = document.createElement('span');
    rootFiles.className = 'folder-row-count';
    rootFiles.textContent = tree.dupFiles + ' files';

    const rootWasted = document.createElement('span');
    rootWasted.className = 'folder-row-date';
    rootWasted.style.color = tree.wasted > 0 ? '#f44336' : '';
    rootWasted.textContent = tree.wasted > 0 ? formatSize(tree.wasted) + ' wasted' : '';

    rootRow.appendChild(rootChevron);
    rootRow.appendChild(rootName);
    rootRow.appendChild(rootGroups);
    rootRow.appendChild(rootFiles);
    rootRow.appendChild(rootWasted);

    rootRow.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === rootChevron || e.target === rootChevron.parentElement) {
        rootItem.classList.toggle('expanded');
      } else {
        dupFolderFilter = null;
        highlightDupFolderTree();
        renderDuplicates();
      }
    });

    rootItem.appendChild(rootRow);

    const rootChildren = document.createElement('div');
    rootChildren.className = 'folder-children';
    buildDupTreeNodes(tree, rootChildren, 1);
    rootItem.appendChild(rootChildren);

    folderTreeEl.appendChild(rootItem);
  }

  function buildDupTreeNodes(parentNode, container, depth) {
    if (!parentNode.children) return;

    const children = Object.values(parentNode.children)
      .sort((a, b) => b.wasted - a.wasted || b.dupGroups - a.dupGroups);

    for (const child of children) {
      const hasChildren = child.children && Object.keys(child.children).length > 0;

      const item = document.createElement('div');
      item.className = 'folder-item';

      const row = document.createElement('div');
      row.className = 'folder-row';
      row.style.paddingLeft = (10 + depth * 18) + 'px';
      row.dataset.path = child.path || '';

      if (child.path === dupFolderFilter) {
        row.classList.add('active');
      }

      const chevron = document.createElement('span');
      chevron.className = 'folder-chevron' + (hasChildren ? '' : ' empty');
      chevron.textContent = '\u25B6';

      const countBadge = document.createElement('span');
      countBadge.className = 'folder-pct';
      countBadge.textContent = child.dupGroups.toString();
      countBadge.style.background = 'rgba(244,67,54,0.2)';
      countBadge.style.color = '#f44336';

      const name = document.createElement('span');
      name.className = 'folder-row-name';
      name.textContent = child.name;

      const groups = document.createElement('span');
      groups.className = 'folder-row-size';
      groups.textContent = child.dupGroups + ' groups';

      const files = document.createElement('span');
      files.className = 'folder-row-count';
      files.textContent = child.dupFiles + ' files';

      const wasted = document.createElement('span');
      wasted.className = 'folder-row-date';
      wasted.style.color = child.wasted > 0 ? '#f44336' : '';
      wasted.textContent = child.wasted > 0 ? formatSize(child.wasted) + ' wasted' : '';

      row.appendChild(chevron);
      row.appendChild(countBadge);
      row.appendChild(name);
      row.appendChild(groups);
      row.appendChild(files);
      row.appendChild(wasted);

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (hasChildren && (e.target === chevron)) {
          item.classList.toggle('expanded');
        } else if (child.path) {
          dupFolderFilter = child.path;
          highlightDupFolderTree();
          renderDuplicates();
        }
      });

      item.appendChild(row);

      if (hasChildren) {
        const childContainer = document.createElement('div');
        childContainer.className = 'folder-children';
        buildDupTreeNodes(child, childContainer, depth + 1);
        item.appendChild(childContainer);
      }

      container.appendChild(item);
    }
  }

  function highlightDupFolderTree() {
    if (!folderTreeEl) return;
    const rows = folderTreeEl.querySelectorAll('.folder-row');
    for (const row of rows) {
      row.classList.toggle('active', row.dataset.path === (dupFolderFilter || ''));
    }
    // Auto-expand parents of active row
    const activeRow = folderTreeEl.querySelector('.folder-row.active');
    if (activeRow) {
      let parent = activeRow.parentElement;
      while (parent && parent !== folderTreeEl) {
        if (parent.classList.contains('folder-item')) parent.classList.add('expanded');
        parent = parent.parentElement;
      }
      activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function renderFolderTree() {
    if (!folderTreeEl || !folderTree) return;
    folderTreeEl.innerHTML = '';

    const parentSize = effectiveNodeSize(folderTree) || 1;

    // Root row
    const rootItem = document.createElement('div');
    rootItem.className = 'folder-item expanded';

    const rootRow = document.createElement('div');
    rootRow.className = 'folder-row' + (bubblePath.length === 0 ? ' active' : '');
    rootRow.dataset.path = '';

    const rootChevron = document.createElement('span');
    rootChevron.className = 'folder-chevron';
    rootChevron.textContent = '\u25B6';

    const rootName = document.createElement('span');
    rootName.className = 'folder-row-name';
    rootName.textContent = folderTree.name || '(root)';

    const rootSize = document.createElement('span');
    rootSize.className = 'folder-row-size';
    rootSize.textContent = formatSize(effectiveNodeSize(folderTree));

    const rootCount = document.createElement('span');
    rootCount.className = 'folder-row-count';
    rootCount.textContent = folderTree.fileCount.toLocaleString() + ' items';

    const rootDate = document.createElement('span');
    rootDate.className = 'folder-row-date';
    rootDate.textContent = formatRelativeDate(folderTree.mtime);

    rootRow.appendChild(rootChevron);
    rootRow.appendChild(rootName);
    rootRow.appendChild(rootSize);
    rootRow.appendChild(rootCount);
    rootRow.appendChild(rootDate);

    rootRow.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === rootChevron || e.target === rootChevron.parentElement) {
        rootItem.classList.toggle('expanded');
      } else {
        // Clear folder filter — show all files
        selectFolder(null);
      }
    });

    rootItem.appendChild(rootRow);

    const rootChildren = document.createElement('div');
    rootChildren.className = 'folder-children';
    buildTreeNodes(folderTree, rootChildren, parentSize, 1);
    rootItem.appendChild(rootChildren);

    folderTreeEl.appendChild(rootItem);
  }

  function buildTreeNodes(parentNode, container, rootSize, depth) {
    if (!parentNode.children) return;

    const children = Object.values(parentNode.children)
      .filter(c => effectiveNodeSize(c) > 0)
      .sort(folderSortMode === 'name'
        ? (a, b) => a.name.localeCompare(b.name)
        : (a, b) => effectiveNodeSize(b) - effectiveNodeSize(a)
      );

    for (const child of children) {
      const childEffSize = effectiveNodeSize(child);
      const hasChildren = child.children && Object.values(child.children).some(c => effectiveNodeSize(c) > 0);
      const pct = rootSize > 0 ? (childEffSize / rootSize) * 100 : 0;
      const pctStr = pct >= 10 ? pct.toFixed(0) + '%' : pct.toFixed(1) + '%';
      const colors = getPctColor(pct);

      const item = document.createElement('div');
      item.className = 'folder-item';

      const row = document.createElement('div');
      row.className = 'folder-row';
      row.style.paddingLeft = (10 + depth * 18) + 'px';
      row.dataset.path = child.path || '';

      // Highlight if this is the active navigated folder
      const currentPath = bubblePath.join('/');
      if (child.path === currentPath) {
        row.classList.add('active');
      }

      const chevron = document.createElement('span');
      chevron.className = 'folder-chevron' + (hasChildren ? '' : ' empty');
      chevron.textContent = '\u25B6';

      const pctBadge = document.createElement('span');
      pctBadge.className = 'folder-pct';
      pctBadge.textContent = pctStr;
      pctBadge.style.background = colors.bg;
      pctBadge.style.color = colors.fg;

      const name = document.createElement('span');
      name.className = 'folder-row-name';
      name.textContent = child.name;

      const size = document.createElement('span');
      size.className = 'folder-row-size';
      size.textContent = formatSize(childEffSize);

      const count = document.createElement('span');
      count.className = 'folder-row-count';
      count.textContent = child.fileCount.toLocaleString() + ' items';

      const date = document.createElement('span');
      date.className = 'folder-row-date';
      date.textContent = formatRelativeDate(child.mtime);

      row.appendChild(chevron);
      row.appendChild(pctBadge);
      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(count);
      row.appendChild(date);

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (hasChildren && (e.target === chevron)) {
          item.classList.toggle('expanded');
        } else if (child.path) {
          // Filter all views to this folder
          selectFolder(child.path);
        }
      });

      item.appendChild(row);

      if (hasChildren) {
        const childContainer = document.createElement('div');
        childContainer.className = 'folder-children';
        buildTreeNodes(child, childContainer, rootSize, depth + 1);
        item.appendChild(childContainer);
      }

      container.appendChild(item);
    }
  }

  function highlightFolderTree() {
    if (!folderTreeEl) return;
    const currentPath = selectedFolderPath || '';
    const rows = folderTreeEl.querySelectorAll('.folder-row');
    for (const row of rows) {
      row.classList.toggle('active', row.dataset.path === currentPath);
    }

    // Auto-expand parents of active row
    const activeRow = folderTreeEl.querySelector('.folder-row.active');
    if (activeRow) {
      let el = activeRow.closest('.folder-item');
      while (el) {
        el.classList.add('expanded');
        el = el.parentElement?.closest('.folder-item');
      }
      // Scroll into view
      activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // === Feature: Histogram ===

  function renderHistogram() {
    if (!displayFiles.length) { renderEmpty('No files to display'); return; }
    const buckets = [
      { label: '0–1 KB', min: 0, max: 1024 },
      { label: '1–10 KB', min: 1024, max: 10240 },
      { label: '10–100 KB', min: 10240, max: 102400 },
      { label: '100 KB–1 MB', min: 102400, max: 1048576 },
      { label: '1–10 MB', min: 1048576, max: 10485760 },
      { label: '10–100 MB', min: 10485760, max: 104857600 },
      { label: '100 MB–1 GB', min: 104857600, max: 1073741824 },
      { label: '1–10 GB', min: 1073741824, max: 10737418240 },
      { label: '10+ GB', min: 10737418240, max: Infinity }
    ];

    const counts = buckets.map(() => ({ count: 0, totalSize: 0 }));
    for (const f of displayFiles) {
      const fSz = effectiveSize(f);
      for (let i = 0; i < buckets.length; i++) {
        if (fSz >= buckets[i].min && fSz < buckets[i].max) {
          counts[i].count++;
          counts[i].totalSize += fSz;
          break;
        }
      }
    }

    const maxCount = Math.max(...counts.map(c => c.count), 1);
    const maxSize = Math.max(...counts.map(c => c.totalSize), 1);

    let html = '<div class="histogram-container">';
    html += '<div class="histogram-header">';
    html += '<h3>File Size Distribution</h3>';
    html += '<div class="histogram-legend"><span class="hist-legend-count">■ File Count</span><span class="hist-legend-size">■ Total Size</span></div>';
    html += '</div>';
    html += '<div class="histogram-chart">';

    for (let i = 0; i < buckets.length; i++) {
      const countPct = (counts[i].count / maxCount) * 100;
      const sizePct = (counts[i].totalSize / maxSize) * 100;
      html += `<div class="hist-row">
        <div class="hist-label">${buckets[i].label}</div>
        <div class="hist-bars">
          <div class="hist-bar-wrap">
            <div class="hist-bar hist-bar-count" style="width:${Math.max(countPct, 0.5)}%"></div>
            <span class="hist-bar-value">${counts[i].count.toLocaleString()} files</span>
          </div>
          <div class="hist-bar-wrap">
            <div class="hist-bar hist-bar-size" style="width:${Math.max(sizePct, 0.5)}%"></div>
            <span class="hist-bar-value">${formatSize(counts[i].totalSize)}</span>
          </div>
        </div>
      </div>`;
    }

    html += '</div>';

    // Summary insights
    const totalCount = displayFiles.length;
    const smallFiles = counts[0].count + counts[1].count + counts[2].count;
    const bigFiles = counts[6].count + counts[7].count + counts[8].count;
    const bigFilesSize = counts[6].totalSize + counts[7].totalSize + counts[8].totalSize;
    const totalSizeAll = counts.reduce((s, c) => s + c.totalSize, 0);

    html += '<div class="histogram-insights">';
    html += `<div class="insight-card"><span class="insight-num">${((smallFiles / totalCount) * 100).toFixed(1)}%</span><span class="insight-desc">of files are under 100 KB</span></div>`;
    html += `<div class="insight-card"><span class="insight-num">${bigFiles.toLocaleString()}</span><span class="insight-desc">files over 100 MB using ${formatSize(bigFilesSize)} (${totalSizeAll > 0 ? ((bigFilesSize / totalSizeAll) * 100).toFixed(1) : 0}%)</span></div>`;

    // Find the most populated bucket
    let peakIdx = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i].count > counts[peakIdx].count) peakIdx = i;
    }
    html += `<div class="insight-card"><span class="insight-num">${buckets[peakIdx].label}</span><span class="insight-desc">most common file size range (${counts[peakIdx].count.toLocaleString()} files)</span></div>`;
    html += '</div></div>';

    viz.innerHTML = html;
  }

  // === Feature: Timeline ===

  function renderTimeline() {
    if (!displayFiles.length) { renderEmpty('No files to display'); return; }

    const now = Date.now();
    const periods = [
      { label: 'Today', min: now - 86400000, max: now },
      { label: 'This Week', min: now - 604800000, max: now - 86400000 },
      { label: 'This Month', min: now - 2592000000, max: now - 604800000 },
      { label: '1–3 Months', min: now - 7776000000, max: now - 2592000000 },
      { label: '3–6 Months', min: now - 15552000000, max: now - 7776000000 },
      { label: '6–12 Months', min: now - 31536000000, max: now - 15552000000 },
      { label: '1–2 Years', min: now - 63072000000, max: now - 31536000000 },
      { label: '2–5 Years', min: now - 157680000000, max: now - 63072000000 },
      { label: '5+ Years', min: 0, max: now - 157680000000 }
    ];

    const data = periods.map(() => ({ count: 0, totalSize: 0, types: {} }));
    for (const f of displayFiles) {
      const mt = f.mtime || 0;
      const fSz = effectiveSize(f);
      for (let i = 0; i < periods.length; i++) {
        if (mt >= periods[i].min && mt < periods[i].max) {
          data[i].count++;
          data[i].totalSize += fSz;
          const cat = getFileCategory(f.ext);
          data[i].types[cat] = (data[i].types[cat] || 0) + fSz;
          break;
        }
        // Files older than 5+ years fall into last bucket
        if (i === periods.length - 1 && mt < periods[i].max) {
          data[i].count++;
          data[i].totalSize += fSz;
          const cat = getFileCategory(f.ext);
          data[i].types[cat] = (data[i].types[cat] || 0) + fSz;
        }
      }
    }

    const maxSize = Math.max(...data.map(d => d.totalSize), 1);
    const maxCount = Math.max(...data.map(d => d.count), 1);
    const categories = Object.keys(EXT_COLORS).filter(k => k !== 'default');

    let html = '<div class="timeline-container">';
    html += '<div class="histogram-header"><h3>File Age Timeline</h3>';
    html += '<div class="histogram-legend">';
    for (const cat of categories) {
      html += `<span class="tl-legend" style="color:${EXT_COLORS[cat]}">■ ${cat}</span>`;
    }
    html += '</div></div>';

    html += '<div class="timeline-chart">';
    for (let i = 0; i < periods.length; i++) {
      const d = data[i];
      const pct = (d.totalSize / maxSize) * 100;

      // Build stacked bar segments by type
      let stackHtml = '';
      if (d.totalSize > 0) {
        for (const cat of categories) {
          const catSize = d.types[cat] || 0;
          if (catSize > 0) {
            const segPct = (catSize / d.totalSize) * 100;
            stackHtml += `<div class="tl-seg" style="width:${segPct}%;background:${EXT_COLORS[cat]}" title="${cat}: ${formatSize(catSize)}"></div>`;
          }
        }
        // Add 'other'
        const knownSize = categories.reduce((s, c) => s + (d.types[c] || 0), 0);
        const otherSize = d.totalSize - knownSize;
        if (otherSize > 0) {
          stackHtml += `<div class="tl-seg" style="width:${(otherSize / d.totalSize) * 100}%;background:${EXT_COLORS.default}" title="other: ${formatSize(otherSize)}"></div>`;
        }
      }

      html += `<div class="tl-row">
        <div class="tl-label">${periods[i].label}</div>
        <div class="tl-bar-area">
          <div class="tl-bar-outer" style="width:${Math.max(pct, 0.5)}%">
            <div class="tl-bar-stacked">${stackHtml}</div>
          </div>
        </div>
        <div class="tl-stats">
          <span class="tl-count">${d.count.toLocaleString()} files</span>
          <span class="tl-size">${formatSize(d.totalSize)}</span>
        </div>
      </div>`;
    }
    html += '</div>';

    // Insights
    const recentSize = data[0].totalSize + data[1].totalSize + data[2].totalSize;
    const oldSize = data[6].totalSize + data[7].totalSize + data[8].totalSize;
    const totalSizeAll = data.reduce((s, d) => s + d.totalSize, 0);
    const oldCount = data[6].count + data[7].count + data[8].count;

    html += '<div class="histogram-insights">';
    html += `<div class="insight-card"><span class="insight-num">${formatSize(recentSize)}</span><span class="insight-desc">modified in the last month</span></div>`;
    html += `<div class="insight-card"><span class="insight-num">${oldCount.toLocaleString()} files</span><span class="insight-desc">over 1 year old (${formatSize(oldSize)} — ${totalSizeAll > 0 ? ((oldSize / totalSizeAll) * 100).toFixed(1) : 0}%)</span></div>`;

    // Find the period with most data
    let peakIdx = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i].totalSize > data[peakIdx].totalSize) peakIdx = i;
    }
    html += `<div class="insight-card"><span class="insight-num">${periods[peakIdx].label}</span><span class="insight-desc">most data (${formatSize(data[peakIdx].totalSize)})</span></div>`;
    html += '</div></div>';

    viz.innerHTML = html;
  }

  // === Feature: Collector (Deletion Staging) ===

  function updateCollectorUI() {
    const panel = document.getElementById('collector-panel');
    const countEl = document.getElementById('collector-count');
    const sizeEl = document.getElementById('collector-size');
    const listEl = document.getElementById('collector-list');

    if (collectorItems.length === 0) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    const totalSize = collectorItems.reduce((s, f) => s + f.size, 0);
    countEl.textContent = collectorItems.length + ' item' + (collectorItems.length !== 1 ? 's' : '');
    sizeEl.textContent = formatSize(totalSize) + ' to reclaim';

    listEl.innerHTML = '';
    for (let i = 0; i < collectorItems.length; i++) {
      const f = collectorItems[i];
      const row = document.createElement('div');
      row.className = 'collector-item';
      row.innerHTML = `<span class="collector-item-name" title="${escHtml(f.relativePath || f.name)}">${escHtml(f.name)}</span>
        <span class="collector-item-size">${formatSize(f.size)}</span>
        <button class="collector-item-remove" data-idx="${i}" title="Remove from collector">&times;</button>`;
      listEl.appendChild(row);
    }

    // Remove individual items
    listEl.querySelectorAll('.collector-item-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx);
        collectorItems.splice(idx, 1);
        updateCollectorUI();
      });
    });
  }

  function addToCollector(file) {
    if (!file) return;
    // Avoid duplicates
    if (collectorItems.some(f => f.path === file.path)) return;
    collectorItems.push(file);
    updateCollectorUI();
  }

  function clearCollector() {
    collectorItems = [];
    updateCollectorUI();
  }

  async function deleteCollectorItems() {
    if (collectorItems.length === 0) return;
    const totalSize = collectorItems.reduce((s, f) => s + f.size, 0);
    const count = collectorItems.length;

    // Confirmation is handled by main process
    const paths = collectorItems.map(f => f.path);
    const result = await window.api.deleteFiles(paths);
    if (result && result.deleted > 0) {
      // Remove deleted files from allFiles and displayFiles
      const deletedSet = new Set(result.deletedPaths || paths);
      allFiles = allFiles.filter(f => !deletedSet.has(f.path));
      collectorItems = collectorItems.filter(f => !deletedSet.has(f.path));
      applyFilters();
      updateCollectorUI();
    }
  }

  // === Feature: File Tagging ===

  function getFileTags(file) {
    const key = file.relativePath || file.path;
    return fileTags[key] || [];
  }

  function toggleTag(file, tagName) {
    const key = file.relativePath || file.path;
    if (!fileTags[key]) fileTags[key] = [];
    const idx = fileTags[key].indexOf(tagName);
    if (idx >= 0) fileTags[key].splice(idx, 1);
    else fileTags[key].push(tagName);
    if (fileTags[key].length === 0) delete fileTags[key];
    saveTagsDebounced();
    renderVisualization();
  }

  function saveTagsDebounced() {
    clearTimeout(tagSaveTimer);
    tagSaveTimer = setTimeout(() => {
      const folder = folderPathEl.textContent;
      if (folder) window.api.saveTags(folder, fileTags);
    }, 300);
  }

  async function loadTagsForFolder(folder) {
    fileTags = await window.api.loadTags(folder) || {};
  }

  function renderTagDots(file) {
    const tags = getFileTags(file);
    if (!tags.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'tag-dots';
    for (const t of tags) {
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.backgroundColor = TAG_DEFS[t] || '#888';
      dot.title = t.charAt(0).toUpperCase() + t.slice(1);
      wrap.appendChild(dot);
    }
    return wrap;
  }

  // === Feature: Locate-by-Type ===

  function locateByType(category) {
    // Determine which categories match this pill
    const knownCats = Object.keys(EXT_MAP);
    const matching = allFiles.filter(f => {
      const cat = getFileCategory(f.ext);
      if (category === 'other') return !knownCats.includes(cat);
      return cat === category;
    });
    if (!matching.length) return;

    // Group by parent folder
    const folderMap = {};
    for (const f of matching) {
      const rp = (f.relativePath || f.path).replace(/\\/g, '/');
      const parts = rp.split('/');
      const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
      if (!folderMap[folder]) folderMap[folder] = { path: folder, count: 0, size: 0 };
      folderMap[folder].count++;
      folderMap[folder].size += f.size;
    }

    const folders = Object.values(folderMap).sort((a, b) => b.size - a.size);
    showLocatePanel(category, matching.length, folders);
  }

  function showLocatePanel(category, totalCount, folders) {
    const overlay = document.getElementById('locate-overlay');
    const title = document.getElementById('locate-title');
    const body = document.getElementById('locate-body');
    const label = category.charAt(0).toUpperCase() + category.slice(1);

    title.textContent = '\u{1F50D} Locate: ' + label + ' files';
    let html = `<div class="locate-summary">${totalCount.toLocaleString()} ${escHtml(label.toLowerCase())} file${totalCount !== 1 ? 's' : ''} across ${folders.length} folder${folders.length !== 1 ? 's' : ''}</div>`;

    const maxSize = folders.length ? folders[0].size : 1;
    for (const f of folders.slice(0, 100)) {
      const pct = Math.max(2, (f.size / maxSize) * 100);
      html += `<div class="locate-row" data-folder="${escHtml(f.path)}" title="${escHtml(f.path)}">
        <div class="locate-row-info">
          <span class="locate-folder-name">${escHtml(f.path)}</span>
          <span class="locate-meta">${f.count} file${f.count !== 1 ? 's' : ''} &middot; ${formatSize(f.size)}</span>
        </div>
        <div class="locate-bar-track"><div class="locate-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    }

    body.innerHTML = html;
    overlay.classList.remove('hidden');

    // Click handler for rows
    body.querySelectorAll('.locate-row').forEach(row => {
      row.addEventListener('click', () => {
        const folderPath = row.dataset.folder;
        closeLocatePanel();
        // Navigate folder tree to this folder
        if (folderPath && folderPath !== '(root)') {
          selectedFolderPath = folderPath;
          applyFilters();
          renderFolderTree();
        }
      });
    });
  }

  function closeLocatePanel() {
    document.getElementById('locate-overlay').classList.add('hidden');
  }

  // === Feature: Scan Comparison ===

  async function compareScan() {
    if (!allFiles.length) return;
    const folderPath = folderPathEl.textContent;
    if (!folderPath) return;

    // Load the cached previous scan
    const cached = await window.api.loadCache(folderPath);
    if (!cached || !cached.files) {
      alert('No previous scan cached for this folder. Scan it once, then scan again later to compare.');
      return;
    }

    const cachedDate = new Date(cached.cachedAt).toLocaleString();
    const oldFiles = new Map();
    for (const f of cached.files) {
      oldFiles.set(f.relativePath || f.path, f);
    }

    const currentFiles = new Map();
    for (const f of allFiles) {
      currentFiles.set(f.relativePath || f.path, f);
    }

    // Compute diffs
    const added = [];      // in current but not in old
    const removed = [];    // in old but not in current
    const grown = [];      // size increased
    const shrunk = [];     // size decreased

    for (const [key, f] of currentFiles) {
      const old = oldFiles.get(key);
      if (!old) {
        added.push({ ...f, diff: f.size });
      } else if (f.size > old.size) {
        grown.push({ ...f, diff: f.size - old.size, oldSize: old.size });
      } else if (f.size < old.size) {
        shrunk.push({ ...f, diff: old.size - f.size, oldSize: old.size });
      }
    }
    for (const [key, f] of oldFiles) {
      if (!currentFiles.has(key)) {
        removed.push({ ...f, diff: f.size });
      }
    }

    // Sort by diff descending
    added.sort((a, b) => b.diff - a.diff);
    removed.sort((a, b) => b.diff - a.diff);
    grown.sort((a, b) => b.diff - a.diff);
    shrunk.sort((a, b) => b.diff - a.diff);

    const totalAdded = added.reduce((s, f) => s + f.diff, 0);
    const totalRemoved = removed.reduce((s, f) => s + f.diff, 0);
    const totalGrown = grown.reduce((s, f) => s + f.diff, 0);
    const totalShrunk = shrunk.reduce((s, f) => s + f.diff, 0);
    const netChange = totalAdded + totalGrown - totalRemoved - totalShrunk;

    let html = '<div class="compare-container">';
    html += `<div class="compare-header"><h3>Scan Comparison</h3><span class="compare-date">Previous scan: ${cachedDate}</span></div>`;

    // Summary cards
    html += '<div class="compare-summary">';
    html += `<div class="compare-card compare-added"><span class="compare-num">+${formatSize(totalAdded)}</span><span class="compare-label">${added.length} new files</span></div>`;
    html += `<div class="compare-card compare-removed"><span class="compare-num">-${formatSize(totalRemoved)}</span><span class="compare-label">${removed.length} deleted files</span></div>`;
    html += `<div class="compare-card compare-grown"><span class="compare-num">+${formatSize(totalGrown)}</span><span class="compare-label">${grown.length} files grew</span></div>`;
    html += `<div class="compare-card compare-shrunk"><span class="compare-num">-${formatSize(totalShrunk)}</span><span class="compare-label">${shrunk.length} files shrank</span></div>`;
    html += `<div class="compare-card compare-net"><span class="compare-num">${netChange >= 0 ? '+' : ''}${formatSize(Math.abs(netChange))}</span><span class="compare-label">net ${netChange >= 0 ? 'growth' : 'reduction'}</span></div>`;
    html += '</div>';

    // Detail lists (show top 20 each)
    function renderChangeList(title, items, cssClass, showOldSize) {
      if (!items.length) return '';
      let h = `<div class="compare-section"><h4 class="${cssClass}">${title} (${items.length})</h4>`;
      h += '<div class="compare-list">';
      const shown = items.slice(0, 20);
      for (const f of shown) {
        h += `<div class="compare-item">
          <span class="compare-item-name" title="${f.relativePath || f.name}">${f.name}</span>
          ${showOldSize ? `<span class="compare-item-old">${formatSize(f.oldSize)}</span><span class="compare-arrow">→</span>` : ''}
          <span class="compare-item-size">${formatSize(f.size)}</span>
          <span class="compare-item-diff ${cssClass}">${cssClass.includes('add') || cssClass.includes('grow') ? '+' : '-'}${formatSize(f.diff)}</span>
        </div>`;
      }
      if (items.length > 20) h += `<div class="compare-more">...and ${items.length - 20} more</div>`;
      h += '</div></div>';
      return h;
    }

    html += renderChangeList('New Files', added, 'compare-added', false);
    html += renderChangeList('Deleted Files', removed, 'compare-removed', false);
    html += renderChangeList('Files That Grew', grown, 'compare-grown', true);
    html += renderChangeList('Files That Shrank', shrunk, 'compare-shrunk', true);
    html += '</div>';

    // Temporarily switch to compare view
    viz.innerHTML = html;
  }

  // === Feature: Advanced Search ===

  function buildAdvancedSearch() {
    const filterBar = document.getElementById('filter-bar');
    if (!filterBarOpen) {
      filterBar.classList.add('hidden');
      return;
    }
    filterBar.classList.remove('hidden');

    // Check if advanced search already built
    if (filterBar.querySelector('.adv-search-input')) {
      return;
    }

    // Build advanced filter UI
    let html = '<div class="filter-bar-inner">';

    // Search / regex input
    html += '<div class="filter-group adv-search-group">';
    html += '<label class="filter-label">Search</label>';
    html += '<input type="text" id="adv-search-input" class="adv-search-input" placeholder="regex: \\.mp4$ or term or >1GB or modified:7d">';
    html += '</div>';

    // Type checkboxes
    html += '<div class="filter-group">';
    html += '<label class="filter-label">Type</label>';
    html += '<div class="filter-pills">';
    const categories = [...new Set([...Object.keys(EXT_MAP), 'other'])];
    for (const cat of categories) {
      const color = EXT_COLORS[cat] || EXT_COLORS.default;
      const checked = !filterTypes || filterTypes.has(cat) ? 'active' : '';
      html += `<button class="filter-pill ${checked}" data-type="${cat}" style="--pill-color:${color}">${cat}<span class="pill-locate" data-locate="${cat}" title="Locate folders with ${cat} files">&#128269;</span></button>`;
    }
    html += '</div></div>';

    // Size filter
    html += '<div class="filter-group">';
    html += '<label class="filter-label">Min Size</label>';
    html += '<div class="filter-pills">';
    const sizes = [
      { label: 'All', value: 0 },
      { label: '>1 KB', value: 1024 },
      { label: '>100 KB', value: 102400 },
      { label: '>1 MB', value: 1048576 },
      { label: '>10 MB', value: 10485760 },
      { label: '>100 MB', value: 104857600 },
      { label: '>1 GB', value: 1073741824 }
    ];
    for (const s of sizes) {
      const active = filterMinSize === s.value ? 'active' : '';
      html += `<button class="filter-size-pill ${active}" data-size="${s.value}">${s.label}</button>`;
    }
    html += '</div></div>';

    html += '<button id="filter-reset" class="filter-reset-btn">Reset</button>';
    html += '</div>';
    filterBar.innerHTML = html;

    // Wire up events
    const searchInput = document.getElementById('adv-search-input');
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applyAdvancedFilters(), 300);
    });

    filterBar.querySelectorAll('.pill-locate').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        locateByType(btn.dataset.locate);
      });
    });

    filterBar.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        const activeTypes = new Set();
        filterBar.querySelectorAll('.filter-pill.active').forEach(b => activeTypes.add(b.dataset.type));
        if (activeTypes.size === categories.length) {
          filterTypes = null; // all selected = no filter
        } else {
          filterTypes = activeTypes.size > 0 ? activeTypes : null;
        }
        applyAdvancedFilters();
      });
    });

    filterBar.querySelectorAll('.filter-size-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        filterBar.querySelectorAll('.filter-size-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filterMinSize = parseInt(btn.dataset.size);
        applyAdvancedFilters();
      });
    });

    document.getElementById('filter-reset').addEventListener('click', () => {
      filterTypes = null;
      filterMinSize = 0;
      searchInput.value = '';
      filterBar.querySelectorAll('.filter-pill').forEach(b => b.classList.add('active'));
      filterBar.querySelectorAll('.filter-size-pill').forEach(b => b.classList.remove('active'));
      filterBar.querySelector('.filter-size-pill[data-size="0"]').classList.add('active');
      applyAdvancedFilters();
    });
  }

  function parseSearchExpression(query) {
    // Support: regex patterns, size expressions (>1GB, <100MB), time expressions (modified:7d, modified:30d)
    const filters = { regex: null, minSize: null, maxSize: null, maxAge: null };

    if (!query.trim()) return filters;

    // Check for size expression: >1GB, <100MB etc
    const sizeMatch = query.match(/^([><]=?)\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
    if (sizeMatch) {
      const op = sizeMatch[1];
      const num = parseFloat(sizeMatch[2]);
      const unit = sizeMatch[3].toUpperCase();
      const multipliers = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
      const bytes = num * (multipliers[unit] || 1);
      if (op === '>' || op === '>=') filters.minSize = bytes;
      else if (op === '<' || op === '<=') filters.maxSize = bytes;
      return filters;
    }

    // Check for time expression: modified:7d, modified:30d, modified:1y
    const timeMatch = query.match(/^modified:(\d+)(d|w|m|y)$/i);
    if (timeMatch) {
      const num = parseInt(timeMatch[1]);
      const unit = timeMatch[2].toLowerCase();
      const msPerUnit = { d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
      filters.maxAge = num * (msPerUnit[unit] || 86400000);
      return filters;
    }

    // Otherwise treat as regex
    try {
      filters.regex = new RegExp(query, 'i');
    } catch (e) {
      // If invalid regex, treat as literal string
      filters.regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    return filters;
  }

  function applyAdvancedFilters() {
    const searchInput = document.getElementById('adv-search-input');
    const query = searchInput ? searchInput.value : '';
    const expr = parseSearchExpression(query);

    displayFiles = allFiles.filter(f => {
      if (cloudFilter === 'local' && f.cloudStatus === 'icloud-only') return false;
      if (cloudFilter === 'online' && f.cloudStatus !== 'icloud-only') return false;
      if (selectedFolderPath && !f.relativePath.startsWith(selectedFolderPath + '/') && f.relativePath !== selectedFolderPath) return false;
      const fSize = effectiveSize(f);
      if (filterMinSize > 0 && fSize < filterMinSize) return false;
      if (filterTypes) {
        const cat = getFileCategory(f.ext);
        if (!filterTypes.has(cat)) return false;
      }
      // Advanced search filters
      if (expr.regex && !expr.regex.test(f.name) && !expr.regex.test(f.relativePath || '')) return false;
      if (expr.minSize && fSize < expr.minSize) return false;
      if (expr.maxSize && fSize > expr.maxSize) return false;
      if (expr.maxAge && f.mtime) {
        const age = Date.now() - f.mtime;
        if (age > expr.maxAge) return false;
      }
      return true;
    });
    folderColorMap = null;
    ageRange = null;
    pieOffset = 0;
    updateStats();
    renderFolderTree();
    renderVisualization();
  }

  // === Rendering: Common ===

  function updateToolbarState() {
    const hasData = allFiles.length > 0;
    document.getElementById('btn-export').disabled = !hasData;
    document.getElementById('btn-compare').disabled = !hasData;
    document.getElementById('btn-filter').disabled = !hasData;
    document.getElementById('cloud-filter').disabled = !hasData;
    document.getElementById('view-duplicates').disabled = !hasData;
  }

  function updateTreemapBreadcrumb() {
    const bc = document.getElementById('treemap-breadcrumb');
    if (!bc) return;
    if (!selectedFolderPath || viewMode === 'bubblemap' || viewMode === 'rings') {
      bc.classList.add('hidden');
      return;
    }
    bc.classList.remove('hidden');
    const parts = selectedFolderPath.replace(/\\/g, '/').split('/');
    bc.innerHTML = '';
    const addCrumb = (text, pathVal) => {
      const span = document.createElement('span');
      span.className = 'tb-crumb' + (pathVal === '' ? ' tb-root' : '');
      span.dataset.path = pathVal;
      span.textContent = text;
      span.addEventListener('click', () => selectFolder(pathVal || null));
      bc.appendChild(span);
    };
    addCrumb('All', '');
    let cumPath = '';
    for (let i = 0; i < parts.length; i++) {
      cumPath += (i > 0 ? '/' : '') + parts[i];
      const sep = document.createElement('span');
      sep.className = 'tb-sep';
      sep.innerHTML = '&#9656;';
      bc.appendChild(document.createTextNode(' '));
      bc.appendChild(sep);
      bc.appendChild(document.createTextNode(' '));
      addCrumb(parts[i], cumPath);
    }
  }

  function renderVisualization() {
    if (viewMode !== 'bubblemap' && viewMode !== 'rings') {
      bubbleBreadcrumb.classList.add('hidden');
    }
    updateTreemapBreadcrumb();
    if (viewMode === 'duplicates') {
      renderDuplicates();
      return;
    }
    if (viewMode === 'bubblemap') {
      renderBubbleMap();
      return;
    }
    if (viewMode === 'rings') {
      renderRingsChart();
      return;
    }
    if (!displayFiles.length) return;
    if (viewMode === 'table') {
      renderTable();
    } else if (viewMode === 'histogram') {
      renderHistogram();
    } else if (viewMode === 'timeline') {
      renderTimeline();
    } else if (viewMode === 'treemap') {
      renderTreemap();
    } else {
      renderPieChart();
    }
  }

  function renderEmpty(msg) {
    viz.innerHTML = `<div class="empty-state"><p>${escHtml(msg)}</p></div>`;
  }

  let statsSummaryEl;
  let statsSummaryOpen = false;

  function updateStats() {
    const showingCount = Math.min(displayFiles.length, viewMode === 'treemap' ? MAX_TREEMAP : displayFiles.length);
    let sizeLabel;
    if (cloudFilter === 'online') {
      sizeLabel = `<span>Online size: <span class="stat-value">${formatSize(totalCloudLogicalSize)}</span></span>`;
    } else if (cloudFilter === 'local') {
      sizeLabel = `<span>On disk: <span class="stat-value">${formatSize(totalSize)}</span></span>`;
    } else {
      const combined = totalSize + totalCloudLogicalSize;
      sizeLabel = `<span>Total: <span class="stat-value">${formatSize(combined)}</span></span>` +
        (cloudOnlyCount > 0 ? `<span>On disk: <span class="stat-value">${formatSize(totalSize)}</span></span>` : '');
    }
    statsEl.innerHTML = `
      <span>Files: <span class="stat-value">${totalFiles.toLocaleString()}</span></span>
      ${sizeLabel}
      <span>Showing top: <span class="stat-value">${showingCount.toLocaleString()}</span></span>
      ${cloudOnlyCount > 0 ? `<span class="cloud-stat" title="Files stored in iCloud only — not on your local drive">&#9729; iCloud only: <span class="stat-value">${cloudOnlyCount.toLocaleString()}</span></span>` : ''}
      ${skippedDirs ? `<span>Inaccessible: <span class="stat-value">${skippedDirs.toLocaleString()}</span></span>` : ''}
      ${cacheTimestamp ? `<span class="cache-indicator">Cached: <span class="stat-value">${formatRelativeDate(cacheTimestamp)}</span></span>` : ''}
      ${displayFiles.length ? '<button id="stats-toggle" class="stats-toggle-btn">' + (statsSummaryOpen ? 'Hide Summary' : 'Summary') + '</button>' : ''}
    `;
    statsEl.classList.remove('hidden');
    const toggleBtn = document.getElementById('stats-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        statsSummaryOpen = !statsSummaryOpen;
        updateStatsSummary();
        updateStats();
      });
    }
    updateStatsSummary();
  }

  function updateStatsSummary() {
    if (!statsSummaryEl) statsSummaryEl = document.getElementById('stats-summary');
    if (!statsSummaryOpen || !displayFiles.length) {
      statsSummaryEl.classList.add('hidden');
      return;
    }
    statsSummaryEl.classList.remove('hidden');

    // Type breakdown
    const typeBuckets = {};
    for (const f of displayFiles) {
      const cat = getFileCategory(f.ext);
      if (!typeBuckets[cat]) typeBuckets[cat] = { count: 0, size: 0 };
      typeBuckets[cat].count++;
      typeBuckets[cat].size += f.size;
    }
    const typeEntries = Object.entries(typeBuckets).sort((a, b) => b[1].size - a[1].size);
    const maxTypeSize = typeEntries.length ? typeEntries[0][1].size : 1;

    let typeHtml = typeEntries.slice(0, 8).map(([cat, data]) => {
      const pct = (data.size / maxTypeSize) * 100;
      const color = EXT_COLORS[cat] || '#64748b';
      const label = cat.charAt(0).toUpperCase() + cat.slice(1);
      return `<div class="summary-bar-row">
        <span class="summary-bar-label">${label}</span>
        <div class="summary-bar-track"><div class="summary-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="summary-bar-value">${formatSize(data.size)}</span>
        <span class="summary-bar-count">${data.count}</span>
      </div>`;
    }).join('');

    // Oldest / newest
    let oldest = null, newest = null;
    for (const f of displayFiles) {
      if (!f.mtime) continue;
      if (!oldest || f.mtime < oldest.mtime) oldest = f;
      if (!newest || f.mtime > newest.mtime) newest = f;
    }

    // Average file size
    const avgSize = displayFiles.length ? totalSize / totalFiles : 0;

    // Largest folder
    let largestFolder = null;
    if (folderTree && folderTree.children) {
      for (const child of Object.values(folderTree.children)) {
        if (!largestFolder || child.size > largestFolder.size) largestFolder = child;
      }
    }

    // Age warnings
    const oneYearAgo = Date.now() - (365.25 * 24 * 3600 * 1000);
    const oldFiles = allFiles.filter(f => f.mtime && f.mtime < oneYearAgo);
    const oldSize = oldFiles.reduce((s, f) => s + f.size, 0);
    let ageWarningHtml = '';
    if (oldFiles.length > 0) {
      ageWarningHtml = `<div class="summary-stat summary-stat-warn" id="age-warning-btn" style="cursor:pointer" title="Click to filter to old files">
        <span class="summary-stat-label">&#9888; Files older than 1 year</span>
        <span class="summary-stat-value">${oldFiles.length.toLocaleString()} files &middot; ${formatSize(oldSize)}</span>
      </div>`;
    }

    // Duplicate waste
    let wasteHtml = '';
    if (duplicateResults && duplicateResults.length) {
      let totalWaste = 0;
      for (const g of duplicateResults) {
        totalWaste += g.wasted || 0;
      }
      if (totalWaste > 0) {
        wasteHtml = `<div class="summary-stat"><span class="summary-stat-label">Duplicate waste</span><span class="summary-stat-value">${formatSize(totalWaste)}</span></div>`;
      }
    }

    statsSummaryEl.innerHTML = `
      <div class="summary-section">
        <div class="summary-heading">Type Breakdown</div>
        ${typeHtml}
      </div>
      <div class="summary-section summary-details">
        <div class="summary-stat"><span class="summary-stat-label">Average file size</span><span class="summary-stat-value">${formatSize(avgSize)}</span></div>
        ${oldest ? `<div class="summary-stat"><span class="summary-stat-label">Oldest file</span><span class="summary-stat-value" title="${oldest.name}">${formatRelativeDate(oldest.mtime)} &mdash; ${oldest.name.length > 30 ? oldest.name.slice(0, 30) + '...' : oldest.name}</span></div>` : ''}
        ${newest ? `<div class="summary-stat"><span class="summary-stat-label">Newest file</span><span class="summary-stat-value" title="${newest.name}">${formatRelativeDate(newest.mtime)} &mdash; ${newest.name.length > 30 ? newest.name.slice(0, 30) + '...' : newest.name}</span></div>` : ''}
        ${largestFolder ? `<div class="summary-stat"><span class="summary-stat-label">Largest folder</span><span class="summary-stat-value">${largestFolder.name}/ &mdash; ${formatSize(largestFolder.size)}</span></div>` : ''}
        ${wasteHtml}
        ${ageWarningHtml}
      </div>
    `;

    // Wire up age warning click
    const ageBtn = document.getElementById('age-warning-btn');
    if (ageBtn) {
      ageBtn.addEventListener('click', () => {
        // Set age filter to show only files older than 1 year
        displayFiles = allFiles.filter(f => f.mtime && f.mtime < oneYearAgo);
        displayFiles.sort((a, b) => a.mtime - b.mtime);
        renderVisualization();
      });
    }
  }

  function selectFile(file, event) {
    if (!file || !file.path) return;

    // Multi-select with Cmd/Ctrl or Shift
    if (event && (event.metaKey || event.ctrlKey)) {
      const idx = selectedFiles.findIndex(f => f.path === file.path);
      if (idx >= 0) selectedFiles.splice(idx, 1);
      else selectedFiles.push(file);
      selectedFile = selectedFiles.length ? selectedFiles[selectedFiles.length - 1] : null;
    } else if (event && event.shiftKey && selectedFile) {
      // Range select in table view
      const startIdx = displayFiles.findIndex(f => f.path === selectedFile.path);
      const endIdx = displayFiles.findIndex(f => f.path === file.path);
      if (startIdx >= 0 && endIdx >= 0) {
        const lo = Math.min(startIdx, endIdx);
        const hi = Math.max(startIdx, endIdx);
        selectedFiles = displayFiles.slice(lo, hi + 1);
        selectedFile = file;
      }
    } else {
      selectedFile = file;
      selectedFiles = [file];
    }

    if (selectedFiles.length > 1) {
      const totalSz = selectedFiles.reduce((s, f) => s + effectiveSize(f), 0);
      detailName.textContent = selectedFiles.length + ' files selected';
      detailPath.textContent = '';
      detailSize.textContent = formatSize(totalSz) + ' combined';
    } else if (selectedFile) {
      detailName.textContent = selectedFile.name;
      detailName.title = selectedFile.name;
      detailPath.textContent = selectedFile.relativePath;
      detailPath.title = selectedFile.path;
      detailSize.textContent = selectedFile.cloudStatus === 'icloud-only'
        ? '☁ ' + (selectedFile.logicalSize ? formatSize(selectedFile.logicalSize) + ' (iCloud only)' : 'iCloud only — not on local drive')
        : (selectedFile.logicalSize && selectedFile.logicalSize !== selectedFile.size
          ? `${formatSize(selectedFile.size)} on disk (${formatSize(selectedFile.logicalSize)} logical)`
          : formatSize(selectedFile.size));
    }
    detailPanel.classList.add('visible');
    if (previewExpanded && selectedFiles.length === 1) loadPreview(selectedFile);
    renderVisualization();
  }

  function isFileSelected(file) {
    return selectedFiles.some(f => f.path === file.path);
  }

  // === Tooltip ===

  function showTooltip(e, file) {
    let sizeInfo;
    if (file.cloudStatus === 'icloud-only') {
      sizeInfo = `<span class="tip-cloud">☁ iCloud only — not on local drive</span>`;
    } else if (file.logicalSize && file.logicalSize !== file.size) {
      sizeInfo = `<span class="tip-size">${formatSize(file.size)} on disk</span> <span class="tip-path">(${formatSize(file.logicalSize)} logical)</span>`;
    } else {
      sizeInfo = `<span class="tip-size">${formatSize(file.size)}</span>`;
    }
    tooltip.innerHTML = `
      <strong>${escHtml(file.name)}</strong><br>
      <span class="tip-path">${escHtml(file.relativePath)}</span><br>
      ${sizeInfo}
    `;
    tooltip.style.display = 'block';
    moveTooltip(e);
  }

  function moveTooltip(e) {
    let x = e.clientX + 14;
    let y = e.clientY + 14;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 8;
    if (y + th > window.innerHeight - 8) y = e.clientY - th - 8;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
  }

  // === Actions ===

  let currentFolder = null;
  let cacheTimestamp = null;

  function loadScanResult(result) {
    allFiles = result.files;
    displayFiles = allFiles;
    totalFiles = result.totalFiles;
    totalSize = result.totalSize;
    skippedDirs = result.skippedDirs || 0;
    cloudOnlyCount = result.cloudOnlyCount || 0;
    totalLogicalSize = result.totalLogicalSize || result.totalSize;
    totalCloudLogicalSize = result.totalCloudLogicalSize || 0;
    cloudFilter = 'all';
    const cloudFilterEl = document.getElementById('cloud-filter');
    if (cloudFilterEl) cloudFilterEl.value = 'all';
    duplicateResults = null;
    dupFilterTiers = new Set(['gold', 'silver', 'bronze']);
    dupSortBy = 'size';
    dupSortAsc = false;
    dupFolderFilter = null;
    folderColorMap = null;
    ageRange = null;
    filterTypes = null;
    filterMinSize = 0;
    pieOffset = 0;
    selectedFolderPath = null;
    folderTree = result.folderTree || null;
    bubblePath = [];
    bubbleCurrentNode = folderTree;
    cacheTimestamp = result.cachedAt || null;
    diskSpaceInfo = null;
    updateToolbarState();
    // Load file tags for this folder
    const folder = folderPathEl.textContent;
    if (folder) {
      loadTagsForFolder(folder);
      window.api.getDiskSpace(folder).then(info => {
        diskSpaceInfo = info;
        if (viewMode === 'treemap') renderVisualization();
      }).catch(() => {});
    }
    updateStats();
    if (folderTree) {
      folderPanel.classList.remove('hidden');
      renderFolderTree();
    }
    renderVisualization();
  }

  async function openFolderPath(folder) {
    currentFolder = folder;
    folderPathEl.textContent = folder;
    selectedFile = null;
    selectedFiles = [];
    detailPanel.classList.remove('visible');
    addRecentFolder(folder);

    const cached = await window.api.loadCache(folder);
    if (cached && cached.cachedAt) {
      const ageMs = Date.now() - cached.cachedAt;
      const ageHours = ageMs / 3600000;
      if (ageHours < 24) {
        const ageText = ageHours < 1
          ? Math.floor(ageMs / 60000) + ' min ago'
          : Math.floor(ageHours) + 'h ago';
        viz.innerHTML = `<div class="cache-prompt">
          <p>Cached scan available (${ageText})</p>
          <div class="cache-prompt-actions">
            <button id="cache-use">Use Cached</button>
            <button id="cache-rescan">Rescan</button>
          </div>
        </div>`;
        document.getElementById('cache-use').addEventListener('click', () => {
          loadScanResult(cached);
        });
        document.getElementById('cache-rescan').addEventListener('click', () => {
          doFreshScan(folder);
        });
        return;
      }
    }
    doFreshScan(folder);
  }

  async function handleSelectFolder() {
    const folder = await window.api.selectFolder();
    if (!folder) return;
    openFolderPath(folder);
  }

  function insertIntoTopFiles(file) {
    // Maintain a sorted top-200 list by size descending
    if (scanTopFiles.length < MAX_TREEMAP) {
      scanTopFiles.push(file);
      scanTopFiles.sort((a, b) => b.size - a.size);
    } else if (file.size > scanTopFiles[scanTopFiles.length - 1].size) {
      scanTopFiles[scanTopFiles.length - 1] = file;
      scanTopFiles.sort((a, b) => b.size - a.size);
    }
  }

  function animRender() {
    if (!scanAnimating) return;
    const now = Date.now();
    if (now - lastAnimRenderTime < 250) return;
    lastAnimRenderTime = now;
    if (viewMode === 'treemap' && scanTopFiles.length > 0) {
      displayFiles = scanTopFiles.slice();
      renderTreemap();
    }
  }

  async function doFreshScan(folder) {
    loading.classList.remove('hidden');
    loading.classList.add('scanning');
    loadingText.textContent = 'Diving in...';
    const progressFill = document.getElementById('scan-progress-fill');
    if (progressFill) progressFill.style.width = '5%';

    // Guard against concurrent scans
    if (scanAnimating) {
      scanAnimating = false;
      window.api.removeScanBatchListeners();
    }

    // Set up animated scan
    scanAnimating = true;
    scanTopFiles = [];
    allFiles = [];
    displayFiles = [];
    selectedFile = null;
    selectedFiles = [];
    lastAnimRenderTime = 0;

    // Clear viz for live rendering
    if (viewMode === 'treemap') viz.innerHTML = '';

    // Clean up old listeners before registering new ones
    window.api.removeScanBatchListeners();

    // Listen for file batches
    window.api.onScanBatch((data) => {
      if (!scanAnimating) return;
      for (const f of data.files) {
        insertIntoTopFiles(f);
      }
      loadingText.textContent = `Scanning... ${data.count.toLocaleString()} files found` +
        (data.skipped ? ` (${data.skipped} inaccessible)` : '');
      // Pulse progress bar (indeterminate but with activity feedback)
      const fill = document.getElementById('scan-progress-fill');
      if (fill) {
        const pct = Math.min(95, 30 + Math.log10(data.count + 1) * 15);
        fill.style.width = pct + '%';
      }
      animRender();
    });

    try {
      const result = await window.api.scanFolder(folder);
      scanAnimating = false;
      window.api.removeScanBatchListeners();
      loading.classList.remove('scanning');
      loadScanResult(result);
      window.api.saveCache(folder, result);
    } catch (err) {
      scanAnimating = false;
      window.api.removeScanBatchListeners();
      loading.classList.remove('scanning');
      console.error('Scan error:', err);
      renderEmpty('Error scanning folder');
    } finally {
      loading.classList.add('hidden');
    }
  }

  function setViewMode(mode) {
    if (mode === 'duplicates') {
      // Toggle duplicates as a separate feature
      viewMode = viewMode === 'duplicates' ? lastChartMode : 'duplicates';
    } else {
      lastChartMode = mode;
      viewMode = mode;
      window.api.saveSettings({ lastViewMode: mode });
    }
    btnTreemap.classList.toggle('active', viewMode === 'treemap');
    btnPie.classList.toggle('active', viewMode === 'pie');
    btnBubblemap.classList.toggle('active', viewMode === 'bubblemap');
    btnRings.classList.toggle('active', viewMode === 'rings');
    btnTable.classList.toggle('active', viewMode === 'table');
    btnHistogram.classList.toggle('active', viewMode === 'histogram');
    btnTimeline.classList.toggle('active', viewMode === 'timeline');
    btnDuplicates.classList.toggle('active', viewMode === 'duplicates');
    if (viewMode === 'duplicates') {
      detailPanel.classList.remove('visible');
      // Show duplicate-specific folder tree with updated header
      const fhSize = document.querySelector('.fh-size');
      const fhCount = document.querySelector('.fh-count');
      const fhDate = document.querySelector('.fh-date');
      if (fhSize) fhSize.textContent = 'Groups';
      if (fhCount) fhCount.textContent = 'Files';
      if (fhDate) fhDate.textContent = 'Wasted';
      if (duplicateResults && duplicateResults.length) {
        renderDupFolderTree();
      }
    } else {
      // Restore normal folder tree and header
      dupFolderFilter = null;
      const fhSize = document.querySelector('.fh-size');
      const fhCount = document.querySelector('.fh-count');
      const fhDate = document.querySelector('.fh-date');
      if (fhSize) fhSize.textContent = 'Size';
      if (fhCount) fhCount.textContent = 'Contents';
      if (fhDate) fhDate.textContent = 'Modified';
      renderFolderTree();
    }
    if ((viewMode === 'bubblemap' || viewMode === 'rings') && !bubbleCurrentNode && folderTree) {
      bubblePath = [];
      bubbleCurrentNode = folderTree;
    }
    updateStats();
    renderVisualization();
  }

  function setColorMode(mode) {
    colorMode = mode;
    folderColorMap = null;
    ageRange = null;
    btnColorAge.classList.toggle('active', mode === 'age');
    btnColorType.classList.toggle('active', mode === 'type');
    btnColorFolder.classList.toggle('active', mode === 'folder');
    renderVisualization();
  }

  // === Init ===

  // === Feature: Right-Click Context Menu ===

  let contextMenuFile = null;

  function showContextMenu(x, y, file) {
    const menu = document.getElementById('context-menu');
    contextMenuFile = file;

    const finderBtn = menu.querySelector('[data-action="finder"]');
    if (finderBtn) {
      const platform = window.api.platform;
      const label = platform === 'darwin' ? 'Show in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in Files';
      finderBtn.innerHTML = '&#128194; ' + label;
    }

    menu.classList.remove('hidden');
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }

  function hideContextMenu() {
    document.getElementById('context-menu').classList.add('hidden');
    contextMenuFile = null;
  }

  function handleContextAction(action) {
    if (!contextMenuFile) return;
    switch (action) {
      case 'open': window.api.openFile(contextMenuFile.path); break;
      case 'preview': window.api.previewFile(contextMenuFile.path); break;
      case 'finder': window.api.showInFolder(contextMenuFile.path); break;
      case 'collect': addToCollector(contextMenuFile); break;
      case 'copypath': navigator.clipboard.writeText(contextMenuFile.path); break;
      case 'copysize': navigator.clipboard.writeText(formatSize(contextMenuFile.size)); break;
      case 'tag-keep': toggleTag(contextMenuFile, 'keep'); break;
      case 'tag-reviewed': toggleTag(contextMenuFile, 'reviewed'); break;
      case 'tag-delete': toggleTag(contextMenuFile, 'delete'); break;
    }
    hideContextMenu();
  }

  function findFileFromTarget(target) {
    let el = target;
    while (el && el !== viz) {
      if (el.dataset && el.dataset.filePath) {
        return displayFiles.find(f => f.path === el.dataset.filePath) || allFiles.find(f => f.path === el.dataset.filePath) || null;
      }
      if (el.tagName === 'TR' && el.dataset && el.dataset.fileIdx) {
        return displayFiles[parseInt(el.dataset.fileIdx)] || null;
      }
      if (el.classList && el.classList.contains('pie-legend-item') && el.dataset && el.dataset.fileIdx) {
        return displayFiles[parseInt(el.dataset.fileIdx)] || null;
      }
      el = el.parentElement;
    }
    return null;
  }

  // === Feature: Export HTML Report ===

  function exportHTMLReport() {
    if (!displayFiles.length) return;

    const typeGroups = {};
    for (const f of displayFiles) {
      const cat = getFileCategory(f.ext);
      if (!typeGroups[cat]) typeGroups[cat] = { size: 0, count: 0 };
      typeGroups[cat].size += f.size;
      typeGroups[cat].count++;
    }
    const totalSz = displayFiles.reduce((s, f) => s + f.size, 0);
    const sortedTypes = Object.entries(typeGroups).sort((a, b) => b[1].size - a[1].size);

    const typeColors = { image: '#34d399', video: '#f87171', audio: '#fbbf24', document: '#60a5fa', code: '#a78bfa', archive: '#c084fc', data: '#22d3ee', executable: '#fb7185', other: '#64748b' };
    let angle = 0;
    let pieSvg = '<svg viewBox="0 0 200 200" width="300" height="300" style="margin:0 auto;display:block">';
    for (const [cat, data] of sortedTypes) {
      const pct = data.size / totalSz;
      if (pct < 0.001) continue;
      const startAngle = angle;
      angle += pct * Math.PI * 2;
      const color = typeColors[cat] || '#64748b';
      if (pct >= 0.9999) {
        pieSvg += '<circle cx="100" cy="100" r="90" fill="' + color + '" />';
      } else {
        const x1 = 100 + 90 * Math.cos(startAngle), y1 = 100 + 90 * Math.sin(startAngle);
        const x2 = 100 + 90 * Math.cos(angle), y2 = 100 + 90 * Math.sin(angle);
        pieSvg += '<path d="M100,100 L' + x1 + ',' + y1 + ' A90,90 0 ' + (pct > 0.5 ? 1 : 0) + ',1 ' + x2 + ',' + y2 + ' Z" fill="' + color + '" />';
      }
    }
    pieSvg += '</svg>';

    let legendHtml = sortedTypes.map(([cat, data]) => {
      const color = typeColors[cat] || '#64748b';
      return '<div style="display:flex;gap:8px;align-items:center;margin:4px 0"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:' + color + '"></span><span style="flex:1;text-transform:capitalize">' + cat + '</span><span style="font-weight:600">' + formatSize(data.size) + '</span><span style="color:#999">' + data.count + ' files</span></div>';
    }).join('');

    const sorted = [...displayFiles].sort((a, b) => b.size - a.size).slice(0, 20);
    let tableHtml = '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="border-bottom:2px solid #333"><th style="text-align:left;padding:8px">Name</th><th style="text-align:right;padding:8px">Size</th><th style="text-align:left;padding:8px">Path</th></tr>';
    for (const f of sorted) {
      const name = f.name.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const rp = (f.relativePath || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      tableHtml += '<tr style="border-bottom:1px solid #222"><td style="padding:6px 8px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</td><td style="text-align:right;padding:6px 8px;white-space:nowrap;font-weight:600">' + formatSize(f.size) + '</td><td style="padding:6px 8px;color:#888;max-width:350px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + rp + '</td></tr>';
    }
    tableHtml += '</table>';

    const now = new Date().toLocaleString();
    const fp = (folderPathEl.textContent || 'Unknown').replace(/&/g, '&amp;').replace(/</g, '&lt;');

    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Stuff Diver Report</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f0f1a;color:#e0e4ea;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;max-width:900px;margin:0 auto}h1{font-size:24px;margin-bottom:4px;background:linear-gradient(135deg,#00b4d8,#7b5cff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.sub{color:#888;font-size:13px;margin-bottom:30px}.sec{margin-bottom:32px}h2{font-size:16px;margin-bottom:12px;color:#a0a8b8}.stats{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}.st{flex:1;min-width:120px;background:#1a1a2e;border:1px solid #2a2a3e;border-radius:10px;padding:14px 16px}.sn{font-size:22px;font-weight:700}.sl{font-size:11px;color:#888}.ca{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}.lg{flex:1;min-width:200px}.ft{margin-top:40px;padding-top:16px;border-top:1px solid #2a2a3e;font-size:11px;color:#555;text-align:center}</style></head><body>'
      + '<h1>Stuff Diver Report</h1><p class="sub">' + fp + ' &mdash; ' + now + '</p>'
      + '<div class="stats"><div class="st"><div class="sn">' + displayFiles.length.toLocaleString() + '</div><div class="sl">Files</div></div><div class="st"><div class="sn">' + formatSize(totalSz) + '</div><div class="sl">Total Size</div></div><div class="st"><div class="sn">' + sortedTypes.length + '</div><div class="sl">File Types</div></div><div class="st"><div class="sn">' + formatSize(totalSz / (displayFiles.length || 1)) + '</div><div class="sl">Avg File Size</div></div></div>'
      + '<div class="sec"><h2>Type Distribution</h2><div class="ca">' + pieSvg + '<div class="lg">' + legendHtml + '</div></div></div>'
      + '<div class="sec"><h2>Top 20 Largest Files</h2>' + tableHtml + '</div>'
      + '<div class="ft">Generated by Stuff Diver &mdash; File Explorer</div></body></html>';

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stuffdiver-report-' + new Date().toISOString().slice(0, 10) + '.html';
    a.click();
    URL.revokeObjectURL(url);
  }

  // === Feature: Smart Cleanup Wizard ===

  const CLEANUP_PATTERNS = [
    { id: 'node_modules', label: 'node_modules', match: function(p) { return /\/node_modules\//.test(p); }, icon: '📦' },
    { id: 'git', label: '.git directories', match: function(p) { return /\/\.git\//.test(p); }, icon: '🔀' },
    { id: 'cache', label: 'Caches', match: function(p) { return /\/(cache|\.cache|__pycache__|\.pytest_cache|\.npm|\.yarn)\//i.test(p); }, icon: '🗄' },
    { id: 'temp', label: 'Temp files', match: function(p) { return /\.(tmp|temp|swp|swo|bak)$/i.test(p); }, icon: '🕐' },
    { id: 'xcode', label: 'Xcode DerivedData', match: function(p) { return /\/DerivedData\//.test(p); }, icon: '🔨' },
    { id: 'build', label: 'Build artifacts', match: function(p) { return /\/(dist|\.next|\.nuxt|target|\.build)\//i.test(p); }, icon: '🏗' },
    { id: 'logs', label: 'Log files', match: function(p) { return /\.log$/i.test(p); }, icon: '📝' },
    { id: 'dsstore', label: '.DS_Store files', match: function(p) { return /\.DS_Store$/.test(p); }, icon: '👻' },
    { id: 'thumbs', label: 'Thumbnails & junk', match: function(p) { return /(Thumbs\.db|desktop\.ini|\.Spotlight|\.Trashes)/i.test(p); }, icon: '🗑' }
  ];

  function openCleanupWizard() {
    if (!allFiles.length) { alert('Please scan a folder first.'); return; }
    const overlay = document.getElementById('cleanup-overlay');
    overlay.classList.remove('hidden');

    const categories = CLEANUP_PATTERNS.map(function(p) { return { id: p.id, label: p.label, icon: p.icon, match: p.match, files: [], totalSize: 0 }; });
    for (const f of allFiles) {
      const rp = '/' + (f.relativePath || f.name);
      for (const cat of categories) {
        if (cat.match(rp)) { cat.files.push(f); cat.totalSize += f.size; break; }
      }
    }

    const found = categories.filter(function(c) { return c.files.length > 0; }).sort(function(a, b) { return b.totalSize - a.totalSize; });
    const body = document.getElementById('cleanup-body');

    if (!found.length) {
      body.innerHTML = '<div class="cleanup-empty">No reclaimable patterns found. Your folder looks clean!</div>';
      return;
    }

    const grandTotal = found.reduce(function(s, c) { return s + c.totalSize; }, 0);
    let html = '<div class="cleanup-total"><span class="cleanup-total-label">Total reclaimable space</span><span class="cleanup-total-size">' + formatSize(grandTotal) + '</span></div>';

    for (const cat of found) {
      html += '<div class="cleanup-category"><input type="checkbox" class="cleanup-check" data-id="' + cat.id + '" checked><span class="cleanup-icon">' + cat.icon + '</span><div class="cleanup-info"><div class="cleanup-name">' + cat.label + '</div><div class="cleanup-detail">' + cat.files.length.toLocaleString() + ' files</div></div><span class="cleanup-size">' + formatSize(cat.totalSize) + '</span></div>';
    }
    html += '<div class="cleanup-actions"><button class="cleanup-btn-clean" id="cleanup-execute">Clean Selected</button></div>';
    body.innerHTML = html;

    document.getElementById('cleanup-execute').addEventListener('click', async function() {
      const checks = body.querySelectorAll('.cleanup-check:checked');
      const selectedIds = new Set([...checks].map(function(c) { return c.dataset.id; }));
      const filesToDelete = [];
      for (const cat of found) {
        if (selectedIds.has(cat.id)) filesToDelete.push(...cat.files.map(function(f) { return f.path; }));
      }
      if (filesToDelete.length === 0) return;
      const result = await window.api.deleteFiles(filesToDelete);
      if (result && result.deleted > 0) {
        const deletedSet = new Set(result.deletedPaths || []);
        allFiles = allFiles.filter(function(f) { return !deletedSet.has(f.path); });
        applyFilters();
        openCleanupWizard();
      }
    });
  }

  function closeCleanupWizard() {
    document.getElementById('cleanup-overlay').classList.add('hidden');
  }

  // === Feature: Storage Forecast ===

  async function openForecast() {
    const overlay = document.getElementById('forecast-overlay');
    overlay.classList.remove('hidden');

    const folderPath = folderPathEl.textContent;
    const summary = document.getElementById('forecast-summary');
    const canvas = document.getElementById('forecast-chart');

    if (!folderPath || !allFiles.length) {
      summary.innerHTML = '<div class="forecast-empty">Please scan a folder first.</div>';
      canvas.style.display = 'none';
      return;
    }
    canvas.style.display = 'block';

    let diskInfo = null;
    try { diskInfo = await window.api.getDiskSpace(folderPath); } catch (e) {}

    const cached = await window.api.loadCache(folderPath);
    const currentTotal = allFiles.reduce(function(s, f) { return s + f.size; }, 0);
    const currentDate = Date.now();

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const ml = 70, mr = 20, mt = 20, mb = 40;
    const cw = W - ml - mr, ch = H - mt - mb;

    const isLight = document.body.classList.contains('light');
    const textColor = isLight ? '#333' : '#888';
    const gridColor = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
    const bgColor = isLight ? '#f8f9fa' : '#0d1220';
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    let dailyGrowth = 0, hasPreviousScan = false, prevDate = 0, prevTotal = 0;
    if (cached && cached.cachedAt && cached.totalSize) {
      prevDate = cached.cachedAt;
      prevTotal = cached.totalSize;
      const daysDiff = (currentDate - prevDate) / 86400000;
      if (daysDiff > 0) { dailyGrowth = (currentTotal - prevTotal) / daysDiff; hasPreviousScan = true; }
    }

    const totalCapacity = diskInfo ? diskInfo.total : currentTotal * 2;
    const projectionDays = 365;
    const xStart = hasPreviousScan ? prevDate : currentDate - 30 * 86400000;
    const xEnd = currentDate + projectionDays * 86400000;
    const yMax = totalCapacity * 1.1;

    function toX(t) { return ml + ((t - xStart) / (xEnd - xStart)) * cw; }
    function toY(v) { return mt + ch - (v / yMax) * ch; }

    // Grid
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = mt + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(W - mr, y); ctx.stroke();
      ctx.fillStyle = textColor; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(formatSize(yMax - (yMax / 4) * i), ml - 8, y + 4);
    }

    // X labels
    ctx.textAlign = 'center';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 0; i <= 4; i++) {
      const t = xStart + ((xEnd - xStart) / 4) * i;
      const d = new Date(t);
      ctx.fillText(months[d.getMonth()] + ' ' + d.getFullYear().toString().slice(2), toX(t), H - mb + 16);
    }

    // Capacity line
    if (diskInfo) {
      ctx.strokeStyle = '#f87171'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(ml, toY(totalCapacity)); ctx.lineTo(W - mr, toY(totalCapacity)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f87171'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('Drive Capacity: ' + formatSize(totalCapacity), ml + 4, toY(totalCapacity) - 6);
    }

    // Historical line
    const points = [];
    if (hasPreviousScan) points.push({ t: prevDate, v: prevTotal });
    points.push({ t: currentDate, v: currentTotal });

    ctx.strokeStyle = '#00b4d8'; ctx.lineWidth = 2.5; ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      if (i === 0) ctx.moveTo(toX(points[i].t), toY(points[i].v));
      else ctx.lineTo(toX(points[i].t), toY(points[i].v));
    }
    ctx.stroke();

    for (const p of points) {
      ctx.beginPath(); ctx.arc(toX(p.t), toY(p.v), 5, 0, Math.PI * 2);
      ctx.fillStyle = '#00b4d8'; ctx.fill();
      ctx.strokeStyle = bgColor; ctx.lineWidth = 2; ctx.stroke();
    }

    // Projection
    if (dailyGrowth > 0) {
      ctx.strokeStyle = '#7b5cff'; ctx.lineWidth = 2; ctx.setLineDash([8, 4]);
      ctx.beginPath(); ctx.moveTo(toX(currentDate), toY(currentTotal));
      ctx.lineTo(toX(xEnd), toY(Math.min(currentTotal + dailyGrowth * projectionDays, yMax * 1.2)));
      ctx.stroke(); ctx.setLineDash([]);
    }

    // Summary cards
    let cardsHtml = '<div class="forecast-cards">';
    cardsHtml += '<div class="forecast-card"><span class="forecast-num">' + formatSize(currentTotal) + '</span><span class="forecast-label">Current usage</span></div>';
    if (diskInfo) {
      const usedPct = ((diskInfo.total - diskInfo.available) / diskInfo.total * 100).toFixed(1);
      cardsHtml += '<div class="forecast-card"><span class="forecast-num">' + usedPct + '%</span><span class="forecast-label">Drive used (' + formatSize(diskInfo.total) + ')</span></div>';
    }
    if (hasPreviousScan && dailyGrowth > 0) {
      cardsHtml += '<div class="forecast-card"><span class="forecast-num">+' + formatSize(dailyGrowth * 30) + '</span><span class="forecast-label">Growth per month</span></div>';
      if (diskInfo) {
        const daysUntilFull = diskInfo.available / dailyGrowth;
        cardsHtml += '<div class="forecast-card"><span class="forecast-num ' + (daysUntilFull < 365 ? 'forecast-warning' : 'forecast-ok') + '">' + (daysUntilFull < 365 ? Math.round(daysUntilFull) + ' days' : (daysUntilFull / 365).toFixed(1) + ' years') + '</span><span class="forecast-label">Until drive is full</span></div>';
      }
    } else if (hasPreviousScan && dailyGrowth <= 0) {
      cardsHtml += '<div class="forecast-card"><span class="forecast-num forecast-ok">' + formatSize(Math.abs(dailyGrowth * 30)) + '</span><span class="forecast-label">Shrinking per month</span></div>';
    } else {
      cardsHtml += '<div class="forecast-card"><span class="forecast-num">—</span><span class="forecast-label">Need 2+ scans to forecast</span></div>';
    }
    cardsHtml += '</div>';
    summary.innerHTML = cardsHtml;
  }

  function closeForecast() {
    document.getElementById('forecast-overlay').classList.add('hidden');
  }

  // === Help Guide ===

  const HELP_GUIDE = [
    {
      category: 'Getting Started',
      icon: '&#127937;',
      entries: [
        { name: 'Select a folder', desc: 'Click <strong>Select Folder</strong> in the top-left (or click the splash logo) to choose a directory. Stuff Diver will recursively scan every file and build its visualisations.' },
        { name: 'Drag &amp; drop', desc: 'Drag a folder from your file manager and drop it anywhere on the app to start scanning it immediately.' },
        { name: 'Recent folders', desc: 'Your last 10 scanned folders appear on the splash screen for quick re-access.' },
        { name: 'Cached scans', desc: 'Scan results are cached automatically. Re-opening the same folder loads instantly. Clear the cache from the scan summary if files have changed.' },
        { name: 'Folder sidebar', desc: 'The left panel shows a collapsible folder tree with sizes, file counts, and modification dates. Click a folder to filter the visualisation. Drag the right edge to resize. Click the <strong>&#8693;</strong> button to toggle between sorting by size or name.' }
      ]
    },
    {
      category: 'Visualisation Views',
      icon: '&#128202;',
      entries: [
        { name: 'Treemap', desc: 'Rectangles sized by file size. The bigger the block, the bigger the file. Hover for details, click to select. Includes a hatched <strong>Free Space</strong> block showing available disk space for context.' },
        { name: 'Live scan animation', desc: 'When scanning a new folder, the treemap builds in real-time as files are discovered — you can watch the largest files appear and grow. A progress bar shows scan activity.' },
        { name: 'Treemap breadcrumbs', desc: 'When filtering to a subfolder, a breadcrumb trail appears at the top of the treemap. Click any segment to navigate back up the folder path.' },
        { name: 'Rings', desc: 'Concentric rings showing folder hierarchy. Click a ring segment to drill into that folder, click the centre or press <span class="help-kbd">Esc</span> to go back up.' },
        { name: 'Pie Chart', desc: 'Classic pie chart of the largest files. The legend shows every slice — click a legend item to select that file.' },
        { name: 'Bubbles', desc: 'Circle-packed view of folders and files. Click a bubble to drill into sub-folders. Breadcrumb trail at the top lets you navigate back.' },
        { name: 'Table', desc: 'Sortable file list with columns for name, path, size, type, and modified date. Click any column header to sort. Right-click rows for context menu.' },
        { name: 'Histogram', desc: 'Bar chart grouping files by size range (KB, MB, GB). Quickly spot whether your space is consumed by many small files or a few large ones.' },
        { name: 'Timeline', desc: 'Shows files plotted by modification date, so you can see when files were created or last changed.' }
      ]
    },
    {
      category: 'Colour Modes',
      icon: '&#127912;',
      entries: [
        { name: 'Age', desc: 'Colours files by how recently they were modified — green for recent, red/brown for old. Useful for spotting stale files.' },
        { name: 'Type', desc: 'Colours files by category — images, video, audio, documents, code, archives, data, and executables each get a distinct colour.' },
        { name: 'Folder', desc: 'Gives each top-level folder its own colour so you can see which folders dominate your disk.' }
      ]
    },
    {
      category: 'File Actions',
      icon: '&#128196;',
      entries: [
        { name: 'Detail bar', desc: 'Click any file to see its name, path, and size in the detail bar at the bottom. Actions appear on the right. Select multiple files with <span class="help-kbd">Cmd</span>/<span class="help-kbd">Ctrl</span>+click or <span class="help-kbd">Shift</span>+click to see combined size.' },
        { name: 'Open', desc: 'Opens the file with your system\'s default application.' },
        { name: 'Quick Look', desc: 'Triggers the OS native preview (macOS Quick Look, etc.).' },
        { name: 'Show in Finder', desc: 'Reveals the file in your system file manager (Finder on macOS, Explorer on Windows, etc.).' },
        { name: 'Inline preview', desc: 'Click the <strong>&#9650;</strong> arrow in the detail bar to expand an inline preview. Images, videos, audio, and code files preview directly in the app. Click again to collapse.' },
        { name: 'Right-click menu', desc: 'Right-click any file in the visualisation for a context menu with Open, Quick Look, Show in Finder, Add to Collector, Copy Path, Copy Size, and Tag options.' },
        { name: 'File tagging', desc: 'Tag files as <strong>Keep</strong> (green), <strong>Reviewed</strong> (blue), or <strong>Delete</strong> (red) via the Tag dropdown in the detail bar or the right-click menu. Tags are shown as coloured dots on treemap blocks and table rows. Tags persist between sessions.' }
      ]
    },
    {
      category: 'Collector & Deletion',
      icon: '&#128465;',
      entries: [
        { name: 'Add to Collector', desc: 'Click <strong>Add to Collector</strong> in the detail bar or right-click menu to stage files for deletion. The Collector panel appears at the bottom showing all staged files.' },
        { name: 'Collector panel', desc: 'Shows total item count and combined size. Use <strong>Clear</strong> to unstage everything, or <strong>Delete All</strong> to move all collected files to the system trash.' },
        { name: 'Safe deletion', desc: 'Files are moved to the system trash (Recycle Bin), not permanently deleted. You can always recover them.' }
      ]
    },
    {
      category: 'Duplicates',
      icon: '&#128257;',
      entries: [
        { name: 'Find Duplicates', desc: 'Click <strong>Find Duplicates</strong> in the toolbar. Files are hashed to detect exact matches. Progress is shown during hashing.' },
        { name: 'Tier system', desc: '<strong>Gold</strong> = exact duplicates (same hash), <strong>Silver</strong> = same name & similar size, <strong>Bronze</strong> = same name only. Filter by tier using the checkboxes.' },
        { name: 'Sorting', desc: 'Sort duplicate groups by tier, file count, size, or wasted space using the column headers.' },
        { name: 'Folder filter', desc: 'When duplicates are shown, the sidebar updates to display folders ranked by wasted space. Click a folder to filter duplicate groups to that location.' }
      ]
    },
    {
      category: 'Filter & Search',
      icon: '&#128269;',
      entries: [
        { name: 'Filter button', desc: 'Click <strong>Filter</strong> in the toolbar to show the filter bar. Set minimum/maximum file size, file type, and name search to narrow down displayed files.' },
        { name: 'Folder click', desc: 'Click any folder in the left sidebar to filter all views to only show files within that folder.' },
        { name: 'Locate-by-type', desc: 'In the filter bar, click the <strong>&#128269;</strong> icon on any type pill to see all folders containing that file type, sorted by size. Click a folder to navigate straight to it.' }
      ]
    },
    {
      category: 'Export & Reports',
      icon: '&#128190;',
      entries: [
        { name: 'Export CSV', desc: 'Click <strong>Export &#9662;</strong> &rarr; <strong>Export CSV</strong> to download a comma-separated file of all scanned files with name, path, size, type, and modified date.' },
        { name: 'Export HTML Report', desc: 'Click <strong>Export &#9662;</strong> &rarr; <strong>Export HTML Report</strong> to generate a self-contained HTML report with a pie chart, type breakdown, and top 20 largest files table.' },
        { name: 'Compare Scans', desc: 'Click <strong>Compare Scans</strong> to compare the current scan against a previous cached scan and see what files were added, removed, or changed.' },
        { name: 'Export Tags', desc: 'Click <strong>Export &#9662;</strong> &rarr; <strong>Export Tags Report</strong> to download a CSV of all tagged files grouped by tag. Perfect for tracking cleanup sessions.' }
      ]
    },
    {
      category: 'Tools',
      icon: '&#128736;',
      entries: [
        { name: 'Smart Cleanup', desc: 'Click the <strong>&#128736; Tools</strong> icon &rarr; <strong>Smart Cleanup</strong> to scan for reclaimable space: node_modules, .git directories, caches, temp files, build artifacts, logs, .DS_Store, and more. Check categories and clean with one click.' },
        { name: 'Storage Forecast', desc: 'Click <strong>&#128736; Tools</strong> &rarr; <strong>Storage Forecast</strong> to see a chart of your disk usage over time with a projected growth line. Shows estimated days until your drive is full.' },
        { name: 'Watch Folder', desc: 'Click <strong>&#128736; Tools</strong> &rarr; <strong>Watch Folder</strong> to monitor a folder for growth. Set a check interval (6h, daily, weekly) and get system notifications when significant growth is detected. A tray icon keeps the app running in the background.' },
        { name: 'Age warnings', desc: 'In the Summary panel, a warning highlights how many files haven\'t been modified in over a year. Click it to filter the view to just those old files.' }
      ]
    },
    {
      category: 'Appearance',
      icon: '&#127912;',
      entries: [
        { name: 'Dark / Light mode', desc: 'Click the <strong>moon/sun</strong> icon in the top-right to toggle between dark and light themes. Your preference is remembered.' },
        { name: 'Resizable sidebar', desc: 'Drag the right edge of the folder sidebar to make it wider or narrower. The visualisation adjusts automatically.' }
      ]
    },
    {
      category: 'Settings & Updates',
      icon: '&#9881;',
      entries: [
        { name: 'Settings', desc: 'Click the <strong>&#9881;</strong> gear icon to open settings and check for updates.' },
        { name: 'Auto-updates', desc: 'Stuff Diver checks for updates on launch. When an update is available, a banner appears at the top. Click <strong>View Details</strong> to download and install.' },
        { name: 'Manual update check', desc: 'In Settings, click <strong>Check for Updates</strong> to manually check. If available, download and restart to apply.' }
      ]
    },
    {
      category: 'Keyboard Shortcuts',
      icon: '&#9000;',
      entries: [
        { name: '<span class="help-kbd">Space</span>', desc: 'When a file is selected, opens Quick Look (native OS preview). Works in any view.' },
        { name: '<span class="help-kbd">Esc</span>', desc: 'Close any open modal, dropdown, or context menu. In Rings/Bubbles view, navigates back up one level.' },
        { name: '<span class="help-kbd">Backspace</span>', desc: 'In Rings or Bubbles view, navigate back up one folder level.' },
        { name: '<span class="help-kbd">&#8593;</span> / <span class="help-kbd">&#8595;</span>', desc: 'Navigate through files. In Table view, moves between rows. In other views, cycles through files by size.' },
        { name: '<span class="help-kbd">Enter</span>', desc: 'Opens the currently selected file with its default application.' },
        { name: '<span class="help-kbd">Cmd</span>/<span class="help-kbd">Ctrl</span>+Click', desc: 'Toggle-select multiple files. Detail bar shows combined size. Add all to Collector at once.' },
        { name: '<span class="help-kbd">Shift</span>+Click', desc: 'Range-select files in Table view — selects all files between the current and clicked file.' },
        { name: 'Right-click', desc: 'On any file in the visualisation — opens the context menu with quick actions.' }
      ]
    }
  ];

  function openHelpGuide() {
    document.getElementById('help-overlay').classList.remove('hidden');
    const search = document.getElementById('help-search');
    search.value = '';
    renderHelpGuide('');
    setTimeout(() => search.focus(), 50);
  }

  function closeHelpGuide() {
    document.getElementById('help-overlay').classList.add('hidden');
  }

  function renderHelpGuide(query) {
    const body = document.getElementById('help-body');
    const countEl = document.getElementById('help-section-count');
    const q = query.trim().toLowerCase();

    // filter entries
    let filtered = HELP_GUIDE.map(cat => {
      const entries = cat.entries.filter(e => {
        if (!q) return true;
        const text = (e.name + ' ' + e.desc).replace(/<[^>]+>/g, '').toLowerCase();
        return q.split(/\s+/).every(word => text.includes(word));
      });
      return { ...cat, entries };
    }).filter(cat => cat.entries.length > 0);

    let totalEntries = filtered.reduce((sum, c) => sum + c.entries.length, 0);
    countEl.textContent = q
      ? `${totalEntries} result${totalEntries !== 1 ? 's' : ''} found`
      : `${HELP_GUIDE.length} guide sections`;

    if (filtered.length === 0) {
      body.innerHTML = '<div class="help-no-results">No matching guide entries found.</div>';
      return;
    }

    let html = '';

    // show highlight cards only when no search
    if (!q) {
      html += `<div class="help-highlight-cards">
        <div class="help-highlight-card">
          <div class="help-highlight-card-title">Start Here</div>
          <p>Select a folder to scan, then switch between 7 visualisation views to explore your files.</p>
        </div>
        <div class="help-highlight-card">
          <div class="help-highlight-card-title">Good to Know</div>
          <p>Right-click any file for quick actions. Use the Collector to stage files for safe bulk deletion.</p>
        </div>
      </div>`;
    }

    for (const cat of filtered) {
      html += `<div class="help-category">`;
      html += `<div class="help-category-title"><span class="help-cat-icon">${cat.icon}</span> ${cat.category}</div>`;
      for (const entry of cat.entries) {
        html += `<div class="help-entry">
          <span class="help-entry-name">${entry.name}</span>
          <span class="help-entry-desc">${entry.desc}</span>
        </div>`;
      }
      html += `</div>`;
    }

    body.innerHTML = html;
  }

  // === Feature: Inline File Preview ===

  let previewExpanded = false;

  function togglePreviewExpand() {
    previewExpanded = !previewExpanded;
    detailPanel.classList.toggle('expanded', previewExpanded);
    document.getElementById('detail-preview').classList.toggle('hidden', !previewExpanded);
    if (previewExpanded && selectedFile) loadPreview(selectedFile);
  }

  async function loadPreview(file) {
    const content = document.getElementById('preview-content');
    if (!content || !previewExpanded) return;

    const cat = getFileCategory(file.ext);
    const ext = (file.ext || '').toLowerCase();

    if (cat === 'image') {
      try {
        const dataUrl = await window.api.readFilePreview(file.path, 5 * 1024 * 1024, true);
        if (dataUrl) {
          const img = document.createElement('img');
          img.src = dataUrl;
          content.innerHTML = '';
          content.appendChild(img);
        } else {
          content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext) + '</span><span>Image preview unavailable</span></div>';
        }
      } catch (e) {
        content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext) + '</span><span>Cannot preview</span></div>';
      }
    } else if (cat === 'video') {
      try {
        const dataUrl = await window.api.readFilePreview(file.path, 0, true);
        if (dataUrl) {
          const vid = document.createElement('video');
          vid.src = dataUrl;
          vid.controls = true;
          content.innerHTML = '';
          content.appendChild(vid);
        } else {
          content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext) + '</span><span>' + formatSize(file.size) + '</span></div>';
        }
      } catch (e) {
        content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext) + '</span><span>' + formatSize(file.size) + '</span></div>';
      }
    } else if (cat === 'audio') {
      try {
        const dataUrl = await window.api.readFilePreview(file.path, 0, true);
        if (dataUrl) {
          const aud = document.createElement('audio');
          aud.src = dataUrl;
          aud.controls = true;
          aud.style.width = '100%';
          content.innerHTML = '';
          content.appendChild(aud);
        } else {
          content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext) + '</span></div>';
        }
      } catch (e) {
        content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext) + '</span></div>';
      }
    } else if (cat === 'code' || cat === 'data' || ['txt','csv','tsv','log','md','ini','cfg','conf'].includes(ext)) {
      try {
        const text = await window.api.readFilePreview(file.path, 10240, false);
        if (text !== null) {
          const pre = document.createElement('pre');
          pre.textContent = text;
          content.innerHTML = '';
          content.appendChild(pre);
        } else {
          content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext) + '</span><span>Binary file</span></div>';
        }
      } catch (e) {
        content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext) + '</span><span>Preview failed</span></div>';
      }
    } else {
      content.innerHTML = '<div class="preview-info"><span class="preview-ext">' + escHtml(ext || '?') + '</span><span>' + formatSize(file.size) + '</span><span style="color:var(--text-faint)">' + escHtml(file.relativePath || file.path) + '</span></div>';
    }
  }

  // === Dropdown helpers ===

  function toggleDropdown(dropdownId) {
    const dd = document.getElementById(dropdownId);
    const wasHidden = dd.classList.contains('hidden');
    document.querySelectorAll('.toolbar-dropdown').forEach(function(d) { d.classList.add('hidden'); });
    if (wasHidden) dd.classList.remove('hidden');
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.toolbar-dropdown').forEach(function(d) { d.classList.add('hidden'); });
  }

  // === Settings & Update ===

  let dismissedUpdateVersion = null;
  let latestUpdateInfo = null;
  let updateReady = false;

  async function initVersionLabel() {
    const version = await window.api.getAppVersion();
    const el = document.getElementById('app-version');
    if (el) el.textContent = 'v' + version;
  }

  async function openSettings() {
    const overlay = document.getElementById('settings-overlay');
    overlay.classList.remove('hidden');
    const version = await window.api.getAppVersion();
    document.getElementById('settings-version').textContent = 'v' + version;
    await window.api.loadSettings();
    document.getElementById('settings-update-status').textContent = '';
    document.getElementById('settings-update-result').classList.add('hidden');
    document.getElementById('settings-download-progress').classList.add('hidden');
    document.getElementById('settings-download-btn').classList.remove('hidden');
    document.getElementById('settings-install-btn').classList.add('hidden');
    document.getElementById('settings-save-status').textContent = '';
    // If update already detected, show it
    if (latestUpdateInfo) {
      document.getElementById('settings-update-result').classList.remove('hidden');
      document.getElementById('settings-update-version').textContent = 'New version available: v' + latestUpdateInfo.version;
      document.getElementById('settings-update-notes').textContent = latestUpdateInfo.notes || '';
      if (updateReady) {
        document.getElementById('settings-download-btn').classList.add('hidden');
        document.getElementById('settings-install-btn').classList.remove('hidden');
      }
    }
  }

  function closeSettings() {
    document.getElementById('settings-overlay').classList.add('hidden');
  }

  async function saveSettingsFromModal() {
    const result = await window.api.saveSettings({});
    const statusEl = document.getElementById('settings-save-status');
    statusEl.textContent = result ? 'Saved!' : 'Error saving';
    statusEl.style.color = result ? '#4caf50' : '#f44336';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }

  async function checkForUpdatesFromSettings() {
    const statusEl = document.getElementById('settings-update-status');
    const resultEl = document.getElementById('settings-update-result');
    statusEl.textContent = 'Checking...';
    statusEl.style.color = 'var(--text-muted)';
    resultEl.classList.add('hidden');

    const result = await window.api.checkForUpdates();
    if (result.error) {
      statusEl.textContent = 'Could not check: ' + result.error;
      statusEl.style.color = '#f44336';
    }
    // The rest is handled by onUpdateStatus events
  }

  function handleUpdateStatus(data) {
    const statusEl = document.getElementById('settings-update-status');
    const resultEl = document.getElementById('settings-update-result');
    const progressEl = document.getElementById('settings-download-progress');
    const progressFill = document.getElementById('settings-progress-fill');
    const progressText = document.getElementById('settings-progress-text');
    const downloadBtn = document.getElementById('settings-download-btn');
    const installBtn = document.getElementById('settings-install-btn');

    switch (data.status) {
      case 'checking':
        statusEl.textContent = 'Checking for updates...';
        statusEl.style.color = 'var(--text-muted)';
        break;

      case 'available':
        statusEl.textContent = '';
        resultEl.classList.remove('hidden');
        document.getElementById('settings-update-version').textContent = 'New version available: v' + data.version;
        document.getElementById('settings-update-notes').textContent = data.notes || '';
        downloadBtn.classList.remove('hidden');
        installBtn.classList.add('hidden');
        progressEl.classList.add('hidden');
        latestUpdateInfo = data;
        showUpdateBanner(data);
        break;

      case 'up-to-date':
        statusEl.textContent = 'You\'re up to date! (v' + (data.version || 'unknown') + ')';
        statusEl.style.color = '#4caf50';
        break;

      case 'downloading':
        downloadBtn.classList.add('hidden');
        progressEl.classList.remove('hidden');
        progressFill.style.width = data.percent + '%';
        progressText.textContent = data.percent + '%';
        // Update banner text too
        document.getElementById('update-banner-text').textContent =
          'Downloading update... ' + data.percent + '%';
        break;

      case 'ready':
        updateReady = true;
        progressEl.classList.add('hidden');
        downloadBtn.classList.add('hidden');
        installBtn.classList.remove('hidden');
        statusEl.textContent = 'Update downloaded — ready to install!';
        statusEl.style.color = '#4caf50';
        // Update banner
        const banner = document.getElementById('update-banner');
        const bannerText = document.getElementById('update-banner-text');
        bannerText.textContent = 'Update v' + data.version + ' ready to install!';
        const detailsBtn = document.getElementById('update-banner-details');
        detailsBtn.textContent = 'Restart Now';
        detailsBtn.onclick = () => window.api.installUpdate();
        banner.classList.remove('hidden');
        break;

      case 'error':
        statusEl.textContent = 'Update error: ' + data.error;
        statusEl.style.color = '#f44336';
        downloadBtn.classList.remove('hidden');
        progressEl.classList.add('hidden');
        break;
    }
  }

  function showUpdateBanner(info) {
    if (dismissedUpdateVersion === info.version) return;
    const banner = document.getElementById('update-banner');
    const text = document.getElementById('update-banner-text');
    text.textContent = 'Update available: v' + info.version;
    const detailsBtn = document.getElementById('update-banner-details');
    detailsBtn.textContent = 'View Details';
    detailsBtn.onclick = openUpdateDetails;
    latestUpdateInfo = info;
    banner.classList.remove('hidden');
  }

  function dismissUpdateBanner() {
    const banner = document.getElementById('update-banner');
    banner.classList.add('hidden');
    if (latestUpdateInfo) dismissedUpdateVersion = latestUpdateInfo.version;
  }

  function openUpdateDetails() {
    openSettings();
  }

  async function startDownload() {
    const downloadBtn = document.getElementById('settings-download-btn');
    downloadBtn.classList.add('hidden');
    document.getElementById('settings-download-progress').classList.remove('hidden');
    document.getElementById('settings-progress-fill').style.width = '0%';
    document.getElementById('settings-progress-text').textContent = '0%';
    await window.api.downloadUpdate();
  }

  function installUpdate() {
    window.api.installUpdate();
  }

  async function silentUpdateCheck() {
    try {
      await window.api.checkForUpdates();
      // Results come via onUpdateStatus events
    } catch (e) {
      // Silent — don't bother user if offline
    }
  }

  // === Feature: Recent Folders ===

  async function loadRecentFolders() {
    const settings = await window.api.loadSettings();
    recentFolders = settings.recentFolders || [];
  }

  async function addRecentFolder(folder) {
    recentFolders = recentFolders.filter(f => f !== folder);
    recentFolders.unshift(folder);
    if (recentFolders.length > 10) recentFolders = recentFolders.slice(0, 10);
    const settings = await window.api.loadSettings();
    settings.recentFolders = recentFolders;
    await window.api.saveSettings(settings);
    renderRecentFolders();
  }

  function renderRecentFolders() {
    const emptyState = document.getElementById('empty-state-wrap');
    if (!emptyState || allFiles.length) return;
    let existing = document.getElementById('recent-folders');
    if (existing) existing.remove();
    if (!recentFolders.length) return;

    const container = document.createElement('div');
    container.id = 'recent-folders';
    container.className = 'recent-folders';
    container.innerHTML = '<div class="recent-title">Recent Folders</div>';

    for (const folder of recentFolders) {
      const row = document.createElement('div');
      row.className = 'recent-row';
      const parts = folder.replace(/\\/g, '/').split('/');
      row.innerHTML = `<span class="recent-icon">&#128194;</span><span class="recent-name">${escHtml(parts[parts.length - 1])}</span><span class="recent-path">${escHtml(folder)}</span>`;
      row.addEventListener('click', () => openFolderPath(folder));
      container.appendChild(row);
    }

    viz.appendChild(container);
  }

  // === Feature: Watch Folder Monitor ===

  let monitorSelectedFolder = null;

  async function openMonitorSetup() {
    const overlay = document.getElementById('monitor-overlay');
    overlay.classList.remove('hidden');
    // Load current status
    const status = await window.api.getMonitorStatus();
    monitorSelectedFolder = status.folder;
    document.getElementById('monitor-folder-path').textContent = status.folder ? status.folder : 'None selected';
    document.getElementById('monitor-interval').value = String(status.interval || 86400000);
    document.getElementById('monitor-enabled').checked = status.enabled;
    document.getElementById('monitor-status').textContent = '';
  }

  function closeMonitorSetup() {
    document.getElementById('monitor-overlay').classList.add('hidden');
  }

  async function saveMonitorSettings() {
    const enabled = document.getElementById('monitor-enabled').checked;
    const interval = parseInt(document.getElementById('monitor-interval').value);
    const statusEl = document.getElementById('monitor-status');

    if (enabled && !monitorSelectedFolder) {
      statusEl.textContent = 'Please select a folder first';
      statusEl.style.color = '#f44336';
      return;
    }

    if (enabled) {
      await window.api.startMonitor(monitorSelectedFolder, interval);
      statusEl.textContent = 'Monitoring started!';
      statusEl.style.color = '#4caf50';
    } else {
      await window.api.stopMonitor();
      statusEl.textContent = 'Monitoring stopped';
      statusEl.style.color = 'var(--text-muted)';
    }
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }

  // === Feature: Export Tags Report ===

  function exportTagsReport() {
    if (!Object.keys(fileTags).length) {
      alert('No files are tagged yet.');
      return;
    }
    const csvEscape = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = ['Tag,File,Path'];
    for (const [relPath, tags] of Object.entries(fileTags)) {
      const file = allFiles.find(f => (f.relativePath || f.path) === relPath);
      const name = file ? file.name : relPath.split('/').pop();
      for (const tag of tags) {
        lines.push(csvEscape(tag) + ',' + csvEscape(name) + ',' + csvEscape(relPath));
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stuffdiver-tags-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function init() {
    viz = document.getElementById('visualization');
    detailPanel = document.getElementById('detail-panel');
    detailName = document.getElementById('detail-name');
    detailPath = document.getElementById('detail-path');
    detailSize = document.getElementById('detail-size');
    actionOpen = document.getElementById('action-open');
    actionPreview = document.getElementById('action-preview');
    actionShow = document.getElementById('action-show');
    tooltip = document.getElementById('tooltip');
    loading = document.getElementById('loading');
    loadingText = document.getElementById('loading-text');
    statsEl = document.getElementById('stats');
    btnSelectFolder = document.getElementById('select-folder');
    btnTreemap = document.getElementById('view-treemap');
    btnPie = document.getElementById('view-pie');
    btnBubblemap = document.getElementById('view-bubblemap');
    btnDuplicates = document.getElementById('view-duplicates');
    btnRings = document.getElementById('view-rings');
    btnTable = document.getElementById('view-table');
    btnHistogram = document.getElementById('view-histogram');
    btnTimeline = document.getElementById('view-timeline');
    btnColorAge = document.getElementById('color-age');
    btnColorType = document.getElementById('color-type');
    btnColorFolder = document.getElementById('color-folder');
    folderPathEl = document.getElementById('folder-path');
    bubbleBreadcrumb = document.getElementById('bubble-breadcrumb');
    breadcrumbTrail = document.getElementById('breadcrumb-trail');
    folderPanel = document.getElementById('folder-panel');
    folderTreeEl = document.getElementById('folder-tree');

    // Resizable folder panel
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'folder-resize-handle';
    folderPanel.appendChild(resizeHandle);
    let resizing = false;
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizing = true;
      resizeHandle.classList.add('dragging');
      const onMove = (e2) => {
        if (!resizing) return;
        const newWidth = Math.max(200, Math.min(600, e2.clientX));
        folderPanel.style.width = newWidth + 'px';
      };
      const onUp = () => {
        resizing = false;
        resizeHandle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (displayFiles.length) renderVisualization();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Platform labels
    actionShow.textContent = getShowLabel();
    actionPreview.textContent = getPreviewLabel();

    // Events
    btnSelectFolder.addEventListener('click', handleSelectFolder);
    document.getElementById('empty-state-btn').addEventListener('click', handleSelectFolder);
    btnTreemap.addEventListener('click', () => setViewMode('treemap'));
    btnPie.addEventListener('click', () => setViewMode('pie'));
    btnBubblemap.addEventListener('click', () => setViewMode('bubblemap'));
    btnRings.addEventListener('click', () => setViewMode('rings'));
    btnTable.addEventListener('click', () => setViewMode('table'));
    btnHistogram.addEventListener('click', () => setViewMode('histogram'));
    btnTimeline.addEventListener('click', () => setViewMode('timeline'));
    btnDuplicates.addEventListener('click', () => setViewMode('duplicates'));
    // Export dropdown wired above in feature section
    document.getElementById('btn-compare').addEventListener('click', compareScan);
    document.getElementById('btn-filter').addEventListener('click', () => {
      filterBarOpen = !filterBarOpen;
      document.getElementById('btn-filter').classList.toggle('active', filterBarOpen);
      buildAdvancedSearch();
    });
    document.getElementById('cloud-filter').addEventListener('change', (e) => {
      cloudFilter = e.target.value;
      if (filterBarOpen) applyAdvancedFilters(); else applyFilters();
    });

    // Collector events
    document.getElementById('action-collect').addEventListener('click', () => {
      if (selectedFiles.length > 1) {
        for (const f of selectedFiles) addToCollector(f);
      } else if (selectedFile) addToCollector(selectedFile);
    });
    document.getElementById('collector-clear').addEventListener('click', clearCollector);
    document.getElementById('collector-delete').addEventListener('click', deleteCollectorItems);
    btnColorAge.addEventListener('click', () => setColorMode('age'));
    btnColorType.addEventListener('click', () => setColorMode('type'));
    btnColorFolder.addEventListener('click', () => setColorMode('folder'));
    document.getElementById('theme-toggle').addEventListener('click', () => {
      document.body.classList.toggle('light');
      if (displayFiles.length) renderVisualization();
    });

    actionOpen.addEventListener('click', () => { if (selectedFile) window.api.openFile(selectedFile.path); });
    actionPreview.addEventListener('click', () => { if (selectedFile) window.api.previewFile(selectedFile.path); });
    actionShow.addEventListener('click', () => { if (selectedFile) window.api.showInFolder(selectedFile.path); });

    // Click outside to deselect (bubble map handles its own SVG clicks)
    viz.addEventListener('click', (e) => {
      if (e.target === viz) {
        if ((viewMode === 'bubblemap' || viewMode === 'rings') && bubblePath.length > 0) {
          navigateBubble(bubblePath.slice(0, -1));
        } else {
          selectedFile = null;
          detailPanel.classList.remove('visible');
          renderVisualization();
        }
      }
    });

    // Keyboard: Escape/Backspace to go up in bubble view, Space for Quick Look
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === ' ' && selectedFile && !document.querySelector('.modal-overlay:not(.hidden)')) {
        e.preventDefault();
        window.api.previewFile(selectedFile.path);
        return;
      }
      if ((viewMode === 'bubblemap' || viewMode === 'rings') && bubblePath.length > 0 &&
          (e.key === 'Escape' || e.key === 'Backspace')) {
        e.preventDefault();
        navigateBubble(bubblePath.slice(0, -1));
      }
    });

    // Resize
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (displayFiles.length) renderVisualization();
      }, 150);
    });

    // Scan progress
    window.api.onScanProgress((data) => {
      loadingText.textContent = `Scanning... ${data.count.toLocaleString()} files found` +
        (data.skipped ? ` (${data.skipped} inaccessible)` : '');
    });

    // Duplicate progress
    window.api.onDuplicateProgress((data) => {
      loadingText.textContent = `Hashing files... ${data.hashed} / ${data.total}`;
    });

    // === Right-Click Context Menu ===
    viz.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const file = findFileFromTarget(e.target) || selectedFile;
      if (file) showContextMenu(e.clientX, e.clientY, file);
    });

    document.getElementById('context-menu').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (btn) handleContextAction(btn.dataset.action);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#context-menu')) hideContextMenu();
    });

    document.addEventListener('scroll', hideContextMenu, true);

    // === Export Dropdown ===
    document.getElementById('btn-export').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown('export-dropdown');
    });

    document.getElementById('export-dropdown').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-export]');
      if (!btn) return;
      if (btn.dataset.export === 'csv') exportCSV();
      else if (btn.dataset.export === 'html') exportHTMLReport();
      else if (btn.dataset.export === 'tags') exportTagsReport();
      closeAllDropdowns();
    });

    // === Tag Dropdown ===
    document.getElementById('action-tag').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown('tag-dropdown');
    });

    document.getElementById('tag-dropdown').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tag]');
      if (!btn || !selectedFile) return;
      toggleTag(selectedFile, btn.dataset.tag);
      closeAllDropdowns();
    });

    // === Tools Dropdown ===
    document.getElementById('tools-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown('tools-dropdown');
    });

    document.getElementById('tools-dropdown').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tool]');
      if (!btn) return;
      closeAllDropdowns();
      if (btn.dataset.tool === 'cleanup') openCleanupWizard();
      else if (btn.dataset.tool === 'forecast') openForecast();
      else if (btn.dataset.tool === 'monitor') openMonitorSetup();
    });

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.toolbar-dropdown-wrap')) closeAllDropdowns();
    });

    // === Cleanup Modal ===
    document.getElementById('cleanup-close').addEventListener('click', closeCleanupWizard);
    document.getElementById('cleanup-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'cleanup-overlay') closeCleanupWizard();
    });

    // === Forecast Modal ===
    document.getElementById('forecast-close').addEventListener('click', closeForecast);
    document.getElementById('forecast-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'forecast-overlay') closeForecast();
    });

    // === Watch Folder Modal ===
    document.getElementById('monitor-close').addEventListener('click', closeMonitorSetup);
    document.getElementById('monitor-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'monitor-overlay') closeMonitorSetup();
    });
    document.getElementById('monitor-save').addEventListener('click', saveMonitorSettings);
    document.getElementById('monitor-select-folder').addEventListener('click', async () => {
      const folder = await window.api.selectFolder();
      if (folder) {
        monitorSelectedFolder = folder;
        document.getElementById('monitor-folder-path').textContent = folder;
      }
    });

    // === Locate-by-Type Modal ===
    document.getElementById('locate-close').addEventListener('click', closeLocatePanel);
    document.getElementById('locate-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'locate-overlay') closeLocatePanel();
    });

    // === Inline File Preview ===
    document.getElementById('detail-expand').addEventListener('click', togglePreviewExpand);

    // === Help Guide ===
    document.getElementById('help-btn').addEventListener('click', openHelpGuide);
    document.getElementById('help-close').addEventListener('click', closeHelpGuide);
    document.getElementById('help-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'help-overlay') closeHelpGuide();
    });
    document.getElementById('help-search').addEventListener('input', (e) => {
      renderHelpGuide(e.target.value);
    });

    // Settings & Update
    initVersionLabel();
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'settings-overlay') closeSettings();
    });
    document.getElementById('settings-save').addEventListener('click', saveSettingsFromModal);
    document.getElementById('settings-check-update').addEventListener('click', checkForUpdatesFromSettings);
    document.getElementById('settings-download-btn').addEventListener('click', startDownload);
    document.getElementById('settings-install-btn').addEventListener('click', installUpdate);
    document.getElementById('update-banner-details').addEventListener('click', openUpdateDetails);
    document.getElementById('update-banner-dismiss').addEventListener('click', dismissUpdateBanner);

    // Listen for update status events from main process
    window.api.onUpdateStatus(handleUpdateStatus);

    // Escape closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!document.getElementById('help-overlay').classList.contains('hidden')) closeHelpGuide();
        else if (!document.getElementById('locate-overlay').classList.contains('hidden')) closeLocatePanel();
        else if (!document.getElementById('settings-overlay').classList.contains('hidden')) closeSettings();
        else if (!document.getElementById('cleanup-overlay').classList.contains('hidden')) closeCleanupWizard();
        else if (!document.getElementById('monitor-overlay').classList.contains('hidden')) closeMonitorSetup();
        else if (!document.getElementById('forecast-overlay').classList.contains('hidden')) closeForecast();
        hideContextMenu();
        closeAllDropdowns();
      }
    });

    // === Initial toolbar state ===
    updateToolbarState();

    // Restore last view mode (default: rings)
    (async function restoreViewMode() {
      const settings = await window.api.loadSettings();
      const saved = settings.lastViewMode;
      if (saved && saved !== 'duplicates' && saved !== viewMode) {
        viewMode = saved;
        lastChartMode = saved;
        btnTreemap.classList.toggle('active', saved === 'treemap');
        btnPie.classList.toggle('active', saved === 'pie');
        btnBubblemap.classList.toggle('active', saved === 'bubblemap');
        btnRings.classList.toggle('active', saved === 'rings');
        btnTable.classList.toggle('active', saved === 'table');
        btnHistogram.classList.toggle('active', saved === 'histogram');
        btnTimeline.classList.toggle('active', saved === 'timeline');
      }
    })();

    // === Folder Sort Toggle ===
    document.getElementById('folder-sort-toggle').addEventListener('click', () => {
      folderSortMode = folderSortMode === 'size' ? 'name' : 'size';
      document.getElementById('folder-sort-toggle').title = 'Sort: ' + (folderSortMode === 'size' ? 'By Size' : 'By Name');
      renderFolderTree();
    });

    // === Drag & Drop ===
    document.body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      document.body.classList.add('drag-over');
    });
    document.body.addEventListener('dragleave', (e) => {
      if (e.target === document.body || !document.body.contains(e.relatedTarget)) {
        document.body.classList.remove('drag-over');
      }
    });
    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const droppedPath = files[0].path;
        // Only accept directories
        openFolderPath(droppedPath);
      }
    });

    // === Keyboard Navigation ===
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!displayFiles.length) return;
        const curIdx = selectedFile ? displayFiles.findIndex(f => f.path === selectedFile.path) : -1;
        let nextIdx;
        if (e.key === 'ArrowDown') {
          nextIdx = curIdx < displayFiles.length - 1 ? curIdx + 1 : 0;
        } else {
          nextIdx = curIdx > 0 ? curIdx - 1 : displayFiles.length - 1;
        }
        selectFile(displayFiles[nextIdx], e);
        // Scroll table row into view
        if (viewMode === 'table') {
          const rows = viz.querySelectorAll('tbody tr');
          if (rows[nextIdx]) rows[nextIdx].scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Enter' && selectedFile) {
        e.preventDefault();
        window.api.openFile(selectedFile.path);
      }
    });

    // === Recent Folders ===
    loadRecentFolders().then(() => {
      if (!allFiles.length) renderRecentFolders();
    });

    // === Copy Size context menu ===
    // (handled via handleContextAction)

    // === Export Tags button in Export dropdown ===
    // (handled via export dropdown delegation)

    // Silent update check on launch
    silentUpdateCheck();
  }

  window.addEventListener('DOMContentLoaded', init);
})();
