// 10-consumo.js — Barra de consumo: sesión 5h, semanal y contexto activo
// Script clásico: comparte scope global con los demás; el orden de carga importa.
// ── Token / session usage status bar ──────────────────────────
const sbWinWrap  = document.getElementById('sb-win-wrap');
const sbWinBar   = document.getElementById('sb-win-bar');
const sbWinPct   = document.getElementById('sb-win-pct');
const sbWinReset = document.getElementById('sb-win-reset');
const sbWkSep    = document.getElementById('sb-wk-sep');
const sbWkLabel  = document.getElementById('sb-wk-label');
const sbWkWrap   = document.getElementById('sb-wk-wrap');
const sbWkBar    = document.getElementById('sb-wk-bar');
const sbWkPct    = document.getElementById('sb-wk-pct');
const sbWkReset  = document.getElementById('sb-wk-reset');
const sbSession  = document.getElementById('sb-session');
const sbCtxTxt   = document.getElementById('sb-ctx-txt');
const sbTotal    = document.getElementById('sb-total');
const sbUpdated  = document.getElementById('sb-updated');
const sbRefresh  = document.getElementById('sb-refresh');

let official = null;   // { session:{percent,resetAt}, weekly:{percent,resetAt} } — exact, real
let officialStatus = null; // { error, backoffUntil, at } — why the exact value may be stale
let windowInfo = null; // local 5h window approximation (fallback if token unreadable)
let lastUsageAt = 0;   // when the last usage payload arrived (for "actualizado hace…")
let resetRefetchFor = 0; // guard: force-fetch only once per expired resetAt value
const BUDGET_KEY = 'cm-usage-budget';
const DEFAULT_BUDGET = 9400000; // calibrated (cost-weighted) so the bar ≈ claude.ai's %
function getBudget() { return parseInt(localStorage.getItem(BUDGET_KEY) || '', 10) || DEFAULT_BUDGET; }

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function fmtDur(ms) {
  if (ms <= 0) return 'ahora';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600),
        m = Math.floor((total % 3600) / 60), s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  // Show seconds when under an hour so the countdown visibly ticks
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

// Effective session view: the real number when available, else the local estimate
function sessionView() {
  if (official && official.session) return { pct: official.session.percent, resetAt: official.session.resetAt, real: true };
  if (windowInfo && windowInfo.active) return { pct: Math.min(100, Math.round(windowInfo.used / getBudget() * 100)), resetAt: windowInfo.resetAt, real: false };
  return null;
}
function panelName(id) {
  const el = document.querySelector(`.panel[data-id="${id}"] .ph-name`);
  return el ? el.textContent : '';
}
function setActiveSession(id) {
  if (activeSessionId === id) return;
  activeSessionId = id;
  renderStatusBar();
}

// Live countdowns — tick every second from the stored resetAt values
function renderCountdowns() {
  const s = sessionView();
  if (s && s.resetAt) {
    sbWinReset.className = '';
    sbWinReset.innerHTML = `<span class="sb-reset-ico">⟳</span> se restablece en ${fmtDur(s.resetAt - Date.now())}`;
  } else {
    sbWinReset.className = 'sb-empty';
    sbWinReset.textContent = 'sin actividad';
  }
  const w = official && official.weekly;
  if (w && w.resetAt) {
    sbWkReset.className = '';
    sbWkReset.textContent = `⟳ ${fmtDur(w.resetAt - Date.now())}`;
  } else {
    sbWkReset.className = 'sb-empty';
    sbWkReset.textContent = '';
  }
}

// Per-second tick: smooth countdowns + "actualizado hace Xs"
function tickStatusBar() {
  renderCountdowns();
  // The moment the session resets, fetch immediately so the fresh window shows
  // up instead of getting stuck on "ahora" until the next poll.
  const s = sessionView();
  if (s && s.resetAt && s.resetAt - Date.now() <= 0 && resetRefetchFor !== s.resetAt) {
    resetRefetchFor = s.resetAt; // once per expiry — avoids hammering while rate-limited
    requestUsage(true);
  }
  if (!lastUsageAt) { sbUpdated.textContent = ''; return; }
  const ago = Math.floor((Date.now() - lastUsageAt) / 1000);
  let txt = ago < 60 ? `hace ${ago}s` : `hace ${Math.floor(ago / 60)}m`;
  // If the exact % couldn't be fetched, say WHY — otherwise the refresh
  // button looks broken when the API is rate-limiting or there's no token.
  if (officialStatus && officialStatus.error) {
    const e = officialStatus.error;
    const wait = officialStatus.backoffUntil - Date.now();
    txt += e === 'http-429' ? ` · ⚠ API limitada${wait > 0 ? ' (' + fmtDur(wait) + ')' : ''}`
        :  e === 'no-token' ? ' · ⚠ sin token de sesión'
        :  ' · ⚠ API sin respuesta';
    sbUpdated.title = official
      ? 'No se pudo refrescar el % oficial — mostrando el último valor conocido'
      : 'No se pudo leer el % oficial — mostrando la estimación local (~)';
  } else sbUpdated.title = '';
  sbUpdated.textContent = txt;
}
setInterval(tickStatusBar, 1000);

function renderStatusBar() {
  // ── Session (hero) — exact when the token is readable, else local estimate ──
  const s = sessionView();
  if (s) {
    sbWinBar.style.width = Math.min(100, s.pct) + '%';
    sbWinBar.className = s.pct > 85 ? 'win-hot' : s.pct > 60 ? 'win-warm' : '';
    sbWinPct.textContent = (s.real ? '' : '~') + s.pct + '%';
  } else {
    sbWinBar.style.width = '0%';
    sbWinPct.textContent = '—';
  }

  // ── Weekly — exact, only shown when official data is available ──
  const w = official && official.weekly;
  const wkEls = [sbWkSep, sbWkLabel, sbWkWrap, sbWkPct, sbWkReset];
  if (w) {
    wkEls.forEach(el => el && (el.style.display = ''));
    sbWkBar.style.width = Math.min(100, w.percent) + '%';
    sbWkBar.className = w.percent > 85 ? 'win-hot' : w.percent > 60 ? 'win-warm' : '';
    sbWkPct.textContent = w.percent + '%';
  } else {
    wkEls.forEach(el => el && (el.style.display = 'none'));
  }

  renderCountdowns();

  // ── Active conversation context (secondary) ──
  const u = activeSessionId ? usageData[activeSessionId] : null;
  const name = activeSessionId ? panelName(activeSessionId) : '';
  if (!u) {
    sbSession.className = 'sb-empty';
    sbSession.textContent = activeSessionId ? `${name} · sin datos` : '— sesión activa —';
    sbCtxTxt.textContent = '';
  } else {
    sbSession.className = '';
    const model = (u.model || '').replace(/^claude-/, '').replace(/-\d{6,8}$/, '');
    sbSession.textContent = name + (model ? `  [${model}]` : '');
    const cpct = u.contextWindow ? Math.min(100, Math.round(u.context / u.contextWindow * 100)) : 0;
    sbCtxTxt.textContent = `· ctx ${cpct}% (${fmtTokens(u.context)})`;
  }

  // ── Session total tokens (right) ──
  let tIn = 0, tOut = 0, any = false;
  for (const us of Object.values(usageData)) { if (us) { any = true; tIn += us.input; tOut += us.output; } }
  sbTotal.textContent = any ? `Σ sesiones ↓${fmtTokens(tIn)} ↑${fmtTokens(tOut)}` : '';
}

// Click the bar to calibrate the estimated 5h budget used for the %
sbWinWrap.addEventListener('click', () => {
  const cur = getBudget();
  const v = prompt('Presupuesto estimado de tokens de tu ventana de 5h (para calcular el %).\n' +
                   'Súbelo o bájalo hasta que el % cuadre con claude.ai:', cur);
  if (v === null) return;
  const n = parseInt(v, 10);
  if (!isNaN(n) && n > 0) { localStorage.setItem(BUDGET_KEY, String(n)); renderStatusBar(); }
});

function requestUsage(force) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'usage', force: !!force }));
}

let usagePoll, gitPoll;
function startUsagePolling() {
  clearInterval(usagePoll); clearInterval(gitPoll);
  requestUsage(true);                       // immediate fresh read on (re)connect
  usagePoll = setInterval(() => requestUsage(false), 60000); // auto every 60s
  requestGitInfo();
  gitPoll = setInterval(requestGitInfo, 15000); // branch + pending changes badges
}

// Manual refresh button — forces a fresh server-side recompute
sbRefresh.addEventListener('click', () => {
  sbRefresh.classList.remove('spinning');
  void sbRefresh.offsetWidth;               // restart the spin animation
  sbRefresh.classList.add('spinning');
  requestUsage(true);
});

