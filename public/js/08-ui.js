// 08-ui.js — Overlays: selector de fondos, modal de config y picker de proyectos
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── Background picker ─────────────────────────────────────────
const bgGridEl = document.getElementById('bg-grid');
const bgOpEl   = document.getElementById('bg-opacity');
const bgOpVal  = document.getElementById('bg-opacity-val');

function renderBgGrid() {
  const ws = activeWs();
  const current = ws ? ws.bg : null;
  bgGridEl.innerHTML = '';

  // "No background" tile
  const none = document.createElement('div');
  none.className = 'bg-tile bg-none' + (!current ? ' active' : '');
  none.title = 'Sin fondo';
  none.innerHTML = '🚫<div class="bg-check">✓</div>';
  none.addEventListener('click', () => selectBg(null));
  none.addEventListener('mouseenter', () => applyWorkspaceBg(null));
  none.addEventListener('mouseleave', () => applyWorkspaceBg());
  bgGridEl.appendChild(none);

  backgrounds.forEach(file => {
    const tile = document.createElement('div');
    tile.className = 'bg-tile' + (current === file ? ' active' : '');
    tile.style.backgroundImage = `url('/fondos/${encodeURIComponent(file)}')`;
    tile.title = file;
    tile.innerHTML = '<div class="bg-check">✓</div>';
    tile.addEventListener('click', () => selectBg(file));
    tile.addEventListener('mouseenter', () => applyWorkspaceBg(file));
    tile.addEventListener('mouseleave', () => applyWorkspaceBg());
    bgGridEl.appendChild(tile);
  });

  if (!backgrounds.length) {
    const hint = document.createElement('div');
    hint.className = 'bg-empty';
    hint.innerHTML = 'No hay imágenes todavía.<br>Copia tus fondos (PNG / JPG / WEBP…) a la carpeta <code>fondos/</code> del proyecto y vuelve a abrir este panel.';
    bgGridEl.appendChild(hint);
  }
}

function selectBg(file) {
  if (!wsStore.active) return;
  writeWs(wsStore.active, { bg: file });
  saveWsStore();
  applyWorkspaceBg();
  renderBgGrid();
}

// Slider value = transparency % (0 = solid). alpha = 1 - t/100
bgOpEl.addEventListener('input', () => {
  const t = parseInt(bgOpEl.value, 10);
  bgOpVal.textContent = t + '%';
  if (!wsStore.active) return;
  writeWs(wsStore.active, { bgOpacity: 1 - t / 100 });
  applyAllTermOpacity();
});
bgOpEl.addEventListener('change', saveWsStore);

function openBgPicker() {
  if (!wsStore.active) { alert('Crea o selecciona un workspace primero.'); return; }
  document.getElementById('bg-ws-name').textContent = '› ' + wsStore.active;
  const t = Math.round((1 - wsBgAlpha()) * 100);
  bgOpEl.value = t; bgOpVal.textContent = t + '%';
  renderBgGrid();
  bgOv.classList.add('open');
  ws.send(JSON.stringify({ type: 'list-backgrounds' })); // refresh in case files changed
}

document.getElementById('ws-bg').addEventListener('click', openBgPicker);
document.getElementById('bg-close').addEventListener('click', () => { applyWorkspaceBg(); bgOv.classList.remove('open'); });
bgOv.addEventListener('click', e => { if (e.target === bgOv) { applyWorkspaceBg(); bgOv.classList.remove('open'); } });

setInterval(() => { clockEl.textContent = new Date().toLocaleTimeString('en-US',{hour12:false}); }, 1000);
clockEl.textContent = new Date().toLocaleTimeString('en-US',{hour12:false});

// ── Config modal ──────────────────────────────────────────────
function openConfig(d) {
  document.getElementById('cfg-root').value = d.projectsRoot||'';
  document.getElementById('cfg-claude').value = d.claudePath||d.detectedClaude||'';
  renderToolsList();
  closeToolForm();
  cfgOv.classList.add('open');
}
document.getElementById('cfg-close').addEventListener('click', () => cfgOv.classList.remove('open'));
cfgOv.addEventListener('click', e => { if (e.target===cfgOv) cfgOv.classList.remove('open'); });
document.getElementById('btn-cfg').addEventListener('click', () => openConfig({
  projectsRoot: document.getElementById('cfg-root').value,
  claudePath:   document.getElementById('cfg-claude').value }));
document.getElementById('cfg-detect').addEventListener('click', () => {
  const b=document.getElementById('cfg-detect'); b.textContent='Detecting…'; b.disabled=true;
  ws.send(JSON.stringify({ type:'detect-claude' }));
});
document.getElementById('cfg-save').addEventListener('click', () =>
  ws.send(JSON.stringify({ type:'save-config',
    projectsRoot: document.getElementById('cfg-root').value.trim(),
    claudePath:   document.getElementById('cfg-claude').value.trim() })));

// ── Project picker ────────────────────────────────────────────
document.getElementById('btn-open').addEventListener('click', () => {
  pickOv.classList.add('open'); selectedProject=null;
  clearContexts();
  document.getElementById('btn-launch').disabled=true;
  ws.send(JSON.stringify({ type:'projects' }));
});
document.getElementById('pick-close').addEventListener('click', () => pickOv.classList.remove('open'));
pickOv.addEventListener('click', e => { if (e.target===pickOv) pickOv.classList.remove('open'); });

function showNewFolderForm(show) {
  document.getElementById('new-folder-form').style.display = show ? 'flex' : 'none';
  if (show) { document.getElementById('new-folder-input').value=''; document.getElementById('new-folder-input').focus(); }
}

document.getElementById('btn-new-folder').addEventListener('click', () => showNewFolderForm(true));
document.getElementById('new-folder-cancel').addEventListener('click', () => showNewFolderForm(false));
document.getElementById('new-folder-ok').addEventListener('click', createFolder);
document.getElementById('new-folder-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') createFolder();
  if (e.key === 'Escape') showNewFolderForm(false);
});

function createFolder() {
  const name = document.getElementById('new-folder-input').value.trim();
  if (!name || currentTechIdx < 0) return;
  ws.send(JSON.stringify({ type:'create-folder', tech: projectData[currentTechIdx].tech, name }));
  showNewFolderForm(false);
}

function selectTech(idx, el) {
  currentTechIdx = idx;
  document.querySelectorAll('#tech-list li').forEach(l=>l.classList.remove('active'));
  el.classList.add('active');
  const toolbar = document.getElementById('proj-toolbar');
  toolbar.style.display = 'flex';
  document.getElementById('proj-tech-label').textContent = projectData[idx].tech;
  const pEl=document.getElementById('proj-list'); pEl.innerHTML='';
  if (!projectData[idx].projects.length)
    pEl.innerHTML = '<li class="empty-h">carpeta vacía — usa «＋ Nueva carpeta» para crear un proyecto</li>';
  projectData[idx].projects.forEach(p=>{
    const li = document.createElement('li');
    li.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 10px 7px 18px';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name; nameSpan.style.flex = '1';
    const addBtn = document.createElement('button');
    addBtn.className = 'add-ctx-btn'; addBtn.textContent = '＋ ctx';
    addBtn.title = 'Agregar como contexto adicional';
    addBtn.addEventListener('click', e => { e.stopPropagation(); addContext(p); });
    li.appendChild(nameSpan); li.appendChild(addBtn);
    if (selectedProject?.path === p.path) li.classList.add('active');
    li.addEventListener('click', () => {
      document.querySelectorAll('#proj-list li').forEach(l=>l.classList.remove('active'));
      li.classList.add('active'); selectedProject=p;
      document.getElementById('btn-launch').disabled=false;
    });
    pEl.appendChild(li);
  });
}
document.getElementById('btn-launch').addEventListener('click', () => {
  if (!selectedProject) return;
  // Calculate expected terminal size so PTY spawns at correct dimensions from the start
  const W = gridWrap.clientWidth, H = gridWrap.clientHeight;
  const panelW = 0.45 * W - 8;  // w:0.45 minus .tw padding
  const panelH = 0.45 * H - 32; // h:0.45 minus header + .tw padding
  const cols = Math.max(80, Math.floor(panelW / 7.8));   // Courier New 13px ≈ 7.8px wide
  const rows = Math.max(24, Math.floor(panelH / 15.6));  // 13px font × 1.2 line-height
  ws.send(JSON.stringify({ type:'open', projectPath:selectedProject.path,
    projectName:selectedProject.name,
    toolId:        selectedToolId,
    resume:        document.getElementById('chk-resume').checked,
    dangerousSkip: document.getElementById('chk-danger').checked,
    contextPaths:  contextPaths.map(c => c.path),
    cols, rows }));
  pickOv.classList.remove('open');
});

