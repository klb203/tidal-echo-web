/* Tidal Echo · 思考过程显示（💭 按钮 + 弹层）冒烟测试
 *
 * 对齐目标（AionsHome）：思考不再铺在对话里，收进那条 AI 回复自己的 💭 按钮，
 * 点开才看。所以这里验三件事：
 *   ① buildVirtualRows：thinking **不再单独成行**，而是挂到紧随的 AI 回复上
 *   ② makeMessage：有思考才出现 💭 按钮；没思考就没有
 *   ③ 弹层：点按钮能开、能关、内容正确
 *
 * 用法：node smoke-think.js   （NODE_PATH 要指向装了 jsdom 的地方）
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };
const eq = (n, got, want) => ok(JSON.stringify(got) === JSON.stringify(want),
  n + (JSON.stringify(got) === JSON.stringify(want) ? "" : "\n      得到 " + JSON.stringify(got) + "\n      期望 " + JSON.stringify(want)));

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const errs = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errs.push(String((e && e.message) || e).slice(0, 200)));
vc.on("error", (...a) => errs.push("console.error: " + a.map(String).join(" ").slice(0, 200)));

const dom = new JSDOM(html, {
  url: "https://klb203.github.io/tidal-echo-web/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    /* 环境缺件必须补（否则宿主脚本一开头就抛错、后面全不执行）：
       jsdom 没有 matchMedia / fetch / canvas —— 上一轮诊断踩过这个坑。 */
    win.matchMedia = win.matchMedia || function () {
      return { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    };
    if (typeof win.fetch !== "function") {
      win.fetch = () => Promise.resolve({
        ok: false, status: 503,
        json: () => Promise.resolve({ error: { message: "（测试桩）后端不可达" } }),
        text: () => Promise.resolve(""), body: null,
      });
    }
    win.HTMLCanvasElement.prototype.getContext = function () {
      const g = { addColorStop() {} };
      return new Proxy({}, {
        get(_, k) {
          if (k === "createRadialGradient" || k === "createLinearGradient") return () => g;
          if (k === "measureText") return () => ({ width: 0 });
          if (k === "getImageData") return () => ({ data: [] });
          return typeof k === "string" ? function () {} : undefined;
        },
        set() { return true; },
      });
    };
  },
});
const w = dom.window, d = w.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(900);

  console.log("【加载】");
  ok(!errs.length, "加载期无错误" + (errs.length ? "：" + errs[0] : ""));
  ok(typeof w.buildVirtualRows === "function", "buildVirtualRows 可用（宿主顶层函数）");
  ok(typeof w.makeMessage === "function", "makeMessage 可用");

  console.log("\n【① thinking 不再单独成行】");
  let rows = [];
  try { rows = w.buildVirtualRows() || []; } catch (e) { console.log("    buildVirtualRows 抛出：" + (e && e.message)); }
  console.log("    行数:", rows.length, "| 行类型:", JSON.stringify([...new Set(rows.map((r) => r.type))]));
  eq("★ 没有 type=thinking 的行了", rows.some((r) => r.type === "thinking"), false);

  /* 注入一对「思考 + 回复」，走**真实的**行构造路径。
     数据源是 chatMessages（顶层 let，不挂 window）→ 用宿主的 setMessage 塞进去，
     这比 eval 取变量稳。 */
  console.log("\n【② 思考挂到 AI 回复上】");
  const now = Date.now();
  if (typeof w.setMessage === "function") {
    w.setMessage({ id: 990001, ts: new Date(now).toISOString(), from: "ai", kind: "thinking",
                   text: "先把数对一遍：1200 减 480…", meta: {} });
    w.setMessage({ id: 990002, ts: new Date(now + 1000).toISOString(), from: "ai", kind: "reply",
                   text: "我算了一下，够的。", meta: {} });
    rows = w.buildVirtualRows() || [];
    console.log("    注入后行数:", rows.length, "| 类型:", JSON.stringify([...new Set(rows.map((r) => r.type))]));
    eq("★ 仍然没有 thinking 行（思考不占位）", rows.some((r) => r.type === "thinking"), false);
    const rep = rows.filter((r) => r.type === "message" && r.message.kind === "reply").pop();
    ok(!!rep, "回复那条成行了");
    eq("★ 思考挂到了回复上", rep && rep.thinking, "先把数对一遍：1200 减 480…");
    const think = rows.filter((r) => r.type === "message" && r.message.kind === "thinking");
    eq("★ 思考本身不再是一条消息行", think.length, 0);
  } else {
    console.log("    （没有 setMessage，跳过注入）");
  }
  const key = "t-" + Date.now();
  const mk = (kind, text, from) => ({ id: Math.floor(Math.random() * 1e6), _key: key + ":" + kind,
    ts: new Date().toISOString(), from: from || "ai", kind, text, meta: {} });
  console.log("    （下面再直接验 makeMessage，它对行的依赖最少）");
  const rowThink = w.makeMessage({ message: mk("reply", "我算了一下，够的。"), thinking: "先把数对一遍：1200 减 480…" });
  const htmlThink = rowThink.innerHTML;
  ok(htmlThink.indexOf("data-think-btn") >= 0, "★ 有思考 → 出现 💭 按钮");
  ok(htmlThink.indexOf("💭") >= 0, "按钮上是 💭");
  ok(rowThink.dataset.messageKey === key + ":reply", "行上带着 messageKey（点击时靠它取文本）");

  const rowPlain = w.makeMessage({ message: mk("reply", "嗯。") });
  ok(rowPlain.innerHTML.indexOf("data-think-btn") < 0, "★ 没有思考 → 不出现按钮（不占地方）");
  const rowEmpty = w.makeMessage({ message: mk("reply", "好。"), thinking: "" });
  ok(rowEmpty.innerHTML.indexOf("data-think-btn") < 0, "思考是空串 → 也不出现按钮");

  console.log("\n【③ 弹层：点开 / 内容 / 关闭】");
  const btn = rowThink.querySelector("[data-think-btn]");
  ok(!!btn, "按钮在 DOM 里");

  /* ★ 位置：按钮要在**气泡外面**，而且排在那条气泡**之前**（也就是消息上方）。
     两条必须一起验 —— 只说"在 row 里"不够（放在气泡之后也满足），
     只说"不在 bubble 里"也不够（飘到行尾同样是错的）。
     这一版就是从气泡里搬到上面的，所以这几条是防它搬回去。 */
  const _bb = rowThink.querySelector(".bubble");
  ok(!!_bb && !_bb.contains(btn), "★ 💭 按钮不在气泡里（气泡里只剩正文与时间）");
  const _tl = rowThink.querySelector(".think-line");
  ok(!!_tl && _tl === btn.parentElement, "★ 按钮住在 .think-line 里（专为它开的那一行）");
  const _kids = Array.prototype.slice.call(rowThink.children);
  ok(_kids.indexOf(_tl) >= 0 && _kids.indexOf(_tl) < _kids.indexOf(_bb),
     "★ 那一行排在气泡之前 = 在消息上方", _kids.map((k) => k.className));
  ok(/\.think-line\{[^}]*flex:\s*0 0 100%/.test(html) && /\.think-line\{[^}]*order:\s*-1/.test(html),
     "CSS：.think-line 独占一行、且 order 排在前面（不换行就压不住气泡）");
  ok(/\.row\{[^}]*flex-wrap:\s*wrap/.test(html), "CSS：.row 允许换行（否则那条 100% 宽的行会把气泡挤扁）");
  /* ★ 必须把行**插进文档**再点：点击是委托在 document 上的，
     游离节点的 click 冒泡不到 document —— 第一版就是这么假红的。 */
  d.body.appendChild(rowThink);
  btn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  let pop = d.getElementById("thinkPop");
  ok(!!pop, "点一下 → 弹层被创建");
  ok(pop && !pop.classList.contains("hidden"), "弹层可见（不是 hidden）");
  const body = pop && pop.querySelector(".think-pop-body");
  eq("★ 弹层里是那条思考的原文", body && body.textContent, "先把数对一遍：1200 减 480…");
  ok(!!pop.querySelector("[data-think-close]"), "有关闭按钮");

  /* 关：点遮罩 */
  pop.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await sleep(300);
  ok(pop.classList.contains("hidden"), "点遮罩 → 关掉");

  console.log("\n【④ 边界】");
  const rowHuman = w.makeMessage({ message: mk("reply", "我说的话", "human"), thinking: "不该挂到人的消息上" });
  /* 人的消息本来就不会被挂（buildVirtualRows 里限定了 m.from === "ai"），
     但万一被挂上，也不该崩 —— 这里只确保渲染不抛错 */
  ok(!!rowHuman, "人的消息带 thinking 也不崩");

  console.log("\n【⑤ 老路径保留（不做删代码式的大改）】");
  ok(typeof w.buildVirtualRows === "function", "buildVirtualRows 仍在");

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  if (errs.length) { console.log("加载期错误："); errs.slice(0, 5).forEach((e) => console.log("  " + e)); }
  process.exit(fail ? 1 : 0);
})();
