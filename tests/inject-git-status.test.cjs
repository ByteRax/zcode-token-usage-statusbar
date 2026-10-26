"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

/* v96 Git 状态旁路查询：整文件 vm 加载（同 inject-remote-recovery 模式），execFile 按 args
 * 分发夹具响应。覆盖 parseGitPorcelain/parseShortstat 纯函数、queryGitStatus 失败分类与
 * 无提交仓库回退、gitTick 的路径校验/去重/多窗口分发/非本地页忽略、git-refresh 动作路由。 */
function loadPump(respond = () => ({})) {
  const intervals = [], timers = new Map(), windows = [], execs = [];
  let id = 0;
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? "{}" : "",
    statSync: file => {
      if (["/fixture/repo", "/fixture/repo2", "/fixture/parent", "/fixture/parent/a", "/fixture/parent/b"].includes(file)) return { isDirectory: () => true, mtimeMs: 1 };
      if (["/fixture/runtime/overlay.js", "/fixture/runtime/zusage.py"].includes(file)) return { mtimeMs: 1, size: 1 };
      throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
    },
    readdirSync: dir => dir === "/fixture/parent" ? ["a", "b"] : [],
    existsSync: file => ["/fixture/parent/a/.git", "/fixture/parent/b/.git"].includes(file), watch: () => ({ on() {} }), writeFileSync() {},
  };
  const ipc = new EventEmitter();
  const sandbox = {
    __dirname: "/fixture/runtime", console: { error() {} },
    process: { resourcesPath: "/fixture/resources", execPath: process.execPath, uptime: () => 1, env: {} },
    module: { exports: {} },
    setTimeout: (fn, ms) => { timers.set(++id, fn); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    require(name) {
      if (name === "fs") return mockFs;
      if (["path", "url", "crypto"].includes(name)) return require(name);
      if (name === "electron") return { app: { getPath: () => "/fixture/home", on() {} }, webContents: { getAllWebContents: () => windows }, ipcMain: ipc };
      if (name === "child_process") return {
        spawn() {
          const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
          p.stdin = new EventEmitter(); p.stdin.writable = true; p.kill = () => {}; return p;
        },
        execFile(cmd, args, opts, cb) {
          execs.push({ cmd, args, opts });
          let r = {};
          try { r = respond(args) || {}; } catch (e) { r = { error: e }; }
          if (r.wait) r.wait.then(() => cb(r.error || null, r.stdout || "", r.stderr || ""));
          else cb(r.error || null, r.stdout || "", r.stderr || "");
        },
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  function addWindow(url = "file:///fixture/resources/index.html") {
    const wc = { id: windows.length + 1, gitPaths: [], requests: [], pushes: [],
      getType: () => "window", isDestroyed: () => false, getURL: () => url,
      executeJavaScript: async js => {
        if (js.includes("__zusageGitPaths")) return JSON.stringify(wc.gitPaths);
        if (js.includes("__zusagePluginRequests")) return wc.requests.splice(0, 8);
        if (js.startsWith("window.__zusageGitState") || js.startsWith("window.__zusageUpdate") || js.startsWith("window.__zusagePluginResult")) wc.pushes.push(js);
        return "null";
      } };
    windows.push(wc); return wc;
  }
  return { api: sandbox.module.exports.__zusageTest, intervals, execs, addWindow };
}

/* ---------- parseGitPorcelain ---------- */

test("parseGitPorcelain: upstream with ahead/behind, per-code counts, rename and conflict", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main...origin/main [ahead 2, behind 1]\nM  a.py\n M b.py\n?? c.py\nR  d.txt\nDD e.py\nA  f.py\n!! ign\n");
  assert.deepEqual({ ...r }, { branch: "main", upstream: "origin/main", ahead: 2, behind: 1,
    detached: false, noCommits: false, staged: 3, unstaged: 1, untracked: 1, conflicts: 1, changed: 5 });
});

test("parseGitPorcelain: bare branch without upstream tracks nothing", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main\n");
  assert.deepEqual([r.branch, r.upstream, r.ahead, r.behind], ["main", "", 0, 0]);
});

test("parseGitPorcelain: detached HEAD and ahead-only tracking", async () => {
  const { api } = loadPump();
  const d = api.parseGitPorcelain("## HEAD (no branch)\n");
  assert.deepEqual([d.detached, d.branch, d.upstream], [true, "", ""]);
  const a = api.parseGitPorcelain("## feat/x...origin/feat/x [ahead 3]\n");
  assert.deepEqual([a.branch, r_up(a)], ["feat/x", "origin/feat/x"]);
  assert.deepEqual([a.ahead, a.behind], [3, 0]);
  function r_up(x) { return x.upstream; }
});

test("parseGitPorcelain: gone upstream and no-commits / initial-commit headers", async () => {
  const { api } = loadPump();
  const g = api.parseGitPorcelain("## main...origin/main [gone]\n");
  assert.deepEqual([g.upstream, g.ahead, g.behind], ["origin/main", 0, 0]);
  const nc = api.parseGitPorcelain("## No commits yet on main\n?? x\n");
  assert.deepEqual([nc.noCommits, nc.branch, nc.untracked], [true, "main", 1]);
  const ic = api.parseGitPorcelain("## Initial commit on dev\n");
  assert.deepEqual([ic.noCommits, ic.branch], [true, "dev"]);
});

test("parseGitPorcelain: tolerates CRLF line endings and empty input", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main\r\nM  a\r\n?? b\r\n");
  assert.deepEqual([r.branch, r.staged, r.untracked], ["main", 1, 1]);
  assert.deepEqual({ ...api.parseGitPorcelain("") },
    { branch: "", upstream: "", ahead: 0, behind: 0, detached: false, noCommits: false, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, changed: 0 });
});

/* ---------- parseShortstat ---------- */

test("parseShortstat: both, singular and half-present forms", async () => {
  const { api } = loadPump();
  assert.deepEqual({ ...api.parseShortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n") }, { ins: 12, del: 4 });
  assert.deepEqual({ ...api.parseShortstat(" 1 file changed, 1 insertion(+)\n") }, { ins: 1, del: 0 });
  assert.deepEqual({ ...api.parseShortstat(" 2 files changed, 5 deletions(-)\n") }, { ins: 0, del: 5 });
  assert.deepEqual({ ...api.parseShortstat("") }, { ins: 0, del: 0 });
});

/* ---------- queryGitStatus ---------- */

test("queryGitStatus: one status + one diff HEAD call with locked-down env, merged result", async () => {
  const respond = args => args.includes("status")
    ? { stdout: "## main...origin/main [ahead 2]\n M a\n" }
    : { stdout: " 3 files changed, 12 insertions(+), 4 deletions(-)\n" };
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.equal(st.ok, true);
  assert.deepEqual([st.branch, st.ahead, st.ins, st.del, st.unstaged], ["main", 2, 12, 4, 1]);
  assert.equal(typeof st.ts, "number");
  assert.deepEqual(execs.map(e => [...e.args]), [
    ["-C", "/fixture/repo", "status", "--porcelain", "--branch"],
    ["-C", "/fixture/repo", "diff", "HEAD", "--shortstat"],
  ]);
  assert.equal(execs[0].cmd, "git");
  assert.equal(execs[0].opts.env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(execs[0].opts.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(execs[0].opts.env.LC_ALL, "C");
  assert.equal(execs[0].opts.timeout, 8000);
  assert.equal(execs[0].opts.windowsHide, true);
});

test("queryGitStatus: exit-128 not-a-repository maps to notrepo without running diff", async () => {
  const respond = () => ({ error: { code: 128 }, stderr: "fatal: not a git repository (or any of the parent directories): .git" });
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.deepEqual([st.ok, st.reason], [false, "notrepo"]);
  assert.equal(execs.length, 1);
});

test("queryGitStatus: ENOENT maps to nogit (single attempt, no diff)", async () => {
  const respond = () => ({ error: { code: "ENOENT" } });
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.deepEqual([st.ok, st.reason], [false, "nogit"]);
  assert.equal(execs.length, 1);
});

test("queryGitStatus: timed-out diff HEAD reports timeout without the two-call fallback", async () => {
  const respond = args => args.includes("status")
    ? { stdout: "## main\n" }
    : { error: { killed: true } };
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.deepEqual([st.ok, st.reason], [false, "timeout"]);
  assert.equal(execs.length, 2, "status + diff HEAD，超时不走回退");
});

test("queryGitStatus: commit-less repo falls back to unstaged + cached shortstat sum", async () => {
  const respond = args => {
    const cmd = args.join(" ");   // Array.includes 按整元素比较，"–cached"/"HEAD" 需按整串子串判断
    if (cmd.includes(" status ")) return { stdout: "## No commits yet on main\n" };
    if (cmd.includes("--cached")) return { stdout: " 1 file changed, 1 insertion(+)\n" };
    if (cmd.includes(" HEAD ")) return { error: { code: 128 }, stderr: "fatal: ambiguous argument 'HEAD': unknown revision" };
    return { stdout: " 1 file changed, 2 insertions(+)\n" };
  };
  const { api, execs } = loadPump(respond);
  const st = await api.queryGitStatus("/fixture/repo");
  assert.equal(st.ok, true);
  assert.deepEqual([st.noCommits, st.branch, st.ins, st.del], [true, "main", 3, 0]);
  assert.deepEqual(execs.map(e => e.args.filter(a => a !== "-C" && a !== "/fixture/repo")).map(a => [...a]), [
    ["status", "--porcelain", "--branch"],
    ["diff", "HEAD", "--shortstat"],
    ["diff", "--shortstat"],
    ["diff", "--cached", "--shortstat"],
  ]);
});

/* ---------- gitTick / 推送 / 动作路由 ---------- */

test("gitTick: dedupes valid local paths, filters invalid ones, pushes to each declaring window", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\n" } : { stdout: "" };
  const h = loadPump(respond);
  const a = h.addWindow(), b = h.addWindow(), web = h.addWindow("https://example.com/");
  a.gitPaths = ["/fixture/repo", "relative", "/missing/repo", "/fixture/repo"];
  b.gitPaths = ["/fixture/repo"];
  web.gitPaths = ["/fixture/repo"];   // 非 file: 页面不读不推
  await h.api.gitTick(false); await flush();
  assert.equal(h.execs.filter(e => e.args.includes("status")).length, 1, "同仓库多窗口只查一次；非法/相对/不存在路径被过滤");
  const pick = wc => wc.pushes.find(js => js.startsWith("window.__zusageGitState && window.__zusageGitState(\"/fixture/repo\""));
  assert.ok(pick(a), "窗口 a 收到推送");
  assert.ok(pick(b), "窗口 b 收到推送");
  assert.equal(web.pushes.filter(js => js.includes("__zusageGitState")).length, 0, "外部页面不推");
  const payload = JSON.parse(pick(a).match(/^window\.__zusageGitState && window\.__zusageGitState\("\/fixture\/repo",(.*?)\)$/)[1]);
  assert.equal(payload.ok, true);
  assert.equal(payload.branch, "main");
});

test("gitTick: two distinct repositories each get one query", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\n" } : { stdout: "" };
  const h = loadPump(respond);
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo", "/fixture/repo2"];
  await h.api.gitTick(false); await flush();
  const queried = h.execs.filter(e => e.args.includes("status")).map(e => e.args[1]);
  assert.deepEqual(queried.sort(), ["/fixture/repo", "/fixture/repo2"]);
  assert.equal(wc.pushes.filter(js => js.includes("__zusageGitState")).length, 2);
});

test("gitTick: no wanted paths means no git processes at all", async () => {
  const h = loadPump(() => { throw new Error("should not exec"); });
  h.addWindow();
  const wc = h.addWindow();
  wc.gitPaths = [];
  await h.api.gitTick(false); await flush();
  assert.equal(h.execs.length, 0);
});

test("manual Git refresh waits for the follow-up tick when a poll is already running", async () => {
  let releaseFirst;
  let statusCalls = 0;
  const h = loadPump(args => {
    if (!args.includes("status")) return { stdout: "" };
    statusCalls++;
    if (statusCalls === 1) return { wait: new Promise(resolve => { releaseFirst = resolve; }), stdout: "## main\\n" };
    return { stdout: "## main\\n" };
  });
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  const first = h.api.gitTick(false);
  await flush();
  const refresh = h.api.gitTick(true, "manual-refresh-1", wc, "/fixture/repo");
  await flush();
  assert.equal(wc.pushes.some(js => js.includes("manual-refresh-1")), false, "busy poll must not acknowledge before the follow-up query");
  releaseFirst();
  await Promise.all([first, refresh]);
  await flush();
  assert.equal(statusCalls, 2, "manual refresh runs a second query after the existing poll");
  assert.ok(wc.pushes.some(js => js.includes("manual-refresh-1") && js.includes('"ok":true')));
});

test("manual Git refresh fails when its requested path is absent or query fails", async () => {
  const noPath = loadPump(() => ({ stdout: "## main\n" }));
  const noPathWc = noPath.addWindow();
  await noPath.api.gitTick(true, "manual-empty", noPathWc, "/fixture/missing");
  await flush();
  assert.ok(noPathWc.pushes.some(js => js.includes("manual-empty") && js.includes("no paths") && js.includes('"ok":false')));

  const noPaths = loadPump(() => ({ stdout: "" }));
  const noPathsWc = noPaths.addWindow();
  await noPaths.api.gitTick(true, "manual-no-paths", noPathsWc, "");
  await flush();
  assert.ok(noPathsWc.pushes.some(js => js.includes("manual-no-paths") && js.includes("no paths") && js.includes('"ok":false')));

  const failed = loadPump(args => args.includes("status") ? { error: { code: 128 }, stderr: "fatal: not a git repository" } : { stdout: "" });
  const failedWc = failed.addWindow();
  failedWc.gitPaths = ["/fixture/repo"];
  await failed.api.gitTick(true, "manual-failed", failedWc, "/fixture/repo");
  await flush();
  assert.ok(failedWc.pushes.some(js => js.includes("manual-failed") && js.includes("query failed") && js.includes('"ok":false')));

  const multi = loadPump(args => {
    const cmd = args.join(" ");
    if (cmd.includes("status") && cmd.includes("/fixture/parent")) return { error: { code: 128 }, stderr: "fatal: not a git repository" };
    if (cmd.includes("status") && cmd.includes("/fixture/parent/a")) return { stdout: "## main\\n" };
    if (cmd.includes("status") && cmd.includes("/fixture/parent/b")) return { error: { killed: true } };
    return { stdout: "" };
  });
  const multiWc = multi.addWindow();
  multiWc.gitPaths = ["/fixture/parent"];
  await multi.api.gitTick(true, "manual-multi-failed", multiWc, "/fixture/parent");
  await flush();
  assert.ok(multiWc.pushes.some(js => js.includes("manual-multi-failed") && js.includes("query failed") && js.includes("\"ok\":false")));
});

test("pollPluginRequests routes git-refresh to an immediate tick", async () => {
  const respond = args => args.includes("status") ? { stdout: "## main\n" } : { stdout: "" };
  const h = loadPump(respond);
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/repo"];
  wc.requests = [{ action: "git-refresh" }];
  const poll = h.intervals.find(i => i.ms === 1000);
  assert.ok(poll, "pollPluginRequests 定时器已注册");
  await poll.fn(); await flush();
  assert.ok(h.execs.some(e => e.args.includes("status")));
  assert.ok(wc.pushes.some(js => js.includes("__zusageGitState")));
  assert.equal(wc.requests.length, 0, "请求已被 splice 消费");
});

test("git refresh interval is registered at 10s", async () => {
  const h = loadPump();
  assert.ok(h.intervals.some(i => i.ms === 10000), "gitTick 10s 轮询已注册");
});

/* ---------- 2026-10-24 夜间扫描回归：IPC 门控与窗口表清理 ---------- */

/* 自含 harness：同 loadPump，但暴露 ipc 与窗口数组，直接驱动宿主同步通道处理器 */
function loadPumpIpc() {
  const intervals = [], timers = new Map(), windows = []; let id = 0;
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? "{}" : "",
    statSync: () => ({ mtimeMs: 1, size: 1 }), existsSync: () => false,
    watch: () => ({ on() {} }), writeFileSync() {},
  };
  const ipc = new EventEmitter();
  const sandbox = {
    __dirname: "/fixture/runtime", console: { error() {} },
    Buffer,
    process: { resourcesPath: "/fixture/resources", execPath: process.execPath, uptime: () => 1, env: {} },
    module: { exports: {} },
    setTimeout: (fn, ms) => { timers.set(++id, fn); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    require(name) {
      if (name === "fs") return mockFs;
      if (["path", "url", "crypto"].includes(name)) return require(name);
      if (name === "electron") return { app: { getPath: () => "/fixture/home", on() {} }, webContents: { getAllWebContents: () => windows }, ipcMain: ipc };
      if (name === "child_process") return {
        spawn() {
          const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
          p.stdin = new EventEmitter(); p.stdin.writable = true; p.kill = () => {}; return p;
        },
        execFile(cmd, args, opts, cb) { cb(null, "", ""); },
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  return { api: sandbox.module.exports.__zusageTest, ipc, windows };
}

const trustedSenderFor = id => ({ id, getType: () => "window", isDestroyed: () => false,
  getURL: () => "file:///fixture/resources/index.html" });

test("active-task-session IPC is gated by trustedSender like its sibling host channels", () => {
  const { api, ipc } = loadPumpIpc();
  ipc.emit("zcode:sync-active-task-session", { sender: trustedSenderFor(7) }, "sid_ok");
  assert.equal(api.ipcState().activeSid.get(7), "sid_ok", "trusted main-window file sender accepted");
  const external = { id: 8, getType: () => "window", isDestroyed: () => false,
    getURL: () => "https://evil.example/" };
  ipc.emit("zcode:sync-active-task-session", { sender: external }, "sid_evil");
  assert.equal(api.ipcState().activeSid.has(8), false, "external page cannot set the window session");
});

test("per-window maps are pruned when a window disappears", async () => {
  const { api, ipc, windows } = loadPumpIpc();
  const wc = trustedSenderFor(3);
  ipc.emit("zcode:sync-web-remote-control-workspaces", { sender: wc },
    [{ workspacePath: "/a", kind: "local", workspaceIdentity: "" }]);
  ipc.emit("zcode:sync-web-remote-control-tasks", { sender: wc },
    [{ taskId: "t1", workspaceKind: "local" }]);
  assert.equal(api.ipcState().windowWorkspaces.has(3), true);
  assert.equal(api.ipcState().windowTasks.has(3), true);
  // 至少一个存活窗口（id 99）：maybeSpawn 才会走到修剪段；id 3 从未注册进 getAllWebContents
  windows.push({ id: 99, getType: () => "window", isDestroyed: () => false,
    getURL: () => "file:///fixture/resources/index.html", executeJavaScript: async () => "null" });
  await api.maybeSpawn();
  assert.equal(api.ipcState().windowWorkspaces.has(3), false, "workspaces pruned");
  assert.equal(api.ipcState().windowTasks.has(3), false, "tasks pruned");
});

test("usage snapshots are never pushed into external pages (data-plane gate parity)", () => {
  const { api, ipc, windows } = loadPumpIpc();
  const local = { id: 21, getType: () => "window", isDestroyed: () => false,
    getURL: () => "file:///fixture/resources/index.html", pushes: [],
    executeJavaScript: async js => { if (js.startsWith("window.__zusageUpdate")) local.pushes.push(js); return "null"; } };
  const external = { id: 22, getType: () => "window", isDestroyed: () => false,
    getURL: () => "https://evil.example/", pushes: [],
    executeJavaScript: async js => { if (js.startsWith("window.__zusageUpdate")) external.pushes.push(js); return "null"; } };
  windows.push(local, external);
  api.handlePayload({ recent: [] });
  return new Promise(resolve => {
    setTimeout(() => {
      assert.ok(local.pushes.length >= 1, "local host page receives the snapshot");
      assert.equal(external.pushes.length, 0, "external page must not receive usage data");
      resolve();
    }, 20);
  });
});
