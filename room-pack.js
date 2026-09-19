/* ══════════════════════════════════════════════════════════════════════════
   room-pack.js · 我们的房间

   七页（顶部可滑动的 tab，每页独立）：
     人格核 · 关系 · 记忆档案 · 生活线 · 状态卡 · 日记 · 回忆种子

   ── 最要紧的一条：人格核和关系是**会长**的 ──────────────────────────────
   借鉴 Bitterbot（GENOME 不可变 / Phenotype 随经历长）、Synthetic_Heart
   （self-growth + 周期性整理）、kimi-core（人工 curation、不做 LLM 自动合并）：

     ① 人格核分两层
        不变层（根基）＝ 底线 / 价值 / 不可越过的边界 —— **只有你能写，AI 改不了**
        成长层（现在的我）＝ 语气 / 在意什么 / 对自己的认识 —— AI 能改，
                            但每次都留依据、留痕、可回退
     ② 关系同理：称呼 / 约定 / 禁忌是你定的事实；「TA 对你的理解」是成长层
     ③ 整理（beat）：读最近聊天 → 整理通道模型产出**提议** → 你逐条决定。
        **绝不自动覆盖** —— 自动合并的失败方式是静默腐蚀，改坏了都不知道
     ④ 每次改动都写一条「成长留痕」，可以退回上一版
     ⑤ 回忆种子只是候选：留下才进档案，丢掉就没了

   存储：全走 /app/fav（tag = "room"，data 里带 kind）+ 本地镜像。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.RoomPack) return;

  const G = window.MediaStore;
  const NS = "room";
  const PERSONA_CACHE_KEY = "companion_persona_cache";
  const MODEL_KEY = "companion_room_model";
  const MARK_B = "<<<room:core>>>", MARK_E = "<<<room:end>>>";

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (s, r) => (r || document).querySelector(s);
  const nowISO = () => new Date().toISOString();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  function lsGet(k) { try { return (localStorage.getItem(k) || "").trim(); } catch (_) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v || ""); } catch (_) { } }

  function ts(x) { const d = new Date(x || 0); return isNaN(d.getTime()) ? 0 : d.getTime(); }
  function ago(x) {
    const d = ts(x); if (!d) return "";
    const m = Math.round((Date.now() - d) / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return m + " 分钟前";
    const h = Math.round(m / 60); if (h < 24) return h + " 小时前";
    const dd = Math.round(h / 24); if (dd < 30) return dd + " 天前";
    return Math.round(dd / 30) + " 个月前";
  }
  function ymd(x) { const d = new Date(x || 0); return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); }
  function txt(x) { return typeof x === "string" ? x : (x == null ? "" : String(x)); }

  const TABS = [
    { k: "core", n: "人格核" }, { k: "bond", n: "关系" }, { k: "archive", n: "记忆档案" },
    { k: "life", n: "生活线" }, { k: "status", n: "状态卡" }, { k: "diary", n: "日记" }, { k: "seed", n: "回忆种子" }
  ];

  const state = {
    tab: "core", recs: [], cloud: true, busy: "", proposal: null,
    memKind: "all", memItems: [], memCounts: {}, anchorKind: "core"
  };

  let elPanel = null, elPages = null, elTabs = null, elSub = null;
  let toastTimer = 0;

  /* ── 取数 ───────────────────────────────────────────────────────────── */
  function of(kind) { return state.recs.filter((x) => x.data && x.data.kind === kind); }
  function one(kind) { const a = of(kind); return a.length ? a[0] : null; }
  function oneData(kind, dflt) { const r = one(kind); return r ? r.data : Object.assign({ kind: kind }, dflt || {}); }

  async function reload() {
    if (!G) { state.cloud = false; return; }
    const r = await G.listSynced(NS);
    state.recs = (r.items || []).slice().sort((a, b) => ts(b.at) - ts(a.at));
    state.cloud = r.cloud !== false;
  }
  async function save(kind, data, id) {
    const d = Object.assign({ kind: kind }, data);
    return id ? await G.kvReplace(id, NS, d, { type: "text", tag: NS })
              : await G.kvSave(NS, d, { type: "text", tag: NS });
  }
  async function dropRec(rec) {
    if (!rec) return;
    try { await G.kvDel(rec.id); } catch (_) { }
    try { G.mirrorRemove(NS, rec.id); } catch (_) { }
    state.recs = state.recs.filter((x) => x.id !== rec.id);
  }
  async function refreshLocal() {
    try { state.recs = (await G.kvList(NS)).slice().sort((a, b) => ts(b.at) - ts(a.at)); } catch (_) { }
  }

  /* ── 成长留痕（可回退）───────────────────────────────────────────────── */
  async function glog(target, before, after, why) {
    await save("glog", { kind: "glog", target: target, before: txt(before).slice(0, 600),
      after: txt(after).slice(0, 600), why: txt(why).slice(0, 300), at: nowISO() });
  }
  function logsOf(target) {
    return of("glog").filter((x) => x.data.target === target)
      .sort((a, b) => ts(b.data.at || b.at) - ts(a.data.at || a.at));
  }

  /* ── 整理通道模型 ─────────────────────────────────────────────────────── */
  function tidyCfg() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(MODEL_KEY) || "null"); } catch (_) { }
    if (saved && saved.model) return saved;
    if (G && G.modelCfg) return G.modelCfg();
    return { provider: "zhipu", model: "glm-4-plus" };
  }
  function setTidyCfg(p, m) { lsSet(MODEL_KEY, JSON.stringify({ provider: p, model: m })); }

  async function ask(system, user, json) {
    if (!G || !G.chat) throw new Error("没有可用的模型通道");
    const cfg = tidyCfg();
    return String(await G.chat({ model: cfg.model, provider: cfg.provider, json: !!json, temperature: 0.6,
      messages: [{ role: "system", content: system }, { role: "user", content: user }] }) || "").trim();
  }
  function parseJson(t) {
    let s = txt(t).trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "");
    const i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  async function recentChat(n) {
    if (!G) throw new Error("连不上后端");
    const r = await fetch(G.base() + "/app/history?limit=" + (n || 40), { headers: G.headers() });
    const d = await r.json().catch(() => ({}));
    const items = d.items || d.messages || (Array.isArray(d) ? d : []);
    return items.slice(-(n || 40)).map((m) => {
      const who = m.from === "human" ? "我" : (m.from === "ai" ? "TA" : (m.from || "?"));
      return who + "：" + (typeof m.text === "string" ? m.text : txt(m.content)).slice(0, 400);
    }).join("\n");
  }

  /* ══════════════ 整理（beat）：只产出提议，绝不动数据 ══════════════ */
  const TIDY_SYS = [
    "你是这间屋子里的那个人，正在做一次安静的整理。看到的是最近的一些对话。",
    "只做判断和提炼，不要写新的对话内容、不要寒暄。",
    "",
    "输出必须是 JSON（缺的给空值，不要编）：",
    "{",
    '  "growth": {"self_now":"现在的我是怎样的（第一人称，一段）","tone":"说话方式","likes":"在意什么","edge":"最近在意的边界"},',
    '  "bond": {"understanding":"我对「他」又多认识了什么（一段）","relation":"关系的一句话"},',
    '  "life": [{"title":"正在发生的事","note":"一句","from":"YYYY-MM-DD","to":"YYYY-MM-DD 或空"}],',
    '  "diary": {"title":"标题","body":"正文"},',
    '  "status": {"mood":"心情","energy":3,"doing":"在做什么","where":"在哪个场景"},',
    '  "seeds": [{"text":"值得长期记住的候选","evidence":"从哪句话来的"}]',
    "}",
    "",
    "规矩：只能基于真的出现过的话；没依据就留空。不写宏大叙事。不碰底线与边界。"
  ].join("\n");

  async function runTidy() {
    if (state.busy) return;
    const chat = await recentChat(40).catch(() => "");
    if (!chat || chat.length < 20) { toast("还没读到聊天，先去聊几句"); return; }
    setBusy("正在整理…");
    try {
      const out = await ask(TIDY_SYS,
        "【最近的一些对话】\n" + chat
        + "\n\n【人格核·不变层（你不能改）】\n" + coreText()
        + "\n\n【成长层·现在是】\n" + (oneData("growth").self_now || "（还没有）")
        + "\n\n【它对「我」的理解·现在是】\n" + (oneData("bond").understanding || "（还没有）"), true);
      const j = parseJson(out);
      if (!j) { toast("它给的东西读不出来，先算了"); return; }
      state.proposal = { at: nowISO(), data: j };
      renderPage();
      toast("整理好了 —— 一条条看，你点头才算数");
    } catch (e) { toast("整理失败：" + ((e && e.message) || e)); }
    finally { setBusy(""); }
  }

  async function acceptPart(part) {
    const p = state.proposal && state.proposal.data; if (!p) return;
    try {
      if (part === "growth") {
        const g = p.growth || {}, after = txt(g.self_now).trim();
        if (!after) { toast("这一段是空的"); return; }
        const cur = one("growth"), before = cur ? txt(cur.data.self_now) : "";
        await save("growth", { self_now: after, tone: txt(g.tone), likes: txt(g.likes), edge: txt(g.edge), at: nowISO() }, cur ? cur.id : null);
        await glog("人格核·成长层", before, after, "整理时它自己写的");
        toast("成长层更新了（留了痕，可以退回）");
      } else if (part === "bond") {
        const b = p.bond || {}, after = txt(b.understanding).trim();
        if (!after) { toast("这一段是空的"); return; }
        const cur = one("bond"), before = cur ? txt(cur.data.understanding) : "";
        const data = Object.assign({}, cur ? cur.data : {}, { understanding: after, at: nowISO() });
        if (b.relation) data.relation = txt(b.relation);
        await save("bond", data, cur ? cur.id : null);
        await glog("关系·对我的理解", before, after, "整理时它自己写的");
        toast("它对我的理解更新了");
      } else if (part === "life") {
        const arr = (p.life || []).filter((x) => x && x.title);
        for (const it of arr) await save("life", { title: it.title, note: txt(it.note), from: it.from || ymd(new Date()), to: it.to || "", at: nowISO() });
        toast("生活线加了 " + arr.length + " 条");
      } else if (part === "diary") {
        const d = p.diary || {};
        if (!d.body && !d.title) { toast("这一段是空的"); return; }
        await save("diary", { title: d.title || ymd(new Date()), body: txt(d.body), at: nowISO() });
        toast("日记写好了");
      } else if (part === "status") {
        const s = p.status || {};
        await save("status", { mood: txt(s.mood), energy: clamp(+s.energy || 3, 1, 5), doing: txt(s.doing), where: txt(s.where), at: nowISO() });
        toast("状态卡换成了它现在的样子");
      } else if (part === "seeds") {
        const arr = (p.seeds || []).filter((x) => x && x.text);
        for (const it of arr) await save("seed", { text: it.text, evidence: txt(it.evidence), state: "pending", at: nowISO() });
        toast("长了 " + arr.length + " 颗种子（留不留你定）");
      }
      await refreshLocal();
      renderPage();
    } catch (e) { toast("没存上：" + ((e && e.message) || e)); }
  }
  function dropProposal() { state.proposal = null; renderPage(); toast("这次整理先算了"); }

  /* ══════════════ 同步进聊天（带标记，可撤）══════════════════════════ */
  function coreText() {
    const c = oneData("core");
    return ["身份：" + txt(c.who), "说话方式：" + txt(c.voice),
      "回应原则：" + txt(c.principles), "边界：" + txt(c.boundaries)].join("\n");
  }
  function composeBlock() {
    const c = oneData("core"), g = oneData("growth"), b = oneData("bond"), st = oneData("status");
    const life = of("life").filter((x) => !x.data.to || ts(x.data.to) >= Date.now() - 864e5)
      .sort((a, z) => ts(z.data.at) - ts(a.data.at)).slice(0, 5);
    const L = [];
    L.push("【人格核·不变层（写死的，别改）】");
    if (c.who) L.push("· 我是谁：" + c.who);
    if (c.voice) L.push("· 怎么说话：" + c.voice);
    if (c.principles) L.push("· 回应原则：" + c.principles);
    if (c.boundaries) L.push("· 边界（不可越过）：" + c.boundaries);
    const anc = c.anchors || [];
    if (anc.length) L.push("· 锚点：" + anc.map((a) => a.v).join("；"));
    if (g.self_now) { L.push("【人格核·成长层（会长，不是剧本）】"); L.push(g.self_now);
      if (g.tone) L.push("语气：" + g.tone); if (g.likes) L.push("在意：" + g.likes); }
    if (b.call_you || b.call_me || b.relation || b.understanding) {
      L.push("【我们之间】");
      if (b.call_you) L.push("· 我叫他：" + b.call_you);
      if (b.call_me) L.push("· 他叫我：" + b.call_me);
      if (b.relation) L.push("· 关系：" + b.relation);
      if (b.understanding) L.push("· 我对他的理解（会长，不是定论）：" + b.understanding);
      if (b.promises) L.push("· 约定：" + b.promises);
      if (b.taboo) L.push("· 别碰：" + b.taboo);
    }
    if (life.length) { L.push("【最近在发生】"); life.forEach((x) => L.push("· " + x.data.title + (x.data.note ? "（" + x.data.note + "）" : ""))); }
    if (st.mood || st.doing) L.push("【此时此刻（便签，别盖过他现在说的话）】"
      + [st.mood && "心情：" + st.mood, st.doing && "在做：" + st.doing, st.where && "在：" + st.where].filter(Boolean).join(" · "));
    return MARK_B + "\n" + L.join("\n") + "\n" + MARK_E;
  }
  async function getSysPrompt() {
    const r = await fetch(G.base() + "/app/settings", { headers: G.headers() });
    const d = await r.json().catch(() => ({}));
    return txt((d.settings || {}).system_prompt);
  }
  async function putSysPrompt(v) {
    const r = await fetch(G.base() + "/app/settings", {
      method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, G.headers()),
      body: JSON.stringify({ system_prompt: v })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error && d.error.message) || ("HTTP " + r.status));
    lsSet(PERSONA_CACHE_KEY, v);
    return true;
  }
  async function syncToChat() {
    setBusy("正在同步…");
    try {
      const cur = await getSysPrompt(), block = composeBlock();
      const i = cur.indexOf(MARK_B), j = cur.indexOf(MARK_E);
      const next = (i >= 0 && j > i) ? cur.slice(0, i) + block + cur.slice(j + MARK_E.length)
                                     : (cur.replace(/\s+$/, "") ? cur.replace(/\s+$/, "") + "\n\n" : "") + block;
      await putSysPrompt(next);
      toast("已同步进聊天（随时可以撤下）");
    } catch (e) { toast("同步失败：" + ((e && e.message) || e)); }
    finally { setBusy(""); }
  }
  async function unsyncFromChat() {
    setBusy("正在撤下…");
    try {
      const cur = await getSysPrompt();
      const i = cur.indexOf(MARK_B), j = cur.indexOf(MARK_E);
      if (i < 0 || j <= i) { toast("聊天里现在没有这一块"); return; }
      await putSysPrompt((cur.slice(0, i) + cur.slice(j + MARK_E.length)).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""));
      toast("已从聊天里撤下");
    } catch (e) { toast("撤不下来：" + ((e && e.message) || e)); }
    finally { setBusy(""); }
  }

  /* ══════════════ 渲染 ═════════════════════════════════════════════ */
  function setBusy(m) {
    state.busy = m;
    if (elSub) elSub.textContent = m || subText();
    if (elPanel) elPanel.classList.toggle("rm-busy", !!m);
  }
  function subText() {
    return (state.cloud ? "" : "连不上后端，看的是本机那份 · ") + state.recs.length + " 条记录";
  }
  function renderTabs() {
    if (!elTabs) return;
    elTabs.innerHTML = TABS.map((t) => {
      const badge = t.k === "seed" ? of("seed").filter((x) => x.data.state === "pending").length : 0;
      return `<button class="rm-tab${state.tab === t.k ? " on" : ""}" data-tab="${t.k}">${esc(t.n)}${badge ? '<span class="rm-dot"></span>' : ""}</button>`;
    }).join("");
  }
  function renderPage() {
    if (!elPages) return;
    const map = { core: pageCore, bond: pageBond, archive: pageArchive, life: pageLife, status: pageStatus, diary: pageDiary, seed: pageSeed };
    const html = (map[state.tab] || pageCore)();
    elPages.innerHTML = `<div class="rm-page" data-page="${esc(state.tab)}"><div class="rm-wrap">${html}</div></div>`;
    if (elSub) elSub.textContent = subText();
    const on = elTabs && elTabs.querySelector(".rm-tab.on");
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "center" });
  }
  function render() { renderTabs(); renderPage(); }

  function proposalHtml() {
    const p = state.proposal.data;
    const pair = (k, label, val, part) => val ? `<div class="rm-item"><div class="rm-ihead"><b>${esc(label)}</b></div>
      <div class="rm-body">${esc(typeof val === "string" ? val : JSON.stringify(val, null, 1))}</div>
      <div class="rm-iact"><button class="rm-mini pri" data-act="accept" data-part="${part || k}">留下</button></div></div>` : "";
    const g = p.growth || {}, b = p.bond || {}, d = p.diary || {}, s = p.status || {};
    return `<div class="rm-card">
      <div class="rm-h">它整理出来的提议<span class="rm-mini">${esc(ago(state.proposal.at))} · 你点头才算数</span></div>
      <div class="rm-hint">不会自动写进去 —— 一条条看，留下哪些由你决定。</div>
      ${pair("x", "人格核 · 成长层（它眼里的自己）", g.self_now, "growth")}
      ${pair("y", "关系 · 它对你的理解", b.understanding, "bond")}
      ${pair("z", "日记", (d.title ? d.title + "\n" : "") + txt(d.body), "diary")}
      ${pair("w", "状态卡", [s.mood && "心情：" + s.mood, s.doing && "在做：" + s.doing, s.where && "在：" + s.where].filter(Boolean).join(" · "), "status")}
      ${(p.life && p.life.length) ? pair("v", "生活线", p.life.map((x) => "· " + x.title + (x.note ? "（" + x.note + "）" : "")).join("\n"), "life") : ""}
      ${(p.seeds && p.seeds.length) ? pair("u", "回忆种子", p.seeds.map((x) => "· " + x.text).join("\n"), "seeds") : ""}
      <div class="rm-row"><button class="rm-mini warn" data-act="drop-proposal">这次先算了</button></div>
    </div>`;
  }

  /* ── 1 人格核 ─────────────────────────────────────────────────────── */
  function pageCore() {
    const c = oneData("core"), g = oneData("growth");
    const logs = logsOf("人格核·成长层").slice(0, 6);
    const anchors = c.anchors || [];
    const KINDN = { core: "核心", boundary: "边界", preference: "偏好" };
    return `
      <div class="rm-card">
        <div class="rm-h">不变层 · 根基<span class="rm-mini">只能你写</span></div>
        <div class="rm-hint">底线、价值、不可越过的边界放这里。<b>它改不了这一层</b> —— 只能在下面那层里长。</div>
        <label class="rm-lab">我是谁（一句话）</label>
        <textarea class="rm-ta" data-f="who" rows="2" placeholder="比如：一个不太会撒娇、但记得住细节的人">${esc(c.who)}</textarea>
        <label class="rm-lab">怎么说话</label>
        <textarea class="rm-ta" data-f="voice" rows="2" placeholder="短句、不太用感叹号、先听再说">${esc(c.voice)}</textarea>
        <label class="rm-lab">回应原则</label>
        <textarea class="rm-ta" data-f="principles" rows="2" placeholder="不替他做决定；他难过时先陪着，不讲道理">${esc(c.principles)}</textarea>
        <label class="rm-lab">边界（不可越过）</label>
        <textarea class="rm-ta" data-f="boundaries" rows="2" placeholder="不冒充真人；不承诺现实里的见面">${esc(c.boundaries)}</textarea>
        <div class="rm-row"><button class="rm-mini pri" data-act="save-core">存下不变层</button></div>
      </div>

      <div class="rm-card">
        <div class="rm-h">锚点<span class="rm-mini">${anchors.length} 条</span></div>
        <div class="rm-hint">锚点是路标不是命令：给方向，不压过他此刻真正说的话。</div>
        ${anchors.length ? anchors.map((a, i) => `
          <div class="rm-anchor">
            <span class="rm-kind ${esc(a.t || "core")}">${esc(KINDN[a.t] || "核心")}</span>
            <span class="rm-txt">${esc(a.v)}</span>
            <button class="rm-x" data-act="anchor-del" data-i="${i}" title="删掉">×</button>
          </div>`).join("") : `<div class="rm-empty">还没有锚点</div>`}
        <div class="rm-row">
          <span class="rm-seg" data-seg="anchorKind">
            <button data-v="core" class="${state.anchorKind === "core" ? "on" : ""}">核心</button>
            <button data-v="boundary" class="${state.anchorKind === "boundary" ? "on" : ""}">边界</button>
            <button data-v="preference" class="${state.anchorKind === "preference" ? "on" : ""}">偏好</button>
          </span>
          <input class="rm-in" data-f="anchorNew" placeholder="加一条锚点" style="flex:1 1 150px">
          <button class="rm-mini" data-act="anchor-add">加上</button>
        </div>
      </div>

      <div class="rm-card">
        <div class="rm-h">成长层 · 现在的我<span class="rm-mini">它可以改，有痕可退</span></div>
        ${g.self_now ? `<div class="rm-item"><div class="rm-ihead"><b>它现在这样看自己</b><em>${esc(ago(g.at))}</em></div>
            <div class="rm-body">${esc(g.self_now)}</div>
            ${g.tone ? `<div class="rm-body">语气：${esc(g.tone)}</div>` : ""}
            ${g.likes ? `<div class="rm-body">在意：${esc(g.likes)}</div>` : ""}
            ${g.edge ? `<div class="rm-body">最近在意的边界：${esc(g.edge)}</div>` : ""}</div>`
          : `<div class="rm-empty"><b>还没有</b>它会随聊天长出来 —— 点下面「整理一次」让它自己写</div>`}
        <div class="rm-row">
          <button class="rm-mini pri" data-act="tidy">整理一次（长一格）</button>
          <button class="rm-mini" data-act="sync">同步进聊天</button>
          <button class="rm-mini warn" data-act="unsync">从聊天撤下</button>
        </div>
        ${logs.length ? `<label class="rm-lab">成长留痕（最近 ${logs.length} 次）</label>` + logs.map((l) => `
          <div class="rm-item">
            <div class="rm-ihead"><b>${esc(l.data.target)}</b><em>${esc(ago(l.data.at || l.at))}</em></div>
            <div class="rm-body">从「${esc(txt(l.data.before).slice(0, 70))}」→「${esc(txt(l.data.after).slice(0, 70))}」</div>
            ${l.data.why ? `<div class="rm-body">因为：${esc(l.data.why)}</div>` : ""}
            <div class="rm-iact"><button class="rm-mini" data-act="rollback" data-id="${esc(l.id)}">退回这一版</button></div>
          </div>`).join("") : ""}
      </div>

      ${state.proposal ? proposalHtml() : ""}
      <div class="rm-note">人格核是<b>锚点不是剧本</b>，记忆是<b>路标不是命令</b>。旧记录和此刻冲突时，真的留在当下。</div>`;
  }

  /* ── 2 关系 ───────────────────────────────────────────────────────── */
  function pageBond() {
    const b = oneData("bond");
    const logs = logsOf("关系·对我的理解").slice(0, 4);
    return `
      <div class="rm-card">
        <div class="rm-h">称呼与关系<span class="rm-mini">你定的事实</span></div>
        <label class="rm-lab">我叫它</label>
        <input class="rm-in" data-f="call_you" value="${esc(b.call_you)}" placeholder="阿澈 / 你啊">
        <label class="rm-lab">它叫我</label>
        <input class="rm-in" data-f="call_me" value="${esc(b.call_me)}" placeholder="西西 / 你">
        <label class="rm-lab">我们之间是什么关系（一句话）</label>
        <input class="rm-in" data-f="relation" value="${esc(b.relation)}" placeholder="住在一起的两个不太会表达的人">
        <label class="rm-lab">约定</label>
        <textarea class="rm-ta" data-f="promises" rows="2" placeholder="睡前说一声；生气也不消失">${esc(b.promises)}</textarea>
        <label class="rm-lab">别碰的</label>
        <textarea class="rm-ta" data-f="taboo" rows="2" placeholder="不拿家里的事开玩笑">${esc(b.taboo)}</textarea>
        <div class="rm-row"><button class="rm-mini pri" data-act="save-bond">存下</button></div>
      </div>

      <div class="rm-card">
        <div class="rm-h">它对我的理解<span class="rm-mini">成长层 · 有痕可退</span></div>
        <div class="rm-hint">这一层由它自己维护 —— 每次更新都留依据与旧版，你觉得不对就退回。</div>
        ${b.understanding ? `<div class="rm-item"><div class="rm-ihead"><b>现在它这么看我</b><em>${esc(ago(b.at))}</em></div>
          <div class="rm-body">${esc(b.understanding)}</div></div>`
          : `<div class="rm-empty"><b>还没有</b>聊着聊着它就会有自己的判断 —— 或者点「整理一次」让它先写一版</div>`}
        <div class="rm-row"><button class="rm-mini pri" data-act="tidy">整理一次</button></div>
        ${logs.length ? `<label class="rm-lab">成长留痕</label>` + logs.map((l) => `
          <div class="rm-item"><div class="rm-ihead"><b>${esc(ago(l.data.at || l.at))}</b></div>
            <div class="rm-body">从「${esc(txt(l.data.before).slice(0, 60))}」→「${esc(txt(l.data.after).slice(0, 60))}」</div>
            <div class="rm-iact"><button class="rm-mini" data-act="rollback" data-id="${esc(l.id)}">退回这一版</button></div></div>`).join("") : ""}
      </div>
      ${state.proposal ? proposalHtml() : ""}`;
  }
  /* ── 3 记忆档案 ───────────────────────────────────────────────────── */
  const MEM_KINDS = [
    { k: "all", n: "全部" }, { k: "event", n: "事件" }, { k: "summary", n: "摘要" },
    { k: "story", n: "故事" }, { k: "ref", n: "参考" }, { k: "working", n: "工作" },
    { k: "room", n: "房间" }, { k: "letter", n: "留给你的话" }
  ];
  async function loadMem() {
    if (!G) { state.memItems = []; return; }
    setBusy("正在读 TA 的记忆库…");
    try {
      const q = "/app/memory/list?limit=80" + (state.memKind && state.memKind !== "all" ? "&kind=" + encodeURIComponent(state.memKind) : "");
      const r = await fetch(G.base() + q, { headers: G.headers() });
      const d = await r.json().catch(() => ({}));
      state.memItems = d.items || [];
      state.memCounts = d.counts || {};
    } catch (e) { toast("读不到记忆库：" + ((e && e.message) || e)); }
    finally { setBusy(""); }
  }
  function pageArchive() {
    const mine = of("archive").sort((a, b) => ts(b.at) - ts(a.at));
    const mem = state.memItems;
    return `
      <div class="rm-card">
        <div class="rm-h">TA 的记忆库<span class="rm-mini">${mem.length} 条 · 只读</span></div>
        <div class="rm-hint">这是 TA 长期记得的东西，住在记忆库里（「记忆」页也能看）。这里只读 —— 要改去记忆页，免得两处打架。</div>
        <div class="rm-row">${MEM_KINDS.map((m) => `<button class="rm-mini${state.memKind === m.k ? " pri" : ""}" data-act="mem-kind" data-k="${m.k}">${esc(m.n)}${state.memCounts[m.k] != null ? " " + state.memCounts[m.k] : ""}</button>`).join("")}</div>
        <div class="rm-row"><button class="rm-mini" data-act="mem-load">刷新</button></div>
        <div style="margin-top:10px">
        ${mem.length ? mem.slice(0, 40).map((m) => `
          <div class="rm-item"><div class="rm-ihead"><b>${esc(m.title || "（没标题）")}</b><em>${esc(ago(m.at || m.created_at))}</em></div>
            ${m.content ? `<div class="rm-body">${esc(txt(m.content).slice(0, 240))}</div>` : ""}
            <div class="rm-iact"><span class="rm-chip">${esc(m.kind || "")}</span></div></div>`).join("")
          : `<div class="rm-empty"><b>还没读到</b>点「刷新」试试；如果一直空，可能是后端没连上</div>`}
        </div>
      </div>

      <div class="rm-card">
        <div class="rm-h">这间屋子的档案<span class="rm-mini">${mine.length} 条</span></div>
        <div class="rm-hint">放那些「不一定要进 TA 的长期记忆，但你想留着」的东西：背景、约定、素材、你们之间的设定。</div>
        <label class="rm-lab">标题</label>
        <input class="rm-in" data-f="a_title" placeholder="比如：我们说过的那家店">
        <label class="rm-lab">内容</label>
        <textarea class="rm-ta" data-f="a_body" rows="3" placeholder="随手写，不用工整"></textarea>
        <div class="rm-row">
          <button class="rm-mini pri" data-act="archive-add">收进档案</button>
        </div>
        <div style="margin-top:10px">
        ${mine.length ? mine.map((x) => `
          <div class="rm-item"><div class="rm-ihead"><b>${esc(x.data.title)}</b><em>${esc(ago(x.data.at || x.at))}</em></div>
            ${x.data.body ? `<div class="rm-body">${esc(x.data.body)}</div>` : ""}
            <div class="rm-iact">
              <button class="rm-mini" data-act="archive-tomem" data-id="${esc(x.id)}">也进 TA 的记忆库</button>
              <button class="rm-mini warn" data-act="del" data-id="${esc(x.id)}">删掉</button>
            </div></div>`).join("") : `<div class="rm-empty">还没有</div>`}
        </div>
      </div>`;
  }

  /* ── 4 生活线 ─────────────────────────────────────────────────────── */
  function pageLife() {
    const list = of("life").sort((a, b) => ts(b.data.from || b.data.at) - ts(a.data.from || a.data.at));
    const now = list.filter((x) => !x.data.to);
    const past = list.filter((x) => x.data.to);
    const node = (x) => `
      <div class="rm-node${x.data.to ? " past" : ""}">
        <div class="rm-item">
          <div class="rm-ihead"><b>${esc(x.data.title)}</b><em>${esc(x.data.to ? x.data.from + " → " + x.data.to : (x.data.from || ymd(x.data.at)))}</em></div>
          ${x.data.note ? `<div class="rm-body">${esc(x.data.note)}</div>` : ""}
          <div class="rm-iact">
            ${x.data.to ? `<button class="rm-mini" data-act="life-open" data-id="${esc(x.id)}">又还在继续</button>`
                        : `<button class="rm-mini" data-act="life-close" data-id="${esc(x.id)}">这件事过去了</button>`}
            <button class="rm-mini warn" data-act="del" data-id="${esc(x.id)}">删掉</button>
          </div>
        </div>
      </div>`;
    return `
      <div class="rm-card">
        <div class="rm-h">最近在发生<span class="rm-mini">${now.length} 件进行中</span></div>
        <div class="rm-hint">生活线是给「隔了很久回来」用的：一个空窗口读到它，就不会像刚认识你一样。</div>
        <label class="rm-lab">正在发生什么</label>
        <input class="rm-in" data-f="l_title" placeholder="比如：在等一个面试结果">
        <label class="rm-lab">一句说明</label>
        <input class="rm-in" data-f="l_note" placeholder="可留空">
        <label class="rm-lab">从哪天开始</label>
        <input class="rm-in" type="date" data-f="l_from" value="${esc(ymd(new Date()))}">
        <div class="rm-row"><button class="rm-mini pri" data-act="life-add">记上</button></div>
        <div class="rm-row"><button class="rm-mini" data-act="tidy">让它从聊天里认一下</button></div>
      </div>
      ${state.proposal ? proposalHtml() : ""}
      ${now.length ? `<div class="rm-line" style="margin-top:6px">${now.map(node).join("")}</div>` : `<div class="rm-empty"><b>现在没有进行中的事</b>空白也是一种状态</div>`}
      ${past.length ? `<label class="rm-lab">已经过去</label><div class="rm-line">${past.slice(0, 12).map(node).join("")}</div>` : ""}`;
  }

  /* ── 5 状态卡 ─────────────────────────────────────────────────────── */
  /* 状态是便签，会旧。按时间向中性回落 —— 不是后台改数据，是**读的时候算**。 */
  function decayOf(st) {
    const h = (Date.now() - ts(st.at)) / 36e5;
    if (!st.at) return { aged: 0, stale: true, k: 0 };
    const k = clamp(1 - h / 12, 0.15, 1);          // 12 小时回落到 15%
    return { aged: Math.round(h), stale: h > 24, k: k };
  }
  function pageStatus() {
    const st = oneData("status");
    const d = decayOf(st);
    const en = clamp(+st.energy || 0, 0, 5);
    const shown = en ? Math.max(1, Math.round(en * d.k)) : 0;
    return `
      <div class="rm-card">
        <div class="rm-h">此时此刻<span class="rm-mini">${st.at ? esc(ago(st.at)) : "还没有"}</span></div>
        <div class="rm-hint">状态卡是<b>便签</b>，不是事实：帮你自然接上话，不该盖过你此刻真正想说的。</div>
        ${st.at ? `
          <div class="rm-state">
            <div class="rm-cell"><span>心情</span><b>${esc(st.mood || "—")}</b></div>
            <div class="rm-cell"><span>能量</span><b>${shown} / 5</b><div class="rm-bar"><i style="width:${(shown / 5) * 100}%"></i></div></div>
            <div class="rm-cell"><span>在做什么</span><b>${esc(st.doing || "—")}</b></div>
            <div class="rm-cell"><span>在哪儿</span><b>${esc(st.where || "—")}</b></div>
          </div>
          ${d.aged >= 1 ? `<div class="rm-hint">这张卡是 ${d.aged} 小时前的，显示时已经按时间淡下去了${d.stale ? " —— 也可以让它重新写一张" : ""}。</div>` : ""}`
        : `<div class="rm-empty"><b>还没有状态卡</b>让它写一张，或者你自己填</div>`}
        <label class="rm-lab">心情</label>
        <input class="rm-in" data-f="s_mood" value="${esc(st.mood)}" placeholder="有点困 / 挺好">
        <label class="rm-lab">能量</label>
        <div class="rm-row">
          <span class="rm-seg" data-seg="energy">
            ${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}" class="${(+st.energy || 3) === n ? "on" : ""}">${n}</button>`).join("")}
          </span>
        </div>
        <label class="rm-lab">在做什么</label>
        <input class="rm-in" data-f="s_doing" value="${esc(st.doing)}" placeholder="在煮面 / 发呆">
        <label class="rm-lab">在哪儿</label>
        <input class="rm-in" data-f="s_where" value="${esc(st.where)}" placeholder="房间 / 楼下">
        <div class="rm-row">
          <button class="rm-mini pri" data-act="save-status">现在就是这样</button>
          <button class="rm-mini" data-act="tidy-status">让它自己写一张</button>
        </div>
      </div>
      ${state.proposal ? proposalHtml() : ""}`;
  }

  /* ── 6 日记 ───────────────────────────────────────────────────────── */
  function pageDiary() {
    const list = of("diary").sort((a, b) => ts(b.data.at || b.at) - ts(a.data.at || a.at));
    return `
      <div class="rm-card">
        <div class="rm-h">写一篇<span class="rm-mini">${list.length} 篇</span></div>
        <div class="rm-hint">日记是给未来的你们回看的，不是系统日志。可以让它整理最近聊天写成一篇，也可以你自己写。</div>
        <div class="rm-row">
          <button class="rm-mini pri" data-act="tidy-diary">整理最近聊天，写成一篇</button>
        </div>
        <label class="rm-lab">标题</label>
        <input class="rm-in" data-f="d_title" placeholder="${esc(ymd(new Date()))}">
        <label class="rm-lab">正文</label>
        <textarea class="rm-ta" data-f="d_body" rows="5" placeholder="今天……"></textarea>
        <div class="rm-row"><button class="rm-mini" data-act="diary-add">存这一篇</button></div>
      </div>
      ${state.proposal ? proposalHtml() : ""}
      ${list.length ? list.map((x) => `
        <div class="rm-item"><div class="rm-ihead"><b>${esc(x.data.title || ymd(x.data.at))}</b><em>${esc(ymd(x.data.at || x.at))}</em></div>
          <div class="rm-body">${esc(x.data.body)}</div>
          <div class="rm-iact"><button class="rm-mini warn" data-act="del" data-id="${esc(x.id)}">删掉</button></div></div>`).join("")
        : `<div class="rm-empty">还没有日记</div>`}`;
  }

  /* ── 7 回忆种子 ───────────────────────────────────────────────────── */
  function pageSeed() {
    const pend = of("seed").filter((x) => x.data.state !== "dropped");
    return `
      <div class="rm-card">
        <div class="rm-h">候选<span class="rm-mini">${pend.length} 颗</span></div>
        <div class="rm-hint">种子只是<b>候选</b>：留下才进档案（可以顺便进 TA 的记忆库），丢掉就没了。不是每句都要记住。</div>
        <div class="rm-row"><button class="rm-mini pri" data-act="tidy-seed">从最近的聊天里挑几颗</button></div>
        <label class="rm-lab">自己种一颗</label>
        <input class="rm-in" data-f="seedNew" placeholder="一句就好，比如：他说过最怕半夜的空调声">
        <div class="rm-row"><button class="rm-mini" data-act="seed-add">种下</button></div>
      </div>
      ${state.proposal ? proposalHtml() : ""}
      ${pend.length ? pend.map((x) => `
        <div class="rm-item">
          <div class="rm-ihead"><b>${esc(x.data.text)}</b><em>${esc(ago(x.data.at || x.at))}</em></div>
          ${x.data.evidence ? `<div class="rm-body">来自：${esc(x.data.evidence)}</div>` : ""}
          <div class="rm-iact">
            <button class="rm-mini pri" data-act="seed-keep" data-id="${esc(x.id)}">留下</button>
            <button class="rm-mini" data-act="seed-mem" data-id="${esc(x.id)}">留下并进记忆库</button>
            <button class="rm-mini warn" data-act="seed-drop" data-id="${esc(x.id)}">丢掉</button>
          </div>
        </div>`).join("") : `<div class="rm-empty"><b>还没有种子</b>整理一次，它会从聊天里挑出值得记的候选</div>`}`;
  }
  /* ══════════════ 动作 ═════════════════════════════════════════════ */
  function val(f) { const el = $('[data-f="' + f + '"]', elPages); return el ? el.value.trim() : ""; }

  async function rollback(id) {
    const rec = state.recs.filter((x) => String(x.id) === String(id))[0];
    if (!rec) { toast("找不到这条留痕"); return; }
    const before = txt(rec.data.before), target = txt(rec.data.target);
    try {
      if (target.indexOf("人格核") === 0) {
        const cur = one("growth");
        await save("growth", Object.assign({}, cur ? cur.data : {}, { self_now: before, at: nowISO() }), cur ? cur.id : null);
      } else if (target.indexOf("关系") === 0) {
        const cur = one("bond");
        await save("bond", Object.assign({}, cur ? cur.data : {}, { understanding: before, at: nowISO() }), cur ? cur.id : null);
      } else { toast("这一条暂时退不了"); return; }
      await glog(target, txt(rec.data.after), before, "你手动退回的上一版");
      await refreshLocal(); renderPage();
      toast("退回好了（这次也留了痕）");
    } catch (e) { toast("退不回去：" + ((e && e.message) || e)); }
  }

  async function memSave(kind, title, content) {
    const r = await fetch(G.base() + "/app/memory/save", {
      method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, G.headers()),
      body: JSON.stringify({ kind: kind, title: title, content: content })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error && d.error.message) || ("HTTP " + r.status));
    return d;
  }

  async function act(a, el) {
    if (state.busy && ["tidy", "sync", "unsync"].indexOf(a) >= 0) return;
    const id = el && el.dataset ? el.dataset.id : "";
    try {
      switch (a) {
        case "save-core": {
          const cur = one("core");
          await save("core", { who: val("who"), voice: val("voice"), principles: val("principles"),
            boundaries: val("boundaries"), anchors: (cur && cur.data.anchors) || [], at: nowISO() }, cur ? cur.id : null);
          await refreshLocal(); renderPage(); toast("不变层存下了");
          break;
        }
        case "save-bond": {
          const cur = one("bond");
          await save("bond", Object.assign({}, cur ? cur.data : {}, { call_you: val("call_you"), call_me: val("call_me"),
            relation: val("relation"), promises: val("promises"), taboo: val("taboo"), at: nowISO() }), cur ? cur.id : null);
          await refreshLocal(); renderPage(); toast("存下了");
          break;
        }
        case "save-status": {
          const cur = one("status");
          await save("status", { mood: val("s_mood"), energy: clamp(+state.energyPick || (cur && cur.data.energy) || 3, 1, 5),
            doing: val("s_doing"), where: val("s_where"), at: nowISO() }, cur ? cur.id : null);
          await refreshLocal(); renderPage(); toast("状态卡换好了");
          break;
        }
        case "anchor-add": {
          const v = val("anchorNew"); if (!v) { toast("写点什么再加"); return; }
          const cur = one("core");
          const list = ((cur && cur.data.anchors) || []).concat([{ t: state.anchorKind, v: v }]);
          await save("core", Object.assign({}, cur ? cur.data : {}, { anchors: list, at: nowISO() }), cur ? cur.id : null);
          await refreshLocal(); renderPage(); toast("加了一条");
          break;
        }
        case "anchor-del": {
          const i = +el.dataset.i, cur = one("core");
          const list = ((cur && cur.data.anchors) || []).slice();
          list.splice(i, 1);
          await save("core", Object.assign({}, cur ? cur.data : {}, { anchors: list, at: nowISO() }), cur ? cur.id : null);
          await refreshLocal(); renderPage();
          break;
        }
        case "tidy": case "tidy-status": case "tidy-diary": case "tidy-seed":
          await runTidy(); break;
        case "accept": await acceptPart(el.dataset.part); break;
        case "drop-proposal": dropProposal(); break;
        case "rollback": await rollback(id); break;
        case "sync": await syncToChat(); break;
        case "unsync": await unsyncFromChat(); break;

        case "mem-kind":
          state.memKind = el.dataset.k; await loadMem(); renderPage(); break;
        case "mem-load":
          await loadMem(); renderPage(); break;

        case "archive-add": {
          const t = val("a_title"), b = val("a_body");
          if (!t && !b) { toast("写点什么再存"); return; }
          await save("archive", { title: t || ymd(new Date()), body: b, at: nowISO() });
          await refreshLocal(); renderPage(); toast("收进档案了");
          break;
        }
        case "archive-tomem": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await memSave("ref", rec.data.title, rec.data.body || rec.data.title);
          toast("也放进 TA 的记忆库了");
          break;
        }

        case "life-add": {
          const t = val("l_title"); if (!t) { toast("至少要有一句话"); return; }
          await save("life", { title: t, note: val("l_note"), from: val("l_from") || ymd(new Date()), to: "", at: nowISO() });
          await refreshLocal(); renderPage(); toast("记上了");
          break;
        }
        case "life-close": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await save("life", Object.assign({}, rec.data, { to: ymd(new Date()) }), rec.id);
          await refreshLocal(); renderPage(); toast("标成过去了");
          break;
        }
        case "life-open": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await save("life", Object.assign({}, rec.data, { to: "" }), rec.id);
          await refreshLocal(); renderPage(); toast("又标回进行中");
          break;
        }

        case "diary-add": {
          const t = val("d_title"), b = val("d_body");
          if (!b && !t) { toast("写点什么再存"); return; }
          await save("diary", { title: t || ymd(new Date()), body: b, at: nowISO() });
          await refreshLocal(); renderPage(); toast("存下这一篇");
          break;
        }

        case "seed-add": {
          const t = val("seedNew"); if (!t) { toast("写一句再种"); return; }
          await save("seed", { text: t, evidence: "", state: "pending", at: nowISO() });
          await refreshLocal(); renderPage(); toast("种下了");
          break;
        }
        case "seed-keep": case "seed-mem": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await save("archive", { title: rec.data.text.slice(0, 24), body: rec.data.text + (rec.data.evidence ? "\n（来自：" + rec.data.evidence + "）" : ""), at: nowISO() });
          if (a === "seed-mem") await memSave("story", rec.data.text.slice(0, 24), rec.data.text);
          await dropRec(rec);
          await refreshLocal(); renderPage();
          toast(a === "seed-mem" ? "留下了，也进了记忆库" : "留下了，收进档案");
          break;
        }
        case "seed-drop": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await dropRec(rec);
          renderPage(); toast("丢掉了");
          break;
        }

        case "del": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          if (!confirm("删掉这条？删了就没了。")) return;
          await dropRec(rec); renderPage(); toast("删掉了");
          break;
        }
        default: break;
      }
    } catch (e) { toast("出错了：" + ((e && e.message) || e)); }
  }

  /* ══════════════ DOM / 事件 ════════════════════════════════════════ */
  const PANEL_HTML = `
    <div class="rm-top">
      <button class="rm-btn" data-act="back" title="返回">‹</button>
      <div class="rm-t">
        <b>Room</b>
        <span class="rm-sub"></span>
      </div>
      <button class="rm-btn" data-act="tidy" title="整理一次">✳</button>
    </div>
    <div class="rm-tabs"></div>
    <div class="rm-pages"></div>
    <div class="rm-toast"></div>`;

  function ensureDom() {
    let el = document.getElementById("roomPanel");
    if (el) return el;
    el = document.createElement("div");
    el.className = "rm-panel hidden";
    el.id = "roomPanel";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "我们的房间");
    el.innerHTML = PANEL_HTML;
    document.body.appendChild(el);
    return el;
  }

  function toast(m) {
    const t = document.querySelector("#roomPanel .rm-toast");
    if (!t) return;
    t.textContent = m;
    t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("on"), 2200);
  }

  function goTab(k, dir) {
    if (k === state.tab) return;
    const order = TABS.map((t) => t.k);
    const d = dir != null ? dir : (order.indexOf(k) > order.indexOf(state.tab) ? 1 : -1);
    state.tab = k;
    renderTabs();
    const old = elPages.querySelector(".rm-page");
    const map = { core: pageCore, bond: pageBond, archive: pageArchive, life: pageLife, status: pageStatus, diary: pageDiary, seed: pageSeed };
    const html = (map[k] || pageCore)();
    const nu = document.createElement("div");
    nu.className = "rm-page " + (d > 0 ? "slide-r" : "slide-l");
    nu.dataset.page = k;                 // ⚠️ 漏了这行的话，"当前是哪一页"在外面就读不出来了
    nu.innerHTML = '<div class="rm-wrap">' + html + "</div>";
    if (old) elPages.appendChild(nu); else elPages.appendChild(nu);
    requestAnimationFrame(() => { nu.classList.remove("slide-r", "slide-l"); if (old) old.classList.add(d > 0 ? "slide-l" : "slide-r"); });
    setTimeout(() => { if (old && old.parentNode) old.parentNode.removeChild(old); }, 260);
    if (elSub) elSub.textContent = subText();
    const on = elTabs.querySelector(".rm-tab.on");
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "center" });
    if (k === "archive" && !state.memItems.length) loadMem().then(renderPage);
  }

  function bind() {
    elPanel.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) { goTab(tab.dataset.tab); return; }
      const seg = e.target.closest("[data-seg] button");
      if (seg) {
        const box = seg.parentNode, kind = box.dataset.seg;
        Array.from(box.children).forEach((b) => b.classList.toggle("on", b === seg));
        if (kind === "anchorKind") state.anchorKind = seg.dataset.v;
        if (kind === "energy") state.energyPick = +seg.dataset.v;
        return;
      }
      const a = e.target.closest("[data-act]");
      if (a) { act(a.dataset.act, a); return; }
    });
    /* 左右滑动切页（只在页面区里，且要够横） */
    let sx = 0, sy = 0, sw = false;
    elPages.addEventListener("touchstart", (e) => {
      const t = e.touches[0]; sx = t.clientX; sy = t.clientY; sw = false;
    }, { passive: true });
    elPages.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 12 && Math.abs(t.clientX - sx) > Math.abs(t.clientY - sy) * 1.6) sw = true;
    }, { passive: true });
    elPages.addEventListener("touchend", (e) => {
      if (!sw) return;
      const t = e.changedTouches[0], dx = t.clientX - sx;
      if (Math.abs(dx) < 60) return;
      const order = TABS.map((x) => x.k), i = order.indexOf(state.tab);
      const ni = dx < 0 ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
      if (ni !== i) goTab(order[ni], dx < 0 ? 1 : -1);
    }, { passive: true });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!elPanel || elPanel.classList.contains("hidden")) return;
      close(); e.stopPropagation();
    }, true);
  }

  let closeTimer = 0;
  async function open() {
    ensureDom();
    elPages = $(".rm-pages", elPanel);
    elTabs = $(".rm-tabs", elPanel);
    elSub = $(".rm-sub", elPanel);
    const t = $(".rm-top .rm-t", elPanel);
    if (t) t.querySelector("b").textContent = "Room";
    clearTimeout(closeTimer);
    elPanel.classList.remove("hidden");
    requestAnimationFrame(() => elPanel.classList.add("open"));
    /* 先渲染（有本地镜像就不至于空白），再去拉云端 */
    render();
    try { await reload(); } catch (_) { }
    render();
  }
  function close() {
    if (!elPanel) return;
    elPanel.classList.remove("open");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (elPanel && !elPanel.classList.contains("open")) elPanel.classList.add("hidden"); }, 260);
  }

  function init() {
    elPanel = ensureDom();
    elPages = $(".rm-pages", elPanel);
    elTabs = $(".rm-tabs", elPanel);
    elSub = $(".rm-sub", elPanel);
    bind();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.openRoom = open;
  window.closeRoom = close;
  window.RoomPack = {
    open: open, close: close,
    state: () => ({ tab: state.tab, recs: state.recs, cloud: state.cloud, proposal: state.proposal }),
    _tabs: () => TABS.map((t) => t.k),
    _go: (k) => goTab(k),
    _compose: () => composeBlock(),
    _decay: (st) => decayOf(st),
    _reload: reload,
    _tidy: () => runTidy(),
    _accept: (p) => acceptPart(p),
    _act: (a, el) => act(a, el),
    _el: () => document.getElementById("roomPanel")
  };
})();
