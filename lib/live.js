// lib/live.js — Paneles web: navegadores reales dentro del dashboard.
//
// Un panel web es una pestaña de un Chromium headless que corre AQUÍ, en el
// servidor: el navegador del usuario solo recibe la imagen (screencast por
// CDP) y manda clics/teclado/pegado. Así cargan sitios que prohíben iframes
// (claude.ai, chatgpt.com…) y los logins funcionan de verdad — para el sitio
// es una pestaña normal.
//
// Consumo: UN solo proceso Chromium compartido; cada panel es un contexto
// aislado (cookies/login propios, guardados en disco como storageState y
// restaurados al despertar). Los paneles que no se ven se DUERMEN: se cierra
// su pestaña a los N minutos y vuelve al mostrarlos, con el login intacto.
// Idea original: comparationweb (server/live.ts).
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium = null;
try { chromium = require('playwright-core').chromium; } catch {}

const SLEEP_MS = Number(process.env.LIVE_SLEEP_MINUTES || 15) * 60000;
const SAVE_MS = 60000;           // guardado periódico del login
const DESKTOP_WIDTH = 1100;      // ancho mínimo del viewport: se escala al tamaño del panel

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try { const p = chromium && chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch {}
  const home = os.homedir();
  const caches = [path.join(home, 'Library/Caches/ms-playwright'), path.join(home, '.cache/ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')];
  const rel = process.platform === 'darwin'
    ? ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
       'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32' ? ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe'] : ['chrome-linux/chrome', 'chrome-linux64/chrome'];
  for (const cache of caches) {
    let dirs; try { dirs = fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]); } catch { continue; }
    for (const d of dirs) for (const r of rel) { const p = path.join(cache, d, r); if (fs.existsSync(p)) return p; }
  }
  const system = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return system.find(p => fs.existsSync(p)) || null;
}

function viewportFor(width, height) {
  const vw = Math.max(Math.round(width), DESKTOP_WIDTH);
  return { width: vw, height: Math.max(200, Math.round((height * vw) / Math.max(width, 1))) };
}
const safeName = id => String(id).replace(/[^a-zA-Z0-9-]/g, '_');
const log = (...a) => console.log('[web]', ...a);
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no respondió en ${ms / 1000}s`)), ms); }),
  ]);
}

class LiveManager {
  constructor({ profilesDir, send }) {
    this.profilesDir = profilesDir;
    this.send = send;               // (ws, msg) => void
    this.panels = new Map();        // id -> panel
    this.browser = null;
    this.browserP = null;
    fs.mkdirSync(profilesDir, { recursive: true });
    this.timer = setInterval(() => this.sweep(), 15000);
  }

  // ¿Hay con qué? (playwright-core instalado + algún Chromium en la máquina)
  availability() {
    if (!chromium) return { ok: false, error: 'falta playwright-core (npm install)' };
    if (!findChromium()) return { ok: false, error: 'no hay Chromium/Chrome: npx playwright-core install chromium' };
    return { ok: true };
  }

  async getBrowser() {
    if (this.browser) return this.browser;
    if (this.browserP) return this.browserP;
    const exe = findChromium();
    if (!chromium || !exe) throw new Error(this.availability().error);
    this.browserP = chromium.launch({
      executablePath: exe, headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--disable-background-networking',
             '--disable-extensions', '--disable-dev-shm-usage', '--no-first-run', '--mute-audio'],
    }).then(b => {
      this.browser = b; this.browserP = null;
      b.on('disconnected', () => { // se cayó: todos los paneles pasan a dormidos y se reabren solos
        this.browser = null;
        for (const p of this.panels.values()) { p.context = p.page = p.cdp = null; p.streaming = false; this.status(p, 'sleeping'); }
      });
      return b;
    }).catch(e => { this.browserP = null; throw e; });
    return this.browserP;
  }

  register(id, url) {
    let p = this.panels.get(id);
    if (!p) {
      // viewers: cada navegador conectado que tiene este panel (ws -> { streaming }).
      // El viewport y el tamaño del screencast siguen al último que lo VE.
      p = { id, url, viewers: new Map(), viewport: viewportFor(900, 500), screencast: { maxWidth: 900, maxHeight: 500 },
            streaming: false, context: null, page: null, cdp: null, chain: Promise.resolve(),
            lastSeen: Date.now(), lastSaved: 0, storage: path.join(this.profilesDir, safeName(id) + '.json') };
      this.panels.set(id, p);
    } else if (url) p.url = url;
    return p;
  }

  // Todas las operaciones de un panel van en serie (despertar + redimensionar + navegar…)
  run(p, fn) {
    p.chain = p.chain.then(() => withTimeout(fn(), 60000, 'operación del panel')).catch(e => {
      log('error en', p.id, e.message);
      this.status(p, 'error', { error: e.message });
    });
    return p.chain;
  }

  // El cliente pide ver/dejar de ver un panel (al montarlo, al redimensionar,
  // al ocultar su workspace, al cambiar de pestaña…)
  open(ws, msg) {
    const p = this.register(msg.sessionId, msg.url);
    p.viewers.set(ws, { streaming: !!msg.streaming });
    if (msg.streaming) p.lastSeen = Date.now();
    const viewport = viewportFor(msg.width || 900, msg.height || 500);
    const screencast = { maxWidth: Math.round((msg.width || 900) * (msg.dpr || 1)), maxHeight: Math.round((msg.height || 500) * (msg.dpr || 1)) };
    return this.run(p, async () => {
      if (!msg.streaming) { // este cliente no lo ve: apaga el stream solo si nadie más lo ve
        if (p.page && !this.anyoneWatching(p)) await this.setStreaming(p, false);
        this.send(ws, this.statusMsg(p, p.page ? 'ready' : 'sleeping'));
        return;
      }
      const wasAsleep = !p.page;
      if (wasAsleep) await this.wake(p);
      if (!p.page) return;
      const resized = p.viewport.width !== viewport.width || p.viewport.height !== viewport.height;
      if (resized) { p.viewport = viewport; await p.page.setViewportSize(viewport); }
      const scChanged = p.screencast.maxWidth !== screencast.maxWidth || p.screencast.maxHeight !== screencast.maxHeight;
      p.screencast = screencast;
      if (!p.streaming || resized || scChanged) await this.setStreaming(p, true);
      this.status(p, 'ready');
    });
  }

  async wake(p) {
    const browser = await this.getBrowser();
    const hasState = fs.existsSync(p.storage);
    const context = await browser.newContext({
      viewport: p.viewport, locale: 'es-MX',
      ...(hasState ? { storageState: p.storage } : {}),
    });
    p.context = context;
    // Menos consumo: fuera medios y fuentes externas (los chats no las necesitan)
    await context.route('**/*', route => {
      const t = route.request().resourceType();
      if (t === 'media' || t === 'font') return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    });
    const page = await context.newPage();
    p.page = page;
    const cdp = await context.newCDPSession(page);
    p.cdp = cdp;
    const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
    if (ua) await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua.replace('HeadlessChrome', 'Chrome') }).catch(() => {});

    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      const ack = () => cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      const targets = [...p.viewers].filter(([ws, v]) => v.streaming && ws.readyState === 1).map(([ws]) => ws);
      if (!targets.length) return void ack();
      const frame = JSON.stringify({ type: 'live-frame', sessionId: p.id, data });
      // El acuse espera a que el cuadro salga por el primer socket (evita acumular imágenes)
      targets.forEach((ws, i) => ws.send(frame, i === 0 ? ack : undefined));
    });
    page.on('framenavigated', f => { if (f === page.mainFrame()) this.status(p, 'ready'); });
    page.on('dialog', d => d.accept().catch(() => {}));
    context.on('page', async popup => { // ligas a otra pestaña → mismo panel
      if (popup === page) return;
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      const url = popup.url();
      await popup.close().catch(() => {});
      if (url && url !== 'about:blank') page.goto(url).catch(() => {});
    });
    context.on('close', () => { if (p.context === context) { p.context = p.page = p.cdp = null; p.streaming = false; } });
    this.status(p, 'launching');
    await page.goto(p.url, { waitUntil: 'commit' }).catch(() => {});
    p.lastSaved = Date.now();
  }

  async setStreaming(p, on) {
    if (!p.cdp) return;
    if (p.streaming) await p.cdp.send('Page.stopScreencast').catch(() => {});
    p.streaming = on;
    if (on) await p.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, ...p.screencast, everyNthFrame: 1 }).catch(() => {});
  }

  async saveState(p) {
    if (!p.context) return;
    try { await p.context.storageState({ path: p.storage }); p.lastSaved = Date.now(); } catch {}
  }

  async sleep(p, reason) {
    if (!p.context) return;
    await this.saveState(p);
    const ctx = p.context;
    p.context = p.page = p.cdp = null; p.streaming = false;
    await ctx.close().catch(() => {});
    this.status(p, 'sleeping', { reason });
  }

  input(ws, msg) {
    const p = this.panels.get(msg.sessionId);
    if (!p) return;
    p.lastSeen = Date.now();
    const { cdp, page } = p;
    if (msg.type === 'live-mouse' || msg.type === 'live-key' || msg.type === 'live-text') {
      if (!cdp) return;
      // Sin cola: el CDP ya procesa en orden, y así un evento lento nunca traba el panel
      let call;
      if (msg.type === 'live-mouse') {
        const { x, y, ...rest } = msg.event || {};
        call = cdp.send('Input.dispatchMouseEvent', { ...rest, x: (x || 0) * p.viewport.width, y: (y || 0) * p.viewport.height });
      } else if (msg.type === 'live-key') call = cdp.send('Input.dispatchKeyEvent', msg.event || {});
      else call = cdp.send('Input.insertText', { text: String(msg.text || '') });
      call.catch(e => log('input', msg.type, e.message));
      return;
    }
    return this.run(p, async () => {
      if (!cdp || !page) return;
      if (msg.type === 'live-nav') {
        if (msg.action === 'back') await page.goBack().catch(() => {});
        else if (msg.action === 'forward') await page.goForward().catch(() => {});
        else if (msg.action === 'reload') await page.reload().catch(() => {});
        else if (msg.action === 'goto' && msg.url) { p.url = msg.url; await page.goto(msg.url, { waitUntil: 'commit' }).catch(() => {}); }
      }
    });
  }

  // La pestaña del dashboard se fue: nadie mira, apaga streams (sin cerrar nada)
  disown(ws) {
    for (const p of this.panels.values()) {
      if (!p.viewers.delete(ws)) continue;
      if (p.page && p.streaming && !this.anyoneWatching(p)) this.run(p, () => this.setStreaming(p, false));
    }
  }

  // El panel se cerró en el dashboard: adiós pestaña y login guardado
  destroy(id) {
    const p = this.panels.get(id);
    if (!p) return;
    this.panels.delete(id);
    const ctx = p.context;
    p.context = p.page = p.cdp = null;
    if (ctx) ctx.close().catch(() => {});
    try { fs.unlinkSync(p.storage); } catch {}
  }

  sweep() {
    const now = Date.now();
    for (const p of this.panels.values()) {
      if (!p.page) continue;
      if (!p.streaming && now - p.lastSeen > SLEEP_MS) this.run(p, () => this.sleep(p, 'idle'));
      else if (now - p.lastSaved > SAVE_MS) this.run(p, () => this.saveState(p));
    }
  }

  anyoneWatching(p) { return [...p.viewers.values()].some(v => v.streaming); }

  statusMsg(p, state, extra) {
    const url = p.page && !p.page.isClosed() ? p.page.url() : p.url;
    return { type: 'live-status', sessionId: p.id, state, url, ...(extra || {}) };
  }
  status(p, state, extra) {
    const m = this.statusMsg(p, state, extra);
    for (const ws of p.viewers.keys()) this.send(ws, m);
  }

  // Al apagar el servicio: guarda los logins de todas las pestañas vivas
  async shutdown() {
    await Promise.all([...this.panels.values()].map(p => this.saveState(p).catch(() => {})));
  }
}

module.exports = { LiveManager, findChromium };
