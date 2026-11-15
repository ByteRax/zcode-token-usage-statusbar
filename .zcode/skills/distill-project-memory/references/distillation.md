# 沉淀模板与增量记录

## 可执行规则

- **标题**：表达明确动作。
- **适用**：触发条件、模块/文件范围。
- **要求**：应该做什么、禁止什么及必要例外。
- **验证**：可执行检查或可观察结果。
- **依据**：指向仓库内详细文档；不要复制完整背景。

示例仅表示写法，不代表项目现状：若证据确认独立浏览器与 Electron 宿主渲染有差异，可写“涉及宿主布局的发布截图在实际 Electron 环境验证；独立 HTML 预览仅用于辅助检查”，并在 docs 记录环境和验证步骤。未核验前不能自动采用此规则。

## 经验文档条目

### <主题：具体问题及结论>
- 适用范围：
- 触发条件与表现：
- 原因与证据：
- 建议处理步骤：
- 不适用情况/失败方案及原因：
- 验证方式与实际结果：
- 相关实现/测试/决策：使用仓库相对路径和章节链接。
- 状态：已验证 / 待核验 / 已被替代；只有结论变化时更新日期。

没有证据的字段不要补造。可按项目风格压缩，不机械填空。

## 可选增量清单

优先复用已有追踪文件；没有持续扫描需要时不创建。必要时用 `docs/experience-index.json`，例如：

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "host-rendering-validation",
      "sourceRefs": ["zcode:project-memory:rendering-note"],
      "sourceDigest": "sha256:<normalized-relevant-content>",
      "evidenceRefs": ["src/example.js"],
      "evidenceDigest": "sha256:<relevant-evidence>",
      "status": "verified",
      "targets": ["docs/engineering-lessons.md#host-rendering"],
      "reason": "实现和可复现结果支持结论"
    }
  ]
}
```

上述路径和摘要均为占位示例，实际写入前替换；不直接复制。状态可用 `verified`、`pending`、`skipped`、`superseded`。记录失败理由和待核验原因以便后续重试，不把 pending 当成永久跳过。

- 摘要基于相关内容而非 mtime；不包含抓取时间等波动元数据。
- sourceRefs 使用不泄露本机路径的稳定逻辑标识；本地绝对路径映射如确有必要，放在已确认被忽略的本机配置中，不自行修改全局配置。
- evidenceDigest 关联真正支持结论的代码/规范内容，避免整个仓库每次提交导致全量失效。
- 更改摘要、状态、目标或结论时更新条目；无变化不重写。
- 不记录无关来源正文或秘密的摘要；先排除敏感内容，再计算相关内容摘要。
- 清单不存在、损坏或版本不支持时，基于现有文档重新比对；保留原文件，说明问题，不能以无法读取清单为由重写所有规则。
