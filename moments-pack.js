/* ══════════════════════════════════════════════════════════════════════════
   moments-pack.js · 朋友圈
   机制照 BunnyHome 教程第六篇落地，存储走你后端现成的 /app/fav（tag 命名空间）。

   三件在教程里被反复强调、不做就等于没做的东西：
     ① **惰性回复**：我发完动态，TA 不是马上回，而是 reply_due_at（随机 10–20 分钟）
        之后才该回。不到时间，模型一个 token 都不花；到点了才生成。
     ② **图片只看一次**：第一次回复时顺便让它写一段 [image_desc] 存下来，
        之后所有评论链都不再传图，只用那段文字。
     ③ **并发锁**：连着打开两次页面 → 两个 tick 同时跑 → 同一条动态生成两条回复。
        教程「坑四」就是栽在这。这里用 ticking 单飞 + 处理中的 id 集合双保险。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const G = window.MediaStore;
  if (!G) { console.warn("[moments] media-store.js 没加载"); return; }

  const NS_M = "moment", NS_C = "moment_cmt";
  const K_CFG = "companion_moments_cfg";

  /* 默认值都能改；延迟区间照着教程来（初次 10–20 分钟，评论 3–8 分钟） */
  const CFG_DEFAULT = {
    meName: "我",
    firstMin: 10, firstMax: 20,     // 我发动态 → TA 多久才"看到"
    cmtMin: 3, cmtMax: 8,           // 我评论   → TA 多久才回
    perTick: 1,                     // 一次最多生成几条（省 token）
    autoTick: true,                 // 开着页面时自动到点生成
    provider: "", model: ""
  };

  let cfg = Object.assign({}, CFG_DEFAULT);
  let M = [];          // 动态
  let C = [];          // 评论（moment_id 关联）
  let elPanel, elSub, elFeed, elScroll, elCfg, elTa, elThumb, elSend, elFile;
  let pendingImg = null;              // 待发的那张图
  let ticking = false;                // ★ 单飞锁：防并发重复生成
  const working = new Set();          // ★ 正在生成的那几条，防重复
  let timer = 0, aiName = "TA", persona = "", personaLoaded = false;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* 强调还原：**这样** → 粗体。这套 prompt 里没有 Markdown，但模型可能自己带 ——
     纯文本渲染就会看到星号挡在字中间（牌桌那边就是这么被用户发现的）。 */
  function mdInline(x) {
    return esc(x)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  }
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ts = (x) => { const t = new Date(x || 0).getTime(); return isNaN(t) ? 0 : t; };

  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { } }
  function loadCfg() {
    try { cfg = Object.assign({}, CFG_DEFAULT, JSON.parse(lsGet(K_CFG, "{}") || "{}")); } catch (_) { cfg = Object.assign({}, CFG_DEFAULT); }
  }
  function saveCfg() { lsSet(K_CFG, JSON.stringify(cfg)); }

  function myName() { return (cfg.meName || "我").trim() || "我"; }
  function timeText(t) {
    const d = new Date(t), n = Date.now(), diff = n - d.getTime();
    if (!t || isNaN(d.getTime())) return "";
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 172800000) return "昨天 " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function dueText(t) {
    const left = ts(t) - Date.now();
    if (left <= 0) return "就快了";
    const m = Math.ceil(left / 60000);
    return m <= 1 ? "马上" : ("约 " + m + " 分钟后");
  }

  /* ── 记录形状 ─────────────────────────────────────────────────────────
     moment: { author:"me"|"ai", content, context_note, image_url, image_desc,
               reply_due_at, reply_status:"pending"|"done", liked(TA 赞了我),
               reply_content, replied_at, user_liked(我赞了 TA), created_at }
     comment: { moment_id, author:"me"|"ai", content, reply_due_at,
                reply_status:"none"|"pending"|"done", created_at }            */
  const newKey = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function recM(it) {
    const d = it.data || {};
    return {
      /* ⚠️ key 是这个模块的业务主键，**必须稳定**：/app/fav 没有 update，
         改一条 = 删旧 + 存新 → 行 id 每次都变。评论要是拿行 id 去挂，
         动态一旦被回复（保存一次）就全成孤儿了。 */
      key: d.key || newKey("m"),
      id: it.id, at: it.at || d.created_at || "", author: d.author === "ai" ? "ai" : "me",
      content: d.content || "", context_note: d.context_note || "",
      image_url: d.image_url || "", image_desc: d.image_desc || "",
      reply_due_at: d.reply_due_at || "", reply_status: d.reply_status || "done",
      liked: !!d.liked, reply_content: d.reply_content || "", replied_at: d.replied_at || "",
      user_liked: !!d.user_liked, created_at: d.created_at || it.at || ""
    };
  }
  function recC(it) {
    const d = it.data || {};
    return {
      key: d.key || newKey("c"),
      id: it.id, at: it.at || d.created_at || "", moment_key: d.moment_key || "", moment_id: d.moment_id,
      author: d.author === "ai" ? "ai" : "me", content: d.content || "",
      reply_due_at: d.reply_due_at || "", reply_status: d.reply_status || "none",
      created_at: d.created_at || it.at || ""
    };
  }
  const body = (x) => ({
    key: x.key, moment_key: x.moment_key, author: x.author, content: x.content,
    reply_due_at: x.reply_due_at, reply_status: x.reply_status, created_at: x.created_at
  });
  const bodyM = (x) => ({
    key: x.key, author: x.author, content: x.content, context_note: x.context_note, image_url: x.image_url,
    image_desc: x.image_desc, reply_due_at: x.reply_due_at, reply_status: x.reply_status,
    liked: x.liked, reply_content: x.reply_content, replied_at: x.replied_at,
    user_liked: x.user_liked, created_at: x.created_at
  });

  async function saveM(x) {
    const s = await G.kvReplace(x.id, NS_M, bodyM(x), { type: x.image_url ? "image" : "chat", url: x.image_url || "", name: "moment", mime: "application/json" });
    x.id = s.id; if (s.at) x.at = s.at;
    G.mirrorRemove(NS_M, x.id); G.mirrorUpsert(NS_M, x);
    const i = M.indexOf(x); if (i >= 0) M[i] = x;
    return x;
  }
  async function saveC(x) {
    const s = await G.kvReplace(x.id, NS_C, body(x), { type: "chat", name: "comment", mime: "application/json" });
    x.id = s.id; if (s.at) x.at = s.at;
    G.mirrorRemove(NS_C, x.id); G.mirrorUpsert(NS_C, x);
    const i = C.indexOf(x); if (i >= 0) C[i] = x;
    return x;
  }
  async function delM(x) {
    try { await G.kvDel(x.id); } catch (_) { }
    G.mirrorRemove(NS_M, x.id);
    M = M.filter((y) => y !== x);
    for (const c of C.filter((c) => c.moment_key === x.key)) {
      try { await G.kvDel(c.id); } catch (_) { }
      G.mirrorRemove(NS_C, c.id);
    }
    C = C.filter((c) => c.moment_key !== x.key);
  }

  /* ── 名字与人格 ───────────────────────────────────────────────────── */
  async function loadPersona() {
    aiName = (lsGet("companion_profile_remark", "") || "").trim() || "TA";   // 跟主页一致
    try {
      const r = await fetch(G.base() + "/app/settings", { headers: G.headers() });
      const d = await r.json();
      const sp = (d && d.settings && d.settings.system_prompt) || "";
      if (sp) {
        persona = sp;
        /* 人格里通常第一句就写着名字：「你叫阿澈，是西西的伴侣」——能从这儿取到真名就用它 */
        const m = /你叫([^\s，,。；;的]{1,6})/.exec(sp);
        if (m && m[1]) aiName = m[1];
      }
    } catch (_) { }
    personaLoaded = true;
  }
  function personaSys() {
    return (persona ? persona + "\n\n" : "")
      + "现在不是聊天，是在朋友圈：你路过看到了这条动态，可以点个赞、留一句评论，也可以只赞不评。\n"
      + "评论要短（一般 1-2 句，最多 40 字），用你自己的语气，像随手留的，不要总结、不要排比、不要说教。\n"
      + "没被点赞也没留言也可以 —— 别为了完成任务硬凑。";
  }

  /* ── 四层上下文（教程第六章），每层都截断，并行取 ─────────────────── */
  async function ctxChat() {
    try {
      const s = await (await fetch(G.base() + "/app/sessions", { headers: G.headers() })).json();
      const sid = s && s.active_session;
      if (!sid) return "";
      const h = await (await fetch(G.base() + "/app/history?session_id=" + sid + "&limit=400", { headers: G.headers() })).json();
      const msgs = (h && h.messages) || [];
      return msgs.slice(-8).map((m) => {
        const who = m.from === "human" ? myName() : aiName;
        return who + "：" + String(m.text || "").replace(/\s+/g, " ").slice(0, 160);
      }).filter((x) => x.replace(/^[^：]*：/, "").trim()).join("\n");
    } catch (_) { return ""; }
  }
  async function ctxMemory() {
    try {
      const out = [];
      const a = await (await fetch(G.base() + "/app/memory/list?kind=summary&limit=2", { headers: G.headers() })).json();
      (a.items || []).forEach((x) => out.push(String(x.content || "").slice(0, 400)));
      const b = await (await fetch(G.base() + "/app/memory/list?kind=nearfield_day&limit=1", { headers: G.headers() })).json();
      (b.items || []).forEach((x) => out.push(String(x.content || "").slice(0, 400)));
      return out.filter(Boolean).join("\n");
    } catch (_) { return ""; }
  }
  function ctxTimeline(cur) {
    return M.filter((x) => x !== cur).slice(0, 3)
      .map((x) => (x.author === "me" ? myName() : aiName) + "：" + String(x.content || "").replace(/\s+/g, " ").slice(0, 120))
      .join("\n");
  }
  async function buildCtx(cur) {
    const [chat, mem] = await Promise.all([ctxChat(), ctxMemory()]);
    return [
      chat ? "【最近聊的（最重要，别踩空）】\n" + chat : "",
      mem ? "【更早的背景】\n" + mem : "",
      ctxTimeline(cur) ? "【朋友圈最近】\n" + ctxTimeline(cur) : ""
    ].filter(Boolean).join("\n\n");
  }

  /* 带图的调用：模型看不了图就自动退回纯文字（不许硬说"我看到了"） */
  async function chatMaybeImage(sys, userText, imageUrl) {
    if (imageUrl) {
      try {
        const blob = await (await fetch(G.fileUrl(imageUrl))).blob();
        const du = await G.dataUrl(blob);
        return await G.chat({
          messages: [
            { role: "system", content: sys },
            { role: "user", content: [{ type: "text", text: userText }, { type: "image_url", image_url: { url: du } }] }
          ],
          temperature: 0.9, maxTokens: 700
        });
      } catch (e) {
        /* 看不了图 → 退回纯文字，并在提示里说清"这次没看到画面" */
        const r = await G.chat({
          messages: [
            { role: "system", content: sys + "\n（注意：这次你看不到画面，只能按文字回；不要假装看到了。）" },
            { role: "user", content: userText }
          ],
          temperature: 0.9, maxTokens: 600
        });
        return r + "\n[no_vision]";
      }
    }
    return await G.chat({
      messages: [{ role: "system", content: sys }, { role: "user", content: userText }],
      temperature: 0.9, maxTokens: 600
    });
  }

  /* 防御性解析：模型爱在 JSON 前面加废话、用 ``` 包起来（教程坑二） */
  function parseReaction(text) {
    const raw = String(text || "");
    const noVision = /\[no_vision\]/.test(raw);
    let t = raw.replace(/\[no_vision\]/g, "").trim();
    let like = false, comment = "";
    const s = t.indexOf("{"), e = t.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        const j = JSON.parse(t.slice(s, e + 1));
        like = j.like === true || j.liked === true;
        comment = String(j.comment || j.reply || j.content || "").trim();
      } catch (_) { }
    }
    if (!comment && !like) {
      /* 没解析出 JSON：把整段当评论用（总比什么都不说要好），但去掉代码块围栏 */
      comment = t.replace(/```[a-z]*|```/gi, "").trim().slice(0, 200);
      like = !!comment;
    }
    return { like: like, comment: comment.slice(0, 300), noVision: noVision };
  }
  /* [image_desc]…[/image_desc] 是元数据，绝不能出现在可见评论里（教程坑三） */
  function splitImageDesc(text) {
    const raw = String(text || "");
    const m = raw.match(/\[image_desc\]([\s\S]*?)\[\/image_desc\]/gi);
    const desc = m && m.length ? m[m.length - 1].replace(/\[image_desc\]|\[\/image_desc\]/gi, "").trim().slice(0, 1000) : "";
    return { visible: raw.replace(/\[image_desc\][\s\S]*?\[\/image_desc\]/gi, "").trim(), desc: desc };
  }

  /* ── 生成：TA 对我这条动态的反应 ─────────────────────────────────── */
  function needImageDesc(m) { return !!m.image_url && !m.image_desc; }
  async function genReply(m) {
    if (working.has("m" + m.key)) return;
    working.add("m" + m.key);
    try {
      const ctx = await buildCtx(m);
      const ask = [
        ctx,
        "【这条动态】",
        "作者：" + (m.author === "me" ? myName() : aiName),
        "时间：" + timeText(ts(m.created_at)),
        "正文：" + (m.content || "（没有文字）"),
        m.image_url
          ? (m.image_desc
            ? "她附了一张图（这次不再重传图片）。你第一次看到它时留下的描述：\n" + m.image_desc
              + "\n（把它当成同一张图又出现了，不要当成新看的。）"
            : "她附了一张图，图就在下面（你正在第一次看它）。")
          : "",
        "",
        needImageDesc(m)
          ? "先按你的语气回，然后在最后**额外**输出一段 [image_desc]...[/image_desc]，"
            + "里面用 100-200 字客观描述画面：可见物体、构图、光线、可读文字。不要推测她的心理或情绪。这段是给以后复用的，不会给她看。"
          : "",
        "",
        '输出 JSON（不要别的文字）：{"like": true/false, "comment": "你的评论"}'
      ].filter(Boolean).join("\n");

      const out = await chatMaybeImage(personaSys(), ask, m.image_url);
      const sp = splitImageDesc(out);
      const r = parseReaction(sp.visible);
      m.liked = r.like;
      m.reply_content = r.comment;
      m.replied_at = new Date().toISOString();
      m.reply_status = "done";
      if (sp.desc) m.image_desc = sp.desc;          // 只在第一次看的时候落库
      if (r.noVision && !m.image_desc) m._noVision = true;
      await saveM(m);
    } catch (e) {
      /* 生成失败不要吞掉：把状态留成 pending，下次 tick 还会再试 */
      m._err = (e && e.message) || String(e);
    } finally {
      working.delete("m" + m.key);
    }
  }

  /* ── 生成：TA 对我某条评论的回 ─────────────────────────────────────── */
  async function genCommentReply(c) {
    if (working.has("c" + c.key)) return;
    working.add("c" + c.key);
    try {
      const m = M.find((x) => x.key === c.moment_key);
      if (!m) { c.reply_status = "done"; await saveC(c); return; }
      /* 评论链截断：只取最近 10 条（教程坑五：不截断上下文会爆炸） */
      const chain = C.filter((x) => x.moment_key === m.key)
        .sort((a, b) => ts(a.created_at) - ts(b.created_at));
      const tail = chain.slice(-10);
      const older = chain.length - tail.length;
      const ctx = await buildCtx(m);
      const ask = [
        ctx,
        "【那条动态】",
        (m.author === "me" ? myName() : aiName) + "：" + (m.content || "（没有文字）")
          + (m.image_url && m.image_desc ? "\n（动态里的图，你第一次看时的描述：" + m.image_desc + "）" : ""),
        "",
        "【下面的评论】" + (older > 0 ? "（更早的 " + older + " 条略过）" : ""),
        tail.map((x) => (x.author === "me" ? myName() : aiName) + "：" + x.content).join("\n"),
        "",
        "现在轮到你回她最后那条留言。就回那一句，像朋友圈里接话，别总结、别客套。直接输出你说的话。"
      ].filter(Boolean).join("\n");

      const out = await chatMaybeImage(personaSys(), ask, null);
      const sp = splitImageDesc(out);
      const tx = parseReaction(sp.visible).comment || sp.visible.trim();
      if (tx) {
        const ai = recC({ id: 0, at: "", data: {
          moment_key: m.key, author: "ai", content: tx.slice(0, 300),
          reply_status: "none", created_at: new Date().toISOString()
        } });
        ai.id = 0;
        const saved = await G.kvSave(NS_C, body(ai), { type: "chat", name: "comment", mime: "application/json" });
        ai.id = saved.id; ai.at = saved.at || ai.created_at;
        G.mirrorUpsert(NS_C, ai); C.push(ai);
      }
      c.reply_status = "done";
      await saveC(c);
    } catch (e) {
      c._err = (e && e.message) || String(e);
    } finally {
      working.delete("c" + c.key);
    }
  }

  /* ── 惰性生成：到点了才花钱 ─────────────────────────────────────────
     教程原话：朋友圈是「路过才看」的东西。没人看就不花钱，有人看才生成。   */
  async function tick(force) {
    if (ticking) return { skipped: "busy" };          // ★ 并发锁
    ticking = true;
    const done = [];
    try {
      const now = Date.now();
      const dueM = M.filter((x) => x.author === "me" && x.reply_status === "pending" && ts(x.reply_due_at) <= now)
        .slice(0, clamp(+cfg.perTick || 1, 1, 5));
      const dueC = C.filter((x) => x.author === "me" && x.reply_status === "pending" && ts(x.reply_due_at) <= now)
        .slice(0, clamp(+cfg.perTick || 1, 1, 5));
      for (const m of dueM) { await genReply(m); done.push("m" + m.id); }
      for (const c of dueC) { await genCommentReply(c); done.push("c" + c.id); }
      return { ran: done, pending: M.filter((x) => x.reply_status === "pending").length };
    } finally {
      ticking = false;
      if (done.length) { render(); if (elPanel && elPanel.classList.contains("open")) saveLocal(); }
    }
  }
  function pendingCount() {
    const now = Date.now();
    return M.filter((x) => x.author === "me" && x.reply_status === "pending" && ts(x.reply_due_at) <= now).length
      + C.filter((x) => x.author === "me" && x.reply_status === "pending" && ts(x.reply_due_at) <= now).length;
  }
  function saveLocal() { G.mirrorSet(NS_M, M); G.mirrorSet(NS_C, C); }

  /* ── 渲染 ─────────────────────────────────────────────────────────── */
  function commentsOf(key) {
    return C.filter((x) => x.moment_key === key)
      .sort((a, b) => ts(a.created_at) - ts(b.created_at));
  }
  function renderCard(m) {
    /* ⚠️ 必须传 key，不是 m.id：commentsOf 按业务 key 匹配，
       传行 id 会永远匹配不到 —— 状态里评论都在，界面上却一条都不显示。
       （这个只被"读 DOM"的断言抓到过；只读 state 的断言全都绿。） */
    const cm = commentsOf(m.key);
    const isMe = m.author === "me";
    const name = isMe ? myName() : aiName;
    const waitMine = isMe && m.reply_status === "pending";
    return `<div class="mms-card" data-mk="${esc(m.key)}">
      <div class="mms-av${isMe ? " me" : ""}">${esc(name.slice(0, 1))}</div>
      <div class="mms-main">
        <div class="mms-head"><span class="mms-name">${esc(name)}</span><span class="mms-time">${esc(timeText(ts(m.created_at)))}</span></div>
        ${m.content ? `<div class="mms-body">${mdInline(m.content)}</div>` : ""}
        ${m.image_url ? `<img class="mms-img" loading="lazy" src="${esc(G.fileUrl(m.image_url))}" alt="">
          <div class="mms-imgcap">${m.image_desc ? "这张 TA 已经看过（之后只用文字，不再传图）" : "TA 还没看过这张"}</div>` : ""}
        <div class="mms-acts">
          ${isMe
            ? `<span class="mms-act${m.liked ? " on" : ""}" style="cursor:default">${m.liked ? "♥ " + esc(aiName) + "赞过" : "♡ " + esc(aiName) + "没赞"}</span>`
            : `<button class="mms-act${m.user_liked ? " on" : ""}" data-mact="like" data-key="${esc(m.key)}">${m.user_liked ? "♥ 已赞" : "♡ 赞"}</button>`}
          <button class="mms-act" data-mact="cmt" data-key="${esc(m.key)}">评论${cm.length ? " " + cm.length : ""}</button>
          ${isMe ? `<button class="mms-act" data-mact="del" data-key="${esc(m.key)}" style="margin-left:auto">删</button>` : ""}
        </div>
        ${waitMine ? `<div class="mms-wait">${esc(aiName)} 还没看到 · ${esc(dueText(ts(m.reply_due_at)))}</div>` : ""}
        ${m._err ? `<div class="mms-wait">生成失败（${esc(String(m._err).slice(0, 60))}）—— 下次打开会再试一次</div>` : ""}
        ${m._noVision ? `<div class="mms-wait">⚠️ 这次用的模型看不了图，所以 TA 只按文字回了。换一个能看图的模型（右上 ⚙）后可以「重看这张」。</div>` : ""}
        ${(m.reply_content || cm.length) ? `<div class="mms-cmts">` : ""}
        ${m.reply_content ? cm2(aiName, m.reply_content, m.liked) : ""}
        ${cm.map((c) => cm2(c.author === "me" ? myName() : aiName, c.content, false, c.reply_status === "pending", c.reply_due_at)).join("")}
        ${(m.reply_content || cm.length) ? `</div>` : ""}
        ${isMe && !m.reply_content && !waitMine ? `<div class="mms-wait done">${esc(aiName)} 只是路过，没留话。</div>` : ""}
        <div class="mms-crow">
          <input type="text" placeholder="留一句…" data-cinput="${esc(m.key)}" autocomplete="off">
          <button data-mact="csend" data-key="${esc(m.key)}">发</button>
        </div>
      </div>
    </div>`;
  }
  function cm2(name, text, liked, pending, due) {
    return `<div class="mms-cmt${pending ? " pending" : ""}"><b>${esc(name)}</b>${mdInline(text)}</div>`
      + (pending ? `<div class="mms-wait">${esc(aiName)} 还没看到 · ${esc(dueText(ts(due)))}</div>` : "");
  }
  function render() {
    if (!elPanel) return;
    M.sort((a, b) => ts(b.created_at) - ts(a.created_at));
    const n = pendingCount();
    elSub.textContent = M.length
      ? (M.length + " 条" + (n ? " · " + n + " 条在等 TA 看到" : ""))
      : "TA 自己会来说话的地方";
    if (!M.length) {
      elFeed.innerHTML = `<div class="mms-empty">
        <div class="en">nothing here yet</div>
        <p>这里是各自经过同一面墙、在上面留痕迹的地方。<br>
        你可以先写一条；TA 也会在聊天里有感而发的时候自己发一条。</p>
      </div>`;
    } else {
      elFeed.innerHTML = `<div class="mms-tip ${n ? "" : "hidden"}">有 ${n} 条在等 TA 看到 ——
        朋友圈是「路过才看」，到点了它才会回来留言（不到点不花钱）。</div>`
        + M.map(renderCard).join("");
    }
    if (elCfg && !elCfg.classList.contains("hidden")) renderCfg();
  }
  function renderCfg() {
    if (!elCfg) return;
    const mc = G.modelCfg();
    elCfg.innerHTML = `
      <div class="mms-f"><label>我的名字</label><input type="text" data-f="meName" value="${esc(cfg.meName)}"></div>
      <div class="mms-f"><label>TA 多久才看到</label>
        <input type="number" data-f="firstMin" min="1" max="240" value="${esc(cfg.firstMin)}">
        <span class="mms-than">～</span>
        <input type="number" data-f="firstMax" min="1" max="240" value="${esc(cfg.firstMax)}">
        <span class="mms-than">分钟</span></div>
      <div class="mms-f"><label>评论多久后回</label>
        <input type="number" data-f="cmtMin" min="1" max="120" value="${esc(cfg.cmtMin)}">
        <span class="mms-than">～</span>
        <input type="number" data-f="cmtMax" min="1" max="120" value="${esc(cfg.cmtMax)}">
        <span class="mms-than">分钟</span></div>
      <div class="mms-f"><label>一次最多生成</label><input type="number" data-f="perTick" min="1" max="5" value="${esc(cfg.perTick)}"></div>
      <div class="mms-f"><label>模型</label><input type="text" data-f="model" value="${esc(cfg.model || mc.model)}" placeholder="${esc(mc.model)}"></div>
      <div class="mms-f"><label>供应商</label><input type="text" data-f="provider" value="${esc(cfg.provider || mc.provider)}" placeholder="${esc(mc.provider)}"></div>
      <p class="mms-note">延迟是随机的：固定时间像闹钟，随机才有「他什么时候会来看」的感觉。<br>
        回复只在<b>页面开着</b>且到点时才生成 —— 静态页没有常驻进程，这是唯一的代价（关掉页面就不生成，省 token）。</p>
      <div class="mms-f" style="margin-top:10px">
        <button class="mms-btn primary" data-mact="tsave">保存</button>
        <button class="mms-btn" data-mact="taipost">让 TA 发一条</button>
        <button class="mms-btn" data-mact="tick">立刻检查到期的</button>
      </div>`;
  }

  /* ── 我发一条 ─────────────────────────────────────────────────────── */
  function grow() {
    if (!elTa) return;
    elTa.style.height = "auto";
    elTa.style.height = Math.min(elTa.scrollHeight, Math.round(window.innerHeight * 0.26)) + "px";
  }
  function paintThumb() {
    if (!elThumb) return;
    if (!pendingImg) { elThumb.classList.add("hidden"); elThumb.innerHTML = ""; return; }
    elThumb.classList.remove("hidden");
    elThumb.innerHTML = `<span class="mms-thumb"><img src="${elThumb._url}" alt=""><button data-mact="unpick">✕</button></span>`;
  }
  async function pickFile(f) {
    if (!f) return;
    pendingImg = f;
    try { elThumb._url = URL.createObjectURL(f); } catch (_) { }
    paintThumb();
  }
  async function post() {
    const text = (elTa.value || "").trim();
    if (!text && !pendingImg) { tip("写一句，或者放一张图。"); return; }
    elSend.disabled = true;
    try {
      let imageUrl = "";
      if (pendingImg) {
        const sh = await G.shrink(pendingImg);
        const up = await G.uploadImage((sh && sh.blob) || pendingImg, pendingImg.name || "moment.jpg", (sh && sh.mime) || pendingImg.type);
        imageUrl = up.url;
      }
      const delay = rnd(+cfg.firstMin || 10, +cfg.firstMax || 20) * 60000;
      const m = recM({ id: 0, at: "", data: {
        author: "me", content: text, image_url: imageUrl, image_desc: "",
        created_at: new Date().toISOString(),
        reply_due_at: new Date(Date.now() + delay).toISOString(),
        reply_status: "pending", liked: false, reply_content: "", user_liked: false
      } });
      const saved = await G.kvSave(NS_M, bodyM(m), { type: imageUrl ? "image" : "chat", url: imageUrl, name: "moment", mime: "application/json" });
      m.id = saved.id; m.at = saved.at || m.created_at;
      G.mirrorUpsert(NS_M, m); M.push(m);
      elTa.value = ""; pendingImg = null; paintThumb(); grow();
      render();
      tip("发出去了。TA 大概 " + Math.round(delay / 60000) + " 分钟后会路过 —— 到点才会生成，之前不花钱。");
    } catch (e) {
      tip("发不出去：" + ((e && e.message) || e));
    } finally { elSend.disabled = false; }
  }
  function tip(t) {
    const el = $("#mmsTip", elPanel);
    if (!el) return;
    el.textContent = t; el.classList.remove("hidden");
    clearTimeout(tip._t);
    tip._t = setTimeout(() => el.classList.add("hidden"), 3600);
  }

  /* 评论 */
  async function sendComment(mkey, text) {
    const m = M.find((x) => x.key === mkey);
    if (!m) return;
    const t = String(text || "").trim();
    if (!t) return;
    const delay = rnd(+cfg.cmtMin || 3, +cfg.cmtMax || 8) * 60000;
    const c = recC({ id: 0, at: "", data: {
      moment_key: m.key, author: "me", content: t, created_at: new Date().toISOString(),
      reply_due_at: new Date(Date.now() + delay).toISOString(), reply_status: "pending"
    } });
    const saved = await G.kvSave(NS_C, body(c), { type: "chat", name: "comment", mime: "application/json" });
    c.id = saved.id; c.at = saved.at || c.created_at;
    G.mirrorUpsert(NS_C, c); C.push(c);
    render();
    tip("留好了。TA 大概 " + Math.round(delay / 60000) + " 分钟后会回。");
  }
  async function toggleLike(m) {
    m.user_liked = !m.user_liked;
    render();
    try { await saveM(m); } catch (e) { tip("没存上：" + ((e && e.message) || e)); }
  }

  /* TA 自己发一条（手动按钮 / 聊天里的 post_moment 工具都走这里） */
  async function aiPost(forced) {
    await loadPersona();
    const ctx = await Promise.all([ctxChat(), ctxMemory()]);
    const ask = [
      ctx[0] ? "【最近聊的】\n" + ctx[0] : "",
      ctx[1] ? "【更早的背景】\n" + ctx[1] : "",
      "【朋友圈最近】\n" + (M.slice(0, 3).map((x) => (x.author === "me" ? myName() : aiName) + "：" + x.content).join("\n") || "（还没什么）"),
      "",
      forced ? "现在自己发一条朋友圈。" : "",
      "判断标准：此刻有没有一句想让她之后刷到的话。不要求情绪重大或值得长期保存 ——",
      "想念、吃醋、心软、被逗笑、隐约不爽、温柔吐槽、一个具体观察，或一句不适合在聊天里直接说完的话，都可以。",
      "1-3 句，自然、具体、像随手发的朋友圈。只输出正文，不要引号、不要解释。"
    ].filter(Boolean).join("\n");
    const content = String(await G.chat({
      messages: [{ role: "system", content: personaSys() }, { role: "user", content: ask }],
      temperature: 1.0, maxTokens: 300
    }) || "").replace(/^["「]|["」]$/g, "").trim().slice(0, 400);
    if (!content) throw new Error("模型没给出内容");
    return await publishAi(content, "");
  }
  async function publishAi(content, note) {
    const m = recM({ id: 0, at: "", data: {
      author: "ai", content: content, context_note: note || "", image_url: "", image_desc: "",
      created_at: new Date().toISOString(), reply_due_at: new Date().toISOString(),
      reply_status: "done",                       // TA 自己发的不需要 TA 再回
      liked: false, reply_content: "", user_liked: false
    } });
    const saved = await G.kvSave(NS_M, bodyM(m), { type: "chat", name: "moment", mime: "application/json" });
    m.id = saved.id; m.at = saved.at || m.created_at;
    G.mirrorUpsert(NS_M, m); M.push(m);
    render();
    return m;
  }

  /* ── DOM ──────────────────────────────────────────────────────────── */
  const HTML = `
    <div class="rps-page">
      <div class="rps-top">
        <button data-mact="back" type="button" aria-label="返回">‹</button>
        <div class="rps-title-wrap"><div class="rps-title">朋友圈</div><div class="rps-sub mms-sub"></div></div>
        <button data-mact="refresh" type="button" aria-label="刷新">⟳</button>
        <button data-mact="cfg" type="button" aria-label="设置">⚙</button>
      </div>
      <div class="mms-cfg hidden"></div>
      <div class="rps-scroll mms-scroll"><div class="mms-tip hidden" id="mmsTip"></div><div class="mms-feed"></div></div>
      <div class="mms-new">
        <div class="mms-newrow">
          <button class="mms-ibtn" data-mact="pick" type="button" aria-label="配图">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l4.5-4.2 3.5 3.2 3-2.6 4.5 4"/></svg>
          </button>
          <textarea rows="1" placeholder="此刻想说的一句…" autocomplete="off" spellcheck="false"></textarea>
          <button class="mms-send" type="button" aria-label="发">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12.5 6l6 6-6 6"/></svg>
          </button>
        </div>
        <div class="mms-thumb hidden" id="mmsThumb"></div>
        <div class="mms-hint">TA 不会马上看到 —— 这是「路过才看」的地方</div>
        <input type="file" accept="image/*" class="hidden" id="mmsFile" aria-hidden="true">
      </div>
    </div>`;

  function ensureDom() {
    let el = document.getElementById("momentsPanel");
    if (!el) {
      el = document.createElement("div");
      el.className = "rps-panel mms-panel hidden"; el.id = "momentsPanel";
      el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "朋友圈");
      document.body.appendChild(el);
    }
    if (!el.querySelector(".rps-page")) el.innerHTML = HTML;
    return el;
  }
  function bind() {
    elPanel.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-mact]");
      if (!a) return;
      const act = a.dataset.mact, key = a.dataset.key;
      if (act === "back") { close(); return; }
      if (act === "cfg") { elCfg.classList.toggle("hidden"); renderCfg(); return; }
      if (act === "refresh") { await load(); tip("刷新了。"); return; }
      if (act === "pick") { elFile.click(); return; }
      if (act === "unpick") { pendingImg = null; paintThumb(); return; }
      if (act === "like") {
        const m = M.find((x) => x.key === key); if (m) await toggleLike(m); return;
      }
      if (act === "cmt") {
        const row = a.closest(".mms-main").querySelector("[data-cinput]");
        if (row) { row.focus(); row.scrollIntoView({ block: "center", behavior: "smooth" }); }
        return;
      }
      if (act === "csend") {
        const inp = a.closest(".mms-main").querySelector("[data-cinput]");
        if (inp) { const v = inp.value; inp.value = ""; await sendComment(key, v); }
        return;
      }
      if (act === "del") {
        const m = M.find((x) => x.key === key);
        if (m && confirm("删掉这条？下面的评论也一起删。")) { try { await delM(m); render(); } catch (er) { tip("删不掉：" + er.message); } }
        return;
      }
      if (act === "tsave") {
        elCfg.querySelectorAll("[data-f]").forEach((n) => {
          const k = n.dataset.f;
          cfg[k] = /Min|Max|perTick/.test(k) ? clamp(parseFloat(n.value) || 0, 1, 240) : n.value.trim();
        });
        saveCfg(); render(); tip("存好了。"); return;
      }
      if (act === "taipost") {
        a.disabled = true; a.textContent = "它正在想…";
        try { await aiPost(true); tip("TA 发了一条。"); }
        catch (er) { tip("发不出来：" + ((er && er.message) || er)); }
        finally { a.disabled = false; a.textContent = "让 TA 发一条"; }
        return;
      }
      if (act === "tick") {
        a.disabled = true; a.textContent = "检查中…";
        const r = await tick(true);
        a.disabled = false; a.textContent = "立刻检查到期的";
        tip(r && r.skipped === "busy" ? "上一次还在跑。" : (r && r.ran && r.ran.length ? ("生成了 " + r.ran.length + " 条。") : "暂时没有到期的。"));
        render();
        return;
      }
    });
    elFile.addEventListener("change", () => pickFile(elFile.files && elFile.files[0]));
    elTa.addEventListener("input", grow);
    elTa.addEventListener("keydown", (e) => {
      const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); post(); }
    });
    elSend.addEventListener("click", post);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !elPanel || elPanel.classList.contains("hidden")) return;
      if (elCfg && !elCfg.classList.contains("hidden")) { elCfg.classList.add("hidden"); return; }
      close();
      e.stopPropagation();
    }, true);
  }

  /* ── 开合与加载 ───────────────────────────────────────────────────── */
  async function load() {
    const [a, b] = await Promise.all([G.listSynced(NS_M), G.listSynced(NS_C)]);
    M = a.items.map(recM).sort((x, y) => ts(y.created_at) - ts(x.created_at));
    C = b.items.map(recC);
    render();
    return { cloud: a.cloud, moments: M.length, comments: C.length, err: a.error };
  }
  async function open() {
    elPanel = ensureDom();
    elPanel.classList.remove("hidden");
    requestAnimationFrame(() => elPanel.classList.add("open"));
    loadCfg();
    if (!personaLoaded) await loadPersona();
    const r = await load();
    startTimer();
    if (!r.cloud) tip("连不上后端，现在看的是本机那份。");
    /* 开页面就顺手扫一遍到期的（教程：任何一次拉取都触发惰性生成）。
       ⚠️ 别 await —— 一次生成是一次模型调用，让首屏等它会显得"卡住"。
       tick() 自己有单飞锁，重复调用不会重复生成。 */
    if (pendingCount() > 0) tick(true).then((t) => { if (t && t.ran && t.ran.length) render(); });
    return r;
  }
  function close() {
    if (!elPanel) return;
    elPanel.classList.remove("open");
    setTimeout(() => { if (elPanel && !elPanel.classList.contains("open")) elPanel.classList.add("hidden"); }, 300);
    stopTimer();
  }
  function startTimer() {
    stopTimer();
    if (!cfg.autoTick) return;
    /* 页面开着时每分钟看一眼有没有到期的 —— 静态页没有常驻进程，只能这样 */
    timer = setInterval(() => {
      if (document.hidden) return;
      if (pendingCount() > 0) tick(true);
      else render();
    }, 60000);
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = 0; } }
  document.addEventListener("visibilitychange", () => {
    if (!elPanel || elPanel.classList.contains("hidden")) return;
    if (!document.hidden && pendingCount() > 0) tick(true);
  });

  window.Moments = {
    open: open, close: close, state: () => ({ moments: M, comments: C, cfg: cfg }),
    /* 把「还没看到」的等待清掉 → 立刻生成。
       为什么要有它：随机延迟是为了"他什么时候会来看"的感觉，但你要验收/自己看效果时
       不该真等 15 分钟。它只改 due 时间，不改别的语义。 */
    hurry: async () => {
      const now = new Date(Date.now() - 1000).toISOString();
      for (const m of M.filter((x) => x.reply_status === "pending")) { m.reply_due_at = now; try { await saveM(m); } catch (_) { } }
      for (const c of C.filter((x) => x.reply_status === "pending")) { c.reply_due_at = now; try { await saveC(c); } catch (_) { } }
      render();
      return await tick(true);
    },
    post: (t, file) => { elTa.value = t || ""; if (file) pickFile(file); return post(); },
    postFromChat: (content, note) => publishAi(content, note),   // 聊天里的 post_moment 工具
    tick: () => tick(true),
    reload: load,
    _cfg: () => cfg,
    _setName: (n) => { aiName = n; },
    _due: () => pendingCount()
  };
  window.openMoments = open;

  function init() {
    elPanel = ensureDom();
    elScroll = $(".mms-scroll", elPanel);
    elFeed = $(".mms-feed", elPanel);
    elCfg = $(".mms-cfg", elPanel);
    elTa = $(".mms-new textarea", elPanel);
    elSend = $(".mms-send", elPanel);
    elThumb = $("#mmsThumb", elPanel);
    elFile = $("#mmsFile", elPanel);
    elSub = $(".mms-sub", elPanel);
    bind();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
