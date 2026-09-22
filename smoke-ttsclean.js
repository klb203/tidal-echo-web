/* 朗读前文本清洗（ttsClean）冒烟：纯函数 + **正反例**断言表。
   这类正则最容易悄悄变宽 —— 「误删正文」比「漏删标记」更糟，所以反面例子必须够多。

   做法：从 index.html 里把那段函数抠出来 eval（不加载整份 67 万字 inline script）。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const DIR = __dirname;
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } }
function eq(name, got, want) {
  if (got === want) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + "\n      得到 " + JSON.stringify(got) + "\n      期望 " + JSON.stringify(want)); }
}

const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const A = "/* ════════════ 朗读前的文本清洗";
const B = '/* 模型可以把「值得长期记住」的事写成一行';
const a = html.indexOf(A), b = html.indexOf(B, a);
if (a < 0 || b < 0) { console.log("✗ 抠不出 ttsClean（锚点变了？）"); process.exit(1); }
const CODE = html.slice(a, b);
console.log("抠出 ttsClean：" + CODE.length + " 字符\n");

const dom = new JSDOM("<!doctype html><html><body></body></html>",
  { url: "https://tidal.example/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.eval(CODE + "\nwindow.__ttsClean = ttsClean;");
const clean = (t) => w.__ttsClean(t);
if (typeof clean !== "function") { console.log("✗ ttsClean 没定义出来"); process.exit(1); }

console.log("【该剥掉的】");
eq("**粗体** → 只留字", clean("**今天很冷**"), "今天很冷");
eq("*斜体* → 只留字", clean("她*小声*说"), "她小声说");
eq("__下划线粗__", clean("__记住了__"), "记住了");
eq("***三重***", clean("***重要***"), "重要");
eq("~~删除线~~", clean("~~不要~~"), "不要");
eq("行内代码", clean("用`npm i`装"), "用npm i装");
eq("# 标题去井号", clean("# 今天\n她来了"), "今天 她来了");
eq("- 列表去符号", clean("- 猫\n- 狗"), "猫 狗");
eq("有序列表去序号", clean("1. 先吃饭\n2. 再睡觉"), "先吃饭 再睡觉");
eq("> 引用去箭头", clean("> 她说好"), "她说好");
eq("分隔线整行丢掉", clean("上面\n---\n下面"), "上面 下面");
eq("代码围栏去掉", clean("```js\nconst a=1;\n```"), "const a=1;");
eq("Markdown 链接留文字", clean("看[这个](https://a.example/x?y=1)就好"), "看这个就好");
eq("裸网址删掉", clean("在 https://example.com/a?b=1 这里"), "在 这里");
eq("图片语法留 alt", clean("![一只猫](https://x/y.png)"), "一只猫");
eq("★ 识图插进来的（图：…）整块删", clean("（图：一只橘猫趴在窗台上，旁边有个蓝色水杯）她发的"),
   "她发的");
eq("半角括号版本也删", clean("(图: a cat on a windowsill) hi"), "hi");
eq("★ 带冒号的标签删掉", clean("好呀[心里嘀咕：她今天怎么这么安静]"), "好呀");
eq("全大写标签删掉", clean("嗯[CAM_CHECK]在的"), "嗯 在的");   // 标记→一个空格（无害，见实现里的说明）
eq("图片占位删掉", clean("[图片]"), "");
eq("附件占位删掉", clean("收到[附件]了吗"), "收到 了吗");
eq("<think> 整段删", clean("<think>她在想什么</think>她说好"), "她说好");
eq("未闭合 <think> 后面全删", clean("她说好<think>还在想"), "她说好");
eq("残留动作标记删", clean("我翻翻[[recall: 上次那家店]]等下"),
   "我翻翻 等下");
eq("只写「参考链接」的行丢掉", clean("原话在这\n参考链接\n她说的"), "原话在这 她说的");

console.log("\n【不该误删的（反面例子）】");
eq("正常全角括号保留", clean("她说（明天要早起）"), "她说（明天要早起）");
eq("括号里带冒号也保留", clean("（他说：好）"), "（他说：好）");
eq("方括号无冒号保留", clean("看第[3]条"), "看第[3]条");
eq("小写下划线标识符保留", clean("跑 PATCH_01 那个"), "跑 PATCH_01 那个");
eq("单个星号（乘法）保留", clean("2 * 3 等于 6"), "2 * 3 等于 6");
eq("单个横线保留", clean("她-我都在"), "她-我都在");
eq("网址前缀不完整保留", clean("这不是网址 abc://x"), "这不是网址 abc://x");
eq("中间方括号正常句保留", clean("他说[我不同意]就走了"), "他说[我不同意]就走了");
eq("普通换行变空格（不吞字）", clean("第一句\n第二句"), "第一句 第二句");
eq("句号前的空格收掉", clean("好 。"), "好。");

console.log("\n【边界】");
eq("空串 → 空", clean(""), "");
eq("null → 空", clean(null), "");
eq("纯空白 → 空", clean("   \n  "), "");
eq("纯标点 → 空（调用方据此跳过合成）", clean("。。。"), "");
eq("纯 emoji → 空", clean("🌙🌙"), "");
eq("全是标记 → 空", clean("[图片][附件]"), "");
ok(clean("有中文就留 🌙") === "有中文就留 🌙", "带 emoji 的正文保留 emoji");
ok(!/\*/.test(clean("**重点**和`code`")), "结果里不该残留 * 与反引号");
ok(clean("  前后空白  ") === "前后空白", "首尾空白清掉");
ok(!/  /.test(clean("嗯[CAM_CHECK]在的 [图片] 好")), "不会留下连续空格");
ok(!/  /.test(clean("第一句。\n\n\n第二句")), "空行也压成一个空格");

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
