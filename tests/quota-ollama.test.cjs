const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* Ollama Cloud 适配器（issue #410；custom provider baseUrl host 为 ollama.com）：
 * GET https://ollama.com/api/balance（Bearer <key>）——新套餐 included.{balance_usd,
 * allowance_usd,period} 月度额度池；旧套餐 included.{session,weekly}.remaining_percent；
 * purchased.balance_usd 附加充值余额。端点与两代响应形状转写自 magpie（MIT）与官方
 * docs（docs.ollama.com/cloud/usage、/api/balance）；未真账号实测（unverified）。 */
const ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };
const T0 = 1700000000000;
const BALANCE_URL = "https://ollama.com/api/balance";

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
    { providerId: id, providerName: id, config: { api: { type: "openai-chat-completions", baseUrl }, access: { type: "api-key", apiKey } } }
  )) } } };
}
function ollamaClient({ cfgEntries, secrets, env } = {}) {
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

test("ollama: custom ollama.com provider maps allowance pool to monthly window", async () => {
  const { client, calls } = ollamaClient({ cfgEntries: [["new-provider", "https://ollama.com/v1", "ok-key"]] });
  client.noteProvider("new-provider");
  client.tick();
  assert.deepEqual(calls.map((c) => c.url), [BALANCE_URL]);
  assert.equal(calls[0].headers.authorization, "Bearer ok-key");
  reply(calls, BALANCE_URL, 200, {
    included: { balance_usd: 72.5, allowance_usd: 100,
      period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" } },
    purchased: { balance_usd: 25 },
  });
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.kind, "plan");
  assert.equal(v.label, "Ollama Cloud");
  const m = v.windows.monthly;
  assert.ok(m, "新套餐产出 monthly 窗");
  assert.equal(m.percent, 27.5);
  assert.equal(m.used, 27.5);
  assert.equal(m.total, 100);
  assert.equal(m.remaining, 72.5);
  assert.equal(m.currency, "USD");
  assert.equal(m.resetsAt, "2026-10-15T09:30:00Z");
  assert.equal(v.balance, null, "有窗口时 purchased 余额不进顶层 balance（渲染端余额形态优先会挤掉窗口段）");
});

test("ollama: legacy remaining_percent windows flip to used with resetsAt", async () => {
  const { client, calls } = ollamaClient({ cfgEntries: [["new-provider", "https://ollama.com", "ok-key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, BALANCE_URL, 200, {
    included: {
      session: { remaining_percent: 75, resets_at: "2026-10-01T07:00:00Z" },
      weekly: { remaining_percent: 40, resets_at: "2026-10-05T00:00:00Z" },
    },
    purchased: { balance_usd: 25 },
  });
  await flush();
  const v = client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.kind, "plan");
  assert.equal(v.windows.fiveHour.percent, 25, "remaining_percent 75 → 已用 25%");
  assert.equal(v.windows.fiveHour.resetsAt, "2026-10-01T07:00:00Z");
  assert.equal(v.windows.weekly.percent, 60, "remaining_percent 40 → 已用 60%");
  assert.equal(v.windows.weekly.resetsAt, "2026-10-05T00:00:00Z");
  assert.equal(v.windows.monthly, undefined);
});

test("ollama: windowless reply (no period) yields plan window without resetsAt", () => {
  const v = Q.normalizeOllama({ included: { balance_usd: 19, allowance_usd: 20 } });
  assert.equal(v.kind, "plan");
  const p = v.windows.plan;
  assert.ok(p, "period 缺失/不可解析 → plan 窗（不带周期语义），不冒充月窗");
  assert.equal(p.percent, 5);
  assert.equal(p.used, 1);
  assert.equal(p.total, 20);
  assert.equal(p.resetsAt, undefined);

  const garbage = Q.normalizeOllama({ included: { balance_usd: 19, allowance_usd: 20, period: { until: "TBD" } } });
  assert.ok(garbage.windows.plan, "until 非空但非日期不冒充月窗（resetOf 透传是全仓基线，ollama 侧 Date.parse 门内敛加固）");
  assert.equal(garbage.windows.monthly, undefined);
});

test("ollama: numeric period.until (epoch ms, or ms digit string) lands on the monthly window with resetsAt", () => {
  // 复盘 MINOR：Date.parse 只认日期串，数字毫秒被误落 plan 窗（「套餐」标签、无重置时间）
  const ms = 1769875200000;
  for (const until of [ms, String(ms), ms / 1000]) {   // 第三形态：秒值（resetOf 乘 1000）
    const v = Q.normalizeOllama({ included: { balance_usd: 19, allowance_usd: 20, period: { until } } });
    assert.ok(v.windows.monthly, "until=" + JSON.stringify(until) + " 进月窗");
    assert.equal(v.windows.monthly.resetsAt, ms);
    assert.equal(v.windows.plan, undefined);
  }
  // 玩具数值与垃圾串仍不冒充月窗；超长数字串转 Number 是 Infinity，同样落 plan 窗
  for (const until of ["12345", 12345, "TBD", "", null, true, "9".repeat(400)]) {
    const v = Q.normalizeOllama({ included: { balance_usd: 19, allowance_usd: 20, period: { until } } });
    assert.ok(v.windows.plan && !v.windows.monthly, "until=" + JSON.stringify(until).slice(0, 24) + " 落 plan 窗");
  }
});

test("ollama: purchased-only account degrades to balance card; zero allowance no divide-by-zero", () => {
  const payg = Q.normalizeOllama({ purchased: { balance_usd: 25 } });
  assert.equal(payg.kind, "balance");
  assert.deepEqual(payg.balance, { amount: 25, currency: "USD" });
  assert.equal(payg.windows, undefined);

  const zero = Q.normalizeOllama({ included: { balance_usd: 0, allowance_usd: 0 }, purchased: { balance_usd: 25 } });
  assert.equal(zero.kind, "balance", "allowance=0 无窗口，退化为余额，不除零不造 0% 窗");
  assert.deepEqual(zero.balance, { amount: 25, currency: "USD" });

  const empty = Q.normalizeOllama({ included: {} });
  assert.equal(empty.kind, "plan", "included 在但无可解析窗口且无 purchased：ok 空窗（纯 PAYG 账号不判无订阅）");
  assert.equal(empty.windows, undefined);
});

test("ollama: clamps — overdraw pins 100%, remaining>100 pins 0%, negative purchased ignored", () => {
  const over = Q.normalizeOllama({ included: { balance_usd: -5, allowance_usd: 100, period: { until: "2026-10-15T09:30:00Z" } } });
  assert.equal(over.windows.monthly.percent, 100, "balance<0（超支）钳满格");
  assert.equal(over.windows.monthly.used, 100);
  assert.equal(over.windows.monthly.remaining, 0);

  const over100 = Q.normalizeOllama({ included: { session: { remaining_percent: 150 } } });
  assert.equal(over100.windows.fiveHour.percent, 0, "remaining_percent>100 钳到 0% 已用");

  const negPct = Q.normalizeOllama({ included: { weekly: { remaining_percent: -20 } } });
  assert.equal(negPct.windows.weekly.percent, 100, "remaining_percent<0 钳到 100% 已用");

  const negBought = Q.normalizeOllama({ purchased: { balance_usd: -3 } });
  assert.equal(negBought.kind, "plan", "负 purchased 视为无充值，不出余额卡");
  assert.equal(negBought.windows, undefined);
  assert.equal(negBought.balance, undefined);
});

test("ollama: string numbers tolerated; drift and empty shapes fail closed", () => {
  const str = Q.normalizeOllama({ included: { balance_usd: "72.5", allowance_usd: "100" },
    purchased: { balance_usd: "25" } });
  assert.equal(str.windows.plan.percent, 27.5, "服务端字符串数字宽容解析（无 period 落 plan 窗）");

  const nan = Q.normalizeOllama({ included: { balance_usd: NaN, allowance_usd: Infinity },
    purchased: { balance_usd: 25 } });
  assert.equal(nan.windows, undefined, "NaN/Infinity 不是数字：无月窗");
  assert.equal(nan.kind, "balance", "退化为 purchased 余额卡");

  const dirty = Q.normalizeOllama({ included: { session: { remaining_percent: "abc" } } });
  assert.equal(dirty.windows, undefined, "脏字符串不猜 0%：对应窗缺席");

  assert.throws(() => Q.normalizeOllama(null), /ollama shape/);
  assert.throws(() => Q.normalizeOllama([]), /ollama shape/);
  assert.throws(() => Q.normalizeOllama("str"), /ollama shape/);
  assert.throws(() => Q.normalizeOllama({ error: "invalid credentials" }), /ollama empty/, "included 与 purchased 全缺按形状变化 fail-closed");
  assert.throws(() => Q.normalizeOllama({ included: "x" }), /ollama empty/);
  for (const bad of [null, [], "str", { error: "invalid credentials" }, { included: "x" }]) {
    let code = "";
    try { Q.normalizeOllama(bad); } catch (e) { code = e.code; }
    assert.equal(code, "parse_error", "错误分类恒 parse_error（30 分钟确定性退避）");
  }
});

test("ollama: bad key 401 freezes as auth_failed", async () => {
  const { client, calls } = ollamaClient({ cfgEntries: [["new-provider", "https://ollama.com/v1", "bad-key"]] });
  client.noteProvider("new-provider");
  client.tick();
  reply(calls, BALANCE_URL, 401, { error: "invalid credentials" });
  await flush();
  const v = client.view();
  assert.equal(v.status, "auth_failed");
});

test("ollama: env key activates key-only source; credential priority env > secrets > cfg", async () => {
  const envOnly = ollamaClient({ env: { OLLAMA_API_KEY: "env-key" } });
  envOnly.client.tick();
  assert.ok(envOnly.calls.some((c) => c.url === BALANCE_URL), "OLLAMA_API_KEY 无 provider_config 也激活（defaultOn）");
  assert.equal(envOnly.calls.find((c) => c.url === BALANCE_URL).headers.authorization, "Bearer env-key");
  reply(envOnly.calls, BALANCE_URL, 200, { purchased: { balance_usd: 25 } });
  await flush();
  assert.equal(envOnly.client.view().sources.ollama.status, "ok", "env-only 激活的 ollama 源查询成功");

  /* 三级优先：env 压过 secrets 与 provider_config。 */
  const prio = ollamaClient({
    cfgEntries: [["new-provider", "https://ollama.com/v1", "cfg-key"]],
    secrets: { sources: { ollama: { apiKey: "sec-key" } } },
    env: { OLLAMA_API_KEY: "env-key" },
  });
  prio.client.noteProvider("new-provider");
  prio.client.tick();
  assert.equal(prio.calls.find((c) => c.url === BALANCE_URL).headers.authorization, "Bearer env-key");
  reply(prio.calls, BALANCE_URL, 200, { purchased: { balance_usd: 25 } });
  await flush();

  const secOnly = ollamaClient({
    cfgEntries: [["new-provider", "https://ollama.com/v1", "cfg-key"]],
    secrets: { sources: { ollama: { apiKey: "sec-key" } } },
  });
  secOnly.client.noteProvider("new-provider");
  secOnly.client.tick();
  assert.equal(secOnly.calls.find((c) => c.url === BALANCE_URL).headers.authorization, "Bearer sec-key");
  reply(secOnly.calls, BALANCE_URL, 200, { purchased: { balance_usd: 25 } });
  await flush();
});

test("ollama: detect rejects non-https, lookalike hosts and local server; presets registered", () => {
  const j = {
    env: {},
    secrets: { sources: {} },
    customProviderOf: (id) => ({ baseUrl: "https://ollama.com/v1", apiKey: "k" }),
  };
  const a = Q.createQuotaClient({
    env: ENV, now: () => T0, credsPath: "/v/c.json", secretsPath: "/v/s.json",
    readFile: () => { throw new Error("ENOENT"); },
    fetchImpl: () => new Promise(() => { }),
  });
  const ad = a._adapters.find((x) => x.id === "ollama");
  assert.ok(ad, "ollama 适配器已注册");
  assert.equal(ad.defaultOn, true);
  assert.deepEqual(ad.envKeys, ["OLLAMA_API_KEY"]);
  assert.ok(ad.detect(j, "new-provider"), "https://ollama.com/v1 命中");

  const hit = (url) => {
    const jj = Object.assign({}, j, { customProviderOf: () => ({ baseUrl: url, apiKey: "k" }) });
    return !!ad.detect(jj, "new-provider");
  };
  assert.ok(hit("https://ollama.com"), "裸域命中");
  assert.equal(hit("http://ollama.com/v1"), false, "非 https 不命中");
  assert.equal(hit("https://ollama.com.evil.example/v1"), false, "伪装域不命中");
  assert.equal(hit("http://localhost:11434"), false, "本地 Ollama 不命中");
  assert.equal(hit(""), false, "空 baseUrl 不命中");
  assert.equal(ad.detect(j, "account:bigmodel"), null, "内置账号不认领");

  const cfg = a.sourcesConfig();
  const row = (cfg || []).find((s) => s.id === "ollama");
  assert.ok(row, "sourcesConfig 含 ollama 行");
  assert.equal(row.keyUrl, "https://ollama.com/settings/keys");
  a.dispose();
});
