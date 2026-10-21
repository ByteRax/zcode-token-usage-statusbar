const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");

const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* ---------- 加解密（与宿主 credentialCipherProvider 同语义的重写实现） ---------- */
const ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };
const KEY = Q.deriveCipherKey(ENV);
function encryptValue(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + iv.toString("base64url") + "." + c.getAuthTag().toString("base64url") + "." + ct.toString("base64url");
}

test("decryptValue roundtrip, wrong key, bad format, plaintext passthrough", () => {
  const enc = encryptValue("eyJhbGciOi.abc");
  assert.equal(Q.decryptValue(enc, KEY), "eyJhbGciOi.abc");
  assert.equal(Q.decryptValue(enc, Q.deriveCipherKey({ ZCODE_CREDENTIAL_SECRET: "other" })), null);
  assert.equal(Q.decryptValue("enc:v1:only.two", KEY), null);
  assert.equal(Q.decryptValue("enc:v1:" + "A".repeat(16) + "." + "B".repeat(24) + ".", KEY), null);
  assert.equal(Q.decryptValue("plain-value", KEY), "plain-value");
  assert.equal(Q.decryptValue(42, KEY), 42);
});

test("jwtExpMs reads exp; non-JWT yields null", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1793176110 })).toString("base64url");
  assert.equal(Q.jwtExpMs("h." + payload + ".s"), 1793176110 * 1000);
  assert.equal(Q.jwtExpMs("opaque-token"), null);
  assert.equal(Q.jwtExpMs(""), null);
});

/* ---------- 归一化 ---------- */
test("normalize: P0 real sample shape (TIME_LIMIT folded to tools, TOKENS_LIMIT window, models from details)", () => {
  const v = Q.normalizeQuotaBody({
    code: 200, msg: "操作成功", success: true,
    data: {
      level: "max",
      limits: [
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 48, remaining: 3952, percentage: 1, nextResetTime: 1793176110955,
          usageDetails: [{ modelCode: "search-prime", displayName: "Search Prime", usage: 35 }] },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 26, nextResetTime: 1793176110955 },
      ],
    },
  });
  assert.equal(v.level, "max");
  assert.equal(v.windows.fiveHour.percent, 26);
  assert.equal(v.windows.weekly, null);
  assert.equal(v.tools.total, 4000);
  assert.equal(v.tools.used, 48);
  assert.equal(v.tools.resetsAt, 1793176110955);
  assert.deepEqual(v.models, []);   // token 窗 usageDetails 为空；TIME_LIMIT 明细不算模型
  assert.deepEqual(v.unknownUnits, []);
});

test("normalize: percentage precision prefers self-compute; weekly unit=6; details collect models", () => {
  const v = Q.normalizeQuotaBody({ success: true, data: { limits: [
    { type: "tokens_limit", unit: 3, percentage: 1, usage: 4000, currentValue: 48, nextResetTime: 0,
      usageDetails: [{ modelCode: "glm-5.3-flash", displayName: "GLM-5.3-Flash", usage: 12 }, { modelCode: "glm-4.6", displayName: "GLM-4.6", usage: 3 }] },
    { type: "CREDIT_LIMIT", unit: 6, currentValue: 3, usage: 25 },
  ] } });
  assert.equal(v.windows.fiveHour.percent, 1.2);       // 48/4000 自算，不吃整数 1
  assert.equal(v.windows.fiveHour.resetsAt, null);      // 0 = 无重置（滚动窗）
  assert.equal(v.windows.weekly.percent, 12);           // 3/25，无 percentage 字段
  assert.deepEqual(v.models, ["GLM-5.3-Flash", "GLM-4.6"]);
});

test("normalize: unknown unit discarded with trace; missing-unit fallback fills fiveHour first (no reset first)", () => {
  const v = Q.normalizeQuotaBody({ success: true, data: { limits: [
    { type: "TOKENS_LIMIT", unit: 9, percentage: 40, nextResetTime: 1793176110955 },   // 未知 unit：丢弃留痕
    { type: "TOKENS_LIMIT", percentage: 10, nextResetTime: 1793176110999 },           // 缺 unit，有 reset → weekly 位
    { type: "TOKENS_LIMIT", percentage: 5 },                                          // 缺 unit，无 reset → fiveHour 位
  ] } });
  assert.deepEqual(v.unknownUnits, [9]);
  assert.equal(v.windows.fiveHour.percent, 5);
  assert.equal(v.windows.weekly.percent, 10);
});

test("normalize: weekly resets before five-hour at period end stays classified by unit (issue #3036 trap)", () => {
  const v = Q.normalizeQuotaBody({ success: true, data: { limits: [
    { type: "TOKENS_LIMIT", unit: 3, percentage: 60, nextResetTime: 2000000000000 },
    { type: "TOKENS_LIMIT", unit: 6, percentage: 10, nextResetTime: 1000000000000 },
  ] } });
  assert.equal(v.windows.fiveHour.percent, 60);
  assert.equal(v.windows.weekly.percent, 10);
});

test("normalize: reset seconds auto-scale; string passthrough; no-plan envelope zh/en; other business error is retryable", () => {
  const v = Q.normalizeQuotaBody({ success: true, data: { limits: [
    { type: "TOKENS_LIMIT", unit: 3, percentage: 1, nextResetTime: 1793176110 },
  ] } });
  assert.equal(v.windows.fiveHour.resetsAt, 1793176110 * 1000);
  const v2 = Q.normalizeQuotaBody({ success: true, data: { limits: [
    { type: "TOKENS_LIMIT", unit: 3, percentage: 1, nextResetTime: "2026-10-28T08:28:00Z" },
  ] } });
  assert.equal(v2.windows.fiveHour.resetsAt, "2026-10-28T08:28:00Z");

  assert.deepEqual(Q.normalizeQuotaBody({ code: 500, msg: "当前用户不存在coding plan", success: false }), { noPlan: true });
  assert.deepEqual(Q.normalizeQuotaBody({ code: 500, msg: "no coding plan not found for user", success: false }), { noPlan: true });
  assert.throws(() => Q.normalizeQuotaBody({ code: 500, msg: "内部服务错误", success: false }),
    (e) => e.code === "network_error");
  assert.throws(() => Q.normalizeQuotaBody({ success: true, data: {} }), (e) => e.code === "parse_error");
  assert.throws(() => Q.normalizeQuotaBody(null), (e) => e.code === "parse_error");
});

test("resolveWanted: builtin families, team, custom provider", () => {
  assert.deepEqual(Q.resolveWanted("account:bigmodel-individual-coding-plan"), { family: "bigmodel" });
  assert.deepEqual(Q.resolveWanted("account:zai-pro-coding-plan"), { family: "zai" });
  assert.deepEqual(Q.resolveWanted("account:bigmodel-team-coding-plan"), { unsupported: "team" });
  assert.equal(Q.resolveWanted("new-provider"), null);
  assert.equal(Q.resolveWanted(""), null);
});

/* ---------- 客户端状态机（注入 now/fetch/readFile） ---------- */
function deferred() {
  let resolve, reject;
  const p = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise: p, resolve, reject };
}
function fakeRes(status, body, headers) {
  return {
    status,
    headers: { get: (k) => ((headers || {})[String(k).toLowerCase()]) || null },
    text: async () => body,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 5));
const OK_BODY = JSON.stringify({ success: true, data: { level: "max", limits: [
  { type: "TOKENS_LIMIT", unit: 3, percentage: 26, nextResetTime: 1793176110955 },
] } });
const T0 = 1700000000000;
const BIGMODEL_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";

/* credsRef.value 可变：模拟 credentials.json 刷新（密文变化） */
function makeClient({ creds, env } = {}) {
  const credsRef = { value: creds };
  const clock = { t: T0 };
  const calls = [];
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV, env || {}),   // 解密密钥与夹具加密同源
    now: () => clock.t,
    credsPath: "/virtual/credentials.json",
    readFile: () => {
      if (credsRef.value === undefined || credsRef.value === null) throw new Error("ENOENT");
      return credsRef.value;
    },
    fetchImpl: (url, init) => {
      if (url.indexOf("/api/biz/subscription/list") >= 0) {
        return Promise.resolve(fakeRes(200, SUB_OK));   // makeClient 场景默认订阅可用；订阅专项用例自建 client
      }
      const d = deferred();
      calls.push({ url, auth: init.headers.authorization, redirect: init.redirect, d });
      return d.promise;
    },
  });
  return { client, clock, calls, credsRef };
}
const CRED_FILE = (token) => ({ "oauth:bigmodel:access_token": encryptValue(token || "jwt.test.token") });

test("client: happy path with bare authorization header, TTL gate, view shape", async () => {
  const { client, clock, calls } = makeClient({ creds: CRED_FILE("jwt.test.token") });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BIGMODEL_URL);
  assert.equal(calls[0].auth, "jwt.test.token");          // bigmodel 裸头，无 Bearer
  assert.equal(calls[0].redirect, "manual");
  calls[0].d.resolve(fakeRes(200, OK_BODY));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.providerId, "account:bigmodel-individual-coding-plan");
  assert.equal(v.level, "max");
  assert.equal(v.windows.fiveHour.percent, 26);
  assert.equal(v.stale, false);
  clock.t += Q.TTL_MS - 1;
  client.tick();
  assert.equal(calls.length, 1);                          // TTL 内不重复请求
  clock.t += 2;
  client.tick();
  assert.equal(calls.length, 2);                          // 过期重查
  calls[1].d.resolve(fakeRes(200, OK_BODY));
  await flush();
  assert.equal(client.view().status, "ok");
});

test("client: 401 freezes; credential refresh (ciphertext change) unfreezes; stale flag after TTL", async () => {
  const { client, clock, calls, credsRef } = makeClient({ creds: CRED_FILE("jwt.test.token") });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  calls[0].d.resolve(fakeRes(401, "{}"));
  await flush();
  assert.equal(client.view().status, "auth_failed");
  clock.t += 60 * 60 * 1000;
  client.tick();
  assert.equal(calls.length, 1);                          // 冻结：不再请求
  client.credentialsChanged();
  client.tick();                                          // 密文没变：仍冻结
  assert.equal(calls.length, 1);
  credsRef.value = CRED_FILE("jwt.renewed.token");        // 宿主刷新了 token（新密文）
  client.credentialsChanged();
  client.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].auth, "jwt.renewed.token");
  calls[1].d.resolve(fakeRes(200, OK_BODY));
  await flush();
  assert.equal(client.view().status, "ok");
  clock.t += Q.TTL_MS + 1;
  assert.equal(client.view().stale, true);
});

test("client: no-plan freezes; manual refresh forces; env key overrides decrypt", async () => {
  const { client, calls } = makeClient({
    creds: null,
    env: { ZCODE_BIGMODEL_USAGE_API_KEY: "sk-env-key" },
  });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, "sk-env-key");              // env key 优先于宿主凭据
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ code: 500, msg: "当前用户不存在coding plan", success: false })));
  await flush();
  assert.equal(client.view().status, "no_plan");
  client.tick();
  assert.equal(calls.length, 1);                          // 冻结
  client.refresh();                                       // 手动刷新绕过冻结
  assert.equal(calls.length, 2);
  calls[1].d.resolve(fakeRes(200, OK_BODY));
  await flush();
  assert.equal(client.view().status, "ok");
});

test("client: zai family uses Bearer; 429 reads retry-after; backoff ladder on network error", async () => {
  const { client, clock, calls } = makeClient({ creds: { "oauth:zai:access_token": encryptValue("zai.tok") } });
  client.noteProvider("account:zai-pro-coding-plan");
  client.tick();
  assert.equal(calls[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(calls[0].auth, "Bearer zai.tok");
  calls[0].d.resolve(fakeRes(429, "{}", { "retry-after": "120" }));
  await flush();
  assert.equal(client.view().status, "rate_limited");
  clock.t += 119 * 1000;
  client.tick();
  assert.equal(calls.length, 1);
  clock.t += 2 * 1000;
  client.tick();
  assert.equal(calls.length, 2);
  calls[1].d.reject(new Error("ECONNRESET"));
  await flush();
  assert.equal(client.view().status, "network_error");
  clock.t += 30 * 1000;                                   // 第一档退避 30s
  client.tick();
  assert.equal(calls.length, 3);
  calls[2].d.reject(new Error("ECONNRESET"));
  await flush();
  clock.t += 2 * 60 * 1000;                               // 第二档 2min
  client.tick();
  assert.equal(calls.length, 4);
});

test("client: not_configured / decrypt failure fail-closed; unsupported team & custom provider", () => {
  const a = makeClient({ creds: null });
  a.client.noteProvider("account:bigmodel-individual-coding-plan");
  a.client.tick();
  assert.equal(a.client.view().status, "not_configured");
  assert.equal(a.calls.length, 0);

  const b = makeClient({ creds: { "oauth:bigmodel:access_token": "enc:v1:broken.value.here" } });
  b.client.noteProvider("account:bigmodel-individual-coding-plan");
  b.client.tick();
  assert.equal(b.client.view().status, "not_configured");
  assert.equal(b.client.view().error, "credential decrypt failed");
  assert.equal(b.calls.length, 0);

  const c = makeClient({ creds: CRED_FILE() });
  c.client.noteProvider("account:bigmodel-team-coding-plan");
  c.client.tick();
  assert.equal(c.client.view().status, "unsupported");
  assert.equal(c.client.view().reason, "team");
  c.client.noteProvider("new-provider");
  c.client.tick();
  assert.equal(c.client.view().reason, "provider");
  assert.equal(c.calls.length, 0);
});

test("client: JWT near-expiry skips fetch (waits for host refresh); fresh JWT fetches", async () => {
  const soonJwt = "h." + Buffer.from(JSON.stringify({ exp: (T0 + 60 * 1000) / 1000 })).toString("base64url") + ".s";
  const a = makeClient({ creds: CRED_FILE(soonJwt) });
  a.client.noteProvider("account:bigmodel-individual-coding-plan");
  a.client.tick();
  assert.equal(a.calls.length, 0);                        // 临期（<2min）不发请求
  assert.equal(a.client._state.nextAt, T0 + 5 * 60 * 1000);

  const freshJwt = "h." + Buffer.from(JSON.stringify({ exp: (T0 + 3600 * 1000) / 1000 })).toString("base64url") + ".s";
  const b = makeClient({ creds: CRED_FILE(freshJwt) });
  b.client.noteProvider("account:bigmodel-individual-coding-plan");
  b.client.tick();
  assert.equal(b.calls.length, 1);
  b.calls[0].d.resolve(fakeRes(200, OK_BODY));
  await flush();
  assert.equal(b.client.view().status, "ok");
});

test("client: provider switch mid-flight bumps epoch; late response of old pool is dropped", async () => {
  const { client, calls, credsRef } = makeClient({ creds: CRED_FILE() });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  assert.equal(calls.length, 1);
  client.noteProvider("account:zai-pro-coding-plan");     // 在途时切换 family
  client.tick();                                          // zai 凭据不在虚拟文件 → not_configured，不新发
  assert.equal(calls.length, 1);
  assert.equal(client.view().status, "not_configured");
  calls[0].d.resolve(fakeRes(200, OK_BODY));              // bigmodel 的旧响应迟到
  await flush();
  assert.equal(client.view().status, "not_configured");   // 被代际守卫丢弃，未覆盖新状态
  assert.equal(client.view().windows, undefined);
  credsRef.value = { "oauth:zai:access_token": encryptValue("zai.tok") };
  client.credentialsChanged();
  client.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.z.ai/api/monitor/usage/quota/limit");
  calls[1].d.resolve(fakeRes(200, OK_BODY));
  await flush();
  assert.equal(client.view().status, "ok");
});

test("client: same-family model switch keeps provider string (no churn), custom base URL from env", async () => {
  const { client, calls } = makeClient({ creds: CRED_FILE(), env: { ZCODE_BIGMODEL_USAGE_QUOTA_URL: "https://bigmodel.cn/api/monitor/usage/quota/limit" } });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.noteProvider("account:bigmodel-individual-coding-plan");   // 同串重复：无动作
  client.tick();
  assert.equal(calls.length, 1);
  client.dispose();   // 中止在途，无异常
});

/* ---------- 订阅元数据（v95.1：BigModel 套餐 version/productName/valid） ---------- */
const SUB_OK = JSON.stringify({ code: 200, success: true, data: [{
  id: "280777", agreementNo: "0b7ab55f", orderNo: "2026022825451fef",   // 敏感字段：解析必须丢弃
  productId: "product-7fd668", productName: "GLM Coding Max", version: "V1",
  status: "VALID", inCurrentPeriod: true, valid: "2026-02-28 16:28:31-2027-02-28 10:00:00",
  nextRenewTime: "2027-02-28", autoRenew: 0,
}] });

test("normalizeSubscriptionPlan: whitelist fields, valid-range parse, no-plan/ambiguity fail-closed", () => {
  const plan = Q.normalizeSubscriptionPlan(JSON.parse(SUB_OK));
  assert.deepEqual(plan, { version: "V1", productName: "GLM Coding Max", validStart: "2026-02-28", validEnd: "2027-02-28" });
  assert.ok(!JSON.stringify(plan).includes("orderNo") && !JSON.stringify(plan).includes("agreementNo"), "敏感字段不保留");
  assert.equal(Q.normalizeSubscriptionPlan({ data: [] }), null);                       // 无生效订阅
  assert.equal(Q.normalizeSubscriptionPlan({ data: [{ status: "EXPIRED", inCurrentPeriod: false }] }), null);
  assert.equal(Q.normalizeSubscriptionPlan({ data: [{ status: "VALID", inCurrentPeriod: true, productName: "A", version: "V1" },
    { status: "VALID", inCurrentPeriod: true, productName: "B", version: "V2" }] }), null);   // 多条生效：歧义不猜
  assert.equal(Q.normalizeSubscriptionPlan(null), null);
  assert.equal(Q.normalizeSubscriptionPlan({ data: {} }), null);
});

test("client: bigmodel fetch pulls subscription in parallel; plan lands in view(); zai skips it", async () => {
  const clock = { t: T0 };
  const calls = [];
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV),
    now: () => clock.t,
    credsPath: "/virtual/credentials.json",
    readFile: () => CRED_FILE("jwt.test.token"),
    fetchImpl: (url) => {
      const d = deferred();
      calls.push({ url, d });
      return d.promise;
    },
  });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  assert.equal(calls.length, 2, "额度+订阅并行");
  assert.ok(calls.some((c) => c.url.endsWith("/api/monitor/usage/quota/limit")));
  assert.ok(calls.some((c) => c.url.endsWith("/api/biz/subscription/list")));
  for (const c of calls) c.d.resolve(fakeRes(200, c.url.includes("subscription") ? SUB_OK : OK_BODY));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.plan.productName, "GLM Coding Max");
  assert.equal(v.plan.version, "V1");

  // 订阅端点失败：额度照常、plan 丢弃
  clock.t += Q.TTL_MS + 1;
  client.tick();
  assert.equal(calls.length, 4);
  for (const c of calls.slice(2)) {
    c.d.resolve(c.url.includes("subscription") ? fakeRes(404, "{}") : fakeRes(200, OK_BODY));
  }
  await flush();
  assert.equal(client.view().status, "ok");
  assert.equal(client.view().plan, null, "订阅失败静默降级");
});

test("client: zai family does not fetch subscription endpoint", async () => {
  const { client, calls } = makeClient({ creds: { "oauth:zai:access_token": encryptValue("zai.tok") } });
  client.noteProvider("account:zai-pro-coding-plan");
  client.tick();
  assert.equal(calls.length, 1, "仅额度一个请求");
  assert.ok(calls[0].url.includes("api.z.ai"));
  calls[0].d.resolve(fakeRes(200, OK_BODY));
  await flush();
  assert.equal(client.view().status, "ok");
  assert.equal(client.view().plan, null);
});

/* ---------- 自定义 provider 余额（v96.2：官方域直连 + OpenAI legacy 探测） ---------- */
function customCfgFile(entries) {
  return { config: { providerConfigRules: { providerRules: entries.map(([id, baseUrl, apiKey, name]) => (
    { providerId: id, providerName: name || id, config: { api: { type: "openai-chat-completions", baseUrl }, access: { type: "api-key", apiKey } } }
  )) } } };
}
const CUSTOM_OK_BODY = JSON.stringify({ success: true, data: { level: "", limits: [] } });

test("custom provider: official host (DeepSeek) hits its balance endpoint; view exposes balance", async () => {
  const clock = { t: T0 };
  const calls = [];
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV), now: () => clock.t,
    credsPath: "/virtual/credentials.json", readFile: () => { throw new Error("ENOENT"); },
    customCfgPath: "/virtual/provider_config.json",
    fetchImpl: (url) => {
      const d = deferred();
      calls.push({ url, d });
      return d.promise;
    },
  });
  // readFile 被凭据路径占用：这里凭据直接抛 ENOENT 即可（自定义分支不读凭据文件），
  // 但 resolveCustomProvider 也用同一 readFile —— 改为按路径分流。
  void client;
  const client2 = Q.createQuotaClient({
    env: Object.assign({}, ENV), now: () => clock.t,
    credsPath: "/virtual/credentials.json",
    readFile: (p) => (p.endsWith("credentials.json") ? (() => { throw new Error("ENOENT"); })() : customCfgFile([["new-provider-4", "https://api.deepseek.com/v1", "sk-cfg-key"]])),
    customCfgPath: "/virtual/provider_config.json",
    fetchImpl: (url) => {
      const d = deferred();
      calls.push({ url, d });
      return d.promise;
    },
  });
  client2.noteProvider("new-provider-4");
  client2.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ is_available: true, balance_infos: [
    { currency: "CNY", total_balance: "110.00", granted_balance: "0.00", topped_up_balance: "110.00" },
  ] })));
  await flush();
  const v = client2.view();
  assert.equal(v.status, "ok");
  assert.deepEqual({ amount: v.balance.amount, currency: v.balance.currency }, { amount: 110, currency: "CNY" });
  assert.equal(v.windows, undefined);
  assert.equal(v.balance.parts, undefined, "granted=0 不拆分（parts 字段缺省，与 0 区分）");
});

test("custom provider: OpenAI legacy gateway with a finite pool computes remaining; unlimited pool stays hidden", async () => {
  const mk = (hard, totalUsage) => {
    const client = Q.createQuotaClient({
      env: Object.assign({}, ENV), now: () => T0,
      credsPath: "/virtual/credentials.json",
      readFile: (p) => (p.endsWith("credentials.json") ? (() => { throw new Error("ENOENT"); })() : customCfgFile([["gw1", "https://relay.example.com/v1", "sk-relay"]])),
      customCfgPath: "/virtual/provider_config.json",
      fetchImpl: (url) => Promise.resolve(fakeRes(200, url.endsWith("/subscription")
        ? JSON.stringify({ hard_limit_usd: hard })
        : JSON.stringify({ total_usage: totalUsage }))),
    });
    client.noteProvider("gw1");
    client.tick();
    return { client };
  };
  const a = mk(100, 2500);                       // $100 池，已用 $25
  await flush();
  assert.deepEqual(
    { a: a.client.view().balance.amount, c: a.client.view().balance.currency },
    { a: 75, c: "USD" });
  // 无限池（≥1e8，实测 OpenHubs 即此类）→ unsupported，chip 隐藏
  const b = mk(100000000, 0);
  await flush();
  assert.equal(b.client.view().status, "unsupported");
  assert.equal(b.client.view().reason, "gateway");
});

/* ---------- 阶段 B/C 适配器专项（各家真实形状夹具 + 陷阱断言） ---------- */
function adapterClient({ cfgEntries, secrets, env } = {}) {
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
    fetchImpl: (url) => {
      const d = deferred();
      calls.push({ url, d });
      return d.promise;
    },
  });
  return { client, clock, calls };
}

test("minimax: remaining% flipped to used%, weekly only when status==1, status==3 skipped", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["mm", "https://api.minimaxi.com/v1", "sk-mm"]] });
  client.noteProvider("mm");
  client.tick();
  assert.equal(calls[0].url, "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({
    base_resp: { status_code: 0, status_msg: "success" },
    model_remains: [
      { model_name: "video", current_interval_remaining_percent: 50 },
      { model_name: "general", current_interval_remaining_percent: 62, end_time: 1793176110955,
        current_weekly_status: 1, current_weekly_remaining_percent: 88, weekly_end_time: 1793262510955 },
    ],
  })));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.fiveHour.percent, 38);     // 100-62 已用%
  assert.equal(v.windows.weekly.percent, 12);       // 100-88
  // weekly_status==3（无周限额，remaining 恒 100）：跳过不误显
  client.refreshSource("minimax"); void client.refresh; client.tick(true);
  await flush();
  const c2 = adapterClient({ cfgEntries: [["mm", "https://api.minimaxi.com/v1", "sk-mm"]] });
  c2.client.noteProvider("mm");
  c2.client.tick();
  c2.calls[0].d.resolve(fakeRes(200, JSON.stringify({
    base_resp: { status_code: 0 },
    model_remains: [{ model_name: "general", current_interval_remaining_percent: 62, end_time: 1, current_weekly_status: 3, current_weekly_remaining_percent: 100 }],
  })));
  await flush();
  assert.ok(!c2.client.view().windows.weekly, "status==3 不出周窗");
});

test("kimi: subscription shape (remaining 制) with KimiCLI UA; 401 falls back to moonshot PAYG balance", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["kimi", "https://api.kimi.com", "sk-kimi-coding"]] });
  client.noteProvider("kimi");
  client.tick();
  assert.equal(calls[0].url, "https://api.kimi.com/coding/v1/usages");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({
    limits: [{ detail: { limit: 200, remaining: 150, resetTime: 1793176110 } }],
    usage: { limit: 1000, remaining: 400, resetTime: 1793262510 },
  })));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.fiveHour.percent, 25);   // (200-150)/200
  assert.equal(v.windows.weekly.percent, 60);     // (1000-400)/1000

  const b = adapterClient({ cfgEntries: [["kimi2", "https://api.kimi.com", "sk-payg"]] });
  b.client.noteProvider("kimi2");
  b.client.tick();
  b.calls[0].d.resolve(fakeRes(401, "{}"));   // 非订阅 Key
  await flush();
  // 回落链：/usages 401 → /usage 也试？authish 直接 break → PAYG
  const paygCalls = b.calls.filter((c) => c.url.indexOf("moonshot") >= 0);
  assert.ok(paygCalls.length >= 1, "回落 moonshot 余额端点");
  paygCalls[paygCalls.length - 1].d.resolve(fakeRes(200, JSON.stringify({ available_balance: 12345 })));
  await flush();
  const vb = b.client.view();
  assert.equal(vb.status, "ok");
  assert.equal(vb.balance.amount, 123.45, "人民币分→元");
});

test("commandcode: 4-call chain assembles windows + three-part credits balance", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["cc", "https://api.commandcode.ai/provider", "sk-cc"]] });
  client.noteProvider("cc");
  client.tick();
  const pathOf = (c) => c.url.replace("https://api.commandcode.ai", "").split("?")[0];
  assert.equal(pathOf(calls[0]), "/alpha/whoami");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ org: { id: "org1" } })));
  await flush();   // 链式：orgId 到位后才发后续三连（每步后重扫 calls）
  const byPath = () => { const m = {}; for (const c of calls) m[pathOf(c)] = c; return m; };
  assert.ok(byPath()["/alpha/billing/credits"], "credits 已发");
  byPath()["/alpha/billing/credits"].d.resolve(fakeRes(200, JSON.stringify({
    credits: { monthlyCredits: 30, purchasedCredits: 50, freeCredits: 20 },
    windowLimits: { limited: true, fiveHour: { used: 25, cap: 100, resetAt: 1793176110955 }, weekly: { used: 60, cap: 200, resetAt: 1793262510955 } },
  })));
  await flush();
  byPath()["/alpha/billing/subscriptions"].d.resolve(fakeRes(200, JSON.stringify({ data: { currentPeriodStart: "2026-10-01", currentPeriodEnd: "2026-11-01", planId: "pro" } })));
  await flush();
  byPath()["/alpha/usage/summary"].d.resolve(fakeRes(200, JSON.stringify({ totalCost: 100 })));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.fiveHour.percent, 25);
  assert.equal(v.windows.weekly.percent, 30);
  assert.equal(v.windows.monthly.percent, 50);   // 100/(100+100)
  assert.deepEqual(v.balance.parts.map((p) => p.label), ["月度", "购买", "免费"]);
});

test("cline: three windows from data.limits percentUsed", async () => {
  const { client, calls } = adapterClient({ secrets: { sources: { cline: { enabled: true, apiKey: "sk-cline" } } } });
  client.noteProvider("other");   // 配置型：primary 无关，靠 enabled 激活
  client.tick();
  const c = calls.find((x) => x.url.indexOf("cline.bot") >= 0);
  assert.ok(c, "cline 源被 secrets 启用并查询");
  c.d.resolve(fakeRes(200, JSON.stringify({ data: { limits: [
    { type: "five_hour", percentUsed: 42 }, { type: "weekly", percentUsed: "17.5" }, { type: "monthly", percentUsed: 3 },
  ] } })));
  await flush();
  const sv = client.view().sources.cline;
  assert.equal(sv.status, "ok");
  assert.equal(sv.windows.fiveHour.percent, 42);
  assert.equal(sv.windows.weekly.percent, 17.5);
});

test("anthropic: env OAuth token; sub-quota windows dropped, main windows kept", async () => {
  const { client, calls } = adapterClient({ env: { ANTHROPIC_OAUTH_TOKEN: "oauth-tok" } });
  client.noteProvider("whatever");
  client.tick();
  const c = calls.find((x) => x.url.indexOf("api.anthropic.com") >= 0);
  assert.ok(c, "anthropic 源自动激活（env 凭据）");
  c.d.resolve(fakeRes(200, JSON.stringify({
    five_hour: { utilization: 55, resets_at: 1793176110 },
    seven_day: { utilization: 20, resets_at: 1793262510 },
    seven_day_sonnet: { utilization: 99, resets_at: 1793262510 },
  })));
  await flush();
  const sv = client.view().sources.anthropic;
  assert.equal(sv.status, "ok");
  assert.equal(sv.windows.fiveHour.percent, 55);
  assert.equal(sv.windows.weekly.percent, 20);
  assert.equal(sv.windows.weekly.resetsAt, 1793262510 * 1000);
});

test("deepseek: granted≠0 splits into 赠送/充值 parts", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["ds", "https://api.deepseek.com/v1", "sk-ds"]] });
  client.noteProvider("ds");
  client.tick();
  assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ balance_infos: [
    { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
  ] })));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.balance.amount, 110);
  assert.deepEqual(v.balance.parts, [{ label: "赠送", amount: 10 }, { label: "充值", amount: 100 }]);
});

test("mimo: cookie normalized (prefix/quotes/newlines), plan+compensation windows, balance parts, login-expired soft", async () => {
  assert.equal(Q.normalizeMimoCookie('Cookie: "userId=741;\napi-platform_serviceToken=abc"'), "userId=741; api-platform_serviceToken=abc");
  assert.equal(Q.normalizeMimoCookie("userId=1"), null, "缺 serviceToken 无效");
  const { client, calls } = adapterClient({ secrets: { sources: { mimo: { enabled: true, cookie: "userId=741; serviceToken=abc" } } } });
  client.noteProvider("x");
  client.tick();
  const usage = calls.find((c) => c.url.endsWith("/tokenPlan/usage"));
  usage.d.resolve(fakeRes(200, JSON.stringify({ data: { monthUsage: { items: [
    { name: "month_total_token", used: 40, limit: 200, percent: 0 },
    { name: "compensation_total_token", used: 10, limit: 100, percent: 0 },
  ] } } })));
  await flush();   // detail/balance 与 usage 无依赖，usage 返回后并行发出
  const det = calls.find((c) => c.url.endsWith("/tokenPlan/detail"));
  det.d.resolve(fakeRes(200, JSON.stringify({ data: { planCode: "p", currentPeriodEnd: "2026-11-01 00:00:00", expired: false } })));
  const bal = calls.find((c) => c.url.endsWith("/balance"));
  bal.d.resolve(fakeRes(200, JSON.stringify({ data: { balance: "66.50", currency: "CNY", cashBalance: "60.00", giftBalance: "6.50" } })));
  await flush();
  const sv = client.view().sources.mimo;
  assert.equal(sv.status, "ok");
  assert.equal(sv.windows.monthly.percent, 20);
  assert.equal(sv.windows.compensation.percent, 10);
  assert.equal(sv.windows.monthly.resetsAt, "2026-11-01 00:00 +08:00");
  assert.deepEqual(sv.balance.parts, [{ label: "充值", amount: 60 }, { label: "赠送", amount: 6.5 }]);
});

test("volcano: AFP probe empty falls back to CodingPlan; envelope error in HTTP 200 mapped to auth_failed", async () => {
  const { client, calls } = adapterClient({ secrets: { sources: { volcano: { enabled: true, accessKeyId: "ak", secretAccessKey: "sk" } } } });
  client.noteProvider("x");
  client.tick();
  const afp = calls.find((c) => c.url.indexOf("GetAFPUsage") >= 0);
  assert.ok(afp, "先探 Agent Plan");
  assert.ok(afp.url.indexOf("Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01") >= 0, "query 字母序");
  afp.d.resolve(fakeRes(200, JSON.stringify({ Result: { AFPFiveHour: { Quota: 0, Used: 0 } } })));   // Quota<=0 → 未订阅
  await flush();
  const cp = calls.find((c) => c.url.indexOf("GetCodingPlanUsage") >= 0);
  assert.ok(cp, "回落 Coding Plan");
  cp.d.resolve(fakeRes(200, JSON.stringify({ Result: { QuotaUsage: [
    { Level: "session", Percent: 70, ResetTime: 1793176110955 },
    { Level: "weekly", Percent: 25, ResetTime: 1793262510955 },
    { Level: "monthly", Percent: 10, ResetTime: 1793348910955 },
  ] } })));
  await flush();
  const sv = client.view().sources.volcano;
  assert.equal(sv.status, "ok");
  assert.equal(sv.windows.fiveHour.percent, 70);
  assert.equal(sv.windows.weekly.percent, 25);
  assert.equal(sv.windows.monthly.percent, 10);
  // HTTP 200 带错误信封（签名错）：auth_failed
  const b = adapterClient({ secrets: { sources: { volcano: { enabled: true, accessKeyId: "ak", secretAccessKey: "sk" } } } });
  b.client.noteProvider("y");
  b.client.tick();
  b.calls[0].d.resolve(fakeRes(200, JSON.stringify({ ResponseMetadata: { Error: { Code: "InvalidAuthorization", Message: "bad signature" } } })));
  await flush();
  assert.equal(b.client.view().sources.volcano.status, "auth_failed");
});

test("scnet: extras-driven ledger; missing extras soft-hides", async () => {
  const { client, calls } = adapterClient({ secrets: { sources: { scnet: { enabled: true, planCredits: 240000 } } } });
  client.noteProvider("x");
  client.noteSnapshotExtras({ scnet: { source: "estimate", credits_used: 96000, plan_credits: 240000, resets_at: 1793348910955 } });
  client.tick();
  await flush();
  const sv = client.view().sources.scnet;
  assert.equal(sv.status, "ok");
  assert.equal(sv.windows.monthly.percent, 40);
  assert.equal(calls.length, 0, "ledger 源零网络请求");
  client.noteSnapshotExtras({ scnet: { source: "none" } });
  client.refreshSource("scnet");
  await flush();
  assert.equal(client.view().sources.scnet.status, "no_plan");
});

test("zai family skips subscription; multi-source scheduler refreshes defaultOn adapters in background", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["z", "https://api.z.ai/api/anthropic", "sk-z"]] });
  client.noteProvider("account:zai-pro-coding-plan");
  client.tick();
  // primary zai：无凭据 → not_configured；自定义 z 域名无零配置适配器命中
  const zai = client.view().sources.zai;
  assert.equal(zai.status, "not_configured");
  assert.equal(calls.filter((c) => c.url.indexOf("subscription") >= 0).length, 0, "zai 不拉订阅");
});

test("B2: two custom relay providers hold isolated source states (custom:<pid>)", async () => {
  const clock = { t: T0 };
  const calls = [];
  const cfg = () => customCfgFile([
    ["gw-a", "https://a.example.com/v1", "sk-a"],
    ["gw-b", "https://b.example.com/v1", "sk-b"],
  ]);
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV), now: () => clock.t,
    credsPath: "/virtual/credentials.json", secretsPath: "/virtual/quota-secrets.json",
    readFile: (p) => (p.endsWith("credentials.json") ? (() => { throw new Error("ENOENT"); })() : cfg()),
    customCfgPath: "/virtual/provider_config.json",
    fetchImpl: (url) => {
      const d = deferred();
      calls.push({ url, d });
      return d.promise;
    },
  });
  client.noteProvider("gw-a");
  client.tick();
  assert.equal(calls[0].url, "https://a.example.com/v1/dashboard/billing/subscription");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ hard_limit_usd: 50 })));
  await flush();
  calls[1].d.resolve(fakeRes(200, JSON.stringify({ total_usage: 1000 })));   // a 池 $50 已用 $10 → 40
  await flush();
  assert.equal(client.view().balance.amount, 40);
  // 切到 gw-b：独立源，a 的在途/状态不影响 b
  client.noteProvider("gw-b");
  client.tick();
  assert.equal(calls[2].url, "https://b.example.com/v1/dashboard/billing/subscription");
  assert.equal(client._states.get("custom:gw-a").value.balance.amount, 40, "a 状态保留");
  calls[2].d.resolve(fakeRes(200, JSON.stringify({ hard_limit_usd: 200 })));
  await flush();
  calls[3].d.resolve(fakeRes(200, JSON.stringify({ total_usage: 50000 })));   // b 池 $200 已用 $500 → 透支 300？
  await flush();
  assert.equal(client.view().balance.amount, -300, "b 是独立数字（哪怕为负也如实展示）");
});

test("B3: scnet no_plan unfreezes when snapshot extras arrive", async () => {
  const { client } = adapterClient({ secrets: { sources: { scnet: { enabled: true, planCredits: 240000 } } } });
  client.noteProvider("x");
  client.tick();
  await flush();
  assert.equal(client.view().sources.scnet.status, "no_plan", "extras 未到：软隐藏冻结");
  client.noteSnapshotExtras({ scnet: { source: "estimate", credits_used: 48000, plan_credits: 240000, resets_at: null } });
  client.tick();
  await flush();
  const sv = client.view().sources.scnet;
  assert.equal(sv.status, "ok", "extras 到位即解冻重查");
  assert.equal(sv.windows.monthly.percent, 20);
});
