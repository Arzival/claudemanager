// 12-spawn.js — Lanzamiento rápido: clic derecho sobre el tablero vacío abre
// un menú con tus proyectos y la consola nace con su esquina en el cursor.
// Script clásico: comparte scope global con los demás; el orden de carga importa.

let spawnPos = null;    // { l, t } en fracciones — posición del próximo panel
let spawnMenuEl = null;

// Preferencias del lanzamiento rápido (mismas opciones que el picker grande)
const spawnPrefs = {
  get resume() { return localStorage.getItem('claudemgr-spawn-resume') === '1'; },
  set resume(v) { localStorage.setItem('claudemgr-spawn-resume', v ? '1' : '0'); },
  get danger() { return localStorage.getItem('claudemgr-spawn-danger') !== '0'; }, // default activo
  set danger(v) { localStorage.setItem('claudemgr-spawn-danger', v ? '1' : '0'); },
};

function closeSpawnMenu() {
  spawnMenuEl?.remove();
  spawnMenuEl = null;
  document.removeEventListener('mousedown', spawnMenuAway);
}
function spawnMenuAway(e) { if (!e.target.closest('#spawn-menu')) closeSpawnMenu(); }

// Herramienta del lanzamiento rápido: recuerda la última elegida aquí; si ya
// no existe, cae a la herramienta default de la config.
function spawnToolId() {
  const saved = localStorage.getItem('claudemgr-spawn-tool');
  return toolsList.find(t => t.id === saved) ? saved : selectedToolId;
}

// Proyectos marcados como contexto para el próximo lanzamiento (path -> name).
// Se marcan con CLIC DERECHO sobre el proyecto; se limpia al cerrar el menú.
const spawnCtx = new Map();

function renderSpawnMenu() {
  if (!spawnMenuEl) return;
  const tid = spawnToolId();
  const tool = toolsList.find(t => t.id === tid);
  spawnMenuEl.innerHTML =
    `<div class="vm-hdr">⚡ LANZAR AQUÍ — clic lanza · clic der. marca contexto</div>` +
    // Con más de una herramienta configurada (claude, bash, gemini…), elige
    (toolsList.length > 1
      ? toolsList.map(t =>
          `<div class="vm-item sp-tool" data-t="${escHtml(t.id)}">${t.id === tid ? '◉' : '○'} ${escHtml(t.name)}</div>`
        ).join('')
      : '') +
    // Toggles solo si la herramienta elegida soporta esos flags
    (tool?.resumeFlag ? `<div class="vm-item sp-opt" data-o="resume">${spawnPrefs.resume ? '☑' : '☐'} ↩ retomar conversación</div>` : '') +
    (tool?.skipPermsFlag ? `<div class="vm-item sp-opt" data-o="danger">${spawnPrefs.danger ? '☑' : '☐'} ⚡ skip permisos</div>` : '') +
    // Resumen de contexto marcado — clic limpia todo
    (spawnCtx.size
      ? `<div class="vm-item sp-ctx-clear" title="Clic para quitar todo el contexto">📎 ctx: ${escHtml([...spawnCtx.values()].join(', '))} ✕</div>`
      : '') +
    (!projectData.length
      ? '<div class="vm-hdr">cargando proyectos…</div>'
      : projectData.map(t =>
          `<div class="vm-hdr">${escHtml(t.tech.toUpperCase())}</div>` +
          t.projects.map(p =>
            `<div class="vm-item sp-proj ${spawnCtx.has(p.path) ? 'sp-ctx-on' : ''}" data-path="${escHtml(p.path)}" data-name="${escHtml(p.name)}">` +
            `${spawnCtx.has(p.path) ? '📎 ' : ''}${escHtml(p.name)}</div>`
          ).join('')
        ).join(''));
}

function quickLaunch(projectPath, projectName) {
  // Mismo cálculo de cols/rows que el picker: el pty nace ya al tamaño del panel
  const W = gridWrap.clientWidth, H = gridWrap.clientHeight;
  const cols = Math.max(80, Math.floor((0.45 * W - 8) / 7.8));
  const rows = Math.max(24, Math.floor((0.45 * H - 32) / 15.6));
  const tool = toolsList.find(t => t.id === spawnToolId());
  // Contexto marcado con clic derecho (sin incluir el proyecto principal)
  const ctx = [...spawnCtx.keys()].filter(p => p !== projectPath);
  ws.send(JSON.stringify({
    type: 'open', projectPath, projectName,
    toolId: spawnToolId(),
    resume: !!tool?.resumeFlag && spawnPrefs.resume,
    dangerousSkip: !!tool?.skipPermsFlag && spawnPrefs.danger,
    contextPaths: ctx,
    cols, rows,
  }));
  vToast(`⚡ lanzando ${projectName}${tool ? ' con ' + tool.name : ''}${ctx.length ? ' + ' + ctx.length + ' ctx' : ''}…`);
}

gridWrap.addEventListener('contextmenu', e => {
  // Solo sobre el tablero vacío — el clic derecho en paneles/terminales no se toca
  if (e.target !== gridWrap && e.target !== canvas) return;
  e.preventDefault();
  closeSpawnMenu();
  // El futuro panel nace con su esquina donde está el cursor (incluye scroll)
  const r = gridWrap.getBoundingClientRect();
  spawnPos = {
    l: Math.max(0, (e.clientX - r.left + gridWrap.scrollLeft) / gridWrap.clientWidth),
    t: Math.max(0, (e.clientY - r.top + gridWrap.scrollTop) / gridWrap.clientHeight),
  };
  const m = document.createElement('div');
  m.id = 'spawn-menu';
  m.style.left = Math.min(e.clientX, innerWidth - 250) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - 340) + 'px';
  spawnMenuEl = m;
  spawnCtx.clear(); // el contexto marcado es por lanzamiento, no persiste
  renderSpawnMenu();
  if (!projectData.length) ws.send(JSON.stringify({ type: 'projects' })); // se repinta al llegar
  // Clic derecho sobre un proyecto = marcar/desmarcar como contexto (--add-dir)
  m.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    const proj = ev.target.closest('.sp-proj');
    if (!proj) return;
    if (spawnCtx.has(proj.dataset.path)) spawnCtx.delete(proj.dataset.path);
    else spawnCtx.set(proj.dataset.path, proj.dataset.name);
    renderSpawnMenu();
  });
  m.addEventListener('click', ev => {
    const clear = ev.target.closest('.sp-ctx-clear');
    if (clear) { spawnCtx.clear(); renderSpawnMenu(); return; }
    const toolIt = ev.target.closest('.sp-tool');
    if (toolIt) { // cambio de herramienta — el menú sigue abierto
      localStorage.setItem('claudemgr-spawn-tool', toolIt.dataset.t);
      renderSpawnMenu();
      return;
    }
    const opt = ev.target.closest('.sp-opt');
    if (opt) { // toggle de opción — el menú sigue abierto
      spawnPrefs[opt.dataset.o] = !spawnPrefs[opt.dataset.o];
      renderSpawnMenu();
      return;
    }
    const proj = ev.target.closest('.sp-proj');
    if (!proj) return;
    quickLaunch(proj.dataset.path, proj.dataset.name);
    closeSpawnMenu();
  });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('mousedown', spawnMenuAway), 0);
});
