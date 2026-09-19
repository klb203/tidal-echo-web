/* Tidal Echo — service worker (offline shell + Web Push).
   IMPORTANT: bump CACHE on every front-end change, or installed clients keep the
   old shell (the precached index.html won't refresh until the SW reinstalls). */
const AI_NAME = "DeepSeek";          // push-title fallback; keep in sync with index.html CONFIG.AI_NAME
const CACHE = "companion-v82-fragments";         // v82：记忆库第 8 个分区「片段」—— 时间线碎片自动组装成小记忆（时间线页加「组装成片段」）  // v81：Memory 加「时间线 · 一个它」页
const PRECACHE = [
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.png",
  "./apple-touch-icon.png",
  "./icon-192.png", "./icon-512.png",
  "./chat-light.webp", "./chat-harbor.webp",
  "./menu-light.webp", "./menu-harbor.webp",
  "./avatar-sea.png",
  "./send.mp3",
  "./chat-pink.png", "./chat-dark.png",
  "./mascot-raccoon.png",
  "./group-chat-pack.css", "./group-chat-pack.js",
  "./rp-channel-pack.css", "./rp-channel-pack.js",
  "./activity-pack.css", "./activity-pack.js",
  "./media-store.js",
  "./album-pack.css", "./album-pack.js",
  "./room-pack.css", "./room-pack.js",
  "./moments-pack.css", "./moments-pack.js",
  "./choice-pack.css", "./choice-pack.js", "./mascot-ask.png",
  "./topic-pack.css", "./topic-pack.js", "./mascot-topic.png",
  "./ghost-pack.css", "./ghost-pack.js",
  "./wander-pack.css", "./wander-pack.js",
  "./mcp-pack.css", "./mcp-pack.js",
  "./clock-pack.css", "./clock-pack.js",
  "./tides.html",
];

/* 逐个 put，而不是 addAll：addAll 是「全有全无」—— 只要有一条 404
   （比如某个主题图没传上去），整批预缓存就全废，而且会被 catch 吞掉，
   表现是「离线打不开 / 装到主屏后壁纸全是空的」。逐条兜底就只丢那一条。 */
function precache() {
  return caches.open(CACHE).then((c) => Promise.all(
    PRECACHE.map((u) =>
      fetch(new Request(u, { cache: "reload" }))
        .then((res) => { if (res && (res.ok || res.type === "opaque")) return c.put(u, res); })
        .catch(() => {})                       // 单条失败不影响其余
    )
  ));
}

self.addEventListener("install", (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;                     // 只处理 GET
  if (url.origin !== location.origin) return;                 // 跨域（后端 / CDN）一律放行不缓存
  if (url.pathname.startsWith("/relay/")) return;             // never intercept the API / SSE
  if (url.pathname.endsWith("/sw.js")) return;                // 别把 SW 自己塞进缓存
  if (e.request.mode === "navigate") {
    // network-first for the page → an online reload always gets the latest index.html
    e.respondWith(fetch(e.request, { cache: "reload" }).catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((r) => {
      if (r) return r;
      return fetch(e.request).then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});

// ── Web Push (VAPID) ──────────────────────────────
// The relay sends a push when the AI replies and no PWA tab is holding the stream;
// here we surface it on the lock screen.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { body: (e.data && e.data.text && e.data.text()) || "" }; }
  const title = d.title || AI_NAME;                        // backend sends RELAY_AI_NAME as title
  const body  = d.body  || "你有一条新消息";
  const tag   = d.id ? ("companion-" + d.id) : "companion-msg";
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon:  "./icon-192.png",
      badge: "./icon-192.png",
      vibrate: [80, 40, 80],
      data: { url: d.url || "./" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    // matchAll only returns clients this SW controls (our own scope), so focus the first one.
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
      for (const c of cls) {
        if ("focus" in c){ c.postMessage({ type: "backfill" }); return c.focus(); }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : null;
    })
  );
});
