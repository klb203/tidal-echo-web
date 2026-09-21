/* ══════════════════════════════════════════════════════════════════════════
   cinema-pack.js · 看电影（Movie「一起做」里的那张卡片）

   你放你的片，它在旁边说 —— **每条话都绑在"放到第几秒"**上。

   为什么不做"双人同步"
   ────────────────────
   参考的 open-watch-cinema 自己也没做（README 的 "Not included" 里明写
   multi-viewer playback synchronization）。它是**单观众 + AI 伴侣**：
   观众上报播放位置，AI 只读那个位置、按游标增量说话。所以这里照它的核心做：
     · 每条留言带 media_ms；
     · 播放推进时把"到点了还没露过面"的按顺序放出来；
     · **回退 / 前跳超过阈值 → 重排，不补发**（拖完进度满屏弹幕不叫一起看）。

   它没看过这部电影
   ────────────────
   它接的是"你刚说的那句 + 现在放到第几分几秒"。界面上照这么说 ——
   假装它看完了全片，第一次对话就会露馅。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.CinemaPack) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const TICK_MS = 2000;        // 时间轴多久问一次后端（不是每帧 —— 那是在打后端）

  const S = {
    open: false,
    cfg: { url: "", title: "", last_ms: 0, autosay: true, wired: false },
    danmu: [],
    lastMs: -1,          // 本地游标：处理到哪儿了
    ms: 0,               // 当前播放位置
    dur: 0,
    playing: false,
    sheet: "",
    note: "",
    busy: "",
  };
  let elPanel = null, elVideo = null, tickTimer = null, toastTimer = null, lastAsk = 0;

  async function api(path, opt) {
    const o = Object.assign({}, opt || {});
    if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
    if (o.body) o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
    try {
      if (typeof window.memApi === "function") return await window.memApi(path, o);
    } catch (_) { }
    const r = await fetch(path, o);
    return r.json();
  }

  function mmss(msOrSec, isMs) {
    const s = Math.max(0, Math.floor(isMs ? (Number(msOrSec) || 0) / 1000 : (Number(msOrSec) || 0)));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return (h ? h + ":" + ("0" + m).slice(-2) : m) + ":" + ("0" + ss).slice(-2);
  }
  function hostName(which) {
    try {
      const h = window.__DayHost || window.__CinemaHost || {};
      const f = which === "ai" ? h.aiName : h.meName;
      const v = (typeof f === "function") ? String(f() || "").trim() : "";
      if (v) return v;
    } catch (_) { }
    return which === "ai" ? "TA" : "我";
  }

  /* ══════════════════ DOM ══════════════════════════════════════════════ */
  function ensureDom() {
    let el = document.getElementById("cinemaPanel");
    if (el) return el;
    el = document.createElement("div");
    el.className = "cn-panel hidden";
    el.id = "cinemaPanel";
    el.innerHTML =
      '<div class="cn-top">' +
        '<button class="cn-ic" type="button" data-cn="close" title="返回">‹</button>' +
        '<div class="cn-title" id="cnHead">看电影</div>' +
        '<button class="cn-ic" type="button" data-cn="sheet" title="片源">⚙</button>' +
      "</div>" +
      '<div class="cn-scroll" id="cnScroll">' +
        '<div class="cn-stage">' +
          '<div class="cn-vwrap">' +
            '<video class="cn-video" id="cnVideo" playsinline controls preload="metadata"></video>' +
            '<div class="cn-danmu" id="cnLayer"></div>' +
            '<div class="cn-empty" id="cnEmpty">还没放片子 —— 点右上 ⚙ 贴一个视频地址' +
              "（.mp4 / .m3u8 的直链都行）。</div>" +
          "</div>" +
          '<div class="cn-bar" data-cn="seek"><i id="cnFill"></i></div>' +
          '<div class="cn-times"><span id="cnPos">0:00</span><span id="cnDur">0:00</span></div>' +
          '<div class="cn-ctl">' +
            '<button class="cn-btn" type="button" data-cn="back10">« 10s</button>' +
            '<button class="cn-btn main" type="button" data-cn="toggle" id="cnToggle">▶</button>' +
            '<button class="cn-btn" type="button" data-cn="fwd10">10s »</button>' +
            '<button class="cn-btn" type="button" data-cn="say">✦ 让它说一句</button>' +
          "</div>" +
          '<div class="cn-hint" id="cnHint"></div>' +
        "</div>" +
        '<div class="cn-sec">边看边说<span class="cn-n" id="cnN"></span>' +
          '<span class="cn-sec-s">每条都记着说到第几秒</span></div>' +
        '<div class="cn-list" id="cnList"></div>' +
        '<div class="cn-compose">' +
          '<div class="cn-now" id="cnNow">说到 0:00</div>' +
          '<input class="cn-in" id="cnInput" type="text" autocomplete="off" placeholder="说点什么…">' +
          '<button class="cn-send" type="button" data-cn="send">发送</button>' +
        "</div>" +
      "</div>" +
      '<div class="cn-sheet hidden" id="cnSheet"></div>' +
      '<div class="cn-toast" id="cnToast"></div>';
    document.body.appendChild(el);
    return el;
  }
  const el = (id) => document.getElementById(id);

  function showToast(t) {
    const box = el("cnToast");
    if (box) { box.textContent = String(t || ""); box.classList.toggle("show", !!t); }
    clearTimeout(toastTimer);
    if (t) toastTimer = setTimeout(() => { if (box) box.classList.remove("show"); }, 2600);
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────────── */
  function paint() {
    if (!elPanel) return;
    const head = el("cnHead");
    if (head) head.textContent = S.cfg.title ? S.cfg.title : "看电影";
    const empty = el("cnEmpty");
    if (empty) empty.classList.toggle("hidden", !!S.cfg.url);
    const toggle = el("cnToggle");
    if (toggle) toggle.textContent = S.playing ? "❚❚" : "▶";
    const fill = el("cnFill");
    if (fill) fill.style.width = (S.dur > 0 ? Math.min(100, (S.ms / 1000 / S.dur) * 100) : 0) + "%";
    const pos = el("cnPos"), dur = el("cnDur"), now = el("cnNow");
    if (pos) pos.textContent = mmss(S.ms, true);
    if (dur) dur.textContent = S.dur > 0 ? mmss(S.dur) : "0:00";
    if (now) now.textContent = "说到 " + mmss(S.ms, true);
    paintList();
    paintSheet();
  }

  function paintList() {
    const box = el("cnList");
    const cnt = el("cnN");
    if (cnt) cnt.textContent = S.danmu.length ? " · " + S.danmu.length : "";
    if (!box) return;
    if (!S.danmu.length) {
      box.innerHTML = '<div class="cn-empty-box">还没有。放到哪儿想说什么，' +
        "写一句 —— 它会接着你说；点下面那条时间还能跳回去。</div>";
      return;
    }
    box.innerHTML = S.danmu.map((m) => {
      const mine = m.who !== "ai";
      return '<div class="cn-row' + (mine ? " me" : " ai") + '" data-cn-go="' + esc(m.id) + '">' +
        '<button class="cn-t" type="button" data-cn-jump="' + esc(m.ms) + '">' +
          esc(mmss(m.ms, true)) + "</button>" +
        '<div class="cn-x"><span class="cn-who ' + (mine ? "me" : "ai") + '">' +
          esc(mine ? hostName("me") : hostName("ai")) + "</span>" + esc(m.text) + "</div>" +
        '<button class="cn-x-del" type="button" data-cn-del="' + esc(m.id) + '" title="删掉">✕</button>' +
        "</div>";
    }).join("");
  }

  function paintSheet() {
    const box = el("cnSheet");
    if (!box) return;
    box.classList.toggle("hidden", !S.sheet);
    if (!S.sheet) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<div class="cn-sheet-h">片源<button class="cn-ic" type="button" data-cn="sheet-close">✕</button></div>' +
      '<div class="cn-sheet-b">' +
        '<div class="cn-hint-box">贴一个**能直接播**的地址（.mp4 / .webm / .m3u8 的直链）。' +
          "它没看过这部片 —— 它接的是你刚说的那句和现在放到第几秒。</div>" +
        '<label class="cn-fld"><span>片名（会用在它的话里）</span>' +
          '<input id="cnTitle" type="text" autocomplete="off" value="' + esc(S.cfg.title || "") +
          '" placeholder="比如：海边"></label>' +
        '<label class="cn-fld"><span>视频地址</span>' +
          '<input id="cnUrl" type="text" autocomplete="off" spellcheck="false" value="' +
          esc(S.cfg.url || "") + '" placeholder="https://…/movie.mp4"></label>' +
        '<label class="cn-fld row"><span>自动留言（放一会儿它自己说一句）</span>' +
          '<input id="cnAuto" type="checkbox"' + (S.cfg.autosay ? " checked" : "") + "></label>" +
        '<div class="cn-sheet-btns">' +
          '<button class="cn-btn" type="button" data-cn="cfg-save">保存并加载</button>' +
          '<button class="cn-btn ghost" type="button" data-cn="sheet-close">取消</button>' +
        "</div>" +
        (S.note ? '<div class="cn-note-box">' + esc(S.note) + "</div>" : "") +
      "</div>";
  }

  /* ══════════════ 行为 ══════════════════════════════════════════════════ */
  async function load() {
    S.busy = "load";
    try {
      const d = await api("/app/cinema/state");
      if (d && d.ok) {
        S.cfg = d.cfg || S.cfg;
        S.danmu = d.danmu || [];
        S.lastMs = -1;
        applySrc();
        paint();
      } else showToast((d && d.error) || "读不到看电影的状态");
    } catch (e) { showToast("读不到：" + ((e && e.message) || e)); }
    finally { S.busy = ""; }
  }

  /** 把片源挂到 <video> 上，并接着上次的位置。 */
  function applySrc(autoplay) {
    if (!elVideo) return;
    const want = S.cfg.url || "";
    if (!want) { S.playing = false; if (autoplay) showToast("还没贴片源"); return; }
    if (elVideo.getAttribute("src") !== want) {
      elVideo.setAttribute("src", want);
      try { elVideo.load(); } catch (_) { }
    }
    const back = Math.max(0, Number(S.cfg.last_ms || 0)) / 1000;
    if (back > 3 && Math.abs((elVideo.currentTime || 0) - back) > 3) {
      try { elVideo.currentTime = back; } catch (_) { }
      setHint("接着上次看到的地方（" + mmss(back) + "）—— 要重头看就把进度条拖到最前面。");
    }
  }

  function setHint(t) {
    const box = el("cnHint");
    if (box) box.innerHTML = t || "";
  }

  async function toggle() {
    if (!elVideo || !S.cfg.url) { S.sheet = "src"; paintSheet(); return; }
    if (elVideo.paused) {
      try { await elVideo.play(); S.playing = true; } catch (e) { showToast("放不出来：" + ((e && e.message) || e)); }
    } else { elVideo.pause(); S.playing = false; }
    paint();
  }

  function nudge(delta) {
    if (!elVideo) return;
    try { elVideo.currentTime = Math.max(0, (elVideo.currentTime || 0) + delta); } catch (_) { }
  }

  async function send() {
    const inp = el("cnInput");
    const txt = inp ? String(inp.value || "").trim() : "";
    if (!txt) { showToast("说点什么"); return; }
    if (inp) inp.value = "";
    try {
      const d = await api("/app/cinema/danmu", { method: "POST",
        body: { text: txt, ms: S.ms | 0, who: "me" } });
      if (d && d.ok && d.msg) { S.danmu.push(d.msg); paintList(); if (canSway()) sway(d.msg); }
      else showToast((d && d.error) || "没存下去");
    } catch (e) { showToast("没存下去：" + ((e && e.message) || e)); }
  }

  async function sayNow(force) {
    showToast("它正在写…");
    try {
      const d = await api("/app/cinema/say", { method: "POST",
        body: { ms: S.ms | 0, force: !!force } });
      if (d && d.ok && d.msg) {
        S.danmu.push(d.msg);
        paintList();
        if (canSway()) sway(d.msg);
        showToast("它说了一句");
      } else showToast((d && (d.skipped || d.error)) || "这次没说");
    } catch (e) { showToast("没写成：" + ((e && e.message) || e)); }
  }

  async function delOne(mid) {
    try {
      const d = await api("/app/cinema/danmu/del", { method: "POST", body: { id: mid } });
      if (d && d.ok) {
        S.danmu = S.danmu.filter((x) => String(x.id) !== String(mid));
        paintList();
      } else showToast((d && d.error) || "没删掉");
    } catch (e) { showToast("没删掉：" + ((e && e.message) || e)); }
  }

  async function saveCfg() {
    const body = {};
    if (el("cnTitle")) body.title = String(el("cnTitle").value || "").trim();
    if (el("cnUrl")) body.url = String(el("cnUrl").value || "").trim();
    if (el("cnAuto")) body.autosay = !!el("cnAuto").checked;
    S.note = "保存中…";
    paintSheet();
    try {
      const d = await api("/app/cinema/cfg", { method: "POST", body: body });
      if (d && d.ok) {
        S.cfg = d.cfg || S.cfg;
        S.sheet = ""; S.note = "";
        S.lastMs = -1;
        applySrc();
        paint();
        showToast("存好了");
      } else { S.note = (d && d.error) || "没存下去"; paintSheet(); }
    } catch (e) { S.note = "没存下去：" + ((e && e.message) || e); paintSheet(); }
  }

  /* ── 弹幕层 ───────────────────────────────────────────────────────────── */
  function canSway() {
    // 就是"那个层在不在"。原来这里还 && 了一个 S.pausedByUser ——
    // 那个字段根本没定义，等于写了个看起来有逻辑其实没有的条件。
    return !!el("cnLayer");
  }
  function sway(m) {
    const layer = el("cnLayer");
    if (!layer) return;
    const d = document.createElement("div");
    d.className = "cn-fly" + (m.who === "ai" ? " ai" : "");
    d.textContent = (m.who === "ai" ? hostName("ai") + "：" : "") + m.text;
    layer.appendChild(d);
    setTimeout(() => { try { layer.removeChild(d); } catch (_) { } }, 7200);
  }

  /* 时间轴补发：**每 TICK_MS 问一次**（不是每帧 —— 那是在打后端）。
     回退 / 前跳由后端判成 reset，这时**不补发**，只把游标挪过去。 */
  async function tick() {
    if (!S.open || !elVideo || !S.cfg.url) return;
    const now = Math.round((elVideo.currentTime || 0) * 1000);
    S.ms = now;
    const after = S.lastMs < 0 ? Math.max(0, now - 800) : S.lastMs;
    if (now === after) { paintTimes(); return; }
    try {
      const d = await api("/app/cinema/timeline?upto=" + now + "&after=" + after);
      if (d && d.ok) {
        if (d.reset) {
          // 拖进度了 —— 不补发，只把游标挪过来（拖完满屏弹幕不叫一起看）
          S.lastMs = now;
        } else {
          (d.msgs || []).forEach((m) => { if (canSway()) sway(m); });
          S.lastMs = now;
        }
      }
    } catch (_) { }
    paintTimes();
  }
  function paintTimes() {
    const pos = el("cnPos"), fill = el("cnFill"), now = el("cnNow");
    if (pos) pos.textContent = mmss(S.ms, true);
    if (now) now.textContent = "说到 " + mmss(S.ms, true);
    if (fill && S.dur > 0) fill.style.width = Math.min(100, (S.ms / 1000 / S.dur) * 100) + "%";
  }

  async function seekTo(ev) {
    if (!elVideo || !S.dur) return;
    const r = ev.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / (r.width || 1)));
    try { elVideo.currentTime = ratio * S.dur; } catch (_) { }
  }

  /* ── 事件 ─────────────────────────────────────────────────────────────── */
  function bind() {
    if (!elPanel || elPanel.dataset.bound) return;
    elPanel.dataset.bound = "1";
    elPanel.addEventListener("click", onAct);
    elPanel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target && e.target.id === "cnInput") { e.preventDefault(); send(); }
    });
    elVideo = el("cnVideo");
    if (elVideo) {
      elVideo.addEventListener("loadedmetadata", () => {
        S.dur = elVideo.duration || 0;
        paint();
      });
      elVideo.addEventListener("play", () => { S.playing = true; paint(); startTick(); });
      elVideo.addEventListener("pause", () => { S.playing = false; paint(); });
      elVideo.addEventListener("ended", () => {
        S.playing = false; paint();
        try { api("/app/cinema/cfg", { method: "POST", body: { last_ms: 0 } }); } catch (_) { }
      });
      elVideo.addEventListener("error", () => {
        setHint('<span class="cn-bad">这个地址放不出来</span> —— 多半不是能直接播的直链' +
          "（页面地址、需要登录的、或者 .m3u8 之外的流）。换个 .mp4 直链试试。");
      });
    }
  }

  function startTick() {
    clearInterval(tickTimer);
    tick();
    tickTimer = setInterval(tick, TICK_MS);
  }

  function onAct(e) {
    const t = e.target;
    const b = t && t.closest ? t.closest("[data-cn]") : null;
    if (b) {
      const k = b.dataset.cn;
      if (k === "close") { close(); return; }
      if (k === "sheet") { S.sheet = S.sheet ? "" : "src"; S.note = ""; paintSheet(); return; }
      if (k === "sheet-close") { S.sheet = ""; paintSheet(); return; }
      if (k === "cfg-save") { saveCfg(); return; }
      if (k === "toggle") { toggle(); return; }
      if (k === "back10") { nudge(-10); return; }
      if (k === "fwd10") { nudge(10); return; }
      if (k === "say") { sayNow(true); return; }
      if (k === "send") { send(); return; }
      if (k === "seek") { seekTo(e); return; }
      return;
    }
    const jump = t && t.closest ? t.closest("[data-cn-jump]") : null;
    if (jump) {
      if (elVideo) { try { elVideo.currentTime = Number(jump.dataset.cnJump) / 1000; } catch (_) { } }
      return;
    }
    const dl = t && t.closest ? t.closest("[data-cn-del]") : null;
    if (dl) { delOne(dl.dataset.cnDel); return; }
  }

  function open() {
    elPanel = ensureDom();
    bind();
    S.open = true;
    elPanel.classList.remove("hidden");
    requestAnimationFrame(() => elPanel.classList.add("open"));
    load();
  }
  function close() {
    S.open = false;
    S.sheet = "";
    clearInterval(tickTimer);
    if (elVideo) {
      // 记下看到哪了（下次接着看）
      try {
        const ms = Math.round((elVideo.currentTime || 0) * 1000);
        if (ms > 3000) api("/app/cinema/cfg", { method: "POST", body: { last_ms: ms } });
      } catch (_) { }
      try { elVideo.pause(); } catch (_) { }
    }
    S.playing = false;
    if (elPanel) {
      elPanel.classList.remove("open");
      setTimeout(() => { if (elPanel && !elPanel.classList.contains("open")) elPanel.classList.add("hidden"); }, 260);
    }
  }

  function init() {
    elPanel = ensureDom();
    bind();
    paint();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.openCinema = open;
  window.closeCinema = close;
  window.CinemaPack = {
    open: open, close: close,
    _el: () => document.getElementById("cinemaPanel"),
    _paint: paint, _load: load, _tick: tick,
    _send: send, _say: sayNow, _del: delOne, _saveCfg: saveCfg,
    _toggle: toggle, _nudge: nudge, _applySrc: applySrc,
    _mmss: mmss,
    _state: () => JSON.parse(JSON.stringify({
      cfg: S.cfg, danmu: S.danmu, ms: S.ms, dur: S.dur, playing: S.playing,
      lastMs: S.lastMs, sheet: S.sheet, note: S.note,
    })),
    _set: (p) => { Object.assign(S, p || {}); paint(); },
  };
})();
