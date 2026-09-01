// 03-layout.js — Canvas y paneles: tamaño, layout, snap, refit, arrastrar y redimensionar
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── Canvas size: expand in both axes to fit all panels ────────
function updateCanvasHeight() {
  // Only visible panels count — hidden ones belong to other workspaces and
  // keep stale positions that would inflate the canvas with phantom scroll.
  const panels = [...canvas.querySelectorAll('.panel')].filter(p => !p.dataset.hidden);
  if (!panels.length) { canvas.style.height = ''; canvas.style.width = ''; return; }
  const maxBottom = Math.max(...panels.map(p =>
    parseFloat(p.style.top) + parseFloat(p.style.height)));
  canvas.style.height = Math.max(gridWrap.clientHeight, maxBottom + 20) + 'px';
  // Same expansion to the right: panels can be dragged past the viewport edge
  // and the horizontal scrollbar follows them.
  const maxRight = Math.max(...panels.map(p =>
    parseFloat(p.style.left) + parseFloat(p.style.width)));
  canvas.style.width = Math.max(gridWrap.clientWidth, maxRight + 20) + 'px';
}

// ── Default layout ────────────────────────────────────────────
// Returns { l, t, w, h } as fractions 0..1 of the VIEWPORT
function defaultLayout(idx, total) {
  const G = 0.008;
  if (total === 1) return { l:G, t:G, w:1-2*G, h:1-2*G };
  const cols = total <= 2 ? 2 : total <= 4 ? 2 : 3;
  const rows = Math.ceil(total / cols);
  const ci = idx % cols, ri = Math.floor(idx / cols);
  const w = 1/cols - G*1.5, h = 1/rows - G*1.5;
  const l = ci*(1/cols) + G*0.75, t = ri*(1/rows) + G*0.75;
  return { l, t, w, h };
}

// ── Apply position from fractions of viewport ─────────────────
function applyLayout(panel, lay) {
  const W = gridWrap.clientWidth, H = gridWrap.clientHeight;
  panel.style.left   = (lay.l * W) + 'px';
  panel.style.top    = (lay.t * H) + 'px';
  panel.style.width  = (lay.w * W) + 'px';
  panel.style.height = (lay.h * H) + 'px';
}

// ── Snap to 1% grid ───────────────────────────────────────────
function snap(v) { return Math.round(v * 100) / 100; }

// ── Refit ─────────────────────────────────────────────────────
function scheduleRefit() {
  Object.keys(fits).forEach(id => debouncedFit(id, 80));
}

// Raise panel to top. Renormalize before z-indexes reach the modals' z:500 —
// otherwise, after enough clicks, panels render ON TOP of every modal.
function raise(panel) {
  panel.style.zIndex = ++zTop;
  if (zTop > 400) {
    const ps = [...canvas.querySelectorAll('.panel')]
      .sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));
    zTop = 10;
    ps.forEach(p => p.style.zIndex = ++zTop);
  }
}

// ── DRAG MOVE (header) ────────────────────────────────────────
function initDragMove(panel, header) {
  header.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    e.preventDefault(); raise(panel);
    const sx = e.clientX, sy = e.clientY;
    const sl = parseFloat(panel.style.left), st = parseFloat(panel.style.top);
    panel.style.opacity = '.88';

    function onMove(e) {
      // Sin tope a la derecha: el canvas crece (updateCanvasHeight) y aparece
      // scroll horizontal, igual que ya pasa hacia abajo.
      const l = Math.max(0, sl + e.clientX - sx);
      const t = Math.max(0, st + e.clientY - sy);
      panel.style.left = l + 'px';
      panel.style.top  = t + 'px';
    }
    function onUp() {
      panel.style.opacity = '1';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Moving doesn't change any panel's size — no terminal refit needed
      updateCanvasHeight(); persistToWorkspace();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── DRAG RESIZE (edges + corner) ─────────────────────────────
function initResizeHandle(panel, rh, dirs) {
  rh.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation(); raise(panel);
    const W = gridWrap.clientWidth, H = gridWrap.clientHeight;
    const sx = e.clientX, sy = e.clientY;
    const sl = parseFloat(panel.style.left), st = parseFloat(panel.style.top);
    const sw = parseFloat(panel.style.width), sh = parseFloat(panel.style.height);

    function onMove(e) {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (dirs.includes('r')) panel.style.width  = Math.max(200, snap((sw+dx)/W)*W) + 'px';
      if (dirs.includes('b')) panel.style.height = Math.max(120, snap((sh+dy)/H)*H) + 'px';
      if (dirs.includes('l')) {
        const newW = Math.max(200, snap((sw-dx)/W)*W);
        panel.style.left  = (sl + sw - newW) + 'px';
        panel.style.width = newW + 'px';
      }
      if (dirs.includes('t')) {
        const newH = Math.max(120, snap((sh-dy)/H)*H);
        panel.style.top    = (st + sh - newH) + 'px';
        panel.style.height = newH + 'px';
      }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Only this panel changed size; its own ResizeObserver also fires
      updateCanvasHeight(); debouncedFit(panel.dataset.id, 0); persistToWorkspace();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// xterm.js delivers selection as Latin-1 encoded bytes (each byte as a char code ≤ 255).
// Decode those bytes as UTF-8 so Spanish/special chars paste correctly.
// If the string already contains proper Unicode (code points > 255), return it unchanged.
function decodeXtermSelection(sel) {
  if (!sel) return sel;
  if ([...sel].some(c => c.codePointAt(0) > 255)) return sel;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(sel, c => c.charCodeAt(0))
    );
  } catch { return sel; }
}

