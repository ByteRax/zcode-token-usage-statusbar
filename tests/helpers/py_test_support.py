# -*- coding: utf-8 -*-
"""Python 测试公共夹具与加载辅助（零第三方依赖，兼容 Python 3.8+）。"""
import importlib.util
import json
from pathlib import Path
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_ROOT = ROOT / "plugins" / "zcode-token-usage-statusbar"

_RUNTIME_BYTES_CACHE = {}
_HEAD_BYTES_CACHE = {}


def load_module(name, path):
    """按文件路径加载独立模块实例。"""
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_asar(path, entry=b"console.log('official v1');", package=None, files=None, unpacked=False):
    """生成微型合法 asar 归档。

    - 若传 `files`（`{asar内路径: bytes}`），按给定字典构建；
    - 否则默认写入 `out/main/index.js`（内容为 `entry`），当传入 `package` 时一并写入 `package.json`。
    """
    path = Path(path)
    if files is None:
        file_map = {"out/main/index.js": entry}
        if package is not None:
            pkg_bytes = package if isinstance(package, bytes) else json.dumps(package).encode("utf-8")
            file_map["package.json"] = pkg_bytes
    else:
        file_map = dict(files)
    header, payload = {"files": {}}, bytearray()
    for name, data in file_map.items():
        parent = header
        parts = [p for p in name.split("/") if p]
        for part in parts[:-1]:
            parent = parent["files"].setdefault(part, {"files": {}})
        node = {"offset": str(len(payload)), "size": len(data)}
        if name == "package.json" and unpacked:
            node["unpacked"] = True
        parent["files"][parts[-1]] = node
        payload.extend(data)
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    aligned = (len(raw) + 7) // 4 * 4
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(raw)) + raw +
                     b"\0" * (aligned - len(raw) - 4) + payload)
    return path


def cached_plugin_runtime_bytes(plugin_root=PLUGIN_ROOT, runtime_files=()):
    """进程内缓存插件目录运行时文件字节，避免每个测试用例重复读盘 1.5MB+。"""
    plugin_root = Path(plugin_root).resolve()
    out = {}
    for name in runtime_files:
        key = (str(plugin_root), name)
        if key not in _RUNTIME_BYTES_CACHE:
            _RUNTIME_BYTES_CACHE[key] = (plugin_root / name).read_bytes()
        out[name] = _RUNTIME_BYTES_CACHE[key]
    return out


def cached_head_bytes(repo_root=ROOT, names=()):
    """进程内缓存 `git show HEAD:<name>`，避免测试集重复拉起数十次 git 子进程。"""
    repo_root = Path(repo_root).resolve()
    out = {}
    for name in names:
        key = (str(repo_root), name)
        if key not in _HEAD_BYTES_CACHE:
            _HEAD_BYTES_CACHE[key] = subprocess.check_output(["git", "-C", str(repo_root), "show", "HEAD:" + name])
        out[name] = _HEAD_BYTES_CACHE[key]
    return out
