// sw.js — Service worker. Su ÚNICA función es recibir Web Push y abrir la app
// al tocar la notificación.
//
// Deliberadamente NO cachea nada. El dashboard es una app en vivo servida con
// Cache-Control: no-cache, y un service worker que cachea es la causa número uno
// de "actualicé el código y el navegador sigue mostrando el viejo". Si algún día
// se quiere modo offline, hay que versionar el caché e invalidarlo en 'activate'.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }

  const title = d.title || 'Claude Manager';
  const opts = {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    // Una notificación por sesión: si llegan varias de la misma, se reemplaza
    // en vez de apilarse.
    tag: d.tag || 'claudemanager',
    renotify: true,
    data: { sessionId: d.sessionId || null, url: d.url || '/' },
    // iOS ignora vibrate; Android lo usa.
    vibrate: [60, 40, 60],
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const sid = event.notification.data && event.notification.data.sessionId;
  const target = new URL(sid ? `/?session=${encodeURIComponent(sid)}` : '/', self.location.origin).href;

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Si la app ya está abierta, la enfocamos y le decimos a qué sesión ir,
    // en vez de abrir una ventana nueva.
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        if (sid) w.postMessage({ type: 'abrir-sesion', sessionId: sid });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
