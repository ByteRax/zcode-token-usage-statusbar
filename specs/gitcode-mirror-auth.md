# GitCode Release 镜像的接口鉴权

## 目标与边界

- `release_tool.py publish --gitcode-repo` 在 GitHub 发布验收后把同一字节的资产镜像到 GitCode。镜像步骤的每一个 GitCode API 调用都带 `GITCODE_TOKEN`：查询同 tag 的 Release（创建前与上传后各一次）、创建 Release、取上传凭证。
- 起因：GitCode 匿名接口按公共机器人账号计共享额度（报错原文 `Threshold: 10W times per user per hour. Limited account:p_repoRobot`）。额度被用光时匿名调用返回 429，与本项目调用量无关。此前两处查询不带令牌，镜像步骤会在 GitHub 已经公开之后整体失败。
- 只约束发布工具的镜像步骤。更新器（`plugin-release.cjs`）对 GitCode 接口的使用按它自己的合同，不在本规格内。
- 令牌只经查询参数发送，不落盘、不进日志、不出现在报错里（`gitcode_api` 的既有约束不变）。

## 规则

- `gitcode_mirror` 对 `GITCODE_TOKEN` 的要求不变：缺失时 `--publish` 在创建 GitHub draft 之前整体失败。
- 查询、创建、取上传凭证一律带令牌；不为了省本人额度把查询改回匿名。
- 带令牌的查询返回 401/403 时照旧以 `gitcode release lookup -> HTTP <状态码>` 失败，此时 GitCode 上还没有创建任何东西；不回退到匿名查询——令牌无效时创建与上传同样会被拒，回退只会把失败推迟到写入之后。

## 验收

| 场景 | 可观察结果 |
|---|---|
| 匿名调用被限流（429），带令牌的调用正常，镜像上没有同 tag 的 Release | 镜像步骤成功：创建 Release、上传两个资产、回读比对、写出 GitCode 渠道清单；镜像步骤没有任何不带令牌的调用 |
| 匿名调用被限流（429），镜像上已有同 tag 的 Release | 带令牌查询返回 200，复用该 Release，不重复创建，上传与回读照常 |
| 带令牌的查询返回 401 | 以 `gitcode release lookup -> HTTP 401` 失败，没有创建请求，没有上传 |
| `GITCODE_TOKEN` 缺失 | `--publish` 在创建 GitHub draft 之前失败（既有行为） |

自动化验收使用 `tests/test_release_tool.py`。
