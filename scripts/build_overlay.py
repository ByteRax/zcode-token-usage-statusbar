#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""零依赖拼接脚本：将 src/overlay/[0-9][0-9]-*.js 按序拼接为根目录单文件 overlay.js。

设计目标：
- 保持分发产物形态不变：根目录 overlay.js 与 plugins/.../overlay.js 仍为单文件 IIFE，
  无需打包器或第三方依赖，也不改变 Release ZIP 的文件清单契约。
- 降低维护粒度：2MB 的 overlay.js 拆分为职责清晰的 19 个源码模块（src/overlay/，`04-` 前缀六文件：词包纯数据与速度 V3 五分片（04-speed-v3-*）按字典序插于 `04-status-rotator-data.js` 之前）。
- 防漂移门禁：`--check` 校验 src/overlay/ 拼接结果与根 overlay.js 逐字节一致，
  并由 `sync_plugin.py` 自动串联调用。

分片闭包架构与作用域边界图（Onboarding 速查）：
  ┌─ 外层 IIFE 闭包 `(function () {`（00 开 → 12 闭）────────────────────────────────┐
  │  00-boot-state-i18n.js              防重入守卫、进程级共享状态 state、双语 L() 与基础格式化
  │  01-git-and-doc-tooltips.js         Git 状态 chip/Tooltip、文档气泡与通用 DOM 辅助
  │  02-store-bridge-and-speed-v2.js    渲染桥 ZUsageTurnStats 对接与速度 20 组合筛选引擎
  │  03-deterministic-turns-and-verbs.js 回答末尾确定性统计行、富文本回填与状态动词库
  │  04-rotator-builtin-packs.js        内置状态词包纯数据表（builtinPacks）
  │  04-speed-v3-charts.js              v384 速度 V3：最近/今天/近7天图表与悬停卡（specs/speed-tooltip-v3.md）
  │  04-speed-v3-core.js                v384 速度 V3：解包/模型身份配色/筛选状态机/聚合管线
  │  04-speed-v3-heat.js                v384 速度 V3：本月日历与全部历史热力图
  │  04-speed-v3-view.js                v384 速度 V3：920×480 外壳/头部双 Tab/模型筛选/左右卡
  │  04-speed-v3-wire.js                v384 速度 V3：spd3RebuildOr 装配桥（图表分发+状态烘入）
  │  04-status-rotator-data.js          内置语录库、在线热更缓存、自动轮换引擎与通知音效
  │  05-status-rotator-runtime.js       词包编辑器弹窗、多 pane 协调器与几何可见性判定
  │  ┌─ 实例级闭包 `function spawnInstance(pid)`（06 开 → 12 闭）──────────────────┐ │
  │  │ 06-instance-dom-and-styles.js     VERSION 台账、实例级状态、内联 CSS 与条面根 DOM
  │  │ 07-instance-render-and-tips.js    状态条主渲染 render()、各格 Tooltip 与复制菜单
  │  │ 08-instance-bridge-and-subrate.js 会话归属仲裁 pickCurrent、store 订阅与子代理行内速率
  │  │ 09-instance-settings-and-notes.js ⚙ 设置面板构建、更新日志卡片与提示词增强历史/配置
  │  │ 10-instance-subpanel-and-composer.js 子代理任务抽屉浮层、工作流卡片与输入框查找定位
  │  │ 11-instance-toolbar-chips.js      输入框工具行 chip（上下文/额度/Git/速率/系统/增强）与模型拉取弹窗
  │  │ 12-instance-mount-and-boot.js     in-card/pill/compact 挂载、窄宽三档收缩、折叠与实例 dispose()
  │  └─────────────────────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────────────────────┘

用法：
  python3 scripts/build_overlay.py          # 从 src/overlay/*.js 生成根 overlay.js
  python3 scripts/build_overlay.py --check  # 仅校验根 overlay.js 是否与模块源码一致
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src" / "overlay"
TARGET = ROOT / "overlay.js"
PART_RE = re.compile(r"^[0-9]{2}-[A-Za-z0-9_-]+\.js$")
_LEDGER_BLOCK_RE = re.compile(
    r"[ \t]*/\* VERSION 台账[^\n]*\r?\n((?:[ \t]*\* [^\n]*\r?\n)+)[ \t]*\*/\r?\n([ \t]*var VERSION = \"[^\"]+\";)"
)
# 双层闭包边界锚点校验：防分片误删/错位破坏跨文件词法作用域
_CLOSURE_ANCHORS = (
    ("00-", "(function () {"),
    ("06-", "function spawnInstance("),
    ("12-", "instances.push(api);"),
    ("12-", "})();"),
)


def _fold_version_ledger(text):
    """将源码分片中可读的多行 VERSION 台账注释收敛为产物中的同行 `//v82 ...` 注释，
    既消除源码中的 45KB 超长单行，又保持发版检查脚本对单行 VERSION 台账的校验契约。"""
    def _repl(match):
        items = [re.sub(r"^[ \t]*\* ", "", line.rstrip("\r")) for line in match.group(1).splitlines()]
        return f"{match.group(2)}   //" + " ".join(items)
    return _LEDGER_BLOCK_RE.sub(_repl, text, count=1)


def list_parts(src_dir=SRC_DIR):
    src_dir = Path(src_dir)
    if not src_dir.is_dir():
        return []
    return sorted(p for p in src_dir.iterdir() if p.is_file() and PART_RE.match(p.name))


def assemble_bytes(src_dir=SRC_DIR):
    strays = sorted(p.name for p in Path(src_dir).glob("*.js") if p.is_file() and not PART_RE.match(p.name))
    if strays:
        raise ValueError(
            f"{src_dir} 下存在不匹配分片命名 [0-9][0-9]-*.js 的 .js 文件"
            f"（不会参与拼接，为防静默丢片请改名或移除）: {', '.join(strays)}"
        )
    parts = list_parts(src_dir)
    if not parts:
        raise FileNotFoundError(f"未找到任何 overlay 模块源码: {src_dir}")
    chunks = []
    texts_by_name = {}
    for part in parts:
        data = part.read_bytes()
        if not data:
            raise ValueError(f"overlay 模块源码为空: {part.name}")
        try:
            text = data.decode("utf-8")  # 校验合法 UTF-8
        except UnicodeDecodeError as exc:
            raise ValueError(f"分片非 UTF-8: {part.name}: {exc}") from None
        texts_by_name[part.name] = text
        if "/* VERSION 台账" in text:
            text = _fold_version_ledger(text)
            data = text.encode("utf-8")
        chunks.append(data)
    # 若包含完整 00..12 生产分片集，校验外层 IIFE 与 spawnInstance 闭包锚点完好
    if any(name.startswith("06-") for name in texts_by_name) and any(name.startswith("12-") for name in texts_by_name):
        for prefix, anchor in _CLOSURE_ANCHORS:
            matched = [txt for name, txt in texts_by_name.items() if name.startswith(prefix)]
            if not matched or not any(anchor in txt for txt in matched):
                raise ValueError(f"overlay 闭包边界锚点缺失（{prefix}* 应包含 {anchor!r}）")
    return b"".join(chunks), parts


def main(argv=None, root=ROOT):
    argv = sys.argv[1:] if argv is None else list(argv)
    unknown = [a for a in argv if a != "--check"]
    if unknown:
        print(f"build_overlay: 未知参数 {' '.join(unknown)}（仅支持 --check）", file=sys.stderr)
        return 2
    check_only = "--check" in argv
    root = Path(root).resolve()
    src_dir = root / "src" / "overlay"
    target = root / "overlay.js"
    try:
        expected, parts = assemble_bytes(src_dir)
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        print(f"build_overlay: {exc}", file=sys.stderr)
        return 1
    current = target.read_bytes() if target.is_file() else None
    if check_only:
        if current != expected:
            print(
                "overlay.js 与 src/overlay/ 模块源码不一致（请运行 python3 scripts/build_overlay.py 或 python3 sync_plugin.py）",
                file=sys.stderr,
            )
            return 1
        return 0
    if current != expected:
        target.write_bytes(expected)
        print(f"已从 {len(parts)} 个模块构建 overlay.js（{len(expected)} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
