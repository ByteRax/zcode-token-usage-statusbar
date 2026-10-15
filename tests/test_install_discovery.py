# -*- coding: utf-8 -*-
"""install.py 自动探测测试：枚举候选的身份校验与畸形 asar 容错（Windows 盘符扫描回归）。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import importlib.util
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("install_discovery_test", ROOT / "install.py")
installer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(installer)


def make_asar(path, files):
    """微型 asar：files = {asar内路径: bytes}；header 布局与 patch_install.read_header 对齐。"""
    header, payload = {"files": {}}, bytearray()
    for name, data in files.items():
        parent = header
        parts = name.split("/")
        for part in parts[:-1]:
            parent = parent["files"].setdefault(part, {"files": {}})
        parent["files"][parts[-1]] = {"offset": str(len(payload)), "size": len(data)}
        payload.extend(data)
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    aligned = (len(raw) + 7) // 4 * 4
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(raw)) + raw +
                     b"\0" * (aligned - len(raw) - 4) + payload)


def make_raw_asar(path, raw_header, entry=b"{}"):
    """完全自定义 header 字节（构造畸形包：合法 JSON 但非对象等）。"""
    raw = raw_header if isinstance(raw_header, bytes) else json.dumps(raw_header).encode("utf-8")
    aligned = (len(raw) + 7) // 4 * 4
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(raw)) + raw +
                     b"\0" * (aligned - len(raw) - 4) + entry)


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        # ZCODE_ASAR 置空（falsy）确保走枚举候选，且不影响其它环境变量。
        env = mock.patch.dict(os.environ, {"ZCODE_ASAR": ""})
        env.start()
        self.addCleanup(env.stop)

    def zcode_asar(self, name="zcode-desktop"):
        path = self.root / "ZCode" / "resources" / "app.asar"
        make_asar(path, {"package.json": json.dumps({"name": name}).encode(),
                         "out/main/index.js": b"official;"})
        return path

    def test_enum_candidates_require_zcode_identity(self):
        foreign = self.root / "foreign" / "resources" / "app.asar"
        make_asar(foreign, {"package.json": json.dumps({"name": "another-electron-app"}).encode()})
        good = self.zcode_asar()
        with mock.patch.object(installer, "ASAR_CANDIDATES", [foreign, good]):
            self.assertEqual(installer.find_asar(), good)
        with mock.patch.object(installer, "ASAR_CANDIDATES", [foreign]):
            self.assertIsNone(installer.find_asar())

    def test_malformed_asar_candidates_are_skipped_not_crash(self):
        # 畸形包（合法 JSON 但非对象）曾把 AttributeError 炸穿 find_asar：
        # 盘符扫描把全部枚举候选都过 is_zcode_app 后，必须按"读不到"跳过。
        header_is_list = self.root / "m1" / "resources" / "app.asar"
        make_raw_asar(header_is_list, ["not", "a", "dict"])
        files_is_list = self.root / "m2" / "resources" / "app.asar"
        make_raw_asar(files_is_list, {"files": ["not", "a", "dict"]})
        package_is_list = self.root / "m3" / "resources" / "app.asar"
        make_raw_asar(package_is_list, {"files": {"package.json": {"offset": "0", "size": 3}}},
                      entry=b"[1]")
        good = self.zcode_asar()
        with mock.patch.object(installer, "ASAR_CANDIDATES",
                               [header_is_list, files_is_list, package_is_list, good]):
            self.assertEqual(installer.find_asar(), good)
        with mock.patch.object(installer, "ASAR_CANDIDATES",
                               [header_is_list, files_is_list, package_is_list]):
            self.assertIsNone(installer.find_asar())

    def test_windows_candidates_cover_custom_drive_layouts(self):
        if sys.platform != "win32":
            self.skipTest("Windows 盘符候选")
        candidates = installer.ASAR_CANDIDATES
        self.assertIn(r"D:\Program Files\ZCode\resources\app.asar", candidates)
        self.assertIn(r"E:\ZCode\resources\app.asar", candidates)
        # 去重：预置候选与盘符枚举不重复出现。
        self.assertEqual(len(candidates), len(set(candidates)))


if __name__ == "__main__":
    unittest.main()
