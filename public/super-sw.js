/* Service worker de /super (la app "IAE Super" instalada en el celular). Solo muestra avisos push y abre el
   panel al tocarlos; no guarda nada en caché: el panel siempre se pide al servidor. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/* Payload del servidor (server/push.js): { title, body, url, tag }. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'IAE Salidas';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/super-192.png',
    badge: '/icons/super-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: sameOriginPath(data.url) },
  }));
});

/* Solo rutas de este sitio: un payload no puede mandar el panel a otra página. */
function sameOriginPath(url) {
  return typeof url === 'string' && url.startsWith('/super') ? url : '/super';
}

/* Tocar el aviso: si /super ya está abierto, se enfoca y va al probador; si no, se abre. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/super', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).pathname === '/super' || new URL(c.url).pathname === '/super.html');
    if (open) {
      await open.focus();
      if ('navigate' in open) { try { await open.navigate(target); } catch (e) { /* not controlled: stays focused */ } }
      return;
    }
    await self.clients.openWindow(target);
  })());
});
