/* 记忆库（AionsHome 那套）冒烟：假 DOM + 假 fetch 里真跑 index.html 里那一段代码。
   验的是**请求路由与状态**（不是渲染长得对不对）——
   这正是"只能 node --check 就推上去"最容易漏掉的一段。

   做法：把 index.html 里的「记忆库」整段抠出来 eval（不是加载整个 67 万字的 inline script
   —— 那会把几百个无关的监听器也跑起来，测试反而不稳）。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const DIR = __dirname;
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } }

const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const START = "/* ════════════ 记忆库（AionsHome：日常 / 长期重要 两档）";
const END = 'if ($("#dyList")) $("#dyList").addEventListener("click", (e) => {';
const a = html.indexOf(START);
const b = html.indexOf(END, a);
if (a < 0 || b < 0) { console.log("✗ 抠不出记忆库代码段（锚点变了？）"); process.exit(1); }
const CODE = html.slice(a, b);
console.log("抠出记忆库代码段：" + CODE.length + " 字符\n");

// ── 假 DOM：把这一页用到的 id 都摆上 ──────────────────────────────────
const IDS = ["mlLead", "mlTag", "mlTabs", "mlNew", "mlTidy", "mlRefresh", "mlStatus",
             "mlEdit", "mlBody", "mlKw", "mlReason", "mlTier", "mlImp", "mlImpVal",
             "mlSaveBtn", "mlCancelBtn", "mlTidyBox", "mlList"];
const dom = new JSDOM("<!doctype html><html><body>" +
  IDS.map((i) => '<div id="' + i + '"></div>').join("") +
  '<div id="mlTabsInner"></div>' +
  "</body></html>", { url: "https://tidal.example/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
// 分类按钮（真实结构里是 #mlTabs 里的三个 button）
w.document.getElementById("mlTabs").innerHTML =
  ["all", "daily", "long_term"].map((k) => '<button type="button" data-mlt="' + k + '">' + k + "</button>").join("");

// ── 假 fetch：把每次请求记下来，按 URL 回数据 ─────────────────────────
const reqs = [];
let LIST_PAYLOAD = { items: [] };
let TIDY_PAYLOAD = { ops: [], scanned: 0, dry_run: true };
let FAIL_NEXT = "";
w.fetch = (url, opt) => {
  const body = opt && opt.body ? JSON.parse(opt.body) : null;
  reqs.push({ url: String(url), method: (opt && opt.method) || "GET", body });
  if (FAIL_NEXT) {
    const m = FAIL_NEXT; FAIL_NEXT = "";
    return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: { message: m } }) });
  }
  let d = { ok: true };
  if (String(url).indexOf("/app/memory/list") >= 0) d = { ok: true, items: LIST_PAYLOAD.items, counts: {} };
  else if (String(url).indexOf("/app/memory/tidy") >= 0) {
    d = Object.assign({ ok: true }, TIDY_PAYLOAD);
    if (body && body.dry_run === false) d = { ok: true, dry_run: false, applied: 3, fails: [], counts: {} };
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(d) });
};

// ── 宿主函数桩 ───────────────────────────────────────────────────────
const toasts = [];
w.eval(`
  var $ = (s) => document.querySelector(s);
  var escapeHtml = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  var showToast = (m) => { window.__toasts.push(String(m)); };
  var authHeaders = () => ({});
  var appUrl = (p) => "https://relay.example" + p;
  var memApi = async (p, opt) => {
    const r = await fetch(appUrl(p), Object.assign({
      headers: Object.assign({}, authHeaders(), (opt && opt.body) ? { "Content-Type": "application/json" } : {})
    }, opt || {}));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error && d.error.message) || ("HTTP " + r.status));
    return d;
  };
  var memData = { items: {}, itemIndex: {} };
  window.__toasts = [];
`);
w.__toasts = toasts;
let CONFIRM = true;
w.confirm = () => CONFIRM;

w.eval(CODE + "\nwindow.__mlData = mlData;");
/* ★ let 声明的变量**不会**挂到 window 上（只有 function 声明会）。
   所以要**接在同一段 eval 后面**暴露（分两次 eval 会 ReferenceError） —— 这也是个真实的坑：
   在控制台 w.__mlData 是 undefined，但代码里 mlData 用得好好的。 */
ok(typeof w.mlLoad === "function", "mlLoad 定义出来了（代码段真的跑起来了）");
ok(!!w.__mlData, "状态取到了（let 不会挂到 window，得单独暴露）");

// ── 1) 纯函数 ─────────────────────────────────────────────────────────
ok(w.mlTierOf({ tier: "long_term" }) === "long_term", "mlTierOf 认显式 tier");
ok(w.mlTierOf({ importance: 9 }) === "long_term", "mlTierOf：重要度 ≥7 算长期");
ok(w.mlTierOf({ importance: 5 }) === "daily", "mlTierOf：5 分算日常");
ok(w.mlTierOf({ pinned: true }) === "daily".replace("daily", "long_term"), "mlTierOf：pinned 算长期");
ok(w.mlSourceLabel({ source: "ai" }) === "它写的", "来源标：ai → 它写的");
ok(w.mlSourceLabel({ source: "" }) === "你写的", "来源标：空 → 你写的");
ok(w.mlSourceLabel({ source: "nearfield" }) === "自动", "来源标：机器路径 → 自动");

// ── 2) 加载：路由对、fragment 被排除、计数对 ───────────────────────────
(async () => {
  LIST_PAYLOAD = { items: [
    { id: "1", kind: "event", source: "ai", content: "楼下橘猫", keywords: ["橘猫"], tier: "daily",
      importance: 5, label: "事件", ts: "2026-09-21T10:00:00" },
    { id: "2", kind: "story", source: "", content: "她搬花", keywords: [], tier: "long_term",
      importance: 9, label: "故事", ts: "2026-09-20T10:00:00" },
    { id: "3", kind: "fragment", source: "scenes", content: "跑过某工具", keywords: [],
      tier: "daily", importance: 3, label: "片段", ts: "2026-09-19T10:00:00" },
    { id: "4", kind: "summary", source: "nearfield", content: "机器压缩出来的老摘要", keywords: [],
      tier: "daily", importance: 5, label: "摘要", ts: "2026-09-18T10:00:00" },
    { id: "5", kind: "ref", source: "", content: "参考资料", keywords: [],
      tier: "daily", importance: 5, label: "参考资料", ts: "2026-09-17T10:00:00" },
  ] };
  await w.mlLoad(true);
  const listReq = reqs.filter((r) => r.url.indexOf("/app/memory/list") >= 0);
  ok(listReq.length === 1, "加载打了 /app/memory/list 一次");
  ok(/limit=200/.test(listReq[0].url), "带上了 limit=200");
  ok(w.__mlData.items.length === 2, "★ fragment（素材）被排除，只剩 2 条");
  ok(!w.__mlData.items.some((x) => x.kind === "summary"), "★ summary（机器老摘要）不占记忆库");
  ok(!w.__mlData.items.some((x) => x.kind === "ref"), "★ ref（参考资料）不占记忆库");
  ok(w.$("#mlTag").textContent === "2 条", "计数标签 = 2 条");
  ok(/它自己写的 1 条/.test(w.$("#mlLead").textContent), "副标题标出「它自己写的 1 条」");

  // 渲染出来的条目
  const items = w.document.querySelectorAll("#mlList .ml-item");
  ok(items.length === 2, "渲染出 2 个条目");
  const firstHtml = w.document.querySelector("#mlList").innerHTML;
  ok(/from-ai/.test(firstHtml), "它写的那条带 from-ai 样式标");
  ok(/它写的/.test(firstHtml) && /你写的/.test(firstHtml), "两条的来源标都对");
  ok(/ml-kw/.test(firstHtml) && /#橘猫/.test(firstHtml), "关键词渲染成 chip");
  ok(/长期重要/.test(firstHtml) && /日常/.test(firstHtml), "两档标签都画出来了");
  ok(/data-mledit/.test(firstHtml) && /data-mldel/.test(firstHtml), "编辑/删除按钮在");

  // ── 3) 筛选 ─────────────────────────────────────────────────────────
  w.__mlData.filter = "long_term"; w.mlRender();
  ok(w.document.querySelectorAll("#mlList .ml-item").length === 1, "筛「长期重要」只剩 1 条");
  w.__mlData.filter = "daily"; w.mlRender();
  ok(w.document.querySelectorAll("#mlList .ml-item").length === 1, "筛「日常」只剩 1 条");
  w.__mlData.filter = "all"; w.mlRender();

  // ── 4) 新增：payload 对不对 ─────────────────────────────────────────
  reqs.length = 0; toasts.length = 0;
  w.mlEditOpen(null);
  ok(w.$("#mlBody").value === "" && w.$("#mlSaveBtn").textContent === "保存", "空手打开编辑器是「新增」态");
  w.$("#mlBody").value = "她下周三要去医院复查";
  w.$("#mlKw").value = "医院,复查";
  w.$("#mlReason").value = "她亲口说的";
  w.$("#mlTier").value = "long_term";
  w.$("#mlImp").value = "9";
  await w.mlSave();
  const saveReq = reqs.find((r) => r.url.indexOf("/app/memory/save") >= 0);
  ok(!!saveReq && saveReq.method === "POST", "新增打了 POST /app/memory/save");
  ok(saveReq.body.content === "她下周三要去医院复查", "正文传对了");
  ok(saveReq.body.keywords === "医院,复查", "关键词传对了");
  ok(saveReq.body.reason === "她亲口说的", "理由传对了");
  ok(saveReq.body.tier === "long_term", "档位传对了");
  ok(saveReq.body.importance === 9, "重要度传对了（数字不是字符串）");
  ok(saveReq.body.id === undefined, "新增不带 id");
  ok(w.$("#mlEdit").className.indexOf("hidden") >= 0, "存完编辑器收起来了");
  ok(listReq && reqs.filter((r) => r.url.indexOf("/app/memory/list") >= 0).length >= 1, "存完自动刷新了列表");

  // ── 5) 空正文不许存 ─────────────────────────────────────────────────
  reqs.length = 0; toasts.length = 0;
  w.mlEditOpen(null);
  w.$("#mlBody").value = "   ";
  await w.mlSave();
  ok(reqs.length === 0, "空正文不发请求");
  ok(/不能空/.test(toasts.join("")), "空正文给了提示");

  // ── 6) 编辑：带 id 打同一个接口 ─────────────────────────────────────
  reqs.length = 0;
  w.mlEditOpen(w.__mlData.items[0]);
  ok(w.$("#mlBody").value === "楼下橘猫", "编辑时正文回填了");
  ok(w.$("#mlKw").value === "橘猫", "编辑时关键词回填了");
  ok(w.$("#mlSaveBtn").textContent === "保存修改", "按钮文案变成「保存修改」");
  w.$("#mlBody").value = "楼下橘猫（改过）";
  await w.mlSave();
  const editReq = reqs.find((r) => r.url.indexOf("/app/memory/save") >= 0);
  ok(editReq && editReq.body.id === "1", "编辑带了 id=1");

  // ── 7) 删除：DELETE + id 参数 ───────────────────────────────────────
  reqs.length = 0; toasts.length = 0;
  CONFIRM = false;
  await w.mlDelete("2");
  ok(reqs.length === 0, "确认框点「取消」就不删");
  CONFIRM = true;
  await w.mlDelete("2");
  const delReq = reqs.find((r) => r.method === "DELETE");
  ok(!!delReq, "删除打了 DELETE");
  ok(/\/app\/memory\/item\?id=2/.test(delReq.url), "id 在 query 上（后端读的正是这个参数名）");
  ok(!w.__mlData.items.find((x) => x.id === "2"), "本地列表里也移掉了");

  // ── 8) 整理：必须两段式（dry_run 先看，应用才落库）──────────────────
  reqs.length = 0;
  TIDY_PAYLOAD = { dry_run: true, scanned: 2, ops: [
    { op: "merge", ids: ["1", "2"], content: "合并后的", keywords: ["橘猫"], reason: "重复",
      tier: "long_term", importance: 8, before: ["a", "b"] },
    { op: "add", content: "新增的", keywords: [], tier: "daily", importance: 5 },
  ] };
  await w.mlTidy();
  const t1 = reqs.find((r) => r.url.indexOf("/app/memory/tidy") >= 0);
  ok(!!t1 && t1.body.dry_run === true, "★ 第一次整理必须 dry_run:true（先看预览）");
  const boxHtml = w.$("#mlTidyBox").innerHTML;
  ok(/ml-op/.test(boxHtml), "预览渲染出来了");
  ok(/合并/.test(boxHtml) && /新增一条/.test(boxHtml), "两种 op 的中文标签都在");
  ok(/mlTidyApply/.test(boxHtml), "有「应用」按钮");
  ok(/重复/.test(boxHtml) && /橘猫/.test(boxHtml), "理由与关键词都显示出来");

  reqs.length = 0;
  await w.mlTidyApply();
  const t2 = reqs.find((r) => r.url.indexOf("/app/memory/tidy") >= 0);
  ok(!!t2 && t2.body.dry_run === false, "★ 应用才发 dry_run:false");
  ok(w.$("#mlTidyBox").className.indexOf("hidden") >= 0, "应用后预览收起来了");

  // ── 9) 出错要有明确文案，不能静默 ───────────────────────────────────
  FAIL_NEXT = "缺「小助手 · 中转站地址」";
  await w.mlTidy();
  ok(/中转站地址/.test(w.$("#mlStatus").textContent), "整理失败时状态行显示后端原文案");
  ok(/err/.test(w.$("#mlStatus").className), "状态行标成错误态");

  // ── 10) 空库要说话，不是一片空白 ────────────────────────────────────
  LIST_PAYLOAD = { items: [] };
  await w.mlLoad(true);
  ok(/空/.test(w.$("#mlStatus").textContent), "空库时状态行有说明");
  ok(/arc-empty/.test(w.$("#mlList").innerHTML), "空库时列表区有占位文案");

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
