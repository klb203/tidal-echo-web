/* ══════════════════════════════════════════════════════════════════════════
   letter-pack.js · 信箱（Movie「一起做」里的那张卡片）

   一页信：它写给你的、你写给它的，都能留着；看完能真的**寄到你的邮箱**。

   三件事说清楚
   ────────────
   ① **信不是聊天**。它写信用的是同一条"让它说一句"的链路（deliver_it=False），
      落在这里，不往会话里发 —— 所以信可以长、可以留、可以回头看。
   ② **授权码在「设置」里填**。填的是 QQ 邮箱的**授权码**，不是登录密码
      （最常见的失败就是填成了登录密码）。填了之后能"测试连接"，错了会说出原因。
   ③ **乌有乡现在没接上**（缺 X-Nowhere-Key）—— 所以那一栏**照实说**，
      不假装有。等 key 填上，这一栏就会列出明信片。
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
    cards: {},
    sheet: "",          // "" | "write" | "cfg"
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

  function paintCards(box) {
    const c = S.cards || {};
    let h = '<div class="lt-count">乌有乡 · 明信片</div>';
    if (!c.ok) {
      h += '<div class="lt-empty">' + esc(c.note || "还没接上") + "</div>";
      if (c.wired) {
        h += '<div class="lt-note">服务已经在列表里了，把 X-Nowhere-Key 填上再去握一次手。</div>';
      } else {
        h += '<div class="lt-note">接上之后，这里会列出它寄来的明信片，也能把信寄过去。</div>';
      }
    } else {
      h += '<div class="lt-empty">接上了：' + esc(c.server || "") +
           (c.n_done ? "（" + c.n_done + " 个工具）" : "") + "</div>";
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
      return;
    }
    const tab = t && t.closest ? t.closest("[data-lt-tab]") : null;
    if (tab) { S.tab = tab.dataset.ltTab; S.cur = null; paintList(); return; }
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
    _ago: ago, _who: whoName,
    _tab: (k) => { S.tab = k; S.cur = null; paintList(); },
    _state: () => JSON.parse(JSON.stringify({
      tab: S.tab, letters: S.letters, unread: S.unread, cur: S.cur,
      mail: S.mail, cards: S.cards, sheet: S.sheet, note: S.note,
    })),
    _set: (p) => { Object.assign(S, p || {}); paint(); },
  };
})();
