// 300 dpi export: each sheet becomes its own file, drawn from the original files
// (not the previews). An image that spans two sheets is cut into each one at its
// exact position — which is what makes printing easy.
import { decodeOriginal, stepDown, toBlob } from './images.js?v=202611232200';

const intersects = (a, r) => a.x < r.x + r.w && a.x + a.w > r.x && a.y < r.y + r.h && a.y + a.h > r.y;

export function sheetPixels(wmm, hmm, dpi) {
  const k = dpi / 25.4;
  return { W: Math.round(wmm * k), H: Math.round(hmm * k) };
}

// `embed: false` + a lower `quality` is used for the book preview (fast, light files).
export async function renderSheets({ sheets, items, assets, bg, dpi, format, name, onProgress, embed = true, quality = 0.95 }) {
  const k = dpi / 25.4;
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext = format === 'png' ? 'png' : 'jpg';
  const cache = new Map(); // assetId -> decoded original (reused across neighbouring sheets)
  const out = [];
  try {
    for (let i = 0; i < sheets.length; i++) {
      const r = sheets[i];
      const { W, H } = sheetPixels(r.w, r.h, dpi);
      onProgress?.(i, sheets.length, W, H);
      await new Promise((res) => setTimeout(res, 30)); // let the screen paint the progress

      const need = items.filter((it) => assets.has(it.assetId) && intersects(it, r));
      for (const [id, d] of cache) {
        if (!need.some((it) => it.assetId === id)) { d.close(); cache.delete(id); }
      }

      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { alpha: format === 'png' });
      if (!ctx || !canvasWorks(ctx, W, H)) {
        c.width = c.height = 0;
        throw new Error(`Sheet ${i + 1} (${W} × ${H} px) exceeds this browser's memory limit. Try Chrome or use smaller sheets.`);
      }
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      for (const it of need) {
        const a = assets.get(it.assetId);
        let d = cache.get(a.id);
        if (!d) { d = await decodeOriginal(a.file, a.nw, a.nh); cache.set(a.id, d); }
        // object-fit: cover + focal point (fx, fy) — same math as on screen
        const sc = Math.max(it.w / a.nw, it.h / a.nh); // mm por pixel do original
        const dw = a.nw * sc, dh = a.nh * sc;
        const ox = (it.w - dw) * it.fx, oy = (it.h - dh) * it.fy;
        const tw = dw * k, th = dh * k;
        const step = stepDown(d.src, a.nw, a.nh, tw, th);
        ctx.save();
        ctx.beginPath();
        ctx.rect((it.x - r.x) * k, (it.y - r.y) * k, it.w * k, it.h * k);
        ctx.clip();
        ctx.drawImage(step.src, (it.x - r.x + ox) * k, (it.y - r.y + oy) * k, tw, th);
        ctx.restore();
        step.release();
      }

      let blob = await toBlob(c, mime, quality);
      c.width = c.height = 0; // free the sheet's memory before the next one
      if (embed) blob = await embedDpi(blob, dpi, format);
      out.push({ name: `${name}-sheet-${String(i + 1).padStart(2, '0')}.${ext}`, blob, W, H });
    }
  } finally {
    for (const d of cache.values()) d.close();
  }
  return out;
}

// If the canvas did not fit in memory, the browser silently returns a "dead" canvas.
function canvasWorks(ctx, W, H) {
  ctx.fillStyle = '#00FF00';
  ctx.fillRect(W - 1, H - 1, 1, 1);
  const px = ctx.getImageData(W - 1, H - 1, 1, 1).data;
  return px[1] === 255 && px[3] === 255;
}

// ---------- 300 dpi metadata (so the print shop opens it at the right size) ----------
async function embedDpi(blob, dpi, format) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const out = format === 'png' ? pngWithPhys(bytes, dpi) : jpegWithDensity(bytes, dpi);
  return new Blob([out], { type: format === 'png' ? 'image/png' : 'image/jpeg' });
}

export function jpegWithDensity(b, dpi) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const isJfif = b[2] === 0xff && b[3] === 0xe0 && b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0;
  if (isJfif) {
    b[13] = 1; // units: dots per inch
    b[14] = dpi >> 8; b[15] = dpi & 255;
    b[16] = dpi >> 8; b[17] = dpi & 255;
    return b;
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
  const out = new Uint8Array(b.length + app0.length);
  out.set(b.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(b.subarray(2), 2 + app0.length);
  return out;
}

export function pngWithPhys(b, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, ihdrEnd = -1;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const end = p + 12 + len;
    if (type === 'IHDR') ihdrEnd = end;
    if (type === 'pHYs') {
      dv.setUint32(p + 8, ppm); dv.setUint32(p + 12, ppm); b[p + 16] = 1;
      dv.setUint32(p + 17, crc32(b.subarray(p + 4, p + 17)));
      return b;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    p = end;
  }
  if (ihdrEnd < 0) return b;
  const chunk = new Uint8Array(21);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  cv.setUint32(8, ppm); cv.setUint32(12, ppm); chunk[16] = 1;
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(b.length + 21);
  out.set(b.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(b.subarray(ihdrEnd), ihdrEnd + 21);
  return out;
}

// ---------- uncompressed ZIP (the images are already compressed) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function zipStore(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const crc = crc32(data);
    const name = enc.encode(f.name);
    const lh = new Uint8Array(30 + name.length);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
    v.setUint16(8, 0, true); v.setUint16(10, time, true); v.setUint16(12, date, true);
    v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true);
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
    lh.set(name, 30);
    parts.push(lh, f.blob);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
