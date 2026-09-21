/*
 * 信箱自检 —— 用法：node smoke-letter.js [index.html] [letter-pack.js]
 *
 * 这一类页面的坏法，node --check 一个都拦不住：
 *   · 授权码被回显到界面上（等于把密码发到浏览器里）
 *   · 提示里不说"要填授权码不是登录密码"—— 用户会拿登录密码试，然后卡住
 *   · "写一封"拆标题拆错，把正文吃掉
 *   · 乌有乡那栏假装有内容（它现在根本没 key）
 *   · 删除 / 寄出接不上（点了没反应）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTMLP = process.argv[2] || path.join(__dirname, 'index.html');
const JSP = process.argv[3] || path.join(__dirname, 'letter-pack.js');
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
ok(html.includes('letter-pack.css'), 'index.html 引入了 letter-pack.css');
ok(html.includes('letter-pack.js'), 'index.html 引入了 letter-pack.js');
ok(/<script defer src="letter-pack\.js">/.test(html), '用 defer');
ok(sw.includes('./letter-pack.css') && sw.includes('./letter-pack.js'),
  '★ sw 的 PRECACHE 里有这两个文件（不然离线打开是空的）');
ok(/companion-v1\d\d/.test((/const CACHE = "([^"]+)"/.exec(sw) || [])[1] || ''), 'CACHE 是本次版本');
const rows = arrBlock(day, '{ t: "生活记录", rows: [');
ok(/k:\s*"letter"/.test(rows) && /n:\s*"信箱"/.test(rows), '★ Movie 里有「信箱」这张卡');
const acts = arrBlock(day, 'const ACTIONS = {');
ok(/letter:\s*\{[^}]*fn:\s*"openLetter"/.test(acts),
  '★ ACTIONS 里也登记了（少一边 = 点了没反应）');
ok(/window\.openLetter\s*=/.test(js), 'letter-pack 挂出了 window.openLetter');

console.log('\n=== 2. 授权码不进浏览器 ===');
const cfgBlk = (/function paintSheet\(\)[\s\S]*?\n  \}/).exec(js) || [''];
ok(!/value="'\s*\+\s*esc\(m\.code/.test(cfgBlk[0]), '★ 授权码不进 input 的 value');
ok(/m\.has_code/.test(cfgBlk[0]), '只显示"有没有填过"');
ok(/留空 = 不改/.test(cfgBlk[0]), '并说明留空 = 不改（GET 不回显，框本来就是空的）');
ok(/不是登录密码/.test(js), '★ 提示里说清"授权码不是登录密码"（最常见的卡点）');
ok(/QQ 邮箱设置/.test(js) || /账户/.test(js), '并说明去哪儿生成');

console.log('\n=== 3. 乌有乡那栏不假装有 ===');
ok(/postcards/.test(js), '界面读了明信片状态');
ok(/c\.ok/.test(js) && /c\.note/.test(js), '★ 没接上时显示后端给的原因（不写死一句"敬请期待"）');
ok(/X-Nowhere-Key/.test(js), '说清缺的是 X-Nowhere-Key');

/* ── 假 DOM ───────────────────────────────────────────────────────────── */
function mkEl(tag) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(),
    innerHTML: '', textContent: '', value: '',
    style: {}, dataset: {}, children: [], _cls: {},
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
  };
  Object.defineProperty(e, 'id', { get() { return e._id || ''; }, set(v) { e._id = v; } });
  return e;
}

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
    if (p.indexOf('/app/letter/state') === 0) {
      return { ok: true, unread: 1, mail: o.mail || {}, postcards: o.cards || { ok: false, wired: false, note: '还没接上乌有乡', n_done: 0 },
               letters: o.letters || [] };
    }
    if (p.indexOf('/app/letter/get') === 0) return { ok: true, letter: o.one || { id: 'a1', title: '今晚的风', who: 'ai', body: '正文在这里', at: '2026-09-21 22:00' } };
    if (p.indexOf('/app/letter/ai') === 0) return { ok: true, letter: { title: '它写的' } };
    if (p.indexOf('/app/letter/write') === 0) return { ok: true };
    if (p.indexOf('/app/letter/mail/send') === 0) return { ok: true, to: 'me@qq.com' };
    if (p.indexOf('/app/letter/mail/probe') === 0) return { ok: true, note: '登录成功' };
    if (p.indexOf('/app/letter/mail') === 0) return { ok: true, mail: { from: 'me@qq.com', has_code: true, ready: true } };
    if (p.indexOf('/app/letter/del') === 0) return { ok: true };
    return { ok: true };
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(js + '\n; globalThis.__L = window.LetterPack;', ctx);
  return { L: ctx.__L, calls, id: (k) => byId[k], sandbox };
}

const LETTERS = [
  { id: 'a1', title: '今晚的风', who: 'ai', ts: Date.now() / 1000, read: false, delivered: false, excerpt: '今天路过那家店…', chars: 30 },
  { id: 'a2', title: '给你', who: 'me', ts: Date.now() / 1000 - 90000, read: true, delivered: true, excerpt: '……', chars: 10 },
];

console.log('\n=== 4. 假 DOM：真跑一遍 ===');
let H;
try { H = harness({ letters: LETTERS }); ok(!!H.L, 'letter-pack 在假环境里跑起来了'); }
catch (e) { ok(false, 'letter-pack 跑不起来', String((e && e.message) || e)); }

if (H && H.L) {
  const { L, calls, id } = H;

  eq(L._ago(Date.now() / 1000), '刚刚', '刚刚');
  eq(L._ago(Date.now() / 1000 - 120), '2 分钟前', '2 分钟前');
  eq(L._ago(Date.now() / 1000 - 7200), '2 小时前', '2 小时前');
  eq(L._ago(0), '', '没有时间戳时是空的');

  eq(L._who('ai'), '阿澈', '★ 它写的显示宿主给的名字');
  eq(L._who('me'), '西西', '我写的显示我的名字');
  eq(L._who('nowhere'), '乌有乡', '★ 乌有乡的显示「乌有乡」（不是"我"也不是它）');

  PENDING.push((async () => {
    L.open();
    await new Promise((r) => setTimeout(r, 30));
    ok(calls.some((c) => c.path.indexOf('/app/letter/state') === 0), '打开时拉了 /app/letter/state');
    eq(L._state().letters.length, 2, '信读回来了');
    eq(L._state().unread, 1, '未读数带上了');
    const listHtml = (id('ltList') || {}).innerHTML || '';
    ok(/今晚的风/.test(listHtml), '列表里有「今晚的风」');
    ok(/lt-item unread/.test(listHtml), '★ 未读那封带 unread（样式与圆点靠它）');

    /* 筛选 */
    L._tab('ai');
    const aiHtml = (id('ltList') || {}).innerHTML || '';
    ok(/今晚的风/.test(aiHtml) && !/给你/.test(aiHtml), '★ 切到「它写的」只剩它那封');
    L._tab('me');
    const meHtml = (id('ltList') || {}).innerHTML || '';
    ok(/给你/.test(meHtml) && !/今晚的风/.test(meHtml), '切到「我写的」只剩我这封');
    L._tab('all');

    /* 乌有乡那栏 */
    L._tab('nowhere');
    const cardHtml = (id('ltList') || {}).innerHTML || '';
    ok(/还没接上乌有乡/.test(cardHtml), '★ 乌有乡那栏显示后端给的原因');
    ok(/接上之后/.test(cardHtml), '并说清接上之后会有什么（不是一句干巴巴的"无"）');
    L._tab('all');

    /* 读一封 */
    calls.length = 0;
    await L._open('a1');
    ok(calls.some((c) => c.path.indexOf('/app/letter/get?id=a1') === 0), '点一封会拉它的正文');
    const oneHtml = (id('ltList') || {}).innerHTML || '';
    ok(/正文在这里/.test(oneHtml), '正文画出来了');
    ok(/寄到我的邮箱/.test(oneHtml), '有「寄到我的邮箱」这个键');
    ok(/删掉/.test(oneHtml), '有「删掉」这个键');

    /* 寄出 */
    calls.length = 0;
    await L._send();
    const sendCall = calls.filter((c) => c.path.indexOf('/app/letter/mail/send') === 0)[0];
    ok(!!sendCall, '寄出走 POST /app/letter/mail/send');
    eq((sendCall.body || {}).id, 'a1', '带上是哪一封');

    /* 让它写一封 */
    calls.length = 0;
    await L._writeAI();
    const aiCall = calls.filter((c) => c.path.indexOf('/app/letter/ai') === 0)[0];
    ok(!!aiCall, '「让它写一封」走 POST /app/letter/ai');

    /* 自己写一封：第一行当标题
       ★ 这里必须调 pack 的 _writeSave，不能"在测试里再写一遍拆标题的逻辑"——
         那样断言的是测试自己那份，等于没测到 pack。 */
    calls.length = 0;
    id('ltWrite').value = '今晚的风\n\n今天路过那家店，想起来你说过想吃里面的东西。';
    L._set({ sheet: 'write' });
    await L._writeSave();
    const wCall = calls.filter((c) => c.path.indexOf('/app/letter/write') === 0)[0];
    ok(!!wCall, '写一封走 POST /app/letter/write');
    eq((wCall.body || {}).title, '今晚的风', '★ 第一行当标题');
    ok(/路过那家店/.test((wCall.body || {}).body || ''), '★ 正文没被标题吃掉');
    eq((wCall.body || {}).who, 'me', '我写的 who 是 me');

    /* 没写空行时也要保住正文 */
    calls.length = 0;
    id('ltWrite').value = '今晚的风\n今天路过那家店。';
    await L._writeSave();
    const w2 = calls.filter((c) => c.path.indexOf('/app/letter/write') === 0)[0];
    ok(/路过那家店/.test((w2.body || {}).body || ''), '★ 没空行时正文也不能丢');

    /* 空的就别发 */
    calls.length = 0;
    id('ltWrite').value = '   ';
    await L._writeSave();
    ok(!calls.some((c) => c.path.indexOf('/app/letter/write') === 0), '★ 空的一封不发出去');

    /* 邮箱设置：授权码留空也要发出去（后端按"空 = 不改"处理） */
    calls.length = 0;
    L._set({ sheet: 'cfg', mail: { from: 'me@qq.com', has_code: true, ready: true, host: 'smtp.qq.com' } });
    id('ltFrom').value = 'me@qq.com';
    id('ltCode').value = '';
    id('ltTo').value = '';
    id('ltHost').value = 'smtp.qq.com';
    await L._mailSave(false);
    const saveCall = calls.filter((c) => c.path === '/app/letter/mail')[0];
    ok(!!saveCall, '保存邮箱走 POST /app/letter/mail');
    eq((saveCall.body || {}).code, '', '★ 授权码为空照样发出去（后端按"空 = 不改"处理，不能前端自作主张丢掉这个字段）');
    eq((saveCall.body || {}).from, 'me@qq.com', '发件地址带上了');

    /* 测试连接 */
    calls.length = 0;
    await L._mailProbe();
    ok(calls.some((c) => c.path.indexOf('/app/letter/mail/probe') === 0), '「测试连接」有对应的接口');
  })());
}

Promise.allSettled(PENDING).then(() => {
  console.log('\n──────────────────────────────');
  console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
  process.exit(FAIL ? 1 : 0);
});
