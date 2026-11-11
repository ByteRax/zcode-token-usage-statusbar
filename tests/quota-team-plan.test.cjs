const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* ---------- 团队套餐（GLM Coding Plan team，配方转写自 magpie zcode_team.go） ----------
 * provider 规范形 account:{fam}-team-coding-plan；选择读 setting.json（HOME/.zcode/v2）；
 * 配额 ?type=2 + 团队头；重置 targetType=TEAM。business token 走 v2 分发器解密。 */
const T0 = 1700000000000;
const TEAM_MONITOR = {
  bigmodel: "https://bigmodel.cn/api/monitor/usage/quota/limit?type=2",
  zai: "https://api.z.ai/api/monitor/usage/quota/limit?type=2",
};
const OK_BODY = JSON.stringify({ success: true, data: { level: "max", limits: [
  { type: "CREDIT_LIMIT", unit: 3, percentage: 18, nextResetTime: 1793176110955 },          // 团队 5 小时：无 number
  { type: "CREDIT_LIMIT", unit: 6, percentage: 40, nextResetTime: 1793276110955 },
  { type: "TIME_LIMIT", unit: 5, percentage: 1.3, nextResetTime: 1795776110955 },           // MCP 月度工具窗
] } });
const SETTING = {
  providerFamilyConnectionSelections: {
    bigmodel: { kind: "team-coding-plan", organizationId: "org-1", projectId: "proj-1" },
  },
};

function fakeRes(status, body) {
  return { status, headers: { get: () => null }, text: async () => body };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeTeamClient(t, { setting = SETTING, fam = "bigmodel", creds, calls } = {}) {
  const credsPath = "/virtual/team/credentials.json";
  const clock = { t: T0 };
  const client = Q.createQuotaClient({
    env: {},
    now: () => clock.t,
    settingPath: "/virtual/team/setting.json",
    credsPath,
    readFile: (p) => {
      if (p === credsPath) return creds;
      if (p === "/virtual/team/setting.json") return setting === null ? (() => { throw new Error("ENOENT"); })() : setting;
      throw new Error("ENOENT: " + p);
    },
    fetchImpl: (url, init) => {
      calls.push({ url, headers: init.headers });
      if (url === TEAM_MONITOR[fam]) return Promise.resolve(fakeRes(200, OK_BODY));
      if (url.indexOf("/reset/status") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ code: 0, success: true, data: { available_five_hour_resets: [], available_week_resets: [] } })));
      if (url.indexOf("customer-package-reset/list") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ code: 0, success: true, data: {
        fiveHourResets: [{ available: true, expireTime: 1793176110955 }, { available: false, expireTime: 1793006110955 }],
        weekResets: [{ available: true, expireTime: 1795776110955 }],
      } })));
      return Promise.resolve(fakeRes(200, "{}"));
    },
  });
  t.after(() => { client.dispose(); Q.setDefaultDecryptCtx({ env: process.env }); });
  return { client, calls, clock };
}

const TEAM_CREDS = (Q, key) => {
  const crypto = require("crypto");
  const k = crypto.createHash("sha256").update("team-managed-secret-0123456789abcdef").digest();   // 与返回的 env 派生一致
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(key, "utf8"), c.final()]);
  const keyId = crypto.createHash("sha256").update(k).digest("hex").slice(0, 24);
  const seal = [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
  const entry = "enc:v2:env:" + keyId + ":" + seal;
  return {
    entry,
    env: "team-managed-secret-0123456789abcdef",
    key: k,
    file: { "oauth:bigmodel:access_token": entry, "oauth:zai:access_token": entry, zcodejwttoken: entry },
  };
};

test("team: 未切团队（无选择）fail-closed——not_configured、零请求", async (t) => {
  const calls = [];
  const { client } = makeTeamClient(t, { setting: null, fam: "bigmodel", creds: { "oauth:bigmodel:access_token": "enc:v1:x.y.z" }, calls });
  client.noteProvider("account:bigmodel-team-coding-plan");
  client.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 0);
  const entry = client.view().sources["bigmodel-team"];
  assert.ok(entry && entry.status === "not_configured");
});

test("team: 有选择即按团队链查询——?type=2、团队头、明文 token；legacy 选择键等价", async (t) => {
  for (const setting of [
    SETTING,
    { modelProviderFamilySelectedKeys: { bigmodel: "team-plan:builtin:bigmodel-coding-plan:org-display:org-1:proj-1" } },
  ]) {
    const tc = TEAM_CREDS(Q, "plan.team.key");
    const calls = [];
    const { client, clock } = makeTeamClient(t, {
      setting, fam: "bigmodel",
      creds: { "oauth:bigmodel:access_token": tc.entry },
      calls,
    });
    Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
    client.noteProvider("account:bigmodel-team-coding-plan");
    client.tick();                       // 预热启动（异步），本轮团队解密失败
    await Q.ensureDefaultV2Key();
    clock.t += 1100;                     // pending 的 1 秒短重试
    client.tick();
    await new Promise((r) => setTimeout(r, 10));
    const monitor = calls.filter((c) => c.url === TEAM_MONITOR.bigmodel);
    assert.equal(monitor.length, 1);
    assert.equal(monitor[0].headers.authorization, "plan.team.key");          // BigModel 业务 token 裸头
    assert.equal(monitor[0].headers["Bigmodel-Organization"], "org-1");
    assert.equal(monitor[0].headers["Bigmodel-Project"], "proj-1");
    const entry = client.view().sources["bigmodel-team"];
    assert.equal(entry.status, "ok");
    assert.equal(entry.level, "max");
    assert.equal(entry.windows.fiveHour.percent, 18);   // 团队 5 小时无 number：窗口照常
    assert.ok(entry.tools, "TIME_LIMIT 折入工具窗（MCP 月度）");
    await client.dispose();
  }
});

test("team: zai 家族走 api.z.ai + Bearer", async (t) => {
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const calls = [];
  const setting = { providerFamilyConnectionSelections: { zai: { kind: "team-coding-plan", organizationId: "org-z", projectId: "proj-z" } } };
  const { client, clock } = makeTeamClient(t, {
    setting, fam: "zai",
    creds: { "oauth:zai:access_token": tc.entry },
    calls,
  });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  client.noteProvider("account:zai-team-coding-plan");
  client.setProviders(["account:zai-team-coding-plan"]);
  client.tick();
  await Q.ensureDefaultV2Key();
  clock.t += 1100;
  client.tick();
  await new Promise((r) => setTimeout(r, 10));
  const monitor = calls.filter((c) => c.url === TEAM_MONITOR.zai);
  assert.equal(monitor.length, 1);
  assert.equal(monitor[0].headers.authorization, "Bearer plan.team.key");   // Z.ai 业务 token 走 Bearer
  assert.equal(monitor[0].headers["Bigmodel-Organization"], "org-z");
  assert.equal(client.view().sources["zai-team"].status, "ok");
});

test("team: 个人模式选择不得跨家族——bigmodel 选择不点亮 zai-team", async (t) => {
  const calls = [];
  const { client } = makeTeamClient(t, {
    fam: "zai", creds: { "oauth:zai:access_token": "enc:v1:x.y.z" }, calls,   // setting 只有 bigmodel 选择
  });
  client.noteProvider("account:zai-team-coding-plan");
  client.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 0);
  assert.equal(client.view().sources["zai-team"].status, "not_configured");
});

test("team: 重置卡走 targetType=TEAM 列表（团队头），值形与徽标消费对齐", async (t) => {
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const setting = { providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", organizationId: "org-1", projectId: "proj-1" } } };
  const calls = [];
  const clock = { t: T0 };
  const client = Q.createQuotaClient({
    env: {}, now: () => clock.t, settingPath: "/virtual/team/setting.json", credsPath: "/virtual/team/credentials.json",
    readFile: (p) => {
      if (p === "/virtual/team/credentials.json") return {
        "oauth:bigmodel:access_token": tc.entry,
        zcodejwttoken: tc.entry,   // 与业务 token 相同：个人链视为陈旧，不影响团队模式
      };
      if (p === "/virtual/team/setting.json") return setting;
      throw new Error("ENOENT");
    },
    quotaEnabled: () => false, resetEnabled: () => true,
    fetchImpl: (url, init) => {
      calls.push({ url, headers: init.headers });
      if (url.indexOf("customer-package-reset/list") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ code: 0, success: true, data: {
        fiveHourResets: [{ available: true, expireTime: "2026-11-13 09:00:00" }, { available: false, expireTime: "2026-11-13 06:00:00" }],
        weekResets: [{ available: true, expireTime: "2026-11-18 09:00:00" }],
      } })));
      return Promise.resolve(fakeRes(200, "{}"));
    },
  });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  t.after(() => { client.dispose(); Q.setDefaultDecryptCtx({ env: process.env }); });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();                       // 预热启动（异步），本轮团队解密失败
  await Q.ensureDefaultV2Key();        // env 源密钥落定
  clock.t += 1100;                     // pending 的 1 秒短重试
  client.tick();                       // pending 短重试后解出：TEAM 列表发出
  await new Promise((r) => setTimeout(r, 10));
  const list = calls.filter((c) => c.url.indexOf("customer-package-reset/list?targetType=TEAM") >= 0);
  assert.equal(list.length, 1, "团队模式只打 TEAM 列表");
  assert.ok(!calls.some((c) => c.url.indexOf("/reset/status") >= 0), "个人 reset/status 不发");
  assert.equal(list[0].headers.authorization, "plan.team.key");   // 业务 token 裸头
  assert.equal(list[0].headers["Bigmodel-Organization"], "org-1");
  assert.equal(list[0].headers["Bigmodel-Project"], "proj-1");
  const famEntry = client.view().resets && client.view().resets.bigmodel;
  assert.ok(famEntry && famEntry.list && Array.isArray(famEntry.list.fiveHour), "团队列表进视图");
  const liveFive = (famEntry.list.fiveHour || []).filter((c) => c.available !== false);
  assert.equal(liveFive.length, 1, "只计 available 且未过期的卡");
  assert.equal(liveFive[0].expireAt, Date.parse("2026-11-13T09:00:00+08:00"));   // 服务端 UTC+8 字符串
  assert.ok(calls.every((c) => JSON.stringify(c).indexOf("enc:v") < 0), "任何请求不外发密文");
});

