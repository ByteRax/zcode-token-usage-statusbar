"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

/* v96 多仓聚合回归：复用 inject-git-status 的 loadPump vm 沙箱，mockFs 扩展出可编程的父目录
 * 子项夹具——children 表按父目录列出子项 { name, file?, statThrows?, git? }，驱动
 * readdirSync 返回名字数组、statSync 区分目录/普通文件/抛错、existsSync 对子项下 .git 按夹具真假。
 * 覆盖 parseGitPorcelain 的 changed 口径、discoverChildRepos 的过滤/排序/截断、queryGitStatus
 * 的三分支（notrepo 聚合 / 恰 1 仓单仓管线 / 自身仓库直返）、失败隔离与 gitTick 推送。 */
function loadPump(respond = () => ({}), children = {}) {
  const intervals = [], timers = new Map(), windows = [], execs = [];
  let id = 0;
  const childOf = p => {   // 定位直接子项描述符；父目录本身返回 { parent: true }
    for (const parent of Object.keys(children)) {
      if (p === parent) return { parent: true };
      if (p.startsWith(parent + path.sep)) {
        const name = p.slice(parent.length + 1);
        if (!name.includes(path.sep)) {
          const c = children[parent].find(e => e.name === name);
          if (c) return c;
        }
      }
    }
    return null;
  };
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? "{}" : "",
    readdirSync: dir => {
      if (Object.prototype.hasOwnProperty.call(children, dir)) return children[dir].map(e => e.name);
      throw Object.assign(new Error("ENOENT: " + dir), { code: "ENOENT" });
    },
    statSync: file => {
      if (file === "/fixture/repo" || file === "/fixture/repo2") return { isDirectory: () => true, mtimeMs: 1 };
      if (typeof file === "string" && file.endsWith(path.sep + ".git")) {
        const c = childOf(file.slice(0, -(path.sep + ".git").length));
        if (c && c.git) return { isDirectory: () => true, mtimeMs: 1 };   // gitDotDir 探测 .git 目录
      }
      if (["/fixture/runtime/overlay.js", "/fixture/runtime/zusage.py"].includes(file)) return { mtimeMs: 1, size: 1 };
      const c = childOf(file);
      if (c) {
        if (c.parent) return { isDirectory: () => true, mtimeMs: 1 };
        if (c.statThrows) throw Object.assign(new Error("EACCES: " + file), { code: "EACCES" });
        return { isDirectory: () => !c.file, mtimeMs: 1 };
      }
      throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
    },
    existsSync: p => {
      if (typeof p === "string" && p.endsWith(path.sep + ".git")) {
        const c = childOf(p.slice(0, -(path.sep + ".git").length));
        return !!(c && c.git);   // .git 是目录还是 worktree 链接文件都按存在返回
      }
      if (typeof p === "string" && p.includes(path.sep + ".git" + path.sep)) {
        // 操作探针：仓库夹具的 op 字段决定对应触发器文件是否存在（detectGitOp 的输入面）
        const repoPath = p.slice(0, p.indexOf(path.sep + ".git" + path.sep));
        const probe = p.slice(repoPath.length + (path.sep + ".git" + path.sep).length);
        const c = childOf(repoPath);
        if (!c) return false;
        if (probe === "rebase-merge") return c.op === "rebase";
        if (probe === "rebase-apply") return c.op === "am" || c.op === "rebase";
        if (probe === "applying") return c.op === "am";   // 探针相对 .git 目录：applying 在 rebase-apply 内
        if (probe === "MERGE_HEAD") return c.op === "merge";
        return false;
      }
      return false;
    },
    watch: () => ({ on() {} }), writeFileSync() {},
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
          cb(r.error || null, r.stdout || "", r.stderr || "");
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
        if (js.startsWith("window.__zusageGitState") || js.startsWith("window.__zusageUpdate")) wc.pushes.push(js);
        return "null";
      } };
    windows.push(wc); return wc;
  }
  return { api: sandbox.module.exports.__zusageTest, intervals, execs, addWindow };
}

/* 父目录 status 的 notrepo 夹具：exit 128 + fatal 文案（gitFailure 据此判 notrepo 触发子仓发现） */
const NOTREPO = { error: { code: 128 }, stderr: "fatal: not a git repository (or any of the parent directories): .git" };
/* 按 cwd 分发 status 夹具：值为 porcelain 字符串（成功）或 { error }（失败）；非 status 命令回短统计 */
function statusRespond(map) {
  return args => {
    if (args.includes("status")) {
      const hit = map[args[1]];
      if (hit !== undefined) return typeof hit === "string" ? { stdout: hit } : hit;
      return { stdout: "## main\n" };
    }
    return { stdout: " 2 files changed, 5 insertions(+), 1 deletion(-)\n" };
  };
}

/* ---------- parseGitPorcelain.changed 口径 ---------- */

test("parseGitPorcelain: MM 部分暂存一行只计 1 个 changed，不等于 staged+unstaged 之和", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main\nMM a.py\n");
  assert.equal(r.staged, 1);
  assert.equal(r.unstaged, 1);
  assert.equal(r.changed, 1, "MM 是一行变更，changed 不重复计 staged+unstaged");
  assert.notEqual(r.changed, r.staged + r.unstaged, "changed 不等于 2");
});

test("parseGitPorcelain: DD 冲突计入 changed，?? 不计入，干净输出 changed=0", async () => {
  const { api } = loadPump();
  const d = api.parseGitPorcelain("## main\nDD e.py\n");
  assert.equal(d.conflicts, 1);
  assert.equal(d.changed, 1, "DD 冲突行计入 changed");
  const u = api.parseGitPorcelain("## main\n?? new.py\n");
  assert.equal(u.untracked, 1);
  assert.equal(u.changed, 0, "未跟踪行不计入 changed");
  const clean = api.parseGitPorcelain("## main...origin/main [ahead 1]\n");
  assert.equal(clean.changed, 0);
});

test("parseGitPorcelain: 混合行集合的 changed 总数按行数统计", async () => {
  const { api } = loadPump();
  const r = api.parseGitPorcelain("## main\nMM a\nM  b\n M c\nDD d\nAU e\n?? f\n!! g\nR  h\nA  i\n D j\n");
  // changed 行：MM / M / " M" / DD / AU / R / A / " D" 共 8；?? 与 !! 不计
  assert.deepEqual([r.staged, r.unstaged, r.untracked, r.conflicts, r.changed], [4, 3, 1, 2, 8]);
});

/* ---------- discoverChildRepos ---------- */

test("discoverChildRepos: 无 .git 子目录返回 0 仓", async () => {
  const { api } = loadPump(null, { "/fixture/parent": [
    { name: "alpha" }, { name: "beta" }, { name: "notes.txt", file: true },
  ]});
  const r = api.discoverChildRepos("/fixture/parent");
  assert.deepEqual([...r.repos], []);
  assert.equal(r.more, 0);
});

test("discoverChildRepos: .git 为文件（worktree 链接）也算仓库", async () => {
  const { api } = loadPump(null, { "/fixture/parent": [{ name: "linked", git: true }] });
  const r = api.discoverChildRepos("/fixture/parent");
  assert.deepEqual([...r.repos].map(x => ({ ...x })), [{ name: "linked", path: "/fixture/parent/linked" }]);
});

test("discoverChildRepos: 非目录子项（普通文件）跳过", async () => {
  const { api } = loadPump(null, { "/fixture/parent": [
    { name: "a.txt", file: true, git: true }, { name: "real", git: true },
  ]});
  const names = [...api.discoverChildRepos("/fixture/parent").repos].map(x => x.name);
  assert.deepEqual(names, ["real"], "带 .git 的普通文件不是仓库");
});

test("discoverChildRepos: statSync 抛错的子项跳过且不抛出", async () => {
  const { api } = loadPump(null, { "/fixture/parent": [
    { name: "gone", statThrows: true }, { name: "ok", git: true },
  ]});
  const names = [...api.discoverChildRepos("/fixture/parent").repos].map(x => x.name);
  assert.deepEqual(names, ["ok"]);
});

test("discoverChildRepos: readdirSync 抛错返回空结果不抛出", async () => {
  const { api } = loadPump();
  const r = api.discoverChildRepos("/fixture/missing");
  assert.deepEqual([...r.repos], []);
  assert.equal(r.more, 0);
});

test("discoverChildRepos: 名字按码点序 A10 < A2 < a", async () => {
  const { api } = loadPump(null, { "/fixture/parent": [
    { name: "a", git: true }, { name: "A2", git: true }, { name: "A10", git: true },
  ]});
  const names = [...api.discoverChildRepos("/fixture/parent").repos].map(x => x.name);
  assert.deepEqual(names, ["A10", "A2", "a"], "默认 sort 码点序，非自然数序");
});

test("discoverChildRepos: 33 个仓库截断为 32 个并计 more:1", async () => {
  const entries = Array.from({ length: 33 }, (_, i) => ({ name: "r" + String(i + 1).padStart(2, "0"), git: true }));
  const { api } = loadPump(null, { "/fixture/parent": entries });
  const r = api.discoverChildRepos("/fixture/parent");
  assert.equal(r.repos.length, 32);
  assert.equal(r.more, 1);
  assert.equal(r.repos[31].name, "r32", "截断保留码点序前 32 个");
});

/* ---------- queryGitStatus 三分支 ---------- */

test("queryGitStatus: 2 个子仓聚合 kind multi，每仓恰 1 条 status 且全程 0 条 diff", async () => {
  const { api, execs } = loadPump(statusRespond({
    "/fixture/parent": NOTREPO,
    "/fixture/parent/alpha": "## main...origin/main [ahead 2, behind 1]\nMM a.py\n?? c\n",
    "/fixture/parent/beta": "## feat/x\n M b\n",
  }), { "/fixture/parent": [{ name: "alpha", git: true }, { name: "beta", git: true }] });
  const st = await api.queryGitStatus("/fixture/parent");
  assert.equal(st.ok, true);
  assert.equal(st.kind, "multi");
  assert.equal(st.more, 0);
  assert.deepEqual([...st.repos].map(r => r.name), ["alpha", "beta"], "repos 按字母序");
  const statuses = execs.filter(e => e.args.includes("status"));
  assert.equal(statuses.length, 3, "父目录探测 1 条 + 两个子仓各 1 条");
  assert.equal(statuses.filter(e => e.args[1] === "/fixture/parent/alpha").length, 1, "alpha 恰 1 条 status");
  assert.equal(statuses.filter(e => e.args[1] === "/fixture/parent/beta").length, 1, "beta 恰 1 条 status");
  assert.equal(execs.filter(e => e.args.includes("diff")).length, 0, "多仓分支不跑 diff 行数");
  const alpha = { ...st.repos[0] }, beta = { ...st.repos[1] };
  assert.equal(typeof alpha.ts, "number", "成功项附最近成功时刻");
  assert.equal(alpha.op, "", "无进行中操作时 op 为空串");
  delete alpha.ts; delete alpha.op; delete beta.ts; delete beta.op;
  assert.deepEqual(alpha, { name: "alpha", path: "/fixture/parent/alpha", branch: "main",
    upstream: "origin/main", ahead: 2, behind: 1, detached: false, noCommits: false,
    staged: 1, unstaged: 1, untracked: 1, conflicts: 0, changed: 1 }, "成功项字段完整");
  assert.deepEqual(beta, { name: "beta", path: "/fixture/parent/beta", branch: "feat/x",
    upstream: "", ahead: 0, behind: 0, detached: false, noCommits: false,
    staged: 0, unstaged: 1, untracked: 0, conflicts: 0, changed: 1 });
});

test("queryGitStatus: 3 仓中 1 仓超时 1 仓损坏，整体仍 ok 且失败项只记 err", async () => {
  const { api } = loadPump(statusRespond({
    "/fixture/parent": NOTREPO,
    "/fixture/parent/alpha": "## main\n",
    "/fixture/parent/broken": { error: { code: 128 }, stderr: "fatal: not a git repository (or any of the parent directories): .git" },
    "/fixture/parent/slow": { error: { killed: true } },
  }), { "/fixture/parent": [{ name: "alpha", git: true }, { name: "broken", git: true }, { name: "slow", git: true }] });
  const st = await api.queryGitStatus("/fixture/parent");
  assert.equal(st.ok, true, "单仓失败不拖垮整体");
  assert.equal(st.kind, "multi");
  const repos = [...st.repos].map(r => ({ ...r }));
  const alpha = repos[0];
  assert.equal(typeof alpha.ts, "number");
  delete alpha.ts; delete alpha.op;
  assert.deepEqual(alpha, { name: "alpha", path: "/fixture/parent/alpha", branch: "main", upstream: "",
    ahead: 0, behind: 0, detached: false, noCommits: false,
    staged: 0, unstaged: 0, untracked: 0, conflicts: 0, changed: 0 }, "剩余仓正常");
  assert.equal(repos[1].err, "notrepo");
  assert.equal(typeof repos[1].tsAttempt, "number", "失败项附最近尝试时刻（≠最近成功）");
  assert.equal(repos[2].err, "timeout");
  assert.equal(typeof repos[2].tsAttempt, "number");
  assert.ok(!("branch" in repos[1]) && !("changed" in repos[1]), "无旧快照的失败项不含分支/计数字段");
});

test("queryGitStatus: 失败子仓携带最近成功快照并标 stale（渲染端作历史提示）", async () => {
  const children = { "/fixture/parent": [{ name: "alpha", git: true }, { name: "beta", git: true }] };
  let slowFirst = true;
  const h = loadPump(args => {
    if (!args.includes("status")) return { stdout: "" };
    if (args[1] === "/fixture/parent") return NOTREPO;
    if (args[1] === "/fixture/parent/beta") {
      if (slowFirst) { slowFirst = false; return { stdout: "## dev\n M b\n" }; }
      return { error: { killed: true } };   // 第二轮起超时
    }
    return { stdout: "## main\n" };
  }, children);
  const ok1 = await h.api.queryGitStatus("/fixture/parent");
  assert.equal(ok1.kind, "multi");
  const beta1 = [...ok1.repos].find(r => r.name === "beta");
  assert.equal(beta1.unstaged, 1, "首轮成功入库（ M 为未暂存）");
  const ok2 = await h.api.queryGitStatus("/fixture/parent");
  const beta2 = [...ok2.repos].find(r => r.name === "beta");
  assert.equal(beta2.err, "timeout", "第二轮失败");
  assert.equal(beta2.stale, true, "标注历史属性");
  assert.equal(beta2.changed, 1, "携带最近成功快照的 changed");
  assert.equal(beta2.branch, "dev", "携带最近成功快照的分支");
});

test("queryGitStatus: 恰 1 个子仓走完整单仓管线并附子仓 repoPath", async () => {
  const { api, execs } = loadPump(statusRespond({ "/fixture/parent": NOTREPO }),
    { "/fixture/parent": [{ name: "alpha", git: true }] });
  const st = await api.queryGitStatus("/fixture/parent");
  assert.equal(st.ok, true);
  assert.equal(st.repoPath, "/fixture/parent/alpha", "repoPath 指向子仓");
  assert.ok(!("kind" in st), "单仓形状无 kind");
  assert.ok(!("repos" in st), "单仓形状无 repos");
  assert.deepEqual([st.branch, st.ins, st.del], ["main", 5, 1], "diff HEAD 短统计已合并");
  assert.deepEqual(execs.map(e => [...e.args]), [
    ["-C", "/fixture/parent", "status", "--porcelain", "--branch"],
    ["-C", "/fixture/parent/alpha", "status", "--porcelain", "--branch"],
    ["-C", "/fixture/parent/alpha", "diff", "HEAD", "--shortstat"],
  ], "status + diff HEAD 两条命令都执行");
});

test("queryGitStatus: 0 个子仓维持 notrepo 语义", async () => {
  const { api, execs } = loadPump(statusRespond({ "/fixture/parent": NOTREPO }),
    { "/fixture/parent": [{ name: "plain", file: true }, { name: "docs" }] });
  const st = await api.queryGitStatus("/fixture/parent");
  assert.deepEqual([st.ok, st.reason], [false, "notrepo"]);
  assert.equal(execs.length, 1, "父目录 status 探测后即止");
});

test("queryGitStatus: workspace 自身是仓库直接单仓形状，repoPath 等于自身", async () => {
  const { api, execs } = loadPump(statusRespond({}), { "/fixture/parent": [{ name: "alpha", git: true }] });
  const st = await api.queryGitStatus("/fixture/repo");
  assert.equal(st.ok, true);
  assert.equal(st.repoPath, "/fixture/repo");
  assert.ok(!("kind" in st) && !("repos" in st), "不触发子仓聚合");
  assert.deepEqual(execs.map(e => [...e.args.filter(a => a !== "-C" && a !== "/fixture/repo")]),
    [["status", "--porcelain", "--branch"], ["diff", "HEAD", "--shortstat"]], "现有单仓管线原样");
});

/* ---------- 上限语义与 gitTick 集成 ---------- */

test("queryGitStatus: 33 仓目录折叠为 32 + more:1", async () => {
  const entries = Array.from({ length: 33 }, (_, i) => ({ name: "r" + String(i + 1).padStart(2, "0"), git: true }));
  const { api, execs } = loadPump(statusRespond({ "/fixture/parent": NOTREPO }), { "/fixture/parent": entries });
  const st = await api.queryGitStatus("/fixture/parent");
  assert.equal(st.ok, true);
  assert.equal(st.kind, "multi");
  assert.equal(st.more, 1);
  assert.equal(st.repos.length, 32);
  assert.equal(st.repos[31].name, "r32");
  assert.ok(![...st.repos].some(r => r.name === "r33"), "第 33 仓被折叠进 more");
  assert.equal(execs.filter(e => e.args.includes("status")).length, 33, "父 1 + 恰 32 个子仓 status");
});

test("gitTick: 窗口路径指向非仓库父目录时推送 kind multi 状态", async () => {
  const h = loadPump(statusRespond({ "/fixture/parent": NOTREPO }),
    { "/fixture/parent": [{ name: "alpha", git: true }, { name: "beta", git: true }] });
  const wc = h.addWindow();
  wc.gitPaths = ["/fixture/parent"];
  await h.api.gitTick(false); await flush();
  const push = wc.pushes.find(js => js.startsWith('window.__zusageGitState && window.__zusageGitState("/fixture/parent"'));
  assert.ok(push, "窗口收到父目录的 git 状态推送");
  const payload = JSON.parse(push.match(/^window\.__zusageGitState && window\.__zusageGitState\("\/fixture\/parent",(.*)\)$/)[1]);
  assert.equal(payload.ok, true);
  assert.equal(payload.kind, "multi");
  assert.equal(payload.more, 0);
  assert.deepEqual(payload.repos.map(r => r.name), ["alpha", "beta"]);
});

test("恰 1 子仓但该子仓查询失败：透传失败形状，不递归发现、无 diff", async () => {
  const children = { "/fixture/parent": [{ name: "alpha", git: true }] };
  const h = loadPump(args => {
    if (!args.includes("status")) return { stdout: "" };
    return args[1] === "/fixture/parent" ? NOTREPO : { error: { killed: true } };
  }, children);
  const st = await h.api.queryGitStatus("/fixture/parent");
  assert.deepEqual([st.ok, st.reason], [false, "timeout"]);
  assert.ok(!("repoPath" in st), "失败形状不带 repoPath");
  assert.equal(h.execs.length, 2, "父探测 + 子仓 status，无 diff");
  assert.ok(!h.execs.some(e => e.args.includes("diff")));
});

test("父目录 status 非 notrepo 失败（timeout）不触发子仓发现", async () => {
  const children = { "/fixture/parent": [{ name: "alpha", git: true }, { name: "beta", git: true }] };
  const h = loadPump(args => {
    if (!args.includes("status")) return { stdout: "" };
    return args[1] === "/fixture/parent" ? { error: { killed: true } } : { stdout: "## main\n" };
  }, children);
  const st = await h.api.queryGitStatus("/fixture/parent");
  assert.deepEqual([st.ok, st.reason], [false, "timeout"]);
  assert.equal(h.execs.filter(e => e.args.includes("status")).length, 1, "子仓 0 次查询");
});

test("恰 32 仓不截断：more=0（cap 边界单侧）", async () => {
  const kids = [];
  for (let i = 0; i < 32; i++) kids.push({ name: "r" + String(i + 1).padStart(2, "0"), git: true });
  const h = loadPump(args => {
    if (!args.includes("status")) return { stdout: "" };
    return args[1] === "/fixture/parent" ? NOTREPO : { stdout: "## main\n" };
  }, { "/fixture/parent": kids });
  const st = await h.api.queryGitStatus("/fixture/parent");
  assert.equal(st.kind, "multi");
  assert.equal(st.more, 0, "32 恰在 cap 内不产生 more");
  assert.equal([...st.repos].length, 32);
});

test("detectGitOp：触发器文件→操作码，am 以 applying 文件与 rebase 区分", async () => {
  const children = { "/fixture/parent": [
    { name: "r-am", git: true, op: "am" },
    { name: "r-rebase", git: true, op: "rebase" },
    { name: "r-merge", git: true, op: "merge" },
    { name: "r-clean", git: true },
  ] };
  const h = loadPump(args => {
    if (!args.includes("status")) return { stdout: "" };
    return args[1] === "/fixture/parent" ? NOTREPO : { stdout: "## main\n" };
  }, children);
  assert.equal(await h.api.detectGitOp("/fixture/parent/r-am"), "am", "applying 存在 → am（非 rebase）");
  assert.equal(await h.api.detectGitOp("/fixture/parent/r-rebase"), "rebase");
  assert.equal(await h.api.detectGitOp("/fixture/parent/r-merge"), "merge");
  assert.equal(await h.api.detectGitOp("/fixture/parent/r-clean"), "");
  const st = await h.api.queryGitStatus("/fixture/parent");
  const byName = {};
  for (const r of [...st.repos]) byName[r.name] = r;
  assert.equal(byName["r-am"].op, "am");
  assert.equal(byName["r-rebase"].op, "rebase");
  assert.equal(byName["r-merge"].op, "merge");
  assert.equal(byName["r-clean"].op, "");
});
