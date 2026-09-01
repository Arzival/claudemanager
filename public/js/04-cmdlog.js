// 04-cmdlog.js — Command log: sugerencias de comandos mientras escribes en un shell
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── COMMAND LOG — sugerencias mientras escribes ───────────────
// El servidor guarda UNA lista global de comandos (frecuencia + recencia).
// Aquí solo se filtra en memoria por lo tecleado; el servidor confirma vía
// cmd-state que la sesión está en un shell (o ssh) antes de mostrar la caja.
let cmdLog = [];            // [{cmd,count,last}] — lista global del servidor
const cmdTrack = {};        // sessionId -> {line,dirty,suppress}
const cmdShellOk = {};      // sessionId -> {val,at} — ¿foreground es un shell?
const cmdMatchCache = {};   // sessionId -> matches actualmente mostrados
const cmdSel = {};          // sessionId -> índice seleccionado (-1 = ninguno)

function cmdTracker(id) {
  return cmdTrack[id] || (cmdTrack[id] = { line: '', dirty: false, suppress: false });
}

// Réplica ligera del tracker del servidor: reconstruye la línea tecleada para
// saber qué prefijo filtrar. Flechas/Tab invalidan la captura hasta que la
// línea se limpie (la línea real ya no coincide con lo reconstruido).
function cmdTrackInput(id, data) {
  const t = cmdTracker(id);
  data = data.replace(/\x1b\[20[01]~/g, ''); // marcadores de bracketed paste
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r' || ch === '\n' || ch === '\x15' || ch === '\x03') {
      t.line = ''; t.dirty = false; t.suppress = false;
    } else if (ch === '\x7f' || ch === '\b') {
      t.line = t.line.slice(0, -1);
    } else if (ch === '\x1b') {
      t.dirty = true;
      if (data[i + 1] === '[') { i++; while (i + 1 < data.length && !/[A-Za-z~]/.test(data[i + 1])) i++; i++; }
      else if (data[i + 1] === 'O') i += 2;
    } else if (ch === '\t') {
      t.dirty = true;
    } else if (ch >= ' ' && t.line.length < 300) {
      if (!t.line) askCmdShell(id); // arranca línea → consulta si hay shell
      t.line += ch;
    }
  }
  renderCmdBox(id);
}

// Pregunta (con throttle) si el foreground de la sesión es un shell
function askCmdShell(id) {
  const c = cmdShellOk[id];
  if (c && Date.now() - c.at < 3000) return;
  cmdShellOk[id] = { val: c ? c.val : false, at: Date.now() };
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'cmd-state', sessionId: id }));
}

function cmdBoxEl(id) { return document.getElementById('cb-' + id); }

function renderCmdBox(id) {
  const el = cmdBoxEl(id);
  if (!el) return;
  const t = cmdTracker(id);
  const p = t.line.trimStart();
  let matches = [];
  if (!t.dirty && !t.suppress && p.length >= 2 && cmdShellOk[id]?.val) {
    const pl = p.toLowerCase();
    const starts = [], incl = [];
    for (const c of cmdLog) {
      const cl = c.cmd.toLowerCase();
      if (cl === pl) continue; // ya lo escribiste completo
      if (cl.startsWith(pl)) starts.push(c);
      else if (cl.includes(pl)) incl.push(c);
    }
    const by = (a, b) => (b.count - a.count) || (b.last - a.last);
    matches = starts.sort(by).concat(incl.sort(by)).slice(0, 8);
  }
  cmdMatchCache[id] = matches;
  if (!matches.length) { el.classList.remove('open'); cmdSel[id] = -1; return; }
  if (!(cmdSel[id] >= 0) || cmdSel[id] >= matches.length) cmdSel[id] = -1;
  const pl = p.toLowerCase();
  el.innerHTML = matches.map((c, i) => {
    const at = c.cmd.toLowerCase().indexOf(pl);
    const html = escHtml(c.cmd.slice(0, at)) + '<b>' + escHtml(c.cmd.slice(at, at + p.length)) + '</b>' + escHtml(c.cmd.slice(at + p.length));
    return `<li data-i="${i}" class="${i === cmdSel[id] ? 'sel' : ''}">${html}<span class="cb-count">×${c.count}</span></li>`;
  }).join('') + `<li class="cb-hint">↑↓ elegir · Enter ejecutar · Tab completar · Esc cerrar · clic inserta · clic der. borra</li>`;
  el.classList.add('open');
}

function moveCmdSel(id, d) {
  const m = cmdMatchCache[id] || [];
  if (!m.length) return;
  let i = (cmdSel[id] ?? -1) + d;
  if (i < -1) i = m.length - 1;
  if (i >= m.length) i = -1; // -1 = nada seleccionado → Enter pasa al shell
  cmdSel[id] = i;
  renderCmdBox(id);
  cmdBoxEl(id)?.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
}

// Inserta el comando en la terminal (Ctrl+U limpia lo tecleado primero).
// run=true además lo ejecuta con Enter.
function acceptCmd(id, cmd, run) {
  ws.send(JSON.stringify({ type: 'input', sessionId: id, data: '\x15' + cmd + (run ? '\r' : '') }));
  const t = cmdTracker(id);
  t.line = run ? '' : cmd; t.dirty = false;
  cmdSel[id] = -1;
  cmdBoxEl(id)?.classList.remove('open');
  try { terms[id]?.focus(); } catch {}
}

