
function createModelPuller(opts) {
  const o = opts || {};
  const customCfgPath = String(o.customCfgPath || "");
  /* 宿主打包的内置配置（resources/config/provider/zcode-builtin.json）：模板创建的
   * 供应商（如 opencode-go-chat）个人规则只存 templateId + apiKey，baseUrl/protocol
   * 在 templateRules。issue #123 已在额度链合并模板；增强链同样需要。
   * 缺省由 Electron 主进程的 resourcesPath 推导：热更 model-puller 时无需同时换冷文件
   * inject-main.cjs；宿主显式 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 时让位（非空判定与
   * resolveHostQuotaPaths 同款，空串按未设处理；让位=不猜打包副本，env 文件本体由冷 loader 经
   * resolveQuotaPaths 传入）；Node 测试环境无 resourcesPath，仍由调用方显式传 builtinCfgPath。 */
  const builtinCfgPath = String(o.builtinCfgPath || (!process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && process.resourcesPath ? path.join(process.resourcesPath, "config", "provider", "zcode-builtin.json") : ""));
  const log = o.log || function () { };
  const fetchImpl = o.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const modelsDevUrl = o.modelsDevUrl === undefined ? MODELS_DEV_URL : String(o.modelsDevUrl);
  const modelsDevApiUrl = o.modelsDevApiUrl === undefined ? MODELS_DEV_API_URL : String(o.modelsDevApiUrl);
  const catalogGraceMs = Number.isFinite(Number(o.catalogGraceMs)) && Number(o.catalogGraceMs) >= 0 ? Number(o.catalogGraceMs) : CATALOG_GRACE_MS;
  const cachePath = String(o.cachePath || "");   // 档位索引落盘路径（运行目录，inject-main 传入）；空=仅内存（测试）
  const credentialsPath = String(o.credentialsPath || "");   // 宿主 OAuth 凭据（套餐源）
  const decryptValue = typeof o.decryptValue === "function" ? o.decryptValue : null;   // 注入解密（主进程内存解密）
  const credEnv = o.env && typeof o.env === "object" ? o.env : process.env;   // v1 信封派生钥环境（生产缺省 process.env，同注入闭包口径）
  /* 宿主 appVersion：GLr 换发体 clientVersion（specs/plan-glr-credential.md）。本文件由
   * inject-main 在 Electron 主进程 require，可直接取 app.getVersion()；测试/独立链无
   * electron 模块 → catch 兜空，body 省略该字段。opts.hostVersion 仅供测试注入覆写。 */
  const hostVersion = String(o.hostVersion || (function () {
    try {
      const { app } = require("electron");
      return app && typeof app.getVersion === "function" ? String(app.getVersion()) : "";
    } catch (e) { return ""; }
  })());
  let disposed = false;
  let applyBusy = false;   // 读-改-写竞态闸：UI 正常路径不会并发，这里防异常路径双写互相覆盖
  let catalogCache = null;   // {at, entries}：目录全量约数百 KB，成功后进程内复用
  let catalogFailedAt = 0;   // 目录失败短缓存：不通的网络环境（代理断连）每次拉取都吃满超时不可接受
  let apiCatalogCache = null;   // {at, index}：api.json 档位索引（#236），文件缓存的进程内副本
  let apiCatalogFailedAt = 0;
  let apiCatalogPending = null;   // 在途拉取 promise：防重复触发
  const fetchCache = new Map();   // providerId → {metaById}：applyModels 只收 id（写入字段不受渲染端注入），metaById 仅供弹窗展示
  let templateRulesCache = null;   // {stamp, byId}：模板源 stat 变化即重读（宿主升级/个人覆盖）

  function readProviderCfg() {
    try {
      const d = JSON.parse(fs.readFileSync(customCfgPath, "utf8"));
      if (!d || typeof d !== "object") return null;
      return d;
    } catch (e) { return null; }
  }
  function rulesOf(data) {
    /* 非数组（损坏/手改）一律按空处理：findRule/listProviders 的 for-of 不能被
     * truthy 非可迭代值炸掉，损坏结构走各调用方的 fail-closed 拒绝路径 */
    const rules = (((data || {}).config || {}).providerConfigRules || {}).providerRules;
    return Array.isArray(rules) ? rules : [];
  }
  /* 模板规则：内置 zcode-builtin.json + 个人 provider_config.json 的
   * config.providerConfigRules.templateRules（后者覆盖前者，与 quota-client.loadProviderCfg
   * 同序）。模板创建的供应商个人规则只存 templateId + 凭据，baseUrl/protocol 由模板提供。
   * 按两文件 stat（mtime/ctime/birthtime/size/ino/dev）缓存；stat 失败清缓存，删除后同
   * mtime/size 重建也不会复活旧模板。ino/dev 兜底 Windows 文件隧道化：15 秒内同名重建
   * 会被 NTFS 复用原 birthtime（ctime 在时间戳 tick 内重建时也可相同），只有文件实例 ID 必变。 */
  function readTemplateRules() {
    const paths = [builtinCfgPath, customCfgPath].filter(Boolean);
    if (!paths.length) return new Map();
    const stampParts = [], readable = [];
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        stampParts.push(p + ":" + st.mtimeMs + ":" + st.ctimeMs + ":" + st.birthtimeMs + ":" + st.size + ":" + st.ino + ":" + st.dev);
        readable.push(p);
      } catch (e) {
        stampParts.push(p + ":missing");
        templateRulesCache = null;   // 源文件消失：旧缓存不可再复活（同 quota-client 缓存纪律）
      }
    }
    const stamp = stampParts.join("|");
    if (templateRulesCache && templateRulesCache.stamp === stamp) return templateRulesCache.byId;
    const byId = new Map();
    let failed = false;
    for (const p of readable) {
      try {
        const d = JSON.parse(fs.readFileSync(p, "utf8"));
        const pcr = (((d || {}).config || {}).providerConfigRules) || {};
        for (const t of Array.isArray(pcr.templateRules) ? pcr.templateRules : []) {
          if (!t || !t.templateId) continue;
          const cfg = t.config || {}, old = byId.get(String(t.templateId)) || {};
          byId.set(String(t.templateId), {
            access: Object.assign({}, old.access, cfg.access && typeof cfg.access === "object" ? cfg.access : {}),
            api: Object.assign({}, old.api, cfg.api && typeof cfg.api === "object" ? cfg.api : {}),
          });
        }
      } catch (e) { failed = true; }   // 单个文件损坏/半写：保留已读到的模板，下次重读
    }
    if (failed) { templateRulesCache = null; return byId; }
    templateRulesCache = { stamp, byId };
    return byId;
  }
  /* 读取路径的有效供应商配置：按 templateId 合并模板，显式配置优先；
   * 显式空串 baseUrl 按未填处理回落模板（与 quota-client.loadProviderCfg 同口径）。
   * 只读：applyModels/probe 修复写回仍用原始 rule.config，绝不把模板字段落盘。 */
  function effectiveRuleConfig(rule) {
    const cfg = (rule && rule.config) || {};
    const access = cfg.access && typeof cfg.access === "object" ? cfg.access : {};
    const api = cfg.api && typeof cfg.api === "object" ? cfg.api : {};
    /* 只认显式 templateId：与宿主/quota 链一致。不能按 providerId 猜——宿主会按
     * 供应商名生成 slug，自定义供应商碰巧与模板同 id 时会把个人 key 发往官方端点。 */
    const tid = rule && rule.templateId ? String(rule.templateId) : "";
    const tpl = tid ? readTemplateRules().get(tid) : null;
    const mergedApi = Object.assign({}, tpl && tpl.api, api);
    if (!mergedApi.baseUrl && tpl && tpl.api) mergedApi.baseUrl = tpl.api.baseUrl;
    return Object.assign({}, cfg, { access: Object.assign({}, tpl && tpl.access, access), api: mergedApi });
  }
  function declaredModelIds(pcfg) {
    const ids = [];
    for (const key of ["personalModelIds", "modelOrder"]) {
      for (const mid of (pcfg && pcfg[key]) || []) {
        if (typeof mid === "string" && mid.trim() && !ids.includes(mid)) ids.push(mid);
      }
    }
    return ids;
  }
  /* api-key 型自定义供应商才可拉取/写入；套餐源（PLAN_SOURCES）另行放行；
   * coding-plan 型自定义规则的 baseUrl/模型由宿主管。
   * issue #383：按合并模板后的有效配置判定——模板供应商个人规则只存 templateId + key，
   * 读原始 config 会把 baseUrl 判空、整链（列表/拉取/探测/写入）全部不可用。
   * enabled:false（rule 级或 config 级）与增强链 modelPullerRuleAllowed 同口径拒绝。 */
  function isPullable(rule) {
    const cfg = effectiveRuleConfig(rule);
    const access = cfg.access || {}, api = cfg.api || {};
    if (access.type === "api-key" && !!api.baseUrl && modelPullerRuleAllowed(rule)) return true;
    return !!(isPlanProvider(rule && rule.providerId) && planTokenOf(rule.providerId));
  }
  function isPlanProvider(providerId) {
    return !!PLAN_SOURCES[String(providerId || "")];
  }
  /* 套餐 token：宿主 credentials.json 解密，只在内存流转（同额度链纪律：不落盘不进日志）。
   * 注入的 decryptValue 是 quota-client 的分发器（上游 #289）：v1/v2 双信封都能解，v2 密钥
   * 经 defaultDec 绑定的真实路径上下文取。本入口只被用户动作触达：先越过 v2 密钥的失败冷却
   * 与失配限频（钥匙串刚解锁时点一下就能拉到，不必等 60 秒）；密钥异步未热时本次为空、下次
   * 即可。取键与额度链同走 quota-client 的 hostCredDecrypt 单一实现（issue #393：宿主 3.18+
   * 新式登录态下旧平铺键整键缺席，业务 token 改存 linked_bigmodel/zai_cn 信封——旧键优先、
   * 缺失才回退；热换竞窗里旧 quota-client 无该导出时回退旧平铺键直读，联动热换后自愈）。
   * 仍带 enc: 前缀的结果一律作废——热换竞窗里旧模块闭包可能透传密文，绝不外发。 */
  function planTokenOf(providerId) {
    const src = PLAN_SOURCES[String(providerId || "")];
    if (!src || !credentialsPath || !decryptValue) return null;
    try {
      const quota = require("./quota-client.cjs");
      if (typeof quota.v2KeyRetryNow === "function") quota.v2KeyRetryNow();
      const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
      if (typeof quota.hostCredDecrypt === "function") {
        const hit = quota.hostCredDecrypt(raw, src.fam, src.credKey, credEnv, decryptValue);
        let token = hit && typeof hit.token === "string" ? hit.token : null;
        if (token && token.startsWith("enc:")) token = null;
        return token && token.trim() ? token.trim() : null;
      }
      const enc = raw && typeof raw === "object" ? raw[src.credKey] : null;
      if (typeof enc !== "string" || !enc) return null;
      let token = decryptValue(enc);
      if (typeof token === "string" && token.startsWith("enc:")) token = null;
      return token && String(token).trim() ? String(token).trim() : null;
    } catch (e) { return null; }
  }
  /* 宿主 v2/config.json 的 builtin 条目（issue #336）：增强鉴权与列表门控共用读取。 */
  function readV2BuiltinEntry(src) {
    if (!src || !src.v2ConfigKey || !customCfgPath) return null;
    try {
      const cfgPath = customCfgPath.replace(/provider_config\.json$/, "config.json");
      const d = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      return d && d.provider && typeof d.provider === "object" ? d.provider[src.v2ConfigKey] || null : null;
    } catch (e) { return null; }
  }
  /* 套餐增强鉴权（issue #336）：「宿主 v2/config.json 的 builtin provider options.apiKey
   * 优先（明文 key，宿主对话同款——同目录 config.json 与 provider_config.json 并置），
   * OAuth 兜底」——bigmodel coding plan 实测口径（OAuth 直连 messages 被网关 500 拒，
   * 2026-11-13）。缺失/带 enc: 前缀的 key 一律不作明文使用。两把凭据都只在内存与目标供应商请求中出现。 */
  function planKeyOf(providerId) {
    const src = PLAN_SOURCES[String(providerId || "")];
    if (!src || !customCfgPath) return planTokenOf(providerId);
    const entry = readV2BuiltinEntry(src);
    const key = entry && entry.options && typeof entry.options.apiKey === "string" ? entry.options.apiKey.trim() : "";
    return (key && key.indexOf("enc:") !== 0 ? key : null) || planTokenOf(providerId);
  }
  /* v2 条目明文 key 门（issue #429）：条目存在、未显式禁用、key 非空且非 enc: 才算可用。
   * planKeyOf 不查 enabled（individual/team 维持既有「条目 key 优先、OAuth 兜底」口径），
   * 增强链用它作 3.18 宿主（v2 config.json 在）的首选凭据——3.19.x 宿主已不再落盘该文件
   * （specs/plan-glr-credential.md），GLr 换发接管。 */
  function planEntryKeyOf(providerId) {
    const src = PLAN_SOURCES[String(providerId || "")];
    if (!src || !src.v2ConfigKey || !customCfgPath) return null;
    const entry = readV2BuiltinEntry(src);
    if (!entry || entry.enabled === false) return null;
    const key = entry.options && typeof entry.options.apiKey === "string" ? entry.options.apiKey.trim() : "";
    return key && key.indexOf("enc:") !== 0 ? key : null;
  }
  /* ---------- GLr 凭据换发（specs/plan-glr-credential.md）：宿主 3.19.x 对 builtin 套餐
   * （access.type=zhipu-account）运行时内存换发——OAuth token 换短期 access token，
   * v2/config.json 不再存在，插件的 OAuth 直连兜底（v344 实测 500 code 1234）随之失效。
   * 换发 token 只在内存（10 分钟 memo，凭据指纹变化即失效），绝不落盘/进日志/回渲染端。 */
  const GLR_MEMO_TTL_MS = 10 * 60 * 1000;
  const GLR_EXCHANGE_TIMEOUT_MS = 15000;
  const GLR_PLATFORM_PREFIX = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const glrMemo = { fp: "", token: "", at: 0 };
  function glrMemoToken() {
    return glrMemo.token && Date.now() - glrMemo.at < GLR_MEMO_TTL_MS ? glrMemo.token : null;
  }
  /* runtime builtin 配置（<v2>/runtime/provider/<平台>/<宿主版本>/endpoint-<hash>/zcode-builtin.json）：
   * 宿主 3.19.x 的权威套餐路由（start-plan → zcode.z.ai，individual/team → open.bigmodel.cn）。
   * 全量 stat stamp 缓存；多版本目录取最高 semver，先扫高版本先到先得；单文件损坏跳过。
   * 读不到（旧宿主/结构变化）返回 null，调用方回退 PLAN_SOURCES.baseUrl。 */
  let runtimeRouteCache = null;
  function runtimePlanRoute(providerId) {
    if (!customCfgPath) return null;
    const root = path.join(path.dirname(customCfgPath), "runtime", "provider");
    const candidates = [];
    let stamp = "";
    try {
      for (const plat of fs.readdirSync(root)) {
        if (String(plat).indexOf(GLR_PLATFORM_PREFIX) !== 0) continue;
        const platDir = path.join(root, plat);
        let versions = null;
        try { versions = fs.readdirSync(platDir); } catch (e) { continue; }
        for (const ver of versions) {
          const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(ver));
          if (!m) continue;
          const epDir = path.join(platDir, ver);
          let eps = null;
          try { eps = fs.readdirSync(epDir); } catch (e) { continue; }
          for (const ep of eps) {
            if (String(ep).indexOf("endpoint-") !== 0) continue;
            const file = path.join(epDir, ep, "zcode-builtin.json");
            let st = null;
            try { st = fs.statSync(file); } catch (e2) { continue; }
            if (!st.isFile()) continue;
            /* stamp 含 ino/dev：与 readTemplateRules 同纪律，防 Windows 同毫秒同名重建的
             * 文件隧道化钉死旧路由（review A-2/D-4d） */
            stamp += file + ":" + st.mtimeMs + ":" + st.ctimeMs + ":" + st.birthtimeMs + ":" + st.size + ":" + st.ino + ":" + st.dev + "|";
            candidates.push({ rank: (+m[1]) * 1e6 + (+m[2]) * 1e3 + (+m[3]), file: file });
          }
        }
      }
    } catch (e) { return null; }
    if (!candidates.length) return null;
    if (runtimeRouteCache && runtimeRouteCache.stamp === stamp) return runtimeRouteCache.byId[String(providerId || "")] || null;
    candidates.sort((a, b) => b.rank - a.rank);
    const byId = Object.create(null);
    for (const cand of candidates) {
      try {
        const d = JSON.parse(fs.readFileSync(cand.file, "utf8"));
        const rules = (((d || {}).config || {}).providerConfigRules || {}).providerRules;
        if (!Array.isArray(rules)) continue;
        for (const r of rules) {
          const pid = r && typeof r === "object" ? String(r.providerId || "") : "";
          const base = r && r.config && r.config.api && typeof r.config.api.baseUrl === "string" ? officialPlanBaseUrl(r.config.api.baseUrl) : null;
          if (pid && base && !byId[pid]) byId[pid] = base;   // 非家族官方域一律不收（review D-1：换发 token 与草稿只发白名单域）
        }
      } catch (e) { }
    }
    runtimeRouteCache = { stamp: stamp, byId: byId };
    return byId[String(providerId || "")] || null;
  }
  function planBaseUrl(providerId) {
    const src = PLAN_SOURCES[String(providerId || "")];
    if (!src) return "";
    return runtimePlanRoute(providerId) || src.baseUrl;
  }
  /* GLr 换发（异步，仅 bigmodel 家族增强路径使用）：location 键扫描 → 信封解密 →
   * POST access_tokens 换 token。location 缺失/解密失败/形状不符/换发失败一律 null
   * （enhanceText 回 plan_auth）；外部 signal 贯穿，超时 15s 自理。memo 键=OAuth 摘要
   * + location 键名——凭据或定位变化即失效。OAuth token 只发 bigmodel.cn 本域
   * （origin 已在 parseProjectLocationKeyName 校验）。 */
  async function planGLrTokenOf(providerId, externalSignal) {
    const src = PLAN_SOURCES[String(providerId || "")];
    if (!src || src.fam !== "bigmodel" || !credentialsPath || !decryptValue) return null;
    const oauth = planTokenOf(providerId);
    if (!oauth) return null;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8")); } catch (e) { return null; }
    if (!raw || typeof raw !== "object") return null;
    const locKey = Object.keys(raw).find((k) => {
      const p = parseProjectLocationKeyName(k);
      return !!p && p.family === "bigmodel" && p.team === null && p.usageScene === 1;
    });
    if (!locKey) return null;
    /* 指纹含信封串：宿主同键名重发 location（换 apiKeyId）时旧 memo 立即失效
     * （review A-1：仅键名不足以覆盖「同键换值」） */
    const fp = createHash("sha256").update(oauth + "|" + locKey + "|" + String(raw[locKey] || "")).digest("hex");
    if (glrMemo.fp === fp && Date.now() - glrMemo.at < GLR_MEMO_TTL_MS) return glrMemo.token || null;
    let loc = null;
    try {
      const env = typeof raw[locKey] === "string" ? raw[locKey] : "";
      if (!env) return null;
      let val = decryptValue(env);
      if (typeof val !== "string" || val.indexOf("enc:") === 0) return null;
      loc = JSON.parse(val);
    } catch (e) { return null; }
    if (!loc || typeof loc !== "object") return null;
    const organizationId = typeof loc.organizationId === "string" ? loc.organizationId.trim() : "";
    const projectId = typeof loc.projectId === "string" ? loc.projectId.trim() : "";
    const apiKeyId = typeof loc.apiKeyId === "string" ? loc.apiKeyId.trim() : "";
    if (!organizationId || !projectId || !apiKeyId) return null;
    const origin = parseProjectLocationKeyName(locKey).origin;
    const body = { clientType: "zcode" };
    if (hostVersion) body.clientVersion = hostVersion;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GLR_EXCHANGE_TIMEOUT_MS);
    if (timer && typeof timer.unref === "function") timer.unref();   // 超时兜底定时器契约
    const onAbort = () => ctl.abort();
    if (externalSignal && typeof externalSignal.addEventListener === "function") externalSignal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(glrExchangeUrl(origin, { organizationId: organizationId, projectId: projectId, apiKeyId: apiKeyId }), {
        method: "POST",
        headers: { "Authorization": "Bearer " + oauth, "Content-Type": "application/json", "User-Agent": "ZCode" },
        body: JSON.stringify(body), signal: ctl.signal, redirect: "error",
      });
      if (!res || !res.ok) { dropBody(res); return null; }   // 404=location 失效、401/403=token 失效、5xx——一律 fail-closed；非 ok 体显式取消（undici 连接卫生，review A-3）
      let text = "";
      try { text = await readEnhanceBody(res); } catch (e) { return null; }
      if (text.length > 65536) return null;
      const token = parseGlrExchangePayload(text);
      if (!token) return null;
      glrMemo.fp = fp; glrMemo.token = token; glrMemo.at = Date.now();
      return token;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
      if (externalSignal && typeof externalSignal.removeEventListener === "function") externalSignal.removeEventListener("abort", onAbort);
    }
  }
  /* 拉模型列表门控（issue #336 附加发现 2）：PLAN_SOURCES 从 1 条扩到 6 条后，共享凭据的
   * team/start 条目若照单全列会出现 3 行近似重复——规则：宿主 v2 config 显式 enabled:false
   * 不列；同 v2 条目（宿主对 individual/team 共用同一 builtin key）或同 credKey 家族
   * （无 v2 config 的旧宿主/独立链）只列首档。仅影响列表展示；enhance/probe/apply 仍按
   * 凭据可用性独立裁决。已知取舍：credKey 兜底方向可能列出未开通套餐的假行（OAuth token
   * 是账号级非套餐级），宿主条目无法区分 individual/team 时首档承载。 */
  function planListable(planId) {
    const src = PLAN_SOURCES[String(planId || "")];
    if (!src || !planTokenOf(planId)) return false;
    const entry = readV2BuiltinEntry(src);
    if (entry && entry.enabled === false) return false;
    const first = Object.keys(PLAN_SOURCES).find((id) => {
      const s = PLAN_SOURCES[id];
      return (entry ? s.v2ConfigKey === src.v2ConfigKey : s.credKey === src.credKey) && !!planTokenOf(id);
    });
    return first === planId;
  }
  function providerView(rule) {
    const cfg = effectiveRuleConfig(rule);   // issue #383：模板供应商展示合并后 baseUrl
    const access = cfg.access || {}, api = cfg.api || {};
    return {
      id: String(rule.providerId || ""),
      name: String(rule.providerName || ""),
      baseUrl: String(api.baseUrl || "").replace(/\/+$/, ""),
      hasKey: !!access.apiKey,
      modelIds: declaredModelIds(cfg),
    };
  }
  function findRule(data, providerId) {
    for (const rule of rulesOf(data)) {
      if (rule && String(rule.providerId || "") === providerId) return rule;
    }
    return null;
  }
  function providerSource(data, providerId) {
    const src = PLAN_SOURCES[String(providerId || "")];
    const rule = findRule(data, providerId);
    /* issue #383：身份随合并后配置推导——模板变更即失效（在途探测中止、拉取缓存作废）；
     * 非模板供应商合并结果与原始 config 同值，指纹不变 */
    const cfg = rule ? effectiveRuleConfig(rule) : {}, api = cfg.api || {}, access = cfg.access || {};
    return createHash("sha256").update(JSON.stringify(src
      ? [src.baseUrl, planTokenOf(providerId)]
      : [access.type, api.type, String(api.baseUrl || "").trim().replace(/\/+$/, ""), String(access.apiKey || "").trim()])).digest("hex");
  }
  function currentProbe(ctx, data) {
    return !disposed && (!ctx || providerSource(data || readProviderCfg(), ctx.providerId) === ctx.source);
  }
  function cachedMeta(data, providerId) {
    const cache = fetchCache.get(providerId);
    return !disposed && cache && cache.source === providerSource(data, providerId) ? cache : null;
  }
  function dropBody(res) {
    /* 非 ok 响应不读 body 时显式取消：undici 下未消费的 body 会使连接滞留池外直至 GC
     * （长驻主进程反复拉取会累积）；与 readJsonBounded 超限 cancel 同一卫生语义 */
    try { if (res && res.body && typeof res.body.cancel === "function") res.body.cancel(); } catch (e) { }
  }
  function fetchJson(url, headers, timeoutMs) {
    if (!fetchImpl) return Promise.resolve(null);
    return fetchImpl(url, { headers: headers, signal: AbortSignal.timeout(timeoutMs) })
      .then((res) => {
        if (res && res.ok) return readJsonBounded(res, RESPONSE_MAX_BYTES);
        dropBody(res);
        return null;
      })
      .catch(() => null);
  }
  function loadCatalog() {
    if (!fetchImpl || !modelsDevUrl) return Promise.resolve([]);
    if (catalogCache && Date.now() - catalogCache.at < 3600000) return Promise.resolve(catalogCache.entries);
    if (catalogFailedAt && Date.now() - catalogFailedAt < 600000) return Promise.resolve([]);   // 失败 10 分钟内不再重试（零等待降级）
    return fetchJson(modelsDevUrl, { "Accept": "application/json" }, MODELS_DEV_TIMEOUT_MS).then((payload) => {
      const entries = payload ? catalogEntries(payload) : [];
      if (entries.length) catalogCache = { at: Date.now(), entries: entries };
      else catalogFailedAt = Date.now();
      return entries;
    });
  }

  /* api.json 档位目录（#236）：下载后只落「模型 id → 档位词表」轻量索引（原文约 6MB，
   * 索引数百 KB，运行目录 cachePath 原子写），进程内存是文件缓存的副本——单一 24h 生命周期：
   * 索引 <24h 直接用（跨重启生效），≥24h 先用旧索引合并再后台刷新（stale-while-revalidate，
   * 一天最多一次下载）；从不阻塞本轮弹窗、从不等待下载完成（cc-switch 拉列表不等目录的同一取舍）。 */
  function loadEffortsCacheFile() {
    if (!cachePath) return null;
    try {
      const d = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (!d || typeof d !== "object" || typeof d.at !== "number" || !d.e || typeof d.e !== "object" || !d.b || typeof d.b !== "object") return null;
      /* 逐键形状校验 + 重建 null 原型映射：缓存文件可被外部损坏/篡改，字符串冒充词表一旦
       * 穿透会写进宿主 provider_config 规则令整份配置解析失败——任一键非法按空缓存重建 */
      const sanitize = (raw) => {
        const out = Object.create(null);
        for (const key of Object.keys(raw)) {
          const v = raw[key];
          if (v === null) { out[key] = null; continue; }
          if (!Array.isArray(v) || !v.length || v.length > EFFORTS_MAX) return null;
          const vals = [];
          for (const item of v) {
            if (typeof item !== "string" || !item.trim()) return null;
            vals.push(item);
          }
          out[key] = vals;
        }
        return out;
      };
      const e = sanitize(d.e), b = sanitize(d.b);
      if (!e || !b) return null;
      return { at: d.at, index: { e: e, b: b } };
    } catch (err) { return null; }
  }
  function saveEffortsCacheFile(index) {
    if (!cachePath) return;
    const tmp = cachePath + ".zusage-tmp-" + process.pid;   // 同目录临时文件 + 原子替换：双实例并发最后写者赢
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: Date.now(), e: index.e, b: index.b }));
      fs.renameSync(tmp, cachePath);
    } catch (e) {
      /* 缓存落盘失败静默：非关键路径；清掉半写 tmp 防残留 */
      try { fs.unlinkSync(tmp); } catch (e2) { }
    }
  }
  function ensureApiCatalogBackground() {
    if (!fetchImpl || !modelsDevApiUrl) return false;
    const now = Date.now();
    if (apiCatalogPending) return true;   // 在途刷新：并发的第二个供应商弹窗同样显示补拉态
    if (apiCatalogFailedAt && now - apiCatalogFailedAt < 600000) return false;
    const current = apiCatalogCache || loadEffortsCacheFile();
    if (current && now - current.at < API_CACHE_MAX_AGE_MS) return false;
    apiCatalogPending = fetchJson(modelsDevApiUrl, { "Accept": "application/json" }, MODELS_DEV_API_TIMEOUT_MS).then((payload) => {
      apiCatalogPending = null;
      const entries = payload ? apiCatalogEntries(payload) : [];
      if (entries.length) {
        apiCatalogCache = { at: Date.now(), index: buildEffortsIndex(entries) };
        saveEffortsCacheFile(apiCatalogCache.index);
      } else {
        apiCatalogFailedAt = Date.now();
      }
    });
    return true;
  }
  /* 缺档位证据的模型：索引（内存→文件，任意新鲜度）就地补，供应商/主目录证据优先只补缺；
   * 索引缺位或 ≥24h 时触发后台刷新。返回是否触发刷新，供 fetchModels 带 effortsFetching
   * 让渲染端把「未获取配置」换成「档位补拉中」。 */
  function fillEffortsFromApiCatalog(metaById, ids) {
    const cached = apiCatalogCache || loadEffortsCacheFile();
    if (cached) apiCatalogCache = cached;   // 文件索引回填进程内副本
    if (cached) {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i], m = metaById[id];
        if (m && m.efforts && m.efforts.length) continue;
        const values = apiEffortsFor(cached.index, id);
        if (!values || !values.length) continue;
        if (m) m.efforts = values.slice();
        else metaById[id] = { efforts: values.slice() };
      }
    }
    const stale = !cached || Date.now() - cached.at >= API_CACHE_MAX_AGE_MS;
    return stale ? ensureApiCatalogBackground() : false;
  }

  function listProviders() {
    const data = readProviderCfg();
    if (!data) return { ok: false, error: "provider config missing or unreadable", providers: [] };
    const seen = new Set(), providers = [];
    for (const rule of rulesOf(data)) {
      if (!rule || !rule.providerId || isPlanProvider(rule.providerId) || !isPullable(rule)) continue;   // 套餐源走下方追加（带名称/端点）
      const id = String(rule.providerId);
      if (seen.has(id)) continue;   // 同 id 取首条（宿主写入自身去重，防御性跳过重复项）
      seen.add(id);
      providers.push(providerView(rule));
    }
    /* 套餐源追加（v134）：OAuth 型套餐不在 api-key 规则里，凭据可用才列出 */
    for (const planId of Object.keys(PLAN_SOURCES)) {
      if (seen.has(planId) || !planListable(planId)) continue;
      const planRule = findRule(data, planId);
      const view = providerView(planRule || { providerId: planId, config: {} });
      view.name = view.name || PLAN_SOURCES[planId].name;
      view.baseUrl = PLAN_SOURCES[planId].baseUrl;
      providers.push(view);
    }
    return { ok: true, providers: providers };
  }

  async function fetchModels(providerId) {
    providerId = planAliasId(providerId);   // issue #336：builtin: 旧形套餐 id 归一
    const data = readProviderCfg();
    const source = providerSource(data, providerId);
    const rule = data ? findRule(data, providerId) : null;
    const planSrc = PLAN_SOURCES[String(providerId || "")];
    if (disposed || (!planSrc && (!rule || !isPullable(rule)))) return { ok: false, error: "provider not found" };
    let planToken = null;
    if (planSrc) {
      planToken = planTokenOf(providerId);
      if (!planToken) return { ok: false, error: "provider not found" };
    }
    if (!fetchImpl) return { ok: false, error: "no network stack" };
    /* 目录与供应商请求并行（#236 起套餐源也接目录）；目录只在供应商完成后最多宽限
     * CATALOG_GRACE_MS——它是行内小字的锦上添花，绝不拖慢弹窗（cc-switch 拉列表不等目录，同款取舍）。
     * 早退分支（供应商无效/无凭据/无网络栈）先于目录请求返回，不白打 models.dev。 */
    const catalogPromise = loadCatalog();
    const awaitCatalogWithinGrace = () => {
      let graceTimer;
      return Promise.race([
        catalogPromise,
        new Promise((resolve) => {
          graceTimer = setTimeout(() => resolve(catalogCache ? catalogCache.entries : []), catalogGraceMs);
          if (graceTimer && typeof graceTimer.unref === "function") graceTimer.unref();
        }),
      ]).finally(() => clearTimeout(graceTimer));
    };
    if (planSrc) {
      /* 套餐源：单端点（Anthropic models，与运行协议同源），Bearer 套餐 token */
      try {
        const res = await fetchImpl(planSrc.endpoint, { headers: { "Accept": "application/json", "Authorization": "Bearer " + planToken, "User-Agent": "ZCode" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) { dropBody(res); return { ok: false, error: "HTTP " + res.status }; }
        const body = await readJsonBounded(res, RESPONSE_MAX_BYTES);
        const list = Array.isArray(body) ? body : asObject(body).data || asObject(body).models || asObject(body).result || null;
        const ids = sanitizeModelIds((Array.isArray(list) ? list : [])
          .map((item) => (typeof item === "string" ? item : asObject(item).id || asObject(item).slug || "")).filter(Boolean))
          .map(normalizePlanModelId)
          .filter((id, i, a) => a.indexOf(id) === i);
        if (!ids.length) return { ok: false, error: "no models in response" };
        ids.sort();
        const entries = await awaitCatalogWithinGrace();
        const metaById = Object.create(null);   // null 原型：模型 id 来自远端，"__proto__" 等键必须可写
        if (entries && entries.length) {
          for (const mid of ids) {
            const hit = matchCatalogEntry(entries, mid);
            if (!hit) continue;
            const meta = mergedMeta({ id: mid, contextWindow: 0, maxOutputTokens: 0, modalities: null, vision: undefined, efforts: [] }, hit.model, agreedCapabilities(entries, mid));
            if (Object.keys(meta).length) metaById[mid] = meta;
          }
        }
        const fetching = fillEffortsFromApiCatalog(metaById, ids);   // #236：GLM 档位词表来自 api 目录（按需）
        fetchCache.set(providerId, { metaById: metaById, source: source });
        return { ok: true, models: ids, metaById: metaById, via: planSrc.endpoint, effortsFetching: fetching || undefined };
      } catch (e) {
        return { ok: false, error: (e && e.name === "TimeoutError") ? "timeout" : "request failed" };
      }
    }
    const cfg = effectiveRuleConfig(rule);   // issue #383：模板供应商按合并后配置构造请求
    const apiKey = String((cfg.access || {}).apiKey || "").trim();
    const urls = candidateUrls(cfg.api.baseUrl);
    const headers = { "Accept": "application/json", "User-Agent": "ZCode" };
    if (apiKey) { headers["Authorization"] = "Bearer " + apiKey; headers["x-api-key"] = apiKey; }
    let lastError = "no candidate endpoint succeeded";
    let items = null, via = "";
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, { headers: headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) {
          lastError = "HTTP " + res.status;
          dropBody(res);
          /* 404/405=路径不对才换下一候选；401/403/5xx 是凭据或服务端问题，换路径无意义
           * （cc-switch 同款，避免每个候选各等一个超时） */
          if (res.status !== 404 && res.status !== 405) return { ok: false, error: lastError };
          continue;
        }
        const body = await readJsonBounded(res, RESPONSE_MAX_BYTES);
        const list = Array.isArray(body) ? body
          : asObject(body).data || asObject(body).models || asObject(body).result || null;
        if (!Array.isArray(list)) { lastError = "no models in response"; continue; }
        items = list; via = url;
        break;
      } catch (e) {
        lastError = (e && e.name === "TimeoutError") ? "timeout" : "request failed";
      }
    }
    if (!items) return { ok: false, error: lastError };
    const entries = await awaitCatalogWithinGrace();
    const ids = [], metaById = Object.create(null);   // null 原型：模型 id 来自远端，"__proto__" 等键必须可写
    for (const item of items) {
      const pm = extractModelMeta(item);
      if (!pm.id || pm.id.length > MODEL_ID_MAX || /[\x00-\x1f\x7f]/.test(pm.id)) continue;
      if (ids.includes(pm.id)) continue;
      const hit = entries.length ? matchCatalogEntry(entries, pm.id) : null;
      const meta = mergedMeta(pm, hit ? hit.model : null, agreedCapabilities(entries, pm.id));
      if (Object.keys(meta).length) metaById[pm.id] = meta;
      ids.push(pm.id);
      if (ids.length >= MAX_MODELS) break;
    }
    if (!ids.length) return { ok: false, error: "no models in response" };
    ids.sort();
    const fetching = fillEffortsFromApiCatalog(metaById, ids);   // #236：缺档位证据时按需补/后台拉 api 目录
    fetchCache.set(providerId, { metaById: metaById, source: source });
    if (fetchCache.size > CATALOG_CACHE_MAX) fetchCache.delete(fetchCache.keys().next().value);
    return { ok: true, models: ids, metaById: metaById, via: via, effortsFetching: fetching || undefined };
  }

  function writeProviderCfg(data) {
    const file = customCfgPath;
    /* tmp 名带 pid：applyBusy 只约束本进程，双 ZCode 实例共享 HOME 时防同路径交错写 */
    const tmp = file + ".zusage-tmp-" + process.pid;
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch (e) { }
    try {
      fs.copyFileSync(file, file + ".zusage-bak");   // 滚动备份：失败不阻塞写入（原子替换本身安全）
    } catch (e) { log("backup failed:", e.message); }
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: mode });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, mode); } catch (e2) { /* Windows/权限失败忽略：tmp 已按原 mode 创建 */ }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { }
      throw e;
    }
  }

  /* 模板丰富度评分：维度越多越适合做新模型的填充来源 */
  function templateScore(config) {
    let n = 0;
    const props = config && config.properties;
    if (props) {
      if (props.contextWindow) n++;
      const fmt = props.inputFormat;
      if (fmt) for (const k of ["supportsImage", "supportsVideo", "supportsAudio", "supportsPdf"]) if (fmt[k]) n++;
      for (const k of ["supportsToolCall", "supportsJsonSchemaOutput", "supportsNativeWebSearch", "supportsMidConversationSystem"]) if (props[k]) n++;
    }
    const specs = config && config.optionSpecs;
    if (specs) {
      if (specs.reasoningLevel && Array.isArray(specs.reasoningLevel.values) && specs.reasoningLevel.values.length) n += 2;
      if (specs.maxOutputTokens && specs.maxOutputTokens.max) n++;
    }
    return n;
  }

  /* 按模型写实 config：以同供应商模板为底（保证 strict 校验），仅覆盖有依据的字段；
   * 模板已带 map 表达式的 optionSpecs 是与档位名自洽的整体，不覆盖（防 values 换名后 map 失配）。
   * 元数据来自主进程 fetchCache（applyModels 只收 id，渲染端无法注入任意 config 字段）。
   * 其余键、其余供应商一律原样保留。写入对象含 key，任何返回/日志不携带配置内容。 */
  function entryWithMeta(entry, meta) {
    if (!meta) return entry;
    const props = entry.properties && typeof entry.properties === "object" && !Array.isArray(entry.properties)
      ? entry.properties : (entry.properties = {});
    if (meta.contextWindow) props.contextWindow = meta.contextWindow;
    if (meta.inputFormat) {
      const fmt = props.inputFormat && typeof props.inputFormat === "object" && !Array.isArray(props.inputFormat)
        ? props.inputFormat : (props.inputFormat = {});
      Object.assign(fmt, meta.inputFormat);
    }
    /* 能力位只写实有据叶子（v312）：正证据 true / 显式负证据 false，缺省不动内置 catch-all */
    if (typeof meta.supportsJsonSchemaOutput === "boolean") props.supportsJsonSchemaOutput = meta.supportsJsonSchemaOutput;
    if (meta.supportsMidConversationSystem === true) props.supportsMidConversationSystem = true;
    if (typeof meta.supportsToolCall === "boolean") props.supportsToolCall = meta.supportsToolCall;
    if (meta.maxOutputTokens || meta.efforts) {
      const specs = entry.optionSpecs && typeof entry.optionSpecs === "object" && !Array.isArray(entry.optionSpecs)
        ? entry.optionSpecs : (entry.optionSpecs = {});
      if (meta.maxOutputTokens) {
        const limit = specs.maxOutputTokens && typeof specs.maxOutputTokens === "object"
          ? specs.maxOutputTokens : (specs.maxOutputTokens = {});
        if (typeof limit.map !== "string") limit.max = meta.maxOutputTokens;   // 带 map 的自洽结构不动
      }
      if (meta.efforts && meta.efforts.length) {
        const level = specs.reasoningLevel && typeof specs.reasoningLevel === "object"
          ? specs.reasoningLevel : (specs.reasoningLevel = {});
        if (typeof level.map !== "string") level.values = meta.efforts.slice();
      }
    }
    return entry;
  }

  async function applyModels(providerId, models) {
    providerId = planAliasId(providerId);   // issue #336：builtin: 旧形套餐 id 归一
    if (disposed) return { ok: false, error: "model puller disposed" };
    const wanted = sanitizeModelIds(models);
    if (!wanted.length) return { ok: false, error: "no valid models" };
    if (applyBusy) return { ok: false, error: "another write is in progress" };
    applyBusy = true;
    try {
      const data = readProviderCfg();
      const planSrc = PLAN_SOURCES[String(providerId || "")];
      let rule = data ? findRule(data, providerId) : null;
      if (!planSrc && (!rule || !isPullable(rule))) return { ok: false, error: "provider not found" };
      if (planSrc && !rule) {
        /* issue #226：全新环境宿主尚未创建套餐 personal 规则（首次官方保存才隐式创建），
         * 自建与宿主 addPersonalModel 同构的最小条目 {providerId, config}——宿主 rule schema
         * 是 strict 且 account: 供应商禁止 config.access（superRefine），绝不多写字段；
         * providerRules 不是文件内数组（结构缺口过大）仍拒绝，不代宿主搭骨架。
         * 宿主对整份文件 strict 校验、任一条目非法即整体降级，写入形状必须严格同构。 */
        const list = data && data.config && data.config.providerConfigRules
          ? data.config.providerConfigRules.providerRules : null;
        if (!Array.isArray(list)) return { ok: false, error: "provider not found" };
        rule = { providerId: providerId, config: {} };
        list.push(rule);
      }
      if (planSrc) {
        for (let i = 0; i < wanted.length; i++) wanted[i] = normalizePlanModelId(wanted[i]);
        for (let i = wanted.length - 1; i > 0; i--) if (wanted.indexOf(wanted[i]) < i) wanted.splice(i, 1);
      }
      const pcfg = rule.config || (rule.config = {});
      const personal = Array.isArray(pcfg.personalModelIds) ? pcfg.personalModelIds.filter((m) => typeof m === "string") : [];
      const order = Array.isArray(pcfg.modelOrder) ? pcfg.modelOrder.filter((m) => typeof m === "string") : [];
      const declared = new Set(declaredModelIds(pcfg));
      const adding = wanted.filter((m) => !declared.has(m));
      if (!adding.length) return { ok: true, added: 0 };
      if (personal.length + adding.length > MAX_MODELS || order.length + adding.length > MAX_MODELS) {
        return { ok: false, error: "too many models" };
      }
      for (const mid of adding) {
        if (!personal.includes(mid)) personal.push(mid);
        if (!order.includes(mid)) order.push(mid);
      }
      pcfg.personalModelIds = personal;
      pcfg.modelOrder = order;
      const mcr = data.config && data.config.modelConfigRules;
      const rules = mcr && Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : null;
      if (rules && mcr && typeof mcr === "object") {
        if (!Array.isArray(mcr.manualProviderModelRules)) mcr.manualProviderModelRules = [];
        const siblings = rules.filter((r) => r && typeof r === "object" && String(r.providerId || "") === providerId && r.config && typeof r.config === "object");
        if (siblings.length) {
          const cache = cachedMeta(data, providerId);
          /* 模板取配置最丰富的兄弟（用户手动配全的那条），不是最后一条——最后一条可能恰好
           * 是贫瘠配置，复制后新模型看起来什么都没填（实测翻车：gpt-6.1-terra 继承 astra） */
          const template = siblings.reduce((best, r) => (templateScore(r.config) >= templateScore(best.config) ? r : best)).config;
          for (const mid of adding) {
            const entry = JSON.parse(JSON.stringify(template));
            rules.push({ modelId: mid, providerId: providerId, config: entryWithMeta(entry, cache ? cache.metaById[mid] : null) });
          }
        } else {
          /* 无兄弟模板：按宿主 addPersonalModel 的最小骨架写实 {enabled:true}（issue #226；
           * 条目 schema strict，config 经 sparseShape 接受最小布尔）。issue #236：api-key
           * 供应商首拉同样走这里，有据元数据（contextWindow/inputFormat/档位/输出上限）
           * 直接写实——稀疏个人规则字段级覆盖内置，map 继承宿主 apiType catch-all；
           * 绝不生成 map，绝不写 manualProviderModelRules */
          const cache = cachedMeta(data, providerId);
          for (const mid of adding) {
            rules.push({ modelId: mid, providerId: providerId, config: entryWithMeta({ enabled: true }, cache ? cache.metaById[mid] : null) });
          }
        }
      }
      writeProviderCfg(data);
      log("added", adding.length, "models to provider", providerId);
      return { ok: true, added: adding.length };
    } finally {
      applyBusy = false;
    }
  }

  /* 单模型单次探测（v310 从 probeModel 提出）：URL/鉴权/载荷按宿主同款语义构建。
   * anthropic 鉴权双头与宿主 withAnthropicAuthorizationHeader 同款（x-api-key + Bearer）。
   * opts.reasoning 按 apiType 附加 wire 字段（v311）；opts.messages/opts.responseFormat 供
   * v312 能力探测替换载荷；opts.timeoutMs 收紧能力探测超时。失败结果携带 full（完整脱敏
   * 文案，供接受集解析），probeModel 返回前剥除——渲染端只见 snippet。 */
  async function probeRequest(apiType, baseUrl, apiKey, mid, opts, ctx) {
    if (!currentProbe(ctx)) return { ok: false, model: mid, kind: "provider", error: "provider changed" };
    const o = opts || {};
    const remaining = ctx ? ctx.deadline - Date.now() : PROBE_TIMEOUT_MS;
    if (remaining <= 0) return { ok: false, model: mid, kind: "timeout", error: "timeout" };
    let url = "", body = null;
    const headers = { "Content-Type": "application/json", "User-Agent": "ZCode" };   // fetchModels/enhanceText 同款 UA：网关拒绝无 UA 请求
    if (isOpenCodeGoBaseUrl(baseUrl)) headers["x-opencode-session"] = randomUUID();   // OpenCode Go 路由键，缺失 400 MissingSessionID（issue #383：与增强链同款）
    if (apiType === "openai-chat-completions") {
      url = baseUrl + "/chat/completions";
      headers["Authorization"] = "Bearer " + apiKey;
      body = { model: mid, messages: Array.isArray(o.messages) ? o.messages : [{ role: "user", content: "ping" }], max_tokens: 16, stream: false };
    } else if (apiType === "openai-responses") {
      url = baseUrl + "/responses";
      headers["Authorization"] = "Bearer " + apiKey;
      body = { model: mid, input: "ping", max_output_tokens: 16, stream: false };
    } else if (apiType === "anthropic-messages") {
      url = anthropicBaseWithV1(baseUrl) + "/messages";
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["Authorization"] = "Bearer " + apiKey;
      body = { model: mid, max_tokens: 16, messages: Array.isArray(o.messages) ? o.messages : [{ role: "user", content: "ping" }] };
    } else {
      return { ok: false, model: mid, kind: "unsupported", error: "unsupported api type" };
    }
    if (o.reasoning !== undefined) Object.assign(body, reasoningWireField(apiType, o.reasoning));
    if (o.responseFormat) body.response_format = o.responseFormat;
    if (o.tools) body.tools = o.tools;
    const started = Date.now();
    try {
      const res = await fetchImpl(url, { headers: headers, body: JSON.stringify(body), method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.min(o.timeoutMs || PROBE_TIMEOUT_MS, remaining)) });
      if (!currentProbe(ctx)) { dropBody(res); return { ok: false, model: mid, kind: "provider", error: "provider changed" }; }
      const latencyMs = Date.now() - started;
      if (res && res.ok) {
        dropBody(res);
        return { ok: true, model: mid, status: res.status, latencyMs: latencyMs, url: url };
      }
      const full = await errorSnippet(res, apiKey);
      const status = res ? res.status : 0;
      return { ok: false, model: mid, kind: classifyProbeStatus(status), status: status, url: url, snippet: full.slice(0, PROBE_SNIPPET_MAX), full: full };
    } catch (e) {
      const timedOut = !!(e && (e.name === "TimeoutError" || e.name === "AbortError"));
      return { ok: false, model: mid, kind: timedOut ? "timeout" : "network", url: url, error: timedOut ? "timeout" : "request failed" };
    }
  }
  /* 路径错配自动修复（v310，用户规格「自动帮我修复而不是红字提示」）：path 类失败时对
   * ±/v1 邻域候选实测，命中即把新 baseUrl 写回 provider_config（读-改-原子替换，与
   * applyModels 共享 applyBusy 写闸防交错丢更新）；宿主轮询该文件后对运行中的客户端即
   * 时生效。单飞：同供应商并发的探测共享同一次修复（全选模型同 URL 全 405 时只测一轮、
   * 只写一次），各自再按新 base 重试。修复限定 openai 两型（anthropic 型宿主自动补 /v1，
   * 无此错配维度；套餐源 baseUrl 由插件常量管理，不代改）。 */
  const probeRepairBusy = new Map();   // providerId → 在途修复 promise（单飞）
  async function probeRepairOnce(providerId, apiType, baseUrl, apiKey, mid, ctx) {
    const key = providerId + ":" + ctx.source;
    const shared = probeRepairBusy.get(key);
    if (shared) {
      const result = await shared.task;
      if (result.base) { ctx.source = result.source; return result; }
      if (shared.mid === mid || !currentProbe(ctx)) return result;
      return probeRepairOnce(providerId, apiType, baseUrl, apiKey, mid, ctx);
    }
    const task = (async () => {
      const tried = [];
      for (const cand of probeRepairCandidates(baseUrl, apiType)) {
        tried.push(cand.url);
        const test = await probeRequest(apiType, cand.base, apiKey, mid, null, ctx);
        if (!test.ok) continue;
        if (applyBusy) return { base: "", tried: tried };
        applyBusy = true;
        try {
          const data = readProviderCfg();
          const rule = data ? findRule(data, providerId) : null;
          if (!currentProbe(ctx, data) || !rule || !isPullable(rule) || !rule.config || typeof rule.config !== "object") return { base: "", tried: tried };
          /* issue #383：模板供应商个人规则可无 api 对象——补建后只写实测命中的 baseUrl
           * （稀疏 api 过宿主 strict schema；api.type 仍由模板承载不代写，显式配置覆盖模板） */
          const api = rule.config.api && typeof rule.config.api === "object" ? rule.config.api : (rule.config.api = {});
          const cache = cachedMeta(data, providerId);
          api.baseUrl = cand.base;
          writeProviderCfg(data);
          ctx.source = providerSource(data, providerId);
          if (cache) cache.source = ctx.source;
          log("probe repaired baseUrl for", providerId, "->", cand.base);
          return { base: cand.base, source: ctx.source, tried: tried };
        } catch (e) {
          log("probe repair write-back failed:", e && e.message);   // 静默吞异常曾让修复失败无从排查（issue #383）
          return { base: "", tried: tried };
        } finally {
          applyBusy = false;
        }
      }
      return { base: "", tried: tried };
    })().catch(() => ({ base: "", tried: [] }));
    probeRepairBusy.set(key, { task: task, mid: mid });
    task.finally(() => { if (probeRepairBusy.get(key)?.task === task) probeRepairBusy.delete(key); });
    return task;
  }
  /* 模型级写实规则（modelConfigRules.providerModelRules 的 (providerId, modelId) 条目）：
   * v252 起 api-key 首拉也落 {enabled:true} 骨架，这里是辅助档位验证的目标读写位置 */
  function modelRuleOf(data, providerId, mid) {
    const mcr = data && data.config && data.config.modelConfigRules;
    const rules = mcr && Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : null;
    if (!rules) return null;
    for (const r of rules) {
      if (r && typeof r === "object" && String(r.modelId || "") === mid && String(r.providerId || "") === providerId) return r;
    }
    return null;
  }
  /* 辅助档位自动写实（v311，用户实报 Gemini 严格上游拒 reasoning_effort:"none"）：
   * 返回 null=现状可用无需动作 / {values}=已写实修复 / {failed,...}=无法修复（渲染端报
   * reasoning 类失败）。写目标二选一：模型规则已存在→直接写规则（applyModels 不触碰已
   * 添加模型）；不存在→写 fetchCache 元数据，紧随其后的 applyModels 经 entryWithMeta 落盘
   * （绝不在探测路径新建模型规则，避免与 applyModels 双写重复条目）。带 map 的自洽结构
   * 不动（entryWithMeta 同纪律）；写回与 applyModels 共享 applyBusy。 */
  async function healReasoningLadder(providerId, apiType, baseUrl, apiKey, mid, ctx) {
    const data = readProviderCfg();
    const modelRule = data ? modelRuleOf(data, providerId, mid) : null;
    const cache = cachedMeta(data, providerId);
    const meta = cache && cache.metaById ? cache.metaById[mid] : null;
    const level = modelRule && asObject(asObject(modelRule.config).optionSpecs).reasoningLevel;
    if (typeof asObject(level).map === "string") return null;
    const expectedLevel = JSON.stringify(level);
    const writtenValues = modelRule
      ? (((modelRule.config || {}).optionSpecs || {}).reasoningLevel || {}).values
      : (meta && Array.isArray(meta.efforts) ? meta.efforts : null);
    const current = Array.isArray(writtenValues) && writtenValues.length && writtenValues.every((v) => typeof v === "string") ? writtenValues : null;
    const auxValue = auxWireValue(current ? current[0] : "disabled");   // 宿主测试/辅助取 values[0]；无写入=内置两档最低 disabled
    const aux = await probeRequest(apiType, baseUrl, apiKey, mid, { reasoning: auxValue }, ctx);
    if (aux.ok) {
      if (cache && cache.metaById && currentProbe(ctx) && fetchCache.get(providerId) === cache) cache.metaById[mid] = Object.assign({}, cache.metaById[mid] || {}, { auxOk: true });
      return null;   // 现状可用
    }
    if (!(aux.status === 400 && /reasoning|effort/i.test(aux.full || ""))) return null;   // 非档位问题不越权
    const accepted = acceptedEffortsFromSnippet(aux.full);
    const tryCandidates = async (candidates) => {
      for (let i = 0; i < Math.min(candidates.length, 2); i++) {
        const pick = candidates.slice(i);
        const verify = await probeRequest(apiType, baseUrl, apiKey, mid, { reasoning: pick[0] }, ctx);
        if (!verify.ok) continue;
        if (modelRule) {
          const w = await writeLadderToRule(providerId, mid, pick, ctx, expectedLevel);
          return w ? { values: pick } : { failed: true, status: aux.status, snippet: aux.snippet, writeBlocked: true };
        }
        if (!cache || !currentProbe(ctx) || fetchCache.get(providerId) !== cache) return null;
        cache.metaById[mid] = Object.assign({}, cache.metaById[mid] || {}, { efforts: pick.slice() });
        return { values: pick.slice() };
      }
      return null;
    };
    if (accepted) {
      const r = await tryCandidates(REASONING_LADDER.filter((v) => accepted.indexOf(v) >= 0));
      if (r) return r;
    }
    /* 解析失败/解析与实际不符：逐候选实测，取第一个可用档位写单值表（default=aux 同值，
     * 宿主测试/辅助立即恢复；主下拉退化但可用，用户可后续在设置里补足） */
    for (const cand of REASONING_LADDER) {
      const t = await probeRequest(apiType, baseUrl, apiKey, mid, { reasoning: cand }, ctx);
      if (!t.ok) continue;
      if (modelRule) {
        const w = await writeLadderToRule(providerId, mid, [cand], ctx, expectedLevel);
        return w ? { values: [cand] } : { failed: true, status: aux.status, snippet: aux.snippet, writeBlocked: true };
      }
      if (!cache || !currentProbe(ctx) || fetchCache.get(providerId) !== cache) return null;
      cache.metaById[mid] = Object.assign({}, cache.metaById[mid] || {}, { efforts: [cand] });
      return { values: [cand] };
    }
    return { failed: true, status: aux.status, snippet: aux.snippet };
  }
  async function writeLadderToRule(providerId, mid, values, ctx, expectedLevel) {
    if (applyBusy) return null;
    applyBusy = true;
    try {
      const data = readProviderCfg();
      const modelRule = data ? modelRuleOf(data, providerId, mid) : null;
      if (!currentProbe(ctx, data) || !modelRule || !modelRule.config || typeof modelRule.config !== "object") return null;
      if (JSON.stringify(asObject(modelRule.config.optionSpecs).reasoningLevel) !== expectedLevel) return null;
      const specs = modelRule.config.optionSpecs && typeof modelRule.config.optionSpecs === "object" ? modelRule.config.optionSpecs : (modelRule.config.optionSpecs = {});
      const rl = specs.reasoningLevel && typeof specs.reasoningLevel === "object" ? specs.reasoningLevel : (specs.reasoningLevel = {});
      if (typeof rl.map === "string") return null;   // 带 map 的自洽结构不动（entryWithMeta 同纪律）
      rl.values = values.slice();
      writeProviderCfg(data);
      log("probe wrote reasoning ladder for", providerId, mid, "->", values.join("/"));
      return true;
    } catch (e) {
      return null;
    } finally {
      applyBusy = false;
    }
  }
  /* 能力实测探测（v312，用户规格「输入类型/模型能力自动匹配」）：只采正证据——2xx 才写
   * true，4xx/网络失败一律不写（保守默认继承内置 catch-all 全 false，绝不因网关脾气把
   * 能力写死）。三项在真实中转实测可判定（2026-11-09 OpenHub）：图片 content part、
   * response_format json_schema、对话中 system 消息；PDF 的 OpenAI wire（type:"file"）
   * 部分中转不认，400 是形状错误不是能力缺失——PDF 只走目录证据；视频/音频无廉价可靠
   * 探测（audio 宿主无消费者）不探测；原生联网搜索无法廉价如实验证不探测。写目标与
   * v311 同款双路径：模型规则已存在→合并 properties 叶子（用户显式 false 不覆盖）；
   * 未落盘→fetchCache 元数据由 applyModels 统一落盘。仅 openai-chat-completions
   * （responses 型 wire 形状不同，本轮不探测）。 */
  const PROBE_CAP_TIMEOUT_MS = 6000;
  const CAP_PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";   // 1x1 PNG
  const CAP_PROBE_SCHEMA = { type: "json_schema", json_schema: { name: "probe", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } };
  function ruleLeafTrue(modelRule, inInputFormat, key) {
    const props = modelRule && modelRule.config && typeof modelRule.config === "object" ? modelRule.config.properties : null;
    if (!props || typeof props !== "object") return false;
    const v = inInputFormat ? asObject(props.inputFormat)[key] : props[key];
    return v === true;
  }
  function ruleLeafSettled(modelRule, inInputFormat, key) {
    /* 已定 = 显式 true 或显式 false（用户/既有证据拍过板，探测不再越权） */
    const props = modelRule && modelRule.config && typeof modelRule.config === "object" ? modelRule.config.properties : null;
    if (!props || typeof props !== "object") return false;
    const v = inInputFormat ? asObject(props.inputFormat)[key] : props[key];
    return v === true || v === false;
  }
  async function writeCapsToRule(providerId, mid, caps, ctx) {
    if (applyBusy) return null;
    applyBusy = true;
    try {
      const data = readProviderCfg();
      const modelRule = data ? modelRuleOf(data, providerId, mid) : null;
      if (!currentProbe(ctx, data) || !modelRule || !modelRule.config || typeof modelRule.config !== "object") return null;
      const written = [];
      const props = modelRule.config.properties && typeof modelRule.config.properties === "object" && !Array.isArray(modelRule.config.properties)
        ? modelRule.config.properties : (modelRule.config.properties = {});
      if (caps.image && props.inputFormat !== false && asObject(props.inputFormat).supportsImage !== false) {
        const fmt = props.inputFormat && typeof props.inputFormat === "object" && !Array.isArray(props.inputFormat)
          ? props.inputFormat : (props.inputFormat = {});
        fmt.supportsImage = true;
        written.push("image");
      }
      if (caps.jsonSchema && props.supportsJsonSchemaOutput !== false) { props.supportsJsonSchemaOutput = true; written.push("jsonSchema"); }
      if (caps.midConv && props.supportsMidConversationSystem !== false) { props.supportsMidConversationSystem = true; written.push("midConv"); }
      if (!written.length) return [];
      writeProviderCfg(data);
      log("probe wrote capabilities for", providerId, mid, "->", JSON.stringify(caps));
      return written;
    } catch (e) {
      return null;
    } finally {
      applyBusy = false;
    }
  }
  async function healCapabilities(providerId, apiType, baseUrl, apiKey, mid, ctx) {
    const data = readProviderCfg();
    const modelRule = data ? modelRuleOf(data, providerId, mid) : null;
    const cache = cachedMeta(data, providerId);
    const meta = cache && cache.metaById ? cache.metaById[mid] : null;
    const have = {
      image: ruleLeafSettled(modelRule, true, "supportsImage") || !!(meta && meta.inputFormat && typeof meta.inputFormat.supportsImage === "boolean"),
      jsonSchema: ruleLeafSettled(modelRule, false, "supportsJsonSchemaOutput") || !!(meta && typeof meta.supportsJsonSchemaOutput === "boolean"),
      midConv: ruleLeafSettled(modelRule, false, "supportsMidConversationSystem") || !!(meta && typeof meta.supportsMidConversationSystem === "boolean"),
    };
    const want = [];
    if (!have.image) want.push("image");
    if (!have.jsonSchema) want.push("jsonSchema");
    if (!have.midConv) want.push("midConv");
    const toolHistoryChecked = !!(meta && meta.toolHistoryChecked === true);
    const added = [];
    for (const key of want) {
      if (!currentProbe(ctx)) return null;
      let res;
      if (key === "image") {
        res = await probeRequest(apiType, baseUrl, apiKey, mid, { timeoutMs: PROBE_CAP_TIMEOUT_MS, messages: [{ role: "user", content: [{ type: "text", text: "ping" }, { type: "image_url", image_url: { url: "data:image/png;base64," + CAP_PROBE_PNG } }] }] }, ctx);
      } else if (key === "jsonSchema") {
        res = await probeRequest(apiType, baseUrl, apiKey, mid, { timeoutMs: PROBE_CAP_TIMEOUT_MS, responseFormat: CAP_PROBE_SCHEMA }, ctx);
      } else {
        res = await probeRequest(apiType, baseUrl, apiKey, mid, { timeoutMs: PROBE_CAP_TIMEOUT_MS, messages: [{ role: "user", content: "hi" }, { role: "system", content: "reply briefly" }, { role: "user", content: "hi2" }] }, ctx);
      }
      if (res && res.ok) added.push(key);
    }
    /* 工具历史回灌探测（v313，警告性质）：OpenHub 实证其全部 Gemini 系通道拒收 tool_calls
     * 历史（首轮工具调用成功、第二轮必 400001），Anthropic 线同病——通道缺陷无法用配置表达
     * （supportsToolCall:false 会让宿主对带工具请求直接报错，更糟），只如实警告。 */
    let toolHistoryUnsupported = false;
    if (!toolHistoryChecked) {
      const th = await probeRequest(apiType, baseUrl, apiKey, mid, {
        timeoutMs: PROBE_CAP_TIMEOUT_MS,
        messages: [
          { role: "user", content: "read it" },
          { role: "assistant", content: "", tool_calls: [{ id: "zusage_probe_1", type: "function", function: { name: "zusage_probe", arguments: "{\"path\":\"/x\"}" } }] },
          { role: "tool", tool_call_id: "zusage_probe_1", content: "data" },
        ],
        tools: [{ type: "function", function: { name: "zusage_probe", description: "probe", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
      }, ctx);
      if (!currentProbe(ctx)) return null;
      if (th && th.ok) toolHistoryUnsupported = false;
      else if (th && (th.status === 400 || th.status === 422)) toolHistoryUnsupported = true;   // 确定性拒绝才警告；超时/网络/5xx 不定不警
      if (cache && cache.metaById && fetchCache.get(providerId) === cache && (th.ok || toolHistoryUnsupported)) {
        cache.metaById[mid] = Object.assign({}, cache.metaById[mid] || {}, { toolHistoryChecked: true, toolHistoryUnsupported: toolHistoryUnsupported || undefined });
      }
    } else if (meta && meta.toolHistoryUnsupported) {
      toolHistoryUnsupported = true;
    }
    if (!currentProbe(ctx) || (!added.length && !toolHistoryUnsupported)) return null;
    const caps = { image: added.indexOf("image") >= 0, jsonSchema: added.indexOf("jsonSchema") >= 0, midConv: added.indexOf("midConv") >= 0 };
    const warnings = toolHistoryUnsupported ? ["toolHistory"] : [];
    if (modelRule) {
      const written = added.length ? await writeCapsToRule(providerId, mid, caps, ctx) : [];
      return { added: written || [], warnings: warnings };
    }
    if (cache && cache.metaById && fetchCache.get(providerId) === cache) {
      const latest = cache.metaById[mid] || {};
      const next = Object.assign({}, latest);
      if (caps.image) next.inputFormat = Object.assign({}, latest.inputFormat, { supportsImage: true });
      if (caps.jsonSchema) next.supportsJsonSchemaOutput = true;
      if (caps.midConv) next.supportsMidConversationSystem = true;
      cache.metaById[mid] = next;   // applyModels 随后经 entryWithMeta 统一落盘
      return { added: added, warnings: warnings };
    }
    return warnings.length ? { added: [], warnings: warnings } : null;   // 无规则无拉取会话：无处写实，不虚报
  }
  /* 规格补全（v314，用户实报 400 maxOutputTokens 89642>65537）：applyModels 是 append-only，
   * 先添加的模型在目录证据迟到时永远拿不到 optionSpecs.maxOutputTokens/properties.contextWindow
   * 写实——baseline 落到内置 catch-all 128000，宿主预轮 cap=窗口−用量 只会下调不设上限，超出
   * 上游真实输出上限即 400。探测确认时用拉取会话元数据补「缺失」键（绝不覆盖已写值/带 map
   * 自洽结构），与 v311/v312 同款双路径纪律。 */
  async function enrichSpecFromMeta(providerId, mid, ctx) {
    const cache = cachedMeta(readProviderCfg(), providerId);
    const meta = cache && cache.metaById ? cache.metaById[mid] : null;
    if (!meta) return [];
    if (applyBusy) return [];
    applyBusy = true;
    try {
      const data = readProviderCfg();
      const modelRule = data ? modelRuleOf(data, providerId, mid) : null;
      if (!currentProbe(ctx, data) || fetchCache.get(providerId) !== cache || !modelRule || !modelRule.config || typeof modelRule.config !== "object") return [];
      const props = modelRule.config.properties && typeof modelRule.config.properties === "object" && !Array.isArray(modelRule.config.properties)
        ? modelRule.config.properties : (modelRule.config.properties = {});
      const specs = modelRule.config.optionSpecs && typeof modelRule.config.optionSpecs === "object" ? modelRule.config.optionSpecs : (modelRule.config.optionSpecs = {});
      const out = [];
      if (meta.contextWindow && typeof props.contextWindow !== "number") {
        props.contextWindow = meta.contextWindow;
        out.push("contextWindow");
      }
      if (meta.maxOutputTokens) {
        const limit = specs.maxOutputTokens && typeof specs.maxOutputTokens === "object" ? specs.maxOutputTokens : (specs.maxOutputTokens = {});
        if (typeof limit.map !== "string" && typeof limit.max !== "number") {
          limit.max = meta.maxOutputTokens;
          out.push("maxOutputTokens");
        }
      }
      if (out.length) {
        writeProviderCfg(data);
        log("probe enriched spec for", providerId, mid, "->", out.join("/"));
      }
      return out;
    } catch (e) {
      return [];
    } finally {
      applyBusy = false;
    }
  }
  async function probeModel(providerId, modelId, opts) {
    providerId = planAliasId(providerId);   // issue #336：builtin: 旧形套餐 id 归一
    const probeCaps = !!(opts && opts.caps === true);
    const mid = sanitizeModelIds([modelId])[0] || "";
    if (!mid) return { ok: false, model: String(modelId || "").slice(0, MODEL_ID_MAX), kind: "invalid_model", error: "invalid model id" };
    const data = readProviderCfg();
    const rule = data ? findRule(data, providerId) : null;
    const planSrc = PLAN_SOURCES[String(providerId || "")];
    if (!planSrc && (!rule || !isPullable(rule))) return { ok: false, model: mid, kind: "provider", error: "provider not found" };
    if (!fetchImpl) return { ok: false, model: mid, kind: "network", error: "no network stack" };
    const cfg = rule ? effectiveRuleConfig(rule) : {};   // issue #383：probe 镜像宿主——宿主真实请求本就使用模板 baseUrl
    const api = cfg.api || {};
    const apiType = planSrc ? "anthropic-messages" : String(api.type || "");   // probe 链维持 anthropic models 端点实测语义
    const baseUrl = String((planSrc ? planSrc.baseUrl : api.baseUrl) || "").trim().replace(/\/+$/, "");
    const apiKey = planSrc ? planTokenOf(providerId) : String(((cfg.access || {}).apiKey) || "").trim();
    if (!apiKey) return { ok: false, model: mid, kind: "auth", error: "no api key" };
    const ctx = { providerId: providerId, source: providerSource(data, providerId), deadline: Date.now() + 80000 };
    let attempt = await probeRequest(apiType, baseUrl, apiKey, mid, null, ctx);
    let effectiveBase = baseUrl;
    let specEnriched = [];
    if (!attempt.ok && attempt.kind === "path" && !planSrc) {
      const repair = await probeRepairOnce(providerId, apiType, baseUrl, apiKey, mid, ctx);
      if (repair.base) {
        effectiveBase = repair.base;
        attempt = await probeRequest(apiType, repair.base, apiKey, mid, null, ctx);
        attempt.repaired = { from: baseUrl, to: repair.base };   // 写回已发生；重试仍失败也如实标记
      } else if (repair.tried && repair.tried.length) {
        attempt.tried = repair.tried;   // 修复候选也失败：渲染端披露试过的 URL
      }
    }
    if (attempt.ok && probeCaps && !planSrc) {
      specEnriched = await enrichSpecFromMeta(providerId, mid, ctx);
    }
    /* 辅助档位验证（v311）：仅 openai 两型且基础连通后（anthropic 型 catch-all 产出
     * thinking 型字段，off/disabled 即合法无此错配；套餐源同 skip） */
    if (attempt.ok && !planSrc && (apiType === "openai-chat-completions" || apiType === "openai-responses")) {
      delete attempt.full;
      const healed = await healReasoningLadder(providerId, apiType, effectiveBase, apiKey, mid, ctx);
      if (healed && healed.values) attempt.effortFixed = { values: healed.values };
      else if (healed && healed.failed) {
        attempt = Object.assign({}, attempt, { ok: false, model: mid, kind: "reasoning", status: healed.status, snippet: healed.snippet || "", accepted: acceptedEffortsFromSnippet(healed.snippet || "") || undefined });
      }
      if (attempt.ok) delete attempt.full;
      else {
        if (specEnriched.length) attempt.specEnriched = specEnriched;
        return attempt;
      }
    }
    /* 能力实测（v312）：确认流显式携带 caps 标志才跑（独立单测/裸探测不触发），仅
     * chat-completions 且基础连通后 */
    if (probeCaps && attempt.ok && !planSrc && apiType === "openai-chat-completions") {
      delete attempt.full;
      const caps = await healCapabilities(providerId, apiType, effectiveBase, apiKey, mid, ctx);
      if (caps && caps.added && caps.added.length) attempt.capabilitiesFixed = caps.added;
      if (caps && caps.warnings && caps.warnings.length) attempt.warnings = caps.warnings;
    }
    if (!currentProbe(ctx)) attempt = Object.assign({}, attempt, { ok: false, kind: "provider", error: "provider changed" });
    if (specEnriched.length) attempt.specEnriched = specEnriched;
    delete attempt.full;
    return attempt;
  }
