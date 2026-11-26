    /* ---------- v480 模型选择器峰谷倍率徽标（specs/model-peak-factor-badge.md）----------
     * BigModel/GLM Coding Plan 套餐的模型行右缘显示当前时段额度消耗倍率（单值，title 带
     * 双档）。口径单一来源=桌面快照 peak.glm_plan 段（token_pricing 现算，specs/
     * peak-valley-time.md），本段零时段规则；段缺失（旧 Python/非桌面链/中继 lean/远端）
     * 整体静默。弹层每次打开全新挂载、行由 React 管理且会复用（title 整套换）——DOM 存在
     * 性幂等 + 每趟原位更新文本/title，复用 body hcObserver（即时）与 heavy（600ms 兜底）
     * 双触发，不新增监听器；弹层关闭徽标随宿主 DOM 销毁，dispose 零新增。
     * 非对称多实例语义：行级门控不过的实例对该行整体 no-op（绝不摘除）——多分栏多实例
     * 并发扫描同一弹层，非 GLM 实例不得扯掉 GLM 实例刚挂的徽标；摘除只由门控通过者按
     * 数据失配驱动（行级门控取自行上属性时各实例判定一致，pane 回退路径才需要本规则）。
     * 引擎锚点（ZCode 4.0.0 app.asar 静态取证，引擎改版则静默失效）：模型行 testid=
     * chat-model-select-item-<providerId>/<模型名>（providerMenu 为原生 button、普通下拉
     * 为 Radix div，故不用元素限定）；分组容器带 data-model-provider-key=
     * "registry-provider:<providerId>"（编码套餐账号的 providerId 即 quota 链 account: id）；
     * 选中 ✓ 为 absolute right-2（pr-8 padding 区），徽标以文档流追加在行内徽标容器
     * （span.flex-1）末尾、margin-left:auto，右缘止于内容区与之零重叠。 */
    var ZU_PEAK_ROW_SEL = '[data-testid^="chat-model-select-item-"]';
    function zuPeakProviderOf(row) {
      /* 行级供应商 id：祖先分组键（剥 registry-provider: 前缀）→ testid value 首段 → null */
      try {
        var g = row.closest ? row.closest("[data-model-provider-key]") : null;
        if (g) {
          var k = String(g.getAttribute("data-model-provider-key") || "");
          if (k.indexOf("registry-provider:") === 0) k = k.slice(18);
          if (k) return k;
        }
      } catch (e) { }
      try {
        var tid = String(row.getAttribute("data-testid") || "");
        if (tid.indexOf("chat-model-select-item-") === 0) {
          var v = tid.slice(23), slash = v.indexOf("/");   // 前缀恰 23 字符，勿差一
          if (slash > 0) return v.slice(0, slash);
        }
      } catch (e) { }
      return null;
    }
    function zuPeakFamilyOk(pid) {
      /* GLM 编码计划族：quota 链 account: id + bigmodel/zai 族 + coding-plan（start-plan 无官方系数，排除） */
      if (!pid) return false;
      pid = String(pid).toLowerCase();
      return pid.indexOf("account:") === 0 && pid.indexOf("-coding-plan") !== -1 &&
             (pid.indexOf("bigmodel") !== -1 || pid.indexOf("zai") !== -1);
    }
    function zuPeakModelName(row) {
      /* 模型名：testid value 首个 / 后段（结构化，registry 模型 name=modelId）→ 首 span
       * title → 首个非徽标 span 的文本。不回退整行 textContent——徽标自身的「N.NN×」
       * 会混入名字造成「挂上→匹配失败摘除→再挂上」振荡。畸形输入安全退化为不命中 */
      try {
        var tid = String(row.getAttribute("data-testid") || "");
        if (tid.indexOf("chat-model-select-item-") === 0) {
          var slash = tid.indexOf("/", 23);   // 前缀恰 23 字符，勿差一
          if (slash > 0) return tid.slice(slash + 1);
        }
      } catch (e) { }
      try {
        var spans = row.querySelectorAll("span");
        for (var i = 0; i < spans.length; i++) {
          if (spans[i].getAttribute("data-zusage-peak")) continue;   // 跳过徽标自身（title 与文本都不作数）
          var t = spans[i].getAttribute("title");
          if (t) return t;
          var txt = spans[i].textContent;
          if (txt) return String(txt);
        }
      } catch (e) { }
      return "";
    }
    function zuPeakMatchFactor(name, factors) {
      /* 精确等值匹配（小写），与 token_pricing.glm_plan_peak_factor 同语义——不用子串，
       * 防 GLM-5.3-FlashX 误命中 GLM-5.3-Flash（未收录模型必须不显示） */
      var n = String(name || "").toLowerCase();
      for (var i = 0; i < factors.length; i++) {
        if (String(factors[i] && factors[i][0] || "").toLowerCase() === n) return factors[i];
      }
      return null;
    }
    function zuPeakFormat(n) {
      /* 恒两位小数（2.00×/0.67×/1.00×）+ tabular-nums：各行数值成列对齐（维护者参考图样式），
       * 尾零裁剪会让左缘参差（2×/3×/1.2x 宽窄不一，真机反馈「丑陋」） */
      var v = Number(n);
      return (isFinite(v) ? v.toFixed(2) : "") + "×";
    }
    function syncModelPeakBadges() {
      if (inactive()) return;
      var seg = null;
      try { seg = state.data && state.data.peak && state.data.peak.glm_plan; } catch (e) { }
      if (!seg || !seg.factors || !seg.factors.length) return;   // 段缺失先早退，免旧 Python/lean 页面每拍白查
      var rows = null;
      try { rows = document.querySelectorAll(ZU_PEAK_ROW_SEL); } catch (e) { return; }
      if (!rows || !rows.length) return;   // 弹层未开：一次查询早退
      var paneOk = null;   // 惰性：行级判定不出供应商时才询本 pane 身份
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var pid = zuPeakProviderOf(row);
        var ok = zuPeakFamilyOk(pid);
        if (!ok && pid == null) {
          if (paneOk === null) {
            var pp = "";
            try { pp = effectiveQuotaProvider() || ""; } catch (e) { }
            paneOk = zuPeakFamilyOk(pp);
          }
          ok = paneOk;
        }
        if (!ok) continue;   // 非对称 no-op：绝不摘除（防多实例互踩）
        var pair = null;
        var name = "";
        try { name = String(zuPeakModelName(row) || "").toLowerCase(); } catch (e) { }
        if (name) pair = zuPeakMatchFactor(name, seg.factors);
        var badge = null;
        try { badge = row.querySelector("[data-zusage-peak]"); } catch (e) { }
        if (!pair) {
          if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
          continue;
        }
        var val = seg.is_peak ? pair[2] : pair[1];
        var txt = zuPeakFormat(val);
        var tip = "高峰 " + zuPeakFormat(pair[2]) + " · 非高峰 " + zuPeakFormat(pair[1]) +
                  "（额度消耗倍率，高峰：周一至五 14:00–18:00）";
        /* 挂点=行内徽标容器（span.flex-1，视觉徽标所在）；无则退化整行末尾 */
        var cont = row;
        try {
          for (var j = 0; j < row.children.length; j++) {
            var c = row.children[j];
            if (c.tagName === "SPAN" && (" " + c.className + " ").indexOf(" flex-1 ") !== -1) { cont = c; break; }
          }
        } catch (e) { }
        if (!badge || !badge.isConnected || badge.parentNode !== cont) {
          if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
          badge = document.createElement("span");
          badge.setAttribute("data-zusage-peak", "1");
          /* 弱化小字贴行右缘；不加 pointer-events-none——title 悬停要生效 */
          badge.style.cssText = "margin-left:auto;flex:0 0 auto;padding-right:6px;" +
            "font-variant-numeric:tabular-nums;" +   /* 同字号随行（不再 -2px 缩小）、等宽数字成列，弱化灰 */
            "color:var(--color-foreground-subtle,#8791a3);white-space:nowrap;";
          try { cont.appendChild(badge); } catch (e) { continue; }
        }
        if (badge.textContent !== txt) badge.textContent = txt;
        if (badge.getAttribute("title") !== tip) badge.setAttribute("title", tip);
      }
    }
