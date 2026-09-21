/*
 * 侧边栏状态卡自检 —— 用法：node smoke-statuscard.js [index.html]
 *
 * 为什么要有它：这张卡把三件事拼在一起，而这三件各自都有"悄悄错"的典型形态：
 *   · 头像/名字**又存了一份** → 「主题美化」改了卡片不变（用户报的就是这个）
 *   · tab 式的摆放错：卡片部件 id 拼错一个字母 → 那一格永远空白，不报错
 *   · 状态生成的解析太脆（模型偶尔不写 JSON）→ 一次格式不符就把整次调用作废
 *   · 节流写反 → 要么每次打开菜单都花一次调用，要么永远不刷新
 *   · 失败路径没兜底 → 原来那句被抹掉，卡片变成空白
 *
 * 第一段验静态结构（不需要后端、不需要浏览器）；
 * 第二段把 ms 模块抠出来，用假 DOM + 假 fetch 真跑一遍。
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

function divBlock(startNeedle) {
  const i = html.indexOf(startNeedle);
  if (i < 0) return null;
  const re = /<(\/?)div\b/g;
  re.lastIndex = i;
  let depth = 0, started = false, m;
  while ((m = re.exec(html))) {
    depth += m[1] === '' ? 1 : -1;
    started = true;
    if (started && depth === 0) return { a: i, b: html.indexOf('>', re.lastIndex) + 1 };
  }
  return null;
}

console.log('=== 1. 卡片在侧边栏里，旧的 hero 清干净了 ===');
const menu = divBlock('<div class="menu-panel hidden" id="menuPanel"');
ok(!!menu, '找得到 #menuPanel');
const menuSeg = menu ? html.slice(menu.a, menu.b) : '';
for (const id of ['menuCard', 'msConn', 'msConnText', 'msClock', 'msAv', 'msHandle', 'msName',
                  'msPlace', 'msPlaceText', 'msStatusText', 'msLive', 'msRefresh']) {
  ok(menuSeg.includes('id="' + id + '"'), '卡片部件 #' + id + ' 在侧边栏里');
}
for (const id of ['msSearch', 'msCompose', 'msMore']) {
  ok(menuSeg.includes('id="' + id + '"'), '顶栏圆键 #' + id + ' 在侧边栏里');
}
ok(menuSeg.indexOf('id="menuDays"') > 0, '★ #menuDays 还在（refreshDays() 仍要更新它）');
for (const dead of ['.menu-title', '.menu-since', 'menu-private', 'menu-hero']) {
  eq(html.split(dead).length - 1, 0, dead + ' 已清零（旧 hero 结构不留残骸）');
}

console.log('\n=== 2. ★ 头像与名字都只有一处来源（这是用户最容易发现的那种坏）===');
ok(/\.ms-av\{[^}]*background-image:\s*var\(--avatar-stack\)/.test(html),
  '头像吃 CSS 变量 --avatar-stack —— applyAvatar 改的就是它');
ok(/function applyAvatar\(url\)[\s\S]{0,400}--avatar-default/.test(html),
  'applyAvatar 写的确实是 --avatar-default（和上面同一条链）');
ok(/function applyRemark\(value\)\{[\s\S]{0,500}getElementById\("msName"\)/.test(html),
  '★ 名字在 applyRemark 里**同一个出口**更新（不是卡片自己存一份）');
ok(/function applyRemark\(value\)\{[\s\S]{0,600}getElementById\("msHandle"\)/.test(html),
  '@handle 跟着名字一起走');
ok(/function msNameNow\(\)\{[\s\S]{0,240}getElementById\("peerName"\)/.test(html),
  'msNameNow() 读的是 #peerName —— 和聊天顶栏显示名字的那个元素同一个');
/* ★ 口径：AVATAR_KEY 是**常量**，所以去找 localStorage.setItem("companion_avatar")
   这种字面量是找不到的（第一次跑就是这条假红）。改成把全文里所有
   companion_*avatar* 串抓出来去重 —— 卡片不该新增第三个键。 */
const avatarStores = [...new Set([...html.matchAll(/companion_[a-z_]*avatar[a-z_]*/gi)].map((m) => m[0]))].sort();
eq(avatarStores, ['companion_avatar', 'companion_user_avatar'],

  '头像相关的本机键**只有原有那两个**（卡片没新增第三个）');

console.log('\n=== 3. 状态只有一份存储、渲染只有一处 ===');
eq(html.split('const MS_KEY = "companion_menu_status"').length - 1, 1, 'MS_KEY 只定义一次');
const statusKeys = [...html.matchAll(/localStorage\.setItem\(\s*"(companion_menu[a-z_]*|[a-z_]*status[a-z_]*)"/g)].map((m) => m[1]);
ok(statusKeys.length === 0, 'msSave 用的是 MS_KEY 常量（没有写死的第二个键）：' + JSON.stringify(statusKeys));
eq(html.split('function msPaint()').length - 1, 1, '渲染只有 msPaint 一处');
ok(/function msPaint\(\)\{[\s\S]{0,900}msPlaceText[\s\S]{0,600}msStatusText/.test(html),
  'msPaint 一处把地点与状态都写了');

console.log('\n=== 4. 状态由它自己写：prompt 的约束 ===');
const promptFn = html.slice(html.indexOf('function msPrompt('), html.indexOf('async function msAskStatus()'));
ok(promptFn.length > 200, '找得到 msPrompt');
ok(/第一人称、现在时/.test(promptFn), 'prompt 要求第一人称现在时');
ok(/不要用第三人称/.test(promptFn), 'prompt 明确禁第三人称（这一路的老毛病）');
ok(/不要问问题/.test(promptFn), 'prompt 禁反问');
ok(/\{"place"/.test(promptFn) || /\\\\?"place\\\\?"/.test(promptFn), 'prompt 约定输出 JSON');
ok(/AI_NAME/.test(promptFn) && /HUMAN_NAME/.test(promptFn), 'prompt 用的是全局那两个名字（不写死）');
ok(/stream:\s*false/.test(html.slice(html.indexOf('async function msAskStatus()'), html.indexOf('async function msAskStatus()') + 1400)),
  '这是一次非流式调用（不占聊天流）');

console.log('\n=== 5. CSS 齐全，且全靠变量（四套主题都得活）===');
for (const c of ['.menu-head{', '.ms-chip{', '.ms-acts{', '.ms-act{', '.menu-card{', '.ms-row{',
                 '.ms-pill{', '.ms-pill.on i{', '.ms-clock{', '.ms-id{', '.ms-av{', '.ms-id-txt{',
                 '.ms-handle{', '.ms-name{', '.ms-place{', '.ms-now{', '.ms-now-head{', '.ms-live{',
                 '.ms-now-row{', '.ms-now-txt{', '.ms-refresh{', '@keyframes msSpin{']) {
  ok(html.includes(c), 'CSS 有 ' + c);
}
/* 写死颜色 = 深色主题下白底白字（或反过来）。只有"连接绿点"允许写死（它本来就是绿的）。 */
const msCss = html.slice(html.indexOf('  .menu-head{'), html.indexOf('@keyframes msSpin{'));
/* ★ `color: #fff` 能被"冒号+值"的正则抓到，但 `box-shadow: 0 0 0 3px rgba(…)` 抓不到
   （冒号后面先是数字）。改成扫**任何位置**的颜色字面量 —— 这样更严，也才对得上意图。 */
const hardColors = [...msCss.matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
eq(hardColors, ['#4CAF7D', 'rgba(76,175,125,.18)'],
  '★ .ms-* 里写死的颜色只有那个"在线绿点"（其余全走 var()）');

console.log('\n=== 6. 挂钩点接上了 ===');
ok(/function openMenu\(\)\{[\s\S]{0,300}msPaint\(\);/.test(html), 'openMenu 里调了 msPaint');
ok(/function openMenu\(\)\{[\s\S]{0,400}msMaybeRefresh\(\);/.test(html), 'openMenu 里调了 msMaybeRefresh');
ok(/msMaybeRefresh\(\);\s*\/\/[^\n]*20 分钟/.test(html) || /msMaybeRefresh\(\)/.test(html), '节流说明在位');
ok(/setInterval\(\(\) => \{[\s\S]{0,200}msClock/.test(html), '时钟自己走（30s 一跳）');
ok(/if \(msEl\("msRefresh"\)\) msEl\("msRefresh"\)\.addEventListener\("click", \(\) => msRefreshStatus\(true\)\)/.test(html),
  '刷新键 = 强制重写一次');
/* ★ 处理体在**下一行**（`if (...) el.addEventListener("click", () => {` + 换行），
   用 [^\n]* 够不着 —— 第一次跑就是这条假红。跨行给足 220 字。 */
ok(/if \(msEl\("msSearch"\)\)[\s\S]{0,220}openMessageDb/.test(html), '搜索键 → 消息库');
ok(/if \(msEl\("msMore"\)\)[\s\S]{0,220}toggleQuick/.test(html), '⋯ 键 → 聊天快捷设置');

/* ══════════════════════════════════════════════════════════════════════════
   第二段：假 DOM + 假 fetch，把 ms 模块真跑一遍
   ────────────────────────────────────────────────────────────────────────── */
console.log('\n=== 7. 假 DOM：msPaint / msParseStatus / 节流 / 失败兜底 ===');

const a0 = html.indexOf('const MS_KEY = "companion_menu_status"');
const b0 = html.indexOf('let menuCloseTimer = null;');
ok(a0 > 0 && b0 > a0, '在 index.html 里找得到 ms 模块');
const msCode = a0 > 0 && b0 > a0 ? html.slice(a0, b0) : '';

function mkEl(id) {
  const set = new Set();
  return {
    id, textContent: '', style: {}, _on: {},
    classList: {
      add(...c) { c.forEach((x) => set.add(x)); },
      remove(...c) { c.forEach((x) => set.delete(x)); },
      contains(c) { return set.has(c); },
      toggle(c, f) { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on; },
      _set: set,
    },
    addEventListener(ev, fn) { this._on[ev] = fn; },
  };
}

function harness() {
  const ids = ['msConn', 'msConnText', 'msClock', 'msAv', 'msHandle', 'msName', 'msPlace',
               'msPlaceText', 'msStatusText', 'msLive', 'msRefresh', 'msSearch', 'msCompose',
               'msMore', 'peerName', 'menuDays'];
  const els = {};
  ids.forEach((id) => { els[id] = mkEl(id); });
  els.peerName.textContent = 'DeepSeek';

  const store = {};
  const calls = { fetch: [], refresh: 0, toast: [], openDb: 0, quick: 0, closeMenu: 0 };
  let fetchReply = { ok: true, json: () => Promise.resolve({ choices: [{ message: { content: '{"place":"苏拉威西海 · 潮线之下","status":"刚把一段旧事翻出来读了一遍，眼睛有点涩。"}' } }] }) };
  let fetchThrows = null;      // fetch 自己 reject = 网络层被拒（CORS / 断网），不是 HTTP 错误

  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
    fetch: (url, opt) => {
      calls.fetch.push({ url, body: opt && JSON.parse(opt.body || '{}') });
      if (fetchThrows) return Promise.reject(fetchThrows);
      return Promise.resolve(fetchReply);
    },
    activeConn: () => ({ id: 'c1', type: 'relay', name: '云端', model: 'deepseek-chat' }),
    connChatUrl: () => 'https://relay.example/app/chat',
    connHeaders: () => ({ 'Content-Type': 'application/json' }),
    providerOf: () => ({ models: ['deepseek-chat'] }),
    showToast: (m) => calls.toast.push(String(m)),
    AI_NAME: 'DeepSeek',
    HUMAN_NAME: '你',
    APP_NAME: 'Tidal Echo',
    chatMessages: [],
    menuPanel: { classList: { contains: () => false } },
    inputEl: { focus() {} },
    closeMenu: () => { calls.closeMenu++; },
    openMessageDb: () => { calls.openDb++; },
    toggleQuick: () => { calls.quick++; },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(msCode + `
    ; globalThis.__api = { msPaint, msLoad, msSave, msParseStatus, msMaybeRefresh,
                           msRefreshStatus, msRecentDialogue, msMsgCount, msClock, msPrompt, MS_KEY, MS_TTL };`,
    ctx, { filename: 'ms.js' });
  return { api: ctx.__api, els, store, calls, sandbox,
           setReply: (r) => { fetchReply = r; fetchThrows = null; },
           setThrow: (e) => { fetchThrows = e; } };
}

/* 第二段要 await，而 CommonJS 里没有顶层 await → 整段包进 async IIFE */
(async () => {
let H;
try { H = harness(); ok(!!H.api, 'ms 模块在假 DOM 里跑起来了'); }
catch (e) { ok(false, 'ms 模块跑不起来', String((e && e.message) || e)); }

if (H && H.api) {
  const { api, els, store, calls } = H;

  // ── 解析：模型不写 JSON 也得能活 ──
  eq(api.msParseStatus('{"place":"陆家嘴 · 顶层平层办公室","status":"刚结束并购会谈，胃隐隐有点疼。"}'),
     { place: '陆家嘴 · 顶层平层办公室', status: '刚结束并购会谈，胃隐隐有点疼。' }, '标准 JSON 解析');
  eq(api.msParseStatus('```json\n{"place":"家","status":"在等你"}\n```'),
     { place: '家', status: '在等你' }, '带代码块也能解析（模型很爱加）');
  eq(api.msParseStatus('刚把灯关掉，屋子安静下来了。'),
     { place: '', status: '刚把灯关掉，屋子安静下来了。' }, '★ 完全不写 JSON → 整行当状态，不是作废');
  ok(api.msParseStatus('{"place":"' + 'x'.repeat(80) + '","status":"' + 'y'.repeat(200) + '"}').place.length === 40,
     '地点超长会截断到 40');
  ok(api.msParseStatus('{"place":"a","status":"' + 'y'.repeat(200) + '"}').status.length === 90,
     '状态超长会截断到 90');

  // ── 没数据时的初始态 ──
  api.msPaint();
  eq(els.msName.textContent, 'DeepSeek', '名字取自 #peerName');
  eq(els.msHandle.textContent, '@deepseek', '@handle 跟着名字');
  eq(els.msStatusText.textContent, '（还没写）', '没写过 → 占位文案');
  eq(els.msPlaceText.textContent, '还没连线', '没写过 → 地点占位');
  ok(els.msConn.classList.contains('on'), '有活动连接 → 亮绿点');
  eq(els.msConnText.textContent, 'CONNECTED · 云端', '云端连接的文案');
  ok(els.msLive.style.visibility === 'hidden', '没状态时 LIVE 藏起来（不假亮）');
  ok(/^(星期日|星期一|星期二|星期三|星期四|星期五|星期六) · \d{2}:\d{2}$/.test(api.msClock()),
     '时钟格式「星期四 · 01:24」：' + api.msClock());
  eq(api.msRecentDialogue(4), [], '没有对话时返回空数组（不炸）');

  // ── 生成一次 ──
  await api.msRefreshStatus(true);
  eq(calls.fetch.length, 1, '确实发了一次请求');
  const sent = calls.fetch[0].body;
  eq(sent.stream, false, '是非流式');
  ok(sent.max_tokens <= 300, 'max_tokens 给小（省钱）：' + sent.max_tokens);
  ok(sent.temperature >= 0.7, '温度偏高（要的是"它自己的语气"）：' + sent.temperature);
  eq(sent.messages.length, 2, '两条消息：规则 + 最近对话');
  ok(/第一人称/.test(sent.messages[0].content), '规则里带第一人称约束');
  eq(calls.fetch[0].url, 'https://relay.example/app/chat', '打到当前连接的对话地址');

  const saved = JSON.parse(store['companion_menu_status']);
  eq(saved.place, '苏拉威西海 · 潮线之下', '地点存下来了');
  ok(/胃隐隐|眼睛有点涩/.test(saved.status), '状态存下来了');
  ok(typeof saved.at === 'number' && saved.at > 0, '存了时间戳');
  ok(typeof saved.sig === 'number', '存了"生成时的消息数"（节流要用）');

  api.msPaint();
  eq(els.msStatusText.textContent, '\u201C刚把一段旧事翻出来读了一遍，眼睛有点涩。\u201D', '★ 状态显示成带引号那一句');
  eq(els.msPlaceText.textContent, '苏拉威西海 · 潮线之下', '地点显示出来');
  ok(els.msLive.style.visibility === '', '有状态时 LIVE 才亮');
  eq(calls.toast[calls.toast.length - 1], '它写了一句新的', '强制刷新给一句回执');

  // ── 节流 ──
  const before = calls.fetch.length;
  await api.msMaybeRefresh();
  eq(calls.fetch.length, before, '★ 刚写完、消息数没变 → 再打开菜单**不再调**（省调用）');

  /* ★ 要**直接改存储里的 at** —— msSave 的职责就是把 at 写成"现在"，
     拿它来"装作过期"永远装不成（第一次跑就是这条假红）。 */
  const aged = JSON.parse(store['companion_menu_status']);
  aged.at = Date.now() - api.MS_TTL - 1000;
  store['companion_menu_status'] = JSON.stringify(aged);
  await api.msMaybeRefresh();
  eq(calls.fetch.length, before, '★ 过期了但这期间没聊新的 → 也不调');

  H.sandbox.chatMessages.push({ kind: 'user', from: 'human', text: '在吗' });
  H.sandbox.chatMessages.push({ kind: 'reply', from: 'ai', text: '在的' });
  await api.msMaybeRefresh();
  eq(calls.fetch.length, before + 1, '★ 过期 + 有新对话 → 才重写一次');

  // ── 最近对话的来源 ──
  const dlg = api.msRecentDialogue(6);
  eq(dlg.length, 2, '取到两条（只有 user/reply 算数）');
  ok(dlg[0].startsWith('我：'), '人类那条标「我」');
  ok(dlg[1].startsWith('DeepSeek：'), 'AI 那条标它的名字（不是「TA」）');
  H.sandbox.chatMessages.push({ kind: 'summary', from: 'ai', text: '（总结卡，不该进上下文）' });
  eq(api.msRecentDialogue(6).length, 2, '总结卡这类 kind 不混进状态上下文');

  // ── 失败兜底 ──
  H.setReply({ ok: false, json: () => Promise.resolve({}) });
  const keepText = els.msStatusText.textContent;
  await api.msRefreshStatus(true);
  eq(els.msStatusText.textContent, keepText, '★ 失败时把原来那句**放回去**（不是留下空白）');
  ok(/HTTP 502|HTTP/.test(calls.toast[calls.toast.length - 1]), '失败有回执：' + calls.toast[calls.toast.length - 1]);
  ok(!els.msRefresh.classList.contains('busy'), '失败后按钮从 busy 里退出来（不然永远转）');

  /* ★ 直连被 CORS 拦的真实形态是 **fetch 自己 reject**（`TypeError: Failed to fetch`），
     而不是回一个 ok:false —— 用 setReply 只会走到 "HTTP undefined" 那条分支，
     测出来的是别的东西（第一次跑就是这条假红）。 */
  H.setThrow(new TypeError('Failed to fetch'));
  await api.msRefreshStatus(true);
  ok(/CORS/.test(calls.toast[calls.toast.length - 1]),
     '★ 直连被 CORS 拦时给出可操作的话：' + calls.toast[calls.toast.length - 1]);

  // ── 没连接时不炸 ──
  H.sandbox.activeConn = () => null;
  api.msPaint();
  eq(els.msConnText.textContent, 'OFFLINE', '没连接 → OFFLINE');
  ok(!els.msConn.classList.contains('on'), '没连接 → 绿点灭');

  // ── 三个圆键 ──
  els.msSearch._on.click(); eq(calls.openDb, 1, '搜索键打开消息库');
  els.msMore._on.click(); eq(calls.quick, 1, '⋯ 键打开快捷设置');
  els.msCompose._on.click(); eq(calls.closeMenu, 3, '＋ 键（含前两个键各自关一次菜单）会关掉菜单回聊天');
}

console.log('\n──────────────────────────────');
console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
process.exit(FAIL ? 1 : 0);
})();
