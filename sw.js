// SORA service worker: deixa o app instalável e mostra as notificações de venda.
const CACHE = 'sora-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// Páginas: sempre busca a versão nova; sem internet, mostra a última que abriu.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/')))
  );
});

// Notificação enviada pelo servidor (para quando o app estiver fechado).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Venda aprovada! 💜', {
    body: d.body || '', icon: '/icons/notify-192.png', badge: '/icons/badge-96.png',
    vibrate: [90, 50, 90, 50, 160], tag: d.tag || 'sora-venda-' + Date.now(), renotify: true, data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
