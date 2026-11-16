#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拼接手机传输分片并内嵌桌面同一份 overlay，生成正式/调试用户脚本。

不读取可能滞后的根 overlay.js；通过 build_overlay.assemble_bytes 取得含 VERSION
台账折叠的桌面完整输出。运行时不下载代码，也不提取/复制 CSS、图标或设置子集。
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src" / "mobile"
OVERLAY_SRC_DIR = ROOT / "src" / "overlay"
TARGET = ROOT / "zusage-mobile.user.js"
TARGET_DEBUG = ROOT / "zusage-mobile.debug.user.js"
PART_RE = re.compile(r"^[0-9]{2}-[A-Za-z0-9_-]+\.js$")
PLACEHOLDER_RE = re.compile(r"\b__ZM_[A-Z0-9_]+__\b")
DEBUG_NAME_REPL = (
    "// @name         ZCode 用量状态条（远控中继接收端）",
    "// @name         ZCode 用量状态条（远控中继接收端·调试版）",
)
DEBUG_DESC_REPL = (
    "// @description  在 ZCode Web 远程控制页面渲染 token 用量；仅在确认宿主支持后同步显示偏好",
    "// @description  调试版：默认显示排障面板（帧统计/overlay 加载状态）；日常使用请安装正式版 zusage-mobile.user.js",
)
DEBUG_URL_REPL = (
    "https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.user.js",
    "https://raw.githubusercontent.com/ByteRax/zcode-token-usage-statusbar/main/zusage-mobile.debug.user.js",
)


class BuildError(Exception):
    pass


def assemble_mobile(src_dir=SRC_DIR):
    src_dir = Path(src_dir)
    try:
        files = sorted(p for p in src_dir.iterdir() if p.is_file() and p.suffix == ".js")
        strays = [p.name for p in files if not PART_RE.fullmatch(p.name)]
        if strays:
            raise BuildError("mobile 分片命名须匹配 [0-9][0-9]-*.js: " + ", ".join(strays))
        if not files:
            raise BuildError("未找到任何 mobile 模块源码: " + str(src_dir))
        chunks = []
        for part in files:
            data = part.read_bytes()
            if not data:
                raise BuildError("mobile 模块源码为空: " + part.name)
            chunks.append(data.decode("utf-8"))
        return "".join(chunks)
    except (OSError, UnicodeDecodeError) as exc:
        raise BuildError(str(exc)) from None


def desktop_bytes(src_dir=OVERLAY_SRC_DIR):
    """加载构建器本身，复用其唯一的组装与 VERSION 台账折叠实现。"""
    spec = importlib.util.spec_from_file_location("_mobile_build_overlay", ROOT / "scripts" / "build_overlay.py")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        data, _ = module.assemble_bytes(src_dir)
        return data
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise BuildError("desktop overlay: " + str(exc)) from None


def replace_once(src, old, new, label):
    count = src.count(old)
    if count != 1:
        raise BuildError(f"{label} 替换点应恰有 1 处，实际 {count}")
    return src.replace(old, new, 1)


def assemble(src_dir=SRC_DIR, overlay_src_dir=OVERLAY_SRC_DIR):
    """返回共同主体和构建信息；路径可注入，供隔离测试使用。"""
    src = assemble_mobile(src_dir)
    # 只检查手机源码；桌面完整代码作为不透明字符串嵌入，不扫描其注释或字符串。
    executable = re.sub(r"/\*[\s\S]*?\*/|(?m:^[ \t]*//[^\n]*)", "", src)
    for declaration in ("var OVERLAY_CODE = __ZM_OVERLAY_SOURCE__;", "var DEBUG_BUILD = __ZM_DEBUG__;"):
        executable = executable.replace(declaration, "")
    residue = PLACEHOLDER_RE.findall(executable)
    if residue:
        raise BuildError("构建占位符残留: " + ", ".join(sorted(set(residue))))
    overlay = desktop_bytes(overlay_src_dir)
    # JSON 字符串解码后恢复精确字节；转义 HTML 结束标签以兼容页面脚本注入。
    literal = json.dumps(overlay.decode("utf-8"), ensure_ascii=True).replace("</", "<\\/")
    src = replace_once(src, "var OVERLAY_CODE = __ZM_OVERLAY_SOURCE__;",
                       "var OVERLAY_CODE = " + literal + ";", "__ZM_OVERLAY_SOURCE__")
    return src, {"overlay_bytes": len(overlay)}


def finalize(common_src, debug):
    src = replace_once(common_src, "var DEBUG_BUILD = __ZM_DEBUG__;",
                       "var DEBUG_BUILD = " + ("true" if debug else "false") + ";", "__ZM_DEBUG__")
    for prefix in ("// @downloadURL  ", "// @updateURL    "):
        src = replace_once(src, prefix + DEBUG_URL_REPL[0],
                           prefix + DEBUG_URL_REPL[1 if debug else 0], prefix.strip())
    if debug:
        src = replace_once(src, *DEBUG_NAME_REPL, "调试版 @name")
        src = replace_once(src, *DEBUG_DESC_REPL, "调试版 @description")
    return src


def main(argv=None, root=ROOT):
    argv = sys.argv[1:] if argv is None else list(argv)
    unknown = [arg for arg in argv if arg != "--check"]
    if unknown:
        print("build_mobile_userscript: 未知参数 " + " ".join(unknown) + "（仅支持 --check）", file=sys.stderr)
        return 2
    root = Path(root)
    try:
        common, _ = assemble(root / "src" / "mobile", root / "src" / "overlay")
        variants = [
            (root / TARGET.name, finalize(common, False).encode("utf-8")),
            (root / TARGET_DEBUG.name, finalize(common, True).encode("utf-8")),
        ]
    except BuildError as exc:
        print("build_mobile_userscript: " + str(exc), file=sys.stderr)
        return 1
    failed = False
    try:
        for target, expected in variants:
            current = target.read_bytes() if target.is_file() else None
            if "--check" in argv:
                if current != expected:
                    print(target.name + " 与手机分片及内嵌桌面 overlay 不一致（请运行构建脚本）", file=sys.stderr)
                    failed = True
            elif current != expected:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(expected)
                print(f"已构建 {target.name}（{len(expected)} 字节）")
            else:
                print(target.name + " 已是最新")
    except OSError as exc:
        print("build_mobile_userscript: " + str(exc), file=sys.stderr)
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
