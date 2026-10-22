const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSub2api } = require('../quota-client.cjs');

const base = { isValid: true, mode: 'unrestricted', unit: 'USD' };
const parseError = (body) => assert.throws(() => normalizeSub2api(body), e => e.code === 'parse_error');

test('sub2api: explicit unrestricted wallet balance, including zero; remaining alone is not wallet', () => {
  for (const amount of [0, 7.25, -1]) {
    assert.deepEqual(normalizeSub2api({ ...base, balance: amount, remaining: 99 }), {
      label: 'sub2api', kind: 'balance', balance: { amount, currency: 'USD' },
    });
  }
  parseError({ ...base, remaining: 7 });
  for (const balance of [null, Infinity, '1e309']) parseError({ ...base, balance, remaining: 7 });
  assert.equal(normalizeSub2api({ ...base, mode: 'balance', remaining: 0 }).balance.amount, 0);
});

test('sub2api: key total quota is a summary, never wallet balance', () => {
  for (const mode of ['quota_limited', 'quota']) {
    const value = normalizeSub2api({ ...base, mode, remaining: 999,
      quota: { limit: '10', used: '3', remaining: '7', unit: 'USD' } });
    assert.deepEqual(value.quotaSummary, { limit: 10, used: 3, remaining: 7, currency: 'USD' });
    assert.equal(value.balance, undefined);
    assert.equal(value.windows, undefined);
    assert.equal(value.kind, 'plan');
  }
  assert.equal(normalizeSub2api({ ...base, mode: 'quota_limited',
    quota: { limit: 10, used: 10, remaining: 0 } }).quotaSummary.remaining, 0);
});

test('sub2api: official rate limit windows need no top-level unit or remaining', () => {
  const value = normalizeSub2api({ isValid: true, mode: 'quota_limited', rate_limits: [
    { window: '5h', limit: 10, used: 0, remaining: 10 },
    { window: '1d', limit: 20, used: 5, remaining: 15, reset_at: '2027-01-01T00:00:00Z' },
    { window: '7d', limit: 50, used: 50, remaining: 0 },
  ] });
  assert.deepEqual(Object.keys(value.windows), ['fiveHour', 'daily', 'weekly']);
  assert.deepEqual(value.windows.fiveHour, {
    percent: 0, used: 0, total: 10, remaining: 10, currency: 'USD', resetsAt: null,
  });
  assert.equal(value.windows.daily.percent, 25);
  assert.equal(value.windows.daily.resetsAt, '2027-01-01T00:00:00Z');
  assert.equal(value.windows.weekly.remaining, 0);
  assert.equal(value.balance, undefined);
  const combined = normalizeSub2api({ isValid: true, mode: 'quota_limited',
    quota: { limit: 100, used: 20, remaining: 80 },
    rate_limits: [{ window: '1d', limit: 10, used: 2, remaining: 8 }] });
  assert.equal(combined.quotaSummary.remaining, 80);
  assert.equal(combined.windows.daily.remaining, 8);
});

test('sub2api: existing unrestricted subscription remains a plan, not remaining wallet', () => {
  const value = normalizeSub2api({ ...base, remaining: 7, planName: 'Plan', subscription: {
    daily_limit_usd: 10, daily_usage_usd: 3,
    weekly_limit_usd: 50, weekly_usage_usd: 10,
    monthly_limit_usd: 100, monthly_usage_usd: 20,
    expires_at: '2027-01-01T00:00:00Z',
  } });
  assert.equal(value.balance, undefined);
  assert.equal(value.windows.daily.remaining, 7);
  assert.equal(value.windows.weekly.percent, 20);
  assert.equal(value.windows.monthly.percent, 20);
  assert.deepEqual(value.subscription, { name: 'Plan', expiresAt: '2027-01-01T00:00:00Z' });
});

test('sub2api: strict auth and recognized malformed shapes never fall back to legacy', () => {
  assert.throws(() => normalizeSub2api({ isValid: false }), e => e.code === 'auth_failed');
  assert.equal(normalizeSub2api({ hard_limit_usd: 10 }), null);
  for (const body of [
    { ...base, isValid: 'true', balance: 7 },
    { ...base, mode: 'unknown', balance: 7 },
    { ...base, unit: null, balance: 7 },
    { ...base, mode: 'quota_limited' },
    { ...base, mode: 'quota_limited', quota: {} },
    { ...base, mode: 'quota_limited', quota: { limit: 10, used: null, remaining: 10 } },
    { ...base, mode: 'quota_limited', rate_limits: [] },
    { ...base, subscription: {} },
  ]) parseError(body);
});

test('sub2api: nonfinite numbers and numeric strings cannot yield valid quotas', () => {
  for (const bad of [Infinity, -Infinity, NaN, '1e309', '-1e309', 'Infinity', null]) {
    parseError({ ...base, mode: 'balance', remaining: bad });
    parseError({ ...base, subscription: { daily_limit_usd: 10, daily_usage_usd: bad } });
    for (const field of ['limit', 'used', 'remaining']) {
      parseError({ ...base, mode: 'quota_limited', quota: { limit: 10, used: 3, remaining: 7, [field]: bad } });
      parseError({ isValid: true, mode: 'quota_limited', rate_limits: [
        { window: '1d', limit: 10, used: 3, remaining: 7, [field]: bad },
      ] });
    }
  }
});
