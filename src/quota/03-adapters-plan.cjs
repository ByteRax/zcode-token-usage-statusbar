/* ---------- 适配器注册表 ----------
 * 契约：{id, label, kind, envKeys[], defaultOn, unverified?,
 *   detect(j, providerId) → ctx|null   （providerId 驱动的零配置发现；返回 null=不命中）
 *   resolveCred(j, ctx) → {token|cookie|ak|sk|none, fingerprint, source} | null | {decryptFailed}
 *   fetchOne(j, ctx, cred, ctl) → value | {noPlan:true}   （抛 qErr 分类错误）}
 * j = {env, now, fetchImpl, readFile, secrets, customCfgPath, customProviderOf, log, http} */
const ADAPTERS = [];

/* --- BigModel / Z.ai 内置套餐（主链，v96 同款） --- */
for (const fam of ["bigmodel", "zai"]) {
  const conf = fam === "bigmodel"
    ? { credKey: "oauth:bigmodel:access_token", origin: "https://bigmodel.cn", bearer: false,
        envKeys: ["ZCODE_BIGMODEL_USAGE_API_KEY", "BIGMODEL_USAGE_API_KEY"], envUrl: "ZCODE_BIGMODEL_USAGE_QUOTA_URL", subPath: "/api/biz/subscription/list" }
    : { credKey: "oauth:zai:access_token", origin: "https://api.z.ai", bearer: true,
        envKeys: [], envUrl: "", subPath: null };
  ADAPTERS.push({
    id: fam, label: fam === "bigmodel" ? "BigModel" : "Z.ai", kind: "plan", defaultOn: false, envKeys: conf.envKeys,
    detect(j, providerId) {
      if (providerId.indexOf("account:") !== 0) return null;
      if (isTeamProviderId(providerId)) return { team: true };
      if (providerId.indexOf("account:" + fam) === 0) return { family: fam };
      return null;
    },
    resolveCred(j, ctx) {
      for (const k of conf.envKeys) {
        const v = j.env[k];
        if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
      }
      const configured = ((j.secrets.sources || {})[fam] || {}).apiKey;
      if (typeof configured === "string" && configured) return { token: configured, fingerprint: "sec:" + sha16(configured), source: "secrets" };
      if (ctx.apiKeyProvider) {
        const key = j.familyApiKeyOf(fam, ctx.apiKeyProvider);
        if (key) return { token: key, fingerprint: "cfg:" + sha16(key), source: "provider_config" };
      }
      let raw = null;
      try { raw = j.readFile(j.credsPath); } catch (e) { return null; }
      const enc = raw && typeof raw === "object" ? raw[conf.credKey] : null;
      if (typeof enc !== "string" || !enc) return null;
      const token = decryptValue(enc, deriveCipherKey(j.env));   // v2 信封由 decryptValue 分发器经 defaultDec 解（上游 #289 架构）
      if (!token) return { decryptFailed: true, fingerprint: "host:" + sha16(enc) };
      return { token, fingerprint: "host:" + sha16(enc), source: "host" };
    },
    async fetchOne(j, ctx, cred, ctl) {
      const url = (conf.envUrl && j.env[conf.envUrl]) || conf.origin + QUOTA_PATH;
      /* 订阅元数据与额度并行（仅 bigmodel）；失败静默降级不拖累额度 */
      const subFetch = (conf.subPath && ctx.family === "bigmodel")
        ? j.http.maybeGetJson(conf.origin + conf.subPath, { authorization: cred.token }, ctl) : Promise.resolve(null);
      subFetch.catch(() => { });
      const body = await j.http.getJson(url, { authorization: (conf.bearer ? "Bearer " : "") + cred.token }, ctl);
      const value = normalizeQuotaBody(body);
      if (value && value.noPlan) return { noPlan: true };
      const plan = await subFetch;
      const sub = plan ? normalizeSubscriptionPlan(plan, j.now()) : null;
      return sub ? Object.assign({}, value, { plan: sub }) : value;
    },
  });
}

/* --- 团队套餐（GLM Coding Plan team，配方转写自 magpie zcode_team.go，MIT） ---
 * 成员账号与个人套餐同端点服务，但鉴权用业务登录 token（oauth:{fam}:access_token）、
 * 必须带团队头 Bigmodel-Organization/Bigmodel-Project，配额走 ?type=2
 * （CREDIT_LIMIT unit3=5 小时、unit6=周，TIME_LIMIT=MCP 月度工具调用、不阻断模型）。
 * 选择读 setting.json（恒在 HOME/.zcode/v2，不随 dataBaseDir 迁移）：
 * providerFamilyConnectionSelections[fam]={kind:"team-coding-plan",organizationId,projectId}；
 * legacy modelProviderFamilySelectedKeys[fam]="team-plan:builtin:{fam}-coding-plan:{org}:{project}"
 * （org/project 各段 URL 编码）。无选择=未切团队：fail-closed 不发请求。BigModel 家族里
 * 业务 token 与 zcodejwttoken 解密相同视为陈旧令牌，跳过（ZCode 也不会用它，magpie 同款）。 */
function teamSelectionOf(j, fam) {
  try {
    const set = j.readFile(j.settingPath || path.join(os.homedir(), ".zcode", "v2", "setting.json"));
    if (!set || typeof set !== "object") return null;
    let org = "", project = "";
    const sel = (set.providerFamilyConnectionSelections || {})[fam];
    if (sel && sel.kind === "team-coding-plan") {
      org = String(sel.organizationId || "").trim();
      project = String(sel.projectId || "").trim();
    } else {
      const legacy = String((set.modelProviderFamilySelectedKeys || {})[fam] || "").trim();
      const prefix = "team-plan:builtin:" + fam + "-coding-plan:";
      if (legacy.indexOf(prefix) === 0) {
        const parts = legacy.slice(prefix.length).split(":");
        if (parts.length === 3) {
          try { org = decodeURIComponent(parts[1]); project = decodeURIComponent(parts[2]); } catch (e) { return null; }
        }
      }
    }
    if (!org || !project) return null;
    return { org, project };
  } catch (e) { return null; }
}
for (const teamFam of ["bigmodel", "zai"]) {
  const teamOrigin = teamFam === "bigmodel" ? "https://bigmodel.cn" : "https://api.z.ai";
  const teamBearer = teamFam === "zai";   // BigModel 业务 token 裸 Authorization，Z.ai 走 Bearer
  const teamCredKey = teamFam === "bigmodel" ? "oauth:bigmodel:access_token" : "oauth:zai:access_token";
  ADAPTERS.push({
    id: teamFam + "-team", label: teamFam === "bigmodel" ? "BigModel 团队套餐" : "Z.ai 团队套餐", kind: "plan", defaultOn: false, envKeys: [],
    detect(j, providerId) { return teamFamilyOf(providerId) === teamFam ? { family: teamFam, team: true } : null; },
    resolveCred(j, ctx) {
      const sel = teamSelectionOf(j, teamFam);
      if (!sel) return null;   // 未切到团队套餐：按未配置 fail-closed
      let raw = null;
      try { raw = j.readFile(j.credsPath); } catch (e) { return null; }
      const enc = raw && typeof raw === "object" ? raw[teamCredKey] : null;
      if (typeof enc !== "string" || !enc) return null;
      const token = decryptValue(enc, deriveCipherKey(j.env));   // v2 信封由分发器解
      if (!token) return { decryptFailed: true, fingerprint: "host:" + sha16(enc) };
      if (teamFam === "bigmodel") {
        const jwtEnc = raw["zcodejwttoken"];
        if (typeof jwtEnc === "string" && jwtEnc) {
          const jwt = decryptValue(jwtEnc, deriveCipherKey(j.env));
          if (jwt && jwt.trim() === token.trim()) return null;   // 陈旧业务令牌：ZCode 也不会用
        }
      }
      return { token: token.trim(), fingerprint: "team:" + sha16(JSON.stringify([teamFam, sel.org, sel.project, enc])),
               source: "host", team: { org: sel.org, project: sel.project } };
    },
    async fetchOne(j, ctx, cred, ctl) {
      const body = await j.http.getJson(teamOrigin + QUOTA_PATH + "?type=2", {
        authorization: (teamBearer ? "Bearer " : "") + cred.token,
        "Bigmodel-Organization": cred.team.org,
        "Bigmodel-Project": cred.team.project,
        "set-language": "zh",
      }, ctl);
      const value = normalizeQuotaBody(body);
      if (value && value.noPlan) return { noPlan: true };
      return value;
    },
  });
}
/* --- ZCode Start Plan（免费档发放池：zcode.z.ai 账号级权益，OAuth zcodejwttoken 零配置） ---
 * 与 coding plan 是两条独立链：monitor/subscription 只返回编码套餐订阅，Start Plan 的
 * 权益/额度只在 zcode-plan billing/balance（宿主 getStartPlanSnapshot 同源端点）。
 * 鉴权必须用 zcodejwttoken（OAuth access_token 实测 401），且必须带 X-Device-Mid
 * （缺头实测 HTTP 400 code 3001 parameter error）；app_version 参数实测可省略。
 * bigmodel/zai 两个家族的 start-plan 走同一端点同一凭据键；zai 侧未实测真实账号。 */
const ZCODE_START_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
function zcodeStartDetectOf(providerId) {
  return providerId.indexOf("account:bigmodel-start-plan") === 0 || providerId.indexOf("account:zai-start-plan") === 0;
}
function readZcodeDeviceMid(j) {   // 宿主设备号：与 credentials.json 同目录的遥测状态文件
  const dir = path.dirname(j.credsPath);
  for (const name of ["telemetry-state.json", "onboarding-record.json"]) {
    let d = null;
    try { d = j.readFile(path.join(dir, name)); } catch (e) { }
    const v = d && typeof d === "object" ? d.deviceMid : null;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
ADAPTERS.push({
  id: "zcode-start", label: "ZCode Start Plan", kind: "plan", defaultOn: false, envKeys: [],
  detect(j, providerId) {
    return zcodeStartDetectOf(providerId) ? { family: "zcode-start" } : null;
  },
  resolveCred(j, ctx) {
    const sec = (j.secrets.sources || {})["zcode-start"] || {};
    const apiKey = typeof sec.apiKey === "string" && sec.apiKey.trim() ? sec.apiKey.trim() : "";
    let token = "", source = "";
    if (apiKey) { token = apiKey; source = "secrets"; } else {
      let raw = null;
      try { raw = j.readFile(j.credsPath); } catch (e) { return null; }
      const enc = raw && typeof raw === "object" ? raw["zcodejwttoken"] : null;
      if (typeof enc !== "string" || !enc) return null;
      token = decryptValue(enc, deriveCipherKey(j.env));
      if (!token) return { decryptFailed: true, fingerprint: "host:" + sha16(enc) };
      source = "host";
    }
    const deviceMid = readZcodeDeviceMid(j);
    if (!deviceMid) return null;   // 缺设备号必被服务端 3001 拒：fail-closed 不发请求
    return { token, deviceMid, fingerprint: sha16(JSON.stringify([token, deviceMid])), source };   // 定界拼接防 "|" 歧义撞指纹
  },
  async fetchOne(j, ctx, cred, ctl) {
    const body = await j.http.getJson(ZCODE_START_BALANCE_URL,
      { authorization: "Bearer " + cred.token, "X-Device-Mid": cred.deviceMid }, ctl);
    return normalizeZcodeStartBalance(body, j.now());
  },
});

/* --- MiniMax Token Plan（零配置：api.minimaxi.com/.cn/.io 自定义供应商；可信域可配） --- */
ADAPTERS.push({
  id: "minimax", label: "MiniMax", kind: "plan", defaultOn: true, unverified: true,
  envKeys: ["MINIMAX_API_KEY"],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    if (!cp.baseUrl && providerId === "minimax") return { domain: "https://api.minimaxi.com", key: cp.apiKey, origin: "cfg" };
    let host = "";
    try { host = new URL(cp.baseUrl).hostname; } catch (e) { return null; }
    if (host === "api.minimaxi.com" || host === "api.minimax.cn") return { domain: "https://api.minimaxi.com", key: cp.apiKey, origin: "cfg" };
    if (host === "api.minimax.io") return { domain: "https://api.minimax.io", key: cp.apiKey, origin: "cfg" };
    return null;
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).minimax || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    if (ctx.key) return { token: ctx.key, fingerprint: "cfg:" + sha16(ctx.key), source: "provider_config" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const rawDomain = ((j.secrets.sources || {}).minimax || {}).baseUrl || "";
    let host = "";
    try { host = rawDomain ? new URL(rawDomain).hostname : ""; } catch (e) { host = ""; }
    const trusted = host === "api.minimaxi.com" || host === "api.minimax.cn" || host === "api.minimax.io";   // 可信查询域白名单：key 不发任意域
    const domain = trusted ? rawDomain.replace(/\/+$/, "") : (ctx.domain || "https://api.minimaxi.com");
    let body;
    try {
      body = await j.http.getJson(domain + "/v1/api/openplatform/coding_plan/remains", { authorization: "Bearer " + cred.token }, ctl);
    } catch (e) {
      if (e && e.code !== "parse_error") throw e;
      body = await j.http.getJson("https://www." + (domain.indexOf(".io") >= 0 ? "minimax.io" : "minimaxi.com") + "/v1/token_plan/remains", { authorization: "Bearer " + cred.token }, ctl);   // dsh 旧端点兜底
    }
    const br = body && body.base_resp;
    if (br && num(br.status_code) !== 0) throw qErr(br.status_code === 401 || br.status_code === 403 ? "auth_failed" : "parse_error", "minimax base_resp " + br.status_code);
    const rows = Array.isArray(body && body.model_remains) ? body.model_remains : (Array.isArray(body && body.data && body.data.model_remains) ? body.data.model_remains : []);
    const row = rows.find((r) => r && String(r.model_name || "").toLowerCase() === "general") ||
      rows.find((r) => /^minimax-m/i.test(String((r || {}).model_name || ""))) ||
      rows.find((r) => r && (num(r.current_interval_remaining_percent) != null || num(r.current_weekly_remaining_percent) != null));
    if (!row) throw qErr("parse_error", "no general row");
    const windows = {};
    const five = num(row.current_interval_remaining_percent);
    if (five != null) windows.fiveHour = { percent: Math.round(clampPct(100 - five) * 10) / 10, resetsAt: resetOf(row.end_time) };
    if (num(row.current_weekly_status) === 1) {   // ==3 = 套餐无周限额（remaining 恒 100），必须跳过
      const wk = num(row.current_weekly_remaining_percent);
      if (wk != null) windows.weekly = { percent: Math.round(clampPct(100 - wk) * 10) / 10, resetsAt: resetOf(row.weekly_end_time) };
    }
    if (!Object.keys(windows).length) throw qErr("parse_error", "no minimax windows");
    return { windows };
  },
});

/* --- Kimi Code（订阅 usages，401/403 回落 moonshot PAYG 余额） --- */
ADAPTERS.push({
  id: "kimi", label: "Kimi", kind: "plan", defaultOn: true, unverified: true,
  envKeys: ["KIMI_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY"],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let u = "";
    try { u = new URL(cp.baseUrl); } catch (e) { return null; }
    if (u.hostname === "api.kimi.com" || u.hostname === "api.moonshot.cn") {
      return { key: cp.apiKey, origin: "cfg" };
    }
    return null;
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).kimi || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    if (ctx.key) return { token: ctx.key, fingerprint: "cfg:" + sha16(ctx.key), source: "provider_config" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const headers = { authorization: "Bearer " + cred.token, "user-agent": "KimiCLI/1.6" };
    let body = null;
    let authish = false;
    let lastErr = null;
    for (const p of ["/coding/v1/usages", "/coding/v1/usage"]) {
      try {
        body = await j.http.getJson("https://api.kimi.com" + p, headers, ctl);
        break;
      } catch (e) {
        if (e && (e.code === "auth_failed")) { authish = true; break; }   // 该 Key 非订阅 Key/无订阅 → 回落 PAYG
        lastErr = e;
        if (e && e.code !== "network_error" && e.code !== "parse_error") throw e;
      }
    }
    if (body && !authish) {
      const windows = {};
      const limits = Array.isArray(body.limits) ? body.limits : [];
      for (const e of limits) {   // 兼容 cc-switch（detail 直挂）与 dsh（window+detail）两形状
        if (!e || typeof e !== "object") continue;
        const d = e.detail || e;
        const limit = num(d.limit), remaining = num(d.remaining);
        if (limit == null || remaining == null || limit <= 0) continue;
        const pct = clampPct(((limit - remaining) / limit) * 100);
        if (!windows.fiveHour) {   // cc-switch 语义：limits 各行均属 5 小时窗，取首条有效行
          windows.fiveHour = { percent: Math.round(pct * 10) / 10, resetsAt: resetOf(d.resetTime) };
        }
      }
      const u = body.usage && typeof body.usage === "object" ? body.usage : null;
      if (u) {
        const limit = num(u.limit), remaining = num(u.remaining);
        if (limit != null && limit > 0 && remaining != null) {
          windows.weekly = { percent: Math.round(clampPct(((limit - remaining) / limit) * 100) * 10) / 10, resetsAt: resetOf(u.resetTime) };
        }
      }
      if (Object.keys(windows).length) return { windows };
    }
    /* PAYG 回落：moonshot 余额（人民币分）。仅订阅端点明确 401（authish）或已解析出订阅
     * 响应但无可展示窗口时回落；两端点都瞬时失败（network/parse_error）时不得拿 PAYG
     * 数据冒充套餐，按最后错误抛出走常规退避（2026-10-24 审计修复）。 */
    if (!body && !authish) throw (lastErr && lastErr.code) ? lastErr : qErr("network_error", "kimi subscription unreachable");
    const bal = await j.http.getJson("https://api.moonshot.cn/v1/users/me/balance", { authorization: "Bearer " + cred.token }, ctl);
    /* 余额字段逐级判 null 取值（零余额合法，不能用 || 短路——曾把 available_balance:0
     * 当解析失败打 30 分钟 parse_error 退避）。 */
    const raw = bal && (bal.available_balance != null ? bal.available_balance
      : bal.balance != null ? bal.balance
      : (bal.data && bal.data.available_balance != null) ? bal.data.available_balance
      : (bal.data && bal.data.balance !== undefined) ? bal.data.balance : null);
    const v = num(raw);
    if (v == null) throw qErr("parse_error", "kimi payg shape");
    const yuan = v >= 100 ? v / 100 : v;   // 分 → 元（≥100 视为分）
    return { balance: { amount: Math.round(yuan * 100) / 100, currency: "CNY" }, note: "PAYG" };
  },
});

/* --- CommandCode（控制面四连；credits 三分） --- */
ADAPTERS.push({
  id: "commandcode", label: "CommandCode", kind: "plan", defaultOn: true, unverified: true,
  envKeys: ["COMMANDCODE_API_KEY"],
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let u = "";
    try { u = new URL(cp.baseUrl); } catch (e) { return null; }
    if (u.hostname === "api.commandcode.ai") return { key: cp.apiKey, origin: "cfg" };
    return null;
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).commandcode || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    if (ctx.key) return { token: ctx.key, fingerprint: "cfg:" + sha16(ctx.key), source: "provider_config" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const H = { authorization: "Bearer " + cred.token };
    const who = await j.http.getJson("https://api.commandcode.ai/alpha/whoami?limits=1", H, ctl);
    // 个人订阅账号 whoami 返回 org:null，省略 orgId 即用户作用域（issue #73）；组织账号仍带 orgId
    const org = who && who.org;
    const orgId = org && org.id ? String(org.id) : "";
    if (org != null && !orgId) throw qErr("parse_error", "bad org shape");
    const scope = orgId ? "?orgId=" + encodeURIComponent(orgId) : "";
    const cred8 = await j.http.getJson("https://api.commandcode.ai/alpha/billing/credits" + scope, H, ctl);
    const c = (cred8 && (cred8.credits || cred8)) || {};
    const wl = (cred8 && (cred8.windowLimits || (cred8.credits && cred8.credits.windowLimits))) || null;
    const windows = {};
    if (wl && wl.limited) {
      for (const [k, name] of [["fiveHour", "fiveHour"], ["weekly", "weekly"]]) {
        const w = wl[k];
        const used = num(w && w.used), cap = num(w && w.cap);
        if (w && cap != null && cap > 0 && used != null) {
          windows[name] = { percent: Math.round(clampPct((used / cap) * 100) * 10) / 10, resetsAt: resetOf(w.resetAt) };
        }
      }
    }
    const subs = await j.http.getJson("https://api.commandcode.ai/alpha/billing/subscriptions" + scope, H, ctl);
    const sd = (subs && (subs.data || subs)) || {};
    const periodStart = sd.currentPeriodStart, periodEnd = sd.currentPeriodEnd;
    let monthly = null;
    const sum = await j.http.getJson("https://api.commandcode.ai/alpha/usage/summary?since=" + encodeURIComponent(String(periodStart || "")) + (orgId ? "&orgId=" + encodeURIComponent(orgId) : ""), H, ctl);
    const totalCost = num(sum && sum.totalCost);
    const parts = [
      ["monthly", num(c.monthlyCredits)], ["purchased", num(c.purchasedCredits)], ["free", num(c.freeCredits)],
    ].filter(([, v]) => v != null);
    const remainTotal = parts.reduce((a, [, v]) => a + v, 0);
    if (totalCost != null && (totalCost > 0 || remainTotal > 0)) {
      monthly = { percent: Math.round(clampPct((totalCost / Math.max(totalCost + remainTotal, 1e-9)) * 100) * 10) / 10, resetsAt: resetOf(periodEnd) };
    }
    if (monthly) windows.monthly = monthly;
    const out = {};
    if (Object.keys(windows).length) out.windows = windows;
    if (parts.length) {
      out.balance = { amount: Math.round(remainTotal * 100) / 100, currency: "CR",
        parts: parts.map(([label, v]) => ({ label: { monthly: "月度", purchased: "购买", free: "免费" }[label] || label, amount: v })) };
    }
    if (!out.windows && !out.balance) throw qErr("parse_error", "commandcode empty");
    if (sd.planId) out.plan = { version: "", productName: String(sd.planId).slice(0, 40), validStart: "", validEnd: "" };
    return out;
  },
});

/* --- Cline Pass（配置型：独立 Key；三窗口已用%） --- */
ADAPTERS.push({
  id: "cline", label: "Cline Pass", kind: "plan", defaultOn: false, unverified: true,
  envKeys: ["CLINE_API_KEY"],
  detect() { return null; },
  resolveCred(j) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).cline || {};
    if (sec.apiKey) return { token: sec.apiKey, fingerprint: "sec:" + sha16(sec.apiKey), source: "secrets" };
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const body = await j.http.getJson("https://api.cline.bot/api/v1/users/me/plan/usage-limits", { authorization: "Bearer " + cred.token }, ctl);
    const windows = collectWindows(body && body.data && body.data.limits,
      [["five_hour", "fiveHour"], ["fivehour", "fiveHour"], ["weekly", "weekly"], ["monthly", "monthly"]]);
    if (!Object.keys(windows).length) throw qErr("parse_error", "cline empty");
    return { windows };
  },
});

/* --- Anthropic Claude Pro/Max（OAuth 自动发现 ~/.claude/.credentials.json） --- */
ADAPTERS.push({
  /* 显式启用（非零配置默认）：凭据自动发现读的是第三方应用 Claude Code 的凭据文件，
   * 属跨应用读取，必须用户在 ⚙ 单独打开（披露句随面板/README）。 */
  id: "anthropic", label: "Anthropic", kind: "plan", defaultOn: false, unverified: true,
  envKeys: ["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  detect() { return null; },
  resolveCred(j) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).anthropic || {};
    if (sec.token) return { token: sec.token, fingerprint: "sec:" + sha16(sec.token), source: "secrets" };
    try {   // 自动发现：Claude Code 凭据文件（披露已列明）
      const p = path.join(os.homedir(), ".claude", ".credentials.json");
      const d = j.readFile(p);
      const tok = d && d.claudeAiOauth && d.claudeAiOauth.accessToken;
      if (typeof tok === "string" && tok) return { token: tok, fingerprint: "claude:" + sha16(tok), source: "claude-file" };
    } catch (e) { /* 未装 Claude Code / 文件不存在：按未配置 */ }
    return null;
  },
  async fetchOne(j, ctx, cred, ctl) {
    const body = await j.http.getJson("https://api.anthropic.com/api/oauth/usage", { authorization: "Bearer " + cred.token }, ctl);
    const windows = {};
    for (const [src, name] of [["five_hour", "fiveHour"], ["seven_day", "weekly"]]) {
      const w = body && body[src];
      if (!w || typeof w !== "object") continue;
      let pct = num(w.utilization);
      if (pct == null) pct = num(w.used_percentage);
      if (pct == null || !isFinite(pct) || pct < 0) continue;
      windows[name] = { percent: Math.round(clampPct(pct) * 10) / 10, resetsAt: resetOf(w.resets_at != null ? w.resets_at : w.reset_at) };
    }
    if (!Object.keys(windows).length) throw qErr("parse_error", "anthropic empty");
    return { windows };   // 子配额窗（seven_day_sonnet 等）整体丢弃，不覆盖主窗
  },
});

