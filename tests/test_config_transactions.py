# -*- coding: utf-8 -*-
import json
import os
import stat
from unittest import mock
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runtime_lock


@unittest.skipIf(os.name == "nt", "update_enhance_provider 在 Windows 有意 fail-closed（POSIX 安全落盘），直接调用恒 raise")
class EnhanceProviderTransactionTests(unittest.TestCase):
    """POSIX 专属路径的直接调用覆盖；Windows 行为由 EnhanceProviderCliExitCodeTests 在平台门上覆盖。"""

    def test_save_revision_key_actions_and_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            first = runtime_lock.update_enhance_provider(runtime, 0, {
                "mode": "custom", "source": "manual", "baseUrl": "https://example.test/v1",
                "protocol": "openai-chat-completions", "model": "model-a",
                "keyAction": "replace", "apiKey": "secret-fixture"})
            self.assertEqual(first["revision"], 1)
            second = runtime_lock.update_enhance_provider(runtime, 1, {"model": "model-b", "keyAction": "keep"})
            self.assertEqual(second["apiKey"], "secret-fixture")
            with self.assertRaises(ValueError):
                runtime_lock.update_enhance_provider(runtime, 1, {"model": "stale", "keyAction": "keep"})
            self.assertEqual(json.loads((runtime / "enhance-provider.json").read_text())["model"], "model-b")
            third = runtime_lock.update_enhance_provider(runtime, 2, {"keyAction": "clear"})
            self.assertNotIn("apiKey", third)
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE((runtime / "enhance-provider.json").stat().st_mode), 0o600)

    def test_changing_protocol_does_not_reuse_saved_key(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            runtime_lock.update_enhance_provider(runtime, 0, {
                "mode": "custom", "source": "manual", "baseUrl": "https://example.test/v1",
                "protocol": "openai-chat-completions", "keyAction": "replace", "apiKey": "secret-fixture"})
            updated = runtime_lock.update_enhance_provider(runtime, 1, {
                "protocol": "openai-responses", "keyAction": "keep"})
            self.assertNotIn("apiKey", updated)

    def test_save_history_boolean_persisted_and_type_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            updated = runtime_lock.update_enhance_provider(runtime, 0, {"saveHistory": True})
            self.assertIs(updated["saveHistory"], True)
            with self.assertRaises(ValueError):
                runtime_lock.update_enhance_provider(runtime, 1, {"saveHistory": "on"})

    def test_allow_downgrade_boolean_persisted_and_type_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            updated = runtime_lock.update_enhance_provider(runtime, 0, {"allowDowngrade": False})
            self.assertIs(updated["allowDowngrade"], False)
            with self.assertRaises(ValueError):
                runtime_lock.update_enhance_provider(runtime, 1, {"allowDowngrade": "yes"})

    def test_corrupt_or_symlink_configuration_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "enhance-provider.json"
            config.write_text("{broken", encoding="utf-8")
            with self.assertRaises(ValueError):
                runtime_lock.update_enhance_provider(runtime, 0, {"keyAction": "keep"})
            self.assertEqual(config.read_text(), "{broken")
            if hasattr(os, "symlink") and os.name != "nt":
                config.unlink()
                target = runtime / "target"
                target.write_text("untouched")
                config.symlink_to(target)
                with self.assertRaises((OSError, ValueError)):
                    runtime_lock.update_enhance_provider(runtime, 0, {"keyAction": "keep"})
                self.assertEqual(target.read_text(), "untouched")


class EnhanceProviderWindowsGateTests(unittest.TestCase):
    """Windows 平台门守护：update_enhance_provider 在 nt 恒 raise。上面的 POSIX 直调类
    在 Windows 被 skip，若平台门被删则「门+skip」组合在 Windows 零覆盖（变异实证）——
    本类在 nt 实跑、POSIX 跳过，删门即红。"""

    @unittest.skipIf(os.name != "nt", "仅 Windows 平台门")
    def test_update_enhance_provider_fails_closed_on_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                runtime_lock.update_enhance_provider(Path(directory), 0, {"keyAction": "keep"})


class EnhanceProviderCliExitCodeTests(unittest.TestCase):
    """CLI 退出码传播契约（两平台都跑，无平台跳过）：Windows 上 --update-enhance-provider
    走平台门 fail-closed（raise → ok:false JSON + 退出码 1 + 配置不动），POSIX 上走
    revision 冲突路径——断言的失败传播契约相同。"""

    def test_cli_conflict_exits_nonzero(self):
        # 回归：main() 的 return 1 曾未传播为退出码，主进程把事务失败当成功（假 ok:true）
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "enhance-provider.json"
            config.write_text(json.dumps({"version": 1, "revision": 0, "mode": "default"}), encoding="utf-8")
            if os.name != "nt":
                config.chmod(0o600)
            done = subprocess.run(
                [sys.executable, str(ROOT / "runtime_lock.py"), "--update-enhance-provider", str(runtime)],
                input=json.dumps({"revision": 999999, "changes": {"keyAction": "keep"}}),
                capture_output=True, text=True, timeout=15)
            self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
            self.assertFalse(json.loads(done.stdout)["ok"])
            self.assertEqual(json.loads(config.read_text())["revision"], 0)


class ConfigTransactionTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_existing_config_mode_and_owner_survive_atomic_merge(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            config.write_text('{"plugin_auto_update":false}')
            config.chmod(0o644)
            before = config.stat()
            runtime_lock.update_config(runtime, {"answer_rate_line": False})
            after = config.stat()
            self.assertEqual(stat.S_IMODE(after.st_mode), 0o644)
            self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))

    def test_installer_returns_config_and_lock_to_user_on_every_update(self):
        import install
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            with mock.patch.object(install, "chown_to_user") as chown:
                install.update_runtime_config(runtime, {"asar_path": "fixture.asar"})
            self.assertEqual(chown.call_args_list,
                             [mock.call(runtime), mock.call(runtime / "config.json"),
                              mock.call(runtime / "plugin-config.lock")])
            config = json.loads((runtime / "config.json").read_text())
            self.assertEqual(config, {"asar_path": "fixture.asar"})

    def test_changes_and_defaults_preserve_explicit_opt_out(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            config.write_text('{"plugin_auto_update": false, "python_path": "custom"}', encoding="utf-8")
            runtime_lock.update_config(runtime, {"asar_path": "fixture.asar"},
                                       {"python_path": "fallback", "plugin_auto_update": True})
            self.assertEqual(json.loads(config.read_text()), {
                "plugin_auto_update": False, "python_path": "custom", "asar_path": "fixture.asar"})

    def test_corrupt_or_nonobject_config_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            for value in ("{broken", "[]", "null", "true"):
                config.write_text(value, encoding="utf-8")
                with self.assertRaises(ValueError):
                    runtime_lock.update_config(runtime, {"plugin_auto_update": True})
                self.assertEqual(config.read_text(), value)

    def test_cli_writers_wait_for_lock_and_merge_latest_config(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            config.write_text('{"plugin_auto_update": true}', encoding="utf-8")
            children = []
            with runtime_lock.file_lock(runtime / "plugin-config.lock"):
                for changes in ({"asar_path": "fixture.asar"}, {"answer_rate_line": False}):
                    child = subprocess.Popen([sys.executable, str(ROOT / "runtime_lock.py"),
                                              "--update-config", str(runtime)], stdin=subprocess.PIPE,
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    child.stdin.write(json.dumps({"changes": changes}))
                    child.stdin.close()
                    child.stdin = None
                    children.append(child)
                config.write_text('{"plugin_auto_update": false, "remote": {"enabled": true}}', encoding="utf-8")
            for child in children:
                out, err = child.communicate(timeout=15)
                self.assertEqual(child.returncode, 0, err)
                self.assertTrue(json.loads(out)["ok"])
            self.assertEqual(json.loads(config.read_text()), {
                "plugin_auto_update": False, "remote": {"enabled": True},
                "asar_path": "fixture.asar", "answer_rate_line": False})


class BoundedTempPrimitivesTests(unittest.TestCase):
    """issue #360 深化：runtime_lock.bounded_mkstemp / bounded_tempdir 与 token_rate
    临时文件创建的单次快错、碰撞上限与清理容错。"""

    def test_bounded_tempdir_fails_fast_on_permission_error_and_caps_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            attempts = {"n": 0}

            def denied(path, *args, **kwargs):
                attempts["n"] += 1
                raise PermissionError(5, "denied", str(path))

            with mock.patch.object(runtime_lock.os, "mkdir", side_effect=denied):
                with self.assertRaises(PermissionError):
                    with runtime_lock.bounded_tempdir(prefix="zusage-t-", dir=directory):
                        pass
            self.assertEqual(attempts["n"], 1)

            collisions = {"n": 0}

            def occupied(path, *args, **kwargs):
                collisions["n"] += 1
                raise FileExistsError(17, "exists", str(path))

            with mock.patch.object(runtime_lock.os, "mkdir", side_effect=occupied):
                with self.assertRaises(FileExistsError):
                    with runtime_lock.bounded_tempdir(prefix="zusage-t-", dir=directory):
                        pass
            self.assertEqual(collisions["n"], 16)

    def test_bounded_tempdir_tolerates_cleanup_oserror(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(runtime_lock.shutil, "rmtree",
                                   side_effect=PermissionError(32, "used by another process")):
                with runtime_lock.bounded_tempdir(prefix="zusage-t-", dir=directory) as created:
                    self.assertTrue(Path(created).is_dir())
            runtime_lock.shutil.rmtree(created, ignore_errors=True)

    def test_write_session_state_tolerates_unlink_permission_error(self):
        import token_rate
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "state.json"
            with mock.patch.object(token_rate, "STATE_FILE", str(state_file)), \
                    mock.patch.object(token_rate, "_replace_state_file",
                                      side_effect=PermissionError(5, "replace denied")), \
                    mock.patch.object(token_rate.os, "unlink",
                                      side_effect=PermissionError(32, "sharing violation")):
                token_rate.write_session_state("sess_1", "prompt-submit")

    def test_marker_and_pending_zip_and_overlay_atomic_write_fail_fast_and_tolerate_unlink_error(self):
        import pending_zip_patch
        from tests.test_bridge_pending import load_installer
        installer = load_installer()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / ".marker.json"
            with mock.patch.object(runtime_lock.os, "replace",
                                   side_effect=PermissionError(5, "replace denied")), \
                    mock.patch.object(runtime_lock.os, "unlink",
                                      side_effect=PermissionError(32, "sharing violation")):
                with self.assertRaises(PermissionError) as ctx:
                    runtime_lock._write_marker(marker, {"ok": True})
                self.assertEqual(ctx.exception.errno, 5)
            with mock.patch.object(pending_zip_patch.os, "replace",
                                   side_effect=PermissionError(5, "replace denied")), \
                    mock.patch.object(Path, "unlink",
                                      side_effect=PermissionError(32, "sharing violation")):
                with self.assertRaises(PermissionError) as ctx:
                    pending_zip_patch.save_state(root, {"files": {}})
                self.assertEqual(ctx.exception.errno, 5)
            dst = root / "overlay.js"
            with mock.patch.object(installer.os, "replace",
                                   side_effect=PermissionError(5, "replace denied")), \
                    mock.patch.object(Path, "unlink",
                                      side_effect=PermissionError(32, "sharing violation")):
                with self.assertRaises(PermissionError) as ctx:
                    installer._atomic_write(dst, b"payload")
                self.assertEqual(ctx.exception.errno, 5)


if __name__ == "__main__":
    unittest.main()
