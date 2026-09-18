/* ═══════════════════════════════════════════════════════════════════════════
   Tidal Echo · 万花筒（角色扮演渠道）— 逻辑层
   ───────────────────────────────────────────────────────────────────────────
   范式来源：github.com/sebastianevan200-stack/kaleidoscope-rp（CC BY-NC-SA 4.0）
     「摇老虎机开世界 · 旁白与 NPC 召唤制 · 红线分层 · 配出戏信号」
   只抄机制，不抄代码。**本包不包含任何内容** ——
   人设 / 尺度 / 口味红线全部是用户自己在「⋯ → 配置」里填的空位，
   代码里一句话都没写。这正是原项目最值得学的一点：
   内容住在 config 里，改玩法不动代码。

   ── 三个机制 ──────────────────────────────────────────────────────────────
   1 老虎机世界生成   不让人对着空白框写设定（最劝退的一步）。摇词 → 世界卡。
     第 3 排（状态 / 场所 / 要求）只在成人模式出现，
     且必须是**三个槽** —— 只给一个词生成器没有操作空间，产出高度雷同。
   2 旁白召唤制       旁白不是每轮自动出场（那会让环境描写淹没对话），
     由主角在正文里埋 [cue:…] 点名叫出来。
   3 NPC 按需登场     [npc:名字:指示]。关键是**由主角判断该谁说话**，
     而且要给它「你可以一个字都不写」的权限 ——
     不给这个权限，模型每轮都会硬接，在不该开口的时候开口。

   ── 五条安全/正确性规则（都有症状+根因注释，别删）────────────────────────
   A 结构红线        绝不替使用者说话/做事/写心理；旁白不写心理与对话；
                     使用者打【停】立刻出戏。结构红线与口味红线**分开存** ——
                     混在一起写会互相绞死：口味红线原样保留就只能玩原作者的玩法。
   B 出戏信号        一旦要求模型把戏内的「不要」当台词，就必须配一个戏外的
                     停止信号（本项目用「停」）。这两件事是一套的，要么都有要么都别做。
   C cut_role_bleed  模型替使用者写的那些行，切掉并**存档**，绝不静默丢弃
                     （静默删会让使用者觉得"它怎么知道我会这么说"却查不到）。
   D drop_row        一轮里任何一个模型调用失败 → **整轮不落库**。
                     否则失败会残留半截台词，剧情被倒带。配一个重发窗口，
                     重发复用已追加的用户消息，不会变成两句。
   E run 级锁        一次只允许跑一轮，两个标签页/连点都不会把一场戏交错写乱。

   ── 与宿主的接缝 ──────────────────────────────────────────────────────────
   复用宿主已有的 PROVIDERS / cloudHost() / cloudToken() / connChatUrl() /
   connHeaders() / loadConnections()，不另建连接体系。
   它们是顶层 const/function —— 不挂 window，但同处一个全局词法环境，
   所以本文件（同级 defer 脚本，在宿主内联脚本之后执行）能按名字直接引用。
   全部读取包在 try/catch 里，缺任何一个就降级到自带兜底，
   因此本文件也能脱离宿主单跑（见 rp-channel-preview.html）。
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ── 存储键（独占命名空间，和主聊天/群聊完全隔离）───────────────────────── */
  const K_SCENE = "companion_rp_scene";
  const K_CFG   = "companion_rp_cfg";
  const K_POOL  = "companion_rp_pools";
  const MSG_CAP = 400;

  /* ── 老虎机三排 ────────────────────────────────────────────────────────
     词池全部可编辑，整类不合口味可以整类删掉。
     ⚠️ 第 3 排是三个槽（状态 / 场所 / 要求），不是一个 —— 只给一个词，
        生成器没有操作空间，产出高度雷同（原项目实测结论）。 */
  const POOLS_DEFAULT = {
    "世界":     ["近未来都市", "深山客栈", "海上邮轮", "末世避难所", "九十年代小镇", "异国旧街", "雨不停的城", "雪山旅馆", "废弃游乐园"],
    "我是谁":   ["失忆的旅人", "守店人", "落魄画家", "夜班护士", "旧友", "逃婚者", "考古学生", "无名歌手", "回乡的人"],
    "你是谁":   ["沉默的房东", "旧日恋人", "赏金猎人", "药剂师", "双面间谍", "守灯人", "老同学", "陌生搭话者", "债主"],
    "我们之间": ["债主与欠债人", "旧同事", "救命恩人", "契约关系", "血亲", "师生", "仇家", "已经分手", "从未见过"],
    "开场":     ["她推门进来", "一封迟到的信", "停电那一秒", "雨里共用一把伞", "有人敲门", "车抛锚在半路", "一张旧照片", "误拨的电话"],
    "基调":     ["克制", "张弛有度", "苦甜", "悬疑", "温柔", "荒诞", "冷冽", "炽热", "静水深流"],
    "一件东西": ["一条铁链", "一盘录音带", "没寄出的信", "旧怀表", "半瓶威士忌", "一只断跟的鞋", "生锈的钥匙", "受潮的火柴"],
    "状态":     ["久别重逢", "刚吵完", "失眠的凌晨", "装作不认识", "各怀心事", "只剩最后一夜", "谁都没先开口", "假装若无其事"],
    "场所":     ["雨夜的车里", "顶楼天台", "末班地铁", "旧公寓的厨房", "海边栈道", "停电的电梯", "打烊的书店", "空荡的候车厅"],
    "要求":     ["慢一点", "别说话", "由你先开口", "不许提从前", "谁都别先走", "别开灯", "装作第一次见", "说到一半停住"]
  };
  const ROWS = [
    { id: "r1", label: "第一排 · 骨架", tag: "必摇", adult: false, slots: ["世界", "我是谁", "你是谁", "我们之间"] },
    { id: "r2", label: "第二排 · 调味", tag: "必摇", adult: false, slots: ["开场", "基调", "一件东西"] },
    { id: "r3", label: "第三排", tag: "成人模式", adult: true, slots: ["状态", "场所", "要求"] }
  ];
  const ROW1_ID_KEYS = ["我是谁", "你是谁", "我们之间"];   // 世界卡里单独成行的三项

  /* ── 三个模型位（复用宿主 cloud:* 预设）───────────────────────────────────
     原项目建议：主角用强模型，旁白 / NPC 用便宜的。 */
  const MODELS_DEFAULT = {
    char: { provider: "cloud:deepseek", model: "deepseek-chat",      temp: 0.95, connId: "" },
    narr: { provider: "cloud:moonshot", model: "moonshot-v1-8k",     temp: 0.7,  connId: "" },
    npc:  { provider: "cloud:zhipu",    model: "glm-4-flash",        temp: 0.85, connId: "" }
  };

  const CFG_DEFAULT = {
    character: "",      // 你是谁（主角人设）—— 使用者自己填
    userPersona: "",    // 我是谁
    tone: "",           // 尺度与笔法
    redlines: [],       // 口味红线（可删改；结构红线不进这里）
    adult: false,       // 成人模式 → 第三排解锁
    adultOk: false,     // 一次性确认记录
    blur: true,         // 私密打码：内容默认模糊，点一下才显形
    ctxMsgs: 24,        // 带进上下文的轮数
    menuName: "万花筒"   // 侧边栏显示名（可自己改得更隐蔽）
  };

  /* 结构红线：不动。想换玩法去改口味红线，别动这几条。 */
  const STRUCT_REDLINES = [
    "绝不替使用者说话、做事、写心理活动 —— 写了会被切掉并留档",
    "旁白只写环境与外部事件，不写任何人的心理，不写任何人的对话",
    "使用者打出「停」立刻出戏，用你自己的本人口吻回应，不要再演",
    "主角可以沉默：该由别人开口时，正文一个字都不写，只留标记行"
  ];
  const STOP_WORDS = ["停", "【停】", "[停]", "STOP", "stop"];

  /* ════════════════════════════ 宿主接缝 ════════════════════════════ */
  function hostApi() {
    const H = {};
    try { H.PROVIDERS = (typeof PROVIDERS !== "undefined") ? PROVIDERS : null; } catch (_) { H.PROVIDERS = null; }
    try { H.cloudHost = (typeof cloudHost === "function") ? cloudHost : null; } catch (_) { H.cloudHost = null; }
    try { H.cloudToken = (typeof cloudToken === "function") ? cloudToken : null; } catch (_) { H.cloudToken = null; }
    try { H.connChatUrl = (typeof connChatUrl === "function") ? connChatUrl : null; } catch (_) { H.connChatUrl = null; }
    try { H.connHeaders = (typeof connHeaders === "function") ? connHeaders : null; } catch (_) { H.connHeaders = null; }
    try { H.loadConns = (typeof loadConnections === "function") ? loadConnections : null; } catch (_) { H.loadConns = null; }
    try { H.toast = (typeof showToast === "function") ? showToast : null; } catch (_) { H.toast = null; }
    return H;
  }
  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const FALLBACK_PROVIDERS = {
    "cloud:deepseek": { name: "☁ 云端 · DeepSeek", ver: "v1", models: ["deepseek-chat", "deepseek-reasoner"] },
    "cloud:moonshot": { name: "☁ 云端 · Kimi", ver: "v1", models: ["kimi-k2-0711-preview", "moonshot-v1-8k", "moonshot-v1-32k"] },
    "cloud:zhipu":    { name: "☁ 云端 · 智谱 GLM", ver: "v4", models: ["glm-4-plus", "glm-4-air", "glm-4-flash"] },
    "cloud:siliconflow": { name: "☁ 云端 · 硅基流动", ver: "v1", models: ["deepseek-ai/DeepSeek-V3"] },
    "cloud:qwen":     { name: "☁ 云端 · 阿里百炼", ver: "v1", models: ["qwen-plus", "qwen-max"] },
    "cloud:volc":     { name: "☁ 云端 · 火山方舟", ver: "v3", models: ["doubao-pro-32k"] },
    "cloud:hunyuan":  { name: "☁ 云端 · 腾讯混元", ver: "v1", models: ["hunyuan-pro"] },
    "cloud:openai":   { name: "☁ 云端 · OpenAI", ver: "v1", models: ["gpt-4o", "gpt-4o-mini"] },
    "cloud:openrouter": { name: "☁ 云端 · OpenRouter", ver: "v1", models: ["openai/gpt-4o"] },
    "deepseek": { name: "直连 · DeepSeek", root: "https://api.deepseek.com", ver: "v1", models: ["deepseek-chat"] },
    "moonshot": { name: "直连 · Kimi", root: "https://api.moonshot.cn", ver: "v1", models: ["moonshot-v1-8k"] },
    "zhipu":    { name: "直连 · 智谱 GLM", root: "https://open.bigmodel.cn/api/paas", ver: "v4", models: ["glm-4-flash"] },
    "custom":   { name: "自定义", root: "", ver: "v1", models: [] }
  };
  function providerTable() {
    const H = hostApi();
    return (H.PROVIDERS && Object.keys(H.PROVIDERS).length) ? H.PROVIDERS : FALLBACK_PROVIDERS;
  }
  function pvOf(pid) { return providerTable()[pid] || null; }
  const isCloudPid = (pid) => /^cloud:/.test(pid || "");
  function completeUrl(root, ver, tail) {
    root = String(root || "").trim().replace(/\/+$/, "");
    if (!root) return "";
    if (root.slice(-tail.length) === "/" + tail) return root;
    if (/(^|\/)v\d+$/i.test(root)) return root + "/" + tail;
    return root + "/" + (ver || "v1") + "/" + tail;
  }
  /* 一个模型位 → {url, headers, model, label}；解析不出来 → null */
  function resolve(slot) {
    const H = hostApi();
    if (slot.connId && H.loadConns) {
      let list = []; try { list = H.loadConns() || []; } catch (_) { }
      const c = list.find((x) => x && x.id === slot.connId);
      if (c && H.connChatUrl) {
        const url = H.connChatUrl(c);
        if (url) return {
          url, headers: H.connHeaders ? H.connHeaders(c) : { "Content-Type": "application/json" },
          model: slot.model || c.model || "", label: c.name || (c.provider || "-"), cloud: !!(c.cloud || isCloudPid(c.provider))
        };
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
      return {
        url: host.replace(/\/+$/, "") + "/relay/" + pid.replace(/^cloud:/, "") + "/" + (pv.ver || "v1") + "/chat/completions",
        headers, model, label: pv.name || pid, cloud: true
      };
    }
    const root = slot.base || pv.root || "";
    if (!root) return null;
    const headers = { "Content-Type": "application/json" };
    if (slot.key) headers["Authorization"] = "Bearer " + slot.key;
    return { url: completeUrl(root, pv.ver, "chat/completions"), headers, model, label: pv.name || pid, cloud: false };
  }

  /* ════════════════════════════ 状态 ════════════════════════════ */
  const state = {
    view: "slot",        // slot | scene | cfg
    scene: null,         // { id, world, msgs, cuts, createdAt, updatedAt }
    pick: {},            // 老虎机当前摇到的词 { "世界": "...", ... }
    world: null,         // 摇出来的世界卡
    cfg: Object.assign({}, CFG_DEFAULT),
    models: JSON.parse(JSON.stringify(MODELS_DEFAULT)),
    pools: JSON.parse(JSON.stringify(POOLS_DEFAULT)),
    running: false,
    abort: false,
    ctrl: null,
    lastUserText: "",    // 重发窗口用
    resendAt: 0
  };

  function lsRead(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }
  function lsWrite(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { } }
  function load() {
    state.cfg = Object.assign({}, CFG_DEFAULT, lsRead(K_CFG, {}) || {});
    const m = lsRead(K_CFG + "_models", null);
    state.models = m ? Object.assign(JSON.parse(JSON.stringify(MODELS_DEFAULT)), m) : JSON.parse(JSON.stringify(MODELS_DEFAULT));
    const p = lsRead(K_POOL, null);
    state.pools = p ? Object.assign(JSON.parse(JSON.stringify(POOLS_DEFAULT)), p) : JSON.parse(JSON.stringify(POOLS_DEFAULT));
    state.scene = lsRead(K_SCENE, null);
  }
  function save() {
    lsWrite(K_CFG, state.cfg);
    lsWrite(K_CFG + "_models", state.models);
    lsWrite(K_POOL, state.pools);
    if (state.scene) {
      if (state.scene.msgs && state.scene.msgs.length > MSG_CAP) state.scene.msgs = state.scene.msgs.slice(-MSG_CAP);
      lsWrite(K_SCENE, state.scene);
    } else { try { localStorage.removeItem(K_SCENE); } catch (_) { } }
  }
  let seq = 0;
  const nid = (p) => p + "_" + Date.now().toString(36) + "_" + (++seq).toString(36);

  /* ════════════════════════════ 调模型 ════════════════════════════ */
  async function call(slotKey, messages, onDelta, signal) {
    const conn = resolve(state.models[slotKey]);
    if (!conn) throw new Error("「" + slotName(slotKey) + "」这个位置还没配模型 —— 到「⋯ → 配置」里给它选一个。");
    if (!conn.model) throw new Error("「" + slotName(slotKey) + "」没填模型名。");
    const body = { model: conn.model, messages, stream: true, temperature: (state.models[slotKey].temp != null ? state.models[slotKey].temp : 0.9) };
    const res = await fetch(conn.url, { method: "POST", headers: conn.headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      let d = "HTTP " + res.status;
      try { const j = await res.json(); if (j && j.error && j.error.message) d = j.error.message; } catch (_) { }
      throw new Error("「" + slotName(slotKey) + "」返回错误：" + d);
    }
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (ctype.indexOf("application/json") >= 0 && ctype.indexOf("event-stream") < 0) {
      const j = await res.json();
      const t = (j && j.choices && j.choices[0] && ((j.choices[0].message || {}).content || j.choices[0].text)) || "";
      if (onDelta) onDelta(t);
      return t;
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", acc = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const d0 = (j.choices && j.choices[0] && j.choices[0].delta) || {};
          if (d0.content) { acc += d0.content; if (onDelta) onDelta(acc); }
        } catch (_) { }
      }
    }
    return acc;
  }
  const slotName = (k) => ({ char: "主角", narr: "旁白", npc: "NPC" }[k] || k);

  /* ════════════════════════════ 提示词装配 ════════════════════════════ */
  function worldBlock() {
    const w = state.scene && state.scene.world;
    if (!w) return "";
    const ids = (w.ids || []).map((x) => `${x.k}：${x.v}`).join("\n");
    return ["【世界】" + (w.name || ""), w.bg || "", ids ? "【身份】\n" + ids : "",
      (w.tags && w.tags.length) ? "【标签】" + w.tags.join("、") : ""].filter(Boolean).join("\n");
  }
  function redlineBlock() {
    const taste = (state.cfg.redlines || []).filter(Boolean);
    return ["【结构红线（必须遵守）】", STRUCT_REDLINES.map((r) => "· " + r).join("\n"),
      taste.length ? "\n【口味红线（使用者自己定的）】" + taste.map((r) => "· " + r).join("\n") : ""
    ].filter(Boolean).join("\n");
  }
  function charSystem() {
    return [
      worldBlock(),
      state.cfg.character ? "\n【你（主角）是谁】\n" + state.cfg.character : "",
      state.cfg.userPersona ? "\n【我是谁（使用者）】\n" + state.cfg.userPersona : "",
      state.cfg.tone ? "\n【尺度与笔法】\n" + state.cfg.tone : "",
      "\n" + redlineBlock(),
      [
        "",
        "【怎么说话】",
        "· 每一轮只写「你」（主角）自己的台词、动作、心理。写完就停。",
        "· 绝不替使用者说话、做事、写心理活动 —— 这是最重的一条，违反会被切掉。",
        "· 需要环境推一把时，在**单独一行**写 [cue:想让旁白写什么]。这一行不会显示给使用者。",
        "· 需要别人开口时，在**单独一行**写 [npc:名字:让他说什么]。这一行不会显示。",
        "· 如果这一幕该由别人接话，你**可以一个字都不写**，只留标记行 —— 不许为了凑字数硬接。",
        "· 不要复述上一轮，不要替使用者做决定，不要写「你看到他…」这类替对方视角的句子。",
        "· 说人话，短。一次推进一小步，不要把整场戏一次写完。"
      ].join("\n")
    ].filter(Boolean).join("\n");
  }
  function narrSystem(cue) {
    return [
      worldBlock(),
      "",
      "你是这个场景的旁白。",
      "只写环境与外部事件：光线、声音、天气、门、脚步、时间流逝、物件的状态。",
      "绝不写任何人的心理活动，绝不写任何人的对话，绝不替角色做决定。",
      "",
      "主角给你的提示：" + cue,
      "",
      "两到三句，短，中文。"
    ].filter(Boolean).join("\n");
  }
  function npcSystem(name, inst) {
    return [
      worldBlock(),
      "",
      `你是这个世界里的「${name}」。`,
      "只写这个角色此刻说的一句话和一个动作。",
      "绝不替主角说话，绝不替使用者说话，绝不写主角的心理，绝不推进到下一个场景。",
      "",
      "主角给你的指示：" + inst,
      "",
      "短，中文，像一句台词。"
    ].filter(Boolean).join("\n");
  }
  function transcript(n) {
    const msgs = ((state.scene && state.scene.msgs) || []).slice(-n);
    return msgs.map((m) => {
      if (m.who === "user") return "【使用者】" + m.text;
      if (m.who === "narr") return "【旁白】" + m.text;
      if (m.who === "npc") return `【${m.name}】` + m.text;
      return "【你（主角）】" + m.text;
    }).join("\n");
  }

  /* ══════════ 标记解析 / 切除（cut_role_bleed）══════════ */
  const RE_CUE = /^\s*\[cue\s*[:：]\s*([\s\S]+?)\]\s*$/;
  const RE_NPC = /^\s*\[npc\s*[:：]\s*([^\]\s:：]{1,12})\s*[:：]\s*([\s\S]+?)\]\s*$/;
  /* 模型替使用者写的那些行：以"使用者/你+冒号"开头，或整行是带引号的替答 */
  const RE_BLEED = /^\s*(?:使用者|{{user}}|你（使用者）|\[使用者\]|我)\s*[:：]/;

  function parseMarks(text) {
    const lines = String(text || "").split(/\r?\n/);
    const body = [], cues = [], npcs = [];
    lines.forEach((raw) => {
      const line = raw.trim();
      let g;
      if ((g = RE_CUE.exec(line))) { cues.push(g[1].trim()); return; }
      if ((g = RE_NPC.exec(line))) { npcs.push({ name: g[1].trim(), inst: g[2].trim() }); return; }
      body.push(raw);
    });
    return { body: body.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""), cues, npcs };
  }
  /* 切掉替使用者写的行，并**存档**（绝不静默丢）。返回 {body, cut} */
  function cutRoleBleed(text) {
    const lines = String(text || "").split(/\r?\n/);
    const body = [], cut = [];
    lines.forEach((raw) => {
      if (RE_BLEED.test(raw)) cut.push(raw.trim());
      else body.push(raw);
    });
    return { body: body.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""), cut };
  }
  const isStop = (t) => STOP_WORDS.indexOf(String(t || "").trim()) >= 0;

  /* ════════════════════════════ 一轮（D drop_row + E run 锁）═══════════════════════════ */
  function push(who, text, extra) {
    const m = Object.assign({ id: nid("r"), ts: Date.now(), who, text: String(text || "") }, extra || {});
    state.scene.msgs.push(m);
    return m;
  }
  function pushSys(text, edge) { return push("sys", text, { edge: !!edge }); }

  async function runTurn(userText) {
    if (state.running) return;
    if (!state.scene) return;
    const t = String(userText || "").trim();
    if (!t) return;
    state.running = true; state.abort = false; state.ctrl = new AbortController();
    state.lastUserText = t; state.resendAt = Date.now();
    render();
    try {
      /* ── B 出戏信号：打「停」→ 立刻脱戏，本人口吻回应，不走扮演流程 ────── */
      if (isStop(t)) {
        const u = push("user", t, { stop: true });
        render(); scrollBottom(true);
        const sys = charSystem() +
          "\n\n【出戏】使用者打了停止信号。现在停止扮演，用**你自己的本人口吻**回应" +
          "——直接、简短、关心地确认：演出停了，问使用者想聊什么、或者需不需要把这一场存下来。不要再写任何戏内内容。";
        const draft = [];
        const txt = await call("char", [{ role: "system", content: sys }, { role: "user", content: "（停止信号）" }],
          (acc) => { draft[0] = acc; }, state.ctrl.signal);
        push("char", txt, { ooc: true });
        save(); render();
        return;
      }

      const u = push("user", t);
      /* ⚠️ 先只改内存：整轮成功才落库（D drop_row）。
         否则旁白/NPC 中途失败会留下半截台词，剧情被倒带。 */
      const draft = { msgs: [], cuts: [] };

      /* 1) 主角
         ⚠️ live 这个对象必须**只建一次**。如果每个 delta 都新建一个对象，
            patchLive 会以为每次都是"全新的第一条"，于是每来一段字就 push 一条新消息 ——
            实测一轮下来会残留 9 条半截影子（这是冒烟测试抓出来的）。
            而且这些影子不会被 commit 清理，使用者会看到同一句话的九个版本。 */
      let raw = "";
      const live = { who: "char", text: "" };
      try {
        raw = await call("char", [
          { role: "system", content: charSystem() },
          { role: "system", content: "【已经发生过的事】\n" + (transcript(state.cfg.ctxMsgs) || "（这是开场，还没有任何对话）") },
          { role: "user", content: "现在接着往下演。（记得：该安静就安静，该叫人就留标记行。）" }
        ], (acc) => { live.text = acc; patchLive(live); }, state.ctrl.signal);
      } catch (e) {
        draft.msgs.push({ who: "sys", text: "（这一轮没跑起来）" + (e && e.message ? e.message : e), edge: true, err: true });
        commit(draft); return;
      }

      /* 2) 剥标记 → 3) 切除替使用者说的话（C：切掉并存档，不静默） */
      const marks = parseMarks(raw);
      const cut = cutRoleBleed(marks.body);
      if (cut.body.trim()) draft.msgs.push({ who: "char", text: cut.body.trim() });
      if (cut.cut.length) draft.cuts.push(...cut.cut);

      if (state.abort) { draft.msgs.push({ who: "sys", text: "（你按了停止，这一轮没往下跑）" }); commit(draft); return; }

      /* 4) 旁白召唤制：只在主角埋了 [cue:] 时才出场 */
      for (const cue of marks.cues) {
        try {
          const nt = await call("narr", [
            { role: "system", content: narrSystem(cue) },
            { role: "user", content: "写这一笔环境。" }
          ], null, state.ctrl.signal);
          if (String(nt).trim()) draft.msgs.push({ who: "narr", text: nt.trim() });
        } catch (e) { /* 旁白失败不影响主戏，静默跳过（它本来就是可选的） */ }
      }

      /* 5) NPC 按需登场 */
      for (const n of marks.npcs) {
        try {
          const nt = await call("npc", [
            { role: "system", content: npcSystem(n.name, n.inst) },
            { role: "user", content: "说这一句。" }
          ], null, state.ctrl.signal);
          if (String(nt).trim()) draft.msgs.push({ who: "npc", name: n.name, text: nt.trim() });
        } catch (e) { /* 同上 */ }
      }

      commit(draft);
    } finally {
      state.running = false; state.ctrl = null;
      render(); scrollBottom();
    }
  }
  /* 流式期间那条临时消息（patchLive 建的、带着 draft 标记的那一条）必须先撤掉，
     再落正式解析过的那条 —— 否则气泡里会同时留下"流式过程"和"最终结果"两份。 */
  function dropDrafts() {
    if (!state.scene) return;
    state.scene.msgs = state.scene.msgs.filter((m) => !m.draft);
    bubbleRefs.forEach((b, id) => { if (!state.scene.msgs.some((m) => m.id === id)) bubbleRefs.delete(id); });
  }
  /* 整轮成功才写进 scene —— 失败则整轮不落库，配合重发窗口补回来 */
  function commit(draft) {
    dropDrafts();
    (draft.msgs || []).forEach((m) => {
      if (m.who === "sys") pushSys(m.text, m.edge);
      else push(m.who, m.text, { name: m.name, ooc: !!m.ooc, cut: !!m.cut });
    });
    (draft.cuts || []).forEach((c) => {
      if (!state.scene.cuts) state.scene.cuts = [];
      state.scene.cuts.push({ ts: Date.now(), text: c });
    });
    save();
  }
  /* 重发：复用已经追加的那条用户消息，不会变成两句 */
  function resend() {
    if (state.running || !state.scene) return;
    const msgs = state.scene.msgs;
    const lastUser = msgs.filter((m) => m.who === "user").pop();
    if (!lastUser) return;
    /* 把上一轮失败留下的东西（含那条用户消息）退掉，再原样发一次 */
    const i = msgs.lastIndexOf(lastUser);
    state.scene.msgs = msgs.slice(0, i);
    runTurn(lastUser.text);
  }
  function stopAll() {
    state.abort = true;
    if (state.ctrl) { try { state.ctrl.abort(); } catch (_) { } }
    state.busy = false;
    if (state.scene) pushSys("你按了停止。");
    save(); render();
  }

  /* ══════════ 老虎机：摇词 + 生成世界卡 ══════════ */
  function rollRow(rowId) {
    const row = ROWS.find((r) => r.id === rowId);
    if (!row) return;
    const cells = elPanel.querySelectorAll(`[data-row="${rowId}"] .rp-cell`);
    row.slots.forEach((slot, i) => {
      const pool = (state.pools[slot] || []).slice();
      if (!pool.length) return;
      const w = pool[Math.floor(Math.random() * pool.length)];
      state.pick[slot] = w;
      const cell = cells[i];
      if (cell) {
        cell.querySelector(".v").textContent = w;
        cell.classList.remove("rolling");
        void cell.offsetWidth;                      // 重排一次，动画才会重放
        cell.classList.add("rolling");
      }
    });
    state.world = null;
    renderSlot();
  }
  function pickedWords(includeAdult) {
    const out = [];
    ROWS.forEach((r) => {
      if (r.adult && !includeAdult) return;
      r.slots.forEach((s) => { if (state.pick[s]) out.push({ k: s, v: state.pick[s] }); });
    });
    return out;
  }
  /* 没有模型时的兜底：把摇到的词**原样拼成**世界卡（不编内容，只是组装） */
  function localWorldCard() {
    const p = pickedWords(state.cfg.adult);
    const get = (k) => (p.find((x) => x.k === k) || {}).v || "";
    const name = get("世界") || "无名之地";
    const bg = [
      get("开场") ? `开场：${get("开场")}。` : "",
      `这是${name}。我是${get("我是谁") || "一个来路不明的人"}，你是${get("你是谁") || "守在这里的人"}。`,
      get("我们之间") ? `我们之间：${get("我们之间")}。` : "",
      get("一件东西") ? `场上有${get("一件东西")}。` : "",
      state.cfg.adult ? [get("状态"), get("场所"), get("要求")].filter(Boolean).map((x) => x + "。").join("") : ""
    ].filter(Boolean).join("\n");
    const ids = ["我是谁", "你是谁", "我们之间"].filter((k) => get(k)).map((k) => ({ k, v: get(k) }));
    const tags = [get("基调"), get("世界"), state.cfg.adult ? "成人模式" : ""].filter(Boolean);
    return { name, bg, ids, tags, adult: !!state.cfg.adult, local: true };
  }
  async function genWorld() {
    if (state.running) return;
    const words = pickedWords(state.cfg.adult);
    if (!words.length) { toast("先摇一排词"); return; }
    state.running = true; render();
    try {
      const conn = resolve(state.models.char);
      if (!conn) { state.world = localWorldCard(); save(); render(); return; }
      const sys = [
        "你是一个角色扮演的世界生成器。用下面这些词，产出一张可以直接开演的世界卡。",
        "严格按这个格式输出，不要寒暄、不要解释、不要加粗：",
        "世界名：",
        "背景：",
        "我是谁：",
        "你是谁：",
        "我们之间：",
        "标签：",
        "",
        "要求：背景两到三段、150 字以内，要有具体的时间地点和一件实物；",
        "「我是谁 / 你是谁 / 我们之间」各一句话；标签 3 到 5 个词，逗号分隔。",
        "只使用给定词语提供的信息，不要凭空加人物关系以外的支线。",
        state.cfg.tone ? "笔法基调：" + state.cfg.tone : ""
      ].filter(Boolean).join("\n");
      const raw = await call("char", [
        { role: "system", content: sys },
        { role: "user", content: words.map((w) => `${w.k}：${w.v}`).join("\n") }
      ], null, null);
      state.world = parseWorldCard(raw) || localWorldCard();
    } catch (e) {
      state.world = localWorldCard();
      state.worldErr = (e && e.message) || String(e);
    } finally { state.running = false; render(); }
  }
  function parseWorldCard(raw) {
    const s = String(raw || "");
    const pick = (k) => {
      const m = new RegExp(k + "\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:世界名|背景|我是谁|你是谁|我们之间|标签)\\s*[:：]|$)", "i").exec(s);
      return m ? m[1].trim() : "";
    };
    const name = pick("世界名"), bg = pick("背景");
    if (!name && !bg) return null;
    const ids = ["我是谁", "你是谁", "我们之间"].map((k) => ({ k, v: pick(k) })).filter((x) => x.v);
    const tags = pick("标签").split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
    return { name, bg, ids, tags, adult: !!state.cfg.adult };
  }
  function startScene() {
    if (!state.world) { toast("先摇一张世界卡"); return; }
    state.scene = {
      id: nid("s"), world: state.world, msgs: [], cuts: [], createdAt: Date.now(), updatedAt: Date.now()
    };
    state.view = "scene";
    pushSys("世界卡已采用。开场你自己来 —— 说第一句，或者让它先动。");
    save(); render(); scrollBottom(true);
  }
  function endScene(keep) {
    if (!state.scene) return;
    if (!keep) { state.scene = null; state.view = "slot"; state.world = null; }
    save(); render();
  }

  /* ════════════════════════════ 渲染 ════════════════════════════ */
  const $ = (s, root) => (root || document).querySelector(s);
  let elPanel, elSlot, elScroll, elMsgs, elCfg, elComposer, elInput, elSend, elTitle, elSub, elBack;
  const bubbleRefs = new Map();

  const WHO_COLOR = { char: "#3E7BE8", narr: "#8A93A6", npc: "#D9822B", human: "#7E93A4" };
  function npcColor(name) {
    let h = 0; for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) % 360;
    return `hsl(${h} 58% 52%)`;
  }
  function fmtTime(ts) {
    const d = new Date(ts), n = new Date(), p = (x) => String(x).padStart(2, "0");
    const hm = p(d.getHours()) + ":" + p(d.getMinutes());
    if (d.toDateString() === n.toDateString()) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
  const dayLabel = (ts) => {
    const d = new Date(ts), n = new Date();
    if (d.toDateString() === n.toDateString()) return "今天";
    const y = new Date(n.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return "昨天";
    return (d.getMonth() + 1) + " 月 " + d.getDate() + " 日";
  };

  function render() {
    if (!elPanel) return;
    if (elPanel.classList.contains("hidden")) return;

    const hasScene = !!state.scene;
    if (state.view === "cfg") { state.view = "cfg"; }
    else if (!hasScene && state.view === "scene") state.view = "slot";

    elTitle.textContent = state.view === "cfg" ? "配置"
      : (state.view === "slot" ? state.cfg.menuName || "万花筒" : ((state.scene.world && state.scene.world.name) || "这一场"));
    elSub.innerHTML = state.view === "cfg" ? "人设 · 尺度 · 红线 · 模型"
      : state.view === "slot" ? "摇一排词，开一个世界"
        : ((state.scene.world && state.scene.world.tags || []).slice(0, 3).join(" · ") || "正在演")
        + (state.cfg.blur ? " · <span style='color:#B36A1A'>私密</span>" : "");
    elBack.classList.toggle("hidden", state.view !== "cfg");

    elSlot.classList.toggle("hidden", state.view !== "slot");
    elScroll.classList.toggle("hidden", state.view !== "scene");
    elCfg.classList.toggle("hidden", state.view !== "cfg");
    elComposer.classList.toggle("hidden", state.view !== "scene");
    elPanel.classList.toggle("rp-blur", !!state.cfg.blur);

    if (state.view === "slot") renderSlot();
    if (state.view === "scene") renderMsgs();
    if (state.view === "cfg") renderCfg();
  }

  /* ── 老虎机 ──────────────────────────────────────────────────────────── */
  function renderSlot() {
    const adult = !!state.cfg.adult;
    elSlot.innerHTML = ROWS.map((row) => {
      const locked = row.adult && !adult;
      return `<div class="rp-row" data-row="${row.id}">
        <div class="rp-row-t">
          <span>${esc(row.label)}</span>
          <span class="tag${row.adult ? " adult" : ""}">${esc(row.tag)}</span>
          ${row.adult && !adult ? `<button data-act="adult-on">开成人模式</button>` : ""}
          ${row.adult && adult ? `<button data-act="adult-off">关掉</button>` : ""}
          <button data-act="roll" data-row="${row.id}">摇</button>
        </div>
        <div class="rp-slots${row.slots.length === 3 ? " c3" : ""}">
          ${row.slots.map((s) => `<div class="rp-cell${state.pick[s] ? " on" : ""}" data-cell="${esc(s)}">
            ${locked ? `<span class="lock">未开</span>` : ""}
            <span class="k">${esc(s)}</span><span class="v">${esc(state.pick[s] || "—")}</span>
          </div>`).join("")}
        </div>
      </div>`;
    }).join("")
      + `<div class="rp-acts">
          <button class="rp-btn" data-act="gen"${state.running ? " disabled" : ""}>${state.running ? "正在生成…" : "生成世界卡"}</button>
          ${state.world ? `<button class="rp-btn" data-act="start">用这张开演</button>` : ""}
          <button class="rp-btn ghost" data-act="cfg">配置</button>
          <button class="rp-btn ghost" data-act="pools">改词池</button>
        </div>`
      + (state.world ? worldCardHtml(state.world) : `<div class="rp-empty">${svgDice()}
          <h4>摇一排词，就有世界</h4>
          <p>不用对着空白框写设定 —— 那是最劝退的一步。<br>
             摇出来的词会交给模型，生成一张能直接开演的世界卡。</p></div>`);
  }
  function worldCardHtml(w) {
    return `<div class="rp-world">
      <div class="rp-world-t">${esc(w.name || "无名之地")}${w.local ? ` <span style="font-size:10.5px;color:#B36A1A">本地拼装</span>` : ""}</div>
      <div class="rp-world-bg">${esc(w.bg || "")}</div>
      ${(w.ids || []).length ? `<div class="rp-world-id">${w.ids.map((i) => `<span><b>${esc(i.k)}</b> ${esc(i.v)}</span>`).join("")}</div>` : ""}
      ${(w.tags || []).length ? `<div class="rp-tags">${w.tags.map((t) => `<span class="rp-tag${w.adult ? " adult" : ""}">${esc(t)}</span>`).join("")}</div>` : ""}
      ${state.worldErr ? `<div class="rp-note" style="color:#A8565F">没能调模型生成，这张是用摇到的词本地拼的（${esc(state.worldErr)}）</div>` : ""}
    </div>`;
  }

  /* ── 扮演界面 ────────────────────────────────────────────────────────── */
  function renderMsgs() {
    const msgs = (state.scene && state.scene.msgs) || [];
    bubbleRefs.clear();
    if (!msgs.length) {
      elMsgs.innerHTML = `<div class="rp-empty">${svgMask()}<h4>开场你来</h4>
        <p>说第一句，或者让它先动。<br>想让它描写环境，就让它自己决定要不要叫旁白。</p></div>`;
    } else {
      let html = "", lastDay = "";
      for (const m of msgs) {
        const dk = dayKey(m.ts);
        if (dk !== lastDay && m.who !== "sys") { lastDay = dk; html += `<div class="rp-day">${esc(dayLabel(m.ts))}</div>`; }
        html += msgHtml(m);
      }
      elMsgs.innerHTML = html;
      elMsgs.querySelectorAll(".rp-msg").forEach((n) => {
        const id = n.dataset.mid; if (id) bubbleRefs.set(id, $(".rp-bubble", n));
      });
    }
    renderComposer();
  }
  function msgHtml(m) {
    if (m.who === "sys") return `<div class="rp-sys${m.edge ? " edge" : ""}">${esc(m.text)}</div>`;
    if (m.who === "cut") return `<div class="rp-cut">${esc(m.text)}</div>`;
    if (m.who === "narr") {
      /* 旁白刻意**不做成气泡**（它不是一个"说话的人"），靠居中+斜体+上下细线区分。
         但完全不标也容易懵，所以给一个低对比度小标签。 */
      return `<div class="rp-msg narr" data-mid="${esc(m.id)}">
        <div class="rp-body">
          <div class="rp-narr-tag">旁白</div>
          <div class="rp-bubble">${esc(m.text)}</div>
        </div></div>`;
    }
    if (m.who === "user") {
      return `<div class="rp-msg human" data-mid="${esc(m.id)}">
        <span class="rp-av" style="background:${WHO_COLOR.human}">我</span>
        <div class="rp-body">
          <div class="rp-meta"><b>我</b><span>${esc(fmtTime(m.ts))}</span>${m.stop ? "<em>出戏信号</em>" : ""}</div>
          <div class="rp-bubble">${esc(m.text)}</div>
        </div></div>`;
    }
    const isNpc = m.who === "npc";
    const color = isNpc ? npcColor(m.name || "?") : WHO_COLOR.char;
    const name = isNpc ? (m.name || "?") : ((state.scene.world && ((state.scene.world.ids || []).find((i) => i.k === "你是谁") || {}).v) || "主角");
    /* 头像统一用名字首字（主角的名字取自世界卡的「你是谁」，没有就用「演」） */
    const av = String(name || "").slice(0, 1) || "演";
    return `<div class="rp-msg ai" data-mid="${esc(m.id)}" style="--mc:${esc(color)}">
      <span class="rp-av" style="background:${esc(color)}">${esc(av)}</span>
      <div class="rp-body">
        <div class="rp-meta"><b>${esc(name)}</b><span>${esc(fmtTime(m.ts))}</span>${m.ooc ? "<em>已出戏</em>" : ""}</div>
        <div class="rp-bubble">${esc(m.text)}</div>
        ${state.cfg.blur ? `<span class="rp-hold">（点气泡显形）</span>` : ""}
      </div></div>`;
  }
  function patchLive(live) {
    if (!live) return;
    if (!live.mid) {
      const m = push(live.who, live.text, { draft: true });
      live.mid = m.id;
      renderMsgs();
    } else {
      const m = state.scene.msgs.find((x) => x.id === live.mid);
      if (m) { m.text = live.text; const b = bubbleRefs.get(live.mid); if (b) b.textContent = live.text; }
    }
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; scrollBottom(true); });
  }
  let rafPending = false;

  function renderComposer() {
    const cuts = (state.scene && state.scene.cuts) || [];
    elInput.placeholder = "说你要做什么、说什么…（打「停」立刻出戏）";
    elSend.classList.toggle("stop", state.running);
    elSend.innerHTML = state.running
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12.5 6l6 6-6 6"/></svg>`;
    elSend.setAttribute("aria-label", state.running ? "停止" : "发送");
    const qb = elComposer.querySelector(".rp-quick");
    if (qb) {
      qb.innerHTML =
        `<button class="rp-qb stop" data-act="stop-word">【停】出戏</button>` +
        (cuts.length ? `<button class="rp-qb" data-act="cuts">已切除 ${cuts.length} 行</button>` : "") +
        `<button class="rp-qb" data-act="resend"${state.resendAt ? "" : " disabled"}>重发上一句</button>` +
        `<button class="rp-qb" data-act="end">结束这场</button>`;
    }
  }

  /* ── 配置页 ──────────────────────────────────────────────────────────── */
  function renderCfg() {
    const pvTable = providerTable();
    let conns = [];
    try { const H = hostApi(); if (H.loadConns) conns = H.loadConns() || []; } catch (_) { }

    const modelCard = (key, title, hint) => {
      const s = state.models[key];
      const conn = resolve(s);
      return `<div class="rp-card">
        <div class="rp-card-h"><b>${esc(title)}</b><span>${esc(hint)}</span></div>
        <label class="rp-lbl">来源</label>
        <select class="rp-sel" data-f="provider" data-m="${key}">
          <optgroup label="云端预设（走你的后端转发）">
            ${Object.keys(pvTable).filter(isCloudPid).map((pid) =>
              `<option value="${esc(pid)}"${s.provider === pid ? " selected" : ""}>${esc(pvTable[pid].name)}</option>`).join("")}
          </optgroup>
          <optgroup label="浏览器直连">
            ${Object.keys(pvTable).filter((p) => !isCloudPid(p)).map((pid) =>
              `<option value="${esc(pid)}"${s.provider === pid ? " selected" : ""}>${esc(pvTable[pid].name)}</option>`).join("")}
          </optgroup>
          ${conns.length ? `<optgroup label="已保存的连接">${conns.map((c) =>
            `<option value="conn:${esc(c.id)}"${s.connId === c.id ? " selected" : ""}>${esc(c.name || c.id)}</option>`).join("")}</optgroup>` : ""}
        </select>
        <div class="rp-two">
          <div><label class="rp-lbl">模型</label>
            <input class="rp-in" data-f="model" data-m="${key}" value="${esc(s.model || "")}"></div>
          <div><label class="rp-lbl">温度</label>
            <input class="rp-in" type="number" min="0" max="2" step="0.05" data-f="temp" data-m="${key}" value="${esc(s.temp != null ? s.temp : 0.9)}"></div>
        </div>
        <div class="rp-note">${conn
          ? `现在会打到 <b>${esc(conn.label)}</b> · <code>${esc(conn.model)}</code>`
          : `现在<b>不可用</b>：解析不出地址。最省事是先到「设置 → 云端后端」填后端地址，再回来选一个 ☁ 云端预设。`}</div>
      </div>`;
    };

    elCfg.innerHTML = `
      <div class="rp-card">
        <div class="rp-card-h"><b>世界与身份</b><span>这几栏是空的 —— 由你填，代码里不写内容</span></div>
        <label class="rp-lbl">TA 是谁（主角人设）</label>
        <textarea class="rp-ta" rows="3" data-f="character" placeholder="名字、外形、说话方式、在意什么…">${esc(state.cfg.character)}</textarea>
        <label class="rp-lbl">我是谁</label>
        <textarea class="rp-ta" rows="2" data-f="userPersona" placeholder="你在这场戏里的身份、脾气…">${esc(state.cfg.userPersona)}</textarea>
        <label class="rp-lbl">尺度与笔法</label>
        <textarea class="rp-ta" rows="2" data-f="tone" placeholder="想要多露骨、多克制；长句还是短句；第几人称…">${esc(state.cfg.tone)}</textarea>
        <div class="rp-note">参照 kaleidoscope-rp 的分层法：内容全部住在配置里，
          改玩法不用动代码，也不用重发版本。</div>
      </div>

      <div class="rp-card">
        <div class="rp-card-h"><b>红线</b><span>结构红线动不了，口味红线随你删改</span></div>
        ${STRUCT_REDLINES.map((r) => `<div class="rp-rl fixed"><span class="lk">结构</span><span class="tx">${esc(r)}</span></div>`).join("")}
        ${(state.cfg.redlines || []).map((r, i) =>
          `<div class="rp-rl"><span class="tx">${esc(r)}</span>
           <button class="x" data-act="rl-del" data-i="${i}" aria-label="删除">✕</button></div>`).join("")}
        <div class="rp-rl-add">
          <input class="rp-in" id="rpRlNew" placeholder="加一条口味红线，例如：不许出现第三人">
          <button class="rp-btn" data-act="rl-add">加</button>
        </div>
        <div class="rp-note"><b>为什么要分两层：</b>混在一起写会互相绞死 ——
          口味红线原样保留，你就只能玩原作者的玩法。所以它们单独存、随便删。</div>
      </div>

      ${modelCard("char", "主角", "用强一点的模型")}
      ${modelCard("narr", "旁白", "便宜的就行，只写环境")}
      ${modelCard("npc", "NPC", "便宜的就行，一人一句")}

      <div class="rp-card">
        <div class="rp-card-h"><b>渠道设置</b></div>
        <div class="rp-switch">
          <div class="t">成人模式<small>开了才会出现第三排（状态 / 场所 / 要求）。可随时关。</small></div>
          <button class="rp-sw${state.cfg.adult ? " on" : ""}" data-act="adult"></button>
        </div>
        <div class="rp-switch">
          <div class="t">私密打码<small>内容默认模糊，点气泡才显形。手机被别人看到时不至于社死。</small></div>
          <button class="rp-sw${state.cfg.blur ? " on" : ""}" data-act="blur"></button>
        </div>
        <div class="rp-switch">
          <div class="t">侧边栏显示名<small>改成一个只有你自己认得的名字。</small></div>
          <input class="rp-in" data-f="menuName" value="${esc(state.cfg.menuName || "万花筒")}" maxlength="8" style="width:110px;flex:0 0 auto">
        </div>
        <div class="rp-switch">
          <div class="t">带进上下文的轮数<small>越多越"记得住"，也越费 token。</small></div>
          <input class="rp-in" type="number" min="6" max="80" step="2" data-f="ctxMsgs" value="${esc(state.cfg.ctxMsgs)}" style="width:74px;flex:0 0 auto">
        </div>
      </div>

      <div class="rp-card">
        <div class="rp-card-h"><b>数据</b></div>
        <div class="rp-note" style="margin-top:0">
          这一场 ${((state.scene && state.scene.msgs) || []).length} 条消息，存在本机浏览器里（localStorage），
          和主聊天、群聊<b>完全隔离</b>，不上传。
        </div>
        <div style="margin-top:9px">
          <button class="rp-btn ghost" data-act="export">导出</button>
          <button class="rp-btn danger" data-act="wipe">删掉这一场</button>
        </div>
      </div>`;
  }

  function renderPools() {
    elCfg.classList.remove("hidden");
    elSlot.classList.add("hidden");
    elScroll.classList.add("hidden");
    elComposer.classList.add("hidden");
    elTitle.textContent = "词池";
    elBack.classList.remove("hidden");
    elCfg.innerHTML = `<div class="rp-note" style="margin:0 0 10px">
      每行一条，逗号分隔。整类不合口味可以整类清空 —— 清空的那一栏就不摇了。
    </div>` + Object.keys(state.pools).map((k) => {
      const adultRow = (ROWS.find((r) => r.id === "r3") || {}).slots || [];
      return `<div class="rp-card">
        <div class="rp-card-h"><b>${esc(k)}</b><span>${adultRow.indexOf(k) >= 0 ? "成人模式" : ""}</span></div>
        <textarea class="rp-ta" rows="3" data-pool="${esc(k)}">${esc((state.pools[k] || []).join("、"))}</textarea>
      </div>`;
    }).join("") + `<button class="rp-btn" data-act="pool-save">保存词池</button>
      <button class="rp-btn ghost" data-act="pool-reset">恢复默认</button>
      <button class="rp-btn ghost" data-act="cfg-back">返回配置</button>`;
  }

  /* ════════════════════════════ 事件 ════════════════════════════ */
  function autoGrow() {
    if (!elInput) return;
    elInput.style.height = "auto";
    elInput.style.height = Math.min(elInput.scrollHeight, Math.round(window.innerHeight * 0.32)) + "px";
  }
  function scrollBottom(force) {
    if (!elScroll) return;
    const near = elScroll.scrollHeight - elScroll.scrollTop - elScroll.clientHeight < 120;
    if (force || near) elScroll.scrollTop = elScroll.scrollHeight;
  }
  function toast(m) { const H = hostApi(); if (H.toast) H.toast(m); }
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  /* 侧边栏那条菜单的名字是可配置的（改成一个只有你自己认得的名字）→
     宿主菜单项给了 id="rpMenuName"，这里每次打开/改名都同步一次。
     宿主没有这个 id 时（比如脱离宿主的预览页）什么都不做。 */
  function syncMenuName() {
    const n = document.getElementById("rpMenuName");
    if (n && n.textContent !== (state.cfg.menuName || "万花筒")) n.textContent = state.cfg.menuName || "万花筒";
  }

  function bind() {
    elPanel.addEventListener("click", (e) => {
      /* 私密模式：点气泡显形 */
      const bub = e.target.closest(".rp-bubble");
      if (bub && state.cfg.blur) { bub.classList.toggle("revealed"); return; }

      const roll = e.target.closest('[data-act="roll"]');
      if (roll) { rollRow(roll.dataset.row); return; }

      const act = e.target.closest("[data-act]");
      if (act) {
        const a = act.dataset.act;
        if (a === "gen") genWorld();
        else if (a === "start") startScene();
        else if (a === "cfg") { state.view = "cfg"; render(); }
        else if (a === "cfg-back") { state.view = "cfg"; render(); }
        else if (a === "pools") renderPools();
        else if (a === "pool-save") {
          elCfg.querySelectorAll("[data-pool]").forEach((ta) => {
            const arr = ta.value.split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean);
            state.pools[ta.dataset.pool] = arr;
          });
          save(); state.view = "cfg"; render(); toast("词池已保存");
        }
        else if (a === "pool-reset") { state.pools = JSON.parse(JSON.stringify(POOLS_DEFAULT)); save(); renderPools(); }
        else if (a === "adult-on" || a === "adult") {
          if (!state.cfg.adult && !state.cfg.adultOk) {
            if (!confirm("成人模式会出现第三排（状态 / 场所 / 要求）。\n\n只有你自己用、并且已成年，才继续。")) return;
            state.cfg.adultOk = true;
          }
          state.cfg.adult = !state.cfg.adult; save(); render();
        }
        else if (a === "adult-off") { state.cfg.adult = false; save(); render(); }
        else if (a === "blur") { state.cfg.blur = !state.cfg.blur; save(); render(); }
        else if (a === "rl-add") {
          const i = $("#rpRlNew"); const v = (i && i.value || "").trim();
          if (v) { state.cfg.redlines.push(v); save(); renderCfg(); if (i) i.value = ""; }
        }
        else if (a === "rl-del") { state.cfg.redlines.splice(+act.dataset.i, 1); save(); renderCfg(); }
        else if (a === "stop-word") { send("停"); }
        else if (a === "resend") resend();
        else if (a === "end") {
          if (confirm("结束这一场？消息会清掉，不可恢复。")) { endScene(false); toast("这一场结束了"); }
        }
        else if (a === "cuts") {
          const cuts = (state.scene && state.scene.cuts) || [];
          if (cuts.length) alert("被切掉的（模型替你写的）共 " + cuts.length + " 行：\n\n" +
            cuts.map((c, i) => (i + 1) + ". " + c).join("\n"));
        }
        else if (a === "export") {
          const blob = new Blob([JSON.stringify({ scene: state.scene, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
          const a2 = document.createElement("a");
          a2.href = URL.createObjectURL(blob);
          a2.download = "rp-" + new Date().toISOString().slice(0, 10) + ".json";
          a2.click(); setTimeout(() => URL.revokeObjectURL(a2.href), 4000);
        }
        else if (a === "wipe") {
          if (confirm("删掉这一场的所有消息？不可恢复。")) { state.scene = null; state.view = "slot"; save(); render(); }
        }
        return;
      }
      if (e.target.closest("[data-close]")) { close(); return; }
    });

    elCfg.addEventListener("change", (e) => {
      const t = e.target, f = t.dataset && t.dataset.f;
      if (!f) return;
      if (f === "menuName") { state.cfg.menuName = (t.value || "").trim().slice(0, 8) || "万花筒"; syncMenuName(); }
      else if (f === "ctxMsgs") state.cfg.ctxMsgs = clamp(+t.value || 24, 6, 80);
      else if (f === "character") state.cfg.character = t.value;
      else if (f === "userPersona") state.cfg.userPersona = t.value;
      else if (f === "tone") state.cfg.tone = t.value;
      else if (t.dataset.m) {
        const s = state.models[t.dataset.m]; if (!s) return;
        if (f === "model") s.model = t.value.trim();
        else if (f === "temp") s.temp = clamp(+t.value, 0, 2);
        else if (f === "provider") {
          const v = t.value;
          if (/^conn:/.test(v)) s.connId = v.slice(5);
          else { s.connId = ""; s.provider = v; s.model = ((pvOf(v) || {}).models || [])[0] || s.model; }
        }
      }
      save();
      if (f === "provider" || f === "model" || f === "temp") renderCfg();
    });
    elCfg.addEventListener("blur", (e) => {
      const t = e.target, f = t.dataset && t.dataset.f;
      if (f === "character" || f === "userPersona" || f === "tone") { state.cfg[f] = t.value; save(); }
    }, true);

    elInput.addEventListener("input", autoGrow);
    elInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return; }
      const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); send(elInput.value); }
    });
    elSend.addEventListener("click", () => { if (state.running) stopAll(); else send(elInput.value); });
    elBack.addEventListener("click", () => { state.view = state.scene ? "scene" : "slot"; render(); });

    /* ESC 由本包自己处理（捕获阶段，先于宿主的 document keydown 跑），
       免得同一次 ESC 又把菜单/别的面板关一遍。 */
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (elPanel.classList.contains("hidden")) return;
      if (state.view === "cfg") { state.view = state.scene ? "scene" : "slot"; render(); e.stopPropagation(); return; }
      if (state.running) { stopAll(); e.stopPropagation(); return; }
      close(); e.stopPropagation();
    }, true);
  }

  function send(text) {
    const t = String(text || "").trim();
    if (!t || state.running) return;
    if (!state.scene) { toast("先摇一张世界卡开演"); return; }
    if (elInput) { elInput.value = ""; autoGrow(); }
    runTurn(t);
  }

  /* ════════════════════════════ 开 / 关 ════════════════════════════ */
  let closeTimer = null;
  function open() {
    if (!elPanel) return;
    clearTimeout(closeTimer);
    elPanel.classList.remove("hidden");
    load();
    state.view = state.scene ? "scene" : "slot";
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => { elPanel.classList.add("open"); scrollBottom(true); }));
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
    <div class="rp-page">
      <div class="rp-top">
        <button data-back type="button" aria-label="返回" class="hidden">‹</button>
        <div class="rp-title-wrap"><div class="rp-title">万花筒</div><div class="rp-sub"></div></div>
        <button data-act="cfg" type="button" aria-label="配置" title="配置">⋯</button>
        <button data-close type="button" aria-label="关闭">✕</button>
      </div>
      <div class="rp-slot"></div>
      <div class="rp-scroll hidden"><div class="rp-msgs"></div></div>
      <div class="rp-cfg hidden"></div>
      <div class="rp-composer hidden">
        <div class="rp-quick"></div>
        <div class="rp-inputrow">
          <textarea rows="1" placeholder="说你要做什么…" autocomplete="off" spellcheck="false"></textarea>
          <button class="rp-send" type="button" aria-label="发送"></button>
        </div>
        <div class="rp-hint">打「停」立刻出戏 · 主角自己决定要不要叫旁白 / NPC</div>
      </div>
    </div>`;

  function ensureDom() {
    let el = document.getElementById("rpPanel");
    if (!el) {
      el = document.createElement("div");
      el.className = "rp-panel hidden"; el.id = "rpPanel";
      el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "万花筒");
      document.body.appendChild(el);
    }
    if (!el.querySelector(".rp-page")) el.innerHTML = PANEL_HTML;
    return el;
  }

  function init() {
    elPanel = ensureDom();
    elSlot = $(".rp-slot", elPanel);
    elScroll = $(".rp-scroll", elPanel);
    elMsgs = $(".rp-msgs", elPanel);
    elCfg = $(".rp-cfg", elPanel);
    elComposer = $(".rp-composer", elPanel);
    elInput = $(".rp-inputrow textarea", elPanel);
    elSend = $(".rp-send", elPanel);
    elTitle = $(".rp-title", elPanel);
    elSub = $(".rp-sub", elPanel);
    elBack = $(".rp-top button[data-back]", elPanel);
    load();
    bind();
    render();
    syncMenuName();
  }

  function svgDice() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3.4"/><circle cx="8.6" cy="8.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.4" cy="15.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/></svg>`; }
  function svgMask() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.2c3.2-1.6 14.8-1.6 18 0 0 5.4-3 9.2-6.6 11.3-1.5.9-3.3.9-4.8 0C6 15.4 3 11.6 3 6.2Z"/><path d="M8.4 10.6c.9 1.1 2.4 1.1 3.3 0"/><path d="M12.3 10.6c.9 1.1 2.4 1.1 3.3 0"/></svg>`; }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  /* ── 对外接口 ─────────────────────────────────────────────────────── */
  window.RpChannel = {
    open, close, toggle, init,
    state,
    menuName: () => state.cfg.menuName || "万花筒",
    send,                       // 暴露给冒烟测试：可以直接验 run 级锁（不走按钮，按钮在跑的时候是"停止"）
    reset() { state.scene = null; state.world = null; save(); render(); },
    /* 给冒烟测试用的两个口子：open() 内部会 load() 覆盖内存，
       所以测试要"摆好状态 → 先落盘 → 再 open"，否则注入的场景会被 load 冲掉。 */
    _render: render,
    _save: save
  };
  window.openRp = open;
})();
