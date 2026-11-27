    /* ---------- 设置面板 ---------- */
    /* v172 待办指纹 → v208 仅待重启：marker mtime 代际（旧主进程缺 markerAt 时退 "?"）。
       红点只承载「需重启 ZCode」：更新成功且可热重载、发现新版本未安装等场景一律不亮；
       红点显示 = 指纹非空 且 ≠ 已查看指纹；点进「插件更新」分区即写 LS.updSeen 记为已查看 */
    function updFingerprint(u) {
      if (!u || !u.restartRequired) return "";
      return String(u.markerAt || "?");
    }
    function syncUpdateDots(on) {
      /* gear 在 buildPanel 首调（issue #55 时序）后才赋值：首轮 syncUpdate 可能读不到，防御 undefined */
      var gearDot = gear && gear.querySelector(".zu-gear-dot");
      if (gearDot) gearDot.style.display = on ? "block" : "none";
      var navDot = panel.querySelector('.zu-navitem[data-sec="update"] .zu-nav-dot');
      if (navDot) navDot.style.display = on ? "block" : "none";
    }
    /* v177：分量级比较——只要求 seen 覆盖当前全部分量：分量退出不复亮，出现新分量才复亮。
     * v208 起指纹仅待重启单分量，本比较仍保留以兼容旧版写入的「代际|版本」已查看串。 */
    function updSeenCovers(seen, fp) {
      if (!fp) return true;
      if (!seen) return false;
      if (seen === fp) return true;
      var parts = fp.split("|");
      for (var i = 0; i < parts.length; i++) {
        if (("|" + seen + "|").indexOf("|" + parts[i] + "|") < 0) return false;
      }
      return true;
    }
    function ackUpdateDots() {
      var fp = updFingerprint(state.pluginUpdate);
      if (!fp) return;
      var covered = false;
      try {
        covered = updSeenCovers(localStorage.getItem(LS.updSeen) || "", fp);
        if (!covered) localStorage.setItem(LS.updSeen, fp);   // 幂等：已覆盖不写（也避免触发多余 storage 事件）
      } catch (e) { }
      /* v177：已覆盖也要收敛本窗口红点——相同状态推送被 JSON 等值短路，漏收 storage 事件的
       * 窗口只能靠这次自愈；早退只跳过跨实例广播 */
      syncUpdateDots(false);
      if (covered) return;
      try { instances.forEach(function (inst) { inst.syncUpdate(); }); } catch (e) { }   // v172 同窗其余实例（多分栏）立刻收敛
    }
    /* v208 红点亮判定单一出口：syncUpdate 与齿轮跳转共用（restartNotice 关闭时不亮） */
    function updDotOn() {
      if (state.restartNotice === false) return false;
      var fp = updFingerprint(state.pluginUpdate);
      if (!fp) return false;
      var seen = "";
      try { seen = localStorage.getItem(LS.updSeen) || ""; } catch (eDotSeen) { }
      return !updSeenCovers(seen, fp);
    }
    /* v208 分区切换单一出口：导航点击与齿轮待重启跳转共用；切入「插件更新」即 ack（点进分区红点消失） */
    function activateSettingsSec(sec) {
      if (sec !== "enhance-provider" && typeof epTest !== "undefined" && epTest && epTest.id && typeof epTestStop === "function") epTestStop(L("测试已取消。", "Test cancelled."));
      state.settingsSec = sec || "display";
      persist();
      if (state.settingsSec === "update") ackUpdateDots();
      try { syncNotes(); } catch (eSecNotes) { }   // v202：进入更新分区按需加载日志（失败静默，syncUpdate 下一轮兜底）
      var cur = activeSettingsSec();
      panel.querySelectorAll(".zu-settings-section[data-sec]").forEach(function (s) {
        s.hidden = s.getAttribute("data-sec") !== cur;
      });
      /* 底部实时预览随分区启停（切走即清定时器，不留空转）。本函数会被 settings/speed
       * 测试单独切片进隔离 VM——跨切片引用一律 typeof 守卫（zuRotatorSyncPanel 同款）。 */
      if (cur === "rotator") {
        if (typeof rotPreview !== "undefined" && typeof ensureRotPreviewTimer === "function") {
          rotPreview.panelEl = panel;
          rotPreview.secEl = panel.querySelector('[data-sec="rotator"]');
          ensureRotPreviewTimer();
          renderRotPreview();
        }
      } else if (typeof rotPreview !== "undefined" && rotPreview.timer) {
        clearInterval(rotPreview.timer);
        rotPreview.timer = null;
      }
      panel.querySelectorAll(".zu-navitem").forEach(function (b) {
        if (b.getAttribute("data-sec") === cur) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
      });
      var navBody = panel.querySelector(".zu-settings-body");
      if (navBody) navBody.scrollTop = 0;
      syncSettingsScroll();
    }
    function canStartEnhanceTest() {
      return !(typeof mobileMode !== "undefined" && mobileMode) && state.enhanceEnabled !== false && !state.enhancePending;
    }
    function syncEnhanceControls() {
      var readOnly = typeof mobileMode !== "undefined" && mobileMode, pending = state.enhancePending;
      var toggle = panel.querySelector(".zu-enhance-toggle");
      if (toggle) {
        toggle.checked = !readOnly && (pending ? pending.enabled : state.enhanceEnabled !== false);
        toggle.disabled = readOnly || !!pending;
      }
      var run = panel.querySelector(".zu-ep-test-run");
      if (run) run.disabled = !canStartEnhanceTest() || !!(typeof epTest !== "undefined" && epTest && epTest.id);
    }
    function syncUpdate() {
      var u = state.pluginUpdate;
      syncEnhanceControls();
      if (typeof epReconcile === "function") epReconcile(u && u.enhanceProvider);
      if (typeof epTest !== "undefined" && epTest && typeof epTestSignature === "function" && epTest.signature && epTest.signature !== epTestSignature()) {
        if (epTest.id) epTestStop(L("配置已变化，请重新测试。", "Settings changed; test again."));
        else if (epTest.result) { epTest.status = L("上次测试结果（配置已变化）", "Previous test result (settings changed)"); epTestRender(); }
      }
      var active = !!(u && u.supported);
      var version = panel.querySelector(".zu-settings-version");
      version.textContent = active && u.currentVersion ? u.currentVersion : "";
      version.hidden = !version.textContent;
      var cb = panel.querySelector(".zu-auto-update");
      cb.checked = !!(u && u.auto);
      cb.disabled = !active;
      /* 重启提醒开关真值不依赖更新器可用性（主进程无条件推送 restartNotice，缺省开；change 时代乐观更新） */
      var rn = panel.querySelector(".zu-restart-notice");
      if (rn) rn.checked = state.restartNotice !== false;
      var mobileReadOnly = typeof mobileMode !== "undefined" && mobileMode;
      var mobileBox = panel.querySelector(".zu-mobile-relay");
      if (mobileBox) {
        mobileBox.checked = !mobileReadOnly && state.mobileRelaySupported === true && (state.mobileRelayPending
          ? state.mobileRelayPending.enabled === true : state.mobileRelayEnabled === true);
        mobileBox.disabled = mobileReadOnly || state.mobileRelaySupported !== true || !!state.mobileRelayPending;
      }
      var mobileStatus = panel.querySelector(".zu-mobile-relay-status");
      if (mobileStatus) mobileStatus.textContent = mobileReadOnly
        ? L("手机端不可修改此开关；请在桌面端 ZCode 的「设置 → 维护 → 移动端远程控制」中开启或关闭统计推送。手机端不显示桌面当前值。", "This switch cannot be changed on mobile; turn statistics push on or off in ZCode on your desktop (Settings → Maintenance → Mobile remote control). The mobile page does not show the desktop's current value.")
        : state.mobileRelaySupported !== true
          ? L("需要新版桌面插件主进程支持；请完全退出并重启 ZCode，仍不可用时请升级桌面插件。", "Requires a newer desktop plugin main process; quit ZCode completely and restart it, or upgrade the desktop plugin if still unavailable.")
          : state.mobileRelayPending ? L("操作已发出，等待确认…", "Sent; awaiting confirmation…") : "";
      panel.querySelector('[data-update=check]').disabled = !active || !!u.busy;
      panel.querySelector('[data-update=update]').disabled = !active || !!u.busy || u.phase !== "available";
      /* v379 底栏新增「重启 ZCode」按钮：与更新区按钮同 data-update=relaunch、共用点击状态机，
       * 两处同步 armed/sent/禁用/待重启高亮文案；索引 0=更新区内，1=底栏 */
      var relaunchBtns = panel.querySelectorAll ? panel.querySelectorAll('[data-update=relaunch]') : null;
      if (!relaunchBtns || !relaunchBtns.length) {
        var soloBtn = panel.querySelector ? panel.querySelector('[data-update=relaunch]') : null;
        relaunchBtns = soloBtn ? [soloBtn] : [];
      }
      var relaunchDead = !!(u && u.relaunchSupported !== true);   // v180 issue #158：主进程缺能力标记（旧版）→ relaunch 指令必然无人接收
      var relaunchSent = false;   // v244：重启请求已发出，状态推送重建状态行时保持「正在重启」态
      for (var si = 0; si < relaunchBtns.length; si++) {
        var sBtn = relaunchBtns[si];
        if (sBtn && sBtn.dataset && sBtn.dataset.sent === "1") { relaunchSent = true; break; }
      }
      for (var ri = 0; ri < relaunchBtns.length; ri++) {
        var rBtn = relaunchBtns[ri];
        rBtn.hidden = relaunchDead;   // 降级为下方提示文案：浮层热更/主进程冷加载错位窗口里按钮「点了没反应」
        rBtn.disabled = relaunchSent || !!(u && u.busy) || relaunchDead;   // 重启不依赖更新器：仅更新进行中禁用（u 为 null 时仍可点）
        rBtn.classList.toggle("zu-rr-armed", !!(u && u.restartRequired));
      }
      /* v172 待办红点 → v208 仅待重启：需重启且未查看时亮 ⚙ 与「插件更新」导航点；其他窗口经各自 syncUpdate 收敛 */
      syncUpdateDots(updDotOn());
      /* v413：待重启红点亮起即后台预取日志（悬停零等待）。pluginRequest 参与判定是为了
       * VM 切片安全——不含 00 分片定义的切片沙箱里 typeof 为 undefined，整链跳过不抛错。
       * 预取链不参与实例存亡：异常只记诊断，绝不沿 buildPanel → spawnInstance 拖垮条挂载。 */
      try {
        if (updDotOn() && typeof updNotePrefetch === "function" && typeof pluginRequest === "function") updNotePrefetch();
      } catch (eUpdNote) { try { window.__zusageDiag.updNoteErr = String((eUpdNote && eUpdNote.stack) || eUpdNote); } catch (_) { } }
      var messages = {
        idle: L("尚未检测", "Not checked yet"),
        checking: L("正在检查更新…", "Checking for updates…"),
        available: L("发现新版本", "Update available"),
        current: L("当前已是最新版本", "Up to date"),
        downloading: L("正在下载更新…", "Downloading update…"),
        updating: L("正在安装更新…", "Installing update…"),
        updated: L("插件已更新；请重开会话以加载新版插件组件", "Plugin updated; start a new session to load the new components"),
        error: L("更新失败：", "Update failed: ") + (u && u.error || ""),
      };
      var text = !active ? L("仅支持已安装的 zusage-marketplace 用户插件；更新通道未就绪时需先升级插件并重启 ZCode。", "Requires the installed user plugin from zusage-marketplace. Upgrade the plugin and restart ZCode if the update channel is not ready.") : messages[u.phase] || messages.idle;
      if (!active && u && u.error) text += "\n" + messages.error;
      if (active && u.currentVersion) text += "\n" + L("当前版本：", "Current version: ") + u.currentVersion;
      if (active && u.latestVersion) text += (u.channel === "release" ? L(" · Release 版本：", " · Release version: ") : L(" · 市场版本：", " · Marketplace version: ")) + u.latestVersion;
      if (active && u.channel) text += "\n" + L("更新来源：", "Update source: ") + (u.channel === "release" ? (u.channelHost === "gitcode" ? L("GitCode 正式 Release（校验 ZIP 与 SHA256）", "stable GitCode Release (validated ZIP and SHA256)") : u.mirror ? L("GitHub 正式 Release（经 GitCode 镜像下载，校验 ZIP 与 SHA256）", "stable GitHub Release (downloaded via the GitCode mirror, validated ZIP and SHA256)") : L("GitHub 正式 Release（校验 ZIP 与 SHA256）", "stable GitHub Release (validated ZIP and SHA256)"))
        : u.channel === "market" ? (u.channelHost === "gitcode" ? L("GitCode 仓库源码（由插件管理器直接更新）", "GitCode repository source (updated directly by the plugin manager)") : L("GitHub 仓库源码（由插件管理器直接更新）", "GitHub repository source (updated directly by the plugin manager)"))
        : L("本地目录市场", "local directory marketplace"));
      if (active && u.releaseUrl) text += "\n" + u.releaseUrl;
      if (active && u.checkedAt) text += "\n" + L("上次成功检查：", "Last successful check: ") + new Date(u.checkedAt).toLocaleString(state.lang === "en" ? "en-US" : "zh-CN");
      /* v259 持久化的上次更新失败原因（issue #247）：浮层复活后也能看到检查期失败；
       * phase=error 时 u.error 已在状态行展示，不重复 */
      if (active && u.phase !== "error" && u.lastError && typeof u.lastError.message === "string" && u.lastError.message)
        text += "\n" + L("上次更新失败：", "Last update failed: ") + u.lastError.message
          + (Number.isSafeInteger(u.lastError.at) && u.lastError.at ? "（" + new Date(u.lastError.at).toLocaleString(state.lang === "en" ? "en-US" : "zh-CN") + "）" : "");
      if (u && (u.phase === "updating" || u.phase === "downloading")) text += "\n" + L("关闭自动更新仅阻止后续安装；已开始的安装会继续完成", "Turning automatic updates off stops future installs; an install already started will finish");
      /* v208 已更新待重启提示条：替代原状态行追加文案；旧主进程（relaunchDead）无重启按钮，
       * 提示条不显示，保留原文字指引与下方 relaunchDead 降级提示 */
      var updBanner = panel.querySelector(".zu-upd-banner");
      if (updBanner) {
        var bannerOn = !!(u && u.restartRequired && !relaunchDead);
        updBanner.hidden = !bannerOn;
        /* v359（issue #321）：桥补装 pending 也写重启标记（无 version 键，markerVersion 空
         * 串）——此时「已更新成功」不实，改中性文案；版本可匹配（更新安装）保持原文。 */
        if (bannerOn) updBanner.textContent =
          (u.markerVersion ? L("已更新成功，点击重启 ZCode 即可生效", "Update installed — click Restart ZCode to apply")
                           : L("有待生效的改动，点击重启 ZCode", "Pending changes — click Restart ZCode to apply"));
      }
      if (u && u.restartRequired && relaunchDead) text += "\n" + L("主进程或关闭热更新的文件已更新，需重启 ZCode", "Restart ZCode to load main-process updates or files with hot reload disabled");
      if (relaunchDead) text += "\n" + L("「重启 ZCode」需要新版主进程支持：当前主进程是旧版本，请完全退出 ZCode 后重新打开。", "Restarting ZCode needs a newer main process: the running main process is outdated — quit ZCode completely and reopen it.");
      if (u && u.skipped && u.skipped.length) text += "\n" + L("保留本地热修（未覆盖）：", "Local edits preserved (not overwritten): ") + u.skipped.join(", ");
      /* v140 API 限流兜底也失败时引导显式切 GitCode 渠道（错误签名在 plugin-updater catalogFallback） */
      if (u && u.phase === "error" && /渠道清单回退/.test(u.error || "")) text += "\n" + L("GitHub API 不可达且清单回退失败；可改用国内 GitCode 镜像渠道：安装或更新 zcode 插件 https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode", "GitHub API is unreachable and the catalog fallback failed; switch to the GitCode mirror: install or update the zcode plugin https://gitcode.com/tanranran/zcode-token-usage-statusbar.git#plugin-releases-gitcode");
      if (relaunchSent) text += "\n" + L("已发出重启请求：ZCode 正在退出全部窗口并自动重新打开；等待会话与扩展子进程退出通常需要几秒到几十秒，请稍候。", "Restart request sent: ZCode is closing all windows and will reopen automatically; waiting for session and extension child processes to exit can take a few seconds to tens of seconds.");
      panel.querySelector(".zu-update-status").textContent = text;
      syncProgress(active ? u : null);
      /* 逐问速率行开关勾选态：state.rateLine 由主进程推送（或 change 时代乐观更新） */
      var rl = panel.querySelector(".zu-rate-line");
      if (rl) rl.checked = state.rateLine;
      var qe = panel.querySelector(".zu-quota-enable");   // v95：勾选态由主进程推送的 quotaEnabled 决定
      if (qe) qe.checked = state.quotaEnabled;
      var re = panel.querySelector(".zu-rst-enable");   // v135：勾选态由主进程推送的 resetBadgeEnabled 决定
      if (re) re.checked = state.resetBadge;
      var ac = panel.querySelector(".zu-ac-enable");   // v179：勾选态由主进程推送的 enginePatch.enabled 决定
      if (ac) ac.checked = !!(state.enginePatch && state.enginePatch.enabled);
      try { syncAutoCompactInputs(); } catch (eAc) { try { window.__zusageDiag.acPanelErr = String((eAc && eAc.stack) || eAc); } catch (_) { } }   // 防御：阈值面板渲染失败不得拖垮 syncPanel（同 syncQuotaSources 先例）
      try { syncQuotaSources(); } catch (eSrc) { try { window.__zusageDiag.quotaSrcErr = String((eSrc && eSrc.stack) || eSrc); } catch (_) { } }   // 防御：多源列表渲染失败不得拖垮实例创建（实测 SRC_FIELD_LABELS 时序可致整条状态条消失）
      try { syncNotes(); } catch (eNotes) { try { window.__zusageDiag.notesErr = String((eNotes && eNotes.stack) || eNotes); } catch (_) { } }   // 防御：更新日志渲染失败不得拖垮整个 ⚙ 面板（同 syncQuotaSources 先例）
    }
    /* ---------- v202 更新日志卡片（数据链：pluginRequest("release-notes"/"-list") → 主进程
     * 按注册 Release 渠道代拉 GitHub/GitCode 发布说明并缓存；渲染进程只传 version/force） ---------- */
    /* 状态变量必须在早期 buildPanel()（issue #55 时序）之前赋值：var 只提升声明不提升初始值，
     * 曾实测 buildPanel→syncUpdate→syncNotes 在赋值前执行把 notesSel 读成 undefined。 */
    /* 渠道：Release 渠道取本渠道 Release（verified）；market（源码）渠道取注册仓库的
     * 同号 Release 作参考正文（verified:false，浮层标注未核实）；本地目录无仓库身份，离线。 */
    function notesChannelOf(u) {
      if (!u || !u.channel || u.channel === "local") return null;
      return { flavor: u.channelHost === "gitcode" ? "gitcode" : "github", verified: u.channel === "release" };
    }
    /* 默认日志选择（唯一依据是主进程推送的可靠状态，不猜）：
     * 待重启=已装完成（markerVersion 实际写入运行目录的版本，退 pendingRelease 目标）→
     * 下载/安装中=安装目标 → 失败=保留失败目标并标注未安装 → 有新版=可用目标 → 已是最新=当前版本。 */
    function notesDefaultTarget(u) {
      if (!u || !u.supported) return null;
      if (u.restartRequired) {
        var pending = u.pendingRelease && u.pendingRelease.release;
        var v = typeof u.markerVersion === "string" && u.markerVersion ? u.markerVersion
          : pending && typeof pending.version === "string" && pending.version ? pending.version : "";
        if (v) return { version: v, status: "installed-restart" };
        if (u.phase === "updated" && u.latestVersion) return { version: u.latestVersion, status: "installed-restart" };
        return { unknown: true, status: "installed-restart" };   // 待重启但版本身份无法确定：明示，不拿其他版本冒充
      }
      if (u.phase === "downloading" || u.phase === "updating") {
        var pr = u.pendingRelease && u.pendingRelease.release;
        var v2 = pr && typeof pr.version === "string" && pr.version ? pr.version : u.latestVersion;
        return v2 ? { version: v2, status: "installing" } : null;
      }
      if (u.phase === "error" && u.lastFailure && typeof u.lastFailure.version === "string" && u.lastFailure.version) {
        return { version: u.lastFailure.version, status: "failed" };
      }
      if (u.phase === "updated" && u.latestVersion) return { version: u.latestVersion, status: "current" };   // 热文件已重载，无待重启
      if (u.phase === "available" && u.latestVersion) return { version: u.latestVersion, status: "available" };
      if (u.phase === "current" && u.currentVersion) return { version: u.currentVersion, status: "current" };
      /* 未触发检查更新（idle/检查失败等）：当前已装版本就是可靠身份，直接展示它的日志；
       * 该版本无 Release 时如实提示，可转历史版本。渠道未知也发起拉取——主进程按注册
       * 渠道门控，market/local 会被拒绝且不产生任何网络请求。 */
      if (u.currentVersion) return { version: u.currentVersion, status: "current" };
      return null;
    }
    /* ---------- v413 齿轮悬停更新日志卡：待重启红点亮起时，悬停 ⚙ 直接展示待重启版本的
     * Release 日志（形态对标宿主 UpdateReleaseNotesTooltip，规则见 overlay-ui.md）。
     * 数据独立于设置页 notesResult——面板有粘性历史选择，两边不能互相干扰；主进程 1h
     * 缓存兜底多窗与面板的重复请求。悬停只读不 ack，红点已读仍以点进「插件更新」分区为准。 */
    /* 保留 buildPanel 期懒初始化的对象：赋值行在 spawn 体内执行晚于 buildPanel 首拍
     * （issue #55 var 只提升声明的同款时序），无条件重赋会丢掉首拍预取的在途状态、
     * 令其结果被 seq 守卫弃收后重发一轮（v416 补充防御；崩溃根因见 updNoteEnsure）。 */
    var updNoteState = updNoteState || { version: "", seq: 0, loading: false, result: null, error: null };
    function updNoteTargetVersion() {
      var def = notesDefaultTarget(state.pluginUpdate);
      return def && !def.unknown && def.version ? def.version : "";
    }
    function updNoteEnsure() {
      /* issue #55 时序翻版防御：模块级赋值在 IIFE 深处，而 buildPanel 首轮经 syncUpdate →
       * updNotePrefetch 同步到达此处时可能尚未执行（v1.5.2 同款「读到 undefined 拖垮实例创建」，
       * 3.19.1 实机 coordErr 实证：spawn 半途夭折、主条整条不挂）。红点亮起才走得到本行。 */
      if (!updNoteState) updNoteState = { version: "", seq: 0, loading: false, result: null, error: null };
      var v = updNoteTargetVersion();
      if (!v) return false;
      if (updNoteState.version === v && (updNoteState.loading || updNoteState.result || updNoteState.error)) {
        updNoteRefreshTip();   // 持续悬停中（syncUpdate 每拍钩子）超时/迟到回包也能即时重画；签名幂等无 DOM 抖动
        return false;
      }
      var seq = ++updNoteState.seq;
      updNoteState.version = v; updNoteState.loading = true; updNoteState.result = null; updNoteState.error = null;
      updNoteState.at = Date.now();
      pluginRequest("release-notes", { version: v, force: false }, function (result) {
        if (inactive() || seq !== updNoteState.seq) return;   // 乱序/实例销毁守卫：旧结果不覆盖新状态
        updNoteState.loading = false;
        updNoteState.result = result && result.ok ? result : null;
        updNoteState.error = result && !result.ok ? result : null;
        updNoteRefreshTip();
      });
      return true;
    }
    function updNotePrefetch() { updNoteEnsure(); }   // 红点亮起即后台拉取（syncUpdate 钩子），悬停到达时多半已就绪
    function updNoteRefreshTip() {
      if (!gear) return;
      gear.__zuUpdHtml = updNoteHtml();
      if (typeof renderUpdNoteTip === "function" && typeof updNoteTipFor !== "undefined" && updNoteTipFor === gear) renderUpdNoteTip();
    }
    function updNoteHtml() {
      var v = updNoteState.version;
      if (!v) return "";
      var r = updNoteState.result;
      var subs = [];
      if (r && r.publishedAt) {
        var d = notesFmtDate(r.publishedAt);
        if (d) subs.push(d);
      }
      subs.push(L("已安装待重启，重启 ZCode 后生效", "Installed, pending restart — takes effect after restarting ZCode"));
      if (r && r.mirror) subs.push(L("GitCode 镜像（GitHub 限流回退）", "GitCode mirror (GitHub rate-limit fallback)"));
      else if (r && r.verified === false) subs.push(L("参考：同号 Release，未核实与本渠道一致", "reference: same-version release, parity with this source unverified"));
      var head = '<div class="zu-un-head"><div class="zu-un-title">' + mEsc("v" + v + L(" 更新日志", " release notes")) +
        '</div><div class="zu-un-sub">' + mEsc(subs.join(" · ")) + "</div></div>";
      var body;
      /* 回执丢失兜底（与设置页 NOTES_LOADING_TIMEOUT_MS 同款）：超时把 loading 转为可读错误，
       * 卡对同版本不再永挂「正在加载」；下一次悬停/回包到达即按新状态重画 */
      var timedOut = updNoteState.loading && Date.now() - (updNoteState.at || 0) > NOTES_LOADING_TIMEOUT_MS;
      var err = timedOut ? { reason: "network" } : updNoteState.error;
      if (updNoteState.loading && !err) {
        body = '<div class="zu-un-note">' + L("正在加载更新日志…", "Loading release notes…") + "</div>";
      } else if (err) {
        var reason = String(err.reason || "");
        var errText = String(err.error || err.message || "");
        var text = /^unknown action:/.test(errText) ? L("当前主进程为旧版本，暂不支持在线更新日志。", "The main process is outdated; online release notes are unavailable.")
          : reason === "rate-limited" ? L("暂时无法获取（API 限流）", "Temporarily unavailable (rate limited)")
          : reason === "missing" ? L("该版本暂无发布日志", "No release notes for this version")
          : reason === "unsupported-channel" || reason === "unsupported" ? L("当前来源暂不支持在线日志", "Online release notes are unavailable for this source")
          : L("暂时无法获取更新日志", "Temporarily unable to load release notes");
        body = '<div class="zu-un-note">' + text + L("　详情见 ⚙ → 插件更新。", " — see ⚙ → Plugin updates.") + "</div>";
      } else if (r && typeof r.body === "string" && r.body) {
        body = notesHtml(r.body, true).html;   // 全量渲染（64KB 钳制 + 升级注意节高亮），超帽由卡内滚动承接
      } else {
        body = '<div class="zu-un-note">' + L("暂无正文内容。", "No content.") + "</div>";
      }
      return head + '<div class="zu-un-body">' + body + "</div>";
    }
    function onGearUpdEnter() {
      if (!updDotOn()) return;   // 红点灭（含 restartNotice:false、已 ack）不弹
      if (panel.classList.contains("open")) return;   // 面板开着：更高优先级界面，不弹卡
      try { updNoteEnsure(); } catch (eUpdEns) { }
      updNoteRefreshTip();
      if (gear.__zuUpdHtml && typeof showUpdNoteTip === "function") showUpdNoteTip(gear);
    }
    function onGearUpdLeave() {
      if (typeof scheduleUpdNoteHide === "function") scheduleUpdNoteHide();
    }
    function notesPickTarget(u) {
      var def = notesDefaultTarget(u);
      if (notesSel.explicit && notesSel.version) {
        if (def && def.version === notesSel.version) return { def: def, target: def };   // 选择已被默认追上：按真实状态显示，粘性自然失效
        return { def: def, target: { version: notesSel.version, status: "history" } };
      }
      return { def: def, target: def };
    }
    function notesStatusBadge(status) {
      return {
        "installed-restart": L("已安装，待重启", "Installed, restart pending"),
        "installing": L("安装中", "Installing"),
        "failed": L("更新失败，未安装成功", "Update failed, not installed"),
        "available": L("可用版本", "Available version"),
        "current": L("当前版本", "Current version"),
        "history": L("历史版本", "History"),
      }[status] || "";
    }
    /* Release 页链接：版本为稳定语义版时指向具体 tag，否则回退 releases 列表页（market 参考入口） */
    function notesReleasePageUrl(flavor, repository, version) {
      var base = flavor === "gitcode" ? "https://gitcode.com/" : "https://github.com/";
      if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository) || repository.length > 200) return "";
      return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
        ? base + repository + "/releases/tag/v" + version
        : base + repository + "/releases";
    }
    /* GitCode 的 tag 深链页对本项目（API 创建的）Release 一律「找不到或无权限」——平台路由
     * bug，2026-11-04 匿名实测；/releases 列表页正常。发布页链接对 GitCode 一律落到列表页，
     * GitHub 保持精确 tag 深链。 */
    function notesReachablePageUrl(url) {
      return typeof url === "string" && /^https:\/\/gitcode\.com\/[^/\s]+\/[^/\s]+\/releases\/tag\//.test(url)
        ? url.replace(/\/releases\/tag\/[^/?#]*$/, "/releases") : url;
    }
    /* 渠道未知（未检查过）时从已验证回复的发布页 URL 推导来源标签 */
    function notesHostLabel(notes) {
      var url = notes && notes.url;
      return /^https:\/\/github\.com\//.test(String(url || "")) ? "GitHub"
        : /^https:\/\/gitcode\.com\//.test(String(url || "")) ? "GitCode" : "";
    }
    function notesFmtDate(iso) {
      var t = Date.parse(String(iso || ""));
      return isFinite(t) ? new Date(t).toLocaleDateString(state.lang === "en" ? "en-US" : "zh-CN") : "";
    }
    /* ---------- 受限 Markdown：转义优先的 GFM 子集（对齐宿主更新日志渲染形态）----------
     * 支持 标题/嵌套列表(缩进上限已天然钳 3 层)/任务清单/GFM 管道表格/引用/分隔线/围栏代码/
     * 行内代码/粗斜体(粗内可套斜)/删除线(~~双波浪，宿主 singleTilde:false 同款)/链接/裸 URL；
     * HTML 一律按文本显示（宿主对 markdown 格式同款），图片默认禁用（只留 alt 文本不发请求），
     * 链接仅 https 且带上限，点击走 openExternal。_下划线强调不支持（避免 snake_case 误判）。 */
    function notesSafeLinkUrl(u) {
      return typeof u === "string" && u.length <= 600 && /^https:\/\/\S+$/.test(u) ? u : "";   // 与点击侧同款大小写敏感：HTTPS:// 渲染为文本，不产出死链按钮
    }
    function notesInline(text) {
      var out = "", last = 0, m;
      var re = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]{1,600})\)|\[([^\]]{0,200})\]\(([^)\s]{1,600})\)|\*\*((?:[^*\n]|\*(?!\*)){1,300}?)\*\*|\*([^*\s][^*\n]{0,300}?)\*|~~([^~\n]{1,300}?)~~|(https:\/\/[^\s<>()\[\]{}"“”‘’]{4,400})/g;
      while ((m = re.exec(text))) {
        out += mEsc(text.slice(last, m.index));
        if (m[1] !== undefined) out += "<code>" + mEsc(m[2]) + "</code>";
        else if (m[3] !== undefined) out += mEsc(m[3] || L("图片", "image"));   // 图片禁用：仅 alt 文本
        else if (m[5] !== undefined) {
          var href = notesSafeLinkUrl(m[6]);
          out += href ? '<button type="button" class="zu-notes-lnk" data-href="' + mEsc(href) + '">' + (mEsc(m[5]) || mEsc(href)) + "</button>"
            : mEsc(m[5]) + "（" + mEsc(m[6]) + "）";
        } else if (m[7] !== undefined) out += "<strong>" + notesInline(m[7]) + "</strong>";
        else if (m[8] !== undefined) out += "<em>" + notesInline(m[8]) + "</em>";
        else if (m[9] !== undefined) out += "<del>" + notesInline(m[9]) + "</del>";
        else {
          var bare = notesSafeLinkUrl(m[10]);
          out += bare ? '<button type="button" class="zu-notes-lnk" data-href="' + mEsc(bare) + '">' + mEsc(bare) + "</button>" : mEsc(m[10]);
        }
        last = re.lastIndex;
      }
      return out + mEsc(text.slice(last));
    }
    /* 表格行拆格：首尾管道只作边界符，\| 转义为字面竖线 */
    function notesSplitRow(line) {
      var s = String(line).trim(), cells = [], cur = "";
      if (s.charAt(0) === "|") s = s.slice(1);
      if (!/\\\|$/.test(s) && s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === "\\" && s.charAt(i + 1) === "|") { cur += "|"; i++; continue; }
        if (c === "|") { cells.push(cur.trim()); cur = ""; continue; }
        cur += c;
      }
      cells.push(cur.trim());
      return cells;
    }
    /* 分隔行 → 对齐数组（:-- left / :--: center / --: right / --- ""）；列数与表头不符即非表格 */
    function notesSepAlign(line, cols) {
      var cells = notesSplitRow(line), align = [];
      if (cells.length !== cols) return null;
      for (var i = 0; i < cells.length; i++) {
        if (!/^:?-+:?$/.test(cells[i])) return null;
        var l = cells[i].charAt(0) === ":", r = cells[i].charAt(cells[i].length - 1) === ":";
        align.push(l && r ? "center" : r ? "right" : l ? "left" : "");
      }
      return align;
    }
    /* 标题文本收尾（关闭 # 串）：去尾部空白 → 去关闭 # 串 → 再去其前空白。纯循环，无回溯。 */
    function notesHeadingText(text) {
      var end = text.length;
      while (end > 0 && /\s/.test(text.charAt(end - 1))) end--;
      var body = end;
      while (body > 0 && text.charAt(body - 1) === "#") body--;
      while (body > 0 && /\s/.test(text.charAt(body - 1))) body--;
      return text.slice(0, body > 0 ? body : end);   // 整段只有 #（如「# #」）没有正文可剥：保留，不出空标题
    }
    function notesBlocks(md) {
      var lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
      var blocks = [], para = null, list = null, quote = null, code = null, codeText = null;
      function closePara() { if (para) { blocks.push({ type: "p", text: para.join("\n") }); para = null; } }
      function closeList() { if (list) { blocks.push({ type: "list", ordered: list.levels[0].ordered, items: list.levels[0].items }); list = null; } }
      function closeQuote() { if (quote) { blocks.push({ type: "quote", text: quote.join("\n") }); quote = null; } }
      function closeAll() { closePara(); closeList(); closeQuote(); }
      /* 分隔行：≥2 列（每列至少一个 -），单列表与 `---` 分隔线/集合语义冲突不收 */
      var reSep = /^\s{0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (code !== null) {
          if (/^\s*(```|~~~)\s*$/.test(line)) { blocks.push({ type: "pre", text: codeText || "" }); code = null; }
          else codeText = codeText === null ? line : codeText + "\n" + line;
          continue;
        }
        if (/^\s*(```|~~~)/.test(line)) { closeAll(); code = "```"; codeText = null; continue; }
        if (/^\s*$/.test(line)) { closeAll(); continue; }
        /* v445：标题行改「线性捕获 + JS 收尾」。旧式 /(.+?)\s*#*\s*$/ 对「# 字 + 长串空格 + 尾字」
         * 是三次方回溯（4000 空格约 10 秒、65532 空格按外推约 70 分钟）；红点预取即同步渲染，
         * 一条这样的标题行就能把渲染进程卡死。 */
        var heading = /^(\s{0,3})(#{1,6})\s+([\s\S]+)$/.exec(line);   // [\s\S]：`.` 过不了 U+2028/2029，那会让 `.+` 回退成二次方重扫
        if (heading) { closeAll(); blocks.push({ type: "h", level: Math.min(3, heading[2].length), text: notesHeadingText(heading[3]) }); continue; }
        if (/^\s{0,3}(?:-\s*){3,}$/.test(line) || /^\s{0,3}(?:\*\s*){3,}$/.test(line) || /^\s{0,3}(?:_\s*){3,}$/.test(line)) { closeAll(); blocks.push({ type: "hr" }); continue; }
        /* GFM 表格：表头行含管道 + 次行为合法分隔行才成表；表体收到空行或首个无管道行为止，
         * 单元格补齐/截断到表头列数（列钳即表头列数，行钳 200），其余行交回主循环重处理 */
        if (line.indexOf("|") >= 0 && i + 1 < lines.length && reSep.test(lines[i + 1])) {
          var head = notesSplitRow(line), align = notesSepAlign(lines[i + 1], head.length);
          if (align) {
            closeAll();
            var rows = [];
            for (i += 2; i < lines.length && rows.length < 200; i++) {
              if (/^\s*$/.test(lines[i]) || lines[i].indexOf("|") < 0) break;
              var cells = notesSplitRow(lines[i]);
              for (var c = cells.length; c < head.length; c++) cells.push("");
              if (cells.length > head.length) cells = cells.slice(0, head.length);
              rows.push(cells);
            }
            blocks.push({ type: "table", head: head, rows: rows, align: align });
            i--;   // 抵消外层 ++，让终止行回到主循环
            continue;
          }
        }
        var item = /^(\s{0,12})(?:[-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
        if (item) {
          closePara(); closeQuote();
          var ordered = /^\s{0,12}\d/.test(line);
          if (list && list.levels[0].ordered !== ordered) closeList();
          if (!list) list = { base: -1, levels: [null, null, null] };
          if (list.base < 0) list.base = item[1].length;
          /* 层级按相对首项缩进每 2 空格一级；缩进捕获上限 12 ⇒ 天然 ≤3 层，无需额外钳制 */
          var lvl = Math.min(2, Math.max(0, Math.floor((item[1].length - list.base) / 2)));
          while (lvl > 0 && !list.levels[lvl - 1]) lvl--;   // 跳级无父挂靠就地上移，绝不丢条目
          var txt = item[2], task = /^\[([xX ])\]\s+/.exec(txt);
          var it = { text: task ? txt.slice(task[0].length) : txt, task: task ? task[1] !== " " : null, children: null };
          if (lvl === 0) {
            if (!list.levels[0]) list.levels[0] = { ordered: ordered, items: [] };
            list.levels[0].items.push(it);
          } else {
            var pArr = list.levels[lvl - 1].items, parent = pArr[pArr.length - 1];
            if (!parent.children) parent.children = { ordered: ordered, items: [] };
            list.levels[lvl] = parent.children;   // 回落再嵌套时挂到当前父项， siblings 各自成树
            parent.children.items.push(it);
          }
          continue;
        }
        var q = /^\s{0,3}>\s?(.*)$/.exec(line);
        if (q) { closePara(); closeList(); (quote = quote || []).push(q[1]); continue; }
        closeList(); closeQuote();
        (para = para || []).push(line);   // 段内软换行按作者换行保留
      }
      if (code !== null) blocks.push({ type: "pre", text: codeText || "" });
      closeAll();
      return blocks;
    }
    function notesListHtml(node, depth) {
      var out = node.ordered ? "<ol>" : "<ul>";
      for (var i = 0; i < node.items.length; i++) {
        var it = node.items[i];
        out += "<li>" + (it.task === null ? "" : '<input type="checkbox" disabled' + (it.task ? " checked" : "") + ">") + notesInline(it.text);
        if (it.children && depth < 3) out += notesListHtml(it.children, depth + 1);
        out += "</li>";
      }
      return out + (node.ordered ? "</ol>" : "</ul>");
    }
    function notesCellAttr(al) { return al ? ' style="text-align:' + al + '"' : ""; }
    function notesBlockHtml(b) {
      if (b.type === "h") return '<div class="zu-notes-h zu-notes-h' + b.level + '">' + notesInline(b.text) + "</div>";
      if (b.type === "list") return notesListHtml(b, 1);
      if (b.type === "table") {
        var out = "<table><thead><tr>", c;
        for (c = 0; c < b.head.length; c++) out += "<th" + notesCellAttr(b.align[c]) + ">" + notesInline(b.head[c]) + "</th>";
        out += "</tr></thead><tbody>";
        for (var r = 0; r < b.rows.length; r++) {
          out += "<tr>";
          for (c = 0; c < b.rows[r].length; c++) out += "<td" + notesCellAttr(b.align[c]) + ">" + notesInline(b.rows[r][c]) + "</td>";
          out += "</tr>";
        }
        return out + "</tbody></table>";
      }
      if (b.type === "quote") return "<blockquote>" + notesInline(b.text).replace(/\n/g, "<br>") + "</blockquote>";
      if (b.type === "pre") return "<pre><code>" + mEsc(b.text) + "</code></pre>";
      if (b.type === "hr") return "<hr>";
      return "<p>" + notesInline(b.text).replace(/\n/g, "<br>") + "</p>";
    }
    /* 按标题分节：只用于折叠预览与「升级注意」置顶；正文渲染永远完整，不靠标题截内容 */
    function notesSectionsOf(blocks) {
      var sections = [], cur = null;
      for (var i = 0; i < blocks.length; i++) {
        if (!cur || blocks[i].type === "h") {
          if (cur) sections.push(cur);
          cur = { title: blocks[i].type === "h" ? blocks[i].text : "", blocks: [] };
        }
        cur.blocks.push(blocks[i]);
      }
      if (cur) sections.push(cur);
      return sections;
    }
    function notesIsAttn(title) {
      return /升级|注意|兼容|Breaking|Upgrade|Attention|Important|⚠/i.test(String(title || ""));
    }
    function notesSectionHtml(sec) {
      var out = "";
      for (var i = 0; i < sec.blocks.length; i++) out += notesBlockHtml(sec.blocks[i]);
      return out;
    }
    function notesListLen(items) {
      var n = 0;
      for (var i = 0; i < items.length; i++) n += String(items[i].text || "").length + (items[i].children ? notesListLen(items[i].children.items) : 0);
      return n;
    }
    function notesSectionLen(sec) {
      var n = String(sec.title || "").length;
      for (var i = 0; i < sec.blocks.length; i++) {
        var b = sec.blocks[i];
        n += String(b.text || "").length + (b.items ? notesListLen(b.items) : 0) +
          (b.head ? b.head.join("").length + b.rows.join("").length : 0);
      }
      return n;
    }
    /* 折叠预览：整节切分（不截半节），预览取前面的节到约 600 字符为止；「升级注意」类
     * 标题的节无论位置都完整可见并高亮。折叠态明确提示还有更多内容，不静默丢弃。 */
    /* 渲染入口：正文先钳长（缓存层也会截，这里兜底直传路径），4 连以上反引号归一为
     * 三连——行内代码正则对长反引号串是多项式回溯（实测 8KB 数百 ms、64KB 分钟级），
     * 外部正文不可信，必须在进正则前拆掉引爆串。 */
    var NOTES_MAX_RENDER_CHARS = 64 * 1024;
    function notesHtml(md, expanded) {
      md = String(md || "").slice(0, NOTES_MAX_RENDER_CHARS).replace(/`{4,}/g, "```");
      var sections = notesSectionsOf(notesBlocks(md));
      var attn = [], normal = [];
      for (var i = 0; i < sections.length; i++) (notesIsAttn(sections[i].title) ? attn : normal).push(sections[i]);
      if (expanded) {
        var full = "";
        for (i = 0; i < normal.length; i++) full += notesSectionHtml(normal[i]);
        for (i = 0; i < attn.length; i++) full += '<div class="zu-notes-attn">' + notesSectionHtml(attn[i]) + "</div>";
        return { html: full, more: false };
      }
      var html = "", count = 0, shown = 0;
      for (i = 0; i < normal.length; i++) {
        if (count >= 600 && shown > 0) break;
        html += notesSectionHtml(normal[i]); count += notesSectionLen(normal[i]); shown++;
      }
      for (i = 0; i < attn.length; i++) html += '<div class="zu-notes-attn">' + notesSectionHtml(attn[i]) + "</div>";
      return { html: html, more: shown < normal.length };
    }
    function requestNotes(version, force) {
      if (!version) return;
      var seq = ++notesReqSeq;
      notesLoadedVersion = version; notesResult = null; notesError = { reason: "loading" };
      notesAutoTriedVersion = version;   // 手动/切换请求自己负责加载：防止 syncNotes 自动分支对同版本再触发（重复拉取反馈环）
      notesRequestedAt = Date.now();
      syncNotes();
      pluginRequest("release-notes", { version: version, force: force === true }, function (result) {
        if (inactive() || seq !== notesReqSeq) return;   // 乱序/实例销毁守卫：旧结果不覆盖新选择
        notesResult = result && result.ok ? result : null;
        notesError = result && !result.ok ? result : null;
        syncNotes();
      });
    }
    function requestNotesList(force) {
      var seq = ++notesListSeq;
      notesHistoryState = "loading";
      renderNotesHistory();
      pluginRequest("release-notes-list", { force: force === true }, function (result) {
        if (inactive() || seq !== notesListSeq) return;
        notesHistory = result && result.ok && Array.isArray(result.releases) ? result : null;
        notesHistoryError = result && !result.ok ? result : null;
        notesHistoryState = "done";
        renderNotesHistory();
      });
    }
    function renderNotesHistory() {
      var histPanel = panel.querySelector(".zu-notes-history");
      if (!histPanel || histPanel.hidden) return;
      var rows = notesHistory && notesHistory.releases;
      var cur = notesPickTarget(state.pluginUpdate).target;
      var sig = notesHistoryState + "|" + (rows ? rows.map(function (r) { return r.tag; }).join(",") : "") +
        "|" + (notesHistoryError ? String(notesHistoryError.reason || notesHistoryError.error || "err") : "") +
        "|" + (cur && cur.version ? cur.version : "");   // 选中版本变化也要重绘（aria-current 即时迁移）
      if (sig === notesHistorySig) return;
      notesHistorySig = sig;
      var html = "";
      if (notesHistoryState === "loading") html = '<div class="zu-notes-hist-note">' + L("正在加载历史版本…", "Loading version history…") + "</div>";
      else if (!rows) {
        var reason = notesHistoryError ? String(notesHistoryError.reason || "") : "";
        var errText = notesHistoryError ? String(notesHistoryError.error || notesHistoryError.message || "") : "";
        html = '<div class="zu-notes-hist-note">' + (/^unknown action:/.test(errText) ? L("当前主进程为旧版本，暂不支持在线历史版本。", "The main process is outdated; online history is unavailable.")
          : reason === "rate-limited" ? L("暂时无法获取历史版本（API 限流），可稍后重试。", "Version history is temporarily unavailable (rate limited); try again later.")
          : reason === "unsupported-channel" || reason === "unsupported" ? L("当前来源暂不支持在线日志。", "Online release notes are not available for this source.")
          : reason ? L("暂时无法获取历史版本，可重试。", "Version history is temporarily unavailable; retry.")
          : L("暂无历史版本记录。", "No version history yet.")) + "</div>";
        if (reason && reason !== "unsupported-channel" && reason !== "unsupported" && !/^unknown action:/.test(errText)) {
          html += '<button type="button" class="zu-notes-hist-retry">' + L("重试", "Retry") + "</button>";   // 失败态给重试入口（force 绕过缓存）
        }
      } else {
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          html += '<button type="button" class="zu-notes-hist-item" data-version="' + mEsc(r.version) + '"' +
            (cur && cur.version === r.version ? ' aria-current="true"' : "") + '><span class="zu-notes-hist-ver">' + mEsc(r.tag) +
            '</span><span class="zu-notes-hist-name">' + mEsc(r.name !== r.tag ? r.name : notesFmtDate(r.publishedAt)) + "</span></button>";
        }
        html += '<div class="zu-notes-hist-note">' + L("仅列出正式发布的版本；更早的历史版本可能未收录。", "Stable releases only; older versions may be missing.") + "</div>";
      }
      histPanel.innerHTML = html;
    }
    function syncNotes() {
      var u = state.pluginUpdate;
      var badge = panel.querySelector(".zu-notes-badge");
      var meta = panel.querySelector(".zu-notes-meta");
      var body = panel.querySelector(".zu-notes-body");
      var histBtn = panel.querySelector(".zu-notes-history-btn");
      var backBtn = panel.querySelector(".zu-notes-back");
      var toggle = panel.querySelector(".zu-notes-toggle");
      var link = panel.querySelector(".zu-notes-link");
      var retry = panel.querySelector(".zu-notes-retry");
      var histPanel = panel.querySelector(".zu-notes-history");
      if (!badge || !meta || !body || !histBtn || !backBtn || !toggle || !link || !retry || !histPanel) return;
      var ch = notesChannelOf(u);
      var pick = notesPickTarget(u);
      var def = pick.def, target = pick.target;
      /* 空状态：渠道明确为 market/local 时不联网（market 有注册仓库时给明确标注的参考链接）；
       * 版本身份缺失时明示，不冒充。渠道未知但有当前版本时不再空转——走下方正常流程，
       * 由主进程渠道门控裁决（本地/源码渠道会被拒绝且零网络开销）。 */
      var emptyKey = "";
      if (!target) emptyKey = !u || !u.supported ? "inactive" : "nomatch";
      else if (target.unknown) emptyKey = "unknown";   // 待重启但版本身份无法确定：明示，不冒充
      else if (!ch && u && u.channel === "local") emptyKey = "local";   // 本地目录：无仓库身份，不联网
      if (emptyKey) {
        notesBodySig = ""; body.innerHTML = ""; body.setAttribute("aria-busy", "false");
        badge.textContent = ""; badge.style.display = "none";
        meta.textContent = emptyKey === "local" ? L("本地目录来源不联网，暂无更新日志。", "Directory sources stay offline; no release notes.")
          : emptyKey === "unknown" ? L("已安装待重启，但无法确定本次安装的版本，暂不显示更新日志。", "Waiting for restart, but the installed version can't be determined; notes are hidden.")
          : L("尚未检查或没有可靠的版本身份；检查更新后这里会显示对应版本的日志。", "No reliable version identity yet; run a check to see matching notes.");
        histBtn.hidden = true; histPanel.hidden = true;
        backBtn.hidden = true;
        toggle.hidden = true; retry.hidden = true;
        link.hidden = true; link.removeAttribute("data-href");
        return;
      }
      /* Release 渠道：按 target 拉取并渲染 */
      var visible = panel.classList.contains("open") && activeSettingsSec() === "update";
      if (visible && notesAutoTriedVersion !== target.version) {
        notesAutoTriedVersion = target.version;   // 每个目标只自动拉一次；失败后靠手动重试，不做高频轮询
        requestNotes(target.version, false);
        return;
      }
      if (notesError && notesError.reason === "loading" && Date.now() - notesRequestedAt > NOTES_LOADING_TIMEOUT_MS) {
        notesError = { reason: "network", message: "timeout" };   // 回执丢失兜底：不再永挂「正在加载」，转可重试
      }
      var loading = notesError && notesError.reason === "loading" && notesLoadedVersion === target.version;
      var status = target.status === "history" ? "history" : def && def.version === target.version ? def.status : "history";
      badge.style.display = "";
      badge.textContent = notesStatusBadge(status) + " · v" + target.version;
      badge.classList.toggle("zu-notes-warn", status === "failed");
      /* 未核实标注：market（源码）渠道展示的是注册仓库的同号 Release，不冒充本渠道已核实内容 */
      var unverified = (ch ? ch.verified === false : notesLoadedVersion === target.version &&
        !!(notesResult && notesResult.verified === false));
      var srcLabel = ch ? (ch.flavor === "gitcode" ? "GitCode" : "GitHub")
        : notesHostLabel(notesLoadedVersion === target.version ? notesResult : null);
      if (notesLoadedVersion === target.version && notesResult && notesResult.mirror) {
        srcLabel = L("GitCode 镜像（GitHub 限流回退）", "GitCode mirror (GitHub rate-limit fallback)");   // 镜像回退如实标注实际来源
      }
      var metaText = notesLoadedVersion === target.version && notesResult && notesResult.cachedAt
        ? (srcLabel ? L("来源：", "Source: ") + srcLabel : "") +
          (notesResult.stale ? L(" · 正在显示缓存，最近获取：", " · showing cache, fetched: ") : L(" · 缓存于：", " · cached: ")) + (isFinite(notesResult.cachedAt) ? notesFmtDate(new Date(Math.min(notesResult.cachedAt, 8.64e15)).toISOString()) : "")
        : loading ? L("正在加载更新日志…", "Loading release notes…")
        : srcLabel ? L("来源：", "Source: ") + srcLabel + (ch && ch.flavor === "gitcode" && u.channelRepo ? " · " + u.channelRepo : "") : "";
      if (unverified && notesLoadedVersion === target.version && notesResult) {
        metaText += (metaText ? " " : "") + L("· 参考：同号 Release，未核实与本渠道一致", "· reference: same-version release, parity with this source unverified");
      }
      meta.textContent = metaText;
      var notesProved = notesLoadedVersion === target.version &&
        ((notesResult && typeof notesResult.url === "string") || (notesError && notesError.reason === "missing"));
      histBtn.hidden = !(ch || notesProved);   // 渠道已知或已被回复证实为 Release 渠道才提供历史版本
      /* 粘性选择的返回入口：默认目标存在且与当前不同时可见；安装状态变化时由此轻量收敛 */
      var backVisible = !!(notesSel.explicit && def && def.version && def.version !== target.version);
      backBtn.hidden = !backVisible;
      if (backVisible) backBtn.textContent = L("返回默认版本 v", "Back to v") + def.version;
      if (histPanel.hidden) notesHistorySig = "";   // 收起后下次展开强制重绘（状态可能已变）；开合只由用户点击驱动
      var pageUrl = ch ? notesReleasePageUrl(ch.flavor, u.channelRepo, target.version) : "";
      if (notesLoadedVersion === target.version && notesResult && notesResult.mirror && typeof notesResult.url === "string" &&
          notesResult.url.length <= 600 && /^https:\/\/(github|gitcode)\.com\//.test(notesResult.url)) {
        pageUrl = notesResult.url;   // 镜像回退：链接指向内容实际来源的发布页
      }
      if (!pageUrl && notesProved && notesResult && typeof notesResult.url === "string" &&
          notesResult.url.length <= 600 && /^https:\/\/(github|gitcode)\.com\//.test(notesResult.url)) pageUrl = notesResult.url;
      pageUrl = notesReachablePageUrl(pageUrl);   // 主路径与镜像/未核实回退统一：GitCode tag 深链是平台 bug 页，落到可达的列表页
      if (pageUrl) {
        link.hidden = false; link.setAttribute("data-href", pageUrl);
        link.textContent = unverified ? L("参考：发布页（未核实与本渠道一致）", "Reference: releases page (parity unverified)") : L("完整发布说明", "Full release notes");
      }
      else { link.hidden = true; link.removeAttribute("data-href"); }
      retry.hidden = !(notesError && notesLoadedVersion === target.version && ["rate-limited", "network", "error"].indexOf(notesError.reason) >= 0);
      /* 正文：签名幂等——内容没变不重建，保滚动位置与焦点 */
      var rendered = null, html = "", sig = "";
      if (loading) { html = '<p class="zu-notes-more">' + L("正在加载更新日志…", "Loading release notes…") + "</p>"; sig = "loading|" + target.version; }
      else if (notesResult && notesLoadedVersion === target.version && typeof notesResult.body === "string") {
        rendered = notesHtml(notesResult.body, notesExpanded);
        html = rendered.html;
        if (rendered.more) html += '<p class="zu-notes-more">' + L("还有更多内容，点下方「展开全部」。", "More content below — use \"Expand\" to show it all.") + "</p>";
        sig = "ok|" + target.version + "|" + notesExpanded + "|" + html.length;
      } else if (notesError && notesLoadedVersion === target.version) {
        var reason = String(notesError.reason || "");
        html = '<p class="zu-notes-more">' + (reason === "missing" ? L("此版本暂无更新日志（可能尚未发布 Release）。", "No release notes for this version (release may not exist yet).")
          : reason === "rate-limited" ? L("暂时无法获取（API 限流），可点「重试」。", "Temporarily unavailable (rate limited); use \"Retry\".")
          : reason === "unsupported-channel" || reason === "unsupported" ? L("当前来源暂不支持在线日志。", "Online release notes are not available for this source.")
          : /^unknown action:/.test(String(notesError.error || "")) ? L("当前主进程为旧版本，暂不支持在线日志。", "The main process is outdated; online notes are unavailable.")
          : reason === "loading" ? L("正在加载更新日志…", "Loading release notes…")
          : L("暂时无法获取，可点「重试」。", "Temporarily unavailable; use \"Retry\".")) + "</p>";
        sig = "err|" + target.version + "|" + reason;
      } else { html = '<p class="zu-notes-more">' + L("正在加载更新日志…", "Loading release notes…") + "</p>"; sig = "pending|" + target.version; }
      if (sig !== notesBodySig || (!body.innerHTML && html)) {   // 后者：buildPanel 重建骨架后闭包签名残留，强制回填正文
        notesBodySig = sig;
        body.innerHTML = html;
        body.setAttribute("aria-busy", loading ? "true" : "false");
      }
      toggle.hidden = !(notesResult && notesLoadedVersion === target.version);
      toggle.textContent = notesExpanded ? L("收起", "Collapse") : L("展开全部", "Expand all");
      if (notesHistoryState === "" && !histPanel.hidden) requestNotesList(false);
    }
    /* ---------- v179 自动压缩阈值（⚙ 面板渲染与提交的单一出口） ---------- */
    /* v426：模式由 .zu-ac-mode 下拉显式选择（v420 双域隐式约定废弃），解析按下拉值驱动——
     * percent=30-99 整数；tokens=≥100000，保留 k/K/M 后缀（如 300k）；留空=default；
     * 其余（含另一模式的合法值）=null。writeConfig/引擎 hook 同限，此处拦截只为不把非法值发出去。 */
    function parseAcValue(raw, mode) {
      var s = String(raw == null ? "" : raw).trim();
      if (s === "") return { mode: "default", value: "" };
      if (mode !== "tokens") {
        var p = Math.round(Number(s));
        return isFinite(p) && p >= 30 && p <= 99 ? { mode: "percent", value: p } : null;
      }
      var m = s.match(/^(\d+(?:\.\d+)?)([kKmM])$/);
      var n = Math.round(m ? parseFloat(m[1]) * (m[2].toLowerCase() === "k" ? 1000 : 1000000) : Number(s));
      return isFinite(n) && n >= 100000 ? { mode: "tokens", value: n } : null;
    }
    /* v420：tokens 模式回显规整形式（整除千位显示 k 后缀，如 300000→300k） */
    function formatAcValue(mode, value) {
      var n = Number(value);
      if (mode !== "tokens" || !isFinite(n)) return String(value);
      return n >= 1000 && n % 1000 === 0 ? (n / 1000) + "k" : String(n);
    }
    /* v436：切模式时数值跟随换算（percent↔tokens 双向），基准=当前会话上下文窗口
     * （lastBand.cw，与 acWarningText 同源），取不到按 1,000,000 兜底。仅本侧合法值
     * 才换算（空/非法保持原样，交状态行校验提示），结果钳进对侧合法域
     * （tokens≥100k、percent 30-99）。只改输入框显示，不提交——仍由 input change 落盘。 */
    function acConvertOnModeSwitch(sel) {
      var input = panel.querySelector(".zu-ac-value");
      if (!input || document.activeElement === input) return;
      var toMode = sel.value === "tokens" ? "tokens" : "percent";
      var parsed = parseAcValue(input.value, toMode === "tokens" ? "percent" : "tokens");
      if (!parsed || parsed.mode === "default") return;   // 空=default：切模式保持留空语义，不伪造数值
      var cw = lastBand && isFinite(lastBand.cw) && lastBand.cw > 0 ? lastBand.cw : 1000000;
      var n = toMode === "tokens" ? Math.round(cw * parsed.value / 100) : Math.round(parsed.value / cw * 100);
      input.value = formatAcValue(toMode, toMode === "tokens" ? Math.max(100000, n) : Math.min(99, Math.max(30, n)));
    }
    function acModeOf(cfg) {
      if (!cfg || typeof cfg !== "object") return { mode: "default", value: "" };
      if (cfg.enabled === false) return { mode: "disabled", value: "" };
      if (isFinite(cfg.thresholdPercent)) return { mode: "percent", value: String(cfg.thresholdPercent) };
      if (isFinite(cfg.thresholdTokens)) return { mode: "tokens", value: String(cfg.thresholdTokens) };
      if (isFinite(cfg.bufferTokens)) return { mode: "buffer", value: String(cfg.bufferTokens) };
      return { mode: "default", value: "" };
    }
    function syncAutoCompactInputs() {
      var input = panel.querySelector(".zu-ac-value");   // v188：留空=跟随引擎默认；v420：tokens 回显（300k 规整形式）
      var modeSel = panel.querySelector(".zu-ac-mode");   // v426：模式下拉（percent/tokens）
      var cur = acModeOf(state.enginePatch && state.enginePatch.config);
      if (input && document.activeElement !== input) input.value = cur.mode === "percent" || cur.mode === "tokens" ? formatAcValue(cur.mode, cur.value) : "";
      if (modeSel && document.activeElement !== modeSel) modeSel.value = cur.mode === "tokens" ? "tokens" : "percent";   // default/disabled/buffer 显示 percent（buffer 协议保留不暴露）
      /* v190：注入开关关闭时数值行没有意义，整行隐藏 */
      var acRow = input && input.closest ? input.closest("label") : null;
      if (acRow) acRow.hidden = !!(state.enginePatch && state.enginePatch.enabled === false) || state.enginePatch == null;
      acRefreshStatusLine();
    }
    /* v445：状态行（引擎状态 + 数值行按当前模式的实时校验提示）单独成函数——切模式
     * 换算后只重算它，不回写输入框（整段 sync 会把换算结果抹回已保存值；而换算前的
     * sync 是按新模式校验旧值，留下的「百分比需在 30-99」红字会挂在已合法的新值旁）。 */
    function acRefreshStatusLine() {
      var node = panel.querySelector(".zu-ac-status");
      if (!node) return;
      var input = panel.querySelector(".zu-ac-value"), modeSel = panel.querySelector(".zu-ac-mode");
      var ep = state.enginePatch;
      var text = "";
      if (!ep) text = L("主进程补丁模块未加载；完全重启 ZCode 后可用。", "Engine patch module not loaded; fully restart ZCode first.");
      else if (!ep.enabled) text = L("开关关闭：引擎保持原生行为。", "Off: the engine keeps its built-in behavior.");
      else {
        var m = {
          applied: L("已注入", "Injected"),
          unsupported_build: L("当前客户端引擎版本不在支持名单，等待插件更新", "This engine build is not supported yet; wait for a plugin update"),
          engine_missing: L("未找到引擎文件", "Engine file not found"),
          busy: L("引擎文件被占用，重启 ZCode 后重试", "Engine file is busy; restart ZCode and retry"),
          error: L("注入失败", "Injection failed"),
        };
        /* v225（issue #191）：桌面 build 已登记而引擎 sha 脱钩 = 引擎文件被单独热更，
         * 与"全新桌面版本"分开明示；lastError 后缀此时与 sha 重复，不再拼接。 */
        var drift = ep.state === "unsupported_build" && ep.drifted;
        var sha12 = typeof ep.engineSha256 === "string" && ep.engineSha256.length >= 12 ? ep.engineSha256.slice(0, 12) : "";
        var base = drift
          ? L("客户端引擎文件已被单独热更" + (sha12 ? "（sha " + sha12 + "…）" : "") + "，自动压缩阈值暂不可用；等待插件适配，可将该 sha 前缀反馈给维护者加快登记",
              "The engine file was hot-updated separately" + (sha12 ? " (sha " + sha12 + "…)" : "") + "; the auto-compact threshold is unavailable until the plugin adapts — reporting this sha prefix to the maintainer speeds up registration")
          : (m[ep.state] || ep.state);
        text = base + (ep.build ? " · " + ep.build : "") +
          (ep.state === "applied" ? L("；已运行会话保持旧阈值，新会话生效", "; running sessions keep the old threshold, new sessions apply") : "") +
          (ep.lastError && ep.state !== "applied" && !drift ? " · " + ep.lastError : "");
      }
      var warn = acWarningText();
      /* v194→v426：数值行实时校验按 .zu-ac-mode 下拉模式——percent 30-99、tokens ≥100k（支持 k/M 后缀），非法在状态行提示，提交侧同步拒绝 */
      var acv = input && input.value != null ? String(input.value).trim() : "";
      var acMode = modeSel && modeSel.value === "tokens" ? "tokens" : "percent";
      var bad = acv !== "" && !parseAcValue(acv, acMode);
      var msg = (bad ? (acMode === "tokens" ? L("⚠ Token 数需 ≥100k，支持 k/M 后缀（如 300k）；数字低于 100k 失焦自动取 100k", "⚠ Tokens must be ≥100k; k/M suffix allowed (e.g. 300k); numbers below 100k are clamped to 100k on blur")
        : L("⚠ 百分比需在 30-99 之间", "⚠ Percent must be between 30 and 99")) : "") +
        (warn ? (bad ? "\n" : "") + warn : "");
      node.textContent = text + (msg ? "\n" + msg : "");
      node.classList.toggle("zu-ac-warn", !!(warn || bad));
    }
    function acTargetTokens(mc, cw) {
      if (mc.mode === "default" || mc.mode === "disabled") return null;
      var RESERVE = 21000;   // 引擎输出预留上限（policy.ts PREFLIGHT 常量；实际 min(maxOut,21K)，此处近似）
      var th = mc.mode === "percent" ? Math.min(cw * (parseFloat(mc.value) / 100), cw - RESERVE)   // v194：总窗口口径（与引擎 hook 同式），极端值钳在有效窗口内
        : mc.mode === "tokens" ? parseFloat(mc.value)
          : (cw - RESERVE) - parseFloat(mc.value);
      return isFinite(th) ? th : null;
    }
    function acWarningText() {
      var ep = state.enginePatch;
      if (!ep || !ep.enabled || ep.state !== "applied") return "";
      var mc = acModeOf(ep.config);
      var cw = lastBand && lastBand.cw;
      var cur = lastBand && isFinite(lastBand.pct) ? lastBand.pct : null;
      if (!cw || cur == null) return "";
      var th = acTargetTokens(mc, cw);
      if (th == null) return "";
      return th / cw * 100 < cur ? L("⚠ 目标阈值低于当前用量，可能立即触发压缩", "⚠ Target threshold is below current usage; compaction may trigger immediately") : "";
    }
    function sendAutoCompactConfig() {
      var input = panel.querySelector(".zu-ac-value");
      if (!input) return;
      var value = input.value.trim();
      /* v194→v426：按下拉模式解析（percent 30-99；tokens ≥100k 支持 k/M），非法不提交（状态行实时提示），避免非法值写进 autocompact.json。
       * v438：tokens 模式纯数字/带 kM 后缀但低于 100k（如 65、65k）失焦自动钳到 100k 回显并提交（用户规格）；非数字仍提示不提交。 */
      var modeSel = panel.querySelector(".zu-ac-mode");
      var acIsTokens = !!(modeSel && modeSel.value === "tokens");
      var parsed = parseAcValue(value, acIsTokens ? "tokens" : "percent");
      if (value !== "" && !parsed) {
        if (acIsTokens && /^\d+(?:\.\d+)?[kKmM]?$/.test(value)) {
          input.value = formatAcValue("tokens", 100000);
          parsed = { mode: "tokens", value: 100000 };
        } else { showSettingsFeedback(true); return; }
      }
      showSettingsFeedback(false, true);
      /* v188：留空=跟随引擎默认（default，value 不上线）；v420：有值按解析模式提交（percent/tokens） */
      pluginRequest("autocompact-config", { mode: parsed.mode, value: parsed.mode === "default" ? undefined : parsed.value }, function (result) {
        if (inactive()) return;
        if (result.ok) {
          if (result.config) { if (!state.enginePatch) state.enginePatch = { enabled: false, state: "off" }; state.enginePatch.config = result.config; }
          showSettingsFeedback(false, false);
        } else showSettingsFeedback(true);
        syncAutoCompactInputs();   // 成败都回写主进程真值（失败回滚为主进程现值）
      });
    }
    function srcStatusText(sv) {
      if (sv.busy) return L("查询中…", "Querying…");
      var m = { ok: L("查询成功", "Query succeeded"), idle: L("待查询", "pending"), not_configured: L("未配置凭据", "credential missing"),
        disabled: L("已关闭", "off"),
        auth_failed: L("认证失效", "auth failed"), no_plan: L("无订阅", "no subscription"),
        rate_limited: L("限流中", "rate limited"), network_error: L("查询失败", "failed"),
        parse_error: L("响应异常", "bad response"), unsupported: L("不支持", "unsupported") };
      return m[sv.status] || sv.status || "";
    }
    function showSettingsFeedback(error, pending) {
      var node = panel.querySelector(".zu-settings-feedback-status");
      if (!node) return;
      node.textContent = pending ? (state.pluginUpdate && state.pluginUpdate.feedbackVersion >= 1 ? L("操作已发出，等待确认…", "Sent; awaiting confirmation…") : L("操作已发出；保存确认需重启后端", "Sent; restart the backend for save confirmation")) : error ? L("保存失败，请重试", "Save failed; try again") : L("已保存", "Saved");
      node.classList.toggle("zu-feedback-error", !!error);
    }
    function showSourceFeedback(id, error, pending, text) {
      sourceFeedback[id] = { error: !!error, pending: !!pending, text: text || "" };   // text：千问登录等自定义反馈（重建行时保留）
      var rows = panel.querySelectorAll(".zu-src-row[data-src]");
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute("data-src") !== String(id)) continue;
        var node = rows[i].querySelector(".zu-src-feedback");
        if (!node) return;
        node.textContent = text || (pending ? (state.pluginUpdate && state.pluginUpdate.feedbackVersion >= 1 ? L("操作已发出，等待确认…", "Sent; awaiting confirmation…") : L("操作已发出；保存确认需重启后端", "Sent; restart the backend for save confirmation")) : error ? L("操作失败，请重试", "Action failed; try again") : L("已保存", "Saved"));
        node.classList.toggle("zu-feedback-error", !!error);
        return;
      }
    }
    /* ---------- v132 模型拉取（收编 zcode-model-puller，挂宿主设置页）----------
     * 挂载点：官方「模型设置 → 自定义供应商」的「+ 添加模型」按钮左侧（锚
     * data-testid=model-provider-add-model-button），与额度 chip 同款 enhance/restore
     * 契约（render/heavy 双对账 + 位置兜回，React 不清理手动属性/兄弟节点）。
     * 供应商归属：优先读设置页表单里的 http(s) Base URL 匹配主进程供应商列表，唯一命中
     * 直接拉取；否则单供应商直用、多供应商弹选择。模型 id 是远端 /models 响应内容，弹窗
     * 全部 innerHTML 拼接处经 mEsc 转义。mpAsk 25s 兜底：旧主进程不识别 action 时提示
     * 完全重启而非永久 loading。 */
    var mpModal = null, mpHostBtn = null;
    var mpWaiters = [];
    var MP_HOST_ANCHOR = '[data-testid="model-provider-add-model-button"]';
    /* v309 确认前自动探测：勾选 ≤24 个才逐个发最小请求验证（并发 4），全部通过才写入；
     * 有失败自动取消勾选并保留弹窗展示原因（可重新勾选强制添加）。数量上限防异常全选
     * 大列表时弹窗被探测阻塞（>24 直接保存，与旧版行为一致）。 */
    var MP_TEST_MAX = 24, MP_TEST_CONC = 4;
    function mEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function mpAsk(action, extra, done, timeoutMs) {
      var settled = false, requestId = "";
      function cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var index = mpWaiters.indexOf(cancel);
        if (index >= 0) mpWaiters.splice(index, 1);
        if (typeof pluginRequestCallbacks !== "undefined") delete pluginRequestCallbacks[requestId];
      }
      function finish(result) {
        if (settled) return;
        cancel();
        done(result || { ok: false, error: "no response" });
      }
      var timer = setTimeout(function () { finish(null); }, timeoutMs || 25000);
      if (timer && typeof timer.unref === "function") timer.unref();
      mpWaiters.push(cancel);
      requestId = pluginRequest(action, extra, finish);
    }
    function mpErrorText(err) {
      var s = (err && err.error) || err || "";
      if (s === "no response") {
        return L("请求超时：多候选端点全部无响应，或主进程仍是旧版（模型拉取需完全退出并重开 ZCode 加载）。", "Timed out: every candidate endpoint hung, or the main process is outdated (fully quit and reopen ZCode to load model pulling).");
      }
      if (s === "unavailable") {
        return L("主进程可能仍是旧版：模型拉取需完全退出并重开 ZCode 加载。", "The main process may be outdated: fully quit and reopen ZCode to load model pulling.");
      }
      return String(s);
    }
    /* 探测结果 → 人话（v309）：path 类必须带宿主实际请求 URL——Base URL 少 /v1 这类错配
     * 的诊断价值全在这一行；kind 与主进程 classifyProbeStatus 对齐，摘录已在主进程脱敏 */
    function mpProbeFailText(result) {
      var r = result || {};
      var kind = String(r.kind || "");
      var detail = (r.url ? "\n" + r.url : "") + (r.snippet ? "\n" + r.snippet : "");
      if (kind === "auth") return L("鉴权失败：API Key 无效或无权限（HTTP " + (r.status || "?") + "）", "Auth failed: API key invalid or unauthorized (HTTP " + (r.status || "?") + ")") + detail;
      if (kind === "path") return L("路径不匹配（HTTP " + (r.status || "?") + "）：宿主实际请求 " + (r.url || "") + "。OpenAI 兼容接口的 Base URL 通常需要以 /v1 结尾；Anthropic 协议由客户端自动补 /v1、无需手写。",
        "Path mismatch (HTTP " + (r.status || "?") + "): the client actually requests " + (r.url || "") + ". OpenAI-compatible base URLs usually need to end with /v1; the Anthropic protocol auto-appends /v1.") + (r.snippet ? "\n" + r.snippet : "") +
        (r.tried && r.tried.length ? "\n" + L("已尝试自动修复（候选也失败）：" + r.tried.join("、"), "Auto-repair tried (candidate also failed): " + r.tried.join(", ")) : "");
      if (kind === "rate") return L("被限流（HTTP 429）：模型可达但被限流，稍后重试。", "Rate limited (HTTP 429): reachable but throttled; retry later.") + detail;
      if (kind === "bad_request") return L("请求被拒绝（HTTP 400）：模型名可能不存在或参数不被接受。", "Rejected (HTTP 400): the model id may not exist or params are not accepted.") + detail;
      if (kind === "server") return L("服务端错误（HTTP " + (r.status || "?") + "）。", "Server error (HTTP " + (r.status || "?") + ").") + detail;
      if (kind === "timeout") return L("超时：网关无响应（15 秒）。", "Timed out: gateway not responding (15s).") + detail;
      if (kind === "network") return L("网络错误：无法连接。", "Network error: cannot connect.") + detail;
      if (kind === "provider") return L("供应商配置不可用。", "Provider config unavailable.") + detail;
      if (kind === "unsupported") return L("该接口类型不支持自动探测。", "This API type does not support auto testing.") + detail;
      if (kind === "reasoning") return L("思考档位被上游拒绝（HTTP " + (r.status || "?") + "）：自动写实未成功" + (r.accepted && r.accepted.length ? "，上游接受 " + r.accepted.join("/") : "") + "。可稍后在模型设置的思考下拉手动选择。", "Reasoning level rejected by the upstream (HTTP " + (r.status || "?") + "): auto-heal failed" + (r.accepted && r.accepted.length ? "; the upstream accepts " + r.accepted.join("/") : "") + ". Pick a level later in the model settings.") + detail;
      return L("请求失败" + (r.status ? "（HTTP " + r.status + "）" : "") + "。", "Request failed" + (r.status ? " (HTTP " + r.status + ")" : "") + ".") + detail;
    }
    /* 弹窗行元数据（v130）：ctx/out 可见小字，档位与全量进 title；数值 k/M 紧凑格式。
     * issue #236：无任何证据（无 meta 或全空）时给「未获取配置」中性小字，不再静默按默认写入；
     * 主进程目录补拉中（effortsFetching）时换成「档位补拉中…」状态，用户知道在等什么。 */
    function mpMetaParts(meta, fetching) {
      /* v312：能力/输入正证据也算「获取到配置」——只有能力的模型不再误显「未获取配置」 */
      var hasCaps = !!(meta && ((meta.inputFormat && (meta.inputFormat.supportsImage || meta.inputFormat.supportsPdf || meta.inputFormat.supportsVideo || meta.inputFormat.supportsAudio))
        || meta.supportsJsonSchemaOutput === true || meta.supportsMidConversationSystem === true || meta.supportsToolCall === false));
      if (!meta || (!meta.contextWindow && !meta.maxOutputTokens && !(meta.efforts && meta.efforts.length) && !hasCaps)) {
        if (fetching) {
          return {
            visible: L("档位补拉中…", "efforts pulling…"),
            title: L("思考档位目录正在后台补拉，完成后重新拉取即可显示", "The reasoning-level catalog is being fetched in the background; pull again once it lands"),
          };
        }
        return {
          visible: L("未获取配置", "no config fetched"),
          title: L("未获取到提供商侧配置，写入后保持 ZCode 默认（思考档位/上下文等可在模型设置手动调整）", "No provider-side config fetched; ZCode defaults apply after sync (adjust reasoning/context in model settings)"),
        };
      }
      var fmt = function (n) {
        n = +n;
        if (!isFinite(n) || n <= 0) return "";
        if (n >= 1000000) return (Math.round(n / 100000) / 10) + "M";
        if (n >= 1000) return Math.round(n / 1000) + "k";
        return String(n);
      };
      var visible = [], title = [];
      if (meta.contextWindow) { visible.push(L("上下文 " + fmt(meta.contextWindow), "ctx " + fmt(meta.contextWindow))); title.push("ctx " + fmt(meta.contextWindow)); }
      if (meta.maxOutputTokens) { visible.push(L("输出 " + fmt(meta.maxOutputTokens), "out " + fmt(meta.maxOutputTokens))); title.push("out " + fmt(meta.maxOutputTokens)); }
      if (meta.efforts && meta.efforts.length) title.push(L("思考档位 ", "reasoning ") + meta.efforts.join("/"));
      /* v312 能力/输入匹配徽标：写实的正证据一览（图/PDF/JSON） */
      var caps = [];
      if (meta.inputFormat && meta.inputFormat.supportsImage) caps.push(L("图", "img"));
      if (meta.inputFormat && meta.inputFormat.supportsPdf) caps.push("PDF");
      if (meta.supportsJsonSchemaOutput) caps.push("JSON");
      if (caps.length) { visible.push(caps.join("·")); title.push(caps.join("/")); }
      if (!visible.length && !title.length) return null;
      return { visible: visible.join(" · "), title: title.join(" · ") };
    }
    /* 通用弹窗壳：body 级遮罩（面板同族变量配色），Esc/遮罩/✕ 关闭，返回遮罩节点供调用方绑内容事件 */
    function openMpShell(titleText, bodyHtml) {
      cleanupMpModal();
      var ov = document.createElement("div");
      ov.className = "zu-mp-ov";
      ov.innerHTML = '<div class="zu-mp-modal" role="dialog" aria-modal="true" aria-label="' + mEsc(titleText || L("选择要同步的模型", "Choose models to sync")) + '">' +
        (titleText ? '<div class="zu-mp-head"><div class="zu-mp-title">' + mEsc(titleText) + '</div>' +
        '<button type="button" class="zu-mp-close" aria-label="' + L("关闭", "Close") + '">✕</button></div>' :
        '<button type="button" class="zu-mp-close zu-mp-close-abs" aria-label="' + L("关闭", "Close") + '">✕</button>') + bodyHtml + "</div>";
      ov.classList.toggle("zu-light", !themeDark);   // 弹窗不在 bar 作用域，自带类随主题换装
      document.body.appendChild(ov);
      mpModal = ov;
      mpModalDispose = cleanupMpModal;
      mpModalThemeSync = function (lite) { ov.classList.toggle("zu-light", lite); };
      ov.querySelector(".zu-mp-close").addEventListener("click", cleanupMpModal);
      ov.addEventListener("mousedown", function (e) { if (e.target === ov) cleanupMpModal(); });
      /* Esc 升捕获相 + stopPropagation 对齐词包查看 rotPkKey 协议（05 分片）：mp 壳是视口
       * 最顶层（z-index 拉满），Esc 必须先关弹窗——冒泡相监听会被焦点所在面板的 keydown
       * （closeSettings+stopPropagation）截胡，弹窗留存而设置面板被关（v342 实报） */
      function onEsc(e) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        cleanupMpModal();
      }
      document.addEventListener("keydown", onEsc, true);
      ov.__zuMpEsc = onEsc;
      return ov;
    }
    /* v342 联系我弹窗：设置底栏入口，展示维护者微信二维码（远程直链，加载失败给文字兜底） */
    function openContactModal() {
      var ov = openMpShell(L("联系我", "Contact me"),
        '<img class="zu-ct-img" src="http://qiniu.tanranran.cn/wechat.webp" width="600" height="600" alt="' + L("微信二维码", "WeChat QR code") + '">' +
        '<div class="zu-ct-note" hidden>' + L("图片加载失败，请检查网络后重试。", "Failed to load the image; check your network and retry.") + '</div>');
      ov.classList.add("zu-ct-ov");   // openMpShell 写死 className，收窄卡宽覆写靠此后加类生效
      var img = ov.querySelector(".zu-ct-img");
      var note = ov.querySelector(".zu-ct-note");
      img.addEventListener("error", function () {
        if (!img.isConnected) return;   // 弹窗已关（外壳移除）就不必再改 DOM
        img.hidden = true;
        note.hidden = false;
      });
      return ov;
    }
    /* 模型选择弹窗：勾选（已添加默认不选/新模型默认全选）、搜索、快捷批选，确认后
     * model-pull-apply 最小写回；成功即关闭，宿主模型列表数秒内自动刷新。 */
    function openMpModal(provider, models, metaById, effortsFetching) {
      var metaById2 = metaById || Object.create(null);   // 与 v130 纪律一致：远端数据键一律 null 原型
      var existing = Object.create(null);   // null 原型：模型 id 来自远端，"__proto__" 等键必须可写
      for (var i = 0; i < provider.modelIds.length; i++) existing[provider.modelIds[i]] = true;
      var sel = Object.create(null), newCount = 0;
      for (i = 0; i < models.length; i++) { sel[models[i]] = !existing[models[i]]; if (sel[models[i]]) newCount++; }
      var rows = "";
      for (i = 0; i < models.length; i++) {
        var mid = models[i];
        var meta = mpMetaParts(metaById2[mid], effortsFetching);
        rows += '<label class="zu-mp-item" data-mpid="' + mEsc(mid) + '" title="' + mEsc(meta ? meta.title : mid) + '"><input type="checkbox" data-mpid="' + mEsc(mid) + '"' + (sel[mid] ? " checked" : "") + ">" +
          '<span class="zu-mp-id">' + mEsc(mid) + "</span>" +
          (meta && meta.visible ? '<span class="zu-mp-meta">' + mEsc(meta.visible) + "</span>" : "") +
          (existing[mid] ? '<span class="zu-mp-badge zu-mp-old">' + L("已添加", "Added") + "</span>"
            : '<span class="zu-mp-badge zu-mp-new">' + L("新模型", "New") + "</span>") + "</label>";
      }
      var ov = openMpShell("",
        '<div class="zu-mp-head2"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="zu-mp-bolt"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>' +
        '<span class="zu-mp-title">' + mEsc(L("选择要同步的模型 (共 " + models.length + " 个，待添加新模型 " + newCount + " 个)", "Choose models to sync (" + models.length + " total, " + newCount + " new)")) + "</span></div>" +
        '<div class="zu-mp-sub">' + mEsc(provider.name || provider.id) + "</div>" +
        '<div class="zu-mp-tools"><input type="text" class="zu-mp-search" placeholder="' + L("搜索模型名称…", "Search model names…") + '" aria-label="' + L("搜索模型", "Search models") + '">' +
        '<div class="zu-mp-quick"><button type="button" class="zu-mp-all">' + L("全选", "All") + "</button>" +
        '<button type="button" class="zu-mp-none">' + L("清空", "None") + "</button>" +
        '<button type="button" class="zu-mp-fresh">' + L("仅选新模型", "New only") + " (" + newCount + ")</button></div></div>" +
        '<div class="zu-mp-items">' + rows + "</div>" +
        (effortsFetching ? '<div class="zu-mp-note">' + mEsc(L("思考档位目录正在后台补拉（约数 MB，不阻塞本轮），完成后重新拉取即可显示档位。", "The reasoning-level catalog is being fetched in the background (a few MB, non-blocking); pull again once it lands to show levels.")) + "</div>" : "") +
        '<div class="zu-mp-note">' + mEsc(L("仅新增写入：已有显式配置不会被覆盖；未获取到配置的模型保持 ZCode 默认值。确认会向供应商发送检测请求，可能消耗额度；验证后可修复路径、补全缺失配置。", "Append-only: existing explicit configs are never overwritten; models without fetched config keep ZCode defaults. Confirmation sends provider test requests that may consume quota; verified paths and missing settings may be repaired.")) + "</div>" +
        '<div class="zu-mp-fix" role="status" aria-live="polite"></div>' +
        '<div class="zu-mp-warn" role="status" aria-live="polite"></div>' +
        '<div class="zu-mp-err" role="status" aria-live="polite"></div>' +
        '<div class="zu-mp-foot"><span class="zu-mp-count"></span>' +
        '<div class="zu-mp-actions"><button type="button" class="zu-mp-cancel">' + L("取消", "Cancel") + "</button>" +
        '<button type="button" class="zu-mp-ok">' + L("确认添加并保存", "Confirm and save") + ' (<span class="zu-mp-okn">0</span>)</button></div></div>');
      var items = ov.querySelector(".zu-mp-items");
      var countNode = ov.querySelector(".zu-mp-count");
      var okBtn = ov.querySelector(".zu-mp-ok");
      var errNode = ov.querySelector(".zu-mp-err");
      var fixNode = ov.querySelector(".zu-mp-fix");
      var warnNode = ov.querySelector(".zu-mp-warn");
      var busy = false, tested = Object.create(null), forced = Object.create(null);
      function setBusy(value) {
        busy = value;
        var controls = [okBtn, ov.querySelector(".zu-mp-all"), ov.querySelector(".zu-mp-none"), ov.querySelector(".zu-mp-fresh")];
        var inputs = items.querySelectorAll("input");
        for (var i = 0; i < inputs.length; i++) inputs[i].disabled = value;
        for (var j = 0; j < controls.length; j++) controls[j].disabled = value;
        if (!value) refreshCounts();
      }
      function refreshCounts() {
        var n = 0;
        for (var k in sel) if (Object.prototype.hasOwnProperty.call(sel, k) && sel[k]) n++;
        countNode.textContent = L("已选中 " + n + " / " + models.length + " 个模型", n + " / " + models.length + " selected");
        ov.querySelector(".zu-mp-okn").textContent = String(n);
        okBtn.disabled = busy || n === 0;
      }
      items.addEventListener("change", function (e) {
        var id = e.target.getAttribute && e.target.getAttribute("data-mpid");
        if (id == null || !Object.prototype.hasOwnProperty.call(sel, id)) return;
        if (busy) { e.target.checked = !!sel[id]; return; }
        sel[id] = e.target.checked;
        forced[id] = !!sel[id] && tested[id] === "failed";
        refreshCounts();
      });
      ov.querySelector(".zu-mp-search").addEventListener("input", function (e) {
        var kw = e.target.value.toLowerCase().trim();
        var nodes = items.querySelectorAll(".zu-mp-item");
        for (var j = 0; j < nodes.length; j++) {
          nodes[j].hidden = nodes[j].getAttribute("data-mpid").toLowerCase().indexOf(kw) < 0;
        }
      });
      function setAll(value, onlyNew) {
        if (busy) return;
        var nodes = items.querySelectorAll(".zu-mp-item");
        for (var j = 0; j < nodes.length; j++) {
          var id = nodes[j].getAttribute("data-mpid");
          var v = onlyNew ? !existing[id] : value;
          sel[id] = v;
          if (tested[id] === "failed") forced[id] = false;
          var cb = nodes[j].querySelector("input");
          if (cb) cb.checked = v;
        }
        refreshCounts();
      }
      ov.querySelector(".zu-mp-all").addEventListener("click", function () { setAll(true, false); });
      ov.querySelector(".zu-mp-none").addEventListener("click", function () { setAll(false, false); });
      ov.querySelector(".zu-mp-fresh").addEventListener("click", function () { setAll(false, true); });
      ov.querySelector(".zu-mp-cancel").addEventListener("click", cleanupMpModal);
      refreshCounts();
      /* 行内探测状态 chip（v309）：惰性插入到徽标前；原因走 data-tip 伪元素气泡（v310：
       * 宿主内原生 title 气泡不弹——v307 同款实证，速度卡模型行先例），从 chip 左侧水平
       * 弹出、行内垂直居中，避开 .zu-mp-items 的 overflow:auto 裁剪。 */
      function mpRowOf(mid) {
        var nodes = items.querySelectorAll(".zu-mp-item");
        for (var j = 0; j < nodes.length; j++) {
          if (nodes[j].getAttribute("data-mpid") === mid) return nodes[j];
        }
        return null;
      }
      function mpSetRowTest(mid, cls, text, tip) {
        var row = mpRowOf(mid);
        if (!row) return;
        var node = row.querySelector(".zu-mp-tst");
        if (!node) {
          node = document.createElement("span");
          var badge = row.querySelector(".zu-mp-badge");
          if (badge) row.insertBefore(node, badge); else row.appendChild(node);
        }
        node.className = "zu-mp-tst " + cls;
        node.textContent = text;
        if (tip) { node.setAttribute("data-tip", tip); node.setAttribute("aria-label", text + " " + tip); }
        else { node.removeAttribute("data-tip"); node.removeAttribute("aria-label"); }
      }
      function mpClearRowTests() {
        var nodes = items.querySelectorAll(".zu-mp-tst");
        for (var j = 0; j < nodes.length; j++) nodes[j].remove();
      }
      function mpApply(picked) {
        setBusy(true);
        okBtn.firstChild.nodeValue = L("正在保存…", "Saving…") + " (";
        mpAsk("model-pull-apply", { providerId: provider.id, models: picked }, function (result) {
          if (inactive() || mpModal !== ov) return;
          if (result && result.ok) {
            cleanupMpModal();   // 写回完成：宿主模型列表数秒内自动刷新
            return;
          }
          setBusy(false);
          okBtn.firstChild.nodeValue = L("确认添加并保存", "Confirm and save") + " (";
          errNode.textContent = mpErrorText(result);
        });
      }
      /* 先探测后保存（v309）：worker 池逐模型 model-pull-probe（主进程镜像宿主 URL 语义），
       * 行内 chip 即时刷新；全过自动写入，有失败自动取消勾选并保留弹窗。旧主进程回
       * unknown action 时降级为直接保存（与旧版行为一致）。
       * v310：主进程对路径错配（404/405）自动修复 Base URL（±/v1 实测命中即写回配置），
       * 探测结果带 repaired 标记——汇总区绿字披露写回结果，不再让用户手改配置。
       * v311：辅助档位被严格上游拒绝时（reasoning_effort "none" 类 400）自动写实合法档位
       * 表（values[0] 是宿主测试/辅助调用的最低档），effortFixed 标记同区披露。 */
      function mpProbeThenApply(picked, checking) {
        setBusy(true);
        var done = 0, active = 0, cursor = 0, closed = false;
        var failed = [];
        var repairs = [];   // 去重后的修复/匹配披露列表
        var repairSeen = Object.create(null);
        var capSeen = Object.create(null);   // v312 能力实测写入的项（image/jsonSchema/midConv）
        var toolHistoryWarned = false;   // v313 通道不支持工具调用历史（代理任务工具轮会失败，纯对话可用）
        var specSeen = Object.create(null);   // v314 规格补全（contextWindow/maxOutputTokens）
        function label() {
          okBtn.firstChild.nodeValue = L("正在检测 " + done + "/" + checking.length + "…", "Testing " + done + "/" + checking.length + "…") + " (";
        }
        function settle() {
          if (closed) return;
          closed = true;
          if (Object.keys(capSeen).length) {
            repairs.push(L("能力匹配：", "capability match: ") + Object.keys(capSeen).map(function (k) {
              return k === "image" ? L("图片", "image") : k === "jsonSchema" ? L("结构化输出", "structured output") : L("中段系统消息", "mid-conversation system");
            }).join("/"));
          }
          if (Object.keys(specSeen).length) {
            repairs.push(L("规格补全：", "spec backfilled: ") + Object.keys(specSeen).map(function (k) {
              return k === "contextWindow" ? L("上下文窗口", "context window") : L("输出上限", "output limit");
            }).join("/"));
          }
          warnNode.textContent = toolHistoryWarned
            ? L("警告：该模型通道拒绝了测试用工具调用历史，代理任务的工具轮次可能失败；请确认通道兼容性后再使用。", "Warning: this model channel rejected the test tool-call history; agent tool turns may fail. Check the channel compatibility before use.")
            : "";
          if (repairs.length) {
            fixNode.textContent = L("已自动匹配配置（已有模型已写入，新模型保存时写入）：", "Auto-matched settings (existing models saved; new models saved on confirmation): ") + repairs.join(L("；", "; "));
          }
          if (!failed.length && !repairs.length && !toolHistoryWarned) { mpApply(picked); return; }
          for (var j = 0; j < failed.length; j++) {
            sel[failed[j]] = false;
            var row = mpRowOf(failed[j]);
            if (row) { var cb = row.querySelector("input"); if (cb) cb.checked = false; }
          }
          setBusy(false);
          okBtn.firstChild.nodeValue = L("确认添加并保存", "Confirm and save") + " (";
          if (!failed.length) {
            errNode.textContent = L("检测完成，请查看以上说明后再次确认保存。", "Testing complete. Review the details above, then confirm again to save.");
            return;
          }
          errNode.textContent = L("自动检测：", "Auto test: ") + (checking.length - failed.length) +
            L(" 个可用，", " ok, ") + failed.length +
            L(" 个失败（已取消勾选；悬停「失败」看原因，重新勾选可强制添加）。", " failed (unchecked; hover the failed badge for the reason, re-check to force-add).");
        }
        function finishOne(mid, result) {
          done++;
          var sec = result && typeof result.latencyMs === "number" ? (Math.round(result.latencyMs / 100) / 10) + "s" : "";
          if (result) {
            if (result.repaired && result.repaired.from && result.repaired.to) {
              var key = result.repaired.from + ">" + result.repaired.to;
              if (!repairSeen[key]) { repairSeen[key] = 1; repairs.push("Base URL " + result.repaired.from + " → " + result.repaired.to); }
            }
            if (result.effortFixed && Array.isArray(result.effortFixed.values) && result.effortFixed.values.length) {
              var ek = provider.id + ">" + mid + ">effort";
              if (!repairSeen[ek]) { repairSeen[ek] = 1; repairs.push(L("思考档位 → ", "reasoning levels → ") + result.effortFixed.values.join("/")); }
            }
            if (Array.isArray(result.capabilitiesFixed)) {
              for (var ck = 0; ck < result.capabilitiesFixed.length; ck++) capSeen[result.capabilitiesFixed[ck]] = 1;
            }
            if (result.warnings && result.warnings.indexOf("toolHistory") >= 0) toolHistoryWarned = true;
            if (Array.isArray(result.specEnriched)) {
              for (var sk = 0; sk < result.specEnriched.length; sk++) specSeen[result.specEnriched[sk]] = 1;
            }
          }
          if (result && result.ok) {
            tested[mid] = "ok";
            mpSetRowTest(mid, "zu-mp-tst-ok", L("可用" + (sec ? " " + sec : ""), "ok" + (sec ? " " + sec : "")), result.url || "");
          } else {
            tested[mid] = "failed";
            failed.push(mid);
            mpSetRowTest(mid, "zu-mp-tst-fail", L("失败", "failed"), mpProbeFailText(result));
          }
          label();
          pump();
          if (done >= checking.length) settle();
        }
        function pump() {
          while (!closed && active < MP_TEST_CONC && cursor < checking.length) {
            var mid = checking[cursor++];
            active++;
            (function (m) {
              mpAsk("model-pull-probe", { providerId: provider.id, model: m, caps: true }, function (result) {
                active--;
                if (closed) return;
                if (inactive() || mpModal !== ov) { closed = true; return; }   // 弹窗已关：不再起下一轮
                if (result && typeof result.error === "string" && result.error.indexOf("unknown action") === 0) {
                  closed = true;   // 旧主进程不识别探测：降级直接保存
                  mpClearRowTests();
                  errNode.textContent = L("主进程较旧，已跳过自动检测。", "Main process outdated; the auto test was skipped.");
                  mpApply(picked);
                  return;
                }
                finishOne(m, result);
              }, 90000);   // v312：探测 + 修复 + 重试 + 能力实测（3×6s）最坏约 70s，兜底放宽到 90s
            })(mid);
          }
        }
        for (var i = 0; i < checking.length; i++) mpSetRowTest(checking[i], "zu-mp-tst-run", L("检测中", "testing"), "");
        label();
        pump();
      }
      okBtn.addEventListener("click", function () {
        if (busy) return;
        var picked = [];
        for (var j = 0; j < models.length; j++) if (sel[models[j]]) picked.push(models[j]);
        if (!picked.length) return;
        errNode.textContent = "";
        if (picked.length > MP_TEST_MAX) { mpApply(picked); return; }   // 数量过多不阻塞：直接保存
        var checking = picked.filter(function (m) { return tested[m] !== "ok" && !forced[m]; });
        if (!checking.length) { mpApply(picked); return; }
        mpProbeThenApply(picked, checking);
      });
    }
    function cleanupMpModal() {
      if (!mpModal) return;
      var pending = mpWaiters.slice();
      for (var i = 0; i < pending.length; i++) pending[i]();
      if (mpModal.__zuMpEsc) document.removeEventListener("keydown", mpModal.__zuMpEsc, true);   // 捕获相注册必须同 flag 摘除
      mpModal.remove();
      mpModal = null;
      mpModalDispose = null;
      mpModalThemeSync = null;
    }
    /* 供应商归属（v132 读宿主源码定案，主判定=当前选择的供应商）：左侧导航项
     * testid=model-provider-nav-item-<nodeKey>，custom 供应商 nodeKey=custom:<providerId>
     * （utils.tsx createCustomProviderNodeKey），选中项 data-state="selected"（Navigation.tsx）
     * ——取选中 custom 项的 providerId 与主进程列表精确匹配，编辑草稿未保存也不影响归属。
     * 兜底链：Base URL 匹配（专用 testid model-provider-base-url-input 优先，表单启发式探测
     * 次之）→ 单供应商直用 → 多供应商弹选择。preset/套餐导航项（非 custom: 前缀）不误归属。 */
    function detectSelectedCustomProviderId(anchor) {
      try {
        var nodes = document.querySelectorAll('[data-testid^="model-provider-nav-item-"][data-state="selected"]');
        for (var i = 0; i < nodes.length; i++) {
          var nodeKey = (nodes[i].getAttribute("data-testid") || "").replace(/^model-provider-nav-item-/, "");
          try { window.__zusageDiag.mpSel = nodeKey.slice(0, 140); } catch (e) { }   // 诊断：真实选中 nodeKey 形态
          var m = /^custom:(.+)$/.exec(nodeKey);
          if (m) return m[1];
          /* v134 内置套餐源：BigModel 付费套餐详情页可拉取（OAuth token 对 anthropic
           * models 端点有效，实测 200）。实机诊断：BigModel 导航项与 Start Plan 导航项
           * 共用 nodeKey=preset:account:bigmodel-start-plan——按详情内容区分：页内含
           * 付费卡（GLM Coding Max）才归属付费套餐；纯 Start Plan 免费卡页（模型由
           * 服务端随卡指定、无 models 端点实测 404）不放行不显示按钮 */
          if (/account:bigmodel-individual-coding-plan$/.test(nodeKey)) return nodeKey.slice(nodeKey.indexOf(":") + 1);
          if (/account:bigmodel-start-plan$/.test(nodeKey)) {
            var container = anchor, depth = 0, hasPaidCard = false;
            for (; container && container !== document.body && depth < 8; depth++) {
              container = container.parentElement;
              if (container && container.querySelector && container.querySelector('[data-testid="model-provider-enabled-switch"]')) break;
            }
            try {
              hasPaidCard = !!(container && container.textContent && container.textContent.indexOf("GLM Coding Max") >= 0);
            } catch (e) { }
            return hasPaidCard ? "account:bigmodel-individual-coding-plan" : "";
          }
        }
      } catch (e) { }
      return "";
    }
    function matchProviderById(providers, providerId) {
      var want = String(providerId || "");
      if (!want) return null;
      for (var i = 0; i < providers.length; i++) {
        if (String(providers[i].id) === want) return providers[i];
      }
      return null;
    }
    function matchProviderByBaseUrl(providers, baseUrl) {
      var want = String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
      if (!want) return null;
      var hits = [];
      for (var i = 0; i < providers.length; i++) {
        var b = String(providers[i].baseUrl || "").replace(/\/+$/, "").toLowerCase();
        if (b === want) hits.push(providers[i]);
      }
      return hits.length === 1 ? hits[0] : null;
    }
    function detectMpProviderBaseUrl(anchor) {
      try {
        var el = document.querySelector('[data-testid="model-provider-base-url-input"]');
        if (el) {
          var v = String(el.value || "").trim();
          if (/^https?:\/\//i.test(v)) return v;
        }
      } catch (e) { }
      var node = anchor;
      for (var i = 0; i < 8 && node && node !== document.body; i++) {
        node = node.parentElement;
        if (!node || !node.querySelectorAll) continue;
        var inputs = node.querySelectorAll("input:not([type=password]):not([type=checkbox]):not([type=radio])");
        if (inputs.length >= 2) {   // 表单容器（Base URL + 其它字段同框）
          for (var j = 0; j < inputs.length; j++) {
            var v = String(inputs[j].value || "").trim();
            if (/^https?:\/\//i.test(v)) return v;
          }
        }
      }
      return "";
    }
    function startMpHostFetch(provider, hostBtn) {
      mpAsk("model-pull-fetch", { providerId: provider.id }, function (result) {
        if (inactive()) return;
        if (hostBtn) setMpHostBusy(hostBtn, false);   // 弹窗出现/失败即解除（不再有异步步骤）
        if (!result || !result.ok) { openMpNotice(mpErrorText(result)); return; }
        openMpModal(provider, result.models || [], result.metaById || {}, result.effortsFetching);
      });
    }
    function openMpNotice(text) {
      openMpShell(L("模型拉取", "Model puller"), '<div class="zu-mp-note">' + mEsc(text) + "</div>");
    }
    function openMpProviders(providers) {
      var rows = "";
      for (var i = 0; i < providers.length; i++) {
        rows += '<button type="button" class="zu-mp-row zu-mp-pick" data-mp="' + mEsc(providers[i].id) + '">' +
          '<span class="zu-mp-name">' + mEsc(providers[i].name || providers[i].id) + "</span>" +
          '<span class="zu-mp-url">' + mEsc(providers[i].baseUrl) + "</span>" +
          '<span class="zu-mp-count">' + L("已有 " + providers[i].modelIds.length + " 个模型", providers[i].modelIds.length + " model(s) configured") + "</span></button>";
      }
      var ov = openMpShell(L("选择供应商", "Choose a provider"), '<div class="zu-mp-list">' + rows + "</div>");
      ov.addEventListener("click", function (e) {
        var pick = e.target.closest && e.target.closest(".zu-mp-pick");
        if (!pick) return;
        var id = pick.getAttribute("data-mp");
        for (var i = 0; i < providers.length; i++) {
          if (providers[i].id === id) { cleanupMpModal(); startMpHostFetch(providers[i]); return; }
        }
      });
    }
    function setMpHostBusy(btn, busy) {
      if (busy) {
        btn.setAttribute("aria-busy", "true");
        if (btn.lastChild && btn.lastChild.nodeType === 3) {
          btn.__zuMpLabel = btn.lastChild.nodeValue;
          btn.lastChild.nodeValue = L("拉取中…", "Pulling…");
        }
      } else {
        btn.removeAttribute("aria-busy");
        if (btn.__zuMpLabel && btn.lastChild && btn.lastChild.nodeType === 3) btn.lastChild.nodeValue = btn.__zuMpLabel;
      }
    }
    /* 从列表里选出要拉取的供应商。选中的是套餐源（account:*）而列表里没有它时返回 pending：
     * 套餐 token 靠系统钥匙串里的密钥解密、密钥异步到位，列表可能暂时不含它——这时绝不能
     * 落到「只有一个供应商就用它」的兜底上，那会把请求改投到别的供应商。 */
    function pickMpProvider(providers, selectedId, baseUrl) {
      var byId = matchProviderById(providers, selectedId);
      if (byId) return { provider: byId };
      if (/^account:/.test(selectedId || "")) return { pending: true };
      return { provider: matchProviderByBaseUrl(providers, baseUrl) || (providers.length === 1 ? providers[0] : null) };
    }
    function onMpHostClick(e) {
      e.preventDefault();
      e.stopPropagation();
      if (inactive()) { restoreModelPuller(); return; }   // 热更后旧实例闭包不得再开弹窗
      var self = e.currentTarget;
      if (self.getAttribute("aria-busy") === "true") return;
      setMpHostBusy(self, true);   // loading 覆盖全程：list 是本地读取（毫秒级），真正的网络耗时在 fetch 阶段
      askMpList(self, false, detectSelectedCustomProviderId(self));   // 点击时同步采样选中项
    }
    function askMpList(self, retried, wanted) {
      mpAsk("model-pull-list", undefined, function (result) {
        if (inactive()) { restoreModelPuller(); return; }
        var providers = result && result.ok && Array.isArray(result.providers) ? result.providers : null;
        if (!providers) { setMpHostBusy(self, false); openMpNotice(mpErrorText(result)); return; }
        /* 判定用点击时刻的选中项：400ms 等待期间宿主可能重渲染详情区/切换导航，重读 DOM 会把
         * 选中态读丢，从而落回「只有一个供应商就用它」——那会把拉取改投到别的供应商。 */
        var selectedId = wanted || detectSelectedCustomProviderId(self);
        var pick = pickMpProvider(providers, selectedId, detectMpProviderBaseUrl(self));
        if (pick.pending) {
          if (!retried) {   // 首次列表会触发取钥：稍等重问一次
            setTimeout(function () { if (inactive()) { restoreModelPuller(); return; } askMpList(self, true, selectedId); }, 400);
            return;
          }
          setMpHostBusy(self, false);
          openMpNotice(L("当前套餐的登录凭据暂时不可用，请稍后重试。", "The sign-in credential for this plan is not available right now. Try again shortly."));
          return;
        }
        if (!providers.length) {
          setMpHostBusy(self, false);
          openMpNotice(L("未找到 API Key 型自定义供应商：先在「模型设置 → 自定义供应商」里添加一个（填写 Base URL 与 API Key）再来。", "No API-key custom provider found: add one under Model settings first (base URL + API key), then pull."));
          return;
        }
        if (pick.provider) startMpHostFetch(pick.provider, self);   // busy 延续到 fetch 回调（弹窗出现/失败才解除）
        else { setMpHostBusy(self, false); openMpProviders(providers); }
      });
    }
    /* 宿主设置页挂载（额度 chip 同款契约）：锚按钮左侧前插、幂等复用、位置兜回；
     * 设置页关即锚失 → restore 摘除。按钮视觉复刻原生 secondary 视格（同页 Tailwind
     * utility），⚡ 图标 stroke currentColor 与文字同色。 */
    function enhanceModelPuller() {
      if (inactive()) { restoreModelPuller(); return; }
      /* 锚 testid 全局唯一：内置/套餐页（BigModel/Start Plan）的「添加模型」同款 testid，
       * 但那些供应商的模型由宿主管——只有选中的是 custom 供应商时才挂按钮 */
      var btn = null;
      try { btn = document.querySelector(MP_HOST_ANCHOR); } catch (e) { }
      if (!detectSelectedCustomProviderId(btn)) { restoreModelPuller(); return; }
      try { window.__zusageDiag.mpAnchor = btn ? "1" : "0"; } catch (e) { }   // 诊断：锚按钮存在性
      if (!btn || !btn.parentElement) { restoreModelPuller(); return; }
      var wrap = btn.parentElement;
      var mine = mpHostBtn;
      if (!mine || !mine.isConnected || mine.parentElement !== wrap) {
        if (mine && mine.isConnected) mine.remove();
        mine = null;
        for (var i = 0; i < wrap.children.length; i++) {
          if (wrap.children[i].classList && wrap.children[i].classList.contains("zu-mp-host")) { mine = wrap.children[i]; break; }
        }
        if (!mine) {
          mine = document.createElement("button");
          mine.type = "button";
          mine.className = "zu-mp-host group/host inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors outline-none select-none gap-1 px-2 h-7 text-ui-base rounded-lg bg-secondary text-foreground hover:bg-secondary/80 border border-transparent disabled:pointer-events-none disabled:opacity-50 ml-auto";   /* ml-auto：锚容器是 justify-between，三子项会被均匀分布——吃掉剩余空间贴紧「添加模型」左侧 */
          mine.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:0 0 auto"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg>' + L("拉取模型", "Pull models");
          mine.addEventListener("click", onMpHostClick);
        }
        mpHostBtn = mine;
      }
      if (mine.nextElementSibling !== btn) wrap.insertBefore(mine, btn);   // 位置兜回：始终紧贴「添加模型」左侧
    }
    function restoreModelPuller() {
      if (mpHostBtn && mpHostBtn.isConnected) mpHostBtn.remove();
      mpHostBtn = null;
    }
    /* 源列表按推送状态增量重建（JSON 签名没变不重绘，避免打断正在输入的凭据框） */
    function syncQuotaSources() {
      var box = panel.querySelector(".zu-src-list");
      if (!box) return;
      var list = state.quotaSources || [];
      var sig = JSON.stringify([list, sourceFeedback]);
      if (sig === srcListSig && box.children && box.children.length) return;
      /* 正在输入凭据的源行不重建：状态推送（如别家查询完成）会翻转签名，重建会丢焦点丢内容 */
      try {
        var act = document.activeElement;
        if (act && act.classList && act.classList.contains("zu-src-field") && box.contains && box.contains(act)) return;
      } catch (e) { }
      srcListSig = sig;
      /* 源 id/label 可含用户自定义 provider 名（custom:<providerId> 等），经 innerHTML 拼接前
       * 统一转义；属性值经 HTML 解码读回，转义对 data-src 寻址透明。 */
      var aEsc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
      var html = "";
      for (var i2 = 0; i2 < list.length; i2++) {
        var sv = list[i2];
        var credFields = "";
        for (var f = 0; f < (sv.credentialFields || []).length; f++) {
          var field = sv.credentialFields[f];
          var isCred = field === "apiKey" || field === "cookie" || field === "token" || field === "secretAccessKey";
          credFields += '<input type="' + (isCred ? "password" : "text") + '" class="zu-src-field" data-src="' + aEsc(sv.id) +
            '" data-field="' + aEsc(field) + '" placeholder="' + aEsc((SRC_FIELD_LABELS || {})[field] || field) +
            (isCred && sv.keyConfigured ? L("（已配置，输入以更换）", " (configured)") : "") + '" autocomplete="off">';
        }
        var pr = sv.presets || [], chips = "", curBase = String(sv.baseUrl || "").replace(/\/+$/, "");
        for (var p2 = 0; p2 < pr.length; p2++) {
          chips += '<button type="button" class="zu-src-preset' + (curBase && curBase === String(pr[p2].value || "").replace(/\/+$/, "") ? " on" : "") +
            '" data-src="' + aEsc(sv.id) + '" data-base="' + aEsc(pr[p2].value) + '" title="' + aEsc(pr[p2].value) + '">' + L(pr[p2].label, pr[p2].labelEn || pr[p2].label) + '</button>';
        }
        html += '<div class="zu-src-row" data-src="' + aEsc(sv.id) + '">' +
          '<label class="zu-src-name"><input type="checkbox" class="zu-src-enable" data-src="' + aEsc(sv.id) + '"' + (sv.enabled ? " checked" : "") + '>' +
          '<span>' + aEsc(sv.label) + (sv.unverified ? "*" : "") + '</span></label>' +
          '<span class="zu-src-status" role="status" aria-live="polite">' + srcStatusText(sv) + '</span>' +
          (sv.keyUrl ? '<button type="button" class="zu-src-keyurl" data-url="' + aEsc(sv.keyUrl) + '" aria-label="' + L("打开控制台获取 API Key", "Open the console to get an API key") + '" title="' + L("打开控制台获取 API Key", "Open the console to get an API key") + '">' + L("获取 Key ↗", "Get key ↗") + '</button>' : "") +
          /* issue #399：千问套餐凭据是平台登录态而非 API Key，走官方设备码授权（面板起流 →
           * 浏览器确认 → 主进程持久化）；旧主进程不识别该动作时按 unknown action 降级提示。 */
          (sv.id === "qianwen" ? '<button type="button" class="zu-src-signin" data-src="qianwen" aria-label="' + L("登录千问平台授权额度查询", "Sign in to the Qianwen platform for quota access") + '" title="' + L("打开浏览器完成官方设备码授权后查询套餐额度", "Opens the browser for the official device-code sign-in") + '">' + L("登录 ↗", "Sign in ↗") + '</button>' : "") +
          '<button type="button" class="zu-src-refresh" data-src="' + aEsc(sv.id) + '" aria-label="' + L("立即刷新", "Refresh now") + '" title="' + L("跳过缓存，立即重新查询该源", "Re-query this source now, skipping the cache") + '"' + (sv.enabled && !sv.busy ? "" : " disabled") + ' aria-busy="' + (!!sv.busy) + '">↻</button>' +
          (chips ? '<span class="zu-src-presets">' + chips + '</span>' : "") +
          '<span class="zu-src-fields">' + credFields + '</span>' +
          '<span class="zu-src-feedback' + (sourceFeedback[sv.id] && sourceFeedback[sv.id].error ? ' zu-feedback-error' : '') + '" role="status" aria-live="polite">' +
          /* text 可能含服务端响应串（千问 account/status）：重建行走 innerHTML 必须转义（即时反馈走 textContent 无此问题） */
          (sourceFeedback[sv.id] ? aEsc(sourceFeedback[sv.id].text) || (sourceFeedback[sv.id].pending ? (state.pluginUpdate && state.pluginUpdate.feedbackVersion >= 1 ? L("操作已发出，等待确认…", "Sent; awaiting confirmation…") : L("操作已发出；保存确认需重启后端", "Sent; restart the backend for save confirmation")) : sourceFeedback[sv.id].error ? L("操作失败，请重试", "Action failed; try again") : L("已保存", "Saved")) : "") + '</span></div>';
      }
      box.innerHTML = html;
    }
    /* ---------- issue #399 千问设备码登录（面板侧）：start → openExternal 授权页 →
     * 每 2s 轮询 state 直至 done/failed。轮询不绑定按钮节点：源列表按签名整表重建（点击
     * 写入的「等待浏览器授权…」反馈本身就会翻转签名，面板重开/切语言也重建），旧节点一
     * 断连，旧实现的轮询就静默停摆、起流回执也不再开授权页，反馈卡在「等待」。存活只看
     * waiting + 代际 gen（新一轮点击、实例销毁都让旧回调自弃）；面板关着也照常轮询，
     * done/failed 的反馈写进 sourceFeedback，重开面板随行重建显示。 ---------- */
    var qianwenSignin = { timer: 0, waiting: false, gen: 0 };
    function stopQianwenPoll() {
      qianwenSignin.gen += 1;
      if (qianwenSignin.timer) { clearTimeout(qianwenSignin.timer); qianwenSignin.timer = 0; }
      qianwenSignin.waiting = false;
    }
    function pollQianwenState(gen) {
      qianwenSignin.timer = setTimeout(function () {
        qianwenSignin.timer = 0;
        if (gen !== qianwenSignin.gen || !qianwenSignin.waiting) return;
        pluginRequest("quota-qianwen-signin-state", {}, function (res) {
          if (gen !== qianwenSignin.gen || !qianwenSignin.waiting) return;
          if (!res || res.ok !== true) { stopQianwenPoll(); showSourceFeedback("qianwen", true, false, L("登录状态查询不可用", "Sign-in status unavailable")); return; }
          if (res.state === "pending") { pollQianwenState(gen); return; }
          stopQianwenPoll();
          if (res.state === "done") showSourceFeedback("qianwen", false, false, res.account ? L("已登录 ", "Signed in: ") + res.account : L("已登录", "Signed in"));
          else if (res.state === "failed") showSourceFeedback("qianwen", true, false, res.error || L("登录失败", "Sign-in failed"));
          /* idle：流已不在（关额度开关会取消在途登录；主进程重启后同样如此）——给中性终态，
           * 否则行上一直停在「等待浏览器授权…」 */
          else showSourceFeedback("qianwen", false, false, L("登录已取消", "Sign-in cancelled"));
        });
      }, 2000);
    }
    function onQianwenSigninClick() {
      stopQianwenPoll();
      showSourceFeedback("qianwen", false, true, L("等待浏览器授权…", "Waiting for approval in the browser…"));
      var gen = qianwenSignin.gen;
      pluginRequest("quota-qianwen-signin", {}, function (res) {
        if (gen !== qianwenSignin.gen) return;   // 回执迟到：期间又点了一次或实例已销毁，旧流作废
        if (res && res.ok && res.url) {
          var zu = window.zcode;   // 客户端 openExternal 桥优先（系统默认浏览器），window.open 被内置浏览器接管仅兜底
          if (zu && typeof zu.openExternal === "function") zu.openExternal(res.url);
          else window.open(res.url, "_blank", "noopener");
          qianwenSignin.waiting = true;
          pollQianwenState(gen);
        } else {
          /* 主进程回执是英文固定串：已知串映射本地化，未知串脱敏兜底（错误正文可能来自桥层） */
          var msg = String((res && res.error) || "");
          if (/unknown action|restart required/i.test(msg)) msg = L("需完全重启 ZCode 后可用", "Restart ZCode to enable");
          else if (/quota disabled/i.test(msg)) msg = L("额度查询已关闭", "Quota queries are off");
          else if (/sign-in unavailable|unavailable/i.test(msg)) msg = L("登录功能暂不可用，请重试", "Sign-in unavailable; try again");
          else if (msg) msg = L("登录不可用", "Sign-in unavailable");   // 未知回执不原样上屏
          else msg = L("登录不可用", "Sign-in unavailable");
          showSourceFeedback("qianwen", true, false, msg);
        }
      });
    }
    /* 更新进度条（v89）。主进程 updater 在 downloading/updating 阶段推送
     * progress = { stage: download|verify|install|sync, loaded?, total? }：
     * 下载条在 download 阶段按字节比例，之后一律 100%；安装条没有字节口径（宿主插件管理器
     * 不报进度），按校验→安装→同步三段推进并用扫光表示仍在活动。旧版主进程不带 progress
     * 字段（热更新的渲染端先于主进程重启生效），此时整块隐藏，只保留原有状态文案。 */
    function formatBytes(n) {
      n = Math.max(0, +n || 0);
      if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
      if (n >= 1024) return Math.round(n / 1024) + " KB";
      return n + " B";
    }
    function setProgressBar(box, key, ratio, active, label) {
      var row = box.querySelector('[data-progress="' + key + '"]');
      if (!row) return;
      var pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
      var fill = row.querySelector(".zu-progress-fill");
      fill.style.width = pct + "%";
      fill.classList.toggle("active", !!active);
      row.querySelector(".zu-progress-track").setAttribute("aria-valuenow", String(pct));
      row.querySelector(".zu-progress-track").setAttribute("aria-label", key === "download" ? L("下载进度", "Download progress") : L("安装阶段", "Installation stage"));
      row.querySelector(".zu-progress-value").textContent = label;
    }
    function syncProgress(u) {
      var box = panel.querySelector(".zu-update-progress");
      if (!box) return;
      var p = u && u.progress;
      var show = !!(p && typeof p.stage === "string" && (u.phase === "downloading" || u.phase === "updating"));
      box.hidden = !show;
      if (!show) return;
      var idx = PROGRESS_STAGES.indexOf(p.stage);
      var total = +p.total > 0 ? +p.total : 0, loaded = Math.max(0, +p.loaded || 0);
      var dlRatio = idx > 0 ? 1 : (total ? loaded / total : 0);
      var dlLabel = idx > 0 ? "100%"
        : total ? Math.round(Math.min(1, loaded / total) * 100) + "% · " + formatBytes(loaded) + " / " + formatBytes(total)
        : formatBytes(loaded);
      setProgressBar(box, "download", dlRatio, idx <= 0, dlLabel);
      var install = {
        verify: [.15, L("校验中", "Verifying")],
        install: [.55, L("安装中", "Installing")],
        sync: [.9, L("同步中", "Syncing")],
      }[p.stage] || [0, L("等待下载完成", "Waiting for download")];
      setProgressBar(box, "install", install[0], idx > 0, install[1]);
    }
    var epTest = { id: "", timer: 0, draft: "", result: "", status: "", failed: false, generation: 0, testedDraft: "", signature: "" };
    function epTestSignature() {
      var ep = state.pluginUpdate && state.pluginUpdate.enhanceProvider;
      var scope = typeof enhanceCurrentScope === "function" ? enhanceCurrentScope() : "";
      if (typeof readQuotaSelection === "function") readQuotaSelection();
      var selection = typeof quotaSelection !== "undefined" ? quotaSelection : null;
      return JSON.stringify([ep && ep.revision, ep && ep.mode, scope, selection && selection.providerId, selection && selection.modelId]);
    }
    function epTestRender() {
      var draft = panel.querySelector(".zu-ep-test-draft"), result = panel.querySelector(".zu-ep-test-result");
      if (!draft || !result || !epTest) return;
      draft.value = epTest.draft; result.textContent = epTest.result;
      panel.querySelector(".zu-ep-test-empty").hidden = !!epTest.result;
      var status = panel.querySelector(".zu-ep-test-status");
      status.textContent = epTest.status;
      status.classList.toggle("zu-ep-test-err", !!epTest.failed);
      syncEnhanceControls();
      panel.querySelector(".zu-ep-test-cancel").hidden = !epTest.id;
    }
    function epTestStop(message, failed) {
      if (!epTest) return;
      var id = epTest.id; epTest.id = ""; epTest.generation++; if (message) epTest.failed = !!failed;
      if (epTest.timer) { clearTimeout(epTest.timer); epTest.timer = 0; }
      if (id) { epTest.result = ""; epTest.testedDraft = ""; }
      if (id) { forgetPluginRequest(id); pluginRequest("prompt-enhance-cancel", { requestId: id }); }
      if (message) epTest.status = message;
      epTestRender();
    }
    function epTestStart() {
      var ep = state.pluginUpdate && state.pluginUpdate.enhanceProvider, draft = epTest.draft;
      if (!canStartEnhanceTest() || epTest.id) return;
      if (!draft.trim() || draft.length > 20000) { epTest.status = L("请输入 1–20000 字符的草稿。", "Enter a draft of 1–20000 characters."); epTestRender(); return; }
      if (!ep || ep.capability !== 1 || ep.unreadable || epSaving || epConflict || !Number.isSafeInteger(epSavedRevision)) { epTest.status = L("增强配置暂不可用，请稍后重试。", "Enhancement settings are temporarily unavailable; retry."); epTestRender(); return; }
      var editingMode = epValue(".zu-ep-mode"), useDraftForm = editingMode === "custom";
      var form = null, key = epValue(".zu-ep-key").trim();
      if (useDraftForm) {
        form = epForm();
        if (!form.providerId && form.source === "host") { epTest.status = L("请先点击选择一个供应商，再测试。", "Select a provider card before testing."); epTestRender(); return; }
        if (!form.model) { epTest.status = L("请先填写增强模型。", "Enter the enhancement model first."); epTestRender(); return; }
        if (form.source === "manual" && !form.baseUrl) { epTest.status = L("请先填写 Base URL。", "Enter the Base URL first."); epTestRender(); return; }
      }
      if (typeof readQuotaSelection === "function") readQuotaSelection();
      var sel = typeof quotaSelection !== "undefined" ? quotaSelection : null;
      var scope = typeof enhanceCurrentScope === "function" ? enhanceCurrentScope() : "";
      if (!useDraftForm) {
        if (ep.mode === "custom") { epTest.status = L("已保存配置为自定义模式；如需按当前会话模型测试，请先保存。", "Saved settings are custom; save first to test with the session model."); epTestRender(); return; }
        if (!scope || !sel || !sel.providerId || !sel.modelId) { epTest.status = L("无法确认当前会话模型，暂不能测试。", "Current session model cannot be verified."); epTestRender(); return; }
      }
      var signature = epTestSignature(), generation = ++epTest.generation, started = Date.now(), id = "";
      epTest.result = ""; epTest.testedDraft = "";
      epTest.status = L("正在增强…", "Enhancing…"); epTest.signature = signature;
      id = pluginRequest(useDraftForm ? "prompt-enhance-v2" : "prompt-enhance", useDraftForm ? { revision: ep.revision, text: draft, form: { source: form.source, providerId: form.providerId, baseUrl: form.baseUrl, protocol: form.protocol, model: form.model }, formApiKey: form.source === "manual" && key ? key : undefined } : { providerId: sel.providerId, modelId: sel.modelId, text: draft }, function (res) {
        if (!epTest || epTest.id !== id || epTest.generation !== generation || inactive()) return;
        var formChanged = useDraftForm && JSON.stringify(epForm()) !== JSON.stringify(form);
        if (signature !== epTestSignature() || formChanged || draft !== epTest.draft) { epTestStop(L("配置或草稿已变化，请重新测试。", "Settings or draft changed; test again.")); return; }
        epTest.id = ""; if (epTest.timer) clearTimeout(epTest.timer); epTest.timer = 0;
        if (res && res.ok && typeof res.text === "string" && res.text) {
          var providerLabel = "";
          if (useDraftForm) providerLabel = form.source === "host" ? (function () { var hf = panel.querySelector(".zu-ep-host"), o = hf && hf.options[hf.selectedIndex]; return o && o.textContent || form.providerId; })() : (form.baseUrl || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
          else providerLabel = sel.providerId;
          var sentModel = useDraftForm ? form.model : sel.modelId;
          var served = res.serverModel && typeof res.serverModel === "string" ? res.serverModel : sentModel;
          epTest.result = res.text; epTest.testedDraft = draft; epTest.failed = false;
          epTest.status = L("测试成功 · ", "Test succeeded · ") + providerLabel + " · " + sentModel + (served !== sentModel ? L("（服务端返回：", " (server: ") + served + "）" : "") + L(" · 耗时 ", " · ") + ((Date.now() - started) / 1000).toFixed(1) + "s";
          if (typeof enhanceHistoryAdd === "function") enhanceHistoryAdd({ requestId: id, source: "test", providerName: providerLabel, modelId: sentModel, originalText: draft, enhancedText: res.text, usage: res.usage || null, createdAt: new Date().toISOString(), durationMs: Date.now() - started });
        }
        else {
          var raw = res && typeof res.error === "string" ? res.error : "";
          var detail = res && res.detail ? String(res.detail).replace(/\s+/g, " ").trim().slice(0, 600) : "";
          var internal = {
            "enhance provider settings changed": L("已保存配置已变化，请重新打开设置后再试。", "Saved settings changed; reopen settings and try again."),
            "restart required": L("请完全重启 ZCode 后重试。", "Fully restart ZCode and retry."),
            "provider unavailable": L("供应商不可用，请重新选择并检查其配置。", "Provider unavailable; reselect it and check its settings."),
            "unsupported platform": L("当前平台暂不支持该操作。", "Not supported on this platform."),
            "cancelled": L("操作已取消。", "Cancelled."),
            "disabled": L("增强功能已关闭。", "Prompt enhancement is disabled."),
            "model downgraded": L("已按要求拒绝降级：服务端返回了不同的模型", "Fallback rejected as requested: the server served a different model"),
            /* issue #429：start-plan 无可用 v2 项目 key 的 fail-fast 短语本地化（balance 类
             * 失败 error 置空、detail 携带脱敏上游正文，走下方 detail 分支展示） */
            "plan conversation key unavailable": L("当前套餐暂不支持增强（无可用的对话凭据）。", "This plan has no usable conversation credential; enhancement is unavailable.")
          };
          epTest.failed = true;
          var teamText = res && res.kind === "team_auth" ? enhanceTeamAuthText(res) : "";   // v473：团队凭据换发失败带环节文案（issue #481）
          if (teamText) epTest.status = teamText + L("。", ".");
          else if (internal[raw]) epTest.status = internal[raw] + (detail ? "：" + detail : "");
          else if (detail || /^HTTP /.test(raw)) epTest.status = L("增强失败：", "Enhancement failed: ") + (detail || raw);
          else epTest.status = L("增强失败，请检查已保存的供应商、模型与网络。", "Enhancement failed; check the saved provider, model and network.");
        }
        epTestRender();
      });
      epTest.id = id;
      epTest.timer = setTimeout(function () { if (epTest && epTest.id === id) epTestStop(L("测试超时，请重试。", "Test timed out; retry."), true); }, 75000);
      epTestRender();
    }
    /* v473（issue #481）：团队套餐凭据换发失败的环节文案，工具栏增强与设置页测试区共用。主进程
     * 回执 kind "team_auth" + reason 环节码（固定枚举，只含环节与性质）+ 可选 HTTP status。只认
     * 表内 reason，表外码回空串：工具栏回落 error 短语、设置页测试区回落通用失败文案（主进程比渲染端
     * 新时不致空白）；文案=「团队凭据换发失败（…）」。 */
    function enhanceTeamAuthText(res) {
      var why = {
        token: L("登录凭据不可用", "login credential unavailable"),
        selection: L("宿主未切换到团队套餐", "host is not on the team plan"),
        customer_http: L("第 1 步校验团队失败", "step 1 (verify team) failed"),
        customer_mismatch: L("第 1 步未找到所选团队", "step 1: selected team not found"),
        customer_shape: L("第 1 步响应异常", "step 1: unexpected response"),
        keys_http: L("第 2 步读取团队密钥失败", "step 2 (list team keys) failed"),
        keys_missing: L("第 2 步未找到团队密钥", "step 2: team key not found"),
        keys_shape: L("第 2 步响应异常", "step 2: unexpected response"),
        pat_http: L("第 3 步签发团队令牌失败", "step 3 (issue team token) failed"),
        pat_shape: L("第 3 步响应异常", "step 3: unexpected response"),
        network: L("网络请求失败或超时", "network request failed or timed out"),
      };
      var code = res && typeof res.reason === "string" ? res.reason : "";
      if (!code || !Object.prototype.hasOwnProperty.call(why, code)) return "";
      var status = res && Number.isInteger(res.status) && res.status > 0 ? res.status : 0;
      return L("团队凭据换发失败", "Team credential exchange failed") + L("（", " (") + why[code]
        + (status ? L("，HTTP ", ", HTTP ") + status : "") + L("）", ")");
    }
    function epRisk(value) {
      try {
        var u = new URL(value), hn = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (hn.indexOf("::ffff:") === 0) hn = hn.slice(7);   // IPv4-mapped IPv6 还原为点分四段再判私网
        var h = hn, p = h.split(".").map(Number);
        return u.protocol === "http:" || h === "localhost" || /\.(localhost|local|internal)$/.test(h) || h.indexOf(".") < 0 || h === "::1" || /^(fc|fd|fe[89ab])/i.test(h) || (p.length === 4 && p.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; }) && (p[0] === 10 || p[0] === 127 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 169 && p[1] === 254));
      } catch (e) { return false; }
    }
    var epEditVersion = 0, epHostRequest = 0, epModelRequest = 0, epHostsLoaded = false, epSavedRevision = -1, epCleanVersion = 0, epSaving = false, epConflict = false, epSavedFormJson = null;
    function epDirty() { return epSavedFormJson !== null && JSON.stringify(epForm()) !== epSavedFormJson; }
    function epSyncDirtyStatus() {
      var status = panel.querySelector(".zu-ep-status");
      if (epDirty()) status.textContent = L("配置未保存", "Unsaved changes");
      else if (status.textContent === L("配置未保存", "Unsaved changes")) status.textContent = "";
    }
    function epApplySaved(ep) {
      var mode = panel.querySelector(".zu-ep-mode");
      if (!mode || !ep || ep.unreadable) return;
      mode.__zuInitialized = true; mode.value = ep.mode || "default";
      panel.querySelector(".zu-ep-source").value = ep.mode === "default" ? "default" : (ep.source || "manual");
      panel.querySelector(".zu-ep-url").value = ep.baseUrl || "";
      panel.querySelector(".zu-ep-protocol").value = ep.protocol || "openai-chat-completions";
      panel.querySelector(".zu-ep-model").value = ep.model || "";
      panel.querySelector(".zu-ep-key").value = "";
      var host = panel.querySelector(".zu-ep-host");
      host.value = ep.providerId || ""; host.__zuPendingId = ep.providerId || "";
      var allowBox = panel.querySelector(".zu-ep-allow-downgrade");
      if (allowBox) allowBox.checked = ep.allowDowngrade !== false;
      var saveBox = panel.querySelector(".zu-ep-save-history");
      if (saveBox) saveBox.checked = ep.saveHistory !== false;
      epSavedRevision = ep.revision; epCleanVersion = epEditVersion; epConflict = false;
      epSavedFormJson = JSON.stringify(epForm());
      epModelRequest++; panel.querySelector(".zu-ep-model-list").textContent = "";
      if (ep.mode === "custom" && ep.source === "host") epApplyModelCache(epForm());
      panel.querySelector(".zu-ep-reload").hidden = true;
      panel.querySelector(".zu-ep-status").textContent = "";
      epRender();
      if (ep.mode === "custom" && ep.source === "host") epLoadHosts(false);   // 打开/重载优先用缓存，刷新按钮才强制拉取
    }
    function epReconcile(ep) {
      var mode = panel.querySelector(".zu-ep-mode");
      if (typeof epSavedRevision !== "number" || !mode || !ep || ep.unreadable || !Number.isSafeInteger(ep.revision)) return;
      if (!mode.__zuInitialized) { epApplySaved(ep); return; }
      if (ep.revision <= epSavedRevision || epSaving) return;
      if (!epDirty()) { epApplySaved(ep); return; }
      epConflict = true; epModelRequest++;
      panel.querySelector(".zu-ep-status").textContent = L("其他窗口已修改配置；草稿已保留，请重新载入后再保存。", "Settings changed in another window. Your draft is retained; reload before saving.");
      panel.querySelector(".zu-ep-reload").hidden = false;
    }
    function epCaptureDraft() {
      var mode = panel.querySelector(".zu-ep-mode");
      if (!mode || !mode.__zuInitialized) return null;
      var values = {};
      ["mode", "source", "url", "protocol", "model", "key", "preset", "search"].forEach(function (name) { var el = panel.querySelector(".zu-ep-" + name); if (el) values[name] = el.value; });
      var host = panel.querySelector(".zu-ep-host");
      values.host = host ? host.value || host.__zuPendingId || "" : "";
      var allowBox = panel.querySelector(".zu-ep-allow-downgrade"), saveBox = panel.querySelector(".zu-ep-save-history");
      if (allowBox) values.allowDowngrade = allowBox.checked;
      if (saveBox) values.saveHistory = saveBox.checked;
      return values;
    }
    function epRestoreDraft(values) {
      if (!values) return;
      ["mode", "source", "url", "protocol", "model", "key", "preset", "search"].forEach(function (name) { var el = panel.querySelector(".zu-ep-" + name); if (el && typeof values[name] === "string") el.value = values[name]; });
      var mode = panel.querySelector(".zu-ep-mode"), host = panel.querySelector(".zu-ep-host");
      if (!mode || !host) return;
      mode.__zuInitialized = true; host.__zuPendingId = values.host || "";
      var allowBox = panel.querySelector(".zu-ep-allow-downgrade"), saveBox = panel.querySelector(".zu-ep-save-history");
      if (allowBox && typeof values.allowDowngrade === "boolean") allowBox.checked = values.allowDowngrade;
      if (saveBox && typeof values.saveHistory === "boolean") saveBox.checked = values.saveHistory;
      epHostRequest++; epModelRequest++; epHostsLoaded = false;
      epRender();
      var reload = panel.querySelector(".zu-ep-reload"), status = panel.querySelector(".zu-ep-status");
      if (reload) reload.hidden = !epConflict;
      if (status && epSaving) status.textContent = L("保存结果待确认，请勿重复提交。", "Save outcome pending; do not resubmit yet.");
      else if (status && epConflict) status.textContent = L("其他窗口已修改配置；草稿已保留，请重新载入后再保存。", "Settings changed in another window. Your draft is retained; reload before saving.");
      else if (status) epSyncDirtyStatus();
      if (values.mode === "custom" && values.source === "host") { epLoadHosts(false); epApplyModelCache({ source: "host", providerId: values.host || "", baseUrl: values.url || "", protocol: values.protocol || "" }); }
    }
    function epValue(selector) { var el = panel.querySelector(selector); return el ? el.value : ""; }
    function epForm() { var acb = panel.querySelector(".zu-ep-allow-downgrade"), scb = panel.querySelector(".zu-ep-save-history"); return { mode: epValue(".zu-ep-mode"), source: epValue(".zu-ep-source"), providerId: epValue(".zu-ep-host"), baseUrl: epValue(".zu-ep-url").trim(), protocol: epValue(".zu-ep-protocol"), model: epValue(".zu-ep-model"), allowDowngrade: !acb || acb.checked, saveHistory: !scb || scb.checked }; }
    function epRender() {
      var f = epForm(), custom = f.mode === "custom", host = f.source === "host";
      panel.querySelector(".zu-ep-default").hidden = custom;
      panel.querySelector(".zu-ep-custom").hidden = !custom;
      panel.querySelector(".zu-ep-host-panel").hidden = !custom || !host;
      panel.querySelector(".zu-ep-manual-panel").hidden = !custom || host;
      var warning = panel.querySelector(".zu-ep-warning");
      warning.hidden = !custom || !epRisk(f.baseUrl);
      warning.textContent = L("此地址使用 HTTP 或本机／内网连接，Key 与草稿可能发送至该目标，请确认服务可信。", "This HTTP or local/intranet target may receive your key and draft. Verify that you trust it.");
      var ep = state.pluginUpdate && state.pluginUpdate.enhanceProvider;
      panel.querySelector(".zu-ep-key-state").textContent = ep && ep.keyConfigured ? L("已保存 API Key", "API key saved") : L("尚未保存 API Key", "No saved API key");
      panel.querySelector(".zu-ep-remove").disabled = !(ep && ep.keyConfigured);
      panel.querySelector(".zu-ep-remove").hidden = !(ep && ep.keyConfigured);
    }
    var epHostCache = null, epHostCacheAt = 0, epModelCache = {};   // 实例级内存缓存：供应商列表 5 分钟、模型列表按目标 10 分钟；刷新/拉取强制走网络
    function epRenderHosts(providers) {
      var select = panel.querySelector(".zu-ep-host"), grid = panel.querySelector(".zu-ep-host-grid"), old = select.value || select.__zuPendingId || "";
      select.textContent = ""; grid.textContent = "";
      var empty = document.createElement("option"); empty.value = ""; empty.textContent = L("请选择供应商", "Select a provider"); select.appendChild(empty);
      providers.forEach(function (p) {
        var option = document.createElement("option"); option.value = p.id; option.textContent = p.name; option.dataset.url = p.baseUrl; option.dataset.protocol = p.protocol; select.appendChild(option);
        var card = document.createElement("button"); card.type = "button"; card.className = "zu-ep-host-card"; card.dataset.id = p.id;
        var title = document.createElement("strong"); title.textContent = p.name;
        var meta = document.createElement("small"), domain = p.baseUrl;
        try { domain = new URL(p.baseUrl).host; } catch (e) { }
        meta.textContent = domain + " · " + p.protocol;
        var mark = document.createElement("span"); mark.className = "zu-ep-host-check"; mark.textContent = L("✓ 已选择", "✓ Selected"); mark.hidden = p.id !== old;
        card.appendChild(title); card.appendChild(meta); card.appendChild(mark); card.setAttribute("aria-pressed", p.id === old ? "true" : "false"); grid.appendChild(card);
      });
      select.value = old; select.__zuPendingId = "";
      return old;
    }
    function epApplyModelCache(form) {
      var list = panel.querySelector(".zu-ep-model-list");
      list.textContent = "";   // 目标变化先清空旧列表，避免残留上一个供应商的模型
      var key = JSON.stringify([form.source, form.providerId, form.baseUrl, form.protocol]);
      var hit = epModelCache[key];
      if (!hit || Date.now() - hit.at > 600000) return false;
      hit.models.forEach(function (id) { var option = document.createElement("option"); option.value = id; list.appendChild(option); });
      panel.querySelector(".zu-ep-model-status").textContent = L("模型列表（缓存）· 正在自动更新。", "Model list (cached); auto-refreshing.");
      return true;
    }
    function epModelsErrorText(result) {
      var error = result && result.error || "";
      return error === "restart required" ? L("请完全重启 ZCode 后重试。", "Fully restart ZCode and retry.") : error === "settings changed" ? L("配置版本已变化，请重新载入后重试。", "Settings changed; reload and retry.") : error === "provider unavailable" ? L("供应商不可用，请重新选择并检查其配置。", "Provider unavailable; reselect it and check its settings.") : error === "unsupported platform" ? L("当前平台暂不支持该操作。", "Not supported on this platform.") : error === "cancelled" ? L("操作已取消，输入已保留。", "Cancelled; your edits were retained.") : /^HTTP (401|403)$/.test(error) ? L("模型接口拒绝访问，请检查供应商凭据或权限。", "Model endpoint denied access; check credentials and permissions.") : /^HTTP (404|405)$/.test(error) ? L("该地址不支持模型列表，请手动填写模型 ID。", "This endpoint does not support model lists; enter a model ID.") : L("模型列表获取失败，请检查网络与接口地址，或手动输入模型 ID。", "Failed to fetch models; check network and endpoint, or enter a model ID.");
    }
    function epRequestModels(f, formApiKey, done) {
      var ep = state.pluginUpdate && state.pluginUpdate.enhanceProvider;
      if (!ep || !ep.available || ep.unreadable || epSaving || epConflict || !Number.isSafeInteger(epSavedRevision)) return false;
      var serial = ++epModelRequest, version = epEditVersion;
      var req = { revision: epSavedRevision, form: { source: f.source, providerId: f.providerId, baseUrl: f.baseUrl, protocol: f.protocol } };
      if (f.source === "manual" && formApiKey) req.formApiKey = formApiKey;
      pluginRequest("enhance-provider-models", req, function (result) {
        if (inactive() || serial !== epModelRequest || version !== epEditVersion) return;
        var list = panel.querySelector(".zu-ep-model-list");
        if (result && result.ok && Array.isArray(result.models)) {
          list.textContent = "";
          result.models.forEach(function (id) { var option = document.createElement("option"); option.value = id; list.appendChild(option); });
          epModelCache[JSON.stringify([f.source, f.providerId, f.baseUrl, f.protocol])] = { models: result.models.slice(0, 200), at: Date.now() };
        }
        done && done(result);
      });
      return true;
    }
    function epLoadHosts(force) {
      if (epHostsLoaded && !force) return;
      var status = panel.querySelector(".zu-ep-host-status");
      if (!force && epHostCache && Date.now() - epHostCacheAt < 300000) {   // 缓存命中：同步渲染，不发请求
        epHostsLoaded = true;
        var old = epRenderHosts(epHostCache);
        status.textContent = !epHostCache.length ? L("没有可用供应商：请检查启用状态、协议和凭据，或使用手动配置。", "No compatible providers. Check their status, protocol and credentials, or use manual configuration.") : "";
        return;
      }
      var serial = ++epHostRequest;
      if (!force) {   // 硬盘缓存先行：主进程直接回上次拉取的列表，新鲜数据随后覆盖
        pluginRequest("enhance-provider-list", { cached: true }, function (res) {
          if (inactive() || epHostsLoaded || !res || !res.ok || !Array.isArray(res.providers)) return;
          epHostsLoaded = true; epHostCache = res.providers; epHostCacheAt = Date.now();
          epRenderHosts(res.providers);
          status.textContent = !res.providers.length ? L("没有可用供应商：请检查启用状态、协议和凭据，或使用手动配置。", "No compatible providers. Check their status, protocol and credentials, or use manual configuration.") : "";
        });
      }
      status.textContent = L("正在加载供应商…", "Loading providers…");
      pluginRequest("enhance-provider-list", {}, function (result) {
        if (inactive() || serial !== epHostRequest) return;
        if (!result || !result.ok || !Array.isArray(result.providers)) { epHostsLoaded = false; status.textContent = L("供应商加载失败，请刷新重试。", "Failed to load providers. Refresh to retry."); return; }
        epHostsLoaded = true; epHostCache = result.providers; epHostCacheAt = Date.now();
        var old = epRenderHosts(result.providers);
        status.textContent = !result.providers.length ? L("没有可用供应商：请检查启用状态、协议和凭据，或使用手动配置。", "No compatible providers. Check their status, protocol and credentials, or use manual configuration.") : old && panel.querySelector(".zu-ep-host").value !== old ? L("已保存的供应商不可用，请重新选择。", "The saved provider is unavailable; select another.") : "";
      });
    }
    function syncPanel() {
      panel.querySelectorAll('.zu-theme-choice').forEach(function (r) {
        r.checked = state.theme === r.value;
      });
      panel.querySelectorAll('.zu-just-choice').forEach(function (r) {
        r.checked = state.barJust === r.value;
      });
      panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
        cb.checked = !!state.show[cb.dataset.k];
      });
      /* v352 排序卡回填（v249 双回填契约）：radio 选中态按 state.barPriority；
       * 行序与 state.barOrder 漂移（他实例已改）时整卡重建。 */
      panel.querySelectorAll(".zu-layout-row").forEach(function (row) {
        var key = row.dataset.zuLayoutKey;
        row.querySelectorAll(".zu-layout-prio input").forEach(function (r) {
          r.checked = (state.barPriority[key] || "normal") === r.value;
        });
      });
      var domOrder = Array.prototype.map.call(panel.querySelectorAll(".zu-layout-row"), function (row) { return row.dataset.zuLayoutKey; });
      if (domOrder.length && domOrder.join("|") !== (state.barOrder || []).join("|")) refreshLayoutEditor(null, null);
      /* v356 系统状态配置卡回填（他窗 storage 同步/重建后值态一致）；预览行由 sysmonTick 帧驱动。
       * 切片沙箱纪律：state.sysmonCfg 可能缺字段，守卫回退归一化缺省。 */
      var sysCfgL = (state.sysmonCfg && state.sysmonCfg.thresholds) ? state.sysmonCfg : normalizeSysmonCfg(null);
      panel.querySelectorAll(".zu-syscfg-m").forEach(function (cb) {
        var k = cb.getAttribute("data-sysm");
        if (k && sysCfgL.metrics[k] !== undefined) cb.checked = !!sysCfgL.metrics[k];
      });
      panel.querySelectorAll(".zu-syscfg-vol").forEach(function (cb) {
        var k = cb.getAttribute("data-sysm");
        if (k === "projectVol") cb.checked = !!sysCfgL.projectVol;
        else if (k === "systemVol") cb.checked = !!sysCfgL.systemVol;
      });
      var sysWarnBox = panel.querySelector(".zu-syscfg-warn");
      if (sysWarnBox) sysWarnBox.checked = !!sysCfgL.warnColors;
      var sysFmt = panel.querySelector(".zu-syscfg-fmt");
      if (sysFmt) sysFmt.value = sysCfgL.format;
      var sysInt = panel.querySelector(".zu-syscfg-int");
      if (sysInt) sysInt.value = String(Math.round(sysCfgL.intervalMs / 1000));
      var sysDInt = panel.querySelector(".zu-syscfg-dint");
      if (sysDInt) sysDInt.value = String(Math.round(sysCfgL.diskIntervalMs / 1000));
      panel.querySelectorAll(".zu-syscfg-th").forEach(function (inp) {
        var k = inp.getAttribute("data-th");
        if (k && sysCfgL.thresholds[k] !== undefined) inp.value = String(sysCfgL.thresholds[k]);
      });
      var thErrSync = panel.querySelector("[data-zu-sys-therr]");   // v362：他窗同步后阈值关系提示跟随新值
      if (thErrSync) {
        var syncIssues = sysThresholdIssues(sysCfgL);
        if (syncIssues.length) { thErrSync.textContent = syncIssues.join(L("；", "; ")); thErrSync.hidden = false; }
        else {
          thErrSync.hidden = true;
          panel.querySelectorAll(".zu-syscfg-th.zu-syscfg-bad").forEach(function (inp2) { inp2.classList.remove("zu-syscfg-bad"); });
        }
      }
      panel.querySelector(".zu-ctxov").value = state.ctxOv;
      var rstCdhIn = panel.querySelector(".zu-rst-cdh");
      if (rstCdhIn) rstCdhIn.value = String(state.resetCdh);
      var kmbBox = panel.querySelector(".zu-force-kmb");
      if (kmbBox) kmbBox.checked = !!state.forceKmb;
      var cnBox = panel.querySelector(".zu-cn-num");
      if (cnBox) cnBox.checked = !!state.cnNum;
      var ppBox = panel.querySelector(".zu-pp-enable");
      if (ppBox) ppBox.checked = !!state.projPath;
      var ctxEnhBox = panel.querySelector(".zu-ctx-enh");
      if (ctxEnhBox) ctxEnhBox.checked = !!state.ctxEnh;
      var ctxBkdBox = panel.querySelector(".zu-ctx-bkd");
      if (ctxBkdBox) ctxBkdBox.checked = !!state.ctxBkd;
      var cptBox = panel.querySelector(".zu-cpt-btn");
      if (cptBox) cptBox.checked = !!state.ctxCpt;
      var costBox = panel.querySelector(".zu-cost-enable");
      if (costBox) costBox.checked = !!state.cost;
      var cwBox = panel.querySelector(".zu-cmdk-widen");
      if (cwBox) cwBox.checked = !!state.cmdkW;
      var cmpAnnBox = panel.querySelector(".zu-cmp-ann");
      if (cmpAnnBox) cmpAnnBox.checked = !!state.cmpAnn;
      var tipClickBox = panel.querySelector(".zu-tip-click");
      if (tipClickBox) tipClickBox.checked = !!state.tipClick;
      var tipHoverMsSel = panel.querySelector(".zu-tip-hover-ms");
      if (tipHoverMsSel) tipHoverMsSel.value = String(parseInt(state.tipHoverMs, 10) || 0);
      var devKeepTipBox = panel.querySelector(".zu-dev-keep-tip");
      if (devKeepTipBox) devKeepTipBox.checked = !!state.devKeepTip;
      var qrBox = panel.querySelector(".zu-quota-remain");
      if (qrBox) qrBox.checked = !!state.quotaRemain;
      if (typeof epReconcile === "function") epReconcile(state.pluginUpdate && state.pluginUpdate.enhanceProvider);
      if (typeof epSyncDirtyStatus === "function") epSyncDirtyStatus();
      if (typeof zuRotatorSyncPanel === "function") zuRotatorSyncPanel(panel);
      syncUpdate();
    }
    var relaunchAckTimer = 0;   /* v177：relaunch 回执超时（v244 起主进程回执随投递即返，含 1s 轮询约 1s 量级；超时≈旧主进程） */
    var relaunchAliveTimer = 0; /* v244：ok 回执后 90s 仍存活兜底——防状态机永久卡死；窗口可能已被 v245 hide，主进程 15s unhide 哨兵负责恢复可见 */
    var relaunchConfirmTimer = 0; /* v379 review：二次确认 5s 还原定时器——发送/dispose 时清理，防面板重建后旧定时器误清新按钮的确认态 */
    var relaunchSeq = 0;          /* v379 review：每次发送递增的代际号——4s/回执/90s 回调据此丢弃过期回执，防重建后迟到 ok 重挂 alive 误清新一轮重启 */
    /* v379：底栏与更新区的「重启 ZCode」按钮共用同一状态机——点其中一个，两处同步 armed/文案/禁用。
       测试桩无 querySelectorAll 时退回单按钮，保持既有单按钮契约不变。 */
    function relaunchSiblings(active) {
      var all = panel.querySelectorAll ? panel.querySelectorAll('[data-update=relaunch]') : null;
      return all && all.length ? Array.prototype.slice.call(all) : [active];
    }
    function eachRelaunch(active, fn) {
      var arr = relaunchSiblings(active);
      for (var ri = 0; ri < arr.length; ri++) fn(arr[ri]);
    }
    /* v379：ok 回执守卫读「当前 DOM」任一同 action 按钮是否处于 sent=1——
       不能读闭包捕获的 button（面板重建后它已脱离 DOM，sent 陈旧），否则 4s 超时还原后
       迟到 ok 会误挂 90s alive 兜底，进而误清新一轮重启状态。 */
    function eachRelaunchSends(active) {
      var arr = relaunchSiblings(active);
      for (var ri = 0; ri < arr.length; ri++) {
        if (arr[ri] && arr[ri].dataset && arr[ri].dataset.sent === "1") return true;
      }
      return false;
    }

    /* 自定义排序：HTML Drag and Drop + 明确的键盘上下移动按钮，均沿用展示配置存储。
     * v352：单根 .zu-layout-card 整卡替换；焦点目标被 disabled 时回退同行可用控件。 */
    var zuDragKey = "", zuDragOverRow = null;
    function refreshLayoutEditor(focusKey, focusSelector) {
      var oldCard = panel.querySelector(".zu-layout-card:not(.zu-syscfg)");   // v362 review A2：显式排除系统状态卡（同为 zu-layout-card，DOM 序耦合曾靠 buildPanel 顺序隐式保证）
      if (!oldCard) return;
      var container = document.createElement("div");
      container.innerHTML = barOrderSettingsHtml();
      var updated = container.firstElementChild;
      if (!updated || !updated.classList || !updated.classList.contains("zu-layout-card")) return;
      oldCard.replaceWith(updated);
      if (focusKey && focusSelector) {
        var row = panel.querySelector('.zu-layout-row[data-zu-layout-key="' + focusKey + '"]');
        var focus = row && row.querySelector(focusSelector);
        if (focus && focus.disabled) {   // 移到端点后同向按钮已禁用：焦点回退同行可用控件
          focus = row.querySelector(".zu-layout-action:not(:disabled)") ||
                  row.querySelector(".zu-layout-prio input:not(:disabled)");
        }
        if (focus && focus.focus) focus.focus();
      }
    }
    function announceLayout(key) {
      var pos = state.barOrder.indexOf(key);
      if (pos < 0 || !ariaLiveState) return;
      var t = ZU_BAR_TITLES[key] || [key, key];
      ariaLiveState.textContent = L(t[0], t[1]) + L(" 已移至第 ", " moved to position ") + (pos + 1) + (state.lang === "en" ? "" : " 位");
    }
    function applyLayoutOrder(next, focusKey, focusSelector) {
      state.barOrder = zuBarOrderNormalize(next);
      persistBarOrder();
      refreshLayoutEditor(focusKey, focusSelector);
      if (focusKey && focusSelector) announceLayout(focusKey);   // 键盘排序播报；鼠标拖放不还焦点不播报
      foldDirty = true;   // v359：显式联动折叠重算（render 路径经 didRebuild 本会置位，此处防御短路；同级右先折的候选位次跟手）
      renderAll(false);
    }
    panel.addEventListener("dragstart", function (e) {
      var row = e.target && e.target.closest && e.target.closest(".zu-layout-row");
      if (!row || (e.target.closest && e.target.closest("input,select,button"))) { e.preventDefault(); return; }
      zuDragKey = row.dataset.zuLayoutKey;
      if (!zuDragKey || state.barOrder.indexOf(zuDragKey) < 0) { e.preventDefault(); return; }
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", zuDragKey);
      }
    });
    panel.addEventListener("dragover", function (e) {
      var row = e.target && e.target.closest && e.target.closest(".zu-layout-row");
      if (!zuDragKey) return;
      if (!row) {   // 行间隙：清掉上一行高亮，不让描边滞留
        if (zuDragOverRow) { zuDragOverRow.classList.remove("zu-drag-over"); zuDragOverRow = null; }
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (zuDragOverRow !== row) {   // prevRow 记忆：命中行变化才摘/挂类，避免 dragover 高频全面板扫描
        if (zuDragOverRow) zuDragOverRow.classList.remove("zu-drag-over");
        row.classList.add("zu-drag-over");
        zuDragOverRow = row;
      }
    });
    panel.addEventListener("dragleave", function (e) {
      var row = e.target && e.target.closest && e.target.closest(".zu-layout-row");
      if (row && (!e.relatedTarget || !row.contains(e.relatedTarget))) {
        if (zuDragOverRow === row) zuDragOverRow = null;
        row.classList.remove("zu-drag-over");
      }
    });
    panel.addEventListener("drop", function (e) {
      var row = e.target && e.target.closest && e.target.closest(".zu-layout-row");
      if (!row || !zuDragKey) return;
      e.preventDefault();
      var target = row.dataset.zuLayoutKey, from = state.barOrder.indexOf(zuDragKey), to = state.barOrder.indexOf(target);
      var moving = zuDragKey;
      zuDragKey = "";
      if (from < 0 || to < 0 || from === to) return;
      var order = state.barOrder.slice();
      order.splice(from, 1);
      order.splice(to, 0, moving);
      applyLayoutOrder(order, moving, null);   // HTML5 DnD 期间焦点本不在行上，鼠标拖放不还焦点
    });
    panel.addEventListener("dragend", function () {
      zuDragKey = "";
      if (zuDragOverRow) { zuDragOverRow.classList.remove("zu-drag-over"); zuDragOverRow = null; }
      panel.querySelectorAll(".zu-drag-over").forEach(function (el) { el.classList.remove("zu-drag-over"); });
    });
    panel.addEventListener("click", function (e) {
      var testButton = e.target.closest && e.target.closest(".zu-ep-test-run,.zu-ep-test-cancel");
      if (testButton) {
        if (testButton.classList.contains("zu-ep-test-run")) epTestStart();
        else if (testButton.classList.contains("zu-ep-test-cancel")) epTestStop(L("测试已取消。", "Test cancelled."));
        return;
      }
      var epCard = e.target.closest && e.target.closest(".zu-ep-host-card");
      if (epCard) {
        var hostSelect = panel.querySelector(".zu-ep-host"); hostSelect.value = epCard.dataset.id;
        hostSelect.dispatchEvent(new Event("change", { bubbles: true }));
        panel.querySelectorAll(".zu-ep-host-card").forEach(function (card) { card.setAttribute("aria-pressed", card === epCard ? "true" : "false"); var mark = card.querySelector(".zu-ep-host-check"); if (mark) mark.hidden = card !== epCard; });
        return;
      }
      var epAction = e.target.closest && e.target.closest(".zu-ep-save,.zu-ep-hosts,.zu-ep-models,.zu-ep-remove,.zu-ep-reload");
      if (epAction) {
        var epStatus = panel.querySelector(".zu-ep-status"), ep = state.pluginUpdate && state.pluginUpdate.enhanceProvider;
        if (!ep || !ep.available || ep.unreadable) {
          epStatus.textContent = ep && ep.platformLimited
            ? L("当前平台暂不支持自定义增强供应商配置与历史落盘；增强历史仅本次运行内存可用。", "Custom enhancement provider settings and on-disk history are not supported on this platform; history stays in memory for this run only.")
            : L("增强配置不可用，请检查权限或重启 ZCode。", "Enhancement settings unavailable; check permissions or restart ZCode.");
          return;
        }
        if (epAction.classList.contains("zu-ep-reload")) {
          if (epDirty()) zuConfirm(L("重新载入配置", "Reload settings"), L("重新载入将丢弃当前未保存的修改，继续吗？", "Reloading will discard unsaved edits. Continue?"), L("继续", "Continue"), function () { epApplySaved(ep); });
          else epApplySaved(ep);
          return;
        }
        if (epAction.classList.contains("zu-ep-hosts")) { epLoadHosts(true); return; }
        if (epSaving || epConflict || ep.revision !== epSavedRevision) { epReconcile(ep); epStatus.textContent = L("配置已变化或正在保存，请等待或重新载入。", "Settings changed or a save is pending; wait or reload."); return; }
        var remove = epAction.classList.contains("zu-ep-remove"), save = epAction.classList.contains("zu-ep-save") || remove;
        var f = epForm(), keyField = panel.querySelector(".zu-ep-key"), key = keyField.value, revision = epSavedRevision, version = epEditVersion;
        if (!remove && f.mode === "custom" && f.source === "host" && !f.providerId) { epStatus.textContent = L("请先点击选择一个供应商，再拉取模型或保存。", "Select a provider card before fetching models or saving."); return; }
        if (!save) {   // 拉取模型走共享请求通道（自动/手动同款）
          var modelStatus = panel.querySelector(".zu-ep-model-status") || epStatus;
          modelStatus.textContent = L("正在获取模型…", "Fetching models…");
          var okReq = epRequestModels(f, key, function (result) {
            modelStatus.textContent = result && result.ok ? (result.models.length ? L("模型列表已获取；可输入或选择模型。", "Model list fetched; enter or select a model.") : L("模型列表为空，请手动输入模型 ID。", "No models returned; enter a model ID.")) : epModelsErrorText(result);
          });
          if (!okReq) modelStatus.textContent = L("增强配置暂不可用，请稍后重试。", "Enhancement settings are temporarily unavailable; retry.");
          return;
        }
        var proceed = function () {
        var opts = { revision: revision }, action = "enhance-provider-save";
        opts.changes = remove ? { keyAction: "clear" } : f.mode === "default" ? { mode: "default", allowDowngrade: !!f.allowDowngrade, saveHistory: !!f.saveHistory, keyAction: "keep" } : { mode: f.mode, source: f.source, providerId: f.providerId, baseUrl: f.baseUrl, protocol: f.protocol, model: f.model, allowDowngrade: !!f.allowDowngrade, saveHistory: !!f.saveHistory, keyAction: key ? "replace" : "keep" };
        if (!remove && key && f.source === "manual" && f.mode === "custom") opts.changes.apiKey = key;
        epAction.disabled = true; epAction.setAttribute && epAction.setAttribute("aria-busy", "true");
        epSaving = true;
        epStatus.textContent = L("正在保存配置…", "Saving settings…");
        var settled = false;
        var timer = setTimeout(function () { if (settled) return; epStatus.textContent = L("保存结果待确认，请勿重复提交。", "Save outcome pending; do not resubmit yet."); }, 15000);
        pluginRequest(action, opts, function (result) {
          if (settled) return; settled = true; clearTimeout(timer); epAction.disabled = false;
          epSaving = false;
          if (inactive()) return;
          epStatus = panel.querySelector(".zu-ep-status"); keyField = panel.querySelector(".zu-ep-key");
          if (result && result.ok && result.provider) {
            var latest = state.pluginUpdate && state.pluginUpdate.enhanceProvider;
            epSavedRevision = result.provider.revision;
            if (!latest || latest.revision <= result.provider.revision) {
              if (state.pluginUpdate) state.pluginUpdate.enhanceProvider = result.provider;
              latest = result.provider;
            }
            if (!remove && epEditVersion === version && keyField.value === key) { keyField.value = ""; epCleanVersion = version; }
            epSavedFormJson = JSON.stringify(epForm());   // v350.1 保存成功即以当前表单为新已保存基准：否则重开面板经 epSyncDirtyStatus 用旧基准比对，误报「配置未保存」
            epStatus.textContent = remove ? L("已移除保存的 Key；其他未保存修改仍保留。", "Saved key removed; other unsaved edits are retained.") : epEditVersion === version ? L("配置已保存", "Settings saved") : L("已保存先前的配置；当前修改未保存。", "Previous settings saved; current edits remain unsaved.");
            epRender(); epReconcile(latest); return;
          }
          epReconcile(state.pluginUpdate && state.pluginUpdate.enhanceProvider);
          var error = result && result.error || "";
          epStatus.textContent = error === "restart required" ? L("请完全重启 ZCode 后重试。", "Fully restart ZCode and retry.") : error === "settings changed" ? L("配置版本已变化，请重新载入后重试。", "Settings changed; reload and retry.") : error === "provider unavailable" ? L("供应商不可用，请重新选择并检查其配置。", "Provider unavailable; reselect it and check its settings.") : error === "unsupported platform" ? L("当前平台暂不支持该操作。", "Not supported on this platform.") : error === "cancelled" ? L("操作已取消，输入已保留。", "Cancelled; your edits were retained.") : L("保存失败，请检查配置后重试；输入已保留。", "Save failed; check settings and retry. Your edits were retained.");
        });
        };
        if (remove) {
          zuConfirm(L("移除 API Key", "Remove API key"), L("确定移除已保存的 API Key？", "Remove the saved API key?"), L("移除", "Remove"), proceed);
          return;
        }
        proceed();
      }

      var reset = e.target.closest && e.target.closest(".zu-layout-reset");
      if (reset) {
        state.barPriority = zuBarPriorityNormalize(null);
        persistBarPriority();
        applyLayoutOrder(ZU_BAR_KEYS.slice(), null, null);
        var newReset = panel.querySelector(".zu-layout-reset");
        if (newReset && newReset.focus) newReset.focus();   // 整卡替换后焦点跟到新按钮，键盘用户不被甩出
        return;
      }
      var shift = e.target.closest && e.target.closest("[data-zu-shift]");
      if (shift) {
        var row = shift.closest(".zu-layout-row"), key = row && row.dataset.zuLayoutKey;
        var from = state.barOrder.indexOf(key), to = from + Number(shift.dataset.zuShift);
        if (from >= 0 && to >= 0 && to < state.barOrder.length) {
          var next = state.barOrder.slice();
          next.splice(from, 1); next.splice(to, 0, key);
          applyLayoutOrder(next, key, '[data-zu-shift="' + shift.dataset.zuShift + '"]');
        }
        return;
      }
      if (typeof zuRotatorPanelClick === "function" && zuRotatorPanelClick(e, panel)) return;
      var navItem = e.target.closest && e.target.closest(".zu-navitem");
      if (navItem && navItem.getAttribute("data-sec") === "update") ackUpdateDots();   // v172：含已停留时再点
      if (navItem && !navItem.hasAttribute("aria-current")) {
        activateSettingsSec(navItem.dataset.sec);
        return;
      }
      if (e.target.closest && e.target.closest(".zu-settings-close")) {
        closeSettings(true);
        return;
      }
      if (e.target.closest && e.target.closest(".zu-settings-scroll")) {
        var body = panel.querySelector(".zu-settings-body");
        body.scrollTop += Math.max(1, Math.round(body.clientHeight * .8));
        syncSettingsScroll();
        return;
      }
      var presetBtn = e.target.closest && e.target.closest(".zu-src-preset");
      if (presetBtn) {
        if (presetBtn.dataset.src && presetBtn.dataset.base) pluginRequest("quota-src-key", { id: presetBtn.dataset.src, field: "baseUrl", value: presetBtn.dataset.base }, function (result) {
          if (!inactive()) showSourceFeedback(presetBtn.dataset.src, !result.ok, false);
        });
        return;
      }
      var srcBtn = e.target.closest && e.target.closest(".zu-src-refresh");
      if (srcBtn && !srcBtn.disabled) {
        pluginRequest("quota-src-refresh", { id: srcBtn.dataset.src });
        return;
      }
      if (e.target.closest && e.target.closest(".zu-settings-contact")) {
        openContactModal();
        return;
      }
      if (e.target.closest && e.target.closest(".zu-settings-feedback")) {
        /* 优先走客户端 zcode 桥（IPC → 主进程 shell.openExternal，系统默认浏览器）；
           window.open 会被客户端内置浏览器接管，仅作无桥环境兜底 */
        var zc = window.zcode, issuesUrl = "https://github.com/ByteRax/zcode-token-usage-statusbar/issues";
        if (zc && typeof zc.openExternal === "function") zc.openExternal(issuesUrl);
        else window.open(issuesUrl, "_blank", "noopener");
        return;
      }
      /* ---------- v202 更新日志卡片交互 ---------- */
      var notesLnk = e.target.closest && e.target.closest(".zu-notes-lnk");
      if (notesLnk) {
        var notesUrl = notesLnk.getAttribute("data-href") || "";
        if (/^https:\/\//.test(notesUrl) && notesUrl.length <= 600) {   // 双重校验：渲染时已过滤，点击再验一次
          var zn = window.zcode;
          if (zn && typeof zn.openExternal === "function") zn.openExternal(notesUrl);
          else window.open(notesUrl, "_blank", "noopener");
        }
        return;
      }
      var notesHistBtn = e.target.closest && e.target.closest(".zu-notes-history-btn");
      if (notesHistBtn) {
        var notesHistPanel = panel.querySelector(".zu-notes-history");
        if (notesHistPanel) {
          notesHistPanel.hidden = !notesHistPanel.hidden;
          notesHistorySig = "";
          if (!notesHistPanel.hidden && (notesHistoryState === "" ||
              (notesHistoryState === "done" && notesHistoryError && !notesHistory))) requestNotesList(false);   // 首次展开或上次失败：重新拉取
          renderNotesHistory();
        }
        return;
      }
      var notesHistItem = e.target.closest && e.target.closest(".zu-notes-hist-item");
      if (notesHistItem && notesHistItem.getAttribute("data-version")) {
        notesSel = { version: notesHistItem.getAttribute("data-version"), explicit: true };   // 粘性：轮询不切回
        renderNotesHistory();
        syncNotes();
        return;
      }
      var notesRetryBtn = e.target.closest && e.target.closest(".zu-notes-retry");
      if (notesRetryBtn && !notesRetryBtn.hidden) {
        var retryTarget = notesPickTarget(state.pluginUpdate).target;
        if (retryTarget && retryTarget.version) requestNotes(retryTarget.version, true);
        return;
      }
      var notesHistRetryBtn = e.target.closest && e.target.closest(".zu-notes-hist-retry");
      if (notesHistRetryBtn) {
        requestNotesList(true);   // force：绕过缓存重拉历史列表
        return;
      }
      var notesToggleBtn = e.target.closest && e.target.closest(".zu-notes-toggle");
      if (notesToggleBtn && !notesToggleBtn.hidden) {
        notesExpanded = !notesExpanded;
        syncNotes();
        return;
      }
      var notesLinkBtn = e.target.closest && e.target.closest(".zu-notes-link");
      if (notesLinkBtn && !notesLinkBtn.hidden) {
        var notesPageUrl = notesLinkBtn.getAttribute("data-href") || "";
        if (/^https:\/\//.test(notesPageUrl) && notesPageUrl.length <= 600) {
          var zp = window.zcode;
          if (zp && typeof zp.openExternal === "function") zp.openExternal(notesPageUrl);
          else window.open(notesPageUrl, "_blank", "noopener");
        }
        return;
      }
      var notesBackBtn = e.target.closest && e.target.closest(".zu-notes-back");
      if (notesBackBtn) {
        notesSel = { version: "", explicit: false };   // 回到默认目标（安装状态已变化时也由此收敛）
        syncNotes();
        return;
      }
      var button = e.target.closest && e.target.closest("[data-update]");
      if (button && !button.disabled) {
        if (button.dataset.update !== "relaunch") { pluginRequest(button.dataset.update); return; }
        var pu = state.pluginUpdate;
        if (pu && pu.relaunchSupported !== true) {   // v180 issue #158：防能力标记首推前的渲染窗口——主进程无 relaunch 能力时不发指令，直接给手动指引
          eachRelaunch(button, function (b) {
            b.dataset.armed = "0";
            if (!pu.restartRequired) b.classList.remove("zu-rr-armed");   // 待重启高亮仍由 syncUpdate 按 restartRequired 校正
            b.textContent = L("重启 ZCode", "Restart ZCode");
          });
          var puEl = panel.querySelector(".zu-update-status");
          if (puEl) puEl.textContent = L("「重启 ZCode」需要新版主进程支持：当前主进程是旧版本，请完全退出 ZCode 后重新打开。", "Restarting ZCode needs a newer main process: the running main process is outdated — quit ZCode completely and reopen it.");
          return;
        }
        /* v172 重启会关闭所有窗口：二次确认（首次变确认文案，5s 未再点还原）再发 relaunch 动作。
         * v244 退出等待期可达数十秒（宿主 app.quit 优雅退出链要关窗并逐个终止会话/扩展子进程）：
         * 发出即进入「正在重启…」禁用态并写预期文案，不再「发出即恢复」伪装无反应；
         * 4s 无回执 / ok:false 失败 / 90s 仍存活三路全部还原按钮。
         * v379：底栏与更新区两枚按钮同步全部状态（confirm/armed/sent/文案/禁用）。 */
        if (button.dataset.armed === "1") {
          if (relaunchConfirmTimer) { clearTimeout(relaunchConfirmTimer); relaunchConfirmTimer = 0; }   // v379：发送即取消 5s 确认还原，防旧定时器误清新按钮
          var mySeq = ++relaunchSeq;   // v379：本次发送代际——下方 4s/回执/90s 回调只认自己这一代，过期回调直接丢弃
          eachRelaunch(button, function (b) {
            b.dataset.armed = "0";
            if (!(state.pluginUpdate && state.pluginUpdate.restartRequired)) b.classList.remove("zu-rr-armed");
            b.dataset.sent = "1";   // syncUpdate 状态推送重建状态行时据此保持禁用与提示
            b.disabled = true;
            b.textContent = L("正在重启…", "Restarting…");
          });
          var stEl = panel.querySelector(".zu-update-status");
          if (stEl) stEl.textContent = L("已发出重启请求：ZCode 正在退出全部窗口并自动重新打开；等待会话与扩展子进程退出通常需要几秒到几十秒，请稍候。", "Restart request sent: ZCode is closing all windows and will reopen automatically; waiting for session and extension child processes to exit can take a few seconds to tens of seconds.");
          if (relaunchAckTimer) clearTimeout(relaunchAckTimer);
          relaunchAckTimer = setTimeout(function () {
            relaunchAckTimer = 0;
            if (relaunchSeq !== mySeq) return;   // v379：过期回执超时（已被新一次发送取代）不得还原状态
            /* v177：旧 pollPluginRequests 白名单外动作 splice 后静默丢弃（无 ok:false 回执）——
             * 超时明确告知手动完全退出；v244 起同时还原「正在重启」态。 */
            eachRelaunch(button, function (b) {
              b.dataset.sent = "";
              b.disabled = false;
              b.textContent = L("重启 ZCode", "Restart ZCode");
            });
            var stEl = panel.querySelector(".zu-update-status");
            if (stEl) stEl.textContent = L("未收到重启回执：ZCode 主进程可能是旧版，请手动完全退出并重新打开。", "No receipt for the restart request; the ZCode main process may be outdated — quit ZCode completely and reopen it manually.");
          }, 4000);
          pluginRequest("relaunch", undefined, function (result) {
            if (relaunchSeq !== mySeq) return;   // v379：迟到回执属于旧代际（面板重建/新一轮重启），整段丢弃
            if (relaunchAckTimer) { clearTimeout(relaunchAckTimer); relaunchAckTimer = 0; }
            if (result && result.ok === false) {
              eachRelaunch(button, function (b) {
                b.dataset.sent = "";
                b.disabled = false;
                b.textContent = L("重启 ZCode", "Restart ZCode");
              });
              var stEl = panel.querySelector(".zu-update-status");
              if (stEl) stEl.textContent = /^unknown action:/.test(String(result.error || ""))
                ? L("重启请求未被识别：ZCode 主进程是旧版本，请完全退出 ZCode 后重新打开。", "The restart request was not recognized: the ZCode main process is outdated — quit ZCode completely and reopen it.")
                : L("重启请求失败：", "Restart failed: ") + (result.error || "");
            } else if (result && result.ok && eachRelaunchSends(button)) {
              /* v244：ok 后保持「正在重启」态（状态文案发送时已写，回执不改写）；挂 90s 仍存活
               * 兜底——quit 被会话/扩展阻止时按钮不能永久卡死（4s 超时已还原则跳过）。
               * 正常路径渲染进程随窗口退出先于本定时器消亡，回调不再执行。 */
              if (relaunchAliveTimer) clearTimeout(relaunchAliveTimer);
              relaunchAliveTimer = setTimeout(function () {
                relaunchAliveTimer = 0;
                if (relaunchSeq !== mySeq) return;   // v379：过期 alive 兜底不得误清新一轮重启状态
                eachRelaunch(button, function (b) {
                  b.dataset.sent = "";
                  b.disabled = false;
                  b.textContent = L("重启 ZCode", "Restart ZCode");
                });
                var stEl = panel.querySelector(".zu-update-status");
                if (stEl) stEl.textContent = L("ZCode 仍未退出（可能被会话或扩展子进程阻止）：可再次点击重启，或手动完全退出后重新打开。", "ZCode has not exited (it may be blocked by a session or extension child process): click restart again, or quit ZCode completely and reopen it.");
              }, 90000);
            }
          });
        } else {
          eachRelaunch(button, function (b) {
            b.dataset.armed = "1";
            b.classList.add("zu-rr-armed");
            b.textContent = L("再次点击确认重启", "Click again to confirm restart");
          });
          if (relaunchConfirmTimer) clearTimeout(relaunchConfirmTimer);
          relaunchConfirmTimer = setTimeout(function () {
            relaunchConfirmTimer = 0;
            eachRelaunch(button, function (b) {
              if (b.dataset.armed === "1") {
                b.dataset.armed = "0";
                if (!(state.pluginUpdate && state.pluginUpdate.restartRequired)) b.classList.remove("zu-rr-armed");
                b.textContent = L("重启 ZCode", "Restart ZCode");
              }
            });
          }, 5000);
        }
        return;
      }
      var keyBtn = e.target.closest && e.target.closest(".zu-src-keyurl");
      if (keyBtn) {
        /* 获取 Key：走客户端 openExternal 桥（系统默认浏览器），无桥环境 window.open 兜底 */
        var ku = keyBtn.getAttribute("data-url") || "";
        if (ku) {
          var zk = window.zcode;
          if (zk && typeof zk.openExternal === "function") zk.openExternal(ku);
          else window.open(ku, "_blank", "noopener");
        }
        return;
      }
      var signinBtn = e.target.closest && e.target.closest(".zu-src-signin");
      if (signinBtn) { onQianwenSigninClick(); return; }   // issue #399：千问设备码登录（不传节点：轮询按代际存活，见 onQianwenSigninClick）
    });
    gear.addEventListener("click", function (e) {
      e.stopPropagation();
      var opening = !panel.classList.contains("open");
      if (!opening) { closeSettings(true); return; }
      previousPanelFocus = document.activeElement;
      panel.classList.add("open");   /* 先置打开态再 syncPanel：预览引擎认领 panelEl 以 .open 为前提（顺序错配=首开预览空白） */
      if (typeof sysmonWantRecalc === "function") sysmonWantRecalc();   // v356：设置页开着即订阅采样（预览用真实数据；签名不变零开销；typeof 守卫兼容切片沙箱）
      try { syncPanel(); } catch (eOpenSync) { panel.classList.remove("open"); throw eOpenSync; }   /* syncPanel 抛错不残留半开面板（与旧顺序失败语义一致） */
      /* v172：持久化分区停在「插件更新」时打开面板即已查看；
       * v208：有待重启红点且未查看时直接落到「插件更新」分区（激活即 ack，红点灭），确保立刻看到提示与重启按钮 */
      if (activeSettingsSec() === "update") ackUpdateDots();
      else if (updDotOn()) activateSettingsSec("update");
      panel.setAttribute("aria-modal", "false");
      gear.setAttribute("aria-expanded", "true");
      panel.style.height = "";   // v101：重开时按当前分区内容重测高度（开着的期间高度锁死）
      positionSettingsPanel();
      subPopClose(false, "gear-open");   // 与子代理统一浮层互斥（v49→v217）
      hideTip(true, "gear-open");   // 移向齿轮的路上可能触发过条目 tooltip，开面板时一并收掉
      if (typeof hideUpdNoteTip === "function") hideUpdNoteTip();   // v413：悬停日志卡与面板互斥
      var activeNav = panel.querySelector('.zu-navitem[aria-current="page"]');
      if (activeNav) activeNav.focus();
    });
    /* v413：待重启红点时悬停/聚焦 ⚙ 弹更新日志卡（壳与收放是 01 分片文档级单例）。
     * 绑定放在 click 注册之后——大量 VM 切片以「gear.addEventListener("click"」收尾，
     * 放前面会被一并切进无 gear 桩的沙箱求值而 ReferenceError。 */
    gear.addEventListener("mouseenter", onGearUpdEnter);
    gear.addEventListener("focus", onGearUpdEnter);
    gear.addEventListener("mouseleave", onGearUpdLeave);
    gear.addEventListener("blur", onGearUpdLeave);
    gear.addEventListener("keydown", function (e) { if (e.key === "Escape" && typeof hideUpdNoteTip === "function") hideUpdNoteTip(); });
    panel.addEventListener("input", function (e) {
      var field = e.target;
      if (field.classList && field.classList.contains("zu-src-field")) field.__zuEditVersion = (field.__zuEditVersion || 0) + 1;
      if (field.classList && field.classList.contains("zu-ep-test-draft")) {
        epTest.draft = field.value;
        if (epTest.id) epTestStop(L("草稿已变化，请重新测试。", "Draft changed; test again."));
        else if (epTest.result && epTest.draft !== epTest.testedDraft) { epTest.status = L("上次测试结果", "Previous test result"); epTestRender(); }
        return;
      }
      if (field.closest && field.closest(".zu-ep")) {
        if (!field.classList.contains("zu-ep-search")) {
          if (epTest.id) epTestStop(L("配置已变化，请重新测试。", "Settings changed; test again."));
          else if (epTest.result) { epTest.status = L("上次测试结果（配置已变化）", "Previous test result (settings changed)"); epTestRender(); }
        }
        if (field.classList.contains("zu-ep-search")) {
          var q = field.value.toLowerCase(); panel.querySelectorAll(".zu-ep-host-card").forEach(function (card) { card.hidden = card.textContent.toLowerCase().indexOf(q) < 0; });
        } else { epEditVersion++; epSyncDirtyStatus(); epRender(); }
      }
    });
    panel.addEventListener("change", function (e) {
      var t2 = e.target;
      if (t2.classList && t2.classList.contains("zu-ep-test-draft")) return;
      if (t2.closest && t2.closest(".zu-ep")) {
        if (t2.classList.contains("zu-ep-source")) {
          panel.querySelector(".zu-ep-mode").value = t2.value === "default" ? "default" : "custom";   // 合并后的来源选择驱动隐藏模式位
          if (t2.value === "manual" && epValue(".zu-ep-preset") === "") {   // 首次切到手动来源：默认带出 Zhipu GLM 预设（地址/协议），Key 与模型仍留空
            var zhipu = null;
            (typeof ZU_EP_PRESETS !== "undefined" ? ZU_EP_PRESETS : []).forEach(function (g) { g.items.forEach(function (it) { if (it[0] === "zhipu-cn") zhipu = it; }); });
            if (zhipu) { panel.querySelector(".zu-ep-preset").value = "zhipu-cn"; panel.querySelector(".zu-ep-url").value = zhipu[2]; panel.querySelector(".zu-ep-protocol").value = zhipu[3]; panel.querySelector(".zu-ep-model").value = ""; }
          }
        }
        if (epTest.id) epTestStop(L("配置已变化，请重新测试。", "Settings changed; test again."));
        else if (epTest.result) { epTest.status = L("上次测试结果（配置已变化）", "Previous test result (settings changed)"); epTestRender(); }
        else { epTest.status = ""; epTestRender(); }   // 清掉过期提示（如错误/校验文案），不带入新模式
        if (t2.classList.contains("zu-ep-source") || t2.classList.contains("zu-ep-protocol")) {
          panel.querySelector(".zu-ep-model").value = "";
          panel.querySelector(".zu-ep-model-list").textContent = "";
        }
        if (t2.classList.contains("zu-ep-preset")) {
          var found = null;
          (typeof ZU_EP_PRESETS !== "undefined" ? ZU_EP_PRESETS : []).forEach(function (g) { g.items.forEach(function (it) { if (it[0] === t2.value) found = it; }); });
          if (found) { panel.querySelector(".zu-ep-url").value = found[2]; panel.querySelector(".zu-ep-protocol").value = found[3]; panel.querySelector(".zu-ep-model").value = ""; }
        }
        var hostApplied = false;
        if (t2.classList.contains("zu-ep-host") || t2.classList.contains("zu-ep-source") && t2.value === "host") {
          var hostField = panel.querySelector(".zu-ep-host"), selected = hostField.options[hostField.selectedIndex];
          if (selected && selected.value) {
            panel.querySelector(".zu-ep-url").value = selected.dataset.url || ""; panel.querySelector(".zu-ep-protocol").value = selected.dataset.protocol || ""; panel.querySelector(".zu-ep-model").value = "";
            hostApplied = true;
          }
        }
        epEditVersion++; epSyncDirtyStatus(); epRender();
        if (hostApplied) {   // 自动拉取放在版本号递增之后，回包不被同一事件的脏标记误判过期
          var targetForm = epForm(), autoStatus = panel.querySelector(".zu-ep-model-status");
          epApplyModelCache(targetForm);
          if (!epRequestModels(targetForm, "", function (result) {
            autoStatus.textContent = result && result.ok ? (result.models.length ? L("模型列表已获取；可输入或选择模型。", "Model list fetched; enter or select a model.") : L("模型列表为空，请手动输入模型 ID。", "No models returned; enter a model ID.")) : epModelsErrorText(result);
          })) autoStatus.textContent = "";
        }
        if (epValue(".zu-ep-mode") === "custom" && epValue(".zu-ep-source") === "host") epLoadHosts(false);
      }
      if (t2.classList && t2.closest && t2.closest(".zu-layout-prio")) {
        var prioBox = t2.closest(".zu-layout-prio"), key = prioBox && prioBox.dataset.zuPriority;
        if (ZU_BAR_KEYS.indexOf(key) >= 0 && !t2.disabled) {
          state.barPriority[key] = ["high", "normal", "low"].indexOf(t2.value) >= 0 ? t2.value : ZU_BAR_PRIORITY_DEFAULT[key];
          persistBarPriority();
          renderAll(false);
        }
        return;
      }
      if (typeof zuRotatorPanelChange === "function" && zuRotatorPanelChange(e, panel)) return;
      /* v356 系统状态配置卡（.zu-syscfg-*）：本地纯展示偏好，改完即持久化+重渲染，
       * 不走主进程 config；want 签名含 cfg JSON，间隔/目标变化自动重发订阅。
       * 裸赋值（阈值/间隔）之后必须再过一次归一化 clamp——HTML min/max 不拦键入
       * （review M3：输入 0/-5/999999 会绕过 clamp 造成恒危险或永不过期）。 */
      if (t2.classList && (t2.classList.contains("zu-syscfg-m") || t2.classList.contains("zu-syscfg-vol") || t2.classList.contains("zu-syscfg-warn"))) {
        var sysKey = t2.getAttribute("data-sysm");
        var sc2 = normalizeSysmonCfg(Object.assign({}, state.sysmonCfg));
        if (t2.classList.contains("zu-syscfg-m") && sysKey && sc2.metrics[sysKey] !== undefined) sc2.metrics[sysKey] = t2.checked ? 1 : 0;
        else if (t2.classList.contains("zu-syscfg-vol") && (sysKey === "projectVol" || sysKey === "systemVol")) sc2[sysKey] = t2.checked;
        else if (t2.classList.contains("zu-syscfg-warn")) sc2.warnColors = t2.checked ? 1 : 0;
        state.sysmonCfg = normalizeSysmonCfg(sc2);
        persistSysmonCfg();
        sysmonWantRecalc(true);
        renderAll(false);
        try { sysmonApplyFace(); } catch (eSysFace) { }
        return;
      }
      if (t2.classList && t2.classList.contains("zu-syscfg-fmt")) {
        var sc3 = normalizeSysmonCfg(Object.assign({}, state.sysmonCfg));
        sc3.format = ["auto", "full", "compact", "minimal"].indexOf(t2.value) >= 0 ? t2.value : "auto";
        state.sysmonCfg = normalizeSysmonCfg(sc3);
        persistSysmonCfg();
        sysmonWantRecalc(true);
        renderAll(false);
        try { sysmonApplyFace(); } catch (eSysFmt) { }
        return;
      }
      if (t2.classList && (t2.classList.contains("zu-syscfg-int") || t2.classList.contains("zu-syscfg-dint") || t2.classList.contains("zu-syscfg-th"))) {
        var nSys = Math.floor(Number(t2.value));
        if (t2.value === "" || !isFinite(nSys)) return;   // 清空/乱码：不写不回填（Number("") 是 0，必须单独拦——review A2）
        var sc4 = normalizeSysmonCfg(Object.assign({}, state.sysmonCfg));
        if (t2.classList.contains("zu-syscfg-int")) sc4.intervalMs = nSys * 1000;
        else if (t2.classList.contains("zu-syscfg-dint")) sc4.diskIntervalMs = nSys * 1000;
        else {
          var thKey = t2.getAttribute("data-th");
          if (!thKey || sc4.thresholds[thKey] === undefined) return;
          sc4.thresholds[thKey] = nSys;
        }
        var sc5 = normalizeSysmonCfg(sc4);   // clamp 是唯一事实源（范围越界在此生效）
        /* 关系校验（v362）：CPU/内存 warn<crit、磁盘 warn>crit。非法不写入（不悄悄交换、
         * 不静默落错误配置），回填原生效值 + 行内红字 + 输入框红边；合法则写入并回填
         * clamp 后的实际生效值（HTML min/max 不拦键入，回填让用户看到真实生效数字）。 */
        if (t2.classList.contains("zu-syscfg-th")) {
          var candIssues = sysThresholdIssues(sc5);
          if (candIssues.length) {
            t2.value = String(state.sysmonCfg.thresholds[t2.getAttribute("data-th")]);
            t2.classList.add("zu-syscfg-bad");
            var errBox3 = panel.querySelector("[data-zu-sys-therr]");
            if (errBox3) { errBox3.textContent = candIssues.join(L("；", "; ")) + L("（已保留原值）", " (previous value kept)"); errBox3.hidden = false; }
            return;
          }
          t2.classList.remove("zu-syscfg-bad");
          t2.value = String(sc5.thresholds[t2.getAttribute("data-th")]);
        } else if (t2.classList.contains("zu-syscfg-int")) {
          t2.value = String(Math.round(sc5.intervalMs / 1000));
        } else {
          t2.value = String(Math.round(sc5.diskIntervalMs / 1000));
        }
        state.sysmonCfg = sc5;
        var errBox4 = panel.querySelector("[data-zu-sys-therr]");
        if (errBox4) {
          var stIssues = sysThresholdIssues(state.sysmonCfg);
          if (stIssues.length) { errBox4.textContent = stIssues.join(L("；", "; ")); errBox4.hidden = false; }
          else errBox4.hidden = true;
        }
        if (!sysThresholdIssues(state.sysmonCfg).length) {   // v362 review A1：关系恢复合法后清掉所有残留红边（跨字段修复场景）
          panel.querySelectorAll(".zu-syscfg-th.zu-syscfg-bad").forEach(function (inp2) { inp2.classList.remove("zu-syscfg-bad"); });
        }
        persistSysmonCfg();
        sysmonWantRecalc(true);
        renderAll(false);
        try { sysmonApplyFace(); } catch (eSysNum) { }
        return;
      }
      if (t2.classList.contains("zu-theme-choice")) {
        if (t2.checked && (t2.value === "default" || t2.value === "pill" || t2.value === "compact")) {
          if (ls(LS.autoCompact, "")) lsSet(LS.autoCompact, "");   // v226：手动改档即解除全关自动精简（无标记不写，保持持久化写面干净）
          setBarTheme(t2.value);
        }
        return;
      }
      if (t2.classList.contains("zu-just-choice")) {
        if (t2.checked) setBarJust(t2.value);   // v226：默认样式水平对齐（均分/居左/居右）
        return;
      }
      if (t2.classList.contains("zu-auto-update")) {
        pluginRequest("auto", t2.checked);
        return;
      }
      if (t2.classList.contains("zu-mobile-relay")) {
        /* pending 跨 pane 共享；只改变待确认勾选，采集仍以已确认配置为准。
         * 来源 pane 被摘除后回执仍须释放共享 pending，旧代际回执由 stale 拒收。 */
        if ((typeof mobileMode !== "undefined" && mobileMode) || state.mobileRelaySupported !== true || state.mobileRelayPending) { syncUpdate(); return; }
        var mobileSave = state.mobileRelayPending = { enabled: t2.checked === true, confirmed: false };
        function syncMobilePanels() {
          syncUpdate();
          instances.forEach(function (inst) { inst.syncUpdate(); });
        }
        syncMobilePanels();
        showSettingsFeedback(false, true);
        pluginRequest("mobile-relay", mobileSave.enabled, function (result) {
          if (stale() || state.mobileRelayPending !== mobileSave) return;
          state.mobileRelayPending = null;
          /* 主进程先广播实际值再回执；兼容回执先到的情况，后续广播仍可覆盖。
           * 失败没有乐观配置要撤回：移除 pending 即回到最近确认的真值。 */
          if (result && result.ok === true && !mobileSave.confirmed) state.mobileRelayEnabled = mobileSave.enabled;
          syncMobilePanels();
          if (!inactive()) showSettingsFeedback(!(result && result.ok === true), false);
        });
        return;
      }
      if (t2.classList.contains("zu-restart-notice")) {
        /* 乐观更新勾选态，真值以主进程写 config.json 后回推的 restartNotice 为准 */
        var requestedNotice = t2.checked, previousNotice = state.restartNotice;
        state.restartNotice = requestedNotice;
        showSettingsFeedback(false, true);
        pluginRequest("restart-notice", requestedNotice, function (result) {
          if (inactive()) return;
          if (result.ok) { showSettingsFeedback(false, false); return; }
          state.restartNotice = previousNotice;
          syncPanel();
          showSettingsFeedback(true);
        });
        return;
      }
      if (t2.classList.contains("zu-src-enable")) {
        var sourceToggle = t2, sourceWasEnabled = !t2.checked;
        showSourceFeedback(t2.dataset.src, false, true);
        pluginRequest("quota-src", { id: t2.dataset.src, enabled: t2.checked }, function (result) {
          if (inactive()) return;
          if (!result.ok) sourceToggle.checked = sourceWasEnabled;
          showSourceFeedback(sourceToggle.dataset.src, !result.ok, false);
        });
        return;
      }
      if (t2.classList.contains("zu-src-field")) {
        if (t2.dataset.src && t2.dataset.field) {
          var field = t2, editVersion = field.__zuEditVersion || 0;
          showSourceFeedback(field.dataset.src, false, true);
          pluginRequest("quota-src-key", { id: field.dataset.src, field: field.dataset.field, value: field.value }, function (result) {
            if (inactive()) return;
            if (result.ok && field.type === "password" && document.activeElement !== field && (field.__zuEditVersion || 0) === editVersion) field.value = "";
            showSourceFeedback(field.dataset.src, !result.ok, false);
          });
        }
        return;
      }
      if (t2.classList.contains("zu-quota-enable")) {
        /* v95：乐观更新，真值以主进程写 config.json 的 quota_enabled 后回推为准；关闭时
           chip 在下一次 heavy 对账点摘除，主进程停止解密与联网 */
        var requestedQuota = t2.checked;
        var previousQuota = state.quotaEnabled;
        state.quotaEnabled = requestedQuota;
        showSettingsFeedback(false, true);
        pluginRequest("quota", requestedQuota, function (result) {
          if (inactive()) return;
          if (result.ok) { showSettingsFeedback(false, false); return; }
          state.quotaEnabled = previousQuota;
          syncPanel();
          showSettingsFeedback(true);
        });
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-enhance-toggle")) {
        if ((typeof mobileMode !== "undefined" && mobileMode) || state.enhancePending) { syncEnhanceControls(); return; }
        /* 待保存的勾选态在同窗口共享，不提前改变真正的工具栏开关。 */
        var enhanceSave = state.enhancePending = { enabled: t2.checked, timer: 0, id: "" };
        function syncEnhancePanels() {
          if (!inactive()) syncEnhanceControls();
          instances.forEach(function (inst) { inst.syncUpdate(); });
        }
        function finishEnhanceSave(result) {
          if (stale() || state.enhancePending !== enhanceSave) return;
          clearTimeout(enhanceSave.timer);
          forgetPluginRequest(enhanceSave.id);
          state.enhancePending = null;
          syncEnhancePanels();
          if (!inactive()) showSettingsFeedback(!(result && result.ok === true), false);
        }
        syncEnhancePanels();
        showSettingsFeedback(false, true);
        enhanceSave.timer = setTimeout(finishEnhanceSave, 20000);   // 主进程配置写入上限 15s，另留投递时间
        enhanceSave.timer.unref?.();
        enhanceSave.id = pluginRequest("enhance", enhanceSave.enabled, finishEnhanceSave);
        return;
      }
      if (t2.classList.contains("zu-rst-enable")) {
        /* v135：乐观更新，真值以主进程写 config.json 的 reset_badge_enabled 后回推为准 */
        var requestedRst = t2.checked;
        var previousRst = state.resetBadge;
        state.resetBadge = requestedRst;
        showSettingsFeedback(false, true);
        pluginRequest("quota-reset", requestedRst, function (result) {
          if (inactive()) return;
          if (result.ok) { showSettingsFeedback(false, false); return; }
          state.resetBadge = previousRst;
          syncPanel();
          showSettingsFeedback(true);
        });
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-ac-enable")) {
        /* v179：乐观更新，真值以主进程打补丁/还原后回推的 enginePatch 为准。
           补丁即时写引擎文件；已运行 agent 子进程保持旧代码，下个 spawn/重启起用。 */
        var requestedAc = t2.checked;
        var previousAc = !!(state.enginePatch && state.enginePatch.enabled);
        if (state.enginePatch) state.enginePatch.enabled = requestedAc;
        showSettingsFeedback(false, true);
        pluginRequest("autocompact-patch", requestedAc, function (result) {
          if (inactive()) return;
          if (result.ok) {
            if (result.enginePatch) state.enginePatch = result.enginePatch;
            showSettingsFeedback(false, false);
          } else {
            if (state.enginePatch) state.enginePatch.enabled = previousAc;
            showSettingsFeedback(true);
          }
          syncAutoCompactInputs();
        });
        return;
      }
      if (t2.classList.contains("zu-rate-line")) {
        /* 乐观更新勾选态，真值以主进程写 config.json 后回推的 rateLine 为准 */
        var requestedRateLine = t2.checked;
        var previousRateLine = state.rateLine;
        state.rateLine = requestedRateLine;
        scanRateLines();
        scanDeterministicLines();   // v71：关=撤下确定性历史行，开=立即重扫补行
        showSettingsFeedback(false, true);
        pluginRequest("rate-line", requestedRateLine, function (result) {
          if (inactive()) return;
          if (result.ok) { showSettingsFeedback(false, false); return; }
          state.rateLine = previousRateLine;
          scanRateLines();
          scanDeterministicLines();
          syncPanel();
          showSettingsFeedback(true);
        });
        return;
      }
      if (t2.classList.contains("zu-force-kmb")) {
        /* v173：独立持久化（不进 persist 批量写），避免多窗口旧快照互相覆盖 */
        var nextForceKmb = t2.checked ? 1 : 0;
        if (nextForceKmb !== state.forceKmb) {
          richTextUnitEpoch++;
          richTextAttempts = {};
        }
        state.forceKmb = nextForceKmb;
        lsSet(LS.forceKmb, state.forceKmb ? "1" : "0");
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-cn-num")) {
        var nextCn = t2.checked ? 1 : 0;
        if (nextCn !== state.cnNum) {
          /* v177：与 forceKmb 同款在途竞态守卫——切换前在途的旧单位 turn-text 响应
           * 被 epoch 守卫拒绝，不再以旧万/亿格式写进缓存（已缓存行按契约不重算） */
          richTextUnitEpoch++;
          richTextAttempts = {};
        }
        state.cnNum = nextCn;
        persist();
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-pp-enable")) {
        /* v136：纯展示偏好存 localStorage；<html> 属性门控样式即时生效，无需重建 */
        state.projPath = t2.checked ? 1 : 0;
        persist();
        applyProjPath();
        return;
      }
      if (t2.classList.contains("zu-ctx-enh")) {
        /* v156：增强开关即时生效——下一拍 render/heavy 对账走 enhanceCtxButton 的关闭分支
         * 还原/重挂；这里直接调一次让按钮形态立即切换，不等对账周期 */
        state.ctxEnh = t2.checked ? 1 : 0;
        persist();
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-ctx-bkd")) {
        /* v487：构成明细增强开关即时生效——关闭即摘除弹层内已注入的估算 Token 数并收起气泡，
         * 开启即原位重挂，不等 Observer/heavy 对账周期 */
        state.ctxBkd = t2.checked ? 1 : 0;
        persist();
        if (!state.ctxBkd && typeof hideCtxBkdTip === "function") hideCtxBkdTip();
        syncCompactBtn();
        return;
      }
      if (t2.classList.contains("zu-cpt-btn")) {
        /* v200：压缩按钮开关即时生效——关闭立即摘除弹层内已注入按钮（确认框理论上进
         * 不到这里：弹框遮罩挡住齿轮，兜底关掉），开启即重挂；阈值行/说明行同拍顶到
         * 按钮原位，不等 Observer/heavy 对账周期 */
        state.ctxCpt = t2.checked ? 1 : 0;
        persist();
        if (!state.ctxCpt && compactDlg) closeCompactDlg();
        syncCompactBtn();
        return;
      }
      if (t2.classList.contains("zu-cost-enable")) {
        /* v202：费用行开关即时生效——纯展示偏好，立即重渲染让四格 tooltip/模型明细/
         * 紧凑摘要同拍带上或去掉费用行。v376：费用开关随 turn-text 请求透传给
         * token_rate.py（--no-cost），换代拒绝在途旧费用态回执。与 cn/forceKmb 同款：
         * 已缓存行按契约不重算（切开关后的新轮才带新费用态）——不能清 richTextCache，
         * 它覆盖本窗口所有轮，而 turn-text 只能重取当前活跃轮，清缓存会让历史轮永久
         * 降级为简化占位（丢模型 id/分级耗时/费用等 v376 格式）。 */
        var nextCost = t2.checked ? 1 : 0;
        if (nextCost !== state.cost) {
          richTextUnitEpoch++;
          richTextAttempts = {};
        }
        state.cost = nextCost;
        persist();
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-quota-remain")) {
        /* v251：额度显示口径切换——纯渲染偏好，立即重渲染让 chip 面分段数字与 aria、
         * 悬停明细（quotaTip）同拍改口径；档位色不受影响（恒按已用判定） */
        state.quotaRemain = t2.checked ? 1 : 0;
        persist();
        renderAll(false);
        return;
      }
      if (t2.classList.contains("zu-cmdk-widen")) {
        /* v146：同款纯展示偏好 + <html> 属性门控即时生效，无需重建 */
        state.cmdkW = t2.checked ? 1 : 0;
        persist();
        applyCmdkW();
        return;
      }
      if (t2.classList.contains("zu-cmp-ann")) {
        /* v421：压缩分隔线统计标注开关（⚙ 回答统计分区，缺省开）——纯展示偏好即时生效，
         * 关=摘除本 pane 标注、开=按内存记录补回（syncCompactionRows 幂等），无需重建 */
        state.cmpAnn = t2.checked ? 1 : 0;
        persist();
        syncCompactionRows();
        return;
      }
      if (t2.classList.contains("zu-tip-click")) {
        /* v249：纯渲染偏好，即时生效（下一次 mousemove/click 即按新模式判定） */
        state.tipClick = t2.checked ? 1 : 0;
        persist();
        return;
      }
      if (t2.classList.contains("zu-tip-hover-ms")) {
        /* v439：纯渲染偏好，即时生效——撤掉在途排程，下一次 mousemove 按新门槛排程；
         * v440：chip 单槽同撤（review 一致性：键盘改档时指针恰好停在 chip 上的边角） */
        var thm1 = parseInt(t2.value, 10);
        state.tipHoverMs = thm1 > 0 ? thm1 : 0;
        persist();
        tipHoverCancel();
        zuChipHoverDisarm();
        return;
      }
      if (t2.classList.contains("zu-dev-keep-tip")) {
        /* v297.3：开发者调试开关，即时生效（下一次收起判定即按新模式） */
        state.devKeepTip = t2.checked ? 1 : 0;
        persist();
        return;
      }
      if (t2.name === "zu-lang") {
        if (t2.value !== state.lang) {
          /* v177：cnUnits() 依赖 state.lang，zh↔en 翻转 turn-text 的 cn 分量——与 cnNum/
           * forceKmb 同款在途竞态守卫，拒掉旧单位格式的在途回复 */
          richTextUnitEpoch++;
          richTextAttempts = {};
        }
        state.lang = t2.value;
        persist();
        buildPanel();   // 面板自身文案随语言重建（含 radio 勾选态）
        rebuildExcBubble();
        renderAll(true);   // 条面单位与 tooltip 文案随语言刷新（含各实例面板文案重建）
        gear.setAttribute("aria-label", L("打开状态条设置", "Open status bar settings"));
        var languageInput = panel.querySelector('input[name="zu-lang"][value="' + state.lang + '"]');
        if (languageInput && languageInput.focus) languageInput.focus();
        return;
      }
      if (t2.classList.contains("zu-ac-value")) {
        /* v179→v188：数值变化即提交（留空=跟随引擎默认；主进程归一白名单后写
           autocompact.json，引擎 hook 每轮决策读——下一轮即生效，无需重启） */
        sendAutoCompactConfig();
        return;
      }
      if (t2.classList.contains("zu-ac-mode")) {
        /* v426→v436：切模式先重校验并回显已保存真值，再按当前窗口换算数值（空/非法保持原样），
         * 仍不提交——改值后由 input change 落盘。换算必须在 sync 之后：sync 会把输入框回写为
         * 已保存配置的回显（真机实报：先换算会被 sync 抹回原值，65→切 Token 数仍显 65）。 */
        syncAutoCompactInputs();
        try { acConvertOnModeSwitch(t2); acRefreshStatusLine(); } catch (eAcCvt) { try { window.__zusageDiag.acPanelErr = String((eAcCvt && eAcCvt.stack) || eAcCvt); } catch (_) { } }
        return;
      }
      if (t2.type === "checkbox") {
        state.show[t2.dataset.k] = t2.checked ? 1 : 0;
        persist();
        if (t2.dataset.k === "git") refreshWants();   // v96：开/关即时更新上报路径集（开启时顺带触发首查）
        if (t2.dataset.k) autoCompactOnShow(t2.dataset.k, !!t2.checked);   // v226：六格全关自动转精简/重开恢复
      } else if (t2.classList.contains("zu-ctxov")) {
        state.ctxOv = t2.value.trim();
        persist();
      } else if (t2.classList.contains("zu-rst-cdh")) {
        var cdh = parseInt(t2.value.trim(), 10);
        state.resetCdh = cdh >= 1 && cdh <= 24 * 7 ? cdh : 24;   // 1–168 小时，非法回退默认 24
        persist();
        renderAll(false);   // 阈值即时生效：徽标倒计时随 heavy/render 对账刷新
      }
      renderAll(false);
    });
    listenGlobal(document, "mousedown", function (e) {
      /* v80：面板挂 body 后 bar.contains 不再覆盖面板自身，点面板内部不能关。
       * 面板上层的 body 级弹框（词包查看 .zu-rot-pk-dlg / 模型选择 .zu-mp-ov）不算「面板外」：
       * 点遮罩/✕ 只关弹框本身，不联动关设置面板。遮罩关闭与面板外点判定同在 mousedown、
       * target 阶段先执行并已把 rotPkDlg/mpModal 置 null——按 target 向上匹配弹框根类名，
       * 弹框已 detach 时 closest 仍沿残留子树命中（用户复报：点弹框外仍连关设置） */
      var t = e.target;
      var inModal = !!(t && t.closest && t.closest(".zu-rot-pk-dlg,.zu-mp-ov,.zu-compact-dlg"));   // v342 补压缩弹框，与 OWN_LAYER_SEL 对齐
      if (panel.classList.contains("open") && !inModal && !bar.contains(t) && !panel.contains(t)) {
        closeSettings(false);
        previousPanelFocus = null;
      }
      if (subPopOpen() && !inModal && !bar.contains(t) && !subPanel.contains(t)) subPopClose(false, "outside");
    });
    listenGlobal(document, "click", onProjRowClick);   // v137：编辑项目弹窗源文件夹行点击打开文件管理器（随实例 dispose 摘除）

