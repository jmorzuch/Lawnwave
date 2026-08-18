/* Lawn Mower — service worker
 * Caches the app shell so the app loads and runs fully offline after the
 * first visit. The app is a single self-contained HTML file (all CSS/JS
 * inline), so caching it + the manifest + icon is enough. Weather data is
 * always fetched live from the network (it changes daily).
 */
const CACHE = "lawn-mower-v1";
const APP_SHELL = [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./icon.svg",
];

// Install: pre-cache the app shell.
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
    );
});

// Activate: drop old caches.
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Fetch: cache-first for same-origin GET requests, falling back to network
// and then to the cached index.html (so refresh loads work offline).
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // let cross-origin (weather API) use default handling

    event.respondWith(
        caches.match(req, { ignoreSearch: true }).then((cached) => {
            if (cached) return cached;
            return fetch(req)
                .then((res) => {
                    if (res && res.status === 200 && res.type === "basic") {
                        const copy = res.clone();
                        caches.open(CACHE).then((cache) => cache.put(req, copy));
                    }
                    return res;
                })
                .catch(() => caches.match("./index.html"));
        })
    );
});
