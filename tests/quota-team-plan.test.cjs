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
/* issue #481：线上 api_keys 条目密钥 ID 在 apiKey（32 位串），没有 apiKeyId 字段；PAT 响应的
 * expiresAt 是秒级时间戳、expiresIn 单位秒。夹具与线上同形——旧夹具的毫秒 expiresAt 把
 * 「秒级过期时间与毫秒时钟直接比较」挡在了测试外面。 */
const TEAM_KEY_ID = "9f3c6a1e5b7d4c2a8e0f1a2b3c4d5e6f";
const teamKeyEntry = () => ({ apiKey: TEAM_KEY_ID, createTime: "2026-11-20 10:00:00", isHidden: false, keyType: 2, lastUseTime: null,
  name: "zcode-team-api-key", publicKey: "", secretKey: "", tokenType: "", usageScene: 1, useApiKeyUserId: "u-1", useUserName: "团队管理员" });
const teamPatCalls = (calls) => calls.filter((c) => /\/access_tokens$/.test(c.url));
const teamSel = (org, proj) => ({ providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", organizationId: org, projectId: proj } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes(status, body) {
  return { status, headers: { get: () => null }, text: async () => body };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeTeamClient(t, { setting = SETTING, fam = "bigmodel", creds, calls, monitor = null, patTtlSec = 3600, patExpiresAtSec, patExpiresUnit = "s", keyIdRaw, patExpiresRaw, patExpiresInRaw } = {}) {
  const credsPath = "/virtual/team/credentials.json";
  const clock = { t: T0 };
  const client = Q.createQuotaClient({
    env: {},
    now: () => clock.t,
    settingPath: "/virtual/team/setting.json",
    credsPath,
    readFile: (p) => {
      /* 基名匹配：客户端经 path.resolve 归一路径，POSIX 形状虚拟路径在 Windows 解析
       * 成 <盘>:\virtual\...，精确等值比较恒失配（v416 改平台无关基名等值） */
      const base = String(p).split(/[\\/]+/).pop();
      if (base === "credentials.json") return creds;
      if (base === "setting.json") return setting === null ? (() => { throw new Error("ENOENT"); })() : setting;
      throw new Error("ENOENT: " + p);
    },
    fetchImpl: (url, init) => {
      calls.push({ url, headers: init.headers, method: init.method });
      if (url.indexOf("/api/biz/customer/getCustomerInfo") >= 0) {
        const famSel = (setting && setting.providerFamilyConnectionSelections) || {};
        const org = (Object.values(famSel)[0] || {}).organizationId || "org-1";
        const proj = (Object.values(famSel)[0] || {}).projectId || "proj-1";
        return Promise.resolve(fakeRes(200, JSON.stringify({ code: 200, data: { organizations: [
          { organizationId: org, projects: [{ projectId: proj }] },
        ] } })));
      }
      if (url.indexOf("/api_keys") >= 0 && init.method === "GET") return Promise.resolve(fakeRes(200, JSON.stringify({ code: 200, data: [
        /* 诱饵排在团队密钥前面：同为 keyType=2、名字不同的条目不得被当成团队密钥 */
        Object.assign(teamKeyEntry(), { name: "other-key", apiKey: "decoy-key-id" }),
        Object.assign(teamKeyEntry(), keyIdRaw === undefined ? {} : { apiKey: keyIdRaw }),   // keyIdRaw：可带首尾空白与需编码字符的原始值
      ] })));
      if (url.indexOf("/access_tokens") >= 0) {
        const expiresAt = patExpiresUnit === "ms" ? T0 + (patExpiresAtSec || patTtlSec) * 1000 : Math.floor(T0 / 1000) + (patExpiresAtSec || patTtlSec);   // patExpiresAtSec：让 expiresAt 与 expiresIn 不一致
        const payload = JSON.stringify({ code: 200, data: { enabled: true, accessToken: "pat.team.token", tokenType: "Bearer", expiresIn: patTtlSec, expiresAt } });
        /* patExpiresRaw / patExpiresInRaw：把 expiresAt、expiresIn 的 JSON 文本换成任意字面量（1e400 这类解析后非有限、或离谱大的值） */
        let text = payload;
        if (patExpiresRaw !== undefined) {
          text = text.replace('"expiresAt":' + expiresAt, '"expiresAt":' + patExpiresRaw);
          if (text === payload) throw new Error("fixture: expiresAt splice failed");
        }
        if (patExpiresInRaw !== undefined) {
          text = text.replace('"expiresIn":' + patTtlSec, '"expiresIn":' + patExpiresInRaw);
          if (text.indexOf('"expiresIn":' + patExpiresInRaw) < 0) throw new Error("fixture: expiresIn splice failed");
        }
        return Promise.resolve(fakeRes(200, text));
      }
      if (url === TEAM_MONITOR[fam]) {   // monitor 可变应答（{status}，换发解冻用例先 401 后 200）；缺省 200+OK_BODY
        const st = (monitor && monitor.status) || 200;
        return Promise.resolve(fakeRes(st, st === 200 ? OK_BODY : "{}"));
      }
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
/* 复用 TEAM_CREDS 的 v2:env 密钥重封任意明文（新式登录态键用例：linked 信封封 JSON、zai_cn 封 token 本体） */
function teamSeal(tc, plain) {
  const crypto = require("crypto");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", tc.key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const keyId = crypto.createHash("sha256").update(tc.key).digest("hex").slice(0, 24);
  return "enc:v2:env:" + keyId + ":" + [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

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
    assert.equal(monitor[0].headers.authorization, "pat.team.token");         // monitor 鉴权=项目 PAT（裸头）
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
  assert.equal(monitor[0].headers.authorization, "pat.team.token");         // Z.ai PAT 同样裸头
  assert.equal(monitor[0].headers["Bigmodel-Organization"], "org-z");
  assert.equal(client.view().sources["zai-team"].status, "ok");
});

test("team: 旧平铺键缺席回退 oauth:linked_bigmodel（issue #391）——PAT 交换链照常走通", async (t) => {
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const linkedJson = JSON.stringify({ userId: "u1", customerId: "c1", accessToken: "plan.team.key" });
  const calls = [];
  /* org/project 避开前序用例：teamPatCache 模块级按 fam|org|project 缓存，同键会跳过 PAT 交换链 */
  const setting = { providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", organizationId: "org-alt", projectId: "proj-alt" } } };
  const { client, clock } = makeTeamClient(t, {
    setting, fam: "bigmodel",
    creds: { "oauth:linked_bigmodel": teamSeal(tc, linkedJson) },
    calls,
  });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  client.noteProvider("account:bigmodel-team-coding-plan");
  client.tick();
  await Q.ensureDefaultV2Key();
  clock.t += 1100;
  client.tick();
  await new Promise((r) => setTimeout(r, 10));
  const info = calls.find((c) => c.url.indexOf("/api/biz/customer/getCustomerInfo") >= 0);
  assert.ok(info, "PAT 交换链第一步发出");
  assert.equal(info.headers.authorization, "plan.team.key");   // 裸业务 token 来自回退键
  const monitor = calls.filter((c) => c.url === TEAM_MONITOR.bigmodel);
  assert.equal(monitor.length, 1);
  assert.equal(monitor[0].headers.authorization, "pat.team.token");
  assert.equal(monitor[0].headers["Bigmodel-Organization"], "org-alt");
  assert.equal(client.view().sources["bigmodel-team"].status, "ok");
});

test("team: zai 家族旧键缺席回退 oauth:zai_cn:access_token（issue #391）", async (t) => {
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const setting = { providerFamilyConnectionSelections: { zai: { kind: "team-coding-plan", organizationId: "org-zalt", projectId: "proj-zalt" } } };
  const calls = [];
  const { client, clock } = makeTeamClient(t, {
    setting, fam: "zai",
    creds: { "oauth:zai_cn:access_token": teamSeal(tc, "zai.cn.team.tok") },   // 信封即 token 本体
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
  const info = calls.find((c) => c.url.indexOf("/api/biz/customer/getCustomerInfo") >= 0);
  assert.ok(info, "PAT 交换链第一步发出");
  assert.equal(info.headers.authorization, "zai.cn.team.tok");
  const monitor = calls.filter((c) => c.url === TEAM_MONITOR.zai);
  assert.equal(monitor.length, 1);
  assert.equal(monitor[0].headers.authorization, "pat.team.token");
  assert.equal(client.view().sources["zai-team"].status, "ok");
});

test("team: 回退信封解不出可用 token 按 decryptFailed 降级（issue #391）", async (t) => {
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const setting = { providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", organizationId: "org-df", projectId: "proj-df" } } };
  const calls = [];
  const { client, clock } = makeTeamClient(t, {
    setting, fam: "bigmodel",
    creds: { "oauth:linked_bigmodel": teamSeal(tc, "not-json{") },
    calls,
  });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  client.noteProvider("account:bigmodel-team-coding-plan");
  client.tick();
  await Q.ensureDefaultV2Key();
  clock.t += 1100;
  client.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 0);   // fail-closed 零请求
  const entry = client.view().sources["bigmodel-team"];
  assert.equal(entry.status, "not_configured");
  assert.equal(entry.error, "credential decrypt failed");
});

test("team: 指纹跟随回退信封——401 冻结后宿主换发解冻重查（issue #391）", async (t) => {
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const linkedJson = (tok) => JSON.stringify({ userId: "u1", customerId: "c1", accessToken: tok });
  const mon = { status: 401 };
  const setting = { providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", organizationId: "org-fr", projectId: "proj-fr" } } };
  const calls = [];
  const creds = { "oauth:linked_bigmodel": teamSeal(tc, linkedJson("team.tok.v1")) };
  const { client, clock } = makeTeamClient(t, { setting, fam: "bigmodel", creds, calls, monitor: mon });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  client.noteProvider("account:bigmodel-team-coding-plan");
  client.tick();
  await Q.ensureDefaultV2Key();
  clock.t += 1100;
  client.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(client.view().sources["bigmodel-team"].status, "auth_failed");
  mon.status = 200;   // PAT 缓存（T0+3600s）运行期内恒有效：第二轮只重打 monitor，不断言 PAT 链重放
  creds["oauth:linked_bigmodel"] = teamSeal(tc, linkedJson("team.tok.v2"));   // 宿主换发回退信封（新密文=新指纹）
  client.credentialsChanged();
  client.tick();
  await new Promise((r) => setTimeout(r, 10));
  const mons = calls.filter((c) => c.url === TEAM_MONITOR.bigmodel);
  assert.equal(mons.length, 2);
  assert.equal(client.view().sources["bigmodel-team"].status, "ok");
});

/* 预热→解密→首轮查询的标准三拍：返回后 monitor 已查过一轮 */
async function teamFirstRound(client, clock) {
  client.noteProvider("account:bigmodel-team-coding-plan");
  client.tick();                       // 预热启动（异步），本轮团队解密失败
  await Q.ensureDefaultV2Key();
  clock.t += 1100;                     // pending 的 1 秒短重试
  client.tick();
  await sleep(10);
}

test("team: access_tokens 换发 URL 带的是条目 apiKey，不是 undefined（issue #481）", async (t) => {
  /* 旧代码查找用 k.apiKey、拼 URL 却用 teamKey.apiKeyId——线上拼成 …/api_keys/undefined/access_tokens。
   * 上面的桩按「URL 含 /access_tokens」匹配，undefined 路径同样命中，此前没暴露；这里断言真实 URL。
   * 列表里另有一条同名族、同 keyType 的诱饵排在前面：必须选到 zcode-team-api-key 那一条。 */
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const calls = [];
  const { client, clock } = makeTeamClient(t, { setting: teamSel("org-kid", "proj-kid"), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  await teamFirstRound(client, clock);
  assert.deepEqual(teamPatCalls(calls).map((c) => [c.method, c.url]), [
    ["POST", "https://bigmodel.cn/api/biz/v1/organization/org-kid/projects/proj-kid/api_keys/" + TEAM_KEY_ID + "/access_tokens"],
  ]);
  assert.equal(calls.some((c) => c.url.indexOf("/undefined/") >= 0), false, "任何请求 URL 都不得带 undefined 路径段");
  assert.equal(calls.filter((c) => c.url === TEAM_MONITOR.bigmodel)[0].headers.authorization, "pat.team.token");
  assert.equal(client.view().sources["bigmodel-team"].status, "ok");
});

test("team: 密钥 ID trim 后经 encodeURIComponent 拼进换发 URL", async (t) => {
  const raw = "  id/with?reserved#chars &more  ";
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const calls = [];
  const { client, clock } = makeTeamClient(t, { setting: teamSel("org-enc", "proj-enc"), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, keyIdRaw: raw });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  await teamFirstRound(client, clock);
  assert.deepEqual(teamPatCalls(calls).map((c) => c.url), [
    "https://bigmodel.cn/api/biz/v1/organization/org-enc/projects/proj-enc/api_keys/" + encodeURIComponent(raw.trim()) + "/access_tokens",
  ], "去空白并编码后的密钥 ID：路径里不得出现原始斜杠、空格或井号");
});

test("team: 密钥 ID 是路径段保留写法（. 或 ..）时按没有团队密钥处理，不发换发请求", async (t) => {
  /* `.` 与 `..` 经 encodeURIComponent 原样保留，URL 规范化会吃掉上一级路径段 */
  for (const [i, id] of [".", ".."].entries()) {
    const tc = TEAM_CREDS(Q, "plan.team.key");
    const calls = [];
    const org = "org-dots" + i;
    const { client, clock } = makeTeamClient(t, { setting: teamSel(org, "proj-" + org), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, keyIdRaw: "  " + id + "  " });
    Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
    await teamFirstRound(client, clock);
    assert.ok(calls.some((c) => /\/api_keys$/.test(c.url)), "链走到了第②步（列出密钥）：" + id);
    assert.equal(teamPatCalls(calls).length, 0, "不发换发请求：" + id);
    assert.equal(calls.some((c) => c.url === TEAM_MONITOR.bigmodel), false, "没有 PAT 就不查 monitor：" + id);
    assert.equal(client.view().sources["bigmodel-team"].status, "unsupported", id);
  }
});

test("team: 秒级 expiresAt 的 PAT 在有效期内复用——三步链只跑一轮（issue #481）", async (t) => {
  /* 旧代码把秒级 expiresAt 直接与毫秒时钟比较，缓存永不命中：每轮套餐刷新都重签一次 PAT。 */
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const calls = [];
  const { client, clock } = makeTeamClient(t, { setting: teamSel("org-exp", "proj-exp"), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  client.noteProvider("account:bigmodel-team-coding-plan");
  client.tick(); await Q.ensureDefaultV2Key(); clock.t += 1100; client.tick();
  await sleep(10);
  assert.equal(calls.filter((c) => c.url === TEAM_MONITOR.bigmodel).length, 1);
  assert.equal(teamPatCalls(calls).length, 1);
  for (const round of [2, 3]) {        // 套餐 TTL 过后再查两轮（共约 20 分钟）：PAT 仍有约 40 分钟有效期
    clock.t += Q.TTL_MS + 1;
    client.tick();
    await sleep(10);
    assert.equal(calls.filter((c) => c.url === TEAM_MONITOR.bigmodel).length, round, "monitor 每轮照常重查");
    assert.equal(teamPatCalls(calls).length, 1, "PAT 未到期不重签");
    assert.equal(client.view().sources["bigmodel-team"].status, "ok");
  }
});

test("team: PAT 落在到期前 2 分钟内即重签，未进提前量则复用——秒级与毫秒 expiresAt 各验一遍", async (t) => {
  /* 时钟每轮跳一个套餐 TTL（10 分钟）。PAT 有效期取 1290 秒：第二轮在签发后约 600 秒（未进提前量）
   * 复用，第三轮约 1200 秒（只剩约 90 秒，落入 2 分钟提前量）重签——提前量改成 0 或 60 秒都会红。
   * 毫秒口径同时锁死「不分单位一律乘 1000」：放大后过期时间落到遥远未来，缓存永不失效。 */
  for (const [unit, org] of [["s", "org-lead"], ["ms", "org-leadms"]]) {
    const tc = TEAM_CREDS(Q, "plan.team.key");
    const calls = [];
    const { client, clock } = makeTeamClient(t, { setting: teamSel(org, "proj-" + org), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, patTtlSec: 1290, patExpiresUnit: unit });
    Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
    await teamFirstRound(client, clock);
    assert.equal(teamPatCalls(calls).length, 1, unit);
    const monitors = () => calls.filter((c) => c.url === TEAM_MONITOR.bigmodel).length;
    clock.t += Q.TTL_MS + 1;             // 签发后约 600 秒：距到期还有约 690 秒
    client.tick();
    await sleep(10);
    assert.equal(monitors(), 2, unit);
    assert.equal(teamPatCalls(calls).length, 1, "未进提前量的 PAT 复用：" + unit);
    clock.t += Q.TTL_MS + 1;             // 签发后约 1200 秒：只剩约 90 秒，落入 2 分钟提前量
    client.tick();
    await sleep(10);
    assert.equal(monitors(), 3, unit);
    assert.equal(teamPatCalls(calls).length, 2, "落入刷新提前量的 PAT 重签：" + unit);
    assert.equal(client.view().sources["bigmodel-team"].status, "ok", unit);
  }
});

test("team: expiresAt 与 expiresIn 不一致时以 expiresAt 为准（秒级与毫秒各验一遍）", async (t) => {
  for (const [unit, org] of [["s", "org-atwin"], ["ms", "org-atwinms"]]) {
    const tc = TEAM_CREDS(Q, "plan.team.key");
    const calls = [];
    const { client, clock } = makeTeamClient(t, { setting: teamSel(org, "proj-" + org), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, patTtlSec: 60, patExpiresAtSec: 3600, patExpiresUnit: unit });
    Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
    await teamFirstRound(client, clock);
    clock.t += Q.TTL_MS + 1;
    client.tick();
    await sleep(10);
    assert.equal(teamPatCalls(calls).length, 1, "合理的 expiresAt 照常生效，不回落到 60 秒的 expiresIn：" + unit);
  }
});

test("team: 离谱的 expiresAt（非有限或远超任何合理时钟）不会把 PAT 永久缓存", async (t) => {
  /* JSON 文本里直接写：1e400（解析成 Infinity）、1e308、1e15 与 9.99e13（毫秒口径的离谱未来）、5e11 与 1e13
   * （换算成毫秒后仍在 7 天以外）；配合 60 秒的 expiresIn，下一轮必须重签 */
  for (const [i, raw] of ["1e400", "1e308", "1e15", "9.99e13", "5e11", "1e13"].entries()) {
    const tc = TEAM_CREDS(Q, "plan.team.key");
    const calls = [];
    const org = "org-absurd" + i;
    const { client, clock } = makeTeamClient(t, { setting: teamSel(org, "proj-" + org), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, patTtlSec: 60, patExpiresRaw: raw });
    Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
    await teamFirstRound(client, clock);
    assert.equal(teamPatCalls(calls).length, 1, raw);
    clock.t += Q.TTL_MS + 1;
    client.tick();
    await sleep(10);
    assert.equal(teamPatCalls(calls).length, 2, "离谱值按缺失处理，回落到 60 秒的 expiresIn，早已过期：" + raw);
    assert.equal(calls.filter((c) => c.url === TEAM_MONITOR.bigmodel).length, 2, raw);
    assert.equal(client.view().sources["bigmodel-team"].status, "ok", raw);
  }
});

test("team: 离谱的 expiresIn 回落到缺省 1 小时，而不是几十年", async (t) => {
  /* 没带 expiresAt、expiresIn 是 10 亿秒（31 年）或 1e306（折算后溢出成 Infinity）：只能落到缺省 3600 秒 */
  for (const [i, raw] of ["1e9", "1e306"].entries()) {
    const tc = TEAM_CREDS(Q, "plan.team.key");
    const calls = [];
    const org = "org-absin" + i;
    const { client, clock } = makeTeamClient(t, { setting: teamSel(org, "proj-" + org), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, patTtlSec: 60, patExpiresRaw: "null", patExpiresInRaw: raw });
    Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
    await teamFirstRound(client, clock);
    assert.equal(teamPatCalls(calls).length, 1, raw);
    clock.t += Q.TTL_MS + 1;             // 签发后约 10 分钟：缺省 1 小时内，复用
    client.tick();
    await sleep(10);
    assert.equal(teamPatCalls(calls).length, 1, "缺省 1 小时内复用：" + raw);
    clock.t += 55 * 60 * 1000;           // 签发后约 65 分钟：超出缺省 1 小时，重签
    client.tick();
    await sleep(10);
    assert.equal(teamPatCalls(calls).length, 2, "超出缺省 1 小时重签：" + raw);
    assert.equal(client.view().sources["bigmodel-team"].status, "ok", raw);
  }
});

test("team: 合理的几小时 expiresIn 在不带 expiresAt 时照常生效（上界不收得过紧）", async (t) => {
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const calls = [];
  const { client, clock } = makeTeamClient(t, { setting: teamSel("org-in2h", "proj-in2h"), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, patTtlSec: 7200, patExpiresRaw: "null" });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  await teamFirstRound(client, clock);
  clock.t += 80 * 60 * 1000;           // 签发后约 80 分钟：2 小时有效期内，复用
  client.tick();
  await sleep(10);
  assert.equal(teamPatCalls(calls).length, 1, "2 小时有效期内复用");
  clock.t += 50 * 60 * 1000;           // 签发后约 130 分钟：超出 2 小时减去 2 分钟提前量，重签
  client.tick();
  await sleep(10);
  assert.equal(teamPatCalls(calls).length, 2, "超出有效期重签");
});

test("team: 已过期的 expiresAt 原样保留，缓存落空后重签，不借用回落的有效期", async (t) => {
  /* 过期时间在 60 秒前，expiresIn 却说还有 1 小时：以 expiresAt 为准 */
  for (const [unit, org] of [["s", "org-expkeep"], ["ms", "org-expkeepms"]]) {
    const tc = TEAM_CREDS(Q, "plan.team.key");
    const calls = [];
    const { client, clock } = makeTeamClient(t, { setting: teamSel(org, "proj-" + org), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, patTtlSec: 3600, patExpiresAtSec: -60, patExpiresUnit: unit });
    Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
    await teamFirstRound(client, clock);
    assert.equal(teamPatCalls(calls).length, 1, unit);
    clock.t += Q.TTL_MS + 1;
    client.tick();
    await sleep(10);
    assert.equal(teamPatCalls(calls).length, 2, "已过期的 PAT 不复用：" + unit);
  }
});

test("team: 响应不带 expiresAt 与 expiresIn 时按缺省 1 小时缓存", async (t) => {
  const tc = TEAM_CREDS(Q, "plan.team.key");
  const calls = [];
  const { client, clock } = makeTeamClient(t, { setting: teamSel("org-defttl", "proj-defttl"), fam: "bigmodel", creds: { "oauth:bigmodel:access_token": tc.entry }, calls, patExpiresRaw: "null", patExpiresInRaw: "null" });
  Q.setDefaultDecryptCtx({ credsPath: "/virtual/team/credentials.json", credsDir: "/virtual/team", env: { ZCODE_CREDENTIAL_SECRET: tc.env } });
  await teamFirstRound(client, clock);
  clock.t += 30 * 60 * 1000;           // 签发后约 30 分钟：缺省 1 小时内，复用
  client.tick();
  await sleep(10);
  assert.equal(teamPatCalls(calls).length, 1, "缺省 1 小时内复用");
  clock.t += 45 * 60 * 1000;           // 签发后约 75 分钟：超出缺省 1 小时，重签
  client.tick();
  await sleep(10);
  assert.equal(teamPatCalls(calls).length, 2, "超出缺省 1 小时重签");
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
      calls.push({ url, headers: init.headers, method: init.method });
      if (url.indexOf("customer-package-reset/list") >= 0) {
        const nth = calls.filter((c) => c.url.indexOf("customer-package-reset/list") >= 0).length;
        return Promise.resolve(fakeRes(200, JSON.stringify({ code: 0, success: true, data: {
          fiveHourResets: nth >= 2
            ? [{ available: true, expireTime: "2026-11-13 09:00:00" }, { available: true, expireTime: "2026-11-13 07:00:00" }, { available: false, expireTime: "2026-11-13 06:00:00" }]
            : [{ available: true, expireTime: "2026-11-13 09:00:00" }, { available: false, expireTime: "2026-11-13 06:00:00" }],
          weekResets: [{ available: true, expireTime: "2026-11-18 09:00:00" }],
        } })));
      }
      if (url.indexOf("/api/biz/customer/getCustomerInfo") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ code: 200, data: { organizations: [
        { organizationId: "org-1", projects: [{ projectId: "proj-1" }] },
      ] } })));
      if (url.indexOf("/api_keys") >= 0 && init.method === "GET") return Promise.resolve(fakeRes(200, JSON.stringify({ code: 200, data: [teamKeyEntry()] })));
      if (url.indexOf("/access_tokens") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ code: 200, data: {
        enabled: true, accessToken: "pat.team.token", tokenType: "Bearer", expiresIn: 3600, expiresAt: Math.floor(T0 / 1000) + 3600,
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
  assert.equal(list[0].headers.authorization, "pat.team.token");   // 重置列表鉴权=项目 PAT
  assert.equal(list[0].headers["Bigmodel-Organization"], "org-1");
  assert.equal(list[0].headers["Bigmodel-Project"], "proj-1");
  const famEntry = client.view().resets && client.view().resets.bigmodel;
  assert.ok(famEntry && famEntry.list && Array.isArray(famEntry.list.fiveHour), "团队列表进视图");
  const liveFive = (famEntry.list.fiveHour || []).filter((c) => c.available !== false);
  assert.equal(liveFive.length, 1, "只计 available 且未过期的卡");
  assert.equal(liveFive[0].expireAt, Date.parse("2026-11-13T09:00:00+08:00"));   // 服务端 UTC+8 字符串
  clock.t += Q.RESET_TTL_MS + 1;
  client.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.filter((c) => c.url.indexOf("customer-package-reset/list?targetType=TEAM") >= 0).length, 2,
    "团队 list 就是主链：不受个人链列表子 TTL 限制，每个 status 周期照打");
  const famEntry2 = client.view().resets && client.view().resets.bigmodel;
  assert.equal((famEntry2.list.fiveHour || []).filter((c) => c.available !== false).length, 2,
    "团队 list 视图随服务端更新（sticky 不适用于团队分支，不被冻结在首轮）");
  assert.ok(calls.every((c) => JSON.stringify(c).indexOf("enc:v") < 0), "任何请求不外发密文");
});

