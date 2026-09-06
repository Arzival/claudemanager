// 13-admin.js — Administración: gestor del historial de comandos (buscar,
// editar, borrar), botón de reinicio del servicio y aviso de actualización.
// Script clásico: comparte scope global con los demás; el orden de carga importa.

// ── Gestor del historial de comandos ──────────────────────────
const cmdsOv = document.getElementById('cmds-overlay');
const cmdsList = document.getElementById('cmds-list');
const cmdsSearch = document.getElementById('cmds-search');
let cmdsEditing = null; // cmd en edición (para conservar el input entre repintados)

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + ' min';
  if (d < 86400e3) return Math.round(d / 3600e3) + ' h';
  return Math.round(d / 86400e3) + ' d';
}

function renderCmds() {
  const q = cmdsSearch.value.trim().toLowerCase();
  const rows = cmdLog
    .filter(c => !q || c.cmd.toLowerCase().includes(q))
    .sort((a, b) => (b.count - a.count) || (b.last - a.last));
  document.getElementById('cmds-count').textContent =
    `${rows.length} de ${cmdLog.length}`;
  cmdsList.innerHTML = rows.length ? rows.map(c => `
    <li data-cmd="${escHtml(c.cmd)}">
      <span class="cm-cmd">${cmdsEditing === c.cmd
        ? `<input value="${escHtml(c.cmd)}">`
        : escHtml(c.cmd)}</span>
      <span class="cm-meta">×${c.count} · hace ${relTime(c.last)}</span>
      <button class="cm-btn" data-a="edit" title="Editar">✎</button>
      <button class="cm-btn del" data-a="del" title="Borrar">✕</button>
    </li>`).join('')
    : '<li class="cmds-empty">' + (q ? 'nada coincide con la búsqueda' : 'aún no hay comandos registrados — se aprenden solos al usar shells') + '</li>';
  // Foco al input de edición, si lo hay
  const inp = cmdsList.querySelector('.cm-cmd input');
  if (inp) { inp.focus(); inp.select(); }
}

cmdsList.addEventListener('click', e => {
  const li = e.target.closest('li[data-cmd]');
  if (!li) return;
  const cmd = li.dataset.cmd;
  const a = e.target.closest('.cm-btn')?.dataset.a;
  if (a === 'del') {
    ws.send(JSON.stringify({ type: 'cmd-delete', cmd }));
  } else if (a === 'edit') {
    cmdsEditing = cmdsEditing === cmd ? null : cmd;
    renderCmds();
  }
});

cmdsList.addEventListener('keydown', e => {
  if (!e.target.matches('.cm-cmd input')) return;
  if (e.key === 'Escape') { cmdsEditing = null; renderCmds(); }
  if (e.key === 'Enter') {
    const li = e.target.closest('li[data-cmd]');
    const nuevo = e.target.value.trim();
    cmdsEditing = null;
    if (nuevo && nuevo !== li.dataset.cmd)
      ws.send(JSON.stringify({ type: 'cmd-edit', old: li.dataset.cmd, new: nuevo }));
    else renderCmds();
  }
});

cmdsSearch.addEventListener('input', renderCmds);
document.getElementById('cmds-purge').addEventListener('click', () => {
  const singles = cmdLog.filter(c => c.count === 1).length;
  if (!singles) { vToast('no hay comandos de un solo uso'); return; }
  if (confirm(`¿Borrar los ${singles} comandos usados una sola vez?`))
    ws.send(JSON.stringify({ type: 'cmd-clear-singles' }));
});

document.getElementById('btn-cmds').addEventListener('click', () => {
  cmdsOv.classList.add('open');
  cmdsEditing = null;
  cmdsSearch.value = '';
  renderCmds();
  cmdsSearch.focus();
});
document.getElementById('cmds-close').addEventListener('click', () => cmdsOv.classList.remove('open'));
cmdsOv.addEventListener('mousedown', e => { if (e.target === cmdsOv) cmdsOv.classList.remove('open'); });

// El servidor rebroadcastea cmd-log tras cada cambio — repinta si está abierto
function cmdsOnLogUpdate() {
  if (cmdsOv.classList.contains('open')) renderCmds();
}

// ── Reinicio del servicio ─────────────────────────────────────
document.getElementById('btn-restart').addEventListener('click', () => {
  if (!confirm('Reiniciar el servicio completo:\n\n• Todas las sesiones se relanzan (pierden lo que tienen en pantalla)\n• Si configuraste un comando de actualización, correrá al arrancar\n• Requiere el autostart (launchd/systemd) — si corres npm start a mano, quedará apagado\n\n¿Continuar?')) return;
  ws.send(JSON.stringify({ type: 'restart-service' }));
  vToast('⟳ reiniciando el servicio…', 0);
});
