/*
 * 看电影自检 —— 用法：node smoke-cinema.js [index.html] [cinema-pack.js]
 *
 * 这一类页面的坏法，node --check 一个都拦不住：
 *   · 留言没绑播放位置（那就成了普通聊天，不是"一起看"）
 *   · 时间轴回退时不重排 → 拖完进度满屏弹幕一次性刷出来
 *   · 每帧都去问时间轴（手机上等于一直在打后端）
 *   · 没贴片源时点播放什么都不发生（点了没反应）
 *   · 假装它看过这部电影
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTMLP = process.argv[2] || path.join(__dirname, 'index.html');
const JSP = process.argv[3] || path.join(__dirname, 'cinema-pack.js');
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
ok(html.includes('cinema-pack.css'), 'index.html 引入了 cinema-pack.css');
ok(html.includes('cinema-pack.js'), 'index.html 引入了 cinema-pack.js');
ok(/<script defer src="cinema-pack\.js">/.test(html), '用 defer');
ok(sw.includes('./cinema-pack.css') && sw.includes('./cinema-pack.js'),
  '★ sw 的 PRECACHE 里有这两个文件');
ok(/companion-v1\d\d/.test((/const CACHE = "([^"]+)"/.exec(sw) || [])[1] || ''), 'CACHE 是本次版本');
const rows = arrBlock(day, '{ t: "一起做", rows: [');
ok(/k:\s*"film"/.test(rows) && /n:\s*"看电影"/.test(rows), '★ Movie 里有「看电影」这张卡');
const acts = arrBlock(day, 'const ACTIONS = {');
ok(/film:\s*\{[^}]*fn:\s*"openCinema"/.test(acts), '★ ACTIONS 里也登记了');
ok(/window\.openCinema\s*=/.test(js), 'cinema-pack 挂出了 window.openCinema');
ok(!/\bopenCinema\b/.test(html), '★ 宿主里没有同名函数');

console.log('\n=== 2. 它没看过这部片 —— 界面要照实说 ===');
ok(/它没看过这部/.test(js), '★ 片源设置里说清"它没看过这部片"');
ok(/现在放到第几秒|放到第几分几秒|说到第几秒/.test(js), '说明它接的是"放到第几秒"这件事');

console.log('\n=== 3. 不每帧打后端 ===');
ok(/TICK_MS\s*=\s*\d+/.test(js), '★ 时间轴有节流常量：' + ((/TICK_MS\s*=\s*(\d+)/.exec(js) || [])[1] || '?') + 'ms');
ok(/setInterval\(tick, TICK_MS\)/.test(js), '按这个间隔问，不是每帧问');
ok(!/addEventListener\("timeupdate",\s*.*tick/.test(js), 'timeupdate 里没有直接调 tick');

/* ── 假 DOM ───────────────────────────────────────────────────────────── */
function mkEl(tag) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(),
    innerHTML: '', textContent: '', value: '', src: '',
    style: {}, dataset: {}, children: [], _cls: {}, _ev: {}, _attr: {},
    currentTime: 0, duration: 0, paused: true,
    classList: {
      add(c) { e._cls[c] = 1; }, remove(c) { delete e._cls[c]; },
      toggle(c, on) { if (on === undefined) on = !e._cls[c]; if (on) e._cls[c] = 1; else delete e._cls[c]; },
      contains(c) { return !!e._cls[c]; },
    },
    appendChild(c) { e.children.push(c); return c; },
    removeChild(c) { e.children = e.children.filter((x) => x !== c); return c; },
    addEventListener(t, f) { (e._ev = e._ev || {})[t] = f; },
    removeEventListener() {},
    setAttribute(k, v) { e._attr[k] = v; if (k === 'src') e.src = v; },
    getAttribute(k) { return e._attr[k] === undefined ? '' : e._attr[k]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {},
    getBoundingClientRect() { return { left: 0, width: 200, top: 0, height: 100 }; },
    load() {}, play() { e.paused = false; return Promise.resolve(); }, pause() { e.paused = true; },
  };
  Object.defineProperty(e, 'id', { get() { return e._id || ''; }, set(v) { e._id = v; } });
  return e;
}

const DANMU = [
  { id: 'd1', who: 'me', text: '这里我在电影院看过', ms: 65000, ts: Date.now() / 1000 },
  { id: 'd2', who: 'ai', text: '这段我刚才也想说', ms: 70000, ts: Date.now() / 1000 },
];

function harness(opts) {
  const o = opts || {};
  const byId = {};
  const calls = [];
  const doc = {
    readyState: 'complete', body: mkEl('body'),
    createElement: (t) => mkEl(t),
    getElementById(id) { if (!byId[id]) byId[id] = mkEl(id === 'cnVideo' ? 'video' : 'div'); return byId[id]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {},
  };
  const sandbox = {
    console, document: doc,
    requestAnimationFrame: (f) => { try { f(0); } catch (_) {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    __DayHost: { aiName: () => '阿澈', meName: () => '西西' },
  };
  sandbox.window = sandbox;
  sandbox.memApi = async (p, opt) => {
    calls.push({ path: p, body: (opt && opt.body) ? JSON.parse(opt.body) : null,
                 method: (opt && opt.method) || 'GET' });
    if (o.memApi) return o.memApi(p, opt, calls);
    if (p.indexOf('/app/cinema/state') === 0) {
      return { ok: true, danmu: o.danmu || [], count: (o.danmu || []).length,
               cfg: o.cfg || { url: 'http://x/a.mp4', title: '海边', last_ms: 0, autosay: true, wired: true } };
    }
    if (p.indexOf('/app/cinema/timeline') === 0) {
      return o.timeline || { ok: true, msgs: [], reset: false };
    }
    if (p.indexOf('/app/cinema/danmu/del') === 0) return { ok: true };
    if (p.indexOf('/app/cinema/danmu') === 0) {
      return { ok: true, msg: { id: 'new', who: 'me', text: 'ok', ms: 1000, ts: Date.now() / 1000 } };
    }
    if (p.indexOf('/app/cinema/say') === 0) {
      return { ok: true, msg: { id: 'say', who: 'ai', text: '它说的', ms: 2000, ts: Date.now() / 1000 } };
    }
    if (p.indexOf('/app/cinema/cfg') === 0) {
      return { ok: true, cfg: o.cfg || { url: 'http://x/a.mp4', title: '海边', last_ms: 0, autosay: true } };
    }
    return { ok: true };
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(js + '\n; globalThis.__C = window.CinemaPack;', ctx);
  return { C: ctx.__C, calls, id: (k) => byId[k] };
}

console.log('\n=== 4. 假 DOM：真跑一遍 ===');
let H;
try { H = harness({ danmu: DANMU }); ok(!!H.C, 'cinema-pack 在假环境里跑起来了'); }
catch (e) { ok(false, 'cinema-pack 跑不起来', String((e && e.message) || e)); }

if (H && H.C) {
  const { C, calls, id } = H;

  eq(C._mmss(65000, true), '1:05', '毫秒 → 1:05');
  eq(C._mmss(3725000, true), '1:02:05', '超过一小时带上小时');
  eq(C._mmss(0, true), '0:00', '0 毫秒 → 0:00');

  PENDING.push((async () => {
    C.open();
    await new Promise((r) => setTimeout(r, 30));
    ok(calls.some((c) => c.path.indexOf('/app/cinema/state') === 0), '打开时拉 /app/cinema/state');
    eq(C._state().danmu.length, 2, '留言读回来了');
    const listHtml = (id('cnList') || {}).innerHTML || '';
    ok(/这里我在电影院看过/.test(listHtml), '我的话画出来了');
    ok(/这段我刚才也想说/.test(listHtml), '它的话也画出来了');
    ok(/1:05/.test(listHtml) && /1:10/.test(listHtml), '★ 每条都带着"说到第几秒"');
    ok(/cn-row ai/.test(listHtml), '它那条带 ai（样式与对齐靠它）');

    /* 留言要绑当前位置 */
    calls.length = 0;
    const v = id('cnVideo');
    v.currentTime = 125.4;                 // 播到 2:05.4
    id('cnInput').value = '  这个人好像我表哥  ';
    await C._send();
    const dCall = calls.filter((c) => c.path === '/app/cinema/danmu')[0];
    ok(!!dCall, '留言走 POST /app/cinema/danmu');
    eq((dCall.body || {}).text, '这个人好像我表哥', '★ 去掉首尾空白');
    eq((dCall.body || {}).ms, 125400, '★ 带上当时的播放位置（毫秒）——这一层的关键就是它');
    eq((dCall.body || {}).who, 'me', 'who 是 me');

    /* 空的不发 */
    calls.length = 0;
    id('cnInput').value = '   ';
    await C._send();
    ok(!calls.some((c) => c.path === '/app/cinema/danmu'), '★ 空的不发出去');

    /* 让它说一句 */
    calls.length = 0;
    await C._say(true);
    const sCall = calls.filter((c) => c.path === '/app/cinema/say')[0];
    ok(!!sCall, '「让它说一句」走 POST /app/cinema/say');
    eq((sCall.body || {}).force, true, '★ 手动按的带 force');
    ok(typeof (sCall.body || {}).ms === 'number', '带上播放位置（它才知道现在说到第几秒）');

    /* 时间轴：只问一次、带 after 游标 */
    calls.length = 0;
    v.currentTime = 130;
    C._set({ lastMs: 100000 });
    await C._tick();
    const tCall = calls.filter((c) => c.path.indexOf('/app/cinema/timeline') === 0)[0];
    ok(!!tCall, '时间轴走 /app/cinema/timeline');
    ok(tCall.path.indexOf('upto=130000') >= 0, '带上"现在到哪了"');
    ok(tCall.path.indexOf('after=100000') >= 0, '★ 带上"上次处理到哪"（游标，不是每次都全量）');

    /* 拖进度：reset 时不补发 */
    const H2 = harness({
      danmu: DANMU,
      timeline: { ok: true, reset: true, msgs: [{ id: 'x', who: 'me', text: '不该补发', ms: 5000 }] },
    });
    PENDING.push((async () => {
      H2.C.open();
      await new Promise((r) => setTimeout(r, 20));
      H2.C._set({ lastMs: 90000 });
      H2.id('cnVideo').currentTime = 5;
      await H2.C._tick();
      const layer = H2.id('cnLayer');
      eq((layer.children || []).length, 0,
        '★ reset（拖了进度）时**不补发** —— 拖完满屏弹幕不叫一起看');
      eq(H2.C._state().lastMs, 5000, '但游标要挪过去（下次从新位置接着算）');
    })());

    /* 正常推进时才飘 */
    const H3 = harness({
      danmu: [],
      timeline: { ok: true, reset: false, msgs: [{ id: 'y', who: 'ai', text: '到点了', ms: 3000 }] },
    });
    PENDING.push((async () => {
      H3.C.open();
      await new Promise((r) => setTimeout(r, 20));
      H3.C._set({ lastMs: 1000 });
      H3.id('cnVideo').currentTime = 3;
      await H3.C._tick();
      ok((H3.id('cnLayer').children || []).length >= 1, '到点了就放出来（飘一条）');
    })());

    /* 没贴片源时点播放 → 打开片源抽屉，不静默 */
    const H4 = harness({ cfg: { url: '', title: '', last_ms: 0, autosay: true, wired: false } });
    PENDING.push((async () => {
      H4.C.open();
      await new Promise((r) => setTimeout(r, 20));
      await H4.C._toggle();
      eq(H4.C._state().sheet, 'src', '★ 没片源时点播放会打开片源抽屉（不是什么都没发生）');
      ok((H4.id('cnSheet').innerHTML || '').length > 0, '抽屉真的画出来了');
    })());

    /* 保存片源 */
    calls.length = 0;
    C._set({ sheet: 'src' });
    id('cnTitle').value = '海边';
    id('cnUrl').value = 'http://x/b.mp4';
    id('cnAuto').checked = true;
    await C._saveCfg();
    const cfgCall = calls.filter((c) => c.path === '/app/cinema/cfg')[0];
    ok(!!cfgCall, '保存片源走 POST /app/cinema/cfg');
    eq((cfgCall.body || {}).url, 'http://x/b.mp4', '带地址');
    eq((cfgCall.body || {}).title, '海边', '带片名');

    /* 点时间跳回去 */
    const v5 = id('cnVideo');
    v5.currentTime = 0;
    C._nudge(10);
    eq(v5.currentTime, 10, '快进 10 秒');

    /* 删一条 */
    calls.length = 0;
    await C._del('d1');
    ok(calls.some((c) => c.path === '/app/cinema/danmu/del'), '删留言有对应接口');
  })());
}

Promise.allSettled(PENDING).then(() => {
  console.log('\n──────────────────────────────');
  console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
  process.exit(FAIL ? 1 : 0);
});
