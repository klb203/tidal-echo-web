/* Tidal Echo — service worker (offline shell + Web Push).
   IMPORTANT: bump CACHE on every front-end change, or installed clients keep the
   old shell (the precached index.html won't refresh until the SW reinstalls). */
const AI_NAME = "DeepSeek";          // push-title fallback; keep in sync with index.html CONFIG.AI_NAME
const CACHE = "companion-v112-earfix";         // v112：一起听 —— 没填 eryu 令牌时先给一句明确引导
                                               //       （线上实测：不带令牌 eryu 回 403，
                                               //        填不填它决定这一页能不能出声）
                                               // v111：Movie 里多了「一起听」——唱片页（黑胶转着、
                                               //       歌词跟着走）+ 听歌时你们俩的留言；
                                               //       歌曲来自云服务器那两套音乐服务
                                               // v110：网关卡那 5 张外部服务的能力卡**点开直接填令牌**
                                               //       （麦当劳 / 瑞幸 / 高德 / 小红书 / 查手机）——
                                               //       原来只有一句 toast 把人送去「MCP 设置」找那张卡
                                               // v109：网关「它自己能用的」改成**能力卡**——卡片上写的是
                                               //       能力名（麦当劳 / 高德地图 / 调动微信…），不是后端工具名；
                                               //       工具名藏进卡里，点开才看
                                               // v108：侧边栏收掉四个入口（大富翁 / 自由活动 / 群聊 / 朋友圈）
                                               //       —— 它们已经是「今天」页里的卡片，从那进就行
                                               // v107：侧边栏 Movie 打开「今天」——时钟 / 日期 /
                                               //       在一起多少天（随日子涨）/ 常用入口 / 一起做 · 生活记录；
                                               //       大富翁与自由活动在这里有了卡片（原来是侧边栏的项）
                                               // v106：记忆面板导航改版——底部横滑栏 → 顶部两个 tab
                                               //       （总览 / 全部）+ 卡片网格（沿用工具能力页那套排版）；
                                               //       侧边栏的「记忆宫殿」入口并了进来
                                               // v105：修「房间」返回键点了没反应——按钮写着 data-act="back"
                                               //       但 act() 里没有这个分支；顺手把点按区从 34px 撑到 48px
                                               // v104：侧边栏顶部换成状态卡（头像与名字跟随「主题美化」，
                                               //       地点与状态由它自己写；存本机，20 分钟 + 有新对话才重写）
                                               // v103：工具能力 / 网关 / 设置 三合一（侧边栏一个入口，
                                               //       顶部栏 tab 切换）—— 原来三个整页层、三个入口
                                               // v102：档案馆只收"AI 第一人称的总结性记忆"——
                                               //       片段（工具/活动跑出来的原始素材）不再入档 / 进银河 / 归盒
                                               // v101：事件/故事/片段/工作记忆/我的房间/留给西西的话
                                               //       这六类**从界面去掉**（用户点名），内容走「从记忆库导入」
                                               // v100：记忆库分区收进「世界书」页（底部栏不再各占一张卡）
                                               //       世界书面板出错/没加载时把原因画出来（不再是一片空白）
                                               //       新增「从记忆库导入」：把分区复制成世界书条目
                                               // v99：世界书 = Lorebook（手写设定 + 命中预览 + 导入导出）
                                               //      档案馆 = 事件盒（活/灰节点可复活、压缩、封盒）
                                               //      纠正 v98 的一处理解错误：世界书**不是**"事件·摘要·故事·片段"，
                                               //      那四类是聊天里长出来的叙事，归档案馆
                                               // v98：记忆重排成六层（宫殿节点进银河与档案馆）
                                               // v97：万花筒下线（只留大富翁）· 荷官独立模型位 · 阿澈走聊天连接
                                               // v96：近景日更能覆盖了（原来从不带 force，永远只回「已有日更」）+ 秒表与预期时长
                                               // v95：MiniMax 默认音色（留空即用内置）+ 用量预算卡 + 外部工具卡（麦当劳/瑞幸）
                                               // v94：MCP 设置（传输 / 自定义头 / 每工具开关 / 状态常驻）+ 能力总览卡
                                               // v85：记忆待确认队列（机器写的不再静默生效）+ 大富翁 AI 剧情 + 牌桌记忆 + 启动层防白屏 + Kimi Code 订阅额度
                                               // v84：修「状态行无限增生 + hwm 读失败归零」（宫殿重复提取、注入稿一天一行）
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
  "./memory-pack.css", "./memory-pack.js",
  "./day-pack.css", "./day-pack.js",
  "./music-pack.css", "./music-pack.js",
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
