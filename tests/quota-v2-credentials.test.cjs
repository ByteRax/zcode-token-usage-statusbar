const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* ---------- enc:v2（宿主 3.18.0 起凭据格式） ----------
 * 形状：enc:v2:<os|env>:<sha256(key)hex[:24]>:<base64url(iv).base64url(tag).base64url(ct)>
 * 与 quota-client.test.cjs 的 v1 夹具并列：这里按宿主加密器同款自建密文。每个失败用例只留
 * 一个失败点（其余字段全部合法），否则多重失败叠加时删掉任何一道校验都照样 null。 */
const sha256 = (v) => crypto.createHash("sha256").update(v).digest();
const keyIdOf = (key) => sha256(key).toString("hex").slice(0, 24);
function v2Payload(plain, key, { ivLen = 12, tagLen = 16 } = {}) {
  const iv = crypto.randomBytes(ivLen);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag().subarray(0, tagLen), ct].map((b) => b.toString("base64url")).join(".");
}
function v2Entry(plain, key, source, opts = {}) {
  return `enc:v2:${source}:${opts.keyId || keyIdOf(key)}:${v2Payload(plain, key, opts)}`;
}
const ENV_SECRET = "test-managed-secret-0123456789abcdef";
const ENV_KEY = sha256(ENV_SECRET);
const OS_KEY = crypto.randomBytes(32);
const OS_SECRET = OS_KEY.toString("base64url");   // 钥匙串里存的形状：43 字符 base64url
const T0 = 1700000000000;

/* 钥匙串密钥缓存是模块级、按凭据路径分桶：每个用例用自己的路径，互不串味 */
let pathSeq = 0;
const freshCredsPath = () => `/virtual/v2-${process.pid}-${++pathSeq}/credentials.json`;
const envJ = (extra) => Object.assign({ env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET }, credsPath: freshCredsPath() }, extra);

/* 宿主 @napi-rs/keyring AsyncEntry 的替身：记录开条目参数与读取次数 */
function fakeKeyring(secret) {
  const opens = [];
  let reads = 0;
  const open = (service, account) => {
    opens.push({ service, account });
    return { getPassword: () => { reads += 1; return typeof secret === "function" ? secret() : Promise.resolve(secret); } };
  };
  return { open, opens, reads: () => reads };
}
const settle = () => new Promise((r) => setImmediate(r));   // 等异步取钥落定（promise 回调在本轮微任务内跑完）
const flush = () => new Promise((r) => setTimeout(r, 5));

/* ---------- decryptValue（只认 v1） ---------- */
test("decryptValue: 明文与非字符串原样；其它 enc 代际一律 null（不再把密文当明文透传）", () => {
  const key = Q.deriveCipherKey({ ZCODE_CREDENTIAL_SECRET: "legacy" });
  assert.equal(Q.decryptValue("plain-token", key), "plain-token");
  assert.equal(Q.decryptValue(42, key), 42);
  assert.equal(Q.decryptValue(v2Entry("t", ENV_KEY, "env"), key), null);
  assert.equal(Q.decryptValue(v2Entry("t", OS_KEY, "os"), key), null);
  assert.equal(Q.decryptValue("enc:v9:whatever", key), null);
});

/* ---------- decryptHostCredential：env 源（同步） ---------- */
test("v2:env roundtrip；明文原样；v1 旧链等价", () => {
  const j = envJ();
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.v2.token", ENV_KEY, "env"), j), "jwt.v2.token");
  assert.equal(Q.decryptHostCredential("plain-token", j), "plain-token");
  assert.equal(Q.decryptHostCredential(42, j), 42);
  const legacyKey = Q.deriveCipherKey(j.env);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
  const ct = Buffer.concat([c.update("legacy.token", "utf8"), c.final()]);
  const v1 = "enc:v1:" + [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
  assert.equal(Q.decryptHostCredential(v1, j), "legacy.token");
  assert.equal(Q.decryptHostCredential(v1, j), Q.decryptValue(v1, legacyKey));
});

test("keyId 校验是独立的一道门：密钥与密文都对、只有 keyId 段不符也拒绝", () => {
  const j = envJ();
  const good = v2Entry("jwt.keyid", ENV_KEY, "env");
  assert.equal(Q.decryptHostCredential(good, j), "jwt.keyid");
  const otherKeyId = keyIdOf(crypto.randomBytes(32));   // 合法 hex24，只是不属于这把钥
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.keyid", ENV_KEY, "env", { keyId: otherKeyId }), j), null);
});

test("错误 secret、篡改密文、未知代际与残缺形状一律 null", () => {
  const j = envJ();
  const good = v2Entry("jwt.shape", ENV_KEY, "env");
  assert.equal(Q.decryptHostCredential(good, envJ({ env: { ZCODE_CREDENTIAL_SECRET: "another-secret-0123456789abcdef" } })), null);
  assert.equal(Q.decryptHostCredential(good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA"), j), null);
  assert.equal(Q.decryptHostCredential("enc:v3:" + good.slice("enc:v2:".length), j), null);
  assert.equal(Q.decryptHostCredential(`enc:v2:env:${keyIdOf(ENV_KEY)}`, j), null);                                  // 缺 payload
  assert.equal(Q.decryptHostCredential(good + ":extra", j), null);                                                     // 多一段
  assert.equal(Q.decryptHostCredential(`enc:v2:env:${"Z".repeat(24)}:${v2Payload("x", ENV_KEY)}`, j), null);           // keyId 非 hex
});

test("iv 必须 12 字节、tag 必须 16 字节：其它长度的合法 GCM 密文也拒绝", () => {
  const j = envJ();
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.iv", ENV_KEY, "env", { ivLen: 16 }), j), null);   // Node 本身接受非 96 位 IV
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.tag", ENV_KEY, "env", { tagLen: 12 }), j), null);
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.iv", ENV_KEY, "env"), j), "jwt.iv");
});

test("源白名单：os/env 之外的源即使密钥、keyId、密文全对也拒绝，且不去开钥匙串", async () => {
  const ring = fakeKeyring(OS_SECRET);
  const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring.open };
  const entry = v2Entry("jwt.tpm", OS_KEY, "tpm");
  assert.equal(Q.decryptHostCredential(entry, j), null);
  await settle();
  assert.equal(Q.decryptHostCredential(entry, j), null);
  assert.equal(ring.opens.length, 0);
});

test("env 源来源序同宿主：环境变量 → 显式文件（不查权限位）→ 凭据同目录 credential-secret（仅属主）", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-sec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsPath = path.join(dir, "credentials.json");
  const entry = v2Entry("jwt.file", ENV_KEY, "env");

  // 两个环境变量同配：宿主视为不可用
  assert.equal(Q.decryptHostCredential(entry, { env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET, ZCODE_CREDENTIAL_SECRET_FILE: path.join(dir, "x") }, credsPath }), null);

  // 显式文件：0644 也可用（宿主只对默认文件查权限位）；尺寸窗口 32–4096 字节；必须是常规文件
  const explicit = path.join(dir, "explicit-secret");
  fs.writeFileSync(explicit, ENV_SECRET, { mode: 0o644 });
  const viaFile = (file) => Q.decryptHostCredential(entry, { env: { ZCODE_CREDENTIAL_SECRET_FILE: file }, credsPath });
  assert.equal(viaFile(explicit), "jwt.file");
  for (const size of [31, 4097]) {
    const odd = path.join(dir, "secret-" + size);
    const text = "s".repeat(size);
    fs.writeFileSync(odd, text);
    assert.equal(Q.decryptHostCredential(v2Entry("t", sha256(text), "env"), { env: { ZCODE_CREDENTIAL_SECRET_FILE: odd }, credsPath }), null, size + " 字节越窗");
  }
  for (const size of [32, 4096]) {
    const edge = path.join(dir, "secret-" + size);
    const text = "s".repeat(size);
    fs.writeFileSync(edge, text);
    assert.equal(Q.decryptHostCredential(v2Entry("edge", sha256(text), "env"), { env: { ZCODE_CREDENTIAL_SECRET_FILE: edge }, credsPath }), "edge", size + " 字节在窗内");
  }
  assert.equal(viaFile(dir), null);   // 目录不是常规文件

  // 默认文件：无环境变量时读凭据同目录 credential-secret，非 win32 要求仅属主可读写
  const sibling = path.join(dir, "credential-secret");
  assert.equal(Q.decryptHostCredential(entry, { env: {}, credsPath }), null);   // 尚不存在
  fs.writeFileSync(sibling, ENV_SECRET, { mode: 0o600 });
  assert.equal(Q.decryptHostCredential(entry, { env: {}, credsPath }), "jwt.file");
  if (process.platform !== "win32") {
    fs.chmodSync(sibling, 0o644);
    assert.equal(Q.decryptHostCredential(entry, { env: {}, credsPath }), null);
  }
});

/* ---------- decryptHostCredential：os 源（钥匙串，异步取钥） ---------- */
test("v2:os 取钥契约：service 与 account（绝对化凭据路径的 sha256）同宿主；到位前 null，到位后解出且不再重开", async () => {
  const ring = fakeKeyring(OS_SECRET);
  const credsPath = freshCredsPath();
  const j = { env: {}, credsPath, keyringEntry: ring.open, now: () => T0 };
  const entry = v2Entry("jwt.os.token", OS_KEY, "os");

  for (let i = 0; i < 5; i++) assert.equal(Q.decryptHostCredential(entry, j), null);   // 未就绪：按解密失败降级
  assert.deepEqual(ring.opens, [{ service: "ZCode Credential Encryption", account: sha256(path.resolve(credsPath)).toString("hex") }]);
  assert.equal(ring.reads(), 1);   // 单飞：在途期间不重复取

  await settle();
  assert.equal(Q.decryptHostCredential(entry, j), "jwt.os.token");
  assert.equal(Q.decryptHostCredential(v2Entry("second", OS_KEY, "os"), j), "second");
  assert.equal(ring.reads(), 1);   // 缓存命中：之后零 I/O
});

test("v2:os 取不到钥：负缓存窗口内不重取，过窗才重试一次；坏形状的钥匙串值同样按取不到", async () => {
  for (const bad of [null, "", "short", OS_SECRET + "A", OS_SECRET.slice(0, 42) + "!"]) {
    const ring = fakeKeyring(bad);
    const clock = { t: T0 };
    const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring.open, now: () => clock.t };
    const entry = v2Entry("jwt.miss", OS_KEY, "os");
    assert.equal(Q.decryptHostCredential(entry, j), null);
    await settle();
    for (let i = 0; i < 6; i++) assert.equal(Q.decryptHostCredential(entry, j), null);
    assert.equal(ring.reads(), 1, "窗口内不重取：" + JSON.stringify(bad));
    clock.t += 10 * 60 * 1000;
    assert.equal(Q.decryptHostCredential(entry, j), null);
    await settle();
    assert.equal(ring.reads(), 2, "过窗重试一次");
  }
});

test("v2:os 开条目抛错、读取 reject、句柄残缺都只是取不到，不向上抛", async () => {
  const entry = v2Entry("jwt.err", OS_KEY, "os");
  const cases = [
    () => { throw new Error("addon missing"); },
    () => ({ getPassword: () => Promise.reject(new Error("keychain locked")) }),
    () => ({ getPassword: () => { throw new Error("sync failure"); } }),
    () => ({}),
    () => null,
  ];
  for (const open of cases) {
    const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: open, now: () => T0 };
    assert.equal(Q.decryptHostCredential(entry, j), null);
    await settle();
    assert.equal(Q.decryptHostCredential(entry, j), null);
  }
});

test("v2:os 取到的钥与条目 keyId 不符：拒绝解密，窗口内不反复重取", async () => {
  const ring = fakeKeyring(OS_SECRET);
  const clock = { t: T0 };
  const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring.open, now: () => clock.t };
  const stale = v2Entry("jwt.stale", crypto.randomBytes(32), "os");   // 用另一把钥加密的旧条目
  assert.equal(Q.decryptHostCredential(stale, j), null);
  await settle();
  for (let i = 0; i < 6; i++) assert.equal(Q.decryptHostCredential(stale, j), null);
  assert.equal(ring.reads(), 1);
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.current", OS_KEY, "os"), j), "jwt.current");   // 同一把钥的条目照常可解
  clock.t += 10 * 60 * 1000;
  assert.equal(Q.decryptHostCredential(stale, j), null);
  await settle();
  assert.equal(ring.reads(), 2);
});

/* ---------- 调度链端到端 ---------- */
function fakeRes(status, body) {
  return { status, headers: { get: () => null }, text: async () => body };
}
const MONITOR_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";
const OK_BODY = JSON.stringify({ success: true, data: { level: "max", limits: [
  { type: "TOKENS_LIMIT", unit: 3, percentage: 26, nextResetTime: 1793176110955 },
] } });
function makeClient(t, opts) {
  const calls = [];
  const client = Q.createQuotaClient(Object.assign({
    env: {},
    now: () => T0,
    fetchImpl: (url, init) => {
      calls.push({ url, headers: init.headers });
      if (url.indexOf("/api/biz/subscription/list") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ success: true, data: [] })));
      if (url.indexOf("/reset/status") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ code: 0, success: true, data: { available_five_hour_resets: [], available_week_resets: [] } })));
      return Promise.resolve(fakeRes(200, url === MONITOR_URL ? OK_BODY : "{}"));
    },
  }, opts));
  t.after(() => client.dispose());
  return { client, calls };
}
const everyHeaderValue = (calls) => calls.flatMap((c) => Object.values(c.headers || {}).map(String));

test("client: enc:v2:os 凭据——取钥到位前零请求，到位后自动唤醒并以解密后的 token 发请求", async (t) => {
  const ring = fakeKeyring(OS_SECRET);
  const credsPath = freshCredsPath();
  const { client, calls } = makeClient(t, {
    credsPath, keyringEntry: ring.open,
    readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.v2.real", OS_KEY, "os") }; throw new Error("ENOENT"); },
  });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  assert.equal(calls.length, 0);   // 钥还没到：不发任何请求
  const pending = client.view().sources.bigmodel;
  assert.ok(pending && pending.status === "not_configured" && pending.reason === "decrypt");

  await settle();   // 钥到位 → 唤醒回调 → 重评并 tick，无需再等低频探测
  await flush();
  const monitor = calls.filter((c) => c.url === MONITOR_URL);
  const subscription = calls.filter((c) => c.url.indexOf("/api/biz/subscription/list") >= 0);
  assert.equal(monitor.length, 1);
  assert.equal(monitor[0].headers.authorization, "jwt.v2.real");
  assert.equal(subscription.length, 1);
  assert.equal(subscription[0].headers.authorization, "jwt.v2.real");
  assert.ok(everyHeaderValue(calls).every((v) => !v.startsWith("enc:")), "任何请求头都不带密文");
  assert.equal(client.view().sources.bigmodel.status, "ok");
  assert.equal(ring.reads(), 1);
});

test("client: 钥匙串取不到钥——not_configured(decrypt)，始终零请求", async (t) => {
  const ring = fakeKeyring(null);
  const credsPath = freshCredsPath();
  const { client, calls } = makeClient(t, {
    credsPath, keyringEntry: ring.open,
    readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.hidden", OS_KEY, "os") }; throw new Error("ENOENT"); },
  });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  await settle();
  for (let i = 0; i < 4; i++) { client.tick(); client.view(); }   // 每次载荷推送都会重评凭据：不得再触发取钥
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(ring.reads(), 1);
  const entry = client.view().sources.bigmodel;
  assert.ok(entry && entry.status === "not_configured" && entry.reason === "decrypt");
});

test("client: dispose 注销唤醒回调——之后钥才到位也不再发请求", async () => {
  let release;
  const ring = fakeKeyring(() => new Promise((r) => { release = () => r(OS_SECRET); }));
  const credsPath = freshCredsPath();
  const calls = [];
  const client = Q.createQuotaClient({
    env: {}, now: () => T0, credsPath, keyringEntry: ring.open,
    readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.late", OS_KEY, "os") }; throw new Error("ENOENT"); },
    fetchImpl: (url, init) => { calls.push({ url, headers: init.headers }); return Promise.resolve(fakeRes(200, OK_BODY)); },
  });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  client.dispose();
  release();
  await settle();
  await flush();
  assert.equal(calls.length, 0);
});

test("client: zcode-start 链（zcodejwttoken）解 enc:v2，请求头是明文 token", async (t) => {
  const credsPath = freshCredsPath();
  const dir = path.dirname(credsPath);
  const { client, calls } = makeClient(t, {
    env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET }, credsPath,
    readFile: (p) => {
      if (p === credsPath) return { zcodejwttoken: v2Entry("start.v2.jwt", ENV_KEY, "env") };
      if (p === path.join(dir, "telemetry-state.json")) return { deviceMid: "0123456789abcdef0123456789abcdef" };
      throw new Error("ENOENT");
    },
  });
  client.noteProvider("account:bigmodel-start-plan");
  client.setProviders(["account:bigmodel-start-plan"]);
  client.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance");
  assert.equal(calls[0].headers.authorization, "Bearer start.v2.jwt");
  assert.equal(calls[0].headers["X-Device-Mid"], "0123456789abcdef0123456789abcdef");
});

test("client: 重置卡链（OAuth + zcodejwttoken 成对）解 enc:v2，两个请求头都是明文", async (t) => {
  const credsPath = freshCredsPath();
  const { client, calls } = makeClient(t, {
    env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET }, credsPath,
    quotaEnabled: () => false, resetEnabled: () => true,
    readFile: (p) => {
      if (p === credsPath) return {
        "oauth:bigmodel:access_token": v2Entry("oauth.v2.tok", ENV_KEY, "env"),
        zcodejwttoken: v2Entry("zcode.v2.jwt", ENV_KEY, "env"),
      };
      throw new Error("ENOENT");
    },
  });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  await flush();
  const status = calls.filter((c) => c.url.indexOf("/api/v1/coding-plan/reset/status") >= 0);
  assert.equal(status.length, 1);
  assert.equal(status[0].headers.authorization, "Bearer zcode.v2.jwt");
  assert.equal(status[0].headers["X-Bigmodel-Authorization"], "oauth.v2.tok");
  assert.ok(everyHeaderValue(calls).every((v) => !v.startsWith("enc:")));
});

/* ---------- 取钥门面的边角语义 ---------- */
/* 依次返回给定结果的钥匙串替身；用完后重复最后一个 */
function sequencedKeyring(results) {
  let reads = 0;
  const open = () => ({ getPassword: () => { const r = results[Math.min(reads, results.length - 1)]; reads += 1; return typeof r === "function" ? r() : Promise.resolve(r); } });
  return { open, reads: () => reads };
}
const TEN_MIN = 10 * 60 * 1000;

test("重取失败不清掉已缓存的可用密钥", async () => {
  const ring = sequencedKeyring([OS_SECRET, null]);
  const clock = { t: T0 };
  const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring.open, now: () => clock.t };
  const good = v2Entry("jwt.keep", OS_KEY, "os");
  const stale = v2Entry("jwt.stale", crypto.randomBytes(32), "os");
  Q.decryptHostCredential(good, j);
  await settle();
  assert.equal(Q.decryptHostCredential(good, j), "jwt.keep");
  clock.t += TEN_MIN;
  assert.equal(Q.decryptHostCredential(stale, j), null);   // 过窗：为失配条目重取，这次读取失败
  await settle();
  assert.equal(ring.reads(), 2);
  assert.equal(Q.decryptHostCredential(good, j), "jwt.keep");
});

test("时钟回拨不会无限期推迟重试：从回拨后的时刻重新计窗", async () => {
  const ring = sequencedKeyring([null]);
  const clock = { t: T0 };
  const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring.open, now: () => clock.t };
  const entry = v2Entry("jwt.clock", OS_KEY, "os");
  Q.decryptHostCredential(entry, j);
  await settle();
  clock.t = T0 - 6 * TEN_MIN;                      // 系统时间被拨回一小时
  assert.equal(Q.decryptHostCredential(entry, j), null);
  await settle();
  Q.decryptHostCredential(entry, j);               // 回拨后的下一拍：从回拨时刻重新计窗
  await settle();
  assert.equal(ring.reads(), 1, "回拨当下与紧随的一拍都不立即重取");
  clock.t += TEN_MIN;                               // 回拨后的 10 分钟：已过重试窗
  Q.decryptHostCredential(entry, j);
  await settle();
  assert.equal(ring.reads(), 2);
});

test("读取迟迟不落定：软超时只留日志，在途期间绝不叠加新读取；迟到结果照常采纳", async () => {
  let release;
  const ring = sequencedKeyring([() => new Promise((r) => { release = r; })]);
  const clock = { t: T0 };
  const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring.open, now: () => clock.t, keyTimeoutMs: 15 };
  const entry = v2Entry("jwt.soft", OS_KEY, "os");
  Q.decryptHostCredential(entry, j);
  await new Promise((r) => setTimeout(r, 50));      // 软超时已触发
  clock.t += 60 * 60 * 1000;                         // 无论过多久
  Q.hostKeyRetryNow(j.credsPath);                    // 无论手动清不清窗
  for (let i = 0; i < 5; i++) Q.decryptHostCredential(entry, j);
  assert.equal(ring.reads(), 1, "挂住的读取释不掉：绝不叠加新读取（叠加会占满线程池）");
  release(OS_SECRET);                                // 迟到的正确结果照常采纳
  await settle();
  assert.equal(Q.decryptHostCredential(entry, j), "jwt.soft");
  assert.equal(ring.reads(), 1);
});

test("在途期间被要求重试：读取失败后不开新窗口，下一次调用立即重读", async () => {
  let release;
  const ring = sequencedKeyring([() => new Promise((r) => { release = r; }), OS_SECRET]);
  const clock = { t: T0 };
  const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring.open, now: () => clock.t };
  const entry = v2Entry("jwt.retry", OS_KEY, "os");
  Q.decryptHostCredential(entry, j);                 // 在途
  Q.hostKeyRetryNow(j.credsPath);                    // 用户在此期间点了刷新
  release(null);                                     // 这次读取失败
  await settle();
  Q.decryptHostCredential(entry, j);                 // 不等重试窗，立即再读
  await settle();
  assert.equal(ring.reads(), 2);
  assert.equal(Q.decryptHostCredential(entry, j), "jwt.retry");
});

test("缓存命中先于在途检查：后台重取在途期间，已可解的条目照常解出", async () => {
  let hang;
  const ring = sequencedKeyring([OS_SECRET, () => new Promise((r) => { hang = r; })]);
  const clock = { t: T0 };
  const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring.open, now: () => clock.t };
  const good = v2Entry("jwt.cached", OS_KEY, "os");
  const stale = v2Entry("jwt.stale2", crypto.randomBytes(32), "os");
  Q.decryptHostCredential(good, j);
  await settle();
  clock.t += TEN_MIN;                                 // 失配条目触发后台重取（这次挂住）
  Q.decryptHostCredential(stale, j);
  assert.equal(ring.reads(), 2);
  assert.equal(Q.decryptHostCredential(good, j), "jwt.cached", "在途重取不得冻结已缓存的密钥");
});

test("取钥失败日志只含原因分类，不含钥匙串原值", async () => {
  const logs = [];
  const secret = "not-a-valid-keyring-value-at-all";
  const j = { env: {}, credsPath: freshCredsPath(), keyringEntry: sequencedKeyring([secret]).open, now: () => T0,
    log: (...a) => logs.push(a.map(String).join(" ")) };
  Q.decryptHostCredential(v2Entry("jwt.log", OS_KEY, "os"), j);
  await settle();
  assert.ok(logs.some((l) => /unavailable/.test(l)), "有一次失败原因日志");
  assert.ok(logs.every((l) => !l.includes(secret)), "日志不得包含钥匙串原值");
});

test("入口不带 env（或整个 j 缺席）也不抛：按解不开处理", () => {
  const entry0 = v2Entry("t", OS_KEY, "os");
  assert.equal(Q.decryptHostCredential(entry0, null), null);
  assert.equal(Q.decryptHostCredential(entry0, undefined), null);
  const j = { credsPath: freshCredsPath() };
  assert.equal(Q.decryptHostCredential("enc:v1:AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA", j), null);
  assert.equal(Q.decryptHostCredential(v2Entry("t", ENV_KEY, "env"), j), null);
  assert.equal(Q.decryptHostCredential("plain", j), "plain");
});

/* 生产环境的取钥路径：不注入 keyringEntry，按宿主资源目录解析宿主自带的 @napi-rs/keyring。
 * 用一个假的资源目录顶替（普通目录名叫 app.asar），核对解析锚点与开条目参数。 */
function withFakeHostKeyring(t, secret) {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-host-"));
  const pkg = path.join(resources, "app.asar", "node_modules", "@napi-rs", "keyring");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar", "package.json"), JSON.stringify({ name: "@zcode/desktop" }));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@napi-rs/keyring", main: "index.js" }));
  const bag = "__zusageFakeKeyring" + (++pathSeq);
  globalThis[bag] = { opens: [], secret };
  fs.writeFileSync(path.join(pkg, "index.js"),
    "const bag = globalThis[" + JSON.stringify(bag) + "];\n" +
    "exports.AsyncEntry = class { constructor(service, account, options) { bag.opens.push({ service, account, options }); }\n" +
    "  async getPassword() { return bag.secret; } };\n");
  Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true, writable: true });
  t.after(() => { delete process.resourcesPath; delete globalThis[bag]; fs.rmSync(resources, { recursive: true, force: true }); });
  return globalThis[bag];
}

test("生产取钥路径：从宿主资源目录解析 keyring 并按宿主同款参数开条目", async (t) => {
  const host = withFakeHostKeyring(t, OS_SECRET);
  const credsPath = freshCredsPath();
  const j = { env: {}, credsPath };
  const entry = v2Entry("jwt.host.keyring", OS_KEY, "os");
  assert.equal(Q.decryptHostCredential(entry, j), null);
  await settle();
  assert.equal(Q.decryptHostCredential(entry, j), "jwt.host.keyring");
  assert.deepEqual(host.opens, [{
    service: "ZCode Credential Encryption",
    account: sha256(path.resolve(credsPath)).toString("hex"),
    options: { linux: { store: "secret-service" } },
  }]);
});

test("生产取钥路径：宿主没有 keyring 依赖或不在宿主进程里，只是取不到", async (t) => {
  const entry = v2Entry("jwt.no.host", OS_KEY, "os");
  const outside = { env: {}, credsPath: freshCredsPath() };            // 普通 Node：没有 process.resourcesPath
  assert.equal(Q.decryptHostCredential(entry, outside), null);
  await settle();
  assert.equal(Q.decryptHostCredential(entry, outside), null);

  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-bare-"));   // 有资源目录但没有该依赖（3.17.x 及更早）
  fs.mkdirSync(path.join(resources, "app.asar"), { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar", "package.json"), "{}");
  Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true, writable: true });
  t.after(() => { delete process.resourcesPath; fs.rmSync(resources, { recursive: true, force: true }); });
  const bare = { env: {}, credsPath: freshCredsPath() };
  assert.equal(Q.decryptHostCredential(entry, bare), null);
  await settle();
  assert.equal(Q.decryptHostCredential(entry, bare), null);
});

/* ---------- 调度链：唤醒、重试与状态 ---------- */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("client: 重取到同一把钥不重复唤醒——残留的失配条目不会把额度查询频率翻倍", async (t) => {
  const ring = fakeKeyring(OS_SECRET);
  const clock = { t: T0 };
  const credsPath = freshCredsPath();
  const { client, calls } = makeClient(t, {
    credsPath, keyringEntry: ring.open, now: () => clock.t, resetEnabled: () => true,
    readFile: (p) => {
      if (p === credsPath) return {
        "oauth:bigmodel:access_token": v2Entry("jwt.live", OS_KEY, "os"),
        zcodejwttoken: v2Entry("zcode.jwt", OS_KEY, "os"),
        "oauth:zai:access_token": v2Entry("zai.stale", crypto.randomBytes(32), "os"),   // 另一把钥加密的残留条目
      };
      throw new Error("ENOENT");
    },
  });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  await settle();
  await flush();
  const monitorCalls = () => calls.filter((c) => c.url === MONITOR_URL).length;
  assert.equal(monitorCalls(), 1);
  clock.t += 6 * 60 * 1000;          // 过取钥重试窗、未到额度 TTL
  client.tick();                      // 残留条目触发一次重取，取回的还是同一把钥
  await settle();
  await flush();
  assert.equal(ring.reads(), 2);
  assert.equal(monitorCalls(), 1, "没有新密钥就不该提前重拉额度");
});

test("client: 凭据变更与手动刷新都能越过取钥重试窗", async (t) => {
  for (const kick of [(c) => c.credentialsChanged(), (c) => c.refresh(), (c) => c.refreshSource("bigmodel")]) {
    const ring = sequencedKeyring([null, OS_SECRET]);
    const credsPath = freshCredsPath();
    const { client, calls } = makeClient(t, {
      credsPath, keyringEntry: ring.open,
      readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.unlock", OS_KEY, "os") }; throw new Error("ENOENT"); },
    });
    client.noteProvider("account:bigmodel-individual-coding-plan");
    client.tick();
    await settle();
    client.tick();
    await settle();
    assert.equal(ring.reads(), 1, "窗口内的普通 tick 不重取");
    kick(client);                     // 例如钥匙串刚解锁后用户点了刷新
    await settle();
    await flush();
    assert.equal(ring.reads(), 2);
    assert.equal(calls.filter((c) => c.url === MONITOR_URL).length, 1);
    assert.equal(calls.filter((c) => c.url === MONITOR_URL)[0].headers.authorization, "jwt.unlock");
  }
});

test("client: 密钥到位后首轮查询在途时不再显示未配置；成功后不残留 decrypt 原因", async (t) => {
  const ring = fakeKeyring(OS_SECRET);
  const credsPath = freshCredsPath();
  const monitor = deferred();
  const client = Q.createQuotaClient({
    env: {}, now: () => T0, credsPath, keyringEntry: ring.open,
    readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.state", OS_KEY, "os") }; throw new Error("ENOENT"); },
    fetchImpl: (url) => (url === MONITOR_URL ? monitor.promise : Promise.resolve(fakeRes(200, JSON.stringify({ success: true, data: [] })))),
  });
  t.after(() => client.dispose());
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  assert.equal(client.view().sources.bigmodel.status, "not_configured");   // 钥未到
  await settle();
  const inFlight = client.view().sources.bigmodel;
  assert.equal(inFlight.status, "idle");                                    // 钥到了、查询在途：不是「未配置」
  assert.equal(inFlight.reason, "");
  monitor.resolve(fakeRes(200, OK_BODY));
  await flush();
  const done = client.view().sources.bigmodel;
  assert.equal(done.status, "ok");
  assert.equal(done.reason, "");
});

/* ---------- env 源：文件校验与来源序（每条只留一个失败点） ---------- */
const SECRET_A = "A".repeat(40), SECRET_B = "B".repeat(40);
const keyOf = (s) => sha256(s);

test("env 源来源序：环境变量优先于同目录文件；显式文件缺失不回落同目录文件", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-order-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsPath = path.join(dir, "credentials.json");
  const sibling = path.join(dir, "credential-secret");
  fs.writeFileSync(sibling, SECRET_B, { mode: 0o600 });

  const entryA = v2Entry("jwt.a", keyOf(SECRET_A), "env");
  assert.equal(Q.decryptHostCredential(entryA, { env: { ZCODE_CREDENTIAL_SECRET: SECRET_A }, credsPath }), "jwt.a",
    "环境变量在，就不得读同目录文件去解");
  assert.equal(Q.decryptHostCredential(entryA, { env: {}, credsPath }), null, "同目录文件是另一把钥：解不开");

  const missing = path.join(dir, "no-such-secret");
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.b", keyOf(SECRET_B), "env"),
    { env: { ZCODE_CREDENTIAL_SECRET_FILE: missing }, credsPath }), null,
    "显式指定的文件读不到按不可用，不回落同目录文件（宿主同款）");
});

test("env 源文件：非属主可读写一律拒绝（逐位权限样本）；secret 不做 trim；按字节计尺寸", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-modes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsPath = path.join(dir, "credentials.json");
  const sibling = path.join(dir, "credential-secret");
  if (process.platform !== "win32") {
    fs.writeFileSync(sibling, SECRET_A);   // writeFileSync 的 mode 只在创建时生效：统一用 chmodSync 换挡
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o610, 0o601]) {
      fs.chmodSync(sibling, mode);
      assert.equal(Q.decryptHostCredential(v2Entry("jwt.mode", keyOf(SECRET_A), "env"), { env: {}, credsPath }),
        null, "mode 0" + mode.toString(8) + " 越出仅属主");
    }
    fs.chmodSync(sibling, 0o600);
    assert.equal(Q.decryptHostCredential(v2Entry("jwt.mode", keyOf(SECRET_A), "env"), { env: {}, credsPath }), "jwt.mode", "0600 可用");
  }

  const withNewline = SECRET_A + "\n";   // 带尾随换行：按原样哈希（宿主不 trim）
  fs.writeFileSync(sibling, withNewline, { mode: 0o600 });
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.raw", keyOf(withNewline), "env"), { env: {}, credsPath }), "jwt.raw");
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.trim", keyOf(SECRET_A), "env"), { env: {}, credsPath }), null, "先 trim 再哈希解不开");

  const cjk = "十一个汉字凑三十三字节";   // 11 个汉字 = 33 字节（按字符数会算 11）
  fs.writeFileSync(sibling, cjk, { mode: 0o600 });
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.cjk", keyOf(cjk), "env"), { env: {}, credsPath }), "jwt.cjk");
  const wide = "é".repeat(2049);          // 2049 个两字节字符 = 4098 字节，越窗
  fs.writeFileSync(sibling, wide, { mode: 0o600 });
  assert.equal(Q.decryptHostCredential(v2Entry("jwt.wide", keyOf(wide), "env"), { env: {}, credsPath }), null);
});

/* ---------- 取钥重试窗边界与失败不唤醒 ---------- */
test("取钥重试窗：真实时钟下毫秒级重评不重读；注入时钟恰满窗口即重取、差 1ms 不重取", async () => {
  const entry = v2Entry("jwt.window", OS_KEY, "os");
  const ring2 = sequencedKeyring([null, null]);
  const j2 = { env: {}, credsPath: freshCredsPath(), keyringEntry: ring2.open };
  Q.decryptHostCredential(entry, j2);
  await settle();
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 3; i++) Q.decryptHostCredential(entry, j2);
  assert.equal(ring2.reads(), 1, "重试窗内的连续重评不得重读钥匙串（窗口被改小到毫秒级会红）");

  const ringFixed = sequencedKeyring([null, null]);
  const clock = { t: T0 };
  const jFixed = { env: {}, credsPath: freshCredsPath(), keyringEntry: ringFixed.open, now: () => clock.t };
  Q.decryptHostCredential(entry, jFixed);
  await settle();
  clock.t += 5 * 60 * 1000 - 1;
  Q.decryptHostCredential(entry, jFixed);
  await settle();
  assert.equal(ringFixed.reads(), 1, "差 1ms 仍在窗内");
  clock.t += 1;
  Q.decryptHostCredential(entry, jFixed);
  assert.equal(ringFixed.reads(), 2, "恰满窗口即可重取（边界含等号）");
});

test("client: 取钥失败不唤醒——已成功的宿主凭据源不因残留失配条目被提前重拉", async (t) => {
  const ring = sequencedKeyring([OS_SECRET, null]);
  const clock = { t: T0 };
  const credsPath = freshCredsPath();
  const { client, calls } = makeClient(t, {
    credsPath, keyringEntry: ring.open, now: () => clock.t, resetEnabled: () => true,
    readFile: (p) => {
      if (p === credsPath) return {
        zcodejwttoken: v2Entry("start.jwt", OS_KEY, "os"),
        "oauth:zai:access_token": v2Entry("zai.stale", crypto.randomBytes(32), "os"),   // 残留的失配条目
      };
      if (p === path.join(path.dirname(credsPath), "telemetry-state.json")) return { deviceMid: "0123456789abcdef0123456789abcdef" };
      throw new Error("ENOENT");
    },
  });
  client.noteProvider("account:bigmodel-start-plan");
  client.setProviders(["account:bigmodel-start-plan"]);
  client.tick();
  await settle();
  await flush();
  const balance = () => calls.filter((c) => c.url.indexOf("zcode.z.ai") >= 0).length;
  assert.equal(balance(), 1);
  clock.t += 6 * 60 * 1000;   // 过取钥重试窗：失配条目触发重取，这次读取失败
  client.tick();
  await settle();
  await flush();
  assert.equal(ring.reads(), 2);
  assert.equal(balance(), 1, "取钥失败不构成唤醒，宿主凭据源保持自己的 TTL 节奏");
});


test("client: 密钥到位但 token 已临期——离开未配置态，不再残留 decrypt 失败", async (t) => {
  const ring = fakeKeyring(OS_SECRET);
  const clock = { t: T0 };
  const credsPath = freshCredsPath();
  const soon = Buffer.from(JSON.stringify({ exp: Math.floor((clock.t + 30 * 1000) / 1000) })).toString("base64url");
  const expiringToken = "h." + soon + ".s";   // JWT 形状、30 秒后过期：命中临期早退
  const { client } = makeClient(t, {
    credsPath, keyringEntry: ring.open, now: () => clock.t,
    readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry(expiringToken, OS_KEY, "os") }; throw new Error("ENOENT"); },
  });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  await settle();
  await flush();
  const v = client.view().sources.bigmodel;
  assert.equal(v.status, "idle");   // 不是 not_configured：临期早退发生在状态迁移之后
  assert.equal(v.reason, "");
  assert.ok(!v.lastError, "不残留 decrypt 失败文案");
});

test("client: 额度与重置卡都关时，密钥到位不触发凭据重评（关闭即停解密）", async (t) => {
  const ring = fakeKeyring(OS_SECRET);
  const credsPath = freshCredsPath();
  let reads = 0;
  const client = Q.createQuotaClient({
    env: {}, now: () => T0, credsPath, keyringEntry: ring.open, quotaEnabled: () => false, resetEnabled: () => false,
    readFile: (p) => { if (p === credsPath) { reads += 1; return { "oauth:bigmodel:access_token": v2Entry("jwt.off", OS_KEY, "os") }; } throw new Error("ENOENT"); },
    fetchImpl: (url) => Promise.resolve(fakeRes(200, OK_BODY)),
  });
  t.after(() => client.dispose());
  client.noteProvider("account:bigmodel-individual-coding-plan");   // 单源模式（wantedProviders 为 null）
  Q.decryptHostCredential(v2Entry("jwt.kick", OS_KEY, "os"), { env: {}, credsPath, keyringEntry: ring.open });   // 经同一模块缓存触发取钥（要成功取到才会唤醒）
  await settle();
  const readsAfterKick = reads;
  await flush();
  assert.equal(reads, readsAfterKick, "密钥到位不重评凭据");
});

test("唤醒遍历中注销的 client 不再被唤醒", async (t) => {
  const ring = fakeKeyring(OS_SECRET);
  const credsPath = freshCredsPath();
  const readFile = (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.wake", OS_KEY, "os") }; throw new Error("ENOENT"); };
  const callsA = [], callsB = [];
  let late = null;
  const mk = (calls, onUpdate) => Q.createQuotaClient({
    env: {}, now: () => T0, credsPath, keyringEntry: ring.open, readFile,
    onUpdate,
    fetchImpl: (url, init) => { if (url === MONITOR_URL) calls.push(init.headers.authorization); return Promise.resolve(fakeRes(200, OK_BODY)); },
  });
  const a = mk(callsA, () => { if (late) { late.dispose(); late = null; } });   // A 先被唤醒、开始查询时注销 B
  const b = mk(callsB);
  late = b;
  a.noteProvider("account:bigmodel-individual-coding-plan");
  b.noteProvider("account:bigmodel-individual-coding-plan");
  t.after(() => { a.dispose(); b.dispose(); });
  b.tick();                 // 触发取钥（A、B 都注册了唤醒）
  await settle();
  await flush();
  assert.equal(callsA.length, 1, "A 正常恢复查询");
  assert.deepEqual(callsB, [], "遍历途中被注销的 B 不再被唤醒");
});
