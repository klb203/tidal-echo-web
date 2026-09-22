/* ══════════════════════════════════════════════════════════════════════════
   Tidal Echo · 记忆分层面板：世界书（Lorebook）+ 档案馆（事件盒）
   ══════════════════════════════════════════════════════════════════════════

   为什么单独成包，而不是接着写在 index.html 里
   ──────────────────────────────────────────────────────────────────────────
   这两页从"只读展示"变成了**编辑器**：世界书有十来个字段、事件盒有复活/归档/
   封盒/压缩四类结构操作。逻辑量翻了几倍，而 index.html 是 1MB 的单文件、
   在本环境里**没有浏览器可测** —— 塞进去就只能靠正则扫字符串兜底，
   而"表单字段连错、key 串了"这类错正则一个都抓不住。
   独立成包之后可以用假 DOM + 假 fetch 做真冒烟（见 smoke-memory-pack.js）。

   参考实现（两件都以它为准，不要按字面猜）
   ──────────────────────────────────────────────────────────────────────────
   · 世界书 → SullyOS `apps/WorldbookApp.tsx` + `utils/worldbook.ts`
       定义：「一组**按条件**提供给 AI 的补充设定…它不会自己发消息，
             也不等同于角色记忆。」→ 所以它是 Lorebook，不是聊天记录。
   · 档案馆 → SullyOS `utils/memoryPalace/types.ts` 的 EventBox
       时间线是"什么时候"，**事件盒是"哪一件事"**。

   ⚠️ 选择性逻辑的四个编号，**名字是反的**（SillyTavern 的历史包袱）。
      后端 worldbook.secondary_passes() 是唯一判据，这里只是照它写标签：
        0  any(hits)        次词中任意一个即可        （SullyOS 叫 AND_ANY）
        1  not all(hits)    次词并非全部命中          （叫 AND_ALL）
        2  not any(hits)    次词一个都不中            （叫 NOT_ANY）
        3  all(hits)        次词必须全部命中          （叫 NOT_ALL）
      别照名字理解语义 —— 照这四行。

   存储与口径
   ──────────────────────────────────────────────────────────────────────────
   世界书条目存在 memories 表 kind="lore"；事件盒存 kind="event_box"。
   六层的归属定义在后端 layers.py（唯一一处），前端不另列一份。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* ════════════════════════════ 宿主接缝 ════════════════════════════ */
  /* 每次 render 时解析一次，而不是在模块加载时抓死 —— 这样测试可以把
     window.__MEMORY_PACK_HOST 注入进来（生产里没人设它）。 */
  function hostApi() {
    const H = {};
    const grab = (k, expr) => { try { H[k] = expr(); } catch (_) { H[k] = null; } };
    grab("api", () => (typeof memApi === "function") ? memApi : null);
    grab("toast", () => (typeof showToast === "function") ? showToast : null);
    grab("esc", () => (typeof escapeHtml === "function") ? escapeHtml : null);
    grab("libItems", () => (typeof memData === "object" && memData) ? (memData.items || {}) : {});
    grab("layers", () => (typeof memData === "object" && memData) ? memData.layers : null);
    grab("libCounts", () => (typeof memData === "object" && memData) ? (memData.counts || {}) : {});
    grab("arcRender", () => (typeof arcRender === "function") ? arcRender : null);
    grab("reload", () => (typeof memLoad === "function") ? memLoad : null);
    grab("aiName", () => {
      if (typeof CONFIG === "object" && CONFIG && CONFIG.AI_NAME) return String(CONFIG.AI_NAME);
      return "";
    });
    try {
      const inj = (typeof window !== "undefined") ? window.__MEMORY_PACK_HOST : null;
      if (inj) Object.assign(H, inj);
    } catch (_) { }
    return H;
  }

  function esc(s) {
    const H = hostApi();
    if (H.esc) return H.esc(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(msg) {
    const H = hostApi();
    if (H.toast) { H.toast(msg); return; }
    try { console.log("[memory]", msg); } catch (_) { }
  }
  function api(path, opt) {
    const H = hostApi();
    if (!H.api) return Promise.reject(new Error("宿主没有提供 memApi —— 页面脚本没加载完？"));
    return H.api(path, opt);
  }
  const POST = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
  const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  const line = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

  /* 记忆库那八类（可以导进世界书的）。
     ★ 列表与中文名**以后端 /app/layers 为准**（layers.MEM_KINDS / KIND_LABEL）——
       前端这份只是"读不到 /app/layers"时的兜底。抄第二份定义的下场，
       这个项目已经踩过好几次（改一处漏一处）。 */
  const LIB_FALLBACK = ["event", "ref", "working", "summary", "story", "room", "letter", "fragment"];
  function libKinds() {
    const L = hostApi().layers;
    const k = L && L.library_kinds;
    return (Array.isArray(k) && k.length) ? k : LIB_FALLBACK;
  }
  function kindLabel(k) {
    const L = hostApi().layers;
    const m = (L && L.labels) || {};
    return m[k] || k;
  }

  /* 选择性逻辑 —— 语义照 worldbook.secondary_passes()，名字照 SillyTavern（是反的，别改） */
  const LOGIC = [
    { v: 0, label: "次词中任意一个即可", en: "AND_ANY" },
    { v: 1, label: "次词并非全部命中", en: "AND_ALL" },
    { v: 2, label: "次词一个都不中", en: "NOT_ANY" },
    { v: 3, label: "次词必须全部命中", en: "NOT_ALL" },
  ];

  /* ════════════════════════════ 世界书 ════════════════════════════ */
  const WB = {
    loaded: false, busy: false, err: "",
    items: [], stats: null, cats: [], posLabels: {}, posDesc: {}, roleLabels: {}, defaults: null,
    cat: "", edit: null,       // edit = 条目 id / "new" / null
    panel: "",                 // "" | "import" | "preview" | "fromlib"
    importText: "", preview: null, previewText: "", names: { char: "", user: "" },
    libPick: { room: true, letter: true },   // 默认勾"房间与留言"（它们是静态设定）
    libConst: true,                          // 导进来默认标成常驻
    /* ── 下面这四个是「照 SullyOS 摆」用的（WorldbookApp.tsx）────────────
       collapsed  哪几个分类被收起来了（默认全展开 —— 条目不多时展开更省事）
       openId     哪一条正在就地展开正文（SullyOS 的 previewBookId）
       selecting  多选模式开着没有（SullyOS 的 isSelecting）
       sel        勾了哪几条，键是条目 id（SullyOS 的 selectedBookIds） */
    collapsed: {}, openId: null, selecting: false, sel: {},
  };

  async function wbLoad() {
    WB.busy = true; WB.err = "";
    try {
      const d = await api("/app/worldbook");
      if (d && d.ok === false) throw new Error(d.error || "读不到世界书");
      WB.items = (d && d.items) || [];
      WB.stats = (d && d.stats) || null;
      WB.posLabels = (d && d.positionLabels) || {};
      WB.posDesc = (d && d.positionDescriptions) || {};
      WB.roleLabels = (d && d.roleLabels) || {};
      WB.cats = (d && d.presetCategories) || [];
      WB.defaults = (d && d.defaults) || null;
      WB.loaded = true;
      /* 名字只取一次：{{char}} / {{user}} 要展开成什么。用户可以在预览里改。 */
      if (!WB.names.char && WB.names.user === "") {
        WB.names.char = hostApi().aiName || "";
      }
    } catch (e) {
      WB.err = "读取失败：" + ((e && e.message) || e);
      WB.loaded = false;
    }
    WB.busy = false;
  }

  /* 分组列表：预设分组在前，其余的按出现顺序补在后面（不丢自定义分组） */
  function wbCats() {
    const seen = [];
    WB.cats.forEach((c) => { if (c && seen.indexOf(c) < 0) seen.push(c); });
    WB.items.forEach((b) => {
      const c = b.category || "";
      if (c && seen.indexOf(c) < 0) seen.push(c);
    });
    return seen;
  }
  function wbList() {
    let out = WB.items.slice();
    if (WB.cat) out = out.filter((b) => (b.category || "") === WB.cat);
    out.sort((a, b) => (num(a.order, 100) - num(b.order, 100)) ||
      String(a.title || "").localeCompare(String(b.title || "")));
    return out;
  }
  function wbById(id) {
    return WB.items.filter((b) => String(b.id) === String(id))[0] || null;
  }

  /* 新建时的草稿 —— 默认值全部取自后端（DEFAULTS），不在前端另写一份。
     ★ 这就是"默认值只能有一处"：后端改了默认位置，这里跟着变。 */
  function wbDraft() {
    const d = WB.defaults || {};
    return {
      id: "", title: "", content: "",
      category: WB.cat || (WB.cats[0] || "通用设定"),
      key: "", keysecondary: "",
      constant: true, selective: false, selectiveLogic: num(d.selectiveLogic, 0),
      order: num(d.order, 100), position: num(d.position, 1), disable: false,
      probability: num(d.probability, 100), useProbability: !!d.useProbability,
      depth: num(d.depth, 4), role: d.role == null ? 0 : num(d.role, 0),
      scanDepth: d.scanDepth == null ? 4 : num(d.scanDepth, 4),
      caseSensitive: !!d.caseSensitive, matchWholeWords: !!d.matchWholeWords,
    };
  }
  function wbToDraft(b) {
    const k = (v) => Array.isArray(v) ? v.join("，") : String(v == null ? "" : v);
    return {
      id: String(b.id || ""), title: b.title || "", content: b.content || "",
      category: b.category || "通用设定",
      key: k(b.key), keysecondary: k(b.keysecondary),
      constant: !!b.constant, selective: !!b.selective,
      selectiveLogic: num(b.selectiveLogic, 0), order: num(b.order, 100),
      position: num(b.position, 1), disable: !!b.disable,
      probability: num(b.probability, 100), useProbability: !!b.useProbability,
      depth: num(b.depth, 4), role: b.role == null ? 0 : num(b.role, 0),
      scanDepth: b.scanDepth == null ? 4 : num(b.scanDepth, 4),
      caseSensitive: b.caseSensitive === true, matchWholeWords: b.matchWholeWords === true,
    };
  }

  /* ── 渲染 ────────────────────────────────────────────────────────────── */
  function wbChipsHtml() {
    const cats = wbCats();
    const n = {};
    WB.items.forEach((b) => { const c = b.category || ""; n[c] = (n[c] || 0) + 1; });
    const one = (key, text, cnt) =>
      '<button type="button" class="mp-chip' + (WB.cat === key ? " hot" : "") +
      '" data-wb-cat="' + esc(key) + '">' + esc(text) + (cnt != null ? " · " + cnt : "") + "</button>";
    return '<div class="mp-chips">' + one("", "全部", WB.items.length) +
      cats.map((c) => one(c, c, n[c] || 0)).join("") + "</div>";
  }

  /* ── 按分类分组（SullyOS 是「一个分类一折，折起来只留标题行」）──────
     顺序就按条目自己的 order —— 分组内不再重排，免得和"顺序（小的先注入）"
     那个字段打架（那个字段管的是注入先后，不是列表长相）。 */
  function wbGroups() {
    const map = new Map();
    wbList().forEach((b) => {
      const c = String(b.category || "").trim() || "通用设定";
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(b);
    });
    return Array.from(map.entries()).map((kv) => ({ name: kv[0], items: kv[1] }));
  }

  function wbGroupHtml(g) {
    const off = !!WB.collapsed[g.name];
    return '<div class="wb-group">' +
      '<div class="wb-group-head" data-wb-gtog="' + esc(g.name) + '">' +
        '<span class="wb-caret">' + (off ? "▸" : "▾") + "</span>" +
        '<span class="wb-gname">' + esc(g.name) + "</span>" +
        '<span class="wb-gcount">' + g.items.length + " 条</span>" +
        '<button type="button" class="mp-mini" data-wb-gexport="' + esc(g.name) + '">导出</button>' +
      "</div>" +
      (off ? "" : '<div class="wb-group-body">' + g.items.map(wbCardHtml).join("") + "</div>") +
      "</div>";
  }

  async function wbBulkDelete() {
    const ids = Object.keys(WB.sel);
    if (!ids.length) { toast("先在条目上勾几条"); return; }
    if (!confirm("删除选中的 " + ids.length + " 条世界书条目？删掉就没了。")) return;
    let ok = 0;
    for (const id of ids) {
      try {
        const d = await POST("/app/worldbook/delete", { id: id });
        if (d && d.ok !== false) ok++;
      } catch (_) { }
    }
    toast("已删除 " + ok + " / " + ids.length + " 条");
    WB.sel = {}; WB.selecting = false;
    await wbLoad(); wbPaint();
  }

  async function wbDeleteOne(id) {
    const b = wbById(id);
    if (!b) return;
    if (!confirm("删除「" + (b.title || "（无标题）") + "」？")) return;
    try {
      const d = await POST("/app/worldbook/delete", { id: String(id) });
      if (d && d.ok === false) throw new Error(d.error || "删除失败");
      toast("已删除");
      if (WB.edit === String(id)) { WB.edit = null; WB.editDraft = null; }
      await wbLoad(); wbPaint();
    } catch (e) { toast("删除失败：" + ((e && e.message) || e)); }
  }

  function wbCardHtml(b) {
    const id = String(b.id);
    const hot = [];
    if (b.constant) hot.push('<span class="mp-chip hot">常驻</span>');
    else {
      const ks = Array.isArray(b.key) ? b.key : [];
      hot.push('<span class="mp-chip hot">关键词 ' + esc(ks.slice(0, 2).join("/")) +
        (ks.length > 2 ? " +" + (ks.length - 2) : "") + "</span>");
    }
    if (b.disable) hot.push('<span class="mp-chip off">已停用</span>');
    const pos = WB.posLabels[String(b.position)] || ("位置 " + b.position);
    const open = WB.openId === id;
    const picked = !!WB.sel[id];
    /* 点卡片主体 = 就地展开正文（SullyOS 的 togglePreview），进编辑要点「编辑」按钮。
       ★ data-wb-open 仍然挂在那个「编辑」按钮上 —— 冒烟测试就是靠它定位条目的。 */
    return '<div class="arc-entry mp-item wb-item' + (WB.edit === id ? " on" : "") +
      (picked ? " sel" : "") + '" data-wb-prev="' + esc(id) + '">' +
      '<div class="wb-top">' +
        (WB.selecting ? '<input type="checkbox" class="wb-pick" data-wb-pick="' + esc(id) + '"' +
          (picked ? " checked" : "") + ">" : "") +
        '<div class="mp-item-t">' + esc(b.title || "（无标题）") + "</div>" +
        '<span class="wb-caret">' + (open ? "▾" : "▸") + "</span>" +
      "</div>" +
      '<div class="mp-chips">' + hot.join("") +
      '<span class="mp-chip">' + esc(b.category || "") + "</span>" +
      '<span class="mp-chip">' + esc(pos) + "</span>" +
      '<span class="mp-chip">顺序 ' + esc(String(b.order)) + "</span>" +
      "</div>" +
      (open
        ? '<div class="wb-body">' + (b.content ? esc(b.content) : "（这条还没有正文）") + "</div>"
        : (b.content ? '<div class="mp-item-s">' + esc(b.content) + "</div>" : "")) +
      '<div class="wb-acts">' +
        '<button type="button" class="mp-mini" data-wb-open="' + esc(id) + '">编辑</button>' +
        '<button type="button" class="mp-mini" data-wb-qr="' + esc(id) + '">条码</button>' +
        (WB.selecting ? "" : '<button type="button" class="mp-mini" data-wb-del-one="' + esc(id) + '">删除</button>') +
      "</div>" +
      "</div>";
  }

  function wbEditorHtml() {
    const d = WB.edit === "new" ? wbDraft() : (WB.editDraft || wbDraft());
    const opt = (v, t, cur) => '<option value="' + esc(String(v)) + '"' +
      (String(cur) === String(v) ? " selected" : "") + ">" + esc(t) + "</option>";
    const roles = Object.keys(WB.roleLabels || {});
    return '<div class="arc-back"><button type="button" class="mp-mini" data-wb-back="1">‹ 返回</button>' +
      '<span class="mp-item-t">' + (WB.edit === "new" ? "新建世界书条目" : "编辑条目") + "</span></div>" +
      '<div class="mp-form">' +
      '<div class="mp-row"><label>标题</label><input type="text" data-wbf="title" value="' +
        esc(d.title) + '" placeholder="给它起个名字"></div>' +
      '<div class="mp-row"><label>正文（这就是会被注入的内容）</label>' +
        '<textarea data-wbf="content" placeholder="例：{{char}} 住在海边一间朝东的小屋，窗台上有盆薄荷。">' +
        esc(d.content) + "</textarea></div>" +
      '<div class="mp-form2">' +
      '<div class="mp-row"><label>分组</label><input type="text" data-wbf="category" list="wbCatList" value="' +
        esc(d.category) + '">' +
        '<datalist id="wbCatList">' + wbCats().map((c) => '<option value="' + esc(c) + '">').join("") +
        "</datalist></div>" +
      '<div class="mp-row"><label>顺序（小的先注入）</label><input type="number" data-wbf="order" value="' +
        esc(String(d.order)) + '"></div>' +
      "</div>" +
      '<div class="mp-row"><label>主关键词（逗号分隔；<b>留空 = 常驻</b>）</label>' +
        '<input type="text" data-wbf="key" value="' + esc(d.key) + '" placeholder="例：薄荷、小屋"></div>' +
      '<label class="mp-check"><input type="checkbox" data-wbf="constant"' +
        (d.constant ? " checked" : "") + ">始终生效（常驻，不等关键词）</label>" +
      '<div class="mp-row"><label>次关键词（可留空）</label>' +
        '<input type="text" data-wbf="keysecondary" value="' + esc(d.keysecondary) + '"></div>' +
      '<div class="mp-row"><label>次关键词的逻辑</label><select data-wbf="selectiveLogic">' +
        LOGIC.map((x) => opt(x.v, x.label + "（" + x.en + "）", d.selectiveLogic)).join("") +
        "</select></div>" +
      '<div class="mp-form2">' +
      '<div class="mp-row"><label>注入位置</label><select data-wbf="position">' +
        Object.keys(WB.posLabels).map((k) => opt(k, WB.posLabels[k], d.position)).join("") +
        "</select></div>" +
      '<div class="mp-row"><label>深度（位置=聊天记录时）</label><input type="number" data-wbf="depth" value="' +
        esc(String(d.depth)) + '"></div>' +
      "</div>" +
      '<div class="mp-form2">' +
      '<div class="mp-row"><label>以谁的身份插入</label><select data-wbf="role">' +
        roles.map((k) => opt(k, (WB.roleLabels[k] || k) + (String(k) === "0" ? "（推荐）" : ""), d.role)).join("") +
        "</select></div>" +
      '<div class="mp-row"><label>扫描最近几条</label><input type="number" data-wbf="scanDepth" value="' +
        esc(String(d.scanDepth)) + '"></div>' +
      "</div>" +
      '<div class="mp-form2">' +
      '<div class="mp-row"><label>触发概率 %</label><input type="number" data-wbf="probability" value="' +
        esc(String(d.probability)) + '"></div>' +
      '<label class="mp-check"><input type="checkbox" data-wbf="useProbability"' +
        (d.useProbability ? " checked" : "") + ">按概率触发</label>" +
      "</div>" +
      '<div class="mp-form2">' +
      '<label class="mp-check"><input type="checkbox" data-wbf="caseSensitive"' +
        (d.caseSensitive ? " checked" : "") + ">区分大小写</label>" +
      '<label class="mp-check"><input type="checkbox" data-wbf="matchWholeWords"' +
        (d.matchWholeWords ? " checked" : "") + ">整词匹配</label>" +
      "</div>" +
      '<label class="mp-check"><input type="checkbox" data-wbf="disable"' +
        (d.disable ? " checked" : "") + ">停用这条（保留内容，不参与注入）</label>" +
      '<div class="mp-hint" id="wbPosHint">' + esc(WB.posDesc[String(d.position)] || "") + "</div>" +
      "</div>" +
      '<div class="mp-acts">' +
      '<button type="button" class="mp-btn primary" data-wb-save="1">保存</button>' +
      '<button type="button" class="mp-btn" data-wb-back="1">取消</button>' +
      (WB.edit === "new" ? "" : '<button type="button" class="mp-btn danger" data-wb-del="1">删除</button>') +
      "</div>";
  }

  function wbPanelHtml() {
    if (WB.panel === "import") {
      return '<div class="mp-row" style="margin-top:12px"><label>粘贴世界书 JSON（标准格式，和别处做的可以互导）</label>' +
        '<textarea data-wb-importbox="1" placeholder=\'{"entries":{"0":{"key":["薄荷"],"content":"…"}}}\'>' +
        esc(WB.importText) + "</textarea></div>" +
        '<div class="mp-acts"><button type="button" class="mp-btn primary" data-wb-import="1">导入</button>' +
        '<button type="button" class="mp-btn" data-wb-panel-close="1">取消</button></div>';
    }
    if (WB.panel === "preview") {
      const p = WB.preview;
      let out = '<div class="mp-row" style="margin-top:12px"><label>拿一段最近的话试试，看哪些条目会命中</label>' +
        '<textarea data-wb-prevbox="1" placeholder="例：今天窗台的薄荷长得很好">' + esc(WB.previewText) + "</textarea></div>" +
        '<div class="mp-form2">' +
        '<div class="mp-row"><label>它叫什么（{{char}}）</label><input type="text" data-wb-char="1" value="' +
          esc(WB.names.char) + '"></div>' +
        '<div class="mp-row"><label>你叫什么（{{user}}）</label><input type="text" data-wb-user="1" value="' +
          esc(WB.names.user) + '"></div>' +
        "</div>" +
        '<div class="mp-acts"><button type="button" class="mp-btn primary" data-wb-preview="1">试一下</button>' +
        '<button type="button" class="mp-btn" data-wb-panel-close="1">收起</button></div>';
      if (p) {
        const by = p.bySection || {};
        out += '<div class="mp-kv">' + Object.keys(by).map((k) =>
          "<div><b>" + by[k] + "</b><span>" + esc(k) + "</span></div>").join("") + "</div>";
        out += (p.hits && p.hits.length)
          ? p.hits.map((h) => '<div class="arc-entry"><div class="mp-item-t">' + esc(h.title || h.id) + "</div>" +
              '<div class="mp-chips"><span class="mp-chip hot">' + esc(h.positionLabel || "") + "</span>" +
              '<span class="mp-chip">' + esc(h.category || "") + "</span>" +
              '<span class="mp-chip">顺序 ' + esc(String(h.order)) + "</span>" +
              (h.constant ? '<span class="mp-chip">常驻</span>' : "") + "</div>" +
              '<div class="mp-item-s">' + esc(h.content) + "</div></div>").join("")
          : '<div class="arc-empty">这一段话没有命中任何条目。<br>' +
            "常驻的那几条不算命中 —— 它们每轮都在。</div>";
        const ren = p.rendered || {};
        Object.keys(ren).forEach((k) => {
          out += '<div class="mp-sec"><div class="mp-sec-h">' + esc(k) + "</div>" +
            '<div class="mp-pre">' + esc(ren[k]) + "</div></div>";
        });
      }
      return out;
    }
    if (WB.panel === "fromlib") {
      /* 把记忆库那八个分区**复制**成世界书条目 —— 用户要的"归类为世界书"就是这条。
         默认只勾「我的房间」「留给西西的话」：那两类回答的是"它住在什么样的地方 /
         它想对 TA 说什么"，是**静态设定**，本来就该在世界书里；
         其余六类（事件/摘要/故事/片段/参考资料/工作记忆）要用户自己决定 ——
         它们是"记忆"，硬塞进世界书会让每轮上下文变长（而且白花钱）。 */
      const C = hostApi().libCounts || {};
      const ks = libKinds();
      const rows = ks.map((k) => {
        const n = num(C[k], 0);
        const on = WB.libPick[k] ? " checked" : "";
        return '<label class="mp-check"' + (n ? "" : ' style="opacity:.55"') +
          '><input type="checkbox" data-wb-libpick="' + esc(k) + '"' + on + ">" +
          esc(kindLabel(k)) + " · " + n + " 条</label>";
      }).join("");
      const picked = ks.filter((k) => WB.libPick[k]).length;
      return '<div class="mp-note" style="margin-top:12px">' +
        "把记忆库的分区<b>复制</b>一份成世界书条目（记忆库那边一条都不动）。" +
        "导进来的就是普通条目 —— 能改正文、能设关键词、能设位置、能设成常驻。<br>" +
        "同一条只会导一次，反复点不会灌重复。</div>" +
        '<div class="mp-chips" style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px">' +
        rows + "</div>" +
        '<label class="mp-check" style="margin-top:11px"><input type="checkbox" data-wb-libconst="1"' +
        (WB.libConst ? " checked" : "") + ">导进来标成常驻（每轮都在上下文里）</label>" +
        '<div class="mp-hint">不勾的话：「我的房间」「留给西西的话」仍然常驻，' +
        "其余按关键词 —— 前者是「一直在那儿」的设定，后者要等说到才需要。</div>" +
        '<div class="mp-acts">' +
        '<button type="button" class="mp-btn primary" data-wb-fromlib-go="1">导入选中的 ' +
        picked + " 类</button>" +
        '<button type="button" class="mp-btn" data-wb-fromlib-all="1">全选</button>' +
        '<button type="button" class="mp-btn" data-wb-panel-close="1">取消</button>' +
        "</div>";
    }
    return "";
  }

  function wbHtml() {
    const st = WB.stats || {};
    if (WB.err) {
      return '<section class="mg-card"><div class="mg-head"><div>' +
        '<div class="mg-title">世界书</div>' +
        '<div class="mg-sub">手写的补充设定 · 命中了才进上下文</div></div></div>' +
        '<div class="arc-empty">' + esc(WB.err) + "</div>" +
        '<div class="mp-acts"><button type="button" class="mp-btn" data-wb-reload="1">重试</button></div></section>';
    }
    if (!WB.loaded) {
      return '<section class="mg-card"><div class="mg-head"><div>' +
        '<div class="mg-title">世界书</div>' +
        '<div class="mg-sub">手写的补充设定 · 命中了才进上下文</div></div></div>' +
        '<div class="arc-empty">读取中…</div></section>';
    }
    const head = '<section class="mg-card"><div class="mg-head"><div>' +
      '<div class="mg-title">世界书</div>' +
      '<div class="mg-sub">手写的补充设定 · 不等关键词就不会进上下文</div></div>' +
      '<span class="mg-tag">' + num(st.total, 0) + " 条</span></div>" +
      '<div class="mp-kv">' +
      "<div><b>" + num(st.constant, 0) + "</b><span>常驻</span></div>" +
      "<div><b>" + num(st.keyword, 0) + "</b><span>按关键词</span></div>" +
      "<div><b>" + num(st.chars, 0).toLocaleString("en-US") + "</b><span>总字数</span></div>" +
      "</div>" +
      '<div class="mp-acts">' +
      '<button type="button" class="mp-btn primary" data-wb-new="1">新建条目</button>' +
      '<button type="button" class="mp-btn" data-wb-preview-open="1">命中预览</button>' +
      '<button type="button" class="mp-btn" data-wb-import-open="1">导入</button>' +
      '<button type="button" class="mp-btn" data-wb-export="1">导出</button>' +
      '<button type="button" class="mp-btn primary" data-wb-fromlib-open="1">从记忆库导入</button>' +
      '<button type="button" class="mp-btn" data-wb-reload="1">刷新</button>' +
      "</div>" +
      '<div class="mp-note" style="margin-top:12px">这里放的是<b>你自己写</b>的设定 —— ' +
      "世界观、人物关系、地点、规则。「我的房间」「留给西西的话」也属于这一层" +
      "（它们回答的是「它住在什么样的地方 / 它想对 TA 说什么」，不是「发生过什么事」）。" +
      "<br>按关键词命中的条目<b>只在那几轮</b>进上下文；留空关键词的就是常驻。" +
      "<br>下面那一叠是<b>记忆库的分区</b>（事件 / 摘要 / 故事 / 片段 / 参考资料 / " +
      "工作记忆 / 我的房间 / 留给西西的话）—— 在这里也能看、也能改。" +
      "想把它们变成世界书条目，用上面的「从记忆库导入」。</div>" +
      wbPanelHtml() +
      "</section>";
    if (WB.edit) {
      return head + '<section class="mg-card" style="margin-top:14px">' + wbEditorHtml() + "</section>";
    }
    const list = wbList();
    const groups = wbGroups();
    const selN = Object.keys(WB.sel).length;
    return head +
      '<section class="mg-card" style="margin-top:14px"><div class="mg-head"><div>' +
      '<div class="mg-title">' + (WB.cat ? esc(WB.cat) : "全部条目") + "</div>" +
      '<div class="mg-sub">' + list.length + " 条 · " +
        (WB.cat ? "按顺序排" : groups.length + " 个分类") + "</div></div>" +
      (WB.selecting ? '<span class="mg-tag">已选 ' + selN + "</span>" : "") + "</div>" +
      /* 多选那套（SullyOS 的 isSelecting / selectedBookIds / confirmBulkDelete）：
         平时只留一个「选择」按钮，进了选择模式才出现全选与删除 —— 免得误删。 */
      '<div class="mp-acts" style="margin-top:10px">' +
      (WB.selecting
        ? '<button type="button" class="mp-btn" data-wb-sel-all="1">全选 / 清空</button>' +
          '<button type="button" class="mp-btn danger" data-wb-bulk-del="1">删除选中</button>' +
          '<button type="button" class="mp-btn" data-wb-sel-mode="1">退出选择</button>'
        : '<button type="button" class="mp-btn" data-wb-sel-mode="1">选择</button>' +
          (WB.cat ? "" : '<button type="button" class="mp-btn" data-wb-collapse="1">全部收起 / 展开</button>')) +
      "</div>" +
      wbChipsHtml() +
      (list.length
        ? '<div style="margin-top:10px">' +
            (WB.cat ? list.map(wbCardHtml).join("") : groups.map(wbGroupHtml).join("")) +
          "</div>"
        : '<div class="arc-empty">这里还是空的 —— ' +
          "世界书放的是<b>你自己写</b>的设定，它不会自己长出来。<br><br>" +
          "两条路：点「<b>新建条目</b>」手写一条；或者点「<b>从记忆库导入</b>」，" +
          "把下面那些分区（我的房间 / 留给西西的话 / 事件 …）复制一份过来，" +
          "再改成你想要的写法。</div>") +
      "</section>";
  }

  function wbPaint() {
    const host = document.getElementById("memWbMount");
    if (!host) return;
    host.innerHTML = wbHtml();
  }

  /* ── 读表单 / 保存 / 操作 ───────────────────────────────────────────── */
  function wbReadForm() {
    const host = document.getElementById("memWbMount");
    if (!host) return null;
    const g = (k) => { const el = host.querySelector('[data-wbf="' + k + '"]'); return el ? el.value : ""; };
    const c = (k) => { const el = host.querySelector('[data-wbf="' + k + '"]'); return el ? !!el.checked : false; };
    const key = g("key").trim();
    const key2 = g("keysecondary").trim();
    return {
      id: WB.edit === "new" ? "" : String(WB.edit || ""),
      title: g("title").trim(),
      content: g("content"),
      category: g("category").trim() || "通用设定",
      // 关键词串 → 数组：交给后端 split_keywords 归一（前端不再自己切一遍）
      key: key,
      keysecondary: key2,
      constant: c("constant") || !key,
      /* ★ selective 是"要不要看次关键词"。判定就是"**填了**次关键词" ——
         和后端 normalize 的默认值同一条规则（keysecondary 非空就启用）。
         写成一个独立开关的话，界面会出现"填了次词却不生效"这种哑状态。 */
      selective: !!key2,
      selectiveLogic: num(g("selectiveLogic"), 0),
      order: num(g("order"), 100),
      position: num(g("position"), 1),
      disable: c("disable"),
      probability: num(g("probability"), 100),
      useProbability: c("useProbability"),
      depth: num(g("depth"), 4),
      role: num(g("role"), 0),
      scanDepth: num(g("scanDepth"), 4),
      caseSensitive: c("caseSensitive"),
      matchWholeWords: c("matchWholeWords"),
    };
  }

  async function wbSave() {
    const item = wbReadForm();
    if (!item) return;
    if (!String(item.content || "").trim()) { toast("正文不能为空"); return; }
    WB.busy = true;
    try {
      const d = await POST("/app/worldbook/save", { item: item });
      if (!d || d.ok === false) throw new Error((d && d.error) || "保存失败");
      toast("已保存");
      WB.edit = null; WB.editDraft = null;
      await wbLoad(); wbPaint();
    } catch (e) {
      toast("保存失败：" + ((e && e.message) || e));
    }
    WB.busy = false;
  }

  async function wbDelete() {
    if (WB.edit === "new" || !WB.edit) return;
    if (typeof confirm === "function" && !confirm("删掉这条世界书？\n它不会把聊天里的记忆也删掉。")) return;
    try {
      const d = await POST("/app/worldbook/delete", { id: WB.edit });
      if (!d || d.ok === false) throw new Error((d && d.error) || "删除失败");
      toast("已删除");
      WB.edit = null; WB.editDraft = null;
      await wbLoad(); wbPaint();
    } catch (e) { toast("删除失败：" + ((e && e.message) || e)); }
  }

  async function wbMigrate() {
    if (typeof confirm === "function" &&
      !confirm("把记忆库里的「我的房间」「留给西西的话」复制成世界书条目？\n" +
        "会标成常驻（一直在上下文里）。记忆库那两张卡留着不动。")) return;
    try {
      const d = await POST("/app/worldbook/migrate", {});
      toast("拉进来 " + num(d && d.made, 0) + " 条" + (num(d && d.skipped, 0) ? "（跳过 " + d.skipped + " 条已有的）" : ""));
      await wbLoad(); wbPaint();
    } catch (e) { toast("迁移失败：" + ((e && e.message) || e)); }
  }

  async function wbExport(cat) {
    /* cat 为真是"导出这个分组"（SullyOS 的 handleExportGroup）；不传就用当前的筛选 */
    const only = (cat != null && String(cat) !== "") ? String(cat) : WB.cat;
    try {
      const d = await api("/app/worldbook/export" + (only ? ("?category=" + encodeURIComponent(only)) : ""));
      if (!d || !d.content) throw new Error("没有可导出的内容");
      const name = d.filename || "worldbook.json";
      try {
        const blob = new Blob([d.content], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch (_) { } }, 1200);
        toast("已导出 " + name);
      } catch (_) {
        // 下载被拦（某些 WebView）→ 退到剪贴板
        try { await navigator.clipboard.writeText(d.content); toast("已复制到剪贴板"); }
        catch (__) { toast("导出失败：这个浏览器不让下载也不让复制"); }
      }
    } catch (e) { toast("导出失败：" + ((e && e.message) || e)); }
  }

  async function wbImport() {
    const host = document.getElementById("memWbMount");
    const box = host && host.querySelector("[data-wb-importbox]");
    const raw = box ? box.value : WB.importText;
    if (!String(raw || "").trim()) { toast("先粘一段 JSON 进来"); return; }
    try {
      const d = await POST("/app/worldbook/import", { content: raw, category: WB.cat || "" });
      if (!d || d.ok === false) throw new Error((d && d.error) || "导入失败");
      toast("导入 " + num(d.imported, 0) + " 条" + (num(d.failed, 0) ? "，失败 " + d.failed : ""));
      WB.panel = ""; WB.importText = "";
      await wbLoad(); wbPaint();
    } catch (e) { toast("导入失败：" + ((e && e.message) || e)); }
  }

  async function wbFromLib() {
    const kinds = libKinds().filter((k) => WB.libPick[k]);
    if (!kinds.length) { toast("一类都没勾 —— 先勾上要导的（比如「我的房间」）"); return; }
    WB.busy = true;
    try {
      const d = await POST("/app/worldbook/from-library",
        { kinds: kinds, constant: !!WB.libConst });
      if (!d || d.ok === false) throw new Error((d && d.error) || "导入失败");
      toast("导进 " + num(d.made, 0) + " 条" +
        (num(d.skipped, 0) ? "（跳过 " + d.skipped + " 条已导过的）" : ""));
      WB.panel = "";
      await wbLoad();
      wbPaint();
      /* 顺手让宿主重读一次记忆库 —— 分区卡的副标题（共 N 条）跟着刷新。
         ★ 导完**不**动记忆库的数据（那是复制），但分栏上的计数要跟当前状态一致。 */
      const H = hostApi();
      if (H.reload) { try { await H.reload(); } catch (_) { } }
    } catch (e) {
      toast("导入失败：" + ((e && e.message) || e));
    }
    WB.busy = false;
  }

  /* 勾选只改按钮上那个数字，**不重绘整个面板** ——
     重绘会把刚勾的 checkbox 洗掉（用户的勾选状态在 DOM 里，不在 WB 里）。 */
  function wbFromLibCount() {
    const host = document.getElementById("memWbMount"); if (!host) return;
    const btn = host.querySelector("[data-wb-fromlib-go]");
    if (btn) btn.textContent = "导入选中的 " + libKinds().filter((k) => WB.libPick[k]).length + " 类";
  }

  async function wbPreview() {
    const host = document.getElementById("memWbMount");
    const box = host && host.querySelector("[data-wb-prevbox]");
    const ch = host && host.querySelector("[data-wb-char]");
    const us = host && host.querySelector("[data-wb-user]");
    const text = box ? box.value : "";
    WB.previewText = text;
    if (ch) WB.names.char = ch.value.trim();
    if (us) WB.names.user = us.value.trim();
    if (!String(text || "").trim()) { toast("先写一段话"); return; }
    try {
      WB.preview = await POST("/app/worldbook/preview",
        { text: text, char: WB.names.char, user: WB.names.user });
      wbPaint();
    } catch (e) { toast("预览失败：" + ((e && e.message) || e)); }
  }

  /* 位置下拉变了 → 只更新那行提示，不重绘整个表单（否则正在输入的东西会丢） */
  function wbPosHint() {
    const host = document.getElementById("memWbMount"); if (!host) return;
    const sel = host.querySelector('[data-wbf="position"]');
    const hint = host.querySelector("#wbPosHint");
    if (sel && hint) hint.textContent = WB.posDesc[String(sel.value)] || "";
  }

  /* ── 事件绑定（挂在挂载点上，只挂一次）──────────────────────────────── */
  function wbBind() {
    const host = document.getElementById("memWbMount");
    if (!host || host.dataset.bound) return;
    host.dataset.bound = "1";
    host.addEventListener("change", (e) => {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches('[data-wbf="position"]')) { wbPosHint(); return; }
      /* 导入面板的勾选：只记状态（+更新按钮上那个数字），不重绘 —— 见 wbFromLibCount */
      if (t.matches("[data-wb-libpick]")) {
        WB.libPick[t.dataset.wbLibpick] = !!t.checked;
        wbFromLibCount();
        return;
      }
      if (t.matches("[data-wb-libconst]")) { WB.libConst = !!t.checked; return; }
      /* 多选：勾选状态记在 WB.sel，重绘一次把「已选 N」和卡片描边同步上 */
      if (t.matches("[data-wb-pick]")) {
        const id = String(t.dataset.wbPick || "");
        if (!id) return;
        if (t.checked) WB.sel[id] = true; else delete WB.sel[id];
        wbPaint();
        return;
      }
    });
    host.addEventListener("click", async (e) => {
      const t = e.target;
      const hit = (sel) => t.closest(sel);
      try {
        if (hit("[data-wb-reload]")) { await wbLoad(); wbPaint(); return; }
        if (hit("[data-wb-new]")) { WB.edit = "new"; WB.editDraft = wbDraft(); wbPaint(); return; }
        if (hit("[data-wb-back]")) { WB.edit = null; WB.editDraft = null; wbPaint(); return; }
        if (hit("[data-wb-save]")) { await wbSave(); return; }
        if (hit("[data-wb-del]")) { await wbDelete(); return; }
        if (hit("[data-wb-cat]")) { WB.cat = hit("[data-wb-cat]").dataset.wbCat || ""; wbPaint(); return; }
        /* 勾选框自己会冒泡成"点卡片" —— 先让开，交给上面那个 change */
        if (t.matches && t.matches("[data-wb-pick]")) return;
        if (hit("[data-wb-gtog]")) {
          const c = hit("[data-wb-gtog]").dataset.wbGtog || "";
          WB.collapsed[c] = !WB.collapsed[c]; wbPaint(); return;
        }
        if (hit("[data-wb-gexport]")) {
          e.stopPropagation();
          await wbExport(hit("[data-wb-gexport]").dataset.wbGexport || "");
          return;
        }
        if (hit("[data-wb-collapse]")) {
          const anyOpen = wbGroups().some((g) => !WB.collapsed[g.name]);
          wbGroups().forEach((g) => { WB.collapsed[g.name] = anyOpen; });
          wbPaint(); return;
        }
        if (hit("[data-wb-sel-mode]")) {
          WB.selecting = !WB.selecting;
          if (!WB.selecting) WB.sel = {};
          wbPaint(); return;
        }
        if (hit("[data-wb-sel-all]")) {
          const all = wbList();
          const on = Object.keys(WB.sel).length < all.length;
          WB.sel = {};
          if (on) all.forEach((b) => { WB.sel[String(b.id)] = true; });
          wbPaint(); return;
        }
        if (hit("[data-wb-bulk-del]")) { await wbBulkDelete(); return; }
        if (hit("[data-wb-del-one]")) {
          e.stopPropagation();
          await wbDeleteOne(hit("[data-wb-del-one]").dataset.wbDelOne || "");
          return;
        }
        /* 条码：这一条编成二维码带走（扫出来就是标准 JSON，别处能认出它是什么） */
        if (hit("[data-wb-qr]")) {
          e.stopPropagation();
          const b = wbById(hit("[data-wb-qr]").dataset.wbQr);
          if (b && window.Barcode) {
            window.Barcode.show(window.Barcode.fromWorldbook(b),
              { title: (b.title || "世界书条目"), note: "分组：" + (b.category || "通用设定") });
          } else {
            toast("条码模块没加载 —— 刷新一次页面");
          }
          return;
        }
        if (hit("[data-wb-panel-close]")) { WB.panel = ""; WB.preview = null; wbPaint(); return; }
        if (hit("[data-wb-import-open]")) { WB.panel = WB.panel === "import" ? "" : "import"; wbPaint(); return; }
        if (hit("[data-wb-preview-open]")) {
          WB.panel = WB.panel === "preview" ? "" : "preview"; wbPaint(); return;
        }
        if (hit("[data-wb-fromlib-open]")) {
          WB.panel = WB.panel === "fromlib" ? "" : "fromlib";
          /* 打开时把"有没有东西可导"摆在明面：一条都没有的类别变淡（见面板里那行） */
          wbPaint(); return;
        }
        if (hit("[data-wb-fromlib-all]")) {
          libKinds().forEach((k) => { WB.libPick[k] = true; });
          wbPaint(); return;
        }
        if (hit("[data-wb-fromlib-go]")) { await wbFromLib(); return; }
        if (hit("[data-wb-import]")) { await wbImport(); return; }
        if (hit("[data-wb-preview]")) { await wbPreview(); return; }
        if (hit("[data-wb-export]")) { await wbExport(); return; }
        if (hit("[data-wb-migrate]")) { await wbMigrate(); return; }
        const op = hit("[data-wb-open]");
        if (op) {
          const b = wbById(op.dataset.wbOpen);
          // ★ 先把表单里的值存起来？不 —— 点开是**进入**编辑，不会丢未保存的输入
          WB.edit = op.dataset.wbOpen;
          WB.editDraft = b ? wbToDraft(b) : null;
          wbPaint(); return;
        }
        /* ★ 放在所有按钮之后：点「编辑」「删除」时 closest 先命中的是它们自己，
           不会跑到这里把卡片展开。点卡片主体才展开正文（SullyOS 的 togglePreview）。 */
        const pv = hit("[data-wb-prev]");
        if (pv) {
          const id = String(pv.dataset.wbPrev || "");
          WB.openId = (WB.openId === id) ? null : id;
          wbPaint(); return;
        }
      } catch (err) { toast("出错了：" + ((err && err.message) || err)); }
    });
  }

  /* ════════════════════════════ 档案馆 · 事件盒 ════════════════════════════ */
  const BX = {
    loaded: false, busy: false, err: "",
    boxes: [], stats: null, th: null, open: null, view: "boxes", renaming: null,
  };

  async function bxLoad() {
    BX.busy = true; BX.err = "";
    try {
      const d = await api("/app/archive/boxes");
      if (d && d.ok === false) throw new Error(d.error || "读不到事件盒");
      BX.boxes = (d && d.boxes) || [];
      BX.stats = (d && d.stats) || null;
      BX.th = (d && d.thresholds) || null;
      BX.loaded = true;
    } catch (e) {
      BX.err = "读取失败：" + ((e && e.message) || e);
      BX.loaded = false;
    }
    BX.busy = false;
  }

  function bxById(id) {
    return BX.boxes.filter((b) => String(b.id) === String(id))[0] || null;
  }
  /* 已经在某个盒里的节点 id —— 用来算"还有几条叙事没归盒" */
  function bxBound() {
    const s = {};
    BX.boxes.forEach((b) => {
      (b.live || []).forEach((x) => { s[String(x)] = 1; });
      (b.archived || []).forEach((x) => { s[String(x)] = 1; });
    });
    return s;
  }
  /* 事件盒的成员 kind —— **以后端 layers.NARRATIVE_KINDS 为准**（/app/layers 带下来）。
     这里那四个只是"还没读到 /app/layers"时的兜底。
     ★ 写这个兜底的时候我差点又抄成第二份定义 —— 那样改一处就漂，
       而"同一个概念多处实现"正是这一路在收的病（后端 test_layers 里有断言挡着，
       前端这份靠这条注释与 smoke 用例挡）。 */
  const NARRATIVE_FALLBACK = ["event", "story", "summary"];
  function narrativeKinds() {
    const L = hostApi().layers;
    const k = L && L.narrative_kinds;
    return (Array.isArray(k) && k.length) ? k : NARRATIVE_FALLBACK;
  }
  function bxLoose() {
    const items = hostApi().libItems || {};
    const bound = bxBound();
    const out = [];
    narrativeKinds().forEach((k) => {
      (items[k] || []).forEach((it) => {
        const id = String(it.id);
        if (!bound[id]) out.push(id);
      });
    });
    return out;
  }

  function bxSegHtml() {
    const one = (k, t) => '<button type="button"' + (BX.view === k ? ' class="on"' : "") +
      ' data-arc-view="' + k + '">' + t + "</button>";
    return '<div class="mp-seg">' + one("boxes", "事件盒") + one("timeline", "时间线") + "</div>";
  }

  function bxCardHtml(b) {
    const live = (b.live || []).length, gone = (b.archived || []).length;
    return '<button class="arc-card mp-box' + (b.sealed ? " sealed" : "") + '" type="button" data-bx-open="' +
      esc(String(b.id)) + '">' +
      '<span class="arc-badge">' + live + " 活 / " + gone + " 灰</span>" +
      '<span class="arc-ico">' + (b.sealed ? "▣" : "▢") + "</span>" +
      '<div class="mp-box-t">' + esc(b.name || "（无名）") + "</div>" +
      '<div class="mp-box-s">' + (b.sealed ? "已封盒 · " : "") +
      (b.summaryNodeId ? "含总结" : "还没压过") + " · " + (b.compressionCount || 0) + " 次压缩</div>" +
      "</button>";
  }

  function bxNodeHtml(nid, n, gone) {
    const n2 = n || {};
    return '<div class="mp-node' + (gone ? " gone" : "") + '">' +
      '<div class="mp-node-h">' +
      '<span class="mp-chip">' + esc(n2.kind || "") + "</span>" +
      '<div class="mp-node-t">' + esc(n2.title || line(n2.content, 40) || nid) + "</div>" +
      '<button type="button" class="mp-mini" data-bx-act="' + (gone ? "revive" : "archive") +
      '" data-bx-node="' + esc(String(nid)) + '">' + (gone ? "复活" : "归档") + "</button>" +
      "</div>" +
      (n2.content ? '<div class="mp-node-b">' + esc(line(n2.content, 220)) + "</div>" : "") +
      "</div>";
  }

  function bxSummaryHtml(b) {
    const s = b.summary;
    return '<div class="mp-note" style="margin-top:12px">' +
      "<b>总结</b>（活节点压成的一段；灰节点不参与召回，但可以复活）<br>" +
      (s ? esc(s) : "还没压过。活节点到 " + num((BX.th || {}).compress, 4) + " 条就该压一次。") +
      "</div>";
  }

  function bxDetailHtml(b) {
    const live = b.live || [], gone = b.archived || [];
    const nodes = b.nodes || {};
    return '<section class="mg-card">' +
      '<div class="arc-back"><button type="button" class="mp-mini" data-bx-back="1">‹ 返回</button>' +
      '<span class="mp-item-t">' + esc(b.name || "（无名）") + "</span>" +
      '<span class="mp-chip' + (b.sealed ? "" : " hot") + '">' + (b.sealed ? "已封盒" : "开着") + "</span></div>" +
      '<div class="mp-acts">' +
      '<button type="button" class="mp-btn primary" data-bx-act="compress">压缩成总结</button>' +
      '<button type="button" class="mp-btn" data-bx-act="' + (b.sealed ? "unseal" : "seal") + '">' +
        (b.sealed ? "解封" : "封盒") + "</button>" +
      '<button type="button" class="mp-btn" data-bx-rename="1">改名</button>' +
      '<button type="button" class="mp-btn danger" data-bx-del="1">删盒</button>' +
      "</div>" +
      bxSummaryHtml(b) +
      '<div class="mp-sec"><div class="mp-sec-h">活节点 ' + live.length + " 条（参与召回）</div>" +
      (live.length ? live.map((id) => bxNodeHtml(id, nodes[id], false)).join("")
        : '<div class="arc-empty">这个盒还没有活节点。</div>') + "</div>" +
      '<div class="mp-sec"><div class="mp-sec-h">灰节点 ' + gone.length + " 条（已压进总结，可复活）</div>" +
      (gone.length ? gone.map((id) => bxNodeHtml(id, nodes[id], true)).join("")
        : '<div class="arc-empty">没有灰节点。</div>') + "</div>" +
      "</section>";
  }

  function bxHtml() {
    if (BX.err) {
      return '<section class="mg-card"><div class="mg-head"><div><div class="mg-title">档案馆</div>' +
        '<div class="mg-sub">所有记忆 · 按事件盒存放</div></div></div>' +
        bxSegHtml() + '<div class="arc-empty">' + esc(BX.err) + "</div>" +
        '<div class="mp-acts"><button type="button" class="mp-btn" data-bx-reload="1">重试</button></div></section>';
    }
    if (!BX.loaded) {
      return '<section class="mg-card"><div class="mg-head"><div><div class="mg-title">档案馆</div>' +
        '<div class="mg-sub">所有记忆 · 按事件盒存放</div></div></div>' +
        bxSegHtml() + '<div class="arc-empty">读取中…</div></section>';
    }
    const st = BX.stats || {};
    const head = '<section class="mg-card"><div class="mg-head"><div>' +
      '<div class="mg-title">档案馆</div>' +
      '<div class="mg-sub">按<b>哪一件事</b>存放（时间线是"什么时候"）</div></div>' +
      '<span class="mg-tag">' + num(st.boxes, 0) + " 个盒</span></div>" +
      bxSegHtml() +
      '<div class="mp-kv">' +
      "<div><b>" + num(st.live, 0) + "</b><span>活节点</span></div>" +
      "<div><b>" + num(st.archived, 0) + "</b><span>灰节点</span></div>" +
      "<div><b>" + num(st.compressed, 0) + "</b><span>压过几次</span></div>" +
      "</div>" +
      '<div class="mp-acts">' +
      '<button type="button" class="mp-btn primary" data-bx-bind="1">把没归盒的收进来</button>' +
      '<button type="button" class="mp-btn" data-bx-new="1">新建空盒</button>' +
      '<button type="button" class="mp-btn" data-bx-reload="1">刷新</button>' +
      "</div>" +
      '<div class="mp-note" style="margin-top:12px">' +
      "同<b>一件事</b>的几条记忆收在同一个盒里 —— 「我们第一次去那家店」可能横跨三天、" +
      "散在五个分区，按月归档会把它切碎。<br>" +
      "活节点到 " + num((BX.th || {}).compress, 4) + " 条该压一次总结；" +
      "压过头就<b>封盒</b>，新相关的另开一个，盒里的东西召回照常。" +
      "</div></section>";
    if (BX.open) {
      const b = bxById(BX.open);
      if (b) return head + '<div style="margin-top:14px">' + bxDetailHtml(b) + "</div>";
      BX.open = null;
    }
    return head +
      (BX.boxes.length
        ? '<div class="arc-grid">' + BX.boxes.map(bxCardHtml).join("") + "</div>"
        : '<div class="arc-empty" style="margin-top:14px">还没有事件盒。<br>' +
          "点「把没归盒的收进来」，它会把事件 / 摘要 / 故事 / 片段按内容相近度收进盒里。</div>");
  }

  async function bxAct(act, node) {
    const b = bxById(BX.open);
    if (!b) return;
    if (act === "compress" && typeof confirm === "function" &&
      !confirm("把活节点压成一段总结？这要走一次模型（会花钱）。\n压过之后它们是灰节点，可以随时复活。")) return;
    BX.busy = true;
    try {
      if (act === "compress") {
        const d = await POST("/app/archive/box/compress", { id: b.id });
        if (!d || d.ok === false) throw new Error((d && d.error) || (d && d.message) || "压缩失败");
        toast("压好了" + (num(d.moved, 0) ? "，归档 " + d.moved + " 条" : ""));
      } else {
        const d = await POST("/app/archive/box/act", { id: b.id, act: act, node: node || "" });
        if (!d || d.ok === false) throw new Error((d && d.error) || "操作失败");
        toast(act === "revive" ? "已复活" : act === "archive" ? "已归档" :
          act === "seal" ? "已封盒" : "已解封");
      }
      await bxLoad(); bxPaint();
    } catch (e) { toast("操作失败：" + ((e && e.message) || e)); }
    BX.busy = false;
  }

  async function bxBind() {
    const ids = bxLoose();
    if (!ids.length) { toast("没有漏在外面的叙事记忆 —— 都归盒了"); return; }
    BX.busy = true;
    try {
      const d = await POST("/app/archive/box/bind", { ids: ids });
      if (!d || d.ok === false) throw new Error((d && d.error) || "归盒失败");
      toast("收进 " + num(d.bound, 0) + " 条" + (num(d.created, 0) ? "，新开了 " + d.created + " 个盒" : ""));
      await bxLoad(); bxPaint();
    } catch (e) { toast("归盒失败：" + ((e && e.message) || e)); }
    BX.busy = false;
  }

  async function bxNew() {
    const name = (typeof prompt === "function") ? prompt("新盒叫什么？（之后可以改）", "") : "";
    if (name == null) return;
    try {
      const d = await POST("/app/archive/box/save", { box: { name: String(name).trim() || "一件事" } });
      if (!d || d.ok === false) throw new Error((d && d.error) || "新建失败");
      await bxLoad(); bxPaint();
    } catch (e) { toast("新建失败：" + ((e && e.message) || e)); }
  }

  async function bxRename() {
    const b = bxById(BX.open); if (!b) return;
    const name = (typeof prompt === "function") ? prompt("改成什么名字？", b.name || "") : null;
    if (name == null) return;
    try {
      const nb = Object.assign({}, b, { name: String(name).trim() || b.name, nodes: undefined, summary: undefined });
      const d = await POST("/app/archive/box/save", { box: nb });
      if (!d || d.ok === false) throw new Error((d && d.error) || "改名失败");
      await bxLoad(); bxPaint();
    } catch (e) { toast("改名失败：" + ((e && e.message) || e)); }
  }

  async function bxDelete() {
    const b = bxById(BX.open); if (!b) return;
    if (typeof confirm === "function" &&
      !confirm("删掉「" + (b.name || "这个盒") + "」？\n盒里的记忆本身不会删，只是不再属于任何盒。")) return;
    try {
      const d = await POST("/app/archive/box/delete", { id: b.id });
      if (!d || d.ok === false) throw new Error((d && d.error) || "删除失败");
      BX.open = null;
      await bxLoad(); bxPaint();
    } catch (e) { toast("删除失败：" + ((e && e.message) || e)); }
  }

  /* 子视图切换：事件盒 ↔ 时间线。
     ★ 时间线那一屏是**宿主原来的**渲染（年 / 月 / 条目 + Haven 卡），
       这里不重写它，只是显隐 —— 两套实现同一个东西，是这次要收掉的病。 */
  function bxView(v) {
    BX.view = v;
    const tl = document.getElementById("arcTimeline");
    if (tl) tl.classList.toggle("hidden", v !== "timeline");
    const bt = document.getElementById("arcBoxes");
    if (bt) bt.classList.toggle("hidden", v !== "boxes");
    if (v === "timeline") {
      const H = hostApi();
      if (H.arcRender) { try { H.arcRender(); } catch (_) { } }
    }
  }

  function bxBindEv() {
    const host = document.getElementById("arcBoxes");
    if (!host || host.dataset.bound) return;
    host.dataset.bound = "1";
    host.addEventListener("click", async (e) => {
      const t = e.target;
      const hit = (sel) => t.closest(sel);
      try {
        const seg = hit("[data-arc-view]");
        if (seg) { bxView(seg.dataset.arcView); bxPaint(); return; }
        if (hit("[data-bx-reload]")) { await bxLoad(); bxPaint(); return; }
        if (hit("[data-bx-back]")) { BX.open = null; bxPaint(); return; }
        if (hit("[data-bx-bind]")) { await bxBind(); return; }
        if (hit("[data-bx-new]")) { await bxNew(); return; }
        if (hit("[data-bx-rename]")) { await bxRename(); return; }
        if (hit("[data-bx-del]")) { await bxDelete(); return; }
        const act = hit("[data-bx-act]");
        // ★ 顺序要紧：先判具体的「节点操作」，再判盒级动作 ——
        //   两处都用 data-bx-act，认错了会把"复活某条"当成"压缩整盒"
        if (act && act.dataset.bxNode) { await bxAct(act.dataset.bxAct, act.dataset.bxNode); return; }
        if (act) { await bxAct(act.dataset.bxAct, ""); return; }
        const op = hit("[data-bx-open]");
        if (op) { BX.open = op.dataset.bxOpen; bxPaint(); return; }
      } catch (err) { toast("出错了：" + ((err && err.message) || err)); }
    });
  }

  function bxPaint() {
    const host = document.getElementById("arcBoxes");
    if (!host) return;
    const v = BX.view;
    host.innerHTML = bxHtml();
    // 重绘会把 class 洗掉，所以每次重新同步一次显隐
    const tl = document.getElementById("arcTimeline");
    if (tl) tl.classList.toggle("hidden", v !== "timeline");
    host.classList.toggle("hidden", v !== "boxes");
  }

  /* 出错时把原因画出来（而不是留一片空白）+ 一个能点的重试。
     ★ 重试按钮要挂监听器，所以这里再 bind 一次 —— bind 是幂等的（dataset.bound）。 */
  function paintFailure(page, e) {
    const isArc = page === "archive";
    const msg = String((e && e.message) || e || "未知错误");
    try { if (typeof console !== "undefined" && console.error) console.error("[memory-pack]", page, e); } catch (_) { }
    /* ★ 兜底路径必须**自包含**：不能调 hostApi().esc / esc() / hostApi().toast。
       它们是"正常路径"的依赖 —— 而正常路径刚刚才炸过。第一版这里写的是 esc(msg)，
       于是一旦坏在 esc 上（比如宿主给的 escapeHtml 有问题），兜底自己也跟着抛，
       结果还是留一片空白，等于没有兜底。（smoke 里那条"兜底不许依赖会坏的东西"抓到的。） */
    const safe = (x) => String(x == null ? "" : x).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    let host = null;
    try { host = document.getElementById(isArc ? "arcBoxes" : "memWbMount"); } catch (_) { host = null; }
    if (!host) return;
    /* 整段拼装也包起来 —— 目标是"无论如何都留下一点可读的东西"，不是"再抛一次" */
    try {
      host.innerHTML = '<section class="mg-card"><div class="mg-head"><div>' +
        '<div class="mg-title">' + (isArc ? "档案馆" : "世界书") + "</div>" +
        '<div class="mg-sub">这一页没能画出来</div></div></div>' +
        '<div class="arc-empty">' + safe(msg) + "<br><br>" +
        "常见原因：后端刚重启（等十几秒再点重试）、网络断了、或者这条记录的形状不对。</div>" +
        '<div class="mp-acts"><button type="button" class="mp-btn primary" data-' +
        (isArc ? "bx" : "wb") + '-reload="1">重试</button></div></section>';
    } catch (_) { host.innerHTML = "这一页没能画出来：" + safe(msg); }
    /* 重试按钮得有监听器，否则它是个死按钮 */
    try { if (isArc) bxBindEv(); else wbBind(); } catch (_) { }
  }

  /* ════════════════════════════ 出口 ════════════════════════════ */
  const api_ = {
    /* page: "worldbook" | "archive"。force=true 时强制重读。 */
    async render(page, force) {
      try {
        if (page === "worldbook") {
          wbBind();
          if (force || !WB.loaded) await wbLoad();
          wbPaint();
          return WB;
        }
        if (page === "archive") {
          bxBindEv();
          if (force || !BX.loaded) await bxLoad();
          bxPaint();
          return BX;
        }
      } catch (e) {
        /* ★ 不静默。
           宿主那边是 `try { MemoryPack.render(...) } catch (_) { }` —— 它会把错误吃掉，
           界面上只剩一片空白。用户看到的是"打开没有"，而真正的原因谁也看不见 ——
           排查成本全落在"再读一遍代码"上。所以这里自己把错误画在页面上：
           至少能分清是"后端连不上""数据形状不对"还是"哪儿写崩了"。 */
        paintFailure(page, e);
      }
    },
    /* 换页/重进记忆面板时清掉"停在某一层"的状态 —— 否则下次进来还停在上次的盒里 */
    reset() {
      WB.edit = null; WB.editDraft = null; WB.panel = ""; WB.preview = null;
      BX.open = null;
    },
    /* 给冒烟测试用的口子（不进 UI）。名字前缀下划线是刻意的：它不是给业务调的。 */
    _state: { WB: WB, BX: BX },
    _wbHtml: wbHtml,
    _bxHtml: bxHtml,
    _wbCats: wbCats,
    _wbList: wbList,
    _wbDraft: wbDraft,
    _bxLoose: bxLoose,
    _narrativeKinds: narrativeKinds,
    _libKinds: libKinds,
    _kindLabel: kindLabel,
    _wbReadForm: wbReadForm,
    _wbPanelHtml: wbPanelHtml,
    _bxView: bxView,
    _reset() {
      WB.loaded = false; WB.items = []; WB.stats = null; WB.err = "";
      WB.edit = null; WB.editDraft = null; WB.panel = ""; WB.preview = null;
      BX.loaded = false; BX.boxes = []; BX.stats = null; BX.err = ""; BX.open = null; BX.view = "boxes";
      const a = document.getElementById("memWbMount"); if (a) delete a.dataset.bound;
      const b = document.getElementById("arcBoxes"); if (b) delete b.dataset.bound;
    },
  };
  try { window.MemoryPack = api_; } catch (_) { }
  if (typeof module !== "undefined" && module.exports) module.exports = api_;
})();
