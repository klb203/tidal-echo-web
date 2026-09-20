/* ══════════════════════════════════════════════════════════════════════════
   mcp-pack.js · 聊天里的 MCP 动作层 —— 让 TA 在聊天中自己决定去调工具

   来源：EvelynnYu/MIRROW 的「工具调用调度器」(behavior_scheduler / agent_tools_lib)
     它给的是三件事：**工具要有 schema、结果要有统一信封、调用要有调度**
       · tool schema  → name / description / input_schema{type,properties,required}
       · 结果信封     → {status:"success"|"error", message, ...data}（不成功也别抛，要能读出为什么）
   落到这个前端（没有后端改动权限）：沿用本项目**已经在用的标记约定**（见 chat-action-layer 技能），
   而不是 function calling —— 理由和那份技能写的一样：工具定义常驻 system prompt 每轮都要付费、
   tool_use 链一长就容易走岔、而标记解析失败可以**降级成纯文本**，不会让整条回复丢掉。

     TA 写：  我翻一下。[[mcp: 小红书/search_notes {"kw":"香草"}]]
     前端：   ① 把标记从气泡里剥掉（原文留着）
              ② 真去调那个 MCP 工具（前端自己就是 MCP 客户端）
              ③ 结果做成一张「工具卡」放进聊天（你看得见它调了什么、拿到了什么）
              ④ **补全轮**：把结果回灌给它，让它接着说 —— 不说这一步它只能干说「我去翻翻」
              ⑤ 顺手写进记忆库，这样它下次还能想起来（不写的话这一轮只在本次会话里）

   ── 照抄自 chat-action-layer 的几条硬规矩（每条都在那份技能里栽过）──────────
   ① 流式必须「边流边剥」：标记是一两个字蹦出来的，等流完再剥用户已经看见 `[[mcp: 前` 了。
      末尾可能**只是标记开头**（`[[` / `[[m` / `[[mcp: 正文正在长`）→ 扣住；`[[这个` → 放行。
   ② 不认识的 `[[xxx: …]]` **原样保留** —— 宁可露出怪东西，也别吃掉真心话。
   ③ 一条回复最多认 MAX_ACTIONS 个动作；补全最多 1 轮。
   ④ 所有结果加起来有**总预算**，超了给一句显式提示，不静默丢。
   ⑤ 危险工具用**白名单**思路挡：删/清/执行类一律不给，并在界面上写明为什么。
   ⑥ **注入端和执行端必须同一份清单** —— 不然就是"你刷新了清单，模型学会用了，一调就报错"。
   ⑦ 回灌那段开头必须写清「TA 看不到这一段、别念原文、别提工具」，否则它会转述成"根据检索结果显示"。
   ⑧ 假库/假实现要「搜不到就真的搜不到」，不然断言永远绿。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.McpPack) return;

  const G = window.MediaStore;
  const MARK_B = "<<<mcpact:on>>>", MARK_E = "<<<mcpact:end>>>";
  const RES_B = "<<<mcpres>>>", RES_E = "<<<mcpres:end>>>";
  const LS_ON = "companion_mcp_act_on";
  const LS_ALLOW = "companion_mcp_allow";
  const LS_TOOLS = "companion_mcp_tools";
  const LS_FRESH = "companion_mcp_fresh";
  const LS_SRV = "companion_mcp_srv";      /* 后端服务器摘要的本地缓存（先画出来再刷新） */
  const PERSONA_CACHE_KEY = "companion_persona_cache";

  const MAX_ACTIONS = 2;        /* 一条回复最多认几个动作 */
  const PER_CAP = 2000;         /* 单个结果最多留多少字 */
  const BUDGET = 4000;          /* 所有结果加起来的上限 */
  /* 卡片里的显示上限要**比预算大一点**：预算那一步截完还会补一句
     「…（还很长，先看这些）」，显示层再按 PER_CAP 截一次的话正好把那句说明砍掉 ——
     用户只看到一条被硬切的结果，不知道是被截的（2026-09-19 探针逮到的）。 */
  const DISPLAY_CAP = PER_CAP + 240;

  /* ★ 危险工具白名单：凡「删了就回不来」或「后果不该由它单方面决定」的，一律不给。
     这是**产品决定不是技术限制**，所以界面上要把「为什么没收给它」写出来。 */
  const DENY_RE = /(^|[_\-\/])(delete|del|remove|rm|drop|purge|forget|erase|wipe|clear|reset|destroy|kill|uninstall|exec|eval|shell|run_command|write_file|upload|post|publish|send)([_\-\/]|$)/i;

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (s, r) => (r || document).querySelector(s);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  function lsGet(k) { try { return (localStorage.getItem(k) || "").trim(); } catch (_) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v == null ? "" : v); } catch (_) { } }
  function lsJson(k, d) { try { const v = JSON.parse(lsGet(k) || "null"); return v == null ? d : v; } catch (_) { return d; } }
  function toast(m) {
    try { if (typeof showToast === "function") { showToast(m); return; } } catch (_) { }
    console.log("[mcp] " + m);
  }
  async function memApi(path, opt) {
    try { if (typeof window.memApi === "function") return await window.memApi(path, opt); } catch (_) { }
    const r = await fetch((G ? G.base() : "") + path, Object.assign({ headers: G ? G.headers((opt && opt.body) ? { "Content-Type": "application/json" } : {}) : {} }, opt || {}));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error && d.error.message) || ("HTTP " + r.status));
    return d;
  }

  const state = {
    on: lsGet(LS_ON) === "1",
    tools: lsJson(LS_TOOLS, {}),     /* { "服务/工具": "描述" } —— 已握手过的真实清单 */
    allow: lsJson(LS_ALLOW, null),   /* { 服务名: true } —— 允不允许在聊天里被调；null = 全允许 */
    srv: lsJson(LS_SRV, []),         /* 后端 /app/mcp/list 的摘要（含状态、传输、工具开关） */
    busy: false,
    lastRun: null,
    fresh: lsGet(LS_FRESH) === "1"
  };
  let liveTide = false;

  /* ══════════════ 服务与工具清单 ═════════════════════════════════════
     ★ 配置来源只有一个：**后端**（/app/mcp/*，也就是「工具与能力 → MCP 设置」那张卡）。
       以前这里读的是「自由活动」里那份**本地**列表 —— 两套配置、两处维护，
       于是必然出现"设置里改了、聊天里没变"，而且改的到底是哪一处都说不清。
       现在一处配置、两处生效（聊天动作层 + 自由活动都用后端这份）。
     ★ 真正的调用也在后端（/app/mcp/call）：自定义鉴权头、读 SSE 回包、对方还得开 CORS，
       浏览器三样都做不到；令牌还存在后端、不回显，前端手里根本没有凭据。
       ——「注入端与执行端同源」是这一层唯一不能破的规矩。 */
  function servers() {
    return (state.srv || []).filter((x) => x && x.url);
  }
  async function loadServers() {
    const d = await memApi("/app/mcp/list");
    state.srv = d.servers || [];
    lsSet(LS_SRV, JSON.stringify(state.srv));
    return state.srv;
  }
  function toolOffOf(sv, name) {
    return ((sv && sv.tool_off) || []).indexOf(name) >= 0;
  }
  function allowOf(sv) {
    if (!sv || sv.enable === false) return false;
    if (!state.allow) return true;
    return state.allow[sv.name || sv.id] !== false;
  }
  function setAllow(sv, v) {
    state.allow = state.allow || {};
    state.allow[sv.name || sv.id] = !!v;
    lsSet(LS_ALLOW, JSON.stringify(state.allow));
  }
  function isDanger(name) { return DENY_RE.test(String(name || "")); }
  /* 「注入端」和「执行端」都走这一个函数 —— 两边同源，才不会出现"清单里有、一调就报错" */
  function toolAllowed(sv, toolName) {
    if (!sv || !toolName) return false;
    if (sv.enable === false) return false;                 /* 后端停用了 */
    if (!allowOf(sv)) return false;                        /* 聊天这一侧关掉了 */
    if (isDanger(toolName)) return false;                  /* 硬拦：删 / 清 / 执行 / 外发 */
    if (toolOffOf(sv, toolName)) return false;             /* 这一个工具被单独关掉了 */
    const key = (sv.name || sv.id) + "/" + toolName;
    if (Object.keys(state.tools).length && !state.tools[key]) return false;   /* 有清单就按清单来 */
    return true;
  }
  function toolKeyOf(sv, name) { return (sv.name || sv.id) + "/" + name; }
  function findServer(name) {
    const list = servers();
    const hit = list.filter((x) => x.name === name || x.id === name)[0];
    if (hit) return hit;
    /* 名字写歪了也救一下：唯一前缀匹配 */
    const byPrefix = list.filter((x) => String(x.name || "").indexOf(name) === 0);
    return byPrefix.length === 1 ? byPrefix[0] : null;
  }
  function stateOf(sv) {
    const s = (sv && sv.state) || {};
    return { s: s.s || "idle", label: s.label || "还没握手过", msg: s.msg || "",
             at: s.at || "", ms: s.ms || 0 };
  }

  /* ══════════════ 清单与调用（都走后端）═══════════════════════════════ */
  /* 真去握手一次并刷新清单。verbose 时会逐个报结果 —— 静默失败最难查。 */
  async function handshake(verbose) {
    try { await loadServers(); } catch (_) { }
    const list = servers().filter((x) => x.enable !== false);
    if (!list.length) {
      if (verbose) toast((state.srv || []).length
        ? "服务都被停用了 —— 去「工具与能力 → MCP 设置」打开一个"
        : "还没配 MCP 服务 —— 去「工具与能力 → MCP 设置」加一个");
      return state.tools;
    }
    const out = Object.assign({}, state.tools);
    for (const sv of list) {
      const nm = sv.name || sv.id;
      try {
        const d = await memApi("/app/mcp/ping", { method: "POST", body: JSON.stringify({ name: nm }) });
        (d.tool_list || []).forEach((t) => {
          if (!t || !t.name) return;
          out[toolKeyOf(sv, t.name)] = String(t.description || t.name || "").slice(0, 160);
        });
        if (d.tools_error) delete out[nm + "/" + "（列不出工具）"];
        if (verbose) toast(nm + (d.ok ? " 握手成功（" + ((d.tool_list || []).length) + " 个工具）"
                                     : " 握手失败：" + (d.error || ("HTTP " + d.status))));
      } catch (e) {
        if (verbose) toast(nm + " 握手失败：" + ((e && e.message) || e));
      }
    }
    try { await loadServers(); } catch (_) { }
    if (Object.keys(out).length) {
      /* 按名字排序存下来 —— 清单要逐字节稳定，才进得了提示词的稳定段（前缀缓存） */
      state.tools = {};
      Object.keys(out).sort().forEach((k) => { state.tools[k] = out[k]; });
      lsSet(LS_TOOLS, JSON.stringify(state.tools));
      state.fresh = false; lsSet(LS_FRESH, "");
    }
    renderTile(); renderPanel();
    return state.tools;
  }
  /* 只读「已经存下来的清单」，不重新握手 —— 打开面板时用这个，别让几个服务串起来等十几秒 */
  async function pullTools() {
    try { await loadServers(); } catch (_) { }
    const out = {};
    for (const sv of servers()) {
      try {
        const d = await memApi("/app/mcp/tools?name=" + encodeURIComponent(sv.name || sv.id));
        (d.tools || []).forEach((t) => {
          if (t && t.name) out[toolKeyOf(sv, t.name)] = String(t.description || t.name || "").slice(0, 160);
        });
      } catch (_) { }
    }
    if (Object.keys(out).length) {
      state.tools = {};
      Object.keys(out).sort().forEach((k) => { state.tools[k] = out[k]; });
      lsSet(LS_TOOLS, JSON.stringify(state.tools));
    }
    return state.tools;
  }
  /* 真的调一个工具 —— 后端替我们调（浏览器拿不到凭据，也过不去 CORS/SSE） */
  async function callTool(sv, name, args) {
    try {
      const d = await memApi("/app/mcp/call", { method: "POST",
        body: JSON.stringify({ name: sv.name || sv.id, tool: name, arguments: args || {} }) });
      if (d && d.ok) return { status: "success", message: String(d.text || "") };
      return { status: "error", message: String((d && d.error) || "没调成") };
    } catch (e) {
      return { status: "error", message: ((e && e.message) || String(e)) };
    }
  }
  /* 单个工具的开关（写在后端，聊天与自由活动都跟着变） */
  async function toggleTool(sv, name, on) {
    await memApi("/app/mcp/tool", { method: "POST",
      body: JSON.stringify({ name: sv.name || sv.id, tool: name, on: !!on }) });
    sv.tool_off = (sv.tool_off || []).filter((x) => x !== name);
    if (!on) sv.tool_off.push(name);
    try { await loadServers(); } catch (_) { }
    renderPanel();
  }

  /* ══════════════ 教学段落 ═══════════════════════════════════════════ */
  function composeInstr() {
    const keys = Object.keys(state.tools);
    const L = [];
    L.push(MARK_B);
    L.push("【你可以自己动手（MCP 工具）】");
    L.push("聊天的时候，如果你**真的需要**外面的东西 —— 查一下、翻一下、看一眼 —— 可以自己调工具，");
    L.push("把这一行写在回复的最后：");
    L.push("");
    L.push('[[mcp: 服务名/工具名 {"参数":"值"}]]');
    L.push("");
    if (keys.length) {
      L.push("你现在能用的（**只认这些，别编**）：");
      keys.filter((k) => !isDanger(k.split("/")[1])).forEach((k) => {
        L.push("· " + k + (state.tools[k] ? " —— " + state.tools[k] : ""));
      });
    } else {
      L.push("（现在一个工具都还没接上 —— 连上之后这份清单会自己出现在这里。在那之前不要写这一行。）");
    }
    L.push("");
    L.push("规矩：");
    L.push("· **只在真需要的时候用。**能凭记忆和对话答上来的，就别调 —— 调工具要等你，会慢。");
    L.push("· 一次最多 " + MAX_ACTIONS + " 个。参数必须是合法 JSON，双引号。");
    L.push("· 标记之外**一定要有正常说的话**：先说一句你要去干嘛（「我翻一下」这种就够），再放标记。");
    L.push("· 结果会回到你手里，你接着把话说完 —— 但**别念工具名、别说「根据返回结果」这种话**，");
    L.push("  就像你自己刚想起来一样自然地说出来。");
    L.push("· 调不到就说调不到，别编一个结果。");
    L.push(MARK_E);
    return L.join("\n");
  }
  async function readSys() {
    const d = await memApi("/app/settings");
    return String((d.settings || {}).system_prompt || "");
  }
  async function writeSys(v) {
    await memApi("/app/settings", { method: "PUT", body: JSON.stringify({ system_prompt: v }) });
    lsSet(PERSONA_CACHE_KEY, v);
    return true;
  }
  async function applyInstr(on) {
    const cur = await readSys();
    const i = cur.indexOf(MARK_B), j = cur.indexOf(MARK_E);
    let next;
    if (on) {
      next = (i >= 0 && j > i) ? cur.slice(0, i) + composeInstr() + cur.slice(j + MARK_E.length)
                               : (cur.replace(/\s+$/, "") ? cur.replace(/\s+$/, "") + "\n\n" : "") + composeInstr();
    } else {
      if (i < 0 || j <= i) return false;
      next = (cur.slice(0, i) + cur.slice(j + MARK_E.length)).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
    }
    await writeSys(next);
    return true;
  }
  /* 清单变了（握手过 / 换了服务）→ 段落跟着更新，不然模型手里那份就过期了 */
  async function resyncInstr() {
    if (!state.on) return false;
    try { return await applyInstr(true); } catch (_) { return false; }
  }

  /* ══════════════ 解析 / 剥离 ═════════════════════════════════════════ */
  /* [[mcp: 服务/工具 {json}]]  —— 只认 mcp 这个动作名，别的一律放行（别人的标记不许动） */
  const OPEN = "[[mcp:";
  function parseCalls(text) {
    const s0 = String(text == null ? "" : text);
    if (s0.indexOf(OPEN) < 0) return null;
    const out = [], rest = [];
    let i = 0;
    while (i < s0.length) {
      const p = s0.indexOf(OPEN, i);
      if (p < 0) { rest.push(s0.slice(i)); break; }
      const q = s0.indexOf("]]", p);
      if (q < 0) { rest.push(s0.slice(i)); break; }          /* 没闭合 → 当普通文本 */
      const body = s0.slice(p + OPEN.length, q);
      const call = parseOneCall(body);
      if (!call) { rest.push(s0.slice(i, q + 2)); i = q + 2; continue; }
      rest.push(s0.slice(i, p));
      out.push(call);
      i = q + 2;
    }
    if (!out.length) return null;
    return { calls: out, rest: rest.join("").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "") };
  }
  function parseOneCall(body) {
    let s = String(body || "").trim();
    if (!s) return null;
    let args = {}, jsonPart = "";
    const b = s.indexOf("{");
    if (b >= 0) { jsonPart = s.slice(b).trim(); s = s.slice(0, b).trim(); }
    if (jsonPart) {
      let j = null;
      try { j = JSON.parse(jsonPart); } catch (_) {
        /* 中文引号、单引号这些写歪的，救一下 —— 参数写歪不该让整个动作作废 */
        const fixed = jsonPart.replace(/[“”]/g, '"').replace(/'/g, '"').replace(/,\s*([}\]])/g, "$1");
        try { j = JSON.parse(fixed); } catch (_) { j = null; }
      }
      if (j && typeof j === "object") args = j;
      else if (jsonPart) return null;
    }
    const name = s.replace(/^\s+|\s+$/g, "");
    if (!name) return null;
    return { ref: name, tool: name.indexOf("/") >= 0 ? name.split("/").pop().trim() : name, args: args };
  }
  /* 流式剥半截：只扣「可能正在长成 [[mcp:」的尾巴，别的方括号一律放行 */
  function stripPartial(s) {
    const t = String(s || "");
    const p = t.lastIndexOf("[[");
    if (p < 0) return t;
    const frag = t.slice(p).toLowerCase();
    if ("[[mcp:".indexOf(frag) === 0 || frag.indexOf("[[mcp:") === 0) return t.slice(0, p);
    return t;
  }

  /* ══════════════ 工具卡（本地消息）═══════════════════════════════════ */
  function parseRes(body) {
    const raw = String(body || "").trim();
    if (!raw) return null;
    let j = null;
    try { j = JSON.parse(raw); } catch (_) {
      const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
      if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (_) { } }
    }
    if (!j || typeof j !== "object") return null;
    return j;
  }
  function splitRes(text) {
    const s0 = String(text == null ? "" : text);
    const i = s0.indexOf(RES_B);
    if (i < 0) return null;
    const j = s0.indexOf(RES_E, i);
    if (j < 0) return null;
    const d = parseRes(s0.slice(i + RES_B.length, j));
    if (!d) return null;
    return { data: d, rest: (s0.slice(0, i) + s0.slice(j + RES_E.length)).trim() };
  }
  const STZH = { running: "在调…", ok: "拿到了", bad: "没调成" };
  function cardHtml(d) {
    const cls = d.status === "ok" ? "ok" : (d.status === "bad" ? "bad" : "run");
    const args = d.args && Object.keys(d.args).length ? JSON.stringify(d.args) : "";
    return '<span class="mpc" data-mpc-id="' + esc(d.id) + '">'
      + '<span class="mpc-h"><b>它去调工具了</b><span>' + esc(d.svc || "") + " · " + esc(d.tool || "") + '</span>'
      + '<span class="mpc-st ' + cls + '">' + esc(STZH[d.status] || "") + '</span></span>'
      + (args ? '<span class="mpc-args"><em>' + esc(args.slice(0, 300)) + '</em></span>' : "")
      /* ⚠️ 这里别写 slice(0, PER_CAP)：预算阶段已经截过一次、而且还补了一句「还很长…」，
         再截一次正好把那句说明砍掉 —— 用户只看到一条被硬切掉的结果，不知道是被截的。 */
      + '<span class="mpc-res">' + esc(String(d.result || "").slice(0, DISPLAY_CAP) || "（还没结果）") + '</span>'
      + '<span class="mpc-foot">' + esc(d.foot || "") + '</span>'
      + '</span>';
  }
  /* 排在最后、又不推高 lastId 的办法：照宿主自己的 nextImageId()（max + 0.5）。
     它既 > 所有真实 id（排最后），又不是一个「未来」的时间戳级数字（拉取不会越界）。 */
  function localId() {
    try { if (typeof nextImageId === "function") return nextImageId(); } catch (_) { }
    return "mcp-" + Date.now();
  }
  async function putCard(d) {
    if (typeof window.setMessage !== "function") return null;
    try {
      const id = d.id || localId();
      d.id = id;
      window.setMessage({ id: id, from: "ai", kind: "chat", ts: Date.now(),
        text: RES_B + JSON.stringify({ id: id, svc: d.svc, tool: d.tool, args: d.args,
          status: d.status, result: String(d.result || "").slice(0, DISPLAY_CAP), foot: d.foot || "" }) + RES_E,
        status: "sent", meta: { mcpact: 1 } }, { render: true, cache: false });
      setTimeout(() => { try { if (typeof scrollToBottom === "function") scrollToBottom(); } catch (_) { } }, 220);
      return id;
    } catch (_) { return null; }
  }
  /* 同一张卡改内容：删旧的、插新的（本地消息没有"更新"这条路） */
  function updateCard(d) {
    try {
      if (typeof removeMessage === "function" && d.id != null) removeMessage(d.id, { render: false, cache: false });
    } catch (_) { }
    return putCard(d);
  }

  /* ══════════════ 补全轮：把结果回灌，让它接着说 ═════════════════════ */
  async function historyForModel(n) {
    try {
      const d = await memApi("/app/history?limit=" + (n || 8));
      const items = d.items || d.messages || [];
      return items.filter((m) => m && m.text && m.kind !== "thinking" && m.kind !== "act")
        .slice(-(n || 8))
        .map((m) => ({ role: m.from === "human" ? "user" : "assistant", content: String(m.text).slice(0, 1500) }))
        .filter((m) => m.content && m.content.indexOf("[[") !== 0);   /* 自己写的标记行别当"说过的话"喂回去 */
    } catch (_) { return []; }
  }
  async function completeRound(rawText, results) {
    if (!G || !G.chat) return null;
    const persona = (() => { try { return lsGet(PERSONA_CACHE_KEY).slice(0, 1200); } catch (_) { return ""; } })();
    const sys = (persona ? persona + "\n\n" : "")
      + "你刚刚去调了工具。下面那一段【工具返回】是你自己拿到的，**她看不到这一段**。"
      + "现在接着把话说完，就像你自己刚想起来一样 —— 别念工具名、别说「根据返回结果」，别提到检索或工具。";
    const back = results.map((r) => "· " + r.svc + "/" + r.tool + " → "
      + (r.status === "ok" ? String(r.result || "").slice(0, PER_CAP) : ("没调成：" + (r.result || "")))).join("\n");
    const msgs = [{ role: "system", content: sys }]
      .concat(await historyForModel(6))
      .concat([{ role: "assistant", content: String(rawText || "").slice(0, 2000) },
               { role: "user", content: "【工具返回】（这一段她看不到，别念原文、别提工具）\n" + back }]);
    try {
      const out = await G.chat({ messages: msgs, temperature: 0.85, maxTokens: 600 });
      return String(out || "").trim() || null;
    } catch (e) {
      console.log("[mcp] 补全轮失败", e);
      return null;
    }
  }
  async function memSave(title, content) {
    try {
      await memApi("/app/memory/save", { method: "POST",
        body: JSON.stringify({ kind: "event", title: String(title).slice(0, 42), content: String(content).slice(0, 4000) }) });
      return true;
    } catch (_) { return false; }
  }

  /* ══════════════ 跑一组动作 ═════════════════════════════════════════ */
  async function runCalls(calls, rawText) {
    if (state.busy) return;
    state.busy = true;
    const picked = calls.slice(0, MAX_ACTIONS);
    const dropped = calls.length - picked.length;
    const results = [];
    let used = 0;
    try {
      for (const c of picked) {
        const sv = findServer(c.ref.split("/")[0]) || findServer(c.ref);
        const toolName = sv ? (c.ref.indexOf("/") >= 0 ? c.ref.split("/").pop() : c.tool) : c.tool;
        /* 执行端与注入端同源（toolAllowed 两边都走它） */
        if (!sv || !toolAllowed(sv, toolName)) {
          const why = !sv ? ("没找到这个服务：" + c.ref.split("/")[0] + "（去「自由活动 → 接服务」看看名字）")
                          : (isDanger(toolName) ? ("这个工具被收起来了：" + toolName + " 属于删 / 清 / 执行类，"
                              + "后果不该由它单方面决定 —— 要清要改，让它直接跟你说，由你来点。")
                                                : "这个工具不在允许的清单里（可能没握手过，或者你把这个服务关掉了）");
          results.push({ svc: c.ref.split("/")[0] || "?", tool: toolName, args: c.args, status: "bad", result: why });
          /* ★ 被挡下来也要**插一张卡**：什么都不显示的话，你看不出来它想干什么、
             也看不出来是"被拦了"还是"它没动手" —— 而这正好是最该让你看见的一种。
             （第一版忘了这一步，探针里"最新那张卡"还是上一次的，才露出来。） */
          await putCard({ svc: c.ref.split("/")[0] || "（没有这个服务）", tool: toolName, args: c.args,
            status: "bad", result: why, foot: "这一次没有真的发出去。" });
          continue;
        }
        const card = { svc: sv.name || sv.id, tool: toolName, args: c.args, status: "running", result: "正在调…" };
        card.id = await putCard(card);
        let r;
        try { r = await callTool(sv, toolName, c.args); }
        catch (e) { r = { status: "error", message: (e && e.message) || String(e) }; }
        let res = String(r.message || "");
        const room = Math.min(PER_CAP, BUDGET - used);
        if (res.length > room) {
          res = res.slice(0, Math.max(0, room)) +
            (room <= 0 ? "【本轮工具结果预算已用完，这一段没有再展开】" : "…（还很长，先看这些）");
        }
        used += Math.max(0, Math.min(res.length, room));
        const okd = r.status === "success";
        results.push({ svc: sv.name || sv.id, tool: toolName, args: c.args, _card: card,
          status: okd ? "ok" : "bad", result: res || (okd ? "（空结果）" : "没调成") });
        card.status = okd ? "ok" : "bad";
        card.result = res || (okd ? "（空结果）" : "没调成");
        card.foot = okd ? "" : "失败了也没关系 —— 它会照实说，不会编一个结果给你。";
        updateCard(card);
      }
      if (dropped > 0) {
        const note = "一条回复最多跑 " + MAX_ACTIONS + " 个动作 —— 还有 " + dropped + " 个这次没跑。";
        results.push({ svc: "—", tool: "（还有 " + dropped + " 个没跑）", args: {}, status: "bad", result: note });
        /* ★ 要**让你看见**，不能只塞进回灌的那段里。
           写了标记却看起来毫无反应，它下次就不敢用了 —— 反过来你也不知道它被截了。
           挂在最后一张卡的页脚上，比再插一张卡干净。 */
        const last = results.filter((x) => x._card).pop();
        if (last && last._card) { last._card.foot = note; updateCard(last._card); }
      }
      /* 补全轮 */
      const cont = await completeRound(rawText, results);
      if (cont) {
        try {
          window.setMessage({ id: localId(), from: "ai", kind: "chat", ts: Date.now(), text: cont,
            status: "sent", meta: { mcpact: 1, cont: 1 } }, { render: true, cache: false });
          setTimeout(() => { try { if (typeof scrollToBottom === "function") scrollToBottom(); } catch (_) { } }, 200);
        } catch (_) { }
      }
      /* 写进记忆：不写的话这一轮只在本次会话里，它下次想不起来自己干过这件事 */
      const okOnes = results.filter((x) => x.status === "ok");
      if (okOnes.length) {
        await memSave("自己动手 · " + okOnes[0].tool,
          "我在聊天里自己去调了工具：" + okOnes[0].svc + "/" + okOnes[0].tool + "\n"
          + "拿到的东西：\n" + okOnes.map((x) => String(x.result || "").slice(0, 600)).join("\n\n")
          + (cont ? "\n\n我当时的说法：\n" + cont.slice(0, 600) : ""));
      }
      state.lastRun = { at: Date.now(), results: results, cont: cont || "" };
      state.fresh = true; lsSet(LS_FRESH, "1");
      renderTile();
      renderPanel();
    } finally {
      state.busy = false;
    }
  }

  /* ══════════════ 挂钩 ═══════════════════════════════════════════════ */
  function carryFlags(wrapped, orig) {
    try { Object.keys(orig).forEach((k) => { if (k.indexOf("__") === 0) wrapped[k] = orig[k]; }); } catch (_) { }
  }
  const seenKeys = {};
  function hookSetMessage() {
    if (typeof window.setMessage !== "function" || window.setMessage.__mcp) return false;
    const orig = window.setMessage;
    const wrapped = function (raw, opt) {
      try {
        if (raw && raw.from === "ai" && !state.busy && state.on && !raw.meta) {
          const hit = parseCalls(raw.text);
          if (hit) {
            const clean = Object.assign({}, raw, { text: hit.rest });
            const rt = String(raw.text || "");
            const key = String(raw.id == null ? "" : raw.id);
            if (!seenKeys[key]) {
              seenKeys[key] = 1;
              /* 只在**实时**收到的这条上动手；历史回放不重跑（免得刷个页面又调一次工具） */
              if (liveTide) setTimeout(() => runCalls(hit.calls, rt), 260);
            }
            raw = clean;
          }
        }
      } catch (_) { }
      return arguments.length > 1 ? orig.call(this, raw, opt) : orig.call(this, raw);
    };
    carryFlags(wrapped, orig);
    wrapped.__mcp = true;
    window.setMessage = wrapped;
    return true;
  }
  function hookRenderText() {
    if (typeof window.renderText !== "function" || window.renderText.__mcp) return false;
    const orig = window.renderText;
    const wrapped = function (t) {
      const s0 = String(t == null ? "" : t);
      const sp = splitRes(s0);
      if (sp) {
        return (sp.rest ? orig.call(this, sp.rest) : "") + cardHtml(sp.data);
      }
      /* 流式：半截的 [[mcp: 要当场扣住，否则会从正文里长出来 */
      return orig.call(this, stripPartial(s0));
    };
    carryFlags(wrapped, orig);
    wrapped.__mcp = true;
    window.renderText = wrapped;
    return true;
  }
  function hookMakeMessage() {
    if (typeof window.makeMessage !== "function" || window.makeMessage.__mcp) return false;
    const orig = window.makeMessage;
    const wrapped = function (rowData) {
      const row = orig.apply(this, arguments);
      try {
        const m = rowData && rowData.message;
        if (row && row.classList && m && splitRes(m.text)) {
          row.classList.add("mp-row-card");
          row.classList.remove("grouped");
        }
      } catch (_) { }
      return row;
    };
    carryFlags(wrapped, orig);
    wrapped.__mcp = true;
    window.makeMessage = wrapped;
    return true;
  }
  function hookOnMessage() {
    if (typeof window.onMessage !== "function" || window.onMessage.__mcp) return false;
    const orig = window.onMessage;
    const wrapped = function () {
      liveTide = true;
      try { return orig.apply(this, arguments); } finally { liveTide = false; }
    };
    carryFlags(wrapped, orig);
    wrapped.__mcp = true;
    window.onMessage = wrapped;
    return true;
  }

  /* ══════════════ 上拉面板的磁贴 ═════════════════════════════════════ */
  const TILE = `
    <button class="cs-item mp-tile" type="button" data-mp-tile="1" aria-pressed="false">
      <i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.6h5.2v4h-5.2z"/><path d="M14.3 5.6h5.2v4h-5.2z"/><path d="M4.5 14.4h5.2v4h-5.2z"/><path d="M14.3 14.4h5.2v4h-5.2z"/><path d="M9.7 7.6h4.6"/><path d="M7.1 9.6v4.8"/><path d="M16.9 9.6v4.8"/></svg></i>
      <span>MCP 动作</span>
      <em class="mp-sw" aria-hidden="true"></em>
      <b class="mp-dot" aria-hidden="true"></b>
    </button>`;
  function injectTile() {
    const grid = document.querySelector("#csMain .cs-grid");
    if (!grid) return false;
    if (!grid.querySelector("[data-mp-tile]")) {
      const box = document.createElement("div");
      box.innerHTML = TILE.trim();
      const tile = box.firstElementChild;
      tile.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); open(); });
      grid.appendChild(tile);
    }
    renderTile();
    return true;
  }
  function renderTile() {
    const t = document.querySelector("[data-mp-tile]");
    if (!t) return;
    t.classList.toggle("on", state.on);
    t.classList.toggle("fresh", state.fresh);
    t.setAttribute("aria-pressed", state.on ? "true" : "false");
  }

  /* ══════════════ 整页面板 ═══════════════════════════════════════════ */
  const PANEL = `
    <div class="mp-top">
      <button class="mp-btn" data-mp="close" title="返回">‹</button>
      <div class="mp-t"><b>MCP 动作</b><span class="mp-sub"></span></div>
      <button class="mp-btn" data-mp="sync" title="把清单同步进聊天">✳</button>
    </div>
    <div class="mp-body"><div class="mp-wrap"></div></div>`;
  let elPanel = null;
  function ensurePanel() {
    if (elPanel) return elPanel;
    elPanel = document.createElement("div");
    elPanel.className = "mp-panel hidden";
    elPanel.id = "mcpPanel";
    elPanel.setAttribute("role", "dialog");
    elPanel.setAttribute("aria-modal", "true");
    elPanel.setAttribute("aria-label", "MCP 动作");
    elPanel.innerHTML = PANEL;
    document.body.appendChild(elPanel);
    elPanel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mp]");
      if (b) {
        const w = b.dataset.mp;
        if (w === "close") { close(); return; }
        if (w === "sync") { syncNow(); return; }
      }
      const ck = e.target.closest("[data-mp-allow]");
      if (ck) {
        const sv = servers().filter((x) => (x.name || x.id) === ck.dataset.mpAllow)[0];
        if (sv) { setAllow(sv, !ck.classList.contains("on")); renderPanel(); }
        return;
      }
      const tk = e.target.closest("[data-mp-tool]");
      if (tk) {
        const nm = tk.dataset.mpSrv;
        const sv = servers().filter((x) => (x.name || x.id) === nm)[0];
        if (sv) toggleTool(sv, tk.dataset.mpTool, !tk.classList.contains("on")).catch((er) => toast("改不了：" + ((er && er.message) || er)));
        return;
      }
      const a = e.target.closest("[data-mp-act]");
      if (!a) return;
      const what = a.dataset.mpAct;
      if (what === "handshake") handshake(true).then(renderPanel);
      else if (what === "on") setOn(!state.on);
      else if (what === "test") testNow();
      else if (what === "clear") { state.lastRun = null; state.fresh = false; lsSet(LS_FRESH, ""); renderTile(); renderPanel(); }
      else if (what === "pull") pullTools().then(() => { toast("已按存下来的清单刷新"); renderPanel(); })
                                        .catch((er) => toast("读清单失败：" + ((er && er.message) || er)));
    });
    return elPanel;
  }
  function open() {
    ensurePanel();
    elPanel.classList.remove("hidden");
    requestAnimationFrame(() => elPanel.classList.add("open"));
    renderPanel();                                   /* 先用缓存画出来，别让面板空着等网络 */
    loadServers().then(() => renderPanel()).catch(() => { });
  }
  let closeTimer = 0;
  function close() {
    if (!elPanel) return;
    elPanel.classList.remove("open");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (elPanel && !elPanel.classList.contains("open")) elPanel.classList.add("hidden"); }, 280);
  }
  function renderPanel() {
    if (!elPanel || elPanel.classList.contains("hidden")) return;
    const wrap = $(".mp-wrap", elPanel);
    const sub = $(".mp-sub", elPanel);
    if (!wrap) return;
    const list = servers();
    const keys = Object.keys(state.tools);
    if (sub) sub.textContent = state.on ? (keys.length ? keys.length + " 个工具可用" : "还没有工具清单") : "关着";
    const L = [];
    L.push('<div class="mp-card"><div class="mp-h">开关</div>'
      + '<div class="mp-row"><button class="mp-mini ' + (state.on ? "pri" : "") + '" data-mp-act="on">'
      + (state.on ? "开着（点一下关掉）" : "关着（点一下打开）") + '</button>'
      + '<button class="mp-mini" data-mp-act="sync">把清单同步进聊天</button></div>'
      + '<div class="mp-hint">关掉的话：模型不写标记、写了也不执行、清单也不注入。'
      + '<b>开着才有"动手"这回事。</b>开关状态存在本机，清单存在后端人格里（可撤）。</div></div>');

    L.push('<div class="mp-card"><div class="mp-h"><span>聊天时可以调哪些服务</span>'
      + '<span class="mp-hint">' + list.length + ' 个</span></div>'
      + (list.length ? list.map((sv) => {
          const nm = sv.name || sv.id;
          const st = stateOf(sv);
          const tp = sv.transport === "sse" ? "SSE" : "HTTP";
          return '<div class="mp-sv"><div class="mp-sv-t">'
            + '<em class="mp-dot2 ' + esc(st.s) + '" title="' + esc(st.label) + '"></em>'
            + '<b>' + esc(nm) + '</b>'
            + '<span>' + esc(tp) + (sv.tools ? " · 工具 " + sv.tool_on + "/" + sv.tools : "")
            + (st.ms ? " · " + st.ms + "ms" : "") + " · " + esc(st.label) + '</span></div>'
            + '<button class="mp-ck' + (allowOf(sv) ? " on" : "") + '" type="button" data-mp-allow="' + esc(nm) + '" aria-label="允许"></button></div>';
        }).join("")
        : '<div class="mp-empty"><b>还没有 MCP 服务</b>在「工具与能力 → MCP 设置」里加一个 —— '
          + '这边不另做一套，<b>一处配置两处生效</b>（聊天动作层和自由活动读的是同一份）。</div>')
      + '<div class="mp-hint">点右边那个圆点是「<b>聊天时</b>允许它自己调」的开关；'
      + '传输类型、鉴权头、单个工具的开关都在「工具与能力 → MCP 设置」里改。</div></div>');

    L.push('<div class="mp-card"><div class="mp-h"><span>它能调的工具</span>'
      + '<span class="mp-hint">' + keys.length + ' 个</span></div>'
      + '<div class="mp-row"><button class="mp-mini pri" data-mp-act="handshake">握手并刷新清单</button>'
      + '<button class="mp-mini" data-mp-act="pull">按存下来的清单刷新</button></div>'
      + '<div class="mp-hint">清单是<b>真的问服务器要来的</b>，不是照文档抄的 —— 抄的清单一定和真实部署对不上'
      + '（上过这个当：照源码写的工具名，线上根本没有）。问完存下来，注入永远用存下来的那份。'
      + '<br>右边那个开关是<b>单独关掉某个工具</b>；关掉的不会写进提示词，也不会被执行。</div>'
      + (keys.length ? keys.map((k) => {
          const srvName = k.split("/")[0], toolName = k.split("/").slice(1).join("/");
          const sv = findServer(srvName);
          const deny = isDanger(toolName);
          const off = sv ? toolOffOf(sv, toolName) : false;
          return '<div class="mp-tool' + (deny ? " deny" : "") + (off ? " off" : "") + '">'
            + '<b>' + esc(k) + '</b><span>' + esc(state.tools[k] || "（没有描述）") + '</span>'
            + (deny ? "" : '<button class="mp-ck' + (off ? "" : " on") + '" type="button" data-mp-tool="'
                + esc(toolName) + '" data-mp-srv="' + esc(srvName) + '" aria-label="开关"></button>')
            + '</div>';
        }).join("")
        : '<div class="mp-empty"><b>还没握手过</b>点上面那个按钮问一次。</div>')
      + (keys.some((k) => isDanger(k.split("/")[1]))
        ? '<div class="mp-red" style="margin-top:8px;font-size:11.5px;color:var(--danger,#b06a6f);line-height:1.7">'
          + '划掉的那些被<b>收起来了</b>：删 / 清 / 执行这类，后果不该由它单方面决定。'
          + '要清要改，让它直接跟你说，由你来点。</div>' : "")
      + '</div>');

    L.push('<div class="mp-card"><div class="mp-h">试一段</div>'
      + '<div class="mp-hint">写一段带标记的话，看它到底认出了什么、跑了没有、回灌了多少字 ——'
      + '动作层是黑盒的话，出了事只能猜。</div>'
      + '<textarea class="mp-ta" id="mpTest" placeholder="例：我翻一下我们之前说的那件事 &#10;[[mcp: 服务名/工具名 {&quot;关键词&quot;:&quot;香草&quot;}]]"></textarea>'
      + '<div class="mp-row"><button class="mp-mini pri" data-mp-act="test">跑一下（真的会调）</button>'
      + (state.lastRun ? '<button class="mp-mini warn" data-mp-act="clear">清掉下面这次结果</button>' : "")
      + '</div>'
      + (state.lastRun ? '<div class="mp-out">' + state.lastRun.results.map((r) =>
            '<div class="mp-tool"><b>' + esc(r.svc + "/" + r.tool) + '</b>'
            + '<span class="' + (r.status === "ok" ? "mp-ok" : "mp-bad") + '">'
            + (r.status === "ok" ? "拿到了 " + String(r.result || "").length + " 字" : "没调成") + '</span>'
            + '<div class="mp-lv">' + esc(String(r.result || "").slice(0, 500)) + '</div></div>').join("")
          + (state.lastRun.cont ? '<div class="mp-tool"><b>它接着说的话</b><div class="mp-lv">'
              + esc(state.lastRun.cont.slice(0, 500)) + '</div></div>' : "")
          + '</div>' : "")
      + '</div>');
    wrap.innerHTML = L.join("");
  }

  async function syncNow() {
    try { await resyncInstr(); toast(state.on ? "清单同步进聊天了" : "先打开开关再同步"); }
    catch (e) { toast("同步失败：" + ((e && e.message) || e)); }
  }
  async function setOn(v) {
    state.on = !!v;
    lsSet(LS_ON, v ? "1" : "");
    renderTile(); renderPanel();
    try {
      await applyInstr(state.on);
      toast(state.on ? "开着 —— 它现在可以自己动手了" : "关掉了 —— 标记一律不执行");
    } catch (e) {
      state.on = !v; lsSet(LS_ON, state.on ? "1" : ""); renderTile(); renderPanel();
      toast("改不了：" + ((e && e.message) || e));
    }
  }
  async function testNow() {
    const box = document.getElementById("mpTest");
    const text = (box && box.value || "").trim();
    if (!text) { toast("先在上面写一段带标记的话"); return; }
    const hit = parseCalls(text);
    if (!hit) { toast("这一段里没认出 [[mcp: …]] —— 再看看格式"); return; }
    close();
    await runCalls(hit.calls, text);
    renderPanel();
  }

  /* ══════════════ 初始化 ═════════════════════════════════════════════ */
  function init() {
    ensurePanel();
    injectTile();
    /* 打开就顺手把后端那份服务器摘要拉回来（失败也不吵 —— 面板会显示"没有服务"） */
    loadServers().catch(() => { });
    hookRenderText();
    hookSetMessage();
    hookMakeMessage();
    hookOnMessage();
    try {
      const mo = new MutationObserver(() => { if (!document.querySelector("[data-mp-tile]")) injectTile(); });
      const sheet = document.getElementById("cSheet");
      if (sheet) mo.observe(sheet, { childList: true, subtree: true });
    } catch (_) { }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.McpPack = {
    open: open, close: close,
    on: () => state.on, setOn: setOn,
    handshake: handshake, sync: syncNow,
    loadServers: loadServers, pullTools: pullTools, toggleTool: toggleTool,
    servers: servers, tools: () => state.tools,
    state: () => ({ on: state.on, tools: state.tools, allow: state.allow, lastRun: state.lastRun }),
    _init: init,
    _parse: parseCalls,
    _strip: stripPartial,
    _splitRes: splitRes,
    _allowed: (svName, tool) => toolAllowed(findServer(svName), tool),
    _danger: isDanger,
    _setOn: (v) => { state.on = !!v; lsSet(LS_ON, v ? "1" : ""); renderTile(); return state.on; },
    _run: (calls, raw) => runCalls(calls, raw),
    _instr: composeInstr,
    _panel: () => elPanel
  };
})();
