/* ---------- 宿主路径与供应商配置（builtin → personal） ---------- */
function resolveQuotaPaths(opts) {
  const o = opts || {}, env = o.env || process.env;
  const home = o.defaultHome || os.homedir();
  // 可独立注入 win32；非 Windows 测试/诊断也不能把 D:\\... 当 POSIX 相对路径。
  const pathOf = (p) => o.pathImpl || (/^(?:[a-z]:[\\/]|\\\\)/i.test(p) ? path.win32 : path);
  const absolute = (p) => {
    if (p === "~") p = home;
    else if (/^~[\\/]/.test(p)) p = pathOf(home).join(home, p.slice(2));
    return pathOf(p).resolve(p);
  };
  const base = absolute(o.dataBaseDir || env.ZCODE_DATA_BASE_DIR || o.desktopHome || env.ZCODE_DESKTOP_HOME_DIR || home);
  const root = pathOf(base).join(base, ".zcode", "v2");
  const credsPath = absolute(o.credsPath || pathOf(root).join(root, "credentials.json"));
  const customCfgPath = absolute(o.customCfgPath || env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || pathOf(root).join(root, "provider_config.json"));
  // Runtime builtin 文件由宿主按版本/endpoint 选择，不能扫描或猜测其它缓存副本。
  const builtin = o.builtinCfgPath || env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const builtinCfgPath = builtin ? absolute(builtin) : "";
  return { credsPath, customCfgPath, builtinCfgPath,
    credsDir: pathOf(credsPath).dirname(credsPath),
    customCfgDir: pathOf(customCfgPath).dirname(customCfgPath),
    builtinCfgDir: builtinCfgPath ? pathOf(builtinCfgPath).dirname(builtinCfgPath) : "" };
}
let providerCfgCache = null;
function loadProviderCfg(readFile2, cfgPath, builtinCfgPath) {
  const paths = [builtinCfgPath, cfgPath].filter(Boolean);
  let stamp = null;
  try { stamp = JSON.stringify(paths.map((p) => { const s = fs.statSync(p); return [p, s.mtimeMs, s.size]; })); }
  catch (e) { providerCfgCache = null; /* stat 失败仍现读，并撤销旧缓存，避免同时间戳重建后复活旧 key */ }
  if (stamp !== null && providerCfgCache && providerCfgCache.stamp === stamp && providerCfgCache.readFile === readFile2) {
    return providerCfgCache.byId;
  }
  const templates = new Map();
  const rules = new Map();
  for (const p of paths) {
    try {
      const d = readFile2(p);
      const pcr = (d.config || {}).providerConfigRules || {};
      /* Array.isArray 守卫：真值非数组的 templateRules 不能连累同文件 providerRules（基线行为） */
      for (const t of Array.isArray(pcr.templateRules) ? pcr.templateRules : []) {
        if (!t || !t.templateId) continue;
        const old = templates.get(String(t.templateId)) || {}, cfg = t.config || {};
        templates.set(String(t.templateId), {
          access: Object.assign({}, old.access, cfg.access),
          api: Object.assign({}, old.api, cfg.api),
        });
      }
      for (const r of pcr.providerRules || []) {
        if (!r || !r.providerId) continue;
        const old = rules.get(String(r.providerId)) || {}, cfg = r.config || {};
        rules.set(String(r.providerId), {
          name: r.providerName == null ? old.name : String(r.providerName),
          templateId: r.templateId == null ? old.templateId : String(r.templateId),
          access: Object.assign({}, old.access, cfg.access),
          api: Object.assign({}, old.api, cfg.api),
        });
      }
    } catch (e) { /* 损坏/缺失按无配置处理 */ }
  }
  const byId = new Map();
  for (const [id, cfg] of rules) {
    /* 模板创建的供应商（个人配置不含 baseUrl）从内置 templateRules 回填
     * baseUrl/access；显式配置仍优先，显式空串 baseUrl 按未填处理回落模板。 */
    const tpl = cfg.templateId ? templates.get(cfg.templateId) : null;
    const api = Object.assign({}, tpl && tpl.api, cfg.api);
    const access = Object.assign({}, tpl && tpl.access, cfg.access);
    if (!api.baseUrl && tpl && tpl.api) api.baseUrl = tpl.api.baseUrl;
    byId.set(id, { baseUrl: String(api.baseUrl || "").replace(/\/+$/, ""), apiKey: String(access.apiKey || ""), name: cfg.name || "",
      accessType: String(access.type || "") });
  }
  if (stamp !== null) providerCfgCache = { stamp, readFile: readFile2, byId };
  return byId;
}
function resolveCustomProvider(providerId, readFile2, cfgPath, builtinCfgPath) {
  const e = loadProviderCfg(readFile2, cfgPath, builtinCfgPath).get(String(providerId));
  return e ? { baseUrl: e.baseUrl, apiKey: e.apiKey, name: e.name } : null;
}

/* apiKey 模式的 BigModel/Z.ai 连接（provider bigmodel-api[-N] / zai-api[-N]）：额度端点与 OAuth 同属账号池，
 * 凭据取 provider_config 里同家族的 key，编码套餐 key（access.type 以 coding-plan-api-key 结尾）优先，
 * 其次当前 provider 自身，再其次同家族首个非空 key。baseUrl 若显式配置必须落在官方域，
 * 否则视为指向第三方中转的同名 provider，绝不把它的 key 发往官方域。 */
const API_KEY_PROVIDER_RE = /^(bigmodel|zai)-api(?:-\d+)?$/;
const FAMILY_HOST_RE = { bigmodel: /(^|\.)bigmodel\.cn$/i, zai: /(^|\.)z\.ai$/i };
function apiKeyFamilyOf(providerId) {
  const m = API_KEY_PROVIDER_RE.exec(String(providerId || ""));
  return m ? m[1] : "";
}
function resolveFamilyApiKey(family, providerId, readFile2, cfgPath, builtinCfgPath) {
  const usable = [];
  for (const [id, e] of loadProviderCfg(readFile2, cfgPath, builtinCfgPath)) {
    if (apiKeyFamilyOf(id) !== family || !e.apiKey) continue;
    if (e.baseUrl) {
      let host = "";
      try { host = new URL(e.baseUrl).hostname; } catch (err) { continue; }
      if (!FAMILY_HOST_RE[family].test(host)) continue;
    }
    usable.push({ id, key: e.apiKey, plan: /coding-plan-api-key$/.test(e.accessType) });
  }
  const pick = usable.find((u) => u.plan && u.id === providerId) || usable.find((u) => u.plan) ||
    usable.find((u) => u.id === providerId) || usable[0];
  return pick ? pick.key : "";
}

