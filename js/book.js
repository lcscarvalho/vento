// Book preview: shows the album closed and lets you flip through it page by page.
// Each leaf is a two-sided card that turns around the spine. Side-by-side sheets
// bind on the left (like a book); stacked sheets bind on top (like a calendar).
//
// Page order on the leaves:
//  - "plain" cover:  [cover, sheet 1, sheet 2, …, sheet n, (blank), back cover]
//                    → sheets 1–2, 3–4… open as spreads, matching the desk layout.
//  - "sheet" cover:  [sheet 1, sheet 2, …, sheet n, (blank)]
//                    → sheet 1 is the front cover, spreads are 2–3, 4–5…
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function createBook(root, { onCoverChange = () => {}, onClose = () => {} } = {}) {
  root.innerHTML = `
    <div class="bv-bar">
      <div class="bv-title"><span class="mini">Preview</span><span class="bv-name">Your <i>album</i></span></div>
      <div class="bv-cover-wrap">
        <span class="mini">Cover</span>
        <div class="seg bv-cover">
          <button data-cover="plain" title="A plain hard cover; sheets 1–2, 3–4… open as spreads">Plain cover</button>
          <button data-cover="sheet" title="Sheet 1 is printed as the front cover; spreads are 2–3, 4–5…">Sheet 1 as cover</button>
        </div>
      </div>
      <button class="btn icon bv-close" title="Close (Esc)" aria-label="Close preview"><svg class="ico"><use href="#i-close"/></svg></button>
    </div>
    <div class="bv-stage">
      <div class="book"></div>
      <div class="bv-loading"><span class="mini">Preview</span><span class="modal-big">Binding</span><span class="modal-script">your book</span><span class="meta-line bv-progress"></span></div>
    </div>
    <div class="bv-nav">
      <button class="btn icon bv-first" title="Front cover (Home)" aria-label="Front cover"><svg class="ico"><use href="#i-first"/></svg></button>
      <button class="btn icon bv-prev" title="Previous (←)" aria-label="Previous page"><svg class="ico"><use href="#i-prev"/></svg></button>
      <div class="bv-where"><b class="bv-label">Front cover</b><span class="bv-count"></span></div>
      <button class="btn icon bv-next" title="Next (→ or Space)" aria-label="Next page"><svg class="ico"><use href="#i-next"/></svg></button>
      <button class="btn icon bv-last" title="Back cover (End)" aria-label="Back cover"><svg class="ico"><use href="#i-last"/></svg></button>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const stage = $('.bv-stage'), book = $('.book'), loading = $('.bv-loading');
  let pages = [], leaves = [], N = 0, k = 0, open = false, turnZ = 1000;
  let dims = { w: 1, h: 1, binding: 'left' };

  function face(p, side) {
    const f = document.createElement('div');
    f.className = 'face ' + side;
    if (p.kind === 'sheet') {
      const img = new Image();
      img.src = p.url;
      img.alt = `Sheet ${p.n}`;
      img.draggable = false;
      f.append(img);
    } else if (p.kind === 'cover' || p.kind === 'back') {
      f.classList.add('cloth');
    } else {
      f.classList.add('blank');
    }
    return f;
  }

  function setup({ urls, w, h, binding, bg, cover, keepPosition }) {
    const sheet = (u, i) => ({ kind: 'sheet', n: i + 1, url: u });
    if (cover === 'sheet') {
      pages = urls.map(sheet);
      if (pages.length % 2) pages.push({ kind: 'blank' });
    } else {
      pages = [{ kind: 'cover' }, ...urls.map(sheet)];
      if ((pages.length + 1) % 2) pages.push({ kind: 'blank' });
      pages.push({ kind: 'back' });
    }
    N = pages.length / 2;
    k = keepPosition ? clamp(k, 0, N) : 0;
    dims = { w, h, binding };
    for (const b of root.querySelectorAll('[data-cover]')) b.classList.toggle('on', b.dataset.cover === cover);

    book.className = 'book instant ' + binding;
    book.style.setProperty('--page-bg', bg);
    book.textContent = '';
    leaves = [];
    for (let i = 0; i < N; i++) {
      const leaf = document.createElement('div');
      leaf.className = 'leaf';
      leaf.append(face(pages[2 * i], 'front'), face(pages[2 * i + 1], 'back'));
      leaf.addEventListener('transitionend', (e) => {
        if (e.target === leaf && e.propertyName === 'transform') restZ(i);
      });
      book.append(leaf);
      leaves.push(leaf);
    }
    leaves.forEach((leaf, i) => {
      leaf.classList.toggle('flipped', i < k);
      restZ(i);
    });
    layout();
    update();
    loading.hidden = true;
    void book.offsetWidth; // apply the starting position without animating it
    book.classList.remove('instant');
  }

  // Resting stack order: unturned leaves on the right (first on top), turned ones on the left (last on top).
  function restZ(i) {
    const leaf = leaves[i];
    if (leaf) leaf.style.zIndex = leaf.classList.contains('flipped') ? i + 1 : N - i;
  }

  function layout() {
    if (!open || !N) return;
    const availW = stage.clientWidth - 96, availH = stage.clientHeight - 64;
    const left = dims.binding === 'left';
    const bw = left ? dims.w * 2 : dims.w, bh = left ? dims.h : dims.h * 2;
    const s = Math.max(0.01, Math.min(availW / bw, availH / bh));
    book.style.width = bw * s + 'px';
    book.style.height = bh * s + 'px';
  }

  function update() {
    // A closed book only shows one half: slide it so that half sits in the middle.
    const shift = k === 0 ? -25 : k === N ? 25 : 0;
    book.style.transform = dims.binding === 'left' ? `translateX(${shift}%)` : `translateY(${shift}%)`;

    let label, count = '';
    const sheetsIn = (...ps) => ps.filter((p) => p?.kind === 'sheet').map((p) => p.n);
    if (k === 0) {
      label = 'Front cover';
      if (pages[0]?.kind === 'sheet') count = 'Sheet 1';
    } else if (k === N) {
      label = 'Back cover';
      const last = pages[pages.length - 1];
      if (last?.kind === 'sheet') count = `Sheet ${last.n}`;
    } else {
      const ns = sheetsIn(pages[2 * k - 1], pages[2 * k]);
      label = ns.length === 2 ? `Sheets ${ns[0]}–${ns[1]}` : ns.length ? `Sheet ${ns[0]}` : 'Endpapers';
      count = `Spread ${k} of ${N - 1}`;
    }
    $('.bv-label').textContent = label;
    $('.bv-count').textContent = count;
    $('.bv-prev').disabled = $('.bv-first').disabled = k === 0;
    $('.bv-next').disabled = $('.bv-last').disabled = k === N;
  }

  function turn(i, forward) {
    const leaf = leaves[i];
    leaf.style.zIndex = ++turnZ; // the turning leaf passes over everything
    leaf.classList.toggle('flipped', forward);
  }
  function next() {
    if (k >= N) return;
    turn(k, true);
    k++;
    update();
  }
  function prev() {
    if (k <= 0) return;
    k--;
    turn(k, false);
    update();
  }
  function goTo(target) {
    target = clamp(target, 0, N);
    const step = target > k ? next : prev;
    const n = Math.abs(target - k);
    for (let j = 0; j < n; j++) setTimeout(step, j * 90); // riffle through the pages
  }

  // Click a side of the book to turn that way; swipe on touch screens.
  let down = null;
  stage.addEventListener('pointerdown', (e) => { if (!loading.hidden) return; down = { x: e.clientX, y: e.clientY }; });
  stage.addEventListener('pointerup', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    down = null;
    const vertical = dims.binding === 'top';
    const d = vertical ? dy : dx;
    if (Math.abs(d) > 40) return d < 0 ? next() : prev();
    const r = book.getBoundingClientRect();
    // when closed, the visible half is the whole target
    if (k === 0) return next();
    if (k === N) return prev();
    const mid = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
    (vertical ? e.clientY : e.clientX) > mid ? next() : prev();
  });

  $('.bv-next').addEventListener('click', next);
  $('.bv-prev').addEventListener('click', prev);
  $('.bv-first').addEventListener('click', () => goTo(0));
  $('.bv-last').addEventListener('click', () => goTo(N));
  $('.bv-close').addEventListener('click', () => api.hide());
  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cover]')?.dataset.cover;
    if (c && !e.target.closest('[data-cover]').classList.contains('on')) onCoverChange(c);
  });
  new ResizeObserver(layout).observe(stage);

  const api = {
    get isOpen() { return open; },
    show() {
      open = true;
      root.hidden = false;
      loading.hidden = false;
      $('.bv-progress').textContent = '';
    },
    progress(text) { $('.bv-progress').textContent = text; },
    setup,
    hide() {
      if (!open) return;
      open = false;
      root.hidden = true;
      onClose();
    },
    key(e) {
      const key = e.key;
      if (key === 'Escape') api.hide();
      else if (key === 'ArrowRight' || key === 'ArrowDown' || key === ' ' || key === 'PageDown') next();
      else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') prev();
      else if (key === 'Home') goTo(0);
      else if (key === 'End') goTo(N);
      else return;
      e.preventDefault();
    },
  };
  return api;
}
