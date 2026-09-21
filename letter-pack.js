/* ══════════════════════════════════════════════════════════════════════════
   letter-pack.js · 信箱（Movie「一起做」里的那张卡片）

   一页信：它写给你的、你写给它的，都能留着；看完能真的**寄到你的邮箱**。

   三件事说清楚
   ────────────
   ① **信不是聊天**。它写信用的是同一条"让它说一句"的链路（deliver_it=False），
      落在这里，不往会话里发 —— 所以信可以长、可以留、可以回头看。
   ② **授权码在「设置」里填**。填的是 QQ 邮箱的**授权码**，不是登录密码
      （最常见的失败就是填成了登录密码）。填了之后能"测试连接"，错了会说出原因。
   ③ **乌有乡的明信片在这一栏里**。密钥和地址直接在这儿填（不必绕去网关卡），
      填完握一次手，明信片就列出来了。它的"字是它写的，邮戳是世界的" ——
      地点、当地时间、天气、海拔都是乌有乡给的，不是模型编的。
      取明信片要打到你那台服务器上，所以是**打开这一栏之后**才去取的，不拖慢整页。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.LetterPack) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const TABS = [
    { k: "all", n: "全部" },
    { k: "ai", n: "它写的" },
    { k: "me", n: "我写的" },
    { k: "nowhere", n: "乌有乡" },
  ];

  const S = {
    open: false,
    tab: "all",
    letters: [],
    unread: 0,
    cur: null,          // 打开的那封（含正文）
    mail: {},
    cards: {},          // 乌有乡：明信片与连接状态
    nw: null,           // 乌有乡的凭据设置（打开设置面板时才去取）
    nwBusy: "",
    sheet: "",          // "" | "write" | "cfg" | "nw"
    busy: "",
    note: "",
  };
  let elPanel = null, toastTimer = null;

  async function api(path, opt) {
    const o = Object.assign({}, opt || {});
    if (o.body && typeof o.body !== "string") o.body = JSON.stringify(o.body);
    if (o.body) o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
    try {
      if (typeof window.memApi === "function") return await window.memApi(path, o);
    } catch (_) { }
    const r = await fetch(path, o);
    return r.json();
  }

  function ago(ts) {
    if (!ts) return "";
    const d = Math.max(0, Date.now() / 1000 - Number(ts));
    if (d < 60) return "刚刚";
    if (d < 3600) return Math.floor(d / 60) + " 分钟前";
    if (d < 86400) return Math.floor(d / 3600) + " 小时前";
    if (d < 86400 * 30) return Math.floor(d / 86400) + " 天前";
    return Math.floor(d / 86400 / 30) + " 个月前";
  }
  function whoName(w) {
    if (w === "ai") return hostName("ai");
    if (w === "nowhere") return "乌有乡";
    return hostName("me");
  }
  function hostName(which) {
    try {
      const h = window.__DayHost || window.__LetterHost || {};
      const f = which === "ai" ? h.aiName : h.meName;
      const v = (typeof f === "function") ? String(f() || "").trim() : "";
      if (v) return v;
    } catch (_) { }
    return which === "ai" ? "TA" : "我";
  }

  /* ══════════════════ DOM ══════════════════════════════════════════════ */
  function ensureDom() {
    let el = document.getElementById("letterPanel");
    if (el) return el;
    el = document.createElement("div");
    el.className = "lt-panel hidden";
    el.id = "letterPanel";
    el.innerHTML =
      '<div class="lt-top">' +
        '<button class="lt-ic" type="button" data-lt="close" title="返回">‹</button>' +
        '<div class="lt-title">信箱</div>' +
        '<button class="lt-ic" type="button" data-lt="write" title="写一封">✎</button>' +
        '<button class="lt-ic" type="button" data-lt="cfg" title="设置">⚙</button>' +
      "</div>" +
      '<div class="lt-tabs" id="ltTabs">' +
        TABS.map((t) => '<button class="lt-tab" type="button" data-lt-tab="' + t.k + '">' +
                        esc(t.n) + "</button>").join("") +
      "</div>" +
      '<div class="lt-scroll" id="ltScroll">' +
        '<div class="lt-list" id="ltList"></div>' +
      "</div>" +
      '<div class="lt-bottom">' +
        '<button class="lt-btn" type="button" data-lt="ai">✦ 让它写一封</button>' +
        '<button class="lt-btn" type="button" data-lt="write">✎ 我写一封</button>' +
      "</div>" +
      '<div class="lt-sheet hidden" id="ltSheet"></div>' +
      '<div class="lt-toast" id="ltToast"></div>';
    document.body.appendChild(el);
    return el;
  }
  const el = (id) => document.getElementById(id);

  function showToast(t) {
    const box = el("ltToast");
    if (box) { box.textContent = String(t || ""); box.classList.toggle("show", !!t); }
    clearTimeout(toastTimer);
    if (t) toastTimer = setTimeout(() => { if (box) box.classList.remove("show"); }, 2600);
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────────── */
  function paint() {
    if (!elPanel) return;
    const tabs = el("ltTabs");
    if (tabs) {
      Array.prototype.forEach.call(tabs.querySelectorAll("[data-lt-tab]"), (b) => {
        b.classList.toggle("on", b.dataset.ltTab === S.tab);
      });
    }
    paintList();
    paintSheet();
  }

  function paintList() {
    const box = el("ltList");
    if (!box) return;
    if (S.tab === "nowhere") { paintCards(box); return; }
    if (S.cur) { paintOne(box); return; }

    let list = S.letters || [];
    if (S.tab === "ai") list = list.filter((x) => x.who === "ai");
    if (S.tab === "me") list = list.filter((x) => x.who === "me");
    if (!list.length) {
      box.innerHTML = '<div class="lt-empty">' +
        (S.busy ? "读信…" : "还没有信。点下面「让它写一封」，或者自己写一封。") + "</div>";
      return;
    }
    const total = list.length;
    const head = '<div class="lt-count">' + total + " 封" +
      (S.unread ? ' · <b>' + S.unread + " 封未读</b>" : "") + "</div>";
    box.innerHTML = head + list.map((L) =>
      '<button class="lt-item' + (L.read ? "" : " unread") + '" type="button" ' +
        'data-lt-open="' + esc(L.id) + '">' +
        '<div class="lt-i-h"><span class="lt-i-from">' + esc(whoName(L.who)) + "</span>" +
        '<span class="lt-i-t">' + esc(ago(L.ts)) + "</span></div>" +
        '<div class="lt-i-title">' + (L.read ? "" : '<i class="lt-dot"></i>') +
          esc(L.title) + "</div>" +
        '<div class="lt-i-x">' + esc(L.excerpt || "") + "</div>" +
        (L.delivered ? '<div class="lt-i-sent">已寄出</div>' : "") +
      "</button>").join("");
  }

  function paintOne(box) {
    const L = S.cur || {};
    let h = '<div class="lt-one">' +
      '<div class="lt-one-h">' +
        '<button class="lt-ic" type="button" data-lt="back">‹</button>' +
        '<div class="lt-one-t"><div class="lt-one-title">' + esc(L.title) + "</div>" +
        '<div class="lt-one-s">' + esc(whoName(L.who)) + " · " + esc(L.at || ago(L.ts)) +
        (L.delivered ? " · 已寄出" : "") + "</div></div>" +
      "</div>" +
      '<div class="lt-body">' + esc(L.body || "").replace(/\n/g, "<br>") + "</div>" +
      '<div class="lt-one-btns">' +
        '<button class="lt-btn" type="button" data-lt="send">✉ 寄到我的邮箱</button>' +
        '<button class="lt-btn ghost" type="button" data-lt="del">删掉</button>' +
      "</div>" +
      (S.note ? '<div class="lt-note">' + esc(S.note) + "</div>" : "") +
      "</div>";
    box.innerHTML = h;
  }

  /* 地表 / 昼夜 → 人话。认不出来的原样显示，不吞掉 */
  const SURFACE = { forest: "林地", grass: "草地", city: "城市", town: "城镇",
                    water: "水面", sea: "海面", desert: "荒漠", mountain: "山地",
                    snow: "雪地", farm: "田野", rock: "岩地" };
  const PHASE = { day: "白天", night: "夜里", dusk: "黄昏", dawn: "黎明" };

  function cardStamp(c) {
    const bits = [];
    if (c.elevation != null) bits.push(Math.round(c.elevation) + " m");
    if (c.weather) bits.push(c.weather + (c.temp_c != null ? " " + c.temp_c + "°C" : ""));
    if (c.surface) bits.push(SURFACE[c.surface] || c.surface);
    if (c.phase) bits.push(PHASE[c.phase] || c.phase);
    return bits.join(" · ");
  }

  function cardHtml(c) {
    const st = cardStamp(c);
    return '<div class="lt-pc">' +
      '<div class="lt-pc-h">' +
        '<span class="lt-pc-place">' + esc(c.place || "远方") + "</span>" +
        '<span class="lt-pc-time">' + esc(c.time || "") + "</span>" +
      "</div>" +
      '<div class="lt-pc-t">' + esc(c.text || "") + "</div>" +
      (st || c.tz ? '<div class="lt-pc-stamp">' + esc(st) +
        (c.tz ? (st ? " · " : "") + esc(c.tz) : "") + "</div>" : "") +
      "</div>";
  }

  function paintCards(box) {
    const c = S.cards || {};
    let h = '<div class="lt-bar">' +
      '<span class="lt-count">明信片' + (c.total ? "（" + c.total + "）" : "") + "</span>" +
      '<span class="lt-bar-b">' +
        '<button class="lt-btn ghost sm" type="button" data-lt="nw-cfg">密钥</button>' +
        '<button class="lt-btn ghost sm" type="button" data-lt="pc-reload">刷新</button>' +
      "</span></div>";
    if (S.nwBusy === "cards") {
      h += '<div class="lt-empty">正在取…</div>';
    } else if (!c.ok) {
      h += '<div class="lt-empty">' + esc(c.note || "还没接上乌有乡") + "</div>";
      h += '<div class="lt-sheet-btns">' +
        '<button class="lt-btn" type="button" data-lt="nw-cfg">填地址和密钥</button>' +
        "</div>";
    } else if (!(c.cards || []).length) {
      h += '<div class="lt-empty">' + esc(c.note || "还没有明信片") + "</div>";
    } else {
      h += (c.cards || []).map(cardHtml).join("");
    }
    if (c.ok) {
      h += '<div class="lt-sheet-btns">' +
        '<button class="lt-btn" type="button" data-lt="pc-send">✈ 让它出门，寄一张回来</button>' +
        "</div>";
    }
    box.innerHTML = h;
  }

  function paintSheet() {
    const box = el("ltSheet");
    if (!box) return;
    box.classList.toggle("hidden", !S.sheet);
    if (!S.sheet) { box.innerHTML = ""; return; }
    if (S.sheet === "write") {
      box.innerHTML =
        '<div class="lt-sheet-h">写一封<button class="lt-ic" type="button" data-lt="sheet-close">✕</button></div>' +
        '<div class="lt-sheet-b">' +
          '<div class="lt-hint">第一行当标题，空一行，后面是正文。</div>' +
          '<textarea class="lt-ta" id="ltWrite" placeholder="今晚的风&#10;&#10;今天路过那家店，想起来你说过想吃里面的东西。"></textarea>' +
          '<div class="lt-sheet-btns">' +
            '<button class="lt-btn" type="button" data-lt="save">收进信箱</button>' +
            '<button class="lt-btn ghost" type="button" data-lt="sheet-close">取消</button>' +
          "</div>" +
        "</div>";
      return;
    }
    if (S.sheet === "nw") {
      const n = S.nw || {};
      box.innerHTML =
        '<div class="lt-sheet-h">乌有乡<button class="lt-ic" type="button" data-lt="sheet-close">✕</button></div>' +
        '<div class="lt-sheet-b">' +
          (S.note ? '<div class="lt-sheet-note">' + esc(S.note) + "</div>" : "") +
          (n.note && !n.ok ? '<div class="lt-sheet-note">' + esc(n.note) + "</div>" : "") +
          '<label class="lt-fld"><span>MCP 地址' +
            (n.url_locked ? "（这项由服务方定）" : "") + "</span>" +
            '<input id="nwUrl" type="text" autocomplete="off" spellcheck="false" ' +
            (n.url_locked ? "readonly " : "") +
            'value="' + esc(n.url || "") + '" placeholder="' +
            esc(n.url_hint || "https://你的域名/mcp/sse") + '"></label>' +
          '<label class="lt-fld"><span>' + esc(n.token_label || "访问密钥") +
            (n.has_token ? "（已填，留空 = 不改）" : "") + "</span>" +
            '<input id="nwKey" type="password" autocomplete="off" spellcheck="false" placeholder="' +
            esc(n.has_token ? "留空 = 不改" : "X-Nowhere-Key") + '"></label>' +
          (n.token_hint ? '<div class="lt-sheet-note">' + esc(n.token_hint) + "</div>" : "") +
          '<div class="lt-sheet-note">传输方式用 <b>SSE</b>（乌有乡就是这么起的）—— ' +
            "保存时会自动带上，不用你选。</div>" +
          '<div class="lt-sheet-btns">' +
            '<button class="lt-btn" type="button" data-lt="nw-save">保存</button>' +
            '<button class="lt-btn ghost" type="button" data-lt="nw-probe">保存并握手</button>' +
          "</div>" +
        "</div>";
      return;
    }
    const m = S.mail || {};
    box.innerHTML =
      '<div class="lt-sheet-h">投递设置<button class="lt-ic" type="button" data-lt="sheet-close">✕</button></div>' +
      '<div class="lt-sheet-b">' +
        '<div class="lt-hint">' + (m.ready ? "已经配好了。" : "还没配好 —— 填完点「测试连接」。") + "</div>" +
        '<label class="lt-fld"><span>发件邮箱（QQ 邮箱地址）</span>' +
          '<input id="ltFrom" type="text" autocomplete="off" spellcheck="false" value="' +
          esc(m.from || "") + '" placeholder="你的QQ号@qq.com"></label>' +
        '<label class="lt-fld"><span>授权码' +
          (m.has_code ? "（已填，留空 = 不改）" : "（不是登录密码）") + "</span>" +
          '<input id="ltCode" type="password" autocomplete="off" spellcheck="false" placeholder="' +
          (m.has_code ? "留空 = 不改" : "在 QQ 邮箱设置 → 账户 里生成") + '"></label>' +
        '<label class="lt-fld"><span>收件邮箱（留空 = 寄给自己）</span>' +
          '<input id="ltTo" type="text" autocomplete="off" spellcheck="false" value="' +
          esc(m.to || "") + '" placeholder="留空就寄到发件邮箱"></label>' +
        '<label class="lt-fld"><span>SMTP 服务器</span>' +
          '<input id="ltHost" type="text" autocomplete="off" spellcheck="false" value="' +
          esc(m.host || "smtp.qq.com") + '"></label>' +
        '<div class="lt-sheet-note">授权码在 QQ 邮箱网页版 → 设置 → 账户 → ' +
          "「IMAP/SMTP 服务」里开一下并生成。它等同密码，所以只存在你自己的后端里。</div>" +
        '<div class="lt-sheet-btns">' +
          '<button class="lt-btn" type="button" data-lt="mail-save">保存</button>' +
          '<button class="lt-btn ghost" type="button" data-lt="mail-probe">测试连接</button>' +
        "</div>" +
        (S.note ? '<div class="lt-note">' + esc(S.note) + "</div>" : "") +
      "</div>";
  }

  /* ══════════════════ 行为 ══════════════════════════════════════════════ */
  /** 取明信片。**只有切到这一栏 / 手动刷新时才调** —— 它要打到你那台云服务器上，
      放进 load() 会让每次打开信箱都白等一次。 */
  async function loadCards() {
    S.nwBusy = "cards";
    paintList();
    try {
      const d = await api("/app/letter/postcards");
      if (d) S.cards = d;
    } catch (e) {
      S.cards = { ok: false, wired: false, cards: [],
                  note: "取不到明信片：" + ((e && e.message) || e) };
    } finally { S.nwBusy = ""; paintList(); }
  }

  /** 打开「乌有乡设置」：去读那一项的凭据描述（标签、提示语都由后端给，前端不抄）。 */
  async function nwOpen() {
    S.sheet = S.sheet === "nw" ? "" : "nw";
    S.note = "";
    if (S.sheet === "nw" && !S.nw) {
      S.note = "读取设置…";
      paintSheet();
      try {
        const d = await api("/app/extools/keys");
        const list = (d && d.creds) || [];
        S.nw = list.filter((x) => x && x.key === "nowhere")[0] || {};
        if (!Object.keys(S.nw).length) S.nw = { ok: false, note: "后端没给出乌有乡这一项" };
      } catch (e) {
        S.nw = { ok: false, note: "读不到设置：" + ((e && e.message) || e) };
      }
      S.note = "";
    }
    paintSheet();
  }

  async function nwSave(probe) {
    const body = { key: "nowhere" };
    const u = el("nwUrl"), k = el("nwKey");
    if (u) body.url = String(u.value || "").trim();
    if (k) body.token = String(k.value || "").trim();
    if (!body.url && !body.token) { S.note = "地址和密钥都没填"; paintSheet(); return; }
    S.note = "保存中…";
    paintSheet();
    try {
      const d = await api("/app/extools/keys", { method: "POST", body: body });
      if (!d || !d.ok) { S.note = (d && d.error) || "没存下去"; paintSheet(); return; }
      S.note = "已保存（密钥留空 = 没改）";
      if (probe) {
        S.note = "正在握手…";
        paintSheet();
        const p = await api("/app/mcp/ping", { method: "POST", body: { name: "nowhere" } });
        if (p && p.ok) {
          const n = (p.tools || []).length;
          S.note = "握上手了 ✓" + (p.server ? " " + p.server : "") + (n ? "（" + n + " 个工具）" : "");
        } else {
          S.note = "握手没过：" + ((p && (p.error || p.raw || p.tools_error)) || "原因不明").slice(0, 120);
        }
      }
      S.nw = null;                       // 下次打开重新读
      await loadCards();
    } catch (e) {
      S.note = "没存下去：" + ((e && e.message) || e);
    }
    paintSheet();
  }

  /** 切栏。**只有这一个入口** —— 点击分发和对外导出都走它。

      ★ 以前这里是两处各写一遍（onAct 里一段、_tab 一段），
        结果"切到乌有乡才去取明信片"只加在了其中一条路上：
        从另一条切过去，那一栏永远是空的。
  */
  function switchTab(k) {
    S.tab = k;
    S.cur = null;
    paintList();
    // 只有切到这一栏才去取 —— 明信片要打到你那台云服务器上，别拖慢别的栏。
    // 已经有内容就不重复取（手动刷新有单独的键）。
    if (k === "nowhere" && !(S.cards && S.cards.cards && S.cards.cards.length)) loadCards();
  }

  /** 让它出门走一趟，寄一张明信片回来（字它写，邮戳乌有乡盖）。 */
  async function pcSend() {
    S.nwBusy = "send";
    showToast("它出门了…");
    try {
      const d = await api("/app/letter/postcard", { method: "POST", body: {} });
      if (d && d.ok) {
        showToast("寄回来一张" + (d.where ? " · " + d.where : ""));
        S.sheet = "";
        await loadCards();
      } else {
        showToast((d && (d.error || d.skipped)) || "这次没寄成");
      }
    } catch (e) {
      showToast("没寄成：" + ((e && e.message) || e));
    } finally { S.nwBusy = ""; paintList(); }
  }

  async function load() {
    S.busy = "load";
    try {
      const d = await api("/app/letter/state");
      if (d && d.ok) {
        S.letters = d.letters || [];
        S.unread = d.unread || 0;
        S.mail = d.mail || {};
        S.cards = d.postcards || {};
        S.cur = null;
        paint();
      } else showToast((d && d.error) || "读不到信箱");
    } catch (e) {
      showToast("读不到信箱：" + ((e && e.message) || e));
    } finally { S.busy = ""; paintList(); }
  }

  async function openOne(lid) {
    S.note = "";
    S.busy = "open";
    paintList();
    try {
      const d = await api("/app/letter/get?id=" + encodeURIComponent(lid));
      if (d && d.ok) {
        S.cur = d.letter || null;
        const row = (S.letters || []).filter((x) => String(x.id) === String(lid))[0];
        if (row) { row.read = true; S.unread = Math.max(0, S.unread - 1); }
      } else showToast((d && d.error) || "打不开这封");
    } catch (e) { showToast("打不开：" + ((e && e.message) || e)); }
    finally { S.busy = ""; paintList(); }
  }

  async function writeSave() {
    const ta = el("ltWrite");
    const raw = ta ? String(ta.value || "").trim() : "";
    if (!raw) { showToast("还没写什么"); return; }
    const parts = raw.split(/\n\s*\n/);
    const title = (parts.length > 1 ? parts[0] : parts[0].split("\n")[0]).trim();
    const body = parts.length > 1 ? parts.slice(1).join("\n\n").trim() : raw;
    try {
      const d = await api("/app/letter/write", { method: "POST",
        body: { title: title, body: body || raw, who: "me" } });
      if (d && d.ok) {
        S.sheet = "";
        showToast("收进信箱了");
        await load();
      } else showToast((d && d.error) || "没存下去");
    } catch (e) { showToast("没存下去：" + ((e && e.message) || e)); }
  }

  async function writeAI() {
    S.busy = "ai";
    showToast("它正在写…");
    try {
      const d = await api("/app/letter/ai", { method: "POST", body: {} });
      if (d && d.ok) { showToast("它写了一封"); await load(); }
      else showToast((d && (d.skipped || d.error)) || "这次没写");
    } catch (e) { showToast("没写成：" + ((e && e.message) || e)); }
    finally { S.busy = ""; }
  }

  async function delCur() {
    if (!S.cur) return;
    try {
      const d = await api("/app/letter/del", { method: "POST", body: { id: S.cur.id } });
      if (d && d.ok) { S.cur = null; showToast("删了"); await load(); }
      else showToast((d && d.error) || "没删掉");
    } catch (e) { showToast("没删掉：" + ((e && e.message) || e)); }
  }

  async function sendCur() {
    if (!S.cur) return;
    S.note = "寄出中…";
    paintList();
    try {
      const d = await api("/app/letter/mail/send", { method: "POST", body: { id: S.cur.id } });
      S.note = d && d.ok ? ("已寄到 " + (d.to || "你的邮箱")) : ("寄不出去：" + ((d && d.error) || ""));
      if (d && d.ok) { S.cur.delivered = true; showToast("寄出去了"); }
    } catch (e) { S.note = "寄不出去：" + ((e && e.message) || e); }
    paintList();
  }

  async function mailSave(probe) {
    const body = {};
    if (el("ltFrom")) body.from = String(el("ltFrom").value || "").trim();
    if (el("ltCode")) body.code = String(el("ltCode").value || "").trim();
    if (el("ltTo")) body.to = String(el("ltTo").value || "").trim();
    if (el("ltHost")) body.host = String(el("ltHost").value || "").trim();
    S.note = "保存中…";
    paintSheet();
    try {
      const d = await api("/app/letter/mail", { method: "POST", body: body });
      if (d && d.ok) {
        S.mail = d.mail || S.mail;
        S.note = "已保存（授权码留空 = 没改）";
        if (probe) return await mailProbe();
      } else S.note = (d && d.error) || "没存下去";
    } catch (e) { S.note = "没存下去：" + ((e && e.message) || e); }
    paintSheet();
  }

  async function mailProbe() {
    S.note = "正在连…";
    paintSheet();
    try {
      const d = await api("/app/letter/mail/probe", { method: "POST", body: {} });
      S.note = d && d.ok ? "连上了 ✓" : ((d && d.error) || "连不上");
    } catch (e) { S.note = "连不上：" + ((e && e.message) || e); }
    paintSheet();
  }

  /* ── 事件 ─────────────────────────────────────────────────────────────── */
  function bind() {
    if (!elPanel || elPanel.dataset.bound) return;
    elPanel.dataset.bound = "1";
    elPanel.addEventListener("click", onAct);
    elPanel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { if (S.sheet) { S.sheet = ""; paintSheet(); } else if (S.cur) { S.cur = null; paintList(); } }
    });
  }

  function onAct(e) {
    const t = e.target;
    const b = t && t.closest ? t.closest("[data-lt]") : null;
    if (b) {
      const k = b.dataset.lt;
      if (k === "close") { close(); return; }
      if (k === "back") { S.cur = null; S.note = ""; paintList(); return; }
      if (k === "reload") { load(); return; }
      if (k === "write") { S.sheet = S.sheet === "write" ? "" : "write"; paintSheet(); return; }
      if (k === "cfg") { S.sheet = S.sheet === "cfg" ? "" : "cfg"; S.note = ""; paintSheet(); return; }
      if (k === "sheet-close") { S.sheet = ""; paintSheet(); return; }
      if (k === "save") { writeSave(); return; }
      if (k === "ai") { writeAI(); return; }
      if (k === "send") { sendCur(); return; }
      if (k === "del") { delCur(); return; }
      if (k === "mail-save") { mailSave(false); return; }
      if (k === "mail-probe") { mailSave(true); return; }
      if (k === "nw-cfg") { nwOpen(); return; }
      if (k === "nw-save") { nwSave(false); return; }
      if (k === "nw-probe") { nwSave(true); return; }
      if (k === "pc-reload") { loadCards(); return; }
      if (k === "pc-send") { pcSend(); return; }
      return;
    }
    const tab = t && t.closest ? t.closest("[data-lt-tab]") : null;
    if (tab) { switchTab(tab.dataset.ltTab); return; }
    const item = t && t.closest ? t.closest("[data-lt-open]") : null;
    if (item) { openOne(item.dataset.ltOpen); return; }
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
    S.cur = null;
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

  window.openLetter = open;
  window.closeLetter = close;
  window.LetterPack = {
    open: open, close: close,
    _el: () => document.getElementById("letterPanel"),
    _paint: paint, _load: load,
    _open: openOne, _writeAI: writeAI, _send: sendCur, _del: delCur,
    _writeSave: writeSave,
    _mailSave: mailSave, _mailProbe: mailProbe,
    _loadCards: loadCards, _nwOpen: nwOpen, _nwSave: nwSave, _pcSend: pcSend,
    _cardHtml: cardHtml, _cardStamp: cardStamp,
    _ago: ago, _who: whoName,
    _tab: switchTab,
    _state: () => JSON.parse(JSON.stringify({
      tab: S.tab, letters: S.letters, unread: S.unread, cur: S.cur,
      mail: S.mail, cards: S.cards, sheet: S.sheet, note: S.note,
    })),
    _set: (p) => { Object.assign(S, p || {}); paint(); },
  };
})();
