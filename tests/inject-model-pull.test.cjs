"use strict";
// v309 模型探测分发契约：pollPluginRequests 白名单新分支（model-pull-probe）+
// handleModelPullRequest 探测路由（provider/model 校验与 modelPuller 缺失兜底）。
// 注意：probeModel stub 无 await、同步执行，其闭包引用的记录对象必须先于 runHandle 完成初始化。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const vm = require("vm");

const { getInjectSlice, sliceInject } = require("./helpers/overlay-extract.cjs");

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function runPoll(requests) {
  const HOST_URL = require("url").pathToFileURL(path.join(path.sep, "client", "resources", "app", "out", "main", "index.js")).href;
  const wc = { isDestroyed: () => false, getURL: () => HOST_URL, executeJavaScript: async () => requests };
  const calls = { handled: [] };
  vm.runInNewContext(getInjectSlice("pollPluginRequests") + "\npollPluginRequests();", {
    path, fileURLToPath: require("url").fileURLToPath,
    process: { platform: process.platform, resourcesPath: path.join(path.sep, "client", "resources") },
    webContents: { getAllWebContents: () => [wc] },
    isMainWindowState: () => true,
    pluginRequestBusy: false,
    pluginUpdater: null, quotaClient: null, enginePatcher: null, modelPuller: null, gitTick: async () => { },
    setAnswerRateLine: () => { }, setRestartNotice: () => { }, setQuotaEnabled: () => { }, setResetBadgeEnabled: () => { },
    handleQuotaProviders: () => { }, handleQuotaSourceRequest: () => { },
    handleModelPullRequest: (req) => calls.handled.push(req),
    queryTurnText: () => { }, quotaEnabled: () => true,
    setAutoCompactPatch: () => { }, handleAutoCompactConfig: () => { },
    deliverPluginRequest: () => { },
    LOG: () => { }, setTimeout, clearTimeout, Promise,
  });
  return calls;
}

test("model-pull-probe is whitelisted in the request pump", async () => {
  const calls = runPoll([{ action: "model-pull-probe", providerId: "p1", model: "gemini-3.8-flash", requestId: "r1" }]);
  await settle();
  assert.equal(calls.handled.length, 1);
  assert.equal(calls.handled[0].action, "model-pull-probe");
});

function runHandle(req, modelPuller, calls) {
  const wc = { isDestroyed: () => false };
  vm.runInNewContext(
    sliceInject("function modelPullerProviderOk(v) {", "\n/* 渠道门控") + "\nhandleModelPullRequest(" + JSON.stringify(req) + ", wc);",
    {
      wc,
      modelPuller: modelPuller === null ? null : {
        listProviders: () => ({ ok: true, providers: [] }),
        fetchModels: () => Promise.resolve({ ok: false, error: "x" }),
        applyModels: () => Promise.resolve({ ok: true }),
        probeModel: modelPuller.probeModel,
      },
      deliverPluginRequest: (w, requestId, result) => calls.deliveries.push({ requestId, result }),
      LOG: (...a) => calls.logs.push(a.join(" ")),
      setTimeout, clearTimeout, Promise,
    },
  );
}

test("handleModelPullRequest routes probe with sanitized model; bad provider fails closed", async () => {
  const calls = { probes: [], deliveries: [], logs: [] };
  runHandle(
    { action: "model-pull-probe", providerId: "p1", model: "gemini-3.8-flash", caps: true, requestId: "r1" },
    { probeModel: async (pid, m, opts) => { calls.probes.push([pid, m, opts]); return { ok: true, model: m }; } },
    calls,
  );
  await settle();
  assert.equal(calls.probes[0][0], "p1");
  assert.equal(calls.probes[0][1], "gemini-3.8-flash");
  assert.equal(calls.probes[0][2] && calls.probes[0][2].caps, true, "v312 caps 透传");   // vm 沙箱对象原型不同，逐字段断言
  assert.equal(calls.deliveries.length, 1);
  assert.equal(calls.deliveries[0].result.ok, true);

  const bad = { probes: [], deliveries: [], logs: [] };
  runHandle(
    { action: "model-pull-probe", providerId: "p1", model: "bad\x01id", requestId: "r2" },
    { probeModel: async (pid, m) => { bad.probes.push([pid, m]); return { ok: false, kind: "invalid_model" }; } },
    bad,
  );
  await settle();
  assert.deepEqual(bad.probes, [["p1", ""]], "控制字符模型 id 在主进程边界清洗为空，由 probeModel 报 invalid_model");

  const badProvider = { probes: [], deliveries: [], logs: [] };
  runHandle(
    { action: "model-pull-probe", providerId: "bad\x02id", model: "m", requestId: "r3" },
    { probeModel: async () => { throw new Error("must not run"); } },
    badProvider,
  );
  await settle();
  assert.equal(badProvider.deliveries[0].result.error, "invalid provider");

  const missing = { probes: [], deliveries: [], logs: [] };
  runHandle(
    { action: "model-pull-probe", providerId: "p1", model: "m", requestId: "r4" },
    null,
    missing,
  );
  await settle();
  assert.ok(missing.deliveries[0].result.error.indexOf("model puller unavailable") === 0, "旧主进程模块缺失时给明确指引");
});
