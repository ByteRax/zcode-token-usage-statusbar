# 沉淀模板、分层落点示例与增量状态约定

本文档定义 `distill-project-memory` 在写入 `.zcode/rules/*.md`、根 `AGENTS.md`、`specs/*.md` 或 `docs/*.md` 时的写法规范与本地状态格式。遵循目标项目的标点、术语与排版风格，不机械填空。

## 1. 分层落点速查（以本仓库及 ZCode 规范为准）

写入前先按下表定位唯一主落点，优先在既有文件的对应主题节内合并或追加，不新建重复文件：

| 经验主题域 | 优先落点 | 根 `AGENTS.md` 是否同步 |
| --- | --- | --- |
| 套餐额度、OAuth `enc:v1`/`enc:v2` 解密、多源调度、SCNet、`src/quota/*` | `.zcode/rules/quota.md` | 仅在顶层契约或入口文件变化时更新 §0/§2/§5 摘要 |
| 浮层 DOM、三态样式、Tooltip、设置面板、`pointerdown` 防吞、字号/主题、`src/overlay/*` | `.zcode/rules/overlay-ui.md` | 仅在顶层契约变化时更新摘要 |
| 安装/卸载、asar 注入、6 处分发清单、热/冷文件部署、Squirrel `pending_zip_patch.py`、发布渠道 | `.zcode/rules/install-release.md` | 涉及共享清单或部署步骤变化时同步 §3/§8 |
| `renderer_bridge.py` 版本指纹、窗口/分栏 scope 归属、SSH 远端路由与 fail-closed | `.zcode/rules/bridge-remote.md` | 仅在顶层隔离契约变化时更新 §5 |
| 测试夹具（`py_test_support.py`、`overlay-extract.cjs`）、假绿灯反模式、CDP/实机验收、DB 排查 | `.zcode/rules/tests.md` | 涉及基础测试命令变化时同步 §6 |
| Git 分支、worktree 隔离、并行会话防覆盖、双推镜像、`VERSION` 撞号顺延 | `.zcode/rules/repo-workflow.md` | 不重复展开，由 §0 索引指向 |
| 三语 `README`、`docs/`、宣传图 `shoot.py`、冻结路径 `docs/promo/icon.webp`、禁用词纪律 | `.zcode/rules/docs.md` | 涉及顶层文档要求变化时同步 §7 |
| 宿主 `zcode.cjs` bundle 逆向、Squirrel 更新机制、宿主 vs 插件速率口径对照 | `.zcode/rules/host-engine.md` | 涉及排查入口变化时同步 §6 |
| 单一功能/专项特性的完整状态机、数据契约与验收矩阵 | `specs/<feature>.md` | 在相关规则中用相对链接引用 `specs/...` |
| 跨宿主适配长文、设计演进背景、用户排障手册 | `docs/hosts.md` / `docs/design-notes.md` / `docs/maintaining.md` / `docs/user-guide.md` | 按需保持现有链接有效 |

> **红线提醒**：ZCode 宿主引擎只加载从工作目录向上找到的**第一个** `AGENTS.md`（上限 100KB），**绝不在子目录新建 `AGENTS.md`**，否则子目录会话会遮蔽根 `AGENTS.md`。

## 2. `.zcode/rules/*.md` 可执行规则条目写法

规则条目力求高密度、可直接指导编码或审查，单条包含以下要素（可融合成紧凑列表项，不必每条拆成多级子标题）：

- **结论与动作（首句加粗锚点）**：一句话点明必须遵守的不变量或禁止动作。
- **触发条件与模块范围**：具体文件/分片路径（如 `src/overlay/*.js`、`src/quota/*.cjs`）、函数名或运行相位。
- **根因与历史先例（Why）**：简述违反后的真实故障机制及可复核先例（如 `issue #298`、`v345`），解释“为什么不能按直觉改”。
- **边界与验证方式**：合法例外情况，以及对应的回归测试文件或静态/实机检查命令。

**写法正例（高密度、有源码锚点与原因、无易变数字）**：
- **超时兜底定时器清理（防挂起事件循环）**：生产代码与测试中的超时兜底定时器（如 `Promise.race` 的 fallback `setTimeout`、`AbortController` 的 `kill` 超时）必须在结算后通过 `.finally(() => { if (typeof clearTimeout === "function") clearTimeout(timer); })` 立即清理（加 `typeof` 守卫兼容极简 VM 沙箱），并对长周期定时器调用 `timer.unref?.()`，防止断言结束后 Node 事件循环被悬空定时器挂住。

**写法反例（禁止入库）**：
- 空洞口号：“编写异步代码时要注意清理定时器，避免内存泄漏和进程挂起。”（无具体场景、无沙箱 `typeof` 陷阱、不可核查）
- 易变事实：“当前全仓共有 42 个 Python 测试文件和 21 个分发文件，每次修改后全部运行通过。”（数字随日常提交立即漂移失效）
- 未核验草案：直接把 `.zcode/plans/plan-*.md` 中尚未合入或已改方案的伪代码当成现行规则写入。

## 3. `docs/` 专题经验或排障条目写法

当经验属于长篇背景、多方案取舍对比或面向用户/维护者的排障步骤，沉淀到 `docs/` 对应文档（或无规则目录项目的 `docs/engineering-lessons.md`）时：

```markdown
### <主题：具体现象或架构取舍结论>
- **适用范围**：涉及的模块、宿主环境或平台（如 macOS Squirrel 更新链、`wb-overlay.cjs` CDP 模式）。
- **现象与触发条件**：可观察的故障表现或边界条件。
- **根因与源码依据**：实际链路与关键实现位置（使用仓库相对路径，如 `pending_zip_patch.py`）。
- **现行方案与被弃方案对比**：当前采用的做法，以及某替代方案为何不可行（防止后人重踩同一死胡同）。
- **验证方法**：可复现的隔离测试命令或实机诊断字段（如 `diag-0.json` 的具体键）。
```

没有证据的字段直接省略，不编造行号或未执行的实机测试结果。

## 4. 可选本地增量状态（默认不创建，按需存 `.zcode/`）

日常沉淀直接与 `.zcode/rules/*.md`、`AGENTS.md`、`docs/*.md` 现行文本做语义比对即可，**不创建额外索引文件**，更不要在 `docs/` 下创建 `docs/experience-index.json` 污染受控文档目录。

仅当用户要求对大批量历史记忆做分批断点扫描时，可在被 `.gitignore` 默认忽略的 `.zcode/memory-distill-state.json` 中记录脱敏摘要：

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "pending-zip-content-length-mismatch",
      "sourceRefs": ["repo:plan:sess_example", "git:commit:v339"],
      "sourceDigest": "sha256:<normalized-content-hash>",
      "evidenceRefs": ["pending_zip_patch.py", ".zcode/rules/install-release.md"],
      "status": "verified",
      "targets": [".zcode/rules/install-release.md", "AGENTS.md"],
      "note": "已核实 Squirrel MacUpdater Content-Length 固化机制并同步规则"
    }
  ]
}
```

状态维护纪律：
- `status` 取值：`verified`（已核验并入库或已由既有规则覆盖）、`pending`（待补充证据，后续扫描继续复核，不当成永久跳过）、`rejected`（已被源码证伪或属一次性噪音）、`superseded`（已被新架构替代）。
- `sourceRefs` 只用逻辑标识（如 `repo:plan:<文件名>`、`git:commit:<短SHA>`、`zcode:memory:<主题名>`），**严禁写入本机用户名、HOME 绝对路径、凭据或原始对话全文**。
- 状态文件缺失、损坏或版本不匹配时，直接回退为对照现有 `.zcode/rules/` 与 `AGENTS.md` 重新语义比对，不得以状态文件不可读为由重写既有规则。
