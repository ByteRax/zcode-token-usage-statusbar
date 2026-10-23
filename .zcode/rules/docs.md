# 文档、本地化与宣传物料规则

适用路径：`README.md`、`README.zh-CN.md`、`README.en.md`、`docs/`（user-guide、maintaining、features、design-notes、quota-support-audit、promo、tour）、三份 README 的市场/Topics 元信息、`docs/promo/`、`docs/tour/`。

## 1. 文档对应关系

- `README.md` 与 `README.zh-CN.md` 保持一致（中英标题按节一一对齐，人工核对纪律）；`README.en.md` 在功能、限制、安装、发布范围上对应，可链接中文详细文档但要标明语言。Web 两份 README 同步维护。
- 标点与结构是稳定契约不做迁移：正文 ASCII 直引号、UI 标签「」、英文破折号保留；README 章节结构已多轮定稿，不重排。
- 配置键、默认值、协议、兼容性变更时同步 `config.example.json`、相关 README、user-guide、插件 README/命令/hooks/技能；设计或发布链变化同时核对 maintaining/设计文档。JSON 示例不含注释，路径占位须说明替换；检查仓库相对链接、标题锚点与示例可解析。
- 文档中不写死会漂移的数字（测试用例数、清单长度、版本清单）；要写数字须由实测对账（验证代理抓过 13≠15）。
- 客户端升级登记新桥版本时，同步文档中的版本列表（README×3 / user-guide / 插件 README）；user-guide 的「核对 YYYY-MM-DD：vX.Y.Z」标注随每次发版递增。
- `docs/user-guide.md#远程会话` 等锚点被 AGENTS/README 引用，改标题先查反向引用。

## 2. 文案纪律

- 宣传与功能文档文案禁用「实时」（数据为入库后计算或字符增量估算，不是逐字流式）；禁「精准校准 / 彻底解决 / 绝不」类强断言、无分母命中率、演示数据当真实指标。
- 差异化卖点=上下文占比 + 中英双语 + 首屏截图三条守住，不拼竞品功能清单。
- 逐问速率行的标签（`token_rate.py format_turn_line`）不分语言恒中文（硬编码无 locale 分支，英文宣传图里速率行是手写演示文案，已知产品限制）；`overlay.js` 自身 `L()` 双语可在布景页 `localStorage.setItem("zusage3.lang","en")` 取真实英文文案，不手写翻译。
- 市场条目保留 `description_i18n`；门面显示名「速度状态栏」与市场 UI 显示的 slug 派生名（"ZCode Token Usage Statusbar"）不一致**刻意保留**——slug、市场名、命令、配置键、仓库/安装指引里的英文名都不擅改（受插件市场 UI 名约束，真改是破坏性工程）。README 安装指引中的英文名是市场实际显示名，不能翻译。
- GitHub 默认仓库搜索只匹配 name+description+topics（README 需 `in:readme`）——辨识度关键词写 Description/Topics 而非正文堆同义词；topics ≤20、仅小写字母数字连字符、≤50 字符、不加竞品名不凑满。远端写入（Description/Topics/README）后 `gh api` 回读确认。

## 3. 宣传图与 tour 截图（docs/promo、docs/tour）

- 产品截图一律走 HTML 布景 + 真实 `overlay.js` 渲染 + Playwright 导出（`docs/promo/shoot.py [html] [out] [w] [h] [hover序号|none]`，本机缺 chromium 时回退 `channel="chrome"`）；shoot 内置 CHECK_JS 自检，`problems:[]` 全清零是唯一验收标准（overflowPx=0、内容未被收缩隐藏等）。
- 布景页必须复刻真实 DOM 形态：工具行容器加宿主同款 group 类让挂载原生生效（手动伪造挂载类会被对账打回）；不留真实效果中不存在的 CSS；条面选择器与当前 overlay 的实际类名一致（旧 id 选择器静默返回 0 节点，不报错）；挂靠卡片不得用 `opacity<0.1` 隐藏（幽灵判定会不挂条），用透明背景方案。
- 改 overlay 挂载/外观/单位/文案（万/亿、时间行、面板结构）后主动重渲染 promo 四图与 tour 全套；判断图过期不能只看 mtime，要核对选择器与条面 DOM 是否对得上（tour 的 shoot 失配是静默失败不抛错）。tour 重拍：`python3 -m http.server 8799` + `uv run --with playwright python docs/tour/shoot.py`。
- 布局排查写一次性 Playwright inspect 脚本量 `getBoundingClientRect`，别反复截图猜参数；「先判断存在再配对」的列表用 {name,rect} 结构一起过滤（平行数组下标错位）。
- 窄窗触发的收缩+渐隐是真实行为不是回归；宣传图不得展示降级态，文案变宽（英文/万/亿）须重排布景宽度。`#poster` 区块不进任何已发布图片。社交文案在 `docs/promo/social-copy.md`；市场地址/插件名各图保持一致。

## 4. 已知文档滞后（改到对应领域时核对）

- README 与用户指南的正式自动安装范围不同；README 命名空间命令说明与用户指南裸命令不同；设计笔记的「空闲零进程」、`current` 窗口及「最近一次速度」与实现不完全一致。
- 安装命令文档的 `sudo python install.py` 不适用于仅含插件子树的缓存；Web 文档的 `node:sqlite` 理由与当前实现不匹配。核对时结合源码/契约测试，不顺手改业务逻辑或宣称正式渠道已有 main 功能。
