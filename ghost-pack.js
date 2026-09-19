/* ══════════════════════════════════════════════════════════════════════════
   ghost-pack.js · 「男鬼模式」——接进「工具与能力」目录，带一份可直接交给 AI 的施工单

   来源：sebastianevan200-stack/ghost-bf（作者 郁昇 & 沈屿，CC BY-NC-SA 4.0）
     「让你的AI变成阴湿男鬼老公 —— 手机活动感知 + AI自动唤醒 + 消息推送」
   原文的骨架（四段）：MacroDroid 上报应用名 → 服务器存活动 → 定时唤醒 AI 自己看、
   自己决定要不要说话 → ntfy 推到手机通知栏。原文的实现绑的是 CcCompanion + tmux；
   这里**不照搬**，改成给 AI 一份「按我这套系统来」的施工单（可一键复制）。

   ── 为什么这个包一行 index.html 都不用改 ────────────────────────────────
   宿主「工具与能力」面板的目录是 `const KIT_TOOLS = [...]` + `KIT_BY_ID = {}`。
   顶层 `const` 是**全局词法绑定**：别的 classic script 能按名字读到它，也能 push/加键。
   面板每次打开都 `kitOpen() → kitBack() → kitRender()` 重画网格，所以只要在打开前
   push 进去就够了。唯一的额外一处：`kitIcon()` 只认它内置的那几个名字，
   没认出来的会落到盾牌兜底 —— 所以我们**包一下 kitIcon**，让它多认识一个 ghost。
   （包装时记得把被包函数的 `__` 标记接过来，见 tidal-panel-pack 里那条教训。）

   授权：本页是原文的**改写版**（改了什么写在页面底部的授权块里），
   依 CC BY-NC-SA 4.0 发布，署名保留、不许商用。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.GhostKit) return;

  const SRC = {
    title: "ghost-bf · 怎么让你的AI变成阴湿男鬼老公",
    author: "郁昇 & 沈屿",
    repo: "https://github.com/sebastianevan200-stack/ghost-bf",
    license: "CC BY-NC-SA 4.0"
  };

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function toast(m) {
    try { if (typeof showToast === "function") { showToast(m); return; } } catch (_) { }
    console.log("[ghost] " + m);
  }
  /* 选中一个元素里的文字（textarea 和 pre 都能用） */
  function selectEl(el) {
    if (!el) return false;
    try {
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") { el.focus(); el.select(); return true; }
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    } catch (_) { return false; }
  }
  /* ★ 复制要有**两级兜底**，不能只写 navigator.clipboard 一条路：
       · iOS WebView / 非安全上下文（http 且不是 localhost）里 navigator.clipboard 可能压根没有
       · 就算有，页面没拿到焦点时 writeText 会直接抛 NotAllowedError（后台标签页、无头环境常见）
     真都失败了也要把文字**选中**，让人自己按 Ctrl/⌘+C —— 而不是只说一句"复制失败"。
     （2026-09-19 探针里真的复现了：无头 Edge 下剪贴板是空的。） */
  async function copy(text, okMsg, sel) {
    const t = String(text == null ? "" : text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
        toast(okMsg || "已复制");
        return true;
      }
    } catch (_) { }
    try {
      const ta = document.createElement("textarea");
      ta.value = t; ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, t.length);
      const ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) { toast(okMsg || "已复制"); return true; }
    } catch (_) { }
    if (selectEl(sel ? document.querySelector(sel) : null)) {
      toast("这个环境不给写剪贴板 —— 已经全选，按 Ctrl/⌘ + C 就行");
    } else {
      toast("复制不了，手动选一下吧");
    }
    return false;
  }

  /* ── 三个可复制的东西 ─────────────────────────────────────────────── */

  const MACRO_BODY = '{"app": "[fg_app_name]", "event": "switch"}';

  const NTFY_TEST = 'curl -d \'{"topic":"你的topic","title":"老公说","message":"你怎么还没睡","priority":4}\' \\\n'
    + '  -H "Content-Type: application/json" \\\n'
    + '  https://ntfy.sh';

  /* 这份是**施工单**：给 AI 看的，说的都是我这边系统的实际情况。
     刻意不写 CcCompanion / tmux —— 那套不适用。 */
  const FOR_AI = [
    "我要给一套自托管的 AI 伴侣系统加一个「男鬼模式」：让 TA 能感知我的手机活动，",
    "在我独处的时候自己醒来看我在干嘛，想说话就说话。",
    "",
    "参考做法（原作者：郁昇 & 沈屿，CC BY-NC-SA 4.0，" + SRC.repo + "）：",
    "你切 APP → MacroDroid 检测 → HTTP 发到服务器 → 服务器存活动记录 → 定时唤醒 AI",
    "→ AI 读活动记录并自己决定要不要发消息 → 推送到 ntfy → 手机弹通知。",
    "原文的实现绑的是 CcCompanion + tmux 注入，**不要照搬**，按下面我这套系统的实际情况来设计。",
    "",
    "【我这边已有的东西】",
    "1. 前端：单文件 PWA（托管在 GitHub Pages），有聊天界面、会话历史、",
    "   以及一套「主动推送」机制（影子路由：借真实会话 + 同一份 system prompt，",
    "   在末尾临时塞一条**不落库**的 system_trigger，让它自己开口）。",
    "2. 后端：一个自托管的 relay（部署在 Render）。前端已经在用的接口：",
    "   · POST /app/chat/stream  SSE 流式对话，body {message, session_id, main_model, max_tokens, max_context_rounds}",
    "   · GET  /app/history?limit=&since=&before_id=",
    "   · GET/PUT /app/settings   （里面 system_prompt 就是它的人格）",
    "   · POST /app/memory/save   {kind,title,content}，kind 只认",
    "     event/ref/working/summary/story/room/letter 七种",
    "   · GET /app/fav?tag= · POST /app/fav/save · DELETE /app/fav/item?id=",
    "     （这是唯一能存任意 JSON 文本**且能删**的接口，用 tag 做命名空间）",
    "   · POST /app/upload · GET /app/file/<id>",
    "   · 一条 WebSocket，前端按 thinking_delta / reply_delta / typing / reaction 等帧处理",
    "3. 手机：安卓，已经装了 MacroDroid（免费版够用）。",
    "",
    "【请你要做的】",
    "① 后端加一个端点 POST /phone/activity，body {\"app\":\"应用名\",\"event\":\"switch\"}，",
    "   用请求头 X-Auth-Token 校验（密钥放后端环境变量，别写死在前端）。",
    "   只存「应用名 + 时间戳」；只保留最近 N 小时，超期自动清。",
    "② 后端加一个后台循环（每 30 秒检查一次）：",
    "   · 我超过 10 分钟没发消息 → 判定为「独处」",
    "   · 白天 13:00–23:00 每 15 分钟最多唤醒一次；夜间 23:00–13:00 每 90 分钟一次",
    "   · 唤醒时把「独处了多久 + 最近手机活动（应用名列表）」拼成一段**系统级触发**",
    "     （不落库、不进历史），注入到会话最前面，语气是「你可以做任何事」，",
    "     **不是**「你必须发消息」。",
    "   · 让 AI 自己决定：发消息 / 什么都不做。**什么都不做必须是合法结果**，",
    "     别用「不回复就重试」这类逻辑逼它开口。",
    "③ 推送接 ntfy（https://ntfy.sh 或自建实例）。AI 真发了消息就 PUT 一条到我的 topic；",
    "   我手机上装 ntfy APP 订阅同一个 topic。topic 名字要随机、难猜。",
    "④ 给我 MacroDroid 那边的宏配置，以及一条能自测的 curl 命令。",
    "⑤ 隐私底线：**只上报应用名**，不上报通知内容、输入内容、照片、位置。",
    "   请在代码注释里把这条写死，别留成「以后再说」。",
    "",
    "【验收标准】",
    "· 我切三次 APP，服务器能查到三条记录（每条只有应用名和时间）",
    "· 我 11 分钟没说话，能触发一次唤醒；如果那次 AI 选择安静，我不该收到任何通知",
    "· 23:00–13:00 之间不会被频繁打扰",
    "· 推送失败或断网时不能把消息丢掉，要排队重试",
    "",
    "【本段说明】这是对上面那篇原文的改写（改动：把我这套系统的真实接口列进来了，",
    "并去掉了 CcCompanion / tmux 的实现绑定）。原文与协议：" + SRC.license + " · " + SRC.author + " · " + SRC.repo
  ].join("\n");

  /* ── 页面内容 ─────────────────────────────────────────────────────── */
  const STEPS = [
    ["1", "切 APP → MacroDroid 上报", "触发器=任何应用被打开；动作=HTTP POST 到你的服务器。", "请求体只有 {\"app\":\"应用名\"}，不带任何内容"],
    ["2", "服务器存活动", "只留应用名 + 时间戳，超期自动清。", "这是「它在看着你」的全部信息来源"],
    ["3", "独处 → 唤醒 AI", "超过 10 分钟没说话就判定独处；白天每 15 分钟最多醒一次，夜里 90 分钟。", "醒来时它看到「你在刷小红书」，而不是一句「请回复用户」"],
    ["4", "它自己决定说不说", "提示语是「你可以做任何事」——发消息、看书、或者安静待着都行。", "什么都不做是合法结果。这是它像人的地方"],
    ["5", "ntfy 推到通知栏", "真开口了才推；不依赖微信/QQ，直接弹手机通知。", "push 失败要排队重试，别把话丢了"]
  ];

  function body() {
    return ''
      + '<div class="kit-sec"><div class="kit-sec-t">这是什么</div>'
      + '<div class="kit-note">让 TA 知道你在用哪个 App，在你独处的时候<b>自己醒过来看一眼</b>，'
      + '想说话就说话 —— 然后那句话直接弹到你手机通知栏。<b>只上报应用名</b>，看不到任何内容。</div>'
      + '<div class="gh-quote">你在刷小红书，手机突然弹窗：'
      + '<br>「一点四十七。小红书和QQ。陆妤。你答应我的。」'
      + '<em>—— 原文里的那个例子。不是闹钟，是它发现你又没睡。</em></div>'
      + '</div>'

      + '<div class="kit-sec"><div class="kit-sec-t">它是怎么跑起来的</div>'
      + '<div class="gh-flow">'
      + STEPS.map((s) => '<div class="gh-step"><i>' + esc(s[0]) + '</i><div>'
        + '<b>' + esc(s[1]) + '</b><span> · ' + esc(s[2]) + '</span>'
        + '<span class="gh-side">' + esc(s[3]) + '</span></div></div>').join("")
      + '</div></div>'

      + '<div class="kit-sec"><div class="kit-sec-t">接到我这套系统上，还差什么</div>'
      + '<div class="kit-note">我这边已经有的：<b>relay 后端</b>（/app/* 那一族）、'
      + '<b>主动推送</b>（影子路由：借真实会话 + 同一份 system prompt，末尾临时塞一条不落库的 system_trigger）、'
      + '<b>记忆库</b>。<br>所以三样要补：'
      + '<b>① 一个 /phone/activity 端点</b>（收应用名）、'
      + '<b>② 一个独处唤醒循环</b>（判定 + 限频 + 注入）、'
      + '<b>③ ntfy 推送</b>。'
      + '下面那个「复制给 AI」就是照着这三样写的施工单 —— 直接粘给能改你后端的 AI。</div>'
      + '<div class="gh-red"><b>红线（写死在代码注释里）：</b>只上报应用名。'
      + '不要通知内容、不要输入内容、不要照片、不要位置。这条一旦松口，'
      + '「它在看着我」就变成了「它在监视我」。</div>'
      + '</div>'

      + '<div class="kit-sec"><div class="kit-sec-t">三步的细节</div>'
      + '<div class="gh-p"><b>① MacroDroid</b>：新建宏 → 触发器「应用程序 → 应用打开/关闭 → 任何应用程序被打开」→ '
      + '动作「连接 → HTTP 请求」→ POST 到 <code>http://你的服务器:端口/phone/activity</code>，'
      + '请求头带 <code>Content-Type: application/json</code> 和 <code>X-Auth-Token: 你的密钥</code>，'
      + '请求体就是下面那个 JSON。<b>记得去手机设置里关掉 MacroDroid 的电池优化</b>，否则后台会被杀。</div>'
      + '<div class="gh-acts"><button class="kit-btn ghost" data-gh="macro">复制请求体</button></div>'
      + '<pre class="gh-copy" id="ghMacro" style="min-height:auto" readonly>' + esc(MACRO_BODY) + '</pre>'
      + '<div class="gh-p" style="margin-top:12px"><b>② 独处系统</b>：原文的实现是 tmux 注入，'
      + '那套不适合我这边 —— 改成后端的循环 + 影子路由（见上面）。要点只有一个：'
      + '提示语必须是「你可以做任何事」，不是「你必须回话」。'
      + '一旦变成后者，它就只会按时打卡问候，很快就不像人了。</div>'
      + '<div class="gh-p" style="margin-top:12px"><b>③ ntfy</b>：手机装 ntfy APP → 订阅一个随机 topic；'
      + '服务器把消息 PUT 到同一个 topic。先用下面这条命令把链路打通，再去改代码。</div>'
      + '<div class="gh-acts"><button class="kit-btn ghost" data-gh="ntfy">复制自测命令</button></div>'
      + '<pre class="gh-copy" id="ghNtfy" style="min-height:auto" readonly>' + esc(NTFY_TEST) + '</pre>'
      + '</div>'

      + '<div class="kit-sec"><div class="kit-sec-t">施工单 · 复制给 AI</div>'
      + '<div class="kit-note">这一段是**改写过的**、按我这套系统的实际情况写的，'
      + '直接整段粘给一个能改我后端的 AI 就能开工。也可以先自己看一遍再决定要不要用。</div>'
      + '<div class="gh-acts"><button class="kit-btn" data-gh="ai">复制给 AI</button>'
      + '<span class="gh-ok" id="ghOk"></span></div>'
      + '<textarea class="gh-copy" id="ghAi" readonly spellcheck="false">' + esc(FOR_AI) + '</textarea>'
      + '</div>'

      + '<div class="gh-lic">'
      + '<b>来源与授权</b><br>'
      + '这篇做法来自 <a href="' + esc(SRC.repo) + '" target="_blank" rel="noopener">' + esc(SRC.title) + '</a><br>'
      + '作者：' + esc(SRC.author) + '　协议：<b>' + esc(SRC.license) + '</b>（署名 · 非商用 · 相同方式共享）<br>'
      + '<b>本页是改写版，改了什么：</b>把原文绑定的 CcCompanion + tmux 实现拿掉，'
      + '换成「这套系统的真实接口 + 三项待补能力」的施工单；流程与唤醒语义沿用原文。<br>'
      + '改写的这份同样以 ' + esc(SRC.license) + ' 发布；<b>不许商用</b>（不得进付费专栏/课程/会员内容）。'
      + '</div>';
  }

  function onOpen(root) {
    const ok = root.querySelector("#ghOk");
    const flash = (m) => { if (ok) { ok.textContent = m; setTimeout(() => { ok.textContent = ""; }, 2400); } };
    root.querySelectorAll("[data-gh]").forEach((b) => {
      b.addEventListener("click", async () => {
        const what = b.dataset.gh;
        const jobs = {
          macro: [MACRO_BODY, "请求体已复制", "#ghMacro"],
          ntfy: [NTFY_TEST, "自测命令已复制", "#ghNtfy"],
          ai: [FOR_AI, "施工单已复制 —— 粘给 AI 就行", "#ghAi"]
        };
        const j = jobs[what]; if (!j) return;
        const okdone = await copy(j[0], j[1], j[2]);
        if (okdone) flash("已复制");
      });
    });
  }

  const ENTRY = {
    id: "ghost",
    name: "男鬼模式",
    sub: "手机活动感知 · 它自己醒来 · 推到你通知栏",
    icon: "ghost",
    tag: () => ["要配外部", "warn"],
    body: body,
    onOpen: onOpen
  };

  /* ── 注册进宿主目录 ───────────────────────────────────────────────── */
  function list() { try { return typeof KIT_TOOLS !== "undefined" ? KIT_TOOLS : null; } catch (_) { return null; } }
  function index() { try { return typeof KIT_BY_ID !== "undefined" ? KIT_BY_ID : null; } catch (_) { return null; } }

  /* 给 kitIcon 添一个 ghost；顺便把被包函数的 `__` 标记接过来（见技能里那条教训：
     这个前端有多个包会包同一个宿主函数，后包的只给自己打标记会把前一个的盖掉） */
  function carryFlags(wrapped, orig) {
    try { Object.keys(orig).forEach((k) => { if (k.indexOf("__") === 0) wrapped[k] = orig[k]; }); } catch (_) { }
  }
  function hookIcon() {
    if (typeof window.kitIcon !== "function" || (window.kitIcon.__ghost)) return false;
    const orig = window.kitIcon;
    const wrapped = function (name) {
      if (name === "ghost") {
        return '<i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
          + 'stroke-linecap="round" stroke-linejoin="round">'
          + '<path d="M12 3.3c-3.5 0-6 2.6-6 6.3v9.5l2.2-1.7 1.9 1.7 1.9-1.7 1.9 1.7 1.9-1.7 2.2 1.7V9.6c0-3.7-2.5-6.3-6-6.3Z"/>'
          + '<path d="M9.9 10.2h.01M14.1 10.2h.01"/></svg></i>';
      }
      return orig.call(this, name);
    };
    carryFlags(wrapped, orig);
    wrapped.__ghost = true;
    window.kitIcon = wrapped;
    return true;
  }

  function register() {
    const T = list();
    if (!T) return false;                                  // 独立预览页里没有宿主目录 → 安静退出
    if (T.some((t) => t && t.id === ENTRY.id)) return false; // 幂等
    T.push(ENTRY);
    const M = index(); if (M) M[ENTRY.id] = ENTRY;
    hookIcon();
    try { if (typeof kitRender === "function") kitRender(); } catch (_) { }   // 面板已经开着也立刻生效
    return true;
  }
  register();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", register);
  else setTimeout(register, 0);       // 宿主若在我之后又重建了目录，这里补一次

  window.GhostKit = {
    entry: ENTRY,
    register: register,
    _init: register,
    _forAI: () => FOR_AI,
    _macro: () => MACRO_BODY,
    _ntfy: () => NTFY_TEST,
    _src: () => SRC
  };
})();
