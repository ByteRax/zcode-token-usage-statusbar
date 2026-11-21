const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* StepFun Step Plan 适配器（2026-11-21 外部贡献）：自定义供应商 baseUrl host 为
 * api.stepfun.com（https 必须）时零配置认领；只读 GET https://api.stepfun.com/step_plan/
 * v1/usage（Bearer key）——官方文档化端点（platform.stepfun.com/docs/zh/step-plan/usage），
 * 返回账号级套餐额度快照。本机真实账号实测过 Pro/Max 两档全链（2026-11-20/21）。
 * 测试形状取自官方文档示例响应（Token-Plus）与真实响应同构的合成快照，无真实凭据。 */
const ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };
const T0 = 1700000000000;
const USAGE_URL = "https://api.stepfun.com/step_plan/v1/usage";

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
function stepfunClient({ cfgEntries, secrets, env } = {}) {
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

/* validEnd 断言镜像适配器的本地时区 yyyy-MM-dd 格式化（两端同取本地日历日，
 * 测试在任意时区下等价；断言的是「订阅到期被格式化为日历日」这一行为本身）。 */
function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

const DOC_BODY = {
  schema_version: 1, observed_at_ms: 1767196800000, scope: "personal_account",
  account: { id: "123456789012345678" },
  plan: { state: "known", family: "token", name: "Token-Plus-月付-官方原价",
    subscription: { id: "123456", expires_at_ms: 1769875200000 } },
  quota: { state: "known", allowed: true, reason: null, windows: [],
    credit_buckets: [ { type: "subscription", total: "1600000000", remaining: "983000000",
      used_percent: 38.5625, resets_at_ms: null, expires_at_ms: 1769875200000 } ] },
};

test("stepfun: custom api.stepfun.com provider maps subscription pool to monthly window", async () => {
  const { client, calls } = stepfunClient({ cfgEntries: [["new-provider", "https://api.stepfun.com/step_plan", "cfg-key"]] });
  client.noteProvider("new-provider");
  client.tick();
  assert.deepEqual(calls.map((c) => c.url), [USAGE_URL], "只发官方 usage 端点，一请求");
  assert.equal(calls[0].headers.authorization, "Bearer cfg-key");
  reply(calls, USAGE_URL, 200, DOC_BODY);
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.kind, "plan");
  assert.equal(v.label, "StepFun");
  const m = v.windows.monthly;
  assert.ok(m, "订阅桶产出 monthly 窗");
  assert.equal(m.percent, 38.6, "used_percent 直取（38.5625 → 38.6，已用口径）");
  assert.equal(m.resetsAt, null, "文档示例 resets_at_ms=null：不拿订阅到期冒充重置时间");
  assert.equal(v.plan.productName, "Token-Plus-月付-官方原价");
  assert.equal(v.plan.validEnd, localDay(1769875200000), "订阅到期 → validEnd 日历日");
  client.dispose();
});

test("stepfun: normalize — resets_at_ms lands on window; used_percent missing self-computes", () => {
  const withReset = Q.normalizeStepfun({
    plan: { state: "known", name: "Token-Pro-月付-官方原价", subscription: { id: "1", expires_at_ms: 1796868261000 } },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "5028152640",
      used_percent: 37.148092, resets_at_ms: 1796865309000, expires_at_ms: 1796868261000 } ] },
  });
  assert.equal(withReset.windows.monthly.resetsAt, 1796865309000, "resets_at_ms 是真重置语义才进窗");
  assert.equal(withReset.plan.validEnd, localDay(1796868261000));

  const noPct = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "5028152640" } ] },
  });
  assert.equal(noPct.windows.monthly.percent, 37.1, "used_percent 缺失按 (total−remaining)/total 自算");
  assert.equal(noPct.windows.monthly.resetsAt, null);

  const clamped = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "0", used_percent: 150 } ] },
  });
  assert.equal(clamped.windows.monthly.percent, 100, "used_percent>100 由 clampPct 钳满格");

  const zeroPct = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "4000000000", used_percent: 0 } ] },
  });
  assert.equal(zeroPct.windows.monthly.percent, 0, "used_percent=0 是合法值直取，不落自算兜底");

  const badResetStr = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "5028152640", resets_at_ms: "not-a-date" } ] },
  });
  assert.equal(badResetStr.windows.monthly.resetsAt, null, "resets_at_ms 垃圾串过不了 Date.parse 门");

  const isoReset = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "5028152640", resets_at_ms: "2027-01-01T00:00:00.000Z" } ] },
  });
  assert.equal(isoReset.windows.monthly.resetsAt, "2027-01-01T00:00:00.000Z", "可解析日期串过门后原样透传");

  const numericStrReset = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "5028152640", resets_at_ms: "1796865309000" } ] },
  });
  assert.equal(numericStrReset.windows.monthly.resetsAt, 1796865309000, "全数字字符串转 Number 恢复（官方防精度写法可能同款）");

  const junkNumReset = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "5028152640", resets_at_ms: "2030" } ] },
  });
  assert.equal(junkNumReset.windows.monthly.resetsAt, null, "低于毫秒量级的短数字串不冒充重置时间");

  const longName = Q.normalizeStepfun({
    plan: { state: "known", name: "N".repeat(60) },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "5028152640" } ] },
  });
  assert.equal(longName.plan.productName.length, 40, "plan.name 截 40 字");
});

test("stepfun: non-subscription bucket falls back; empty buckets → noPlan; inconsistent shape parse_error", () => {
  const topup = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "topup", total: "400000000", remaining: "100000000", used_percent: 75 } ] },
  });
  assert.equal(topup.windows.monthly.percent, 75, "无 subscription 桶时取首个有效桶兜底展示");

  const subFirst = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "topup", total: "400000000", remaining: "100000000", used_percent: 75 },
      { type: "subscription", total: "8000000000", remaining: "4000000000", used_percent: 50 } ] },
  });
  assert.equal(subFirst.windows.monthly.percent, 50, "subscription 桶优先于加油包桶（月窗=订阅月池）");

  assert.throws(() => Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: null } ] },
  }), (e) => e.code === "parse_error", "remaining 为 null 的桶不被过滤（null >= 0 为 true），落 parse_error");

  const zeroTotal = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "0", remaining: "0" } ] },
  });
  assert.deepEqual(zeroTotal, { noPlan: true }, "total=0 桶被过滤（无法产出窗口）");

  const overdraft = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "8000000000", remaining: "-5" } ] },
  });
  assert.deepEqual(overdraft, { noPlan: true }, "负 remaining（透支形状）被过滤 → noPlan");

  const empty = Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [] },
  });
  assert.deepEqual(empty, { noPlan: true }, "无有效额度桶 = 无在订套餐，fail-closed 冻结");

  assert.throws(() => Q.normalizeStepfun({
    plan: { state: "known", name: "x" },
    quota: { credit_buckets: [ { type: "subscription", total: "100", remaining: "200", used_percent: 50 } ] },
  }), (e) => e.code === "parse_error", "remaining > total 是形状不一致，fail-closed 不钳制展示");

  assert.throws(() => Q.normalizeStepfun({ plan: { name: "x" } }), (e) => e.code === "parse_error");
  assert.throws(() => Q.normalizeStepfun([]), (e) => e.code === "parse_error");
});

test("stepfun: 401 classifies auth_failed and freezes until credential fingerprint change", async () => {
  const { client, calls } = stepfunClient({ cfgEntries: [["new-provider", "https://api.stepfun.com/step_plan", "bad-key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, USAGE_URL, 401, { error: { message: "Incorrect API key provided", type: "invalid_api_key" } });
  await flush();
  const st = client.view().sources["stepfun:new-provider"];
  assert.equal(st.status, "auth_failed");
  client.dispose();
});

test("stepfun: empty buckets freeze as no_plan through the scheduler", async () => {
  const { client, calls } = stepfunClient({ cfgEntries: [["new-provider", "https://api.stepfun.com/step_plan", "cfg-key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, USAGE_URL, 200, { schema_version: 1, plan: { state: "known", name: "x" },
    quota: { state: "known", allowed: false, credit_buckets: [] } });
  await flush();
  assert.equal(client.view().sources["stepfun:new-provider"].status, "no_plan");
  client.dispose();
});

test("stepfun: credential priority env > secrets > provider_config", async () => {
  const prio = stepfunClient({
    cfgEntries: [["new-provider", "https://api.stepfun.com/step_plan", "cfg-key"]],
    secrets: { sources: { stepfun: { apiKey: "sec-key" } } },
    env: { STEPFUN_API_KEY: "env-key" },
  });
  prio.client.noteProvider("new-provider");
  prio.client.tick();
  assert.equal(prio.calls.find((c) => c.url === USAGE_URL).headers.authorization, "Bearer env-key");
  reply(prio.calls, USAGE_URL, 200, DOC_BODY);
  await flush();
  prio.client.dispose();

  const secOnly = stepfunClient({
    cfgEntries: [["new-provider", "https://api.stepfun.com/step_plan", "cfg-key"]],
    secrets: { sources: { stepfun: { apiKey: "sec-key" } } },
  });
  secOnly.client.noteProvider("new-provider");
  secOnly.client.tick();
  assert.equal(secOnly.calls.find((c) => c.url === USAGE_URL).headers.authorization, "Bearer sec-key");
  reply(secOnly.calls, USAGE_URL, 200, DOC_BODY);
  await flush();
  secOnly.client.dispose();
});

test("stepfun: detect rejects non-https and lookalike hosts; presets registered", () => {
  const a = Q.createQuotaClient({
    env: ENV, now: () => T0, credsPath: "/v/c.json", secretsPath: "/v/s.json",
    readFile: () => { throw new Error("ENOENT"); },
    fetchImpl: () => new Promise(() => { }),
  });
  const ad = a._adapters.find((x) => x.id === "stepfun");
  assert.ok(ad, "stepfun 适配器已注册");
  assert.equal(ad.kind, "plan");
  assert.equal(ad.defaultOn, true);
  assert.deepEqual(ad.envKeys, ["STEPFUN_API_KEY"]);

  const j = { env: {}, secrets: { sources: {} }, customProviderOf: (id) => ({ baseUrl: "https://api.stepfun.com/step_plan", apiKey: "k" }) };
  assert.ok(ad.detect(j, "new-provider"), "官方域命中");
  const hit = (url) => {
    const jj = Object.assign({}, j, { customProviderOf: () => ({ baseUrl: url, apiKey: "k" }) });
    return !!ad.detect(jj, "new-provider");
  };
  assert.equal(hit("http://api.stepfun.com/step_plan"), false, "非 https 不命中");
  assert.equal(hit("https://api.stepfun.com.evil.example/v1"), false, "伪装域不命中");
  assert.equal(hit("https://www.stepfun.com/v1"), false, "官网主域不是 API 域，不命中");
  assert.equal(hit(""), false, "空 baseUrl 不命中");
  assert.equal(ad.detect(j, "account:bigmodel"), null, "内置账号不认领");

  const cfg = a.sourcesConfig();
  const row = (cfg || []).find((s) => s.id === "stepfun");
  assert.ok(row, "sourcesConfig 含 stepfun 行");
  assert.equal(row.keyUrl, "https://platform.stepfun.com/account-overview");
  a.dispose();
});
