// lib/stats.js — Historial de consumo (Claude Code + Codex) para la sección STATS.
//
// Lee de forma INCREMENTAL los transcripts de Claude (~/.claude/projects) y
// los rollouts de Codex (~/.codex/sessions) y los acumula en buckets por HORA
// (hora local) × proveedor × modelo × proyecto, persistidos en
// ~/.claudemanager/usage-history.json. El resumen sobrevive aunque las
// herramientas borren sus archivos viejos, y tras la primera pasada solo se
// procesan los bytes nuevos.
//
// Exactitud:
//  - Claude escribe el mismo mensaje varias veces mientras transmite (mismo
//    message.id, misma usage) → se deduplica por id, global entre archivos.
//  - Codex guarda totales ACUMULADOS por sesión → se suman deltas entre
//    snapshots consecutivos de token_count.
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const VERSION = 1;
const SEEN_TTL_DAYS = 120; // ids de mensaje recordados para deduplicar

let historyFile = null;
let state = null;
let scanning = null; // Promise de la pasada en curso

function emptyState() {
  return { version: VERSION, files: {}, seen: {}, hours: {} };
}

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (state.version !== VERSION) state = emptyState();
  } catch { state = emptyState(); }
  return state;
}

function save() {
  // Purga ids viejos: un duplicado de hace meses ya no va a aparecer
  const today = Math.floor(Date.now() / 86400e3);
  for (const [id, d] of Object.entries(state.seen))
    if (today - d > SEEN_TTL_DAYS) delete state.seen[id];
  const tmp = historyFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, historyFile); // escritura atómica
}

function hourKey(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

function add(hk, provider, model, project, session, u) {
  const h = state.hours[hk] || (state.hours[hk] = { r: {}, s: {} });
  const key = `${provider}|${model}|${project}`;
  const r = h.r[key] || (h.r[key] = { in: 0, out: 0, cr: 0, cw5: 0, cw1: 0, n: 0 });
  r.in += u.in || 0; r.out += u.out || 0; r.cr += u.cr || 0;
  r.cw5 += u.cw5 || 0; r.cw1 += u.cw1 || 0; r.n += 1;
  if (session) h.s[`${provider}|${project}|${session}`] = 1; // para contar sesiones
}

function listJsonl(dir, maxDepth) {
  const out = [];
  const walk = (d, depth) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

// Lee los bytes nuevos de un archivo y entrega solo líneas COMPLETAS; la
// posición guardada siempre queda justo después del último salto de línea.
async function readNewLines(file, fst) {
  let st; try { st = await fs.promises.stat(file); } catch { return null; }
  if (fst.ino !== st.ino || st.size < fst.pos) { fst.ino = st.ino; fst.pos = 0; fst.reset = true; }
  if (st.size === fst.pos) return [];
  const fh = await fs.promises.open(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(st.size - fst.pos);
    await fh.read(buf, 0, buf.length, fst.pos);
  } finally { await fh.close(); }
  const lastNl = buf.lastIndexOf(10);
  if (lastNl < 0) return [];
  fst.pos += lastNl + 1;
  return buf.toString('utf8', 0, lastNl).split('\n');
}

async function scanClaude(file) {
  const fst = state.files[file] || (state.files[file] = { kind: 'claude', ino: 0, pos: 0 });
  const lines = await readNewLines(file, fst);
  if (!lines) return;
  for (const line of lines) {
    if (!line.includes('"usage"')) continue; // filtro barato antes de parsear
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type !== 'assistant' || !m || !m.usage || !m.id) continue;
    if (!m.model || m.model === '<synthetic>') continue;
    if (state.seen[m.id]) continue;
    const hk = hourKey(o.timestamp);
    if (!hk) continue;
    state.seen[m.id] = Math.floor(Date.parse(o.timestamp) / 86400e3);
    const u = m.usage;
    const cc = u.cache_creation || {};
    const cw = u.cache_creation_input_tokens || 0;
    const cw1 = cc.ephemeral_1h_input_tokens || 0;
    const cw5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, cw - cw1);
    add(hk, 'claude', m.model, path.basename(o.cwd || '') || '(desconocido)', o.sessionId, {
      in: u.input_tokens, out: u.output_tokens, cr: u.cache_read_input_tokens, cw5, cw1,
    });
  }
}

async function scanCodex(file) {
  const fst = state.files[file] ||
    (state.files[file] = { kind: 'codex', ino: 0, pos: 0, prev: null, model: '', cwd: '', sid: '' });
  const lines = await readNewLines(file, fst);
  if (!lines) return;
  if (fst.reset) { fst.prev = null; fst.reset = false; }
  for (const line of lines) {
    if (!/session_meta|turn_context|token_count/.test(line)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (o.type === 'session_meta') {
      fst.cwd = p.cwd || fst.cwd;
      fst.sid = p.id || p.session_id || fst.sid;
      continue;
    }
    if (p.model) fst.model = p.model;
    if (p.type !== 'token_count' || !p.info || !p.info.total_token_usage) continue;
    const t = p.info.total_token_usage;
    const cur = { in: t.input_tokens || 0, cached: t.cached_input_tokens || 0, out: t.output_tokens || 0 };
    const prev = fst.prev || { in: 0, cached: 0, out: 0 };
    // Totales acumulados → delta; si bajaran (sesión reiniciada) cuenta el valor actual
    const d = cur.in >= prev.in ? {
      in: cur.in - prev.in, cached: cur.cached - prev.cached, out: cur.out - prev.out,
    } : cur;
    fst.prev = cur;
    if (!d.in && !d.out) continue;
    const hk = hourKey(o.timestamp);
    if (!hk) continue;
    add(hk, 'codex', fst.model || 'codex', path.basename(fst.cwd || '') || '(desconocido)', fst.sid, {
      in: Math.max(0, d.in - d.cached), cr: Math.max(0, d.cached), out: Math.max(0, d.out),
    });
  }
}

async function scanAll() {
  load();
  const claude = listJsonl(CLAUDE_DIR, 4);
  const codex = listJsonl(CODEX_DIR, 4);
  for (const f of claude) {
    await scanClaude(f);
    await new Promise(r => setImmediate(r)); // no acaparar el event loop
  }
  for (const f of codex) {
    await scanCodex(f);
    await new Promise(r => setImmediate(r));
  }
  save();
}

// Pasada incremental (una a la vez; las peticiones simultáneas esperan la misma)
function refresh() {
  if (!scanning) {
    scanning = scanAll().catch(err => console.error('[stats]', err.message))
      .finally(() => { scanning = null; });
  }
  return scanning;
}

// Datos crudos para el cliente: buckets por hora con sus filas y el conteo
// de sesiones distintas por (proveedor|proyecto). El cliente filtra/agrupa.
function snapshot() {
  load();
  const hours = {};
  for (const [hk, h] of Object.entries(state.hours))
    hours[hk] = { r: h.r, s: Object.keys(h.s) };
  return hours;
}

function init(dataDir) {
  historyFile = path.join(dataDir, 'usage-history.json');
}

module.exports = { init, refresh, snapshot };
