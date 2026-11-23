// High-resolution image loading.
// The original file is never recompressed: it is kept as-is and only decoded at
// export. On screen we use a reduced preview (long edge up to 2400 px).
const PREVIEW_MAX = 2400;

export function loadImg(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('format not supported by this browser'));
    img.src = url;
  });
}

export function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not encode the image'))), type, quality)
  );
}

// Decodes the original file with EXIF orientation applied.
// Returns { src, close } — src is an ImageBitmap or an HTMLImageElement.
export async function decodeOriginal(file, nw, nh) {
  try {
    const b = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (b.width === nw && b.height === nh) return { src: b, close: () => b.close() };
    b.close();
  } catch { /* fall back to <img> */ }
  const url = URL.createObjectURL(file);
  const img = await loadImg(url);
  try { await img.decode(); } catch { /* already loaded */ }
  return { src: img, close: () => URL.revokeObjectURL(url) };
}

// Downscales in halving steps to keep quality on large reductions
// (e.g. a 9000 px photo drawn at 1200 px).
export function stepDown(src, sw, sh, tw, th) {
  let cur = src, cw = sw, ch = sh;
  while (cw / 2 >= tw * 1.25 && ch / 2 >= th * 1.25) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cw / 2));
    c.height = Math.max(1, Math.round(ch / 2));
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, c.width, c.height);
    if (cur !== src && cur instanceof HTMLCanvasElement) cur.width = cur.height = 0;
    cur = c; cw = c.width; ch = c.height;
  }
  return { src: cur, release: () => { if (cur !== src) cur.width = cur.height = 0; } };
}

export async function readImage(file) {
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await loadImg(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) throw new Error('empty image');
  const preview = await makePreview(file, nw, nh);
  return { nw, nh, preview };
}

async function makePreview(file, nw, nh) {
  const s = Math.min(1, PREVIEW_MAX / Math.max(nw, nh));
  const pw = Math.max(1, Math.round(nw * s)), ph = Math.max(1, Math.round(nh * s));
  const d = await decodeOriginal(file, nw, nh);
  const c = document.createElement('canvas');
  try {
    const step = stepDown(d.src, nw, nh, pw, ph);
    c.width = pw; c.height = ph;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(step.src, 0, 0, pw, ph);
    step.release();
    let blob = await toBlob(c, 'image/webp', 0.88);
    if (blob.type !== 'image/webp') {
      // Safari can't encode WebP: PNG keeps transparency, JPEG for the rest
      blob = await toBlob(c, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.88);
    }
    return blob;
  } finally {
    c.width = c.height = 0;
    d.close();
  }
}

export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;
  return `${(n / 1024 ** 3).toLocaleString('en-US', { maximumFractionDigits: 2 })} GB`;
}
