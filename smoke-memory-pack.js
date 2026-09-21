/*
 * memory-pack.js 冒烟测试 —— 用法：node smoke-memory-pack.js [memory-pack.js]
 *
 * 为什么要有它：这一页全是**编辑器**（世界书的十来个字段、事件盒的复活/归档/
 * 封盒/压缩）。这类错 node --check 一个都抓不到：
 *   · 表单字段连错（位置的下拉接到了深度上）→ 存进去的东西静默变形
 *   · 保存时把数组当字符串发、把数字发成字符串 → 后端 normalize 会救，但语义会偏
 *   · 归盒时把**已经归过盒的** id 又送一遍 → 盒里重复、甚至把灰节点拽回活节点
 *   · 封盒按钮发成 unseal → 点了没反应（或反过来把盒锁死）
 *
 * 做法：一个够用的假 DOM + 一个记录 URL 与请求体的假 api。验的是**状态层与请求路由**，
 * 不是渲染好不好看。渲染结果只做"关键串在不在"的粗验（那能抓住字段接错）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PACK = process.argv[2] || path.join(__dirname, 'memory-pack.js');
const code = fs.readFileSync(PACK, 'utf8');

let PASS = 0, FAIL = 0;
function ok(cond, msg, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ ' + msg + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }

/* ── 够用的假 DOM ─────────────────────────────────────────────────────── */
function makeEl(id) {
  const cls = new Set(), ls = {}, q = {};
  const el = {
    id: id || "", dataset: {}, style: {}, _html: "", _q: q,
    addEventListener(t, fn) { (ls[t] = ls[t] || []).push(fn); },
    _fire(t, ev) { (ls[t] || []).slice().forEach((f) => f(ev)); },
    _listeners: ls,
    querySelector(sel) { return q[sel] || null; },
    querySelectorAll() { return []; },
    classList: {
      add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); },
      toggle(c, f) { const on = (f === undefined) ? !cls.has(c) : !!f; if (on) cls.add(c); else cls.delete(c); return on; },
    },
    _cls: cls,
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; }, set(v) { el._html = String(v); },
  });
  return el;
}
/* 表单字段：pack 用 .value 读文本、.checked 读勾选 */
function setField(host, name, value) {
  host._q['[data-wbf="' + name + '"]'] = { value: value, checked: !!value };
}
/* 点击目标：只在 map 里有那个选择器时才"命中" */
function tgt(map) {
  return { closest: (sel) => (sel in map) ? { dataset: map[sel] || {} } : null };
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 8); i++) await tick(); }

/* ── 起一个沙盒：注入宿主接口 + 假 api ─────────────────────────────────── */
function boot(hostOverride, responses) {
  const els = {
    memWbMount: makeEl("memWbMount"),
    arcBoxes: makeEl("arcBoxes"),
    arcTimeline: makeEl("arcTimeline"),
  };
  const calls = [];
  const base = {
    esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    toast: () => { },
    api: async (p, o) => {
      calls.push({
        path: p, method: (o && o.method) || "GET",
        body: (o && o.body) ? JSON.parse(o.body) : null,
      });
      const r = (responses || {})[p];
      if (typeof r === "function") return r();
      return (r === undefined) ? { ok: true } : r;
    },
    libItems: {}, layers: null, aiName: "", arcRender: null, reload: null,
  };
  Object.assign(base, hostOverride || {});
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, RegExp, Boolean,
    isFinite, parseInt, parseFloat, Promise, Error, Set,
    setTimeout: () => 0, clearTimeout: () => { },
    Blob: function () { }, URL: { createObjectURL: () => "", revokeObjectURL: () => { } },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => makeEl(), body: makeEl(),
    },
    confirm: () => true, prompt: () => "改过的新名字",
  };
  sb.window = sb;
  sb.window.__MEMORY_PACK_HOST = base;
  vm.createContext(sb);
  vm.runInContext(code, sb);
  return { MP: sb.window.MemoryPack, els, calls, host: base, sb };
}

/* ── 夹具：像真接口那样的一坨数据 ─────────────────────────────────────── */
const WB_FIX = {
  ok: true,
  items: [
    { id: "a1", title: "我的房间", content: "朝东的小屋，窗台有薄荷。", category: "我的房间",
      key: [], keysecondary: [], constant: true, selective: false, selectiveLogic: 0,
      order: 50, position: 1, disable: false, probability: 100, useProbability: false,
      depth: 4, role: 0, scanDepth: 4, caseSensitive: false, matchWholeWords: false },
    { id: "a2", title: "咖啡口味", content: "只喝生椰拿铁。", category: "通用设定",
      key: ["拿铁", "咖啡"], keysecondary: [], constant: false, selective: false, selectiveLogic: 0,
      order: 10, position: 1, disable: false, probability: 100, useProbability: false,
      depth: 4, role: 0, scanDepth: 4, caseSensitive: false, matchWholeWords: false },
    { id: "a3", title: "旧事", content: "很久以前那条。", category: "别的分组",
      key: ["旧"], keysecondary: [], constant: false, selective: false, selectiveLogic: 3,
      order: 900, position: 4, disable: true, probability: 30, useProbability: true,
      depth: 2, role: 1, scanDepth: 6, caseSensitive: true, matchWholeWords: true },
  ],
  stats: { total: 3, by_category: { "我的房间": 1, "通用设定": 1, "别的分组": 1 },
           constant: 1, keyword: 2, disabled: 1, chars: 42 },
  positionLabels: { "0": "角色设定前", "1": "角色设定后", "2": "作者注释顶部", "3": "作者注释底部",
                    "4": "聊天记录指定深度", "5": "示例消息前", "6": "示例消息后" },
  positionDescriptions: { "1": "适合一般世界观。" },
  roleLabels: { "0": "System", "1": "User", "2": "Assistant" },
  presetCategories: ["我的房间", "留给西西的话", "通用设定"],
  defaults: { category: "通用设定", key: [], keysecondary: [], constant: false, selective: false,
              selectiveLogic: 0, order: 100, position: 1, disable: false, probability: 100,
              useProbability: false, depth: 4, role: 0, scanDepth: 4,
              caseSensitive: false, matchWholeWords: false },
};

function box(over) {
  return Object.assign({
    id: "b1", name: "第一次去那家店", tags: [], summaryNodeId: "s1",
    live: ["n1", "n2"], archived: ["n3"], compressionCount: 1, sealed: false,
    predecessorBoxId: null, createdAt: 1, updatedAt: 2, lastCompressedAt: 3,
    nodes: {
      n1: { kind: "event", title: "订了位", content: "订了靠窗的位子。", ts: "2026-09-01T10:00:00", archived: false },
      n2: { kind: "fragment", title: "", content: "她说那家的面包好吃。", ts: "2026-09-01T12:00:00", archived: false },
      n3: { kind: "story", title: "旧的那次", content: "更早也去过一次。", ts: "2026-08-01T10:00:00", archived: true },
    },
    summary: "我们去过那家店，订了靠窗的位子。",
  }, over || {});
}
const BX_FIX = {
  ok: true, boxes: [box()],
  stats: { boxes: 1, sealed: 0, live: 2, archived: 1, compressed: 1, uncompressed: 0 },
  thresholds: { compress: 4, hardCap: 15, seal: 12 },
};

/* ══════════════════════════════════════════════════════════════════════ */
(async function main() {
  console.log('=== 1. 世界书：加载与列表 ===');
  {
    const { MP, els } = boot({}, { "/app/worldbook": WB_FIX });
    await MP.render("worldbook");
    const h = els.memWbMount._html;
    ok(h.includes("世界书"), "渲染出世界书页");
    ok(h.includes("3 条"), "头部显示总条数");
    ok(h.includes("1</b><span>常驻"), "统计格里有常驻数");
    ok(h.includes("42"), "统计格里有总字数");
    /* 排序：a2(order 10) → a1(50) → a3(900)。
       ★ 用 data-wb-open 定位，别用标题 —— "我的房间" 同时是**分组名**，
         用 indexOf 会命中上面的 chip，看着像"排序失效"。 */
    const i2 = h.indexOf('data-wb-open="a2"');
    const i1 = h.indexOf('data-wb-open="a1"');
    const i3 = h.indexOf('data-wb-open="a3"');
    ok(i2 > 0 && i1 > i2 && i3 > i1, "按 order 从小到大排（10 → 50 → 900）", { a1: i1, a2: i2, a3: i3 });
    ok(h.includes("常驻"), "常驻那条标了「常驻」");
    ok(h.includes("关键词 拿铁/咖啡"), "关键词那条列出前两个词");
    ok(h.includes("已停用"), "停用的那条标出来");
    ok(h.includes("聊天记录指定深度"), "位置显示成中文名（不是数字）");
  }

  console.log('\n=== 2. 世界书：分组 chips ===');
  {
    const { MP, els } = boot({}, { "/app/worldbook": WB_FIX });
    await MP.render("worldbook");
    const h = els.memWbMount._html;
    /* 预设分组即使**一条都没有**也要出 chip（用户得看得见"这一组是空的"，
       也才点得进去建第一条）。所以计数用各自真实的数。 */
    const chipWant = { "全部": 3, "我的房间": 1, "留给西西的话": 0, "通用设定": 1, "别的分组": 1 };
    for (const c of Object.keys(chipWant)) {
      ok(h.includes(">" + c + " · " + chipWant[c] + "<"), "分组 chip：" + c + "（" + chipWant[c] + " 条）");
    }
    const cats = MP._wbCats();
    eq(cats, ["我的房间", "留给西西的话", "通用设定", "别的分组"],
      "预设分组在前，自定义的补在后面（不丢）");
    /* 点一个分组 → 只列那一组 */
    els.memWbMount._fire("click", { target: tgt({ "[data-wb-cat]": { wbCat: "通用设定" } }) });
    await settle();
    const h2 = els.memWbMount._html;
    ok(h2.includes("咖啡口味"), "筛选后还有这一组的条目");
    ok(!h2.includes("朝东的小屋"), "别的组的正文不在列表里");
  }

  console.log('\n=== 3. 世界书：编辑器（字段不能接错）===');
  {
    const { MP, els } = boot({}, { "/app/worldbook": WB_FIX });
    await MP.render("worldbook");
    els.memWbMount._fire("click", { target: tgt({ "[data-wb-open]": { wbOpen: "a3" } }) });
    await settle();
    const h = els.memWbMount._html;
    ok(h.includes('data-wbf="title" value="旧事"'), "标题填进了表单");
    ok(h.includes("很久以前那条。"), "正文填进了表单");
    ok(h.includes('data-wbf="order" value="900"'), "顺序填进了表单");
    ok(h.includes('data-wbf="depth" value="2"'), "深度填进了表单（不是接到别处）");
    ok(h.includes('data-wbf="scanDepth" value="6"'), "扫描深度也各自就位");
    ok(/data-wbf="position">[\s\S]{0,600}?<option value="4" selected/.test(h),
      "位置下拉选中的是 4");
    ok(/data-wbf="role">[\s\S]{0,400}?<option value="1" selected/.test(h), "角色下拉选中的是 1");
    ok(/data-wbf="selectiveLogic">[\s\S]{0,900}?<option value="3" selected/.test(h),
      "选择性逻辑选中的是 3");
    ok(/data-wbf="probability" value="30"/.test(h), "概率填对");
    ok(/data-wbf="useProbability" checked/.test(h), "勾上了按概率触发");
    ok(/data-wbf="caseSensitive" checked/.test(h), "勾上了区分大小写");
    ok(/data-wbf="matchWholeWords" checked/.test(h), "勾上了整词匹配");
    ok(/data-wbf="disable" checked/.test(h), "勾上了停用");
    ok(h.includes("次词必须全部命中（NOT_ALL）"),
      "选择性逻辑的四个选项写的是**语义**，不是那个反着的英文名");
  }

  console.log('\n=== 4. 世界书：新建的默认值来自后端 ===');
  {
    const fix = JSON.parse(JSON.stringify(WB_FIX));
    fix.defaults.position = 6; fix.defaults.role = 2; fix.defaults.depth = 9;
    const { MP, els } = boot({}, { "/app/worldbook": fix });
    await MP.render("worldbook");
    els.memWbMount._fire("click", { target: tgt({ "[data-wb-new]": {} }) });
    await settle();
    const h = els.memWbMount._html;
    ok(h.includes("新建世界书条目"), "进了新建态");
    ok(/data-wbf="position">[\s\S]{0,600}?<option value="6" selected/.test(h),
      "默认位置用的是后端 DEFAULTS（不是前端写死的）");
    ok(/data-wbf="role">[\s\S]{0,400}?<option value="2" selected/.test(h), "默认角色来自后端");
    ok(/data-wbf="depth" value="9"/.test(h), "默认深度来自后端");
    ok(!h.includes("data-wb-del"), "新建时没有「删除」（没东西可删）");
    ok(/data-wbf="constant" checked/.test(h), "新建默认勾了常驻（还没填关键词）");
  }

  console.log('\n=== 5. 世界书：保存时发出去的请求体 ===');
  {
    const { MP, els, calls } = boot({}, { "/app/worldbook": WB_FIX });
    await MP.render("worldbook");
    els.memWbMount._fire("click", { target: tgt({ "[data-wb-open]": { wbOpen: "a1" } }) });
    await settle();
    const host = els.memWbMount;
    setField(host, "title", "改过的标题");
    setField(host, "content", "改过的正文");
    setField(host, "key", "薄荷，窗台");
    setField(host, "keysecondary", "夏天");
    setField(host, "selectiveLogic", "2");
    setField(host, "order", "77");
    setField(host, "position", "4");
    setField(host, "depth", "3");
    setField(host, "role", "1");
    setField(host, "probability", "55");
    setField(host, "useProbability", true);
    setField(host, "caseSensitive", false);
    setField(host, "matchWholeWords", true);
    setField(host, "disable", false);
    calls.length = 0;
    host._fire("click", { target: tgt({ "[data-wb-save]": {} }) });
    await settle();
    const save = calls.filter((c) => c.path === "/app/worldbook/save")[0];
    ok(!!save, "发了保存请求");
    const it = save && save.body && save.body.item;
    ok(!!it, "请求体里有 item");
    eq(it.id, "a1", "带着要改的 id");
    eq(it.title, "改过的标题", "标题");
    eq(it.content, "改过的正文", "正文");
    ok(typeof it.key === "string", "关键词以**字符串**发（切词交给后端的 split_keywords）");
    ok(typeof it.keysecondary === "string", "次关键词也是字符串");
    eq(it.selective, true, "填了次关键词 → selective 自动为真（否则次词是哑的）");
    eq(it.constant, false, "填了主关键词 → 不再是常驻");
    ok(typeof it.order === "number" && it.order === 77, "顺序是数字");
    ok(typeof it.position === "number" && it.position === 4, "位置是数字");
    ok(typeof it.depth === "number" && it.depth === 3, "深度是数字");
    ok(typeof it.role === "number" && it.role === 1, "角色是数字");
    ok(it.useProbability === true && it.probability === 55, "概率与开关");
    ok(it.matchWholeWords === true && it.caseSensitive === false, "整词 / 大小写各自独立");
    ok(calls.some((c) => c.path === "/app/worldbook"), "保存后会重读一次列表");
  }

  console.log('\n=== 6. 世界书：保存的护栏 ===');
  {
    const { MP, els, calls } = boot({}, { "/app/worldbook": WB_FIX });
    const toasts = [];
    els.memWbMount.dataset.bound = "";
    const b = boot({ toast: (m) => toasts.push(m) }, { "/app/worldbook": WB_FIX });
    await b.MP.render("worldbook");
    b.els.memWbMount._fire("click", { target: tgt({ "[data-wb-open]": { wbOpen: "a1" } }) });
    await settle();
    setField(b.els.memWbMount, "content", "   ");
    b.calls.length = 0;
    b.els.memWbMount._fire("click", { target: tgt({ "[data-wb-save]": {} }) });
    await settle();
    ok(!b.calls.some((c) => c.path === "/app/worldbook/save"), "正文空 → 不发请求");
    ok(toasts.some((m) => m.includes("正文不能为空")), "并且明确说了原因");
  }

  console.log('\n=== 7. 世界书：导入 / 预览 / 迁移 ===');
  {
    const { MP, els, calls } = boot({}, {
      "/app/worldbook": WB_FIX,
      "/app/worldbook/preview": { ok: true, hits: [{ id: "a1", title: "我的房间", positionLabel: "角色设定后", order: 50, constant: true, content: "朝东的小屋" }], bySection: { afterCharacter: 1 }, rendered: { afterCharacter: "#### [我的房间]\n朝东的小屋" } },
    });
    await MP.render("worldbook");
    els.memWbMount._fire("click", { target: tgt({ "[data-wb-import-open]": {} }) });
    await settle();
    els.memWbMount._q["[data-wb-importbox]"] = { value: '{"entries":{}}' };
    calls.length = 0;
    els.memWbMount._fire("click", { target: tgt({ "[data-wb-import]": {} }) });
    await settle();
    const im = calls.filter((c) => c.path === "/app/worldbook/import")[0];
    ok(!!im && im.body.content === '{"entries":{}}', "导入把粘贴的 JSON 发出去了");

    els.memWbMount._fire("click", { target: tgt({ "[data-wb-migrate]": {} }) });
    await settle();
    ok(calls.some((c) => c.path === "/app/worldbook/migrate"), "迁移发了请求");

    els.memWbMount._fire("click", { target: tgt({ "[data-wb-preview-open]": {} }) });
    await settle();
    /* 用变量而不是在两处各写一遍那段话 —— 差一个字测试就红，而那是测试的错 */
    const PV_TEXT = "今天窗台的薄荷长得很好";
    els.memWbMount._q["[data-wb-prevbox]"] = { value: PV_TEXT };
    els.memWbMount._q["[data-wb-char]"] = { value: "阿澈" };
    els.memWbMount._q["[data-wb-user]"] = { value: "西西" };
    calls.length = 0;
    els.memWbMount._fire("click", { target: tgt({ "[data-wb-preview]": {} }) });
    await settle();
    const pv = calls.filter((c) => c.path === "/app/worldbook/preview")[0];
    ok(!!pv, "预览发了请求");
    eq(pv.body.text, PV_TEXT, "带上了那段话");
    eq(pv.body.char, "阿澈", "带上了 {{char}} 要展开成的名字");
    eq(pv.body.user, "西西", "带上了 {{user}}");
    const h = els.memWbMount._html;
    ok(h.includes("角色设定后"), "预览结果显示命中条目的注入位置");
    ok(h.includes("朝东的小屋"), "预览结果里能看到注入正文");
  }

  console.log('\n=== 8. 档案馆：事件盒列表 ===');
  {
    const { MP, els } = boot({}, { "/app/archive/boxes": BX_FIX });
    await MP.render("archive");
    const h = els.arcBoxes._html;
    ok(h.includes("档案馆"), "渲染出档案馆页");
    ok(h.includes("第一次去那家店"), "盒名在列表里");
    ok(h.includes("2 活 / 1 灰"), "盒卡上写清活 / 灰");
    ok(h.includes("1 个盒"), "头部写着盒数");
    ok(h.includes("含总结"), "标出了「含总结」");
    ok(h.includes("事件盒") && h.includes("时间线"), "有两个子视图的切换条");
    ok(!/mp-box sealed/.test(h), "没封盒的盒不带 sealed 类");
  }

  console.log('\n=== 9. 档案馆：盒详情（活 / 灰 / 总结）===');
  {
    const { MP, els } = boot({}, { "/app/archive/boxes": BX_FIX });
    await MP.render("archive");
    els.arcBoxes._fire("click", { target: tgt({ "[data-bx-open]": { bxOpen: "b1" } }) });
    await settle();
    const h = els.arcBoxes._html;
    ok(h.includes("活节点 2 条"), "活节点数写上");
    ok(h.includes("灰节点 1 条"), "灰节点数写上");
    ok(h.includes("订了靠窗的位子"), "活节点正文显示出来");
    ok(h.includes("我们去过那家店"), "总结显示出来");
    ok(/mp-node gone[\s\S]{0,400}?data-bx-act="revive"/.test(h),
      "灰节点给的是「复活」");
    ok(/mp-node"[^>]*>[\s\S]{0,300}?data-bx-act="archive"/.test(h),
      "活节点给的是「归档」");
    ok(h.includes("压缩成总结") && h.includes("封盒"), "盒级动作在");
  }

  console.log('\n=== 10. 档案馆：每个动作发的是对的 act ===');
  {
    /* compress 走的是**另一条路由**（它要调模型生成总结），请求体里没有 act ——
       所以它对 act 的断言是 null（"这一项不适用"），不是 compress。 */
    const cases = [
      ["seal", "seal", "/app/archive/box/act"],
      ["unseal", "unseal", "/app/archive/box/act"],
      ["compress", null, "/app/archive/box/compress"],
    ];
    for (const [act, wantAct, pathWant] of cases) {
      const { MP, els, calls } = boot({}, { "/app/archive/boxes": BX_FIX });
      await MP.render("archive");
      els.arcBoxes._fire("click", { target: tgt({ "[data-bx-open]": { bxOpen: "b1" } }) });
      await settle();
      calls.length = 0;
      els.arcBoxes._fire("click", { target: tgt({ "[data-bx-act]": { bxAct: act } }) });
      await settle();
      const c = calls.filter((x) => x.path === pathWant)[0];
      ok(!!c, "「" + act + "」打到 " + pathWant);
      if (wantAct) eq(c.body.act, wantAct, "act 是 " + wantAct + "（不是别的）");
      eq(c.body.id, "b1", "带着盒 id");
    }
  }

  console.log('\n=== 11. 档案馆：节点级的复活 / 归档（★ 别把节点操作认成盒级）===');
  {
    for (const [act, node] of [["revive", "n3"], ["archive", "n1"]]) {
      const { MP, els, calls } = boot({}, { "/app/archive/boxes": BX_FIX });
      await MP.render("archive");
      els.arcBoxes._fire("click", { target: tgt({ "[data-bx-open]": { bxOpen: "b1" } }) });
      await settle();
      calls.length = 0;
      els.arcBoxes._fire("click", {
        target: tgt({ "[data-bx-act]": { bxAct: act, bxNode: node } }),
      });
      await settle();
      const c = calls.filter((x) => x.path === "/app/archive/box/act")[0];
      ok(!!c, act + " 打到 act 接口");
      eq(c.body.act, act, "act = " + act);
      eq(c.body.node, node, "带上了节点 id " + node);
    }
  }

  console.log('\n=== 12. 档案馆：归盒只送"没归过盒的"（★ 最容易错的一条）===');
  {
    const host = {
      libItems: {
        event: [{ id: "n1" }, { id: "n9" }],        // n1 已在盒里
        story: [{ id: "n3" }],                       // n3 是灰节点，也算已归盒
        fragment: [{ id: "n8" }],
        summary: [{ id: "s1" }],                     // s1 是盒的总结节点，没在 live/archived 里
        ref: [{ id: "r1" }],                         // 笔记本不是叙事，永远不归盒
      },
      layers: { narrative_kinds: ["event", "story", "fragment", "summary"] },
    };
    const { MP, els, calls } = boot(host, { "/app/archive/boxes": BX_FIX });
    await MP.render("archive");
    eq(MP._bxLoose().sort(), ["n8", "n9", "s1"], "漏在外面的正好这三个（n1/n3 已归盒，r1 不是叙事）");
    calls.length = 0;
    els.arcBoxes._fire("click", { target: tgt({ "[data-bx-bind]": {} }) });
    await settle();
    const c = calls.filter((x) => x.path === "/app/archive/box/bind")[0];
    ok(!!c, "发了归盒请求");
    eq(c.body.ids.sort(), ["n8", "n9", "s1"], "请求里只有没归盒的（重复送会把灰节点拽回活节点）");
  }

  console.log('\n=== 13. 档案馆：叙事 kind 以后端为准 ===');
  {
    /* 后端说"只有 event 算叙事" → 前端就该只收 event，不许拿内置那份顶 */
    const host = {
      libItems: { event: [{ id: "e1" }], story: [{ id: "s1" }] },
      layers: { narrative_kinds: ["event"] },
    };
    const { MP } = boot(host, { "/app/archive/boxes": BX_FIX });
    await MP.render("archive");
    eq(MP._narrativeKinds(), ["event"], "用了后端给的 narrative_kinds");
    eq(MP._bxLoose(), ["e1"], "只收 event 的（story 不在后端那份里）");
    /* 读不到 /app/layers 时退回内置 */
    const b2 = boot({ libItems: { event: [{ id: "e2" }] }, layers: null }, { "/app/archive/boxes": BX_FIX });
    await b2.MP.render("archive");
    eq(b2.MP._narrativeKinds().sort(), ["event", "fragment", "story", "summary"],
      "拿不到后端时用内置兜底（离线也能画）");
  }

  console.log('\n=== 14. 档案馆：没有漏的就不发请求 ===');
  {
    const host = {
      libItems: { event: [{ id: "n1" }], story: [{ id: "n3" }] },   // 两个都已在盒里
      layers: { narrative_kinds: ["event", "story"] },
    };
    const { MP, els, calls } = boot(host, { "/app/archive/boxes": BX_FIX });
    await MP.render("archive");
    calls.length = 0;
    els.arcBoxes._fire("click", { target: tgt({ "[data-bx-bind]": {} }) });
    await settle();
    ok(!calls.some((c) => c.path === "/app/archive/box/bind"), "没有漏的不发请求（省一次往返）");
  }

  console.log('\n=== 15. 档案馆：删除 / 改名 / 新建 ===');
  {
    const { MP, els, calls } = boot({}, { "/app/archive/boxes": BX_FIX });
    /* 进详情 —— 每次操作前都要重新进（删掉就没得进了，所以顺序要放最后） */
    const openBox = async () => {
      els.arcBoxes._fire("click", { target: tgt({ "[data-bx-open]": { bxOpen: "b1" } }) });
      await settle();
    };
    const inDetail = () => els.arcBoxes._html.includes("data-bx-back");

    await MP.render("archive");
    await openBox();
    ok(inDetail(), "先确认在详情里");

    /* ── 改名（★ 必须带上 live/archived：只送 id+name 的话，
          后端 normalize 会把成员清成空数组 —— 盒会"突然空了"）── */
    calls.length = 0;
    els.arcBoxes._fire("click", { target: tgt({ "[data-bx-rename]": {} }) });
    await settle();
    const r = calls.filter((c) => c.path === "/app/archive/box/save")[0];
    ok(!!r, "改名发的是 save");
    eq(r.body.box.name, "改过的新名字", "名字来自输入");
    eq(r.body.box.id, "b1", "带着 id（否则会新建一个）");
    eq(r.body.box.live, ["n1", "n2"], "★ 原样带着 live —— 不带上会被后端 normalize 清空");
    eq(r.body.box.archived, ["n3"], "灰节点也要带上");

    /* ── 新建：先回列表 */
    els.arcBoxes._fire("click", { target: tgt({ "[data-bx-back]": {} }) });
    await settle();
    ok(!inDetail(), "返回后离开详情");
    calls.length = 0;
    els.arcBoxes._fire("click", { target: tgt({ "[data-bx-new]": {} }) });
    await settle();
    const n = calls.filter((c) => c.path === "/app/archive/box/save")[0];
    ok(!!n, "新建发的是 save");
    ok(!n.body.box.id, "新建不带 id（让后端发一个）");

    /* ── 删除放最后（删完那个盒就没了）*/
    await openBox();
    calls.length = 0;
    els.arcBoxes._fire("click", { target: tgt({ "[data-bx-del]": {} }) });
    await settle();
    const d = calls.filter((c) => c.path === "/app/archive/box/delete")[0];
    ok(!!d && d.body.id === "b1", "删盒带上了 id");
    ok(!inDetail(), "删完回到列表（★ 不能用 indexOf(\"活节点\") 判 —— 列表页头部也有这三个字）");
  }

  console.log('\n=== 16. 子视图切换：时间线那一屏是宿主的，只是显隐 ===');
  {
    let arcCalled = 0;
    const { MP, els } = boot({ arcRender: () => { arcCalled++; } }, { "/app/archive/boxes": BX_FIX });
    await MP.render("archive");
    ok(els.arcTimeline._cls.has("hidden"), "默认是事件盒那一屏（时间线藏着）");
    els.arcBoxes._fire("click", { target: tgt({ "[data-arc-view]": { arcView: "timeline" } }) });
    await settle();
    ok(!els.arcTimeline._cls.has("hidden"), "切到时间线 → 去掉 hidden");
    ok(arcCalled > 0, "并且通知宿主重画它自己那一屏（arcRender）");
    els.arcBoxes._fire("click", { target: tgt({ "[data-arc-view]": { arcView: "boxes" } }) });
    await settle();
    ok(els.arcTimeline._cls.has("hidden"), "切回事件盒 → 时间线又藏起来");
  }

  console.log('\n=== 17. 失败与兜底 ===');
  {
    /* 宿主没提供 api（脚本没加载完）→ 页面要显示错误，而不是抛出去把整页弄白 */
    const { MP, els } = boot({ api: null }, {});
    await MP.render("worldbook");
    ok(els.memWbMount._html.includes("读取失败"), "读不到时显示错误与重试（不白屏）");
    await MP.render("archive");
    ok(els.arcBoxes._html.includes("读取失败"), "档案馆同理");
  }
  {
    const { MP, els, calls } = boot({}, { "/app/worldbook": { ok: false, error: "数据库连不上" } });
    await MP.render("worldbook");
    ok(els.memWbMount._html.includes("数据库连不上"), "后端明确报错时把原话带出来");
  }
  {
    /* reset：换页/重进时不该还停在上次的详情里 */
    const { MP, els } = boot({}, { "/app/archive/boxes": BX_FIX });
    await MP.render("archive");
    els.arcBoxes._fire("click", { target: tgt({ "[data-bx-open]": { bxOpen: "b1" } }) });
    await settle();
    ok(els.arcBoxes._html.includes("活节点 2 条"), "先进了详情");
    MP.reset();
    await MP.render("archive");
    ok(!els.arcBoxes._html.includes("活节点 2 条"), "reset 后回到列表");
  }
  {
    /* 渲染两次不该把监听器挂两遍（挂两遍会出现"点一次执行两次"） */
    const { MP, els } = boot({}, { "/app/archive/boxes": BX_FIX });
    await MP.render("archive");
    await MP.render("archive");
    await MP.render("archive");
    eq((els.arcBoxes._listeners.click || []).length, 1, "点击监听器只挂了一个");
    const w = boot({}, { "/app/worldbook": WB_FIX });
    await w.MP.render("worldbook");
    await w.MP.render("worldbook");
    eq((w.els.memWbMount._listeners.click || []).length, 1, "世界书那边也只挂一个");
  }

  console.log('\n────────────────────────────────────────');
  console.log(PASS + ' 通过 / ' + FAIL + ' 失败');
  process.exit(FAIL ? 1 : 0);
})();
