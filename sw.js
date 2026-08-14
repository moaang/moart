// ver1053: offline shell for the Add-to-Home-Screen app. iOS Safari cannot open a local HTML file at all
// (file:// is blocked; the Files-app Quick Look preview does not run JS), so a cached PWA is the only way this
// runs offline on iPad. Stale-while-revalidate: the cached copy launches instantly — it is ~4MB, and a
// network-first fetch would stall every cold start — while a fresh copy downloads in the background and is
// served on the NEXT launch. One release behind for one launch is the deliberate trade.
const CACHE = 'conte-shell-v1'; // FIXED on purpose: bumping it per release would force a full re-download every time.
const SHELL = ['./', './index.html'];

// ONE-TIME shell replacement, for clients already stuck on an old cached shell. The cache NAME stays
// fixed (bumping it per release would force a full re-download every time — see CACHE above); instead a
// token is stored IN the cache and compared on activate, so this runs once per token change and never
// otherwise. Change the token only when stuck clients must be freed.
// REPLACE, never delete: deleting would leave an offline iPad with no app at all if the refetch failed.
// On failure the old shell stays AND the token is not written, so the next activate tries again.
const PURGE_TOKEN = '2026-08-15-waituntil';
const PURGE_KEY = './__shell-purge-token';   // not a real path — nothing ever fetches it

// ver1459: the stale-while-revalidate trade above says "one release behind for one launch". That was fine
// when releases were rare, but during a run of frequent deploys every launch stays one behind and the app
// looks like it never updated (reported as "you don't seem to be deploying"). So once the fresh shell is IN
// THE CACHE, tell the open page — it shows a "new version / reload" bar, and reloading serves the copy we
// just stored. The offline-instant launch is unchanged; only the not-knowing is fixed.
// Version is judged from HEADERS, never the 5.7MB body: GitHub Pages sends a strong ETag.
function shellStamp(res) {
  if (!res || !res.headers) return '';
  return res.headers.get('etag') || res.headers.get('last-modified') || '';
}
function isShellRequest(request, url) {
  if (request.mode === 'navigate') return true;
  return SHELL.some(function (path) { return new URL(path, self.location.href).href === url.href; });
}
function notifyShellUpdated() {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage({ type: 'moart-shell-updated' }); });
  });
}

function replaceShellFromNetwork(c) {
  const first = new URL(SHELL[0], self.location.href).href;
  return fetch(first, { cache: 'reload' }).then(function (res) {   // cache:reload — bypass the HTTP cache
    if (!res || !res.ok) throw new Error('shell fetch failed: ' + (res && res.status));
    // both SHELL entries are the same document; clone once per entry rather than downloading twice.
    return Promise.all(SHELL.map(function (p) {
      return c.put(new URL(p, self.location.href).href, res.clone());
    }));
  });
}

function runOneTimeShellPurge() {
  const tokenUrl = new URL(PURGE_KEY, self.location.href).href;
  return caches.open(CACHE).then(function (c) {
    return c.match(tokenUrl).then(function (rec) {
      return (rec ? rec.text() : Promise.resolve('')).then(function (seen) {
        if (seen === PURGE_TOKEN) return;                       // this client already did it
        return replaceShellFromNetwork(c)
          .then(function () { return c.put(tokenUrl, new Response(PURGE_TOKEN)); })
          .then(notifyShellUpdated);   // a pre-ver1459 shell cannot hear this — its NEXT launch is fresh anyway
      });
    });
  }).catch(function (err) {
    console.error('[sw] one-time shell purge failed', err);     // never silent
  });
}

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
      .then(runOneTimeShellPurge)   // after claim: a slow shell refetch must not delay taking control
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // same-origin only — GoatCounter (gc.zgo.at) and any other third party must pass straight through, so it
  // simply fails silently offline instead of being cached or retried.
  if (url.origin !== self.location.origin) return;
  // **The background half of stale-while-revalidate is now HELD OPEN.** Nothing used to hold it: the
  // cached copy answered respondWith, the worker went idle, and the browser was free to kill it
  // mid-download — with a ~5.7MB shell that window is wide. The put never landed, so the next launch was
  // stale too, and the next, forever; the slower the line, the more certain. A report arrived from a
  // build 707 releases old, on a shell too old to even receive the ver1459 update message.
  // Two things changed: the put is INSIDE this chain (it used to dangle off caches.open with nothing
  // awaiting it), and waitUntil keeps the worker alive until that chain settles.
  const net = fetch(e.request);
  const stored = net.then(function (res) {
    if (!res || !res.ok) return;
    const copy = res.clone();
    const fresh = shellStamp(res);
    const shell = isShellRequest(e.request, url);
    return caches.open(CACHE).then(function (c) {
      // read the OLD entry before overwriting it — that is the copy the user is looking at right now
      return c.match(e.request).then(function (old) {
        const stale = shellStamp(old);
        return c.put(e.request, copy).then(function () {
          // notify only AFTER the put, so a reload is guaranteed to get the new shell.
          // no old entry = first visit, missing stamp = no grounds to judge -> stay quiet either way
          // (a false "new version" banner would be worse than the delay it is fixing).
          if (shell && old && fresh && stale && fresh !== stale) return notifyShellUpdated();
        });
      });
    });
  }).catch(function (err) {
    // never silent: a failed cache write means the NEXT launch is still stale and nobody would know
    console.error('[sw] shell cache update failed', err);
  });
  e.waitUntil(stored);   // MUST be called synchronously, while the event is still dispatching
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      // A cache MISS that also fails the network must still resolve to a Response — respondWith(undefined)
      // throws a TypeError and takes the whole request down with it. Hits the first-ever visit made offline,
      // and any same-origin asset outside SHELL requested while offline.
      return net.catch(function () { return Response.error(); });
    })
  );
});
