# -*- coding: utf-8 -*-
from contextlib import ExitStack
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


class EnhanceProviderTransactionTests(unittest.TestCase):
    """直接调用覆盖（issue #442 起 Windows 平台门移除，两平台同跑）：uid/0600 语义
    POSIX 专属、Windows 随 profile 目录 ACL（quota-secrets.json 同款取舍）。"""

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


class EnhanceProviderCliExitCodeTests(unittest.TestCase):
    """CLI 退出码传播契约（两平台都跑，无平台跳过）：issue #442 后两平台都走
    revision 冲突路径（raise → ok:false JSON + 退出码 1 + 配置不动），断言相同。"""

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

    def test_merge_preserves_unknown_keys_and_replaces_only_direct_children(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            config.write_text(json.dumps({
                "unknown": {"enabled": False},
                "mobile_relay": {"enabled": False, "keep": {"nested": 1},
                                 "transport": {"old": True}},
                "literal.enabled": {"keep": True},
            }), encoding="utf-8")
            merge = {"mobile_relay": {"enabled": True, "transport": {"new": True}},
                     "literal.enabled": {"value": False}}
            before = json.dumps(merge)
            self.assertTrue(runtime_lock.update_config(runtime, {}, merge=merge))
            self.assertEqual(json.loads(config.read_text()), {
                "unknown": {"enabled": False},
                "mobile_relay": {"enabled": True, "keep": {"nested": 1},
                                 "transport": {"new": True}},
                "literal.enabled": {"keep": True, "value": False},
            })
            self.assertEqual(json.dumps(merge), before)
            with mock.patch.object(runtime_lock, "_write_marker") as write:
                self.assertFalse(runtime_lock.update_config(runtime, {}, merge=merge))
            write.assert_not_called()

    def test_merge_persists_boolean_values_even_when_legacy_numbers_compare_equal(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            for old, new in ((0, False), (1, True), (0.0, False), (1.0, True),
                             ({"enabled": 1}, {"enabled": True})):
                with self.subTest(old=old, new=new):
                    config.write_text(json.dumps({"mobile_relay": {"enabled": old, "keep": 1}}),
                                      encoding="utf-8")
                    merge = {"mobile_relay": {"enabled": new}}
                    self.assertTrue(runtime_lock.update_config(runtime, {}, merge=merge))
                    value = json.loads(config.read_text())["mobile_relay"]["enabled"]
                    self.assertEqual(json.dumps(value), json.dumps(new))
                    self.assertFalse(runtime_lock.update_config(runtime, {}, merge=merge))
            # The old top-level-only API keeps its existing equality/no-op behavior.
            config.write_text('{"legacy": 0}', encoding="utf-8")
            self.assertFalse(runtime_lock.update_config(runtime, {"legacy": False}))
            self.assertEqual(config.read_text(), '{"legacy": 0}')

    def test_merge_uses_empty_object_for_missing_or_nonobject_old_field(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            for current in ({}, *({"mobile_relay": value}
                                 for value in (None, False, True, 0, "legacy", [], [1]))):
                with self.subTest(current=current):
                    config.write_text(json.dumps(dict(current, unknown=False)), encoding="utf-8")
                    self.assertTrue(runtime_lock.update_config(
                        runtime, {}, merge={"mobile_relay": {"enabled": False}}))
                    self.assertEqual(json.loads(config.read_text()), {
                        "unknown": False, "mobile_relay": {"enabled": False}})
            config.unlink()
            self.assertTrue(runtime_lock.update_config(
                runtime, {}, merge={"mobile_relay": {"enabled": True}}))
            self.assertEqual(json.loads(config.read_text()), {"mobile_relay": {"enabled": True}})

    def test_merge_follows_existing_top_level_changes_and_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            config.write_text(json.dumps({
                "plugin_auto_update": False, "python_path": "custom", "unknown": 1,
                "mobile_relay": {"old": True},
            }), encoding="utf-8")
            changes = {"mobile_relay": {"replacement": True}, "python_path": "changed"}
            defaults = {"mobile_relay": {"default": True}, "plugin_auto_update": True,
                        "new_group": {"keep": True}}
            self.assertTrue(runtime_lock.update_config(runtime, changes, defaults, {
                "mobile_relay": {"enabled": True}, "new_group": {"enabled": False}}))
            self.assertEqual(json.loads(config.read_text()), {
                "plugin_auto_update": False, "python_path": "changed", "unknown": 1,
                "mobile_relay": {"replacement": True, "enabled": True},
                "new_group": {"keep": True, "enabled": False},
            })
            # No merge argument: an object-valued changes entry still replaces the whole field.
            self.assertTrue(runtime_lock.update_config(runtime, {"mobile_relay": {"enabled": False}}))
            self.assertEqual(json.loads(config.read_text())["mobile_relay"], {"enabled": False})
            self.assertFalse(runtime_lock.update_config(runtime, {}, defaults, None))

    def test_invalid_update_types_fail_without_writing_config(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            before = '{"unknown": true, "mobile_relay": {"keep": 1}}'
            config.write_text(before, encoding="utf-8")
            invalid = []
            for value in (None, [], False, 1, "bad"):
                invalid.append((value, None, None))
                if value is not None:
                    invalid.extend([({}, value, None), ({}, None, value)])
                invalid.append(({}, None, {"mobile_relay": value}))
            invalid.extend([({}, None, {1: {}}), ({}, None, {"mobile_relay": {1: True}})])
            for key in ("__proto__", "constructor", "prototype"):
                invalid.extend([({}, None, {key: {"enabled": True}}),
                                ({}, None, {"mobile_relay": {key: True}})])
            for changes, defaults, merge in invalid:
                with self.subTest(changes=changes, defaults=defaults, merge=merge):
                    with self.assertRaises(ValueError):
                        runtime_lock.update_config(runtime, changes, defaults, merge)
                    self.assertEqual(config.read_text(), before)

    def test_corrupt_or_nonobject_config_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            config = runtime / "config.json"
            for value in ("{broken", "[]", "null", "true"):
                for merge in (None, {"mobile_relay": {"enabled": True}}):
                    with self.subTest(config=value, merge=merge):
                        config.write_text(value, encoding="utf-8")
                        with self.assertRaises(ValueError):
                            runtime_lock.update_config(runtime, {"plugin_auto_update": True}, merge=merge)
                        self.assertEqual(config.read_text(), value)

    def test_cli_merge_writers_read_latest_nested_config_inside_lock(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as children:
            runtime = Path(directory)
            config = runtime / "config.json"
            config.write_text('{"mobile_relay": {"enabled": false, "keep": "stale"}}', encoding="utf-8")
            writers = []
            with runtime_lock.file_lock(runtime / "plugin-config.lock"):
                for merge in ({"mobile_relay": {"enabled": True}},
                              {"mobile_relay": {"other_writer": True}}):
                    # Signal immediately before attempting the lock; no timing sleeps or stale snapshots.
                    code = ("import sys; sys.path.insert(0, sys.argv[1]); import runtime_lock; "
                            "original = runtime_lock.file_lock; "
                            "runtime_lock.file_lock = lambda path: "
                            "(print('waiting', flush=True), original(path))[1]; "
                            "sys.argv = [sys.argv[0], '--update-config', sys.argv[2]]; runtime_lock.main()")
                    child = children.enter_context(subprocess.Popen(
                        [sys.executable, "-B", "-c", code, str(ROOT), str(runtime)], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
                    children.callback(lambda child=child: child.kill() if child.poll() is None else None)
                    child.stdin.write(json.dumps({"changes": {}, "merge": merge}))
                    child.stdin.close()
                    child.stdin = None
                    self.assertEqual(child.stdout.readline().strip(), "waiting")
                    writers.append(child)
                config.write_text(json.dumps({
                    "unknown": {"fresh": True}, "plugin_auto_update": False,
                    "mobile_relay": {"enabled": False, "keep": "latest", "nested": {"latest": 1}},
                }), encoding="utf-8")
            for child in writers:
                out, err = child.communicate(timeout=15)
                self.assertEqual(child.returncode, 0, err)
                self.assertEqual(json.loads(out), {"ok": True, "changed": True})
            self.assertEqual(json.loads(config.read_text()), {
                "unknown": {"fresh": True}, "plugin_auto_update": False,
                "mobile_relay": {"enabled": True, "keep": "latest", "nested": {"latest": 1},
                                 "other_writer": True},
            })

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

    def test_bounded_mkstemp_fails_fast_on_permission_error_and_caps_collisions(self):
        # patch_install 等模块经 from runtime_lock import bounded_mkstemp 共用本实现，
        # 这里直接钉 runtime_lock 侧：PermissionError 第一次就原样抛出（Windows ACL
        # 快错），换名重试正是 issue #360 的挂起机制；只有 FileExistsError 才重试
        # 至多 16 次（断言字面量，防同义反复）。
        with tempfile.TemporaryDirectory() as directory:
            attempts = {"n": 0}

            def denied(path, flags, *args, **kwargs):
                attempts["n"] += 1
                raise PermissionError(5, "denied", str(path))

            with mock.patch.object(runtime_lock.os, "open", side_effect=denied):
                with self.assertRaises(PermissionError):
                    runtime_lock.bounded_mkstemp(prefix="zusage-m-", dir=directory)
            self.assertEqual(attempts["n"], 1)

            collisions = {"n": 0}

            def occupied(path, flags, *args, **kwargs):
                collisions["n"] += 1
                raise FileExistsError(17, "exists", str(path))

            with mock.patch.object(runtime_lock.os, "open", side_effect=occupied):
                with self.assertRaises(FileExistsError):
                    runtime_lock.bounded_mkstemp(prefix="zusage-m-", dir=directory)
            self.assertEqual(collisions["n"], 16)

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

    def test_marker_write_retries_a_bounded_number_of_times_while_pending_zip_and_overlay_writes_fail_fast(self):
        """三处原子写都被拒、临时文件又删不掉：标记写入为并发读者短暂重试（次数有界，仍以原异常
        上抛），待更新包与渲染桥的原子写第一次被拒就上抛；清理失败都不盖住原因。"""
        import pending_zip_patch
        from tests.test_bridge_pending import load_installer
        installer = load_installer()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / ".marker.json"
            attempts = []

            def denied_replace(source, target):
                attempts.append(target)
                raise PermissionError(5, "replace denied")

            with mock.patch.object(runtime_lock.os, "replace", side_effect=denied_replace), \
                 mock.patch.object(runtime_lock.os, "unlink",
                                   side_effect=PermissionError(32, "sharing violation")), \
                 mock.patch.object(runtime_lock.time, "sleep") as sleep:
                with self.assertRaises(PermissionError) as ctx:
                    runtime_lock._write_marker(marker, {"ok": True})
                self.assertEqual(ctx.exception.errno, 5)
            self.assertEqual(len(attempts), 20)   # 钉字面值：重试预算调小要在这里变红
            self.assertEqual(sleep.call_count, 19)
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
