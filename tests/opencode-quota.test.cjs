const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* OpenCode Go 适配器（$10/月订阅，端点只认 Bearer）：
 * 主链 GET https://opencode.ai/console/api/go/status（控制台 Go 页面同源，meters 给精确
 * microcent 金额）；兜底 GET https://opencode.ai/zen/go/v1/usage（未文档化第一方端点，
 * {usage:{rolling|weekly|monthly:{status,percent(已用0-100),resetsAt(ISO)}}}）。
 * 夹具为 quota-client.test.cjs 五件套的本地复刻（fetchImpl 额外记录认证头）。
 * `calls` 只记录 public usage 端点（既有断言口径）；控制台请求走 `statusCalls`，
 * 默认自动回 404，让既有用例继续覆盖 usage 兜底链。 */
const ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };
const T0 = 1700000000000;
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const STATUS_URL = "https://opencode.ai/console/api/go/status";

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

function customCfgFile(entries) {
  return { config: { providerConfigRules: { providerRules: entries.map(([id, baseUrl, apiKey]) => (
    { providerId: id, providerName: id, config: { api: { type: "openai-chat-completions", baseUrl }, access: { type: "api-key", apiKey } } }
  )) } } };
}
function adapterClient({ cfgEntries, personalCfg, builtinCfg, secrets, env, respond, statusRespond } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const statusCalls = [];
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV, env || {}),
    now: () => clock.t,
    credsPath: "/virtual/credentials.json",
    secretsPath: "/virtual/quota-secrets.json",
    readFile: (p) => {
      if (p.endsWith("credentials.json")) { throw new Error("ENOENT"); }
      if (p.endsWith("quota-secrets.json")) return secrets || { sources: {} };
      if (p.endsWith("builtin.json")) return builtinCfg || { config: { providerConfigRules: {} } };
      return personalCfg || customCfgFile(cfgEntries || []);
    },
    customCfgPath: "/virtual/provider_config.json",
    builtinCfgPath: "/virtual/builtin.json",
    fetchImpl: (url, init) => {
      const d = deferred();
      const entry = { url, auth: init && init.headers ? init.headers.authorization : "", signal: init && init.signal, d };
      /* 真 fetch 在 abort 时拒绝；替身同样拒绝，才能覆盖父信号联动/3 秒宽限超时路径。 */
      if (entry.signal && typeof entry.signal.addEventListener === "function") {
        entry.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          d.reject(err);
        }, { once: true });
      }
      if (url === STATUS_URL) {
        statusCalls.push(entry);
        if (statusRespond) statusRespond(url, d);
        else d.resolve(fakeRes(404, "{}"));   // 默认控制台不可用：既有用例继续走 usage 兜底链
      } else {
        calls.push(entry);
        if (respond) respond(url, d);
      }
      return d.promise;
    },
  });
  return { client, clock, calls, statusCalls };
}

const GO_BODY = JSON.stringify({ usage: {
  rolling: { status: "ok", percent: 37, resetsAt: "2026-08-26T14:12:03.000Z" },
  weekly: { status: "ok", percent: 62, resetsAt: "2026-08-31T00:00:00.000Z" },
  monthly: { status: "ok", percent: 80, resetsAt: "2026-09-11T00:00:00.000Z" },
} });

/* 真实控制台响应形状（2026-11-15 实测；microcent 字段是字符串）。$12/$30/$60 三窗，
 * 5 小时窗 7990374/1200000000 = 0.67%——public usage 端点会向下取整回 0%。 */
const GO_STATUS_BODY = JSON.stringify({
  subscriberUserId: "user_test",
  product: "go",
  renewalProduct: "go",
  useBalance: false,
  cancelAtPeriodEnd: false,
  resumability: "renewing",
  access: {
    startsAt: "2026-11-08T16:50:08.000Z",
    endsAt: "2026-12-08T16:50:08.000Z",
    cancelAtPeriodEnd: false,
    meters: {
      fiveHour: { startsAt: "2026-11-15T12:57:51.000Z", resetsAt: "2026-11-15T17:57:51.000Z",
        limitMicroCents: "1200000000", usedMicroCents: "7990374" },
      week: { startsAt: "2026-11-09T00:00:00.000Z", resetsAt: "2026-11-16T00:00:00.000Z",
        limitMicroCents: "3000000000", usedMicroCents: "68248357" },
      month: { resetsAt: "2026-12-08T16:50:08.000Z",
        limitMicroCents: "6000000000", usedMicroCents: "68248357" },
    },
  },
});

test("opencode: detect hits both /zen/go and /zen/go/v1 tiers; canonical endpoint with Bearer", async () => {
  for (const [pid, base] of [["oc-claude", "https://opencode.ai/zen/go"], ["oc-codex", "https://opencode.ai/zen/go/v1"]]) {
    const { client, calls } = adapterClient({ cfgEntries: [[pid, base, "sk-go"]] });
    client.noteProvider(pid);
    client.tick();
    assert.equal(calls[0].url, USAGE_URL, "两档 base 归一到同一用量端点");
    assert.equal(calls[0].auth, "Bearer sk-go");
    assert.equal(client.view().byProvider[pid], "opencode:" + pid);
    calls[0].d.resolve(fakeRes(200, GO_BODY));
    await flush();
    assert.equal(client.view().sources["opencode:" + pid].windows.fiveHour.percent, 37);
    client.dispose();
  }
});

test("opencode: detect excludes /zen/v1 pay-as-you-go tier and foreign domains; key never sent to opencode endpoint", async () => {
  const { client, calls } = adapterClient({
    cfgEntries: [["zen", "https://opencode.ai/zen/v1", "sk-zen"], ["fake", "https://evil.example.com/zen/go/v1", "sk-fake"],
      ["sneaky", "https://opencode.ai/api/zen/go", "sk-x"]],
    respond: (url, d) => { d.resolve(fakeRes(404, "{}")); },
  });
  client.noteProvider("zen");
  client.tick();
  client.noteProvider("fake");
  client.tick();
  await flush();
  for (const c of calls) assert.notEqual(c.url, USAGE_URL, "opencode 适配器未命中，不发用量请求");
  client.noteProvider("sneaky");
  client.tick();
  await flush();
  const v = client.view();
  assert.equal(v.byProvider["zen"], "custom:zen", "Zen 按量版回落 custom");
  assert.equal(v.byProvider["fake"], "custom:fake", "外域路径伪装不命中");
  assert.equal(v.byProvider["sneaky"], "custom:sneaky", "域内非 /zen/go 前缀路径不命中");
  assert.equal(v.sources["custom:zen"].status, "unsupported");
  client.dispose();
});

test("opencode: /zen/gopher prefix look-alike does not hit the adapter", async () => {
  const { client, calls } = adapterClient({
    cfgEntries: [["gopher", "https://opencode.ai/zen/gopher", "sk-x"]],
    respond: (url, d) => { d.resolve(fakeRes(404, "{}")); },
  });
  client.noteProvider("gopher");
  client.tick();
  await flush();
  for (const c of calls) assert.notEqual(c.url, USAGE_URL, "前缀相似但非两档预设不命中");
  assert.equal(client.view().byProvider["gopher"], "custom:gopher");
  client.dispose();
});

test("opencode: three windows map to fiveHour/weekly/monthly; used-percent semantics; ISO resetsAt passthrough", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]] });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(200, GO_BODY));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.deepEqual(Object.keys(v.windows), ["fiveHour", "weekly", "monthly"]);
  assert.equal(v.windows.fiveHour.percent, 37, "rolling→fiveHour，已用%直取（37 不是 63）");
  assert.equal(v.windows.fiveHour.resetsAt, "2026-08-26T14:12:03.000Z", "ISO 原样透传");
  assert.equal(v.windows.weekly.percent, 62);
  assert.equal(v.windows.monthly.percent, 80);
  assert.equal(v.balance, null, "entryView 归一为 null");
  assert.equal(v.level, undefined);
  client.dispose();
});

test("opencode: console status meters expose exact sub-1% five-hour usage and USD amounts", async () => {
  const { client, calls, statusCalls } = adapterClient({
    cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]],
    statusRespond: (url, d) => d.resolve(fakeRes(200, GO_STATUS_BODY)),
  });
  client.noteProvider("oc");
  client.tick();
  await flush();
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].url, STATUS_URL);
  assert.equal(statusCalls[0].auth, "Bearer sk-go");
  assert.equal(calls.length, 1, "public usage 端点并行兜底");
  assert.notEqual(statusCalls[0].signal, calls[0].signal, "两请求各自独立 AbortController");
  assert.equal(calls[0].signal.aborted, true, "控制台命中后取消多余兜底请求");
  calls[0].d.resolve(fakeRes(200, GO_BODY));   // 兜底响应即使成功也不覆盖精确 meters
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.label, "OpenCode Go");
  assert.equal(v.kind, "plan");
  const w = v.windows;
  assert.equal(w.fiveHour.percent, 0.67, "7990374/1200000000 → 0.67%，不是整数 0%");
  assert.equal(w.fiveHour.resetsAt, "2026-11-15T17:57:51.000Z");
  assert.equal(w.fiveHour.currency, "USD");
  assert.equal(w.fiveHour.total, 12);
  assert.ok(Math.abs(w.fiveHour.used - 0.07990374) < 1e-12, "microcent → USD");
  assert.ok(Math.abs(w.fiveHour.remaining - 11.92009626) < 1e-9);
  assert.equal(w.weekly.percent, 2.27);
  assert.equal(w.weekly.total, 30);
  assert.equal(w.monthly.percent, 1.14);
  assert.equal(w.monthly.total, 60);
  assert.equal(w.monthly.resetsAt, "2026-12-08T16:50:08.000Z");
  client.dispose();
});

test("opencode: console status 5xx/malformed/invalid-json falls back to public usage percent chain", async () => {
  for (const [label, statusRes] of [
    ["5xx", fakeRes(500, "{}")],
    ["malformed", fakeRes(200, '{"access":{}}')],
    ["invalid-json", fakeRes(200, "not json")],
  ]) {
    const { client, calls, statusCalls } = adapterClient({
      cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]],
      statusRespond: (url, d) => d.resolve(statusRes),
    });
    client.noteProvider("oc");
    client.tick();
    assert.equal(statusCalls.length, 1, label + "：控制台端点确实请求过");
    assert.equal(statusCalls[0].url, STATUS_URL, label);
    assert.equal(calls.length, 1, label);
    calls[0].d.resolve(fakeRes(200, GO_BODY));
    await flush();
    const v = client.view();
    assert.equal(v.status, "ok", label);
    assert.equal(v.windows.fiveHour.percent, 37, label);
    assert.equal(v.windows.fiveHour.used, undefined, label + "：兜底链没有金额");
    client.dispose();
  }
});

test("opencode: console month meter without resetsAt falls back to access.endsAt", async () => {
  const body = JSON.parse(GO_STATUS_BODY);
  delete body.access.meters.month.resetsAt;
  const { client, calls } = adapterClient({
    cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]],
    statusRespond: (url, d) => d.resolve(fakeRes(200, JSON.stringify(body))),
  });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(200, GO_BODY));
  await flush();
  assert.equal(client.view().windows.monthly.resetsAt, "2026-12-08T16:50:08.000Z");
  client.dispose();
});

test("opencode: rich console data survives public usage endpoint 401/403", async () => {
  for (const [label, res] of [["401", fakeRes(401, "{}")], ["403", fakeRes(403, "{}")]]) {
    const { client, calls } = adapterClient({
      cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]],
      statusRespond: (url, d) => d.resolve(fakeRes(200, GO_STATUS_BODY)),
    });
    client.noteProvider("oc");
    client.tick();
    calls[0].d.resolve(res);
    await flush();
    const v = client.view();
    assert.equal(v.status, "ok", "控制台 meters 成功时不因兜底端点 " + label + " 拖累主链");
    assert.equal(v.windows.fiveHour.percent, 0.67);
    client.dispose();
  }
});

test("opencode: pending console defers to resolved fallback after the 3s grace abort", async () => {
  const { client, calls, statusCalls } = adapterClient({
    cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]],
    statusRespond: () => { /* 保持 pending：验证 3 秒宽限超时 */ },
  });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(200, GO_BODY));
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal(statusCalls[0].signal.aborted, true, "3 秒宽限后单独中止控制台请求");
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.fiveHour.percent, 37, "已就绪的兜底不被挂起的控制台拖死");
  client.dispose();
});

test("opencode: disposing the client aborts both in-flight endpoint requests", async () => {
  const { client, calls, statusCalls } = adapterClient({
    cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]],
    statusRespond: () => { /* 保持 pending：验证父信号联动 */ },
  });
  client.noteProvider("oc");
  client.tick();
  assert.equal(statusCalls.length, 1);
  assert.equal(calls.length, 1);
  client.dispose();
  await flush();
  assert.equal(statusCalls[0].signal.aborted, true, "父控制器 abort 联动控制台子信号");
  assert.equal(calls[0].signal.aborted, true, "父控制器 abort 联动兜底子信号");
});

test("opencode: console meters with invalid limits are skipped individually", async () => {
  const body = JSON.parse(GO_STATUS_BODY);
  body.access.meters.week.limitMicroCents = "0";
  body.access.meters.month.usedMicroCents = "-1";
  const { client, calls } = adapterClient({
    cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]],
    statusRespond: (url, d) => d.resolve(fakeRes(200, JSON.stringify(body))),
  });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(200, GO_BODY));
  await flush();
  const w = client.view().windows;
  assert.equal(w.fiveHour.percent, 0.67);
  assert.equal(w.weekly, undefined, "limit=0 的窗跳过");
  assert.equal(w.monthly, undefined, "used<0 的窗跳过");
  client.dispose();
});

test("opencode: percent=0 drops placeholder resetsAt but keeps the window", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]] });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-08-26T15:00:00.000Z" },
    weekly: { status: "ok", percent: 0, resetsAt: "2026-08-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 42, resetsAt: "2026-09-11T00:00:00.000Z" },
  } })));
  await flush();
  const w = client.view().windows;
  assert.equal(w.fiveHour.percent, 0);
  assert.equal(w.fiveHour.resetsAt, null, "percent=0 的 resetsAt 是 now+窗长占位，丢弃");
  assert.equal(w.weekly.resetsAt, null);
  assert.equal(w.monthly.percent, 42);
  assert.equal(w.monthly.resetsAt, "2026-09-11T00:00:00.000Z");
  client.dispose();
});

test("opencode: rate-limited window takes percent 100 directly; source stays ok", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]] });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ usage: {
    rolling: { status: "ok", percent: 10, resetsAt: "2026-08-26T15:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-11T00:00:00.000Z" },
  } })));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok", "窗口级 rate-limited 不是 HTTP 429，不触发调度器限流态");
  assert.equal(v.windows.monthly.percent, 100);
  assert.equal(v.windows.fiveHour.percent, 10);
  client.dispose();
});

test("opencode: malformed windows are skipped without failing the rest", async () => {
  const { client, calls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]] });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(200, JSON.stringify({ usage: {
    rolling: { status: "ok" }, weekly: { status: "ok", percent: "12" }, monthly: null,
  } })));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok", "坏窗跳过不整体失败");
  assert.equal(v.windows.weekly.percent, 12, "数字字符串兼容");
  assert.equal(v.windows.fiveHour, undefined);
  assert.equal(v.windows.monthly, undefined);
  client.dispose();
});

test("opencode: all windows missing → parse_error with 30-minute backoff", async () => {
  for (const body of ['{"usage":{}}', JSON.stringify({ useBalance: false, rollingUsage: { status: "ok", usagePercent: 37, resetInSec: 3600 } })]) {
    const { client, clock, calls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]] });
    client.noteProvider("oc");
    client.tick();
    calls[0].d.resolve(fakeRes(200, body));
    await flush();
    const v = client.view();
    assert.equal(v.status, "parse_error", "形态不认识显式报错（含 2026-08 旧扁平形态）");
    assert.equal(v.windows, undefined);
    clock.t += 30 * 60 * 1000 - 1;
    client.tick();
    assert.equal(calls.length, 1, "30 分钟长退避内不重试");
    clock.t += 2;
    client.tick();
    assert.equal(calls.length, 2, "退避到点重试");
    client.dispose();
  }
});

test("opencode: HTTP 403 → no_plan (valid key, no Go subscription), frozen", async () => {
  const { client, clock, calls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]] });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(403, "{}"));
  await flush();
  assert.equal(client.view().status, "no_plan", "403 是无订阅而非认证失败（classifyStatus 归 auth_failed，适配器分流）");
  clock.t += 60 * 60 * 1000;
  client.tick();
  assert.equal(calls.length, 1, "冻结到凭据指纹变化");
  client.dispose();
});

test("opencode: HTTP 401 → auth_failed, frozen, no value fields", async () => {
  const { client, clock, calls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]] });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(401, "{}"));
  await flush();
  const v = client.view();
  assert.equal(v.status, "auth_failed", "key 无效与 403 无订阅分开提示");
  assert.equal(v.windows, undefined);
  clock.t += 60 * 60 * 1000;
  client.tick();
  assert.equal(calls.length, 1);
  client.dispose();
});

test("opencode: value carries label 'OpenCode Go' and kind plan; primary mirror and plan TTL", async () => {
  const { client, clock, calls, statusCalls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go/v1", "sk-go"]] });
  client.noteProvider("oc");
  client.tick();
  calls[0].d.resolve(fakeRes(200, GO_BODY));
  await flush();
  const v = client.view();
  assert.equal(v.label, "OpenCode Go");
  assert.equal(v.kind, "plan");
  assert.equal(v.active, "opencode:oc");
  assert.equal(v.fetchedAt, T0);
  assert.equal(statusCalls.length, 1);
  clock.t += 10 * 60 * 1000 - 1;
  client.tick();
  assert.equal(calls.length, 1, "plan 类 TTL 10 分钟");
  assert.equal(statusCalls.length, 1, "控制台端点同样受 TTL 约束");
  clock.t += 2;
  client.tick();
  assert.equal(calls.length, 2);
  assert.equal(statusCalls.length, 2);
  client.dispose();
});

test("opencode: usage shape is never misdetected as sub2api; custom probing it ends unsupported", () => {
  assert.equal(Q.normalizeSub2api(JSON.parse(GO_BODY)), null, "无 isValid/mode，custom 分支不会当 sub2api 解析");
  assert.equal(Q.normalizeSub2api({ usage: {} }), null);
});

test("opencode: custom relay probing an opencode-shaped 200 ends unsupported, not parse_error", async () => {
  const { client, calls } = adapterClient({
    cfgEntries: [["zen", "https://opencode.ai/zen/v1", "sk-zen"]],
    respond: (url, d) => { d.resolve(fakeRes(url.endsWith("/v1/usage") ? 200 : 404, url.endsWith("/v1/usage") ? GO_BODY : "{}")); },
  });
  client.noteProvider("zen");
  client.tick();
  await flush();
  const v = client.view();
  assert.equal(v.byProvider["zen"], "custom:zen", "/zen/v1 不命中 opencode，走 generic 探测");
  assert.equal(v.sources["custom:zen"].status, "unsupported");
  assert.equal(v.sources["custom:zen"].reason, "gateway");
  client.dispose();
});

test("opencode: credential priority env → secrets → provider cfg", async () => {
  const cases = [
    [{ env: { OPENCODE_API_KEY: "sk-env" } }, "Bearer sk-env"],
    [{ env: { OPENCODE_API_KEY: "sk-env" }, secrets: { sources: { opencode: { apiKey: "sk-sec" } } } }, "Bearer sk-env"],
    [{ secrets: { sources: { opencode: { apiKey: "sk-sec" } } } }, "Bearer sk-sec"],
    [{}, "Bearer sk-cfg"],
  ];
  for (const [opts, expected] of cases) {
    const { client, calls } = adapterClient(Object.assign({ cfgEntries: [["oc", "https://opencode.ai/zen/go", "sk-cfg"]] }, opts));
    client.noteProvider("oc");
    client.tick();
    assert.equal(calls[0].auth, expected);
    client.dispose();
  }
});

test("opencode: same-source secrets key rotation unfreezes auth_failed", async () => {
  const secrets = { sources: { opencode: { apiKey: "sk-sec" } } };
  const { client, calls } = adapterClient({ cfgEntries: [["oc", "https://opencode.ai/zen/go", "sk-cfg"]], secrets });
  client.noteProvider("oc");
  client.tick();
  assert.equal(calls[0].auth, "Bearer sk-sec");
  calls[0].d.resolve(fakeRes(401, "{}"));
  await flush();
  assert.equal(client.view().status, "auth_failed");
  secrets.sources.opencode.apiKey = "sk-sec2";
  client.credentialsChanged();
  client.tick();
  assert.equal(calls.length, 2, "⚙ 换 key 后指纹变化解冻重查");
  assert.equal(calls[1].auth, "Bearer sk-sec2");
  calls[1].d.resolve(fakeRes(200, GO_BODY));
  await flush();
  assert.equal(client.view().status, "ok");
  client.dispose();
});

test("opencode: template-created provider without personal baseUrl hits adapter via builtin templateRules (#123)", async () => {
  const { client, calls } = adapterClient({
    personalCfg: { config: { providerConfigRules: { providerRules: [
      { providerId: "opencode-go-responses", templateId: "opencode-go-responses",
        config: { api: { type: "openai-responses" }, access: { type: "api-key", apiKey: "sk-tpl" } } },
    ] } } },
    builtinCfg: { config: { providerConfigRules: { templateRules: [
      { templateId: "opencode-go-responses", config: { api: { type: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" } } },
    ] } } },
  });
  client.noteProvider("opencode-go-responses");
  client.tick();
  assert.equal(calls[0].url, USAGE_URL, "模板回填的 baseUrl 命中 opencode 适配器");
  assert.equal(calls[0].auth, "Bearer sk-tpl");
  assert.equal(client.view().byProvider["opencode-go-responses"], "opencode:opencode-go-responses");
  calls[0].d.resolve(fakeRes(200, GO_BODY));
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.fiveHour.percent, 37);
  client.dispose();
});
