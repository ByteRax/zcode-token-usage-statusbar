"use strict";
// v172「重启 ZCode」动作回归：pollPluginRequests 白名单分支切片直跑——
// 先回执再延迟 relaunch+quit（quit 走 before-quit 清理钩子）；窗口验证沿用既有判据。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const a = source.indexOf("async function pollPluginRequests() {");
const b = source.indexOf("setInterval(pollPluginRequests, 1000);", a);
assert.ok(a >= 0 && b > a, "pollPluginRequests 切片锚点失配：结构重写后请同步更新本测试");
const slice = source.slice(a, b);
assert.ok(slice.includes('req.action === "relaunch"'), "relaunch 分支必须在切片内（白名单契约）");

const RESOURCES = path.join(path.sep, "client", "resources");
const HOST_URL = pathToFileURL(path.join(RESOURCES, "app", "out", "main", "index.js")).href;

function runPoll(requests, url = HOST_URL, main = true, updater = null) {
  const calls = { relaunch: 0, quit: 0, deliveries: [], executed: 0, hides: 0 };
  const app = {
    relaunch: () => { calls.relaunch++; },
    quit: () => { calls.quit++; },
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
    setTimeout, clearTimeout,   // relaunch 分支延迟 quit 用（沙箱无全局定时器）
  });
  return { calls, settle: () => new Promise((resolve) => setTimeout(resolve, 450)) };
}

test("relaunch action replies ok then relaunches via quit (before-quit cleanup path)", async () => {
  const { calls, settle } = runPoll([{ action: "relaunch", requestId: "zusage-relaunch-1" }]);
  await settle();
  assert.deepEqual(calls.deliveries, [{ requestId: "zusage-relaunch-1", result: { ok: true } }]);   // 回执先送达
  assert.deepEqual([calls.relaunch, calls.quit], [1, 1]);   // 再 relaunch 标记 + quit（清理钩子自然执行）
  assert.equal(calls.hides, 1, "v245：quit 前 hide 窗口——退出屏障期间窗口全程可见是宿主行为，感知退出应即时");
});

test("800ms hard fallback quits even when the renderer never settles the receipt delivery", async () => {
  // v244 review：渲染端卡死（executeJavaScript 投递永不结算）时，回执快路径不触发——
  // 800ms 硬兜底必须独立完成 hide + relaunch + quit，不能让「点了重启」静默失效。
  const dA = source.indexOf("function deliverPluginRequest");
  const dB = source.indexOf("\n}", dA) + 2;
  const deliverSrc = source.slice(dA, dB);
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
    setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));   // 越过 800ms 兜底
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
    setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
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
  const psA = source.indexOf("function pushPluginState(wc, state) {");
  // v206 起 ack 前置到更新器初始化之前，pushPluginState 与 try 块之间插入了 ack 调用：切片止于 ack 注释
  const psB = source.indexOf("\n/* ack 必须先于更新器初始化", psA);
  assert.ok(psA >= 0 && psB > psA, "pushPluginState 切片锚点失配：结构重写后请同步更新本测试");
  const pushed = [];
  const wc = { isDestroyed: () => false, executeJavaScript: (js) => { pushed.push(js); return Promise.resolve(); } };
  vm.runInNewContext(source.slice(psA, psB) + "\npushPluginState(wc, { supported: true, restartRequired: true });", {
    wc,
    isMainWindowState: () => true, isLocalHostPage: () => true,
    readCfgCached: () => ({ answer_rate_line: true, restart_notice: true }),
    quotaEnabled: () => true, resetBadgeEnabled: () => true,
    quotaClient: null, enginePatcher: null,
  });
  assert.equal(pushed.length, 1);
  const payload = JSON.parse(pushed[0].slice(pushed[0].indexOf("(") + 1, -1));
  assert.equal(payload.relaunchSupported, true, "pushPluginState 必须携带 relaunchSupported 能力标记（issue #158 契约）");
  assert.equal(payload.restartRequired, true, "推送不得丢弃更新器状态字段");
});
