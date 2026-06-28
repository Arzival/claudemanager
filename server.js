const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

process.on('uncaughtException', err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const PORT = 3000;
const BUFFER_LIMIT = 1000;          // max chunks of replay history per session
const BUFFER_BYTES = 256 * 1024;    // cap replay history at ~256 KB per session
const FLUSH_MS = 16; // coalesce PTY output into one broadcast per frame
const CONFIG_FILE = path.join(__dirname, 'sessions.json');
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

// Try to auto-detect claude binary path
function detectClaude() {
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
  const data = p.chunks.join('');
  p.chunks.length = 0;
  broadcast({ type: 'output', sessionId: id, data });
}

function broadcast(msg) {
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
    })
    .filter(t => t.projects.length > 0);
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

const usageProviders = { 'claude-code': readClaudeUsage };

// Resolve which provider a session uses: explicit tool.usageProvider wins,
// else infer from the command (anything running `claude` → claude-code).
function providerFor(session) {
  const tool = (config.tools || []).find(t => t.id === session.toolId);
  if (tool && tool.usageProvider) return tool.usageProvider;
  if ((session.command || '').toLowerCase().includes('claude')) return 'claude-code';
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
  for (const d of dirs) {
    const dir = path.join(root, d);
    let files; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs >= cutoff) ingestTranscript(fp); // files touched within retention
    }
  }
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
function readOAuthToken() {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8' });
    const j = JSON.parse(raw);
    return (j.claudeAiOauth || j).accessToken || null;
  } catch { return null; }
}

function fetchOfficialUsage(cb) {
  const tok = readOAuthToken();
  if (!tok) { cb(null); return; }
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
      if (res.statusCode !== 200) { cb(null); return; }
      try {
        const j = JSON.parse(b);
        const pick = w => w ? { percent: w.utilization, resetAt: Date.parse(w.resets_at) } : null;
        cb({ session: pick(j.five_hour), weekly: pick(j.seven_day), at: Date.now() });
      } catch { cb(null); }
    });
  });
  req.on('error', () => cb(null));
  req.on('timeout', () => { req.destroy(); cb(null); });
  req.end();
}

let officialUsage = null, officialFetchedAt = 0, officialInFlight = false;
function getOfficialUsage(force, cb) {
  if (!force && officialUsage && Date.now() - officialFetchedAt < 30000) return cb(officialUsage);
  if (officialInFlight) return cb(officialUsage); // serve stale while a fetch runs
  officialInFlight = true;
  fetchOfficialUsage(u => {
    officialInFlight = false;
    if (u) { officialUsage = u; officialFetchedAt = Date.now(); }
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

// HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('Error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url.startsWith('/fondos/')) {
    const file = decodeURIComponent(req.url.slice('/fondos/'.length).split('?')[0]);
    const ext = path.extname(file).toLowerCase();
    const full = path.join(BACKGROUNDS_DIR, file);
    // Block path traversal and non-image requests
    if (!full.startsWith(BACKGROUNDS_DIR + path.sep) || !IMG_TYPES[ext]) {
      res.writeHead(404); return res.end('Not found');
    }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': IMG_TYPES[ext], 'Cache-Control': 'no-cache' });
      res.end(data);
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
    tools: config.tools || [],
    defaultTool: config.defaultTool || 'claude',
    backgrounds: listBackgrounds(),
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, sessionId } = msg;

    if (type === 'list') {
      const list = [];
      for (const [id, s] of sessions)
        list.push({ id, name: s.name, cwd: s.cwd, status: s.status, cols: s.cols || 80, rows: s.rows || 24 });
      ws.send(JSON.stringify({ type: 'sessions', sessions: list }));
      for (const [id, buf] of buffers)
        if (buf.length) ws.send(JSON.stringify({ type: 'output', sessionId: id, data: buf.join('') }));

    } else if (type === 'save-config') {
      config.projectsRoot = msg.projectsRoot.trim();
      config.claudePath = msg.claudePath.trim();
      saveConfig();
      broadcast({ type: 'reload' });

    } else if (type === 'input') {
      const s = sessions.get(sessionId);
      if (s && s.proc && s.status === 'running') s.proc.write(msg.data);

    } else if (type === 'resize') {
      const s = sessions.get(sessionId);
      if (s && s.proc && s.status === 'running') {
        try { s.proc.resize(msg.cols, msg.rows); } catch {}
        const saved = (config.sessions || []).find(c => c.id === sessionId);
        if (saved) { saved.cols = msg.cols; saved.rows = msg.rows; saveConfig(); }
      }
    } else if (type === 'detect-claude') {
      ws.send(JSON.stringify({ type: 'detected-claude', path: detectClaude() }));

    } else if (type === 'list-backgrounds') {
      ws.send(JSON.stringify({ type: 'backgrounds', files: listBackgrounds() }));

    } else if (type === 'usage') {
      getOfficialUsage(msg.force, official => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({
          type: 'usage', sessions: collectUsage(),
          window: getWindow(msg.force), // local fallback if the token can't be read
          official,                     // exact { session, weekly } or null
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
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`CladeManager running → http://localhost:${PORT}`);
  if (!isConfigured()) console.log('⚠ Not configured — open the browser to complete setup.');
});

let reloadTimer;
fs.watch(path.join(__dirname, 'public', 'index.html'), () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 120);
});
