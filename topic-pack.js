/* ══════════════════════════════════════════════════════════════════════════
   topic-pack.js · Topic Pool（把自由活动带回来的东西做成一张卡，发到聊天里）

   自由活动（activity-pack）跑完一趟，会带回一段总结（去过哪、看到什么）和
   用过的 MCP 服务/工具。这个包把那一趟做成**一张卡**，作为一条消息放进聊天 ——
   于是它就在对话流里，能滚动、能被翻回去、能接着聊。

   ── 怎么把「一张自定义的卡」放进宿主的消息流（这一步是全部难点）──────────
   宿主的消息流是虚拟列表，`buildVirtualRows()` 只认它自己的几种 row type，
   没有插件口子。所以走这两条已有的收口，**一行都不用改 index.html**：

     ① `setMessage({ id: "tp-…", from:"ai", text: "<标记块>" })`
        —— 宿主自己的消息漏斗，插进去就进 `chatMessages`、进虚拟列表。
     ② `renderText(t)`
        —— 所有文本显示的收口。在它之前把标记块换成卡片的 HTML 返回，
           **不能**把 HTML 交给宿主原本的 renderText（它第一步就 escapeHtml）。
     ③ `makeMessage(rowData)`
        —— 给这一行加个 `tpc-row` 类，好让 CSS 把气泡"让位"给卡片。

   ★★ id 必须是**字符串**，绝对不能用大数字。
      宿主自己就为这类本地标记写了一条警告（index.html:15715）：
        「不塞进 chatMessages、不碰 lastId —— 塞进去的话 since=lastId 的增量拉取
          会以为已经同步到很远的未来，新消息永远不来了。」
      字符串 id 在 `msgNum()` 里是 NaN → 0 → 既不推高 lastId，排序又落在最后。
      代价：`cacheableMessages()` 会把它滤掉，所以卡片**只在本次会话里存在**
      （和宿主的「你戳了戳 TA」本地标记一模一样的行为）。自由活动面板里记录还在，
      想再发一次点一下就行。

   存储：本包自己不存东西。卡片数据来自 activity-pack 传进来的那一趟记录。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.TopicCard) return;

  const TITLE = "Topic Pool";          // 参考图里的那行衬线斜体大字
  const SUB = "它出去逛带回的东西";      // 下面那行小字
  const LAB_BODY = "带回的话";
  const LAB_SRC = "来源";

  const B = "<<<topic>>>", E = "<<<topic:end>>>";
  const folded = new Set();            // 收起来的卡（按卡片 id）
  const store = new Map();             // id → 卡片数据（渲染时填，点按钮时读）

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function toast(m) {
    try { if (typeof showToast === "function") { showToast(m); return; } } catch (_) { }
    console.log("[topic] " + m);
  }

  /* ── 解析：把文本切成 [普通文本, 卡片数据, 普通文本, …] ───────────────── */
  function parseOne(body) {
    const raw = String(body || "").trim();
    if (!raw) return null;
    let j = null;
    try { j = JSON.parse(raw); } catch (_) {
      const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
      if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (_) { } }
    }
    if (!j || typeof j !== "object") return null;
    const d = {
      id: String(j.id || ("tp-" + Math.abs(hash(String(j.title || "") + String(j.body || "").slice(0, 80))))),
      title: String(j.title || "").slice(0, 120),
      body: String(j.body || "").slice(0, 4000),
      src: String(j.src || "").slice(0, 2000),
      when: String(j.when || "").slice(0, 80),
      from: String(j.from || "").slice(0, 40)
    };
    if (!d.title && !d.body) return null;
    return d;
  }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

  /* 返回 [{text}|{data}] 的片段数组；没有标记就返回 null */
  function splitTopic(text) {
    const s0 = String(text == null ? "" : text);
    if (s0.indexOf("<<<topic") < 0) return null;
    const re = /<<<topic(?:\s*[:：][\s\S]*?)?>>>([\s\S]*?)(?:<<<topic\s*[:：]\s*end\s*>>>|$)/gi;
    const parts = [];
    let m, last = 0, hit = 0;
    while ((m = re.exec(s0))) {
      const d = parseOne(m[1]);
      if (!d) continue;                        // 认不出来就当普通文本，别吞掉
      if (m.index > last) parts.push({ text: s0.slice(last, m.index) });
      parts.push({ data: d });
      last = re.lastIndex; hit++;
    }
    if (!hit) return null;
    if (last < s0.length) parts.push({ text: s0.slice(last) });
    return parts;
  }

  /* ── 卡片 HTML ─────────────────────────────────────────────────────────
     ⚠️ 整张卡在 `<span class="txt">` 里，只能用**短语级元素**（span/b/i/em/img/button）。
        放 <div>/<p> 是无效嵌套（浏览器能容忍，但别指望它）——所以全是 span + display:block。 */
  function cardHtml(d) {
    store.set(d.id, d);
    const fold = folded.has(d.id);
    const src = d.src.split(/\n/).map((x) => x.trim()).filter(Boolean).join("\n")
      || "（这一趟没有留下链接）";
    return `<span class="tpc" data-tpc-id="${esc(d.id)}"${fold ? ' data-fold="1"' : ""}>`
      + `<button class="tpc-x" type="button" data-tpc-act="fold" aria-label="收起 / 展开">✕</button>`
      + `<span class="tpc-head">`
      +   `<img class="tpc-art" src="mascot-topic.png" alt="" aria-hidden="true">`
      +   `<span class="tpc-brand"><span class="tpc-title">${esc(TITLE)}</span>`
      +     `<span class="tpc-sub">${esc(SUB)}</span></span>`
      + `</span>`
      + `<span class="tpc-sec">`
      +   `<span class="tpc-lab"><i>✦</i>${esc(LAB_BODY)}</span>`
      +   `<span class="tpc-body">${esc(d.title ? d.title + "\n" + d.body : d.body)}</span>`
      +   (d.when || d.from ? `<span class="tpc-meta">${esc([d.from, d.when].filter(Boolean).join(" · "))}</span>` : "")
      + `</span>`
      + `<span class="tpc-div"><i>◆</i></span>`
      + `<span class="tpc-sec">`
      +   `<span class="tpc-lab"><i>✦</i>${esc(LAB_SRC)}</span>`
      +   `<span class="tpc-src">${esc(src)}</span>`
      + `</span>`
      + `<span class="tpc-acts">`
      +   `<button class="tpc-btn" type="button" data-tpc-act="list">返回列表</button>`
      +   `<button class="tpc-btn pri" type="button" data-tpc-act="talk">想聊这个</button>`
      + `</span>`
      + `</span>`;
  }

  /* ── 挂钩 ─────────────────────────────────────────────────────────────
     ★★★ 包住宿主函数时，必须把**被包那个函数身上的标记一起接过来**。
     这个前端有多个包会包同一个 renderText（choice-pack 也包）。后包的如果只给自己打
     `__topic`，前一个的 `__choice` 就丢了 —— 于是前一个包下一次 init 会以为"还没包过"，
     再包一层；下次再 init 再套一层……套娃而且标记再也信不过。
     （2026-09-19 真踩到：回归跑出 `renderText.__choice === false`。） */
  function carryFlags(wrapped, orig) {
    try { Object.keys(orig).forEach((k) => { if (k.indexOf("__") === 0) wrapped[k] = orig[k]; }); } catch (_) { }
  }

  function hookRenderText() {
    if (typeof window.renderText !== "function" || window.renderText.__topic) return false;
    const orig = window.renderText;
    const wrapped = function (t) {
      const parts = splitTopic(t);
      if (!parts) return orig.call(this, t);
      try {
        return parts.map((p) => (p.data ? cardHtml(p.data) : orig.call(this, p.text))).join("");
      } catch (_) { return orig.call(this, t); }
    };
    carryFlags(wrapped, orig);
    wrapped.__topic = true;
    window.renderText = wrapped;
    return true;
  }
  function hookMakeMessage() {
    if (typeof window.makeMessage !== "function" || window.makeMessage.__topic) return false;
    const orig = window.makeMessage;
    const wrapped = function (rowData) {
      const row = orig.apply(this, arguments);
      try {
        const m = rowData && rowData.message;
        /* 只给「确实装着卡片」的那一行让位（splitTopic 有快路径，普通消息几乎零成本） */
        if (row && row.classList && m && splitTopic(m.text)) {
          row.classList.add("tpc-row");
          row.classList.remove("grouped");     // 卡片独占一行，不要跟上一个气泡粘在一起
          /* 重渲染时把「收起」状态补回来 —— 节点被复用/重建都不会丢 */
          const root = row.querySelector(".tpc");
          if (root) {
            if (folded.has(root.dataset.tpcId)) root.setAttribute("data-fold", "1");
            else root.removeAttribute("data-fold");
          }
        }
      } catch (_) { }
      return row;
    };
    carryFlags(wrapped, orig);
    wrapped.__topic = true;
    window.makeMessage = wrapped;
    return true;
  }

  /* ── 发到聊天：就是插一条本地消息 ─────────────────────────────────────
     用字符串 id（见文件头那条警告）。cache:false —— 它本来就进不了缓存，
     省掉一次没意义的 IndexedDB 写入。 */
  function send(input) {
    if (!input) return null;
    const body = String(input.body || "").trim();
    if (!body && !String(input.title || "").trim()) { toast("这一趟没有内容可以发"); return null; }
    if (typeof window.setMessage !== "function") { toast("宿主没有消息接口（预览页里发不了）"); return null; }
    const id = "tp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const d = {
      id: id,
      title: String(input.title || "").trim().slice(0, 120),
      body: body.slice(0, 4000),
      src: String(input.src || "").trim().slice(0, 2000),
      when: String(input.when || "").trim().slice(0, 80),
      from: String(input.from || "自由活动").trim().slice(0, 40)
    };
    store.set(id, d);
    try {
      window.setMessage({ id: id, from: "ai", kind: "chat", ts: Date.now(),
        text: B + JSON.stringify(d) + E, status: "sent", meta: { topic: 1 } },
        { render: true, cache: false });
    } catch (e) { toast("发不出去：" + ((e && e.message) || e)); return null; }
    setTimeout(() => { try { if (typeof scrollToBottom === "function") scrollToBottom(); } catch (_) { } }, 240);
    return id;
  }

  /* ── 卡片上的四个动作（事件委托，重渲染后照样有效）────────────────── */
  function sendTalk(d) {
    const inp = document.querySelector("#input");
    const btn = document.querySelector("#sendBtn");
    if (!inp || !btn) { toast("找不到输入框，手动打一句吧"); return; }
    const line = d.title ? d.title.replace(/\n+/g, " ").slice(0, 60) : "";
    inp.value = "我们聊聊这个吧" + (line ? " —— " + line : "") + "\n\n" + d.body.slice(0, 600);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    btn.click();
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest ? e.target.closest("[data-tpc-act]") : null;
    if (!btn) return;
    const act = btn.dataset.tpcAct;
    const root = btn.closest(".tpc");
    const id = (root && root.dataset.tpcId) || "";
    if (act === "fold") {
      e.preventDefault(); e.stopPropagation();
      if (!root || !id) return;
      const nowFold = !folded.has(id);
      if (nowFold) folded.add(id); else folded.delete(id);
      /* 先直接改 DOM —— 立刻见效，不用等重渲染 */
      if (nowFold) root.setAttribute("data-fold", "1"); else root.removeAttribute("data-fold");
      return;
    }
    if (act === "list") {
      e.preventDefault(); e.stopPropagation();
      try { if (window.ActivityPanel && window.ActivityPanel.open) { window.ActivityPanel.open(); return; } } catch (_) { }
      try { if (window.openActivity) { window.openActivity(); return; } } catch (_) { }
      toast("找不到自由活动面板");
      return;
    }
    if (act === "talk") {
      e.preventDefault(); e.stopPropagation();
      const d = store.get(id);
      if (!d) { toast("这张卡的数据丢了，回列表再发一次"); return; }
      sendTalk(d);
      return;
    }
  });

  /* ── 装钩子 ───────────────────────────────────────────────────────────
     ⚠️ 必须**立刻调**，不能等 DOMContentLoaded —— 消息（本地缓存里的那份）可能在
        这之前就渲染过了，晚一步那些行就没有卡片，得等下一次重渲染才补上。
        这个包只包函数、不碰 DOM，所以在 defer 执行的那一刻装是最早也最安全的时机。
     上一版我忘了调这两个钩子（函数都写好了、就是没装），症状是：卡片发得进去、
     消息也在，但气泡里是一串原始标记 —— 探针一量 `renderText.__topic === false` 就露了。 */
  function init() { hookRenderText(); hookMakeMessage(); }
  init();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else setTimeout(init, 0);          // 宿主若在 defer 之后又换了函数，这里再补一次

  window.TopicCard = {
    send: send,
    _init: init,
    title: () => TITLE,
    sub: () => SUB,
    marker: { b: B, e: E },
    _parse: parseOne,
    _split: splitTopic,
    _card: (d) => cardHtml(parseOne(JSON.stringify(d)) || d),
    _folded: () => Array.from(folded),
    _apply: () => { try { if (typeof scheduleRender === "function") scheduleRender({ preserveAnchor: true }); } catch (_) { } }
  };
})();
