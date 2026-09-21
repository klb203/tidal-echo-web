/* ══════════════════════════════════════════════════════════════════════════
   day-pack.js · 「今天」（侧边栏 Movie 打开的那一页）

   一屏看今天：时钟 · 日期 · 在一起多少天 · 五个常用入口 · 一起做 / 生活记录。

   ── 两条纪律 ────────────────────────────────────────────────────────────
   ① **名字与天数不在这里算**。它们来自宿主注入点 window.__DayHost ——
      那背后是 index.html 里唯一那一份（applyRemark 的名字、daysTogether 的天数）。
      这里只做兜底（取不到就 TA / 我 / 0 天），绝不另存一份；
      否则「主题美化改了名字、这一页不变」那种坏法又会冒出来。
   ② **每个按钮都必须接上一个真实存在的功能**。接不上就明说"还没加载好"，
      不静默 —— 用户上次报的"点了没反应"就是这一类（按钮在、没人接）。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.DayPack) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const pad2 = (n) => ("0" + n).slice(-2);

  /* ── 跟宿主取那一份（唯一的真源）──────────────────────────────────── */
  function G() {
    let g = null;
    try { g = (typeof window !== "undefined") ? window.__DayHost : null; } catch (_) { g = null; }
    return g || {};
  }
  function call1(name, fallback) {
    try {
      const f = G()[name];
      const v = (typeof f === "function") ? f() : null;
      const s = String(v == null ? "" : v).trim();
      return s || fallback;
    } catch (_) { return fallback; }
  }
  const aiName = () => call1("aiName", "TA");
  const meName = () => call1("meName", "我");
  const days = () => { const n = parseInt(call1("days", "0"), 10); return Number.isFinite(n) ? n : 0; };
  const since = () => call1("since", "");

  /* ── 三行抬头 ──────────────────────────────────────────────────────── */
  function clockText(d) {
    const t = d || new Date();
    return pad2(t.getHours()) + ":" + pad2(t.getMinutes());
  }
  function dateText(d) {
    const t = d || new Date();
    return (t.getMonth() + 1) + "月" + t.getDate() + "日 " + WEEK[t.getDay()];
  }
  /* 「阿澈和西西在一起的 71 天」—— 天数随日子涨（不是存下来的数字） */
  function togetherText() {
    return aiName() + "和" + meName() + "在一起的 " + days() + " 天";
  }
  function sinceText() {
    const s = since();
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
    return m ? ("since " + m[1] + "." + pad2(+m[2]) + "." + pad2(+m[3])) : "";
  }

  /* ── 每个按钮接什么 ─────────────────────────────────────────────────
     ★ 这张表就是"动作覆盖"的唯一来源：HTML 里 data-day 的每个值都必须在这里，
       smoke-day.js 会拿两边的集合做差（少了就是"点了没反应"）。
     · 前三项（memory / palace 这种 index.html 里的局部函数）走宿主注入的 local，
       其余（room / rp / album…）是各 pack 挂在 window 上的。
     · tab 是"打开之后还要切到哪一页"（room 那几项要，别的不用）。 */
  const ACTIONS = {
    memory:   { label: "记忆",       fn: "memory",   local: true },
    mood:     { label: "心情",       fn: "openRoom", tab: "status" },
    diary:    { label: "日记",       fn: "openRoom", tab: "diary" },
    dream:    { label: "梦境",       fn: "openRoom", tab: "dream" },
    play:     { label: "大富翁",     fn: "openRp" },
    mono:     { label: "大富翁",     fn: "openRp" },
    activity: { label: "自由活动",   fn: "openActivity" },
    group:    { label: "群聊",       fn: "openGroupChat" },
    album:    { label: "一起看",     fn: "openAlbum" },
    ear:      { label: "一起听",     fn: "openEar" },
    letter:   { label: "信箱",       fn: "openLetter" },
    read:     { label: "共读",       fn: "openRead" },
    palace:   { label: "记忆宫殿",   fn: "palace",   local: true },
    room:     { label: "我们的房间", fn: "openRoom" },
    moments:  { label: "朋友圈",     fn: "openMoments" },
  };
  function resolve(name, isLocal) {
    const g = G();
    if (isLocal) {
      const f = g.local && g.local[name];
      return (typeof f === "function") ? f : null;
    }
    try { return (typeof window[name] === "function") ? window[name] : null; } catch (_) { return null; }
  }

  /* ══════════════ DOM ═══════════════════════════════════════════════ */
  const QUICK = [
    { k: "memory", ic: "◈", n: "记忆" },
    { k: "mood",   ic: "☺", n: "心情" },
    { k: "diary",  ic: "▤", n: "日记" },
    { k: "dream",  ic: "☾", n: "梦境" },
    { k: "play",   ic: "◲", n: "Play" },
  ];
  const SECTIONS = [
    { t: "一起做", rows: [
      { k: "mono",     ic: "⚄", n: "大富翁" },
      { k: "activity", ic: "✧", n: "自由活动" },
      { k: "group",    ic: "⬡", n: "群聊" },
      { k: "ear",      ic: "♪", n: "一起听" },
      { k: "read",     ic: "❋", n: "共读" },
      { k: "album",    ic: "▢", n: "一起看" },
    ] },
    { t: "生活记录", rows: [
      { k: "palace",  ic: "⌂", n: "记忆宫殿" },
      { k: "room",    ic: "⌘", n: "我们的房间" },
      { k: "moments", ic: "◍", n: "朋友圈" },
      { k: "letter",  ic: "✉", n: "信箱" },
    ] },
  ];
  const PANEL_HTML =
    '<div class="dp-scroll">' +
      '<div class="dp-head">' +
        '<div class="dp-clock" id="dpClock">--:--</div>' +
        '<div class="dp-date" id="dpDate"></div>' +
        '<div class="dp-together" id="dpTogether"></div>' +
      '</div>' +
      '<div class="dp-quick">' +
        QUICK.map((q) =>
          '<button class="dp-q" type="button" data-day="' + q.k + '">' +
            '<span class="dp-qi">' + q.ic + "</span>" +
            '<span class="dp-qt">' + esc(q.n) + "</span>" +
          "</button>").join("") +
      "</div>" +
      SECTIONS.map((s) =>
        '<div class="dp-sec">' + esc(s.t) + "</div>" +
        '<div class="dp-list">' +
          s.rows.map((r) =>
            '<button class="dp-row" type="button" data-day="' + r.k + '">' +
              '<span class="dp-ri">' + r.ic + "</span>" +
              '<span class="dp-rn">' + esc(r.n) + "</span>" +
              '<span class="dp-rchev">›</span>' +
            "</button>").join("") +
        "</div>").join("") +
    "</div>" +
    '<button class="dp-close" id="dpClose" type="button" aria-label="关闭">✕</button>' +
    '<div class="dp-toast" id="dpToast"></div>';

  let elPanel = null, elToast = null, toastTimer = 0, clockTimer = 0, closeTimer = 0;

  function ensureDom() {
    let el = document.getElementById("dayPanel");
    if (el) return el;
    el = document.createElement("div");
    el.className = "dp-panel hidden";
    el.id = "dayPanel";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "今天");
    el.innerHTML = PANEL_HTML;
    document.body.appendChild(el);
    return el;
  }
  function toast(m) {
    if (!elToast) return;
    elToast.textContent = m;
    elToast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elToast.classList.remove("on"), 2400);
  }

  /* ── 画那三行 ─────────────────────────────────────────────────────── */
  function paint() {
    const c = $("#dpClock"); if (c) c.textContent = clockText();
    const d = $("#dpDate"); if (d) d.textContent = dateText();
    const t = $("#dpTogether");
    if (t) {
      const s = sinceText();
      t.innerHTML = esc(togetherText()) + (s ? '<span class="dp-since">' + esc(s) + "</span>" : "");
    }
  }

  /* ── 点一下 ───────────────────────────────────────────────────────── */
  function act(kind) {
    const a = ACTIONS[kind];
    if (!a) { toast("这一项还没接上"); return; }          // 理论上到不了：smoke 会盯住两边集合
    const fn = resolve(a.fn, a.local);
    if (!fn) { toast(a.label + " 还没加载好，刷新一下页面"); return; }
    close();
    setTimeout(() => {
      try {
        fn();
        if (a.tab && window.RoomPack && typeof window.RoomPack._go === "function") {
          setTimeout(() => { try { window.RoomPack._go(a.tab); } catch (_) { } }, 420);
        }
      } catch (e) {
        toast("打不开" + a.label + "：" + ((e && e.message) || e));
      }
    }, 200);
  }

  function bind() {
    elPanel.addEventListener("click", (e) => {
      if (e.target.closest("#dpClose")) { close(); return; }
      const b = e.target.closest("[data-day]");
      if (b) act(b.dataset.day);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!elPanel || elPanel.classList.contains("hidden")) return;
      close();
      e.stopPropagation();
    }, true);
  }

  /* ── 开 / 关 ──────────────────────────────────────────────────────── */
  async function open() {
    ensureDom();
    elToast = $("#dpToast", elPanel);
    paint();
    clearTimeout(closeTimer);
    elPanel.classList.remove("hidden");
    requestAnimationFrame(() => elPanel.classList.add("open"));
    clearInterval(clockTimer);
    /* 时钟走一格 —— 只在面板开着时算（关掉就停，不做无用的定时器） */
    clockTimer = setInterval(() => {
      if (!elPanel || elPanel.classList.contains("hidden")) return;
      const c = $("#dpClock"); if (c) c.textContent = clockText();
      const d = $("#dpDate"); if (d) d.textContent = dateText();
    }, 30000);
  }
  function close() {
    if (!elPanel) return;
    elPanel.classList.remove("open");
    clearInterval(clockTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (elPanel && !elPanel.classList.contains("open")) elPanel.classList.add("hidden");
    }, 260);
  }

  function init() {
    elPanel = ensureDom();
    elToast = $("#dpToast", elPanel);
    bind();
    paint();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.openDay = open;
  window.closeDay = close;
  window.DayPack = {
    open: open, close: close,
    _paint: paint,
    _clock: clockText,
    _date: dateText,
    _together: togetherText,
    _since: sinceText,
    _actions: () => Object.keys(ACTIONS).map((k) => ({ k: k, label: ACTIONS[k].label, fn: ACTIONS[k].fn })),
    _act: (k) => act(k),
    _el: () => document.getElementById("dayPanel"),
  };
})();
