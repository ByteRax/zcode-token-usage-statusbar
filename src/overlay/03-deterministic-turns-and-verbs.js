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
  function zuDetBuildLine(ownerToken, tid, text) {
    /* 样式基本交还宿主默认（模型时代贴的 Markdown 引用块就是这套渲染：彩色 ⚡、
     * 正文亮度、引用线）；唯一例外字号（v78）：用户反馈宿主正文号太大，内联缩到
     * 0.8125rem（13px）。必须内联——本节点长在宿主消息流 prose 容器内，bar 内部
     * 样式表够不着，挂 head 的外来样式又会被 React 清掉（历史根因）。 */
    var quote = document.createElement("blockquote");
    quote.__zuDetOwner = ownerToken;
    quote.__zuDetTid = tid;   // v345：宽限只给仍属同一 tid 的行
    quote.dataset.zusageDeterministic = "1";
    var p = document.createElement("p");
    p.dataset.zusageDeterministic = "1";
    p.style.fontSize = ZU_DET_FONT_SIZE;
    p.textContent = text;
    quote.appendChild(p);
    return quote;
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
    /* v458 子代理窗格（specs/subagent-turn-stats-line.md）：无实例认领的 box 回退观察器
     * （发现即建、按 sid 幂等；窗格根=最近 sess_subagent_ 会话根，与实例 root 天然不嵌套）。 */
    if (!owner) {
      var sub = zuSubDetEnsure(box);
      if (sub) {
        var subRoot = sub.detRoot();
        if (subRoot && subRoot.contains(box)) { owner = sub; best = subRoot; }
      }
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
  /* ===== v458 子代理窗格统计行（specs/subagent-turn-stats-line.md）：伪 owner 观察器 =====
   * 子代理窗格（sess_subagent_* 只读分栏）没有 overlay 实例，det 链的实例归属/请求门/
   * 投递门三处都进不去。观察器以 sid 为键实现 owner 接口（getSid/getScope/detRoot/
   * statsFor/isCurrentTurn/bridgeInfo），detOwnerOf 与实例同规则认领——扫描、占位行、
   * 富文本回推整套既有机制复用（诊断只加一个 sub 段）。身份取窗格自身（zuSubDetPaneScope）：远端或
   * 带身份的窗格一律不认领，不借本地实例的身份去查本地库（issue #40 的 fail-closed 同款）。
   * store 走子代理速率槽位同款双路径（注册表按本地键精确直绑 → 桥 v2 acquire 租约，
   * refcount、dispose 时 off 释放）。发现搭 detOwnerOf 的无归属回退便车（零新增文档级
   * 查询），生命周期清理搭 sharedTick 便车（零新增定时器）；活跃轮号在订阅回调里推送
   * 缓存（isCurrentTurn 不读 store——issue #309 纪律：v2 桥 getState 是 O(window) 深拷贝，
   * 禁入周期调用路径）。富文本请求带页面轮号（02 分片 turnRef → 主桥 --turn-ref）：只认
   * 窗格里这一轮、且该轮已结束才出数——别的轮、进行中的轮、库还没追上的轮都取不到，
   * 不会挂错轮，也不会把半截统计缓存成定稿。 */
  var zuSubDetPanes = {};
  function zuSubDetPaneList() {
    var list = [];
    for (var sid in zuSubDetPanes) list.push(zuSubDetPanes[sid]);
    return list;
  }
  function zuSubDetHasOwner(owner) {   // 02 分片 noInst/stale 门放行观察器 owner（切片测试无 03 分片时调用方 typeof 守卫）
    if (!owner) return false;
    for (var sid in zuSubDetPanes) if (zuSubDetPanes[sid] === owner) return true;
    return false;
  }
  function zuSubDetDiag() {   // panes=窗格数，bound=已绑定 store 数，retrying=未绑定（拿不到 store 或绑定失败，等 2s 重试）
    var bound = 0, n = 0;
    for (var sid in zuSubDetPanes) { n++; if (zuSubDetPanes[sid].store) bound++; }
    return { panes: n, bound: bound, retrying: n - bound };
  }
  function zuSubDetPaneScope(root) {   // 窗格自身的本地 scope；远端 / 带身份 / 无法确认本地 → null（不认领）
    if (root.getAttribute("data-zusage-scope-version") === "1") {
      /* 桥写在会话根上的 scope 属性（与 readPaneScope 同一来源；比它少核对一项 paneId）。paneId 不核对：
       * 观察器没有宿主 pane 身份，根节点本身就是窗格，这些属性与 data-session-id 同节点同写。 */
      var path = root.getAttribute("data-zusage-workspace-path"), identity = root.getAttribute("data-zusage-workspace-identity"), remote = root.getAttribute("data-zusage-remote-session-id");
      if (typeof path !== "string" || !path.trim() || typeof identity !== "string" || typeof remote !== "string" ||
          /[\x00-\x1f\x7f]/.test(path + identity + remote) || identity.trim() || remote) return null;
      return { workspacePath: path };
    }
    /* 桥缺席（表外宿主 / 补装失败）时的退路：仅当本窗口每一个实例的 scope 都是已验证的本地
     * scope 才认领——实例里有远端分栏，或任何一个实例的 scope 不明，就不认领；实例分布在
     * 多个本地工作区时分不清窗格属于哪一个，同样不认领。只看得见 overlay 实例：没有实例的
     * 远端分栏识别不了（规格已知限制）。 */
    if (!instances.length) return null;
    var local = null;
    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i], sc = inst.getScope ? inst.getScope() : null;
      var path = sc ? sc.workspacePath : null;
      if (!sc || sc.identity || sc.remoteSessionId ||
          typeof path !== "string" || !path.trim() || /[\x00-\x1f\x7f]/.test(path)) return null;
      if (local === null) local = path; else if (local !== path) return null;
    }
    return { workspacePath: local };
  }
  function zuSubDetBind(w) {   // 注册表按本地键精确直绑 → 桥 v2 acquire 租约；失败 2s 重试（同 subSlotReset 纪律）
    /* 永不抛：它跑在扫描（detOwnerOf 的无归属回退）与 sharedTick 两条周期路径上，抛了会打断主会话的
     * 扫描。任何一步失败——拿不到 store、订阅时抛异常、拿不到退订函数、订阅的同步首跑身份不符——都把
     * 已经拿到的订阅、租约与 tracker 当场放掉再重试，不挂在观察器上（租约泄漏；真实 subscribeStore
     * 的退订函数自己会 dispose tracker，拿不到退订函数时由这里兜底）。 */
    var store = null, tracker = null, off = null, fail = false;
    try {
      store = zuTryBindStore(w.getSid(), w.scope) || zuAcquireSubStore(w.getSid(), w.scope);
      if (!store) { w.retryAt = Date.now() + 2000; return; }
      tracker = TURN_STATS.createTracker();
      off = TURN_STATS.subscribeStore(store, tracker, function (st) {
        if (w.dead) return;
        var snap = st && st.snapshot;
        if (!snap || snap.sessionId !== w.getSid()) {
          if (!w.store) { fail = true; return; }   // 订阅的同步首跑就身份不符（观察器尚未入册）：按绑定失败处理，不带着别的会话的 store 入册
          zuSubDetPaneDispose(w.getSid());          // 绑定之后收到别的会话的快照：关闭/换代，整观察器撤除待重发现
          return;
        }
        w.activeTid = zuActiveTurnId(snap);
      });
      /* subscribeStore 会同步先跑一次回调：首跑身份不符时回调已把 fail 置位。 */
      if (!off || w.dead) fail = true;
    } catch (e) { fail = true; }
    if (fail) {
      try { if (off) off(); } catch (e) { }
      try { if (store && store.off) store.off(); } catch (e) { }
      try { if (tracker) tracker.dispose(); } catch (e) { }
      w.retryAt = Date.now() + 2000;
      return;
    }
    w.store = store; w.tracker = tracker; w.off = off;
  }
  function zuSubDetPaneDispose(sid) {
    var w = zuSubDetPanes[sid];
    if (!w) return;
    w.dead = true;
    try { if (w.off) w.off(); } catch (e) { }
    try { if (w.store && w.store.off) w.store.off(); } catch (e) { }
    try { if (w.tracker) w.tracker.dispose(); } catch (e) { }
    delete zuSubDetPanes[sid];
  }
  function zuSubDetDisposeAll() {   // cleanupDeterministic/主开关关闭链：租约全释放（发现门随之停开）
    for (var sid in zuSubDetPanes) {
      var w = zuSubDetPanes[sid];
      w.dead = true;
      try { if (w.off) w.off(); } catch (e) { }
      try { if (w.store && w.store.off) w.store.off(); } catch (e) { }
      try { if (w.tracker) w.tracker.dispose(); } catch (e) { }
    }
    zuSubDetPanes = {};
  }
  function zuSubDetPaneTick() {   // sharedTick 便车：只巡注册表（零文档级查询）；发现走 detOwnerOf 无归属回退
    if (stale()) return;
    for (var sid in zuSubDetPanes) {
      var w = zuSubDetPanes[sid];
      if (w.dead || !w.root.isConnected) { zuSubDetPaneDispose(sid); continue; }
      if (!w.store && Date.now() >= (w.retryAt || 0)) zuSubDetBind(w);
    }
  }
  function zuSubDetEnsure(box) {   // detOwnerOf 无归属回退：最近会话根=sess_subagent_ 时建观察器（按 sid 幂等）
    var p = box;
    while (p && p !== document.body) {
      if (p.hasAttribute && p.hasAttribute("data-session-id")) {
        var sid = p.getAttribute("data-session-id") || "";
        if (/^sess_subagent_[A-Za-z0-9_-]{1,72}$/.test(sid)) {
          if (!zuSubDetPanes[sid]) {
            var scope = zuSubDetPaneScope(p);
            if (scope) zuSubDetPanes[sid] = zuSubDetPaneCreate(sid, p, scope);
          }
          return zuSubDetPanes[sid] || null;
        }
        return null;   // 最近会话根不是子代理窗格：不越级认领
      }
      p = p.parentElement;
    }
    return null;
  }
  function zuSubDetPaneCreate(sid, root, scope) {
    var w = {
      pid: "subagent-pane:" + sid, root: root, scope: scope, store: null, tracker: null, off: null,
      activeTid: "", retryAt: 0, dead: false,
      getSid: function () { return sid; },
      getScope: function () { return { sid: sid, identity: "", workspacePath: scope.workspacePath, remoteSessionId: "" }; },
      detRoot: function () { return root.isConnected ? root : null; },
      statsFor: function (tid) { try { return w.tracker ? w.tracker.get(tid) : null; } catch (e) { return null; } },
      isCurrentTurn: function (tid) { return !!tid && tid === w.activeTid; },   // 活跃轮号由订阅回调推送缓存（不读 store）
      bridgeInfo: function () { return { subPane: sid.slice(-8), bound: !!w.store }; }
    };
    zuSubDetBind(w);
    return w;
  }
  function zuSubDetIsLastTurnBox(w, box) {   // 窗格最后一轮判定（纯 DOM 判据，不依赖桥快照）：存量轮（tracker 无记录）只给窗格最后一轮发查询——没有 tracker 完成态可依的轮，其余与主会话一致不出行；查询本身按页面轮号精确定位这一轮。快照里没有该窗格 turnHeader 时（冷窗格）activeTid 恒空，isCurrentTurn 门不可用，故用 DOM 判据
    var root = w.detRoot();
    if (!root || !box.getAttribute) return false;
    var tid = box.getAttribute("data-turn-id");
    if (!tid) return false;
    var list = root.querySelectorAll("[data-turn-id]");
    for (var i = list.length - 1; i >= 0; i--) {
      var el = list[i], t = el.getAttribute && el.getAttribute("data-turn-id");
      if (!t) continue;
      return t === tid && (el === box || el.contains(box) || box.contains(el));   // 嵌套容器（v4 单元包 section）同 tid 均算最后一轮
    }
    return false;
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
  var ZU_DET_NULL_GRACE = 3, ZU_DET_NULL_MS = 1000;   // v345 issue #327：令牌连续取不到的拍数且墙钟都达标才撤行（扫描 0.5s/拍）
  var zuDetScanSeq = 0;   // 扫描序号：同一次扫描内同一行被多个 box 命中时只计一次
  function zuDetNullOwner(owner, count) {   // 带行的 box 令牌为空时归因并（count 时）计数：owner=无归属实例（含侧聊边界/同根歧义），sid=实例无会话，scope=scope 与 sid 不符/侧聊远端；返回原因
    var n = scanDeterministicLines.nulls, why = !owner || !owner.getSid ? "owner" : (!owner.getSid() ? "sid" : "scope");
    if (count) n[why]++;
    return why;
  }
  function scanDeterministicLines() {
    if (stale()) return;
    zuDetScanSeq++;
    try {
      if (!state.rateLine || !TURN_STATS) {   // 开关关闭：撤下自己插的行（模型历史行不动）
        document.querySelectorAll("[data-zusage-deterministic]").forEach(function (el) { el.remove(); });
        zuSubDetDisposeAll();   // v458：子代理窗格观察器的租约与订阅一并释放（扫描停了没人再收它们；开关重开时 detOwnerOf 重新发现）
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
        /* v345 issue #327：令牌瞬时取不到（getSid 空串、实例重绑、同根歧义）的单拍里，已验证归属的行
         * 宽限再撤——此前当拍整块 remove 且 continue 不重建，逐拍抖动即约 0.5s 一档的消失/重现
         * （块高归零、下方内容跳动）。宽限只给「证据缺席」型空令牌（reason=owner 无归属实例 / sid
         * 实例暂无会话）且行仍属同一 tid（__zuDetTid，防虚拟列表复用节点滞留旧轮文本）：连续
         * ZU_DET_NULL_GRACE 拍且跨过 ZU_DET_NULL_MS 才撤（扫描另有富文本回执/设置开关同步调用，
         * 纯拍数可能被爆发耗尽；纯墙钟又会被后台节流拉长，故两者并取）。scope 与 sid 不符/侧聊
         * 远端是「属于别的会话」的反证，归属换成另一个有效令牌（SID/scope 切换）、无 __zuDetOwner
         * 或 __zuDetTid 的遗留行无法证明归属，均仍即时撤——fail-closed 对这些情形不松动。 */
        if (mine && !ownerToken) {
          /* fresh：同一次扫描里外层 [data-v4-turn-unit] 与内层 section 可命中同一行（owner 为空时 detSeenKey
           * 不去重），按扫描序号只推进一次计数/计时/诊断，否则拍数门与 nullOwner 数字翻倍。 */
          var nullFresh = mine.__zuDetNullSeq !== zuDetScanSeq, nullWhy = zuDetNullOwner(owner, nullFresh);
          if (nullWhy !== "scope" && mine.__zuDetOwner && mine.__zuDetTid === tid) {
            if (nullFresh) {
              mine.__zuDetNullSeq = zuDetScanSeq;
              if (!mine.__zuDetNull) { mine.__zuDetNull = 0; mine.__zuDetNullAt = Date.now(); }
              mine.__zuDetNull++;
            }
            var nullDt = Date.now() - mine.__zuDetNullAt;   // 负值=系统时钟回拨：视为到期，免得行无限滞留
            if (mine.__zuDetNull < ZU_DET_NULL_GRACE || (nullDt >= 0 && nullDt < ZU_DET_NULL_MS)) {
              if (nullFresh) scanDeterministicLines.nulls.grace++;
              continue;
            }
          }
        }
        if (mine && (!ownerToken || mine.__zuDetOwner !== ownerToken)) {
          scanDeterministicLines.nulls[ownerToken ? "swap" : "removed"]++;   // swap=非空令牌换代撤旧（同拍重建），removed=空令牌撤行
          mine.remove(); mine = null;
        }
        if (!ownerToken) continue;
        if (mine) mine.__zuDetNull = 0;
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
        /* v458：观察器 owner 的窗格存量轮（观察器绑定前已完成，tracker 无记录）——tracker 门放行
         * 为「纯富文本轮」：缓存命中直接插行；未命中且是窗格最后一轮才发查询、**不插占位**
         * （deliver 空回执不写缓存 → 该轮没结束、库还没追上或旧主桥降级时永不插行，与「未观测
         * 轮不插行」现状一致，绝不显示误导性的「本轮统计不可用」）。请求带页面轮号（02 分片
         * turnRef → 主桥 --turn-ref），取回的就是这一轮自己的富文本，不是「最新一轮」：别的轮
         * 取不到，进行中的轮要等它结束才有。富文本到达后重扫经本分支插行，再往后的拍次由
         * 上方 v86 keep 分支自维持。主会话实例（zuSubDetHasOwner 判否）不受影响，走下方既有
         * tracker 门。 */
        if (!stats && typeof zuSubDetHasOwner === "function" && zuSubDetHasOwner(owner)) {
          if (richTextCache[richKey]) {
            zuDetPlace(box, zuDetBuildLine(ownerToken, tid, richTextCache[richKey]));
            if (rec) rec.line = "rich";
          } else if (zuSubDetIsLastTurnBox(owner, box)) {
            zuRequestTurnText(owner, tid, { sessionId: owner.getSid() });   // 最小替身：zuRequestTurnText 只读 sessionId（noSid 门）
          }
          if (rec && !rec.line) rec.line = "subwait";
          continue;
        }
        if (!stats || !stats.complete) continue;   // 未完成 / 旧消息（tracker 无记录）不插
        var statsOk = zuHasMeaningfulOutput(stats);
        if (!statsOk && !stats.observedLive && !richTextCache[richKey]) {
          /* v467：切回补捞的完成轮（重绑新建 tracker 后非亲历）在窗口头部行缺真实输出数
           * 时的静默跳过，会让「离开期间完成的回答」永远没有统计行（真机 diag 实证缺失轮
           * 清一色 live:0/out:0/line:none——宿主快照只有最近完成轮带 outputTokens）。改为
           * 仍是实例活跃轮（无更新轮顶替，--current 语义正确定位这一轮）且非压缩轮时按
           * 既有 --current 通道要富文本（最小替身只带 sessionId），到达后下一拍经下方
           * 缓存穿越插入；不插占位——空回执不写缓存即永不插行（v458 存量轮同契约），
           * 用户新提问后 promptTs 前移、旧轮回执为空自然放弃。被顶替/压缩轮维持 v86/v230
           * 静默（flush notCur 门兜底；rec.line 停在 none）。 */
          if (!stats.isCompact && owner.isCurrentTurn && owner.isCurrentTurn(tid)) {
            if (zuRequestTurnText(owner, tid, { sessionId: owner.getSid() }) && rec) rec.line = "backwait";   // noSid 门只读 sessionId；未入队（尝试耗尽/身份拒绝）不标等回执
          }
          continue;
        }
        if (!statsOk && stats.isCompact && !richTextCache[richKey]) continue;   // v230：压缩轮零输出不插「不可用」行（宿主压缩提示已承载语义；rec.line 已在上面记 none）
        if (statsOk) zuRequestTurnText(owner, tid, stats);   // 先占位，向主进程要这轮的数据库富文本
        zuDetPlace(box, zuDetBuildLine(ownerToken, tid, richTextCache[richKey] || (statsOk ? zuFinalText(stats) : zuUnavailableText())));
        if (rec) rec.line = richTextCache[richKey] ? "rich" : (statsOk ? "ph" : "na");
      }
      zuFlushRichTextWants();   // v174：收集完毕统一发起（同 SID 只追最新未缓存轮）
      if (wantDiag) {
        scanDeterministicLines.diagAt = Date.now();
        FATAL.det = {
          time: new Date().toISOString(), boxes: boxes.length, rich: Object.keys(richTextCache).length,
          rt: { sent: richTextDiag.sent, ok: richTextDiag.ok, empty: richTextDiag.empty,
            miss: richTextDiag.miss, stale: richTextDiag.stale,
            spawn: richTextDiag.spawn, timeout: richTextDiag.timeout, pyerr: richTextDiag.pyerr,
            noKey: richTextDiag.noKey, noSid: richTextDiag.noSid,
            notCur: richTextDiag.notCur, noInst: richTextDiag.noInst },   // v343/v360 issue #321：回推失败与静默拒绝可观测（spawn/timeout/pyerr 需主进程同版；四类门控拒绝按轮键计一次，sent=0 而占位常驻时先看这里）
          bridge: instances.map(function (inst) { return inst.bridgeInfo ? inst.bridgeInfo() : null; }),
          nullOwner: scanDeterministicLines.nulls,   // v345 issue #327：带行 box 令牌取不到的累计拍数与原因、宽限命中数、撤行/换代数
          sub: zuSubDetDiag(),   // v458：子代理窗格观察器（窗格数/已绑定数/等重试数）
          turns: diagTurns.slice(0, 40),
        };
      }
    } catch (e) { FATAL.detErr = String((e && e.stack) || e); }
  }
  scanDeterministicLines.nulls = { owner: 0, sid: 0, scope: 0, grace: 0, removed: 0, swap: 0, since: new Date().toISOString() };   // 仅统计「带统计行的 box」令牌为空的拍数；grace=宽限放行拍数，removed=因空令牌撤行次数，swap=非空令牌换代撤旧次数；since=本代起算（热更新换代归零）
  function zuDiagStats(s) {
    return s ? { c: s.complete ? 1 : 0, live: s.observedLive ? 1 : 0, out: s.outputTokens, st: s.state,
      sa: s.startedAt, ea: s.endedAt, mm: s.modelMs, dm: s.durationMs,
      ic: s.isCompact ? 1 : undefined,   // v230：压缩轮标记（timelineMarker type=compact）
      ks: s.kinds ? s.kinds.join(",") : undefined,   // v230：轮内行 kind 集合（排"压缩轮为何不可用"类问题）
      tmr: s.tmr && s.tmr.length ? s.tmr : undefined } : null;   // v230：timelineMarker 内容（区分压缩/模型切换）
  }
  function cleanupDeterministic() {
    clearInterval(detTimer);
    zuSubDetDisposeAll();   // v458：观察器租约随代际全释放（行节点在窗格 DOM 内随窗格生死）
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
    zuSubDetPaneTick();   // v458：观察器生命周期巡检搭 500ms 便车（零新增定时器/查询）
    scanDeterministicLines();
  }
  detTimer = setInterval(sharedTick, 500);   // v88：2s→0.5s，与速率行扫描/心跳同节奏
  sharedTick();

  var mpModalDispose = null;   // v128 模型拉取弹窗清理回调（openMpModal 注册，disposeOverlay 调用）
  var mpModalThemeSync = null;   // v132 弹窗浅色主题同步回调（openMpShell 注册，applyTheme 调用）
  function disposeOverlay() {
    if (disposed) return;
    disposed = true;
    if (state.enhancePending) clearTimeout(state.enhancePending.timer);
    state.enhancePending = null;
    pluginRequestCallbacks = {};
    clearTimeout(bootTimer);
    clearInterval(coordinatorTimer);
    instances.forEach(function (inst) { inst.dispose(); });
    instances = [];
    quotaSelectionsSig = "";
    pluginRequest("quota-providers", { panes: {} });
    zuChipHoverDisarm();   // v440：chip 悬停门槛在途排程随代际销毁（fire 的 isConnected 守卫是第二道）
    cleanupRateTip();
    cleanupGitTip();
    if (typeof cleanupSysTip === "function") cleanupSysTip();   // v356：系统状态 chip 浮层同链清理
    closeEnhanceHistoryFull();   // v350：摘除查看全部历史面板的 document keydown / window resize 监听与 debounce（幂等）
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










