// ver1053: offline shell for the Add-to-Home-Screen app. iOS Safari cannot open a local HTML file at all
// (file:// is blocked; the Files-app Quick Look preview does not run JS), so a cached PWA is the only way this
// runs offline on iPad. Stale-while-revalidate: the cached copy launches instantly — it is ~4MB, and a
// network-first fetch would stall every cold start — while a fresh copy downloads in the background and is
// served on the NEXT launch. One release behind for one launch is the deliberate trade.
const CACHE = 'conte-shell-v1'; // FIXED on purpose: bumping it per release would force a full re-download every time.
const SHELL = ['./', './index.html'];
// CacheStorage is shared by every app under this origin, not scoped to this worker: only MoArt's own
// old shell names may be deleted, never another app's named cache.
const CACHE_PREFIX = 'conte-shell-';
function isOldMoArtCache(name) { return name !== CACHE && name.indexOf(CACHE_PREFIX) === 0; }

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
function isShellRequest(url) {
  // Only these document aliases may populate the shared shell or announce its readiness.
  return SHELL.some(function (path) { return new URL(path, self.location.href).href === url.href; });
}
function notifyShellUpdated() {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage({ type: 'moart-shell-updated' }); });
  });
}

// Cache.put commits only after the whole body is read, so two refreshes of one key can finish in the
// reverse order they started: a slow OLD body would overwrite the NEW one already stored and announced.
// Every writer of a key (install, one-time purge, fetch refresh) therefore runs as one queued task, from
// its network response to its last put, in the order the tasks were started. A failed task never blocks
// the next one. Both shell aliases share one key.
const cacheWriteQueues = new Map();
function cacheWriteKey(url) { return isShellRequest(url) ? 'shell' : url.href; }
function queueCacheWrite(key, task) {
  const run = (cacheWriteQueues.get(key) || Promise.resolve()).then(task);
  const tail = run.catch(function () {});
  cacheWriteQueues.set(key, tail);
  tail.then(function () { if (cacheWriteQueues.get(key) === tail) cacheWriteQueues.delete(key); });
  return run;
}

function putShellResponse(c, res) {
  return Promise.all(SHELL.map(function (p) {
    return c.put(new URL(p, self.location.href).href, res.clone());
  }));
}

function replaceShellFromNetwork(c) {
  const first = new URL(SHELL[0], self.location.href).href;
  return fetch(first, { cache: 'reload' }).then(function (res) {   // cache:reload — bypass the HTTP cache
    if (!res || !res.ok) throw new Error('shell fetch failed: ' + (res && res.status));
    // both SHELL entries are the same document; clone once per entry rather than downloading twice.
    return putShellResponse(c, res);
  });
}

function runOneTimeShellPurge() {
  const tokenUrl = new URL(PURGE_KEY, self.location.href).href;
  return caches.open(CACHE).then(function (c) {
    return c.match(tokenUrl).then(function (rec) {
      return (rec ? rec.text() : Promise.resolve('')).then(function (seen) {
        if (seen === PURGE_TOKEN) return;                       // this client already did it
        return queueCacheWrite('shell', function () { return replaceShellFromNetwork(c); })
          .then(function () { return c.put(tokenUrl, new Response(PURGE_TOKEN)); })
          .then(notifyShellUpdated);   // a pre-ver1459 shell cannot hear this — its NEXT launch is fresh anyway
      });
    });
  }).catch(function (err) {
    console.error('[sw] one-time shell purge failed', err);     // never silent
  });
}

// rest-K3 #013: the purge must NOT sit in activate's waitUntil. claim() there does not help: the browser holds
// navigations until the worker is ACTIVATED (measured in Chrome: reopening the app waited the whole shell
// download, 3.9s for a 4s refetch). So activate only starts it, and every shell request keeps the one run alive
// with its own waitUntil — which also retries a run cut short by worker shutdown (the token is still missing).
// One run at a time; once it settles the next shell request just re-reads the token (one cache read).
let shellPurgeRun = null;
function ensureShellPurge() {
  if (!shellPurgeRun) shellPurgeRun = runOneTimeShellPurge().then(function () { shellPurgeRun = null; });
  return shellPurgeRun;
}

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(queueCacheWrite('shell', function () { return caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(isOldMoArtCache).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
      .then(function () { ensureShellPurge(); })   // started, not awaited: see ensureShellPurge
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
  // The store copy is split off the moment the response arrives, BEFORE a cache miss hands the original
  // to the page: the queued writer may run only after the page has read that body, and cloning a consumed
  // Response throws. Shell aliases are cloned from this copy too, so the page's body is never touched.
  // A shell request waits for a pending one-time purge before it fetches AND before it joins the write queue
  // (rest-K3 #013). Fetching first could race an old body over the purged one; queueing first deadlocks,
  // because the purge enters the same queue only after its async token read. The cached copy still answers
  // at once below — only a shell cache MISS waits. Shell requests waiting on one purge enter the queue in
  // the order they arrived; every other request is queued synchronously as before.
  const shell = isShellRequest(url);
  const purge = shell ? ensureShellPurge() : null;
  const net = (purge ? purge.then(function () { return fetch(e.request); }) : fetch(e.request)).then(function (res) {
    return { res: res, copy: res && res.ok ? res.clone() : null };
  });
  // queued in request-start order, so writes for one key commit in that order (see queueCacheWrite)
  const write = function () { return net.then(function (got) {
    const copy = got.copy;
    if (!copy) return;
    const fresh = shellStamp(copy);
    return caches.open(CACHE).then(function (c) {
      // read the OLD entry before overwriting it — that is the copy the user is looking at right now
      return c.match(e.request).then(function (old) {
        const stale = shellStamp(old);
        const storedAliases = shell ? putShellResponse(c, copy) : c.put(e.request, copy);
        return storedAliases.then(function () {
          // Both aliases must finish before any window is told the shell is ready.
          // no old entry = first visit, missing stamp = no grounds to judge -> stay quiet either way
          // (a false "new version" banner would be worse than the delay it is fixing).
          if (shell && old && fresh && stale && fresh !== stale) return notifyShellUpdated();
        });
      });
    });
  }); };
  const key = cacheWriteKey(url);
  const stored = (purge ? purge.then(function () { return queueCacheWrite(key, write); }) : queueCacheWrite(key, write)).catch(function (err) {
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
      return net.then(function (got) { return got.res; }, function () { return Response.error(); });
    })
  );
});

// Read-only census for conservative cleanup. Include older/uncontrolled windows on this origin.
self.addEventListener('message', function (event) {
  if (!event.data || event.data.type !== 'moart-storage-clients' || !event.ports[0]) return;
  const port = event.ports[0];
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (clients) {
    port.postMessage({ type: 'moart-storage-clients', onlyCaller: clients.length === 1 && !!event.source && clients[0].id === event.source.id });
  }).catch(function (error) {
    console.warn('[sw] storage client census failed', error);
    port.postMessage({ type: 'moart-storage-clients', onlyCaller: false });
  }));
});
