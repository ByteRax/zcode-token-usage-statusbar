'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
function slice(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'missing source anchors: ' + start);
  return source.slice(a, b);
}
const helpers = slice('  var ZU_BAR_KEYS =', '  var state = {');
function logic() {
  const context = {};
  vm.runInNewContext(helpers + '\nglobalThis.api = {zuBarOrderNormalize, zuBarPriorityNormalize, zuBarSortItems, ZU_BAR_KEYS};', context);
  return context.api;
}
test('order normalization rejects unknown/duplicate keys without losing new defaults', () => {
  const api = logic();
  const order = Array.from(api.zuBarOrderNormalize(['sub','sub','fake','speed','tools']));
  assert.deepEqual(order, ['sub','speed','tools','turn','win','today','proj']);
  assert.equal(new Set(order).size, api.ZU_BAR_KEYS.length);
});
test('priority normalization tolerates invalid and legacy storage', () => {
  const api = logic();
  const raw = {speed: 'high', turn: 'low', tools: '__bad__', evil: 'high'};
  const priority = Object.fromEntries(Object.entries(api.zuBarPriorityNormalize(raw)));
  assert.equal(priority.speed, 'high');
  assert.equal(priority.turn, 'low');
  assert.equal(priority.tools, 'low');
  assert.ok(!('evil' in priority));
  assert.equal(api.zuBarPriorityNormalize(null).win, 'high');
});
test('sort uses user order while keeping diagnostic warnings ahead of movable cells', () => {
  const api = logic();
  const rows = ['win', 'turn', 'system', 'sub', 'speed'].map((key,index) => ({key,index}));
  const result = Array.from(api.zuBarSortItems(rows,['sub','speed','win','turn','today','proj','tools']), r => r.key);
  assert.deepEqual(result, ['system','sub','speed','win','turn']);
});
test('compiled renderer includes the drag, priority, and adaptive fold controls', () => {
  for (const token of ['data-zu-layout-key', 'data-zu-priority', 'dragstart',
    'zuBarSortItems', 'function syncBarOverflow()', 'zu-more-option',
    'data-zu-folded', 'foldPrioritySig']) assert.ok(source.includes(token), token);
});
