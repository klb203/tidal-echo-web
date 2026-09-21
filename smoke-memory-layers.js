/*
 * 记忆面板「六层」结构自检 —— 用法：node smoke-memory-layers.js
 *
 * 为什么要有它：这次重排动的全是**摆放**（分栏卡的 key ↔ 页面的 data-mp ↔ 各种 id），
 * 而这类错 node --check 一个都抓不到：
 *   · 分栏卡 key 写成 "palce"、页面写 data-mp="palace" → 点了静默跳回总览，看着像"没反应"
 *   · 搬 DOM 时 id 漏抄 / 抄重 → 后端读到了但界面一片空白
 *   · 世界书的四类在 LIB_DEFS 里标了 book，而 WB_KINDS 里漏了 "summary"
 *     → 那一类既没有独立页、也没进世界书页，等于**凭空消失**
 *
 * 这一份只验前端自己的一致性（不需要后端），所以能独立跑。
 */
const fs = require('fs');
const path = require('path');

const HTML = process.argv[2] || path.join(__dirname, 'index.html');
const SW = path.join(path.dirname(HTML), 'sw.js');

const html = fs.readFileSync(HTML, 'utf8');
let PASS = 0, FAIL = 0;
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }

/* ── 取片段 ───────────────────────────────────────────────────────────── */
function block(needle) {
  const i = html.indexOf(needle);
  if (i < 0) return '';
  /* 从 needle 开始，按第一个 '];' 或 '};' 收尾（这些定义都是数组/对象字面量） */
  const j = html.indexOf('\n];', i);
  const k = html.indexOf('\n};', i);
  const end = [j, k].filter((x) => x > 0).sort((a, b) => a - b)[0];
  return end ? html.slice(i, end) : '';
}

console.log('=== 1. 底部栏六层 ===');
const barBlock = block('const MEM_BAR_FIXED = [');
ok(barBlock.length > 0, '找到 MEM_BAR_FIXED');
const barKeys = [...barBlock.matchAll(/\bkey:\s*"([^"]+)"/g)].map((m) => m[1]);
const barNames = [...barBlock.matchAll(/\bname:\s*"([^"]+)"/g)].map((m) => m[1]);
eq(barKeys, ['overview', 'palace', 'near', 'haven', 'worldbook', 'archive', 'pending', 'timeline'],
  '分栏顺序：总览 → 长期 → 短期 → 外置 → 世界书 → 档案馆 → 待确认 → 时间线');
eq(barNames.slice(0, 6), ['总览', '长期记忆', '短期记忆', '外置记忆库', '世界书', '档案馆'],
  '六层的名字');

console.log('\n=== 2. 每张分栏卡都有对应页面（点了不能静默跳回总览）===');
const pageKeys = [...html.matchAll(/class="mem-page[^"]*"\s+data-mp="([^"]+)"/g)].map((m) => m[1]);
ok(pageKeys.includes('palace'), '有「长期记忆」页 data-mp="palace"');
ok(pageKeys.includes('worldbook'), '有「世界书」页 data-mp="worldbook"');
ok(pageKeys.includes('archive'), '有「档案馆」页 data-mp="archive"');
ok(pageKeys.includes('near'), '有「短期记忆」页 data-mp="near"');
ok(pageKeys.includes('haven'), '有「外置记忆库」页 data-mp="haven"');
ok(pageKeys.includes('overview'), '有「总览」页 data-mp="overview"');
for (const k of barKeys) {
  const isLib = k.startsWith('lib-');
  if (!isLib) ok(pageKeys.includes(k), '分栏 "' + k + '" 有对应页面');
}
const orphan = pageKeys.filter((p) => !p.startsWith('lib-') && !barKeys.includes(p));
eq(orphan, [], '没有孤儿页面（有页但没入口）');

console.log('\n=== 3. 世界书：四类必须一个不多一个不少 ===');
const wbKinds = (() => {
  const m = /const WB_KINDS\s*=\s*\[([^\]]*)\]/.exec(html);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
})();
eq(wbKinds.sort(), ['event', 'fragment', 'story', 'summary'], 'WB_KINDS = 事件 / 摘要 / 故事 / 片段');

const libBlock = block('const LIB_DEFS = [');
const libKinds = [...libBlock.matchAll(/kind:\s*"([^"]+)"/g)].map((m) => m[1]);
const bookKinds = [...libBlock.matchAll(/\{\s*kind:\s*"([^"]+)",[^}]*?\bbook:\s*true/g)].map((m) => m[1]);
ok(libKinds.length === 8, 'LIB_DEFS 仍是 8 类（没有偷偷丢掉）: ' + libKinds.length);
eq(bookKinds.sort(), wbKinds.slice().sort(), '标了 book 的正好是 WB_KINDS 那四类');
/* ★ 漏一类就会"既没独立页、也没进世界书页" = 凭空消失 */
for (const k of wbKinds) {
  ok(libKinds.includes(k), '世界书的 "' + k + '" 在 LIB_DEFS 里（否则那一页渲染不出来）');
}

console.log('\n=== 4. 分栏不出重复入口 ===');
ok(/LIB_DEFS\.filter\(\(d\)\s*=>\s*!d\.book\)/.test(html),
  'buildMemBar 过滤掉了 book 那四类（否则同一条记忆两个入口）');

console.log('\n=== 5. DOM 搬家：档案馆那一块要真的在新页里 ===');
const iArchive = html.indexOf('data-mp="archive"');
const iArcBody = html.indexOf('id="arcBody"');
const iWorldbook = html.indexOf('data-mp="worldbook"');
ok(iArchive >= 0 && iArcBody >= 0, '两个锚点都在');
ok(iArchive < iArcBody && iArcBody < iWorldbook,
  '#arcBody 落在档案馆页与下一個页之间（搬家成功）', { archive: iArchive, body: iArcBody, next: iWorldbook });
/* 归档的三个统计口也得跟着搬，不然会指到不存在的元素 */
for (const id of ['arcCrumb', 'arcLead', 'arcChars', 'arcCount']) {
  ok(iArchive < html.indexOf('id="' + id + '"'), '#' + id + ' 也在档案馆页里');
}
/* 总览页不该再有档案室 */
const iOverview = html.indexOf('data-mp="overview"');
const iOverviewEnd = html.indexOf('<!-- /总览页 -->');
ok(!(html.slice(iOverview, iOverviewEnd).includes('id="arcCard"')), '总览页里已经没有被搬走的档案卡');

console.log('\n=== 6. 新加的 id 各只有一个，且都被引用 ===');
const idNeed = ['palCard', 'palOpen', 'palTag', 'palLead',
                'wbCard', 'wbSections', 'wbTag', 'wbLead', 'wbRefresh', 'wbCompose', 'wbMonth', 'wbStatus',
                'arcCard', 'arcBody', 'arcCrumb', 'arcLead', 'arcChars', 'arcCount', 'libCards', 'memBar'];
for (const id of idNeed) {
  const n = (html.match(new RegExp('id="' + id + '"', 'g')) || []).length;
  ok(n === 1, '#' + id + ' 恰好一个', n);
}
for (const id of ['palOpen', 'wbRefresh', 'wbCompose', 'wbMonth']) {
  ok(new RegExp('\\$\\("#' + id + '"\\)').test(html), '#' + id + ' 挂了监听器（否则是个死按钮）');
}
/* buildLibCards 往 #wbSections 写 —— 这个容器丢了世界书就是空的 */
ok(/\$\("#wbSections"\)/.test(html), 'buildLibCards 找得到 #wbSections');
ok(/\[\s*host,\s*\$\("#wbSections"\)\s*\]/.test(html),
  '两个宿主都挂了点击监听器（世界书那四张卡的编辑按钮才活）');

console.log('\n=== 7. 记忆宫殿是"借道"，不是第二套 UI ===');
const iPalOpen = html.indexOf('$("#palOpen")');
ok(iPalOpen > 0 && /openPalace\(\)/.test(html.slice(iPalOpen, iPalOpen + 220)),
  '长期记忆页的按钮调的是 openPalace()（不复制宫殿 UI）');

console.log('\n=== 8. 六层计数来自后端，不自己算 ===');
ok(/\/app\/layers/.test(html), 'memLoad 会读 /app/layers');
ok(/memData\.layers/.test(html), '读到后存进 memData.layers');
ok(/many\("palace"/.test(html) && /many\("worldbook"/.test(html) && /many\("archive"/.test(html),
  '副标题用后端计数（palace / worldbook / archive）');
ok(/nx\("haven"\) === null|Haven Brain · 只读/.test(html),
  'haven 不报数字（它在别人服务器上，报 0 会读成"空的"）');

console.log('\n=== 9. 只读条目不能在档案馆里被"编辑" ===');
ok(/ro:\s*!!s\.ro/.test(html), 'arcItems 透传 ro');
ok(/const openAttr = it\.ro \? "" :/.test(html), 'arcEntryHtml 对 ro 条目不挂 data-arc-open');
ok(/canEdit:\s*!s\.ro &&/.test(html), 'ro 条目 canEdit 为 false');

console.log('\n=== 10. Service Worker 缓存已 bump（否则 PWA 停在旧壳）===');
try {
  const sw = fs.readFileSync(SW, 'utf8');
  const m = /const CACHE = "([^"]+)"/.exec(sw);
  ok(!!m, '找到 CACHE');
  ok(/layers|v9[89]/.test(m ? m[1] : ''), 'CACHE 是本次的版本：' + (m ? m[1] : '?'));
} catch (e) {
  ok(false, '读不到 sw.js：' + e.message);
}

console.log('\n────────────────────────────────────────');
console.log(PASS + ' 通过 / ' + FAIL + ' 失败');
process.exit(FAIL ? 1 : 0);
