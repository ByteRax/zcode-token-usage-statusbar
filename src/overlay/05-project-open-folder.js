  /* ---------- v486 项目菜单「在 Finder 中打开」（specs/project-open-folder-menu.md） ----------
   * 宿主项目侧栏两类 Radix 菜单（项目行右键 contextmenu、行内「…」dropdown）弹出时注入一枚
   * 「在 Finder 中打开」（文案跟随宿主 appHeader.openInFinder / openInFileExplorer /
   * openInFileManager 三平台措辞）：右键菜单逐个跟随 virtual-project-context-files-N
   * （textContent 首个「 · 」后即根路径，多根一一对应）；「…」下拉经 content 的
   * aria-labelledby 找触发按钮、closest 项目行、React fiber 上溯（≤48 层，真机实测行元素
   * 36 层）取 memoizedProps.project.roots[].rootPath 首根（与宿主行内「查看文件」按钮
   * M[0]?.run() 同取首根语义）。点击直调宿主 preload 桥 window.zcode.openInFileManager(path)
   * （与宿主任务菜单「在 Finder 中打开」同一 IPC zcode:open-in-file-manager，真机 4.0.0 实证
   * 桥函数在场），随后向菜单派发 Escape 关闭（非 Radix collection 成员，宿主不会因选中收菜单）。
   * 本地/远程甄别：项目行外层 section 带 data-project-host，仅 === "local" 注入（远程项目
   * 本地打开无意义，fail-closed）；右键菜单经 document 捕获阶段的 pointerdown（鼠标右键、触控
   * 与笔）与 contextmenu 监听记录来源行（时机与平台差异见 zuOpfRecord 上方注释）。
   * 宿主旧版无桥函数或取不到路径时整链不注入。弹层 DOM 归宿主 React 管，注入项只借克隆外观，
   * 弹层关闭即随宿主销毁；观察器只挂 body 直属子节点（portal 容器都在 body 直属层，
   * 聊天流式变更不触发），不进热路径。 */
  var ZU_OPF_LABEL = "data-zusage-open-folder";
  var ZU_OPF_ROW_SEL = '[data-testid="virtual-project-row"]';
  var ZU_OPF_LOCAL_SEL = "[data-project-host]";
  var ZU_OPF_FILES_SEL = "[data-testid^='virtual-project-context-files-']";
  var ZU_OPF_MENU_SEL = "[data-radix-menu-content]";
  var ZU_OPF_CTX_WINDOW_MS = 8000;   // 来源行记录的有效期（右键按下起算；菜单在右键后瞬时打开）
  var ZU_OPF_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open size-4 shrink-0" aria-hidden="true"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.22a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></svg>';
  var zuOpfCtxRow = null, zuOpfCtxAt = 0;
  function zuOpfFails() {
    var f = FATAL.openPathErr || (FATAL.openPathErr = { n: 0 });
    f.n++;
  }
  /* 路径形态：POSIX 绝对路径 / ~ 展开、Windows 盘符路径（正反斜杠都认）、Windows 原生 UNC
   * （\\server\share\…）与长路径前缀（\\?\C:\…）——网络共享做根的本地项目同样要出菜单项 */
  function zuOpfLooksPath(v) {
    return typeof v === "string" && v.length > 1 && v.length <= 1024 &&
      (v.charAt(0) === "/" || v.charAt(0) === "~" || /^[A-Za-z]:[\\/]/.test(v) ||
       /^\\\\[^\\?]+\\[^\\]/.test(v) || /^\\\\\?\\[A-Za-z]:\\/.test(v));
  }
  function zuOpfFiberOf(el) {
    try {
      var ks = Object.keys(el);
      for (var i = 0; i < ks.length; i++) {
        if (ks[i].indexOf("__reactFiber$") === 0) return el[ks[i]];
      }
    } catch (e) { }
    return null;
  }
  /* 行元素 → fiber 上溯（≤48 层，真机实测行元素 36 层）：project.roots[].rootPath 优先，
   * SOt 层 paths（字符串数组）备选；两个形态都是宿主行组件自身的 props，不进子组件猜。 */
  function zuOpfRootsFromRow(row) {
    try {
      var f = zuOpfFiberOf(row);
      for (var i = 0; f && i < 48; i++, f = f.return) {
        var p = f.memoizedProps;
        if (!p || typeof p !== "object") continue;
        var pr = p.project;
        if (pr && Array.isArray(pr.roots) && pr.roots.length) {
          var roots = [];
          for (var j = 0; j < pr.roots.length; j++) {
            var rp = pr.roots[j] && pr.roots[j].rootPath;
            if (zuOpfLooksPath(rp)) roots.push(rp);
          }
          if (roots.length) return roots;
        }
        if (Array.isArray(p.paths) && p.paths.length && zuOpfLooksPath(p.paths[0])) {
          var ps = [];
          for (var k = 0; k < p.paths.length; k++) if (zuOpfLooksPath(p.paths[k])) ps.push(p.paths[k]);
          if (ps.length) return ps;
        }
      }
    } catch (e) { }
    return null;
  }
  function zuOpfPathFromFilesItem(el) {
    var t = String(el.textContent || "");
    var at = t.indexOf(" · ");
    if (at < 0) return null;
    var p = t.slice(at + 3).trim();
    return zuOpfLooksPath(p) ? p : null;
  }
  /* 本地/远程甄别：宿主把 data-project-host 烙在行外层 section（真机本地恒 "local"）。
   * 属性缺席（宿主改版/旧版）一律视为不注入，fail-closed。 */
  function zuOpfRowIsLocal(row) {
    try {
      var sec = row && row.closest ? row.closest(ZU_OPF_LOCAL_SEL) : null;
      return !!sec && sec.getAttribute("data-project-host") === "local";
    } catch (e) { return false; }
  }
  function zuOpfOpen(p) {
    try {
      var z = typeof window !== "undefined" ? window.zcode : null;
      if (!(z && typeof z.openInFileManager === "function")) { zuOpfFails(); return; }
      Promise.resolve(z.openInFileManager(p)).then(function (r) {
        if (r == null) return;   // fire-and-forget 形态无回执：打开已发起，不算失败（真机 4.0.0 实测回执 {success:true}）
        var ok = r && typeof r === "object" ? r.success === true : r === true;
        if (!ok) zuOpfFails();   // 目录已删等回执失败：静默计数，不弹错误 UI
      }).catch(function () { zuOpfFails(); });
    } catch (e) { zuOpfFails(); }
  }
  function zuOpfLabelText() {
    var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/mac/i.test(ua)) return L("在 Finder 中打开", "Open in Finder");
    if (/windows/i.test(ua)) return L("在文件资源管理器中打开", "Open in File Explorer");
    return L("在文件管理器中打开", "Open in File Manager");
  }
  function zuOpfBuildItem(tmpl, path) {
    if (!tmpl || typeof tmpl.cloneNode !== "function") return null;
    var item;
    try { item = tmpl.cloneNode(true); } catch (e) { return null; }
    /* 克隆只借外观（类名/结构），宿主身份属性全部剥掉，防宿主选择器/集合误认 */
    var strip = ["data-testid", "data-radix-collection-item", "data-orientation", "id"];
    for (var i = 0; i < strip.length; i++) {
      try { item.removeAttribute(strip[i]); } catch (e) { }
    }
    try { item.setAttribute(ZU_OPF_LABEL, "1"); item.setAttribute("tabindex", "-1"); } catch (e) { }
    try {
      while (item.firstChild) item.removeChild(item.firstChild);
      var span = document.createElement("span");
      span.innerHTML = ZU_OPF_ICON;   // 固定常量串，无用户输入
      if (span.firstChild) item.appendChild(span.firstChild);
      item.appendChild(document.createTextNode(zuOpfLabelText()));
    } catch (e) { return null; }
    try {
      item.addEventListener("click", function (ev) {
        try { ev.stopPropagation(); } catch (e) { }
        try { ev.preventDefault(); } catch (e) { }
        zuOpfOpen(path);
        try {
          /* 我们不是 Radix collection 成员，宿主不会因选中而收菜单：派发 Escape 走
           * DismissableLayer 的 document keydown 关闭（真机验收覆盖）。 */
          item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        } catch (e) { }
      });
    } catch (e) { }
    try {
      /* Radix 高亮只发给 collection 成员（data-highlighted 属性驱动 data-[highlighted]:bg-menu-hover），
       * 我们剥了成员标记不会被宿主点亮：悬停自挂同款属性补齐 hover 效果；指针从宿主项直接移到
       * 我们这里时宿主的 pointermove 找不到成员、原高亮会残留，进来自动清掉保持单高亮。 */
      item.addEventListener("mouseenter", function () {
        try {
          var menu = item.closest("[data-radix-menu-content]");
          var lit = menu ? menu.querySelectorAll("[data-highlighted]") : [];
          for (var i = 0; i < lit.length; i++) lit[i].removeAttribute("data-highlighted");
        } catch (e) { }
        item.setAttribute("data-highlighted", "");
      });
      item.addEventListener("mouseleave", function () {
        try { item.removeAttribute("data-highlighted"); } catch (e) { }
      });
    } catch (e) { }
    return item;
  }
  function zuOpfTmplOf(menu) {
    return menu.querySelector('[data-testid="virtual-project-worktrees"]') || menu.querySelector("[role='menuitem']");
  }
  function zuOpfScan() {
    if (stale()) return;
    var z = typeof window !== "undefined" ? window.zcode : null;
    if (!(z && typeof z.openInFileManager === "function")) return;   // 宿主无桥函数：整链不注入
    var menus;
    try { menus = document.querySelectorAll('[data-radix-menu-content][role="menu"]'); } catch (e) { return; }
    for (var i = 0; i < menus.length; i++) {
      var menu = menus[i];
      var hasProj = false;
      try { hasProj = !!menu.querySelector("[data-testid^='virtual-project-']"); } catch (e) { }
      if (!hasProj) continue;
      try {
        var files = menu.querySelectorAll(ZU_OPF_FILES_SEL);
        if (files.length) {
          /* 右键菜单：每个「查看文件」项后插一枚同路径项（多根一一对应）；
           * 来源行取 contextmenu 捕获记录，仅本地项目注入。 */
          if (!zuOpfRowIsLocal(Date.now() - zuOpfCtxAt < ZU_OPF_CTX_WINDOW_MS ? zuOpfCtxRow : null)) continue;
          var tmpl = zuOpfTmplOf(menu);
          for (var j = 0; j < files.length; j++) {
            var fe = files[j];
            var nxt = fe.nextElementSibling;
            if (nxt && nxt.hasAttribute && nxt.hasAttribute(ZU_OPF_LABEL)) continue;   // 幂等：已注入
            var p = zuOpfPathFromFilesItem(fe);
            if (!p) continue;
            var item = zuOpfBuildItem(tmpl, p);
            if (!item) continue;
            if (nxt) menu.insertBefore(item, nxt);
            else menu.appendChild(item);
          }
          continue;
        }
        /* 「…」下拉：labelledby → 触发按钮 → 项目行（本地甄别）→ fiber 取 roots，取首根，
         * 插在 Worktrees 前。 */
        var labelled = menu.getAttribute("aria-labelledby");
        if (!labelled) continue;
        var trig = document.getElementById(String(labelled).split(/\s+/)[0]);
        var row = trig && trig.closest ? trig.closest(ZU_OPF_ROW_SEL) : null;
        if (!zuOpfRowIsLocal(row)) continue;
        var roots = zuOpfRootsFromRow(row);
        if (!roots || !roots.length) continue;
        if (menu.querySelector("[" + ZU_OPF_LABEL + "]")) continue;   // 幂等
        var tmpl2 = zuOpfTmplOf(menu);
        var item2 = zuOpfBuildItem(tmpl2, roots[0]);
        if (!item2) continue;
        if (tmpl2 && tmpl2.parentNode === menu) menu.insertBefore(item2, tmpl2);
        else menu.insertBefore(item2, menu.firstChild);
      } catch (e) { zuOpfFails(); }
    }
  }
  /* 右键菜单与来源行的唯一关联窗口：Radix ContextMenuContent 不回指触发行，靠 document 捕获阶段
   * 在菜单打开前记录（仅记录项目行；其余右键清掉旧记录）。记录时机有两个：① pointerdown——
   * 鼠标右键（button 2）或触控 / 笔的按下，任何平台都早于菜单挂载；② contextmenu 事件——它的
   * 派发时机各平台不同（macOS / Linux 在按下时、Windows 在松开时），而菜单何时打开取决于宿主
   * Radix 的实现：4.0.0 引擎包实证当前宿主在 contextmenu 里才开鼠标右键菜单（记录一定先于挂载；
   * 触控与笔走 700ms 长按定时器开菜单，不保证派发 contextmenu）。宿主若换成在 pointerdown 里就
   * 开菜单的实现，Windows 上就成了「菜单先挂载、扫描先跑、contextmenu 后到」——所以 contextmenu
   * 记录之后再补排一次扫描（幂等）。松开时指针多半落在刚弹出的菜单上，落在菜单里的 contextmenu
   * 不动记录。 */
  function zuOpfRecord(target) {
    try {
      zuOpfCtxRow = target && target.closest ? target.closest(ZU_OPF_ROW_SEL) : null;
      zuOpfCtxAt = zuOpfCtxRow ? Date.now() : 0;
    } catch (e) { }
  }
  function zuOpfOnPointerDown(e) {
    try {
      if (e && (e.button === 2 || e.pointerType === "touch" || e.pointerType === "pen")) zuOpfRecord(e.target);
    } catch (e) { }
  }
  function zuOpfOnCtx(e) {
    try {
      var t = e && e.target;
      if (!(t && t.closest && t.closest(ZU_OPF_MENU_SEL))) zuOpfRecord(t);
    } catch (e) { }
    zuOpfSchedule();
  }
  function zuOpfSchedule() {
    if (zuOpfRaf) return;
    if (typeof requestAnimationFrame !== "function") { zuOpfScan(); return; }
    zuOpfRaf = requestAnimationFrame(function () {
      zuOpfRaf = 0;
      try { zuOpfScan(); } catch (e) { zuOpfFails(); }
    });
  }
  var zuOpfRaf = 0;
  var zuOpfObserver = null;
  try {
    if (document.body) {
      zuOpfObserver = new MutationObserver(zuOpfSchedule);
      zuOpfObserver.observe(document.body, { childList: true });   // 仅直属：portal 进出 body 才触发
    }
  } catch (e) { zuOpfObserver = null; }
  try { document.addEventListener("contextmenu", zuOpfOnCtx, true); } catch (e) { }
  try { document.addEventListener("pointerdown", zuOpfOnPointerDown, true); } catch (e) { }
  function zuOpfDispose() {
    try { if (zuOpfObserver) { zuOpfObserver.disconnect(); } } catch (e) { }
    zuOpfObserver = null;
    try { if (zuOpfRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(zuOpfRaf); } catch (e) { }
    zuOpfRaf = 0;
    try { document.removeEventListener("contextmenu", zuOpfOnCtx, true); } catch (e) { }
    try { document.removeEventListener("pointerdown", zuOpfOnPointerDown, true); } catch (e) { }
    zuOpfCtxRow = null; zuOpfCtxAt = 0;
  }
  zuOpfScan();   // 热重载重注入后立即补一次（跨代际存活的已开菜单）
