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
  assert.deepEqual(Q.resolveWanted("bigmodel-api"), { family: "bigmodel" });
  assert.deepEqual(Q.resolveWanted("bigmodel-api-2"), { family: "bigmodel" });
  assert.deepEqual(Q.resolveWanted("zai-api"), { family: "zai" });
  assert.equal(Q.resolveWanted("bigmodel-api-x"), null);
  assert.equal(Q.resolveWanted("my-bigmodel-api"), null);
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
  const plan = Q.normalizeSubscriptionPlan(JSON.parse(SUB_OK), Date.parse("2026-10-22T04:00:00Z"));
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
  clock.t = Date.parse("2026-10-22T04:00:00Z");   // 注入时钟落在订阅周期内：日期随 j.now() 贯穿
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
  assert.equal(v.plan.validStart, "2026-02-28");
  assert.equal(v.plan.validEnd, "2027-02-28");

  // 时钟越过续费日（同一陈旧行）：日期隐藏而非显示下一年
  clock.t = Date.parse("2027-06-01T04:00:00Z");
  client.tick();
  assert.equal(calls.length, 4);
  for (const c of calls.slice(2)) {
    c.d.resolve(fakeRes(200, c.url.includes("subscription") ? SUB_OK : OK_BODY));
  }
  await flush();
  assert.equal(client.view().plan.validEnd, "", "clock past renewal hides dates");

  // 订阅端点失败：额度照常、plan 丢弃
  clock.t += Q.TTL_MS + 1;
  client.tick();
  assert.equal(calls.length, 6);
  for (const c of calls.slice(4)) {
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
  assert.ok(byPath()["/alpha/billing/credits"].url.indexOf("orgId=org1") >= 0, "组织账号 credits 带 orgId");
  byPath()["/alpha/billing/credits"].d.resolve(fakeRes(200, JSON.stringify({
    credits: { monthlyCredits: 30, purchasedCredits: 50, freeCredits: 20 },
    windowLimits: { limited: true, fiveHour: { used: 25, cap: 100, resetAt: 1793176110955 }, weekly: { used: 60, cap: 200, resetAt: 1793262510955 } },
  })));
  await flush();
  byPath()["/alpha/billing/subscriptions"].d.resolve(fakeRes(200, JSON.stringify({ data: { currentPeriodStart: "2026-10-01", currentPeriodEnd: "2026-11-01", planId: "pro" } })));
  assert.ok(byPath()["/alpha/billing/subscriptions"].url.indexOf("orgId=org1") >= 0, "组织账号 subscriptions 带 orgId");
  await flush();
  byPath()["/alpha/usage/summary"].d.resolve(fakeRes(200, JSON.stringify({ totalCost: 100 })));
  assert.ok(byPath()["/alpha/usage/summary"].url.indexOf("orgId=org1") >= 0, "组织账号 usage/summary 带 orgId");
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.fiveHour.percent, 25);
  assert.equal(v.windows.weekly.percent, 30);
  assert.equal(v.windows.monthly.percent, 50);   // 100/(100+100)
  assert.deepEqual(v.balance.parts.map((p) => p.label), ["月度", "购买", "免费"]);
});

test("commandcode: personal account (whoami org:null) omits orgId on all three follow-up calls", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["ccp", "https://api.commandcode.ai/provider", "sk-cc-p"]] });
  client.noteProvider("ccp");
  client.tick();
  const pathOf = (c) => c.url.replace("https://api.commandcode.ai", "").split("?")[0];
  assert.equal(pathOf(calls[0]), "/alpha/whoami");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ success: true, user: { id: "u1" }, org: null })));
  await flush();
  const byPath = () => { const m = {}; for (const c of calls) m[pathOf(c)] = c; return m; };
  const cred = byPath()["/alpha/billing/credits"];
  assert.ok(cred, "个人账号 credits 仍发出（不再抛 no org id）");
  assert.ok(cred.url.indexOf("orgId=") < 0, "个人账号 credits 不带 orgId");
  cred.d.resolve(fakeRes(200, JSON.stringify({
    credits: { monthlyCredits: 40, purchasedCredits: 20, freeCredits: 10 },
    windowLimits: { limited: true, fiveHour: { used: 20, cap: 125, resetAt: 1793176110955 }, weekly: { used: 90, cap: 300, resetAt: 1793262510955 } },
  })));
  await flush();
  const subs = byPath()["/alpha/billing/subscriptions"];
  assert.ok(subs.url.indexOf("orgId=") < 0, "个人账号 subscriptions 不带 orgId");
  subs.d.resolve(fakeRes(200, JSON.stringify({ data: { currentPeriodStart: "2026-10-01", currentPeriodEnd: "2026-11-01", planId: "personal" } })));
  await flush();
  const sum = byPath()["/alpha/usage/summary"];
  assert.ok(sum.url.indexOf("orgId=") < 0, "个人账号 usage/summary 不带 orgId");
  sum.d.resolve(fakeRes(200, JSON.stringify({ totalCost: 30 })));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.fiveHour.percent, 16);   // 20/125
  assert.equal(v.windows.weekly.percent, 30);     // 90/300
  assert.equal(v.windows.monthly.percent, 30);    // 30/(30+70)
  assert.equal(v.balance.amount, 70);
});

test("commandcode: org present without id stays parse_error, no silent scope downgrade", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["ccb", "https://api.commandcode.ai/provider", "sk-cc-b"]] });
  client.noteProvider("ccb");
  client.tick();
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ org: {} })));
  await flush();
  assert.equal(client.view().status, "parse_error");
  assert.equal(calls.filter((c) => c !== calls[0]).length, 0, "形状坏时不发后续三连");
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

test("anthropic: explicit enable + env OAuth token; sub-quota windows dropped, main windows kept", async () => {
  const { client, calls } = adapterClient({ env: { ANTHROPIC_OAUTH_TOKEN: "oauth-tok" },
    secrets: { sources: { anthropic: { enabled: true } } } });   // 读第三方应用凭据须显式启用
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
      if (url.endsWith("/v1/usage")) return Promise.resolve(fakeRes(404, "{}"));
      const d = deferred();
      calls.push({ url, d });
      return d.promise;
    },
  });
  client.noteProvider("gw-a");
  client.tick();
  await flush();
  assert.equal(calls[0].url, "https://a.example.com/v1/dashboard/billing/subscription");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ hard_limit_usd: 50 })));
  await flush();
  calls[1].d.resolve(fakeRes(200, JSON.stringify({ total_usage: 1000 })));   // a 池 $50 已用 $10 → 40
  await flush();
  assert.equal(client.view().balance.amount, 40);
  // 切到 gw-b：独立源，a 的在途/状态不影响 b
  client.noteProvider("gw-b");
  client.tick();
  await flush();
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


test('live provider set schedules all panes, preserving in-flight work and cache on model changes', async () => {
  const { client, calls } = adapterClient({ cfgEntries: [
    ['ds-a', 'https://api.deepseek.com/v1', 'sk-a'],
    ['ds-b', 'https://api.deepseek.com/v1', 'sk-b'],
  ] });
  client.setProviders(['ds-a', 'ds-b']);
  client.tick();
  assert.equal(calls.length, 2, 'both pane accounts are scheduled despite sharing a vendor');
  const firstState = client._states.get('deepseek:ds-a');
  const firstFlight = firstState.inFlight;
  client.setProviders(['ds-b', 'ds-a', 'ds-a']);
  client.tick();
  assert.equal(calls.length, 2, 'same selection map is idempotent and de-duplicated');
  assert.equal(firstState.inFlight, firstFlight, 'reconciling panes does not abort existing work');
  const body = amount => JSON.stringify({ balance_infos: [
    { currency: 'CNY', total_balance: String(amount), granted_balance: '0', topped_up_balance: String(amount) },
  ] });
  calls[0].d.resolve(fakeRes(200, body(10)));
  calls[1].d.resolve(fakeRes(200, body(25)));
  await flush();
  const view = client.view();
  assert.equal(view.sources[view.byProvider['ds-a']].balance.amount, 10);
  assert.equal(view.sources[view.byProvider['ds-b']].balance.amount, 25, 'different API keys never share vendor state');
  client.setProviders(['ds-a', 'ds-b']);
  client.tick();
  assert.equal(calls.length, 2, 'same provider, another model reuses TTL');
  client.setProviders([]);
  client.tick();
  assert.deepEqual(client.view().byProvider, {}, 'closed panes remove their selection mappings');
  client.setProviders(['ds-b']);
  client.tick();
  assert.equal(calls.length, 2, 'switching back reuses that account cache');
});

test('switching a live pane set drops old relay results without exposing Coding Plan as a fallback', async () => {
  const { client, calls } = adapterClient({ cfgEntries: [
    ['relay-a', 'https://a.example.com/v1', 'sk-a'],
    ['relay-b', 'https://b.example.com/v1', 'sk-b'],
  ] });
  client.setProviders(['relay-a']);
  client.tick();
  const oldEpoch = client._states.get('custom:relay-a').epoch;
  client.setProviders(['relay-b']);
  client.tick();
  assert.ok(client._states.get('custom:relay-a').epoch > oldEpoch, 'leaving the relay invalidates its in-flight response');
  assert.equal(client.view().byProvider['relay-a'], undefined);
  assert.equal(client.view().byProvider['relay-b'], 'custom:relay-b');
  const relayBody = fakeRes(200, JSON.stringify({ hard_limit_usd: 100000000 }));
  calls[0].d.resolve(relayBody);   // relay-a /v1/usage 探测（epoch 已失效，迟到结果被丢弃）
  calls[1].d.resolve(relayBody);   // relay-b /v1/usage 探测：非 sub2api JSON → null → 转 legacy
  await flush();                   // 等 legacy 回退探测入队（统一版先探 /v1/usage）
  for (const late of calls.slice(2)) late.d.resolve(relayBody);   // legacy：hard≥1e8 判按量无固定池
  await flush();
  assert.equal(client.view().active, 'custom:relay-b');
  assert.equal(client.view().sources['custom:relay-b'].status, 'unsupported');
  assert.equal(client.view().sources['custom:relay-a'].status, 'idle', 'late failure cannot mutate the departed pool');
});


test('vendor settings status and manual refresh cover provider-scoped account sources', async () => {
  const { client, calls } = adapterClient({ cfgEntries: [['ds-a', 'https://api.deepseek.com/v1', 'sk-a']] });
  client.setProviders(['ds-a']);
  client.tick();
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ balance_infos: [
    { currency: 'CNY', total_balance: '10', granted_balance: '0', topped_up_balance: '10' },
  ] })));
  await flush();
  const config = client.sourcesConfig().find(s => s.id === 'deepseek');
  assert.equal(config.status, 'ok');
  assert.equal(config.keyConfigured, true);
  assert.equal(config.keySource, 'provider_config');
  client.refreshSource('deepseek');
  assert.equal(calls.length, 2, 'vendor refresh reaches its provider-specific source');
  calls[1].d.resolve(fakeRes(200, JSON.stringify({ balance_infos: [
    { currency: 'CNY', total_balance: '9', granted_balance: '0', topped_up_balance: '9' },
  ] })));
  await flush();
  assert.equal(client.view().sources['deepseek:ds-a'].balance.amount, 9);
});

const SUB2API_USAGE = {
  isValid: true, mode: 'unrestricted', unit: 'USD', remaining: 66.90158933, planName: 'Fixture subscription',
  subscription: { daily_limit_usd: 100, daily_usage_usd: 33.09841067,
    weekly_limit_usd: 250, weekly_usage_usd: 45.91393736,
    monthly_limit_usd: 1000, monthly_usage_usd: 69.38740268,
    expires_at: '2027-04-25T13:06:06.850682+08:00' },
};

test('sub2api subscription normalizes all windows without labelling daily remaining as wallet balance', () => {
  const value = Q.normalizeSub2api(SUB2API_USAGE);
  assert.equal(value.kind, 'plan');
  assert.equal(value.label, 'sub2api');
  assert.equal(value.windows.daily.percent, 33.1);
  assert.equal(value.windows.weekly.percent, 18.4);
  assert.equal(value.windows.monthly.percent, 6.9);
  assert.ok(Math.abs(value.windows.daily.remaining - SUB2API_USAGE.remaining) < 1e-9);
  assert.equal(value.windows.daily.used, 33.09841067);
  assert.equal(value.balance, undefined);
  assert.equal(value.windows.daily.resetsAt, null, 'no inferred reset time');
  assert.equal(value.subscription.expiresAt, SUB2API_USAGE.subscription.expires_at);
  assert.deepEqual(Q.normalizeSub2api({ isValid: true, mode: 'balance', unit: 'USD', remaining: 0 }),
    { label: 'sub2api', kind: 'balance', balance: { amount: 0, currency: 'USD' } });
  assert.equal(Q.normalizeSub2api({ remaining: 10 }), null, 'ambiguous JSON not classified');
  assert.throws(() => Q.normalizeSub2api({ ...SUB2API_USAGE, isValid: false }), e => e.code === 'auth_failed');
  assert.throws(() => Q.normalizeSub2api({ ...SUB2API_USAGE, subscription: {} }), e => e.code === 'parse_error');
});

test('sub2api query stays same-origin and handles configured root or /v1 prefix exactly once', async () => {
  for (const [base, endpoint] of [
    ['https://relay.example.com', 'https://relay.example.com/v1/usage'],
    ['https://relay.example.com/v1/', 'https://relay.example.com/v1/usage'],
    ['https://relay.example.com/proxy/v1', 'https://relay.example.com/proxy/v1/usage'],
  ]) {
    assert.equal(Q.relayQuotaUrls(base).sub2api, endpoint);
    const { client, calls } = adapterClient({ cfgEntries: [['gw', base, 'fake-key']] });
    client.noteProvider('gw'); client.tick();
    assert.equal(calls[0].url, endpoint);
    calls[0].d.resolve(fakeRes(200, JSON.stringify(SUB2API_USAGE)));
    await flush();
    assert.equal(calls.length, 1, 'matched protocol stops probing legacy');
    assert.equal(client.view().windows.daily.percent, 33.1);
    assert.equal(client.view().label, 'sub2api');
    assert.equal(client.view().subscription.expiresAt, SUB2API_USAGE.subscription.expires_at);
    assert.equal(client.view().balance, null);
  }
  assert.throws(() => Q.relayQuotaUrls('https://user:pass@relay.example.com'), e => e.code === 'parse_error');
  assert.throws(() => Q.relayQuotaUrls('http://relay.example.com'), e => e.code === 'parse_error');
});

test('sub2api 401 and 429 are classified, not masked as unsupported with extra probes', async () => {
  for (const [code, status] of [[401, 'auth_failed'], [429, 'rate_limited']]) {
    const { client, calls } = adapterClient({ cfgEntries: [['gw', 'https://relay.example.com/v1', 'fake-key']] });
    client.noteProvider('gw'); client.tick();
    calls[0].d.resolve(fakeRes(code, '{}'));
    await flush();
    assert.equal(client.view().status, status);
    assert.equal(calls.length, 1);
  }
});

test('legacy fallback cannot turn a failed or missing usage query into a full balance', async () => {
  const { client, calls } = adapterClient({ cfgEntries: [['gw', 'https://relay.example.com/v1', 'fake-key']] });
  client.noteProvider('gw'); client.tick();
  calls[0].d.resolve(fakeRes(404, '{}')); await flush();
  calls[1].d.resolve(fakeRes(200, JSON.stringify({ hard_limit_usd: 100 }))); await flush();
  calls[2].d.resolve(fakeRes(200, '{}')); await flush();
  assert.equal(client.view().status, 'parse_error');
  assert.equal(client.view().balance, undefined);
});


test('audited official balances accept zero, require complete totals and retain SiliconFlow region', async () => {
  const cases = [
    ['ds', 'https://api.deepseek.com/v1', { balance_infos: [{ currency: 'CNY', total_balance: '0', granted_balance: '0', topped_up_balance: '0' }] }, 0, 'CNY', 'https://api.deepseek.com/user/balance'],
    ['sf-cn', 'https://api.siliconflow.cn/v1', { data: { balance: '1', chargeBalance: '9', totalBalance: '10' } }, 10, 'CNY', 'https://api.siliconflow.cn/v1/user/info'],
    ['sf-en', 'https://api.siliconflow.com/v1', { data: { balance: '1', totalBalance: '10' } }, 10, 'USD', 'https://api.siliconflow.com/v1/user/info'],
  ];
  for (const [id, base, body, amount, currency, url] of cases) {
    const { client, calls } = adapterClient({ cfgEntries: [[id, base, 'fake-key']] });
    client.noteProvider(id); client.tick();
    assert.equal(calls[0].url, url);
    calls[0].d.resolve(fakeRes(200, JSON.stringify(body))); await flush();
    assert.equal(client.view().balance.amount, amount);
    assert.equal(client.view().balance.currency, currency);
  }
  const { client, calls } = adapterClient({ cfgEntries: [['sf', 'https://api.siliconflow.cn/v1', 'fake-key']] });
  client.noteProvider('sf'); client.tick(); calls[0].d.resolve(fakeRes(410, '{}')); await flush();
  assert.equal(client.view().status, 'unsupported');
  assert.equal(client.view().reason, 'endpoint_retired');
});

test('OpenRouter account credits require an explicit management key, not the inference key', async () => {
  const plain = adapterClient({ cfgEntries: [['or', 'https://openrouter.ai/api/v1', 'inference-key']] });
  plain.client.noteProvider('or'); plain.client.tick();
  assert.equal(plain.calls.length, 0);
  assert.equal(plain.client.view().status, 'not_configured');
  for (const [body, status, amount] of [
    [{ data: { total_credits: 20, total_usage: 5 } }, 'ok', 15],
    [{ data: { total_credits: 20 } }, 'parse_error', undefined],
  ]) {
    const x = adapterClient({ env: { OPENROUTER_MANAGEMENT_KEY: 'management-key' } });
    x.client.tick();
    assert.equal(x.calls.length, 1, 'env-only management credential activates the adapter');
    x.calls[0].d.resolve(fakeRes(200, JSON.stringify(body))); await flush();
    const view = x.client.view().sources.openrouter;
    assert.equal(view.status, status);
    if (status === 'ok') assert.equal(view.balance.amount, amount);
    else assert.equal(view.balance, undefined, 'missing usage never becomes zero spend');
  }
});

test('env-only credentials activate enabled vendor adapters, explicit per-source opt-out prevents requests', async () => {
  for (const [env, id] of [
    [{ MINIMAX_API_KEY: 'mm' }, 'minimax'], [{ KIMI_CODING_API_KEY: 'kimi' }, 'kimi'],
    [{ DEEPSEEK_API_KEY: 'ds' }, 'deepseek'], [{ COMMANDCODE_API_KEY: 'cc' }, 'commandcode'],
    [{ SILICONFLOW_API_KEY: 'sf' }, 'siliconflow'],
  ]) {
    const x = adapterClient({ env }); x.client.tick();
    assert.equal(x.calls.length, 1, id + ' env credential reaches fetch');
    x.client.dispose();
  }
  const cline = adapterClient({ env: { CLINE_API_KEY: 'cline' }, secrets: { sources: { cline: { enabled: true } } } });
  cline.client.tick();
  assert.equal(cline.calls.length, 1, 'explicitly enabled cline with env-only credential reaches fetch');
  cline.client.dispose();
  const off = adapterClient({ cfgEntries: [['ds', 'https://api.deepseek.com/v1', 'ds']],
    env: { DEEPSEEK_API_KEY: 'env-ds' }, secrets: { sources: { deepseek: { enabled: false } } } });
  off.client.noteProvider('ds'); off.client.tick();
  assert.equal(off.calls.length, 0, 'primary also honors vendor opt-out');
  assert.equal(off.client.view().status, 'disabled');
  assert.equal(off.client.sourcesConfig().find(x => x.id === 'deepseek').enabled, false);
});

test('BigModel write-only settings key is consumed even without a host login credential', async () => {
  const x = adapterClient({ secrets: { sources: { bigmodel: { enabled: true, apiKey: 'explicit-key' } } } });
  x.client.noteProvider('account:bigmodel-individual-coding-plan'); x.client.tick();
  assert.equal(x.calls.length, 2);
  for (const c of x.calls) c.d.resolve(fakeRes(200, c.url.includes('subscription') ? SUB_OK : OK_BODY));
  await flush();
  assert.equal(x.client.view().status, 'ok');
});


test('default-on vendor activates from a saved credential, while explicit disable blocks manual refresh too', async () => {
  const config = { sources: { deepseek: { apiKey: 'configured-key' } } };
  const x = adapterClient({ secrets: config }); x.client.tick();
  assert.equal(x.calls.length, 1, 'saving a default-on source key is sufficient to activate');
  x.calls[0].d.resolve(fakeRes(200, JSON.stringify({ balance_infos: [
    { currency: 'CNY', total_balance: '0', granted_balance: '0', topped_up_balance: '0' },
  ] }))); await flush();
  config.sources.deepseek.enabled = false;
  x.client.credentialsChanged(); x.client.tick(); x.client.refreshSource('deepseek');
  assert.equal(x.calls.length, 1, 'explicit opt-out is enforced at the request entry');
});

test('sub2api malformed subscription or unknown mode never becomes a wallet balance', () => {
  for (const subscription of [[], '', 'invalid', 5, true]) {
    assert.throws(() => Q.normalizeSub2api({ ...SUB2API_USAGE, subscription }), e => e.code === 'parse_error');
  }
  for (const mode of ['unknown', '', 'unrestricted', 'subscription', 'quota']) {
    assert.throws(() => Q.normalizeSub2api({ isValid: true, mode, unit: 'USD', remaining: 50 }), e => e.code === 'parse_error');
  }
});


const SUBSCRIPTION_NOW = Date.parse('2026-10-22T04:00:00Z');
function subscriptionSample(fields) {
  return { success: true, data: [{
    status: 'VALID', inCurrentPeriod: true, productName: 'GLM Coding Max', version: 'V1',
    valid: '2027-03-14 10:00 ~ 2028-03-14 10:00',
    currentRenewTime: '2026-03-14', nextRenewTime: '2027-03-14', billingCycle: 'annually',
    autoRenew: 0, ...fields,
  }] };
}

test('subscription expiry prefers the current renewal boundary over a future annual valid interval', () => {
  for (const autoRenew of [false, 0]) {
    const plan = Q.normalizeSubscriptionPlan(subscriptionSample({ autoRenew }), SUBSCRIPTION_NOW);
    assert.equal(plan.validStart, '2026-03-14');
    assert.equal(plan.validEnd, '2027-03-14');
    assert.equal(plan.renewAt, undefined);
    assert.doesNotMatch(JSON.stringify(plan), /2028-03-14/);
    assert.equal(plan.billingCycle, undefined, 'only normalized presentation fields cross the snapshot boundary');
  }
});

test('automatic renewal exposes the next charge date without claiming a final expiry', () => {
  for (const autoRenew of [true, 1]) {
    assert.deepEqual(Q.normalizeSubscriptionPlan(subscriptionSample({ autoRenew }), SUBSCRIPTION_NOW), {
      version: 'V1', productName: 'GLM Coding Max',
      validStart: '2026-03-14', validEnd: '', renewAt: '2027-03-14',
    });
  }
});

test('only a valid interval containing today may supply a missing renewal boundary', () => {
  const current = '2026-03-14 10:00:00-2027-03-14 10:00:00';
  for (const nextRenewTime of [undefined, '', 'not-a-date', '2027-02-30', '2026-01-01']) {
    const plan = Q.normalizeSubscriptionPlan(subscriptionSample({ valid: current, nextRenewTime }), SUBSCRIPTION_NOW);
    assert.equal(plan.validStart, '2026-03-14');
    assert.equal(plan.validEnd, '2027-03-14');
  }
  for (const valid of [
    '2027-03-14 10:00 ~ 2028-03-14 10:00', // future period
    '2025-03-14 ~ 2026-03-14',             // expired period
    '2027-03-14 ~ 2026-03-14',             // reversed
    '2026-02-30 ~ 2027-03-14',             // invalid calendar day
    'not-a-range',
  ]) {
    const plan = Q.normalizeSubscriptionPlan(subscriptionSample({ valid, nextRenewTime: '', currentRenewTime: '' }), SUBSCRIPTION_NOW);
    assert.equal(plan.validEnd, '', 'unconfirmed valid interval cannot become the expiry');
    assert.equal(plan.validStart, '');
    assert.equal(plan.productName, 'GLM Coding Max');
    assert.equal(plan.version, 'V1');
  }
});

test('auto-renew without an explicit next charge date labels a current interval only as the current period', () => {
  const plan = Q.normalizeSubscriptionPlan(subscriptionSample({ autoRenew: 1, nextRenewTime: '',
    valid: '2026-03-14 10:00 ~ 2027-03-14 10:00' }), SUBSCRIPTION_NOW);
  assert.equal(plan.validEnd, '');
  assert.equal(plan.renewAt, undefined);
  assert.equal(plan.periodEnd, '2027-03-14');
});

test('renewal-day morning keeps the current-period expiry instead of jumping to next year', () => {
  const plan = Q.normalizeSubscriptionPlan(subscriptionSample({}), Date.parse('2027-03-14T09:00:00+08:00'));
  assert.equal(plan.validEnd, '2027-03-14');
  assert.doesNotMatch(JSON.stringify(plan), /2028-03-14/);
});

test('charged instant passed: next period genuinely current for manual; stale auto-renew hides dates', () => {
  // 非自动续费：10:00 已过，valid 新周期（2027-03-14 10:00~2028-03-14 10:00）真实生效
  const manual = Q.normalizeSubscriptionPlan(subscriptionSample({ nextRenewTime: '2027-03-14 10:00:00' }),
    Date.parse('2027-03-14T11:00:00+08:00'));
  assert.equal(manual.validStart, '2027-03-14');
  assert.equal(manual.validEnd, '2028-03-14', 'next period really started; showing it is correct');
  // 自动续费陈旧行（已扣费但 nextRenewTime 未更新）：不知道新扣费日，隐藏日期不猜
  const auto = Q.normalizeSubscriptionPlan(subscriptionSample({ nextRenewTime: '2027-03-14 10:00:00', autoRenew: 1 }),
    Date.parse('2027-03-14T11:00:00+08:00'));
  assert.equal(auto.validEnd, '');
  assert.equal(auto.renewAt, undefined);
});

test('legal datetime nextRenewTime keeps renewAt/expiry like the host mapper accepts', () => {
  const cases = [
    ['2027-03-14 10:00:00', 1, 'renewAt'],
    ['2027-03-14T10:00:00+08:00', 1, 'renewAt'],
    ['2027-03-14T02:00:00Z', 1, 'renewAt'],
    ['2027-03-14 10:00', 0, 'validEnd'],
  ];
  for (const [nextRenewTime, autoRenew, key] of cases) {
    const plan = Q.normalizeSubscriptionPlan(subscriptionSample({ nextRenewTime, autoRenew }), SUBSCRIPTION_NOW);
    assert.equal(plan[key], '2027-03-14', nextRenewTime);
  }
});

test('malformed times inside the valid interval reject the whole fallback', () => {
  for (const valid of [
    '2026-03-14 25:99 ~ 2027-03-14 99:99',
    '2026-03-14 10:00 ~ 2027-03-14 25:00',
  ]) {
    const plan = Q.normalizeSubscriptionPlan(subscriptionSample({ valid, nextRenewTime: '', currentRenewTime: '' }), SUBSCRIPTION_NOW);
    assert.equal(plan.validEnd, '', valid);
    assert.equal(plan.validStart, '');
  }
});

test('subscription dates validate the calendar, avoid year subtraction and keep the service calendar day', () => {
  const leap = Q.normalizeSubscriptionPlan(subscriptionSample({ nextRenewTime: '2028-02-29', currentRenewTime: '2026-02-29' }), SUBSCRIPTION_NOW);
  assert.equal(leap.validEnd, '2028-02-29', 'use the explicit boundary rather than subtracting one year');
  assert.equal(leap.validStart, '', 'invalid calendar start is not exposed');
  for (const nextRenewTime of ['2027-03-14 25:00', '2027-03-14junk', '2027-13-01', '2027-00-10', '2027-03-14T10:00+08:99']) {
    const plan = Q.normalizeSubscriptionPlan(subscriptionSample({ nextRenewTime, currentRenewTime: '' }), SUBSCRIPTION_NOW);
    assert.equal(plan.validEnd, '', nextRenewTime);
  }
  const day = Date.parse('2026-10-21T16:30:00Z'); // already 2026-10-22 in the BigModel service calendar
  const future = Q.normalizeSubscriptionPlan(subscriptionSample({ nextRenewTime: '', currentRenewTime: '',
    valid: '2026-10-21 00:00 ~ 2026-10-22 00:00' }), day);
  assert.equal(future.validEnd, '', 'end of yesterday\'s interval is not a current entitlement');
});


/* ---------- issue #68：apiKey 模式连接（bigmodel-api[-N] / zai-api[-N]） ---------- */
function apiKeyRules(rules) {
  return { config: { providerConfigRules: { providerRules: rules.map(([id, type, apiKey, baseUrl]) => (
    { providerId: id, providerName: id, config: { access: { type, apiKey }, api: baseUrl ? { baseUrl } : {} } }
  )) } } };
}
function apiKeyClient({ rules, creds, env, secrets }) {
  const calls = [];
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV, env || {}), now: () => T0,
    credsPath: "/virtual/credentials.json", secretsPath: "/virtual/quota-secrets.json",
    customCfgPath: "/virtual/provider_config.json",
    readFile: (p) => {
      if (p.endsWith("credentials.json")) { if (!creds) throw new Error("ENOENT"); return creds; }
      if (p.endsWith("quota-secrets.json")) return secrets || { sources: {} };
      return apiKeyRules(rules || []);
    },
    fetchImpl: (url, init) => { const d = deferred(); calls.push({ url, auth: init.headers.authorization, d }); return d.promise; },
  });
  return { client, calls };
}
const quotaCalls = (x) => x.calls.filter((c) => c.url.indexOf("/quota/limit") >= 0);

test("apiKey mode: bigmodel-api-2 coding-plan key hits the quota endpoint with a bare header and fills the isolated source", async () => {
  const x = apiKeyClient({ rules: [["bigmodel-api", "api-key", "sk-plain"], ["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-plan"]] });
  x.client.noteProvider("bigmodel-api-2");
  x.client.tick();
  const q = quotaCalls(x);
  assert.equal(q.length, 1);
  assert.equal(q[0].url, BIGMODEL_URL);
  assert.equal(q[0].auth, "sk-plan");
  for (const c of x.calls) c.d.resolve(fakeRes(200, c.url.indexOf("subscription") >= 0 ? SUB_OK : OK_BODY));
  await flush();
  const v = x.client.view();
  assert.equal(v.byProvider["bigmodel-api-2"], "bigmodel:bigmodel-api-2");
  assert.equal(v.sources["bigmodel:bigmodel-api-2"].status, "ok");
  assert.equal(v.sources["bigmodel:bigmodel-api-2"].windows.fiveHour.percent, 26);
  assert.equal(v.sources["bigmodel:bigmodel-api-2"].keySource, undefined);
  assert.ok(!JSON.stringify(v).includes("sk-plan"), "key never reaches the view");
});

test("apiKey mode: plain provider session still prefers the family coding-plan key over its own plain key", async () => {
  const x = apiKeyClient({ rules: [["bigmodel-api", "api-key", "sk-plain"], ["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-plan"]] });
  x.client.noteProvider("bigmodel-api");
  x.client.tick();
  assert.equal(quotaCalls(x)[0].auth, "sk-plan");
  x.client.dispose();
  const y = apiKeyClient({ rules: [["bigmodel-api", "api-key", "sk-plain"]] });
  y.client.noteProvider("bigmodel-api");
  y.client.tick();
  assert.equal(quotaCalls(y)[0].auth, "sk-plain");   // 无编码套餐 key：用自身 key，交服务端判 no_plan
  y.client.dispose();
});

test("apiKey mode: zai-api uses Bearer on api.z.ai and never borrows a bigmodel key", async () => {
  const x = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-bm"], ["zai-api", "api-key", "sk-zai"]] });
  x.client.noteProvider("zai-api");
  x.client.tick();
  const q = quotaCalls(x);
  assert.equal(q.length, 1);
  assert.equal(q[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(q[0].auth, "Bearer sk-zai");
  x.client.dispose();
  const none = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-bm"]] });
  none.client.noteProvider("zai-api");
  none.client.tick();
  assert.equal(none.calls.length, 0);
  assert.equal(none.client.view().sources["zai:zai-api"].status, "not_configured");
  none.client.dispose();
});

test("apiKey mode: env and write-only settings keys outrank provider_config; OAuth credentials do not outrank it", () => {
  const env = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-plan"]], env: { ZCODE_BIGMODEL_USAGE_API_KEY: "sk-env" } });
  env.client.noteProvider("bigmodel-api-2"); env.client.tick();
  assert.equal(quotaCalls(env)[0].auth, "sk-env");
  const sec = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-plan"]], secrets: { sources: { bigmodel: { apiKey: "sk-set" } } } });
  sec.client.noteProvider("bigmodel-api-2"); sec.client.tick();
  assert.equal(quotaCalls(sec)[0].auth, "sk-set");
  const oauth = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-plan"]], creds: CRED_FILE("jwt.oauth.token") });
  oauth.client.noteProvider("bigmodel-api-2"); oauth.client.tick();
  assert.equal(quotaCalls(oauth)[0].auth, "sk-plan");
  for (const x of [env, sec, oauth]) x.client.dispose();
});

test("apiKey mode: provider key aimed at a third-party base URL is never sent to the official domain", () => {
  const x = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-leak", "https://relay.example.com/v1"]] });
  x.client.noteProvider("bigmodel-api-2"); x.client.tick();
  assert.equal(x.calls.length, 0);
  const ok = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-ok", "https://open.bigmodel.cn/api/coding/paas/v4"]] });
  ok.client.noteProvider("bigmodel-api-2"); ok.client.tick();
  assert.equal(quotaCalls(ok)[0].auth, "sk-ok");
  const evil = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-evil", "https://bigmodel.cn.evil.com"]] });
  evil.client.noteProvider("bigmodel-api-2"); evil.client.tick();
  assert.equal(evil.calls.length, 0);
  for (const c of [x, ok, evil]) c.client.dispose();
});

test("apiKey mode: replacing the provider key unfreezes a no_plan source; key file change is the only trigger", async () => {
  const rules = [["bigmodel-api", "api-key", "sk-old"]];
  const calls = [];
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV), now: () => T0, credsPath: "/virtual/credentials.json",
    secretsPath: "/virtual/quota-secrets.json", customCfgPath: "/virtual/provider_config.json",
    readFile: (p) => { if (p.endsWith("credentials.json")) throw new Error("ENOENT"); if (p.endsWith("quota-secrets.json")) return { sources: {} }; return apiKeyRules(rules); },
    fetchImpl: (url, init) => { const d = deferred(); calls.push({ url, auth: init.headers.authorization, d }); return d.promise; },
  });
  const quotaOnly = () => calls.filter((c) => c.url.indexOf("/quota/limit") >= 0);
  client.noteProvider("bigmodel-api"); client.tick();
  quotaOnly()[0].d.resolve(fakeRes(200, JSON.stringify({ code: 500, msg: "当前用户不存在coding plan", success: false })));
  for (const c of calls) if (c.url.indexOf("subscription") >= 0) c.d.resolve(fakeRes(200, "{}"));
  await flush();
  assert.equal(client.view().sources["bigmodel:bigmodel-api"].status, "no_plan");
  client.tick();
  assert.equal(quotaOnly().length, 1);   // 冻结
  rules[0][2] = "sk-new";
  client.credentialsChanged(); client.tick();
  assert.equal(quotaOnly().length, 2);
  assert.equal(quotaOnly()[1].auth, "sk-new");
  client.dispose();
});

/* ---------- 变异审查补充（issue #68） ---------- */
const sendKey = (rules, provider, opts) => {
  const x = apiKeyClient(Object.assign({ rules }, opts || {}));
  x.client.noteProvider(provider); x.client.tick();
  const a = quotaCalls(x).map((c) => c.auth);
  x.client.dispose();
  return a;
};

test("apiKey mode: zai-api baseUrl host gate (official ok; lookalikes and bigmodel hosts rejected)", () => {
  const mk = (u) => [["zai-api", "api-key", "sk-z", u]];
  assert.deepEqual(sendKey(mk("https://api.z.ai/api/coding/paas/v4"), "zai-api"), ["Bearer sk-z"]);
  assert.deepEqual(sendKey(mk("https://z.ai"), "zai-api"), ["Bearer sk-z"]);
  assert.deepEqual(sendKey(mk("https://evilz.ai/v1"), "zai-api"), []);          // 无左边界
  assert.deepEqual(sendKey(mk("https://api.z.ai.evil.com/v1"), "zai-api"), []);  // 无右锚
  assert.deepEqual(sendKey(mk("https://open.bigmodel.cn/api/paas/v4"), "zai-api"), []); // 跨家族域
  assert.deepEqual(sendKey([["bigmodel-api", "api-key", "sk-b", "https://api.z.ai/v1"]], "bigmodel-api"), []);
});

test("apiKey mode: bigmodel host gate needs a dot boundary and parseable URL", () => {
  const mk = (u) => [["bigmodel-api", "api-key", "sk-b", u]];
  assert.deepEqual(sendKey(mk("https://evilbigmodel.cn/v1"), "bigmodel-api"), []);
  assert.deepEqual(sendKey(mk("relay.example.com/v1"), "bigmodel-api"), []);        // 无 scheme：URL 抛错，fail-closed
  assert.deepEqual(sendKey(mk("https://evil.com#.bigmodel.cn"), "bigmodel-api"), []); // 以 URL 解析的 hostname 为准
  assert.deepEqual(sendKey(mk("https://open.bigmodel.cn:8443/v1"), "bigmodel-api"), ["sk-b"]);
});

test("apiKey mode: key selection order (own plan > any plan in config order > own plain > first plain), skips empty and third-party keys", () => {
  const P = "zhipu-coding-plan-api-key";
  // 两个编码套餐 key：自身的优先，否则按配置顺序取第一个
  assert.deepEqual(sendKey([["bigmodel-api", P, "sk-p1"], ["bigmodel-api-2", P, "sk-p2"]], "bigmodel-api-2"), ["sk-p2"]);
  assert.deepEqual(sendKey([["bigmodel-api-2", P, "sk-p2"], ["bigmodel-api-3", P, "sk-p3"], ["bigmodel-api", "api-key", "sk-x"]], "bigmodel-api"), ["sk-p2"]);
  // 无套餐 key：自身普通 key 优先于配置里靠前的同家族普通 key
  assert.deepEqual(sendKey([["bigmodel-api", "api-key", "sk-a"], ["bigmodel-api-2", "api-key", "sk-b"]], "bigmodel-api-2"), ["sk-b"]);
  // 自身无可用 key（空 key / 指向第三方）：退到同家族首个可用 key
  assert.deepEqual(sendKey([["bigmodel-api", "api-key", ""], ["bigmodel-api-2", "api-key", "sk-b"]], "bigmodel-api"), ["sk-b"]);
  assert.deepEqual(sendKey([["bigmodel-api", "api-key", "sk-relay", "https://relay.example.com"], ["bigmodel-api-2", "api-key", "sk-b"]], "bigmodel-api"), ["sk-b"]);
  // 空 key 不得被当作"可用"选中（否则会以空 Authorization 发请求）
  assert.deepEqual(sendKey([["bigmodel-api", "api-key", ""]], "bigmodel-api"), []);
  // 同家族多个普通 key，自身不在其中：取配置顺序第一个
  assert.deepEqual(sendKey([["bigmodel-api-2", "api-key", "sk-2"], ["bigmodel-api-3", "api-key", "sk-3"]], "bigmodel-api"), ["sk-2"]);
  // accessType 须以 coding-plan-api-key 结尾
  assert.deepEqual(sendKey([["bigmodel-api", "api-key", "sk-a"], ["bigmodel-api-2", "coding-plan-api-key-legacy", "sk-b"]], "bigmodel-api"), ["sk-a"]);
});

test("apiKey mode: OAuth (account:*) sessions never pick provider_config keys; apiKey provider without key falls back to OAuth", () => {
  const oauth = CRED_FILE("jwt.oauth.token");
  const x = apiKeyClient({ rules: [["bigmodel-api-2", "zhipu-coding-plan-api-key", "sk-plan"]], creds: oauth });
  x.client.noteProvider("account:bigmodel"); x.client.tick();
  assert.notEqual(quotaCalls(x)[0].auth, "sk-plan");
  x.client.dispose();
  const y = apiKeyClient({ rules: [], creds: oauth });
  y.client.noteProvider("bigmodel-api"); y.client.tick();
  assert.equal(quotaCalls(y).length, 1);   // 回退宿主 OAuth（按产品决定调整本断言，但必须钉死一种行为）
  y.client.dispose();
});

test("apiKey mode: provider id shape is strict (no bare family, no suffix, no case folding)", () => {
  for (const p of ["bigmodel", "zai", "bigmodel-api-x", "zai-api-", "zai-apix", "BigModel-API", "bigmodel-api-2-x", "x-zai-api"]) {
    assert.equal(Q.resolveWanted(p), null, p);
  }
  assert.deepEqual(Q.resolveWanted("zai-api-12"), { family: "zai" });
});

test("apiKey mode: raw key never appears in fingerprints or state", () => {
  const x = apiKeyClient({ rules: [["bigmodel-api", "api-key", "sk-secret-123"]] });
  x.client.noteProvider("bigmodel-api"); x.client.tick();
  for (const st of x.client._states.values()) assert.ok(!JSON.stringify({ fp: st.fingerprint, v: st.value, e: st.lastError }).includes("sk-secret-123"));
  x.client.dispose();
});

/* ---------- v102 预设模板 ---------- */
test("sourcesConfig ships static presets, keyUrl and non-secret baseUrl", () => {
  const { client } = adapterClient({ secrets: { sources: { minimax: { apiKey: "sk-mm", baseUrl: "https://api.minimax.io/" } } } });
  const mm = client.sourcesConfig().find(s => s.id === "minimax");
  assert.deepEqual(mm.presets, [
    { label: "国内站", labelEn: "China", value: "https://api.minimaxi.com" },
    { label: "国际站", labelEn: "Global", value: "https://api.minimax.io" },
  ]);
  assert.equal(mm.keyUrl, "https://platform.minimaxi.com");
  assert.equal(mm.baseUrl, "https://api.minimax.io/");   // 域名回显（模板高亮用），非凭据
  assert.equal(mm.apiKey, undefined, "apiKey must never reach sourcesConfig");
  const ds = client.sourcesConfig().find(s => s.id === "deepseek");
  assert.equal(ds.presets, undefined);
  assert.equal(ds.keyUrl, "https://platform.deepseek.com/api_keys");
  assert.equal(client.sourcesConfig().find(s => s.id === "custom"), undefined);
});

test("siliconflow honours the preset baseUrl only for trusted hosts and derives the currency", async () => {
  const { client, calls } = adapterClient({
    secrets: { sources: { siliconflow: { apiKey: "sk-sf", baseUrl: "https://api.siliconflow.com" } } },
  });
  client.tick();
  assert.equal(calls[0].url, "https://api.siliconflow.com/v1/user/info");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ data: { totalBalance: "9.5" } })));   // 响应无 currency：按域推导
  await flush();
  const st = client.view().sources.siliconflow;
  assert.equal(st.balance.amount, 9.5);
  assert.equal(st.balance.currency, "USD");
});

test("siliconflow falls back to the default origin for untrusted preset hosts", async () => {
  const { client, calls } = adapterClient({
    secrets: { sources: { siliconflow: { apiKey: "sk-sf", baseUrl: "https://evil.example.com" } } },
  });
  client.tick();
  assert.equal(calls[0].url, "https://api.siliconflow.cn/v1/user/info");
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ data: { totalBalance: "1", currency: "CNY" } })));
  await flush();
  assert.equal(client.view().sources.siliconflow.status, "ok");
});

test("explicitly disabled sources report status 'disabled' instead of a fake idle", () => {
  const { client } = adapterClient({ secrets: { sources: { deepseek: { enabled: false, apiKey: "sk-ds" } } } });
  const ds = client.sourcesConfig().find(s => s.id === "deepseek");
  assert.equal(ds.enabled, false);
  assert.equal(ds.status, "disabled");   // 旧逻辑在无激活账号时会透传 idle，面板出现「开关已关却显示待查询」
});

/* ---------- 2026-10-24 夜间扫描回归：Kimi 余额零值/回落门 + 火山 post 状态分类 ---------- */

test("kimi: PAYG zero balance is a legal value, not parse_error", async () => {
  const b = adapterClient({ cfgEntries: [["kimi0", "https://api.kimi.com", "sk-payg0"]] });
  b.client.noteProvider("kimi0");
  b.client.tick();
  b.calls[0].d.resolve(fakeRes(401, "{}"));   // 非订阅 Key → PAYG 回落
  await flush();
  const paygCalls = b.calls.filter((c) => c.url.indexOf("moonshot") >= 0);
  paygCalls[paygCalls.length - 1].d.resolve(fakeRes(200, JSON.stringify({ available_balance: 0 })));
  await flush();
  const v = b.client.view();
  assert.equal(v.status, "ok", "零余额可显示（旧实现被 || 短路成 parse_error 30 分钟退避）");
  assert.equal(v.balance.amount, 0);
});

test("kimi: transient subscription-endpoint failures do not masquerade as PAYG balance", async () => {
  const b = adapterClient({ cfgEntries: [["kimi5", "https://api.kimi.com", "sk-x"]] });
  b.client.noteProvider("kimi5");
  b.client.tick();
  b.calls[0].d.resolve(fakeRes(502, "bad gateway"));   // /usages 瞬时失败
  await flush();
  const second = b.calls.find((c) => c.url.endsWith("/coding/v1/usage"));
  assert.ok(second, "回落尝试第二订阅端点");
  second.d.resolve(fakeRes(500, "boom"));              // 也失败
  await flush();
  await flush();
  const moonshot = b.calls.filter((c) => c.url.indexOf("moonshot") >= 0);
  assert.equal(moonshot.length, 0, "订阅端点瞬时失败不得查 PAYG 余额冒充套餐");
  const sv = b.client.view();
  assert.equal(sv.status, "network_error", "按网络错误分类进入常规退避");
});

test("volcano post: non-JSON gateway error page maps to network_error, not 30-min parse_error", async () => {
  const b = adapterClient({ secrets: { sources: { volcano: { enabled: true, accessKeyId: "ak", secretAccessKey: "sk" } } } });
  b.client.noteProvider("volcano");
  b.client.tick();
  b.calls[0].d.resolve(fakeRes(502, "<html>Gateway Timeout</html>"));   // AFP 探测：瞬时失败被有意吞掉继续探 CodingPlan
  await flush();
  const cp = b.calls.find((c) => c.url.indexOf("GetCodingPlanUsage") >= 0);
  cp.d.resolve(fakeRes(502, "<html>Gateway Timeout</html>"));
  await flush();
  const sv = b.client.view().sources.volcano;
  assert.equal(sv.status, "network_error", "非 JSON 错误页按状态分类走阶梯退避（旧实现 parse_error 30 分钟）");
});

test("volcano post: 400 with JSON signature envelope stays auth_failed (envelope precedes status)", async () => {
  const b = adapterClient({ secrets: { sources: { volcano: { enabled: true, accessKeyId: "bad", secretAccessKey: "bad" } } } });
  b.client.noteProvider("volcano");
  b.client.tick();
  b.calls[0].d.resolve(fakeRes(400, JSON.stringify({ ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch" } } })));
  await flush();
  assert.equal(b.client.view().sources.volcano.status, "auth_failed");
});

/* ---------- 2026-10-24 第 4 轮回归：team 词边界 / 坏 baseUrl 归 unsupported ---------- */

test("team detection uses word boundaries: substring-only ids are not team plans", () => {
  assert.deepEqual(Q.resolveWanted("account:bigmodel-team-coding-plan"), { unsupported: "team" });
  assert.deepEqual(Q.resolveWanted("account:zai-team"), { unsupported: "team" });
  const steam = Q.resolveWanted("account:steam-promo");   // 含 "team" 子串的假想 id
  assert.ok(!steam || !steam.unsupported || steam.unsupported !== "team",
    "substring match must not misclassify: " + JSON.stringify(steam));
});

test("empty/invalid relay baseUrl classifies as unsupported, not parse_error", () => {
  assert.throws(() => Q.relayQuotaUrls(""), e => e.code === "unsupported");
  assert.throws(() => Q.relayQuotaUrls("not a url"), e => e.code === "unsupported");
  // scheme/userinfo 安全门维持既有分类（parse_error），测试 976-977 已锁定
});
