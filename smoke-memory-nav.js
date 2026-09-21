/*
 * 记忆面板导航自检 —— 用法：node smoke-memory-nav.js [index.html]
 *
 * 导航刚改过：底部横滑栏（八张卡）→ 顶部两个 tab（总览 / 全部）+ 卡片网格，
 * 侧边栏那个「记忆宫殿」入口也并了进来。改的是**怎么在页之间走**，而这类错
 * `node --check` 一个都抓不到，症状还特别像"没反应"：
 *   · tab / 卡片的 data-* 与页面 data-mp 拼错一个字母 → 点了还是停在原页
 *   · 进二级页后 tab 高亮跑掉 → 用户看不出自己在哪、也找不到回去的路
 *   · 面包屑忘了显示 / 隐藏逻辑反了 → 要么回不去，要么首页上挂着一条多余的「‹ 全部」
 *   · 切到某页时忘了触发它的异步加载 → 那一页永远空壳
 *
 * 第一段验结构（数据表 ↔ 页面 ↔ 挂载点），第二段把 memShowPage 抠出来真跑。
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

console.log('=== 1. 两个 tab + 一张卡片表，三者对得上 ===');
const tabKeys = [...html.matchAll(/data-mem-tab="([^"]+)"/g)].map((m) => m[1]);
eq(tabKeys, ['overview', 'all'], '顶部就两个 tab：总览 / 全部');
const cardKeys = [...arrBlock(html, 'const MEM_SECTIONS = [').matchAll(/\bkey:\s*"([^"]+)"/g)].map((m) => m[1]);
ok(cardKeys.length >= 6, '卡片表里有几个分区：' + cardKeys.length);
const pageKeys = [...html.matchAll(/class="mem-page[^"]*"\s+data-mp="([^"]+)"/g)].map((m) => m[1]);
for (const k of tabKeys) ok(pageKeys.includes(k), '★ tab "' + k + '" 有对应页面（否则点了没反应）');
for (const k of cardKeys) ok(pageKeys.includes(k), '★ 卡片 "' + k + '" 有对应页面');
const orphan = pageKeys.filter((p) => !tabKeys.includes(p) && !cardKeys.includes(p));
eq(orphan, [], '没有孤儿页（有页但既不是 tab、也不在卡片表里）');
ok(!cardKeys.includes('overview'), '「总览」不在卡片表里（它是 tab，不是卡片）');

console.log('\n=== 2. 卡片就是工具能力页那套排版 ===');
ok(/<div class="kit-grid" id="memGrid"><\/div>/.test(html), '「全部」页的网格用的是 .kit-grid');
const buildFn = html.slice(html.indexOf('function buildMemNav(){'), html.indexOf('function buildMemNav(){') + 1200);
ok(/class="kit-card" type="button" data-mp-go=/.test(buildFn), '卡片用 .kit-card + data-mp-go');
ok(/class="kit-card-t"/.test(buildFn) && /class="kit-card-s"/.test(buildFn),
  '卡片里是标题 + 副标题两行（和工具卡一样）');
ok(/id="mcNum-' \+ c\.key \+ '"/.test(buildFn), '每张卡带一个计数位 #mcNum-<key>');
ok(/grid\.dataset\.built/.test(buildFn) && /tabs\.dataset\.built/.test(buildFn),
  '填一次、绑一次（重复 openMemory 不会叠出第二套监听）');

console.log('\n=== 3. 侧边栏那个「记忆宫殿」入口已经并进来 ===');
const menuKeys = [...html.matchAll(/class="menu-item"[^>]*data-menu="([^"]+)"/g)].map((m) => m[1]);
ok(!menuKeys.includes('palace'), '「Palace」不再是侧边栏的独立入口');
ok(/window\.openPalace|function openPalace/.test(html), 'openPalace 仍在（网关那边还要用它）');
ok(/id="palOpen"/.test(html), '长期记忆页里有「打开记忆宫殿 ↗」按钮（不做第二套 UI）');

console.log('\n=== 4. 底部栏那套清干净了 ===');
for (const dead of ['id="memBar"', 'mem-bar-card', '.mem-bar{', 'mbSub-']) {
  eq(html.split(dead).length - 1, 0, dead + ' 已清零');
}
ok(!/#memoryPanel \.settings-scroll\{ padding-bottom[^}]*108px/.test(html),
  '★ 不再给底部栏垫 108px 的下内边距（否则内容底部永远空一块）');
ok(/\.mem-tabs\{/.test(html) && /\.mem-tab\.on\{/.test(html) && /\.mem-crumb\{/.test(html),
  '新的 .mem-tabs / .mem-tab.on / .mem-crumb 都在');
ok(/function memNavSync\(\)/.test(html) && !/function memBarSync\(/.test(html), 'memBarSync 已随底部栏一起改名');
/* ★ 面包屑的**文案**写在 HTML 里（memShowPage 只管显隐），所以这条只能在静态段验 ——
   放進假 DOM 段去读 textContent 永远读到空串（那是测试自己构造的元素）。 */
ok(html.includes('id="memCrumb" type="button">‹ 全部</button>'), '面包屑的文案是「‹ 全部」');

/* ══════════════════════════════════════════════════════════════════════════
   第二段：假 DOM 真跑 memShowPage（切页 / tab 高亮 / 面包屑 / 触发加载）
   ────────────────────────────────────────────────────────────────────────── */
console.log('\n=== 5. 假 DOM：memShowPage 真的在切页、并把"我在哪"标出来 ===');

function mkEl(tag) {
  const set = new Set();
  const el = {
    tagName: String(tag || 'div').toUpperCase(), dataset: {}, textContent: '', style: {},
    attrs: {}, _on: {},
    classList: {
      add(...c) { c.forEach((x) => set.add(x)); },
      remove(...c) { c.forEach((x) => set.delete(x)); },
      contains(c) { return set.has(c); },
      toggle(c, f) { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on; },
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k] !== undefined ? el.attrs[k] : null; },
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; },
  };
  return el;
}

function harness() {
  const PAGES = ['overview', 'all', 'archive', 'palace', 'near', 'pending', 'timeline', 'haven', 'worldbook'];
  const pages = PAGES.map((k) => { const e = mkEl(); e.dataset.mp = k; if (k !== 'overview') e.classList.add('hidden'); return e; });
  const tabs = ['overview', 'all'].map((k) => { const e = mkEl('button'); e.dataset.memTab = k; if (k === 'overview') e.classList.add('on'); return e; });
  const cards = ['palace', 'near', 'haven', 'worldbook', 'archive', 'pending', 'timeline'].map((k) => { const e = mkEl('button'); e.dataset.mpGo = k; return e; });
  const crumb = mkEl('button'); crumb.classList.add('hidden');
  const panel = mkEl();
  panel.querySelectorAll = (sel) => {
    if (sel === '.mem-page') return pages;
    if (sel === '.mem-tab') return tabs;
    if (sel === '[data-mp-go]') return cards;
    return [];
  };
  const calls = { br: 0, tl: 0, pd: 0, arc: 0, pack: [] };
  const sandbox = {
    console,
    document: { querySelector: (sel) => (sel === '#memoryPanel' ? panel : (sel === '#memCrumb' ? crumb : null)) },
    $: (sel) => (sel === '#memoryPanel' ? panel : (sel === '#memCrumb' ? crumb : null)),
    brLoad: () => { calls.br++; },
    tlLoad: () => { calls.tl++; },
    pdLoad: () => { calls.pd++; },
    arcRender: () => { calls.arc++; },
    memPackRender: (page, sel) => { calls.pack.push([page, sel]); },
  };
  sandbox.window = sandbox;
  const a = html.indexOf('function memShowPage(key){');
  const b = html.indexOf('function memNavSync(){');
  ok(a > 0 && b > a, '在 index.html 里抠得出 memShowPage');
  const ctx = vm.createContext(sandbox);
  vm.runInContext(html.slice(a, b) + '\n; globalThis.__t = { memShowPage };', ctx, { filename: 'memnav.js' });
  return { api: ctx.__t, pages, tabs, cards, crumb, calls, panel };
}

let H;
try { H = harness(); ok(!!H.api, 'memShowPage 在假 DOM 里跑起来了'); }
catch (e) { ok(false, 'memShowPage 跑不起来', String((e && e.message) || e)); }

if (H && H.api) {
  const { api, pages, tabs, cards, crumb, calls } = H;
  const shown = () => pages.filter((p) => !p.classList.contains('hidden')).map((p) => p.dataset.mp);
  const tabOn = () => tabs.filter((t) => t.classList.contains('on')).map((t) => t.dataset.memTab);

  eq(shown(), ['overview'], '初始只显示总览');
  eq(tabOn(), ['overview'], '初始高亮「总览」');
  ok(crumb.classList.contains('hidden'), '初始面包屑是藏着的');

  api.memShowPage('all');
  eq(shown(), ['all'], '点「全部」→ 只显示卡片页');
  eq(tabOn(), ['all'], 'tab 跟着高亮「全部」');
  ok(crumb.classList.contains('hidden'), '★ 卡片页自己不显示面包屑（不然会有一条多余的「‹ 全部」）');

  api.memShowPage('archive');
  eq(shown(), ['archive'], '点「档案馆」卡片 → 进那一页');
  eq(tabOn(), ['all'], '★ tab 仍停在「全部」（二级页算在它底下，不是第三个 tab）');
  ok(!crumb.classList.contains('hidden'), '★ 二级页显示面包屑（能回去）');
  eq(cards.filter((c) => c.classList.contains('on')).map((c) => c.dataset.mpGo), ['archive'],
    '刚才点的那张卡片高亮（知道自己从哪进来的）');
  ok(calls.arc >= 1 && calls.pack.some((p) => p[0] === 'archive'), '★ 切过去时顺手刷了档案馆那两屏');
  eq(tabs[1].getAttribute('aria-selected'), 'true', '无障碍：选中的 tab aria-selected=true');
  eq(tabs[0].getAttribute('aria-selected'), 'false', '没选中的是 false');

  for (const [k, who] of [['haven', 'br'], ['timeline', 'tl'], ['pending', 'pd']]) {
    const before = calls[who];
    api.memShowPage(k);
    eq(calls[who], before + 1, '★ 切到「' + k + '」会触发它自己的异步加载（否则永远空壳）');
    ok(!crumb.classList.contains('hidden'), '二级页（' + k + '）面包屑可见');
  }

  api.memShowPage('worldbook');
  ok(calls.pack.some((p) => p[0] === 'worldbook' && p[1] === '#memWbMount'),
    '世界书页交给 memory-pack 画（挂到 #memWbMount）');

  api.memShowPage('总览');            // 认不出的 key
  eq(shown(), ['overview'], '认不出的 key 回落到总览（不静默停在半路）');
  ok(crumb.classList.contains('hidden'), '回总览后面包屑收起');

  api.memShowPage('near');
  api.memShowPage('all');
  ok(crumb.classList.contains('hidden'), '从二级页点回「全部」→ 面包屑收起');
  eq(shown(), ['all'], '回到卡片页');
}

console.log('\n──────────────────────────────');
console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
process.exit(FAIL ? 1 : 0);
