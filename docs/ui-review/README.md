# 桌面 UI 审查与验收

本目录是当前工作树桌面 UI 改动的隔离证据，不是已安装或已发布版本的证明。示例数据由 `tests/ui-fixture.html` 生成，无个人数据库、凭据或真实账号请求。

## 问题分类与改动

- **源码已确认：** 设置齿轮、子代理入口原为普通 span；改为有名称的按钮。额度／Git chip 原有 focus tooltip 保留，并补 Enter／Space 激活。设置采用非模态 dialog，不添加 Tab 焦点陷阱；Escape、关闭按钮恢复入口焦点，外点关闭不抢新目标的焦点。
- **截图设计建议：** 统一 24×24 线性 SVG、圆角描边和小尺寸视觉重量。本轮改为单消息、会话累计改为叠消息，重绘速度、工具、日历、分支和齿轮；生成／思考／工具阶段的更新路径保留不同图标。主要数值与辅助文字分层，保留等宽数字和宿主字号。
- **源码已确认：** 子代理 tooltip 是连续句；改为输入、输出、缓存、请求、速度和状态行。工具按原顺序对齐名称、次数、耗时。单次耗时、首字和轮总分行，完整测速说明放脚注，不改变统计计算。
- **源码已确认：** 额度写入失败原来只记日志；增加仅含请求 ID、成功／失败与中性错误的结果通道。源反馈跨列表重画保留，凭据不回显；迟到的成功确认不会清除新输入。旧主进程缺确认协议时显示“操作已发出；保存确认需重启后端”，不声称保存成功，也不锁死控件。
- **源码已确认：** 源列表原来没有在途状态；从既有 `inFlight` 追加布尔 busy，查询开始／结束推送，关闭源仍 disabled，不修改同源并发保护、TTL、退避、适配器或鉴权。
- **源码已确认：** 更新检查时间原来跟随系统 locale；显示改为浮层语言的“上次成功检查”，不改 `checkedAt` 生产语义。
- **需运行验证：** 真实 Electron、多窗口、屏幕阅读器、完整宿主主题、真实保存和供应商响应仍未验收。

## 同视口前后图

固定视口为 1280×720，数据和时间相同；before 使用本次运行时的 `HEAD:overlay.js`，after 使用工作树根源码。

| 状态 | 修改前 | 修改后 |
|---|---|---|
| 状态条 | [before-bar.png](before-bar.png) | [after-bar.png](after-bar.png) |
| 本轮 tooltip | [before-turn.png](before-turn.png) | [after-turn.png](after-turn.png) |
| 设置 | [before-settings.png](before-settings.png) | [after-settings.png](after-settings.png) |

[保存失败夹具](save-failure.png) 。深浅、反色 tooltip 与中英文宽窄图也保存在本目录。

## 实测结果与边界

- 内置浏览器已优先实际打开 promo 页并读取 DOM、操作设置；其截图 surface 连续超时后降级为 Chrome DevTools。Chrome DevTools 实际确认了 hover、设置打开、方向键及 Escape 焦点恢复。之后 Playwright 在同类 Chromium 页面执行可重跑矩阵。
- 12 组受控矩阵：dark／light／inverse × zh／en × 1280px／14px 字号及 560px／20px 字号。验证 tooltip 视口限制、真实指针移入走廊、切页锁高、窄导航 title、Enter／Space／Escape、关闭焦点返回及语言单选方向键。
- 文字对比度通过计算样式和实际背景混合测量；本次采样最低 6.42∶1。该数字仅代表夹具提供的主题令牌，不代表所有实际宿主配色均达到 4.5∶1。控件边界和状态色的全宿主主题矩阵仍需 Electron 验证。
- 固定对照中，状态条从约 23.2px 高变为 27px 高，宽度仍为卡片内宽；设置打开高度均为 516px。窄栏保留既有收缩和渐隐，不用换行或继续缩字隐藏拥挤。
- 429 项相关 Node 回归通过，0 失败、0 跳过；17 项 `test_statusbar_rate.py` 通过。Python 测试出现未关闭 SQLite 连接的 `ResourceWarning`，未导致断言失败。
- 根 JS/CJS 语法、副本漂移、Python 截图脚本语法检查通过。四张 promo 自检均为 `problems: []`，中英文 tour 全套命中实际 tooltip／面板；不以旧图 mtime 作为新效果证据。

详细几何和计算样式见 [metrics.json](metrics.json) 。重跑方式见 [tests/README.md](../../tests/README.md#桌面-ui-隔离浏览器验收) 。

## Web 独立评估

`web/overlay.js` 没有改动。Web 仍有状态条上下文格，子代理零值受“有消耗或活动”的额外门控；语言、显示项持久化、宽窄布局及统计行字段与桌面不同。Web 无桌面额度凭据链，也不使用桌面配置保存确认。桌面改版不能复制覆盖 Web，本轮没有启动 sidecar／nginx 或验证 Web 旁挂认证。

## 部署状态

只运行了 `sync_plugin.py` 同步仓库内插件副本。未更新宿主插件缓存、稳定运行目录或客户端文件；未提交、推送、安装或发布。`inject-main.cjs` 和 `quota-client.cjs` 是冷文件，将来若部署，需完全退出并重启后才可验收新反馈链。


## 设置导航与高度后续修正

截图中的白色月牙来自选中项的左侧 inset box-shadow 被圆角弯曲，并非额外 SVG。已移除该弧形标记，选中底色和完整键盘焦点轮廓继续保留。设置面板打开时采用视口高度的 82%，受状态条上方实际可用空间限制；切分区仍锁高，缩小窗口仍只收紧。1280×900 夹具实测从 576px 提升到 738px，打开「关于数据」等短分区也不再变矮。

对照：[修正前](settings-crescent-before.png) ／ [修正后](settings-crescent-after.png) 。本次只同步仓库副本，尚未部署运行目录。
