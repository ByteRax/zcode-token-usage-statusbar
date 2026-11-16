"use strict";
// v172「重启 ZCode」动作回归：pollPluginRequests 白名单分支切片直跑——
// 先回执再延迟 relaunch+quit（quit 走 before-quit 清理钩子）；窗口验证沿用既有判据。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

const { getInjectSlice, sliceInject } = require("./helpers/overlay-extract.cjs");
const slice = getInjectSlice("pollPluginRequests");
assert.ok(slice.includes('req.action === "relaunch"'), "relaunch 分支必须在切片内（白名单契约）");

const RESOURCES = path.join(path.sep, "client", "resources");
const HOST_URL = pathToFileURL(path.join(RESOURCES, "app", "out", "main", "index.js")).href;

function runPoll(requests, url = HOST_URL, main = true, updater = null, hooks = {}) {
  const calls = { relaunch: 0, quit: 0, deliveries: [], executed: 0, hides: 0, beforeQuit: [] };
  const app = {
    relaunch: () => { calls.relaunch++; },
    quit: () => { calls.quit++; if (hooks.quitThrows) throw new Error("quit boom"); },
    once: (evt, fn) => { if (evt === "before-quit") calls.beforeQuit.push(fn); },   // issue #372：取消监听
  };
  const wc = {
    isDestroyed: () => false,
    getURL: () => url,
    executeJavaScript: async () => { calls.executed++; return requests; },
  };
  const win = { isVisible: () => true, hide: () => { calls.hides++; } };   // v245：quit 前 hide 全部窗口
  vm.runInNewContext(slice + "\npollPluginRequests();", {
    path, console: { log: () => {} },
    process: { platform: process.platform, resourcesPath: RESOURCES },
    fileURLToPath: require("url").fileURLToPath,
    webContents: { getAllWebContents: () => [wc] },
    isMainWindowState: () => main,
    deliverPluginRequest: (w, requestId, result) => calls.deliveries.push({ requestId, result: { ...result } }),   // 浅拷贝出宿主 realm 对象供 deepStrictEqual
    app, LOG: () => {}, pluginRequestBusy: false, pluginUpdater: updater,
    BrowserWindow: { getAllWindows: () => [win] },
    pendingAsarPath: hooks.pendingAsarPath || (() => ""),
    writeRelaunchRequest: hooks.writeRelaunchRequest || (() => 1),
    clearRelaunchRequest: hooks.clearRelaunchRequest || (() => {}),
    setTimeout, clearTimeout,   // relaunch 分支延迟 quit 用（沙箱无全局定时器）
  });
  return { calls, settle: () => new Promise((resolve) => setTimeout(resolve, 60)) };
}

test("relaunch action replies ok then relaunches via quit (before-quit cleanup path)", async () => {
  const { calls, settle } = runPoll([{ action: "relaunch", requestId: "zusage-relaunch-1" }]);
  await settle();
  assert.deepEqual(calls.deliveries, [{ requestId: "zusage-relaunch-1", result: { ok: true } }]);   // 回执先送达
  assert.deepEqual([calls.relaunch, calls.quit], [1, 1]);   // 再 relaunch 标记 + quit（清理钩子自然执行）
  assert.equal(calls.hides, 1, "v245：quit 前 hide 窗口——退出屏障期间窗口全程可见是宿主行为，感知退出应即时");
});

test("issue #372 pending asar hands the restart to the monitor (quit-only, no hide)", async () => {
  // 有合法待收尾 asar 时不能 app.relaunch：Windows relauncher 助手是 ZCode.exe，
  // monitor 的「全部进程退出」判据永不成立。必须写交接请求 + quit-only，且不隐藏窗口
  // （宿主 before-quit 的「确认退出」弹窗需要可见父窗口）。
  const written = [];
  const { calls, settle } = runPoll([{ action: "relaunch", requestId: "zusage-handover-1" }], HOST_URL, true, null, {
    pendingAsarPath: () => "C:\\client\\resources\\app.asar",
    writeRelaunchRequest: (asar) => { written.push(asar); return 1794849917517; },
  });
  await settle();
  assert.deepEqual(calls.deliveries, [{ requestId: "zusage-handover-1", result: { ok: true } }]);
  assert.deepEqual([calls.relaunch, calls.quit, calls.hides], [0, 1, 0], "quit-only，且不提前隐藏窗口");
  assert.deepEqual(written, ["C:\\client\\resources\\app.asar"]);
});

test("issue #372 falls back to app.relaunch when the handover request cannot be written", async () => {
  const { calls, settle } = runPoll([{ action: "relaunch", requestId: "zusage-handover-2" }], HOST_URL, true, null, {
    pendingAsarPath: () => "C:\\client\\resources\\app.asar",
    writeRelaunchRequest: () => 0,
  });
  await settle();
  assert.deepEqual([calls.relaunch, calls.quit, calls.hides], [1, 1, 1], "请求写失败回退原路径，行为不劣化");
});

test("issue #372 quit throw clears the handover request instead of leaving a ghost", async () => {
  const cleared = [];
  const { calls, settle } = runPoll([{ action: "relaunch", requestId: "zusage-handover-3" }], HOST_URL, true, null, {
    pendingAsarPath: () => "C:\\client\\resources\\app.asar",
    writeRelaunchRequest: () => 42,
    clearRelaunchRequest: (createdAt) => cleared.push(createdAt),
    quitThrows: true,
  });
  await settle();
  assert.deepEqual([calls.relaunch, calls.quit, calls.hides], [0, 1, 0]);
  assert.deepEqual(cleared, [42], "quit 同步失败按本次 createdAt 清请求");
});

test("issue #372 a cancelled quit clears the handover request at the 15s sentinel", async () => {
  // 宿主会话保护在 before-quit 里 showMessageBoxSync + preventDefault：用户取消退出后
  // 进程继续运行，残留请求必须在哨兵时撤回，否则之后 15 分钟内的手动退出+收尾会被误拉起。
  const cleared = [];
  const { calls, flush, fire, of } = runPollFake([{ action: "relaunch", requestId: "zusage-handover-cancel" }], {
    pendingAsarPath: () => "C:\\client\\resources\\app.asar",
    writeRelaunchRequest: () => 42,
    clearRelaunchRequest: (createdAt) => cleared.push(createdAt),
  });
  await flush();
  fire(of(30));
  assert.deepEqual([calls.relaunch, calls.quit, calls.hides], [0, 1, 0], "quit-only 路径不隐藏窗口");
  assert.equal(calls.beforeQuit.length, 1, "quit-only 注册 before-quit 取消监听");
  calls.beforeQuit[0]({ defaultPrevented: true });   // 用户在宿主弹窗取消退出
  fire(of(15000));
  assert.deepEqual(cleared, [42], "取消的退出在哨兵时撤回交接请求");
});

test("issue #372 a slow quit (no cancellation) must keep the handover request", async () => {
  // 退出链可超过 15s、弹窗阻塞会冻结定时器使逾期哨兵立即触发：没有 preventDefault
  // 正证据时绝不清请求，否则 monitor 收尾后无人拉起，「重启」静默变「退出」（review MAJOR）。
  const cleared = [];
  const { calls, flush, fire, of } = runPollFake([{ action: "relaunch", requestId: "zusage-handover-slow" }], {
    pendingAsarPath: () => "C:\\client\\resources\\app.asar",
    writeRelaunchRequest: () => 42,
    clearRelaunchRequest: (createdAt) => cleared.push(createdAt),
  });
  await flush();
  fire(of(30));
  assert.equal(calls.beforeQuit.length, 1);
  fire(of(15000));   // 慢退出中哨兵逾期触发：quit 未被取消（未收到 before-quit 事件）
  assert.deepEqual([calls.relaunch, calls.quit], [0, 1]);
  assert.deepEqual(cleared, [], "慢退出不清请求：请求留给 monitor 收尾后拉起");
  calls.beforeQuit[0]({ defaultPrevented: false });   // 退出在途但未被取消，同样不清
  fire(of(15000));
  assert.deepEqual(cleared, []);
});

test("issue #372 helper validates pending sidecar, writes/clears a bounded request", () => {
  const block = sliceInject("/* ---------- issue #372：待收尾 asar 的应用内重启交接 ---------- */",
    "/* ---------- issue #372 交接结束 ---------- */", { includeEnd: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-relaunch-"));
  const asar = path.join(root, "app.asar");
  const tmp = asar + ".zusage.tmp";
  const meta = tmp + ".json";
  const request = path.join(root, "relaunch-request.json");
  fs.writeFileSync(asar, "official");
  fs.writeFileSync(tmp, "patched");
  fs.writeFileSync(meta, JSON.stringify({ operation: "install", validated: true }));
  const ctx = {
    path, fs, console: { log: () => {} },
    process: {
      resourcesPath: root, execPath: "C:\\ZCode\\ZCode.exe",
      argv: ["C:\\ZCode\\ZCode.exe", "--flag"], cwd: () => root, pid: 4242,
    },
    HERE: root,
    readCfgCached: () => ({ asar_path: asar }),
    LOG: () => {},
  };
  vm.runInNewContext(block, ctx);
  assert.equal(ctx.pendingAsarPath(), path.resolve(asar), "install+validated 才是合法待收尾包");
  fs.writeFileSync(meta, JSON.stringify({ operation: "remove", validated: true }));
  assert.equal(ctx.pendingAsarPath(), "", "remove pending 不触发应用内重启交接");
  fs.writeFileSync(meta, JSON.stringify({ operation: "install", validated: false }));
  assert.equal(ctx.pendingAsarPath(), "", "未通过自检（validated!==true）的 install 也不是合法待收尾包");
  fs.writeFileSync(meta, JSON.stringify({ operation: "install", validated: true }));
  fs.rmSync(meta);
  assert.equal(ctx.pendingAsarPath(), "", "缺 sidecar 不触发应用内重启交接");
  fs.writeFileSync(meta, JSON.stringify({ operation: "install", validated: true }));
  fs.rmSync(tmp);
  assert.equal(ctx.pendingAsarPath(), "", "缺 TMP 不触发应用内重启交接");
  fs.writeFileSync(tmp, "patched");
  // review 变异 N15：config 的 asar_path 优先于 resourcesPath 缺省——自定义安装路径
  // 用户的待收尾包必须被识别（否则静默回退旧 relaunch，#372 复发）。
  const customDir = path.join(root, "custom");
  fs.mkdirSync(customDir);
  const customAsar = path.join(customDir, "app.asar");
  const customTmp = customAsar + ".zusage.tmp";
  const customMeta = customTmp + ".json";
  fs.writeFileSync(customAsar, "official custom");
  fs.writeFileSync(customTmp, "patched custom");
  fs.writeFileSync(customMeta, JSON.stringify({ operation: "install", validated: true }));
  ctx.readCfgCached = () => ({ asar_path: customAsar });
  assert.equal(ctx.pendingAsarPath(), path.resolve(customAsar), "asar_path 配置优先于缺省路径");
  ctx.readCfgCached = () => ({ asar_path: asar });
  const at = ctx.writeRelaunchRequest(asar);
  assert.ok(at > 0);
  if (process.platform !== "win32") {
    // review 变异 M15：请求文件 0600（POSIX；Windows 忽略 mode 继承 ACL，门控跳过）。
    assert.equal(fs.statSync(request).mode & 0o777, 0o600, "relaunch-request.json 必须最小暴露面");
  }
  const payload = JSON.parse(fs.readFileSync(request, "utf8"));
  assert.deepEqual(payload, {
    version: 1,
    asar: path.resolve(asar),
    argv: ["C:\\ZCode\\ZCode.exe", "--flag"],
    cwd: root,
    pid: 4242,
    createdAt: at,
  });
  ctx.clearRelaunchRequest(at - 1);
  assert.ok(fs.existsSync(request), "旧 15s 哨兵不得误删新请求");
  ctx.clearRelaunchRequest(at);
  assert.equal(fs.existsSync(request), false, "同代 createdAt 清除");
  ctx.writeRelaunchRequest(asar);
  ctx.clearRelaunchRequest();
  assert.equal(fs.existsSync(request), false, "loader 启动无参清理");
  fs.rmSync(root, { recursive: true, force: true });
});

test("800ms hard fallback quits even when the renderer never settles the receipt delivery", async () => {
  // v244 review：渲染端卡死（executeJavaScript 投递永不结算）时，回执快路径不触发——
  // 800ms 硬兜底必须独立完成 hide + relaunch + quit，不能让「点了重启」静默失效。
  const deliverSrc = getInjectSlice("deliverPluginRequest");
  assert.ok(deliverSrc.includes("executeJavaScript"), "deliverPluginRequest 切片锚点失配：结构重写后请同步更新本测试");
  const calls = { relaunch: 0, quit: 0, hides: 0 };
  const app = { relaunch: () => { calls.relaunch++; }, quit: () => { calls.quit++; } };
  const win = { visible: true, isVisible() { return this.visible; }, hide() { this.visible = false; calls.hides++; } };
  const deliveryCalls = [];
  const wc = {
    isDestroyed: () => false,
    getURL: () => HOST_URL,
    executeJavaScript: (js) => {
      if (String(js).startsWith("(function(){var q=window.__zusagePluginRequests")) {
        return Promise.resolve([{ action: "relaunch", requestId: "zusage-stall-1" }]);
      }
      deliveryCalls.push(String(js));
      return new Promise(() => { });   // 渲染端卡死：回执投递永不结算
    },
  };
  vm.runInNewContext(slice + "\n" + deliverSrc + "\npollPluginRequests();", {
    path, console: { log: () => { } },
    process: { platform: process.platform, resourcesPath: RESOURCES },
    fileURLToPath: require("url").fileURLToPath,
    webContents: { getAllWebContents: () => [wc] },
    isMainWindowState: () => true,
    isLocalHostPage: () => true,
    app, LOG: () => { }, pluginRequestBusy: false, pluginUpdater: null,
    BrowserWindow: { getAllWindows: () => [win] },
    pendingAsarPath: () => "",
    writeRelaunchRequest: () => 1,
    clearRelaunchRequest: () => {},
    setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setTimeout(resolve, 850));   // 越过 800ms 兜底
  assert.equal(deliveryCalls.length, 1, "投递确实发出过（卡死的是渲染端执行，不是没发）");
  assert.deepEqual([calls.relaunch, calls.quit], [1, 1], "投递永不结算时 800ms 硬兜底必须退出");
  assert.equal(calls.hides, 1, "硬兜底路径同样先 hide 窗口");
});

test("hide is rolled back when relaunch/quit throws synchronously", async () => {
  // v245 review：quit 同步失败不能留下「窗口消失、进程还在」的永久态——catch 分支必须恢复可见性
  const calls = { relaunch: 0, quit: 0, hides: 0, shows: 0, deliveries: [] };
  const app = {
    relaunch: () => { calls.relaunch++; throw new Error("boom"); },
    quit: () => { calls.quit++; },
  };
  const win = { visible: true, isVisible() { return this.visible; }, hide() { this.visible = false; calls.hides++; }, show() { this.visible = true; calls.shows++; } };
  const wc = {
    isDestroyed: () => false,
    getURL: () => HOST_URL,
    executeJavaScript: async () => [{ action: "relaunch", requestId: "zusage-throw-1" }],
  };
  vm.runInNewContext(slice + "\npollPluginRequests();", {
    path, console: { log: () => { } },
    process: { platform: process.platform, resourcesPath: RESOURCES },
    fileURLToPath: require("url").fileURLToPath,
    webContents: { getAllWebContents: () => [wc] },
    isMainWindowState: () => true,
    deliverPluginRequest: (w, requestId, result) => calls.deliveries.push(result),
    app, LOG: () => { }, pluginRequestBusy: false, pluginUpdater: null,
    BrowserWindow: { getAllWindows: () => [win] },
    pendingAsarPath: () => "",
    writeRelaunchRequest: () => 1,
    clearRelaunchRequest: () => {},
    setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.hides, 1);
  assert.equal(calls.shows, 1, "relaunch/quit 同步 throw 后必须 unhide 全部窗口");
  assert.equal(win.visible, true);
});

test("relaunch is ignored for URLs outside the host resources tree or non-main windows", async () => {
  for (const [url, main, label] of [
    ["file:///etc/evil/out/main/index.js", true, "越出 resourcesPath"],
    ["https://evil.example/index.html", true, "非 file: 协议"],
    [HOST_URL, false, "非主窗状态"],
  ]) {
    const { calls, settle } = runPoll([{ action: "relaunch", requestId: "zusage-relaunch-x" }], url, main);
    await settle();
    assert.deepEqual(calls.deliveries, [], label);
    assert.deepEqual([calls.relaunch, calls.quit], [0, 0], label);
    assert.equal(calls.executed, 0, label + "：不读请求队列");
  }
});

test("relaunch is rejected with ok:false while an update is in progress (v177 coverage gap)", async () => {
  // 更新进行中 quit 会打断下载/安装：必须只回执拒绝，不 relaunch 不 quit
  const { calls, settle } = runPoll([{ action: "relaunch", requestId: "zusage-relaunch-busy" }], HOST_URL, true, {
    status: () => ({ busy: true }),
  });
  await settle();
  assert.deepEqual(calls.deliveries, [{ requestId: "zusage-relaunch-busy", result: { ok: false, error: "update in progress" } }]);
  assert.deepEqual([calls.relaunch, calls.quit], [0, 0]);
});

test("unknown action gets an ok:false fallback receipt instead of silence (v180, issue #158)", async () => {
  // 浮层/主进程版本错位窗口：白名单外动作 splice 后必须回执，浮层才能给出「主进程是旧版」指引
  const { calls, settle } = runPoll([
    { action: "time-travel", requestId: "zusage-future-1" },
    { action: "x".repeat(200), requestId: "zusage-future-2" },   // 超长 action 截断回显
    { action: "no-id-action" },   // 无 requestId：保持静默（无处投递）
  ]);
  await settle();
  assert.deepEqual(calls.deliveries, [
    { requestId: "zusage-future-1", result: { ok: false, error: "unknown action: time-travel" } },
    { requestId: "zusage-future-2", result: { ok: false, error: "unknown action: " + "x".repeat(60) } },
  ]);
  assert.deepEqual([calls.relaunch, calls.quit], [0, 0]);
});

test("pushPluginState pushes the relaunchSupported capability flag (v180, issue #158)", () => {
  // 行为级：真实执行 pushPluginState，捕获推送的 payload 断言标记在列（与 relaunch 分支同文件=缺标记必无该分支）
  const psSlice = getInjectSlice("pushPluginState");
  const pushed = [];
  const wc = { isDestroyed: () => false, executeJavaScript: (js) => { pushed.push(js); return Promise.resolve(); } };
  vm.runInNewContext(psSlice + "\npushPluginState(wc, { supported: true, restartRequired: true });", {
    wc,
    isMainWindowState: () => true, isLocalHostPage: () => true,
    readCfgCached: () => ({ answer_rate_line: true, restart_notice: true }),
    quotaEnabled: () => true, resetBadgeEnabled: () => true, enhanceEnabled: () => true,
    enhanceProviderView: () => ({ available: false, version: 1, revision: 0, mode: "default", keyConfigured: false }),
    mobileEnabled: () => false,
    quotaClient: null, enginePatcher: null,
  });
  assert.equal(pushed.length, 1);
  const payload = JSON.parse(pushed[0].slice(pushed[0].indexOf("(") + 1, -1));
  assert.equal(payload.relaunchSupported, true, "pushPluginState 必须携带 relaunchSupported 能力标记（issue #158 契约）");
  assert.equal(payload.restartRequired, true, "推送不得丢弃更新器状态字段");
});

// v244/v245 时序契约：假定时器沙箱——逐 ms 断言 30ms 正式退出/800ms 硬兜底/15s 哨兵，
// 有状态窗口桩（visible 翻转）让 hide/show 可观察。
function runPollFake(requests, opts = {}) {
  const calls = { relaunch: 0, quit: 0, deliveries: [], executed: 0, hides: 0, shows: 0, timers: [], beforeQuit: [] };
  const app = {
    relaunch: () => { if (opts.relaunchThrows) throw new Error("relaunch boom"); calls.relaunch++; },
    quit: () => { calls.quit++; },
    once: (evt, fn) => { if (evt === "before-quit") calls.beforeQuit.push(fn); },   // issue #372：取消监听
  };
  if (opts.isQuitting !== undefined) app.isQuitting = opts.isQuitting;
  const wc = {
    isDestroyed: () => false,
    getURL: () => HOST_URL,
    executeJavaScript: async () => { calls.executed++; return requests; },
  };
  const win = {
    visible: true,
    isVisible() { return this.visible; },
    hide() { this.visible = false; calls.hides++; },
    show() { this.visible = true; calls.shows++; },
  };
  vm.runInNewContext(slice + "\npollPluginRequests();", {
    path, console: { log: () => { } },
    process: { platform: process.platform, resourcesPath: RESOURCES },
    fileURLToPath: require("url").fileURLToPath,
    webContents: { getAllWebContents: () => [wc] },
    isMainWindowState: () => true,
    deliverPluginRequest: opts.neverSettle
      ? (w, requestId, result) => { calls.deliveries.push({ requestId, result: { ...result } }); return new Promise(() => { }); }   // 脚本已注入、渲染端回调永不执行
      : (w, requestId, result) => { calls.deliveries.push({ requestId, result: { ...result } }); return Promise.resolve(); },
    app, LOG: () => { }, pluginRequestBusy: false, pluginUpdater: null,
    BrowserWindow: { getAllWindows: () => [win] },
    pendingAsarPath: opts.pendingAsarPath || (() => ""),
    writeRelaunchRequest: opts.writeRelaunchRequest || (() => 1),
    clearRelaunchRequest: opts.clearRelaunchRequest || (() => {}),
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms, cleared: false }); return calls.timers.length; },
    clearTimeout: (id) => { if (calls.timers[id - 1]) calls.timers[id - 1].cleared = true; },
  });
  return {
    calls, win,
    flush: () => new Promise((resolve) => setImmediate(resolve)),   // 冲微任务：deliver promise 链与 await 队列
    fire(id) { const t = calls.timers[id - 1]; if (t && !t.cleared) t.fn(); },
    of(ms) { return calls.timers.findIndex((t) => t.ms === ms) + 1; },
  };
}

test("v244 receipt lands then quit is armed at +30ms with the 800ms hard fallback cancelled", async () => {
  const { calls, flush, fire, of } = runPollFake([{ action: "relaunch", requestId: "zusage-fake-1" }]);
  await flush();
  assert.equal(calls.deliveries.length, 1, "回执先送达");
  for (const ms of [30, 800, 15000]) {
    assert.ok(calls.timers.some((t) => t.ms === ms), "挂 " + ms + "ms 定时器（30 正式退出/800 硬兜底/15s 哨兵）");
  }
  assert.equal(calls.timers[of(800) - 1].cleared, true, "回执送达后取消 800ms 兜底");
  assert.equal(calls.timers[of(30) - 1].cleared, false);
  fire(of(30));
  assert.deepEqual([calls.relaunch, calls.quit, calls.hides], [1, 1, 1], "30ms 即退出，quit 前 hide 窗口");
  calls.timers[of(800) - 1].fn();   // 兜底已被取消仍手动触发：quitArmed 必须防重入
  assert.deepEqual([calls.relaunch, calls.quit], [1, 1], "quitArmed 防重入：重复触发是 no-op");
});

test("v244 an unresponsive renderer still quits via the 800ms hard fallback", async () => {
  const { calls, flush, fire, of } = runPollFake([{ action: "relaunch", requestId: "zusage-fake-2" }], { neverSettle: true });
  await flush();
  assert.equal(calls.deliveries.length, 1, "回执已发出（渲染端无响应=回调未执行）");
  assert.ok(!calls.timers.some((t) => t.ms === 30), "30ms 正式路径未挂（回执未送达）");
  assert.ok(calls.timers.some((t) => t.ms === 800) && calls.timers.some((t) => t.ms === 15000), "兜底与哨兵照挂");
  assert.deepEqual([calls.relaunch, calls.quit, calls.hides], [0, 0, 0]);
  fire(of(800));
  assert.deepEqual([calls.relaunch, calls.quit, calls.hides], [1, 1, 1], "渲染端无响应也必须退出");
});

test("v245 a failed relaunch/quit restores hidden windows instead of leaving window ghosts", async () => {
  const { calls, win, flush, fire, of } = runPollFake([{ action: "relaunch", requestId: "zusage-fake-3" }], { relaunchThrows: true });
  await flush();
  fire(of(30));
  assert.equal(calls.hides, 1, "quit 前 hide");
  assert.deepEqual([calls.relaunch, calls.quit], [0, 0], "relaunch 同步抛错：标记与 quit 都未发生");
  assert.equal(calls.shows, 1, "quit 失败路径恢复窗口可见性（窗口消失进程还活着= ghost）");
  assert.equal(win.visible, true);
});

test("v245 the 15s sentinel unhides when quit never happens and honours app.isQuitting when exposed", async () => {
  const a = runPollFake([{ action: "relaunch", requestId: "zusage-fake-4a" }]);
  await a.flush();
  a.fire(a.of(30));   // 正式路径 quit：hide 完成、relaunch+quit 已发生
  assert.deepEqual([a.calls.hides, a.calls.shows], [1, 0]);
  a.fire(a.of(15000));   // 宿主不暴露 isQuitting → 恒真兜回 unhide（15s 后进程仍在=quit 被阻止）
  assert.deepEqual([a.calls.hides, a.calls.shows], [1, 1], "屏障超时 quit 未发生：窗口恢复可见");
  assert.equal(a.win.visible, true);
  const b = runPollFake([{ action: "relaunch", requestId: "zusage-fake-4b" }], { isQuitting: true });
  await b.flush();
  b.fire(b.of(30));
  b.fire(b.of(15000));
  assert.deepEqual([b.calls.hides, b.calls.shows], [1, 0], "退出确在进行（isQuitting）时不闪回窗口");
});

test("deliverPluginRequest resolves handled true/false around executeJavaScript (v244 promise contract)", async () => {
  const dslice = getInjectSlice("deliverPluginRequest");
  const deliverWith = (wc, isLocal = true) => {
    const ctx = { wc, isLocalHostPage: () => isLocal, out: null };
    vm.runInNewContext(dslice + "\nout = deliverPluginRequest(wc, 'id-1', { ok: true });", ctx);
    return ctx.out;
  };
  const executed = [];
  const ok = await deliverWith({ isDestroyed: () => false, executeJavaScript: async (js) => { executed.push(js); } });
  assert.equal(ok, true, "回执脚本执行成功→true（relaunch 分支据此进入 30ms quit）");
  assert.match(executed[0], /__zusagePluginResult/);
  const fail = await deliverWith({ isDestroyed: () => false, executeJavaScript: async () => { throw new Error("receiver gone"); } });
  assert.equal(fail, false, "执行失败→false 且不向上抛（不炸 poll 轮询）");
  const dead = await deliverWith({ isDestroyed: () => true, executeJavaScript: async () => { } });
  assert.equal(dead, false, "已销毁 wc→false");
  const alien = await deliverWith({ isDestroyed: () => false, executeJavaScript: async () => { } }, false);
  assert.equal(alien, false, "非宿主页→false");
});
