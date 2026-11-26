  /* ---------- v384 生成速度 Tooltip V3：模型级速度统计核心（spd3 纯函数，无 DOM） ----------
   * 数据契约 = specs/speed-tooltip-v3.md §1：轮表 msl 条目扩为 [mIdx,out,ms,n] 四元组
   * （旧二元组兼容）+ 帧级 mkeys 身份表；新顶层 speed_days 全历史按日聚合（生产端
   * 本地日界、550 天上限）。v457（spec §25）起轮级可选键 tk / 日桶第 7 位 tk 携带每模型
   * Token 总消耗，解包为行 tok 与模型分量 tt（未知为 null，筛选重算据此保持精确）。
   * v479（spec §28）起 sel.mon 携带本月视图所选月，an.mon 给出有效月份与导航下界；
   * 月窗右端收在月末（历史月不得把之后的月份算进来），全部范围在轮表覆盖不住所选月
   * 时改用 speed_days 日行池（混合数据源）。
   * 本分片只做解包/筛选状态机/聚合/管线，是 view/charts/heat
   * （spec §5-§7，另分片实现）唯一的数据上游：消费入口 spd3Analyze(h, sd, sel) → an。
   * 口径铁律（spec §0）：速度恒 = Σ有效输出 ÷ Σ有效生成窗口，绝不逐轮/逐模型算术
   * 平均，绝不用「模型输出 ÷ 整轮耗时」充当模型速度。
   * 只引用更早分片的存活符号（V3 集成后仍在）：L / SPD_L / TPS_BANDS / tpsBand /
   * tpsBandText / spdEsc / spdNum / spd2 / spdDate / spdFull / spdLabel / spdBucket /
   * spdNextBucket / spdShort / spdRangeText / spdCompactRange / SPD_RANGES /
   * SPD_PERIODS / SPD_BARS_MAX。V2 专属函数（spdAnalyze/spdChartHTML/spdRebuildOr/
   * speedSegsOf 等）随 V3 上线删除，本分片一律不引用；其余依赖一律本地 spd3 版本，
   * 保证本文件可独立 node --check、可单独切片进 VM 夹具。 */
  /* SPD_V3_CORE_BEGIN */
  /* ==================== ① 轮表解包（spec §1.1/§1.3）：msl 新旧条目兼容 ==================== */
  /* msl 条目 → 模型分量。二元组 [mIdx,out]（旧帧，无模型级窗口）与四元组
   * [mIdx,out,ms,n]（v384 起，ms=该模型在本轮的 Σ有效生成窗口、n=已完成请求数）
   * 兼容；日行五元组多出的 tn 取 p[4]（轮表条目无此位 → 0，聚合按每行 1 轮计）。
   * 身份键（spec §1.3）：mkeys 在场且条目为非空字符串时 key=mkeys[idx]
   * （provider_id\x1fmodel_id，provider 缺失为空段），否则退化为 "n\x1f"+name 按名称
   * 识别。返回 null = 条目非法（只跳该条目，不弃整轮——纪律同 spdUnpackRaw）。 */
  function spd3ModelOf(p, mnames, mkeys) {
    /* 名字只拒绝 null/undefined（空串是合法显示名缺失）：兜底「未知模型」继续用
     * mkeys/名称键识别身份，不再把空名整条丢弃（minor2） */
    if (!p || typeof p[0] !== "number" || p[0] < 0 || mnames[p[0]] == null || !(spdNum(p[1]) > 0)) return null;
    var name = mnames[p[0]] || SPD_L("未知模型", "Unknown model"), key, mpid = "", mmid = name;
    if (mkeys && typeof mkeys[p[0]] === "string" && mkeys[p[0]]) {
      key = mkeys[p[0]];
      var cut = key.indexOf("\x1f");
      if (cut >= 0) { mpid = key.slice(0, cut); mmid = key.slice(cut + 1); }
    } else {
      key = "n\x1f" + name;
    }
    return { key: key, name: name, pid: mpid, mid: mmid, o: spdNum(p[1]),
      ms: (typeof p[2] === "number" && isFinite(p[2]) && p[2] > 0) ? p[2] : 0,
      n: (typeof p[3] === "number" && isFinite(p[3]) && p[3] > 0) ? p[3] : 0,
      tn: (typeof p[4] === "number" && isFinite(p[4]) && p[4] > 0) ? p[4] : 0,
      tt: null };   /* tt=该模型在本行内的 Token 总消耗（v457，解包层按 tk 填；null=未知） */
  }
  /* v457（spec §25）：Token 数只认非负有限数，其余一律 null——未知 ≠ 0，未知不出 token 行 */
  function spd3TokNum(x) {
    return (typeof x === "number" && isFinite(x) && x >= 0) ? x : null;
  }
  /* 轮表解包：t 是相对上一轮完成时刻的 delta（升序还原），s/msl 是索引表下标。
   * t 缺失/非法整帧拒绝（fail-closed，minor3）：t 是 delta 累加基准，跳行续跑会让
   * 后续所有轮的时间整体位移，宁可整体降级 V1 也不出错位统计；其余核心字段
   * （out/ms/s）非法仍整轮丢弃，不让畸形远端/旧快照污染统计。
   * 行携带 msAvail（任一模型分量 ms>0）= 该轮有模型级速度数据；全帧都没有时管线
   * 判定降级模式（spec §4 msAvail=false）。 */
  function spd3UnpackRaw(h) {
    var sids = h.sids, snames = h.snames, pids = h.pids || [];
    var mnames = Array.isArray(h.mnames) ? h.mnames : [];
    /* 索引表一律 Array.isArray 校验：字符串等有 .length 的鸭子类型会把下标访问
     * 变成字符索引（mnames='GLM-A' 时 mnames[0]==='G'），不能放行 */
    var mkeys = Array.isArray(h.mkeys) ? h.mkeys : null;
    var out = [], prev = 0;
    for (var i = 0; i < h.turns.length; i++) {
      var r = h.turns[i];
      if (!r || typeof r.t !== "number" || !isFinite(r.t)) return null;
      var t = prev + r.t;
      prev = t;
      var outv = spdNum(r.out), ms = spdNum(r.ms);
      if (!(outv > 0 && ms > 0) || !(typeof r.s === "number" && sids[r.s])) continue;
      var models = [], msAvail = false, tokArr = Array.isArray(r.tk) ? r.tk : null;
      if (r.msl && typeof r.msl.length === "number") {
        for (var j = 0; j < r.msl.length; j++) {
          var m = spd3ModelOf(r.msl[j], mnames, mkeys);
          if (!m) continue;
          if (m.ms > 0) msAvail = true;
          /* tk 与 msl 按原始下标对齐：无效条目跳过，tk 下标照用 j（不错位） */
          if (tokArr) m.tt = spd3TokNum(tokArr[j]);
          models.push(m);
        }
      }
      var meta = pids[r.s] || ["", ""];
      var ti = spdNum(r.i), to = spdNum(r.o);
      /* 行级 tok 与日行同一严格判定（v457）：i/o 任一缺失或非法 → tok 未知，不把残缺的
       * i+o 当合计显示；行上的 i/o 字段沿用既有 spdNum 口径不变（v253 起恒成对产出） */
      var tok = (spd3TokNum(r.i) !== null && spd3TokNum(r.o) !== null && ti + to > 0) ? ti + to : null;
      /* 无 tk 的轮表行 = 恰一个入列模型且其 token 恰为轮级合计（v457 生产端契约；
       * 旧帧的单模型轮同取轮级 i+o，多模型轮各模型 tt 保持未知） */
      if (!tokArr && models.length === 1 && tok !== null) models[0].tt = tok;
      out.push({ s: r.s, sid: sids[r.s], sname: snames[r.s] || sids[r.s],
        pid: meta[0] || "", pname: meta[1] || sids[r.s],
        t: t, b: spdNum(r.b) || t, out: outv, ms: ms,
        i: ti, o: to, n: spdNum(r.n), models: models, msAvail: msAvail, tok: tok,
        c: (typeof r.c === "number" && isFinite(r.c)) ? r.c : null, cf: !!r.cf });
    }
    return { turns: out, sid: h.sid || "", source: h.source || "", truncated: !!h.truncated };
  }
  /* 解包结果按帧对象引用缓存（纪律同 SPD_UNPACK_MEMO）：updateLive 心跳/悬停重编会
   * 反复经 spd3Analyze 解包同一份轮表（6000 轮约 5ms/次）。同一帧内引用恒定；新帧是
   * 新 JSON 对象自然失效，引用相等即内容相等，零陈旧风险。轮数守卫防同一对象被原地
   * 追加后命中陈旧结果。结果只读：spd3Analyze 只 filter/slice 出新数组、不改行对象。 */
  var SPD3_UNPACK_MEMO = new WeakMap();
  function spd3Unpack(h) {
    if (!h || !Array.isArray(h.turns) || !h.sids || !h.snames) return null;
    var memo = SPD3_UNPACK_MEMO.get(h);
    if (memo && memo.n === h.turns.length) return memo.res;
    var res = spd3UnpackRaw(h);
    SPD3_UNPACK_MEMO.set(h, { n: h.turns.length, res: res });
    return res;
  }
  /* ==================== ② speed_days 解包（spec §1.2/§1.3） ====================
   * days[i] = start 起第 i 个本地自然日（连续；日界由 Python 生产端按本地日历保证，
   * 解包同样按本地日历 new Date(y,m,d+i) 推进，DST 日 23h/25h 与生产端天然对齐，
   * 见 spd3UnpackDaysRaw 注释）。空日=[0,0,0,0,0,0] 跳过不产行，渲染层自己铺空格。
   * 日行字段与轮表行对齐同形（b=t0、t=当日最后一毫秒、c=null），使
   * spd3Aggregate/筛选重算无需分行处理；i/o 自 v457 起由第 7 位 tk 补齐（旧帧无 tk →
   * i=o=0、tok=null）；sid/pid 留空 = 日行无会话身份，范围筛选
   * 天然只命中轮表行；t0 即日历零点，供日桶键直接使用（与轮表行 spdBucket 同源）。 */
  function spd3UnpackDaysRaw(sd) {
    var mnames = Array.isArray(sd.mnames) ? sd.mnames : [];
    var mkeys = Array.isArray(sd.mkeys) ? sd.mkeys : null;
    /* 日界从 start 的日历日期本地推进（new Date(y,m,d+i)，B1/S10）：DST 日 23h/25h
     * 天然对齐 Python 生产端。固定 864e5 步长在跨 DST 帧上把日桶键推离日历零点
     * （每次切换 ±1h 累计）：热力格按日历零点查 byDay 命中不了漂移键、合并接缝
     * （endMs 漂到覆盖末日 23:00）还会把末日内晚轮双重计数。t1=次日日历零点，
     * t=t1-1（约定不变）。rows[].t0 与轮表行 spdBucket 本地零点同源，聚合/热力
     * 无需再分行处理。 */
    var d0 = new Date(sd.start);
    var y0 = d0.getFullYear(), mo0 = d0.getMonth(), dd0 = d0.getDate();
    var rows = [];
    for (var i = 0; i < sd.days.length; i++) {
      var e = sd.days[i];
      if (!e || typeof e.length !== "number") continue;
      var outv = spdNum(e[0]), ms = spdNum(e[1]);
      if (!(outv > 0 && ms > 0)) continue;   /* 空日（或全无效日）不产行 */
      var t0 = new Date(y0, mo0, dd0 + i).getTime();
      var t1 = new Date(y0, mo0, dd0 + i + 1).getTime();
      /* v457：第 7 位 tk=[当日输入, 当日输出, 与 msl 五元组逐条对齐的每模型 token]。
       * 旧帧无第 7 位 → tok=null（未知，渲染端不出 token 行，绝不估数）。
       * 每模型段不是每天都带（spec §8 帧体积预算）：恰一个入列模型且 tk 只含合计 →
       * 该模型 token=合计（这类日在筛选下只有全选或整行剔除两态，推导值不参与显示）；
       * 多模型日的 tk 只含合计（早于近 N 天）→ 各模型 tt 未知，筛选后不出行 */
      var tkd = (Array.isArray(e[6]) && e[6].length >= 2) ? e[6] : null;
      /* 合计段与每模型段同一严格判定（spd3TokNum）：非法 → 整行 tok 未知（i/o 记 0），
       * 不把非法当 0 后照常显示一个被低估的合计 */
      var tin = tkd ? spd3TokNum(tkd[0]) : null, tout = tkd ? spd3TokNum(tkd[1]) : null;
      var tokKnown = tin != null && tout != null;
      var models = [], msAvail = false;
      if (e[5] && typeof e[5].length === "number") {
        /* v384 S1 打平形态：日行 msl 为五元组平铺序列 [mIdx,out,ms,n,tn, ...]
         * （生产端 cap=8）；逐元素嗅探兼容旧嵌套形态（数组=嵌套条目步长 1，
         * 数字=打平步长 5）。残缺尾部（不足一个五元组）丢弃不越界读。步长恒 5——
         * 新字段一律挂第 7 位 tk，不得改步长（旧渲染端按 5 解析）。 */
        var ml3 = e[5];
        for (var j = 0, k3 = 0; j < ml3.length;) {
          var entry3, step3;
          if (Array.isArray(ml3[j])) { entry3 = ml3[j]; step3 = 1; }
          else if (typeof ml3[j] === "number" && j + 5 <= ml3.length) { entry3 = ml3.slice(j, j + 5); step3 = 5; }
          else break;
          j += step3;
          var m = spd3ModelOf(entry3, mnames, mkeys);
          /* tk 的每模型段按条目序号对齐：无效条目也占号（跳过但 k3 照加）；越界=未知 */
          if (m && tkd && tkd.length > 2) m.tt = spd3TokNum(tkd[2 + k3]);
          k3++;
          if (!m) continue;
          if (m.ms > 0) msAvail = true;
          models.push(m);
        }
      }
      if (tokKnown && tkd.length === 2 && models.length === 1) models[0].tt = tin + tout;
      rows.push({ t0: t0, t1: t1, t: t1 - 1, b: t0,
        out: outv, ms: ms, n: spdNum(e[2]), turns: spdNum(e[3]), capped: !!e[4],
        models: models, msAvail: msAvail, sid: "", pid: "", sname: "", pname: "",
        i: tokKnown ? tin : 0, o: tokKnown ? tout : 0, tok: tokKnown ? tin + tout : null, c: null, cf: false });
    }
    /* end=覆盖末日次日日历零点（合并接缝界，B1/S10）：日行 t 恒 < end，晚于 end 的
     * 轮表行才由 spd3Analyze 并入，无重叠无遗漏。 */
    return { rows: rows, days: sd.days.length, start: sd.start,
      end: new Date(y0, mo0, dd0 + sd.days.length).getTime(), truncated: !!sd.truncated };
  }
  /* 日桶解包同样按 sd 对象引用缓存，天数守卫防原地追加（纪律同 spd3Unpack）。 */
  var SPD3_DAYS_MEMO = new WeakMap();
  function spd3UnpackDays(sd) {
    /* days 必须是真数组：字符串等有 .length 的鸭子类型会通过长度检查却不产行
     * （'x'.length===1、'x'[0] 不是数组被静默跳过），宁可整帧拒绝 */
    if (!sd || sd.v !== 1 || !Array.isArray(sd.days) ||
        typeof sd.start !== "number" || !isFinite(sd.start)) return null;
    var memo = SPD3_DAYS_MEMO.get(sd);
    if (memo && memo.n === sd.days.length) return memo.res;
    var res = spd3UnpackDaysRaw(sd);
    SPD3_DAYS_MEMO.set(sd, { n: sd.days.length, res: res });
    return res;
  }
  /* ==================== ③ 模型身份与颜色（spec §2） ====================
   * 固定 10 色调色板（深浅主题共用，QA 验证过对比度）：纯哈希取色，跨范围/跨时间
   * Tab/跨筛选稳定，与选择顺序和数据池无关；冲突靠名称/悬停明细区分。速度色阶仍
   * 唯一来自 TPS_BANDS，两套颜色语义不混用（PRD 7.3）。 */
  var SPD3_PALETTE = ["#4ea1ff", "#34d399", "#a78bfa", "#fbbf24", "#22d3ee",
    "#f472b6", "#a3e635", "#fb923c", "#2dd4bf", "#f87171"];
  /* FNV-1a 32 位哈希：offset basis 2166136261、FNV 质数 16777619，逐 UTF-16 码元
   * 「先异或后乘质数」（Math.imul 保持 32 位乘法语义），>>>0 归一化为无符号后对
   * 调色板长度取模。同 key 恒同色。 */
  function spd3Color(key) {
    var s = String(key == null ? "" : key), hsh = 2166136261;
    for (var i = 0; i < s.length; i++) hsh = Math.imul(hsh ^ s.charCodeAt(i), 16777619) >>> 0;
    return SPD3_PALETTE[hsh % SPD3_PALETTE.length];
  }
  /* 模型条目的稳定身份键：key 在场直接用（解包已保证），兜底按名称退化（spec §1.3），
   * 供渲染层在 chips/图例/色点间统一取键，不假设条目一定来自 spd3 解包。 */
  function spd3ModelKey(m) {
    return m && typeof m.key === "string" && m.key ? m.key : "n\x1f" + ((m && m.name) || "");
  }
  /* ==================== ④ 筛选状态机（spec §3） ====================
   * 实例状态 filt = {mode:"auto"|"sel", keys:[...]|null}：auto=跟随数据池全部模型；
   * sel=显式集合（可为空=明确空态，不假装全选）。全部动作原地改属性并返回同引用，
   * 不整体换对象（时间 Tab 切换保留筛选，会话切换与 speedSel 一同重置由调用方做）。
   * 作用域=实例；新范围中无数据的选中模型保留选中，由 spd3Analyze 产出 selMissing
   * 供 chips 标「无数据」。 */
  function spd3FilterAuto() { return { mode: "auto", keys: null }; }
  /* auto 下首次点击某模型=「只看该模型」（最小惊讶）；sel 下点击=toggle 该 key，
   * 清空到 0 个时保持 sel 空数组=显式空态。 */
  function spd3FilterToggle(f, key) {
    if (!f) return f;
    if (f.mode !== "sel" || !f.keys) { f.mode = "sel"; f.keys = [key]; return f; }
    var i = f.keys.indexOf(key);
    if (i >= 0) f.keys.splice(i, 1); else f.keys.push(key);
    return f;
  }
  /* 显式只看一组模型（弹出层全选/搜索勾选批量用）；重复 key 去重保持签名稳定 */
  function spd3FilterOnly(f, keys) {
    if (!f) return f;
    var out = [];
    for (var i = 0; i < (keys || []).length; i++) if (out.indexOf(keys[i]) < 0) out.push(keys[i]);
    f.mode = "sel"; f.keys = out;
    return f;
  }
  /* 恢复默认=auto（spec §3 reset） */
  function spd3FilterAll(f) {
    if (!f) return f;
    f.mode = "auto"; f.keys = null;
    return f;
  }
  /* 显式空态（sel 且 0 个选中）≠ auto 全选 */
  function spd3FilterIsEmpty(f) {
    return !!f && f.mode === "sel" && (!f.keys || !f.keys.length);
  }
  /* 稳定签名串（spec §8 缓存键与 §7 横滚记忆键 filterSig）：keys 排序消除 toggle
   * 顺序差，集合相等即同签名。显式空态（sel 且 0 个）签名 "sel:" 不得与 auto 塌缩
   * 同串——两者池语义不同（空 vs 全部），memo/横滚键会互相碰撞。分隔符用 \x1e
   * （记录分隔符）——key 内部已含 \x1f（provider\x1fmodel），再用 \x1f 连接会产生
   * 歧义碰撞。 */
  function spd3FilterSig(f) {
    if (!f || f.mode !== "sel" || !f.keys) return "auto";
    return "sel:" + f.keys.slice().sort().join("\x1e");
  }
  /* ==================== ⑤ 聚合器（spec §0 口径铁律） ====================
   * 统一聚合器：任何桶/柱/overall 都走 Σ有效输出 ÷ Σ有效生成窗口，绝不逐轮/逐模型
   * 算术平均。每模型分量按 key 累计 {name,o,ms,n}，模型级速度 tps 在输出时就地算出
   * （ms=0 的分量 tps=null = 该模型无窗口数据，绝不拿整轮窗口冒充）。轮表行/日行
   * 混合池（all+sd 合并）无需分行处理——日行解包时已对齐 b/t 同形。models 不截断：
   * 模型数受生产端 msl ≤12 上限约束，悬停合成明细需要完整组成（V2 的 slice(0,8)
   * 截断废弃，withNames 全量名单纪律保留）。 */
  function spd3Aggregate(rows, withNames) {
    var out = 0, ms = 0, i = 0, o = 0, n = 0, turns = 0, models = {}, c = 0, priced = false, costFull = true;
    var t0 = Infinity, t1 = 0, last = 0;
    /* v457：tok=桶内各行 Token 总消耗之和；任一行未知即整桶未知（null，不出 token 行） */
    var tok = 0, tokFull = true;
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      out += r.out; ms += r.ms; i += r.i; o += r.o; n += r.n;
      if (r.tok === null || r.tok === undefined) tokFull = false; else tok += r.tok;
      /* 日行 turns=当日 distinct 轮数（解包带），轮表行每行恒 1 轮 */
      turns += (typeof r.turns === "number" && isFinite(r.turns) && r.turns > 0) ? r.turns : 1;
      if (r.b < t0) t0 = r.b;
      if (r.t > t1) t1 = r.t;
      if (r.t >= last) last = r.t;
      for (var j = 0; j < r.models.length; j++) {
        var m = r.models[j], e = models[m.key];
        if (!e) e = models[m.key] = { key: m.key, name: m.name, pid: m.pid || "", mid: m.mid || "", o: 0, ms: 0, n: 0 };
        e.o += m.o; e.ms += spdNum(m.ms); e.n += spdNum(m.n);
      }
      if (r.c !== null) { c += r.c; priced = true; costFull = costFull && r.cf; }
      else costFull = false;
    }
    if (!rows.length || !ms) return null;
    var ml = [];
    for (var key in models) if (models[key].o > 0) {
      var e2 = models[key];
      ml.push({ key: e2.key, name: e2.name, pid: e2.pid, mid: e2.mid, o: e2.o, ms: e2.ms, n: e2.n,
        tps: e2.ms > 0 ? e2.o / (e2.ms / 1000) : null });
    }
    ml.sort(function (a, b) { return b.o - a.o; });
    var res = { v: out / (ms / 1000), out: out, ms: ms, i: i, o: o, n: n, turns: turns,
      models: ml, modelCount: ml.length, t0: isFinite(t0) ? t0 : 0, t1: t1, last: last,
      tok: tokFull ? tok : null,
      c: priced ? c : null, costFull: priced && costFull };
    /* 整体口径额外产出全量模型名单（悬停列表不省略，纪律同 V2 withNames） */
    if (withNames) res.modelNames = ml.map(function (x) { return x.name; });
    return res;
  }
  /* 按模型分组（Σout/Σms/n/tn）→ out 降序数组。tn：轮表行每含该模型一轮计 1，
   * 日行用解包带的 tn（当日含该模型的 distinct 轮数，缺席按 ≥1 计）。速度恒
   * Σout÷Σms，ms=0 → tps=null（降级模式）。share（请求数占比，恰好 1）由调用方
   * 按池内总请求数计算——本函数不掌握「分母是否该含池外模型」的语境。 */
  function spd3PerModel(rows) {
    var by = {};
    for (var k = 0; k < rows.length; k++) {
      var rm = rows[k].models;
      for (var j = 0; j < rm.length; j++) {
        var m = rm[j], e = by[m.key];
        if (!e) e = by[m.key] = { key: m.key, name: m.name, pid: m.pid || "", mid: m.mid || "", out: 0, ms: 0, n: 0, tn: 0 };
        e.out += m.o; e.ms += spdNum(m.ms); e.n += spdNum(m.n);
        e.tn += (typeof m.tn === "number" && isFinite(m.tn) && m.tn > 0) ? m.tn : 1;
      }
    }
    var ml = [];
    for (var key in by) if (by[key].out > 0) {
      var e2 = by[key];
      ml.push({ key: e2.key, name: e2.name, pid: e2.pid, mid: e2.mid, out: e2.out, ms: e2.ms, n: e2.n, tn: e2.tn,
        tps: e2.ms > 0 ? e2.out / (e2.ms / 1000) : null });
    }
    ml.sort(function (a, b) { return b.out - a.out; });
    return ml;
  }
  /* ==================== ⑤b 月份导航助手（spec §28） ====================
   * 月份用整数「年×12+月」比较（月为 0 基），日期一律本地日历构造（DST 日 23h/25h
   * 与生产端日界一致，禁固定毫秒步长）。文案三件套供 core 标题与 view 的胶囊/弹层/
   * Tab/左卡共用（zh「2026年11月」「11月」，en「Nov 2026」「Nov」）。 */
  var SPD3_MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function spd3MonOf(t) { var d = spdDate(t); return d.getFullYear() * 12 + d.getMonth(); }
  function spd3MonY(v) { return Math.floor(v / 12); }
  function spd3MonM(v) { return ((v % 12) + 12) % 12; }
  function spd3MonLabel(v) {
    return SPD_L(spd3MonY(v) + "年" + (spd3MonM(v) + 1) + "月", SPD3_MONTH_EN[spd3MonM(v)] + " " + spd3MonY(v));
  }
  function spd3MonShort(v) { return SPD_L((spd3MonM(v) + 1) + "月", SPD3_MONTH_EN[spd3MonM(v)]); }
  function spd3MonStart(v) { return new Date(spd3MonY(v), spd3MonM(v), 1).getTime(); }
  /* 轮表是否完整覆盖某时刻起的月份（spec §28.3 混合数据源）：未截断=全史在表恒覆盖；
   * 已截断则只有最早一轮早于该时刻才算覆盖住（否则该月只有起点之后的数据）。 */
  function spd3TurnsCover(u, t) {
    if (!u) return false;
    if (!u.truncated) return true;
    return !!(u.turns.length && u.turns[0].t < t);
  }
  /* ==================== ⑥ 聚合管线（spec §4，20 组合唯一入口） ====================
   * 顺序固定（PRD 4.2）：范围池 → 自然时间窗 → 最近 N 轮（SPD_BARS_MAX=18，沿用
   * 现值）→ 模型筛选 → 聚合。筛选只删分量不缩窗口：range=recent 先取最近 18 轮
   * 窗口，再在窗口内按筛选分量重算（PRD 4.3，不向更早历史补轮）。
   * 入参：h=speed_history 帧（可 null）、sd=speed_days 帧（可 null）、
   * sel={range,period,sid,remote?,filt?,focus?,mon?}。sid 由调用点从本窗口/分栏可信身份
   * 注入（同一帧推给所有窗，绝不用帧里 sid——纪律同 V2）；filt 是 spd3Filter* 维护
   * 的同一可变对象（原地改属性后无需重建 sel）；mon={y,m}（月 0 基，v479 spec §28）
   * =本月视图所选月，缺席=当前自然月。
   * 返回 an（view/charts/heat 的唯一上游契约，结果只读不得原地改）：
   * { items, real, overall(+modelNames/models[].tps), perModel(+share), peak, low,
   *   latest, unit("turn"|"hour"|"day"), title, range, period, spanA, spanB, notice,
   *   truncated, msAvail, pool, selMissing, daysGrid?(仅 month),
   *   mon: {y,m,cur,lo,hi}(有效月份与导航下界，lo/hi 为整数「年×12+月」闭区间) }
   * items 每项 = spd3Aggregate 结果 + {label,full,a,b}，空桶 {v:null,...,empty:true}
   * 不显 0 t/s；real=非空 items；peak/low/latest 按 real 的 v/last。 */
  function spd3Analyze(h, sd, sel) {
    sel = sel || {};
    var range = SPD_RANGES.indexOf(sel.range) >= 0 ? sel.range : "all";
    var period = SPD_PERIODS.indexOf(sel.period) >= 0 ? sel.period : "all";
    var paneSid = sel.sid || "";
    var now = Date.now();
    var u = spd3Unpack(h);
    var daysRows = sd ? spd3UnpackDays(sd) : null;
    if (!u && !daysRows) return null;   /* h 与 sd 都缺（或都畸形）→ 调用方回退 V1 */
    /* 远端身份 + 全部：本地库不能冒充远端历史，明确降级到本会话并提示（沿用 V2
     * fail-closed）。降级先行：all+sd 合并池只在真「全部」范围组装，降级后自然走
     * 轮表会话池（日行无 sid，会话筛选天然剔除）。 */
    var remote = !!sel.remote;
    if (remote && range === "all") range = "session";
    var notices = [];
    if (remote && sel.range === "all") notices.push(SPD_L("远端会话仅显示本会话历史", "Remote pane: local session history only"));
    /* v479（spec §28.1）月份导航：所选月 sel.mon={y,m} 折成整数「年×12+月」（缺席/非法=
     * 当前自然月）与导航下界 lo=本范围**有数据**的最早时刻所在月。全部范围的下界取全部
     * 来源最早者——轮表覆盖不住的月份由 speed_days 日行承接（见下 useDays），下界必须与
     * 「切过去之后看得到什么」一致，否则弹层会把可看的月份置灰；日行取首个非空日
     * （daysRows.start 是固定 550 天窗口起点，早于首个有数据日时照取会让人翻到一串必定
     * 全空的月份——2026-11-26 实机取证）；其余范围在范围过滤后对池重算。sel.mon 落在
     * 界外时钳到最近的可看月份（monEff）。 */
    var dNow = new Date(now);
    var monCur = dNow.getFullYear() * 12 + dNow.getMonth();
    var monSel = (sel.mon && typeof sel.mon.y === "number" && typeof sel.mon.m === "number" &&
      isFinite(sel.mon.y) && isFinite(sel.mon.m)) ? Math.floor(sel.mon.y) * 12 + Math.floor(sel.mon.m) : monCur;
    var monLoT = (range === "all" && daysRows && daysRows.rows.length) ? daysRows.rows[0].t0 : Infinity;
    if (range === "all" && u && u.turns.length && u.turns[0].t < monLoT) monLoT = u.turns[0].t;
    var monLo = isFinite(monLoT) ? spd3MonOf(monLoT) : monCur;
    var monEff = Math.min(Math.max(monSel, monLo), monCur);
    /* 数据池组装（spec §1.2 防重叠）：全部×全部 且 speed_days 可用 → 日行 + 晚于
     * 覆盖末日次日日历零点（daysRows.end，B1/S10 日历化接缝）的轮表行；日行 t 恒 <
     * 该分界，轮表行按 t >= 分界并入，无重叠无遗漏——固定 864e5 接缝在跨 DST 帧会
     * 漂进覆盖末日，把末日内晚轮双重计数。其余组合池=轮表行。
     * v479（spec §28.3 混合数据源，用户裁定）：全部×本月 在轮表覆盖不住所选月时
     * 同样走日行池（可回看约 550 天）；轮表完整覆盖时照旧只用轮表（日卡预估费用与
     * 每模型 token 仍由轮表行提供，现状零变化）。 */
    var useDays = range === "all" && !!daysRows &&
      (period === "all" || (period === "month" && !spd3TurnsCover(u, spd3MonStart(monEff))));
    var pool;
    if (useDays) {
      var endMs = daysRows.end;
      pool = daysRows.rows.slice();
      if (u) for (var pi = 0; pi < u.turns.length; pi++) if (u.turns[pi].t >= endMs) pool.push(u.turns[pi]);
      /* 月视图走日行时不追加截断提示：导航下界已保证所选月在覆盖内（spec §28.3） */
      if (daysRows.truncated && period === "all") notices.push(SPD_L("已截断 · 仅显示最近 " + daysRows.days + " 天",
        "Truncated · last " + daysRows.days + " days only"));
    } else {
      pool = u ? u.turns : [];
    }
    /* 数据来源披露（M2/S8）：a) 无 speed_days 的「全部×全部」= 轮表窗口在冒充全历史；
     * b) 轮表 6000 截断且本视图真以轮表为源（useDays 时日桶已覆盖全历史，截断无谓
     * 再提示）。两类同义（「仅统计最近可用轮次」），互斥去重不叠报。 */
    if (range === "all" && period === "all" && !daysRows) {
      notices.push(SPD_L("仅统计最近可用轮次", "recent turns only"));
    } else if (!useDays && u && u.truncated) {
      notices.push(SPD_L("历史较长，仅统计最近可用轮次", "long history: recent turns only"));
    }
    /* 本会话 pid 从池内同 sid 行取（帧不携带调用方身份）；找不到=本会话不在历史中，
     * 项目范围为空池并提示（spec §4：项目=本会话所在 pid 的全部会话）。 */
    var panePid = "";
    for (var pp = 0; pp < pool.length; pp++) if (pool[pp].sid === paneSid) { panePid = pool[pp].pid; break; }
    if (range === "session" || range === "recent") {
      pool = pool.filter(function (r) { return r.sid === paneSid; });
    } else if (range === "project") {
      if (!panePid) notices.push(SPD_L("当前会话不在历史中，项目范围无数据", "Current session not found in history; project scope is empty"));
      pool = panePid ? pool.filter(function (r) { return r.pid === panePid; }) : [];
    }
    /* v479：会话/项目/最近范围的下界=范围过滤后轮表池最早一轮所在月（池空=当前月），
     * 钳制随之重算（取自模型筛选前的池：下界不随筛选变化） */
    if (range !== "all") {
      var loT = Infinity;
      for (var mi2 = 0; mi2 < pool.length; mi2++) if (pool[mi2].t < loT) loT = pool[mi2].t;
      monLo = isFinite(loT) ? spd3MonOf(loT) : monCur;
      monEff = Math.min(Math.max(monSel, monLo), monCur);
    }
    /* 自然时间窗：today/week/month 用本地日历运算（零点/当月一号），不减固定毫秒数
     * （weekStart 同样日历化：today-6 个本地日，DST 日 23h/25h 与桶归属一致，M3/S8；
     * 桶归属仍走 spdBucket 本地日历）。 */
    var a = 0, b = 0;
    var todayStart = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()).getTime();
    var weekStart = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate() - 6).getTime();
    var monthStart = spd3MonStart(monEff);
    if (period === "today") { a = todayStart; b = now; }
    else if (period === "week") { a = weekStart; b = now; }
    /* v479（spec §28.2）：右端收在月末——整体均值/模型分布/峰低新都从本窗过滤后的
     * 整池算，历史月右端不收会把之后的月份一并算进去；当月仍是 now（既有行为） */
    else if (period === "month") { a = monthStart; b = Math.min(spdNextBucket(monthStart, "month") - 1, now); }
    if (a) pool = pool.filter(function (r) { return r.t >= a && r.t <= b; });
    /* 最近 N 轮：时间窗先行、N 轮上限在后（沿用 V2）；range=recent 与 period=recent
     * 两处各切一次（同值幂等）——范围「最近」在该周期过滤之后取最近 18 个有效轮。 */
    if (range === "recent") pool = pool.slice(-SPD_BARS_MAX);
    if (period === "recent") pool = pool.slice(-SPD_BARS_MAX);
    /* 降级提示的池规模判据（M1/S8）：取筛选前的原始池模型数——筛选只删分量，
     * 池里「有没有第二个模型可比」不该随筛选翻转。rawPool 引用=v389 §13.4
     * axisA/axisB（未筛选时间轴）复用。 */
    var rawPool = pool;
    var rawPoolModelCount = 0, rawPoolKeys = {};
    for (var rk = 0; rk < pool.length; rk++) {
      var rkm = pool[rk].models;
      for (var rkj = 0; rkj < rkm.length; rkj++)
        if (!rawPoolKeys[rkm[rkj].key]) { rawPoolKeys[rkm[rkj].key] = 1; rawPoolModelCount++; }
    }
    /* 模型筛选（spec §4 顺序最末）：把每行 models 收窄为选中 key 子集，行级 out/ms/n
     * 重算为筛选后分量和；行无选中分量 → 整行剔除。特例：所选分量全部无模型级窗口
     * （旧二元组帧 fms=0）时保留整行 out/ms 画整轮值（spec §6 降级不缺柱），但
     * models 清空（M1/S8）——无窗口分量不入 perModel/悬停组成，绝不拿「分量输出 ÷
     * 整轮窗口」充当模型速度，柱走中性色、左卡单模型判定天然排除。 */
    var filt = sel.filt, filtering = !!(filt && filt.mode === "sel" && filt.keys);
    if (filtering) {
      var selSet = {};
      for (var si = 0; si < filt.keys.length; si++) selSet[filt.keys[si]] = true;
      var fp = [];
      for (var fi = 0; fi < pool.length; fi++) {
        var row = pool[fi], fm = [];
        for (var fj = 0; fj < row.models.length; fj++) if (selSet[row.models[fj].key]) fm.push(row.models[fj]);
        if (!fm.length) continue;
        if (fm.length === row.models.length) { fp.push(row); continue; }
        var fo = 0, fms = 0, fn = 0, ftok = 0, tokKnown = true;
        for (var fk = 0; fk < fm.length; fk++) {
          fo += fm[fk].o; fms += fm[fk].ms; fn += fm[fk].n;
          /* v457（spec §25）：选中模型的 Token 之和；任一选中模型 tt 未知 → 整行未知
           * （tok=null，渲染端不出 token 行，绝不拿整行合计冒充筛选后的值） */
          if (fm[fk].tt === null || fm[fk].tt === undefined) tokKnown = false; else ftok += fm[fk].tt;
        }
        /* 部分选中：有窗口分量按 spec §4 重算行级和；全无窗口（旧二元组帧）保留
         * 整行 out/ms 画整轮值、models 清空（M1/S8，身份不再入分布/悬停卡）。
         * 两种都拷贝新行对象——缓存的解包结果只读，绝不原地改行。筛选后的行
         * 无法再按模型拆输入/输出，i/o 保留整轮值不动，token 以 tok 为准。 */
        fp.push(fms > 0
          ? Object.assign({}, row, { out: fo, ms: fms, n: fn, models: fm, msAvail: true,
              tok: tokKnown ? ftok : null })
          : Object.assign({}, row, { models: [], msAvail: false, tok: null }));
      }
      pool = fp;
    }
    /* 桶化：recent 每轮一项；today 恒小时全桶（00..当前小时，空桶保留显空位不显 0）；
     * week/month/all 恒日桶（v291 起「全部」切历史热力，日粒度恒定）。month 另产
     * an.daysGrid 覆盖当月全部日（含空日/未来日，日历铺格由渲染层做）。日行桶键
     * 直接用契约 t0（不走 spdBucket 再归一化，见 ② 的 DST 口径注释）。 */
    var items = [], daysGrid = null;
    if (period === "recent") {
      for (var ri = 0; ri < pool.length; ri++) {
        var rrow = pool[ri], ragg = spd3Aggregate([rrow]);
        /* 柱底只显时分，完整年月日时分秒留给 hover 信息卡（纪律同 V2） */
        if (ragg) items.push(Object.assign(ragg, { label: spdShort(rrow.t, "turn"),
          full: spdFull(rrow.b) + " – " + spdFull(rrow.t), a: rrow.b, b: rrow.t }));
      }
    } else {
      var unit = period === "today" ? "hour" : "day";
      var buckets = {}, bkeys = [];
      if (pool.length) {
        for (var w = 0; w < pool.length; w++) {
          var prow = pool[w];
          var bk = (unit === "day" && prow.t0 !== undefined) ? prow.t0 : spdBucket(prow.t, unit);
          if (!buckets[bk]) { buckets[bk] = []; bkeys.push(bk); }
          buckets[bk].push(prow);
        }
        bkeys.sort(function (x, y) { return x - y; });
        if (period === "today") {
          /* 00:00→当前小时全桶，无数据显空桶而非零速度；有效桶 ≤3 且全桶 ≥4 时默认
           * 聚焦有效时段（收放条件读 sel.focus，沿用 V2 行为） */
          bkeys = [];
          for (var hr = 0; hr <= dNow.getHours(); hr++) bkeys.push(todayStart + hr * 3600000);
          var fullKeys = bkeys.slice(), realKeys = [];
          for (var fk = 0; fk < fullKeys.length; fk++) if ((buckets[fullKeys[fk]] || []).length) realKeys.push(fullKeys[fk]);
          if (sel.focus !== "full" && realKeys.length && realKeys.length <= 3 && fullKeys.length >= 4) bkeys = realKeys;
        }
        for (var bi = 0; bi < bkeys.length; bi++) {
          var bk2 = bkeys[bi], rows2 = buckets[bk2] || [], bg = spd3Aggregate(rows2);
          /* v387：进行中桶（今天最后一格/跨今天的日桶）b 钳到 now——hover 区间
           * 「截至 HH:mm」语义由渲染层按 b 与桶末的距离区分（spec §11.5），
           * 绝不把未发生的时间展示成已统计区间。 */
          var nb = Math.min(spdNextBucket(bk2, unit), now);
          items.push(bg ? Object.assign(bg, { label: spdLabel(bk2, unit, true),
              full: spdFull(bk2) + " – " + spdFull(nb), a: bk2, b: nb })
            : { v: null, label: spdLabel(bk2, unit, true), full: spdFull(bk2) + " – " + spdFull(nb),
                a: bk2, b: nb, empty: true, models: [] });
        }
      }
      if (period === "month") {
        /* 所选月每日键集（本地日历天数，当月含今天之后的未来日）：agg=null=空日/未来
         * 日，热力格状态由渲染层区分（spec §5：未来遮罩/空日灰/有记录色阶/今天描边）；
         * v479 起月份取 monEff（历史月无今天、无未来日，今天判定仍在渲染层按真实时钟） */
        daysGrid = [];
        var mY = spd3MonY(monEff), mM = spd3MonM(monEff);
        var dim = new Date(mY, mM + 1, 0).getDate();
        for (var dd = 1; dd <= dim; dd++) {
          var g0 = new Date(mY, mM, dd).getTime();
          var g1 = new Date(mY, mM, dd + 1).getTime();
          var grows = buckets[g0] || [];
          daysGrid.push({ t0: g0, t1: g1, agg: grows.length ? spd3Aggregate(grows) : null });
        }
      }
    }
    /* 设计稿五命名（spec §6）；N=items.length（recent 恒 = 柱数） */
    var unit2 = period === "recent" ? "turn" : (period === "today" ? "hour" : "day");
    var title = period === "recent" ? SPD_L("最近 " + items.length + " 轮 · 生成速度", "Last " + items.length + " turns · generation speed")
      : period === "today" ? SPD_L("今天 · 按小时生成速度", "Today · hourly generation speed")
      : period === "week" ? SPD_L("近 7 天 · 每日平均速度", "Last 7 days · daily average speed")
      /* v479（spec §28.4）：当前月保持「本月」，历史月带年月（「2026年10月 · 日均生成速度」） */
      : period === "month" ? (monEff === monCur ? SPD_L("本月 · 日均生成速度", "This month · daily generation speed")
        : spd3MonLabel(monEff) + SPD_L(" · 日均生成速度", " · daily generation speed"))
      : SPD_L("全部 · 历史生成速度", "All history · generation speed");
    /* v295 纪律沿用：顺序时间（旧→新，最新柱在最右）；real 与峰值/最低/最新按时间戳
     * 比较不受顺序影响；spanA/spanB 取自筛选后池（沿用 V2 取法：时间窗优先）。 */
    var real = items.filter(function (x) { return !x.empty; });
    var overall = spd3Aggregate(pool, true);
    /* v389 §13.4：未筛选原始池时间轴（axisA/axisB）——heat 短历史形态判定读它，
     * 保证「覆盖跨度=池时间轴、着色=筛选」（PRD 5.5 时间轴稳定：极端筛选不使
     * 形态在日卡/周网格间跳变）；spanA/spanB 仍是筛选后展示轴（图表头区间）。 */
    var axisA = spanA0v(), axisB = 0;
    function spanA0v() {
      var lo = Infinity;
      for (var ai = 0; ai < rawPool.length; ai++) if (rawPool[ai].b < lo) lo = rawPool[ai].b;
      return isFinite(lo) ? lo : 0;
    }
    for (var abi = 0; abi < rawPool.length; abi++) if (rawPool[abi].t > axisB) axisB = rawPool[abi].t;
    var spanA = a || (pool.length ? pool[0].b : 0);
    var spanB = b || (pool.length ? pool[pool.length - 1].t : 0);
    if (period === "all" && pool.length) { spanA = pool[0].b; spanB = pool[pool.length - 1].t; }
    var peak = null, low = null, latest = null;
    for (var z = 0; z < real.length; z++) {
      if (real[z].v == null) continue;
      if (!peak || real[z].v > peak.v) peak = real[z];
      if (!low || real[z].v < low.v) low = real[z];
      if (!latest || real[z].last > latest.last) latest = real[z];
    }
    /* msAvail=筛选后池内是否存在 ms>0 的模型分量（spec §4 降级模式判据）；同时收集
     * 池内模型 key 集（selMissing 判定基于筛选后的真实池）。 */
    var msAvail = false, poolKeys = {};
    for (var mi = 0; mi < pool.length; mi++) {
      var rm2 = pool[mi].models;
      for (var mj = 0; mj < rm2.length; mj++) {
        if (rm2[mj].ms > 0) msAvail = true;
        if (!poolKeys[rm2[mj].key]) { poolKeys[rm2[mj].key] = true; }
      }
    }
    var selMissing = [];
    if (filtering) {
      for (var sm = 0; sm < filt.keys.length; sm++) if (!poolKeys[filt.keys[sm]]) selMissing.push(filt.keys[sm]);
      if (selMissing.length) notices.push(SPD_L("已选 " + filt.keys.length + " 个模型中 " + selMissing.length + " 个在当前范围无数据",
        selMissing.length + " of " + filt.keys.length + " selected models have no data here"));
    }
    /* 降级模式通知：判据=筛选后池无窗口分量 且 原始池（筛选前）有第二个模型可比
     * （M1/S8：降级帧上筛选会清空全部身份，池模型数不能再当判据，单模型也无可
     * 比较对象，spec §6/任务 §7） */
    if (!msAvail && rawPoolModelCount > 1) notices.push(SPD_L("该历史数据缺少模型级生成耗时，暂无法按模型比较速度",
      "Model-level timing missing in this history; per-model speed comparison unavailable"));
    /* perModel：spd3PerModel 分组 + share（请求数占比，恰好 1；spec §6 左卡分布表。
     * 占比按「该模型已完成请求数 / 池内总请求数」——单轮多模型会使 Σn>轮数，属
     * 口径内（PRD §10 禁的是把 Token 占比或输出占比当请求占比，不是 n 占比）。 */
    var perModel = spd3PerModel(pool), totalN = 0;
    for (var tni = 0; tni < perModel.length; tni++) totalN += perModel[tni].n;
    for (var shi = 0; shi < perModel.length; shi++) perModel[shi].share = totalN > 0 ? perModel[shi].n / totalN : 0;
    var an = { items: items, real: real, overall: overall, perModel: perModel,
      peak: peak, low: low, latest: latest, unit: unit2, title: title,
      range: range, period: period, spanA: spanA, spanB: spanB,
      notice: notices.join(SPD_L(" · ", " · ")), truncated: !!(u && u.truncated),
      msAvail: msAvail, pool: pool, selMissing: selMissing,
      axisA: axisA, axisB: axisB,   /* v389 §13.4：未筛选时间轴（heat 形态判定） */
      /* v479（spec §28.1）：有效月份与导航下界（lo/hi 为整数「年×12+月」闭区间） */
      mon: { y: spd3MonY(monEff), m: spd3MonM(monEff), cur: monEff === monCur, lo: monLo, hi: monCur } };
    /* v387 §11.4：空态原因分类（view 空态页据此给针对性提示与恢复动作，
     * 不再千篇一律「尝试更长时间范围」）。按池构成与筛选态判定，顺序即优先级。 */
    if (!real.length) {
      if (remote) an.emptyReason = SPD_L("远端会话仅显示本会话历史", "Remote pane shows this session only");
      else if (!u) an.emptyReason = SPD_L("速度数据尚未加载", "Speed history not loaded yet");
      else if (filtering && !filt.keys.length) an.emptyReason = SPD_L("未选择任何模型", "No model selected");
      else if (filtering) an.emptyReason = SPD_L("已选模型在当前范围暂无有效速度记录", "Selected models have no rated turns in this range");
      /* v479（spec §28.4）：历史月先按月说原因——范围=会话/最近的通用句「当前会话暂无
       * 已完成请求」在这里是误报（会话有请求，只是不在该月） */
      else if (period === "month" && monEff !== monCur) an.emptyReason = SPD_L("所选月份内暂无请求", "No requests in the selected month");
      else if (range === "session" || range === "recent") an.emptyReason = SPD_L("当前会话暂无已完成请求", "No completed turns in this session yet");
      else if (range === "project") an.emptyReason = SPD_L("当前项目暂无有效速度数据", "No rated data in this project yet");
      else if (a && b) an.emptyReason = SPD_L("当前时间范围内暂无请求", "No turns in this time range");
      else an.emptyReason = SPD_L("暂无有效生成速度记录", "No rated turns yet");
    }
    if (daysGrid) an.daysGrid = daysGrid;
    return an;
  }
  /* ==================== ⑦ 结果 memo（spec §8） ====================
   * 按「帧对象引用 + sel 签名」缓存（WeakMap<h, 条目数组>）：帧未变+签名未变不重算。
   * 每帧多槽（S10/B1 修复）：wire 在筛选激活时对同一帧连续算 sel/auto 两个签名、
   * 多窗/多实例各持不同组合——单槽会逐拍互踢退化为每次全量重算。槽数组线性扫
   * （≤SPD3_MEMO_CAP 条，数组在 VM 切片沙箱可用，Map 不在夹具原生名单内），超限
   * 整清再存当前（纪律同 _AGG_CACHE 溢出整清）。命中另带 h.turns.length 守卫
   * （同 spd3Unpack：防同一帧对象被原地追加后命中陈旧结果）。签名含分钟粒度时间片
   * spd3NowBucket——today/week/month 时间窗与 month 日历都依赖 Date.now()，每分钟
   * 失效一次（V2 每次悬停都全量重算，这里是纯增益）。speed_days 帧经 SPD3_SD_IDS
   * 分配稳定序号进签名（WeakMap 键做不了字符串签名的一部分）。结果为共享只读对象：
   * 调用方不得原地改 an（纪律同 spd3Unpack 行只读）。 */
  var SPD3_MEMO = new WeakMap(), SPD3_SD_IDS = new WeakMap(), SPD3_SD_NEXT = 1;
  var SPD3_MEMO_CAP = 8;
  function spd3NowBucket() { return Math.floor(Date.now() / 60000); }
  function spd3AnalyzeCached(h, sd, sel) {
    var keyObj = h || sd;
    if (!keyObj) return spd3Analyze(h, sd, sel);
    sel = sel || {};
    var sdId = 0;
    if (sd) {
      sdId = SPD3_SD_IDS.get(sd);
      if (!sdId) { sdId = SPD3_SD_NEXT++; SPD3_SD_IDS.set(sd, sdId); }
    }
    var sig = [sel.range || "", sel.period || "", sel.sid || "", sel.remote ? 1 : 0,
      spd3FilterSig(sel.filt), sel.focus || "", spd3NowBucket(), sdId,
      sel.mon ? sel.mon.y + "-" + sel.mon.m : ""].join("\u0001");   /* v479：所选月进签名 */
    var n = (h && h.turns && typeof h.turns.length === "number") ? h.turns.length : -1;
    var memo = SPD3_MEMO.get(keyObj);
    if (memo) for (var i = 0; i < memo.length; i++)
      if (memo[i].sig === sig && memo[i].n === n) return memo[i].res;
    var res = spd3Analyze(h, sd, sel);
    if (!memo) { memo = []; SPD3_MEMO.set(keyObj, memo); }
    if (memo.length >= SPD3_MEMO_CAP) memo.length = 0;   /* 超限整清再存当前 */
    memo.push({ sig: sig, n: n, res: res });
    return res;
  }
  /* SPD_V3_CORE_END */
