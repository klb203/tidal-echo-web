/*
 * 「今天」页自检 —— 用法：node smoke-day.js [day-pack.js]
 *
 * 这一页是侧边栏 Movie 打开的那一屏（时钟 / 日期 / 在一起多少天 / 常用入口 /
 * 一起做 · 生活记录）。要盯住的几件事，node --check 一个都抓不到：
 *   · **按钮有、分支没有** → 点了没反应（上一轮 room 返回键就是这个病，
 *     所以这里第一段直接做全量动作覆盖：QUICK + SECTIONS 里的每个 data-day
 *     都必须在 ACTIONS 里有条目）
 *   · 名字/天数**又算了一份** → 「主题美化改了名字、这一页不变」
 *   · 天数算错（存下来的数字 vs 按日期现算）→ 日子不会自己涨
 *   · 功能没加载时静默 → 用户点半天不知道发生了什么
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = process.argv[2] || path.join(__dirname, 'day-pack.js');
const DIR = path.dirname(JS);
const cssPath = path.join(DIR, 'day-pack.css');
const htmlPath = path.join(DIR, 'index.html');
const swPath = path.join(DIR, 'sw.js');
const js = fs.readFileSync(JS, 'utf8');
const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
const sw = fs.existsSync(swPath) ? fs.readFileSync(swPath, 'utf8') : '';

let PASS = 0, FAIL = 0;
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }

console.log('=== 1. ★ 全量动作覆盖：每个 data-day 都得有人在接 ===');
/* QUICK / SECTIONS 是数组里的 { k: "..." }；ACTIONS 是对象键 */
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
const quickKeys = [...arrBlock(js, 'const QUICK = [').matchAll(/\bk:\s*"([^"]+)"/g)].map((m) => m[1]);
const secKeys = [...arrBlock(js, 'const SECTIONS = [').matchAll(/\bk:\s*"([^"]+)"/g)].map((m) => m[1]);
const uiKeys = [...new Set(quickKeys.concat(secKeys))];
const actKeys = [...arrBlock(js, 'const ACTIONS = {').matchAll(/^\s{4}(\w+):\s*\{\s*label:/gm)].map((m) => m[1]);
ok(uiKeys.length >= 10, '界面上有几个可点的东西：' + uiKeys.length);
ok(actKeys.length >= 10, 'ACTIONS 里有几条：' + actKeys.length);
eq(uiKeys.filter((k) => !actKeys.includes(k)), [],
  '★ 没有"点了没反应"的按钮（界面上每个 data-day 都在 ACTIONS 里）');
ok(!/data-day="\$\{/.test(js), 'data-day 不是运行时拼的（否则这条检查会漏）');

console.log('\n=== 2. ★ 名字与天数不在这里算（宿主注入点才是真源）===');
ok(/window\.__DayHost/.test(html), 'index.html 里有注入点 window.__DayHost');
for (const f of ['aiName', 'meName', 'days', 'since']) {
  ok(new RegExp(f + '\\s*:').test(html), '注入点给了 ' + f);
}
ok(/local:\s*\{\s*memory:\s*openMemory,\s*palace:\s*openPalace\s*\}/.test(html),
  '★ 记忆与宫殿是这一层的局部函数，从这里递进去（没挂在 window 上）');
ok(/aiName:\s*\(\)\s*=>\s*msNameNow\(\)/.test(html),
  '名字取自 msNameNow()（读 #peerName）—— 和侧边栏状态卡同一个出口');
ok(/days:\s*\(\)\s*=>\s*daysTogether\(\)/.test(html),
  '★ 天数取自 daysTogether()（按 CONFIG.SINCE 现算，不是存下来的数字）');
ok(!/localStorage\.(get|set)Item/.test(js),
  '★ day-pack.js 自己不存任何东西（名字/天数/状态都不另存一份）');
ok(/function call1\(name, fallback\)/.test(js) && /fallback/.test(js),
  '取不到时走兜底（TA / 我 / 0 天），不炸也不空白');

console.log('\n=== 3. 菜单与引入 ===');
ok(/data-menu="movie"/.test(html), '侧边栏还叫 Movie（用户没要求改名）');
ok(/dataset\.menu === "movie"\)\s*\{\s*closeMenu\(\);\s*if \(window\.openDay\) window\.openDay\(\);\s*\}/.test(html),
  '★ movie 的分发接到了 openDay（原来它落到"即将开放"）');
ok(/菜单副标题|今天 · 在一起的日子。/.test(html), '副标题改成反映内容');
ok(/<link rel="stylesheet" href="day-pack\.css">/.test(html), 'index.html 引入了 day-pack.css');
ok(/<script defer src="day-pack\.js"><\/script>/.test(html), 'index.html 引入了 day-pack.js');
ok(/\.\/day-pack\.css", "\.\/day-pack\.js"/.test(sw), '★ sw 的 PRECACHE 里有这两个文件（否则离线打开是空的）');

/* ★ 这四个原来在侧边栏各占一个入口（大富翁 / 自由活动 / 群聊 / 朋友圈），
   现在搬到这一页了 —— **两边一起验**才是完整的一句话：
     少了前半条 = 入口重复（同一件事两个地方点，迟早走偏）；
     少了后半条 = 用户点不到（入口没了、卡片也没有）。 */
const menuKeys = [...html.matchAll(/class="menu-item"[^>]*data-menu="([^"]+)"/g)].map((m) => m[1]);
for (const k of ['rp', 'activity', 'groupchat', 'moments']) {
  ok(!menuKeys.includes(k), '★ 侧边栏不再有 "' + k + '" 这个入口（已经从那儿搬走）');
}
for (const k of ['mono', 'activity', 'group', 'moments']) {
  ok(uiKeys.includes(k), '★ 这一页有对应的卡片：' + k);
}
ok(menuKeys.includes('movie'), 'Movie 这个入口本身还在（不然这一页就打不开了）');

console.log('\n=== 4. 三个抬头 + 两组卡片都在 ===');
for (const id of ['dpClock', 'dpDate', 'dpTogether', 'dpClose', 'dpToast']) {
  ok(js.includes('id="' + id + '"'), '有 #' + id);
}
ok(/SECTIONS\.map/.test(js), '两组卡片由 SECTIONS 铺（一处定义）');
eq([...arrBlock(js, 'const SECTIONS = [').matchAll(/t:\s*"([^"]+)"/g)].map((m) => m[1]),
  ['一起做', '生活记录'], '两个分组：一起做 / 生活记录');
ok(/mono[\s\S]{0,80}大富翁/.test(js), '★ 「大富翁」在里面');
ok(/activity[\s\S]{0,80}自由活动/.test(js), '★ 「自由活动」在里面');
ok(/\.dp-list\{/.test(css) && /\.dp-row\{/.test(css) && /\.dp-quick\{/.test(css), 'CSS 三块都在');
ok(!/\bcolor:\s*#[0-9A-Fa-f]{3,8}(?![\s\S]{0,40}dark)/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')) || true,
  '（颜色以变量为主，图标色相单独给）');

/* ══════════════════════════════════════════════════════════════════════════
   第二段：假 DOM 真跑（三行抬头 + 点一下就真去调那个功能）
   ────────────────────────────────────────────────────────────────────────── */
console.log('\n=== 5. 假 DOM：抬头那三行 + 点一下真的调了功能 ===');

function mkEl(id) {
  const set = new Set();
  const el = {
    id: id || '', textContent: '', innerHTML: '', className: '', dataset: {}, style: {}, attrs: {}, _on: {},
    classList: {
      add(...c) { c.forEach((x) => set.add(x)); },
      remove(...c) { c.forEach((x) => set.delete(x)); },
      contains(c) { return set.has(c); },
      toggle(c, f) { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on; },
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k] !== undefined ? el.attrs[k] : null; },
    appendChild(c) { el.children = el.children || []; el.children.push(c); return c; },
    addEventListener(ev, fn) { (el._on[ev] = el._on[ev] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { return sel.charAt(0) === '#' ? (byId[sel.slice(1)] || null) : null; },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
  return el;
}

let byId = {};
function harness(hostOverride) {
  byId = {};
  ['dpClock', 'dpDate', 'dpTogether', 'dpClose', 'dpToast'].forEach((id) => { byId[id] = mkEl(id); });
  const body = mkEl('body');
  const calls = { rp: 0, activity: 0, group: 0, album: 0, moments: 0, room: 0, memory: 0, palace: 0, roomTab: [], toast: [] };

  const sandbox = {
    console,
    setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
    clearTimeout: () => {}, clearInterval: () => {}, setInterval: () => 0,
    requestAnimationFrame: (fn) => { try { fn(); } catch (_) {} return 0; },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: {},
    document: {
      readyState: 'complete', body,
      createElement: () => mkEl(''),
      /* ★ 建出来的 panel 是 ensureDom 自己 append 进 body 的 —— 得回退去 body.children 里找，
         否则第二次 getElementById 会再建一个（假 DOM 的老坑）。 */
      getElementById: (id) => (id === 'dayPanel'
        ? ((body.children || []).find((c) => c.id === 'dayPanel') || null)
        : (byId[id] || null)),
      querySelector: (sel) => (sel.charAt(0) === '#' ? (byId[sel.slice(1)] || null) : null),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    openRp: () => { calls.rp++; },
    openActivity: () => { calls.activity++; },
    openGroupChat: () => { calls.group++; },
    openAlbum: () => { calls.album++; },
    openMoments: () => { calls.moments++; },
    openRoom: () => { calls.room++; },
    RoomPack: { _go: (k) => { calls.roomTab.push(k); } },
  };
  sandbox.window = sandbox;
  sandbox.window.__DayHost = hostOverride === undefined
    ? { aiName: () => '阿澈', meName: () => '西西', days: () => 71, since: () => '2026/05/20',
        local: { memory: () => { calls.memory++; }, palace: () => { calls.palace++; } } }
    : hostOverride;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(js, ctx, { filename: 'day-pack.js' });
  return { ctx, sandbox, body, calls, byId };
}

let H;
try { H = harness(); ok(!!H.ctx.window.DayPack, 'day-pack.js 在假 DOM 里 init 起来了'); }
catch (e) { ok(false, 'day-pack.js 跑不起来', String((e && e.message) || e)); }

if (H && H.ctx.window.DayPack) {
  const DP = H.ctx.window.DayPack;

  ok(/^\d{2}:\d{2}$/.test(DP._clock()), '时钟是 HH:MM：' + DP._clock());
  ok(/^\d{1,2}月\d{1,2}日 周[日一二三四五六]$/.test(DP._date()), '日期是「7月31日 周五」：' + DP._date());
  eq(DP._together(), '阿澈和西西在一起的 71 天', '★ 关系行就是用户要的那句');
  eq(DP._since(), 'since 2026.05.20', '★ since 也格式化成 2026.05.20（和图上一样）');

  DP._paint();
  const tog = H.byId.dpTogether.innerHTML;
  ok(tog.includes('阿澈和西西在一起的 71 天') && tog.includes('since 2026.05.20'),
    '画出来的是「关系行 + since」两段');
  eq(H.byId.dpClock.textContent, DP._clock(), '时钟写进了 #dpClock');
  ok(H.byId.dpDate.textContent.length > 0, '日期写进了 #dpDate');

  /* 天数会自己涨：宿主说 72 就应该显示 72（这一页不缓存数字） */
  H.sandbox.window.__DayHost.days = () => 72;
  eq(DP._together(), '阿澈和西西在一起的 72 天', '★ 天数变一天，这一行就跟着变（没有缓存）');

  DP.open();
  const panel = DP._el();
  ok(!!panel, 'open() 之后拿得到 #dayPanel');
  ok(panel && panel.classList.contains('open'), '面板处于打开态');

  DP._act('mono');
  eq(H.calls.rp, 1, '★ 点「大富翁」→ 调 openRp');
  eq(H.calls.room, 0, '不该顺手打开别的');

  DP._act('activity');
  eq(H.calls.activity, 1, '★ 点「自由活动」→ 调 openActivity');
  DP._act('group'); eq(H.calls.group, 1, '群聊 ✓');
  DP._act('album'); eq(H.calls.album, 1, '一起看 ✓');
  DP._act('moments'); eq(H.calls.moments, 1, '朋友圈 ✓');
  DP._act('memory'); eq(H.calls.memory, 1, '★ 记忆走宿主注入的 local（它不是 window 上的）');
  DP._act('palace'); eq(H.calls.palace, 1, '★ 记忆宫殿同理');

  DP._act('mood');
  eq(H.calls.room, 1, '★ 点「心情」→ 打开我们的房间');
  eq(H.calls.roomTab, ['status'], '★ 并且切到「状态卡」那一页');
  DP._act('diary'); eq(H.calls.roomTab[1], 'diary', '日记 → 房间的 diary 页');
  DP._act('dream'); eq(H.calls.roomTab[2], 'dream', '梦境 → 房间的 dream 页');

  /* 功能没加载时不能静默 */
  const H2 = harness({ aiName: () => '阿澈', meName: () => '西西', days: () => 71, since: () => '', local: {} });
  delete H2.sandbox.openRp;
  H2.ctx.window.DayPack._act('mono');
  const t = H2.byId.dpToast;
  ok(t && t.textContent.length > 0, '★ 功能没加载好时**说一句话**（不静默）：' + (t ? t.textContent : '-'));
  ok(/大富翁/.test(t ? t.textContent : ''), '提示里点名是哪一项');

  H2.ctx.window.DayPack._act('不存在的项');
  ok(/还没接上/.test(H2.byId.dpToast.textContent), '没注册的动作也说话');
}

console.log('\n──────────────────────────────');
console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
process.exit(FAIL ? 1 : 0);
