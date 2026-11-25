'use strict';
// Quarantine for developer-folder cleanup: folders are MOVED (fs.rename on the same volume, never copy) into a hidden,
// dated per-run folder next to the user's files, with a manifest that makes "put it back" exact.
// Nothing here deletes anything: no code in this file removes anything. Purging a run is done by the caller
// by handing the run folder to the OS Trash.
// Everything that touches the outside world (fs, platform, protected-path rules) is injected so the Windows paths and
// failure modes can be unit-tested with stubs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QDIR = '.StuffDiverQuarantine';
const RETENTION_DAYS = 14;
const MANIFEST = 'manifest.json';
const RUN_RE = /^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{8}$/;
const MANIFEST_MAX_BYTES = 20 * 1024 * 1024;

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const isCi = (platform) => platform === 'win32' || platform === 'darwin';
const same = (a, b, ci) => (ci ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

// True for any path that is, or lies inside, a quarantine folder (any spelling of the name, so it is excluded on every filesystem).
function isQuarantinePath(p) {
  return String(p).replace(/\\/g, '/').split('/').some(s => s.toLowerCase() === QDIR.toLowerCase());
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function runDirName(d, runId) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${runId}`;
}
const newRunId = () => crypto.randomBytes(4).toString('hex');

// ---- choosing where an item goes (read-only: creates nothing) ----
// ctx: { platform, home, fsx, mounts(), rootOk(root) -> reason|null, uid }
// Returns { root } or { error } (the caller falls back to the OS Trash and says why).
function chooseRoot(itemPath, ctx) {
  const P = pathFor(ctx.platform);
  const fsx = ctx.fsx || fs;
  const notes = [];
  let itemDev;
  try { itemDev = fsx.lstatSync(itemPath, { bigint: true }).dev; } catch (e) { return { error: 'the folder cannot be read' }; }
  const candidates = [];
  if (ctx.platform === 'win32') {
    const d = /^([a-zA-Z]):[\\/]/.exec(itemPath);
    if (!d) return { error: 'it is not on a local drive letter (network paths are never quarantined)' };
    // Only fixed local disks: mapped network drives, removable drives and unknown types are never used.
    const kind = ctx.driveType ? ctx.driveType(d[1].toUpperCase()) : null;
    if (kind == null) return { error: `could not determine the drive type of ${d[1].toUpperCase()}: (${(ctx.driveTypeReason && ctx.driveTypeReason(d[1].toUpperCase())) || 'no answer'}), so it is moved to the Recycle Bin instead of quarantine` };
    if (kind !== 'Fixed') return { error: `drive ${d[1].toUpperCase()}: is not a fixed local disk (${kind}), so it is never used for quarantine` };
    const hd = /^([a-zA-Z]):/.exec(ctx.home || '');
    // System drive: inside the user's own profile folder, which keeps the profile's own inherited ACL (by design: no per-user
    // subfolder or extra ACL; default profiles grant only the user, SYSTEM and Administrators, but a profile with extra
    // principals would expose the quarantine to them too). Any other drive: its own top folder in a per-user subfolder
    // (every account on the machine shares that top folder), made private by an explicit ACL when created.
    if (hd && hd[1].toLowerCase() === d[1].toLowerCase()) candidates.push(P.join(ctx.home, QDIR));
    else candidates.push(P.join(d[1].toUpperCase() + ':\\' + QDIR, ctx.owner || ''));
  } else {
    candidates.push(P.join(ctx.home, QDIR));
    const mounts = ctx.mounts ? ctx.mounts() : null;
    if (Array.isArray(mounts)) {
      let real = itemPath;
      try { real = fsx.realpathSync(itemPath); } catch (e) { /* use the typed path */ }
      let best = null;
      for (const m of mounts) {
        if (!m || m === '/') continue;
        const pre = m.endsWith('/') ? m : m + '/';
        if ((real === m || real.startsWith(pre)) && (!best || m.length > best.length)) best = m;
      }
      if (best) candidates.push(P.join(best, QDIR, ctx.owner || ''));   // shared volume top: per-user subfolder
    }
  }
  for (const root of candidates) {
    const why = (ctx.rootOk ? ctx.rootOk(root) : null) || (ctx.platform !== 'win32' && ctx.volumeProblem ? ctx.volumeProblem(root) : null);
    if (why) { notes.push(`${root}: ${why}`); continue; }
    // Nearest existing ancestor decides the volume (the root itself may not exist yet).
    let probe = root, st = null;
    for (;;) {
      try { st = (probe === root ? fsx.lstatSync(probe, { bigint: true }) : fsx.statSync(probe, { bigint: true })); break; } catch (e) {
        const up = P.dirname(probe);
        if (up === probe) break;
        probe = up;
      }
    }
    if (!st) { notes.push(`${root}: no existing parent`); continue; }
    if (probe === root) {
      if (st.isSymbolicLink() || !st.isDirectory()) { notes.push(`${root}: is not a plain folder`); continue; }
      if (ctx.platform !== 'win32' && ctx.uid != null && Number(st.uid) !== ctx.uid) { notes.push(`${root}: belongs to another user`); continue; }
    }
    if (st.dev !== itemDev) { notes.push(`${root}: is on a different volume than the folder`); continue; }
    return { root, notes };
  }
  return { error: 'no safe location on the same volume' + (notes.length ? ' (' + notes.join('; ') + ')' : ''), notes };
}

// ---- manifest ----
function writeManifest(runDir, manifest, ctx) {
  const fsx = ctx.fsx || fs;
  const P = pathFor(ctx.platform);
  const finalP = P.join(runDir, MANIFEST);
  const tmp = P.join(runDir, MANIFEST + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  const c = fs.constants;
  // Unique name, O_EXCL (and no link following where the OS has O_NOFOLLOW): a planted link cannot redirect the write.
  const fd = fsx.openSync(tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o600);
  try { fsx.writeSync(fd, JSON.stringify(manifest, null, 1)); try { fsx.fsyncSync(fd); } catch (e) { /* best effort */ } } finally { fsx.closeSync(fd); }
  // Keep the previous good manifest as .bak: a crash between the two renames leaves .bak, which readRun falls back to.
  try { fsx.renameSync(finalP, P.join(runDir, MANIFEST + '.bak')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fsx.renameSync(tmp, finalP);
}

// Creates <root>/<run dir> and writes the manifest with every item `planned`. Throws on any problem (caller falls back to the Trash).
// plan: { root, runId, t, appVersion, scanRoot, source, items: [{ originalPath, originalRealPath, dev, size, files, category }] }
function createRun(plan, ctx) {
  const fsx = ctx.fsx || fs;
  const P = pathFor(ctx.platform);
  // A per-user folder on a shared volume top: the shared parent must stay traversable for other accounts (0755),
  // our own folder is private (0700 / explicit ACL, verified before use).
  const perUser = !!ctx.owner && P.basename(plan.root) === ctx.owner;
  if (perUser) fsx.mkdirSync(P.dirname(plan.root), { recursive: true, mode: 0o755 });
  fsx.mkdirSync(plan.root, { recursive: true, mode: 0o700 });
  const st = fsx.lstatSync(plan.root, { bigint: true });
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(plan.root + ' is not a plain folder');
  if (plan.expectDev != null && st.dev !== plan.expectDev) throw new Error(plan.root + ' is on a different volume');
  if (perUser && ctx.secureDir) ctx.secureDir(plan.root);   // throws when the folder cannot be made private to this account
  if (ctx.hide) { ctx.hide(plan.root); if (perUser) ctx.hide(P.dirname(plan.root)); }
  const dirName = runDirName(new Date(plan.t), plan.runId);
  const runDir = P.join(plan.root, dirName);
  fsx.mkdirSync(runDir, { mode: 0o700 });   // non-recursive: must not already exist
  const manifest = {
    version: 1, runId: plan.runId, t: plan.t, appVersion: plan.appVersion, platform: ctx.platform, source: plan.source || null,
    scanRoot: plan.scanRoot || null, root: plan.root, runDir, owner: ctx.owner || null,
    items: plan.items.map((it, i) => {
      const n = it.n != null ? it.n : i + 1;
      const name = P.basename(it.originalPath);
      return {
        n, name, originalPath: it.originalPath, originalRealPath: it.originalRealPath || it.originalPath, dev: String(it.dev),
        size: it.size, files: it.files, category: it.category, quarantinePath: P.join(runDir, String(n), name), status: 'planned'
      };
    })
  };
  writeManifest(runDir, manifest, ctx);
  return manifest;
}

// Moves ONE planned item into the quarantine. Rename only; throws on any failure and the item is then untouched.
function moveIn(manifest, item, ctx) {
  const fsx = ctx.fsx || fs;
  const P = pathFor(ctx.platform);
  const dir = P.join(manifest.runDir, String(item.n));
  fsx.mkdirSync(dir, { mode: 0o700 });
  try { fsx.lstatSync(item.quarantinePath); throw Object.assign(new Error('quarantine slot already exists'), { code: 'EEXIST' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  (ctx.rename || fsx.renameSync.bind(fsx))(item.originalPath, item.quarantinePath);
  item.status = 'quarantined';
  item.qt = Date.now();
  writeManifest(manifest.runDir, manifest, ctx);
}
// Records a non-quarantine outcome for an item (status 'trashed-fallback', 'failed' ...) in the manifest.
function setItemStatus(manifest, item, status, extra, ctx) {
  item.status = status;
  if (extra) Object.assign(item, extra);
  writeManifest(manifest.runDir, manifest, ctx);
}

// ---- reading runs back ----
function registryPath(userData) { return path.join(userData, 'quarantine-roots.json'); }
function readRegistry(userData, fsx = fs) {
  try {
    const a = JSON.parse(fsx.readFileSync(registryPath(userData), 'utf8'));
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.replace(/\\/g, '/').split('/').some(seg => seg === QDIR)) : [];
  } catch (e) { return []; }
}
function addRegistry(userData, root, fsx = fs) {
  const cur = readRegistry(userData, fsx);
  if (cur.some(r => r === root)) return;
  cur.push(root);
  const tmp = registryPath(userData) + '.tmp';
  fsx.writeFileSync(tmp, JSON.stringify(cur, null, 1));
  fsx.renameSync(tmp, registryPath(userData));
}

// Reads and validates one run folder. Never trusts the manifest: paths are recomputed from the run folder, name and item number.
// Falls back to manifest.json.bak when the main file is missing or corrupt. Parsed manifests are cached by size+mtime.
const manifestCache = new Map();
function loadManifestFile(fsx, mp) {
  const st = fsx.statSync(mp, { bigint: true });
  if (st.size > BigInt(MANIFEST_MAX_BYTES)) throw new Error('manifest too large');
  const key = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
  const hit = manifestCache.get(mp);
  if (hit && hit.key === key) return hit.m;
  const m = JSON.parse(fsx.readFileSync(mp, 'utf8'));
  if (manifestCache.size > 200) manifestCache.clear();
  manifestCache.set(mp, { key, m });
  return m;
}
function readRun(runDir, ctx) {
  const fsx = ctx.fsx || fs;
  const P = pathFor(ctx.platform);
  const base = P.basename(runDir);
  const out = { runDir, root: P.dirname(runDir), name: base, ok: false, items: [] };
  let m = null, usedBackup = false, err = null;
  const valid = (x) => x && typeof x === 'object' && Array.isArray(x.items) && RUN_RE.test(base) && base.endsWith('_' + x.runId);
  for (const [file, bak] of [[MANIFEST, false], [MANIFEST + '.bak', true]]) {
    try { const x = loadManifestFile(fsx, P.join(runDir, file)); if (valid(x)) { m = x; usedBackup = bak; break; } err = err || 'manifest does not belong to this folder'; }
    catch (e) { err = err || 'manifest unreadable (' + (e.code || e.message) + ')'; }
  }
  if (!m) { out.error = err; return out; }
  let ownerChanged = false;
  if (m.owner && ctx.owner && m.owner !== ctx.owner && !(ctx.legacyOwners || []).includes(m.owner)) {
    // In this account's OWN folder a different recorded owner means the account id changed (rename, new profile): list it, restore needs a confirmation.
    const own = P.basename(out.root) === ctx.owner || (ctx.home && same(out.root, P.join(ctx.home, QDIR), isCi(ctx.platform)));
    if (!own) { out.error = 'belongs to another user account'; out.foreign = true; return out; }
    ownerChanged = true;
  }
  const seen = new Set();
  for (const it of m.items) {
    if (!it || typeof it !== 'object' || !Number.isInteger(it.n) || it.n < 1 || seen.has(it.n)) continue;
    if (typeof it.originalPath !== 'string' || !it.originalPath || typeof it.name !== 'string') continue;
    const name = P.basename(it.originalPath);
    if (name !== it.name || !name || name === '.' || name === '..') continue;
    seen.add(it.n);
    out.items.push({ ...it, name, ownerChanged, quarantinePath: P.join(runDir, String(it.n), name) });   // recomputed, never taken from the file
  }
  out.ok = true;
  out.usedBackup = usedBackup;
  out.manifest = { ...m, root: out.root, runDir, items: out.items };
  out.runId = m.runId;
  out.t = Number(m.t) || 0;
  out.scanRoot = typeof m.scanRoot === 'string' ? m.scanRoot : null;
  return out;
}

// All runs, merged across roots (a run that spanned volumes has one folder per root). Newest first.
function listRuns(roots, ctx, now = Date.now()) {
  const fsx = ctx.fsx || fs;
  const P = pathFor(ctx.platform);
  const byRun = new Map();
  const broken = [];
  for (const root of [...new Set(roots)]) {
    let ents;
    try { ents = fsx.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || !RUN_RE.test(e.name)) continue;
      const r = readRun(P.join(root, e.name), ctx);
      if (!r.ok) { if (!r.foreign) broken.push({ runDir: r.runDir, name: e.name, error: r.error }); continue; }
      let run = byRun.get(r.runId);
      if (!run) { run = { runId: r.runId, t: r.t, scanRoot: r.scanRoot, dirs: [], items: [] }; byRun.set(r.runId, run); }
      run.dirs.push(r.runDir);
      let slots = new Set();
      try { slots = new Set(fsx.readdirSync(r.runDir)); } catch (er) { /* unreadable: nothing present */ }   // one readdir instead of one lstat per item
      for (const it of r.items) {
        // present = the item itself is there (an empty slot, e.g. after a crash or a folder dragged out by hand, is not)
        let present = false;
        if (slots.has(String(it.n))) {
          if (it.status === 'quarantined' || it.status === 'planned') { try { present = fsx.lstatSync(it.quarantinePath).isDirectory(); } catch (er) { present = false; } }
          else present = true;
        }
        run.items.push({ ...it, runDir: r.runDir, present, scanRoot: r.scanRoot });
      }
    }
  }
  const runs = [...byRun.values()].map(run => {
    run.items.sort((a, b) => a.n - b.n);
    const held = run.items.filter(i => i.present && (i.status === 'quarantined' || i.status === 'planned'));
    run.size = held.reduce((a, i) => a + (Number(i.size) || 0), 0);
    run.heldCount = held.length;
    run.expired = now - run.t > RETENTION_DAYS * 86400000;
    return run;
  }).sort((a, b) => b.t - a.t);
  return { runs, broken, totalSize: runs.reduce((a, r) => a + r.size, 0) };
}

// ---- restoring ----
// ctx adds: destReason(path) -> reason|null (protected, cloud, bundle, mount rules), inspect(dir) -> {files,bytes,error}, canRecreate(parent, scanRoot) -> bool
// opts: { beside, recreateParent }. Returns { ok:true, restoredTo } or { ok:false, state, reason, ... }. Never overwrites, merges or copies.
async function restoreItem(item, ctx, opts = {}) {
  const fsx = ctx.fsx || fs;
  const P = pathFor(ctx.platform);
  const ci = isCi(ctx.platform);
  const fail = (state, reason, extra) => ({ ok: false, state, reason, ...(extra || {}) });
  if (item.status === 'restored') return fail('done', 'already restored');
  if (item.status !== 'quarantined' && item.status !== 'planned') return fail('refused', `was not moved to quarantine (status: ${item.status})`);
  const q = item.quarantinePath;
  let qst;
  try { qst = fsx.lstatSync(q, { bigint: true }); } catch (e) {
    return item.status === 'planned' ? fail('never-moved', 'was never moved into quarantine (nothing to restore; it is still in its original place if it exists)')
      : fail('missing', 'is no longer in the quarantine folder (it was moved or removed outside Stuff Diver)');
  }
  if (qst.isSymbolicLink() || !qst.isDirectory()) return fail('mismatch', 'in quarantine is no longer a plain folder');
  if (String(qst.dev) !== String(item.dev)) return fail('mismatch', 'in quarantine is on a different volume than it was (cannot be put back by a rename)');
  // The slot and the item must be real folders at exactly runDir/n/name (a planted link must not redirect what is moved).
  if (item.runDir) {
    const slot = P.join(item.runDir, String(item.n));
    let sst;
    try { sst = fsx.lstatSync(slot); } catch (e) { return fail('missing', 'is no longer in the quarantine folder'); }
    if (sst.isSymbolicLink() || !sst.isDirectory()) return fail('refused', 'its quarantine slot is not a plain folder (a link was found); left untouched');
    try {
      const real = fsx.realpathSync.native || fsx.realpathSync;
      const expected = P.join(real(item.runDir), String(item.n), item.name);
      if (!same(real(q), expected, ci)) return fail('refused', 'its quarantine location resolves somewhere else than the run folder (a link was found); left untouched');
    } catch (e) { return fail('refused', 'its quarantine location cannot be resolved (' + (e.code || e.message) + ')'); }
  }
  if (item.ownerChanged && !opts.anyway) return fail('mismatch', 'was recorded for a different account id (the account may have been renamed or recreated); confirm to restore it anyway', { canRestoreAnyway: true });
  const orig = item.originalPath;
  if (isQuarantinePath(orig)) return fail('refused', 'was recorded inside a quarantine folder; restoring there is refused');
  const parent = P.dirname(orig);
  let pst = null;
  try { pst = fsx.statSync(parent, { bigint: true }); } catch (e) { pst = null; }
  let recreated = false;
  if (!pst) {
    const can = !!(ctx.canRecreate && ctx.canRecreate(parent, item.scanRoot));
    if (!opts.recreateParent) return fail('parent-missing', `the original parent folder ${parent} no longer exists`, { canRecreateParent: can });
    if (!can) return fail('refused', `the original parent folder ${parent} no longer exists and cannot be recreated safely (it is outside the folder you scanned, or protected)`);
    const real = fsx.realpathSync.native || fsx.realpathSync;
    const expectedReal = P.dirname(item.originalRealPath || orig);
    let anc = parent;
    while (!(() => { try { fsx.lstatSync(anc); return true; } catch (e) { return false; } })() && P.dirname(anc) !== anc) anc = P.dirname(anc);
    try {
      const realAnc = real(anc);
      // Checked BEFORE anything is created: the folders to create, appended to where `anc` really is, must be exactly where the folder was.
      const wouldBe = P.join(realAnc, P.relative(anc, parent));
      if (!same(wouldBe, expectedReal, ci)) return fail('refused', `${anc} now resolves to ${realAnc}, so recreating ${parent} would put it at ${wouldBe} instead of ${expectedReal} (a link changed); nothing was created`);
    } catch (e) { return fail('refused', `${anc} cannot be resolved (${e.code || e.message})`); }
    try {
      fsx.mkdirSync(parent, { recursive: true }); recreated = true; pst = fsx.statSync(parent, { bigint: true });
      if (!same(real(parent), expectedReal, ci)) return fail('refused', `${parent} was recreated but resolves to ${real(parent)} instead of ${expectedReal}; the folder was NOT put back`);
    } catch (e) { return fail('failed', `could not recreate ${parent} (${e.code || e.message})`); }
  }
  if (!pst.isDirectory()) return fail('refused', `${parent} is not a folder now`);
  if (!recreated) {
    let realParent = null;
    try { realParent = (fsx.realpathSync.native || fsx.realpathSync)(parent); } catch (e) { return fail('refused', `${parent} cannot be resolved (${e.code || e.message})`); }
    const wasParent = P.dirname(item.originalRealPath || orig);
    if (!same(realParent, wasParent, ci)) return fail('refused', `${parent} now resolves to ${realParent}, not ${wasParent} where it was (a link or mount changed)`);
  }
  if (String(pst.dev) !== String(item.dev)) return fail('refused', `${parent} is on a different volume than the quarantine (a rename cannot move it there)`);
  // Contents should still be what was moved in. A difference (a file written while the dialog was open, a dev server,
  // a .DS_Store) never makes restore impossible: the user can confirm "restore anyway". The location checks above and
  // the destination checks below still apply, and the rename never overwrites.
  if (!opts.anyway && ctx.inspect) {
    if (!Number.isFinite(item.files) || !Number.isFinite(item.size)) return fail('mismatch', 'has no size or file count recorded in the manifest, so its contents cannot be verified', { canRestoreAnyway: true });
    const w = await ctx.inspect(q);
    if (w.error) return fail('mismatch', 'in quarantine could not be verified (' + w.error + ')', { canRestoreAnyway: true });
    if (w.files !== item.files || w.bytes !== item.size) return fail('mismatch', `in quarantine differs from what was moved in (${w.files} files / ${w.bytes} bytes now, ${item.files} files / ${item.size} bytes recorded)`, { canRestoreAnyway: true, recorded: { files: item.files, bytes: item.size }, now: { files: w.files, bytes: w.bytes } });
  }
  let dest = orig;
  const exists = (p) => { try { fsx.lstatSync(p); return true; } catch (e) { return e.code !== 'ENOENT'; } };
  if (exists(dest)) {
    if (!opts.beside) return fail('exists', `${dest} already exists (never overwritten or merged)`, { canRestoreBeside: true });
    let n = 1;
    for (;;) {
      dest = P.join(parent, `${item.name} (restored${n > 1 ? ' ' + n : ''})`);
      if (!exists(dest)) break;
      if (++n > 99) return fail('refused', 'too many "(restored)" copies already exist next to it');
    }
  }
  const why = ctx.destReason ? ctx.destReason(dest) : null;
  if (why) return fail('refused', `cannot be put back: ${dest} is ${why}`);
  if (ctx.destAllowed && !ctx.destAllowed(dest, item.scanRoot) && opts.confirmDestination !== dest) {
    return fail('confirm-destination', `would be put back at ${dest}, which is outside the folder you scanned and any folder approved in this session. Confirm that exact destination to continue`, { canConfirmDestination: true, destination: dest });
  }
  if (exists(dest)) return fail('exists', `${dest} appeared just now (never overwritten)`, { canRestoreBeside: true });   // last look right before the rename
  try { (ctx.rename || fsx.renameSync.bind(fsx))(q, dest); } catch (e) {
    return fail('failed', `could not be moved back (${e.code || e.message}); nothing was copied and it is still in quarantine`);
  }
  return { ok: true, restoredTo: dest, beside: dest !== orig, recreatedParent: recreated };
}

// Marks an item restored in its run's manifest (written by the caller after restoreItem succeeded).
function markRestored(item, restoredTo, ctx) {
  const r = readRun(item.runDir, ctx);
  if (!r.ok) return false;
  const it = r.manifest.items.find(x => x.n === item.n);
  if (!it) return false;
  it.status = 'restored'; it.restoredTo = restoredTo; it.restoredAt = Date.now();
  writeManifest(r.runDir, r.manifest, ctx);
  return true;
}

// ---- Windows drive types ----
// 1. `fsutil fsinfo drivetype X:` answers in milliseconds without PowerShell (5 s limit, one process at a time).
// 2. If its output is not understood (localized Windows) or it fails, ONE .NET DriveInfo listing is used instead (10 s limit).
// 3. USB/SD/FireWire disks report as "Fixed"; the bus type is learned by a best-effort background check (15 s limit). It never
//    blocks the SYSTEM drive (Fixed there is enough); other drives stay "not allowed" until the bus type is known.
// A success is remembered per drive for the session; a failure only for 30 s, then the next cleanup retries.
const DRIVE_FAIL_MS = 30000;
const REMOVABLE_BUS = /^(USB|1394|SD|MMC|iSCSI)$/i;
function parseDriveList(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z])\|(Fixed|Removable|Network|CDRom|Ram|NoRootDirectory|Unknown)\|(.*)$/.exec(line.trim());
    if (m) out.set(m[1].toUpperCase(), m[2] === 'Fixed' && REMOVABLE_BUS.test(m[3].trim()) ? `Removable (${m[3].trim()} disk)` : m[2]);
  }
  return out;
}
// "C: - Fixed Drive", "D: - CD-ROM Drive", "E: - Removable Drive", "Z: - Remote/Network Drive", "RAM Disk"; anything else is not understood.
function parseFsutilDriveType(text) {
  const t = String(text);
  if (/-\s*Fixed\b/i.test(t)) return 'Fixed';
  if (/-\s*Removable\b/i.test(t)) return 'Removable';
  if (/-\s*Remote|Network/i.test(t)) return 'Network';
  if (/-\s*CD-?ROM/i.test(t)) return 'CDRom';
  if (/-\s*RAM/i.test(t)) return 'Ram';
  return null;
}
function parseBusList(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) { const m = /^([A-Za-z])\|(.*)$/.exec(line.trim()); if (m) out.set(m[1].toUpperCase(), m[2].trim()); }
  return out;
}
// opts: runFsutil(letter), runDotnet(), runBus() -> Promise<string> (reject on failure/timeout); systemDrive: 'C'; now().
function createDriveProbe(opts) {
  const now = opts.now || Date.now;
  const sys = (opts.systemDrive || 'C').toUpperCase();
  const known = new Map(), failed = new Map();
  let bus = null, busFailedAt = null, busRunning = false, busPromise = Promise.resolve();
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.then(() => {}, () => {}); return p; };   // never two probe processes at once
  const short = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 80);
  async function probeLetter(l) {
    let why = null;
    try { const t = parseFsutilDriveType(await opts.runFsutil(l)); if (t) return { type: t }; why = 'fsutil output not understood'; } catch (e) { why = short(e); }
    try { const t = parseDriveList(await opts.runDotnet()).get(l); if (t) return { type: t }; return { error: 'the drive is not listed by Windows' }; } catch (e) { return { error: `${why}; then ${short(e)}` }; }
  }
  const api = {
    async prefetch(paths) {
      const letters = [...new Set(paths.map(p => (/^([a-zA-Z]):[\\/]/.exec(p) || [])[1]).filter(Boolean).map(x => x.toUpperCase()))];
      for (const l of letters) {
        if (known.has(l) || (failed.has(l) && now() - failed.get(l).t < DRIVE_FAIL_MS)) continue;
        const r = await serial(() => probeLetter(l));
        if (r.type) { known.set(l, r.type); failed.delete(l); } else failed.set(l, { t: now(), reason: r.error });
      }
      if (letters.some(l => l !== sys && known.get(l) === 'Fixed')) api.startBusCheck();   // needed for non-system disks only
    },
    // Best effort, in the background (also called once at app start). Retried after a failure once 30 s have passed.
    startBusCheck() {
      if (busRunning) return busPromise;
      if (bus || (busFailedAt !== null && now() - busFailedAt < DRIVE_FAIL_MS) || !opts.runBus) return Promise.resolve();
      busRunning = true;
      busPromise = serial(async () => {
        try { bus = parseBusList(await opts.runBus()); busFailedAt = null; } catch (e) { busFailedAt = now(); }
        busRunning = false;
      });
      return busPromise;
    },
    type(l) {
      const t = known.get(l);
      if (!t) return null;
      if (t !== 'Fixed' || l === sys) return t;          // the system drive is never held up by the bus check
      if (!bus) return null;                              // other disks: not allowed until the bus type is known
      const b = bus.get(l) || '';
      return REMOVABLE_BUS.test(b) ? `Removable (${b} disk)` : 'Fixed';
    },
    reason(l) {
      if (known.get(l) === 'Fixed' && l !== sys && !bus) return busRunning ? 'the check for USB/SD media is still running' : 'the check for USB/SD media has not completed' + (busFailedAt !== null ? ' (it failed; retried automatically)' : '');
      return (failed.get(l) || {}).reason || null;
    }
  };
  return api;
}

module.exports = { parseDriveList, parseFsutilDriveType, parseBusList, createDriveProbe, DRIVE_FAIL_MS, QDIR, RETENTION_DAYS, MANIFEST, RUN_RE, isQuarantinePath, runDirName, newRunId, chooseRoot, createRun, moveIn, setItemStatus, writeManifest, readRun, listRuns, restoreItem, markRestored, readRegistry, addRegistry, registryPath };
