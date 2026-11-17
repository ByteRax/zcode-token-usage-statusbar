#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""零依赖拼接脚本：将 src/puller/[0-9][0-9]-*.cjs 按序拼接为根目录单文件 model-puller.cjs。

设计目标：
- 保持分发产物形态不变：根目录 model-puller.cjs 与 plugins/.../model-puller.cjs 仍为单文件 CommonJS 模块，
  无需打包器或第三方依赖，也不改变主进程热替换（inject-main.cjs）或 Release ZIP 清单契约。
- 降低维护粒度：将模型目录解析、探测/增强纯辅助函数、拉取/写回/探测自愈、提示词增强拆分为职责清晰的 4 个源码模块（src/puller/）。
- 防漂移门禁：`--check` 校验 src/puller/ 拼接结果与根 model-puller.cjs 逐字节一致，
  并由 `sync_plugin.py` 自动串联调用。

用法：
  python3 scripts/build_puller.py          # 从 src/puller/*.cjs 生成根 model-puller.cjs
  python3 scripts/build_puller.py --check  # 仅校验根 model-puller.cjs 是否与模块源码一致
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src" / "puller"
TARGET = ROOT / "model-puller.cjs"
PART_RE = re.compile(r"^[0-9]{2}-[A-Za-z0-9_-]+\.cjs$")


def list_parts(src_dir=SRC_DIR):
    src_dir = Path(src_dir)
    if not src_dir.is_dir():
        return []
    return sorted(p for p in src_dir.iterdir() if p.is_file() and PART_RE.match(p.name))


def assemble_bytes(src_dir=SRC_DIR):
    strays = sorted(p.name for p in Path(src_dir).glob("*.cjs") if p.is_file() and not PART_RE.match(p.name))
    if strays:
        raise ValueError(
            f"{src_dir} 下存在不匹配分片命名 [0-9][0-9]-*.cjs 的 .cjs 文件"
            f"（不会参与拼接，为防静默丢片请改名或移除）: {', '.join(strays)}"
        )
    parts = list_parts(src_dir)
    if not parts:
        raise FileNotFoundError(f"未找到任何 puller 模块源码: {src_dir}")
    chunks = []
    for part in parts:
        data = part.read_bytes()
        if not data:
            raise ValueError(f"puller 模块源码为空: {part.name}")
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(f"分片非 UTF-8: {part.name}: {exc}") from None
        chunks.append(data)
    return b"".join(chunks), parts


def main(argv=None, root=ROOT):
    argv = sys.argv[1:] if argv is None else list(argv)
    unknown = [a for a in argv if a != "--check"]
    if unknown:
        print(f"build_puller: 未知参数 {' '.join(unknown)}（仅支持 --check）", file=sys.stderr)
        return 2
    check_only = "--check" in argv
    root = Path(root).resolve()
    src_dir = root / "src" / "puller"
    target = root / "model-puller.cjs"
    try:
        expected, parts = assemble_bytes(src_dir)
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        print(f"build_puller: {exc}", file=sys.stderr)
        return 1
    current = target.read_bytes() if target.is_file() else None
    if check_only:
        if current != expected:
            print(
                "model-puller.cjs 与 src/puller/ 模块源码不一致（请运行 python3 scripts/build_puller.py 或 python3 sync_plugin.py）",
                file=sys.stderr,
            )
            return 1
        return 0
    if current != expected:
        target.write_bytes(expected)
        print(f"已从 {len(parts)} 个模块构建 model-puller.cjs（{len(expected)} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
