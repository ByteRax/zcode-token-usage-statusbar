const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v421 压缩分隔线统计标注：11 分片 compSuffixHtml/syncCompactionRows。
 * 数据链（zusage 顶层 compactions，{sid:[{ts,b,a,cr,cw}]}，第 k 条 success 分隔线 ↔
 * 第 k 条 compact 记录）由 tests/test_session_compactions.py 锁定；本文件锁 DOM 标注。 */

const slice = sliceOverlay('    function cmpNum(', '    /* ---------- v105 压缩上下文');
/* v445：alt 行走的是外层 IIFE 的 gitEsc（01 分片符号），compSuffixHtml 所在工厂作用域没有 esc。
 * 这里把产物里的真实 gitEsc 一并放进切片，不再往沙箱注入同名桩——旧桩曾把
 * 「esc is not defined」的 ReferenceError 掩成恒绿（tests.md §2 同名桩陷阱）。 */
const gitEscSrc = sliceOverlay('  function gitEsc(s) {', '  function gitTimeStr(ts) {');

// 宿主分隔线结构（ConversationShareReadonlyTimeline MarkerDividerRow）：线 div + 中央 pill + 线 div。
function fakeSpan(tag) {
  return {
    tagName: tag,
    children: [],
    style: {},
    parentNode: null,
    attrs: null,
    setAttribute(k, v) { (this.attrs = this.attrs || {})[k] = v; },
    appendChild(c) { c.parentNode = this; this.children.push(c); },
    removeChild(c) { c.parentNode = null; this.children = this.children.filter(x => x !== c); },
  };
}

function fakeRow() {
  const pill = fakeSpan('SPAN');
  const row = fakeSpan('DIV');
  row.children = [fakeSpan('DIV'), pill, fakeSpan('DIV')];
  row.querySelector = sel => {
    if (sel !== 'span[data-zusage-cmp]') throw new Error('unexpected sel ' + sel);
    return pill.children.find(c => (c.attrs && c.attrs['data-zusage-cmp'] !== undefined)) || null;
  };
  return { row, pill };
}

function makeContext(opts) {
  const o = opts || {};
  const { row, pill } = fakeRow();
  const rows = [...(o.extraRows || []), row];
  const body = fakeSpan('BODY');
  const pane = o.pane || {
    getAttribute(k) { return k === 'data-testid' ? 'v4-session-pane-p1' : null; },
    contains() { return true; },
    parentElement: body,
  };
  const anchor = o.anchor === undefined
    ? { isConnected: true, parentElement: pane, getAttribute: () => null } : o.anchor;
  const ctx = {
    state: { lang: o.lang || 'zh', cmpAnn: 'cmpAnn' in o ? o.cmpAnn : 1, data: { context_window: o.win || 0 } },
    nativeCtxVal: o.nctx || 0,
    L: (zh, en) => ctx.state.lang === 'en' ? en : zh,
    inactive: () => false,
    pickedSid: o.sid === undefined ? 'sessA' : o.sid,
    instSid: 'sessA',
    lastCompactions: 'lastCompactions' in o ? o.lastCompactions : { sessA: o.recs || [] },
    wantedEl: anchor,
    composer: null,
    mobileMode: undefined,
    FATAL: {},
    rows,
    paneObj: pane,
    document: {
      body,
      querySelectorAll: () => ctx.querySelectorAllError ? (() => { throw new Error('boom'); })() : rows,
      createElement: tag => fakeSpan(tag.toUpperCase()),
    },
  };
  return { ctx, row, pill };
}

function run(ctx) {
  vm.runInNewContext(gitEscSrc + '\n' + slice + '\nthis.__api = { compSuffixHtml, syncCompactionRows };', ctx);
  return ctx.__api;
}

/* ---------- compSuffixHtml：用户规格格式（千分位逗号 + 全角括号 + 日期） ---------- */

test('compSuffixHtml renders the zh annotation as three lines with window pct and op facts', () => {
  // 窗口走 ctxOv > nativeCtxVal > 快照 context_window：这里给快照窗口 128000
  const { compSuffixHtml } = run(makeContext({ win: 128000 }).ctx);
  // 构造本地时刻 → 日期断言跨时区稳定
  const ts = new Date(2026, 10, 21, 23, 13, 46).getTime();
  const rec = { ts, b: 94787, a: 40747, cr: 30000, cw: 1000, out: 3210, dur: 9400 };
  const html = compSuffixHtml(rec, 0, [rec]);
  // 整串锁定三行结构（千分位逗号 + 全角括号 + 用户规格水位%前缀）
  assert.equal(html,
    '2026 年 11 月 21 日 23:13:46 · 第 1 次<br>' +
    '74%(94,787)→32%(40,747) · 减少：54,040 Token（57.01%）<br>' +
    '压缩消耗 3,210 Token · 耗时 9 秒');
  // v437：缓存四项行整行去除——快照仍带 cr/cw 也不渲染（rec 特意带 cr=30000/cw=1000）
  assert.ok(!html.includes('未缓存输入') && !html.includes('缓存命中率'));
  // 第 2 次：距上次按宿主同款两段时长
  const r2 = { ts: ts + 5400000, b: 50000, a: 45000, cr: 0, cw: 0, out: 0, dur: 0 };
  const html2 = compSuffixHtml(r2, 1, [rec, r2]);
  assert.match(html2, /· 第 2 次 · 距上次 1 时 30 分<br>39%\(50,000\)→35%\(45,000\)/);
  // ⑥ 执行模型不同才带 alt（out/dur 缺失时 L4 只剩执行者）
  r2.alt = 'glm-4.5-air';
  assert.match(compSuffixHtml(r2, 1, [rec, r2]), /<br>由 glm-4\.5-air 执行$/);
  // v433：model_id 来自 DB（自定义名可含 HTML），转义链与其余展示同规
  r2.alt = '<img src=x onerror=alert(1)>';
  const altHtml = compSuffixHtml(r2, 1, [rec, r2]);
  assert.ok(!altHtml.includes('<img src=x'), 'alt 过转义（不得出现原始 HTML 标签）');
  assert.match(altHtml, /由 &lt;img src=x onerror=alert\(1\)&gt; 执行/);
  // 窗口未知：水位段退回纯数字（v427 形态）
  const nowin = run(makeContext({}).ctx);
  assert.match(nowin.compSuffixHtml({ ts, b: 94787, a: 40747, cr: 0, cw: 0, out: 0, dur: 0 }, 0, [{ ts }]),
    /<br>94,787→40,747 ·/);
  assert.ok(!nowin.compSuffixHtml({ ts, b: 94787, a: 40747, cr: 0, cw: 0, out: 0, dur: 0 }, 0, [{ ts }]).includes('%(94,787)'));
});

test('compSuffixHtml degrades honestly and renders English under lang=en', () => {
  const { compSuffixHtml } = run(makeContext({ lang: 'en', win: 128000 }).ctx);
  const ts = new Date(2026, 10, 21, 23, 13, 46).getTime();
  const full = compSuffixHtml({ ts, b: 94787, a: 40747, cr: 0, cw: 0, out: 3210, dur: 9400 }, 0, [{ ts }]);
  assert.equal(full,
    'Nov 21, 2026 23:13:46 · #1<br>' +
    '74% (94,787)→32% (40,747) · Reduced: 54,040 tokens (57.01%)<br>' +
    'Compaction cost 3,210 tokens · Took 9s');
  // v437：en 同样不渲染缓存行
  assert.ok(!full.includes('Uncached') && !full.includes('Cache'));
  // 缺 b（无压缩前样本）：变化/减少段整行省略，只剩日期+序数单行
  const noB = compSuffixHtml({ ts: 123, a: 1000, cr: 250, cw: 0, out: 0, dur: 0 }, 0, [{ ts: 123 }]);
  assert.ok(!noB.includes('Reduced:'));
  assert.ok(!noB.includes('% ('));
  assert.ok(!noB.includes('Cache'));
  assert.equal((noB.match(/<br>/g) || []).length, 0);
  // 非法 ts：日期段为空但不抛（meta 只剩序数）
  const ts0 = compSuffixHtml({ ts: 0, a: 10, cr: 0, cw: 0, out: 0, dur: 0 }, 0, [{ ts: 0 }]);
  assert.match(ts0, /#1/);
  assert.ok(!ts0.includes('Cache'));
});

/* ---------- syncCompactionRows：第 k 条对齐、幂等、诚实降级、pane 过滤 ---------- */

test('syncCompactionRows appends one suffixed span per record and is signature-idempotent', () => {
  const ts = new Date(2026, 10, 21, 23, 13, 46).getTime();
  const recs = [{ ts, b: 94787, a: 40747, cr: 0, cw: 0 }, { ts: ts + 60000, b: 50000, a: 45000, cr: 44000, cw: 0 }];
  const { ctx, pill } = makeContext({ recs });
  const { syncCompactionRows } = run(ctx);
  syncCompactionRows();
  const spans = pill.children.filter(c => (c.attrs && c.attrs['data-zusage-cmp'] !== undefined));
  assert.equal(spans.length, 1);
  assert.match(spans[0].innerHTML, /<br>94,787→40,747 ·/);
  assert.equal((spans[0].innerHTML.match(/<br>/g) || []).length, 1, '标注块两行（v437 缓存行去除；样本无 out/dur 故 L4 缺）');
  assert.equal(spans[0].style.cssText,
    'flex:0 0 100%;font-size:12px;opacity:.78;text-align:center;line-height:1.5;white-space:nowrap;');
  assert.equal(pill.style.flexWrap, 'wrap', '宿主 pill 补换行放行标注块落 label 下');
  // 幂等：重跑不重复、不重建（签名一致跳过）
  const ref = pill.children[0];
  syncCompactionRows();
  assert.equal(pill.children.filter(c => (c.attrs && c.attrs['data-zusage-cmp'] !== undefined)).length, 1);
  assert.equal(pill.children[0], ref);
  // 会话切换到无记录会话：标注摘除（诚实降级），pill 换行放行一并还原
  ctx.pickedSid = 'sessB';
  syncCompactionRows();
  assert.equal(pill.children.filter(c => (c.attrs && c.attrs['data-zusage-cmp'] !== undefined)).length, 0);
  assert.equal(pill.style.flexWrap, '', '摘除时还原宿主 pill 单行布局');
});

test('v445: a record carrying alt renders via the real gitEsc and never aborts later rows', () => {
  // 回归：alt 行曾裸引工厂作用域里不存在的 esc → ReferenceError 被 syncCompactionRows 的
  // try 吞进 FATAL.cmpErr，自带 alt 的那条起（含）标注全缺。沙箱不注入 esc 桩，缺失即红。
  assert.equal(/(^|[^\w.])esc\(/.test(slice), false, '压缩标注切片不得调用裸 esc（本作用域只有 gitEsc）');
  const ts = new Date(2026, 10, 21, 23, 13, 46).getTime();
  const first = fakeRow();
  const recs = [
    { ts, b: 94787, a: 40747, cr: 0, cw: 0, alt: '<b>glm-4.5-air</b>' },
    { ts: ts + 60000, b: 50000, a: 45000, cr: 0, cw: 0 },
  ];
  const { ctx, pill } = makeContext({ recs, extraRows: [first.row] });   // 默认 pane 含全部行：两条记录各对一条分隔线
  const { syncCompactionRows } = run(ctx);
  syncCompactionRows();
  assert.equal(ctx.FATAL.cmpErr, undefined, '带 alt 的记录不得抛错');
  const spansOf = p => p.children.filter(c => (c.attrs && c.attrs['data-zusage-cmp'] !== undefined));
  const a = spansOf(first.pill), b = spansOf(pill);
  assert.equal(a.length, 1, '带 alt 的分隔线挂上标注');
  assert.match(a[0].innerHTML, /第 1 次<br>94,787→40,747[\s\S]*<br>由 &lt;b&gt;glm-4\.5-air&lt;\/b&gt; 执行$/, 'alt 走产物内真实 gitEsc');
  assert.ok(!a[0].innerHTML.includes('<b>glm'), '原始标签不得进 innerHTML');
  assert.equal(b.length, 1, '带 alt 记录之后的分隔线仍有标注（异常不得中断后续行）');
  assert.match(b[0].innerHTML, /第 2 次 · 距上次 1 分<br>/);
});

test('syncCompactionRows skips rows outside the pane and tolerates hostile DOM', () => {
  const ts = new Date(2026, 10, 21, 23, 13, 46).getTime();
  const other = fakeRow();
  const { ctx, row, pill } = makeContext({
    recs: [{ ts, b: 94787, a: 40747, cr: 0, cw: 0 }],
    extraRows: [other.row],   // 前置一条属于别的 pane 的分隔线
  });
  ctx.paneObj.contains = el => el === row;   // 只有本实例 pane 内的行放行
  const { syncCompactionRows } = run(ctx);
  syncCompactionRows();
  // 序号只按 pane 内行累计：标注吃到 recs[0]，不会把记录错配给外来行
  assert.equal(other.pill.children.filter(c => (c.attrs && c.attrs['data-zusage-cmp'] !== undefined)).length, 0);
  assert.equal(pill.children.filter(c => (c.attrs && c.attrs['data-zusage-cmp'] !== undefined)).length, 1);
  // querySelectorAll 抛错：吞掉记 FATAL，不外抛
  ctx.querySelectorAllError = true;
  syncCompactionRows();
  assert.match(ctx.FATAL.cmpErr, /boom/);
});

test('syncCompactionRows is inert on mobile mode and disposed instances', () => {
  const { ctx, pill } = makeContext({ recs: [{ ts: 1, b: 10, a: 5, cr: 0, cw: 0 }] });
  const { syncCompactionRows } = run(ctx);
  ctx.mobileMode = true;
  syncCompactionRows();
  assert.equal(pill.children.filter(c => (c.attrs && c.attrs['data-zusage-cmp'] !== undefined)).length, 0);
  ctx.mobileMode = undefined;
  ctx.inactive = () => true;
  syncCompactionRows();   // disposed：不抛不标
});

/* ---------- v421 ⚙「压缩分隔线统计」开关（zusage3.cmpAnn，缺省开） ---------- */

test('syncCompactionRows strips annotations while state.cmpAnn is off and restores on re-enable', () => {
  const ts = new Date(2026, 10, 21, 23, 13, 46).getTime();
  const recs = [{ ts, b: 94787, a: 40747, cr: 0, cw: 0 }];
  const { ctx, pill } = makeContext({ recs });
  const { syncCompactionRows } = run(ctx);
  syncCompactionRows();
  assert.equal(pill.children.filter(c => c.attrs && c.attrs['data-zusage-cmp'] !== undefined).length, 1);
  // 关闭：下一拍撤下标注（rec 恒空走摘除分支），pill 换行放行同步还原
  ctx.state.cmpAnn = 0;
  syncCompactionRows();
  assert.equal(pill.children.filter(c => c.attrs && c.attrs['data-zusage-cmp'] !== undefined).length, 0);
  assert.equal(pill.style.flexWrap, '');
  // 关闭态重跑幂等（无重复摘除报错）
  syncCompactionRows();
  assert.equal(pill.children.filter(c => c.attrs && c.attrs['data-zusage-cmp'] !== undefined).length, 0);
  // 重开：按内存记录补回
  ctx.state.cmpAnn = 1;
  syncCompactionRows();
  const spans = pill.children.filter(c => c.attrs && c.attrs['data-zusage-cmp'] !== undefined);
  assert.equal(spans.length, 1);
  assert.match(spans[0].innerHTML, /<br>94,787→40,747 ·/);
  assert.equal(pill.style.flexWrap, 'wrap');
});

test('⚙ 回答统计「压缩分隔线统计」开关接线完整（缺省开/显式0关/持久化/恢复/独立分支）', () => {
  const { readOverlaySource } = require('./helpers/overlay-extract.cjs');
  const src = readOverlaySource();
  assert.ok(src.includes('cmpAnn: "zusage3.cmpAnn"'), 'LS 键登记');
  assert.match(src, /cmpAnn: 1,/);
  assert.match(src, /if \(ls\(LS\.cmpAnn, ""\) === "0"\) state\.cmpAnn = 0;/);
  assert.match(src, /lsSet\(LS\.cmpAnn, state\.cmpAnn \? "1" : "0"\);/);
  assert.ok(src.includes('class="zu-cmp-ann"'), '设置行');
  assert.match(src, /压缩分隔线统计/);
  assert.match(src, /t2\.classList\.contains\("zu-cmp-ann"\)/, '独立 change 分支');
  assert.equal((src.match(/panel\.querySelector\("\.zu-cmp-ann"\)/g) || []).length, 2, 'buildPanel+syncPanel 两处恢复');
  assert.ok(src.indexOf('zu-rate-line') < src.indexOf('zu-cmp-ann'), '行序：回答统计分区紧跟统计行开关');
  assert.match(src, /state\.cmpAnn \? recs : null/, '关闭态摘除门控在标注函数内');
});
