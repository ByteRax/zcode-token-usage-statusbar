const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuotaClient } = require('../quota-client.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  let rules = ['a', 'b'].map(id => ({ providerId: id,
    config: { api: { baseUrl: `https://${id}.invalid/v1` },
      access: { apiKey: `fixture-${id}` } } }));
  const calls = [];
  let updates = 0;
  const client = createQuotaClient({
    env: {}, now: () => 1700000000000,
    credsPath: '/virtual/provider-revoke/credentials.json',
    customCfgPath: '/virtual/provider-revoke/providers.json',
    secretsPath: '/virtual/provider-revoke/secrets.json',
    readFile(p) {
      if (p.endsWith('/providers.json')) {
        return { config: { providerConfigRules: { providerRules: rules } } };
      }
      if (p.endsWith('/secrets.json')) return { sources: {} };
      throw new Error('unexpected fixture read');
    },
    fetchImpl(url, options) {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      calls.push({ url, options, resolve });
      return promise;
    },
    onUpdate() { updates++; client.view(); client.sourcesConfig(); },
  });
  t.after(() => client.dispose());
  return { client, calls, updates: () => updates,
    deleteA() { rules = rules.filter(r => r.providerId !== 'a'); } };
}

function answer(call, balance) {
  call.resolve({ status: 200, text: async () => JSON.stringify({
    isValid: true, mode: 'unrestricted', unit: 'USD', balance,
  }) });
}

function assertRevoked(client) {
  const view = client.view();
  const a = view.sources[view.byProvider.a];
  assert.ok(a, 'registered A keeps an unavailable entry for its pane');
  assert.notEqual(a.status, 'ok');
  assert.equal(a.balance, undefined);
  assert.equal(a.fetchedAt, 0);
  assert.equal(client._states.get(view.byProvider.a).ctx, null);
  assert.equal(view.active, 'custom:b');
  assert.equal(view.sources['custom:b'].status, 'ok');
  assert.equal(view.sources['custom:b'].balance.amount, 34);
  assert.equal(view.balance.amount, 34, 'primary mirror remains B');
}

test('non-primary provider deletion revokes its successful balance without tick or network', async t => {
  const x = fixture(t);
  x.client.noteProvider('a'); x.client.tick();
  answer(x.calls[0], 12); await flush();
  assert.equal(x.client.view().sources['custom:a'].balance.amount, 12);
  x.client.noteProvider('b'); x.client.tick();
  answer(x.calls[1], 34); await flush();
  assert.equal(x.client.view().sources['custom:a'].balance.amount, 12,
    'focus switch alone does not revoke valid A');

  x.deleteA();
  const updates = x.updates();
  x.client.credentialsChanged();
  assertRevoked(x.client);
  assert.equal(x.calls.length, 2);
  assert.equal(x.updates(), updates, 'revocation and view do not recursively notify');
});

test('revoked non-primary provider aborts its in-flight refresh and ignores late success', async t => {
  const x = fixture(t);
  x.client.noteProvider('a'); x.client.tick();
  answer(x.calls[0], 12); await flush();
  x.client.refresh();
  const pendingA = x.calls[1];
  assert.equal(pendingA.options.signal.aborted, false);
  x.client.noteProvider('b'); x.client.tick();
  answer(x.calls[2], 34); await flush();

  x.deleteA();
  x.client.credentialsChanged();
  assertRevoked(x.client);
  assert.equal(pendingA.options.signal.aborted, true);
  const updates = x.updates();
  // Deliberately ignore AbortSignal in the mock to exercise the epoch guard too.
  answer(pendingA, 999); await flush();
  assertRevoked(x.client);
  assert.equal(x.calls.length, 3);
  assert.equal(x.updates(), updates, 'late success must not publish a restored balance');
});
