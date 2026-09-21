/*
 * rp-channel-pack.js 冒烟测试 —— 这个包平时"没有浏览器可测"，只能 node --check。
 * 但它的**状态层**（load / 迁移 / 位解析 / 说话人切分）是可以跑起来验的，
 * 那正是这次改动最危险的地方（存档迁移、模型位解析）。
 *
 * 做法：造一个够用的假 DOM，让 init() 跑完不炸；把 classList.contains("hidden")
 * 恒为 true，于是 render() 第一行就返回 —— 我们不测渲染，只测逻辑。
 */
const fs = require('fs');
const vm = require('vm');

/* 用法：node smoke-rp-channel.js [rp-channel-pack.js]
   不带参数就用同目录的 rp-channel-pack.js。

   为什么要有这个文件：这个包在浏览器里跑，而**这个仓库里没有浏览器可测** ——
   以前只能靠 node --check（那只验语法，验不出"存档迁移把配置弄丢""阿澈打错模型"
   这类问题）。而包本身早就留了 _split / _cast / _save 这些"给冒烟测试用的口子"，
   测试却一直缺着。这里用假 DOM 把它补上：init() 能跑完，render() 按设计提前返回，
   于是状态层（load / 迁移 / 位解析 / 说话人切分 / 真实 fetch 地址）全都能验。 */
const PACK = process.argv[2] || require('path').join(__dirname, 'rp-channel-pack.js');
if (!fs.existsSync(PACK)) { console.error('找不到 ' + PACK); process.exit(2); }
const CODE = fs.readFileSync(PACK, 'utf8');

let PASS = 0, FAIL = 0;
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }

/* ── 假环境 ───────────────────────────────────────────────────────────── */
function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', value: '',
    style: {}, dataset: {}, attrs: {}, children: [],
    scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    offsetWidth: 100, offsetHeight: 100,
    innerHTML: '',
    classList: {
      /* ★ 恒为 true —— 让 render() 在第一行就返回 */
      contains: () => true,
      add() {}, remove() {}, toggle() {}
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k); },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
    insertBefore(c) { el.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    querySelector() { return mkEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    focus() {}, blur() {}, click() {}, remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 }; }
  };
  return el;
}

function boot(seed) {
  const byId = new Map();
  const doc = {
    readyState: 'loading',                       // → idleInit 只挂事件，不真的建 DOM
    createElement: (t) => mkEl(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById(id) {
      if (!byId.has(id)) { const e = mkEl('div'); e.id = id; byId.set(id, e); }
      return byId.get(id);
    },
    querySelector: () => mkEl('div'),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: mkEl('body'), documentElement: mkEl('html'), head: mkEl('head')
  };

  const store = new Map(Object.entries(seed || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear()
  };

  const win = {
    innerWidth: 420, innerHeight: 900,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: () => 0,
    /* ★ 不给 requestIdleCallback —— idleInit 会走 setTimeout，
       而下面的 setTimeout 是"记下来但不执行"，于是 init() 完全不会被自动调用。
       我们要自己控制什么时候 init。 */
    setTimeout: () => 0,
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage, navigator: { userAgent: 'smoke' },
    document: doc, AbortController, TextDecoder, TextEncoder,
    fetch: () => Promise.reject(new Error('smoke: 不该发请求'))
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;

  const sandbox = Object.assign({}, win, { console });
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'rp-channel-pack.js' });
  return { win, sandbox, doc, localStorage, byId, store };
}

/* ═══════════════════════════════════════════════════════════════════════ */
console.log('=== 1. 默认状态（全新用户） ===');
{
  const { sandbox, byId } = boot({});
  const R = sandbox.window.RpChannel;
  ok(!!R, 'RpChannel 已导出');
  R.init();
  ok(true, 'init() 没抛异常');

  eq(Object.keys(R.state.models), ['dealer'], '模型位只有一个 dealer');
  eq(R.state.mode, 'mono', '模式锁死 mono（不再是 rp）');
  eq(R.menuName(), '大富翁', '侧边栏名字是「大富翁」');
  eq(byId.get('rpMenuName').textContent, '大富翁', '菜单 DOM 也被同步成「大富翁」');
  eq(R.state.models.dealer.model, 'deepseek-chat', '荷官默认模型');
  ok(R.state.cfg.menuName === '大富翁', 'cfg.menuName 默认值');

  const segs = R._split('【荷官】轮到你了\n【阿澈】我去买那块地');
  eq(segs.map((s) => s.role), ['dealer'], '名字还没落进 setup 时，认不出的名字算荷官（设计如此）');
  /* ★ 名字是 aiName()/humanName() 落进 setup 的 —— 它们只在荷官开口前被调。
     所以这里手动摆好（等价于"荷官已经说过第一轮"），再验三方切分。 */
  R.state.mono.setup.p1_name = '阿澈';
  R.state.mono.setup.p2_name = '主人';
  const segs2 = R._split('【荷官】轮到你了\n【阿澈】我去买那块地');
  eq(segs2.map((s) => s.role), ['dealer', '阿澈'], '【荷官】/【阿澈】切分成两个说话人');
  eq(segs2[1].text, '我去买那块地', '阿澈那一行是它自己的');
}

console.log('\n=== 2. 老存档迁移（rp 时代的 char 位） ===');
{
  const { sandbox } = boot({
    companion_rp_cfg_models: JSON.stringify({
      char: { provider: 'cloud:zhipu', model: 'glm-4-plus', temp: 0.33, connId: 'conn-x' },
      narr: { provider: 'cloud:moonshot', model: 'moonshot-v1-8k', temp: 0.7, connId: '' },
      npc: { provider: 'cloud:zhipu', model: 'glm-4-flash', temp: 0.85, connId: '' }
    })
  });
  const R = sandbox.window.RpChannel;
  R.init();
  eq(Object.keys(R.state.models), ['dealer'], '老存档不会把 char/narr/npc 一起带回来');
  eq(R.state.models.dealer.model, 'glm-4-plus', 'char 的模型迁到了 dealer');
  eq(R.state.models.dealer.connId, 'conn-x', 'char 的连接也一起迁过来');
  eq(R.state.models.dealer.temp, 0.33, 'char 的温度也迁过来（不静默改用户配置）');
}

console.log('\n=== 3. 已有 dealer 存档时不被覆盖 ===');
{
  const { sandbox } = boot({
    companion_rp_cfg_models: JSON.stringify({
      char: { provider: 'cloud:zhipu', model: 'glm-4-plus', temp: 0.33, connId: '' },
      dealer: { provider: 'cloud:deepseek', model: 'deepseek-reasoner', temp: 0.2, connId: '' }
    })
  });
  const R = sandbox.window.RpChannel;
  R.init();
  eq(R.state.models.dealer.model, 'deepseek-reasoner', 'dealer 存档优先，不被 char 顶掉');
}

console.log('\n=== 4. 菜单名迁移：只迁旧默认值 ===');
{
  const a = boot({ companion_rp_cfg: JSON.stringify({ menuName: '万花筒' }) });
  a.sandbox.window.RpChannel.init();
  eq(a.sandbox.window.RpChannel.menuName(), '大富翁', '「万花筒」→「大富翁」');

  const b = boot({ companion_rp_cfg: JSON.stringify({ menuName: '秘密花园' }) });
  b.sandbox.window.RpChannel.init();
  eq(b.sandbox.window.RpChannel.menuName(), '秘密花园', '自己改过的名字保持不动');
}

console.log('\n=== 5. 模式迁移：老存档里的 rp 不能进来 ===');
{
  const { sandbox } = boot({ companion_rp_cfg_mode: JSON.stringify('rp') });
  const R = sandbox.window.RpChannel;
  R.init();
  eq(R.state.mode, 'mono', '存着 "rp" 也锁到 mono');
  /* render() 在这个假环境里会提前返回（面板恒为 hidden），所以 view 不在这里断言；
     真实浏览器里 render()/open() 都会把它顶成 "mono"。 */
  ok(['slot', 'scene', 'mono', 'cfg'].indexOf(R.state.view) >= 0, 'view 是合法值：' + R.state.view);
}

console.log('\n=== 6. 阿澈那一席 / 说话人表 ===');
{
  const { sandbox } = boot({});
  const R = sandbox.window.RpChannel;
  R.init();
  R.state.mono.setup.p1_name = '阿澈';
  R.state.mono.setup.p2_name = '西西';
  R.state.mono.ai = { p1: false, p2: true, persona: '', auto: 5, autoJoin: true };
  const cast = R._cast();
  eq(Object.keys(cast).sort(), ['西西', '阿澈'], '牌桌上两个人都在说话人表里');
  ok(cast['西西'].ai === true && cast['阿澈'].ai === false, '西西是 AI 那一席');
  const segs = R._split('【荷官】开局\n【西西】我先掷骰子\n【阿澈】随便你');
  eq(segs.map((s) => s.role), ['dealer', '西西', '阿澈'], '荷官 + 阿澈 + 用户 三方都能分开');
}

console.log('\n=== 7. 存档写回（save 白名单不能漏） ===');
{
  const { sandbox, store } = boot({});
  const R = sandbox.window.RpChannel;
  R.init();
  R.state.mono.setup.p1_name = '阿澈';
  R.state.mono.boardFolded = true;
  R._save();
  const raw = store.get('companion_rp_mono');
  ok(!!raw, 'mono 存档写出来了');
  const d = JSON.parse(raw);
  eq(d.setup.p1_name, '阿澈', 'setup 进存档');
  eq(d.boardFolded, true, 'boardFolded 进存档');
  ok(typeof d.ai === 'object' && d.ai !== null, 'ai（谁在玩）进存档');
  const cfgRaw = JSON.parse(store.get('companion_rp_cfg'));
  eq(cfgRaw.menuName, '大富翁', 'cfg 里的菜单名是「大富翁」');
  eq(JSON.parse(store.get('companion_rp_cfg_mode')), 'mono', '模式存的是 mono');
}

console.log('\n=== 8. 位解析：slotOf 的兜底（没配连接也不该整局哑掉） ===');
{
  /* 直接把内部函数拿出来太麻烦，改用可观测的行为：
     没有 activeConn（脱离宿主的预览页）时，荷官位仍然要能解析出来。 */
  const { sandbox } = boot({});
  const R = sandbox.window.RpChannel;
  R.init();
  ok(typeof sandbox.activeConn !== 'function', '宿主没提供 activeConn（模拟预览页）');
  /* 荷官位在默认配置下必须能解析（否则一点开局就报"还没配模型"） */
  ok(R.state.models.dealer.provider === 'cloud:deepseek', '荷官位有默认来源');
  ok(R.state.models.dealer.connId === '', 'connId 为空时走 provider 那条路');
}

/* ── 端到端：一轮里荷官和阿澈分别打到哪个地址 ──────────────────────────
   这是本次改动的**核心可观测行为**：
     荷官 → 荷官位（云端转发）
     阿澈 → 聊天当前连接（宿主 activeConn）
   用一个假 fetch 把两次请求原样记下来，直接看地址、模型、温度、有没有带 tools。 */

const DEALER_REPLY = [
  '【局面】西西掷出 4 点，停在旧书店。',
  '【给阿澈的任务】西西得在旧书店里挑一本书，你说说你怎么看。',
  '【给主人的任务】无'
].join('\n');

const ACHE_REPLY = '【阿澈】挑了一本旧诗集，我念给你听。';

function fakeChat(content) {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({ choices: [{ message: { role: 'assistant', content } }] }),
    text: () => Promise.resolve(content)
  };
}

function setupTurn(extraGlobals, opts) {
  opts = opts || {};
  const calls = [];
  const env = boot({});
  const S = env.sandbox;

  let n = 0;
  S.fetch = (url, init) => {
    const body = JSON.parse(init.body || '{}');
    calls.push({ url, body });
    const c = (n++ === 0) ? DEALER_REPLY : ACHE_REPLY;
    return Promise.resolve(fakeChat(c));
  };
  S.cloudHost = () => 'https://relay.example';
  S.cloudToken = () => 'tok';
  if (extraGlobals) Object.keys(extraGlobals).forEach((k) => { S[k] = extraGlobals[k]; });

  const R = S.window.RpChannel;
  R.init();
  R.state.mono.setup.p1_name = '阿澈';
  R.state.mono.setup.p2_name = '西西';
  R.state.mono.ai = { p1: false, p2: true, persona: '', auto: 5, autoJoin: true };
  R.state.mono.game = { game_id: 'g-smoke' };
  return { S, R, calls };
}

console.log('\n=== 9. 端到端：没有聊天连接时，阿澈退回荷官位（不能整局哑掉） ===');
{
  const { R, calls } = setupTurn(null);
  R._continue('测试').then((out) => {
    eq(calls.length, 2, '这一轮打了两枪：荷官 + 阿澈');
    ok(calls[0].url.indexOf('/relay/deepseek/') >= 0, '荷官走云端转发：' + calls[0].url);
    ok(calls[1].url.indexOf('/relay/deepseek/') >= 0, '阿澈退回荷官位（同一地址）');
    ok(Array.isArray(calls[0].body.tools) && calls[0].body.tools.length > 0, '荷官带着工具');
    ok(calls[1].body.tools === undefined, '阿澈不带工具（动手是荷官的事）');
    const msgs = R.state.mono.msgs || [];
    const host = msgs.filter((m) => m.who === 'host');
    ok(host.length === 1, '只有一条 host 消息（荷官 + 阿澈合并成一条）');
    const segs = R._split(host[0].text);
    eq(segs.map((s) => s.role), ['dealer', '阿澈'], '一条消息里切出荷官和阿澈两个说话人');
    /* 用户直接跟阿澈说话时，荷官不许写「无」—— 否则阿澈永远不会被叫到 */
    const dsys = (calls[0].body.messages[0] || {}).content || '';
    ok(dsys.indexOf('不要写「无」') >= 0, '荷官被明确告知：主人跟阿澈说话时不要写「无」');
    next();
  }).catch((e) => { FAIL++; console.log('  ✗ 抛异常：' + (e && e.stack || e)); next(); });
}

function next() {
  console.log('\n=== 10. 端到端：有聊天连接时，阿澈真的走那条连接 ===');
  const CHAT_URL = 'https://my-chat.example/v1/chat/completions';
  const conn = { id: 'chat-1', name: '我的聊天', model: 'gpt-4o-mini', temp: 0.42, chatUrl: CHAT_URL, provider: '' };
  const { S, R, calls } = setupTurn({
    activeConn: () => conn,
    loadConnections: () => [conn],
    connChatUrl: (c) => c.chatUrl,
    connHeaders: () => ({ 'Content-Type': 'application/json', 'X-Host': '1' })
  });
  /* 人格也复用它 —— 牌桌上的阿澈必须是聊天里那个 */
  S.window.MediaStore = { persona: () => '你叫阿澈，是西西的伴侣，不是助手。' };

  R._continue('测试').then(() => {
    eq(calls.length, 2, '还是两枪');
    ok(calls[0].url.indexOf('/relay/deepseek/') >= 0, '荷官仍走荷官位：' + calls[0].url);
    eq(calls[1].url, CHAT_URL, '★ 阿澈打到聊天当前连接');
    eq(calls[1].body.model, 'gpt-4o-mini', '用的是聊天连接里的模型');
    eq(calls[1].body.temperature, 0.42, '用的是聊天连接里的温度');
    ok(calls[1].body.tools === undefined, '阿澈不带工具');
    const sys = (calls[1].body.messages[0] || {}).content || '';
    ok(sys.indexOf('你叫阿澈') >= 0, '阿澈的 system 里是聊天人格（逐字复用）');
    ok(sys.indexOf('给阿澈的任务') >= 0, '阿澈的 system 里带着荷官派的任务');
    ok(sys.indexOf('打一局大富翁') >= 0, '阿澈知道自己在牌桌上');
    const host = (R.state.mono.msgs || []).filter((m) => m.who === 'host');
    const segs = R._split(host[0].text);
    eq(segs.map((s) => s.role), ['dealer', '阿澈'], '界面上一眼能分开谁在说话');

    console.log('\n────────────────────────────────────────');
    console.log(PASS + ' 通过 / ' + FAIL + ' 失败');
    process.exit(FAIL ? 1 : 0);
  }).catch((e) => {
    FAIL++; console.log('  ✗ 抛异常：' + (e && e.stack || e));
    process.exit(1);
  });
}
