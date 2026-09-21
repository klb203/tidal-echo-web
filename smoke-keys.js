/*
 * 网关卡「直接填令牌」自检 —— 用法：node smoke-keys.js [index.html]
 *
 * 用户的原话：「把这些变成直接填token的在前端 麦当劳 · 瑞幸咖啡 · 高德地图 · 小红书 · 查手机」
 *
 * 改前那 5 张卡点开只有一句 toast：「还没接上 —— 在「MCP 设置」里配好 token」，
 * 然后把人送到另一个页面去找一张叫 mcp 的卡。五样东西五条绕路。
 *
 * node --check 抓不到的坏法（这一类改动全中过）：
 *   · 前端自己判断"这个令牌存哪" → 后端换落点，前端悄悄存到废地方
 *   · 凭据状态读了两处 → 卡片说"填了"、点开是空的
 *   · 状态还没拉回来就当成"没填" → 刚打开网关五张卡先全灭再亮，第一眼像坏了
 *   · 保存完不刷新状态 → 填了、显示还是"没填"（用户会再填一遍）
 *   · 令牌回显到界面上（GET 本来就故意不回显）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

let PASS = 0, FAIL = 0;
const PENDING = [];        /* 异步断言先攒着 —— 不等完就统计 = 假绿 */
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
function fnBlock(text, sig) {
  const i = text.indexOf(sig);
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') { depth++; started = true; }
    else if (text[j] === '}') { depth--; if (started && depth === 0) return text.slice(i, j + 1); }
  }
  return '';
}

/* ── 1. 五张卡都挂上了凭据键，键名与后端那张表一致 ─────────────────────── */
console.log('=== 1. 五项外部服务都挂上了凭据键 ===');
const ability = arrBlock(html, 'const CAP_ABILITY = [');
ok(ability.length > 0, '找得到 CAP_ABILITY');
const CREDS = ['mcd', 'luckin', 'amap', 'xhs', 'phone'];
for (const k of CREDS) {
  ok(new RegExp('cred:\\s*"' + k + '"').test(ability),
    '★ 「' + k + '」有 cred 键（= 这张卡点开能直接填令牌）');
}
/* 键名就是后端 bots.EXT_CRED 里的那个 —— 前端不另起名字 */
const credKeys = [...ability.matchAll(/cred:\s*"(\w+)"/g)].map((m) => m[1]).sort();
eq(credKeys, [...CREDS].sort(), '凭据键恰好是这五个（不多不少）');
ok(/cred:\s*"phone"/.test(ability) && /k:\s*"device"/.test(ability),
  '★ 查手机那张卡的 cred 是 phone（能力 key 叫 device，但后端服务名是 phone —— 两个名字各指各的）');

/* ── 2. 读 / 存 / 试各只有一处，落点由后端说 ─────────────────────────── */
console.log('\n=== 2. 读 / 存 / 试各只有一处 ===');
eq(html.split('function capCredOf(').length - 1, 1, 'capCredOf 只定义一次（读状态的唯一入口）');
eq(html.split('function capCredApply(').length - 1, 1, 'capCredApply 只定义一次');
eq(html.split('async function capCredSave(').length - 1, 1, 'capCredSave 只定义一次');
eq(html.split('async function capCredProbe(').length - 1, 1, 'capCredProbe 只定义一次');
eq([...html.matchAll(/\/app\/extools\/keys/g)].length, 2, '★ 只跟 /app/extools/keys 打交道（一次读一次写）');
/* ★ 前端**不该**自己去写 /app/mcp/config —— 哪个服务存哪是后端那张表的事 */
const saveBlk = fnBlock(html, 'async function capCredSave(');
ok(saveBlk.length > 0 && !/\/app\/mcp\/config/.test(saveBlk),
  '★ 前端不自己判断"存哪"（不出现 /app/mcp/config）—— 落点由后端 bots.EXT_CRED 说');
ok(/\/app\/extools\/keys/.test(saveBlk), '保存走 /app/extools/keys');

/* ── 3. 状态拉回来时带上凭据 ─────────────────────────────────────────── */
console.log('\n=== 3. 状态一起拉回来 ===');
const loadBlk = fnBlock(html, 'async function capLoad(force){');
ok(/\[\s*"keys"\s*,\s*"\/app\/extools\/keys"\s*\]/.test(loadBlk),
  '★ capLoad 里带了 keys（不单独再跑一趟）');
ok(/Promise\.allSettled/.test(loadBlk), '仍然用 allSettled（一项失败不影响别的）');

/* ── 4. 判定：没令牌就是"还没接上"，但状态没回来时不判 ───────────────── */
console.log('\n=== 4. 判定接上凭据 ===');
const abBlk = fnBlock(html, 'function capAbilityOf(a){');
ok(/a\.cred/.test(abBlk), '判定里认 cred');
ok(/if\s*\(c\s*&&\s*!c\.has_token\)/.test(abBlk),
  '★ 只有拿到凭据状态（c 非空）才判"没填" —— 状态没回来时不判，'
  + '否则刚打开网关五张卡会先全灭再亮');
ok(/还没填令牌/.test(abBlk), '文案直说「还没填令牌」');
ok(/点开填/.test(abBlk), '★ 文案指向"点开这张卡"（不再把人送去 MCP 设置）');

/* ── 5. 有凭据的卡不把人送去别处 ─────────────────────────────────────── */
console.log('\n=== 5. 有凭据的卡不再绕路 ===');
ok(/if\s*\(!a\.cred\s*&&\s*!st\.tools\.length\)/.test(html),
  '★ 跳去 MCP 设置那条路**只对没有凭据的卡**成立');
const openBlk = fnBlock(html, 'function capOpenAb(a){');
ok(openBlk.length > 0, '点开抽成了 capOpenAb（点击与"保存后重开"共用一份）');
ok(/capCredForm\(a,\s*c\)/.test(openBlk), 'capOpenAb 里有凭据表单');
ok(/capIcon\("bolt"\)/.test(openBlk), '工具明细那段也还在（有工具时才列）');
/* ★ 口径：定义带 `function ` 前缀、调用不带 —— 混成一个模式去数只会得到 1（假红）。
   定义必须恰好一处；调用至少两处（点击一次、保存后重开一次）。 */
eq(html.split('function capOpenAb(').length - 1, 1, 'capOpenAb 只定义一次');
ok(html.split('capOpenAb(a)').length - 1 >= 2,
  '调用处至少两处：点击 / 保存后重开  ← ' + (html.split('capOpenAb(a)').length - 1));

/* ── 6. 表单：字段与文案由后端给 ─────────────────────────────────────── */
console.log('\n=== 6. 表单字段与文案从后端来 ===');
const formBlk = fnBlock(html, 'function capCredForm(a, c){');
ok(formBlk.length > 0, '找得到 capCredForm');
ok(/token_label/.test(formBlk), '★ 输入框的提示语用后端的 token_label（前端不抄一份）');
ok(/token_hint/.test(formBlk), '说明用后端的 token_hint');
ok(/url_locked/.test(formBlk), '★ 地址被锁的（高德，key 拼在 url 里）只显示、不给改');
ok(/data-cap-cred-save/.test(formBlk) && /data-cap-cred-test/.test(formBlk),
  '有「保存」与「测试握手」两个键');
ok(/留空 = 不改/.test(formBlk), '★ 提示了"留空 = 不改"（GET 不回显，输入框本来就是空的）');
ok(/id="capCredTok"/.test(html) && /id="capCredUrl"/.test(html),
  '输入框的 id 都在（保存时按 id 取值）');
eq([...html.matchAll(/id="capCredTok"/g)].length, 1, '★ capCredTok 全文只出现一次（不重复 id）');

/* ── 7. 保存后状态跟着变，且把表单再摊开 ─────────────────────────────── */
console.log('\n=== 7. 保存完那一下 ===');
ok(/capCredApply\(d\)/.test(html), '保存成功后把返回的凭据覆盖进状态（不用再拉十二个请求）');
ok(/CAP_REOPEN/.test(html), '★ 记住了"刚才开着哪张卡"');
ok(/function capReopen\(/.test(html), '重渲染后自己再摊开一次（不然填完表单就没了）');
ok(/inPanel/.test(html), '网关不在台面上时就不重开了（省得在别的页上乱摊）');

/* ── 8. 样式 ─────────────────────────────────────────────────────────── */
console.log('\n=== 8. 样式 ===');
for (const cls of ['.cap-cred{', '.cap-cred-url{', '.cap-cred-btns{', '.cap-cred-note{']) {
  ok(html.includes(cls), 'CSS 里有 ' + cls);
}
ok(html.includes('.cap-cred-lock{') && html.includes('.cap-ok{'), '锁地址的提示与成功/失败色都在');

/* ── 9. 假 DOM：真跑读状态、判定、保存、探针 ─────────────────────────── */
console.log('\n=== 9. 假 DOM：真跑一遍 ===');
const need = [
  fnBlock(html, 'function capDig(obj, path, dflt){'),
  fnBlock(html, 'function capCredOf(key){'),
  fnBlock(html, 'function capCredApply(d){'),
  fnBlock(html, 'function capCredSrcText(c){'),
  fnBlock(html, 'function capCredForm(a, c){'),
  fnBlock(html, 'async function capCredSave(key, token, url){'),
  fnBlock(html, 'async function capCredProbe(a){'),
  fnBlock(html, 'function capAbilityOf(a){'),
  fnBlock(html, 'function capOpenAb(a){'),
];
ok(need.every((b) => b.length > 0), '九个片段都抠出来了：' + need.map((b) => b.length).join('/'));

function harness(opts) {
  const o = opts || {};
  const calls = [];
  const box = { innerHTML: '' };
  const sandbox = {
    console,
    CAP_STATE: { data: {} },
    document: { querySelector: () => box },
    $: () => box,                        /* capOpenAb 用 $("#capAbBox") 取盒子 */
    escapeHtml: (s) => String(s == null ? '' : s),
    capIcon: () => '',
    showToast: () => {},
    memApi: async (p, opt) => {
      calls.push({ path: p, opt: opt || null });
      if (o.memApi) return o.memApi(p, opt, calls);
      return { ok: true };
    },
  };
  if ('keys' in o) sandbox.CAP_STATE.data.keys = o.keys;
  if ('tools' in o) sandbox.CAP_STATE.data.tools = o.tools;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(need.join('\n') + `
    ; globalThis.__api = { capCredOf, capAbilityOf, capCredSave, capCredForm,
                           capCredSrcText, capCredApply, capCredProbe, capOpenAb };
    globalThis.__box = (document.querySelector() ) ;`, ctx);
  return { api: ctx.__api, box, calls, ctx };
}

const CRED_ROWS = [
  { key: 'mcd', label: '麦当劳', way: 'preset', token_label: '麦当劳 MCP 令牌',
    token_hint: '麦当劳开放平台 → MCP 服务', has_token: false, token_src: '', url: '', url_locked: true },
  { key: 'amap', label: '高德地图', way: 'server', token_label: '高德 Web 服务 Key',
    token_hint: 'lbs.amap.com 添加 Key', has_token: false, token_src: '',
    url: 'https://mcp.amap.com/sse', url_locked: true },
  { key: 'xhs', label: '小红书', way: 'server', token_label: '小红书 MCP 令牌',
    token_hint: '第三方服务给的', has_token: false, token_src: '',
    url: '', url_locked: false, url_hint: 'https://对方给的地址/mcp' },
];

let H;
try { H = harness({ keys: { ok: true, creds: CRED_ROWS }, tools: { tools: {}, denied: [] } }); ok(!!H.api, '模块在假环境里跑起来了'); }
catch (e) { ok(false, '模块跑不起来', String((e && e.message) || e)); }

if (H && H.api) {
  const { capCredOf, capAbilityOf, capCredSave, capCredForm, capCredSrcText, capCredApply } = H.api;

  /* 读 */
  eq(capCredOf('mcd').label, '麦当劳', 'capCredOf 取得到那一项');
  eq(capCredOf('nope'), null, '没有这项 → null（不抛）');
  eq(capCredOf(''), null, '空 key → null');
  const H2 = harness({});
  eq(H2.api.capCredOf('mcd'), null, '★ keys 还没拉回来 → null（不是"没有"）');

  /* 判定 */
  eq(capAbilityOf({ k: 'mcd', src: 'mcp', cred: 'mcd', match: ['mcd'] }).ok, false,
    '★ 没填令牌 → 不亮');
  ok(/还没填令牌/.test(capAbilityOf({ k: 'mcd', src: 'mcp', cred: 'mcd', match: ['mcd'] }).text),
    '文案是「还没填令牌」');
  eq(H2.api.capAbilityOf({ k: 'mcd', src: 'mcp', cred: 'mcd', match: ['mcd'] }).text, '后端还没回话',
    '★ 状态没回来时走的是原来的「后端还没回话」—— 不冤判成"没填"');

  const H3 = harness({
    keys: { ok: true, creds: [
      { key: 'mcd', way: 'preset', has_token: true, token_src: 'user', token_label: 'x', url_locked: true },
    ] },
    tools: { tools: { 'mcd.available-coupons': '查券' }, denied: [] },
  });
  const r3 = H3.api.capAbilityOf({ k: 'mcd', src: 'mcp', cred: 'mcd', match: ['mcd'] });
  eq(r3.ok, true, '★ 填了令牌 + 后端报了这个服务的工具 → 亮');
  eq(r3.tools, ['mcd.available-coupons'], '并把背后的工具列出来');
  const H4 = harness({
    keys: { ok: true, creds: [{ key: 'mcd', way: 'preset', has_token: true, token_label: 'x' }] },
    tools: { tools: {}, denied: [] },
  });
  eq(H4.api.capAbilityOf({ k: 'mcd', src: 'mcp', cred: 'mcd', match: ['mcd'] }).text, '还没接',
    '填了令牌但后端没报工具 → 「还没接」（两件事都要成立）');
  /* 不带 cred 的老卡不受影响（回归） */
  eq(H3.api.capAbilityOf({ k: 'w', src: 'tool', match: ['weather'] }).ok, false,
    '内置工具类（没 cred）判定不受这次改动影响');

  /* 保存 —— 这一组是异步的：断言收进 PENDING，最后一起等完再统计。
     ★ 不等的话它们会在进程退出后才跑，等于没跑，而且统计里根本没算它们 ——
       这种假绿比红更坏（第一次写这一组就是这样）。 */
  const H5 = harness({
    keys: { ok: true, creds: [{ key: 'amap', way: 'server', has_token: false, url_locked: true }] },
    memApi: (p, o) => Object.assign({ ok: true }, JSON.parse(o.body)),
  });
  PENDING.push(H5.api.capCredSave('amap', 'my-key', '').then((sent) => {
    eq(sent.key, 'amap', '保存的请求体带 key');
    eq(sent.token, 'my-key', '带 token');
    eq(sent.url, '', '地址留空也照发（后端有它自己的）');
    eq(H5.calls[0].path, '/app/extools/keys', '打到 /app/extools/keys');
    eq(H5.calls[0].opt.method, 'POST', '是 POST');
  }));
  const H5b = harness({ keys: { ok: true, creds: [] }, memApi: (p, o) => Object.assign({ ok: true }, JSON.parse(o.body)) });
  H5b.api.capCredSave('xhs', 'tk', 'https://x.example/mcp');
  eq(H5b.calls[0].path, '/app/extools/keys', '★ 保存只有这一个口（server 型也不另找接口）');

  /* 保存失败要**抛**，不能静默 */
  const H6 = harness({ keys: { ok: true, creds: [] }, memApi: () => ({ ok: false, error: '这个名字不认识' }) });
  PENDING.push(H6.api.capCredSave('nope', 't', '').then(
    () => ok(false, '★ 后端回 ok:false 时应该抛错（不然界面以为成功了）'),
    (e) => ok(/不认识/.test(String(e && e.message)), '★ 后端的错误话原样带出来：' + e.message)
  ));

  /* 保存后状态跟着变 */
  const H7 = harness({ keys: { ok: true, creds: [{ key: 'mcd', has_token: false, way: 'preset', token_label: 'x' }] } });
  H7.api.capCredApply({ ok: true, creds: [{ key: 'mcd', has_token: true, way: 'preset', token_src: 'user', token_label: 'x' }] });
  eq(H7.api.capCredOf('mcd').has_token, true, '★ capCredApply 之后读到的就是新的（填了不用再拉十二个请求）');

  /* 来源文案 */
  eq(capCredSrcText({ token_src: 'user', has_token: true }), '已填', '来源文案：已填');
  ok(/环境变量/.test(capCredSrcText({ token_src: 'env', has_token: true })),
    '来源文案能区分"环境变量里的"（Render 上那份）');
  eq(capCredSrcText({ has_token: false }), '还没填', '来源文案：还没填');

  /* 表单渲染 */
  const f1 = capCredForm({ k: 'amap', n: '高德地图', ic: '◈', cred: 'amap' }, CRED_ROWS[1]);
  ok(/cap-cred-url/.test(f1), '★ 地址被锁 → 只显示地址（不给输入框）');
  ok(!/id="capCredUrl"/.test(f1), '锁定时**不出** url 输入框');
  ok(/mcp\.amap\.com/.test(f1), '把固定地址显示出来');
  ok(/高德 Web 服务 Key/.test(f1), '提示语用后端的 token_label');
  const f2 = capCredForm({ k: 'xhs', n: '小红书', ic: '▤', cred: 'xhs' }, CRED_ROWS[2]);
  ok(/id="capCredUrl"/.test(f2), '★ 没锁的（小红书）给 url 输入框');
  ok(/https:\/\/对方给的地址\/mcp/.test(f2), '用后端的 url_hint 当占位提示');
  const f3 = capCredForm({ k: 'mcd', n: '麦当劳', ic: '☰', cred: 'mcd' }, null);
  ok(f3.length > 0 && /麦当劳 令牌/.test(f3), '凭据状态还没回来时也有兜底文案（不空着）');

  /* 点开一张卡：表单真的进去了 */
  const H8 = harness({ keys: { ok: true, creds: CRED_ROWS }, tools: { tools: {}, denied: [] } });
  H8.api.capOpenAb({ k: 'mcd', n: '麦当劳', s: '点单', ic: '☰', src: 'mcp', cred: 'mcd', match: ['mcd'] });
  ok(/凭据/.test(H8.box.innerHTML), '★ 点开麦当劳那张卡 → 摊开的是**凭据表单**');
  ok(/data-cap-cred-save/.test(H8.box.innerHTML), '表单里有保存键');
  ok(/填好令牌并保存/.test(H8.box.innerHTML), '还没接上时给一句"填好保存"的引导');
}

/* ★ 统计要等完异步断言。不等的话那几条会在进程退出后才跑 ——
   等于没跑，而且看不出来（统计里根本没计它们）。比红更坏的是这种假绿。 */
Promise.allSettled(PENDING).then(() => {
  console.log('\n──────────────────────────────');
  console.log(`通过 ${PASS} 项，失败 ${FAIL} 项`);
  process.exit(FAIL ? 1 : 0);
});
