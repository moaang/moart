// ver1053: offline shell for the Add-to-Home-Screen app. iOS Safari cannot open a local HTML file at all
// (file:// is blocked; the Files-app Quick Look preview does not run JS), so a cached PWA is the only way this
// runs offline on iPad. Stale-while-revalidate: the cached copy launches instantly — it is ~4MB, and a
// network-first fetch would stall every cold start — while a fresh copy downloads in the background and is
// served on the NEXT launch. One release behind for one launch is the deliberate trade.
const CACHE = 'conte-shell-v1'; // FIXED on purpose: bumping it per release would force a full re-download every time.
const SHELL = ['./', './index.html'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // same-origin only — GoatCounter (gc.zgo.at) and any other third party must pass straight through, so it
  // simply fails silently offline instead of being cached or retried.
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      const net = fetch(e.request).then(function (res) {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
        return res;
      }).catch(function () {
        // A cache MISS that also fails the network must still resolve to a Response — respondWith(undefined)
        // throws a TypeError and takes the whole request down with it. Hits the first-ever visit made offline,
        // and any same-origin asset outside SHELL requested while offline.
        return hit || Response.error();
      });
      return hit || net;
    })
  );
});
