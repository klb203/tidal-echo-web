/* ══════════════════════════════════════════════════════════════════════════
   read-pack.js · 共读（Movie「一起做」里的那张卡片）

   书架 → 翻开一章 → 在段落旁边写下你的想法 → **它会回你一条**。

   三条纪律
   ────────
   ① **它没读过这本书**。它回应的是"你划线的那一句 + 你写的话"，不是通读后的书评。
      界面上照这么说 —— 假装它读完了整本，第一次对话就会露馅。
   ② **锚点是原文片段**，不是字符偏移（reading-nook 的做法）。换字号、换设备、
      后端换存储格式，片段匹配都还能用；偏移一错位就全乱。
   ③ 打开只拉**书架**（一行索引），正文按章取。整本几十万字一次灌回来，
      翻开就要等半天。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.ReadPack) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const S = {
    open: false,
    books: [],
    book: null,        // {id, title, index, total, ch_title, body, chs, notes}
    note: "",          // 抽屉里的提示
    sheet: "",         // "" | "add" | "toc"
    busy: "",
    focus: "",         // 正在对它说的那条批注 id
  };
  let elPanel = null, toastTimer = null, scrollTimer = null;

  async function api(path, opt) {
    const o = Object.assign({}, opt || {});
    if (o.body && typeof o.body !== "string") o.body = JSON.stringify(o.body);
    if (o.body) o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
    try {
      if (typeof window.memApi === "function") return await window.memApi(path, o);
    } catch (_) { }
    const r = await fetch(path, o);
    return r.json();
  }

  function hostName(which) {
    try {
      const h = window.__DayHost || window.__ReadHost || {};
      const f = which === "ai" ? h.aiName : h.meName;
      const v = (typeof f === "function") ? String(f() || "").trim() : "";
      if (v) return v;
    } catch (_) { }
    return which === "ai" ? "TA" : "我";
  }

  /* ══════════════════ DOM ══════════════════════════════════════════════ */
  function ensureDom() {
    let el = document.getElementById("readPanel");
    if (el) return el;
    el = document.createElement("div");
    el.className = "rd-panel hidden";
    el.id = "readPanel";
    el.innerHTML =
      '<div class="rd-top">' +
        '<button class="rd-ic" type="button" data-rd="close" title="返回">‹</button>' +
        '<div class="rd-title" id="rdHead">共读</div>' +
        '<button class="rd-ic" type="button" data-rd="add" title="加一本书">＋</button>' +
      "</div>" +
      '<div class="rd-scroll" id="rdScroll"></div>' +
      '<div class="rd-bottom" id="rdBottom"></div>' +
      '<div class="rd-sheet hidden" id="rdSheet"></div>' +
      '<div class="rd-toast" id="rdToast"></div>';
    document.body.appendChild(el);
    return el;
  }
  const el = (id) => document.getElementById(id);

  function showToast(t) {
    const box = el("rdToast");
    if (box) { box.textContent = String(t || ""); box.classList.toggle("show", !!t); }
    clearTimeout(toastTimer);
    if (t) toastTimer = setTimeout(() => { if (box) box.classList.remove("show"); }, 2600);
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────────── */
  function paint() {
    if (!elPanel) return;
    const head = el("rdHead");
    if (head) head.textContent = S.book ? (S.book.title || "共读") : "共读";
    paintBody();
    paintBottom();
    paintSheet();
  }

  function paintBody() {
    const box = el("rdScroll");
    if (!box) return;
    if (!S.book) { paintShelf(box); return; }

    const b = S.book;
    let h = '<div class="rd-chbar">' +
      '<button class="rd-ic sm" type="button" data-rd="prev"' + (b.index <= 0 ? " disabled" : "") + ">‹</button>" +
      '<div class="rd-chname">' + esc(b.ch_title || "") +
        '<span class="rd-chno">' + (b.index + 1) + " / " + b.total + "</span></div>" +
      '<button class="rd-ic sm" type="button" data-rd="toc">☰</button>' +
      '<button class="rd-ic sm" type="button" data-rd="next"' +
        (b.index >= b.total - 1 ? " disabled" : "") + ">›</button>" +
      "</div>";
    h += '<div class="rd-text" id="rdText">' +
      esc(b.body || "").split(/\n\s*\n/).map((p) =>
        '<p class="rd-p">' + (p.trim() ? esc(p).replace(/\n/g, "<br>") : "&nbsp;") + "</p>"
      ).join("") + "</div>";

    const ns = b.notes || [];
    h += '<div class="rd-sec">这一章的批注' + (ns.length ? " · " + ns.length : "") + "</div>";
    if (!ns.length) {
      h += '<div class="rd-empty">还没有。读到哪里想起什么，写在下面 —— 它会回你一条。</div>';
    } else {
      h += ns.map((n) =>
        '<div class="rd-note" data-rd-note="' + esc(n.id) + '">' +
          (n.anchor ? '<div class="rd-anchor">「' + esc(n.anchor) + '」</div>' : "") +
          '<div class="rd-nx"><span class="rd-who me">' + esc(hostName("me")) + "</span>" +
          esc(n.note) + "</div>" +
          (n.replies || []).map((r) =>
            '<div class="rd-reply"><span class="rd-who ai">' + esc(hostName("ai")) + "</span>" +
            esc(r.text) + "</div>").join("") +
          '<div class="rd-nbtn">' +
            '<button class="rd-mini" type="button" data-rd-ai="' + esc(n.id) + '">让它回应</button>' +
            '<button class="rd-mini ghost" type="button" data-rd-del="' + esc(n.id) + '">删掉</button>' +
          "</div>" +
        "</div>").join("");
    }
    h += '<div class="rd-compose">' +
      '<input class="rd-in" id="rdAnchor" type="text" autocomplete="off" ' +
        'placeholder="（可选）把划到的那句粘过来">' +
      '<textarea class="rd-ta" id="rdNote" placeholder="对着这一章说点什么…"></textarea>' +
      '<div class="rd-cbtns">' +
        '<button class="rd-btn" type="button" data-rd="save">留一句</button>' +
        '<button class="rd-btn ghost" type="button" data-rd="back">回书架</button>' +
      "</div></div>";
    box.innerHTML = h;
  }

  function paintShelf(box) {
    const bs = S.books || [];
    if (!bs.length) {
      box.innerHTML = '<div class="rd-empty">书架是空的 —— 点右上角的 ＋，' +
        "把一本书的正文粘进来（txt 里的内容整段复制就行）。</div>";
      return;
    }
    box.innerHTML = bs.map((b) => {
      const p = b.pos || {};
      const done = b.n_ch ? Math.round(((p.ch || 0) + (p.pct || 0)) / b.n_ch * 100) : 0;
      return '<button class="rd-book" type="button" data-rd-open="' + esc(b.id) + '">' +
        '<div class="rd-b-t">' + esc(b.title) + "</div>" +
        '<div class="rd-b-s">' + b.n_ch + " 章 · " + (b.notes || 0) + " 条批注" +
          (p.ch ? " · 读到第 " + (p.ch + 1) + " 章" : "") + "</div>" +
        '<div class="rd-bar"><i style="width:' + Math.max(0, Math.min(100, done)) + '%"></i></div>' +
        "</button>";
    }).join("");
  }

  function paintBottom() {
    const box = el("rdBottom");
    if (!box) return;
    if (!S.book) { box.innerHTML = ""; return; }
    box.innerHTML = '<button class="rd-btn" type="button" data-rd="back">‹ 回书架</button>';
  }

  function paintSheet() {
    const box = el("rdSheet");
    if (!box) return;
    box.classList.toggle("hidden", !S.sheet);
    if (!S.sheet) { box.innerHTML = ""; return; }
    if (S.sheet === "toc") {
      const chs = (S.book || {}).chs || [];
      box.innerHTML =
        '<div class="rd-sheet-h">目录<button class="rd-ic" type="button" data-rd="sheet-close">✕</button></div>' +
        '<div class="rd-sheet-b"><div class="rd-toc">' +
        chs.map((t, i) => '<button class="rd-row' +
          (i === (S.book || {}).index ? " on" : "") + '" type="button" data-rd-ch="' + i + '">' +
          '<span class="rd-row-n">' + esc(t) + "</span></button>").join("") +
        "</div></div>";
      return;
    }
    box.innerHTML =
      '<div class="rd-sheet-h">加一本书<button class="rd-ic" type="button" data-rd="sheet-close">✕</button></div>' +
      '<div class="rd-sheet-b">' +
        '<div class="rd-hint">把正文粘进来就行。章节会按「第X章 / Chapter N / 序章…」自动分；' +
          "分不出来会按字数切。<b>只存在你自己的后端里</b>。</div>" +
        '<label class="rd-fld"><span>书名</span>' +
          '<input id="rdNewTitle" type="text" autocomplete="off" placeholder="比如：雨"></label>' +
        '<textarea class="rd-ta big" id="rdNewText" placeholder="把整本书的正文粘到这里…"></textarea>' +
        '<div class="rd-cbtns">' +
          '<button class="rd-btn" type="button" data-rd="add-save">收进书架</button>' +
          '<button class="rd-btn ghost" type="button" data-rd="sheet-close">取消</button>' +
        "</div>" +
        (S.note ? '<div class="rd-note-box">' + esc(S.note) + "</div>" : "") +
      "</div>";
  }

  /* ══════════════ 行为 ══════════════════════════════════════════════════ */
  async function load() {
    S.busy = "load";
    try {
      const d = await api("/app/read/state");
      if (d && d.ok) { S.books = d.books || []; paint(); }
      else showToast((d && d.error) || "读不到书架");
    } catch (e) { showToast("读不到书架：" + ((e && e.message) || e)); }
    finally { S.busy = ""; paintBody(); }
  }

  async function openBook(bid, ch) {
    S.busy = "open";
    paintBody();
    try {
      const d = await api("/app/read/book?id=" + encodeURIComponent(bid) +
                          (ch === undefined ? "" : "&ch=" + ch));
      if (d && d.ok) { S.book = d; paint(); scrollTop(); }
      else showToast((d && d.error) || "翻不开这本");
    } catch (e) { showToast("翻不开：" + ((e && e.message) || e)); }
    finally { S.busy = ""; paintBody(); }
  }

  function scrollTop() {
    const box = el("rdScroll");
    if (box) box.scrollTop = 0;
  }

  async function turn(delta) {
    if (!S.book) return;
    const i = S.book.index + delta;
    if (i < 0 || i >= S.book.total) return;
    await openBook(S.book.id, i);
  }

  async function saveNote() {
    if (!S.book) return;
    const ta = el("rdNote");
    const an = el("rdAnchor");
    const txt = ta ? String(ta.value || "").trim() : "";
    if (!txt) { showToast("还没写什么"); return; }
    try {
      const d = await api("/app/read/note", { method: "POST",
        body: { bid: S.book.id, ch: S.book.index, note: txt,
                anchor: an ? String(an.value || "").trim() : "" } });
      if (d && d.ok) { showToast("记下了"); await openBook(S.book.id, S.book.index); }
      else showToast((d && d.error) || "没记下来");
    } catch (e) { showToast("没记下来：" + ((e && e.message) || e)); }
  }

  async function askAI(nid) {
    S.focus = nid;
    showToast("它正在看…");
    try {
      const d = await api("/app/read/note/ai", { method: "POST", body: { id: nid } });
      if (d && d.ok) { showToast("它回了一条"); await openBook(S.book.id, S.book.index); }
      else showToast((d && (d.skipped || d.error)) || "它这次没回");
    } catch (e) { showToast("没回成：" + ((e && e.message) || e)); }
    finally { S.focus = ""; }
  }

  async function delNote(nid) {
    try {
      const d = await api("/app/read/note/del", { method: "POST", body: { id: nid } });
      if (d && d.ok) { showToast("删了"); await openBook(S.book.id, S.book.index); }
      else showToast((d && d.error) || "没删掉");
    } catch (e) { showToast("没删掉：" + ((e && e.message) || e)); }
  }

  async function addBook() {
    const tEl = el("rdNewTitle"), xEl = el("rdNewText");
    const title = tEl ? String(tEl.value || "").trim() : "";
    const text = xEl ? String(xEl.value || "") : "";
    if (!text.trim()) { S.note = "正文还没粘进来"; paintSheet(); return; }
    S.note = "正在收…（章节要拆一下）";
    paintSheet();
    try {
      const d = await api("/app/read/add", { method: "POST", body: { title: title, text: text } });
      if (d && d.ok) {
        S.sheet = ""; S.note = "";
        showToast("收进来了（" + d.n_ch + " 章）");
        await load();
      } else { S.note = (d && d.error) || "没收进来"; paintSheet(); }
    } catch (e) { S.note = "没收进来：" + ((e && e.message) || e); paintSheet(); }
  }

  /* 滚动时记进度（节流，别每滚一下就发一次） */
  function onScroll() {
    if (!S.book) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const box = el("rdScroll");
      if (!box || !S.book) return;
      const max = Math.max(1, box.scrollHeight - box.clientHeight);
      const pct = Math.max(0, Math.min(1, box.scrollTop / max));
      api("/app/read/pos", { method: "POST",
        body: { id: S.book.id, ch: S.book.index, pct: pct } }).catch(() => { });
    }, 1200);
  }

  /* ── 事件 ─────────────────────────────────────────────────────────────── */
  function bind() {
    if (!elPanel || elPanel.dataset.bound) return;
    elPanel.dataset.bound = "1";
    elPanel.addEventListener("click", onAct);
    const box = el("rdScroll");
    if (box) box.addEventListener("scroll", onScroll);
  }

  function onAct(e) {
    const t = e.target;
    const b = t && t.closest ? t.closest("[data-rd]") : null;
    if (b) {
      const k = b.dataset.rd;
      if (k === "close") { close(); return; }
      if (k === "add") { S.sheet = S.sheet === "add" ? "" : "add"; S.note = ""; paintSheet(); return; }
      if (k === "add-save") { addBook(); return; }
      if (k === "sheet-close") { S.sheet = ""; paintSheet(); return; }
      if (k === "toc") { S.sheet = "toc"; paintSheet(); return; }
      if (k === "prev") { turn(-1); return; }
      if (k === "next") { turn(1); return; }
      if (k === "save") { saveNote(); return; }
      if (k === "back") { S.book = null; S.note = ""; load(); return; }
      return;
    }
    const op = t && t.closest ? t.closest("[data-rd-open]") : null;
    if (op) { openBook(op.dataset.rdOpen); return; }
    const ch = t && t.closest ? t.closest("[data-rd-ch]") : null;
    if (ch) { S.sheet = ""; openBook(S.book.id, Number(ch.dataset.rdCh)); return; }
    const ai = t && t.closest ? t.closest("[data-rd-ai]") : null;
    if (ai) { askAI(ai.dataset.rdAi); return; }
    const dl = t && t.closest ? t.closest("[data-rd-del]") : null;
    if (dl) { delNote(dl.dataset.rdDel); return; }
  }

  function open() {
    elPanel = ensureDom();
    bind();
    S.open = true;
    elPanel.classList.remove("hidden");
    requestAnimationFrame(() => elPanel.classList.add("open"));
    load();
  }
  function close() {
    S.open = false;
    S.sheet = "";
    if (elPanel) {
      elPanel.classList.remove("open");
      setTimeout(() => { if (elPanel && !elPanel.classList.contains("open")) elPanel.classList.add("hidden"); }, 260);
    }
  }

  function init() {
    elPanel = ensureDom();
    bind();
    paint();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.openRead = open;
  window.closeRead = close;
  window.ReadPack = {
    open: open, close: close,
    _el: () => document.getElementById("readPanel"),
    _paint: paint, _load: load,
    _openBook: openBook, _turn: turn,
    _saveNote: saveNote, _askAI: askAI, _delNote: delNote, _addBook: addBook,
    _state: () => JSON.parse(JSON.stringify({
      books: S.books, book: S.book, sheet: S.sheet, note: S.note,
    })),
    _set: (p) => { Object.assign(S, p || {}); paint(); },
  };
})();
