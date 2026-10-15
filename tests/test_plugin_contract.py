# -*- coding: utf-8 -*-
import base64
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "zcode-token-usage-statusbar"


def prompt_hook():
    spec = importlib.util.spec_from_file_location("prompt_contract_test", PLUGIN / "hooks/prompt-submit.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stats_command(module, sid):
    line = module.turn_stats_instruction(sid)[2]
    return line.split("运行一次:", 1)[1]


class PluginContractTests(unittest.TestCase):
    def test_marketplace_localizes_descriptions_not_plugin_manifests(self):
        market = json.loads((ROOT / "marketplace.json").read_text(encoding="utf-8"))
        entry = next(item for item in market["plugins"] if item["name"] == PLUGIN.name)
        translations = entry["description_i18n"]
        self.assertEqual(translations["zh-CN"], entry["description"])
        self.assertIn("app.asar", translations["en"])
        self.assertIn("quit", translations["en"])
        self.assertIn("opt-out", translations["en"])
        for directory in (".zcode-plugin", ".claude-plugin"):
            manifest = json.loads((PLUGIN / directory / "plugin.json").read_text(encoding="utf-8"))
            self.assertNotIn("description_i18n", manifest)
            self.assertEqual(translations["en"], manifest["description"])
            self.assertEqual(manifest["homepage"], manifest["repository"])

    def test_release_catalog_preserves_marketplace_localization(self):
        spec = importlib.util.spec_from_file_location("contract_release_tool", ROOT / "release_tool.py")
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        with tempfile.TemporaryDirectory(prefix="zusage-contract-release-") as temporary:
            result = tool.build(ROOT, "ByteRax/zcode-token-usage-statusbar", Path(temporary) / "out")
            catalog = json.loads(Path(result["catalog"]).read_text(encoding="utf-8"))
            market = json.loads((ROOT / "marketplace.json").read_text(encoding="utf-8"))
            self.assertEqual(catalog["plugins"][0]["description_i18n"],
                             market["plugins"][0]["description_i18n"])

    def test_hook_matcher_and_timeouts_match_host_contract(self):
        hooks = json.loads((PLUGIN / "hooks/hooks.json").read_text(encoding="utf-8"))["hooks"]
        start = hooks["SessionStart"][0]
        self.assertEqual(start["matcher"], "startup|resume")
        self.assertEqual(start["hooks"][0]["timeoutMs"], 60000)
        self.assertEqual(hooks["UserPromptSubmit"][0]["hooks"][0]["timeoutMs"], 8000)

    def test_mcp_declaration_uses_short_service_key_and_same_script(self):
        servers = json.loads((PLUGIN / ".mcp.json").read_text(encoding="utf-8"))["mcpServers"]
        self.assertEqual(list(servers), ["zusage"])
        self.assertEqual(servers["zusage"]["args"], ["${ZCODE_PLUGIN_ROOT}/usage_mcp.py"])

    def test_stats_command_round_trips_paths_and_session_for_bash(self):
        module = prompt_hook()
        for interpreter in ("/tmp/Python $HOME `uname` 'quoted'/python3",
                            r"C:\Program Files\Python\python.exe"):
            with self.subTest(interpreter=interpreter), mock.patch.object(module.sys, "executable", interpreter), \
                    mock.patch.object(module.sys, "platform", "darwin"), \
                    mock.patch.object(module, "RATE_SCRIPT", Path("/tmp/plugin $HOME 'quoted'/token_rate.py")):
                sid = "sess_$HOME 'quoted';exit"
                self.assertEqual(shlex.split(stats_command(module, sid)),
                                 [interpreter, str(module.RATE_SCRIPT), "--turn", "--current", "--session", sid])

    def test_windows_stats_command_wraps_literal_arguments_for_cmd_and_git_bash(self):
        module = prompt_hook()
        interpreter = r"C:\Program Files\Python\python.exe"
        script = Path("C:/plugin $HOME %PATH% 'quoted' O\u2018\u2019\u201a\u201bBrien/token_rate.py")
        sid = "sess_$HOME %PATH% 'quoted';exit"
        with mock.patch.object(module.sys, "platform", "win32"), \
                mock.patch.object(module.sys, "executable", interpreter), \
                mock.patch.object(module, "RATE_SCRIPT", script):
            outer = shlex.split(stats_command(module, sid))
        self.assertEqual(outer[:4], ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
        self.assertRegex(outer[4], r"^[A-Za-z0-9+/]+=*$")
        payload = base64.b64decode(outer[4], validate=True).decode("utf-16le")
        literal = lambda text: "'" + text.replace("'", "''") + "'"
        escaped_script = str(script)
        for quote in "'\u2018\u2019\u201a\u201b":
            escaped_script = escaped_script.replace(quote, quote * 2)
        literals = [literal(interpreter), "'" + escaped_script + "'", literal("--turn"), literal("--current"),
                    literal("--session"), literal(sid)]
        self.assertEqual(payload, "$ErrorActionPreference = 'Stop'; & " + " ".join(literals) + "; exit $LASTEXITCODE")

    def run_native_windows_command(self, git_bash=False):
        module = prompt_hook()
        with tempfile.TemporaryDirectory(prefix="zusage-cmd-") as temporary:
            script = Path(temporary) / "rate $HOME %PATH% O\u2019Brien 'quoted'.py"
            script.write_text("import json, sys\nprint(json.dumps(sys.argv[1:]))\n", encoding="utf-8")
            with mock.patch.object(module, "RATE_SCRIPT", script):
                command = stats_command(module, "sess_$HOME %PATH% 'quoted'")
            runner = shutil.which("bash.exe") if git_bash else None
            result = subprocess.run([runner, "-c", command] if runner else command, shell=not git_bash,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), ["--turn", "--current", "--session", "sess_$HOME %PATH% 'quoted'"])
            script.write_text("import sys\nsys.exit(7)\n", encoding="utf-8")
            result = subprocess.run([runner, "-c", command] if runner else command, shell=not git_bash,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 7, result.stderr)
            with mock.patch.object(module.sys, "executable", str(Path(temporary) / "missing.exe")), \
                    mock.patch.object(module, "RATE_SCRIPT", script):
                command = stats_command(module, "sess_fixture")
            result = subprocess.run([runner, "-c", command] if runner else command, shell=not git_bash,
                                    capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)

    @unittest.skipUnless(sys.platform == "win32", "requires native Windows CMD and Windows PowerShell")
    def test_windows_stats_command_executes_in_native_cmd(self):
        self.run_native_windows_command()

    @unittest.skipUnless(sys.platform == "win32" and shutil.which("bash.exe"),
                         "requires native Windows Git Bash and Windows PowerShell")
    def test_windows_stats_command_executes_in_native_git_bash(self):
        self.run_native_windows_command(git_bash=True)

    def test_stats_command_falls_back_without_session_or_executable(self):
        module = prompt_hook()
        with mock.patch.object(module.sys, "executable", ""), mock.patch.object(module.sys, "platform", "darwin"):
            self.assertEqual(shlex.split(stats_command(module, "")),
                             ["python3", str(module.RATE_SCRIPT), "--turn", "--current"])

    @unittest.skipIf(sys.platform == "win32", "real POSIX shell probe; argv quoting is tested on all platforms")
    def test_stats_command_executes_literal_path_in_real_shell(self):
        module = prompt_hook()
        with tempfile.TemporaryDirectory(prefix="zusage-shell-") as temporary:
            script = Path(temporary) / "rate $HOME 'quoted'.py"
            script.write_text("import json, sys\nprint(json.dumps(sys.argv[1:]))\n", encoding="utf-8")
            with mock.patch.object(module, "RATE_SCRIPT", script):
                command = stats_command(module, "sess_$HOME 'quoted'")
            result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), ["--turn", "--current", "--session", "sess_$HOME 'quoted'"])


if __name__ == "__main__":
    unittest.main()
