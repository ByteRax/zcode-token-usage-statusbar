# -*- coding: utf-8 -*-
"""README 安装文案的自包含契约。

宿主不提供单独的 zcode 命令，也不给代理任何「怎么装插件」的指引，代理只能靠文案本身。
这里锁定三份 README 的安装文案包含 tests/install-prompt-smoke.py 实跑的每一条命令，
并且不再把「怎么执行安装」留给代理自己摸索。
"""
import re
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tests.helpers.py_test_support import load_module  # noqa: E402

SMOKE = load_module("install_prompt_smoke_contract", ROOT / "tests" / "install-prompt-smoke.py")
README = ("README.md", "README.zh-CN.md", "README.en.md")
ANCHOR = "plugins marketplace add"


def install_prompt(name):
    """安装文案 = 含 plugins marketplace add 的那个 text 代码块（README 里另有别的 text 块）。"""
    blocks = [block for block in re.findall(r"^```text\n(.*?)\n```", (ROOT / name).read_text(encoding="utf-8"),
                                          re.S | re.M) if ANCHOR in block]
    if len(blocks) != 1:
        raise AssertionError("%s 里含 %r 的 text 代码块应有 1 个，实际 %d 个" % (name, ANCHOR, len(blocks)))
    return blocks[0]


class InstallPromptContractTests(unittest.TestCase):
    def test_chinese_readmes_stay_identical(self):
        self.assertEqual((ROOT / "README.md").read_bytes(), (ROOT / "README.zh-CN.md").read_bytes())

    def test_prompt_contains_every_command_the_smoke_runs(self):
        # 两条 plugins 命令在文案里各占一整行，整行相等才算数：只做子串包含的话，
        # 脚本常量被改弱（如去掉 --json）时仍然会放行。
        commands = (SMOKE.ADD_COMMAND % SMOKE.CHANNELS["github"], SMOKE.INSTALL_COMMAND)
        # 安装器命令嵌在第 2 步的句子里，路径是占位符：除路径外逐字一致，同一行后面不能再跟别的参数
        # （参数形如 --force、extra 或中文词，前面隔普通空格、制表符、不换行空格或反斜杠续行都算；
        #   换行、括号、逗号等标点续写不算参数）
        overlay = re.escape(SMOKE.OVERLAY_COMMAND).replace("%s", '[^"]*') + r"(?![^\S\r\n]*[\w\\-])"
        needles = ("ELECTRON_RUN_AS_NODE=1", "resources/glm/zcode.cjs", SMOKE.CHANNELS["gitcode"])
        for name in README:
            with self.subTest(readme=name):
                prompt = install_prompt(name)
                lines = [line.strip() for line in prompt.splitlines()]
                for command in commands:
                    self.assertIn(command, lines, "%s 的安装文案里没有这一整行命令：%s" % (name, command))
                self.assertRegex(prompt, overlay, "%s 的安装文案里没有安装器命令：%s" % (name, SMOKE.OVERLAY_COMMAND))
                for needle in needles:
                    self.assertIn(needle, prompt, "%s 的安装文案缺少：%s" % (name, needle))

    def test_prompt_spells_out_the_overlay_instead_of_naming_a_command(self):
        # 旧文案只说「在对话中执行 /install-overlay」：插件刚装好时当前会话里还没有这条命令，
        # 代理只能自行摸索。新文案直接给出安装器脚本的调用方式。
        for name in README:
            with self.subTest(readme=name):
                prompt = install_prompt(name)
                self.assertNotIn("/install-overlay", prompt)
                self.assertIn("installPath", prompt)

    def test_prompt_asks_for_a_full_quit_and_forbids_silent_skips(self):
        expectations = {
            "README.md": ("完全退出", "不要自动重启", "原样转述错误", "声称安装成功"),
            "README.zh-CN.md": ("完全退出", "不要自动重启", "原样转述错误", "声称安装成功"),
            "README.en.md": ("quit ZCode completely", "do not restart it automatically",
                             "relay the error as is", "claim installation succeeded"),
        }
        for name, needles in expectations.items():
            with self.subTest(readme=name):
                prompt = install_prompt(name)
                for needle in needles:
                    self.assertIn(needle, prompt, "%s 的安装文案缺少：%s" % (name, needle))


if __name__ == "__main__":
    unittest.main()
