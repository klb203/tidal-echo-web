/*
 * 记忆面板「六层」结构自检 —— 用法：node smoke-memory-layers.js [index.html]
 *
 * 为什么要有它：这一路改动动的全是**摆放**（分栏卡的 key ↔ 页面的 data-mp ↔ 各种 id），
 * 而这类错 node --check 一个都抓不到：
 *   · 分栏卡 key 写成 "palce"、页面写 data-mp="palace" → 点了静默跳回总览，看着像"没反应"
 *   · 搬 DOM 时 id 漏抄 / 抄重 → 后端读到了但界面一片空白
 *   · 一类记忆既没有独立页、也没进任何合并页 → **凭空消失**（最难发现的一种）
 *   · 改了名字但没 bump SW 的 CACHE → PWA 停在旧壳，改了什么都是"没生效"
 *
 * 这一份只验前端自己的一致性（不需要后端、不需要浏览器），所以能独立跑。
 * 逻辑层的真行为由 smoke-memory-pack.js 用假 DOM + 假 fetch 验。
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

/* ── 取片段（这些定义都是数组/对象字面量，按第一个 '];' / '};' 收尾）────── */
function block(needle) {
  const i = html.indexOf(needle);
  if (i < 0) return '';
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
for (const k of ['palace', 'worldbook', 'archive', 'near', 'haven', 'overview']) {
  ok(pageKeys.includes(k), '有页面 data-mp="' + k + '"');
}
for (const k of barKeys) {
  if (!k.startsWith('lib-')) ok(pageKeys.includes(k), '分栏 "' + k + '" 有对应页面');
}
const orphan = pageKeys.filter((p) => !p.startsWith('lib-') && !barKeys.includes(p));
eq(orphan, [], '没有孤儿页面（有页但没入口）');

console.log('\n=== 3. 世界书不再是"聊天记录长出来的叙事" ===');
/* ★ 这一节是**纠正**：上一版把世界书当成"事件/摘要/故事/片段四类合一"，
   于是 LIB_DEFS 给它们标了 book、分栏把它们藏起来、WB_KINDS 列了那四类。
   参考实现的定义是"手写的补充设定"（Lorebook）—— 那四类归档案馆（事件盒）。
   所以现在正确形态是：**没有 book 标记、没有 WB_KINDS、四类各占一张分区卡**。 */
ok(!/const WB_KINDS/.test(html), 'WB_KINDS 已退休（那四类不再属于世界书）');
const libBlock = block('const LIB_DEFS = [');
const libKinds = [...libBlock.matchAll(/kind:\s*"([^"]+)"/g)].map((m) => m[1]);
const bookKinds = [...libBlock.matchAll(/\{\s*kind:\s*"([^"]+)",[^}]*?\bbook:\s*true/g)].map((m) => m[1]);
ok(libKinds.length === 8, 'LIB_DEFS 仍是 8 类（没有偷偷丢掉）: ' + libKinds.length);
eq(bookKinds, [], '没有任何一类标着 book（世界书不再从记忆库里挑）');
for (const k of ['event', 'summary', 'story', 'fragment']) {
  ok(libKinds.includes(k), '叙事 "' + k + '" 仍在 LIB_DEFS 里（否则它的编辑入口消失了）');
}
ok(/const note = LIB_DEFS\.filter\(\(d\)\s*=>\s*!d\.book\)/.test(html) === false,
  'buildLibCards 不再按 book 拆（那个过滤器连同 #wbSections 一起退休了）');

console.log('\n=== 4. 八个分区各占一页，一个处理器 ===');
ok(/host\.innerHTML = LIB_DEFS\.map\(/.test(html),
  '八个分区都渲染进 #libCards');
ok(!/\$\("#wbSections"\)/.test(html), '#wbSections 已经不存在（不再往那儿塞卡片）');
ok(!/\[\s*host,\s*\$\("#wbSections"\)\s*\]/.test(html),
  '监听器只挂一个宿主（两个宿主的写法是上一版的）');

console.log('\n=== 5. 档案馆：两个子视图，DOM 搬家要真落在新页里 ===');
const iArchive = html.indexOf('data-mp="archive"');
const iArcBoxes = html.indexOf('id="arcBoxes"');
const iArcTl = html.indexOf('id="arcTimeline"');
const iArcBody = html.indexOf('id="arcBody"');
const iWorldbook = html.indexOf('data-mp="worldbook"');
ok(iArchive >= 0 && iArcBoxes >= 0 && iArcTl >= 0 && iArcBody >= 0, '四个锚点都在');
ok(iArchive < iArcBoxes && iArcBoxes < iArcTl && iArcTl < iArcBody && iArcBody < iWorldbook,
  '顺序是：档案馆页 → #arcBoxes → #arcTimeline → #arcBody → 世界书页',
  { archive: iArchive, boxes: iArcBoxes, tl: iArcTl, body: iArcBody, wb: iWorldbook });
for (const id of ['arcCrumb', 'arcLead', 'arcChars', 'arcCount']) {
  ok(iArchive < html.indexOf('id="' + id + '"') && html.indexOf('id="' + id + '"') < iWorldbook,
    '#' + id + ' 在这个页里');
}
ok(/id="arcTimeline" class="hidden"/.test(html) || /class="hidden"[^>]*id="arcTimeline"/.test(html),
  '#arcTimeline 初始是 hidden（默认显示事件盒那一屏）');
const iOverview = html.indexOf('data-mp="overview"');
const iOverviewEnd = html.indexOf('<!-- /总览页 -->');
ok(!(html.slice(iOverview, iOverviewEnd).includes('id="arcCard"')), '总览页里已经没有被搬走的档案卡');

console.log('\n=== 6. 两个新挂载点各一个，且 pack 真的被引入 ===');
for (const id of ['arcBoxes', 'arcTimeline', 'memWbMount', 'arcCard', 'arcBody', 'arcCrumb',
                  'arcLead', 'arcChars', 'arcCount', 'libCards', 'memBar', 'palCard', 'palOpen']) {
  const n = (html.match(new RegExp('id="' + id + '"', 'g')) || []).length;
  ok(n === 1, '#' + id + ' 恰好一个', n);
}
ok(/<script defer src="memory-pack\.js"><\/script>/.test(html), 'index.html 引入了 memory-pack.js');
ok(/<link rel="stylesheet" href="memory-pack\.css">/.test(html), 'index.html 引入了 memory-pack.css');
/* 两个挂载点的监听器由 pack 自己挂（dataset.bound），宿主不该碰它们 */
ok(!/\$\("#memWbMount"\)/.test(html), '宿主不碰 #memWbMount（整页归 pack）');
ok(!/\$\("#arcBoxes"\)/.test(html), '宿主不碰 #arcBoxes');
/* 但切页时必须通知 pack，否则进去是空的 */
ok(/MemoryPack\.render\("worldbook"\)/.test(html), 'memShowPage 会通知 pack 渲染世界书');
ok(/MemoryPack\.render\("archive"\)/.test(html), 'memShowPage 会通知 pack 渲染档案馆');
/* 时间线那一屏还是宿主的 arcRender —— 不能因为加了 pack 就没人画它 */
ok(/try \{ arcRender\(\); \} catch/.test(html), '档案馆页仍然会调宿主自己的 arcRender()');

console.log('\n=== 7. 世界书那一页的旧控件已经清干净（不留死按钮）===');
for (const id of ['wbSections', 'wbTag', 'wbCard', 'wbLead', 'wbRefresh', 'wbCompose', 'wbMonth', 'wbStatus']) {
  const n = (html.match(new RegExp('id="' + id + '"', 'g')) || []).length;
  ok(n === 0, '#' + id + ' 已经不在页面里', n);
}
ok(!/\$\("#wbRefresh"\)/.test(html), '没有指向 #wbRefresh 的监听器（死代码）');
ok(!/\$\("#wbCompose"\)/.test(html), '没有指向 #wbCompose 的监听器');
ok(!/\$\("#wbMonth"\)/.test(html), '没有指向 #wbMonth 的监听器');

console.log('\n=== 8. 记忆宫殿是"借道"，不是第二套 UI ===');
const iPalOpen = html.indexOf('$("#palOpen")');
ok(iPalOpen > 0 && /openPalace\(\)/.test(html.slice(iPalOpen, iPalOpen + 220)),
  '长期记忆页的按钮调的是 openPalace()（不复制宫殿 UI）');

console.log('\n=== 9. 六层计数来自后端，不自己算 ===');
ok(/\/app\/layers/.test(html), 'memLoad 会读 /app/layers');
ok(/memData\.layers/.test(html), '读到后存进 memData.layers');
ok(/many\("palace"/.test(html) && /many\("worldbook"/.test(html) && /many\("archive"/.test(html),
  '副标题用后端计数（palace / worldbook / archive）');
ok(/nx\("haven"\) === null|Haven Brain · 只读/.test(html),
  'haven 不报数字（它在别人服务器上，报 0 会读成"空的"）');

console.log('\n=== 10. 只读条目不能在时间线里被"编辑" ===');
ok(/ro:\s*!!s\.ro/.test(html), 'arcItems 透传 ro');
ok(/const openAttr = it\.ro \? "" :/.test(html), 'arcEntryHtml 对 ro 条目不挂 data-arc-open');
ok(/canEdit:\s*!s\.ro &&/.test(html), 'ro 条目 canEdit 为 false');

console.log('\n=== 11. Service Worker：缓存已 bump，且新文件进了预缓存 ===');
try {
  const sw = fs.readFileSync(SW, 'utf8');
  const m = /const CACHE = "([^"]+)"/.exec(sw);
  ok(!!m, '找到 CACHE');
  ok(/v99|events?box|memory-pack|worldbook/.test(m ? m[1] : ''), 'CACHE 是本次的版本：' + (m ? m[1] : '?'));
  for (const f of ['./memory-pack.js', './memory-pack.css']) {
    ok(sw.includes(f), f + ' 在 PRECACHE 里（否则离线打开是空的）');
  }
} catch (e) {
  ok(false, '读不到 sw.js：' + e.message);
}

console.log('\n────────────────────────────────────────');
console.log(PASS + ' 通过 / ' + FAIL + ' 失败');
process.exit(FAIL ? 1 : 0);
