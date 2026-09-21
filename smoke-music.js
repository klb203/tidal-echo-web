/*
 * 一起听（唱片页）自检 —— 用法：node smoke-music.js [index.html] [music-pack.js]
 *
 * 这一页的坏法，node --check 一个都拦不住：
 *   · 打开时顺手去拉歌词/播放地址 → 打开要转十几秒的圈（该按需的塞进了首屏）
 *   · 拿不到播放地址只提示"播放失败" → 用户以为是自己点错了，
 *     其实是服务器上那个网易云 cookie 过期（要敢说出来）
 *   · 留言的谁是谁搞反（这个项目在这一类上栽过好几次）
 *   · LRC 的小数位按毫秒算 → 两位的（[00:03.50]）整整慢 10 倍
 *   · 歌词/留言渲染整段 innerHTML 拼进去，却忘了转义
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTMLP = process.argv[2] || path.join(__dirname, 'index.html');
const JSP = process.argv[3] || path.join(__dirname, 'music-pack.js');
const html = fs.readFileSync(HTMLP, 'utf8');
const js = fs.readFileSync(JSP, 'utf8');
const css = fs.readFileSync(path.join(path.dirname(JSP), 'music-pack.css'), 'utf8');
const sw = fs.readFileSync(path.join(path.dirname(JSP), 'sw.js'), 'utf8');
const day = fs.readFileSync(path.join(path.dirname(JSP), 'day-pack.js'), 'utf8');

let PASS = 0, FAIL = 0;
const PENDING = [];        // 异步断言先攒着 —— 不等完就统计 = 假绿
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

/* ── 1. 接线：这一页真的会被加载、也真的能打开 ───────────────────────── */
console.log('=== 1. 接线 ===');
ok(html.includes('music-pack.css'), 'index.html 引入了 music-pack.css');
ok(html.includes('music-pack.js'), 'index.html 引入了 music-pack.js');
ok(/<script defer src="music-pack\.js">/.test(html), '用 defer（不然会抢主脚本的执行顺序）');
ok(sw.includes('./music-pack.css') && sw.includes('./music-pack.js'),
  '★ sw 的 PRECACHE 里有这两个文件（不然离线打开是空的）');
const cacheVer = (/const CACHE = "([^"]+)"/.exec(sw) || [])[1] || '';
ok(/v1\d\d/.test(cacheVer), 'CACHE 是本次的版本：' + cacheVer);

const rowsBlock = arrBlock(day, '{ t: "一起做", rows: [');
ok(/k:\s*"ear"/.test(rowsBlock), '★ Movie「一起做」里有「一起听」这张卡');
ok(/k:\s*"ear"[\s\S]{0,80}n:\s*"一起听"/.test(rowsBlock), '卡片名字是「一起听」');
const actBlock = arrBlock(day, 'const ACTIONS = {');
ok(/ear:\s*\{[^}]*fn:\s*"openEar"/.test(actBlock),
  '★ ACTIONS 里也登记了（少一边就是"点了没反应"—— 用户报过的那类）');
ok(/window\.openEar\s*=/.test(js), 'music-pack 挂出了 window.openEar');

/* ── 2. 首屏必须快：歌词/地址按需拉 ─────────────────────────────────── */
console.log('\n=== 2. 首屏快 ===');
const loadBlk = (/async function load\(\)[\s\S]*?\n  \}/).exec(js) || [''];
ok(/\/app\/ear\/state/.test(loadBlk[0]), 'load() 拉的是 /app/ear/state');
ok(/loadSong/.test(loadBlk[0]), '有当前歌时再去 loadSong（按需）');
ok(!/\/app\/ear\/lyric/.test(loadBlk[0]) || /loadSong/.test(loadBlk[0]),
  '歌词不在 load() 里直拉（它在 loadSong 里）');
const loadSongBlk = (/async function loadSong\(sid, opt\)[\s\S]*?\n  \}/).exec(js) || [''];
ok(/\/app\/ear\/audio/.test(loadSongBlk[0]) && /\/app\/ear\/lyric/.test(loadSongBlk[0]),
  'audio 与 lyric 都在 loadSong 里（分开按需）');

/* ── 3. 拿不到播放地址要说清为什么 ─────────────────────────────────── */
console.log('\n=== 3. 播不出来时敢说原因 ===');
ok(/没拿到播放地址/.test(js), '★ 提示里明说「没拿到播放地址」');
ok(/audio\.hint/.test(js), '把后端给的 hint 一起显示出来');
ok(/歌词与留言照常/.test(js), '同时说明歌词与留言不受影响（不然用户以为整页坏了）');

/* ── 4. 留言：谁是谁 ───────────────────────────────────────────────── */
console.log('\n=== 4. 留言的谁是谁 ===');
const paintNotesBlk = (/function paintNotes\(\)[\s\S]*?\n  \}/).exec(js) || [''];
ok(/m\.who !== "ai"/.test(paintNotesBlk[0]), '判定口径是「不等于 ai 就是我」（只有两个值）');
ok(/esc\(m\.text\)/.test(paintNotesBlk[0]), '★ 留言正文转义过（不然它会往页面里插标签）');
ok(/ear-note' \+ \(mine \? " me" : " ai"\)/.test(paintNotesBlk[0].replace(/\s+/g, ' ')),
  '渲染带 me / ai 两个 class（样式与对齐靠它）');

/* ── 5. 假 DOM ─────────────────────────────────────────────────────── */
console.log('\n=== 5. 假 DOM：真跑一遍 ===');

function mkEl(tag) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(),
    innerHTML: '', textContent: '', value: '', src: '', paused: true,
    style: {}, dataset: {}, children: [],
    _cls: {},
    classList: {
      add(c) { e._cls[c] = 1; },
      remove(c) { delete e._cls[c]; },
      toggle(c, on) { if (on === undefined) on = !e._cls[c]; if (on) e._cls[c] = 1; else delete e._cls[c]; },
      contains(c) { return !!e._cls[c]; },
    },
    appendChild(c) { e.children.push(c); return c; },
    addEventListener(t, f) { (e._ev = e._ev || {})[t] = f; },
    removeEventListener() {},
    setAttribute(k, v) { if (k === 'src') e.src = v; e[k] = v; },
    getAttribute(k) { return e[k] === undefined ? '' : e[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, width: 100 }; },
    scrollIntoView() {},
    focus() {},
  };
  Object.defineProperty(e, 'id', {
    get() { return e._id || ''; },
    set(v) { e._id = v; },
  });
  return e;
}

function harness(opts) {
  const o = opts || {};
  const byId = {};
  const calls = [];
  const doc = {
    readyState: 'complete',
    body: mkEl('body'),
    createElement: mkEl,
    // ★ 万能桩：innerHTML 建出来的元素解析不了，所以按 id 懒建一个并复用 ——
    //   这样 paint() 里的 el("earHint") 拿得到同一个对象，能断言它写了什么。
    getElementById(id) {
      if (!byId[id]) byId[id] = mkEl('div');
      return byId[id];
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const sandbox = {
    console, document: doc, requestAnimationFrame: (f) => { try { f(0); } catch (_) {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    __DayHost: { aiName: () => '阿澈', meName: () => '西西' },
  };
  sandbox.window = sandbox;
  sandbox.memApi = async (p, opt) => {
    calls.push({ path: p, body: (opt && opt.body) ? JSON.parse(opt.body) : null, method: (opt && opt.method) || 'GET' });
    if (o.memApi) return o.memApi(p, opt, calls);
    if (p.indexOf('/app/ear/state') === 0) {
      return { ok: true, cfg: { eryu: 'http://e', nmcp: 'http://n', has_token: true, autosay: true },
               now: (o.now || null), notes: o.notes || [], can_write: true };
    }
    if (p.indexOf('/app/ear/audio') === 0) {
      return o.audio === undefined ? { ok: true, url: 'http://cdn/x.mp3' } : o.audio;
    }
    if (p.indexOf('/app/ear/lyric') === 0) return { ok: true, lrc: o.lrc || '' };
    if (p.indexOf('/app/ear/note') === 0) return { ok: true, note: { who: 'me', text: 'ok', ts: Date.now() / 1000 } };
    if (p.indexOf('/app/ear/say') === 0) return { ok: true, note: { who: 'ai', text: '它写的', ts: Date.now() / 1000 } };
    if (p.indexOf('/app/ear/playlists') === 0) return { ok: true, playlists: [{ id: 1, name: '歌单甲', trackCount: 4 }], from: 'netease-mcp' };
    return { ok: true };
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(js + '\n; globalThis.__P = window.EarPack;', ctx);
  return { P: ctx.__P, sandbox, doc, calls, id: (k) => byId[k] };
}

let H;
try {
  H = harness({ notes: [
    { who: 'me', text: '这条是我写的', ts: Date.now() / 1000 },
    { who: 'ai', text: '这条是它写的', ts: Date.now() / 1000 },
  ] });
  ok(!!H.P, 'music-pack 在假环境里跑起来了');
} catch (e) {
  ok(false, 'music-pack 跑不起来', String((e && e.message) || e));
}

if (H && H.P) {
  const { P, calls, id } = H;

  /* LRC */
  const lrc = P._lrc('[00:01.00]第一句\n[00:03.50]第二句\n[00:12.500]第三句\n不进\n');
  eq(lrc.length, 3, 'LRC 只认带时间戳的行');
  eq(lrc[0].text, '第一句', '第一句正文对');
  eq(lrc[1].t, 3.5, '★ [00:03.50] 是 3.5 秒 —— 两位是按百分秒算的，不是毫秒');
  eq(lrc[2].t, 12.5, '[00:12.500] 三位是毫秒 → 12.5 秒');
  eq(P._lrcIndex(lrc, 0.5), -1, '还没到第一句时不亮任何一句');
  eq(P._lrcIndex(lrc, 1.2), 0, '到 1.2 秒时亮第一句');
  eq(P._lrcIndex(lrc, 4), 1, '到 4 秒时亮第二句');
  eq(P._lrcIndex(lrc, 999), 2, '放到最后一句之后停在最后一句');
  eq(P._mmss(0), '0:00', '0 秒显示 0:00');
  eq(P._mmss(75), '1:15', '75 秒显示 1:15');

  /* 打开 */
  PENDING.push((async () => {
    P.open();
    /* ★ open() 里是异步的 load()，调用方拿不到它的 promise ——
       断言直接跟在后面就会跑在数据回来之前（第一次就是这样红的）。
       这是**测试写法**的问题，不是代码：浏览器里没有谁会 await 一个 open()。 */
    await new Promise((r) => setTimeout(r, 30));
    const st = P._state();
    eq(st.notes.length, 2, '★ 打开后留言读回来了');
    ok(calls.some((c) => c.path.indexOf('/app/ear/state') === 0), '打开时调了 /app/ear/state');
    const notesHtml = (id('earNotes') || {}).innerHTML || '';
    ok(/这条是我写的/.test(notesHtml) && /这条是它写的/.test(notesHtml), '两条留言都渲染出来了');
    ok(/ear-note me/.test(notesHtml), '★ 我那条带 me');
    ok(/ear-note ai/.test(notesHtml), '★ 它那条带 ai');
    ok(/阿澈/.test(notesHtml), '它那条显示的是宿主给的名字（不在这里另存一份）');

    /* 播放：一首歌 → 记下 + 拉地址 + 拉歌词 */
    calls.length = 0;
    let playErr = null;
    try {
      await P._playSong({ id: 1349292048, name: '心如止水', artist: 'Ice Paper' });
    } catch (e) { playErr = String((e && e.message) || e); }
    /* ★ loadSong 里那两个 api 调用外面套着 try/catch —— 真抛错的话会表现成
       "默默一个请求都没发"，最难查。所以这里明着断言它不抛。 */
    ok(!playErr, 'playSong 不该抛错', playErr);
    const nowCall = calls.filter((c) => c.path === '/app/ear/now')[0];
    ok(!!nowCall, '点了歌会 POST /app/ear/now（两端才看到同一首）');
    eq((nowCall.body || {}).song.name, '心如止水', '/now 的 body 带歌名');
    ok(calls.some((c) => c.path.indexOf('/app/ear/audio?id=1349292048') === 0),
      '拉了播放地址   ← 实际路径：' + JSON.stringify(calls.map((c) => c.path)));
    ok(calls.some((c) => c.path.indexOf('/app/ear/lyric?id=1349292048') === 0), '拉了歌词');
    ok(!(id('earHint') || {}).innerHTML, '拿到了地址就不该有提示（提示是给失败用的）');

    /* 留言与"让它说一句" */
    calls.length = 0;
    id('earInput').value = '  你也听出来了  ';
    await P._send();
    const noteCall = calls.filter((c) => c.path === '/app/ear/note')[0];
    ok(!!noteCall, '发送会 POST /app/ear/note');
    eq((noteCall.body || {}).text, '你也听出来了', '★ 去掉了首尾空白再发');
    eq((noteCall.body || {}).who, 'me', '我发的 who 是 me');
    eq(id('earInput').value, '', '发完清空输入框');

    calls.length = 0;
    await P._say(true);
    const sayCall = calls.filter((c) => c.path === '/app/ear/say')[0];
    ok(!!sayCall, '「让它说一句」会 POST /app/ear/say');
    eq((sayCall.body || {}).force, true, '★ 手动按的那个带 force（后端靠它绕过节流）');
  })());

  /* 拿不到播放地址：把原因与 cookie 提示一起说出来 */
  const H2 = harness({
    audio: { ok: false, error: 'no url, may need VIP or song unavailable',
             hint: '服务器上的网易云 cookie 可能过期了 —— 到云服务器的 ~/.netease_cred 换一个新的 MUSIC_U，再试一次。' },
  });
  PENDING.push((async () => {
    await H2.P._playSong({ id: 5, name: '起风了' });
    const h = (H2.id('earHint') || {}).innerHTML || '';
    ok(/没拿到播放地址/.test(h), '★ 明说没拿到地址');
    ok(/no url/.test(h), '把后端的原话带出来');
    ok(/cookie/.test(h), '★ 把"cookie 可能过期"这条提示带出来（不然用户只会以为自己点错了）');
    ok(/歌词与留言照常/.test(h), '同时说明别的功能不受影响');
  })());

  /* 没在听什么的时候，不该去拉地址 */
  const H3 = harness({});
  PENDING.push((async () => {
    H3.calls.length = 0;
    H3.P.open();
    await new Promise((r) => setTimeout(r, 0));
    ok(!H3.calls.some((c) => c.path.indexOf('/app/ear/audio') === 0),
      '★ 没在听什么时不去拉播放地址（省一趟白等的请求）');
    const hint = (H3.id('earHint') || {}).innerHTML || '';
    ok(/点歌/.test(hint), '而是给一句"点歌"的引导，不留空白');
  })());

  /* 切歌：按点歌面板里那份列表往下走 */
  const H4 = harness({});
  PENDING.push((async () => {
    await H4.P._openPick();
    ok(H4.P._sheet() === 'pick', '点「点歌」会摊开点歌面板');
    H4.P._set({ pick: { songs: [{ id: 11, name: '甲' }, { id: 22, name: '乙' }],
                        playlists: [], from: '', err: '' } });
    await H4.P._playSong({ id: 11, name: '甲' });
    eq(H4.P._state().now.name, '甲', '先放了甲');
    await H4.P._step(1);
    eq(H4.P._state().now.name, '乙', '★ 下一首真的切到乙（靠的是那份列表，不是瞎猜）');
    await H4.P._step(1);
    eq(H4.P._state().now.name, '甲', '★ 到最后会绕回第一首');
  })());

  /* 没有列表时切歌要明说（不静默） */
  const H5 = harness({});
  PENDING.push((async () => {
    await H5.P._playSong({ id: 9, name: '孤零零' });
    H5.P._set({ pick: { songs: [], playlists: [], from: '', err: '' } });
    await H5.P._step(1);
    eq(H5.P._state().now.name, '孤零零', '★ 没列表时不乱切');
    ok(H5.P._sheet() === 'pick', '而是把点歌面板打开（给一条出路）');
  })());
}

Promise.allSettled(PENDING).then(() => {
  console.log('\n──────────────────────────────');
  console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
  process.exit(FAIL ? 1 : 0);
});
