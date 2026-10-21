/* v96 额度客户端（主进程，冷文件）：BigModel / Z.ai 个人编码套餐的套餐池额度查询。
 * 数据链：解密宿主 OAuth 凭据（~/.zcode/v2/credentials.json 的 enc:v1 AES-256-GCM，
 * 算法按宿主 credentialCipherProvider 语义重写）→ 裸 authorization 直查
 * {origin}/api/monitor/usage/quota/limit → 归一化窗口 → inject-main 附加进快照。
 *
 * 口径（P0 实测 2026-10-20 + cc-switch/dsh 交叉核对）：
 *  - limits[] 仅收 TOKENS_LIMIT/CREDIT_LIMIT（type 大小写不敏感）；窗口按 unit 显式分类
 *    （3=5 小时、6=周），不按 nextResetTime 排序代替——周期末尾周窗会先于 5h 窗重置，
 *    时间排序必把两桶标反（cc-switch issue #3036）；unit 缺失的条目兜底补位（无重置时间
 *    的优先归 5h），未知数值 unit 丢弃并留痕，绝不猜映射。
 *  - TIME_LIMIT（unit=5）是内置工具调用期（usage=总额度次数、currentValue=已用），
 *    折叠为 tools 行，不参与 chip 主数字。
 *  - percentage 是整数已用 %（服务端精度粗）；有绝对量时用 currentValue/usage 自算。
 *  - 无套餐是业务信封 {"code":500,"msg":"…不存在coding plan","success":false}，不是 401。
 *
 * 凭据纪律：token 只在本模块与请求头之间流转；不落盘、不进日志/诊断/配置；
 * 诊断只记 status/HTTP code/错误摘要。401/403 与无套餐冻结到凭据指纹变化
 * （inject-main 监听 credentials.json 变化后调 credentialsChanged 解冻重试）。
 * 远端会话同账号（宿主 provisioning 把桌面凭据强制同步到远端并覆盖），无需远端查询。 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ENC_PREFIX = "enc:v1:";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const TTL_MS = 10 * 60 * 1000;            // 对齐宿主 usageEntitlementCache 的 10min
const FETCH_TIMEOUT_MS = 10 * 1000;
const BODY_LIMIT = 256 * 1024;            // dsh readJsonBounded 同款上限
const BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 10 * 60 * 1000];
const PARSE_BACKOFF_MS = 30 * 60 * 1000;  // 响应结构变化：长退避 + 诊断，不高频打接口
const NOT_CONFIGURED_RETRY_MS = 60 * 1000; // 未登录：低频探测登录状态
const EXP_SOON_MS = 2 * 60 * 1000;        // OAuth token 临期窗口
const EXP_RETRY_MS = 5 * 60 * 1000;       // 临期不发请求，等宿主刷新后重读

const FAMILIES = {
  bigmodel: {
    credKey: "oauth:bigmodel:access_token",
    origin: "https://bigmodel.cn",
    bearer: false,                        // bigmodel family 裸 authorization（宿主与 P0 实测一致）
    envKeys: ["ZCODE_BIGMODEL_USAGE_API_KEY", "BIGMODEL_USAGE_API_KEY"],
    envUrl: "ZCODE_BIGMODEL_USAGE_QUOTA_URL",
    subPath: "/api/biz/subscription/list",   // 订阅元数据（version/productName/valid，宿主同款端点）
  },
  zai: {
    credKey: "oauth:zai:access_token",
    origin: "https://api.z.ai",
    bearer: true,                         // zai family 套 Bearer（宿主同款；未实测，401 即冻结待核对）
    envKeys: [],
    envUrl: "",
    subPath: null,                        // 订阅元数据暂只接 BigModel（用户需求）；zai 需要时再加
  },
};

function sha16(v) { return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 16); }

function deriveSecret(env) {
  const conf = env.ZCODE_CREDENTIAL_SECRET;
  if (conf) return conf;
  let username = "unknown";
  try { username = os.userInfo().username; } catch (e) { /* 部分环境拿不到用户名 */ }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}
function deriveCipherKey(env) { return crypto.createHash("sha256").update(deriveSecret(env)).digest(); }

/* enc:v1:<b64url(iv)>.<b64url(tag)>.<b64url(ct)>，AES-256-GCM、IV 12B、tag 16B。
 * 非密文原样返回（宿主语义）；格式/解密失败返回 null（调用方 fail-closed，绝不猜）。 */
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

/* 本地预检 JWT 过期（不校验签名，只读 exp）：临期/过期不发请求，避免白打 401。
 * 非 JWT（opaque token）返回 null，正常发请求。 */
function jwtExpMs(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" && json.exp > 0 ? json.exp * 1000 : null;
  } catch (e) { return null; }
}

function qErr(code, message, extra) {
  return Object.assign(new Error(message), Object.assign({ code }, extra || {}));
}

function isNoPlanMessage(msg) {
  const m = String(msg || "").toLowerCase();
  const compact = m.replace(/[\s_-]/g, "");
  return compact.indexOf("codingplan") >= 0 &&
    ["不存在", "没有", "未开通", "not exist", "not found", "not have", "doesn't have", "no coding plan", "not subscribed"]
      .some((kw) => m.indexOf(kw) >= 0);
}

/* 模型 provider 段 → 查询目标。返回 null = MVP 不支持的 provider（自定义/未知，
 * chip 隐藏）；{unsupported:"team"} = 团队套餐（需 org/project 头，阶段 3）。 */
function resolveWanted(providerId) {
  const p = String(providerId || "");
  if (p.indexOf("account:") !== 0) return null;
  if (p.indexOf("team") >= 0) return { unsupported: "team" };
  if (p.indexOf("account:bigmodel") === 0) return { family: "bigmodel" };
  if (p.indexOf("account:zai") === 0) return { family: "zai" };
  return null;
}

function clampPct(x) { return Math.max(0, Math.min(100, x)); }

/* 已用 %：服务端 percentage 为整数精度粗，能自算时优先自算（P0：48/4000 被存成 1）。 */
function pctOf(limit) {
  if (typeof limit.percentage === "number" && limit.percentage >= 0) {
    if (typeof limit.currentValue === "number" && typeof limit.usage === "number" &&
        limit.usage > 0 && limit.currentValue >= 0) {
      return Math.round(clampPct((limit.currentValue / limit.usage) * 100) * 10) / 10;
    }
    return Math.round(clampPct(limit.percentage) * 10) / 10;
  }
  if (typeof limit.currentValue === "number" && typeof limit.usage === "number" &&
      limit.usage > 0 && limit.currentValue >= 0) {
    return Math.round(clampPct((limit.currentValue / limit.usage) * 100) * 10) / 10;
  }
  return null;
}

/* 重置时间：数字按秒/毫秒自适应（<1e12 视为秒），≤0 视为无（0% 滚动窗）；字符串原样。 */
function resetOf(v) {
  if (typeof v === "number" && isFinite(v)) {
    if (v <= 0) return null;
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string" && v) return v;
  return null;
}

function usageDetailsOf(limit) {
  const out = [];
  if (Array.isArray(limit && limit.usageDetails)) {
    for (const u of limit.usageDetails) {
      if (u && typeof u === "object" && typeof u.modelCode === "string" && u.modelCode) {
        out.push({ modelCode: u.modelCode, displayName: typeof u.displayName === "string" ? u.displayName : "", usage: typeof u.usage === "number" ? u.usage : null });
      }
    }
  }
  return out;
}

/* 归一化（纯函数）：响应体 → 值 / 无套餐 / 抛错。抛错一律带 code（parse_error /
 * network_error），由 settle 决定退避。 */
function normalizeQuotaBody(body) {
  if (!body || typeof body !== "object") throw qErr("parse_error", "non-object body");
  if (body.success === false) {
    const msg = String(body.msg || "");
    if (isNoPlanMessage(msg)) return { noPlan: true };
    /* 其它业务错误（瞬时服务端故障居多）：短退避重试，消息摘要进诊断 */
    throw qErr("network_error", "business error: " + msg.slice(0, 80));
  }
  const data = body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.limits)) {
    throw qErr("parse_error", "missing data.limits");
  }
  const windows = { fiveHour: null, weekly: null };
  let tools = null;
  const unknownUnits = [];
  const unclassified = [];
  const models = [];
  const seenModel = {};
  for (const limit of data.limits) {
    if (!limit || typeof limit !== "object") continue;
    const type = String(limit.type || "").toUpperCase();
    if (type === "TIME_LIMIT") {
      if (!tools) {
        tools = {
          used: typeof limit.currentValue === "number" ? limit.currentValue : null,
          total: typeof limit.usage === "number" ? limit.usage : null,
          resetsAt: resetOf(limit.nextResetTime),
        };
      }
      continue;
    }
    if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;
    const entry = { percent: pctOf(limit), resetsAt: resetOf(limit.nextResetTime), details: usageDetailsOf(limit) };
    for (const m of entry.details) {
      const key = m.displayName || m.modelCode;
      if (!seenModel[key]) { seenModel[key] = 1; models.push(key); }
    }
    const u = typeof limit.unit === "number" ? limit.unit : null;
    if (u === 3) { if (!windows.fiveHour) windows.fiveHour = entry; }
    else if (u === 6) { if (!windows.weekly) windows.weekly = entry; }
    else if (u === null) unclassified.push(entry);       // unit 缺失：按兜底规则补位
    else unknownUnits.push(u);                            // 未知数值 unit：丢弃留痕，绝不猜
  }
  /* unit 缺失兜底（cc-switch 同款）：无重置时间的条目优先归 5h（5h 桶在 0% 等状态
   * 可能没有 reset），其余按重置时间升序填入仍空缺的槽位。 */
  unclassified.sort((a, b) => {
    const ra = a.resetsAt == null ? -1 : (typeof a.resetsAt === "string" ? 0 : a.resetsAt);
    const rb = b.resetsAt == null ? -1 : (typeof b.resetsAt === "string" ? 0 : b.resetsAt);
    return ra - rb;
  });
  for (const entry of unclassified) {
    if (!windows.fiveHour) windows.fiveHour = entry;
    else if (!windows.weekly) windows.weekly = entry;
  }
  return {
    level: typeof data.level === "string" ? data.level : "",
    windows, tools, models, unknownUnits,
  };
}

/* 订阅元数据（BigModel）：取 status=VALID 且 inCurrentPeriod=true 的条目；0 条或歧义
 * （多条生效）一律 null 不猜。白名单字段——订单号/协议号等敏感字段绝不保留。 */
function normalizeSubscriptionPlan(body) {
  const data = body && typeof body === "object" && Array.isArray(body.data) ? body.data : null;
  if (!data) return null;
  const active = data.filter((e) => e && typeof e === "object" && e.status === "VALID" && e.inCurrentPeriod === true);
  if (active.length !== 1) return null;
  const s = active[0];
  const valid = typeof s.valid === "string" ? s.valid : "";
  const m = valid.match(/^(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);   // "起-止"区间，日期本身含连字符
  return {
    version: typeof s.version === "string" ? s.version.slice(0, 8) : "",
    productName: typeof s.productName === "string" ? s.productName.slice(0, 40) : "",
    validStart: m ? m[1] : "",
    validEnd: m ? m[2] : "",
  };
}

async function readBounded(res, ctl) {
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      size += step.value.length;
      if (size > BODY_LIMIT) {
        try { ctl.abort(); } catch (e) { }
        throw qErr("parse_error", "response too large");
      }
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const buf = Buffer.alloc(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return buf.toString("utf8");
  }
  const text = await res.text();
  if (text.length > BODY_LIMIT) throw qErr("parse_error", "response too large");
  return text;
}

function parseRetryAfterMs(v) {
  if (v == null) return null;
  const sec = Number(v);
  if (isFinite(sec) && sec >= 0) return Math.min(Math.max(sec * 1000, 30 * 1000), 10 * 60 * 1000);
  return 60 * 1000;
}

/* ---------- 客户端实例（inject-main 每 app 一份；测试可注入 env/now/fetch/readFile） ---------- */
function createQuotaClient(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const now = o.now || (() => Date.now());
  const fetchImpl = o.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const credsPath = o.credsPath || path.join(os.homedir(), ".zcode", "v2", "credentials.json");
  const readFile = o.readFile || ((p) => JSON.parse(fs.readFileSync(p, "utf8")));
  const log = o.log || (() => {});
  const onUpdate = o.onUpdate || null;

  const st = {
    status: "idle",          // idle|ok|auth_failed|no_plan|rate_limited|network_error|parse_error|not_configured|unsupported
    reason: "",              // unsupported 细分：team / provider
    providerId: "",
    value: null,             // 最近一次成功归一化结果（硬失败保留，供旧值展示）
    fetchedAt: 0,
    nextAt: 0,
    backoffIdx: 0,
    fingerprint: "",
    epoch: 0,
    inFlight: null,
    ctl: null,
    lastError: "",
  };

  function resolveCredential(fam) {
    for (const k of fam.envKeys) {
      const v = env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    let raw = null;
    try { raw = readFile(credsPath); } catch (e) { return null; }
    const enc = raw && typeof raw === "object" ? raw[fam.credKey] : null;
    if (typeof enc !== "string" || !enc) return null;
    const token = decryptValue(enc, deriveCipherKey(env));
    if (!token) return { decryptFailed: true, fingerprint: "host:" + sha16(enc) };
    return { token, fingerprint: "host:" + sha16(enc), source: "host" };
  }

  function setState(patch) { Object.assign(st, patch); if (onUpdate) onUpdate(); }

  function settleError(ep, err) {
    if (ep !== st.epoch) return;   // 代际守卫：期间 provider/凭据已切换，旧响应丢弃
    const code = err && err.code || "network_error";
    st.lastError = String(err && err.message || code).slice(0, 120);
    st.status = code;
    if (code === "auth_failed") st.nextAt = Infinity;            // 冻结到凭据指纹变化/手动刷新
    else if (code === "no_plan") st.nextAt = Infinity;
    else if (code === "parse_error") st.nextAt = now() + PARSE_BACKOFF_MS;
    else if (code === "rate_limited") st.nextAt = now() + (err.retryAfterMs || 60 * 1000);
    else st.nextAt = now() + BACKOFF_MS[Math.min(st.backoffIdx++, BACKOFF_MS.length - 1)];
    log("quota settle:", code, st.lastError);
    if (onUpdate) onUpdate();
  }
  function settleOk(ep, value) {
    if (ep !== st.epoch) return;
    st.value = value;
    st.fetchedAt = now();
    st.status = "ok";
    st.lastError = "";
    st.backoffIdx = 0;
    st.nextAt = now() + TTL_MS;
    if (onUpdate) onUpdate();
  }

  async function startFetch(wanted, fam, cred) {
    st.epoch += 1;
    const ep = st.epoch;
    const ctl = new AbortController();
    st.ctl = ctl;
    const kill = setTimeout(() => { try { ctl.abort(); } catch (e) { } }, FETCH_TIMEOUT_MS);
    const url = (fam.envUrl && env[fam.envUrl]) || fam.origin + QUOTA_PATH;
    const headers = {
      authorization: (fam.bearer ? "Bearer " : "") + cred.token,
      accept: "application/json",
      "accept-encoding": "identity",
    };
    /* 订阅元数据与额度并行拉取（仅配了 subPath 的 family）；任何失败都只丢 plan 字段，
     * 不影响额度状态机——两个端点独立演进，结构变化不互相拖累。 */
    const subFetch = fam.subPath ? fetchSubscription(fam, cred, ctl) : Promise.resolve(null);
    subFetch.catch(() => { });   // 额度先行返回时挂一个兜底 handler，避免未处理拒绝
    try {
      const res = await fetchImpl(url, { headers, signal: ctl.signal, redirect: "manual" });
      if (res.status === 401 || res.status === 403) {
        settleError(ep, qErr("auth_failed", "HTTP " + res.status));
        return;
      }
      if (res.status === 429) {
        const ra = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
        settleError(ep, qErr("rate_limited", "HTTP 429", { retryAfterMs: parseRetryAfterMs(ra) }));
        return;
      }
      if (res.status < 200 || res.status >= 300) {
        settleError(ep, qErr("network_error", "HTTP " + res.status));
        return;
      }
      const text = await readBounded(res, ctl);
      let json;
      try { json = JSON.parse(text); } catch (e) { settleError(ep, qErr("parse_error", "invalid json")); return; }
      const value = normalizeQuotaBody(json);
      if (value && value.noPlan) settleError(ep, qErr("no_plan", "no coding plan"));
      else {
        const plan = await subFetch;   // fetchSubscription 自身不 reject（内部全捕获）
        settleOk(ep, plan ? Object.assign({}, value, { plan }) : value);
      }
    } catch (e) {
      if (e && e.code) settleError(ep, e);
      else settleError(ep, qErr("network_error", String(e && e.name || e && e.message || "fetch failed")));
    } finally {
      clearTimeout(kill);
    }
  }

  async function fetchSubscription(fam, cred, ctl) {
    try {
      const res = await fetchImpl(fam.origin + fam.subPath, {
        headers: {
          authorization: (fam.bearer ? "Bearer " : "") + cred.token,
          accept: "application/json",
          "accept-encoding": "identity",
        },
        signal: ctl.signal,
        redirect: "manual",
      });
      if (res.status !== 200) return null;
      const text = await readBounded(res, ctl);
      return normalizeSubscriptionPlan(JSON.parse(text));
    } catch (e) {
      return null;   // 订阅失败静默降级：额度照常，tooltip 少一行
    }
  }

/* ---------- 自定义 provider（OpenAI 兼容中转/官方直连）的余额探测（v96.2） ----------
 * 配置来自宿主 ~/.zcode/v2/provider_config.json（api.baseUrl + access.apiKey，明文中转 key）。
 * 识别顺序：官方域名直连表（DeepSeek/OpenRouter/SiliconFlow 余额端点）→ 非官方域探测
 * OpenAI legacy billing（subscription+usage，one-api 系兼容最广）。hard_limit≥1e8 视为
 * 按量后付无固定池（实测 OpenHubs 即此类）→ 无 balance 可展示。识别不了的网关 →
 * unsupported，chip 隐藏；探测单轮不穷举，结果随凭据指纹缓存。key 只发 detect 确认的域。 */
const CUSTOM_BALANCE_HOSTS = [
  { host: "api.deepseek.com", url: "https://api.deepseek.com/user/balance",
    parse: (j) => parseCurrencyAmount(j && j.balance) },
  { host: "api.siliconflow.cn", url: "https://api.siliconflow.cn/v1/user/info",
    parse: (j) => parseCurrencyAmount(j && j.data && j.data.balance) },
  { host: "openrouter.ai", url: "https://openrouter.ai/api/v1/credits",
    parse: (j) => {
      const d = j && j.data;
      if (typeof (d && d.total_credits) === "number" && typeof d.total_usage === "number") {
        return { amount: Math.round((d.total_credits - d.total_usage) * 100) / 100, currency: "USD" };
      }
      return null;
    } },
];

/* "CNY 110.00" / "¥110.00" / "$12.5" → {amount, currency}；解析不了返回 null */
function parseCurrencyAmount(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([A-Z]{3}|¥|\$)\s*([\d,]+(?:\.\d+)?)$/);
  if (!m) return null;
  const currency = m[1] === "¥" ? "CNY" : m[1] === "$" ? "USD" : m[1];
  return { amount: parseFloat(m[2].replace(/,/g, "")), currency };
}

let providerCfgCache = null;   // {mtime, byId: Map(providerId → {baseUrl, apiKey, name})}
function resolveCustomProvider(providerId, readFile2, cfgPath) {
  let mtime = 0;
  try { mtime = fs.statSync(cfgPath).mtimeMs; }
  catch (e) { mtime = -1; }   // stat 失败不短路：仍尝试读取（测试虚拟路径/权限受限场景）
  if (!providerCfgCache || providerCfgCache.mtime !== mtime) {
    const byId = new Map();
    try {
      const d = readFile2(cfgPath);
      for (const r of ((d.config || {}).providerConfigRules || {}).providerRules || []) {
        const cfg = (r && r.config) || {};
        const baseUrl = String(((cfg.api || {}).baseUrl) || "").replace(/\/+$/, "");
        const apiKey = String(((cfg.access || {}).apiKey) || "");
        if (baseUrl && apiKey && r.providerId) {
          byId.set(String(r.providerId), { baseUrl, apiKey, name: String(r.providerName || "") });
        }
      }
    } catch (e) { /* 损坏/读取失败按无配置处理 */ }
    providerCfgCache = { mtime, byId };
  }
  return providerCfgCache.byId.get(String(providerId)) || null;
}

async function fetchCustomBalance(cp, fetchImpl, ctl) {
  let host = "";
  try { host = new URL(cp.baseUrl).hostname; } catch (e) { return null; }
  const official = CUSTOM_BALANCE_HOSTS.find((h) => host === h.host || host.endsWith("." + h.host));
  if (official) {
    const res = await fetchImpl(official.url, {
      headers: { authorization: "Bearer " + cp.apiKey, accept: "application/json", "accept-encoding": "identity" },
      signal: ctl.signal, redirect: "manual",
    });
    if (res.status !== 200) return null;
    const parsed = official.parse(JSON.parse(await readBounded(res, ctl)));
    return parsed && typeof parsed.amount === "number" && isFinite(parsed.amount) ? parsed : null;
  }
  /* 非官方域：OpenAI legacy billing 兼容探测（一轮 subscription+usage，不做端点穷举） */
  const sub = await fetchImpl(cp.baseUrl + "/dashboard/billing/subscription", {
    headers: { authorization: "Bearer " + cp.apiKey, accept: "application/json", "accept-encoding": "identity" },
    signal: ctl.signal, redirect: "manual",
  });
  if (sub.status !== 200) return null;
  const subJ = JSON.parse(await readBounded(sub, ctl));
  const hard = subJ && typeof subJ.hard_limit_usd === "number" ? subJ.hard_limit_usd : null;
  if (hard == null || hard >= 1e8) return null;   // 无固定池（按量后付站）
  const usage = await fetchImpl(cp.baseUrl + "/dashboard/billing/usage", {
    headers: { authorization: "Bearer " + cp.apiKey, accept: "application/json", "accept-encoding": "identity" },
    signal: ctl.signal, redirect: "manual",
  });
  if (usage.status !== 200) return null;
  const usageJ = JSON.parse(await readBounded(usage, ctl));
  const used = usageJ && typeof usageJ.total_usage === "number" ? usageJ.total_usage / 100 : 0;
  return { amount: Math.round((hard - used) * 100) / 100, currency: "USD" };
}

  function tick(force) {
    if (st.inFlight) return;
    const t = now();
    if (!force && t < st.nextAt) return;
    const wanted = resolveWanted(st.providerId);
    if (!wanted) {
      /* 自定义 provider：探测/直连其余额（官方域直连表 + OpenAI legacy 兼容）。
       * 配置缺失或识别不了的网关 → unsupported，chip 隐藏（fail-closed）。 */
      const cp = resolveCustomProvider(st.providerId, readFile,
        o.customCfgPath || path.join(os.homedir(), ".zcode", "v2", "provider_config.json"));
      if (!cp) {
        if (st.status !== "unsupported" || st.reason !== "provider") setState({ status: "unsupported", reason: "provider" });
        return;
      }
      const cpFp = sha16(cp.apiKey + "|" + cp.baseUrl);
      if (cpFp !== st.fingerprint) {
        st.fingerprint = cpFp;   // 中转 key/baseUrl 变化：解冻 + 清退避
        st.backoffIdx = 0;
        if (st.status === "auth_failed" || st.status === "unsupported") st.status = "idle";
        st.nextAt = 0;
      }
      if (!force && (st.status === "auth_failed" || st.status === "unsupported")) return;
      st.epoch += 1;
      const ep = st.epoch;
      const ctl = new AbortController();
      st.ctl = ctl;
      const kill = setTimeout(() => { try { ctl.abort(); } catch (e) { } }, FETCH_TIMEOUT_MS);
      st.inFlight = fetchCustomBalance(cp, fetchImpl, ctl)
        .then((balance) => {
          if (ep !== st.epoch) return;
          if (!balance) {   // 识别不了的网关/无固定池：无可展示余额
            setState({ status: "unsupported", reason: "gateway", value: null, lastError: "" });
            st.nextAt = now() + PARSE_BACKOFF_MS;
            if (onUpdate) onUpdate();
            return;
          }
          settleOk(ep, { custom: true, balance });
        })
        .catch((e) => settleError(ep, e && e.code ? e : qErr("network_error", String(e && e.message || "fetch failed"))))
        .finally(() => { clearTimeout(kill); if (st.inFlight) st.inFlight = null; });
      return;
    }
    if (wanted.unsupported === "team") {
      if (st.status !== "unsupported" || st.reason !== "team") setState({ status: "unsupported", reason: "team" });
      return;
    }
    const fam = FAMILIES[wanted.family];
    const cred = resolveCredential(fam);
    if (!cred) {
      if (st.status !== "not_configured") setState({ status: "not_configured", reason: "", lastError: "" });
      st.nextAt = t + NOT_CONFIGURED_RETRY_MS;
      return;
    }
    if (cred.decryptFailed) {
      /* 宿主改加密格式（如切 safeStorage）：fail-closed，只低频重探，绝不显示 0 */
      if (st.status !== "not_configured") setState({ status: "not_configured", reason: "decrypt", lastError: "credential decrypt failed" });
      st.nextAt = t + NOT_CONFIGURED_RETRY_MS;
      return;
    }
    if (cred.fingerprint !== st.fingerprint) {
      st.fingerprint = cred.fingerprint;   // 凭据变化（登录/刷新/换账号）：解冻 + 清退避
      st.backoffIdx = 0;
      if (st.status === "auth_failed" || st.status === "no_plan") st.status = "idle";
      st.nextAt = 0;
    }
    if (!force && (st.status === "auth_failed" || st.status === "no_plan")) return;   // 冻结中（同一凭据）
    if (cred.source === "host") {
      const exp = jwtExpMs(cred.token);
      if (exp && exp - t < EXP_SOON_MS) { st.nextAt = t + EXP_RETRY_MS; return; }     // 临期等宿主刷新
    }
    st.inFlight = startFetch(wanted, fam, cred);
    const p = st.inFlight;
    p.then(() => { if (st.inFlight === p) st.inFlight = null; });   // startFetch 自身不 reject
  }

  return {
    tick,
    refresh() { tick(true); },
    noteProvider(providerId) {
      const p = String(providerId || "");
      if (p === st.providerId) return;
      st.providerId = p;
      /* 换 provider 即换代：在途请求属旧额度池，响应迟到也不得覆盖新状态；
       * 同套餐内换模型 provider 串不变，不走这里（同池零成本复用）。 */
      st.epoch += 1;
      if (st.ctl) { try { st.ctl.abort(); } catch (e) { } }
      st.inFlight = null;
      st.nextAt = 0;   // 立即重判（unsupported ↔ 支持档）
    },
    credentialsChanged() { st.nextAt = 0; },   // credentials.json 变化：重读指纹，变化即解冻
    view() {
      const t = now();
      const v = {
        status: st.status,
        reason: st.reason,
        providerId: st.providerId,
        fetchedAt: st.fetchedAt,
        stale: !!(st.fetchedAt && t - st.fetchedAt > TTL_MS),
        error: st.lastError,
      };
      if (st.value) {
        v.level = st.value.level;
        v.plan = st.value.plan || null;
        v.balance = st.value.balance || null;
        v.windows = st.value.windows;
        v.tools = st.value.tools;
        v.models = st.value.models;
      }
      return v;
    },
    dispose() {
      if (st.ctl) { try { st.ctl.abort(); } catch (e) { } }
      st.inFlight = null;
    },
    _state: st,   // 测试接缝
  };
}

module.exports = {
  createQuotaClient,
  decryptValue,
  deriveCipherKey,
  jwtExpMs,
  normalizeQuotaBody,
  normalizeSubscriptionPlan,
  isNoPlanMessage,
  resolveWanted,
  TTL_MS,
};
