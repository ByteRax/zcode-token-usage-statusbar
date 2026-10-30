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
  const calls = { relaunch: 0, quit: 0, deliveries: [], executed: 0 };
  const app = {
    relaunch: () => { calls.relaunch++; },
    quit: () => { calls.quit++; },
  };
  const wc = {
    isDestroyed: () => false,
    getURL: () => url,
    executeJavaScript: async () => { calls.executed++; return requests; },
  };
  vm.runInNewContext(slice + "\npollPluginRequests();", {
    path, console: { log: () => {} },
    process: { platform: process.platform, resourcesPath: RESOURCES },
    fileURLToPath: require("url").fileURLToPath,
    webContents: { getAllWebContents: () => [wc] },
    isMainWindowState: () => main,
    deliverPluginRequest: (w, requestId, result) => calls.deliveries.push({ requestId, result: { ...result } }),   // 浅拷贝出宿主 realm 对象供 deepStrictEqual
    app, LOG: () => {}, pluginRequestBusy: false, pluginUpdater: updater,
    setTimeout, clearTimeout,   // relaunch 分支延迟 quit 用（沙箱无全局定时器）
  });
  return { calls, settle: () => new Promise((resolve) => setTimeout(resolve, 450)) };
}

test("relaunch action replies ok then relaunches via quit (before-quit cleanup path)", async () => {
  const { calls, settle } = runPoll([{ action: "relaunch", requestId: "zusage-relaunch-1" }]);
  await settle();
  assert.deepEqual(calls.deliveries, [{ requestId: "zusage-relaunch-1", result: { ok: true } }]);   // 回执先送达
  assert.deepEqual([calls.relaunch, calls.quit], [1, 1]);   // 再 relaunch 标记 + quit（清理钩子自然执行）
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
