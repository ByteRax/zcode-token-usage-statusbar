/* mobile-relay：官方中继手机远控 chips 推送（主进程热换模块，v2 目标驱动）。
 * 数据流：overlay.js 渲染端读宿主只读接口 window.zcode.getWebRemoteControlStatus()，
 * 取 mobileTaskView 作为远控页面正在查看的会话（taskId 即聊天 sessionId），连同
 * 已挂载状态条 DOM 采集的 chips 写 window.__zusageMobileChips →
 * 主泵 readWants 轮询读回（同 __zusageWantSids 通道）→ 本模块 push() →
 * 编码为 @zcode/rpc EventFire 帧（魔数 id 2147483647，官方 ChannelClient id 从 0 递增
 * 不碰撞，未知 id 静默丢弃零干扰）→ globalThis.__zusageRelayStash 各活跃桥的
 * protocol.send（宿主 AcknowledgedRelayProtocol 唯一合法入口：seq/messageSeq/ack/
 * 降级语义全归宿主协议栈，绝不直接写 relay socket）→ 官方中继 ws2 →
 * 远控页油猴脚本（docs/zusage-mobile.user.js）解码渲染。规格 specs/mobile-relay.md。
 *
 * 目标会话来源（v2 修正）：只认宿主报告的 mobileTaskView.taskId。mobileTaskView 为空
 * （页面隐藏/首页/遮盖）时不推新数据、不清空手机端上次显示；**不**按目录、标题、
 * 最近活跃等启发式猜会话（v1 的 queryByWorkspace 已删除）。remoteSessionId 是
 * bridge/source 路由键、URL sid 是 deviceSid，均不是聊天 sessionId。
 *
 * chips 优先复用渲染端 DOM 采集（bySession[taskId]，与桌面逐字一致）；桌面没打开
 * 该会话时按精确 taskId 调 zusage.py json <sid>，从 recent 里取该 sid 的记录格式化。
 * payload 契约：{zm:1, ts:ms, target:{taskId,workspacePath,workspaceIdentity}|null,
 * bySession:{sid:[{id,label,value,detail,tone}]}}，JSON ≤ 256KB 单分片。 */
"use strict";

const MAGIC_ID = 2147483647;
const MAX_JSON_BYTES = 262144;
/* 查询/推送限频：与桌面主泵同源同值（config.activity_min_ms，缺省 1500ms，下限 300）。
 * 实际值由 inject-main 创建本模块时传入（options.minIntervalMs），此常量仅兜底/测试用。 */
const DEFAULT_ACTIVITY_MIN_MS = 1500;
/* 同一目标的数据刷新节奏：远控页看的是「当前会话」，1s 级刷新才像桌面。
 * 每次查询走常驻 `zusage.py serve`（见下方 residentQuery），单次 ~5-20ms，
 * 不再每次 spawn 新解释器（Windows 冷启动 0.5~1.5s 是此前「更新慢」的主因之一）。 */
/* 桌面同款触发模型（v346）：DB 写入事件驱动（inject-main 的 fs.watch 300ms 去抖调 pump），
 * 30s 兜底心跳防事件丢失；查询节流 = config.activity_min_ms（与桌面同一配置项）。 */
const FALLBACK_HEARTBEAT_MS = 30000;
const ANNOUNCE_MS = 2500;  // 能力公告节奏（握手起点；极小帧，不影响数据推送节流）
const UPLINK_CAP = 2;      // 上行能力/帧代际（与油猴 zuUp 配对；握手成功油猴才上行）
const HEARTBEAT_MS = 15000;          // 内容不变也至少 15s 一帧（消费端 30s 标灰阈值的一半）
const RESIDENT_IDLE_MS = 60000;      // 无查询 60s 回收常驻解释器
const RESIDENT_TIMEOUT_MS = 15000;   // 单请求超时（与主泵同值）

/* @zcode/rpc serialization.ts 的最小编码器（只写方向）：
 * [1B tag][VQL len][data]；tag 4=array 5=object(JSON) 6=int。消息 = header + body，
 * header=[204(EventFire), MAGIC_ID]，body=Object JSON。协议 send 只解包 .buffer
 * （`send: (buffer) => this.reserveMessage(buffer.buffer)`），VSBuffer shim 只需 buffer。 */
function writeVQL(out, value) {
  let v = value >>> 0;
  for (;;) {
    const b = v & 0x7f;
    v = v >>> 7;
    if (v === 0) { out.push(b); return; }
    out.push(b | 0x80);
  }
}
function encodeEventFireFrame(payloadJson) {
  const bodyBytes = Buffer.from(payloadJson, "utf8");
  const head = [];
  head.push(4);                    // Array
  writeVQL(head, 2);               // 长度 2
  head.push(6); writeVQL(head, 204);            // Int 204 = ResponseType.EventFire
  head.push(6); writeVQL(head, MAGIC_ID);       // Int 魔数 id
  const headBytes = Buffer.from(head);
  const out = Buffer.alloc(headBytes.length + 1 + 5 + bodyBytes.length);   // 5=长度 VQL 上界
  let off = 0;
  headBytes.copy(out, off); off += headBytes.length;
  out[off++] = 5;                  // Object（JSON fallback）
  const lenBytes = [];
  writeVQL(lenBytes, bodyBytes.length);
  const lb = Buffer.from(lenBytes);
  lb.copy(out, off); off += lb.length;
  bodyBytes.copy(out, off);
  return { buffer: out.subarray(0, off + bodyBytes.length) };
}

/* 与桌面状态条同口径的中文单位：万/亿，toFixed(2) 去尾零。 */
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(2).replace(/\.?0+$/, "") + "亿";
  if (v >= 10000) return (v / 10000).toFixed(2).replace(/\.?0+$/, "") + "万";
  return String(Math.round(v));
}

/* TPS_BANDS 同款档位（02-store-bridge-and-speed-v2.js:109）——桌面速度主数字按档色，
 * 手机端沿用同一档名，由油猴脚本映射同色值。 */
const TPS_BANDS = [
  [2000, "zu-ultra"], [1000, "zu-magenta"], [800, "zu-purple"], [500, "zu-violet"],
  [300, "zu-azure"], [200, "zu-sky"], [150, "zu-teal"], [70, "ok"], [40, "warm"], [0, "hot"],
];
function tpsBand(v) {
  if (typeof v !== "number" || !isFinite(v) || v < 0) return "";
  for (const [lo, cls] of TPS_BANDS) if (v >= lo) return cls;
  return "hot";
}

/* 单个会话快照（zusage json 的 recent 条目）→ 与桌面状态条同序的 chips。
 * 速度主数字沿用 v298 口径（用户拍板）：**最后一轮真实速度（r.last.tps）**，
 * 会话加权平均 avg_tps 只进 tooltip detail——此前误用 avg_tps 当主数字，
 * 导致手机端 157.2t/s 与桌面 355t/s 不一致。
 * 每格按桌面 DOM 拆成 {v 主值, dim 次要后缀}（桌面 .v 600 字重 / .dim subtitle），
 * 手机端用同一套 .zu-* 结构与 CSS 渲染，避免自造格式。 */
function chipsFromSession(r, today) {
  const chips = [];
  const lastTps = Number((r.last && r.last.tps) || 0);
  const avgTps = Number(r.avg_tps || 0);
  const mainTps = lastTps > 0 ? lastTps : avgTps;
  if (mainTps > 0) {
    const band = tpsBand(mainTps);
    const parts = ["最近一段 " + (Math.round(lastTps * 10) / 10) + "t/s"];
    if (avgTps > 0) parts.push("会话均 " + (Math.round(avgTps * 10) / 10) + "t/s");
    parts.push("Σ输出÷Σ生成窗口");
    chips.push({
      id: "speed", label: "速度", band,
      v: String(Math.round(mainTps * 10) / 10), dim: "t/s",
      value: (Math.round(mainTps * 10) / 10) + "t/s",
      detail: parts.join(" · "),
    });
  }
  const lt = r.last_turn || {};
  /* id 与桌面 state.show 键对齐（turn/win/today/proj/tools/sub）：手机端「状态栏显示」
   * 面板照抄桌面 ⚙ 的显示项行，勾选键名必须一致 */
  if (lt.total) chips.push({ id: "turn", label: "本轮", v: formatTokens(lt.total), dim: (lt.requests || 0) + "次", value: formatTokens(lt.total) + (lt.requests || 0) + "次" });
  if (r.total) chips.push({ id: "win", label: "会话累计", v: formatTokens(r.total), dim: (r.turns || 0) + "轮 " + (r.requests || 0) + "次", value: formatTokens(r.total) + (r.turns || 0) + "轮 " + (r.requests || 0) + "次" });
  if (today && today.total) chips.push({ id: "today", label: "今日合计", v: formatTokens(today.total), dim: (today.turns || 0) + "轮 " + (today.requests || 0) + "次", value: formatTokens(today.total) + (today.turns || 0) + "轮 " + (today.requests || 0) + "次" });
  const pj = r.project;
  if (pj && pj.total) chips.push({ id: "proj", label: "项目累计", v: formatTokens(pj.total), dim: (pj.sessions || 0) + "会话 " + (pj.requests || 0) + "次", value: formatTokens(pj.total) + (pj.sessions || 0) + "会话 " + (pj.requests || 0) + "次" });
  const sb = r.sub;
  if (sb && sb.total) chips.push({ id: "sub", label: "子代理", v: formatTokens(sb.total), dim: (sb.requests || 0) + "次", value: formatTokens(sb.total) + (sb.requests || 0) + "次" });
  if (r.tool_calls) {
    /* 工具错误数单独下发（桌面 .eb 红色徽标同款），不并进总数文本 */
    const errs = Number((r.tools && r.tools.errors) || 0);
    const tc = { id: "tools", label: "工具", v: String(r.tool_calls), value: String(r.tool_calls) };
    if (errs > 0) tc.err = String(errs);
    chips.push(tc);
  }
  return chips;
}

/* 按手机端上报的显示项配置裁剪 chips（v346）：手机上 ⚙ 面板勾掉的格不再推送——
 * show 值形如 {"turn":1,"win":1,"proj":0,...}（zusage3.show 原始串）；缺键全开，
 * 显式 false/0 才隐藏。speed 不在 show 键域内，恒保留（与桌面同语义）。
 * 配置缺失/解析失败时不裁（fail-open：宁多推不错推）。 */
function filterChipsByShow(chips, cfg) {
  let show = null;
  try {
    const raw = cfg && cfg.prefs && cfg.prefs.show;
    if (typeof raw === "string" && raw) show = JSON.parse(raw);
    else if (raw && typeof raw === "object") show = raw;
  } catch (e) { return chips; }
  if (!show || typeof show !== "object") return chips;
  return chips.filter((c) => {
    if (!c || !c.id) return true;
    if (c.id === "speed" || c.id === "quota") return true;
    const v = show[c.id];
    return !(v === 0 || v === false || v === "0");
  });
}

function createMobileRelay(options) {
  const log = (options && options.log) || (() => { });
  const stash = () => {
    try { const s = globalThis.__zusageRelayStash; return Array.isArray(s) ? s : []; } catch (e) { return []; }
  };
  let live = [];
  let lastPushAt = 0, lastSnapAt = 0, lastSnapKey = "";
  let pushed = 0, droppedOversize = 0, skippedDup = 0, throttled = 0, sendErr = 0, lastError = "";
  let skippedNoTarget = 0, queryRuns = 0;

  const { spawn: realSpawn } = require("child_process");
  const path = require("path");
  const fs = require("fs");
  const zusagePath = path.join(__dirname, "zusage.py");
  /* 测试接缝：configPath（配置文件落点）与 spawnProc（进程拉起替身）可注入，
   * 默认走真实路径/child_process.spawn。 */
  const spawn = (options && options.spawnProc) || realSpawn;
  /* 限频 = config.activity_min_ms（与桌面主泵同源）。用 getter 形态：inject-main 传入
   * () => readCfgCached().activity_min_ms（自带 mtime 缓存，改配置下一拍即生效），
   * 避免创建时快照常量导致「改了配置要重启才生效」。options.minIntervalMs 供测试注入。 */
  const getMinIntervalMs = (() => {
    const fixed = Math.floor(Number(options && options.minIntervalMs));
    if (fixed > 0) return () => Math.max(300, fixed);
    const fn = options && typeof options.getMinIntervalMs === "function" ? options.getMinIntervalMs : null;
    return () => {
      let v = 0;
      try { v = Math.floor(Number(fn && fn())); } catch (e) { v = 0; }
      return Math.max(300, v > 0 ? v : DEFAULT_ACTIVITY_MIN_MS);
    };
  })();
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  let currentTarget = null;      // {taskId, workspacePath, workspaceIdentity}
  let queryBusy = false, lastQueryAt = 0;
  /* 手机端已上报配置 = 有消费者（v346 门控）：只有收到手机上行配置后才开始查库推送，
   * 单纯建立远控通道不推（避免无消费者盲推占带宽）。 */
  let clientReady = false, clientCfg = null, clientCfgGen = 0, uplinkFrames = 0;
  let lastMode = "";
  let lastQueryRecord = null, lastPushedChips = null;   // 诊断：查询原始记录 / 实际推送内容

  function refreshBridges() {
    const seen = new Set(), next = [];
    for (const e of stash()) {
      if (!e || !e.p || !e.b) continue;
      if (e.b.degraded) continue;                 // 降级桥不再发
      if (!e.b.relayProtocol) continue;           // 已 dispose（relayProtocol 被置空）
      if (seen.has(e.p)) continue;
      seen.add(e.p); next.push(e);
    }
    live = next;
  }

  /* 上行排空：宿主钩子（mobile_relay_patch 的 injection）把带 zuUp 标记的帧推进
   * globalThis.__zusageRelayUplinkQueue——帧在 acceptPayload 严格 seq 校验前被消费，
   * 官方 ack 水位零接触。载荷 = 手机端 overlay 偏好（zusage3.* 同键），gen 单调幂等。 */
  function drainUplink() {
    let q;
    try { q = globalThis.__zusageRelayUplinkQueue; } catch (e) { return; }
    if (!Array.isArray(q) || !q.length) return;
    const frames = q.splice(0, q.length);
    for (const p of frames) {
      uplinkFrames++;
      const cfg = p && typeof p === "object" ? p.zuCfg : null;
      if (!cfg || typeof cfg !== "object") continue;
      const gen = Math.floor(Number(cfg.gen)) || 0;
      if (gen <= clientCfgGen) continue;
      clientCfgGen = gen;
      clientCfg = cfg;
      clientReady = true;
      diag({ uplinkApplied: gen, clientReady, clientCfg });
      /* 首次拿到配置（或配置变化）：立即按新偏好推一帧 */
      try { schedulePump(0); } catch (e) { }
    }
  }

  /* 热修层（与 asar 持久层等价的双保险）：包裹 stash 桥的 relayProtocol.acceptPayload，
   * zuUp 帧进队列并返回 true（先于严格校验被消费）。客户端重装/升级抹掉 asar 补丁时，
   * 这里仍能保证上行安全；新桥由 refreshBridges 节拍补包。 */
  function wrapUplinkHooks() {
    for (const e of stash()) {
      const relay = e && e.b && e.b.relayProtocol;
      if (!relay || typeof relay.acceptPayload !== "function" || relay.__zusageUplinkWrapped) continue;
      let orig;
      try { orig = relay.acceptPayload.bind(relay); } catch (e2) { continue; }
      const wrapped = function (payload) {
        try {
          if (payload && payload.zuUp) {
            (globalThis.__zusageRelayUplinkQueue = globalThis.__zusageRelayUplinkQueue || []).push(payload);
            return true;
          }
        } catch (e2) { }
        return orig(payload);
      };
      try { relay.acceptPayload = wrapped; relay.__zusageUplinkWrapped = true; } catch (e2) { }
    }
  }

  const bridgeTimer = setInterval(() => {
    refreshBridges();
    wrapUplinkHooks();
    drainUplink();
    /* 兜底心跳（同桌面 heartbeat_ms）：事件丢失时仍按 30s 节奏对账 */
    if (live.length && currentTarget && clientReady) { try { pump(); } catch (e) { } }
  }, FALLBACK_HEARTBEAT_MS);
  if (typeof bridgeTimer.unref === "function") bridgeTimer.unref();
  /* 能力公告节拍：只做握手（有桥就发，不管有没有 target/配置） */
  const announceTimer = setInterval(() => { try { announce(); } catch (e) { } }, ANNOUNCE_MS);
  if (typeof announceTimer.unref === "function") announceTimer.unref();
  refreshBridges();
  wrapUplinkHooks();

  function entryInfo(e) {
    try {
      return {
        id: e.b && e.b.bridgeSessionId ? String(e.b.bridgeSessionId).slice(0, 16) : null,
        degraded: !!(e.b && e.b.degraded),
        relay: !!(e.b && e.b.relayProtocol),
        ws: e.b && e.b.workspacePath ? String(e.b.workspacePath).slice(0, 50) : null,
        keys: e.b ? Object.keys(e.b).slice(0, 24) : null,
        ready: !!(e.b && e.b.readyAnnounced),
        closed: !!(e.b && e.b.closed),
        destroyed: !!(e.b && e.b.destroyed),
        connected: e.b && typeof e.b.connected !== "undefined" ? !!e.b.connected : null,
      };
    } catch (err) { return { err: String(err && err.message || err).slice(0, 40) }; }
  }

  function diag(extra) {    try {
      const fs = require("fs");
      fs.writeFileSync(path.join(__dirname, "mobile-relay-diag.json"), JSON.stringify(Object.assign({
        ts: Date.now(), stashCount: stash().length, liveCount: live.length,
        live: live.map(entryInfo), stashAll: stash().map(entryInfo),
        pushed, droppedOversize, skippedDup, throttled, sendErr, skippedNoTarget,
        queryRuns, lastPushAt, lastError, lastMode, clientReady, clientCfgGen, uplinkFrames, clientCfg,
        target: currentTarget ? currentTarget.taskId : null,
        targetWorkspace: currentTarget ? currentTarget.workspacePath : null,
        lastQueryRecord, lastPushedChips,
      }, extra || {}), null, 2));
    } catch (e) { }
  }
  /* 自调度空转时也要能观测（推送被内容去重跳过时不写 diag）：最多 10s 落一次 */
  let lastDiagAt = 0;
  function diagThrottled() {
    const t = Date.now();
    if (t - lastDiagAt < 10000) return;
    lastDiagAt = t;
    diag();
  }


  /* 常驻查询进程（`zusage.py serve`，与主泵同一行协议）：每 1.5s 刷新一次数据时，
   * 每次 spawn 新 Python 在 Windows 要 0.5~1.5s 且吃 CPU——这是远控端「更新慢」的
   * 主因。常驻进程下同一查询 5~20ms。空闲 60s 回收；早退 3 次判不稳定回退一次性 spawn。
   * turns:true 不再携带（逐轮统计块随回答统计行一并回退）。 */
  const RESIDENT_LINE = (taskId) => JSON.stringify({ sids: [taskId], scopes: [] });
  let pyRes = null, pyFail = 0, pyIdle = 0;
  function stopResident() {
    if (pyIdle) { clearTimeout(pyIdle); pyIdle = 0; }
    const c = pyRes;
    if (!c) return;
    pyRes = null;
    c.intentional = true;
    try { c.proc.kill(); } catch (e) { }
    const ws = c.waiters; c.waiters = [];
    ws.forEach((w) => { try { w(null); } catch (e) { } });
  }
  function armIdle() {
    if (pyIdle) clearTimeout(pyIdle);
    pyIdle = setTimeout(() => { pyIdle = 0; stopResident(); }, RESIDENT_IDLE_MS);
    if (pyIdle && typeof pyIdle.unref === "function") pyIdle.unref();
  }
  function startResident() {
    if (pyRes) return pyRes;
    let proc;
    try { proc = spawn(pythonCmd, [zusagePath, "serve"], { windowsHide: true }); }
    catch (e) { pyFail++; lastError = "serve spawn: " + e.message; return null; }
    const c = { proc, buf: "", waiters: [], born: Date.now(), intentional: false, finished: false };
    pyRes = c;
    c.finish = () => {
      if (c.finished) return;
      c.finished = true;
      if (pyRes === c) pyRes = null;
      const ws = c.waiters; c.waiters = [];
      ws.forEach((w) => { try { w(null); } catch (e) { } });
      if (c.intentional) return;
      if (Date.now() - c.born < 30000) pyFail++; else pyFail = 0;
      if (pyFail >= 3) { lastError = "serve unstable, fallback to one-shot"; return; }
    };
    proc.on("error", () => { try { proc.kill(); } catch (e) { } c.finish(); });
    proc.stdin.on("error", () => { try { proc.kill(); } catch (e) { } c.finish(); });
    proc.on("close", c.finish);
    proc.stderr.on("data", () => { });
    proc.stdout.on("data", (d) => {
      if (c.finished) return;
      c.buf += d.toString("utf8");
      if (c.buf.length > 8 * 1024 * 1024) { c.buf = ""; return; }
      let i;
      while ((i = c.buf.indexOf("\n")) >= 0) {
        const line = c.buf.slice(0, i);
        c.buf = c.buf.slice(i + 1);
        const w = c.waiters.shift();
        if (!w) continue;
        let payload = null;
        try { payload = JSON.parse(line); } catch (e) { }
        w(payload);
      }
    });
    armIdle();
    return c;
  }
  /* 一次查询：常驻优先，不稳定时一次性 spawn 回退；只结算一次。 */
  function queryJson(taskId, done) {
    let settled = false;
    const finish = (payload) => { if (!settled) { settled = true; done(payload); } };
    if (pyFail < 3) {
      const c = startResident();
      if (c && c.proc.stdin.writable) {
        const waiter = (payload) => { clearTimeout(timer); finish(payload); };
        const timer = setTimeout(() => { stopResident(); finish(null); }, RESIDENT_TIMEOUT_MS);
        c.waiters.push(waiter);
        try { c.proc.stdin.write(RESIDENT_LINE(taskId) + "\n"); }
        catch (e) { try { c.proc.kill(); } catch (e2) { } c.finish(); }
        armIdle();
        return;
      }
    }
    const proc = spawn(pythonCmd, [zusagePath, "json", taskId], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) { } finish(null); }, RESIDENT_TIMEOUT_MS);
    proc.stdout.on("data", (d) => { if (out.length < 8 * 1024 * 1024) out += d.toString("utf8"); });
    proc.on("error", () => { clearTimeout(timer); finish(null); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { finish(null); return; }
      try { finish(JSON.parse(out)); } catch (e) { finish(null); }
    });
  }

  /* 按精确 taskId 查询会话快照并推送：主载荷 = zusage.py json 的完整快照（手机端跑
   * 桌面 overlay.js 渲染），chips 仅为 overlay 加载失败时的降级渲染（按手机 show 裁剪）。 */
  function queryAndPush(taskId) {
    if (queryBusy) return;
    queryBusy = true;
    queryRuns++;
    queryJson(taskId, (d) => {
      queryBusy = false;
      lastQueryAt = Date.now();
      if (!d || d.error) { lastError = "query: " + ((d && d.error) || "no payload"); diag(); return; }
      try {
        const r = (d.recent || []).find((x) => x && x.sid === taskId);
        if (!r) { lastError = "session not in recent"; diag(); return; }
        lastQueryRecord = {   // 诊断快照：查询返回的原始字段
          ts: Date.now(), sid: r.sid, title: r.title,
          total: r.total, turns: r.turns, requests: r.requests,
          tool_calls: r.tool_calls, avg_tps: r.avg_tps,
          last: r.last ? { tps: r.last.tps } : null,
          last_turn: r.last_turn ? { total: r.last_turn.total, requests: r.last_turn.requests, tps: r.last_turn.tps } : null,
          today_total: d.today ? d.today.total : null,
          today_turns: d.today ? d.today.turns : null,
          today_requests: d.today ? d.today.requests : null,
        };
        const chips = filterChipsByShow(chipsFromSession(r, d.today), clientCfg);
        sendSnapshot(taskId, d, chips);
      } catch (e) { lastError = "parse: " + ((e && e.message) || e); diag(); }
    });
  }

  /* 能力公告帧（v346 握手起点，打破死锁）：桌面等手机配置才推、手机等 zuUpCap 才发配置，
   * 两者互等。这里在「有活跃桥」时不依赖 target/clientReady 周期发极小公告
   * （~80B，仅能力声明），手机收到即上行配置 → 桌面门控打开 → 开始推数据。
   * 无补丁宿主不会发此帧，油猴因此绝不会对无钩子连接上行（安全门不受影响）。 */
  let lastAnnounceAt = 0;
  function announce() {
    refreshBridges();
    wrapUplinkHooks();
    if (!live.length) return;
    const now = Date.now();
    if (now - lastAnnounceAt < ANNOUNCE_MS) return;
    lastAnnounceAt = now;
    const body = { zm: 1, ts: now, zuUpCap: UPLINK_CAP, cfgGen: clientCfgGen };
    let frame;
    try { frame = encodeEventFireFrame(JSON.stringify(body)); }
    catch (e) { sendErr++; lastError = "announce encode: " + ((e && e.message) || e); return; }
    for (const e of live.slice()) {
      try { e.p.send(frame); }
      catch (err) {
        sendErr++; lastError = ((err && err.message) || String(err)).slice(0, 160);
        const idx = live.indexOf(e);
        if (idx >= 0) live.splice(idx, 1);
      }
    }
  }

  /* 快照推送：载荷 = {zm, ts, target, mine, zuUpCap, cfgGen, snap, chips}。
   * snap 是桌面 overlay 可直接消费的 zusage 快照（手机端跑同一份 overlay.js 渲染，
   * 样式/面板/tooltip 全量照抄）；chips 仅作 overlay 加载失败时旧脚本的降级渲染；
   * >256KB 时依次裁 speed_history → chips（rpc-frame 单分片上限）。 */
  function sendSnapshot(taskId, snap, chips) {
    refreshBridges();
    if (!live.length) return;
    delete snap.all_projects;      // 手机端项目格用 sess.project，整库聚合体积大且不用
    delete snap.known_sids;
    const mine = taskId;
    const now = Date.now();
    const key = JSON.stringify({ t: mine, s: snap });
    if (key === lastSnapKey && now - lastSnapAt < HEARTBEAT_MS) { skippedDup++; return; }
    /* zuUpCap/cfgGen：上行能力握手与配置回执（油猴据此决定能否上行/是否停重试） */
    let body = { zm: 1, ts: now, target: currentTarget, mine: mine,
      zuUpCap: UPLINK_CAP, cfgGen: clientCfgGen, snap: snap, chips: chips };
    let json = JSON.stringify(body);
    if (json.length > MAX_JSON_BYTES) { delete body.snap.speed_history; json = JSON.stringify(body); }
    if (json.length > MAX_JSON_BYTES) { delete body.chips; json = JSON.stringify(body); }
    if (json.length > MAX_JSON_BYTES) { droppedOversize++; lastError = "snap oversize"; diag(); return; }
    if (now - lastSnapAt < getMinIntervalMs()) { throttled++; return; }
    let frame;
    try { frame = encodeEventFireFrame(json); }
    catch (e) { sendErr++; lastError = "encode: " + ((e && e.message) || e); return; }
    let okCount = 0;
    for (const e of live.slice()) {
      try { e.p.send(frame); okCount++; }
      catch (err) {
        sendErr++; lastError = ((err && err.message) || String(err)).slice(0, 160);
        const idx = live.indexOf(e);
        if (idx >= 0) live.splice(idx, 1);
      }
    }
    if (okCount > 0) {
      pushed++; lastPushAt = now; lastSnapAt = now; lastSnapKey = key; lastMode = "snap";
      lastPushedChips = chips;
      diag();
    }
  }

  /* 事件驱动（v346，与桌面同款）：inject-main 的 DB watcher（300ms 去抖）与兜底心跳
   * 都调 pump()；查询节流 = activity_min_ms（getter 实时读，改配置即生效），
   * 不满足时补一拍，保证限频窗口内的最后一笔写入一定被取到（scheduleRetry 同款）。 */
  let pumpTimer = 0, pumpTimerDue = 0;
  /* 已有排程时允许「更早的重排」：改小 activity_min_ms 或目标切换后应立即补拍，
   * 不能被先前按旧限频排下的长等待拖住（桌面 scheduleRetry 只保留最后一次，
   * 这里取更早者——语义上是「最早可查时刻」，两者等价且不受旧值牵制）。 */
  function schedulePump(delayMs) {
    const due = Date.now() + Math.max(0, delayMs || 0);
    if (pumpTimer) {
      if (pumpTimerDue <= due) return;   // 已有更早的排程
      clearTimeout(pumpTimer);
      pumpTimer = 0;
    }
    pumpTimerDue = due;
    pumpTimer = setTimeout(function () {
      pumpTimer = 0;
      try { pump(); } catch (e) { }
    }, Math.max(0, due - Date.now()));
    if (pumpTimer && typeof pumpTimer.unref === "function") pumpTimer.unref();
  }
  function clearPump() {
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = 0; pumpTimerDue = 0; }
  }
  /* 一次对账：门控（clientReady）→ 目标 → 节流 → 查询推送。 */
  function pump() {
    drainUplink();
    if (!currentTarget || !clientReady) return false;
    refreshBridges();
    if (!live.length) return false;                  // 无远控连接：不查库
    const taskId = String(currentTarget.taskId);
    if (queryBusy) { schedulePump(300); return false; }
    const now = Date.now();
    const limit = getMinIntervalMs();
    if (now - lastQueryAt < limit) { schedulePump(limit - (now - lastQueryAt)); return false; }
    queryAndPush(taskId);
    diagThrottled();
    return true;
  }

  /* 渲染端上报：{zm:1, ts, target, bySession}。目标变化立即 pump；同一目标等 DB 事件。
   * 无手机配置（clientReady=false）时不查库不推——门控在 pump 内。 */
  function push(payload) {
    if (!payload || payload.zm !== 1) return false;
    const tgt = payload.target && payload.target.taskId ? payload.target : null;
    const prevTaskId = currentTarget ? currentTarget.taskId : "";
    currentTarget = tgt;
    if (!tgt) { clearPump(); skippedNoTarget++; return false; }
    const taskId = String(tgt.taskId);
    if (taskId !== prevTaskId) clearPump();   // 目标变化：立即对账（不受旧节流限制）
    schedulePump(taskId !== prevTaskId ? 0 : 0);
    return true;
  }

  diag({ entries: stash().filter((e) => e.b && e.b.relayProtocol).map((e) => ({
    bridgeSessionId: e.b.bridgeSessionId ? String(e.b.bridgeSessionId).slice(0, 12) : null,
    workspacePath: e.b.workspacePath || null,
  })) });

  return {
    push,
    status: () => ({
      bridges: live.length, pushed, droppedOversize, skippedDup, throttled, sendErr,
      skippedNoTarget, queryRuns, lastPushAt, lastError, lastMode,
      clientReady, clientCfgGen, uplinkFrames,
      target: currentTarget ? currentTarget.taskId : null,
    }),
    /* 测试接缝：DB 事件正常由 inject-main 调用（冷文件），测试直调 */
    pump,
    dispose: () => { if (bridgeTimer) clearInterval(bridgeTimer); if (announceTimer) clearInterval(announceTimer); clearPump(); stopResident(); live = []; },
  };
}

module.exports = { createMobileRelay, MOBILE_RELAY_MAGIC_ID: MAGIC_ID, chipsFromSession, tpsBand };
