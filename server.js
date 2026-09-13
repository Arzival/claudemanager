const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

process.on('uncaughtException', err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const PORT = Number(process.env.PORT) || 3000;
const BUFFER_LIMIT = 1000;          // max chunks of replay history per session
const BUFFER_BYTES = 256 * 1024;    // cap replay history at ~256 KB per session
const FLUSH_MS = 16; // coalesce PTY output into one broadcast per frame

// State lives OUTSIDE the repo (~/.claudemanager) so updating the project
// (git clean, zip overwrite, discard changes…) can never wipe the sessions
// or the cached usage %. Legacy in-repo files are migrated on first boot.
const DATA_DIR = path.join(require('os').homedir(), '.claudemanager');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'sessions.json');
const LEGACY_CONFIG = path.join(__dirname, 'sessions.json');
if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_CONFIG)) {
  fs.copyFileSync(LEGACY_CONFIG, CONFIG_FILE);
  console.log(`Migrated sessions.json → ${CONFIG_FILE}`);
}
const EXAMPLE_FILE = path.join(__dirname, 'sessions.example.json');
const BACKGROUNDS_DIR = path.join(__dirname, 'fondos');
const IS_WIN = process.platform === 'win32';

// Background images live in fondos/ (folder is versioned, its contents are gitignored)
if (!fs.existsSync(BACKGROUNDS_DIR)) fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
const IMG_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif',
};
function listBackgrounds() {
  try {
    return fs.readdirSync(BACKGROUNDS_DIR, { withFileTypes: true })
      .filter(d => d.isFile() && IMG_TYPES[path.extname(d.name).toLowerCase()])
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

// Auto-create sessions.json from example if missing
if (!fs.existsSync(CONFIG_FILE)) {
  fs.copyFileSync(EXAMPLE_FILE, CONFIG_FILE);
  console.log('Created sessions.json from sessions.example.json — open http://localhost:3000 to configure.');
}

let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Coalesce high-frequency saves (e.g. many resize events during a drag) into
// one write. `config` is shared, so the deferred write always persists the
// latest state.
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveConfig(); }, 400);
}

// ── Command log (global) ──────────────────────────────────────
// Reconstructs the line the user types from raw pty input and records it on
// Enter into ONE global list (not per-project): recurring commands like
// `npm run dev` are useful in every project. The client filters this list by
// prefix as you type. Commands typed inside ssh count too — locally the
// foreground process for the whole remote session is the ssh client.
const COMMANDS_FILE = path.join(DATA_DIR, 'commands.json');
const MAX_COMMANDS = 3000;
let commands = [];
try { commands = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8')); } catch {}
if (!Array.isArray(commands)) commands = [];

let cmdSaveTimer = null;
function scheduleCmdSave() {
  if (cmdSaveTimer) return;
  cmdSaveTimer = setTimeout(() => {
    cmdSaveTimer = null;
    fs.writeFile(COMMANDS_FILE, JSON.stringify(commands), () => {});
  }, 500);
}

let cmdBroadcastTimer = null;
function scheduleCmdBroadcast() {
  if (cmdBroadcastTimer) return;
  cmdBroadcastTimer = setTimeout(() => {
    cmdBroadcastTimer = null;
    broadcast({ type: 'cmd-log', commands });
  }, 300);
}

// The suggestion box only makes sense at a shell prompt (or inside ssh) —
// never while typing prose into Claude or another TUI.
const SHELL_NAMES = new Set(['bash','zsh','sh','fish','dash','ksh','tcsh','csh',
  'ssh','mosh','mosh-client','powershell','pwsh','cmd','nu','wsl']);
function fgIsShell(s) {
  try {
    let name = String((s.proc && s.proc.process) || '');
    name = path.basename(name).toLowerCase().replace(/^-/, '').replace(/\.exe$/, '');
    return SHELL_NAMES.has(name);
  } catch { return false; }
}

// Never record what's typed at a password prompt: with echo off the keystrokes
// still reach us (ssh/su/git over https). Check the tail of the last output.
function atPasswordPrompt(id) {
  const buf = buffers.get(id);
  if (!buf || !buf.length) return false;
  const tail = buf.slice(-3).join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-200);
  return /(password|passphrase|contraseña|passcode|verification code)[^\n]*:?\s*$/i.test(tail);
}

// Estado de dictado incremental por cliente + cola de whisper (uno a la vez
// para no saturar el CPU con varias transcripciones simultáneas)
const dictations = new Map(); // ws -> Map(seq -> Promise<{text,error}>)
let whisperChain = Promise.resolve();
function transcribeP(audioB64) {
  const run = () => new Promise(res => transcribe(audioB64, (text, error) => res({ text, error })));
  const p = whisperChain.then(run, run);
  whisperChain = p;
  return p;
}

function recordCommand(cmd) {
  const now = Date.now();
  const hit = commands.find(c => c.cmd === cmd);
  if (hit) { hit.count++; hit.last = now; }
  else {
    commands.push({ cmd, count: 1, last: now });
    if (commands.length > MAX_COMMANDS) {
      commands.sort((a, b) => (b.count - a.count) || (b.last - a.last));
      commands.length = MAX_COMMANDS;
    }
  }
  scheduleCmdSave();
  scheduleCmdBroadcast();
}

// Per-session reconstruction of the current input line. Escape sequences
// (arrows = history recall / cursor moves) and Tab (completion) make the real
// line diverge from what was typed, so they poison the capture until it clears.
function trackInput(s, id, data) {
  const t = s.tracker || (s.tracker = { line: '', dirty: false, shell: false });
  data = data.replace(/\x1b\[20[01]~/g, ''); // bracketed-paste markers
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r' || ch === '\n') {
      const { line, dirty, shell } = t;
      t.line = ''; t.dirty = false;
      const cmd = line.trim();
      // Leading space = "don't record" (same convention as shell history)
      if (!dirty && shell && cmd.length >= 2 && !line.startsWith(' ') && !atPasswordPrompt(id))
        recordCommand(cmd);
    } else if (ch === '\x7f' || ch === '\b') {
      t.line = t.line.slice(0, -1);
    } else if (ch === '\x15' || ch === '\x03') { // Ctrl+U / Ctrl+C
      t.line = ''; t.dirty = false;
    } else if (ch === '\x1b') {
      t.dirty = true;
      // Skip the escape sequence's bytes so they don't land in the buffer
      if (data[i + 1] === '[') { i++; while (i + 1 < data.length && !/[A-Za-z~]/.test(data[i + 1])) i++; i++; }
      else if (data[i + 1] === 'O') i += 2;
    } else if (ch === '\t') {
      t.dirty = true;
    } else if (ch >= ' ' && t.line.length < 300) {
      if (!t.line) t.shell = fgIsShell(s); // sampled as the line starts — who owns the prompt
      t.line += ch;
    }
  }
}

// ── Voz: transcripción local con whisper.cpp ──────────────────
// El navegador manda PCM crudo (16kHz, mono, Int16) grabado con push-to-talk;
// aquí se envuelve en un WAV y se transcribe con whisper-cli. Todo local —
// el audio nunca sale de la máquina. El TTS de salida vive en el navegador
// (speechSynthesis), el servidor solo persiste la voz elegida por sesión.
const WHISPER_MODEL = path.join(DATA_DIR, 'models', 'ggml-small.bin');
let whisperBinCache;
function whisperBin() {
  if (whisperBinCache !== undefined) return whisperBinCache;
  try {
    const out = execSync(IS_WIN ? 'where whisper-cli' : 'which whisper-cli', { encoding: 'utf8' });
    whisperBinCache = out.split('\n')[0].trim() || null;
  } catch {
    whisperBinCache = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']
      .find(p => fs.existsSync(p)) || null;
  }
  return whisperBinCache;
}

// WAV = cabecera RIFF de 44 bytes + las muestras tal cual (PCM 16-bit LE)
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function transcribe(pcmB64, cb) {
  const bin = whisperBin();
  if (!bin) return cb(null, 'whisper-cli no está instalado (brew install whisper-cpp)');
  if (!fs.existsSync(WHISPER_MODEL)) return cb(null, `falta el modelo en ${WHISPER_MODEL}`);
  let pcm;
  try { pcm = Buffer.from(pcmB64, 'base64'); } catch { return cb(null, 'audio inválido'); }
  if (!pcm.length) return cb(null, 'audio vacío');
  if (pcm.length > 16000 * 2 * 300) return cb(null, 'audio demasiado largo (máx 5 min)');
  const tmp = path.join(require('os').tmpdir(), `cm_voice_${Date.now()}_${Math.floor(Math.random() * 1e6)}.wav`);
  try { fs.writeFileSync(tmp, pcmToWav(pcm, 16000)); } catch (e) { return cb(null, e.message); }
  execFile(bin, ['-m', WHISPER_MODEL, '-f', tmp, '-l', 'es', '-np', '-nt'],
    { timeout: 240000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      fs.unlink(tmp, () => {});
      if (err) return cb(null, 'whisper falló: ' + err.message.slice(0, 200));
      cb((out || '').replace(/\[[^\]]*\]/g, '').trim(), null);
    });
}

// Try to auto-detect claude binary path
let claudePathCache;
function detectClaude(force) {
  if (!force && claudePathCache !== undefined) return claudePathCache;
  claudePathCache = detectClaudeUncached();
  return claudePathCache;
}
function detectClaudeUncached() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = IS_WIN
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
        'C:\\Program Files\\claude\\claude.exe',
      ]
    : [
        '/opt/homebrew/bin/claude',   // macOS Apple Silicon
        '/usr/local/bin/claude',      // macOS Intel / Linux
        '/usr/bin/claude',            // Linux
        path.join(home, '.local/bin/claude'),
      ];
  try {
    const result = execSync(IS_WIN ? 'where claude' : 'which claude', { encoding: 'utf8' }).trim();
    return result.split('\n')[0].trim();
  } catch {}
  return candidates.find(p => fs.existsSync(p)) || '';
}

function isConfigured() {
  return !!(config.projectsRoot && fs.existsSync(config.projectsRoot) &&
            config.claudePath && fs.existsSync(config.claudePath));
}

const sessions = new Map();
const buffers = new Map();
const bufferBytes = new Map(); // id -> total byte length of buffers.get(id)
const pending = new Map(); // id -> { chunks: [], timer } — output waiting to be flushed
const clients = new Set();

function flushOutput(id) {
  const p = pending.get(id);
  if (!p) return;
  p.timer = null;
  if (!p.chunks.length) return;
  // With no browser connected, skip the join/stringify entirely — the replay
  // buffer already holds this output for when a client reconnects.
  if (!clients.size) { p.chunks.length = 0; return; }
  const data = p.chunks.join('');
  p.chunks.length = 0;
  broadcast({ type: 'output', sessionId: id, data });
}

function broadcast(msg) {
  if (!clients.size) return;
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(str);
  }
}

function spawnSession(cfg) {
  const { id, name, command, args = [], cwd, cols = 80, rows = 24 } = cfg;
  let proc;
  try {
    proc = pty.spawn(command, args, {
      name: IS_WIN ? 'windows-ansi' : 'xterm-256color', cols, rows,
      cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
      env: {
        ...process.env,
        HOME: process.env.HOME || process.env.USERPROFILE || '',
        LANG: process.env.LANG || 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      },
    });
  } catch (err) {
    console.error(`[${id}] spawn failed:`, err.message);
    sessions.set(id, { ...cfg, proc: null, status: 'exited' });
    return;
  }
  if (!buffers.has(id)) buffers.set(id, []);
  proc.onData((data) => {
    const s = sessions.get(id);
    if (s) s.lastOutAt = Date.now(); // señal de "sigue trabajando" para la voz
    const buf = buffers.get(id);
    if (!buf) return;
    buf.push(data);
    // Bound replay history by both chunk count and total bytes so a single
    // noisy session can't retain unbounded memory.
    let bytes = (bufferBytes.get(id) || 0) + Buffer.byteLength(data);
    while (buf.length > BUFFER_LIMIT || (bytes > BUFFER_BYTES && buf.length > 1))
      bytes -= Buffer.byteLength(buf.shift());
    bufferBytes.set(id, bytes);
    // Coalesce bursts of output into a single broadcast per frame to cut
    // message count and JSON.stringify churn under heavy streaming.
    let p = pending.get(id);
    if (!p) { p = { chunks: [], timer: null }; pending.set(id, p); }
    p.chunks.push(data);
    if (!p.timer) p.timer = setTimeout(() => flushOutput(id), FLUSH_MS);
  });
  proc.onExit(() => {
    flushOutput(id); // emit any buffered output before the exit status
    const s = sessions.get(id);
    if (s) s.status = 'exited';
    broadcast({ type: 'status', sessionId: id, status: 'exited' });
  });
  sessions.set(id, { ...cfg, proc, status: 'running' });
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.proc && s.proc.kill(); } catch {}
  const p = pending.get(id);
  if (p && p.timer) clearTimeout(p.timer);
  pending.delete(id);
  sessions.delete(id);
  buffers.delete(id);
  bufferBytes.delete(id);
  config.sessions = (config.sessions || []).filter(c => c.id !== id);
  saveConfig();
  broadcast({ type: 'session-removed', sessionId: id });
}

function scanProjects() {
  const root = config.projectsRoot;
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => {
      const techPath = path.join(root, d.name);
      const projects = fs.readdirSync(techPath, { withFileTypes: true })
        .filter(p => p.isDirectory() && !p.name.startsWith('.'))
        .map(p => ({ name: p.name, path: path.join(techPath, p.name) }));
      return { tech: d.name, projects };
    });
  // Note: empty tech folders are kept on purpose — a freshly created folder
  // at root level must show up so projects can be created inside it.
}

// ── Token / session usage (pluggable per tool) ────────────────
// Each provider reads a tool's own on-disk records. Claude Code persists every
// session as JSONL under ~/.claude/projects/<cwd-with-slashes-as-dashes>/.
const CONTEXT_WINDOW = 200000;            // approx window for the % fill bar
const usageCache = new Map();             // filePath -> incremental parse state

function claudeProjectDir(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

// Newest .jsonl in the project dir = the most recent session for that cwd
function latestTranscript(cwd) {
  const dir = claudeProjectDir(cwd);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  let best = null, bestM = -1;
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(dir, f);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = fp; }
  }
  return best;
}

// Read usage incrementally: only parse bytes appended since last poll.
function readClaudeUsage(session) {
  const file = latestTranscript(session.cwd);
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  let c = usageCache.get(file);
  if (!c || c.ino !== st.ino || st.size < c.size) {
    c = { ino: st.ino, size: 0, leftover: '',
          totals: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, turns: 0 },
          latest: { context: 0, model: '' } };
    usageCache.set(file, c);
  }
  if (st.size > c.size) {
    const len = st.size - c.size;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, c.size); } finally { fs.closeSync(fd); }
    c.size = st.size;
    const lines = (c.leftover + buf.toString('utf8')).split('\n');
    c.leftover = lines.pop(); // trailing partial line, completed on next read
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      const u = obj.message && obj.message.usage;
      if (!u) continue;
      c.totals.input       += u.input_tokens || 0;
      c.totals.output      += u.output_tokens || 0;
      c.totals.cacheRead   += u.cache_read_input_tokens || 0;
      c.totals.cacheCreate += u.cache_creation_input_tokens || 0;
      c.totals.turns       += 1;
      c.latest.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (obj.message.model) c.latest.model = obj.message.model;
    }
  }
  return {
    input: c.totals.input, output: c.totals.output,
    cacheRead: c.totals.cacheRead, cacheCreate: c.totals.cacheCreate,
    turns: c.totals.turns, context: c.latest.context,
    contextWindow: CONTEXT_WINDOW, model: c.latest.model,
  };
}

// ── Codex: consumo desde sus rollouts (~/.codex/sessions) ─────
// Cada sesión de Codex escribe un JSONL con eventos token_count que traen
// totales, ventana de contexto Y los límites del plan reportados por el
// servidor de OpenAI (5h + semanal, con used_percent exacto). Se aparea
// panel↔rollout por cwd (la primera línea del archivo es session_meta).
const CODEX_SESSIONS = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'sessions');
const codexFileCwd = new Map(); // file -> cwd (cache de la primera línea)
const codexCache = new Map();   // file -> estado de parseo incremental
let codexListCache = { at: 0, list: [] };

function codexRollouts() {
  if (Date.now() - codexListCache.at < 10000) return codexListCache.list;
  const out = [];
  const cutoff = Date.now() - 3 * 86400e3; // solo rollouts de los últimos 3 días
  const walk = (dir, depth) => {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) out.push({ p, m: st.mtimeMs }); } catch {}
      }
    }
  };
  walk(CODEX_SESSIONS, 0);
  out.sort((a, b) => b.m - a.m);
  codexListCache = { at: Date.now(), list: out };
  return out;
}

function codexCwdOf(file) {
  if (codexFileCwd.has(file)) return codexFileCwd.get(file);
  let cwd = null;
  try {
    // La línea session_meta puede ser ENORME (20KB+ con instrucciones
    // embebidas) — buffer amplio y, si aun así quedó cortada, regex.
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(262144);
    let n;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const chunk = buf.toString('utf8', 0, n);
    const nl = chunk.indexOf('\n');
    try {
      const obj = JSON.parse(nl >= 0 ? chunk.slice(0, nl) : chunk);
      cwd = (obj.payload && obj.payload.cwd) || null;
    } catch {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(chunk);
      if (m) { try { cwd = JSON.parse('"' + m[1] + '"'); } catch {} }
    }
  } catch {}
  codexFileCwd.set(file, cwd);
  return cwd;
}

// Parseo incremental de un rollout (misma mecánica que el lector de Claude)
function parseCodexFile(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  let c = codexCache.get(file);
  if (!c || c.ino !== st.ino || st.size < c.size) {
    c = { ino: st.ino, size: 0, leftover: '', model: '', turns: 0, info: null, limits: null, limitsAt: 0 };
    codexCache.set(file, c);
  }
  if (st.size > c.size) {
    const len = st.size - c.size;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, c.size); } finally { fs.closeSync(fd); }
    c.size = st.size;
    const lines = (c.leftover + buf.toString('utf8')).split('\n');
    c.leftover = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      const pl = obj.payload || {};
      if (pl.model) c.model = pl.model;
      if (pl.type === 'token_count' && pl.info) {
        c.info = pl.info;
        c.turns++;
        if (pl.rate_limits) {
          c.limits = pl.rate_limits;
          c.limitsAt = Date.parse(obj.timestamp) || Date.now();
        }
      }
    }
    // Los límites del plan son DE LA CUENTA, no de la sesión: cada snapshot
    // más nuevo que veamos (venga del rollout que venga) actualiza el global.
    if (c.limits && c.limitsAt > codexGlobal.at) codexGlobal = { at: c.limitsAt, limits: c.limits };
  }
  return c;
}

// Snapshot global de límites: el más reciente entre todos los rollouts. Se
// asegura de parsear también el rollout más nuevo del disco aunque no esté
// apareado a ningún panel (p. ej. una sesión de codex fuera del dashboard).
let codexGlobal = { at: 0, limits: null };
function codexGlobalLimits() {
  const newest = codexRollouts()[0];
  if (newest) parseCodexFile(newest.p);
  return codexGlobal.limits;
}

function readCodexUsage(session) {
  const target = path.resolve(session.cwd);
  const hit = codexRollouts().find(f => codexCwdOf(f.p) === target);
  if (!hit) return null;
  const c = parseCodexFile(hit.p);
  if (!c || !c.info) return null;
  const t = c.info.total_token_usage || {};
  const last = c.info.last_token_usage || {};
  // Un snapshot cuya ventana ya venció NO es consumo actual: la ventana se
  // reinició sola y el % real es 0 hasta que Codex escriba uno fresco.
  const pick = w => {
    if (!w) return null;
    const resetAt = (w.resets_at || 0) * 1000;
    if (resetAt && resetAt <= Date.now()) return { percent: 0, resetAt: 0 };
    return { percent: w.used_percent, resetAt };
  };
  const gl = codexGlobalLimits(); // límites de CUENTA — iguales en todos los paneles
  return {
    input: Math.max(0, (t.input_tokens || 0) - (t.cached_input_tokens || 0)),
    output: t.output_tokens || 0,
    cacheRead: t.cached_input_tokens || 0,
    cacheCreate: t.cache_write_input_tokens || 0,
    turns: c.turns,
    context: last.input_tokens || 0,
    contextWindow: c.info.model_context_window || 0,
    model: c.model,
    limits: gl ? {
      session: pick(gl.primary),
      weekly: pick(gl.secondary),
      plan: gl.plan_type || '',
    } : null,
  };
}

const usageProviders = { 'claude-code': readClaudeUsage, codex: readCodexUsage };

// ── TTS neuronal local (Kokoro + Piper) ───────────────────────
// Un worker Python persistente (scripts/tts-worker.py, venv aislado en
// ~/.claudemanager/tts/venv) sintetiza WAVs que el navegador reproduce.
// Catálogo curado: TODO el español + TODO el inglés de ambos motores; las
// voces Piper en inglés se descargan bajo demanda la primera vez.
const TTS_DIR = path.join(DATA_DIR, 'tts');
const TTS_VENV_PY = path.join(TTS_DIR, 'venv', 'bin', IS_WIN ? 'python.exe' : 'python');
const TTS_WORKER = path.join(__dirname, 'scripts', 'tts-worker.py');
const PIPER_DIR = path.join(DATA_DIR, 'voices', 'piper');
const PIPER_INDEX = path.join(DATA_DIR, 'voices', 'piper-index.json');

function ttsAvailable() {
  return fs.existsSync(TTS_VENV_PY) && fs.existsSync(TTS_WORKER);
}
function kokoroAvailable() {
  return ttsAvailable() &&
    fs.existsSync(path.join(TTS_DIR, 'kokoro-v1.0.onnx')) &&
    fs.existsSync(path.join(TTS_DIR, 'voices-v1.0.bin'));
}

// Un worker persistente POR MOTOR (JSON por línea, respuestas en orden).
// Separados a propósito: Kokoro y Piper empaquetan cada uno su propio espeak
// nativo y compartir proceso los hace chocar (abort al inicializar el 2º).
const ttsWorkers = {}; // engine -> { proc, buf, pending: Map }
let ttsReqId = 0;

function ttsWorker(engine) {
  let w = ttsWorkers[engine];
  if (w && w.proc) return w;
  const { spawn } = require('child_process');
  w = ttsWorkers[engine] = { proc: null, buf: '', pending: new Map(), ...(w || {}) };
  w.proc = spawn(TTS_VENV_PY, [TTS_WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  w.buf = '';
  w.proc.stdout.on('data', d => {
    w.buf += d.toString('utf8');
    let nl;
    while ((nl = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, nl); w.buf = w.buf.slice(nl + 1);
      let r; try { r = JSON.parse(line); } catch { continue; }
      const cb = w.pending.get(r.id);
      if (cb) { w.pending.delete(r.id); cb(r); }
    }
  });
  w.proc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) console.error(`[tts-${engine}]`, s.slice(0, 300));
  });
  w.proc.on('exit', code => {
    console.error(`[tts-${engine}] terminó (código ${code})`);
    for (const cb of w.pending.values()) cb({ ok: false, error: 'el worker de voz se cayó' });
    w.pending.clear(); w.proc = null; w.buf = '';
  });
  return w;
}

function ttsSynth(engine, voice, speaker, text, cb) {
  if (!ttsAvailable()) return cb({ ok: false, error: 'motores de voz no instalados' });
  const w = ttsWorker(engine);
  const id = ++ttsReqId;
  const timer = setTimeout(() => {
    if (w.pending.has(id)) { w.pending.delete(id); cb({ ok: false, error: 'timeout de síntesis' }); }
  }, 120000);
  w.pending.set(id, r => { clearTimeout(timer); cb(r); });
  try {
    w.proc.stdin.write(JSON.stringify({ id, engine, voice, speaker, text }) + '\n');
  } catch (e) {
    w.pending.delete(id); clearTimeout(timer);
    cb({ ok: false, error: 'worker no disponible: ' + e.message });
  }
}

// Descarga bajo demanda de una voz Piper (curl sigue las redirecciones de HF)
const piperDownloads = new Map(); // key -> Promise
function downloadPiperVoice(entry) {
  if (piperDownloads.has(entry.key)) return piperDownloads.get(entry.key);
  const p = new Promise((resolve, reject) => {
    fs.mkdirSync(PIPER_DIR, { recursive: true });
    const base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
    const dl = (url, dest, done) =>
      execFile('curl', ['-sL', '-o', dest, url], { timeout: 300000 }, err => done(err));
    dl(base + entry.path + '.onnx', path.join(PIPER_DIR, entry.key + '.onnx'), e1 => {
      if (e1) return reject(new Error('descarga falló: ' + e1.message));
      dl(base + entry.path + '.onnx.json', path.join(PIPER_DIR, entry.key + '.onnx.json'), e2 => {
        if (e2) return reject(new Error('descarga falló: ' + e2.message));
        resolve();
      });
    });
  }).finally(() => piperDownloads.delete(entry.key));
  piperDownloads.set(entry.key, p);
  return p;
}

// Índice oficial de Piper (nombres, idiomas, hablantes) — cacheado en disco
let piperIndexCache = null;
function piperIndex() {
  if (piperIndexCache) return piperIndexCache;
  try { piperIndexCache = JSON.parse(fs.readFileSync(PIPER_INDEX, 'utf8')); } catch { piperIndexCache = {}; }
  return piperIndexCache;
}

const KOKORO_VOICES = (() => {
  const es = { ef_dora: 'Dora', em_alex: 'Alex', em_santa: 'Santa' };
  const enUS = ['af_heart','af_alloy','af_aoede','af_bella','af_jessica','af_kore','af_nicole',
    'af_nova','af_river','af_sarah','af_sky','am_adam','am_echo','am_eric','am_fenrir',
    'am_liam','am_michael','am_onyx','am_puck','am_santa'];
  const enGB = ['bf_alice','bf_emma','bf_isabella','bf_lily','bm_daniel','bm_fable','bm_george','bm_lewis'];
  const cap = v => v.split('_')[1][0].toUpperCase() + v.split('_')[1].slice(1);
  const out = [];
  for (const [v, name] of Object.entries(es))
    out.push({ id: 'kokoro:' + v, name, lang: 'es', source: 'Kokoro' });
  for (const v of enUS) out.push({ id: 'kokoro:' + v, name: cap(v), lang: 'en-US', source: 'Kokoro' });
  for (const v of enGB) out.push({ id: 'kokoro:' + v, name: cap(v), lang: 'en-GB', source: 'Kokoro' });
  return out;
})();

const QUALITY_ES = { x_low: 'mínima', low: 'baja', medium: 'media', high: 'alta' };
function ttsCatalog() {
  const out = [];
  if (kokoroAvailable()) out.push(...KOKORO_VOICES);
  if (ttsAvailable()) {
    for (const v of Object.values(piperIndex())) {
      const code = v.language && v.language.code; // es_MX, en_US…
      if (!code || !/^(es|en)_/.test(code)) continue;
      const onnx = Object.keys(v.files).find(f => f.endsWith('.onnx'));
      if (!onnx) continue;
      const pathNoExt = onnx.slice(0, -5);
      const downloaded = fs.existsSync(path.join(PIPER_DIR, v.key + '.onnx'));
      const sizeMb = Math.round(((v.files[onnx] || {}).size_bytes || 0) / 1e6);
      const quality = QUALITY_ES[v.quality] || v.quality;
      // Multi-hablante: se expanden solo los modelos chicos (sharvard = 2);
      // los corpus gigantes (libritts: 900+ hablantes) irían a una sola
      // entrada — expandirlos inundaría el catálogo con miles de voces.
      const speakers = v.num_speakers > 1 && v.num_speakers <= 4
        ? Object.entries(v.speaker_id_map || {})
        : [[null, null]];
      for (const [spName, spId] of speakers) {
        out.push({
          id: 'piper:' + v.key + (spId !== null && spId !== undefined ? '#' + spId : ''),
          name: v.name + (spName ? ' ' + spName : '') + ' (' + quality + ')',
          lang: code.replace('_', '-'),
          source: 'Piper', key: v.key, path: pathNoExt, downloaded, sizeMb,
        });
      }
    }
  }
  return out;
}

// Cola secuencial de peticiones tts por servidor: preserva el orden de los
// bloques aunque una voz requiera descargarse primero.
let ttsChain = Promise.resolve();
function handleTts(ws, msg) {
  ttsChain = ttsChain.then(() => new Promise(res => {
    const m = /^(kokoro|piper):([^#]+)(?:#(\d+))?$/.exec(msg.voice || '');
    const fail = error => {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'tts-audio', reqId: msg.reqId, sessionId: msg.sessionId, error }));
      res();
    };
    if (!m) return fail('voz desconocida');
    const [, engine, voice, speaker] = m;
    const ready = () => ttsSynth(engine, voice, speaker !== undefined ? +speaker : null, msg.text, r => {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'tts-audio', reqId: msg.reqId, sessionId: msg.sessionId,
          wav: r.ok ? r.wav : undefined, error: r.ok ? undefined : r.error }));
      res();
    });
    if (engine === 'piper' && !fs.existsSync(path.join(PIPER_DIR, voice + '.onnx'))) {
      const entry = ttsCatalog().find(c => c.key === voice);
      if (!entry) return fail('voz no encontrada en el catálogo');
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'tts-status', msg: `descargando la voz ${entry.name} (~${entry.sizeMb}MB)…` }));
      downloadPiperVoice(entry).then(ready).catch(e => fail(e.message));
    } else ready();
  }));
}

// ── Lectura incremental de respuestas (voz) ───────────────────
// Tras dictarle a una sesión, el cliente pide vigilar su transcript: cada
// 500ms se leen SOLO los bytes nuevos del JSONL y cada bloque de texto del
// asistente se envía apenas queda escrito — la voz lo lee mientras Claude
// sigue generando los siguientes. Un vigilante por cliente WS.
const respWatchers = new Map(); // ws -> watcher

function stopResponseWatch(ws, notify) {
  const w = respWatchers.get(ws);
  if (!w) return;
  clearInterval(w.timer);
  respWatchers.delete(ws);
  if (notify && ws.readyState === 1)
    ws.send(JSON.stringify({ type: 'response-end', sessionId: w.sessionId, blocks: w.blocks }));
}

function startResponseWatch(ws, sessionId) {
  stopResponseWatch(ws, false);
  const s = sessions.get(sessionId);
  if (!s) return;
  const w = { sessionId, cwd: s.cwd, file: null, pos: 0, leftover: '',
              since: Date.now(), started: Date.now(), lastBytes: Date.now(),
              blocks: 0, promptSeen: false, timer: null };
  // Arranca al FINAL del archivo actual: solo verá lo que se escriba después
  // del dictado — imposible releer una respuesta vieja.
  const initFile = latestTranscript(s.cwd);
  if (initFile) { try { w.file = initFile; w.pos = fs.statSync(initFile).size; } catch {} }
  w.timer = setInterval(() => {
    try {
      const now = Date.now();
      // Fin de turno por SEÑALES, no por silencio del archivo (el transcript
      // no crece mientras Claude piensa o corre herramientas lentas):
      //  - promptSeen: el mensaje del usuario quedó escrito → el prompt SÍ entró
      //  - pty quieto: la TUI repinta el spinner todo el tiempo que trabaja;
      //    4s sin output = terminó de verdad (o nunca empezó)
      const sess = sessions.get(w.sessionId);
      const outIdle = sess && sess.lastOutAt ? now - sess.lastOutAt : Infinity;
      if (now - w.started > 10 * 60 * 1000) return stopResponseWatch(ws, true);          // tope duro
      if (!w.promptSeen && now - w.started > 15000 && outIdle > 4000)
        return stopResponseWatch(ws, true);                                              // el prompt nunca entró
      if (w.promptSeen && now - w.started > 5000 && outIdle > 4000 && now - w.lastBytes > 1500)
        return stopResponseWatch(ws, true);                                              // turno terminado
      const file = latestTranscript(w.cwd);
      if (!file) return;
      if (file !== w.file) { w.file = file; w.pos = 0; w.leftover = ''; } // rotó el transcript
      let st; try { st = fs.statSync(file); } catch { return; }
      if (st.size < w.pos) { w.pos = 0; w.leftover = ''; }
      if (st.size === w.pos) return;
      const len = st.size - w.pos;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, w.pos); } finally { fs.closeSync(fd); }
      w.pos = st.size;
      w.lastBytes = now;
      const lines = (w.leftover + buf.toString('utf8')).split('\n');
      w.leftover = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'user') w.promptSeen = true; // el prompt (o un tool-result) ya está en el transcript
        // Solo texto del asistente principal — fuera herramientas, pensamiento
        // interno y subagentes (isSidechain).
        if (obj.type !== 'assistant' || obj.isSidechain || !obj.message || !Array.isArray(obj.message.content)) continue;
        const ts = Date.parse(obj.timestamp) || 0;
        if (ts && ts < w.since - 2000) continue;
        const text = obj.message.content
          .filter(c => c.type === 'text' && c.text && c.text.trim())
          .map(c => c.text).join('\n');
        if (!text) continue;
        w.blocks++;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'response-block', sessionId: w.sessionId, text }));
      }
    } catch (err) { console.error('[watch-response]', err.message); }
  }, 500);
  respWatchers.set(ws, w);
}

// ── Resolución de rutas de archivos arrastrados ───────────────
// El navegador nunca revela la ruta original de lo que arrastras (seguridad
// web), pero sí el nombre, tamaño y contenido. Como el servidor corre en la
// misma máquina, busca el original con Spotlight (mdfind, indexado) y solo
// acepta una coincidencia ÚNICA verificada (tamaño exacto en archivos, hijos
// presentes en carpetas). Si es ambigua o no aparece → null y el cliente cae
// a la copia temporal de siempre.
function resolveDropItem(item, cb) {
  const name = String(item.name || '');
  if (!name || /[\/\\]/.test(name)) return cb(null);
  const finish = candidates => {
    const matches = [];
    for (const p of candidates) {
      try {
        if (path.basename(p) !== name) continue;
        const st = fs.statSync(p);
        if (item.isDir) {
          if (!st.isDirectory()) continue;
          const need = (item.childNames || []).slice(0, 6);
          if (need.length) {
            const have = new Set(fs.readdirSync(p));
            if (!need.every(k => have.has(k))) continue;
          }
        } else {
          if (!st.isFile()) continue;
          if (typeof item.size === 'number' && st.size !== item.size) continue;
        }
        matches.push(p);
        if (matches.length > 1) break; // ambigua — mejor no adivinar
      } catch {}
    }
    cb(matches.length === 1 ? matches[0] : null);
  };
  if (process.platform === 'darwin') {
    execFile('mdfind', ['-name', name], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => finish(err || !out ? [] : out.split('\n').filter(Boolean)));
  } else if (!IS_WIN) {
    const home = process.env.HOME || '';
    const roots = [config.projectsRoot, path.join(home, 'Desktop'), path.join(home, 'Downloads'),
      path.join(home, 'Documents')].filter(r => r && fs.existsSync(r));
    if (!roots.length) return cb(null);
    execFile('find', [...roots, '-maxdepth', '6', '-name', name],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => finish(out ? out.split('\n').filter(Boolean) : []));
  } else cb(null); // Windows: sin búsqueda — sigue el flujo de copia temporal
}

// ── Git status per session (branch + pending changes, Warp-style) ─
function gitInfoFor(cwd, cb) {
  execFile('git', ['status', '--porcelain=v1', '--branch'], { cwd, timeout: 4000 }, (err, out) => {
    if (err) return cb(null); // not a repo (or git missing) — hide the badge
    let branch = '', ahead = 0, behind = 0;
    const files = [];
    for (const l of out.split('\n')) {
      if (!l) continue;
      if (l.startsWith('## ')) {
        branch = l.slice(3).split('...')[0].trim();
        const a = l.match(/ahead (\d+)/); if (a) ahead = +a[1];
        const b = l.match(/behind (\d+)/); if (b) behind = +b[1];
      } else {
        files.push({ s: l.slice(0, 2).trim(), f: l.slice(3) });
      }
    }
    cb({ branch, ahead, behind, files });
  });
}

// Resolve which provider a session uses: explicit tool.usageProvider wins,
// else infer from the command (anything running `claude` → claude-code).
function providerFor(session) {
  const tool = (config.tools || []).find(t => t.id === session.toolId);
  if (tool && tool.usageProvider) return tool.usageProvider;
  const cmd = (session.command || '').toLowerCase();
  if (cmd.includes('codex')) return 'codex';
  if (cmd.includes('claude')) return 'claude-code';
  return null;
}

function collectUsage() {
  const out = [];
  for (const [id, s] of sessions) {
    const name = providerFor(s);
    const prov = name && usageProviders[name];
    let usage = null;
    if (prov) { try { usage = prov(s); } catch {} }
    out.push({ id, provider: name, usage });
  }
  return out;
}

// ── Rolling 5h usage window (local approximation, like ccusage) ─
// Anthropic's plan limit (% used / reset time) is server-side and not on disk,
// so we approximate the 5h session window from transcript timestamps: the block
// starts at the earliest activity still inside the window and resets 5h later.
const WINDOW_MS = 5 * 60 * 60 * 1000;
const RETENTION_MS = 18 * 60 * 60 * 1000; // keep enough history to anchor blocks across idle gaps
const windowCache = new Map();  // file -> { ino, size, leftover } (incremental read state)
let windowEvents = [];          // { ts, tokens } for events kept within RETENTION_MS

function ingestTranscript(file) {
  let st; try { st = fs.statSync(file); } catch { return; }
  let c = windowCache.get(file);
  if (!c || c.ino !== st.ino || st.size < c.size) {
    c = { ino: st.ino, size: 0, leftover: '' };
    windowCache.set(file, c);
  }
  if (st.size <= c.size) return;
  const len = st.size - c.size;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, c.size); } finally { fs.closeSync(fd); }
  c.size = st.size;
  const lines = (c.leftover + buf.toString('utf8')).split('\n');
  c.leftover = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const u = obj.message && obj.message.usage;
    if (!u || !obj.timestamp) continue;
    const ts = Date.parse(obj.timestamp);
    if (!ts) continue;
    // Cost-weighted token sum — the best local proxy for how the plan meters
    // usage. Cache reads dominate volume in long sessions, so omitting them made
    // the % track far below the real one; here they count at their ~0.1x weight.
    const tokens = (u.input_tokens || 0) * 1
                 + (u.output_tokens || 0) * 5
                 + (u.cache_creation_input_tokens || 0) * 1.25
                 + (u.cache_read_input_tokens || 0) * 0.1;
    windowEvents.push({ ts, tokens });
  }
}

function computeWindow() {
  const root = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
  const cutoff = Date.now() - RETENTION_MS;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return { active: false }; }
  const seen = new Set();
  for (const d of dirs) {
    const dir = path.join(root, d);
    let files; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs >= cutoff) { seen.add(fp); ingestTranscript(fp); } // files touched within retention
    }
  }
  // Drop cache state for transcripts that fell out of the retention window so
  // the map doesn't grow forever across days of sessions.
  for (const key of windowCache.keys()) if (!seen.has(key)) windowCache.delete(key);
  windowEvents = windowEvents.filter(e => e.ts >= cutoff);
  if (!windowEvents.length) return { active: false };

  // Reconstruct fixed 5h session blocks (like ccusage): a block is anchored to its
  // first event and lasts exactly 5h; the meter resets to 0 at start+5h. A new block
  // starts on the first event past that cap, or after an idle gap longer than 5h.
  const ev = windowEvents.slice().sort((a, b) => a.ts - b.ts);
  let blockStart = ev[0].ts, blockTokens = 0, lastTs = ev[0].ts;
  for (const e of ev) {
    if (e.ts - blockStart >= WINDOW_MS || e.ts - lastTs >= WINDOW_MS) {
      blockStart = e.ts; blockTokens = 0; // start a fresh block
    }
    blockTokens += e.tokens;
    lastTs = e.ts;
  }
  const resetAt = blockStart + WINDOW_MS;
  if (Date.now() >= resetAt) return { active: false }; // current block already expired
  return { active: true, resetAt, used: blockTokens, windowMs: WINDOW_MS };
}

// Cache the window so the per-poll dir scan only runs every ~12s
let windowResult = { active: false }, windowComputedAt = 0;
function getWindow(force) {
  if (force || Date.now() - windowComputedAt > 12000) {
    try { windowResult = computeWindow(); } catch { windowResult = { active: false }; }
    windowComputedAt = Date.now();
  }
  return windowResult;
}

// ── Official account usage (exact, server-side via OAuth) ──────
// Calls Anthropic's /api/oauth/usage with the token Claude Code keeps in the
// Keychain. We re-read the token each call so Claude Code owns the refresh; we
// never log it. This returns the real global 5h-session and weekly % shown in
// the official app, aggregated across every Claude Code session and model.
let oauthTokenCache = null, oauthTokenAt = 0;
function readOAuthToken() {
  // The Keychain call is a blocking execSync (~tens of ms); cache the token
  // briefly so the periodic usage poll doesn't stall the event loop each time.
  // Claude Code still owns the refresh — we just re-read every few minutes.
  if (oauthTokenCache && Date.now() - oauthTokenAt < 5 * 60 * 1000) return oauthTokenCache;
  let raw = null;
  if (process.platform === 'darwin') {
    try {
      raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8' });
    } catch {}
  }
  if (!raw) {
    // Windows/Linux (no Keychain): Claude Code stores the credential on disk.
    // Also acts as a fallback on macOS if the Keychain read fails.
    try {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      raw = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8');
    } catch {}
  }
  if (raw) {
    try {
      const j = JSON.parse(raw);
      const tok = (j.claudeAiOauth || j).accessToken || null;
      if (tok) { oauthTokenCache = tok; oauthTokenAt = Date.now(); }
    } catch {}
  }
  return oauthTokenCache;
}

function fetchOfficialUsage(cb) {
  const tok = readOAuthToken();
  if (!tok) {
    console.log('[usage] OAuth token not found (Keychain / ~/.claude/.credentials.json) — using local estimate');
    officialLastError = 'no-token';
    cb(null); return;
  }
  const req = https.request({
    hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET', timeout: 8000,
    headers: {
      'Authorization': 'Bearer ' + tok,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'claude-cli/2.1.181',
    },
  }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => {
      if (res.statusCode !== 200) {
        console.log(`[usage] /oauth/usage HTTP ${res.statusCode} — keeping last known value`);
        if (res.statusCode === 429) officialBackoffUntil = Date.now() + 5 * 60 * 1000;
        officialLastError = 'http-' + res.statusCode;
        cb(null); return;
      }
      try {
        const j = JSON.parse(b);
        const pick = w => w ? { percent: w.utilization, resetAt: Date.parse(w.resets_at) } : null;
        officialLastError = null;
        cb({ session: pick(j.five_hour), weekly: pick(j.seven_day), at: Date.now() });
      } catch { officialLastError = 'parse'; cb(null); }
    });
  });
  req.on('error', () => { officialLastError = 'network'; cb(null); });
  req.on('timeout', () => { req.destroy(); officialLastError = 'timeout'; cb(null); });
  req.end();
}

let officialUsage = null, officialFetchedAt = 0, officialInFlight = false, officialBackoffUntil = 0;
let officialLastError = null; // why the last fetch failed — surfaced in the UI

// Persist the last good value so a server restart doesn't drop the bar back
// to the local estimate while the endpoint is rate-limiting us.
const USAGE_CACHE_FILE = path.join(DATA_DIR, 'usage-cache.json');
try {
  const j = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
  if (j && j.session && j.session.resetAt > Date.now()) {
    officialUsage = j; officialFetchedAt = j.at || 0;
  }
} catch {}

function getOfficialUsage(force, cb) {
  if (!force && officialUsage && Date.now() - officialFetchedAt < 30000) return cb(officialUsage);
  if (officialInFlight) return cb(officialUsage); // serve stale while a fetch runs
  if (Date.now() < officialBackoffUntil) return cb(officialUsage); // 429 backoff — don't hammer
  officialInFlight = true;
  fetchOfficialUsage(u => {
    officialInFlight = false;
    if (u) {
      officialUsage = u; officialFetchedAt = Date.now();
      try { fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true }); } catch {}
      fs.writeFile(USAGE_CACHE_FILE, JSON.stringify(u), () => {});
    }
    cb(officialUsage);
  });
}

// Boot pre-configured sessions (only if configured)
if (isConfigured()) {
  for (const cfg of (config.sessions || [])) {
    buffers.set(cfg.id, []);
    spawnSession(cfg);
  }
}

// Precalentar motores TTS: si algún panel tiene asignada una voz de Kokoro o
// Piper, se lanza su worker y se fuerza la carga del modelo desde ya — la
// primera lectura sale sin el arranque en frío (~2-5s). Quien no use voces de
// motor no paga nada (no se precalienta).
function prewarmTts() {
  if (!ttsAvailable()) return;
  const warmed = new Set();
  for (const s of (config.sessions || [])) {
    const m = /^(kokoro|piper):([^#]+)(?:#(\d+))?$/.exec(s.voice || '');
    if (!m || warmed.has(m[1] + ':' + m[2])) continue;
    warmed.add(m[1] + ':' + m[2]);
    // Las Piper aún no descargadas no se bajan en el boot — solo al elegirlas
    if (m[1] === 'piper' && !fs.existsSync(path.join(PIPER_DIR, m[2] + '.onnx'))) continue;
    ttsSynth(m[1], m[2], m[3] !== undefined ? +m[3] : null, 'ok', r => {
      console.log(`[tts] precalentado ${m[1]}:${m[2]}${r.ok ? '' : ' — falló: ' + r.error}`);
    });
  }
}
setTimeout(prewarmTts, 1500); // tras el arranque, sin estorbarlo

// ── Actualización al arrancar ─────────────────────────────────
// Si hay un comando configurado (brew upgrade…, npm update -g…, cada quien
// el suyo según su SO e instalación), corre en CADA arranque/reinicio del
// servicio, en segundo plano y sin bloquear nada. El resultado se guarda y
// se avisa en el dashboard al conectar.
let updateResult = null; // { ok, msg, at }
if ((config.updateCommand || '').trim()) {
  const cmd = config.updateCommand.trim();
  console.log('[update] ejecutando:', cmd);
  require('child_process').exec(cmd, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
    const tail = s => String(s || '').trim().split('\n').slice(-3).join(' · ').slice(0, 300);
    updateResult = err
      ? { ok: false, msg: tail(errOut) || err.message.slice(0, 200), at: Date.now() }
      : { ok: true, msg: tail(out) || 'sin novedades', at: Date.now() };
    console.log(`[update] ${err ? 'FALLÓ' : 'ok'} — ${updateResult.msg}`);
    broadcast({ type: 'update-result', ...updateResult });
  });
}

// HTTP server
let indexCache = null; // in-memory copy of index.html, invalidated by fs.watch below
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    // no-cache: sin esto el navegador puede recargar con un index.html viejo
    // de su caché heurística y "no enterarse" de los cambios del cliente.
    const HDRS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
    if (indexCache) {
      res.writeHead(200, HDRS);
      return res.end(indexCache);
    }
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('Error'); }
      indexCache = data;
      res.writeHead(200, HDRS);
      res.end(data);
    });
  } else if (/^\/(js|css)\//.test(req.url)) {
    // Módulos del cliente (public/js, public/css) — no-cache igual que el
    // index para que las recargas siempre traigan la versión del disco.
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const full = path.join(__dirname, 'public', rel);
    const pubDir = path.join(__dirname, 'public');
    const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    const mime = MIME[path.extname(full).toLowerCase()];
    if (!full.startsWith(pubDir + path.sep) || !mime) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } else if (req.url.startsWith('/ptt/')) {
    // Disparador global de dictado: un atajo del SO (Shortcuts/AutoHotkey/
    // atajos de GNOME…) hace curl aquí y el dashboard —tenga o no el foco—
    // arranca o detiene la grabación. Se avisa solo a la pestaña más
    // reciente para no grabar por duplicado si hay varias abiertas.
    const action = req.url.slice(5).split('?')[0];
    if (!['start', 'stop', 'toggle'].includes(action)) { res.writeHead(404); return res.end('Not found'); }
    let target = null;
    for (const c of clients) if (c.readyState === 1) target = c;
    if (target) target.send(JSON.stringify({ type: 'ptt', action }));
    console.log(`[ptt] ${action} → ${target ? 'entregado al navegador' : 'SIN navegador conectado'}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !!target, browsers: target ? 1 : 0 }));
  } else if (req.url.startsWith('/fondos/')) {
    const file = decodeURIComponent(req.url.slice('/fondos/'.length).split('?')[0]);
    const ext = path.extname(file).toLowerCase();
    const full = path.join(BACKGROUNDS_DIR, file);
    // Block path traversal and non-image requests
    if (!full.startsWith(BACKGROUNDS_DIR + path.sep) || !IMG_TYPES[ext]) {
      res.writeHead(404); return res.end('Not found');
    }
    // Stream the image and honor conditional requests: with an ETag the
    // browser revalidates and gets a 304 instead of re-downloading the file.
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
      const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
      res.writeHead(200, {
        'Content-Type': IMG_TYPES[ext], 'Content-Length': st.size,
        'ETag': etag, 'Cache-Control': 'no-cache',
      });
      fs.createReadStream(full).pipe(res);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);

  // Send config state on connect so client knows if setup is needed
  ws.send(JSON.stringify({
    type: 'config-state',
    configured: isConfigured(),
    projectsRoot: config.projectsRoot || '',
    claudePath: config.claudePath || '',
    detectedClaude: detectClaude(),
    updateCommand: config.updateCommand || '',
    tools: config.tools || [],
    defaultTool: config.defaultTool || 'claude',
    backgrounds: listBackgrounds(),
  }));

  if (commands.length) ws.send(JSON.stringify({ type: 'cmd-log', commands }));
  ws.send(JSON.stringify({ type: 'tts-catalog', voices: ttsCatalog() }));
  if (updateResult) ws.send(JSON.stringify({ type: 'update-result', ...updateResult }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, sessionId } = msg;

    if (type === 'list') {
      const list = [];
      for (const [id, s] of sessions)
        list.push({ id, name: s.name, cwd: s.cwd, status: s.status, cols: s.cols || 80, rows: s.rows || 24, subtitle: s.subtitle || '', voice: s.voice || '' });
      ws.send(JSON.stringify({ type: 'sessions', sessions: list }));
      for (const [id, buf] of buffers)
        if (buf.length) ws.send(JSON.stringify({ type: 'output', sessionId: id, data: buf.join('') }));

    } else if (type === 'save-config') {
      config.projectsRoot = msg.projectsRoot.trim();
      config.claudePath = msg.claudePath.trim();
      if (typeof msg.updateCommand === 'string') config.updateCommand = msg.updateCommand.trim();
      saveConfig();
      broadcast({ type: 'reload' });

    } else if (type === 'input') {
      const s = sessions.get(sessionId);
      if (s && s.proc && s.status === 'running') {
        s.proc.write(msg.data);
        try { trackInput(s, sessionId, msg.data); } catch {}
      }

    } else if (type === 'resize') {
      const s = sessions.get(sessionId);
      if (s && s.proc && s.status === 'running') {
        try { s.proc.resize(msg.cols, msg.rows); } catch {}
        const saved = (config.sessions || []).find(c => c.id === sessionId);
        if (saved) { saved.cols = msg.cols; saved.rows = msg.rows; scheduleSave(); }
      }
    } else if (type === 'detect-claude') {
      ws.send(JSON.stringify({ type: 'detected-claude', path: detectClaude(true) }));

    } else if (type === 'list-backgrounds') {
      ws.send(JSON.stringify({ type: 'backgrounds', files: listBackgrounds() }));

    } else if (type === 'usage') {
      getOfficialUsage(msg.force, official => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({
          type: 'usage', sessions: collectUsage(),
          window: getWindow(msg.force), // local fallback if the token can't be read
          official,                     // exact { session, weekly } or null
          officialStatus: { error: officialLastError, backoffUntil: officialBackoffUntil, at: officialFetchedAt },
        }));
      });

    } else if (type === 'close') {
      closeSession(sessionId);

    } else if (type === 'projects') {
      try { ws.send(JSON.stringify({ type: 'projects', data: scanProjects() })); }
      catch (err) { ws.send(JSON.stringify({ type: 'error', msg: err.message })); }

    } else if (type === 'create-folder') {
      const { tech, name } = msg;
      if (!tech || !name || /[\/\\..]/.test(name)) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Nombre de carpeta inválido' }));
        return;
      }
      const folderPath = path.join(config.projectsRoot, tech, name.trim());
      try {
        fs.mkdirSync(folderPath, { recursive: true });
        ws.send(JSON.stringify({ type: 'projects', data: scanProjects() }));
        ws.send(JSON.stringify({ type: 'folder-created', tech, name: name.trim() }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', msg: err.message }));
      }

    } else if (type === 'save-tool') {
      if (!config.tools) config.tools = [];
      const idx = config.tools.findIndex(t => t.id === msg.tool.id);
      if (idx >= 0) config.tools[idx] = msg.tool;
      else config.tools.push(msg.tool);
      if (!config.defaultTool) config.defaultTool = msg.tool.id;
      saveConfig();
      broadcast({ type: 'tools-updated', tools: config.tools, defaultTool: config.defaultTool });

    } else if (type === 'paste-image') {
      try {
        const m = (msg.data || '').match(/^data:image\/(\w+);base64,(.+)$/s);
        if (!m) return;
        const tmpPath = path.join(require('os').tmpdir(), `cm_paste_${Date.now()}.${m[1]}`);
        fs.writeFileSync(tmpPath, Buffer.from(m[2], 'base64'));
        ws.send(JSON.stringify({ type:'image-pasted', sessionId:msg.sessionId, path:tmpPath }));
      } catch(err) { console.error('[paste-image]', err.message); }

    } else if (type === 'resolve-drop') {
      // ¿Dónde vive de verdad lo que arrastraron? (ver resolveDropItem)
      const items = Array.isArray(msg.items) ? msg.items.slice(0, 25) : [];
      const paths = new Array(items.length).fill(null);
      let left = items.length;
      const reply = () => {
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'drop-resolved', sessionId, reqId: msg.reqId, paths }));
      };
      if (!left) return reply();
      items.forEach((it, i) => resolveDropItem(it || {}, p => {
        paths[i] = p;
        if (--left === 0) reply();
      }));

    } else if (type === 'drop-files') {
      // Files/folders dragged onto a terminal. The browser can't reveal the
      // original path, so we persist a temp copy (files keep their name,
      // folders keep their tree) and the client pastes that path.
      try {
        const paths = [];
        let n = 0;
        const stamp = Date.now();
        const safeSeg = s => String(s || 'archivo').replace(/[^\w.\-]+/g, '_').slice(-80) || '_';
        const writeB64 = (dest, data) => {
          const m = (data || '').match(/^data:([^;,]*);base64,(.*)$/s);
          if (!m) return false;
          fs.writeFileSync(dest, Buffer.from(m[2], 'base64'));
          return true;
        };
        for (const f of (msg.files || []).slice(0, 20)) {
          const tmpPath = path.join(require('os').tmpdir(), `cm_drop_${stamp}_${n++}_${safeSeg(f.name)}`);
          if (writeB64(tmpPath, f.data)) paths.push(tmpPath);
        }
        for (const folder of (msg.folders || []).slice(0, 5)) {
          const base = path.join(require('os').tmpdir(), `cm_drop_${stamp}_${n++}`);
          let wrote = 0;
          for (const f of (folder.files || []).slice(0, 500)) {
            // Sanitize every path segment; anything escaping the base dir is dropped
            const rel = String(f.rel || '').split('/')
              .filter(seg => seg && seg !== '.' && seg !== '..').map(safeSeg).join(path.sep);
            if (!rel) continue;
            const dest = path.join(base, rel);
            if (!dest.startsWith(base + path.sep)) continue;
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            if (writeB64(dest, f.data)) wrote++;
          }
          if (wrote) paths.push(path.join(base, safeSeg(folder.name)));
        }
        if (paths.length) ws.send(JSON.stringify({ type:'files-dropped', sessionId:msg.sessionId, paths }));
      } catch(err) { console.error('[drop-files]', err.message); }

    } else if (type === 'delete-tool') {
      config.tools = (config.tools || []).filter(t => t.id !== msg.toolId);
      if (config.defaultTool === msg.toolId) config.defaultTool = config.tools[0]?.id || '';
      saveConfig();
      broadcast({ type: 'tools-updated', tools: config.tools, defaultTool: config.defaultTool });

    } else if (type === 'open') {
      const { projectPath, projectName, dangerousSkip, resume, contextPaths, toolId } = msg;
      const id = 'dyn_' + Date.now();
      // Resolve tool config
      const tool = (config.tools || []).find(t => t.id === (toolId || config.defaultTool));
      const args = [...(tool?.defaultArgs || [])];
      if (resume && tool?.resumeFlag) args.push(tool.resumeFlag);
      if (dangerousSkip && tool?.skipPermsFlag) args.push(tool.skipPermsFlag);
      if (contextPaths && contextPaths.length > 0 && tool?.addDirFlag) {
        contextPaths.forEach(p => args.push(tool.addDirFlag, p));
      }
      const command = tool?.command || config.claudePath;
      const cfg = { id, name: projectName, toolId: toolId || config.defaultTool, command, args, cwd: projectPath, cols: msg.cols || 80, rows: msg.rows || 24 };
      buffers.set(id, []);
      spawnSession(cfg);
      if (!config.sessions) config.sessions = [];
      config.sessions.push({ id, name: cfg.name, command: cfg.command, args: cfg.args, cwd: cfg.cwd, cols: cfg.cols, rows: cfg.rows, toolId: cfg.toolId });
      saveConfig();
      broadcast({ type: 'session-added', session: { id, name: cfg.name, cwd: cfg.cwd, status: 'running', cols: cfg.cols, rows: cfg.rows } });

      // Fallback for tools without addDirFlag: send context as text
      if (contextPaths && contextPaths.length > 0 && !tool?.addDirFlag) {
        setTimeout(() => {
          const s = sessions.get(id);
          if (s && s.proc && s.status === 'running') {
            const lines = contextPaths.map(p => `- ${p}`).join('\n');
            s.proc.write(`Proyectos relacionados disponibles:\n${lines}\n`);
          }
        }, 5000);
      }

    } else if (type === 'git-info') {
      // Branch + pending-change info for every session, deduped by cwd
      const cwds = [...new Set([...sessions.values()].map(s => s.cwd))];
      const byCwd = {};
      let left = cwds.length;
      const finish = () => {
        if (ws.readyState !== 1) return;
        const data = {};
        for (const [id, s] of sessions) data[id] = byCwd[s.cwd] || null;
        ws.send(JSON.stringify({ type: 'git-info', data }));
      };
      if (!left) return finish();
      cwds.forEach(cwd => gitInfoFor(cwd, info => { byCwd[cwd] = info; if (--left === 0) finish(); }));

    } else if (type === 'git-diff') {
      const s = sessions.get(sessionId);
      if (!s || typeof msg.file !== 'string') return;
      // Renames arrive as "old -> new"; diff the new path
      const file = msg.file.includes(' -> ') ? msg.file.split(' -> ').pop() : msg.file;
      // Keep the path inside the session's cwd (git-diff --no-index could read anything)
      const full = path.resolve(s.cwd, file);
      if (full !== path.resolve(s.cwd) && !full.startsWith(path.resolve(s.cwd) + path.sep)) return;
      const opts = { cwd: s.cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
      const send = d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'git-diff', sessionId, file: msg.file, diff: d })); };
      const clip = d => d.length > 200000 ? d.slice(0, 200000) + '\n… (diff truncado)' : d;
      execFile('git', ['diff', 'HEAD', '--', file], opts, (e1, o1) => {
        if (o1 && o1.trim()) return send(clip(o1));
        execFile('git', ['diff', '--', file], opts, (e2, o2) => {
          if (o2 && o2.trim()) return send(clip(o2));
          // Untracked file: diff against /dev/null (git exits 1 here by design)
          execFile('git', ['diff', '--no-index', '--', IS_WIN ? 'NUL' : '/dev/null', file], opts, (e3, o3) => {
            send(o3 && o3.trim() ? clip(o3) : '(sin cambios que mostrar — ¿archivo binario o vacío?)');
          });
        });
      });

    } else if (type === 'cmd-state') {
      // Is the session sitting at a shell prompt right now? Gates the box.
      const s = sessions.get(sessionId);
      ws.send(JSON.stringify({
        type: 'cmd-state', sessionId,
        shell: !!(s && s.proc && s.status === 'running' && fgIsShell(s)),
      }));

    } else if (type === 'cmd-delete') {
      commands = commands.filter(c => c.cmd !== msg.cmd);
      scheduleCmdSave();
      scheduleCmdBroadcast();

    } else if (type === 'cmd-edit') {
      // Renombrar un comando del historial; si el nombre nuevo ya existe,
      // se fusionan (suma de usos, fecha más reciente).
      const from = commands.find(c => c.cmd === msg.old);
      const to = (msg.new || '').trim();
      if (!from || !to || to === msg.old) return;
      const dup = commands.find(c => c.cmd === to);
      if (dup) {
        dup.count += from.count;
        dup.last = Math.max(dup.last, from.last);
        commands = commands.filter(c => c !== from);
      } else {
        from.cmd = to;
      }
      scheduleCmdSave();
      scheduleCmdBroadcast();

    } else if (type === 'cmd-clear-singles') {
      // Limpieza de basura: fuera todos los comandos usados una sola vez
      const before = commands.length;
      commands = commands.filter(c => c.count > 1);
      scheduleCmdSave();
      scheduleCmdBroadcast();
      ws.send(JSON.stringify({ type: 'cmd-cleared', removed: before - commands.length }));

    } else if (type === 'restart-service') {
      // El supervisor (launchd/systemd/Task Scheduler) revive el proceso al
      // salir — mismo mecanismo que un reinicio manual. Sin supervisor, el
      // servicio queda apagado (advertido en el botón).
      console.log('[restart] solicitado desde el dashboard — saliendo para que el supervisor reviva el servicio');
      broadcast({ type: 'restarting' });
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveConfig(); }
      setTimeout(() => process.exit(0), 300); // deja salir el broadcast

    } else if (type === 'watch-response') {
      startResponseWatch(ws, sessionId);

    } else if (type === 'stop-watch') {
      stopResponseWatch(ws, false);

    } else if (type === 'voice-audio') {
      transcribe(msg.audio, (text, error) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'voice-text', text, error }));
      });

    } else if (type === 'voice-partial') {
      // Dictado incremental: tramos transcritos EN PARALELO a la grabación —
      // al soltar solo falta la colita y el resultado sale casi al instante.
      let d = dictations.get(ws);
      if (!d) { d = new Map(); dictations.set(ws, d); }
      d.set(msg.seq | 0, transcribeP(msg.audio));

    } else if (type === 'voice-final') {
      const d = dictations.get(ws) || new Map();
      dictations.delete(ws);
      d.set(msg.seq | 0, transcribeP(msg.audio));
      const seqs = [...d.keys()].sort((a, b) => a - b);
      Promise.all(seqs.map(s => d.get(s))).then(results => {
        if (ws.readyState !== 1) return;
        const errs = results.filter(r => r.error).map(r => r.error);
        const text = results.map(r => (r.text || '').trim()).filter(Boolean).join(' ');
        if (!text && errs.length) ws.send(JSON.stringify({ type: 'voice-text', text: null, error: errs[0] }));
        else ws.send(JSON.stringify({ type: 'voice-text', text, error: null }));
      });

    } else if (type === 'tts') {
      handleTts(ws, msg);

    } else if (type === 'tts-catalog') {
      ws.send(JSON.stringify({ type: 'tts-catalog', voices: ttsCatalog() }));

    } else if (type === 'save-voice') {
      // Voz TTS elegida para el panel ('' = sin voz, la lee el usuario)
      const s = sessions.get(sessionId);
      if (s) s.voice = msg.voice || '';
      const saved = (config.sessions || []).find(c => c.id === sessionId);
      if (saved) { saved.voice = msg.voice || ''; saveConfig(); }
      broadcast({ type: 'voice-saved', sessionId, voice: msg.voice || '' });

    } else if (type === 'read-file') {
      // Contenido completo de un archivo del repo — para la vista markdown
      // renderizada del git drawer. Misma protección de rutas que git-diff.
      const s = sessions.get(sessionId);
      if (!s || typeof msg.file !== 'string') return;
      const file = msg.file.includes(' -> ') ? msg.file.split(' -> ').pop() : msg.file;
      const full = path.resolve(s.cwd, file);
      if (full !== path.resolve(s.cwd) && !full.startsWith(path.resolve(s.cwd) + path.sep)) return;
      fs.readFile(full, (err, buf) => {
        if (ws.readyState !== 1) return;
        const MAX = 1024 * 1024;
        const content = err ? null :
          (buf.length > MAX ? buf.toString('utf8', 0, MAX) + '\n\n… (archivo truncado a 1MB)' : buf.toString('utf8'));
        ws.send(JSON.stringify({ type: 'file-content', sessionId, file: msg.file, content, error: err ? err.message : null }));
      });

    } else if (type === 'save-subtitle') {
      const s = sessions.get(sessionId);
      if (s) s.subtitle = msg.subtitle;
      const saved = (config.sessions || []).find(c => c.id === sessionId);
      if (saved) { saved.subtitle = msg.subtitle; saveConfig(); }
    }
  });

  ws.on('close', () => { clients.delete(ws); stopResponseWatch(ws, false); dictations.delete(ws); });
  ws.on('error', () => { clients.delete(ws); stopResponseWatch(ws, false); dictations.delete(ws); });
});

server.listen(PORT, () => {
  console.log(`CladeManager running → http://localhost:${PORT}`);
  if (!isConfigured()) console.log('⚠ Not configured — open the browser to complete setup.');
});

let reloadTimer;
// Watch the directory, not the file: editors replace files via rename, which
// kills a file-level watcher after the first save (stale cache + no reload).
// Recursive: el cliente vive repartido en public/js y public/css.
fs.watch(path.join(__dirname, 'public'), { recursive: true }, (ev, filename) => {
  if (filename && !/\.(html|js|css)$/.test(filename)) return;
  if (!filename || filename.endsWith('index.html')) indexCache = null;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 120);
});
