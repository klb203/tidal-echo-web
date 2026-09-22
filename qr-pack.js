/* ══════════════════════════════════════════════════════════════════════════
   qr-pack.js · 条码（把一条记忆 / 一个世界书条目变成能扫走的东西）

   为什么是二维码而不是一维条码：一维条码容量只有几十个字符，只够放个编号，
   扫出来还得联网回原站取内容 —— 那就不叫"带走"了。二维码能把正文直接装进去
   （byte 模式，纠错 L 时上限约 2953 字节），扫出来就是完整内容，
   在没网、没后端、换设备的时候都能读。
   ★ 中文一个字算 3 字节，所以一张码大约装得下 900 个汉字 —— 超了就截断并提示。

   依赖：vendor/qrcode.min.js（davidshimjs/qrcodejs，MIT），必须在本文件之前加载。
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* ★ 容量上限说的是**编码之后**的字节数（QR 硬上限 2953，留点余量给纠错码）。
     为什么还要"编码"这一步 —— 实测踩到的：davidshimjs/qrcodejs 算容量时对多字节字符
     处理是错的，一段 153 字的中文 JSON 直接抛 `code length overflow. (2812>1552)`：
     它算出 2812 bit，却认为这个版本只有 1552 bit。纯 ASCII 走它自己的快路径没这个问题。
     所以：**含非 ASCII 就让原文先上 base64**（纯 ASCII，它的路径是对的），扫出来再还原。
     代价是体积涨三分之一，换来的是"中文一定画得出来"。 */
  const MAX_BYTES = 2900;
  const B64_TAG = "TIDALQR1:";   // 前缀：本页扫到会自动还原，别的扫码 App 也知道这是 tidal 的东西
  let el = null;                 // 弹层

  const $ = (s, r) => (r || document).querySelector(s);
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function nbytes(s) {
    try { return new TextEncoder().encode(String(s || "")).length; } catch (_) { return String(s || "").length * 3; }
  }
  /* 原文 → 二维码里实际要编的串 */
  function encodePayload(text) {
    const t = String(text == null ? "" : text);
    if (/^[\x20-\x7E\r\n\t]*$/.test(t)) return t;              // 纯可打印 ASCII，直接用
    try {
      return B64_TAG + btoa(unescape(encodeURIComponent(t)));       // UTF-8 → base64
    } catch (_) {
      return t;
    }
  }
  /* 二维码里读出来的串 → 原文 */
  function decodePayload(s) {
    const t = String(s == null ? "" : s);
    if (t.indexOf(B64_TAG) !== 0) return t;
    try {
      return decodeURIComponent(escape(atob(t.slice(B64_TAG.length))));
    } catch (_) {
      return t;
    }
  }
  function clip(s, n) {
    const t = String(s || "");
    return t.length <= n ? t : t.slice(0, n) + "…";
  }

  /* ── 弹层 DOM（自己注入，宿主不用写标记）───────────────────────────── */
  function ensure() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "qr-panel hidden";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "条码");
    el.innerHTML =
      '<div class="qr-card">' +
        '<div class="qr-head"><span class="qr-title">条码</span>' +
          '<button type="button" class="qr-x" data-qr="close" aria-label="关闭">✕</button></div>' +
        '<div class="qr-note" data-qr="note"></div>' +
        '<div class="qr-box" data-qr="box"></div>' +
        '<pre class="qr-text" data-qr="text"></pre>' +
        '<div class="qr-acts">' +
          '<button type="button" class="qr-btn primary" data-qr="save">保存图片</button>' +
          '<button type="button" class="qr-btn" data-qr="copy">复制内容</button>' +
          '<button type="button" class="qr-btn" data-qr="scan">扫一个</button>' +
        "</div>" +
      "</div>";
    document.body.appendChild(el);
    el.addEventListener("click", async (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t === el && !t.closest(".qr-card")) { close(); return; }      // 点遮罩关掉
      const b = t.closest("[data-qr]");
      if (!b) return;
      const act = b.dataset.qr;
      if (act === "close") return close();
      if (act === "save") return savePng();
      if (act === "copy") return copyText();
      if (act === "scan") return scan();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && el && !el.classList.contains("hidden")) { close(); e.stopPropagation(); }
    }, true);
    return el;
  }

  let curText = "";

  function show(text, opts) {
    opts = opts || {};
    const box = ensure();
    const raw = String(text == null ? "" : text);
    curText = raw;
    let enc = encodePayload(raw);
    let too = false;
    /* 超长就截断 —— 与其给一张扫出来是乱码的码，不如给个能读的，
       并在上面写清楚"只装下了前面这段"。先按比例估，再逐步回退到放得下为止。 */
    if (nbytes(enc) > MAX_BYTES) {
      too = true;
      let n = Math.floor(raw.length * (MAX_BYTES / Math.max(1, nbytes(enc))) * 0.95);
      while (n > 20 && nbytes(encodePayload(raw.slice(0, n))) > MAX_BYTES) n = Math.floor(n * 0.9);
      enc = encodePayload(raw.slice(0, n));
    }
    $(".qr-title", box).textContent = opts.title || "条码";
    $(".qr-note", box).innerHTML =
      (opts.note ? esc(opts.note) + "<br>" : "") +
      (too
        ? '<b>内容太长</b>（编完约 ' + nbytes(enc) + ' 字节 > ' + MAX_BYTES + "），这张码只装下了前面一段。" +
          "要完整带走请用「导出」。"
        : "扫这个码就能拿到完整内容（约 " + nbytes(enc) + " 字节，离线可读）。") +
      (enc.indexOf(B64_TAG) === 0
        ? "<br>内容是中文，已按 " + B64_TAG + " 编码进码里 —— <b>在本页「扫一个」会自动还原</b>；" +
          "用别的扫码 App 看到的是编码后的串。"
        : "");

    const host = $('[data-qr="box"]', box);
    host.innerHTML = "";
    const drawn = () => !!host.querySelector("canvas, img, table");
    if (typeof QRCode === "undefined") {
      host.innerHTML = '<div class="qr-err">二维码库没加载（vendor/qrcode.min.js）—— 刷新一次页面试试。</div>';
    } else {
      const opt = {
        text: enc, width: 252, height: 252,
        /* ★ 纠错级别用 L：它的容量最大。这类码是"贴屏对着扫"，
           不需要抗污损那点余量，容量才是稀缺的。 */
        correctLevel: (QRCode.CorrectLevel && QRCode.CorrectLevel.L) || 1,
        colorDark: "#1f2d3d", colorLight: "#ffffff",
      };
      try { new QRCode(host, opt); } catch (e) { /* 下面统一看结果 */ }
      /* ★ 兜底：有的环境 canvas 拿不到（隐私设置 / 老 WebView），库会先试 canvas 再抛错。
         这里不看异常、只看结果 —— 什么都没画出来就清空重来一次，让它退回自己的 table 渲染。
         （jsdom 冒烟里这条路径是真会走到的，不是假想。） */
      if (!drawn()) {
        try { host.innerHTML = ""; new QRCode(host, opt); } catch (_) { }
      }
      if (!drawn()) {
        host.innerHTML = '<div class="qr-err">这个环境画不出二维码（canvas 被禁了？）—— ' +
          "可以点下面的「复制内容」把内容带走。</div>";
      }
    }
    $('[data-qr="text"]', box).textContent = clip(raw, 400);
    box.classList.remove("hidden");
    requestAnimationFrame(() => box.classList.add("open"));
  }

  function close() {
    if (!el) return;
    el.classList.remove("open");
    setTimeout(() => { if (el && !el.classList.contains("open")) el.classList.add("hidden"); }, 220);
  }

  function canvasOf() {
    if (!el) return null;
    return $("canvas", el) || null;
  }

  function savePng() {
    const cv = canvasOf();
    if (!cv) { toastSafe("还没生成出来"); return; }
    try {
      const url = cv.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "tidal-qr-" + Date.now() + ".png";
      document.body.appendChild(a); a.click();
      setTimeout(() => { try { a.remove(); } catch (_) { } }, 1000);
      toastSafe("已保存图片");
    } catch (e) {
      toastSafe("保存失败：" + ((e && e.message) || e));
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(curText);
      toastSafe("内容已复制");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = curText; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toastSafe("内容已复制"); } catch (e) { toastSafe("复制失败"); }
      ta.remove();
    }
  }

  /* ── 扫一个：用浏览器自带的 BarcodeDetector（Chrome / 安卓 WebView 支持）。
     不支持就算了 —— 手机相机本来就能扫，没必要为了这个塞一个解码库进来。 */
  async function scan() {
    if (!("BarcodeDetector" in window)) {
      toastSafe("这个浏览器不支持在页内扫码 —— 直接用手机相机扫就行");
      return;
    }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch (e) {
      toastSafe("拿不到摄像头权限：" + ((e && e.message) || e));
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "qr-scan";
    wrap.innerHTML = '<video playsinline></video><div class="qr-scan-tip">对准条码…</div>' +
      '<button type="button" class="qr-btn" data-scan="stop">停止</button>';
    $(".qr-card", ensure()).appendChild(wrap);
    const video = $("video", wrap);
    video.srcObject = stream;
    try { await video.play(); } catch (_) { }
    const det = new window.BarcodeDetector({ formats: ["qr_code"] });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { }
      try { wrap.remove(); } catch (_) { }
    };
    wrap.addEventListener("click", (e) => {
      if (e.target.closest('[data-scan="stop"]')) stop();
    });
    const tick = async () => {
      if (stopped) return;
      try {
        const codes = await det.detect(video);
        if (codes && codes.length && codes[0].rawValue) {
          const val = decodePayload(String(codes[0].rawValue));    // TIDALQR1: 前缀会自动还原
          stop();
          show(val, { title: "扫到的内容", note: "下面是这个码里装的东西。" });
          return;
        }
      } catch (_) { }
      setTimeout(tick, 320);
    };
    tick();
  }

  function toastSafe(msg) {
    try {
      if (typeof window.showToast === "function") { window.showToast(msg); return; }
      if (typeof window.toast === "function") { window.toast(msg); return; }
    } catch (_) { }
    console.log("[qr]", msg);
  }

  /* ── 给别处用的两个便利函数 ────────────────────────────────────────── */
  function fromWorldbook(item) {
    /* 世界书条目 → 标准 JSON。带着 tidal 标记与版本号，
       扫出来的人（或本机导入）一看就知道这是什么、能不能认。 */
    const one = {
      title: item.title || "", content: item.content || "", category: item.category || "",
      key: Array.isArray(item.key) ? item.key : String(item.key || "").split(/[,，\n]/).filter(Boolean),
      keysecondary: Array.isArray(item.keysecondary) ? item.keysecondary
        : String(item.keysecondary || "").split(/[,，\n]/).filter(Boolean),
      constant: !!item.constant, selectiveLogic: item.selectiveLogic || 0,
      position: item.position, depth: item.depth, role: item.role, order: item.order,
      scanDepth: item.scanDepth, useProbability: !!item.useProbability,
      probability: item.probability, caseSensitive: !!item.caseSensitive,
      matchWholeWords: !!item.matchWholeWords, disable: !!item.disable,
    };
    return JSON.stringify({ tidal: "worldbook", v: 1, item: one });
  }

  function fromMemory(item) {
    /* 两种形状都收：接口回的是**扁平**字段（title / keywords 在顶层），
       老调用点传的是 {meta:{…}}。带上关键词与档位 —— 扫出来的人才知道
       这条记忆"该怎么想起来"，而不是只有一段正文。 */
    const meta = item.meta || {};
    const pick = (k) => (item[k] !== undefined ? item[k] : meta[k]);
    return JSON.stringify({
      tidal: "memory", v: 1,
      item: {
        kind: item.kind || "", title: pick("title") || "", content: item.content || "",
        importance: pick("importance"), pinned: !!pick("pinned"),
        keywords: pick("keywords") || [], reason: pick("reason") || "",
        tier: pick("tier") || "", source: pick("source") || "",
        created_at: item.at || item.created_at || "",
      },
    });
  }

  window.Barcode = { show: show, close: close, scan: scan,
                     encodePayload: encodePayload, decodePayload: decodePayload,
                     fromWorldbook: fromWorldbook, fromMemory: fromMemory,
                     maxBytes: MAX_BYTES };
})();
