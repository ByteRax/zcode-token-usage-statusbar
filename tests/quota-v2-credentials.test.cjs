const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* ---------- enc:v2（宿主 3.18.0 起凭据格式；实现为上游 #289 分发器架构） ----------
 * 形状：enc:v2:<os|env>:<sha256(key)hex[:24]>:<base64url(iv).base64url(tag).base64url(ct)>
 * 每个失败用例只留一个失败点（其余字段全部合法），否则多重失败叠加时删掉任何一道校验都照样 null。
 * makeHostDecryptor 每实例独立 ctx（缓存/冷却/失配限频），测试免共享态；客户端级用例经
 * setDefaultDecryptCtx 绑定模块级 defaultDec 后 createQuotaClient。 */
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
const V1_KEY = Q.deriveCipherKey({ ZCODE_CREDENTIAL_SECRET: "legacy-secret" });
const T0 = 1700000000000;

let seq = 0;
const freshCreds = () => `/virtual/v2-${process.pid}-${++seq}/credentials.json`;
const credDirOf = (p) => path.dirname(p);

/* 宿主 @napi-rs/keyring AsyncEntry 的替身：记录开条目参数与读取次数 */
function fakeKeyring(secret) {
  const opens = [];
  let reads = 0;
  const mod = { AsyncEntry: class {
    constructor(service, account, options) { opens.push({ service, account, options }); }
    getPassword() { reads += 1; return typeof secret === "function" ? secret() : Promise.resolve(secret); }
  } };
  return { mod, opens, reads: () => reads, setSecret: (s) => { secret = s; } };
}
const settle = () => new Promise((r) => setImmediate(r));
const flush = () => new Promise((r) => setTimeout(r, 5));

/* ---------- decryptValue 分发器与 v1 旧链 ---------- */
test("decryptValue：明文与非字符串原样；未知 enc: 代际一律 null（不再把密文当明文透传）", () => {
  assert.equal(Q.decryptValue("plain-token", V1_KEY), "plain-token");
  assert.equal(Q.decryptValue(42, V1_KEY), 42);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", V1_KEY, iv);
  const ct = Buffer.concat([c.update("legacy", "utf8"), c.final()]);
  const v1 = "enc:v1:" + [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
  assert.equal(Q.decryptValue(v1, V1_KEY), "legacy");
  assert.equal(Q.decryptValue("enc:v9:whatever", V1_KEY), null);
});

/* ---------- 信封形状（env 源，实例直测） ---------- */
test("v2:env roundtrip；keyId 是独立的一道门：密钥与密文都对、只有 keyId 段不符也拒绝", async () => {
  const dec = Q.makeHostDecryptor({ env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET }, credsPath: freshCreds() });
  await dec.ensureKey();   // 预热：解密是同步读缓存（上游设计）
  assert.equal(dec.decrypt(v2Entry("jwt.v2", ENV_KEY, "env"), V1_KEY), "jwt.v2");
  const other = keyIdOf(crypto.randomBytes(32));
  assert.equal(dec.decrypt(v2Entry("jwt.v2", ENV_KEY, "env", { keyId: other }), V1_KEY), null);
});

test("错误 secret、篡改密文、未知代际与残缺形状一律 null", async () => {
  const dec = Q.makeHostDecryptor({ env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET }, credsPath: freshCreds() });
  await dec.ensureKey();
  const good = v2Entry("jwt.shape", ENV_KEY, "env");
  const wrongKey = Q.makeHostDecryptor({ env: { ZCODE_CREDENTIAL_SECRET: "another-secret-0123456789abcdef" }, credsPath: freshCreds() });
  await wrongKey.ensureKey();
  assert.equal(wrongKey.decrypt(good, V1_KEY), null);
  assert.equal(dec.decrypt(good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA"), V1_KEY), null);
  assert.equal(dec.decrypt("enc:v3:" + good.slice("enc:v2:".length), V1_KEY), null);
  assert.equal(dec.decrypt(`enc:v2:env:${keyIdOf(ENV_KEY)}`, V1_KEY), null);
  assert.equal(dec.decrypt(good + ":extra", V1_KEY), null);
  assert.equal(dec.decrypt(`enc:v2:env:${"Z".repeat(24)}:${v2Payload("x", ENV_KEY)}`, V1_KEY), null);
});

test("iv 必须 12 字节、tag 必须 16 字节：其它长度的合法 GCM 密文也拒绝", async () => {
  const dec = Q.makeHostDecryptor({ env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET }, credsPath: freshCreds() });
  await dec.ensureKey();
  assert.equal(dec.decrypt(v2Entry("jwt.iv", ENV_KEY, "env", { ivLen: 16 }), V1_KEY), null);
  assert.equal(dec.decrypt(v2Entry("jwt.tag", ENV_KEY, "env", { tagLen: 12 }), V1_KEY), null);
});

test("源白名单：os/env 之外的源即使密钥、keyId、密文全对也拒绝，且不去开钥匙串", async () => {
  const ring = fakeKeyring(OS_SECRET);
  const dec = Q.makeHostDecryptor({ env: {}, credsPath: freshCreds(), keyringMod: ring.mod });
  const entry = v2Entry("jwt.tpm", OS_KEY, "tpm");
  assert.equal(dec.decrypt(entry, V1_KEY), null);
  await settle();
  assert.equal(dec.decrypt(entry, V1_KEY), null);
  assert.equal(ring.opens.length, 0);
});

/* ---------- env 源：文件校验与来源序（每条只留一个失败点） ---------- */
const SECRET_A = "A".repeat(40), SECRET_B = "B".repeat(40);

test("env 源来源序：环境变量优先于同目录文件；显式文件缺失不回落；同目录文件可作 env 源", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-order-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsPath = path.join(dir, "credentials.json");
  fs.writeFileSync(path.join(dir, "credential-secret"), SECRET_B, { mode: 0o600 });
  const entryA = v2Entry("jwt.a", sha256(SECRET_A), "env");
  const base = { credsPath, credsDir: dir };
  const warm = async (env) => { const d = Q.makeHostDecryptor({ ...base, env }); await d.ensureKey(); return d; };
  assert.equal((await warm({ ZCODE_CREDENTIAL_SECRET: SECRET_A })).decrypt(entryA, V1_KEY), "jwt.a",
    "环境变量在，就不得读同目录文件去解");
  assert.equal((await warm({})).decrypt(entryA, V1_KEY), null, "同目录文件是另一把钥：解不开");
  assert.equal((await warm({ ZCODE_CREDENTIAL_SECRET_FILE: path.join(dir, "no-such") }))
    .decrypt(v2Entry("jwt.b", sha256(SECRET_B), "env"), V1_KEY), null,
    "显式指定的文件读不到按不可用，不回落同目录文件（宿主同款）");
  assert.equal((await warm({}))
    .decrypt(v2Entry("jwt.sib", sha256(SECRET_B), "env"), V1_KEY), "jwt.sib",
    "同目录 credential-secret 可作 env 源（宿主无 os 标记时如此派生，headless 部署靠它）");
});

test("env 源文件：非属主可读写一律拒绝（逐位权限样本）；secret 不做 trim；按字节计尺寸", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-modes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsPath = path.join(dir, "credentials.json");
  const sibling = path.join(dir, "credential-secret");
  const dec = async (env) => { const d = Q.makeHostDecryptor({ credsPath, credsDir: dir, env }); await d.ensureKey(); return d; };
  if (process.platform !== "win32") {
    fs.writeFileSync(sibling, SECRET_A);   // writeFileSync 的 mode 只在创建时生效：统一用 chmodSync 换挡
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o610, 0o601]) {
      fs.chmodSync(sibling, mode);
      assert.equal((await dec({})).decrypt(v2Entry("jwt.mode", sha256(SECRET_A), "env"), V1_KEY), null, "mode 0" + mode.toString(8) + " 越出仅属主");
    }
    fs.chmodSync(sibling, 0o600);
    assert.equal((await dec({})).decrypt(v2Entry("jwt.mode", sha256(SECRET_A), "env"), V1_KEY), "jwt.mode", "0600 可用");
  }
  const withNewline = SECRET_A + "\n";   // 带尾随换行：按原样哈希（宿主不 trim）
  fs.writeFileSync(sibling, withNewline);
  fs.chmodSync(sibling, 0o600);
  assert.equal((await dec({})).decrypt(v2Entry("jwt.raw", sha256(withNewline), "env"), V1_KEY), "jwt.raw");
  assert.equal((await dec({})).decrypt(v2Entry("jwt.trim", sha256(SECRET_A), "env"), V1_KEY), null, "先 trim 再哈希解不开");
  const cjk = "十一个汉字凑三十三字节";   // 11 个汉字 = 33 字节（按字符数会算 11）
  fs.writeFileSync(sibling, cjk);
  assert.equal((await dec({})).decrypt(v2Entry("jwt.cjk", sha256(cjk), "env"), V1_KEY), "jwt.cjk");
  const wide = "é".repeat(2049);          // 2049 个两字节字符 = 4098 字节，越窗
  fs.writeFileSync(sibling, wide);
  assert.equal((await dec({})).decrypt(v2Entry("jwt.wide", sha256(wide), "env"), V1_KEY), null);
});

/* ---------- os 源（钥匙串）：预热、冷却、失配与守恒（对 ctx 直测） ---------- */
const osDec = (ring, extra) => Q.makeHostDecryptor(Object.assign({ env: {}, credsPath: freshCreds(), keyringMod: ring.mod }, extra));

test("取钥契约：service 与 account 同宿主；单飞预热；到位后解出且不再重开", async () => {
  const ring = fakeKeyring(OS_SECRET);
  const credsPath = freshCreds();
  const dec = osDec(ring, { credsPath });
  const entry = v2Entry("jwt.os", OS_KEY, "os");
  for (let i = 0; i < 5; i++) assert.equal(dec.decrypt(entry, V1_KEY), null);   // 未热：null
  assert.deepEqual(ring.opens, [{ service: "ZCode Credential Encryption", account: sha256(String(credsPath)).toString("hex"), options: { linux: { store: "secret-service" } } }]);
  await dec.ensureKey();
  assert.equal(ring.reads(), 1, "单飞：解密触发的读取与显式预热共用一次");
  assert.equal(dec.decrypt(entry, V1_KEY), "jwt.os");
  assert.equal(dec.decrypt(v2Entry("second", OS_KEY, "os"), V1_KEY), "second");
  assert.equal(ring.reads(), 1, "缓存命中零 I/O");
});

test("取不到钥：60 秒冷却内不重读，过窗由预热自然重试；坏形状同样按取不到", async () => {
  for (const bad of [null, "", "short", OS_SECRET + "A", OS_SECRET.slice(0, 42) + "!"]) {
    const ring = fakeKeyring(bad);
    const dec = osDec(ring);
    const entry = v2Entry("jwt.miss", OS_KEY, "os");
    dec.decrypt(entry, V1_KEY);
    await dec.ensureKey().catch(() => {});
    for (let i = 0; i < 4; i++) dec.decrypt(entry, V1_KEY);
    await dec.ensureKey().catch(() => {});
    assert.equal(ring.reads(), 1, "冷却内不重读：" + JSON.stringify(bad));
    dec.ctx.keyFailedAt = Date.now() - 61 * 1000;   // 过窗
    await dec.ensureKey().catch(() => {});
    assert.equal(ring.reads(), 2, "过窗重试一次");
    assert.equal(dec.decrypt(entry, V1_KEY), null);
  }
});

test("开条目抛错、读取 reject、模块缺失都只是取不到，不向上抛", async () => {
  const entry = v2Entry("jwt.err", OS_KEY, "os");
  const cases = [
    () => ({ get AsyncEntry() { throw new Error("boom"); } }),
    () => ({ getPassword: () => Promise.reject(new Error("keychain locked")) }),
    () => ({ getPassword: () => { throw new Error("sync failure"); } }),
    () => ({}),
    () => null,
  ];
  for (const mod of cases) {
    const dec = Q.makeHostDecryptor({ env: {}, credsPath: freshCreds(), keyringMod: mod() });
    assert.equal(dec.decrypt(entry, V1_KEY), null);
    await dec.ensureKey().catch(() => {});
    assert.equal(dec.decrypt(entry, V1_KEY), null);
  }
});

test("失配：拒绝解密、限频 force 重读自愈、重读失败保留旧钥、旧钥继续服务其余条目", async () => {
  const otherKey = crypto.randomBytes(32);
  const ring = fakeKeyring(OS_SECRET);
  const dec = osDec(ring);
  const good = v2Entry("jwt.good", OS_KEY, "os");
  const stale = v2Entry("jwt.stale", otherKey, "os");
  dec.decrypt(good, V1_KEY);                              // 冷启动第一拍（走失配分支）触发读取
  await settle();
  await dec.ensureKey();
  assert.equal(ring.reads(), 1);
  assert.equal(dec.decrypt(good, V1_KEY), "jwt.good");

  dec.ctx.mismatchAt = Date.now() - 61 * 1000;            // 拨过期后失配条目触发一次 force 重读
  assert.equal(dec.decrypt(stale, V1_KEY), null);
  await settle();
  assert.equal(ring.reads(), 2);
  assert.equal(dec.decrypt(good, V1_KEY), "jwt.good", "失配不清缓存：旧钥继续服务其余条目");
  dec.decrypt(stale, V1_KEY);                             // 限频窗口内：不再叠加读取
  await settle();
  assert.equal(ring.reads(), 2);

  dec.ctx.mismatchAt = Date.now() - 61 * 1000;            // 过失配限频窗，这次重读失败
  ring.mod.AsyncEntry = class { async getPassword() { throw new Error("locked"); } };
  dec.decrypt(stale, V1_KEY);
  await settle();
  assert.equal(dec.decrypt(good, V1_KEY), "jwt.good", "重读失败保留旧钥");
});

test("在途失败尊重越窗意图（retryNow）：不开新冷却窗，下一次调用立即重读", async () => {
  let release;
  const ring = fakeKeyring(() => new Promise((r) => { release = r; }));
  const dec = osDec(ring);
  const entry = v2Entry("jwt.retry", OS_KEY, "os");
  dec.decrypt(entry, V1_KEY);
  dec.ctx.retryNow = true;      // 在途读取期间用户点了刷新（v2KeyRetryNow 对 defaultDec 做的就是这个）
  release(null);                // 这次读取失败
  await settle();
  assert.equal(dec.ctx.keyFailedAt, 0, "在途失败尊重越窗意图：不开新冷却窗");
  dec.ctx.mismatchAt = 0;       // 失配限频窗也重置（v2KeyRetryNow 同款语义）
  dec.decrypt(entry, V1_KEY);   // 失配分支（缓存空）立即重读
  await settle();
  assert.equal(ring.reads(), 2);
});

test("挂住的读取不叠加（ctx.ensuring 单飞）；在途重读不冻结已缓存密钥", async () => {
  let hang;
  const ring = fakeKeyring(() => new Promise((r) => { hang = r; }));
  const dec = osDec(ring);
  const good = v2Entry("jwt.hang", OS_KEY, "os");
  dec.decrypt(good, V1_KEY);
  hang(OS_SECRET);   // 第一次读成功
  await dec.ensureKey();
  assert.equal(dec.decrypt(good, V1_KEY), "jwt.hang");
  const stale = v2Entry("jwt.stale3", crypto.randomBytes(32), "os");
  dec.ctx.mismatchAt = Date.now() - 61 * 1000;
  dec.decrypt(stale, V1_KEY);   // force 重读（这次挂住）
  for (let i = 0; i < 5; i++) dec.decrypt(stale, V1_KEY);
  await settle();
  assert.equal(ring.reads(), 2, "挂住的读取不叠加");
  assert.equal(dec.decrypt(good, V1_KEY), "jwt.hang", "在途重读不冻结已缓存密钥");
});

test("v2KeyRetryNow：defaultDec 的冷却与失配限频都被越过", async () => {
  const credsPath = freshCreds();
  const ring = fakeKeyring(null);
  Q.setDefaultDecryptCtx({ credsPath, credsDir: credDirOf(credsPath), env: {}, keyringMod: ring.mod });
  try {
    const entry = v2Entry("jwt.unlock", OS_KEY, "os");
    Q.decryptValue(entry, V1_KEY);
    await Q.ensureDefaultV2Key();
    assert.equal(ring.reads(), 1);
    Q.decryptValue(entry, V1_KEY);   // 冷却内
    await Q.ensureDefaultV2Key();
    assert.equal(ring.reads(), 1);
    Q.v2KeyRetryNow();               // 用户显式动作
    Q.decryptValue(entry, V1_KEY);
    await Q.ensureDefaultV2Key();
    assert.equal(ring.reads(), 2, "越窗后立即重读");
  } finally {
    Q.setDefaultDecryptCtx({ env: process.env });   // 还原缺省，避免影响其它用例
  }
});

/* ---------- 生产取钥路径：宿主资源目录解析（不注入 keyringMod） ---------- */
function withFakeHostKeyring(t, secret) {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-host-"));
  const pkg = path.join(resources, "app.asar", "node_modules", "@napi-rs", "keyring");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar", "package.json"), JSON.stringify({ name: "@zcode/desktop" }));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@napi-rs/keyring", main: "index.js" }));
  const bag = "__zusageFakeKeyring" + (++seq);
  globalThis[bag] = { opens: [], secret };
  fs.writeFileSync(path.join(pkg, "index.js"),
    "const bag = globalThis[" + JSON.stringify(bag) + "];\n" +
    "exports.AsyncEntry = class { constructor(service, account, options) { bag.opens.push({ service, account, options }); }\n" +
    "  async getPassword() { return bag.secret; } };\n");
  t.after(() => { delete globalThis[bag]; fs.rmSync(resources, { recursive: true, force: true }); });
  return { resources, host: globalThis[bag] };
}

test("生产取钥路径：从宿主资源目录解析 keyring 并按宿主同款参数开条目（Windows 实测链）", async (t) => {
  const { resources, host } = withFakeHostKeyring(t, OS_SECRET);
  const credsPath = freshCreds();
  const dec = Q.makeHostDecryptor({ env: {}, credsPath, resourcesDir: resources });
  const entry = v2Entry("jwt.host.keyring", OS_KEY, "os");
  assert.equal(dec.decrypt(entry, V1_KEY), null);
  await dec.ensureKey();
  assert.equal(dec.decrypt(entry, V1_KEY), "jwt.host.keyring");
  assert.deepEqual(host.opens, [{
    service: "ZCode Credential Encryption",
    account: sha256(String(credsPath)).toString("hex"),
    options: { linux: { store: "secret-service" } },
  }]);
});

test("生产取钥路径：宿主没有 keyring 依赖（3.17.x 及更早）只是取不到", async (t) => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-v2-bare-"));
  fs.mkdirSync(path.join(resources, "app.asar"), { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar", "package.json"), "{}");
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const entry = v2Entry("jwt.no.host", OS_KEY, "os");
  const dec = Q.makeHostDecryptor({ env: {}, credsPath: freshCreds(), resourcesDir: resources });
  assert.equal(dec.decrypt(entry, V1_KEY), null);
  await dec.ensureKey();
  assert.equal(dec.decrypt(entry, V1_KEY), null);
});

/* ---------- 调度链端到端（绑定 defaultDec） ---------- */
function fakeRes(status, body) {
  return { status, headers: { get: () => null }, text: async () => body };
}
const MONITOR_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";
const OK_BODY = JSON.stringify({ success: true, data: { level: "max", limits: [
  { type: "TOKENS_LIMIT", unit: 3, percentage: 26, nextResetTime: 1793176110955 },
] } });
function makeClient(t, opts) {
  const calls = [];
  const clock = { t: T0 };
  const client = Q.createQuotaClient(Object.assign({
    env: {},
    now: () => clock.t,
    fetchImpl: (url, init) => {
      calls.push({ url, headers: init.headers });
      if (url.indexOf("/api/biz/subscription/list") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ success: true, data: [] })));
      if (url.indexOf("/reset/status") >= 0) return Promise.resolve(fakeRes(200, JSON.stringify({ code: 0, success: true, data: { available_five_hour_resets: [], available_week_resets: [] } })));
      return Promise.resolve(fakeRes(200, url === MONITOR_URL ? OK_BODY : "{}"));
    },
  }, opts));
  t.after(() => { client.dispose(); Q.setDefaultDecryptCtx({ env: process.env }); });
  return { client, calls, clock };
}
const everyHeader = (calls) => calls.flatMap((c) => Object.values(c.headers || {}).map(String));

test("client: enc:v2:os——密钥未热零请求（pending 短重试），预热落定后下一拍以明文 token 发请求", async (t) => {
  const credsPath = freshCreds();
  const ring = fakeKeyring(OS_SECRET);
  const { client, calls, clock } = makeClient(t, {
    credsPath,
    readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.v2.real", OS_KEY, "os") }; throw new Error("ENOENT"); },
  });
  Q.setDefaultDecryptCtx({ credsPath, credsDir: credDirOf(credsPath), env: {}, keyringMod: ring.mod });   // 构造后再绑：客户端构造时会按自身路径重绑 defaultDec
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();                 // 预热启动（异步），本轮解密失败：not_configured + pending 短重试
  assert.equal(calls.length, 0);
  await Q.ensureDefaultV2Key();  // 预热落定
  clock.t += 1100;               // pending 的 1 秒短重试（载荷推送/心跳驱动）
  client.tick();
  await flush();                 // 请求结算异步
  assert.equal(calls.filter((c) => c.url === MONITOR_URL).length, 1);
  assert.equal(calls.filter((c) => c.url === MONITOR_URL)[0].headers.authorization, "jwt.v2.real");
  assert.equal(calls.filter((c) => c.url.indexOf("subscription/list") >= 0).length, 1);
  assert.ok(everyHeader(calls).every((v) => !v.startsWith("enc:")), "任何请求头都不带密文");
  assert.equal(client.view().sources.bigmodel.status, "ok");
  assert.equal(ring.reads(), 1);
});

test("client: 钥匙串持续取不到——冷却内 tick 不重读、零请求", async (t) => {
  const credsPath = freshCreds();
  const ring = fakeKeyring(null);
  const { client, calls } = makeClient(t, {
    credsPath,
    readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.hidden", OS_KEY, "os") }; throw new Error("ENOENT"); },
  });
  Q.setDefaultDecryptCtx({ credsPath, credsDir: credDirOf(credsPath), env: {}, keyringMod: ring.mod });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  for (let i = 0; i < 4; i++) { client.tick(); await Q.ensureDefaultV2Key(); }
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(ring.reads(), 1, "冷却内（memoize+60s）不重读");
  const entry = client.view().sources.bigmodel;
  assert.ok(entry && entry.status === "not_configured" && entry.reason === "decrypt");
});

test("client: 凭据变更与手动刷新都越过冷却（v2KeyRetryNow 接线）", async (t) => {
  for (const kick of [(c) => c.credentialsChanged(), (c) => c.refresh(), (c) => c.refreshSource("bigmodel")]) {
    const credsPath = freshCreds();
    const ring = fakeKeyring(null);   // 先取不到，解锁后可取
    const { client, calls, clock } = makeClient(t, {
      credsPath,
      readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("jwt.unlock2", OS_KEY, "os") }; throw new Error("ENOENT"); },
    });
    Q.setDefaultDecryptCtx({ credsPath, credsDir: credDirOf(credsPath), env: {}, keyringMod: ring.mod });
    client.noteProvider("account:bigmodel-individual-coding-plan");
    client.tick();
    await Q.ensureDefaultV2Key();
    assert.equal(ring.reads(), 1);
    ring.setSecret(OS_SECRET);        // 钥匙串解锁了
    kick(client);                     // 例如用户点了刷新（v2KeyRetryNow 已把冷却/失配窗清零）
    clock.t += 1100;
    client.tick();                    // 这一拍触发越窗重读，密钥在途 → 解密仍失败（pending 1s）
    await Q.ensureDefaultV2Key();     // 重读落定
    assert.equal(ring.reads(), 2, "越窗立即重读");
    clock.t += 1100;
    client.tick();                    // 下一拍以明文 token 发请求
    await flush();
    await flush();
    const monitor = calls.filter((c) => c.url === MONITOR_URL);
    assert.equal(monitor.length, 1);
    assert.equal(monitor[0].headers.authorization, "jwt.unlock2");
  }
});

test("client: 密钥到位但 token 临期——离开未配置态，不残留 decrypt 失败", async (t) => {
  const credsPath = freshCreds();
  const soon = Buffer.from(JSON.stringify({ exp: Math.floor((T0 + 30 * 1000) / 1000) })).toString("base64url");
  const { client, clock } = makeClient(t, {
    credsPath,
    readFile: (p) => { if (p === credsPath) return { "oauth:bigmodel:access_token": v2Entry("h." + soon + ".s", OS_KEY, "os") }; throw new Error("ENOENT"); },
  });
  Q.setDefaultDecryptCtx({ credsPath, credsDir: credDirOf(credsPath), env: {}, keyringMod: fakeKeyring(OS_SECRET).mod });
  client.noteProvider("account:bigmodel-individual-coding-plan");
  client.tick();
  await Q.ensureDefaultV2Key();
  clock.t += 1100;
  client.tick();
  await flush();
  const v = client.view().sources.bigmodel;
  assert.equal(v.status, "idle");   // 不是 not_configured：临期早退发生在状态迁移之后
  assert.equal(v.reason, "");
  assert.ok(!v.lastError, "不残留 decrypt 失败文案");
});

test("client: zcode-start 链（zcodejwttoken）与重置卡链解 enc:v2，请求头都是明文", async (t) => {
  const credsPath = freshCreds();
  const dir = credDirOf(credsPath);
  const { client, calls, clock } = makeClient(t, {
    env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET }, credsPath,
    resetEnabled: () => true,
    readFile: (p) => {
      if (p === credsPath) return {
        zcodejwttoken: v2Entry("start.v2.jwt", ENV_KEY, "env"),
        "oauth:bigmodel:access_token": v2Entry("oauth.v2.tok", ENV_KEY, "env"),
      };
      if (p === path.join(dir, "telemetry-state.json")) return { deviceMid: "0123456789abcdef0123456789abcdef" };
      throw new Error("ENOENT");
    },
  });
  Q.setDefaultDecryptCtx({ credsPath, credsDir: dir, env: { ZCODE_CREDENTIAL_SECRET: ENV_SECRET } });
  client.noteProvider("account:bigmodel-start-plan");
  client.setProviders(["account:bigmodel-start-plan"]);
  client.tick();
  await Q.ensureDefaultV2Key();
  clock.t += 1100;
  client.tick();
  await flush();
  await flush();
  const start = calls.filter((c) => c.url === "https://zcode.z.ai/api/v1/zcode-plan/billing/balance");
  assert.equal(start.length, 1);
  assert.equal(start[0].headers.authorization, "Bearer start.v2.jwt");
  assert.equal(start[0].headers["X-Device-Mid"], "0123456789abcdef0123456789abcdef");
  const status = calls.filter((c) => c.url.indexOf("/api/v1/coding-plan/reset/status") >= 0);
  assert.ok(status.length >= 1, "重置卡链发出请求");
  for (const c of status) {   // 两拍可能在途守卫结算前各触发一次：每一次都必须是明文凭据
    assert.equal(c.headers.authorization, "Bearer start.v2.jwt");
    assert.equal(c.headers["X-Bigmodel-Authorization"], "oauth.v2.tok");
  }
  assert.ok(everyHeader(calls).every((v) => !v.startsWith("enc:")));
});

/* ---------- 第四轮补口 ---------- */
test("v2KeyRetryNow 的在途分支：读取成功也消费越窗意图，下一次无关失败仍进冷却", async () => {
  let release;
  const ring = fakeKeyring(() => new Promise((r) => { release = r; }));
  const dec = osDec(ring);
  const good = v2Entry("jwt.consume", OS_KEY, "os");
  const bad = v2Entry("jwt.consume2", crypto.randomBytes(32), "os");
  dec.decrypt(good, V1_KEY);              // 在途
  dec.ctx.retryNow = true;                // 在途期间用户点了刷新（v2KeyRetryNow 的 ensuring 分支语义）
  release(OS_SECRET);                     // 这次读取成功
  await settle();
  assert.equal(dec.ctx.retryNow, false, "成功路径同样消费 retryNow");
  assert.equal(dec.decrypt(good, V1_KEY), "jwt.consume");
  dec.ctx.keyFailedAt = Date.now();       // 之后一次无关失败（如钥匙串刚被锁）
  dec.decrypt(bad, V1_KEY);               // 失配 force 被冷却压制
  await settle();
  assert.ok(dec.ctx.keyFailedAt > 0, "无关失败正常进冷却，不被残留意图放行");
});
