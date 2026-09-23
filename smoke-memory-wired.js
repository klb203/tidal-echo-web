/*
 * 记忆面板「接线」自检 —— 用法：node smoke-memory-wired.js [index.html]
 *
 * 为什么单独写一个：v134 上线时漏了 `memApi`（它跟下线的时间线 tl* 挨着，
 * 被同一次清理一起带走了），症状是面板里一行红字「读取失败：memApi is not defined」——
 * 而当时 **19 个冒烟全绿**。为什么全绿？因为每个测试都用**自己的桩**：
 * smoke-memlib.js 里就有一份 `var memApi = async (...) => {...}`。
 * 桩越像真的，越测不出"真实的那一份没了"。
 *
 * 所以这个测试**不抠代码段、不给主机函数打桩**：
 *   ① 整份 HTML 真加载（runScripts: dangerously）—— 脚本真跑一遍；
 *   ② 然后问：这些函数在不在？这些元素在不在？
 *   ③ 反射式地扫一遍：记忆面板那几段里 `$("#xxx")` 提到的 id，HTML 里必须都有
 *      （这条抓的就是"删了元素、JS 还在引用"）。
 *
 * 它不管"算得对不对"（那是 smoke-memlib / smoke-day 的事），只管**零件齐不齐**。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = process.argv[2] || path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errs.push(String((e && e.message) || e).slice(0, 200)));
vc.on('error', (...a) => errs.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));

const dom = new JSDOM(html, {
  url: 'https://klb203.github.io/tidal-echo-web/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    /* 环境缺件要补，否则宿主脚本一开头就抛错、后面全不执行（会全绿假象）。 */
    win.matchMedia = win.matchMedia || function () {
      return { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    };
    if (typeof win.fetch !== 'function') {
      win.fetch = () => Promise.resolve({
        ok: false, status: 503,
        json: () => Promise.resolve({ error: { message: '（接线自检的桩）后端不可达' } }),
        text: () => Promise.resolve(''), body: null,
      });
    }
    win.HTMLCanvasElement.prototype.getContext = function () {
      const g = { addColorStop() {} };
      return new Proxy({}, {
        get(_, k) {
          if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => g;
          if (k === 'measureText') return () => ({ width: 0 });
          if (k === 'getImageData') return () => ({ data: [] });
          return typeof k === 'string' ? function () {} : undefined;
        },
        set() { return true; },
      });
    };
  },
});
const w = dom.window, d = w.document;

(async () => {
  await sleep(900);

  console.log('【0. 加载】');
  ok(!errs.length, '整份 HTML 加载期无错误' + (errs.length ? '：' + errs[0] : ''));

  console.log('\n【1. 记忆面板要用到的函数，一个都不能少】');
  /* 名单来自"面板真会调的路径"：打开 → 取数 → 画画 → 三个页各自的入口。
     ★ 加新功能时记得把新函数加进来 —— 这份名单就是"漏一个就红"的清单。 */
  const NEED_FN = [
    'openMemory', 'closeMemory', 'buildMemNav', 'memShowPage', 'memNavSync',
    'memLoad', 'memApi', 'memStatus',
    'renderNearfield', 'nfLabel', 'memOpenDay', 'memRun', 'memSaveDay',
    'memDeleteDay', 'memAssemble', 'memMonth',
    'mlLoad', 'mlRender', 'mlSave', 'mlDelete', 'mlEditOpen', 'mlTidy',
    'mlTierOf', 'mlSourceLabel',
    'brLoad', 'brRender', 'brSearch',
    'escapeHtml', 'appUrl', 'authHeaders',
  ];
  const missFn = NEED_FN.filter((f) => typeof w[f] !== 'function');
  ok(missFn.length === 0, '全部在（' + NEED_FN.length + ' 个）' + (missFn.length ? '　缺：' + missFn.join('、') : ''));

  console.log('\n【2. 三页用到的元素，一个都不能少】');
  const NEED_EL = [
    'memoryPanel', 'memTabs', 'memoryBack', 'memoryClose',
    'mlCard', 'mlList', 'mlQ', 'mlCount', 'mlTabs', 'mlEdit', 'mlBody',
    'mlKw', 'mlReason', 'mlTier', 'mlImp', 'mlUnres', 'mlSaveBtn',
    'mlNew', 'mlTidy', 'mlRefresh', 'mlStatus',
    'nfDays', 'nfDay', 'nfCurrent', 'nfRun', 'nfTarget', 'nfAssemble',
    'nfMonth', 'nfRefresh', 'nfSaveDay', 'nfDeleteDay', 'nfStatus', 'cardSubNear',
    'brainCard', 'brList', 'brQ', 'brFoot', 'brStats',
  ];
  const missEl = NEED_EL.filter((id) => !d.getElementById(id));
  ok(missEl.length === 0, '全部在（' + NEED_EL.length + ' 个）' + (missEl.length ? '　缺：' + missEl.join('、') : ''));

  console.log('\n【3. 反射：面板代码里引用的 id，HTML 里必须都有】');
  /* ★ 这条抓的是"删了元素、JS 还在引用" —— 也就是 v133 → v134 那次
     `palacePanel` 崩溃的同一类错。范围限定在**保留下来的**那几段代码里，
     所以检出的缺失都是真问题（下线的页面的代码已经删干净了）。 */
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const SEGS = [
    ['记忆库段', '/* ════════════ 记忆库（AionsHome', 'const IG_KEY = "companion_image_gen";'],
    ['近景段', '/* ── 近景七天：把 /app/nearfield', 'if ($("#memoryBack"))'],
  ];
  let allMissing = [];
  for (const [name, a, b] of SEGS) {
    const i = html.indexOf(a);
    if (i < 0) { ok(false, name + ' 的起点锚点没找到（锚点变了？）'); continue; }
    let j = html.indexOf(b, i);
    if (j < 0) j = Math.min(html.length, i + 60000);
    const seg = html.slice(i, j);
    const used = [...new Set([...seg.matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]))];
    const miss = used.filter((x) => !ids.has(x));
    allMissing = allMissing.concat(miss.map((x) => name + ':#' + x));
    ok(miss.length === 0, name + ' 里引用的 ' + used.length + ' 个 id 都有对应元素'
       + (miss.length ? '　缺：' + miss.join('、') : ''));
  }

  console.log('\n【4. 真调一次：近景画得出来吗】');
  w.eval(`
    memData.status = { days: [{ date: "2026-09-22", chars: 120 }, { date: "2026-09-21", chars: 80 }],
                       today: "2026-09-23", yesterday: "2026-09-22", max_days: 7,
                       quota: [480, 280, 200, 140, 100, 80, 60], model: "gemini-3.1-flash-lite",
                       tz_offset: 8, months: [] };
    memData.current = "我在海边坐了一会儿。";
  `);
  w.renderNearfield();
  const chips = d.getElementById('nfDays').innerHTML;
  ok(/nf-chip/.test(chips), '七天胶囊画出来了');
  ok(/昨天/.test(chips) && /2 天前/.test(chips), '日期标签走的是 nfLabel（今天/昨天/N 天前）');
  ok(/我在海边坐了一会儿/.test(d.getElementById('nfCurrent').textContent), '注入稿那一段有内容');
  ok(/天/.test(d.getElementById('nfStatus').textContent), '状态行写上了近景参数：'
     + d.getElementById('nfStatus').textContent.slice(0, 40));

  console.log('\n【5. 真调一次：记忆库渲染（空库不炸）】');
  w.eval('mlData.items = []; mlData.filter = "all";');
  w.mlRender();
  ok(/还没有内容|arc-empty/.test(d.getElementById('mlList').innerHTML), '空库时列表区有占位文案');

  console.log('\n──────────────────────────────');
  console.log('通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项');
  process.exit(FAIL ? 1 : 0);
})();
