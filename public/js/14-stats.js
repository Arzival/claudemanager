// 14-stats.js — Sección STATS: consumo histórico (Claude + Codex) por
// hora/día/semana/mes, modelos más usados y valor equivalente en la API.
// El servidor manda buckets crudos por hora; aquí se filtra y agrupa todo,
// así cambiar de periodo/proveedor/proyecto es instantáneo.
// Script clásico: comparte scope global con los demás; el orden de carga importa.

const statsView = document.getElementById('stats-view');
let stData = null;      // { hours, pricing }
let stPollTimer = null;
const stF = {           // filtros (persistidos por navegador)
  period: localStorage.getItem('claudemgr-st-period') || 'week',
  provider: localStorage.getItem('claudemgr-st-provider') || 'all',
  project: localStorage.getItem('claudemgr-st-project') || '',
  metric: localStorage.getItem('claudemgr-st-metric') || 'cost',
};
let stSort = { key: 'cost', dir: -1 };

// Paleta neón del tablero — un color fijo por modelo (por ranking de uso)
const ST_PALETTE = ['#00f5ff', '#ff006e', '#ffd60a', '#39ff14', '#bf00ff', '#0080ff',
  '#ff9500', '#60ffff', '#ff4090', '#80ff50', '#df80ff', '#40a0ff'];
let stColors = {};

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ── Utilidades ────────────────────────────────────────────────
function stMoney(v, dec = 2) {
  if (v == null) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function stTok(n) { return fmtTokens(Math.round(n || 0)); }
const stModelKey = m => (m || '').replace(/-\d{8}$/, '');   // claude-haiku-4-5-20251001 → claude-haiku-4-5
const stModelLabel = m => stModelKey(m).replace(/^claude-/, '');
function stParseHour(hk) {
  const [d, h] = hk.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(y, mo - 1, da, +h);
}
function stDayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function stAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function stPrice(model) {
  const p = stData && stData.pricing.models[stModelKey(model)];
  if (!p) return null;
  const ok = ['in', 'out'].some(f => p[f] > 0);
  return ok ? p : null;
}
function stCost(model, r) {
  const p = stPrice(model);
  if (!p) return null;
  return ((r.in || 0) * (p.in || 0) + (r.out || 0) * (p.out || 0) + (r.cr || 0) * (p.cr || 0) +
          (r.cw5 || 0) * (p.cw5 || 0) + (r.cw1 || 0) * (p.cw1 || 0)) / 1e6;
}
const stTokens = r => (r.in || 0) + (r.out || 0) + (r.cr || 0) + (r.cw5 || 0) + (r.cw1 || 0);

// ── Ventana de tiempo del periodo y su granularidad ───────────
function stRange() {
  const now = new Date();
  const today = stDayStart(now);
  if (stF.period === 'day') {
    const buckets = [];
    for (let h = 0; h < 24; h++) buckets.push({ start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), h), label: String(h).padStart(2, '0') + 'h' });
    return finish(today, stAddDays(today, 1), buckets, 'hora', 1, true);
  }
  if (stF.period === 'week' || stF.period === 'month') {
    const n = stF.period === 'week' ? 7 : 30;
    const start = stAddDays(today, -(n - 1));
    const buckets = [];
    for (let i = 0; i < n; i++) {
      const d = stAddDays(start, i);
      buckets.push({ start: d, label: n === 7 ? `${DIAS[d.getDay()]} ${d.getDate()}` : `${d.getDate()}/${d.getMonth() + 1}` });
    }
    return finish(start, stAddDays(today, 1), buckets, 'día', n, true);
  }
  // Todo: desde el primer dato, con granularidad según la extensión
  const keys = Object.keys(stData.hours).sort();
  const first = keys.length ? stDayStart(stParseHour(keys[0])) : today;
  const spanDays = Math.max(1, Math.round((today - first) / 86400e3) + 1);
  const buckets = [];
  if (spanDays <= 60) {
    for (let i = 0; i < spanDays; i++) { const d = stAddDays(first, i); buckets.push({ start: d, label: `${d.getDate()}/${d.getMonth() + 1}` }); }
    return finish(first, stAddDays(today, 1), buckets, 'día', spanDays, false);
  }
  if (spanDays <= 240) {
    let d = stAddDays(first, -((first.getDay() + 6) % 7)); // lunes
    while (d <= today) { buckets.push({ start: d, label: `${d.getDate()} ${MESES[d.getMonth()]}` }); d = stAddDays(d, 7); }
    return finish(buckets[0].start, stAddDays(today, 1), buckets, 'semana', spanDays, false);
  }
  let d = new Date(first.getFullYear(), first.getMonth(), 1);
  while (d <= today) { buckets.push({ start: d, label: `${MESES[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` }); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
  return finish(buckets[0].start, stAddDays(today, 1), buckets, 'mes', spanDays, false);

  function finish(start, end, buckets, unit, days, comparable) {
    for (let i = 0; i < buckets.length; i++) buckets[i].end = i + 1 < buckets.length ? buckets[i + 1].start : end;
    const prev = comparable ? { start: new Date(start - (end - start)), end: start } : null;
    return { start, end, buckets, unit, days, prev };
  }
}

// ── Agregación de los buckets crudos según filtros ────────────
function stRowPasses(prov, project) {
  if (stF.provider !== 'all' && prov !== stF.provider) return false;
  if (stF.project && project !== stF.project) return false;
  return true;
}

function stAggregate(range) {
  const A = {
    tokens: 0, cost: 0, unpriced: 0, in: 0, out: 0, cr: 0, cw: 0,
    sessions: new Set(), models: {}, providers: {}, buckets: range.buckets.map(() => ({ models: {}, tok: 0, cost: 0 })),
    days: {}, prevCost: 0, prevTokens: 0, prevSeen: false,
  };
  const bIndex = t => {
    // buckets ordenados → búsqueda binaria
    let lo = 0, hi = range.buckets.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, b = range.buckets[m];
      if (t < b.start) hi = m - 1; else if (t >= b.end) lo = m + 1; else return m;
    }
    return -1;
  };
  for (const [hk, h] of Object.entries(stData.hours)) {
    const t = stParseHour(hk);
    const inPrev = range.prev && t >= range.prev.start && t < range.prev.end;
    if (inPrev) {
      for (const [k, r] of Object.entries(h.r)) {
        const [prov, model, project] = k.split('|');
        if (!stRowPasses(prov, project)) continue;
        A.prevSeen = true;
        A.prevTokens += stTokens(r);
        A.prevCost += stCost(model, r) || 0;
      }
      continue;
    }
    if (t < range.start || t >= range.end) continue;
    const bi = bIndex(t);
    const dayKey = hk.slice(0, 10);
    for (const [k, r] of Object.entries(h.r)) {
      const [prov, model, project] = k.split('|');
      if (!stRowPasses(prov, project)) continue;
      const tok = stTokens(r), c = stCost(model, r);
      A.tokens += tok; A.in += r.in; A.out += r.out; A.cr += r.cr; A.cw += (r.cw5 || 0) + (r.cw1 || 0);
      if (c == null) A.unpriced += tok; else A.cost += c;
      const M = A.models[model] || (A.models[model] = { model, prov, in: 0, out: 0, cr: 0, cw: 0, tokens: 0, cost: 0, priced: c != null, n: 0 });
      M.in += r.in; M.out += r.out; M.cr += r.cr; M.cw += (r.cw5 || 0) + (r.cw1 || 0); M.tokens += tok; M.cost += c || 0; M.n += r.n;
      const P = A.providers[prov] || (A.providers[prov] = { tokens: 0, cost: 0, series: range.buckets.map(() => ({ tok: 0, cost: 0 })) });
      P.tokens += tok; P.cost += c || 0;
      if (bi >= 0) {
        const B = A.buckets[bi];
        const bm = B.models[model] || (B.models[model] = { tok: 0, cost: 0 });
        bm.tok += tok; bm.cost += c || 0; B.tok += tok; B.cost += c || 0;
        P.series[bi].tok += tok; P.series[bi].cost += c || 0;
      }
      const D = A.days[dayKey] || (A.days[dayKey] = {});
      const pr = D[project] || (D[project] = { tok: 0, cost: 0, prov: new Set() });
      pr.tok += tok; pr.cost += c || 0; pr.prov.add(prov);
    }
    for (const s of h.s) {
      const [prov, project] = s.split('|');
      if (stRowPasses(prov, project)) A.sessions.add(s);
    }
  }
  return A;
}

function stAssignColors() {
  const tot = {};
  for (const h of Object.values(stData.hours))
    for (const [k, r] of Object.entries(h.r)) { const m = k.split('|')[1]; tot[m] = (tot[m] || 0) + stTokens(r); }
  stColors = {};
  Object.keys(tot).sort((a, b) => tot[b] - tot[a]).forEach((m, i) => { stColors[m] = ST_PALETTE[i % ST_PALETTE.length]; });
}

// ── Render ────────────────────────────────────────────────────
function stDeltaBadge(cur, prev, seen) {
  if (!seen || !prev) return '<span class="st-badge flat">sin periodo previo</span>';
  const d = Math.round((cur - prev) / prev * 100);
  if (!d) return '<span class="st-badge flat">= vs anterior</span>';
  // Más consumo = rosa (alerta), menos = verde
  return `<span class="st-badge ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}% vs anterior</span>`;
}

const ST_PERIOD_TXT = { day: 'hoy', week: 'últimos 7 días', month: 'últimos 30 días', all: 'todo el historial' };

function stRenderHero(A) {
  const whole = Math.floor(A.cost), dec = (A.cost - whole).toFixed(2).slice(1);
  const allUnpriced = A.tokens > 0 && A.cost === 0;
  const top = Object.values(A.models).sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens))[0];
  const cacheHit = A.cr + A.in + A.cw ? Math.round(A.cr / (A.cr + A.in + A.cw) * 100) : 0;
  document.getElementById('st-hero').innerHTML = `
    <div class="st-card-hdr"><span>VALOR API EQUIVALENTE · ${ST_PERIOD_TXT[stF.period].toUpperCase()}</span>
      <span class="st-dim">${A.unpriced ? stTok(A.unpriced) + ' tokens sin precio no suman' : 'lo que costaría sin suscripción'}</span></div>
    <div class="st-hero-top">
      ${allUnpriced
        ? `<div class="st-big" style="color:var(--yellow)">sin precio</div>
           <span class="st-nop" data-model="">captura el precio de sus modelos en ⚙ precios →</span>`
        : `<div class="st-big">$${whole.toLocaleString('en-US')}<span class="dec">${dec}</span></div>
           ${stDeltaBadge(A.cost, A.prevCost, A.prevSeen)}`}
    </div>
    <div class="st-kpis">
      <div class="st-kpi"><div class="st-kpi-l">TOKENS</div><div class="st-kpi-v">${stTok(A.tokens)}</div>
        <div class="st-kpi-s">↓${stTok(A.in + A.cw)} ↑${stTok(A.out)}</div></div>
      <div class="st-kpi"><div class="st-kpi-l">SESIONES</div><div class="st-kpi-v">${A.sessions.size}</div>
        <div class="st-kpi-s">${Object.keys(A.models).length} modelo(s)</div></div>
      <div class="st-kpi"><div class="st-kpi-l">MODELO TOP</div>
        <div class="st-kpi-v" style="color:${top ? stColors[top.model] : '#e8f4ff'}">${top ? escHtml(stModelLabel(top.model)) : '—'}</div>
        <div class="st-kpi-s">${top ? (top.priced ? stMoney(top.cost) : stTok(top.tokens) + ' tok') : ''}</div></div>
      <div class="st-kpi"><div class="st-kpi-l">CACHÉ</div><div class="st-kpi-v">${cacheHit}%</div>
        <div class="st-kpi-s">${stTok(A.cr)} leídos de caché</div></div>
    </div>`;
}

function stRenderChart(range, A) {
  const el = document.getElementById('st-chart');
  // Uso sin precio capturado ≠ sin uso: en ese caso se grafican tokens con aviso
  const noPrice = stF.metric === 'cost' && A.tokens > 0 && !A.buckets.some(b => b.cost > 0);
  const cost = stF.metric === 'cost' && !noPrice;
  document.getElementById('st-chart-title').innerHTML =
    `${cost ? 'VALOR API' : 'TOKENS'} POR ${range.unit.toUpperCase()} ` +
    `<span class="st-metric"><button class="st-btn ${cost ? 'st-primary' : ''}" data-m="cost">$</button>` +
    `<button class="st-btn ${!cost ? 'st-primary' : ''}" data-m="tokens">tokens</button></span>`;
  const models = Object.values(A.models).sort((a, b) => b.tokens - a.tokens).map(m => m.model);
  document.getElementById('st-legend').innerHTML = (noPrice
    ? '<span style="color:var(--yellow)">⚠ sin precio — mostrando tokens</span>' : '') +
    models.slice(0, 8).map(m => `<span><i style="background:${stColors[m]}"></i>${escHtml(stModelLabel(m))}</span>`).join('');
  const val = b => cost ? b.cost : b.tok;
  const max = Math.max(...A.buckets.map(val), 0);
  if (!max) { el.innerHTML = '<div class="st-empty">sin consumo en este periodo</div>'; return; }

  const W = el.clientWidth || 600, H = el.clientHeight || 230;
  const padL = 52, padB = 22, padT = 8, n = A.buckets.length;
  const cw = (W - padL) / n, bw = Math.max(3, Math.min(34, cw * 0.62));
  const y = v => H - padB - (v / max) * (H - padB - padT);
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs>`;
  // Columnas en forma de píldora: cada segmento se recorta con un rect redondeado
  A.buckets.forEach((b, i) => {
    const v = val(b); if (!v) return;
    const x = padL + i * cw + (cw - bw) / 2;
    svg += `<clipPath id="stc${i}"><rect x="${x}" y="${y(v)}" width="${bw}" height="${H - padB - y(v)}" rx="${Math.min(bw / 2, 6)}"/></clipPath>`;
  });
  svg += '</defs>';
  for (let g = 0; g <= 4; g++) {
    const v = max * g / 4, yy = y(v);
    svg += `<line x1="${padL}" x2="${W}" y1="${yy}" y2="${yy}" stroke="rgba(0,245,255,${g ? .07 : .2})"/>` +
      `<text x="${padL - 6}" y="${yy + 3}" text-anchor="end" fill="rgba(160,180,200,.45)" font-size="9" font-family="Courier New">${cost ? stMoney(v, v < 10 ? 2 : 0) : stTok(v)}</text>`;
  }
  const every = Math.ceil(n / Math.max(1, Math.floor((W - padL) / 46)));
  A.buckets.forEach((b, i) => {
    const x = padL + i * cw + (cw - bw) / 2;
    svg += `<g class="st-col" data-i="${i}"><rect x="${padL + i * cw}" y="${padT}" width="${cw}" height="${H - padB - padT}" fill="transparent"/>`;
    let acc = 0;
    for (const m of models) {
      const s = b.models[m]; if (!s) continue;
      const v = cost ? s.cost : s.tok; if (!v) continue;
      const y1 = y(acc + v), y0 = y(acc);
      svg += `<rect class="st-bar" clip-path="url(#stc${i})" x="${x}" y="${y1}" width="${bw}" height="${Math.max(0, y0 - y1)}" fill="${stColors[m]}" fill-opacity=".85"/>`;
      acc += v;
    }
    svg += '</g>';
    if (i % every === 0)
      svg += `<text x="${padL + i * cw + cw / 2}" y="${H - 6}" text-anchor="middle" fill="rgba(160,180,200,.5)" font-size="9" font-family="Courier New">${range.buckets[i].label}</text>`;
  });
  el.innerHTML = svg + '</svg>';
  el._ctx = { range, A, models };
}

function stSpark(series, color, metric) {
  const vals = series.map(s => metric === 'cost' ? s.cost : s.tok);
  const max = Math.max(...vals, 0);
  if (!max) return '<div class="st-dim" style="padding-top:16px">sin actividad</div>';
  const W = 220, H = 46, n = vals.length;
  const pts = vals.map((v, i) => [n === 1 ? W / 2 : i * W / (n - 1), H - 4 - v / max * (H - 8)]);
  // Curva suavizada (Catmull-Rom → Bézier)
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  const id = 'sg' + color.slice(1);
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d} L${W},${H} L0,${H} Z" fill="url(#${id})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" style="filter:drop-shadow(0 0 4px ${color})"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3" fill="${color}"/></svg>`;
}

function stRenderProviders(A, prevByProv) {
  const provs = [['claude', 'CLAUDE', '#00f5ff'], ['codex', 'CODEX', '#39ff14']]
    .filter(([p]) => stF.provider === 'all' || stF.provider === p);
  document.getElementById('st-prov').innerHTML = provs.map(([p, name, color]) => {
    const P = A.providers[p];
    const prev = prevByProv[p];
    return `<section class="st-card">
      <div class="st-card-hdr"><span class="st-prov-name" style="color:${color}">${name}</span>
        ${P ? stDeltaBadge(P.cost, prev ? prev.cost : 0, !!prev) : ''}</div>
      ${P && !P.cost
        ? `<div class="st-prov-v">${stTok(P.tokens)} <span class="st-dim">tokens</span></div>
           <div class="st-nop" data-model="">sin precio — clic para capturarlo</div>`
        : `<div class="st-prov-v">${P ? stMoney(P.cost) : '$0.00'}</div>
           <div class="st-dim">${P ? stTok(P.tokens) + ' tokens' : 'sin uso en el periodo'}</div>`}
      <div class="st-spark">${P ? stSpark(P.series, color, P.cost ? stF.metric : 'tokens') : ''}</div>
    </section>`;
  }).join('');
}

function stRenderTable(A) {
  const rows = Object.values(A.models);
  const k = stSort.key;
  rows.sort((a, b) => {
    const va = k === 'model' ? stModelLabel(a.model) : a[k], vb = k === 'model' ? stModelLabel(b.model) : b[k];
    return (va > vb ? 1 : va < vb ? -1 : 0) * stSort.dir;
  });
  const cols = [['model', 'MODELO'], ['in', 'ENTRADA'], ['out', 'SALIDA'], ['cr', 'CACHÉ LEÍDA'],
                ['cw', 'CACHÉ ESCRITA'], ['tokens', '% TOKENS'], ['cost', 'VALOR API']];
  const total = A.tokens || 1;
  document.getElementById('st-table').innerHTML =
    '<thead><tr>' + cols.map(([c, l]) => `<th data-k="${c}" class="${c === k ? 'on' : ''}">${l}${c === k ? (stSort.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('') + '</tr></thead><tbody>' +
    (rows.map(m => {
      const pct = m.tokens / total * 100;
      return `<tr>
        <td><span class="st-dot" style="background:${stColors[m.model]};color:${stColors[m.model]}"></span>${escHtml(stModelLabel(m.model))}<span class="st-pv ${m.prov}">${m.prov.toUpperCase()}</span></td>
        <td>${stTok(m.in)}</td><td>${stTok(m.out)}</td><td>${stTok(m.cr)}</td><td>${stTok(m.cw)}</td>
        <td>${pct.toFixed(1)}%<span class="st-pctbar"><b style="width:${pct}%;background:${stColors[m.model]}"></b></span></td>
        <td>${m.priced ? stMoney(m.cost) : `<span class="st-nop" data-model="${escHtml(stModelKey(m.model))}">sin precio</span>`}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="st-dim">sin consumo en este periodo</td></tr>') + '</tbody>';
}

function stRenderSavings(A, range) {
  const subs = stData.pricing.subscriptions;
  // Suscripción prorrateada a los días del periodo, solo de proveedores con uso
  const provs = Object.keys(A.providers).filter(p => stF.provider === 'all' || stF.provider === p);
  const paid = provs.reduce((s, p) => s + (subs[p] || 0) * range.days / 30.44, 0);
  const value = provs.reduce((s, p) => s + A.providers[p].cost, 0);
  const mult = paid ? value / paid : 0;
  const share = value ? Math.min(100, paid / value * 100) : 0;
  document.getElementById('st-save').innerHTML = `
    <div class="st-card-hdr"><span>AHORRO VS API</span><span class="st-dim">${ST_PERIOD_TXT[stF.period]}</span></div>
    <div class="st-save-row" title="Tu suscripción mensual ajustada a los días del periodo: mensualidad × ${range.days} ÷ 30.4"><span>pagas en ${range.days} día${range.days === 1 ? '' : 's'}</span><b>${stMoney(paid)}</b></div>
    <div class="st-save-row"><span>valdría por API</span><b>${stMoney(value)}</b></div>
    <div class="st-mult">${paid && value ? '×' + mult.toFixed(1) : '—'}</div>
    <div class="st-dim">${A.tokens && !value ? 'el consumo de este filtro no tiene precio capturado' : paid ? (mult >= 1 ? `tu suscripción rinde ${mult.toFixed(1)} veces su costo` : 'en este periodo saldría más barato pagar por API') : 'configura tu suscripción en ⚙ precios'}</div>
    <div class="st-meter" title="Lo que pagas como % del valor API"><b style="width:${share}%"></b></div>
    <div class="st-save-row"><span class="st-dim">pagas el ${share.toFixed(share < 10 ? 1 : 0)}% del valor</span></div>
    <div class="st-dim" style="margin-top:4px">${provs.map(p => p + ' $' + (subs[p] || 0) + '/mes').join(' · ')}</div>`;
}

function stRenderActivity(A) {
  const today = stDayStart(new Date());
  const days = Object.keys(A.days).sort().reverse().slice(0, 10);
  const label = dk => {
    const [y, m, d] = dk.split('-').map(Number);
    const diff = Math.round((today - new Date(y, m - 1, d)) / 86400e3);
    return diff === 0 ? 'HOY' : diff === 1 ? 'AYER' : `${DIAS[new Date(y, m - 1, d).getDay()].toUpperCase()} ${d} ${MESES[m - 1].toUpperCase()}`;
  };
  document.getElementById('st-activity').innerHTML = days.map(dk => {
    const projs = Object.entries(A.days[dk]).sort((a, b) => (b[1].cost - a[1].cost) || (b[1].tok - a[1].tok)).slice(0, 5);
    return `<div class="st-day">${label(dk)}</div>` + projs.map(([p, v]) =>
      `<div class="st-arow"><span>${escHtml(p)} <span class="st-dim">${stTok(v.tok)}</span></span><span class="c">${v.cost ? stMoney(v.cost) : '<span class="st-dim">sin precio</span>'}</span></div>`).join('');
  }).join('') || '<div class="st-dim">sin actividad en este periodo</div>';
}

function stRenderRail() {
  document.querySelectorAll('.st-seg').forEach(seg => {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === stF[seg.dataset.k]));
  });
  const projects = new Set();
  for (const h of Object.values(stData.hours)) for (const k of Object.keys(h.r)) projects.add(k.split('|')[2]);
  const sel = document.getElementById('st-project');
  sel.innerHTML = '<option value="">Todos</option>' + [...projects].sort()
    .map(p => `<option value="${escHtml(p)}" ${p === stF.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('');
}

function stRender() {
  if (!stData) return;
  stAssignColors();
  stRenderRail();
  const range = stRange();
  const A = stAggregate(range);
  // Totales del periodo anterior por proveedor (para los badges de las tarjetas)
  const prevByProv = {};
  if (range.prev) {
    for (const [hk, h] of Object.entries(stData.hours)) {
      const t = stParseHour(hk);
      if (t < range.prev.start || t >= range.prev.end) continue;
      for (const [k, r] of Object.entries(h.r)) {
        const [prov, model, project] = k.split('|');
        if (!stRowPasses(prov, project)) continue;
        const P = prevByProv[prov] || (prevByProv[prov] = { cost: 0 });
        P.cost += stCost(model, r) || 0;
      }
    }
  }
  stRenderHero(A);
  stRenderChart(range, A);
  stRenderProviders(A, prevByProv);
  stRenderTable(A);
  stRenderSavings(A, range);
  stRenderActivity(A);
}

// ── Tooltip de la gráfica ─────────────────────────────────────
const stTip = document.getElementById('st-tip');
document.getElementById('st-chart').addEventListener('mousemove', e => {
  const col = e.target.closest('.st-col');
  const ctx = e.currentTarget._ctx;
  if (!col || !ctx) { stTip.style.display = 'none'; return; }
  const i = +col.dataset.i, B = ctx.A.buckets[i];
  if (!B.tok) { stTip.style.display = 'none'; return; }
  const b = ctx.range.buckets[i];
  const rows = ctx.models.filter(m => B.models[m]).map(m =>
    `<div><span><span class="st-dot" style="background:${stColors[m]}"></span>${escHtml(stModelLabel(m))}</span>` +
    `<span>${stTok(B.models[m].tok)} · ${stMoney(B.models[m].cost)}</span></div>`).join('');
  stTip.innerHTML = `<h4>${b.label}</h4>${rows}<div style="margin-top:5px;color:var(--yellow)"><span>Total</span><span>${stTok(B.tok)} · ${stMoney(B.cost)}</span></div>`;
  stTip.style.display = 'block';
  stTip.style.left = Math.min(e.clientX + 14, innerWidth - stTip.offsetWidth - 8) + 'px';
  stTip.style.top = Math.max(8, e.clientY - stTip.offsetHeight - 12) + 'px';
});
document.getElementById('st-chart').addEventListener('mouseleave', () => { stTip.style.display = 'none'; });
new ResizeObserver(() => { if (statsView.classList.contains('open')) stRender(); })
  .observe(document.getElementById('st-chart'));

// ── Controles ─────────────────────────────────────────────────
function stSet(k, v) {
  stF[k] = v;
  localStorage.setItem('claudemgr-st-' + k, v);
  stRender();
}
document.querySelectorAll('.st-seg').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) stSet(seg.dataset.k, b.dataset.v);
}));
document.getElementById('st-project').addEventListener('change', e => stSet('project', e.target.value));
document.getElementById('st-chart-title').addEventListener('click', e => {
  const b = e.target.closest('[data-m]'); if (b) stSet('metric', b.dataset.m);
});
document.getElementById('st-table').addEventListener('click', e => {
  const nop = e.target.closest('.st-nop');
  if (nop) { stOpenPrices(nop.dataset.model); return; }
  const th = e.target.closest('th'); if (!th) return;
  stSort = { key: th.dataset.k, dir: stSort.key === th.dataset.k ? -stSort.dir : (th.dataset.k === 'model' ? 1 : -1) };
  stRender();
});

function stRequest() {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stats' }));
}
function stOpen() {
  statsView.classList.add('open');
  if (!stData) document.getElementById('st-loading').style.display = 'block';
  else stRender();
  stRequest();
  clearInterval(stPollTimer);
  stPollTimer = setInterval(stRequest, 60000); // se actualiza sola mientras está abierta
}
function stClose() {
  statsView.classList.remove('open');
  document.getElementById('st-prices-panel').classList.remove('open');
  stTip.style.display = 'none';
  clearInterval(stPollTimer);
}
document.getElementById('btn-stats').addEventListener('click', stOpen);
document.getElementById('st-close').addEventListener('click', stClose);
document.getElementById('st-refresh').addEventListener('click', stRequest);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !statsView.classList.contains('open')) return;
  const prices = document.getElementById('st-prices-panel');
  if (prices.classList.contains('open')) prices.classList.remove('open'); else stClose();
});

// ── Editor de precios ─────────────────────────────────────────
function stOpenPrices(focusModel) {
  const panel = document.getElementById('st-prices-panel');
  const seen = new Set();
  for (const h of Object.values(stData.hours)) for (const k of Object.keys(h.r)) seen.add(stModelKey(k.split('|')[1]));
  const models = [...new Set([...Object.keys(stData.pricing.models), ...seen])]
    .sort((a, b) => (seen.has(b) - seen.has(a)) || a.localeCompare(b));
  const f = ['in', 'out', 'cr', 'cw5', 'cw1'];
  document.getElementById('st-prices-table').innerHTML =
    '<thead><tr><th>MODELO</th><th>ENTRADA</th><th>SALIDA</th><th>CACHÉ LEÍDA</th><th>CACHÉ 5m</th><th>CACHÉ 1h</th></tr></thead><tbody>' +
    models.map(m => {
      const p = stData.pricing.models[m] || {};
      return `<tr data-m="${escHtml(m)}"><td>${escHtml(m)}${seen.has(m) ? '' : ' <span class="st-dim">(sin uso)</span>'}</td>` +
        f.map(k => `<td><input data-f="${k}" value="${p[k] != null ? p[k] : ''}" placeholder="—"></td>`).join('') + '</tr>';
    }).join('') + '</tbody>';
  const subs = stData.pricing.subscriptions;
  document.getElementById('st-prices-subs').innerHTML = 'Suscripción mensual (USD): ' +
    ['claude', 'codex'].map(p => `<label>${p} <input data-sub="${p}" value="${subs[p] != null ? subs[p] : ''}"></label>`).join('');
  panel.classList.add('open');
  if (focusModel) {
    const row = panel.querySelector(`tr[data-m="${CSS.escape(focusModel)}"] input`);
    if (row) { row.scrollIntoView({ block: 'center' }); row.focus(); }
  }
}
document.getElementById('st-prices').addEventListener('click', () => stData && stOpenPrices());
['st-hero', 'st-prov'].forEach(id => document.getElementById(id).addEventListener('click', e => {
  if (e.target.closest('.st-nop')) stOpenPrices();
}));
document.getElementById('st-prices-close').addEventListener('click', () =>
  document.getElementById('st-prices-panel').classList.remove('open'));
document.getElementById('st-prices-save').addEventListener('click', () => {
  const panel = document.getElementById('st-prices-panel');
  const models = {};
  panel.querySelectorAll('tbody tr[data-m]').forEach(tr => {
    const p = {};
    tr.querySelectorAll('input[data-f]').forEach(i => { if (i.value.trim() !== '') p[i.dataset.f] = parseFloat(i.value); });
    if (Object.keys(p).length) models[tr.dataset.m] = p;
  });
  const subscriptions = {};
  panel.querySelectorAll('input[data-sub]').forEach(i => { if (i.value.trim() !== '') subscriptions[i.dataset.sub] = parseFloat(i.value); });
  ws.send(JSON.stringify({ type: 'save-pricing', pricing: { models, subscriptions } }));
  panel.classList.remove('open');
  vToast('✓ precios guardados');
});

// ── Mensajes del servidor (llamados desde 11-ws.js) ───────────
function statsOnData(msg) {
  stData = { hours: msg.hours || {}, pricing: msg.pricing };
  document.getElementById('st-loading').style.display = 'none';
  if (statsView.classList.contains('open')) stRender();
}
function statsOnPricing(pricing) {
  if (!stData) return;
  stData.pricing = pricing;
  if (statsView.classList.contains('open')) stRender();
}
