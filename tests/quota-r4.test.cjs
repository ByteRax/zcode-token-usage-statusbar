const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* R4 Coder 适配器（custom provider baseUrl 指向 api.r4.codes）：
 * GET /v1/cli/key  调用 Key 的 limit/spent/held（reserve gate 口径）
 * GET /v1/cli/meta 套餐池、limit_windows（如 5 小时 ceiling）、钱包余额与到期
 * 夹具取自 2026-11-17 真实响应（金额/窗口字段原样，key 名与起始串已脱敏）。 */
const ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };
const T0 = 1700000000000;
const KEY_URL = "https://api.r4.codes/v1/cli/key";
const META_URL = "https://api.r4.codes/v1/cli/meta";

function deferred() {
  let resolve, reject;
  const p = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise: p, resolve, reject };
}
function fakeRes(status, body) {
  return { status, headers: { get: () => null }, text: async () => body };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

function customCfgFile(entries) {
  return { config: { providerConfigRules: { providerRules: entries.map(([id, baseUrl, apiKey]) => (
    { providerId: id, providerName: id, config: { api: { type: "anthropic-messages", baseUrl }, access: { type: "api-key", apiKey } } }
  )) } } };
}
function r4Client({ cfgEntries, secrets, env } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV, env || {}),
    now: () => clock.t,
    credsPath: "/virtual/credentials.json",
    secretsPath: "/virtual/quota-secrets.json",
    readFile: (p) => {
      if (p.endsWith("credentials.json")) { throw new Error("ENOENT"); }
      if (p.endsWith("quota-secrets.json")) return secrets || { sources: {} };
      return customCfgFile(cfgEntries || []);
    },
    customCfgPath: "/virtual/provider_config.json",
    fetchImpl: (url, opts) => {
      const d = deferred();
      calls.push({ url, headers: (opts && opts.headers) || {}, d });
      return d.promise;
    },
  });
  return { client, clock, calls };
}
function reply(calls, url, status, body) {
  const hit = calls.find((c) => c.url === url);
  assert.ok(hit, "未发出请求：" + url);
  hit.d.resolve(fakeRes(status, JSON.stringify(body)));
}

const KEY_BODY = {
  key: { name: "zcode", start: "coder_test" },
  limit_usd: null, spent_usd: "1.392047", held_usd: "0.000000", remaining_usd: null,
  day: "2026-11-17", refresh_after_ms: 28702984,
  today: { request_count: 88, charged_usd_total: "1.391254", prompt_tokens_total: 6109288,
    completion_tokens_total: 97237, cache_read_tokens_total: 5727744, cache_creation_tokens_total: 0 },
  series: [],
};
const META_BODY = {
  key: { name: "zcode", start: "coder_test" },
  plan: {
    package_name: "Code Lite +1",
    remaining_usd: "58.607953", total_usd: "60.000000", max_concurrency: 6,
    expires_at: "2026-12-15T07:22:18.858Z",
    limit_windows: [{
      duration_seconds: 18000, ceiling_usd: 5, consumed_usd: 1.391254,
      remaining_usd: 3.608746, resets_at: "2026-11-17T09:22:18.859Z",
    }],
    grant_count: 2, grants: [],
  },
  queued: [],
  wallet: { balance_usd: "5.000000", max_concurrency: 5 },
  app_url: "https://r4.codes", public_base_url: "https://api.r4.codes",
};

test("r4: custom api.r4.codes provider maps plan pool + 5h ceiling from key/meta", async () => {
  const { client, calls } = r4Client({ cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_key"]] });
  client.noteProvider("new-provider");
  client.tick();
  assert.deepEqual(calls.map((c) => c.url).sort(), [KEY_URL, META_URL].sort());
  reply(calls, KEY_URL, 200, KEY_BODY);
  reply(calls, META_URL, 200, META_BODY);
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.kind, "plan");
  assert.equal(v.label, "R4 Coder");
  assert.deepEqual(v.plan, { productName: "Code Lite +1", validEnd: "2026-12-15" });
  assert.equal(v.balance, null, "有计划时不把钱包余额推到 chip 前");
  assert.equal(v.quotaSummary, undefined, "limit_usd=null 不造 Key 总额度");
  const pool = v.windows.plan, five = v.windows.fiveHour;
  assert.equal(pool.percent, 2.3);
  assert.equal(pool.used, 1.392047);
  assert.equal(pool.total, 60);
  assert.equal(pool.remaining, 58.607953);
  assert.equal(pool.currency, "USD");
  assert.equal(pool.expires, true);
  assert.equal(pool.resetsAt, "2026-12-15T07:22:18.858Z");
  assert.equal(five.percent, 27.8);
  assert.equal(five.used, 1.391254);
  assert.equal(five.total, 5);
  assert.equal(five.remaining, 3.608746);
  assert.equal(five.resetsAt, "2026-11-17T09:22:18.859Z");
  assert.equal(five.expires, undefined);
});

test("r4: key spend limit (no plan) becomes quotaSummary; wallet is not mixed in", async () => {
  const { client, calls } = r4Client({ cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, KEY_URL, 200, { key: { name: "k" }, limit_usd: "20.000000", spent_usd: "7.200000",
    held_usd: "0.100000", remaining_usd: "12.700000" });
  reply(calls, META_URL, 200, { key: { name: "k" }, plan: null, wallet: { balance_usd: "0.000000" } });
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.kind, "plan");
  assert.deepEqual(v.quotaSummary, { limit: 20, used: 7.3, remaining: 12.7, currency: "USD" });
  assert.equal(v.windows, undefined);
  assert.equal(v.balance, null);
});

test("r4: wallet-only account falls back to balance; uncapped window is skipped", async () => {
  const { client, calls } = r4Client({ cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, KEY_URL, 200, { key: { name: "k" }, limit_usd: null, spent_usd: "0.000000",
    held_usd: "0.000000", remaining_usd: null });
  reply(calls, META_URL, 200, { key: { name: "k" }, plan: null,
    wallet: { balance_usd: "5.000000" } });
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.kind, "balance");
  assert.deepEqual(v.balance, { amount: 5, currency: "USD" });
  assert.equal(v.windows, undefined);

  const capped = Q.normalizeR4(null, { plan: { package_name: "X", total_usd: "0", remaining_usd: "0",
    limit_windows: [{ duration_seconds: 18000, ceiling_usd: null, consumed_usd: 2, remaining_usd: null }] },
    wallet: { balance_usd: "0" } });
  assert.equal(capped.windows, undefined, "ceiling=null 是不限速，不得渲染成 0% 窗口");

  const unknown = Q.normalizeR4(null, { plan: { package_name: "P", total_usd: "60", remaining_usd: "50",
    limit_windows: [{ duration_seconds: 999999999, ceiling_usd: 5, consumed_usd: 1 }] },
    wallet: { balance_usd: "0" } });
  assert.deepEqual(Object.keys(unknown.windows), ["plan"], "未知时长窗不得覆盖套餐池");

  const zero = Q.normalizeR4({ key: {}, limit_usd: "0", spent_usd: "0", remaining_usd: "0" },
    { plan: null, wallet: null });
  assert.deepEqual(zero.quotaSummary, { limit: 0, used: 0, remaining: 0, currency: "USD" },
    "limit=0 是合法零额度，不判无订阅");
});

test("r4: meta transport failure keeps key quota and never freezes as no_plan", async () => {
  const { client, clock, calls } = r4Client({ cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, KEY_URL, 200, { key: { name: "k" }, limit_usd: "20.000000", spent_usd: "7.200000",
    held_usd: "0.100000", remaining_usd: "12.700000" });
  reply(calls, META_URL, 500, {});
  await flush();
  let v = client.view();
  assert.equal(v.status, "ok", "钱端 key 已给出可展示限额，meta 500 只损失套餐增强");
  assert.equal(v.quotaSummary.remaining, 12.7);

  /* 无 Key 限额的账户：meta 失败必须按瞬时错误退避重试，不能判无订阅冻结。 */
  const second = r4Client({ cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_key"]] });
  second.client.noteProvider("new-provider");
  second.client.tick();
  reply(second.calls, KEY_URL, 200, KEY_BODY);
  reply(second.calls, META_URL, 500, {});
  await flush();
  v = second.client.view();
  assert.equal(v.status, "network_error", "不是 no_plan");
  second.clock.t += 31 * 1000;
  second.client.tick();
  assert.equal(second.calls.length, 4, "短退避后可重试");
});

test("r4: malformed money/shape is parse_error, not a silent no_plan", async () => {
  const { client, calls } = r4Client({ cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, KEY_URL, 200, { key: { name: "k" }, limit_usd: "not-a-number", spent_usd: "x" });
  reply(calls, META_URL, 200, { plan: "oops", wallet: 1 });
  await flush();
  assert.equal(client.view().status, "parse_error");
});

test("r4: credential precedence env > secrets > provider_config; Bearer header is sent", async () => {
  const triple = r4Client({
    cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_cfg"]],
    secrets: { sources: { r4: { apiKey: "coder_sec" } } },
    env: { R4_API_KEY: "coder_env" },
  });
  triple.client.noteProvider("new-provider");
  triple.client.tick();
  reply(triple.calls, KEY_URL, 200, KEY_BODY);
  reply(triple.calls, META_URL, 200, META_BODY);
  await flush();
  assert.ok(triple.calls.length >= 2);
  triple.calls.forEach((c) => assert.equal(c.headers.authorization, "Bearer coder_env", "env 优先且授权头为 Bearer"));

  const sec = r4Client({
    cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_cfg"]],
    secrets: { sources: { r4: { apiKey: "coder_sec" } } },
  });
  sec.client.noteProvider("new-provider");
  sec.client.tick();
  reply(sec.calls, KEY_URL, 200, KEY_BODY);
  reply(sec.calls, META_URL, 200, META_BODY);
  await flush();
  sec.calls.forEach((c) => assert.equal(c.headers.authorization, "Bearer coder_sec", "无 env 时用 secrets"));
});

test("r4: same-name windows keep the worst; bad windows and meta fields are clamped", () => {
  const v = Q.normalizeR4(null, {
    plan: {
      package_name: "X".repeat(80),
      total_usd: "60", remaining_usd: "80",
      limit_windows: [
        { duration_seconds: 18000, ceiling_usd: 10, consumed_usd: 2, remaining_usd: null },
        { duration_seconds: 10800, ceiling_usd: 10, consumed_usd: 8, remaining_usd: null },
        { duration_seconds: 18000, ceiling_usd: null, consumed_usd: 9 },
        { duration_seconds: 18000, ceiling_usd: 5, consumed_usd: -1 },
      ],
    },
    wallet: { balance_usd: "-3" },
  });
  assert.equal(v.windows.fiveHour.used, 8, "同标签多窗取已用比例更高者，不让低窗掩盖受限");
  assert.equal(v.windows.fiveHour.remaining, 2, "remaining 缺失回退 ceiling-consumed");
  assert.deepEqual(Object.keys(v.windows), ["plan", "fiveHour"], "ceiling=null 与负 consumed 窗不渲染");
  assert.equal(v.windows.plan.used, 0, "remaining>total 时 used 钳 0");
  assert.equal(v.windows.plan.remaining, 60, "remaining 钳到 total");
  assert.equal(v.plan.productName, "X".repeat(60), "productName 截 60 字符");
  assert.equal(v.balance, undefined, "有套餐时不回退钱包");

  const neg = Q.normalizeR4(null, { plan: null, wallet: { balance_usd: "-3" } });
  assert.equal(neg.noPlan, true, "负余额是坏数据，不显示余额也不判有额度");

  const over = Q.normalizeR4({ key: {}, limit_usd: "20", spent_usd: "25", held_usd: "0", remaining_usd: null },
    { plan: null, wallet: null });
  assert.equal(over.quotaSummary.used, 25);
  assert.equal(over.quotaSummary.remaining, 0, "spent 超限且 remaining 缺失时回退钳 0，不进负数");
});

test("r4: window duration thresholds map to the four buckets and drop the unknown", () => {
  const names = (s) => {
    const v = Q.normalizeR4(null, { plan: { package_name: "P", total_usd: "10", remaining_usd: "5",
      limit_windows: [{ duration_seconds: s, ceiling_usd: 10, consumed_usd: 1 }] }, wallet: { balance_usd: "0" } });
    return Object.keys(v.windows).filter((k) => k !== "plan").sort();
  };
  assert.deepEqual(names(21600), ["fiveHour"], "6h 整点归 fiveHour");
  assert.deepEqual(names(21601), ["daily"], "6h+1s 归 daily");
  assert.deepEqual(names(129600), ["daily"], "36h 整点归 daily");
  assert.deepEqual(names(129601), ["weekly"], "36h+1s 归 weekly");
  assert.deepEqual(names(691200), ["weekly"], "8d 整点归 weekly");
  assert.deepEqual(names(691201), ["monthly"], "8d+1s 归 monthly");
  assert.deepEqual(names(2764800), ["monthly"], "32d 整点归 monthly");
  assert.deepEqual(names(2764801), [], "32d+1s 未知长窗丢弃");
});

test("r4: 403 (monitoring-purpose key) is auth_failed and freezes until key changes", async () => {
  const { client, clock, calls } = r4Client({ cfgEntries: [["new-provider", "https://api.r4.codes/v1", "coder_key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, KEY_URL, 403, { code: "STANDARD_KEY_REQUIRED" });
  reply(calls, META_URL, 403, { code: "STANDARD_KEY_REQUIRED" });
  await flush();
  assert.equal(client.view().status, "auth_failed");
  clock.t += 60 * 60 * 1000;
  client.tick();
  assert.equal(calls.length, 2, "auth_failed 冻结到凭据指纹变化");
});

test("r4: lookalike host is not claimed; env-only key activates the source", async () => {
  const spoof = r4Client({ cfgEntries: [["evil", "https://api.r4.codes.evil.example/v1", "sk"]] });
  spoof.client.noteProvider("evil");
  spoof.client.tick();
  assert.equal(spoof.calls[0].url, "https://api.r4.codes.evil.example/v1/usage", "落 generic 中转探测，不是 cli/key");

  const sub = r4Client({ cfgEntries: [["sub", "https://sub.r4.codes/v1", "sk"]] });
  sub.client.noteProvider("sub");
  sub.client.tick();
  assert.equal(sub.calls[0].url, "https://sub.r4.codes/v1/usage", "r4 子域不认领，host 精确匹配");

  const insecure = r4Client({ cfgEntries: [["h", "http://api.r4.codes/v1", "sk"]] });
  insecure.client.noteProvider("h");
  insecure.client.tick();
  assert.equal(insecure.calls.length, 0, "http baseUrl 不认领；generic 探测也拒明文 http，零请求");

  const envOnly = r4Client({ env: { R4_API_KEY: "coder_env" } });
  envOnly.client.tick();
  assert.deepEqual(envOnly.calls.map((c) => c.url).sort(), [KEY_URL, META_URL].sort());
  envOnly.calls.forEach((c) => c.d.resolve(fakeRes(200, JSON.stringify(c.url === KEY_URL ? KEY_BODY : META_BODY))));
  await flush();
  const src = envOnly.client.view().sources.r4;
  assert.equal(src.status, "ok");
  assert.equal(src.kind, "plan");
});
