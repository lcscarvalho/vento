import { createColorWheel } from './colorwheel.js';
import { readImage, fmtBytes } from './images.js';
import { renderSheets, sheetPixels, zipStore, downloadBlob } from './export.js';
import * as db from './store.js';

// Todas as medidas internas em milímetros. Na tela: px = mm × scale.
const DPI = 300;
const PAD = 160;                 // margem da mesa em volta das folhas (px)
const MM_PX = 96 / 25.4;         // 100% de zoom = tamanho real
const BRAND = [
  { name: 'Branco', hex: '#FFFFFF' },
  { name: 'Oat Cream', hex: '#E9E5D6' },
  { name: 'Coffee Blue', hex: '#2589D8' },
  { name: 'Tangerine', hex: '#FF783D' },
];
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
const DEFAULTS = { w: 200, h: 300, count: 2, layout: 'row', bg: '#FFFFFF', cuts: true, format: 'jpg', items: [] };
const CORNERS = ['nw', 'ne', 'se', 'sw'];
const ALL_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const S = structuredClone(DEFAULTS);
const assets = new Map();        // id -> { id, name, size, file, preview, previewUrl, nw, nh }
const nodes = new Map();         // itemId -> { c, g } (nó recortado e "fantasma" fora da folha)
let scale = 1;
let sel = null;
let cropMode = false;
let drag = null;
let exporting = false;
let wheel;

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (mm, d = 1) => (mm / 10).toLocaleString('pt-BR', { maximumFractionDigits: d });
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

// ---------- histórico (desfazer/refazer) ----------
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

// ---------- salvamento local ----------
let saveTimer, saveWarned = false;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { w, h, count, layout, bg, cuts, format, items } = S;
    db.saveProject({ v: 1, w, h, count, layout, bg, cuts, format, items }).catch(warnSave);
  }, 400);
}
function warnSave(e) {
  console.warn(e);
  if (saveWarned) return;
  saveWarned = true;
  toast('Não deu para salvar o álbum neste navegador (espaço cheio?). Baixe as folhas antes de fechar.', 'error');
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
    `${plural(S.count, 'arquivo', 'arquivos')} · ${W.toLocaleString('pt-BR')} × ${H.toLocaleString('pt-BR')} px cada` +
    (S.count > 1 ? ' · em .zip' : '');

  const used = new Set(S.items.map((i) => i.assetId));
  let bytes = 0;
  for (const id of used) bytes += assets.get(id)?.size || 0;
  $('#img-count').textContent = S.items.length
    ? `${plural(S.items.length, 'imagem', 'imagens')} na mesa · ${fmtBytes(bytes)} em originais`
    : '';
}

function renderStage() {
  const g = geo();
  const sw = g.W * scale, sh = g.H * scale;
  const extraW = g.row ? 96 : 0, extraH = g.row ? 0 : 96; // espaço do botão "+ folha"
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
  // a ordem no DOM é a ordem de empilhamento ("trazer para frente / enviar para trás")
  S.items.forEach((it, i) => {
    const n = nodes.get(it.id);
    if (clipL.children[i] !== n.c) clipL.insertBefore(n.c, clipL.children[i] || null);
    if (ghostL.children[i] !== n.g) ghostL.insertBefore(n.g, ghostL.children[i] || null);
  });
  $('#empty').hidden = S.items.length > 0;
}

// ---------- seleção ----------
let ov = null; // referências do overlay atual
function toolbarHtml(it) {
  const b = (act, icon, title, extra = '') =>
    `<button type="button" data-act="${act}" title="${title}" aria-label="${title}" ${extra}><svg class="ico"><use href="#i-${icon}"/></svg></button>`;
  return `<div class="sel-toolbar">
    ${b('lock', it.lock ? 'lock' : 'unlock', it.lock ? 'Proporção travada — clique para liberar (L)' : 'Proporção livre — clique para travar (L)', it.lock ? 'class="on"' : '')}
    ${b('crop', 'crop', it.lock ? 'Enquadrar: libere a proporção primeiro' : 'Enquadrar (duplo clique)', it.lock ? 'disabled' : cropMode ? 'class="on"' : '')}
    <i></i>
    ${b('fill', 'fill', 'Preencher a folha')}
    ${b('front', 'front', 'Trazer para frente ( ] )')}
    ${b('back', 'back', 'Enviar para trás ( [ )')}
    ${b('dup', 'copy', 'Duplicar (⌘D)')}
    <i></i>
    ${b('del', 'trash', 'Excluir (Delete)')}
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
    ? 'Arraste para enquadrar · Esc sai'
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
  $('#sel-name').textContent = a?.name || 'imagem';
  $('#sel-name').title = a?.name || '';
  $('#sel-px').textContent = a ? `${a.nw.toLocaleString('pt-BR')} × ${a.nh.toLocaleString('pt-BR')} px originais` : '';
  setField($('#sel-w'), fmt(it.w, 2));
  setField($('#sel-h'), fmt(it.h, 2));
  setField($('#sel-x'), fmt(it.x, 2));
  setField($('#sel-y'), fmt(it.y, 2));
  const lock = $('#sel-lock');
  lock.setAttribute('aria-pressed', String(it.lock));
  lock.querySelector('use').setAttribute('href', it.lock ? '#i-lock' : '#i-unlock');
  lock.querySelector('b').textContent = it.lock ? 'Manter proporção' : 'Proporção livre';
  lock.querySelector('small').textContent = it.lock ? 'Redimensiona sem distorcer' : 'A moldura corta a foto · duplo clique enquadra';
  $('#sel-crop').disabled = it.lock;
  $('#sel-crop').classList.toggle('on', cropMode);

  const dpi = Math.round(effDpi(it, a));
  const [cls, txt] =
    dpi >= 280 ? ['good', 'nítida na impressão'] : dpi >= 180 ? ['ok', 'boa para impressão'] : ['low', 'pouca resolução para esse tamanho'];
  $('#sel-dpi').innerHTML = `<span class="dpi ${cls}">${dpi} dpi</span><span>${txt}</span>`;
}

// ---------- ações sobre a imagem ----------
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
    // volta à proporção original mantendo a largura e o centro
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
      if (it.lock) return toast('Libere a proporção para enquadrar a foto dentro da moldura.');
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

// ---------- imagens ----------
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
    status.textContent = `Preparando ${i + 1} de ${files.length} · ${f.name}`;
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
      toast(`Não consegui abrir ${f.name}${heic ? ' — HEIC só abre no Safari; exporte como JPG' : ''}.`, 'error');
    }
  }
  if (lastId) {
    sel = lastId;
    cropMode = false;
    commit();
    renderItems();
    renderOverlay();
    renderSelPanel();
    if (added > 1) toast(`${added} imagens adicionadas`);
  }
  renderControls();
}

// ---------- zoom ----------
let autoFit = true; // reajusta ao redimensionar a janela até o usuário mexer no zoom
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
  const labelW = g.row ? 0 : 100; // rótulos das folhas empilhadas ficam à esquerda
  const s = Math.min((vp.clientWidth - 120 - labelW) / g.W, (vp.clientHeight - 130) / g.H);
  scale = clamp(s, 0.02, 60);
  renderStage();
  for (const it of S.items) placeItem(it);
  updateOverlay();
  renderControls();
  vp.scrollLeft = board.offsetLeft + PAD + (g.W * scale) / 2 - vp.clientWidth / 2 - labelW / 2;
  vp.scrollTop = board.offsetTop + PAD + (g.H * scale) / 2 - vp.clientHeight / 2 + 8;
}

// ---------- ímã (alinhamento) ----------
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

// ---------- arrastar / redimensionar / enquadrar ----------
function toWorld(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

function resizeItem(it, d, dx, dy, shift, thr, guides) {
  const o = d.o, dir = d.dir, MIN = 4;
  const a = assets.get(it.assetId);
  const keep = it.lock !== shift; // Shift inverte a trava enquanto arrasta
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
    if (it.lock) it.lock = false; // virou moldura livre
  }
}

let lastDownId = null;
vp.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.sel-toolbar, .add-sheet')) return;
  if (e.target === vp && (e.offsetX > vp.clientWidth || e.offsetY > vp.clientHeight)) return; // barra de rolagem
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
    toast('Libere a proporção (cadeado) para enquadrar a foto dentro da moldura.');
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

// ---------- arquivos: botão, arrastar e soltar, colar ----------
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

// ---------- painel ----------
function bindPanel() {
  const preset = $('#preset');
  preset.innerHTML =
    PRESETS.map(([id, , , label]) => `<option value="${id}">${label}</option>`).join('') +
    '<option value="custom">Personalizado</option>';
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
      if (v == null || v < 10) { el.value = fmt(S[key]); return toast('Use um tamanho a partir de 1 cm.'); }
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
    // leva cada imagem junto com a folha em que está
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
  $('#new-album').addEventListener('click', newAlbum);
}

// ---------- teclado ----------
document.addEventListener('keydown', (e) => {
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

// ---------- exportação ----------
async function doExport() {
  if (exporting) return;
  exporting = true;
  const g = geo();
  const modal = $('#modal');
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `vento-${stamp}`;
  modal.hidden = false;
  const progress = (i, n, W, H) => {
    $('#modal-title').textContent = `Folha ${i + 1} de ${n}`;
    $('#modal-sub').textContent = `${W.toLocaleString('pt-BR')} × ${H.toLocaleString('pt-BR')} px · ${S.format.toUpperCase()}`;
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
      $('#modal-title').textContent = 'Empacotando';
      $('#modal-sub').textContent = `${files.length} folhas em um .zip`;
      await new Promise((r) => setTimeout(r, 30));
      downloadBlob(await zipStore(files), `${name}-album.zip`);
    }
    const low = S.items.filter((it) => effDpi(it, assets.get(it.assetId)) < 180).length;
    toast(
      `Pronto: ${plural(files.length, 'folha', 'folhas')} em 300 dpi.` +
        (low ? ` Atenção: ${plural(low, 'imagem está', 'imagens estão')} com pouca resolução para o tamanho.` : '')
    );
  } catch (err) {
    console.error(err);
    toast(err.message || 'Falha ao exportar.', 'error');
  } finally {
    modal.hidden = true;
    exporting = false;
  }
}

async function newAlbum() {
  if (S.items.length && !confirm('Começar um álbum novo? As imagens e o layout atuais serão apagados deste navegador.')) return;
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

// ---------- início ----------
async function boot() {
  wheel = createColorWheel($('#wheel'), {
    value: S.bg,
    swatches: BRAND,
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
    if (S.items.length) toast(`Álbum restaurado · ${plural(S.items.length, 'imagem', 'imagens')}`);
  } catch (e) {
    console.warn('Salvamento local indisponível', e);
  }
  wheel.setValue(S.bg);
  lastSnap = snapshot();
  renderAll();
  fit();
}
boot();

// ganchos para depuração e testes
window.vento = { S, assets, addFiles, doExport, fit, geo, select, renderSheets, sheetRects };
