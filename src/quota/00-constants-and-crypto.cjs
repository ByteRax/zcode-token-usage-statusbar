/* 额度客户端（主进程热换模块）v3：多厂商适配器 + 多源调度器。
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

/* ---------- 宿主凭据解密（enc:v1 AES-256-GCM，按宿主语义重写） ---------- */
function deriveSecret(env) {
  const conf = env.ZCODE_CREDENTIAL_SECRET;
  if (conf) return conf;
  let username = "unknown";
  try { username = os.userInfo().username; } catch (e) { /* 拿不到用户名按占位 */ }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}
function deriveCipherKey(env) { return crypto.createHash("sha256").update(deriveSecret(env)).digest(); }
function decryptValue(value, key) {
  if (typeof value !== "string") return value;
  /* 只解 enc:v1。无前缀明文原样返回；其它 enc:* 代际一律 null——原先对非 v1 值原样返回，
   * enc:v2 密文会被调用方当成明文 token 外发（宿主对未知前缀同款拒绝）。 */
  if (!value.startsWith(ENC_PREFIX)) return value.startsWith("enc:") ? null : value;
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

/* ---------- 宿主凭据解密（enc:v2，宿主 3.18.0 起） ----------
 * 形状 enc:v2:<os|env>:<keyId>:<payload>：仍 AES-256-GCM，payload 为三段 base64url(iv.tag.ct)
 * 点分隔；keyId = sha256(key) hex 前 24 字符，与所取密钥不符即拒（防拿错钥解出垃圾）。
 *   os  = 密钥在系统钥匙串（service "ZCode Credential Encryption"、account =
 *         sha256hex(绝对化 credentials.json 路径)）。取钥走宿主自带的 @napi-rs/keyring：
 *         宿主主进程自己就是这样读写该条目的，本模块跑在同一进程内、访问身份与宿主相同，
 *         不经外部命令、不改条目的访问控制。取钥是异步的：未就绪时本次按解密失败降级，
 *         到位后经 hostKeyWaiters 唤醒调度器重评；取不到或与条目 keyId 不符时
 *         HOST_KEY_RETRY_MS 内不重取（已有的密钥不因一次失败被清掉），单次读取有超时兜底。
 *         宿主无该依赖（3.17.x 及更早）或加载失败一律取不到。
 *         Windows/Linux 走同一条链，未实机验证。
 *   env = 宿主 managed secret，来源序同宿主：ZCODE_CREDENTIAL_SECRET →
 *         ZCODE_CREDENTIAL_SECRET_FILE（两者同配按不可用）→ 凭据同目录 credential-secret
 *         （非 win32 须仅属主可读写）；文件须为常规文件、32–4096 字节；key = sha256(secret)。
 *         按条目声明的源取钥并以 keyId 把关，不像宿主那样再要求它等于当前环境解析出的源。
 * 密钥只在内存，不进日志/诊断。 */
const ENC_V2_PREFIX = "enc:v2:";
const KEYRING_SERVICE = "ZCode Credential Encryption";
const HOST_KEY_RETRY_MS = 5 * 60 * 1000;    // 取不到或与条目 keyId 不符后的重取间隔
const HOST_KEY_TIMEOUT_MS = 30 * 1000;      // 单次读取的兜底：钥匙串被锁等情况下不让在途状态永久占住
const hostKeys = new Map();         // credsPath → { key, keyId, at, flight }（模块级：额度与模型拉取共用，热换即重置）
const hostKeyWaiters = new Set();   // 密钥到位回调 (credsPath) => void：各 client 创建时注册、dispose 时注销
function v2KeyIdOf(key) { return crypto.createHash("sha256").update(key).digest("hex").slice(0, 24); }
function v2SecretFile(file, ownerOnly) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4096 || (ownerOnly && process.platform !== "win32" && (st.mode & 63) !== 0)) return null;
    const text = fs.readFileSync(file, "utf8");
    const size = Buffer.byteLength(text, "utf8");
    return size >= 32 && size <= 4096 ? text : null;
  } catch (e) { return null; }
}
function v2EnvKey(env, credsPath) {
  const direct = env.ZCODE_CREDENTIAL_SECRET, file = env.ZCODE_CREDENTIAL_SECRET_FILE;
  if (direct && file) return null;   // 宿主互斥语义：双配视为不可用，不猜取哪个
  let secret = direct || null;
  if (!secret && file) secret = v2SecretFile(file, false);   // 显式指定的文件宿主不查权限位
  else if (!secret && typeof credsPath === "string" && credsPath) {
    secret = v2SecretFile(path.join(path.dirname(path.resolve(credsPath)), "credential-secret"), true);
  }
  return secret ? crypto.createHash("sha256").update(secret).digest() : null;
}
/* 宿主自己的钥匙串条目句柄（宿主 getEntry 同款参数）。按宿主的依赖解析方式取包：桌面主
 * 程序已加载过它，这里拿到的是同一份模块。非 Electron 环境（CLI、测试）没有宿主资源目录。 */
function hostKeyringEntry(service, account) {
  const resources = process.resourcesPath;
  if (!resources) return null;
  const hostRequire = require("module").createRequire(path.join(resources, "app.asar", "package.json"));
  const { AsyncEntry } = hostRequire("@napi-rs/keyring");
  return new AsyncEntry(service, account, { linux: { store: "secret-service" } });
}
/* 清掉某凭据路径的取钥重试窗口（在途读取不受影响）：用户点「立即刷新」或凭据文件变更时调用，
 * 让下一次凭据重评可以马上再读一次钥匙串。 */
function hostKeyRetryNow(credsPath) {
  const st = hostKeys.get(credsPath);
  if (!st) return;
  st.at = 0;
  if (st.flight) st.retryNow = true;   // 在途读取稍后失败时不重开窗口
}
/* 同步门面：缓存里有与条目 keyId 相符的密钥就返回；否则发起一次异步取钥（单飞）并返回 null。
 * 每次载荷推送都会经 resolveCred 走到这里，所以除首次与重试窗口外不得读钥匙串。 */
function hostOsKey(j, keyId) {
  const credsPath = j.credsPath;
  if (typeof credsPath !== "string" || !credsPath) return null;
  let st = hostKeys.get(credsPath);
  if (!st) { st = { key: null, keyId: "", at: 0, flight: false, retryNow: false }; hostKeys.set(credsPath, st); }
  if (st.key && st.keyId === keyId) return st.key;
  if (st.flight) return null;
  const clock = typeof j.now === "function" ? j.now : Date.now;
  if (st.at) {
    const since = clock() - st.at;
    if (since < 0) st.at = clock() || 1;   // 时钟回拨：从现在重新计窗，既不立即重取也不无限期推迟
    if (since < HOST_KEY_RETRY_MS) return null;
  }
  const log = typeof j.log === "function" ? j.log : null;
  let settled = false, timer = null;
  const settle = (secret, why) => {
    if (settled) return;   // 每次读取只结算一次
    settled = true;
    if (timer) clearTimeout(timer);
    const raw = typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(secret) ? Buffer.from(secret, "base64url") : null;   // 宿主同款形状：base64url 43 字符 = 32 字节
    const fresh = raw && raw.length === 32 ? raw : null;
    st.at = st.retryNow ? 0 : (clock() || 1);   // 在途期间被要求重试（手动刷新/凭据变更）：失败后不开新窗口
    st.retryNow = false;
    st.flight = false;
    if (!fresh) {   // 这次没取到：已有的密钥照旧可用，不清
      if (log) log("host credential key unavailable:", why);
      return;
    }
    const freshId = v2KeyIdOf(fresh);
    const changed = !st.key || st.keyId !== freshId;
    st.key = fresh;
    st.keyId = freshId;
    if (!changed) return;   // 取到的还是同一把钥：没有新信息，不唤醒
    for (const wake of Array.from(hostKeyWaiters)) {
      if (!hostKeyWaiters.has(wake)) continue;   // 遍历途中被注销的 client 不再唤醒
      try { wake(credsPath); } catch (e) { /* 单个 client 的唤醒异常不连累其它 */ }
    }
  };
  let entry = null;
  try {
    const open = typeof j.keyringEntry === "function" ? j.keyringEntry : hostKeyringEntry;
    entry = open(KEYRING_SERVICE, crypto.createHash("sha256").update(path.resolve(credsPath)).digest("hex"));
  } catch (e) { entry = null; }
  if (!entry || typeof entry.getPassword !== "function") { settle(null, "keyring module unavailable"); return null; }
  st.flight = true;
  /* 软超时：钥匙串读取走 libuv 线程池（宿主 keyring 原生模块没有取消口），挂住的读取释不掉也
   * 取消不了。超时只留日志，在途标志保持——真正落定前绝不叠加新读取（每次挂住各占一个线程池
   * 线程，叠加会占满宿主主进程的异步容量），迟到结果照常采纳、失败后照常进重试窗。 */
  timer = setTimeout(() => {
    if (settled) return;
    if (log) log("host credential key read timed out; waiting for it to settle");
  }, Number.isFinite(j.keyTimeoutMs) ? j.keyTimeoutMs : HOST_KEY_TIMEOUT_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
  let pending;
  try { pending = Promise.resolve(entry.getPassword()); } catch (e) { pending = Promise.reject(e); }
  pending.then((secret) => settle(secret, secret == null ? "no keychain entry" : "malformed value"), () => settle(null, "read failed"));
  return null;
}
function v2Open(payload, key) {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) return null;
  let iv, tag, ct;
  try {
    iv = Buffer.from(parts[0], "base64url");
    tag = Buffer.from(parts[1], "base64url");
    ct = Buffer.from(parts[2], "base64url");
  } catch (e) { return null; }
  if (!ct.length || iv.length !== 12 || tag.length !== 16) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch (e) { return null; }
}
/* 宿主凭据统一解密入口：无前缀明文原样返回；enc:v1 走旧链；enc:v2 按 os/env 源取钥；
 * 其它 enc:* 代际返回 null。j 需带 env 与 credsPath；可选 now、log、keyringEntry、
 * keyTimeoutMs 注入（后两个主要供测试）。 */
function decryptHostCredential(value, j) {
  if (typeof value !== "string" || !value.startsWith("enc:")) return value;
  j = j || {};
  const env = j.env || {};
  if (value.startsWith(ENC_PREFIX)) return decryptValue(value, deriveCipherKey(env));
  if (!value.startsWith(ENC_V2_PREFIX)) return null;
  const parts = value.slice(ENC_V2_PREFIX.length).split(":");
  if (parts.length !== 3 || (parts[0] !== "os" && parts[0] !== "env") || !/^[a-f0-9]{24}$/.test(parts[1])) return null;
  const key = parts[0] === "env" ? v2EnvKey(env, j.credsPath) : hostOsKey(j, parts[1]);
  if (!key || v2KeyIdOf(key) !== parts[1]) return null;
  return v2Open(parts[2], key);
}

