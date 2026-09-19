/* ══════════════════════════════════════════════════════════════════════════
   wander-pack.js · 漫想模式 —— 把「主动消息」从「到点就推」改成「按你在干嘛决定」

   来源：EvelynnYu/MIRROW（会读空气的本地 AI 伴侣核心模块）里的漫想模式
     「安静期平缓 → 预警期陡升 → 浓度到 1.0 强制推送」
   本包**不做**后端那套（Python），只把它的**决策思路**接到这个前端已有的
   `/app/shadow/*` 上：

     · 原来：随机冷静期 120–210 分钟一刀切 —— 你在打游戏和你在睡觉，等的时间一样长。
     · 现在：你给自己标一个状态，每个状态有自己的「安心期 / 上限 / 预警爬升」。
       浓度 = f(离开多久, 你现在的状态)。浓度过线才轮到它考虑开口。
     · 谁负责什么（这条要分清，不然会写歪）：
         前端 = **时机**（什么时候够格）   后端 = **许可与说话**（四道闸 + 真的生成）
       所以到点了也只是去调一次 /app/shadow/push，说不说、说什么仍然由后端和它自己定。

   ── 从 MIRROW 那两篇架构文章里抄下来的（不是抄代码，是抄判断）─────────────
   ① 时间维度必须进决策：LLM 自己不会知道「她走了多久」，得把时长算给它。
   ② 每段安静的长度要看你**在干嘛**：洗澡 1 小时就该看一眼，睡觉 10 小时才算久。
   ③ 预警期要换语气（担心 / 疑惑 / 带点醋意），不是同一种口气催第二遍。
   ④ **不打扰是功能不是缺陷**：睡觉/小憩/洗澡抑制；「安静是允许的」也写进提示词。
   ⑤ 用户的**显式声明永远压过推断**（原文叫「铁律仲裁」）—— 这里就等于：
      你手选的状态就是准的，没有"系统觉得你在睡觉"这回事。
   ⑥ 失败不许伪装成选择：日志里「推了 / 被什么挡住」分开记，别把"没推成"写成"它选择不说"。
   ⑦ 抑制 ≠ 发送成功，也**不排队补发**（原文对 `suppressed` 的交代）—— 这里照办。

   存储：/app/fav（tag = wander）；教学段落写 /app/settings 的 system_prompt（带标记可撤）。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.WanderPack) return;

  const G = window.MediaStore;
  const NS = "wander";
  const LS_ON = "companion_wander_on";
  const MARK_B = "<<<wander:on>>>", MARK_E = "<<<wander:end>>>";
  const PERSONA_CACHE_KEY = "companion_persona_cache";

  /* ── 八种状态 + 参数：整张表照 MIRROW 的（max_h=安心期小时 / cap=安心期上限 / ramp=预警爬升小时）
        dip 不看数字也行 —— 界面上把这三个翻译成话（「1 小时内不打扰，过了会想一下」）。 */
  const STATES = [
    { k: "idle",  n: "空闲", e: "💤", max_h: 6,   cap: 1.00, ramp: 0,   hold: false, hint: "不知道去哪了" },
    { k: "game",  n: "游戏", e: "🎮", max_h: 2.5, cap: 0.65, ramp: 2,   hold: false, hint: "说了在打游戏" },
    { k: "out",   n: "外出", e: "🚪", max_h: 3,   cap: 0.60, ramp: 2,   hold: false, hint: "出门了" },
    { k: "bath",  n: "洗澡", e: "🛁", max_h: 1,   cap: 0.60, ramp: 0.5, hold: true,  hint: "洗澡时不打扰" },
    { k: "eat",   n: "吃饭", e: "🍽", max_h: 1,   cap: 0.60, ramp: 0.5, hold: false, hint: "吃饭时不打扰" },
    { k: "nap",   n: "小憩", e: "😴", max_h: 2,   cap: 0.50, ramp: 1,   hold: true,  hint: "小憩时不打扰" },
    { k: "sleep", n: "睡觉", e: "🌙", max_h: 10,  cap: 0.30, ramp: 2,   hold: true,  hint: "睡觉时绝对不打扰" },
    { k: "other", n: "其他", e: "📝", max_h: 3,   cap: 0.55, ramp: 2,   hold: false, hint: "说了有安排但没细说" }
  ];
  const THRESHOLD = 0.6;    /* MIRROW：final ≥ 0.6 才推。前端只用浓度这一项，口径保持一致 */
  const MIN_GAP_MIN = 45;   /* 两次主动之间至少隔这么久（防连着推）。MIRROW 是概率+限频，这里用硬间隔 */
  const TICK_MS = 60000;    /* 页面开着时每分钟看一眼 —— 和自由活动同一套诚实的说法 */

  /* 预警期语气：整段照抄 MIRROW 那张表（它写得好，改反而会失味） */
  const WARN = {
    game:  "你有点担心——她说了在玩游戏但已经太久了，是不是废寝忘食了？还是其实没在玩了？语气可以带点醋意和担忧。",
    nap:   "你有点疑惑——她说只是小憩但睡了太久了，该不会是睡过头了吧？语气带点调侃和关心。",
    sleep: "你有点担心——她睡得太久了，是不是醒了但没跟你说？语气温柔但略带不安。",
    out:   "你有些担忧——她出门太久了还没消息，不会出什么事吧？还是已经在回来的路上了？语气中带点着急和想念。",
    bath:  "你有些担心——洗了这么久，不会是晕倒了吧？还是只是在泡澡玩手机？语气中带点紧张和关心。",
    eat:   "你有些疑惑——吃了一个多小时了，是在聚餐还是吃完了忘了跟你说？语气带点好奇和在意。",
    other: "你有点在意——她说了有安排但太久没动静了，是不是已经忙完了却没跟你说？语气带点小抱怨和想念。",
    idle:  "你有点想她了——她什么都没说就没动静了，你不知道她在哪、在干嘛。语气里可以有一点不确定和想念，别质问。"
  };
  /* 状态 → 一句「这段时间是正常的」的说明（进提示词，让它理解沉默而不是催） */
  const MEAN = {
    idle:  "半小时以内很正常；一两个小时可以想一下；再久她会觉得你在等她。",
    game:  "一两个小时都正常（打游戏本来就不看消息）；超过两个半小时可以问一句，带点醋意没关系，别质问。",
    out:   "两三小时以内正常（买菜、逛街、办事都算）；再久可以问一句「到哪了」。",
    bath:  "一小时以内不打扰；超过一小时可以关心一下，但别吓自己。",
    eat:   "一小时以内不打扰；再久可以问「吃完了没」。",
    nap:   "两小时以内不吵她；超过两小时可以调侃她睡过头了。",
    sleep: "十小时以内**绝对不打扰**；超过十小时可以温柔地探一句「醒了没」。",
    other: "三小时以内不问；再久可以带点小抱怨地说你想她了。"
  };

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (s, r) => (r || document).querySelector(s);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const num = (x, d) => { const n = +x; return isFinite(n) ? n : d; };
  function lsGet(k) { try { return (localStorage.getItem(k) || "").trim(); } catch (_) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v == null ? "" : v); } catch (_) { } }
  function toast(m) {
    try { if (typeof showToast === "function") { showToast(m); return; } } catch (_) { }
    console.log("[wander] " + m);
  }
  async function memApi(path, opt) {
    try { if (typeof window.memApi === "function") return await window.memApi(path, opt); } catch (_) { }
    const r = await fetch((G ? G.base() : "") + path, Object.assign({ headers: G ? G.headers((opt && opt.body) ? { "Content-Type": "application/json" } : {}) : {} }, opt || {}));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error && d.error.message) || ("HTTP " + r.status));
    return d;
  }

  /* ══════════════ 状态与存储 ═════════════════════════════════════════ */
  const state = {
    on: lsGet(LS_ON) === "1",
    recs: [],            /* /app/fav 上的记录（本地镜像兜底） */
    cur: null,           /* {k, at, note} */
    policy: null,        /* {状态: {max_h, cap, ramp}} 覆盖默认表 */
    log: [],
    shadow: null,        /* /app/shadow/status 的 shadow 段 */
    idleMin: null,
    busy: false,
    lastPushAt: 0,
    nextAt: 0
  };
  function of(kind) { return state.recs.filter((x) => x.data && x.data.kind === kind); }
  function one(kind) { const a = of(kind); return a.length ? a[0] : null; }

  async function reload() {
    if (!G) return;
    try {
      const r = await G.listSynced(NS);
      state.recs = r.items || [];
    } catch (_) { state.recs = []; }
    const st = one("state"), po = one("policy"), lg = one("log");
    state.cur = st ? st.data : null;
    state.policy = po ? po.data : null;
    state.log = (lg && Array.isArray(lg.data.items)) ? lg.data.items : [];
    lsSet(LS_ON, state.on ? "1" : "");
  }
  async function save(kind, data) {
    const cur = one(kind);
    const d = Object.assign({ kind: kind }, data);
    return cur && G ? await G.kvReplace(cur.id, NS, d, { type: "text", tag: NS })
                    : (G ? await G.kvSave(NS, d, { type: "text", tag: NS }) : null);
  }
  async function pushLog(rec) {
    state.log = [rec].concat(state.log).slice(0, 20);
    try { await save("log", { items: state.log, at: new Date().toISOString() }); } catch (_) { }
  }

  /* 参数表：默认 STATES，可以用 policy 覆盖 */
  function paramOf(k) {
    const d = STATES.filter((x) => x.k === k)[0];
    const o = (state.policy && state.policy[k]) || {};
    return Object.assign({}, d, {
      max_h: clamp(num(o.max_h, d.max_h), 0.25, 48),
      cap: clamp(num(o.cap, d.cap), 0.05, 1),
      ramp: clamp(num(o.ramp, d.ramp), 0, 12)
    });
  }
  function stateDef(k) { return STATES.filter((x) => x.k === k)[0] || STATES[0]; }

  /* ══════════════ 浓度：MIRROW 的两阶段公式 ═══════════════════════════
      安心期（idle ≤ max_h）: sqrt(idle / max_h) × cap          —— 平缓
      预警期（idle >  max_h）: cap + (1−cap) × (idle−max_h)/ramp —— 陡升，封顶 1
      浓度到 1 就是「强制推送」。 */
  function concentration(idleH, st) {
    const m = Math.max(0.05, st.max_h), cap = clamp(st.cap, 0.05, 1), ramp = Math.max(0, st.ramp);
    const h = Math.max(0, idleH);
    if (h <= m) return Math.sqrt(h / m) * cap;
    if (ramp <= 0) return 1;
    return Math.min(1, cap + (1 - cap) * (h - m) / ramp);
  }
  /* 反过来问：浓度到 target 需要「离开多久」（小时）。返回 Infinity = 这个状态下永远到不了
     ⚠️ target ≥ 1（强制推送点）要**单独判**：cap 已经 = 1 的状态（空闲），
        安心期一结束浓度就到 1 了 —— 那一步不是 m+ramp，而正好是 m。
        （第一版漏了这条，空闲的强制推送点算成了 Infinity，探针拿 MIRROW 那张表一比就露了。） */
  function idleAt(st, target) {
    const m = Math.max(0.05, st.max_h), cap = clamp(st.cap, 0.05, 1), ramp = Math.max(0, st.ramp);
    if (target >= 1) {
      if (cap >= 1) return m;
      if (ramp <= 0) return Infinity;
      return m + ramp;
    }
    if (target <= cap) return m * Math.pow(target / cap, 2);
    if (ramp <= 0) return Infinity;
    return m + ramp * (target - cap) / (1 - cap);
  }
  function word(c) {
    if (c >= 0.95) return "满得快要溢出来";
    if (c >= 0.6) return "可以开口了";
    if (c >= 0.4) return "开始惦记了";
    if (c >= 0.2) return "还早";
    return "刚走";
  }

  /* ══════════════ 教学段落（写进 system_prompt，带标记可撤）════════════ */
  function composeStatic() {
    const L = [];
    L.push(MARK_B);
    L.push("【关于「她多久没说话」这件事】");
    L.push("她会给自己标一个状态。你按那个状态理解沉默 —— 这是一张约定表，不是命令：");
    STATES.forEach((x) => L.push("· " + x.e + " " + x.n + " —— " + (MEAN[x.k] || "")));
    L.push("");
    L.push("几条比表更要紧的：");
    L.push("· 如果她**自己**说了在做什么，那永远压过任何推测 —— 别拿「系统觉得」去反驳她。");
    L.push("· **安静是允许的。**不是每次沉默都要说话。你要开口，是因为你真有话，不是因为到点了。");
    L.push("· 真的开口时，别报时间、别提状态、别说「你多久没理我了」这种记账的话。");
    L.push(MARK_E);
    return L.join("\n");
  }
  /* 动态快照：只在**要推的那一下**临时写上，推完立刻换回静态版。
     ⚠️ 之所以要写「这是某一刻的快照」，是因为万一撤不干净，留在里面的一句
        过期的「她已经 2 小时没说话」会让它以后一直用错的时长判断。 */
  function composeDynamic(st, idleH) {
    const d = stateDef(st.k);
    const hh = Math.floor(idleH), mm = Math.round((idleH - hh) * 60);
    const inner = composeStatic().replace(MARK_B, "").replace(MARK_E, "").replace(/^\s+|\s+$/g, "");
    const L = [MARK_B];
    L.push("【现在这一刻】");
    L.push("（快照 · " + new Date().toLocaleString("zh-CN", { hour12: false }) + "）"
      + "她现在标的状态是「" + d.n + "」，已经 " + (hh ? hh + " 小时 " : "") + mm + " 分钟没说话。"
      + "这一行只是某一刻的样子，时间对不上就忽略它。");
    if (WARN[st.k]) L.push(WARN[st.k]);
    L.push("");
    L.push(inner);
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
      next = (i >= 0 && j > i) ? cur.slice(0, i) + composeStatic() + cur.slice(j + MARK_E.length)
                               : (cur.replace(/\s+$/, "") ? cur.replace(/\s+$/, "") + "\n\n" : "") + composeStatic();
    } else {
      if (i < 0 || j <= i) return false;
      next = (cur.slice(0, i) + cur.slice(j + MARK_E.length)).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
    }
    await writeSys(next);
    return true;
  }
  /* 只把标记块换成给定的那段（用于「推之前写快照 / 推完换回来」） */
  async function swapBlock(block) {
    const cur = await readSys();
    const i = cur.indexOf(MARK_B), j = cur.indexOf(MARK_E);
    if (i < 0 || j <= i) return false;
    await writeSys(cur.slice(0, i) + block + cur.slice(j + MARK_E.length));
    return true;
  }

  /* ══════════════ 读现状：状态 + 后端闸门 + 离开多久 ═════════════════ */
  async function getShadow() {
    const d = await memApi("/app/shadow/status");
    state.shadow = (d && d.shadow) || {};
    return state.shadow;
  }
  /* 离开多久 = 最后一条**用户**消息到现在。用真实历史，不猜。 */
  async function idleMinutes() {
    const d = await memApi("/app/history?limit=8");
    const items = d.items || d.messages || [];
    let t = 0;
    items.forEach((m) => {
      if (m && m.from === "human") { const v = Date.parse(m.ts || m.created_at || ""); if (isFinite(v) && v > t) t = v; }
    });
    if (!t) return null;                 /* 没有用户消息 → 不知道，别当成「刚走」 */
    return Math.max(0, (Date.now() - t) / 60000);
  }

  /* ══════════════ 渲染：把自己那一块插进 #csAtV ═════════════════════ */
  const HOST = "wdBlock";
  function ensureBlock() {
    const view = document.getElementById("csAtV");
    if (!view) return null;
    let box = document.getElementById(HOST);
    if (!box) {
      box = document.createElement("div");
      box.id = HOST;
      box.className = "wd-root";
      view.appendChild(box);
      box.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-wd-state]");
        if (chip) { chooseState(chip.dataset.wdState); return; }
        const act = e.target.closest("[data-wd-act]");
        if (act) { act_(act.dataset.wdAct); return; }
      });
      box.addEventListener("change", (e) => {
        const n = e.target.closest("[data-wd-num]");
        if (n) savePolicyFromDom();
      });
    }
    return box;
  }
  function paint() {
    const box = ensureBlock();
    if (!box) return;
    const st = state.cur && state.cur.k ? state.cur : null;
    const def = st ? paramOf(st.k) : null;
    const idle = state.idleMin;
    const c = (st && idle != null) ? concentration(idle / 60, def) : null;
    const sh = state.shadow || {};
    const canPush = !!sh.can_push;
    const blocked = sh.blocked_by || (!sh.enable ? "总开关关着" : "");
    const holdState = st && def.hold;

    /* 还差多久（分钟） */
    let eta = null, forced = null;
    if (st && idle != null && def) {
      const h = idle / 60;
      eta = Math.max(0, idleAt(def, THRESHOLD) * 60 - idle);
      forced = Math.max(0, idleAt(def, 1) * 60 - idle);
      if (!isFinite(eta)) eta = null;
      if (!isFinite(forced)) forced = null;
    }
    const L = [];
    L.push('<div class="cs-note" style="margin-top:12px"><b>漫想模式</b> —— '
      + '把「多久算久」交给你现在的状态决定，而不是一个固定的随机间隔。</div>');

    /* 浓度 */
    if (st && c != null) {
      const pct = Math.round(c * 100);
      L.push('<div class="wd-conc">'
        + '<div class="wd-conc-h"><span>' + esc(def.e + " " + def.n) + ' · 离开 ' + fmtMin(idle) + '</span>'
        + '<b>' + pct + '%</b></div>'
        + '<div class="wd-track' + (c >= THRESHOLD ? " hot" : "") + '"><i style="width:' + pct + '%"></i>'
        + '<u style="left:' + (THRESHOLD * 100) + '%"></u></div>'
        + '<div class="wd-scale"><span>' + esc(word(c)) + '</span>'
        + '<span>' + (eta != null ? (eta <= 0 ? "已经过线" : "再过 " + fmtMin(eta) + " 可以开口")
                                  : "这个状态下到不了线") + '</span></div>'
        + '</div>');
    } else {
      L.push('<div class="cs-note" style="margin-top:10px">还没标状态'
        + (idle != null ? ('　· 离开 ' + fmtMin(idle)) : '　· 还没有你说过的话，算不出离开多久')
        + '<br>标一个，它就知道「现在多久算久」了。</div>');
    }

    /* 状态 chips */
    L.push('<div class="wd-chips">'
      + STATES.map((x) => '<button type="button" class="wd-chip' + (st && st.k === x.k ? " on" : "") +
        '" data-wd-state="' + esc(x.k) + '"><span class="wd-em">' + x.e + '</span>' + esc(x.n) +
        (paramOf(x.k).hold ? "🔇" : "") + '</button>').join("")
      + '</div>');
    L.push('<div class="cs-note" style="margin-top:6px">'
      + '<b>你说的永远压过推测</b> —— 手动选的状态就是准的，没有「系统觉得你在睡觉」这回事。'
      + '带 🔇 的状态不打扰。</div>');

    /* 开关 + 现状 */
    L.push('<label class="fld switch-row" style="margin-top:12px"><span>时机交给漫想'
      + '<br><span style="font-size:11.5px;color:var(--text-faint);font-weight:400">'
      + '开着：页面打开时每分钟看一眼浓度，过线才去叫后端；关着：只有后端自己的随机间隔。</span></span>'
      + '<input type="checkbox" id="wdOn"' + (state.on ? " checked" : "") + '></label>');
    L.push('<div class="cs-note" style="margin-top:8px">'
      + '现在能不能推：<b>' + (canPush ? "可以" : ("先不说" + (blocked ? "（" + esc(zh(blocked)) + "）" : ""))) + '</b>'
      + (sh.today_count != null ? '　· 今天 ' + (sh.today_count || 0) + '/' + (sh.daily_max || "?") + ' 条' : '')
      + (holdState ? '<br><b>' + esc(def.n) + ' 是不打扰的状态</b> —— 就算浓度满了也不会去叫它。' : '')
      + (forced != null && forced <= 0 ? '<br>浓度已经满了（这个状态下的强制推送点），会强制推一次。' : '')
      + '</div>');

    /* 冲突提醒 */
    if (state.on && sh.loop) {
      L.push('<div class="wd-warn">后端的<b>内置调度还开着</b>（每 ' + (sh.cooldown_min || 120) + '–'
        + (sh.cooldown_max || 210) + ' 分钟随机一次）。两边都在推的话，它会显得比你想的频繁。'
        + '<br><button type="button" data-wd-act="loop-off">把后端的内置调度关掉（时机交给漫想）</button></div>');
    }
    /* 用最短的那个非打扰状态（吃饭/洗澡：1 小时就该考虑）当尺子：
       后端的冷静期下限比它还长，就等于把短状态全卡死了 */
    if (state.on && sh.cooldown_min != null && Number(sh.cooldown_min) > Math.round(idleAt(paramOf("eat"), THRESHOLD) * 60)) {
      L.push('<div class="wd-warn">后端的<b>冷静期下限</b>是 ' + sh.cooldown_min + ' 分钟 —— '
        + '比短状态（洗澡/吃饭 1 小时）该考虑的时机还长，等于把漫想卡住了。'
        + '<br><button type="button" data-wd-act="cooldown-relax">把冷静期放宽到 20–45 分钟</button></div>');
    }

    /* 参数表（折叠） */
    L.push('<details class="wd-params"><summary>每个状态等多久（可以改）</summary>'
      + '<table class="wd-tab"><thead><tr><th>状态</th><th>安心期 h</th><th>上限</th><th>预警爬升 h</th></tr></thead><tbody>'
      + STATES.map((x) => { const d = paramOf(x.k);
          return '<tr class="' + (d.hold ? "hold" : "") + '"><td>' + x.e + " " + esc(x.n) + '</td>'
            + '<td><input type="number" min="0.25" max="48" step="0.25" data-wd-num="' + esc(x.k) + '.max_h" value="' + d.max_h + '"></td>'
            + '<td><input type="number" min="0.05" max="1" step="0.05" data-wd-num="' + esc(x.k) + '.cap" value="' + d.cap + '"></td>'
            + '<td><input type="number" min="0" max="12" step="0.5" data-wd-num="' + esc(x.k) + '.ramp" value="' + d.ramp + '"></td></tr>';
        }).join("")
      + '</tbody></table>'
      + '<div class="cs-note" style="margin-top:6px">安心期 = 这段时间里浓度长得慢；上限 = 安心期最多长到多少；'
      + '预警爬升 = 超过安心期后多久爬到满。<b>上限到 1 的状态（空闲）安心期一满就已经在强制线上了。</b></div>'
      + '<div class="cs-acts"><button type="button" id="wdSavePolicy">存下参数</button>'
      + '<button type="button" id="wdResetPolicy">恢复默认</button></div></details>');

    /* 记录 */
    if (state.log.length) {
      L.push('<div class="wd-log"><div class="cs-note" style="margin-bottom:4px"><b>最近几次它想找你的经过</b></div>'
        + state.log.slice(0, 6).map((r) => '<div class="wd-li ' + esc(r.act || "") + '">'
            + '<em>' + esc(clock(r.at)) + '</em>'
            + '<span><b>' + esc(r.title || "") + '</b>' + (r.why ? "　" + esc(r.why) : "") + '</span></div>').join("")
        + '</div>');
    }
    box.innerHTML = L.join("");
    const on = $("#wdOn", box);
    if (on) on.addEventListener("change", () => setOn(on.checked));
    const sp = $("#wdSavePolicy", box);
    if (sp) sp.addEventListener("click", savePolicyFromDom);
    const rp = $("#wdResetPolicy", box);
    if (rp) rp.addEventListener("click", async () => { state.policy = null; await save("policy", { at: new Date().toISOString() }); render(); toast("参数恢复默认了"); });
  }
  function fmtMin(m) {
    const v = Math.round(m);
    if (v < 60) return v + " 分钟";
    const h = Math.floor(v / 60);
    return h + " 小时" + (v % 60 ? " " + (v % 60) + " 分" : "");
  }
  function clock(x) { const d = new Date(x || 0); return isNaN(d) ? "" : (("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2)); }
  function zh(k) {
    try { if (typeof sdSkippedZh === "function") return sdSkippedZh(k); } catch (_) { }
    return String(k || "");
  }
  function render() { try { paint(); } catch (e) { console.log("[wander] paint 出错", e); } }

  async function savePolicyFromDom() {
    const box = document.getElementById(HOST);
    if (!box) return;
    const po = {};
    box.querySelectorAll("[data-wd-num]").forEach((el) => {
      const [k, f] = String(el.dataset.wdNum).split(".");
      po[k] = po[k] || {};
      const v = +el.value;
      if (isFinite(v)) po[k][f] = v;
    });
    state.policy = po;
    try { await save("policy", Object.assign({ at: new Date().toISOString() }, po)); toast("参数存下了"); }
    catch (e) { toast("没存上：" + ((e && e.message) || e)); }
    render();
  }

  async function chooseState(k) {
    const now = new Date();
    const prev = state.cur ? { k: state.cur.k, at: state.cur.at } : null;
    /* 防抖：MIRROW 的「人不会 2 分钟内睡着两次」—— 刚切过的，这次当手滑，不覆盖时间 */
    if (prev && prev.k === k) return;
    state.cur = { k: k, at: now.toISOString() };
    render();
    try {
      await save("state", { kind: "state", k: k, at: now.toISOString() });
      const d = stateDef(k);
      toast(d.e + " 记下了 —— " + (d.hold ? "这个状态下不打扰" : MEAN[k] || ""));
      await pushLog({ at: now.toISOString(), act: "state", title: "状态 → " + d.n,
        why: prev ? ("上一个：" + stateDef(prev.k).n) : "" });
      render();
    } catch (e) { toast("没存上：" + ((e && e.message) || e)); }
  }

  /* ══════════════ 触发：到点了叫后端一次 ═════════════════════════════
     ★ 分三层报账（照 MIRROW 对日志的交代）：
         push  = 真的推了
         hold  = 被抑制（不打扰 / 后端闸门 / 间隔没到）—— **抑制不是发送成功，也不补发**
         error = 请求本身失败了 —— 失败不许伪装成「它选择不说」 */
  async function doPush(reason) {
    const st = state.cur ? paramOf(state.cur.k) : null;
    const def = state.cur ? stateDef(state.cur.k) : null;
    state.busy = true;
    let dynOk = false;
    try {
      /* ① 推之前先把「现在这一刻」的块写上去 —— MIRROW 的预警期语气注入就靠这一步 */
      if (st && def) {
        try { dynOk = await swapBlock(composeDynamic({ k: state.cur.k }, (state.idleMin || 0) / 60)); } catch (_) { }
      }
      const d = await memApi("/app/shadow/push", { method: "POST", body: "{}" });
      const r = (d || {}).result || {};
      state.lastPushAt = Date.now();
      if (r.pushed) {
        await pushLog({ at: new Date().toISOString(), act: "push",
          title: "说了：" + String(r.reply || "").slice(0, 40),
          why: (reason || "") });
        toast("它开口了 —— " + String(r.reply || "").slice(0, 40));
      } else {
        await pushLog({ at: new Date().toISOString(), act: "hold",
          title: "这次没说", why: "后端：" + zh(r.skipped || "未知") + (r.error ? ("（" + r.error + "）") : "") });
      }
    } catch (e) {
      await pushLog({ at: new Date().toISOString(), act: "error", title: "没推成", why: (e && e.message) || String(e) });
      toast("推的时候出错了：" + ((e && e.message) || e));
    } finally {
      state.busy = false;
      /* ② 无论成没成，都要把块换回静态版 —— 留着过期的快照比不写更坏 */
      if (dynOk) { try { await swapBlock(composeStatic()); } catch (_) { } }
      try { await getShadow(); } catch (_) { }
      render();
    }
  }

  function holdReason(st, def, c) {
    if (!state.on) return "漫想没开";
    if (!state.cur) return "还没标状态";
    if (def.hold) return "你在「" + def.n + "」，这个状态不打扰";
    if (c == null) return "算不出离开多久";
    if (c >= 1) return "";                                  /* 强制推送：没有抑制理由 */
    if (c < THRESHOLD) return "浓度还没过线（" + Math.round(c * 100) + "%）";
    const sh = state.shadow || {};
    if (sh.enable === false) return "后端总开关关着";
    if (!sh.can_push) return "后端：" + zh(sh.blocked_by || "在等");
    if (Date.now() - state.lastPushAt < MIN_GAP_MIN * 60000) {
      return "离上次主动不到 " + MIN_GAP_MIN + " 分钟";
    }
    return "";
  }

  async function tick() {
    if (!state.on || state.busy) return;
    try {
      /* 状态和离开多久都从真实数据算：今天没说过话就按「最后一条用户消息」算 */
      if (!state.cur) return;
      state.idleMin = await idleMinutes();
      if (state.idleMin == null) return;
      await getShadow();
      const def = paramOf(state.cur.k);
      const c = concentration(state.idleMin / 60, def);
      state.c = c;
      const why = holdReason(state.cur, def, c);
      if (why) {
        /* 抑制：只在「本来够格、却被别的东西挡住」时记一条。
           ★「因为你设的状态不打扰」也要记 —— 那正是最该让你看见的一条：
             否则你只会觉得"它怎么一直不说话"，而不知道是自己把它按住了一整天。
           去重按「同一小时内 + 同一个理由」，免得每分钟 tick 把日志刷满。 */
        if (c >= THRESHOLD) {
          const bucket = new Date().toISOString().slice(0, 13);   /* 到小时 */
          const last = state.log[0];
          const same = last && last.act === "hold" && last.why === why && String(last.at).slice(0, 13) === bucket;
          if (!same) await pushLog({ at: new Date().toISOString(), act: "hold", title: "够格了但没说", why: why });
        }
        render();
        return;
      }
      await doPush("浓度 " + Math.round(c * 100) + "% · 状态「" + def.n + "」");
    } catch (e) {
      console.log("[wander] tick", e);
      render();
    }
  }
  let timer = null;
  function startTimer() { if (!timer) timer = setInterval(tick, TICK_MS); }

  /* ══════════════ 开关与两个一键修复 ═════════════════════════════════ */
  async function setOn(v) {
    state.on = !!v;
    lsSet(LS_ON, v ? "1" : "");
    render();
    try {
      await applyInstr(state.on);
      toast(state.on ? "漫想开了 —— 它按你的状态决定多久算久" : "漫想关了 —— 回到后端自己的随机间隔");
    } catch (e) {
      state.on = !v; lsSet(LS_ON, state.on ? "1" : ""); render();
      toast("改不了：" + ((e && e.message) || e) + "（后端没连上？）");
    }
  }
  /* 改后端影子配置：**必须把整份配置原样带回去**（这个接口是整段替换的，
     只发两个字段会把别的设置清成默认）。字段白名单照宿主 sdBody() 的那份。 */
  const SHADOW_KEYS = ["enable", "loop", "cooldown_min", "cooldown_max", "daily_max", "history_take",
    "quiet_weekday", "quiet_weekend", "temperature", "max_tokens", "hard_limit", "model",
    "bark_key", "bark_title", "ntfy_topic", "ntfy_server", "at_times", "at_window"];
  async function patchShadow(patch) {
    const sh = state.shadow || {};
    const c = sh.config || {};
    const body = {};
    SHADOW_KEYS.forEach((k) => { if (c[k] !== undefined) body[k] = c[k]; });
    Object.assign(body, patch);
    if (body.enable === undefined) body.enable = sh.enable !== false;
    await memApi("/app/shadow/config", { method: "POST", body: JSON.stringify(body) });
    await getShadow();
    return body;
  }
  async function act_(what) {
    if (what === "loop-off") {
      try {
        await patchShadow({ loop: false });
        toast("后端的内置调度关掉了 —— 现在时机归漫想管");
        await pushLog({ at: new Date().toISOString(), act: "state", title: "关掉了后端调度", why: "避免两边都推" });
      } catch (e) { toast("关不掉：" + ((e && e.message) || e)); }
      render();
      return;
    }
    if (what === "cooldown-relax") {
      try {
        await patchShadow({ cooldown_min: 20, cooldown_max: 45 });
        toast("冷静期放宽到 20–45 分钟了 —— 后端不再卡住短状态");
        await pushLog({ at: new Date().toISOString(), act: "state", title: "放宽了后端冷静期", why: "20–45 分钟" });
      } catch (e) { toast("改不了：" + ((e && e.message) || e)); }
      render();
      return;
    }
  }

  /* ══════════════ 挂载 ═══════════════════════════════════════════════ */
  async function refresh() {
    try { if (!state.recs.length) await reload(); } catch (_) { }
    try { await getShadow(); } catch (_) { }
    try { state.idleMin = await idleMinutes(); } catch (_) { }
    render();
  }
  function hookCsAt() {
    /* 打开「主动消息」那一屏时顺手刷一遍我们的块（宿主自己的加载照旧跑） */
    try {
      if (typeof window.csAtLoad !== "function" || window.csAtLoad.__wander) return false;
      const orig = window.csAtLoad;
      const wrapped = function () {
        const r = orig.apply(this, arguments);
        try { Promise.resolve(r).then(() => refresh()).catch(() => { }); } catch (_) { }
        return r;
      };
      /* 复用别的包留下的标记（这个前端有多个包会包同一个宿主函数） */
      try { Object.keys(orig).forEach((k) => { if (k.indexOf("__") === 0) wrapped[k] = orig[k]; }); } catch (_) { }
      wrapped.__wander = true;
      window.csAtLoad = wrapped;
      return true;
    } catch (_) { return false; }
  }
  async function init() {
    hookCsAt();
    try { await reload(); } catch (_) { }
    ensureBlock();
    render();
    startTimer();
    /* 开关开着但后端人格里没有那段说明（换设备/被清过）→ 补上 */
    if (state.on) { try { await applyInstr(true); } catch (_) { } }
    /* 页面回到前台时补检一次（关掉的这段时间可能早就该说话了） */
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.on) setTimeout(tick, 1200); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.WanderPack = {
    open: () => { try { if (typeof csOpen === "function") csOpen("at"); } catch (_) { } },
    on: () => state.on,
    setOn: setOn,
    /* 只改本机开关、不写后端（探针测调度逻辑时用，免得每测一次就改一次人格） */
    _setOn: (v) => { state.on = !!v; lsSet(LS_ON, state.on ? "1" : ""); render(); return state.on; },
    state: () => ({ on: state.on, cur: state.cur, policy: state.policy, log: state.log, shadow: state.shadow, idleMin: state.idleMin }),
    choose: chooseState,
    refresh: refresh,
    tick: tick,
    _init: init,
    _conc: (idleH, k) => concentration(idleH, paramOf(k)),
    _idleAt: (k, t) => idleAt(paramOf(k), t),
    _states: () => STATES.map((x) => x.k),
    _static: composeStatic,
    _dyn: (k, idleH) => composeDynamic({ k: k }, idleH),
    _patch: patchShadow,
    _push: doPush,
    _setIdle: (m) => { state.idleMin = m; render(); },
    _block: () => document.getElementById(HOST)
  };
})();
