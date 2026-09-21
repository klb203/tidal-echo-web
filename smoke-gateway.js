/*
 * 网关「它现在会什么」自检 —— 用法：node smoke-gateway.js [index.html]
 *
 * 这一组原来是**后端工具名的清单**（mcd.available-coupons 这种）。
 * 用户要的是：卡片上写**能力名**（"麦当劳"），让人一眼知道它现在会什么、
 * 什么还没接上；工具名藏进卡里，点开才看。
 *
 * 这类改动 node --check 抓不到的坏法：
 *   · 卡片上又混进工具名（就是用户说的"不是工具名"）
 *   · 能力表漏了某项 → 用户以为它不会（其实是没写进表）
 *   · 判定写了第二份 → 卡片说"能用"、点开却啥也没有
 *   · 匹配写死整名（`mcd.available-coupons`）→ 服务方改个名就全灭
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

let PASS = 0, FAIL = 0;
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }

function arrBlock(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) return '';
  const open = text[i + needle.length - 1], close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i + needle.length - 1; j < text.length; j++) {
    if (text[j] === open) depth++;
    else if (text[j] === close) { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  return '';
}
function fnBlock(text, sig) {
  const i = text.indexOf(sig);
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') { depth++; started = true; }
    else if (text[j] === '}') { depth--; if (started && depth === 0) return text.slice(i, j + 1); }
  }
  return '';
}

console.log('=== 1. 能力卡：写的是能力名，不是工具名 ===');
const ability = arrBlock(html, 'const CAP_ABILITY = [');
ok(ability.length > 0, '找得到 CAP_ABILITY');
const names = [...ability.matchAll(/\bn:\s*"([^"]+)"/g)].map((m) => m[1]);
/* 用户点名的这些必须都在（少一个 = 他会以为它不会） */
const WANT = ['自由活动', '大富翁', '朋友圈', '群聊', '天气', '麦当劳', '瑞幸咖啡',
              '高德地图', '小红书', '查手机', '调动微信', 'QQ Bot', 'AI 付', 'MCP 设置'];
for (const w of WANT) ok(names.includes(w), '★ 能力表里有「' + w + '」');
eq([...new Set([...ability.matchAll(/src:\s*"(\w+)"/g)].map((m) => m[1]))].sort(),
  ['cfg', 'mcp', 'page', 'tool'], '四种来源都在：页面 / 内置工具 / MCP / 设置');
ok(names.length >= 12, '能力条数：' + names.length);
for (const m of ability.matchAll(/\{\s*k:\s*"(\w+)"[^}]*\}/g)) {
  const seg = m[0];
  ok(/n:\s*"[^"]+"/.test(seg) && /s:\s*"[^"]+"/.test(seg) && /ic:\s*"[^"]+"/.test(seg),
    '「' + m[1] + '」有名字 / 说明 / 图标');
}

console.log('\n=== 2. ★ 卡片上不出现工具名（用户的原话："不是工具名"）===');
const aStart = html.indexOf('/* ── A. 它现在会什么');
const aEnd = html.indexOf('/* ── B / C / D');
const aGroup = html.slice(aStart, aEnd);
ok(aStart > 0 && aEnd > aStart, '找得到 A 组那一段');
ok(!/cap-toolname/.test(aGroup), '★ A 组的卡片里**没有** cap-toolname（工具名藏进点开后的明细）');
ok(/data-cap-ab/.test(aGroup), 'A 组用的是能力卡（data-cap-ab）');
ok(/class="kit-grid"/.test(aGroup), '★ 排版沿用工具能力页那套 .kit-grid');
ok(/class="kit-card cap-ab/.test(aGroup), '卡片用 .kit-card');
ok(/capAbilityOf\(a\)/.test(aGroup), '每张卡的状态走 capAbilityOf()');
ok(/\.kit-card/.test(html) && /\.cap-ab-st\{/.test(html), 'CSS：工具卡 + 状态小字都在');

console.log('\n=== 3. 判定只有一处，且是"前缀匹配"不是写死整名 ===');
eq(html.split('function capAbilityOf(').length - 1, 1, 'capAbilityOf 只定义一次');
ok([...html.matchAll(/capAbilityOf\(/g)].length >= 3, '调用点：渲染一处 + 点击一处（+定义）');
const fn = fnBlock(html, 'function capAbilityOf(a){');
ok(/indexOf\(String\(p\)\.toLowerCase\(\)\)/.test(fn), '★ 用 indexOf 前缀匹配 —— 服务方加个后缀不会全灭');
ok(/toLowerCase\(\)/.test(fn), '大小写不敏感');
ok(!/=== *"mcd\./.test(fn), '没有把某个具体工具名写死进判定');

console.log('\n=== 4. 点击与跳转都接上了 ===');
ok(html.includes('e.target.closest("[data-cap-ab]")'), '点击处理认 data-cap-ab');
ok(/if \(a\.go\)\{ capAct\(a\.go\); return; \}/.test(html), '有 go 的能力直接去那个地方');
ok(/capAct\("kit:mcp"\)/.test(html), '没接上的能力 → 引导去 MCP 设置');
ok(/str\.indexOf\("kit:"\) === 0/.test(html), 'capAct 支持 kit:<id>（跳到工具能力页那一项）');
for (const f of ['openActivity', 'openRp', 'openMoments', 'openGroupChat']) {
  ok(new RegExp('fn:' + f).test(html), '能力表里有 ' + f + ' 的入口');
  ok(new RegExp(f + ':\\s*function').test(html), '★ ' + f + ' 在 fn: 的 map 里包了一层（它是 pack 挂 window 上的）');
}

/* ══════════════════════════════════════════════════════════════════════════
   第二段：真跑 capAbilityOf（连同真的 capDig 一起抠出来）
   ────────────────────────────────────────────────────────────────────────── */
console.log('\n=== 5. 假 DOM：四种来源的判定 ===');

const digBlk = fnBlock(html, 'function capDig(obj, path, dflt){');
ok(digBlk.length > 0 && fn.length > 0, '抠出了 capDig 与 capAbilityOf');

function harness(tools, denied) {
  const sandbox = { console, CAP_STATE: { data: {} } };
  if (tools !== null) sandbox.CAP_STATE.data.tools = { tools: tools || {}, denied: denied || [] };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(digBlk + '\n' + fn + '\n; globalThis.__f = capAbilityOf;', ctx);
  return ctx.__f;
}

const TOOLS = {
  'mcd.available-coupons': '看看有什么优惠券',
  'mcd.create-order': '下单',
  'luckin.order': '瑞幸点单',
  'device.net': '网络信息',
  'weather.now': '现在天气',
};
let F;
try { F = harness(TOOLS, ['device.net']); ok(typeof F === 'function', 'capAbilityOf 在假环境里跑起来了'); }
catch (e) { ok(false, 'capAbilityOf 跑不起来', String((e && e.message) || e)); }

if (typeof F === 'function') {
  eq(F({ k: 'p', src: 'page' }).ok, true, 'page 类（前端面板）永远能用');
  ok(/随时能开/.test(F({ k: 'p', src: 'page' }).text), 'page 的说明是「前端面板 · 随时能开」');
  eq(F({ k: 'c', src: 'cfg' }).ok, true, 'cfg 类（MCP 设置）永远亮 —— 它是个入口');

  const r = F({ k: 'm', src: 'mcp', match: ['mcd'] });
  eq(r.ok, true, '★ mcd.* 匹配到 → 亮');
  eq(r.tools.sort(), ['mcd.available-coupons', 'mcd.create-order'], '并列出背后具体是哪些工具');
  ok(/2 个工具可用/.test(r.text), '小字写的是几个工具：' + r.text);

  const dev = F({ k: 'd', src: 'mcp', match: ['device'] });
  eq(dev.ok, false, '★ 命中的全在 denied 里 → 不亮（"故意不给它"）');
  ok(/故意不给它/.test(dev.text), '文案说清是故意不给：' + dev.text);
  eq(dev.tools, ['device.net'], '但还是把工具列出来（让人知道是哪几个）');

  const none = F({ k: 'n', src: 'mcp', match: ['nothing-here'] });
  eq(none.ok, false, '一个都没匹配 → 不亮');
  eq(none.text, '还没接', '文案是「还没接」');

  eq(F({ k: 'u', src: 'mcp', match: ['MCD'] }).ok, true, '★ 匹配大小写不敏感（表里写 MCD 也认）');
  eq(F({ k: 's', src: 'tool', match: ['weather'] }).ok, true, '内置工具（天气）同理');
  eq(F({ k: 'x', src: 'tool', match: ['qq'] }).ok, false, '清单里没有的（QQ Bot）→ 还没接');
  eq(F(null).ok, false, '传了个空对象也不炸');

  const F2 = harness(null);
  const noReply = F2({ k: 'm', src: 'mcp', match: ['mcd'] });
  eq(noReply.ok, false, '后端没回话 → 不亮');
  ok(/后端还没回话/.test(noReply.text), '文案说清是后端没回话：' + noReply.text);
  eq(F2({ k: 'p', src: 'page' }).ok, true, '★ 后端没回话时，前端面板那几张卡照样亮（它们本来就不靠后端）');
}

console.log('\n──────────────────────────────');
console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
process.exit(FAIL ? 1 : 0);
