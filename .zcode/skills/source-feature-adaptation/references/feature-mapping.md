# 功能对照与实现映射（复杂任务时使用）

只在需要追踪多项功能、多个仓库或较高风险改动时填写完整表格。简单任务在实施前用 2～5 条简短说明即可，不要因为文档阻碍实施。

## 1. 输入与证据

- 目标仓库/工作区：`<path or repo>`，分支/版本：`<ref>`
- 参考仓库 A：`<url or path>`，核验的 commit/tag：`<sha>`（无法核验则注明）
- 参考仓库 B（可选）：`<url or path>`
- 用户期望：`<what the user can do or observe>`
- 目标平台：`<web / Electron / iOS / Android / HarmonyOS / Node / ...>`
- 许可状况：`<license + obligation + uncertainty>`

## 2. 实现证据矩阵

| 功能/场景 | 参考项目可观察行为 | 关键源码证据 | 目标现状 | 目标落点/做法 | 验收条件 |
| --- | --- | --- | --- | --- | --- |
| 正常路径 | `<action → result>` | `<file:line, symbol>` | `<existing/missing>` | `<file/component>` | `<assertion>` |
| 边界路径 | `<edge case>` | `<file:line, symbol>` | `<existing/missing>` | `<implementation>` | `<assertion>` |
| 异常恢复 | `<error, retry, cleanup>` | `<file:line, symbol>` | `<existing/missing>` | `<implementation>` | `<assertion>` |

说明：行号、提交号、测试结果只有实际核验后才填写；不要为了表格好看而编造。

## 3. 实施方案

**必须实现**：核心功能清单、输入输出、状态转换、依赖关系。

**适配差异**：参考框架 vs 目标框架、平台权限与生命周期、UI 设计系统、依赖和存储策略。

**可选增强与不做范围**：说明为什么不迁移某些复杂或平台特有行为。

**版权处理**：独立实现/允许复用、需要的署名 NOTICE、第三方依赖许可证。

## 4. 验证矩阵

| 检查层 | 实际命令/操作 | 预期 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| 现有基线 | `<command>` | `<baseline>` | `<actual>` | 通过/失败/未运行 |
| 新增测试 | `<command>` | `<assertion>` | `<actual>` | 通过/失败/未运行 |
| 构建 | `<command>` | `<build target>` | `<actual>` | 通过/失败/未运行 |
| 平台验证 | `<platform/action>` | `<expected>` | `<actual>` | 通过/失败/未验证 |

**发布条件**：所有关键验收项通过，且未消除的高风险问题和阻塞项已向用户说明。未测试的平台不计入“全部通过”。

## 5. 多 Subagent 工作流映射（使用并行实施时补充）

| Task ID | 子代理职责 | 依赖 | 读/写范围 | 产物位置/证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `reference-trace` | 参考源码证据 | 无 | 参考源码只读 | `<ref@commit:path:line>` | `<done/partial/blocked>` |
| `target-audit` | 目标架构与复用点 | 无 | 目标项目只读 | `<target:path:line>` | `<...>` |
| `implement-core` | 功能核心 | `contract` | `src/...` **独占写入** | `<files + tests>` | `<...>` |
| `implement-ui` | UI/交互 | `contract` | `src/...` **独占写入** | `<files + tests>` | `<...>` |
| `integrate` | 主代理合并与全量测试 | 上述编码任务 | 公共入口和锁文件主代理独占 | `<git diff + commands>` | `<...>` |

- 在编写前锁定公共接口契约（符号、输入输出、错误语义）与任务依赖图；不可同时指派两个代理写同一文件或目录。
- 多仓库要注明每个结论的参考来源及可核验的 commit，避免将不同版本的行为混为一谈。
- 子代理自检结果只是局部证据；最终验收只基于主代理整合的目标仓库状态。
- 大型任务可用 [task-plan.example.json](task-plan.example.json) 与 `scripts/validate_task_plan.py` 预检所有权和依赖。
