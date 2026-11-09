# -*- coding: utf-8 -*-
"""WorkBuddy 专用插件构建（plugins/workbuddy-token-usage）的契约回归。

这份构建与 ZCode 插件包是两条链：只带 MCP + /usage，**不能**带 hooks（否则 WorkBuddy
会话会去改 ZCode 的 app.asar）。测试锁住三件事：清单能被 WorkBuddy 读、没有 hooks、
运行时副本与根文件一致（副本是生成物，改了根忘了同步会在这里失败）。
"""
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "workbuddy-token-usage"

spec = importlib.util.spec_from_file_location("sync_wb_plugin", ROOT / "scripts" / "sync_workbuddy_plugin.py")
sync_wb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync_wb)


class WorkBuddyPluginPackageTests(unittest.TestCase):
    def test_manifest_is_workbuddy_native_and_declares_mcp(self):
        manifest = json.loads((PLUGIN / ".codebuddy-plugin" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "workbuddy-token-usage")
        self.assertRegex(manifest["version"], r"^\d+\.\d+\.\d+$")
        server = manifest["mcpServers"]["zusage"]
        # WorkBuddy 用 ${CODEBUDDY_PLUGIN_ROOT} 展开插件目录；写成绝对路径会在升级后失效
        self.assertIn("${CODEBUDDY_PLUGIN_ROOT}/usage_mcp.py", server["args"])
        self.assertEqual(server["env"]["ZUSAGE_HOST"], "workbuddy")   # 默认读 WorkBuddy 库
        self.assertEqual(manifest["commands"], ["./commands/usage.md"])

    def test_no_zcode_only_hooks_or_asar_chain(self):
        self.assertFalse((PLUGIN / "hooks").exists(), "WorkBuddy 构建不应带 hooks（会去改 ZCode 的 asar）")
        for name in ("overlay_install.py", "patch_install.py", "inject-main.cjs", "overlay.js"):
            self.assertFalse((PLUGIN / name).exists(), f"WorkBuddy 构建不应打包 {name}")
        manifest = (PLUGIN / ".codebuddy-plugin" / "plugin.json").read_text(encoding="utf-8")
        self.assertNotIn("hooks", json.loads(manifest))

    def test_marketplace_lists_the_plugin_from_its_own_root(self):
        market = json.loads((PLUGIN / "marketplace.json").read_text(encoding="utf-8"))
        self.assertEqual(market["name"], "workbuddy-token-usage")
        entries = {p["name"]: p for p in market["plugins"]}
        self.assertIn("workbuddy-token-usage", entries)
        self.assertEqual(entries["workbuddy-token-usage"]["source"], "./")
        version = json.loads((PLUGIN / ".codebuddy-plugin" / "plugin.json").read_text(encoding="utf-8"))["version"]
        self.assertEqual(entries["workbuddy-token-usage"]["version"], version)   # 两份清单版本必须一致

    def test_marketplace_manifest_is_where_the_client_reads_it(self):
        """客户端只在 <市场目录>/.codebuddy-plugin/marketplace.json 找市场清单
        （候选目录 ['.codebuddy-plugin','.workbuddy-plugin','.claude-plugin']）。
        只放根目录会导致 listPlugins 为空 → 报 'plugin not found in marketplace'，
        连带 MCP server 不注册、插件在界面里不可见。两份必须逐字节一致。"""
        nested = PLUGIN / ".codebuddy-plugin" / "marketplace.json"
        self.assertTrue(nested.is_file(), "市场清单必须放在 .codebuddy-plugin/ 下")
        self.assertEqual(nested.read_bytes(), (PLUGIN / "marketplace.json").read_bytes())

    def test_command_frontmatter_has_description_and_hint(self):
        text = (PLUGIN / "commands" / "usage.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        head = text.split("\n---\n", 1)[0]
        self.assertIn("description:", head)
        self.assertIn("argument-hint:", head)
        self.assertIn("token_usage", text)      # 取数入口写清楚，模型才知道调什么
        self.assertIn("不可得", text)            # WorkBuddy 缺项要如实转述

    def test_skill_entry_gives_a_second_discoverable_surface(self):
        """命令（/usage）之外再给一个技能入口：宿主把技能列进可用能力，
        命令只在斜杠菜单里，两条路都指向同一个 token_usage 查询。"""
        manifest = json.loads((PLUGIN / ".codebuddy-plugin" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["skills"], ["./skills/token-usage"])
        skill = PLUGIN / "skills" / "token-usage" / "SKILL.md"
        self.assertTrue(skill.is_file())
        head = skill.read_text(encoding="utf-8").split("\n---\n", 1)[0]
        self.assertIn("name: token-usage", head)
        self.assertIn("description:", head)
        self.assertIn("token_usage", skill.read_text(encoding="utf-8"))

    def test_runtime_copies_match_repo_root(self):
        for name in sync_wb.FILES:
            with self.subTest(name=name):
                src, dst = ROOT / name, PLUGIN / name
                self.assertTrue(dst.is_file(), f"{name} 未同步（运行 python scripts/sync_workbuddy_plugin.py）")
                self.assertEqual(src.read_bytes(), dst.read_bytes(), f"{name} 副本与根文件不一致")


class PageScriptSyntaxTests(unittest.TestCase):
    """PAGE_SCRIPT 是嵌在宿主文件模板字符串里的页面脚本：宿主文件 `node --check` 过了
    不代表它能跑——字符串少个引号、多插一个换行，页面里就是 SyntaxError，
    注入器每 tick 都失败、状态条整条不出现（踩过：滑杆图标的 `<circle>` 行少收引号）。
    这里把脚本抽出来单独做语法检查。"""

    def test_embedded_page_script_parses(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("需要 node 才能校验页面脚本语法")
        src = (ROOT / "wb-overlay.cjs").read_text(encoding="utf-8")
        start = "const PAGE_SCRIPT = `"
        i = src.index(start) + len(start)
        j = src.index("`;", i)
        script = src[i:j].replace("${PAGE_VERSION}", "wb-test")
        self.assertIn("__zusageWB_update", script)      # 抽到的是整段脚本，不是被截断的半截
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "page-script.js"
            path.write_text(script, encoding="utf-8")
            done = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, "页面脚本语法错误：\n" + (done.stderr or done.stdout))


if __name__ == "__main__":
    unittest.main()
