/*
 * room 面板自检 —— 用法：node smoke-room.js [room-pack.js]
 *
 * 为什么要有它：用户报「打开 room 之后返回去的按键不灵敏」。查下来是
 *   **按钮写着 data-act="back"，但 act() 的 switch 里没有 case "back"** ——
 *   点击被静默吞掉，一点反应都没有。
 * 这类错 node --check 一个都抓不到（语法完全正确），界面上也只有一个症状：
 * "点了没反应"。所以这一份的第一段就是**全量动作覆盖检查**：
 *   文件里每一个 data-act="X" 都必须有对应的 case "X"。
 * 它一次性抓到了那个 back（54 个动作里唯一的漏网），并且能防住以后新加的按钮。
 *
 * 第二段用假 DOM 真跑一遍：点返回键 → 委托 → act("back") → 面板关掉。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = process.argv[2] || path.join(__dirname, 'room-pack.js');
const CSS = path.join(path.dirname(JS), 'room-pack.css');
const js = fs.readFileSync(JS, 'utf8');
const css = fs.existsSync(CSS) ? fs.readFileSync(CSS, 'utf8') : '';

let PASS = 0, FAIL = 0;
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }
/* 按括号配平取一个数组/对象字面量 —— 比"往后 N 个字符"可靠 */
function arrBlock(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) return '';
  const open = text[i + needle.length - 1];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i + needle.length - 1; j < text.length; j++) {
    if (text[j] === open) depth++;
    else if (text[j] === close) { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  return '';
}

console.log('=== 1. ★ 全量动作覆盖：每个 data-act 都得有人在接 ===');
const acts = [...new Set([...js.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]))].sort();
const cases = new Set([...js.matchAll(/case "([^"]+)"/g)].map((m) => m[1]));
ok(acts.length >= 40, '抓到静态 data-act 若干：' + acts.length);
const dead = acts.filter((a) => !cases.has(a));
eq(dead, [], '★ 没有"点了没反应"的按钮（本次 bug 就是这里漏了 back）');
const dyn = [...js.matchAll(/data-act="\$\{/g)].length;
eq(dyn, 0, '没有运行时拼出来的 data-act（有的话这条检查会漏，得改成运行时验）');

console.log('\n=== 2. 返回键：分支在、动作对 ===');
ok(acts.includes('back'), '顶栏有 data-act="back" 的返回键');
ok(/case "back":\s*close\(\);\s*break;/.test(js), '★ case "back" 调的是 close()');
ok(/async function act\(a, el\)\s*\{[\s\S]{0,600}case "back"/.test(js), '分支在 act() 里（不是别处同名函数）');
ok(/window\.closeRoom = close;/.test(js), 'closeRoom 仍挂在 window 上（宿主那一侧也走得到）');

console.log('\n=== 3. 点击热区（"不灵敏"的另一半原因）===');
ok(/\.rm-top \.rm-btn::after\{[^}]*inset:\s*-7px/.test(css),
  '★ 按钮视觉 34px，点按区外扩到 48px（手机上手指点不准）');
ok(/\.rm-top \.rm-btn\{[^}]*position:\s*relative/.test(css),
  '按钮是 position:relative（否则那个透明热区会跑到别处）');
ok(/\.rm-top\{[^}]*env\(safe-area-inset-top\)/.test(css),
  '顶栏让出了状态栏高度（刘海/挖孔屏上按钮不会被系统栏压住）');
ok(/\.rm-panel\{[^}]*position:\s*fixed;\s*inset:\s*0/.test(css), '面板是全屏层');
ok(/\.rm-page\{[^}]*position:\s*absolute/.test(css) && /\.rm-pages\{[^}]*overflow:\s*hidden/.test(css),
  '页面区在 .rm-pages 里自己滚（不会盖住顶栏）');

console.log('\n=== 4. 结构：目录与页面一一对应（点 tab 不能静默回落）===');
/* ★ 用配平取 TABS —— 写死"往后 1200 字符"会越界抓到后面的维度定义
   （DIMS 里也是 { k: "close", ... }），于是"每个 tab 都有页面"永远红（第一次跑就是这条假红）。 */
const tabsBlock = arrBlock(js, 'const TABS = [');
const tabKeys = [...tabsBlock.matchAll(/\bk:\s*"([^"]+)"/g)].map((m) => m[1]);
ok(tabKeys.length >= 5, 'TABS 有几个页：' + tabKeys.length);
const pageFn = js.slice(js.indexOf('const PAGE = ()'), js.indexOf('const PAGE = ()') + 500);
const pageKeys = [...pageFn.matchAll(/(\w+):\s*page\w+/g)].map((m) => m[1]);
const missing = tabKeys.filter((k) => !pageKeys.includes(k));
eq(missing, [], '★ 每个 tab 都有对应页面（少一个就是点了跳回默认页）');

console.log('\n=== 5. Esc 能关、且只绑一次 ===');
const escBinds = [...js.matchAll(/addEventListener\("keydown"/g)].length;
eq(escBinds, 1, 'keydown 监听只有一处（绑多了会关两次 / 互相打架）');
ok(/keydown[\s\S]{0,300}Escape[\s\S]{0,200}close\(\)/.test(js), 'Esc 走的是 close()');

/* ══════════════════════════════════════════════════════════════════════════
   第二段：假 DOM 真跑「点返回键 → 面板关掉」
   ────────────────────────────────────────────────────────────────────────── */
console.log('\n=== 6. 假 DOM：点返回键真的能把面板关掉 ===');

function mkEl(tag) {
  const set = new Set();
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: '', className: '',
    textContent: '', innerHTML: '', value: '', dataset: {}, style: {}, attrs: {},
    children: [], parentNode: null, _on: {},
    classList: {
      add(...c) { c.forEach((x) => set.add(x)); },
      remove(...c) { c.forEach((x) => set.delete(x)); },
      contains(c) { return set.has(c); },
      toggle(c, f) { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on; },
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k] !== undefined ? el.attrs[k] : null; },
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    addEventListener(ev, fn) { (el._on[ev] = el._on[ev] || []).push(fn); },
    removeEventListener() {},
    querySelector() { return mkEl('div'); },      // ★ 返回新元素而不是 null —— 少一堆崩溃
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    focus() {}, blur() {}, click() {}, remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 600 }; },
    scrollIntoView() {},
  };
  return el;
}

function boot() {
  const byId = new Map();
  const body = mkEl('body');
  const store = {};
  const sandbox = {
    console,
    setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => { try { fn(); } catch (_) {} return 0; },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    navigator: { onLine: true },
    location: { href: 'https://example.test/', origin: 'https://example.test' },
    addEventListener() {}, removeEventListener() {},
    document: {
      readyState: 'complete',
      body,
      documentElement: mkEl('html'),
      createElement: (t) => mkEl(t),
      /* ★ 建出来的 panel 是 ensureDom 自己 append 进 body 的，byId 里没有它 ——
         所以这里要回退去 body.children 里找（否则第二次 getElementById 会**再建一个**，
         "同一性"断言就假红了）。id 既要认属性赋值，也要认 setAttribute 那条路。 */
      getElementById: (id) => byId.get(id) || body.children.find((c) => c.id === id || (c.attrs && c.attrs.id === id)) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(js, ctx, { filename: 'room-pack.js' });

  // ensureDom() 建的 panel 会进 body —— 收进 byId，模拟"后来 getElementById 查得到"
  const panel = body.children.find((c) => c.id === 'roomPanel') || null;
  if (panel) {
    // pack 里 setAttribute("id") 不走属性赋值 → 两种都认
    if (!panel.id) panel.id = panel.attrs.id || 'roomPanel';
    byId.set(panel.id, panel);
  }
  return { ctx, panel, byId, body, sandbox };
}

let B;
try {
  B = boot();
  ok(!!B.panel, 'room-pack.js 在假 DOM 里 init 起来了，且建出了 #roomPanel');
} catch (e) {
  ok(false, 'room-pack.js 跑不起来', String((e && e.message) || e));
}

if (B && B.panel) {
  const { panel, ctx } = B;
  const RP = ctx.window.RoomPack;
  ok(!!RP, 'window.RoomPack 挂上了');
  ok(typeof RP._act === 'function', '导出里有 _act（测试口）');
  /* ★ 用 === 而不是 eq() —— 假元素有 parentNode↔children 的循环引用，
     丢给 JSON.stringify 会直接崩（第一次跑就是这样）。同一性断言本来也不该走序列化。 */
  ok(RP._el() === panel, '★ _el() 返回的就是 ensureDom 建的那个 panel（同一性，不是新建的）');

  // 面板先打开
  panel.classList.remove('hidden');
  panel.classList.add('open');
  ok(panel.classList.contains('open'), '面板处于打开状态');

  /* 点返回键：造一个"按钮"，让 closest 认得 [data-act]，
     然后把 click 派发给 panel（委托就绑在它身上）—— 走的是和线上同一条链。 */
  const btn = mkEl('button');
  btn.dataset.act = 'back';
  btn.closest = (sel) => (sel === '[data-act]' ? btn : null);
  const handlers = panel._on.click || [];
  ok(handlers.length >= 1, 'panel 上挂了 click 委托');
  handlers.forEach((fn) => fn({ target: btn, stopPropagation() {}, preventDefault() {} }));

  ok(!panel.classList.contains('open'), '★ 点返回键之后 open 类被摘掉了（面板开始关）');
  ok(panel.classList.contains('hidden'), '★ 动画计时器到点后加上 hidden（真的关掉了）');
  ok(ctx.window.closeRoom === RP.close, 'closeRoom 与 RoomPack.close 是同一个函数（同一性）');

  // 再开一次，用 Esc 那条路
  panel.classList.remove('hidden');
  panel.classList.add('open');
  RP._act('back');
  ok(!panel.classList.contains('open'), '直接走 _act("back") 也能关（不是只认鼠标事件）');

  // 未知动作不该炸（default 分支）
  let threw = false;
  try { RP._act('这个动作不存在'); } catch (_) { threw = true; }
  ok(!threw, '未知 data-act 不抛（落到 default，最多没反应）');
}

console.log('\n──────────────────────────────');
console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
process.exit(FAIL ? 1 : 0);
