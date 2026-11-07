# -*- coding: utf-8 -*-
"""把仓库根的运行时文件同步进 plugins/zcode-token-usage-statusbar/（插件打包副本），
并集中校验 6 处分发/运行文件清单的一致性。

插件要能脱离仓库独立安装（marketplace 缓存目录里只有 plugins/<name>/ 子树），
所以插件包里必须带一份 zusage.py 等文件的副本。改了根目录文件后跑一次：

  python3 sync_plugin.py

副本与根文件不一致或 6 处分发清单存在漂移时退出码 1（CI 可用作漂移检查；加 --check 只查不改）。
"""
import ast
import filecmp
import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
PLUGIN_NAME = "zcode-token-usage-statusbar"
PLUGIN_PREFIX = f"plugins/{PLUGIN_NAME}/"
PLUGIN = ROOT / "plugins" / PLUGIN_NAME

# 1. 仓库根同步到 plugins/zcode-token-usage-statusbar/ 的正本文件（单点事实源）
FILES = [
    "usage_mcp.py",
    "mcp-launch.cjs",
    "zusage.py",
    "patch_install.py",
    "install_monitor.py",
    "inject-main.cjs",
    "plugin-updater.cjs",
    "plugin-release.cjs",
    "plugin-storage.cjs",
    "quota-client.cjs",
    "model-puller.cjs",
    "engine-patch.cjs",
    "release_unpack.py",
    "runtime_lock.py", "usage_stats.py", "turn-stats.js",
    "overlay.js", "token_rate.py", "renderer_bridge.py", "token_pricing.py",
    "pending_zip_patch.py",
]

# 仅存在于插件目录内、随 Release ZIP 一起分发的文件
PLUGIN_ONLY_FILES = (
    "overlay_install.py",
    "plugin_auto_update.py",
    "restart_notice.py",
    ".mcp.json",
    "README.md",
    ".zcode-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/session-start.py",
    "hooks/prompt-submit.py",
    "commands/usage.md",
    "commands/install-overlay.md",
    "commands/uninstall-overlay.md",
    "skills/zcode-token-usage/SKILL.md",
)

# 派生清单契约（对应 .zcode/rules/install-release.md §1 的 6 处登记点）：
# - install.py 独立链运行目录：FILES 去掉插件专用的 mcp-launch.cjs
STANDALONE_RUNTIME_FILES = tuple(f for f in FILES if f != "mcp-launch.cjs")
# - overlay_install.py 插件链运行目录：FILES 去掉从插件目录直跑的 usage_mcp.py 与 mcp-launch.cjs
PLUGIN_RUNTIME_FILES = tuple(f for f in FILES if f not in ("usage_mcp.py", "mcp-launch.cjs"))
# - 主进程冷文件（变更后需完全退出并重启客户端）
COLD_FILES = (
    "inject-main.cjs",
    "plugin-updater.cjs",
    "plugin-release.cjs",
    "plugin-storage.cjs",
    "quota-client.cjs",
    "model-puller.cjs",
    "engine-patch.cjs",
)
# - restart_notice.py 允许记录 hash 的文件集合（冷文件 + 禁用热重载时的热文件）
RESTART_HASH_FILES = (*COLD_FILES, "overlay.js", "zusage.py")
# - Release ZIP 内的插件文件与完整条目
RELEASE_PLUGIN_FILES = (*FILES, *PLUGIN_ONLY_FILES)
RELEASE_ZIP_FILES = tuple(sorted((
    "LICENSE",
    "marketplace.json",
    *(PLUGIN_PREFIX + p for p in RELEASE_PLUGIN_FILES),
)))


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check_manifests(root=ROOT):
    """校验 6 处分发清单是否与本模块定义的派生契约完全一致，返回错误描述列表。"""
    root = Path(root).resolve()
    plugin_dir = root / "plugins" / PLUGIN_NAME
    errors = []

    # (1) release_tool.py: SYNC_FILES / SOURCES / NAMES
    rt = _load_module("sync_check_release_tool", root / "release_tool.py")
    if set(rt.SYNC_FILES) != set(FILES) or len(rt.SYNC_FILES) != len(FILES):
        errors.append("release_tool.SYNC_FILES 与 sync_plugin.FILES 不一致")
    if set(rt.SOURCES) != set(RELEASE_PLUGIN_FILES) or len(rt.SOURCES) != len(RELEASE_PLUGIN_FILES):
        errors.append("release_tool.SOURCES 与 sync_plugin.RELEASE_PLUGIN_FILES 不一致")
    if tuple(rt.NAMES) != RELEASE_ZIP_FILES:
        errors.append("release_tool.NAMES 与 sync_plugin.RELEASE_ZIP_FILES 不一致")

    # (2) release_unpack.py: PLUGIN_FILES / ALLOWED_FILES
    ru = _load_module("sync_check_release_unpack", root / "release_unpack.py")
    if set(ru.PLUGIN_FILES) != set(RELEASE_PLUGIN_FILES) or len(ru.PLUGIN_FILES) != len(RELEASE_PLUGIN_FILES):
        errors.append("release_unpack.PLUGIN_FILES 与 sync_plugin.RELEASE_PLUGIN_FILES 不一致")
    if set(ru.ALLOWED_FILES) != set(RELEASE_ZIP_FILES):
        errors.append("release_unpack.ALLOWED_FILES 与 sync_plugin.RELEASE_ZIP_FILES 不一致")

    # (3) install.py: RUNTIME_FILES
    inst = _load_module("sync_check_install", root / "install.py")
    if set(inst.RUNTIME_FILES) != set(STANDALONE_RUNTIME_FILES) or len(inst.RUNTIME_FILES) != len(STANDALONE_RUNTIME_FILES):
        errors.append("install.RUNTIME_FILES 与 sync_plugin.STANDALONE_RUNTIME_FILES 不一致")

    # (4) overlay_install.py: RUNTIME_FILES & cold_files
    ov = _load_module("sync_check_overlay_install", plugin_dir / "overlay_install.py")
    if set(ov.RUNTIME_FILES) != set(PLUGIN_RUNTIME_FILES) or len(ov.RUNTIME_FILES) != len(PLUGIN_RUNTIME_FILES):
        errors.append("overlay_install.RUNTIME_FILES 与 sync_plugin.PLUGIN_RUNTIME_FILES 不一致")
    ov_src = (plugin_dir / "overlay_install.py").read_text(encoding="utf-8")
    cold_matches = re.findall(r"cold_files = (\{[^}]+\})", ov_src)
    if len(cold_matches) != 1:
        errors.append(f"overlay_install.py 中 cold_files 字面量数量异常（期望 1 处，实际 {len(cold_matches)} 处）")
    else:
        parsed_cold = ast.literal_eval(cold_matches[0])
        if set(parsed_cold) != set(COLD_FILES):
            errors.append("overlay_install.py cold_files 与 sync_plugin.COLD_FILES 不一致")

    # (5) restart_notice.py: RESTART_HASH_FILES
    rn = _load_module("sync_check_restart_notice", plugin_dir / "restart_notice.py")
    rn_files = getattr(rn, "RESTART_HASH_FILES", ())
    if set(rn_files) != set(RESTART_HASH_FILES) or len(rn_files) != len(RESTART_HASH_FILES):
        errors.append("restart_notice.RESTART_HASH_FILES 与 sync_plugin.RESTART_HASH_FILES 不一致")

    # (6) .zcode-plugin/plugin.json & .claude-plugin/plugin.json: packageLayout.files
    for rel in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"):
        mpath = plugin_dir / rel
        manifest = json.loads(mpath.read_text(encoding="utf-8"))
        layout_files = (manifest.get("packageLayout") or {}).get("files")
        if not isinstance(layout_files, list) or tuple(sorted(layout_files)) != RELEASE_ZIP_FILES or len(layout_files) != len(RELEASE_ZIP_FILES):
            errors.append(f"{rel} packageLayout.files 与 sync_plugin.RELEASE_ZIP_FILES 不一致")

    return errors


def _maybe_build_bundles(root=ROOT, check_only=False):
    """若存在模块化构建脚本（scripts/build_overlay.py、scripts/build_quota.py），先构建或校验根产物。"""
    for script_name, mod_name in (
        ("build_overlay.py", "sync_build_overlay"),
        ("build_quota.py", "sync_build_quota"),
    ):
        builder = Path(root) / "scripts" / script_name
        if not builder.is_file():
            continue
        mod = _load_module(mod_name, builder)
        rc = mod.main(["--check"] if check_only else [], root=root)
        if rc != 0:
            return False
    return True


def main(check_only=False):
    if not _maybe_build_bundles(ROOT, check_only=check_only):
        return 1
    missing = [f for f in FILES if not (ROOT / f).is_file()]
    if missing:
        print("根文件缺失:", ", ".join(missing))
        return 1
    manifest_errors = check_manifests(ROOT)
    if manifest_errors:
        for err in manifest_errors:
            print("清单漂移:", err)
        return 1
    PLUGIN.mkdir(parents=True, exist_ok=True)
    drift = []
    copies = [(name, name) for name in FILES]
    for name, destination in copies:
        src, dst = ROOT / name, PLUGIN / destination
        if dst.is_file() and filecmp.cmp(src, dst, shallow=False):
            continue
        drift.append(name)
        if not check_only:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            print(f"已同步 {name}")
    if check_only:
        if drift:
            print("插件副本过期:", ", ".join(drift), "（运行 python3 sync_plugin.py 更新）")
            return 1
        print("插件副本与根文件一致。")
    elif not drift:
        print("无需更新，副本已一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main(check_only="--check" in sys.argv[1:]))
