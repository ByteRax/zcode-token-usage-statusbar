const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");

const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* ---------- 夹具（与 quota-client.test.cjs 同款） ---------- */
const ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };
const KEY = Q.deriveCipherKey(ENV);
function encryptValue(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + iv.toString("base64url") + "." + c.getAuthTag().toString("base64url") + "." + ct.toString("base64url");
}
function deferred() {
  let resolve, reject;
  const p = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise: p, resolve, reject };
}
function fakeRes(status, body) {
  return { status, headers: { get: () => null }, text: async () => body };
}
const flush = () => new Promise((r) => setTimeout(r, 5));
const DEVICE_MID = "0123456789abcdef0123456789abcdef";
const START_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const T0 = 1792775513000;   // 与样例 server_time 对齐（2026-10-24 01:11:53 +08）

/* 真实响应裁剪：1024 Dev Day 双桶（Flash 3亿 / GLM-5.3 2亿） */
const START_BODY = {
  code: 0, msg: "操作成功", success: true,
  data: {
    server_time: 1792775513,
    plans: [{
      user_plan_id: "upl_1", plan_id: "zcode-v3-start-plan-1024", name: "ZCode 1024 Dev Day",
      priority: 101, status: "active", starts_at: 1792757397, ends_at: 1792976400,
      entitlements: [{ entitlement_id: "e1", show_name: "GLM-5.3-Flash", meter: "model_usage",
        capabilities: ["model:glm-5.3-flash"], grant_units: 300000000, period: "one_time", effective_at: 1792767600 }],
    }],
    balances: [
      { bucket_id: "b1", plan_id: "zcode-v3-start-plan-1024", show_name: "GLM-5.3-Flash", meter: "model_usage",
        total_units: 300000000, used_units: 41486791, remaining_units: 258513209, expires_at: 1792976400 },
      { bucket_id: "b2", plan_id: "zcode-v3-start-plan-1024", show_name: "GLM-5.3", meter: "model_usage",
        total_units: 200000000, used_units: 4974987, remaining_units: 195025013, expires_at: 1792976400 },
    ],
  },
};

function localStamp(ms) {   // zcodeStartStamp 的本地时区镜像（断言与时区无关）
  const d = new Date(ms);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/* zcodejwttoken 凭据 + 设备号文件（readFile 按路径分发，虚拟路径） */
function makeClient({ body, env, secrets } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const credsRef = { value: { zcodejwttoken: encryptValue("start.jwt.token"), "oauth:bigmodel:access_token": encryptValue("jwt.test.token") } };
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV, env || {}),
    now: () => clock.t,
    credsPath: "/virtual/credentials.json",
    readFile: (p) => {
      if (p === "/virtual/credentials.json") return credsRef.value;
      if (p === "/virtual/telemetry-state.json") return { deviceMid: DEVICE_MID };
      if (p === "/virtual/quota-secrets.json") return secrets || { sources: {} };
      throw new Error("ENOENT: " + p);
    },
    fetchImpl: (url, init) => {
      if (url.indexOf("/api/biz/subscription/list") >= 0) {   // bigmodel 并行订阅拉取：空清单（plan 置 null），不入 calls
        return Promise.resolve(fakeRes(200, JSON.stringify({ success: true, data: [] })));
      }
      const d = deferred();
      calls.push({
        url, headers: init.headers, d,
        respond: (override) => d.resolve(fakeRes(200, JSON.stringify(override != null ? override : (body != null ? body : START_BODY)))),
      });
      return d.promise;
    },
  });
  return { client, clock, calls, credsRef };
}

/* ---------- 归一化 ---------- */
test("zcode-start normalize: real sample shape aggregates model_usage buckets with plan pool window", () => {
  const v = Q.normalizeZcodeStartBalance(START_BODY, T0);
  assert.equal(v.level, "Start");
  assert.equal(v.plan.productName, "ZCode 1024 Dev Day");
  assert.equal(v.plan.validStart, localStamp(1792757397000));
  assert.equal(v.plan.validEnd, localStamp(1792976400000));
  assert.equal(v.windows.plan.percent, 9.3);   // (41486791+4974987)/5亿 自算
  assert.equal(v.windows.plan.expires, true);
  assert.equal(v.windows.plan.resetsAt, 1792976400000);
  assert.equal(v.windows.plan.used, undefined);   // 金额明细是货币格式，token 绝对量不进窗口行
  assert.equal(v.windows.plan.total, undefined);
  assert.equal(v.windows.plan.remaining, undefined);
  assert.deepEqual(v.models, ["GLM-5.3-Flash", "GLM-5.3"]);   // 大桶在前
  assert.equal(v.windows.fiveHour, null);
  assert.equal(v.windows.weekly, null);
});

test("zcode-start normalize: active-but-ended plan reclassified by server_time (PRe parity) → no_plan", () => {
  const body = JSON.parse(JSON.stringify(START_BODY));
  body.data.server_time = 1792976400 + 10;   // ends_at 之后
  const v = Q.normalizeZcodeStartBalance(body, T0);
  assert.deepEqual(v, { noPlan: true });
});

test("zcode-start normalize: expired plan buckets filtered, live plan kept; dead buckets excluded", () => {
  const body = JSON.parse(JSON.stringify(START_BODY));
  const old = { plan_id: "zcode-v3-old", name: "Old Grant", status: "active", starts_at: 1, ends_at: 1792770000, priority: 1 };   // ends_at <= server_time
  body.data.plans.unshift(old);
  body.data.balances.unshift({ bucket_id: "b0", plan_id: "zcode-v3-old", show_name: "Old", meter: "model_usage",
    total_units: 900000000, used_units: 1, remaining_units: 899999999, expires_at: 1792770000 });
  body.data.balances.push({ bucket_id: "b3", plan_id: "zcode-v3-start-plan-1024", show_name: "Dead", meter: "model_usage",
    total_units: 50000000, used_units: 10, remaining_units: 0, expires_at: 1792770000 });   // 活 plan 下的死桶
  const v = Q.normalizeZcodeStartBalance(body, T0);
  assert.equal(v.plan.productName, "ZCode 1024 Dev Day");   // 优先级 101 > 1，老 plan 整段不采信
  assert.equal(v.windows.plan.percent, 9.3);                // 9亿旧桶与 5千万死桶都不进聚合（混入旧桶会稀释到 3.2）
  assert.deepEqual(v.models, ["GLM-5.3-Flash", "GLM-5.3"]);
});

test("zcode-start normalize: non-model_usage meter and zero-total buckets ignored; missing remaining falls back", () => {
  const body = JSON.parse(JSON.stringify(START_BODY));
  body.data.balances = [
    { bucket_id: "x1", plan_id: "zcode-v3-start-plan-1024", show_name: "Tool", meter: "tool_calls", total_units: 100, used_units: 1, remaining_units: 99, expires_at: 1792976400 },
    { bucket_id: "x2", plan_id: "zcode-v3-start-plan-1024", show_name: "Zero", meter: "model_usage", total_units: 0, used_units: 0, remaining_units: 0, expires_at: 1792976400 },
    { bucket_id: "x3", plan_id: "zcode-v3-start-plan-1024", show_name: "GLM-5.3-Flash", meter: "model_usage", total_units: 300000000, used_units: 30000000, expires_at: 1792976400 },
  ];
  const v = Q.normalizeZcodeStartBalance(body, T0);
  assert.equal(v.windows.plan.percent, 10);   // 只聚合 x3：3亿池已用 3000万
  assert.deepEqual(v.models, ["GLM-5.3-Flash"]);
});

test("zcode-start normalize: error envelope is retryable; malformed body is parse_error", () => {
  assert.throws(() => Q.normalizeZcodeStartBalance({ code: 3001, msg: "parameter error" }, T0),
    (e) => e.code === "network_error" && /business error/.test(e.message));   // 业务错误按可重试退避，不冒充 no_plan
  assert.throws(() => Q.normalizeZcodeStartBalance({ success: true }, T0), (e) => e.code === "parse_error");
  assert.throws(() => Q.normalizeZcodeStartBalance(null, T0), (e) => e.code === "parse_error");
});

/* ---------- 路由 ---------- */
test("resolveWanted: start-plan ids route to zcode-start, coding-plan ids unchanged", () => {
  assert.deepEqual(Q.resolveWanted("account:bigmodel-start-plan"), { family: "zcode-start" });
  assert.deepEqual(Q.resolveWanted("account:zai-start-plan"), { family: "zcode-start" });
  assert.deepEqual(Q.resolveWanted("account:bigmodel-individual-coding-plan"), { family: "bigmodel" });
  assert.deepEqual(Q.resolveWanted("account:zai-pro-coding-plan"), { family: "zai" });
  assert.deepEqual(Q.resolveWanted("account:bigmodel-team-coding-plan"), { unsupported: "team" });
});

/* ---------- 客户端状态机 ---------- */
test("zcode-start client: zcodejwttoken + X-Device-Mid request, view shape, no app_version param", async () => {
  const { client, calls } = makeClient();
  client.noteProvider("account:bigmodel-start-plan");
  client.setProviders(["account:bigmodel-start-plan"]);
  client.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, START_URL);   // 无 query 参数
  assert.equal(calls[0].headers.authorization, "Bearer start.jwt.token");
  assert.equal(calls[0].headers["X-Device-Mid"], DEVICE_MID);
  calls[0].respond();
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.providerId, "account:bigmodel-start-plan");
  assert.equal(v.byProvider["account:bigmodel-start-plan"], "zcode-start");   // 主进程映射锁死：start-plan pane 不得回读编码套餐池
  assert.equal(v.level, "Start");
  assert.equal(v.windows.plan.percent, 9.3);
  assert.deepEqual(v.models, ["GLM-5.3-Flash", "GLM-5.3"]);
});

test("zcode-start client: missing deviceMid fails closed without any request", async () => {
  const fetchCalls = [];
  const probe = Q.createQuotaClient({
    env: ENV, now: () => T0, credsPath: "/virtual/credentials.json",
    readFile: (p) => { if (p === "/virtual/credentials.json") return { zcodejwttoken: encryptValue("t") }; throw new Error("ENOENT"); },
    fetchImpl: (url, init) => { fetchCalls.push(url); throw new Error("must not fetch"); },
  });
  probe.noteProvider("account:bigmodel-start-plan");
  probe.setProviders(["account:bigmodel-start-plan"]);
  probe.tick();
  assert.equal(fetchCalls.length, 0);   // fail-closed：不发请求（误发会走 settleError 而非 not_configured）
  assert.equal(probe.view().status, "not_configured");
  probe.dispose();
});

test("zcode-start client: no active plan freezes; token refresh unfreezes", async () => {
  const { client, calls, credsRef } = makeClient({ body: { code: 0, success: true, data: { server_time: 1792976500, plans: [], balances: [] } } });
  client.noteProvider("account:bigmodel-start-plan");
  client.setProviders(["account:bigmodel-start-plan"]);
  client.tick();
  calls[0].respond();
  await flush();
  assert.equal(client.view().status, "no_plan");
  client.tick();
  assert.equal(calls.length, 1);   // 冻结
  credsRef.value = { zcodejwttoken: encryptValue("start.jwt.renewed") };   // 重新登录（密文变化）
  client.credentialsChanged();
  client.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.authorization, "Bearer start.jwt.renewed");
  calls[1].respond(START_BODY);   // 解冻后拿到有效套餐
  await flush();
  assert.equal(client.view().status, "ok");
});

test("zcode-start client: secrets apiKey overrides host zcodejwttoken; oauth access_token never used", async () => {
  const { client, calls } = makeClient({ secrets: { sources: { "zcode-start": { apiKey: " manual.key " } } } });
  client.noteProvider("account:bigmodel-start-plan");
  client.setProviders(["account:bigmodel-start-plan"]);
  client.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer manual.key");   // trim 过的 secrets key
  calls[0].respond();
  await flush();
  assert.equal(client.view().status, "ok");
});

test("zcode-start client: 401 freezes to credential fingerprint; coding-plan pane never fetches this source", async () => {
  const { client, calls, clock } = makeClient();
  client.noteProvider("account:bigmodel-start-plan");
  client.setProviders(["account:bigmodel-start-plan"]);
  client.tick();
  calls[0].d.resolve(fakeRes(401, "{}"));
  await flush();
  assert.equal(client.view().status, "auth_failed");
  clock.t += 60 * 60 * 1000;
  client.tick();
  assert.equal(calls.length, 1);   // 冻结
  client.dispose();

  const solo = makeClient();
  solo.client.noteProvider("account:bigmodel-individual-coding-plan");
  solo.client.setProviders(["account:bigmodel-individual-coding-plan"]);
  solo.client.tick();
  await flush();
  assert.ok(solo.calls.every((c) => c.url.indexOf("zcode.z.ai") < 0), "编码套餐 pane 只发 monitor 请求，不触发 zcode-start");
  assert.equal(solo.client.view().active, "bigmodel");
  solo.client.dispose();
});

test("zcode-start client: corrupted zcodejwttoken ciphertext is decrypt failure, not_configured without fetch", async () => {
  const fetchCalls = [];
  const probe = Q.createQuotaClient({
    env: ENV, now: () => T0, credsPath: "/virtual/credentials.json",
    readFile: (p) => {
      if (p === "/virtual/credentials.json") return { zcodejwttoken: "enc:v1:not.valid.ciphertext" };   // 密文损坏（错 key 加密/结构残缺）
      if (p === "/virtual/telemetry-state.json") return { deviceMid: DEVICE_MID };
      throw new Error("ENOENT");
    },
    fetchImpl: (url) => { fetchCalls.push(url); throw new Error("must not fetch"); },
  });
  probe.noteProvider("account:bigmodel-start-plan");
  probe.setProviders(["account:bigmodel-start-plan"]);
  probe.tick();
  assert.equal(fetchCalls.length, 0);
  const v = probe.view();
  assert.equal(v.status, "not_configured");
  assert.equal(v.reason, "decrypt");
  probe.dispose();
});

test("zcode-start client: mixed wanted providers run both pools in parallel with isolated byProvider mapping", async () => {
  const { client, calls } = makeClient();
  client.setProviders(["account:bigmodel-individual-coding-plan", "account:bigmodel-start-plan"]);
  client.tick();
  assert.equal(calls.length, 2);   // 两个池各自一条请求，互不借数
  const urls = calls.map((c) => c.url).sort();
  assert.deepEqual(urls, [
    "https://bigmodel.cn/api/monitor/usage/quota/limit",
    "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
  ]);
  const OK_MONITOR = { success: true, data: { level: "max", limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 26, nextResetTime: 1793176110955 }] } };
  for (const c of calls) c.respond(c.url.indexOf("zcode.z.ai") >= 0 ? undefined : OK_MONITOR);   // 各喂各的协议形状
  await flush();
  const v = client.view();
  assert.equal(v.byProvider["account:bigmodel-individual-coding-plan"], "bigmodel");
  assert.equal(v.byProvider["account:bigmodel-start-plan"], "zcode-start");
  assert.equal(v.sources.bigmodel.status, "ok");
  assert.equal(v.sources["zcode-start"].status, "ok");
  client.dispose();
});
