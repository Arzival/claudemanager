const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

process.on('uncaughtException', err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const PORT = 3000;
const BUFFER_LIMIT = 1000;
const CONFIG_FILE = path.join(__dirname, 'sessions.json');
const EXAMPLE_FILE = path.join(__dirname, 'sessions.example.json');
const IS_WIN = process.platform === 'win32';

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
const clients = new Set();

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
    if (buf.length > BUFFER_LIMIT) buf.shift();
    broadcast({ type: 'output', sessionId: id, data });
  });
  proc.onExit(() => {
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
  sessions.delete(id);
  buffers.delete(id);
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
