/* 条码模块冒烟：假 DOM（jsdom）里真跑一次 qrcode.min.js + qr-pack.js，
   验的是"码真的画出来了"——不是只有语法通过。
   jsdom 没有 canvas，qrcodejs 会自动退回 table 渲染，这条兜底路径也一并验到。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const DIR = __dirname;
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } }

const dom = new JSDOM("<!doctype html><html><body></body></html>",
  { url: "https://tidal.example/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;

// 先库后包（和 index.html 的顺序一致）
w.eval(fs.readFileSync(path.join(DIR, "vendor", "qrcode.min.js"), "utf8"));
ok(typeof w.QRCode === "function", "vendor/qrcode.min.js 加载出来 QRCode 了");

w.eval(fs.readFileSync(path.join(DIR, "qr-pack.js"), "utf8"));
ok(typeof w.Barcode === "object" && typeof w.Barcode.show === "function", "window.Barcode 挂上了");

// 1) 世界书条目 → 标准 JSON
const wbItem = { title: "薄荷", content: "窗台上有盆薄荷，早上晒到太阳。", category: "生活",
                 key: ["薄荷"], constant: false, position: 1, order: 100, depth: 4, role: 0,
                 scanDepth: 4, probability: 100 };
const wbJson = w.Barcode.fromWorldbook(wbItem);
const wbObj = JSON.parse(wbJson);
ok(wbObj.tidal === "worldbook" && wbObj.v === 1, "世界书条码带 tidal/worldbook 标记与版本");
ok(wbObj.item.key[0] === "薄荷" && wbObj.item.content.indexOf("薄荷") >= 0, "世界书条码里带上了关键词与正文");

// 2) 记忆条目 → 标准 JSON
const memJson = w.Barcode.fromMemory({ kind: "event", content: "今天她把阳台的花搬进来了。",
                                       meta: { title: "搬花", importance: 7 }, at: "2026-09-22T10:00:00Z" });
const memObj = JSON.parse(memJson);
ok(memObj.tidal === "memory" && memObj.item.kind === "event", "记忆条码带 tidal/memory 标记与 kind");
ok(memObj.item.importance === 7, "记忆条码带上了重要度");

// 3) 真的画出来
w.Barcode.show(memJson, { title: "记忆条码" });
const box = w.document.querySelector(".qr-box");
const painted = box && box.querySelectorAll("canvas, img, table").length > 0;
if (!painted) console.log("    调试：box.innerHTML 前 200 字 =", box ? box.innerHTML.slice(0, 200).replace(/\s+/g, " ") : "(无 box)");
ok(painted, "二维码真的渲染出来了（canvas/img/table 任一）");
ok((w.document.querySelector(".qr-panel") || {}).className.indexOf("hidden") < 0, "弹层显示出来了");
ok(/\d+\s*字节/.test(w.document.querySelector(".qr-note").textContent), "提示里写了字节数");

// 4) 超长内容要提示"只装下前面这段"，而不是给一张扫出来是乱码的码
const longText = "很长的一段记忆。".repeat(400);          // 约 6400 字节
w.Barcode.show(longText, { title: "太长了" });
const note2 = w.document.querySelector(".qr-note").textContent;
ok(/内容太长/.test(note2), "超长时提示「内容太长」");
ok(w.document.querySelector(".qr-box").querySelectorAll("canvas, img, table").length > 0,
   "超长时仍然画得出码（截断后编码）");

// 5) 关闭
w.Barcode.close();
ok(true, "close() 不抛错");

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
