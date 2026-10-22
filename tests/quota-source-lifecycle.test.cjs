const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Q = require('../quota-client.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { primary = false, enabled } = {}) {
  let time = 1700000000000, updates = 0;
  const secrets = { sources: { openrouter: { apiKey: 'fixture-management-key' } } };
  if (enabled !== undefined) secrets.sources.openrouter.enabled = enabled;
  const calls = [];
  let client;
  client = Q.createQuotaClient({
    env: {}, now: () => time,
    secretsPath: '/virtual/quota-lifecycle/secrets.json',
    credsPath: '/virtual/quota-lifecycle/credentials.json',
    customCfgPath: '/virtual/quota-lifecycle/provider_config.json',
    readFile(p) {
      if (p.endsWith('secrets.json')) return JSON.parse(JSON.stringify(secrets));
      return { config: { providerConfigRules: { providerRules: [{ providerId: 'or',
        config: { api: { baseUrl: 'https://openrouter.ai/api/v1' },
          access: { apiKey: 'fixture-inference-key' } } }] } } };
    },
    fetchImpl(url, options) {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      calls.push({ url, options, resolve });
      return promise;
    },
    onUpdate() { updates++; client.view(); client.sourcesConfig(); },
  });
  if (primary) client.noteProvider('or');   // 统一调度器：该 provider 持独立复合源 openrouter:or
  t.after(() => client.dispose());
  return { client, secrets, calls, updates: () => updates,
    advance: () => { time += 16 * 60 * 1000; } };
}
function answer(call, status = 200) {
  call.resolve({ status, text: async () => JSON.stringify({ data: { total_credits: 20, total_usage: 5 } }) });
}

for (const primary of [false, true]) {
  test(`explicit disable clears value and rejects late result (primary=${primary})`, async t => {
    const x = fixture(t, { primary });
    x.client.tick(); answer(x.calls[0]); await flush();
    assert.equal(x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'].balance.amount, 15);
    x.client.refreshSource('openrouter');
    x.secrets.sources.openrouter.enabled = false;
    x.client.credentialsChanged(); x.client.tick();
    const before = x.updates();
    answer(x.calls[1]); await flush();
    const v = x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'];
    assert.equal(v.status, 'disabled');
    assert.equal(v.balance, undefined);
    assert.equal(v.fetchedAt, 0);
    assert.equal(x.client.sourcesConfig().find(s => s.id === 'openrouter').status, 'disabled');
    assert.equal(x.calls[1].options.signal.aborted, true);
    assert.equal(x.updates(), before, 'late success and view/settings never recursively notify');
    x.client.refreshSource('openrouter');
    assert.equal(x.calls.length, 2);
    x.secrets.sources.openrouter.enabled = true;
    x.client.credentialsChanged(); x.client.tick();
    assert.equal(x.calls.length, 3, 're-enable permits a fresh query');
    answer(x.calls[2]); await flush();
    assert.equal(x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'].status, 'ok');
  });
}

for (const enabled of [undefined, true]) {
  test(`deleting management key clears automatic/explicit source (enabled=${enabled})`, async t => {
    const x = fixture(t, { enabled });
    x.client.tick(); answer(x.calls[0]); await flush();
    x.client.refreshSource('openrouter');
    delete x.secrets.sources.openrouter.apiKey;
    x.client.credentialsChanged(); // Must revoke without tick, including when the global switch is off.
    answer(x.calls[1]); await flush();
    assert.equal(x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'].status, 'not_configured');
    assert.equal(x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'].balance, undefined);
    assert.equal(x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'].fetchedAt, 0);
    assert.equal(x.client.sourcesConfig().find(s => s.id === 'openrouter').keyConfigured, false);
    x.client.tick(); assert.equal(x.calls.length, 2);
    x.secrets.sources.openrouter.apiKey = 'replacement-fixture-key';
    x.client.credentialsChanged(); x.client.tick();
    assert.equal(x.calls.length, 3);
    answer(x.calls[2]); await flush();
    assert.equal(x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'].balance.amount, 15);
  });
}

test('view and settings alone revoke deleted credentials without network or callbacks', async t => {
  const x = fixture(t, { primary: true });
  x.client.tick(); answer(x.calls[0]); await flush();
  const before = x.updates();
  delete x.secrets.sources.openrouter.apiKey;
  const v = x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'];
  assert.equal(v.status, 'not_configured');
  assert.equal(v.balance, undefined);
  assert.equal(x.client.sourcesConfig().find(s => s.id === 'openrouter').status, 'not_configured');
  assert.equal(x.calls.length, 1);
  assert.equal(x.updates(), before);
});

test('network failure preserves the last successful value and stale timestamp', async t => {
  const x = fixture(t);
  x.client.tick(); answer(x.calls[0]); await flush();
  const fetchedAt = x.client.view().sources.openrouter.fetchedAt;
  x.advance(); x.client.tick(); answer(x.calls[1], 503); await flush();
  const v = x.client.view().sources[x.client.view().byProvider['or'] || 'openrouter'];
  assert.equal(v.status, 'network_error');
  assert.equal(v.balance.amount, 15);
  assert.equal(v.fetchedAt, fetchedAt);
  assert.equal(v.stale, true);
});

test('writeQuotaSecrets pushes revoked quota immediately, but never fetches with global switch off', () => {
  const source = fs.readFileSync(require.resolve('../inject-main.cjs'), 'utf8');
  const start = source.indexOf('function writeQuotaSecrets(mutate) {');
  const end = source.indexOf('\nfunction handleQuotaSourceRequest', start);
  for (const enabled of [false, true]) {
    const events = [], pushes = [];
    const sandbox = {
      readQuotaSecrets: () => ({ sources: {} }), HERE: '/virtual/runtime',
      path: require('node:path'), fs: { writeFileSync() {}, renameSync() {}, chmodSync() {} },
      LOG() {}, quotaEnabled: () => enabled,
      quotaClient: { credentialsChanged: () => events.push('changed'), tick: () => events.push('tick'),
        view: () => ({ sources: { openrouter: { status: 'disabled' } } }) },
      lastGoodPayload: { fixture: true }, webContents: { getAllWebContents: () => ['window'] },
      pushOnce: (wc, payload) => pushes.push(payload), broadcastPluginState: () => events.push('settings'),
    };
    vm.runInNewContext(source.slice(start, end) + '\nwriteQuotaSecrets(sec => { sec.openrouter = {enabled:false}; });', sandbox);
    assert.deepEqual(events, enabled ? ['changed', 'tick', 'settings'] : ['changed', 'settings']);
    assert.equal(pushes.length, enabled ? 1 : 0);
    if (enabled) assert.equal(pushes[0].quota.sources.openrouter.status, 'disabled');
  }
});
