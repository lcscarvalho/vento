// Roda de cores HSV: matiz no ângulo, saturação no raio, brilho no controle deslizante.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();

export function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1)];
}
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export function createColorWheel(root, { value = '#FFFFFF', swatches = [], onInput = () => {}, onChange = () => {} } = {}) {
  root.classList.add('cw');
  root.innerHTML = `
    <div class="cw-disc"><canvas></canvas><span class="cw-marker"></span></div>
    <label class="cw-row"><span class="mini">Brilho</span><input class="cw-value" type="range" min="0" max="100" step="1" aria-label="Brilho"></label>
    <div class="cw-row cw-hexrow"><span class="cw-chip"></span><input class="cw-hex field" type="text" spellcheck="false" maxlength="7" aria-label="Cor em hexadecimal"></div>
    <div class="cw-swatches">${swatches
      .map((s) => {
        const light = luminance(hexToRgb(s.hex)) > 0.6;
        return `<button type="button" class="cw-sw" data-hex="${s.hex}" title="${s.name} · ${s.hex}" style="--c:${s.hex};--t:${light ? '#123A5E' : '#fff'}"><b>${s.name}</b><small>${s.hex}</small></button>`;
      })
      .join('')}</div>`;

  const SIZE = 176;
  const disc = root.querySelector('.cw-disc');
  const cv = disc.querySelector('canvas');
  const marker = disc.querySelector('.cw-marker');
  const slider = root.querySelector('.cw-value');
  const hexIn = root.querySelector('.cw-hex');
  const chip = root.querySelector('.cw-chip');
  const sws = [...root.querySelectorAll('.cw-sw')];
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = cv.height = Math.round(SIZE * dpr);
  cv.style.width = cv.style.height = SIZE + 'px';
  const ctx = cv.getContext('2d');

  let hex = (value || '#FFFFFF').toUpperCase();
  let hsv = rgbToHsv(...hexToRgb(hex));
  let drawnV = -1;

  function draw() {
    if (drawnV === hsv.v) return;
    drawnV = hsv.v;
    const n = cv.width, R = n / 2;
    const img = ctx.createImageData(n, n), d = img.data;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - R, dy = y + 0.5 - R;
        const r = Math.hypot(dx, dy);
        if (r > R + 1) continue;
        const h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
        const [rr, gg, bb] = hsvToRgb(h, Math.min(1, r / R), hsv.v);
        const i = (y * n + x) * 4;
        d[i] = rr; d[i + 1] = gg; d[i + 2] = bb;
        d[i + 3] = 255 * clamp(R - r + 0.5, 0, 1);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function sync(skipHexField) {
    draw();
    const R = SIZE / 2, a = (hsv.h * Math.PI) / 180;
    marker.style.left = R + Math.cos(a) * hsv.s * R + 'px';
    marker.style.top = R - Math.sin(a) * hsv.s * R + 'px';
    marker.style.background = hex;
    slider.value = Math.round(hsv.v * 100);
    slider.style.setProperty('--top', rgbToHex(hsvToRgb(hsv.h, hsv.s, 1)));
    chip.style.background = hex;
    if (!skipHexField) hexIn.value = hex;
    for (const b of sws) b.classList.toggle('on', b.dataset.hex.toUpperCase() === hex);
  }
  function fromHsv() {
    hex = rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v));
    sync();
    onInput(hex);
  }
  function setHex(h, fire) {
    const rgb = hexToRgb(h);
    if (!rgb) return false;
    hex = rgbToHex(rgb);
    const next = rgbToHsv(...rgb);
    if (next.s === 0) next.h = hsv.h; // preserva o matiz em cinzas
    hsv = next;
    sync(fire === 'typing');
    if (fire) onInput(hex);
    return true;
  }

  let dragging = false;
  const pick = (e) => {
    const r = cv.getBoundingClientRect(), R = r.width / 2;
    const dx = e.clientX - r.left - R, dy = e.clientY - r.top - R;
    hsv.s = clamp(Math.hypot(dx, dy) / R, 0, 1);
    hsv.h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
    if (hsv.v < 0.04) hsv.v = 1;
    fromHsv();
  };
  disc.addEventListener('pointerdown', (e) => {
    dragging = true;
    disc.setPointerCapture(e.pointerId);
    pick(e);
  });
  disc.addEventListener('pointermove', (e) => dragging && pick(e));
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    onChange(hex);
  };
  disc.addEventListener('pointerup', stop);
  disc.addEventListener('pointercancel', stop);

  slider.addEventListener('input', () => { hsv.v = slider.value / 100; fromHsv(); });
  slider.addEventListener('change', () => onChange(hex));

  hexIn.addEventListener('input', () => {
    const v = hexIn.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) setHex(v, 'typing');
  });
  hexIn.addEventListener('change', () => {
    if (setHex(hexIn.value.trim(), true)) onChange(hex);
    else sync();
  });
  for (const b of sws) {
    b.addEventListener('click', () => {
      setHex(b.dataset.hex, true);
      onChange(hex);
    });
  }

  sync();
  return {
    setValue(h) { setHex(h, false); },
    get value() { return hex; },
  };
}
