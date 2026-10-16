# -*- coding: utf-8 -*-
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "zcode-token-usage-statusbar"


def prompt_hook():
    spec = importlib.util.spec_from_file_location("prompt_contract_test", PLUGIN / "hooks/prompt-submit.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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

    def test_prompt_hook_no_longer_injects_model_instruction(self):
        # 统计行已改为确定性渲染（overlay.js 经 renderer 只读桥插入），hook 不再要求
        # 模型自跑 token_rate.py；但背景行 / 重启提醒 / 开关判断通道必须保留。
        source = (PLUGIN / "hooks/prompt-submit.py").read_text(encoding="utf-8")
        module = prompt_hook()
        self.assertFalse(hasattr(module, "turn_stats_instruction"), source[:200])
        for banned in ("本轮统计指令", "运行一次:", "Markdown 引用块", "RATE_SCRIPT",
                       "base64", "shlex"):
            self.assertNotIn(banned, source, banned)
        for required in ("【内部背景·勿展示】", "answer_rate_line", "reminder_context",
                         "write_session_state", "emit"):
            self.assertIn(required, source, required)
        self.assertTrue(hasattr(module, "rate_line_enabled"))
        self.assertTrue(hasattr(module, "emit"))


if __name__ == "__main__":
    unittest.main()
