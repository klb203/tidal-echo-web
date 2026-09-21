/* ══════════════════════════════════════════════════════════════════════════
   music-pack.js · 一起听（Movie「一起做」里的那张卡片）

   一页唱片：黑胶转着 · 歌词跟着走 · 下面是**听歌时你们俩的留言**。

   数据来自云服务器上那两套音乐服务（都由后端 /app/ear/* 代跑，前端不直连）：
        eryu（:9090）             歌词 / 播放地址 / 正在播放
        netease-music-mcp（:3456）歌单（含封面与时长）/ 搜索

   ── 三条纪律 ──────────────────────────────────────────────────────────────
   ① **留言不是聊天**。它写的话落在这一页（后端走的是同一条"让它说一句"的链路，
      只是 deliver_it=False）——所以这里不显示聊天气泡，也不往会话里塞。
   ② 拿不到播放地址时**把原因说出来**。线上实测多半是服务器上的网易云 cookie
      过期（~/.netease_cred 里的 MUSIC_U）——不说清，用户会以为是自己点错了。
   ③ 一打开只拉**本地那份**（/app/ear/state），歌词与地址按需单独拉。
      要是把它们塞进打开那一下，页面就得转十几秒的圈。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.EarPack) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* ── 状态 ─────────────────────────────────────────────────────────────── */
  const S = {
    open: false,
    busy: "",
    cfg: {},                 // {eryu, nmcp, has_token, autosay}
    now: {},                 // 现在在听什么
    notes: [],
    lyric: [],               // [{t, text}]
    lyricIdx: -1,
    dur: 0,
    pos: 0,
    playing: false,
    sheet: "",               // "" | "pick" | "cfg"
    pick: { playlists: [], songs: [], from: "", err: "" },
    toast: "",
  };
  let elPanel = null, elAudio = null, tick = null, toastTimer = null;

  /* ── 跟宿主拿的后端调用（index.html 里那份带 base + 鉴权）───────────── */
  async function api(path, opt) {
    const o = Object.assign({}, opt || {});
    if (o.body && typeof o.body !== "string") o.body = JSON.stringify(o.body);
    if (o.body && !(o.headers && o.headers["Content-Type"])) {
      o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
    }
    try {
      if (typeof window.memApi === "function") return await window.memApi(path, o);
    } catch (_) { /* 落到下面的 fetch */ }
    const r = await fetch(path, o);
    return r.json();
  }

  /* ── LRC ──────────────────────────────────────────────────────────────── */
  function parseLrc(raw) {
    const out = [];
    String(raw || "").split("\n").forEach((line) => {
      const m = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)$/.exec(line.trim());
      if (!m) return;
      // ★ LRC 里的小数是**按位数**算的：[00:03.50] 是 50 百分秒（0.5 秒），
      //   [00:03.500] 才是 500 毫秒。写成固定 /1000 会让两位那种整整慢半拍。
      const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
      const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac;
      const text = String(m[4] || "").trim();
      if (text) out.push({ t: t, text: text });
    });
    return out.sort((a, b) => a.t - b.t);
  }
  function lrcIndex(list, sec) {
    let i = -1;
    for (let k = 0; k < list.length; k++) {
      if (list[k].t <= sec + 0.25) i = k; else break;
    }
    return i;
  }

  /* ── 时间 ─────────────────────────────────────────────────────────────── */
  function mmss(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }
  function ago(ts) {
    const d = Math.max(0, Date.now() / 1000 - (Number(ts) || 0));
    if (d < 60) return "刚刚";
    if (d < 3600) return Math.floor(d / 60) + " 分钟前";
    if (d < 86400) return Math.floor(d / 3600) + " 小时前";
    return Math.floor(d / 86400) + " 天前";
  }

  /* ══════════════════ DOM ══════════════════════════════════════════════ */
  function ensureDom() {
    let el = document.getElementById("earPanel");
    if (el) return el;
    el = document.createElement("div");
    el.className = "ear-panel hidden";
    el.id = "earPanel";
    el.innerHTML =
      '<div class="ear-top">' +
        '<button class="ear-ic" type="button" data-ear="close" title="返回">‹</button>' +
        '<div class="ear-title">一起听</div>' +
        '<button class="ear-ic" type="button" data-ear="reload" title="刷新">⟳</button>' +
      "</div>" +
      '<div class="ear-scroll">' +
        '<div class="ear-stage">' +
          '<div class="ear-vinyl' + '" id="earVinyl">' +
            '<div class="ear-groove"></div>' +
            '<img class="ear-cover" id="earCover" alt="" ' +
              'src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E">' +
            '<div class="ear-hole"></div>' +
          "</div>" +
          '<div class="ear-name" id="earName">还没在听什么</div>' +
          '<div class="ear-artist" id="earArtist"></div>' +
          '<div class="ear-bar" data-ear="seek"><div class="ear-fill" id="earFill"></div></div>' +
          '<div class="ear-times"><span id="earPos">0:00</span><span id="earDur">0:00</span></div>' +
          '<div class="ear-ctl">' +
            '<button class="ear-cbtn" type="button" data-ear="prev" title="上一首">⏮</button>' +
            '<button class="ear-cbtn main" type="button" data-ear="toggle" id="earToggle">▶</button>' +
            '<button class="ear-cbtn" type="button" data-ear="next" title="下一首">⏭</button>' +
          "</div>" +
          '<div class="ear-hint" id="earHint"></div>' +
        "</div>" +
        '<div class="ear-lyric" id="earLyric"></div>' +
        '<div class="ear-sec-t">留言<span class="ear-n" id="earNoteN"></span>' +
          '<span class="ear-sec-s">听歌时你们俩说的</span></div>' +
        '<div class="ear-notes" id="earNotes"></div>' +
        '<div class="ear-compose">' +
          '<input class="ear-input" id="earInput" type="text" autocomplete="off" ' +
            'placeholder="说点什么…（它会看到）">' +
          '<button class="ear-send" type="button" data-ear="send">发送</button>' +
        "</div>" +
      "</div>" +
      '<div class="ear-bottom">' +
        '<button class="ear-btn" type="button" data-ear="say">✦ 让它说一句</button>' +
        '<button class="ear-btn" type="button" data-ear="pick">♫ 点歌</button>' +
        '<button class="ear-btn" type="button" data-ear="cfg">⚙ 设置</button>' +
      "</div>" +
      '<div class="ear-sheet hidden" id="earSheet"></div>' +
      '<div class="ear-toast" id="earToast"></div>' +
      '<audio id="earAudio" preload="none"></audio>';
    document.body.appendChild(el);
    return el;
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────────── */
  const el = (id) => document.getElementById(id);

  function showToast(t) {
    S.toast = String(t || "");
    const box = el("earToast");
    if (box) { box.textContent = S.toast; box.classList.toggle("show", !!S.toast); }
    clearTimeout(toastTimer);
    if (S.toast) toastTimer = setTimeout(() => {
      S.toast = "";
      if (box) box.classList.remove("show");
    }, 2600);
  }

  function paint() {
    if (!elPanel) return;
    const n = S.now || {};
    const name = el("earName"), artist = el("earArtist"), cover = el("earCover");
    if (name) name.textContent = n.name || "还没在听什么";
    if (artist) artist.textContent = n.artist || "";
    if (cover && n.cover && cover.getAttribute("src") !== n.cover) cover.setAttribute("src", n.cover);
    const toggle = el("earToggle");
    if (toggle) toggle.textContent = S.playing ? "❚❚" : "▶";
    const vinyl = el("earVinyl");
    if (vinyl) vinyl.classList.toggle("spin", !!S.playing);
    const fill = el("earFill");
    if (fill) fill.style.width = (S.dur > 0 ? Math.min(100, (S.pos / S.dur) * 100) : 0) + "%";
    const pos = el("earPos"), dur = el("earDur");
    if (pos) pos.textContent = mmss(S.pos);
    if (dur) dur.textContent = S.dur > 0 ? mmss(S.dur) : "0:00";
    paintLyric();
    paintNotes();
    paintSheet();
  }

  function paintLyric() {
    const box = el("earLyric");
    if (!box) return;
    if (!S.lyric.length) {
      box.innerHTML = '<div class="ear-empty">' +
        esc(S.now && S.now.name ? "这首歌还没拿到歌词" : "点一首歌，歌词会跟着走") + "</div>";
      return;
    }
    box.innerHTML = S.lyric.map((l, i) =>
      '<div class="ear-lrc' + (i === S.lyricIdx ? " on" : "") + '" data-lrc-idx="' + i + '">' +
      esc(l.text) + "</div>").join("");
    const cur = box.querySelector(".ear-lrc.on");
    if (cur && cur.scrollIntoView) {
      try { cur.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) { }
    }
  }

  function paintNotes() {
    const box = el("earNotes");
    const cnt = el("earNoteN");
    if (cnt) cnt.textContent = S.notes.length ? " · " + S.notes.length : "";
    if (!box) return;
    if (!S.notes.length) {
      box.innerHTML = '<div class="ear-empty">还没有留言。放一首歌，然后把此刻说给它听 —— ' +
        '或者点下面的「让它说一句」。</div>';
      return;
    }
    box.innerHTML = S.notes.slice().reverse().map((m) => {
      const mine = m.who !== "ai";
      return '<div class="ear-note' + (mine ? " me" : " ai") + '">' +
        '<div class="ear-n-h"><span class="ear-n-who">' + (mine ? "我" : esc(hostName("ai"))) + "</span>" +
        '<span class="ear-n-t">' + esc(ago(m.ts)) + "</span>" +
        (m.song ? '<span class="ear-n-song">' + esc(m.song) + "</span>" : "") + "</div>" +
        '<div class="ear-n-x">' + esc(m.text) + "</div></div>";
    }).join("");
  }

  function paintSheet() {
    const box = el("earSheet");
    if (!box) return;
    box.classList.toggle("hidden", !S.sheet);
    if (!S.sheet) { box.innerHTML = ""; return; }
    if (S.sheet === "cfg") {
      const c = S.cfg || {};
      box.innerHTML =
        '<div class="ear-sheet-h">一起听 · 设置' +
          '<button class="ear-ic" type="button" data-ear="sheet-close">✕</button></div>' +
        '<div class="ear-sheet-b">' +
          '<label class="ear-fld"><span>eryu 地址（歌词 / 播放 / 正在播放）</span>' +
            '<input id="earCfgEryu" type="text" autocomplete="off" spellcheck="false" value="' +
            esc(c.eryu || "") + '" placeholder="http://你的服务器:9090"></label>' +
          '<label class="ear-fld"><span>访问令牌' +
            (c.has_token ? '（已填，留空 = 不改）' : "（在你自己那个 9090 页面的设置里能看到）") +
            "</span>" +
            '<input id="earCfgTok" type="password" autocomplete="off" spellcheck="false" placeholder="' +
            (c.has_token ? "留空 = 不改" : "X-Auth-Token") + '"></label>' +
          '<label class="ear-fld"><span>netease-music-mcp 地址（歌单 / 封面）</span>' +
            '<input id="earCfgNmcp" type="text" autocomplete="off" spellcheck="false" value="' +
            esc(c.nmcp || "") + '" placeholder="http://你的服务器:3456"></label>' +
          '<label class="ear-fld row"><span>切歌时让它自己留一句</span>' +
            '<input id="earCfgAuto" type="checkbox"' + (c.autosay ? " checked" : "") + "></label>" +
          '<div class="ear-sheet-note">留空令牌 = 不改动。地址是云服务器上那两套音乐服务 —— ' +
            "一起听这一页的歌词、封面、播放都靠它们。</div>" +
          '<div class="ear-sheet-btns">' +
            '<button class="ear-btn" type="button" data-ear="cfg-save">保存并刷新</button>' +
            '<button class="ear-btn ghost" type="button" data-ear="sheet-close">取消</button>' +
          "</div>" +
        "</div>";
      return;
    }
    // 点歌
    const p = S.pick;
    let h = '<div class="ear-sheet-h">点歌<button class="ear-ic" type="button" data-ear="sheet-close">✕</button></div>' +
      '<div class="ear-sheet-b">' +
      '<div class="ear-search"><input id="earQ" type="text" autocomplete="off" ' +
        'placeholder="搜歌名 / 歌手（回车）"><button class="ear-btn" type="button" data-ear="search">搜</button></div>';
    if (p.err) h += '<div class="ear-warn">' + esc(p.err) + "</div>";
    if (p.songs.length) {
      h += '<div class="ear-sheet-t">搜索结果</div><div class="ear-list">' +
        p.songs.slice(0, 30).map((s) =>
          '<button class="ear-row" type="button" data-ear-pick="' + esc(s.id) + '">' +
          '<span class="ear-row-n">' + esc(s.name) + "</span>" +
          '<span class="ear-row-s">' + esc(s.artist || "") + "</span></button>").join("") + "</div>";
    }
    if (p.playlists.length) {
      h += '<div class="ear-sheet-t">歌单 · ' + esc(p.from || "") + '</div><div class="ear-list">' +
        p.playlists.map((x) =>
          '<button class="ear-row" type="button" data-ear-pl="' + esc(x.id) + '">' +
          '<span class="ear-row-n">' + esc(x.name) + "</span>" +
          '<span class="ear-row-s">' + esc(String(x.trackCount || x.count || "")) + " 首</span>" +
          "</button>").join("") + "</div>";
    }
    if (!p.songs.length && !p.playlists.length && !p.err) {
      h += '<div class="ear-empty">' + (S.busy ? "读歌单…" : "搜一首歌，或者挑个歌单") + "</div>";
    }
    h += "</div>";
    box.innerHTML = h;
  }

  /* ── 宿主那两个名字（不在这里另存一份）────────────────────────────── */
  function hostName(which) {
    try {
      const h = window.__DayHost || window.__EarHost || {};
      const f = which === "ai" ? h.aiName : h.meName;
      const v = (typeof f === "function") ? String(f() || "").trim() : "";
      if (v) return v;
    } catch (_) { }
    return which === "ai" ? "TA" : "我";
  }

  /* ══════════════════ 行为 ══════════════════════════════════════════════ */
  async function load() {
    S.busy = "load";
    try {
      const d = await api("/app/ear/state");
      if (d && d.ok) {
        S.cfg = d.cfg || {};
        S.now = d.now || {};
        S.notes = d.notes || [];
        paint();
        if (S.now && S.now.sid) await loadSong(S.now.sid, { autoplay: false });
        else { setHint("点「点歌」放一首 —— 放起来之后，你在这儿说的每一句它都看得到。"); }
      } else {
        setHint("读不到一起听的状态：" + ((d && d.error) || "后端没回话"));
      }
    } catch (e) {
      setHint("读不到一起听的状态：" + ((e && e.message) || e));
    } finally {
      S.busy = "";
      paintSheet();
    }
  }

  function setHint(t) {
    const box = el("earHint");
    if (box) box.innerHTML = t;
  }

  /** 拉这首歌的**播放地址与歌词**（两件事都按需，不塞进打开那一下）。 */
  async function loadSong(sid, opt) {
    const o = opt || {};
    S.lyric = []; S.lyricIdx = -1; S.dur = 0; S.pos = 0;
    paintLyric();
    setHint("读这首歌…");
    let audio = null;
    try { audio = await api("/app/ear/audio?id=" + encodeURIComponent(sid)); } catch (_) { }
    if (audio && audio.ok && audio.url) {
      if (elAudio) {
        elAudio.src = audio.url;
        if (o.autoplay) { try { await elAudio.play(); S.playing = true; } catch (_) { S.playing = false; } }
      }
      setHint("");
    } else {
      S.playing = false;
      setHint("没拿到播放地址 —— " + esc((audio && (audio.error || "")) || "后端没回话") +
        (audio && audio.hint ? '<br><span class="ear-hint-h">' + esc(audio.hint) + "</span>" : "") +
        '<br><span class="ear-hint-s">歌词与留言照常，只是这一首暂时放不出声。</span>');
    }
    paint();
    try {
      const ly = await api("/app/ear/lyric?id=" + encodeURIComponent(sid));
      if (ly && ly.ok) { S.lyric = parseLrc(ly.lrc); paintLyric(); }
    } catch (_) { }
  }

  async function playSong(song) {
    if (!song) return;
    S.playing = false;
    S.now = { sid: String(song.sid || song.id || ""), name: song.name || "",
              artist: song.artist || "", cover: song.cover || song.pic || "" };
    paint();
    try { await api("/app/ear/now", { method: "POST", body: { song: S.now } }); } catch (_) { }
    S.sheet = "";
    paintSheet();
    await loadSong(S.now.sid, { autoplay: true });
  }

  async function toggle() {
    if (!elAudio || !elAudio.src) { showToast("先点一首"); return; }
    if (elAudio.paused) { try { await elAudio.play(); S.playing = true; } catch (e) { showToast("放不出来：" + ((e && e.message) || e)); } }
    else { elAudio.pause(); S.playing = false; }
    paint();
  }

  async function sendNote() {
    const inp = el("earInput");
    const text = inp ? String(inp.value || "").trim() : "";
    if (!text) { showToast("说点什么"); return; }
    if (inp) inp.value = "";
    try {
      const d = await api("/app/ear/note", { method: "POST", body: { text: text, who: "me" } });
      if (d && d.ok && d.note) { S.notes.push(d.note); paintNotes(); }
      else showToast((d && d.error) || "没存下去");
    } catch (e) { showToast("没存下去：" + ((e && e.message) || e)); }
  }

  async function sayNow(force) {
    S.busy = "say";
    showToast("它正在写…");
    try {
      const d = await api("/app/ear/say", { method: "POST", body: { force: !!force } });
      if (d && d.ok && d.note) {
        S.notes.push(d.note);
        paintNotes();
        showToast("它留了一句");
      } else {
        showToast((d && (d.skipped || d.error)) || "这次没写");
      }
    } catch (e) { showToast("没写成：" + ((e && e.message) || e)); }
    finally { S.busy = ""; }
  }

  async function openPick() {
    S.sheet = "pick";
    S.pick = { playlists: [], songs: [], from: "", err: "" };
    paintSheet();
    try {
      const d = await api("/app/ear/playlists");
      if (d && d.ok) { S.pick.playlists = d.playlists || []; S.pick.from = d.from || ""; }
      else S.pick.err = (d && d.error) || "歌单没读到";
    } catch (e) { S.pick.err = "歌单没读到：" + ((e && e.message) || e); }
    paintSheet();
  }

  async function doSearch() {
    const q = el("earQ") ? String(el("earQ").value || "").trim() : "";
    if (!q) return;
    S.busy = "search";
    paintSheet();
    try {
      const d = await api("/app/ear/search?q=" + encodeURIComponent(q));
      S.pick.songs = (d && d.songs) || [];
      S.pick.err = (d && !d.ok) ? (d.error || "搜不到") : "";
    } catch (e) { S.pick.err = "搜不了：" + ((e && e.message) || e); }
    finally { S.busy = ""; paintSheet(); }
  }

  async function openPlaylist(pid) {
    S.busy = "pl";
    paintSheet();
    try {
      const d = await api("/app/ear/playlist?id=" + encodeURIComponent(pid));
      const songs = (d && d.songs) || [];
      S.pick.songs = songs.map((s) => ({
        id: s.id, name: s.name, artist: s.artist,
        cover: s.pic || s.cover || "",
      }));
      S.pick.err = songs.length ? "" : "这个歌单是空的（或者没读到）";
    } catch (e) { S.pick.err = "读不了歌单：" + ((e && e.message) || e); }
    finally { S.busy = ""; paintSheet(); }
  }

  async function seekTo(ev) {
    if (!elAudio || !S.dur) return;
    const bar = ev.currentTarget;
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / (r.width || 1)));
    try { elAudio.currentTime = ratio * S.dur; } catch (_) { }
  }

  async function saveCfg() {
    const body = {};
    if (el("earCfgEryu")) body.eryu = String(el("earCfgEryu").value || "").trim();
    if (el("earCfgNmcp")) body.nmcp = String(el("earCfgNmcp").value || "").trim();
    if (el("earCfgTok")) body.token = String(el("earCfgTok").value || "").trim();
    if (el("earCfgAuto")) body.autosay = !!el("earCfgAuto").checked;
    try {
      const d = await api("/app/ear/config", { method: "POST", body: body });
      if (d && d.ok) {
        S.cfg = d.config || S.cfg;
        S.sheet = "";
        paint();
        showToast("存好了");
        await load();
      } else showToast((d && d.error) || "没存下去");
    } catch (e) { showToast("没存下去：" + ((e && e.message) || e)); }
  }

  /* ── 事件（一次委托，不逐个绑）────────────────────────────────────── */
  function bind() {
    if (!elPanel || elPanel.dataset.bound) return;
    elPanel.dataset.bound = "1";
    elPanel.addEventListener("click", onAct);
    elPanel.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.target && e.target.id === "earInput") { e.preventDefault(); sendNote(); }
      if (e.target && e.target.id === "earQ") { e.preventDefault(); doSearch(); }
    });
    elAudio = el("earAudio");
    if (elAudio) {
      elAudio.addEventListener("timeupdate", () => {
        S.pos = elAudio.currentTime || 0;
        if (!S.dur && elAudio.duration) S.dur = elAudio.duration;
        const i = lrcIndex(S.lyric, S.pos);
        if (i !== S.lyricIdx) { S.lyricIdx = i; paintLyric(); }
        else {
          const fill = el("earFill");
          if (fill) fill.style.width = (S.dur > 0 ? Math.min(100, (S.pos / S.dur) * 100) : 0) + "%";
          const p = el("earPos");
          if (p) p.textContent = mmss(S.pos);
        }
      });
      elAudio.addEventListener("loadedmetadata", () => {
        S.dur = elAudio.duration || 0;
        const d = el("earDur");
        if (d) d.textContent = S.dur > 0 ? mmss(S.dur) : "0:00";
        paint();
      });
      elAudio.addEventListener("play", () => { S.playing = true; if (!tick) tickStart(); paint(); });
      elAudio.addEventListener("pause", () => { S.playing = false; paint(); });
      elAudio.addEventListener("ended", () => { S.playing = false; paint(); });
    }
  }

  function onAct(e) {
    const t = e.target;
    const b = t && t.closest ? t.closest("[data-ear]") : null;
    if (b) {
      const k = b.dataset.ear;
      if (k === "close") { close(); return; }
      if (k === "reload") { load(); return; }
      if (k === "toggle") { toggle(); return; }
      if (k === "prev" || k === "next") { step(k === "next" ? 1 : -1); return; }
      if (k === "send") { sendNote(); return; }
      if (k === "say") { sayNow(true); return; }
      if (k === "pick") { openPick(); return; }
      if (k === "cfg") { S.sheet = S.sheet === "cfg" ? "" : "cfg"; paintSheet(); return; }
      if (k === "sheet-close") { S.sheet = ""; paintSheet(); return; }
      if (k === "search") { doSearch(); return; }
      if (k === "cfg-save") { saveCfg(); return; }
      if (k === "seek") { seekTo(e); return; }
      return;
    }
    const pick = t && t.closest ? t.closest("[data-ear-pick]") : null;
    if (pick) { playSong(S.pick.songs.filter((s) => String(s.id) === String(pick.dataset.earPick))[0]); return; }
    const pl = t && t.closest ? t.closest("[data-ear-pl]") : null;
    if (pl) { openPlaylist(pl.dataset.earPl); return; }
  }

  /** 切歌：当前歌在**歌单/搜索结果**里的话就顺着一张表走；没有表就明说。 */
  async function step(dir) {
    const list = (S.pick.songs || []);
    if (!list.length) { showToast("先从「点歌」里放一首 —— 有了列表才能切"); S.sheet = "pick"; paintSheet(); return; }
    const i = list.findIndex((s) => String(s.id) === String((S.now || {}).sid));
    const j = i < 0 ? 0 : (i + dir + list.length) % list.length;
    await playSong(list[j]);
  }

  function tickStart() {
    clearInterval(tick);
    tick = setInterval(() => {
      if (!S.open) { clearInterval(tick); tick = null; return; }
      paint();
    }, 30000);          // 只是让"几分钟前"别停在那儿
  }

  /* ── 开关 ─────────────────────────────────────────────────────────── */
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
    if (elAudio) { try { elAudio.pause(); } catch (_) { } }
    S.playing = false;
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

  window.openEar = open;
  window.closeEar = close;
  window.EarPack = {
    open: open, close: close,
    _el: () => document.getElementById("earPanel"),
    _paint: paint,
    _load: load,
    _playSong: playSong,
    _say: sayNow,
    _send: sendNote,
    _step: step,
    _openPick: openPick,
    _sheet: () => S.sheet,
    _lrc: parseLrc,
    _lrcIndex: lrcIndex,
    _state: () => JSON.parse(JSON.stringify({
      cfg: S.cfg, now: S.now, notes: S.notes, lyric: S.lyric, playing: S.playing,
      pos: S.pos, dur: S.dur, sheet: S.sheet,
    })),
    _set: (patch) => { Object.assign(S, patch || {}); paint(); },
    _mmss: mmss,
  };
})();
