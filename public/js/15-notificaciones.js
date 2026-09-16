// 15-notificaciones.js — Web Push + registro de la PWA.
//
// Reglas del terreno (no son opinión, son límites de las plataformas):
//   · Se necesita HTTPS con certificado válido. En http://localhost el navegador
//     hace una excepción, pero desde el móvil hay que servirlo por HTTPS.
//   · En iOS, Web Push SOLO funciona si la app está instalada en la pantalla de
//     inicio (Compartir → Añadir a inicio). En una pestaña de Safari no existe.
//   · El permiso debe pedirse desde un gesto del usuario, nunca al cargar.

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const boton = $('mv-notif');

  const esIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS se disfraza de Mac
  const instalada = () => window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const soportaPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  let registro = null;

  // ── Service worker ───────────────────────────────────────────
  async function registrarSW() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      // Ámbito raíz: el sw.js se sirve desde / (ver server.js) para que controle
      // toda la app y pueda enfocarla al tocar una notificación.
      registro = await navigator.serviceWorker.register('sw.js', { scope: '/' });
      return registro;
    } catch (e) {
      console.warn('[push] no se pudo registrar el service worker:', e.message);
      return null;
    }
  }

  // VAPID viaja en base64url; PushManager exige un Uint8Array.
  function b64aBytes(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function estadoServidor() {
    try {
      const r = await fetch('api/push/key', { cache: 'no-store' });
      return await r.json();
    } catch { return { enabled: false }; }
  }

  // ── Activar ──────────────────────────────────────────────────
  async function activar() {
    if (!soportaPush()) return aviso('Este navegador no soporta notificaciones push.');

    if (esIOS() && !instalada())
      return aviso('En iPhone/iPad primero instala la app: Compartir → Añadir a pantalla de inicio. '
                 + 'Web Push no funciona en una pestaña de Safari.');

    if (!window.isSecureContext)
      return aviso('Se necesita HTTPS. Sirve el dashboard por Tailscale, Cloudflare Tunnel o un proxy con TLS.');

    const srv = await estadoServidor();
    if (!srv.enabled || !srv.publicKey)
      return aviso('El servidor no tiene push activo. Revisa que `npm install` haya instalado web-push.');

    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted')
      return aviso(permiso === 'denied'
        ? 'Bloqueaste las notificaciones. Hay que reactivarlas en los ajustes del navegador.'
        : 'Permiso no concedido.');

    const reg = registro || await registrarSW();
    if (!reg) return aviso('No se pudo registrar el service worker.');
    await navigator.serviceWorker.ready;

    try {
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,                       // obligatorio en todos los navegadores
          applicationServerKey: b64aBytes(srv.publicKey),
        });
      }
      const r = await fetch('api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
      if (!r.ok) throw new Error('el servidor rechazó la suscripción');
      pintar(true);
      aviso('Notificaciones activadas ✓');
    } catch (e) {
      aviso('No se pudo suscribir: ' + e.message);
    }
  }

  async function desactivar() {
    try {
      const reg = registro || await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
    } catch {}
    pintar(false);
    aviso('Notificaciones desactivadas.');
  }

  function pintar(on) { if (boton) { boton.classList.toggle('on', on); boton.textContent = on ? '🔔' : '🔕'; } }

  // Usa el toast del dashboard si existe; si no, alert.
  function aviso(txt) {
    if (typeof vToast === 'function') vToast(txt);
    else alert(txt);
  }

  // ── Aviso de instalación ─────────────────────────────────────
  // Android muestra su propio diálogo de instalación; iOS no tiene ninguno, así
  // que sin este cartel los usuarios de iPhone nunca sabrían por qué no les
  // llegan notificaciones.
  function quizaSugerirInstalar() {
    const caja = $('mv-instalar'); if (!caja) return;
    if (instalada()) return;
    if (localStorage.getItem('mv-instalar-visto') === '1') return;
    if (!document.body.classList.contains('movil')) return;

    $('mv-instalar-txt').innerHTML = esIOS()
      ? 'Para recibir <b>notificaciones</b> en iPhone hay que instalar la app: '
        + 'toca <b>Compartir</b> y luego <b>Añadir a pantalla de inicio</b>.'
      : 'Instálala como app para pantalla completa y notificaciones: '
        + 'menú del navegador → <b>Instalar aplicación</b>.';
    caja.classList.add('on');
    $('mv-instalar-x').addEventListener('click', () => {
      caja.classList.remove('on');
      localStorage.setItem('mv-instalar-visto', '1');
    });
  }

  // ── Arranque ─────────────────────────────────────────────────
  (async function init() {
    if (!('serviceWorker' in navigator)) return;
    await registrarSW();

    if (boton) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && reg.pushManager && await reg.pushManager.getSubscription();
      pintar(!!sub && Notification.permission === 'granted');
      boton.addEventListener('click', () => (boton.classList.contains('on') ? desactivar() : activar()));
    }

    setTimeout(quizaSugerirInstalar, 2500);
  })();
})();
