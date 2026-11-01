// 15-web.js — Paneles web: un navegador real (Chromium en el servidor) dentro
// de un panel. Aquí solo se pinta la imagen que manda el servidor y se le
// devuelven mouse, rueda, teclado y pegado. Ver lib/live.js.
// Script clásico: comparte scope global con los demás; el orden de carga importa.

const webPanels = {}; // sessionId -> { el, img, notice, urlEl, w, h, status, timer }

const WEB_PRESETS = [
  { name: 'Claude', url: 'https://claude.ai/code' },
  { name: 'ChatGPT / Codex', url: 'https://chatgpt.com/codex' },
  { name: 'Gemini', url: 'https://gemini.google.com' },
];

function buildWebPanel(s, lay) {
  lay = getSavedLayout(s.id) || lay;
  panelCount++;
  const panel = document.createElement('div');
  panel.className = 'panel panel-web'; panel.dataset.id = s.id;
  panel.style.zIndex = ++zTop;
  panel.innerHTML = `
    <div class="ph">
      <span class="ph-id">WEB:${String(panelCount).padStart(2,'0')}</span>
      <div class="dot ${s.status || 'running'}"></div>
      <span class="ph-name">${escHtml((s.name || 'web').toUpperCase())}</span>
      <span class="ph-sep">·</span>
      <span class="ph-sub">${s.subtitle ? escHtml(s.subtitle) : ''}</span>
      <span class="ph-cwd lw-url" title="Doble clic para cambiar la URL">${escHtml(s.url || '')}</span>
      <button class="pbtn lw-nav" data-a="back" title="Atrás">←</button>
      <button class="pbtn lw-nav" data-a="reload" title="Recargar">⟳</button>
      <a class="pbtn lw-ext" href="${escHtml(s.url || '#')}" target="_blank" rel="noreferrer" title="Abrir en el navegador">↗</a>
      <button class="pbtn closebtn" title="Cerrar">✕</button>
    </div>
    <div class="lw" id="lw-${s.id}" tabindex="0">
      <img class="lw-frame" alt="" draggable="false">
      <div class="lw-notice">Abriendo navegador…</div>
    </div>
    <div class="rh rh-r"></div><div class="rh rh-b"></div><div class="rh rh-l"></div><div class="rh rh-t"></div><div class="rh rh-br"></div>`;
  canvas.appendChild(panel);
  applyLayout(panel, lay);
  updateCanvasHeight();
  initDragMove(panel, panel.querySelector('.ph'));
  initResizeHandle(panel, panel.querySelector('.rh-r'), ['r']);
  initResizeHandle(panel, panel.querySelector('.rh-b'), ['b']);
  initResizeHandle(panel, panel.querySelector('.rh-l'), ['l']);
  initResizeHandle(panel, panel.querySelector('.rh-t'), ['t']);
  initResizeHandle(panel, panel.querySelector('.rh-br'), ['r','b']);
  panel.addEventListener('mousedown', e => {
    raise(panel); setActiveSession(s.id);
    if (e.target.closest('button') || e.target.closest('.ph-sub')) return;
    setTimeout(() => { if (!document.activeElement?.isContentEditable) el.focus(); }, 0);
  });
  panel.querySelector('.closebtn').addEventListener('click', () =>
    ws.send(JSON.stringify({ type: 'close', sessionId: s.id })));

  // Nota editable, igual que en las terminales
  const subEl = panel.querySelector('.ph-sub');
  let subOriginal = s.subtitle || '';
  subEl.addEventListener('dblclick', e => { e.stopPropagation(); subEl.contentEditable = 'true'; subEl.focus(); });
  subEl.addEventListener('mousedown', e => { if (subEl.contentEditable === 'true') e.stopPropagation(); });
  subEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); subEl.blur(); }
    if (e.key === 'Escape') { subEl.textContent = subOriginal; subEl.blur(); }
  });
  subEl.addEventListener('blur', () => {
    subEl.contentEditable = 'false';
    subOriginal = subEl.textContent.trim();
    ws.send(JSON.stringify({ type: 'save-subtitle', sessionId: s.id, subtitle: subOriginal }));
  });

  const el = panel.querySelector('.lw');
  const W = webPanels[s.id] = {
    el, img: el.querySelector('.lw-frame'), notice: el.querySelector('.lw-notice'),
    urlEl: panel.querySelector('.lw-url'), ext: panel.querySelector('.lw-ext'),
    url: s.url, w: 0, h: 0, status: null, timer: null, focused: false,
  };

  // Navegación
  panel.querySelectorAll('.lw-nav').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    ws.send(JSON.stringify({ type: 'live-nav', sessionId: s.id, action: b.dataset.a }));
  }));
  W.urlEl.addEventListener('dblclick', e => {
    e.stopPropagation();
    const url = prompt('URL del panel:', W.url || 'https://');
    if (!url || !/^https?:\/\//i.test(url)) return;
    W.url = url; W.urlEl.textContent = url; W.ext.href = url;
    ws.send(JSON.stringify({ type: 'live-nav', sessionId: s.id, action: 'goto', url }));
    ws.send(JSON.stringify({ type: 'save-web-url', sessionId: s.id, url }));
  });

  // Tamaño → el servidor ajusta viewport y screencast (debounce)
  new ResizeObserver(() => liveRequest(s.id, 150)).observe(el);
  // Visibilidad (cambio de workspace oculta el panel con data-hidden)
  new MutationObserver(() => liveRequest(s.id, 0)).observe(panel, { attributes: true, attributeFilter: ['data-hidden'] });

  liveInput(el, s.id);
  liveRequest(s.id, 0);
}

function liveRequest(id, delay) {
  const W = webPanels[id];
  if (!W) return;
  clearTimeout(W.timer);
  W.timer = setTimeout(() => {
    const panel = W.el.closest('.panel');
    const r = W.el.getBoundingClientRect();
    const streaming = !panel.dataset.hidden && document.visibilityState === 'visible' && r.width > 0;
    W.w = Math.round(r.width); W.h = Math.round(r.height);
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'live-open', sessionId: id, url: W.url, width: W.w || 900, height: W.h || 500,
      dpr: window.devicePixelRatio || 1, streaming }));
  }, delay);
}
document.addEventListener('visibilitychange', () => Object.keys(webPanels).forEach(id => liveRequest(id, 0)));

// Escribirle a un panel web desde fuera (dictado por voz): texto + Enter
function liveType(id, text, enter) {
  ws.send(JSON.stringify({ type: 'live-text', sessionId: id, text }));
  if (enter) {
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' };
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'live-key', sessionId: id, event: { type: 'keyDown', ...k } }));
      ws.send(JSON.stringify({ type: 'live-key', sessionId: id, event: { type: 'keyUp', ...k } }));
    }, 150);
  }
}

// ── Entrada: mouse, rueda, teclado y pegado hacia el Chromium ─
const LIVE_BUTTONS = ['left', 'middle', 'right'];
function liveMods(e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }
function liveInput(el, id) {
  const send = (type, extra) => ws.send(JSON.stringify({ type, sessionId: id, ...extra }));
  // La imagen se dibuja con object-fit: contain; el punto se mide sobre la
  // imagen real (no la caja), así nunca se desfasa aunque cambie el aspecto.
  const img = el.querySelector('.lw-frame');
  const clamp = v => Math.min(1, Math.max(0, v));
  const point = e => {
    const r = el.getBoundingClientRect();
    let { left, top, width, height } = r;
    if (img.naturalWidth && img.naturalHeight) {
      const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
      width = img.naturalWidth * s; height = img.naturalHeight * s;
      left = r.left + (r.width - width) / 2; top = r.top + (r.height - height) / 2;
    }
    return { x: clamp((e.clientX - left) / width), y: clamp((e.clientY - top) / height) };
  };
  const pressed = e => (e.buttons & 1 ? 'left' : e.buttons & 4 ? 'middle' : e.buttons & 2 ? 'right' : 'none');
  const mouse = (type, e, extra) => send('live-mouse', { event: { type, ...point(e), buttons: e.buttons, modifiers: liveMods(e), ...extra } });
  let frame = 0;
  el.addEventListener('pointerdown', e => {
    el.focus(); try { el.setPointerCapture(e.pointerId); } catch {}
    if (webPanels[id]?.status === 'sleeping') liveRequest(id, 0);
    mouse('mousePressed', e, { button: LIVE_BUTTONS[e.button] || 'left', clickCount: e.detail || 1 });
  });
  el.addEventListener('pointerup', e => mouse('mouseReleased', e, { button: LIVE_BUTTONS[e.button] || 'left', clickCount: e.detail || 1 }));
  el.addEventListener('pointermove', e => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; mouse('mouseMoved', e, { button: pressed(e) }); });
  });
  el.addEventListener('wheel', e => { e.preventDefault(); mouse('mouseWheel', e, { deltaX: e.deltaX, deltaY: e.deltaY }); }, { passive: false });
  const onKey = e => {
    // Cmd/Ctrl+V pasa de largo para que llegue el evento paste con el portapapeles real
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return;
    if (e.key === 'Escape' && !webPanels[id]?.focused) return;
    e.preventDefault(); e.stopPropagation();
    const up = e.type === 'keyup';
    const plain = !e.metaKey && !e.ctrlKey;
    const text = !up && plain ? (e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : undefined) : undefined;
    send('live-key', { event: { type: up ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown', key: e.key, code: e.code, text,
      unmodifiedText: text, windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode, modifiers: liveMods(e), autoRepeat: e.repeat } });
  };
  el.addEventListener('keydown', onKey);
  el.addEventListener('keyup', onKey);
  el.addEventListener('focus', () => { if (webPanels[id]) webPanels[id].focused = true; });
  el.addEventListener('blur', () => { if (webPanels[id]) webPanels[id].focused = false; });
  el.addEventListener('paste', e => {
    e.preventDefault();
    const t = e.clipboardData?.getData('text');
    if (t) send('live-text', { text: t });
  });
  el.addEventListener('contextmenu', e => e.preventDefault());
}

// ── Mensajes del servidor (desde 11-ws.js) ────────────────────
function liveOnFrame(msg) {
  const W = webPanels[msg.sessionId];
  if (W) W.img.src = 'data:image/jpeg;base64,' + msg.data;
}
const LIVE_TEXT = {
  launching: 'Abriendo navegador…',
  sleeping: 'Dormido para ahorrar memoria — se despierta solo al verlo',
  error: 'No se pudo abrir el navegador',
};
function liveOnStatus(msg) {
  const W = webPanels[msg.sessionId];
  if (!W) return;
  W.status = msg.state;
  if (msg.url && /^https?:/.test(msg.url)) { W.ext.href = msg.url; W.urlEl.textContent = msg.url; W.urlEl.title = msg.url; }
  if (msg.state === 'ready') { W.notice.style.display = 'none'; return; }
  if (msg.state === 'sleeping') { // si se ve, se despierta solo (otro cliente pudo dormirlo)
    const panel = W.el.closest('.panel');
    if (!panel.dataset.hidden && document.visibilityState === 'visible') liveRequest(msg.sessionId, 400);
  }
  W.notice.style.display = 'flex';
  W.notice.textContent = (LIVE_TEXT[msg.state] || msg.state) + (msg.error ? ': ' + msg.error : '');
}
