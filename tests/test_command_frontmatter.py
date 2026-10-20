# -*- coding: utf-8 -*-
"""命令 frontmatter 白名单回归：防止带通道副作用的心智字段再次进入桌面 / 补全。

3.16.2 实证：引擎把 `disable-noninteractive: true` 解析为 disableNonInteractive，
listProtocolSlashCommands 会将此类命令整体排除出桌面协议补全（终端 CLI 仍可见），
官方文档「是否在非交互模式下禁用」的描述与桌面行为不一致。因此本项目白名单
只放行已验证无副作用的 description / argument-hint；要加新字段先在目标引擎
源码确认所有暴露通道（桌面补全 / CLI / 非交互）的实际语义，再更新本白名单。
"""
import re
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "zcode-token-usage-statusbar"
COMMANDS = PLUGIN / "commands"
ALLOWED_KEYS = {"description", "argument-hint"}
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_:-]{0,63}$")


def parse_frontmatter(path):
    text = path.read_text(encoding="utf-8")
    prefix = "---\n"
    if not text.startswith(prefix):
        return None, "缺少 frontmatter 起始 ---"
    end = text.find("\n---\n", len(prefix))
    if end < 0:
        return None, "缺少 frontmatter 结束 ---"
    fields = {}
    for line in text[len(prefix):end].splitlines():
        if not line.strip():
            continue
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields, None


class CommandFrontmatterTest(unittest.TestCase):
    def test_every_command_frontmatter_is_whitelisted(self):
        files = sorted(COMMANDS.glob("*.md"))
        self.assertTrue(files, "commands 目录没有命令文件")
        for path in files:
            with self.subTest(command=path.name):
                fields, error = parse_frontmatter(path)
                self.assertIsNone(error, f"{path.name}: {error}")
                unknown = set(fields) - ALLOWED_KEYS
                self.assertEqual(unknown, set(),
                                 f"{path.name} 含白名单外字段 {sorted(unknown)}；"
                                 "新字段须先核对引擎各通道语义再放宽 ALLOWED_KEYS")
                self.assertTrue(fields.get("description"), f"{path.name} 缺 description")

    def test_command_file_names_match_host_rule(self):
        for path in COMMANDS.glob("*.md"):
            with self.subTest(command=path.name):
                self.assertRegex(path.stem, NAME_PATTERN,
                                 f"{path.name} 不满足宿主命令命名规则")


if __name__ == "__main__":
    unittest.main()
