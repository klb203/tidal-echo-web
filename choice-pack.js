/* ══════════════════════════════════════════════════════════════════════════
   choice-pack.js · 选项卡（AI 抛给你的选择题）

   要的东西（用户给的那张参考图）：
     · 输入框「上拉」面板里多一个**开关**：「选项卡」。
       打开之后，AI 才有资格在聊天里弹出一张选项卡。
     · 卡片内容 = **AI 向用户提出的选项**：题干 + A/B/C/D + 一个自由输入框
       （「自己胡说一个答案…」），点选项或自己写一句，都当成你说的话发出去。
     · 卡片左上角探出脑袋的那只吉祥物，用用户给的**生气浣熊**（mascot-ask.png），
       不是参考图里那只黑猫。

   ── 三条不值得重来一遍的实现决定 ─────────────────────────────────────
   ① 「AI 能不能弹卡」这件事**必须由后端人格知道**，不能只前端记一个开关。
      所以开关一开，就往 /app/settings 的 system_prompt 里写一段**带标记的**说明
      （<<<askon>>>…<<<askon:end>>>），关掉就整段摘掉 —— 和 room-pack 同一套路数，
      各用各的标记，互不干扰，随时可撤。
   ② 卡片不是气泡，是**浮层**：参考图里气泡在卡片后面露着半截，卡片盖在上面。
      做成浮层就不必去改宿主的消息渲染，风险小得多。
   ③ 标记要从**两个地方**剥掉：
      · setMessage —— 落库/入内存之前剥，顺带把问题解析出来（历史回放也干净）
      · renderText —— 流式是一个字一个字蹦的，`<<<choi` 这种半截标记得当场吃掉，
        否则会看到它从正文里长出来（宿主自己的 [[remember 就是这么处理的）

   存储：开关状态 + 「已经答过的问题」在 localStorage；说明段落写后端人格。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.ChoicePack) return;

  const G = window.MediaStore;
  const LS_ON = "companion_choice_on";
  const LS_DONE = "companion_choice_done";
  const PERSONA_CACHE_KEY = "companion_persona_cache";

  const MARK_B = "<<<askon>>>", MARK_E = "<<<askon:end>>>";
  /* AI 真正吐出来的那个块 */
  const ASK_B = "<<<choice>>>", ASK_E = "<<<choice:end>>>";

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (s, r) => (r || document).querySelector(s);
  const clampN = (n, a, b) => Math.max(a, Math.min(b, n));
  function lsGet(k) { try { return (localStorage.getItem(k) || "").trim(); } catch (_) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v == null ? "" : v); } catch (_) { } }
  function toast(m) {
    try { if (typeof showToast === "function") { showToast(m); return; } } catch (_) { }
    console.log("[choice] " + m);
  }
  function aiName() {
    try { if (typeof AI_NAME === "string" && AI_NAME) return AI_NAME; } catch (_) { }
    try { if (typeof CONFIG !== "undefined" && CONFIG && CONFIG.AI_NAME) return CONFIG.AI_NAME; } catch (_) { }
    return "TA";
  }
  /* ── 状态 ─────────────────────────────────────────────────────────── */
  const state = {
    on: lsGet(LS_ON) === "1",
    ask: null,        /* { q, opts, key, at } —— 当前这张卡的内容 */
    busy: false
  };
  function doneKeys() { try { return JSON.parse(lsGet(LS_DONE) || "[]") || []; } catch (_) { return []; } }
  function markDone(key) {
    if (!key) return;
    const a = doneKeys().filter((k) => k !== key).concat([key]).slice(-60);
    lsSet(LS_DONE, JSON.stringify(a));
    updateBadge();
  }

  /* ══════════════ ① 教学：往 system prompt 里写/摘说明段 ══════════════ */
  const INSTR = [
    MARK_B,
    "【你可以问他一件事 · 选项卡】",
    "在你真的需要他选、或者你想听他的偏向时，把问题做成一张选项卡 —— 写在回复的最后：",
    ASK_B,
    '{"q":"一句具体的问题","opts":["选项一","选项二","选项三"]}',
    ASK_E,
    "规矩：",
    "· 一次 2–4 个选项。每个一行话，别超过 18 个字。要具体到能选。",
    "· 不要「都可以」「看情况」「听你的」这种废选项 —— 选项之间要有真的差别。",
    "· 宁可只给两个，也别为了凑数硬加。",
    "· 先把你自己的话说完，再放卡片。卡片之外照常说话，不要只在卡片里说话。",
    "· 别每条消息都问。只有真的需要他定的时候才用。",
    "· 卡片只是提问的方式，不是新的人设。你的语气、边界、说话方式都不变。",
    MARK_E
  ].join("\n");

  function base() { try { return (G && G.base) ? G.base() : ""; } catch (_) { return ""; } }
  function headers(extra) {
    try { if (G && G.headers) return G.headers(extra); } catch (_) { }
    return Object.assign({}, extra || {});
  }
  /* ★ 必须带超时。免费档后端会休眠/冷启动，请求能安静地挂上几十秒 ——
     不设超时的话 state.busy 会一直卡着，磁贴变成按了没反应的死件；
     更糟的是：用户看着没反应就会去拨第二次，那次延迟回来的**旧结果**会盖掉新状态。 */
  async function fetchT(url, init, ms) {
    if (typeof AbortController !== "function") return fetch(url, init);
    const ctl = new AbortController();
    const timer = setTimeout(() => { try { ctl.abort(); } catch (_) { } }, ms || 12000);
    try { return await fetch(url, Object.assign({}, init, { signal: ctl.signal })); }
    finally { clearTimeout(timer); }
  }
  async function readSys() {
    const r = await fetchT(base() + "/app/settings", { headers: headers() });
    const d = await r.json().catch(() => ({}));
    return String((d.settings || {}).system_prompt || "");
  }
  async function writeSys(v) {
    const r = await fetchT(base() + "/app/settings", {
      method: "PUT", headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ system_prompt: v })
    }, 15000);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error && d.error.message) || ("HTTP " + r.status));
    lsSet(PERSONA_CACHE_KEY, v);        /* 直连模式读的是这份缓存 */
    return true;
  }
  /* 开：找到自己的标记就替换，找不到才追加（同步两次不许堆两份）
     关：整段摘掉，并把多余空行收掉 —— 别碰别的 pack 写的块 */
  async function applyInstr(on) {
    const cur = await readSys();
    const i = cur.indexOf(MARK_B), j = cur.indexOf(MARK_E);
    let next;
    if (on) {
      next = (i >= 0 && j > i) ? cur.slice(0, i) + INSTR + cur.slice(j + MARK_E.length)
                               : (cur.replace(/\s+$/, "") ? cur.replace(/\s+$/, "") + "\n\n" : "") + INSTR;
    } else {
      if (i < 0 || j <= i) return false;
      next = (cur.slice(0, i) + cur.slice(j + MARK_E.length)).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
    }
    await writeSys(next);
    return true;
  }

  async function setOn(v, quiet) {
    if (state.busy) return state.on;
    state.busy = true;
    renderTile();
    try {
      await applyInstr(v);
      state.on = !!v;
      lsSet(LS_ON, v ? "1" : "");
      if (!quiet) toast(v ? "打开了 —— 它现在可以问你问题" : "关掉了 —— 它不会主动弹选项卡了");
    } catch (e) {
      /* 后端没连上 / 超时：**不装作成功**。开关退回原样，免得出现
         「界面开着、模型却不知道有这功能」这种最难查的错位。 */
      const aborted = !!(e && (e.name === "AbortError" || /abort/i.test(String(e.message || ""))));
      state.on = !v;
      lsSet(LS_ON, state.on ? "1" : "");
      toast(aborted ? "后端没回应（超时了）—— 开关先退回原样" : ("没能改动人设：" + ((e && e.message) || e)));
    } finally {
      state.busy = false;
      renderTile();
    }
    return state.on;
  }

  /* ══════════════ ② 解析 / 剥离 ═════════════════════════════════════ */
  /* 容错两种写法：
     <<<choice>>>{"q":"…","opts":[…] }<<<choice:end>>>      ← 推荐
     <<<choice:问题>>>\nA. 一\nB. 二\n<<<choice:end>>>      ← 行式也认 */
  function parseBlock(body, inlineQ) {
    let q = String(inlineQ || "").trim(), opts = [];
    const raw = String(body || "").trim();
    if (raw) {
      let j = null;
      try { j = JSON.parse(raw); } catch (_) {
        const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
        if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (_) { } }
      }
      if (j && typeof j === "object") {
        if (!q) q = String(j.q || j.question || j.title || "").trim();
        const o = j.opts || j.options || j.choices || [];
        if (Array.isArray(o)) opts = o.map((x) => (typeof x === "string" ? x : String((x && (x.text || x.label)) || "")));
      }
      if (!opts.length) {
        /* 行式：第一行（没前缀的那行）当题干，其余按 A. / 1. / - / · 拆 */
        raw.split(/\r?\n/).forEach((line) => {
          const s = line.trim();
          if (!s) return;
          const m = /^(?:[A-Za-z]|[0-9]{1,2})\s*[.、:：)）]\s*(.+)$/.exec(s) || /^[-–—·•*]\s*(.+)$/.exec(s);
          if (m) { opts.push(m[1].trim()); return; }
          if (!q) q = s; else opts.push(s);
        });
      }
    }
    opts = opts.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6);
    q = q.slice(0, 300);
    if (!q && !opts.length) return null;
    if (!opts.length) return null;                 /* 只有问题没有选项 → 不是选项卡，别拦 */
    return { q: q, opts: opts };
  }

  /* 返回 { q, opts, rest } ；没有块就返回 null */
  function splitAsk(text) {
    const s0 = String(text == null ? "" : text);
    if (s0.indexOf("<<<choice") < 0) return null;      /* 快路径 */
    const re = /<<<choice(?:\s*[:：]\s*([\s\S]*?))?>>>([\s\S]*?)(?:<<<choice\s*[:：]\s*end\s*>>>|$)/gi;
    let m, out = null, rest = "", last = 0;
    while ((m = re.exec(s0))) {
      if (!out) out = parseBlock(m[2], m[1]);
      rest += s0.slice(last, m.index);
      last = re.lastIndex;
    }
    if (!out) return null;                              /* 块存在但解析不出选项：当普通文本 */
    rest += s0.slice(last);
    rest = rest.replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
    return { q: out.q, opts: out.opts, rest: rest };
  }

  /* 给渲染用：只剥不解析（流式时半截标记也要当场吃掉） */
  function stripChoice(t) {
    const s0 = String(t == null ? "" : t);
    /* ⚠️ 快路径必须查 `<<<` 而不是 `<<<choice` —— 流式是先蹦 `<<<`、再 `<<<choi`、
       最后才长成 `<<<choice`。只查完整关键词的话，那两个半截状态会原样漏到界面上
       （宿主把 < 转义成 &lt;，看上去就是正文里冒出一串 <<< 然后消失）。
       查 `<<<` 仍然是「绝大多数消息一次 indexOf 就返回」的快路径，正文里真有 <<< 时才往下走。 */
    if (s0.indexOf("<<<") < 0) return s0;
    let s = s0.replace(/<<<choice(?:\s*[:：][\s\S]*?)?>>>[\s\S]*?(?:<<<choice\s*[:：]\s*end\s*>>>|$)/gi, "");
    /* 末尾还没写完的半截：<<<choi / <<<choice / <<<choice>>>（正文正在一个字一个字长） */
    const tail = s.lastIndexOf("<<<");
    if (tail >= 0) {
      const frag = s.slice(tail).toLowerCase();
      if ("<<<choice".indexOf(frag) === 0 || frag.indexOf("<<<choice") === 0) s = s.slice(0, tail);
    }
    return s.replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
  }

  /* ══════════════ ③ 挂钩：renderText / setMessage / onMessage ════════ */
  let liveTide = false;          /* 正在处理一条**实时**消息（不是历史回放） */

  /* ★★★ 包住宿主函数时，必须把**被包那个函数身上的标记一起接过来**。
     这个前端有多个包会包同一个 renderText（topic-pack 也包）。后包的如果只给自己打标记，
     前一个的标记就丢了 → 前一个下次 init 会以为"还没包过" → 再套一层 → 套娃。
     （2026-09-19 回归跑出 `renderText.__choice === false` 才逮到。） */
  function carryFlags(wrapped, orig) {
    try { Object.keys(orig).forEach((k) => { if (k.indexOf("__") === 0) wrapped[k] = orig[k]; }); } catch (_) { }
  }

  function hookRenderText() {
    if (typeof window.renderText !== "function" || window.renderText.__choice) return false;
    const orig = window.renderText;
    const wrapped = function (t) { return orig.call(this, stripChoice(t)); };
    carryFlags(wrapped, orig);
    wrapped.__choice = true;
    window.renderText = wrapped;
    return true;
  }

  function rememberAsk(ask, raw) {
    if (!raw || raw.from !== "ai") return;
    const kind = String(raw.kind || "");
    if (kind === "thinking" || kind === "act" || kind === "summary") return;
    const key = "m" + String(raw.id == null ? "" : raw.id);
    state.ask = { q: ask.q, opts: ask.opts, key: key, at: Date.now() };
    if (liveTide) setTimeout(() => show(state.ask, { auto: true }), 420);
    else updateBadge();
  }

  function hookSetMessage() {
    if (typeof window.setMessage !== "function" || window.setMessage.__choice) return false;
    const orig = window.setMessage;
    const wrapped = function (raw, opt) {
      try {
        if (raw && raw.from === "ai") {
          const hit = splitAsk(raw.text);
          if (hit) {
            const clean = Object.assign({}, raw);
            /* 整条消息只有卡片时，让气泡显示题干（参考图里气泡后面露出来的就是那句话），
               免得留下一个空气泡 */
            clean.text = hit.rest || hit.q || "";
            rememberAsk(hit, raw);
            raw = clean;
          }
        }
      } catch (_) { }
      return arguments.length > 1 ? orig.call(this, raw, opt) : orig.call(this, raw);
    };
    carryFlags(wrapped, orig);
    wrapped.__choice = true;
    window.setMessage = wrapped;
    return true;
  }

  function hookOnMessage() {
    if (typeof window.onMessage !== "function" || window.onMessage.__choice) return false;
    const orig = window.onMessage;
    const wrapped = function () {
      liveTide = true;
      try { return orig.apply(this, arguments); } finally { liveTide = false; }
    };
    carryFlags(wrapped, orig);
    wrapped.__choice = true;
    window.onMessage = wrapped;
    return true;
  }

  /* ══════════════ ④ 卡片 DOM ════════════════════════════════════════ */
  const CARD_HTML = `
    <div class="ch-scrim" data-ch="close"></div>
    <div class="ch-card" role="document">
      <img class="ch-mascot" src="mascot-ask.png" alt="" aria-hidden="true">
      <div class="ch-head">
        <span class="ch-who"></span>
        <button class="ch-x" type="button" data-ch="close" aria-label="收起">✕</button>
      </div>
      <div class="ch-q"></div>
      <div class="ch-opts"></div>
      <div class="ch-free">
        <input class="ch-in" type="text" maxlength="300" placeholder="自己胡说一个答案…" enterkeyhint="send">
        <button class="ch-send" type="button" data-ch="send" aria-label="发送" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6.5 10.5L12 5l5.5 5.5"/></svg>
        </button>
      </div>
      <div class="ch-foot" id="chFoot"></div>
    </div>`;

  let elPop = null, elCard = null, elQ = null, elOpts = null, elIn = null, elWho = null, elFoot = null;

  function ensureDom() {
    if (elPop) return elPop;
    elPop = document.createElement("div");
    elPop.className = "ch-pop hidden";
    elPop.id = "choicePop";
    elPop.setAttribute("role", "dialog");
    elPop.setAttribute("aria-modal", "true");
    elPop.setAttribute("aria-label", "它问你的问题");
    elPop.innerHTML = CARD_HTML;
    document.body.appendChild(elPop);
    elCard = $(".ch-card", elPop);
    elQ = $(".ch-q", elPop);
    elOpts = $(".ch-opts", elPop);
    elIn = $(".ch-in", elPop);
    elWho = $(".ch-who", elPop);
    elFoot = $("#chFoot", elPop);

    elPop.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ch]");
      if (!b) return;
      const what = b.dataset.ch;
      if (what === "close") { close({ answered: false }); return; }
      if (what === "send") { answer(elIn ? elIn.value : ""); return; }
      if (what === "opt") { answer(b.dataset.v || ""); return; }
    });
    if (elIn) {
      elIn.addEventListener("input", () => { const s = $(".ch-send", elPop); if (s) s.disabled = !elIn.value.trim(); });
      elIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); answer(elIn.value); } });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!elPop || elPop.classList.contains("hidden")) return;
      close({ answered: false }); e.stopPropagation();
    }, true);
    return elPop;
  }

  const LETTERS = "ABCDEF";

  function renderCard(ask, opts) {
    ensureDom();
    const who = aiName();
    if (elWho) elWho.textContent = who + " 在问";
    if (elQ) elQ.textContent = ask.q || "（它没说清要问什么）";
    if (elOpts) {
      elOpts.innerHTML = (ask.opts || []).map((t, i) => `
        <button class="ch-opt" type="button" data-ch="opt" data-v="${esc(t)}">
          <i class="ch-letter">${LETTERS[i] || (i + 1)}</i>
          <span class="ch-txt">${esc(t)}</span>
          <span class="ch-chev">›</span>
        </button>`).join("");
    }
    if (elIn) { elIn.value = ""; }
    const send = $(".ch-send", elPop); if (send) send.disabled = true;
    if (elFoot) {
      elFoot.innerHTML = (opts && opts.demo ? "这是一张<b>样子</b> —— 点选项不会发出去。<br>" : "")
        + "选一个，或者自己写一句 —— 都会当你说的那句话发出去。";
    }
  }

  function show(ask, opts) {
    if (!ask) return;
    if (!state.on && !(opts && opts.demo)) { toast("先把「选项卡」打开"); return; }
    try { if (typeof csClose === "function") csClose(); } catch (_) { }
    ensureDom();
    renderCard(ask, opts);
    elPop.classList.remove("hidden");
    requestAnimationFrame(() => elPop.classList.add("on"));
  }
  let closeTimer = 0;
  function close(o) {
    if (!elPop) return;
    if (o && o.answered && state.ask) markDone(state.ask.key);
    elPop.classList.remove("on");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (elPop && !elPop.classList.contains("on")) elPop.classList.add("hidden"); }, 280);
    updateBadge();
  }

  /* 把答案当成「用户说的话」发出去 —— 复用宿主自己那条发送链路，
     别另起一条：流式、落库、失败重试、附件渲染都在那条链路上。 */
  function answer(text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return;
    const inp = document.querySelector("#input");
    const btn = document.querySelector("#sendBtn");
    if (!inp || !btn) { toast("找不到输入框，手动打一句吧"); return; }
    let payload = t;
    try { if (typeof isImageRequest === "function" && isImageRequest(t)) payload = "我选：" + t; } catch (_) { }
    inp.value = payload;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    close({ answered: true });
    state.ask = null;
    updateBadge();
    btn.click();
  }

  /* ══════════════ ⑤ 上拉面板里的开关 + 小红点 ════════════════════════ */
  const TILE_HTML = `
    <button class="cs-item ch-tile" type="button" data-ch-tile="1" aria-pressed="false">
      <i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.2A3.2 3.2 0 0 1 7.7 3h8.6a3.2 3.2 0 0 1 3.2 3.2v5.4a3.2 3.2 0 0 1-3.2 3.2h-3.9l-4.3 3.5v-3.5H7.7a3.2 3.2 0 0 1-3.2-3.2z"/><path d="M9.6 8.2a2.5 2.5 0 0 1 4.6 1.1c0 1.6-2.2 1.9-2.2 3.1"/><line x1="12" y1="14.6" x2="12" y2="14.7"/></svg></i>
      <span>选项卡</span>
      <em class="ch-sw" aria-hidden="true"></em>
      <b class="ch-dot" aria-hidden="true"></b>
    </button>`;

  const NOTE_ID = "chNote";

  function injectTile() {
    const grid = document.querySelector("#csMain .cs-grid");
    if (!grid) return false;
    if (!grid.querySelector("[data-ch-tile]")) {
      const box = document.createElement("div");
      box.innerHTML = TILE_HTML.trim();
      const tile = box.firstElementChild;
      tile.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        setOn(!state.on);
      });
      grid.appendChild(tile);
    }
    if (!$("#" + NOTE_ID)) {
      const note = document.createElement("div");
      note.className = "ch-note";
      note.id = NOTE_ID;
      grid.parentNode.insertBefore(note, grid.nextSibling);
      /* 一个出口：有待回的问题就打开它，没有就给个「样子」看。
         （拆成两个监听迟早会打架，而且哪条生效得读两处才看得懂） */
      note.addEventListener("click", () => {
        if (state.ask) { show(state.ask); return; }
        show({ q: DEMO.q, opts: DEMO.opts.slice(), key: "demo" }, { demo: true });
      });
    }
    renderTile();
    return true;
  }

  const DEMO = {
    q: "这张选项卡现在看起来怎么样？",
    opts: ["吉祥物换对了，是只浣熊", "字体和间距还想再调调", "选项太少了，多给两条", "先这样，能用就行"]
  };

  function renderTile() {
    const tile = document.querySelector("[data-ch-tile]");
    const note = $("#" + NOTE_ID);
    const pending = !!(state.ask && doneKeys().indexOf(state.ask.key) < 0);
    if (tile) {
      tile.classList.toggle("on", state.on);
      tile.classList.toggle("pending", pending);
      tile.setAttribute("aria-pressed", state.on ? "true" : "false");
    }
    if (note) {
      note.classList.toggle("pending", pending && state.on);
      const head = state.on
        ? "它可以在聊天里给你一张<b>选项卡</b>：题干 + 几个选项，点一个就当你说的话发出去。"
        : "关着的时候它只能一问一答地聊。<b>打开</b>，它才能在需要你定的时候弹一张选项卡。";
      const tail = pending
        ? '<br><span class="ch-go">▸ 它有一个问题还没回你，点这里打开</span>'
        : '<br><span class="ch-go">▸ 先看个样子</span>';
      note.innerHTML = head + tail;
    }
    /* 输入框右上角那个 ＋ 上打点 —— 不用打开面板就能看见「它还在等你」 */
    const plus = document.querySelector("#csOpenBtn");
    if (plus) plus.classList.toggle("ch-has-dot", pending);
  }
  function updateBadge() { try { renderTile(); } catch (_) { } }

  /* ══════════════ ⑥ 初始化 ═══════════════════════════════════════════ */
  function init() {
    ensureDom();
    injectTile();
    hookRenderText();
    hookSetMessage();
    hookOnMessage();
    /* 宿主的上拉面板是静态 DOM，但万一被重建过，用 observer 补插一次 */
    try {
      const mo = new MutationObserver(() => { if (!$("[data-ch-tile]")) injectTile(); });
      const sheet = document.getElementById("cSheet");
      if (sheet) mo.observe(sheet, { childList: true, subtree: true });
    } catch (_) { }
    /* 开关是开着的、但后端人格里没有那段说明（换了设备/被清过）→ 补上，
       免得出现「界面开着、模型不知道」这种最难查的错位 */
    if (state.on) {
      applyInstr(true).catch(() => { });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.ChoicePack = {
    on: () => state.on,
    busy: () => state.busy,
    setOn: setOn,
    ask: () => state.ask,
    show: show,
    close: close,
    answer: answer,
    strip: stripChoice,
    split: splitAsk,
    preset: (ask) => { state.ask = ask; updateBadge(); },
    _instr: () => INSTR,
    _tile: () => document.querySelector("[data-ch-tile]"),
    _pop: () => elPop,
    _readSys: readSys,
    _writeSys: writeSys
  };
})();
