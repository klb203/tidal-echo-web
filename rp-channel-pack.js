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
  const K_MONO  = "companion_rp_mono";
  /* ⚠️ 这个常量必须在 state 之前声明 —— MONO_DEFAULT 在初始化时就要读它。
     顶层 const 有 TDZ：反着写会抛 "Cannot access 'MCP_DEFAULT' before initialization"，
     而且会**整个包一起挂掉**（这类错误只在控制台留一行，页面其余功能看着都正常）。 */
  const MCP_DEFAULT = "https://spicy-monopoly.lol/mcp";
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
  const MONO_DEFAULT = {
    endpoint: MCP_DEFAULT, token: "", rulesAck: "", rules: "", ack: false,
    setup: { p1_name: "", p2_name: "", p1_sex: "女", p2_sex: "男", p1_role: "受", p2_role: "攻",
             lineup: "男女", flavor: "light", identity_mode: "off", rounds: 20, limits: "", pair_code: "" },
    game: null,          // { game_id, player_token, board, status, ... }
    msgs: [],            // 荷官与玩家的对话（与扮演模式完全隔离）
    setupMsgs: [],       // 「开局」整页对话界面的聊天记录（关掉再回来还在）
    boardFolded: false,  // 牌桌上棋盘是否收起（屏幕小的时候要先看对话）
    /* 谁在玩 + AI 代打。persona 留空 —— 内容归 config，代码里不写玩法。 */
    ai: { p1: false, p2: true, persona: "", auto: 5 }
  };

  const state = {
    mode: "rp",          // rp（老虎机/扮演）| mono（大富翁）
    view: "slot",        // rp: slot | scene · mono: mono · 两者都可进 cfg
    scene: null,         // { id, world, msgs, cuts, createdAt, updatedAt }
    pick: {},            // 老虎机当前摇到的词 { "世界": "...", ... }
    world: null,         // 摇出来的世界卡
    mono: JSON.parse(JSON.stringify(MONO_DEFAULT)),
    cfg: Object.assign({}, CFG_DEFAULT),
    models: JSON.parse(JSON.stringify(MODELS_DEFAULT)),
    pools: JSON.parse(JSON.stringify(POOLS_DEFAULT)),
    running: false,
    autoRunning: false,  // 是不是「自动跑」在跑（决定快捷条显示「自动跑」还是「停下」）
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
    const monoSaved = lsRead(K_MONO, null);
    state.mono = monoSaved
      ? mergeDeep(JSON.parse(JSON.stringify(MONO_DEFAULT)), monoSaved)
      : JSON.parse(JSON.stringify(MONO_DEFAULT));
    state.mode = lsRead(K_CFG + "_mode", "rp") === "mono" ? "mono" : "rp";
  }
  function mergeDeep(base, over) {
    Object.keys(over || {}).forEach((k) => {
      const v = over[k];
      if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) mergeDeep(base[k], v);
      else base[k] = v;
    });
    return base;
  }
  function save() {
    lsWrite(K_CFG, state.cfg);
    lsWrite(K_CFG + "_mode", state.mode);
    lsWrite(K_CFG + "_models", state.models);
    lsWrite(K_POOL, state.pools);
    lsWrite(K_MONO, {
      endpoint: state.mono.endpoint, token: state.mono.token, rulesAck: state.mono.rulesAck,
      rules: state.mono.rules, ack: state.mono.ack, setup: state.mono.setup, game: state.mono.game,
      /* ⚠️ 这里是**显式白名单**，加了字段忘了加进来就会"设置看着生效、刷新就没了"。
         ai（谁在玩 / 风格 / 轮数）和 boardFolded 就是这么漏过一次 —— 截图才发现。 */
      ai: state.mono.ai, boardFolded: state.mono.boardFolded,
      msgs: (state.mono.msgs || []).slice(-60),
      setupMsgs: (state.mono.setupMsgs || []).slice(-60)
    });
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

  /* ══════════════════════════ MCP 客户端（大富翁）══════════════════════════
     上游（RennAkira/spicy-monopoly）把玩法压成 6 个高层工具，本包就当 MCP **客户端**
     直接调它们 —— 不自己写 HTTP 玩法，也不自己编骰子/任务/金币。

     ⚠️ 三个部署现实（不改就调不通，别在这儿浪费时间 debug）：
       1 Pages 是 HTTPS → MCP 端点必须也是 **HTTPS**，否则浏览器按"混合内容"直接拦。
       2 跨域 → 那个端点必须回 `Access-Control-Allow-Origin`。自建的话在 nginx 上加一行。
       3 端口 → 腾讯云安全组 + 本机 ufw 两道关卡都要放行（这机器上踩过很多次）。
     所以端点做成可配：默认指向上游公开实例（开箱即用），自部署后改一行即可。
     （MCP_DEFAULT 常量在文件顶部 state 之前声明，这里只是说明，不再重复定义。） */

  /* 6 个工具（与上游 mcp-server.js 一致）。中文说明原样取自上游手册，
     这样模型知道每条规矩，而不是靠我转述。 */
  const MONO_TOOLS = [
    { name: "monopoly_help", description:
      "查看当前连接的 API、MCP 荷官规则，返回 rules_ack（开局必须带上）。",
      parameters: { type: "object", properties: {} } },
    { name: "new_game", description:
      "开局。必须先向玩家说明胜负/攻受反转/安全词 404/skip/swap，并问完强度等设置，" +
      "才能带 setup_confirmed=true 和 rules_ack。否则返回 setup_required 和 checklist，不会开局。",
      parameters: { type: "object", properties: {
        p1_name: { type: "string", description: "玩家1名字" },
        p2_name: { type: "string", description: "玩家2名字" },
        p1_sex: { type: "string", enum: ["男", "女"] },
        p2_sex: { type: "string", enum: ["男", "女"] },
        p1_role: { type: "string", enum: ["攻", "受"] },
        p2_role: { type: "string", enum: ["攻", "受"] },
        lineup: { type: "string", enum: ["男女", "男男", "女女"] },
        flavor: { type: "string", enum: ["light", "medium", "heavy"], description: "强度档位" },
        identity_mode: { type: "string", enum: ["off", "mixed", "nsfw_only"] },
        rounds: { type: "integer", description: "回合数" },
        limits: { type: "string", description: "红线/不想碰的内容" },
        pair_code: { type: "string", description: "专属暗号，撞名时才用" },
        setup_confirmed: { type: "boolean" },
        rules_ack: { type: "string", description: "来自 monopoly_help" }
      }, required: ["p1_name", "p2_name", "p1_sex", "p2_sex", "p1_role", "p2_role", "setup_confirmed", "rules_ack"] } },
    { name: "roll", description:
      "每轮掷骰，也会结算上一轮悬着的任务/过路费/对决。只传 game_id，不要传玩家名。",
      parameters: { type: "object", properties: {
        game_id: { type: "string" },
        task: { type: "string", enum: ["done", "skip"], description: "仅在上一轮提示时才传" },
        toll: { type: "string", enum: ["pay", "serve"], description: "仅在提示时才传" },
        super_action: { type: "string", enum: ["done", "buyout"], description: "仅在提示时才传" },
        guess: { type: "string", enum: ["大", "小"], description: "仅在提示时才传" }
      }, required: ["game_id"] } },
    { name: "game_action", description:
      "所有非掷骰的操作：skip / swap / duel_result / final_result / 功能卡 / 身份事件 / 淫纹猜测。",
      parameters: { type: "object", properties: {
        action: { type: "string" },
        game_id: { type: "string" },
        who: { type: "string", description: "必须是开局时的玩家原名" }
      }, required: ["action", "game_id"] } },
    { name: "game_info", description: "只读查询：state / shop / list_games / pair_history。",
      parameters: { type: "object", properties: {
        query: { type: "string", enum: ["state", "shop", "list_games", "pair_history"] },
        game_id: { type: "string" }
      }, required: ["query"] } },
    { name: "game_admin", description: "少用的管理动作：delete_game / clear_pair_history / submit_feedback。",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["delete_game", "clear_pair_history", "submit_feedback"] },
        game_id: { type: "string" },
        player_token: { type: "string" }
      }, required: ["action"] } }
  ];
  /* 上游原话：任何人说 404 / 停 / 红线 / 不想做，立刻 skip 或停止 */
  const MONO_SAFETY = /^(404|停|【停】|\[停\]|不想做|不做了|红线|STOP|stop)$/i;

  let rpcId = 0, mcpSession = null, mcpReady = false;

  async function mcpPost(body, wantSession) {
    const url = String(state.mono.endpoint || "").trim();
    if (!url) throw new Error("还没填 MCP 端点地址 —— 到「端点设置」里填一个（默认已指向上游公开实例）。");
    const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
    if (state.mono.token) headers["Authorization"] = "Bearer " + state.mono.token;
    if (mcpSession) headers["Mcp-Session-Id"] = mcpSession;
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error("连不上 MCP 端点（" + url + "）。常见三个原因：端点不是 HTTPS（Pages 会按混合内容拦掉）、"
        + "没有回 CORS 头、云服务器的安全组/ufw 没放这个端口。（" + ((e && e.message) || e) + "）");
    }
    const sid = wantSession ? res.headers.get("Mcp-Session-Id") : null;
    const raw = await res.text();
    if (!res.ok) {
      let d = "HTTP " + res.status;
      try { const j = JSON.parse(raw); if (j && j.error && j.error.message) d = j.error.message; } catch (_) { }
      throw new Error(d);
    }
    /* 服务端可能回普通 JSON，也可能回 SSE —— 两种都要能吃 */
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
    if (!msg) throw new Error("MCP 返回了看不懂的东西：" + String(raw).slice(0, 90));
    if (msg.error) throw new Error("MCP 报错 " + msg.error.code + "：" + (msg.error.message || ""));
    return { result: msg.result, sid };
  }
  async function mcpHello(force) {
    if (mcpReady && !force) return;
    const r = await mcpPost({
      jsonrpc: "2.0", id: ++rpcId, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tidal-echo-rp", version: "1" } }
    }, true);
    if (r.sid) mcpSession = r.sid;
    mcpReady = true;
    mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false).catch(() => { });
  }
  async function mcpCall(name, args) {
    /* 有些部署不要求握手 —— 握手失败也照样直连，不在这里卡住整个流程 */
    await mcpHello(false).catch(() => { });
    const once = () => mcpPost({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args || {} } }, false);
    let r;
    try { r = await once(); }
    catch (e) {
      if (/session|initialized|初始化/i.test(String((e && e.message) || ""))) {
        mcpReady = false; mcpSession = null;
        await mcpHello(true);
        r = await once();
      } else throw e;
    }
    const res = r.result || {};
    const text = ((res.content) || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
    let data = null;
    if (res.structuredContent) data = res.structuredContent;
    else { try { data = JSON.parse(text); } catch (_) { } }
    return { text, data, isError: !!res.isError };
  }

  /* 非流式的完整调用（工具循环必须用它 —— 流式拿不到 tool_calls 的完整结构） */
  async function callJson(slotKey, messages, tools, signal) {
    const conn = resolve(state.models[slotKey]);
    if (!conn) throw new Error("「" + slotName(slotKey) + "」这个位置还没配模型 —— 到「⋯ → 配置」里给它选一个。");
    if (!conn.model) throw new Error("「" + slotName(slotKey) + "」没填模型名。");
    const body = { model: conn.model, messages, temperature: (state.models[slotKey].temp != null ? state.models[slotKey].temp : 0.9) };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
    const res = await fetch(conn.url, { method: "POST", headers: conn.headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      let d = "HTTP " + res.status;
      try { const j = await res.json(); if (j && j.error && j.error.message) d = j.error.message; } catch (_) { }
      throw new Error("「" + slotName(slotKey) + "」返回错误：" + d);
    }
    const j = await res.json();
    const m = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    return m;
  }

  /* 从工具返回里把该记住的东西抓出来（game_id / 棋盘 / 状态 / 规则回执） */
  function monoAbsorb(r, name) {
    const d = r.data || {};
    const g = state.mono.game || (state.mono.game = {});
    if (d.game_id) g.game_id = d.game_id;
    if (d.player_token) g.player_token = d.player_token;
    if (typeof d.board === "string" && d.board) g.board = d.board;
    if (d.status) g.status = d.status;
    if (d.active_limits) g.active_limits = d.active_limits;
    if (d.history_note) g.history_note = d.history_note;
    if (d.intensity_note) g.intensity_note = d.intensity_note;
    if (d.identity_reminder) g.identity_reminder = d.identity_reminder;
    /* 棋盘也可能直接躺在文本里（瘦身模式下不一定有结构化字段） */
    if (!g.board && typeof r.text === "string") {
      const m = /"board"\s*:\s*"?([\s\S]{20,}?)"?\s*[,}]/.exec(r.text);
      if (m) g.board = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    if (name === "monopoly_help" && d.rules_ack) { state.mono.rulesAck = d.rules_ack; }
    if (name === "monopoly_help") {
      state.mono.rules = [d.host_rules, d.safety_rules, d.setup_questions].filter(Boolean).join("\n\n")
        || r.text.slice(0, 3000);
    }
    save();
  }

  /* 荷官的 system：把上游手册的规矩原样压给模型。
     ⚠️ 这里**不含任何内容** —— 规则与卡库都在你部署的那套引擎里。 */
  function monoSystem() {
    const g = state.mono.game || {};
    const ai = state.mono.ai || {};
    const p1 = state.mono.setup.p1_name || "玩家1";
    const p2 = state.mono.setup.p2_name || "玩家2";
    const anyAi = !!(ai.p1 || ai.p2);
    const whoPlays = [
      "· " + p1 + "：" + (ai.p1 ? "**AI（你自己）**" : "人类（你只能等他在聊天里说，不要替他决定）"),
      "· " + p2 + "：" + (ai.p2 ? "**AI（你自己）**" : "人类（你只能等他在聊天里说，不要替他决定）")
    ].join("\n");
    return [
      "你是这局大富翁的荷官，同时是玩家之一。用 spicy-monopoly MCP 工具驱动游戏，不要自己写玩法。",
      "",
      "【规矩（照上游 MCP 使用说明执行）】",
      "· 绝不自己编骰子、任务、金币、赢家或隐藏位置 —— 一律以工具返回为准。",
      "· roll 只传 game_id，不要传玩家名；轮到谁由游戏自动决定。",
      "· roll 的结算参数（task / toll / super_action / guess）只在上一轮返回里提示了才传。",
      "· game_action 必须带 action 和 game_id；大部分还要带 who，且必须是开局时的原名。",
      "· 工具返回 ok:false / error / action_needed 时，照提示修正后重新调用，不要假装成功。",
      "· 棋盘（board）**原样贴给玩家**，不要重画成表格或 ASCII 图 —— 它已经排好版了。",
      "· 任何人说 404 / 停 / 红线 / 不想做，立刻用 game_action 的 skip，或停止游戏。",
      "· 玩家已在设置面板确认过开局参数（setup_confirmed=true），不要再追问一遍。",
      "",
      "【这一局谁在玩】",
      whoPlays,
      anyAi
        ? [
            "★ 标了「AI（你自己）」的那一席，**轮到他时你必须自己拍板**：该掷骰就调 roll，",
            "  该选结算参数（done/skip、pay/serve、done/buyout、大/小）就自己选一个，",
            "  **不要停下来问他、也不要说「该你了」** —— 他没在电脑前，问了就卡住。",
            ai.persona ? "· 他的玩法风格：" + ai.persona : "· 玩法风格：没特别设定，按最省事、最不容易翻车的方式走。",
            "· 你替 AI 那一席做的每个决定，都要用一句话说明理由，别默默调工具。",
            "",
            "【什么时候才停下来等人类】只有这三种，其余情况一律自己往下走：",
            "1 人类玩家主动说话；2 牵涉到安全词 / 红线；3 工具返回的信息确实不足以判断该怎么选。",
            "真要停下来时，回复的**最后单独一行**写：【等你】＋一句话说明在等什么。"
          ].join("\n")
        : "（两边都是人类，你只负责主持和贴棋盘。）",
      "",
      state.mono.rulesAck ? "rules_ack：" + state.mono.rulesAck : "rules_ack：（还没取，先调 monopoly_help）",
      g.game_id ? "\n当前 game_id：" + g.game_id : "",
      g.board ? "\n【当前棋盘（原样贴给玩家，别重画）】\n" + g.board : ""
    ].filter(Boolean).join("\n");
  }

  /* 一回合的荷官循环：模型 → 工具 → 模型，直到它不再调工具为止。
     迭代上限是硬闸门，防止模型绕圈子。 */
  const MONO_MAX_STEPS = 6;
  /* 工具轨迹是给人看的，别吐原始 JSON。
     优先挑工具返回里本来就写给人看的字段；实在没有，就把 JSON 语法洗掉、只留一句话。
     （之前直接把返回原文塞进界面，是一大坨带 \n 转义的乱码 —— 截图上一眼就看出来了。） */
  function briefOf(r) {
    const d = (r && r.data) || {};
    const pick = d.step || d.note || d.message || d.summary || d.status
      || (d.action_needed ? "需要选：" + d.action_needed : "")
      || (d.board ? "棋盘已更新" : "");
    if (pick && typeof pick === "string") return pick.replace(/\s+/g, " ").slice(0, 60);
    return String((r && r.text) || "")
      .replace(/\\[nrt]/g, " ")
      .replace(/[{}\[\]"]/g, " ")
      .replace(/\b[a-z_]+\s*:/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 60);
  }
  async function monoAgent(userText) {
    const tools = MONO_TOOLS.map((t) => ({ type: "function", function: t }));
    const msgs = [{ role: "system", content: monoSystem() }];
    (state.mono.msgs || []).slice(-12).forEach((m) => {
      if (m.who === "user") msgs.push({ role: "user", content: m.text });
      else if (m.who === "host") msgs.push({ role: "assistant", content: m.text });
    });
    msgs.push({ role: "user", content: userText });
    const trace = [];
    for (let i = 0; i < MONO_MAX_STEPS; i++) {
      if (state.abort) break;
      let out;
      try { out = await callJson("char", msgs, tools, state.ctrl && state.ctrl.signal); }
      catch (e) {
        /* ⚠️ 人手按的「停下」会让 fetch 抛 AbortError —— 那**不是故障**，
           别在对话里留一行 "signal is aborted without reason" 吓人。
           （这个坑是牌桌测试里按停之后，从截图上发现的。） */
        if (state.abort || /abort/i.test(((e && e.name) || "") + ((e && e.message) || ""))) {
          return { reply: "", aborted: true, trace };
        }
        return { reply: "（荷官没回上话）" + ((e && e.message) || e), trace, err: true };
      }
      if (out.tool_calls && out.tool_calls.length) {
        msgs.push(out);
        for (const tc of out.tool_calls) {
          let args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { }
          trace.push({ name: tc.function && tc.function.name, args });
          let r;
          try { r = await mcpCall(tc.function.name, args); }
          catch (e) { r = { text: "调用失败：" + ((e && e.message) || e), isError: true }; }
          monoAbsorb(r, tc.function.name);
          trace[trace.length - 1].ok = !r.isError;
          trace[trace.length - 1].brief = briefOf(r);
          renderMono(); renderTable();                      // 每步都把新棋盘画出来，看得见进展
          msgs.push({ role: "tool", tool_call_id: tc.id, content: String(r.text || "").slice(0, 4000) });
        }
        continue;
      }
      return { reply: out.content || "", trace };
    }
    return { reply: "（这一轮工具调用到上限了，先停一下）", trace };
  }

  /* ════════════════════════════ 渲染 ════════════════════════════ */
  const $ = (s, root) => (root || document).querySelector(s);
  let elPanel, elSlot, elScroll, elMsgs, elCfg, elComposer, elInput, elSend, elTitle, elSub, elBack, elMono, elSwitch;
  /* 牌桌（对局整页）那一套 */
  let elTable, elTableSub, elTableBoardbar, elTableSeats, elTableBoard, elTableParams,
      elTableScroll, elTableMsgs, elTableInput, elTableSend, elTableQuick, elTableHint;
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
    const isCfg = state.view === "cfg";
    /* 视图由 mode 决定；没戏的老虎机模式自动落回老虎机页 */
    if (!isCfg && state.mode === "rp" && !hasScene && state.view === "scene") state.view = "slot";
    if (!isCfg && state.mode === "mono" && state.view !== "mono") state.view = "mono";

    const showSlot = !isCfg && state.mode === "rp" && state.view === "slot";
    const showScene = !isCfg && state.mode === "rp" && state.view === "scene";
    const showMono = !isCfg && state.mode === "mono";

    if (elSwitch) {
      elSwitch.classList.toggle("hidden", isCfg);
      elSwitch.querySelectorAll(".rp-mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
    }

    elTitle.textContent = isCfg ? "配置"
      : showMono ? (state.mono.game ? "大富翁" : "开局")
        : (showSlot ? state.cfg.menuName || "万花筒" : ((state.scene.world && state.scene.world.name) || "这一场"));
    elSub.innerHTML = isCfg ? "人设 · 尺度 · 红线 · 模型"
      : showMono ? (state.mono.game ? "掷骰 · 占地 · 抽卡" : "先定规矩，再开局")
        : showSlot ? "摇一排词，开一个世界"
          : ((state.scene.world && state.scene.world.tags || []).slice(0, 3).join(" · ") || "正在演")
          + (state.cfg.blur ? " · <span style='color:#B36A1A'>私密</span>" : "");
    elBack.classList.toggle("hidden", !isCfg);

    elSlot.classList.toggle("hidden", !showSlot);
    elScroll.classList.toggle("hidden", !showScene);
    if (elMono) elMono.classList.toggle("hidden", !showMono);
    elCfg.classList.toggle("hidden", !isCfg);
    elComposer.classList.toggle("hidden", !(showScene || showMono));
    elPanel.classList.toggle("rp-blur", !!state.cfg.blur && !showMono);

    if (showSlot) renderSlot();
    if (showScene) renderMsgs();
    if (showMono) renderMono();
    if (isCfg) renderCfg();
    renderTable();          // 牌桌是独立一层，只要它开着就跟着刷新
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
    const mono = state.mode === "mono";
    elInput.placeholder = mono
      ? "说点什么…（打 404 / 停 立刻停下并跳过）"
      : "说你要做什么、说什么…（打「停」立刻出戏）";
    elSend.classList.toggle("stop", state.running);
    elSend.innerHTML = state.running
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12.5 6l6 6-6 6"/></svg>`;
    elSend.setAttribute("aria-label", state.running ? "停止" : "发送");
    const qb = elComposer.querySelector(".rp-quick");
    if (qb) {
      qb.innerHTML = mono
        ? `<button class="rp-qb stop" data-act="mono-skip">404 停下</button>` +
          `<button class="rp-qb" data-act="mono-roll">掷骰</button>` +
          `<button class="rp-qb" data-act="mono-info">查状态</button>`
        : `<button class="rp-qb stop" data-act="stop-word">【停】出戏</button>` +
          (cuts.length ? `<button class="rp-qb" data-act="cuts">已切除 ${cuts.length} 行</button>` : "") +
          `<button class="rp-qb" data-act="resend"${state.resendAt ? "" : " disabled"}>重发上一句</button>` +
          `<button class="rp-qb" data-act="end">结束这场</button>`;
    }
    const hint = elComposer.querySelector(".rp-hint");
    if (hint) hint.textContent = mono
      ? "安全词 404 / 停 / 红线 / 不想做 → 立刻跳过，不等模型想一轮"
      : "打「停」立刻出戏 · 主角自己决定要不要叫旁白 / NPC";
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
    if (elCfg) elCfg.classList.remove("hidden");
    elSlot.classList.add("hidden");
    elScroll.classList.add("hidden");
    elComposer.classList.add("hidden");
    if (elMono) elMono.classList.add("hidden");
    if (elSwitch) elSwitch.classList.add("hidden");   // 词池是配置的子页，底部切换先收起来
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

  /* ── 大富翁 ──────────────────────────────────────────────────────────── */
  function renderMono() {
    if (!elMono) return;
    const mo = state.mono, g = mo.game || {}, has = !!g.game_id;
    const FL = ["light", "medium", "heavy"];

    /* 0 端点（永远可见，折叠在最后一张卡里） */
    const endpointCard =
      `<div class="rp-mcard">
        <div class="rp-mcard-t">MCP 端点</div>
        <div class="rp-fields">
          <div class="f full"><label>地址（必须是 HTTPS，否则 Pages 会按混合内容拦掉）</label>
            <input data-mf="endpoint" value="${esc(mo.endpoint)}" placeholder="${esc(MCP_DEFAULT)}"></div>
          <div class="f full"><label>访问 token（服务端设了才要填）</label>
            <input data-mf="token" value="${esc(mo.token)}" placeholder="留空"></div>
        </div>
        <div class="rp-macts">
          <button class="rp-btn" data-act="mcp-hello">取荷官规则</button>
          <button class="rp-btn ghost" data-act="mcp-reset">恢复默认端点</button>
        </div>
        <div class="rp-note">自建的话三件事要齐：<b>HTTPS</b>、<b>CORS 头</b>、
          <b>云服务器安全组 + ufw 都放行该端口</b>。任一缺失都会连不上。</div>
      </div>`;

    /* 1 还没连上 */
    if (!mo.rulesAck) {
      elMono.innerHTML =
        `<div class="rp-mcard"><div class="rp-mcard-t">先接上游戏服务端</div>
          <div class="rp-note" style="margin-top:0">连一次就会取回荷官规则和 <code>rules_ack</code>；
            <code>rules_ack</code> 是开局的必备参数，没有它服务端只会回 <code>setup_required</code>。</div>
          <div class="rp-macts"><button class="rp-btn" data-act="mcp-hello">连接并取规则</button></div>
        </div>` + endpointCard;
      return;
    }

    /* 2 已连上、还没开局 → 进「开局」整页对话界面
       ★ 上游的规矩本来就是让荷官**在对话里**把参数问清楚（强度 / 红线 / 阵容 / 角色 /
         身份 / 回合数 / 暗号），不是丢一张表给你填。手机上一度改用表单，
         现在按你的要求改成：点「开局」→ 打开一整页的聊天界面，让它在里面问。 */
    if (!has) {
      const s = mo.setup;
      const got = SETUP_FIELDS.filter((f) => String(s[f.key] ?? "").trim() !== "");
      elMono.innerHTML =
        `<div class="rp-mcard">
          <div class="rp-mcard-t">还没开局</div>
          <div class="rp-note" style="margin-top:0">开局要<b>先聊一聊</b> ——
            它会把强度、红线、阵容、角色、回合数这些问清楚，再把规矩念给你听，然后才开局。
            这一页是<b>整页的对话界面</b>，不和棋盘挤在一起。</div>
          <div class="rps-prog" style="margin-top:9px">
            ${SETUP_FIELDS.map((f) => `<span class="rps-chip${got.some((g) => g.key === f.key) ? " got" : ""}">${esc(f.label)}</span>`).join("")}
          </div>
          <div class="rp-macts">
            <button class="rp-btn" data-act="setup-open">开局：先聊一聊</button>
            <button class="rp-btn ghost" data-act="mono-new">不聊了，直接开</button>
          </div>
          <div class="rp-note">「直接开」用的是上面这些参数的当前值 ——
            名字没填就开不了。</div>
        </div>` + endpointCard;
      return;
    }

    /* 3 进行中 → 这一层只留一个「牌桌」入口。
       ★ 对局本身是**独立一整页的聊天界面**（棋盘钉在顶上），不再把棋盘和消息
         挤成卡片堆在这一层 —— 手机上那样根本没法玩。 */
    const chips = [];
    if (g.game_id) chips.push(`<span class="rp-st">局号 ${esc(String(g.game_id).slice(0, 10))}</span>`);
    if (mo.setup.flavor) chips.push(`<span class="rp-st hot">${esc(mo.setup.flavor)}</span>`);
    if (mo.setup.rounds) chips.push(`<span class="rp-st">${esc(mo.setup.rounds)} 回合</span>`);
    const ai = mo.ai || {};
    const seats = [
      mo.setup.p1_name ? `<span class="rpm-seat ${ai.p1 ? "ai" : "human"}">${esc(mo.setup.p1_name)} · ${ai.p1 ? "AI" : "你"}</span>` : "",
      mo.setup.p2_name ? `<span class="rpm-seat ${ai.p2 ? "ai" : "human"}">${esc(mo.setup.p2_name)} · ${ai.p2 ? "AI" : "你"}</span>` : ""
    ].filter(Boolean).join("");

    elMono.innerHTML =
      `<div class="rp-mcard">
        <div class="rp-mcard-t">这一局在牌桌上</div>
        <div class="rp-status">${chips.join("")}</div>
        <div class="rp-status">${seats}</div>
        <div class="rp-note" style="margin-top:0">对局是<b>一整页的聊天界面</b> ——
          棋盘钉在顶上（可以收起），下面就是你和荷官的对话。
          ${(ai.p1 || ai.p2) ? "标了 <b>AI</b> 的那一席会自己拍板，不用你替他点。" : "两边都是你在玩。"}</div>
        <div class="rp-macts">
          <button class="rp-btn" data-act="table-open">进入牌桌</button>
          <button class="rp-btn ghost" data-act="mono-end">结束这局</button>
        </div>
      </div>`
      + endpointCard;
    renderComposer();
  }

  /* ════════════════ 对局：整页牌桌（棋盘 + 聊天）════════════════════════
     和「开局」那一页同构：整页、盖在万花筒之上，只做一件事 —— 把这局玩下去。 */
  const MONO_PANEL_HTML = `
    <div class="rps-page">
      <div class="rps-top">
        <button data-mact="back" type="button" aria-label="返回">‹</button>
        <div class="rps-title-wrap"><div class="rps-title">大富翁</div><div class="rps-sub rpm-sub"></div></div>
        <button data-mact="params" type="button" aria-label="设置">⚙</button>
        <button data-mact="close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="rpm-boardbar">
        <div class="rpm-bhead">
          <button class="rpm-btoggle" data-mact="board" type="button">棋盘 <span class="rpm-bchev">▾</span></button>
          <div class="rpm-seats"></div>
        </div>
        <pre class="rp-board rpm-board"></pre>
      </div>
      <div class="rps-params rpm-params hidden"></div>
      <div class="rps-scroll rpm-scroll"><div class="rps-msgs rpm-msgs"></div></div>
      <div class="rps-composer rpm-composer">
        <div class="rps-quick rpm-quick"></div>
        <div class="rps-inputrow rpm-inputrow">
          <textarea rows="1" placeholder="说点什么…（打 404 / 停 立刻停下并跳过）" autocomplete="off" spellcheck="false"></textarea>
          <button class="rps-send rpm-send" type="button" aria-label="发送"></button>
        </div>
        <div class="rps-hint rpm-hint"></div>
      </div>
    </div>`;

  /* 模型说「在等你」的标记 —— 出现了就停自动跑（和群聊包的【待确认】同一套路数） */
  const MONO_WAIT = /【等你】|【待你决定】/;

  function monoStage() {
    const g = state.mono.game || {};
    const ai = state.mono.ai || {};
    const seats = [
      state.mono.setup.p1_name ? { name: state.mono.setup.p1_name, ai: !!ai.p1 } : null,
      state.mono.setup.p2_name ? { name: state.mono.setup.p2_name, ai: !!ai.p2 } : null
    ].filter(Boolean);
    return `<span class="rpm-seat ${g.game_id ? "" : "warn"}">${g.game_id ? "局号 " + esc(String(g.game_id).slice(0, 10)) : "还没开局"}</span>` +
      (state.mono.setup.flavor ? `<span class="rpm-seat">${esc(state.mono.setup.flavor)}</span>` : "") +
      seats.map((s) => `<span class="rpm-seat ${s.ai ? "ai" : "human"}">${esc(s.name)} · ${s.ai ? "AI" : "你"}</span>`).join("");
  }

  function monoMsgsHtml(limit) {
    const list = (state.mono.msgs || []).slice(-(limit || 60));
    if (!list.length) {
      return `<div class="rp-sys">（还没有对话）先说一句，或者点下面的「掷骰」／「自动跑」。</div>`;
    }
    return list.map((m) => {
      if (m.who === "user") return `<div class="rp-msg human"><div class="rp-body"><div class="rp-bubble">${esc(m.text)}</div></div></div>`;
      if (m.who === "sys") return `<div class="rp-sys${m.edge ? " edge" : ""}">${esc(m.text)}</div>`;
      return `<div class="rp-msg ai" style="--mc:#3E7BE8">
        <span class="rp-av" style="background:#3E7BE8">荷</span>
        <div class="rp-body">
          <div class="rp-meta"><b>荷官</b>${m.tools ? `<em>${esc(m.tools)}</em>` : ""}</div>
          <div class="rp-bubble">${esc(m.text)}</div>
          ${m.trace ? `<div class="rp-tool"><b>这一轮调了</b> ${esc(m.trace)}</div>` : ""}
        </div></div>`;
    }).join("");
  }

  /* 牌桌上的设置区：谁在玩 / AI 玩法 / 自动跑轮数 / MCP 端点 */
  function renderTableParams() {
    if (!elTableParams || elTableParams.classList.contains("hidden")) return;
    const a = state.mono.ai || (state.mono.ai = { p1: false, p2: true, persona: "", auto: 5 });
    const seg = (k, v, label) =>
      `<button type="button" data-mai="${k}" data-val="${v}" class="${(k === "p1" ? a.p1 : a.p2) === (v === "ai") ? "on" : ""}">${label}</button>`;
    elTableParams.innerHTML =
      `<div class="rpm-ai">
        <div class="rpm-ai-row"><b>${esc(state.mono.setup.p1_name || "玩家1")}</b>
          <span class="rpm-seg">${seg("p1", "human", "你来玩")}${seg("p1", "ai", "AI 来玩")}</span></div>
        <div class="rpm-ai-row"><b>${esc(state.mono.setup.p2_name || "玩家2")}</b>
          <span class="rpm-seg">${seg("p2", "human", "你来玩")}${seg("p2", "ai", "AI 来玩")}</span></div>
        <label class="rp-lbl">AI 的玩法风格（留空就按最省事的方式走）</label>
        <textarea class="rp-ta" data-mai="persona" rows="2" placeholder="比如：爱冒险、喜欢买断、不太在意代价">${esc(a.persona || "")}</textarea>
        <label class="rp-lbl" style="margin-top:8px">一次「自动跑」最多几轮</label>
        <input class="rp-in" type="number" min="1" max="20" data-mai="auto" value="${esc(a.auto || 5)}">
        <div class="rpm-note" style="margin-top:8px">标了 <b>AI</b> 的那一席，轮到他时由模型自己拍板
          （该掷骰就掷、该选结算参数就自己选），不会停下来问你；
          只有你说话、牵涉安全词、或信息不足时它才会标【等你】停下。
          <br>两边都设成「你来玩」也能正常打，只是没有 AI 代打。</div>
      </div>
      <div class="rpm-ai">
        <label class="rp-lbl">MCP 端点（必须是 HTTPS，否则会被按混合内容拦掉）</label>
        <input class="rp-in" data-mf="endpoint" value="${esc(state.mono.endpoint)}" placeholder="${esc(MCP_DEFAULT)}">
        <label class="rp-lbl" style="margin-top:8px">访问 token（服务端设了才要填）</label>
        <input class="rp-in" data-mf="token" value="${esc(state.mono.token)}" placeholder="留空">
        <div class="rp-macts">
          <button class="rp-btn ghost" data-act="mcp-hello">取荷官规则</button>
          <button class="rp-btn ghost" data-act="mcp-reset">恢复默认端点</button>
        </div>
      </div>`;
  }

  function renderTable() {
    if (!elTable || elTable.classList.contains("hidden")) return;
    const g = state.mono.game || {};
    const a = state.mono.ai || {};
    const anyAi = !!(a.p1 || a.p2);

    elTableSub.textContent = (g.game_id ? "局号 " + String(g.game_id).slice(0, 10) : "还没开局")
      + (state.mono.setup.flavor ? " · " + state.mono.setup.flavor : "")
      + (state.running ? (state.autoRunning ? " · 自动跑中…" : " · 正在忙…") : "");

    elTableBoardbar.classList.toggle("folded", !!state.mono.boardFolded);
    elTableSeats.innerHTML = monoStage();
    elTableBoard.textContent = g.board || "（还没有棋盘 —— 掷一次骰子就有了）";
    elTableMsgs.innerHTML = monoMsgsHtml();

    elTableSend.classList.toggle("stop", state.running);
    elTableSend.innerHTML = state.running
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12.5 6l6 6-6 6"/></svg>`;
    elTableSend.setAttribute("aria-label", state.running ? "停止" : "发送");

    elTableQuick.innerHTML =
      (state.running
        ? `<button class="rp-qb stop" data-mact="stop">停下</button>`
        : (anyAi ? `<button class="rp-qb" data-mact="auto">自动跑 ${clamp(+a.auto || 5, 1, 20)} 轮</button>` : "")) +
      `<button class="rp-qb${state.running ? " disabled" : ""}" data-act="mono-roll">掷骰</button>` +
      `<button class="rp-qb" data-act="mono-info">查状态</button>` +
      `<button class="rp-qb stop" data-act="mono-skip">404 停下</button>` +
      `<button class="rp-qb" data-mact="end">结束这局</button>`;

    elTableHint.textContent = anyAi
      ? "标了 AI 的那一席会自己拍板 · 你说「404 / 停」立刻跳过（不等模型）"
      : "两边都是你在玩 · 打 404 / 停 立刻跳过（不等模型）";
    renderTableParams();
  }

  function tableScroll() { if (elTableScroll) elTableScroll.scrollTop = elTableScroll.scrollHeight; }

  function openTable() {
    elTable = ensureTableDom();
    load();
    elTable.classList.remove("hidden");
    requestAnimationFrame(() => elTable.classList.add("open"));
    renderTable(); tableScroll();
  }
  function closeTable() {
    if (!elTable) return;
    elTable.classList.remove("open");
    setTimeout(() => { if (elTable && !elTable.classList.contains("open")) elTable.classList.add("hidden"); }, 300);
  }

  /* 表内动作：棋盘折叠 / 参数区 / 自动跑 / 停下 / 结束 */
  function tableAct(a) {
    if (a === "board") { state.mono.boardFolded = !state.mono.boardFolded; save(); renderTable(); return; }
    if (a === "params") { elTableParams.classList.toggle("hidden"); renderTableParams(); return; }
    if (a === "back" || a === "close") { closeTable(); render(); return; }
    if (a === "stop") { stopAll(); return; }
    if (a === "auto") { monoAuto(); return; }
    if (a === "end") { monoEnd(); return; }
  }

  /* 自动跑：把「AI 自己玩」跑起来。
     一次调用就是一个安全边界 —— 中途按「停下」立刻 break。 */
  async function monoAuto() {
    if (state.running) { stopAll(); return; }        // 再点一次 = 停
    const a = state.mono.ai || {};
    if (!a.p1 && !a.p2) { toast("先在 ⚙ 里把某一席设成「AI 来玩」"); return; }
    const g = state.mono.game;
    if (!g || !g.game_id) { toast("先开一局"); return; }

    state.running = true; state.autoRunning = true; state.abort = false;
    state.ctrl = new AbortController();
    const max = clamp(+a.auto || 5, 1, 20);
    pushMono("sys", "（自动跑开始：最多 " + max + " 轮，随时可以按「停下」）");
    save(); render(); renderTable(); tableScroll();

    try {
      for (let i = 0; i < max; i++) {
        if (state.abort) { pushMono("sys", "（你叫停了）"); break; }
        const out = await monoAgent(
          "（自动）继续这一局。轮到标了「AI」的那一席就由你自己拍板，别停下来等人类。"
          + (i === 0 ? "先从当前局面接着走。" : ""));
        /* 叫停不是故障：留一句「你叫停了」就够，别写成一屏报错 */
        if (out.aborted) { pushMono("sys", "（你叫停了）"); break; }
        pushMono("host", out.reply || "（这一轮它没说话）", !!out.err, out.trace);
        save(); renderTable(); tableScroll();
        if (out.err) break;
        if (MONO_WAIT.test(out.reply || "")) {
          pushMono("sys", "（它标了【等你】，自动跑停在这儿 —— 你回一句话它就接着走）");
          break;
        }
        if (i === max - 1) pushMono("sys", "（到设定的 " + max + " 轮了，先停在这儿；再点一次继续）");
      }
    } catch (e) {
      pushMono("sys", "（自动跑出错）" + ((e && e.message) || e), true);
    } finally {
      state.running = false; state.autoRunning = false; state.ctrl = null;
      save(); render(); renderTable(); tableScroll();
    }
  }

  /* ════════════════════ 开局：整页对话界面 ════════════════════════════
     点「开局」不再是一张表单，而是**新开一整页**、只做一件事：跟荷官把开局参数聊清楚。
     上游的规矩本来就是这个 —— 让 AI 在对话里问，不是丢一张表给人填。 */
  const SETUP_FIELDS = [
    { key: "p1_name", label: "你" }, { key: "p2_name", label: "TA" },
    { key: "flavor", label: "强度" }, { key: "lineup", label: "阵容" },
    { key: "p1_role", label: "你的角色" }, { key: "p2_role", label: "TA 的角色" },
    { key: "identity_mode", label: "身份模式" }, { key: "rounds", label: "回合数" },
    { key: "limits", label: "红线" }, { key: "pair_code", label: "暗号" }
  ];
  /* 开局阶段只给它这三个工具 —— 这时候不该掷骰，也不该有戏内操作 */
  const SETUP_TOOLS = MONO_TOOLS.filter((t) => ["monopoly_help", "new_game", "game_info"].indexOf(t.name) >= 0);
  const SETUP_MAX_STEPS = 8;

  function setupSystem() {
    const s = state.mono.setup;
    const have = SETUP_FIELDS.filter((f) => String(s[f.key] ?? "").trim() !== "");
    return [
      "你是这局大富翁的荷官，现在处于**开局前**阶段。用聊天把开局参数问清楚，然后开局。",
      "",
      "【你要问清楚的】",
      SETUP_FIELDS.map((f) => "· " + f.label).join("\n"),
      "（性别只用 男/女；角色只用 攻/受；阵容只用 男女/男男/女女；强度只用 light/medium/heavy；身份模式只用 off/mixed/nsfw_only）",
      "",
      "【规矩（照上游 MCP 使用说明执行）】",
      "· 先把胜负方式、攻受反转、安全词 404、skip / swap 简要说清楚，再问参数。",
      "· 强度要说明差别（light/medium/heavy 各自对应哪一档），并告诉玩家随时可以改。",
      "· 默认名 / 常见名先用 game_info 的 pair_history 查一下；撞名就问一个专属暗号。",
      "· 一次别问太多，一两样一口气，聊着来。",
      "· 只有玩家都确认了，才能用 new_game 开局，且必须带 setup_confirmed=true 和 rules_ack。",
      "· 工具返回 setup_required 就照 checklist 继续问，不要硬开。",
      "· 开局成功后把服务端返回的 intensity_note / active_limits / history_note 简明说一遍。",
      "",
      state.mono.rulesAck ? "rules_ack：" + state.mono.rulesAck : "rules_ack：（还没取，先调 monopoly_help）",
      "",
      "【已经收集到的（这些不用再问）】",
      have.length ? have.map((f) => f.label + "：" + String(s[f.key]).trim()).join("\n") : "（还没有）"
    ].join("\n");
  }

  let elSetup, elSetupParams, elSetupScroll, elSetupMsgs, elSetupInput, elSetupSend, elSetupSub;
  const SETUP_PANEL_HTML = `
    <div class="rps-page">
      <div class="rps-top">
        <button data-sact="back" type="button" aria-label="返回">‹</button>
        <div class="rps-title-wrap"><div class="rps-title">开局</div><div class="rps-sub"></div></div>
        <button data-sact="params" type="button" aria-label="参数">⚙</button>
        <button data-sact="close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="rps-params hidden"></div>
      <div class="rps-scroll"><div class="rps-msgs"></div></div>
      <div class="rps-composer">
        <div class="rps-quick"></div>
        <div class="rps-inputrow">
          <textarea rows="1" placeholder="回答它…" autocomplete="off" spellcheck="false"></textarea>
          <button class="rps-send" type="button" aria-label="发送"></button>
        </div>
        <div class="rps-hint">它会在这儿把开局参数问清楚；聊完了自己开局</div>
      </div>
    </div>`;

  function setupPush(who, text) {
    if (!state.mono.setupMsgs) state.mono.setupMsgs = [];
    state.mono.setupMsgs.push({ id: nid("u"), ts: Date.now(), who, text: String(text || "") });
    if (state.mono.setupMsgs.length > 80) state.mono.setupMsgs = state.mono.setupMsgs.slice(-80);
  }
  function setupScroll() { if (elSetupScroll) elSetupScroll.scrollTop = elSetupScroll.scrollHeight; }
  function setupGrow() {
    if (!elSetupInput) return;
    elSetupInput.style.height = "auto";
    elSetupInput.style.height = Math.min(elSetupInput.scrollHeight, Math.round(window.innerHeight * 0.26)) + "px";
  }

  function renderSetup() {
    if (!elSetup || elSetup.classList.contains("hidden")) return;
    const s = state.mono.setup;
    const got = SETUP_FIELDS.filter((f) => String(s[f.key] ?? "").trim() !== "");
    elSetupSub.textContent = "已定 " + got.length + "/" + SETUP_FIELDS.length + " 项"
      + (state.mono.game && state.mono.game.game_id ? " · 已开局" : "");

    /* 参数区默认收起 —— 这一页的主体是聊天，不是表单 */
    if (!elSetupParams.classList.contains("hidden")) {
      elSetupParams.innerHTML =
        `<div class="rps-prog">${SETUP_FIELDS.map((f) =>
          `<span class="rps-chip${got.some((g) => g.key === f.key) ? " got" : ""}">${esc(f.label)}</span>`).join("")}</div>
        <div class="rp-fields">
          <div class="f"><label>你</label><input data-ms="p1_name" value="${esc(s.p1_name)}" placeholder="你的名字"></div>
          <div class="f"><label>TA</label><input data-ms="p2_name" value="${esc(s.p2_name)}" placeholder="TA 的名字"></div>
          <div class="f"><label>你的性别</label><select data-ms="p1_sex">${["女", "男"].map((x) => `<option${s.p1_sex === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="f"><label>TA 的性别</label><select data-ms="p2_sex">${["男", "女"].map((x) => `<option${s.p2_sex === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="f"><label>你的角色</label><select data-ms="p1_role">${["受", "攻"].map((x) => `<option${s.p1_role === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="f"><label>TA 的角色</label><select data-ms="p2_role">${["攻", "受"].map((x) => `<option${s.p2_role === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="f"><label>强度</label><select data-ms="flavor">${["light", "medium", "heavy"].map((x) => `<option value="${x}"${s.flavor === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="f"><label>身份模式</label><select data-ms="identity_mode">${["off", "mixed", "nsfw_only"].map((x) => `<option value="${x}"${s.identity_mode === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="f"><label>回合数</label><input type="number" min="5" max="200" data-ms="rounds" value="${esc(s.rounds)}"></div>
          <div class="f"><label>阵容</label><select data-ms="lineup">${["男女", "男男", "女女"].map((x) => `<option${s.lineup === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="f full"><label>红线 / 不想碰的</label><input data-ms="limits" value="${esc(s.limits)}" placeholder="可留空"></div>
          <div class="f full"><label>专属暗号（撞名时才用）</label><input data-ms="pair_code" value="${esc(s.pair_code)}" placeholder="可留空"></div>
        </div>
        <label class="rp-ack"><input type="checkbox" data-mf="ack"${state.mono.ack ? " checked" : ""}>
          <span>规矩我看过了，也知道随时说「404 / 停 / 红线 / 不想做」就能立刻停下。</span></label>`;
    }

    const list = state.mono.setupMsgs || [];
    elSetupMsgs.innerHTML = list.length
      ? list.map((m) => {
        if (m.who === "user") return `<div class="rp-msg human"><div class="rp-body"><div class="rp-bubble">${esc(m.text)}</div></div></div>`;
        if (m.who === "sys") return `<div class="rp-sys">${esc(m.text)}</div>`;
        if (m.who === "tool") return `<div class="rp-cut"><b>调了</b> ${esc(m.text)}</div>`;
        return `<div class="rp-msg ai" style="--mc:#3E7BE8">
          <span class="rp-av" style="background:#3E7BE8">荷</span>
          <div class="rp-body"><div class="rp-meta"><b>荷官</b></div>
            <div class="rp-bubble">${esc(m.text)}</div></div></div>`;
      }).join("")
      : `<div class="rp-empty">${svgMask()}<h4>开局先聊一聊</h4>
         <p>它会把强度、红线、阵容、角色、回合数问清楚，<br>再把规矩念给你听，然后才开局。</p>
         <button class="rp-btn" data-sact="go">让它开口</button></div>`;

    const qb = elSetup.querySelector(".rps-quick");
    if (qb) qb.innerHTML = ["light", "medium", "heavy", "20 回合", "不设红线", "就按你说的来"]
      .map((x) => `<button class="rps-qb" data-sact="say" data-say="${esc(x)}">${esc(x)}</button>`).join("");
    if (elSetupSend) elSetupSend.disabled = !!state.running;
    setupScroll();
  }

  let setupTimer = null;
  function openSetup() {
    if (!elSetup) return;
    clearTimeout(setupTimer);
    elSetup.classList.remove("hidden");
    if (!state.mono.setupMsgs) state.mono.setupMsgs = [];
    renderSetup();
    requestAnimationFrame(() => requestAnimationFrame(() => { elSetup.classList.add("open"); setupScroll(); }));
  }
  function closeSetup() {
    if (!elSetup) return;
    elSetup.classList.remove("open");
    clearTimeout(setupTimer);
    setupTimer = setTimeout(() => elSetup.classList.add("hidden"), 360);
  }

  /* 开局对话：模型 → 工具（只限 help / new_game / info）→ 模型；
     一旦 new_game 成功就关掉这一页，回到棋盘。 */
  async function setupSend(t) {
    const text = String(t || "").trim();
    if (!text || state.running) return;
    if (!state.mono.rulesAck) {
      setupPush("sys", "还没有荷官规则 —— 先回上一页点「取荷官规则」拿到 rules_ack，开局才带着它。");
      renderSetup(); return;
    }
    setupPush("user", text);
    if (elSetupInput) { elSetupInput.value = ""; setupGrow(); }
    save(); renderSetup();

    state.running = true; state.abort = false; state.ctrl = new AbortController();
    renderSetup();
    const apiTools = SETUP_TOOLS.map((x) => ({ type: "function", function: x }));
    try {
      const msgs = [{ role: "system", content: setupSystem() }];
      (state.mono.setupMsgs || []).slice(-16).forEach((m) => {
        if (m.who === "user") msgs.push({ role: "user", content: m.text });
        else if (m.who === "host") msgs.push({ role: "assistant", content: m.text });
      });
      msgs.push({ role: "user", content: text });
      for (let i = 0; i < SETUP_MAX_STEPS; i++) {
        if (state.abort) break;
        const out = await callJson("char", msgs, apiTools, state.ctrl && state.ctrl.signal);
        if (out.tool_calls && out.tool_calls.length) {
          msgs.push(out);
          for (const tc of out.tool_calls) {
            const name = tc.function && tc.function.name;
            let args = {}; try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { }
            setupPush("tool", name + "  " + JSON.stringify(args).slice(0, 140));
            let r;
            try { r = await mcpCall(name, args); }
            catch (e) { r = { text: "调用失败：" + ((e && e.message) || e), isError: true }; }
            monoAbsorb(r, name);
            msgs.push({ role: "tool", tool_call_id: tc.id, content: String(r.text || "").slice(0, 6000) });
            if (name === "new_game" && state.mono.game && state.mono.game.game_id) {
              setupPush("sys", "开局成功了 —— 回到棋盘。");
              save(); renderSetup();
              setTimeout(() => {
                closeSetup();
                pushMono("sys", "开局了。棋盘钉在牌桌顶上（点「棋盘」可以收起）；"
                  + "标了 AI 的那一席会自己拍板，也可以随时按「自动跑」。");
                save(); render();
                openTable();                       // 开局完直接进牌桌 —— 对局就是整页的
              }, 900);
              return;
            }
          }
          renderSetup();
          continue;
        }
        if (out.content) setupPush("host", String(out.content).trim());
        break;
      }
    } catch (e) {
      setupPush("sys", "（荷官没回上话）" + ((e && e.message) || e));
    } finally {
      state.running = false; state.ctrl = null;
      save(); renderSetup(); setupScroll();
    }
  }

  /* ════════════════════════════ 大富翁：动作 ════════════════════════════ */
  function pushMono(who, text, edge, trace) {
    if (!state.mono.msgs) state.mono.msgs = [];
    state.mono.msgs.push({
      id: nid("m"), ts: Date.now(), who, text: String(text || ""), edge: !!edge,
      tools: trace && trace.length ? trace.map((t) => t.name + (t.ok === false ? "✗" : "✓")).join(" ") : "",
      trace: trace && trace.length ? trace.map((t) => t.name + " → " + (t.brief || "")).join("\n") : ""
    });
    if (state.mono.msgs.length > 80) state.mono.msgs = state.mono.msgs.slice(-80);
  }
  function scrollMono() { if (elMono) elMono.scrollTop = elMono.scrollHeight; }

  /* 一次工具调用的统一外壳：跑 → 吸收 → 记录 → 重画 */
  async function monoRun(name, args, label) {
    if (state.running) return null;
    state.running = true; state.abort = false; state.ctrl = new AbortController();
    render();
    try {
      const r = await mcpCall(name, args);
      monoAbsorb(r, name);
      return r;
    } catch (e) {
      pushMono("sys", (label ? label + "：" : "") + ((e && e.message) || e), true);
      return null;
    } finally {
      state.running = false; state.ctrl = null;
      save(); render(); scrollMono(); tableScroll();
    }
  }

  async function monoStart() {
    if (state.running) return;
    const s = state.mono.setup;
    if (!String(s.p1_name || "").trim() || !String(s.p2_name || "").trim()) { toast("两个人的名字都要填"); return; }
    if (!state.mono.ack) { toast("先勾上那条知情确认"); return; }
    const r = await monoRun("new_game",
      Object.assign({}, s, { setup_confirmed: true, rules_ack: state.mono.rulesAck }), "开局失败");
    if (r && state.mono.game && state.mono.game.game_id) {
      closeSetup();                                  // 「不聊了，直接开」时顺手关掉开局那页
      pushMono("sys", "开局了。棋盘钉在牌桌顶上（点「棋盘」可以收起）；"
        + "标了 AI 的那一席会自己拍板，也可以随时按「自动跑」。");
      save(); render();
      openTable();                                   // 直接进牌桌
    }
  }
  async function monoRoll() {
    const g = state.mono.game;
    if (!g || !g.game_id) { toast("先开一局"); return; }
    await monoRun("roll", { game_id: g.game_id }, "掷骰失败");
  }
  async function monoInfo() {
    const g = state.mono.game;
    if (!g || !g.game_id) { toast("先开一局"); return; }
    await monoRun("game_info", { query: "state", game_id: g.game_id }, "查状态失败");
  }
  async function monoSkip() {
    const g = state.mono.game;
    if (!g || !g.game_id) { toast("先开一局"); return; }
    const r = await monoRun("game_action",
      { action: "skip", game_id: g.game_id, who: state.mono.setup.p1_name || "" }, "跳过失败");
    if (r) pushMono("sys", "已跳过这一步。");
    save(); render();
  }
  async function monoEnd() {
    const g = state.mono.game;
    if (!g || !g.game_id) { state.mono.game = null; state.mono.msgs = []; save(); render(); closeTable(); return; }
    if (!confirm("结束这局？棋局会在服务端删掉，本地记录也清空。")) return;
    await monoRun("game_admin", { action: "delete_game", game_id: g.game_id, player_token: g.player_token || "" }, "删除失败");
    state.mono.game = null; state.mono.msgs = [];
    save(); render(); closeTable();
  }
  async function monoHello() {
    const r = await monoRun("monopoly_help", {}, "取规则失败");
    if (r) toast(r.data && r.data.rules_ack ? "已拿到荷官规则" : "连上了，但没拿到 rules_ack");
  }

  /* 大富翁模式下的发送：安全词直通，其余交给荷官（模型 + 工具循环） */
  async function monoSend(t) {
    const g = state.mono.game;
    if (!g || !g.game_id) { toast("先开一局"); return; }
    if (elInput) { elInput.value = ""; autoGrow(); }
    pushMono("user", t);
    save(); render(); scrollMono();

    /* 上游原话：任何人说 404 / 停 / 红线 / 不想做 → 立刻 skip 或停止。
       这条**绕过模型**直接发，安全词不该等模型想一轮。 */
    if (MONO_SAFETY.test(t)) {
      const r = await monoRun("game_action",
        { action: "skip", game_id: g.game_id, who: state.mono.setup.p1_name || "" }, "跳过失败");
      pushMono("sys", r ? "（安全词）已跳过，随时可以再来。" : "（安全词）没能跳过，见上面的报错。", !r);
      save(); render(); scrollMono();
      return;
    }

    state.running = true; state.abort = false; state.ctrl = new AbortController();
    render();
    try {
      const out = await monoAgent(t);
      if (out.aborted) pushMono("sys", "（你叫停了）");
      else pushMono("host", out.reply || "（荷官这一轮没说话）", !!out.err, out.trace);
    } catch (e) {
      pushMono("sys", "（荷官跑不动）" + ((e && e.message) || e), true);
    } finally {
      state.running = false; state.ctrl = null;
      save(); render(); scrollMono();
    }
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
      if (bub && state.cfg.blur && state.mode === "rp") { bub.classList.toggle("revealed"); return; }

      /* 底部模式切换（老虎机 / 大富翁）*/
      const mm = e.target.closest(".rp-mode");
      if (mm) {
        state.mode = mm.dataset.mode === "mono" ? "mono" : "rp";
        state.view = state.mode === "mono" ? "mono" : (state.scene ? "scene" : "slot");
        save(); render();
        /* 已经有局了就直接进牌桌 —— 对局本来就是整页的，不该先在卡片堆里绕一圈 */
        if (state.mode === "mono" && state.mono.game && state.mono.game.game_id) openTable();
        return;
      }

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
        /* ── 大富翁 ── */
        else if (a === "setup-open") openSetup();
        else if (a === "mcp-hello") monoHello();
        else if (a === "mcp-reset") { state.mono.endpoint = MCP_DEFAULT; state.mono.token = ""; mcpReady = false; mcpSession = null; save(); render(); }
        else if (a === "mono-new") monoStart();
        else if (a === "mono-roll") monoRoll();
        else if (a === "mono-info") monoInfo();
        else if (a === "mono-skip") monoSkip();
        else if (a === "mono-end") monoEnd();
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

    /* 大富翁的表单。⚠️ input 只存不重画（重画会抢走焦点、打一个字跳一下）；
       change 才重画 —— 换端点/勾确认这些需要立刻看到反馈。 */
    if (elMono) {
      elMono.addEventListener("input", (e) => {
        const t = e.target, k = t.dataset && t.dataset.ms;
        if (k && t.type !== "number") { state.mono.setup[k] = t.value; save(); }
      });
      elMono.addEventListener("change", (e) => {
        const t = e.target;
        if (t.dataset && t.dataset.mf) {
          const k = t.dataset.mf;
          if (k === "ack") state.mono.ack = !!t.checked;
          else {
            state.mono[k] = t.value.trim();
            mcpReady = false; mcpSession = null;      // 换了端点就得重新握手
          }
          save(); renderMono();
        } else if (t.dataset && t.dataset.ms) {
          const k = t.dataset.ms;
          state.mono.setup[k] = (k === "rounds") ? clamp(+t.value || 20, 5, 200) : t.value;
          save(); renderMono();
        }
      });
    }

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
    if (state.mode === "mono") { monoSend(t); return; }     // 大富翁 → 荷官
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
    state.view = state.mode === "mono" ? "mono" : (state.scene ? "scene" : "slot");
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
      <div class="rp-mono hidden"></div>
      <div class="rp-cfg hidden"></div>
      <div class="rp-switchbar">
        <button class="rp-mode" type="button" data-mode="rp">老虎机<small>摇个世界演一场</small></button>
        <button class="rp-mode" type="button" data-mode="mono">大富翁<small>掷骰 · 占地 · 抽卡</small></button>
      </div>
      <div class="rp-composer hidden">
        <div class="rp-quick"></div>
        <div class="rp-inputrow">
          <textarea rows="1" placeholder="说你要做什么…" autocomplete="off" spellcheck="false"></textarea>
          <button class="rp-send" type="button" aria-label="发送"></button>
        </div>
        <div class="rp-hint">打「停」立刻出戏 · 主角自己决定要不要叫旁白 / NPC</div>
      </div>
    </div>`;

  /* 开局对话是**独立的一整页**：单独一个面板，层级在大富翁之上（200），
     所以打开时它盖住整个万花筒，关掉才回到棋盘那层。 */
  function ensureSetupDom() {
    let el = document.getElementById("rpSetupPanel");
    if (!el) {
      el = document.createElement("div");
      el.className = "rps-panel hidden"; el.id = "rpSetupPanel";
      el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "开局");
      document.body.appendChild(el);
    }
    if (!el.querySelector(".rps-page")) el.innerHTML = SETUP_PANEL_HTML;
    return el;
  }
  function bindSetup() {
    elSetup.addEventListener("click", (e) => {
      const say = e.target.closest("[data-sact='say']");
      if (say) { setupSend(say.dataset.say); return; }
      const s = e.target.closest("[data-sact]");
      if (!s) return;
      const a = s.dataset.sact;
      if (a === "close") closeSetup();
      else if (a === "back") closeSetup();
      else if (a === "params") { elSetupParams.classList.toggle("hidden"); renderSetup(); }
      else if (a === "go") setupSend("开始吧，把要问的问清楚。");
    });
    elSetupSend.addEventListener("click", () => setupSend(elSetupInput.value));
    elSetupInput.addEventListener("input", setupGrow);
    elSetupInput.addEventListener("keydown", (e) => {
      const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); setupSend(elSetupInput.value); }
    });
    /* 参数区里的字段（与 mono 那套同名同逻辑，但绑在这一页上） */
    elSetupParams.addEventListener("input", (e) => {
      const t = e.target, k = t.dataset && t.dataset.ms;
      if (k && t.type !== "number") { state.mono.setup[k] = t.value; save(); }
    });
    elSetupParams.addEventListener("change", (e) => {
      const t = e.target, k = t.dataset && t.dataset.ms;
      if (k) { state.mono.setup[k] = (k === "rounds") ? clamp(+t.value || 20, 5, 200) : t.value; save(); renderSetup(); }
      else if (t.dataset && t.dataset.mf === "ack") { state.mono.ack = !!t.checked; save(); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (elSetup.classList.contains("hidden")) return;
      if (!elSetupParams.classList.contains("hidden")) { elSetupParams.classList.add("hidden"); renderSetup(); }
      else closeSetup();
      e.stopPropagation();
    }, true);
  }

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

  function ensureTableDom() {
    let el = document.getElementById("rpMonoPanel");
    if (!el) {
      el = document.createElement("div");
      /* 复用 .rps-panel 那一套（整页固定 / hidden / open 动画），只用 .rpm-panel 抬高一层 */
      el.className = "rps-panel rpm-panel hidden"; el.id = "rpMonoPanel";
      el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "大富翁");
      document.body.appendChild(el);
    }
    if (!el.querySelector(".rps-page")) el.innerHTML = MONO_PANEL_HTML;
    return el;
  }

  function bindTable() {
    elTable.addEventListener("click", (e) => {
      const q = e.target.closest("[data-mact]");
      if (q) { tableAct(q.dataset.mact); return; }
      /* ⚙ 里那两个「你来玩 / AI 来玩」的按钮（注意 persona/auto 也是 [data-mai]，但不是 button） */
      const seat = e.target.closest("[data-mai]");
      if (seat && seat.tagName === "BUTTON") {
        const k = seat.dataset.mai;
        if (k === "p1" || k === "p2") {
          state.mono.ai[k] = seat.dataset.val === "ai";
          save(); render(); renderTable();
        }
        return;
      }
      const act = e.target.closest("[data-act]");
      if (act) {
        const a = act.dataset.act;
        if (a === "mono-roll") monoRoll();
        else if (a === "mono-info") monoInfo();
        else if (a === "mono-skip") monoSkip();
        else if (a === "mono-end") monoEnd();
        else if (a === "mcp-hello") monoHello();
        else if (a === "mcp-reset") { state.mono.endpoint = MCP_DEFAULT; save(); renderTable(); toast("端点已恢复默认"); }
      }
    });
    elTableSend.addEventListener("click", () => {
      if (state.running) { stopAll(); return; }          // 跑的时候这个键就是「停」
      monoSend(elTableInput.value);
    });
    elTableInput.addEventListener("input", tableGrow);
    elTableInput.addEventListener("keydown", (e) => {
      const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); monoSend(elTableInput.value); }
    });
    /* 设置区：谁在玩 / AI 风格 / 自动跑轮数 / 端点 */
    elTableParams.addEventListener("input", (e) => {
      const t = e.target, k = t.dataset && t.dataset.mai;
      if (k === "persona") { state.mono.ai.persona = t.value; save(); }
      else if (k === "auto") { state.mono.ai.auto = clamp(+t.value || 5, 1, 20); save(); }
      else if (t.dataset && t.dataset.mf === "endpoint") { state.mono.endpoint = t.value; save(); }
      else if (t.dataset && t.dataset.mf === "token") { state.mono.token = t.value; save(); }
    });
    elTableParams.addEventListener("blur", (e) => {
      const k = e.target.dataset && e.target.dataset.mai;
      if (k === "auto" || k === "persona") { save(); renderTable(); }
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!elTable || elTable.classList.contains("hidden")) return;
      if (elTableParams && !elTableParams.classList.contains("hidden")) { elTableParams.classList.add("hidden"); renderTable(); }
      else closeTable();
      e.stopPropagation();
    }, true);
  }
  function tableGrow() {
    if (!elTableInput) return;
    elTableInput.style.height = "auto";
    elTableInput.style.height = Math.min(elTableInput.scrollHeight, Math.round(window.innerHeight * 0.3)) + "px";
  }

  function init() {
    elPanel = ensureDom();
    elSlot = $(".rp-slot", elPanel);
    elScroll = $(".rp-scroll", elPanel);
    elMsgs = $(".rp-msgs", elPanel);
    elCfg = $(".rp-cfg", elPanel);
    elMono = $(".rp-mono", elPanel);
    elSwitch = $(".rp-switchbar", elPanel);
    elComposer = $(".rp-composer", elPanel);
    elInput = $(".rp-inputrow textarea", elPanel);
    elSend = $(".rp-send", elPanel);
    elTitle = $(".rp-title", elPanel);
    elSub = $(".rp-sub", elPanel);
    elBack = $(".rp-top button[data-back]", elPanel);
    elSetup = ensureSetupDom();
    elSetupParams = $(".rps-params", elSetup);
    elSetupScroll = $(".rps-scroll", elSetup);
    elSetupMsgs = $(".rps-msgs", elSetup);
    elSetupInput = $(".rps-inputrow textarea", elSetup);
    elSetupSend = $(".rps-send", elSetup);
    elSetupSub = $(".rps-sub", elSetup);
    elTable          = ensureTableDom();
    elTableSub       = $(".rpm-sub", elTable);
    elTableBoardbar  = $(".rpm-boardbar", elTable);
    elTableSeats     = $(".rpm-seats", elTable);
    elTableBoard     = $(".rpm-board", elTable);
    elTableParams    = $(".rpm-params", elTable);
    elTableScroll    = $(".rpm-scroll", elTable);
    elTableMsgs      = $(".rpm-msgs", elTable);
    elTableInput     = $(".rpm-inputrow textarea", elTable);
    elTableSend      = $(".rpm-send", elTable);
    elTableQuick     = $(".rpm-quick", elTable);
    elTableHint      = $(".rpm-hint", elTable);
    bindTable();
    bindSetup();
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
    _save: save,
    _openTable: () => openTable(),
    _closeTable: () => closeTable(),
    _auto: () => monoAuto(),
    _tableEl: () => document.getElementById("rpMonoPanel")
  };
  window.openRp = open;
})();
