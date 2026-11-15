const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/overlay/09-instance-settings-and-notes.js'), 'utf8');
const start = source.indexOf('    var epEditVersion =');
const end = source.indexOf('    function epValue(', start);
assert.ok(start >= 0 && end > start);

function harness() {
  const fields = {};
  for (const name of ['mode', 'source', 'url', 'protocol', 'model', 'key', 'host', 'preset', 'search', 'model-list', 'reload', 'status']) {
    fields['.zu-ep-' + name] = { value: '', textContent: '', hidden: true };
  }
  const calls = [];
  const context = {
    panel: { querySelector: selector => fields[selector] },
    L: (zh) => zh,
    epRender: () => calls.push('render'),
    epLoadHosts: force => calls.push(['load', force]),
    epApplyModelCache: () => false,
    epForm: () => ({ mode: fields['.zu-ep-mode'].value, source: fields['.zu-ep-source'].value, providerId: fields['.zu-ep-host'].value, baseUrl: fields['.zu-ep-url'].value, protocol: fields['.zu-ep-protocol'].value, model: fields['.zu-ep-model'].value }),
    Number, JSON,
  };
  vm.runInNewContext(source.slice(start, end) + `
    globalThis.api = {
      reconcile: epReconcile,
      capture: epCaptureDraft,
      restore: epRestoreDraft,
      edit: () => { epEditVersion++; },
      startSave: () => { epSaving = true; },
      endSave: () => { epSaving = false; },
      saved: () => epSavedRevision,
      conflict: () => epConflict,
      modelVersion: () => epModelRequest
    };`, context);
  return { fields, calls, api: context.api };
}

const config = (revision, model) => ({ revision, mode: 'custom', source: 'manual', baseUrl: 'https://example.test/v1', protocol: 'openai-chat-completions', model });

test('other window update refreshes a clean form and revision', () => {
  const h = harness();
  h.api.reconcile(config(1, 'model-a'));
  const before = h.api.modelVersion();
  h.api.reconcile(config(2, 'model-b'));
  assert.equal(h.fields['.zu-ep-model'].value, 'model-b');
  assert.equal(h.api.saved(), 2);
  assert.equal(h.api.conflict(), false);
  assert.equal(h.fields['.zu-ep-reload'].hidden, true);
  assert.ok(h.api.modelVersion() > before, 'old model responses invalidated');
});

test('other window update preserves dirty draft and requires explicit reload', () => {
  const h = harness();
  h.api.reconcile(config(1, 'model-a'));
  h.fields['.zu-ep-model'].value = 'draft-model';
  h.fields['.zu-ep-key'].value = 'fixture-key';
  h.api.edit();
  h.api.reconcile(config(2, 'model-b'));
  assert.equal(h.fields['.zu-ep-model'].value, 'draft-model');
  assert.equal(h.fields['.zu-ep-key'].value, 'fixture-key');
  assert.equal(h.api.saved(), 1);
  assert.equal(h.api.conflict(), true);
  assert.equal(h.fields['.zu-ep-reload'].hidden, false);
  assert.match(h.fields['.zu-ep-status'].textContent, /其他窗口/);
});

test('rebuilding the panel preserves unsaved draft and conflict state in memory', () => {
  const h = harness();
  h.api.reconcile(config(1, 'model-a'));
  h.fields['.zu-ep-model'].value = 'draft-model';
  h.fields['.zu-ep-key'].value = 'fixture-key';
  h.fields['.zu-ep-preset'].value = 'openai';
  h.api.edit();
  h.api.reconcile(config(2, 'model-b'));
  const draft = h.api.capture();
  for (const field of Object.values(h.fields)) { field.value = ''; field.textContent = ''; field.hidden = true; delete field.__zuInitialized; }
  h.api.restore(draft);
  h.api.reconcile(config(2, 'model-b'));
  assert.equal(h.fields['.zu-ep-model'].value, 'draft-model');
  assert.equal(h.fields['.zu-ep-key'].value, 'fixture-key');
  assert.equal(h.fields['.zu-ep-preset'].value, 'openai');
  assert.equal(h.api.saved(), 1);
  assert.equal(h.fields['.zu-ep-reload'].hidden, false);
  assert.match(h.fields['.zu-ep-status'].textContent, /其他窗口/);
});

test('rebuilding a host draft reloads the provider list with pending selection', () => {
  const h = harness();
  h.api.reconcile({ ...config(1, 'model-a'), source: 'host', providerId: 'host-a' });
  h.fields['.zu-ep-host'].__zuPendingId = 'host-a';
  const draft = h.api.capture();
  h.fields['.zu-ep-host'].value = '';
  h.api.restore(draft);
  assert.equal(h.fields['.zu-ep-host'].__zuPendingId, 'host-a');
  assert.deepEqual(h.calls.at(-1), ['load', false]);   // 重建后优先用缓存，不强制拉取
});

test('broadcast during save is reconciled after save completes', () => {
  const h = harness();
  h.api.reconcile(config(1, 'model-a'));
  h.api.startSave();
  h.api.reconcile(config(2, 'model-b'));
  assert.equal(h.api.saved(), 1);
  h.api.endSave();
  h.api.reconcile(config(2, 'model-b'));
  assert.equal(h.api.saved(), 2);
  assert.equal(h.fields['.zu-ep-model'].value, 'model-b');
});
