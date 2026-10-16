# -*- coding: utf-8 -*-
"""zusage CLI 入口的库结构漂移提示：查询期 OperationalError 转两行可行动提示并 exit 1。

夹具库只建 session + 缺列的 model_usage：connect 的表存在性探测（select 1）通过，
首次真实查询才撞列缺失，与 ZCode 升级改列的现场一致。
"""
import contextlib
import importlib.util
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("zusage_cli_test", ROOT / "zusage.py")
zusage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zusage)

DRIFTED = """
create table session (id text primary key, title text, parent_id text, time_created integer);
create table model_usage (id text primary key, session_id text, status text);
"""


class SchemaDriftHintTests(unittest.TestCase):
    def test_operational_error_becomes_actionable_hint_and_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "db.sqlite"
            con = sqlite3.connect(str(db))
            con.executescript(DRIFTED)
            con.commit()
            con.close()
            output, errors = io.StringIO(), io.StringIO()
            with mock.patch.object(zusage, "DB_PATH", db), \
                    mock.patch.object(zusage, "_LANG", "zh"), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                code = zusage.main(["today"])
        self.assertEqual(code, 1)
        self.assertNotIn("Traceback", output.getvalue() + errors.getvalue())
        self.assertIn("查询失败", output.getvalue())
        self.assertIn("用量库结构", output.getvalue())


if __name__ == "__main__":
    unittest.main()
