# -*- coding: utf-8 -*-
"""启动策略回归：同一份代码按 agent 分流，ZCode 走 asar（原机制不动），WorkBuddy 走 CDP。

这里的断言都是「策略选择」而不是「真的注入」：不连 CDP、不起进程、不读真实配置，
避免测试在有/没有客户端的机器上表现不同。
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


zusage = _load("zusage_agent_test", ROOT / "zusage.py")
usage_mcp = _load("usage_mcp_agent_test", ROOT / "usage_mcp.py")


class AgentDetectionTests(unittest.TestCase):
    def test_env_precedence(self):
        self.assertEqual(zusage.detect_agent({}), "zcode")                       # 老安装默认不变
        self.assertEqual(zusage.detect_agent({"ZUSAGE_AGENT": "workbuddy"}), "workbuddy")
        self.assertEqual(zusage.detect_agent({"ZUSAGE_AGENT": "cli"}), "cli")
        self.assertEqual(zusage.detect_agent({"ZUSAGE_AGENT": "wb"}), "workbuddy")  # 别名
        self.assertEqual(zusage.detect_agent({"CODEBUDDY_PLUGIN_ROOT": "x"}), "workbuddy")
        self.assertEqual(zusage.detect_agent({"ZCODE_PLUGIN_ROOT": "x"}), "zcode")
        # 插件根变量优先于客户端指纹
        self.assertEqual(zusage.detect_agent({
            "CODEBUDDY_PLUGIN_ROOT": "x", "CLIENT_INFO_PLATFORM": "WorkBuddy"}), "workbuddy")
        # 客户端指纹会被子进程继承（在 WorkBuddy 终端里跑 ZCode 那份就会误判），刻意不采用
        self.assertEqual(zusage.detect_agent({"CLIENT_INFO_PLATFORM": "WorkBuddy"}), "zcode")

    def test_host_follows_agent_only_for_workbuddy_build(self):
        with mock.patch.object(zusage, "detect_agent", return_value="workbuddy"), \
                mock.patch.object(zusage, "CONFIG_PATH", Path("不存在.json")):
            self.assertEqual(zusage.resolve_host(), zusage.HOST_WORKBUDDY)
            self.assertEqual(zusage.host_source(), "agent")
        with mock.patch.object(zusage, "detect_agent", return_value="zcode"), \
                mock.patch.object(zusage, "CONFIG_PATH", Path("不存在.json")):
            self.assertEqual(zusage.resolve_host(), zusage.HOST_ZCODE)   # 老行为不变

    def test_strategy_table(self):
        zcode = zusage.agent_strategy("zcode")
        self.assertEqual(zcode["overlay"], "asar")     # 原机制：asar 注入
        self.assertTrue(zcode["rate_line"])
        self.assertTrue(zcode["updater"])
        wb = zusage.agent_strategy("workbuddy")
        self.assertEqual(wb["overlay"], "cdp")         # 无 asar 链，改 CDP
        self.assertFalse(wb["rate_line"])              # 没有渲染桥
        self.assertFalse(wb["updater"])                # 没有 ZCode 插件更新器
        self.assertIsNone(zusage.agent_strategy("cli")["overlay"])

    def test_overlay_mode_config_override(self):
        self.assertEqual(zusage.overlay_mode("workbuddy"), "cdp")
        self.assertEqual(zusage.overlay_mode("zcode"), "asar")
        self.assertIsNone(zusage.overlay_mode("workbuddy", cfg={"agents": {"workbuddy": {"overlay": False}}}))
        self.assertIsNone(zusage.overlay_mode("workbuddy", cfg={"agents": {"workbuddy": {"overlay": "off"}}}))
        self.assertEqual(zusage.overlay_mode("workbuddy", cfg={"agents": {"workbuddy": {"overlay": "asar"}}}), "asar")
        self.assertEqual(zusage.overlay_mode("workbuddy", cfg={"agents": {"workbuddy": {"overlay": True}}}), "cdp")
        # 坏配置不改变默认
        self.assertEqual(zusage.overlay_mode("workbuddy", cfg={"agents": "nope"}), "cdp")

    def test_node_candidates_dedupe_and_skip_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ver = Path(tmp) / "binaries" / "node" / "versions" / "22.22.2-6"
            ver.mkdir(parents=True)
            exe = ver / ("node.exe" if os.name == "nt" else "node")
            exe.write_bytes(b"")
            with mock.patch.object(zusage.shutil, "which", return_value=str(exe)), \
                    mock.patch.dict(os.environ, {"WORKBUDDY_HOME": tmp}):
                found = zusage.node_candidates()
        self.assertEqual(len(found), 1, found)          # PATH 与版本目录指向同一文件 → 只留一个
        self.assertTrue(found[0].endswith(("node.exe", "node")))

    def test_entrypoint_points_at_injector(self):
        self.assertEqual(zusage.overlay_entrypoint().name, "wb-overlay.cjs")


class StartPolicyTests(unittest.TestCase):
    """start_agent_overlay 的分流：ZCode 一定不动手，WorkBuddy 才拉起注入器。"""

    def test_zcode_never_spawns_anything(self):
        with mock.patch.object(usage_mcp.zusage, "detect_agent", return_value="zcode"), \
                mock.patch.object(usage_mcp.subprocess, "Popen", side_effect=AssertionError("不该拉起")) as popen, \
                mock.patch.object(usage_mcp, "_spawn_via_wmi", side_effect=AssertionError("不该走 WMI")):
            usage_mcp.start_agent_overlay()
        self.assertFalse(popen.called)

    def test_workbuddy_without_injector_is_silent(self):
        with mock.patch.object(usage_mcp.zusage, "detect_agent", return_value="workbuddy"), \
                mock.patch.object(usage_mcp.zusage, "overlay_mode", return_value="cdp"), \
                mock.patch.object(usage_mcp.zusage, "overlay_entrypoint", return_value=Path("不存在.cjs")), \
                mock.patch.object(usage_mcp, "_spawn_via_wmi") as wmi, \
                mock.patch.object(usage_mcp.subprocess, "Popen") as popen:
            usage_mcp.start_agent_overlay()
        self.assertFalse(wmi.called)
        self.assertFalse(popen.called)

    def test_workbuddy_running_overlay_is_not_duplicated(self):
        fake = Path(__file__)
        with mock.patch.object(usage_mcp.zusage, "detect_agent", return_value="workbuddy"), \
                mock.patch.object(usage_mcp.zusage, "overlay_mode", return_value="cdp"), \
                mock.patch.object(usage_mcp.zusage, "overlay_entrypoint", return_value=fake), \
                mock.patch.object(usage_mcp, "_overlay_running", return_value=True), \
                mock.patch.object(usage_mcp, "_spawn_via_wmi") as wmi:
            usage_mcp.start_agent_overlay()
        self.assertFalse(wmi.called)

    def test_lock_freshness(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "zusage-wb-overlay.lock"
            with mock.patch.object(usage_mcp.tempfile, "gettempdir", return_value=tmp):
                lock.write_text(json.dumps({"pid": 1, "at": 0}), encoding="utf-8")
                self.assertFalse(usage_mcp._overlay_running())          # 过期
                import time
                lock.write_text(json.dumps({"pid": 1, "at": time.time() * 1000}), encoding="utf-8")
                self.assertTrue(usage_mcp._overlay_running())
                lock.write_text("{坏 JSON", encoding="utf-8")
                self.assertFalse(usage_mcp._overlay_running())


class HookAgentGateTests(unittest.TestCase):
    """ZCode 的 SessionStart hook 装到别的宿主时必须静默退出，绝不碰 asar。"""

    def test_session_start_is_silent_on_workbuddy(self):
        hook = ROOT / "plugins" / "zcode-token-usage-statusbar" / "hooks" / "session-start.py"
        env = dict(os.environ, ZUSAGE_AGENT="workbuddy")
        env.pop("ZCODE_PLUGIN_ROOT", None)
        proc = subprocess.run([sys.executable, "-B", str(hook)], input=b"{}",
                              capture_output=True, env=env, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
        payload = json.loads(proc.stdout.decode("utf-8", "replace").strip() or "{}")
        self.assertIs(payload.get("suppressOutput"), True)
        self.assertNotIn("hookSpecificOutput", payload)   # 不往会话里塞文字
        self.assertEqual(proc.stderr, b"")


class McpHostBehaviorTests(unittest.TestCase):
    """MCP host 参数按次生效（不写进程级覆盖）；待收尾包自愈门控按 agent 判定。"""

    def test_tool_host_override_is_per_call(self):
        recorded = []

        def fake_connect(host=None):
            recorded.append(host)
            return mock.MagicMock()

        with mock.patch.object(usage_mcp.zusage, "connect", side_effect=fake_connect), \
                mock.patch.object(usage_mcp.zusage, "render_current", return_value="ok"):
            usage_mcp.tool_token_usage(scope="current", host="workbuddy")
            usage_mcp.tool_token_usage(scope="current")
        self.assertEqual(recorded, ["workbuddy", None])   # 不传 host 的下一次回到跟随配置
        self.assertIsNone(usage_mcp.zusage._HOST_OVERRIDE)

    def test_finalize_revive_gate_follows_agent_not_host(self):
        """ZCode 客户端 + host=workbuddy 配置：待收尾包自愈（issue #163）必须保留。"""
        path_mock = mock.MagicMock()
        with mock.patch.object(usage_mcp.zusage, "detect_agent", return_value="zcode"), \
                mock.patch.object(usage_mcp.zusage, "resolve_host", return_value="workbuddy"), \
                mock.patch.object(usage_mcp, "Path", return_value=path_mock) as pmock:
            usage_mcp.revive_finalize_monitor()
        self.assertTrue(pmock.called, "agent=zcode 时不得因 host=workbuddy 提前 return")
        with mock.patch.object(usage_mcp.zusage, "detect_agent", return_value="workbuddy"), \
                mock.patch.object(usage_mcp, "Path", return_value=path_mock) as pmock2:
            usage_mcp.revive_finalize_monitor()
        self.assertFalse(pmock2.called, "agent=workbuddy 应在触碰任何路径前退出")


if __name__ == "__main__":
    unittest.main()
