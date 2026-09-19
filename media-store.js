/* ══════════════════════════════════════════════════════════════════════════
   media-store.js · 共享存储层（Gallery 图片记忆 / 朋友圈 共用）

   两份教程要的两层存储，都落在**你现有后端**上，不用新建任何服务：
     · 图片本体：POST /app/upload（原始字节）  →  GET /app/file/<id>
     · 元数据：  POST /app/fav/save { text, tag, source, type, url, name, mime }
                 GET  /app/fav?tag=<ns>&per_page=N
                 DELETE /app/fav/item?id=<id>
   外加一份 localStorage 镜像：后端没连上/断网时照样能看，写入时两边都写。

   ⚠️ 三个当初探路才知道的事（别再踩）：
     1. /app/memory/save **只收 event/ref/working/summary/story/room/letter 七种 kind**
        （传自定义 kind 会被 400 掉）——所以元数据不能塞进记忆库，会污染 TA 的回忆。
     2. /app/fav 是唯一能存**任意 JSON 文本**且**能删**的接口，用 tag 做命名空间。
        save 时带上 type:"image"/url 会让它归到「收藏 → 图片」分类，便于区分。
     3. /app/* 必须打后端的**根**，不是 /relay 前缀（/relay 只给 /relay/<供应商>/v1 用）。
   ══════════════════════════════════════════════════════════════════════════ */
window.MediaStore = (function () {
  const HOST_KEY   = "companion_cloud_relay";
  const TOKEN_KEY  = "companion_relay_token";
  const SECRET_KEY = "companion_secret";
  const CLOUD_DEFAULT = "https://tidal-echo-relay-1-vudb.onrender.com";
  const CONN_KEY   = "companion_active_conn";
  const MODEL_KEY  = "companion_media_model";     // 视觉/写作模型（可配）

  /* 各家版本号不一样：智谱是 v4、火山是 v3，其余 v1。拼错就是 404。 */
  const VER = { zhipu: "v4", volc: "v3" };

  function lsGet(k) { try { return (localStorage.getItem(k) || "").trim(); } catch (_) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v || ""); } catch (_) { } }

  function base() {
    const h = lsGet(HOST_KEY) || CLOUD_DEFAULT;
    return h.replace(/\/+$/, "");
  }
  function token() { return lsGet(TOKEN_KEY); }
  function secret() { return lsGet(SECRET_KEY); }
  function headers(extra) {
    /* 后端的 /app/* 走 Bearer；「关闭鉴权」时带上也无害 */
    const t = token() || secret();
    const h = Object.assign({}, extra || {});
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }
  function fileUrl(u) {
    const s = String(u || "");
    if (!s) return "";
    if (/^https?:/i.test(s) || s.indexOf("data:") === 0) return s;
    return base() + (s.charAt(0) === "/" ? s : "/" + s);
  }

  /* ── 内容哈希：只算**原始文件的字节**（不含任何元数据）───────────────
     教程坑三：哈希不含元数据 → 改标题不会被覆盖，这是对的。
     为什么哈希用原图、上传用缩略图：canvas 压缩的产物在不同浏览器/设备上
     可能差几个字节，用它当哈希会让同一张图在手机和电脑上算成两张。
     所以：hash = sha256(原图)，上传 = 压过的看图版。                        */
  async function sha256(buf) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function hashFile(file) {
    const buf = await file.arrayBuffer();
    return { hash: await sha256(buf), bytes: buf };
  }

  /* 大图压成看图版：手机随手一张 5–10MB，直接上传/传模型都很贵 */
  async function shrink(file, maxSide, quality) {
    maxSide = maxSide || 1280; quality = quality || 0.86;
    try {
      const bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = URL.createObjectURL(file);
      });
      let w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
      if (!w || !h) return null;
      const k = Math.min(1, maxSide / Math.max(w, h));
      w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
      URL.revokeObjectURL(bmp.src);
      const mime = /png/i.test(file.type) && k === 1 ? "image/png" : "image/jpeg";
      const blob = await new Promise((res) => cv.toBlob(res, mime, quality));
      return blob ? { blob: blob, w: w, h: h, mime: mime } : null;
    } catch (_) { return null; }
  }

  async function uploadImage(fileOrBlob, name, mime) {
    const blob = fileOrBlob;
    const qs = "?name=" + encodeURIComponent(name || "image.jpg");
    const r = await fetch(base() + "/app/upload" + qs, {
      method: "POST",
      headers: headers({ "Content-Type": mime || blob.type || "application/octet-stream" }),
      body: blob
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error((d && d.error && d.error.message) || ("上传失败 HTTP " + r.status));
    return { id: d.id, url: d.url || ("/app/file/" + d.id), name: d.name, mime: d.mime, size: d.size };
  }

  /* ── 元数据 KV（/app/fav + 本地镜像）────────────────────────────────── */
  const MIRROR_PREFIX = "companion_media_";
  function mirrorGet(ns) { try { return JSON.parse(localStorage.getItem(MIRROR_PREFIX + ns) || "[]") || []; } catch (_) { return []; } }
  function mirrorSet(ns, arr) { try { localStorage.setItem(MIRROR_PREFIX + ns, JSON.stringify((arr || []).slice(-500))); } catch (_) { } }

  function parseItem(it) {
    let data = {};
    try { data = JSON.parse(it.text || "{}") || {}; } catch (_) { }
    return {
      id: it.id, at: it.at || "", tag: it.tag || "", type: it.type || "", url: it.url || "",
      name: it.name || "", mime: it.mime || "", data: data
    };
  }

  async function kvList(ns, perPage) {
    const r = await fetch(base() + "/app/fav?tag=" + encodeURIComponent(ns)
      + "&per_page=" + (perPage || 200) + "&page=1", { headers: headers() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error((d && d.error && d.error.message) || ("读取失败 HTTP " + r.status));
    return (d.items || []).map(parseItem);
  }

  async function kvSave(ns, obj, extra) {
    const body = Object.assign({
      text: JSON.stringify(obj),
      tag: ns,
      source: ns
    }, extra || {});
    const r = await fetch(base() + "/app/fav/save", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error((d && d.error && d.error.message) || ("保存失败 HTTP " + r.status));
    /* 后端会把**刚存进去的那条**放在 items[0]（实测） */
    const first = (d.items || [])[0] || {};
    return { id: first.id, at: first.at };
  }

  async function kvDel(id) {
    const r = await fetch(base() + "/app/fav/item?id=" + encodeURIComponent(id), { method: "DELETE", headers: headers() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error((d && d.error && d.error.message) || ("删除失败 HTTP " + r.status));
    return true;
  }

  /* 改一条 = 删旧 + 存新（/app/fav 没有 update）。
     ⚠️ 顺序不能反：先存新的再删旧的，万一删错了至少数据还在。 */
  async function kvReplace(id, ns, obj, extra) {
    const nu = await kvSave(ns, obj, extra);
    if (id) { try { await kvDel(id); } catch (_) { } }
    return nu;
  }

  /* 云端优先；云端不可用就退回本地镜像（并标明来自本地，UI 上要说出来） */
  async function listSynced(ns) {
    try {
      const items = await kvList(ns);
      mirrorSet(ns, items);
      return { items: items, cloud: true, error: "" };
    } catch (e) {
      return { items: mirrorGet(ns), cloud: false, error: (e && e.message) || String(e) };
    }
  }
  function mirrorUpsert(ns, rec) {
    const arr = mirrorGet(ns).filter((x) => String(x.id) !== String(rec.id));
    arr.unshift(rec);
    mirrorSet(ns, arr);
  }
  function mirrorRemove(ns, id) {
    mirrorSet(ns, mirrorGet(ns).filter((x) => String(x.id) !== String(id)));
  }

  /* ── 模型调用 ─────────────────────────────────────────────────────────
     视觉描述 / 第一印象 / 朋友圈回复都走这里。走的是前端同一个中转后端，
     所以不用在前端放任何 Key。                                            */
  function activeConn() {
    try { return JSON.parse(localStorage.getItem(CONN_KEY) || "null"); } catch (_) { return null; }
  }
  function modelCfg() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(MODEL_KEY) || "null"); } catch (_) { }
    if (saved && saved.model) return saved;
    /* 没单独配就跟主聊天保持一致（智谱 v4 之类会对上） */
    const c = activeConn();
    if (c && c.model) return { provider: (c.provider || "cloud:deepseek").replace(/^cloud:/, ""), model: c.model };
    return { provider: "zhipu", model: "glm-4v-plus" };   // 默认挑一个能看图的
  }
  function setModelCfg(provider, model) { lsSet(MODEL_KEY, JSON.stringify({ provider: provider, model: model })); }

  function chatUrl(provider) {
    const pid = String(provider || "").replace(/^cloud:/, "");
    return base() + "/relay/" + pid + "/" + (VER[pid] || "v1") + "/chat/completions";
  }
  function pickText(m) {
    if (!m) return "";
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p && p.text) || "")).join("");
    return m.reasoning_content || "";
  }
  async function chat(opt) {
    const cfg = opt.model ? { provider: opt.provider, model: opt.model } : modelCfg();
    const body = {
      model: cfg.model,
      messages: opt.messages,
      temperature: opt.temperature == null ? 0.85 : opt.temperature
    };
    if (opt.json) body.response_format = { type: "json_object" };
    if (opt.maxTokens) body.max_tokens = opt.maxTokens;
    const r = await fetch(chatUrl(cfg.provider), {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (d && d.error && d.error.message) || ("HTTP " + r.status);
      const e = new Error(msg); e.status = r.status; e.provider = cfg.provider; e.model = cfg.model;
      throw e;
    }
    const m = d && d.choices && d.choices[0] && d.choices[0].message;
    return pickText(m);
  }

  /* 把一张图变成 data URL（给视觉模型用） */
  async function dataUrl(blobOrFile, mime) {
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ""));
      fr.onerror = rej;
      fr.readAsDataURL(blobOrFile);
    });
  }

  return {
    base, token, secret, headers, fileUrl,
    sha256, hashFile, shrink, uploadImage,
    kvList, kvSave, kvDel, kvReplace, listSynced, mirrorGet, mirrorSet, mirrorUpsert, mirrorRemove,
    chat, chatUrl, modelCfg, setModelCfg, activeConn, dataUrl
  };
})();
