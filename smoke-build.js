/* 版本自检 + 一键更新 冒烟：假 DOM + 假 fetch。
   验四件事：① 版本不一致顶 bar；② 一致就不打扰；③ 离线静默；④ 点「更新」真的清缓存 + 重载。 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const DIR = __dirname;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const eq = (n, g, w) => {
  const deep = (v) => v !== null && typeof v === "object";
  const same = (deep(g) || deep(w)) ? JSON.stringify(g) === JSON.stringify(w) : g === w;
  if (same) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + "\n      得到 " + JSON.stringify(g) + "\n      期望 " + JSON.stringify(w)); }
};

const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
/* ★ 起点要包住外层那个 (function(){ —— 只从 var BUILD 开始切，
   切出来的代码会多一个 "})();"，直接 SyntaxError（第一版就这么错的）。 */
const A = 'var BUILD = "v';
const b = html.indexOf("})();", html.indexOf(A));
const a = html.lastIndexOf("(function(){", html.indexOf(A));
if (a < 0 || b < 0) { console.log("✗ 抠不出版本自检代码（锚点变了？）"); process.exit(1); }
const CODE = html.slice(a, b + 5);
console.log("抠出 " + CODE.length + " 字符；BUILD = " + (/var BUILD = "(v\d+)"/.exec(CODE) || [])[1] + "\n");

/* 按给定的 sw.js 内容跑一遍，返回观察结果 */
function run(swText, opts) {
  opts = opts || {};
  /* jsdom 的 location.reload 是**打不了桩**的（它是特殊对象，赋值会被忽略）。
     好在这件事有别的观察口：真调了 reload，jsdom 会往 virtualConsole 报一句
     "Not implemented: navigation to another Document" —— 拿它当"确实重载了"的证据。 */
  const vcMsgs = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => vcMsgs.push(String((e && e.message) || e)));
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "https://tidal.example/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const got = { fetchUrls: [], cacheKeys: 0, cacheDeleted: [], reloaded: 0, regUpdates: 0, bar: null };

  w.fetch = (url, o) => {
    got.fetchUrls.push(String(url));
    got.fetchOpts = o;
    if (opts.rejectFetch) return Promise.reject(new Error("offline"));
    if (opts.notFound) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(swText) });
  };
  w.caches = {
    keys: () => Promise.resolve(["companion-v127-old", "companion-v126-old2"]),
    delete: (k) => { got.cacheDeleted.push(k); return Promise.resolve(true); },
  };
  w.navigator.serviceWorker = {
    getRegistrations: () => Promise.resolve([{ update: () => { got.regUpdates++; return Promise.resolve(); } }]),
  };
  got.vcMsgs = vcMsgs;

  w.eval(CODE);
  return new Promise((res) => setTimeout(() => {
    got.bar = w.document.getElementById("buildBar");
    got.w = w;
    /* 重载的观察口：virtualConsole 里那句 "Not implemented ... navigation" */
    got.reloaded = vcMsgs.filter((m) => /navigation to another Document/i.test(m)).length;
    res(got);
  }, 60));
}

(async () => {
  const SW_NEW = 'const CACHE = "companion-v999-newer";   // 线上更新了\nconst X = 1;\n';
  const SW_SAME = 'const CACHE = "companion-v128-package";\n';

  console.log("【① 线上版本更新了 → 顶 bar】");
  let g = await run(SW_NEW);
  ok(!!g.bar, "buildBar 被创建了");
  ok(g.bar && g.bar.classList.contains("on"), "bar 显示出来了（class=on）");
  eq("文案里带线上版本", g.bar && /v999/.test(g.bar.textContent), true);
  eq("文案里也带本页版本（方便一眼看出差在哪）", g.bar && /v128/.test(g.bar.textContent), true);
  ok(g.bar && /更新/.test(g.bar.querySelector("button").textContent), "有「更新」按钮");
  ok(g.fetchUrls.length === 1 && /sw\.js\?build=\d+/.test(g.fetchUrls[0]), "去读的是带时间戳的 sw.js（绕缓存）");
  ok(g.fetchOpts && g.fetchOpts.cache === "no-store", "★ 用了 no-store（否则拿旧文件判断有没有更新是自欺）");

  console.log("\n【② 点「更新」→ 更新SW + 清缓存 + 重载】");
  g.bar.querySelector("button").dispatchEvent(new g.w.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  /* ★ 重载的观察口要**点完之后**再数一次 —— 上面那次是在点击前算的（第一版就错在这） */
  g.reloaded = (g.vcMsgs || []).filter((m) => /navigation to another Document/i.test(m)).length;
  eq("更新了 SW 注册", g.regUpdates, 1);
  eq("★ 删掉了旧的缓存（两个）", g.cacheDeleted, ["companion-v127-old", "companion-v126-old2"]);
  eq("重载了页面", g.reloaded, 1);
  ok(/更新中/.test(g.bar.querySelector("button").textContent), "按钮变成「更新中…」（防连点）");

  console.log("\n【③ 版本一致 → 完全不打扰】");
  g = await run(SW_SAME);
  eq("没有创建 bar", g.bar, null);
  eq("仍然读了一次 sw.js（拿不到就没法比对）", g.fetchUrls.length, 1);

  console.log("\n【④ 离线 / 拿不到 → 静默，不弹错】");
  g = await run("", { rejectFetch: true });
  eq("离线时没有 bar", g.bar, null);
  g = await run("", { notFound: true });
  eq("404 时没有 bar", g.bar, null);
  g = await run("这不是 sw.js，没有版本号");
  eq("内容里没有版本号时不误报", g.bar, null);

  console.log("\n【⑤ 手动兜底入口】");
  g = await run(SW_SAME);
  eq("window.__buildUpdate 可手动调", typeof g.w.__buildUpdate, "function");
  eq("window.BUILD 暴露出来（以后好问「你是哪个版本」）", typeof g.w.BUILD, "string");
  ok(/^v\d+$/.test(g.w.BUILD || ""), "BUILD 是 vNNN 形式：" + g.w.BUILD);

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
