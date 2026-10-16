# -*- coding: utf-8 -*-
"""install.py 自动探测测试：枚举候选的身份校验与畸形 asar 容错（Windows 盘符扫描回归）。

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import ctypes
import importlib.util
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("install_discovery_test", ROOT / "install.py")
installer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(installer)
REAL_DRIVE_CANDIDATES = installer.drive_candidates   # setUp 会替换，盘符用例要用真实实现


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
        # LOCALAPPDATA/ProgramFiles 指到夹具目录：find_asar 的 %LOCALAPPDATA%\Programs
        # 兜底扫描与候选展开都不受测试机真实安装影响（真装有 ZCode 时曾把
        # assertIsNone 打成 assertIsNotNone）。非 Windows 平台多设这两个变量无害。
        env = mock.patch.dict(os.environ, {
            "ZCODE_ASAR": "",
            "LOCALAPPDATA": str(self.root / "localappdata"),
            "ProgramFiles": str(self.root / "programfiles")})
        env.start()
        self.addCleanup(env.stop)
        # 盘符扫描默认关闭，隔离 Windows 测试机上真实存在的 ZCode；盘符用例单独打开。
        drives = mock.patch.object(installer, "drive_candidates", return_value=[])
        self.drive_candidates = drives.start()
        self.addCleanup(drives.stop)

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

    def test_drive_candidates_cover_custom_layouts_on_fixed_drives(self):
        with mock.patch.object(installer, "fixed_drives", return_value=["D", "E"]) as fixed:
            candidates = REAL_DRIVE_CANDIDATES()
        fixed.assert_called_once_with("CDEFGHIJKLMNOPQRSTUVWXYZ")
        self.assertEqual(candidates, [r"D:\Program Files\ZCode\resources\app.asar",
                                      r"D:\ZCode\resources\app.asar",
                                      r"E:\Program Files\ZCode\resources\app.asar",
                                      r"E:\ZCode\resources\app.asar"])

    def test_fixed_drives_skip_network_removable_and_missing_drives(self):
        # 离线映射网络盘一被访问就触发重连，光驱/读卡器可能无介质：只保留 DRIVE_FIXED(3)。
        kinds = {"C:\\": 3, "D:\\": 4, "E:\\": 3, "F:\\": 2, "G:\\": 5}   # 1=DRIVE_NO_ROOT_DIR
        kernel32 = mock.Mock()
        kernel32.GetDriveTypeW.side_effect = lambda root: kinds.get(root, 1)
        with mock.patch.object(ctypes, "windll", mock.Mock(kernel32=kernel32), create=True):
            self.assertEqual(installer.fixed_drives("CDEFGH"), ["C", "E"])
        if not hasattr(ctypes, "windll"):
            self.assertEqual(installer.fixed_drives("CD"), [])

    def test_find_asar_checks_identity_of_drive_candidates(self):
        foreign = self.root / "foreign" / "resources" / "app.asar"
        make_asar(foreign, {"package.json": json.dumps({"name": "another-electron-app"}).encode()})
        good = self.zcode_asar()
        self.drive_candidates.return_value = [str(foreign), str(good)]
        with mock.patch.object(installer, "ASAR_CANDIDATES", []), \
                mock.patch.object(installer.sys, "platform", "win32"):
            self.assertEqual(installer.find_asar(), good)


if __name__ == "__main__":
    unittest.main()
