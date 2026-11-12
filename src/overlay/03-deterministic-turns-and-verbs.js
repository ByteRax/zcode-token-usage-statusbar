  /* ---------- 确定性历史行（v71）：完成的 turn 在消息流末尾插统计行 ----------
   * 数据来自 tracker（renderer store 投影），不再要求模型自跑统计脚本（hook 已去指令）。
   * 虚拟列表回收重挂后由扫描重建；旧消息（tracker 无记录）不补造；
   * 同容器已有模型历史统计行（isRateLine）则跳过，避免双行。 */
  var ZU_DET_FONT_SIZE = "0.8125rem";   // v78：宿主正文号偏大，用户要求缩小（13px）
  var detTimer = 0;
  /* v79：统计行在 turn 容器内的落点——hover 工具条之前、data-state="closed" 弹出层
   * 之后（工具条类名 opacity-0 … group-hover/assistant-turn:opacity-100，Tailwind
   * 类名含 : / [ ] 特殊字符，querySelector 转义易碎 → 按子节点 className 子串匹配）。
   * v82：新开会话的 turn 容器里工具条不在直接子层，嵌在 group/assistant-turn
   * flex w-full flex-col gap-5 → flex flex-col gap-5 内容列末尾——直接子层找不到时
   * 深度找工具条，insertBefore 落到锚点的父容器（即内容列内、工具条之上）。
   * 都找不到（宿主改版）回退 appendChild（旧行为，容器末尾）。 */
  function zuDetAnchor(box) {
    try {
      var kids = box.children, i, cls;
      for (i = kids.length - 1; i >= 0; i--) {
        cls = String(kids[i].className || "");
        if (cls.indexOf("group-hover/assistant-turn") >= 0 && cls.indexOf("opacity-0") >= 0)
          return kids[i];
      }
      var deep = box.querySelectorAll("div");
      for (var j = 0; j < deep.length; j++) {
        cls = String(deep[j].className || "");
        if (cls.indexOf("group-hover/assistant-turn") >= 0 && cls.indexOf("opacity-0") >= 0)
          return deep[j];
      }
      for (i = kids.length - 1; i >= 0; i--) {
        if (kids[i].getAttribute && kids[i].getAttribute("data-state") === "closed")
          return kids[i].nextSibling;   // null = 已到末尾，insertBefore(node, null) 即 append
      }
    } catch (e) { }
    return null;
  }
  function zuDetPlace(box, node) {
    try {
      var anchor = zuDetAnchor(box);
      if (anchor && anchor === node.nextSibling) return;   // 已在位（React 重排兜底快速路径）
      if (anchor) { anchor.parentElement.insertBefore(node, anchor); return; }   // v82：深度锚点挂锚的父容器
      if (node.parentElement !== box) box.appendChild(node);
    } catch (e) { FATAL.detErr = String((e && e.stack) || e); }
  }
  /* v258：桥缺席（表外客户端版本）时的辅助对话识别兜底：沿 React fiber 找宿主
   * SessionPane 组件帧的 tabId props（JSX 属性名不被压缩）。只读、限深 24 层、撞更外层
   * 会话/分栏根止步；返回宿主 tabId 或 ""（失败/歧义一律空串，fail-closed）。sidechat
   * 切片测试（richTextCache→zuDiagStats）覆盖本函数；coordinator 里的同文副本因
   * port-patches 切片与本区间不相交而无法共享，两处须同步改。 */
  function fiberSideIdOf(el) {
    try {
      var keys = Object.keys(el), fk = "";
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) { fk = keys[i]; break; }
      }
      if (!fk) return "";
      var fiber = el[fk], hit = "", depth = 0;
      while (fiber && depth++ < 24) {
        var node = fiber.stateNode;
        if (node && node !== el && node.getAttribute &&
            (node.hasAttribute("data-session-id") || node.hasAttribute("data-pane-id"))) break;
        var p = fiber.memoizedProps || fiber.pendingProps;
        if (p && typeof p.tabId === "string" && p.tabId.indexOf("selection-side-chat:") === 0) {
          if (hit && hit !== p.tabId) return "";
          hit = p.tabId;
        }
        fiber = fiber.return;
      }
      return hit;
    } catch (e) { return ""; }
  }
  /* 只接受唯一且最内层的会话根；根缺失或同根歧义时不借其他实例的数据。 */
  function detOwnerOf(box) {
    var owner = null, best = null;
    for (var i = 0; i < instances.length; i++) {
      var root = instances[i].detRoot && instances[i].detRoot();
      if (!root || !root.contains || !root.contains(box)) continue;
      if (!best || (best !== root && best.contains(root))) { owner = instances[i]; best = root; }
      else if (root === best || !root.contains(best)) return null;
    }
    /* 主根可能包住尚未挂载实例的侧聊；识别到侧聊边界时只能由对应侧聊实例认领。 */
    for (var p = box; p && p !== document.body; p = p.parentElement) {
      if (!p.getAttribute) continue;
      var testid = String(p.getAttribute("data-testid") || "");
      var side = testid.indexOf("v4-session-pane-selection-side-chat:") === 0 ? testid.slice("v4-session-pane-".length) : "";
      var bridgePid = String(p.getAttribute("data-zusage-pane-id") || "");
      if (!side && bridgePid.indexOf("selection-side-chat:") === 0 && p.getAttribute("data-zusage-scope-version") === "1") side = bridgePid;
      if (!side && p.getAttribute("data-zusage-scope-version") !== "1" &&
          p.hasAttribute && p.hasAttribute("data-session-id")) side = fiberSideIdOf(p);   // v258：宿主 testid 也缺失的表外版本兜底
      if (side) return owner && owner.pid === side && best === p ? owner : null;
    }
    return owner;
  }
  function detSeenKey(box, tid) {   // v174：同 owner 内按 tid 去重（嵌套容器），跨 owner 各自独立
    var owner = detOwnerOf(box);
    return owner ? owner.pid + "|" + tid : null;
  }
  function detStatsFor(box, tid) {
    var owner = detOwnerOf(box);
    return owner ? owner.statsFor(tid) : null;
  }
  /* 节点只保存不透明令牌，不暴露 SID、工作区或远端身份。tracker 换代不改变令牌。 */
  var detOwnerTokens = new WeakMap();
  function detOwnerToken(owner) {
    if (!owner || !owner.getSid || !owner.getScope) return null;
    var sid = owner.getSid(), scope = owner.getScope();
    if (!sid || (scope && scope.sid !== sid)) return null;
    var side = String(owner.pid).indexOf("selection-side-chat:") === 0;
    if (side && (!scope || scope.identity !== "" || scope.remoteSessionId !== "")) return null;
    var identity = scope ? JSON.stringify([sid, scope.identity, scope.workspacePath, scope.remoteSessionId]) : JSON.stringify([sid, "no-pane-scope"]);
    var entry = detOwnerTokens.get(owner);
    if (!entry || entry.identity !== identity) {
      entry = { identity: identity, token: {} };
      detOwnerTokens.set(owner, entry);
    }
    return entry.token;
  }
  function scanDeterministicLines() {
    if (stale()) return;
    try {
      if (!state.rateLine || !TURN_STATS) {   // 开关关闭：撤下自己插的行（模型历史行不动）
        document.querySelectorAll("[data-zusage-deterministic]").forEach(function (el) { el.remove(); });
        return;
      }
      /* 两种选择器可能同时命中同一个 turn（外层 [data-v4-turn-unit] 包着内层
       * section，二者带同一个 data-turn-id）：按 owner+tid 去重（v174：辅助对话与
       * 主分栏并存时不同会话可能同名 tid，纯 tid 去重会吞掉第二个视图的行），
       * section 更具体，优先用它当容器，避免同一轮被当成两个独立容器各插一条。 */
      var boxes = [], seen = {};
      document.querySelectorAll("section[data-turn-id]").forEach(function (el) {
        var t = el.getAttribute("data-turn-id");
        var key = t && detSeenKey(el, t);
        if (t && (!key || !seen[key])) { if (key) seen[key] = 1; boxes.push(el); }
      });
      document.querySelectorAll("[data-v4-turn-unit][data-turn-id]").forEach(function (el) {
        var t = el.getAttribute("data-turn-id");
        var key = t && detSeenKey(el, t);
        if (t && (!key || !seen[key])) { if (key) seen[key] = 1; boxes.push(el); }
      });
      /* v86 诊断（≥10s 一次写 __zusageDiag.det，主进程泵取回写 diag-<n>.json）：每轮容器的行类型
       * （rich/ph/na/keep/model/none）与 tracker 视图、各 pane 的桥接快照窗口——排"历史轮不可用"类问题用 */
      var wantDiag = Date.now() - (scanDeterministicLines.diagAt || 0) > 10000, diagTurns = wantDiag ? [] : null;
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        var tid = box.getAttribute && box.getAttribute("data-turn-id");
        if (!tid) continue;
        var owner = detOwnerOf(box), ownerToken = detOwnerToken(owner);
        var mine = null;
        try { mine = box.querySelector("[data-zusage-deterministic]"); } catch (e) { }
        if (mine && (!ownerToken || mine.__zuDetOwner !== ownerToken)) { mine.remove(); mine = null; }
        if (!ownerToken) continue;
        var richKey = zuRichKey(owner, tid);
        var rec = diagTurns ? { tid: tid.slice(-8) } : null;
        if (rec) diagTurns.push(rec);
          if (mine) {
            /* 已插过：重挂/数据演进后从 tracker 重建文本；观测过但记录已清（换代）、
             * 或完成但确实零输出（无意义数字，如"耗时 939.0s"配"输出 0 token"）则明示不可用 */
            var again = detStatsFor(box, tid);   // v174：按实例归属取数，不跨实例首命中
          var againOk = !!again && again.complete && zuHasMeaningfulOutput(again);
          if (!againOk && again && again.isCompact) {
            /* v230 压缩轮（轮内带 compact 类 timelineMarker）：无正文的辅助轮，消耗已计入
             * 今日/会话累计，宿主「上下文已压缩」提示已承载语义——旧版误插的「本轮统计不可用」
             * 撤下，不再误导（marker 未来带输出数字时 againOk 成立，仍照常显示）。
             * tracker 无记录时走下方 v86 保留分支。 */
            mine.remove();
            if (rec) { rec.line = "compact"; rec.st = zuDiagStats(again); }
            continue;
          }
          if (!againOk && !(again && again.observedLive)) {
            /* v86：tracker 无记录（快照窗口滑出/store 换代/热更新换 tracker）或重绑后一步到位捞到的
             * 历史存量轮缺 outputTokens（缺字段 ≠ 零输出）——都不据此改判"不可用"：已完成轮的数字不会
             * 过时，保留已有占位/富文本；此前误插的"不可用"行直接撤下。仅亲历过的真实零输出轮仍明示 */
            var keptLine = mine.querySelector("p") || mine;
            if (richTextCache[richKey]) {
              if ((keptLine.textContent || "") !== richTextCache[richKey]) keptLine.textContent = richTextCache[richKey];
              if (!keptLine.style.fontSize) keptLine.style.fontSize = ZU_DET_FONT_SIZE;
              zuDetPlace(box, mine);
            } else if (zuIsUnavailableText(keptLine.textContent)) mine.remove();
            else zuDetPlace(box, mine);
            if (rec) { rec.line = richTextCache[richKey] ? "rich" : "keep"; rec.st = zuDiagStats(again); }
            continue;
          }
          var againText = againOk ? zuFinalText(again) : zuUnavailableText();
          if (againOk) zuRequestTurnText(owner, tid, again);   // 仍缺富文本就补发（限流见函数内）
          var text = richTextCache[richKey] || againText;
          var line = mine.querySelector("p") || mine;
          if ((line.textContent || "") !== text) line.textContent = text;
          if (!line.style.fontSize) line.style.fontSize = ZU_DET_FONT_SIZE;   // 旧代节点补样式（热更间隙）
          zuDetPlace(box, mine);   // React 重排后兜住用户指定位置（工具条之前）
          if (rec) { rec.line = richTextCache[richKey] ? "rich" : (againOk ? "ph" : "na"); rec.st = zuDiagStats(again); }
          continue;
        }
        var hasModel = false;
        try {
          box.querySelectorAll("blockquote p, blockquote, p").forEach(function (el) {
            if (!hasModel && isRateLine(el)) hasModel = true;
          });
        } catch (e) { }
        if (hasModel) { if (rec) rec.line = "model"; continue; }   // 模型历史统计行在位：不叠双行
        var stats = detStatsFor(box, tid);   // v174：按实例归属取数，不跨实例首命中
        if (rec) { rec.line = "none"; rec.st = zuDiagStats(stats); }
        if (!stats || !stats.complete) continue;   // 未完成 / 旧消息（tracker 无记录）不插
        var statsOk = zuHasMeaningfulOutput(stats);
        if (!statsOk && !stats.observedLive && !richTextCache[richKey]) continue;   // v86：历史零值或缺字段不判失败；已缓存的完整统计仍可重建
        if (!statsOk && stats.isCompact && !richTextCache[richKey]) continue;   // v230：压缩轮零输出不插「不可用」行（宿主压缩提示已承载语义；rec.line 已在上面记 none）
        var quote = document.createElement("blockquote");
        quote.__zuDetOwner = ownerToken;
        quote.dataset.zusageDeterministic = "1";
        var p = document.createElement("p");
        p.dataset.zusageDeterministic = "1";
        /* 样式基本交还宿主默认（模型时代贴的 Markdown 引用块就是这套渲染：彩色 ⚡、
         * 正文亮度、引用线）；唯一例外字号（v78）：用户反馈宿主正文号太大，内联缩到
         * 0.8125rem（13px）。必须内联——本节点长在宿主消息流 prose 容器内，bar 内部
         * 样式表够不着，挂 head 的外来样式又会被 React 清掉（历史根因）。 */
        p.style.fontSize = ZU_DET_FONT_SIZE;
        if (statsOk) zuRequestTurnText(owner, tid, stats);   // 先占位，向主进程要这轮的数据库富文本
        p.textContent = richTextCache[richKey] || (statsOk ? zuFinalText(stats) : zuUnavailableText());
        if (rec) rec.line = richTextCache[richKey] ? "rich" : (statsOk ? "ph" : "na");
        quote.appendChild(p);
        zuDetPlace(box, quote);
      }
      zuFlushRichTextWants();   // v174：收集完毕统一发起（同 SID 只追最新未缓存轮）
      if (wantDiag) {
        scanDeterministicLines.diagAt = Date.now();
        FATAL.det = {
          time: new Date().toISOString(), boxes: boxes.length, rich: Object.keys(richTextCache).length,
          rt: { sent: richTextDiag.sent, ok: richTextDiag.ok, empty: richTextDiag.empty,
            miss: richTextDiag.miss, stale: richTextDiag.stale,
            spawn: richTextDiag.spawn, timeout: richTextDiag.timeout, pyerr: richTextDiag.pyerr },   // v343 issue #321：回推失败可观测（spawn/timeout/pyerr 需主进程同版）
          bridge: instances.map(function (inst) { return inst.bridgeInfo ? inst.bridgeInfo() : null; }),
          turns: diagTurns.slice(0, 40),
        };
      }
    } catch (e) { FATAL.detErr = String((e && e.stack) || e); }
  }
  function zuDiagStats(s) {
    return s ? { c: s.complete ? 1 : 0, live: s.observedLive ? 1 : 0, out: s.outputTokens, st: s.state,
      sa: s.startedAt, ea: s.endedAt, mm: s.modelMs, dm: s.durationMs,
      ic: s.isCompact ? 1 : undefined,   // v230：压缩轮标记（timelineMarker type=compact）
      ks: s.kinds ? s.kinds.join(",") : undefined,   // v230：轮内行 kind 集合（排"压缩轮为何不可用"类问题）
      tmr: s.tmr && s.tmr.length ? s.tmr : undefined } : null;   // v230：timelineMarker 内容（区分压缩/模型切换）
  }
  function cleanupDeterministic() {
    clearInterval(detTimer);
    zuResetRichText();
    try {
      document.querySelectorAll("[data-zusage-deterministic],[data-zusage-loading-status]").forEach(function (el) { el.remove(); });
    } catch (e) { }
  }
  /* ---------- 工具动词表（v76 引入，v78 起仅悬浮条合并 chip 使用）：zuBarSpeedView
   * 在工具执行期显示"正在读取 · 1.2s"同款状态词，数据源为桥接 tracker 的 runningTool
   * （本轮最后一个活动行=进行中的工具调用，宿主从 tool_input_start 起算"进行中"）。
   * v76 的消息流 loading 插槽插入（[data-zusage-loading-status]）已删，见 zuToolVerb 下方注。 */
  var ZU_TOOL_VERBS = {
    Read: ["读取中", "Reading"],
    Write: ["写入中", "Writing"], Edit: ["编辑中", "Editing"], ApplyPatch: ["编辑中", "Editing"],
    Bash: ["执行中", "Executing"],
    Grep: ["搜索中", "Searching"], Glob: ["搜索中", "Searching"],
    WebSearch: ["搜索中", "Searching"], web_search: ["搜索中", "Searching"],
    WebFetch: ["获取网页中", "Fetching page"],
    TodoWrite: ["更新待办中", "Updating todos"], TodoRead: ["读取待办中", "Reading todos"],
    Skill: ["运行技能中", "Running skill"],
    ReadSessionContext: ["读取上下文中", "Reading context"],
    Agent: ["子代理运行中", "Running agent"], Task: ["子代理运行中", "Running agent"],
    SendMessage: ["发送消息中", "Sending message"],
    TaskOutput: ["获取任务输出中", "Fetching task output"],
    TaskStop: ["停止任务中", "Stopping task"],
    CreateWorkflow: ["编写工作流中", "Writing workflow"],
  };
  function zuToolVerb(name) {
    if (name && ZU_TOOL_VERBS[name]) { var pair = ZU_TOOL_VERBS[name]; return L(pair[0], pair[1]); }
    if (name && name.indexOf("mcp__computer-use__") === 0) return L("正在操作电脑", "Operating computer");
    if (name && name.indexOf("mcp__") === 0)
      return L("正在调用 " + name.slice(5).replace(/__/g, " · "), "Calling " + name.slice(5).replace(/__/g, " · "));
    if (name && name.indexOf("js") === 0) return L("正在执行代码", "Executing code");
    return name ? L("执行中 " + name, "Executing " + name) : L("执行中", "Executing");
  }
  /* v158：Skill 工具从输入串提取技能显示名（宿主 inputText 是 JSON，name 字段为技能
   * 请求名）——状态词显示「技能名·执行中」；解析失败/超限返回空回退「运行技能中」。
   * 名字来自宿主数据，渲染前经 ttEsc（chip innerHTML 与 aria 双 sink）。 */
  function zuSkillBaseName(inputText) {
    if (!inputText) return "";
    var name = "";
    try { var parsed = JSON.parse(inputText); if (parsed && typeof parsed.name === "string") name = parsed.name; } catch (e) { }
    if (!name) { var m = /"name"\s*:\s*"([^"]{1,80})"/.exec(inputText); if (m) name = m[1]; }
    name = String(name).trim();
    if (!name || /[\x00-\x1f]/.test(name)) return "";
    return name;
  }
  function zuSkillName(inputText) {
    var name = zuSkillBaseName(inputText);
    if (!name) return "";
    if (name.length > 24) name = name.slice(0, 24) + "…";
    return name;
  }
  /* v78：消息流 loading 状态词（v76 的 [data-zusage-loading-status] 插槽插入）已删——
   * 悬浮条合并 chip 在工具执行期仍显示同款动词+耗时（zuBarSpeedView），消息流内不再插节点。
   * 清理选择器保留（根清理 + dispose）：热更/重载后把旧版本可能残留的 span 清干净。 */
  function sharedTick() {
    if (stale()) return;
    scanDeterministicLines();
  }
  detTimer = setInterval(sharedTick, 500);   // v88：2s→0.5s，与速率行扫描/心跳同节奏
  sharedTick();

  var mpModalDispose = null;   // v128 模型拉取弹窗清理回调（openMpModal 注册，disposeOverlay 调用）
  var mpModalThemeSync = null;   // v132 弹窗浅色主题同步回调（openMpShell 注册，applyTheme 调用）
  function disposeOverlay() {
    if (disposed) return;
    disposed = true;
    pluginRequestCallbacks = {};
    clearTimeout(bootTimer);
    clearInterval(coordinatorTimer);
    instances.forEach(function (inst) { inst.dispose(); });
    instances = [];
    quotaSelectionsSig = "";
    pluginRequest("quota-providers", { panes: {} });
    cleanupRateTip();
    cleanupGitTip();
    document.removeEventListener("mouseover", subTipDocOver, true);   // v176：委托悬停随 dispose 摘除
    document.removeEventListener("mouseout", subTipDocOut, true);
    hideSubTip();
    try { if (subTip.parentElement) subTip.remove(); } catch (e) { }
    if (mpModalDispose) mpModalDispose();
    cleanupDeterministic();
    if (typeof zuRotatorDisposeAll === "function") zuRotatorDisposeAll();
    window.__zusageWantSids = [];
    window.__zusageWantSid = "";
    window.__zusageGitPaths = [];   // v96：主进程下轮 tick 读到空集即停查
    delete window.__zusageSpdMonRect;   // v297 动态字号量测缓存随代际清理，防旧格尺寸误读新布局（review 修复）
    if (window.__zusageDispose === disposeOverlay) {
      delete window.__zusageDispose;
      delete window.__zusageUpdate;
      delete window.__zusagePluginUpdate;
      delete window.__zusagePluginResult;
      delete window.__zusageGitState;
      delete window.__zusageDeliverTurnText;   // 旧代闭包经 stale() 自卫，但清理应完整（O8）
      delete window.__zusageSidWs;
      delete window.__zusagePaneScopes;
      window.__zusageOverlay = false;
    }
  }
  window.__zusageDispose = disposeOverlay;
  bootTimer = setTimeout(function () {
    if (stale()) return;
    try { coordinator(); } catch (e) {
      FATAL.fatal = String((e && e.stack) || e);
      var b = document.getElementById("zusage-bar");
      if (b) b.style.cssText = "position:fixed;right:16px;bottom:16px;font:12px monospace;color:#ff7a59;" +
        "background:#1a0f0d;border:1px solid #ff7a59;border-radius:6px;padding:4px 10px;z-index:2147483647";
    }
  }, 0);










