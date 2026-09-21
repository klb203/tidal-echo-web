/*
 * 共读自检 —— 用法：node smoke-read.js [index.html] [read-pack.js]
 *
 * 这一类页面的坏法，node --check 一个都拦不住：
 *   · 把"它读完了整本书"当默认 —— 它根本没读过，第一次对话就露馅
 *   · 锚点存成字符偏移（换字号 / 换设备必错位）—— 这里必须是原文片段
 *   · 翻开一章就把整本拉回来（几十万字）
 *   · 滚动每动一下就发一次进度上报（手机上就是一直在打后端）
 *   · 留一句 / 让它回应 接不上（点了没反应）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTMLP = process.argv[2] || path.join(__dirname, 'index.html');
const JSP = process.argv[3] || path.join(__dirname, 'read-pack.js');
const html = fs.readFileSync(HTMLP, 'utf8');
const js = fs.readFileSync(JSP, 'utf8');
const sw = fs.readFileSync(path.join(path.dirname(JSP), 'sw.js'), 'utf8');
const day = fs.readFileSync(path.join(path.dirname(JSP), 'day-pack.js'), 'utf8');

let PASS = 0, FAIL = 0;
const PENDING = [];
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

console.log('=== 1. 接线 ===');
ok(html.includes('read-pack.css'), 'index.html 引入了 read-pack.css');
ok(html.includes('read-pack.js'), 'index.html 引入了 read-pack.js');
ok(/<script defer src="read-pack\.js">/.test(html), '用 defer');
ok(sw.includes('./read-pack.css') && sw.includes('./read-pack.js'),
  '★ sw 的 PRECACHE 里有这两个文件');
ok(/companion-v1\d\d/.test((/const CACHE = "([^"]+)"/.exec(sw) || [])[1] || ''), 'CACHE 是本次版本');
const rows = arrBlock(day, '{ t: "一起做", rows: [');
ok(/k:\s*"read"/.test(rows) && /n:\s*"共读"/.test(rows), '★ Movie 里有「共读」这张卡');
const acts = arrBlock(day, 'const ACTIONS = {');
ok(/read:\s*\{[^}]*fn:\s*"openRead"/.test(acts), '★ ACTIONS 里也登记了（少一边 = 点了没反应）');
ok(/window\.openRead\s*=/.test(js), 'read-pack 挂出了 window.openRead');
ok(!/\bopenRead\b/.test(html), '★ 宿主里没有同名函数（不会互相盖掉）');

console.log('\n=== 2. 它没读过这本书 —— 界面要照实说 ===');
ok(/这一章的批注/.test(js), '批注区是"这一章的批注"（不是"全书讨论"）');
ok(/把划到的那句粘过来/.test(js), '★ 有"划到的那句"这个输入（锚点＝原文片段）');
ok(/anchor/.test(js), '锚点字段是 anchor');
/* ★ 口径：验的是"交给后端的字段里没有偏移量"，就盯着**字段** ——
   拿 /offset/ 去扫全文会命中注释里那句"不是字符偏移"（假红）。 */
ok(!/\b(offset|charIndex|startIndex|endIndex)\s*:/.test(js),
  '★ 提交的字段里没有偏移量（锚点只走 anchor 片段）');
ok(/只存在你自己的后端/.test(js), '加书时说明正文存哪儿（自己的后端）');

console.log('\n=== 3. 目录与一次性 ===');
ok(/data-rd-ai/.test(js) && /data-rd-del/.test(js), '每条批注都有「让它回应」与「删掉」');
ok(/data-rd-ch/.test(js), '目录里每一章可点');
ok(/data-rd="toc"/.test(js), '章头有目录键（data-rd="toc"）');

/* ── 假 DOM ───────────────────────────────────────────────────────────── */
function mkEl(tag) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(),
    innerHTML: '', textContent: '', value: '',
    style: {}, dataset: {}, children: [], _cls: {}, _ev: {},
    scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    classList: {
      add(c) { e._cls[c] = 1; }, remove(c) { delete e._cls[c]; },
      toggle(c, on) { if (on === undefined) on = !e._cls[c]; if (on) e._cls[c] = 1; else delete e._cls[c]; },
      contains(c) { return !!e._cls[c]; },
    },
    appendChild(c) { e.children.push(c); return c; },
    addEventListener(t, f) { (e._ev = e._ev || {})[t] = f; },
    removeEventListener() {},
    setAttribute(k, v) { e[k] = v; }, getAttribute(k) { return e[k] === undefined ? '' : e[k]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
  };
  Object.defineProperty(e, 'id', { get() { return e._id || ''; }, set(v) { e._id = v; } });
  return e;
}

const BOOK = {
  ok: true, id: 'b1', title: '雨', index: 1, total: 3,
  ch_title: '第二章 再会',
  body: '后来他们又见了一面，谁也没提那天的事。\n\n她点了杯热的，他要了杯冰的。',
  chs: ['第一章 初见', '第二章 再会', '第三章 分别'],
  notes: [{ id: 'n1', ch: 1, anchor: '雨顺着伞骨往下淌', note: '这句让我想起那天', who: 'me',
            replies: [{ who: 'ai', text: '你说的这句，我想起小时候也有一回。' }] }],
};

function harness(opts) {
  const o = opts || {};
  const byId = {};
  const calls = [];
  const doc = {
    readyState: 'complete', body: mkEl('body'), createElement: mkEl,
    getElementById(id) { if (!byId[id]) byId[id] = mkEl('div'); return byId[id]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {},
  };
  const sandbox = {
    console, document: doc,
    requestAnimationFrame: (f) => { try { f(0); } catch (_) {} },
    setTimeout, clearTimeout,
    __DayHost: { aiName: () => '阿澈', meName: () => '西西' },
  };
  sandbox.window = sandbox;
  sandbox.memApi = async (p, opt) => {
    calls.push({ path: p, body: (opt && opt.body) ? JSON.parse(opt.body) : null,
                 method: (opt && opt.method) || 'GET' });
    if (o.memApi) return o.memApi(p, opt, calls);
    if (p.indexOf('/app/read/state') === 0) return { ok: true, books: o.books || [] };
    if (p.indexOf('/app/read/book') === 0) return o.book || BOOK;
    if (p.indexOf('/app/read/note/ai') === 0) return { ok: true, reply: '它回了一条' };
    if (p.indexOf('/app/read/note/del') === 0) return { ok: true };
    if (p.indexOf('/app/read/note') === 0) return { ok: true };
    if (p.indexOf('/app/read/add') === 0) return { ok: true, id: 'b2', n_ch: 3 };
    if (p.indexOf('/app/read/pos') === 0) return { ok: true };
    return { ok: true };
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(js + '\n; globalThis.__R = window.ReadPack;', ctx);
  return { R: ctx.__R, calls, id: (k) => byId[k] };
}

console.log('\n=== 4. 假 DOM：真跑一遍 ===');
let H;
try {
  H = harness({ books: [
    { id: 'b1', title: '雨', n_ch: 3, notes: 2, pos: { ch: 1, pct: 0.4 }, chars: 3000 },
  ] });
  ok(!!H.R, 'read-pack 在假环境里跑起来了');
} catch (e) { ok(false, 'read-pack 跑不起来', String((e && e.message) || e)); }

if (H && H.R) {
  const { R, calls, id } = H;

  PENDING.push((async () => {
    R.open();
    await new Promise((r) => setTimeout(r, 30));
    ok(calls.some((c) => c.path.indexOf('/app/read/state') === 0), '打开时拉 /app/read/state');
    const shelfHtml = (id('rdScroll') || {}).innerHTML || '';
    ok(/雨/.test(shelfHtml), '书架上画出书名');
    ok(/3 章/.test(shelfHtml), '带章节数');
    ok(/2 条批注/.test(shelfHtml), '带批注数');
    ok(/读到第 2 章/.test(shelfHtml), '★ 带"读到第几章"');
    ok(/rd-bar/.test(shelfHtml), '有进度条');

    /* 翻开一本 */
    calls.length = 0;
    await R._openBook('b1');
    const bookCall = calls.filter((c) => c.path.indexOf('/app/read/book') === 0)[0];
    ok(!!bookCall, '点一本会去读它');
    ok(bookCall.path.indexOf('id=b1') >= 0, '带上了书的 id');
    const readHtml = (id('rdScroll') || {}).innerHTML || '';
    ok(/第二章 再会/.test(readHtml), '章节名画出来了');
    ok(/谁也没提那天的事/.test(readHtml), '正文画出来了');
    ok(/这块让我想起那天|这句让我想起那天/.test(readHtml), '批注画出来了');
    ok(/雨顺着伞骨往下淌/.test(readHtml), '★ 批注上的划线那句也画出来了');
    ok(/它回了一条|小时候也有一回/.test(readHtml), '★ 它的回应挂在批注下面');

    /* 翻章 */
    calls.length = 0;
    await R._turn(1);
    const t = calls.filter((c) => c.path.indexOf('/app/read/book') === 0)[0];
    ok(!!t && t.path.indexOf('ch=2') >= 0, '★ 下一章带上了章序号');

    /* 留一句 */
    calls.length = 0;
    R._set({ book: BOOK });
    id('rdNote').value = '  这句话我不同意  ';
    id('rdAnchor').value = '谁也没提那天的事';
    await R._saveNote();
    const nCall = calls.filter((c) => c.path === '/app/read/note')[0];
    ok(!!nCall, '留一句走 POST /app/read/note');
    eq((nCall.body || {}).note, '这句话我不同意', '★ 去掉了首尾空白');
    eq((nCall.body || {}).anchor, '谁也没提那天的事', '★ 锚点（划到的那句）一起发出去');
    eq((nCall.body || {}).bid, 'b1', '带书 id');
    eq((nCall.body || {}).ch, 1, '带章序号');

    /* 空的别发 */
    calls.length = 0;
    id('rdNote').value = '   ';
    await R._saveNote();
    ok(!calls.some((c) => c.path === '/app/read/note'), '★ 空的不发出去');

    /* 让它回应 */
    calls.length = 0;
    await R._askAI('n1');
    const aCall = calls.filter((c) => c.path === '/app/read/note/ai')[0];
    ok(!!aCall, '「让它回应」走 POST /app/read/note/ai');
    eq((aCall.body || {}).id, 'n1', '带上是哪一条批注');

    /* 删一条 */
    calls.length = 0;
    await R._delNote('n1');
    ok(calls.some((c) => c.path === '/app/read/note/del'), '删批注有对应接口');

    /* 加书 */
    calls.length = 0;
    R._set({ sheet: 'add' });
    id('rdNewTitle').value = '雨';
    id('rdNewText').value = '第一章 初见\n\n正文…';
    await R._addBook();
    const addCall = calls.filter((c) => c.path === '/app/read/add')[0];
    ok(!!addCall, '加书走 POST /app/read/add');
    eq((addCall.body || {}).title, '雨', '带书名');
    ok(/第一章 初见/.test((addCall.body || {}).text || ''), '带正文');

    /* 空的加书不发 */
    calls.length = 0;
    id('rdNewText').value = '   ';
    await R._addBook();
    ok(!calls.some((c) => c.path === '/app/read/add'), '★ 正文空的时候不发出去');
    ok(/还没粘进来/.test(JSON.stringify(R._state().note)), '而是明说"正文还没粘进来"');

    /* 进度上报要节流 */
    calls.length = 0;
    R._set({ book: BOOK });
    const sc = id('rdScroll');
    if (sc._ev && sc._ev.scroll) {
      sc._ev.scroll();
      sc._ev.scroll();
      sc._ev.scroll();
      ok(!calls.some((c) => c.path === '/app/read/pos'),
        '★ 刚滚完不发（要等停一下）—— 不然手机上就是一直在打后端');
      await new Promise((r) => setTimeout(r, 1400));
      ok(calls.some((c) => c.path === '/app/read/pos'),
        '停一会儿之后才发一次进度');
      const pCall = calls.filter((c) => c.path === '/app/read/pos')[0];
      eq((pCall.body || {}).id, 'b1', '进度带上书 id');
      ok(typeof (pCall.body || {}).pct === 'number', '带章内百分比');
    } else {
      ok(false, '滚动监听没绑上（onScroll 接不到）');
    }
  })());
}

Promise.allSettled(PENDING).then(() => {
  console.log('\n──────────────────────────────');
  console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
  process.exit(FAIL ? 1 : 0);
});
