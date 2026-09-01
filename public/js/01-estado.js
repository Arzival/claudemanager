// 01-estado.js — Referencias DOM, estado global y tema del terminal
// Script clásico: comparte scope global con los demás; el orden de carga importa.
const gridWrap = document.getElementById('grid-wrap');
const canvas   = document.getElementById('canvas');
const connEl   = document.getElementById('conn');
const clockEl  = document.getElementById('clock');
const pickOv   = document.getElementById('pick-overlay');
const cfgOv    = document.getElementById('cfg-overlay');
const bgOv     = document.getElementById('bg-overlay');
const terms = {}, fits = {}, lastOut = {}, statuses = {}, lastResizeTime = {};
let usageData = {};          // sessionId -> usage object (or null if N/A)
let activeSessionId = null;  // session reflected in the status bar
let projectData = [], selectedProject = null, panelCount = 0, detectedClaude = '', currentTechIdx = -1;
let toolsList = [], selectedToolId = null;
let backgrounds = [];

// Base color behind the terminal text. Workspace transparency lowers its alpha
// so the board background shows through, while glyphs stay fully opaque.
const TERM_BG_RGB = '9,9,22';
const TERM_THEME = {
  background:'#090916',foreground:'#b0c8dc',cursor:'#00f5ff',cursorAccent:'#090916',
  selectionBackground:'rgba(0,245,255,.18)',black:'#090916',red:'#ff006e',green:'#39ff14',
  yellow:'#ffd60a',blue:'#0080ff',magenta:'#bf00ff',cyan:'#00f5ff',white:'#a0b4c8',
  brightBlack:'#2a3a4a',brightRed:'#ff4090',brightGreen:'#80ff50',brightYellow:'#ffe060',
  brightBlue:'#40a0ff',brightMagenta:'#df80ff',brightCyan:'#60ffff',brightWhite:'#e0f0ff',
};

// ── Tools ─────────────────────────────────────────────────────
function renderToolPills() {
  const el = document.getElementById('tool-pills');
  if (!el) return;
  el.innerHTML = '';
  toolsList.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'tool-pill' + (t.id === selectedToolId ? ' active' : '');
    btn.textContent = t.name;
    btn.addEventListener('click', () => {
      selectedToolId = t.id;
      renderToolPills();
      // Show/hide skip perms checkbox based on tool capability
      const tool = toolsList.find(x => x.id === selectedToolId);
      const chkWrap = document.getElementById('chk-danger').closest('.chk-wrap');
      chkWrap.style.display = tool?.skipPermsFlag ? '' : 'none';
      const chkResume = document.getElementById('chk-resume').closest('.chk-wrap');
      chkResume.style.display = tool?.resumeFlag ? '' : 'none';
    });
    el.appendChild(btn);
  });
}

function renderToolsList() {
  const el = document.getElementById('tools-list');
  if (!el) return;
  el.innerHTML = '';
  toolsList.forEach(t => {
    const row = document.createElement('div');
    row.className = 'tool-item';
    row.innerHTML = `
      <span class="tool-item-name">${t.name}</span>
      <span class="tool-item-cmd">${t.command}</span>
      <button class="tool-ibtn edit-btn">Editar</button>
      <button class="tool-ibtn del del-btn">Eliminar</button>`;
    row.querySelector('.edit-btn').addEventListener('click', () => openToolForm(t));
    row.querySelector('.del-btn').addEventListener('click', () => {
      if (confirm(`Eliminar "${t.name}"?`))
        ws.send(JSON.stringify({ type: 'delete-tool', toolId: t.id }));
    });
    el.appendChild(row);
  });
}

function openToolForm(tool = null) {
  const form = document.getElementById('tool-form');
  document.getElementById('tool-form-title').textContent = tool ? 'EDITAR HERRAMIENTA' : 'NUEVA HERRAMIENTA';
  document.getElementById('tf-id').value       = tool?.id || '';
  document.getElementById('tf-name').value     = tool?.name || '';
  document.getElementById('tf-cmd').value      = tool?.command || '';
  document.getElementById('tf-skip').value     = tool?.skipPermsFlag || '';
  document.getElementById('tf-resume').value   = tool?.resumeFlag || '';
  document.getElementById('tf-adddir').value   = tool?.addDirFlag || '';
  form.style.display = 'flex';
}

function closeToolForm() {
  document.getElementById('tool-form').style.display = 'none';
}

document.getElementById('btn-add-tool').addEventListener('click', () => openToolForm());
document.getElementById('tf-cancel').addEventListener('click', closeToolForm);
document.getElementById('tf-detect').addEventListener('click', () => {
  ws.send(JSON.stringify({ type: 'detect-claude' }));
});
document.getElementById('tf-save').addEventListener('click', () => {
  const name = document.getElementById('tf-name').value.trim();
  const command = document.getElementById('tf-cmd').value.trim();
  if (!name || !command) return;
  const id = document.getElementById('tf-id').value || name.toLowerCase().replace(/\s+/g, '-');
  const tool = {
    id, name, command,
    defaultArgs: [],
    skipPermsFlag: document.getElementById('tf-skip').value.trim() || null,
    resumeFlag: document.getElementById('tf-resume').value.trim() || null,
    addDirFlag: document.getElementById('tf-adddir').value.trim() || null,
  };
  ws.send(JSON.stringify({ type: 'save-tool', tool }));
  closeToolForm();
});

