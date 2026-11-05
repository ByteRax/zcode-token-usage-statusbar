# -*- coding: utf-8 -*-
"""ui_element_exe_for 的隔离测试：darwin 后台拉起换 LSUIElement Helper，Dock 不闪图标（issue #238）。"""
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
import patch_install


class UiElementExecutableTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        # 仿 macOS bundle 布局：<root>/Contents/MacOS/ZCode + Frameworks 下的 Helper
        self.contents = self.root / "Contents"
        self.exe = self.contents / "MacOS" / "ZCode"
        self.helper = (self.contents / "Frameworks" / "ZCode Helper.app" /
                       "Contents" / "MacOS" / "ZCode Helper")
        for path in (self.exe, self.helper):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"#!/bin/fixture")
            path.chmod(0o755)

    def test_mac_bundle_swaps_to_ui_element_helper(self):
        with mock.patch.object(patch_install, "IS_MAC", True):
            self.assertEqual(patch_install.ui_element_exe_for(self.exe), self.helper)

    def test_missing_helper_falls_back_to_original(self):
        self.helper.unlink()
        with mock.patch.object(patch_install, "IS_MAC", True):
            self.assertEqual(patch_install.ui_element_exe_for(self.exe), self.exe)

    def test_helper_path_being_directory_falls_back(self):
        self.helper.unlink()
        self.helper.mkdir()
        with mock.patch.object(patch_install, "IS_MAC", True):
            self.assertEqual(patch_install.ui_element_exe_for(self.exe), self.exe)

    def test_loose_binary_without_bundle_layout_ignored(self):
        loose = self.root / "zcode-cli"
        loose.write_bytes(b"#!/bin/fixture")
        loose.chmod(0o755)
        with mock.patch.object(patch_install, "IS_MAC", True):
            self.assertEqual(patch_install.ui_element_exe_for(loose), loose)

    def test_missing_exe_still_swaps_to_existing_helper(self):
        # 与 cliExecutable 同契：不校验原二进制自身（升级覆盖窗口 ZCODE_EXE 可能暂缺），
        # 只看 Helper 是否可用——可用即继续检查，而不是整段跳过。
        self.exe.unlink()
        with mock.patch.object(patch_install, "IS_MAC", True):
            self.assertEqual(patch_install.ui_element_exe_for(self.exe), self.helper)

    @unittest.skipIf(os.name == "nt",
                     "Windows 的 chmod 不区分可执行位，os.access(X_OK) 恒真；仅 POSIX 可造不可执行 Helper")
    def test_non_executable_helper_falls_back(self):
        self.helper.chmod(0o644)
        with mock.patch.object(patch_install, "IS_MAC", True):
            self.assertEqual(patch_install.ui_element_exe_for(self.exe), self.exe)

    def test_non_mac_returns_original(self):
        with mock.patch.object(patch_install, "IS_MAC", False):
            self.assertEqual(patch_install.ui_element_exe_for(self.exe), self.exe)

    def test_empty_value_returned_as_is(self):
        with mock.patch.object(patch_install, "IS_MAC", True):
            self.assertIsNone(patch_install.ui_element_exe_for(None))
            self.assertEqual(patch_install.ui_element_exe_for(""), "")

    def test_string_path_accepted(self):
        with mock.patch.object(patch_install, "IS_MAC", True):
            self.assertEqual(patch_install.ui_element_exe_for(str(self.exe)), self.helper)

    def test_syntax_check_reuses_helper_with_run_as_node(self):
        run = mock.Mock(return_value=mock.Mock(returncode=0, stderr=""))
        with mock.patch.object(patch_install, "IS_MAC", True), \
                mock.patch.object(patch_install, "ZCODE_EXE", self.exe), \
                mock.patch.object(patch_install, "entry_bytes_of", return_value=b"entry"), \
                mock.patch.object(patch_install.subprocess, "run", run):
            output = io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(sys.stderr):
                self.assertTrue(patch_install.syntax_check(self.root / "app.asar"))
        argv, kwargs = run.call_args
        self.assertEqual(argv[0], [str(self.helper), "--check", mock.ANY])
        self.assertEqual(kwargs["env"]["ELECTRON_RUN_AS_NODE"], "1")
        self.assertIn("exit=0", output.getvalue())

    def test_syntax_check_skips_when_zcode_exe_missing(self):
        run = mock.Mock()
        with mock.patch.object(patch_install, "IS_MAC", True), \
                mock.patch.object(patch_install, "ZCODE_EXE", None), \
                mock.patch.object(patch_install.subprocess, "run", run):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertTrue(patch_install.syntax_check(self.root / "app.asar"))
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
