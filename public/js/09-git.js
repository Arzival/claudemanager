// 09-git.js — Git: badges por panel y drawer de cambios/diffs/markdown
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── Git: header badges + right-side drawer (branch, changes, diff) ──
let gitInfo = {};                 // sessionId -> { branch, ahead, behind, files } | null
let gdSession = null, gdFile = null;
const gitDrawer = document.getElementById('git-drawer');

function requestGitInfo() {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type:'git-info' }));
}

function updateGitBadges() {
  canvas.querySelectorAll('.panel').forEach(p => {
    const b = p.querySelector('.ph-git');
    const info = gitInfo[p.dataset.id];
    if (!b) return;
    if (!info || !info.branch) { b.style.display = 'none'; return; }
    b.style.display = '';
    b.textContent = `⎇ ${info.branch} ±${info.files.length}`;
    b.classList.toggle('dirty', info.files.length > 0);
  });
  if (gdSession) renderGitDrawer();
}

function renderGitDrawer() {
  const info = gitInfo[gdSession];
  const filesEl = document.getElementById('gd-files');
  document.getElementById('gd-name').textContent = panelName(gdSession) || '';
  if (!info || !info.branch) {
    document.getElementById('gd-branch').textContent = '';
    document.getElementById('gd-count').textContent = '';
    filesEl.innerHTML = '<li class="gd-empty">Este directorio no es un repositorio git.</li>';
    return;
  }
  document.getElementById('gd-branch').textContent = '⎇ ' + info.branch;
  let count = `± ${info.files.length}`;
  if (info.ahead)  count += `  ↑${info.ahead}`;
  if (info.behind) count += `  ↓${info.behind}`;
  document.getElementById('gd-count').textContent = count;

  filesEl.innerHTML = '';
  if (!info.files.length) {
    filesEl.innerHTML = '<li class="gd-empty">Sin cambios pendientes — working tree limpio ✓</li>';
    document.getElementById('gd-diff').textContent = '';
    gdFile = null;
    return;
  }
  let fileStillThere = false;
  info.files.forEach(({ s: st, f }) => {
    const li = document.createElement('li');
    const cls = st === '??' ? 'U' : st[0];
    li.innerHTML = `<span class="gd-st ${cls}">${st === '??' ? 'U' : escHtml(st)}</span><span>${escHtml(f)}</span>`;
    if (f === gdFile) { li.classList.add('active'); fileStillThere = true; }
    li.addEventListener('click', () => selectGitFile(f, li));
    filesEl.appendChild(li);
  });
  if (gdFile && !fileStillThere) {
    gdFile = null;
    document.getElementById('gd-diff').textContent = '';
    document.getElementById('gd-md').innerHTML = '';
    document.getElementById('gd-view').style.display = 'none';
    gdShow('diff');
  }
}

let gdView = 'diff'; // vista activa para el archivo seleccionado: 'diff' | 'md'
const isMdFile = f => /\.(md|markdown)$/i.test((f.includes(' -> ') ? f.split(' -> ').pop() : f).trim());

function gdShow(view) {
  gdView = view;
  document.getElementById('gd-diff').style.display = view === 'md' ? 'none' : '';
  document.getElementById('gd-md').style.display   = view === 'md' ? 'block' : 'none';
  document.getElementById('gd-view-md').classList.toggle('active', view === 'md');
  document.getElementById('gd-view-diff').classList.toggle('active', view === 'diff');
}

function gdRequestView() {
  if (gdView === 'md') {
    document.getElementById('gd-md').textContent = 'cargando…';
    ws.send(JSON.stringify({ type:'read-file', sessionId: gdSession, file: gdFile }));
  } else {
    document.getElementById('gd-diff').textContent = 'cargando diff…';
    ws.send(JSON.stringify({ type:'git-diff', sessionId: gdSession, file: gdFile }));
  }
}

function selectGitFile(f, li) {
  gdFile = f;
  document.querySelectorAll('#gd-files li').forEach(l => l.classList.remove('active'));
  li.classList.add('active');
  const md = isMdFile(f);
  document.getElementById('gd-view').style.display = md ? 'flex' : 'none';
  gdShow(md ? 'md' : 'diff'); // los .md abren renderizados por defecto
  gdRequestView();
}

document.getElementById('gd-view-md').addEventListener('click', () => {
  if (gdFile && gdView !== 'md') { gdShow('md'); gdRequestView(); }
});
document.getElementById('gd-view-diff').addEventListener('click', () => {
  if (gdFile && gdView !== 'diff') { gdShow('diff'); gdRequestView(); }
});

// El markdown se renderiza con marked (CDN) y se sanitiza el HTML resultante:
// fuera scripts/iframes/handlers on* — es contenido local, pero por si acaso.
function sanitizeHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(n => n.remove());
  t.content.querySelectorAll('*').forEach(n => {
    [...n.attributes].forEach(a => {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)))
        n.removeAttribute(a.name);
    });
  });
  return t.innerHTML;
}

function renderMdFile(content, error) {
  const el = document.getElementById('gd-md');
  if (error || content == null) {
    el.textContent = 'No se pudo leer el archivo' + (error ? ': ' + error : '');
    return;
  }
  if (window.marked) el.innerHTML = sanitizeHtml(marked.parse(content));
  else el.textContent = content; // sin CDN (offline) — texto plano
}

function renderGitDiff(d) {
  document.getElementById('gd-diff').innerHTML = d.split('\n').map(l => {
    const cls =
      l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'dl-m' :
      l.startsWith('+') ? 'dl-a' :
      l.startsWith('-') ? 'dl-d' :
      l.startsWith('@@') ? 'dl-h' : '';
    return `<span class="${cls}">${escHtml(l) || ' '}</span>`;
  }).join('\n');
}

function openGitDrawer(id) {
  gdSession = id; gdFile = null;
  document.getElementById('gd-diff').textContent = '';
  document.getElementById('gd-md').innerHTML = '';
  document.getElementById('gd-view').style.display = 'none';
  gdShow('diff');
  gitDrawer.classList.add('open');
  renderGitDrawer();
  requestGitInfo(); // fresh state the moment it opens
}

// Ancho del drawer ajustable arrastrando el borde izquierdo (persistido)
const GD_W_KEY = 'claudemgr-gd-width';
{
  const saved = parseFloat(localStorage.getItem(GD_W_KEY));
  if (saved) gitDrawer.style.width = saved + 'px';
}
document.getElementById('gd-resize').addEventListener('mousedown', e => {
  e.preventDefault();
  const handle = e.target;
  handle.classList.add('dragging');
  function onMove(ev) {
    const w = Math.max(320, Math.min(window.innerWidth * 0.92, window.innerWidth - ev.clientX));
    gitDrawer.style.width = w + 'px';
  }
  function onUp() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    localStorage.setItem(GD_W_KEY, parseFloat(gitDrawer.style.width));
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});
function closeGitDrawer() { gitDrawer.classList.remove('open'); gdSession = null; gdFile = null; }

document.getElementById('gd-close').addEventListener('click', closeGitDrawer);
document.addEventListener('keydown', e => {
  // Esc closes the drawer — unless typing inside a terminal (vim & friends use Esc)
  if (e.key === 'Escape' && gitDrawer.classList.contains('open') && !e.target.closest('.tw')) closeGitDrawer();
});

