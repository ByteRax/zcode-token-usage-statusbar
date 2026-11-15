const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/overlay/09-instance-settings-and-notes.js'), 'utf8');
const a = source.indexOf('    var epHostCache =');
const b = source.indexOf('    function syncPanel(', a);
assert.ok(a > 0 && b > a);

function harness() {
  const els = {};
  for (const name of ['host', 'host-grid', 'host-status', 'model-list', 'model-status']) {
    els['.zu-ep-' + name] = { value: '', textContent: '', children: [], options: [{ value: '' }], selectedIndex: 0,
      appendChild(el) { this.children.push(el); if (el.optionValue !== undefined) this.value = el.optionValue; },
      __zuPendingId: '' };
  }
  const requests = [];
  let now = 1000000;
  const context = { panel: { querySelector: s => els[s] }, inactive: () => false, L: zh => zh, Date: { now: () => now },
    epHostsLoaded: false, epHostRequest: 0,
    document: { createElement: tag => ({ optionValue: undefined, dataset: {}, appendChild() { }, setAttribute() { }, set textContent(v) { if (tag === 'option') this.optionValue = v; } }) },
    URL, pluginRequest(action, opts, cb) { requests.push(cb); },
    setTimeout: () => 1 };
  vm.runInNewContext(source.slice(a, b) + '\nthis.api={load:epLoadHosts,models:epApplyModelCache,cache:()=>({hosts:epHostCache,at:epHostCacheAt,models:epModelCache}),markLoaded:()=>{epHostsLoaded=true;}};', context);
  return { els, requests, context, api: context.api, advance: ms => { now += ms; } };
}
const providers = [{ id: 'a', name: 'A', baseUrl: 'https://a.test', protocol: 'openai-responses' }];

test('provider list is served from memory cache without a second request', () => {
  const h = harness();
  h.api.load(false); assert.equal(h.requests.length, 2, 'disk-cache ask + fresh fetch');
  h.requests[1]({ ok: true, providers });
  assert.equal(h.els['.zu-ep-host-grid'].children.length, 1);
  h.advance(1000);
  h.api.load(false); assert.equal(h.requests.length, 2, 'loaded flag short-circuits refetch');
  h.advance(300000); h.context.epHostsLoaded = false; h.api.load(false); assert.equal(h.requests.length, 4, 'expired cache refetches on reopen (disk + fresh)');
});
test('refresh button bypasses the cache and updates it', () => {
  const h = harness(); h.api.load(false); h.requests[1]({ ok: true, providers });
  h.api.load(true); assert.equal(h.requests.length, 3, 'force skips the disk-cache ask');
  h.requests[2]({ ok: true, providers: providers.concat([{ id: 'b', name: 'B', baseUrl: 'https://b.test', protocol: 'anthropic-messages' }]) });
  assert.equal(h.api.cache().hosts.length, 2);
});
test('model list cache restores per target and expires after ten minutes', () => {
  const h = harness();
  const form = { source: 'host', providerId: 'a', baseUrl: 'https://a.test', protocol: 'openai-responses' };
  assert.equal(h.api.models(form), false);
  h.api.cache().models[JSON.stringify([form.source, form.providerId, form.baseUrl, form.protocol])] = { models: ['m1', 'm2'], at: h.context.Date.now() };
  assert.equal(h.api.models(form), true);
  assert.deepEqual(h.els['.zu-ep-model-list'].children.map(o => o.value), ['m1', 'm2']);
  assert.match(h.els['.zu-ep-model-status'].textContent, /缓存/);
  h.advance(600001);
  assert.equal(h.api.models(form), false, 'stale model cache is ignored');
});
