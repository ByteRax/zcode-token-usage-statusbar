/* --- DeepSeek（官方域零配置；total/granted/topped_up 三分拆分） --- */
ADAPTERS.push({
  id: "deepseek", label: "DeepSeek", kind: "balance", defaultOn: true,
  envKeys: ["DEEPSEEK_API_KEY", "DEEPSEEK_BALANCE_API_KEY"],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let host = "";
    try { host = new URL(cp.baseUrl).hostname; } catch (e) { return null; }
    if (host === "api.deepseek.com") return { key: cp.apiKey, origin: "cfg" };
    return null;
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).deepseek || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    if (ctx.key) return { token: ctx.key, fingerprint: "cfg:" + sha16(ctx.key), source: "provider_config" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const body = await j.http.getJson("https://api.deepseek.com/user/balance", { authorization: "Bearer " + cred.token }, ctl);
    const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : [];
    if (!infos.length) {
      /* is_available=false（官方语义：无余额可供调用）且无币种条目：按合法零余额显示，不判解析失败——
       * 文档不承诺无可用余额的账户仍返回 balance_infos 条目；币种无响应证据，沿用平台缺省 CNY。 */
      if (body && body.is_available === false) return { balance: { amount: 0, currency: "CNY" } };
      throw qErr("parse_error", "no balance_infos");
    }
    const parsed = infos
      .map((x) => {
        const total = parseCurrencyAmount(x.total_balance, x.currency);
        const granted = parseCurrencyAmount(x.granted_balance, x.currency);
        const topped = parseCurrencyAmount(x.topped_up_balance, x.currency);
        if (!total) return null;
        return { currency: x.currency || total.currency, total, granted, topped };
      })
      .filter(Boolean);
    if (!parsed.length) throw qErr("parse_error", "balance_infos unparsable");
    const best = parsed.sort((a, b) => b.total.amount - a.total.amount)[0];
    const out = { balance: { amount: Math.round(best.total.amount * 100) / 100, currency: best.currency || "CNY" } };
    if (best.granted && best.granted.amount > 0) {   // 仅赠送≠0 才拆分展示
      out.balance.parts = [
        { label: "赠送", amount: best.granted.amount },
        { label: "充值", amount: best.topped ? best.topped.amount : Math.max(0, best.total.amount - best.granted.amount) },
      ];
    }
    return out;
  },
});

/* --- OpenRouter credits --- */
ADAPTERS.push({
  id: "openrouter", label: "OpenRouter", kind: "balance", defaultOn: true,
  envKeys: ["OPENROUTER_MANAGEMENT_KEY"],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let host = "";
    try { host = new URL(cp.baseUrl).hostname; } catch (e) { return null; }
    if (host === "openrouter.ai") return { key: cp.apiKey, origin: "cfg" };
    return null;
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).openrouter || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const body = await j.http.getJson("https://openrouter.ai/api/v1/credits", { authorization: "Bearer " + cred.token }, ctl);
    const d = body && body.data;
    const total = num(d && d.total_credits), used = num(d && d.total_usage);
    if (total == null || used == null) throw qErr("parse_error", "openrouter shape");
    return { balance: { amount: Math.round((total - used) * 100) / 100, currency: "USD" } };
  },
});

/* --- SiliconFlow（端点存在 410 废弃风险，失败中性引导） --- */
ADAPTERS.push({
  id: "siliconflow", label: "SiliconFlow", kind: "balance", defaultOn: true,
  envKeys: ["SILICONFLOW_API_KEY"],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let host = "";
    try { host = new URL(cp.baseUrl).hostname; } catch (e) { return null; }
    if (host === "api.siliconflow.cn" || host === "api.siliconflow.com") return {
      key: cp.apiKey, origin: "cfg", apiOrigin: "https://" + host, currency: host.endsWith(".com") ? "USD" : "CNY" };

    return null;
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).siliconflow || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    if (ctx.key) return { token: ctx.key, fingerprint: "cfg:" + sha16(ctx.key), source: "provider_config" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    let body;
    /* v102：secrets.baseUrl（⚙ 预设模板写入）仅在可信域白名单内生效（minimax 同款，
     * key 不发任意域）；.com 币种随域。端点自带 currency 时仍以响应为准。 */
    const rawBase = ((j.secrets.sources || {}).siliconflow || {}).baseUrl || "";
    let baseHost = "";
    try { baseHost = rawBase ? new URL(rawBase).hostname : ""; } catch (e) { baseHost = ""; }
    const trustedBase = baseHost === "api.siliconflow.cn" || baseHost === "api.siliconflow.com";
    const baseOrigin = trustedBase ? rawBase.replace(/\/+$/, "") : (ctx.apiOrigin || "https://api.siliconflow.cn");
    const baseCurrency = baseHost === "api.siliconflow.com" ? "USD" : baseHost === "api.siliconflow.cn" ? "CNY" : "";
    try { body = await j.http.getJson(baseOrigin + "/v1/user/info", { authorization: "Bearer " + cred.token }, ctl); }
    catch (e) { if (e && e.httpStatus === 410) throw qErr("unsupported", "siliconflow quota endpoint retired", { reason: "endpoint_retired" }); throw e; }
    const d = (body && body.data) || {};
    const v = parseCurrencyAmount(d.totalBalance != null ? d.totalBalance : d.balance, d.currency || baseCurrency || ctx.currency || "CNY");
    if (!v) throw qErr("parse_error", "siliconflow shape");
    return { balance: { amount: Math.round(v.amount * 100) / 100, currency: v.currency || "CNY" } };
  },
});

/* --- 小米 MiMo Token Plan（配置型：控制台 Cookie） --- */
function normalizeMimoCookie(raw) {
  let s = String(raw || "").trim().replace(/^Cookie:\s*/i, "").replace(/^["']|["']$/g, "").replace(/\s*\n\s*/g, "; ").replace(/;\s*;+/g, ";");
  if (!/userId=/.test(s)) return null;
  if (!/(api-platform_)?serviceToken=/.test(s)) return null;
  return s;
}
ADAPTERS.push({
  id: "mimo", label: "小米 MiMo", kind: "plan", defaultOn: false, unverified: true,
  envKeys: ["MIMO_COOKIE", "XIAOMI_MIMO_COOKIE"],
  detect() { return null; },
  resolveCred(j) {
    let raw = null;
    for (const k of this.envKeys) { if (j.env[k]) { raw = j.env[k]; break; } }
    if (!raw) raw = ((j.secrets.sources || {}).mimo || {}).cookie;
    if (!raw) return null;
    const cookie = normalizeMimoCookie(raw);
    if (!cookie) return { decryptFailed: true, fingerprint: "sec:" + sha16(raw), missing: "mimoCookieFields" };
    return { cookie, fingerprint: "sec:" + sha16(cookie), source: "secrets" };
  },
  async fetchOne(j, ctx, cred, ctl) {
    const H = { cookie: cred.cookie };
    const base = "https://platform.xiaomimimo.com/api/v1";
    const usage = await j.http.getJson(base + "/tokenPlan/usage", H, ctl);
    const ud = (usage && usage.data) || {};
    const items = Array.isArray(ud.monthUsage && ud.monthUsage.items) ? ud.monthUsage.items : [];
    const windows = {};
    const pick = (names, name) => {
      for (const it of items) {
        if (!it) continue;
        const key = String(it.name || "");
        if (!names.some((n) => key === n)) continue;
        const used = num(it.used), limit = num(it.limit);
        let pct = num(it.percent);
        if ((used != null && limit != null && limit > 0)) pct = (used / limit) * 100;
        if (pct == null || !isFinite(pct) || pct < 0) continue;
        if (!windows[name]) windows[name] = { percent: Math.round(clampPct(pct) * 10) / 10, resetsAt: null };
      }
    };
    pick(["month_total_token", "plan_total_token"], "monthly");
    pick(["compensation_total_token"], "compensation");
    let out = {};
    if (Object.keys(windows).length) out.windows = windows;
    /* 周期截止与余额并行（均无依赖）；失败静默降级 */
    const detP = j.http.maybeGetJson(base + "/tokenPlan/detail", H, ctl).catch(() => null);
    const balP = j.http.maybeGetJson(base + "/balance", H, ctl).catch(() => null);
    const det = await detP;
    const dd = (det && det.data) || {};
    const end = typeof dd.currentPeriodEnd === "string" ? dd.currentPeriodEnd : "";
    if (end) {
      const m = end.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
      if (m && out.windows && out.windows.monthly) out.windows.monthly.resetsAt = m[1] + " " + m[2] + " +08:00";
    }
    const bal = await balP;
    const bd = (bal && bal.data) || {};
    const b = parseCurrencyAmount(bd.balance != null ? bd.balance : bd.cashBalance, bd.currency || "CNY");
    if (b) {
      out.balance = { amount: Math.round(b.amount * 100) / 100, currency: b.currency || "CNY" };
      const cash = parseCurrencyAmount(bd.cashBalance, bd.currency), gift = parseCurrencyAmount(bd.giftBalance, bd.currency);
      if (cash && gift && (gift.amount > 0 || cash.amount > 0)) {
        out.balance.parts = [{ label: "充值", amount: cash.amount || 0 }, { label: "赠送", amount: gift.amount || 0 }];
      }
    }
    if (!out.windows && !out.balance) throw qErr("parse_error", "mimo empty");
    return out;
  },
});

/* --- 火山方舟（配置型 AK/SK；SigV4 火山变体） --- */
function hmac(key, data) { return crypto.createHmac("sha256", key).update(data).digest(); }
async function volcCall(http, host, action, region, ak, sk) {
  const now = new Date();
  const xDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");   // YYYYMMDDTHHMMSSZ
  const query = "Action=" + action + "&Region=" + region + "&Version=2024-01-01";   // 字母序 Action<Region<Version
  const payload = "";
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
  const headers = "host:" + host + "\nx-date:" + xDate + "\nx-content-sha256:" + payloadHash + "\ncontent-type:application/json; charset=utf-8\n";
  const signed = "host;x-date;x-content-sha256;content-type";
  const canonical = "POST\n/\n" + query + "\n" + headers + "\n" + signed + "\n" + payloadHash;
  const date = xDate.slice(0, 8);
  const scope = date + "/" + region + "/ark/request";   // 火山变体：结尾 request，非 aws4_request
  const stringToSign = "HMAC-SHA256\n" + xDate + "\n" + scope + "\n" + crypto.createHash("sha256").update(canonical).digest("hex");
  let k = hmac(sk, date);                       // SK 不加前缀
  k = hmac(k, region); k = hmac(k, "ark"); k = hmac(k, "request");
  const signature = crypto.createHmac("sha256", k).update(stringToSign).digest("hex");
  const res = await http.post("https://" + host + "/?" + query, {
    "x-date": xDate,
    "x-content-sha256": payloadHash,
    "content-type": "application/json; charset=utf-8",
    authorization: "HMAC-SHA256 Credential=" + ak + "/" + scope + ", SignedHeaders=" + signed + ", Signature=" + signature,
  });
  return res;
}
ADAPTERS.push({
  id: "volcano", label: "火山方舟", kind: "plan", defaultOn: false, unverified: true,
  envKeys: ["VOLCENGINE_ACCESS_KEY_ID", "VOLCENGINE_SECRET_ACCESS_KEY"],
  /* Ark Agent Plan 自定义供应商认领（issue #261）：官方域 + /api/plan 前缀才命中（/api/v3
   * 按量版无套餐查询语义，不认领）。只解析 provider baseUrl，不查凭据、不发请求——无 AK/SK
   * 时归本源报 not_configured（chip 引导去 ⚙ 配置），比落 custom 报 unsupported 更可操作；
   * ⚙ 显式 enabled=false 时复合源报 disabled 隐藏 chip（尊重显式关闭）。 */
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let u = null;
    try { u = new URL(cp.baseUrl); } catch (e) { return null; }
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "ark.cn-beijing.volces.com") return null;
    const p = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (p !== "/api/plan" && !p.startsWith("/api/plan/")) return null;
    return { config: true, family: "volcano" };
  },
  resolveCred(j) {
    const sec = (j.secrets.sources || {}).volcano || {};
    const ak = j.env.VOLCENGINE_ACCESS_KEY_ID || sec.accessKeyId || sec.ak;
    const sk = j.env.VOLCENGINE_SECRET_ACCESS_KEY || sec.secretAccessKey || sec.sk;
    if (!ak || !sk) return null;
    return { ak, sk, fingerprint: "sec:" + sha16(ak + "|" + sk), source: "secrets" };
  },
  async fetchOne(j, ctx, cred, ctl) {
    const rawRegion = ((j.secrets.sources || {}).volcano || {}).region;
    const region = typeof rawRegion === "string" && /^[a-z0-9-]{2,32}$/.test(rawRegion) ? rawRegion : "cn-beijing";   // 非法 region 回默认，不让坏配置进签名串
    const host = "open.volcengineapi.com";
    /* 双 plan 探测：Agent Plan（GetAFPUsage）非空即返；Quota<=0 视为未订阅回落 Coding Plan */
    let body = null, tag = "";
    try {
      body = await volcCall(j.http, host, "GetAFPUsage", region, cred.ak, cred.sk);
      tag = "Agent Plan";
    } catch (e) {
      if (e && e.code === "auth_failed") throw e;
      body = null;
    }
    const afp = body && body.Result;
    const windows = {};
    if (afp && typeof afp === "object") {
      for (const [k, name] of [["AFPFiveHour", "fiveHour"], ["AFPWeekly", "weekly"], ["AFPMonthly", "monthly"]]) {   // AFPDaily 刻意跳过（历史默认值虚高）
        const q = num(afp[k] && afp[k].Quota), used = num(afp[k] && afp[k].Used);
        if (q != null && q > 0 && used != null) {
          windows[name] = { percent: Math.round(clampPct((used / q) * 100) * 10) / 10, resetsAt: resetOf(afp[k].ResetTime) };
        }
      }
    }
    if (Object.keys(windows).length) return { label: "火山方舟", kind: "plan", plan: { productName: tag }, windows, planName: tag };
    const cp = await volcCall(j.http, host, "GetCodingPlanUsage", region, cred.ak, cred.sk);
    const arr = (cp && cp.Result && (cp.Result.QuotaUsage || cp.Result.Usages || cp.Result.Details)) || [];
    for (const e of arr) {
      if (!e || typeof e !== "object") continue;
      const lvl = String(e.Level || e.Type || e.Period || e.Label || e.Window || "").toLowerCase().replace(/[\s_-]/g, "");
      const name = /session|^5h|fivehour|rolling5h/.test(lvl) ? "fiveHour" : /weekly|week|7d/.test(lvl) ? "weekly" : /monthly|month/.test(lvl) ? "monthly" : null;
      if (!name || windows[name]) continue;
      let pct = num(e.Percent);
      if (pct == null) pct = num(e.UsedPercent);
      if (pct == null) pct = num(e.UsagePercent);
      if (pct == null || pct < 0) continue;
      windows[name] = { percent: Math.round(clampPct(pct) * 10) / 10, resetsAt: resetOf(e.ResetTime != null ? e.ResetTime : e.ResetTimestamp) };
    }
    if (!Object.keys(windows).length) throw qErr("parse_error", "volcano empty");
    return { label: "火山方舟", kind: "plan", plan: { productName: "Coding Plan" }, windows };
  },
});

/* --- SCNet（账本估算，无网络；数据由 zusage 快照侧聚合注入） --- */
ADAPTERS.push({
  id: "scnet", label: "SCNet", kind: "ledger", defaultOn: false, unverified: true,
  envKeys: [],
  detect() { return null; },
  resolveCred(j) {
    const sec = (j.secrets.sources || {}).scnet || {};
    if (!sec.enabled || !(num(sec.planCredits) > 0)) return null;
    return { none: true, fingerprint: "sec:scnet:" + sha16(JSON.stringify([sec.planCredits, sec.planStart || "", sec.modelPatterns || {}])), source: "secrets" };
  },
  async fetchOne(j) {
    const ex = j.extras && j.extras.scnet;
    if (!ex || ex.source === "none" || ex.credits_used == null) return { noPlan: true };   // 快照未带估算（zusage 旧版/未配置）：软隐藏不报错
    return {
      windows: { monthly: { percent: Math.round(clampPct((ex.credits_used / ex.plan_credits) * 100) * 10) / 10, resetsAt: ex.resets_at || null } },
      ledger: { used: ex.credits_used, total: ex.plan_credits, source: ex.source },
    };
  },
});

/* sub2api 的 key 用量接口（与推理地址同源，非管理接口）。remaining 可能是最紧
 * 订阅窗口的剩余，不一定是钱包余额：存在 subscription 时仅输出套餐窗口。 */
function normalizeSub2api(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.isValid === false) throw qErr("auth_failed", "sub2api key unavailable");
  if (!("isValid" in body) && !("mode" in body)) return null;
  if (body.isValid !== true || !["balance", "subscription", "unrestricted", "quota", "quota_limited"].includes(body.mode)) {
    throw qErr("parse_error", "sub2api mode invalid");
  }
  const unit = body.unit == null && body.mode === "quota_limited" ? "USD" : body.unit;
  if (!["USD", "CNY", "credits"].includes(unit)) throw qErr("parse_error", "sub2api unit invalid");
  if (body.subscription != null && (typeof body.subscription !== "object" || Array.isArray(body.subscription))) {
    throw qErr("parse_error", "sub2api subscription invalid");
  }
  const currency = unit === "credits" ? "CR" : unit;
  if (body.mode === "quota" || body.mode === "quota_limited") {
    const value = { label: "sub2api", kind: "plan" };
    if (body.quota != null) {
      const quota = body.quota;
      const limit = num(quota.limit), used = num(quota.used), remaining = num(quota.remaining);
      if (typeof quota !== "object" || Array.isArray(quota) || limit == null || limit <= 0 ||
          used == null || used < 0 || remaining == null || (quota.unit != null && quota.unit !== "USD")) {
        throw qErr("parse_error", "sub2api quota invalid");
      }
      value.quotaSummary = { limit, used, remaining, currency: "USD" };
    }
    if (body.rate_limits != null) {
      if (!Array.isArray(body.rate_limits)) throw qErr("parse_error", "sub2api rate limits invalid");
      const windows = {};
      for (const entry of body.rate_limits) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw qErr("parse_error", "sub2api rate limit invalid");
        const key = entry.window === "5h" ? "fiveHour" : entry.window === "1d" ? "daily" : entry.window === "7d" ? "weekly" : null;
        if (!key) continue;
        const total = num(entry.limit), used = num(entry.used), remaining = num(entry.remaining);
        if (total == null || total <= 0 || used == null || used < 0 || remaining == null ||
            (entry.unit != null && entry.unit !== "USD")) throw qErr("parse_error", "sub2api rate limit invalid");
        windows[key] = { percent: Math.round(clampPct(used / total * 100) * 10) / 10,
          used, total, remaining, currency: "USD", resetsAt: resetOf(entry.reset_at) };
      }
      if (Object.keys(windows).length) value.windows = windows;
    }
    if (!value.quotaSummary && !value.windows) throw qErr("parse_error", "sub2api quota missing");
    return value;
  }
  const sub = body.subscription;
  if (sub && typeof sub === "object" && !Array.isArray(sub)) {
    const windows = {};
    for (const [period, key] of [["daily", "daily"], ["weekly", "weekly"], ["monthly", "monthly"]]) {
      const total = num(sub[period + "_limit_usd"]);
      const used = num(sub[period + "_usage_usd"]);
      if (total == null || total <= 0 || used == null || used < 0) continue;
      const reset = sub[period + "_reset_at"] || sub[period + "_resets_at"];
      windows[key] = { percent: Math.round(clampPct(used / total * 100) * 10) / 10,
        used: used, total: total, remaining: total - used, currency: "USD", resetsAt: resetOf(reset) };
    }
    if (!Object.keys(windows).length) throw qErr("parse_error", "sub2api subscription windows missing");
    const expires = typeof sub.expires_at === "string" && Number.isFinite(Date.parse(sub.expires_at)) ? sub.expires_at : "";
    return { label: "sub2api", kind: "plan", windows: windows,
      subscription: { name: typeof body.planName === "string" ? body.planName.slice(0, 100) : "", expiresAt: expires } };
  }
  if (body.mode !== "balance" && body.mode !== "unrestricted") throw qErr("parse_error", "sub2api balance scope unknown");
  const remaining = num(body.mode === "unrestricted" ? body.balance : body.remaining);
  if (remaining == null) throw qErr("parse_error", "sub2api balance missing");
  return { label: "sub2api", kind: "balance", balance: { amount: remaining, currency: currency } };
}

function relayQuotaUrls(baseUrl) {
  // 空/非法 baseUrl 是配置类不可用：按 unsupported 长退避（quota.md 契约），不是响应形状问题
  let url;
  try { url = new URL(baseUrl); } catch (e) { throw qErr("unsupported", "bad baseUrl"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw qErr("parse_error", "untrusted query scheme");
  if (url.username || url.password) throw qErr("parse_error", "baseUrl userinfo rejected");
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { sub2api: url.origin + prefix + "/v1/usage", legacy: url.origin + url.pathname.replace(/\/+$/, "") };
}

/* --- OpenCode Go（$10/月订阅；端点为第一方未文档化接口，2026-11-15 个人 Go 档实测） ---
 * 主链 GET https://opencode.ai/console/api/go/status（控制台 Go 页面同源；API key
 * 同样以 Authorization: Bearer 读取）：access.meters.{fiveHour,week,month} 各自带
 * {startsAt?,resetsAt,limitMicroCents,usedMicroCents}，金额单位 microcent
 * （1 USD = 1e8 microcent），percent 自算，可显示 $ 用量/额度明细。
 * 兜底 GET https://opencode.ai/zen/go/v1/usage（cc-switch coding_plan.rs 转写，MIT）：
 * {usage:{rolling|weekly|monthly:{status,percent(已用0-100),resetsAt(ISO)}}}；
 * 该端点只回整数已用百分比且向下取整（5 小时窗口用量 <1% 时恒为 0），也不回金额。
 * 两链同域 opencode.ai，凭据不出官方域。detect 较 cc-switch 的裸子串收严：host 精确
 * opencode.ai + 路径 /zen/go 或其子路径（两档预设），防外域伪装；Zen 按量版 /zen/v1
 * 无用量 API（cc-switch 实测 404）刻意不命中。 */
const OPENCODE_GO_STATUS_URL = "https://opencode.ai/console/api/go/status";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_MICROCENTS_PER_USD = 1e8;
const OPENCODE_STATUS_TIMEOUT_MS = Math.min(3000, FETCH_TIMEOUT_MS);
function opencodeLinkedAbort(parent) {
  const ctl = new AbortController();
  const signal = parent && parent.signal;
  if (!signal) return ctl;
  if (signal.aborted) { try { ctl.abort(); } catch (e) { } return ctl; }
  try { signal.addEventListener("abort", () => { try { ctl.abort(); } catch (e) { } }, { once: true }); }
  catch (e) { /* 极简 signal 桩：仍可独立超时 */ }
  return ctl;
}
function opencodeUsdOf(v) {
  const n = num(v);
  return n == null || n < 0 ? null : n / OPENCODE_MICROCENTS_PER_USD;
}
/* 控制台 meters → 窗口；形状不符/全无有效窗返回 null（调用方回落 public usage 端点，
 * 不把一次控制台改版打成 parse_error 长退避）。percent 保留两位小数：public 端点的
 * 整数向下取整会把 0.67% 显示成 0%，正是 5 小时窗口「看起来查不到」的根因。 */
function normalizeOpencodeGoStatus(body) {
  const access = body && typeof body === "object" && !Array.isArray(body) &&
    body.access && typeof body.access === "object" && !Array.isArray(body.access) ? body.access : null;
  const meters = access && access.meters && typeof access.meters === "object" &&
    !Array.isArray(access.meters) ? access.meters : null;
  if (!meters) return null;
  const windows = {};
  for (const pair of [["fiveHour", "fiveHour"], ["week", "weekly"], ["month", "monthly"]]) {
    const m = meters[pair[0]] && typeof meters[pair[0]] === "object" && !Array.isArray(meters[pair[0]])
      ? meters[pair[0]] : null;
    if (!m) continue;
    const limitMc = num(m.limitMicroCents), usedMc = num(m.usedMicroCents);
    if (limitMc == null || !(limitMc > 0) || usedMc == null || usedMc < 0) continue;
    const total = opencodeUsdOf(limitMc), used = opencodeUsdOf(usedMc);
    windows[pair[1]] = {
      percent: Math.round(clampPct((usedMc / limitMc) * 100) * 100) / 100,
      resetsAt: resetOf(m.resetsAt) || (pair[0] === "month" ? resetOf(access.endsAt) : null),
      used, total, remaining: total != null && used != null ? Math.max(0, total - used) : null,
      currency: "USD",
    };
  }
  /* 缺某窗（字段漂移/该档无此窗）时不拿兜底整数百分比补洞：避免不同来源/时刻的数据
   * 混在同一张卡上；全部窗都缺失才整源回落，下一拍控制台恢复即自愈。 */
  if (!Object.keys(windows).length) return null;
  return { label: "OpenCode Go", kind: "plan", windows: windows };
}
function normalizeOpencodeGo(body) {
  const usage = body && typeof body === "object" && !Array.isArray(body) &&
    body.usage && typeof body.usage === "object" && !Array.isArray(body.usage) ? body.usage : null;
  if (!usage) throw qErr("parse_error", "opencode usage shape");
  const windows = {};
  for (const pair of [["rolling", "fiveHour"], ["weekly", "weekly"], ["monthly", "monthly"]]) {
    const w = usage[pair[0]] && typeof usage[pair[0]] === "object" && !Array.isArray(usage[pair[0]]) ? usage[pair[0]] : null;
    const pct = w ? num(w.percent) : null;
    if (pct == null || pct < 0) continue;   // 坏窗跳过不整体失败（端点上线当天改过一次形态）
    windows[pair[1]] = {
      percent: Math.round(clampPct(pct) * 10) / 10,   // 已用%直取（Go 语义即已用，非剩余）
      /* percent=0 时 public 端点的 resetsAt 是 now+窗长占位值（空闲窗），丢弃；
       * 子 1% 活跃窗由控制台 meters 主链给出精确 percent 与真实 resetsAt。 */
      resetsAt: pct > 0 ? resetOf(w.resetsAt) : null,
    };
  }
  if (!Object.keys(windows).length) throw qErr("parse_error", "opencode windows missing");
  return { label: "OpenCode Go", kind: "plan", windows: windows };
}

ADAPTERS.push({
  id: "opencode", label: "OpenCode Go", kind: "plan", defaultOn: true,
  envKeys: ["OPENCODE_API_KEY"],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let u = null;
    try { u = new URL(cp.baseUrl); } catch (e) { return null; }
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "opencode.ai") return null;
    const p = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (p !== "/zen/go" && !p.startsWith("/zen/go/")) return null;   // 仅两档预设；/zen/v1 按量版与 /zen/gopher 类前缀不命中
    return { key: cp.apiKey, origin: "cfg" };
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).opencode || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    if (ctx.key) return { token: ctx.key, fingerprint: "cfg:" + sha16(ctx.key), source: "provider_config" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const headers = { authorization: "Bearer " + cred.token };
    /* 两个端点并行、各自独立 AbortController（仅父信号联动）：控制台 meters 给出精确金额/
     * 子 1% 用量；public usage 端点作为独立兜底并负责 403 无订阅判定。控制台 3 秒宽限
     * 超时后单独中止，不拖住已就绪的兜底；控制台 401/403/网络/形态变化静默降级，不让
     * 一次控制台改版把整条链打成 parse_error 长退避。 */
    const statusCtl = opencodeLinkedAbort(ctl);
    const usageCtl = opencodeLinkedAbort(ctl);
    const statusTimer = setTimeout(() => { try { statusCtl.abort(); } catch (e) { } }, OPENCODE_STATUS_TIMEOUT_MS);
    if (statusTimer && typeof statusTimer.unref === "function") statusTimer.unref();
    const statusP = j.http.getJson(OPENCODE_GO_STATUS_URL, headers, statusCtl)
      .then((body) => normalizeOpencodeGoStatus(body))
      .catch(() => null)
      .finally(() => clearTimeout(statusTimer));
    /* 显式信封而非 instanceof Error：fetchImpl 是注入接缝，可能以字符串/普通对象拒绝。 */
    const usageP = j.http.getJson(OPENCODE_GO_USAGE_URL, headers, usageCtl)
      .then((body) => ({ ok: true, value: normalizeOpencodeGo(body) }))
      .catch((error) => ({ ok: false, error }));
    const rich = await statusP;
    if (rich) {
      try { usageCtl.abort(); } catch (e) { }   // 主链已够：取消多余兜底请求
      return rich;
    }
    const usage = await usageP;
    if (!usage.ok) {
      /* 403 EntitlementError：key 本身有效（Zen/Go 共用 workspace key）但无 Go 订阅——
       * 与 401 认证失败分开（classifyStatus 把 401/403 都归 auth_failed，此处按消息分流）。 */
      if (usage.error && usage.error.httpStatus === 403) return { noPlan: true };
      throw usage.error;
    }
    return usage.value;
  },
});

/* --- R4 Coder（r4.codes 中转；/v1/cli/key + /v1/cli/meta 同源只读） ---
 * 自定义供应商 baseUrl 指向 api.r4.codes 时零配置认领；普通 coder_ 推理 key 即查询
 * 凭据（文档：Authorization Bearer 与 x-api-key 等价，三端点共享 60 req/min 桶）。
 * key 给出调用 Key 的 limit/spent/held（reserve gate 口径），meta 给出套餐池、
 * limit_windows（如 5 小时 ceiling）、钱包余额与到期。两请求并行：meta 失败只损失
 * 套餐增强，key 限额仍可展示；两者都无可展示数据才 fail-closed。 */
const R4_API_ORIGIN = "https://api.r4.codes";
function r4WindowName(seconds) {
  if (!(seconds > 0)) return "";
  if (seconds <= 6 * 3600) return "fiveHour";
  if (seconds <= 36 * 3600) return "daily";
  if (seconds <= 8 * 86400) return "weekly";
  if (seconds <= 32 * 86400) return "monthly";
  return "";   // 未知长窗丢弃：绝不冒充套餐池（plan 只由 plan.total/remaining 产出）
}
function r4Day(value) {
  const m = typeof value === "string" ? value.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return m ? m[1] : "";
}
/* 金额是服务端字符串转来的十进制小数；减法会留下 1.392046999999998 这类尾差，
 * 统一收到 6 位再进快照（展示层只用到 2–4 位，不影响精度）。 */
function r4Usd(value) { return Math.round(value * 1e6) / 1e6; }
function normalizeR4(keyBody, metaBody) {
  const key = keyBody && typeof keyBody === "object" && !Array.isArray(keyBody) ? keyBody : null;
  const meta = metaBody && typeof metaBody === "object" && !Array.isArray(metaBody) ? metaBody : null;
  if (!key && !meta) throw qErr("parse_error", "r4 empty");
  const out = { label: "R4 Coder", kind: "plan" };
  const windows = {};
  let hasQuota = false;
  const plan = meta && meta.plan && typeof meta.plan === "object" && !Array.isArray(meta.plan) ? meta.plan : null;
  if (plan) {
    const total = num(plan.total_usd), remaining = num(plan.remaining_usd);
    if (total != null && total > 0 && remaining != null && remaining >= 0) {
      const used = Math.max(0, total - remaining);
      windows.plan = {
        percent: Math.round(clampPct((used / total) * 100) * 10) / 10,
        used: r4Usd(used), total: r4Usd(total), remaining: r4Usd(Math.min(remaining, total)),
        currency: "USD", resetsAt: resetOf(plan.expires_at), expires: true,
      };
      hasQuota = true;
    }
    const list = Array.isArray(plan.limit_windows) ? plan.limit_windows : [];
    for (const lw of list) {
      if (!lw || typeof lw !== "object" || Array.isArray(lw)) continue;
      const ceiling = num(lw.ceiling_usd), consumed = num(lw.consumed_usd);
      /* ceiling=null 是「该窗不限速」语义，不是 0 额度：跳过，绝不造 0% 假窗口。 */
      if (ceiling == null || !(ceiling > 0) || consumed == null || consumed < 0) continue;
      const left = num(lw.remaining_usd);
      const name = r4WindowName(num(lw.duration_seconds));
      if (!name) continue;
      const win = {
        percent: Math.round(clampPct((consumed / ceiling) * 100) * 10) / 10,
        used: consumed, total: ceiling,
        remaining: left != null && left >= 0 ? left : Math.max(0, ceiling - consumed),
        currency: "USD", resetsAt: resetOf(lw.resets_at),
      };
      /* 同标签多窗（字段漂移/多档叠加）取已用比例更高者，不让低窗掩盖受限状态。 */
      if (!windows[name] || win.percent > windows[name].percent) windows[name] = win;
      hasQuota = true;
    }
    const pkg = typeof plan.package_name === "string" ? plan.package_name.trim() : "";
    if (pkg) out.plan = { productName: pkg.slice(0, 60) };
    const end = r4Day(plan.expires_at);
    if (end && out.plan) out.plan.validEnd = end;
  }
  if (key) {
    const limit = num(key.limit_usd), spent = num(key.spent_usd), held = num(key.held_usd);
    const remaining = num(key.remaining_usd);
    if (limit != null && limit >= 0 && (remaining != null || spent != null)) {
      const used = spent != null ? spent + (held != null ? held : 0) : Math.max(0, limit - remaining);
      out.quotaSummary = {
        limit: r4Usd(limit), used: r4Usd(used),
        remaining: r4Usd(remaining != null ? remaining : Math.max(0, limit - used)),
        currency: "USD",
      };
      hasQuota = true;
    }
  }
  if (Object.keys(windows).length) out.windows = windows;
  if (!hasQuota) {
    const wallet = meta && meta.wallet && typeof meta.wallet === "object" && !Array.isArray(meta.wallet) ? meta.wallet : null;
    const balance = wallet ? num(wallet.balance_usd) : null;
    if (balance == null || balance < 0) return { noPlan: true };   // 钱包缺失/负值且无套餐/限额：无任何可展示额度（0 是合法零余额，照常显示）
    out.kind = "balance";
    out.balance = { amount: balance, currency: "USD" };
  }
  return out;
}
function r4KeyUsable(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (!("limit_usd" in body) && !("spent_usd" in body) && !("remaining_usd" in body)) return false;
  for (const k of ["limit_usd", "spent_usd", "held_usd", "remaining_usd"]) {
    if (body[k] != null && num(body[k]) == null) return false;   // 字段漂移/脏值不猜 0
  }
  return true;
}
function r4MetaUsable(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (!("plan" in body) && !("wallet" in body)) return false;
  for (const k of ["plan", "wallet"]) {
    if (body[k] != null && (typeof body[k] !== "object" || Array.isArray(body[k]))) return false;
  }
  return true;
}
ADAPTERS.push({
  id: "r4", label: "R4 Coder", kind: "plan", defaultOn: true,
  envKeys: ["R4_API_KEY", "R4_CODER_API_KEY", "R4CODES_API_KEY"],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let u = null;
    try { u = new URL(cp.baseUrl); } catch (e) { return null; }
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    /* key 只发 r4 官方域；r4.codes 主站与 API 子域都只认这两个入口，路径不参与判定
     * （/v1、/v1/anthropic 等宿主 baseUrl 变体同域命中）。 */
    if (host === "api.r4.codes") return { key: cp.apiKey, origin: "cfg", apiOrigin: R4_API_ORIGIN };
    if (host === "r4.codes" || host === "www.r4.codes") return { key: cp.apiKey, origin: "cfg", apiOrigin: "https://" + host };
    return null;
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).r4 || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    if (ctx.key) return { token: ctx.key, fingerprint: "cfg:" + sha16(ctx.key), source: "provider_config" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const origin = ctx.apiOrigin || R4_API_ORIGIN;
    const headers = { authorization: "Bearer " + cred.token };
    const got = (p) => p.then((body) => ({ ok: true, body }), (error) => ({ ok: false, error }));
    const [keyR, metaR] = await Promise.all([
      got(j.http.getJson(origin + "/v1/cli/key", headers, ctl)),
      got(j.http.getJson(origin + "/v1/cli/meta", headers, ctl)),
    ]);
    const key = keyR.ok && r4KeyUsable(keyR.body) ? keyR.body : null;
    const meta = metaR.ok && r4MetaUsable(metaR.body) ? metaR.body : null;
    if (!key && !meta) throw (keyR.error || metaR.error || qErr("parse_error", "r4 shape"));
    const out = normalizeR4(key, meta);
    /* 无可展示额度且缺任一端点：只有两端都成功才判无订阅；请求失败按瞬时错误重试，
     * 绝不用 no_plan 把状态冻结到用户换 key。 */
    if (out && out.noPlan && (!meta || !key)) {
      throw (keyR.error || metaR.error || qErr("parse_error", "r4 shape"));
    }
    return out;
  },
});

/* --- 自定义中转（sub2api / OpenAI legacy；仅查询配置地址的同源） --- */
ADAPTERS.push({
  id: "custom", label: "中转站", kind: "balance", defaultOn: false,
  envKeys: [],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    return cp ? { cp } : null;
  },
  resolveCred(j, ctx) { return { token: ctx.cp.apiKey, fingerprint: "cfg:" + sha16(JSON.stringify([ctx.cp.apiKey, ctx.cp.baseUrl])), source: "provider_config" }; },   // 定界拼接防 "|" 歧义撞指纹
  async fetchOne(j, ctx, cred, ctl) {
    const cp = ctx.cp;
    const urls = relayQuotaUrls(cp.baseUrl);
    const headers = { authorization: "Bearer " + cred.token };
    let usage = null;
    try { usage = await j.http.getJson(urls.sub2api, headers, ctl); }
    catch (e) {
      if (!e || (e.code !== "parse_error" && e.httpStatus !== 404 && e.httpStatus !== 405)) throw e;
    }
    const detected = normalizeSub2api(usage);
    if (detected) return detected;
    const sub = await j.http.maybeGetJson(urls.legacy + "/dashboard/billing/subscription", headers, ctl);
    if (!sub) return null;   // 识别不了的网关：无可展示余额（unsupported 由调度器标注）
    const hard = num(sub.hard_limit_usd);
    if (hard == null || hard >= 1e8) return null;   // 按量后付无固定池
    const billed = await j.http.getJson(urls.legacy + "/dashboard/billing/usage", headers, ctl);
    const cents = billed && num(billed.total_usage);
    if (cents == null || cents < 0) throw qErr("parse_error", "legacy usage missing");
    return { balance: { amount: Math.round((hard - cents / 100) * 100) / 100, currency: "USD" } };
  },
});
const ADAPTER_BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

/* ---------- 预设模板（v102，⚙ 面板「预设模板」行） ----------
 * CC Switch / magpie 同款「选模板只填 Key」体验：presets 为官方域变体，选中值写入
 * secrets.sources.<id>.baseUrl（minimax 的可信域白名单机制，同款推广到 siliconflow）；
 * keyUrl 是控制台取 Key 页。纯静态白名单数据，key 绝不进预设；未列出的源无模板行。 */
const SOURCE_PRESETS = {
  minimax: {
    keyUrl: "https://platform.minimaxi.com",
    presets: [
      { label: "国内站", labelEn: "China", value: "https://api.minimaxi.com" },
      { label: "国际站", labelEn: "Global", value: "https://api.minimax.io" },
    ],
  },
  siliconflow: {
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    presets: [
      { label: "中国站 ¥", labelEn: "China ¥", value: "https://api.siliconflow.cn" },
      { label: "国际站 $", labelEn: "Global $", value: "https://api.siliconflow.com" },
    ],
  },
  deepseek: { keyUrl: "https://platform.deepseek.com/api_keys" },
  openrouter: { keyUrl: "https://openrouter.ai/settings/keys" },
  r4: { keyUrl: "https://r4.codes/dashboard/api-keys" },
  kimi: { keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  anthropic: { keyUrl: "https://console.anthropic.com/settings/keys" },
  mimo: { keyUrl: "https://platform.xiaomimimo.com" },
  volcano: { keyUrl: "https://console.volcengine.com/ark" },
  qianwen: { keyUrl: "https://platform.qianwenai.com" },
};

