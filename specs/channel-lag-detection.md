# 渠道落后察觉

## 目标与边界

- 更新器有三条路径的版本源只有宿主手里的渠道清单：market 渠道（清单指向源码路径）、GitCode Release 渠道（按设计不调 GitCode API）、GitHub Release 渠道在 API 检查失败后的清单兜底。清单因任何原因没跟上最新发布——渠道分支被改写、清单没推、宿主刷新市场静默失败（issue #247、#308、#497）——这些用户只会看到「已是最新」，没有任何报错。
- 本规格让前两条路径在结论为「已是最新」时，用不依赖用户克隆的 Release 列表交叉核对一次；清单落后于最新发布时留下可见、可诊断的记录。维护者本机不经线上渠道，渠道坏了只有这条提示和用户反馈能暴露问题。
- 只提示，不换源：不替宿主修市场克隆，不从 Release 渠道安装，不修改用户的市场注册。
- GitHub Release 渠道经清单兜底得出「已是最新」时不交叉核对：那一刻 GitHub API 刚失败，再问一次只会同样失败。这类用户在 API 恢复后由既有检查拿到更新，是已知缺口。
- 交叉核对是诊断，不是检查的一部分：任何失败（网络、限流、格式、仓库不支持）一律静默返回，不改变检查结论，不写失败记录。

## 规则

- 触发：`plugin-updater.cjs` 的 `check()` 结论为 `current`（渠道版本不高于已安装版本），且本轮版本源只有渠道清单（`checkedVia` 为 `market`，或 GitCode Release 渠道的 `release-catalog`）。结论为 `available` 时不核对——用户马上会装上渠道里的版本，下一次检查自然会核对。
- 来源：GitHub flavor 问注册仓库的 Release 列表（`checkRelease`）；GitCode flavor 只在注册仓库是官方镜像时问镜像的 Release 列表（`checkGitcodeMirrorRelease`）。其它 GitCode 仓库与本地目录来源不核对。
- 判定：最新正式 Release 版本大于渠道版本即落后。GitHub 侧「最新」要求发布包完整（`validateRelease`），与 Release 渠道安装口径一致；GitCode 侧要求该 tag 的 manifest 完整。
- 落痕：写入 `plugin-update.json` 的 `lastError`，与检查失败同一字段（⚙ 更新区在非错误相位显示，下次检查成功即清）。消息写明渠道版本、最新发布版本和两步处置：在插件市场刷新 `zusage-marketplace` 后重新检查；仍不行则移除该市场后按仓库地址重新注册。渠道跟上后，下一次检查清空记录。
- 并发：交叉核对要等网络，期间来源或结论可能被改写；来源与本轮不一致时不落痕。
- 限频：沿用检查本身的节流（自动检查按 `INTERVAL_MS`，手动检查每次），不另设计时器。

## 验收

| 场景 | 可观察结果 |
|---|---|
| market 渠道，渠道版本等于已安装版本，Release 列表有更新版本 | `phase=current`；`lastError.message` 同时含渠道版本与最新版本；`plugin-update.json` 落盘同一消息；没有安装、没有同步 |
| market 渠道，Release 列表不高于渠道版本 | `lastError` 为空 |
| market 渠道，渠道版本高于已安装版本 | 不发交叉核对请求，照常进入更新 |
| market 渠道，交叉核对请求失败（限流、断网） | `phase=current`，`lastError` 为空，检查不报错 |
| GitCode Release 渠道，渠道清单落后于镜像最新 Release | `lastError.message` 同时含两个版本 |
| GitHub Release 渠道经 API 得出「已是最新」 | 不发第二次列表请求 |
| 本地目录市场 | 不发交叉核对请求 |
| 渠道落后被记录后，下一次检查渠道已跟上 | `lastError` 清空 |

自动化验收使用 `tests/plugin-release-updater.test.cjs`。真实渠道落后（分支断链）的端到端表现需实机验证。
