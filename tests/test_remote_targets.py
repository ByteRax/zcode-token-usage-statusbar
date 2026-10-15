# -*- coding: utf-8 -*-
"""远端查询回归：所有客户端状态、数据库和通道均隔离，不连接网络。"""
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("zusage_remote_test", ROOT / "zusage.py")
zusage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(zusage)

A = "remote:ssh:a:22:u:/p"
B = "remote:ssh:b:22:u:/p"


def entry(host, path="/p"):
    return {"kind": "remote", "workspacePath": path,
            "target": {"kind": "ssh", "host": host, "username": "u"}}


def write_setting(root, payload):
    path = Path(root) / ".zcode" / "v2" / "setting.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    zusage._CLIENT_STATE_CACHE["sig"] = None
    return path


class IsolatedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patches = [mock.patch.dict(os.environ, {"ZCODE_DESKTOP_HOME_DIR": self.tmp.name,
                                               "ZUSAGE_REMOTE_CHILD": "0"}),
                   mock.patch.object(subprocess, "Popen", side_effect=AssertionError("network/process forbidden")),
                   mock.patch.object(zusage, "_load_lang", return_value="zh")]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        zusage._CLIENT_STATE_CACHE.update(sig=None, entries=[])
        zusage._REMOTE_NEG.clear()
        zusage._AGG_CACHE.clear()
        self.addCleanup(zusage._REMOTE_NEG.clear)
        self.addCleanup(zusage._AGG_CACHE.clear)

    def setup_targets(self):
        return zusage._remote_setup({"remote": {"auto": False, "enabled": True, "targets": [
            {"ssh": ["ssh", "u@a"], "identity": A},
            {"ssh": ["ssh", "u@b"], "identity": B}]}})


class DiscoveryTests(IsolatedTests):
    def test_real_dot_zcode_path_and_home_trim(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("A")]})
        with mock.patch.dict(os.environ, {"ZCODE_DESKTOP_HOME_DIR": " " + self.tmp.name + " "}):
            self.assertEqual(zusage._desktop_setting_path(), Path(self.tmp.name) / ".zcode/v2/setting.json")
            self.assertEqual(zusage._auto_targets({})[0]["identities"], [A])

    def test_legacy_history_and_reference(self):
        legacy = dict(entry("a"), id="old")
        for payload in ({"remoteWorkspaceHistory": [legacy]},
                        {"lastWorkspaceSession": [{"kind": "remote", "historyId": "old"}],
                         "remoteWorkspaceHistory": [legacy]}):
            write_setting(self.tmp.name, payload)
            self.assertEqual(zusage._auto_targets({})[0]["identities"], [A])

    def test_merge_and_password_skip(self):
        pwd = entry("password")
        pwd["target"]["passwordCredentialKey"] = "secret-ref"
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("A"), entry("a", "/other"), pwd]})
        rows = zusage._auto_targets({})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ssh_argv"], ["ssh", "-o", "BatchMode=yes", "u@A"])
        self.assertEqual(len(rows[0]["identities"]), 2)

    def test_legacy_test_actually_uses_legacy_key(self):
        alias = entry("a")
        alias["target"].update(sshConfigAlias="alias", privateKeyPath="/key")
        write_setting(self.tmp.name, {"remoteWorkspaceHistory": [alias]})
        self.assertEqual(zusage._auto_targets({})[0]["ssh_argv"], ["ssh", "-o", "BatchMode=yes", "alias"])

    def test_bad_json_shape_and_deleted_setting(self):
        path = write_setting(self.tmp.name, [])
        self.assertEqual(zusage._auto_targets({}), [])
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("a")]})
        self.assertEqual(len(zusage._auto_targets({})), 1)
        path.unlink()
        self.assertEqual(zusage._auto_targets({}), [])


class SetupTests(IsolatedTests):
    def test_empty_auto_does_not_read_real_home(self):
        self.assertIsNone(zusage._remote_setup({}))

    def test_enabled_false_disables_legacy_ssh_not_auto(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("a")]})
        setup = zusage._remote_setup({"remote": {"enabled": False, "ssh": "ssh placeholder"}})
        self.assertEqual(len(setup["targets"]), 1)
        self.assertIsNone(setup["default"])
        self.assertIsNone(zusage._remote_setup({"remote": {"enabled": False, "auto": False,
                                                           "targets": [{"ssh": "ssh a", "identity": A}]}}))

    def test_targets_available_in_auto_and_manual_and_override(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("a")]})
        for enabled in (False, True):
            setup = zusage._remote_setup({"remote": {"enabled": enabled, "python": "/venv/python",
                "script": "~/custom usage.py", "timeout_s": 3,
                "targets": [{"ssh": "ssh override", "identities": [A]}]}})
            rc = setup["targets"][setup["identities"][A]]
            self.assertEqual(rc["ssh_argv"], ["ssh", "override"])
            self.assertEqual((rc["python"], rc["script"], rc["timeout_s"]), ("/venv/python", "~/custom usage.py", 3))

    def test_stable_key_after_insert_remove_reorder_workspace(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("b")]})
        before = zusage._remote_setup({})["identities"][B]
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("a"), entry("b", "/z"), entry("b")]})
        self.assertEqual(zusage._remote_setup({})["identities"][B], before)
        one = {"ssh": "ssh a", "identity": A}
        two = {"ssh": "ssh b", "identity": B}
        s1 = zusage._remote_setup({"remote": {"enabled": True, "auto": False, "targets": [one, two]}})
        s2 = zusage._remote_setup({"remote": {"enabled": True, "auto": False, "targets": [two, one]}})
        self.assertEqual(s1["identities"], s2["identities"])

    def test_recursion_guard_covers_manual_and_auto(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("a")]})
        with mock.patch.dict(os.environ, {"ZUSAGE_REMOTE_CHILD": "1"}):
            for cfg in ({}, {"remote": {"enabled": True, "ssh": "ssh a"}},
                        {"remote": {"targets": [{"ssh": "ssh a", "identity": A}]}}):
                self.assertIsNone(zusage._remote_setup(cfg))

    def test_bad_target_does_not_disable_healthy_target(self):
        setup = zusage._remote_setup({"remote": {"targets": [
            {"identity": A}, {"ssh": "ssh broken", "timeout_s": "invalid"},
            {"ssh": "ssh good", "identity": B}]}})
        self.assertEqual(len(setup["targets"]), 1)


class ExecTests(IsolatedTests):
    def rc(self, channel=None, **kwargs):
        return zusage._normalize_remote_entry({"ssh": channel or ["ssh", "box"], **kwargs})

    def test_ssh_command_is_shell_quoted_and_tilde_keeps_home(self):
        rc = self.rc(script="~/folder/usage 'quoted'; touch nope.py", python="/path with space/python")
        with mock.patch.object(zusage.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b'{"recent":[]}\n', b'')) as run:
            zusage._remote_exec(["s"], rc, "key")
        cmd = run.call_args.args[0]
        self.assertEqual(len(cmd), 3)
        args = shlex.split(cmd[-1])
        self.assertEqual(args[:3], ["env", "ZUSAGE_REMOTE_CHILD=1", "/path with space/python"])
        self.assertEqual(args[3], "$HOME/folder/usage 'quoted'; touch nope.py")
        self.assertEqual(args[-2:], ["json", "s"])

    def test_generic_channels_use_env_argv_and_expand_tilde_in_python(self):
        for channel in (["docker", "exec", "-i", "box"], ["wsl", "-d", "Ubuntu"],
                        ["kubectl", "exec", "-i", "pod", "--"]):
            with mock.patch.object(zusage.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b'{}\n', b'')) as run:
                zusage._remote_exec(["s"], self.rc(channel, script="~/space folder/zusage.py"), "key")
            args = run.call_args.args[0]
            self.assertEqual(args[:len(channel)], channel)
            self.assertEqual(args[len(channel):len(channel)+2], ["env", "ZUSAGE_REMOTE_CHILD=1"])
            self.assertIn("-c", args)
            self.assertIn("~/space folder/zusage.py", args)

    def test_missing_script_or_python_and_error_payload(self):
        for result in (subprocess.CompletedProcess([], 2, b'', b"python3: can't open file: missing zusage.py"),
                       subprocess.CompletedProcess([], 127, b'', b'python3: not found'),
                       subprocess.CompletedProcess([], 0, b'{"error":"missing schema"}\n', b'')):
            with mock.patch.object(zusage.subprocess, "run", return_value=result):
                by, today, err = zusage._remote_exec(["s"], self.rc(), "key")
            self.assertEqual(by, {})
            self.assertIsNone(today)
            self.assertTrue(err)

    def test_banner_known_sids_and_legacy_zero(self):
        payload = {"known_sids": ["s"], "recent": [{"sid": "s", "requests": 0}], "today": {"requests": 1}}
        with mock.patch.object(zusage.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b'banner\n'+json.dumps(payload).encode(), b'')):
            by, today, err = zusage._remote_exec(["s"], self.rc(), "key")
        self.assertEqual(by["s"]["remote_target"], "key")
        self.assertIsNone(err)
        self.assertEqual(today, {"requests": 1})


class FetchTests(IsolatedTests):
    def test_auto_unknown_local_sid_never_probed(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [entry("a")]})
        setup = zusage._remote_setup({})
        with mock.patch.object(zusage, "_remote_exec") as run:
            self.assertEqual(zusage._remote_fetch(["s"], set(), setup), ({}, {}, {}))
            zusage._remote_fetch(["s"], set(), setup, scopes=[("s", "/local")])
        run.assert_not_called()

    def test_same_sid_two_remote_scopes_and_local_collision(self):
        setup = self.setup_targets()
        def fake(sids, rc, key):
            return {"s": {"sid": "s", "requests": 10 if key == setup["identities"][A] else 20}}, {"requests": 1}, None
        with mock.patch.object(zusage, "_remote_exec", side_effect=fake):
            by, today, errs = zusage._remote_fetch(["s"], {"s"}, setup, scopes=[("s", A), ("s", B)])
        self.assertEqual(by[("s", A)]["requests"], 10)
        self.assertEqual(by[("s", B)]["requests"], 20)
        self.assertEqual(len(today), 2)

    def test_error_cache_keeps_reason_and_isolated_per_target(self):
        setup = self.setup_targets()
        calls = []
        def fake(sids, rc, key):
            calls.append(key)
            return {}, None, "offline" if key == setup["identities"][A] else None
        with mock.patch.object(zusage, "_remote_exec", side_effect=fake):
            by, _, errs = zusage._remote_fetch(["s"], set(), setup, scopes=[("s", A)])
            by2, _, errs2 = zusage._remote_fetch(["s"], set(), setup, scopes=[("s", A), ("s", B)])
        self.assertEqual(len(calls), 2)
        self.assertEqual(by2[("s", A)]["remote_error"], "offline")
        self.assertTrue(by2[("s", A)]["remote_missing"])
        self.assertEqual(errs2[setup["identities"][A]], "offline")
        self.assertNotIn(setup["identities"][B], errs2)
        self.assertEqual(zusage._REMOTE_NEG[("s", setup["identities"][A])][1], zusage._REMOTE_NEG_TTL_ERR)
        self.assertEqual(zusage._REMOTE_NEG[("s", setup["identities"][B])][1], zusage._REMOTE_NEG_TTL_OK)

    def test_unknown_scope_stub_and_legacy_local_precedence(self):
        setup = self.setup_targets()
        with mock.patch.object(zusage, "_remote_exec") as run:
            by, _, _ = zusage._remote_fetch(["s"], set(), setup, scopes=[("s", "remote:ssh:unknown:22:u:/p")])
            row = next(iter(by.values()))
            self.assertTrue(row["remote_missing"])
            self.assertEqual(row["remote_target"], "")
            zusage._remote_fetch(["s"], {"s"}, setup)
        run.assert_not_called()

    def test_parallel_channels_one_exception_does_not_block_healthy(self):
        setup = self.setup_targets()
        barrier = threading.Barrier(2)
        def fake(sids, rc, key):
            barrier.wait(timeout=1)
            if key == setup["identities"][A]:
                raise ValueError("bad response")
            return {"s": {"sid": "s", "requests": 5}}, {}, None
        with mock.patch.object(zusage, "_remote_exec", side_effect=fake):
            by, _, errs = zusage._remote_fetch(["s"], set(), setup, scopes=[("s", A), ("s", B)])
        self.assertEqual(by[("s", B)]["requests"], 5)
        self.assertIn("bad response", by[("s", A)]["remote_error"])

    def test_timeout_budget_is_bounded_with_queued_targets(self):
        targets = [{"ssh": "ssh host" + str(i), "identity": "remote:ssh:h" + str(i) + ":22:u:/p"}
                   for i in range(8)]
        setup = zusage._remote_setup({"remote": {"targets": targets, "timeout_s": 100}})
        scopes = [("s", target["identity"]) for target in targets]
        active, maximum = 0, 0
        lock = threading.Lock()
        def fake(sids, rc, key):
            nonlocal active, maximum
            self.assertLessEqual(rc["timeout_s"], 6)
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.01)
            with lock:
                active -= 1
            return {}, None, "timeout"
        with mock.patch.object(zusage, "_remote_exec", side_effect=fake):
            by, _, errs = zusage._remote_fetch(["s"], set(), setup, scopes=scopes)
        self.assertEqual(len(by), 8)
        self.assertEqual(len(errs), 8)
        self.assertLessEqual(maximum, 4)
        self.assertGreater(maximum, 1)

    def test_timeout_and_budget_exhaustion_are_error_not_absence(self):
        rc = zusage._normalize_remote_entry({"ssh": "ssh a"})
        with mock.patch.object(zusage.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 6)):
            _, _, err = zusage._remote_exec(["s"], rc, "key")
        self.assertIn("timeout", err)
        setup = self.setup_targets()
        with mock.patch.object(zusage.time, "monotonic", side_effect=[100, 107, 107]), \
                mock.patch.object(zusage, "_remote_exec") as run:
            by, _, errs = zusage._remote_fetch(["s"], set(), setup, scopes=[("s", A), ("s", B)])
        run.assert_not_called()
        self.assertEqual(len(errs), 2)
        self.assertTrue(all("budget exhausted" in row["remote_error"] for row in by.values()))
        self.assertTrue(all(value[1] == zusage._REMOTE_NEG_TTL_ERR for value in zusage._REMOTE_NEG.values()))

    def test_same_sid_local_and_remote_snapshot_precedence(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        spec = importlib.util.spec_from_file_location("rate_schema", ROOT / "tests/test_statusbar_rate.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        con.executescript(mod.SCHEMA)
        con.execute("insert into session(id,title) values ('s','local')")
        cfg = {"context_window": 1, "remote": {"targets": [{"ssh": "ssh a", "identity": A}]}}
        with mock.patch.object(zusage, "connect", return_value=con), \
                mock.patch.object(zusage, "load_config", return_value=cfg), \
                mock.patch.object(zusage, "_remote_exec", return_value=({"s": {"sid": "s", "requests": 99}}, {}, None)):
            payload = zusage.snapshot("s", [{"sid": "s", "workspaceIdentity": "/local"},
                                           {"sid": "s", "workspaceIdentity": A}])
        scoped = {row.get("workspace_identity"): row for row in payload["recent"] if row.get("workspace_identity")}
        self.assertEqual(scoped["/local"]["title"], "local")
        self.assertFalse(scoped["/local"].get("remote"))
        self.assertEqual(scoped[A]["requests"], 99)

    def test_error_cache_expires_and_success_clears(self):
        setup = self.setup_targets()
        key = setup["identities"][A]
        zusage._REMOTE_NEG[("s", key)] = (0, 1, "old")
        with mock.patch.object(zusage, "_remote_exec", return_value=({"s": {"sid": "s"}}, {}, None)):
            by, _, errs = zusage._remote_fetch(["s"], set(), setup, scopes=[("s", A)])
        self.assertNotIn(("s", key), zusage._REMOTE_NEG)
        self.assertFalse(by[("s", A)].get("remote_missing"))
        self.assertEqual(errs, {})


class ProtocolSnapshotTests(IsolatedTests):
    def test_parse_routes_and_json(self):
        self.assertEqual(zusage._parse_routes("s@a0,bad@UPPER,nope"), {"s": "a0"})
        self.assertEqual(zusage._parse_query("s|s@a0"), ("s", {"s": "a0"}))
        request = {"sids": ["s"], "scopes": [{"sid": "s", "workspaceIdentity": A}]}
        self.assertEqual(zusage._parse_query(json.dumps(request)), ("s", request["scopes"]))

    def test_main_and_serve_json_equal_without_db(self):
        cfg = {"context_window": 128000, "remote": {"targets": [{"ssh": "ssh a", "identity": A}]}}
        request = json.dumps({"sids": ["s"], "scopes": [{"sid": "s", "workspaceIdentity": A}]})
        def fake(sids, rc, key):
            return {"s": {"sid": "s", "requests": 42}}, {"requests": 8}, None
        outputs = []
        with mock.patch.object(zusage, "load_config", return_value=cfg), \
                mock.patch.object(zusage, "connect", side_effect=sqlite3.OperationalError("no local db")), \
                mock.patch.object(zusage, "_remote_exec", side_effect=fake):
            for resident in (False, True):
                out = io.StringIO()
                with mock.patch.object(zusage.sys, "stdout", out), mock.patch.object(zusage.sys, "stdin", io.StringIO(request + "\n")):
                    zusage.main(["serve"] if resident else ["json", request])
                outputs.append(json.loads(out.getvalue()))
        self.assertEqual(outputs[0], outputs[1])
        row = next(r for r in outputs[0]["recent"] if r.get("workspace_identity") == A)
        self.assertEqual(row["requests"], 42)
        self.assertEqual(outputs[0]["local_error"], "no local db")

    def test_main_and_serve_preserve_remote_when_local_detail_table_missing(self):
        spec = importlib.util.spec_from_file_location("local_detail_schema", ROOT / "tests/test_statusbar_rate.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        cfg = {"context_window": 128000, "remote": {"auto": False, "enabled": True,
               "targets": [{"ssh": "ssh a", "identity": A}]}}
        request = json.dumps({"sids": ["s"], "scopes": [{"sid": "s", "workspaceIdentity": A}]})
        for resident in (False, True):
            for latest in (False, True):
                with self.subTest(resident=resident, latest=latest):
                    con = sqlite3.connect(":memory:")
                    con.row_factory = sqlite3.Row
                    con.executescript(mod.SCHEMA)
                    con.execute("insert into session(id,title) values ('local','local')")
                    if latest:
                        con.execute("insert into model_usage(id,session_id,status,completed_at) values ('r','local','completed',1)")
                    con.execute("drop table tool_usage")
                    zusage._AGG_CACHE.clear()
                    out = io.StringIO()
                    with mock.patch.object(zusage, "connect", return_value=con), \
                            mock.patch.object(zusage, "load_config", return_value=cfg), \
                            mock.patch.object(zusage, "_remote_exec", return_value=({"s": {"sid": "s", "requests": 42}}, {"requests": 8}, None)) as remote, \
                            mock.patch.object(zusage.sys, "stdout", out), \
                            mock.patch.object(zusage.sys, "stdin", io.StringIO(request + "\n")):
                        zusage.main(["serve"] if resident else ["json", request])
                    payload = json.loads(out.getvalue())
                    remote.assert_called_once()
                    self.assertNotIn("error", payload)
                    self.assertIn("tool_usage", payload["local_error"])
                    row = next(r for r in payload["recent"] if r.get("workspace_identity") == A)
                    self.assertEqual(row["requests"], 42)
                    self.assertEqual(payload["remote_today"][row["remote_target"]], {"requests": 8})

    def test_light_local_failure_preserves_remote(self):
        cfg = {"context_window": 128000, "remote": {"targets": [{"ssh": "ssh a", "identity": A}]}}
        con = mock.Mock()
        con.execute.return_value = []
        local_rows = [("local" + str(i), 10-i) for i in range(6)]
        with mock.patch.object(zusage, "connect", return_value=con), \
                mock.patch.object(zusage, "load_config", return_value=cfg), \
                mock.patch.object(zusage, "range_usage", return_value=(0,) * 9), \
                mock.patch.object(zusage, "_scan_session_ids", return_value=local_rows), \
                mock.patch.object(zusage, "_session_snapshot", side_effect=lambda c, s, cfg: zusage._empty_snapshot(s, cfg)), \
                mock.patch.object(zusage, "_light_snapshot", side_effect=sqlite3.OperationalError("light query failed")), \
                mock.patch.object(zusage, "_remote_exec", return_value=({"s": {"sid": "s", "requests": 42}}, {}, None)):
            payload = zusage.snapshot("s", [{"sid": "s", "workspaceIdentity": A}])
        self.assertEqual(payload["local_error"], "light query failed")
        self.assertEqual(payload["recent"][0]["requests"], 42)
        self.assertEqual(next(r for r in payload["recent"] if r["sid"] == "local5")["requests"], 0)

    def test_json_empty_scopes_never_uses_manual_fallback(self):
        cfg = {"context_window": 128000, "remote": {"enabled": True, "auto": False, "ssh": "ssh a"}}
        request = json.dumps({"sids": ["s"], "scopes": []})
        for resident in (False, True):
            out = io.StringIO()
            with mock.patch.object(zusage, "connect", side_effect=sqlite3.OperationalError("no db")), \
                    mock.patch.object(zusage, "load_config", return_value=cfg), \
                    mock.patch.object(zusage, "_remote_exec") as remote, \
                    mock.patch.object(zusage.sys, "stdout", out), \
                    mock.patch.object(zusage.sys, "stdin", io.StringIO(request + "\n")):
                zusage.main(["serve"] if resident else ["json", request])
            remote.assert_not_called()
            self.assertNotIn("error", json.loads(out.getvalue()))

    def test_unknown_remote_scope_without_setup_is_scoped_stub(self):
        with mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.object(zusage, "connect", side_effect=sqlite3.OperationalError("no db")):
            payload = zusage.snapshot("s", [{"sid": "s", "workspaceIdentity": A}])
        row = payload["recent"][0]
        self.assertEqual(row["workspace_identity"], A)
        self.assertEqual(row["remote_target"], "")
        self.assertTrue(row["remote_missing"])


if __name__ == "__main__":
    unittest.main()
