/* Lawn Mower — service worker v2
 * Caches the app shell so the app loads and runs fully offline after the
 * first visit. The app is a single self-contained HTML file (all CSS/JS
 * inline), so caching it + manifest + icon is enough for the UI itself.
 *
 * Weather data: fetched live by the page, but ALSO cached in localStorage
 * as "lawnMower.weather.v2" — when the phone is offline the page falls back
 * to that cache and labels the section as stale/offline.
 *
 * Daily digest: the page registers a Background Sync task ("lawnwave-daily").
 * On Android/Chrome it fires periodically with the app closed; elsewhere it
 * fires on reconnect / app open. We send at most one notification per ~12h,
 * sharing that throttle with the page-side fallback via localStorage.
 */
const CACHE = "lawn-mower-v13"; // bump on every index.html change (v13: full-page OAuth redirect + PKCE replaces broken GSI popup; new auth.html callback)
const APP_SHELL = [
    "./",
    "./index.html",
    "./auth.html",
    "./manifest.webmanifest",
    "./icon.svg",
];

// Install: pre-cache the app shell, then activate immediately so users get the
// new version without a double-tap reload.
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

    // Never cache this worker's OWN script. Chrome re-requests sw.js on every app open to
    // check for a newer version — if we answer from cache, the phone stays pinned at whatever
    // version first got here (this is exactly what kept v6 out of Joe's S25). Let those go network-direct.
    if (req.destination === "script" || url.pathname.endsWith("/sw.js")) return;

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

/* ============================================================
 *  Background sync — the daily mowing digest.
 *  Runs with the app CLOSED (Android: periodically; other browsers:
 *  when it reconnects or a client opens). At most one notification
 *  per ~12h, throttled via localStorage shared with the page.
 * ============================================================ */
const LS_WX = "lawnMower.weather.v2";
const LS_CUTS = "lawnMower.lastCut.v1";
const LS_ALERTS = "lawnMower.alerts.v1";
const LS_NOTED = "lawnMower.alerts.lastNote";
var PROPS = [ // keep in sync with index.html's PROPERTIES (names only)
    { id: "osha", name: "Osha's House" },
    { id: "mine", name: "My House" },
    { id: "hoa", name: "HOA Property" },
];

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

// Score a single day: higher = better for mowing. Mirrors the page's scoreDay
// so the digest agrees with what the app shows.
function scoreDay(day) {
    var rain = (day.precipitation_probability_max == null) ? 0 : day.precipitation_probability_max;
    var precipSum = (day.precipitation_sum == null) ? 0 : day.precipitation_sum;
    var temp = (((day.temperature_2m_max != null ? day.temperature_2m_max : 75)) + (day.temperature_2m_min != null ? day.temperature_2m_min : 65)) / 2;
    var rainScore = 100 - rain;
    rainScore -= Math.min(30, precipSum * 4);
    var tempDist = Math.abs(temp - 72);
    var tempScore = Math.max(0, 100 - tempDist * 3.2);
    return { score: rainScore * 0.65 + tempScore * 0.35, rain: rain, temp: temp };
}

function buildDigest() {
    // Best mowing day from the cached forecast (the page refreshes it whenever
    // online; if we're offline this is whatever was last fetched — fine for a
    // daily nudge, and the page labels stale data in its UI).
    var bestLine = "Best mowing day unknown — open Lawnwave to refresh";
    try {
        var env = JSON.parse(lsGet(LS_WX));
        if (env && Array.isArray(env.days) && env.days.length) {
            var bi = 0, bs = -Infinity;
            env.days.forEach(function (d, i) {
                var s = scoreDay(d).score;
                if (s > bs) { bs = s; bi = i; }
            });
            var b = env.days[bi];
            var info = scoreDay(b);
            var name = new Date(b.date + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
            bestLine = name + " is your best mowing day (rain " + info.rain + "%, ~" + Math.round(info.temp) + "\u00B0F)";
        }
    } catch (e) { /* no cached forecast yet */ }

    // Most overdue / never-cut property. Never-cut outranks any count; the
    // highest days-since-last-cut wins otherwise.
    var cuts = {};
    try { cuts = JSON.parse(lsGet(LS_CUTS)) || {}; } catch (e) { cuts = {}; }
    var worstName = null, worstDays = -1, worstNever = false;
    PROPS.forEach(function (p) {
        var raw = cuts[p.id];
        var arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        var lastTs = arr.length ? Math.max.apply(null, arr.filter(function (t) { return typeof t === "number" && isFinite(t) && t > 0; })) : null;
        var days = lastTs ? Math.floor((Date.now() - lastTs) / 86400000) : null;
        if (days === null) {
            worstNever = true;
            worstName = p.name; // keep the first never-cut one seen
        } else if (!worstNever && days > worstDays) {
            worstDays = days;
            worstName = p.name;
        }
    });

    var dueLine = "All lawns fresh — no cuts due";
    if (worstNever) {
        dueLine = worstName + " has never been cut";
    } else if (worstDays >= 8) {
        dueLine = worstName + " is " + worstDays + " days since last cut" + (worstDays > 12 ? " — overdue" : "");
    }

    return { title: "Lawnwave daily", body: bestLine + " \u00B7 " + dueLine };
}

self.addEventListener("sync", function (event) {
    if (event.tag !== "lawnwave-daily") return; // ignore unrelated sync tasks
    event.waitUntil(
        (function () {
            // Throttle: one digest per ~12h (same key the page's fallback uses).
            var last = parseInt(lsGet(LS_NOTED), 10) || 0;
            if (Date.now() - last < 43200000) return Promise.resolve(null);
            // Only nag when the user asked for alerts.
            var prefs = {};
            try { prefs = JSON.parse(lsGet(LS_ALERTS)) || {}; } catch (e) { prefs = {}; }
            if (!prefs.enabled) return Promise.resolve(null);
            lsSet(LS_NOTED, String(Date.now()));
            var d = buildDigest();
            return self.registration.showNotification(d.title, {
                body: d.body, icon: "icon.svg", tag: "lawnwave-daily", requireInteraction: false,
            });
        })()
    );
});
