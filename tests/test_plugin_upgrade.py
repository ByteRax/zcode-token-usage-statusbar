# -*- coding: utf-8 -*-
"""使用临时微型 asar 验证目标迁移、客户端升级覆盖及配置安全。"""
import contextlib
import ctypes
import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


PLUGIN_ROOT = (Path(__file__).resolve().parents[1] / "plugins" /
               "zcode-token-usage-statusbar")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PluginUpgradeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.runtime = self.root / "runtime"
        self.plugin = self.root / "plugin"
        self.asar = self.root / "custom-location" / "resources" / "app.asar"
        self.installer = load_module("overlay_upgrade_test", PLUGIN_ROOT / "overlay_install.py")
        self.real_candidates = self.installer.asar_candidates
        self.pi = load_module("patch_upgrade_test", PLUGIN_ROOT / "patch_install.py")
        self.pi._LANG = "zh"  # 不读取真实用户的语言配置。
        self.body = b"export const clientVersion = '1.0.0';\n"
        self.write_asar(self.asar)
        manifest = self.plugin / ".zcode-plugin" / "plugin.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text('{"name":"zcode-token-usage-statusbar","version":"1.0.0"}', encoding="utf-8")
        for name in self.installer.RUNTIME_FILES:
            (self.plugin / name).write_bytes((PLUGIN_ROOT / name).read_bytes())
        self.updater = types.SimpleNamespace(start_auto_update=mock.Mock())
        self.notice = load_module("upgrade_restart_notice", PLUGIN_ROOT / "restart_notice.py")
        # Windows 上 SystemRoot 缺失会让 node 验收子进程启动即崩（ncrypto CSPRNG 断言），
        # 清空环境时必须保留系统关键变量；同时固定子进程 IO 编码为 UTF-8——被清空后
        # 子进程会回落到 GBK 控制台编码输出中文，父进程 UTF-8 解码在读线程崩溃（stdout 变 None）。
        windows_essentials = {name: os.environ[name] for name in
                              ("SystemRoot", "TEMP", "TMP") if os.name == "nt" and name in os.environ}
        windows_essentials.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        for patcher in (
                mock.patch.object(self.installer, "PLUGIN_ROOT", self.plugin),
                mock.patch.object(self.installer, "load_patch_install", return_value=self.pi),
                mock.patch.object(self.installer, "asar_candidates", return_value=[]),
                mock.patch.object(self.pi, "syntax_check", return_value=True),
                mock.patch.object(self.pi, "launch_monitor"),
                mock.patch.object(self.pi, "client_running", return_value=False),
                mock.patch.dict(sys.modules, {"plugin_auto_update": self.updater,
                    "restart_notice": self.notice}),
                mock.patch.dict(os.environ, {"ZUSAGE_PLUGIN_RUNTIME": str(self.runtime),
                    "HOME": str(self.root / "home"), "USERPROFILE": str(self.root / "home"),
                    "PATH": os.environ.get("PATH", ""), **windows_essentials}, clear=True)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def notice_context(self, runtime, **kwargs):
        """reminder() 的 context 文案；无提醒时空串。"""
        got = self.notice.reminder(runtime, **kwargs)
        return got["context"] if got else ""

    def write_asar(self, path, entry=None, name="zcode-desktop", version="1.0.0", unpacked=False):
        files = {
            "package.json": json.dumps({"name": name, "version": version}).encode("utf-8"),
            "out/main/index.js": self.body if entry is None else entry,
            "assets/unchanged.txt": b"official resource",
        }
        header, payload = {"files": {}}, bytearray()
        for name, data in files.items():
            parent = header
            parts = name.split("/")
            for part in parts[:-1]:
                parent = parent["files"].setdefault(part, {"files": {}})
            node = {"offset": str(len(payload)), "size": len(data)}
            if name == "package.json" and unpacked:
                node["unpacked"] = True
            parent["files"][parts[-1]] = node
            payload.extend(data)
        encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
        aligned = (len(encoded) + 7) // 4 * 4
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(encoded)) +
                         encoded + b"\0" * (aligned - len(encoded) - 4) + payload)

    def write_config(self, config):
        self.runtime.mkdir(parents=True, exist_ok=True)
        (self.runtime / "config.json").write_text(json.dumps(config), encoding="utf-8")

    def config(self):
        return json.loads((self.runtime / "config.json").read_text(encoding="utf-8"))

    def main(self, command):
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["overlay_install.py", command]), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as exit_code:
                self.installer.main()
        return exit_code.exception.code, output.getvalue(), errors.getvalue()

    def hook(self):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = self.installer.run_hook()
        self.assertEqual(output.getvalue(), "")
        return result, errors.getvalue()

    def test_platform_candidates_include_common_and_nonstandard_windows_programs(self):
        local = self.root / "LocalAppData"
        custom = local / "Programs" / "custom-channel" / "resources" / "app.asar"
        self.write_asar(custom)
        os.environ.update({"LOCALAPPDATA": str(local), "ProgramFiles": str(self.root / "ProgramFiles")})
        with mock.patch.object(self.installer.sys, "platform", "win32"):
            candidates = self.real_candidates()
            self.assertIn(local / "Programs/ZCode/resources/app.asar", candidates)
            self.assertIn(local / "ZCode/resources/app.asar", candidates)
            self.assertIn(self.root / "ProgramFiles/ZCode/resources/app.asar", candidates)
            self.assertIn(custom, candidates)
        with mock.patch.object(self.installer, "asar_candidates", return_value=[custom]):
            self.assertEqual(self.installer.resolve_paths()[1].ASAR, custom)
        with mock.patch.object(self.installer.sys, "platform", "darwin"), \
                mock.patch.object(self.installer.Path, "home", return_value=self.root):
            self.assertIn(self.root / "Applications/ZCode.app/Contents/Resources/app.asar",
                          self.real_candidates())
        with mock.patch.object(self.installer.sys, "platform", "linux"):
            self.assertIn(Path("/opt/ZCode/resources/app.asar"), self.real_candidates())
            self.assertIn(Path("/usr/lib/zcode/resources/app.asar"), self.real_candidates())

    def test_production_precedence_environment_config_candidates(self):
        configured = self.root / "configured" / "app.asar"
        discovered = self.root / "discovered" / "app.asar"
        self.write_asar(configured)
        self.write_asar(discovered)
        self.write_config({"asar_path": str(configured)})
        os.environ["ZCODE_ASAR"] = str(self.asar)
        with mock.patch.object(self.installer, "asar_candidates", return_value=[discovered]):
            self.assertEqual(self.installer.resolve_paths()[1].ASAR, self.asar)
            del os.environ["ZCODE_ASAR"]
            self.assertEqual(self.installer.resolve_paths()[1].ASAR, configured)
            configured.unlink()
            self.assertEqual(self.installer.resolve_paths()[1].ASAR, discovered)

    def test_test_override_has_explicit_priority_and_skips_package_validation(self):
        foreign = self.root / "foreign.asar"
        self.write_asar(foreign, name="another-electron-client")
        self.write_config({"asar_path": str(self.asar)})
        os.environ.update({"ZUSAGE_PLUGIN_ASAR": str(foreign), "ZCODE_ASAR": str(self.asar)})
        with mock.patch.object(self.installer, "is_zcode_asar", side_effect=AssertionError("validated test")):
            self.assertEqual(self.installer.resolve_paths()[1].ASAR, foreign)

    def test_foreign_asar_is_rejected_for_every_production_source(self):
        foreign = self.root / "ZCode" / "resources" / "app.asar"
        self.write_asar(foreign, name="another-electron-client")
        # 文件名甚至可执行文件名均不是身份依据。
        (foreign.parent.parent / "ZCode.exe").write_bytes(b"not ZCode")
        self.write_config({"asar_path": str(foreign)})
        os.environ["ZCODE_ASAR"] = str(foreign)
        before = foreign.read_bytes()
        with mock.patch.object(self.installer, "asar_candidates", return_value=[foreign]):
            self.assertIsNone(self.installer.resolve_paths()[1].ASAR)
            code, _, errors = self.main("install")
        self.assertEqual(code, 1)
        self.assertIn("未找到有效 ZCode", errors)
        self.assertEqual(foreign.read_bytes(), before)
        self.assertEqual(self.config(), {"asar_path": str(foreign)})
        self.pi.launch_monitor.assert_not_called()

    def test_invalid_environment_and_stale_config_fall_back_to_valid_candidate(self):
        foreign = self.root / "foreign.asar"
        self.write_asar(foreign, name="electron")
        os.environ["ZCODE_ASAR"] = str(foreign)
        self.write_config({"asar_path": str(self.root / "removed" / "app.asar"), "lang": "en"})
        with mock.patch.object(self.installer, "asar_candidates", return_value=[self.asar]):
            code, _, _ = self.main("install")
        self.assertEqual(code, 0)
        self.assertEqual(self.config()["asar_path"], str(self.asar))
        self.assertEqual(self.config()["lang"], "en")
        self.assertEqual(self.pi.entry_bytes_of(self.asar), self.body + self.pi.INJECT_LINE.encode())

    def test_no_target_never_reuses_cached_patch_module_target(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        self.assertEqual(self.installer.resolve_paths()[1].ASAR, self.asar)
        del os.environ["ZUSAGE_PLUGIN_ASAR"]
        self.assertIsNone(self.installer.resolve_paths()[1].ASAR)
        for name in ("BAK", "TMP", "ZCODE_EXE"):
            self.assertIsNone(getattr(self.pi, name))
        self.assertIsNone(self.installer.injected_status(self.pi))
        self.assertFalse((self.runtime / "config.json").exists())

    def test_unpacked_missing_or_invalid_package_is_not_a_production_target(self):
        for name, unpacked in (("zcode", True), (None, False), (["zcode"], False)):
            with self.subTest(name=name, unpacked=unpacked):
                self.write_asar(self.asar, name=name, unpacked=unpacked)
                self.assertFalse(self.installer.is_zcode_asar(self.pi, self.asar))
        self.asar.write_bytes(b"not an asar")
        self.assertFalse(self.installer.is_zcode_asar(self.pi, self.asar))

    def test_first_install_creates_only_python_and_actual_target_configuration(self):
        os.environ["ZCODE_ASAR"] = str(self.asar)
        self.assertEqual(self.main("install")[0], 0)
        self.assertEqual(self.config(), {"python_path": sys.executable, "asar_path": str(self.asar)})
        self.assertTrue(self.installer.auto_enabled(self.runtime))
        self.assertTrue(self.installer.injected_status(self.pi))
        self.pi.launch_monitor.assert_called_once()
        self.pi.syntax_check.assert_called_once()
        checked = self.pi.syntax_check.call_args.args[0]
        self.assertEqual(checked.parent, self.pi.TMP.parent)
        self.assertTrue(checked.name.startswith(self.pi.TMP.name + ".") and checked.name.endswith(".stage"))
        self.assertFalse(self.pi.TMP.exists())
        # 后续卸载仅靠已记住的非标准位置，不依赖环境变量或缓存目标。
        del os.environ["ZCODE_ASAR"]
        self.pi.ASAR = self.root / "incorrect-cached.asar"
        self.assertEqual(self.main("remove")[0], 0)
        self.assertEqual(self.pi.entry_bytes_of(self.asar), self.body)

    def test_install_preserves_existing_python_and_unrelated_nested_settings(self):
        settings = {"asar_path": str(self.asar), "python_path": "custom-python", "lang": "en",
                    "remote": {"enabled": True, "host": "my-host"}, "plugin_auto_update": True,
                    "plugin_auto_install_overlay": False, "hot_reload": False}
        self.write_config(settings)
        with mock.patch.object(self.installer, "_atomic_write", wraps=self.installer._atomic_write) as atomic:
            self.assertEqual(self.main("install")[0], 0)
        self.assertEqual(self.config(), settings)
        self.assertNotIn(self.runtime / "config.json", [call.args[0] for call in atomic.call_args_list])

    def test_missing_python_is_added_without_enabling_or_disabling_user_optins(self):
        settings = {"asar_path": str(self.asar), "plugin_auto_install_overlay": True,
                    "plugin_auto_update": False, "remote": {"enabled": False}}
        self.write_config(settings)
        self.assertEqual(self.main("install")[0], 0)
        self.assertEqual(self.config(), dict(settings, python_path=sys.executable))

    def test_corrupt_config_is_never_overwritten_even_after_successful_install(self):
        os.environ["ZCODE_ASAR"] = str(self.asar)
        self.runtime.mkdir(parents=True)
        config_path = self.runtime / "config.json"
        for content in (b"{bad JSON", b"[]", b"null", b'"not an object"'):
            with self.subTest(content=content):
                config_path.write_bytes(content)
                self.assertEqual(self.main("install")[0], 0)
                self.assertEqual(config_path.read_bytes(), content)
                self.assertFalse(self.installer.auto_enabled(self.runtime))
        self.assertTrue(self.installer.injected_status(self.pi))

    def test_config_save_is_atomic_and_failed_replace_preserves_settings(self):
        settings = {"asar_path": str(self.asar), "lang": "en", "remote": {"enabled": True}}
        self.write_config(settings)
        self.installer.resolve_paths()
        config_path = self.runtime / "config.json"
        before = config_path.read_bytes()
        real_replace = os.replace

        def inspect_replace(source, destination):
            self.assertEqual(Path(source).parent, config_path.parent)
            self.assertEqual(destination, config_path)
            self.assertEqual(json.loads(Path(source).read_text(encoding="utf-8")),
                             dict(settings, python_path=sys.executable))
            raise OSError("config replace denied")

        with mock.patch.object(self.installer.os, "replace", side_effect=inspect_replace):
            self.assertFalse(self.installer.save_runtime_config(self.runtime, self.pi))
        self.assertEqual(config_path.read_bytes(), before)
        self.assertFalse(list(self.runtime.glob("config.json.*.tmp")))
        with mock.patch.object(self.installer.os, "replace", wraps=real_replace) as replace:
            self.assertTrue(self.installer.save_runtime_config(self.runtime, self.pi))
        self.assertEqual(replace.call_count, 1)
        self.assertEqual(self.config(), dict(settings, python_path=sys.executable))

    def test_state_rejects_history_wrong_paths_and_duplicate_injections(self):
        self.pi.set_target(self.asar)
        self.pi.set_runtime(self.runtime)
        current = self.pi.INJECT_LINE.encode()
        old = self.pi.INJECT_LINE_TMPL.format(url=(self.root / "old-plugin/inject-main.cjs").as_uri()).encode()
        for suffix in (b"", old, old + current, current * 2,
                       current.replace(b"inject-main.cjs", b"wrong-loader.cjs")):
            with self.subTest(suffix=suffix):
                self.write_asar(self.asar, entry=self.body + suffix)
                self.assertFalse(self.installer.injected_status(self.pi))
        self.write_asar(self.asar, entry=self.body + current)
        self.assertTrue(self.installer.injected_status(self.pi))
        self.asar.unlink()
        self.assertIsNone(self.installer.injected_status(self.pi))

    def test_state_accepts_exact_bytes_injection_line_stub(self):
        line = b"\n;stub();"
        stub = types.SimpleNamespace(ASAR=self.asar, INJECT_LINE=line,
                                     ZUSAGE_LINE_RE=re.compile(rb"historical-line"),
                                     entry_bytes_of=lambda _: self.body + line)
        self.assertTrue(self.installer.injected_status(stub))
        stub.entry_bytes_of = lambda _: self.body + line * 2
        self.assertFalse(self.installer.injected_status(stub))

    def test_first_session_defaults_to_install_and_preserves_explicit_disable(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        result, _ = self.hook()
        self.assertTrue(self.installer.injected_status(self.pi))
        self.assertIn("用户可见·重启提醒", result["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("plugin_auto_install_overlay", self.config())
        self.assertTrue(self.installer.auto_enabled(self.runtime))
        self.assertEqual(self.config()["asar_path"], str(self.asar))
        for config in ({"plugin_auto_install_overlay": False},
                       {"plugin_auto_install_overlay": "true"}):
            self.write_asar(self.asar)
            self.write_config(config)
            before = self.asar.read_bytes()
            for _ in range(2):
                result, _ = self.hook()
                self.assertEqual(self.asar.read_bytes(), before)
                self.assertIn("install-overlay", result["systemMessage"])
            self.assertEqual(self.config()["plugin_auto_install_overlay"], config["plugin_auto_install_overlay"])
        self.write_config({"plugin_auto_install_overlay": False})
        os.environ["ZUSAGE_PLUGIN_AUTO_INSTALL"] = "1"
        self.hook()
        self.assertTrue(self.installer.injected_status(self.pi))
        self.assertIs(self.config()["plugin_auto_install_overlay"], False)

    def test_default_install_preserves_corrupt_config_and_respects_environment_off(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        self.runtime.mkdir()
        config = self.runtime / "config.json"
        original = self.asar.read_bytes()
        for content in ('{bad', '[]', 'null'):
            config.write_text(content, encoding="utf-8")
            self.hook()
            self.assertEqual(config.read_text(), content)
            self.assertEqual(self.asar.read_bytes(), original)
        config.unlink()
        os.environ["ZUSAGE_PLUGIN_AUTO_INSTALL"] = "0"
        self.hook()
        self.assertEqual(self.asar.read_bytes(), original)
        os.environ.pop("ZUSAGE_PLUGIN_AUTO_INSTALL")
        self.assertTrue(self.installer.auto_enabled(self.runtime))
        (self.runtime / ".plugin-overlay-optout").write_text("1")
        self.assertEqual(self.hook()[0], {"suppressOutput": True})
        self.assertEqual(self.asar.read_bytes(), original)

    def test_clean_first_session_and_prompt_require_install_before_restart(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        self.write_config({"plugin_auto_install_overlay": False})
        original = self.asar.read_bytes()
        for _ in range(2):
            result, _ = self.hook()
            self.assertIn("install-overlay", result["systemMessage"])
            self.assertIn("用户可见·安装提醒", result["hookSpecificOutput"]["additionalContext"])
            self.assertEqual(self.asar.read_bytes(), original)
            prompt = subprocess.run([sys.executable, str(PLUGIN_ROOT / "hooks" / "prompt-submit.py")],
                                    input="{}", capture_output=True, text=True, timeout=10)
            self.assertEqual(prompt.returncode, 0, prompt.stderr)
            context = json.loads(prompt.stdout)["hookSpecificOutput"]["additionalContext"]
            # issue #108：提醒只走会话级通道，prompt-submit 在待安装状态也不注入。
            self.assertNotIn("用户可见·", context)
            self.assertNotIn("插件提醒", context)
            self.assertIn("【内部背景·勿展示】", context)
            self.assertNotIn("本轮统计指令", context)
        self.assertEqual(self.main("install")[0], 0)
        context = self.notice_context(self.runtime)
        self.assertIn("用户可见·重启提醒", context)
        self.assertIn("完全退出 ZCode", context)
        helper = load_module("first_install_runtime_lock", PLUGIN_ROOT / "runtime_lock.py")
        marker = json.loads((self.runtime / ".plugin-restart-required").read_text())
        helper.ack_restart(self.runtime, dict(marker.get("hashes", {}), _loadedAt=marker["publishedAt"] + 1))
        self.assertEqual(self.notice_context(self.runtime), "")
        self.assertEqual(self.hook()[0], {"suppressOutput": True})

    def test_remove_suppresses_session_and_prompt_notices_with_leftover_marker(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        self.assertEqual(self.main("install")[0], 0)
        self.assertEqual(self.main("remove")[0], 0)
        self.assertTrue((self.runtime / ".plugin-restart-required").exists())
        self.assertEqual(self.hook()[0], {"suppressOutput": True})
        self.assertEqual(self.notice_context(self.runtime), "")
        prompt = subprocess.run([sys.executable, str(PLUGIN_ROOT / "hooks" / "prompt-submit.py")],
                                input="{}", capture_output=True, text=True, timeout=10)
        self.assertEqual(prompt.returncode, 0, prompt.stderr)
        context = json.loads(prompt.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("用户可见·", context)
        self.assertIn("【内部背景·勿展示】", context)
        self.assertNotIn("本轮统计指令", context)

    def test_client_upgrade_overwrite_preserves_explicit_disable(self):
        self.write_config({"asar_path": str(self.asar), "plugin_auto_install_overlay": False})
        self.assertEqual(self.main("install")[0], 0)
        upgraded = b"export const clientVersion = '2.0.0';\n"
        self.write_asar(self.asar, entry=upgraded, version="2.0.0")
        before = self.asar.read_bytes()
        result, _ = self.hook()
        self.assertIn("需要请运行", result["systemMessage"])
        self.assertEqual(self.asar.read_bytes(), before)
        settings = self.config()
        settings["plugin_auto_install_overlay"] = True
        self.write_config(settings)
        result, _ = self.hook()
        self.assertIn("用量状态条已安装或更新", result["systemMessage"])
        self.assertEqual(result["hookSpecificOutput"]["hookEventName"], "SessionStart")
        self.assertIn("第一行", result["hookSpecificOutput"]["additionalContext"])
        self.assertTrue((self.runtime / ".plugin-restart-required").is_file())
        self.assertEqual(self.pi.entry_bytes_of(self.asar), upgraded + self.pi.INJECT_LINE.encode())
        with mock.patch.object(self.pi, "repack", wraps=self.pi.repack) as repack:
            unchanged, _ = self.hook()
        self.assertEqual(unchanged["hookSpecificOutput"]["hookEventName"], "SessionStart")
        self.assertIn("完全退出 ZCode", unchanged["systemMessage"])
        repack.assert_not_called()
        helper = load_module("upgrade_runtime_lock", PLUGIN_ROOT / "runtime_lock.py")
        hashes = json.loads((self.runtime / ".plugin-restart-required").read_text()).get("hashes", {})
        published = json.loads((self.runtime / ".plugin-restart-required").read_text())
        helper.ack_restart(self.runtime, dict(hashes, _loadedAt=published["publishedAt"] + 1))
        after_restart, _ = self.hook()
        self.assertEqual(after_restart, {"suppressOutput": True})
        with self.asar.open("rb") as stream:
            header, base = self.pi.read_header(stream)
            node = header["files"]["package.json"]
            stream.seek(base + int(node["offset"]))
            self.assertEqual(json.loads(stream.read(node["size"]))["version"], "2.0.0")
            asset = header["files"]["assets"]["files"]["unchanged.txt"]
            stream.seek(base + int(asset["offset"]))
            self.assertEqual(stream.read(asset["size"]), b"official resource")

    def test_optin_repairs_old_runtime_paths_and_duplicate_lines_using_real_install(self):
        self.write_config({"asar_path": str(self.asar), "plugin_auto_install_overlay": True})
        self.pi.set_runtime(self.runtime)
        current = self.pi.INJECT_LINE.encode()
        old = self.pi.INJECT_LINE_TMPL.format(url=(self.root / "removed-cache/inject-main.cjs").as_uri()).encode()
        for suffix in (old, old + current, current * 2):
            with self.subTest(suffix=suffix):
                self.write_asar(self.asar, entry=self.body + suffix)
                result, _ = self.hook()
                self.assertIn("用量状态条已安装或更新", result["systemMessage"])
                self.assertEqual(self.pi.entry_bytes_of(self.asar), self.body + current)
                self.assertTrue(self.installer.injected_status(self.pi))

    def test_publication_intent_precedes_asar_and_ack_is_not_rebuilt(self):
        import runtime_lock
        import time
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        original_publish = self.pi.publish_install
        original_prepare = self.pi._prepare_tmp
        original_repack = self.pi.repack
        starts = []

        def unconfirmed_start(*args, **kwargs):
            marker = json.loads((self.runtime / self.notice.MARKER).read_text())
            starts.append(time.time() * 1000)
            self.assertNotIn("publishedAt", marker)
            # 新启动时间也不能确认重包前/发布前意图，旧loader无时间字段同样拒绝。
            self.assertFalse(runtime_lock.ack_restart(self.runtime, dict(marker["hashes"],
                                                                        _loadedAt=starts[-1]))["cleared"])
            self.assertFalse(runtime_lock.ack_restart(self.runtime, marker["hashes"])["cleared"])

        def prepare(*args, **kwargs):
            unconfirmed_start()
            return original_prepare(*args, **kwargs)

        def repack(*args, **kwargs):
            unconfirmed_start()
            return original_repack(*args, **kwargs)

        @contextlib.contextmanager
        def publish(runtime, installation):
            unconfirmed_start()
            with original_publish(runtime, installation):
                yield
            marker_path = self.runtime / self.notice.MARKER
            marker = json.loads(marker_path.read_text())
            self.assertEqual(marker["installation"], installation)
            self.assertTrue(self.installer.injected_status(self.pi))
            # 进程在旧入口开始、动态import却在发布后执行，也不能用新磁盘内容确认。
            for start in starts:
                self.assertFalse(runtime_lock.ack_restart(runtime, dict(marker["hashes"], _loadedAt=start))["cleared"])
            loaded = dict(marker["hashes"], _loadedAt=marker["publishedAt"] + 1)
            self.assertTrue(runtime_lock.ack_restart(runtime, loaded)["cleared"])

        for mode in ("auto", "explicit"):
            with self.subTest(mode=mode):
                self.pi.set_runtime(self.runtime)
                old = self.pi.INJECT_LINE_TMPL.format(url=(self.root / "old/inject-main.cjs").as_uri()).encode()
                self.write_asar(self.asar, entry=self.body + old + self.pi.INJECT_LINE.encode())
                starts.clear()
                os.environ["ZUSAGE_PLUGIN_AUTO_INSTALL"] = "1"
                with mock.patch.object(self.pi, "publish_install", publish), \
                        mock.patch.object(self.pi, "_prepare_tmp", side_effect=prepare), \
                        mock.patch.object(self.pi, "repack", side_effect=repack):
                    if mode == "auto":
                        self.assertEqual(self.hook()[0], {"suppressOutput": True})
                    else:
                        code, output, _ = self.main("install")
                        self.assertEqual(code, 0)
                        self.assertNotIn(self.notice.PREFIX, output)
                self.assertGreaterEqual(len(starts), 3)
                self.assertFalse((self.runtime / self.notice.MARKER).exists())
                self.assertEqual(self.hook()[0], {"suppressOutput": True})

    def test_delayed_finalize_blocks_prepublication_start_and_allows_new_boot(self):
        import runtime_lock
        import time
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        self.pi.set_runtime(self.runtime)
        old = self.pi.INJECT_LINE_TMPL.format(url=(self.root / "old/inject-main.cjs").as_uri()).encode()
        self.write_asar(self.asar, entry=self.body + old + self.pi.INJECT_LINE.encode())
        real_replace = os.replace
        def occupied(source, destination):
            if Path(destination) == self.asar:
                raise PermissionError("occupied")
            real_replace(source, destination)
        with mock.patch.object(self.pi.os, "replace", side_effect=occupied):
            code, _, _ = self.main("install")
        self.assertEqual(code, 1)
        marker_path = self.runtime / self.notice.MARKER
        before = marker_path.read_bytes()
        self.assertNotIn("publishedAt", json.loads(before))
        self.assertTrue(self.pi.TMP.exists())
        loaded = dict(json.loads(before)["hashes"], _loadedAt=time.time() * 1000)
        self.assertFalse(runtime_lock.ack_restart(self.runtime, loaded)["cleared"])
        self.assertEqual(marker_path.read_bytes(), before)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(self.pi.finalize_tmp(client_closed=lambda: True))
        published = json.loads(marker_path.read_text())
        self.assertEqual(published["createdAt"], json.loads(before)["createdAt"])
        self.assertGreater(published["publishedAt"], loaded["_loadedAt"])
        self.assertFalse(runtime_lock.ack_restart(self.runtime, loaded)["cleared"])
        self.assertIn("用户可见·重启提醒", self.notice_context(self.runtime))
        self.assertTrue(runtime_lock.ack_restart(self.runtime, dict(published["hashes"],
            _loadedAt=published["publishedAt"] + 1))["cleared"])
        self.assertEqual(self.hook()[0], {"suppressOutput": True})

    def test_published_asar_record_failure_is_conservative_not_retried(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        real_replace = os.replace
        marker_path = self.runtime / self.notice.MARKER
        def deny_publication_record(source, destination):
            if Path(destination) == marker_path and "publishedAt" in json.loads(Path(source).read_text()):
                raise OSError("publication record denied")
            real_replace(source, destination)
        with mock.patch.object(self.pi.os, "replace", side_effect=deny_publication_record):
            code, output, errors = self.main("install")
        self.assertEqual(code, 0)  # ASAR 已实际替换；不能让收尾重复 rename。
        self.assertTrue(self.installer.injected_status(self.pi))
        self.assertFalse(self.pi.TMP.exists())
        self.assertIn("publication record denied", errors)
        self.assertIn("记录无法确认", output)
        self.assertNotIn(self.notice.MESSAGE, output)
        self.assertNotIn("publishedAt", json.loads(marker_path.read_text()))

    def run_monitor_process(self, backend):
        script = r'''
import json, sys
sys.path.insert(0, sys.argv[1])
sys.argv = ["install_monitor.py", "0", sys.argv[2], sys.argv[3]]
import install_monitor as monitor
import patch_install as pi
operations = []
finalize = pi.finalize_tmp
def observed_finalize(*args, **kwargs):
    operations.append(kwargs.get("operation", "missing"))
    return finalize(*args, **kwargs)
pi.finalize_tmp = observed_finalize
monitor.zcode_pids = lambda: set()
monitor.main()
print(json.dumps(operations))
'''
        result = subprocess.run([sys.executable, "-B", "-c", script, str(backend),
                                 str(self.asar), str(self.runtime)], capture_output=True, text=True,
                                env=dict(os.environ, ZUSAGE_MONITOR_QUIET="1",
                                         PYTHONDONTWRITEBYTECODE="1"), timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout.splitlines()[-1]), [None])
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())

    def ack_process(self, backend, loaded):
        result = subprocess.run([sys.executable, "-B", str(backend / "runtime_lock.py"),
                                 "--ack-restart", str(self.runtime), json.dumps(loaded)],
                                capture_output=True, text=True,
                                env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"), timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_real_monitor_operation_none_installs_and_removes_without_false_publication(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        real_replace = os.replace
        def occupied(source, destination):
            if Path(destination) == self.asar:
                raise PermissionError("occupied")
            real_replace(source, destination)
        for backend in (PLUGIN_ROOT.parents[1], PLUGIN_ROOT):
            for operation in ("install", "remove"):
                with self.subTest(backend=backend, operation=operation):
                    self.pi.set_runtime(self.runtime)
                    entry = self.body + (self.pi.INJECT_LINE.encode() if operation == "remove" else b"")
                    self.write_asar(self.asar, entry=entry)
                    marker_path = self.runtime / self.notice.MARKER
                    if operation == "remove":
                        self.notice.record_restart(self.runtime, {"state": "pending-install", "installation": {
                            "asar": str(self.asar), "entryHash": hashlib.sha256(entry).hexdigest()}})
                    with mock.patch.object(self.pi.os, "replace", side_effect=occupied):
                        self.assertEqual(self.main(operation)[0], 1)
                    before = marker_path.read_bytes()
                    self.assertNotIn("publishedAt", json.loads(before))
                    self.run_monitor_process(backend)
                    if operation == "install":
                        marker = json.loads(marker_path.read_text())
                        self.assertIn("publishedAt", marker)
                        self.assertTrue(self.installer.injected_status(self.pi))
                        self.assertTrue(self.ack_process(backend, dict(marker["hashes"],
                            _loadedAt=marker["publishedAt"] + 1))["cleared"])
                    else:
                        self.assertEqual(marker_path.read_bytes(), before)
                        self.assertFalse(self.installer.injected_status(self.pi))

    def test_cold_sync_intent_real_monitor_then_new_start_partial_and_full_ack(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        real_replace = os.replace
        def occupied(source, destination):
            if Path(destination) == self.asar:
                raise PermissionError("occupied")
            real_replace(source, destination)
        for backend in (PLUGIN_ROOT.parents[1], PLUGIN_ROOT):
            with self.subTest(backend=backend):
                self.write_asar(self.asar)
                with mock.patch.object(self.pi.os, "replace", side_effect=occupied):
                    self.assertEqual(self.main("install")[0], 1)
                marker_path = self.runtime / self.notice.MARKER
                intent = json.loads(marker_path.read_text())["installation"]
                for name in ("inject-main.cjs", "plugin-storage.cjs"):
                    source = self.plugin / name
                    source.write_bytes(source.read_bytes() + b"\n// test cold sync before monitor\n")
                self.installer.sync_runtime(self.runtime)
                merged = json.loads(marker_path.read_text())
                self.assertEqual(merged["state"], "pending-sync")
                self.assertEqual(merged["installation"], intent)
                self.assertNotIn("publishedAt", merged)
                self.assertFalse(self.ack_process(backend, dict(merged["hashes"],
                    _loadedAt=merged["createdAt"] * 1000 + 1))["cleared"])
                self.run_monitor_process(backend)
                published = json.loads(marker_path.read_text())
                self.assertEqual(published["state"], "pending-sync")
                self.assertEqual(published["installation"], intent)
                self.assertEqual(published["hashes"], merged["hashes"])
                self.assertIn("publishedAt", published)
                start = published["publishedAt"] + 1
                self.assertIn("用户可见·重启提醒", self.notice_context(self.runtime))
                acknowledged_name = next(iter(published["hashes"]))
                partial_loaded = {"_loadedAt": start, acknowledged_name: published["hashes"][acknowledged_name]}
                self.assertFalse(self.ack_process(backend, partial_loaded)["cleared"])
                partial = json.loads(marker_path.read_text())
                self.assertEqual(partial["installation"], intent)
                self.assertEqual(partial["publishedAt"], published["publishedAt"])
                self.assertEqual(partial["hashes"], {name: digest for name, digest in published["hashes"].items()
                                                  if name != acknowledged_name})
                self.assertTrue(self.ack_process(backend, dict(partial["hashes"], _loadedAt=start))["cleared"])
                self.assertFalse(marker_path.exists())
                self.assertEqual(self.hook()[0], {"suppressOutput": True})

    def test_failed_publication_keeps_intent_without_claiming_installed(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        os.environ["ZUSAGE_PLUGIN_AUTO_INSTALL"] = "1"
        real_replace = os.replace
        before = self.asar.read_bytes()

        def deny_publication(source, destination):
            if Path(destination) == self.asar:
                self.assertEqual(json.loads((self.runtime / self.notice.MARKER).read_text())["state"],
                                 "pending-install")
                raise OSError("asar denied")
            real_replace(source, destination)

        with mock.patch.object(self.pi.os, "replace", side_effect=deny_publication):
            result, _ = self.hook()
        self.assertEqual(self.asar.read_bytes(), before)
        self.assertIn("自动安装未完成", result["systemMessage"])
        self.assertNotIn("已安装或更新", result["systemMessage"])
        self.assertIn("用户可见·安装提醒", self.notice_context(self.runtime))
        self.assertEqual(json.loads((self.runtime / self.notice.MARKER).read_text())["state"],
                         "pending-install")
        self.assertEqual(self.main("install")[0], 0)  # 同一意图可由正常重试完成。
        self.assertIn("用户可见·重启提醒", self.notice_context(self.runtime))

    def test_intent_write_failure_blocks_even_pending_tmp_publication(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        os.environ["ZUSAGE_PLUGIN_AUTO_INSTALL"] = "1"
        before = self.asar.read_bytes()
        self.installer.resolve_paths()
        self.installer.sync_runtime(self.runtime)
        with mock.patch.object(self.notice, "record_restart", side_effect=OSError("intent denied")), \
                mock.patch.object(self.pi, "_prepare_tmp") as prepare:
            result, _ = self.hook()
        prepare.assert_not_called()
        self.assertEqual(self.asar.read_bytes(), before)
        self.assertFalse(self.pi.TMP.exists())
        self.assertFalse(self.pi.TMP_META.exists())
        self.assertNotIn("已安装或更新", result["systemMessage"])

    def test_before_publish_callback_is_optional_and_skipped_for_noop(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        self.installer.resolve_paths()
        self.installer.sync_runtime(self.runtime)
        callback = mock.Mock()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(self.pi.install(before_publish=callback))
            callback.assert_called_once_with({"asar": str(self.asar),
                "entryHash": hashlib.sha256(self.pi.entry_bytes_of(self.asar)).hexdigest()})
            callback.reset_mock()
            self.assertTrue(self.pi.install(before_publish=callback))
            callback.assert_not_called()
            self.assertTrue(self.pi.install())

    def test_existing_injection_cold_update_notice_wins_over_noop_log(self):
        os.environ["ZUSAGE_PLUGIN_ASAR"] = str(self.asar)
        self.assertEqual(self.main("install")[0], 0)
        helper = load_module("noop_runtime_lock", PLUGIN_ROOT / "runtime_lock.py")
        marker = json.loads((self.runtime / self.notice.MARKER).read_text())
        self.assertTrue(helper.ack_restart(self.runtime, dict(marker["hashes"],
                          _loadedAt=marker.get("publishedAt", marker["createdAt"] * 1000) + 1))["cleared"])
        loader = self.plugin / "plugin-updater.cjs"
        loader.write_bytes(loader.read_bytes() + b"\n// test cold update\n")
        # 该文件为验收器，运行时验收使用同步前的可信快照。
        code, output, _ = self.main("install")
        self.assertEqual(code, 0)
        self.assertIn("已安装，注入行已指向当前目录", output)
        self.assertIn(self.notice.MESSAGE, output)
        marker = json.loads((self.runtime / self.notice.MARKER).read_text())
        self.assertTrue(helper.ack_restart(self.runtime, dict(marker["hashes"],
                          _loadedAt=marker.get("publishedAt", marker["createdAt"] * 1000) + 1))["cleared"])
        code, output, _ = self.main("install")
        self.assertEqual(code, 0)
        self.assertIn("已安装，注入行已指向当前目录", output)
        self.assertNotIn(self.notice.PREFIX, output)
        self.assertFalse((self.runtime / self.notice.MARKER).exists())

    def test_hook_existing_valid_target_backfills_config_without_enabling_auto(self):
        self.pi.set_runtime(self.runtime)
        self.write_asar(self.asar, entry=self.body + self.pi.INJECT_LINE.encode())
        os.environ["ZCODE_ASAR"] = str(self.asar)
        result, _ = self.hook()
        self.assertIn("重启 ZCode", result["systemMessage"])
        self.assertEqual(self.config(), {"python_path": sys.executable, "asar_path": str(self.asar)})
        self.pi.launch_monitor.assert_not_called()

    def test_hook_starts_update_after_sync_even_without_target(self):
        def assert_runtime_ready(runtime, pi):
            self.assertTrue((runtime / "plugin-runtime.json").exists())
            self.assertTrue((runtime / "plugin-updater.cjs").exists())
            self.assertIsNone(pi.ASAR)

        self.updater.start_auto_update.side_effect = assert_runtime_ready
        result, _ = self.hook()
        self.assertEqual(result, {"suppressOutput": True})
        self.updater.start_auto_update.assert_called_once_with(self.runtime, self.pi)
        self.assertFalse((self.runtime / "config.json").exists())

    def test_update_failure_does_not_block_optin_overlay_install(self):
        self.write_config({"asar_path": str(self.asar), "plugin_auto_install_overlay": True})
        self.updater.start_auto_update.side_effect = RuntimeError("update unavailable")
        result, errors = self.hook()
        self.assertIn("用量状态条已安装或更新", result["systemMessage"])
        self.assertIn("update unavailable", errors)
        self.assertTrue(self.installer.injected_status(self.pi))

    def test_hook_starts_update_when_current_injection_is_already_valid(self):
        self.write_config({"asar_path": str(self.asar)})
        self.assertEqual(self.main("install")[0], 0)
        result, _ = self.hook()
        self.assertEqual(result["hookSpecificOutput"]["hookEventName"], "SessionStart")
        self.assertIn("完全退出 ZCode", result["systemMessage"])
        self.updater.start_auto_update.assert_called_once_with(self.runtime, self.pi)
        self.pi.launch_monitor.assert_called_once()

    def test_windows_candidates_cover_custom_drive_program_files(self):
        # 回归：ZCode 装在 D:\Program Files\ZCode 等非默认位置时探测不到，
        # 只能靠手工设 ZCODE_ASAR（1.4.2 Windows 实机问题）。盘符只枚举本地固定盘。
        # setUp 把 asar_candidates 打成恒空以隔离真机探测，这里用保存的真实实现。
        with mock.patch.object(self.installer.sys, "platform", "win32"), \
                mock.patch.object(self.installer, "fixed_drives", return_value=["D", "E"]) as fixed:
            candidates = self.real_candidates()
        fixed.assert_called_once_with("DEFGHIJKLMNOPQRSTUVWXYZ")
        self.assertIn(Path("D:/Program Files/ZCode/resources/app.asar"), candidates)
        self.assertIn(Path("D:/Programs/ZCode/resources/app.asar"), candidates)
        self.assertIn(Path("E:/ZCode/resources/app.asar"), candidates)
        self.assertNotIn(Path("F:/ZCode/resources/app.asar"), candidates)

    def test_fixed_drives_skip_network_removable_and_missing_drives(self):
        # 离线映射网络盘一被访问就触发重连，光驱/读卡器可能无介质：只保留 DRIVE_FIXED(3)。
        kinds = {"D:\\": 3, "E:\\": 4, "F:\\": 2}   # 固定/网络/可移动；其余 1=DRIVE_NO_ROOT_DIR
        kernel32 = mock.Mock()
        kernel32.GetDriveTypeW.side_effect = lambda root: kinds.get(root, 1)
        with mock.patch.object(ctypes, "windll", mock.Mock(kernel32=kernel32), create=True):
            self.assertEqual(self.installer.fixed_drives("DEFG"), ["D"])


if __name__ == "__main__":
    unittest.main()
