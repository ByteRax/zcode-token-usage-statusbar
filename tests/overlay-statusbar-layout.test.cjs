'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
const { getNamedSlice } = require('./helpers/overlay-extract.cjs');
function slice(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'missing source anchors: ' + start);
  return source.slice(a, b);
}
const helpers = getNamedSlice('barOrderHelpers');
function logic(extra) {
  const context = extra || {};
  vm.runInNewContext(helpers + '\nglobalThis.api = {zuBarOrderNormalize, zuBarPriorityNormalize, zuBarSortItems, zuBarFoldOrder, ZU_BAR_KEYS, ZU_BAR_TITLES};', context);
  return context.api;
}
test('order normalization rejects unknown/duplicate keys without losing new defaults', () => {
  const api = logic();
  const order = Array.from(api.zuBarOrderNormalize(['sub','sub','fake','speed','tools']));
  assert.deepEqual(order, ['sub','speed','tools','turn','win','today','proj','sysmon']);   // v356：sysmon 缺项补尾（老配置自动追加）
  assert.equal(new Set(order).size, api.ZU_BAR_KEYS.length);
  /* v356：老用户只有七项配置时 sysmon 自动补尾，不破坏已有相对顺序 */
  const legacy = Array.from(api.zuBarOrderNormalize(['win','speed']));
  assert.deepEqual(legacy.slice(0, 2), ['win','speed']);
  assert.equal(legacy[legacy.length - 1], 'sysmon');
});
test('priority normalization tolerates invalid and legacy storage', () => {
  const api = logic();
  const raw = {speed: 'high', turn: 'low', tools: '__bad__', evil: 'high'};
  const priority = Object.fromEntries(Object.entries(api.zuBarPriorityNormalize(raw)));
  assert.equal(priority.speed, 'high');
  assert.equal(priority.turn, 'low');
  assert.equal(priority.tools, 'low');
  assert.ok(!('evil' in priority));
  /* v352 缺省按设计稿：会话累计=普通、子代理=低（既有持久化值不受影响，仅缺省形态） */
  assert.equal(api.zuBarPriorityNormalize(null).win, 'normal');
  assert.equal(api.zuBarPriorityNormalize(null).sub, 'low');
  assert.equal(api.zuBarPriorityNormalize(null).speed, 'high');
  assert.equal(api.zuBarPriorityNormalize(null).turn, 'high');
  assert.equal(api.zuBarPriorityNormalize(null).tools, 'low');
  /* v356：sysmon 缺省低优先级（默认关，打开后低先折让位给统计格） */
  assert.equal(api.zuBarPriorityNormalize(null).sysmon, 'low');
});
test('sort uses user order while keeping diagnostic warnings ahead of movable cells', () => {
  const api = logic();
  const rows = ['win', 'turn', 'system', 'sub', 'speed'].map((key,index) => ({key,index}));
  const result = Array.from(api.zuBarSortItems(rows,['sub','speed','win','turn','today','proj','tools']), r => r.key);
  assert.deepEqual(result, ['system','sub','speed','win','turn']);
});
test('fold order: low folds first, ties fold right-first, speed and system never fold', () => {
  const api = logic();
  const keys = ['speed','turn','win','today','proj','tools','sub'];
  const prio = {speed:'high', turn:'high', win:'normal', today:'normal', proj:'normal', tools:'low', sub:'low'};
  const order = api.zuBarFoldOrder(keys, prio).map(c => c.key);
  assert.deepEqual(order, ['sub','tools','proj','today','win','turn','speed']);
  /* 全部同优先级：同级按显示序靠右先收，speed 仍在最后 */
  const allHigh = api.zuBarFoldOrder(keys, {speed:'high',turn:'high',win:'high',today:'high',proj:'high',tools:'high',sub:'high'}).map(c => c.key);
  assert.equal(allHigh[0], 'sub');
  assert.equal(allHigh[allHigh.length - 1], 'speed');
  /* system 徽标与 speed 一样不参与折叠（rank -1 恒最后） */
  const withSystem = api.zuBarFoldOrder(['system','turn'], {turn:'low'}).map(c => c.key);
  assert.deepEqual(withSystem, ['turn','system']);
  /* 未知 key 按普通档折叠 */
  const unknown = api.zuBarFoldOrder(['mystery','tools'], {tools:'high'}).map(c => c.key);
  assert.deepEqual(unknown, ['mystery','tools']);
  /* v356 sysmon 参与折叠：默认 low 最先收（右先收在 sysmon 最右）；调高后存活到统计格之后 */
  const keys8 = keys.concat(['sysmon']);
  const low8 = api.zuBarFoldOrder(keys8, Object.assign({}, prio, {sysmon:'low'})).map(c => c.key);
  assert.equal(low8[0], 'sysmon');
  const high8 = api.zuBarFoldOrder(keys8, Object.assign({}, prio, {sysmon:'high'})).map(c => c.key);
  assert.equal(high8.indexOf('sysmon'), high8.indexOf('turn') - 1);   // high 同级右先收：sysmon 在 turn 之前被收
  assert.notEqual(high8[0], 'sysmon');
});
test('menu options carry localized name, live value and the folded cell reference', () => {
  function makeEl(tag) {
    return {
      tag, children: [], dataset: {}, attrs: {}, _text: '', _cls: '',
      set className(v) { this._cls = v; }, get className() { return this._cls; },
      appendChild(c) { this.children.push(c); return c; },
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      setAttribute(n, v) { this.attrs[n] = v; },
      querySelector(sel) { return sel === '.zu-more-value' ? this.children.find(c => c._cls === 'zu-more-value') || null : null; },
      querySelectorAll() { return []; },
    };
  }
  const cell = makeEl('span');
  cell.dataset.zuKey = 'win'; cell.dataset.zuFolded = '1';
  cell._text = '58.25万3轮 9次';
  cell.__tip = 'SESSION_TIP';
  const main = { querySelectorAll(sel) { return sel === ':scope > .it' ? [cell] : []; } };
  const morePanel = makeEl('div');
  const context = { main, morePanel, document: { createElement: makeEl }, L: (zh) => zh, ZU_BAR_TITLES: logic().ZU_BAR_TITLES };
  vm.runInNewContext(slice('    function moreEntriesSync() {', '    function syncBarOverflow() {') + '\nmoreEntriesSync();', context);
  assert.equal(morePanel.children.length, 1);   // 标题走 innerHTML 串（桩不解析），子元素仅 option 按钮
  const option = morePanel.children[0];
  assert.equal(option.dataset.zuKey, 'win');
  assert.equal(option._cls, 'zu-more-option');
  const name = option.children.find(c => c._cls === 'zu-more-name');
  const value = option.children.find(c => c._cls === 'zu-more-value');
  assert.ok(name, 'name span exists');
  assert.equal(name.textContent, '会话累计');
  assert.ok(value, 'value span exists');
  assert.equal(value.textContent, '58.25万3轮 9次');
  assert.equal(option.__zuCell, cell, 'option keeps the live cell reference');
  assert.equal(morePanel.__zuSig, 'win');
});
test('drag drop splices in both directions and persists through the dedicated writer', () => {
  const dragSource = getNamedSlice('barOrderHelpers') + '\n' +
    slice('    /* 自定义排序：HTML Drag and Drop', '    panel.addEventListener("click", function (e) {');
  const handlers = {};
  const state = {
    show: {}, lang: 'zh',
    barOrder: ['speed','turn','win','today','proj','tools','sub'],
    barPriority: {speed:'high',turn:'high',win:'normal',today:'normal',proj:'normal',tools:'low',sub:'low'},
  };
  let persisted = 0, renders = 0;
  const context = {
    panel: {
      addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
      querySelector: () => null,   // refreshLayoutEditor 无卡可换：直接返回
      querySelectorAll: () => [],
    },
    state,
    persistBarOrder: () => { persisted++; },
    renderAll: () => { renders++; },
    ariaLiveState: { textContent: '' },
    L: (zh) => zh,
    ZU_BAR_TITLES: { sub: ['子代理', 'Sub-agents'] },
    document: { createElement: () => ({ set innerHTML(v) {}, firstElementChild: null, classList: { contains: () => false } }) },
  };
  vm.runInNewContext(dragSource, context);
  assert.ok(handlers.dragstart && handlers.drop && handlers.dragend, 'drag listeners registered');
  const rowFor = key => ({ dataset: { zuLayoutKey: key }, classList: { add() {}, remove() {} }, contains: () => false });
  handlers.dragstart[0]({ target: { closest(sel) { return sel === '.zu-layout-row' ? rowFor('sub') : null; } }, dataTransfer: { setData() {} } });
  const dropOnto = key => handlers.drop[0]({
    target: { closest(sel) { return sel === '.zu-layout-row' ? rowFor(key) : null; } },
    preventDefault() {},
  });
  dropOnto('turn');   // 末位 sub 拖到第 1 位（from=6, to=1）；sysmon 缺项经归一化补尾
  assert.equal(state.barOrder.join('|'), 'speed|sub|turn|win|today|proj|tools|sysmon', '跨 realm 数组断言用 join');
  assert.equal(persisted, 1);
  assert.equal(renders, 1);
  handlers.dragstart[0]({ target: { closest(sel) { return sel === '.zu-layout-row' ? rowFor('sub') : null; } }, dataTransfer: { setData() {} } });
  dropOnto('tools');   // 拖回末位（from=1, to=6：向下滑动的 splice 数学）
  assert.equal(state.barOrder.join('|'), 'speed|turn|win|today|proj|tools|sub|sysmon');
  handlers.drop[0]({ target: { closest: () => null } });   // 无行：忽略不崩
  assert.equal(persisted, 2);
  handlers.dragend[0]({});
});
test('compiled renderer keeps the fold/menu/layout contract tokens', () => {
  for (const token of ['data-zu-layout-key', 'dragstart', 'zuBarSortItems', 'zuBarFoldOrder',
    'function syncBarOverflow()', 'zu-more-option', 'data-zu-folded', 'foldPrioritySig',
    'FOLD_HYS', 'moreEntriesRefresh', 'data-zu-endlead', 'foldTrigger'])
    assert.ok(source.includes(token), token);
  /* v352 折叠触发器必须双向：折叠态 slack≥FOLD_HYS 也要触发重算（单向溢出探针会让
   * 「已折叠且刚好装下」的折叠集在宽度跳变时永久冻结，pill 夹具实证） */
  assert.ok(source.includes('foldedKeys ? ovNow <= 1 - FOLD_HYS : ovNow > 1'), 'bidirectional fold trigger');
  /* speed 固定保护：折叠序纯函数排除 speed/system；设置页 speed 行用固定徽标替代开关 */
  assert.ok(source.includes('key === "system" || key === "speed"'), 'speed/system fold exemption');
  assert.ok(source.includes('zu-layout-fixed'), 'speed fixed badge');
  assert.ok(!source.includes('__zuMoreTipKey'), 'dead more-tip marker removed');
  /* v352 分层定案：窄宽三档（shrink 状态机）保留为前层，折叠仅在 shrink===2 仍溢出时接管 */
  assert.ok(source.includes('state.theme !== "default" || shrink !== 2'), 'fold gate on narrow tier');
  assert.ok(source.includes('foldDirty = true;   // 档位切换即重算折叠'), 'shrink tier change bumps foldDirty');
  assert.ok(source.includes('syncBarOverflow();'), 'track calls fold after narrow block');
});
