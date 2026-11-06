#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""零依赖拼接脚本：将 src/overlay/[0-9][0-9]-*.js 按序拼接为根目录单文件 overlay.js。

设计目标：
- 保持分发产物形态不变：根目录 overlay.js 与 plugins/.../overlay.js 仍为单文件 IIFE，
  无需打包器或第三方依赖，也不改变 Release ZIP 的文件清单契约。
- 降低维护粒度：1.1MB 的 overlay.js 拆分为职责清晰的 10 个源码模块（src/overlay/）。
- 防漂移门禁：`--check` 校验 src/overlay/ 拼接结果与根 overlay.js 逐字节一致，
  并由 `sync_plugin.py` 自动串联调用。

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
    for part in parts:
        data = part.read_bytes()
        if not data:
            raise ValueError(f"overlay 模块源码为空: {part.name}")
        try:
            data.decode("utf-8")  # 校验合法 UTF-8
        except UnicodeDecodeError as exc:
            raise ValueError(f"分片非 UTF-8: {part.name}: {exc}") from None
        chunks.append(data)
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
