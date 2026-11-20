const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { sliceOverlay } = require('./helpers/overlay-extract.cjs');

/* v406 受管 worktree 会话的 Git chip 路径覆写（specs/worktree-branch.md）。
 * 切片评估 01 分片的 worktreeFor/gitViewFor/publishGitPaths 与 gitTipHTML（VM 桩），
 * gitChipView/onGitClick 覆写为源码契约断言（整链 DOM 集成由 overlay-git-chip 系列承载）。 */

function gitRegion() {
  return sliceOverlay('  var gitStateByPath = {}, gitLastGood = {}, gitAskedAt = 0;', '  var quotaSelectionsSig = "";');
}

function tipRegion() {
  return sliceOverlay('  function gitEsc(s)', '  /* v96 multi tooltip');
}

function publishRegion() {
  return sliceOverlay('  function publishGitPaths() {', '  /* ---------- 回复末尾速率行');
}

function run(fragment, sandbox) {
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fragment, ctx);
  return ctx;
}

test('worktreeFor: sid 命中取事实，缺帧/非受管/缺 cwd 一律 null', () => {
  const ctx = run('var lastWorktrees = null; function stale(){return false;}\n' + gitRegion(), { window: {} });
  const worktreeFor = ctx.worktreeFor;
  assert.equal(worktreeFor('s1'), null, '无快照帧返回 null');
  ctx.lastWorktrees = { s1: { cwd: '/wt/cwd', root: '/wt/root', bucket: 'd0c5', name: 'repo', ref: null, sha: 'abc' } };
  assert.deepEqual(worktreeFor('s1'), ctx.lastWorktrees.s1, '命中返回完整事实');
  assert.equal(worktreeFor('other'), null, '非受管 sid 返回 null');
  assert.equal(worktreeFor(''), null, '空 sid 返回 null');
  ctx.lastWorktrees = { s2: { root: '/wt/root' } };   // 缺 cwd 的畸形条目按未命中处理
  assert.equal(worktreeFor('s2'), null, '缺 cwd 条目返回 null');
});

test('publishGitPaths: 受管会话发布 wt.cwd，普通会话发布 workspacePath，变化触发立即首查', () => {
  function setup(map) {
    const asks = [];
    const ctx = run(
      'var lastWorktrees = ' + JSON.stringify(map) + ';\n' +
      'var instances = [{ getSid: function(){ return "s1"; }, getScope: function(){ return { sid: "s1", identity: "", workspacePath: "/proj/main" }; } }];\n' +
      'var state = { show: { git: true } };\n' +
      'function stale(){ return false; }\n' +
      'function pluginRequest(){ return ""; }\n' +
      gitRegion() + publishRegion(),
      { window: {}, asks });
    /* gitRegion 自带真实 askGitRefresh（函数声明后定义胜出），加载后重绑记录桩观察 changed 实参 */
    ctx.askGitRefresh = function (changed) { asks.push(changed); };
    return { ctx, asks };
  }
  let h = setup({ s1: { cwd: '/wt/cwd', root: '/wt/root', bucket: 'd0c5', name: 'repo' } });
  h.ctx.publishGitPaths();
  assert.deepEqual([...h.ctx.window.__zusageGitPaths], ['/wt/cwd'], '受管会话上报 worktree cwd');
  assert.equal(h.asks.pop(), true, '路径集变化触发立即首查');
  h = setup({});
  h.ctx.publishGitPaths();
  assert.deepEqual([...h.ctx.window.__zusageGitPaths], ['/proj/main'], '普通会话上报 workspacePath');
  h = setup({ s1: { cwd: '/wt/cwd' } });
  h.ctx.window.show = { git: false };
  h.ctx.state.show.git = false;
  h.ctx.publishGitPaths();
  assert.deepEqual([...h.ctx.window.__zusageGitPaths], [], '开关关闭不上报（现状行为）');
});

test('gitTipHTML: worktree 区块全量信息（短标识/根目录仅 monorepo/主仓库/起点/创建于），转义与回退', () => {
  const sandbox = {
    L: (cn) => cn,
    cnUnits: () => false,
    window: {},
    document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {} } },
  };
  const ctx = run('function stale(){ return false; }\n' + tipRegion(), sandbox);
  const gitTipHTML = ctx.gitTipHTML;
  const st = { branch: 'feat/x', upstream: '', ahead: 0, behind: 0, detached: false, noCommits: false,
    staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ins: 0, del: 0, ts: 1730000000000, repoPath: '/wt/cwd' };
  /* monorepo：cwd ≠ root → 根目录行单列 */
  let html = gitTipHTML({ path: '/wt/cwd', st, stale: false, wt: { bucket: 'd0c5', root: '/wt/root', cwd: '/wt/cwd/sub', name: 'repo', ref: 'feat/big', sha: '0eb3d313', sourceRoot: '/src/repo', created: 1730000000000 } });
  assert.match(html, /受管 Worktree/, 'worktree 标题行');
  assert.match(html, /<b>受管 Worktree<\/b><span>d0c5 · repo<\/span>/, '短标识 bucket·名称（不重复整条 root 路径）');
  assert.match(html, /<b>Worktree 根目录<\/b><span>\/wt\/root<\/span>/, 'monorepo 时根目录单列');
  assert.match(html, /<b>主仓库<\/b><span>\/src\/repo<\/span>/, '源仓库行');
  assert.match(html, /<b>起点<\/b><span>feat\/big<\/span>/, '起点优先 ref');
  assert.match(html, /<b>创建于<\/b><span>2024-10-27/, '创建时间行');
  /* cwd == root：根目录行不重复（「目录」行已是根） */
  html = gitTipHTML({ path: '/wt/root', st, stale: false, wt: { bucket: 'd0c5', root: '/wt/root', cwd: '/wt/root', name: 'repo', ref: null, sha: '0eb3d3133adc', sourceRoot: null, created: null } });
  assert.ok(!html.includes('Worktree 根目录'), 'cwd=根时不再单列根目录行');
  assert.ok(!html.includes('主仓库'), '无 sourceRoot 隐藏行');
  assert.ok(!html.includes('创建于'), '无 created 隐藏行');
  assert.match(html, /<b>起点<\/b><span>0eb3d31<\/span>/, '无 ref 回退 sha 前 7 位');
  html = gitTipHTML({ path: '/wt/cwd', st, stale: false, wt: { bucket: 'd0c5', root: '/wt/root', cwd: '/wt/root', name: 'repo', ref: null, sha: null } });
  assert.match(html, /<b>起点<\/b><span>当前 HEAD（游离检出）<\/span>/, '都无显当前 HEAD');
  html = gitTipHTML({ path: '/wt/cwd', st, stale: false, wt: { bucket: 'd<c', root: '/wt/<script>alert(1)</script>', cwd: '/wt/x', name: 'r<b', ref: 'a<b', sha: null, sourceRoot: '/src/<i>' } });
  assert.ok(!html.includes('<script>alert(1)</script>') && !html.includes('<i>'), '用户数据全过 gitEsc');
  assert.match(html, /a&lt;b/, 'ref 用户数据过 gitEsc');
  html = gitTipHTML({ path: '/proj', st, stale: false });
  assert.ok(!html.includes('受管 Worktree'), '无 wt 字段不渲染区块（普通会话）');
});

test('gitChipHtml/gitChipAria: worktree 游离检出令牌显 WorkTree（chip/aria 同源）', () => {
  /* 切片含 gitBranchToken 单源助手（位于 gitChipHtml 之前） */
  const frag = sliceOverlay('    /* v409：游离检出分支令牌单源', '    function gitDotCls(st, stale)');
  const sandbox = {
    L: (cn) => cn,
    ZU_GIT_ICON: '<i>ico</i>',
    gitEsc: (x) => String(x),
    gitNum: (n) => String(n | 0),
    gitOpLabel: (c) => c,
  };
  const ctx = run(frag, sandbox);
  const stDetached = { branch: '', upstream: '', ahead: 0, behind: 0, detached: true, noCommits: false,
    staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ins: 0, del: 0, ts: 1 };
  const wt = { bucket: '0f62', root: '/wt', cwd: '/wt', name: 'repo', ref: null, sha: 'abc' };
  let html = ctx.gitChipHtml({ path: '/wt', st: stDetached, stale: false, wt });
  assert.match(html, /<span class="zu-git-name">WorkTree<\/span>/, 'worktree 游离检出 chip 显 WorkTree');
  html = ctx.gitChipHtml({ path: '/proj', st: stDetached, stale: false, wt: null });
  assert.match(html, /<span class="zu-git-name">HEAD<\/span>/, '非 worktree 游离检出保持 HEAD');
  const stBranch = Object.assign({}, stDetached, { detached: false, branch: 'feat/x' });
  html = ctx.gitChipHtml({ path: '/wt', st: stBranch, stale: false, wt });
  assert.match(html, /<span class="zu-git-name">feat\/x<\/span>/, 'worktree 有分支照常显示分支名');
  let aria = ctx.gitChipAria(stDetached, false, wt);
  assert.match(aria, /WorkTree（游离检出）/, 'aria 播报 worktree 游离检出');
  aria = ctx.gitChipAria(stDetached, false, null);
  assert.match(aria, /Git 分支 HEAD/, '非 worktree aria 保持 HEAD');
});

test('gitChipView 行为断言：wt 命中按 wt.cwd 取数并携带 wt，未命中走 workspacePath（防同字面量写反）', () => {
  /* gitChipView 在 spawnInstance 实例闭包内（11 分片），切片执行需桩实例变量与依赖。
   * 桩用闭包变量而非 this（VM 内无绑调用会解绑 this）。 */
  const frag = sliceOverlay('    function gitChipView() {', '    function gitChipHtml(view)');
  const wts = { s1: { cwd: '/wt/cwd', root: '/wt/root', bucket: 'd0c5', name: 'repo', ref: null, sha: 'abc' } };
  const queries = { s1: { sid: 's1', identity: '', workspacePath: '/proj/main' } };
  const views = {
    '/wt/cwd': { st: { branch: 'feat/x', detached: false }, stale: false },
    '/proj/main': { st: { branch: 'main', detached: false }, stale: false },
  };
  const sandbox = {
    L: (cn) => cn,
    state: { show: { git: true } },
    wantedEl: {}, pickedSid: 's1', pid: 'workspace-main',
    readPaneScope: (el, sid) => queries[sid] || null,
    worktreeFor: (sid) => { const w = wts[sid]; return w && w.cwd ? w : null; },
    gitViewFor: (p) => views[p] || null,
  };
  const ctx = run(frag, sandbox);
  /* 变异防线（M8）：publishGitPaths 里有同款 `wt ? wt.cwd : scope.workspacePath` 字面量，
   * 无锚定正则可被其顶替；这里用真实行为断言锁 gitChipView 自身 */
  let view = ctx.gitChipView();
  assert.equal(view.path, '/wt/cwd', '受管会话视图路径 = worktree cwd');
  assert.deepEqual(view.wt, wts.s1, 'view 携带 wt 供 tooltip');
  assert.equal(view.st.branch, 'feat/x', '状态取自 worktree 查询结果');
  delete wts.s1;
  view = ctx.gitChipView();
  assert.equal(view.path, '/proj/main', '非受管会话视图路径 = workspacePath');
  assert.equal(view.wt, null, '未命中时 wt 为 null');
  sandbox.state.show.git = false;
  assert.equal(ctx.gitChipView(), null, '开关关闭不显示（现状行为）');
});

test('gitCandidates: L2 摘要档与 gitBranchToken 单源接线（防令牌漂移，审查 M5）', () => {
  const frag = sliceOverlay('    function gitCandidates(view) {', '    function gitMeasureAvail(');
  const sandbox = {
    L: (cn) => cn,
    ZU_GIT_ICON: '<i>ico</i>', ZU_GIT_MULTI_ICON: '<i>multi</i>',
    gitEsc: (x) => String(x),
    gitNum: (n2) => String(n2 | 0),
    gitOpLabel: (c) => c,
    gitMultiAgg: () => ({ total: 1, known: 1, changed: 0, conflict: 0, op: 0, failed: 0, staleAny: false, m: 0, q: 0 }),
    gitDotCls: () => 'zu-git-dot-g',
    gitChipHtml: () => '<i>full</i>',
    gitBranchToken: (st, view) => st.detached ? (view.wt ? "WorkTree" : "HEAD") : String(st.branch || "HEAD"),
  };
  const ctx = run(frag, sandbox);
  const stDetached = { branch: '', upstream: '', ahead: 0, behind: 0, detached: true, noCommits: false,
    staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ins: 0, del: 0, ts: 1 };
  const view = { path: '/wt', st: stDetached, stale: false, wt: { bucket: '0f62', name: 'repo' } };
  const cands = ctx.gitCandidates(view);
  assert.match(cands.L2, /<span class="zu-git-name">WorkTree<\/span>/, 'L2 摘要档经单源令牌显 WorkTree');
  delete view.wt;
  cands.L2 = ctx.gitCandidates(view).L2;
  assert.match(cands.L2, /<span class="zu-git-name">HEAD<\/span>/, '非 worktree 游离检出 L2 保持 HEAD');
});

test('gitChipView/onGitClick 覆写为锚定源码契约（与行为断言双保险）', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'overlay.js'), 'utf8');
  /* 锚定 gitChipView 现场：`var v = gitViewFor(gp)` 紧随覆写行（publishGitPaths 无此相邻形状，
   * 写反式变异无法再用他处同字面量顶替） */
  assert.match(src, /var gp = wt \? wt\.cwd : scope\.workspacePath;\s*var v = gitViewFor\(gp\);/, 'gitChipView 覆写+取数相邻在场');
  assert.match(src, /wt: wt \} : null;/, 'view 携带 wt 供 tooltip');
  assert.match(src, /var wt = scope \? worktreeFor\(scope\.sid\) : null;   \/\/ specs\/worktree-branch\.md：刷新请求同样按覆写路径/, 'onGitClick 刷新路径覆写在场');
  assert.match(src, /if \(!isMobile && d\.worktrees && typeof d\.worktrees === "object"\)/, '__zusageUpdate 捕获 worktrees 帧字段');
});
