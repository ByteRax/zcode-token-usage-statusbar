const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/overlay/01-git-and-doc-tooltips.js'), 'utf8');
const start = source.indexOf('/* 查看全部历史：套餐源 id → 显示名');
const end = source.indexOf('/* ---------- v202 预估费用说明小气泡');
assert.ok(start > 0 && end > start, 'slice anchors');
const slice = source.slice(start, end);

function elStub(env) {
  return {
    style: {}, className: '', _html: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    get clientWidth() { return env.width; },
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
}
function harness(records, opts = {}) {
  const env = { width: opts.width || 1200 };
  const requests = [];
  const winListeners = { add: [], remove: [] };
  const docListeners = { add: [], remove: [] };
  let confirms = opts.confirm !== false;
  const confirmCalls = [];
  const clip = { texts: [] };
  const enhanceTip = elStub(env);
  const ctx = {
    L: zh => zh,
    EH_ICON: { history: '<i>h</i>', close: '<i>x</i>', search: '<i>s</i>', trash: '<i>t</i>', copy: '<i>c</i>', check: '<i>ok</i>', doc: '<i>d</i>', spark: '<i>p</i>', empty: '<i>e</i>', gear: '<i>g</i>' },
    state: {},
    enhanceTip,
    /* v417 起：panel/gear/activateSettingsSec 是 spawnInstance 闭包私有，切片内不再有裸引用——
     * 曾在 ctx 注入同名桩掩盖真实页面 ReferenceError（设置按钮静默失效），桩已撤。 */
    /* 悬停面板状态在切片起点之前声明（01 分片更靠前处），切片外补桩供 hideEnhanceTip/ehRender 引用 */
    ehHideTimer: 0, ehCache: null, ehError: false, ehLoading: false, ehCacheAt: 0, enhanceTipFor: null,
    document: {
      createElement: () => elStub(env),
      body: { appendChild() {} },
      addEventListener: (t, fn) => docListeners.add.push(t),
      removeEventListener: (t, fn) => docListeners.remove.push(t),
      documentElement: { classList: { contains: () => true } }
    },
    window: {
      innerWidth: 1400,
      addEventListener: (t, fn) => winListeners.add.push(t),
      removeEventListener: (t, fn) => winListeners.remove.push(t)
    },
    navigator: { clipboard: { writeText: t => { clip.texts.push(t); return Promise.resolve(); } } },
    setTimeout: () => 0, clearTimeout() {},
    pluginRequest: (name, opts2, done) => { requests.push({ name, opts: opts2, done }); if (done && name === 'enhance-history-list' && opts.autoReply !== false) done({ ok: true, records, total: records.length }); }
  };
  vm.runInNewContext(slice + '\nfunction openFull() { openEnhanceHistoryFull(); }\nfunction closeFull() { closeEnhanceHistoryFull(); }', ctx);
  /* 切片内 function zuConfirm 声明会覆盖运行前赋的桩（声明提升），必须在 run 后覆写 */
  ctx.zuConfirm = (t, d, okText, onOk) => { confirmCalls.push({ t, d, okText, onOk }); if (confirms) onOk(); };
  ctx.openFull();
  return { ctx, requests, winListeners, docListeners, clip, confirmCalls, enhanceTip, setConfirm: v => { confirms = v; } };
}
const rec = (id, over = {}) => Object.assign({
  id, source: 'chat', providerName: 'account:bigmodel-start-plan', modelId: 'glm-5.3-flashx',
  originalText: 'orig-' + id, enhancedText: 'enh-' + id,
  usage: { totalTokens: 291 }, createdAt: '2026-11-15T12:00:00.000Z', durationMs: 3100
}, over);

test('single record renders compactly: no pagination footer, header shows total', () => {
  const h = harness([rec('r1')]);
  const html = h.ctx.ehFull._html;
  assert.ok(!html.includes('zu-eh-pagination'), 'single page must not render pagination footer');
  assert.ok(!html.includes('zu-eh-pg-btn'), 'single page must not render page buttons');
  assert.ok(html.includes('共 1 条'));
  assert.ok(html.includes('zu-eh-head-r'), 'actions grouped on the right');
  assert.ok(html.includes('data-close'), 'close button present');
  assert.ok(html.includes('清空记录'));
});

test('21 records render pagination with page count and size selector', () => {
  const recs = Array.from({ length: 21 }, (_, i) => rec('k' + i));
  const h = harness(recs);
  const html = h.ctx.ehFull._html;
  assert.ok(html.includes('zu-eh-pagination'));
  assert.ok(html.includes('第1/2 页'));
  assert.ok(html.includes('data-f="pagesize"'));
});

test('wide panel: colgroup columns match header and data row cells', () => {
  const h = harness([rec('r1')]);
  const html = h.ctx.ehFull._html;
  const colgroup = html.match(/<colgroup>[\s\S]*?<\/colgroup>/);
  assert.ok(colgroup, 'colgroup present');
  assert.equal((colgroup[0].match(/<col /g) || []).length, 10);
  const headRow = html.match(/<tr class="zu-eh-tr-head">[\s\S]*?<\/tr>/)[0];
  assert.equal((headRow.match(/<th /g) || []).length, 10);
  const dataRow = html.match(/<tr class="zu-eh-row"[^]*?<\/tr>/)[0];
  assert.equal((dataRow.match(/<td /g) || []).length, 10);
  assert.ok(dataRow.includes('BigModel Start Plan'), 'friendly plan label in cell');
  assert.ok(dataRow.includes('title="account:bigmodel-start-plan"'), 'raw id kept in title');
});

test('medium panel merges provider/model into one column', () => {
  const h = harness([rec('r1')], { width: 800 });
  const html = h.ctx.ehFull._html;
  assert.ok(html.includes('供应商 / 模型'));
  const colgroup = html.match(/<colgroup>[\s\S]*?<\/colgroup>/)[0];
  assert.equal((colgroup.match(/<col /g) || []).length, 9);
  assert.ok(html.includes('zu-eh-prov-sep'), 'merged cell separates provider and model');
});

test('narrow panel hides summary columns', () => {
  const h = harness([rec('r1')], { width: 600 });
  h.ctx.ehFull.onclick({ target: { closest: sel => (sel === '.zu-eh-row' ? { getAttribute: a => (a === 'data-id' ? 'r1' : null) } : null), stopPropagation() {} } });
  const html = h.ctx.ehFull._html;
  assert.ok(!html.includes('原文摘要'), 'summary headers hidden');
  const colgroup = html.match(/<colgroup>[\s\S]*?<\/colgroup>/)[0];
  assert.equal((colgroup.match(/<col /g) || []).length, 7);
  assert.ok(html.includes('原始提示词'), 'detail keeps full original text');
});

test('non-plan provider id is shown as-is without fabrication', () => {
  const h = harness([rec('r1', { providerName: 'my-relay-box' })]);
  assert.ok(h.ctx.ehFull._html.includes('>my-relay-box<'));
});

test('row click expands exactly one detail row bound to the record id', () => {
  const h = harness([rec('r1'), rec('r2')]);
  const rowStub = { getAttribute: a => (a === 'data-id' ? 'r2' : null) };
  h.ctx.ehFull.onclick({ target: { closest: sel => (sel === '.zu-eh-row' ? rowStub : null) }, stopPropagation() {} });
  const html = h.ctx.ehFull._html;
  assert.equal((html.match(/zu-eh-detail-row/g) || []).length, 1);
  assert.ok(html.includes('orig-r2'), 'detail belongs to clicked id');
  assert.match(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, 'detail shows full time');
});

test('detail copy resolves text by record id, not row position', () => {
  const h = harness([rec('a'), rec('b', { originalText: 'orig-b-full' })]);
  const rowStub = { getAttribute: a => (a === 'data-id' ? 'b' : null) };
  const btn = {
    hasAttribute: a => a === 'data-copy-orig',
    classList: { contains: c => c === 'zu-eh-row-copy' },
    closest: sel => (sel === '.zu-eh-row' ? null : sel === '.zu-eh-detail-row' ? { previousElementSibling: rowStub } : null),
    innerHTML: '<svg/>'
  };
  h.ctx.ehFull.onclick({ target: { closest: s => (s === 'button' ? btn : null) }, stopPropagation() {} });
  assert.deepEqual(h.clip.texts, ['orig-b-full']);
});

test('delete asks for confirmation and sends the record id', () => {
  const h = harness([rec('r1'), rec('r2')]);
  const rowStub = { getAttribute: a => (a === 'data-id' ? 'r2' : null) };
  const btn = {
    hasAttribute: a => a === 'data-del',
    classList: { contains: () => true },
    closest: sel => (sel === '.zu-eh-row' ? rowStub : null),
    innerHTML: ''
  };
  h.setConfirm(false);
  h.ctx.ehFull.onclick({ target: { closest: s => (s === 'button' ? btn : null) }, stopPropagation() {} });
  assert.equal(h.requests.filter(r => r.name === 'enhance-history-delete').length, 0, 'cancel sends nothing');
  assert.equal(h.confirmCalls.length, 1, 'custom confirm dialog opened');
  assert.equal(h.confirmCalls[0].okText, '删除');
  h.setConfirm(true);
  h.ctx.ehFull.onclick({ target: { closest: s => (s === 'button' ? btn : null) }, stopPropagation() {} });
  const del = h.requests.find(r => r.name === 'enhance-history-delete');
  assert.ok(del, 'confirmed delete sends request');
  assert.equal(del.opts.id, 'r2');
  del.done({ ok: true });
  const html = h.ctx.ehFull._html;
  assert.ok(!html.includes('orig-r2'), 'deleted record leaves the table');
  assert.ok(html.includes('orig-r1'), 'remaining record stays without a refetch');
  assert.ok(html.includes('>1<') || html.includes('共 1 条'), 'header count drops to 1');
});
test('failed delete keeps the table intact', () => {
  const h = harness([rec('r1'), rec('r2')]);
  const rowStub = { getAttribute: a => (a === 'data-id' ? 'r2' : null) };
  const btn = {
    hasAttribute: a => a === 'data-del',
    classList: { contains: () => true },
    closest: sel => (sel === '.zu-eh-row' ? rowStub : null),
    innerHTML: ''
  };
  h.ctx.ehFull.onclick({ target: { closest: s => (s === 'button' ? btn : null) }, stopPropagation() {} });
  h.requests.find(r => r.name === 'enhance-history-delete').done({ ok: false });
  assert.ok(h.ctx.ehFull._html.includes('orig-r2'), 'failed delete must not clear the table');
});

test('deleting the last record shows the empty state without pagination', () => {
  const h = harness([rec('only')]);
  const rowStub = { getAttribute: a => (a === 'data-id' ? 'only' : null) };
  const btn = {
    hasAttribute: a => a === 'data-del',
    classList: { contains: () => true },
    closest: sel => (sel === '.zu-eh-row' ? rowStub : null),
    innerHTML: ''
  };
  h.ctx.ehFull.onclick({ target: { closest: s => (s === 'button' ? btn : null) }, stopPropagation() {} });
  h.requests[1].done({ ok: true });
  const html = h.ctx.ehFull._html;
  assert.ok(html.includes('暂无增强历史'));
  assert.ok(!html.includes('zu-eh-pagination'));
});

test('filtering to no matches keeps the compact panel', () => {
  const h = harness([rec('r1')]);
  h.ctx.ehFull.onchange({ target: { hasAttribute: a => a === 'data-f', getAttribute: () => 'source', value: 'test' } });
  const html = h.ctx.ehFull._html;
  assert.ok(html.includes('没有匹配的记录'));
  assert.ok(!html.includes('zu-eh-pagination'));
});

test('resize listener is added on open and removed on close', () => {
  const h = harness([rec('r1')]);
  assert.ok(h.winListeners.add.includes('resize'));
  assert.ok(h.docListeners.add.includes('keydown'));
  h.ctx.closeFull();
  assert.ok(h.winListeners.remove.includes('resize'));
  assert.ok(h.docListeners.remove.includes('keydown'));
});

test('sort header click toggles order and updates aria-sort (th is not a button)', () => {
  const recs = [rec('lo', { usage: { totalTokens: 100 } }), rec('hi', { usage: { totalTokens: 900 } })];
  const h = harness(recs);
  const thStub = {
    hasAttribute: a => a === 'data-sort',
    getAttribute: a => (a === 'data-sort' ? 'totalTokens' : null),
    closest: () => thStub
  };
  h.ctx.ehFull.onclick({ target: { closest: s => (s === '[data-sort]' ? thStub : null) }, stopPropagation() {} });
  let html = h.ctx.ehFull._html;
  assert.match(html, /aria-sort="descending"/, 'first click on a new field sorts descending');
  let first = html.match(/zu-eh-td-num">([^<]+)</);
  assert.equal(first[1], '900', 'descending puts the larger token count first');
  h.ctx.ehFull.onclick({ target: { closest: s => (s === '[data-sort]' ? thStub : null) }, stopPropagation() {} });
  html = h.ctx.ehFull._html;
  assert.match(html, /aria-sort="ascending"/, 'second click toggles to ascending');
  first = html.match(/zu-eh-td-num">([^<]+)</);
  assert.equal(first[1], '100', 'ascending puts the smaller token count first');
});

test('full panel header settings button dispatches via the entry hook recorded at open time', () => {
  const h = harness([rec('r1')]);
  assert.ok(h.ctx.ehFull._html.includes('zu-eh-cfg'), 'settings button present in header');
  assert.ok(h.ctx.ehFull._html.includes('data-ehset'));
  let calls = 0;
  const entry = { isConnected: true, __zuOpenEnhSettings: () => { calls++; } };
  h.ctx.enhanceTipFor = entry;
  h.ctx.openFull();   // 从 tip 打开全量面板：此刻记录入口钩子
  assert.equal(h.ctx.ehFull.__zuOpenEnhSettings, entry.__zuOpenEnhSettings, 'hook recorded at open time');
  h.ctx.enhanceTipFor = null;   // mouseleave 后 tip 已收的真实时序
  const btn = {
    hasAttribute: a => a === 'data-ehset',
    classList: { contains: () => false },
    closest: () => null,
    innerHTML: ''
  };
  h.ctx.ehFull.onclick({ target: { closest: s => (s === 'button' ? btn : null) }, stopPropagation() {} });
  assert.equal(calls, 1, 'entry hook invoked exactly once');
  assert.equal(h.ctx.ehFull.style.display, 'none', 'full panel closes when settings open');
});

test('hover tip settings entry dispatches via the entry hook and hides the tip', () => {
  const h = harness([rec('r1')]);
  let calls = 0;
  h.ctx.enhanceTipFor = { isConnected: true, __zuOpenEnhSettings: () => { calls++; } };
  h.ctx.openEnhanceSettings();
  assert.equal(calls, 1, 'owner instance hook invoked');
  assert.equal(h.enhanceTip.style.display, 'none', 'hover tip hides');
  assert.equal(h.ctx.enhanceTipFor, null, 'tip association cleared');
});

test('v417 回归锁：壳层 openEnhanceSettings 不得直接引用实例闭包私有的 panel/gear/activateSettingsSec', () => {
  /* 真实页面 ReferenceError 被事件分发吞掉而切片 ctx 桩全绿的盲区（v350 起按钮静默失效）——
   * 源码级断言禁止再引入裸引用，分发必须经入口按钮 __zuOpenEnhSettings 钩子。 */
  const fn = source.slice(source.indexOf('function openEnhanceSettings'), source.indexOf('/* ---------- 查看全部历史浮层'));
  assert.ok(fn.includes('__zuOpenEnhSettings'), 'dispatches through the entry hook');
  assert.doesNotMatch(fn, /gear\.click/);
  assert.doesNotMatch(fn, /panel\.classList/);
  assert.doesNotMatch(fn, /activateSettingsSec\(/);
});

test('hover tip footer renders a settings entry', () => {
  const h = harness([rec('r1')]);
  h.ctx.ehRender();
  assert.ok(h.enhanceTip._html.includes('data-ehset'), 'settings entry present in footer');
  assert.ok(h.enhanceTip._html.includes('设置'), 'settings label localized');
});

test('v371: 相位警示长错误文案原样进 zu-eh-phase（CSS 收缩+省略号，不预截断不撑破头部）', () => {
  const h = harness([rec('r1')]);
  const longErr = 'upstream rejected: https://example.invalid/v1/' + 'x'.repeat(160);
  h.ctx.enhanceTipFor = { isConnected: true, __zuEnhTip: longErr, getBoundingClientRect: () => ({ left: 400, top: 440, width: 40, height: 20 }) };
  h.enhanceTip.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };   // placeEnhanceTip 需要
  h.ctx.ehCache = { records: [rec('r1')], total: 1 };   // 有数据才有总数兄弟项
  h.ctx.ehRender();
  const html = h.enhanceTip._html;
  assert.ok(html.includes('<span class="zu-eh-phase">' + longErr + '</span>'), '长错误文案全文渲染（截断交给 CSS ellipsis）');
  assert.ok(html.includes('zu-eh-total'), '总数兄弟项仍在（不被相位挤出）');
});

test('new history records invalidate the full-panel cache', () => {
  const env = { width: 1200 };
  const ctx = { L: zh => zh, pluginRequest: () => {}, window: {}, document: { createElement: () => elStub(env) } };
  const head = source.slice(source.indexOf('function enhanceHistoryAdd'), source.indexOf('function ehEsc'));
  vm.runInNewContext(head + '\nvar ehFullCache = { records: [1] };\nfunction add(r) { enhanceHistoryAdd(r); }', ctx);
  ctx.add({ id: 'n1' });
  assert.equal(ctx.ehFullCache, null);
});

/* ---------- v355 视口钳位：placeEnhanceTip 三档放置 ---------- */
test('v355 placeEnhanceTip: fits above keeps bottom anchor; tall panel flips below; neither side caps height; unlock unlocks measurement', () => {
  /* offsetHeight 桩尊重 style.maxHeight（真实 DOM 里钳高会压低测量值），用于见证测量解锁行 */
  function makeTip(naturalH, presetMaxH) {
    const cls = new Set();
    const tip = { style: presetMaxH ? { maxHeight: presetMaxH } : {}, isConnected: true,
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) }, _cls: cls };
    Object.defineProperty(tip, 'offsetHeight', { get() {
      const m = parseInt(this.style.maxHeight, 10);
      return Number.isFinite(m) ? Math.min(naturalH, m) : naturalH;
    } });
    return tip;
  }
  const rect = (top, bottom) => ({ top, bottom, left: 100, right: 140, width: 40, height: bottom - top });
  const h = harness([]);
  h.ctx.window.innerHeight = 800;
  // 上方够（自然高 300 ≤ above 380）：bottom 锚定原行为，恢复 boot 契约 650px 帽、无翻转
  {
    const tip = makeTip(300);
    h.ctx.enhanceTip = tip; h.enhanceTip = tip;
    h.ctx.enhanceTipFor = { isConnected: true, getBoundingClientRect: () => rect(400, 440) };
    h.ctx.placeEnhanceTip();
    assert.equal(h.enhanceTip.style.top, 'auto');
    assert.equal(h.enhanceTip.style.bottom, '412px');
    assert.equal(h.enhanceTip.style.maxHeight, 'min(650px,72vh)');
    assert.ok(!h.enhanceTip.classList.contains('zu-eh-flip'), 'no flip class above');
  }
  // 上方不够、下方够（above 280 < 541，below 440 ≥ 320）：翻到按钮下方 + flip 箭头
  {
    const tip = makeTip(541);
    h.ctx.enhanceTip = tip; h.enhanceTip = tip;
    h.ctx.enhanceTipFor = { isConnected: true, getBoundingClientRect: () => rect(300, 340) };
    h.ctx.placeEnhanceTip();
    assert.equal(h.enhanceTip.style.top, '352px');
    assert.equal(h.enhanceTip.style.bottom, 'auto');
    assert.equal(h.enhanceTip.style.maxHeight, '440px');   // 翻转分支钳下方可用高（vh 800 - bottom 340 - 20）
    assert.ok(h.enhanceTip.classList.contains('zu-eh-flip'), 'flip class below');
  }
  // 两侧都不够（above 60 < 541，below 280 < 320）：上方贴边 + maxHeight 钳为可用高
  {
    const tip = makeTip(541);
    h.ctx.enhanceTip = tip; h.enhanceTip = tip;
    h.ctx.enhanceTipFor = { isConnected: true, getBoundingClientRect: () => rect(80, 500) };
    h.ctx.placeEnhanceTip();
    assert.equal(h.enhanceTip.style.top, 'auto');
    assert.equal(h.enhanceTip.style.bottom, '732px');
    assert.equal(h.enhanceTip.style.maxHeight, '60px');
    assert.ok(!h.enhanceTip.classList.contains('zu-eh-flip'), 'no flip when capping');
  }
  // 第 4 档（测量解锁见证）：上一拍遗留钳高 60px，自然高 541——解锁后须量到 541 走翻转，
  // 未解锁实现会量到 60 误判「上方够」走 bottom 锚定（top=auto），复发顶缘裁剪
  {
    const tip = makeTip(541, '60px');
    h.ctx.enhanceTip = tip; h.enhanceTip = tip;
    h.ctx.enhanceTipFor = { isConnected: true, getBoundingClientRect: () => rect(300, 340) };
    h.ctx.placeEnhanceTip();
    assert.equal(h.enhanceTip.style.top, '352px', 'measurement must see natural height, not the stale clamp');
    assert.equal(h.enhanceTip.style.maxHeight, '440px');
    assert.ok(h.enhanceTip.classList.contains('zu-eh-flip'));
  }
});
test('search keeps IME composition and restores focus across debounced rebuilds', () => {
  /* v357：200ms debounce 整面板 innerHTML 重建会销毁聚焦中的搜索框——中文输入停顿即
   * 强制取消拼音组合、焦点打回 body；组合期间挂起重建、compositionend 后刷新、
   * 重建后恢复焦点与光标（委托挂面板，搜索框随每次 build 重建） */
  for (const token of ['e.isComposing || ehFullSearchHold', 'oncompositionstart', 'oncompositionend',
    'var searchFocus = document.activeElement', 'searchEl.setSelectionRange(searchCaret, searchCaret)'])
    assert.ok(slice.includes(token), token);
});
