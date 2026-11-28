# -*- coding: utf-8 -*-
"""/zusage-doctor 只读体检的隔离测试（specs/zusage-doctor.md）：临时归档、临时运行目录、
临时宿主存储，不读真机安装、不写用户目录。"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tests.helpers.py_test_support import load_module, make_asar  # noqa: E402

PLUGIN = ROOT / "plugins" / "zcode-token-usage-statusbar"
INSTALLER = load_module("doctor_overlay_install", PLUGIN / "overlay_install.py")
REPO_ASAR = load_module("doctor_repo_patch_install", ROOT / "patch_install.py")
PLUGIN_ASAR = load_module("doctor_plugin_patch_install", PLUGIN / "patch_install.py")
ID = INSTALLER.PLUGIN_ID


def snapshot(root):
    """目录下全部文件的名字与字节（含隐藏文件），用来证明体检前后没有任何落盘改动。"""
    return {str(path.relative_to(root)): path.read_bytes()
            for path in sorted(Path(root).rglob("*")) if path.is_file()}


class DoctorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="zusage-doctor-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.home_dir("home")
        self.runtime = self.home / ".zcode" / "zcode-token-usage-statusbar"
        self.runtime.mkdir(parents=True)
        self.storage = self.home_dir("storage") / "cli" / "plugins"
        self.storage.mkdir(parents=True)
        self.config = self.home_dir("host") / "config.json"
        self.config.write_text(json.dumps({"plugins": {"enabledPlugins": {ID: True}}}), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                           "ZCODE_STORAGE_DIR": str(self.storage.parents[1]),
                                           "ZUSAGE_PLUGIN_HOST_CONFIG": str(self.config),
                                           "ZUSAGE_PLUGIN_RUNTIME": str(self.runtime),
                                           "ZUSAGE_PLUGIN_ASAR": str(self.root / "app.asar"),
                                           "ZCODE_ASAR": "", "ZUSAGE_NO_MONITOR": "1"})
        env.start()
        self.addCleanup(env.stop)
        self.asar = self.root / "app.asar"
        self.write_host(record=True, market={"id": INSTALLER.MARKETPLACE_ID,
                                              "source": {"source": "git", "ref": "plugin-releases",
                                                         "url": "https://github.com/ByteRax/x.git"}})
        for name in INSTALLER.RUNTIME_FILES:
            shutil.copyfile(PLUGIN / name, self.runtime / name)
        (self.runtime / "plugin-runtime.json").write_text(json.dumps(
            {"version": INSTALLER._plugin_version(), "plugin_root": str(PLUGIN)}), encoding="utf-8")
        self.loader_line = (self.runtime / "inject-main.cjs").as_uri()
        self.injected_entry = b"console.log('official');\n;import(\"%s\").then(() => null, " \
                              b"(e) => console.error(\"[zusage] load failed\", e));" % self.loader_line.encode()
        # 带宿主包身份（版本取指纹表里登记过的一个），让客户端版本与适配判定走真实分支
        self.host_package = json.dumps({"name": "@zcode/desktop", "version": "3.19.0",
                                        "type": "module"}).encode()
        make_asar(self.asar, files={"out/main/index.js": self.injected_entry, "package.json": self.host_package})
        quiet = contextlib.redirect_stdout(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)
        for module in (REPO_ASAR, PLUGIN_ASAR):
            patched = mock.patch.object(module, "client_running", return_value=False)
            patched.start()
            self.addCleanup(patched.stop)
        bridge = mock.Mock()
        bridge._inspect_deploy.return_value = ("result", {"status": "present", "detail": "deployed"})
        modules = mock.patch.dict(sys.modules, {"renderer_bridge": bridge,
                                                "patch_install": PLUGIN_ASAR})
        modules.start()
        self.addCleanup(modules.stop)
        self.bridge = bridge

    def home_dir(self, name):
        path = self.root / name
        path.mkdir(exist_ok=True)
        return path

    def write_host(self, record=None, market=None):
        """record：None=没有安装记录，True=正常记录，dict=正常记录再加覆盖项。"""
        plugins = []
        if record is not None:
            item = {"id": ID, "name": "zcode-token-usage-statusbar", "marketplace": INSTALLER.MARKETPLACE_ID,
                    "scope": "user", "version": INSTALLER._plugin_version(), "installPath": str(PLUGIN)}
            item.update(record if isinstance(record, dict) else {})
            plugins.append(item)
        (self.storage / "installed_plugins.json").write_text(
            json.dumps({"version": 1, "plugins": plugins}), encoding="utf-8")
        markets = [] if market is None else [market]
        (self.storage / "known_marketplaces.json").write_text(
            json.dumps({"version": 1, "marketplaces": markets}), encoding="utf-8")

    def run_doctor(self):
        runtime, pi = INSTALLER.resolve_paths()
        self.assertIs(pi, PLUGIN_ASAR)
        return INSTALLER.doctor(runtime, pi)

    def assertLine(self, report, level, item, detail=None):
        for line in report.splitlines():
            if line.strip().startswith(f"[{level}] {item}:") and (detail is None or detail in line):
                return line
        self.fail(f"没有找到 [{level}] {item}: …{detail or ''}\n{report}")

    @staticmethod
    def actions(report):
        return [line.strip() for line in report.splitlines() if re.match(r"^\d+\. ", line.strip())]

    def test_healthy_install_reports_no_failure_and_no_action(self):
        report, counts = self.run_doctor()
        self.assertEqual(counts["FAIL"], 0, report)
        self.assertEqual(self.actions(report), [], report)
        self.assertIn("未发现需要处理的问题。", report)
        self.assertRegex(report, r"体检结果: OK \d+ / WARN \d+ / FAIL 0")
        self.assertLine(report, "OK", "状态条注入", "指向当前运行目录")
        self.assertLine(report, "OK", "插件安装登记", str(PLUGIN))
        self.assertLine(report, "OK", "市场登记", "正式 Release 渠道")
        self.assertLine(report, "OK", "运行文件", "与插件来源一致")
        self.assertLine(report, "OK", "客户端版本", "3.19.0")
        self.assertLine(report, "OK", "客户端版本适配", "已登记")

    def test_loader_and_relay_diagnostics_share_the_entry_read(self):
        with mock.patch.object(PLUGIN_ASAR, "entry_bytes_of", wraps=PLUGIN_ASAR.entry_bytes_of) as entry, \
                mock.patch.object(PLUGIN_ASAR, "_archive_snapshot", wraps=PLUGIN_ASAR._archive_snapshot) as archive:
            report, _ = self.run_doctor()
        self.assertLine(report, "OK", "状态条注入", "指向当前运行目录")
        self.assertLine(report, "WARN", "远控中继补丁", "无法检查")
        entry.assert_not_called()
        archive.assert_called_once_with(self.asar)

    def test_doctor_changes_nothing_on_disk(self):
        (self.runtime / "quota-secrets.json").write_text('{"token":"SECRET-SENTINEL-123"}', encoding="utf-8")
        before = {name: snapshot(path) for name, path in (("runtime", self.runtime),
                                                          ("asar", self.root), ("storage", self.storage),
                                                          ("host", self.config.parent))}
        report, _ = self.run_doctor()
        after = {name: snapshot(path) for name, path in (("runtime", self.runtime),
                                                         ("asar", self.root), ("storage", self.storage),
                                                         ("host", self.config.parent))}
        self.assertEqual(after, before)
        self.assertNotIn("SECRET-SENTINEL-123", report)
        self.assertNotIn("quota-secrets", report)

    def test_missing_injection_asks_for_install(self):
        make_asar(self.asar, files={"out/main/index.js": b"console.log('official');",
                                    "package.json": self.host_package})
        report, counts = self.run_doctor()
        self.assertGreaterEqual(counts["FAIL"], 1)
        self.assertLine(report, "FAIL", "状态条注入", "未注入")
        self.assertEqual(self.actions(report), ["1. 运行 /install-overlay；新建或恢复会话也会自动安装"], report)

    def test_loader_pointing_elsewhere_is_a_warning(self):
        elsewhere = (self.root / "old-runtime" / "inject-main.cjs").as_uri()
        entry = self.injected_entry.replace(self.loader_line.encode(), elsewhere.encode())
        make_asar(self.asar, files={"out/main/index.js": entry})
        report, counts = self.run_doctor()
        self.assertLine(report, "WARN", "状态条注入", "指向另一个目录")
        self.assertNotIn("FAIL", "".join(line for line in report.splitlines() if "状态条注入" in line))

    def test_unwritable_target_is_fatal_only_while_not_injected(self):
        make_asar(self.asar, files={"out/main/index.js": b"console.log('official');"})
        with mock.patch.object(PLUGIN_ASAR, "target_writable", return_value=False):
            report, _ = self.run_doctor()
        self.assertLine(report, "FAIL", "安装目录可写", "受保护目录")
        self.assertIn("管理员身份或 sudo", report)
        make_asar(self.asar, files={"out/main/index.js": self.injected_entry})
        with mock.patch.object(PLUGIN_ASAR, "target_writable", return_value=False):
            report, _ = self.run_doctor()
        self.assertLine(report, "WARN", "安装目录可写", "受保护目录")

    def test_pending_install_wants_a_full_quit(self):
        make_asar(self.asar, files={"out/main/index.js": b"console.log('official');",
                                    "package.json": self.host_package})
        REPO_ASAR.set_target(self.asar)
        REPO_ASAR.set_runtime(self.runtime)
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(REPO_ASAR, "syntax_check", return_value=True))
            stack.enter_context(mock.patch.object(REPO_ASAR, "launch_monitor", return_value=None))
            REPO_ASAR.prepare_tmp({"/" + REPO_ASAR.ENTRY: self.injected_entry})
        with mock.patch.object(PLUGIN_ASAR, "monitor_instance_lock",
                               side_effect=lambda: contextlib.nullcontext(True)):
            report, counts = self.run_doctor()
        self.assertLine(report, "FAIL", "待替换包", "收尾监控没在运行")
        self.assertLine(report, "FAIL", "状态条注入", "安装已排定")
        # 重跑 /install-overlay 只会复用同一个待替换包：建议动作里不能出现它
        self.assertEqual(self.actions(report), [
            "1. 安装已排定，但现在没有收尾监控：重新打开 ZCode 并新建会话会自动补拉；"
            "仍不生效时完全退出 ZCode 后，按 /install-overlay 输出里的命令手动收尾"], report)
        with mock.patch.object(PLUGIN_ASAR, "monitor_instance_lock",
                               side_effect=lambda: contextlib.nullcontext(False)):
            report, counts = self.run_doctor()
        self.assertLine(report, "FAIL", "待替换包", "收尾监控在运行")
        self.assertEqual(self.actions(report), [
            "1. 安装已排定：完全退出 ZCode（从托盘退出，只关窗口不算）让收尾监控完成替换，"
            "再重新打开；不需要重跑安装"], report)

    def test_disabled_plugin_and_missing_record_are_fatal(self):
        self.config.write_text(json.dumps({"plugins": {"enabledPlugins": {ID: False}}}), encoding="utf-8")
        report, _ = self.run_doctor()
        self.assertLine(report, "FAIL", "插件启用状态", "已被禁用")
        self.assertRegex(report, r"1\. 在 ZCode 设置的插件管理里启用")
        self.config.write_text("{not json", encoding="utf-8")
        report, _ = self.run_doctor()
        self.assertLine(report, "FAIL", "插件启用状态", "判断不了是否启用")
        self.write_host()
        report, _ = self.run_doctor()
        self.assertLine(report, "FAIL", "插件安装登记", "没有本插件的安装记录")
        self.write_host(record={"installPath": str(self.root / "gone")})
        report, _ = self.run_doctor()
        self.assertLine(report, "FAIL", "插件安装登记", "安装目录不存在")

    def test_master_switch_off_is_fatal_and_default_is_enabled(self):
        self.config.write_text(json.dumps({"plugins": {"enabled": False}}), encoding="utf-8")
        report, _ = self.run_doctor()
        self.assertLine(report, "FAIL", "插件启用状态", "总开关已关闭")
        self.config.write_text("{}", encoding="utf-8")
        report, _ = self.run_doctor()
        self.assertLine(report, "OK", "插件启用状态", "按默认启用")

    def test_source_marketplace_is_flagged(self):
        self.write_host(market={"id": INSTALLER.MARKETPLACE_ID,
                                "source": {"source": "git",
                                           "url": "https://github.com/ByteRax/x.git"}})
        report, _ = self.run_doctor()
        self.assertLine(report, "WARN", "市场登记", "仓库源码")
        self.assertIn("#plugin-releases", report)
        self.write_host(market={"id": INSTALLER.MARKETPLACE_ID,
                                "source": {"source": "git", "ref": "plugin-releases-gitcode",
                                           "url": "https://gitcode.com/tanranran/x.git"}})
        report, _ = self.run_doctor()
        self.assertLine(report, "OK", "市场登记", "GitCode")
        self.write_host()
        report, _ = self.run_doctor()
        self.assertLine(report, "WARN", "市场登记", "没有 zusage-marketplace")

    def test_runtime_drift_and_optout_and_restart_marker(self):
        (self.runtime / "overlay.js").write_text("// drifted", encoding="utf-8")
        (self.runtime / "turn-stats.js").unlink()
        (self.runtime / ".plugin-overlay-optout").write_text("", encoding="utf-8")
        (self.runtime / ".plugin-restart-required").write_text(
            json.dumps({"state": "installed", "version": "9.9.9"}), encoding="utf-8")
        report, _ = self.run_doctor()
        self.assertLine(report, "WARN", "运行文件", "缺失 turn-stats.js")
        self.assertLine(report, "WARN", "运行文件", "与插件来源不同 overlay.js")
        self.assertLine(report, "WARN", "自动安装豁免", ".plugin-overlay-optout")
        self.assertLine(report, "WARN", "待重启改动", "installed v9.9.9")

    def test_corrupt_runtime_config_and_faulty_session_record(self):
        (self.runtime / "config.json").write_text("{broken", encoding="utf-8")
        (self.runtime / "plugin-session-start.json").write_text(json.dumps({
            "time": 1700000000, "source": "startup",
            "result": {"hookSpecificOutput": {"additionalContext": "状态条自动安装未完成"}},
            "host": {"hostBuild": "1.2.3", "injected": False}}), encoding="utf-8")
        report, _ = self.run_doctor()
        self.assertLine(report, "FAIL", "配置文件", "config.json 损坏")
        self.assertLine(report, "WARN", "会话启动记录", "状态条自动安装未完成")

    def test_update_state_is_summarised(self):
        (self.runtime / "plugin-update.json").write_text(
            json.dumps({"lastError": {"message": "api.github.com unreachable"}}), encoding="utf-8")
        report, _ = self.run_doctor()
        self.assertLine(report, "WARN", "更新记录", "api.github.com unreachable")
        (self.runtime / "config.json").write_text(json.dumps({"plugin_auto_update": False}), encoding="utf-8")
        report, _ = self.run_doctor()
        self.assertLine(report, "WARN", "自动更新", "已显式关闭")

    def test_missing_bridge_and_unregistered_host_are_warnings(self):
        self.bridge._inspect_deploy.return_value = ("patch", (None, None, None, None, "9.9.9",
                                                              False, False, "/a.js", b"", b"patched"))
        with mock.patch.object(INSTALLER, "_host_registered", return_value=False):
            report, counts = self.run_doctor()
        self.assertLine(report, "WARN", "逐问速率行补丁", "未打上")
        self.assertLine(report, "WARN", "客户端版本适配", "还没有登记 ZCode 3.19.0")

    def test_derived_bridge_counts_as_adapted(self):
        with mock.patch.object(INSTALLER, "_host_registered", return_value=False):
            report, _ = self.run_doctor()
        self.assertLine(report, "OK", "客户端版本适配", "按结构推导适配")

    def test_missing_entry_still_reports_host_version(self):
        make_asar(self.asar, files={"package.json": self.host_package})
        report, _ = self.run_doctor()
        self.assertLine(report, "OK", "客户端版本", "3.19.0")
        self.assertLine(report, "FAIL", "客户端与注入", "这一组检查没能完成")

    def test_one_failing_section_does_not_hide_the_rest(self):
        with mock.patch.object(INSTALLER, "_host_build", side_effect=OSError("boom")):
            report, counts = self.run_doctor()
        self.assertLine(report, "FAIL", "客户端与注入", "这一组检查没能完成")
        self.assertLine(report, "OK", "待替换包", "无")
        self.assertLine(report, "OK", "插件启用状态", "已启用")

    def test_actions_are_ranked_and_deduplicated(self):
        make_asar(self.asar, files={"out/main/index.js": b"console.log('official');"})
        (self.runtime / "overlay.js").write_text("// drifted", encoding="utf-8")
        self.config.write_text(json.dumps({"plugins": {"enabledPlugins": {ID: False}}}), encoding="utf-8")
        report, _ = self.run_doctor()
        actions = self.actions(report)
        self.assertRegex(actions[0], r"^1\. 在 ZCode 设置的插件管理里启用")
        self.assertRegex(actions[1], r"^2\. 运行 /install-overlay")
        self.assertRegex(actions[2], r"^3\. 运行 /install-overlay 重新同步运行目录")
        self.assertEqual(len(actions), 3)
        self.assertEqual(len(actions), len(set(actions)))

    def test_storage_dir_resolution_follows_the_host(self):
        with mock.patch.dict(os.environ, {"ZCODE_STORAGE_DIR": ""}):
            self.assertEqual(INSTALLER._doctor_storage(), self.home / ".zcode" / "cli" / "plugins")
            self.config.write_text(json.dumps({"storage": {"dir": "~/elsewhere"}}), encoding="utf-8")
            self.assertEqual(INSTALLER._doctor_storage(), self.home / "elsewhere" / "cli" / "plugins")
            absolute = self.root / "abs" / "cli"
            self.config.write_text(json.dumps({"storage": {"dir": str(absolute)}}), encoding="utf-8")
            # 绝对路径原样跟随：不拼家目录，已以 cli 结尾就不再补一层。不用 "/abs/cli" 这种 POSIX 形态的
            # 字面量当期望——它在 Windows 上是无盘符的根路径，产品会按家目录所在盘符解析（平台语义）
            self.assertEqual(INSTALLER._doctor_storage(), absolute / "plugins")
            self.config.write_text("{broken", encoding="utf-8")
            self.assertEqual(INSTALLER._doctor_storage(), self.home / ".zcode" / "cli" / "plugins")

    def test_main_prints_only_the_report_and_exits_cleanly_without_an_asar(self):
        # 探测不到任何归档（候选清空、测试接缝撤销）：仍输出完整报告，正常返回
        self.asar.unlink()
        out, errors = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ), mock.patch.object(sys, "argv", ["overlay_install.py", "doctor"]), \
                mock.patch.object(INSTALLER, "asar_candidates", return_value=[]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(errors):
            for name in ("ZUSAGE_PLUGIN_ASAR", "ZCODE_ASAR"):
                os.environ.pop(name, None)
            self.assertIsNone(INSTALLER.main())
        report = out.getvalue()
        self.assertEqual(errors.getvalue(), "")
        self.assertTrue(report.startswith("zcode-token-usage-statusbar 体检（只读）"), report)
        self.assertLine(report, "FAIL", "客户端归档", "没有找到 ZCode 的 app.asar")
        self.assertRegex(report, r"FAIL [1-9]")
        self.assertRegex(report, r"1\. 确认 ZCode 桌面客户端的安装位置")

    def test_main_fails_loudly_when_the_doctor_itself_breaks(self):
        out, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["overlay_install.py", "doctor"]), \
                mock.patch.object(INSTALLER, "doctor", side_effect=RuntimeError("exploded")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as exit_code:
                INSTALLER.main()
        self.assertEqual(exit_code.exception.code, 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("体检未能完成", errors.getvalue())

    def test_command_file_is_registered_for_packaging(self):
        command = PLUGIN / "commands" / "zusage-doctor.md"
        text = command.read_text(encoding="utf-8")
        self.assertIn('overlay_install.py" doctor', text)
        for rel in (".zcode-plugin/plugin.json", ".claude-plugin/plugin.json"):
            self.assertIn("plugins/zcode-token-usage-statusbar/commands/zusage-doctor.md",
                          json.loads((PLUGIN / rel).read_text(encoding="utf-8"))["packageLayout"]["files"])
        tool = load_module("doctor_release_tool", ROOT / "release_tool.py")
        self.assertIn("plugins/zcode-token-usage-statusbar/commands/zusage-doctor.md", tool.NAMES)


if __name__ == "__main__":
    unittest.main()
