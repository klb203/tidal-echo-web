/* ══════════════════════════════════════════════════════════════════════════
   album-pack.js · 图片记忆（App 内整页面板）

   原来 album.html 是一个**独立页面**，侧边栏点「Album」是 location.assign 过去的。
   那条路的代价：① 每进一次相册就是整页重载；② 点返回又要重载一遍 index.html，
   于是会再走一次开屏/连接密钥那屏，最后落到聊天 —— 也就是你看到的现象。
   现在改成宿主里的整页面板：进 = 盖一层，回 = 关一层，不进开屏、不掉会话。

   逻辑本身（SHA-256 去重 / 两条并行的描述线 / 复用只传文字）一行没改，
   只做了三件"搬到宿主里"必须做的事：
     · 所有 $() 收进面板内查询
     · 返回 / 去主页 → 关面板，不再 location.assign
     · 亮色色板不再自己写死，改用宿主主题变量（见 album-pack.css）
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.AlbumPanel) return;          // 防重复加载

  let elPanel = null, elScroll = null;

  const PANEL_HTML = `<div class="alb-wall"></div>
<div class="alb-scroll" id="albScroll">
<div class="alb-wall"></div>

<!-- 顶栏 -->
<div class="bar">
  <button class="icon" id="topBack" title="返回">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
  </button>
  <span class="grow"></span>
  <button class="icon" id="gearBtn" title="模型">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3.6v2.2M12 18.2v2.2M4.9 7.9l1.9 1.1M17.2 15l1.9 1.1M4.9 16.1l1.9-1.1M17.2 9l1.9-1.1"/></svg>
  </button>
  <div class="top-label" id="topLabel">PICTURE<br>MEMORY<span class="rule"></span></div>
</div>

<!-- ⚙ 模型：谁来看图、谁来写印象 -->
<div class="wrap hidden" id="cfgBox" style="padding-bottom:6px">
  <div class="gm-card">
    <span>看图与写字用的模型</span>
    <div class="gm-row">
      <select id="cfgProvider">
        <option value="zhipu">云端 · 智谱 GLM（可看图：glm-4v-plus）</option>
        <option value="openai">云端 · OpenAI（gpt-4o）</option>
        <option value="openrouter">云端 · OpenRouter</option>
        <option value="moonshot">云端 · Kimi</option>
        <option value="qwen">云端 · 阿里百炼</option>
        <option value="deepseek">云端 · DeepSeek（⚠️ 看不了图）</option>
      </select>
      <input type="text" id="cfgModel" placeholder="模型名，如 glm-4v-plus">
    </div>
    <p class="gm-note" id="cfgNote">描述图片需要**能看图**的模型。DeepSeek 只能读文字，选它描述会失败（图照收不误，只是描述待补）。</p>
    <div class="gm-row">
      <button class="glass" id="cfgSave" style="flex:1;padding:10px;border-radius:12px">保存</button>
    </div>
  </div>
</div>

<!-- ════════ 列表 ════════ -->
<div class="wrap" id="listView">
  <div class="hero">
    <h1>Picture Memory</h1>
    <div class="sub">看过一次，就不会忘。</div>
  </div>

  <div class="tools">
    <div class="search glass">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
      <input id="searchInput" type="search" placeholder="找一张…（标题 / 描述）" autocomplete="off">
    </div>
    <button class="up-btn glass" id="upBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      收一张
    </button>
  </div>

  <div class="gm-stats" id="stats"></div>

  <!-- board 照片墙：照片在底层，al-board.png 当上层压边 -->
  <div class="board-zone" id="boardZone">
    <div class="board" id="board">
      <img class="board-bg" src="al-board.png" alt="" draggable="false">
      <button class="pw-draw" id="drawBtn" title="随机抽一张"></button>
    </div>
  </div>

  <div id="recentSec">
    <div class="sec-head"><h2>最近收的</h2><button class="more" id="recentAll">see all ›</button></div>
    <div class="rail" id="recent"></div>
    <div class="dots" id="recentDots"></div>
  </div>

  <div id="albumsSec" class="hidden">
    <div class="sec-head"><h2>My Albums</h2><button class="more" id="albumsAll">see all ›</button></div>
    <div class="albums" id="albums"></div>
  </div>

  <div id="gridSec" class="hidden">
    <div class="sec-head"><h2 id="gridHead">全部</h2><button class="more" id="gridBack">‹ back</button></div>
    <div class="rgrid" id="grid"></div>
  </div>

  <div class="empty hidden" id="listEmpty">
    <div class="en">no pictures yet</div>
    <p>点「收一张」，放第一张进来。TA 会写下一段客观描述，和一句只写给你看的第一印象。</p>
  </div>
  <div class="msg hidden" id="listMsg"></div>
</div>

<!-- ════════ 详情 ════════ -->
<div class="wrap detail hidden" id="detailView">
  <img class="photo" id="detailImg" alt="">
  <div class="author">
    <div class="av"></div>
    <div class="nm"><b id="peerName">TA<small></small></b><span id="detailTime"></span></div>
  </div>

  <h1 id="detailCap"></h1>
  <div class="gm-row" style="margin:2px 2px 0">
    <button class="gm-mini" id="renameBtn">改标题</button>
    <button class="gm-mini" id="reorderBtn" style="display:none">降序</button>
  </div>
  <div class="tags" id="detailTags"></div>

  <div class="gm-card gm-desc">
    <span>TA 第一次看见的（客观描述）</span>
    <p id="detailDesc"></p>
  </div>
  <div class="gm-card gm-imp hidden" id="impCard">
    <span>当时留下的第一印象</span>
    <p id="detailImp"></p>
  </div>

  <div class="gm-meta" id="detailMeta"></div>
  <div class="gm-reuse" id="detailReuse"></div>

  <div class="act">
    <button class="glass" id="actZoom">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4M11 8v6M8 11h6"/></svg>
      查看大图
    </button>
    <button class="glass" id="actChat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z"/></svg>
      带去 Chat
    </button>
  </div>
  <div class="act">
    <button class="glass" id="actRetry">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>
      补描述
    </button>
    <button class="glass" id="actDel" style="color:var(--danger)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V5.2h5V7M6.5 7l.9 12.2h9.2L17.5 7"/></svg>
      删除
    </button>
  </div>

  <div class="footer">
    <h3>Picture Memory</h3>
    <p>every picture keeps a word from the first time</p>
  </div>
</div>

<!-- ════════ 密钥门（只在后端要求鉴权时出现） ════════ -->
<div class="wrap gate hidden" id="gateView">
  <div class="hero" style="padding-top:40px"><h1>Picture Memory</h1><div class="sub">a private little gallery</div></div>
  <div class="gatebox">
    <p>后端要访问密钥。先在主页登录，或在此粘贴（与 PWA 同一个）。</p>
    <input type="text" id="gateInput" placeholder="访问密钥">
    <div class="row">
      <button class="ghost" id="gateHome">去主页</button>
      <button class="send" id="gateSave">保存并进入</button>
    </div>
  </div>
</div>
</div>
<!-- ════════ 收一张（悬浮窗） ════════ -->
<div class="modal hidden" id="uploadModal">
  <div class="sheet" id="uploadSheet">
    <button class="sheet-x" id="uploadClose" aria-label="关闭">✕</button>
    <div class="fh">收一张进记忆</div>
    <div class="fsub">TA 会先看一遍，然后写两句</div>
    <label>选一张（可直接拍）</label>
    <input type="file" id="fileInput" accept="image/*">
    <img class="preview hidden" id="preview" alt="预览">
    <label>分组（可空，如 出游 / 日常）</label>
    <input type="text" id="groupInput" placeholder="出游 / 日常 …">
    <div class="row">
      <button class="ghost" id="uploadCancel">取消</button>
      <button class="send" id="uploadSend">收进记忆</button>
    </div>
    <div class="status" id="uploadStatus"></div>
  </div>
</div>`;

  function ensureDom() {
    let el = document.getElementById("albumPanel");
    if (el) return el;
    el = document.createElement("div");
    el.className = "alb-panel hidden";
    el.id = "albumPanel";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "图片记忆");
    el.innerHTML = PANEL_HTML;
    document.body.appendChild(el);
    return el;
  }


/* ══════════════════════════════════════════════════════════════════════════
   Gallery · 图片记忆
   机制照 vellwarren/bunnyhome-gallery-tutorial 落地，存储换成你后端现成的那两个接口：
     · 图片本体 → POST /app/upload  →  /app/file/<id>
     · 元数据   → /app/fav（tag = "gallery"）
   三件事是这份实现的核心，缺一条就不成立：
     ① 每张图只描述一次 —— 之后复用只给文字，不再传像素（几千 token → 几十字）
     ② 客观描述与第一印象**分开生成**：前者由不带人格的中性工人写，后者由人格写
     ③ SHA-256 去重只算图片二进制、不含元数据 —— 所以改了标题也不会被下次上传覆盖
   ══════════════════════════════════════════════════════════════════════════ */
elPanel = ensureDom();          // 先把面板 DOM 注进来，下面所有 $() 才有得查
const G = window.MediaStore;
const NS = "gallery";
const AI_NAME = "TA";
/* ⚠️ 原来这里是 document.getElementById —— 现在整页是宿主里的一个面板，
   所有元素都必须**在面板内**查，否则同 id 一旦撞车就拿到别人的节点。
   （本次实测宿主里没有同名 id，但这条纪律得留着。） */
const $ = (id) => elPanel.querySelector('[id="' + id + '"]');
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const peerAvatar = localStorage.getItem("companion_avatar");
const peerName = (localStorage.getItem("companion_profile_remark") || "").trim() || AI_NAME;
elPanel.style.setProperty("--peer-avatar", peerAvatar ? `url("${peerAvatar}")` : 'url("avatar-sea.png")');

/* board 8 个相框（相对 al-board.png 1046×917 的孔洞包围盒，照片在底层被 PNG 压边） */
const FRAMES = [
  { l: 33.75, t: 1.74, w: 29.45, h: 28.14 }, { l: 66.44, t: 6.00, w: 27.15, h: 23.88 },
  { l: 4.68, t: 12.10, w: 25.53, h: 30.64 }, { l: 37.09, t: 33.15, w: 24.09, h: 28.57 },
  { l: 63.48, t: 33.59, w: 27.34, h: 27.37 }, { l: 35.66, t: 64.89, w: 25.62, h: 26.72 },
  { l: 62.05, t: 67.28, w: 18.07, h: 27.81 }, { l: 76.96, t: 65.21, w: 20.94, h: 25.95 }
];

const views = { list: $("listView"), detail: $("detailView"), gate: $("gateView") };
function show(name) {
  for (const k in views) views[k].classList.toggle("hidden", k !== name);
  $("topLabel").style.visibility = (name === "list") ? "visible" : "hidden";
  $("cfgBox").classList.add("hidden");
  if (elScroll) elScroll.scrollTo({ top: 0 });
}

let ALL = [];              // 记录（最新的在前）
let hasGroups = false, filterGroup = "", filterText = "", curRec = null, cloudOn = true;

function imgUrl(r) { return G.fileUrl(r.url); }
function fmtAt(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function rec(item) {
  const d = item.data || {};
  return {
    id: item.id, at: item.at || "", url: item.url || d.url || "", hash: d.hash || "",
    title: d.title || "", desc: d.desc || "", impression: d.impression || "",
    desc_state: d.desc_state || (d.desc ? "ok" : "pending"),
    first_sent_at: d.first_sent_at || "", send_count: d.send_count || 0,
    group: d.group || "", w: d.w || 0, h: d.h || 0, mime: item.mime || d.mime || ""
  };
}

/* ── 读列表：云端优先，断网退本地镜像 ── */
async function loadList() {
  show("list");
  $("listMsg").classList.add("hidden");
  const r = await G.listSynced(NS);
  cloudOn = r.cloud;
  ALL = r.items.map(rec).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  hasGroups = ALL.some((p) => (p.group || "").trim());

  $("listEmpty").classList.toggle("hidden", ALL.length > 0);
  $("boardZone").classList.toggle("hidden", ALL.length === 0);
  $("recentSec").classList.toggle("hidden", ALL.length === 0);
  exitGrid();
  paintStats();
  renderBoard(); renderRecent(); renderAlbums();

  if (!r.cloud) {
    $("listMsg").textContent = "连不上后端，现在显示的是本机存的那份（" + (r.error || "") + "）";
    $("listMsg").classList.remove("hidden");
  }
}
function paintStats() {
  const n = ALL.length, done = ALL.filter((x) => x.desc).length;
  const used = ALL.reduce((a, x) => a + (x.send_count || 0), 0);
  $("stats").innerHTML = "共 <b>" + n + "</b> 张 · 有描述 <b>" + done + "</b> 张 · 复用 <b>" + used + "</b> 次"
    + (n && done < n ? " · <span style='color:#B36A1A'>" + (n - done) + " 张待补描述</span>" : "");
}

function renderBoard() {
  const board = $("board");
  board.querySelectorAll(".pw-frame").forEach((n) => n.remove());
  const recent = ALL.slice(0, FRAMES.length);
  FRAMES.forEach((f, i) => {
    const p = recent[i]; if (!p) return;
    const el = document.createElement("button"); el.className = "pw-frame";
    el.style.cssText = `left:${f.l}%;top:${f.t}%;width:${f.w}%;height:${f.h}%;animation-delay:${i * 55}ms`;
    el.innerHTML = `<img loading="lazy" src="${imgUrl(p)}" alt="">`;
    el.onclick = () => openDetail(p.id);
    board.appendChild(el);
  });
}
function renderRecent() {
  const box = $("recent"); box.innerHTML = "";
  ALL.slice(0, 12).forEach((p, i) => {
    const b = document.createElement("button"); b.className = "r-item"; b.style.animationDelay = (i * 40) + "ms";
    b.innerHTML = `<img loading="lazy" src="${imgUrl(p)}" alt="">`;
    b.onclick = () => openDetail(p.id); box.appendChild(b);
  });
  const dots = $("recentDots");
  const pages = Math.max(1, Math.min(5, Math.ceil(Math.min(ALL.length, 12) / 4)));
  dots.innerHTML = ""; for (let i = 0; i < pages; i++) { const d = document.createElement("span"); d.className = "dot" + (i === 0 ? " on" : ""); dots.appendChild(d); }
}
$("recent").addEventListener("scroll", () => {
  const box = $("recent"), dots = $("recentDots").children; if (!dots.length) return;
  const max = box.scrollWidth - box.clientWidth;
  const idx = max > 0 ? Math.round((box.scrollLeft / max) * (dots.length - 1)) : 0;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i === idx);
});
function renderAlbums() {
  const map = new Map();
  for (const p of ALL) { const g = (p.group || "").trim(); if (!g) continue;
    if (!map.has(g)) map.set(g, { name: g, count: 0, cover: p }); map.get(g).count++; }
  const list = [...map.values()];
  $("albumsSec").classList.toggle("hidden", list.length === 0);
  const box = $("albums"); box.innerHTML = "";
  for (const a of list) {
    const b = document.createElement("button"); b.className = "album glass";
    b.innerHTML = `<div class="cov"><img loading="lazy" src="${imgUrl(a.cover)}" alt=""></div>
      <div class="txt"><b>${esc(a.name)}</b><span>${a.count} 张</span></div>`;
    b.onclick = () => enterGrid({ group: a.name, title: a.name }); box.appendChild(b);
  }
}

function enterGrid(opt) {
  filterGroup = opt.group || ""; if (opt.text !== undefined) filterText = opt.text;
  $("recentSec").classList.add("hidden"); $("albumsSec").classList.add("hidden");
  $("boardZone").classList.add("hidden"); $("gridSec").classList.remove("hidden");
  $("gridHead").textContent = opt.title || "全部";
  renderGrid();
  if (!opt.noScroll) $("gridSec").scrollIntoView({ behavior: "smooth", block: "start" });
}
function exitGrid() {
  filterGroup = ""; filterText = ""; if ($("searchInput")) $("searchInput").value = "";
  $("gridSec").classList.add("hidden");
  if (ALL.length) { $("recentSec").classList.remove("hidden"); $("boardZone").classList.remove("hidden"); }
  $("albumsSec").classList.toggle("hidden", !hasGroups);
}
function renderGrid() {
  const grid = $("grid");
  let items = ALL.slice();
  if (filterGroup) items = items.filter((p) => (p.group || "") === filterGroup);
  if (filterText) {
    const q = filterText.toLowerCase();
    items = items.filter((p) => ((p.title || "") + " " + (p.desc || "") + " " + (p.group || "")).toLowerCase().includes(q));
  }
  grid.innerHTML = "";
  if (!items.length) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="en">nothing here</div><p>换个词，或返回看看。</p></div>`; return; }
  items.forEach((p, i) => {
    const card = document.createElement("button"); card.className = "rcard"; card.style.animationDelay = (i * 35) + "ms";
    card.innerHTML = `<img class="img" loading="lazy" src="${imgUrl(p)}" alt="">
      <div class="cap">${esc(p.title || "（还没起名）")}</div>
      <div class="meta"><span>${p.send_count ? "发过 " + p.send_count + " 次" : "还没在聊天里用过"}</span>
        ${p.desc ? "" : "<span style='color:#B36A1A'>待补描述</span>"}</div>`;
    card.onclick = () => openDetail(p.id); grid.appendChild(card);
  });
}

/* ── 详情 ── */
function renderDetail(r) {
  show("detail");
  curRec = r;
  $("detailImg").src = imgUrl(r);
  $("peerName").innerHTML = esc(peerName);
  $("detailCap").textContent = r.title || "（还没起名）";
  $("detailTime").textContent = r.first_sent_at ? ("第一次发来 · " + fmtAt(r.first_sent_at)) : ("收进来的时间 · " + fmtAt(r.at));
  $("detailDesc").textContent = r.desc || "（还没写）—— 点下面的「补描述」，让模型看一眼。";
  $("impCard").classList.toggle("hidden", !r.impression);
  $("detailImp").textContent = r.impression || "";

  const tags = $("detailTags"); tags.innerHTML = "";
  if (r.group) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "# " + r.group; tags.appendChild(t); }
  if (r.hash) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "指纹 " + r.hash.slice(0, 8); tags.appendChild(t); }

  const meta = [];
  meta.push("发过 " + (r.send_count || 0) + " 次");
  if (r.w && r.h) meta.push(r.w + "×" + r.h);
  $("detailMeta").textContent = meta.join(" · ");

  $("detailReuse").innerHTML = r.first_sent_at
    ? "这张 <b>已经被看过</b>了 —— 以后在 Chat 里再发同一张，<b>不会再传图片像素</b>，只用上面那段文字，成本是第一次的零头。"
    : "这张还没在 Chat 里用过。第一次发的时候会传一次原图给 TA 看，之后就一直只用文字了。";
  $("actRetry").textContent = r.desc ? "重写描述" : "补描述";
}
async function openDetail(id) {
  const r = ALL.find((x) => String(x.id) === String(id));
  if (!r) return;
  if (!r.desc && !r._tried && cloudOn) { r._tried = true; }
  renderDetail(r);
}
function openLightbox() {
  const u = curRec ? imgUrl(curRec) : ""; if (!u) return;
  const lb = document.createElement("div"); lb.className = "lightbox";
  lb.innerHTML = `<img src="${u}" alt="">`; lb.onclick = () => lb.remove();
  elPanel.appendChild(lb);
}
function randomOne() {
  if (!ALL.length) { alert("还没有图。"); return; }
  openDetail(ALL[Math.floor(Math.random() * ALL.length)].id);
}

/* ── 两条并行线：客观描述（中性工人） + 第一印象（人格）────────────────────
   教程「坑二」：这两样必须**分开生成**，否则客观描述里会混进"她又来了"，
   第一印象里会混进"白色窗台灰蓝色天空"。两条各跑各的，谁先完成谁先落库。 */
const VISUAL_WORKER = [
  "你是一个私有的中性图片索引工人，不是任何人的角色，也不参与对话。",
  "返回一段 100-200 个中文字符的段落，只包含直接可见的事实。",
  "覆盖主体、构图、颜色、光线和清晰可读的文字。",
  "不要使用第一或第二人称的关系性语言。",
  "不要推测身份、心理、情绪、意图、关系、背景故事或含义。"
].join(" ");

let personaCache = null;
async function loadPersona() {
  if (personaCache != null) return personaCache;
  try {
    const r = await fetch(G.base() + "/app/settings", { headers: G.headers() });
    const d = await r.json();
    personaCache = ((d && d.settings && d.settings.system_prompt) || "").slice(0, 4000);
  } catch (_) { personaCache = ""; }
  return personaCache;
}
async function describeImage(dataUrl, note) {
  return await G.chat({
    messages: [
      { role: "system", content: VISUAL_WORKER },
      { role: "user", content: [
        { type: "text", text: note || "描述这张图。" },
        { type: "image_url", image_url: { url: dataUrl } }
      ] }
    ],
    temperature: 0.2, maxTokens: 400
  });
}
async function impressionOf(dataUrl) {
  const persona = await loadPersona();
  const sys = (persona ? persona + "\n\n" : "")
    + "现在不是聊天。你刚看到对方发来的一张图，要写一条**只有你自己能看到**的隐藏备注："
    + "这张图此刻对你意味着什么。用你自己的语气，1-2 句，不超过 60 字，不要像目录条目、"
    + "不要复述画面细节（客观描述由别人写）。只输出这段话本身。";
  return await G.chat({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "text", text: "（这张图）" },
        { type: "image_url", image_url: { url: dataUrl } }
      ] }
    ],
    temperature: 0.95, maxTokens: 200
  });
}

/* ── 收一张 ── */
let pendingFile = null;
function openUpload() {
  pendingFile = null;
  $("fileInput").value = ""; $("groupInput").value = "";
  $("preview").classList.add("hidden"); $("uploadStatus").textContent = "";
  $("uploadModal").classList.remove("hidden");
}
function closeUpload() { $("uploadModal").classList.add("hidden"); }
$("fileInput").addEventListener("change", () => {
  pendingFile = $("fileInput").files[0] || null;
  const pv = $("preview");
  if (pendingFile) { pv.src = URL.createObjectURL(pendingFile); pv.classList.remove("hidden"); }
  else pv.classList.add("hidden");
});

async function doUpload() {
  const f = pendingFile;
  if (!f) { $("uploadStatus").textContent = "先选一张"; return; }
  const st = (t) => { $("uploadStatus").innerHTML = t; };
  $("uploadSend").disabled = true;
  try {
    st("算指纹…（同一张图只收一次）");
    const { hash } = await G.hashFile(f);
    const dup = ALL.find((x) => x.hash === hash);
    if (dup) {
      st("这张已经在记忆里了 —— 不重复收，直接打开它。");
      closeUpload(); openDetail(dup.id); return;
    }
    st("上传…（大图会压成看图版）");
    const sh = await G.shrink(f);
    const up = await G.uploadImage((sh && sh.blob) || f, f.name || "image.jpg", (sh && sh.mime) || f.type);
    const dataUrl = await G.dataUrl((sh && sh.blob) || f);

    /* 两条线并行跑，互不阻塞；收藏失败不影响图本身入库 */
    st("让 TA 看一眼…（一段客观描述 + 一句第一印象，两条线同时跑）");
    const [desc, imp] = await Promise.all([
      describeImage(dataUrl).catch(() => ""),
      impressionOf(dataUrl).catch(() => "")
    ]);
    const now = new Date().toISOString();
    const recData = {
      hash: hash, url: up.url, title: "", desc: String(desc || "").trim(),
      impression: String(imp || "").trim(), desc_state: desc ? "ok" : "pending",
      first_sent_at: "", send_count: 0, group: $("groupInput").value.trim(),
      created_at: now, w: (sh && sh.w) || 0, h: (sh && sh.h) || 0, mime: up.mime || f.type || ""
    };
    const saved = await G.kvSave(NS, recData, { type: "image", url: up.url, name: f.name || "image.jpg", mime: recData.mime });
    const local = rec({ id: saved.id, at: saved.at || now, url: up.url, mime: recData.mime, data: recData });
    G.mirrorUpsert(NS, local);
    ALL.unshift(local);

    st(desc ? "收好了。" : "图收好了，但描述没写出来（多半是模型看不了图 —— 去右上 ⚙ 换个能看图的）。");
    closeUpload();
    paintStats(); renderBoard(); renderRecent(); renderAlbums();
    openDetail(saved.id);
  } catch (e) {
    const m = String((e && e.message) || e);
    $("uploadStatus").innerHTML = "没收成：" + esc(m)
      + (/Failed to fetch|NetworkError/i.test(m) ? "（后端连不上：检查「云端后端地址」，以及 CORS）" : "");
  } finally { $("uploadSend").disabled = false; }
}

/* ── 改标题 / 补描述 / 删除 ── */
async function saveRecord(r, extra, ttl) {
  const data = Object.assign({}, {
    hash: r.hash, url: r.url, title: r.title, desc: r.desc, impression: r.impression,
    desc_state: r.desc_state, first_sent_at: r.first_sent_at, send_count: r.send_count,
    group: r.group, created_at: r.at, w: r.w, h: r.h, mime: r.mime
  }, extra || {});
  const saved = await G.kvReplace(r.id, NS, data, { type: "image", url: r.url, name: "image", mime: r.mime || "image/jpeg" });
  Object.assign(r, extra || {});
  r.id = saved.id;                       // 改一条 = 删旧存新，id 会变
  if (saved.at) r.at = saved.at;
  G.mirrorRemove(NS, r.id); G.mirrorUpsert(NS, r);
  const i = ALL.indexOf(r); if (i >= 0) ALL[i] = r;
  return saved;
}
async function rename() {
  if (!curRec) return;
  const v = prompt("给这张起个名字（最多 18 字）", curRec.title || "");
  if (v == null) return;
  const t = v.trim().slice(0, 18);
  try { await saveRecord(curRec, { title: t }); renderDetail(curRec); renderGrid(); renderBoard(); showToast("改好了"); }
  catch (e) { alert("改不动：" + ((e && e.message) || e)); }
}
async function retryDesc() {
  if (!curRec || !curRec.url) return;
  const btn = $("actRetry"); btn.disabled = true; btn.textContent = "正在看…";
  try {
    const blob = await (await fetch(imgUrl(curRec))).blob();
    const dataUrl = await G.dataUrl(blob);
    const [desc, imp] = await Promise.all([
      describeImage(dataUrl).catch(() => ""),
      curRec.impression ? Promise.resolve("") : impressionOf(dataUrl).catch(() => "")
    ]);
    if (!desc) throw new Error("模型没能描述这张图（可能看不了图，去右上 ⚙ 换一个）");
    await saveRecord(curRec, { desc: desc.trim(), desc_state: "ok", impression: (curRec.impression || imp || "").trim() });
    renderDetail(curRec); paintStats(); renderGrid();
  } catch (e) { alert("补描述失败：" + ((e && e.message) || e)); }
  finally { btn.disabled = false; btn.textContent = curRec && curRec.desc ? "重写描述" : "补描述"; }
}
async function delOne() {
  if (!curRec) return;
  if (!confirm("从记忆里删掉这张？图本身也会从后端删掉，不可恢复。")) return;
  try {
    try { await G.kvDel(curRec.id); } catch (_) { }
    G.mirrorRemove(NS, curRec.id);
    /* 图本体也清掉（后端没提供删除接口的话，这一步会被跳过 —— 如实说，不假装） */
    let bodyDel = false;
    try {
      const r = await fetch(G.base() + "/app/file/" + encodeURIComponent(String(curRec.url).split("/").pop()),
        { method: "DELETE", headers: G.headers() });
      bodyDel = r.ok;
    } catch (_) { }
    ALL = ALL.filter((x) => String(x.id) !== String(curRec.id));
    curRec = null;
    showToast(bodyDel ? "已删除" : "记录已删（图本体后端不支持删除，留在服务器上）");
    await loadList();
  } catch (e) { alert("删不掉：" + ((e && e.message) || e)); }
}
async function takeToChat() {
  if (!curRec) return;
  close();                            // 回聊天：关面板，不整页跳（原来这里是 location.assign("index.html")）
  if (typeof window.sendOneFile === "function") {
    try {
      const r = await fetch(G.fileUrl(curRec.url), { headers: G.headers() });
      const b = await r.blob();
      const f = new File([b], (curRec.title || "image") + ".jpg", { type: b.type || "image/jpeg" });
      window.sendOneFile(f);
    } catch (e) { showToast("发不过去：" + ((e && e.message) || e)); return; }
  } else { showToast("这条记录已就绪，回到聊天页可以直接用"); }
}
function showToast(m) {
  const el = $("listMsg");
  if (!el) return;
  el.textContent = m;
  el.classList.remove("hidden");
  setTimeout(() => { if (el.textContent === m) el.classList.add("hidden"); }, 2400);
}

/* ── ⚙ 模型 ── */
function paintCfg() {
  const cfg = G.modelCfg();
  $("cfgProvider").value = cfg.provider || "zhipu";
  $("cfgModel").value = cfg.model || "";
  const visionless = ["deepseek", "moonshot"].indexOf(cfg.provider) >= 0;
  $("cfgNote").innerHTML = visionless
    ? "⚠️ <b>" + esc(cfg.provider) + "</b> 这个位置的模型多半<b>看不了图</b>，描述会失败（图照收不误，只是「待补描述」）。看图建议用 <b>zhipu / glm-4v-plus</b> 或 <b>openai / gpt-4o</b>。"
    : "描述图片需要<b>能看图</b>的模型。当前走的是你自己的中转后端，前端不放 Key。";
}
$("gearBtn").onclick = () => { const b = $("cfgBox"); b.classList.toggle("hidden"); if (!b.classList.contains("hidden")) paintCfg(); };
$("cfgSave").onclick = () => {
  G.setModelCfg($("cfgProvider").value, $("cfgModel").value.trim() || "glm-4v-plus");
  showToast("模型已保存");
  $("cfgBox").classList.add("hidden");
};

/* ── 接线 ── */
let searchTimer = 0;
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const v = e.target.value.trim();
    if (v) enterGrid({ text: v, title: "搜索结果", noScroll: true }); else exitGrid();
  }, 180);
});
$("recentAll").onclick = () => enterGrid({ title: "全部" });
$("albumsAll").onclick = () => enterGrid({ title: "全部" });
$("gridBack").onclick = exitGrid;
$("drawBtn").onclick = randomOne;
$("upBtn").onclick = openUpload;
$("uploadClose").onclick = closeUpload;
$("uploadCancel").onclick = closeUpload;
$("uploadSend").onclick = doUpload;
$("uploadModal").addEventListener("click", (e) => { if (e.target === $("uploadModal")) closeUpload(); });
$("renameBtn").onclick = rename;
$("actZoom").onclick = openLightbox;
$("detailImg").onclick = openLightbox;
$("actRetry").onclick = retryDesc;
$("actDel").onclick = delOne;
$("actChat").onclick = takeToChat;
$("topBack").onclick = () => {
  if (!$("uploadModal").classList.contains("hidden")) { closeUpload(); return; }
  if (!views.list.classList.contains("hidden")) {
    if (!$("gridSec").classList.contains("hidden")) exitGrid(); else close();
  } else loadList();
};
$("gateHome").onclick = () => close();
$("gateSave").onclick = () => {
  const v = $("gateInput").value.trim();
  if (v) { localStorage.setItem("companion_secret", v); loadList(); }
};

/* 启动不再自动读 —— 面板是**按需打开**的，进来就读等于每次开机都打后端。
   open() 里再 loadList()。（原来这里是裸的 loadList()，因为那时整页就是相册。） */

/* 给聊天页/测试用的口子 */
window.Gallery = {
  state: () => ({ items: ALL, cloud: cloudOn }),
  reload: loadList,
  saveFile: async (file, opt) => {           // 聊天里「存进相册」走这个
    opt = opt || {};
    const { hash } = await G.hashFile(file);
    const dup = ALL.find((x) => x.hash === hash);
    if (dup) return { dup: true, rec: dup };
    const sh = await G.shrink(file);
    const up = await G.uploadImage((sh && sh.blob) || file, file.name || "image.jpg", (sh && sh.mime) || file.type);
    const dataUrl = await G.dataUrl((sh && sh.blob) || file);
    const [desc, imp] = await Promise.all([
      describeImage(dataUrl).catch(() => ""),
      opt.impression ? Promise.resolve(opt.impression) : impressionOf(dataUrl).catch(() => "")
    ]);
    const data = {
      hash: hash, url: up.url, title: (opt.title || "").slice(0, 18), desc: String(desc || "").trim(),
      impression: String(imp || "").trim(), desc_state: desc ? "ok" : "pending",
      first_sent_at: new Date().toISOString(), send_count: 1, group: "",
      created_at: new Date().toISOString(), w: (sh && sh.w) || 0, h: (sh && sh.h) || 0, mime: up.mime || file.type
    };
    const saved = await G.kvSave(NS, data, { type: "image", url: up.url, name: file.name || "image.jpg", mime: data.mime });
    const l = rec({ id: saved.id, at: saved.at, url: up.url, mime: data.mime, data: data });
    G.mirrorUpsert(NS, l); ALL.unshift(l);
    return { dup: false, rec: l };
  },
  textFor: (hash) => {                       // 复用：只给文字，不传像素
    const r = ALL.find((x) => x.hash === hash && x.desc);
    return r ? { title: r.title, desc: r.desc } : null;
  },
  _open: (id) => openDetail(id),                 // 给测试/截图用
  _internal: { describeImage, impressionOf, VISUAL_WORKER }
};

  /* ── 打开 / 关闭（整页面板，不进开屏、不整页跳转）────────────────────── */
  let openTimer = null;
  function open() {
    ensureDom();
    clearTimeout(openTimer);
    elScroll = $("albScroll");
    elPanel.classList.remove("hidden");
    requestAnimationFrame(() => elPanel.classList.add("open"));
    loadList();
  }
  function close() {
    if (!elPanel) return;
    elPanel.classList.remove("open");
    openTimer = setTimeout(() => {
      if (elPanel && !elPanel.classList.contains("open")) elPanel.classList.add("hidden");
    }, 280);
  }
  function isOpen() { return !!elPanel && !elPanel.classList.contains("hidden"); }

  window.openAlbum = open;
  window.closeAlbum = close;

  /* 供测试/截图用 */
  window.AlbumPanel = {
    open: open, close: close, isOpen: isOpen,
    reset: () => { ALL = []; curRec = null; show("list"); },
    _el: () => document.getElementById("albumPanel"),
    _render: () => show("list"),
    _internal: { describeImage, impressionOf, VISUAL_WORKER, FRAMES }
  };
})();
