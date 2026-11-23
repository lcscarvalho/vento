import { createColorWheel } from './colorwheel.js?v=202611230154';
import { readImage, fmtBytes, previewSize } from './images.js?v=202611230154';
import { createBook } from './book.js?v=202611230154';
import { renderSheets, sheetPixels, zipStore, downloadBlob } from './export.js?v=202611230154';
import * as db from './store.js?v=202611230154';

// All internal measurements are in millimetres. On screen: px = mm × scale.
const DPI = 300;
const PAD = 160;                 // desk margin around the sheets (px)
const MM_PX = 96 / 25.4;         // 100% zoom = actual size
const PRESETS = [
  ['10x15', 100, 150, '10 × 15 cm'],
  ['13x18', 130, 180, '13 × 18 cm'],
  ['15x21', 150, 210, '15 × 21 cm'],
  ['20x20', 200, 200, '20 × 20 cm'],
  ['20x30', 200, 300, '20 × 30 cm'],
  ['a4', 210, 297, 'A4 · 21 × 29,7 cm'],
  ['30x30', 300, 300, '30 × 30 cm'],
  ['a3', 297, 420, 'A3 · 29,7 × 42 cm'],
  ['10x50', 100, 500, '10 × 50 cm'],
];
const DEFAULTS = { w: 200, h: 300, count: 2, layout: 'row', bg: '#FFFFFF', cuts: true, format: 'jpg', cover: 'plain', items: [] };
const CORNERS = ['nw', 'ne', 'se', 'sw'];
const ALL_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const S = structuredClone(DEFAULTS);
const assets = new Map();        // id -> { id, name, size, file, preview, previewUrl, nw, nh }
const nodes = new Map();         // itemId -> { c, g } (clipped node + faded "ghost" outside the sheet)
let scale = 1;
let sel = null;
let cropMode = false;
let drag = null;
let exporting = false;
let wheel;

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (mm, d = 1) => (mm / 10).toLocaleString('en-US', { maximumFractionDigits: d });
const parseCm = (s) => {
  const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v * 10 : null;
};
const getItem = (id) => S.items.find((i) => i.id === id);
const getSel = () => (sel ? getItem(sel) : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function geo() {
  const { w, h, count: n } = S;
  const row = S.layout === 'row';
  return { w, h, n, row, W: row ? w * n : w, H: row ? h : h * n };
}
function sheetRect(i, g = geo()) {
  return g.row ? { x: i * g.w, y: 0, w: g.w, h: g.h } : { x: 0, y: i * g.h, w: g.w, h: g.h };
}
const sheetRects = (g = geo()) => Array.from({ length: g.n }, (_, i) => sheetRect(i, g));

function effDpi(it, a) {
  if (!a) return 0;
  return 25.4 / Math.max(it.w / a.nw, it.h / a.nh);
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = kind), kind === 'error' ? 6000 : 3200);
}

// ---------- history (undo/redo) ----------
const hist = { past: [], future: [] };
let lastSnap = '';
const snapshot = () =>
  JSON.stringify({ w: S.w, h: S.h, count: S.count, layout: S.layout, bg: S.bg, items: S.items });

function commit() {
  const s = snapshot();
  if (s === lastSnap) return;
  hist.past.push(lastSnap);
  if (hist.past.length > 200) hist.past.shift();
  hist.future = [];
  lastSnap = s;
  scheduleSave();
  renderControls();
}
function restore(str) {
  Object.assign(S, JSON.parse(str));
  if (sel && !getItem(sel)) sel = null;
  cropMode = false;
  wheel.setValue(S.bg);
  renderAll();
  scheduleSave();
}
function undo() {
  if (!hist.past.length) return;
  hist.future.push(lastSnap);
  lastSnap = hist.past.pop();
  restore(lastSnap);
}
function redo() {
  if (!hist.future.length) return;
  hist.past.push(lastSnap);
  lastSnap = hist.future.pop();
  restore(lastSnap);
}

// ---------- local save ----------
let saveTimer, saveWarned = false;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { w, h, count, layout, bg, cuts, format, cover, items } = S;
    db.saveProject({ v: 1, w, h, count, layout, bg, cuts, format, cover, items }).catch(warnSave);
  }, 400);
}
function warnSave(e) {
  console.warn(e);
  if (saveWarned) return;
  saveWarned = true;
  toast('Could not save the album in this browser (storage full?). Download your sheets before closing.', 'error');
}

// ---------- DOM ----------
const vp = $('#viewport'), board = $('#board'), stage = $('#stage');
const ghostL = $('#ghosts'), sheetsL = $('#sheets'), clipL = $('#clip');
const cutsL = $('#cuts'), labelsL = $('#labels'), guidesL = $('#guides'), overlay = $('#overlay');
const addSheetBtn = $('#add-sheet');

function renderAll() {
  renderControls();
  renderStage();
  renderItems();
  renderOverlay();
  renderSelPanel();
}

function setField(el, val) {
  if (document.activeElement !== el) el.value = val;
}

function renderControls() {
  const lo = Math.min(S.w, S.h), hi = Math.max(S.w, S.h);
  const p = PRESETS.find((p) => p[1] === lo && p[2] === hi);
  $('#preset').value = p ? p[0] : 'custom';
  setField($('#sheet-w'), fmt(S.w));
  setField($('#sheet-h'), fmt(S.h));
  for (const b of $('#orient').children) {
    b.classList.toggle('on', (b.dataset.orient === 'v' && S.w < S.h) || (b.dataset.orient === 'h' && S.w > S.h));
  }
  $('#count-val').textContent = S.count;
  $('#count-dec').disabled = S.count <= 1;
  for (const b of $('#layout').children) b.classList.toggle('on', b.dataset.layout === S.layout);
  for (const b of $('#format').children) b.classList.toggle('on', b.dataset.format === S.format);
  $('#show-cuts').checked = S.cuts;
  $('#undo').disabled = !hist.past.length;
  $('#redo').disabled = !hist.future.length;
  $('#zoom-val').textContent = Math.round((scale / MM_PX) * 100) + '%';

  const { W, H } = sheetPixels(S.w, S.h, DPI);
  $('#export-info').textContent =
    `${plural(S.count, 'file', 'files')} · ${W.toLocaleString('en-US')} × ${H.toLocaleString('en-US')} px each` +
    (S.count > 1 ? ' · in a .zip' : '');

  const used = new Set(S.items.map((i) => i.assetId));
  let bytes = 0;
  for (const id of used) bytes += assets.get(id)?.size || 0;
  $('#img-count').textContent = S.items.length
    ? `${plural(S.items.length, 'image', 'images')} on the desk · ${fmtBytes(bytes)} of originals`
    : '';
}

function renderStage() {
  const g = geo();
  const sw = g.W * scale, sh = g.H * scale;
  const extraW = g.row ? 96 : 0, extraH = g.row ? 0 : 96; // room for the "+ sheet" button
  board.style.width = sw + PAD * 2 + extraW + 'px';
  board.style.height = sh + PAD * 2 + extraH + 'px';
  Object.assign(stage.style, { left: PAD + 'px', top: PAD + 'px', width: sw + 'px', height: sh + 'px' });

  sheetsL.textContent = '';
  labelsL.textContent = '';
  cutsL.textContent = '';
  const size = `${fmt(g.w)} × ${fmt(g.h)} cm`;
  sheetRects(g).forEach((r, i) => {
    const d = document.createElement('div');
    d.className = 'sheet';
    Object.assign(d.style, { left: r.x * scale + 'px', top: r.y * scale + 'px', width: r.w * scale + 'px', height: r.h * scale + 'px', background: S.bg });
    sheetsL.append(d);

    const l = document.createElement('div');
    l.className = 'sheet-label ' + (g.row ? 'row' : 'col');
    l.innerHTML = `<b>#${String(i + 1).padStart(2, '0')}</b><span>${size}</span>`;
    Object.assign(l.style, { left: r.x * scale + 'px', top: r.y * scale + 'px' });
    labelsL.append(l);

    if (i > 0) {
      const c = document.createElement('div');
      c.className = 'cut ' + (g.row ? 'v' : 'h');
      if (g.row) c.style.left = r.x * scale + 'px';
      else c.style.top = r.y * scale + 'px';
      cutsL.append(c);
    }
  });
  cutsL.hidden = !S.cuts;

  addSheetBtn.className = 'add-sheet ' + (g.row ? 'row' : 'col');
  Object.assign(
    addSheetBtn.style,
    g.row
      ? { left: sw + 24 + 'px', top: '0px', width: '64px', height: Math.min(sh, 320) + 'px' }
      : { left: '0px', top: sh + 24 + 'px', width: Math.min(sw, 320) + 'px', height: '56px' }
  );
}

function makeItemNode(it) {
  const d = document.createElement('div');
  d.className = 'item';
  d.dataset.id = it.id;
  const img = new Image();
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.src = assets.get(it.assetId)?.previewUrl || '';
  d.append(img);
  return d;
}
function placeItem(it) {
  const n = nodes.get(it.id);
  if (!n) return;
  for (const el of [n.c, n.g]) {
    const s = el.style;
    s.left = it.x * scale + 'px';
    s.top = it.y * scale + 'px';
    s.width = it.w * scale + 'px';
    s.height = it.h * scale + 'px';
    el.firstChild.style.objectPosition = `${it.fx * 100}% ${it.fy * 100}%`;
  }
}
function renderItems() {
  const keep = new Set();
  for (const it of S.items) {
    keep.add(it.id);
    let n = nodes.get(it.id);
    if (!n) {
      n = { c: makeItemNode(it), g: makeItemNode(it) };
      nodes.set(it.id, n);
      clipL.append(n.c);
      ghostL.append(n.g);
    }
    n.c.classList.toggle('selected', it.id === sel);
    placeItem(it);
  }
  for (const [id, n] of nodes) {
    if (!keep.has(id)) { n.c.remove(); n.g.remove(); nodes.delete(id); }
  }
  // DOM order is stacking order ("bring to front / send to back")
  S.items.forEach((it, i) => {
    const n = nodes.get(it.id);
    if (clipL.children[i] !== n.c) clipL.insertBefore(n.c, clipL.children[i] || null);
    if (ghostL.children[i] !== n.g) ghostL.insertBefore(n.g, ghostL.children[i] || null);
  });
  $('#empty').hidden = S.items.length > 0;
}

// ---------- selection ----------
let ov = null; // refs to the current overlay
function toolbarHtml(it) {
  const b = (act, icon, title, extra = '') =>
    `<button type="button" data-act="${act}" title="${title}" aria-label="${title}" ${extra}><svg class="ico"><use href="#i-${icon}"/></svg></button>`;
  return `<div class="sel-toolbar">
    ${b('lock', it.lock ? 'lock' : 'unlock', it.lock ? 'Aspect ratio locked — click to unlock (L)' : 'Free aspect ratio — click to lock (L)', it.lock ? 'class="on"' : '')}
    ${b('crop', 'crop', it.lock ? 'Reframe: unlock the aspect ratio first' : 'Reframe (double-click)', it.lock ? 'disabled' : cropMode ? 'class="on"' : '')}
    <i></i>
    ${b('fill', 'fill', 'Fill the sheet')}
    ${b('front', 'front', 'Bring to front ( ] )')}
    ${b('back', 'back', 'Send to back ( [ )')}
    ${b('dup', 'copy', 'Duplicate (⌘D)')}
    <i></i>
    ${b('del', 'trash', 'Delete (Delete)')}
  </div>`;
}
function renderOverlay() {
  overlay.textContent = '';
  ov = null;
  document.body.classList.toggle('cropping', cropMode);
  const it = getSel();
  if (!it) return;
  const a = assets.get(it.assetId);
  const box = document.createElement('div');
  box.className = 'sel-box' + (cropMode ? ' crop' : '');
  let ghost = null;
  if (cropMode && a) {
    ghost = new Image();
    ghost.className = 'crop-ghost';
    ghost.src = a.previewUrl;
    box.append(ghost);
  }
  if (!cropMode) {
    for (const d of it.lock ? CORNERS : ALL_HANDLES) {
      const h = document.createElement('span');
      h.className = 'handle h-' + d;
      h.dataset.handle = d;
      box.append(h);
    }
  }
  box.insertAdjacentHTML('beforeend', toolbarHtml(it));
  const badge = document.createElement('div');
  badge.className = 'size-badge';
  box.append(badge);
  overlay.append(box);
  ov = { id: it.id, box, ghost, badge };
  updateOverlay();
}
function updateOverlay() {
  const it = getSel();
  if (!ov || !it || ov.id !== it.id) return renderOverlay();
  Object.assign(ov.box.style, { left: it.x * scale + 'px', top: it.y * scale + 'px', width: it.w * scale + 'px', height: it.h * scale + 'px' });
  const a = assets.get(it.assetId);
  if (ov.ghost && a) {
    const sc = Math.max(it.w / a.nw, it.h / a.nh);
    const dw = a.nw * sc, dh = a.nh * sc;
    Object.assign(ov.ghost.style, {
      left: (it.w - dw) * it.fx * scale + 'px', top: (it.h - dh) * it.fy * scale + 'px',
      width: dw * scale + 'px', height: dh * scale + 'px',
    });
  }
  ov.badge.textContent = cropMode
    ? 'Drag to reframe · Esc to exit'
    : `${fmt(it.w)} × ${fmt(it.h)} cm · ${Math.round(effDpi(it, a))} dpi`;
}

function select(id) {
  if (id !== sel) cropMode = false;
  sel = id;
  for (const [nid, n] of nodes) n.c.classList.toggle('selected', nid === sel);
  renderOverlay();
  renderSelPanel();
}

function renderSelPanel() {
  const it = getSel();
  $('#sel-section').hidden = !it;
  $('#export-num').textContent = it ? '#05' : '#04';
  if (!it) return;
  const a = assets.get(it.assetId);
  $('#sel-name').textContent = a?.name || 'image';
  $('#sel-name').title = a?.name || '';
  $('#sel-px').textContent = a ? `${a.nw.toLocaleString('en-US')} × ${a.nh.toLocaleString('en-US')} px original` : '';
  setField($('#sel-w'), fmt(it.w, 2));
  setField($('#sel-h'), fmt(it.h, 2));
  setField($('#sel-x'), fmt(it.x, 2));
  setField($('#sel-y'), fmt(it.y, 2));
  const lock = $('#sel-lock');
  lock.setAttribute('aria-pressed', String(it.lock));
  lock.querySelector('use').setAttribute('href', it.lock ? '#i-lock' : '#i-unlock');
  lock.querySelector('b').textContent = it.lock ? 'Keep aspect ratio' : 'Free aspect ratio';
  lock.querySelector('small').textContent = it.lock ? 'Resizes without distortion' : 'The frame crops the photo · double-click to reframe';
  $('#sel-crop').disabled = it.lock;
  $('#sel-crop').classList.toggle('on', cropMode);

  const dpi = Math.round(effDpi(it, a));
  const [cls, txt] =
    dpi >= 280 ? ['good', 'sharp in print'] : dpi >= 180 ? ['ok', 'good for print'] : ['low', 'low resolution for this size'];
  $('#sel-dpi').innerHTML = `<span class="dpi ${cls}">${dpi} dpi</span><span>${txt}</span>`;
}

// ---------- image actions ----------
function sheetFor(it) {
  const rects = sheetRects();
  let best = 0, bestArea = -1;
  rects.forEach((r, i) => {
    const ix = Math.max(0, Math.min(it.x + it.w, r.x + r.w) - Math.max(it.x, r.x));
    const iy = Math.max(0, Math.min(it.y + it.h, r.y + r.h) - Math.max(it.y, r.y));
    if (ix * iy > bestArea) { bestArea = ix * iy; best = i; }
  });
  if (bestArea <= 0) {
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    let dmin = Infinity;
    rects.forEach((r, i) => {
      const d = Math.hypot(cx - (r.x + r.w / 2), cy - (r.y + r.h / 2));
      if (d < dmin) { dmin = d; best = i; }
    });
  }
  return rects[best];
}

function setLock(it, lock) {
  const a = assets.get(it.assetId);
  it.lock = lock;
  if (lock && a) {
    // back to the original aspect ratio, keeping width and centre
    const cy = it.y + it.h / 2;
    it.h = it.w * (a.nh / a.nw);
    it.y = cy - it.h / 2;
    it.fx = it.fy = 0.5;
    cropMode = false;
  }
}

function act(name) {
  const it = getSel();
  if (!it) return;
  const idx = S.items.indexOf(it);
  switch (name) {
    case 'lock':
      setLock(it, !it.lock);
      break;
    case 'crop':
      if (it.lock) return toast('Unlock the aspect ratio to reframe the photo inside its frame.');
      cropMode = !cropMode;
      break;
    case 'fill': {
      const r = sheetFor(it);
      Object.assign(it, { x: r.x, y: r.y, w: r.w, h: r.h, lock: false });
      break;
    }
    case 'front':
      S.items.splice(idx, 1);
      S.items.push(it);
      break;
    case 'back':
      S.items.splice(idx, 1);
      S.items.unshift(it);
      break;
    case 'dup': {
      const c = { ...it, id: uid(), x: it.x + 5, y: it.y + 5 };
      S.items.splice(idx + 1, 0, c);
      sel = c.id;
      cropMode = false;
      break;
    }
    case 'del':
      S.items.splice(idx, 1);
      sel = null;
      cropMode = false;
      break;
  }
  commit();
  renderItems();
  renderOverlay();
  renderSelPanel();
}

// ---------- images ----------
function targetSheet() {
  const g = geo();
  const cx = (vp.scrollLeft + vp.clientWidth / 2 - board.offsetLeft - PAD) / scale;
  const cy = (vp.scrollTop + vp.clientHeight / 2 - board.offsetTop - PAD) / scale;
  const i = g.row ? Math.floor(cx / g.w) : Math.floor(cy / g.h);
  return sheetRect(clamp(i, 0, g.n - 1), g);
}

let addQueue = Promise.resolve();
function addFiles(fileList) {
  const files = [...fileList].filter(
    (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp)$/i.test(f.name)
  );
  if (!files.length) return addQueue;
  addQueue = addQueue.then(() => addFilesNow(files));
  return addQueue;
}
async function addFilesNow(files) {
  const status = $('#img-count');
  const r = targetSheet();
  let added = 0, lastId = null;
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    status.textContent = `Preparing ${i + 1} of ${files.length} · ${f.name}`;
    try {
      const { nw, nh, preview } = await readImage(f);
      const id = uid();
      const asset = { id, name: f.name, size: f.size, file: f, preview, nw, nh, previewUrl: URL.createObjectURL(preview) };
      assets.set(id, asset);
      db.putAsset({ id, name: f.name, size: f.size, file: f, preview, nw, nh }).catch(warnSave);

      const s = Math.min((r.w * 0.72) / nw, (r.h * 0.72) / nh);
      const w = nw * s, h = nh * s;
      const off = (added % 8) * 6;
      const it = { id: uid(), assetId: id, x: r.x + (r.w - w) / 2 + off - 21, y: r.y + (r.h - h) / 2 + off - 21, w, h, lock: true, fx: 0.5, fy: 0.5 };
      if (files.length === 1) { it.x = r.x + (r.w - w) / 2; it.y = r.y + (r.h - h) / 2; }
      S.items.push(it);
      lastId = it.id;
      added++;
      renderItems();
    } catch (e) {
      console.warn(f.name, e);
      const heic = /\.(heic|heif)$/i.test(f.name);
      toast(`Could not open ${f.name}${heic ? ' — HEIC only opens in Safari; export it as JPG' : ''}.`, 'error');
    }
  }
  if (lastId) {
    sel = lastId;
    cropMode = false;
    commit();
    renderItems();
    renderOverlay();
    renderSelPanel();
    if (added > 1) toast(`${added} images added`);
  }
  renderControls();
}

// ---------- zoom ----------
let autoFit = true; // refit on window resize until the user changes the zoom
new ResizeObserver(() => autoFit && vp.clientWidth > 0 && fit()).observe(vp);

function setScale(ns, anchor) {
  autoFit = false;
  ns = clamp(ns, 0.02, 60);
  const r = vp.getBoundingClientRect();
  const ax = anchor ? anchor.x - r.left : vp.clientWidth / 2;
  const ay = anchor ? anchor.y - r.top : vp.clientHeight / 2;
  const wx = (vp.scrollLeft + ax - board.offsetLeft - PAD) / scale;
  const wy = (vp.scrollTop + ay - board.offsetTop - PAD) / scale;
  scale = ns;
  renderStage();
  for (const it of S.items) placeItem(it);
  updateOverlay();
  renderControls();
  vp.scrollLeft = wx * scale + board.offsetLeft + PAD - ax;
  vp.scrollTop = wy * scale + board.offsetTop + PAD - ay;
}
function fit() {
  autoFit = true;
  if (!vp.clientWidth) return;
  const g = geo();
  const labelW = g.row ? 0 : 100; // stacked-sheet labels sit on the left
  const s = Math.min((vp.clientWidth - 120 - labelW) / g.W, (vp.clientHeight - 130) / g.H);
  scale = clamp(s, 0.02, 60);
  renderStage();
  for (const it of S.items) placeItem(it);
  updateOverlay();
  renderControls();
  vp.scrollLeft = board.offsetLeft + PAD + (g.W * scale) / 2 - vp.clientWidth / 2 - labelW / 2;
  vp.scrollTop = board.offsetTop + PAD + (g.H * scale) / 2 - vp.clientHeight / 2 + 8;
}

// ---------- snapping ----------
function snapTargets(excludeId) {
  const xs = [], ys = [];
  for (const r of sheetRects()) {
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  for (const o of S.items) {
    if (o.id === excludeId) continue;
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  return { xs, ys };
}
function snapBest(vals, targets, thr) {
  let best = null;
  for (const v of vals) for (const t of targets) {
    const d = t - v;
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t };
  }
  return best;
}
function renderGuides(list) {
  guidesL.textContent = '';
  for (const g of list) {
    const d = document.createElement('div');
    if (g.x != null) { d.className = 'guide v'; d.style.left = g.x * scale + 'px'; }
    else { d.className = 'guide h'; d.style.top = g.y * scale + 'px'; }
    guidesL.append(d);
  }
}

// ---------- drag / resize / reframe ----------
function toWorld(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

function resizeItem(it, d, dx, dy, shift, thr, guides) {
  const o = d.o, dir = d.dir, MIN = 4;
  const a = assets.get(it.assetId);
  const keep = it.lock !== shift; // Shift inverts the lock while dragging
  const T = thr ? snapTargets(it.id) : null;
  if (keep && dir.length === 2) {
    const ar = it.lock && a ? a.nw / a.nh : o.w / o.h;
    const W = dir.includes('w'), N = dir.includes('n');
    const ax = W ? o.x + o.w : o.x, ay = N ? o.y + o.h : o.y;
    const mx = (W ? o.x : o.x + o.w) + dx, my = (N ? o.y : o.y + o.h) + dy;
    let w = Math.max(0, W ? ax - mx : mx - ax), h = Math.max(0, N ? ay - my : my - ay);
    if (w / ar >= h) h = w / ar; else w = h * ar;
    if (T) {
      const bx = snapBest([W ? ax - w : ax + w], T.xs, thr);
      if (bx) { w = Math.abs(bx.t - ax); h = w / ar; guides.push({ x: bx.t }); }
      else {
        const by = snapBest([N ? ay - h : ay + h], T.ys, thr);
        if (by) { h = Math.abs(by.t - ay); w = h * ar; guides.push({ y: by.t }); }
      }
    }
    if (w < MIN) { w = MIN; h = w / ar; }
    if (h < MIN) { h = MIN; w = h * ar; }
    Object.assign(it, { w, h, x: W ? ax - w : ax, y: N ? ay - h : ay });
  } else {
    const sn = (v, arr, axis) => {
      if (!T) return v;
      const b = snapBest([v], arr, thr);
      if (!b) return v;
      guides.push({ [axis]: b.t });
      return b.t;
    };
    let L = o.x, Tp = o.y, R = o.x + o.w, B = o.y + o.h;
    if (dir.includes('w')) L = Math.min(sn(o.x + dx, T?.xs, 'x'), R - MIN);
    if (dir.includes('e')) R = Math.max(sn(o.x + o.w + dx, T?.xs, 'x'), L + MIN);
    if (dir.includes('n')) Tp = Math.min(sn(o.y + dy, T?.ys, 'y'), B - MIN);
    if (dir.includes('s')) B = Math.max(sn(o.y + o.h + dy, T?.ys, 'y'), Tp + MIN);
    Object.assign(it, { x: L, y: Tp, w: R - L, h: B - Tp });
    if (it.lock) it.lock = false; // now a free frame
  }
}

let lastDownId = null;
vp.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.sel-toolbar, .add-sheet')) return;
  if (e.target === vp && (e.offsetX > vp.clientWidth || e.offsetY > vp.clientHeight)) return; // scrollbar
  const p = toWorld(e);
  const hd = e.target.closest('[data-handle]');
  lastDownId = null;
  if (hd) {
    const it = getSel();
    drag = { kind: 'resize', dir: hd.dataset.handle, p0: p, o: { ...it }, id: it.id };
  } else {
    const el = e.target.closest('[data-id]');
    if (!el) {
      if (sel) select(null);
      return;
    }
    const id = el.dataset.id;
    lastDownId = id;
    if (id !== sel) select(id);
    drag = { kind: cropMode ? 'crop' : 'move', p0: p, o: { ...getItem(id) }, id };
  }
  drag.changed = false;
  vp.setPointerCapture(e.pointerId);
  e.preventDefault();
});
vp.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const it = getItem(drag.id);
  if (!it) return;
  const p = toWorld(e);
  const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
  if (!drag.changed && Math.hypot(dx, dy) * scale < 2) return;
  drag.changed = true;
  const thr = e.altKey ? 0 : 7 / scale;
  const guides = [];
  if (drag.kind === 'move') {
    let nx = drag.o.x + dx, ny = drag.o.y + dy;
    if (thr) {
      const T = snapTargets(it.id);
      const sx = snapBest([nx, nx + it.w / 2, nx + it.w], T.xs, thr);
      if (sx) { nx += sx.d; guides.push({ x: sx.t }); }
      const sy = snapBest([ny, ny + it.h / 2, ny + it.h], T.ys, thr);
      if (sy) { ny += sy.d; guides.push({ y: sy.t }); }
    }
    it.x = nx; it.y = ny;
  } else if (drag.kind === 'crop') {
    const a = assets.get(it.assetId);
    const sc = Math.max(it.w / a.nw, it.h / a.nh);
    const ovx = a.nw * sc - it.w, ovy = a.nh * sc - it.h;
    if (ovx > 0.01) it.fx = clamp(drag.o.fx - dx / ovx, 0, 1);
    if (ovy > 0.01) it.fy = clamp(drag.o.fy - dy / ovy, 0, 1);
  } else {
    const wasLocked = it.lock;
    resizeItem(it, drag, dx, dy, e.shiftKey, thr, guides);
    if (wasLocked !== it.lock) renderOverlay();
  }
  placeItem(it);
  updateOverlay();
  renderGuides(guides);
  renderSelPanel();
});
function endDrag() {
  if (!drag) return;
  const changed = drag.changed;
  drag = null;
  renderGuides([]);
  if (changed) {
    commit();
    renderSelPanel();
  }
}
vp.addEventListener('pointerup', endDrag);
vp.addEventListener('pointercancel', endDrag);
vp.addEventListener('dblclick', () => {
  const it = getSel();
  if (!it || lastDownId !== it.id) return;
  if (it.lock) {
    toast('Unlock the aspect ratio (padlock) to reframe the photo inside its frame.');
    return;
  }
  cropMode = !cropMode;
  renderOverlay();
  renderSelPanel();
});
overlay.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) act(b.dataset.act);
});

vp.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setScale(scale * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
  },
  { passive: false }
);

// ---------- files: button, drag and drop, paste ----------
const fileInput = $('#file-input');
$('#add-images').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});
const work = $('#work');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
work.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  work.classList.add('dropping');
});
work.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
work.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; work.classList.remove('dropping'); }
});
work.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  work.classList.remove('dropping');
  addFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const files = e.clipboardData?.files;
  if (files?.length) addFiles(files);
});

// ---------- panel ----------
function bindPanel() {
  const preset = $('#preset');
  preset.innerHTML =
    PRESETS.map(([id, , , label]) => `<option value="${id}">${label}</option>`).join('') +
    '<option value="custom">Custom</option>';
  preset.addEventListener('change', () => {
    const p = PRESETS.find((p) => p[0] === preset.value);
    if (!p) return;
    const landscape = S.w > S.h;
    [S.w, S.h] = landscape ? [p[2], p[1]] : [p[1], p[2]];
    commit();
    renderAll();
    fit();
  });

  const dim = (id, key) => {
    const el = $(id);
    el.addEventListener('change', () => {
      const v = parseCm(el.value);
      if (v == null || v < 10) { el.value = fmt(S[key]); return toast('Use a size of at least 1 cm.'); }
      S[key] = clamp(Math.round(v * 10) / 10, 10, 3000);
      el.value = fmt(S[key]);
      commit();
      renderAll();
      fit();
    });
  };
  dim('#sheet-w', 'w');
  dim('#sheet-h', 'h');

  $('#orient').addEventListener('click', (e) => {
    const o = e.target.closest('[data-orient]')?.dataset.orient;
    if (!o) return;
    if ((o === 'v' && S.w > S.h) || (o === 'h' && S.w < S.h)) [S.w, S.h] = [S.h, S.w];
    commit();
    renderAll();
    fit();
  });
  const setCount = (n) => {
    S.count = clamp(n, 1, 80);
    commit();
    renderAll();
  };
  $('#count-dec').addEventListener('click', () => setCount(S.count - 1));
  $('#count-inc').addEventListener('click', () => setCount(S.count + 1));
  addSheetBtn.addEventListener('click', () => {
    setCount(S.count + 1);
    const g = geo();
    if (g.row) vp.scrollTo({ left: vp.scrollWidth, behavior: 'smooth' });
    else vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
  });
  $('#layout').addEventListener('click', (e) => {
    const l = e.target.closest('[data-layout]')?.dataset.layout;
    if (!l || l === S.layout) return;
    // move each image along with the sheet it sits on
    const before = geo();
    const moved = S.items.map((it) => {
      const r = sheetFor(it);
      const i = before.row ? Math.round(r.x / before.w) : Math.round(r.y / before.h);
      return { it, i, r };
    });
    S.layout = l;
    const after = geo();
    for (const { it, i, r } of moved) {
      const nr = sheetRect(i, after);
      it.x += nr.x - r.x;
      it.y += nr.y - r.y;
    }
    commit();
    renderAll();
    fit();
  });
  $('#show-cuts').addEventListener('change', (e) => {
    S.cuts = e.target.checked;
    cutsL.hidden = !S.cuts;
    scheduleSave();
  });
  $('#format').addEventListener('click', (e) => {
    const f = e.target.closest('[data-format]')?.dataset.format;
    if (!f) return;
    S.format = f;
    renderControls();
    scheduleSave();
  });

  const selField = (id, apply) => {
    const el = $(id);
    el.addEventListener('change', () => {
      const it = getSel();
      const v = parseCm(el.value);
      if (!it || v == null) return renderSelPanel();
      apply(it, v, assets.get(it.assetId));
      commit();
      placeItem(it);
      updateOverlay();
      renderSelPanel();
    });
  };
  selField('#sel-w', (it, v, a) => {
    it.w = Math.max(4, v);
    if (it.lock && a) it.h = it.w * (a.nh / a.nw);
  });
  selField('#sel-h', (it, v, a) => {
    it.h = Math.max(4, v);
    if (it.lock && a) it.w = it.h * (a.nw / a.nh);
  });
  selField('#sel-x', (it, v) => (it.x = v));
  selField('#sel-y', (it, v) => (it.y = v));
  $('#sel-lock').addEventListener('click', () => act('lock'));
  $('#sel-crop').addEventListener('click', () => act('crop'));
  $('#sel-fill').addEventListener('click', () => act('fill'));
  $('#sel-dup').addEventListener('click', () => act('dup'));
  $('#sel-del').addEventListener('click', () => act('del'));

  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#zoom-in').addEventListener('click', () => setScale(scale * 1.25));
  $('#zoom-out').addEventListener('click', () => setScale(scale / 1.25));
  $('#zoom-fit').addEventListener('click', fit);
  $('#zoom-val').addEventListener('click', () => setScale(MM_PX));
  $('#download').addEventListener('click', doExport);
  $('#download-top').addEventListener('click', doExport);
  $('#preview-top').addEventListener('click', () => openPreview());
  $('#new-album').addEventListener('click', newAlbum);
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (book.isOpen) return book.key(e);
  const t = e.target;
  if (t.closest?.('input, select, textarea')) {
    if (e.key === 'Enter' && t.tagName === 'INPUT') t.blur();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && k === 'y') { e.preventDefault(); return redo(); }
  if (mod && k === '0') { e.preventDefault(); return fit(); }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); return setScale(scale * 1.25); }
  if (mod && k === '-') { e.preventDefault(); return setScale(scale / 1.25); }
  if (mod && k === 'o') { e.preventDefault(); return fileInput.click(); }
  if (mod && k === 's') { e.preventDefault(); return doExport(); }
  if (!mod && k === 'p') { e.preventDefault(); return openPreview(); }
  const it = getSel();
  if (!it) return;
  if (mod && k === 'd') { e.preventDefault(); return act('dup'); }
  if (mod) return;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); return act('del'); }
  if (k === 'escape') {
    if (cropMode) { cropMode = false; renderOverlay(); renderSelPanel(); }
    else select(null);
    return;
  }
  if (k === 'l') return act('lock');
  if (k === 'c' && !it.lock) return act('crop');
  if (k === ']') return act('front');
  if (k === '[') return act('back');
  const step = e.shiftKey ? 10 : 1;
  const mv = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
  if (mv) {
    e.preventDefault();
    it.x += mv[0];
    it.y += mv[1];
    placeItem(it);
    updateOverlay();
    renderSelPanel();
    commit();
  }
});

// ---------- book preview ----------
const book = createBook($('#book-view'), {
  onCoverChange: (cover) => {
    S.cover = cover;
    scheduleSave();
    openPreview(true);
  },
});

// Each sheet rendered from the light previews (not the originals) at about screen
// resolution. Cached until the album changes.
let pv = { key: '', urls: [] };
async function sheetPreviews() {
  const key = snapshot();
  if (pv.key === key) return pv.urls;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const target = Math.min(2000, Math.round(Math.max(window.innerWidth, window.innerHeight) * dpr * 0.75));
  const dpi = target / (Math.max(S.w, S.h) / 25.4);
  const light = new Map();
  for (const [id, a] of assets) {
    const { w, h } = previewSize(a.nw, a.nh);
    light.set(id, { id, file: a.preview, nw: w, nh: h });
  }
  const files = await renderSheets({
    sheets: sheetRects(), items: S.items, assets: light, bg: S.bg, dpi, format: 'jpg', name: 'preview',
    embed: false, quality: 0.86,
    onProgress: (i, n) => book.progress(`Sheet ${i + 1} of ${n}`),
  });
  for (const u of pv.urls) URL.revokeObjectURL(u);
  pv = { key, urls: files.map((f) => URL.createObjectURL(f.blob)) };
  return pv.urls;
}

let previewing = false;
async function openPreview(keepPosition = false) {
  if (previewing || exporting) return;
  previewing = true;
  select(null);
  book.show();
  try {
    const urls = await sheetPreviews();
    if (!book.isOpen) return;
    book.setup({
      urls, w: S.w, h: S.h, binding: S.layout === 'row' ? 'left' : 'top', bg: S.bg, cover: S.cover, keepPosition,
    });
  } catch (err) {
    console.error(err);
    book.hide();
    toast(err.message || 'Could not build the preview.', 'error');
  } finally {
    previewing = false;
  }
}

// ---------- export ----------
async function doExport() {
  if (exporting) return;
  exporting = true;
  const g = geo();
  const modal = $('#modal');
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `vento-${stamp}`;
  modal.hidden = false;
  const progress = (i, n, W, H) => {
    $('#modal-title').textContent = `Sheet ${i + 1} of ${n}`;
    $('#modal-sub').textContent = `${W.toLocaleString('en-US')} × ${H.toLocaleString('en-US')} px · ${S.format.toUpperCase()}`;
    $('#modal-bar').style.width = (i / n) * 100 + '%';
  };
  try {
    const files = await renderSheets({
      sheets: sheetRects(g), items: S.items, assets, bg: S.bg, dpi: DPI, format: S.format, name, onProgress: progress,
    });
    $('#modal-bar').style.width = '100%';
    if (files.length === 1) {
      downloadBlob(files[0].blob, files[0].name);
    } else {
      $('#modal-title').textContent = 'Packing';
      $('#modal-sub').textContent = `${files.length} sheets in one .zip`;
      await new Promise((r) => setTimeout(r, 30));
      downloadBlob(await zipStore(files), `${name}-album.zip`);
    }
    const low = S.items.filter((it) => effDpi(it, assets.get(it.assetId)) < 180).length;
    toast(
      `Done: ${plural(files.length, 'sheet', 'sheets')} at 300 dpi.` +
        (low ? ` Heads up: ${plural(low, 'image has', 'images have')} low resolution for its size.` : '')
    );
  } catch (err) {
    console.error(err);
    toast(err.message || 'Export failed.', 'error');
  } finally {
    modal.hidden = true;
    exporting = false;
  }
}

async function newAlbum() {
  if (S.items.length && !confirm('Start a new album? The current images and layout will be removed from this browser.')) return;
  for (const a of assets.values()) URL.revokeObjectURL(a.previewUrl);
  assets.clear();
  const { format, cuts } = S;
  Object.assign(S, structuredClone(DEFAULTS), { format, cuts });
  sel = null;
  cropMode = false;
  hist.past = [];
  hist.future = [];
  lastSnap = snapshot();
  try { await db.clearAll(); } catch (e) { console.warn(e); }
  wheel.setValue(S.bg);
  renderAll();
  fit();
  scheduleSave();
}

// ---------- startup ----------
async function boot() {
  wheel = createColorWheel($('#wheel'), {
    value: S.bg,
    onInput: (hex) => {
      S.bg = hex;
      for (const d of sheetsL.children) d.style.background = hex;
    },
    onChange: () => commit(),
  });
  bindPanel();
  try {
    const [proj, recs] = await Promise.all([db.loadProject(), db.getAllAssets()]);
    if (proj) for (const k of Object.keys(DEFAULTS)) if (k in proj) S[k] = proj[k];
    const used = new Set(S.items.map((i) => i.assetId));
    for (const r of recs) {
      if (!used.has(r.id)) { db.deleteAsset(r.id).catch(() => {}); continue; }
      assets.set(r.id, { ...r, previewUrl: URL.createObjectURL(r.preview) });
    }
    S.items = S.items.filter((i) => assets.has(i.assetId));
    if (S.items.length) toast(`Album restored · ${plural(S.items.length, 'image', 'images')}`);
  } catch (e) {
    console.warn('Local save unavailable', e);
  }
  wheel.setValue(S.bg);
  lastSnap = snapshot();
  renderAll();
  fit();
}
boot();

// which build is running (helps tell a stale cached copy from the current one)
$('#build').textContent = new URL(import.meta.url).searchParams.get('v') || 'dev';

// hooks for debugging and tests
window.vento = { S, assets, addFiles, doExport, fit, geo, select, renderSheets, sheetRects, openPreview, book };
