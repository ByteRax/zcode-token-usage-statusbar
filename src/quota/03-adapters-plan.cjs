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
      const hit = hostCredDecrypt(raw, fam, conf.credKey, j.env);   // 旧平铺键缺席回退新式登录态键（issue #391）
      if (!hit) return null;
      if (!hit.token) return { decryptFailed: true, fingerprint: "host:" + sha16(hit.enc) };
      return { token: hit.token, fingerprint: "host:" + sha16(hit.enc), source: "host" };
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
/* 团队 PAT（项目访问令牌）交换链——宿主 ProjectAccessTokenClient 同款只读子集：
 * ① getCustomerInfo（裸业务 token）校验 org/project 存在；
 * ② api_keys 列表（裸业务 token + 团队头）找 name=zcode-team-api-key 且 keyType=2 的条目
 *    （缺条目不创建——宿主在 App 内切换团队套餐时自建，本插件只读）；
 * ③ POST api_keys/{id}/access_tokens（Bearer 业务 token，body clientType/clientVersion）
 *    → 项目级短期 PAT，用作 monitor?type=2 的 authorization（裸头，不套 Bearer）。
 *    {id} 就是条目的 apiKey 字段（线上条目没有 apiKeyId；宿主 ProjectAccessTokenClient 同款，
 *    issue #481）。
 * PAT 按 fam|org|project 缓存到过期前 2 分钟；密钥 ID 稳定一并缓存。链上任一环节失败
 * 按既有分类抛出（auth_failed/unsupported/network_error…），fail-closed 零请求降级。 */
const TEAM_PAT_REFRESH_LEAD = 120 * 1000;
const TEAM_PAT_CLIENT = { clientType: "zcode", clientVersion: "3.18.0" };
const teamPatCache = new Map();   // fam|org|project → { pat, expiresAt(ms), apiKey }
function teamPatCacheGet(key, now) {
  const c = teamPatCache.get(key);
  if (c && c.expiresAt - TEAM_PAT_REFRESH_LEAD > now) return c;
  return null;
}
async function ensureTeamPat(j, fam, sel, loginToken, ctl) {
  const bizOrigin = fam === "bigmodel" ? "https://bigmodel.cn" : "https://api.z.ai";
  const cacheKey = fam + "|" + sel.org + "|" + sel.project;
  const now = typeof j.now === "function" ? j.now() : Date.now();
  const hit = teamPatCacheGet(cacheKey, now);
  if (hit) return hit.pat;
  const teamHeaders = {
    "Bigmodel-Organization": sel.org,
    "Bigmodel-Project": sel.project,
    "set-language": "zh",
  };
  /* ① org/project 存在性（裸业务 token，不套 Bearer——宿主 getCustomerInfo 同款） */
  const info = await j.http.getJson(bizOrigin + "/api/biz/customer/getCustomerInfo",
    { authorization: loginToken }, ctl);
  const orgs = info && info.data && Array.isArray(info.data.organizations) ? info.data.organizations : [];
  const orgHit = orgs.some((o) => o && o.organizationId === sel.org &&
    Array.isArray(o.projects) && o.projects.some((pj) => pj && pj.projectId === sel.project));
  if (!orgHit) throw qErr("unsupported", "team project unavailable");
  /* ② api_keys 列表找 keyType=2 团队条目（只读，不创建——创建属宿主 App 内切换行为） */
  const keysUrl = bizOrigin + "/api/biz/v1/organization/" + encodeURIComponent(sel.org) +
    "/projects/" + encodeURIComponent(sel.project) + "/api_keys";
  const keys = await j.http.getJson(keysUrl, { authorization: loginToken, ...teamHeaders }, ctl);
  const keyList = keys && keys.data && Array.isArray(keys.data) ? keys.data : [];
  const teamKey = keyList.find((k) => k && k.name === "zcode-team-api-key" &&
    k.keyType === 2 && typeof k.apiKey === "string" && k.apiKey.trim());
  if (!teamKey) throw qErr("unsupported", "team api key missing");
  /* 密钥 ID 就是条目的 apiKey（issue #481）；`.` 与 `..` 是路径段保留写法——URL 规范化会吃掉上一级
   * 路径段（同源内，仍不该发），按没有团队密钥处理 */
  const teamKeyId = teamKey.apiKey.trim();
  if (teamKeyId === "." || teamKeyId === "..") throw qErr("unsupported", "team api key missing");
  /* ③ PAT 签发（Bearer 业务 token；429/5xx 一次重试，与宿主 MAX_TOKEN_ISSUE_ATTEMPTS 对齐） */
  let raw = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      raw = await j.http.post(keysUrl + "/" + encodeURIComponent(teamKeyId) + "/access_tokens", {
        authorization: "Bearer " + loginToken,
        "content-type": "application/json",
      }, ctl);
      break;
    } catch (e) {
      lastErr = e;
      const retryable = e && (e.code === "network_error" || e.code === "rate_limited");
      if (attempt >= 2 || !retryable) throw e;
      await new Promise((r2) => setTimeout(r2, 500));
    }
  }
  if (lastErr) throw lastErr;
  const patData = raw && raw.data && typeof raw.data === "object" ? raw.data : null;
  const pat = patData && patData.enable !== false && typeof patData.accessToken === "string" &&
    patData.accessToken.trim() ? patData.accessToken.trim() : null;
  if (!pat) throw qErr("unsupported", "team pat missing");
  /* issue #481（线上样本来自报告者抓包）：expiresAt 是秒级时间戳（与 expiresIn 同单位）——< 1e12
   * 视为秒换成毫秒，再与毫秒时钟比较（此前秒级值直接比较，缓存永不命中、每轮都重签 PAT）。
   * 非有限值或 ≥ 1e14 的离谱值按缺失处理，否则 PAT 会被永久缓存。 */
  const at = typeof patData.expiresAt === "number" ? patData.expiresAt : 0;
  const rawExpiresAt = Number.isFinite(at) && at > 0 && at < 1e14 ? at : 0;
  const ttlSec = typeof patData.expiresIn === "number" && Number.isFinite(patData.expiresIn) && patData.expiresIn > 0 ? patData.expiresIn : 3600;
  const expiresAt = rawExpiresAt ? (rawExpiresAt < 1e12 ? rawExpiresAt * 1000 : rawExpiresAt) : now + ttlSec * 1000;
  const cachedEntry = { pat, expiresAt, apiKey: teamKeyId };
  teamPatCache.set(cacheKey, cachedEntry);
  return cachedEntry.pat;
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
      const hit = hostCredDecrypt(raw, teamFam, teamCredKey, j.env);   // 旧平铺键缺席回退新式登录态键（issue #391）
      if (!hit) return null;
      const enc = hit.enc;
      const token = hit.token;
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
      /* monitor 鉴权=项目 PAT（宿主 resolveAccountTeamPlanRuntimeMaterial 同款）；
       * 业务 token 只用于换 PAT。 */
      const pat = await ensureTeamPat(j, teamFam, cred.team, cred.token, ctl);
      const body = await j.http.getJson(teamOrigin + QUOTA_PATH + "?type=2", {
        authorization: pat,
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

/* --- 千问 AI 平台 Token Plan（issue #399；端点与字段转写自 magpie qianwen_plan.go /
 * alibaba_usage.go（MIT），即官方 @qianwenai/qianwen-cli 1.11.0 的登录与用量读法） ---
 * 推理网关 token-plan.maas.qianwenaiapi.com（sk-sp- key）是纯推理入口：用量百分比只对
 * 平台登录态开放（sk-sp- key 查 cs-data 得 BailianGateway.Login.NotLogined）。链路：
 * 设备码（t.qianwenai.com）→ 浏览器授权 → access token（无 refresh，过期整链重登）→
 * 换控制台令牌（cli.qianwenai.com GenerateCLIAccessToken，按 access 指纹缓存 20 分钟）→
 * cs-data 网关查 per<N><Unit>Percentage 窗口（个人套餐=周/月两窗）。凭据只发 qianwen
 * 官方三域。阿里云百炼（token-plan.*.maas.aliyuncs.com）凭据是 AccessKey 签名链、
 * 本版不认领（落 custom 中转保持现状）；团队 seat 版的绝对 Credits 字段不解析。 */
const QIANWEN_UA = "qianwen-cli/1.11.0";
const QIANWEN_REGION = "cn-beijing";
const QIANWEN_USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const QIANWEN_CLI_TOKEN_TTL = 20 * 60 * 1000;   // magpie aliTokenTTL 同款
const QIANWEN_POLL_MAX_MS = 30 * 1000;   // 设备码轮询间隔经 slow_down 逐次翻长后的封顶
const qianwenCliTokens = new Map();   // access 指纹 → { token, at }（控制台令牌缓存）
const QIANWEN_WIN_RE = /^per(\d+)(Hour|Day|Week|Month)(Percentage|ResetTime)$/;
function qianwenUuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}
function qianwenPkce() {   // S256：verifier=32B base64url，challenge=sha256(verifier) base64url
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}
function qianwenExpiryMs(v) {   // ExpireTime：秒/毫秒数、数字串、日期串自适应（magpie qianwenTime 子集）
  if (typeof v === "number" && isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return isFinite(t) && t > 0 ? t : 0;
  }
  return 0;
}
/* device/token 轮询回复宽容解析（magpie readQianwenReply 同款两形状：Data.Credentials
 * 大写形与 credentials 小写形；数字/空值字段按缺省走，不连累整回复）。 */
function qianwenReadSigninReply(rep) {
  if (!rep || typeof rep !== "object" || Array.isArray(rep)) return null;
  const data = rep.Data && typeof rep.Data === "object" && !Array.isArray(rep.Data) ? rep.Data : null;
  const creds = data && data.Credentials && typeof data.Credentials === "object" ? data.Credentials : null;
  const alt = rep.credentials && typeof rep.credentials === "object" ? rep.credentials : null;
  const status = String((data && data.Status != null ? data.Status : rep.status) || "authorization_pending").toLowerCase();
  const access = String((creds && creds.AccessToken) || (alt && alt.access_token) || "");
  const expires = creds && creds.ExpireTime != null ? creds.ExpireTime : (alt && alt.expire_time != null ? alt.expire_time : null);
  const u = creds && creds.User && typeof creds.User === "object" ? creds.User
    : (alt && alt.user && typeof alt.user === "object" ? alt.user : null);
  const user = u ? String(u.Id != null ? u.Id : (u.id != null ? u.id : "")) : "";
  const email = u ? String(u.Email || u.email || "") : "";
  return { status, access, expires, account: email || user };
}
function qianwenStatusWordOf(rep) {   // HTTP ≥3xx 错误体里的状态词（magpie 只认这三个，正文不进错误文案）
  let hay = "";
  if (rep && typeof rep === "object") {
    const data = rep.Data && typeof rep.Data === "object" ? rep.Data : null;
    hay = String((data && data.Status) || rep.status || JSON.stringify(rep).slice(0, 500)).toLowerCase();
  }
  if (hay.indexOf("expired") >= 0) return "expired_token";
  if (hay.indexOf("access_denied") >= 0) return "access_denied";
  if (hay.indexOf("slow_down") >= 0) return "slow_down";
  return "";
}
/* 设备端点原始 POST：绕过 j.http 的严格 JSON.parse（回复可能带 BOM 前缀，magpie 实测案例），
 * 剥 BOM 后宽容解析；失败只抛状态错误，响应体绝不进错误文案（可能含 token）。 */
async function qianwenPost(j, ctl, url) {
  const res = await j.fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "user-agent": QIANWEN_UA },
    signal: ctl ? ctl.signal : undefined, redirect: "manual",
  });
  const text = await res.text();
  if (text.length > BODY_LIMIT) throw qErr("network_error", "qianwen reply too large");
  let parsed = null;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) { parsed = null; }
  if (res.status < 200 || res.status >= 300) {
    const err = qErr("network_error", "qianwen HTTP " + res.status);
    err.body = parsed;
    throw err;
  }
  return parsed;
}
async function qianwenMintCliToken(j, access, fp, ctl) {
  const hit = qianwenCliTokens.get(fp);
  const t = j.now();
  if (hit && t - hit.at < QIANWEN_CLI_TOKEN_TTL) return hit.token;
  const body = JSON.stringify({ product: "ModelStudioRegional", action: "GenerateCLIAccessToken",
    region: QIANWEN_REGION, params: {}, version: "2026-02-10" });
  const r = await j.http.post("https://cli.qianwenai.com/data/v2/api.json", {
    "content-type": "application/json", authorization: "Bearer " + access, "user-agent": QIANWEN_UA,
  }, ctl, body);
  const code = String((r && r.code) != null ? r.code : "");
  const tok = r && r.data && typeof r.data === "object" ? String(r.data.cliAccessToken || "").trim() : "";
  if (code === "200" && r.successResponse === true && tok && tok !== access) {
    qianwenCliTokens.set(fp, { token: tok, at: t });
    return tok;
  }
  qianwenCliTokens.delete(fp);
  if (/NeedLogin|NotLogined|NotLogin/i.test(code)) throw qErr("auth_failed", "qianwen session expired");
  if (code || (r && r.message)) throw qErr("network_error", ("qianwen mint " + (code || "error")).slice(0, 60));
  throw qErr("parse_error", "qianwen mint shape");
}
async function qianwenAskUsage(j, cliToken, ctl) {
  const url = "https://cs-data.qianwenai.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=" +
    encodeURIComponent(QIANWEN_USAGE_API);
  const params = JSON.stringify({ Api: QIANWEN_USAGE_API, V: "1.0", Data: { cornerstoneParam: {
    protocol: "V2", console: "ONE_CONSOLE", productCode: "p_efm", switchUserType: 3, consoleSite: "QIANWENAI" } } });
  const form = "params=" + encodeURIComponent(params) + "&region=" + QIANWEN_REGION;
  const r = await j.http.post(url, {
    "content-type": "application/x-www-form-urlencoded", authorization: "Bearer " + cliToken, "user-agent": QIANWEN_UA,
  }, ctl, form);
  const d = r && r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : null;
  if (d && d.success === false) {
    const code = String(d.errorCode != null ? d.errorCode : "");
    if (/NotLogined|NeedLogin|NotLogin/i.test(code)) throw qErr("auth_failed", "qianwen session expired");
    throw qErr("network_error", ("qianwen console " + (code || "error")).slice(0, 80));   // 只回 code：errorMsg 是服务端文本，不进错误链
  }
  let node = d && d.DataV2 != null ? d.DataV2 : null;   // 双层 {data:…} 剥壳（magpie 同款，缺层容忍）
  for (let i = 0; i < 2; i++) {
    if (node && typeof node === "object" && !Array.isArray(node) && node.data && typeof node.data === "object" && !Array.isArray(node.data)) node = node.data;
    else break;
  }
  return node;
}
function qianwenReadWindows(node) {
  const wins = {};
  if (!node || typeof node !== "object" || Array.isArray(node)) return wins;
  for (const k of Object.keys(node)) {
    const m = QIANWEN_WIN_RE.exec(k);
    if (!m) continue;
    const key = m[1] + m[2];
    const w = wins[key] || (wins[key] = { reset: null, used: null });
    if (m[3] === "ResetTime") w.reset = num(node[k]);
    else { const v = num(node[k]); if (v != null) w.used = v; }
  }
  const nameOf = { "5Hour": "fiveHour", "1Day": "daily", "1Week": "weekly", "1Month": "monthly" };
  const out = {};
  for (const key of Object.keys(wins)) {
    const w = wins[key];
    if (w.used == null || !isFinite(w.used) || w.used < 0) continue;
    const name = nameOf[key];
    if (!name || out[name]) continue;   // 未知窗长丢弃，绝不冒充已知窗口
    out[name] = { percent: Math.round(clampPct(w.used * 100) * 10) / 10, resetsAt: resetOf(w.reset) };
  }
  return out;
}
ADAPTERS.push({
  id: "qianwen", label: "千问 Token Plan", kind: "plan", defaultOn: true, unverified: true,
  envKeys: ["ZCODE_QIANWEN_ACCESS_TOKEN"],
  /* 官方域精确命中，或 qianwenaiapi.com 域内 + sk-sp- key 前缀（token-plan key 被用于
   * 同族其它网关路径时仍认领）；不按 provider 名判定（模板名与实际套餐常不一致，issue
   * 明示），qwencloud/aliyuncs 等同族异域不认领。sk-sp- 推理 key 不作额度凭据。 */
  detect(j, providerId) {
    if (providerId.indexOf("account:") === 0) return null;
    const cp = j.customProviderOf(providerId);
    if (!cp) return null;
    let host = "";
    try { host = new URL(cp.baseUrl).hostname.toLowerCase(); } catch (e) { host = ""; }
    if (host === "token-plan.maas.qianwenaiapi.com") return { config: true, family: "qianwen" };
    if (host.endsWith(".qianwenaiapi.com") && String(cp.apiKey || "").indexOf("sk-sp-") === 0) return { config: true, family: "qianwen" };
    return null;
  },
  resolveCred(j, ctx) {
    for (const k of this.envKeys) {
      const v = j.env[k];
      if (v) return { token: v, fingerprint: "env:" + sha16(v), source: "env" };
    }
    const sec = (j.secrets.sources || {}).qianwen || {};
    const token = typeof sec.token === "string" ? sec.token.trim() : "";
    if (!token) return null;
    const exp = num(sec.tokenExpiresAt);   // 平台登录态已过：无 refresh token，归未配置引导重登
    if (exp > 0 && j.now() > exp) return null;
    return { token, fingerprint: "sec:" + sha16(token), source: "secrets" };
  },
  async fetchOne(j, ctx, cred, ctl) {
    const fp = cred.fingerprint;
    let cliToken = await qianwenMintCliToken(j, cred.token, fp, ctl);
    let node;
    try {
      node = await qianwenAskUsage(j, cliToken, ctl);
    } catch (e) {
      /* 缓存的控制台令牌被网关拒（NotLogined）：重换一次新令牌；新令牌仍被拒=平台登录态
       * 已失效，auth_failed 冻结到重新登录（凭据指纹变化），绝不循环重试。 */
      if (e && e.code === "auth_failed" && qianwenCliTokens.has(fp)) {
        qianwenCliTokens.delete(fp);
        cliToken = await qianwenMintCliToken(j, cred.token, fp, ctl);
        node = await qianwenAskUsage(j, cliToken, ctl);
      } else throw e;
    }
    const windows = qianwenReadWindows(node);
    if (!Object.keys(windows).length) throw qErr("parse_error", "qianwen: no personal plan windows");   // 团队 seat 账号/未购个人套餐：不显示 0%
    return { label: "千问 Token Plan", kind: "plan", windows };
  },
});

/* ---------- 千问设备码登录流（⚙ 面板「登录」按钮驱动；每个 client 实例一条） ----------
 * 状态机 idle→pending→done/failed；gen 是唯一存活令牌（重开/取消/dispose 都 +1，在途
 * 轮询按 gen 自弃）。完成经 saveSecrets（注入侧 writeQuotaSecrets）持久化 token/account/
 * tokenExpiresAt → credentialsChanged → 解冻即查。错误文案绝不引用响应体（可能含 token，
 * magpie 有真实泄露事故）。 */
function installQianwenFlow(client, j, o) {
  const flow = { state: "idle", error: "", url: "", account: "", gen: 0, timer: 0 };
  const armTimer = (ms, fn) => {
    flow.timer = setTimeout(() => { flow.timer = 0; fn(); }, ms);
    if (flow.timer && typeof flow.timer.unref === "function") flow.timer.unref();
  };
  const armPoll = (ctl, url) => {   // 单次轮询 15s 超时兜底：挂死不至于冻结整流（重开即恢复）
    const kill = setTimeout(() => { try { ctl.abort(); } catch (e) { } }, 15 * 1000);
    if (kill && typeof kill.unref === "function") kill.unref();
    return qianwenPost(j, ctl, url).finally(() => { clearTimeout(kill); });
  };
  function finish(state, error) {
    flow.state = state;
    flow.error = error || "";
    flow.url = "";   // 终态一律清：授权页 URL 带设备码 auth_token，done/failed 后渲染端都不再需要
  }
  function flowCancel() {
    flow.gen += 1;
    if (flow.timer) { clearTimeout(flow.timer); flow.timer = 0; }
    flow.state = "idle"; flow.error = ""; flow.url = ""; flow.account = "";
  }
  client.qianwenSignInState = () => ({ ok: true, state: flow.state, error: flow.error, url: flow.url, account: flow.account });
  client.qianwenSignInCancel = () => flowCancel();
  client.disposeQianwenFlow = () => flowCancel();
  client.qianwenSignInStart = async () => {
    if (!o || typeof o.saveSecrets !== "function") return { ok: false, error: "sign-in unavailable" };
    flowCancel();
    const gen = flow.gen;
    const clientID = qianwenUuid();
    const pk = qianwenPkce();
    let codeRep = null, codeErr = null;
    const startCtl = new AbortController();
    try {
      codeRep = await armPoll(startCtl, "https://t.qianwenai.com/cli/device/code?client_id=" + encodeURIComponent(clientID) +
        "&code_challenge=" + encodeURIComponent(pk.challenge) + "&code_challenge_method=S256");
    } catch (e) { codeErr = e; }
    if (gen !== flow.gen) return { ok: false, error: "cancelled" };
    const d = codeRep && codeRep.Data && typeof codeRep.Data === "object" ? codeRep.Data : null;
    const deviceToken = d && typeof d.Token === "string" ? d.Token : "";
    /* 授权页 URL 域白名单（官方=account.qianwenai.com）：服务端可控串不经白名单不交 openExternal。
     * 交出去的是 URL 解析归一后的 href——原始串里的首尾空白/控制字符不随 openExternal
     * 出门；带 userinfo 的「evil.com@account.qianwenai.com」形（地址栏可误导）直接拒。 */
    let url = "";
    if (d && typeof d.VerificationUrl === "string") {
      try {
        const u = new URL(d.VerificationUrl);
        url = u.protocol === "https:" && !u.username && !u.password &&
          u.hostname.toLowerCase().endsWith(".qianwenai.com") ? u.href : "";
      } catch (e) { url = ""; }
    }
    if (codeErr && codeErr.body) {   // HTTP ≥3xx：只嗅状态词，正文不进文案
      const word = qianwenStatusWordOf(codeErr.body);
      if (word === "expired_token") { finish("failed", "设备码已过期，请重试"); return { ok: false, error: flow.error }; }
    }
    if (!codeRep || !d || !deviceToken || !url) {
      finish("failed", "无法发起千问登录" + (codeErr ? "（" + String(codeErr.message || "network").slice(0, 40) + "）" : ""));
      return { ok: false, error: flow.error };
    }
    const everyMs = Math.min(Math.max((num(d.Interval) > 0 ? num(d.Interval) : 2) * 1000, 100), 2000);
    const deadline = j.now() + Math.min(Math.max((num(d.ExpiresIn) > 0 ? num(d.ExpiresIn) : 300) * 1000, 30 * 1000), 15 * 60 * 1000);
    let curMs = everyMs;
    flow.state = "pending";
    flow.url = url;
    const poll = async () => {
      if (gen !== flow.gen) return;
      if (j.now() >= deadline) { finish("failed", "登录页已过期，请重新登录"); return; }
      const ctl = new AbortController();
      let rep = null, netErr = null;
      try { rep = await armPoll(ctl, "https://t.qianwenai.com/cli/device/token?client_id=" + encodeURIComponent(clientID) +
        "&token=" + encodeURIComponent(deviceToken) + "&code_verifier=" + encodeURIComponent(pk.verifier)); }
      catch (e) { netErr = e; }
      if (gen !== flow.gen) return;
      let parsed = rep ? qianwenReadSigninReply(rep) : null;
      if (netErr && netErr.body) {   // HTTP ≥3xx 错误体状态词（expired/access_denied/slow_down）
        parsed = { status: qianwenStatusWordOf(netErr.body) || "http_error", access: "", expires: null, account: "" };
      } else if (netErr) {
        parsed = { status: "authorization_pending", access: "", expires: null, account: "" };   // 掉线轮询重问（magpie 同款）
      } else if (rep && !parsed) {
        finish("failed", "平台返回未知形态，请重试");
        return;
      }
      /* 当前轮询间隔：slow_down 持续加长并沿用（RFC 8628 §3.5——加长后的间隔不回落，
       * 否则服务端要求的间隔高于客户端上限时会一直 slow_down 到 deadline），封顶 30s */
      if (parsed.status === "authorization_pending") { armTimer(curMs, poll); return; }
      if (parsed.status === "slow_down") { curMs = Math.min(curMs * 2, QIANWEN_POLL_MAX_MS); armTimer(curMs, poll); return; }
      if (parsed.status === "complete") {
        if (!parsed.access) { finish("failed", "平台未返回令牌，请重试"); return; }
        const expMs = qianwenExpiryMs(parsed.expires);
        try {
          o.saveSecrets((sec) => {
            sec.qianwen = Object.assign({}, sec.qianwen || {}, { token: parsed.access, account: parsed.account });
            if (expMs > 0) sec.qianwen.tokenExpiresAt = expMs; else delete sec.qianwen.tokenExpiresAt;
          });
        } catch (e) { finish("failed", "登录态保存失败"); return; }
        if (gen !== flow.gen) return;   // 保存与取消竞窗：凭据已落盘无害（下次登录覆盖同字段）
        flow.account = parsed.account;
        finish("done", "");
        return;
      }
      if (parsed.status === "expired_token") { finish("failed", "登录页已过期，请重新登录"); return; }
      if (parsed.status === "access_denied") { finish("failed", "授权被拒绝"); return; }
      if (parsed.status === "http_error") { armTimer(curMs, poll); return; }   // 未知 HTTP 错误：按瞬时重问
      finish("failed", "平台返回未知状态，请重试");   // 服务端 Status 串不进错误链（与 usage 错误同口径）
    };
    armTimer(everyMs, poll);
    return { ok: true, url, state: "pending" };
  };
}

