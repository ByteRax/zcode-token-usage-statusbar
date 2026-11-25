# -*- coding: utf-8 -*-
"""tests/test_*.py 的文件布局契约：`if __name__ == "__main__":` 块只能是文件最后一条语句。

落在文件中段时，discover 与 `-m unittest` 照常收集全部用例（假绿），直接按脚本跑却只执行
它之前定义的用例——用例追加在它后面就永远不会被执行。先例：test_speed_history 的中段块让
新增的三例按脚本跑时缺席，另外三个文件同样只剩前半截能跑。
"""
import ast
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent


def is_main_guard(node):
    return (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
            and isinstance(node.test.left, ast.Name) and node.test.left.id == "__name__"
            and len(node.test.comparators) == 1
            and isinstance(node.test.comparators[0], ast.Constant)
            and node.test.comparators[0].value == "__main__")


class TestFileLayoutTests(unittest.TestCase):
    def test_main_guard_is_the_last_statement_of_every_test_module(self):
        modules = sorted(TESTS.glob("test_*.py"))
        self.assertIn(TESTS / "test_token_rate.py", modules, "测试目录没找到用例文件")
        for path in modules:
            with self.subTest(module=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
                guards = [index for index, node in enumerate(tree.body) if is_main_guard(node)]
                self.assertLessEqual(len(guards), 1, "一个文件至多一个 __main__ 块")
                for index in guards:
                    self.assertEqual(index, len(tree.body) - 1,
                                     "__main__ 块之后还有语句：按脚本直跑时它们不会执行")


if __name__ == "__main__":
    unittest.main()
