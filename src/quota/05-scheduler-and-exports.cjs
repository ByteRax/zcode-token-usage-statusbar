/* ---------- 多源调度器 ---------- */
function createQuotaClient(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const now = o.now || (() => Date.now());
  const fetchImpl = o.fetchImpl || (typeof fetch === "function" ? fetch : null);
  /* v135 双门控：quota_enabled 只关额度 chip 的查询链；reset_badge_enabled 独立控制重置卡。
   * 额度关 + 重置开时主进程仍解密凭据（仅查 reset/status 只读端点）——⚙ 面板已披露该联网语义。 */
  const quotaOn = o.quotaEnabled || (() => true);
  /* resetOn 缺省关：reset 链是注入侧显式启用的附加功能（inject-main 传 resetBadgeEnabled），
   * 库内默认关保证旧宿主装配/测试夹具零改动兼容，冷热混部时也只是少徽标不报错 */
  const resetOn = o.resetEnabled || (() => false);
  /* resetListOn 同理缺省关：bigmodel 族并行查网页控制台列表端点补充过期卡历史
   * （status 端点无过期历史）；请求量翻倍且属增强数据，由注入侧显式开启 */
  const resetListOn = typeof o.resetList === "function" ? o.resetList : (o.resetList ? () => true : () => false);
  const { credsPath, customCfgPath, builtinCfgPath, credsDir } = resolveQuotaPaths(o);
  /* v2 凭据（宿主 3.18.0 enc:v2:os）绑定真实路径上下文并预热 keychain 密钥缓存：
   * 异步预热、解密同步读缓存；未热时解密失败走 pending 短重试（见 tickSource）。 */
  setDefaultDecryptCtx({ credsPath, credsDir, resourcesDir: o.resourcesDir, env });
  void ensureDefaultV2Key();
  const secretsPath = o.secretsPath || path.join(path.dirname(credsPath), "quota-secrets.json");
  const readFile = o.readFile || ((p) => JSON.parse(fs.readFileSync(p, "utf8")));
  const log = o.log || (() => {});
  const onUpdate = o.onUpdate || null;

  /* quota-secrets.json：运行目录 0600（首读强制收紧权限）；损坏/缺失按空配置 */
  let secretsMtime = -2, secrets = { sources: {} };
  function readSecrets() {
    let m = -1;
    try { m = fs.statSync(secretsPath).mtimeMs; }
    catch (e) { m = -1; }   // stat 失败不短路：仍尝试读取（测试虚拟路径/权限受限）；-1 不缓存
    if (m !== secretsMtime) {
      try {
        const d = readFile(secretsPath);
        secrets = d && typeof d === "object" && d.sources && typeof d.sources === "object" ? d : { sources: {} };
      } catch (e) { secrets = { sources: {} }; }
      if (m >= 0) secretsMtime = m; else return secrets;
    }
    return secrets;
  }
  const extras = {};   // 快照侧注入的账本数据（scnet 估算等）：noteSnapshotExtras 写入

  /* HTTP 助手：分类错误（401/403 auth_failed、429 rate_limited、5xx/其它 network_error、
   * JSON 解析 parse_error）；maybeGetJson 任何失败返回 null（探测/可选端点用）。 */
  function classifyStatus(status, headers) {
    if (status === 401 || status === 403) return qErr("auth_failed", "HTTP " + status, { httpStatus: status });
    if (status === 429) {
      const ra = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
      return qErr("rate_limited", "HTTP 429", { retryAfterMs: parseRetryAfterMs(ra) });
    }
    return qErr("network_error", "HTTP " + status, { httpStatus: status });
  }
  async function rawFetch(url, headers, ctl, method) {
    const res = await fetchImpl(url, {
      method: method || "GET",
      headers: Object.assign({ accept: "application/json", "accept-encoding": "identity" }, headers),
      signal: ctl ? ctl.signal : undefined, redirect: "manual",
    });
    let text = "";
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push(step.value); size += step.value.length;
        if (size > BODY_LIMIT) { try { ctl.abort(); } catch (e) { } throw qErr("parse_error", "response too large"); }
      }
      const buf = Buffer.alloc(size); let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      text = buf.toString("utf8");
    } else {
      text = await res.text();
      if (text.length > BODY_LIMIT) throw qErr("parse_error", "response too large");
    }
    return { status: res.status, headers: res.headers, text };
  }
  const http = {
    async getJson(url, headers, ctl) {
      const r = await rawFetch(url, headers, ctl);
      if (r.status < 200 || r.status >= 300) throw classifyStatus(r.status, r.headers);
      try { return JSON.parse(r.text); } catch (e) { throw qErr("parse_error", "invalid json"); }
    },
    async maybeGetJson(url, headers, ctl) {
      try { return await http.getJson(url, headers, ctl); } catch (e) { return null; }
    },
    async post(url, headers, ctl) {
      const r = await rawFetch(url, headers, ctl, "POST");
      let json = null;
      try { json = JSON.parse(r.text); } catch (e) { json = null; }
      const meta = json && json.ResponseMetadata && json.ResponseMetadata.Error;   // 火山信封：HTTP 200 也可能带错
      if (meta && meta.Code) {
        const c = String(meta.Code);
        if (/auth|signature|accessdenied|denied|unauthorized|forbidden|credential|token/i.test(c)) throw qErr("auth_failed", c.slice(0, 60));
        throw qErr("network_error", c.slice(0, 60));
      }
      if (json && json.Error && json.Error.Code) {
        const c = String(json.Error.Code);
        if (/auth|signature|denied|unauthorized|forbidden/i.test(c)) throw qErr("auth_failed", c.slice(0, 60));
        throw qErr("network_error", c.slice(0, 60));
      }
      if (r.status < 200 || r.status >= 300) {
        /* 非 2xx：body 带 JSON 错误信封的已在上面按信封分类（签名错常 400 非 401）；
         * 剩下的（如网关 HTML 错误页）按状态分类——瞬时错误走 network_error 阶梯，
         * 不冒充 parse_error 的 30 分钟长退避（与 getJson 的状态优先同向，2026-10-24 审计修复）。 */
        throw classifyStatus(r.status, r.headers);
      }
      if (!json) throw qErr("parse_error", "invalid json");
      return json;
    },
  };

  /* 团队套餐选择所在的 setting.json：恒在 HOME/.zcode/v2（不随 dataBaseDir 迁移）；测试可注入 */
  const settingPath = o.settingPath || path.join(os.homedir(), ".zcode", "v2", "setting.json");
  const j = {
    env, now, fetchImpl, readFile, secrets: { sources: {} }, customCfgPath, log, http, extras,
    credsPath, settingPath,
    customProviderOf: (pid) => resolveCustomProvider(pid, readFile, customCfgPath, builtinCfgPath),
    familyApiKeyOf: (family, pid) => resolveFamilyApiKey(family, pid, readFile, customCfgPath, builtinCfgPath),
  };

  /* 源状态：id → st（v96 单源状态机的每源实例） */
  const states = new Map();
  const byProvider = {};   // providerId → 源 id（同厂商不同 provider 也隔离）
  let wantedProviders = null;   // null 为旧渲染端单源模式；数组来自全部存活 pane 的实时选择

  function adapterOf(id) { return ADAPTER_BY_ID.get(String(id).split(":")[0]); }
  let primaryId = "";        // 本 pane 会话模型归属的源（chip 主显）
  let primaryProvider = "";  // 最近一次 noteProvider 的原始 provider 串
  let seq = 0;

  function stateOf(id) {
    let st = states.get(id);
    if (!st) {
      st = { id, status: "idle", reason: "", value: null, fetchedAt: 0, nextAt: 0, backoffIdx: 0,
        fingerprint: "", epoch: 0, inFlight: null, ctl: null, lastError: "", ctx: null };
      states.set(id, st);
    }
    return st;
  }
  function setState(st, fields) {
    Object.assign(st, fields);
    if (onUpdate) onUpdate();
  }

  /* provider → 源 id 解析（primary 专用；custom 匹配官方域适配器优先于 generic relay） */
  function resolvePrimary(providerId) {
    const p = String(providerId || "");
    if (!p) return { id: "" };
    if (p.indexOf("account:") === 0) {
      const teamFam = teamFamilyOf(p);
      if (teamFam) return { id: teamFam + "-team", ctx: { family: teamFam, team: true } };
      if (zcodeStartDetectOf(p)) return { id: "zcode-start", ctx: { family: "zcode-start" } };
      if (p.indexOf("account:bigmodel") === 0) return { id: "bigmodel", ctx: { family: "bigmodel" } };
      if (p.indexOf("account:zai") === 0) return { id: "zai", ctx: { family: "zai" } };
      return { id: "" };
    }
    const keyFam = apiKeyFamilyOf(p);
    if (keyFam) return { id: keyFam, ctx: { family: keyFam, apiKeyProvider: p }, provider: p };
    j.secrets = readSecrets();   // provider→adapter 探测前刷新配置
    for (const a of ADAPTERS) {
      if (a.id === "custom" || a.id === "bigmodel" || a.id === "zai") continue;
      try {
        const ctx = a.detect(j, p);
        if (ctx) return { id: a.id, ctx, provider: p };
      } catch (e) { /* detect 抛错按不命中 */ }
    }
    const ctx = ADAPTER_BY_ID.get("custom").detect(j, p);
    /* custom 源按 provider 隔离（custom:<pid>）：两个不同中转的窗口各持独立状态/key，
     * 互不覆盖、互不串显；未命中同样建独立空源（unsupported/provider）。 */
    return { id: "custom:" + p, ctx, provider: p };
  }

  function settleError(st, ep, err) {
    if (ep !== st.epoch) return;   // 代际守卫：源凭据/身份已切换，旧响应丢弃
    const code = err && err.code || "network_error";
    st.lastError = String(err && err.message || code).slice(0, 120);
    st.status = code;
    if (code === "auth_failed" || code === "no_plan") st.nextAt = Infinity;
    else if (code === "parse_error") st.nextAt = now() + PARSE_BACKOFF_MS;
    else if (code === "rate_limited") st.nextAt = now() + (err.retryAfterMs || 60 * 1000);
    else st.nextAt = now() + BACKOFF_MS[Math.min(st.backoffIdx++, BACKOFF_MS.length - 1)];
    log("quota settle:", st.id, code, st.lastError);
    if (onUpdate) onUpdate();
  }
  function settleOk(st, ep, value) {
    if (ep !== st.epoch) return;
    st.value = value;
    st.fetchedAt = now();
    st.status = "ok";
    st.lastError = "";
    st.backoffIdx = 0;
    const a = adapterOf(st.id);
    st.nextAt = now() + (a && a.kind === "balance" ? TTL_BALANCE_MS : TTL_MS);
    if (onUpdate) onUpdate();
  }

  function startFetch(adapter, st) {
    st.epoch += 1;
    const ep = st.epoch;
    const ctl = new AbortController();
    st.ctl = ctl;
    const kill = setTimeout(() => { try { ctl.abort(); } catch (e) { } }, FETCH_TIMEOUT_MS);
    if (kill && typeof kill.unref === "function") kill.unref();
    if (ctl.signal && typeof ctl.signal.addEventListener === "function") {
      ctl.signal.addEventListener("abort", () => clearTimeout(kill), { once: true });
    }
    const p = (async () => {
      const value = await adapter.fetchOne(j, st.ctx, st.cred, ctl);
      if (value && value.noPlan) { const e = qErr("no_plan", "no plan"); e.st = st; throw e; }
      if (value == null) { const e = qErr("unsupported", "gateway"); e.st = st; throw e; }   // custom：识别不了的网关
      settleOk(st, ep, value);
    })()
      .catch((e) => {
        const target = e && e.st || st;
        if (e && e.code === "no_plan") { if (ep === target.epoch) { target.status = "no_plan"; target.nextAt = Infinity; target.lastError = "no plan"; if (onUpdate) onUpdate(); } return; }
        if (e && e.code === "unsupported") { if (ep === target.epoch) { target.status = "unsupported"; target.reason = e.reason || "gateway"; target.value = null; target.lastError = ""; target.nextAt = now() + PARSE_BACKOFF_MS; if (onUpdate) onUpdate(); } return; }
        settleError(target, ep, e);
      })
      .finally(() => { clearTimeout(kill); });
    st.inFlight = p;
    const q = p;
    if (onUpdate) onUpdate();
    p.then(() => {
      if (st.inFlight !== q) return;
      st.inFlight = null;
      if (onUpdate) onUpdate();
    });   // fetchOne 包装自身不 reject
  }

  function tickSource(adapter, st, force) {
    j.secrets = readSecrets();
    if (((j.secrets.sources || {})[adapter.id] || {}).enabled === false) return false;
    const t = now();
    if (st.inFlight) return false;
    if (!force && t < st.nextAt) return false;
    const ctx = st.ctx;
    if (!ctx) {
      if (adapter.id === "custom") {   // 无配置的自定义供应商：unsupported/provider（v96 兼容语义）
        if (st.status !== "unsupported" || st.reason !== "provider") setState(st, { status: "unsupported", reason: "provider", value: null });
      } else if (st.status !== "not_configured") setState(st, { status: "not_configured", reason: "", lastError: "" });
      st.nextAt = t + NOT_CONFIGURED_RETRY_MS;
      return false;
    }
    const cred = adapter.resolveCred(j, ctx);
    if (!cred) {
      if (st.status !== "not_configured") setState(st, { status: "not_configured", reason: "", lastError: "" });
      st.nextAt = t + NOT_CONFIGURED_RETRY_MS;
      return false;
    }
    if (cred.decryptFailed) {
      if (st.status !== "not_configured") setState(st, { status: "not_configured", reason: "decrypt", lastError: "credential decrypt failed" });
      /* v2 密钥缓存未热是瞬态（预热在途）：1 秒短重试；真不可解（keychain 缺失等）维持低频 */
      st.nextAt = t + (v2KeyPending() ? 1000 : NOT_CONFIGURED_RETRY_MS);
      return false;
    }
    if (cred.fingerprint !== st.fingerprint) {
      st.fingerprint = cred.fingerprint;
      st.backoffIdx = 0;
      if (st.status === "auth_failed" || st.status === "no_plan" || (st.status === "unsupported" && st.reason === "gateway")) st.status = "idle";
      st.nextAt = 0;
    }
    if (!force && (st.status === "auth_failed" || st.status === "no_plan")) return false;
    /* 凭据刚就绪（钥匙串密钥到位、用户补了 key）：离开「未配置」，无论 token 是否临期——
     * 否则临期早退会把上一拍的 decrypt 失败状态原样留在面板上 */
    if (st.status === "not_configured") { st.status = "idle"; st.reason = ""; st.lastError = ""; }
    if (cred.source === "host" || cred.source === "env") {
      const exp = jwtExpMs(cred.token || "");
      if (exp && exp - t < EXP_SOON_MS) { st.nextAt = t + EXP_RETRY_MS; return false; }
    }
    st.cred = cred;
    startFetch(adapter, st);
    return true;
  }

  /* 配置撤销清展示值并换代；不通知 onUpdate，避免 view/settings 重评递归推送。 */
  function deactivateSource(st, status) {
    if (st.status === status && !st.value && !st.inFlight && !st.fingerprint) return;
    st.epoch += 1;
    if (st.ctl) { try { st.ctl.abort(); } catch (e) { } }
    Object.assign(st, { status, reason: "", value: null, fetchedAt: 0, nextAt: 0,
      backoffIdx: 0, fingerprint: "", cred: null, ctl: null, inFlight: null, lastError: "" });
  }

  /* 活跃源集合：primary + 全部可解析的零配置适配器 + secrets 显式启用的配置适配器 */
  function activeSet() {
    j.secrets = readSecrets();
    const set = new Map();
    const wanted = wantedProviders === null ? [primaryProvider] : wantedProviders;
    for (const providerId of wanted) {
      const id = byProvider[providerId] || "";
      if (id === "team") {
        const st = stateOf(id);
        if (st.status !== "unsupported") setState(st, { status: "unsupported", reason: "team" });
        continue;
      }
      const a = adapterOf(id);
      if (!a) continue;
      const st = stateOf(id);
      const cfg = (j.secrets.sources || {})[a.id] || {};
      if (cfg.enabled === false) continue;
      if (a.id === "anthropic" && cfg.enabled !== true) continue;   // anthropic 仅显式启用（终版契约）
      set.set(id, { a, st });
    }
    for (const a of ADAPTERS) {
      if (a.id === "custom" || set.has(a.id)) continue;   // custom 系只在 primary 分支进入
      /* 账户复合源（vendor:providerId）已入集时跳过裸厂商源：同一凭据两条状态
       * 会重复请求同一端点（secrets 键被两者共用），账户源已覆盖该厂商。 */
      let vendorCovered = false;
      for (const k of set.keys()) if (k.indexOf(a.id + ":") === 0) { vendorCovered = true; break; }
      if (vendorCovered) continue;
      const secCfg = (j.secrets.sources || {})[a.id] || {};
      const enabledCfg = secCfg.enabled === true;
      const hasEnv = a.envKeys.some((key) => !!j.env[key]);
      const hasConfigured = !!(secCfg.apiKey || secCfg.cookie || secCfg.token || secCfg.accessKeyId);
      if (secCfg.enabled !== false && (enabledCfg || (a.defaultOn && (hasEnv || hasConfigured)))) {
        const st = stateOf(a.id);
        if (!st.ctx) {
          const auto = hasEnv || secCfg.apiKey || secCfg.cookie || secCfg.token || (a.id === "scnet" && num(secCfg.planCredits) > 0) ||
            (a.id === "anthropic") || (a.id === "volcano" && (j.env.VOLCENGINE_ACCESS_KEY_ID || secCfg.accessKeyId));
          if (auto || a.id === "scnet") st.ctx = { config: true, family: a.id };   // anthropic 已改显式启用：enabled+凭据可得才激活
        }
        if (st.ctx) set.set(a.id, { a, st });
        else if (a.defaultOn) {
          /* 零配置适配器但探测不到 provider：仅当 primary 是它时才标 not_configured，否则静默跳过 */
        }
      }
    }
    for (const [id, st] of states) {
      const a = adapterOf(id);   // 复合源 id（vendor:providerId）也须命中：禁用/撤销/解密检查不得跳过账户源
      if (!a) continue;
      const cfg = (j.secrets.sources || {})[a.id] || {};
      if (cfg.enabled === false) {
        deactivateSource(st, "disabled");
      } else if (a.id !== "custom" && !set.has(id)) {
        /* 复合账户源（id 含 ":"）随 pane 离开只视为不在集合：保留 TTL 内缓存供切回即用；
         * 禁用（enabled=false）与凭据失效（resolveCred 空）的撤销在各自分支执行。 */
        if (id.indexOf(":") < 0) deactivateSource(st, "not_configured");
      } else if (set.has(id) && st.ctx) {
        const cred = a.resolveCred(j, st.ctx);
        if (!cred || cred.decryptFailed) {
          deactivateSource(st, "not_configured");
          if (cred && cred.decryptFailed) {
            st.reason = "decrypt";
            st.lastError = "credential decrypt failed";
          }
        } else if (st.status === "disabled") st.status = "idle";
      }
    }
    return set;
  }

  let primaryCtx = null;

  function tick(force) {
    let started = 0;
    void ensureDefaultV2Key();   // v2 密钥缓存预热：已缓存/在途时为廉价空转（memoize）
    const qOn = quotaOn();
    const set = activeSet();   // 撤销/禁用重评始终执行；额度关时只停联网查询
    if (qOn) for (const { a, st } of set.values()) if (tickSource(a, st, force)) started++;
    tickReset(force);
    return started;
  }

  function rememberProvider(providerId) {
    const r = resolvePrimary(providerId);
    if (r.id && providerId.indexOf("account:") !== 0 && r.id.indexOf(":") < 0) {
      r.id += ":" + providerId;
    }
    byProvider[providerId] = r.id || "";
    if (!r.id || r.id === "team") return r;
    const st = stateOf(r.id);
    const contextStamp = sha16(JSON.stringify(r.ctx || null));
    if (st.contextStamp !== contextStamp) {
      st.epoch += 1;
      if (st.ctl) st.ctl.abort();
      st.inFlight = null;
      st.ctx = r.ctx || null;
      st.contextStamp = contextStamp;
      st.value = null;
      st.fetchedAt = 0;
      st.status = "idle";
      st.reason = "";
      st.lastError = "";
      st.fingerprint = "";
      st.backoffIdx = 0;
      st.nextAt = 0;
    }
    return r;
  }

  function entryView(st) {
    const t = now();
    const a = adapterOf(st.id);
    const ttl = a && a.kind === "balance" ? TTL_BALANCE_MS : TTL_MS;
    const cfg = a ? ((j.secrets.sources || {})[a.id] || {}) : {};
    const v = { status: cfg.enabled === false ? "disabled" : st.status, reason: st.reason, fetchedAt: st.fetchedAt,
      stale: !!(st.fetchedAt && t - st.fetchedAt > ttl), error: st.lastError };
    if (cfg.enabled === false) return v;
    v.busy = !!st.inFlight;
    if (st.value) {
      v.level = st.value.level;
      v.plan = st.value.plan || null;
      v.balance = st.value.balance || null;
      v.windows = st.value.windows;
      v.tools = st.value.tools;
      v.models = st.value.models;
      v.ledger = st.value.ledger || null;
      if (st.value.label) v.label = st.value.label;
      if (st.value.kind) v.kind = st.value.kind;
      if (st.value.subscription) v.subscription = st.value.subscription;
      if (st.value.quotaSummary) v.quotaSummary = st.value.quotaSummary;
    }
    return v;
  }

  /* ---------- v135 重置卡轮询器（独立链，账号族级） ----------
   * 端点在 ZCode API 基址 zcode.z.ai（宿主 dn(env, `${bP}/status`) 同款，与 OAuth token
   * 端点同源；实测 bigmodel.cn/api.z.ai 均 404 NOT_FOUND）。两族只差 X-Bigmodel-Authorization
   * 的凭据键（oauth:bigmodel / oauth:zai），各自持 OAuth+zcodejwttoken 才查该族。
   * apiKey-only 用户无此数据（reset 端点是宿主登录态契约）；失败保留最近成功值由 view 标
   * stale（同额度链口径），绝不构造假数据。 */
  const RESET_ORIGIN = "https://zcode.z.ai";
  const RESET_LIST_ORIGIN = "https://bigmodel.cn";
  const RESET_FAMILIES = [
    { fam: "bigmodel", credKey: "oauth:bigmodel:access_token", listPath: "/api/biz/customer-package-reset/list?targetType=PERSONAL" },
    { fam: "zai", credKey: "oauth:zai:access_token" },
  ];
  const resetStates = new Map();
  function resetStateOf(fam) {
    let st = resetStates.get(fam);
    if (!st) {
      st = { status: "idle", value: null, fetchedAt: 0, nextAt: 0, backoffIdx: 0,
        fingerprint: "", epoch: 0, inFlight: null, ctl: null, lastError: "" };
      resetStates.set(fam, st);
    }
    return st;
  }
  function resolveResetCred(famConf) {
    let raw = null;
    try { raw = j.readFile(j.credsPath); } catch (e) { return null; }
    if (!raw || typeof raw !== "object") return null;
    const oauthEnc = raw[famConf.credKey];
    if (typeof oauthEnc !== "string" || !oauthEnc) return null;
    const oauth = decryptValue(oauthEnc, deriveCipherKey(j.env));
    if (!oauth) return { decryptFailed: true, fingerprint: "host:" + sha16(oauthEnc) };
    if (!oauth.trim()) return null;
    const sel = teamSelectionOf(j, famConf.fam);
    if (sel) {
      /* 团队模式：targetType=TEAM 列表只认业务身份——业务 token + org/project，个人 zcodejwttoken 不参与 */
      return { oauth: oauth.trim(), team: sel,
        fingerprint: sha16(JSON.stringify([famConf.fam, sel.org, sel.project, oauthEnc])) };
    }
    const jwtEnc = raw["zcodejwttoken"];
    if (typeof jwtEnc !== "string" || !jwtEnc) return null;
    const jwt = decryptValue(jwtEnc, deriveCipherKey(j.env));
    if (!jwt || !jwt.trim()) return { decryptFailed: true, fingerprint: "host:" + sha16(oauthEnc + "\n" + jwtEnc) };
    return { oauth: oauth.trim(), jwt: jwt.trim(), fingerprint: sha16(JSON.stringify([oauthEnc, jwtEnc])) };
  }
  /* 关闭门控时清除整个独立链；view/sourcesConfig 不发回调，避免推送时递归。 */
  function resetGateOpen() {
    if (resetOn()) return true;
    for (const st of resetStates.values()) {
      st.epoch += 1;
      if (st.ctl) { try { st.ctl.abort(); } catch (e) { } }
    }
    resetStates.clear();
    return false;
  }
  /* 在推送前或发请求前复核凭据；身份变化时清除旧账户值并废弃在途结果。 */
  function syncResetCredential(st, cred) {
    const fingerprint = cred && !cred.decryptFailed && cred.oauth && (cred.jwt || cred.team) ? cred.fingerprint : "";
    const error = cred && cred.decryptFailed ? "credential decrypt failed" : "";
    if (fingerprint === st.fingerprint && (fingerprint || (st.status === "not_configured" && st.lastError === error))) return false;
    st.epoch += 1;
    if (st.ctl) { try { st.ctl.abort(); } catch (e) { } }
    Object.assign(st, { ctl: null, inFlight: null, value: null, fetchedAt: 0,
      fingerprint, backoffIdx: 0, nextAt: 0, status: fingerprint ? "idle" : "not_configured", lastError: error });
    return true;
  }
  function tickReset(force) {
    if (!resetGateOpen()) return;
    const t = now();
    for (const famConf of RESET_FAMILIES) {
      if (!resetGateOpen()) return;
      const st = resetStateOf(famConf.fam);
      let cred = resolveResetCred(famConf);
      const changed = syncResetCredential(st, cred);
      if (changed && onUpdate) onUpdate();
      if (!resetGateOpen() || resetStates.get(famConf.fam) !== st) return;
      if (!st.fingerprint || st.inFlight) continue;
      if (changed && onUpdate) {   // 回调可能同步更换或撤销凭据
        cred = resolveResetCred(famConf);
        if (syncResetCredential(st, cred)) { onUpdate(); continue; }
      }
      if (!force && t < st.nextAt) continue;
      if (!force && st.status === "auth_failed") continue;
      if (!cred.team) {
        const exp = jwtExpMs(cred.jwt);
        if (exp && exp - t < EXP_SOON_MS) { st.nextAt = t + EXP_RETRY_MS; continue; }   // JWT 临期不发请求（个人链）
      }
      st.epoch += 1;
      const ep = st.epoch;
      const ctl = new AbortController();
      st.ctl = ctl;
      const kill = setTimeout(() => { try { ctl.abort(); } catch (e) { } }, FETCH_TIMEOUT_MS);
      if (kill && typeof kill.unref === "function") kill.unref();
      if (ctl.signal && typeof ctl.signal.addEventListener === "function") {
        ctl.signal.addEventListener("abort", () => clearTimeout(kill), { once: true });
      }
      const p = (async () => {
        if (cred.team) {
          /* 团队模式：个人 reset/status 不适用，只打 targetType=TEAM 列表（成员可用的卡）。
           * 鉴权与配额链同款=项目 PAT（ensureTeamPat 换取并缓存）；值形与个人链对齐
           * （fiveHour/week 仅存未过期可用卡），供徽标同款消费。 */
          const pat = await ensureTeamPat(j, famConf.fam, cred.team, cred.oauth, ctl);
          const teamList = await j.http.getJson(RESET_LIST_ORIGIN + "/api/biz/customer-package-reset/list?targetType=TEAM", {
            authorization: pat,
            "Bigmodel-Organization": cred.team.org,
            "Bigmodel-Project": cred.team.project,
            "set-language": "zh",
          }, ctl);
          const parsed = normalizeResetList(teamList, now());
          if (!parsed || !parsed.list) throw qErr("parse_error", "invalid team reset list");
          const live = (cards) => (cards || []).filter((c) => c && c.available !== false &&
            typeof c.expireAt === "number" && c.expireAt > now()).map((c) => ({ expireAt: c.expireAt, grantType: c.grantType || "" }));
          return { fiveHour: live(parsed.list.fiveHour), week: live(parsed.list.weekly), list: parsed.list };
        }
        const body = await j.http.getJson(RESET_ORIGIN + RESET_PATH, {
          authorization: /^Bearer\s/i.test(cred.jwt) ? cred.jwt : "Bearer " + cred.jwt,
          "X-Bigmodel-Authorization": cred.oauth,   // 宿主契约：裸 token，不套 Bearer
          "Bigmodel-Target-Type": "PERSONAL",
        }, ctl);
        const value = normalizeResetStatus(body, now());
        if (famConf.listPath && resetListOn()) {
          /* 网页控制台列表端点：补充近 7 天过期卡与上次重置时间（status 无过期历史）。
           * 与 subscription 同款可选并行——失败/形状变化静默降级，不影响 status 主链。 */
          const listBody = await j.http.maybeGetJson(RESET_LIST_ORIGIN + famConf.listPath,
            { authorization: cred.oauth, "set-language": "zh" }, ctl);
          const extra = listBody ? normalizeResetList(listBody, now()) : null;
          if (extra) {
            value.list = extra.list;
            if (extra.lastFiveHour) value.lastFiveHour = extra.lastFiveHour;
            if (extra.lastWeek) value.lastWeek = extra.lastWeek;
          }
        }
        return value;
      })().then((value) => {
        if (!resetGateOpen() || resetStates.get(famConf.fam) !== st || ep !== st.epoch) return;
        if (syncResetCredential(st, resolveResetCred(famConf))) { if (onUpdate) onUpdate(); return; }
        st.value = value;
        st.fetchedAt = now();
        st.status = "ok";
        st.lastError = "";
        st.backoffIdx = 0;
        st.nextAt = now() + RESET_TTL_MS;
      }).catch((e) => {
        if (!resetGateOpen() || resetStates.get(famConf.fam) !== st || ep !== st.epoch) return;
        if (syncResetCredential(st, resolveResetCred(famConf))) { if (onUpdate) onUpdate(); return; }
        const code = e && e.code || "network_error";
        st.lastError = String(e && e.message || code).slice(0, 120);
        st.status = code;
        if (code === "auth_failed") st.nextAt = Infinity;   // 冻结到凭据指纹变化
        else if (code === "parse_error") st.nextAt = now() + RESET_PARSE_BACKOFF_MS;
        else if (code === "rate_limited") st.nextAt = now() + (e.retryAfterMs || 60 * 1000);
        else st.nextAt = now() + BACKOFF_MS[Math.min(st.backoffIdx++, BACKOFF_MS.length - 1)];
        log("quota reset:", famConf.fam, code, st.lastError);
      }).finally(() => {
        clearTimeout(kill);
        if (!resetGateOpen() || resetStates.get(famConf.fam) !== st || st.inFlight !== p) return;
        st.inFlight = null;
        st.ctl = null;
        if (onUpdate) onUpdate();
      });
      st.inFlight = p;
    }
  }

  const client = {
    tick,
    refresh() { v2KeyRetryNow(); return tick(true) > 0; },   // 用户显式刷新：越过 v2 密钥冷却/失配限频
    refreshSource(id) {   // 厂商按钮刷新该厂商各账户；chip 的完整源 id 只刷新本账户
      const a = adapterOf(id);
      if (!a) return false;
      v2KeyRetryNow();
      let started = false;
      if (String(id).indexOf(":") >= 0) {
        const st = states.get(id);
        if (st) started = tickSource(a, st, true);
      } else {
        for (const st of states.values()) if (adapterOf(st.id) === a) started = tickSource(a, st, true) || started;
      }
      return started;
    },
    noteProvider(providerId) {
      const p = String(providerId || "");
      if (p === primaryProvider && wantedProviders === null) return;
      wantedProviders = null;
      primaryProvider = p;
      if (!p) { primaryId = ""; primaryCtx = null; return; }
      const r = rememberProvider(p);
      primaryId = r.id;
      primaryCtx = r.ctx || null;
    },
    setProviders(providerIds) {
      const next = Array.from(new Set((Array.isArray(providerIds) ? providerIds : [])
        .filter((p) => typeof p === "string" && p.length > 0 && p.length <= 160 && !/[\x00-\x1f\x7f]/.test(p))));
      const ids = new Set();
      for (const p of next) ids.add(rememberProvider(p).id);
      for (const p of Object.keys(byProvider)) if (!next.includes(p)) delete byProvider[p];
      if (!next.includes(primaryProvider)) primaryProvider = next[0] || "";
      primaryId = byProvider[primaryProvider] || "";
      primaryCtx = primaryId ? stateOf(primaryId).ctx : null;
      wantedProviders = next;
      for (const [id, st] of states) {
        if (id.indexOf(":") < 0 || ids.has(id) || !st.inFlight) continue;
        st.epoch += 1;
        if (st.ctl) st.ctl.abort();
        st.inFlight = null;
      }
    },
    credentialsChanged() {   // 凭据文件/配置变更（主桥 fs.watch 等）：v2 密钥也可能换了，允许马上重取
      v2KeyRetryNow();
      /* 同一 provider 的 key/baseURL 也可能被修改；重读实际配置并重判适配器，
       * 不能沿用旧 ctx 或让一次 unsupported 永久锁住后来补全的 MiniMax 规则。 */
      const registered = new Set(Object.keys(byProvider));
      if (primaryProvider) registered.add(primaryProvider);
      /* 经 rememberProvider 重判：复合源后缀（vendor:providerId）与代际失效/状态复位
       * 由它统一处理——直接用 resolvePrimary 裸写 byProvider 会把厂商内复合源坍缩成
       * 裸家族源，丢账户隔离（多账户中转串显，实测）。 */
      for (const provider of registered) rememberProvider(provider);
      if (primaryProvider) {
        primaryId = byProvider[primaryProvider] || "";
        const st = primaryId ? states.get(primaryId) : null;
        primaryCtx = st ? st.ctx : null;
      }
      activeSet();   // 总开关关闭时也撤销旧额度；只重评本地配置，不发请求/回调
      /* 唤醒"值得重评"的源：冻结态（Infinity）重评后仍由 status 短路（指纹未变不复 fetch）；
       * not_configured 唤醒以承接 secrets/供应商配置刚启用；宿主凭据源即时重拉（token 刷新）。
       * ok 态保持 TTL——指纹在其自然到期重查时校验，避免一次 secrets 写入全源冗余刷新。 */
      for (const st of states.values()) {
        if (st.nextAt === Infinity || st.status === "not_configured" || (st.cred && st.cred.source === "host")) st.nextAt = 0;
      }
      if (resetGateOpen()) for (const famConf of RESET_FAMILIES) {
        const st = resetStates.get(famConf.fam);
        if (!st) continue;
        if (!syncResetCredential(st, resolveResetCred(famConf)) &&
            (st.nextAt === Infinity || st.status === "not_configured")) st.nextAt = 0;
      }
    },
    noteSnapshotExtras(data) {   // 快照侧注入（scnet 估算等）；ledger 源数据到位即解冻
      const prevScnet = extras.scnet;
      Object.assign(extras, data || {});
      if (data && data.scnet !== undefined && JSON.stringify(data.scnet) !== JSON.stringify(prevScnet)) {
        const st = states.get("scnet");
        if (st && (st.status === "no_plan" || st.status === "network_error")) {
          st.status = "idle";
          st.nextAt = 0;   // 估算就绪：立即重查（首次启用早于首个快照的自我冻结修复）
        }
      }
    },
    view() {
      activeSet();   // 配置撤销立即可见，不等待下一轮联网 tick
      const sources = {};
      for (const [id, st] of states) sources[id] = entryView(st);
      const out = { active: primaryId || "", byProvider: Object.assign({}, byProvider), sources };
      const prim = primaryId ? sources[primaryId] : null;   // 兼容镜像（本版保留，浮层迁移完成后移除）
      if (prim) Object.assign(out, {
        status: prim.status, reason: prim.reason, providerId: primaryProvider,
        fetchedAt: prim.fetchedAt, stale: prim.stale, error: prim.error,
        level: prim.level, plan: prim.plan, balance: prim.balance,
        windows: prim.windows, tools: prim.tools, models: prim.models, ledger: prim.ledger,
        label: prim.label, kind: prim.kind, subscription: prim.subscription, quotaSummary: prim.quotaSummary,
      });
      if (resetGateOpen()) {   // v135：重置卡独立字段（关开关不暴露旧值，fail-closed）
        const t = now(), resets = {};
        for (const famConf of RESET_FAMILIES) {
          const fam = famConf.fam, st = resetStates.get(fam);
          if (!st) continue;
          syncResetCredential(st, resolveResetCred(famConf));
          resets[fam] = Object.assign({
            status: st.status, fetchedAt: st.fetchedAt,
            stale: !!(st.fetchedAt && t - st.fetchedAt > RESET_TTL_MS),
            error: st.lastError, busy: !!st.inFlight,
          }, st.value || {});
        }
        out.resets = resets;
      }
      return out;
    },
    sourcesConfig() {   // ⚙ 面板数据源列表（不回显凭据值）
      resetGateOpen();   // 宿主切换开关时先广播设置，及时中止关闭的 reset 链
      activeSet();
      const list = [];
      for (const a of ADAPTERS) {
        if (a.id === "custom") continue;
        const cfg = (j.secrets.sources || {})[a.id] || {};
        const accounts = Array.from(states.values()).filter((st) => adapterOf(st.id) === a && st.ctx);
        const st = accounts.find((entry) => entry.status === "ok") || accounts[0] || states.get(a.id);
        list.push({
          id: a.id, label: a.label, kind: a.kind, defaultOn: a.defaultOn, unverified: !!a.unverified,
          enabled: cfg.enabled !== false && (a.defaultOn || cfg.enabled === true),
          credentialFields: a.id === "mimo" ? ["cookie"] : a.id === "volcano" ? ["accessKeyId", "secretAccessKey"] : a.id === "scnet" ? ["planCredits", "planStart"] : a.id === "anthropic" ? ["token"] : ["apiKey"],
          keyConfigured: !!(cfg.apiKey || cfg.cookie || cfg.token || cfg.accessKeyId ||
            accounts.some((entry) => !!entry.cred) || (a.id === "scnet" && num(cfg.planCredits) > 0)),
          keySource: st && st.cred ? st.cred.source : "",
          /* v104：显式关闭的源统一报 disabled（与 entryView 同口径）——原样透传 st.status 时
           * 从未激活过的关闭源会冒充 idle，面板出现「开关已关却显示待查询」的矛盾 */
          status: cfg.enabled === false ? "disabled" : (st ? st.status : "idle"),
          busy: cfg.enabled !== false && accounts.some((entry) => !!entry.inFlight),
          fetchedAt: st ? st.fetchedAt : 0,
          /* v102：预设模板（静态白名单）+ 当前 baseUrl（域名非凭据，仅用于面板高亮选中模板；
           * apiKey/cookie/token/AK/SK 照旧不回显） */
          presets: (SOURCE_PRESETS[a.id] || {}).presets,
          keyUrl: (SOURCE_PRESETS[a.id] || {}).keyUrl,
          baseUrl: cfg.baseUrl || "",
        });
      }
      return list;
    },
    secretsPath,
    dispose() {
      for (const st of states.values()) {
        if (st.ctl) { try { st.ctl.abort(); } catch (e) { } }
        st.inFlight = null;
      }
      for (const st of resetStates.values()) {
        st.epoch += 1;
        if (st.ctl) { try { st.ctl.abort(); } catch (e) { } }
        st.inFlight = null;
      }
    },
    get _state() { return states.get(primaryId) || states.get("custom") || {}; },   // 测试接缝兼容（v96 单源形状）
    _states: states,
    _adapters: ADAPTERS,
  };
  return client;
}

module.exports = {
  createQuotaClient,
  resolveQuotaPaths,
  resolveCustomProvider,
  decryptValue,
  deriveCipherKey,
  makeHostDecryptor,
  setDefaultDecryptCtx,
  ensureDefaultV2Key,
  v2KeyPending,
  v2KeyRetryNow,
  jwtExpMs,
  normalizeQuotaBody,
  normalizeZcodeStartBalance,
  normalizeResetStatus,
  normalizeResetList,
  normalizeSubscriptionPlan,
  normalizeSub2api,
  relayQuotaUrls,
  isNoPlanMessage,
  normalizeMimoCookie,
  parseCurrencyAmount,
  collectWindows,
  resolveWanted(providerId) {   // v96 兼容导出（单测在用）：内置 family 判定
    const p = String(providerId || "");
    if (apiKeyFamilyOf(p)) return { family: apiKeyFamilyOf(p) };
    if (p.indexOf("account:") !== 0) return null;
    const teamFam = teamFamilyOf(p);
    if (teamFam) return { family: teamFam, team: true };
    if (zcodeStartDetectOf(p)) return { family: "zcode-start" };
    if (p.indexOf("account:bigmodel") === 0) return { family: "bigmodel" };
    if (p.indexOf("account:zai") === 0) return { family: "zai" };
    return null;
  },
  TTL_MS,
  RESET_TTL_MS,
};
