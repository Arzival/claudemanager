// 02-workspaces.js — Workspaces: crear/cambiar, fondos, transparencia y scroll por workspace
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── Workspace system ──────────────────────────────────────────
const WS_KEY = 'claudemgr-ws';
let wsStore = { workspaces: {}, active: null };

function loadWsStore() {
  try { wsStore = JSON.parse(localStorage.getItem(WS_KEY) || '{"workspaces":{},"active":null}'); }
  catch { wsStore = { workspaces: {}, active: null }; }
}

function saveWsStore() {
  localStorage.setItem(WS_KEY, JSON.stringify(wsStore));
}

// Merge fields into a workspace WITHOUT dropping its bg / opacity settings
function writeWs(name, fields) {
  wsStore.workspaces[name] = { ...(wsStore.workspaces[name] || {}), ...fields };
}

// ── Per-workspace background & terminal transparency ──────────
// bgOpacity = alpha of the terminal background (1 = solid, lower = see-through)
function activeWs() { return wsStore.active ? wsStore.workspaces[wsStore.active] : null; }
function wsBgAlpha() {
  const ws = activeWs();
  return (ws && typeof ws.bgOpacity === 'number') ? ws.bgOpacity : 1;
}
function applyTermOpacity(id) {
  const t = terms[id];
  const a = wsBgAlpha();
  const rgba = `rgba(${TERM_BG_RGB},${a})`;
  if (t) t.options.theme = { ...TERM_THEME, background: rgba };
  const p = document.querySelector(`.panel[data-id="${id}"]`);
  if (p) p.style.background = rgba;
}
// Re-theming every terminal is expensive; coalesce rapid calls (opacity slider)
// into one application per animation frame.
let termOpacityRaf = null;
function applyAllTermOpacity() {
  if (termOpacityRaf) return;
  termOpacityRaf = requestAnimationFrame(() => {
    termOpacityRaf = null;
    Object.keys(terms).forEach(applyTermOpacity);
  });
}
function applyWorkspaceBg(bgName) {
  const bg = bgName !== undefined ? bgName : (activeWs() && activeWs().bg);
  gridWrap.style.backgroundImage    = bg ? `url('/fondos/${encodeURIComponent(bg)}')` : '';
  gridWrap.style.backgroundSize     = 'cover';
  gridWrap.style.backgroundPosition = 'center';
  gridWrap.style.backgroundRepeat   = 'no-repeat';
}
function applyWorkspaceTheme() { applyWorkspaceBg(); applyAllTermOpacity(); }

function snapshotLayout() {
  const W = gridWrap.clientWidth, H = gridWrap.clientHeight;
  const layout = {};
  canvas.querySelectorAll('.panel').forEach(p => {
    if (!p.dataset.hidden) {
      layout[p.dataset.id] = {
        l: parseFloat(p.style.left)  / W,
        t: parseFloat(p.style.top)   / H,
        w: parseFloat(p.style.width) / W,
        h: parseFloat(p.style.height)/ H,
      };
    }
  });
  return layout;
}

function visiblePanelIds() {
  return [...canvas.querySelectorAll('.panel')]
    .filter(p => !p.dataset.hidden).map(p => p.dataset.id);
}

// Save current state into active workspace
let wsSaveTimer;
function persistToWorkspace() {
  clearTimeout(wsSaveTimer);
  wsSaveTimer = setTimeout(() => {
    if (!wsStore.active) return;
    writeWs(wsStore.active, { panelIds: visiblePanelIds(), layout: snapshotLayout() });
    saveWsStore();
  }, 300);
}

// ── Scroll por workspace ──────────────────────────────────────
// El scroll vive en #grid-wrap (compartido), así que sin esto cambiar de
// workspace hereda el scroll del anterior. Cada workspace guarda su posición
// y se restaura al volver (también sobrevive recargas vía localStorage).
let wsScrollTimer;
gridWrap.addEventListener('scroll', () => {
  clearTimeout(wsScrollTimer);
  wsScrollTimer = setTimeout(() => {
    if (!wsStore.active) return;
    writeWs(wsStore.active, { scroll: { x: gridWrap.scrollLeft, y: gridWrap.scrollTop } });
    saveWsStore();
  }, 200);
});

function restoreWsScroll() {
  const sc = activeWs()?.scroll;
  // El alto del canvas se recalcula al aplicar el layout; restaurar en el
  // siguiente frame para que el clamp del navegador use el tamaño final.
  requestAnimationFrame(() => {
    gridWrap.scrollLeft = sc ? sc.x : 0;
    gridWrap.scrollTop  = sc ? sc.y : 0;
  });
}

function applyWorkspace(name) {
  const ws = wsStore.workspaces[name];
  if (!ws) return;
  const W = gridWrap.clientWidth, H = gridWrap.clientHeight;
  canvas.querySelectorAll('.panel').forEach(p => {
    const id = p.dataset.id;
    if (ws.panelIds.includes(id)) {
      delete p.dataset.hidden;
      p.style.visibility = ''; p.style.pointerEvents = '';
      if (ws.layout[id]) {
        p.style.left   = (ws.layout[id].l * W) + 'px';
        p.style.top    = (ws.layout[id].t * H) + 'px';
        p.style.width  = (ws.layout[id].w * W) + 'px';
        p.style.height = (ws.layout[id].h * H) + 'px';
      }
      setTimeout(() => { debouncedFit(id, 0); try { terms[id]?.scrollToBottom(); } catch {}; }, 80);
    } else {
      p.dataset.hidden = '1';
      p.style.visibility = 'hidden'; p.style.pointerEvents = 'none';
    }
  });
  updateCanvasHeight();
}

function switchWorkspace(name) {
  // Cancela el guardado diferido de scroll: si disparara después del cambio,
  // escribiría el scroll del workspace viejo en el nuevo.
  clearTimeout(wsScrollTimer);
  if (wsStore.active) {
    writeWs(wsStore.active, {
      panelIds: visiblePanelIds(), layout: snapshotLayout(),
      scroll: { x: gridWrap.scrollLeft, y: gridWrap.scrollTop },
    });
  }
  wsStore.active = name;
  saveWsStore();
  applyWorkspace(name);
  restoreWsScroll();
  applyWorkspaceTheme();
  renderWsBar();
}

function newWorkspace() {
  const name = prompt('Nombre del workspace:');
  if (!name?.trim()) return;
  const n = name.trim().toUpperCase();
  if (wsStore.workspaces[n] && !confirm(`"${n}" ya existe. ¿Sobreescribir?`)) return;
  // Save current before switching
  clearTimeout(wsScrollTimer);
  if (wsStore.active)
    writeWs(wsStore.active, {
      panelIds: visiblePanelIds(), layout: snapshotLayout(),
      scroll: { x: gridWrap.scrollLeft, y: gridWrap.scrollTop },
    });
  // New workspace starts EMPTY — hide all panels
  wsStore.workspaces[n] = { panelIds: [], layout: {}, bg: null, bgOpacity: 1 };
  wsStore.active = n;
  canvas.querySelectorAll('.panel').forEach(p => {
    p.dataset.hidden = '1';
    p.style.visibility = 'hidden'; p.style.pointerEvents = 'none';
  });
  updateCanvasHeight(); restoreWsScroll(); saveWsStore(); applyWorkspaceTheme(); renderWsBar();
}

function deleteWorkspace(name) {
  if (!confirm(`Eliminar workspace "${name}"?`)) return;
  delete wsStore.workspaces[name];
  const keys = Object.keys(wsStore.workspaces);
  wsStore.active = keys[0] || null;
  if (wsStore.active) applyWorkspace(wsStore.active);
  applyWorkspaceTheme();
  saveWsStore(); renderWsBar();
}

function renderWsBar() {
  const tabsEl = document.getElementById('ws-tabs');
  tabsEl.innerHTML = '';
  Object.keys(wsStore.workspaces).forEach(name => {
    const tab = document.createElement('div');
    tab.className = 'ws-tab' + (wsStore.active === name ? ' active' : '');
    const nameSpan = document.createElement('span'); nameSpan.textContent = name;
    const del = document.createElement('button'); del.className = 'ws-del'; del.textContent = '✕';
    tab.appendChild(nameSpan); tab.appendChild(del);
    nameSpan.addEventListener('click', () => { if (wsStore.active !== name) switchWorkspace(name); });
    del.addEventListener('click', e => { e.stopPropagation(); deleteWorkspace(name); });
    tabsEl.appendChild(tab);
  });
}

// Get saved layout for a panel (from active workspace or any workspace)
function getSavedLayout(sessionId) {
  if (wsStore.active && wsStore.workspaces[wsStore.active]?.layout[sessionId])
    return wsStore.workspaces[wsStore.active].layout[sessionId];
  for (const ws of Object.values(wsStore.workspaces))
    if (ws.layout[sessionId]) return ws.layout[sessionId];
  return null;
}

loadWsStore();
const contextPaths = []; // { name, path }

function addContext(proj) {
  if (proj.path === selectedProject?.path) return; // don't add main project
  if (contextPaths.find(c => c.path === proj.path)) return; // no duplicates
  contextPaths.push(proj);
  renderChips();
}

function removeContext(path) {
  const i = contextPaths.findIndex(c => c.path === path);
  if (i >= 0) { contextPaths.splice(i, 1); renderChips(); }
}

function renderChips() {
  const row   = document.getElementById('ctx-row');
  const chips = document.getElementById('ctx-chips');
  chips.innerHTML = '';
  contextPaths.forEach(c => {
    const chip = document.createElement('div');
    chip.className = 'ctx-chip';
    chip.innerHTML = `<span>${c.name}</span><button title="Quitar">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => removeContext(c.path));
    chips.appendChild(chip);
  });
  row.style.display = contextPaths.length ? 'flex' : 'none';
}

function clearContexts() { contextPaths.length = 0; renderChips(); }
let zTop = 10;

const fitTimers = {};
function debouncedFit(id, delay = 80) {
  clearTimeout(fitTimers[id]);
  fitTimers[id] = setTimeout(() => { try { fits[id]?.fit(); } catch {} }, delay);
}

