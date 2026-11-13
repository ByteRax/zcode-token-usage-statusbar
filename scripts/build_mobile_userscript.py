#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""零依赖构建脚本：src/mobile/ 分片 + 桌面分片锚点提取 → 正式版/调试版两份油猴产物。

设计目标（specs/mobile-userscript-build.md）：
- 油猴脚本从手写整份改为编译产物：手机特有逻辑（中继旁听/分片重组/overlay 加载器/
  回退 UI 骨架）维护在 src/mobile/ 分片；
- 「照抄桌面」的内容（格图标 SVG、格样式、TPS 色档、设置面板显示项行）在构建期从
  src/overlay/ 06/07 分片的锚点注释提取注入，桌面更新后重新构建即同步；
- 同一提取结果产出两个变体：正式版（DEBUG_BUILD=false，零调试痕迹）与调试版
  （docs/zusage-mobile.debug.user.js，默认显示排障面板，@name 区分）；
- 防漂移门禁：锚点缺失、声明失配、占位符残留一律构建报错（fail-fast），
  `--check` 校验两份产物与源码/锚点逐字节一致。

用法：
  python3 scripts/build_mobile_userscript.py          # 生成两份产物
  python3 scripts/build_mobile_userscript.py --check  # 仅校验产物是否与源码一致
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src" / "mobile"
TARGET = ROOT / "docs" / "zusage-mobile.user.js"
TARGET_DEBUG = ROOT / "docs" / "zusage-mobile.debug.user.js"
OVL06 = ROOT / "src" / "overlay" / "06-instance-dom-and-styles.js"
OVL07 = ROOT / "src" / "overlay" / "07-instance-render-and-tips.js"
OVL13 = ROOT / "src" / "overlay" / "13-mobile-chips.js"
PART_RE = re.compile(r"^[0-9]{2}-[A-Za-z0-9_-]+\.js$")

# 调试变体（0.5.1）：同一构建产出两份产物——正式版 DEBUG_BUILD=false 不创建调试面板
# 与 ☰ 钮（页面零调试痕迹），调试版 true 默认显示。@name 区分，避免篡改猴按
# name+namespace 识别为同一脚本互相覆盖安装。
DEBUG_NAME_REPL = (
    "// @name         ZCode 用量状态条（远控中继接收端）",
    "// @name         ZCode 用量状态条（远控中继接收端·调试版）",
)
DEBUG_DESC_REPL = (
    "// @description  在 ZCode Web 远程控制页面渲染与桌面状态条同源的 token 用量 chips（observe-only，不向 WebSocket 写入任何字节）",
    "// @description  调试版：默认显示排障面板（帧统计/overlay 加载状态）；日常使用请安装正式版 zusage-mobile.user.js",
)

# 桌面分片锚点（specs/mobile-userscript-build.md §3；改锚点名须同步 06 分片注释与本文）
ICO_RE = re.compile(r"ico\(/\*zm-ico:([a-z]+)\*/'((?:[^'\\]|\\.)*)'\)")
RULE_RE = re.compile(r"^([^{}@]+)\{([^{}]*)$")   # split("}") 后片段无尾 }
ROW_RE = re.compile(
    r"settingRow\('<input type=\"checkbox\" data-k=\"([A-Za-z]+)\">',\s*"
    r"L\(\"([^\"]+)\", \"[^\"]*\"\),\s*"
    r"L\(\"([^\"]+)\", \"[^\"]*\"\)\)"
)
MC_BANDS_RE = re.compile(r"var MC_BANDS = \[([^\]]+)\];")
DECL_ICONS_RE = re.compile(r"/\*@zm-icons ([a-z,]+)@\*/")
DECL_KEYS_RE = re.compile(r"/\*@zm-show-keys ([a-z,]+)@\*/")

# 格样式允许选择器（规范化形态）。桌面在 cell 锚点区新增规则默认不收；
# 需要跟随时把选择器加进来并重跑构建——这是有意的「人工确认」边界。
CELL_SELECTORS = {
    ".it", ".it:hover", ".it:focus-visible",
    ".sep", ".k", ".v", ".dim", ".eb",
    ".zusage-root .it",
    ".zusage-root .it>span:not(.eb):not(.zu-live)",
}


class BuildError(Exception):
    pass


def read_text(path):
    try:
        return path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise BuildError(f"{path.name}: {exc}") from None


def assemble_mobile(src_dir=SRC_DIR):
    strays = sorted(p.name for p in Path(src_dir).glob("*.js") if p.is_file() and not PART_RE.match(p.name))
    if strays:
        raise BuildError(
            f"{src_dir} 下存在不匹配分片命名 [0-9][0-9]-*.js 的 .js 文件"
            f"（不会参与拼接，为防静默丢片请改名或移除）: {', '.join(strays)}"
        )
    parts = sorted(p for p in Path(src_dir).iterdir() if p.is_file() and PART_RE.match(p.name))
    if not parts:
        raise BuildError(f"未找到任何 mobile 模块源码: {src_dir}")
    return "".join(read_text(p) for p in parts)


def anchor_span(text, begin, end, source):
    """按注释前缀定位锚点区间（begin/end 形如 "/*zm-cell-css-begin"，容许锚点与
    说明文字并作同一注释块，故只匹配前缀不要求紧跟 */）。"""
    i = text.find(begin)
    if i < 0:
        raise BuildError(f"{source}: 缺少锚点 {begin}（桌面重构删了锚点？先确认手机端跟随再恢复）")
    j = text.find(end, i + len(begin))
    if j < 0:
        raise BuildError(f"{source}: 缺少锚点 {end}")
    return text[i + len(begin):j]


def js_dquote_strings(text):
    """简易 JS 词法扫描：跳过 // 与 /* */ 注释、单引号与模板字符串，收集双引号字符串
    字面量并还原 \\" 转义后连接。不能用正则直接扫——06 分片 CSS 区注释里也有引号
    （如 v319 注释的 "158.9 t/s"），会把注释内容混进 CSS。区间内无正则字面量。"""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j, buf = i + 1, []
            while j < n:
                ch = text[j]
                if ch == "\\" and j + 1 < n:
                    nxt = text[j + 1]
                    if nxt == '"':
                        buf.append('"')
                    elif nxt == "\\":
                        buf.append("\\")
                    else:
                        buf.append("\\" + nxt)
                    j += 2
                    continue
                if ch == '"' or ch == "\n":
                    break
                buf.append(ch)
                j += 1
            out.append("".join(buf))
            i = j + 1
        elif c in ("'", "`"):
            j = i + 1
            while j < n:
                ch = text[j]
                if ch == "\\" and j + 1 < n:
                    j += 2
                    continue
                if ch == c or (ch == "\n" and c != "`"):
                    break
                j += 1
            i = j + 1
        elif c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j + 1
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            i += 1
    return "".join(out)


def split_rules(css):
    """按顶层 } 切候选片段，只保留「选择器{声明}」完整形态（@supports/@keyframes
    的嵌套残片因含多余 { 或以 @ 开头自然被拒）。返回 [(选择器, 声明体)]。"""
    rules = []
    for piece in css.split("}"):
        piece = piece.strip()
        if not piece:
            continue
        m = RULE_RE.match(piece)
        if m:
            rules.append((m.group(1).strip(), m.group(2).strip()))
    return rules


def norm_sel(sel):
    return re.sub(r"\s+", "", sel)


def extract_cell_rules(ovl06):
    """格样式：白名单选择器过滤 + .zusage-root/.zm-root 前缀改写（逗号分组逐项处理）。"""
    segment = anchor_span(ovl06, "/*zm-cell-css-begin", "/*zm-cell-css-end", "06 分片")
    out = []
    for sel, body in split_rules(js_dquote_strings(segment)):
        items = [s.strip() for s in sel.split(",")]
        if not items or any(s not in CELL_SELECTORS for s in items):
            continue
        # 前缀改写保留选择器原文（含内部空格）：.zusage-root 前缀换 .zm-root，裸类加 .zm-root
        rewritten = [
            (".zm-root" + s[len(".zusage-root"):]) if s.startswith(".zusage-root") else (".zm-root " + s)
            for s in items
        ]
        out.append(",".join(rewritten) + "{" + body + "}")
    if not out:
        raise BuildError("cell 锚点区未提取到任何白名单规则（桌面重排了格样式？核对 CELL_SELECTORS）")
    return out


def load_mc_bands(ovl13):
    """13 分片 MC_BANDS 是手机色档值域的唯一事实源，构建脚本内置表必须与之同步。"""
    m = MC_BANDS_RE.search(ovl13)
    if not m:
        raise BuildError("13 分片找不到 var MC_BANDS = [...]（色档值域事实源被移走？同步构建脚本）")
    bands = [s.strip().strip('"\'') for s in m.group(1).split(",")]
    return [b for b in bands if b]


def extract_band_rules(ovl06, mc_bands):
    """TPS 色档：深色 + .zu-light 浅色两个锚点区，只收「单类选择器 + 单一 color 声明」，
    每条展开为 zm-band-<n> 与 zm-tone-<n> 两份（与 13 分片 mcBandOf/mcToneOf 值域对齐）。"""
    segments = [
        anchor_span(ovl06, "/*zm-band-css-begin", "/*zm-band-css-end", "06 分片"),
        anchor_span(ovl06, "/*zm-band-css-light-begin", "/*zm-band-css-light-end", "06 分片"),
    ]
    out = []
    seen = set()
    for segment in segments:
        for sel, body in split_rules(js_dquote_strings(segment)):
            if not re.fullmatch(r"color:[^;:{}]+", body):
                continue   # ::before/@supports 渐变等复杂规则不进回退条（保持基础色）
            # 不做空白规范化（.zu-light 与色档类之间的空格是后代选择器语义）
            m = re.fullmatch(r"(\.zu-light\s+)?\.([a-z-]+)", sel.strip())
            if not m or m.group(2) not in mc_bands:
                continue
            name, light = m.group(2), bool(m.group(1))
            key = (name, light)
            if key in seen:
                continue
            seen.add(key)
            prefix = ".zm-light " if light else ".zm-root "
            out.append(f"{prefix}.zm-band-{name}{{{body}}}")
            out.append(f"{prefix}.zm-tone-{name}{{{body}}}")
    if not out:
        raise BuildError("band 锚点区未提取到任何色档规则（桌面重排了色档？核对提取条件）")
    return out


def extract_show_rows(ovl06, keys):
    """显示项行：settingRow 的 data-k 与中文标题/描述 → 声明键集过滤 → label 行。"""
    segment = anchor_span(ovl06, "/*zm-show-rows-begin", "/*zm-show-rows-end", "06 分片")
    found = {}
    for m in ROW_RE.finditer(segment):
        found[m.group(1)] = (m.group(2), m.group(3))
    missing = [k for k in keys if k not in found]
    if missing:
        raise BuildError(
            f"油猴声明键 {','.join(missing)} 在桌面 zm-show-rows 锚点区不存在"
            f"（桌面删除了显示项？先同步油猴 @zm-show-keys 声明）"
        )
    rows = []
    for k in keys:
        title, desc = found[k]
        rows.append(f"'<label><input type=\"checkbox\" data-k=\"{k}\"><span>{title}<em>{desc}</em></span></label>'")
    return rows, sorted(set(found) - set(keys))


def extract_icons(ovl07):
    icons = {}
    for m in ICO_RE.finditer(ovl07):
        icons[m.group(1)] = m.group(2)
    if not icons:
        raise BuildError("07 分片找不到任何 /*zm-ico:*/ 锚点（图标调用点被重构？恢复锚点）")
    return icons


def build_icons_js(icons, wanted):
    missing = [k for k in wanted if k not in icons]
    if missing:
        raise BuildError(f"油猴 @zm-icons 声明的 {','.join(missing)} 在桌面 07 分片无锚点（桌面删格？同步声明）")
    items = ", ".join(f"{k}: '{icons[k]}'" for k in wanted)
    return "{" + items + "}"


def js_css_literal(rules):
    text = "".join(rules)
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def assemble(src_dir=SRC_DIR, ovl06_path=OVL06, ovl07_path=OVL07, ovl13_path=OVL13):
    """路径可注入：真实源码用默认值；测试用临时夹具验证提取改写与 fail-fast 行为。"""
    src = assemble_mobile(src_dir)
    ovl06 = read_text(ovl06_path)
    ovl07 = read_text(ovl07_path)
    ovl13 = read_text(ovl13_path)

    decl_icons = DECL_ICONS_RE.search(src)
    decl_keys = DECL_KEYS_RE.search(src)
    if not decl_icons:
        raise BuildError("油猴分片缺少 /*@zm-icons ...*/ 声明（图标 id 集合是 fail-fast 契约）")
    if not decl_keys:
        raise BuildError("油猴分片缺少 /*@zm-show-keys ...*/ 声明")
    wanted_icons = [k for k in decl_icons.group(1).split(",") if k]
    wanted_keys = [k for k in decl_keys.group(1).split(",") if k]

    mc_bands = load_mc_bands(ovl13)
    icons = extract_icons(ovl07)
    cell = extract_cell_rules(ovl06)
    band = extract_band_rules(ovl06, mc_bands)
    rows, extra_keys = extract_show_rows(ovl06, wanted_keys)

    # 校验只针对可执行替换点形态（分片注释里的占位符名是文档，不算残留）
    src = replace_once(src, '"__ZM_CELL_CSS__"', js_css_literal(cell), "__ZM_CELL_CSS__")
    src = replace_once(src, '"__ZM_BAND_CSS__"', js_css_literal(band), "__ZM_BAND_CSS__")
    src = replace_once(
        src, "var ICONS = __ZM_ICONS__;", "var ICONS = " + build_icons_js(icons, wanted_icons) + ";", "__ZM_ICONS__")
    src = replace_once(
        src, "var SHOW_ROWS = __ZM_SHOW_ROWS__;", "var SHOW_ROWS = " + " +\n    ".join(rows) + ";", "__ZM_SHOW_ROWS__")
    # __ZM_DEBUG__ 留给 finalize()：同一提取结果产出正式/调试两个变体
    return src, {"desktop_only_keys": extra_keys, "bands": mc_bands}


def finalize(common_src, debug):
    """debug=False 正式版（DEBUG_BUILD=false，零调试痕迹）；True 调试版（默认显示排障
    面板，@name/@description 区分，避免篡改猴按 name+namespace 与正式版互相覆盖）。"""
    src = replace_once(
        common_src, "var DEBUG_BUILD = __ZM_DEBUG__;", f"var DEBUG_BUILD = {'true' if debug else 'false'};",
        "__ZM_DEBUG__")
    if debug:
        src = replace_once(src, *DEBUG_NAME_REPL, "调试版 @name")
        src = replace_once(src, *DEBUG_DESC_REPL, "调试版 @description")
    return src


def replace_once(src, old, new, label):
    """占位符替换点必须恰有 1 处——0 处说明分片被改坏（占位符丢失），多处在防呆。"""
    count = src.count(old)
    if count != 1:
        raise BuildError(f"{label} 替换点应恰有 1 处，实际 {count}（分片形态被改？）")
    return src.replace(old, new, 1)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    unknown = [a for a in argv if a != "--check"]
    if unknown:
        print(f"build_mobile_userscript: 未知参数 {' '.join(unknown)}（仅支持 --check）", file=sys.stderr)
        return 2
    check_only = "--check" in argv
    try:
        common, info = assemble()
        variants = [(TARGET, finalize(common, False)), (TARGET_DEBUG, finalize(common, True))]
    except BuildError as exc:
        print(f"build_mobile_userscript: {exc}", file=sys.stderr)
        return 1
    failed = False
    for target, expected in variants:
        expected_bytes = expected.encode("utf-8")
        current = target.read_bytes() if target.is_file() else None
        if check_only:
            if current != expected_bytes:
                print(f"{target.name} 与 src/mobile/ + 桌面锚点不一致（请运行 python3 scripts/build_mobile_userscript.py）",
                      file=sys.stderr)
                failed = True
            continue
        if current != expected_bytes:
            target.write_bytes(expected_bytes)
            print(f"已构建 {target.name}（{len(expected_bytes)} 字节）")
        else:
            print(f"{target.name} 已是最新")
    if failed:
        return 1
    if not check_only and info["desktop_only_keys"]:
        print(f"提示：桌面锚点区有手机未采集的显示项键（13 分片 mcIds 未映射，属预期）: {','.join(info['desktop_only_keys'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
