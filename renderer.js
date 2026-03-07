(function () {
  'use strict';

  // === Constants ===
  const MAX_TREEMAP = 200;
  const MAX_PIE = 20;
  const GAP = 2;

  const EXT_COLORS = {
    image: '#4caf50',
    video: '#f44336',
    audio: '#ff9800',
    document: '#2196f3',
    code: '#c6a700',
    archive: '#9c27b0',
    data: '#00bcd4',
    executable: '#e91e63',
    default: '#607d8b'
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
  let viewMode = 'treemap';
  let lastChartMode = 'treemap';
  let totalFiles = 0;
  let totalSize = 0;
  let skippedDirs = 0;
  let duplicateResults = null; // null = not scanned, [] = scanned
  let colorMode = 'type';
  let folderTree = null;       // hierarchical tree from scan
  let bubblePath = [];         // current drill-down path segments
  let bubbleCurrentNode = null; // current tree node being displayed

  // === DOM ===
  let viz, detailPanel, detailName, detailPath, detailSize;
  let actionOpen, actionPreview, actionShow;
  let tooltip, loading, loadingText, statsEl;
  let btnSelectFolder, btnTreemap, btnPie, btnBubblemap, btnRings, btnDuplicates, folderPathEl;
  let bubbleBreadcrumb, breadcrumbTrail;
  let folderPanel, folderTreeEl;

  // === Utilities ===

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
    '#e6194b','#3cb44b','#4363d8','#f58231','#911eb4',
    '#42d4f4','#f032e6','#bfef45','#fabed4','#469990',
    '#dcbeff','#9A6324','#800000','#aaffc3','#808000',
    '#000075','#e6beff','#aa6e28','#fffac8','#a9a9a9'
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
    return folderColorMap.get(getTopFolder(file)) || '#607d8b';
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
    return { min, max };
  }

  function getColorByAge(file) {
    if (!ageRange) ageRange = buildAgeRange(displayFiles);
    if (!file.mtime || ageRange.max === ageRange.min) return '#607d8b';
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
    const files = displayFiles.slice(0, MAX_TREEMAP).filter(f => f.size > 0);
    if (!files.length) { renderEmpty('No files found'); return; }

    const rect = { x: 0, y: 0, w: viz.clientWidth, h: viz.clientHeight };
    if (rect.w < 10 || rect.h < 10) return;

    const blocks = computeTreemap(files, rect);

    for (const b of blocks) {
      const el = document.createElement('div');
      el.className = 'treemap-block' + (selectedFile && selectedFile.path === b.path ? ' selected' : '');
      el.style.left = (b.x + GAP / 2) + 'px';
      el.style.top = (b.y + GAP / 2) + 'px';
      el.style.width = Math.max(0, b.w - GAP) + 'px';
      el.style.height = Math.max(0, b.h - GAP) + 'px';
      el.style.backgroundColor = getBlockColor(b);

      const bw = b.w - GAP;
      const bh = b.h - GAP;

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

      el.addEventListener('click', () => selectFile(b));
      el.addEventListener('dblclick', () => window.api.openFile(b.path));
      el.addEventListener('mouseenter', (e) => showTooltip(e, b));
      el.addEventListener('mousemove', moveTooltip);
      el.addEventListener('mouseleave', hideTooltip);

      viz.appendChild(el);
    }
  }

  // === Rendering: Pie Chart ===

  function renderPieChart() {
    viz.innerHTML = '';
    const files = displayFiles.filter(f => f.size > 0);
    if (!files.length) { renderEmpty('No files found'); return; }

    const container = document.createElement('div');
    container.className = 'pie-container';

    const svgWrap = document.createElement('div');
    svgWrap.className = 'pie-svg-wrap';

    const legend = document.createElement('div');
    legend.className = 'pie-legend';

    const w = Math.floor(viz.clientWidth * 0.55);
    const h = viz.clientHeight;
    const radius = Math.min(w, h) * 0.4;
    const cx = w / 2;
    const cy = h / 2;

    const topFiles = files.slice(0, MAX_PIE);
    const otherSize = files.slice(MAX_PIE).reduce((s, f) => s + f.size, 0);
    const items = [...topFiles];
    if (otherSize > 0) {
      items.push({ name: `Other (${files.length - MAX_PIE} files)`, size: otherSize, ext: '', path: '', relativePath: '' });
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
      const isOther = !file.path;
      const color = isOther ? '#8d6e99' : getBlockColor(file);

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
      path.setAttribute('stroke', '#0f0f1a');
      path.setAttribute('stroke-width', '2');
      path.classList.add('pie-slice');

      path.addEventListener('click', () => { if (file.path) selectFile(file); });
      path.addEventListener('mouseenter', (e) => { if (file.path) showTooltip(e, file); });
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
      if (file.path) {
        item.addEventListener('click', () => selectFile(file));
      }
      legend.appendChild(item);
    });

    svgWrap.appendChild(svg);
    container.appendChild(svgWrap);
    container.appendChild(legend);
    viz.appendChild(container);
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
        <p>Scan the ${displayFiles.length} largest files for duplicates</p>
        <p style="font-size:12px;color:#666">Compares file content using SHA-256 hashing</p>
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

    // Summary
    const goldCount = duplicateResults.filter(g => g.tier === 'gold').length;
    const silverCount = duplicateResults.filter(g => g.tier === 'silver').length;
    const bronzeCount = duplicateResults.filter(g => g.tier === 'bronze').length;
    const totalWasted = duplicateResults.reduce((s, g) => s + g.wasted, 0);
    const totalDupFiles = duplicateResults.reduce((s, g) => s + g.files.length, 0);

    const summary = document.createElement('div');
    summary.className = 'dup-summary';
    summary.innerHTML = `
      <span>Groups: <span class="stat-value">${duplicateResults.length}</span></span>
      <span>Files: <span class="stat-value">${totalDupFiles}</span></span>
      <span>Wasted: <span class="stat-value" style="color:#f44336">${formatSize(totalWasted)}</span></span>
      ${goldCount ? `<span><span class="dup-tier gold" style="display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span> Exact: <span class="stat-value">${goldCount}</span></span>` : ''}
      ${silverCount ? `<span><span class="dup-tier silver" style="display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span> Likely: <span class="stat-value">${silverCount}</span></span>` : ''}
      ${bronzeCount ? `<span><span class="dup-tier bronze" style="display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span> Possible: <span class="stat-value">${bronzeCount}</span></span>` : ''}
    `;
    container.appendChild(summary);

    const showLabel = getShowLabel();
    const previewLabel = getPreviewLabel();

    for (const group of duplicateResults) {
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
      duplicateResults = await window.api.findDuplicates(allFiles);
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
    const targetArea = 0.60 * width * height;
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
      return folderColorMap.get(topFolder) || '#607d8b';
    }
    if (colorMode === 'age') {
      if (!ageRange) ageRange = buildAgeRange(displayFiles);
      if (!node.mtime || ageRange.max === ageRange.min) return '#607d8b';
      const t = (node.mtime - ageRange.min) / (ageRange.max - ageRange.min);
      const hue = (1 - t) * 220 + t * 10;
      return `hsl(${hue}, ${50 + t * 20}%, ${35 + t * 15}%)`;
    }
    return '#607d8b';
  }

  function navigateBubble(pathSegments) {
    bubblePath = pathSegments;
    let node = folderTree;
    for (const seg of pathSegments) {
      if (node.children && node.children[seg]) {
        node = node.children[seg];
      }
    }
    bubbleCurrentNode = node;
    updateBreadcrumb();
    highlightFolderTree();
    if (viewMode === 'rings') renderRingsChart();
    else renderBubbleMap();
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
    tooltip.innerHTML = `
      <strong>${item.name}/</strong><br>
      <span class="tip-path">${item.path || '(root)'}</span><br>
      <span class="tip-size">${formatSize(item.size)}</span>
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
      if (child.size <= 0) continue;
      items.push({
        size: child.size,
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
    const maxRadius = Math.min(w, h) * 0.45;
    const MAX_DEPTH = 5;
    const MIN_ANGLE = 0.008; // ~0.46 degrees
    const RING_GAP = 1.5;

    const centerRadius = maxRadius * 0.20;
    const ringWidth = (maxRadius - centerRadius) / MAX_DEPTH;

    // Build arc data recursively
    const arcs = [];

    function buildArcs(node, depth, startAngle, endAngle) {
      if (depth > MAX_DEPTH) return;
      if (!node.children) return;

      const children = Object.values(node.children)
        .filter(c => c.size > 0)
        .sort((a, b) => b.size - a.size);

      if (!children.length) return;

      let currentAngle = startAngle;

      for (const child of children) {
        const childSpan = (child.size / node.size) * (endAngle - startAngle);
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
    centerCircle.setAttribute('fill', '#1a1a2e');
    centerCircle.setAttribute('stroke', '#2a2a4a');
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
    centerSize.setAttribute('fill', '#00b4d8');
    centerSize.setAttribute('font-size', Math.min(11, centerRadius / 5));
    centerSize.setAttribute('font-weight', '600');
    centerSize.setAttribute('filter', 'url(#rings-shadow)');
    centerSize.textContent = formatSize(rootNode.size);
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
        size: rootNode.size,
        fileCount: rootNode.fileCount
      });
    });
    centerGroup.addEventListener('mousemove', moveTooltip);
    centerGroup.addEventListener('mouseleave', () => {
      centerCircle.setAttribute('fill', '#1a1a2e');
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
      path.setAttribute('stroke', '#0f0f1a');
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

  function renderFolderTree() {
    if (!folderTreeEl || !folderTree) return;
    folderTreeEl.innerHTML = '';

    const parentSize = folderTree.size || 1;

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
    rootSize.textContent = formatSize(folderTree.size);

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
        if (viewMode !== 'bubblemap' && viewMode !== 'rings') {
          lastChartMode = 'rings';
          viewMode = 'rings';
          btnTreemap.classList.remove('active');
          btnPie.classList.remove('active');
          btnRings.classList.add('active');
        }
        navigateBubble([]);
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
      .filter(c => c.size > 0)
      .sort((a, b) => b.size - a.size);

    for (const child of children) {
      const hasChildren = child.children && Object.values(child.children).some(c => c.size > 0);
      const pct = rootSize > 0 ? (child.size / rootSize) * 100 : 0;
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
      size.textContent = formatSize(child.size);

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
          // If in treemap/pie, switch to rings for folder exploration
          if (viewMode !== 'bubblemap' && viewMode !== 'rings') {
            lastChartMode = 'rings';
            viewMode = 'rings';
            btnTreemap.classList.remove('active');
            btnPie.classList.remove('active');
            btnRings.classList.add('active');
          }
          navigateBubble(child.path.split('/'));
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
    const currentPath = bubblePath.join('/');
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

  // === Rendering: Common ===

  function renderVisualization() {
    if (viewMode !== 'bubblemap' && viewMode !== 'rings') {
      bubbleBreadcrumb.classList.add('hidden');
    }
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
    if (viewMode === 'treemap') {
      renderTreemap();
    } else {
      renderPieChart();
    }
  }

  function renderEmpty(msg) {
    viz.innerHTML = `<div class="empty-state"><p>${msg}</p></div>`;
  }

  function updateStats() {
    statsEl.innerHTML = `
      <span>Files: <span class="stat-value">${totalFiles.toLocaleString()}</span></span>
      <span>Total size: <span class="stat-value">${formatSize(totalSize)}</span></span>
      <span>Showing top: <span class="stat-value">${Math.min(displayFiles.length, viewMode === 'treemap' ? MAX_TREEMAP : displayFiles.length).toLocaleString()}</span></span>
      ${skippedDirs ? `<span>Inaccessible: <span class="stat-value">${skippedDirs.toLocaleString()}</span></span>` : ''}
    `;
    statsEl.classList.remove('hidden');
  }

  function selectFile(file) {
    if (!file || !file.path) return;
    selectedFile = file;
    detailName.textContent = file.name;
    detailPath.textContent = file.relativePath;
    detailSize.textContent = file.logicalSize && file.logicalSize !== file.size
      ? `${formatSize(file.size)} on disk (${formatSize(file.logicalSize)} logical)`
      : formatSize(file.size);
    detailPanel.classList.add('visible');
    renderVisualization();
  }

  // === Tooltip ===

  function showTooltip(e, file) {
    const sizeInfo = file.logicalSize && file.logicalSize !== file.size
      ? `<span class="tip-size">${formatSize(file.size)} on disk</span> <span class="tip-path">(${formatSize(file.logicalSize)} logical)</span>`
      : `<span class="tip-size">${formatSize(file.size)}</span>`;
    tooltip.innerHTML = `
      <strong>${file.name}</strong><br>
      <span class="tip-path">${file.relativePath}</span><br>
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

  async function handleSelectFolder() {
    const folder = await window.api.selectFolder();
    if (!folder) return;

    folderPathEl.textContent = folder;
    selectedFile = null;
    detailPanel.classList.remove('visible');
    loading.classList.remove('hidden');
    loadingText.textContent = 'Diving in...';

    try {
      const result = await window.api.scanFolder(folder);
      allFiles = result.files;
      displayFiles = allFiles;
      totalFiles = result.totalFiles;
      totalSize = result.totalSize;
      skippedDirs = result.skippedDirs || 0;
      duplicateResults = null;
      folderColorMap = null;
      ageRange = null;
      folderTree = result.folderTree || null;
      bubblePath = [];
      bubbleCurrentNode = folderTree;
      updateStats();
      if (folderTree) {
        folderPanel.classList.remove('hidden');
        renderFolderTree();
      }
      renderVisualization();
    } catch (err) {
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
    }
    btnTreemap.classList.toggle('active', viewMode === 'treemap');
    btnPie.classList.toggle('active', viewMode === 'pie');
    btnBubblemap.classList.toggle('active', viewMode === 'bubblemap');
    btnRings.classList.toggle('active', viewMode === 'rings');
    btnDuplicates.classList.toggle('active', viewMode === 'duplicates');
    if (viewMode === 'duplicates') {
      detailPanel.classList.remove('visible');
    }
    if ((viewMode === 'bubblemap' || viewMode === 'rings') && !bubbleCurrentNode && folderTree) {
      bubblePath = [];
      bubbleCurrentNode = folderTree;
    }
    renderVisualization();
  }

  // === Init ===

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
    folderPathEl = document.getElementById('folder-path');
    bubbleBreadcrumb = document.getElementById('bubble-breadcrumb');
    breadcrumbTrail = document.getElementById('breadcrumb-trail');
    folderPanel = document.getElementById('folder-panel');
    folderTreeEl = document.getElementById('folder-tree');

    // Platform labels
    actionShow.textContent = getShowLabel();
    actionPreview.textContent = getPreviewLabel();

    // Events
    btnSelectFolder.addEventListener('click', handleSelectFolder);
    btnTreemap.addEventListener('click', () => setViewMode('treemap'));
    btnPie.addEventListener('click', () => setViewMode('pie'));
    btnBubblemap.addEventListener('click', () => setViewMode('bubblemap'));
    btnRings.addEventListener('click', () => setViewMode('rings'));
    btnDuplicates.addEventListener('click', () => setViewMode('duplicates'));

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

    // Keyboard: Escape/Backspace to go up in bubble view
    document.addEventListener('keydown', (e) => {
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
  }

  window.addEventListener('DOMContentLoaded', init);
})();
