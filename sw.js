// Cached offline shell for the Add-to-Home-Screen app. The cached document lets the
// installed app launch without waiting for a fresh network copy of the large shell.
// Stale-while-revalidate downloads a fresh copy in the background for a later launch or reload.
// Offline use and failed refreshes can leave the cached copy older than one release; no maximum
// version lag is guaranteed.
const CACHE = 'conte-shell-v1'; // FIXED on purpose: bumping it per release would force a full re-download every time.
const SHELL = ['./', './index.html'];
// Both aliases are the same document, so it is stored ONCE under the first alias and every alias reads that
// entry. (Older workers stored a full copy per alias — two copies of an ~11 MB shell; activate migrates them.)
function shellKey() { return new URL(SHELL[0], self.location.href).href; }
// CacheStorage is shared by every app under this origin, not scoped to this worker: only MoArt's own
// old shell names may be deleted, never another app's named cache.
const CACHE_PREFIX = 'conte-shell-';
function isOldMoArtCache(name) { return name !== CACHE && name.indexOf(CACHE_PREFIX) === 0; }

// Replace the offline shell once per token. Keep the old shell if the download fails.
// Record the token after the replacement so a later request can retry.
const PURGE_TOKEN = '2026-08-15-waituntil';
const PURGE_KEY = './__shell-purge-token';   // not a real path — nothing ever fetches it

// After a changed, stamped shell is stored, notify open windows so the page can offer a "new version / reload"
// bar; a later reload uses the stored copy without waiting for the background refresh. Without this, frequent
// deployments make the cached launch look persistently out of date. Change detection compares ETag or
// Last-Modified headers, without reading the large body.
function shellStamp(res) {
  if (!res || !res.headers) return '';
  return res.headers.get('etag') || res.headers.get('last-modified') || '';
}
function isShellRequest(url) {
  // Only these document aliases may populate the shared shell or announce its readiness. The query is
  // ignored: a link such as ./?utm=... opens the same document and must not store another full shell copy.
  return SHELL.some(function (path) { return new URL(path, self.location.href).pathname === url.pathname; });
}
function notifyShellUpdated() {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage({ type: 'moart-shell-updated' }); });
  });
}

// Cache.put commits only after the whole body is read, so two shell refreshes can finish in the
// reverse order they started: a slow OLD body would overwrite the NEW one already stored and announced.
// Every shell writer (install, one-time purge, fetch refresh) therefore runs as one queued task, from
// its network response to its last put, in the order the tasks were started. A failed task never blocks
// the next one.
let cacheWriteTail = Promise.resolve();
function queueCacheWrite(task) {
  const run = cacheWriteTail.then(task);
  cacheWriteTail = run.catch(function () {});
  return run;
}

function putShellResponse(c, res) {
  return c.put(shellKey(), res);
}
function matchShell(c) {
  return c.match(shellKey());
}

function replaceShellFromNetwork(c) {
  return fetch(shellKey(), { cache: 'reload' }).then(function (res) {   // cache:reload — bypass the HTTP cache
    if (!res || !res.ok) throw new Error('shell fetch failed: ' + (res && res.status));
    return putShellResponse(c, res);
  });
}

function runOneTimeShellPurge() {
  const tokenUrl = new URL(PURGE_KEY, self.location.href).href;
  return caches.open(CACHE).then(function (c) {
    return c.match(tokenUrl).then(function (rec) {
      return (rec ? rec.text() : Promise.resolve('')).then(function (seen) {
        if (seen === PURGE_TOKEN) return;                       // this client already did it
        return queueCacheWrite(function () { return replaceShellFromNetwork(c); })
          .then(function () { return c.put(tokenUrl, new Response(PURGE_TOKEN)); })
          .then(notifyShellUpdated);   // an old shell without the update listener cannot hear this — its NEXT launch is fresh anyway
      });
    });
  }).catch(function (err) {
    console.error('[sw] one-time shell purge failed', err);
  });
}

// Waiting for the download during activation blocks navigation. Start it on activation;
// each shell request keeps the shared run alive with waitUntil and retries an interrupted run.
let shellPurgeRun = null;
function ensureShellPurge() {
  if (!shellPurgeRun) shellPurgeRun = runOneTimeShellPurge().then(function () { shellPurgeRun = null; });
  return shellPurgeRun;
}

// Older workers stored every same-origin GET (query variants of the shell, the local server's /voicevox
// answers) under its own URL, and a full shell copy per alias. Only the one shell entry and the purge token
// belong in this cache. An alias copy is moved to the shell key first when that key is missing — deleting it
// outright would leave an offline client with no app. (Normally install has just stored the shell key, so this
// move only guards a key removed after install.)
function dropNonShellEntries() {
  const keep = [shellKey(), new URL(PURGE_KEY, self.location.href).href];
  const aliases = SHELL.map(function (p) { return new URL(p, self.location.href).href; });
  return caches.open(CACHE).then(function (c) {
    return queueCacheWrite(function () {
      return matchShell(c).then(function (own) {
        if (own) return;
        return c.keys().then(function (reqs) {
          const alias = reqs.find(function (r) { return aliases.indexOf(r.url) >= 0; });
          return alias ? c.match(alias).then(function (res) { return res && putShellResponse(c, res); }) : null;
        });
      }).then(function () {
        return c.keys().then(function (reqs) {
          return Promise.all(reqs.filter(function (r) { return keep.indexOf(r.url) < 0; }).map(function (r) { return c.delete(r); }));
        });
      });
    });
  }).catch(function (err) { console.error('[sw] non-shell cache cleanup failed', err); });
}

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(queueCacheWrite(function () { return caches.open(CACHE).then(function (c) { return c.add(shellKey()); }); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(isOldMoArtCache).map(function (k) { return caches.delete(k); })); })
      .then(dropNonShellEntries)
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
  // Only the app shell is cached. Other same-origin GETs (the local server's /voicevox proxy, anything else)
  // go straight to the network: answering them from a cache would serve stale data.
  if (!isShellRequest(url)) return;
  // Keep the refresh alive after a cache hit returns. Clone the network response before a
  // cache miss gives its body to the page.
  // Wait for the purge before fetching or joining the write queue. Fetching earlier can
  // overwrite the replacement; joining earlier can deadlock with the purge's own write.
  const purge = ensureShellPurge();
  const net = purge.then(function () { return fetch(e.request); }).then(function (res) {
    return { res: res, copy: res && res.ok ? res.clone() : null };
  });
  // queued in request-start order, so shell writes commit in that order (see queueCacheWrite)
  const write = function () {
    return net.then(function (got) {
      const copy = got.copy;
      if (!copy) return;
      const fresh = shellStamp(copy);
      return caches.open(CACHE).then(function (c) {
        // read the OLD entry before overwriting it — that is the copy the user is looking at right now
        return matchShell(c).then(function (old) {
          const stale = shellStamp(old);
          return putShellResponse(c, copy).then(function () {
            // The shell must be stored before any window is told it is ready.
            // no old entry = first visit, missing stamp = no grounds to judge -> stay quiet either way
            // (a false "new version" banner would be worse than the delay it is fixing).
            if (old && fresh && stale && fresh !== stale) return notifyShellUpdated();
          });
        });
      });
    });
  };
  const stored = purge.then(function () { return queueCacheWrite(write); }).catch(function (err) {
    // never silent: a failed cache write means the NEXT launch is still stale and nobody would know
    console.error('[sw] shell cache update failed', err);
  });
  e.waitUntil(stored);   // Register during event dispatch.
  e.respondWith(
    caches.open(CACHE).then(matchShell).then(function (hit) {
      if (hit) return hit;
      // A cache MISS that also fails the network must still resolve to a Response — respondWith(undefined)
      // throws a TypeError and takes the whole request down with it. Hits the first-ever visit made offline.
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
