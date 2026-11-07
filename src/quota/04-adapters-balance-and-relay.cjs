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
  detect() { return null; },
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
    if (Object.keys(windows).length) return { windows, planName: tag };
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
    return { windows };
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

/* --- OpenCode Go（$10/月订阅；转写自 cc-switch coding_plan.rs，MIT，未真实账号实测） ---
 * 用量端点第一方未文档化：GET https://opencode.ai/zen/go/v1/usage，只认
 * Authorization: Bearer（与推理侧只认 x-api-key 相反）；响应
 * {usage:{rolling|weekly|monthly:{status,percent(已用0-100),resetsAt(ISO)}}}，
 * 端点不回金额。detect 较 cc-switch 的裸子串收严：host 精确 opencode.ai +
 * 路径 /zen/go 或其子路径（两档预设），防外域伪装；Zen 按量版 /zen/v1 无
 * 用量 API（cc-switch 实测 404）刻意不命中。 */
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
      resetsAt: pct > 0 ? resetOf(w.resetsAt) : null,   // percent=0 时 resetsAt 是 now+窗长占位值，丢弃
    };
  }
  if (!Object.keys(windows).length) throw qErr("parse_error", "opencode windows missing");
  return { label: "OpenCode Go", kind: "plan", windows: windows };
}

ADAPTERS.push({
  id: "opencode", label: "OpenCode Go", kind: "plan", defaultOn: true, unverified: true,
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
    let body;
    try {
      body = await j.http.getJson("https://opencode.ai/zen/go/v1/usage",
        { authorization: "Bearer " + cred.token }, ctl);
    } catch (e) {
      /* 403 EntitlementError：key 本身有效（Zen/Go 共用 workspace key）但无 Go 订阅——
       * 与 401 认证失败分开（classifyStatus 把 401/403 都归 auth_failed，此处按消息分流）。 */
      if (e && e.httpStatus === 403) return { noPlan: true };
      throw e;
    }
    return normalizeOpencodeGo(body);
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
  kimi: { keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  anthropic: { keyUrl: "https://console.anthropic.com/settings/keys" },
  mimo: { keyUrl: "https://platform.xiaomimimo.com" },
  volcano: { keyUrl: "https://console.volcengine.com/ark" },
};

