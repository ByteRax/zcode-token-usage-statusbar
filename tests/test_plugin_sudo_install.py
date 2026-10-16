# -*- coding: utf-8 -*-
"""Linux /opt 系统安装回归（issue #15）：sudo 下的运行时定位、验收器探测与免 root 卸载。

sudo 会重置 PATH 与 HOME：nvm 装的 node 不在 root 的 PATH 里，Path.home() 指向 /root。
这些用例只使用临时夹具，不读写真实用户目录、不访问真实 asar。
"""
import contextlib
import importlib.util
import io
import json
import os
import pwd
import struct
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


PLUGIN_ROOT = (Path(__file__).resolve().parents[1] / "plugins" /
               "zcode-token-usage-statusbar")
INSTALLER_PATH = PLUGIN_ROOT / "overlay_install.py"
spec = importlib.util.spec_from_file_location("sudo_install_overlay", str(INSTALLER_PATH))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def load_module(name, path):
    module_spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


def write_asar(path, entry=b"official;\n", name="zcode-desktop"):
    """微型 asar：与 patch_install.read_header 对齐，package.json 身份为 ZCode。"""
    files = {"package.json": json.dumps({"name": name}).encode("utf-8"),
             "out/main/index.js": entry}
    header, payload = {"files": {}}, bytearray()
    for inner, data in files.items():
        parent = header
        parts = inner.split("/")
        for part in parts[:-1]:
            parent = parent["files"].setdefault(part, {"files": {}})
        parent["files"][parts[-1]] = {"offset": str(len(payload)), "size": len(data)}
        payload.extend(data)
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    aligned = (len(encoded) + 7) // 4 * 4
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(encoded)) +
                     encoded + b"\0" * (aligned - len(encoded) - 4) + payload)


class SudoRuntimeLocationTests(unittest.TestCase):
    """default_runtime() 必须落在真实用户家目录，而不是 sudo 重置后的 /root。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        user = pwd.getpwuid(os.getuid())
        self.user, self.home = user.pw_name, Path(user.pw_dir)
        # 与 issue 复现一致：sudo 清空后只剩系统默认 PATH。
        patcher = mock.patch.dict(os.environ, {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
                                 clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def sudo_env(self, home=None):
        """模拟 sudo：SUDO_USER 存在、euid 为 0、HOME 指向 root 家目录。"""
        patchers = (
            mock.patch.dict(os.environ, {"SUDO_USER": self.user,
                                         "HOME": str(home or self.root / "root")}),
            mock.patch.object(os, "geteuid", return_value=0),
        )
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_default_runtime_uses_sudo_user_home(self):
        self.sudo_env()
        self.assertEqual(installer.default_runtime(),
                         self.home / ".zcode" / "zcode-token-usage-statusbar")

    def test_default_runtime_never_uses_root_home_under_sudo(self):
        self.sudo_env()
        self.assertNotEqual(installer.default_runtime(),
                            Path("/root") / ".zcode" / "zcode-token-usage-statusbar")
        self.assertNotEqual(installer.default_runtime(),
                            (self.root / "root") / ".zcode" / "zcode-token-usage-statusbar")

    def test_default_runtime_keeps_real_home_without_sudo(self):
        # 普通用户（非 sudo）语义不变：仍是自己家目录，不依赖 SUDO_USER。
        fallback = self.root / "user"
        with mock.patch.dict(os.environ, {"HOME": str(fallback)}, clear=True), \
                mock.patch.object(Path, "home", return_value=fallback), \
                mock.patch.object(os, "geteuid", return_value=1000):
            self.assertEqual(installer.default_runtime(),
                             fallback / ".zcode" / "zcode-token-usage-statusbar")

    def test_unknown_or_absent_sudo_user_falls_back_to_current_home(self):
        fallback = self.root / "fallback"
        for environment in ({"SUDO_USER": "definitely-not-a-user-12345"},
                            {"SUDO_USER": ""}, {}):
            with self.subTest(environment=environment), \
                    mock.patch.dict(os.environ, environment, clear=True), \
                    mock.patch.object(Path, "home", return_value=fallback):
                self.assertEqual(installer.default_runtime(),
                                 fallback / ".zcode" / "zcode-token-usage-statusbar")

    def test_resolved_runtime_targets_sudo_users_config_not_root(self):
        """端到端：sudo 下定位到的 runtime 就是真实用户装了 config.json 的那个。"""
        user_home = self.root / "user-home"
        runtime = user_home / ".zcode" / "zcode-token-usage-statusbar"
        runtime.mkdir(parents=True)
        (runtime / "config.json").write_text('{"asar_path": "/opt/ZCode/resources/app.asar"}',
                                             encoding="utf-8")
        record = types.SimpleNamespace(pw_dir=str(user_home), pw_uid=os.getuid(),
                                       pw_gid=os.getgid())
        pi = mock.Mock(ASAR=None)
        with mock.patch.dict(os.environ, {"SUDO_USER": self.user,
                                          "HOME": str(self.root / "root")}, clear=True), \
                mock.patch.object(os, "geteuid", return_value=0), \
                mock.patch.object(pwd, "getpwnam", return_value=record), \
                mock.patch.object(installer, "load_patch_install", return_value=pi), \
                mock.patch.object(installer, "is_zcode_asar", return_value=True):
            resolved, patched = installer.resolve_paths()
        self.assertEqual(resolved, runtime)
        self.assertEqual(installer.load_runtime_config(resolved),
                         {"asar_path": "/opt/ZCode/resources/app.asar"})
        pi.set_target.assert_called_once_with(Path("/opt/ZCode/resources/app.asar").resolve())


class SudoNodeDiscoveryTests(unittest.TestCase):
    """sudo 清空 PATH 后，验收器仍要能找到 node（含 nvm 与系统位置）。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        # 用临时家目录模拟 SUDO_USER（真实探测走 pwd.getpwnam，不碰 /root 或真实 nvm）。
        self.home = self.root / "home"
        self.home.mkdir()
        self.user = "zusage-sudo-user"
        self.record = types.SimpleNamespace(pw_dir=str(self.home), pw_uid=os.getuid(),
                                            pw_gid=os.getgid())
        patcher = mock.patch.dict(os.environ, {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
                                 clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def discovered(self, which=None, system=()):
        with mock.patch.dict(os.environ, {"SUDO_USER": self.user}), \
                mock.patch.object(os, "geteuid", return_value=0), \
                mock.patch.object(pwd, "getpwnam", return_value=self.record), \
                mock.patch.object(installer.shutil, "which", return_value=which), \
                mock.patch.object(installer, "SYSTEM_NODE_LOCATIONS", system):
            return [str(item) for item in installer._node_candidates()]

    def test_sudo_user_nvm_node_is_discovered_without_path(self):
        r"""SUDO_USER 用 nvm 装的 node（~/.nvm/versions/node/*/bin/node）须被找到。"""
        executable = self.home / ".nvm" / "versions" / "node" / "v24.12.0" / "bin" / "node"
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b"#!/bin/sh\n")
        self.assertIn(str(executable), self.discovered())

    def test_highest_nvm_version_wins_and_is_listed_first(self):
        nvm = self.home / ".nvm" / "versions" / "node"
        for version in ("v20.11.0", "v24.12.0", "v22.9.0"):
            target = nvm / version / "bin" / "node"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"#!/bin/sh\n")
        found = self.discovered()
        self.assertEqual(found[0], str(nvm / "v24.12.0" / "bin" / "node"))
        self.assertLess(found.index(str(nvm / "v22.9.0" / "bin" / "node")),
                        found.index(str(nvm / "v20.11.0" / "bin" / "node")))

    def test_path_node_still_wins_when_present(self):
        self.assertEqual(self.discovered(which="/custom/bin/node")[0], "/custom/bin/node")

    def test_system_locations_are_probed_as_fallback(self):
        fake = tuple(str(self.root / "system" / name) for name in ("node", "altnode"))
        for location in fake:
            Path(location).parent.mkdir(parents=True, exist_ok=True)
            Path(location).write_bytes(b"#!/bin/sh\n")
        self.assertEqual(set(self.discovered(system=fake)), set(fake))

    def test_missing_executables_are_not_reported_as_candidates(self):
        self.assertNotIn(str(self.home / ".nvm" / "versions" / "node" / "v24.12.0"),
                         " ".join(self.discovered()))

    def test_verifier_launch_candidates_include_discovered_node(self):
        """找到 node 时不再抛「未找到运行时验收所需 Node/ZCode 可执行文件」。"""
        node = self.root / "node"
        node.write_bytes(b"#!/bin/sh\n")
        runtime = self.root / "runtime"
        runtime.mkdir()
        for name in ("plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs"):
            (runtime / name).write_bytes(b"// fixture")
        with mock.patch.object(installer, "_node_candidates", return_value=[node]), \
                mock.patch.object(installer, "_run_verifier") as run:
            run.return_value = types.SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"ok": True, "identity": {"record": None},
                                   "pluginRoot": str(installer.PLUGIN_ROOT.resolve())}),
                stderr="")
            with installer._sync_verifier(runtime):
                pass
        self.assertEqual(run.call_args[0][0][0], str(node))

    def test_asar_adjacent_executable_is_preferred_over_path_node(self):
        """能从已解析的安装位置推出 ZCode 可执行文件时，它优先于 PATH 里的 node。"""
        bundle = self.root / "opt" / "ZCode"
        target = bundle / "resources" / "app.asar"
        write_asar(target)
        executable = bundle / ("ZCode.exe" if sys.platform == "win32" else "zcode")
        if not sys.platform.startswith("linux") and sys.platform != "win32":
            executable = bundle / "MacOS" / "ZCode"
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b"#!/bin/sh\n")
        runtime = self.root / "runtime"
        runtime.mkdir()
        for name in ("plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs"):
            (runtime / name).write_bytes(b"// fixture")
        with mock.patch.object(installer, "_node_candidates",
                               return_value=[Path("/path/bin/node")]), \
                mock.patch.object(installer, "_run_verifier") as run:
            run.return_value = types.SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"ok": True, "identity": {"record": None},
                                   "pluginRoot": str(installer.PLUGIN_ROOT.resolve())}),
                stderr="")
            with installer._sync_verifier(runtime, target):
                pass
        self.assertEqual(run.call_args[0][0][0], str(executable))


class UnactionableVerifierErrorTests(unittest.TestCase):
    """找不到 node/ZCode 时，报错必须是可操作的中文提示，而不是裸的 ValueError。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        for name in ("plugin-updater.cjs", "plugin-release.cjs", "plugin-storage.cjs"):
            (self.runtime / name).write_bytes(b"// fixture")

    def test_missing_node_message_names_the_sudo_env_fix(self):
        with mock.patch.object(installer, "_node_candidates", return_value=[]):
            with self.assertRaises(ValueError) as failure:
                with installer._sync_verifier(self.runtime):
                    pass
        message = str(failure.exception)
        self.assertIn("node", message)
        self.assertIn("sudo", message)
        self.assertIn("PATH", message)


class ReadonlyRemoveTests(unittest.TestCase):
    """问题 2：安装从未成功时，remove 不该被 /opt 的 asar 锁卡住。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.asar = self.root / "opt" / "ZCode" / "resources" / "app.asar"
        write_asar(self.asar)
        self.pi = load_module("sudo_remove_patch", PLUGIN_ROOT / "patch_install.py")
        self.pi.set_target(self.asar)
        self.pi.set_runtime(self.runtime)
        self.pi._LANG = "zh"
        # 隔离宿主真实客户端：固定目标为夹具 asar（测试接缝），不枚举平台候选。
        for patcher in (mock.patch.object(installer, "is_zcode_asar", return_value=True),
                        mock.patch.object(installer, "asar_candidates", return_value=[]),
                        mock.patch.dict(os.environ, {"ZUSAGE_PLUGIN_ASAR": str(self.asar)})):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_main(self, command):
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["overlay_install.py", command]), \
                mock.patch.dict(os.environ, {"ZUSAGE_PLUGIN_RUNTIME": str(self.runtime)}), \
                mock.patch.object(installer, "load_patch_install", return_value=self.pi), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as exit_code:
                installer.main()
        return exit_code.exception.code, output.getvalue(), errors.getvalue()

    def inject(self):
        self.pi.set_target(self.asar)
        entry = self.pi.entry_bytes_of(self.asar) + self.pi.INJECT_LINE.encode()
        original = self.asar.read_bytes()
        write_asar(self.asar, entry=entry)
        return original

    def unwritable(self):
        """模拟普通用户面对 root 所有的 /opt：asar 与所在目录都不可写。"""
        return mock.patch.object(self.pi, "target_writable", return_value=False)

    def test_remove_without_injection_succeeds_without_root(self):
        with self.unwritable(), mock.patch.object(self.pi, "client_running", return_value=False):
            code, output, _ = self.run_main("remove")
        self.assertEqual(code, 0)
        self.assertTrue((self.runtime / ".plugin-overlay-optout").exists())
        self.assertIn("未注入", output)

    def test_remove_without_injection_never_prints_lock_permission_error(self):
        with self.unwritable(), mock.patch.object(self.pi, "client_running", return_value=False):
            _, output, errors = self.run_main("remove")
        self.assertNotIn("Permission denied", output + errors)
        self.assertNotIn("卸载锁获取失败", output + errors)

    def test_remove_without_injection_does_not_repack_or_touch_target(self):
        before = self.asar.read_bytes()
        with self.unwritable(), \
                mock.patch.object(self.pi, "client_running", return_value=False), \
                mock.patch.object(self.pi, "repack") as repack:
            code, _, _ = self.run_main("remove")
        self.assertEqual(code, 0)
        repack.assert_not_called()
        self.assertEqual(self.asar.read_bytes(), before)

    def test_remove_with_injection_still_requires_root_and_reports_it(self):
        self.inject()
        with self.unwritable():
            code, output, errors = self.run_main("remove")
        self.assertEqual(code, 1)
        self.assertIn("sudo", output + errors)
        self.assertFalse((self.runtime / ".plugin-overlay-optout").exists())
        self.assertTrue(self.pi.ZUSAGE_LINE_RE.search(self.pi.entry_bytes_of(self.asar)))

    def test_remove_with_injection_message_points_at_home_and_path_preservation(self):
        self.inject()
        with self.unwritable():
            _, output, errors = self.run_main("remove")
        hint = output + errors
        self.assertIn("sudo", hint)
        self.assertIn("HOME", hint)
        self.assertIn("PATH", hint)

    def test_remove_on_writable_target_keeps_normal_strip_path(self):
        self.inject()
        code, _, errors = self.run_main("remove")
        self.assertEqual(code, 0, errors)
        self.assertTrue((self.runtime / ".plugin-overlay-optout").exists())
        self.assertFalse(self.pi.ZUSAGE_LINE_RE.search(self.pi.entry_bytes_of(self.asar)))


class SudoOwnershipTests(unittest.TestCase):
    """root 写进真实用户家目录的运行时文件须归还给 SUDO_USER。"""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "overlay.js").write_bytes(b"x")

    def test_chown_runtime_hands_files_back_to_sudo_user(self):
        user = pwd.getpwuid(os.getuid())
        with mock.patch.dict(os.environ, {"SUDO_USER": user.pw_name}), \
                mock.patch.object(os, "geteuid", return_value=0), \
                mock.patch.object(installer.os, "chown") as chown:
            installer.chown_runtime_to_user(self.runtime)
        self.assertEqual(chown.call_args_list,
                         [mock.call(self.runtime, user.pw_uid, user.pw_gid),
                          mock.call(self.runtime / "overlay.js", user.pw_uid, user.pw_gid)])

    def test_chown_runtime_is_noop_without_sudo(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(installer.os, "chown") as chown:
            installer.chown_runtime_to_user(self.runtime)
        chown.assert_not_called()

    def test_chown_failure_is_not_fatal(self):
        user = pwd.getpwuid(os.getuid())
        with mock.patch.dict(os.environ, {"SUDO_USER": user.pw_name}), \
                mock.patch.object(os, "geteuid", return_value=0), \
                mock.patch.object(installer.os, "chown", side_effect=OSError("denied")):
            installer.chown_runtime_to_user(self.runtime)   # 不抛


if __name__ == "__main__":
    unittest.main()
