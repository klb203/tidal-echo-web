/* ═══════════════════════════════════════════════════════════════════════════
   Tidal Echo · 群聊（多 AI 协作）— 逻辑层
   ───────────────────────────────────────────────────────────────────────────
   灵感与范式来源：
     · github.com/AZHi-xinxin/tech-hub —— 多 AI 共用一间房间、一个任务账本；
       「群聊 / 进度双页 + 红点」「折叠只影响加载、历史不删」「判断归 AI、程序归通道」
     · CcCompanion 的「三层协作 + 五条硬规则」工作群范式（本包把它落成提示词 + 硬约束）

   ── 三层协作（群里四个位置，一条流水线，不抢话）────────────────────────
     主助手  对你负责：把你的需求澄清成可执行的任务单，派给执行者与互审者；
             不亲自干活，只调度与回话。
     执行者  按任务单真跑真做，交一份结果，然后 @主助手 回报。
             跑不动就先回主助手，不许闷声缩范围。
     互审者  换一个底座的视角看执行结果，挑执行者没看到的盲区，
             给主助手拍板下一步的依据。
     你      在群里看整条链路，决定方向与优先级；中间过程不打扰你，
             但任何环节都能介入拍板。

   ── 五条硬规则（写进每个人的 system prompt，并在代码里兜底）──────────────
     1 派活默认走群      —— 所有调度都发在群里，不私聊
     2 完成必须艾特回报  —— 干完必须 @主助手 报「结果 + 下一步建议」，不许只回「收到」
     3 接任务单全干不偷懒 —— 跑不动先回主助手商量，不许当借口闷声改范围
     4 用户拍板优先      —— 助手只给建议，不擅自决定方向；【待确认】一出现，链条立刻停
     5 多 AI 同时收到不抢 —— 没被 @ 的成员不插话（旁观模式可以打开，但默认关闭）

   ── 代码层面的兜底（不依赖模型自觉）──────────────────────────────────────
     · 规则 2：没被 @ 的成员不会被自动唤起；只有 @ 到的成员进队列
     · 规则 4：applyDirectives 一旦解析到【待确认】→ 立刻 break，剩余轮次全部取消
     · 防车轮：每个成员每轮提问最多跑 maxRunsFor() 次（主助手 2、其余 1），
               再叠一层 maxRounds 上限 —— 三重闸门，不可能无限互刷
     · 去重：同一成员同一轮不重复入队

   ── 与宿主的接缝（尽可能薄）────────────────────────────────────────────
     群聊**不自己建连接体系**，直接复用 index.html 已有的：
       PROVIDERS / cloudHost() / cloudToken() / connChatUrl() / connHeaders() / loadConnections()
     这些在宿主里是 `const`/`function` 顶层声明 —— 属于同一个全局词法环境，
     所以本文件（同级 defer 脚本，在宿主内联脚本之后执行）能按名字直接引用。
     全部读取都包在 try/catch 里；任何一个缺失就降级到自带默认值，
     因此本文件也可以脱离宿主单独跑（见 group-chat-preview.html）。
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ── 存储键（沿用本前端 companion_* 的命名习惯）────────────────────────── */
  const K_MSG   = "companion_group_msgs";
  const K_TASK  = "companion_group_tasks";
  const K_MEM   = "companion_group_members";
  const K_CFG   = "companion_group_settings";
  const MSG_CAP = 400;

  /* ── 三个 AI 成员 + 你 ──────────────────────────────────────────────────
     成员色是本包唯一的硬编码色：三个 AI 必须彼此可辨，所以选了
     蓝 / 青绿 / 琥珀 三个中等明度色（浅底深底都看得清）。
     各自挂一家底座：主助手 DeepSeek、执行者 Kimi、互审者 智谱 GLM。 */
  const MEMBERS_DEFAULT = [
    {
      id: "main", name: "主助手", avatar: "主", color: "#3E7BE8",
      provider: "cloud:deepseek", model: "deepseek-chat", temp: 0.6, connId: "",
      duty: "对你负责：把你的需求澄清成一张可执行的任务单，派给执行者与互审者；不亲自干活，只调度与回话。"
    },
    {
      id: "exec", name: "执行者", avatar: "执", color: "#17A08A",
      provider: "cloud:moonshot", model: "kimi-k2-0711-preview", temp: 0.35, connId: "",
      duty: "按任务单真跑真做，交一份能直接看的结果，然后 @主助手 回报；跑不动先回主助手，不许闷声缩范围。"
    },
    {
      id: "review", name: "互审者", avatar: "审", color: "#D9822B",
      provider: "cloud:zhipu", model: "glm-4-plus", temp: 0.5, connId: "",
      duty: "换一个底座的视角审执行结果，挑出执行者没看到的盲区，给主助手拍板下一步的依据。"
    }
  ];
  const HUMAN = { id: "human", name: "你", avatar: "你", color: "#7E93A4" };

  const CFG_DEFAULT = {
    maxRounds: 3,      // 你发一句话之后，最多自动往下跑几轮
    maxRunsMain: 2,    // 主助手每轮最多被自动唤起几次（派活 + 收尾）
    ctxMsgs: 26,       // 每次发言带多少条群聊记录进上下文
    watchMode: false,  // 旁观模式：开启后没被 @ 的成员也可能补一句（默认关，守规则 5）
    demo: null         // null = 自动（一个连接都没有时用脚本演示）；true/false 手动
  };

  /* ════════════════════════════ 宿主接缝 ════════════════════════════ */

  /* 宿主的这些绑定是顶层 const/function —— 不挂在 window 上，
     所以只能按**名字**引用，不能靠 `name in window` 探测。
     typeof 对未声明标识符安全（返回 "undefined"），对 TDZ 变量会抛 —— 一起 try 掉。 */
  function hostApi() {
    const H = {};
    try { H.PROVIDERS    = (typeof PROVIDERS    !== "undefined") ? PROVIDERS    : null; } catch (_) { H.PROVIDERS = null; }
    try { H.cloudHost    = (typeof cloudHost    === "function")  ? cloudHost    : null; } catch (_) { H.cloudHost = null; }
    try { H.cloudToken   = (typeof cloudToken   === "function")  ? cloudToken   : null; } catch (_) { H.cloudToken = null; }
    try { H.connChatUrl  = (typeof connChatUrl  === "function")  ? connChatUrl  : null; } catch (_) { H.connChatUrl = null; }
    try { H.connHeaders  = (typeof connHeaders  === "function")  ? connHeaders  : null; } catch (_) { H.connHeaders = null; }
    try { H.loadConns    = (typeof loadConnections === "function") ? loadConnections : null; } catch (_) { H.loadConns = null; }
    try { H.toast        = (typeof showToast    === "function")  ? showToast    : null; } catch (_) { H.toast = null; }
    try { H.aiName       = (typeof AI_NAME      === "string")    ? AI_NAME      : "AI"; } catch (_) { H.aiName = "AI"; }
    try { H.humanName    = (typeof HUMAN_NAME   === "string")    ? HUMAN_NAME   : "你"; } catch (_) { H.humanName = "你"; }
    return H;
  }
  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ── 连接模型（provider 描述）──────────────────────────────────────────── */
  const FALLBACK_PROVIDERS = {
    "cloud:deepseek": { name: "☁ 云端 · DeepSeek", ver: "v1", cloud: true, models: ["deepseek-chat", "deepseek-reasoner"] },
    "cloud:moonshot": { name: "☁ 云端 · Kimi",     ver: "v1", cloud: true, models: ["kimi-k2-0711-preview", "moonshot-v1-8k", "moonshot-v1-32k"] },
    "cloud:zhipu":    { name: "☁ 云端 · 智谱 GLM", ver: "v4", cloud: true, models: ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4-long"] },
    "cloud:siliconflow": { name: "☁ 云端 · 硅基流动", ver: "v1", cloud: true, models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"] },
    "cloud:qwen":     { name: "☁ 云端 · 阿里百炼", ver: "v1", cloud: true, models: ["qwen-plus", "qwen-max", "qwen-turbo"] },
    "cloud:volc":     { name: "☁ 云端 · 火山方舟", ver: "v3", cloud: true, models: ["doubao-pro-32k", "deepseek-v3-250324"] },
    "cloud:hunyuan":  { name: "☁ 云端 · 腾讯混元", ver: "v1", cloud: true, models: ["hunyuan-pro", "hunyuan-standard"] },
    "cloud:openai":   { name: "☁ 云端 · OpenAI",   ver: "v1", cloud: true, models: ["gpt-4o", "gpt-4o-mini"] },
    "cloud:openrouter": { name: "☁ 云端 · OpenRouter", ver: "v1", cloud: true, models: ["openai/gpt-4o", "deepseek/deepseek-chat"] },
    "deepseek":   { name: "直连 · DeepSeek", root: "https://api.deepseek.com",           ver: "v1", models: ["deepseek-chat", "deepseek-reasoner"] },
    "moonshot":   { name: "直连 · Kimi (Moonshot)", root: "https://api.moonshot.cn",     ver: "v1", models: ["kimi-k2", "moonshot-v1-8k", "moonshot-v1-32k"] },
    "zhipu":      { name: "直连 · 智谱 GLM", root: "https://open.bigmodel.cn/api/paas",  ver: "v4", models: ["glm-4-plus", "glm-4-air", "glm-4-flash"] },
    "siliconflow":{ name: "直连 · 硅基流动", root: "https://api.siliconflow.cn",         ver: "v1", models: ["deepseek-ai/DeepSeek-V3"] },
    "custom":     { name: "自定义 (OpenAI 兼容)", root: "", ver: "v1", models: [] }
  };
  function providerTable() {
    const H = hostApi();
    return (H.PROVIDERS && Object.keys(H.PROVIDERS).length) ? H.PROVIDERS : FALLBACK_PROVIDERS;
  }
  function pvOf(pid) { return providerTable()[pid] || null; }
  function isCloudPid(pid) { return /^cloud:/.test(pid || ""); }
  /* 根地址补全为 chat/completions 完整地址（与宿主 completeApiUrl 同一套规则） */
  function completeUrl(root, ver, tail) {
    root = String(root || "").trim().replace(/\/+$/, "");
    if (!root) return "";
    if (root.slice(-tail.length) === "/" + tail) return root;
    if (/(^|\/)v\d+$/i.test(root)) return root + "/" + tail;
    return root + "/" + (ver || "v1") + "/" + tail;
  }

  /* 把「一个成员的模型来源」解析成 {url, headers, model, label, cloud}；
     优先级：指名已保存的连接 > 预设 provider（☁ 云端 / 直连）。解析不出来 → null。 */
  function memberConn(m) {
    const H = hostApi();
    /* A. 指名用某个已保存的连接（设置里配好的那一份，模型名可覆盖） */
    if (m.connId && H.loadConns) {
      let list = [];
      try { list = H.loadConns() || []; } catch (_) { list = []; }
      const c = list.find((x) => x && x.id === m.connId);
      if (c) {
        const url = H.connChatUrl ? H.connChatUrl(c) : "";
        if (url) {
          const pid = c.provider || "deepseek";
          const heads = H.connHeaders ? H.connHeaders(c) : { "Content-Type": "application/json" };
          return {
            url, headers: heads,
            model: m.model || c.model || (pvOf(pid) || {}).models?.[0] || "",
            label: c.name || pid,
            cloud: !!(c.cloud || isCloudPid(pid)),
            viaConn: true
          };
        }
      }
    }
    /* B. 走预设 provider */
    const pid = m.provider || "";
    if (!pid) return null;
    const pv = pvOf(pid) || {};
    const model = m.model || (pv.models && pv.models[0]) || "";
    if (isCloudPid(pid)) {
      const host = H.cloudHost ? H.cloudHost() : "";
      if (!host) return null;                                   // 没配云端后端 → 本轮不可用
      const headers = { "Content-Type": "application/json" };
      const tk = H.cloudToken ? H.cloudToken() : "";
      if (tk) headers["X-Relay-Token"] = tk;
      return {
        url: host.replace(/\/+$/, "") + "/relay/" + pid.replace(/^cloud:/, "") + "/" + (pv.ver || "v1") + "/chat/completions",
        headers, model, label: pv.name || pid, cloud: true
      };
    }
    /* C. 浏览器直连（多半会被 CORS 拦，但 DeepSeek 放行） */
    const root = m.base || pv.root || "";
    if (!root) return null;
    const headers = { "Content-Type": "application/json" };
    if (m.key) headers["Authorization"] = "Bearer " + m.key;
    return { url: completeUrl(root, pv.ver, "chat/completions"), headers, model, label: pv.name || pid, cloud: false };
  }

  /* ════════════════════════════ 状态 ════════════════════════════ */

  const state = {
    msgs: [],
    tasks: [],
    members: [],
    settings: Object.assign({}, CFG_DEFAULT),
    view: "chat",          // chat | board | cfg
    busy: new Set(),       // 正在发言的成员 id
    pendingApproval: null, // { text, by, ts }
    abort: false,
    running: false,
    unreadChat: 0,
    unreadBoard: 0
  };

  function lsRead(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }
  function lsWrite(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { } }

  function load() {
    const mm = lsRead(K_MEM, null);
    state.members = Array.isArray(mm) && mm.length
      ? MEMBERS_DEFAULT.map((d) => Object.assign({}, d, (mm.find((x) => x && x.id === d.id) || {})))
      : MEMBERS_DEFAULT.map((d) => Object.assign({}, d));
    state.settings = Object.assign({}, CFG_DEFAULT, lsRead(K_CFG, {}) || {});
    const ms = lsRead(K_MSG, []);
    state.msgs = Array.isArray(ms) ? ms : [];
    const tk = lsRead(K_TASK, []);
    state.tasks = Array.isArray(tk) ? tk : [];
  }
  function saveMsgs() { if (state.msgs.length > MSG_CAP) state.msgs = state.msgs.slice(-MSG_CAP); lsWrite(K_MSG, state.msgs); }
  function save() { saveMsgs(); lsWrite(K_TASK, state.tasks); lsWrite(K_MEM, state.members); lsWrite(K_CFG, state.settings); }

  const memberById = (id) => (id === "human" ? HUMAN : state.members.find((m) => m.id === id) || null);
  const nameOf = (id) => (memberById(id) || { name: id }).name;
  let seq = 0;
  const nid = (p) => p + "_" + Date.now().toString(36) + "_" + (++seq).toString(36);

  function pushMsg(o) {
    const msg = Object.assign({
      id: nid("g"), ts: Date.now(), from: "main", kind: "chat",
      text: "", extras: [], meta: null, streaming: false, err: false
    }, o);
    state.msgs.push(msg);
    return msg;
  }
  function pushSys(text, edge) { return pushMsg({ from: "system", kind: "sys", text, edge: !!edge }); }

  /* ════════════ 协议解析：把成员发言里的四个标记翻译成事件 ════════════
     这些标记不是「形式主义」—— 它们是**链条能自动往下走**的唯一依据。
     模型自由发挥时链条就停在原地；写了标记，执行者才会被唤起、账本才会更新。 */

  const RE_CONFIRM  = /^【待确认】\s*([\s\S]+)$/;
  const RE_DISPATCH = /^【派活】\s*([\s\S]+)$/;
  const RE_REPORT   = /^【回报】\s*([\s\S]+)$/;
  const RE_TASK     = /^【任务】\s*([\s\S]+)$/;
  const RE_NEXT     = /^(?:下一步建议|建议|下一步)[:：]\s*([\s\S]+)$/;
  const MENTION_STRIP = /@[^\s@，。；、|｜]{1,12}/g;

  function parseMentions(text) {
    const t = String(text || "");
    const out = [];
    state.members.forEach((m) => {
      if (new RegExp("@" + m.name).test(t)) out.push(m.id);
    });
    /* 拉丁别名，方便脚本 / 键盘快速 @ */
    if (/@main\b/i.test(t))  out.push("main");
    if (/@exec\b/i.test(t))  out.push("exec");
    if (/@review\b/i.test(t)) out.push("review");
    if (/@(全部|所有人|all)\b/i.test(t)) state.members.forEach((m) => out.push(m.id));
    return Array.from(new Set(out));
  }

  function findTask(ownerId, goal) {
    const list = state.tasks.filter((t) => t.owner === ownerId && !t.done);
    if (!goal) return list[list.length - 1] || null;
    const key = String(goal).slice(0, 24);
    return list.find((t) => t.goal.indexOf(key) >= 0 || key.indexOf(t.goal.slice(0, 24)) >= 0) || list[list.length - 1] || null;
  }
  function newTask(o) {
    const t = Object.assign({
      id: nid("t"), goal: "(未填写目标)", owner: "exec", step: "已派单",
      status: "todo", by: "main", createdAt: Date.now(), updatedAt: Date.now(),
      result: "", block: "", done: false
    }, o);
    state.tasks.push(t);
    if (state.tasks.length > 200) state.tasks = state.tasks.slice(-200);
    return t;
  }
  function touch(t) { t.updatedAt = Date.now(); }

  /* 解析一条成员发言 → 入队下一轮成员 + 更新账本 + 触发【待确认】 */
  function applyDirectives(fromId, text, next) {
    const lines = String(text || "").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let g;

      /* 规则 4：用户拍板优先 —— 一出现就登记待确认，由调用方立刻停链条 */
      if ((g = RE_CONFIRM.exec(line))) {
        state.pendingApproval = { text: g[1].trim(), by: fromId, ts: Date.now() };
        continue;
      }
      /* 规则 1：派活默认走群（就在这条群里消息里）+ 规则 5：只唤起 @ 到的人 */
      if ((g = RE_DISPATCH.exec(line))) {
        const seg = g[1];
        const who = parseMentions(seg);
        /* 任务正文的清洗：剥掉 @提及、行首标点，以及模型爱加的「目标：」「任务：」前缀 ——
           任务卡自己已经有「目标」这个位置了，正文再带一次前缀就是重复。 */
        const goal = seg
          .replace(MENTION_STRIP, "")
          .replace(/^[\s:：\-—、,，]*/, "")
          .replace(/^(目标|任务|需求)\s*[:：]\s*/, "")
          .replace(/^[\s:：\-—]*/, "")
          .trim() || seg;
        const targets = who.length ? who : ["exec"];
        targets.forEach((id) => {
          if (id === fromId) return;
          const prev = findTask(id, goal);
          if (prev){ prev.goal = goal; prev.step = "已派单，等待接单"; prev.status = "todo"; prev.done = false; prev.by = fromId; touch(prev); }
          else newTask({ goal, owner: id, step: "已派单，等待接单", status: "todo", by: fromId });
        });
        next.push(...targets.filter((id) => id !== fromId));
        continue;
      }
      /* 规则 2：完成必须回报 —— 落账本「结果」栏，并让主助手收尾 */
      if ((g = RE_REPORT.exec(line))) {
        const t = findTask(fromId);
        if (t){ t.result = g[1].trim(); t.step = "已完成"; t.status = "done"; t.done = true; t.block = ""; touch(t); }
        else newTask({ goal: "(未登记目标的回报)", owner: fromId, step: "已完成", status: "done", done: true, result: g[1].trim() });
        next.push("main");
        continue;
      }
      /* 执行者可以自己更新账本（进行中 / 阻塞）*/
      if ((g = RE_TASK.exec(line))) {
        const parts = g[1].split(/[|｜]/).map((s) => s.trim()).filter((s) => s !== "");
        const goal = parts[0] || "(未填写目标)";
        const step = parts[1] || "";
        const st   = (parts[2] || "").toLowerCase();
        const t = findTask(fromId, goal) || newTask({ goal, owner: fromId });
        if (parts[0]) t.goal = goal;
        if (step) t.step = step;
        if (/阻塞|失败|卡住|blocked|fail/.test(st)) { t.status = "blocked"; t.block = step || "未说明阻塞原因"; t.done = false; }
        else if (/完成|搞定|done|已交/.test(st)) { t.status = "done"; t.done = true; }
        else { t.status = "doing"; t.done = false; }
        touch(t);
        continue;
      }
    }
  }
  /* 把「下一步建议：…」和「【任务】…」这些行从正文里**剥出来**，交给气泡下面的附件卡显示。
     不剥的话同一句话会出现两遍（正文一遍、卡片一遍），看着像 bug。
     ⚠️ 正则必须**按行**匹配（[^\n]+），不能用 [\s\S]+ —— 后者会一路吃到文末，
        于是整段话都被塞进「任务单」卡片里（这个坑是看真链路的截图抓出来的）。 */
  function splitBody(text) {
    const lines = String(text || "").split(/\r?\n/);
    const body = [], next = [], task = [];
    lines.forEach((raw) => {
      const line = raw.trim();
      let g;
      if ((g = RE_NEXT.exec(line))) { next.push(g[1].trim()); return; }
      if ((g = /^【任务】\s*([^\n]+)$/.exec(line))) {
        const parts = g[1].split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
        if (parts.length) task.push(parts.join(" · "));
        return;
      }
      body.push(raw);
    });
    return {
      body: body.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""),
      next, task
    };
  }

  /* ════════════ 提示词：把「五条硬规则」写进每个人的 system ════════════ */

  function rosterText() {
    return state.members.map((m) => m.name).join(" / ") + " / " + HUMAN.name;
  }
  function roleSys(m) {
    return [
      `你是协作群里的「${m.name}」。群成员：${rosterText()}。`,
      `你的职责：${m.duty}`,
      ``,
      `群规（必须遵守）：`,
      `1. 所有调度都发在群里，不要私聊，也不要绕过群另开会话。`,
      `2. 事情做完必须回报：用「@主助手」点名，写清结果和下一步建议。不许只回一句「收到」「好的」。`,
      `3. 接了任务单就整单干完。跑不动、或需要改范围，先说清楚再动，不要闷声缩范围。`,
      `4. 你只给建议，不替用户决定方向。需要用户拍板的事，用【待确认】标出来，然后停住等。`,
      `5. 没被点到名就不要插话。真有必要才说，且只说一句。`,
      ``,
      `发言方式：像在微信群里发消息，说人话，简短、具体、有判断。不要写「作为一个AI」。`,
      `允许在**行首**使用下面四个标记，只在真需要时才用：`,
      `【派活】@执行者 任务单（目标 / 产出 / 边界，一两句说清）`,
      `【回报】结果一句话`,
      `【任务】目标 | 当前步骤 | 进行中（或 阻塞 / 完成）`,
      `【待确认】要用户拍板的事`,
      `还可以在行首写「下一步建议：…」，它会作为附件显示在气泡下面。`,
      ``,
      `你现在的角色是：${m.name}。`,
      m.id === "main"    ? `你是调度者，不亲自干活：不要输出代码或成品，只输出任务单、判断与收尾。` : ``,
      m.id === "exec"    ? `你是执行者：直接给出结果本身（有数据就给数据，有结论就给结论），不要复述任务单。` : ``,
      m.id === "review"  ? `你是互审者：用和上面两位不同的视角看问题，专挑他们没覆盖到的盲区。不要改写执行者的结论。` : ``
    ].filter(Boolean).join("\n");
  }
  function ledgerBrief() {
    const live = state.tasks.filter((t) => !t.done).slice(-6);
    if (!live.length && !state.pendingApproval) return "";
    const rows = live.map((t) => `· [${t.status}] ${t.goal} —— ${nameOf(t.owner)}：${t.step || "—"}`);
    if (state.pendingApproval) rows.unshift(`· [等拍板] ${state.pendingApproval.text}`);
    return rows.join("\n");
  }
  function transcript(list, n) {
    return list
      .filter((m) => (m.kind === "chat" || m.kind === "sys") && String(m.text || "").trim())
      .slice(-n)
      .map((m) => `【${m.from === "system" ? "系统" : nameOf(m.from)}】${String(m.text).trim()}`)
      .join("\n");
  }
  function buildContext(m) {
    const hist = state.msgs.slice(0, -1);              // 去掉刚建好、还是空的那条气泡
    const tr = transcript(hist, state.settings.ctxMsgs);
    const led = ledgerBrief();
    const blocks = [];
    if (tr) blocks.push("【群聊记录（由早到晚）】\n" + tr);
    if (led) blocks.push("【任务账本】\n" + led);
    const out = [{ role: "system", content: roleSys(m) }];
    if (blocks.length) out.push({ role: "system", content: blocks.join("\n\n") });
    out.push({
      role: "user",
      content: `现在轮到你（${m.name}）发言。读上面的群聊记录，回应最后一条与你有关、或需要你处理的消息。`
        + `\n如果记录里没有任何事需要你处理，就只回一个字「过」，不要硬找话说。`
    });
    return out;
  }

  /* ════════════════════════════ 调模型 ════════════════════════════ */

  function hasAnyUsableConn() {
    return state.members.some((m) => !!memberConn(m));
  }
  function demoOn() {
    const d = state.settings.demo;
    if (d === true || d === false) return d;
    return !hasAnyUsableConn();          // 自动：一个可用连接都没有时，用脚本演示兜底
  }

  /* 真跑一轮；失败抛错（由调用方渲染成错误气泡并给出「用演示跑一遍」的出口） */
  async function callModel(m, messages, onDelta, signal) {
    const conn = memberConn(m);
    if (!conn) throw new Error("这个成员还没有可用的模型 —— 到「⋯ → 角色配置」里给它选一个连接或云端预设。");
    const body = {
      model: conn.model,
      messages,
      stream: true,
      temperature: (m.temp != null ? m.temp : 0.6)
    };
    const res = await fetch(conn.url, {
      method: "POST", headers: conn.headers, body: JSON.stringify(body), signal
    });
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) detail = j.error.message;
        else if (j && j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
        else detail = "HTTP " + res.status + " " + JSON.stringify(j).slice(0, 180);
      } catch (_) { }
      throw new Error("模型返回错误：" + detail + "\n请求地址：" + conn.url + "\n模型：" + conn.model);
    }
    const ctype = (res.headers.get("content-type") || "").toLowerCase();

    /* 有些中转会忽略 stream:true，直接吐一整包 JSON —— 兼容一下，别白等 */
    if (ctype.indexOf("application/json") >= 0 && ctype.indexOf("event-stream") < 0) {
      const j = await res.json();
      const txt = (j && j.choices && j.choices[0] && ((j.choices[0].message || {}).content || j.choices[0].text)) || "";
      if (onDelta) onDelta(txt);
      return { text: txt, model: conn.model, label: conn.label };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", acc = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const d0 = (j.choices && j.choices[0] && j.choices[0].delta) || {};
          const piece = d0.content || "";
          if (piece) { acc += piece; if (onDelta) onDelta(acc); }
        } catch (_) { /* 心跳 / 非 JSON 帧，跳过 */ }
      }
    }
    if (!String(acc).trim()) throw new Error("模型这一次一个字都没返回（可能是 token 上限或内容被过滤）。");
    return { text: acc, model: conn.model, label: conn.label };
  }

  /* 脚本演示：把「三层协作 + 五条硬规则」整条链路跑一遍，
     用的是真标记、真的会入账本、真的会弹【待确认】—— 只是文案是预置的。
     每条演示气泡都会带「演示」角标，绝不冒充真模型输出。 */
  function demoReply(m) {
    const lastUser = state.msgs.filter((x) => x.from === "human").pop();
    const task = String((lastUser && lastUser.text) || "这件事").slice(0, 40);
    const reported = state.msgs.some((x) => x.from === "exec" && x.meta && x.meta.reported);
    /* ★ 拍板之后必须换一条路走。否则「批准 → 主助手又提同一件事 → 再批准」会无限循环，
       演示模式看着就像坏了。（真实模型不会这么呆，但演示脚本会。） */
    const lastSys = state.msgs.filter((x) => x.kind === "sys").pop();
    const decided = lastSys ? String(lastSys.text || "") : "";
    if (m.id === "main" && /^你批准了/.test(decided)) {
      return [
        `收到，照你说的办。`,
        ``,
        `落盘完成，这条链路收尾：`,
        `· 结果已存下，任务账本里那条也标了完成。`,
        `· 没有留尾巴。`,
        ``,
        `下一步建议：这一件事到此为止，有新的事你直接说，我重新派单。`
      ].join("\n");
    }
    if (m.id === "main" && /^你驳回/.test(decided)) {
      return [
        `明白，这个方向撤掉。`,
        ``,
        `我换个思路重新拆一版：先不动结果，只把「为什么原来那版不行」记下来，避免下一版再踩。`,
        ``,
        `下一步建议：你说一句更想要什么样子，我按那个方向派新单。`
      ].join("\n");
    }
    if (m.id === "main" && !reported) {
      return [
        `收到。这件事先别急着动手，我拆成一张单子。`,
        ``,
        `【任务】${task} | 拆需求 | 进行中`,
        `【派活】@执行者 目标：${task}`,
        `边界：只做这件事本身，别顺带改别的；产出要是能直接看的东西（结果 + 自测口径）。`,
        `@互审者 先按兵不动，等执行者交结果再上。`,
        ``,
        `下一步建议：等执行者回来，我把它压成「能用 / 有尾巴 / 要不要继续」三条再给你。`
      ].join("\n");
    }
    if (m.id === "exec") {
      return [
        `【回报】干完了，结果如下（演示数据）：`,
        `· 改动：3 处，主路径打通`,
        `· 自测：主路径通过`,
        ``,
        `下一步建议：让互审者过一眼边界情况 —— 我这边只验了主路径，空输入和超长输入没覆盖。`
      ].join("\n");
    }
    if (m.id === "review") {
      return [
        `我从另一个底座看了一遍，跟执行者的结论有一处不一样：`,
        `· 主路径：同意，没问题。`,
        `· 盲区：空输入 / 超长输入两条没覆盖 —— 这是执行者自己视角看不到的地方。`,
        ``,
        `下一步建议：可以先用，但把那两条记成待办，别当已经完成。`
      ].join("\n");
    }
    return [
      `执行者交回来了，我压成三条：`,
      `1. 结果能不能用 —— 能。`,
      `2. 有没有留尾巴 —— 有，见互审者那条。`,
      `3. 下一步做不做 —— 你说了算。`,
      ``,
      `【待确认】要不要现在就把这条结果落盘（存下来 / 写进记忆）？你点头我再派人去办。`
    ].join("\n");
  }

  /* ════════════════════════════ 编排引擎 ════════════════════════════
     三重闸门防「车轮战」：runs 计数 + depth 上限 + 去重。 */

  function maxRunsFor(id) { return id === "main" ? Math.max(1, state.settings.maxRunsMain || 2) : 1; }
  function dedupe(arr) { return Array.from(new Set(arr.filter(Boolean))); }

  async function runOne(m) {
    state.busy.add(m.id); renderRoster(); render();
    const msg = pushMsg({ from: m.id, kind: "chat", text: "", streaming: true });
    render(); scrollBottom(true);
    const next = [];
    try {
      if (demoOn()) {
        const text = demoReply(m);
        /* 打字机效果，让「边干边报」看得见 */
        for (let i = 1; i <= text.length; i += 3) {
          if (state.abort) break;
          msg.text = text.slice(0, i);
          patchStreaming(msg);
          await sleep(9);
        }
        msg.text = text;
        msg.meta = { model: "脚本演示", label: "演示模式", demo: true };
        if (m.id === "exec") msg.meta.reported = true;
      } else {
        const r = await callModel(m, buildContext(m), (acc) => { msg.text = acc; patchStreaming(msg); }, state.ctrl && state.ctrl.signal);
        msg.text = r.text;
        msg.meta = { model: r.model, label: r.label };
      }
      msg.streaming = false;
      applyDirectives(m.id, msg.text, next);
    } catch (e) {
      msg.streaming = false;
      msg.err = true;
      msg.text = "（这一轮没跑起来）\n" + (e && e.message ? e.message : String(e))
        + "\n\n可以点下面的按钮先用脚本把这个流程跑通，或者到「⋯ → 角色配置」里换一个连接。";
      msg.canDemo = true;
    }
    state.busy.delete(m.id);
    save(); renderRoster(); render();
    return next;
  }

  async function runChain(initial, depth) {
    const runs = {};
    let queue = dedupe(initial);
    while (queue.length && !state.pendingApproval && !state.abort) {
      if (depth >= (state.settings.maxRounds || 3)) {
        pushSys("自动轮次到上限了，我先停住 —— 要我继续就说一声。（这个上限在「⋯ → 角色配置」里调）");
        break;
      }
      let next = [];
      for (const id of queue) {
        if (state.pendingApproval || state.abort) break;
        const m = memberById(id);
        if (!m || m.id === "human") continue;
        if ((runs[id] || 0) >= maxRunsFor(id)) continue;      // 闸门：同一人不在本次提问里反复跑
        runs[id] = (runs[id] || 0) + 1;
        next = next.concat(await runOne(m));
      }
      queue = dedupe(next).filter((id) => (runs[id] || 0) < maxRunsFor(id));
      depth++;
    }
    /* 收尾只在一件事上吭声：有待拍板的事。其余情况链条自然停下就停下，不啰嗦。 */
    if (state.pendingApproval) pushSys("有件事在等你拍板，我先停住不往下跑了。");
    save();
  }

  async function send(text) {
    if (state.running) return;
    const t = String(text || "").trim();
    if (!t) return;
    const mentions = parseMentions(t);
    pushMsg({ from: "human", kind: "chat", text: t, to: mentions });
    clearInput();
    save(); render(); scrollBottom(true);

    /* 规则 5：没 @ 人 → 默认交给主助手；@ 了人 → 只有被 @ 的进队列 */
    const targets = mentions.length ? mentions : ["main"];
    state.running = true; state.abort = false; state.ctrl = new AbortController();
    renderComposerState();
    try { await runChain(targets, 0); }
    finally {
      state.running = false; state.ctrl = null;
      render(); renderComposerState(); scrollBottom();
    }
  }

  function approve() {
    const p = state.pendingApproval; if (!p) return;
    const txt = p.text;
    state.pendingApproval = null;
    pushSys("你批准了：" + txt);
    save(); render();
    if (!state.running) send("批准，继续。");
  }
  function reject() {
    const p = state.pendingApproval; if (!p) return;
    const txt = p.text;
    state.pendingApproval = null;
    pushSys("你驳回了：" + txt + " —— 换个方向再给我一版。");
    save(); render();
    if (!state.running) send("这个方向我不采纳，换个思路重来。");
  }
  function stopAll() {
    state.abort = true;
    if (state.ctrl) { try { state.ctrl.abort(); } catch (_) { } }
    state.busy.clear();
    pushSys("你按了停止，这一轮不往下跑了。");
    save(); render();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ════════════════════════════ 渲染 ════════════════════════════ */

  const $ = (s, root) => (root || document).querySelector(s);
  let elPanel, elMsgs, elScroll, elBoard, elCfg, elInput, elMention, elSend, elAppr, elRoster, elSub, elTitle, elBack, elHintL;
  const bubbleRefs = new Map();

  function av(m, cls) {
    return `<span class="${cls}" style="background:${esc(m.color)}">${esc(m.avatar)}</span>`;
  }
  function fmtTime(ts) {
    const d = new Date(ts), n = new Date();
    const p = (x) => String(x).padStart(2, "0");
    const hm = p(d.getHours()) + ":" + p(d.getMinutes());
    if (d.toDateString() === n.toDateString()) return hm;
    const y = new Date(n.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return "昨天 " + hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); }
  function dayLabel(ts) {
    const d = new Date(ts), n = new Date();
    if (d.toDateString() === n.toDateString()) return "今天";
    const y = new Date(n.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return "昨天";
    return (d.getMonth() + 1) + " 月 " + d.getDate() + " 日";
  }

  /* 把 【标记】 高亮成小徽章，正文仍然是正文 */
  function markText(s) {
    return esc(s)
      .replace(/(^|\n)(【[^】]{2,6}】)/g, (mm, p1, p2) => p1 + '<b style="color:var(--mc,var(--accent))">' + p2 + "</b>")
      .replace(/(@[\u4e00-\u9fa5A-Za-z0-9_]{1,12})/g, '<b style="color:var(--mc,var(--accent))">$1</b>');
  }

  function render() {
    if (!elPanel) return;
    if (elPanel.classList.contains("hidden")) { renderTabs(); return; }

    /* 顶栏 */
    elTitle.textContent = state.view === "cfg" ? "角色配置" : state.view === "board" ? "进度" : "群聊";
    elBack.classList.toggle("hidden", state.view !== "cfg");
    elSub.innerHTML = state.view === "chat"
      ? (state.busy.size
        ? state.members.filter((m) => state.busy.has(m.id)).map((m) => m.name).join("、") + " 正在干"
        : "成员 " + state.members.length + " · 任务 " + state.tasks.filter((t) => !t.done).length
          + (demoOn() ? " · <span style='color:#B36A1A'>演示模式</span>" : ""))
      : state.view === "board"
        ? "任务看板 · 谁在做 / 卡在哪 / 结果"
        : "每个助手挂哪个模型、按什么角色说话";

    /* 视图切换 */
    $(".grp-tabs", elPanel).classList.toggle("hidden", state.view === "cfg");
    elScroll.classList.toggle("hidden", state.view !== "chat");
    elBoard.classList.toggle("hidden", state.view !== "board");
    elCfg.classList.toggle("hidden", state.view !== "cfg");
    $(".grp-composer", elPanel).classList.toggle("hidden", state.view !== "chat");
    $(".grp-roster", elPanel).classList.toggle("hidden", state.view !== "chat");

    if (state.view === "chat") { renderMsgs(); renderApproval(); renderRoster(); renderTabs(); renderComposerState(); }
    if (state.view === "board") { renderBoard(); renderTabs(); }
    if (state.view === "cfg") renderCfg();
  }

  function renderTabs() {
    const tabs = elPanel ? elPanel.querySelectorAll(".grp-tab") : [];
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === state.view));
    const bc = elPanel && $(".grp-tab[data-tab='chat'] .grp-badge", elPanel);
    const bb = elPanel && $(".grp-tab[data-tab='board'] .grp-badge", elPanel);
    if (bc) {
      bc.classList.toggle("on", state.unreadChat > 0);
      bc.classList.toggle("num", state.unreadChat > 1);
      bc.textContent = state.unreadChat > 1 ? String(Math.min(99, state.unreadChat)) : "";
    }
    if (bb) bb.classList.toggle("on", state.unreadBoard > 0);
  }

  function renderRoster() {
    if (!elRoster) return;
    elRoster.innerHTML = state.members.map((m) => {
      const c = memberConn(m);
      const cls = memberConn(m) ? "" : " off";
      return `<button class="grp-chip${state.busy.has(m.id) ? " busy" : ""}${cls}" data-mention="${esc(m.name)}" title="${esc(m.duty)}">
        ${av(m, "cav")}<span>${esc(m.name)}</span>
        <span style="opacity:.6;font-size:10px">${c ? esc(String(c.model).split("/").pop().slice(0, 14)) : "未配置"}</span>
      </button>`;
    }).join("");
  }

  function renderMsgs() {
    const list = state.msgs;
    bubbleRefs.clear();
    if (!list.length) {
      elMsgs.innerHTML =
        `<div class="grp-empty">
          ${svgChat()}
          <h4>群里现在有三个人在等你</h4>
          <p>主助手负责拆需求派活，执行者负责真跑，互审者负责挑盲区。<br>
             在下面输入框里说你要做什么；想指名谁，就打一个 <b>@</b>。</p>
          <button class="grp-btn" data-act="seed">给我一个示例任务</button>
        </div>`;
      return;
    }
    let html = "", lastDay = "";
    for (const m of list) {
      const dk = dayKey(m.ts);
      if (dk !== lastDay) { lastDay = dk; html += `<div class="grp-day">${esc(dayLabel(m.ts))}</div>`; }
      html += msgHtml(m);
    }
    elMsgs.innerHTML = html;
    elMsgs.querySelectorAll(".grp-msg").forEach((n) => {
      const id = n.dataset.mid;
      if (id) bubbleRefs.set(id, $(".grp-bubble", n));
    });
  }

  function msgHtml(m) {
    if (m.kind === "sys") return `<div class="grp-sys${m.edge ? " edge" : ""}">${esc(m.text)}</div>`;
    const who = memberById(m.from) || { name: m.from, avatar: "?", color: "#999" };
    const isHuman = m.from === "human";
    const cls = (isHuman ? "human" : "ai") + (m.err ? " err" : "");
    const meta = [];
    meta.push("<b>" + esc(who.name) + "</b>");
    meta.push("<span>" + esc(fmtTime(m.ts)) + "</span>");
    if (!isHuman && m.meta && m.meta.label) meta.push("<em>" + esc(m.meta.label) + "</em>");
    /* 附件卡 = 「下一步建议」+「任务单」（两者都是渲染期从正文里摘出来的）。
       人类消息不摘 —— 你自己打的字原样显示。 */
    const sp = isHuman ? { body: m.text, next: [], task: [] } : splitBody(m.text);
    const extras = [
      ...(sp.next.length ? [{ k: "下一步建议", v: sp.next.join("；") }] : []),
      ...(sp.task.length ? [{ k: "任务单", v: sp.task.join("；") }] : []),
      ...(m.extras || [])
    ].map((e) => `<div class="grp-extra k" style="--mc:${esc(who.color)}"><b>${esc(e.k)}</b> · ${esc(e.v)}</div>`).join("");
    const demoTag = (!isHuman && m.meta && m.meta.demo) ? `<span class="grp-demo">演示</span>` : "";
    const demoBtn = m.canDemo
      ? `<div class="grp-extra"><b>没有可用模型？</b> 先用脚本把这条链路跑给你看。<br>
         <button class="grp-btn ghost" style="margin-top:7px" data-act="demo-run">用演示跑一遍</button></div>` : "";
    const shown = sp.body;
    const body = shown
      ? `<div class="grp-bubble">${markText(shown)}${demoTag}</div>`
      : `<div class="grp-bubble"><div class="grp-typing"><i></i><i></i><i></i></div></div>`;
    return `<div class="grp-msg ${cls}" data-mid="${esc(m.id)}" style="--mc:${esc(who.color)}">
      ${av(who, "grp-av")}
      <div class="grp-body">
        <div class="grp-meta">${meta.join("")}</div>
        ${body}${extras}${demoBtn}
      </div>
    </div>`;
  }

  /* 流式期间只改气泡文本，不重建整棵树（否则光标/滚动会跳） */
  let rafPending = false;
  function patchStreaming(msg) {
    const b = bubbleRefs.get(msg.id);
    if (b) b.innerHTML = markText(msg.text);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      scrollBottom(true);
    });
  }

  function nearBottom() {
    if (!elScroll) return true;
    return elScroll.scrollHeight - elScroll.scrollTop - elScroll.clientHeight < 120;
  }
  function scrollBottom(force) {
    if (!elScroll) return;
    if (force || nearBottom()) elScroll.scrollTop = elScroll.scrollHeight;
  }

  function renderApproval() {
    if (!state.pendingApproval) { elAppr.classList.add("hidden"); return; }
    const p = state.pendingApproval;
    elAppr.classList.remove("hidden");
    elAppr.innerHTML =
      `<div class="grp-ap-head">${svgAlert()}<span>需要你拍板</span></div>
       <div class="grp-ap-body">${esc(p.text)}</div>
       <div class="grp-ap-meta">${esc(nameOf(p.by))} 提出 · ${esc(fmtTime(p.ts))} · 不点头，链条不会往下走</div>
       <div class="grp-ap-acts">
         <button class="grp-ap-ok" data-act="approve">批准一次</button>
         <button class="grp-ap-no" data-act="reject">拒绝</button>
       </div>`;
  }

  /* ── 进度页（五区，抄 tech-hub 的分区语义）────────────────────────── */
  function renderBoard() {
    const tasks = state.tasks.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const need  = state.pendingApproval ? [state.pendingApproval] : [];
    const doing = tasks.filter((t) => !t.done && t.status !== "blocked");
    const block = tasks.filter((t) => !t.done && t.status === "blocked");
    const DONE_WINDOW = 48 * 3600 * 1000;
    const hist  = tasks.filter((t) => t.done && Date.now() - t.updatedAt < DONE_WINDOW);
    const logs  = state.msgs.filter((m) => m.kind === "sys").slice(-12).reverse();

    const sec = (title, n, alert, body, empty) =>
      `<div class="grp-sec">
        <div class="grp-sec-t"><span>${esc(title)}</span><span class="n${alert ? " alert" : ""}">${n}</span></div>
        ${n ? body : `<div class="grp-note">${esc(empty)}</div>`}
      </div>`;

    const cards = (arr) => arr.map((t) => taskHtml(t)).join("");
    const apCard = need.map((p) =>
      `<div class="grp-task blocked">
        <div class="grp-tk-goal">${esc(p.text)}</div>
        <div class="grp-tk-rows">
          <div class="grp-tk-row"><span class="k">谁在等</span><span class="v">${esc(nameOf(p.by))}</span></div>
          <div class="grp-tk-row"><span class="k">等待内容</span><span class="v hot">你的批准 / 驳回</span></div>
          <div class="grp-tk-row"><span class="k">更新时间</span><span class="v">${esc(fmtTime(p.ts))}</span></div>
        </div>
        <div class="grp-tk-acts">
          <button data-act="approve">批准一次</button>
          <button data-act="reject">拒绝</button>
        </div>
      </div>`).join("");

    elBoard.innerHTML =
      sec("需要你处理", need.length, true, apCard, "没有卡在你这里的事。")
      + sec("进行中", doing.length, false, cards(doing), "暂时没有在跑的活。")
      + sec("阻塞 · 失败", block.length, block.length > 0, cards(block), "没有阻塞。")
      + sec("历史（近 48 小时）", hist.length, false, cards(hist), "还没有完成的任务。")
      + sec("系统记录", logs.length, false,
        logs.map((m) => `<div class="grp-log"><b>${esc(fmtTime(m.ts))}</b> ${esc(m.text)}</div>`).join(""),
        "暂无系统记录。");
  }
  function taskHtml(t) {
    /* 任务卡只给人看五项：目标 / 谁在做 / 当前步骤 / 更新时间 / 结果或阻塞原因 */
    const owner = memberById(t.owner) || { name: t.owner };
    const statusTxt = t.done ? "已完成" : (t.status === "blocked" ? "阻塞" : (t.status === "doing" ? "进行中" : "待接单"));
    /* 五项必须是五个**不同**的信息位：目标 / 谁在做 / 当前步骤 / 更新时间 / 结果或阻塞原因。
       第 5 行以前直接复用 t.step，于是「当前步骤」和「进展」印的是同一句话，白占一行。 */
    const lastLabel = t.status === "blocked" && !t.done ? "阻塞原因" : "结果";
    const last = t.done ? (t.result || "—")
      : (t.status === "blocked" ? (t.block || "未说明原因")
        : (t.result || "还没交付结果"));
    return `<div class="grp-task ${t.done ? "done" : (t.status === "blocked" ? "blocked" : "doing")}">
      <div class="grp-tk-goal">${esc(t.goal)}</div>
      <div class="grp-tk-rows">
        <div class="grp-tk-row"><span class="k">谁在做</span><span class="v">${esc(owner.name)} · ${esc(statusTxt)}</span></div>
        <div class="grp-tk-row"><span class="k">当前步骤</span><span class="v">${esc(t.step || "—")}</span></div>
        <div class="grp-tk-row"><span class="k">更新时间</span><span class="v">${esc(fmtTime(t.updatedAt))}</span></div>
        <div class="grp-tk-row"><span class="k">${lastLabel}</span>
          <span class="v${t.status === "blocked" && !t.done ? " hot" : ""}">${esc(last)}</span></div>
      </div>
      ${t.done ? "" : `<div class="grp-tk-acts"><button data-act="nudge" data-task="${esc(t.id)}">催一下</button></div>`}
    </div>`;
  }

  /* ── 角色配置页 ───────────────────────────────────────────────────── */
  function renderCfg() {
    const H = hostApi();
    let conns = [];
    try { conns = (H.loadConns && H.loadConns()) || []; } catch (_) { conns = []; }
    const pvTable = providerTable();

    const optConns = conns.map((c) =>
      `<option value="conn:${esc(c.id)}"${state.members.some((m) => m.connId === c.id) ? "" : ""}>已配置连接 · ${esc(c.name || c.id)}</option>`).join("");
    const optPv = Object.keys(pvTable).map((pid) =>
      `<option value="${esc(pid)}">${esc((pvTable[pid] || {}).name || pid)}</option>`).join("");

    const roleCards = state.members.map((m) => {
      const cur = m.connId ? ("conn:" + m.connId) : (m.provider || "");
      const pv = pvTable[m.provider] || {};
      const models = (pv.models || []).slice();
      const conn = memberConn(m);
      return `<div class="grp-card" data-role="${esc(m.id)}">
        <div class="grp-card-h">${av(m, "cav")}<div><b>${esc(m.name)}</b><br><span>${esc(m.id === "main" ? "调度 · 不干活" : m.id === "exec" ? "执行 · 真跑真改" : "互审 · 换视角挑盲区")}</span></div></div>

        <label class="grp-lbl">职责（会写进它的系统提示词）</label>
        <textarea class="grp-ta" rows="2" data-f="duty" data-role="${esc(m.id)}">${esc(m.duty)}</textarea>

        <label class="grp-lbl">模型来源</label>
        <select class="grp-sel" data-f="source" data-role="${esc(m.id)}">
          <optgroup label="云端预设（走你的后端转发，不受 CORS 限制）">
            ${Object.keys(pvTable).filter((p) => isCloudPid(p)).map((pid) =>
              `<option value="${esc(pid)}"${cur === pid ? " selected" : ""}>${esc(pvTable[pid].name)}</option>`).join("")}
          </optgroup>
          <optgroup label="浏览器直连（多数会被 CORS 拦）">
            ${Object.keys(pvTable).filter((p) => !isCloudPid(p)).map((pid) =>
              `<option value="${esc(pid)}"${cur === pid ? " selected" : ""}>${esc(pvTable[pid].name)}</option>`).join("")}
          </optgroup>
          ${conns.length ? `<optgroup label="已保存的连接">${conns.map((c) =>
            `<option value="conn:${esc(c.id)}"${cur === "conn:" + c.id ? " selected" : ""}>${esc(c.name || c.id)}</option>`).join("")}</optgroup>` : ""}
        </select>

        <label class="grp-lbl">模型名</label>
        <input class="grp-in" list="grpModels" data-f="model" data-role="${esc(m.id)}" value="${esc(m.model || "")}" placeholder="例如 deepseek-chat / glm-4-plus / kimi-k2-0711-preview">
        <datalist id="grpModels">${models.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>

        <div class="grp-two">
          <div><label class="grp-lbl">温度</label>
            <input class="grp-in" type="number" min="0" max="2" step="0.05" data-f="temp" data-role="${esc(m.id)}" value="${esc(m.temp != null ? m.temp : 0.6)}"></div>
          <div><label class="grp-lbl">名字</label>
            <input class="grp-in" data-f="name" data-role="${esc(m.id)}" value="${esc(m.name)}" maxlength="8"></div>
        </div>

        <div class="grp-note">${conn
          ? `现在会打到：<b>${esc(conn.label || "")}</b> · <code>${esc(String(conn.model || "(未填模型名)"))}</code>`
          : `现在<b>不可用</b>：这条来源解析不出可用地址。最省事的修法是先在「设置 → 云端后端」填上后端地址，再回到这里选一个 ☁ 云端预设。`}</div>
      </div>`;
    }).join("");

    elCfg.innerHTML = roleCards + `
      <div class="grp-card">
        <div class="grp-card-h"><b>运行规则</b></div>
        <div class="grp-switch">
          <div class="t">自动轮次上限
            <small>你发一句话之后，最多自动往下跑几轮。到点就停住等你，不会自说自话刷屏。</small></div>
          <input class="grp-in" type="number" min="1" max="8" step="1" data-f="maxRounds"
                 value="${esc(state.settings.maxRounds)}" style="width:74px;flex:0 0 auto">
        </div>
        <div class="grp-switch">
          <div class="t">主助手每轮最多出场 2 次
            <small>一次派活、一次收尾。这是防「三个 AI 互相刷屏」的硬闸门。</small></div>
          <input class="grp-in" type="number" min="1" max="3" step="1" data-f="maxRunsMain"
                 value="${esc(state.settings.maxRunsMain)}" style="width:74px;flex:0 0 auto">
        </div>
        <div class="grp-switch">
          <div class="t">带进上下文的消息条数
            <small>每次发言往上文带多少条群聊记录。条数越多越「记得住」，也越费 token。</small></div>
          <input class="grp-in" type="number" min="6" max="80" step="2" data-f="ctxMsgs"
                 value="${esc(state.settings.ctxMsgs)}" style="width:74px;flex:0 0 auto">
        </div>
        <div class="grp-switch">
          <div class="t">旁观模式
            <small>开启后，没被 @ 到的成员也可能补一句。默认关 —— 群规第 5 条「不抢话」。</small></div>
          <button class="grp-sw${state.settings.watchMode ? " on" : ""}" data-act="watch"></button>
        </div>
        <div class="grp-switch">
          <div class="t">没有可用连接时用脚本演示
            <small>留空 = 自动（一个连接都没有时演示，有连接就真跑）。演示的每条消息都会标「演示」。</small></div>
          <select class="grp-sel" data-f="demo" style="width:118px;flex:0 0 auto">
            <option value="auto"${state.settings.demo === null ? " selected" : ""}>自动</option>
            <option value="on"${state.settings.demo === true ? " selected" : ""}>始终开</option>
            <option value="off"${state.settings.demo === false ? " selected" : ""}>始终关</option>
          </select>
        </div>
      </div>

      <div class="grp-card">
        <div class="grp-card-h"><b>群规（三个助手都收到的同一份）</b></div>
        <div class="grp-note" style="margin-top:0">
          1 派活默认走群 —— 所有调度都发在群里，不私聊。<br>
          2 完成必须艾特回报 —— 干完要 @主助手 报结果 + 下一步建议。<br>
          3 接任务单全干 —— 跑不动先回主助手，不许闷声缩范围。<br>
          4 用户拍板优先 —— 助手只给建议；【待确认】一出现，链条立刻停。<br>
          5 多 AI 同时收到不抢 —— 没被 @ 的不插话。
        </div>
      </div>

      <div class="grp-card">
        <div class="grp-card-h"><b>数据</b></div>
        <div class="grp-note" style="margin-top:0">
          消息 ${state.msgs.length} 条 · 任务 ${state.tasks.length} 条，都存在本机浏览器里（localStorage），不上传。
        </div>
        <div style="margin-top:9px">
          <button class="grp-btn ghost" data-act="export">导出记录</button>
          <button class="grp-btn danger" data-act="clear">清空群聊</button>
        </div>
      </div>`;
  }

  /* ── 输入区：@ 提及 + 微信式自适应高度 ─────────────────────────────── */
  function renderComposerState() {
    if (!elSend) return;
    const running = state.running;
    elSend.classList.toggle("stop", running);
    elSend.innerHTML = running
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12.5 6l6 6-6 6"/></svg>`;
    elSend.setAttribute("aria-label", running ? "停止" : "发送");
    if (elHintL) {
      elHintL.textContent = running
        ? "它们正在群里干活，要打断就按右边的停止。"
        : "在输入框里打 @ 可以指名派活；不 @ 就默认交给主助手。";
    }
    const stopBtn = elPanel && $(".grp-hint button[data-act='stop']", elPanel);
    if (stopBtn) stopBtn.classList.toggle("hidden", !running);
  }

  function autoGrow() {
    if (!elInput) return;
    elInput.style.height = "auto";
    elInput.style.height = Math.min(elInput.scrollHeight, Math.round(window.innerHeight * 0.34)) + "px";
  }

  function currentQuery() {
    const v = elInput.value, pos = elInput.selectionStart || v.length;
    const before = v.slice(0, pos);
    const m = /@([^\s@]{0,8})$/.exec(before);
    return m ? { word: m[1], start: pos - m[0].length, end: pos } : null;
  }
  function renderMention() {
    const q = currentQuery();
    if (!q) { elMention.classList.add("hidden"); return; }
    const cand = state.members.filter((m) => !q.word || m.name.indexOf(q.word) === 0 || m.name.indexOf(q.word) >= 0);
    const extra = (!q.word || "全部".indexOf(q.word) === 0)
      ? [{ id: "__all__", name: "全部", avatar: "全", color: "#7E93A4", duty: "三个人都收到这一条，各自判断要不要接" }] : [];
    const list = cand.concat(extra);
    if (!list.length) { elMention.classList.add("hidden"); return; }
    elMention.classList.remove("hidden");
    elMention.innerHTML = list.map((m) => `<button class="grp-mn" data-pick="${esc(m.name)}">
      ${av(m, "cav")}<span class="tx"><b>${esc(m.name)}</b><span>${esc(m.duty || "")}</span></span></button>`).join("");
  }
  function insertMention(name) {
    const q = currentQuery(); if (!q) return;
    const v = elInput.value;
    elInput.value = v.slice(0, q.start) + "@" + name + " " + v.slice(q.end);
    const caret = q.start + name.length + 2;
    elInput.setSelectionRange(caret, caret);
    elMention.classList.add("hidden");
    elInput.focus(); autoGrow();
  }
  function clearInput() { if (!elInput) return; elInput.value = ""; autoGrow(); }

  function onSendClick() {
    if (state.running) { stopAll(); return; }
    send(elInput.value);
  }

  /* ════════════════════════════ 事件绑定 ════════════════════════════ */

  function bind() {
    elPanel.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) { insertMention(pick.dataset.pick); return; }
      const chip = e.target.closest("[data-mention]");
      if (chip) { elInput.value = "@" + chip.dataset.mention + " " + elInput.value; elInput.focus(); autoGrow(); return; }
      const tab = e.target.closest(".grp-tab");
      if (tab) {
        state.view = tab.dataset.tab;
        if (state.view === "chat") state.unreadChat = 0;
        if (state.view === "board") state.unreadBoard = 0;
        render(); return;
      }
      if (e.target.closest("[data-close]")) { close(); return; }
      const act = e.target.closest("[data-act]");
      if (act) {
        const a = act.dataset.act;
        if (a === "approve") approve();
        else if (a === "reject") reject();
        else if (a === "stop") stopAll();
        else if (a === "cfg") { state.view = "cfg"; render(); }
        else if (a === "watch") { state.settings.watchMode = !state.settings.watchMode; save(); renderCfg(); }
        else if (a === "clear") {
          if (confirm("清空群聊？消息和任务账本都会删掉，且不可恢复。")) {
            state.msgs = []; state.tasks = []; state.pendingApproval = null; save(); render();
            if (hostApi().toast) hostApi().toast("群聊已清空");
          }
        }
        else if (a === "export") {
          const blob = new Blob([JSON.stringify({ msgs: state.msgs, tasks: state.tasks, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
          const a2 = document.createElement("a");
          a2.href = URL.createObjectURL(blob);
          a2.download = "tidal-group-" + new Date().toISOString().slice(0, 10) + ".json";
          a2.click(); setTimeout(() => URL.revokeObjectURL(a2.href), 4000);
        }
        else if (a === "seed") {
          elInput.value = "帮我把「群聊」这个功能的文案再收紧一点，太长的地方砍掉。";
          autoGrow(); elInput.focus();
        }
        else if (a === "demo-run") {
          const old = state.settings.demo; state.settings.demo = true;
          send("用演示把这套流程跑一遍。").then(() => { state.settings.demo = old; save(); });
        }
        else if (a === "nudge") {
          const t = state.tasks.find((x) => x.id === act.dataset.task);
          if (t) send("@" + nameOf(t.owner) + " 这条卡住了，说说卡在哪：" + t.goal);
        }
        return;
      }
    });

    /* 角色配置的字段编辑（委托 change / input） */
    elCfg.addEventListener("change", onCfgEdit);
    elCfg.addEventListener("input", (e) => {
      const f = e.target.dataset && e.target.dataset.f;
      if (f === "duty" || f === "name") onCfgEdit(e, true);
    });

    if (elInput) {
      elInput.addEventListener("input", () => { autoGrow(); renderMention(); });
      elInput.addEventListener("click", renderMention);
      elInput.addEventListener("keydown", (e) => {
        if (!elMention.classList.contains("hidden")) {
          if (e.key === "Enter" || e.key === "Tab") {
            const first = $(".grp-mn", elMention);
            if (first) { e.preventDefault(); insertMention(first.dataset.pick); return; }
          }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); elMention.classList.add("hidden"); return; }
        }
        const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); onSendClick(); }
      });
      elInput.addEventListener("blur", () => setTimeout(() => elMention.classList.add("hidden"), 160));
    }
    elSend.addEventListener("click", onSendClick);
    elBack.addEventListener("click", () => { state.view = "chat"; render(); });

    /* ESC：本包自己处理（不塞进宿主那条 if/else 链，保持 index.html 的改动最小）。
       用捕获阶段 → 先于宿主的 document keydown 跑，然后 stopPropagation 掉，
       免得同一次 ESC 又把菜单/别的面板关一遍。 */
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (elPanel.classList.contains("hidden")) return;
      if (state.view === "cfg") { state.view = "chat"; render(); e.stopPropagation(); return; }
      if (state.view === "board") { state.view = "chat"; render(); e.stopPropagation(); return; }
      if (state.pendingApproval) { e.stopPropagation(); return; }   // 有待拍板事项时，ESC 不关面板
      close();
      e.stopPropagation();
    }, true);
  }

  function onCfgEdit(e, soft) {
    const t = e.target;
    const f = t.dataset && t.dataset.f;
    if (!f) return;
    const roleId = t.dataset.role;
    if (f === "maxRounds") state.settings.maxRounds = clamp(+t.value || 3, 1, 8);
    else if (f === "maxRunsMain") state.settings.maxRunsMain = clamp(+t.value || 2, 1, 3);
    else if (f === "ctxMsgs") state.settings.ctxMsgs = clamp(+t.value || 26, 6, 80);
    else if (f === "demo") state.settings.demo = t.value === "auto" ? null : (t.value === "on");
    else if (roleId) {
      const m = state.members.find((x) => x.id === roleId);
      if (m) {
        if (f === "name") m.name = (t.value || "").trim().slice(0, 8) || m.name;
        else if (f === "duty") m.duty = t.value;
        else if (f === "model") m.model = t.value.trim();
        else if (f === "temp") m.temp = clamp(+t.value, 0, 2);
        else if (f === "source") {
          const v = t.value;
          if (/^conn:/.test(v)) { m.connId = v.slice(5); }
          else { m.connId = ""; m.provider = v; m.model = ((pvOf(v) || {}).models || [])[0] || m.model; }
        }
      }
    }
    save();
    if (!soft && !e.target.matches("input[data-f='duty'],input[data-f='name']")) renderCfg();
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  /* ════════════════════════════ 开 / 关 ════════════════════════════ */

  let closeTimer = null;
  function open() {
    if (!elPanel) return;
    clearTimeout(closeTimer);
    state.unreadChat = 0;
    elPanel.classList.remove("hidden");
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => { elPanel.classList.add("open"); scrollBottom(true); }));
    if (elInput && !(window.matchMedia && window.matchMedia("(pointer: coarse)").matches)) setTimeout(() => elInput.focus(), 320);
  }
  function close() {
    if (!elPanel) return;
    elPanel.classList.remove("open");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => elPanel.classList.add("hidden"), 360);
  }
  function toggle() { elPanel.classList.contains("open") ? close() : open(); }

  /* ════════════════════════════ 启动 ════════════════════════════ */

  /* 面板标记由本包自带 —— 宿主的 index.html 只需要一个空的 <div id="groupPanel">，
     连这个都可以不写：找不到就自己建一个挂到 body 上。
     好处是「一份标记、两处复用」：正式页面和 group-chat-preview.html 走同一段 HTML，
     不会出现预览跟线上长得不一样那种事。 */
  const PANEL_HTML = `
    <div class="group-page">
      <div class="grp-top">
        <button data-back type="button" aria-label="返回群聊" class="hidden">‹</button>
        <div class="grp-title-wrap">
          <div class="grp-title">群聊</div>
          <div class="grp-sub"></div>
        </div>
        <button data-act="cfg" type="button" aria-label="角色配置" title="角色配置">⋯</button>
        <button data-close type="button" aria-label="关闭">✕</button>
      </div>
      <div class="grp-roster" aria-label="群成员"></div>
      <div class="grp-tabs" role="tablist">
        <button class="grp-tab active" data-tab="chat" type="button" role="tab">群聊<span class="grp-badge"></span></button>
        <button class="grp-tab" data-tab="board" type="button" role="tab">进度<span class="grp-badge"></span></button>
      </div>
      <div class="grp-approval hidden"></div>
      <div class="grp-scroll"><div class="grp-msgs"></div></div>
      <div class="grp-board hidden"></div>
      <div class="grp-cfg hidden"></div>
      <div class="grp-composer">
        <div class="grp-mention hidden"></div>
        <div class="grp-hint">
          <span class="l"></span>
          <button data-act="stop" type="button" class="hidden">停止</button>
        </div>
        <div class="grp-inputrow">
          <textarea rows="1" placeholder="说你要做什么…（打 @ 可以指名派活）" autocomplete="off" spellcheck="false"></textarea>
          <button class="grp-send" type="button" aria-label="发送"></button>
        </div>
      </div>
    </div>`;

  function ensureDom() {
    let el = document.getElementById("groupPanel");
    if (!el) {
      el = document.createElement("div");
      el.className = "group-panel hidden";
      el.id = "groupPanel";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-label", "群聊");
      document.body.appendChild(el);
    }
    if (!el.querySelector(".group-page")) el.innerHTML = PANEL_HTML;
    return el;
  }

  function init() {
    elPanel = ensureDom();
    if (!elPanel) return;
    elMsgs    = $(".grp-msgs", elPanel);
    elScroll  = $(".grp-scroll", elPanel);
    elBoard   = $(".grp-board", elPanel);
    elCfg     = $(".grp-cfg", elPanel);
    elInput   = $(".grp-inputrow textarea", elPanel);
    elMention = $(".grp-mention", elPanel);
    elSend    = $(".grp-send", elPanel);
    elAppr    = $(".grp-approval", elPanel);
    elRoster  = $(".grp-roster", elPanel);
    elSub     = $(".grp-sub", elPanel);
    elTitle   = $(".grp-title", elPanel);
    elBack    = $(".grp-top button[data-back]", elPanel);
    elHintL   = $(".grp-hint .l", elPanel);
    load();
    bind();
    /* 宿主可能在别处把待确认项清了 / 有新任务 → 打开时重算一遍红点 */
    render();
  }

  /* ── 图标（内联，避免多一次请求）────────────────────────────────────── */
  function svgChat() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3.5h7A4.5 4.5 0 0 1 20 8v5a4.5 4.5 0 0 1-4.5 4.5H13L9 21v-3.5h-.5A4.5 4.5 0 0 1 4 13V8a4.5 4.5 0 0 1 4.5-4.5Z"/><path d="M9 9.5h6M9 12.5h4"/></svg>`; }
  function svgAlert() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5 21 19.5H3L12 4.5Z"/><path d="M12 10v4M12 16.6v.4"/></svg>`; }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  /* ── 对外接口 ─────────────────────────────────────────────────────── */
  window.GroupChat = {
    open, close, toggle, init,
    state,
    send,
    reset() { state.msgs = []; state.tasks = []; state.pendingApproval = null; save(); render(); },
    members: () => state.members,
    connOf: (id) => { const m = state.members.find((x) => x.id === id); return m ? memberConn(m) : null; },
    _render: render,
    _load: load
  };
  window.openGroupChat = open;
})();
