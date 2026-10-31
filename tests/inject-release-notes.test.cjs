"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "切片锚点失配：结构重写后请同步更新本测试");
  return source.slice(a, b);
}

/* handleReleaseNotesRequest 单测：渠道门控、参数收敛与回执形状。
 * releaseNotes / readChannel / electron app 全部经沙箱注入。 */
const handlerSource = extract("async function handleReleaseNotesRequest(req, wc) {", "\n/* 逐问速率行开关");
function runHandler(req, { channel = null, service = null, noService = false } = {}) {
  const deliveries = [];
  const wc = {};
  const sandbox = {
    req, wc,
    deliverPluginRequest: (w, requestId, result) => deliveries.push({ requestId, result: { ...result } }),   // 展开：把 VM 域对象拷回测试域，便于 deepEqual
    releaseNotes: noService ? null : (service || { getNotes: async (p) => ({ ok: true, tag: "v1.5.7", body: "b", flavor: p.flavor, repository: p.repository, version: p.version, force: p.force }),
      getList: async (p) => ({ ok: true, releases: [{ tag: "v1.5.7" }], flavor: p.flavor, repository: p.repository, force: p.force }) }),
    require: (id) => (id === "./plugin-release.cjs" ? { readChannel: () => channel } : {}),
    app: { getPath: () => "/home" },
    LOG: () => {},
  };
  vm.runInNewContext(handlerSource + "\nhandleReleaseNotesRequest(req, wc);", sandbox);
  return { wait: (ms = 30) => new Promise((r) => setTimeout(r, ms)), deliveries };
}

test("release notes handler refuses non-release channels before any fetch", async () => {
  for (const channel of [null, { kind: "local" }, { kind: "market", flavor: "github", repository: "a/b" }]) {
    let fetched = 0;
    const r = runHandler({ action: "release-notes", version: "1.5.7", requestId: "r1" },
      { channel, service: { getNotes: async () => { fetched++; return { ok: true }; }, getList: async () => ({ ok: true }) } });
    await r.wait();
    assert.equal(fetched, 0, JSON.stringify(channel));
    assert.deepEqual(r.deliveries, [{ requestId: "r1", result: { ok: false, reason: "unsupported-channel" } }]);
  }
});

test("release notes handler resolves flavor/repository from the registered channel only", async () => {
  const channel = { kind: "release", flavor: "gitcode", repository: "tanranran/zcode-token-usage-statusbar" };
  const seen = [];
  const r = runHandler({ action: "release-notes", version: "1.5.7", force: true, flavor: "github", repository: "evil/x", requestId: "r2" },
    { channel, service: { async getNotes(p) { seen.push({ ...p }); return { ok: true }; }, async getList() { return { ok: true }; } } });
  await r.wait();
  // 页面传入的 flavor/repository 被丢弃：目标完全由主进程读到的注册渠道决定
  assert.deepEqual(seen, [{ flavor: "gitcode", repository: "tanranran/zcode-token-usage-statusbar", version: "1.5.7", force: true }]);
  assert.equal(r.deliveries[0].requestId, "r2");
  assert.equal(r.deliveries[0].result.ok, true);
});

test("release notes handler routes the list action and truncates the version param", async () => {
  const channel = { kind: "release", flavor: "github", repository: "a/b" };
  const seen = [];
  const service = { async getNotes(p) { seen.push(["notes", { ...p }]); return { ok: true }; }, async getList(p) { seen.push(["list", { ...p }]); return { ok: true }; } };
  const list = runHandler({ action: "release-notes-list", requestId: "r3" }, { channel, service });
  await list.wait();
  const notes = runHandler({ action: "release-notes", version: "x".repeat(80), requestId: "r4" }, { channel, service });
  await notes.wait();
  assert.deepEqual(seen[0], ["list", { flavor: "github", repository: "a/b", force: false }]);
  assert.equal(seen[1][1].version.length, 32);
  assert.equal(seen[1][0], "notes");
});

test("release notes handler answers unsupported when the service failed to load, errors never throw past the handler", async () => {
  const none = runHandler({ action: "release-notes", requestId: "r5" }, { noService: true });
  await none.wait();
  assert.deepEqual(none.deliveries, [{ requestId: "r5", result: { ok: false, reason: "unsupported" } }]);
  const channel = { kind: "release", flavor: "github", repository: "a/b" };
  const boom = runHandler({ action: "release-notes", version: "1.0.0", requestId: "r6" },
    { channel, service: { getNotes: async () => { throw new Error("disk full"); }, getList: async () => { throw new Error("x"); } } });
  await boom.wait();
  assert.equal(boom.deliveries[0].result.ok, false);
  assert.equal(boom.deliveries[0].result.reason, "error");
  assert.equal(boom.deliveries[0].result.message, "disk full");
});

/* pollPluginRequests 白名单分支：release-notes / release-notes-list 进分发，且白名单外动作仍回 unknown。 */
const pollSource = extract("async function pollPluginRequests() {", "setInterval(pollPluginRequests, 1000);");
function runPoll(requests, handled) {
  const deliveries = [];
  const wc = { isDestroyed: () => false, getURL: () => "file://" + path.join(process.resourcesPath || "/r", "x.html"),
    executeJavaScript: async () => requests };
  vm.runInNewContext(pollSource + "\npollPluginRequests();", {
    path, console: { log: () => {} },
    process: { platform: process.platform, resourcesPath: process.resourcesPath || "/r" },
    webContents: { getAllWebContents: () => [wc] },
    isMainWindowState: () => true,
    fileURLToPath: (u) => u.slice("file://".length),
    deliverPluginRequest: (w, id, result) => deliveries.push({ requestId: id, result: { ...result } }),
    handleReleaseNotesRequest: (req, w) => handled.push({ action: req.action, version: req.version }),
    LOG: () => {}, pluginRequestBusy: false, pluginUpdater: null, modelPuller: null, quotaClient: null,
    pluginUpdaterOr: null, setTimeout, clearTimeout,
    quotaEnabled: () => false, resetBadgeEnabled: () => false, readCfgCached: () => ({}),
  });
  return { wait: (ms = 30) => new Promise((r) => setTimeout(r, ms)), deliveries };
}

test("pollPluginRequests routes the two release-notes actions and keeps the unknown-action reply", async () => {
  const handled = [];
  runPoll([
    { action: "release-notes", version: "1.5.7", requestId: "a" },
    { action: "release-notes-list", requestId: "b" },
    { action: "release-notes-evil", requestId: "c" },
  ], handled);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(handled, [{ action: "release-notes", version: "1.5.7" }, { action: "release-notes-list", version: undefined }]);   // 白名单外动作不分发
});
