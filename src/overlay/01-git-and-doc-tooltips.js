  /* ---------- Git 状态 chip 数据通道（v96）：主进程旁路 git 查询 → 按工作区路径缓存 ----------
   * 主进程对各窗声明的路径并集建 fs.watch，事件 60s 尾随防抖后逐路径查询（v420 起对齐宿主原生
   * Git 胶囊刷新时机，弃 10s 轮询），结果推 window.__zusageGitState；路径集变化由渲染端立即请求
   * 首查。渲染端只缓存与分发，实例按自身 scope.workspacePath 取用。失败不清空最近成功态（标 stale），
   * 只有明确「非仓库 / 无 git」才视为无数据不挂载。 */
  var gitStateByPath = {}, gitLastGood = {}, gitAskedAt = 0;
  var GIT_ASK_MIN_MS = 5000;
  function gitViewFor(p) {
    var cur = gitStateByPath[p];
    if (!cur) return null;
    if (cur.ok) return { st: cur, stale: false };
    if (cur.reason === "notrepo" || cur.reason === "nogit") return null;
    var good = gitLastGood[p];
    return good ? { st: good, stale: true } : null;
  }
  function askGitRefresh(force, done, path) {
    var paths = window.__zusageGitPaths;
    if (!paths || !paths.length) return "";
    var now = Date.now();
    if (!force && now - gitAskedAt < GIT_ASK_MIN_MS) return "";
    gitAskedAt = now;
    return pluginRequest("git-refresh", typeof path === "string" ? { path: path } : undefined, done);
  }
  /* 受管 worktree 会话事实（specs/worktree-branch.md）：宿主分栏 workspacePath 对 worktree
   * 会话是项目主目录（宿主 §2.1「带 workspace 的字段只表示归属」），直接查 git 读的是主
   * checkout；快照顶层 worktrees 按 sid 给出真实 cwd，本地 pane 用它覆写查询与显示路径。
   * 返回 null = 非受管会话/缺帧，走原 workspacePath（行为不变）。 */
  function worktreeFor(sid) {
    var map = lastWorktrees;
    if (!map || !sid) return null;
    var wt = map[sid];
    return wt && wt.cwd ? wt : null;
  }
    window.__zusageGitState = function (p, st) {
      if (stale() || typeof p !== "string" || !st || typeof st !== "object") return;
      gitStateByPath[p] = st;
      if (st.ok) gitLastGood[p] = st;
      for (var i = 0; i < instances.length; i++) {
        try { instances[i].gitTouch(); } catch (e) { FATAL.gitErr = String((e && e.stack) || e); }
      }
    };
  window.__zusagePluginUpdate = function (s) {
    if (stale()) return;
    /* 新旧主进程混载时 fail-closed；即使整帧等值，也要以广播覆盖回执前后的本地状态。 */
    var mobileEnabled = !!(s && s.mobileRelayEnabled === true);
    var mobileSupported = !!(s && s.mobileRelaySupported === true);
    var mobileChanged = state.mobileRelayEnabled !== mobileEnabled || state.mobileRelaySupported !== mobileSupported;
    state.mobileRelayEnabled = mobileEnabled;
    state.mobileRelaySupported = mobileSupported;
    if (state.mobileRelayPending) state.mobileRelayPending.confirmed = true;
    if (JSON.stringify(state.pluginUpdate) === JSON.stringify(s)) {
      if (mobileChanged) instances.forEach(function (inst) { inst.syncUpdate(); });
      return;
    }
    window.__zusagePluginState = state.pluginUpdate = s;
    if (s && typeof s.rateLine === "boolean") state.rateLine = s.rateLine;
    if (s && typeof s.quotaEnabled === "boolean") state.quotaEnabled = s.quotaEnabled;
    if (s && typeof s.resetBadgeEnabled === "boolean") state.resetBadge = s.resetBadgeEnabled;   // v135
    if (s && typeof s.enhanceEnabled === "boolean") state.enhanceEnabled = s.enhanceEnabled;   // v344：增强按钮显隐随主进程真值
    if (s && typeof s.restartNotice === "boolean") state.restartNotice = s.restartNotice;   // v159（issue #139）
    if (s && s.enginePatch && typeof s.enginePatch === "object") state.enginePatch = s.enginePatch;   // v179：⚙ 状态行与 hover 阈值行的数据源
    if (s && Array.isArray(s.quotaSources)) state.quotaSources = s.quotaSources;   // v95：chip 门控随主进程真值（heavy 对账点内生效）
    scanRateLines();
    instances.forEach(function (inst) { inst.syncUpdate(); });
  };
  /* 工作区身份来自当前会话节点；共享 localStorage 不能证明本窗口的 pane 归属。 */
  function collectSidWs() {
    var map = {};
    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i], sid = inst.getSid();
      var scope = inst.getScope && inst.getScope();
      if (!sid || !scope || scope.sid !== sid || !REMOTE_IDENTITY_RE.test(scope.identity)) continue;
      if (!map[sid]) map[sid] = [];
      if (map[sid].indexOf(scope.identity) < 0) map[sid].push(scope.identity);
    }
    return map;
  }
  /* 可信远端身份前缀白名单（与泵侧 REMOTE_IDENTITY_RE 同族）：ssh/wsl/docker/server。
   * v3.16 客户端把所有传输连接握手后统一升级为 remote:server:，wsl/docker 是直接传输身份。 */
  var REMOTE_IDENTITY_RE = /^remote:(?:ssh|wsl|docker|server):/;
  /* v258：静态桥缺席（客户端升级到 HOST_TARGETS 表外版本、桥未部署或 replace-failed）时
   * 的 SessionPane 归属兜底：宿主自写的 data-session-id 节点仍挂 React fiber，沿 return
   * 链上溯找 SessionPane 组件帧的 workspace/pane props（JSX 属性名不被压缩，renderer_bridge
   * AUTO_PANE_PARAM 同源证据）。只读、限深 24 层、途中撞上更外层的会话/分栏根立即止步，
   * 防跨 pane 读父容器 props；多候选值不一致按歧义拒绝（fail-closed）。下方校验与静态属性
   * 分支逐字同规（控制字符、remote/identity 互证、REMOTE_IDENTITY_RE）。 */
  function fiberPaneCandidates(root, pid) {
    var keys = Object.keys(root), fk = "";
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) { fk = keys[i]; break; }
    }
    if (!fk) return null;
    var fiber = root[fk], out = null, depth = 0;
    while (fiber && depth++ < 24) {
      var node = fiber.stateNode;
      if (node && node !== root && node.getAttribute &&
          (node.hasAttribute("data-session-id") || node.hasAttribute("data-pane-id"))) break;
      var p = fiber.memoizedProps || fiber.pendingProps;
      if (p && typeof p.workspacePath === "string" && p.workspacePath.trim()) {
        /* tabId 本身就以 selection-side-chat: 开头（v174 同源），实例 pid 即其全串，不再拼前缀 */
        var tabId = typeof p.tabId === "string" && p.tabId.indexOf("selection-side-chat:") === 0 ? p.tabId : "";
        if (p.paneId === pid || (pid && tabId === pid)) {
          var cand = { workspacePath: p.workspacePath,
            identity: typeof p.workspaceIdentity === "string" ? p.workspaceIdentity : "",
            remote: typeof p.remoteSessionId === "string" ? p.remoteSessionId : "" };
          if (!out) out = cand;
          else if (JSON.stringify(out) !== JSON.stringify(cand)) return null;   // 歧义拒绝
        }
      }
      fiber = fiber.return;
    }
    return out;
  }
  function readFiberPaneScope(root, sid, pid, allowDraft) {
    if (!root || !sid || (sid === "draft" && !allowDraft) || !root.getAttribute ||
        root.getAttribute("data-session-id") !== sid) return null;
    try {
      var best = fiberPaneCandidates(root, pid);
      if (!best) return null;
      var path = best.workspacePath, identity = best.identity, remote = best.remote;
      if (!path.trim() || /[\x00-\x1f\x7f]/.test(path + identity + remote)) return null;
      identity = identity.trim();
      if (remote && (!identity || /\s/.test(remote))) return null;
      if (identity && !REMOTE_IDENTITY_RE.test(identity)) return null;
      return { sid: sid, identity: identity, workspacePath: path, remoteSessionId: remote };
    } catch (e) { return null; }
  }
  function readPaneScope(el, sid, pid, allowDraft) {
    if (!el || !sid || (sid === "draft" && !allowDraft) || !el.isConnected) return null;
    try {
      var root = el;
      while (root && !(root.hasAttribute && root.hasAttribute("data-session-id"))) root = root.parentElement;
      if (!root || root.getAttribute("data-session-id") !== sid) return null;
      if (root.getAttribute("data-zusage-scope-version") !== "1") return readFiberPaneScope(root, sid, pid, allowDraft);   // v258：桥缺席的 fiber 兜底；v354：allowDraft 透传（draft+桥缺席仍可放行）
      if (root.getAttribute("data-zusage-pane-id") !== pid) return null;
      var path = root.getAttribute("data-zusage-workspace-path");
      var identity = root.getAttribute("data-zusage-workspace-identity");
      var remote = root.getAttribute("data-zusage-remote-session-id");
      if (typeof path !== "string" || !path.trim() || typeof identity !== "string" ||
          typeof remote !== "string" || /[\x00-\x1f\x7f]/.test(path + identity + remote)) return null;
      identity = identity.trim();
      if (remote && (!identity || /\s/.test(remote))) return null;
      if (identity && !REMOTE_IDENTITY_RE.test(identity)) return null;
      return { sid: sid, identity: identity, workspacePath: path, remoteSessionId: remote };
    } catch (e) { return null; }
  }
  var quotaSelectionsSig = "";
  function reportQuotaSelections() {
    if (stale()) return;
    var panes = {};
    for (var i = 0; i < instances.length; i++) {
      var selection = instances[i].getQuotaSelection && instances[i].getQuotaSelection();
      if (selection) panes[instances[i].pid] = selection;
    }
    var sig = JSON.stringify(panes);
    if (sig === quotaSelectionsSig) return;
    quotaSelectionsSig = sig;
    FATAL.quotaSelections = { time: new Date().toISOString(), panes: panes };
    var queue = window.__zusagePluginRequests || [];
    for (var j = queue.length - 1; j >= 0; j--) if (queue[j].action === "quota-providers") queue.splice(j, 1);
    pluginRequest("quota-providers", { panes: panes });
  }
  function refreshWants() {
    try {
      var arr = [], panes = {};
      mainScopeNow = { sid: "", identity: "", known: false };
      for (var i = 0; i < instances.length; i++) {
        var inst = instances[i], sid = inst.getSid();
        if (!sid) continue;
        if (arr.indexOf(sid) < 0) arr.push(sid);
        var scope = inst.getScope && inst.getScope();
        if (!scope || scope.sid !== sid) scope = null;
        panes[inst.pid] = scope ? { sid: sid, identity: scope.identity } : { sid: sid };
        if (inst.pid === "workspace-main") mainScopeNow = { sid: sid, identity: scope ? scope.identity : "", known: !!scope };
      }
      window.__zusageWantSids = arr;
      window.__zusageWantSid = arr[0] || "";
      window.__zusageSidWs = collectSidWs();
      window.__zusagePaneScopes = panes;
      publishGitPaths();
    } catch (e) { }
  }
  /* v96：Git chip 关注的本地工作区路径集 → window.__zusageGitPaths（主进程 fs.watch 监听后查询）。
   * identity 为空才是本地；远端 pane 不上报（主进程不替宿主跨机跑 git）；开关关闭为空集。
   * 每次 render 都经 refreshWants 到这里：只在路径集变化时立即请求首查（v420 起，后续更新由
   * 主进程 fs.watch 60s 防抖驱动，不再做快照节奏的节流重查）。 */
  function publishGitPaths() {
    try {
      var gitPaths = [];
      if (state.show.git) for (var i = 0; i < instances.length; i++) {
        var inst = instances[i], sid = inst.getSid();
        var scope = sid && inst.getScope ? inst.getScope() : null;
        if (scope && scope.sid === sid && !scope.identity) {
          var wt = worktreeFor(sid);   // specs/worktree-branch.md：受管 worktree 会话发布真实 cwd
          var gp = wt ? wt.cwd : scope.workspacePath;
          if (gitPaths.indexOf(gp) < 0) gitPaths.push(gp);
        }
      }
      var changed = JSON.stringify(gitPaths) !== JSON.stringify(window.__zusageGitPaths || []);
      window.__zusageGitPaths = gitPaths;
      if (changed) askGitRefresh(true);   // 仅路径集变化立即首查；更新由主进程 fs.watch 60s 防抖驱动（v420）
    } catch (e) { }
  }

  /* ---------- 回复末尾速率行的悬停解释（v67）：给消息流里的统计行挂同款 tooltip ----------
   * 统计行是模型贴的 Markdown 引用块（⚡ … tok/s(本轮)），本身没有 hover 能力；
   * 浮层是注入 DOM 的，所以由它扫描消息流、给匹配节点挂自绘 tooltip（与状态条同套路：
   * 挂 body 的 fixed 浮层，免疫消息流层叠上下文）。document 级、只此一份，不随 pane 实例走。 */
  var rateTip = document.createElement("div");
  rateTip.className = "tip zusage-rate-tip";
  /* .tip 的类样式挂在条实例的 <style> 里（样式随条走）——本浮层是 document 级的，
   * 实例销毁/重建的间隙会失去类样式。内联关键属性兜底（值与 .tip 类一致，含主题 var），
   * 类样式在位时两者相同、不冲突；display 由 show/hide 控制。 */
  rateTip.style.cssText =
    "position:fixed;display:none;background:var(--color-tooltip,#171717);" +
    "border:1px solid var(--color-border,transparent);border-radius:10px;padding:10px 14px;" +
    "font-family:var(--font-sans,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);" +
    "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.55;color:var(--color-tooltip-foreground,#fafafa);" +
    "box-shadow:0 10px 28px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3);" +
    "white-space:normal;z-index:2147483646;max-width:520px;box-sizing:border-box";
  document.body.appendChild(rateTip);
  var rateTipFor = null;
  /* 结构化内容：样式内嵌本浮层（选择器带 .zusage-rate-tip 前缀，随元素清理），
   * 不依赖条实例的 <style>；全部为静态双语文案，无任何插值。 */
  function rateTipHTML() {
    var row = function (label, text) {
      return '<div class="rt-row"><b>' + label + "</b><span>" + text + "</span></div>";
    };
    return '<style>.zusage-rate-tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px}' +
      ".zusage-rate-tip .rt-row{display:flex;gap:10px;margin:3px 0}" +
      ".zusage-rate-tip .rt-row b{flex:0 0 auto;min-width:78px;color:var(--color-tooltip-foreground,#fafafa);font-weight:600}" +
      ".zusage-rate-tip .rt-row span{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      '.zusage-rate-tip .rt-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-border,transparent);color:var(--color-tooltip-tag-foreground,#a6a6a6)}</style>' +
      '<div class="rt-h">⚡ ' + L("本问速率 · 各数值含义", "Rate line · what each figure means") + "</div>" +
      row("token/s", L("本问各段加权平均：总输出 ÷ 总生成时长，工具等待不计入", "weighted average of all segments: total output ÷ total generation time, tool waits excluded")) +
      row(L("首字", "TTFT"), L("第一段从发出请求到首个 token 的等待", "wait from request to the first token of the first segment")) +
      row(L("输出", "Output"), L("本问各段输出合计（思考 token 已含其中）", "sum of segment output (thinking tokens already included)")) +
      row(L("生成", "Gen"), L("各段生成窗口合计：含思考（含 Claude 这类不单独上报思考的模型）用 completed_at − started_at；思考随首字后流出的供应商（按历史数据自动识别）思考已在首字窗口内，用 completed_at − first_token_at；不含段间工具等待", "sum of segment generation windows: with thinking (including models such as Claude that don't report it separately) use completed_at − started_at; for providers whose thinking streams after the first token (auto-detected from history) thinking is already inside the first-token window, so completed_at − first_token_at applies; tool waits between segments excluded")) +
      row(L("段 / 峰", "Seg/Peak"), L("段＝模型请求次数；峰＝最快一段的速率", "segments = model requests; peak = fastest segment")) +
      row(L("会话均", "Session avg"), L("本会话全部已完成请求的加权平均：总输出 ÷ 总生成时长（各段生成窗口求和，工具等待不计入；不含子代理）", "weighted average over all completed requests of this session: total output ÷ total generation time (sum of segment windows, tool waits excluded; sub-agents excluded)")) +
      row(L("累计", "Session"), L("本会话已完成请求的输出总量（不含子代理）", "cumulative output of completed requests (sub-agents excluded)")) +
      row("⏱", L("采样时刻——写正文前自测，收尾正文段未计入", "sample time — self-tested before the final text, so that segment is excluded")) +
      '<div class="rt-note">' + L("状态条「生成速度」是最近一段的瞬时值，与本行的整问均值不同，数值有差异属正常。⚙ 设置可关。",
        "The bar's \"generation speed\" is the latest segment's instant value; this line is the whole-answer average — a difference is expected. Toggle in ⚙ settings.") + "</div>";
  }
  function showRateTip(el) {
    if (stale() || !state.rateLine || !isRateLine(el)) { hideRateTip(); return; }
    rateTip.innerHTML = rateTipHTML();
    rateTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = rateTip.offsetWidth, th = rateTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;               // 优先弹在统计行上方
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);   // 上方放不下改下方
    rateTip.style.left = Math.round(left) + "px";
    rateTip.style.top = Math.round(top) + "px";
    rateTipFor = el;
  }
  function hideRateTip() {
    rateTip.style.display = "none";
    rateTipFor = null;
  }

  /* ---------- v96 套餐额度 chip 的悬停说明：rateTip 同款 document 级独立浮层 ----------
   * chip 挂在宿主工具栏（条外），状态条 .it 的 tooltip 事件委托覆盖不到它；mouseenter/
   * leave 自管理，内容按 chip.__zuQ（render 时写入的最近快照）在悬停时即时生成。 */
  var quotaTip = document.createElement("div");
  quotaTip.className = "tip zusage-quota-tip";
  quotaTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(quotaTip);
  var quotaTipFor = null;
  function qTime(v) {   // 统一 yyyy-MM-dd HH:mm；接受毫秒数或 ISO 字符串
    if (v == null || v === "") return "";
    var d = typeof v === "number" ? new Date(v) : new Date(String(v));
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function qTimeS(v) {   // yyyy-MM-dd HH:mm:ss（重置卡 tooltip 专用：过期时刻精确到秒，其余 tooltip 不变）
    var base = qTime(v);
    if (!base) return "";
    var d = typeof v === "number" ? new Date(v) : new Date(String(v));
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return base + ":" + pad(d.getSeconds());
  }
  function quotaFamilyOf(provider) {   // 内置套餐家族：OAuth 的 account:* 与 apiKey 模式的 bigmodel-api[-N] / zai-api[-N]
    var p = String(provider || "");
    if (p.indexOf("account:bigmodel-start-plan") === 0 || p.indexOf("account:zai-start-plan") === 0) return "zcode-start";
    if (p.indexOf("account:zai") === 0 || /^zai-api(-\d+)?$/.test(p)) return "zai";
    if (p.indexOf("account:bigmodel") === 0 || /^bigmodel-api(-\d+)?$/.test(p)) return "bigmodel";
    return "";
  }
  function quotaFamilyLabel(provider) {
    var fam = quotaFamilyOf(provider);
    return fam === "zai" ? "Z.ai" : fam === "zcode-start" ? "ZCode Start Plan" : "BigModel";
  }
  function quotaLevelLabel(level) {
    var m = { max: "Max", pro: "Pro", lite: "Lite" };
    return m[String(level || "").toLowerCase()] || String(level || "");
  }
  function quotaRemainPct(pct) {   /* v251 剩余口径显示值：同一额度窗口的 100−已用，钳 [0,100]（取整交各显示处自行处理） */
    var r = 100 - pct;
    return r < 0 ? 0 : r > 100 ? 100 : r;
  }
  function quotaStatusText(st) {
    return {
      auth_failed: L("认证失效：重新登录 ZCode 后自动恢复", "Authentication failed: recovers after signing in to ZCode again"),
      rate_limited: L("接口限流，稍后自动重试", "Rate limited; retrying later"),
      network_error: L("网络错误，稍后自动重试", "Network error; retrying later"),
      parse_error: L("接口返回格式变化，已降低查询频率", "Unexpected response format; polling slowed down"),
      no_plan: L("当前账号未订阅编码套餐", "No coding plan on this account"),
    }[st] || "";
  }
    function quotaTipHTML(d) {
      var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
      var row = function (label, text) { return '<div class="rt-row"><b>' + label + "</b><span>" + text + "</span></div>"; };
      /* v371：标题（套餐名/供应商名，远端可控）补 anywhere 断行——无空格长串曾撑破 520px 帽，
       * 同浮层数据行/qt-note 本就有 anywhere，唯标题漏配 */
      var css = '<style>.zusage-quota-tip .qt-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px;overflow-wrap:anywhere}' +
        ".zusage-quota-tip .rt-row{display:flex;gap:12px;margin:4px 0;align-items:flex-start}" +
        ".zusage-quota-tip .rt-row b{flex:0 0 86px;min-width:0;color:var(--color-tooltip-tag-foreground,#a6a6a6);font-weight:500}" +
        ".zusage-quota-tip .rt-row span{min-width:0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}" +
        ".zusage-quota-tip .qt-cur{color:var(--color-tooltip-foreground,#fafafa);font-weight:600}" +
        ".zusage-quota-tip .qt-warn{color:#f5b944}" +
        '.zusage-quota-tip .qt-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent));color:var(--color-tooltip-tag-foreground,#a6a6a6);overflow-wrap:anywhere}</style>';
    var rem = state.quotaRemain === 1;   // v251 显示口径跟随 ⚙「显示剩余额度」：剩余% 打头（与 chip 面同口径）
    /* 其余启用源的摘要：主源分支与 info 分支共用——主源不可展示（未配置/不支持）时，
     * 后台源（如火山方舟 AK/SK）可能已查询成功，不应被 info 提前 return 吞掉（issue #261）。 */
    var otherSourcesRow = function () {
      if (!d.all || !d.all.sources || typeof d.all.sources !== "object") return "";
      var others = [];
      for (var sid in d.all.sources) {
        if (!Object.prototype.hasOwnProperty.call(d.all.sources, sid) || sid === d.all.active) continue;
        var sv = d.all.sources[sid];
        if (!sv || sv.status !== "ok") continue;
        var sum = sv.balance && typeof sv.balance.amount === "number" ? quotaBalanceText(sv.balance)
          : (sv.windows ? ["plan", "fiveHour", "weekly", "monthly"].map(function (k) {
              return sv.windows[k] && typeof sv.windows[k].percent === "number"
                ? Math.round(rem ? quotaRemainPct(sv.windows[k].percent) : sv.windows[k].percent) + "%" : null;
            }).filter(Boolean).join(" ") : "✓");
        /* 复合源 id（vendor:providerId）在 srcLabels 里只有裸厂商键，回退拆分查找 */
        var lbl = (d.srcLabels && (d.srcLabels[sid] || d.srcLabels[String(sid).split(":")[0]])) || sid;
        others.push(esc(lbl) + " " + sum);
      }
      return others.length ? row(L("其他源", "Other sources"), others.join(" · ")) : "";
    };
    if (d.mode.kind === "team") {
      return css + '<div class="qt-h">⊘ ' + L("团队套餐额度", "Team plan quota") + "</div>" +
        '<div class="qt-note">' + L("团队套餐需要组织/项目维度的查询，当前版本暂不支持；个人编码套餐已支持。", "Team plans need organization/project-scoped queries, which this version does not support yet; individual coding plans are supported.") + "</div>";
    }
    if (d.mode.kind === "info") {   // v111：未配置/暂不支持的中性说明（无数据可列，只给引导）
      var q0 = d.q || {};
      return css + '<div class="qt-h">' + L("套餐额度", "Plan quota") + "</div>" + otherSourcesRow() +
        '<div class="qt-note">' + (q0.status === "not_configured"
          ? L("未找到可用的登录凭据或 API Key；在 ⚙ 面板的额度源里配置后自动显示。", "No usable sign-in credentials or API key found; configure a quota source in the ⚙ panel and the chip fills in.")
          : L("该数据源的额度/余额形状暂不支持查询。", "This source's quota or balance shape is not supported yet.")) + "</div>";
    }
    var q = d.q || {};
    var isBalance = d.mode.kind === "balance";
    var title = isBalance ? L("账户余额", "Account balance") : L("套餐额度", "Plan quota");
    /* 标题：有订阅元数据（productName/version/valid）时拼成一行；缺失回退 family+档位 */
    var pl = q.plan;
    /* 周期标签：renewAt=自动续费的下次扣费日（不是最终到期，宿主同款互斥语义）；
     * validEnd=非自动续费的当前权益结束日；两者都缺（周期无法确认）只显示套餐名。 */
    var periodLabel = pl && pl.renewAt
      ? L(" · 下次续费 ", " · renews ") + esc(pl.renewAt)
      : pl && pl.validEnd ? L(" · 有效期至 ", " · valid until ") + esc(pl.validEnd) : "";
    var head = (pl && (pl.productName || pl.version))
      ? [pl.productName, pl.version].filter(Boolean).map(esc).join(" · ") + periodLabel
      : esc(q.label || (String(d.provider || "").indexOf("account:") === 0 || quotaFamilyOf(d.provider) ? quotaFamilyLabel(d.provider) : L("自定义供应商", "Custom provider"))) +
        (q.level ? " " + esc(quotaLevelLabel(q.level)) : "");
    var out = css + '<div class="qt-h">' + title + " · " + head + "</div>";
    var w = q.windows || {};
    var winRow = function (label, e) {
      if (!e) return "";
      var pct = typeof e.percent === "number" ? (Math.round((rem ? quotaRemainPct(e.percent) : e.percent) * 10) / 10) + "%" : "—";
      var rs = qTime(e.resetsAt);
      /* 剩余口径下主数字与首位绝对值换为剩余（补数），已用退为带标签明细；两种口径信息等价只换顺序 */
      var detail = (e.used != null && e.total != null && e.remaining != null)
        ? " · " + quotaBalanceText({ amount: rem ? e.remaining : e.used, currency: e.currency }) + " / " +
          quotaBalanceText({ amount: e.total, currency: e.currency }) + " · " + (rem ? L("已用 ", "used ") : L("剩余 ", "remaining ")) +
          quotaBalanceText({ amount: rem ? e.used : e.remaining, currency: e.currency })
        : "";   // sub2api 等带金额明细的窗口拼进行内；BigModel 套餐窗只有百分比则不拼
      return row(label, (rem ? L("剩余 ", "remaining ") : L("已用 ", "used ")) + pct + detail + (rs ? " · " + (e.expires ? L("到期 ", "expires ") : L("重置 ", "resets ")) + rs : ""));
    };
    out += winRow(L("每日窗口", "Daily window"), w.daily) + winRow(L("5小时窗口", "5-hour window"), w.fiveHour) +
      winRow(L("本周窗口", "This week"), w.weekly) + winRow(L("月度窗口", "Monthly"), w.monthly) +
      winRow(L("套餐池", "Plan pool"), w.plan);
    if (q.quotaSummary) {
      var summary = q.quotaSummary;
      out += row(L("Key 总额度", "Key quota"), (rem ? L("剩余 ", "remaining ") : L("已用 ", "used ")) +
        quotaBalanceText({ amount: rem ? summary.remaining : summary.used, currency: summary.currency }) + " / " +
        quotaBalanceText({ amount: summary.limit, currency: summary.currency }) + " · " + (rem ? L("已用 ", "used ") : L("剩余 ", "remaining ")) +
        quotaBalanceText({ amount: rem ? summary.used : summary.remaining, currency: summary.currency }));
    }
    if (q.subscription && q.subscription.expiresAt) {
      out += row(L("订阅截止", "Subscription ends"), esc(q.subscription.expiresAt));
    }
    if (q.balance && typeof q.balance.amount === "number" && isFinite(q.balance.amount)) {
      /* quotaBalanceText 已自带转义；parts 的 label/amount 是远程字符串，逐项转义后拼接，
       * 整行不得再整体 esc（曾双重转义把 "A&B" 显示成 "A&amp;amp;B"）。 */
      var balTxt = quotaBalanceText(q.balance);
      if (q.balance.parts && q.balance.parts.length) {
        balTxt += "（" + q.balance.parts.map(function (pp) { return esc(pp.label) + " " + esc(pp.amount); }).join(" / ") + "）";
      }
      out += row(L("余额", "Balance"), balTxt);
    }
    out += otherSourcesRow();   // 其余启用源的摘要（tooltip 分家列全）
    if (q.tools && (q.tools.total != null || q.tools.used != null)) {
      var tr = qTime(q.tools.resetsAt);
      out += row(L("内置工具", "Built-in tools"), (q.tools.used == null ? "—" : q.tools.used) + " / " + (q.tools.total == null ? "—" : q.tools.total) +
        L(" 次", " calls") + (tr ? " · " + L("重置 ", "resets ") + tr : ""));
    }
    var models = Array.isArray(q.models) ? q.models : [], cur = String(d.model || "");
    var scope = models.length
      ? models.map(function (m) { return String(m).toLowerCase() === cur.toLowerCase() ? '<span class="qt-cur">' + esc(m) + "</span>" : esc(m); }).join(", ")
      : L("套餐内全部模型", "all models in the plan") + (cur ? L("（当前 ", " (current ") + '<span class="qt-cur">' + esc(cur) + "</span>" + L("）", ")") : "");
    if (isBalance) out += row(L("当前模型", "Current model"), esc(cur || "—"));
    else out += row(L("覆盖范围", "Covers"), scope);
      var foot = q.busy ? L("查询中…", "Querying…") : (q.fetchedAt ? L("更新于 ", "updated ") + qTime(q.fetchedAt) : "");
      foot += q.stale ? L("（已过期，等待刷新）", " (stale, refreshing)") : "";
    var err = q.status && q.status !== "ok" && q.status !== "idle" ? quotaStatusText(q.status) : "";
    if (err) foot += (foot ? " · " : "") + '<span class="qt-warn">⚠ ' + err + "</span>";
    out += '<div class="qt-note">' + (foot ? foot + "<br>" : "") +
      (isBalance
        ? L("余额属于当前供应商账号或 API Key，不是单模型独享。点击 chip 立即刷新。", "Balance belongs to the provider account or API key, not one model. Click the chip to refresh.")
        : L("套餐池为账号级：同账号所有模型共用，不是单个模型独享。点击 chip 立即刷新。", "The pool is account-level: shared by every model on this account, not per model. Click the chip to refresh.")) + "</div>";
    return out;
  }
  function showQuotaTip(el) {
    if (stale() || !el || !el.isConnected || !el.__zuQ) { hideQuotaTip(); return; }
    /* 内容签名幂等（同 gitTip，overlay-ui.md §4）：泵推送/600ms 对账会反复走到这里，
     * 无条件重写 innerHTML 会打断 tooltip 内的文本选择与滚动。 */
    var html = quotaTipHTML(el.__zuQ);
    if (quotaTip.__zuTipSig !== html) {
      quotaTip.innerHTML = html;
      quotaTip.__zuTipSig = html;
    }
    quotaTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = quotaTip.offsetWidth, th = quotaTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;               // 优先弹在 chip 上方
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    quotaTip.style.left = Math.round(left) + "px";
    quotaTip.style.top = Math.round(top) + "px";
    quotaTipFor = el;
  }
  function hideQuotaTip() {
    quotaTip.style.display = "none";
    quotaTipFor = null;
  }
  function onQuotaEnter() { showQuotaTip(this); }
  /* ---------- v135 重置卡徽标 tooltip：每账号分组的逐卡明细 ----------
   * 复用 quotaTip 的浮层模式（同 .tip 样式/上方弹出/签名幂等）；滚动豁免与伪 leave
   * 甄别与 quotaTip 同链。内容只读 el.__zuR（syncResetBadge 写入的徽标视图）。 */
  var rstTip = document.createElement("div");
  rstTip.className = "tip zusage-quota-tip";
  rstTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(rstTip);
  /* 「如何重置」按钮：监听挂 rstTip 本体（innerHTML 签名重建不丢）；外链走客户端
   * openExternal 桥（系统默认浏览器），无桥环境 window.open 兜底（同 ⚙ 取 Key 链接）。 */
  var RST_HOWTO_URL = "https://bigmodel.cn/coding-plan/personal/usage";
  rstTip.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest(".rst-howto");
    if (!btn) return;
    e.stopPropagation();
    var zc = window.zcode;
    if (zc && typeof zc.openExternal === "function") zc.openExternal(RST_HOWTO_URL);
    else window.open(RST_HOWTO_URL, "_blank", "noopener");
  });
  /* 徽标↔tooltip 悬停桥：徽标与 tooltip 之间有 8px 间隙，直接 mouseleave 即收会让指针
   * 移向 tooltip（点「如何重置」）途中浮层消失。离开任一侧延迟收起，进入另一侧取消。 */
  var RST_HIDE_DELAY_MS = 180;
  var rstHideTimer = 0;
  function scheduleRstHide() {
    if (rstHideTimer) return;
    rstHideTimer = setTimeout(function () { rstHideTimer = 0; hideRstTip(); }, RST_HIDE_DELAY_MS);
  }
  function cancelRstHide() {
    if (rstHideTimer) { clearTimeout(rstHideTimer); rstHideTimer = 0; }
  }
  rstTip.addEventListener("mouseenter", cancelRstHide);
  rstTip.addEventListener("mouseleave", scheduleRstHide);
  var rstTipFor = null;
  /* ---------- v146 精简模式速率 chip tooltip：速度读数 + 状态条摘要 + 设置入口 ----------
   * 浮层模式与 quotaTip/rstTip 同款（body 级、上方弹出、签名幂等、悬停桥延迟收起）。
   * 内容由 chip 上的实例闭包 el.__zuT.buildTip(el.__zuT) 生成——摘要行需要实例作用域的
   * fmt/subRate/state.show，不能提到模块层；「打开设置」与子代理明细经 chip 上挂的
   * __zuOpen/__zuOpenSub 回调回到所属实例（多实例各回各的面板）。 */
  var tpsTip = document.createElement("div");
  tpsTip.className = "tip zusage-quota-tip zusage-tps-tip";
  tpsTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(tpsTip);
  /* v263：Tab 切换共用（全量 tip 的 speedTabActivate 同款问题——生成中浮层每 tick
   * 重编会替换按钮 DOM，click 落到共同祖先），提前到 pointerdown 同步生效。 */
  function tpsTabActivate(e) {
    var el = tpsTipFor;   // hideTpsTip 会清 tpsTipFor，回调目标先取
    if (!el) return;
    var tab = e.target && e.target.closest && e.target.closest(".zu-sv-tab");
    var t = el.__zuT;
    if (tab && t && t.speedSel) {
      var grp = tab.getAttribute("data-sv-group"), val = tab.getAttribute("data-sv-val");
      if ((grp === "range" && SPD_RANGES.indexOf(val) >= 0) ||
          (grp === "period" && SPD_PERIODS.indexOf(val) >= 0)) {
        e.stopPropagation();
        t.speedSel[grp] = val;
        /* v384：切 Tab 收起筛选弹出层（06 链同款契约；v479 审查补齐精简链缺口） */
        if (t.speedSel.pop) t.speedSel.pop.open = false;
        /* v479（spec §28.5）：切 Tab 收起月历弹层（所选月保留）。指针路径已由
         * spd3MonthOutside 兜住，这里补键盘路径（Enter 走 click 委托、不经 pointerdown） */
        if (t.speedSel.mpop) t.speedSel.mpop.open = false;
        t.speedHover = -1;
        /* v272：维度切换移除，dim 恒 time */
        tpsTip.__zuTipSig = "";
        showTpsTip(el);
      }
    }
  }
  /* v384 V3 模型筛选交互（compact 链镜像 06 分片 spd3Activate）：状态存 chip 数据包
   * t.speedSel（10Hz 心跳不重置），改完清 __zuTipSig 让 showTpsTip 幂等重编。
   * toggle 动作非同值幂等：pointerdown 独占鼠标路径，click 只认键盘（e.detail===0）。 */
  function tpsSpd3Activate(e) {
    var el = tpsTipFor;
    if (!el || !el.__zuT) return false;
    var t = el.__zuT, s3 = t.speedSel;
    var hit = e.target && e.target.closest ? e.target.closest(
      ".zu-sv3-chip,.zu-sv3-chip-more,[data-sv3-fopen],.zu-sv3-fpop-row,[data-sv3-all],[data-sv3-none],[data-sv3-reset],[data-sv3-act]," +
      "[data-sv3-mnav],[data-sv3-mlabel],[data-sv3-mpick],[data-sv3-myear]") : null;   /* v390：fopen 入口；v391+：data-sv3-more 折叠链退役；v479：月份导航四类元素 */
    if (!hit || !s3 || typeof spd3FilterToggle !== "function") return false;
    if (!s3.filt) s3.filt = (typeof spd3FilterAuto === "function") ? spd3FilterAuto() : { mode: "auto", keys: null };
    if (!s3.pop) s3.pop = { open: false, query: "" };
    /* v479（spec §28.5）月份导航动作（同 06 分片 spd3Activate）：状态机在 wire 的
     * spd3MonthAct 单点实现；本链负责重编、弹层锚定与焦点归位。无动作吞掉事件不重编。 */
    if (typeof spd3MonthHit === "function" && spd3MonthHit(hit)) {
      var mAct1 = spd3MonthAct(s3, hit, (typeof SPD3_MON !== "undefined" ? SPD3_MON : null));
      if (!mAct1) return true;
      if (mAct1 === "open") spd3MonthAnchor(s3.mpop, hit, tpsTip.querySelector(".zu-sv3-root"));
      t.speedHover = -1;
      tpsTip.__zuTipSig = "";
      showTpsTip(el);
      /* 焦点归位只走键盘路径（同 06：指针按下重建后焦点留不住卡内） */
      if (e.type !== "pointerdown") spd3MonthFocus(tpsTip, mAct1);
      return true;
    }
    var key = hit.getAttribute("data-k");
    if (key && (hit.classList.contains("zu-sv3-chip") || hit.classList.contains("zu-sv3-fpop-row"))) {
      spd3FilterToggle(s3.filt, key);
    } else if (hit.classList.contains("zu-sv3-fsearch")) {
      s3.pop.open = !s3.pop.open;   /* v390 兼容分支 */
    } else if (hit.hasAttribute("data-sv3-fopen")) {
      s3.pop.open = !s3.pop.open;
      if (s3.pop.open) {
        /* v479（spec §28.5）：与月历弹层互斥（双向）——键盘路径（Enter→click 委托）
         * 不经 pointerdown，spd3MonthOutside 兜不到，这里镜像补收 */
        if (s3.mpop) s3.mpop.open = false;
        var fb1 = tpsTip.querySelector(".zu-sv3-fbar"), rt1 = tpsTip.querySelector(".zu-sv3-root");
        if (fb1 && rt1) s3.pop.top = Math.round(fb1.getBoundingClientRect().bottom - rt1.getBoundingClientRect().top + 8);
      }
    } else if (hit.hasAttribute("data-sv3-all")) {
      /* v384 B2：同 06 分片——SPD3_POOL 是对象数组，全选取 key 串 */
      spd3FilterOnly(s3.filt, (typeof SPD3_POOL !== "undefined" && SPD3_POOL || []).map(function (pm) { return pm.key; }));
    } else if (hit.hasAttribute("data-sv3-act")) {
      /* v387 §11.4：空态恢复动作（同 06 分片） */
      var act1 = hit.getAttribute("data-sv3-act");
      if (act1 === "clear-filter") spd3FilterAll(s3.filt);
      else if (act1 === "all-time") {
        s3.period = "all";
        if (s3.pop) s3.pop.open = false;
      } else return false;
    } else if (hit.hasAttribute("data-sv3-none")) {
      spd3FilterOnly(s3.filt, []);
    } else if (hit.hasAttribute("data-sv3-reset")) {
      spd3FilterAll(s3.filt);
    } else return false;
    if (!s3.pop.open) s3.pop.query = "";
    t.speedHover = -1;
    tpsTip.__zuTipSig = "";
    showTpsTip(el);
    /* v384 M2：弹层刚打开焦点移入搜索框（showTpsTip 同步重编完成） */
    if (s3.pop.open) {
      var fi3 = tpsTip.querySelector(".zu-sv3-fpop-input");
      if (fi3 && fi3.focus) fi3.focus();
    }
    return true;
  }
  /* v384 M3：tpsTip 链补 mousedown 阻断名单（镜像 06 同名名单；搜索输入框豁免，
   * 否则点击无法聚焦——v362 sysTip 同款镜像先例）。防 tip 内交互把焦点移出编辑器。 */
  tpsTip.addEventListener("mousedown", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var interactive = t.closest(".zu-sv-tab") || t.closest(".zu-sv3-fbar") ||
      (t.closest(".zu-sv3-fpop") && !t.classList.contains("zu-sv3-fpop-input")) || t.closest(".zu-sv3-more") ||
      t.closest(".zu-sv3-mnav") || t.closest(".zu-sv3-mpop") ||   /* v479：月份导航胶囊与月历弹层 */
      t.closest(".zu-sv3-empty-wrap");   /* v387：空态动作同入名单 */
    if (interactive) {
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
    }
  });
  tpsTip.addEventListener("pointerdown", function (e) {
    /* v479（spec §28.5）点弹层之外即收（同 06）：月历弹层开着且按在弹层与胶囊之外 →
     * 先收弹层重编，被点控件照常由下面的分支处理 */
    if (typeof spd3MonthOutside === "function" &&
        spd3MonthOutside(tpsTipFor && tpsTipFor.__zuT ? tpsTipFor.__zuT.speedSel : null, e.target)) {
      tpsTip.__zuTipSig = "";
      showTpsTip(tpsTipFor);
    }
    /* v489（spec §14.1）：筛选弹层同款「点外即收」（同 06 链；fopen 入口豁免防双翻转） */
    if (typeof spd3PopOutside === "function" &&
        spd3PopOutside(tpsTipFor && tpsTipFor.__zuT ? tpsTipFor.__zuT.speedSel : null, e.target)) {
      tpsTip.__zuTipSig = "";
      showTpsTip(tpsTipFor);
    }
    if (tpsSpd3Activate(e)) return;
    tpsTabActivate(e);
  });
  tpsTip.addEventListener("click", function (e) {
    var el = tpsTipFor;   // hideTpsTip 会清 tpsTipFor，回调目标先取
    if (!el) return;
    if (e.target && e.target.closest && e.target.closest(".tps-cfg")) {
      e.stopPropagation();
      hideTpsTip();
      if (el.__zuOpen) el.__zuOpen();
      return;
    }
    if (e.target && e.target.closest && e.target.closest(".tps-subrow")) {
      e.stopPropagation();
      hideTpsTip();
      if (el.__zuOpenSub) el.__zuOpenSub();
      return;
    }
    /* v255：V2 双 Tab 走 tpsTip 本体委托（全量 tip 的同款逻辑），只改 chip 数据包，
     * 由 showTpsTip 签名幂等重编；不新增全局监听、不重建浮层。
     * v263：鼠标路径提前到 pointerdown（见 tpsTabActivate），此处保留键盘与兜底。
     * v384：V3 筛选 toggle 动作 click 只认键盘路径（e.detail===0）。 */
    if (e.detail === 0 && tpsSpd3Activate(e)) return;
    tpsTabActivate(e);
  });
  /* 柱 hover/键盘焦点：委托重建整卡，信息卡随串自愈，不额外挂逐柱监听。
   * v384 m5（镜像 06 同名守卫）：重建销毁聚焦柱节点，先记焦点、重建后归位。 */
  function tpsSpeedPick(idx) {
    var t = tpsTipFor && tpsTipFor.__zuT;
    if (!t || t.speedHover === idx) return;
    var hadFocus = tpsTip.contains(document.activeElement) &&
      document.activeElement.closest && document.activeElement.closest(".zu-sc-col,.zu-hm-cell,.zu-sv3-hit");
    t.speedHover = idx;
    tpsTip.__zuTipSig = "";
    showTpsTip(tpsTipFor);
    if (hadFocus && idx >= 0) {
      var nu3 = tpsTip.querySelector('.zu-sc-col[data-i="' + idx + '"],.zu-hm-cell[data-i="' + idx + '"],.zu-sv3-hit[data-i="' + idx + '"]');
      if (nu3 && nu3.focus) nu3.focus();
    }
  }
  tpsTip.addEventListener("mouseover", function (e) {
    var col = e.target && e.target.closest && e.target.closest(".zu-sc-col,.zu-hm-cell,.zu-sv3-hit");
    if (col) tpsSpeedPick(parseInt(col.getAttribute("data-i"), 10) || 0);
    var lb = e.target && e.target.closest && e.target.closest(".zu-sv-legend-btn");
    if (lb) spdLegendTipShow(lb);   // v281：问号 hover 即显档位说明
  });
  tpsTip.addEventListener("mouseout", function (e) {
    var to = e.relatedTarget;
    var lb = e.target && e.target.closest && e.target.closest(".zu-sv-legend-btn");
    if (lb) {   // v281：icon→卡保活；icon→柱体由 Portal show 侧互斥立即收
      if (!(to && to.closest && (to.closest(".zu-sv-legend-btn") || to.closest(".zu-sv-legend-tip"))))
        spdLegendTipScheduleHide();
      return;
    }
    var col = e.target && e.target.closest && e.target.closest(".zu-sc-col,.zu-hm-cell,.zu-sv3-hit");
    if (!col) return;
    if (to && to.closest && to.closest(".zu-sc-col,.zu-hm-cell,.zu-sv3-hit")) return;
    tpsSpeedPick(-1);
  });
  tpsTip.addEventListener("focusin", function (e) {
    var col = e.target && e.target.closest && e.target.closest(".zu-sc-col,.zu-hm-cell,.zu-sv3-hit");
    if (col) tpsSpeedPick(parseInt(col.getAttribute("data-i"), 10) || 0);
    var lb = e.target && e.target.closest && e.target.closest(".zu-sv-legend-btn");
    if (lb) spdLegendTipShow(lb);   // v281：键盘聚焦问号同样显示
  });
  tpsTip.addEventListener("focusout", function (e) {
    var col = e.target && e.target.closest && e.target.closest(".zu-sc-col,.zu-hm-cell,.zu-sv3-hit");
    if (col && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".zu-sc-col,.zu-hm-cell,.zu-sv3-hit"))) tpsSpeedPick(-1);
    var lb = e.target && e.target.closest && e.target.closest(".zu-sv-legend-btn");
    if (lb && !(e.relatedTarget && e.relatedTarget.closest && (e.relatedTarget.closest(".zu-sv-legend-btn") || e.relatedTarget.closest(".zu-sv-legend-tip"))))
      spdLegendTipScheduleHide();
  });
  /* v281：浮层开着时 Escape 只收档位说明（本链无既存 Escape 监听，语义成立；
   * 全量 tip 链的 legend 分支并入其 v254 既存 keydown，见 spawnInstance 内）。
   * v384：V3 筛选弹出层最先收（焦点归还搜索按钮），再走档位说明分层。 */
  tpsTip.addEventListener("keydown", function (e) {
    /* v384 M1：方向键移动（镜像 06 分片同款步长表）。 */
    var ac3 = e.target && e.target.closest && e.target.closest(".zu-hm-cell,.zu-sv3-hit");
    if (ac3 && typeof e.key === "string" && e.key.indexOf("Arrow") === 0) {
      var idx3 = parseInt(ac3.getAttribute("data-i"), 10);
      if (idx3 >= 0) {
        var isHit3 = ac3.classList.contains("zu-sv3-hit");
        var isHist3 = !isHit3 && !!ac3.closest(".zu3-hh-grid");
        var step3 = e.key === "ArrowRight" ? (isHit3 || !isHist3 ? 1 : 7)
          : e.key === "ArrowLeft" ? (isHit3 || !isHist3 ? -1 : -7)
          : e.key === "ArrowDown" ? (isHist3 ? 1 : 7)
          : e.key === "ArrowUp" ? (isHist3 ? -1 : -7) : 0;
        if (step3) {
          var nu3 = tpsTip.querySelector('.zu-hm-cell[data-i="' + (idx3 + step3) + '"],.zu-sv3-hit[data-i="' + (idx3 + step3) + '"]');
          if (nu3 && nu3 !== ac3) {
            e.preventDefault();
            ac3.setAttribute("tabindex", "-1");
            nu3.setAttribute("tabindex", "0");
            if (nu3.focus) nu3.focus();
          } else if (!nu3) e.preventDefault();
          return;
        }
      }
    }
    if (e.key !== "Escape") return;
    var t3 = tpsTipFor && tpsTipFor.__zuT, s3 = t3 && t3.speedSel;
    /* v479（spec §28.5）：月历弹层与筛选弹层同层（互斥，一次只有一个开着），焦点归还月份文字按钮 */
    if (s3 && s3.mpop && s3.mpop.open) {
      e.stopPropagation();
      s3.mpop.open = false;
      tpsTip.__zuTipSig = "";
      showTpsTip(tpsTipFor);
      if (typeof spd3MonthFocus === "function") spd3MonthFocus(tpsTip, "close");
      return;
    }
    if (s3 && s3.pop && s3.pop.open) {
      e.stopPropagation();
      s3.pop.open = false; s3.pop.query = "";
      tpsTip.__zuTipSig = "";
      showTpsTip(tpsTipFor);
      var fsBtn3 = tpsTip.querySelector("[data-sv3-fopen]");   /* v390：同 06——归还现役触发按钮 */
      if (fsBtn3 && fsBtn3.focus) fsBtn3.focus();
      return;
    }
    if (spdLegendTip.style.display === "block") { e.stopPropagation(); spdLegendTipHide(); }
  });
  /* v384 V3 筛选弹出层搜索：input 委托挂 tpsTip 本体；只重渲染弹出层并回填焦点/光标，
   * 全卡签名不动（下一次完整重编自然携带最新 query）。 */
  tpsTip.addEventListener("input", function (e) {
    var inp = e.target && e.target.classList && e.target.classList.contains("zu-sv3-fpop-input") ? e.target : null;
    if (!inp) return;
    var t3 = tpsTipFor && tpsTipFor.__zuT, s3 = t3 && t3.speedSel;
    if (!s3) return;
    if (!s3.pop) s3.pop = { open: false, query: "" };
    s3.pop.query = inp.value || "";
    var pop = inp.closest(".zu-sv3-fpop");
    if (pop && typeof spd3FilterPopHTML === "function") {
      var pool3 = (typeof SPD3_POOL !== "undefined" && SPD3_POOL) || [];
      pop.innerHTML = spd3FilterPopHTML(pool3, s3.filt, s3.pop.query);
      var ni3 = pop.querySelector(".zu-sv3-fpop-input");
      if (ni3) {
        ni3.value = s3.pop.query;
        if (ni3.focus) ni3.focus();
        try { ni3.setSelectionRange(ni3.value.length, ni3.value.length); } catch (_) { }
      }
    }
  });
  var TPS_HIDE_DELAY_MS = 180, tpsHideTimer = 0;
  function scheduleTpsHide() {
    if (tpsHideTimer) return;
    tpsHideTimer = setTimeout(function () { tpsHideTimer = 0; hideTpsTip(); }, TPS_HIDE_DELAY_MS);
  }
  function cancelTpsHide() {
    if (tpsHideTimer) { clearTimeout(tpsHideTimer); tpsHideTimer = 0; }
  }
  tpsTip.addEventListener("mouseenter", cancelTpsHide);
  tpsTip.addEventListener("mouseleave", scheduleTpsHide);
  /* ---------- v281 档位说明浮层（底部常驻图例移除后的承载） ----------
   * 图表标题栏「单位：t/s」旁问号按钮 hover/focus 即显（不点击）；body 级浮层脱离
   * overflow 裁剪、显示即移尾（B1 同款）；十档内容 spdLegendCardHTML 自 TPS_BANDS
   * 升序生成，当前档位读按钮 data-sv-band（整卡重编自动更新）；icon→卡保活
   * （延时收+卡内取消），柱体 Portal 打开即收（互斥，§八）；Escape/收起路径全清理。 */
  var spdLegendTip = document.createElement("div");
  spdLegendTip.className = "tip zusage-quota-tip zu-sv-legend-tip";
  spdLegendTip.setAttribute("role", "tooltip");
  spdLegendTip.style.cssText = "position:fixed;display:none;z-index:2147483646;";
  document.body.appendChild(spdLegendTip);
  var SPD_LEGEND_HIDE_MS = 180, spdLegendHideTimer = 0;
  function spdLegendTipHide() {
    if (spdLegendHideTimer) { clearTimeout(spdLegendHideTimer); spdLegendHideTimer = 0; }
    if (spdLegendTip.style.display !== "none") {
      spdLegendTip.style.display = "none";
      var lb = spdLegendTip.__zuBtn;
      spdLegendTip.__zuBtn = null;
      try { if (lb) lb.setAttribute("aria-expanded", "false"); } catch (e) { }
    }
  }
  function spdLegendTipScheduleHide() {
    if (spdLegendHideTimer) return;
    spdLegendHideTimer = setTimeout(function () { spdLegendHideTimer = 0; spdLegendTipHide(); }, SPD_LEGEND_HIDE_MS);
  }
  function spdLegendTipShow(btn) {
    if (spdLegendHideTimer) { clearTimeout(spdLegendHideTimer); spdLegendHideTimer = 0; }
    var cur = btn && btn.getAttribute ? (btn.getAttribute("data-sv-band") || "") : "";
    spdLegendTip.innerHTML = spdLegendCardHTML(cur);
    try { spdLegendTip.classList.toggle("zu-light", !document.documentElement.classList.contains("dark")); } catch (e) { }
    spdHoverPortalHide();   // 柱体信息卡互斥（§八）：问号浮层优先于当前指针目标
    spdLegendTip.__zuBtn = btn || null;
    try { if (btn) btn.setAttribute("aria-expanded", "true"); } catch (e) { }
    if (document.body.lastElementChild !== spdLegendTip) document.body.appendChild(spdLegendTip);   // B1 同款：同层树序移尾
    spdLegendTip.style.display = "block";
    var br = (btn && btn.getBoundingClientRect) ? btn.getBoundingClientRect() : { left: m, right: m, bottom: m, top: m };
    var lr = spdLegendTip.getBoundingClientRect();
    var m = 10, vw = window.innerWidth, vh = window.innerHeight;
    /* 2026-11-07 用户规格：浮层在「查看速度档位说明」按钮右侧展示、顶对齐按钮；
     * 右侧放不下 → 翻按钮左侧，再钳视口边（宽度由 CSS 定宽 430）。 */
    var left = br.right + 8;
    if (left + lr.width > vw - m) left = br.left - lr.width - 8;                 // 右侧不足 → 左侧
    left = Math.min(Math.max(m, left), Math.max(m, vw - m - lr.width));
    var top = br.top;
    if (top + lr.height > vh - m) top = vh - m - lr.height;                      // 底部越界上移
    if (top < m) top = m;
    spdLegendTip.style.left = Math.round(left) + "px";
    spdLegendTip.style.top = Math.round(top) + "px";
  }
  spdLegendTip.addEventListener("mouseenter", function () {
    if (spdLegendHideTimer) { clearTimeout(spdLegendHideTimer); spdLegendHideTimer = 0; }   // icon→卡保活
  });
  spdLegendTip.addEventListener("mouseleave", spdLegendTipScheduleHide);
  spdLegendTip.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.stopPropagation(); spdLegendTipHide(); }
  });

  /* v280：图表横向滚动时按柱体新 rect 重定位 Portal（scroll 不冒泡，capture 相捕获内部滚动） */
  tpsTip.addEventListener("scroll", function () {
    if (tpsTipFor && tpsTipFor.__zuT) spdHoverPortalPlace(tpsTip, tpsTipFor.__zuT.speedHover);
  }, true);
  /* v290 图表区滚轮横滚（2026-11-08 用户规格）：wheel 委托在 tpsTip 本体（随元素消亡，
   * 非全局监听）——指针在 .zu-sc-wrap 上且确可横滚时 deltaY 换算 scrollLeft，
   * preventDefault 阻止页面竖滚；不可横滚不拦截，默认行为照旧。 */
  tpsTip.addEventListener("wheel", function (e) {
    var wrap = e.target && e.target.closest && e.target.closest(".zu-sc-wrap");
    if (!wrap || wrap.scrollWidth <= wrap.clientWidth + 1) return;
    var d = (e.deltaY || 0) + (e.deltaX || 0);
    if (!d) return;
    var before = wrap.scrollLeft;
    wrap.scrollLeft += d;
    if (wrap.scrollLeft !== before) e.preventDefault();
  }, { passive: false });
  var tpsTipFor = null;
  function showTpsTip(el) {
    if (stale() || !el || !el.isConnected || !el.__zuT) { hideTpsTip(); return; }
    var html = el.__zuT.buildTip(el.__zuT);
    /* \x01 前缀 = 结构化 HTML 哨兵（v67.1）：主链 drawTip 经 tip.firstChild.slice(1)
     * 剥除后写入；精简链直塞 innerHTML 必须同语义剥除，否则控制字符落成文本节点，
     * .tip 的 white-space:pre-line 会为其撑出整行行框（~20px 幽灵空行）——V2 卡
     * 定高 300 + overflow:hidden 后整卡下坠、底部被裁（精简 tooltip 上大下小）。 */
    if (html.charCodeAt(0) === 1) html = html.slice(1);
    /* v155：内容含秒表（0.1s 步进），悬停中若随心跳整片重建，「打开设置」/子代理行的
     * 点击会落在被替换掉的旧节点上丢失——显示中内容变化时冻结当前内容、只更新位置，
     * 鼠标移开后下一次悬停按新签名重建（与 gitTip 的「滚动中不重建」同一取舍方向）。
     * v255 曾对 V2 整卡放行以让 Tab/柱 hover 即时重绘——但生成中签名每 tick 变化、
     * 悬停中每 tick 整片重建同样把 mousedown 命中的 Tab 换掉（全量 tip 的 v263 同型
     * 根因）。v263 改回统一冻结：交互路径（Tab/维度/柱 hover）本就先清 __zuTipSig
     * 再进来，清空即放行重编；心跳路径悬停中冻结，与全量 tip 的 mouseInBar 冻结同取舍。 */
    var wasVisible = tpsTip.style.display === "block", oldTipScroll = tpsTip.scrollTop;
    var frozen = tpsTip.__zuTipSig !== html && tpsTip.__zuTipSig && wasVisible;
    var rebuilt = !frozen && tpsTip.__zuTipSig !== html;
    if (rebuilt) {   // 签名幂等（同 quotaTip）：内容没变不重建
      /* v279：柱状图横滚位置跨重编记忆（用户实报 全部×全部 拉到末尾、关闭再开回到
       * 开头）——重建前从旧 DOM 连同选择键（data-sv-key）一起捕获，键同才回填：
       * hover/心跳重编不跳回头部，关闭再开（含期间数据刷新）恢复原位置，切换
       * 范围/时间后键变自动归零；空态/V1 图无 .zu-sv3-root 键不参与。 */
      var sw0 = tpsTip.querySelector(".zu-sc-wrap"), sr0 = tpsTip.querySelector(".zu-sv3-root"), st0 = null;
      if (sw0 && sr0) {
        var oldKey = sr0.getAttribute("data-sv-key") || "";
        st0 = !wasVisible ? (tpsTip.__zuChartScroll && tpsTip.__zuChartScroll.key === oldKey ? tpsTip.__zuChartScroll : null) : { key: oldKey, x: sw0.scrollLeft };
      }
      tpsTip.innerHTML = html;
      if (st0) {
        var sw1 = tpsTip.querySelector(".zu-sc-wrap"), sr1 = tpsTip.querySelector(".zu-sv3-root");
        if (sw1 && sr1 && (sr1.getAttribute("data-sv-key") || "") === st0.key) sw1.scrollLeft = st0.x;
        else if (sw1 && sw1.hasAttribute && sw1.hasAttribute("data-sv-end"))
          sw1.scrollLeft = sw1.scrollWidth;   /* v291：键变进入全部历史=本图无有效记忆，滚到最新区 */
      } else {
        /* v291 历史热力图首开（无记忆位置）：初始滚到最右（最新日期区域），§12.2 */
        var sw2 = tpsTip.querySelector(".zu-sc-wrap");
        if (sw2 && sw2.hasAttribute && sw2.hasAttribute("data-sv-end")) sw2.scrollLeft = sw2.scrollWidth;
      }
      tpsTip.__zuTipSig = html;
    }
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    tpsTip.classList.toggle("zu-light", !dark);
    tpsTip.style.display = "block";
    if (rebuilt || !wasVisible || (tpsTip.__zuSpeedSize && (tpsTip.__zuSpeedSize.vw !== window.innerWidth || tpsTip.__zuSpeedSize.vh !== window.innerHeight))) {
      if (typeof spdFitTip === "function") spdFitTip(tpsTip, !wasVisible);
      if (typeof fitModelNames === "function") fitModelNames(tpsTip);
      if (rebuilt || !wasVisible) {
        if (!rebuilt) st0 = tpsTip.__zuChartScroll || null;
        var fittedChart = tpsTip.querySelector(".zu-sc-wrap"), fittedRoot = tpsTip.querySelector(".zu-sv3-root");
        if (fittedChart && st0 && fittedRoot && (fittedRoot.getAttribute("data-sv-key") || "") === st0.key) fittedChart.scrollLeft = st0.x;
        else if (fittedChart && fittedChart.hasAttribute && fittedChart.hasAttribute("data-sv-end")) fittedChart.scrollLeft = fittedChart.scrollWidth;
      }
      tpsTip.scrollTop = oldTipScroll;
    }
    /* v297：tpsTip 链同款月历网格量测回写（动态字号数据源，见 08 drawTip 同名块）。
     * v298 起挂 display:block 之后——隐藏态量测全 0 会把下一帧字号压到 6px 下限。 */
    var mgEl2 = tpsTip.querySelector(".zu3-hm-grid");
    if (mgEl2) {
      var mgr2 = mgEl2.getBoundingClientRect();
      var monRoot2 = mgEl2.closest && mgEl2.closest(".zu-sv3-root");
      var monZoom2 = parseFloat(monRoot2 && monRoot2.style && monRoot2.style.zoom) || 1;
      window.__zusageSpdMonRect = { w: mgr2.width / monZoom2, h: mgr2.height / monZoom2 };
    }
    var r = el.getBoundingClientRect(), tw = tpsTip.offsetWidth, th = tpsTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.max(8, Math.min(r.bottom + 8, vh - th - 8));
    tpsTip.style.left = Math.round(left) + "px";
    tpsTip.style.top = Math.round(top) + "px";
    /* v284：紧凑链保持 chip 左缘对齐（v283 的 dock 覆盖删除——对齐锚统一为速度格） */
    tpsTipFor = el;
    /* v280：Portal 卡渲染+定位。m2（review）：frozen=悬停中心跳冻结当前内容，
     * 新信道是按最新数据的重分析、与冻结图错位——丢弃不消费，鼠标移开后下次
     * 交互按新签名整卡重编时自然对齐。 */
    if (frozen) SPD_PORTAL = "";
    else spdHoverPortalSync(tpsTip, el.__zuT ? el.__zuT.speedHover : -1);
  }
  function hideTpsTip() {
    cancelTpsHide();
    if (tpsTip.style.display !== "none") {
      var closingChart = tpsTip.querySelector(".zu-sc-wrap"), closingRoot = tpsTip.querySelector(".zu-sv3-root");
      if (closingChart && closingRoot) tpsTip.__zuChartScroll = { key: closingRoot.getAttribute("data-sv-key") || "", x: closingChart.scrollLeft };
    }
    tpsTip.style.display = "none";
    /* v479（spec §28.5）：月历弹层随卡收起，重开不残留 */
    var tpsHideSel = tpsTipFor && tpsTipFor.__zuT && tpsTipFor.__zuT.speedSel;
    if (tpsHideSel && tpsHideSel.mpop) tpsHideSel.mpop.open = false;
    if (tpsHideSel && tpsHideSel.pop) tpsHideSel.pop.open = false;   // v489：筛选弹层随卡收起（同 mpop；搜索词保留）
    tpsTipFor = null;
    spdHoverPortalHide();   // v280：Portal 随 tooltip 收起，不留孤儿浮层
    spdLegendTipHide();     // v281：档位说明浮层同链收起
  }
  /* ---------- v280 柱 hover 信息卡 Portal（P0 裁剪根治） ----------
   * 卡原本绝对定位在 .zu-sv-plot 内，被 .zu-sc-wrap（overflow-x:auto;overflow-y:hidden）
   * 滚动容器裁剪——滚到最右/柱靠边时日期·模型·Token·价格被截断（用户实报）。
   * 改为 body 级独立浮层：内容由 spdChartHTML 构建时经 SPD_PORTAL 侧信道产出（纯字符串，
   * VM 切片安全），宿主整卡重编后 spdHoverPortalSync 渲染并按柱体 getBoundingClientRect
   * 定位（渲染后量真实尺寸，不假设固定宽高）。pointer-events:none 纯展示不拦鼠标；
   * z-index 与 tooltip 同层（2147483646），显示时 spdHoverPortalSync 幂等 appendChild
   * 移到 body 末尾压过同层晚挂的实例 tip（fxTip 1296 行同款实测先例）；模态层
   * 2147483647 仍在其上。类名挂 .zusage-quota-tip 复用 boot 旧代清理链 + dispose 链
   * （cleanupRateTip 尾部）双保险，热更新不自留孤儿节点。横向滚动经 capture 相
   * 滚动重定位（柱滚出可视绘图区即收、滚回恢复，Goal §7.1）。 */
  var spdHoverPortal = document.createElement("div");
  spdHoverPortal.className = "zusage-quota-tip zu-sv-portal";
  spdHoverPortal.setAttribute("role", "tooltip");
  spdHoverPortal.style.cssText = "position:fixed;display:none;z-index:2147483646;pointer-events:none;";
  document.body.appendChild(spdHoverPortal);
  function spdHoverPortalHide() {
    if (spdHoverPortal.style.display !== "none") spdHoverPortal.style.display = "none";
  }
  function spdHoverPortalPlace(tipEl, idx) {
    if (!(idx >= 0) || !tipEl || !tipEl.isConnected) { spdHoverPortalHide(); return; }
    /* v291：热力图格子与柱体共用 data-i 定位契约 */
    var col = tipEl.querySelector('.zu-sc-col[data-i="' + idx + '"],.zu-hm-cell[data-i="' + idx + '"],.zu-sv3-hit[data-i="' + idx + '"]');
    if (!col) { spdHoverPortalHide(); return; }
    var cr = col.getBoundingClientRect();
    /* 柱体滚出可视绘图区即收：与 wrap 视口无交叠不再显示（不显示错位卡）。
     * m1（review）：滚出后拖滚动条/键盘滚回、柱重新可见时用缓存内容重挂
     * （滚轮滚动 Chromium 会补发 mouseover 自愈，这里覆盖不补发的路径）；
     * 交叠判定先行，柱仍在可视区外时不做无谓的显隐churn。 */
    var wrap = col.closest && col.closest(".zu-sc-wrap");
    if (wrap) {
      var wr = wrap.getBoundingClientRect();
      if (cr.right < wr.left + 2 || cr.left > wr.right - 2 || cr.bottom < wr.top + 2 || cr.top > wr.bottom - 2) { spdHoverPortalHide(); return; }
    }
    var clip = col.parentElement;
    while (clip && clip !== tipEl.parentElement) {
      if (clip === tipEl || (clip.classList && clip.classList.contains("tbody"))) {
        var clipRect = clip.getBoundingClientRect();
        if (cr.right <= clipRect.left || cr.left >= clipRect.right || cr.bottom <= clipRect.top || cr.top >= clipRect.bottom) { spdHoverPortalHide(); return; }
      }
      clip = clip.parentElement;
    }
    if (spdHoverPortal.style.display !== "block") {
      if (!spdHoverPortal.__zuHtml) { spdHoverPortalHide(); return; }
      spdHoverPortal.innerHTML = spdHoverPortal.__zuHtml;
      if (document.body.lastElementChild !== spdHoverPortal) document.body.appendChild(spdHoverPortal);
      spdHoverPortal.style.display = "block";
    }
    var pr = spdHoverPortal.getBoundingClientRect();
    var m = 10, vw = window.innerWidth, vh = window.innerHeight;
    /* 水平：柱右侧 6px → 右侧不足翻左侧 → 两侧都不足贴右钳边 */
    var left = cr.right + 6;
    if (left + pr.width > vw - m) left = cr.left - pr.width - 6;
    if (left + pr.width > vw - m) left = vw - m - pr.width;
    if (left < m) left = m;
    /* 垂直：与柱顶对齐（右上/左上）→ 顶部空间不足底对齐柱底 → 钳视口上下 */
    var top = cr.top - 4;
    if (top + pr.height > vh - m) top = cr.bottom + 6 - pr.height;
    if (top + pr.height > vh - m) top = vh - m - pr.height;
    if (top < m) top = m;
    spdHoverPortal.style.left = Math.round(left) + "px";
    spdHoverPortal.style.top = Math.round(top) + "px";
  }
  function spdHoverPortalSync(tipEl, idx) {
    var html = SPD_PORTAL; SPD_PORTAL = "";   // 消费即清
    if (!html || !(idx >= 0) || !tipEl || !tipEl.isConnected) { spdHoverPortalHide(); return; }
    if (spdHoverPortal.__zuHtml !== html) {   // 同内容不重建（m3：compact 心跳 10Hz 只 Place 不重排）
      spdHoverPortal.__zuHtml = html;
      spdHoverPortal.innerHTML = html;
      try { spdHoverPortal.classList.toggle("zu-light", !document.documentElement.classList.contains("dark")); } catch (e) { }
    }
    /* B1/M-2（review）：显示即移尾，不挂内容变化条件——实例级全量 tip 在
     * spawnInstance 时才挂 body、必晚于本 Portal（分屏后跨 pane 同内容 hover 走
     * skip 分支也会被新 tip 盖住），同 z-index(2147483646) 按树序后者在上；
     * lastElementChild 守卫幂等 O(1) 无重排（12224 行同款先例）；模态层 2147483647 仍在其上。 */
    if (document.body.lastElementChild !== spdHoverPortal) document.body.appendChild(spdHoverPortal);
    spdLegendTipHide();   // v281 互斥：柱体信息卡显示时收档位说明，不允许双层浮窗并存
    spdHoverPortal.style.display = "block";
    if (typeof fitModelNames === "function") fitModelNames(spdHoverPortal);
    spdHoverPortalPlace(tipEl, idx);
  }
  /* v176：子代理行内速率 chip 的悬停 tooltip（body 级共享元素，骨架同 tpsTip；内容
   * 构建器挂 chip 的 __zuT 由所属实例闭包提供，数据各回各 pane）。纯展示无点击动作。
   * chip 是动态创建/被宿主重建的节点，悬停走 document 委托不挂逐元素监听——省掉
   * 解绑扫描，宿主重挂/换代采纳旧节点后悬停天然可用。 */
  var subTip = document.createElement("div");
  subTip.className = "tip zusage-subrate-tip";
  subTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(subTip);
  var SUB_HIDE_DELAY_MS = 180, subHideTimer = 0;
  function scheduleSubHide() {
    if (subHideTimer) return;
    subHideTimer = setTimeout(function () { subHideTimer = 0; hideSubTip(); }, SUB_HIDE_DELAY_MS);
  }
  function cancelSubHide() {
    if (subHideTimer) { clearTimeout(subHideTimer); subHideTimer = 0; }
  }
  subTip.addEventListener("mouseenter", cancelSubHide);
  subTip.addEventListener("mouseleave", scheduleSubHide);
  var subTipFor = null;
  function showSubTip(el) {
    if (stale() || !el || !el.isConnected || !el.__zuT) { hideSubTip(); return; }
    var html = el.__zuT.buildTip(el.__zuT);
    if (subTip.__zuTipSig !== html) {   // 签名幂等（同 tpsTip）：内容没变不重建
      subTip.innerHTML = html;
      subTip.__zuTipSig = html;
    }
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    subTip.classList.toggle("zu-light", !dark);
    subTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = subTip.offsetWidth, th = subTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    subTip.style.left = Math.round(left) + "px";
    subTip.style.top = Math.round(top) + "px";
    subTipFor = el;
  }
  function hideSubTip() {
    cancelSubHide();
    subTip.style.display = "none";
    subTipFor = null;
  }
  /* v440 chip 悬停门槛（issue #445 扩展，用户规格）：工具行/流内 chip 的悬停明细与条面格
   * 同门槛——共用 zusage3.tipHoverMs（默认 500ms，v440 改档；0=划过即显仅手改 LS），路过不弹、停留才看。
   * chip 有精确 mouseenter/mouseleave 对（不走条面的 150ms 节流 hit-test），无需到点复核：
   * enter 排程、leave 即撤即不弹。单槽 key=chip 元素本体——同时刻至多悬停一处，换 chip
   * 自动作废旧排程，同 chip 内 mouseover 重入不重置已等待时长。focus/blur（键盘）不进门
   * 保持即时；fxTip/档位说明（已开 tooltip 内的 ？ 小目标）、齿轮更新日志卡（红点+悬停
   * 双门控）不在门内。VM 切片夹具的 state 无 tipHoverMs 时按 0=即时直通，既有 chip 测试不感知。 */
  var zuChipHoverSlot = null;
  function zuChipHoverArm(el, open) {
    if (zuChipHoverSlot && zuChipHoverSlot.key === el) return;   // 同 chip 续期：已等待时长不重置
    zuChipHoverDisarm();
    var d = parseInt(state.tipHoverMs, 10) || 0;
    if (!(d > 0)) { open(); return; }
    var slot = { key: el, timer: 0 };
    slot.timer = setTimeout(function () {
      if (zuChipHoverSlot !== slot) return;   // 已被 disarm/换代：过期回调直接弃
      zuChipHoverSlot = null;
      if (el && el.isConnected === false) return;   // chip 已随实例销毁/重建摘除：不到点重挂
      open();
    }, d);
    zuChipHoverSlot = slot;
  }
  function zuChipHoverDisarm(el) {
    if (!zuChipHoverSlot || (el && zuChipHoverSlot.key !== el)) return;
    clearTimeout(zuChipHoverSlot.timer);
    zuChipHoverSlot = null;
  }
  function subTipDocOver(e) {
    if (stale()) return;
    /* v332：工作流 run 卡 chip（.zu-wfrun）、v333 状态面板行 chip（.zu-substat）共用本浮层与委托——不加新监听（监听预算纪律） */
    var chip = e.target && e.target.closest ? e.target.closest(".zu-subrate,.zu-wfrun,.zu-substat") : null;
    if (chip && chip.__zuT) {
      cancelSubHide();
      var chipT = chip;
      zuChipHoverArm(chip, function () { showSubTip(chipT); });   // v440：同走悬停门槛
      return;
    }
    if (subTipFor && !(e.target && subTip.contains(e.target))) scheduleSubHide();
  }
  function subTipDocOut(e) {
    var fromChip = e.target && e.target.closest ? e.target.closest(".zu-subrate,.zu-wfrun,.zu-substat") : null;
    if (fromChip) {
      var to0 = e.relatedTarget;
      if (!(to0 && to0.closest && to0.closest(".zu-subrate,.zu-wfrun,.zu-substat") === fromChip)) zuChipHoverDisarm(fromChip);   // v440：真离开 chip 撤在途排程（chip 内子元素间移动不撤）
    }
    if (!subTipFor) return;
    var to = e.relatedTarget;
    if (to && (subTip.contains(to) || (to.closest && (to.closest(".zu-subrate") === subTipFor ||
        to.closest(".zu-wfrun") === subTipFor || to.closest(".zu-substat") === subTipFor)))) return;
    scheduleSubHide();
  }
  document.addEventListener("mouseover", subTipDocOver, true);
  document.addEventListener("mouseout", subTipDocOut, true);
  var RST_FAM_LABELS = { bigmodel: "BigModel", zai: "Z.ai" };
  /* grantType 枚举的行首展示文案（服务端原值未知语义兜底显示原文；BigModel 未公布口径，
   * GLOBAL=全局发放卡 / DIRECT=直发卡为实测推断，仅作区分展示不作计费语义宣称） */
  var RST_GRANT_LABELS = { GLOBAL: L("全局", "Global"), DIRECT: L("直发", "Direct") };
  function rstGrantText(v) { return RST_GRANT_LABELS[v] || v || ""; }
  /* 徽标三档色阈值唯一事实源：resetBadgeView 判档、tooltip 图例与到期行着色共用，避免漂移。
   * dotCls 的色值定义在 rstTipHTML 注入的 <style>（含 .zu-light 浅色组） */
  var RST_BANDS = [
    { cls: "zu-rst-crit", max: 30 * 60 * 1000, dotCls: "zu-rdot-crit",
      text: L("<30 分钟（呼吸闪烁）", "<30 min (pulsing)") },
    { cls: "zu-rst-mid", max: 3 * 3600 * 1000, dotCls: "zu-rdot-mid",
      text: L("30 分钟–3 小时", "30 min–3 h") },
    { cls: "zu-rst-calm", max: Infinity, dotCls: "zu-rdot-calm",
      text: L(">3 小时", ">3 h") },
  ];
  /* 按剩余时间判档（RST_BANDS 末档 max=Infinity 恒命中）；tooltip 到期行着色与徽标同源 */
  function rstBandClsOf(rem) {
    for (var bi = 0; bi < RST_BANDS.length; bi++) {
      if (rem <= RST_BANDS[bi].max) return RST_BANDS[bi].cls;
    }
    return RST_BANDS[RST_BANDS.length - 1].cls;
  }
  function rstTipHTML(v) {
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    /* rst-row 独立类名：rstTip 与 quotaTip 共用 zusage-quota-tip 类，<style> 是全局作用域，
     * 复用 .rt-row 会与额度 tooltip 的两列布局互相覆盖（单行布局用户规格 2026-10-28）。 */
    var out = '<style>.zusage-quota-tip .rst-row{margin:4px 0;color:var(--color-tooltip-foreground,#fafafa);overflow-wrap:anywhere}' +
      ".zusage-quota-tip .rst-group{margin:6px 0 2px}" +
      ".zusage-quota-tip .rst-group .rst-fam{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zusage-quota-tip .rst-row .rst-fam{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zusage-quota-tip .rst-row.rst-exp{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      /* 到期行按剩余时间档位着色（用户规格 2026-11-05）：色值同图例色点，>3 小时行维持默认色 */
      ".zusage-quota-tip .rst-row.zu-rst-mid{color:#f5b944}" +
      ".zusage-quota-tip .rst-row.zu-rst-crit{color:#ff6b57}" +
      ".zusage-quota-tip .rst-h{font-weight:600;color:var(--color-tooltip-foreground,#fafafa);margin:0 0 7px}" +
      ".zusage-quota-tip .rst-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 6px;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
      ".zusage-quota-tip .rst-lg{display:inline-flex;align-items:center;gap:5px}" +
      ".zusage-quota-tip .rst-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}" +
      ".zusage-quota-tip .zu-rdot-calm{background:#3ecf8e}" +
      ".zusage-quota-tip .zu-rdot-mid{background:#f5b944}" +
      ".zusage-quota-tip .zu-rdot-crit{background:#ff6b57}" +
      ".zusage-quota-tip.zu-light .zu-rdot-calm{background:#0f9d6c}" +
      ".zusage-quota-tip.zu-light .zu-rdot-mid{background:#b6791a}" +
      ".zusage-quota-tip.zu-light .zu-rdot-crit{background:#d8482f}" +
      ".zusage-quota-tip.zu-light .rst-row.zu-rst-mid{color:#b6791a}" +
      ".zusage-quota-tip.zu-light .rst-row.zu-rst-crit{color:#d8482f}" +
      '.zusage-quota-tip .rst-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-popover-border,var(--color-border,transparent));color:var(--color-tooltip-tag-foreground,#a6a6a6);overflow-wrap:anywhere}' +
      ".zusage-quota-tip .rst-howto{margin-left:6px;background:none;border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:999px;color:inherit;font:inherit;font-size:.85em;line-height:1.5;padding:0 9px;cursor:pointer}" +
      ".zusage-quota-tip .rst-howto:hover{color:var(--color-tooltip-foreground,#fafafa);border-color:var(--color-border-hover,rgba(255,255,255,.24))}</style>" +
      '<div class="rst-h">' + L("额度重置卡", "Quota reset cards") + "</div>";
    for (var i = 0; i < v.fams.length; i++) {
      var e = v.fams[i].entry;
      var label = RST_FAM_LABELS[v.fams[i].fam] || v.fams[i].fam;
      var now = Date.now();
      /* 账号名只作组头出现一次，卡片行不再重复前缀（用户规格 2026-10-28） */
      out += '<div class="rst-group"><span class="rst-fam">' + esc(label) + "</span></div>";
      /* 行首展示 grantType（用户规格 2026-10-28）：列表端点每卡自带，status 端点没有——
       * 有列表数据（bigmodel 族 resetList 开启）时整组行改由列表渲染，否则回退 status 行（无前缀） */
      var listData = e.list && typeof e.list === "object" &&
        (Array.isArray(e.list.fiveHour) || Array.isArray(e.list.week)) ? e.list : null;
      if (listData) {
        var rows = [];
        [["fiveHour", L("5小时卡", "5-hour card")], ["week", L("周卡", "Weekly card")]].forEach(function (group) {
          if (!Array.isArray(listData[group[0]])) return;
          listData[group[0]].forEach(function (card) {
            var t = card && card.expireAt;
            if (typeof t !== "number" || !isFinite(t) || t <= now - 7 * 86400000) return;
            rows.push({ time: t, label: group[1], expired: t <= now, grantType: card.grantType || "" });
          });
        });
        rows.sort(function (a, b) { return a.expired - b.expired || a.time - b.time; });
        if (!rows.length) out += '<div class="rst-row">' + L("暂无重置卡", "no reset cards") + "</div>";
        rows.forEach(function (card) {
          var prefix = rstGrantText(card.grantType);
          if (prefix) prefix += " ";
          /* 未过期行按剩余档位着色（<30 分红 / 30 分–3 时黄）；>3 小时档与过期行维持默认色 */
          var bandCls = card.expired ? "" : rstBandClsOf(card.time - now);
          out += '<div class="rst-row' + (card.expired ? " rst-exp" : bandCls === "zu-rst-calm" ? "" : " " + bandCls) + '">' +
            esc(prefix + card.label + " · " + (card.expired ? L("已过期 ", "Expired ") : L("到期 ", "Expires ")) + qTimeS(card.time)) + "</div>";
        });
        var lastRow = [];
        if (e.lastFiveHour) lastRow.push(L("5小时窗 ", "5-hour ") + e.lastFiveHour.slice(0, 19));
        if (e.lastWeek) lastRow.push(L("周窗 ", "weekly ") + e.lastWeek.slice(0, 19));
        if (lastRow.length) {
          out += '<div class="rst-row">' + esc(L("上次重置 ", "last reset ") + lastRow.join(L("；", "; "))) + "</div>";
        }
      } else {
      var cards = [];
      [[e.fiveHour, L("5小时卡", "5-hour card")], [e.week, L("周卡", "Weekly card")]].forEach(function (group) {
        if (!Array.isArray(group[0])) return;
        group[0].forEach(function (card) {
          var t = card && card.expireAt;
          if (typeof t !== "number" || !isFinite(t) || t <= now - 7 * 86400000) return;
          cards.push({ time: t, label: group[1], expired: t <= now });
        });
      });
      /* 旧冷主进程（resetList 之前）的字段名是 history：只有近 7 天过期卡。热文件先于冷
       * 文件部署是常态，渲染端必须兼容两种字段，否则过期行在重启前整段消失（实测）。 */
      var legacyHist = e.history && typeof e.history === "object" ? e.history : null;
      if (legacyHist) {
        var seenValid = {};
        cards.forEach(function (card) { seenValid[card.label + card.time] = 1; });
        var legacyExpired = [];
        [["fiveHour", L("5小时卡", "5-hour card")], ["week", L("周卡", "Weekly card")]].forEach(function (group) {
          if (!Array.isArray(legacyHist[group[0]])) return;
          legacyHist[group[0]].forEach(function (card) {
            var t = card && card.expireAt;
            if (typeof t !== "number" || !isFinite(t) || t > now || now - t > 7 * 86400000) return;
            if (seenValid[group[1] + t]) return;
            legacyExpired.push({ time: t, label: group[1] });
          });
        });
        legacyExpired.sort(function (a, b) { return b.time - a.time; });
        legacyExpired.forEach(function (card) {
          cards.push({ time: card.time, label: card.label, expired: true });
        });
      }
      cards.sort(function (a, b) { return a.expired - b.expired || a.time - b.time; });
      if (!cards.length) out += '<div class="rst-row">' + L("暂无重置卡", "no reset cards") + "</div>";
      cards.forEach(function (card) {
        /* 未过期行按剩余档位着色（同上 listData 路径） */
        var bandCls = card.expired ? "" : rstBandClsOf(card.time - now);
        out += '<div class="rst-row' + (card.expired ? " rst-exp" : bandCls === "zu-rst-calm" ? "" : " " + bandCls) + '">' +
          esc(card.label + " · " + (card.expired ? L("已过期 ", "Expired ") : L("到期 ", "Expires ")) + qTimeS(card.time)) + "</div>";
      });
      }
    }
    var footBusy = false, footStale = false, footAt = 0;
    for (var fi2 = 0; fi2 < v.fams.length; fi2++) {
      var fe = v.fams[fi2].entry;
      if (fe.busy) footBusy = true;
      if (fe.stale) footStale = true;
      if (fe.fetchedAt > footAt) footAt = fe.fetchedAt;
    }
    var foot = footBusy ? L("查询中…", "Querying…") : (footAt ? L("更新于 ", "updated ") + qTime(footAt) : "");
    if (footStale) foot += (foot ? " · " : "") + L("部分数据已过期，等待刷新", "some data stale, refreshing");
    /* 颜色图例：色点类与徽标三档同源（RST_BANDS），浅色主题由 rstTip 的 .zu-light 组覆盖 */
    var legend = '<div class="rst-legend">';
    for (var li = 0; li < RST_BANDS.length; li++) {
      legend += '<span class="rst-lg"><i class="rst-dot ' + RST_BANDS[li].dotCls + '"></i>' + esc(RST_BANDS[li].text) + "</span>";
    }
    legend += "</div>";
    out += '<div class="rst-note">' + legend +
      L("徽标颜色按最快到期卡的剩余时间变化；每 2 分钟自动查询，有可用数据时切回窗口或悬停徽标立即拉新（30 秒防抖），倒计时按本机时钟推算。", "The badge color tracks the soonest card's time left; polled every 2 minutes, refreshed on window focus or hovering the badge when data is available (30s debounce); countdown computed locally.") + "<br>" +
      L("重置卡核销后立即把对应额度窗口恢复到 100%；到期未用自动作废。", "Using a card restores its quota window to 100% instantly; unused cards expire.") +
      ' <button type="button" class="rst-howto">' + L("如何重置", "How to reset") + "</button></div>";
    return out;
  }
  function showRstTip(el) {
    if (stale() || !el || !el.isConnected || !el.__zuR) { hideRstTip(); return; }
    pluginRequest("quota-poke");   // v361 查看即拉新（主进程 30s 防抖；旧主进程回 unknown 无害）
    var html = rstTipHTML(el.__zuR);
    if (rstTip.__zuTipSig !== html) {
      rstTip.innerHTML = html;
      rstTip.__zuTipSig = html;
    }
    /* 图例浅色色点随宿主主题换装（每次悬停时同步；悬停中切主题属边缘态，下次悬停校正） */
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    rstTip.classList.toggle("zu-light", !dark);
    rstTip.style.display = "block";
    var r = el.getBoundingClientRect(), tw = rstTip.offsetWidth, th = rstTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    rstTip.style.left = Math.round(left) + "px";
    rstTip.style.top = Math.round(top) + "px";
    rstTipFor = el;
  }
  function hideRstTip() {
    cancelRstHide();
    rstTip.style.display = "none";
    rstTipFor = null;
  }
  /* ---------- 增强历史面板：悬停增强按钮弹出（替代 v344 纯文字提示）。
   * 最近 3 条卡片 + 查看全部/清空；数据经 enhance-history-* 插件动作读写运行目录。
   * 纯文本渲染（esc），SVG 全部 currentColor；鼠标移入面板保活，移出延迟收起。 */
  var enhanceTip = document.createElement("div");
  enhanceTip.className = "tip zusage-quota-tip zusage-enhance-tip";
  enhanceTip.style.cssText = rateTip.style.cssText;
  enhanceTip.style.width = "600px";
  enhanceTip.style.maxWidth = "calc(100vw - 24px)";
  enhanceTip.style.maxHeight = "min(650px,72vh)";
  enhanceTip.style.display = "flex";
  enhanceTip.style.flexDirection = "column";
  enhanceTip.style.overflow = "hidden";
  enhanceTip.style.padding = "0";
  enhanceTip.style.display = "none";
  document.body.appendChild(enhanceTip);
  var enhanceTipFor = null;
  var EH_HIDE_DELAY_MS = 220;
  var ehHideTimer = 0;
  var ehCache = null, ehCacheAt = 0, ehLoading = false, ehError = false;
  var EH_ICON = {
    history: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
    server: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h6M12 17.5h6"/></svg>',
    chip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4"/><path d="M1 9h4M1 15h4M19 9h4M19 15h4"/></svg>',
    doc: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 1.9 5.9L20 11l-6.1 2.1L12 19l-1.9-5.9L4 11l6.1-2.1L12 3Z"/><path d="m19 18 .6 1.4L21 20l-1.4.6L19 22l-.6-1.4L17 20l1.4-.6L19 18Z"/></svg>',
    db: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></svg>',
    cal: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 15h3M8 18h3M15 15h1"/></svg>',
    timer: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6M12 2v3"/><path d="m19 6 2-2"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2"/><path d="M5 6l1 15h12l1-15"/><path d="M10 10v7M14 10v7"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    empty: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v5h5"/><path d="M8 12h8"/></svg>'
  };
  /* 查看全部历史：套餐源 id → 显示名（与 model-puller.cjs PLAN_SOURCES 同源，避免表格里
   * 出现 account:bigmodel-start-plan 这类内部 id；非套餐 id 原样显示，不虚构名称） */
  var EH_PLAN_LABELS = {
    "account:bigmodel-individual-coding-plan": "BigModel Coding Plan",
    "account:bigmodel-team-coding-plan": "BigModel Coding Plan (team)",
    "account:bigmodel-start-plan": "BigModel Start Plan",
    "account:zai-individual-coding-plan": "Z.ai Coding Plan",
    "account:zai-team-coding-plan": "Z.ai Coding Plan (team)",
    "account:zai-start-plan": "Z.ai Start Plan"
  };
  function ehProvLabel(name) {
    name = String(name || "");
    return EH_PLAN_LABELS[name] || name;
  }
  function enhanceHistoryAdd(record) {
    pluginRequest("enhance-history-add", { record: record });
    ehCacheAt = 0;   // 失效：下次悬停拉取含新记录
    ehFullCache = null;   // 全量面板缓存同样失效（打开中下次交互重建）
  }
  function ehEsc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function ehFetch(done) {
    ehLoading = true;
    pluginRequest("enhance-history-list", { limit: 3 }, function (res) {
      ehLoading = false;
      if (res && res.ok && Array.isArray(res.records)) { ehCache = res; ehCacheAt = Date.now(); ehError = false; }
      else ehError = true;
      done();
    });
  }
  function ehFmtWhen(iso) {
    var d = Date.parse(iso || "");
    if (!isFinite(d)) return "—";
    var t = new Date(d), p2 = function (n) { return n < 10 ? "0" + n : "" + n; };
    return p2(t.getMonth() + 1) + "-" + p2(t.getDate()) + " " + p2(t.getHours()) + ":" + p2(t.getMinutes());
  }
  function ehFmtFull(iso) {
    var d = Date.parse(iso || "");
    if (!isFinite(d)) return "";
    var t = new Date(d), p2 = function (n) { return n < 10 ? "0" + n : "" + n; };
    return t.getFullYear() + "-" + p2(t.getMonth() + 1) + "-" + p2(t.getDate()) + " " + p2(t.getHours()) + ":" + p2(t.getMinutes()) + ":" + p2(t.getSeconds());
  }
  function ehFmtDur(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    return Math.floor(ms / 60000) + "m " + ((ms % 60000) / 1000).toFixed(1) + "s";
  }
  function ehTokenText(usage) {
    var t = usage && Number.isFinite(usage.totalTokens) ? usage.totalTokens : null;
    return t == null ? L("Token 未提供", "tokens not reported") : t.toLocaleString() + " Token";
  }
  function ehCardHTML(r, expanded) {
    var src = r.source === "test" ? L("测试", "test") : L("聊天", "chat");
    var orig = String(r.originalText || ""), enh = String(r.enhancedText || "");
    var tok = r.usage && Number.isFinite(r.usage.totalTokens) ? r.usage.totalTokens.toLocaleString() + " tokens" : L("未提供", "not reported");
    var when = ehFmtFull(r.createdAt);
    return '<div class="zu-eh-card" data-id="' + ehEsc(r.id) + '">' +
      '<div class="zu-eh-pm">' +
      '<span class="zu-eh-ico">' + EH_ICON.server + '</span><span class="zu-eh-lab-k">' + L("供应商：", "Provider: ") + '</span><span class="zu-eh-pm-name" title="' + ehEsc(r.providerName) + '">' + ehEsc(r.providerName || "—") + '</span>' +
      '<span class="zu-eh-sep"></span>' +
      '<span class="zu-eh-ico">' + EH_ICON.chip + '</span><span class="zu-eh-lab-k">' + L("模型：", "Model: ") + '</span><span class="zu-eh-pm-name" title="' + ehEsc(r.modelId) + '">' + ehEsc(r.modelId || "—") + '</span></div>' +
      '<div class="zu-eh-text"><span class="zu-eh-lab-k">' + EH_ICON.doc + L("原始文本：", "Original: ") + '</span><span class="zu-eh-body">' + ehEsc(orig) + '</span></div>' +
      '<div class="zu-eh-text zu-eh-text-enh"><span class="zu-eh-lab-k zu-eh-lab-enh">' + EH_ICON.spark + L("增强文本：", "Enhanced: ") + '</span><span class="zu-eh-body">' + ehEsc(enh) + '</span></div>' +
      '<div class="zu-eh-stats">' +
      '<span class="zu-eh-stat">' + EH_ICON.db + '<span class="zu-eh-lab-k">' + L("消耗：", "Tokens: ") + '</span>' + ehEsc(tok) + '</span>' +
      '<span class="zu-eh-stat">' + EH_ICON.cal + '<span class="zu-eh-lab-k">' + L("时间：", "Time: ") + '</span>' + ehEsc(when) + '</span>' +
      '<span class="zu-eh-stat">' + EH_ICON.timer + '<span class="zu-eh-lab-k">' + L("耗时：", "Duration: ") + '</span>' + ehEsc(ehFmtDur(r.durationMs)) + '</span></div></div>';
  }
  function ehRender() {
    var el = enhanceTipFor;
    var phase = el && el.__zuEnhTip ? '<span class="zu-eh-phase">' + ehEsc(el.__zuEnhTip) + "</span>" : "";
    var body;
    if (ehLoading && !ehCache) body = '<div class="zu-eh-empty">' + L("正在读取历史…", "Loading history…") + "</div>";
    else if (ehError) body = '<div class="zu-eh-empty">' + L("读取历史记录失败", "Failed to load history") + '<button type="button" class="zu-eh-retry zu-eh-act">' + L("重试", "Retry") + "</button><small>" + L("如果重试仍失败，请完全重启 ZCode 后再试。", "If retry fails, fully restart ZCode.") + "</small></div>";
    else if (!ehCache || !ehCache.records || !ehCache.records.length) body = '<div class="zu-eh-empty">' + EH_ICON.empty + '<div>' + L("暂无增强历史", "No enhancement history yet") + '</div><small>' + L("成功增强提示词后，记录会显示在这里。", "Records appear here after a successful enhancement.") + "</small></div>";
    else body = '<div class="zu-eh-scroll">' + ehCache.records.map(function (r) { return ehCardHTML(r, false); }).join("") + "</div>";
    var footer = '<div class="zu-eh-footer"><button type="button" class="zu-eh-act zu-eh-all" data-all>' + EH_ICON.list + L("查看全部历史", "View all history") + '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button><button type="button" class="zu-eh-act zu-eh-clear" data-clear>' + EH_ICON.trash + L("清空记录", "Clear records") + '</button><button type="button" class="zu-eh-act" data-ehset title="' + L("提示词增强设置", "Prompt enhancement settings") + '">' + EH_ICON.gear + L("设置", "Settings") + "</button></div>";
    var total = ehCache && ehCache.total != null ? L("共 ", "total ") + ehCache.total + L(" 条", "") : "";
    enhanceTip.innerHTML = '<div class="zu-eh-head"><div class="zu-eh-head-row"><span class="zu-eh-title">' + EH_ICON.history + L("最近增强记录", "Recent enhancements") + phase + '</span>' + (total ? '<span class="zu-eh-total">' + total + '</span>' : "") + '</div></div>' + body + '<div class="zu-eh-arrow"></div>' + footer;
    placeEnhanceTip();   // v355：内容高度变化（加载完成/清空/删除）后重钳视口位置
  }
  /* v355 视口钳位（用户实报截图：多条卡片时面板顶缘越出窗口顶部被裁剪）——bottom 锚定
   * 只保证底边间距，内容高超过按钮上方可用空间时顶部直接溢出视口。每次显示/内容重绘后按
   * 实测高三档放置：上方够→bottom 锚定（原行为）；上方不够而下方够→翻到按钮下方（箭头
   * 翻转，v315 cap 翻转先例）；两侧都不够→保持上方贴边并钳 maxHeight 让 .zu-eh-scroll 内滚。
   * offsetHeight 在切片/桩环境缺席（→0），恒走「上方够」分支，既有行为与断言不变。 */
  function placeEnhanceTip() {
    var el = enhanceTipFor;
    if (!el || !el.isConnected) return;
    var r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    var tw = Math.min(600, vw - 24);
    enhanceTip.style.left = Math.max(8, Math.min(Math.round(r.left + r.width / 2 - tw / 2), Math.round(vw - tw - 8))) + "px";
    var above = r.top - 20, below = vh - r.bottom - 20;   // 12px 间距 + 8px 视口边距
    enhanceTip.style.maxHeight = "";   // 先解除上一拍的钳高，再量自然高——否则小钳位会锁死后续测量
    var h = enhanceTip.offsetHeight || 0;
    if (h <= above) {
      enhanceTip.style.top = "auto";
      enhanceTip.style.bottom = (vh - Math.round(r.top) + 12) + "px";
      enhanceTip.style.maxHeight = "min(650px,72vh)";   // 恢复 boot 契约的 650px 帽（内部照常滚动），不因走该分支而退役
      enhanceTip.classList.remove("zu-eh-flip");
    } else if (below >= Math.min(h, 320)) {   // 至少 320px 高才值得翻到下方
      enhanceTip.style.top = (Math.round(r.bottom) + 12) + "px";
      enhanceTip.style.bottom = "auto";
      enhanceTip.style.maxHeight = Math.min(h, below) + "px";   // 下方同样钳高，防止面板底缘越出视口
      enhanceTip.classList.add("zu-eh-flip");
    } else {
      enhanceTip.style.top = "auto";
      enhanceTip.style.bottom = (vh - Math.round(r.top) + 12) + "px";
      enhanceTip.style.maxHeight = Math.max(above, 0) + "px";
      enhanceTip.classList.remove("zu-eh-flip");
    }
  }
  function showEnhanceTip(el) {
    if (stale() || !el || !el.isConnected) { hideEnhanceTip(); return; }
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    enhanceTip.classList.toggle("zu-light", !dark);
    enhanceTip.style.display = "flex";
    enhanceTipFor = el;
    if (!ehCache || Date.now() - ehCacheAt > 5000) { if (!ehLoading) ehFetch(ehRender); }
    ehRender();
  }
  function scheduleEnhHide() {
    if (state.devKeepTip) return;   // 开发者常驻开关：不自动收，仅 Escape 手动关
    if (ehHideTimer) clearTimeout(ehHideTimer);
    ehHideTimer = setTimeout(function () { ehHideTimer = 0; hideEnhanceTip(); }, EH_HIDE_DELAY_MS);
  }
  function cancelEnhHide() {
    if (ehHideTimer) { clearTimeout(ehHideTimer); ehHideTimer = 0; }
  }
  function hideEnhanceTip() {
    cancelEnhHide();
    enhanceTip.style.display = "none";
    enhanceTipFor = null;
  }
  enhanceTip.addEventListener("mouseenter", cancelEnhHide);
  enhanceTip.addEventListener("mouseleave", scheduleEnhHide);
  enhanceTip.addEventListener("keydown", function (e) { if (e.key === "Escape") hideEnhanceTip(); });
  enhanceTip.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest("button");
    if (!btn) return;
    if (btn.hasAttribute("data-all")) { openEnhanceHistoryFull(); return; }
    if (btn.hasAttribute("data-ehset")) { openEnhanceSettings(); return; }
    if (btn.hasAttribute("data-clear")) {
      zuConfirm(L("清空增强历史", "Clear enhancement history"), L("确定清空全部增强历史吗？此操作无法撤销。", "Clear all enhancement history? This cannot be undone."), L("清空", "Clear"), function () {
        pluginRequest("enhance-history-clear", {}, function () { ehCache = null; ehRender(); });
      });
      return;
    }
    if (btn.classList.contains("zu-eh-retry")) { ehFetch(ehRender); return; }
    var card = btn.closest(".zu-eh-card");
    if (btn.hasAttribute("data-expand") && card) {
      card.querySelectorAll("[data-eh-prev]").forEach(function (pre) { pre.classList.toggle("open"); });
      btn.classList.toggle("open");
      return;
    }
    if (btn.hasAttribute("data-del") && card) {
      var delCardId = card.getAttribute("data-id");
      zuConfirm(L("删除记录", "Delete record"), L("确定删除这条增强记录？删除后无法恢复。", "Delete this enhancement record? This cannot be undone."), L("删除", "Delete"), function () {
        pluginRequest("enhance-history-delete", { id: delCardId }, function (res) {
          if (res && res.ok) { ehCache = null; ehFetch(ehRender); }
        });
      });
      return;
    }
    if (btn.classList.contains("zu-eh-copy") && card) {
      var pre = card.querySelector('[data-eh-prev="' + btn.getAttribute("data-copy") + '"]');
      var text = pre ? pre.textContent : "";
      var done = function () { var old = btn.innerHTML; btn.innerHTML = EH_ICON.check; setTimeout(function () { btn.innerHTML = old; }, 900); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    }
  });
  /* ---------- v413 齿轮悬停更新日志卡：待重启红点 × ⚙ 悬停弹出（宿主 UpdateReleaseNotesTooltip 同款形态）。
   * document 级单例同 enhanceTip 套路；内容由实例侧（09 分片）写入 gear.__zuUpdHtml（含门控），
   * 本层只管壳、定位与收放；220ms 宽限让指针从齿轮移入卡内保活，Escape 收起。 */
  var updNoteTip = document.createElement("div");
  updNoteTip.className = "tip zusage-quota-tip zusage-upd-note-tip";
  /* rateTip 定义在本段之前的 01 分片处；VM 切片（如增强历史表格）起点在其后、终点在其后，
   * 会把本段切进无 rateTip 的沙箱——typeof 守卫兜底，缺省时靠 .tip 类样式与 06 分片作用域规则。 */
  if (typeof rateTip !== "undefined" && rateTip) updNoteTip.style.cssText = rateTip.style.cssText;
  updNoteTip.style.width = "384px";
  updNoteTip.style.maxWidth = "calc(100vw - 16px)";
  updNoteTip.style.maxHeight = "min(420px,72vh)";
  updNoteTip.style.display = "flex";
  updNoteTip.style.flexDirection = "column";
  updNoteTip.style.overflow = "hidden";
  updNoteTip.style.padding = "0";
  updNoteTip.style.display = "none";
  if (typeof updNoteTip.setAttribute === "function") updNoteTip.setAttribute("role", "tooltip");   // 切片桩元素缺该方法，跳过不碍运行
  document.body.appendChild(updNoteTip);
  var updNoteTipFor = null;
  var UN_HIDE_DELAY_MS = 220;
  var unHideTimer = 0;
  /* 定位：右缘对齐齿轮右缘（齿轮居条最右，居中/左对齐都会越出右缘）+ 8px 视口钳边；
   * 垂直三档照 placeEnhanceTip：上方够→bottom 锚定，不够→翻下方，两侧都不够→钳高内滚。
   * 先解除上一拍钳高再量自然高——否则小钳位会锁死后续测量（v355 教训）。 */
  function placeUpdNoteTip() {
    var el = updNoteTipFor;
    if (!el || !el.isConnected) return;
    var r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    var tw = Math.min(384, vw - 16);
    updNoteTip.style.left = Math.max(8, Math.min(Math.round(r.right - tw), Math.round(vw - tw - 8))) + "px";
    var above = r.top - 20, below = vh - r.bottom - 20;   // 12px 间距 + 8px 视口边距
    updNoteTip.style.maxHeight = "";
    var h = updNoteTip.offsetHeight || 0;
    if (h <= above) {
      updNoteTip.style.top = "auto";
      updNoteTip.style.bottom = (vh - Math.round(r.top) + 12) + "px";
      updNoteTip.style.maxHeight = "min(420px,72vh)";   // 恢复自然帽，不因走该分支而锁死
    } else if (below >= Math.min(h, 320)) {   // 至少 320px 高才值得翻到下方
      updNoteTip.style.top = (Math.round(r.bottom) + 12) + "px";
      updNoteTip.style.bottom = "auto";
      updNoteTip.style.maxHeight = Math.min(h, below) + "px";
    } else {
      updNoteTip.style.top = "auto";
      updNoteTip.style.bottom = (vh - Math.round(r.top) + 12) + "px";
      updNoteTip.style.maxHeight = Math.max(above, 0) + "px";
    }
  }
  function renderUpdNoteTip() {
    var el = updNoteTipFor;
    if (!el) return;
    var html = String(el.__zuUpdHtml || "");
    if (!html) { hideUpdNoteTip(); return; }
    if (updNoteTip.__zuTipSig !== html) { updNoteTip.innerHTML = html; updNoteTip.__zuTipSig = html; }   // 签名幂等：滚动位不因重画丢失
    placeUpdNoteTip();
  }
  function showUpdNoteTip(el) {
    if (stale() || !el || !el.isConnected) { hideUpdNoteTip(); return; }
    cancelUpdNoteHide();   // 离开后 220ms 内重入（快速往返/多实例齿轮切换）：取消在途收起，防刚显即闪没
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    updNoteTip.classList.toggle("zu-light", !dark);
    updNoteTipFor = el;
    updNoteTip.style.display = "flex";
    renderUpdNoteTip();
  }
  function scheduleUpdNoteHide() {
    if (state.devKeepTip) return;   // 开发者常驻开关：不自动收，仅 Escape 手动关
    if (unHideTimer) clearTimeout(unHideTimer);
    unHideTimer = setTimeout(function () { unHideTimer = 0; hideUpdNoteTip(); }, UN_HIDE_DELAY_MS);
  }
  function cancelUpdNoteHide() {
    if (unHideTimer) { clearTimeout(unHideTimer); unHideTimer = 0; }
  }
  function hideUpdNoteTip() {
    cancelUpdNoteHide();
    updNoteTip.style.display = "none";
    updNoteTipFor = null;
  }
  updNoteTip.addEventListener("mouseenter", cancelUpdNoteHide);
  updNoteTip.addEventListener("mouseleave", scheduleUpdNoteHide);
  updNoteTip.addEventListener("keydown", function (e) { if (e.key === "Escape") hideUpdNoteTip(); });
  updNoteTip.addEventListener("click", function (e) {
    var lnk = e.target && e.target.closest && e.target.closest(".zu-notes-lnk");
    if (!lnk) return;
    var url = lnk.getAttribute("data-href") || "";
    if (/^https:\/\//.test(url) && url.length <= 600) {   // 双重校验：渲染时已过滤，点击再验一次（与 ⚙ 面板同款）
      var zn = window.zcode;
      if (zn && typeof zn.openExternal === "function") zn.openExternal(url);
      else window.open(url, "_blank", "noopener");
    }
  });
  /* ---------- 自绘确认弹框（zu-compact-dlg 同款外壳）：overlay 内确认类交互统一走它，
   * 不用 window.confirm（原生框样式不可控、英文按钮与宿主视觉割裂，2026-11-15 用户拍板）。
   * 复用压缩确认弹框全套类（遮罩/卡片/按钮/动画/减动效），零新增样式；规则见 overlay-ui.md。 */
  function zuConfirm(title, desc, okText, onOk) {
    var dlg = document.createElement("div");
    dlg.className = "zu-compact-dlg";
    var card = document.createElement("div");
    card.className = "zu-compact-card";
    var t = document.createElement("div");
    t.className = "zu-compact-title";
    t.textContent = title;
    var d = document.createElement("div");
    d.className = "zu-compact-desc";
    d.textContent = desc;
    var foot = document.createElement("div");
    foot.className = "zu-compact-foot";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "zu-compact-cancel";
    cancel.textContent = L("取消", "Cancel");
    var ok = document.createElement("button");
    ok.type = "button";
    ok.className = "zu-compact-ok";
    ok.textContent = okText;
    function close() {
      document.removeEventListener("keydown", key, true);
      try { if (dlg.parentElement) dlg.remove(); } catch (e) { }
    }
    function key(e) {
      if (stale()) { document.removeEventListener("keydown", key, true); return; }   // 热更后旧代不再吞宿主按键
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Enter") {
        var f = null;
        try { f = document.activeElement; } catch (e2) { }
        if (f && dlg.contains && !dlg.contains(f)) return;   // 焦点已逸出弹框：不劫持宿主 Enter（同压缩弹框协议）
        e.preventDefault(); e.stopPropagation(); ok.click();
      }
    }
    cancel.addEventListener("click", close);
    dlg.addEventListener("mousedown", function (e) { if (e.target === dlg) close(); });   // 点遮罩关闭（卡片内点击不关）
    ok.addEventListener("click", function () { close(); onOk(); });
    document.addEventListener("keydown", key, true);
    foot.appendChild(cancel);
    foot.appendChild(ok);
    card.appendChild(t);
    card.appendChild(d);
    card.appendChild(foot);
    dlg.appendChild(card);
    document.body.appendChild(dlg);
    try { ok.focus(); } catch (e) { }
  }
  /* 打开提示词增强设置分区：panel/gear/activateSettingsSec 都是 spawnInstance 闭包私有，
   * 本层（文档级壳）直接引用会 ReferenceError 且被事件分发吞掉——v350 起两个「设置」入口
   * 在真实页面静默失效而 VM 切片全绿（ctx 桩注入了同名绑定，v417 修）。沿入口按钮上实例侧
   * 挂的 __zuOpenEnhSettings 钩子分发（chip.__zuOpenSub 先例）；全量历史面板的设置入口在
   * tip 已收时用打开面板那一刻记录的入口。 */
  function openEnhanceSettings() {
    var entry = enhanceTipFor;   // 先取入口再收 tip：hideEnhanceTip 会清 enhanceTipFor
    hideEnhanceTip();
    closeEnhanceHistoryFull();
    var fn = entry && typeof entry.__zuOpenEnhSettings === "function" ? entry.__zuOpenEnhSettings : null;
    if (!fn && ehFull && typeof ehFull.__zuOpenEnhSettings === "function") fn = ehFull.__zuOpenEnhSettings;
    if (fn) fn();
  }
  /* ---------- 查看全部历史浮层 ---------- */
  var ehFull = null, ehFullCache = null, ehFullSource = "all", ehFullQuery = "", ehFullPage = 0, ehFullPageSize = 20, ehFullSortField = "createdAt", ehFullSortDir = -1, ehFullProvider = "", ehFullModel = "", ehFullTime = "all", ehExpandedId = null;
  var ehFullResizeTimer = 0, ehFullSearchTimer = 0, ehFullSearchHold = false;
  function ehFullOnResize() {   // 面板打开期间跟随窗口宽度重排版（列合并/裁剪按面板实际宽度，debounce 150ms）
    if (ehFullResizeTimer) clearTimeout(ehFullResizeTimer);
    ehFullResizeTimer = setTimeout(function () {
      ehFullResizeTimer = 0;
      if (stale()) { window.removeEventListener("resize", ehFullOnResize); return; }   // 热更后代际自卫，不在游离节点重建
      if (ehFull && ehFull.style.display !== "none") renderEnhanceHistoryFull(false);
    }, 150);
  }
  function openEnhanceHistoryFull() {
    if (!ehFull) {
      ehFull = document.createElement("div");
      ehFull.className = "tip zusage-quota-tip zusage-enhance-full";
      ehFull.style.cssText = enhanceTip.style.cssText;
      ehFull.style.position = "fixed";
      ehFull.style.bottom = "auto";   // 小浮层 cssText 带动态 bottom，不清掉会把 fixed 面板高度压死
      ehFull.style.width = "min(1200px,calc(100vw - 32px))";
      ehFull.style.height = "auto";
      ehFull.style.minHeight = "60vh";   // 面板最低取窗体高度 60%（用户口径），数据多时仍向上滚动
      ehFull.style.maxHeight = "min(85dvh,760px)";   // 数据少时内容撑开不出现超需空白，多时表区独立滚动
      ehFull.style.display = "none";
      ehFull.style.left = "50%";
      ehFull.style.top = "50%";
      ehFull.style.transform = "translate(-50%,-50%)";
      document.body.appendChild(ehFull);
    }
    ehFull.style.display = "flex";
    if (enhanceTipFor && enhanceTipFor.__zuOpenEnhSettings) ehFull.__zuOpenEnhSettings = enhanceTipFor.__zuOpenEnhSettings;   // v417：面板内设置按钮按打开时的入口分发（此后 tip 随 mouseleave 已收）
    renderEnhanceHistoryFull(true);
    document.addEventListener("keydown", ehFullKeydown, true);
    window.addEventListener("resize", ehFullOnResize);
  }
  function closeEnhanceHistoryFull() {
    if (ehFull) ehFull.style.display = "none";
    ehExpandedId = null;
    if (ehFullResizeTimer) { clearTimeout(ehFullResizeTimer); ehFullResizeTimer = 0; }
    if (ehFullSearchTimer) { clearTimeout(ehFullSearchTimer); ehFullSearchTimer = 0; }
    ehFullSearchHold = false;   // 组合中关面板：不依赖宿主取消组合必派 compositionend 的兜底复位
    document.removeEventListener("keydown", ehFullKeydown, true);
    window.removeEventListener("resize", ehFullOnResize);
  }
  function ehFullKeydown(e) {
    if (stale()) { document.removeEventListener("keydown", ehFullKeydown, true); window.removeEventListener("resize", ehFullOnResize); return; }   // 热更后旧代 Escape 不再吞宿主事件
    if (e.key === "Escape") { e.stopPropagation(); closeEnhanceHistoryFull(); }
  }
  function ehFullFiltered() {
    var all = (ehFullCache && ehFullCache.records || []).slice();
    if (ehFullSource !== "all") all = all.filter(function (r) { return r.source === ehFullSource; });
    if (ehFullProvider) all = all.filter(function (r) { return r.providerName === ehFullProvider; });
    if (ehFullModel) all = all.filter(function (r) { return r.modelId === ehFullModel; });
    if (ehFullTime !== "all") {
      var now = Date.now(), cutoff = 0;
      if (ehFullTime === "today") { var d = new Date(); d.setHours(0,0,0,0); cutoff = d.getTime(); }
      else if (ehFullTime === "week") cutoff = now - 7 * 86400000;
      else if (ehFullTime === "month") { var m = new Date(); m.setDate(1); m.setHours(0,0,0,0); cutoff = m.getTime(); }
      all = all.filter(function (r) { var t = Date.parse(r.createdAt || ""); return t && t >= cutoff; });
    }
    if (ehFullQuery) {
      var q = ehFullQuery.toLowerCase();
      all = all.filter(function (r) { return (String(r.originalText) + String(r.enhancedText) + String(r.providerName) + String(r.modelId)).toLowerCase().indexOf(q) >= 0; });
    }
    var field = ehFullSortField, dir = ehFullSortDir;
    all.sort(function (a, b2) {
      var va, vb;
      if (field === "totalTokens") { va = a.usage && a.usage.totalTokens; vb = b2.usage && b2.usage.totalTokens; if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1; return (va - vb) * dir; }
      if (field === "durationMs") { va = a.durationMs; vb = b2.durationMs; if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1; return (va - vb) * dir; }
      va = Date.parse(a.createdAt || ""); vb = Date.parse(b2.createdAt || "");
      if (!isFinite(va) && !isFinite(vb)) return 0; if (!isFinite(va)) return 1; if (!isFinite(vb)) return -1;
      return (va - vb) * dir;
    });
    return all;
  }
  function ehSortArrow(field) {
    if (ehFullSortField !== field) return "";
    return ehFullSortDir === -1 ? ' <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>' : ' <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
  }
  function renderEnhanceHistoryFull(refetch) {
    var build = function () {
      ehFullSearchHold = false;   // 任何 build 都意味着旧搜索框即将销毁：复位 hold，防组合中重建后宿主未派 compositionend 卡真、拦死后续纯 ASCII 输入
      var all = ehFullFiltered();
      var totalPages = Math.max(1, Math.ceil(all.length / ehFullPageSize));
      if (ehFullPage >= totalPages) ehFullPage = totalPages - 1;
      var start = ehFullPage * ehFullPageSize;
      var pageRecs = all.slice(start, start + ehFullPageSize);
      var panelW = ehFull.clientWidth || Math.min(1200, window.innerWidth - 32);
      var med = panelW < 900, narrow = panelW < 640;   // 中屏合并供应商/模型列，窄屏再隐摘要列
      var colN = narrow ? 7 : (med ? 9 : 10);
      var sortBtn = function (label, field, cls) {
        return '<th class="zu-eh-th ' + cls + '" data-sort="' + field + '" scope="col" aria-sort="' + (ehFullSortField === field ? (ehFullSortDir === -1 ? "descending" : "ascending") : "none") + '">' + label + ehSortArrow(field) + '</th>';
      };
      /* 表头与数据行共用一套 colgroup 列宽（table-layout:fixed 下第一行/colgroup 决定列宽） */
      var colgroup = narrow
        ? '<colgroup><col style="width:32px"><col style="width:56px"><col style="width:26%"><col style="width:12%"><col style="width:9%"><col style="width:15%"><col style="width:64px"></colgroup>'
        : med
          ? '<colgroup><col style="width:32px"><col style="width:56px"><col style="width:24%"><col style="width:17%"><col style="width:20%"><col style="width:8%"><col style="width:7%"><col style="width:12%"><col style="width:64px"></colgroup>'
          : '<colgroup><col style="width:32px"><col style="width:56px"><col style="width:11%"><col style="width:13%"><col style="width:17%"><col style="width:19%"><col style="width:7%"><col style="width:6%"><col style="width:11%"><col style="width:64px"></colgroup>';
      var thead = '<tr class="zu-eh-tr-head">' +
        '<th class="zu-eh-th zu-eh-th-chev" scope="col"></th>' +
        '<th class="zu-eh-th zu-eh-th-src" scope="col">' + L("来源", "Source") + '</th>' +
        (med || narrow
          ? sortBtn(L("供应商 / 模型", "Provider / model"), "providerName", "zu-eh-th-prov")
          : sortBtn(L("供应商", "Provider"), "providerName", "zu-eh-th-prov") + sortBtn(L("模型", "Model"), "modelId", "zu-eh-th-model")) +
        (narrow ? "" :
          '<th class="zu-eh-th zu-eh-th-orig" scope="col">' + L("原文摘要", "Original") + '</th>' +
          '<th class="zu-eh-th zu-eh-th-enh" scope="col">' + L("增强摘要", "Enhanced") + '</th>') +
        sortBtn("Token", "totalTokens", "zu-eh-th-num") +
        sortBtn(L("耗时", "Duration"), "durationMs", "zu-eh-th-num") +
        sortBtn(L("时间", "Time"), "createdAt", "zu-eh-th-time") +
        '<th class="zu-eh-th zu-eh-th-ops" scope="col">' + L("操作", "Actions") + '</th></tr>';
      var rows = "";
      for (var i = 0; i < pageRecs.length; i++) {
        var r = pageRecs[i];
        var expanded = ehExpandedId === r.id;
        var tok = r.usage && Number.isFinite(r.usage.totalTokens) ? r.usage.totalTokens.toLocaleString() : "—";
        var dur = Number.isFinite(r.durationMs) && r.durationMs > 0 ? ehFmtDur(r.durationMs) : "—";
        var src = r.source === "test" ? L("测试", "test") : L("聊天", "chat");
        var provId = String(r.providerName || "");
        var provTxt = ehProvLabel(provId) || L("未知供应商", "Unknown provider");
        var modelTxt = r.modelId || L("未知模型", "Unknown model");
        var provCell = med || narrow
          ? '<td class="zu-eh-td zu-eh-td-prov"><span class="zu-eh-cell-text" title="' + ehEsc(provId) + '">' + ehEsc(provTxt) + '<span class="zu-eh-prov-sep"> / </span><span title="' + ehEsc(r.modelId) + '">' + ehEsc(modelTxt) + '</span></span></td>'
          : '<td class="zu-eh-td zu-eh-td-prov"><span class="zu-eh-cell-text" title="' + ehEsc(provId) + '">' + ehEsc(provTxt) + '</span></td>' +
            '<td class="zu-eh-td zu-eh-td-model"><span class="zu-eh-cell-text" title="' + ehEsc(r.modelId) + '">' + ehEsc(modelTxt) + '</span></td>';
        var sumCells = narrow ? "" :
          '<td class="zu-eh-td"><span class="zu-eh-cell-text" title="' + ehEsc(r.originalText || "") + '">' + ehEsc(r.originalText || "") + '</span></td>' +
          '<td class="zu-eh-td"><span class="zu-eh-cell-text" title="' + ehEsc(r.enhancedText || "") + '">' + ehEsc(r.enhancedText || "") + '</span></td>';
        rows += '<tr class="zu-eh-row' + (expanded ? " zu-eh-open" : "") + '" data-id="' + ehEsc(r.id) + '" aria-expanded="' + (expanded ? "true" : "false") + '">' +
          '<td class="zu-eh-td zu-eh-td-chev"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:rotate(' + (expanded ? "90" : "0") + 'deg);transition:transform .15s"><path d="m9 18 6-6-6-6"/></svg></td>' +
          '<td class="zu-eh-td zu-eh-td-src">' + ehEsc(src) + '</td>' +
          provCell + sumCells +
          '<td class="zu-eh-td zu-eh-td-num">' + tok + '</td>' +
          '<td class="zu-eh-td zu-eh-td-num">' + dur + '</td>' +
          '<td class="zu-eh-td zu-eh-td-time">' + ehEsc(ehFmtWhen(r.createdAt)) + '</td>' +
          '<td class="zu-eh-td zu-eh-td-ops">' +
          '<button type="button" class="zu-eh-row-copy" data-copy-enh aria-label="' + L("复制增强结果", "Copy enhanced") + '">' + EH_ICON.copy + '</button>' +
          '<button type="button" class="zu-eh-row-del" data-del aria-label="' + L("删除", "Delete") + '">' + EH_ICON.trash + '</button></td></tr>';
        if (expanded) {
          rows += '<tr class="zu-eh-detail-row"><td colspan="' + colN + '"><div class="zu-eh-detail">' +
            '<div class="zu-eh-d-meta"><div class="zu-eh-d-pair"><div class="zu-eh-d-k">' + L("供应商", "Provider") + '</div><div class="zu-eh-d-wrap" title="' + ehEsc(provId) + '">' + ehEsc(provTxt) + '</div></div><div class="zu-eh-d-pair"><div class="zu-eh-d-k">' + L("模型", "Model") + '</div><div class="zu-eh-d-wrap">' + ehEsc(modelTxt) + '</div></div></div>' +
            '<div class="zu-eh-d-text"><div class="zu-eh-d-h">' + EH_ICON.doc + L("原始提示词", "Original prompt") + '<button type="button" class="zu-eh-row-copy" data-copy-orig aria-label="' + L("复制原文", "Copy original") + '">' + EH_ICON.copy + '</button></div><div class="zu-eh-d-body">' + ehEsc(r.originalText || "") + '</div></div>' +
            '<div class="zu-eh-d-text zu-eh-d-enh"><div class="zu-eh-d-h">' + EH_ICON.spark + L("增强后的提示词", "Enhanced prompt") + '<button type="button" class="zu-eh-row-copy" data-copy-enh2 aria-label="' + L("复制增强结果", "Copy enhanced") + '">' + EH_ICON.copy + '</button></div><div class="zu-eh-d-body">' + ehEsc(r.enhancedText || "") + '</div></div>' +
            '<div class="zu-eh-d-inline"><div class="zu-eh-d-pair"><div class="zu-eh-d-k">' + L("来源", "Source") + '</div><div>' + ehEsc(src) + '</div></div><div class="zu-eh-d-pair"><div class="zu-eh-d-k">Token</div><div>' + tok + '</div></div><div class="zu-eh-d-pair"><div class="zu-eh-d-k">' + L("时间", "Time") + '</div><div>' + (ehEsc(ehFmtFull(r.createdAt)) || "—") + '</div></div><div class="zu-eh-d-pair"><div class="zu-eh-d-k">' + L("耗时", "Duration") + '</div><div>' + dur + '</div></div></div>' +
            '</div></td></tr>';
        }
      }
      if (!pageRecs.length) rows = '<tr><td colspan="' + colN + '" class="zu-eh-empty">' + (ehFullQuery || ehFullSource !== "all" || ehFullProvider || ehFullModel || ehFullTime !== "all" ? L("没有匹配的记录", "No matching records") : EH_ICON.empty + '<div>' + L("暂无增强历史", "No enhancement history yet") + '</div><small>' + L("成功增强提示词后，记录会显示在这里。", "Records appear here after a successful enhancement.") + "</small>") + '</td></tr>';
      var pageBtns = "";
      if (totalPages > 7) {
        pageBtns += '<button type="button" class="zu-eh-pg-btn" data-page="0" ' + (ehFullPage === 0 ? "disabled" : "") + '>‹</button>';
        for (var pg = 0; pg < totalPages; pg++) {
          if (pg > 2 && pg < totalPages - 2 && Math.abs(pg - ehFullPage) > 1) { if (pg === 3) pageBtns += '<span class="zu-eh-pg-ellipsis">…</span>'; continue; }
          pageBtns += '<button type="button" class="zu-eh-pg-btn' + (pg === ehFullPage ? " zu-eh-pg-cur" : "") + '" data-page="' + pg + '">' + (pg + 1) + '</button>';
        }
        pageBtns += '<button type="button" class="zu-eh-pg-btn" data-page="' + (totalPages - 1) + '" ' + (ehFullPage === totalPages - 1 ? "disabled" : "") + '>›</button>';
      } else {
        for (var pg2 = 0; pg2 < totalPages; pg2++) pageBtns += '<button type="button" class="zu-eh-pg-btn' + (pg2 === ehFullPage ? " zu-eh-pg-cur" : "") + '" data-page="' + pg2 + '">' + (pg2 + 1) + '</button>';
      }
      var sizeOpts = [20, 50, 100].map(function (n) { return '<option value="' + n + '"' + (ehFullPageSize === n ? " selected" : "") + ">" + n + "</option>"; }).join("");
      var providerOpts = '<option value="">' + L("全部供应商", "All providers") + "</option>";
      var provSet = {};
      (ehFullCache && ehFullCache.records || []).forEach(function (r) { if (r.providerName && !provSet[r.providerName]) { provSet[r.providerName] = 1; providerOpts += '<option value="' + ehEsc(r.providerName) + '"' + (ehFullProvider === r.providerName ? " selected" : "") + ">" + ehEsc(ehProvLabel(r.providerName)) + "</option>"; } });
      var modelOpts = '<option value="">' + L("全部模型", "All models") + "</option>";
      var modelSet = {};
      (ehFullCache && ehFullCache.records || []).forEach(function (r) { if (ehFullProvider && r.providerName !== ehFullProvider) return; if (r.modelId && !modelSet[r.modelId]) { modelSet[r.modelId] = 1; modelOpts += '<option value="' + ehEsc(r.modelId) + '"' + (ehFullModel === r.modelId ? " selected" : "") + ">" + ehEsc(r.modelId) + "</option>"; } });
      var timeOpts = [["all", L("全部时间", "All time")], ["today", L("今天", "Today")], ["week", L("近 7 天", "Last 7 days")], ["month", L("本月", "This month")]].map(function (t) { return '<option value="' + t[0] + '"' + (ehFullTime === t[0] ? " selected" : "") + ">" + t[1] + "</option>"; }).join("");
      var srcOpts = [["all", L("全部来源", "All sources")], ["chat", L("聊天", "Chat")], ["test", L("测试", "Test")]].map(function (t) { return '<option value="' + t[0] + '"' + (ehFullSource === t[0] ? " selected" : "") + ">" + t[1] + "</option>"; }).join("");
      var searchVal = ehEsc(ehFullQuery);
      var footer = totalPages > 1
        ? '<div class="zu-eh-pagination"><span class="zu-eh-pg-size"><select class="zu-eh-filter zu-eh-pgsize" data-f="pagesize" aria-label="' + L("每页条数", "Rows per page") + '">' + sizeOpts + '</select> ' + L("条/页", "per page") + '</span><span>' + L("第", "Page ") + (ehFullPage + 1) + "/" + totalPages + L(" 页 · 共 ", " of ") + all.length + L(" 条", "") + '</span><span class="zu-eh-pg-btns">' + pageBtns + '</span></div>'
        : "";   // 单页/空态不渲染分页页脚（Header 已有总数，避免大面积空白与冗余控件）
      /* 重建销毁聚焦中的搜索框：记录焦点与光标，重建后恢复（连续输入/IME 不因翻页筛选打断） */
      var searchFocus = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("zu-eh-search") ? document.activeElement : null;
      var searchCaret = searchFocus && typeof searchFocus.selectionStart === "number" ? searchFocus.selectionStart : -1;
      ehFull.innerHTML = '<div class="zu-eh-full-head"><div class="zu-eh-head-l"><span class="zu-eh-title">' + EH_ICON.history + L("增强历史", "Enhancement history") + '</span><span class="zu-eh-total">' + L("共 ", "total ") + all.length + L(" 条", "") + '</span></div>' +
        '<div class="zu-eh-head-r"><button type="button" class="zu-eh-cfg" data-ehset>' + EH_ICON.gear + L("设置", "Settings") + '</button><button type="button" class="zu-eh-act zu-eh-clear" data-clear>' + EH_ICON.trash + L("清空记录", "Clear all") + '</button><button type="button" class="zu-eh-close" data-close aria-label="' + L("关闭", "Close") + '">' + EH_ICON.close + '</button></div></div>' +
        '<div class="zu-eh-full-filter"><div class="zu-eh-searchbox">' + EH_ICON.search + '<input class="zu-eh-search" type="search" placeholder="' + L("搜索原文、增强结果、模型或供应商", "Search texts, model or provider") + '" value="' + searchVal + '" aria-label="' + L("搜索历史记录", "Search history") + '"></div>' +
        '<select class="zu-eh-filter zu-eh-f-src" data-f="source" aria-label="' + L("来源筛选", "Source filter") + '">' + srcOpts + '</select>' +
        '<select class="zu-eh-filter zu-eh-f-prov" data-f="provider" aria-label="' + L("供应商筛选", "Provider filter") + '">' + providerOpts + '</select>' +
        '<select class="zu-eh-filter zu-eh-f-model" data-f="model" aria-label="' + L("模型筛选", "Model filter") + '">' + modelOpts + '</select>' +
        '<select class="zu-eh-filter zu-eh-f-time" data-f="time" aria-label="' + L("时间筛选", "Time filter") + '">' + timeOpts + '</select></div>' +
        '<div class="zu-eh-table-wrap"><table class="zu-eh-table">' + colgroup + '<thead>' + thead + '</thead><tbody>' + rows + '</tbody></table></div>' + footer;
      if (searchFocus) {
        var searchEl = ehFull.querySelector(".zu-eh-search");
        if (searchEl) {
          searchEl.focus();
          try { if (searchCaret >= 0) searchEl.setSelectionRange(searchCaret, searchCaret); } catch (e) { }
        }
      }
    };
    if (refetch || !ehFullCache) {
      if (!ehFullCache) ehFull.innerHTML = '<div class="zu-eh-empty" style="padding:40px 16px;text-align:center;color:var(--color-foreground-subtle,#999)">' + L("正在读取历史…", "Loading history…") + '</div>';   // 首开占位，避免 IPC 往返前闪白
      pluginRequest("enhance-history-list", { limit: 100 }, function (res) {
        if (res && res.ok && Array.isArray(res.records)) ehFullCache = res;
        build();
      });
    } else build();
    ehFull.onchange = function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute || !t.hasAttribute("data-f")) return;
      var f = t.getAttribute("data-f");
      if (f === "pagesize") ehFullPageSize = parseInt(t.value) || 20;
      else if (f === "source") ehFullSource = t.value;
      else if (f === "provider") { ehFullProvider = t.value; ehFullModel = ""; }
      else if (f === "model") ehFullModel = t.value;
      else if (f === "time") ehFullTime = t.value;
      ehFullPage = 0; ehExpandedId = null;
      build();
    };
    ehFull.oninput = function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("zu-eh-search")) {
        /* IME 组合期间不重建：build 整面板 innerHTML 会销毁输入框，强制取消拼音组合并把
         * 焦点打回 body（中文输入停顿 ≥200ms 即触发）；组合结束经 compositionend 再刷新。 */
        if (e.isComposing || ehFullSearchHold) return;
        if (ehFullSearchTimer) clearTimeout(ehFullSearchTimer);
        ehFullSearchTimer = setTimeout(function () { ehFullSearchTimer = 0; ehFullQuery = e.target.value; ehFullPage = 0; ehExpandedId = null; build(); }, 200);
      }
    };
    /* compositionstart/end 挂面板（委托）：搜索框随每次 build 重建，直接挂会被换掉 */
    ehFull.oncompositionstart = function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("zu-eh-search")) {
        if (ehFullSearchTimer) { clearTimeout(ehFullSearchTimer); ehFullSearchTimer = 0; }   // ASCII 输入 200ms 内切入组合：撤销待触发的重建，防组合中被销毁
        ehFullSearchHold = true;
      }
    };
    ehFull.oncompositionend = function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("zu-eh-search")) {
        ehFullSearchHold = false;
        if (ehFullSearchTimer) clearTimeout(ehFullSearchTimer);
        var input = e.target;
        ehFullSearchTimer = setTimeout(function () { ehFullSearchTimer = 0; ehFullQuery = input.value; ehFullPage = 0; ehExpandedId = null; build(); }, 200);
      }
    };
    ehFull.onclick = function (e) {
      /* 排序列不是 button，必须在 button 判空之前拦截（否则永远不可达） */
      var th = e.target && e.target.closest && e.target.closest("[data-sort]");
      if (th && th.hasAttribute("data-sort")) {
        var f = th.getAttribute("data-sort");
        if (ehFullSortField === f) ehFullSortDir = -ehFullSortDir;
        else { ehFullSortField = f; ehFullSortDir = -1; }
        build(); return;
      }
      var btn = e.target && e.target.closest && e.target.closest("button");
      if (!btn) {
        var rowEl = e.target && e.target.closest && e.target.closest(".zu-eh-row");
        if (rowEl) { ehExpandedId = ehExpandedId === rowEl.getAttribute("data-id") ? null : rowEl.getAttribute("data-id"); build(); }
        else if (e.target === ehFull) closeEnhanceHistoryFull();
        return;
      }
      if (btn.hasAttribute("data-close")) { closeEnhanceHistoryFull(); return; }
      if (btn.hasAttribute("data-ehset")) { openEnhanceSettings(); return; }
      if (btn.hasAttribute("data-page")) { ehFullPage = parseInt(btn.getAttribute("data-page")) || 0; build(); return; }
      if (btn.hasAttribute("data-clear")) {
        zuConfirm(L("清空增强历史", "Clear enhancement history"), L("确定清空全部增强历史吗？此操作无法撤销。", "Clear all enhancement history? This cannot be undone."), L("清空", "Clear"), function () {
          pluginRequest("enhance-history-clear", {}, function () { ehFullCache = null; ehCache = null; ehFullPage = 0; ehExpandedId = null; build(); });
        });
        return;
      }
      if (btn.hasAttribute("data-del")) {
        e.stopPropagation();
        var drow = btn.closest(".zu-eh-row");
        if (!drow) return;
        var did = drow.getAttribute("data-id");
        zuConfirm(L("删除记录", "Delete record"), L("确定删除这条增强记录？删除后无法恢复。", "Delete this enhancement record? This cannot be undone."), L("删除", "Delete"), function () {
          pluginRequest("enhance-history-delete", { id: did }, function (res) {
            if (!res || !res.ok) return;   // 删除失败不清表
            if (ehFullCache && ehFullCache.records) {   // 从缓存就地滤除并保持下拉一致，不清空整表
              ehFullCache.records = ehFullCache.records.filter(function (r) { return r.id !== did; });
              if (ehFullCache.total != null) ehFullCache.total = Math.max(0, (ehFullCache.total || 0) - 1);
            }
            ehCacheAt = 0;   // 小浮层缓存同样失效
            if (ehExpandedId === did) ehExpandedId = null;
            build();
          });
        });
        return;
      }
      if (btn.classList.contains("zu-eh-row-copy")) {
        e.stopPropagation();
        /* 行内按钮 closest 行取 id；详情行按钮经 detail-row 的前一行（同一条记录）取 id，不按行号 */
        var prow = btn.closest(".zu-eh-row") || (btn.closest(".zu-eh-detail-row") && btn.closest(".zu-eh-detail-row").previousElementSibling);
        var pid = prow ? prow.getAttribute("data-id") : null;
        var prec = (ehFullCache && ehFullCache.records || []).find(function (r) { return r.id === pid; });
        var text = btn.hasAttribute("data-copy-orig") ? (prec && prec.originalText || "") : (prec && prec.enhancedText || "");
        var done = function () { var old = btn.innerHTML; btn.innerHTML = EH_ICON.check; setTimeout(function () { btn.innerHTML = old; }, 900); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
        else done();
      }
    };
  }

  /* ---------- v202 预估费用说明小气泡（费用行 ? 图标悬停）：rstTip 同款浮层/悬停桥。
   * 内容三行：价格来源（models.dev）/ 计算公式（本库口径）/ 汇率来源（快照 fx.source，
   * 无汇率标 USD 原值显示）。监听在各实例 tip 本体 mouseover/out 委托（innerHTML 重建不丢）。 */
  var FXQ_ICON = '<svg class="tip-fxq" viewBox="0 0 1024 1024" width="13" height="13" fill="currentColor" style="display:inline;vertical-align:-2px;margin-left:5px;cursor:help" aria-label="?" role="img" xmlns="http://www.w3.org/2000/svg"><path d="M480 784a48 48 0 1 1 96 0 48 48 0 0 1-96 0z m74.432-158.144a32 32 0 1 1-64 0v-62.816a32 32 0 0 1 32-32c64.96 0 117.568-60.576 117.568-125.472a117.568 117.568 0 0 0-235.104 0 32 32 0 1 1-64 0 181.568 181.568 0 0 1 363.104 0c0 89.344-64.544 171.52-149.568 186.656v33.6z"/><path d="M512 992C246.912 992 32 777.088 32 512 32 246.912 246.912 32 512 32c265.088 0 480 214.912 480 480 0 265.088-214.912 480-480 480z m0-64c229.76 0 416-186.24 416-416S741.76 96 512 96 96 282.24 96 512s186.24 416 416 416z"/></svg>';
  var fxTip = document.createElement("div");
  fxTip.className = "tip zusage-quota-tip zusage-fx-tip";
  fxTip.style.cssText = rateTip.style.cssText;
  fxTip.style.zIndex = "2147483647";   // 主 tip 2147483646 且 DOM 在后：同层会被盖（实测），压一级
  fxTip.style.maxWidth = "380px";
  document.body.appendChild(fxTip);
  var FX_HIDE_DELAY_MS = 180;
  var fxHideTimer = 0;
  function scheduleFxHide() {
    if (fxHideTimer) return;
    fxHideTimer = setTimeout(function () { fxHideTimer = 0; hideFxTip(); }, FX_HIDE_DELAY_MS);
  }
  function cancelFxHide() {
    if (fxHideTimer) { clearTimeout(fxHideTimer); fxHideTimer = 0; }
  }
  fxTip.addEventListener("mouseenter", cancelFxHide);
  fxTip.addEventListener("mouseleave", scheduleFxHide);
  /* 气泡内来源链接（下划线）点击打开浏览器：客户端 openExternal 桥，无桥 window.open 兜底 */
  fxTip.addEventListener("click", function (e) {
    var a = e.target && e.target.closest && e.target.closest(".fx-link");
    if (!a) return;
    e.stopPropagation();
    var url = a.getAttribute("data-url");
    if (!url) return;
    var zc = window.zcode;
    if (zc && typeof zc.openExternal === "function") zc.openExternal(url);
    else window.open(url, "_blank", "noopener");
  });
  function fxTipHTML(info) {
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function link(text, url) {
      return '<span class="fx-link" role="link" tabindex="0" data-url="' + esc(url) + '" style="text-decoration:underline;cursor:pointer">' + esc(text) + "</span>";
    }
    var fx = state.data && state.data.fx;
    var rate = (fx && typeof fx.rate === "number" && isFinite(fx.rate) && fx.rate > 0) ? fx.rate : 0;
    /* 牌价随汇率折 ¥ 显示（用户口径：气泡内货币一律人民币）；无有效汇率诚实降级 USD 原值 */
    function money(n) {
      return rate > 0 ? "¥" + (n * rate).toFixed(2) : "$" + (Math.round(n * 10000) / 10000);
    }
    var unitTag = rate > 0
      ? L("（¥/百万 token，按实时汇率折算）", " (¥ per million tokens, converted at the live rate)")
      : L("（USD/百万 token）", " (USD per million tokens)");
    /* v248：模型行只来自 icon 随卡携带的上下文（data-model/data-rates/data-mcount/
     * data-mscope）。旧 default 分支借快照根部 last=全局最近活跃会话的模型，悬浮会话≠它
     * 时张冠李戴（issue：hy4 会话气泡显示 GLM-5.3-FlashX），已删；无上下文=不显模型行。 */
    var model, rates;
    if (info.type === "model") { model = info.model; rates = info.rates; }
    var modelRow = "";
    if (info.type === "project") {
      /* 项目卡语境：没有单一「当前模型」——显示计价范围（N 个模型按各自模型价格分别计价） */
      modelRow = '<div class="rt-row"><b>' + esc(L("计价范围", "Pricing scope")) + '</b><span>' +
        esc(L("项目累计的全部 " + info.count + " 个模型，按各自模型价格分别计价", "all " + info.count + " models of this project, each priced at its own model prices")) + '</span></div>';
    } else if (info.type === "scope") {
      /* 多模型卡（本轮/会话累计/今日合计/子代理汇总）同项目卡口径：计价范围。
       * scope 名词由生成端按卡本地化（data-mscope），这里只拼数量与口径。 */
      modelRow = '<div class="rt-row"><b>' + esc(L("计价范围", "Pricing scope")) + '</b><span>' +
        esc(info.scope + L("的全部 " + info.count + " 个模型，按各自模型价格分别计价", ": all " + info.count + " models, each priced at its own model prices")) + '</span></div>';
    } else if (model && rates && typeof rates.input === "number") {
      modelRow = '<div class="rt-row"><b>' + esc(info.type === "model" ? L("模型", "Model") : L("当前模型", "Current model")) + '</b><span><span class="zu-model-fit" style="display:inline-block;max-width:100%" title="' + esc(model) + '">' + esc(model) + '</span>' +
        '<span style="display:block;margin-top:2px">' +
        esc(L("输入 ", "in ") + money(rates.input) + L(" · 输出 ", " · out ") + money(rates.output) +
            L(" · 缓存读 ", " · cache read ") + money(rates.cache_read) + L(" · 缓存写 ", " · cache write ") + money(rates.cache_write)) +
        unitTag + "</span></span></div>";
    }
    var fxRow = (fx && fx.source)
      ? link(String(fx.source), "https://" + fx.source) + L(" 实时汇率 · ", " live rate · ") +
        "$1 = ¥" + (Math.round(rate * 10000) / 10000)
      : L("暂无汇率，费用按 USD 原值显示", "no live rate; cost shown in USD as-is");
    return '<div class="rt-h">' + esc(L("预估费用说明", "About estimated cost")) + "</div>" + modelRow +
      '<div class="rt-row"><b>' + esc(L("价格来源", "Prices")) + '</b><span>' +
        link("models.dev", "https://models.dev/") + L(" 三方 AI 模型数据库", " third-party AI model database") + "</span></div>" +
      '<div class="rt-row"><b>' + esc(L("计算公式", "How it's computed")) + '</b><span>' +
        esc(L("按每个模型的模型价格分开算输入、缓存读写和输出（模型价格为每百万 token 的美元数；输出已含思考）",
              "each model is priced separately for input, cache read/write and output (list prices are USD per million tokens; output already includes thinking)")) + "</span></div>" +
      '<div class="rt-row"><b>' + esc(L("汇率来源", "FX source")) + '</b><span>' + fxRow + "</span></div>";
  }
  function showFxTip(el, info) {
    if (stale()) { hideFxTip(); return; }
    var html = fxTipHTML(info || { type: "default" });
    if (fxTip.__zuTipSig !== html) {   // 签名幂等：悬停中泵推送不重建（同 rstTip）
      fxTip.innerHTML = html;
      fxTip.__zuTipSig = html;
    }
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    fxTip.classList.toggle("zu-light", !dark);
    fxTip.style.display = "block";
    if (typeof fitModelNames === "function") fitModelNames(fxTip);
    var r = el.getBoundingClientRect(), tw = fxTip.offsetWidth, th = fxTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    fxTip.style.left = Math.round(left) + "px";
    fxTip.style.top = Math.round(top) + "px";
  }
  function hideFxTip() {
    cancelFxHide();
    fxTip.style.display = "none";
  }
  /* ---------- v487 上下文容量弹层分项构成悬停说明（specs/context-breakdown-enhance.md） ----------
   * 文档级单例（.tip.zusage-quota-tip.zusage-ctx-bkd-tip），挂 body，z-index 2147483647
   * 压过 Radix hover-card；由弹层内分项行的 mouseover/mouseout 委托触发。 */
  var ctxBkdTip = document.createElement("div");
  ctxBkdTip.className = "tip zusage-quota-tip zusage-ctx-bkd-tip";
  ctxBkdTip.style.cssText = rateTip.style.cssText;
  ctxBkdTip.style.display = "none";
  ctxBkdTip.style.zIndex = "2147483647";
  ctxBkdTip.style.maxWidth = "380px";
  ctxBkdTip.style.minWidth = "280px";
  document.body.appendChild(ctxBkdTip);
  var ctxBkdTipFor = null;
  var ctxBkdHideTimer = 0;
  var ctxBkdHovered = false;
  function cancelCtxBkdHide() {
    if (ctxBkdHideTimer) { clearTimeout(ctxBkdHideTimer); ctxBkdHideTimer = 0; }
  }
  function scheduleCtxBkdHide() {
    if (ctxBkdHovered || ctxBkdHideTimer) return;
    ctxBkdHideTimer = setTimeout(function () { ctxBkdHideTimer = 0; if (!ctxBkdHovered) hideCtxBkdTip(); }, 350);
  }
  ctxBkdTip.addEventListener("mouseenter", function () { ctxBkdHovered = true; cancelCtxBkdHide(); });
  ctxBkdTip.addEventListener("mouseleave", function (e) {
    ctxBkdHovered = false;
    scheduleCtxBkdHide();
    var hc = ctxBkdTipFor && ctxBkdTipFor.closest ? ctxBkdTipFor.closest('[data-slot="hover-card-content"]') : null;
    var rt = e && e.relatedTarget;
    if (hc && hc.isConnected && (!rt || !hc.contains(rt))) {
      try {
        hc.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, cancelable: true, relatedTarget: rt || document.body }));
        hc.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, cancelable: true, relatedTarget: rt || document.body }));
      } catch (err) { }
    }
  });
  function stopCtxHcLeave(e) {
    if (ctxBkdTip.style.display === "none") return;
    var t = e && e.target, rt = e && e.relatedTarget;
    if (!t || !t.closest || !rt) return;
    var hc = t.closest('[data-slot="hover-card-content"]');
    if (!hc) return;
    if (rt === ctxBkdTip || ctxBkdTip.contains(rt)) e.stopPropagation();
  }
  function onCtxBkdDocDown(e) {
    if (ctxBkdTip.style.display === "none") return;
    if (ctxBkdTip.contains(e && e.target)) return;
    if (ctxBkdTipFor && !ctxBkdTipFor.isConnected && !ctxBkdHovered) hideCtxBkdTip();
  }
  document.addEventListener("pointerout", stopCtxHcLeave, true);
  document.addEventListener("mouseout", stopCtxHcLeave, true);
  document.addEventListener("pointerdown", onCtxBkdDocDown, true);
  ctxBkdTip.addEventListener("pointerdown", function (e) {
    var a = e.target && e.target.closest && e.target.closest(".cb-path");
    if (!a) return;
    e.stopPropagation();
    e.preventDefault();
    var p = a.getAttribute("data-cb-path");
    if (p && typeof openProjFolder === "function") openProjFolder(p);
  });
  var ZU_CTX_BKD_MAP = {
    "消息": "messages", "Messages": "messages",
    "其他": "meta_user_context", "Meta context": "meta_user_context",
    "系统工具": "system_tool_schemas", "System tools": "system_tool_schemas",
    "MCP 工具": "mcp_tool_schemas", "MCP tools": "mcp_tool_schemas",
    "技能": "skills", "Skills": "skills",
    "系统提示词": "system_prompt", "System prompt": "system_prompt",
    "工具提示词": "tool_prompt", "Tool prompt": "tool_prompt"
  };
  var ZU_CTX_BKD_TIPS = {
    messages: {
      title: ["消息", "Messages"],
      items: [
        [["对话正文", "Chat turns"], ["你发送的提问、粘贴的代码片段与 AI 回复内容", "Your prompts, pasted code snippets, and AI responses"]],
        [["工具结果", "Tool outputs"], ["读文件（Read）、搜索（Grep）、终端命令（Bash）等返回的文本输出", "Outputs returned by Read, Grep, Bash, and other tool calls"]],
        [["压缩摘要", "Compaction"], ["此前执行 /compact 生成的历史对话总结（若有）", "Prior conversation summaries generated by /compact (if any)"]]
      ],
      advice: ["占比过高时可点下方「压缩上下文」总结早期对话，或新开会话继续。",
               "When high, click Compact context below to summarize earlier turns, or start a new chat."]
    },
    meta_user_context: {
      title: ["其他", "Meta context"],
      items: [
        [["指令规则", "Instructions"], ["全局与项目 AGENTS.md 等规则文件内容", "Global and project AGENTS.md instruction files"]],
        [["记忆索引", "Memory index"], ["跨会话记忆与上下文前缀公告文本", "Cross-session memory and context-prefix announcements"]],
        [["系统提醒", "Reminders"], ["环境信息、日期、Git 分支与状态、Todo 待办、子代理列表等", "Environment info, date, Git status, todo list, sub-agent catalog, etc."]]
      ],
      advice: ["若此项偏大，通常是项目或全局 AGENTS.md 过长，可精简规则或拆分按需引用。",
               "If unusually large, check if your project or global AGENTS.md is verbose and trim it."]
    },
    system_tool_schemas: {
      title: ["系统工具", "System tools"],
      items: [
        [["内置工具", "Built-in tools"], ["文件读写、代码检索、终端执行等内置工具的参数 Schema", "Parameter schemas for built-in file, search, and shell tools"]],
        [["页面工具", "App tools"], ["浏览器/桌面交互等应用级工具定义（含延迟加载摘要）", "App-level tool definitions (including deferred tool summaries)"]]
      ],
      advice: ["系统工具为每轮请求固定开销，无需手动干预；窗口越大占比越低。",
               "System tools are fixed per-request overhead; no manual action needed."]
    },
    mcp_tool_schemas: {
      title: ["MCP 工具", "MCP tools"],
      items: [
        [["插件工具定义", "MCP schemas"], ["当前已启用的第三方 MCP 服务暴露的工具名称与参数说明", "Tool names and parameter schemas exposed by active MCP servers"]]
      ],
      advice: ["占比过高时，可在设置中关闭当前任务不需要的 MCP 服务以腾出空间。",
               "Disable unused MCP servers in settings if their tool schemas take too much space."]
    },
    skills: {
      title: ["技能", "Skills"],
      items: [
        [["技能目录", "Skill catalog"], ["已加载的 Skills 名称与触发描述（首发及增量公告）", "Loaded skill names and trigger descriptions"]]
      ],
      advice: ["仅包含技能摘要而非全文，通常占用很小；精简未使用的本地技能可略微降低。",
               "Only includes summaries rather than full skill files; usually small."]
    },
    system_prompt: {
      title: ["系统提示词", "System prompt"],
      items: [
        [["核心人设", "Core prompt"], ["ZCode 内置的基础指令、安全边界与工作流规范", "ZCode's built-in core instructions and workflow guidelines"]]
      ],
      advice: ["ZCode 官方固定指令，占用稳定且通常较小，无需手动调整。",
               "Fixed built-in ZCode system instructions; small and stable."]
    },
    tool_prompt: {
      title: ["工具提示词", "Tool prompt"],
      items: [
        [["调用规范", "Tool guidance"], ["指导模型如何正确选择与调用工具的专项说明", "Dedicated instructions guiding proper tool selection and invocation"]]
      ],
      advice: ["随工具配置自动注入的固定说明，一般占比较小。",
               "Automatically injected guidance paired with active tools; typically small."]
    }
  };
  var CTX_BKD_CSS =
    "<style>" +
    ".zusage-ctx-bkd-tip .cb-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:7px}" +
    ".zusage-ctx-bkd-tip .cb-title{font-weight:600;color:var(--color-tooltip-foreground,#fafafa)}" +
    ".zusage-ctx-bkd-tip .cb-pct{font-variant-numeric:tabular-nums;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
    ".zusage-ctx-bkd-tip .cb-metrics{display:grid;gap:3px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.045);margin-bottom:8px;font-variant-numeric:tabular-nums}" +
    ".zusage-ctx-bkd-tip.zu-light .cb-metrics{background:rgba(0,0,0,.04)}" +
    ".zusage-ctx-bkd-tip .cb-mrow{display:flex;justify-content:space-between;gap:10px;font-size:calc(var(--ui-font-size,14px) - 2px)}" +
    ".zusage-ctx-bkd-tip .cb-mk{color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
    ".zusage-ctx-bkd-tip .cb-mv{color:var(--color-tooltip-foreground,#fafafa);text-align:right}" +
    ".zusage-ctx-bkd-tip .cb-subh{font-weight:600;font-size:calc(var(--ui-font-size,14px) - 2px);color:var(--color-tooltip-foreground,#fafafa);margin:0 0 4px}" +
    ".zusage-ctx-bkd-tip .cb-list{display:grid;gap:3px;margin-bottom:8px}" +
    ".zusage-ctx-bkd-tip .cb-item{font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.45;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
    ".zusage-ctx-bkd-tip .cb-item b{color:var(--color-tooltip-foreground,#fafafa);font-weight:600;margin-right:4px}" +
    ".zusage-ctx-bkd-tip .cb-paths{display:flex;flex-wrap:wrap;gap:4px 8px;margin-top:3px;padding-left:10px}" +
    ".zusage-ctx-bkd-tip .cb-path{display:inline-flex;align-items:center;gap:3px;color:var(--color-brand,#57c7ff);cursor:pointer;text-decoration:underline;text-underline-offset:2px;word-break:break-all;font-size:calc(var(--ui-font-size,14px) - 2px)}.zusage-ctx-bkd-tip .cb-path:hover{opacity:.85}" +
    ".zusage-ctx-bkd-tip .cb-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;padding-left:10px}" +
    ".zusage-ctx-bkd-tip .cb-tag{display:inline-block;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,.07);color:var(--color-tooltip-foreground,#fafafa);font-size:calc(var(--ui-font-size,14px) - 2.5px)}" +
    ".zusage-ctx-bkd-tip.zu-light .cb-tag{background:rgba(0,0,0,.06)}" +
    ".zusage-ctx-bkd-tip .cb-adv{padding-top:6px;border-top:1px solid var(--color-border,rgba(255,255,255,.1));font-size:calc(var(--ui-font-size,14px) - 2px);line-height:1.45;color:var(--color-tooltip-tag-foreground,#a6a6a6)}" +
    "</style>";
  function ctxBkdEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function ctxBkdAttr(s) { return ctxBkdEsc(s).replace(/"/g, "&quot;"); }
  function ctxBkdInt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function ctxBkdPathText(label, targetPath) {   /* 只展示路径文本，不可点击（见气泡创建处的说明） */
    if (!targetPath) return "";
    return '<span class="cb-path" data-cb-path="' + ctxBkdAttr(targetPath) + '">' + ctxBkdEsc(label) + "</span>";
  }
  function ctxBkdJoinPath(base, sub) {
    if (!base) return "";
    var sep = base.indexOf("\\") >= 0 && base.indexOf("/") < 0 ? "\\" : "/";
    return base.replace(/[\\/]+$/, "") + sep + String(sub).replace(/[\\/]/g, sep);   // 子路径统一用同一分隔符，Windows 下不出混合斜杠
  }
  function ctxBkdExtraHtml(key, ctx) {
    if (!ctx) return "";
    var home = ctx.homeDir || "";
    var ws = ctx.workspacePath || "";
    var appRes = ctx.appResourcesDir || "";
    var html = "";
    if (key === "skills") {
      var used = Array.isArray(ctx.usedSkills) ? ctx.usedSkills : [];
      /* 清单取自会话快照的尾部窗口，不等于整个会话：标题写「近期」。
       * 技能目录取自技能工具输出（模型可见的不可信数据）：只有落在 home 或工作区之下才展示该目录，
       * 其余只列名称——不让工具输出把任意路径带进气泡 */
      var dirTrusted = function (d) {
        if (!d) return false;
        if (/(^|[\\/])\.\.([\\/]|$)/.test(d)) return false;   /* 字面前缀挡不住「..」穿越，直接拒 */
        return [home, ws].some(function (root) {
          return !!root && (d === root || d.indexOf(root + "/") === 0 || d.indexOf(root + "\\") === 0);
        });
      };
      if (used.length) {
        var tags = used.map(function (sk) {
          return dirTrusted(sk.dir) ? ctxBkdPathText(sk.name, sk.dir) : '<span class="cb-tag">' + ctxBkdEsc(sk.name) + "</span>";
        }).join("");
        html += '<div class="cb-item"><b>· ' + ctxBkdEsc(L("近期已用技能", "Recently used skills")) + " (" + used.length + ")</b>" +
          '<div class="cb-tags">' + tags + "</div></div>";
      } else {
        html += '<div class="cb-item"><b>· ' + ctxBkdEsc(L("近期已用技能", "Recently used skills")) + "</b>" +
          ctxBkdEsc(L("近期未调用技能（仅注入已加载技能的目录摘要）", "None in recent history (only catalog summaries are loaded)")) + "</div>";
      }
      var skDirs = [];
      if (home) skDirs.push(ctxBkdPathText(L("全局技能目录", "Global skills") + " (" + ctxBkdJoinPath(home, ".zcode/skills") + ")", ctxBkdJoinPath(home, ".zcode/skills")));
      if (ws) skDirs.push(ctxBkdPathText(L("项目技能目录", "Project skills") + " (" + ctxBkdJoinPath(ws, ".zcode/skills") + ")", ctxBkdJoinPath(ws, ".zcode/skills")));
      if (skDirs.length) html += '<div class="cb-item"><b>· ' + ctxBkdEsc(L("技能目录位置", "Skill directories")) + '</b><div class="cb-paths">' + skDirs.join("") + "</div></div>";
    } else if (key === "meta_user_context") {
      var instrLinks = [];
      if (home) instrLinks.push(ctxBkdPathText(L("全局 ", "Global ") + "AGENTS.md", ctxBkdJoinPath(home, ".zcode")));
      if (ws) {
        instrLinks.push(ctxBkdPathText(L("项目 ", "Project ") + "AGENTS.md", ws));
        instrLinks.push(ctxBkdPathText(".zcode/AGENTS.md", ctxBkdJoinPath(ws, ".zcode")));
      }
      if (instrLinks.length) html += '<div class="cb-item"><b>· ' + ctxBkdEsc(L("指令规则位置", "Instruction paths")) + '</b><div class="cb-paths">' + instrLinks.join("") + "</div></div>";
      if (home) {
        /* 记忆索引真实布局是 <home>/.zcode/cli/memories/projects/<工作区标识>/memory/MEMORY.md
         * （宿主 memoryService；ZCode 4.0.0 实机核对，<home>/.zcode/projects 不存在）。
         * 工作区标识与目录名不同，不逐项拼，链接打开 projects 目录 */
        var memDir = ctxBkdJoinPath(home, ".zcode/cli/memories/projects");
        html += '<div class="cb-item"><b>· ' + ctxBkdEsc(L("记忆索引位置", "Memory index")) + '</b><div class="cb-paths">' +
          ctxBkdPathText(ctxBkdJoinPath(memDir, "<工作区标识>/memory/MEMORY.md"), memDir) + "</div></div>";
      }
      html += '<div class="cb-item"><b>· ' + ctxBkdEsc(L("动态系统提醒", "Dynamic reminders")) + "</b>" +
        ctxBkdEsc(L("每轮实时拼接：OS/Shell/工作目录、日期、Git 分支与改动、Todo 待办、子代理列表、ToolSearch 公告（无磁盘文件）",
          "Assembled per turn: OS/Shell/cwd, date, Git status, Todo list, sub-agent catalog, ToolSearch notice (in-memory)")) + "</div>";
    } else if (key === "system_prompt") {
      var secTags = [
        ["core（核心身份与能力）", "core (Identity & capabilities)"],
        ["guidelines（编码与执行规范）", "guidelines (Coding & workflow)"],
        ["safety（安全与权限边界）", "safety (Safety & permissions)"],
        ["output_style（回复风格与语言）", "output_style (Style & locale)"]
      ].map(function (t) { return '<span class="cb-tag">' + ctxBkdEsc(L(t[0], t[1])) + "</span>"; }).join("");
      html += '<div class="cb-item"><b>· ' + ctxBkdEsc(L("核心段名称", "Core sections")) + '</b><div class="cb-tags">' + secTags + "</div></div>";
      if (appRes) {
        html += '<div class="cb-item"><b>· ' + ctxBkdEsc(L("内置引擎路径", "Built-in engine path")) + '</b><div class="cb-paths">' +
          ctxBkdPathText(ctxBkdJoinPath(appRes, "zcode.cjs"), appRes) + "</div></div>";
      }
    }
    return html;
  }
  function ctxBkdTipHTML(data) {
    var key = data && data.key;
    var entry = key ? ZU_CTX_BKD_TIPS[key] : null;
    if (!entry) return "";
    var fmtFn = typeof data.fmtTok === "function" ? data.fmtTok : function (v) { return String(v); };
    var title = ctxBkdEsc(L(entry.title[0], entry.title[1]));
    var pctHead = data.pctStr ? '<span class="cb-pct">' + ctxBkdEsc(data.pctStr) + "</span>" : "";
    var mrows = "";
    if (typeof data.tokens === "number" && isFinite(data.tokens) && data.tokens >= 0) {
      var tokDetail = "≈ " + fmtFn(data.tokens) + " token";
      if (data.tokens >= 10000) tokDetail += " (" + ctxBkdInt(data.tokens) + ")";
      mrows += '<div class="cb-mrow"><span class="cb-mk">' + ctxBkdEsc(L("估算用量", "Est. tokens")) +
        '</span><span class="cb-mv">' + ctxBkdEsc(tokDetail) + "</span></div>";
    }
    if (data.pctStr) {
      var ratioTxt = L("占已用 ", "Of used ") + data.pctStr;
      if (typeof data.pctOfWindow === "number" && isFinite(data.pctOfWindow)) {
        ratioTxt += " · " + L("占总窗口 ", "Of window ") + data.pctOfWindow.toFixed(1) + "%";
      }
      mrows += '<div class="cb-mrow"><span class="cb-mk">' + ctxBkdEsc(L("空间占比", "Share")) +
        '</span><span class="cb-mv">' + ctxBkdEsc(ratioTxt) + "</span></div>";
    }
    if (typeof data.chars === "number" && data.chars > 0) {
      var charTxt = fmtFn(data.chars) + L(" 字符", " chars");
      if (typeof data.totalChars === "number" && data.totalChars > 0) {
        charTxt += " / " + L("共 ", "of ") + fmtFn(data.totalChars);
      }
      mrows += '<div class="cb-mrow"><span class="cb-mk">' + ctxBkdEsc(L("原始文本", "Raw text")) +
        '</span><span class="cb-mv">' + ctxBkdEsc(charTxt) + "</span></div>";
    }
    var itemsHtml = entry.items.map(function (it) {
      return '<div class="cb-item"><b>· ' + ctxBkdEsc(L(it[0][0], it[0][1])) + "</b>" + ctxBkdEsc(L(it[1][0], it[1][1])) + "</div>";
    }).join("");
    var extraHtml = ctxBkdExtraHtml(key, data.ctx);
    return CTX_BKD_CSS +
      '<div class="cb-head"><span class="cb-title">' + title + "</span>" + pctHead + "</div>" +
      (mrows ? '<div class="cb-metrics">' + mrows + "</div>" : "") +
      '<div class="cb-subh">' + ctxBkdEsc(L("包含内容", "What's inside")) + "</div>" +
      '<div class="cb-list">' + itemsHtml + extraHtml + "</div>" +
      '<div class="cb-adv">' + ctxBkdEsc(L("💡 " + entry.advice[0], "💡 " + entry.advice[1])) + "</div>";
  }
  function ctxBkdCacheTipHTML(cacheObj) {
    var c = cacheObj && cacheObj.cache;
    if (!c || typeof c !== "object") return "";
    var fmtFn = typeof cacheObj.fmtTok === "function" ? cacheObj.fmtTok : function (v) { return String(v); };
    var rows = "";
    if (typeof c.latestHitRate === "number" && isFinite(c.latestHitRate)) {
      var latestVal = (Math.max(0, c.latestHitRate) * 100).toFixed(1) + "%";
      if (typeof c.cacheReadTokens === "number" && typeof c.inputTokens === "number" && c.inputTokens > 0) {
        latestVal += " (" + fmtFn(c.cacheReadTokens) + " / " + fmtFn(c.inputTokens) + ")";
      }
      rows += '<div class="cb-mrow"><span class="cb-mk">' + ctxBkdEsc(L("最近一次请求", "Latest request")) +
        '</span><span class="cb-mv">' + ctxBkdEsc(latestVal) + "</span></div>";
    }
    if (typeof c.hitRate === "number" && isFinite(c.hitRate)) {
      var avgVal = (Math.max(0, c.hitRate) * 100).toFixed(1) + "%";
      if (typeof c.totalCacheReadTokens === "number" && typeof c.totalInputTokens === "number" && c.totalInputTokens > 0) {
        avgVal += " (" + fmtFn(c.totalCacheReadTokens) + " / " + fmtFn(c.totalInputTokens) + ")";
      }
      rows += '<div class="cb-mrow"><span class="cb-mk">' + ctxBkdEsc(L("本会话累计", "Session total")) +
        '</span><span class="cb-mv">' + ctxBkdEsc(avgVal) + "</span></div>";
    }
    if (typeof c.hitRateRequestCount === "number" && c.hitRateRequestCount > 0) {
      rows += '<div class="cb-mrow"><span class="cb-mk">' + ctxBkdEsc(L("统计主轮数", "Main requests")) +
        '</span><span class="cb-mv">' + ctxBkdEsc(String(c.hitRateRequestCount) + L(" 次", " reqs")) + "</span></div>";
    }
    if (typeof c.cacheWriteTokens === "number" && c.cacheWriteTokens > 0) {
      rows += '<div class="cb-mrow"><span class="cb-mk">' + ctxBkdEsc(L("最近缓存写入", "Last cache write")) +
        '</span><span class="cb-mv">' + ctxBkdEsc(fmtFn(c.cacheWriteTokens) + " token") + "</span></div>";
    }
    if (!rows) return "";
    var headPct = typeof c.hitRate === "number" && isFinite(c.hitRate) ? (Math.max(0, c.hitRate) * 100).toFixed(1) + "%" : "";
    return CTX_BKD_CSS +
      '<div class="cb-head"><span class="cb-title">' + ctxBkdEsc(L("平均缓存命中率", "Average cache hit rate")) + "</span>" +
      (headPct ? '<span class="cb-pct">' + ctxBkdEsc(headPct) + "</span>" : "") + "</div>" +
      '<div class="cb-metrics">' + rows + "</div>" +
      '<div class="cb-adv">' + ctxBkdEsc(L("💡 命中率越高，模型复用已有前缀的比例越高，首字响应更快且更省费用。",
        "💡 Higher hit rate means more prompt prefix is reused by the provider, cutting latency and cost.")) + "</div>";
  }
  function placeCtxBkdTip(rowEl) {
    var dark = true;
    try { dark = document.documentElement.classList.contains("dark"); } catch (e) { }
    ctxBkdTip.classList.toggle("zu-light", !dark);
    ctxBkdTip.style.display = "block";
    var r = rowEl.getBoundingClientRect(), tw = ctxBkdTip.offsetWidth, th = ctxBkdTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var hc = rowEl.closest ? rowEl.closest('[data-slot="hover-card-content"]') : null;
    var anchor = hc ? hc.getBoundingClientRect() : r;
    var left = anchor.right - 4;
    if (left + tw > vw - 8) left = anchor.left - tw + 4;
    left = Math.max(8, Math.min(left, vw - tw - 8));
    var top = Math.max(8, Math.min(r.top - 4, vh - th - 8));
    ctxBkdTip.style.left = Math.round(left) + "px";
    ctxBkdTip.style.top = Math.round(top) + "px";
    ctxBkdTipFor = rowEl;
  }
  function showCtxBkdTip(rowEl) {
    cancelCtxBkdHide();
    if (stale() || !state.ctxBkd || !rowEl) { hideCtxBkdTip(); return; }
    if (!rowEl.isConnected) {
      if (ctxBkdHovered && rowEl === ctxBkdTipFor) return;
      hideCtxBkdTip();
      return;
    }
    if (ctxBkdHovered && ctxBkdTipFor && rowEl !== ctxBkdTipFor) return;
    var html = "";
    if (rowEl.getAttribute && rowEl.getAttribute("data-zusage-bkd-cache") === "1") {
      html = ctxBkdCacheTipHTML(rowEl.__zuBkdCache);
    } else if (rowEl.__zuBkdData) {
      html = ctxBkdTipHTML(rowEl.__zuBkdData);
    }
    if (!html) { hideCtxBkdTip(); return; }
    var sameRow = (ctxBkdTip.style.display === "block" && ctxBkdTipFor === rowEl);
    if (ctxBkdTip.__zuTipSig !== html) {
      ctxBkdTip.innerHTML = html;
      ctxBkdTip.__zuTipSig = html;
    }
    if (!sameRow) placeCtxBkdTip(rowEl);
  }
  function hideCtxBkdTip() {
    cancelCtxBkdHide();
    ctxBkdHovered = false;
    ctxBkdTip.style.display = "none";
    ctxBkdTipFor = null;
  }
  /* 余额文本（文档级：tooltip 与实例 chip 共用）。CNY→¥、USD→$，其它带代码前缀。
   * currency 是远程响应字符串且本函数输出直接进 innerHTML（chip 与 tooltip 双 sink），
   * 在函数内统一转义（2026-10-24 审计：恶意/被黑中转可借 currency 注入）；amount 恒经
   * Number().toFixed(2) 数字化，安全。调用方不得再整体转义本函数输出（会双重转义）。
   * plain=true 供 aria-label 等纯文本场景取未转义形式（避免屏幕阅读器读出实体）。 */
  function quotaBalanceText(bal, plain) {
    var cur = String(bal.currency || "");
    if (!plain) cur = cur.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
    var sym = cur === "CNY" ? "¥" : cur === "USD" ? "$" : (cur ? cur + " " : "");
    return sym + Number(bal.amount).toFixed(2);
  }
  /* 客户端会过滤回复 HTML 的 style/class；提醒先用 Markdown 加粗，加载浮层后再着色。 */
  var noticeStyle = document.createElement("style");
  noticeStyle.textContent = '[data-zusage-notice="' + MY_GEN + '"], [data-zusage-notice="' + MY_GEN + '"] * {' +
    "color:#ef4444!important;font-weight:700!important}";
  document.body.appendChild(noticeStyle);
  var noticeNodes = [];
  function isPluginNotice(el) {
    var parent = el.parentElement;
    return document.body.contains(el) && parent && /^(P|BLOCKQUOTE)$/.test(parent.tagName) &&
      (el.textContent || "").trim().indexOf("🔴 zcode-token-usage-statusbar 插件提醒：") === 0 &&
      (parent.textContent || "").trim() === (el.textContent || "").trim() &&
      el.closest('blockquote') && el.closest('[class~="group/assistant-row"]') &&
      !el.closest('pre, code, [data-v4-user-input-bubble], [data-markdown-preview], .zusage-root, .zusage-rate-tip');
  }
  function clearNotice(el) {
    if (el.dataset.zusageNotice === String(MY_GEN)) delete el.dataset.zusageNotice;
  }
  function scanPluginNotices() {
    noticeNodes = noticeNodes.filter(function (el) {
      if (isPluginNotice(el)) return true;
      clearNotice(el);
      return false;
    });
    document.querySelectorAll("blockquote strong").forEach(function (el) {
      if (el.dataset.zusageNotice === String(MY_GEN) || !isPluginNotice(el)) return;
      el.dataset.zusageNotice = String(MY_GEN);
      noticeNodes.push(el);
    });
  }
  var rateBindings = [];
  function isRateLine(el) {
    var t = el.textContent || "";
    /* 「tok/s(本轮)」是 v85 前的旧标记：模型时代贴进历史的行与升级前已缓存的富文本仍带它 */
    return document.body.contains(el) && (t.indexOf("token/s(本轮)") >= 0 || t.indexOf("tok/s(本轮)") >= 0) && t.indexOf("⚡") >= 0 &&
      !(el.tagName === "BLOCKQUOTE" && el.querySelector("p"));
  }
  function unbindRateLine(binding) {
    var el = binding.el;
    el.removeEventListener("mouseenter", onRateEnter);
    el.removeEventListener("mouseleave", hideRateTip);
    if (el.dataset.zusageRateTip === String(MY_GEN)) delete el.dataset.zusageRateTip;
    if (el.style.cursor === "help") el.style.cursor = binding.cursor;
  }
  function onRateEnter() { showRateTip(this); }
  function scanRateLines() {
    if (stale()) { cleanupRateTip(); return; }
    /* chip 随宿主重建被替换时浏览器不发 mouseleave，tooltip 会悬挂；豁免滚动收起（v106）
     * 后此处是 detach 场景的兜底健康检查（500ms 周期，与速率行扫描共用足迹） */
    if (quotaTipFor && !quotaTipFor.isConnected) hideQuotaTip();
    if (rstTipFor && !rstTipFor.isConnected) hideRstTip();   // v135：徽标随宿主重建 detach 的兜底收起
    if (tpsTipFor && !tpsTipFor.isConnected) hideTpsTip();   // v146：速率 chip 随宿主重建 detach 的兜底收起
    if (subTipFor && !subTipFor.isConnected) hideSubTip();   // v176：行内速率 chip 随宿主重建 detach 的兜底收起
    if (ctxBkdTipFor && !ctxBkdTipFor.isConnected && !ctxBkdHovered) hideCtxBkdTip();   // v487：上下文弹层关闭卸载时的兜底收起
    scanPluginNotices();
    rateBindings = rateBindings.filter(function (binding) {
      if (state.rateLine && isRateLine(binding.el)) return true;
      unbindRateLine(binding);
      return false;
    });
    if (!state.rateLine) { hideRateTip(); return; }
    var nodes = document.querySelectorAll("blockquote p, blockquote, p");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.dataset.zusageRateTip === String(MY_GEN) || !isRateLine(el)) continue;
      rateBindings.push({ el: el, cursor: el.style.cursor });
      el.dataset.zusageRateTip = String(MY_GEN);
      el.style.cursor = "help";
      el.addEventListener("mouseenter", onRateEnter);
      el.addEventListener("mouseleave", hideRateTip);
    }
    if (rateTipFor && !isRateLine(rateTipFor)) hideRateTip();
  }
  function cleanupRateTip() {
    clearInterval(rateScanTimer);
    rateBindings.forEach(unbindRateLine);
    rateBindings = [];
    noticeNodes.forEach(clearNotice);
    noticeNodes = [];
    noticeStyle.remove();
    hideRateTip();
    rateTip.remove();
    hideQuotaTip();
    quotaTip.remove();
    hideRstTip();
    rstTip.remove();
    hideTpsTip();
    tpsTip.remove();   // v146：精简模式速率 tooltip 同链清理
    hideFxTip();
    fxTip.remove();   // v202：预估费用说明小气泡同链清理
    hideCtxBkdTip();
    ctxBkdTip.remove();   // v487：上下文分项构成说明小气泡同链清理
    hideEnhanceTip();
    enhanceTip.remove();   // v344：增强按钮 tooltip 同链清理（dispose 不留 body 孤儿浮层）
    hideUpdNoteTip();
    updNoteTip.remove();   // v413：齿轮悬停更新日志卡同链清理（dispose/热更不留 body 孤儿浮层）
    spdHoverPortalHide();
    spdHoverPortal.remove();   // v280：柱 hover Portal 同链清理（dispose/热更不留孤儿浮层）
    spdLegendTipHide();
    spdLegendTip.remove();     // v281：档位说明浮层同链清理
    window.removeEventListener("scroll", hideTipsOnScroll, true);
    document.removeEventListener("pointerout", stopCtxHcLeave, true);
    document.removeEventListener("mouseout", stopCtxHcLeave, true);
    document.removeEventListener("pointerdown", onCtxBkdDocDown, true);
    if (window.__zusageRateCleanup === cleanupRateTip) delete window.__zusageRateCleanup;
  }
  /* 捕获：任意容器滚动即收——仅速率行浮层需要（宿主在消息流正文内，滚动即移位，fixed 浮层
   * 不跟随即指向错误位置）。额度 chip 与 git chip 同款固定在 composer 工具行，消息流滚动
   * 不移动它，豁免（v106）：思考中流式输出驱动聊天容器持续自动滚动，若一并收起则 tooltip
   * 悬停弹出即灭。quotaTip 由 mouseleave/blur/代际清理/开关关闭收起；chip 随宿主重建被
   * 替换（无 mouseleave）由 scanRateLines 的 isConnected 健康检查兜底。 */
  function hideTipsOnScroll() { hideRateTip(); }
  window.addEventListener("scroll", hideTipsOnScroll, true);
  /* v88：扫描与心跳统一 0.5s（用户要求计时 0.5s 步进；富文本重试上限同步放大保持 ~12s 等库窗口） */
  var rateScanTimer = setInterval(scanRateLines, 500);
  window.__zusageRateCleanup = cleanupRateTip;
  scanRateLines();

  /* ---------- Git chip 的悬停说明（v96）：document 级单例，同 rateTip 套路（挂 body、内联兜底样式） ----------
   * 内容按 chip.__zuGit（{path, st, stale}）渲染；分支名/上游/路径是用户数据，一律过 gitEsc。 */
  var gitTip = document.createElement("div");
  gitTip.className = "tip zusage-git-tip";
  gitTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(gitTip);
  var gitTipFor = null;
  function gitEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function gitTimeStr(ts) {   // yyyy-MM-dd HH:mm:ss（与额度 chip 的 tooltip 时间格式约定一致，用户要求带秒）
    try {
      var t = new Date(ts), p = function (n) { return ("0" + n).slice(-2); };
      return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate()) + " " + p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds());
    } catch (e) { return ""; }
  }
  /* 进行中 Git 操作的展示名（主进程 fs 探针 detectGitOp 的代码 → 双语标签；am 主栏短标签「补丁」） */
  var GIT_OP_LABELS = { rebase: ["变基", "rebase"], merge: ["合并", "merge"], "cherry-pick": ["拣选", "cherry-pick"], revert: ["还原", "revert"], bisect: ["二分", "bisect"], am: ["补丁", "patch"] };
  /* v411 逐文件状态标签（inject-main fileLabel 代码 → 双语短标；v425 起列首标签让位文件类型
   * 图标，本表保留作图标 title 与语义来源；conflict 图标整体转红保留警示） */
  var GIT_FILE_LABELS = { conflict: ["冲突", "conflict"], untracked: ["新", "new"], deleted: ["删", "del"], renamed: ["移", "ren"], added: ["新", "new"], modified: ["改", "mod"] };
  /* v426 图标重制（v425 线条文件页+小字在 14px 下糊成一片，用户实拍反馈）：参照宿主 JS 徽标
   * 的实心圆角方块+粗体扩展名——实底填充保证小尺寸可读，文字色按填充亮度自动取深/白
   * （Json/Js/Md 等浅底配深字，Py/Ts/Png 等深底配白字）；冲突专用深红底白字压过类型色
   * （原 zu-gf-c 语义）。扩展名取路径尾段（rename 天然按新名），超 3 字符截断，无扩展名
   * 纯灰块。仍不引用宿主 material-icons 资产（注入环境无该目录会裂图）。 */
  var GIT_EXT_COLORS = { js: "#e8c66a", cjs: "#e8c66a", mjs: "#e8c66a", jsx: "#e8c66a", ts: "#61afcc", tsx: "#61afcc",
    py: "#5f9ed6", md: "#7aa2f7", markdown: "#7aa2f7", txt: "#9aa5b1", json: "#cbcb41", yml: "#a6a6a6", yaml: "#a6a6a6",
    toml: "#a6a6a6", ini: "#a6a6a6", conf: "#a6a6a6", cfg: "#a6a6a6", css: "#c66cad", scss: "#c66cad", less: "#c66cad",
    html: "#d1712f", htm: "#d1712f", rs: "#dea584", go: "#53b4c8", java: "#b07219", c: "#8aa4c8", h: "#8aa4c8",
    cpp: "#8aa4c8", hpp: "#8aa4c8", cc: "#8aa4c8", sh: "#89c06a", bash: "#89c06a", zsh: "#89c06a", rb: "#d06b5c",
    php: "#8993c4", sql: "#d98f4e", svg: "#a074c4", png: "#a074c4", jpg: "#a074c4", jpeg: "#a074c4", gif: "#a074c4",
    webp: "#a074c4", ico: "#a074c4", lock: "#7d8590" };
  function gitFileIcon(p, s) {
    var m = /\.([A-Za-z0-9]+)\s*$/.exec(String(p));
    var ext = m ? m[1].toLowerCase() : "";
    var c = s === "conflict" ? "#d9534f" : (GIT_EXT_COLORS[ext] || "#98a0a8");
    var t = ext.slice(0, 3).toUpperCase();
    var n = parseInt(c.slice(1), 16);
    var lum = 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255);
    var tc = lum > 162 ? "#24292f" : "#ffffff";
    var fs = t.length <= 2 ? 7 : 5.6;
    return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">' +
      '<rect x="0.5" y="0.5" width="15" height="15" rx="3.2" fill="' + c + '"/>' +
      (t ? '<text x="8" y="' + (t.length <= 2 ? 11.4 : 10.8) + '" text-anchor="middle" font-size="' + fs + '" font-weight="700" fill="' + tc + '" font-family="system-ui,sans-serif">' + t + "</text>" : "") +
      "</svg>";
  }
  function gitOpLabel(code) { var m = GIT_OP_LABELS[code]; return m ? L(m[0], m[1]) : code; }
  /* v96 multi：多仓库聚合口径（chip/aria/tooltip 共用）——总数、脏仓数（成功仓 changed>0 或
   * untracked>0）、改动/未跟踪文件求和、失败仓数、任一成功仓有冲突；聚合数由渲染端算，主进程不提供。 */
  function gitMultiAgg(st) {
    var repos = st && Array.isArray(st.repos) ? st.repos : [];
    /* known=已确认仓库（成功或携带旧快照的失败仓）；changed/conflict/op 只在确认数据上统计；
     * 旧缓存（stale）里的冲突不汇总为已确认冲突，但其改动计入已知改动。 */
    var agg = { total: repos.length, known: 0, changed: 0, conflict: 0, op: 0, failed: 0, staleAny: false, m: 0, q: 0 };
    for (var i = 0; i < repos.length; i++) {
      var r = repos[i];
      if (r.err) {
        agg.failed++;
        if (r.stale) {
          agg.known++; agg.staleAny = true;
          if ((r.changed | 0) > 0 || (r.untracked | 0) > 0) agg.changed++;
        }
        continue;
      }
      agg.known++;
      if (r.stale) agg.staleAny = true;
      if ((r.changed | 0) > 0 || (r.untracked | 0) > 0) agg.changed++;
      if ((r.conflicts | 0) > 0 && !r.stale) agg.conflict++;
      if (r.op && !r.stale) agg.op++;
      agg.m += r.changed | 0;
      agg.q += r.untracked | 0;
    }
    return agg;
  }
  /* v133 Git 计数缩写（用户规格 2026-10-28）：<1万原值；≥1万 中文（cnUnits 判定）万/亿、
   * 英文 k/M/B——k 门槛刻意抬到 1万（9999 内原值），与 token fmt() 的 K≥1000 不同；小写 k、
   * 至多两位小数去尾零、数字与单位紧邻。仓库个数与 aria 播报（gitChipAria）不缩写。 */
  function unit2(x) { return x.toFixed(2).replace(/\.?0+$/, ""); }   // 与实例内 cnUnit 同规则：fmt..sec 源码切片被测试整段求值，不能跨作用域共用
  function gitNum(n) {
    n = n | 0;
    if (n < 1e4) return String(n);
    if (cnUnits()) return n >= 1e8 ? unit2(n / 1e8) + "亿" : unit2(n / 1e4) + "万";
    if (n >= 1e9) return unit2(n / 1e9) + "B";
    if (n >= 1e6) return unit2(n / 1e6) + "M";
    return unit2(n / 1e3) + "k";
  }
  /* tooltip 行样式单/多仓共用：rt-row 补 min-width:0 允许 flex 行收缩防长仓库名溢出；
   * zu-gname=多仓行仓库名（可收缩断行，main 前景色 600 字重），zu-gconf=冲突红，
   * c-mod/c-unt=已跟踪变更/未跟踪（黄），c-warn=失败/过期/未知（黄），c-op=操作名（中性），
   * zu-git-rows=多仓逐仓列表滚动容器；data-zusage-light 切浅色语义档（showGitTip 随 chip 同步）。 */
  var GIT_TIP_CSS = '<style>.zusage-git-tip .rt-h{font-weight:600;color:var(--color-tooltip-foreground,#e6e6e6);margin:0 0 7px}' +
    ".zusage-git-tip .rt-row{display:flex;gap:10px;margin:3px 0;min-width:0}" +
    ".zusage-git-tip .rt-row b{flex:0 0 auto;min-width:78px;color:var(--color-tooltip-foreground,#e6e6e6);font-weight:600}" +
    ".zusage-git-tip .rt-row span{color:var(--color-tooltip-tag-foreground,#a6a6a6);word-break:break-all}" +
    ".zusage-git-tip b.zu-gname{flex:0 1 auto;min-width:0;word-break:break-all;font-weight:600}" +
    ".zusage-git-tip .zu-gbr{color:var(--color-tooltip-tag-foreground,#afafb2)}" +
    ".zusage-git-tip .c-mod,.zusage-git-tip .c-unt,.zusage-git-tip .c-warn{color:#f0e6a0}" +
    ".zusage-git-tip .zu-gconf{color:#f09696}" +
    ".zusage-git-tip .c-op{color:var(--color-tooltip-tag-foreground,#afafb2)}" +
    ".zusage-git-tip .zu-gsep{opacity:.6}" +
    ".zusage-git-tip .zu-gdiv{color:var(--color-tooltip-tag-foreground,#afafb2);opacity:.85}" +
    ".zusage-git-tip .zu-git-rows{max-height:60vh;overflow-y:auto;overscroll-behavior:contain}" +
    /* v425 文件行三段式：类型图标（固定 16px 槽）+ 路径（可收缩断行）+ 行尾 ±N（镜像 chip
     * ins/del 配色，浅色档走 data-zusage-light 覆盖） */
    ".zusage-git-tip b.zu-gf-ico{flex:0 0 auto;min-width:16px;display:flex;align-items:center;font-weight:400}" +
    ".zusage-git-tip .zu-gf-p{flex:1 1 auto;min-width:0}" +
    ".zusage-git-tip .zu-gf-num{flex:0 0 auto;margin-left:8px;white-space:nowrap;font-variant-numeric:tabular-nums}" +
    ".zusage-git-tip .zu-gf-add{color:#aae6aa}" +
    ".zusage-git-tip .zu-gf-del{color:#f09696}" +
    ".zusage-git-tip[data-zusage-light] .zu-gf-add{color:#2da587}" +
    ".zusage-git-tip[data-zusage-light] .zu-gf-del{color:#d20f39}" +
    ".zusage-git-tip[data-zusage-light] .rt-h,.zusage-git-tip[data-zusage-light] .rt-row b,.zusage-git-tip[data-zusage-light] b.zu-gname{color:var(--color-tooltip-foreground,#2e3440)}" +
    ".zusage-git-tip[data-zusage-light] .c-mod,.zusage-git-tip[data-zusage-light] .c-unt,.zusage-git-tip[data-zusage-light] .c-warn{color:#946200}" +
    ".zusage-git-tip[data-zusage-light] .zu-gconf{color:#d20f39}" +
    '.zusage-git-tip .rt-note{margin-top:8px;padding-top:7px;border-top:1px solid var(--color-border,transparent);color:var(--color-tooltip-tag-foreground,#afafb2)}</style>';
  function gitTipHTML(view) {
    if (view.st.kind === "multi") return gitMultiTipHTML(view);
    var st = view.st, row = function (label, text) { return '<div class="rt-row"><b>' + label + "</b><span>" + text + "</span></div>"; };
    var items = function (n) { return gitNum(n) + L(" 项", n === 1 ? " entry" : " entries"); };   // porcelain 条目：重命名计 1、未跟踪目录折叠计 1，不冒充文件数
    var up = st.upstream ? gitEsc(st.upstream) + (st.ahead > 0 ? " ↑" + gitNum(st.ahead) : "") + (st.behind > 0 ? " ↓" + gitNum(st.behind) : "") : L("未设置上游分支（↑↓ 不可用）", "no upstream set (ahead/behind unavailable)");
    var when = gitTimeStr(st.ts);
    return GIT_TIP_CSS +
      '<div class="rt-h">⎇ ' + L("Git 状态", "Git status") + (view.stale ? ' <span class="c-warn">' + L("· 上次查询失败，显示的是最近成功结果", "· last query failed; showing the last good result") + "</span>" : "") + "</div>" +
      row(L("分支", "Branch"), st.detached ? (view.wt ? L("游离 HEAD（worktree 检出，未建分支）", "detached HEAD (worktree checkout, no branch yet)") : L("游离 HEAD（不在任何分支上）", "detached HEAD (on no branch)")) : gitEsc(st.branch || "") + (st.noCommits ? L("（尚无首次提交）", " (no initial commit yet)") : "")) +
      row(L("上游", "Upstream"), up) +
      row(L("已暂存", "Staged"), items(st.staged)) +
      row(L("未暂存", "Unstaged"), items(st.unstaged)) +
      row(L("未跟踪", "Untracked"), items(st.untracked) + L("（目录折叠计 1）", " (collapsed dirs count as 1)")) +
      (st.conflicts > 0 ? row(L("冲突", "Conflicts"), '<span class="zu-gconf">!' + items(st.conflicts) + "</span>") : "") +
      (st.op ? row(L("进行中操作", "Git operation"), gitEsc(gitOpLabel(st.op))) : "") +
      row(L("改动行数", "Diff lines"), "+" + gitNum(st.ins) + " / -" + gitNum(st.del) + L(" 行（工作区相对 HEAD 的合计口径，非净差异）", " lines (worktree vs HEAD, combined—not a net diff)")) +
      row(L("目录", "Directory"), gitEsc(st.repoPath || view.path)) +   // v96：repoPath=真实仓库绝对路径，缺省回退工作区路径
      /* 受管 worktree 区块（specs/worktree-branch.md §v409）：短标识 + 源仓库 + 起点与创建
       * 时刻；root 仅在 cwd ≠ root（monorepo）时单列，否则「目录」行已是根不重复。 */
      (view.wt ? row(L("受管 Worktree", "Managed worktree"), gitEsc(view.wt.bucket) + " · " + gitEsc(view.wt.name)) : "") +
      (view.wt && view.wt.root && view.wt.root !== view.wt.cwd ? row(L("Worktree 根目录", "Worktree root"), gitEsc(view.wt.root)) : "") +
      (view.wt && view.wt.sourceRoot ? row(L("主仓库", "Source repo"), gitEsc(view.wt.sourceRoot)) : "") +
      (view.wt ? row(L("起点", "Start ref"), view.wt.ref ? gitEsc(view.wt.ref) : (view.wt.sha ? gitEsc(String(view.wt.sha).slice(0, 7)) : L("当前 HEAD（游离检出）", "current HEAD (detached)"))) : "") +
      (view.wt && view.wt.created ? row(L("创建于", "Created"), gitTimeStr(view.wt.created)) : "") +
      /* v411 变更文件清单：单仓查询收逐文件明细（帽 60，ft=真实总数），多仓聚合不收。
       * v425：列首状态文字改文件类型图标（title 保留状态语义），行尾追加每文件 ±N 行数
       * （numstat 命中才有；未跟踪/二进制无数值行尾省略，与宿主弹层同布局）。 */
      (st.files && st.files.length ?
        '<div class="rt-row"><b>' + L("变更文件", "Changed files") + '</b><span>' + gitNum(st.ft) + L(" 项", " entries") + (st.ft > st.files.length ? L("（列前 " + st.files.length + " 条）", " (showing first " + st.files.length + ")") : "") + '</span></div>' +
        '<div class="zu-git-rows">' + st.files.map(function (f) {
          var lbl = GIT_FILE_LABELS[f.s] || GIT_FILE_LABELS.modified;
          var nums = f.add != null ? '<span class="zu-gf-num"><span class="zu-gf-add">+' + gitNum(f.add) + '</span> <span class="zu-gf-del">-' + gitNum(f.del) + "</span></span>" : "";
          return '<div class="rt-row"><b class="zu-gf-ico" title="' + L(lbl[0], lbl[1]) + '">' + gitFileIcon(f.p, f.s) + '</b><span class="zu-gf-p">' + gitEsc(f.p) + '</span>' + nums + '</div>';
        }).join("") +
        (st.ft > st.files.length ? '<div class="rt-row"><b class="zu-gf-ico"></b><span class="c-warn">' + L("…另有 " + gitNum(st.ft - st.files.length) + " 项未列出", "… " + gitNum(st.ft - st.files.length) + " more not listed") + '</span></div>' : "") +
        '</div>' : "") +
      (when ? row(L("更新于", "Updated"), when) : "") +
      '<div class="rt-note">' + L("只读本地仓库，不自动 fetch（上游比较基于本地引用）；远端会话不显示。点击 chip 可打开宿主原生 Git 面板（宿主无原生胶囊时为立即刷新）。⚙ 设置可关。",
        "Local repositories read-only, never auto-fetches (upstream compares against local refs); hidden for remote sessions. Click the chip to open the native Git panel (falls back to an instant refresh when the native capsule is absent). Toggle in ⚙ settings.") + "</div>";
  }
  /* v96 multi tooltip：概览（标题 / 有改动仓库与非零冲突·操作·失败 / 覆盖行）→ 逐仓全量列表
   * （优先级：冲突 0 < 失败或过期 1 < 操作中 2 < 有改动 3 < 上游差异 4 < 干净 5；同级码点序，
   * 不用 localeCompare；干净组前插分隔行，所有行都在滚动容器内可访问）→ 元信息（工作目录 /
   * 更新时间 / 口径）。失败仓携带的旧快照标「过期」，其冲突不汇总为已确认。仓库名/分支/路径
   * 是用户数据，一律过 gitEsc/属性转义。 */
  function gitMultiTipHTML(view) {
    var st = view.st, agg = gitMultiAgg(st);
    var row = function (label, text) { return '<div class="rt-row"><b>' + label + "</b><span>" + text + "</span></div>"; };
    var attr = function (s) { return gitEsc(s).replace(/"/g, "&quot;"); };   // title 属性需转义引号
    var rrow = function (name, text, title) { return '<div class="rt-row"><b class="zu-gname"' + (title ? ' title="' + title + '"' : "") + ">" + name + '</b><span>' + text + "</span></div>"; };
    var rank = function (r) {
      if (r.err || r.stale) return 1;
      if ((r.conflicts | 0) > 0) return 0;
      if (r.op) return 2;
      if ((r.changed | 0) > 0 || (r.untracked | 0) > 0) return 3;
      if ((r.ahead | 0) > 0 || (r.behind | 0) > 0) return 4;
      return 5;
    };
    var repos = (st.repos || []).slice();   // 排序不动主进程推送的原数组；与 gitMultiAgg 同款防御
    repos.sort(function (a, b) { var ra = rank(a), rb = rank(b); return ra !== rb ? ra - rb : a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    var h = GIT_TIP_CSS + '<div class="rt-h">⎇ ' + L("Git 状态", "Git status") + L(" · " + agg.total + " 个仓库", " · " + agg.total + " repos") + "</div>";
    var ov = L("有改动 <b class=\"c-mod\">" + agg.changed + "</b> 个仓库", "<b class=\"c-mod\">" + agg.changed + "</b> repos with changes");
    if (agg.conflict > 0) ov += '<span class="zu-gsep"> · </span><span><b class="zu-gconf">!' + agg.conflict + '</b>' + L(" 个仓库冲突", " repos conflicted") + "</span>";
    if (agg.op > 0) ov += '<span class="zu-gsep"> · </span><span><b class="c-op">' + agg.op + '</b>' + L(" 个仓库操作中", " repos mid-operation") + "</span>";
    if (agg.failed > 0) ov += '<span class="zu-gsep"> · </span><span><b class="c-warn">' + agg.failed + '</b>' + L(" 个查询失败", " failed") + "</span>";
    if (view.stale) ov += '<span class="zu-gsep"> · </span><span class="c-warn">' + L("上次查询失败，显示的是最近成功结果", "last query failed; showing the last good result") + "</span>";
    h += '<div class="rt-ov">' + ov + "</div>";
    if (agg.m > 0 || agg.q > 0) {
      var sm = [];
      if (agg.m > 0) sm.push(L("已跟踪变更 <b class=\"c-mod\">" + gitNum(agg.m) + "</b> 项", "<b class=\"c-mod\">" + gitNum(agg.m) + "</b> tracked-change entries"));
      if (agg.q > 0) sm.push(L("未跟踪 <b class=\"c-unt\">" + gitNum(agg.q) + "</b> 项", "<b class=\"c-unt\">" + gitNum(agg.q) + "</b> untracked entries"));
      h += '<div class="rt-ov">' + sm.join('<span class="zu-gsep"> · </span>') + "</div>";
    }
    if (agg.known < agg.total) h += '<div class="rt-ov"><span class="c-warn">' + L("已确认 " + agg.known + "/" + agg.total + " 个仓库", "Confirmed " + agg.known + "/" + agg.total + " repos") + (agg.failed ? " · " + L(agg.failed + " 个查询失败", agg.failed + " failed") : "") + "</span></div>";
    var cleanTotal = 0, focused = 0, divDone = false, rows = "";
    for (var i = 0; i < repos.length; i++) { if (rank(repos[i]) === 5) cleanTotal++; else focused++; }
    for (var j = 0; j < repos.length; j++) {
      var r = repos[j], rk = rank(r);
      if (rk === 5 && focused > 0 && cleanTotal > 0 && !divDone) {   // 干净组分隔行（其余仓仍全部可访问）
        rows += '<div class="rt-row zu-gdiv"><span>' + L("其余 " + cleanTotal + " 个仓库，无本地改动", cleanTotal + " more repos with no local changes") + "</span></div>";
        divDone = true;
      }
      if (r.err) {
        var msg = { notrepo: L("非 Git 仓库", "not a git repository"), nogit: L("未找到 git", "git not found"), timeout: L("超时", "timed out"), error: L("出错", "error") }[r.err] || r.err;
        var t = '<span class="c-warn">⚠ ' + L("查询失败", "query failed") + "（" + gitEsc(msg) + "）</span>";
        if (r.stale) {   // 携带旧快照：标注历史属性并展示上次分支与改动（旧冲突不作已确认，不在此渲染）
          t += ' <span class="c-warn">' + L("过期；以下为上次结果", "stale; showing last good result") + "</span>";
          if (r.branch) t += ' <span class="zu-gbr">' + gitEsc(r.branch) + "</span>";
          if ((r.changed | 0) > 0) t += ' <span class="c-mod">' + L("改 " + gitNum(r.changed) + " 项", gitNum(r.changed) + " mod") + "</span>";
          if ((r.untracked | 0) > 0) t += ' <span class="c-unt">' + L("新 " + gitNum(r.untracked) + " 项", gitNum(r.untracked) + " new") + "</span>";
        }
        rows += rrow(gitEsc(r.name), t, attr(r.path));
        continue;
      }
      var seg = '<span class="zu-gbr">' + (r.detached ? L("HEAD（游离）", "HEAD (detached)") : gitEsc(r.branch || (r.noCommits ? L("初始", "init") : ""))) + (r.noCommits && !r.detached ? L("（尚无首次提交）", " (no initial commit yet)") : "") + "</span>";
      if (r.op && !r.stale) seg += ' <span class="c-op">' + gitEsc(gitOpLabel(r.op)) + "</span>";
      if (r.stale) seg += ' <span class="c-warn">' + L("过期", "stale") + "</span>";
      if ((r.conflicts | 0) > 0) seg += ' <span class="zu-gconf">!' + gitNum(r.conflicts) + L(" 冲突", " conflicted") + "</span>";
      if ((r.changed | 0) > 0) seg += ' <span class="c-mod">' + L("改 " + gitNum(r.changed) + " 项", gitNum(r.changed) + " mod") + "</span>";
      if ((r.untracked | 0) > 0) seg += ' <span class="c-unt">' + L("新 " + gitNum(r.untracked) + " 项", gitNum(r.untracked) + " new") + "</span>";
      if ((r.ahead | 0) > 0) seg += " ↑" + gitNum(r.ahead);
      if ((r.behind | 0) > 0) seg += " ↓" + gitNum(r.behind);
      rows += rrow(gitEsc(r.name), seg, attr(r.path));   // title=完整路径（宿主原生提示可访问完整值）
    }
    if (st.more > 0) rows += '<div class="rt-row"><span class="zu-gmore">' + L("另有 " + st.more + " 个子仓库未统计", st.more + " more repos not scanned") + "</span></div>";
    h += '<div class="zu-git-rows">' + rows + "</div>";
    h += row(L("工作目录", "Work dir"), gitEsc(view.path) + L("，下含 " + agg.total + " 个仓库", " · " + agg.total + " repos"));
    var when = gitTimeStr(st.ts);
    h += when ? row(L("更新于", "Updated"), when + L(" · 工作区文件变更后约 1 分钟内自动刷新，点击 chip 立即刷新", " · auto-refreshes within ~1 min after workspace changes; click chip to refresh now")) : "";
    return h + '<div class="rt-note">' + L("口径：改=已跟踪变更条目（含增删改名与冲突文件），新=未跟踪条目（目录折叠计 1，文件与目录混合计数）。仓库列表全量展开，超出屏幕可滚动。",
      "Units: mod = tracked-change entries (add/delete/rename/conflict), new = untracked entries (collapsed dirs count as 1). The repo list is fully expanded and scrolls when taller than the screen.") + "</div>";
  }
  function showGitTip(chip) {
    var view = chip && chip.__zuGit;
    if (stale() || !view || !chip.isConnected) { hideGitTip(); return; }
    /* 内容签名不变就跳过重建：enhanceGitChip 每 600ms 对账、每次推送都会走到这里，
     * 无条件重写 innerHTML 会打断滚动条拖拽并与滚轮滚动互抢（卡顿根因）；数据本身
     * 低频变化（fs watch 防抖驱动）， hover 期间几乎总是跳过。浅色档与位置每帧照常同步。 */
    var html = gitTipHTML(view);
    if (gitTip.__zuTipSig !== html) {
      var keep = 0;   // 重建时保持列表滚动位置（不重置阅读位置）
      if (gitTipFor === chip) { try { var prevRows = gitTip.querySelector(".zu-git-rows"); if (prevRows) keep = prevRows.scrollTop; } catch (e) { } }
      gitTip.innerHTML = html;
      gitTip.__zuTipSig = html;
      try { var rowsEl = gitTip.querySelector(".zu-git-rows"); if (rowsEl && keep) rowsEl.scrollTop = keep; } catch (e) { }
    }
    if (chip.getAttribute("data-zusage-light") === "1") gitTip.setAttribute("data-zusage-light", "1");   // 语义色浅色档随 chip 主题（与内容无关，每次同步）
    else gitTip.removeAttribute("data-zusage-light");
    gitTip.style.display = "block";
    var r = chip.getBoundingClientRect(), tw = gitTip.offsetWidth, th = gitTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th - 8;   // 优先弹在 chip 上方（工具行贴窗口底部）
    if (top < 8) top = Math.min(r.bottom + 8, vh - th - 8);
    gitTip.style.left = Math.round(left) + "px";
    gitTip.style.top = Math.round(top) + "px";
    gitTipFor = chip;
  }
  function hideGitTip() {
    clearTimeout(gitTipHideTimer);
    gitTip.style.display = "none";
    gitTipFor = null;
  }
  /* 鼠标从 chip 移入 tooltip 的宽限桥：延迟收起，移入即取消（支持移入悬浮内容继续阅读）；
   * Esc 关闭后 gitTipFor 已空，普通数据刷新不会重新弹出（只有再次悬停 chip 才会）。 */
  var gitTipHideTimer = 0;
  function hideGitTipSoon() {
    if (state.devKeepTip) return;   // 开发者常驻开关：不自动收，仅 Escape 手动关
    clearTimeout(gitTipHideTimer);
    gitTipHideTimer = setTimeout(hideGitTip, 200);
  }
  function onGitTipEnter() { clearTimeout(gitTipHideTimer); }
  function onGitKeydown(e) { if (e && e.key === "Escape") hideGitTip(); }
  function onRefreshKeydown(e) {
    if (e.key === "Enter") { e.preventDefault(); this.click(); }
    else if (e.key === " ") e.preventDefault();
  }
  function onRefreshKeyup(e) { if (e.key === " ") { e.preventDefault(); this.click(); } }
  window.addEventListener("keydown", onGitKeydown, true);
  gitTip.addEventListener("mouseenter", onGitTipEnter);
  gitTip.addEventListener("mouseleave", function () { if (!state.devKeepTip) hideGitTip(); });   // v424 开发者常驻不自动收（移出弹层本体同契约）
  /* chip 固定在 composer 工具行，消息流滚动不移动它，无需 rateTip 那样的 scroll 收起；离开/失焦即收 */
  function cleanupGitTip() {
    window.removeEventListener("keydown", onGitKeydown, true);
    clearTimeout(gitTipHideTimer);
    hideGitTip();
    gitTip.remove();
  }

  /* ---------- 系统状态 chip 的悬停说明（v356，issue #338）：gitTip 同款 document 级单例。
   * 内容=00 分片 sysmonTipHtml（与条面格通用链同一产出）；签名幂等 + 重建保磁盘表滚动位；
   * 浅色档随 chip data-zusage-light；Esc/离开/代际清理三链收起。 */
  var sysTip = document.createElement("div");
  sysTip.className = "tip zusage-sysmon-tip";
  sysTip.style.cssText = rateTip.style.cssText;
  document.body.appendChild(sysTip);
  var sysTipFor = null;
  var sysTipHideTimer = 0;
  function showSysTip(chip) {
    if (stale() || !chip || !chip.isConnected) { hideSysTip(); return; }
    var html = sysmonTipHtml(state.sysmonCfg, sysFrame);
    if (sysTip.__zuTipSig !== html) {
      var keep = 0;
      if (sysTipFor === chip) { try { var prevRows = sysTip.querySelector(".zu-sys-vols"); if (prevRows) keep = prevRows.scrollTop; } catch (e) { } }
      sysTip.innerHTML = html;
      sysTip.__zuTipSig = html;
      try { var rowsEl = sysTip.querySelector(".zu-sys-vols"); if (rowsEl && keep) rowsEl.scrollTop = keep; } catch (e) { }
      /* v362：帧刷新重建不收拢阈值说明展开区 */
      if (sysTip.__zuSysExp) {
        var expBox = sysTip.querySelector("[data-zu-sys-thexp]");
        var expBtn = sysTip.querySelector("[data-zu-sys-th]");
        if (expBox) expBox.hidden = false;
        if (expBtn) expBtn.setAttribute("aria-expanded", "true");
      }
    }
    if (chip.getAttribute("data-zusage-light") === "1") sysTip.setAttribute("data-zusage-light", "1");
    else sysTip.removeAttribute("data-zusage-light");
    sysTip.style.display = "block";
    placeSysTip(chip);
    sysTipFor = chip;
  }
  /* 定位（showSysTip 与 ⓘ 切换共用；v362：展开区 +~124px 后重钳防底边越出视口） */
  function placeSysTip(chip) {
    var r = chip.getBoundingClientRect(), tw = sysTip.offsetWidth, th2 = sysTip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(r.left, vw - tw - 8));
    var top = r.top - th2 - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - th2 - 8);
    sysTip.style.left = Math.round(left) + "px";
    sysTip.style.top = Math.round(top) + "px";
  }
  function hideSysTip() {
    clearTimeout(sysTipHideTimer);
    sysTip.style.display = "none";
    /* v362：关闭即收起阈值说明（标志与 DOM 同步复位）——签名未变跳过重建时，
     * 只清标志会让重开看到残留展开态（review MAJOR 修复） */
    sysTip.__zuSysExp = false;
    try {
      var expBox0 = sysTip.querySelector("[data-zu-sys-thexp]");
      var expBtn0 = sysTip.querySelector("[data-zu-sys-th]");
      if (expBox0) expBox0.hidden = true;
      if (expBtn0) expBtn0.setAttribute("aria-expanded", "false");
    } catch (eSysExp0) { }
    sysTipFor = null;
  }
  function hideSysTipSoon() { clearTimeout(sysTipHideTimer); sysTipHideTimer = setTimeout(hideSysTip, 200); }
  function onSysTipEnter() { clearTimeout(sysTipHideTimer); }
  function onSysKeydown(e) { if (e && e.key === "Escape") hideSysTip(); }
  window.addEventListener("keydown", onSysKeydown, true);
  sysTip.addEventListener("mouseenter", onSysTipEnter);
  sysTip.addEventListener("mouseleave", hideSysTip);
  /* v362：ⓘ 按下不移焦（镜像 06 全量 tip 链 mousedown 名单）——chip blur 链已加
   * relatedTarget 守卫，此处双保险覆盖无 relatedTarget 的合成路径 */
  sysTip.addEventListener("mousedown", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest("[data-zu-sys-th]") && e.preventDefault) e.preventDefault();
  });
  /* v362：点击 ⓘ 切换阈值说明内联展开区（只切 hidden 不重建，同全量 tip 链只挂 click）；
   * 切换后重定位防展开后底边越出视口 */
  sysTip.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-zu-sys-th]") : null;
    if (!btn) return;
    sysTip.__zuSysExp = !sysTip.__zuSysExp;
    var box = sysTip.querySelector("[data-zu-sys-thexp]");
    if (box) box.hidden = !sysTip.__zuSysExp;
    btn.setAttribute("aria-expanded", sysTip.__zuSysExp ? "true" : "false");
    if (sysTipFor && sysTipFor.isConnected) placeSysTip(sysTipFor);
  });
  function cleanupSysTip() {
    window.removeEventListener("keydown", onSysKeydown, true);
    clearTimeout(sysTipHideTimer);
    hideSysTip();
    sysTip.remove();
  }

