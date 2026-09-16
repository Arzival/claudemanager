// push.js — Web Push (notificaciones al móvil aunque no haya navegador abierto).
//
// Las llaves VAPID se generan solas la primera vez y viven en ~/.claudemanager/,
// NUNCA en el repo: son la identidad de tu servidor frente a los servicios de
// push de Apple/Google y no deben compartirse ni versionarse.
//
// Las suscripciones también se guardan ahí. Cada navegador que concede permiso
// registra una; las que dejan de existir (app desinstalada, permiso revocado)
// se podan solas cuando el servicio de push responde 404/410.

const fs = require('fs');
const path = require('path');

let webpush = null;
try {
  webpush = require('web-push');
} catch {
  // Dependencia ausente (npm install viejo): el resto del dashboard sigue
  // funcionando, solo se desactivan las notificaciones.
  console.warn('[push] módulo web-push no instalado — notificaciones desactivadas. Corre: npm install');
}

const DATA_DIR = path.join(require('os').homedir(), '.claudemanager');
const FILE = path.join(DATA_DIR, 'push.json');
// El "subject" VAPID identifica a quien opera el servidor ante Apple/Google.
// Tiene que ser un mailto: o https: VÁLIDO: Apple responde 403 y no entrega nada
// si no lo es (un "mailto:algo@localhost" lo rechaza). Se usa la URL del
// proyecto por defecto para no filtrar el correo de nadie; cámbialo por el tuyo
// con CM_PUSH_SUBJECT si prefieres que el servicio de push tenga tu contacto.
const SUBJECT = process.env.CM_PUSH_SUBJECT || 'https://github.com/Arzival/claudemanager';

let state = { vapid: null, subscriptions: [] };
let ready = false;

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[push] no se pudo guardar push.json:', e.message);
  }
}

function init() {
  if (!webpush) return;
  try {
    if (fs.existsSync(FILE)) state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('[push] push.json ilegible, se regenera:', e.message);
    state = { vapid: null, subscriptions: [] };
  }
  if (!state.vapid || !state.vapid.publicKey || !state.vapid.privateKey) {
    state.vapid = webpush.generateVAPIDKeys();
    console.log('[push] llaves VAPID generadas en', FILE);
  }
  if (!Array.isArray(state.subscriptions)) state.subscriptions = [];
  webpush.setVapidDetails(SUBJECT, state.vapid.publicKey, state.vapid.privateKey);
  save();
  ready = true;
}

const enabled = () => ready && !!webpush;
const publicKey = () => (state.vapid ? state.vapid.publicKey : null);
const count = () => state.subscriptions.length;

function subscribe(sub) {
  if (!sub || !sub.endpoint) return false;
  if (state.subscriptions.some(s => s.endpoint === sub.endpoint)) return true;
  state.subscriptions.push(sub);
  save();
  console.log(`[push] suscripción registrada (${state.subscriptions.length} en total)`);
  return true;
}

function unsubscribe(endpoint) {
  const before = state.subscriptions.length;
  state.subscriptions = state.subscriptions.filter(s => s.endpoint !== endpoint);
  if (state.subscriptions.length !== before) save();
  return before !== state.subscriptions.length;
}

// Envía a todos los dispositivos suscritos. Las suscripciones muertas se podan.
async function notify(payload) {
  if (!enabled() || !state.subscriptions.length) return;
  const body = JSON.stringify(payload);
  const muertas = [];

  await Promise.all(state.subscriptions.map(async sub => {
    try {
      await webpush.sendNotification(sub, body, { TTL: 300 });
    } catch (e) {
      // 404/410 = el navegador desinstaló la app o revocó el permiso.
      const host = (() => { try { return new URL(sub.endpoint).host; } catch { return '?'; } })();
      if (e.statusCode === 404 || e.statusCode === 410) muertas.push(sub.endpoint);
      else if (e.statusCode === 403)
        console.error(`[push] 403 desde ${host} — VAPID rechazado. `
          + 'Suele ser el "subject": debe ser un mailto: o https: válido '
          + '(Apple lo exige; "localhost" no sirve). Ajusta CM_PUSH_SUBJECT.');
      else console.error(`[push] error enviando a ${host}:`, e.statusCode || e.message);
    }
  }));

  if (muertas.length) {
    state.subscriptions = state.subscriptions.filter(s => !muertas.includes(s.endpoint));
    save();
    console.log(`[push] ${muertas.length} suscripción(es) caducada(s) eliminada(s)`);
  }
}

module.exports = { init, enabled, publicKey, count, subscribe, unsubscribe, notify };
