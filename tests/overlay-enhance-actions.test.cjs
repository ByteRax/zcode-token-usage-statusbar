const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/overlay/09-instance-settings-and-notes.js'), 'utf8');
const a = source.indexOf('      var epAction = e.target.closest');
const b = source.indexOf('      if (typeof zuRotatorPanelClick', a);
assert.ok(a > 0 && b > a);
function harness(action) {
  const fields = Object.fromEntries(['status', 'key', 'save', 'models', 'model-list', 'model-status'].map(n => ['.zu-ep-' + n, { value: '', textContent: '', disabled: false, children: [], appendChild(el) { this.children.push(el); } }]));
  const requests = [], modelRequests = [], timers = [], confirmCalls = [];
  let confirms = true;
  const ctx = { panel: { querySelector: s => fields[s] }, state: { pluginUpdate: { enhanceProvider: { available: true, revision: 1 } } },
    epSavedRevision: 1, epEditVersion: 0, epCleanVersion: 0, epModelRequest: 0, epSaving: false, epConflict: false,
    epForm: () => ({ mode: 'custom', source: 'manual', baseUrl: 'https://example.test', protocol: 'openai-responses', model: 'fixture' }),
    epModelCache: {},
    epReconcile() {}, epRender() {}, epLoadHosts() {}, epApplySaved() {}, inactive: () => false, L: zh => zh,
    window: {}, document: { createElement: () => ({}) },
    zuConfirm: (t, d, okText, onOk) => { confirmCalls.push({ t, d, okText, onOk }); if (confirms) onOk(); },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    pluginRequest: (name, opts, done) => requests.push({ name, opts, done }),
    epRequestModels(f, key, done) { modelRequests.push({ f, key, done }); return true; },
    epValue: s => (fields[s] ? fields[s].value : ''),
    epModelsErrorText: () => 'models failed',
    /* v352 合并后 click 头部新增排序 reset/shift 分支：closest 桩收紧为仅命中含 action 名的选择器，
     * 否则 .zu-layout-reset 查询也被误命中、提前走进排序分支（zuBarPriorityNormalize 未注入） */
    e: { target: { closest: sel => sel && sel.indexOf(action) >= 0 ? ({ classList: { contains: name => name === action } }) : null } } };
  vm.runInNewContext('function click() {\n' + source.slice(a, b) + '\n}', ctx);
  return { ctx, fields, requests, modelRequests, timers, confirmCalls, click: () => ctx.click(), confirm: value => { confirms = value; } };
}
test('unselected host card gives actionable feedback without sending a request', () => {
  for (const action of ['zu-ep-models', 'zu-ep-save']) {
    const h = harness(action);
    h.ctx.epForm = () => ({ mode: 'custom', source: 'host', providerId: '' });
    h.click();
    assert.equal(h.requests.length, 0);
    assert.match(h.fields['.zu-ep-status'].textContent, /先点击选择一个供应商/);
  }
});
test('selected host snapshot is used when fetching models', () => {
  const h = harness('zu-ep-models');
  h.ctx.epForm = () => ({ mode: 'custom', source: 'host', providerId: 'fixture-provider', baseUrl: 'https://example.test', protocol: 'openai-responses' });
  h.click();
  assert.equal(h.modelRequests.length, 1);
  assert.equal(h.modelRequests[0].f.providerId, 'fixture-provider');
  h.modelRequests[0].done({ ok: true, models: ['model-a', 'model-b'] });
  assert.match(h.fields['.zu-ep-model-status'].textContent, /模型列表已获取/);
});
test('late model response after an edit never replaces model choices or status', () => {
  const h = harness('zu-ep-models'); h.click();
  h.ctx.epEditVersion++;
  h.modelRequests[0].done({ ok: true, models: ['stale-model'] });
  assert.equal(h.fields['.zu-ep-model-list'].children.length, 0, 'helper serial/version guard drops the stale reply');
});
test('key removal cancellation sends no transaction', () => {
  const h = harness('zu-ep-remove'); h.confirm(false); h.click(); assert.equal(h.requests.length, 0);
});
test('key removal confirmation sends clear rather than the draft key', () => {
  const h = harness('zu-ep-remove'); h.fields['.zu-ep-key'].value = 'fixture-key'; h.click();
  assert.equal(h.requests[0].opts.changes.keyAction, 'clear');
  assert.equal(h.requests[0].opts.changes.apiKey, undefined);
});
test('removing a saved key does not mark unrelated edits clean or clear a replacement draft', () => {
  const h = harness('zu-ep-remove'); h.ctx.epEditVersion = 3; h.ctx.epCleanVersion = 1;
  h.fields['.zu-ep-key'].value = 'replacement-fixture'; h.click();
  h.requests[0].done({ ok: true, provider: { revision: 2, available: true } });
  assert.equal(h.ctx.epCleanVersion, 1);
  assert.equal(h.fields['.zu-ep-key'].value, 'replacement-fixture');
  assert.match(h.fields['.zu-ep-status'].textContent, /其他未保存修改/);
});
test('save response after DOM rebuild clears the current key and updates current status', () => {
  const h = harness('zu-ep-save'); h.fields['.zu-ep-key'].value = 'fixture-key'; h.click();
  h.fields['.zu-ep-key'] = { value: 'fixture-key' }; h.fields['.zu-ep-status'] = { textContent: '' };
  h.requests[0].done({ ok: true, provider: { revision: 2, available: true } });
  assert.equal(h.fields['.zu-ep-key'].value, '');
  assert.equal(h.fields['.zu-ep-status'].textContent, '配置已保存');
  assert.equal(h.ctx.epSavedRevision, 2);
});
test('successful save refreshes the saved-form baseline so reopening is never falsely dirty', () => {
  const h = harness('zu-ep-save');
  h.fields['.zu-ep-key'].value = 'fixture-key';
  h.ctx.epSavedFormJson = '{"mode":"custom","stale":true}';   // 打开面板时的旧基准
  h.ctx.epForm = () => ({ mode: 'custom', source: 'manual', baseUrl: 'https://example.test', protocol: 'openai-responses', model: 'fixture', providerId: '', allowDowngrade: true, saveHistory: false });
  h.click();
  assert.equal(h.requests[0].name, 'enhance-provider-save');
  h.requests[0].done({ ok: true, provider: { revision: 2, available: true } });
  assert.deepEqual(JSON.parse(h.ctx.epSavedFormJson), h.ctx.epForm(), 'baseline must match the just-saved form');
});
test('failed save keeps the stale baseline so the unsaved marker stays honest', () => {
  const h = harness('zu-ep-save');
  h.ctx.epSavedFormJson = '{"mode":"custom","stale":true}';
  h.ctx.epForm = () => ({ mode: 'custom', source: 'manual', baseUrl: 'https://example.test', protocol: 'openai-responses', model: 'fixture', providerId: '', allowDowngrade: true, saveHistory: false });
  h.click();
  h.requests[0].done({ ok: false, error: 'provider unavailable' });
  assert.equal(h.ctx.epSavedFormJson, '{"mode":"custom","stale":true}', 'failed save must not clear the dirty marker');
});
