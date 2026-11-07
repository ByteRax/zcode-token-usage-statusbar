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
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) return value;
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

