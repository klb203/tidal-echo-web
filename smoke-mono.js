/* Tidal Echo · 大富翁「荷官 / 阿澈 是两个 AI」冒烟测试
 *
 * 验的是**归属与判定逻辑**，不是渲染长得对不对：
 *   · taskForAche  放宽后认不认得出各种写法的任务行
 *   · stripNonDealer 荷官越界写的别人台词有没有被摘掉（而它自己的和结构行要留）
 *   · acheCastName 阿澈在牌桌上的名字（无副作用）
 *   · landMonoTurn 一回合有没有落成**两条**（各归各家），失败时有没有说明
 *   · monoBubbles  按 by 渲染的归属对不对（荷官 vs 阿澈）
 *
 * 用法：node smoke-mono.js     （需要 NODE_PATH 指向装了 jsdom 的地方）
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function eq(name, got, want) {
  const deep = (v) => v !== null && typeof v === "object";
  const same = (deep(got) || deep(want))
    ? JSON.stringify(got) === JSON.stringify(want)
    : got === want;
  if (same) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + "\n      得到 " + JSON.stringify(got) + "\n      期望 " + JSON.stringify(want)); }
}

/* 从 rp-channel-pack.js 里抠出指定函数的源码（大括号配平）。
   比加载整份 2886 行的 IIFE 稳 —— 后者依赖宿主一堆东西。 */
function grab(src, name) {
  const at = src.indexOf("  function " + name + "(");
  if (at < 0) throw new Error("找不到函数 " + name);
  const b = src.indexOf("{", at);
  let depth = 0, k = b;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(at, k + 1);
}

const SRC = fs.readFileSync(path.join(__dirname, "rp-channel-pack.js"), "utf8");
const CODE = [
  grab(SRC, "acheCastName"),
  grab(SRC, "taskForAche"),
  grab(SRC, "stripNonDealer"),
  grab(SRC, "pushMono"),
  grab(SRC, "landMonoTurn"),
  grab(SRC, "monoBubbles"),
].join("\n\n");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://x/", runScripts: "outside-only", pretendToBeVisual: true,
});
const w = dom.window;

/* ── 最小桩：只给被测函数真正用到的东西 ─────────────────────────── */
const STUB = `
var AV_KEY = "companion_avatar";
var state = {
  mono: {
    setup: { p1_name: "主人", p2_name: "阿澈" },
    ai: { p1: false, p2: true },
    msgs: []
  }
};
function nid(p) { return p + (++nid._n); }
nid._n = 0;
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function mdInline(s) { return esc(s); }
function lsStr() { return ""; }
function monoCast() {
  /* 与真实现同形：名字 → 角色信息 */
  return {
    "主人": { name: "主人", ai: false, avatar: "", color: "#5E7080" },
    "阿澈": { name: "阿澈", ai: true, avatar: "", color: "#B0713A" },
    "小满": { name: "小满", ai: true, avatar: "", color: "#B0713A" }
  };
}
var PUSHED = [];
`;
w.eval(STUB + "\n" + CODE + "\nwindow.__t = { acheCastName: acheCastName, taskForAche: taskForAche,"
  + " stripNonDealer: stripNonDealer, landMonoTurn: landMonoTurn, monoBubbles: monoBubbles,"
  + " PUSHED: PUSHED, state: state };");
const T = w.__t;

console.log("【acheCastName】阿澈在牌桌上的名字");
eq("AI 在 p2 → 取 p2_name", T.acheCastName(), "阿澈");
T.state.mono.ai = { p1: true, p2: false };
eq("AI 在 p1 → 取 p1_name", T.acheCastName(), "主人");
T.state.mono.setup.p1_name = "";
eq("名字空 → 兜底「阿澈」", T.acheCastName(), "阿澈");
T.state.mono.ai = { p1: false, p2: true };
T.state.mono.setup.p2_name = "阿澈";

console.log("\n【taskForAche】任务行（放宽后要认得出各种写法）");
eq("标准写法", T.taskForAche("【给阿澈的任务】去旧书店找它"), "去旧书店找它");
eq("带冒号", T.taskForAche("【给阿澈的任务】：把骰子掷了"), "把骰子掷了");
eq("★ 换成「阿澈的任务」也认", T.taskForAche("【阿澈的任务】挑一个买"), "挑一个买");
eq("★ 简写成「给阿澈」也认", T.taskForAche("【给阿澈】去交罚金"), "去交罚金");
eq("★ 「要做的」也认", T.taskForAche("【阿澈要做的】解释一下刚才那步"), "解释一下刚才那步");
eq("多行：只取到下一个【", T.taskForAche("【给阿澈的任务】第一行\n第二行\n【给主人的任务】无"), "第一行\n第二行");
eq("写「无」→ 空（不该叫它）", T.taskForAche("【给阿澈的任务】无"), "");
eq("写「无。」→ 空", T.taskForAche("【给阿澈的任务】无。"), "");
eq("★ 正文里点名它也认", T.taskForAche("局面：阿澈你来说两句吧"), "局面：阿澈你来说两句吧");
eq("完全没提 → 空", T.taskForAche("【局面】轮到主人了"), "");
eq("空文本 → 空", T.taskForAche(""), "");
eq("null → 空", T.taskForAche(null), "");

console.log("\n【stripNonDealer】荷官越界写的别人台词要摘掉");
let r = T.stripNonDealer("【荷官】我掷了骰子。\n【阿澈】我把骰子接住了，很得意。");
eq("★ 阿澈的台词被摘掉", r.text, "【荷官】我掷了骰子。");
eq("★ 记了越界次数", r.bleed, 1);
r = T.stripNonDealer("【荷官】局面：轮到阿澈。\n【给阿澈的任务】去买地\n【给主人的任务】无");
eq("★ 结构行不是台词，要留着", r.text.indexOf("【给阿澈的任务】") >= 0, true);
eq("★ 结构行也不算越界", r.bleed, 0);
r = T.stripNonDealer("【荷官】第一句\n【荷官】第二句");
eq("荷官自己多段都留", r.text.split("\n").length, 2);
eq("自己写的不算越界", r.bleed, 0);
r = T.stripNonDealer("【小满】我也说一句\n【荷官】好");
eq("★ 别的玩家名字也算越界", r.bleed, 1);
eq("摘完只剩荷官的", r.text, "【荷官】好");
r = T.stripNonDealer("没有署名的普通一句");
eq("没署名 → 原样留（算荷官主持）", r.text, "没有署名的普通一句");
eq("不误报越界", r.bleed, 0);
r = T.stripNonDealer("【阿澈】只有它说话");
eq("★ 全被摘光 → 空文本 + bleed=1", [r.text, r.bleed], ["", 1]);

console.log("\n【landMonoTurn】一回合要落成两条、各归各家");
T.state.mono.msgs = [];
T.landMonoTurn({ dealerReply: "【荷官】局面如上。", acheReply: "【阿澈】我伸手把骰子拿起来。", called: true });
eq("★ 落了两条", T.state.mono.msgs.length, 2);
eq("★ 第一条是荷官的", T.state.mono.msgs[0].by, "dealer");
eq("★ 第二条是阿澈的", T.state.mono.msgs[1].by, "ache");
eq("阿澈那条文本没被改", T.state.mono.msgs[1].text.indexOf("我伸手把骰子拿起来") >= 0, true);

T.state.mono.msgs = [];
T.landMonoTurn({ dealerReply: "【荷官】它在等你。", acheReply: "", called: true, acheErr: "「聊天连接」这个位置还没配模型" });
eq("阿澈没出声时只有荷官一条", T.state.mono.msgs.length, 2);
eq("★ 多出的一条是系统说明", T.state.mono.msgs[1].who, "sys");
eq("★ 说明里有名字", T.state.mono.msgs[1].text.indexOf("阿澈") >= 0, true);
eq("★ 说明里有原因（不再静默消失）", T.state.mono.msgs[1].text.indexOf("没配模型") >= 0, true);
eq("标成了错误色", T.state.mono.msgs[1].edge, true);

T.state.mono.msgs = [];
T.landMonoTurn({ dealerReply: "【荷官】局面。", acheReply: "", called: true, bleed: 2 });
eq("★ 荷官代写 + 阿澈没话说 → 有一条解释", T.state.mono.msgs.length, 2);
eq("解释提到「被丢掉」", T.state.mono.msgs[1].text.indexOf("被丢掉") >= 0, true);

T.state.mono.msgs = [];
T.landMonoTurn({ dealerReply: "【荷官】轮到主人了。", acheReply: "", called: false });
eq("没叫它 → 只有荷官一条", T.state.mono.msgs.length, 1);
eq("也没多嘴解释", T.state.mono.msgs[0].who, "host");

T.state.mono.msgs = [];
T.landMonoTurn(null);
eq("null 不炸", T.state.mono.msgs.length, 0);

console.log("\n【monoBubbles】归属渲染（by 优先，不再看正文标记）");
let html = T.monoBubbles({ text: "【荷官】局面。", by: "dealer" });
ok(html.indexOf("荷官") >= 0, "by=dealer → 显示「荷官」");
ok(html.indexOf(">荷<") >= 0, "荷官头像用「荷」");
html = T.monoBubbles({ text: "【阿澈】我接住了。", by: "ache" });
ok(html.indexOf("<b>阿澈</b>") >= 0, "★ by=ache → 显示阿澈的名字");
ok(html.indexOf(">阿<") >= 0, "★ 头像用阿澈名字首字（不是「荷」）");
ok(html.indexOf(">荷<") < 0, "★ 它那条不带荷官头像");
ok(html.indexOf("#B0713A") >= 0, "用了阿澈那一色的主题变量");
/* ★ 关键反面：正文里写了荷官字样，但 by=ache —— 归属必须听 by 的 */
html = T.monoBubbles({ text: "【荷官】这句是它自己正文里写的", by: "ache" });
ok(html.indexOf("<b>阿澈</b>") >= 0, "★ 正文写【荷官】也不改归属（听 by）");
html = T.monoBubbles({ text: "我掷了骰子。", by: "dealer" });
ok(html.indexOf("<b>荷官</b>") >= 0, "by=dealer 的无标记正文归荷官");

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
