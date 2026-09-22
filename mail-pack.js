/* ══════════════════════════════════════════════════════════════════════════
   mail-pack.js · 邮箱
   面板的 DOM 由这个包自己注入，index.html 里只加三处：样式、脚本、侧边栏入口。

   邮件从哪儿来——三级降级，缺哪级都不至于整个面板空白：
     ① **网关**：后端（relay）暴露的 /app/mail/* —— 能收发，是真邮箱。
        没实现这个接口也没关系，请求会失败并自动落到下一级。
     ② **静态 JSON**：仓库里的 mail/inbox.json。由 GitHub Actions 定时同步
        （见 .github/workflows/mail-sync.yml），前端同域直接 fetch —— 只读，
        但零后端也能看到真实邮件。
     ③ **本机**：localStorage。草稿、发不出去的信、手动导入的邮件都落这儿。

   为什么不做「浏览器直连邮件服务商」：IMAP/SMTP 走的是裸 TCP，网页连不了；
   而且密码/授权码放进前端等于公开。所以前端只认上面这三级入口，
   真正的收发永远发生在后端或 Actions 里。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const G = window.MediaStore || null;

  const K_CFG   = "companion_mail_cfg";
  const K_LOCAL = "companion_mail_local";   // 本机信件（草稿 / 发不出去的 / 导入的）
  const K_READ  = "companion_mail_read";    // 已读 id 集合（只记在本机，不回写服务端）

  const CFG_DEFAULT = {
    meName: "我",
    meAddress: "",                    // 我的邮箱地址（Agent Mail 开通后填进来）
    gateway: "",                      // 留空 = 后端根 + /app/mail
    staticUrl: "./mail/inbox.json",   // 静态收件（Actions 同步出来的那份）
    autoMin: 0,                       // 自动刷新分钟数，0 = 关
    allowHtml: false,                 // 是否按 HTML 渲染正文（默认纯文本）
    signature: ""                     // 写信落款
  };

  let cfg = Object.assign({}, CFG_DEFAULT);
  let ALL = [];                 // 合并后的全部邮件
  let local = [];               // 本机那一份
  let view = "inbox";           // inbox | sent | draft
  let gwOk = false, staticOk = false;
  let lastErr = "", lastStaticAt = "";
  let aiName = "TA", persona = "", personaLoaded = false;
  let timer = 0, busy = false;

  const el = {};
  let panel = null;

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { } }
  function lsArr(k) { try { const v = JSON.parse(lsGet(k, "[]") || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
  function loadCfg() {
    try { cfg = Object.assign({}, CFG_DEFAULT, JSON.parse(lsGet(K_CFG, "{}") || "{}")); }
    catch (_) { cfg = Object.assign({}, CFG_DEFAULT); }
  }
  function saveCfg() { lsSet(K_CFG, JSON.stringify(cfg)); }

  /* ── 后端基址与鉴权：跟 media-store 读同一份设置，避免两处漂移 ────────── */
  function relayBase() {
    if (G && G.base) return G.base();
    const h = (lsGet("companion_cloud_relay", "") || "").trim() || "https://tidal-echo-relay-1-vudb.onrender.com";
    return h.replace(/\/+$/, "");
  }
  function authHeaders(extra) {
    if (G && G.headers) return G.headers(extra);
    const t = (lsGet("companion_relay_token", "") || lsGet("companion_secret", "") || "").trim();
    const h = Object.assign({}, extra || {});
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }
  function gwUrl() {
    const g = (cfg.gateway || "").trim();
    return (g || (relayBase() + "/app/mail")).replace(/\/+$/, "");
  }

  /* ── 归一化：三家返回的字段名都不一样，进来先拍平 ─────────────────────── */
  function party(p) {
    if (!p) return { name: "", email: "" };
    if (typeof p === "string") return { name: p, email: p };
    return { name: p.name || p.display_name || "", email: p.email || p.address || p.addr || "" };
  }
  function parties(v) {
    const arr = Array.isArray(v) ? v : (v ? [v] : []);
    return arr.map(party);
  }
  function partiesText(v) {
    const ps = parties(v);
    if (!ps.length) return "";
    return ps.map((p) => p.name && p.email && p.name !== p.email ? p.name + " <" + p.email + ">" : (p.email || p.name)).join("、");
  }
  function norm(raw, dir, src) {
    const r = raw || {};
    const body = String(r.body || r.text || r.content || r.snippet || "");
    const at = r.at || r.created_at || r.date || r.received_at || r.time || "";
    return {
      id: String(r.id || r.message_id || r.msg_id || ("loc_" + (r._k || Math.random().toString(36).slice(2, 9)))),
      dir: r.dir || dir || "inbox",
      src: src || r.src || "local",
      from: party(r.from || r.sender || r.from_addr),
      to: parties(r.to || r.recipients || r.to_addr),
      subject: String(r.subject || r.title || "（无主题）"),
      body: body,
      html: String(r.html || ""),
      snippet: String(r.snippet || r.preview || body).replace(/\s+/g, " ").slice(0, 140),
      at: at,
      read: !!(r.read || r.is_read),
      attachments: (Array.isArray(r.attachments) ? r.attachments : []).map((a) => ({
        name: a.name || a.filename || "附件",
        url: a.url || a.href || "",
        mime: a.mime || a.content_type || ""
      }))
    };
  }

  /* ── ① 网关 ──────────────────────────────────────────────────────────── */
  async function gwList(dir) {
    const r = await fetch(gwUrl() + "/list?dir=" + encodeURIComponent(dir) + "&limit=50",
      { headers: authHeaders(), cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json().catch(() => ({}));
    if (d && d.ok === false) throw new Error((d.error && d.error.message) || "网关拒绝了请求");
    const items = (d && (d.items || d.messages)) || [];
    return items.map((x) => norm(x, dir, "gateway"));
  }
  async function gwSend(m) {
    const r = await fetch(gwUrl() + "/send", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        to: m.to.filter(Boolean).map((a) => ({ email: a })),
        subject: m.subject,
        body: m.body,
        body_format: "PLAIN"
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || (d && d.ok === false)) throw new Error(((d && d.error && d.error.message)) || ("发送失败 HTTP " + r.status));
    return d || {};
  }
  async function gwMark(id, read) {
    try {
      await fetch(gwUrl() + "/read", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ id: id, read: !!read })
      });
    } catch (_) { /* 标记失败无所谓：本机那份已经记下了 */ }
  }
  async function gwDelete(id) {
    const r = await fetch(gwUrl() + "/delete", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: id })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || (d && d.ok === false)) throw new Error((d && d.error && d.error.message) || ("删除失败 HTTP " + r.status));
  }

  /* ── ② 静态 JSON ─────────────────────────────────────────────────────── */
  async function staticList() {
    const u = (cfg.staticUrl || "").trim();
    if (!u) return [];
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const items = Array.isArray(d) ? d : (d.items || d.messages || []);
    lastStaticAt = (!Array.isArray(d) && (d.updated_at || d.synced_at)) || "";
    return items.map((x) => norm(x, "inbox", "static"));
  }

  /* ── 已读：只存在本机 ────────────────────────────────────────────────── */
  function readSet() {
    try { const v = JSON.parse(lsGet(K_READ, "[]") || "[]"); return new Set(Array.isArray(v) ? v : []); }
    catch (_) { return new Set(); }
  }
  function markRead(m, on) {
    const s = readSet();
    if (on) s.add(m.id); else s.delete(m.id);
    lsSet(K_READ, JSON.stringify(Array.from(s).slice(-2000)));
    m.read = !!on;
    if (m.src === "gateway") gwMark(m.id, on);
  }

  /* ── 合并 ────────────────────────────────────────────────────────────── */
  function merge(lists) {
    const seen = new Map();
    lists.forEach((arr) => (arr || []).forEach((m) => {
      if (!m || !m.id) return;
      const k = m.dir + "|" + m.id;
      const old = seen.get(k);
      /* 网关 > 静态 > 本机：谁更"真"谁留下；已读状态本机说了算 */
      if (!old) { seen.set(k, m); return; }
      const rank = { gateway: 3, static: 2, local: 1 };
      if ((rank[m.src] || 0) > (rank[old.src] || 0)) {
        m.read = old.read || m.read;
        seen.set(k, m);
      }
    }));
    const rs = readSet();
    return Array.from(seen.values()).map((m) => {
      if (rs.has(m.id)) m.read = true;
      return m;
    }).sort((a, b) => ts(b.at) - ts(a.at));
  }
  const ts = (x) => { const t = new Date(x || 0).getTime(); return isNaN(t) ? 0 : t; };

  async function load() {
    loadCfg();
    local = lsArr(K_LOCAL).map((x) => norm(x, x.dir || "inbox", "local"));
    const lists = [];
    lastErr = "";
    try {
      const inbox = await gwList("inbox");
      let sent = [];
      try { sent = await gwList("sent"); } catch (_) { }
      lists.push(inbox, sent);
      gwOk = true;
    } catch (e) {
      gwOk = false;
      lastErr = (e && e.message) || String(e);
    }
    try { lists.push(await staticList()); staticOk = true; }
    catch (_) { staticOk = false; }
    lists.push(local);
    ALL = merge(lists);
    render();
    return { gateway: gwOk, static: staticOk, count: ALL.length, err: lastErr };
  }

  /* ── 时间与头像 ──────────────────────────────────────────────────────── */
  function timeText(t) {
    const ms = ts(t); if (!ms) return "";
    const d = new Date(ms), diff = Date.now() - ms;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 172800000) return "昨天 " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function who(m) { return (m.dir === "sent" || m.dir === "draft") ? "发给 " + (partiesText(m.to) || "（没写收件人）") : (m.from.name || m.from.email || "未知来信人"); }
  function avText(m) {
    const s = (m.dir === "sent" || m.dir === "draft") ? partiesText(m.to) : (m.from.name || m.from.email || "?");
    const c = String(s || "?").trim().charAt(0).toUpperCase();
    return /[A-Za-z]/.test(c) ? c : String(s || "?").trim().slice(0, 1);
  }

  /* HTML 正文：默认不渲染。真要渲染就把脚本、事件属性、javascript: 链接全剥掉 */
  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    $$("script,style,iframe,object,embed,link,meta,form,base", doc).forEach((n) => n.remove());
    $$("*", doc).forEach((n) => {
      Array.prototype.slice.call(n.attributes).forEach((a) => {
        if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        else if (/^(href|src|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
      });
    });
    return doc.body.innerHTML;
  }

  /* ── 渲染 ────────────────────────────────────────────────────────────── */
  function count(dir) {
    if (dir === "inbox") return ALL.filter((m) => m.dir === "inbox" && !m.read).length;
    return ALL.filter((m) => m.dir === dir).length;
  }
  function render() {
    if (!panel) return;
    const rows = ALL.filter((m) => m.dir === view);
    /* 顶栏副标题：地址 / 数据来源，一眼能看出现在看的是哪一份 */
    let sub = (cfg.meAddress || "").trim() || "还没填邮箱地址";
    if (lastErr && !gwOk) sub += " · 网关未通（看的是本机/静态那份）";
    el.sub.textContent = sub;

    el.tabs.innerHTML = [
      ["inbox", "收件"], ["sent", "已发"], ["draft", "草稿"]
    ].map((t) => `<button class="ml-tab ${t[0] === view ? "on" : ""}" data-mact="tab" data-dir="${t[0]}" type="button">${t[1]}${count(t[0]) ? `<b>${count(t[0])}</b>` : ""}</button>`).join("");

    if (!rows.length) {
      el.list.innerHTML = `<div class="ml-empty">
        <div class="en">No letters yet.</div>
        <p>${view === "inbox" ? "收件箱是空的。<br>去设置里填上邮箱地址 / 网关，或者先写第一封信。" :
                  view === "sent" ? "还没有发出去的信。" : "没有草稿。"}</p></div>`;
    } else {
      el.list.innerHTML = rows.map((m) => {
        const att = m.attachments.length
          ? `<svg class="ml-clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 11.5 12.3 20a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/></svg>`
          : "";
        const tag = m.src === "local" && m.dir !== "draft" ? `<span class="ml-tag">本机</span>` :
                    m.src === "static" ? `<span class="ml-tag">静态</span>` : "";
        return `<div class="ml-row ${m.read ? "read" : ""}" data-mact="open" data-id="${esc(m.id)}" data-dir="${esc(m.dir)}">
          <span class="ml-dot ${(m.dir === "inbox" && !m.read) ? "" : "off"}"></span>
          <span class="ml-av">${esc(avText(m))}</span>
          <span class="ml-main">
            <span class="ml-line"><span class="ml-from">${esc(who(m))}</span><span class="ml-when">${esc(timeText(m.at))}</span></span>
            <span class="ml-subj">${esc(m.subject)}${att}${tag}</span>
            <span class="ml-snip">${esc(m.snippet || m.body)}</span>
          </span>
        </div>`;
      }).join("");
    }
    el.src.textContent = [
      gwOk ? "网关已连上" : "网关未通",
      staticOk ? (lastStaticAt ? "静态同步 " + lastStaticAt.slice(0, 16).replace("T", " ") : "静态已读") : "",
      "本机 " + local.length + " 封"
    ].filter(Boolean).join(" · ");
  }
  function tip(t) {
    if (!el.tip) return;
    el.tip.textContent = t; el.tip.classList.remove("hidden");
    clearTimeout(tip._t);
    tip._t = setTimeout(() => el.tip.classList.add("hidden"), 4200);
  }

  /* ── 读信 ────────────────────────────────────────────────────────────── */
  function findMsg(id, dir) { return ALL.find((m) => String(m.id) === String(id) && m.dir === dir); }
  function openDetail(m) {
    if (m.dir === "inbox" && !m.read) { markRead(m, true); render(); }
    if (el.dAi) el.dAi.textContent = "让 " + aiName + " 帮我回";
    el.detail.querySelector(".ml-subj2").textContent = m.subject;
    el.detail.querySelector(".ml-meta-lines").innerHTML =
      `<div class="ml-mline"><b>来自</b> ${esc(m.from.name ? m.from.name + " <" + m.from.email + ">" : (m.from.email || "—"))}</div>` +
      `<div class="ml-mline"><b>发给</b> ${esc(partiesText(m.to) || "—")}</div>` +
      `<div class="ml-mline"><b>时间</b> ${esc(timeText(m.at))}${m.at ? " · " + esc(String(m.at).slice(0, 19).replace("T", " ")) : ""}</div>`;
    const bd = el.detail.querySelector(".ml-body");
    if (cfg.allowHtml && m.html) bd.innerHTML = sanitizeHtml(m.html);
    else bd.textContent = m.body || "（这封信没有正文）";
    el.detail.querySelector(".ml-att").innerHTML = m.attachments.length
      ? `<div class="ml-mline"><b>附件</b> ` + m.attachments.map((a) =>
          a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)).join("、") + `</div>`
      : "";
    el.detail._id = m.id; el.detail._dir = m.dir;
    show(el.detail);
  }
  function show(ov) { ov.classList.remove("hidden"); requestAnimationFrame(() => ov.classList.add("show")); }
  function hide(ov) { ov.classList.remove("show"); setTimeout(() => { if (!ov.classList.contains("show")) ov.classList.add("hidden"); }, 240); }

  /* ── 写信 ────────────────────────────────────────────────────────────── */
  function openCompose(pre) {
    pre = pre || {};
    el.cTo.value = pre.to || "";
    el.cSubj.value = pre.subject || "";
    el.cBody.value = pre.body || (cfg.signature ? "\n\n" + cfg.signature : "");
    el.compose._draftId = pre.id || "";
    show(el.compose);
    setTimeout(() => { if (!el.cTo.value) el.cTo.focus(); else el.cBody.focus(); }, 260);
  }
  function composeObj() {
    return {
      to: el.cTo.value.split(/[,;，；\s]+/).map((s) => s.trim()).filter(Boolean),
      subject: el.cSubj.value.trim() || "（无主题）",
      body: el.cBody.value
    };
  }
  function saveLocal(m) {
    const arr = lsArr(K_LOCAL);
    const i = arr.findIndex((x) => String(x.id) === String(m.id));
    if (i >= 0) arr[i] = m; else arr.unshift(m);
    lsSet(K_LOCAL, JSON.stringify(arr.slice(0, 300)));
    local = arr.map((x) => norm(x, x.dir || "inbox", "local"));
  }
  function dropLocal(id) {
    const arr = lsArr(K_LOCAL).filter((x) => String(x.id) !== String(id));
    lsSet(K_LOCAL, JSON.stringify(arr));
    local = arr.map((x) => norm(x, x.dir || "inbox", "local"));
  }
  async function saveDraft(silent) {
    const o = composeObj();
    if (!o.to.length && !el.cSubj.value.trim() && !el.cBody.trim()) { if (!silent) tip("空的，没什么可存。"); return; }
    const id = el.compose._draftId || ("d_" + Date.now().toString(36));
    saveLocal(Object.assign({ id: id, _k: id, dir: "draft", from: { name: cfg.meName, email: cfg.meAddress },
      at: new Date().toISOString(), read: true, attachments: [] }, o));
    el.compose._draftId = id;
    ALL = merge([ALL, local]);
    render();
    if (!silent) tip("存进草稿了。");
  }
  async function doSend() {
    const o = composeObj();
    if (!o.to.length) return tip("先写收件人。");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.to[0])) return tip("收件人地址看着不像邮箱：" + o.to[0]);
    el.cSend.disabled = true; el.cSend.classList.add("busy");
    try {
      await gwSend(o);
      const id = "s_" + Date.now().toString(36);
      saveLocal(Object.assign({ id: id, _k: id, dir: "sent", from: { name: cfg.meName, email: cfg.meAddress },
        at: new Date().toISOString(), read: true, attachments: [] }, o));
      if (el.compose._draftId) dropLocal(el.compose._draftId);
      ALL = merge([ALL, local]);
      render();
      hide(el.compose);
      tip("发出去了。");
    } catch (e) {
      /* 网关不通不是白写：直接落草稿，等通了再发 */
      await saveDraft(true);
      tip("发不出去（" + ((e && e.message) || e) + "）—— 已经存进草稿，通了再发。");
    } finally { el.cSend.disabled = false; el.cSend.classList.remove("busy"); }
  }

  /* ── AI 代写 / 代回 ──────────────────────────────────────────────────── */
  async function loadPersona() {
    aiName = (lsGet("companion_profile_remark", "") || "").trim() || "TA";
    try {
      const r = await fetch(relayBase() + "/app/settings", { headers: authHeaders() });
      const d = await r.json();
      const sp = (d && d.settings && d.settings.system_prompt) || "";
      if (sp) {
        persona = sp;
        const m = /你叫([^\s，,。；;的]{1,6})/.exec(sp);
        if (m && m[1]) aiName = m[1];
      }
    } catch (_) { }
    personaLoaded = true;
  }
  function personaSys(kind) {
    const head = (persona ? persona + "\n\n" : "") + "现在不是聊天，是在" + (kind === "reply" ? "替她回一封邮件" : "替她写一封邮件") + "。\n";
    return head +
      "用你自己的语气写信，不要写邮件模板，不要「尊敬的」「此致敬礼」那一套，不要总结对方说了什么。\n" +
      "篇幅看事情大小：小事三两句就够，真有事再写长。写完不要加解释、不要加备注、不要加标题行。\n" +
      (cfg.signature ? "落款用：" + cfg.signature + "\n" : "");
  }
  async function aiWrite(what) {
    if (!G || !G.chat) { tip("AI 代写要用到后端连接（media-store 没加载）。"); return; }
    if (!personaLoaded) await loadPersona();
    const btn = what === "reply" ? el.dAi : el.cAi;
    btn.disabled = true; btn.classList.add("busy");
    try {
      const isReply = what === "reply";
      const m = isReply ? findMsg(el.detail._id, el.detail._dir) : null;
      const ask = isReply
        ? ["她收到这样一封信：",
           "【来信人】" + (m ? (m.from.name || m.from.email) : ""),
           "【主题】" + (m ? m.subject : ""),
           "【正文】\n" + (m ? (m.body || m.snippet) : ""),
           "",
           "以她的身份回这封信。"].join("\n")
        : ["她要写一封邮件。",
           el.cTo.value.trim() ? "【收件人】" + el.cTo.value.trim() : "【收件人】还没定",
           el.cSubj.value.trim() ? "【主题】" + el.cSubj.value.trim() : "【主题】还没定",
           el.cBody.value.trim() ? "【她自己先写了这些】\n" + el.cBody.value.trim() : "【她自己先写了这些】（还没写，由你起头）",
           "",
           "写出邮件正文（不要写主题行）。"].join("\n");
      const txt = String(await G.chat({
        messages: [{ role: "system", content: personaSys(what) }, { role: "user", content: ask }],
        temperature: 1.0, maxTokens: 900
      }) || "").trim();
      if (!txt) throw new Error("模型没给出内容");
      if (isReply) {
        openCompose({ to: m ? (m.from.email || "") : "", subject: m ? (m.subject.startsWith("Re:") ? m.subject : "Re: " + m.subject) : "", body: txt });
      } else {
        el.cBody.value = txt + (cfg.signature ? "" : "");
        el.cBody.focus();
        tip("写好了，你改改就能发。");
      }
    } catch (e) {
      tip("AI 没写出来：" + ((e && e.message) || e));
    } finally { btn.disabled = false; btn.classList.remove("busy"); }
  }

  /* ── 设置 ────────────────────────────────────────────────────────────── */
  function openCfg() {
    el.fName.value = cfg.meName || "";
    el.fAddr.value = cfg.meAddress || "";
    el.fGw.value = cfg.gateway || "";
    el.fStatic.value = cfg.staticUrl || "";
    el.fAuto.value = String(cfg.autoMin || 0);
    el.fHtml.checked = !!cfg.allowHtml;
    el.fSig.value = cfg.signature || "";
    el.fGw.placeholder = relayBase() + "/app/mail";
    show(el.cfg);
  }
  function saveCfgForm() {
    cfg.meName = el.fName.value.trim() || "我";
    cfg.meAddress = el.fAddr.value.trim();
    cfg.gateway = el.fGw.value.trim();
    cfg.staticUrl = el.fStatic.value.trim();
    cfg.autoMin = clamp(parseInt(el.fAuto.value, 10) || 0, 0, 720);
    cfg.allowHtml = !!el.fHtml.checked;
    cfg.signature = el.fSig.value.trim();
    saveCfg();
    restartTimer();
    hide(el.cfg);
    tip("设置存好了。");
    load();
  }
  async function testGw() {
    el.fTest.disabled = true; el.fTest.classList.add("busy");
    try {
      const r = await fetch(gwUrl() + "/list?dir=inbox&limit=1", { headers: authHeaders(), cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (d && d.ok === false) throw new Error((d.error && d.error.message) || "网关拒绝");
      tip("网关通了：" + gwUrl());
      gwOk = true; render();
    } catch (e) {
      tip("连不上网关（" + ((e && e.message) || e) + "）。后端还没实现 /app/mail/* 的话，就用静态 JSON 或本机那份。");
      gwOk = false; render();
    } finally { el.fTest.disabled = false; el.fTest.classList.remove("busy"); }
  }
  /* 手动导入：把 JSON 粘进来 → 落本机收件箱。
     给「后端还没接好，但又想先看到真邮件」这个阶段用的。 */
  function importJson() {
    const raw = el.fImport.value.trim();
    if (!raw) return tip("先把 JSON 粘进下面的框。");
    let items = [];
    try {
      const d = JSON.parse(raw);
      items = Array.isArray(d) ? d : (d.items || d.messages || []);
    } catch (e) { return tip("这段不是合法 JSON：" + e.message); }
    if (!items.length) return tip("里面没有邮件。");
    const arr = lsArr(K_LOCAL);
    items.forEach((x, i) => {
      const n = norm(x, "inbox", "local");
      n.id = n.id || ("imp_" + Date.now().toString(36) + i);
      n._k = n.id;
      arr.unshift(n);
    });
    lsSet(K_LOCAL, JSON.stringify(arr.slice(0, 300)));
    local = arr.map((x) => norm(x, x.dir || "inbox", "local"));
    ALL = merge([ALL, local]);
    render();
    el.fImport.value = "";
    tip("导入了 " + items.length + " 封。");
  }
  function exportJson() {
    const s = JSON.stringify({ address: cfg.meAddress || "", updated_at: new Date().toISOString(), items: ALL }, null, 2);
    el.fImport.value = s;
    el.fImport.focus(); el.fImport.select();
    tip("已导出当前列表到下面的框 —— 复制走，或者贴进仓库的 mail/inbox.json。");
  }

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  const HTML = `
    <div class="rps-page">
      <div class="rps-top">
        <button data-mact="back" type="button" aria-label="返回">‹</button>
        <div class="rps-title-wrap"><div class="rps-title">邮箱</div><div class="rps-sub ml-sub"></div></div>
        <button data-mact="refresh" type="button" aria-label="刷新">⟳</button>
        <button data-mact="cfg" type="button" aria-label="设置">⚙</button>
      </div>
      <div class="ml-tip hidden"></div>
      <div class="ml-tabs"></div>
      <div class="ml-scroll"><div class="ml-list"></div><div class="ml-src"></div></div>
      <button class="ml-fab" data-mact="compose" type="button" aria-label="写信">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16v11H4z"/><path d="M4.6 7.2 12 13l7.4-5.8"/></svg>
      </button>

      <!-- 读信 -->
      <div class="ml-ov hidden" data-ov="detail">
        <div class="rps-top">
          <button data-mact="dback" type="button" aria-label="返回">‹</button>
          <div class="rps-title-wrap"><div class="rps-title">读信</div></div>
          <button data-mact="dunread" type="button" aria-label="标未读" title="标成未读">○</button>
          <button data-mact="ddel" type="button" aria-label="删除">🗑</button>
        </div>
        <div class="ml-ovbody">
          <div class="ml-meta">
            <h3 class="ml-subj2"></h3>
            <div class="ml-meta-lines"></div>
            <div class="ml-att"></div>
          </div>
          <div class="ml-body"></div>
          <div class="ml-acts">
            <button class="ml-btn primary" data-mact="dreply" type="button">回复</button>
            <button class="ml-btn" data-mact="dai" type="button">让 TA 帮我回</button>
          </div>
        </div>
      </div>

      <!-- 写信 -->
      <div class="ml-ov hidden" data-ov="compose">
        <div class="rps-top">
          <button data-mact="cback" type="button" aria-label="返回">‹</button>
          <div class="rps-title-wrap"><div class="rps-title">写信</div></div>
          <button data-mact="cai" type="button" aria-label="AI 代写" title="让 TA 帮我写">✧</button>
        </div>
        <div class="ml-ovbody">
          <div class="ml-field"><span>收件人（多个用逗号隔开）</span>
            <input type="text" class="ml-cto" placeholder="someone@example.com" autocomplete="off" spellcheck="false"></div>
          <div class="ml-field"><span>主题</span>
            <input type="text" class="ml-csubj" placeholder="说点什么" autocomplete="off" spellcheck="false"></div>
          <div class="ml-field"><span>正文</span>
            <textarea class="ml-cbody" spellcheck="false"></textarea></div>
          <div class="ml-acts">
            <button class="ml-btn primary ml-csend" data-mact="csend" type="button">发送</button>
            <button class="ml-btn" data-mact="cdraft" type="button">存草稿</button>
            <button class="ml-btn ghost" data-mact="ccancel" type="button">取消</button>
          </div>
        </div>
      </div>

      <!-- 设置 -->
      <div class="ml-ov hidden" data-ov="cfg">
        <div class="rps-top">
          <button data-mact="cfgback" type="button" aria-label="返回">‹</button>
          <div class="rps-title-wrap"><div class="rps-title">邮箱设置</div></div>
        </div>
        <div class="ml-ovbody">
          <div class="ml-row2"><label>我的名字</label><input type="text" class="ml-fname" autocomplete="off"></div>
          <div class="ml-row2"><label>我的邮箱地址</label><input type="text" class="ml-faddr" placeholder="me@agentmail.example" autocomplete="off" spellcheck="false"></div>
          <div class="ml-row2"><label>邮件网关</label><input type="text" class="ml-fgw" placeholder="留空 = 后端 /app/mail" autocomplete="off" spellcheck="false"></div>
          <div class="ml-row2"><label>静态收件 JSON</label><input type="text" class="ml-fstatic" placeholder="./mail/inbox.json" autocomplete="off" spellcheck="false"></div>
          <div class="ml-row2"><label>自动刷新（分）</label><input type="number" class="ml-fauto" min="0" max="720" step="1"></div>
          <div class="ml-row2"><label>写信落款</label><input type="text" class="ml-fsig" placeholder="可留空" autocomplete="off"></div>
          <label class="ml-check"><input type="checkbox" class="ml-fhtml"> 按 HTML 渲染正文（可能带样式，默认关）</label>
          <div class="ml-acts" style="margin-top:2px">
            <button class="ml-btn primary" data-mact="cfgsave" type="button">保存</button>
            <button class="ml-btn" data-mact="cfgtest" type="button">测试网关</button>
          </div>
          <p class="ml-note" style="margin-top:14px">
            邮件走三级：<b>网关</b>（<code>/app/mail/*</code>，能收发）→ <b>静态 JSON</b>
            （<code>mail/inbox.json</code>，由 GitHub Actions 同步，只读）→ <b>本机</b>（草稿与导入）。
            浏览器连不了 IMAP/SMTP，真正的收发必须在后端或 Actions 里做；前端只认这三级入口。
          </p>
          <div class="ml-field"><span>导入 / 导出（JSON 贴这儿）</span>
            <textarea class="ml-fimport" rows="6" spellcheck="false" placeholder='形如：{ "items": [ { "from": {"email":"a@b.com"}, "subject":"…", "body":"…" } ] }'></textarea></div>
          <div class="ml-acts">
            <button class="ml-btn" data-mact="import" type="button">导入到本机</button>
            <button class="ml-btn ghost" data-mact="export" type="button">导出当前列表</button>
          </div>
        </div>
      </div>
    </div>`;

  function ensureDom() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "ml-panel rps-panel hidden";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "邮箱");
    panel.innerHTML = HTML;
    document.body.appendChild(panel);

    el.sub    = $(".ml-sub", panel);
    el.tabs   = $(".ml-tabs", panel);
    el.list   = $(".ml-list", panel);
    el.src    = $(".ml-src", panel);
    el.tip    = $(".ml-tip", panel);
    el.detail = $('[data-ov="detail"]', panel);
    el.compose= $('[data-ov="compose"]', panel);
    el.cfgOv  = $('[data-ov="cfg"]', panel);

    el.cTo   = $(".ml-cto", panel);
    el.cSubj = $(".ml-csubj", panel);
    el.cBody = $(".ml-cbody", panel);
    el.cSend = $(".ml-csend", panel);
    el.cAi   = $('[data-mact="cai"]', panel);
    el.dAi   = $('[data-mact="dai"]', panel);

    el.fName= $(".ml-fname", panel); el.fAddr = $(".ml-faddr", panel);
    el.fGw  = $(".ml-fgw", panel);   el.fStatic = $(".ml-fstatic", panel);
    el.fAuto= $(".ml-fauto", panel); el.fHtml = $(".ml-fhtml", panel);
    el.fSig = $(".ml-fsig", panel);  el.fImport = $(".ml-fimport", panel);
    el.fTest= $('[data-mact="cfgtest"]', panel);

    bind();
    return panel;
  }

  function bind() {
    panel.addEventListener("click", async (e) => {
      const b = e.target.closest ? e.target.closest("[data-mact],[data-id]") : null;
      if (!b) return;
      const act = b.dataset.mact;
      if (act === "back") return close();
      if (act === "refresh") { tip("正在收信…"); const r = await load(); tip(r.gateway ? "收完了。" : "网关没通，现在看的是本机/静态那份。"); return; }
      if (act === "cfg") return openCfg();
      if (act === "compose") return openCompose({});
      if (act === "tab") { view = b.dataset.dir; return render(); }

      /* 列表点开 */
      if (act === "open" || b.dataset.id) {
        const m = findMsg(b.dataset.id, b.dataset.dir || view);
        if (m) openDetail(m);
        return;
      }

      if (act === "dback") return hide(el.detail);
      if (act === "dunread") { const m = findMsg(el.detail._id, el.detail._dir); if (m) { markRead(m, false); render(); } return hide(el.detail); }
      if (act === "ddel") {
        const m = findMsg(el.detail._id, el.detail._dir);
        if (!m) return hide(el.detail);
        try {
          if (m.src === "gateway") await gwDelete(m.id);
          if (m.src === "local") dropLocal(m.id);
          ALL = ALL.filter((x) => !(String(x.id) === String(m.id) && x.dir === m.dir));
          render(); tip("删掉了。");
        } catch (err) { tip("删不掉：" + ((err && err.message) || err)); }
        return hide(el.detail);
      }
      if (act === "dreply") {
        const m = findMsg(el.detail._id, el.detail._dir);
        if (!m) return;
        const q = (m.body || "").split("\n").map((l) => "> " + l).join("\n");
        return openCompose({ to: m.from.email || "", subject: m.subject.startsWith("Re:") ? m.subject : "Re: " + m.subject, body: "\n\n" + q });
      }
      if (act === "dai") return aiWrite("reply");

      if (act === "cback") return saveDraft(true).then(() => { el.compose._draftId = ""; hide(el.compose); render(); });
      if (act === "ccancel") { el.compose._draftId = ""; return hide(el.compose); }
      if (act === "cdraft") return saveDraft(false);
      if (act === "csend" || b.classList.contains("ml-csend")) return doSend();
      if (act === "cai") return aiWrite("write");

      if (act === "cfgback") return hide(el.cfgOv);
      if (act === "cfgsave") return saveCfgForm();
      if (act === "cfgtest") return testGw();
      if (act === "import") return importJson();
      if (act === "export") return exportJson();
    });

    /* Esc：逐层退 —— 覆盖层 → 面板 */
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !panel || panel.classList.contains("hidden")) return;
      const openOv = [el.cfgOv, el.compose, el.detail].find((o) => o && !o.classList.contains("hidden"));
      if (openOv) { hide(openOv); e.stopPropagation(); return; }
      close();
      e.stopPropagation();
    }, true);
  }

  /* ── 自动刷新 ────────────────────────────────────────────────────────── */
  function restartTimer() {
    if (timer) { clearInterval(timer); timer = 0; }
    const min = parseInt(cfg.autoMin, 10) || 0;
    if (!min) return;
    timer = setInterval(() => {
      if (document.hidden) return;
      load();
    }, Math.max(1, min) * 60000);
  }

  /* ── 开合 ────────────────────────────────────────────────────────────── */
  async function open() {
    panel = ensureDom();
    panel.classList.remove("hidden");
    requestAnimationFrame(() => panel.classList.add("open"));
    loadCfg();
    if (!personaLoaded) loadPersona();
    const r = await load();
    restartTimer();
    if (!r.gateway) tip("网关还没通 —— 现在看的是静态/本机那份。设置里可以填网关或导入邮件。");
    return r;
  }
  function close() {
    if (!panel) return;
    [el.cfgOv, el.compose, el.detail].forEach((o) => { if (o) { o.classList.remove("show"); o.classList.add("hidden"); } });
    panel.classList.remove("open");
    setTimeout(() => { if (panel && !panel.classList.contains("open")) panel.classList.add("hidden"); }, 300);
    if (timer) { clearInterval(timer); timer = 0; }
  }

  window.Mail = {
    open: open, close: close, reload: load,
    compose: (pre) => { ensureDom(); openCompose(pre || {}); },
    state: () => ({ all: ALL, cfg: cfg, gateway: gwOk, static: staticOk }),
    setAddress: (a) => { loadCfg(); cfg.meAddress = a || ""; saveCfg(); },
    _setName: (n) => { aiName = n || aiName; }
  };
  window.openMail = open;

  function init() {
    ensureDom();
    loadCfg();
    /* ?open=mail —— 跟朋友圈/相册一样的深链入口 */
    if (/[?&]open=mail\b/.test(location.search)) setTimeout(open, 400);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
