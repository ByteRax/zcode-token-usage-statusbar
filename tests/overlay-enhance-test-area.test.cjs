const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/overlay/09-instance-settings-and-notes.js'), 'utf8');
const a = source.indexOf('    var epTest =');
const b = source.indexOf('    function epRisk(', a);
assert.ok(a > 0 && b > a);
function harness() {
  const fields = Object.fromEntries(['draft', 'result', 'empty', 'status', 'run', 'cancel'].map(n => ['.zu-ep-test-' + n, { value: '', textContent: '', hidden: false, disabled: false, classList: { toggles: [], toggle(c, on) { this.toggles.push([c, on]); } } }]));
  fields['.zu-ep-mode'] = { value: 'custom' };
  fields['.zu-ep-key'] = { value: '' };
  const requests = [], callbacks = {}, timers = new Map(); let seq = 0;
  const context = { panel: { querySelector: s => fields[s] }, state: { pluginUpdate: { enhanceProvider: { capability: 1, available: true, revision: 2, mode: 'custom', model: 'fixture', baseUrl: 'https://example.test' } } },
    epSaving: false, epConflict: false, epEditVersion: 0, epCleanVersion: 0, epSavedRevision: 2,
    epValue: s => fields[s] ? fields[s].value : '',
    epForm: () => ({ mode: fields['.zu-ep-mode'].value, source: 'host', providerId: 'fixture-provider', baseUrl: 'https://example.test', protocol: 'openai-responses', model: 'fixture' }),
    quotaSelection: { providerId: 'p', modelId: 'm' }, readQuotaSelection: () => false, enhanceCurrentScope: () => 'scope', inactive: () => false, L: zh => zh,
    pluginRequest(action, opts, cb) { const id = cb ? 'r' + (++seq) : ''; requests.push({ action, opts, id }); if (cb) callbacks[id] = cb; return id; },
    forgetPluginRequest(id) { delete callbacks[id]; }, setTimeout(fn) { timers.set(++seq, fn); return seq; }, clearTimeout(id) { timers.delete(id); }, Date, JSON };
  vm.runInNewContext(source.slice(a, b) + '\nthis.api={start:epTestStart,stop:epTestStop,state:epTest,render:epTestRender};', context);
  return { context, fields, requests, callbacks, timers, api: context.api };
}
test('blank and oversized drafts never send a request', () => {
  const h = harness(); h.api.state.draft = '  '; h.api.start(); assert.equal(h.requests.length, 0);
  h.api.state.draft = 'x'.repeat(20001); h.api.start(); assert.equal(h.requests.length, 0);
});
test('dirty custom configuration still tests using the form snapshot', () => {
  const h = harness(); h.api.state.draft = 'draft'; h.context.epEditVersion = 5; h.api.start();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].action, 'prompt-enhance-v2');
  assert.equal(h.requests[0].opts.revision, 2);
  assert.equal(h.requests[0].opts.form.providerId, 'fixture-provider');
  assert.equal(h.requests[0].opts.formApiKey, undefined);
});
test('unselected host provider blocks the test without sending', () => {
  const h = harness(); h.context.epForm = () => ({ mode: 'custom', source: 'host', providerId: '', baseUrl: '', protocol: 'openai-responses', model: 'fixture' });
  h.api.state.draft = 'draft'; h.api.start();
  assert.equal(h.requests.length, 0); assert.match(h.api.state.status, /先点击选择一个供应商/);
});
test('manual draft carries the typed key once without saving it', () => {
  const h = harness(); h.context.epForm = () => ({ mode: 'custom', source: 'manual', providerId: '', baseUrl: 'https://relay.test', protocol: 'openai-responses', model: 'fixture' });
  h.fields['.zu-ep-key'].value = ' fixture-key '; h.api.state.draft = 'draft'; h.api.start();
  assert.equal(h.requests[0].opts.formApiKey, 'fixture-key');
  assert.equal(h.fields['.zu-ep-key'].value, ' fixture-key ');
});
test('custom form request leaves draft intact and shows duration on success', () => {
  const h = harness(); h.api.state.draft = 'hello\nworld'; h.api.start();
  assert.equal(h.requests[0].opts.text, 'hello\nworld');
  h.callbacks.r1({ ok: true, text: '<script>plain</script>\nresult' });
  assert.equal(h.fields['.zu-ep-test-result'].textContent, '<script>plain</script>\nresult'); assert.equal(h.api.state.draft, 'hello\nworld');
  assert.match(h.fields['.zu-ep-test-status'].textContent, /测试成功 · fixture-provider · fixture/); assert.equal(h.timers.size, 0);
  h.api.state.draft = 'srv'; h.api.start(); h.callbacks[Object.keys(h.callbacks).at(-1)]({ ok: true, text: 'x', serverModel: 'other-model' });
  assert.match(h.fields['.zu-ep-test-status'].textContent, /（服务端返回：other-model）/);
});
test('failure surfaces the interface error detail in the error color', () => {
  const h = harness(); h.api.state.draft = 'draft'; h.api.start();
  h.callbacks.r1({ ok: false, error: 'HTTP 401', detail: '{"error":{"code":"1002","message":"token invalid"}}' });
  assert.match(h.fields['.zu-ep-test-status'].textContent, /增强失败：.*token invalid/);
  assert.deepEqual(h.fields['.zu-ep-test-status'].classList.toggles.at(-1), ['zu-ep-test-err', true]);
  assert.equal(h.api.state.failed, true); assert.equal(h.timers.size, 0);
  h.api.start = h.api.start; h.api.state.draft = 'again'; h.api.start();
  h.callbacks.r3({ ok: true, text: 'ok' });
  assert.equal(h.api.state.failed, false);
  assert.deepEqual(h.fields['.zu-ep-test-status'].classList.toggles.at(-1), ['zu-ep-test-err', false]);
});
test('internal status codes are localized instead of shown as interface errors', () => {
  const h = harness(); h.api.state.draft = 'draft'; h.api.start();
  h.callbacks.r1({ ok: false, error: 'enhance provider settings changed' });
  assert.equal(h.fields['.zu-ep-test-status'].textContent, '已保存配置已变化，请重新打开设置后再试。');
  assert.equal(h.fields['.zu-ep-test-status'].textContent.indexOf('enhance '), -1);
});
test('cancel sends existing abort action and ignores a stale callback', () => {
  const h = harness(); h.api.state.draft = 'draft'; h.api.start(); const stale = h.callbacks.r1;
  h.api.stop('cancelled'); assert.equal(h.requests[1].action, 'prompt-enhance-cancel'); assert.equal(h.requests[1].opts.requestId, 'r1');
  stale({ ok: true, text: 'old result' }); assert.equal(h.api.state.result, ''); assert.equal(h.timers.size, 0);
});
test('late response after configuration revision changes cannot appear as success', () => {
  const h = harness(); h.api.state.draft = 'draft'; h.api.start(); h.context.state.pluginUpdate.enhanceProvider.revision = 3;
  h.callbacks.r1({ ok: true, text: 'stale' }); assert.equal(h.api.state.result, ''); assert.match(h.api.state.status, /变化/);
});
test('default mode follows the saved mode and requires a verified session model', () => {
  const h = harness(); h.api.state.draft = 'draft'; h.fields['.zu-ep-mode'].value = 'default';
  h.context.enhanceCurrentScope = () => ''; h.api.start(); assert.equal(h.requests.length, 0);
  h.context.enhanceCurrentScope = () => 'scope'; h.api.start();
  assert.equal(h.requests.length, 0); assert.match(h.api.state.status, /先保存/);
  h.context.state.pluginUpdate.enhanceProvider.mode = 'default'; h.api.start();
  assert.equal(h.requests[0].action, 'prompt-enhance'); assert.equal(h.requests[0].opts.modelId, 'm');
});
