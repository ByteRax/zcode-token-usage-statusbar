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
W = "remote:wsl:Ubuntu:dev:/p"
SRV = "remote:server:srv1:/p"


def entry(host, path="/p"):
    return {"kind": "remote", "workspacePath": path,
            "target": {"kind": "ssh", "host": host, "username": "u"}}


def wsl_entry(distro="Ubuntu", user="dev", path="/p", identity=None):
    e = {"kind": "remote", "workspacePath": path,
         "target": {"kind": "wsl", "distro": distro}}
    if user is not None:
        e["target"]["user"] = user
    if identity is not None:
        e["workspaceIdentity"] = identity
    return e


def docker_entry(container="box", path="/p", identity=None):
    e = {"kind": "remote", "workspacePath": path,
         "target": {"kind": "docker", "container": container}}
    if identity is not None:
        e["workspaceIdentity"] = identity
    return e


def write_setting(root, payload):
    path = Path(root) / ".zcode" / "v2" / "setting.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    zusage._CLIENT_STATE_CACHE["sig"] = None
    zusage._CLIENT_STATE_CACHE["server_sig"] = None
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
        zusage._CLIENT_STATE_CACHE.update(sig=None, entries=[], server_sig=None, server_hist=[])
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

    def test_wsl_auto_channel_user_and_exec(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [wsl_entry()]})
        rows = zusage._auto_targets({})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ssh_argv"], ["wsl.exe", "-d", "Ubuntu", "-u", "dev", "--exec"])
        self.assertEqual(rows[0]["identities"], [W])
        self.assertEqual(rows[0]["host_label"], "wsl:Ubuntu")
        # wsl --exec 无登录 shell、CWD 不可靠：自动默认脚本带 ~ 前缀；显式 remote.script 优先。
        setup = zusage._remote_setup({})
        self.assertEqual(setup["targets"][setup["identities"][W]]["script"],
                         "~/.zcode/zcode-token-usage-statusbar/zusage.py")
        setup = zusage._remote_setup({"remote": {"script": "/opt/custom/zusage.py"}})
        self.assertEqual(setup["targets"][setup["identities"][W]]["script"], "/opt/custom/zusage.py")

    def test_wsl_identity_fallbacks_match_client_algorithm(self):
        # 条目缺 workspaceIdentity 时按客户端 buildRemoteWorkspaceIdentity 兜底；
        # 无 user 段走 legacy 两段格式；缺 distro 归一为 default；路径反斜杠归一。
        write_setting(self.tmp.name, {"lastWorkspaceSession": [
            wsl_entry(user=None),
            wsl_entry(distro="", user=None, path=r"\opt\w"),
            wsl_entry(distro="Debian", user=None)]})
        rows = zusage._auto_targets({})
        self.assertEqual([r["host_label"] for r in rows], ["wsl:Debian", "wsl:Ubuntu", "wsl:default"])
        self.assertEqual(rows[0]["ssh_argv"], ["wsl.exe", "-d", "Debian", "--exec"])
        identities = sorted(r["identities"][0] for r in rows)
        self.assertEqual(identities,
                         ["remote:wsl:Debian:/p", "remote:wsl:Ubuntu:/p", "remote:wsl:default:/opt/w"])
        back = zusage._wsl_identity("Ubuntu", "", r"\opt\w")
        self.assertEqual(back, "remote:wsl:Ubuntu:/opt/w")

    def test_wsl_316_server_identity_routes_over_wsl_channel(self):
        # v3.16 客户端握手后把 WSL 会话身份升级为 remote:server:<id>:/p，
        # 持久化 target 仍是传输级 wsl：身份原样采用并路由到 wsl.exe 通道。
        write_setting(self.tmp.name, {"lastWorkspaceSession": [
            wsl_entry(identity=SRV), wsl_entry(path="/q", identity="remote:server:srv1:/q")]})
        rows = zusage._auto_targets({})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ssh_argv"], ["wsl.exe", "-d", "Ubuntu", "-u", "dev", "--exec"])
        self.assertEqual(rows[0]["identities"], [SRV, "remote:server:srv1:/q"])
        setup = zusage._remote_setup({})
        for ident in rows[0]["identities"]:
            self.assertEqual(setup["identities"][ident], setup["identities"][SRV])

    def test_wsl_same_distro_different_user_split(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [
            wsl_entry(user="dev"), wsl_entry(user="root")]})
        rows = zusage._auto_targets({})
        self.assertEqual(len(rows), 2)
        self.assertEqual(sorted(r["ssh_argv"][-3:] for r in rows),
                         [["-u", "dev", "--exec"], ["-u", "root", "--exec"]])

    def test_docker_auto_channel_and_server_kind_skipped(self):
        write_setting(self.tmp.name, {"lastWorkspaceSession": [
            docker_entry(identity="remote:docker:box:/p"),
            {"kind": "remote", "workspacePath": "/p", "target": {"kind": "server", "url": "http://x"}},
            {"kind": "remote", "workspacePath": "/p", "target": {"kind": "docker"}},
            wsl_entry(distro="Debian", user=None, identity="remote:wsl:Debian:/p")]})
        rows = zusage._auto_targets({})
        self.assertEqual(len(rows), 2)
        by_label = {r["host_label"]: r for r in rows}
        self.assertEqual(by_label["docker:box"]["ssh_argv"], ["docker", "exec", "-i", "box"])
        self.assertEqual(by_label["docker:box"]["identities"], ["remote:docker:box:/p"])
        self.assertEqual(by_label["wsl:Debian"]["ssh_argv"], ["wsl.exe", "-d", "Debian", "--exec"])

    def test_316_server_history_identities_join_transport_by_path(self):
        # 3.16 客户端把握手升级后的 remote:server:<id>:/path 记在 sourceServerWorkspaceHistory，
        # lastWorkspaceSession 投影刻意剥掉 server 形态只留传输级 legacy 身份（客户端源码
        # workspace-settings.ts / remoteWorkspaceHistory.ts 实证）：插件按归一路径把 server
        # 身份并进同一条传输通道，路径归一与客户端 normalizeWorkspacePathForIdentity 同款。
        write_setting(self.tmp.name, {
            "lastWorkspaceSession": [wsl_entry(), wsl_entry(path="/q")],
            "sourceServerWorkspaceHistory": [
                {"workspacePath": "/p/", "workspaceIdentity": SRV, "sourceServerId": "srv1"},
                {"workspacePath": "/q", "workspaceIdentity": "remote:server:srv1:/q",
                 "sourceServerId": "srv1"}]})
        rows = zusage._auto_targets({})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["identities"],
                         [W, SRV, "remote:wsl:Ubuntu:dev:/q", "remote:server:srv1:/q"])

    def test_server_history_failclosed_on_ambiguity(self):
        # 同一路径混入多个 sourceServerId 无法唯一归属服务器、非 remote:server: 前缀、
        # 路径命中多条通道：三种情况都不并，保持各自 fail-closed 行为。
        write_setting(self.tmp.name, {
            "lastWorkspaceSession": [wsl_entry(), wsl_entry(distro="Debian", user=None)],
            "sourceServerWorkspaceHistory": [
                {"workspacePath": "/p", "workspaceIdentity": "remote:server:srv1:/p",
                 "sourceServerId": "srv1"},
                {"workspacePath": "/p", "workspaceIdentity": "remote:server:srv2:/p",
                 "sourceServerId": "srv2"},
                {"workspacePath": "/q", "workspaceIdentity": "remote:wsl:Ubuntu:dev:/q",
                 "sourceServerId": "srv1"}]})
        rows = zusage._auto_targets({})
        by_label = {r["host_label"]: r for r in rows}
        self.assertEqual(by_label["wsl:Ubuntu"]["identities"], [W])
        self.assertEqual(by_label["wsl:Debian"]["identities"], ["remote:wsl:Debian:/p"])
        write_setting(self.tmp.name, {
            "lastWorkspaceSession": [wsl_entry(), wsl_entry(distro="Debian", user=None)],
            "sourceServerWorkspaceHistory": [
                {"workspacePath": "/p", "workspaceIdentity": SRV, "sourceServerId": "srv1"}]})
        rows = zusage._auto_targets({})
        by_label = {r["host_label"]: r for r in rows}
        self.assertEqual(by_label["wsl:Ubuntu"]["identities"], [W, SRV])
        self.assertEqual(by_label["wsl:Debian"]["identities"], ["remote:wsl:Debian:/p"])

    def test_server_history_binds_ssh_channel_too(self):
        # 3.16 的 SSH 会话同样握手升级为 server 身份：路径关联对 ssh 通道一致生效。
        write_setting(self.tmp.name, {
            "lastWorkspaceSession": [entry("a")],
            "sourceServerWorkspaceHistory": [
                {"workspacePath": "/p", "workspaceIdentity": "remote:server:srv1:/p",
                 "sourceServerId": "srv1"}]})
        rows = zusage._auto_targets({})
        self.assertEqual(rows[0]["identities"], [A, "remote:server:srv1:/p"])


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
                        ["wsl.exe", "-d", "Ubuntu", "-u", "dev", "--exec"],
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

    def test_wsl_and_server_identities_route_without_ssh_channel(self):
        # 3.15.x wsl 直连身份（remote:wsl:）与 3.16 升级身份（remote:server:）都按
        # 整串路由到各自通道；未知前缀（remote:ftp:）不属于免交互白名单，stub 不查。
        write_setting(self.tmp.name, {"lastWorkspaceSession": [
            wsl_entry(identity=SRV), {"kind": "remote", "workspacePath": "/p",
                                      "target": {"kind": "wsl", "distro": "Debian"},
                                      "workspaceIdentity": "remote:wsl:Debian:/p"}]})
        setup = zusage._remote_setup({})
        srv_key = setup["identities"][SRV]
        debian_key = setup["identities"]["remote:wsl:Debian:/p"]
        self.assertNotEqual(srv_key, debian_key)
        self.assertIn("wsl.exe", setup["targets"][srv_key]["ssh_argv"][0])
        calls = []

        def fake(sids, rc, key):
            calls.append(key)
            return {sids[0]: {"sid": sids[0], "requests": 7}}, {}, None

        with mock.patch.object(zusage, "_remote_exec", side_effect=fake):
            by, _, _ = zusage._remote_fetch(["s", "t"], set(), setup,
                                            scopes=[("s", SRV), ("t", "remote:wsl:Debian:/p"),
                                                    ("u", "remote:ftp:x:/p")])
        self.assertEqual(by[("s", SRV)]["requests"], 7)
        self.assertEqual(by[("t", "remote:wsl:Debian:/p")]["requests"], 7)
        self.assertEqual(set(calls), {srv_key, debian_key})
        self.assertTrue(by[("u", "remote:ftp:x:/p")]["remote_missing"])
        self.assertEqual(by[("u", "remote:ftp:x:/p")]["remote_target"], "")

    def test_316_server_history_identity_routes_over_wsl_channel(self):
        # 端到端：目标表只有 legacy 身份，窗口发来 sourceServerWorkspaceHistory 里的
        # server 身份——修复前这正是 "remote target not configured" 的实机复现路径。
        write_setting(self.tmp.name, {
            "lastWorkspaceSession": [wsl_entry()],
            "sourceServerWorkspaceHistory": [
                {"workspacePath": "/p", "workspaceIdentity": SRV, "sourceServerId": "srv1"}]})
        setup = zusage._remote_setup({})
        key = setup["identities"][SRV]
        self.assertEqual(setup["targets"][key]["ssh_argv"],
                         ["wsl.exe", "-d", "Ubuntu", "-u", "dev", "--exec"])
        calls = []

        def fake(sids, rc, k):
            calls.append(k)
            return {sids[0]: {"sid": sids[0], "requests": 5}}, {}, None

        with mock.patch.object(zusage, "_remote_exec", side_effect=fake):
            by, _, _ = zusage._remote_fetch(["s"], set(), setup, scopes=[("s", SRV)])
        self.assertEqual(calls, [key])
        self.assertEqual(by[(("s"), SRV)]["requests"], 5)

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
        class _cursor(list):          # 兼具真实 sqlite 游标两种用法：可迭代 + fetchone
            def fetchone(self):
                return self[0] if self else None
        con.execute.return_value = _cursor([(0, 0)])   # 今日活动跨度（尚无请求）
        local_rows = [("local" + str(i), 10-i) for i in range(6)]
        with mock.patch.object(zusage, "connect", return_value=con), \
                mock.patch.object(zusage, "load_config", return_value=cfg), \
                mock.patch.object(zusage, "_today_usage", return_value=(0,) * 11), \
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
