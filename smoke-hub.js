/*
 * 「设置与能力」hub 自检 —— 用法：node smoke-hub.js [index.html]
 *
 * 为什么要有它：这一路把三个**整页层**（工具能力 / 网关 / 设置）合成了一个壳，
 * 动的全是摆放和归属，而这类错 node --check 一个都抓不到：
 *   · tab 的 data-hub 与视图的 data-hub-view 拼错一个字母 → 点上去**静默没反应**
 *   · 侧边栏写了三个入口但只留了一个壳 → 另两个点了没东西
 *   · 搬 DOM 时把某张设置卡落在壳外 → 那张卡再也打不开（"能总览到、调不了"）
 *   · memoryPanel 与设置页共用 .settings-panel/.settings-page 两个类 → 删 CSS 会连带把它打坏
 *   · 删了按钮却留着监听 → 有守卫时不报错，但那是死代码，下次改会被误导
 *   · 当前 tab 有两处各自记账 → 切一次界面走一次、Esc 关的是另一个（"关不掉"）
 *
 * 第一段验静态结构（不需要后端、不需要浏览器）；
 * 第二段把 hub 那段代码抠出来，用假 DOM 真跑一遍 hubSwitch / hubOpen / hubBack。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, 'index.html');
const SW = path.join(path.dirname(HTML), 'sw.js');
const html = fs.readFileSync(HTML, 'utf8');
const sw = fs.readFileSync(SW, 'utf8');

let PASS = 0, FAIL = 0;
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }

/* ── 按 div 配平取一个块 ─────────────────────────────────────────────── */
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

console.log('=== 1. 一个壳：侧边栏三个入口收成一个 ===');
const menuKeys = [...html.matchAll(/class="menu-item"[^>]*data-menu="([^"]+)"/g)].map((m) => m[1]);
ok(menuKeys.includes('settings'), '菜单里还有 settings 这一项');
ok(!menuKeys.includes('toolkit'), '「Tools」不再是独立入口（并进 hub 了）');
ok(!menuKeys.includes('gateway'), '「Gateway」不再是独立入口（并进 hub 了）');
ok(/<span class="menu-name">设置与能力<\/span>/.test(html), '菜单项名字改成「设置与能力」');
ok(/<span class="menu-sub">工具 · 网关 · 连接与模型。<\/span>/.test(html), '菜单副标题点出三块内容');

console.log('\n=== 2. hub 壳：一条顶栏 + 一行 tab + 三个视图 ===');
const hub = divBlock('<div class="hub-panel hidden" id="hubPanel"');
ok(!!hub, '找得到 .hub-panel#hubPanel');
const hubSeg = hub ? html.slice(hub.a, hub.b) : '';
ok(/class="hub-panel hidden" id="hubPanel"/.test(hubSeg), '初始是 hidden（不是一进页面就盖着）');
ok(/role="dialog"/.test(hubSeg) && /aria-modal="true"/.test(hubSeg), '还是 dialog 语义（无障碍）');

const viewKeys = [...hubSeg.matchAll(/class="hub-view[^"]*"\s+id="[^"]+"\s+data-hub-view="([^"]+)"/g)].map((m) => m[1]);
eq(viewKeys, ['tools', 'gateway', 'settings'], '正好三个视图，顺序 tools → gateway → settings');

const tabKeys = [...hubSeg.matchAll(/class="hub-tab[^"]*"[^>]*data-hub="([^"]+)"/g)].map((m) => m[1]);
eq(tabKeys, ['tools', 'gateway', 'settings'], '正好三个 tab，顺序与视图一致');
eq(tabKeys, viewKeys, 'tab 的 data-hub 与视图的 data-hub-view **一一对应**（错一个字母就是点了没反应）');

ok(/id="kitBack"/.test(hubSeg) && /id="hubClose"/.test(hubSeg), '顶栏有返回键与关闭键');
ok(/id="hubTabs"/.test(hubSeg), '有 tab 行容器 #hubTabs');
ok(/id="kitTitle"/.test(hubSeg) && /id="kitSub"/.test(hubSeg),
  '顶栏标题沿用 #kitTitle / #kitSub（kitBack / kitTool 自己就会写它，不用另造一套）');

console.log('\n=== 3. 三块内容都真的在壳里（不能落在壳外）===');
for (const [id, who] of [['kitGrid', '工具网格'], ['kitDetail', '工具详情'], ['capBody', '网关正文'],
                         ['capSub', '网关状态行'], ['capRefresh', '网关刷新键']]) {
  ok(hubSeg.includes('id="' + id + '"'), who + ' #' + id + ' 在 hub 内');
}
ok(/class="settings-scroll"/.test(hubSeg), '设置页的 .settings-scroll 在 hub 内');
/* ★ 口径：只数**真的是一张卡**的那种（<section class="set-card..."> 上的 data-card）。
   两处要小心：
     · `document.querySelector('.set-card[data-card="caps"]')` 这类 JS 选择器字符串
       会被裸的 data-card="..." 数进去 → "壳外凭空多一张"永远成立；
     · 有一张卡的写法是 class 后面还夹着 id（<section class="set-card" id="connEditorCard" data-card="editor">）
       → 卡在 class 与 data-card 之间写死，那张就会被漏掉。
   第一次跑这两条各假红过一次。 */
const CARDS = /<section class="set-card[^"]*"[^>]*data-card="([\w-]+)"/g;
const cardsAll = [...html.matchAll(CARDS)].map((m) => m[1]);
const cardsHub = [...hubSeg.matchAll(CARDS)].map((m) => m[1]);
ok(cardsAll.length === 16, '设置卡一共 16 张（含记忆面板那张）：' + cardsAll.length);
ok(cardsHub.length === 15, '其中 15 张住在 hub 里：' + cardsHub.length);
eq([...new Set(cardsAll)].filter((k) => !cardsHub.includes(k)), ['nearfield'],
  '壳外那张是 nearfield —— 它属于记忆面板的「短期记忆」页，本来就不该在这里');

console.log('\n=== 4. 旧的三层不留残骸，memoryPanel 不被误伤 ===');
ok(!/class="kit-panel/.test(html), 'element 上不再有 .kit-panel');
ok(!/class="cap-panel/.test(html), 'element 上不再有 .cap-panel');
ok(/class="settings-panel hidden glass-scope" id="memoryPanel"/.test(html),
  'memoryPanel 仍挂着 .settings-panel（它和设置页共用这两个类）');
ok(/^\s*\.settings-panel\{/m.test(html), '.settings-panel 的 CSS 仍在（memoryPanel 要靠它）');
ok(/^\s*\.settings-page\{/m.test(html), '.settings-page 的 CSS 仍在');
ok(!/^\s*\.kit-panel\{/m.test(html), '.kit-panel 的 CSS 已退休');
ok(!/^\s*\.cap-panel\{/m.test(html), '.cap-panel 的 CSS 已退休');
for (const c of ['.hub-panel{', '.hub-page{', '.hub-top{', '.hub-tabs{', '.hub-tab{',
                 '.hub-tab.on{', '.hub-body{', '.hub-view{', '.hub-view.on{', '.hub-subbar{', '.hub-refresh{']) {
  ok(html.includes(c), 'CSS 有 ' + c);
}
ok(/\.hub-view\{\s*display:none;[^}]*position:relative/.test(html),
  '★ .hub-view 是 position:relative —— 设置页那份 .settings-page 是 absolute;inset:0，靠它定尺寸');

console.log('\n=== 5. 删掉的按钮不留死监听 ===');
for (const id of ['#kitClose', '#capClose', '#settingsBack', '#settingsClose']) {
  eq(html.split(id).length - 1, 0, id + ' 已彻底清零（元素与监听都不在）');
}
/* 这两条用 includes 而不是正则 —— 字符串里全是 $ ( ) . 要转义，
   第一次跑就是自己少写了个括号导致假红。验"这句话在不在"用 includes 最实在。 */
ok(html.includes('if ($("#hubClose")) $("#hubClose").addEventListener("click", hubClose);'),
  '关闭键接的是 hubClose');
ok(html.includes('if ($("#kitBack")) $("#kitBack").addEventListener("click", hubBack);'),
  '返回键接的是 hubBack（工具详情里回网格，其余回菜单）');
ok(/const tabsEl = \$\("#hubTabs"\);/.test(html) && /if \(tabsEl\) tabsEl\.addEventListener\("click"/.test(html),
  'tab 行用一次委托，不是三个按钮各绑一次');

console.log('\n=== 6. 一个名字只能指一个东西：当前 tab 只有一处记账 ===');
/* ★ 数的是**赋值**，不是"出现过"。hubBack 里那句 `hubTab === "tools"` 会被
   split('hubTab =') 一起算进去（"hubTab ==" 的前 8 个字符正好是它）——
   第一次跑就是这条假红，红的是断言不是代码。 */
eq([...html.matchAll(/hubTab = (?!==)/g)].length, 2,
  'hubTab 只有两处赋值（let hubTab = "tools" 与 hubSwitch 里的 hubTab = tab）');
ok(/function hubTabNow\(\)\{ return hubTab; \}/.test(html), '对外只经 hubTabNow() 读');
ok(/function hubIsOpen\(\)/.test(html) && /hubIsOpen\(\)\)\{\s*\n\s*if \(hubTabNow\(\) === "tools"/.test(html),
  'Esc 走的是 hubIsOpen + hubTabNow，不再各自去 classList 上翻');
/* 宫殿/记忆/主题/收藏/Tides/菜单各自判断是历史包袱，这次不动它们；
   只收 hub：判断"这个壳开着吗"必须只有 hubIsOpen 一处。 */
eq(html.split('$("#hubPanel")').length - 1, 3,
  '$("#hubPanel") 只在 hubIsOpen / hubOpen / hubClose 三处出现');

console.log('\n=== 7. 切 tab 不等于"关了再开" ===');
ok(/if \(fn === "openSettings"\)\{ hubSwitch\("settings"\); return; \}/.test(html),
  'capAct 的 fn:openSettings 是同壳切 tab（不再 capClose + 240ms + openSettings）');
ok(/hubSwitch\("settings"\);\s*\n\s*try\{ expandSetCard\(name\); \}/.test(html),
  'capAct 的 card:xxx 是切 tab + 立即展开（省掉原来两段共 560ms 空等）');
ok(/hubOpen\("tools", \{ kit: "mcp" \}\)/.test(html),
  'capsGo("mcp") 直接切到工具页并打开那一项');
ok(/function kitOpen\(id\)\{\s*\n\s*hubOpen\("tools", id \? \{ kit: String\(id\) \} : null\);/.test(html),
  '★ kitOpen 现在真的收参数了（原来没有——capsGo 传的 "mcp" 被悄悄丢掉）');

console.log('\n=== 8. SW CACHE 已 bump（否则 PWA 停在旧壳，改了也白改）===');
const m = /const CACHE = "([^"]+)"/.exec(sw);
ok(!!m, 'sw.js 里找得到 CACHE');
const ver = m ? parseInt((/-v(\d+)/.exec(m[1]) || [])[1], 10) : 0;
ok(ver >= 103, 'CACHE 版本 >= v103（本次是 v103-hub）：' + (m ? m[1] : '-'));

/* ══════════════════════════════════════════════════════════════════════════
   第二段：把 hub 那段代码抠出来，用假 DOM 真跑一遍
   ────────────────────────────────────────────────────────────────────────── */
console.log('\n=== 9. 假 DOM：hubSwitch / hubOpen / hubBack 的真行为 ===');

const startNeedle = 'const HUB_TITLE = {';
const endNeedle = 'function kitClose(){ hubClose(); }';
const ai = html.indexOf(startNeedle);
const bi = html.indexOf(endNeedle);
ok(ai > 0 && bi > ai, '在 index.html 里找得到 hub 模块');
const hubCode = ai > 0 && bi > ai ? html.slice(ai, bi + endNeedle.length) : '';

function mkEl(attrs, cls) {
  const set = new Set(String(cls || '').split(/\s+/).filter(Boolean));
  return {
    _a: Object.assign({}, attrs || {}),
    textContent: '',
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._a, k) ? this._a[k] : null; },
    setAttribute(k, v) { this._a[k] = String(v); },
    classList: {
      add(...c) { c.forEach((x) => set.add(x)); },
      remove(...c) { c.forEach((x) => set.delete(x)); },
      contains(c) { return set.has(c); },
      toggle(c, f) { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on; },
      _set: set,
    },
  };
}

function harness() {
  const tabs = ['tools', 'gateway', 'settings'].map((k) =>
    mkEl({ 'data-hub': k, 'aria-selected': k === 'tools' ? 'true' : 'false' }, 'hub-tab' + (k === 'tools' ? ' on' : '')));
  const views = ['tools', 'gateway', 'settings'].map((k) =>
    mkEl({ 'data-hub-view': k }, 'hub-view' + (k === 'tools' ? ' on' : '')));
  const panel = mkEl({}, 'hub-panel hidden');
  const kitBackBtn = mkEl({}, 'hub-back hidden');
  const kitTitle = mkEl({}, 'hub-title'); kitTitle.textContent = '工具与能力';
  const kitSub = mkEl({}, 'hub-sub'); kitSub.textContent = '它和这台手机能做的事';
  const kitDetail = mkEl({}, 'hidden');
  const byId = { hubPanel: panel, kitBack: kitBackBtn, kitTitle, kitSub, kitDetail };
  const calls = { kitBack: 0, kitTool: [], capRender: 0, capLoad: [], settings: 0, openMenu: 0, raf: 0, timeouts: 0 };

  const sandbox = {
    document: {
      querySelectorAll(sel) { return sel.indexOf('.hub-tab') >= 0 ? tabs : views; },
    },
    $: (sel) => byId[String(sel).replace(/^#/, '')] || null,
    requestAnimationFrame(fn) { calls.raf++; fn(); },
    setTimeout(fn) { calls.timeouts++; fn(); },
    kitBack() { calls.kitBack++; kitTitle.textContent = '工具与能力'; kitSub.textContent = '它和这台手机能做的事'; kitBackBtn.classList.add('hidden'); },
    kitTool(id) { calls.kitTool.push(id); },
    capRender() { calls.capRender++; },
    capLoad(f) { calls.capLoad.push(f); },
    hubLoadSettings() { calls.settings++; },
    openMenu() { calls.openMenu++; },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(hubCode + '\n; globalThis.__api = { hubSwitch, hubOpen, hubClose, hubBack, hubIsOpen, hubTabNow, HUB_TITLE };', ctx, { filename: 'hub.js' });
  return { api: ctx.__api, tabs, views, panel, kitBackBtn, kitTitle, kitSub, kitDetail, calls };
}

let H;
try {
  H = harness();
  ok(!!H.api, 'hub 模块在假 DOM 里跑起来了');
} catch (e) {
  ok(false, 'hub 模块跑不起来', String(e && e.message || e));
}

if (H && H.api) {
  const { api, tabs, views, panel, kitBackBtn, kitTitle, calls } = H;

  eq(api.hubTabNow(), 'tools', '起始 tab 是 tools');
  eq(tabs.map((t) => t.classList.contains('on')), [true, false, false], '起始高亮在第一个 tab');
  eq(views.map((v) => v.classList.contains('on')), [true, false, false], '起始只显示第一个视图');

  const viewsBefore = views.slice();

  api.hubSwitch('gateway');
  eq(api.hubTabNow(), 'gateway', 'hubSwitch("gateway") 后 hubTab 变了');
  eq(tabs.map((t) => t.classList.contains('on')), [false, true, false], '高亮跟着走');
  eq(views.map((v) => v.classList.contains('on')), [false, true, false], '视图跟着走');
  eq(tabs[1].getAttribute('aria-selected'), 'true', '选中的 tab aria-selected=true');
  eq(tabs[0].getAttribute('aria-selected'), 'false', '没选中的 tab aria-selected=false');
  eq(kitTitle.textContent, '网关', '顶栏标题变成「网关」');
  ok(!kitBackBtn.classList.contains('hidden'), '★ 非工具 tab 上要显示返回键（它负责"回菜单"）');
  eq(calls.capRender, 1, '切到网关时铺一次骨架');
  eq(calls.capLoad, [false], '切到网关时拉一次状态');
  eq(views.map((v, i) => v === viewsBefore[i]), [true, true, true],
    '★ 视图是同一个对象（切 tab 只翻 class，没有重建 DOM）');

  api.hubSwitch('settings');
  eq(api.hubTabNow(), 'settings', '再切到设置');
  eq(views.map((v) => v.classList.contains('on')), [false, false, true], '只有设置视图亮着');
  eq(kitTitle.textContent, '设置', '顶栏标题变成「设置」');
  eq(calls.settings, 1, '切到设置时跑一次 hubLoadSettings');

  api.hubSwitch('tools');
  eq(calls.kitBack, 1, '切回工具页会调 kitBack()（回到网格、标题写回去）');
  ok(kitBackBtn.classList.contains('hidden'), '★ 工具首页把返回键收起（那儿没什么可返回）');
  eq(kitTitle.textContent, '工具与能力', '标题回到「工具与能力」');

  api.hubSwitch('tools', { kit: 'mcp' });
  eq(calls.kitTool, ['mcp'], '★ 带 {kit:"mcp"} 时直达那一项');

  api.hubSwitch('没有这个 tab');
  eq(api.hubTabNow(), 'tools', '认不出的 tab 名回落到 tools（不静默卡在半路）');

  // 壳的显隐
  ok(panel.classList.contains('hidden'), '打开之前是 hidden');
  api.hubOpen('gateway');
  ok(!panel.classList.contains('hidden'), 'hubOpen 之后 hidden 去掉');
  ok(panel.classList.contains('open'), 'hubOpen 之后带上 open（入场动画靠它）');
  ok(calls.raf >= 1, '入场动画走 requestAnimationFrame');
  eq(api.hubIsOpen(), true, 'hubIsOpen() 认这个壳');
  ok(api.hubTabNow() === 'gateway', 'hubOpen("gateway") 顺带切了 tab');

  api.hubClose();
  ok(!panel.classList.contains('open'), 'hubClose 去掉 open');
  ok(panel.classList.contains('hidden'), 'hubClose 之后（动画计时器到点）加上 hidden');

  // hubBack 的两种语义
  H.kitDetail.classList.remove('hidden');
  api.hubSwitch('tools');
  const kb = calls.kitBack;
  api.hubBack();
  eq(calls.kitBack, kb + 1, '★ 在工具详情里，顶栏返回＝回网格');
  eq(calls.openMenu, 0, '回网格这一步不该顺手打开菜单');

  H.kitDetail.classList.add('hidden');
  api.hubSwitch('gateway');
  const om = calls.openMenu;
  api.hubBack();
  eq(calls.openMenu, om + 1, '★ 其余情况，顶栏返回＝关面板 + 回菜单（跟原来设置页那个返回一致）');
}

console.log('\n──────────────────────────────');
console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
process.exit(FAIL ? 1 : 0);
