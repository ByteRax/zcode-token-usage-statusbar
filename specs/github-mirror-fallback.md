# GitHub 渠道 GitCode 镜像回退（issue #310）

## 问题

GitHub Release 渠道用户在 github.com / api.github.com 不可达（国内网络环境常见）时更新全链失败：

1. 检查：`checkRelease`（api.github.com）失败 → `catalogFallback` 内宿主 CLI `marketplace update`（GitHub zipball）也失败 → 检查报错。
2. 下载：`downloadRelease` 的 manifest/zip URL 均为 github.com 域。
3. 安装：宿主 CLI `plugins install` 按本地市场缓存清单的 `source.url`（github.com）下载。

报错指引「改用 GitCode 镜像渠道」要求用户手动 remove+add 重新注册，门槛高。

## 宿主事实（ZCode 3.18.1 引擎源码实证，glm/zcode.cjs）

- `plugins install` 路径 `sEc`→`A1n`→`Pya`→`$yt`：**本地缓存清单（`<storage>/marketplaces/<id>/marketplace.json`）存在时全程不联网拉清单**（`nwe` 只在缓存缺失时才在线拉取）；zip 源下载器 `hwo`/`a1n` 按清单 entry 的 `source.url` 下载，仅校验 https 形状与 sha256，**无域白名单**。
- 安装提交的 `installed_plugins.json` record.source = 安装时缓存清单 entry.source（fixture 同款语义）。
- 已注册渠道与缓存清单是两层：`known_marketplaces.json`（注册来源，判定渠道身份）不随缓存清单内容变化。

## 方案：三环节官方镜像回退

官方 GitCode 镜像 `tanranran/zcode-token-usage-statusbar`（与 `plugin-releases-gitcode` 渠道、GitCode Release 镜像、notes 回退同一仓库）。GitHub Release 资产与 GitCode Release 资产由发布链同产物生成，**sha256 逐字节一致**（发版工具 `--gitcode-repo` 保证）。

### 触发边界

- 仅 GitHub flavor 的 release 渠道，且**注册仓库必须是官方上游**（`ByteRax/zcode-token-usage-statusbar`，与 `GITHUB_UPSTREAM_REPOSITORY` 常量比对）：fork/第三方副本注册的渠道内容可能与官方不同，静默换装官方字节会无提示覆盖 fork 改动——这类渠道网络失败只如实报错且**不带换渠道指引**（指引会诱导 fork 用户换成官方渠道、静默丢失 fork 内容），不自动镜像。改名迁移生效时注册名对不上上游，同样不镜像。GitCode 渠道/本地目录/market 渠道不适用。
- 检查第三跳的判据是**第一跳（GitHub API）失败的 cause** 命中网络/限流类特征（`GITHUB_UNREACHABLE`：超时、DNS/连接/证书错误、TLS 握手前断连、403/429/5xx；清单回退失败的原因不参与判定——API 正常而宿主刷新失败时镜像救不了安装，不试）。「无正式 Release」「分页上限」等业务类失败直接抛，不试镜像。
- 镜像检查失败如实报三层原因（原始 + 清单回退 + 镜像）并附换渠道指引；不静默降级。

### 检查（第三跳）

`checkRelease`（API）失败 → `catalogFallback`（宿主刷新 GitHub 清单）失败 → `checkGitcodeMirrorRelease`（plugin-release.cjs）：

1. GitCode v5 API 列 Release（`api.gitcode.com/api/v5`，notes 同款 API 白名单），过滤 prerelease 与非 `v`+稳定语义版本，取最大版本。
2. 下载该 tag 的 `release-manifest.json`（gitcode.com，DOWNLOAD_HOSTS 白名单）并校验身份（schemaVersion/pluginId/version/tag/asset 形状）。
3. 合成镜像行：`{ flavor:"gitcode", mirror:true, repository:镜像仓库, archive:{size:manifest.asset.size, url:gitcode zip}, manifest:{url}, url:gitcode release 页 }`。`checkedVia:"release-mirror"`。

合成行的资产身份由 manifest.sha256 承担（downloadRelease 下载后还要再下载并校验 manifest+zip sha256），镜像清单不必与 GitHub 渠道清单逐字节对账。

### 下载

镜像行天然 gitcode 域 URL，`downloadRelease` 无需改动：`validateManifest` 的 gitcode flavor 分支（manifest.repository=上游 ByteRax 合法即可）与解包器 `--repository` 传 manifest.repository 均已存在。`catalogSha256` 交叉比对镜像行不携带（undefined 跳过）。

### 下载阶段半通转换

api.github.com 可达、github.com 下载域不可达的半通形态（真机实测形态：TLS 握手前断连）下，检查按 API 行成功、第三跳不触发，但安装内下载必然失败。`installUpdate` 捕获 `prepareRelease` 的网络类失败后做**同版本转换**：

- 门控与第三跳同款：仅 GitHub flavor 的检查产物行 + 注册仓库为官方上游；GitCode 渠道下载本就是镜像域资产，超时按同源重试即可，转镜像行会因形状与 GitCode 渠道复核门不符导致「装成功却报更新失败」。
- `checkGitcodeMirrorRelease(…, targetVersion)` 按**已选定版本**钉死直取镜像 manifest（不查 API 列表，不被镜像侧更新版本带偏——面板已呈现什么版本就装什么版本）；镜像缺该版本或身份无效时不顶替 GitHub 下载根因，合并两层原因上报；非网络类下载失败（如 sha256 校验失败）不转换，避免掩盖真实资产问题。
- 转换成功后 `selectedRelease` 换为镜像行、`state.checkedVia="release-mirror"`、`state.mirror=true`、`releaseUrl` 指向镜像 Release 页，后续安装分支随 mirror 标记走缓存清单补丁。

### 安装（缓存清单镜像补丁）

宿主 install 下载源是本地缓存清单 entry。镜像安装时：

1. 读缓存清单字节，把本插件 entry 的 `version` 与 `source.url`（→镜像同版本 zip）/`source.sha256`（→manifest.asset.sha256）原子改写（同目录临时文件+rename），其余字段不动。
2. 读回校验 entry 与已验证 manifest 一致后走原宿主 `plugins install`（宿主不联网拉清单，按镜像 URL 下载并 sha256 校验）。
3. 安装结束（成功或失败）`finally` 原子恢复原清单字节；恢复失败容忍（GitHub 恢复可达后 `marketplace update` 亦会收敛）。
4. 镜像模式跳过安装前 `refreshMarketplace()` 与 GitHub 清单新鲜度重读（那是 GitHub 模式防 #247 旧版回装的守卫；镜像模式的版本源是已下载校验的 manifest）。

### 校验豁免（防伪造）

- `selectedRelease.repository` 与注册仓库不同：镜像行豁免（repository 必须精确等于内置镜像常量）。
- `verifyCommittedRelease`：镜像行走 `validateGithubMirrorRelease` 严格门（mirror 标志 + 固定镜像仓库 + URL 精确形状 + version/tag 自洽）；`record.source.url` 与镜像行 archive URL 的 sameAssetUrl 比对天然成立（宿主按补丁清单安装）。本地状态文件伪造 mirror 标志最多把安装指向官方镜像的已校验资产，无提权面。
- 渠道身份守卫（known_marketplaces 深比较）不豁免：注册来源全程不变，不构成「静默切换市场来源」。

### 状态与展示

- `state.checkedVia = "release-mirror"`；`state.mirror = true`（仅镜像选定后本轮检查有效）。
- `state.releaseUrl` 为 GitCode Release 页（链接天然诚实）。渲染端「更新来源」行的「经 GitCode 镜像下载」文案标注随后续 overlay 批次接入（消费 `state.mirror`，旧浮层忽略该新增字段无契约影响）。

## 不做

- 不自动改写 `known_marketplaces.json` 注册来源（不静默切换渠道）。
- 不为 market 渠道/本地目录来源/fork 注册渠道做镜像。
- 不做用户自定义镜像源配置。

## 已知边界（容忍的残余风险）

- **补丁窗口与宿主 `marketplace update` 并发**：`assertApplied` 之后、宿主 install 读清单之前，缓存清单被并发刷新回 GitHub URL → 宿主装成功但 `record.source.url` 与镜像行不符 → 提交复核 fail-closed 报错，pending 意图滞留至人工清除（宿主 CLI 同刻不可达 GitHub 时该竞态实际不可发生；窗口秒级）。补丁读写带 `.zusage-marketplace.transaction.json` 事务守卫，与清单读取同款。
- **restore 失败静默**（写回原字节失败）：GitHub 恢复可达后宿主 `marketplace update` 会以注册来源清单收敛；清单短暂停留在补丁态不影响身份判定（readChannel 只读注册文件）。
- **跨版本回退**：能写出镜像意图的 updater 必然能复核它；旧版 updater 读到镜像 pending 会 fail-closed 报「资产来源或大小无效」并滞留，需人工清 pendingRelease——与改名迁移意图同款例外，`overlay_install.py` migrate 不登记镜像意图（见 install-release.md §1）。
- **镜像列表单页风险已消除**：API 列表翻页与客户端版本重排同 `checkRelease` 防御，不信任服务端 `direction` 参数。

## 验收场景

1. API 403/429/超时 + 宿主刷新失败 + 镜像可用 → available → 安装成功（record.source=镜像 URL、运行时同步完成、缓存清单已恢复）。
2. 镜像 API 也失败 → 报错含三层原因与换渠道指引，无安装动作。
3. 非网络类检查失败（资产校验/分页上限）→ 不请求镜像域。
4. 镜像 pending 意图恢复（recoverPending）→ verify 豁免通过；篡改镜像行 repository → 拒绝。
5. GitHub 正常时全链与现状逐字节等价（镜像跳零触发）。
