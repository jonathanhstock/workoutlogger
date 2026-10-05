// Offline support. Network-first for the app shell so updates show up
// immediately when online; falls back to the cached copy when offline.
// API calls are never cached (the app keeps its own local copy of data).

const CACHE = 'logbook-v4';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/model.js', 'js/program.js', 'js/store.js', 'js/charts.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});

// Timer alerts pushed by the server while the app is closed or the screen is
// locked (see web-push.js). The phone plays its notification sound and
// vibration.
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { title: 'Logbook', body: event.data?.text() || '' };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || 'Logbook', {
      body: msg.body || '',
      tag: msg.tag || 'timer',
      renotify: true,
      vibrate: [300, 100, 300],
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: './' },
    }),
  );
});

// Tapping a timer alert opens the app (or brings it to the front).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => 'focus' in c);
      return open ? open.focus() : self.clients.openWindow(event.notification.data?.url || './');
    }),
  );
});
