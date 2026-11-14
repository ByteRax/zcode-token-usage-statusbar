/* 13-mobile-chips：桌面状态条 DOM 采集 → window.__zusageMobileChips（mobile-relay v1）。
 * 从已挂载状态条（.zusage-root .zu-main）收割 .it 段的最终显示文本——与桌面渲染
 * 逐字同源（含 ⚙ 显隐项配置、万/亿进位、两态速度、色阶类），不在本层重复任何格式化。
 * 主泵 readWants 轮询读回（与 __zusageWantSids 同通道）→ mobile-relay.cjs 编码推送
 * 官方中继，远控页油猴脚本渲染（docs/zusage-mobile.user.js）。规格 specs/mobile-relay.md。
 * 采集节流：__zusageUpdate 后 50ms 单飞（render 同步完成后 DOM 才是本轮终态）；
 * 内容未变化不重写（mobile-relay 侧另有 2s 节流与 chips 去重兜底）。多实例（多输入卡）
 * v1 只取首个有内容的条。tip（__tip）剥 HTML 标签取前 300 字符作 detail。
 * 结构契约：boot 闭包由 00 开、**本文件尾 `})();` 收**（12 分片已移交收尾）——
 * 产物必须以 boot 闭包收尾（overlay-rate/overlay-lifecycle 测试的尾部锚点注入
 * 契约：注入代码需访问闭包内 state/renderAll）；标识符一律 mc 前缀
 * 防与闭包内既有变量碰撞。 */
var mcOrigUpdate = window.__zusageUpdate;
if (typeof mcOrigUpdate === "function" && !(typeof mobileMode !== "undefined" && mobileMode)) {
  var mcPending = false, mcLastJson = "";
  var mcTarget = null, mcTargetJson = "", mcStatusBusy = false;
  var mcStatusEpoch = 0, mcStatusTimeout = null, mcStopped = false, mcLastChips = {};
  /* v2：目标会话由宿主报告。getWebRemoteControlStatus 是 preload 只读接口，
   * mobileTaskView 为空表示页面没有已验证的可见聊天（隐藏/首页/遮盖），
   * 此时不报告 target，主进程保留手机端上次显示，绝不回退到其它会话。 */
  function mcSetTarget(next) {
    var j = JSON.stringify(next);
    if (j === mcTargetJson) return;
    mcTargetJson = j;
    mcTarget = next;
    mcPublish();
  }
  function mcCancelStatus() {
    mcStatusEpoch++;
    mcStatusBusy = false;
    if (mcStatusTimeout !== null) { clearTimeout(mcStatusTimeout); mcStatusTimeout = null; }
  }
  function mcSyncTarget() {
    if (mcStopped) return;
    var z, getStatus;
    try { z = window.zcode; getStatus = z && z.getWebRemoteControlStatus; } catch (e) { }
    if (typeof getStatus !== "function") { mcCancelStatus(); mcSetTarget(null); return; }
    if (mcStatusBusy) return;
    mcStatusBusy = true;
    var epoch = ++mcStatusEpoch;
    mcStatusTimeout = setTimeout(function () {
      if (mcStopped || epoch !== mcStatusEpoch) return;
      mcStatusTimeout = null;
      mcCancelStatus();
      if ((window.__zusageGen || 0) === mcGen) mcSetTarget(null);
    }, 3000);
    if (mcStatusTimeout && typeof mcStatusTimeout.unref === "function") mcStatusTimeout.unref();
    function finish(next) {
      if (mcStopped || epoch !== mcStatusEpoch || (window.__zusageGen || 0) !== mcGen) return;
      mcCancelStatus();
      mcSetTarget(next);
    }
    var p;
    try { p = getStatus.call(z); } catch (e) { finish(null); return; }
    Promise.resolve(p).then(function (s) {
      try {
        var v = s && s.mobileConnected ? s.mobileTaskView : null;
        var next = v && v.taskId && (v.workspacePath == null || typeof v.workspacePath === "string") &&
          (v.workspaceIdentity == null || typeof v.workspaceIdentity === "string") ? {
          taskId: String(v.taskId),
          workspacePath: typeof v.workspacePath === "string" ? v.workspacePath : null,
          workspaceIdentity: typeof v.workspaceIdentity === "string" ? v.workspaceIdentity : null
        } : null;
        finish(next);
      } catch (e) { finish(null); }
    }, function () { finish(null); });
  }
  var mcGen = window.__zusageGen || 0;
  var mcTimer = setInterval(function () {
    if ((window.__zusageGen || 0) !== mcGen) { mcStopped = true; mcCancelStatus(); clearInterval(mcTimer); mcTimer = null; return; }
    mcSyncTarget();
  }, 1000);
  mcSyncTarget();   // 首次立即发起（不等 1s），不额外占一次性定时器
  /* 定时器归属：接入 overlay dispose 链，热重载/卸载时随代际清理（不能只靠 gen 兜底） */
  var mcPrevDispose = window.__zusageDispose;
  window.__zusageDispose = function () {
    try {
      mcStopped = true;
      mcCancelStatus();
      if (mcTimer) { clearInterval(mcTimer); mcTimer = null; }
    } catch (e) { }
    if (typeof mcPrevDispose === "function") return mcPrevDispose.apply(this, arguments);
  };
  function mcStripTags(html) {
    return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  /* 档位类（与 02 分片 TPS_BANDS / 06 分片样式同源）→ 手机端同色渲染 */
  var MC_BANDS = ["zu-ultra", "zu-magenta", "zu-purple", "zu-violet", "zu-azure", "zu-sky", "zu-teal", "ok", "warm", "hot"];
  function mcBandOf(el) {
    var nodes = [el].concat([].slice.call(el.querySelectorAll("*")));
    for (var i = 0; i < nodes.length; i++) {
      var c = nodes[i].classList;
      if (!c) continue;
      for (var b = 0; b < MC_BANDS.length; b++) if (c.contains(MC_BANDS[b])) return MC_BANDS[b];
    }
    return "";
  }
  /* 值节点（.v）的语义色：bad/err → bad，warn → warn，ok → ok；无 → 空（手机端用默认色，
   * 不再一律 mute 灰——DOM 采集此前把整条状态条渲染成灰色）。 */
  function mcToneOf(el) {
    var nodes = [el].concat([].slice.call(el.querySelectorAll("*")));
    for (var i = 0; i < nodes.length; i++) {
      var c = nodes[i].classList;
      if (!c) continue;
      if (c.contains("bad") || c.contains("err")) return "bad";
      if (c.contains("warn")) return "warn";
      if (c.contains("ok")) return "ok";
    }
    return "";
  }
  /* tooltip class → 语义标签（与桌面 tooltip 结构同源） */
  function mcLabelOf(tip) {
    if (typeof tip !== "string") return "";
    if (tip.indexOf("zu-sv-root") !== -1 || tip.indexOf("zu-tps-tip") !== -1) return "速度";
    if (tip.indexOf("zu-stat-tip--turn") !== -1) return "本轮";
    if (tip.indexOf("zu-stat-tip--session") !== -1) return "会话";
    if (tip.indexOf("zu-stat-tip--today") !== -1) return "今日";
    if (tip.indexOf("zu-stat-tip--project") !== -1) return "项目";
    if (tip.indexOf("zu-stat-tip--tools") !== -1) return "工具";
    if (tip.indexOf("zu-quota") !== -1) return "额度";
    return "";
  }
  function mcHarvest() {
    mcPending = false;
    try {
      var bySession = {};
      var roots = document.querySelectorAll(".zusage-root");
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        var main = root.querySelector(".zu-main");
        if (!main) continue;
        var text = (main.textContent || "").trim();
        if (!text || text === "…") continue;   // 定位前的占位条
        // 向上找 data-session-id（renderer 桥写在 SessionPane 节点上）
        var sid = null, node = root;
        while (node && node !== document.body) {
          if (node.getAttribute) {
            var s = node.getAttribute("data-session-id");
            if (s && s !== "draft") { sid = s; break; }
          }
          node = node.parentElement;
        }
        if (!sid) continue;   // 无会话标识的实例跳过（draft/未绑定）
        var chips = [];
        var its = main.querySelectorAll(".it");
        for (var i = 0; i < its.length; i++) {
          var el = its[i];
          /* 工具格桌面 DOM 是「<span class=v>717</span><span class=eb>15</span>」两个值
           * 节点，textContent 直接拼成 "71715"。手机端只取调用总数，错误数进 detail；
           * 其它格（本轮/会话/今日/项目）的「N次 / N轮 N次」在 .dim 里，必须保留——
           * 所以只在有 .eb 时按尾部剥离，不能统一只取 .v。 */
          var ebEl = el.querySelector(".eb");
          var value = (el.textContent || "").trim();
          var ebText = ebEl ? (ebEl.textContent || "").trim() : "";
          if (ebText && value.slice(-ebText.length) === ebText) value = value.slice(0, -ebText.length).trim();
          if (!value) continue;
          /* 按桌面 DOM 拆主值/后缀：.v 是主值（600 字重），.dim 是「N次 / N轮 N次」后缀；
           * 速度格是单个 .zu-live（"170.4t/s"），拆成数字 + t/s。手机端用同一套 .zu-* 渲染。 */
          var vEl = el.querySelector(".v");
          var dimEls = el.querySelectorAll(".dim");
          var vText = vEl ? (vEl.textContent || "").trim() : value;
          var dimText = dimEls.length ? (dimEls[dimEls.length - 1].textContent || "").trim() : "";
          if (!vEl) {
            var liveEl = el.querySelector(".zu-live");
            if (liveEl) vText = (liveEl.textContent || "").trim();
          }
          var sm = vText.match(/^([\d.,]+)\s*(t\/s)$/);
          if (sm) { vText = sm[1]; dimText = "t/s"; }
          if (ebText && vText.slice(-ebText.length) === ebText) vText = vText.slice(0, -ebText.length).trim();
          var tip = el.__tip;
          var detail = "";
          if (typeof tip === "string" && tip.charAt(0) !== "\x01") detail = mcStripTags(tip).slice(0, 300);
          if (ebText && ebText !== "0") detail = (detail ? detail + " · " : "") + "错误 " + ebText;
          var label = el.getAttribute("aria-label") || mcLabelOf(tip);
          /* 稳定 id 与桌面 state.show 键对齐（turn/win/today/proj/tools/sub）：
           * 手机端「状态栏显示」面板照抄桌面 ⚙ 显示项行，勾选键名必须一致 */
          var mcIds = { "本轮": "turn", "会话": "win", "会话累计": "win", "今日": "today", "今日合计": "today", "项目": "proj", "项目累计": "proj", "工具": "tools", "子代理": "sub", "速度": "speed", "额度": "quota" };
          var chip = { id: mcIds[label] || ("s" + i), label: label, v: vText, value: value, detail: detail };
          if (dimText) chip.dim = dimText;
          if (ebText && ebText !== "0") chip.err = ebText;   // 桌面 .eb 红色徽标同款
          var band = mcBandOf(el);
          if (band) chip.band = band;
          else {
            var tone = mcToneOf(el);
            if (tone) chip.tone = tone;
          }
          chips.push(chip);
        }
        if (chips.length) bySession[sid] = chips;
      }
      mcLastChips = bySession;
      mcPublish();
    } catch (e) { /* 采集失败只是手机端无更新，绝不影响桌面渲染 */ }
  }
  function mcPublish() {
    try {
      var payload = { zm: 1, ts: Date.now(), target: mcTarget, bySession: mcLastChips };
      var json = JSON.stringify(payload);
      if (json === mcLastJson) return;
      mcLastJson = json;
      window.__zusageMobileChips = payload;
    } catch (e) { }
  }
  window.__zusageUpdate = function (d) {
    mcOrigUpdate(d);
    if (!mcPending) { mcPending = true; setTimeout(mcHarvest, 50); }
  };
}
})();
