/*
 * 记忆面板自检 —— 用法：node smoke-memory-nav.js [index.html]
 *
 * 记忆面板收敛成三页（记忆库 / 近景七天 / Haven）之后重写。
 * 上一版测的是"两个 tab + 卡片网格 + 面包屑"，那套结构已经不存在了 ——
 * 这类测试最容易变成**假绿**：结构改了、断言还在测老结构，
 * 于是"点了没反应"这种真错反而放过去了。
 *
 * 两段：
 *   ① 结构（解析真实 index.html）：只剩哪三页、东西各自住在哪一页、
 *      下线的七页有没有真的走干净（少了这一步，"删了一半"看不出来）
 *   ② 行为（把 buildMemNav / memShowPage / memNavSync 抠出来，在真实 DOM 上真跑）：
 *      点 tab 会不会切页、高亮跟着走没走、切过去有没有触发它自己的异步加载、
 *      认不出的 key 会不会静默停在半路
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = process.argv[2] || path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

let PASS = 0, FAIL = 0;
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
}

const dom = new JSDOM(html, { url: 'https://tidal.example/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const doc = w.document;
const $ = (s) => doc.querySelector(s);
const $$ = (s) => Array.prototype.slice.call(doc.querySelectorAll(s));

console.log('=== 1. 结构：只剩三页，且各就各位 ===');
const pages = $$('#memoryPanel .mem-page').map((p) => p.dataset.mp);
ok(pages.length === 3, '记忆面板一共 3 页（实际 ' + pages.length + '：' + pages.join('/') + '）');
ok(pages.indexOf('lib') >= 0 && pages.indexOf('near') >= 0 && pages.indexOf('haven') >= 0,
   '三页就是 记忆库 / 近景七天 / Haven', pages);
ok(pages[0] === 'lib', '第一页是记忆库（打开面板先看到它）', pages[0]);

const tabs = $$('#memoryPanel .mem-tab').map((t) => t.dataset.memTab);
ok(tabs.join(',') === 'lib,near,haven', '顶部三段导航与页一一对应', tabs);
ok($$('#memoryPanel .mem-tab.on').length === 1, '默认只有一段是高亮的');
ok($('#memoryPanel .mem-tab.on').dataset.memTab === 'lib', '默认高亮的是记忆库');

console.log('\n=== 2. 下线的七页 / 面板 / 入口，有没有真的走干净 ===');
[['overview', '总览（银河 + 日历）'], ['all', '全部（卡片网格）'], ['archive', '档案馆'],
 ['worldbook', '世界书'], ['pending', '待确认'], ['timeline', '时间线 · 一个它']]
  .forEach(([k, name]) => ok(!$('[data-mp="' + k + '"]'), name + ' 页已下线'));
ok(!$('#palacePanel'), '记忆宫殿独立面板已下线');
ok(!$('#memGrid'), '卡片网格容器已下线');
ok(!$('#memCrumb'), '面包屑已下线（三 tab 不需要"回上层"）');

const js = html;
ok(!/n:"记忆宫殿"/.test(js), '工具中心里没有「记忆宫殿」入口了');
ok(/n:"记忆"/.test(js), '「记忆」入口还在');
ok(!/const MEM_SECTIONS = \[/.test(js), 'MEM_SECTIONS 那张卡片表已删除');
ok(!/function memPackRender/.test(js), 'memory-pack 的渲染桥已删除（那两页下线了）');

console.log('\n=== 3. 三页各自的内容住在自己页里（不能还散在外面）===');
ok(!!$('[data-mp="lib"] #mlCard'), '记忆库卡片住在 lib 页');
ok(!!$('[data-mp="lib"] #mlQ'), '记忆库搜索框住在 lib 页');
ok(!!$('[data-mp="lib"] #mlTabs'), '记忆库两档 tab 住在 lib 页');
ok(!!$('[data-mp="lib"] #mlEdit'), '记忆库编辑框住在 lib 页');
ok(!!$('[data-mp="lib"] #mlUnres'), '记忆库「还没做/还没去」勾选住在 lib 页');
ok(!!$('[data-mp="near"] #nfDays'), '近景的七天住在 near 页');
ok(!!$('[data-mp="near"] #nfRun'), '近景的动作胶囊（脱水→日更）也搬进 near 页了');
ok(!!$('[data-mp="near"] #nfCurrent'), '近景的注入稿住在 near 页');
ok(!!$('[data-mp="haven"] #brainCard'), 'Haven 的卡片住在 haven 页');
ok(!!$('[data-mp="haven"] #brList'), 'Haven 的列表住在 haven 页');

console.log('\n=== 4. 行为：点 tab 真切页（假 DOM 上跑真代码）===');
const START = '/* ── 记忆面板：三段导航';
/* ★ 收尾锚点换过一次：原来靠 `function libEditOpen` 收，那个函数是「世界书分区卡」
   的编辑器，随下线功能一起清掉了。现在收在工作记忆那一段之前。 */
const END = '/* ── 工作记忆 = 技术记忆';
const a = html.indexOf(START), b = html.indexOf(END, a);
if (a < 0 || b < 0) { console.log('✗ 抠不出导航代码段（锚点变了？）'); process.exit(1); }
const CODE = html.slice(a, b);
console.log('  抠出导航代码段：' + CODE.length + ' 字符');

const calls = { brLoad: 0, mlLoad: 0, scrollReset: 0 };
w.eval(`
  var $ = (s) => document.querySelector(s);
  var memData = { status: {}, counts: {} };
  var brLoad = () => { window.__calls.brLoad++; };
  var mlLoad = () => { window.__calls.mlLoad++; };
`);
w.__calls = calls;
w.eval(CODE);

ok(typeof w.memShowPage === 'function', 'memShowPage 定义出来了（代码段真的跑起来了）');
/* ★ 必须真调一次 buildMemNav —— tab 的 click 监听器是在它里面绑的。
   不调就点，得到的是"点了没反应"，而那不是 bug（线上打开面板时一定会走这一步）。 */
w.buildMemNav();

function shownPage() {
  const vis = $$('#memoryPanel .mem-page').filter((p) => !p.classList.contains('hidden'));
  return vis.length === 1 ? vis[0].dataset.mp : ('(' + vis.length + ' 页可见)');
}
function onTab() {
  const t = $('#memoryPanel .mem-tab.on');
  return t ? t.dataset.memTab : '(没有高亮)';
}

ok(shownPage() === 'lib', '初始可见的是 lib 页', shownPage());

// 点「近景七天」
$('[data-mem-tab="near"]').click();
ok(shownPage() === 'near', '★ 点「近景七天」切到了 near', shownPage());
ok(onTab() === 'near', '★ 高亮跟着走到 near', onTab());
ok($('[data-mem-tab="near"]').getAttribute('aria-selected') === 'true', '无障碍：选中的 aria-selected=true');
ok($('[data-mem-tab="lib"]').getAttribute('aria-selected') === 'false', '没选中的是 false');

// 点 Haven：除了切页，还要触发它自己的异步加载
calls.brLoad = 0;
$('[data-mem-tab="haven"]').click();
ok(shownPage() === 'haven', '★ 点「Haven」切到了 haven', shownPage());
ok(calls.brLoad === 1, '★ 切到 Haven 会补一次 brLoad（否则那一页永远是空壳）', calls.brLoad);

// 点回记忆库
calls.mlLoad = 0;
$('[data-mem-tab="lib"]').click();
ok(shownPage() === 'lib', '★ 切回记忆库', shownPage());
ok(calls.mlLoad === 1, '★ 切到记忆库会补一次 mlLoad', calls.mlLoad);

// 认不出的 key 不能静默停在半路
w.memShowPage('archive');
ok(shownPage() === 'lib', '★ 认不出的 key 回落记忆库（不静默停在半路）', shownPage());
w.memShowPage('worldbook');
ok(shownPage() === 'lib', '★ 已下线的页名也回落到记忆库', shownPage());

// 切页时滚回顶部
const sc = $('#memoryPanel .settings-scroll');
sc.scrollTop = 400;
w.memShowPage('near');
ok(sc.scrollTop === 0, '切页时内容区滚回顶部', sc.scrollTop);

console.log('\n=== 5. 计数：近景那张卡的副标题 ===');
w.eval('memData.status = { days: [{}, {}, {}], max_days: 7 };');
w.memNavSync();
ok(/3 天有日更/.test($('#cardSubNear').textContent), '有日更时写"3 天有日更"：' + $('#cardSubNear').textContent);
w.eval('memData.status = { days: [] };');
w.memNavSync();
ok(/还没生成/.test($('#cardSubNear').textContent), '没有日更时写"还没生成"（不是写 0）：' + $('#cardSubNear').textContent);

console.log('\n──────────────────────────────');
console.log('通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项');
process.exit(FAIL ? 1 : 0);
