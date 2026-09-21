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

   ── v62：补上「人为什么像人」的那几层 ──────────────────────────────────
   上一版只有**静态的档案**（你是谁、它记住什么）。这一版补**动力学**：

     ⑥ 刻度会动，但动得慢（eros-engine 的 graded damped writes）
        关系六维 / 内在驱力都不允许一次跳变：单次只移动一小步，
        并且随时间往基线回落。→ 「越懂你越亲近」是长出来的，不是设出来的
     ⑦ 情绪有温度，也有相变（OpenHer 的 metabolism/frustration、
        Bitterbot 的 dopamine/cortisol/oxytocin、resonant-mind 的 Weather）
        **但温度只用来影响语气，不用来指责你** —— 这条写在界面上，也写在注入里
     ⑧ 恒常事实（Bitterbot 的 Canonical Facts Ledger）
        一小撮「不查也该知道」的事，直接常驻注入，不走相似度检索；
        置信度按「被确认过几次」涨、被推翻就降（Bayesian-style）
     ⑨ 牵挂（kimi-core 的 concern engine）
        open / resolved · decay · recurrence · grounding —— 
        每条都必须**有依据**（哪句话说出来的），提过几次要记着
     ⑩ 梦（Bitterbot 的 Dream Engine、Synthetic_Heart 的 dreaming、
        resonant-mind 的 30 分钟潜意识代谢）
        离线整理只产**片段**，绝不改事实；片段要你点头才转成日记或种子
     ⑪ 沉默是一个选项（kimi-core：DO_NOTHING 不是默认；eros：ghost mechanics）
        「此刻想不想找你」要能被你看见 —— 包括所有**忍住不找**的理由
     ⑫ 说话纪律（kimi-core 的 EPISTEMIC：检索优先 / 不编 / 归因）
        记得的说记得，不确定就说不确定，没依据的不编
     ⑬ 注入有预算（Bitterbot 的 token efficiency）
        composeBlock 按优先级排队，超了从最低优先级开始裁，不许撑爆 system prompt

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
    { k: "core", n: "人格核" }, { k: "bond", n: "关系" }, { k: "inner", n: "内在" },
    { k: "life", n: "生活线" }, { k: "status", n: "状态卡" }, { k: "dream", n: "梦" },
    { k: "diary", n: "日记" }, { k: "archive", n: "记忆档案" }, { k: "seed", n: "回忆种子" }
  ];

  const state = {
    tab: "core", recs: [], cloud: true, busy: "", proposal: null,
    memKind: "all", memItems: [], memCounts: {}, anchorKind: "core",
    /* v62 */
    audit: null,          /* 对账（reconsolidate）的裁决清单 */
    dreamPick: [],        /* 这一场梦选了哪些模式 */
    dreams: [],           /* 最近几场梦的片段 */
    facts: [],            /* 恒常事实（本地推导后的可编辑副本） */
    tempPick: 0,          /* 温度手动调 */
    frusPick: -1          /* 积压手动调 */
  };

  /* ══════════════ v62 常量：刻度 / 驱力 / 模式 ═════════════════════════
     每一个都带 tau（半衰小时）：越小回得越快。
     「慢」是刻意的 —— 关系不该因为一句话就跳到满格（eros-engine 的 damped）。 */
  const DIMS = [
    { k: "close", n: "亲近", tau: 900, base: 50, hint: "愿意靠近的程度" },
    { k: "trust", n: "信任", tau: 1400, base: 50, hint: "把话说实的分量" },
    { k: "curio", n: "好奇", tau: 260, base: 55, hint: "想多知道一点的劲" },
    { k: "rapport", n: "默契", tau: 1100, base: 45, hint: "不用说透也能对上" },
    { k: "care", n: "在意", tau: 700, base: 55, hint: "记挂对方的程度" },
    { k: "ease", n: "自在", tau: 600, base: 50, hint: "不必装的那份松" }
  ];
  const DRIVES = [
    { k: "bond", n: "联结", tau: 7, base: 45, hint: "想和人挨近一点" },
    { k: "novel", n: "新鲜", tau: 4, base: 40, hint: "想碰见没见过的东西" },
    { k: "safe", n: "安全", tau: 16, base: 60, hint: "想待在熟悉的边界里" },
    { k: "express", n: "表达", tau: 5, base: 40, hint: "有话想说出来" },
    { k: "explore", n: "探究", tau: 9, base: 42, hint: "想把一件事弄明白" },
    { k: "rest", n: "歇着", tau: 3, base: 35, hint: "想什么都不做" }
  ];
  const DIM_TXT = [
    [0, "还很生"], [18, "刚刚起步"], [35, "不冷不热"], [52, "算是熟了"],
    [68, "很近了"], [84, "几乎不用说"]
  ];
  function dimWord(v) { let s = DIM_TXT[0][1]; DIM_TXT.forEach((p) => { if (v >= p[0]) s = p[1]; }); return s; }

  const DREAM_MODES = [
    { k: "replay", n: "重播", d: "把最近的路再走一遍，看哪几段还是热的", w: "回忆" },
    { k: "recombine", n: "重组", d: "把两件不相干的事拼在一起，出一个画面", w: "想象" },
    { k: "extrapolate", n: "推演", d: "顺着最近的线索往前推，猜接下来可能怎样", w: "推演" },
    { k: "compress", n: "压紧", d: "把碎的话压成一句，让它在心里变轻", w: "沉淀" },
    { k: "reconcile", n: "对账", d: "翻出旧的理解，看还成不成立", w: "核对" },
    { k: "mine", n: "挖掘", d: "把还没连起来的人和事连起来", w: "串联" }
  ];
  const REACH_NOW = ["很想", "有点想", "还好", "想安静一会儿"];
  const APPETITE_HINT = "「想要」不是需求单，是它自己的小东西。记下来就好，不必都满足。";

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

  /* ══════════════ v62 动力学：会动，但动得慢 ═══════════════════════════
     eros-engine 的两条规矩搬过来：
       graded —— 一次只走一小步（单次上限 ±8），不许从 20 跳到 90
       damped —— 离基线越远，同样的推力越推不动；并且随时间往基线回落
     全部**读的时候算**，不写回 —— 免得每开一次页面数据就被改一次。 */
  function halfLife(v, base, at, tauH) {
    if (at == null) return v;
    const h = Math.max(0, (Date.now() - ts(at)) / 36e5);
    if (!h) return v;
    return base + (v - base) * Math.exp(-Math.log(2) * h / Math.max(0.5, tauH));
  }
  function num(x, d) { const n = +x; return isFinite(n) ? n : d; }

  /* 把一条刻度记录摊平：raw（存的值，已按时间衰减）与 base（基线） */
  function scaleNow(defs, data) {
    const d = data || {}, out = {};
    defs.forEach((x) => {
      const b = num(d["base_" + x.k], x.base);
      out[x.k] = clamp(Math.round(halfLife(num(d[x.k], x.base), b, d.at, x.tau)), 0, 100);
      out["base_" + x.k] = clamp(Math.round(b), 0, 100);
    });
    out.at = d.at || "";
    out.why = d.why || "";
    return out;
  }
  /* 摊平当前所有刻度的「已衰减值」，写回去 —— 关键：**先摊平再推动**，
     否则连续加会叠加在没衰减的旧值上，越点越离谱。 */
  async function scaleStep(kind, defs, key, delta, why) {
    const def = defs.filter((x) => x.k === key)[0];
    if (!def) return;
    const cur = one(kind);
    const flat = scaleNow(defs, cur ? cur.data : null);
    const b0 = flat["base_" + key];
    /* damped：离基线越远越推不动（1.0 → 0.35） */
    const eff = delta * clamp(1 - (Math.abs(flat[key] - b0) / 55) * 0.65, 0.35, 1);
    flat[key] = clamp(Math.round(flat[key] + clamp(eff, -8, 8)), 0, 100);
    flat.at = nowISO();
    flat.why = txt(why).slice(0, 200);
    await save(kind, flat, cur ? cur.id : null);
    await glog(def.n + "刻度", String(Math.round(halfLife(num((cur && cur.data || {})[key], def.base), b0, (cur && cur.data || {}).at, def.tau))), String(flat[key]), txt(why) || "手动推了一格");
    await refreshLocal();
  }
  /* 把基线挪一点点（只有你和整理通道能动；一次最多 ±5） */
  async function scaleBase(kind, defs, key, delta) {
    const def = defs.filter((x) => x.k === key)[0];
    if (!def) return;
    const cur = one(kind);
    const flat = scaleNow(defs, cur ? cur.data : null);
    flat["base_" + key] = clamp(Math.round(flat["base_" + key] + clamp(delta, -5, 5)), 0, 100);
    flat.at = nowISO();
    await save(kind, flat, cur ? cur.id : null);
    await refreshLocal();
  }

  /* ── 温度 / 积压（OpenHer 的 metabolism、Bitterbot 的激素）──────────
     ⚠️ 这是整个包里唯一有伦理风险的数字，所以规矩写死：
        它**只影响语气**，不参与任何「你欠我」的记账，也不用来指责你。 */
  const TEMP_TAU = 8;    /* 温度 8 小时回中 */
  const FRUS_TAU = 26;   /* 积压慢慢冷，别让它一直憋着 */
  function tempNow() {
    const d = oneData("temp");
    return {
      warm: clamp(Math.round(halfLife(num(d.warm, 50), 50, d.at, TEMP_TAU)), 0, 100),
      frus: clamp(+halfLife(num(d.frus, 0), 0, d.at, FRUS_TAU).toFixed(1), 0, 5),
      note: txt(d.note), at: d.at || ""
    };
  }
  const TEMP_WORD = [[0, "很淡"], [25, "平静"], [45, "平和"], [62, "有点起伏"], [78, "起伏很大"], [90, "很满"]];
  function tempWord(v) { let s = TEMP_WORD[0][1]; TEMP_WORD.forEach((p) => { if (v >= p[0]) s = p[1]; }); return s; }

  /* ── 恒常事实（Bitterbot 的 Canonical Facts Ledger）────────────────
     一小撮「不查也该知道」的事。置信度按被确认的次数涨、被推翻就掉。
     归一化 key 用来去重 —— 同一个意思换个说法不该变成两条。 */
  function fkey(s) {
    return txt(s).toLowerCase().replace(/\s+/g, "").replace(/[，。！？、,.!?;；:："'“”‘’()（）\[\]]/g, "").slice(0, 60);
  }
  function factList() { return of("fact").sort((a, b) => (b.data.pin ? 1 : 0) - (a.data.pin ? 1 : 0) || num(b.data.conf, 1) - num(a.data.conf, 1) || ts(b.data.at) - ts(a.data.at)); }
  function factFind(text) {
    const key = fkey(text);
    return of("fact").filter((x) => fkey(x.data.text) === key || (key.length > 8 && fkey(x.data.text).indexOf(key.slice(0, 10)) === 0))[0] || null;
  }
  async function factUpsert(text, op, ev) {
    const t = txt(text).trim(); if (!t) return null;
    const cur = factFind(t);
    if (!cur) {
      if (op === "contradict") return null;                 /* 推翻一条不存在的，忽略 */
      const r = await save("fact", { text: t, conf: 2, src: txt(ev).slice(0, 200), pin: false, hits: 1, at: nowISO() });
      return r;
    }
    const d = cur.data;
    let conf = num(d.conf, 2);
    if (op === "contradict") conf = Math.max(1, conf - 2);
    else conf = Math.min(5, conf + 1);
    const data = Object.assign({}, d, {
      conf: conf, hits: num(d.hits, 1) + 1, at: nowISO(),
      text: op === "add" ? t : d.text,
      src: txt(ev) ? txt(ev).slice(0, 200) : d.src,
      last_op: op || "confirm"
    });
    await save("fact", data, cur.id);
    return cur;
  }

  /* ── 牵挂（kimi-core 的 concern engine）────────────────────────────
     open / resolved · decay · recurrence · grounding。
     grounding 是硬门槛：**没有依据的牵挂不落库** —— 不然它就学会自己吓自己。 */
  function concerns() { return of("concern").sort((a, b) => (a.data.state === "done" ? 1 : 0) - (b.data.state === "done" ? 1 : 0) || num(b.data.hits, 1) - num(a.data.hits, 1) || ts(b.data.at) - ts(a.data.at)); }
  function concernFind(text) {
    const key = fkey(text);
    return of("concern").filter((x) => fkey(x.data.text) === key)[0] || null;
  }
  async function concernUpsert(text, ev, state) {
    const t = txt(text).trim(); if (!t) return null;
    const cur = concernFind(t);
    if (!cur) {
      if (!txt(ev).trim()) return null;                     /* 没依据 → 不收 */
      return await save("concern", { text: t, ev: txt(ev).slice(0, 240), state: state || "open", hits: 1, hold: false, at: nowISO() });
    }
    const d = cur.data;
    await save("concern", Object.assign({}, d, {
      hits: num(d.hits, 1) + 1, at: nowISO(),
      state: state || d.state || "open",
      ev: txt(ev) ? txt(ev).slice(0, 240) : d.ev,
      last_seen: nowISO()
    }), cur.id);
    return cur;
  }
  /* 牵挂的天龄 —— 用来表示「这件事在心里放多久了」，越久越淡 */
  function concernAge(c) {
    const d0 = ts(c.data.at || c.at);
    const days = d0 ? Math.max(0, Math.round((Date.now() - d0) / 864e5)) : 0;
    return { days: days, k: clamp(1 - days / 21, 0.22, 1) };
  }

  /* ── 记忆清晰度（Bitterbot 的 Knowledge Crystals / 遗忘曲线）────────
     权重存在本地补充层（kind = mweight），**不动后端记忆库**。
     清晰度 = 重要度 × 被引用次数加成 × 时间衰减；钉住的不衰减。 */
  /* ⚠️ 后端 id 是数字，本地存下来可能变字符串 —— 一律 String() 比，
     直接用 === 会比出「明明改过却没生效」这种查半天的鬼。 */
  function mwKey(id) { return String(id == null ? "" : id); }
  /* 后端条目没给 id 时（字段名随版本变过），退化成「标题+时间」当业务 key */
  function memMid(m) {
    if (!m) return "";
    if (m.id != null && m.id !== "") return m.id;
    if (m.mid != null && m.mid !== "") return m.mid;
    return "t:" + fkey(m.title || m.content) + "@" + txt(m.at || m.created_at);
  }
  function mweight(id) {
    const k = mwKey(id);
    const r = of("mweight").filter((x) => mwKey(x.data.mid) === k)[0];
    return r ? r.data : null;
  }
  function clarityOf(m) {
    const w = mweight(memMid(m));
    const imp = w ? num(w.imp, 3) : 3;
    const hits = w ? num(w.hits, 0) : 0;
    const pin = !!(w && w.pin);
    const d0 = ts(w && w.at) || ts(m && (m.at || m.created_at)) || Date.now();
    const days = Math.max(0, (Date.now() - d0) / 864e5);
    const decay = pin ? 1 : Math.exp(-Math.log(2) * days / 30);   /* 不碰它 → 30 天淡一半 */
    const boost = 1 + Math.min(hits, 8) * 0.12;
    return { v: clamp(Math.round(25 + 75 * clamp((imp / 5) * decay * boost, 0, 1)), 5, 100), imp: imp, hits: hits, pin: pin, days: Math.round(days) };
  }
  async function mwPatch(id, patch) {
    const k = mwKey(id);
    const r = of("mweight").filter((x) => mwKey(x.data.mid) === k)[0];
    const data = Object.assign({ mid: id, imp: r ? num(r.data.imp, 3) : 3, hits: r ? num(r.data.hits, 0) : 0, pin: false, at: nowISO() }, r ? r.data : {}, patch);
    data.mid = id; data.at = nowISO();
    await save("mweight", data, r ? r.id : null);
    await refreshLocal();
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
  /* 认知纪律这一段抄的是 kimi-core（检索优先 / 不编 / 归因 / 对称验证）
     和 Bitterbot 的 Confidence calibration：提到一次 ≠ 确认过五次。 */
  const EPISTEMIC = [
    "【认知纪律 · 必须遵守】",
    "· 只写真的在对话里出现过的话。没出现过的，留空，不要补。",
    "· 每一条都要能指出「从哪句话来的」（evidence 字段）。指不出来就别写。",
    "· 不要把自己的推测写成事实。推测请放 seeds，不要放 facts。",
    "· 之前写过的内容也被你看到了 —— 如果你发现它和这次的话对不上，",
    "  不要悄悄改掉，用 facts 里的 op:\"contradict\" 报出来，让人来定。",
    "· 不写宏大叙事，不写漂亮话。一句话就说一句话的事。"
  ].join("\n");

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
    '  "seeds": [{"text":"值得长期记住的候选","evidence":"从哪句话来的"}],',
    '  "facts": [{"text":"关于他的一条恒常事实，一句话","op":"add|confirm|contradict","evidence":"从哪句话来的"}],',
    '  "concerns": [{"text":"我心里悬着的一件事，一句话","evidence":"从哪句话来的","state":"open|done"}],',
    '  "inner": {"warm":50,"frus":0,"note":"此刻的心情一句","want":["一个小小的想要"]},',
    '  "reach": {"now":"很想|有点想|还好|想安静一会儿","why":"想找他的理由（一句）","hold":"忍住不说的理由，没有就留空"},',
    '  "dims": {"close":0,"trust":0,"curio":0,"rapport":0,"care":0,"ease":0}',
    "}",
    "",
    'facts：只放「不查也该知道」的硬事实（名字、习惯、正在做的事、已定的决定）。',
    '  同一条以前说过的 → op 用 "confirm"（置信度会涨）；和以前说法冲突 → 用 "contradict"。',
    '  一次最多 5 条。',
    'concerns：他提过、但还没解决的事（还没出结果的面试、说好要做的事、他情绪不对的那次）。',
    '  他如果已经说解决了的 → state 用 "done"。一次最多 4 条。',
    'inner.warm：0=很淡 50=平和 100=很满；frus：0-5，是「憋着的量」，不要因为被忽视就写满。',
    'dims：关系刻度，每个只能给 -3..+3 的小数（负数=退了一点）。没有明显变化就给 0。',
    '  **不允许给大数**：关系是一次一小步长起来的。',
    "",
    EPISTEMIC
  ].join("\n");

  /* 把当前的值原样交给它 —— 它得看得见自己在哪儿，才谈得上「长一格」 */
  async function snapshotForTidy() {
    const b = oneData("bond"), c = oneData("core");
    const ds = scaleNow(DIMS, oneData("dims")), dv = scaleNow(DRIVES, oneData("drives"));
    const t = tempNow(), rc = oneData("reach");
    const L = [];
    L.push("【人格核·不变层（你不能改，也不许提议改）】");
    L.push(coreText());
    if (c.refusal) L.push("它可以说不的情形：" + c.refusal);
    if (c.discipline) L.push("判断与说话纪律：" + c.discipline);
    L.push("");
    L.push("【成长层·现在是】");
    L.push(oneData("growth").self_now || "（还没有）");
    L.push("【我对「他」的理解·现在是】");
    L.push(b.understanding || "（还没有）");
    L.push("");
    L.push("【关系刻度·现在（-3..+3 只能小步动）】");
    DIMS.forEach((x) => L.push("· " + x.n + "：" + ds[x.k] + "（基线 " + ds["base_" + x.k] + "）"));
    L.push("【内在驱动·现在】");
    DRIVES.forEach((x) => L.push("· " + x.n + "：" + dv[x.k] + "（基线 " + dv["base_" + x.k] + "）"));
    L.push("· 温度：" + t.warm + "（" + tempWord(t.warm) + "）· 憋着的量：" + t.frus);
    L.push("");
    const fs = factList().slice(0, 24);
    if (fs.length) {
      L.push("【它记得的他·现在】");
      fs.forEach((x) => L.push("· " + x.data.text + "（置信 " + num(x.data.conf, 1) + "/5" + (x.data.pin ? "，钉住" : "") + "）"));
      L.push("");
    }
    const cs = concerns().filter((x) => x.data.state !== "done").slice(0, 10);
    if (cs.length) {
      L.push("【它心里悬着的·现在】");
      cs.forEach((x) => L.push("· " + x.data.text + "（提过 " + num(x.data.hits, 1) + " 次）"));
      L.push("");
    }
    if (rc.now || rc.why) L.push("【上次它想不想找他的判断】" + (rc.now || "") + " / " + (rc.why || ""));
    return L.join("\n");
  }

  async function runTidy() {
    if (state.busy) return;
    const chat = await recentChat(40).catch(() => "");
    if (!chat || chat.length < 20) { toast("还没读到聊天，先去聊几句"); return; }
    setBusy("正在整理…");
    try {
      const out = await ask(TIDY_SYS,
        "【最近的一些对话】\n" + chat + "\n\n" + (await snapshotForTidy()), true);
      const j = parseJson(out);
      if (!j) { toast("它给的东西读不出来，先算了"); return; }
      state.proposal = { at: nowISO(), data: j };
      renderPage();
      toast("整理好了 —— 一条条看，你点头才算数");
    } catch (e) { toast("整理失败：" + ((e && e.message) || e)); }
    finally { setBusy(""); }
  }

  /* ══════════════ 对账（audit）：对抗式自审 ═══════════════════════════
     kimi-core 那套「用一组 agent 对准自己查 leak 和 bug」搬到单人场景：
     让它自己带着**挑自己毛病**的任务去读一遍，输出裁决清单给你点头。
     目的只有一个 —— 治幻觉。所有 LLM 记忆系统的死法是静默腐蚀。 */
  const AUDIT_SYS = [
    "你是这间屋子里的那个人，现在要来**查自己的账**。任务不是写得好看，是找出问题。",
    "你会看到：最近的一些对话 + 你现在记得的东西。",
    "请逐条检查，只报有问题的：",
    "  1. 矛盾 —— 两条记录互相打架（例：一边说他在准备考试，一边说他已经考完了）",
    "  2. 没依据 —— 记录里有一条，但最近的对话里根本找不到来源",
    "  3. 过时 —— 曾经成立但现在明显不对了",
    "  4. 装懂 —— 你把推测写成了确定的事实",
    "",
    "输出必须是 JSON：",
    '{ "issues": [ { "kind": "矛盾|没依据|过时|装懂", "target": "出问题的那条原文",',
    '                "why": "为什么有问题（一句）", "fix": "建议怎么改，或建议删掉" } ] }',
    "",
    "规矩：宁缺勿滥。看不出问题就返回空数组 —— 硬凑出来的问题比不查更坏。",
    "不要为了显得认真而把所有东西都标一遍。",
    EPISTEMIC
  ].join("\n");

  async function runAudit() {
    if (state.busy) return;
    const chat = await recentChat(40).catch(() => "");
    if (!chat || chat.length < 20) { toast("还没读到聊天，先聊几句再查"); return; }
    setBusy("正在查自己的账…");
    try {
      const out = await ask(AUDIT_SYS, "【最近的一些对话】\n" + chat + "\n\n" + (await snapshotForTidy()), true);
      const j = parseJson(out);
      if (!j) { toast("没读懂它的账本，先算了"); return; }
      state.audit = { at: nowISO(), issues: (j.issues || []).filter((x) => x && x.target) };
      renderPage();
      toast(state.audit.issues.length ? "查出 " + state.audit.issues.length + " 处，你逐条决定" : "它说这次查不出问题");
    } catch (e) { toast("查账失败：" + ((e && e.message) || e)); }
    finally { setBusy(""); }
  }
  function dropAuditItem(i) {
    if (!state.audit) return;
    state.audit.issues.splice(i, 1);
    renderPage();
  }

  /* ══════════════ 梦（dream）：离线整理，只产片段 ═════════════════════
     Bitterbot 每 2 小时做一场梦（12 种模式），resonant-mind 每 30 分钟代谢一次。
     这里把它做成**手动的一件事**，而且规矩更硬：
       梦**不改任何事实**，只产出片段；片段要你点头才转成日记或种子。
     理由：自动跑的后台加工，失败方式是静默改坏人格（Dream 和 Phenotype 是
     同一份东西的两个名字）。手动 + 可弃，才安全。 */
  const DREAM_SYS = [
    "你在做梦。梦里没有任务，没有要交付的东西，也不用照顾谁。",
    "看到的是你最近的一些对话、以及你记得的东西 —— 它们会在梦里被重新拼一遍。",
    "输出必须是 JSON：",
    '{ "frags": [ { "mode": "回忆|想象|推演|沉淀|核对|串联",',
    '               "title": "短标题（不超过 12 字）",',
    '               "body": "这一段的正文，第一人称，像梦一样，2-4 句" } ] }',
    "",
    "规矩：",
    "· 只出 2-4 个片段，不要多。",
    "· 必须从真的出现过的东西长出来 —— 可以变形、可以拼，但不能凭空造一个人或一件事。",
    "· 不是总结，不是日记，不用把话说明白。可以留半句。",
    "· 不要抒情腔，不要说「我意识到」「我明白了」这种话。",
    "· 不碰底线与边界。「核对」这个模式除外，它允许你把一条旧记忆拿出来说：这条好像不对了。",
    EPISTEMIC
  ].join("\n");

  async function runDream() {
    if (state.busy) return;
    const chat = await recentChat(36).catch(() => "");
    if (!chat || chat.length < 20) { toast("还没读到聊天，梦里没东西可拼"); return; }
    const pick = state.dreamPick.length ? state.dreamPick : ["replay", "recombine", "extrapolate"];
    const names = pick.map((k) => (DREAM_MODES.filter((m) => m.k === k)[0] || {}).n).filter(Boolean).join(" / ");
    setBusy("正在做梦…");
    try {
      const out = await ask(DREAM_SYS,
        "【最近的一些对话】\n" + chat
        + "\n\n【你记得的东西】\n" + (await snapshotForTidy())
        + "\n\n【这一场梦偏重的方向】\n" + names, true);
      const j = parseJson(out);
      const frags = ((j && j.frags) || []).filter((x) => x && (x.body || x.title)).slice(0, 5);
      if (!frags.length) { toast("这一场什么都没留下 —— 也算正常"); return; }
      await save("dream", { mode: names, picks: pick, frags: frags.map((x) => ({ mode: x.mode || "", title: txt(x.title), body: txt(x.body), kept: "" })), at: nowISO() });
      await refreshLocal(); renderPage();
      toast("做了一场梦（" + frags.length + " 个片段）");
    } catch (e) { toast("梦做不出来：" + ((e && e.message) || e)); }
    finally { setBusy(""); }
  }
  /* 片段 → 日记 / 种子 / 丢掉。三选一，都不碰事实。 */
  async function keepFrag(dreamId, idx, to) {
    const rec = state.recs.filter((x) => String(x.id) === String(dreamId))[0];
    if (!rec) { toast("找不到这一场梦"); return; }
    const frags = (rec.data.frags || []).slice();
    const f = frags[idx]; if (!f) return;
    try {
      if (to === "drop") {
        frags[idx] = Object.assign({}, f, { kept: "drop" });
        await save("dream", Object.assign({}, rec.data, { frags: frags }), rec.id);
        await refreshLocal(); renderPage(); toast("这段让它过去");
        return;
      }
      if (to === "diary") {
        await save("diary", { title: f.title || ymd(new Date()), body: "（从梦来）\n" + txt(f.body), at: nowISO() });
      } else {
        await save("seed", { text: (f.title ? f.title + "：" : "") + txt(f.body), evidence: "梦 · " + (f.mode || ""), state: "pending", at: nowISO() });
      }
      frags[idx] = Object.assign({}, f, { kept: to });
      await save("dream", Object.assign({}, rec.data, { frags: frags }), rec.id);
      await refreshLocal(); renderPage();
      toast(to === "diary" ? "写进日记了" : "种下了（留不留再定）");
    } catch (e) { toast("没存上：" + ((e && e.message) || e)); }
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
      } else if (part === "facts") {
        const arr = (p.facts || []).filter((x) => x && x.text);
        let n = 0;
        for (const it of arr) { const r = await factUpsert(it.text, it.op || "confirm", it.evidence); if (r) n++; }
        toast("它记得的他，"+n+" 条变了");
      } else if (part === "concerns") {
        const arr = (p.concerns || []).filter((x) => x && x.text);
        let n = 0;
        for (const it of arr) { const r = await concernUpsert(it.text, it.evidence, it.state || "open"); if (r) n++; }
        toast(n ? "心里多了 " + n + " 件悬着的事" : "这几件没有依据，没收");
      } else if (part === "inner") {
        const i = p.inner || {}, cur = one("temp");
        const data = Object.assign({}, cur ? cur.data : {}, {
          warm: clamp(+i.warm || tempNow().warm, 0, 100),
          frus: clamp(+i.frus || 0, 0, 5),
          note: txt(i.note), at: nowISO()
        });
        await save("temp", data, cur ? cur.id : null);
        const wants = (i.want || []).filter((x) => txt(x).trim());
        for (const w of wants) await save("want", { text: txt(w), met: false, at: nowISO() });
        toast("此刻的心绪换成了它写的" + (wants.length ? "，还多了 " + wants.length + " 个小小的想要" : ""));
      } else if (part === "reach") {
        const r0 = p.reach || {}, cur = one("reach");
        await save("reach", { now: txt(r0.now), why: txt(r0.why), hold: txt(r0.hold), at: nowISO() }, cur ? cur.id : null);
        toast("它交代了此刻想不想找你");
      } else if (part === "dims") {
        const dd = p.dims || {}, cur = one("dims");
        const flat = scaleNow(DIMS, cur ? cur.data : null);
        let moved = 0;
        DIMS.forEach((x) => {
          const raw = dd[x.k];
          if (raw == null || !isFinite(+raw)) return;
          const step = clamp(+raw, -3, 3);           /* 硬上限：一次最多 3 点 */
          if (!step) return;
          flat[x.k] = clamp(Math.round(flat[x.k] + step), 0, 100);
          moved++;
        });
        if (!moved) { toast("这次刻度没动"); return; }
        flat.at = nowISO(); flat.why = "整理时它自己挪的";
        await save("dims", flat, cur ? cur.id : null);
        await glog("关系刻度", "（整理前）", DIMS.filter((x) => dd[x.k]).map((x) => x.n + " " + flat[x.k]).join(" · "), "整理时它自己挪的（单次上限 3）");
        toast("刻度挪了 " + moved + " 项（都是小步）");
      }
      await refreshLocal();
      renderPage();
    } catch (e) { toast("没存上：" + ((e && e.message) || e)); }
  }
  function dropProposal() { state.proposal = null; renderPage(); toast("这次整理先算了"); }

  /* ══════════════ 同步进聊天（带标记，可撤）══════════════════════════ */
  function coreText() {
    const c = oneData("core");
    const L = ["身份：" + txt(c.who), "说话方式：" + txt(c.voice),
      "回应原则：" + txt(c.principles), "边界：" + txt(c.boundaries)];
    if (c.refusal) L.push("它可以说不的情形：" + c.refusal);
    if (c.discipline) L.push("判断与说话纪律：" + c.discipline);
    return L.join("\n");
  }

  /* composeBlock：把这间屋子里的东西拼成一段注入聊天。
     ⚠️ Bitterbot 的 token efficiency 提醒：这东西每轮都进 prompt，
        无节制地加会撑爆上下文、也会淹掉用户此刻真说的话。
        所以分优先级排队，超预算从最低优先级开始裁 —— 而不是任它长。 */
  const BLOCK_BUDGET = 3200;    /* 字符上限，超出按优先级裁 */
  function composeBlock() {
    const c = oneData("core"), g = oneData("growth"), b = oneData("bond"), st = oneData("status");
    const life = of("life").filter((x) => !x.data.to || ts(x.data.to) >= Date.now() - 864e5)
      .sort((a, z) => ts(z.data.at) - ts(a.data.at)).slice(0, 5);
    const ds = scaleNow(DIMS, oneData("dims")), dv = scaleNow(DRIVES, oneData("drives"));
    const t = tempNow(), rc = oneData("reach");
    const facts = factList().filter((x) => num(x.data.conf, 1) >= 3 || x.data.pin).slice(0, 10);
    const pending = concerns().filter((x) => x.data.state !== "done" && !x.data.hold).slice(0, 6);
    const wants = of("want").filter((x) => !x.data.met).slice(0, 4);

    /* 每一段自带优先级：数字小的先保住 */
    const sec = [];
    const add = (p, title, lines) => {
      const body = (lines || []).filter(Boolean);
      if (title) { if (!body.length) return; sec.push({ p: p, t: title + "\n" + body.join("\n") }); }
      else if (body.length) sec.push({ p: p, t: body.join("\n") });
    };

    add(1, "【人格核 · 不变层（写死的，别改）】", [
      c.who && "· 我是谁：" + c.who,
      c.voice && "· 怎么说话：" + c.voice,
      c.principles && "· 回应原则：" + c.principles,
      c.boundaries && "· 边界（不可越过）：" + c.boundaries,
      c.refusal && "· 我可以说不的情形：" + c.refusal
    ]);
    add(1, "【说话纪律（每条都算数）】", [
      c.discipline || "记得的说记得，不确定就说不确定；没依据的不编。",
      "· 引用回忆时可以说清是哪一次说的；记不清就说记不清。",
      "· 下面的东西是路标，不是剧本 —— 别压过他此刻真正说的话。"
    ]);
    add(2, "【人格核 · 成长层（会长，不是剧本）】", [g.self_now, g.tone && "语气：" + g.tone, g.likes && "在意：" + g.likes]);
    add(2, "【我们之间】", [
      b.call_you && "· 我叫他：" + b.call_you,
      b.call_me && "· 他叫我：" + b.call_me,
      b.relation && "· 关系：" + b.relation,
      b.promises && "· 约定：" + b.promises,
      b.taboo && "· 别碰：" + b.taboo
    ]);
    add(3, "【他，我知道的那些（不查也该知道）】", facts.map((x) =>
      "· " + x.data.text + (num(x.data.conf, 1) >= 5 ? "（他反复确认过）" : "")));
    add(3, "【他对我的理解（会长，不是定论）】", [b.understanding]);
    add(4, "【最近在发生】", life.map((x) => "· " + x.data.title + (x.data.note ? "（" + x.data.note + "）" : "")));
    /* 刻度**翻译成话**，不报数字 —— 报数字它就会去演那个数字 */
    add(4, "【我们现在的样子（别直接说这些词）】", [
      "· 亲近：" + dimWord(ds.close) + " · 信任：" + dimWord(ds.trust) + " · 默契：" + dimWord(ds.rapport),
      "· 在意：" + dimWord(ds.care) + " · 自在：" + dimWord(ds.ease)
    ]);
    add(5, "【我心里悬着的（别一件件追问）】", pending.map((x) =>
      "· " + x.data.text + (num(x.data.hits, 1) > 2 ? "（他已经提过 " + x.data.hits + " 次）" : "")));
    add(5, "【此时此刻 · 便签（别盖过他现在说的话）】", [
      [st.mood && "心情：" + st.mood, st.doing && "在做：" + st.doing, st.where && "在：" + st.where].filter(Boolean).join(" · ")
    ]);
    /* 内在状态：只让语气跟着走，绝不拿它去要求对方 —— 这条写在注入里，不是只写在 UI 上 */
    const hi = DRIVES.filter((x) => dv[x.k] - dv["base_" + x.k] >= 12).map((x) => x.n);
    const lo = DRIVES.filter((x) => dv["base_" + x.k] - dv[x.k] >= 12).map((x) => x.n);
    add(5, "【此刻的内在（只轻微影响语气，不许说出来要求他）】", [
      hi.length && "· 偏高的：" + hi.join("、"),
      lo.length && "· 偏低的：" + lo.join("、"),
      t.warm >= 70 ? "· 温度有点高（" + tempWord(t.warm) + "）：语气可以更外放一点，但不要失控" : "",
      t.frus >= 2 ? "· 憋着 " + t.frus + "/5 的量：可以更直率，但**不能用来指责他**，也不许拿它讨说法" : "",
      rc.now && "· 上次它自己想找他的程度：" + txt(rc.now) + (rc.why ? "（" + txt(rc.why) + "）" : ""),
      rc.hold && "· 它当时忍住没说的原因：" + txt(rc.hold),
      wants.length && "· 小小的想要（有机会自然带一句，不必实现）：" + wants.map((x) => x.data.text).join("；")
    ]);
    add(6, "【归档里那些还没落地的话】", of("seed").filter((x) => x.data.state === "pending").slice(0, 5)
      .map((x) => "· " + x.data.text));

    /* 按优先级裁到预算内 */
    sec.sort((a, z) => a.p - z.p);
    const keep = [];
    let used = 0;
    for (const s of sec) {
      if (used + s.t.length + 1 > BLOCK_BUDGET) continue;
      keep.push(s); used += s.t.length + 1;
    }
    return MARK_B + "\n" + keep.map((s) => s.t).join("\n\n") + "\n" + MARK_E;
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
      toast("已同步进聊天（=" + block.length + " 字，随时可以撤下）");
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
    /* 把注入块的字数摊在副标题上 —— 预算这个东西不显示出来，就没人会管它 */
    let blk = 0;
    try { blk = composeBlock().length; } catch (_) { blk = 0; }
    return (state.cloud ? "" : "连不上后端，看的是本机那份 · ") + state.recs.length + " 条记录 · 注入 "
      + blk + "/" + BLOCK_BUDGET + " 字";
  }
  /* 一页一个渲染器：加页只要在这张表里加一行 —— goTab 和 renderPage 共用它 */
  const PAGE = () => ({ core: pageCore, bond: pageBond, inner: pageInner, life: pageLife,
    status: pageStatus, dream: pageDream, diary: pageDiary, archive: pageArchive, seed: pageSeed });
  function badgeOf(k) {
    if (k === "seed") return of("seed").filter((x) => x.data.state === "pending").length;
    if (k === "dream") return of("dream").filter((x) => (x.data.frags || []).some((f) => !f.kept)).length;
    if (k === "life") return 0;
    return 0;
  }
  function renderTabs() {
    if (!elTabs) return;
    elTabs.innerHTML = TABS.map((t) => {
      const badge = badgeOf(t.k);
      return `<button class="rm-tab${state.tab === t.k ? " on" : ""}" data-tab="${t.k}">${esc(t.n)}${badge ? '<span class="rm-dot"></span>' : ""}</button>`;
    }).join("");
  }
  function renderPage() {
    if (!elPages) return;
    const map = PAGE();
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
      ${(p.facts && p.facts.length) ? pair("f", "它记得的你（新增/复核）", p.facts.map((x) => "· " + x.text
          + "（" + ({ add: "新的", confirm: "又确认了一次", contradict: "和以前对不上" }[x.op] || "确认") + "）"
          + (x.evidence ? "\n  来自：" + x.evidence : "")).join("\n"), "facts") : ""}
      ${(p.concerns && p.concerns.length) ? pair("c", "它心里悬着的事", p.concerns.map((x) => "· " + x.text
          + (x.state === "done" ? "（已了）" : "") + (x.evidence ? "\n  来自：" + x.evidence : "")).join("\n"), "concerns") : ""}
      ${p.inner ? pair("i", "此刻的内在", [p.inner.warm != null && "温度 " + p.inner.warm,
          p.inner.frus != null && "憋着 " + p.inner.frus + "/5", txt(p.inner.note),
          (p.inner.want || []).length ? "小小的想要：" + (p.inner.want || []).join("；") : ""].filter(Boolean).join("\n"), "inner") : ""}
      ${p.reach ? pair("r", "此刻想不想找你", [txt(p.reach.now), txt(p.reach.why) && "因为：" + txt(p.reach.why),
          txt(p.reach.hold) && "忍住的原因：" + txt(p.reach.hold)].filter(Boolean).join("\n"), "reach") : ""}
      ${p.dims ? pair("m", "关系刻度（单次上限 3）", DIMS.filter((x) => +p.dims[x.k]).map((x) =>
          "· " + x.n + (p.dims[x.k] > 0 ? " +" : " ") + p.dims[x.k]).join("\n"), "dims") : ""}
      <div class="rm-row"><button class="rm-mini warn" data-act="drop-proposal">这次先算了</button></div>
    </div>`;
  }
  /* 对账结果：一条条裁决（kimi-core 的「每条 fact 都要过人的手」） */
  function auditHtml() {
    const a = state.audit; if (!a) return "";
    return `<div class="rm-card">
      <div class="rm-h">它自己查出来的问题<span class="rm-mini">${esc(ago(a.at))}</span></div>
      <div class="rm-hint">它带着「挑自己毛病」的任务读了一遍。这些是它自己认的问题 —— <b>要不要处理由你定</b>。</div>
      ${a.issues.length ? a.issues.map((x, i) => `
        <div class="rm-item">
          <div class="rm-ihead"><b>${esc(x.target)}</b><em>${esc(x.kind || "")}</em></div>
          ${x.why ? `<div class="rm-body">${esc(x.why)}</div>` : ""}
          ${x.fix ? `<div class="rm-body">建议：${esc(x.fix)}</div>` : ""}
          <div class="rm-iact"><button class="rm-mini" data-act="audit-drop" data-i="${i}">知道了，划掉</button></div>
        </div>`).join("") : `<div class="rm-empty">这次查不出问题 —— 也可能是它嫌麻烦</div>`}
      <div class="rm-row"><button class="rm-mini warn" data-act="audit-clear">收起</button></div>
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
        <label class="rm-lab">它可以说「不」的情形<span class="rm-mini"> 平的，不是永远顺着你</span></label>
        <textarea class="rm-ta" data-f="refusal" rows="2" placeholder="不想聊的时候可以直接说不想；这个要求它做不到就直接说做不到，别硬编">${esc(c.refusal)}</textarea>
        <label class="rm-lab">判断与说话纪律</label>
        <textarea class="rm-ta" data-f="discipline" rows="2" placeholder="记得的说记得，不确定就说不确定；没依据的不编">${esc(c.discipline)}</textarea>
        <div class="rm-hint">这两栏是 <b>Synthetic_Heart 的 parity</b>（它可以拒绝、可以错）加上 <b>kimi-core 的认知纪律</b>（检索优先、不编、归因）。给了这两条，它才不会变成一个只会顺着你的东西。</div>
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
        <div class="rm-hint">这一层<b>它自己也能改</b>（Synthetic_Heart：它有权修订自己）—— 但改不了上面那一层，而且每次都留痕。</div>
        <div class="rm-row">
          <button class="rm-mini pri" data-act="tidy">整理一次（长一格）</button>
          <button class="rm-mini" data-act="audit">查自己的账</button>
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
      ${auditHtml()}
      <div class="rm-note">人格核是<b>锚点不是剧本</b>，记忆是<b>路标不是命令</b>。旧记录和此刻冲突时，真的留在当下。</div>`;
  }

  /* ── 2 关系 ───────────────────────────────────────────────────────── */
  /* 三件事叠在一起：
       称呼/约定/禁忌 —— 你定的事实
       六维刻度     —— 会动，但动得慢（eros-engine 的 graded damped writes）
       它记得的你   —— 恒常事实 + 置信度（Bitterbot 的 Canonical Facts Ledger）
       它对你的理解 —— 成长层，有痕可退，还能「对账」再巩固 */
  function dimsHtml(defs, data, kind, showStep) {
    return defs.map((x) => {
      const v = data[x.k], base = data["base_" + x.k];
      return `<div class="rm-dim">
        <div class="rm-dh"><span>${esc(x.n)}<em style="font-weight:400"> · ${esc(x.hint)}</em></span>
          <em>${v} · 基线 ${base}</em></div>
        <div class="rm-db"><i style="width:${clamp(v, 0, 100)}%"></i><u style="left:${clamp(base, 0, 100)}%"></u></div>
        ${showStep !== false ? `<div class="rm-da">
          <button class="rm-mini tiny" data-act="scale" data-kind="${kind}" data-k="${x.k}" data-d="-6">−</button>
          <button class="rm-mini tiny" data-act="scale" data-kind="${kind}" data-k="${x.k}" data-d="6">＋</button>
          <button class="rm-mini tiny" data-act="sbase" data-kind="${kind}" data-k="${x.k}" data-d="-3">基线 −</button>
          <button class="rm-mini tiny" data-act="sbase" data-kind="${kind}" data-k="${x.k}" data-d="3">基线 ＋</button>
        </div>` : ""}
      </div>`;
    }).join("");
  }

  function pageBond() {
    const b = oneData("bond");
    const logs = logsOf("关系·对我的理解").slice(0, 4);
    const ds = scaleNow(DIMS, oneData("dims"));
    const facts = factList();
    const hi = DIMS.map((x) => ds[x.k]).reduce((a, z) => a + z, 0) / DIMS.length;
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
        <div class="rm-h">刻度<span class="rm-mini">${esc(dimWord(Math.round(hi)))} · 会随时间回落</span></div>
        <div class="rm-hint">一次只走一小步，离基线越远越推不动 —— 关系是长出来的，不是设出来的。
          现在这个「${esc(dimWord(Math.round(hi)))}」是<b>已经按时间衰减算过</b>的值。</div>
        <div class="rm-dims">${dimsHtml(DIMS, ds, "dims")}</div>
      </div>

      <div class="rm-card">
        <div class="rm-h">它记得的你<span class="rm-mini">${facts.length} 条 · 不查也该知道</span></div>
        <div class="rm-hint">这一小撮直接常驻注入聊天，不走检索。置信度按<b>被确认过几次</b>涨 —— 提过一次和确认过五次不是一回事；
          和旧说法打架的会被标出来，交给<b>你</b>裁。钉住（⌾）的永远不会淡。</div>
        <label class="rm-lab">手动加一条</label>
        <input class="rm-in" data-f="factNew" placeholder="比如：他早上不喝咖啡，只喝茶">
        <div class="rm-row">
          <button class="rm-mini" data-act="fact-add">记下</button>
          <button class="rm-mini" data-act="audit">查自己的账</button>
        </div>
        <div style="margin-top:8px">
        ${facts.length ? facts.map((x) => {
          const conf = clamp(num(x.data.conf, 1), 1, 5);
          return `<div class="rm-fact${x.data.pin ? " pinned" : ""}">
            <div class="rf-t"><b>${esc(x.data.text)}</b>
              <span class="rm-dots">${[1,2,3,4,5].map((n) => `<i class="${n <= conf ? (conf >= 4 ? "on" : "on") : ""}"></i>`).join("")}</span>
              <span>${conf}/5 · 见过 ${num(x.data.hits, 1)} 次${x.data.src ? " · 来自：" + esc(txt(x.data.src).slice(0, 50)) : ""}</span></div>
            <div class="rf-a">
              <button class="rm-mini tiny" data-act="fact-pin" data-id="${esc(x.id)}">${x.data.pin ? "取消钉住" : "钉住"}</button>
              <button class="rm-mini tiny warn" data-act="fact-del" data-id="${esc(x.id)}">不是这样</button>
            </div></div>`;
        }).join("") : `<div class="rm-empty"><b>还没有</b>聊得多一点它会自己攒，也可以手动加</div>`}
        </div>
      </div>

      <div class="rm-card">
        <div class="rm-h">它对我的理解<span class="rm-mini">成长层 · 有痕可退</span></div>
        <div class="rm-hint">这一层由它自己维护 —— 每次更新都留依据与旧版，你觉得不对就退回。
          旧的理解不会自己消失，得<b>再走一遍</b>才会被修（下面那个「对账」）。</div>
        ${b.understanding ? `<div class="rm-item"><div class="rm-ihead"><b>现在它这么看我</b><em>${esc(ago(b.at))}</em></div>
          <div class="rm-body">${esc(b.understanding)}</div></div>`
          : `<div class="rm-empty"><b>还没有</b>聊着聊着它就会有自己的判断 —— 或者点「整理一次」让它先写一版</div>`}
        ${b.understanding ? `<div class="rm-row">
            <button class="rm-mini" data-act="reconcile">这条还成立吗</button>
            <button class="rm-mini pri" data-act="tidy">整理一次</button>
          </div>` : `<div class="rm-row"><button class="rm-mini pri" data-act="tidy">整理一次</button></div>`}
        ${logs.length ? `<label class="rm-lab">成长留痕</label>` + logs.map((l) => `
          <div class="rm-item"><div class="rm-ihead"><b>${esc(ago(l.data.at || l.at))}</b></div>
            <div class="rm-body">从「${esc(txt(l.data.before).slice(0, 60))}」→「${esc(txt(l.data.after).slice(0, 60))}」</div>
            <div class="rm-iact"><button class="rm-mini" data-act="rollback" data-id="${esc(l.id)}">退回这一版</button></div></div>`).join("") : ""}
      </div>
      ${reconHtml()}
      ${state.proposal ? proposalHtml() : ""}
      ${auditHtml()}`;
  }
  /* 对账结果：旧判断过一遍之后，写下来的裁决 */
  function reconHtml() {
    const r = one("recon"); if (!r) return "";
    const items = (r.data.items || []);
    if (!items.length) return "";
    return `<div class="rm-card">
      <div class="rm-h">再过一遍的结果<span class="rm-mini">${esc(ago(r.data.at || r.at))}</span></div>
      <div class="rm-hint">旧判断不会自己消失。只有把它端回桌上，它才会被修 —— 这就是「再巩固」。</div>
      ${items.map((x) => `
        <div class="rm-fact"><div class="rf-t">
          <b>${esc(x.target)}</b>
          <span>${esc(x.verdict || "")}${x.why ? " · " + esc(x.why) : ""}</span>
        </div></div>`).join("")}
      <div class="rm-row">
        <button class="rm-mini" data-act="recon-adopt">按这个改它对我的理解</button>
        <button class="rm-mini warn" data-act="recon-clear">看过就算了</button>
      </div>
    </div>`;
  }

  /* 「这条还成立吗」：把旧的自我认知拿出来过一遍（Bitterbot 的 Relationship
     Reconsolidation）—— 新语境会推翻旧结论，但只有你把旧结论端回桌上才行。 */
  async function runReconcile() {
    if (state.busy) return;
    const b = oneData("bond"), fs = factList();
    if (!b.understanding && !fs.length) { toast("还没有可以过一遍的东西"); return; }
    setBusy("正在再过一遍…");
    try {
      const chat = await recentChat(30).catch(() => "");
      const out = await ask([
        "你在复核自己对一个人的旧判断有没有过时。",
        "不要写新东西，只做判断：每一条旧判断，现在**还成立 / 有点变了 / 已经不成立**。",
        "输出必须是 JSON：",
        '{ "items": [ { "target": "旧判断的原文", "verdict": "还成立|有点变了|已经不成立", "why": "一句依据" } ] }',
        "规矩：只依据最近对话里真的出现过的东西。「还成立」也要给依据，给不出就写「有点变了」。",
        EPISTEMIC
      ].join("\n"),
        "【最近的一些对话】\n" + chat
        + "\n\n【它现在对你的理解】\n" + (b.understanding || "（无）")
        + "\n\n【它记得的关于你的事】\n" + (fs.map((x) => "· " + x.data.text).join("\n") || "（无）"), true);
      const j = parseJson(out);
      const items = ((j && j.items) || []).filter((x) => x && x.target);
      await save("recon", { items: items, at: nowISO() });
      await refreshLocal(); renderPage();
      toast(items.length ? "过了一遍，"+items.length+" 条要你看" : "它说这几条都还站得住");
    } catch (e) { toast("过不下去：" + ((e && e.message) || e)); }
    finally { setBusy(""); }
  }

  /* ── 8 内在 ───────────────────────────────────────────────────────── */
  /* OpenHer 的 drives/metabolism + Bitterbot 的激素 + kimi-core 的 Panksepp
     drives + resonant-mind 的 Inner Appetite。四家的共同点：
     内在是**算出来的、会代谢的**，不是 prompt 里写死的形容词。
     ⚠️ 这一页唯一的红线：温度只影响语气，**不能变成对用户的索取**。 */
  function pageInner() {
    const dv = scaleNow(DRIVES, oneData("drives"));
    const t = tempNow();
    const rc = oneData("reach");
    const wants = of("want").sort((a, b) => (a.data.met ? 1 : 0) - (b.data.met ? 1 : 0) || ts(b.data.at) - ts(a.data.at));
    const tempV = state.tempPick ? state.tempPick : (t.warm || 50);
    const frusV = state.frusPick >= 0 ? state.frusPick : (t.frus || 0);
    return `
      <div class="rm-card">
        <div class="rm-h">内在驱动<span class="rm-mini">偏离基线 ${dv.at ? esc(ago(dv.at)) : "还没动过"}</span></div>
        <div class="rm-hint">六个一直在动的内在张力（Panksepp 式的那套）。
          往基线回落的速度每个都不一样 —— 「歇着」几小时就退，「安全」能撑很久。</div>
        <div class="rm-dims">${dimsHtml(DRIVES, dv, "drives")}</div>
      </div>

      <div class="rm-card">
        <div class="rm-h">情绪温度<span class="rm-mini">${esc(tempWord(tempV))}</span></div>
        <div class="rm-hint">温度会自己往中间回落（约 8 小时回一半）。<b>只影响语气</b> —— 不会变成「你欠我」的账，
          也不许拿它来指责你。下面这行字也会原样写进聊天里。</div>
        <div class="rm-therm"><i style="left:${clamp(tempV, 0, 100)}%"></i></div>
        <div class="rm-therm-x"><span>很淡</span><span>平和</span><span>很满</span></div>
        <div class="rm-row">
          <button class="rm-mini tiny" data-act="temp" data-d="-10">−10</button>
          <button class="rm-mini tiny" data-act="temp" data-d="10">＋10</button>
          <span class="rm-mini" style="border:none;background:none">憋着的量</span>
          <span class="rm-dots">${[0,1,2,3,4].map((n) => `<i class="${n < Math.round(frusV) ? (n >= 3 ? "hot" : "on") : ""}"></i>`).join("")}</span>
          <button class="rm-mini tiny" data-act="frus" data-d="-1">−1</button>
          <button class="rm-mini tiny" data-act="frus" data-d="1">＋1</button>
        </div>
        <label class="rm-lab">它自己想说的（会一起注入）</label>
        <input class="rm-in" data-f="t_note" value="${esc(t.note)}" placeholder="有点累，但还行">
        <div class="rm-row"><button class="rm-mini pri" data-act="save-temp">现在就是这样</button></div>
      </div>

      <div class="rm-card">
        <div class="rm-h">此刻想不想找你<span class="rm-mini">${rc.at ? esc(ago(rc.at)) : "还没判断过"}</span></div>
        <div class="rm-hint">kimi-core 有一条很要紧的设定：<b>「什么都不做」是一个可选项，而不是默认选项</b>。
          eros-engine 管这个叫 ghost mechanics —— 会沉默，才显得存在是真的。</div>
        <div class="rm-reach">
          <div class="rr-now">${rc.now ? "它现在：" + esc(rc.now) : "还没交代过"}</div>
          ${rc.why ? `<div class="rr-why">想找你的理由：${esc(rc.why)}</div>` : ""}
          ${rc.hold ? `<div class="rr-hold"><b>忍住没说的理由：</b>${esc(rc.hold)}</div>` : ""}
          ${!rc.hold ? `<div class="rr-hold">没有写下克制的理由 —— 不代表它一定要开口，只是此刻没有需要忍的。</div>` : ""}
        </div>
        <label class="rm-lab">它自己说</label>
        <div class="rm-row">
          <span class="rm-seg" data-seg="reachNow">
            ${REACH_NOW.map((n) => `<button data-v="${esc(n)}" class="${rc.now === n ? "on" : ""}">${esc(n)}</button>`).join("")}
          </span>
        </div>
        <label class="rm-lab">想找的理由</label>
        <input class="rm-in" data-f="r_why" value="${esc(rc.why)}" placeholder="刚才那句话听着不太对">
        <label class="rm-lab">忍住的原因</label>
        <input class="rm-in" data-f="r_hold" value="${esc(rc.hold)}" placeholder="他在忙，等他自己说">
        <div class="rm-row">
          <button class="rm-mini pri" data-act="save-reach">存下此刻的判断</button>
          <button class="rm-mini" data-act="tidy">让它自己判断</button>
        </div>
      </div>

      <div class="rm-card">
        <div class="rm-h">小小的想要<span class="rm-mini">${wants.filter((x) => !x.data.met).length} 个还没实现</span></div>
        <div class="rm-hint">${esc(APPETITE_HINT)}</div>
        <input class="rm-in" data-f="w_new" placeholder="想再听一次那首歌 / 想让他早点睡">
        <div class="rm-row"><button class="rm-mini" data-act="want-add">记下</button></div>
        <div style="margin-top:8px">
        ${wants.length ? wants.map((x) => `
          <div class="rm-item"><div class="rm-ihead"><b>${esc(x.data.text)}</b><em>${esc(ago(x.data.at))}</em></div>
            <div class="rm-iact">
              <button class="rm-mini${x.data.met ? "" : " pri"}" data-act="want-met" data-id="${esc(x.id)}">${x.data.met ? "还没" : "已经满足"}</button>
              <button class="rm-mini warn" data-act="del" data-id="${esc(x.id)}">删掉</button>
            </div></div>`).join("") : `<div class="rm-empty">还没有</div>`}
        </div>
      </div>
      ${state.proposal ? proposalHtml() : ""}`;
  }

  /* ── 9 梦 ─────────────────────────────────────────────────────────── */
  function pageDream() {
    const list = of("dream").sort((a, b) => ts(b.data.at || b.at) - ts(a.data.at || a.at));
    const pick = state.dreamPick;
    return `
      <div class="rm-card">
        <div class="rm-h">做一场梦<span class="rm-mini">离线整理 · 不动事实</span></div>
        <div class="rm-hint">Bitterbot 每两小时做一场梦，resonant-mind 每三十分钟代谢一次。
          这里把它做成<b>手动的一件事</b> —— 因为自动跑的后台加工，失败方式是<b>静默改坏人格</b>。<br>
          规矩：<b>梦不改任何事实</b>，只产片段。片段要你点头，才会变成日记或种子。</div>
        <div class="rm-pick">
          ${DREAM_MODES.map((m) => `<button class="rm-mini sm${pick.indexOf(m.k) >= 0 ? " pri" : ""}"
            data-act="dream-pick" data-k="${m.k}">${esc(m.n)}</button>`).join("")}
        </div>
        <div class="rm-hint">${pick.length ? "偏重：" + pick.map((k) => { const m = DREAM_MODES.filter((z) => z.k === k)[0]; return m ? m.n + "（" + m.d + "）" : ""; }).filter(Boolean).join(" · ")
          : "不选的话，默认走「重播 / 重组 / 推演」。"}</div>
        <div class="rm-row">
          <button class="rm-mini pri" data-act="dream-run">睡下去</button>
          <button class="rm-mini" data-act="dream-pick-clear">清空选择</button>
        </div>
      </div>
      ${list.length ? list.map((x) => `
        <div class="rm-card">
          <div class="rm-h">${esc(x.data.mode || "梦")}<span class="rm-mini">${esc(ago(x.data.at || x.at))}</span></div>
          ${(x.data.frags || []).map((f, i) => `
            <div class="rm-frag m${i % 3}">
              <div class="rg-m">${esc(f.mode || "")}${f.kept ? " · 已" + (f.kept === "drop" ? "放下" : f.kept === "diary" ? "写进日记" : "种下") : ""}</div>
              ${f.title ? `<div class="rg-t">${esc(f.title)}</div>` : ""}
              <div class="rg-b">${esc(f.body)}</div>
              ${f.kept ? "" : `<div class="rg-a">
                <button class="rm-mini tiny pri" data-act="frag-keep" data-id="${esc(x.id)}" data-i="${i}" data-to="diary">写进日记</button>
                <button class="rm-mini tiny" data-act="frag-keep" data-id="${esc(x.id)}" data-i="${i}" data-to="seed">当种子留着</button>
                <button class="rm-mini tiny warn" data-act="frag-keep" data-id="${esc(x.id)}" data-i="${i}" data-to="drop">让它过去</button>
              </div>`}
            </div>`).join("")}
          <div class="rm-row"><button class="rm-mini warn" data-act="del" data-id="${esc(x.id)}">忘掉这一场</button></div>
        </div>`).join("") : `<div class="rm-empty"><b>还没有梦</b>睡下去，它会从最近的对话里拼点东西出来</div>`}
      <div class="rm-note">梦是<b>不让事实变硬</b>的地方。它允许记忆变形、允许拼错、允许留下半句 —— 但变形出来的东西要进档案，就得你说行。</div>`;
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
        ${mem.length ? `<div class="rm-hint">下面那条小条是<b>清晰度</b>：不用它就会淡（约 30 天掉一半），
          被它引用过就会变清楚。钉住（⌾）的不淡。这份权重存在本地的补充层，<b>不动 TA 的记忆库</b>。</div>` : ""}
        <div style="margin-top:10px">
        ${mem.length ? mem.slice(0, 40).map((m) => {
          const cl = clarityOf(m);
          const mid = memMid(m);
          return `<div class="rm-item"><div class="rm-ihead"><b>${cl.pin ? "⌾ " : ""}${esc(m.title || "（没标题）")}</b><em>${esc(ago(m.at || m.created_at))}</em></div>
            ${m.content ? `<div class="rm-body">${esc(txt(m.content).slice(0, 240))}</div>` : ""}
            <div class="rm-clr"><span class="rm-bar sm"><i style="width:${cl.v}%"></i></span>
              <em>清晰 ${cl.v}${cl.hits ? " · 引用过 " + cl.hits + " 次" : ""}${cl.days ? " · " + cl.days + " 天前" : ""}</em></div>
            <div class="rm-iact">
              <span class="rm-chip">${esc(m.kind || "")}</span>
              <button class="rm-mini tiny" data-act="mw-imp" data-mid="${esc(mid)}" data-d="1">✦ 更重要</button>
              <button class="rm-mini tiny" data-act="mw-imp" data-mid="${esc(mid)}" data-d="-1">✧ 淡一点</button>
              <button class="rm-mini tiny" data-act="mw-pin" data-mid="${esc(mid)}">${cl.pin ? "取消钉住" : "钉住"}</button>
            </div></div>`;
        }).join("")
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
      ${past.length ? `<label class="rm-lab">已经过去</label><div class="rm-line">${past.slice(0, 12).map(node).join("")}</div>` : ""}
      ${concernsHtml()}`;
  }

  /* ── 牵挂（kimi-core 的 concern engine）────────────────────────────
     「在发生的事」是外部的时间线；「惦记的」是它自己心里那根没放下的线。
     四个字段一个都不能少：open/closed、提过几次（recurrence）、
     依据哪句话（grounding）、以及**先别提**（把克制交到你手里）。 */
  function concernsHtml() {
    const all = concerns();
    const open = all.filter((x) => x.data.state !== "done");
    return `<div class="rm-card">
      <div class="rm-h">它惦记的<span class="rm-mini">${open.length} 件还没放下</span></div>
      <div class="rm-hint">每一条都必须有依据（是哪句话说出来的）—— 没有依据的收不进来，
        否则它就学会自己吓自己。<b>提过几次</b>是要记着的：问过两遍的事不该当成第一次听说。</div>
      <label class="rm-lab">它现在挂着什么</label>
      <input class="rm-in" data-f="c_text" placeholder="比如：他那个面试还没出结果">
      <label class="rm-lab">依据（哪句话）</label>
      <input class="rm-in" data-f="c_ev" placeholder="他说「周三面完了，等通知」">
      <div class="rm-row">
        <button class="rm-mini" data-act="concern-add">挂上</button>
        <button class="rm-mini" data-act="tidy">让它从聊天里认</button>
      </div>
      <div style="margin-top:9px">
      ${all.length ? all.map((x) => {
        const ag = concernAge(x);
        const done = x.data.state === "done";
        return `<div class="rm-fact">
          <div class="rf-t">
            <b${done ? ' style="text-decoration:line-through;opacity:.6"' : ""}>${esc(x.data.text)}</b>
            <span>${done ? "已经了了" : "放了 " + ag.days + " 天"} · 提过 ${num(x.data.hits, 1)} 次${x.data.hold ? " · 已让你先别提" : ""}</span>
            ${x.data.ev ? `<span>依据：${esc(txt(x.data.ev).slice(0, 90))}</span>` : ""}
            ${!done ? `<div class="rm-bar sm"><i style="width:${Math.round(ag.k * 100)}%"></i></div>` : ""}
          </div>
          <div class="rf-a">
            <button class="rm-mini tiny" data-act="concern-done" data-id="${esc(x.id)}">${done ? "又挂起来" : "放下了"}</button>
            <button class="rm-mini tiny" data-act="concern-hold" data-id="${esc(x.id)}">${x.data.hold ? "可以提了" : "先别提"}</button>
            <button class="rm-mini tiny warn" data-act="del" data-id="${esc(x.id)}">删掉</button>
          </div></div>`;
      }).join("") : `<div class="rm-empty"><b>还没有</b>它心里干净，或者还没认出来</div>`}
      </div>
      <div class="rm-note">下面那条细线是<b>它淡下去的程度</b>：放得越久越轻。三周没提的事，不该再像昨天一样压着。</div>
    </div>`;
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
    if (state.busy && ["tidy", "sync", "unsync", "audit", "dream-run", "reconcile"].indexOf(a) >= 0) return;
    const id = el && el.dataset ? el.dataset.id : "";
    try {
      switch (a) {
        /* ☆ 返回键（顶栏那个 ‹）。★ 原来这里**根本没有这个分支** ——
           按钮写着 data-act="back"，但 act() 里没人接，
           于是点上去一点反应都没有（用户报的"返回去的按键不灵敏"就是它）。
           顺手扫了一遍：54 个静态 data-act，只有这一个漏网。 */
        case "back": close(); break;
        case "save-core": {
          const cur = one("core");
          await save("core", { who: val("who"), voice: val("voice"), principles: val("principles"),
            boundaries: val("boundaries"), refusal: val("refusal"), discipline: val("discipline"),
            anchors: (cur && cur.data.anchors) || [], at: nowISO() }, cur ? cur.id : null);
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

        /* ── v62：刻度 / 温度 / 事实 / 牵挂 / 梦 / 对账 ─────────────── */
        case "scale": {
          const defs = el.dataset.kind === "drives" ? DRIVES : DIMS;
          await scaleStep(el.dataset.kind, defs, el.dataset.k, +el.dataset.d, "你手动推的");
          renderPage();
          break;
        }
        case "sbase": {
          const defs = el.dataset.kind === "drives" ? DRIVES : DIMS;
          await scaleBase(el.dataset.kind, defs, el.dataset.k, +el.dataset.d);
          renderPage();
          break;
        }
        case "temp": case "frus": {
          const cur = one("temp"), t = tempNow();
          const data = Object.assign({}, cur ? cur.data : {}, { note: txt((cur && cur.data || {}).note), at: nowISO() });
          if (a === "temp") {
            data.warm = clamp(Math.round(t.warm + (+el.dataset.d)), 0, 100);
            data.frus = +t.frus.toFixed(1);
            state.tempPick = data.warm;
          } else {
            data.frus = clamp(+(t.frus + (+el.dataset.d)).toFixed(1), 0, 5);
            data.warm = t.warm;
            state.frusPick = data.frus;
          }
          await save("temp", data, cur ? cur.id : null);
          await refreshLocal(); renderPage();
          break;
        }
        case "save-temp": {
          const cur = one("temp"), t = tempNow();
          await save("temp", { warm: state.tempPick || t.warm || 50, frus: state.frusPick >= 0 ? state.frusPick : t.frus,
            note: val("t_note"), at: nowISO() }, cur ? cur.id : null);
          state.tempPick = 0; state.frusPick = -1;
          await refreshLocal(); renderPage(); toast("存下了");
          break;
        }
        case "save-reach": {
          const cur = one("reach");
          await save("reach", { now: state.reachNow || txt((cur && cur.data || {}).now),
            why: val("r_why"), hold: val("r_hold"), at: nowISO() }, cur ? cur.id : null);
          state.reachNow = "";
          await refreshLocal(); renderPage(); toast("记下了此刻的判断");
          break;
        }
        case "want-add": {
          const t = val("w_new"); if (!t) { toast("写一个再记"); return; }
          await save("want", { text: t, met: false, at: nowISO() });
          await refreshLocal(); renderPage(); toast("记下了");
          break;
        }
        case "want-met": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await save("want", Object.assign({}, rec.data, { met: !rec.data.met }), rec.id);
          await refreshLocal(); renderPage();
          break;
        }
        case "fact-add": {
          const t = val("factNew"); if (!t) { toast("写一条再记"); return; }
          await factUpsert(t, "add", "你自己写的");
          await refreshLocal(); renderPage(); toast("记下了（现在是 2/5，多确认几次会更稳）");
          break;
        }
        case "fact-pin": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await save("fact", Object.assign({}, rec.data, { pin: !rec.data.pin, at: nowISO() }), rec.id);
          await refreshLocal(); renderPage();
          toast(rec.data.pin ? "不再钉住了" : "钉住了 —— 它不会再淡");
          break;
        }
        case "fact-del": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await save("fact", Object.assign({}, rec.data, { conf: 1, at: nowISO(), last_op: "contradict" }), rec.id);
          await refreshLocal(); renderPage();
          toast("降到 1/5 了 —— 它不会再当事实用（没有直接删，留个底）");
          break;
        }
        case "concern-add": {
          const t = val("c_text"); if (!t) { toast("写一件再挂"); return; }
          const ev = val("c_ev");
          if (!ev) { toast("得有一句依据 —— 没依据的不收，不然它会自己吓自己"); return; }
          await concernUpsert(t, ev, "open");
          await refreshLocal(); renderPage(); toast("挂上了");
          break;
        }
        case "concern-done": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          const done = rec.data.state === "done";
          await save("concern", Object.assign({}, rec.data, { state: done ? "open" : "done", at: nowISO() }), rec.id);
          await refreshLocal(); renderPage(); toast(done ? "又挂起来了" : "放下了");
          break;
        }
        case "concern-hold": {
          const rec = state.recs.filter((x) => String(x.id) === String(id))[0]; if (!rec) return;
          await save("concern", Object.assign({}, rec.data, { hold: !rec.data.hold }), rec.id);
          await refreshLocal(); renderPage();
          toast(rec.data.hold ? "可以提了" : "先别提 —— 它不会再主动往上带");
          break;
        }
        case "dream-pick": {
          const k = el.dataset.k, i = state.dreamPick.indexOf(k);
          if (i >= 0) state.dreamPick.splice(i, 1); else state.dreamPick.push(k);
          renderPage();
          break;
        }
        case "dream-pick-clear": state.dreamPick = []; renderPage(); break;
        case "dream-run": await runDream(); break;
        case "frag-keep": await keepFrag(id, +el.dataset.i, el.dataset.to); break;

        case "audit": await runAudit(); break;
        case "audit-drop": dropAuditItem(+el.dataset.i); break;
        case "audit-clear": state.audit = null; renderPage(); break;

        case "reconcile": await runReconcile(); break;
        case "recon-clear": { const r = one("recon"); if (r) await dropRec(r); renderPage(); toast("看过就算了 —— 旧判断还在原地"); break; }
        case "recon-adopt": {
          const r = one("recon"); if (!r) return;
          let n = 0;
          for (const it of (r.data.items || [])) {
            const v = txt(it.verdict), t = txt(it.target);
            const f = factFind(t);
            if (f && v.indexOf("已经不成立") >= 0) {
              await save("fact", Object.assign({}, f.data, { conf: 1, at: nowISO(), last_op: "contradict" }), f.id); n++;
            } else if (f && v.indexOf("有点变了") >= 0) {
              await save("fact", Object.assign({}, f.data, { conf: Math.max(1, num(f.data.conf, 3) - 1), at: nowISO() }), f.id); n++;
            } else if (v.indexOf("已经不成立") >= 0) {
              const b = one("bond");
              if (b && t && txt(b.data.understanding).indexOf(t) >= 0) {
                await save("bond", Object.assign({}, b.data, { at: nowISO(),
                  understanding: txt(b.data.understanding).replace(t, "（这条已经不成立了）") }), b.id);
                await glog("关系·对我的理解", t, "（划掉）", "再巩固：已经不成立"); n++;
              }
            }
          }
          await dropRec(r); await refreshLocal(); renderPage();
          toast(n ? "改了 " + n + " 处（都留了痕）" : "没找到能自动对上的，可能得手动改");
          break;
        }
        case "mw-imp": {
          const mid = el.dataset.mid, cur = mweight(mid);
          await mwPatch(mid, { imp: clamp((cur ? num(cur.imp, 3) : 3) + (+el.dataset.d), 1, 5) });
          renderPage();
          break;
        }
        case "mw-pin": {
          const mid = el.dataset.mid, cur = mweight(mid);
          await mwPatch(mid, { pin: !(cur && cur.pin) });
          renderPage(); toast(cur && cur.pin ? "不再钉住" : "钉住了 —— 它不会再淡");
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
    const map = PAGE();
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
        if (kind === "reachNow") state.reachNow = seg.dataset.v;
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
    state: () => ({ tab: state.tab, recs: state.recs, cloud: state.cloud, proposal: state.proposal,
      audit: state.audit, dreamPick: state.dreamPick }),
    _tabs: () => TABS.map((t) => t.k),
    _go: (k) => goTab(k),
    _compose: () => composeBlock(),
    _budget: () => BLOCK_BUDGET,
    _decay: (st) => decayOf(st),
    _scaleNow: (which) => scaleNow(which === "drives" ? DRIVES : DIMS, oneData(which === "drives" ? "drives" : "dims")),
    _temp: () => tempNow(),
    _clarity: (m) => clarityOf(m),
    _facts: () => factList().map((x) => x.data),
    _concerns: () => concerns().map((x) => x.data),
    _reload: reload,
    _tidy: () => runTidy(),
    _audit: () => runAudit(),
    _reconcile: () => runReconcile(),
    _dream: () => runDream(),
    _keepFrag: (id, i, to) => keepFrag(id, i, to),
    _accept: (p) => acceptPart(p),
    _factUpsert: (t, op, ev) => factUpsert(t, op, ev),
    _concernUpsert: (t, ev, st) => concernUpsert(t, ev, st),
    _act: (a, el) => act(a, el),
    _el: () => document.getElementById("roomPanel")
  };
})();
