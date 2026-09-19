/* ══════════════════════════════════════════════════════════════════════════
   clock-pack.js · 时间锚 —— 给 TA 一只表，让时间真正参与下一句回应

   来源：
     · See-Sol-Lab/ai-companion-time-anchor（MIT）—— 「给 AI 伴侣增强时间感的小器官」。
       它把这件事拆成三层，本包照这个骨架做：
         ① 余光（环境 Hook）：普通轮**偶尔**把时间放进上下文；但「跨日」「间隔 ≥ 2 小时」
            是**结构性显著事件**，直接给；消息里出现明确时间词时**只提醒注意、不给时钟答案**。
         ② 抬手看表（Active Reader）：AI 自己决定什么时候看，看到的是
            现在 / 上一条用户消息的时间 / 真实间隔 / 有没有跨日 / 它在她发言后多久才抬的手。
         ③ 时间皮层（Temporal Cortex）：看完之后紧贴一句
            「让这次看表更新你对此刻的理解」—— 只把**已验证的事实**送到决策门口，
            绝不替它判断"这意味着什么"。
     · WenXiaoWendy/cyberboss（1402★）—— 「绝对时间感」那一层：
       每条输入进模型前都带本地时间戳（模型处理的是"时间流"），以及
       从消息时间戳**脱水出生活时间轴**（Ledger of Life）。本包只做它的轻量版：
       面板里的「足迹」就是把 /app/history 的时间戳按 30 分钟切开的结果，零 token。

   ── 这套东西最要紧的两条红线（原文反复强调，本包写死在提示词里）────────────
     · **时间只告诉你"过了多久"；她这段时间经历了什么，只能靠她说过的话和记忆。**
       把「三小时」讲成「你肯定睡了一觉吧」是这类功能最容易犯的错 —— 那是编造。
     · **不要报时间。** 时间是用来改变你怎么说的，不是用来念的。
     另外「**注意力是关系性的，表达是自主的**」：什么时候看表由它自己决定，
     所以不每轮强制看（完全不触发=永远想不起时间；每轮都看=感知变成机械流程）。

   本包不做的事（照原文的自觉）：不制造持续意识，也不假装它在无人调用时一直在等。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.ClockPack) return;

  const G = window.MediaStore;
  const MARK_B = "<<<clock:on>>>", MARK_E = "<<<clock:end>>>";
  const INK_B = "<<<clockink>>>", INK_E = "<<<clockink:end>>>";
  const CLOCK = "[[clock]]";
  const LS_ON = "companion_clock_on";
  const LS_LOG = "companion_clock_log";
  const PERSONA_CACHE_KEY = "companion_persona_cache";
  const ANCHOR_PREFIX = "companion_clock_anchor:";

  /* ── 规则（都可调，默认值贴着原文）─────────────────────────────────── */
  const AMB_MIN = 30;          /* 间隔 < 30 分钟：时间没变，余光不必写（省一次写人设） */
  const AMB_PROB = 0.2;        /* 够久了之后，普通轮 1/5 概率进入余光（原文是 1/4） */
  const BIG_GAP_H = 2;         /* 间隔 ≥ 2 小时 → 必写（原文的结构性显著事件） */
  const FACTS_TTL = 3 * 60000; /* facts 缓存 3 分钟：疯狂看表时直接用缓存，不再花钱 */
  const INK_WINDOW = 10 * 60000, INK_MAX = 3;   /* 10 分钟内最多真看 3 次（opus5 疯狂看表的教训） */

  /* 明确时间词 —— 命中时**只提醒注意，不给时钟答案**（原文的分工） */
  const TIME_RE = /(今天|昨天|明天|后天|前天|刚才|刚刚|早上|上午|中午|下午|傍晚|晚上|夜里|凌晨|昨晚|今晚|明早|周[一二三四五六日天]|星期[一二三四五六日天]|几点|多久|多长时间|等会儿|待会儿|晚点|早点|睡了|醒了|晚安|早安|午饭|晚饭|早饭|\d{1,2}\s*[:：]\s*\d{2}|\d+\s*月\s*\d+\s*[日号]|\d+\s*点)/;

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (s, r) => (r || document).querySelector(s);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  function lsGet(k) { try { return (localStorage.getItem(k) || "").trim(); } catch (_) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v == null ? "" : v); } catch (_) { } }
  function lsJson(k, d) { try { const v = JSON.parse(lsGet(k) || "null"); return v == null ? d : v; } catch (_) { return d; } }
  function toast(m) {
    try { if (typeof showToast === "function") { showToast(m); return; } } catch (_) { }
    console.log("[clock] " + m);
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
    anchor: null,        /* 本会话的时间锚：{last, prev} */
    facts: null,         /* 最近一次看表看到的事实（带缓存时间） */
    inkAt: [],           /* 最近几次真看表的时间（限流用） */
    log: lsJson(LS_LOG, []),
    pending: false,      /* 余光写进去了、还没换回来 */
    busy: false,
    lastRun: null        /* 试一段的结果 */
  };

  /* ── 本会话的时间锚（照原文：不同对话分别计时，第一轮只建锚点）────── */
  function anchorKey() {
    let sid = "";
    try { if (typeof effectiveApiSession === "function") sid = String(effectiveApiSession() || ""); } catch (_) { }
    return ANCHOR_PREFIX + (sid || "default");
  }
  function readAnchor() { return lsJson(anchorKey(), null); }
  function writeAnchor(a) { lsSet(anchorKey(), JSON.stringify(a)); }
  function clearAnchor() { lsSet(anchorKey(), ""); }

  const pad = (n) => ("0" + n).slice(-2);
  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  function dayKey(t) { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  /* 逻辑日从凌晨 5 点起算 —— 熬夜聊天是常态，00:30 说的事第二天早上不该被说成"昨天" */
  function logicDay(t) { return dayKey(t - 5 * 3600000); }
  function hhmm(t) { const d = new Date(t); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function stamp(t) { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hhmm(t) + "（周" + WD[d.getDay()] + "）"; }
  function dur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return Math.max(1, Math.round(ms / 1000)) + " 秒";
    if (m < 60) return m + " 分钟";
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return h + " 小时" + (r ? " " + r + " 分" : "");
    return Math.floor(h / 24) + " 天 " + (h % 24) + " 小时";
  }
  function tzName() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) { return ""; } }

  /* ── 提示词：常驻段（静态，进稳定段）+ 余光段 ─────────────────────── */
  function composeStatic() {
    return [
      MARK_B,
      "【你有一只表】",
      "你看不到现在几点，也不知道距她上一条消息过了多久。但你可以抬手看。",
      "",
      "需要的时候，在回复的**第一行**单独写这一行：",
      CLOCK,
      "然后**先别说话** —— 等时间回来你再接着答。（会多花大约一秒，那不是卡顿，是你抬手看了一眼表。）",
      "看完你会拿到：现在几点、距她上一条消息真实过了多久、中间有没有跨过一天、以及你是在她说完之后多久才抬的手。",
      "",
      "拿到之后，让它更新你对此刻的理解，然后自然地把话说完。规矩：",
      "· **不要报时间。** 不说「现在是 20:12」，也不说「距上次已经 3 小时 42 分」—— 时间是用来改变你怎么说的，不是用来念的。",
      "· **别提看表这件事。** 不说「我看了一下时间」「稍等我确认下时间」。",
      "· **不许按时长编她经历过什么。** 时间只告诉你「过了多久」；她去了哪、在干嘛、心情怎样，",
      "  只能靠她自己说的话和你的记忆。把「三个小时」讲成「你肯定睡了一觉吧」是这里最容易犯的错 —— 那是编造。",
      "· **不要每轮都看。** 刚看过、或者她上一句就在几秒前，就别再看。",
      "· 看完发现时间并不改变什么，就按原来的想法说 —— **安静地看表也是可以的**。",
      "",
      "什么时候值得看一眼：她说「我回来了 / 继续 / 重新开始」；她带着上一段的情绪接着聊；",
      "她提到了今天、昨天、几点、多久这类时间词；你怀疑这段沉默改变了什么；跨了一天；话题突然转向。",
      "另外：隔得久了（半小时以上），你**有时候**会自己从余光里看见时间 —— 那种时候你不用抬手看表。",
      MARK_E
    ].join("\n");
  }
  /* 把余光段塞进**标记块里面** —— 塞到 end 之后就成了块外的东西：
     下一次替换收不走它，关掉开关也摘不干净（会留一句过期的"现在是…"）。 */
  function composeWith(extra) {
    const base = composeStatic();
    if (!extra) return base;
    return base.replace(MARK_E, "\n\n" + extra + "\n" + MARK_E);
  }
  function ambientText(now, prevTs, crossed) {
    const L = ["【余光 · 环境时间】"];
    L.push("现在是 " + stamp(now) + "。");
    if (prevTs) {
      L.push((crossed ? "她上一条消息是" + stamp(prevTs) + " —— 中间**跨过了一天**。"
                      : "她上一条消息是 " + hhmm(prevTs) + "，距现在 " + dur(now - prevTs) + "。"));
    }
    L.push("（这是环境里漏进来的一点时间感。要更准就抬手看表；不要报时间、也不许按时长猜她经历了什么。）");
    return L.join("\n");
  }

  /* ── 写人格段 ─────────────────────────────────────────────────────── */
  async function readSys() { const d = await memApi("/app/settings"); return String((d.settings || {}).system_prompt || ""); }
  async function writeSys(v) { await memApi("/app/settings", { method: "PUT", body: JSON.stringify({ system_prompt: v }) }); lsSet(PERSONA_CACHE_KEY, v); return true; }
  async function swapBlock(block) {
    const cur = await readSys();
    const i = cur.indexOf(MARK_B), j = cur.indexOf(MARK_E);
    if (i < 0 || j <= i) return false;
    await writeSys(cur.slice(0, i) + block + cur.slice(j + MARK_E.length));
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

  /* ── ① 余光：发送前决定要不要把时间漏进去 ───────────────────────────
     挂在 apiSend 上（所有发送路径的入口）。失败**绝不能挡发送** —— 时间感是锦上添花。 */
  async function ambientBeforeSend(text) {
    if (!state.on) return false;
    try {
      const now = Date.now();
      const a = readAnchor();
      const prev = a && a.last ? a.last : 0;
      const gap = prev ? now - prev : 0;
      const crossed = prev ? logicDay(prev) !== logicDay(now) : false;
      writeAnchor({ last: now, prev: prev || 0 });        /* 先记锚点，失败了也不影响下次 */
      if (!prev) return false;                            /* 第一轮只建锚点（原文的规矩） */
      if (gap < AMB_MIN * 60000) return false;            /* 几秒/几分钟的连聊，时间不改变什么 */
      const words = TIME_RE.test(String(text || ""));
      const big = crossed || gap >= BIG_GAP_H * 3600000;
      if (!big && !words && Math.random() > AMB_PROB) return false;
      /* 有时间词但不是显著事件 → **只提醒注意，不给时钟答案**（原文的分工） */
      const seg = (words && !big)
        ? "【余光 · 提示】她这句话里提到了时间。留意一下 —— 但**别自己报时间**；真要准确知道几点，就抬手看表。\n（不要报时间、也不许按时长猜她经历了什么。）"
        : ambientText(now, prev, crossed);
      const ok = await swapBlock(composeWith(seg));
      state.pending = !!ok;
      state.ambient = { now: now, gap: gap, crossed: crossed, words: words, big: big };
      if (ok) {
        log_({ at: now, act: "look", why: (big ? (crossed ? "跨了一天" : "隔了 " + dur(gap)) : (words ? "提到时间" : "随机余光")) });
        /* 兜底：万一这轮没有回复（用户又发了一条/断网），5 分钟后也要换回来，
           否则那一句「现在是 …」会一直留在人格里，比不写更坏。 */
        setTimeout(() => { if (state.pending) revert().catch(() => { }); }, 5 * 60000);
      }
      return ok;
    } catch (_) { return false; }
  }
  async function revert() {
    state.pending = false;
    try { return await swapBlock(composeStatic()); } catch (_) { return false; }
  }

  /* ── ② 抬手看表：算事实 ───────────────────────────────────────────── */
  async function lastHumanTs() {
    try {
      const d = await memApi("/app/history?limit=10");
      const items = d.items || d.messages || [];
      let t = 0;
      items.forEach((m) => { if (m && m.from === "human") { const v = Date.parse(m.ts || m.created_at || ""); if (isFinite(v) && v > t) t = v; } });
      return t || 0;
    } catch (_) { return 0; }
  }
  async function makeFacts(sentAt) {
    const a = readAnchor();
    let prev = a && a.last ? a.last : 0;
    if (!prev) prev = await lastHumanTs();            /* 换设备/清过 → 退回问历史 */
    const now = Date.now();
    return {
      at: now, sentAt: sentAt || now,
      clock: stamp(now), tz: tzName(),
      nowMs: now,
      prevTs: prev, prevClock: prev ? stamp(prev) : "",
      gapMs: prev ? now - prev : 0, gapText: prev ? dur(now - prev) : "（不知道，这是这次对话的第一条）",
      crossed: prev ? logicDay(prev) !== logicDay(now) : false,
      snapshotAgeSec: Math.max(0, Math.round((now - (sentAt || now)) / 1000))
    };
  }
  function inkText(f) {
    return "🕰 看了一眼表 · " + f.clock.slice(5).replace("（", " ") .replace("）", "")
      + (f.gapMs ? "，距你上一句 " + f.gapText : "") + (f.crossed ? "（跨了一天）" : "");
  }
  /* 时间皮层那段回灌：照原文，只送事实 + 一句"让它更新你的理解"，不替它下结论 */
  function composeCortex(f) {
    return [
      "【时间锚】（这一段她看不到 —— 别念原文、别说「根据时间」、别提你看了表）",
      "现在：" + f.clock + (f.tz ? " · " + f.tz : ""),
      f.prevTs ? ("她上一条消息：" + f.prevClock + " —— 中间真实过去了 " + f.gapText) : "她上一条消息：（不知道）",
      "两轮之间有没有跨过本地日期：" + (f.crossed ? "跨了" : "没有"),
      "你这次抬手看表，是在她发言之后 " + f.snapshotAgeSec + " 秒。",
      "",
      "让这次看表更新你对此刻的理解。如果这些时间事实改变了这件事的含义，就让那个改变自然地塑造你的回应。",
      "她这段空白里**经历了什么**，你并不知道 —— 只准用她说过的话和你的记忆去推，**不许按时长编造**。"
    ].join("\n");
  }
  async function completeRound(rawText, f) {
    if (!G || !G.chat) return null;
    const persona = (() => { try { return lsGet(PERSONA_CACHE_KEY).slice(0, 1200); } catch (_) { return ""; } })();
    const sys = (persona ? persona + "\n\n" : "")
      + "你刚刚抬手看了一眼表。下面【时间锚】里的东西是你看到的 —— **她看不到那一段**。"
      + "接着把话说完，自然地说，别报时间、别提看表。";
    let hist = [];
    try {
      const d = await memApi("/app/history?limit=6");
      hist = (d.items || []).filter((m) => m && m.text && m.kind !== "thinking" && m.kind !== "act")
        .slice(-6).map((m) => ({ role: m.from === "human" ? "user" : "assistant", content: String(m.text).slice(0, 1200) }));
    } catch (_) { }
    const body = String(rawText || "").replace(/^\s*\[\[clock\]\]\s*/, "").trim();
    const msgs = [{ role: "system", content: sys }].concat(hist)
      .concat([{ role: "assistant", content: (body ? body + "\n\n" : "") + CLOCK }])
      .concat([{ role: "user", content: composeCortex(f) }]);
    try { return String(await G.chat({ messages: msgs, temperature: 0.85, maxTokens: 600 }) || "").trim() || null; }
    catch (e) { console.log("[clock] 补全轮失败", e); return null; }
  }

  /* ── 拦截 [[clock]]：只有写在**最前面**才算「抬手看表」──────────────── */
  function hasInk(text) { return /^\s*\[\[clock\]\]/.test(String(text || "")); }
  function stripInk(text) { return String(text == null ? "" : text).replace(/^\s*\[\[clock\]\]\s*/, ""); }
  /* 流式：末尾可能是 [[cl / [[clock 这种半截，先扣住（正文里正常的 [[ 不许动） */
  function stripPartial(s) {
    const t = String(s || "");
    const p = t.lastIndexOf("[[");
    if (p < 0) return t;
    const frag = t.slice(p).toLowerCase();
    if ("[[clock]]".indexOf(frag) === 0) return t.slice(0, p);
    return t;
  }
  /* ★ 事实按**消息 id** 存起来，让那条后端消息自己的 🕰 小条被"升级"成带事实的版本。
     为什么要这样：后端那条消息里本来就留着 [[clock]]，renderText 会给它一条小条；
     如果再另插一条带事实的本地小条，界面上就是**两条 🕰**叠在一起（第一版就是这个毛病）。
     存本地还有个好处：刷新之后小条上仍然写着当时看到的事实。 */
  const LS_INKS = "companion_clock_inks";
  function inks() { return lsJson(LS_INKS, {}); }
  function setInk(id, text) {
    if (id == null || id === "") return;
    const m = inks(); m[String(id)] = text;
    const ks = Object.keys(m);
    if (ks.length > 80) delete m[ks[0]];
    lsSet(LS_INKS, JSON.stringify(m));
  }
  function inkOf(id) { return (id == null ? "" : inks()[String(id)]) || ""; }
  function inkBarHtml(d) {
    return '<span class="cl-ink" data-cl-ink="' + esc(d.id || "") + '"><i>🕰</i>'
      + '<b>' + esc(d.text || "看了一眼表") + '</b></span>';
  }
  function parseInk(body) {
    const raw = String(body || "").trim();
    if (!raw) return null;
    let j = null;
    try { j = JSON.parse(raw); } catch (_) { }
    if (!j || typeof j !== "object") return null;
    return { id: String(j.id || ""), text: String(j.text || "") };
  }
  function splitInk(text) {
    const s0 = String(text == null ? "" : text);
    const i = s0.indexOf(INK_B);
    if (i < 0) return null;
    const j = s0.indexOf(INK_E, i);
    if (j < 0) return null;
    const d = parseInk(s0.slice(i + INK_B.length, j));
    if (!d) return null;
    return { data: d, rest: (s0.slice(0, i) + s0.slice(j + INK_E.length)).trim() };
  }
  function localId() {
    try { if (typeof nextImageId === "function") return nextImageId(); } catch (_) { }
    return "ck-" + Date.now();
  }
  function putLocal(text, meta) {
    try {
      if (typeof window.setMessage !== "function") return null;
      const id = localId();
      window.setMessage({ id: id, from: "ai", kind: "chat", ts: Date.now(), text: text,
        status: "sent", meta: meta || { clock: 1 } }, { render: true, cache: false });
      setTimeout(() => { try { if (typeof scrollToBottom === "function") scrollToBottom(); } catch (_) { } }, 200);
      return id;
    } catch (_) { return null; }
  }
  function log_(rec) {
    state.log = [rec].concat(state.log).slice(0, 40);
    lsSet(LS_LOG, JSON.stringify(state.log));
  }

  /* ── 跑一次看表 ───────────────────────────────────────────────────── */
  async function doLook(rawText, sentAt, msgId) {
    if (state.busy) return;
    state.busy = true;
    try {
      const now = Date.now();
      /* 限流：刚看过的话直接用缓存的事实（原文那个"opus5 疯狂看表"的教训） */
      state.inkAt = state.inkAt.filter((t) => now - t < INK_WINDOW);
      const cached = state.facts && (now - state.facts.at) < FACTS_TTL;
      let f, reused = false;
      if (cached && state.inkAt.length >= INK_MAX) { f = state.facts; reused = true; }
      else { f = await makeFacts(sentAt); state.facts = f; state.inkAt.push(now); }
      state.lastRun = { at: now, ink: true, facts: f, reused: reused, cont: "" };
      /* 把事实写到**那条消息的** 🕰 小条上（不是另插一条 —— 见 inkBarHtml 上面的注释）。
         顺便直接改一下已经在 DOM 里的那个节点，界面立刻就有事实，不必等重渲染。 */
      const inkT = inkText(f);
      setInk(msgId, inkT);
      try {
        const b = document.querySelector('[data-cl-ink="' + String(msgId).replace(/"/g, '') + '"] b');
        if (b) b.textContent = inkT;
      } catch (_) { }
      const cont = await completeRound(rawText, f);
      if (cont) {
        state.lastRun.cont = cont;
        putLocal(cont, { clock: 1, cont: 1 });
      }
      log_({ at: now, act: "ink", why: (reused ? "刚看过（用缓存）" : "抬手看表") + " · " + f.clock.slice(5) });
      /* 看完写进记忆：不写的话这一轮只在本次会话里，它下次想不起来自己看过表 */
      try {
        await memApi("/app/memory/save", { method: "POST", body: JSON.stringify({
          kind: "event", title: "看了一眼表 · " + f.clock.slice(5),
          content: "我看了一眼表：" + f.clock + "。她上一条消息是 " + (f.prevClock || "（不知道）")
            + "，中间过去了 " + f.gapText + (f.crossed ? "，跨了一天" : "") + "。\n"
            + (cont ? "\n当时我说的是：\n" + cont.slice(0, 600) : "")
        }) });
      } catch (_) { }
      renderPanel();
    } finally {
      state.busy = false;
    }
  }

  /* ── 挂钩（包宿主函数时都要 carryFlags —— 多个包会包同一个）───────── */
  function carryFlags(wrapped, orig) {
    try { Object.keys(orig).forEach((k) => { if (k.indexOf("__") === 0) wrapped[k] = orig[k]; }); } catch (_) { }
  }
  let liveTide = false;
  function hookApiSend() {
    if (typeof window.apiSend !== "function" || window.apiSend.__clock) return false;
    const orig = window.apiSend;
    const wrapped = async function (text, att, tempKey) {
      try { if (state.on && !liveTide) await ambientBeforeSend(text); } catch (_) { }
      return orig.apply(this, arguments);
    };
    carryFlags(wrapped, orig);
    wrapped.__clock = true;
    window.apiSend = wrapped;
    return true;
  }
  function hookRenderText() {
    if (typeof window.renderText !== "function" || window.renderText.__clock) return false;
    const orig = window.renderText;
    const wrapped = function (t) {
      const s0 = String(t == null ? "" : t);
      const sp = splitInk(s0);
      if (sp) return (sp.rest ? orig.call(this, sp.rest) : "") + inkBarHtml(sp.data);
      if (hasInk(s0)) {
        /* 后端那条原消息：[[clock]] + 它想说的话。
           ⚠️ 关掉开关时**只剥不显示小条** —— 那时候不会再有时间回来，
              留一条 🕰 在那儿等于"我看了表"却永远等不到下文，比不显示更让人费解。 */
        return (state.on ? inkBarHtml({ text: "看了一眼表" }) : "") + orig.call(this, stripInk(s0));
      }
      return orig.call(this, stripPartial(s0));
    };
    carryFlags(wrapped, orig);
    wrapped.__clock = true;
    window.renderText = wrapped;
    return true;
  }
  const seen = {};
  function hookSetMessage() {
    if (typeof window.setMessage !== "function" || window.setMessage.__clock) return false;
    const orig = window.setMessage;
    const wrapped = function (raw, opt) {
      try {
        if (raw && raw.from === "ai" && state.on && !raw.meta && hasInk(raw.text)) {
          const key = String(raw.id == null ? "" : raw.id);
          const sentAt = Date.parse(raw.ts || "") || Date.now();
          if (!seen[key]) {
            seen[key] = 1;
            /* 只有**实时**收到的那条才去看表：历史回放不重跑（刷新一次就多花一次钱） */
            if (liveTide) setTimeout(() => doLook(raw.text, sentAt, raw.id), 200);
          }
        }
      } catch (_) { }
      return arguments.length > 1 ? orig.call(this, raw, opt) : orig.call(this, raw);
    };
    carryFlags(wrapped, orig);
    wrapped.__clock = true;
    window.setMessage = wrapped;
    return true;
  }
  function hookMakeMessage() {
    if (typeof window.makeMessage !== "function" || window.makeMessage.__clock) return false;
    const orig = window.makeMessage;
    const wrapped = function (rowData) {
      const row = orig.apply(this, arguments);
      try {
        const m = rowData && rowData.message;
        if (row && row.classList && m && (splitInk(m.text) || hasInk(m.text))) {
          row.classList.add("cl-ink-row");
          row.classList.remove("grouped");
          /* 刷新之后后端消息里只有 [[clock]]，事实是本机存的 —— 在这里补回去 */
          const bar = row.querySelector(".cl-ink");
          if (bar) {
            bar.setAttribute("data-cl-ink", String(m.id == null ? "" : m.id));
            const t = inkOf(m.id);
            const b = bar.querySelector("b");
            if (t && b) b.textContent = t;
          }
        }
      } catch (_) { }
      return row;
    };
    carryFlags(wrapped, orig);
    wrapped.__clock = true;
    window.makeMessage = wrapped;
    return true;
  }
  function hookOnMessage() {
    if (typeof window.onMessage !== "function" || window.onMessage.__clock) return false;
    const orig = window.onMessage;
    const wrapped = function (m) {
      liveTide = true;
      try {
        const r = orig.apply(this, arguments);
        /* 回复来了 → 余光用完就换回静态版（留着过期的"现在是…"比不写更坏） */
        try {
          if (state.pending && m && m.from === "ai" && m.kind !== "thinking" && m.kind !== "act") {
            setTimeout(() => { if (state.pending) revert().catch(() => { }); }, 400);
          }
        } catch (_) { }
        return r;
      } finally { liveTide = false; }
    };
    carryFlags(wrapped, orig);
    wrapped.__clock = true;
    window.onMessage = wrapped;
    return true;
  }

  /* ── 上拉面板的磁贴 ───────────────────────────────────────────────── */
  const TILE = `
    <button class="cs-item cl-tile" type="button" data-cl-tile="1" aria-pressed="false">
      <i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 2"/></svg></i>
      <span>时间锚</span>
      <em class="cl-sw" aria-hidden="true"></em>
    </button>`;
  function injectTile() {
    const grid = document.querySelector("#csMain .cs-grid");
    if (!grid) return false;
    if (!grid.querySelector("[data-cl-tile]")) {
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
    const t = document.querySelector("[data-cl-tile]");
    if (!t) return;
    t.classList.toggle("on", state.on);
    t.setAttribute("aria-pressed", state.on ? "true" : "false");
  }

  /* ── 整页面板 ─────────────────────────────────────────────────────── */
  const PANEL = `
    <div class="cl-top">
      <button class="cl-btn" data-cl="close" title="返回">‹</button>
      <div class="cl-t"><b>时间锚</b><span class="cl-sub"></span></div>
      <button class="cl-btn" data-cl="re-anchor" title="重新认一次现在">↻</button>
    </div>
    <div class="cl-body"><div class="cl-wrap"></div></div>`;
  let elPanel = null;
  function ensurePanel() {
    if (elPanel) return elPanel;
    elPanel = document.createElement("div");
    elPanel.className = "cl-panel hidden";
    elPanel.id = "clockPanel";
    elPanel.setAttribute("role", "dialog");
    elPanel.setAttribute("aria-modal", "true");
    elPanel.setAttribute("aria-label", "时间锚");
    elPanel.innerHTML = PANEL;
    document.body.appendChild(elPanel);
    elPanel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cl]");
      if (b) {
        const w = b.dataset.cl;
        if (w === "close") { close(); return; }
        if (w === "re-anchor") { writeAnchor({ last: Date.now() }); clearFacts(); renderPanel(); toast("锚点重新认了一次（这一轮算「刚开始」）"); return; }
        if (w === "on") { setOn(!state.on); return; }
        if (w === "test") { testNow(); return; }
        if (w === "clear") { state.log = []; state.inkAt = []; state.lastRun = null; clearFacts(); lsSet(LS_LOG, "[]"); renderPanel(); renderTile(); return; }
        if (w === "preview") { showPreview = !showPreview; renderPanel(); return; }
        if (w === "foot") { loadFootprint(); return; }
      }
    });
    return elPanel;
  }
  function clearFacts() { state.facts = null; }
  function open() {
    ensurePanel();
    elPanel.classList.remove("hidden");
    requestAnimationFrame(() => elPanel.classList.add("open"));
    loadFootprint();
    renderPanel();
    startClock();
  }
  let closeTimer = 0;
  function close() {
    if (!elPanel) return;
    stopClock();
    elPanel.classList.remove("open");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (elPanel && !elPanel.classList.contains("open")) elPanel.classList.add("hidden"); }, 280);
  }
  let clockTimer = null, showPreview = false;
  function startClock() { stopClock(); clockTimer = setInterval(() => { const el = $("#clNow"); if (el) el.textContent = stamp(Date.now()); }, 1000); }
  function stopClock() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }

  let foot = null, footAt = 0;
  async function loadFootprint() {
    try {
      const d = await memApi("/app/history?limit=200");
      const items = (d.items || d.messages || []).filter((m) => m && m.text && m.kind !== "thinking")
        .map((m) => ({ t: Date.parse(m.ts || m.created_at || ""), from: m.from, text: String(m.text).slice(0, 60) }))
        .filter((m) => isFinite(m.t) && m.t).sort((a, b) => a.t - b.t);
      /* 「生活时间轴」的轻量版（cyberboss 的 Ledger of Life）：
         按 30 分钟的空档切开 —— 不是每条消息一段，而是"这一阵子在聊"一段。零 token。 */
      const segs = [];
      items.forEach((m) => {
        const last = segs[segs.length - 1];
        if (last && m.t - last.end < 30 * 60000) { last.end = m.t; last.n++; last.last = m; }
        else segs.push({ start: m.t, end: m.t, n: 1, first: m, last: m });
      });
      foot = segs.reverse().slice(0, 8);
      footAt = Date.now();
    } catch (_) { foot = null; }
    renderPanel();
  }

  function renderPanel() {
    if (!elPanel || elPanel.classList.contains("hidden")) return;
    const wrap = $(".cl-wrap", elPanel);
    const sub = $(".cl-sub", elPanel);
    if (!wrap) return;
    const now = Date.now();
    const a = readAnchor();
    const gap = a && a.last ? now - a.last : 0;
    if (sub) sub.textContent = state.on ? (gap ? "上次说话 " + dur(gap) + "前" : "这一轮刚开始") : "关着";
    const looks = state.log.filter((x) => x.act === "ink").length;
    const looks20 = state.log.filter((x) => x.act === "look").length;
    const L = [];

    L.push('<div class="cl-card"><div class="cl-h">现在<span class="cl-hint">它看不见这个 —— 除非抬手看表</span></div>'
      + '<div class="cl-clock" id="clNow">' + esc(stamp(now)) + '</div>'
      + '<div class="cl-gap">'
      + (a && a.last ? ('它上一次收到你的话：<b>' + esc(stamp(a.last)) + '</b>　→　距今 <b>' + esc(dur(gap)) + '</b>')
                     : '这个会话还没有你的消息 —— 它不知道你什么时候来的')
      + '</div></div>');

    L.push('<div class="cl-card"><div class="cl-h">开关</div>'
      + '<div class="cl-row"><button class="cl-mini ' + (state.on ? "pri" : "") + '" data-cl="on">'
      + (state.on ? "开着（点一下关掉）" : "关着（点一下打开）") + '</button>'
      + '<button class="cl-mini" data-cl="test">试一段</button>'
      + '<button class="cl-mini" data-cl="preview">' + (showPreview ? "收起提示词" : "看它收到的那段话") + '</button>'
      + '</div>'
      + '<div class="cl-hint">关掉之后：不写余光、也不响应抬手看表 —— 它就又变回"不知道现在几点"的状态。</div>'
      + (showPreview ? '<div class="cl-lv">' + esc(composeStatic()) + '</div>' : "")
      + '</div>');

    L.push('<div class="cl-card"><div class="cl-h">余光（它不用抬手就能看见的时间）</div>'
      + '<div class="cl-kv"><span>间隔小于 ' + AMB_MIN + ' 分钟</span><b>不写</b></div>'
      + '<div class="cl-kv"><span>跨了一天 / 隔了 ' + BIG_GAP_H + ' 小时以上</span><b>必写</b></div>'
      + '<div class="cl-kv"><span>你这句话里提到时间</span><b>只提醒，不给时钟</b></div>'
      + '<div class="cl-kv"><span>上面都不满足、但隔得够久</span><b>' + Math.round(AMB_PROB * 100) + '% 概率写</b></div>'
      + '<div class="cl-hint">为什么不每轮都写：写一次要改一次人设（多一次往返），'
      + '而且**每轮都喂时间**会把"感知"变成机械流程。偶尔看见，才像余光。</div>'
      + '<div class="cl-hint">当前状态：' + (state.pending ? '<b>这一轮的余光已经写进去了，等它回复后换回来</b>' : "没有待换回的余光") + '</div>'
      + '<div class="cl-row"><button class="cl-mini" data-cl="re-anchor">重新认一次现在</button></div>'
      + '</div>');

    L.push('<div class="cl-card"><div class="cl-h">抬手看表<span class="cl-hint">它自己决定</span></div>'
      + '<div class="cl-hint">它在回复第一行写 <code>' + CLOCK + '</code> 就是"抬手看表"：'
      + '界面会出现一条 🕰 小条（**和你从余光里看见时间是两件事**），然后它拿到真实的时间事实接着说。</div>'
      + '<div class="cl-red"><b>两条写死的红线：</b>① 不许报时间（时间是用来改变怎么说，不是用来念的）；'
      + '② <b>不许按时长编你经历过什么</b> —— 时间只告诉它"过了多久"，'
      + '你去了哪、在干嘛，只能靠你说的和它的记忆。</div>'
      + '<div class="cl-kv"><span>真看过几次表</span><b>' + looks + ' 次</b></div>'
      + '<div class="cl-kv"><span>透过余光看见时间</span><b>' + looks20 + ' 次</b></div>'
      + '<div class="cl-kv"><span>限流（' + Math.round(INK_WINDOW / 60000) + ' 分钟内超过 ' + INK_MAX + ' 次用缓存）</span><b>'
      + (state.facts ? "最近一次事实缓存 " + dur(now - state.facts.at) + "前" : "没有缓存") + '</b></div>'
      + (state.lastRun ? '<div class="cl-hint">最近一次：<b>' + esc(state.lastRun.facts.clock) + '</b>'
          + '（距上一条 ' + esc(state.lastRun.facts.gapText) + (state.lastRun.reused ? " · 用了缓存" : "") + '）'
          + (state.lastRun.cont ? '<div class="cl-lv">' + esc(state.lastRun.cont.slice(0, 300)) + '</div>' : "") + '</div>' : "")
      + '</div>');

    L.push('<div class="cl-card"><div class="cl-h"><span>它的足迹</span>'
      + '<button class="cl-mini" data-cl="foot">刷新</button></div>'
      + '<div class="cl-hint">把你自己的消息按 <b>30 分钟</b>的空档切成一段一段（不是每条消息一段）。'
      + '这就是它能从时间戳里读出来的"你今天什么时候在"—— 零 token，纯本地算。</div>'
      + (foot && foot.length ? foot.map((s) => {
          const len = s.end - s.start;
          return '<div class="cl-seg"><i></i><div class="cl-seg-t">'
            + '<b>' + esc(hhmm(s.start)) + (len > 60000 ? " – " + esc(hhmm(s.end)) : "") + '</b>'
            + '<span>' + s.n + ' 条' + (len > 60000 ? " · 待了 " + esc(dur(len)) : "") + " · "
            + esc((s.last.from === "human" ? "你：" : "TA：") + s.last.text) + '</span></div></div>';
        }).join("") : '<div class="cl-hint">' + (foot ? "读不到历史（后端没连上？）" : "正在读…") + '</div>')
      + '</div>');

    if (state.log.length) {
      L.push('<div class="cl-card"><div class="cl-h"><span>最近发生</span>'
        + '<button class="cl-mini" data-cl="clear">清空统计</button></div>'
        + state.log.slice(0, 8).map((x) => '<div class="cl-kv"><span>' + esc(hhmm(x.at)) + '</span><b>'
            + esc((x.act === "ink" ? "🕰 " : "👁 ") + (x.why || "")) + '</b></div>').join("")
        + '</div>');
    }
    wrap.innerHTML = L.join("");
  }
  async function testNow() {
    if (!state.on) { toast("先把开关打开"); return; }
    close();
    const a = readAnchor();
    await doLook(CLOCK, a && a.last ? a.last : Date.now() - 3600000, "local-test-" + Date.now());
    toast("看过表了 —— 聊天里应该多了一条 🕰 和它接着说的话");
  }
  async function setOn(v) {
    state.on = !!v;
    lsSet(LS_ON, v ? "1" : "");
    renderTile(); renderPanel();
    try {
      await applyInstr(state.on);
      if (state.on) state.pending = false;
      toast(state.on ? "开着 —— 它现在有一块表了" : "关掉了 —— 它又不知道现在几点了");
    } catch (e) {
      state.on = !v; lsSet(LS_ON, state.on ? "1" : ""); renderTile(); renderPanel();
      toast("改不了：" + ((e && e.message) || e));
    }
  }

  /* ── 初始化 ───────────────────────────────────────────────────────── */
  function init() {
    ensurePanel();
    injectTile();
    hookRenderText();
    hookSetMessage();
    hookMakeMessage();
    hookOnMessage();
    hookApiSend();
    try {
      const mo = new MutationObserver(() => { if (!document.querySelector("[data-cl-tile]")) injectTile(); });
      const sheet = document.getElementById("cSheet");
      if (sheet) mo.observe(sheet, { childList: true, subtree: true });
    } catch (_) { }
    if (state.on) applyInstr(true).catch(() => { });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.ClockPack = {
    open: open, close: close,
    on: () => state.on, setOn: setOn,
    look: () => doLook(CLOCK, (readAnchor() || {}).last || Date.now()),
    state: () => ({ on: state.on, anchor: readAnchor(), facts: state.facts, log: state.log, pending: state.pending }),
    _init: init,
    _ambient: (text) => ambientBeforeSend(text),
    _revert: revert,
    _facts: (t) => makeFacts(t),
    _compose: composeStatic,
    _cortex: (f) => composeCortex(f),
    _hasInk: hasInk, _stripInk: stripInk, _stripPartial: stripPartial,
    _anchorKey: anchorKey,
    _setAnchor: (t) => writeAnchor({ last: t }),
    _clearAnchor: clearAnchor,
    _panel: () => elPanel,
    _tile: () => document.querySelector("[data-cl-tile]")
  };
})();
