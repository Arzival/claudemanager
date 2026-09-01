// 07-paneles.js — buildPanel: terminal xterm, drops de archivos, teclas y estado por sesión
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── Build panel ───────────────────────────────────────────────
function buildPanel(s, lay) {
  lay = getSavedLayout(s.id) || lay;
  panelCount++;
  const panel = document.createElement('div');
  panel.className = 'panel'; panel.dataset.id = s.id;
  panel.style.zIndex = ++zTop;

  panel.innerHTML = `
    <div class="ph">
      <span class="ph-id">SYS:${String(panelCount).padStart(2,'0')}</span>
      <div class="dot ${s.status}"></div>
      <span class="ph-name">${s.name.toUpperCase()}</span>
      <span class="ph-sep">·</span>
      <span class="ph-sub">${s.subtitle ? escHtml(s.subtitle) : ''}</span>
      <span class="ph-cwd" title="${s.cwd}">${s.cwd}</span>
      <button class="ph-git" style="display:none" title="Rama y cambios pendientes"></button>
      <button class="pbtn ph-voice" title="Voz de lectura de respuestas dictadas">🔇</button>
      <button class="pbtn closebtn" title="Cerrar">✕</button>
    </div>
    <div class="tw" id="tw-${s.id}"></div>
    <ul class="cmdbox" id="cb-${s.id}"></ul>
    <div class="rh rh-r"></div>
    <div class="rh rh-b"></div>
    <div class="rh rh-l"></div>
    <div class="rh rh-t"></div>
    <div class="rh rh-br"></div>`;

  canvas.appendChild(panel);
  applyLayout(panel, lay);
  updateCanvasHeight();

  // Drag to move
  initDragMove(panel, panel.querySelector('.ph'));

  // Resize handles
  initResizeHandle(panel, panel.querySelector('.rh-r'), ['r']);
  initResizeHandle(panel, panel.querySelector('.rh-b'), ['b']);
  initResizeHandle(panel, panel.querySelector('.rh-l'), ['l']);
  initResizeHandle(panel, panel.querySelector('.rh-t'), ['t']);
  initResizeHandle(panel, panel.querySelector('.rh-br'), ['r','b']);

  // Raise on click + reflect this session in the status bar. Also refocus the
  // terminal: dragging a panel by its header used to leave focus on <body>,
  // after which Cmd+V (image paste) silently went nowhere.
  panel.addEventListener('mousedown', e => {
    raise(panel); setActiveSession(s.id);
    if (e.target.closest('button') || e.target.closest('.ph-sub')) return;
    setTimeout(() => {
      // Don't steal focus if the subtitle entered edit mode in the meantime
      if (document.activeElement?.isContentEditable) return;
      try { terms[s.id]?.focus(); } catch {}
    }, 0);
  });

  panel.querySelector('.closebtn').addEventListener('click', () =>
    ws.send(JSON.stringify({ type:'close', sessionId:s.id })));

  panel.querySelector('.ph-git').addEventListener('click', e => {
    e.stopPropagation();
    openGitDrawer(s.id);
  });

  // Voz TTS del panel (viene persistida del servidor en s.voice)
  if (s.voice !== undefined) voiceByS[s.id] = s.voice || '';
  const voiceBtn = panel.querySelector('.ph-voice');
  voiceBtn.addEventListener('click', e => { e.stopPropagation(); openVoiceMenu(s.id, voiceBtn); });
  updateVoiceBtn(s.id);

  // Subtitle — double-click to edit, Enter/Escape/blur to save
  const subEl = panel.querySelector('.ph-sub');
  let subOriginal = s.subtitle || '';
  subEl.addEventListener('dblclick', e => {
    e.stopPropagation();
    subEl.contentEditable = 'true';
    subEl.focus();
    const range = document.createRange();
    range.selectNodeContents(subEl);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  });
  subEl.addEventListener('mousedown', e => {
    if (subEl.contentEditable === 'true') e.stopPropagation();
  });
  subEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); subEl.blur(); }
    if (e.key === 'Escape') { subEl.textContent = subOriginal; subEl.blur(); }
  });
  subEl.addEventListener('blur', () => {
    subEl.contentEditable = 'false';
    const subtitle = subEl.textContent.trim();
    subOriginal = subtitle;
    ws.send(JSON.stringify({ type:'save-subtitle', sessionId:s.id, subtitle }));
  });

  // Terminal
  const term = new Terminal({
    cols: s.cols || 80, rows: s.rows || 24,
    allowTransparency: true,
    theme: { ...TERM_THEME },
    fontSize:13,fontFamily:"'Courier New',monospace",cursorBlink:true,scrollback:2000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const twEl = document.getElementById(`tw-${s.id}`);
  void twEl.offsetHeight; // force layout before open so xterm measures correct char dimensions
  term.open(twEl);
  // WebGL renderer: big rendering win with many terminals. Must load after open();
  // fall back to the default DOM renderer if WebGL is unavailable or its context is lost.
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => {
      try { webgl.dispose(); } catch {}
      // Without an explicit repaint the terminal stays blank after falling
      // back to the DOM renderer (this is what "broke" panels after a while).
      requestAnimationFrame(() => { try { term.refresh(0, term.rows - 1); } catch {} });
    });
    term.loadAddon(webgl);
  } catch {}
  terms[s.id] = term; fits[s.id] = fit;
  applyTermOpacity(s.id);
  try { fit.fit(); } catch {}
  requestAnimationFrame(() => debouncedFit(s.id, 0));
  // Buffered output from server arrives after the initial fit and can overwrite
  // the SIGWINCH redraw with stale content. Force a resize after the buffer
  // settles so Claude always redraws at the correct panel dimensions.
  setTimeout(() => {
    const t = terms[s.id];
    if (!t) return;
    ws.send(JSON.stringify({ type:'resize', sessionId:s.id, cols:t.cols, rows:t.rows }));
    lastResizeTime[s.id] = Date.now();
    setTimeout(() => { try { terms[s.id]?.scrollToBottom(); } catch {} }, 500);
  }, 350);

  term.onData(data => {
    ws.send(JSON.stringify({ type:'input', sessionId:s.id, data }));
    cmdTrackInput(s.id, data);
  });
  term.onResize(({cols,rows}) => {
    ws.send(JSON.stringify({ type:'resize', sessionId:s.id, cols, rows }));
    lastResizeTime[s.id] = Date.now();
  });
  term.attachCustomKeyEventHandler(e => {
    // Caja de sugerencias abierta → ↑↓ navegan, Enter/Tab aceptan (solo si hay
    // selección; sin selección todo pasa al shell), Esc la cierra. Hay que
    // tragar keydown Y keypress, igual que Shift+Enter más abajo.
    if (cmdBoxEl(s.id)?.classList.contains('open') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (e.type === 'keydown') moveCmdSel(s.id, e.key === 'ArrowDown' ? 1 : -1);
        e.preventDefault(); return false;
      }
      if (e.key === 'Escape') {
        if (e.type === 'keydown') { cmdTracker(s.id).suppress = true; renderCmdBox(s.id); }
        e.preventDefault(); return false;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && cmdSel[s.id] >= 0 && !e.shiftKey) {
        if (e.type === 'keydown') {
          const c = (cmdMatchCache[s.id] || [])[cmdSel[s.id]];
          if (c) acceptCmd(s.id, c.cmd, e.key === 'Enter');
        }
        e.preventDefault(); return false;
      }
    }
    // Shift+Enter → newline instead of submitting: xterm sends plain \r for
    // both, so emit ESC+CR (what Option+Enter sends), which Claude Code and
    // other TUIs interpret as "insert a line break". This must swallow the
    // keypress event too (checked before the keydown-only gate below) —
    // otherwise xterm's keypress handler still emits \r and submits anyway.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.type === 'keydown')
        ws.send(JSON.stringify({ type:'input', sessionId:s.id, data:'\x1b\r' }));
      e.preventDefault();
      return false;
    }
    if (e.type !== 'keydown') return true;
    // Ctrl+V (Windows/Linux): xterm swallows it and sends ^V to the pty
    // instead of pasting. Read the clipboard ourselves — images included,
    // since preventing the native paste event also bypasses the image handler.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'v') {
      if (navigator.clipboard && (navigator.clipboard.read || navigator.clipboard.readText)) {
        e.preventDefault();
        pasteFromClipboard(term, s.id);
        return false;
      }
      return true; // no clipboard API (insecure origin) — let the browser try
    }
    if (e.ctrlKey && e.key==='k') { term.clear(); return false; }
    if (e.metaKey && e.key==='c' && term.hasSelection()) {
      navigator.clipboard.writeText(decodeXtermSelection(term.getSelection())).catch(() => {});
      return false;
    }
    return true;
  });
  new ResizeObserver(() => debouncedFit(s.id)).observe(twEl);

  // Click anywhere on terminal wrapper → focus xterm so paste always works
  twEl.addEventListener('click', () => { term.focus(); setActiveSession(s.id); });

  // Caja de sugerencias: clic inserta el comando, clic derecho lo borra de la
  // lista global. mousedown se anula para no robarle el foco a la terminal.
  const cbEl = panel.querySelector('.cmdbox');
  cbEl.addEventListener('mousedown', e => e.preventDefault());
  cbEl.addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li || li.classList.contains('cb-hint')) return;
    const c = (cmdMatchCache[s.id] || [])[+li.dataset.i];
    if (c) acceptCmd(s.id, c.cmd, false);
  });
  cbEl.addEventListener('contextmenu', e => {
    const li = e.target.closest('li');
    if (!li || li.classList.contains('cb-hint')) return;
    e.preventDefault();
    const c = (cmdMatchCache[s.id] || [])[+li.dataset.i];
    if (c) ws.send(JSON.stringify({ type:'cmd-delete', cmd: c.cmd }));
  });

  // Image paste: intercept clipboard images, save to server temp file, paste path into terminal
  twEl.addEventListener('paste', e => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgItem = items.find(it => it.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault(); e.stopPropagation();
    const reader = new FileReader();
    reader.onload = () => ws.send(JSON.stringify({ type:'paste-image', sessionId:s.id, data:reader.result }));
    reader.readAsDataURL(imgItem.getAsFile());
  });

  // Drag & drop de archivos → pega la ruta en la terminal (como una terminal nativa).
  // El navegador oculta la ruta original, así que el archivo se sube al servidor y se
  // pega la ruta de la copia temporal. Si el origen sí provee file:// URIs (VS Code,
  // etc.) se pega la ruta real directamente sin copiar nada.
  twEl.addEventListener('dragover', e => {
    e.preventDefault(); e.stopPropagation();
    twEl.classList.add('drop-hover');
  });
  twEl.addEventListener('dragleave', e => {
    if (!twEl.contains(e.relatedTarget)) twEl.classList.remove('drop-hover');
  });
  twEl.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    twEl.classList.remove('drop-hover');
    term.focus(); setActiveSession(s.id);

    // 1) Real paths available? (file:// URIs from apps that expose them)
    const uris = (e.dataTransfer.getData('text/uri-list') || '')
      .split(/\r?\n/).filter(u => u.startsWith('file://'));
    if (uris.length) {
      const paths = uris.map(u => decodeURIComponent(u.replace(/^file:\/\/[^/]*/, '')));
      term.paste(paths.map(shEscape).join(' '));
      return;
    }

    // 2) Dropped files AND folders (Finder etc.): el navegador oculta la ruta
    //    original, pero el servidor puede ENCONTRARLA (Spotlight + verificación
    //    por tamaño/hijos) y pegar la ruta real. Solo lo que no se resuelve se
    //    sube como copia temporal. Entries must be captured synchronously here.
    const entries = Array.from(e.dataTransfer.items || [])
      .map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) { smartDrop(entries, s.id, term); return; }

    // Fallback for browsers without webkitGetAsEntry (files only)
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) {
      const MAX = 50 * 1024 * 1024;
      if (files.reduce((a, f) => a + f.size, 0) > MAX) {
        alert('Archivos demasiado grandes para soltar (máx. 50MB en total)');
        return;
      }
      Promise.all(files.map(f => new Promise(res => {
        const r = new FileReader();
        r.onload = () => res({ name: f.name, data: r.result });
        r.onerror = () => res(null); // e.g. dropped folders can't be read — skip
        r.readAsDataURL(f);
      }))).then(list => {
        const ok = list.filter(Boolean);
        if (ok.length) ws.send(JSON.stringify({ type:'drop-files', sessionId:s.id, files: ok }));
      });
      return;
    }

    // 3) Plain text drops (e.g. dragged selection) → paste as-is
    const txt = e.dataTransfer.getData('text/plain');
    if (txt) term.paste(txt);
  });
}

// Escape shell-special characters the way native terminals do when a file is dropped
function shEscape(p) { return p.replace(/[^\w\/.\-]/g, c => '\\' + c); }

// ── Drop inteligente: primero busca la ruta REAL, luego copia ─
let dropReqSeq = 0;
const dropPending = new Map(); // reqId -> resolve(paths)

async function smartDrop(entries, sid, term) {
  // Junta lo que el navegador sí revela: nombre + tamaño (archivos) o nombre
  // + primeros hijos (carpetas) — suficiente para buscar el original en disco.
  const metas = await Promise.all(entries.map(en => new Promise(res => {
    try {
      if (en.isFile) en.file(f => res({ name: en.name, size: f.size, isDir: false }), () => res(null));
      else en.createReader().readEntries(
        kids => res({ name: en.name, isDir: true, childNames: kids.slice(0, 6).map(k => k.name) }),
        () => res({ name: en.name, isDir: true, childNames: [] }));
    } catch { res(null); }
  })));
  const reqId = 'dr' + (++dropReqSeq);
  const paths = await new Promise(res => {
    const t = setTimeout(() => { dropPending.delete(reqId); res(null); }, 4500);
    dropPending.set(reqId, p => { clearTimeout(t); res(p); });
    ws.send(JSON.stringify({ type: 'resolve-drop', reqId, sessionId: sid, items: metas.map(m => m || {}) }));
  });
  const found = [], leftover = [];
  entries.forEach((en, i) => {
    if (paths && paths[i]) found.push(paths[i]);
    else leftover.push(en);
  });
  if (found.length) term.paste(found.map(shEscape).join(' ') + (leftover.length ? ' ' : ''));
  if (leftover.length) {
    vToast('no encontré la ruta original de ' + leftover.length + ' elemento(s) — se sube copia temporal', 4000);
    uploadDroppedEntries(leftover, sid); // plan B: copia temporal, como antes
  }
}

// Paste from the async clipboard API (Ctrl+V path): image wins — it goes to
// the server like paste-image and the temp path is pasted; otherwise text.
async function pasteFromClipboard(term, sessionId) {
  try {
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const imgType = (it.types || []).find(t => t.startsWith('image/'));
        if (imgType) {
          const blob = await it.getType(imgType);
          const r = new FileReader();
          r.onload = () => ws.send(JSON.stringify({ type:'paste-image', sessionId, data:r.result }));
          r.readAsDataURL(blob);
          return;
        }
      }
    }
  } catch {} // permission denied or unsupported — try text below
  try {
    const t = await navigator.clipboard.readText();
    if (t) term.paste(t);
  } catch {}
}

// ── Folder-aware drop upload ──────────────────────────────────
// Walks dropped directory entries recursively (skipping heavy junk dirs),
// uploads files + folder trees, and the server replies with temp paths.
const DROP_SKIP_DIRS = new Set(['node_modules', '.git']);

function walkDropEntry(entry, base, out) {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(f => { out.push({ rel: base + entry.name, file: f }); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      if (DROP_SKIP_DIRS.has(entry.name)) return resolve();
      const reader = entry.createReader();
      const readBatch = () => reader.readEntries(ents => {
        // readEntries returns ≤100 per call — keep reading until empty
        if (!ents.length) return resolve();
        Promise.all(ents.map(en => walkDropEntry(en, base + entry.name + '/', out))).then(readBatch);
      }, () => resolve());
      readBatch();
    } else resolve();
  });
}

async function uploadDroppedEntries(entries, sessionId) {
  const MAX_BYTES = 50 * 1024 * 1024, MAX_FILES = 400;
  const singles = [];  // top-level files: { name, file }
  const folders = [];  // { name, list: [{ rel, file }] } — rel includes the folder name
  for (const en of entries) {
    if (en.isFile) {
      await new Promise(res => en.file(f => { singles.push({ name: en.name, file: f }); res(); }, res));
    } else if (en.isDirectory) {
      const list = [];
      await walkDropEntry(en, '', list);
      folders.push({ name: en.name, list });
    }
  }
  const all = [...singles.map(x => x.file), ...folders.flatMap(fo => fo.list.map(x => x.file))];
  if (!all.length) { alert('La carpeta está vacía (o solo contiene node_modules/.git)'); return; }
  if (all.length > MAX_FILES) { alert(`Demasiados archivos (${all.length}, máx. ${MAX_FILES}) — la carpeta es muy grande`); return; }
  if (all.reduce((a, f) => a + f.size, 0) > MAX_BYTES) { alert('Contenido demasiado grande para soltar (máx. 50MB en total)'); return; }

  const toB64 = f => new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => res(null);
    r.readAsDataURL(f);
  });
  const files = [];
  for (const x of singles) { const d = await toB64(x.file); if (d) files.push({ name: x.name, data: d }); }
  const folderPayload = [];
  for (const fo of folders) {
    const fl = [];
    for (const x of fo.list) { const d = await toB64(x.file); if (d) fl.push({ rel: x.rel, data: d }); }
    if (fl.length) folderPayload.push({ name: fo.name, files: fl });
  }
  if (files.length || folderPayload.length)
    ws.send(JSON.stringify({ type:'drop-files', sessionId, files, folders: folderPayload }));
}

// Don't let drops outside a terminal navigate the page away from the dashboard
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

// Fallback: pasting while no terminal has focus (fresh page load, after
// clicking the bars, after dragging a panel…) used to go nowhere. Route
// images AND text to the active session so Ctrl/Cmd+V always works.
document.addEventListener('paste', e => {
  if (e.target.closest && e.target.closest('.tw')) return;            // per-terminal handler owns it
  if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) return;
  if (!activeSessionId || !terms[activeSessionId]) return;
  const p = document.querySelector(`.panel[data-id="${activeSessionId}"]`);
  if (!p || p.dataset.hidden) return;                                 // never paste into another workspace
  const imgItem = Array.from(e.clipboardData?.items || []).find(it => it.type.startsWith('image/'));
  if (imgItem) {
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => ws.send(JSON.stringify({ type:'paste-image', sessionId:activeSessionId, data:reader.result }));
    reader.readAsDataURL(imgItem.getAsFile());
    terms[activeSessionId].focus();
    return;
  }
  const txt = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  if (txt) {
    e.preventDefault();
    terms[activeSessionId].paste(txt);
    terms[activeSessionId].focus();
  }
});

new ResizeObserver(() => { updateCanvasHeight(); scheduleRefit(); }).observe(gridWrap);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setTimeout(scheduleRefit, 100);
});

// Fix clipboard encoding: xterm's execCommand fallback can produce Mac Roman on macOS.
// Intercept every copy event and re-set data from xterm's selection (proper Unicode).
document.addEventListener('copy', e => {
  for (const t of Object.values(terms)) {
    const sel = decodeXtermSelection(t.getSelection());
    if (sel) { e.preventDefault(); e.clipboardData.setData('text/plain', sel); return; }
  }
});

// ── Dot helpers ───────────────────────────────────────────────
function setDot(id, st) {
  statuses[id] = st;
  const d = document.querySelector(`.panel[data-id="${id}"] .dot`);
  if (d) d.className = `dot ${st}`;
}
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(lastOut))
    if (statuses[id]==='running' && now-lastOut[id]>5000) setDot(id,'idle');
}, 1000);

document.getElementById('ws-new').addEventListener('click', newWorkspace);

