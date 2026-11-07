  /* ---------- 默认配置与归一化 ---------- */
  function defaultRotatorConfig() {
    return {
      enabled: true,
      labelSource: "phrases", // "phrases" | "host"
      intervalMs: 3500,
      typeSpeedMs: 28,
      longAfterMs: 30000,
      weightedRandom: true,
      antiRepeat: { recentLimit: 6, persist: false },
      enabledPacks: ZU_ROTATOR_PACK_META.map(function (m) { return m.id; }),
      activePreset: "default",
      scheduleEnabled: false,
      schedule: [
        { days: [1, 2, 3, 4, 5], hours: "9-18", preset: "work-focus" },
        { days: [0, 1, 2, 3, 4, 5, 6], hours: "23-5", preset: "late-night" }
      ],
      customPhrases: {
        zh: { thinking: [], running: [], long: [] },
        en: { thinking: [], running: [], long: [] }
      },
      appearance: {
        /* 用户规格默认（2026-11-06 晚二次改定）= 「无」主题（applyAppearanceThemePreset("none") 产物：
         * 无流光渐变/无尾巴炫彩/无辉光/无动效——标签回落宿主原生灰 shimmer、鲸鱼 currentColor；
         * gradient 色板保留经典值仅作启用后的初始色，enabled:false 时不消费） */
        theme: "none", // "none" | "classic" | "neon" | "terminal" | "candy" | "glitch"
        fontSizePx: 0, // 0 = follow host
        fontWeight: "500",
        glow: false,
        glowColor: "rgba(87, 200, 255, 0.4)",
        animation: "none", // "none" | "breathe" | "glitch"
        gradient: {
          enabled: false,
          mode: "auto", // "auto" | "night" | "day"
          direction: "ltr", // "ltr" | "rtl"
          speed: 3.2,
          nightColors: ["#ff6b6b", "#feca57", "#48dbfb", "#ff9ff3", "#54a0ff"],
          dayColors: ["#d63031", "#e17055", "#0984e3", "#6c5ce7", "#00b894"]
        }
      },
      whaleTail: true,
      whaleTailRainbow: false,   /* 「无」主题语义：无炫彩填充（勾选框可开回） */
      whaleTailMotion: {
        enabled: true,
        action: "random", // "wag" | "sway" | "twist" | "official" | "random"
        randomActions: ["wag", "sway", "twist", "official"],
        speedMode: "tps", // "tps" | "fixed"
        fixedSpeedHz: 0.85,
        officialRecommendedSpeed: true,
        toolSwitchEnabled: true,
        toolSwitchChance: 0.65,
        tpsTiers: [
          { minTps: 0, speedHz: 0.45 },
          { minTps: 15, speedHz: 0.85 },
          { minTps: 40, speedHz: 1.25 },
          { minTps: 80, speedHz: 1.75 },
          { minTps: 150, speedHz: 2.35 }
        ]
      },
    };
  }

  function clampNum(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function loadRotatorConfig() {
    var base = defaultRotatorConfig();
    try {
      var raw = JSON.parse(ls(ZU_ROTATOR_LS_KEY, "null"));
      if (!raw || typeof raw !== "object") return base;
      if (typeof raw.enabled === "boolean") base.enabled = raw.enabled;
      if (raw.labelSource === "phrases" || raw.labelSource === "host") base.labelSource = raw.labelSource;
      base.intervalMs = Math.round(clampNum(raw.intervalMs, 500, 60000, base.intervalMs));
      base.typeSpeedMs = Math.round(clampNum(raw.typeSpeedMs, 0, 200, base.typeSpeedMs));
      base.longAfterMs = Math.round(clampNum(raw.longAfterMs, 5000, 600000, base.longAfterMs));
      if (typeof raw.weightedRandom === "boolean") base.weightedRandom = raw.weightedRandom;
      if (raw.antiRepeat && typeof raw.antiRepeat === "object") {
        base.antiRepeat.recentLimit = Math.round(clampNum(raw.antiRepeat.recentLimit, 0, 50, base.antiRepeat.recentLimit));
        if (typeof raw.antiRepeat.persist === "boolean") base.antiRepeat.persist = raw.antiRepeat.persist;
      }
      if (Array.isArray(raw.enabledPacks)) {
        base.enabledPacks = raw.enabledPacks.filter(function (id) {
          return typeof id === "string" && Object.prototype.hasOwnProperty.call(ZU_ROTATOR_PACK_BY_ID, id);
        });
      }
      if (typeof raw.activePreset === "string" && raw.activePreset) base.activePreset = raw.activePreset;
      if (typeof raw.scheduleEnabled === "boolean") base.scheduleEnabled = raw.scheduleEnabled;
      if (Array.isArray(raw.schedule)) base.schedule = raw.schedule;
      if (raw.customPhrases && typeof raw.customPhrases === "object") {
        ["zh", "en"].forEach(function (loc) {
          if (raw.customPhrases[loc] && typeof raw.customPhrases[loc] === "object") {
            ["thinking", "running", "long"].forEach(function (ph) {
              if (Array.isArray(raw.customPhrases[loc][ph])) base.customPhrases[loc][ph] = raw.customPhrases[loc][ph];
            });
          }
        });
      }
      if (raw.appearance && typeof raw.appearance === "object") {
        var ap = raw.appearance;
        if (ap.theme && Object.prototype.hasOwnProperty.call(ZU_APPEARANCE_THEMES, ap.theme)) base.appearance.theme = ap.theme;   /* 白名单（hasOwnProperty 防原型链旁路）：手改 LS 脏值回落默认，不进配置 */
        base.appearance.fontSizePx = Math.round(clampNum(ap.fontSizePx, 0, 32, base.appearance.fontSizePx));
        if (typeof ap.fontWeight === "string") base.appearance.fontWeight = ap.fontWeight;
        if (typeof ap.glow === "boolean") base.appearance.glow = ap.glow;
        if (typeof ap.glowColor === "string") base.appearance.glowColor = ap.glowColor;
        if (ap.animation === "none" || ap.animation === "breathe" || ap.animation === "glitch") base.appearance.animation = ap.animation;
        if (ap.gradient && typeof ap.gradient === "object") {
          var gr = ap.gradient;
          if (typeof gr.enabled === "boolean") base.appearance.gradient.enabled = gr.enabled;
          if (gr.mode === "auto" || gr.mode === "night" || gr.mode === "day") base.appearance.gradient.mode = gr.mode;
          if (gr.direction === "ltr" || gr.direction === "rtl") base.appearance.gradient.direction = gr.direction;
          base.appearance.gradient.speed = clampNum(gr.speed, 0.5, 20, base.appearance.gradient.speed);
          if (Array.isArray(gr.nightColors) && gr.nightColors.length >= 2) base.appearance.gradient.nightColors = gr.nightColors;
          if (Array.isArray(gr.dayColors) && gr.dayColors.length >= 2) base.appearance.gradient.dayColors = gr.dayColors;
        }
      }
      if (typeof raw.whaleTail === "boolean") base.whaleTail = raw.whaleTail;
      if (typeof raw.whaleTailRainbow === "boolean") base.whaleTailRainbow = raw.whaleTailRainbow;
      if (raw.whaleTailMotion && typeof raw.whaleTailMotion === "object") {
        var wm = raw.whaleTailMotion;
        if (typeof wm.enabled === "boolean") base.whaleTailMotion.enabled = wm.enabled;
        if (wm.action === "wag" || wm.action === "sway" || wm.action === "twist" || wm.action === "official" || wm.action === "random") {
          base.whaleTailMotion.action = wm.action;
        }
        if (Array.isArray(wm.randomActions) && wm.randomActions.length) {
          var validActs = wm.randomActions.filter(function (a) { return a === "wag" || a === "sway" || a === "twist" || a === "official"; });
          if (validActs.length) base.whaleTailMotion.randomActions = validActs;
        }
        if (wm.speedMode === "tps" || wm.speedMode === "fixed") base.whaleTailMotion.speedMode = wm.speedMode;
        base.whaleTailMotion.fixedSpeedHz = clampNum(wm.fixedSpeedHz, 0.1, 4.0, base.whaleTailMotion.fixedSpeedHz);
        if (typeof wm.officialRecommendedSpeed === "boolean") base.whaleTailMotion.officialRecommendedSpeed = wm.officialRecommendedSpeed;
        if (typeof wm.toolSwitchEnabled === "boolean") base.whaleTailMotion.toolSwitchEnabled = wm.toolSwitchEnabled;
        base.whaleTailMotion.toolSwitchChance = clampNum(wm.toolSwitchChance, 0, 1, base.whaleTailMotion.toolSwitchChance);
        if (Array.isArray(wm.tpsTiers) && wm.tpsTiers.length) base.whaleTailMotion.tpsTiers = wm.tpsTiers;
      }
    } catch (e) { }
    return base;
  }

  var rotatorCfg = loadRotatorConfig();
  function saveRotatorConfig() {
    lsSet(ZU_ROTATOR_LS_KEY, JSON.stringify(rotatorCfg));
  }

  /* ---------- 排程与预设解析 ---------- */
  function matchHourWindow(hourWindow, curHour) {
    if (!hourWindow) return true;
    if (Array.isArray(hourWindow) && hourWindow.length === 2) {
      var s = Number(hourWindow[0]), e = Number(hourWindow[1]);
      if (!isFinite(s) || !isFinite(e)) return true;
      return s <= e ? (curHour >= s && curHour < e) : (curHour >= s || curHour < e);
    }
    var m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(hourWindow).trim());
    if (!m) return true;
    var start = parseInt(m[1], 10), end = parseInt(m[2], 10);
    return start <= end ? (curHour >= start && curHour < end) : (curHour >= start || curHour < end);
  }

  function resolveEffectiveRotatorConfig(nowDate) {
    var d = nowDate || new Date();
    var presetId = rotatorCfg.activePreset;
    if (rotatorCfg.scheduleEnabled && Array.isArray(rotatorCfg.schedule)) {
      var day = d.getDay(), hr = d.getHours();
      for (var i = 0; i < rotatorCfg.schedule.length; i++) {
        var rule = rotatorCfg.schedule[i];
        if (!rule || !rule.preset) continue;
        var dayOk = !Array.isArray(rule.days) || !rule.days.length || rule.days.indexOf(day) >= 0;
        var hrOk = matchHourWindow(rule.hours, hr);
        if (dayOk && hrOk) { presetId = rule.preset; break; }
      }
    }
    return { cfg: rotatorCfg, activePresetId: presetId };
  }

  function applyRotatorPreset(presetId) {
    var p = ZU_ROTATOR_BUILTIN_PRESETS[presetId];
    if (!p) return false;
    rotatorCfg.activePreset = presetId;
    if (Array.isArray(p.enabledPacks)) rotatorCfg.enabledPacks = p.enabledPacks.slice();
    if (p.appearance && p.appearance.theme && ZU_APPEARANCE_THEMES[p.appearance.theme]) {
      applyAppearanceThemePreset(p.appearance.theme);
    }
    if (typeof p.whaleTail === "boolean") rotatorCfg.whaleTail = p.whaleTail;
    if (p.whaleTailMotion && typeof p.whaleTailMotion === "object") {
      if (typeof p.whaleTailMotion.enabled === "boolean") rotatorCfg.whaleTailMotion.enabled = p.whaleTailMotion.enabled;
      if (p.whaleTailMotion.action) rotatorCfg.whaleTailMotion.action = p.whaleTailMotion.action;
    }
    saveRotatorConfig();
    return true;
  }

  function applyAppearanceThemePreset(themeId) {
    var th = ZU_APPEARANCE_THEMES[themeId];
    if (!th) return false;
    rotatorCfg.appearance.theme = themeId;
    rotatorCfg.appearance.glow = !!th.glow;
    if (th.glowColor) rotatorCfg.appearance.glowColor = th.glowColor;
    rotatorCfg.appearance.animation = th.animation || "none";
    rotatorCfg.appearance.fontWeight = th.fontWeight || "500";
    if (typeof th.whaleTailRainbow === "boolean") rotatorCfg.whaleTailRainbow = th.whaleTailRainbow;
    if (th.gradient) {
      rotatorCfg.appearance.gradient.enabled = th.gradient.enabled !== false;
      rotatorCfg.appearance.gradient.mode = th.gradient.mode || "auto";
      rotatorCfg.appearance.gradient.speed = th.gradient.speed || 3.2;
      rotatorCfg.appearance.gradient.direction = th.gradient.direction || "ltr";
      if (th.gradient.nightColors) rotatorCfg.appearance.gradient.nightColors = th.gradient.nightColors.slice();
      if (th.gradient.dayColors) rotatorCfg.appearance.gradient.dayColors = th.gradient.dayColors.slice();
    }
    return true;
  }

  /* ---------- 自定义短语行语法解析 (文案 | 权重 | when:... | rarity:...) ---------- */
  function parsePhraseLine(line) {
    var s = String(line || "").trim();
    if (!s || s.charAt(0) === "#") return null;
    var parts = s.split("|").map(function (p) { return p.trim(); });
    var text = parts[0];
    if (!text) return null;
    var item = { text: text, weight: 1 };
    for (var i = 1; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg) continue;
      if (/^\d+(?:\.\d+)?$/.test(seg)) {
        item.weight = clampNum(Number(seg), 0.1, 100, 1);
      } else if (seg.indexOf("rarity:") === 0) {
        item.rarity = clampNum(Number(seg.slice(7)), 0.01, 1, 1);
      } else if (seg.indexOf("when:") === 0) {
        var condStr = seg.slice(5).trim();
        var when = {};
        condStr.split(",").forEach(function (kv) {
          var eq = kv.indexOf("=");
          if (eq < 0) {
            var k0 = kv.trim();
            if (k0 === "tool" || k0 === "retry" || k0 === "pending" || k0 === "firstTurn") when[k0] = true;
          } else {
            var k = kv.slice(0, eq).trim(), v = kv.slice(eq + 1).trim();
            if (v === "true") when[k] = true;
            else if (v === "false") when[k] = false;
            else if (/^\d+$/.test(v) && (k === "retry" || k === "pending")) when[k] = parseInt(v, 10);
            else when[k] = v;
          }
        });
        if (Object.keys(when).length) item.when = when;
      }
    }
    return item;
  }

  function formatPhraseLines(list) {
    if (!Array.isArray(list)) return "";
    return list.map(function (it) {
      if (typeof it === "string") return it;
      if (!it || typeof it.text !== "string") return "";
      var segs = [it.text];
      if (typeof it.weight === "number" && it.weight !== 1) segs.push(String(it.weight));
      if (it.when && typeof it.when === "object") {
        var ws = [];
        for (var k in it.when) {
          if (Object.prototype.hasOwnProperty.call(it.when, k)) ws.push(k + "=" + it.when[k]);
        }
        if (ws.length) segs.push("when:" + ws.join(","));
      }
      if (typeof it.rarity === "number" && it.rarity < 1) segs.push("rarity:" + it.rarity);
      return segs.join(" | ");
    }).filter(Boolean).join("\n");
  }

  /* ---------- 词池合并、条件过滤、洗牌袋防重复与 17 个实时占位符 ---------- */
  function getMergedPhrasePool(phase, lang, nowDate) {
    var loc = lang === "en" ? "en" : "zh";
    var ph = (phase === "thinking" || phase === "long") ? phase : "running";
    var pool = [];
    var enabled = rotatorCfg.enabledPacks || [];
    if (rotatorCfg.scheduleEnabled) {
      var eff = resolveEffectiveRotatorConfig(nowDate);
      var effPreset = eff && eff.activePresetId && ZU_ROTATOR_BUILTIN_PRESETS[eff.activePresetId];
      if (effPreset && Array.isArray(effPreset.enabledPacks) && effPreset.enabledPacks.length) enabled = effPreset.enabledPacks;
    }
    for (var i = 0; i < enabled.length; i++) {
      var pack = ZU_ROTATOR_PACK_BY_ID[enabled[i]];
      if (!pack) continue;
      var locPack = pack.phrases && (pack.phrases[loc] || pack.phrases.zh);
      var arr = locPack && Array.isArray(locPack[ph]) ? locPack[ph] : [];
      for (var j = 0; j < arr.length; j++) {
        var entry = arr[j];
        if (typeof entry === "string") pool.push({ text: entry, weight: 1, pack: enabled[i] });
        else if (entry && typeof entry.text === "string") pool.push(Object.assign({ weight: 1, pack: enabled[i] }, entry));
      }
    }
    var customLoc = rotatorCfg.customPhrases && rotatorCfg.customPhrases[loc];
    var customArr = customLoc && Array.isArray(customLoc[ph]) ? customLoc[ph] : [];
    for (var k = 0; k < customArr.length; k++) {
      var c = customArr[k];
      if (typeof c === "string") {
        var parsed = parsePhraseLine(c);
        if (parsed) pool.push(Object.assign({ pack: "custom" }, parsed));
      } else if (c && typeof c.text === "string") {
        pool.push(Object.assign({ weight: 1, pack: "custom" }, c));
      }
    }
    if (!pool.length) {
      pool.push({
        text: loc === "en"
          ? (ph === "thinking" ? "Thinking deeply ({elapsed})..." : ph === "long" ? "Still working hard ({elapsed})..." : "Generating response ({tps} t/s)...")
          : (ph === "thinking" ? "深度思考中（{elapsed}）…" : ph === "long" ? "长线攻坚中（{elapsed}）…" : "全力生成中（{tps} t/s）…"),
        weight: 1, pack: "fallback"
      });
    }
    return pool;
  }

  function matchesPhraseWhen(when, ctx) {
    if (!when || typeof when !== "object") return true;
    if (when.phase && when.phase !== ctx.phase) return false;
    if (when.tool !== undefined) {
      if (typeof when.tool === "boolean") {
        if (when.tool !== !!ctx.runningToolName) return false;
      } else if (typeof when.tool === "string") {
        if (!ctx.runningToolName || ctx.runningToolName.toLowerCase().indexOf(when.tool.toLowerCase()) < 0) return false;
      }
    }
    if (when.retry !== undefined) {
      if (typeof when.retry === "boolean" && when.retry !== (ctx.retryCount > 0)) return false;
      if (typeof when.retry === "number" && ctx.retryCount < when.retry) return false;
    }
    if (when.pending !== undefined) {
      if (typeof when.pending === "boolean" && when.pending !== (ctx.pendingCount > 0)) return false;
      if (typeof when.pending === "number" && ctx.pendingCount < when.pending) return false;
    }
    if (when.firstTurn !== undefined && !!when.firstTurn !== !!ctx.firstTurn) return false;
    if (when.hour !== undefined && !matchHourWindow(when.hour, ctx.hour)) return false;
    return true;
  }

  var recentPickedRing = [];
  try {
    if (rotatorCfg.antiRepeat && rotatorCfg.antiRepeat.persist) {
      var savedMem = JSON.parse(ls(ZU_ROTATOR_MEM_KEY, "[]"));
      if (Array.isArray(savedMem)) recentPickedRing = savedMem.slice(-50);
    }
  } catch (e) { }

  function pickRotatorPhrase(phase, ctx) {
    var rawPool = getMergedPhrasePool(phase, state.lang, ctx && ctx.now);
    var eligible = rawPool.filter(function (item) {
      if (!matchesPhraseWhen(item.when, ctx)) return false;
      if (typeof item.rarity === "number" && item.rarity > 0 && item.rarity < 1) {
        if (Math.random() > item.rarity) return false;
      }
      return true;
    });
    if (!eligible.length) eligible = rawPool;
    var limit = Math.min(
      (rotatorCfg.antiRepeat && typeof rotatorCfg.antiRepeat.recentLimit === "number") ? rotatorCfg.antiRepeat.recentLimit : 6,
      Math.max(0, eligible.length - 1)
    );
    var filtered = limit > 0 ? eligible.filter(function (it) {
      return recentPickedRing.slice(-limit).indexOf(it.text) < 0;
    }) : eligible;
    if (!filtered.length) filtered = eligible;

    var chosen = filtered[0];
    if (rotatorCfg.weightedRandom) {
      var totalW = 0;
      for (var i = 0; i < filtered.length; i++) totalW += Math.max(0.05, Number(filtered[i].weight) || 1);
      var r = Math.random() * totalW;
      for (var j = 0; j < filtered.length; j++) {
        r -= Math.max(0.05, Number(filtered[j].weight) || 1);
        if (r <= 0) { chosen = filtered[j]; break; }
      }
    } else {
      chosen = filtered[Math.floor(Math.random() * filtered.length)];
    }
    if (chosen && chosen.text) {
      recentPickedRing.push(chosen.text);
      if (recentPickedRing.length > 50) recentPickedRing.shift();
      if (rotatorCfg.antiRepeat && rotatorCfg.antiRepeat.persist) {
        lsSet(ZU_ROTATOR_MEM_KEY, JSON.stringify(recentPickedRing));
      }
    }
    return chosen ? chosen.text : "";
  }

  function formatRotatorElapsed(ms) {
    var sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + "m " + s + "s";
  }

  function formatRotatorPlaceholders(template, ctx) {
    if (!template) return "";
    var now = ctx.now || new Date();
    var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var dateStr = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
    var timeStr = pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
    var phaseLabels = {
      thinking: L("深度思考", "Thinking"),
      running: L("全力输出", "Generating"),
      long: L("长线攻坚", "Deep work")
    };
    var map = {
      elapsed: formatRotatorElapsed(ctx.elapsedMs),
      phase: ctx.phase || "running",
      phaseLabel: phaseLabels[ctx.phase] || phaseLabels.running,
      model: ctx.model || "AI",
      provider: ctx.provider || "ZCode",
      tps: (typeof ctx.tps === "number" && isFinite(ctx.tps) && ctx.tps > 0) ? ctx.tps.toFixed(1) : "—",
      pending: String(ctx.pendingCount || 0),
      tools: String(ctx.toolsCount || 0),
      running: ctx.runningToolVerb || phaseLabels[ctx.phase] || phaseLabels.running,
      retry: String(ctx.retryCount || 0),
      retryMax: String(ctx.retryMax || 3),
      retryProvider: ctx.retryProvider || ctx.provider || "API",
      retryCode: ctx.retryCode || "429",
      detail: ctx.detail || "",
      locale: state.lang === "en" ? "en" : "zh",
      date: dateStr,
      time: timeStr
    };
    return String(template).replace(/\{(elapsed|phase|phaseLabel|model|provider|tps|pending|tools|running|retry|retryMax|retryProvider|retryCode|detail|locale|date|time)\}/g, function (_, k) {
      return map[k] !== undefined ? map[k] : "";
    });
  }

  /* ---------- 外观样式表（日夜自适应流光渐变、6 套主题预设、小鲸鱼尾巴） ---------- */
  var rotatorStyleEl = document.createElement("style");
  rotatorStyleEl.className = "zu-rotator-style";
  function resolveRotatorGradientColors() {
    var gr = rotatorCfg.appearance && rotatorCfg.appearance.gradient;
    if (!gr) return ["#ff6b6b", "#feca57", "#48dbfb", "#ff9ff3", "#54a0ff"];
    var isDark = true;
    try { isDark = document.documentElement.classList.contains("dark"); } catch (e) { }
    var useNight = gr.mode === "night" ? true : gr.mode === "day" ? false : isDark;
    var list = useNight ? gr.nightColors : gr.dayColors;
    return (Array.isArray(list) && list.length >= 2) ? list : ["#ff6b6b", "#feca57", "#48dbfb", "#ff9ff3", "#54a0ff"];
  }

  function updateRotatorStylesheet() {
    var ap = rotatorCfg.appearance || {};
    var gr = ap.gradient || {};
    var colors = resolveRotatorGradientColors();
    var loopColors = colors.concat([colors[0]]).join(",");
    var speed = clampNum(gr.speed, 0.5, 20, 3.2);
    var dir = gr.direction === "rtl" ? "to left" : "to right";
    var fontRule = ap.fontSizePx > 0 ? "font-size:" + ap.fontSizePx + "px!important;" : "";
    var weightRule = ap.fontWeight ? "font-weight:" + ap.fontWeight + "!important;" : "";
    var glowRule = ap.glow ? "filter:drop-shadow(0 0 6px " + (ap.glowColor || "rgba(87,200,255,.45)") + ");" : "";
    var animRule = ap.animation === "breathe"
      ? "animation:zuRotBreathe 2.4s ease-in-out infinite;"
      : ap.animation === "glitch"
      ? "animation:zuRotGlitch 1.8s steps(2,end) infinite;"
      : "";
    var gradCss = gr.enabled !== false
      ? "background-image:linear-gradient(" + dir + "," + loopColors + ")!important;" +
        "background-size:200% auto!important;-webkit-background-clip:text!important;background-clip:text!important;" +
        "color:transparent!important;-webkit-text-fill-color:transparent!important;" +
        "animation:zuRotFlow " + speed + "s linear infinite" + (ap.animation === "breathe" ? ",zuRotBreathe 2.4s ease-in-out infinite" : ap.animation === "glitch" ? ",zuRotGlitch 1.8s steps(2,end) infinite" : "") + "!important;"
      : animRule;

    rotatorStyleEl.textContent =
      "@keyframes zuRotFlow{0%{background-position:0% 50%}100%{background-position:200% 50%}}" +
      "@keyframes zuRotBreathe{0%,100%{opacity:.98;transform:scale(1)}50%{opacity:.72;transform:scale(.99)}}" +
      "@keyframes zuRotGlitch{0%,92%,100%{transform:translate(0,0);opacity:1}94%{transform:translate(-1px,.5px);opacity:.88}96%{transform:translate(1px,-.5px);opacity:.92}98%{transform:translate(-.5px,0);opacity:.85}}" +
      ".zu-rotator-active-label{display:inline-block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;" + fontRule + weightRule + glowRule + gradCss + "transition:opacity .15s ease}" +
      ".zu-whale-tail-wrap{display:inline-flex;align-items:center;justify-content:center;width:18px;height:15px;flex:0 0 18px;vertical-align:middle;cursor:pointer}" +
      ".zu-whale-tail{width:18px;height:15px;display:block;overflow:visible}" +
      (rotatorCfg.whaleTailRainbow
        ? ".zu-whale-tail path{fill:url(#zu-whale-tail-grad)!important}"
        : ".zu-whale-tail path{fill:currentColor!important}") +
      ".zu-settings-section[data-sec='rotator'] .zu-settings-card+.cap{margin-top:16px}" +
      ".zu-rot-pack-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;padding:10px 14px 14px}" +
      ".zu-rot-pack-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:8px;font-size:calc(var(--ui-font-size,14px) - 1px);background:var(--color-hover,rgba(255,255,255,.03))}" +
      ".zu-rot-pack-item label{display:inline-flex;align-items:center;gap:6px;padding:0;flex:1;min-width:0;cursor:pointer}" +
      ".zu-rot-pack-item input[type=checkbox]{margin:0}" +
      ".zu-rot-pack-item small{color:var(--color-foreground-subtle,#8791a3);font-size:11px}" +
      ".zu-rot-pack-preview{margin:0 14px 12px;color:var(--color-foreground-subtle,#8791a3);font-size:calc(var(--ui-font-size,14px) - 2px)}" +
      ".zu-rot-prev-stage{padding:12px 14px 10px;display:flex;align-items:center;gap:10px;min-height:36px}" +
      ".zu-rot-prev-row{display:inline-flex;align-items:center;gap:10px;max-width:100%;overflow:hidden}" +
      /* 用户规格：实时预览钉在设置滚动区底部（.zu-settings-body 是滚动容器，sticky 随滚动
       * 常驻可视底缘、滚到末尾自然落位；比 fixed 免几何换算，自动跟随面板尺寸/热重载）。
       * 底色用面板同款双写（fallback + color-mix --color-card），覆盖住滚过的卡片内容。 */
      ".zu-settings-section[data-sec='rotator'] .zu-rot-prev-fix{position:sticky;bottom:0;z-index:6;margin-top:16px;padding:8px 12px 12px;border-top:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:12px 12px 0 0;background:rgba(19,22,30,.97);background:color-mix(in srgb,var(--color-card,#13161e) 96%,transparent)}" +
      ".zu-rot-textarea{width:calc(100% - 24px);margin:4px 12px 10px;min-height:74px;background:var(--color-input,rgba(0,0,0,.22));border:1px solid var(--color-border,rgba(255,255,255,.12));border-radius:8px;color:inherit;padding:6px 10px;font-family:var(--font-mono,monospace);font-size:calc(var(--ui-font-size,14px) - 2px);resize:vertical;box-sizing:border-box}" +
      ".zu-rot-inline-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--color-border,rgba(255,255,255,.08))}" +
      ".zu-settings .zu-rot-inline-row label{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;margin:0;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:8px;font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-settings .zu-rot-inline-row label input[type=checkbox]{order:0;margin:0}" +
      ".zu-rot-select,.zu-rot-num{background:var(--color-input,rgba(0,0,0,.22));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;color:inherit;padding:3px 8px;font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px)}" +
      ".zu-rot-num{width:76px;text-align:right}" +
      ".zu-rot-btn{background:var(--color-hover,rgba(255,255,255,.08));border:1px solid var(--color-border,rgba(255,255,255,.14));border-radius:6px;color:inherit;padding:4px 10px;font:inherit;font-size:calc(var(--ui-font-size,14px) - 1px);cursor:pointer}" +
      ".zu-rot-btn:hover{background:var(--color-border,rgba(255,255,255,.16))}";
  }
  function ensureRotatorStyleMounted() {
    try {
      if (!rotatorStyleEl.parentElement && document.body) document.body.appendChild(rotatorStyleEl);
    } catch (e) { }
  }
  updateRotatorStylesheet();

  /* ---------- 运行态驱动：短语轮播、打字机、小鲸鱼尾巴动画与双挂载点同步 ---------- */
  var rotatorRuntime = {
    active: false,
    lastPhase: "thinking",
    rawPhrase: "",
    renderedPhrase: "",
    displayedText: "",
    typeChars: [],
    typeIndex: 0,
    lastPickAt: 0,
    lastTypeAt: 0,
    lastToolName: "",
    lastLabelText: "",   /* 我方最后一次写入 loading 标签的文本：区分「宿主改写」与「自己上一帧」 */
    currentTailAction: "wag",
    tailFrameIndex: 0,
    tailBridgeQueue: [],
    lastTailStepAt: 0
  };

  function resolveCurrentTailAction() {
    var wm = rotatorCfg.whaleTailMotion || {};
    var act = wm.action || "wag";
    if (act !== "random") {
      rotatorRuntime.currentTailAction = act;
      return act;
    }
    var pool = Array.isArray(wm.randomActions) && wm.randomActions.length ? wm.randomActions : ["wag", "sway", "twist", "official"];
    if (pool.indexOf(rotatorRuntime.currentTailAction) < 0) {
      rotatorRuntime.currentTailAction = pool[Math.floor(Math.random() * pool.length)] || "wag";
    }
    return rotatorRuntime.currentTailAction;
  }

  function switchWhaleTailAction(nextAction) {
    var curAct = rotatorRuntime.currentTailAction || "wag";
    var curPoses = decodeWhaleTailPoses(curAct);
    var fromPath = curPoses[rotatorRuntime.tailFrameIndex % curPoses.length] || curPoses[0];
    rotatorRuntime.currentTailAction = nextAction;
    rotatorRuntime.tailFrameIndex = 0;
    var nextPoses = decodeWhaleTailPoses(nextAction);
    var toPath = nextPoses[0];
    rotatorRuntime.tailBridgeQueue = whaleTailBridgeFrames(fromPath, toPath).slice(1, -1);
  }

  function currentWhaleTailPath(nowMs, currentTps) {
    var wm = rotatorCfg.whaleTailMotion || {};
    var act = resolveCurrentTailAction();
    var poses = decodeWhaleTailPoses(act);
    if (!poses || !poses.length) return "M0 0 Z";
    if (wm.enabled === false) return poses[0];
    var hz = resolveWhaleTailSpeedHz(wm, currentTps, act);
    var frameIntervalMs = Math.max(12, Math.round(1000 / (hz * poses.length)));
    /* 按 elapsed 一次补齐错过的帧数：tick 被节流/后台限流后不丢步（否则高速档看起来仍慢）。 */
    if (!rotatorRuntime.lastTailStepAt) rotatorRuntime.lastTailStepAt = nowMs;
    var steps = Math.floor((nowMs - rotatorRuntime.lastTailStepAt) / frameIntervalMs);
    if (steps >= 1) {
      rotatorRuntime.lastTailStepAt += steps * frameIntervalMs;
      if (rotatorRuntime.tailBridgeQueue && rotatorRuntime.tailBridgeQueue.length) {
        return rotatorRuntime.tailBridgeQueue.shift();
      }
      rotatorRuntime.tailFrameIndex = (rotatorRuntime.tailFrameIndex + steps) % poses.length;
    }
    return poses[rotatorRuntime.tailFrameIndex % poses.length] || poses[0];
  }

  function whaleTailSvgHtml(pathD) {
    var colors = resolveRotatorGradientColors();
    return '<span class="zu-whale-tail-wrap" aria-hidden="true">' +
      '<svg class="zu-whale-tail" viewBox="20 40 300 240" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="zu-whale-tail-grad" x1="0%" y1="0%" x2="100%" y2="100%">' +
      '<stop offset="0%" stop-color="' + (colors[0] || "#38bdf8") + '"/>' +
      '<stop offset="50%" stop-color="' + (colors[1] || "#a78bfa") + '"/>' +
      '<stop offset="100%" stop-color="' + (colors[2] || colors[0] || "#f472b6") + '"/>' +
      '</linearGradient></defs>' +
      '<path d="' + (pathD || "M0 0 Z") + '"/></svg></span>';
  }

  function restoreChatLoadingRow(row) {
    if (!row) return;
    try {
      var label = row.querySelector(".zcode-loading-label");
      if (label && label.hasAttribute("data-zu-host-label")) {
        label.textContent = label.getAttribute("data-zu-host-label") || "";
        label.removeAttribute("data-zu-host-label");
        label.classList.remove("zu-rotator-active-label");
      }
      var pixelGrid = row.querySelector("span.grid");
      if (pixelGrid && pixelGrid.style.display === "none") pixelGrid.style.display = "";
      var clockEl = row.querySelector(".font-mono");
      if (clockEl && clockEl.style && clockEl.style.display === "none") clockEl.style.display = "";
      row.querySelectorAll(".zu-whale-tail-wrap,.zu-rot-spinner-ring,.zu-rot-spinner-bar").forEach(function (el) { el.remove(); });
      row.removeAttribute("data-zusage-rotator-slot");
    } catch (e) { }
  }

  function restoreAllChatLoadingRows() {
    try {
      document.querySelectorAll('[data-testid="chat-loading"],[data-zusage-rotator-slot]').forEach(restoreChatLoadingRow);
    } catch (e) { }
  }

  function syncChatMountSurface(active, displayStr, tailPath) {
    var wantChat = rotatorCfg.enabled;
    if (!wantChat || !active) {
      restoreAllChatLoadingRows();
      return;
    }
    try {
      var rows = document.querySelectorAll('[data-testid="chat-loading"]');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        row.setAttribute("data-zusage-rotator-slot", "1");
        var label = row.querySelector(".zcode-loading-label");
        if (label) {
          var curText = label.textContent || "";
          if (!label.hasAttribute("data-zu-host-label")) {
            label.setAttribute("data-zu-host-label", curText);
            rotatorRuntime.lastLabelText = curText;
          } else if (curText && curText !== rotatorRuntime.lastLabelText && curText !== (label.getAttribute("data-zu-host-label") || "")) {
            /* 宿主中途改写同节点文案（≠我方最后写入、≠已存快照）才重拍——打字机逐帧文本以
             * lastLabelText 基准排除，不误拍退化快照 */
            label.setAttribute("data-zu-host-label", curText);
            rotatorRuntime.lastLabelText = curText;
          }
          if (rotatorCfg.labelSource === "phrases" && displayStr) {
            if (label.textContent !== displayStr) { label.textContent = displayStr; rotatorRuntime.lastLabelText = displayStr; }
          } else if (rotatorCfg.labelSource === "host" && label.hasAttribute("data-zu-host-label")) {
            var hostText = label.getAttribute("data-zu-host-label") || "";
            if (hostText && label.textContent !== hostText) { label.textContent = hostText; rotatorRuntime.lastLabelText = hostText; }
          }
          label.classList.add("zu-rotator-active-label");
        }
        /* 用户规格：轮播文案已内嵌耗时（{elapsed}），宿主自带的独立耗时格隐藏避免双计时；
         * labelSource=host（保留原生文案）时耗时格照常显示。 */
        var clockEl = row.querySelector(".font-mono");
        if (clockEl && clockEl.style) clockEl.style.display = (rotatorCfg.labelSource === "phrases" && displayStr) ? "none" : "";
        var pixelGrid = row.querySelector("span.grid");
        var existingTail = row.querySelector(".zu-whale-tail-wrap");
        if (rotatorCfg.whaleTail) {
          if (pixelGrid) pixelGrid.style.display = "none";
          if (!existingTail) {
            var temp = document.createElement("div");
            temp.innerHTML = whaleTailSvgHtml(tailPath);
            existingTail = temp.firstChild;
            row.insertBefore(existingTail, row.firstChild);
          } else {
            var pathEl = existingTail.querySelector("path");
            if (pathEl && pathEl.getAttribute("d") !== tailPath) pathEl.setAttribute("d", tailPath);
          }
        } else {
          if (existingTail) existingTail.remove();
          if (pixelGrid && pixelGrid.style.display === "none") pixelGrid.style.display = "";
        }
      }
    } catch (e) { }
  }

  function restoreBarSpeedCell(mainEl) {
    if (!mainEl) return;
    try {
      mainEl.querySelectorAll(".zu-rotator-bar,.zu-whale-tail-wrap,.zu-rot-spinner-ring,.zu-rot-spinner-bar").forEach(function (el) { el.remove(); });
      mainEl.querySelectorAll(".it").forEach(function (itEl) {
        itEl.classList.remove("zu-it-rotator", "zu-flow-num");
        var ico = itEl.querySelector("svg.ico,.ico");
        if (ico && ico.style && ico.style.display === "none") ico.style.display = "";
      });
    } catch (e) { }
  }

  function collectRotatorLiveContext() {
    var nowMs = Date.now();
    var nowDate = new Date(nowMs);
    var activeStats = null, model = "", provider = "ZCode", sess = null;
    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i];
      var st = inst.rotatorStats && inst.rotatorStats();
      if (st && st.stats && !st.stats.complete) {
        activeStats = st.stats;
        model = st.model || model;
        provider = st.provider || provider;
        sess = st.session || sess;
        break;
      }
      if (st && !model && st.model) {
        model = st.model;
        provider = st.provider || provider;
        sess = st.session || sess;
      }
    }
    var domChatLoading = null;
    try { domChatLoading = document.querySelector('[data-testid="chat-loading"]'); } catch (e) { }
    var isRunning = !!(activeStats && !activeStats.complete) || !!domChatLoading;
    var startedAt = (activeStats && activeStats.startedAt) || (rotatorRuntime.turnStartedAt) || nowMs;
    if (isRunning && !rotatorRuntime.turnStartedAt) {
      rotatorRuntime.turnStartedAt = (activeStats && activeStats.startedAt) || nowMs;
      startedAt = rotatorRuntime.turnStartedAt;
    } else if (!isRunning) {
      rotatorRuntime.turnStartedAt = 0;
    }
    var elapsedMs = isRunning ? Math.max(0, nowMs - startedAt) : 0;
    var phase = "running";
    if (isRunning) {
      if (elapsedMs >= (rotatorCfg.longAfterMs || 30000)) phase = "long";
      else if ((activeStats && activeStats.phase === "thinking" && !activeStats.runningTool && !activeStats.characterRate) || elapsedMs < 15000) phase = "thinking";
    }
    else if ((activeStats && activeStats.phase === "thinking" && !activeStats.runningTool && !activeStats.characterRate) || elapsedMs < 15000) phase = "thinking";

    var tps = 0;
    if (activeStats && typeof activeStats.characterRate === "number" && activeStats.characterRate > 0) {
      tps = activeStats.characterRate / 2;
    } else if (sess && typeof sess.avg_tps === "number" && sess.avg_tps > 0) {
      tps = sess.avg_tps;
    } else if (state.data && Array.isArray(state.data.recent) && state.data.recent[0] && state.data.recent[0].avg_tps > 0) {
      tps = state.data.recent[0].avg_tps;
    }
    var runningToolName = activeStats && activeStats.runningTool && activeStats.runningTool.name ? activeStats.runningTool.name : "";
    var runningToolVerb = runningToolName ? zuToolVerb(runningToolName) : "";

    return {
      now: nowDate,
      nowMs: nowMs,
      active: isRunning,
      phase: phase,
      elapsedMs: elapsedMs,
      model: model || (state.data && state.data.session && state.data.session.model) || "AI",
      provider: provider || "ZCode",
      tps: tps,
      runningToolName: runningToolName,
      runningToolVerb: runningToolVerb,
      toolsCount: (sess && sess.tool_calls) || 0,
      retryCount: (sess && sess.retries) || 0,
      retryMax: 3,
      pendingCount: 0,
      firstTurn: !sess || (sess.turns || 0) <= 1,
      hour: nowDate.getHours(),
      detail: runningToolVerb
    };
  }

  function forceNextRotatorPhrase(ctxOverride) {
    var ctx = ctxOverride || collectRotatorLiveContext();
    var raw = pickRotatorPhrase(ctx.phase, ctx);
    rotatorRuntime.rawPhrase = raw;
    rotatorRuntime.renderedPhrase = formatRotatorPlaceholders(raw, ctx);
    rotatorRuntime.typeChars = Array.from(rotatorRuntime.renderedPhrase);
    if (!rotatorCfg.typeSpeedMs || rotatorCfg.typeSpeedMs <= 0) {
      rotatorRuntime.typeIndex = rotatorRuntime.typeChars.length;
      rotatorRuntime.displayedText = rotatorRuntime.renderedPhrase;
    } else {
      rotatorRuntime.typeIndex = Math.min(1, rotatorRuntime.typeChars.length);
      rotatorRuntime.displayedText = rotatorRuntime.typeChars.slice(0, rotatorRuntime.typeIndex).join("");
    }
    rotatorRuntime.lastPickAt = ctx.nowMs;
    rotatorRuntime.lastTypeAt = ctx.nowMs;
    return rotatorRuntime.renderedPhrase;
  }

  function rotatorMasterTick() {
    if (stale()) return;
    try {
      ensureRotatorStyleMounted();
      if (!rotatorCfg.enabled) {
        /* 关闭态只做遗留 DOM 还原（设置变更尾部有直调 tick 兜底），跳过上下文收集；
         * 无活跃 loading 行时复位计时起点，防「运行中禁用→新轮→再启用」沿用旧起点虚高 {elapsed} */
        restoreAllChatLoadingRows();
        try { if (!document.querySelector('[data-testid="chat-loading"]')) rotatorRuntime.turnStartedAt = 0; } catch (eReset) { }
        return;
      }
      var ctx = collectRotatorLiveContext();
      var effectiveActive = !!ctx.active;
      var wasActive = rotatorRuntime.active;
      rotatorRuntime.active = effectiveActive;

      // Check tool switch for whale tail random action
      if (ctx.runningToolName && ctx.runningToolName !== rotatorRuntime.lastToolName) {
        rotatorRuntime.lastToolName = ctx.runningToolName;
        var wm = rotatorCfg.whaleTailMotion || {};
        if (rotatorCfg.whaleTail && wm.enabled && wm.action === "random" && wm.toolSwitchEnabled) {
          if (Math.random() < (typeof wm.toolSwitchChance === "number" ? wm.toolSwitchChance : 0.65)) {
            var pool = Array.isArray(wm.randomActions) && wm.randomActions.length ? wm.randomActions : ["wag", "sway", "twist", "official"];
            var candidates = pool.filter(function (a) { return a !== rotatorRuntime.currentTailAction; });
            var nextAct = (candidates.length ? candidates : pool)[Math.floor(Math.random() * (candidates.length || pool.length))] || "wag";
            switchWhaleTailAction(nextAct);
          }
        }
      } else if (!ctx.runningToolName) {
        rotatorRuntime.lastToolName = "";
      }

      if (effectiveActive) {
        var phaseChanged = ctx.phase !== rotatorRuntime.lastPhase;
        rotatorRuntime.lastPhase = ctx.phase;
        if (!wasActive || phaseChanged || !rotatorRuntime.rawPhrase || (ctx.nowMs - rotatorRuntime.lastPickAt >= rotatorCfg.intervalMs)) {
          forceNextRotatorPhrase(ctx);
        } else {
          // Live update dynamic placeholders ({elapsed}, {tps}) once typing completes
          var reRendered = formatRotatorPlaceholders(rotatorRuntime.rawPhrase, ctx);
          if (rotatorRuntime.typeIndex >= rotatorRuntime.typeChars.length) {
            rotatorRuntime.renderedPhrase = reRendered;
            rotatorRuntime.displayedText = reRendered;
          } else if (rotatorCfg.typeSpeedMs > 0 && ctx.nowMs - rotatorRuntime.lastTypeAt >= rotatorCfg.typeSpeedMs) {
            var steps = Math.max(1, Math.floor((ctx.nowMs - rotatorRuntime.lastTypeAt) / rotatorCfg.typeSpeedMs));
            rotatorRuntime.typeIndex = Math.min(rotatorRuntime.typeChars.length, rotatorRuntime.typeIndex + steps);
            rotatorRuntime.displayedText = rotatorRuntime.typeChars.slice(0, rotatorRuntime.typeIndex).join("");
            rotatorRuntime.lastTypeAt = ctx.nowMs;
          }
        }
      }

      var tailPath = rotatorCfg.whaleTail ? currentWhaleTailPath(ctx.nowMs, ctx.tps) : "";
      syncChatMountSurface(ctx.active, rotatorRuntime.displayedText, tailPath);
    } catch (e) {
      FATAL.rotatorErr = String((e && e.stack) || e);
    }
  }

  var lastRotatorFrameAt = 0;
  function rotatorFrameStep() {
    var now = Date.now();
    if (now - lastRotatorFrameAt < 65) return;
    lastRotatorFrameAt = now;
    rotatorMasterTick();
  }
  /* v268 移植时 rotatorFrameStep 未接线：打字机永久停在首字（症状=只显示「长」）、鲸鱼帧只能靠
   * ~1.5s 一次的 render 重建推进（视觉=完全静止，用户误判为压缩损坏）。这里用 65ms setInterval
   * 驱动——不用 rAF（被遮挡窗口 rAF 冻结是本项目实证纪律，v276）；stale 自清 +
   * disposeOverlay→zuRotatorDisposeAll 清除，热重载旧代际定时器下个 tick 自杀。 */
  var rotatorTimer = null;
  function ensureRotatorTimer() {
    if (rotatorTimer) return;
    rotatorTimer = setInterval(function () {
      if (stale()) { clearInterval(rotatorTimer); rotatorTimer = null; return; }
      rotatorFrameStep();
    }, 65);
  }
  ensureRotatorTimer();

  /* ---------- 底部实时预览引擎（用户规格：预览固定到轮播设置最底部并联动全部设置）----------
   * 独立于真实运行态（rotatorRuntime 不被预览污染）：自带 65ms 定时器、打字机、换条节奏、
   * 鲸鱼帧与 {elapsed} 走表；样式复用全局 .zu-rotator-active-label / .zu-whale-tail CSS，
   * updateRotatorStylesheet 在每次设置变更后重生成 → 主题/渐变/动效/炫彩自动联动。
   * 面板关闭（元素脱离 DOM）下一拍自清定时器；dispose 同步清除。 */
  var rotPreview = {
    timer: null, panelEl: null, secEl: null,
    raw: "", rendered: "", displayed: "",
    chars: [], typeIndex: 0, pickAt: 0, typeAt: 0,
    frameIdx: 0, lastFrameAt: 0, startedAt: 0, labelEl: null, pathEl: null
  };   /* packId 已随定点预览移除 */
  function ensureRotPreviewTimer() {
    if (rotPreview.timer) return;
    rotPreview.timer = setInterval(rotPreviewTick, 65);
  }
  function rotPreviewCtx(now) {
    var d = new Date(now);
    return {
      now: d, nowMs: now, active: true, phase: "running",
      elapsedMs: Math.max(0, now - (rotPreview.startedAt || now)),
      model: (state.data && state.data.session && state.data.session.model) || "DeepSeek-V3",
      provider: "ZCode", tps: 42.5,
      runningToolName: "Bash",
      runningToolVerb: (typeof zuToolVerb === "function" ? zuToolVerb("Bash") : "执行命令"),
      toolsCount: 3, retryCount: 0, retryMax: 3, pendingCount: 0, firstTurn: false,
      hour: d.getHours(), detail: ""
    };
  }
  function rotPreviewPoolPick(ctx) {
    return pickRotatorPhrase(ctx.phase, ctx);   /* 词包定点预览已随「预览」按钮移除，统一走开启词包词池 */
  }
  function renderRotPreview() {
    var el = rotPreview.panelEl;
    if (!el) return;
    var stage = el.querySelector(".zu-rot-prev-stage");
    if (!stage) return;
    var esc3 = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    var showWhale = !!rotatorCfg.whaleTail;
    var path = "";
    if (showWhale) {
      var poses = decodeWhaleTailPoses(rotatorRuntime.currentTailAction || "wag");
      path = poses && poses.length ? poses[0] : "M0 0 Z";
    }
    rotPreview.frameIdx = 0;
    rotPreview.lastFrameAt = 0;
    rotPreview.startedAt = rotPreview.startedAt || Date.now();
    rotPreview.raw = "";
    rotPreview.pickAt = 0;   // 重建后下一拍立即按新设置取短语
    stage.innerHTML = '<div class="zu-rot-prev-row">' + (showWhale ? whaleTailSvgHtml(path) : "") +
      '<span class="zcode-loading-label text-ui-base font-medium zu-rotator-active-label">' + esc3(rotPreview.displayed || "…") + "</span></div>";
    rotPreview.labelEl = stage.querySelector(".zu-rotator-active-label");
    rotPreview.pathEl = showWhale ? stage.querySelector(".zu-whale-tail path") : null;
  }
  function rotPreviewTick() {
    try {
      FATAL.rotPrevTick = (FATAL.rotPrevTick || 0) + 1;
      var pv = rotPreview;
      var el = pv.panelEl;
      if (!el || !el.isConnected) {
        if (pv.timer) { clearInterval(pv.timer); pv.timer = null; }
        return;
      }
      /* 可见性判据不能用 offsetParent——fixed 面板（.panel{position:fixed}）的后代在 Chromium
       * 上 offsetParent 恒为 null，会把每一拍都拦掉（实机 diag rotPrevGate 实证）。改用
       * getClientRects 空列表判 display:none；VM 桩无此方法时视为可见。 */
      var hiddenNow = !!(pv.secEl && pv.secEl.hidden);
      if (!hiddenNow && el.classList && !el.classList.contains("open")) hiddenNow = true;   /* closeSettings 只摘 .open，面板节点常挂 body——isConnected 判不出关闭态 */
      if (!hiddenNow && el.getClientRects) hiddenNow = el.getClientRects().length === 0;
      FATAL.rotPrevGate = [!!el, el && el.isConnected, hiddenNow].join(",");
      if (hiddenNow) return;   // 面板收起/切走分区时静默跳过
      var now = Date.now();
      pv.startedAt = pv.startedAt || now;
      /* 鲸鱼帧推进先于 host 分支：labelSource=host 时真实 loading 行的鲸鱼照常摆动，预览必须一致。 */
      if (pv.pathEl) {
        var poses = decodeWhaleTailPoses(rotatorRuntime.currentTailAction || "wag");
        if (poses && poses.length) {
          var hz = resolveWhaleTailSpeedHz(rotatorCfg.whaleTailMotion || {}, 0, rotatorRuntime.currentTailAction || "wag");
          var iv = Math.max(12, Math.round(1000 / (hz * poses.length)));
          if (!pv.lastFrameAt) pv.lastFrameAt = now;
          var st2 = Math.floor((now - pv.lastFrameAt) / iv);
          if (st2 >= 1) {
            pv.lastFrameAt += st2 * iv;
            pv.frameIdx = (pv.frameIdx + st2) % poses.length;
            pv.pathEl.setAttribute("d", poses[pv.frameIdx]);
          }
        }
      }
      var ctx = rotPreviewCtx(now);
      if (rotatorCfg.labelSource === "host") {
        pv.displayed = L("工作中...", "Working...");
        if (pv.labelEl && pv.labelEl.textContent !== pv.displayed) pv.labelEl.textContent = pv.displayed;
        return;
      }
      if (!pv.raw || now - pv.pickAt >= (rotatorCfg.intervalMs || 3500)) {
        pv.raw = rotPreviewPoolPick(ctx);
        pv.rendered = formatRotatorPlaceholders(pv.raw, ctx);
        pv.chars = Array.from(pv.rendered);
        pv.typeIndex = (!rotatorCfg.typeSpeedMs || rotatorCfg.typeSpeedMs <= 0) ? pv.chars.length : Math.min(1, pv.chars.length);
        pv.displayed = pv.chars.slice(0, pv.typeIndex).join("");
        pv.pickAt = now;
        pv.typeAt = now;
      } else if (pv.typeIndex < pv.chars.length) {
        if (rotatorCfg.typeSpeedMs > 0 && now - pv.typeAt >= rotatorCfg.typeSpeedMs) {
          var steps = Math.max(1, Math.floor((now - pv.typeAt) / rotatorCfg.typeSpeedMs));
          pv.typeIndex = Math.min(pv.chars.length, pv.typeIndex + steps);
          pv.displayed = pv.chars.slice(0, pv.typeIndex).join("");
          pv.typeAt = now;
        }
      } else {
        var re = formatRotatorPlaceholders(pv.raw, ctx);
        if (re !== pv.rendered) { pv.rendered = re; pv.chars = Array.from(re); pv.displayed = re; }
      }
      if (pv.labelEl && pv.labelEl.textContent !== pv.displayed) pv.labelEl.textContent = pv.displayed;
    } catch (e) { FATAL.rotPrevErr = String((e && e.stack) || e); }
  }

  /* ---------- 设置面板「状态轮播」(data-sec="rotator") UI 与事件委托 ---------- */
  function zuRotatorSectionHtml(isOpen) {
    ensureRotatorStyleMounted();
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    var settingRow = function (input, title, note) { return "<label>" + input + "<span>" + title + "<em>" + note + "</em></span></label>"; };
    var open = isOpen !== undefined ? !!isOpen : (state && state.settingsSec === "rotator");
    var loc = state.lang === "en" ? "en" : "zh";
    var packChecks = ZU_ROTATOR_PACK_META.map(function (pm) {
      var pack = ZU_ROTATOR_PACK_BY_ID[pm.id];
      var locPack = pack && pack.phrases && (pack.phrases[loc] || pack.phrases.zh);
      var cnt = locPack ? ((locPack.thinking ? locPack.thinking.length : 0) + (locPack.running ? locPack.running.length : 0) + (locPack.long ? locPack.long.length : 0)) : 0;
      var checked = (rotatorCfg.enabledPacks || []).indexOf(pm.id) >= 0 ? " checked" : "";
      return '<div class="zu-rot-pack-item"><label><input type="checkbox" class="zu-rot-pack-cb" data-pack="' + pm.id + '"' + checked + '> ' +
        esc(L(pm.zh, pm.en)) + '</label><small>' + cnt + '</small></div>';
    }).join("");
    var customThink = formatPhraseLines(rotatorCfg.customPhrases && rotatorCfg.customPhrases[loc] && rotatorCfg.customPhrases[loc].thinking);
    var customRun = formatPhraseLines(rotatorCfg.customPhrases && rotatorCfg.customPhrases[loc] && rotatorCfg.customPhrases[loc].running);
    var customLong = formatPhraseLines(rotatorCfg.customPhrases && rotatorCfg.customPhrases[loc] && rotatorCfg.customPhrases[loc].long);

    return '<section class="zu-settings-section" data-sec="rotator"' + (open ? "" : " hidden") + '>' +
      '<div class="cap">' + L("状态轮播与小鲸鱼动画", "Status Rotator & Whale Tail") + '</div>' +
      '<div class="zu-settings-card">' +
        settingRow('<input type="checkbox" class="zu-rot-enable">', L("启用状态轮播", "Enable status rotator"), L("在模型思考/生成/长耗时期间于消息流 Loading 行轮播趣味状态短语，支持 17 种实时统计占位符（如 {elapsed}、{tps}、{model}）。状态条速度格保持原生外观。", "Rotates witty status phrases in the chat loading row with 17 live placeholders ({elapsed}, {tps}, {model}, etc.). The status bar speed cell keeps its native look.")) +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("文案来源", "Label source") + '</span>' +
          '<select class="zu-rot-select zu-rot-source">' +
            '<option value="phrases">' + L("趣味词库轮播", "Phrase packs") + '</option>' +
            '<option value="host">' + L("保留宿主原生文案（仅套用外观与鲸鱼尾巴）", "Host label (appearance & whale tail only)") + '</option>' +
          '</select>' +
          '<span>' + L("轮播间隔(ms)", "Interval (ms)") + '</span>' +
          '<input type="number" class="zu-rot-num zu-rot-interval" min="500" max="60000" step="100">' +
          '<span>' + L("打字机(ms/字)", "Typewriter (ms)") + '</span>' +
          '<input type="number" class="zu-rot-num zu-rot-typespeed" min="0" max="200" step="5">' +
        '</div>' +
      '</div>' +

      '<div class="cap">' + L("DeepSeek 小鲸鱼摇尾巴 SVG 帧动画", "DeepSeek Whale Tail SVG Frame Animation") + '</div>' +
      '<div class="zu-settings-card">' +
        settingRow('<input type="checkbox" class="zu-rot-whaletail">', L("显示小鲸鱼尾巴图标", "Show whale tail SVG icon"), L("在消息流 Loading 行以 DeepSeek 小鲸鱼尾巴 SVG 动画替换原生加载像素点（150 帧流畅循环 + 6 帧轮廓桥接过渡，体积压缩至 ~76KB）。", "Replaces the loading pixels in the chat loading row with the 150-frame DeepSeek whale tail SVG animation (~76KB compressed with 6-frame contour morphing).")) +
        settingRow('<input type="checkbox" class="zu-rot-whalerainbow">', L("尾巴炫彩流光填充", "Rainbow gradient fill on whale tail"), L("开启后小鲸鱼尾巴跟随流光渐变色；关闭后跟随当前文字颜色。", "Fills the whale tail with the active flowing gradient; off uses currentColor.")) +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("摆尾动作", "Tail motion") + '</span>' +
          '<select class="zu-rot-select zu-rot-tail-action">' +
            '<option value="random">' + L("随机切换（含 6 帧平滑过渡）", "Random (with 6-frame smooth morph)") + '</option>' +
            '<option value="wag">' + L("翻转摆尾 (wag)", "Flip wag (wag)") + '</option>' +
            '<option value="sway">' + L("左右摆尾 (sway)", "Side sway (sway)") + '</option>' +
            '<option value="twist">' + L("扭转摆尾 (twist)", "3D twist (twist)") + '</option>' +
            '<option value="official">' + L("官方原版晃动 (official)", "Official wobble (official)") + '</option>' +
          '</select>' +
          '<span>' + L("摆尾调速", "Speed mode") + '</span>' +
          '<select class="zu-rot-select zu-rot-tail-speedmode">' +
            '<option value="tps">' + L("随实时 TPS 档位加速", "Scale with live TPS") + '</option>' +
            '<option value="fixed">' + L("固定频率 (Hz)", "Fixed frequency (Hz)") + '</option>' +
          '</select>' +
          '<span>' + L("频率(Hz)", "Hz") + '</span>' +
          '<input type="number" class="zu-rot-num zu-rot-fixedhz" min="0.1" max="4" step="0.05">' +
          '<label><input type="checkbox" class="zu-rot-tail-toolswitch"> ' + L("工具调用时随机换动作", "Switch action on tool call") + '</label>' +
        '</div>' +
      '</div>' +

      '<div class="cap">' + L("流光外观与主题预设", "Flowing Gradient & Appearance Themes") + '</div>' +
      '<div class="zu-settings-card">' +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("外观主题", "Theme preset") + '</span>' +
          '<select class="zu-rot-select zu-rot-theme">' +
            Object.keys(ZU_APPEARANCE_THEMES).map(function (k) {
              var t = ZU_APPEARANCE_THEMES[k];
              return '<option value="' + k + '">' + esc(L(t.zh, t.en)) + '</option>';
            }).join("") +
          '</select>' +
          '<label><input type="checkbox" class="zu-rot-grad-enable"> ' + L("启用日夜自适应流光渐变", "Day/Night adaptive flowing gradient") + '</label>' +
          '<span>' + L("流光方向", "Direction") + '</span>' +
          '<select class="zu-rot-select zu-rot-grad-dir">' +
            '<option value="ltr">' + L("从左到右", "Left to right") + '</option>' +
            '<option value="rtl">' + L("从右到左", "Right to left") + '</option>' +
          '</select>' +
          '<span>' + L("动效", "Animation") + '</span>' +
          '<select class="zu-rot-select zu-rot-anim">' +
            '<option value="none">' + L("无", "None") + '</option>' +
            '<option value="breathe">' + L("呼吸脉冲", "Breathe") + '</option>' +
            '<option value="glitch">' + L("故障抖动", "Glitch") + '</option>' +
          '</select>' +
        '</div>' +
      '</div>' +

      '<div class="cap">' + L("14 个内置词包与排程预设", "14 Built-in Phrase Packs & Presets") + '</div>' +
      '<div class="zu-settings-card">' +
        '<div class="zu-rot-inline-row">' +
          '<span>' + L("场景预设", "Scene preset") + '</span>' +
          '<select class="zu-rot-select zu-rot-preset">' +
            Object.keys(ZU_ROTATOR_BUILTIN_PRESETS).map(function (k) {
              var pr = ZU_ROTATOR_BUILTIN_PRESETS[k];
              return '<option value="' + k + '">' + esc(L(pr.zh, pr.en)) + '</option>';
            }).join("") +
          '</select>' +
          '<button type="button" class="zu-rot-btn zu-rot-packs-all">' + L("全选词包", "Select all") + '</button>' +
          '<button type="button" class="zu-rot-btn zu-rot-packs-default">' + L("恢复默认词包", "Default packs") + '</button>' +
          '<label><input type="checkbox" class="zu-rot-schedule-enable"> ' + L("按工作时段/深夜自动切换预设", "Auto-switch preset by schedule") + '</label>' +
        '</div>' +
        '<div class="zu-rot-pack-grid">' + packChecks + '</div>' +
      '</div>' +

      '<div class="cap">' + L("自定义短语（每行一条，支持：文案 | 权重 | when:tool=Bash | rarity:0.5）", "Custom Phrases (one per line: text | weight | when:tool=Bash | rarity:0.5)") + '</div>' +
      '<div class="zu-settings-card">' +
        '<div class="pnote">' + L("思考阶段 (thinking)", "Thinking phase") + '</div>' +
        '<textarea class="zu-rot-textarea zu-rot-custom-thinking" placeholder="' + L("正在思考人生 ({elapsed})… | 2", "Thinking deeply ({elapsed})… | 2") + '">' + esc(customThink) + '</textarea>' +
        '<div class="pnote">' + L("运行阶段 (running)", "Running phase") + '</div>' +
        '<textarea class="zu-rot-textarea zu-rot-custom-running" placeholder="' + L("全力输出中 {tps} t/s · {running} | 2", "Streaming at {tps} t/s · {running} | 2") + '">' + esc(customRun) + '</textarea>' +
        '<div class="pnote">' + L("长耗时阶段 (long)", "Long turn phase") + '</div>' +
        '<textarea class="zu-rot-textarea zu-rot-custom-long" placeholder="' + L("已经苦战 {elapsed}，稳住能赢！ | 3", "Still working after {elapsed}, hang tight! | 3") + '">' + esc(customLong) + '</textarea>' +
      '</div>' +

      '<div class="zu-rot-prev-fix">' +
      '<div class="zu-settings-card">' +
        '<div class="zu-rot-prev-stage"></div>' +
        '<div class="zu-rot-pack-preview" data-zu-rot-preview hidden></div>' +
      '</div>' +
      '</div>' +
    '</section>';
  }

  function zuRotatorSyncPanel(panelEl) {
    if (!panelEl) return;
    ensureRotatorStyleMounted();
    var q = function (sel) { return panelEl.querySelector(sel); };
    var setCb = function (sel, val) { var el = q(sel); if (el) el.checked = !!val; };
    var setVal = function (sel, val) { var el = q(sel); if (el) el.value = String(val); };

    setCb(".zu-rot-enable", rotatorCfg.enabled);
    setVal(".zu-rot-source", rotatorCfg.labelSource);
    setVal(".zu-rot-interval", rotatorCfg.intervalMs);
    setVal(".zu-rot-typespeed", rotatorCfg.typeSpeedMs);

    setCb(".zu-rot-whaletail", rotatorCfg.whaleTail);
    setCb(".zu-rot-whalerainbow", rotatorCfg.whaleTailRainbow);
    setVal(".zu-rot-tail-action", rotatorCfg.whaleTailMotion.action);
    setVal(".zu-rot-tail-speedmode", rotatorCfg.whaleTailMotion.speedMode);
    setVal(".zu-rot-fixedhz", rotatorCfg.whaleTailMotion.fixedSpeedHz);
    setCb(".zu-rot-tail-toolswitch", rotatorCfg.whaleTailMotion.toolSwitchEnabled);

    setVal(".zu-rot-theme", rotatorCfg.appearance.theme);
    setCb(".zu-rot-grad-enable", rotatorCfg.appearance.gradient.enabled);
    setVal(".zu-rot-grad-dir", rotatorCfg.appearance.gradient.direction);
    setVal(".zu-rot-anim", rotatorCfg.appearance.animation);

    setVal(".zu-rot-preset", rotatorCfg.activePreset);
    setCb(".zu-rot-schedule-enable", rotatorCfg.scheduleEnabled);

    panelEl.querySelectorAll(".zu-rot-pack-cb").forEach(function (cb) {
      cb.checked = (rotatorCfg.enabledPacks || []).indexOf(cb.getAttribute("data-pack")) >= 0;
    });
    /* 实时预览接线：syncPanel 在早期 buildPanel（boot 预构建，issue #55）与每次设置变更后都会被
     * 调用——定时器只在轮播分区为当前分区时存活（state.settingsSec 是分区可见性事实源：
     * activateSettingsSec 单一出口维护，boot 预构建期默认 display → 不启动），避免常驻空转
     * 定时器（lifecycle 计数契约）。 */
    if (!panelEl.classList || panelEl.classList.contains("open")) {   /* 多实例 renderAll 广播不得把 panelEl 翻到关闭态面板 */
      rotPreview.panelEl = panelEl;
      rotPreview.secEl = panelEl.querySelector('[data-sec="rotator"]');
    }
    if (state.settingsSec === "rotator") {
      ensureRotPreviewTimer();
      renderRotPreview();
    } else if (rotPreview.timer) {
      clearInterval(rotPreview.timer);
      rotPreview.timer = null;
    }
  }

  function zuRotatorPanelClick(e, panelEl) {
    var t = e.target;
    if (!t || !t.closest) return false;
    if (t.closest(".zu-rot-packs-all")) {
      rotatorCfg.enabledPacks = ZU_ROTATOR_PACK_META.map(function (m) { return m.id; });
      saveRotatorConfig();
      zuRotatorSyncPanel(panelEl);
      forceNextRotatorPhrase();
      return true;
    }
    if (t.closest(".zu-rot-packs-default")) {
      rotatorCfg.enabledPacks = ZU_ROTATOR_PACK_META.map(function (m) { return m.id; });
      saveRotatorConfig();
      zuRotatorSyncPanel(panelEl);
      forceNextRotatorPhrase();
      return true;
    }
    return false;
  }

  function zuRotatorPanelChange(e, panelEl) {
    var t = e.target;
    if (!t || !t.classList) return false;
    var cl = t.classList;
    if (cl.contains("zu-rot-enable")) { rotatorCfg.enabled = !!t.checked; }
    else if (cl.contains("zu-rot-source")) { rotatorCfg.labelSource = t.value; }
    else if (cl.contains("zu-rot-interval")) { rotatorCfg.intervalMs = clampNum(t.value, 500, 60000, 3500); }
    else if (cl.contains("zu-rot-typespeed")) { rotatorCfg.typeSpeedMs = clampNum(t.value, 0, 200, 28); }
    else if (cl.contains("zu-rot-whaletail")) { rotatorCfg.whaleTail = !!t.checked; }
    else if (cl.contains("zu-rot-whalerainbow")) { rotatorCfg.whaleTailRainbow = !!t.checked; }
    else if (cl.contains("zu-rot-tail-action")) {
      rotatorCfg.whaleTailMotion.action = t.value;
      if (t.value !== "random") switchWhaleTailAction(t.value);
    }
    else if (cl.contains("zu-rot-tail-speedmode")) { rotatorCfg.whaleTailMotion.speedMode = t.value; }
    else if (cl.contains("zu-rot-fixedhz")) { rotatorCfg.whaleTailMotion.fixedSpeedHz = clampNum(t.value, 0.1, 4, 0.85); }
    else if (cl.contains("zu-rot-tail-toolswitch")) { rotatorCfg.whaleTailMotion.toolSwitchEnabled = !!t.checked; }
    else if (cl.contains("zu-rot-theme")) {
      applyAppearanceThemePreset(t.value);
      zuRotatorSyncPanel(panelEl);
    }
    else if (cl.contains("zu-rot-grad-enable")) { rotatorCfg.appearance.gradient.enabled = !!t.checked; }
    else if (cl.contains("zu-rot-grad-dir")) { rotatorCfg.appearance.gradient.direction = t.value; }
    else if (cl.contains("zu-rot-anim")) { rotatorCfg.appearance.animation = t.value; }
    else if (cl.contains("zu-rot-preset")) {
      applyRotatorPreset(t.value);
      zuRotatorSyncPanel(panelEl);
    }
    else if (cl.contains("zu-rot-schedule-enable")) { rotatorCfg.scheduleEnabled = !!t.checked; }
    else if (cl.contains("zu-rot-pack-cb")) {
      var pid = t.getAttribute("data-pack");
      var list = (rotatorCfg.enabledPacks || []).slice();
      var idx = list.indexOf(pid);
      if (t.checked && idx < 0) list.push(pid);
      else if (!t.checked && idx >= 0) list.splice(idx, 1);
      rotatorCfg.enabledPacks = list;
    }
    else if (cl.contains("zu-rot-custom-thinking") || cl.contains("zu-rot-custom-running") || cl.contains("zu-rot-custom-long")) {
      var loc = state.lang === "en" ? "en" : "zh";
      var ph = cl.contains("zu-rot-custom-thinking") ? "thinking" : cl.contains("zu-rot-custom-long") ? "long" : "running";
      rotatorCfg.customPhrases[loc][ph] = String(t.value || "").split(/\r?\n/).map(parsePhraseLine).filter(Boolean);
    } else {
      return false;
    }
    saveRotatorConfig();
    updateRotatorStylesheet();
    rotatorMasterTick();
    /* 全设置联动：任何变更（开关/下拉/数字/textarea）都即时重渲染底部实时预览。 */
    rotPreview.panelEl = panelEl;
    renderRotPreview();
    return true;
  }

  function zuRotatorDisposeAll() {
    if (rotatorTimer) { clearInterval(rotatorTimer); rotatorTimer = null; }
    if (rotPreview.timer) { clearInterval(rotPreview.timer); rotPreview.timer = null; }
    rotPreview.panelEl = null;
    rotPreview.secEl = null;
    restoreAllChatLoadingRows();
    try {
      document.querySelectorAll(".zusage-root .zu-main").forEach(restoreBarSpeedCell);
    } catch (e) { }
    try { if (rotatorStyleEl && rotatorStyleEl.remove) rotatorStyleEl.remove(); } catch (e) { }
    /* 弹幕引擎已移除；选择器保留用于清理旧版本可能残留的弹幕层/速度格注入节点。 */
    try {
      document.querySelectorAll(".zu-rotator-bar,.zu-whale-tail-wrap,.zu-rotator-danmaku,.zu-rotator-style").forEach(function (el) { el.remove(); });
    } catch (e) { }
    if (window.__zusageRotatorDispose === zuRotatorDisposeAll) delete window.__zusageRotatorDispose;
    if (window.__zusageStatusRotator) delete window.__zusageStatusRotator;
  }
  window.__zusageRotatorDispose = zuRotatorDisposeAll;

  window.__zusageStatusRotator = {
    getConfig: function () { return JSON.parse(JSON.stringify(rotatorCfg)); },
    setConfig: function (patch) {
      if (!patch || typeof patch !== "object") return false;
      Object.assign(rotatorCfg, patch);
      saveRotatorConfig();
      rotatorCfg = loadRotatorConfig();
      updateRotatorStylesheet();
      rotatorMasterTick();
      renderRotPreview();
      return true;
    },
    nextPhrase: function () { return forceNextRotatorPhrase(); },
    decodeWhaleTailPoses: decodeWhaleTailPoses,
    whaleTailBridgeFrames: whaleTailBridgeFrames,
    parsePhraseLine: parsePhraseLine,
    formatPlaceholders: formatRotatorPlaceholders,
    tailDataBytes: function () { return JSON.stringify(ZU_WHALE_TAIL_DATA).length; }
  };

  /* 设置页（MCP 配置等）内的编辑框不是聊天输入框：设置是同窗口覆盖层，激活时
   * 聊天视图保持挂载、仅 opacity-0+inert 视觉遮蔽——v61 幽灵判定管的是聊天壳，
   * 设置层是其兄弟节点、够不着。设置框架内（settings-page 根 testid 或
   * content/panel 双 frame 标记，三层标记并集排除、跨宿主版本覆盖面最大）的
   * JSON/环境变量文本框（MCP 表单展开「环境变量（可选）」后的 rows=4 文本框）
   * 落在视口下半部，会被协调器当聊天输入框派发，条冒在设置页底部（实测 bug）。
   * 带设置框架标记的候选一律不派发；聊天流（composer/权限面板/批准框）不在
   * 设置框架内，行为不受影响。 */
  function inSettingsView(el) {
    try { return !!(el.closest && el.closest('[data-testid="settings-page"],[data-settings-content-frame],[data-settings-panel-frame]')); } catch (e) { return false; }
  }
  function coordinator() {
    /* 协调器（v61.1）：扫描主文档里全部下半屏可见输入框，按 pane 键（data-pane-id，
     * 无属性回退 "auto"）分组派发给实例；一个 pane 一条，pane 消失对应条自藏。 */
    function paneKeyOf(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute("data-pane-id")) return p.getAttribute("data-pane-id") || "auto";
      }
      return "auto";
    }
    function sessIdOf(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute("data-session-id")) return p.getAttribute("data-session-id") || "";
      }
      return "";
    }
    /* v174：辅助对话（划词 side chat）候选识别。它复用主会话 SessionPane 组件：无外层
     * data-pane-id（paneKeyOf 落 "auto"、会被下方 v171 守卫丢弃），但会话根节点 testid
     * 恒为 "v4-session-pane-" + 宿主 tabId（tabId 以 selection-side-chat: 开头，三段
     * encodeURIComponent，3.17.1 asar 实证）；桥部署时同节点另写 data-zusage-pane-id=
     * tabId。返回宿主 tabId（同时作实例键与桥 scope 校验键），非辅助候选返回 ""。
     * 只认宿主自带标记，不从标题/最近邻猜身份。
     * v258：宿主 testid 与桥属性双缺席（表外客户端版本）时按 fiber 兜底——同文副本在
     * fiberSideIdOf（detOwnerOf 侧），两个源码切片测试的 eval 区间不相交，须同步改。 */
    function sidePaneKeyOf(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (!p.hasAttribute) continue;
        if (p.hasAttribute("data-zusage-pane-id")) {
          var zpid = p.getAttribute("data-zusage-pane-id");
          if (zpid && String(zpid).indexOf("selection-side-chat:") === 0 &&
              p.getAttribute("data-zusage-scope-version") === "1") return zpid;
        }
        if (p.hasAttribute("data-testid")) {
          var tid = String(p.getAttribute("data-testid"));
          if (tid.indexOf("v4-session-pane-selection-side-chat:") === 0) return tid.slice("v4-session-pane-".length);
        }
        if (p.getAttribute("data-zusage-scope-version") !== "1" && p.hasAttribute("data-session-id")) {
          var fiberHit = fiberSideIdOfPane(p);
          if (fiberHit) return fiberHit;
        }
      }
      return "";
    }
    /* v258：fiberSideIdOf 的 coordinator 局部同文副本（port-patches 切片 eval 边界）。
     * 与模块级版本唯一的差异是无外部引用，逻辑须与 fiberSideIdOf 逐字同规。 */
    function fiberSideIdOfPane(el) {
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
    var SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
    function candidateVisible(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        try {
          if (p.inert) return false;
          var cs = getComputedStyle(p);
          if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return false;
        } catch (e) { }   // 异常环境放行：track 的幽灵/遮挡判定仍会兜底
      }
      return true;
    }
    function tick() {
      if (stale()) return;
      try {
        var best = {};
        document.querySelectorAll(SEL).forEach(function (el) {
          if (el.closest && el.closest('[role="dialog"]')) return;   // v62：弹窗内的编辑框不是聊天输入框，不派实例（issue #9）
          if (inSettingsView(el)) return;   // 设置页（MCP 配置等）的编辑框不是聊天输入框，不派实例
          var r = el.getBoundingClientRect();
          if (!(r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < innerHeight)) return;
          if (!candidateVisible(el)) return;
          var nativeComposer = el.getAttribute && el.getAttribute("data-testid") === "v4-composer-input";
          try { nativeComposer = nativeComposer || !!el.closest('[data-testid^="v4-pane-shell-"]'); } catch (e) { }
          var k = sidePaneKeyOf(el) || paneKeyOf(el), attached = false;
          for (var n = 0; n < instances.length; n++) {
            if (instances[n].pid === k && instances[n].ownsComposer && instances[n].ownsComposer(el)) { attached = true; break; }
          }
          if (!nativeComposer && !attached && r.top < innerHeight * 0.45) return;
          if (!best[k] || (k === "auto" && nativeComposer && !best[k].nativeComposer) ||
              (nativeComposer === !!best[k].nativeComposer && r.top > best[k].top))
            best[k] = { el: el, top: r.top, nativeComposer: nativeComposer };
        });
        var keys = Object.keys(best);
        if (!keys.length) { best["auto"] = { el: null, top: 0 }; keys = ["auto"]; }   // shadow/iframe 兜底
        /* issue #147（社区 @Mc-GrowlR 报告并给出方案）：窗口里已有真实 pane 键（工作区分栏
         * 都带 data-pane-id）时，"auto" 键一律丢弃——无 pane 键的候选只可能是同窗子面
         * （3.17.x 划词 side chat，常驻挂载、收起后幽灵 composer 仍在），不是独立分栏；
         * 老宿主无 data-pane-id 时全部候选均为 auto（单键），单实例行为不变。
         * v174：辅助对话已在上方按宿主 tabId（selection-side-chat:…）独立成键，不再落
         * auto；此处丢弃的只剩真正无法识别的候选，防重守卫本身不变。 */
        if (keys.indexOf("auto") >= 0 && keys.length > 1 &&
            (!best.auto.nativeComposer || keys.some(function (k) { return k !== "auto" && k.indexOf("selection-side-chat:") !== 0; }))) {
          delete best["auto"];
          keys = Object.keys(best);
        }
        // 独立选择四主一辅，优先保留仍可见的既有实例，避免 DOM 顺序引发重建。
        var selected = [], mainCount = 0, sideCount = 0;
        instances.map(function (inst) { return inst.pid; }).concat(keys).forEach(function (k) {
          if (keys.indexOf(k) < 0 || selected.indexOf(k) >= 0) return;
          if (k.indexOf("selection-side-chat:") === 0) {
            if (sideCount >= 1) return;
            sideCount++;
          } else {
            if (mainCount >= 4) return;
            mainCount++;
          }
          selected.push(k);
        });
        keys = selected;
        instances = instances.filter(function (inst) {
          if (keys.indexOf(inst.pid) >= 0) return true;
          inst.dispose();
          return false;
        });
        keys.forEach(function (k) {
          var inst = null;
          for (var i = 0; i < instances.length; i++) if (instances[i].pid === k) { inst = instances[i]; break; }
          if (!inst) inst = spawnInstance(k, nextSlot++);
          if (inst) inst.attach(best[k].el, sessIdOf(best[k].el));
        });
        refreshWants();
        reportQuotaSelections();
        FATAL.insts = instances.map(function (a) { return a.pid + "=" + (a.getSid() ? a.getSid().slice(-8) : "-"); }).join(" | ");
      } catch (e) { FATAL.coordErr = String((e && e.stack) || e); }
    }
    tick();
    coordinatorTimer = setInterval(tick, 600);
  }







