# 手机端油猴脚本构建链（mobile userscript build）

`docs/zusage-mobile.user.js` 是**编译产物**，不是手写文件：手机特有逻辑（中继旁听/分片重组/overlay 加载器/回退 UI 骨架）以分片源码维护在 `src/mobile/`，其中「照抄桌面」的内容（格图标 SVG、格样式、TPS 色档、设置面板显示项行）在构建期从桌面分片（`src/overlay/`）**按锚点注释提取注入**。桌面分片更新后重新构建，油猴产物自动跟随；锚点缺失或声明失配时构建直接报错（fail-fast），不允许静默漂移。

## 1. 文件与职责

| 文件 | 角色 |
|---|---|
| `src/mobile/[0-9][0-9]-*.js` | 油猴脚本分片源码（字典序拼接；命名约束同 `src/overlay/`，杂名文件构建报错） |
| `scripts/build_mobile_userscript.py` | 零依赖构建脚本：拼接 + 提取 + 改写 + 占位符替换，一次产出正式/调试两个产物；`--check` 校验两份产物一致 |
| `docs/zusage-mobile.user.js` | **正式版**产物（用户从 CDN/LAN 安装的实体）：`DEBUG_BUILD = false`，不创建调试面板（`zm-dbg`）与 ☰ 钮，页面零调试痕迹 |
| `docs/zusage-mobile.debug.user.js` | **调试版**产物：`DEBUG_BUILD = true`，默认显示排障面板（帧统计/overlay 加载状态/注入时序）；`@name` 带「·调试版」避免篡改猴按 name+namespace 与正式版互相覆盖。排障时装它，装回正式版恢复干净 |

两变体**仅 3 处差异**（`DEBUG_BUILD` 开关、`@name`、`@description`），共享全部提取与逻辑代码；stats 帧统计两版都照常收集（正式版只是没有 UI 展示）。「未捕获中继连接，请刷新页面」等**功能提示**写在状态条 `zm-idle` 上，不属于调试面板，正式版保留。

油猴产物**不进**插件分发清单（`sync_plugin.py` `FILES`）：它是 `docs/` 文档树资产，不随插件包发布；同步入口只有本构建脚本。桌面侧锚点注释随 `overlay.js` 产物走 `build_overlay.py` → `sync_plugin.py` 正常链。

## 2. 分片内容划分（唯一手写部分 = 手机特有）

| 分片 | 内容 |
|---|---|
| `00-meta` | UserScript 元数据头（`@version` 手写管理，构建不自动 bump）+ 文件头说明 |
| `10-relay` | IIFE 开 + 偏好（`zusageMobilePrefs`）+ @zcode/rpc 只读解码（Reader/utf8Decode/base64）+ 帧统计 |
| `20-overlay-loader` | rpc-frame 分片重组（fragMap）+ 桌面 overlay.js 加载器（OVERLAY_URLS/applySnap） |
| `30-ws-hook` | WebSocket/Worker/SharedWorker 透明包装（observe-only） |
| `40-fallback-ui` | 回退 chips 条 UI 骨架 + 调试面板 + boot 收尾 `})();` |

## 3. 锚点契约（桌面分片侧）

锚点是**注释级标记**，不改变桌面运行行为；桌面重构时删改锚点会让构建报错——这是设计意图（强制人工确认手机端跟随）。

| 锚点 | 位置 | 形态 |
|---|---|---|
| `/*zm-ico:<id>*/` | `src/overlay/07-*.js` 各状态条格图标字面量前 | `ico(/*zm-ico:speed*/'<path…/>')`；id ∈ 油猴声明集合 |
| `/*zm-cell-css-begin*/` / `/*zm-cell-css-end*/` | `src/overlay/06-*.js` 格样式拼接区（`.it` 起、`.eb` 止，可含无关规则——构建白名单过滤） | JS 代码层注释，框住字符串拼接段 |
| `/*zm-band-css-begin*/` / `/*zm-band-css-end*/` | `src/overlay/06-*.js` 色档规则区（深色组与 `.zu-light` 浅色组**各一对**） | 同上 |
| `/*zm-show-rows-begin*/` / `/*zm-show-rows-end*/` | `src/overlay/06-*.js` buildPanel 显示项 `settingRow` 区 | 同上 |

## 4. 提取与改写规则（构建脚本侧）

- **图标**：正则收集 `/*zm-ico:<id>*/'<path>'` → `var ICONS = {…}`。油猴 `40-fallback-ui` 内声明 `/*@zm-icons <id逗号集>@*/`；声明的每个 id 必须在桌面锚点中有命中，否则报错（桌面删格 → 油猴同步删声明）。
- **格样式 CSS**：锚点区间内全部 JS 双引号字符串段连接 → 按顶层 `}` 切规则 → 白名单过滤（`.it`/`.sep`/`.k`/`.v`/`.dim`/`.eb` 及 `.zusage-root` 前缀形态；`.zu-gear`/`.zu-live`/`.btn`/`@keyframes`/`@supports` 等桌面特有规则丢弃）→ 选择器改写：`.zusage-root` 前缀替换为 `.zm-root`，裸类逐个加 `.zm-root ` 前缀（逗号分组逐项处理）。
- **色档 CSS**：同上切规则；深色组 `.ok/.warm/.hot/.zu-teal/.zu-sky/.zu-azure/.zu-violet/.zu-purple/.zu-magenta/.zu-ultra`（单一 color 声明）→ 每条展开为 `.zm-root .zm-band-<n>` 与 `.zm-root .zm-tone-<n>` 两份（与 `src/overlay/13-mobile-chips.js` 的 `MC_BANDS`/`mcToneOf` 值域对齐）；浅色组 `.zu-light .<n>` → `.zm-light .zm-band-<n>` + `.zm-light .zm-tone-<n>`。`.zu-ultra` 的 `::before`/`@supports` 渐变块不收（回退条保持基础色简化版）。
- **显示项行**：锚点区间提取 `settingRow('<input type="checkbox" data-k="<k>">', L("<zh>",…), L("<zh>",…))` → 油猴声明 `/*@zm-show-keys <k逗号集>@*/` 过滤（手机 chips 数据源只有 turn/win/proj/today/tools/sub；桌面新增键不自动进手机——13 分片 `mcIds` 未映射的键没有数据）→ 生成 `<label><input type="checkbox" data-k="k"><span>标题<em>描述</em></span></label>` 行（中文分支）。声明的键必须在桌面提取结果中存在，否则报错。
- **占位符**（`40-fallback-ui` 内）：`__ZM_ICONS__`、`__ZM_CELL_CSS__`、`__ZM_SHOW_ROWS__`。构建后不得残留任何占位符，残留即报错。

## 5. 命令与回归

```bash
python3 scripts/build_mobile_userscript.py          # 生成正式版 + 调试版两份产物
python3 scripts/build_mobile_userscript.py --check  # 两份产物与源码/锚点一致性校验
node --test tests/mobile-userscript.test.cjs        # 产物契约（含桌面提取段与变体差异抽查）
```

`--check` 进 AGENTS.md §6 基础命令清单；修改 `src/mobile/`、桌面锚点或提取逻辑后必须重跑。桌面 06/07 分片改动（含锚点增删）后按常规跑 `build_overlay.py` + `sync_plugin.py` + overlay 回归——锚点注释进 `overlay.js` 产物属预期（注释级，零行为）。

## 6. 验收场景

| # | Given | When | Then |
|---|---|---|---|
| A1 | 桌面 07 分片图标路径改动 | 重新构建 | 油猴产物 ICONS 同步变化；`--check` 在未重建时红 |
| A2 | 桌面删除某格图标锚点 | 构建 | 报错指出缺失 id（fail-fast，不产出静默缺图标） |
| A3 | 桌面 06 分片调整 `.it` 样式 | 重新构建 | 产物格样式段同步（`.zm-root` 前缀正确、逗号分组逐项改写） |
| A4 | 油猴声明引用桌面不存在的 data-k | 构建 | 报错指出失配键 |
| A5 | 产物被手改 | `--check` | 红（产物只读，必须改分片重建） |
| A6 | 产物在浏览器执行 | 加载回退条 | 图标/样式与桌面同代；占位符零残留；`node --check` 语法通过 |
