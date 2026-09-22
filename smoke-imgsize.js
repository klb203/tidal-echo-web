/* 大图降级压缩（shrinkImageToFit）冒烟：桩掉 imageToJpeg，验档位循环的每一步。
   为什么值得测：这是"发图失败"的唯一补救路径 —— 循环少走一档、或者把更大的结果
   采用了，用户看到的就是「压到最小还是发不了」，而他本来能发出去。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const DIR = __dirname;
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } }
function eq(name, got, want) {
  /* ★ 数组/对象要用 JSON 比 —— `[1,2] === [1,2]` 在 JS 里是 false，
     不这么写会把「值明明对」的断言全判成失败（第一版就踩了这个）。 */
  const deep = (v) => v !== null && typeof v === "object";
  const same = (deep(got) || deep(want))
    ? JSON.stringify(got) === JSON.stringify(want)
    : got === want;
  if (same) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + "\n      得到 " + JSON.stringify(got) + "\n      期望 " + JSON.stringify(want)); }
}

const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const A = "/* ★ 图片放不下就";
const B = "async function sendOneFile(file){";
const a = html.indexOf(A), b = html.indexOf(B, a);
if (a < 0 || b < 0) { console.log("✗ 抠不出 shrinkImageToFit（锚点变了？）"); process.exit(1); }
const CODE = html.slice(a, b);
console.log("抠出 " + CODE.length + " 字符\n");

const dom = new JSDOM("<!doctype html><html><body></body></html>",
  { url: "https://tidal.example/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.eval(CODE + "\nwindow.__shrink = shrinkImageToFit; window.__tiers = IMG_SHRINK_TIERS;");
const shrink = w.__shrink;
if (typeof shrink !== "function") { console.log("✗ shrinkImageToFit 没定义出来"); process.exit(1); }

const LIMIT = 4 * 1024 * 1024;
const MB = (n) => n * 1024 * 1024;
const file = { name: "photo.heic", type: "image/heic" };
const big = { size: MB(9) };

/* 一个可控的 imageToJpeg 桩：按调用次序返回预设结果，并记录被问过哪些档位 */
function stub(seq) {
  const asked = [];
  let i = 0;
  w.imageToJpeg = (f, maxSide, q) => {
    asked.push([maxSide, q]);
    const r = seq[i++];
    if (r === "throw") return Promise.reject(new Error("boom"));
    return Promise.resolve(r === undefined ? null : r);
  };
  return asked;
}

(async () => {
  ok(Array.isArray(w.__tiers) && w.__tiers.length >= 3, "档位表存在（" + JSON.stringify(w.__tiers) + "）");

  // ① 本来就放得下 → 一次都不压
  let asked = stub([]);
  let r = await shrink(file, LIMIT, { size: MB(2) }, "a.jpg", "image/jpeg", 100, 200);
  eq("① 放得下 → 原样返回", r.blob.size, MB(2));
  eq("① 放得下 → 不动用压缩", asked.length, 0);
  eq("① ok=true", r.ok, true);
  eq("① 宽高原样带出", [r.width, r.height], [100, 200]);

  // ② 压一档就够 → 只问一次
  asked = stub([{ blob: { size: MB(3) }, name: "b.jpg", width: 1600, height: 1200 }]);
  r = await shrink(file, LIMIT, big, "photo.heic", "image/heic", 0, 0);
  eq("② 用第一档（1600/0.8）", asked[0], [1600, 0.8]);
  eq("② 只问了一档就停", asked.length, 1);
  eq("② 结果是那一档的", r.blob.size, MB(3));
  eq("② ok=true", r.ok, true);
  eq("② 名字换成 jpg", r.name, "b.jpg");
  eq("② mime 换成 jpeg", r.mime, "image/jpeg");
  eq("② 宽高跟着更新", [r.width, r.height], [1600, 1200]);

  // ③ 要压到第三档
  asked = stub([{ blob: { size: MB(6) }, name: "c.jpg", width: 1600, height: 1200 },
                { blob: { size: MB(5) }, name: "c.jpg", width: 1280, height: 960 },
                { blob: { size: MB(2) }, name: "c.jpg", width: 1024, height: 768 }]);
  r = await shrink(file, LIMIT, big, "photo.heic", "image/heic", 0, 0);
  eq("③ 依次问了三档", asked.map((x) => x[0]), [1600, 1280, 1024]);
  eq("③ 采用能放下的那档", r.blob.size, MB(2));
  eq("③ 停在放下的那一档（不再多试）", asked.length, 3);
  eq("③ ok=true", r.ok, true);

  // ④ ★ 候选反而更大 → 必须忽略（否则"越压越大"）
  asked = stub([{ blob: { size: MB(12) }, name: "d.jpg", width: 1600, height: 1200 },
                { blob: { size: MB(11) }, name: "d.jpg", width: 1280, height: 960 },
                { blob: { size: MB(10) }, name: "d.jpg", width: 1024, height: 768 },
                { blob: { size: MB(9) },  name: "d.jpg", width: 800, height: 600 }]);
  r = await shrink(file, LIMIT, big, "photo.heic", "image/heic", 0, 0);
  eq("④ ★ 更大的候选一律不采用", r.blob.size, MB(9));
  eq("④ 但还是把档位试完了", asked.length, 4);
  eq("④ 压不到上限就如实说 ok=false", r.ok, false);

  // ⑤ 解不了的格式（HEIC / 动图）：imageToJpeg 回 null → 保持原图 + 如实报失败
  asked = stub([null, null, null, null]);
  r = await shrink(file, LIMIT, big, "photo.heic", "image/heic", 0, 0);
  eq("⑤ 全是 null → 保留原图", r.blob.size, MB(9));
  eq("⑤ ok=false（调用方据此提示用户）", r.ok, false);
  eq("⑤ 名字/mime 不动（还是原格式）", [r.name, r.mime], ["photo.heic", "image/heic"]);
  eq("⑤ 四个档位都问过", asked.length, 4);

  // ⑥ 压缩函数抛异常 → 不能把整条发送流程弄挂
  asked = stub(["throw", "throw", { blob: { size: MB(2) }, name: "e.jpg", width: 1024, height: 768 }]);
  r = await shrink(file, LIMIT, big, "photo.heic", "image/heic", 0, 0);
  eq("⑥ 抛异常后继续试下一档", asked.length, 3);
  eq("⑥ 最终取到能放下的", r.blob.size, MB(2));
  eq("⑥ ok=true", r.ok, true);

  // ⑦ 边界：刚好等于上限算放下
  asked = stub([]);
  r = await shrink(file, LIMIT, { size: LIMIT }, "x.jpg", "image/jpeg", 0, 0);
  eq("⑦ 刚好等于上限 → 算放下，不压", [r.ok, asked.length], [true, 0]);

  // ⑧ 压到最小仍然超限 → 返回最小的那个（而不是原图），ok=false
  asked = stub([{ blob: { size: MB(8) }, name: "f.jpg", width: 1600, height: 1200 },
                { blob: { size: MB(7) }, name: "f.jpg", width: 1280, height: 960 },
                { blob: { size: MB(6) }, name: "f.jpg", width: 1024, height: 768 },
                { blob: { size: MB(5) }, name: "f.jpg", width: 800, height: 600 }]);
  r = await shrink(file, LIMIT, big, "photo.heic", "image/heic", 0, 0);
  eq("⑧ 返回已知的最小结果", r.blob.size, MB(5));
  eq("⑧ ok=false", r.ok, false);

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
