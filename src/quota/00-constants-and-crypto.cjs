/* 额度客户端（主进程，冷文件）v3：多厂商适配器 + 多源调度器。
 * 阶段 3（浮层 v96 线）：BigModel/Z.ai 内置套餐（解密宿主 OAuth 凭据直查 monitor 端点）
 * 之外，新增零配置官方域适配器（MiniMax/Kimi/CommandCode/DeepSeek/OpenRouter/SiliconFlow/
 * Anthropic OAuth）与显式配置适配器（Cline/MiMo Cookie/火山 AK-SK/SCNet 账本）。
 *
 * 调度语义：enabled 源全量低频刷新（供 tooltip 分家列全），chip 主显跟随本 pane 会话的
 * 模型归属（primary 源）。每源独立 nextAt/epoch/退避/凭据指纹；凭据只在内存，不落盘、
 * 不进日志与诊断；诊断只记 status/HTTP code/错误摘要；key 只发各适配器声明的域。
 *
 * 凭据发现优先级（契约）：环境变量 → quota-secrets.json（运行目录 0600）→ 自动发现
 * （宿主 provider_config.json 的自定义供应商 key；Anthropic 另读 ~/.claude/.credentials.json）。
 * 源码转写声明：MiniMax/Kimi/CommandCode/Cline/MiMo/火山/SCNet 的端点与字段转写自
 * dsh-cost-meter 与 cc-switch（MIT），其中无真实账号实测的家在适配器上标注 unverified。
 *
 * 输出协议：view() = { active, sources: {id: entry} }；为兼容本版浮层，active 源的
 * 字段同时镜像到顶层（下版移除）。entry 形状与 v96 单源一致（status/windows/tools/
 * models/level/plan/balance/stale/...），balance 扩展 parts[]（赠送/充值拆分）。 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ENC_PREFIX = "enc:v1:";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const TTL_MS = 10 * 60 * 1000;            // 套餐窗默认（对齐宿主 usageEntitlementCache）
const TTL_BALANCE_MS = 15 * 60 * 1000;    // 余额默认（dsh 同款）
const FETCH_TIMEOUT_MS = 10 * 1000;
const BODY_LIMIT = 256 * 1024;
const BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 10 * 60 * 1000];
const PARSE_BACKOFF_MS = 30 * 60 * 1000;
const NOT_CONFIGURED_RETRY_MS = 60 * 1000;
const EXP_SOON_MS = 2 * 60 * 1000;
const EXP_RETRY_MS = 5 * 60 * 1000;
/* v135 重置卡（coding plan reset opportunity）：独立只读链，不复用 sources 调度器。
 * 与额度 monitor 是两条链——卡是账号级「立即恢复额度池」的核销机会，每张带 expire_at。 */
const RESET_PATH = "/api/v1/coding-plan/reset/status";
const RESET_TTL_MS = 5 * 60 * 1000;       // 对齐宿主 STATUS_POLL_INTERVAL_MS
const RESET_PARSE_BACKOFF_MS = 15 * 60 * 1000;

/* ---------- 基础工具 ---------- */
function sha16(v) { return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 16); }
function qErr(code, message, extra) {
  return Object.assign(new Error(message), Object.assign({ code }, extra || {}));
}
function clampPct(x) { return Number.isNaN(x) ? 0 : Math.max(0, Math.min(100, x)); }   // NaN→0 防御；±Infinity 按钳制方向处理（超限→100，fail-closed）
/* 团队套餐 id 判定：词边界匹配，含 "team" 子串的普通 id（如假想的 steam-promo）不误判 */
function isTeamProviderId(p) { return /(^|[-:])team([-:]|$)/.test(String(p || "")); }
function parseRetryAfterMs(v) {
  if (v == null) return null;
  const sec = Number(v);
  if (isFinite(sec) && sec >= 0) return Math.min(Math.max(sec * 1000, 30 * 1000), 10 * 60 * 1000);
  return 60 * 1000;
}
function jwtExpMs(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" && json.exp > 0 ? json.exp * 1000 : null;
  } catch (e) { return null; }
}

/* ---------- 宿主凭据解密（enc:v1 / enc:v2 双信封，按宿主语义重写） ---------- */
function deriveSecret(env) {
  const conf = env.ZCODE_CREDENTIAL_SECRET;
  if (conf) return conf;
  let username = "unknown";
  try { username = os.userInfo().username; } catch (e) { /* 拿不到用户名按占位 */ }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}
function deriveCipherKey(env) { return crypto.createHash("sha256").update(deriveSecret(env)).digest(); }
function decryptV1Value(value, key) {
  if (typeof value !== "string") return value;
  /* 未知 enc: 版本按宿主 legacy 语义拒绝（null）：绝不把密文当明文 token 外发 */
  if (value.startsWith("enc:") && !value.startsWith(ENC_PREFIX)) return null;
  if (!value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] === undefined) return null;
  let iv, tag, ct;
  try {
    iv = Buffer.from(parts[0], "base64url");
    tag = Buffer.from(parts[1], "base64url");
    ct = Buffer.from(parts[2], "base64url");
  } catch (e) { return null; }
  if (iv.length !== 12 || tag.length !== 16) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch (e) { return null; }
}

/* ---------- v2 信封（宿主 3.18.0）：enc:v2:{os|env}:{keyId24}:{iv.tag.ct} ----------
 * 密钥是 32 字节随机值，OS 源存宿主 OS 凭据库（service "ZCode Credential Encryption"，
 * account=sha256(resolve(credentials.json)).hex），env 源=sha256(受管 secret)。信封内
 * keyId24=sha256(key).hex 前 24 位，解密前先比对指纹：密钥不在/换钥一律 null，绝不跨钥强解。
 * keychain 读取异步而解密调用点全同步：ensureKey() 异步预热缓存，decrypt 同步读缓存；
 * 未热/失配时置 pending 供调度器用 1 秒短重试（区别于真解密失败的 60 秒）。 */
const ENC_V2_PFX = "enc:v2:";
const V2_SERVICE = "ZCode Credential Encryption";
const V2_KEY_RE = /^[A-Za-z0-9_-]{43}$/;   // 32 字节 base64url（无填充）

function keyIdOf(key) { return crypto.createHash("sha256").update(key).digest("hex").slice(0, 24); }

function openV2Seal(seal, key) {
  const parts = seal.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] === undefined) return null;
  let iv, tag, ct;
  try {
    iv = Buffer.from(parts[0], "base64url");
    tag = Buffer.from(parts[1], "base64url");
    ct = Buffer.from(parts[2], "base64url");
  } catch (e) { return null; }
  if (iv.length !== 12 || tag.length !== 16) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch (e) { return null; }
}

/* 负缓存按 resourcesDir 分桶：一次空 dir/失败探测不再拖累其它目录（热换重建前的自愈路径） */
const hostKeyringByDir = new Map();
function loadHostKeyring(resourcesDir) {
  const dir = String(resourcesDir || "");
  if (!dir) return null;
  if (hostKeyringByDir.has(dir)) return hostKeyringByDir.get(dir);
  let mod = null;
  const tries = [];
  /* asar 内 wrapper（Electron fs 透传把 .node 指到 unpacked）；直接 require 失败不影响后续 */
  tries.push(() => require(path.join(dir, "app.asar", "node_modules", "@napi-rs", "keyring")));
  try {   // unpacked 原生 .node 兜底：扫描 @napi-rs/keyring-<triple> 目录
    const scope = path.join(dir, "app.asar.unpacked", "node_modules", "@napi-rs");
    for (const name of fs.readdirSync(scope)) {
      if (!/^keyring-/.test(name)) continue;
      const pdir = path.join(scope, name);
      for (const f of fs.readdirSync(pdir)) {
        if (f.endsWith(".node")) tries.push(((p, f2) => () => require(path.join(p, f2)))(pdir, f));
      }
    }
  } catch (e) { /* 无 unpacked 目录/受限读取 */ }
  for (const t of tries) {
    try {
      const m = t();
      if (m && (m.AsyncEntry || m.Entry)) { mod = m; break; }
    } catch (e) { /* 下一候选 */ }
  }
  hostKeyringByDir.set(dir, mod);
  return mod;
}

/* 受管 secret（v2:env 源）：镜像宿主 resolveManagedSecret——ZCODE_CREDENTIAL_SECRET env
 * → ZCODE_CREDENTIAL_SECRET_FILE env 指向的文件（不校验权限位，内容 32–4096 字节在 ensureV2Key 判）
 * → 凭据同目录 credential-secret（宿主在无 os 标记时以它派生 env 源：headless 部署靠它；常规文件、
 *   非 win32 须仅属主可读写、32–4096 字节）。前两者同设按配置错误处理（宿主同款 throw）。 */
function readManagedSecret(ctx) {
  const env = ctx.env || {};
  if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) { ctx.lastError = "managed secret misconfigured"; return null; }
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  if (env.ZCODE_CREDENTIAL_SECRET_FILE) {
    try { return (ctx.readFileRaw || ((p) => fs.readFileSync(p, "utf8")))(env.ZCODE_CREDENTIAL_SECRET_FILE); }
    catch (e) { ctx.lastError = "managed secret file unreadable"; return null; }
  }
  if (ctx.credsDir) {
    try {
      const p = path.join(ctx.credsDir, "credential-secret");
      const st = fs.statSync(p);
      if (st.isFile() && st.size >= 32 && st.size <= 4096 &&
          (process.platform === "win32" || (st.mode & 63) === 0)) {
        return (ctx.readFileRaw || ((q) => fs.readFileSync(q, "utf8")))(p);
      }
    } catch (e) { /* 无固定路径文件或不可读：按未配置 */ }
  }
  return null;
}

async function ensureV2Key(ctx, force) {
  const cur = ctx.cache.get(ctx.credsPath) || null;
  if (cur && !force) return cur;   // 已热：不重读 keychain/secret（换钥由 decrypt 侧 keyId 失配限频 force 重读）
  if (ctx.keyFailedAt && Date.now() - ctx.keyFailedAt < 60000) return cur;   // 失败冷却：keychain 缺失时不做 1 秒风暴重试
  ctx.lastError = "";   // 只反映最近一次尝试，不跨调用短路
  const env = ctx.env || process.env;
  let secret = readManagedSecret(ctx), source = "";
  if (ctx.lastError) { ctx.keyFailedAt = ctx.retryNow ? 0 : Date.now(); ctx.retryNow = false; return cur; }   // 受管 secret 配置错误：与 keychain 失败同冷却
  let key;
  if (secret !== null) {
    /* 宿主 X1n：env 源密钥 = sha256(受管 secret) 原始 32 字节，对 secret 无 base64url 形状要求；
     * 文件路径的宿主校验是内容 32–4096 字节。 */
    const blen = Buffer.byteLength(secret, "utf8");
    if (env.ZCODE_CREDENTIAL_SECRET_FILE && (blen < 32 || blen > 4096)) { ctx.lastError = "managed secret file length invalid"; ctx.keyFailedAt = Date.now(); return cur; }
    key = crypto.createHash("sha256").update(secret).digest();
    source = "env";
  } else {
    const mod = ctx.keyringMod !== undefined ? ctx.keyringMod : loadHostKeyring(ctx.resourcesDir);
    if (!mod || !(mod.AsyncEntry || mod.Entry)) { ctx.lastError = "host keyring unavailable"; return cur; }
    try {
      const E = mod.AsyncEntry || mod.Entry;
      const account = crypto.createHash("sha256").update(String(ctx.credsPath)).digest("hex");
      secret = await new E(V2_SERVICE, account, { linux: { store: "secret-service" } }).getPassword();
    } catch (e) { ctx.lastError = "keychain read failed"; ctx.keyFailedAt = ctx.retryNow ? 0 : Date.now(); ctx.retryNow = false; return cur; }
    source = "os";
    if (typeof secret !== "string" || !V2_KEY_RE.test(secret)) { ctx.lastError = "key shape invalid"; ctx.keyFailedAt = ctx.retryNow ? 0 : Date.now(); ctx.retryNow = false; return cur; }
    key = Buffer.from(secret, "base64url");
    if (key.length !== 32) { ctx.lastError = "key length invalid"; ctx.keyFailedAt = ctx.retryNow ? 0 : Date.now(); ctx.retryNow = false; return cur; }
  }
  const ent = { key, keyId: keyIdOf(key), source };
  ctx.cache.set(ctx.credsPath, ent);   // 重读成功才覆盖：失败路径不清旧钥（旧条目继续可解）
  ctx.lastError = "";
  ctx.keyFailedAt = 0;
  return ent;
}

function makeHostDecryptor(opts) {
  const o = opts || {};
  const ctx = {
    credsPath: o.credsPath || "",
    credsDir: o.credsDir || "",
    resourcesDir: o.resourcesDir !== undefined ? o.resourcesDir : ((typeof process !== "undefined" && process.resourcesPath) || ""),
    env: o.env || process.env,
    readFileRaw: o.readFileRaw,
    keyringMod: o.keyringMod,   // undefined=自动探测；null/对象=显式指定（测试注入）
    cache: new Map(), lastError: "", pending: 0, ensuring: null, keyFailedAt: 0, mismatchAt: 0, retryNow: false,
  };
  function ensureKey(force) {
    if (ctx.ensuring) return ctx.ensuring;
    ctx.ensuring = ensureV2Key(ctx, force).finally(() => { ctx.ensuring = null; ctx.pending = 0; });
    return ctx.ensuring;
  }
  function decrypt(enc, legacyKey) {
    if (typeof enc !== "string") return enc;
    if (!enc.startsWith(ENC_V2_PFX)) return decryptV1Value(enc, legacyKey);
    const parts = enc.slice(ENC_V2_PFX.length).split(":");
    if (parts.length !== 3 || !/^(os|env)$/.test(parts[0]) || !/^[a-f0-9]{24}$/.test(parts[1])) return null;
    const ent = ctx.cache.get(ctx.credsPath);
    if (!ent || parts[0] !== ent.source || parts[1] !== ent.keyId) {
      /* 缓存钥与信封不符（宿主换钥/残留旧条目）：不清缓存（重读失败会把仍可解的条目一起打死，
       * 整桶最长 60 秒不可用），限频 force 重读自愈 */
      const now = Date.now();
      if (!ctx.mismatchAt || now - ctx.mismatchAt >= 60000) {
        ctx.mismatchAt = now;
        try { void ensureKey(true); } catch (e) { /* 同步段不抛 */ }
      }
      if (!ctx.keyFailedAt) ctx.pending = 1;   // 失败冷却期内不置位：调度器回退 60 秒，防 1 秒风暴
      return null;
    }
    return openV2Seal(parts[2], ent.key);
  }
  return { ctx, ensureKey, decrypt, keyPending: () => !!ctx.pending };
}

/* 导出的 decryptValue 分发器：v2 信封走缺省宿主解密器（调用方无需感知上下文与缓存），
 * v1/明文维持原 (value, key) 语义。客户端装配时 setDefaultDecryptCtx 绑定真实路径。 */
let defaultDec = makeHostDecryptor({ env: process.env });
function setDefaultDecryptCtx(opts) { defaultDec = makeHostDecryptor(opts || {}); }
function ensureDefaultV2Key() { return defaultDec.ensureKey(); }
function v2KeyPending() { return defaultDec.keyPending(); }
/* 用户显式动作（chip 立即刷新/凭据变更/拉取模型点击）越过 v2 密钥的失败冷却与失配限频，
 * 对齐「点击立即刷新绕过一切间隔与冻结」；在途读取稍后失败时不开新冷却窗。 */
function v2KeyRetryNow() {
  const ctx = defaultDec.ctx;
  if (ctx.ensuring) { ctx.retryNow = true; return; }
  ctx.keyFailedAt = 0;
  ctx.mismatchAt = 0;
}
function decryptValue(value, key) {
  if (typeof value === "string" && value.startsWith(ENC_V2_PFX)) return defaultDec.decrypt(value, key);
  return decryptV1Value(value, key);
}

