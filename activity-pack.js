/* ═══════════════════════════════════════════════════════════════════════════
   Tidal Echo · 自由活动 — 逻辑层
   ───────────────────────────────────────────────────────────────────────────
   范式来源：death34018-hue/AionsHome 的「娱乐室」
     （MCP 服务接入 + AI 自主探索 + 行动日志 + 经历总结归档）
   落到本前端：左侧菜单一个整页面板，三件事 ——
     ① 设时间：让 TA 在什么时段、每隔多久、每天最多几次自己出门逛一趟
     ② 接服务：远程 MCP（HTTP/Streamable HTTP）一个或多个，工具自动发现
     ③ 带回的东西写进记忆：跑完由模型总结成一条，写进宿主记忆库（7 个分区可选）

   ── ⚠️ 两条硬限制，先说清楚（别让人以为它能 24 小时自己跑）────────────────
   1 **只有页面开着才会跑。** 这是个静态 PWA，浏览器里没有常驻进程 ——
     页面关掉就是关掉。所以调度是「页面开着时每分钟检查一次 + 回到前台立刻补检」，
     错过的时段会在下次打开时补一次（记在 lastRun 里）。
   2 **真正 7×24 得放到后端。** 你这套已经有 relay 后端（`/app/*` 那一族）——
     把这个配置搬成后端的一个定时任务即可，前端这份配置就是它的草稿。
   本包不假装自己能常驻。

   ── 与宿主的接缝 ──────────────────────────────────────────────────────────
   记忆写入复用宿主**已有的**接口，不新造一套：
     memApi("/app/memory/save", { kind, title, content })   ← 宿主记忆页「新建一条」用的同一个
   分区取值来自宿主的 LIB_DEFS（event / ref / working / summary / story / room / letter）。
   这些是宿主的顶层 function/const，同处一个全局词法环境，所以能按名字直接引用；
   全部读取包在 try/catch 里，缺了就降级（预览页里没有，会明确告诉你"写不了记忆"）。
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const K_ACT = "companion_activity";
  const RUN_CAP = 30;

  /* 宿主 LIB_DEFS 的兜底副本（分区口径与之一致） */
  const KIND_FALLBACK = [
    { kind: "event",   name: "事件" },
    { kind: "ref",     name: "参考资料" },
    { kind: "working", name: "工作记忆" },
    { kind: "summary", name: "摘要" },
    { kind: "story",   name: "故事" },
    { kind: "room",    name: "我的房间" },
    { kind: "letter",  name: "留给西西的话" }
  ];

  const CFG_DEFAULT = {
    on: false,
    from: 9, to: 23,        // 活动时段（小时，含 from、不含 to）
    everyMin: 120,          // 两次之间至少隔多少分钟
    maxPerDay: 3,           // 每天最多跑几次
    maxSteps: 8,            // 一轮最多几次工具调用
    memOn: true,            // 跑完自动写入记忆
    memKind: "event",       // 写进哪个分区
    memConfirm: false,      // 写之前问一下
    cardOn: true,           // 跑完把这一趟做成一张卡发到聊天里（Topic Pool）
    goal: "",               // 这次自由活动要做什么（用户填）
    persona: "",            // 以什么身份去（留空 = 用主聊天的人格）
    model: { provider: "cloud:deepseek", model: "deepseek-chat", temp: 0.85, connId: "" }
  };

  /* ════════════════════════════ 宿主接缝 ════════════════════════════ */
  function hostApi() {
    const H = {};
    try { H.PROVIDERS = (typeof PROVIDERS !== "undefined") ? PROVIDERS : null; } catch (_) { H.PROVIDERS = null; }
    try { H.cloudHost = (typeof cloudHost === "function") ? cloudHost : null; } catch (_) { H.cloudHost = null; }
    try { H.cloudToken = (typeof cloudToken === "function") ? cloudToken : null; } catch (_) { H.cloudToken = null; }
    try { H.connChatUrl = (typeof connChatUrl === "function") ? connChatUrl : null; } catch (_) { H.connChatUrl = null; }
    try { H.connHeaders = (typeof connHeaders === "function") ? connHeaders : null; } catch (_) { H.connHeaders = null; }
    try { H.loadConns = (typeof loadConnections === "function") ? loadConnections : null; } catch (_) { H.loadConns = null; }
    try { H.memApi = (typeof memApi === "function") ? memApi : null; } catch (_) { H.memApi = null; }
    try { H.LIB_DEFS = (typeof LIB_DEFS !== "undefined") ? LIB_DEFS : null; } catch (_) { H.LIB_DEFS = null; }
    try { H.toast = (typeof showToast === "function") ? showToast : null; } catch (_) { H.toast = null; }
    try { H.escapeHtml = (typeof escapeHtml === "function") ? escapeHtml : null; } catch (_) { H.escapeHtml = null; }
    return H;
  }
  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  function toast(m) { const H = hostApi(); if (H.toast) H.toast(m); }

  const FALLBACK_PROVIDERS = {
    "cloud:deepseek": { name: "☁ 云端 · DeepSeek", ver: "v1", models: ["deepseek-chat", "deepseek-reasoner"] },
    "cloud:moonshot": { name: "☁ 云端 · Kimi", ver: "v1", models: ["kimi-k2-0711-preview", "moonshot-v1-8k"] },
    "cloud:zhipu":    { name: "☁ 云端 · 智谱 GLM", ver: "v4", models: ["glm-4-plus", "glm-4-flash"] },
    "cloud:qwen":     { name: "☁ 云端 · 阿里百炼", ver: "v1", models: ["qwen-plus", "qwen-max"] },
    "deepseek": { name: "直连 · DeepSeek", root: "https://api.deepseek.com", ver: "v1", models: ["deepseek-chat"] },
    "custom":   { name: "自定义", root: "", ver: "v1", models: [] }
  };
  function providerTable() {
    const H = hostApi();
    return (H.PROVIDERS && Object.keys(H.PROVIDERS).length) ? H.PROVIDERS : FALLBACK_PROVIDERS;
  }
  const pvOf = (pid) => providerTable()[pid] || null;
  const isCloudPid = (pid) => /^cloud:/.test(pid || "");
  function completeUrl(root, ver, tail) {
    root = String(root || "").trim().replace(/\/+$/, "");
    if (!root) return "";
    if (root.slice(-tail.length) === "/" + tail) return root;
    if (/(^|\/)v\d+$/i.test(root)) return root + "/" + tail;
    return root + "/" + (ver || "v1") + "/" + tail;
  }
  function resolveModel(slot) {
    const H = hostApi();
    if (slot.connId && H.loadConns && H.connChatUrl) {
      let list = []; try { list = H.loadConns() || []; } catch (_) { }
      const c = list.find((x) => x && x.id === slot.connId);
      if (c) {
        const url = H.connChatUrl(c);
        if (url) return { url, headers: H.connHeaders ? H.connHeaders(c) : { "Content-Type": "application/json" },
          model: slot.model || c.model || "", label: c.name || "-" };
      }
    }
    const pid = slot.provider || "";
    if (!pid) return null;
    const pv = pvOf(pid) || {};
    const model = slot.model || (pv.models && pv.models[0]) || "";
    if (isCloudPid(pid)) {
      const host = H.cloudHost ? H.cloudHost() : "";
      if (!host) return null;
      const headers = { "Content-Type": "application/json" };
      const tk = H.cloudToken ? H.cloudToken() : "";
      if (tk) headers["X-Relay-Token"] = tk;
      return { url: host.replace(/\/+$/, "") + "/relay/" + pid.replace(/^cloud:/, "") + "/" + (pv.ver || "v1") + "/chat/completions",
        headers, model, label: pv.name || pid };
    }
    const root = pv.root || "";
    if (!root) return null;
    return { url: completeUrl(root, pv.ver, "chat/completions"), headers: { "Content-Type": "application/json" }, model, label: pv.name || pid };
  }

  /* ════════════════════════════ 状态 ════════════════════════════ */
  const state = {
    cfg: JSON.parse(JSON.stringify(CFG_DEFAULT)),
    servers: [],        // { id, name, url, token, on, status, tools:[{name,description}], err }
    log: [],            // 当前/最近一次运行的步骤
    runs: [],           // 历史
    today: "",          // 计数所属日期
    todayCount: 0,
    lastRun: 0,
    running: false,
    abort: false,
    ctrl: null,
    nextCheck: 0
  };
  let seq = 0;
  const nid = (p) => p + "_" + Date.now().toString(36) + "_" + (++seq).toString(36);
  const $ = (s, root) => (root || document).querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function lsRead(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }
  function lsWrite(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { } }
  function load() {
    const d = lsRead(K_ACT, null) || {};
    state.cfg = Object.assign(JSON.parse(JSON.stringify(CFG_DEFAULT)), d.cfg || {});
    state.cfg.model = Object.assign(JSON.parse(JSON.stringify(CFG_DEFAULT.model)), (d.cfg && d.cfg.model) || {});
    state.servers = Array.isArray(d.servers) ? d.servers.map((s) => Object.assign({ on: true, status: "", tools: [] }, s)) : [];
    state.runs = Array.isArray(d.runs) ? d.runs : [];
    state.today = d.today || "";
    state.todayCount = d.todayCount || 0;
    state.lastRun = d.lastRun || 0;
    const t = dayKey(Date.now());
    if (state.today !== t) { state.today = t; state.todayCount = 0; }
  }
  function save() {
    lsWrite(K_ACT, {
      cfg: state.cfg, servers: state.servers, runs: state.runs.slice(-RUN_CAP),
      today: state.today, todayCount: state.todayCount, lastRun: state.lastRun
    });
  }
  const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };
  const fmtT = (ts) => {
    const d = new Date(ts), p = (x) => String(x).padStart(2, "0");
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  };

  /* ════════════════════════════ MCP 客户端 ════════════════════════════
     与大富翁那套同一形状：initialize 握手 → tools/list / tools/call，
     响应同时吃 JSON 与 SSE。只支持**远程 HTTP**，浏览器里没有 stdio。 */
  const rpc = {};   // serverId -> { id, session, ready }

  async function mcpPost(sv, body, wantSession) {
    const url = String(sv.url || "").trim();
    if (!url) throw new Error("这个服务还没填地址");
    const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
    if (sv.token) headers["Authorization"] = "Bearer " + sv.token;
    const st = rpc[sv.id] || (rpc[sv.id] = { id: 0, session: null, ready: false });
    if (st.session) headers["Mcp-Session-Id"] = st.session;
    let res;
    try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) }); }
    catch (e) {
      throw new Error("连不上（" + url + "）。三个常见原因：不是 HTTPS（页面是 HTTPS，会被按混合内容拦掉）、"
        + "没回 CORS 头、服务器防火墙/安全组没放这个端口。（" + ((e && e.message) || e) + "）");
    }
    const sid = wantSession ? res.headers.get("Mcp-Session-Id") : null;
    const raw = await res.text();
    if (!res.ok) {
      let d = "HTTP " + res.status;
      try { const j = JSON.parse(raw); if (j && j.error && j.error.message) d = j.error.message; } catch (_) { }
      throw new Error(d);
    }
    let msg = null;
    if (/^data:/m.test(raw)) {
      for (const l of raw.split(/\r?\n/)) {
        const t = l.trim();
        if (!t.startsWith("data:")) continue;
        const d = t.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try { const j = JSON.parse(d); if (j && (j.result || j.error)) { msg = j; break; } } catch (_) { }
      }
    }
    if (!msg) { try { msg = JSON.parse(raw); } catch (_) { } }
    if (!msg) throw new Error("返回了看不懂的东西：" + String(raw).slice(0, 90));
    if (msg.error) throw new Error(msg.error.code + "：" + (msg.error.message || ""));
    return { result: msg.result, sid };
  }
  async function mcpHello(sv, force) {
    const st = rpc[sv.id] || (rpc[sv.id] = { id: 0, session: null, ready: false });
    if (st.ready && !force) return;
    const r = await mcpPost(sv, {
      jsonrpc: "2.0", id: ++st.id, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tidal-echo-activity", version: "1" } }
    }, true);
    if (r.sid) st.session = r.sid;
    st.ready = true;
    mcpPost(sv, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false).catch(() => { });
  }
  async function mcpReq(sv, method, params) {
    const st = rpc[sv.id] || (rpc[sv.id] = { id: 0, session: null, ready: false });
    await mcpHello(sv, false).catch(() => { });     // 有些部署不要求握手
    const once = () => mcpPost(sv, { jsonrpc: "2.0", id: ++st.id, method, params: params || {} }, false);
    try { return await once(); }
    catch (e) {
      if (/session|initialized|初始化/i.test(String((e && e.message) || ""))) {
        st.ready = false; st.session = null;
        await mcpHello(sv, true);
        return await once();
      }
      throw e;
    }
  }
  async function mcpTools(sv) {
    const r = await mcpReq(sv, "tools/list", {});
    const arr = ((r.result || {}).tools) || [];
    return arr.map((t) => ({ name: t.name, description: t.description || "", schema: t.inputSchema || { type: "object", properties: {} } }));
  }
  async function mcpCall(sv, name, args) {
    const r = await mcpReq(sv, "tools/call", { name, arguments: args || {} });
    const res = r.result || {};
    const text = ((res.content) || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
    let data = res.structuredContent || null;
    if (!data) { try { data = JSON.parse(text); } catch (_) { } }
    return { text, data, isError: !!res.isError };
  }

  /* 工具名要带上服务前缀，多个服务的同名工具才不会打架。
     OpenAI 的 function name 只允许 [a-zA-Z0-9_-]，所以前缀也必须干净 —— 服务 id 是自动生成的 s1/s2。 */
  const toolKey = (sv, name) => sv.id + "__" + String(name).replace(/[^a-zA-Z0-9_-]/g, "_");
  function allTools() {
    const out = [];
    state.servers.filter((s) => s.on && s.tools && s.tools.length).forEach((sv) => {
      sv.tools.forEach((t) => out.push({ sv, name: t.name, key: toolKey(sv, t.name), description: t.description, schema: t.schema }));
    });
    return out;
  }
  function findTool(key) { return allTools().find((t) => t.key === key) || null; }

  async function probe(sv) {
    sv.status = "probing"; sv.err = ""; render();
    try {
      sv.tools = await mcpTools(sv);
      sv.status = "ok";
      sv.err = "";
    } catch (e) {
      sv.status = "bad"; sv.tools = [];
      sv.err = (e && e.message) || String(e);
    }
    save(); render();
  }

  /* ════════════════════════════ 模型调用（非流式，要 tool_calls）════════════════════════════ */
  async function callJson(messages, tools, signal) {
    const conn = resolveModel(state.cfg.model);
    if (!conn) throw new Error("还没配模型 —— 到「模型」那张卡里选一个连接或云端预设。");
    if (!conn.model) throw new Error("没填模型名。");
    const body = { model: conn.model, messages, temperature: (state.cfg.model.temp != null ? state.cfg.model.temp : 0.85) };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
    const res = await fetch(conn.url, { method: "POST", headers: conn.headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      let d = "HTTP " + res.status;
      try { const j = await res.json(); if (j && j.error && j.error.message) d = j.error.message; } catch (_) { }
      throw new Error(d);
    }
    const j = await res.json();
    return (j && j.choices && j.choices[0] && j.choices[0].message) || {};
  }

  function logStep(kind, title, body) {
    state.log.push({ ts: Date.now(), kind, title: String(title || ""), body: String(body || "").slice(0, 1200) });
    if (state.log.length > 120) state.log = state.log.slice(-120);
    renderLog();
  }

  /* ════════════════════════════ 自由活动：一轮 ════════════════════════════ */
  function sysPrompt() {
    const H = hostApi();
    const kinds = (H.LIB_DEFS || KIND_FALLBACK).map((k) => k.kind + "（" + k.name + "）").join(" / ");
    return [
      "现在是你的「自由活动」时间：没有人跟你说话，这一段是你自己的。",
      "你可以用给你的工具去逛逛，看看有没有值得带回来的东西。",
      "",
      state.cfg.persona ? "【你是谁】\n" + state.cfg.persona : "",
      "【这次的目标】\n" + (state.cfg.goal || "随便逛逛 —— 你自己决定去哪、看什么。"),
      "",
      "【规矩】",
      "· 只说你**真从工具里拿到**的东西，拿不到就说拿不到，绝对不许编。",
      "· 每调一个工具之前先想清楚为什么调它；调完简短说一句你看到了什么。",
      "· 逛够了就停下。不要为了凑次数硬调工具。",
      "· 最后用一小段话收尾：你去了哪、看到了什么、有什么值得记住的。这段会写进记忆。",
      "· 不要输出与这次活动无关的寒暄，也不要假装是用户在跟你说话。",
      "",
      "【记忆分区（收尾时选一个说清楚）】" + kinds
    ].filter(Boolean).join("\n");
  }

  async function runOnce(trigger) {
    if (state.running) return null;
    const tools = allTools();
    if (!tools.length) {
      logStep("think", "没得逛", "一个可用工具都没有 —— 先在「MCP 服务」里加一个并点「测连通」。");
      return null;
    }
    state.running = true; state.abort = false; state.ctrl = new AbortController();
    state.log = [];
    logStep("think", "出门了", "触发方式：" + trigger + " · 可用工具 " + tools.length + " 个（来自 " +
      state.servers.filter((s) => s.on && s.tools.length).length + " 个服务）");
    render();

    const apiTools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.key,
        description: (t.description || t.name) + "（来自 " + (t.sv.name || t.sv.id) + "）",
        parameters: (t.schema && t.schema.type) ? t.schema : { type: "object", properties: {} }
      }
    }));
    const msgs = [{ role: "system", content: sysPrompt() }];
    const usedTools = [];
    let summary = "", failed = null;

    try {
      msgs.push({ role: "user", content: "开始吧。" });
      for (let step = 0; step < clamp(state.cfg.maxSteps, 1, 20); step++) {
        if (state.abort) { logStep("think", "停下了", "你按了停止。"); break; }
        const out = await callJson(msgs, apiTools, state.ctrl.signal);
        if (out.content && String(out.content).trim()) logStep("say", "它说", String(out.content).trim());
        if (out.tool_calls && out.tool_calls.length) {
          msgs.push(out);
          for (const tc of out.tool_calls) {
            const key = tc.function && tc.function.name;
            const t = findTool(key);
            let args = {};
            try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { }
            if (!t) {
              logStep("tool", "找不到工具", key);
              msgs.push({ role: "tool", tool_call_id: tc.id, content: "没有这个工具：" + key });
              continue;
            }
            usedTools.push(t.sv.name + "/" + t.name);
            let r;
            try { r = await mcpCall(t.sv, t.name, args); }
            catch (e) { r = { text: "调用失败：" + ((e && e.message) || e), isError: true }; }
            logStep("tool", t.sv.name + " · " + t.name,
              JSON.stringify(args) + "\n" + String(r.text || "").slice(0, 600) + (r.isError ? "  ⚠ 调用报错" : ""));
            msgs.push({ role: "tool", tool_call_id: tc.id, content: String(r.text || "").slice(0, 6000) });
          }
          continue;
        }
        summary = String(out.content || "").trim();
        break;
      }
      if (!summary) {
        /* 工具跑完了但模型没给收尾 —— 再要一次，不要拿工具输出硬凑 */
        try {
          msgs.push({ role: "user", content: "停下来，用一小段话收尾：你去了哪、看到了什么、有什么值得记住的。" });
          const fin = await callJson(msgs, null, state.ctrl.signal);
          summary = String(fin.content || "").trim();
          if (summary) logStep("say", "收尾", summary);
        } catch (_) { }
      }
    } catch (e) {
      failed = (e && e.message) || String(e);
      logStep("think", "出岔子了", failed);
    }

    /* 写记忆 —— 只在真拿到东西、且真有总结时写 */
    let memOk = false, memMsg = "";
    if (state.cfg.memOn && summary && !failed) {
      if (state.cfg.memConfirm && !confirm("这次活动的总结写好了一版：\n\n" + summary + "\n\n写进记忆吗？")) {
        memMsg = "你选择先不写。";
        logStep("think", "没写记忆", memMsg);
      } else {
        try {
          await memSave(summary, usedTools, trigger);
          memOk = true;
          memMsg = "已写进「" + kindName(state.cfg.memKind) + "」";
          logStep("think", "带回记忆", memMsg);
        } catch (e) {
          memMsg = (e && e.message) || String(e);
          logStep("think", "记忆没写上", memMsg);
        }
      }
    }

    state.running = false; state.ctrl = null;
    state.lastRun = Date.now();
    state.today = dayKey(Date.now());
    state.todayCount += 1;
    const rec = { rid: "r" + Date.now().toString(36), ts: Date.now(), trigger, steps: state.log.length,
      tools: usedTools, summary, memOk, memMsg, failed };
    state.runs.push(rec);
    state.runs = state.runs.slice(-RUN_CAP);
    save(); render();
    /* 把这一趟做一张卡发到聊天里 —— 放在最后：卡片要读 summary/tools，两者此刻才齐 */
    if (state.cfg.cardOn && summary && !failed) sendCard(rec);
    return summary;
  }

  /* ── 把「这一趟」做成一张卡：去过哪（MCP 服务/工具）、看到什么（总结）────────
     内容是用户要的那两样：**用 MCP 带回来的总结** + **在哪里玩的**。
     真正的发送交给 topic-pack（它负责把卡塞进聊天）。 */
  function topicPayload(r) {
    const sum = String((r && r.summary) || "").trim();
    const lines = sum.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const title = (lines[0] || "出去逛了一趟").slice(0, 60);
    const body = (lines.length > 1 ? lines.slice(1).join("\n") : sum).slice(0, 2000);
    const urls = (sum.match(/https?:\/\/[^\s<>"'）)】]+/g) || []).slice(0, 6);
    const tools = Array.from(new Set(r && r.tools || []));
    const src = [
      tools.length ? "去过：" + tools.join("、") : "",
      urls.length ? urls.join("\n") : ""
    ].filter(Boolean).join("\n");
    return { title, body, src, when: fmtT(r.ts), from: "自由活动 · " + (r.trigger || "") };
  }
  function sendCard(r) {
    if (!r || !String(r.summary || "").trim()) { toast("这一趟没有总结，没什么可发的"); return null; }
    if (!window.TopicCard) { toast("卡片模块没加载（独立预览页里发不了）"); return null; }
    const id = window.TopicCard.send(topicPayload(r));
    if (id) toast("已发到聊天 —— 去聊天界面看那张卡");
    return id || null;
  }

  /* ── 写入宿主记忆（复用宿主记忆页「新建一条」的同一个接口）────────────── */
  function kindName(k) {
    const H = hostApi();
    const d = (H.LIB_DEFS || KIND_FALLBACK).find((x) => x.kind === k);
    return d ? d.name : k;
  }
  async function memSave(summary, usedTools, trigger) {
    const H = hostApi();
    if (!H.memApi) throw new Error("宿主没有记忆接口（独立预览页里写不了；正式页面里才行）");
    const first = String(summary).split(/\n/)[0].trim();
    const title = ("自由活动 · " + first).slice(0, 42);
    const content = [
      summary,
      "",
      "—— 自由活动记录 ——",
      "时间：" + fmtT(Date.now()) + "（" + trigger + "）",
      usedTools.length ? "用到的工具：" + Array.from(new Set(usedTools)).join("、") : ""
    ].filter(Boolean).join("\n");
    await H.memApi("/app/memory/save", {
      method: "POST",
      body: JSON.stringify({ kind: state.cfg.memKind, title, content })
    });
  }
  async function memCount() {
    const H = hostApi();
    if (!H.memApi) return null;
    try { return await H.memApi("/app/memory/list?limit=1"); } catch (_) { return null; }
  }

  /* ════════════════════════════ 调度 ════════════════════════════
     页面开着才跑 —— 每分钟检查一次，回到前台立刻补检一次。 */
  function inWindow(d) {
    const h = d.getHours();
    const f = clamp(+state.cfg.from, 0, 23), t = clamp(+state.cfg.to, 0, 24);   // to 允许 24 = 到午夜
    return (f <= t) ? (h >= f && h < t) : (h >= f || h < t);   // 跨零点也支持
  }
  function dueAt() {
    if (!state.cfg.on) return 0;
    if (state.running) return 0;
    if (state.today !== dayKey(Date.now())) { state.today = dayKey(Date.now()); state.todayCount = 0; }
    if (state.todayCount >= clamp(state.cfg.maxPerDay, 1, 24)) return 0;
    const gap = clamp(state.cfg.everyMin, 5, 1440) * 60000;
    const next = Math.max(state.lastRun + gap, 0);
    return next;
  }
  function tick() {
    state.nextCheck = Date.now() + 60000;
    if (!state.cfg.on || state.running) return;
    if (!inWindow(new Date())) return;
    if (state.todayCount >= clamp(state.cfg.maxPerDay, 1, 24)) return;
    if (Date.now() - state.lastRun < clamp(state.cfg.everyMin, 5, 1440) * 60000) return;
    /* 页面打开/回到前台时把错过的那一次补上（不补多次） */
    runOnce(state.lastRun ? "补一次（页面重新打开）" : "第一次跑");
  }
  let timer = null;
  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 60000);
  }

  /* ════════════════════════════ 渲染 ════════════════════════════ */
  let elPanel, elBody, elTitle, elSub;

  function render() {
    if (!elPanel) return;
    elSub.textContent = state.cfg.on
      ? (state.running ? "正在外面逛…" : "开着 · 今天已跑 " + state.todayCount + "/" + state.cfg.maxPerDay + " 次")
      : "关着";
    elBody.innerHTML = [
      cardRun(), cardSchedule(), cardServers(), cardGoal(), cardMemory(), cardLog(), cardRuns(), cardModel()
    ].join("");
  }
  const card = (t, n, body, act) =>
    `<div class="act-card">
      <div class="act-card-t"><span>${esc(t)}</span>${n != null ? `<span class="n">${esc(n)}</span>` : ""}
        ${act ? `<button data-act="${act.a}">${esc(act.t)}</button>` : ""}</div>
      ${body}</div>`;

  function cardRun() {
    const tools = allTools().length;
    const next = dueAt();
    return card("现在", null,
      `<div class="act-switch">
        <div class="t">自由活动总开关
          <small>开了之后，在下面的时段里它才会自己出门。关着就完全不动。</small></div>
        <button class="act-sw${state.cfg.on ? " on" : ""}" data-act="on"></button>
      </div>
      <div class="act-note">当前可用工具 <b>${tools}</b> 个 ·
        服务 <b>${state.servers.filter((s) => s.on).length}</b> 个 ·
        上次活动 <b>${state.lastRun ? esc(fmtT(state.lastRun)) : "还没跑过"}</b>
        ${state.cfg.on && next ? " · 下一轮最早 <b>" + esc(fmtT(next)) + "</b>" : ""}</div>
      <div class="act-macts">
        <button class="act-btn" data-act="run"${state.running ? " disabled" : ""}>${state.running ? "正在逛…" : "现在就跑一次"}</button>
        ${state.running ? `<button class="act-btn danger" data-act="stop">停止</button>` : ""}
      </div>
      <div class="act-note"><b>⚠️ 只有这个页面开着它才会跑。</b>
        浏览器里没有常驻进程，关掉页面就是关掉。回到前台会自动补检一次。
        真要 7×24，得把这份配置搬到你的 relay 后端去当定时任务 —— 这份配置就是它的草稿。</div>`);
  }

  function cardSchedule() {
    return card("时间表", null,
      `<div class="act-two">
        <div><label class="act-lbl">从几点开始</label>
          <input class="act-in" type="number" min="0" max="23" data-f="from" value="${esc(state.cfg.from)}"></div>
        <div><label class="act-lbl">到几点结束</label>
          <input class="act-in" type="number" min="0" max="24" data-f="to" value="${esc(state.cfg.to)}"></div>
      </div>
      <div class="act-two">
        <div><label class="act-lbl">两次之间至少隔（分钟）</label>
          <input class="act-in" type="number" min="5" max="1440" step="5" data-f="everyMin" value="${esc(state.cfg.everyMin)}"></div>
        <div><label class="act-lbl">每天最多几次</label>
          <input class="act-in" type="number" min="1" max="24" data-f="maxPerDay" value="${esc(state.cfg.maxPerDay)}"></div>
      </div>
      <label class="act-lbl">一轮最多调几次工具</label>
      <input class="act-in" type="number" min="1" max="20" data-f="maxSteps" value="${esc(state.cfg.maxSteps)}">
      <div class="act-note">时段可以跨零点（比如 22 到 6）。</div>`);
  }

  function cardServers() {
    const body = state.servers.map((sv) => {
      const st = sv.status === "ok" ? `<span class="st ok">连得上</span>`
        : sv.status === "bad" ? `<span class="st bad">连不上</span>`
          : sv.status === "probing" ? `<span class="st">测试中…</span>` : `<span class="st">没测过</span>`;
      return `<div class="act-sv">
        <div class="act-sv-h">
          <button class="act-sw${sv.on ? " on" : ""}" data-act="sv-on" data-id="${esc(sv.id)}" style="width:34px;height:20px"></button>
          <b>${esc(sv.name || sv.id)}</b>${st}
          <button class="x" data-act="sv-del" data-id="${esc(sv.id)}" aria-label="删除">✕</button>
        </div>
        <input class="act-in" data-sv="name" data-id="${esc(sv.id)}" value="${esc(sv.name || "")}" placeholder="给它起个名字">
        <input class="act-in" data-sv="url" data-id="${esc(sv.id)}" value="${esc(sv.url || "")}" placeholder="https://…/mcp （必须是 HTTPS）" style="margin-top:6px">
        <input class="act-in" data-sv="token" data-id="${esc(sv.id)}" value="${esc(sv.token || "")}" placeholder="访问 token（服务端设了才要填）" style="margin-top:6px">
        <div class="act-macts">
          <button class="act-btn ghost" data-act="sv-probe" data-id="${esc(sv.id)}">测连通 / 发现工具</button>
        </div>
        ${(sv.tools && sv.tools.length)
          ? `<div class="act-tools">发现 ${sv.tools.length} 个工具：${esc(sv.tools.map((t) => t.name).join("、"))}</div>`
          : ""}
        ${sv.err ? `<div class="act-warn">${esc(sv.err)}</div>` : ""}
      </div>`;
    }).join("");

    return card("MCP 服务", state.servers.length,
      (state.servers.length ? body : `<div class="act-note" style="margin-top:0">还没接服务。加一个远程 MCP 地址就能用 ——
        浏览器里只能走 <b>远程 HTTP</b>，没有 stdio（那是本地进程的事）。</div>`)
      + `<button class="act-btn ghost" data-act="sv-add" style="margin-top:9px">＋ 加一个服务</button>
      <div class="act-note"><b>三个前提缺一不可：</b>地址必须是 <b>HTTPS</b>（本页是 HTTPS，HTTP 会被按混合内容拦掉）、
        服务端要回 <b>CORS 头</b>、服务器防火墙/安全组要放行该端口。</div>`,
      { a: "sv-all", t: "全部重测" });
  }

  function cardGoal() {
    return card("活动目标", null,
      `<textarea class="act-ta" rows="3" data-f="goal" placeholder="留空 = 随便逛逛，它自己决定去哪、看什么。&#10;想定向就写清楚，例如：去看看那几个服务里今天有没有新消息，有新东西就带回来。">${esc(state.cfg.goal)}</textarea>
      <label class="act-lbl">以什么身份去（留空 = 用主聊天那份人格）</label>
      <textarea class="act-ta" rows="2" data-f="persona" placeholder="可留空">${esc(state.cfg.persona)}</textarea>`);
  }

  function cardMemory() {
    const H = hostApi();
    const kinds = H.LIB_DEFS || KIND_FALLBACK;
    return card("写进记忆", null,
      `<div class="act-switch">
        <div class="t">跑完自动写一条
          <small>把这次活动的收尾总结写进宿主的记忆库。关掉就只留日志、不写记忆。</small></div>
        <button class="act-sw${state.cfg.memOn ? " on" : ""}" data-act="mem-on"></button>
      </div>
      <div class="act-switch">
        <div class="t">写之前先问一声
          <small>开着的话，写完前会把总结给你看一眼，你点头才写。</small></div>
        <button class="act-sw${state.cfg.memConfirm ? " on" : ""}" data-act="mem-confirm"></button>
      </div>
      <div class="act-switch">
        <div class="t">跑完发一张卡到聊天
          <small>把「去过哪 + 看到什么」做成一张 Topic Pool 卡片，作为一条消息发到聊天界面 ——
            在对话里能翻回去、也能点「想聊这个」接着聊。</small></div>
        <button class="act-sw${state.cfg.cardOn ? " on" : ""}" data-act="card-on"></button>
      </div>
      <label class="act-lbl">写进哪个分区</label>
      <select class="act-sel" data-f="memKind">
        ${kinds.map((k) => `<option value="${esc(k.kind)}"${state.cfg.memKind === k.kind ? " selected" : ""}>${esc(k.name)}（${esc(k.kind)}）</option>`).join("")}
      </select>
      ${H.memApi
        ? `<div class="act-ok">记忆接口就位 —— 写的是宿主记忆页「新建一条」的同一个接口。</div>`
        : `<div class="act-warn">现在写不了：宿主的记忆接口不在（独立预览页里就是这样）。
            在正式前端里打开就有。</div>`}
      <div class="act-note">写进去的标题形如「自由活动 · 第一句总结」，
        正文是总结 + 时间 + 用到的工具，方便你日后在记忆页里翻。</div>`);
  }

  function cardLog() {
    const body = state.log.length
      ? `<div class="act-log">${state.log.map((s) => `<div class="act-step ${esc(s.kind)}">
          <span class="g">${s.kind === "tool" ? "⚙" : s.kind === "say" ? "”" : "·"}</span>
          <span class="tx"><b>${esc(s.title)}</b>
            ${s.body ? `<span class="res">${esc(s.body)}</span>` : ""}</span>
        </div>`).join("")}</div>`
      : `<div class="act-empty">${svgCompass()}<h4>还没有行动日志</h4>
          <p>点「现在就跑一次」，它去了哪、调了什么、拿回什么，都会一步一步记在这里。</p></div>`;
    return card("行动日志", state.log.length, body);
  }

  function cardRuns() {
    const body = state.runs.length
      ? state.runs.slice().reverse().slice(0, 12).map((r) => `<div class="act-run">
          <div class="h"><b>${esc(r.trigger)}</b>
            <span>${esc(fmtT(r.ts))}${r.memOk ? " · 已写记忆" : (r.memMsg ? " · " + esc(r.memMsg) : "")}</span></div>
          <div class="b">${esc((r.summary || r.failed || "(没有总结)").slice(0, 220))}</div>
          ${(r.summary && !r.failed) ? `<div class="act-run-acts">
            <button class="act-btn ghost" data-act="run-card" data-rid="${esc(r.rid || r.ts)}">发到聊天</button>
          </div>` : ""}
        </div>`).join("")
      : `<div class="act-note" style="margin-top:0">还没有历史记录。</div>`;
    return card("历史记录", state.runs.length, body, state.runs.length ? { a: "runs-clear", t: "清空" } : null);
  }

  function cardModel() {
    const pvTable = providerTable();
    const H = hostApi();
    let conns = []; try { if (H.loadConns) conns = H.loadConns() || []; } catch (_) { }
    const m = state.cfg.model;
    const cur = m.connId ? ("conn:" + m.connId) : (m.provider || "");
    const conn = resolveModel(m);
    return card("模型", null,
      `<label class="act-lbl">用哪个模型去逛</label>
      <select class="act-sel" data-m="source">
        <optgroup label="云端预设（走你的后端转发）">
          ${Object.keys(pvTable).filter(isCloudPid).map((pid) => `<option value="${esc(pid)}"${cur === pid ? " selected" : ""}>${esc(pvTable[pid].name)}</option>`).join("")}
        </optgroup>
        ${conns.length ? `<optgroup label="已保存的连接">${conns.map((c) =>
          `<option value="conn:${esc(c.id)}"${cur === "conn:" + c.id ? " selected" : ""}>${esc(c.name || c.id)}</option>`).join("")}</optgroup>` : ""}
      </select>
      <label class="act-lbl">模型名</label>
      <input class="act-in" data-m="model" value="${esc(m.model || "")}" placeholder="deepseek-chat">
      <label class="act-lbl">温度</label>
      <input class="act-in" type="number" min="0" max="2" step="0.05" data-m="temp" value="${esc(m.temp != null ? m.temp : 0.85)}">
      <div class="act-note">${conn
        ? `会打到 <b>${esc(conn.label)}</b> · <code>${esc(conn.model)}</code>`
        : `现在<b>不可用</b>：解析不出地址。先去「设置 → 云端后端」填后端地址，再回来选一个 ☁ 云端预设。`}</div>
      <div class="act-note">这个模型要<b>支持工具调用</b>（function calling），否则它没法用 MCP 工具。</div>`);
  }
  function svgCompass() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M15.4 8.6l-1.9 4.9-4.9 1.9 1.9-4.9z"/></svg>`;
  }
  function renderLog() { if (elPanel && !elPanel.classList.contains("hidden")) render(); }

  /* ════════════════════════════ 事件 ════════════════════════════ */
  function bind() {
    elPanel.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const a = act.dataset.act, id = act.dataset.id;
      if (a === "on") { state.cfg.on = !state.cfg.on; save(); render(); toast(state.cfg.on ? "自由活动已开启" : "自由活动已关闭"); }
      else if (a === "run") runOnce("手动");
      else if (a === "stop") { state.abort = true; if (state.ctrl) { try { state.ctrl.abort(); } catch (_) { } } render(); }
      else if (a === "sv-add") {
        state.servers.push({ id: "s" + (state.servers.length + 1) + "_" + Math.random().toString(36).slice(2, 6), name: "新服务", url: "", token: "", on: true, status: "", tools: [] });
        save(); render();
      }
      else if (a === "sv-del") {
        if (confirm("删掉这个服务？")) { state.servers = state.servers.filter((s) => s.id !== id); delete rpc[id]; save(); render(); }
      }
      else if (a === "sv-on") {
        const s = state.servers.find((x) => x.id === id); if (s) { s.on = !s.on; save(); render(); }
      }
      else if (a === "sv-probe") {
        const s = state.servers.find((x) => x.id === id); if (s) probe(s);
      }
      else if (a === "sv-all") { state.servers.forEach((s) => { if (s.url) probe(s); }); }
      else if (a === "mem-on") { state.cfg.memOn = !state.cfg.memOn; save(); render(); }
      else if (a === "mem-confirm") { state.cfg.memConfirm = !state.cfg.memConfirm; save(); render(); }
      else if (a === "card-on") { state.cfg.cardOn = !state.cfg.cardOn; save(); render();
        toast(state.cfg.cardOn ? "跑完会发一张卡到聊天" : "跑完不发卡了"); }
      else if (a === "run-card") {
        const r = state.runs.find((x) => String(x.rid || x.ts) === String(id));
        if (r) sendCard(r); else toast("找不到这一条记录");
      }
      else if (a === "runs-clear") { if (confirm("清空历史记录？")) { state.runs = []; save(); render(); } }
      else if (a === "close") close();
    });

    /* 表单：input 只存不重画（重画会抢焦点），change 才重画 */
    elPanel.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.f && t.tagName !== "SELECT") { state.cfg[t.dataset.f] = t.value; save(); }
      else if (t.dataset && t.dataset.sv) {
        const s = state.servers.find((x) => x.id === t.dataset.id);
        if (s) { s[t.dataset.sv] = t.value; save(); }
      }
      else if (t.dataset && t.dataset.m && t.dataset.m !== "source") {
        state.cfg.model[t.dataset.m] = (t.dataset.m === "temp") ? clamp(+t.value || 0, 0, 2) : t.value;
        save();
      }
    });
    elPanel.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.f) {
        const f = t.dataset.f;
        state.cfg[f] = ["from", "to", "everyMin", "maxPerDay", "maxSteps"].indexOf(f) >= 0
          ? clamp(+t.value || 0, 0, 1440) : t.value;
        if (f === "from") state.cfg[f] = clamp(state.cfg[f], 0, 23);
        else if (f === "to") state.cfg[f] = clamp(state.cfg[f], 0, 24);   // 24 = 到午夜
        save(); render();
      } else if (t.dataset && t.dataset.m === "source") {
        const v = t.value;
        if (/^conn:/.test(v)) { state.cfg.model.connId = v.slice(5); }
        else { state.cfg.model.connId = ""; state.cfg.model.provider = v; state.cfg.model.model = ((pvOf(v) || {}).models || [])[0] || state.cfg.model.model; }
        save(); render();
      } else if (t.dataset && t.dataset.m === "model") {
        state.cfg.model.model = t.value.trim(); save(); render();
      } else if (t.dataset && t.dataset.sv) {
        const s = state.servers.find((x) => x.id === t.dataset.id);
        if (s) { s[t.dataset.sv] = t.value; s.status = ""; s.err = ""; save(); render(); }
      }
    });

    /* ESC 自己处理（捕获阶段先于宿主那条链跑），免得同一次 ESC 又关别的面板 */
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (elPanel.classList.contains("hidden")) return;
      close();
      e.stopPropagation();
    }, true);

    /* 回到前台补检一次 */
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
    window.addEventListener("focus", () => tick());
  }

  /* ════════════════════════════ 开 / 关 ════════════════════════════ */
  let closeTimer = null;
  function open() {
    if (!elPanel) return;
    clearTimeout(closeTimer);
    elPanel.classList.remove("hidden");
    load();
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => elPanel.classList.add("open")));
    setTimeout(tick, 1500);          // 打开后补检一次（可能错过了时段）
  }
  function close() {
    if (!elPanel) return;
    elPanel.classList.remove("open");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => elPanel.classList.add("hidden"), 360);
  }
  const toggle = () => { elPanel.classList.contains("open") ? close() : open(); };

  /* ════════════════════════════ 启动 ════════════════════════════ */
  const PANEL_HTML = `
    <div class="act-page">
      <div class="act-top">
        <div class="act-title-wrap"><div class="act-title">自由活动</div><div class="act-sub"></div></div>
        <button data-act="close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="act-body"></div>
    </div>`;

  function ensureDom() {
    let el = document.getElementById("actPanel");
    if (!el) {
      el = document.createElement("div");
      el.className = "act-panel hidden"; el.id = "actPanel";
      el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "自由活动");
      document.body.appendChild(el);
    }
    if (!el.querySelector(".act-page")) el.innerHTML = PANEL_HTML;
    return el;
  }
  function init() {
    elPanel = ensureDom();
    elBody = $(".act-body", elPanel);
    elSub = $(".act-sub", elPanel);
    load(); bind(); render(); startTimer();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.ActivityPanel = {
    open, close, toggle, init,
    state, runOnce,
    _render: render, _save: save, _load: load, _tick: tick, _due: dueAt, _inWindow: inWindow,
    /* 给探针用的两个口子 —— 造一条运行记录再发卡，不必真去跑一次 MCP */
    _sendCard: sendCard, _payload: topicPayload
  };
  window.openActivity = open;
})();
