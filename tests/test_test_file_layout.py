# -*- coding: utf-8 -*-
"""tests/test_*.py 的文件布局契约：定义了 TestCase 的测试模块必须恰好有一个
`if __name__ == "__main__":` 守卫，且它是文件最后一条语句。

守卫落在文件中段时，discover 与 `-m unittest` 照常收集全部用例（假绿），直接按脚本跑却只执行
它之前定义的用例——用例追加在它后面就永远不会被执行；没有守卫时按脚本跑是退出码 0 的空跑。
先例：test_speed_history 的中段块让新增的三例按脚本跑时缺席，另外三个文件同样只剩前半截能跑。
"""
import ast
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent


def is_main_test(test):
    """"__main__" == __name__（任一操作数顺序，只认等号比较），含 and 链里的子条件。"""
    if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.And):
        return any(is_main_test(value) for value in test.values)
    if not isinstance(test, ast.Compare) or len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        return False
    operands = [test.left, *test.comparators]
    return (any(isinstance(node, ast.Name) and node.id == "__name__" for node in operands)
            and any(isinstance(node, ast.Constant) and node.value == "__main__" for node in operands))


def defines_test_cases(tree):
    return any(isinstance(node, ast.ClassDef) and any(
        (isinstance(base, ast.Attribute) and base.attr == "TestCase")
        or (isinstance(base, ast.Name) and base.id == "TestCase") for base in node.bases)
        for node in ast.walk(tree))


class TestFileLayoutTests(unittest.TestCase):
    def test_main_guard_is_the_last_statement_of_every_test_module(self):
        modules = sorted(TESTS.glob("test_*.py"))
        self.assertIn(TESTS / "test_token_rate.py", modules, "测试目录没找到用例文件")
        checked = 0
        for path in modules:
            with self.subTest(module=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
                if not defines_test_cases(tree):
                    continue   # 夹具与辅助模块不按脚本跑
                checked += 1
                # 全树找守卫：嵌在 try / if 里、或写进函数体的都算，它们同样到不了模块末尾。
                guards = [node for node in ast.walk(tree)
                          if isinstance(node, ast.If) and is_main_test(node.test)]
                self.assertEqual(len(guards), 1, "恰好一个 __main__ 守卫（没有守卫时按脚本跑是空跑）")
                self.assertIs(guards[0], tree.body[-1],
                              "__main__ 守卫必须是文件最后一条语句：其后的用例按脚本直跑时不会执行，"
                              "嵌在别的语句里则按脚本跑到不了")
        self.assertGreater(checked, 50, "契约要覆盖到测试模块")


if __name__ == "__main__":
    unittest.main()
