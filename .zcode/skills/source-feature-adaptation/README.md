# Source Feature Adaptation — 多 Subagent 加速版

通过分析其他项目的真实源码与功能契约，在目标项目中实现相似功能。默认在执行环境支持时采用**分波并行子代理**，减少重复查阅与串行等待，保留最小改动、许可证、测试与回归保障。

## 两波并行 + 集成

```text
主代理确认仓库状态、参考版本和范围
             |
    研究波（只读、并行）
    ├─ A：参考源码 / 调用链
    ├─ B：目标项目 / 复用模块
    ├─ C：许可 / 平台 / 依赖
    └─ D：测试现状 / 验收条件（可选）
             |
     主代理合并证据、冻结接口契约
             |
    实施波（独占文件、并行）
    ├─ E：核心逻辑
    ├─ F：UI / 交互
    ├─ G：跨平台适配（可选）
    └─ H：独立测试
             |
    主代理合并、构建、回归、最终只读审查
```

小任务自动采用单代理；中型任务建议并行 3～4 个子代理，大型多仓库/多模块任务建议 5～8 个，并在用户指定且任务确实独立时扩展至 10。实际数量由宿主工具支持和依赖关系决定；**Skill 本身不能凭文字指令创建宿主尚未提供的代理调用接口**。

## 推荐调用方式：直接实现

```text
使用 source-feature-adaptation
参考项目：https://github.com/example/reference-repo
参考功能：图片裁剪，支持四角拖拽、缩放、回弹
目标项目：当前工作区
目标平台：UniApp Android / iOS

请优先使用多 Subagent 并行执行：
1. 并行分析参考项目调用链、当前项目架构、许可/平台限制和验收测试。
2. 先冻结关键接口和功能契约，再按互不重叠的文件所有权并行实施。
3. 需要改共享文件的工作统一由主代理集成；保护已有未提交代码。
4. 集成后执行适用的静态检查、测试、构建与独立审查。
5. 输出真实子代理分工、修改文件、验证结果和剩余风险。
```

## 推荐调用方式：多仓库深度对比

```text
使用 source-feature-adaptation
参考项目 A：<仓库 A>
参考项目 B：<仓库 B>
目标项目：<当前项目路径>
需要实现：<功能列表>
可用代理：最多 8 个 subagent

按参考仓库 / 技术层 / 目标模块分解真实独立工作，
优先并行定位功能机制，再实施；禁止多个代理同时编辑共享文件。
若无委派能力，退回单代理流程并说明。
```

也支持明确要求“只分析”“只输出方案”“只生成提示词”，这些模式不应擅自修改目标代码。

## 目录

- `SKILL.md`：触发条件、默认行为、两波并行策略、原始完整实施与验收流程。
- `references/parallel-playbook.md`：并发判断、任务 DAG、工作树隔离、减少重复查阅、合并与测试策略。
- `references/agent-briefs.md`：研究者、实施者、测试者、审查者的可复制派工信封和报告模板。
- `references/platform-orchestration.md`：Claude Code、Codex 运行时支持与降级策略。
- `references/task-plan.example.json`：多代理任务依赖/文件所有权计划示例。
- `scripts/validate_task_plan.py`：用标准 Python 校验任务 DAG、文件写入冲突；只校验计划，不启动代理。
- `references/feature-mapping.md`：功能/源码证据、目标落点与验收映射模板。
- `references/validation-checklist.md`：行为、许可、平台、协作与测试质量闸门。
- `agents/openai.yaml`：ChatGPT Skill 展示信息。

## 任务计划预检（可选）

大型任务可先复制 `references/task-plan.example.json` 为一个本次任务的计划文件，再按实际范围编辑。执行：

```bash
python scripts/validate_task_plan.py path/to/task-plan.json
```

输出 `VALID` 表示**计划结构**中未发现依赖环或无序并发写冲突，不代表代码已经实施或测试通过。`INVALID` 则应先修正 DAG 或文件所有权再派工。

## 兼容说明

将整个 Skill 目录放到宿主支持的 Skills 目录，或导入 `skill.zip`。具体调用方法、子代理数量限制及 worktree 配置取决于 Claude Code、Codex 或其他宿主的版本和权限。参考 `references/platform-orchestration.md` 中的官方资料；不需要为了使用此 Skill 自动修改全局配置。
