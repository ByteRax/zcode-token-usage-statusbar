#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""token_rate.py / hooks/prompt-submit.py 的测试。

fixture 库模拟一轮「上轮两段 + 本问两段」的 model_usage，覆盖：
  --current 守卫（本问无入库数据时输出为空，绝不拿上一轮充数）
  加权速率（分子=output 已含思考；含思考段窗口=completed−started，Claude 系列不上报思考也按此）、
  首字延迟取第一段、
  段数/峰值、会话累计（Σoutput，思考已含不另加）
  hook 输出为严格 JSON（hookSpecificOutput.hookEventName=UserPromptSubmit + additionalContext），
  注入上一轮背景行与状态写入（--current 守卫依据）；统计行已改为 overlay.js 确定性渲染，
  hook 不再向模型下达统计指令（不再出现 token_rate.py 命令行 / Markdown 引用块要求）

运行：python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import contextlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "plugins" / "zcode-token-usage-statusbar"
RATE = PLUGIN / "token_rate.py"
PROMPT_HOOK = PLUGIN / "hooks" / "prompt-submit.py"

SCHEMA = """
create table model_usage (
  id text primary key,
  session_id text not null,
  turn_id text,
  query_source text not null,
  model_id text not null,
  status text not null,
  started_at integer not null,
  first_token_at integer,
  completed_at integer,
  time_to_first_token_ms integer,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0
);
"""

SID = "sess_fixture"


def make_db(path, rows):
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    con.executemany(
        "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    con.close()


def row(rid, sid, turn, source, started, ft, ttft, completed, inp, out, rea):
    # 列序对应 SCHEMA：(id, session_id, turn_id, query_source, model_id, status,
    #   started_at, first_token_at, completed_at, time_to_first_token_ms, 输入/输出/思考/缓存读)
    return (rid, sid, turn, source, "test-model", "completed",
            started, ft, completed, ttft, inp, out, rea, 0)


class RateTestBase(unittest.TestCase):
    """fixture：提问时刻 T0；上轮 turn_a 两段（T0 前），本问 turn_b 两段（T0 后）。

    口径（2026-10-14 修正）：分子 = output（ZCode 该列已含思考，不另加）；
    含思考段窗口 = completed − started（思考在 first_token 之前流出）。
    turn_b: b1 输出 1200（思考 300）/ 窗口 8.0s → 150；b2 输出 800（思考 200）/ 5.0s → 160
            → 加权 2000 tok / 13.0s = 153.8，峰 160，首字取 b1 = 3.0s
    会话累计(main_turn Σoutput) = 1000+500+1200+800 = 3500 → "3.5k"（思考 600 已含不另加）
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "db.sqlite")
        self.state = str(Path(self.tmp.name) / "state.json")
        self.runtime = Path(self.tmp.name) / "runtime"   # hook 的运行时目录接缝（config.json）
        self.runtime.mkdir()
        now = int(time.time() * 1000)
        t0 = now - 60_000  # 提问时刻（状态文件 TTL 7 天内）
        self.t0 = t0
        rows = [
            # 上轮 turn_a：a1 速率 200，a2 速率 150
            row("a1", SID, "turn_a", "main_turn", t0 - 12000, t0 - 9000, 3000, t0 - 4000, 100, 1000, 0),
            row("a2", SID, "turn_a", "main_turn", t0 - 7000, t0 - 5000, 2000, t0 - 1000, 100, 500, 100),
            # 本问 turn_b：工具调用轮的两段
            row("b1", SID, "turn_b", "main_turn", t0 + 1000, t0 + 4000, 3000, t0 + 9000, 200, 1200, 300),
            row("b2", SID, "turn_b", "main_turn", t0 + 15000, t0 + 17500, 2000, t0 + 20000, 200, 800, 200),
            # 非 main_turn 行：会话标题请求，很早完成，不进统计
            row("title", SID, "turn_title", "session_title", t0 - 25000, t0 - 24000, 1000, t0 - 23000, 50, 99999, 0),
            # 子代理会话：不该被统计进 S
            row("sub1", "sess_subagent_x", "turn_s", "subagent", t0 + 5000, t0 + 6000, 1000, t0 + 8000, 10, 88888, 0),
        ]
        make_db(self.db, rows)

    def tearDown(self):
        # Windows：刚退出的 token_rate 子进程或杀软扫描可能仍短暂持有 db.sqlite
        # 句柄（WinError 32），先重试几轮，仍失败则放弃清理（不掩盖断言结果）。
        for attempt in range(5):
            try:
                self.tmp.cleanup()
                return
            except OSError:
                time.sleep(0.2 * (attempt + 1))
        self.tmp.cleanup(ignore_errors=True)

    def write_state(self, obj):
        Path(self.state).write_text(json.dumps(obj), encoding="utf-8")

    def run_rate(self, *args, sid=SID, state=None):
        env = dict(os.environ, ZCODE_USAGE_DB=self.db, ZCODE_SESSION_ID=sid)
        if state is not None:
            env["ZUSAGE_RATE_STATE_FILE"] = state
        else:
            env["ZUSAGE_RATE_STATE_FILE"] = self.state
        return subprocess.run([sys.executable, str(RATE), *args],
                              capture_output=True, text=True, env=env, timeout=30)


class TestTurnCurrent(RateTestBase):
    def test_turn_current_with_data(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        r = self.run_rate("--turn", "--current", state=self.state)
        self.assertEqual(r.returncode, 0, r.stderr)
        line = r.stdout.strip()
        self.assertIn("153.8 token/s(本轮)", line)
        self.assertIn("首字 3.0s", line)
        self.assertIn("输出 2,000(含 500 思考) token / 生成 13.0s", line)
        self.assertIn("2 段 / 峰 160 token/s", line)
        self.assertIn("累计 3,500 token", line)   # 缺省万/亿模式：不足 1 万千分位，不再 k 缩写
        self.assertNotIn("(上轮)", line)

    def test_turn_current_no_cn_units(self):
        # --no-cn-units：渲染端万/亿开关关闭时由 inject-main 传入，退回千分位 + k 缩写
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        r = self.run_rate("--turn", "--current", "--no-cn-units", state=self.state)
        self.assertEqual(r.returncode, 0, r.stderr)
        line = r.stdout.strip()
        self.assertIn("153.8 token/s(本轮)", line)
        self.assertIn("输出 2,000(含 500 思考) token / 生成 13.0s", line)
        self.assertIn("累计 3.5k token", line)
        self.assertNotIn("3,500", line)

    def test_current_guard_blocks_when_no_data_this_turn(self):
        # 守卫场景：提问时刻晚于库里全部行（纯问答轮收尾自测）→ 输出必须为空
        self.write_state({"sessionId": SID, "ts": self.t0 + 60000, "promptTs": self.t0 + 60000})
        r = self.run_rate("--turn", "--current", state=self.state)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")

    def test_turn_without_current_still_shows_latest(self):
        # 不带 --current（手动排查用）则无守卫，显示最新轮
        self.write_state({"sessionId": SID, "ts": self.t0 + 60000, "promptTs": self.t0 + 60000})
        r = self.run_rate("--turn", state=self.state)
        self.assertIn("token/s(本轮)", r.stdout)

    def test_no_state_file_fails_closed_with_explicit_reason(self):
        absent = str(Path(self.tmp.name) / "absent.json")
        r = self.run_rate("--turn", "--current", state=absent)
        self.assertEqual(r.stdout, "")
        data = json.loads(self.run_rate("--turn", "--current", "--json", state=absent).stdout)
        self.assertIsNone(data["turn"])
        self.assertTrue(data["noCurrentTurnData"])
        self.assertEqual(data["currentTurnUnavailableReason"], "missingPromptState")

    def test_invalid_or_other_session_state_fails_closed(self):
        for state in [
            {"sessionId": "sess_other", "ts": self.t0, "promptTs": self.t0},
            {"sessionId": SID, "ts": self.t0, "source": "session-start"},
            {"sessionId": SID, "ts": self.t0, "promptTs": True},
            {"sessionId": SID, "ts": self.t0, "promptTs": self.t0,
             "prompts": {"sess_other": self.t0}},
            {"sessionId": SID, "ts": self.t0, "promptTs": self.t0 - 8 * 86400000},
        ]:
            with self.subTest(state=state):
                self.write_state(state)
                data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
                self.assertIsNone(data["turn"])
                self.assertEqual(data["currentTurnUnavailableReason"], "missingPromptState")
        Path(self.state).write_text("{broken")
        self.assertEqual(self.run_rate("--turn", "--current").stdout, "")

    def insert_rows(self, rows):
        with contextlib.closing(sqlite3.connect(self.db)) as con, con:
            con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    def test_delayed_old_completion_does_not_replace_current_turn(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        self.insert_rows([row("late", SID, "turn_a", "main_turn",
                              self.t0 - 500, self.t0 + 100, 600, self.t0 + 50000, 10, 9000, 0)])
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertEqual(data["turnId"], "turn_b")
        self.assertEqual(data["turn"]["totalOutput"], 2000)

    def test_old_turn_late_segment_is_not_current_even_if_segment_started_after_prompt(self):
        with contextlib.closing(sqlite3.connect(self.db)) as con, con:
            con.execute("delete from model_usage where turn_id='turn_b'")
        self.insert_rows([row("late", SID, "turn_a", "main_turn",
                              self.t0 + 100, self.t0 + 200, 100, self.t0 + 50000, 10, 9000, 0)])
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertIsNone(data["turn"])
        self.assertEqual(data["currentTurnUnavailableReason"], "noMatchingTurn")

    def test_late_hook_without_identity_fails_closed_instead_of_borrowing_turn(self):
        self.write_state({"sessionId": SID, "ts": self.t0 + 1500, "promptTs": self.t0 + 1500})
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertIsNone(data["turn"])
        self.assertEqual(data["currentTurnUnavailableReason"], "noMatchingTurn")

    def test_fixed_turn_id_needs_no_state_and_never_follows_latest(self):
        data = json.loads(self.run_rate("--turn", "--current", "--json", "--turn-id", "turn_a").stdout)
        self.assertEqual(data["turnId"], "turn_a")
        self.assertEqual(data["turn"]["totalOutput"], 1500)
        self.assertEqual(data["turnIdentitySource"], "explicitTurnId")
        self.assertTrue(data["currentTurnIdentityVerified"])
        missing = json.loads(self.run_rate("--turn", "--current", "--json", "--turn-id=absent").stdout)
        self.assertIsNone(missing["turn"])
        self.assertTrue(missing["noCurrentTurnData"])
        self.assertFalse(missing["currentTurnIdentityVerified"])

    def test_quick_new_prompt_does_not_claim_previous_turn(self):
        # Previous turn started just 1 second ago: the old -3s tolerance borrowed it.
        self.write_state({"sessionId": SID, "ts": self.t0 + 2000, "promptTs": self.t0 + 2000})
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertIsNone(data["turn"])

    def test_time_compatibility_is_explicitly_not_verified_identity(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertEqual(data["turnIdentitySource"], "promptTimeCompatibility")
        self.assertFalse(data["currentTurnIdentityVerified"])

    def test_mixed_rated_and_unrated_output_has_explicit_coverage(self):
        self.insert_rows([row("b3", SID, "turn_b", "main_turn", self.t0 + 21000,
                              None, None, self.t0 + 22000, 10, 500, 0)])
        data = json.loads(self.run_rate("--turn", "--json", "--turn-id=turn_b").stdout)
        turn = data["turn"]
        self.assertEqual(turn["requests"], 3)
        self.assertEqual(turn["rated"], 2)
        self.assertEqual(turn["unrated"], 1)
        self.assertEqual(turn["ratedOutput"], 2000)
        self.assertEqual(turn["unratedOutput"], 500)
        self.assertEqual(turn["rateCoverage"], .8)
        self.assertEqual(turn["tokPerSec"], 153.8)
        latest = json.loads(self.run_rate("--json").stdout)["latest"]
        self.assertEqual(latest["outputTokens"], 500)
        self.assertIsNone(latest["tokPerSec"])

    def test_prompt_older_than_skew_still_rejects_current_turn(self):
        # 容差有界：提问时刻晚于本轮最早段 3 秒以上仍须拦下（不放宽守卫本体）。
        self.write_state({"sessionId": SID, "ts": self.t0 + 4500, "promptTs": self.t0 + 4500})
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertIsNone(data["turn"])
        self.assertEqual(data["currentTurnUnavailableReason"], "noMatchingTurn")

    def test_newer_title_turn_does_not_mask_main_turn(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        self.insert_rows([row("new-title", SID, "turn_new_title", "session_title",
                              self.t0 + 30000, self.t0 + 31000, 1000, self.t0 + 40000, 10, 99999, 0)])
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertEqual(data["turnId"], "turn_b")
        self.assertEqual(data["turn"]["totalOutput"], 2000)

    def test_segment_order_and_latest_identity_use_start_not_completion(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        with contextlib.closing(sqlite3.connect(self.db)) as con, con:
            con.execute("update model_usage set completed_at=? where id='b1'", [self.t0 + 21000])
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertEqual(data["turn"]["ttftMs"], 3000)
        self.assertEqual(data["turn"]["lastAt"], self.t0 + 21000)

    def test_old_schema_without_turn_id_degrades_without_traceback(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        with contextlib.closing(sqlite3.connect(self.db)) as con, con:
            con.execute("alter table model_usage rename column turn_id to legacy_turn")
        result = self.run_rate("--turn", "--current", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertIsNone(data["turn"])
        self.assertEqual(data["currentTurnUnavailableReason"], "missingTurnIdentity")
        self.assertEqual(self.run_rate("--turn", "--current").stdout, "")

    def test_missing_turn_identity_explicitly_degrades(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        with contextlib.closing(sqlite3.connect(self.db)) as con, con:
            con.execute("update model_usage set turn_id=null")
        data = json.loads(self.run_rate("--turn", "--current", "--json").stdout)
        self.assertIsNone(data["turn"])
        self.assertEqual(data["currentTurnUnavailableReason"], "missingTurnIdentity")

    def test_guard_per_session_prompt_ts(self):
        # 多窗口交替提问：全局 promptTs 已被会话 B 的提问覆盖（晚于 A 全部入库行），
        # 但 A 的守卫必须用 A 自己的提问时刻 → A 本轮数据不被误吞（v1.3.0 修复）
        import sqlite3 as _sl
        con = _sl.connect(self.db)
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    row("o1", "sess_other", "turn_o", "main_turn",
                        self.t0 + 25000, self.t0 + 26000, 1000, self.t0 + 30000, 50, 900, 100))
        con.commit()
        con.close()
        self.write_state({"sessionId": "sess_other", "ts": self.t0 + 60000,
                          "promptTs": self.t0 + 60000, "source": "prompt-submit",
                          "prompts": {SID: self.t0, "sess_other": self.t0 + 60000}})
        r = self.run_rate("--turn", "--current", state=self.state)
        self.assertIn("token/s(本轮)", r.stdout)
        self.assertIn("累计 3,500 token", r.stdout)
        # 对照：sess_other 自己刚提问、其入库行全部早于提问时刻 → 必须被守卫拦下（空输出）
        r2 = self.run_rate("--turn", "--current", state=self.state, sid="sess_other")
        self.assertEqual(r2.stdout, "")

    def test_single_segment_has_no_peak_part(self):
        rows = [row("c1", "sess_one", "turn_c", "main_turn",
                    self.t0 + 1000, self.t0 + 2000, 1000, self.t0 + 5000, 10, 600, 0)]
        db2 = str(Path(self.tmp.name) / "one.sqlite")
        make_db(db2, rows)
        state2 = str(Path(self.tmp.name) / "one.json")
        Path(state2).write_text(json.dumps(
            {"sessionId": "sess_one", "ts": self.t0, "promptTs": self.t0}))
        env = dict(os.environ, ZCODE_USAGE_DB=db2, ZCODE_SESSION_ID="sess_one",
                   ZUSAGE_RATE_STATE_FILE=state2)
        r = subprocess.run([sys.executable, str(RATE), "--turn", "--current"],
                           capture_output=True, text=True, env=env, timeout=30)
        line = r.stdout.strip()
        self.assertIn("200 token/s(本轮)", line)
        self.assertIn("输出 600 token / 生成 3.0s", line)
        self.assertNotIn("段 / 峰", line)
        self.assertIn("累计 600 token", line)

    def test_claude_unreported_thinking_counts_from_request_start(self):
        # 回归（2026-10-15 真库同款数据）：Claude 系列 reasoning_tokens 恒为 0，但 output 已含
        # 思考、思考在 first_token_at 之前流出——按首字窗口曾算出 1074 ÷ 1.426s = 753.2 tok/s。
        # 须按含思考段从 started_at 计时：1074 ÷ 15.087s = 71.2；缺首字时同样按整段；
        # 非 Claude 模型口径不变（仍是首字窗口）。
        start = self.t0 + 1000
        cases = (("claude-opus-5-5", start + 13661, 71.2),
                 ("claude-opus-5-5", None, 71.2),
                 ("test-model", start + 13661, 753.2))
        for i, (model, first_token, expected) in enumerate(cases):
            with self.subTest(model=model, first_token=first_token):
                segment = list(row("c1", "sess_claude", "turn_c", "main_turn", start, first_token,
                                   13661 if first_token else None, start + 15087, 10, 1074, 0))
                segment[4] = model
                db2 = Path(self.tmp.name) / f"claude-{i}.sqlite"
                make_db(str(db2), [tuple(segment)])
                state2 = Path(self.tmp.name) / f"claude-{i}.json"
                state2.write_text(json.dumps({"sessionId": "sess_claude", "ts": self.t0, "promptTs": self.t0}))
                env = dict(os.environ, ZCODE_USAGE_DB=str(db2), ZCODE_SESSION_ID="sess_claude",
                           ZUSAGE_RATE_STATE_FILE=str(state2))
                r = subprocess.run([sys.executable, str(RATE), "--turn", "--current", "--json"],
                                   capture_output=True, text=True, env=env, timeout=30)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(json.loads(r.stdout)["turn"]["tokPerSec"], expected)

    def test_json_output(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        r = self.run_rate("--turn", "--current", "--json", state=self.state)
        data = json.loads(r.stdout)
        self.assertNotIn("noCurrentTurnData", data)
        turn = data["turn"]
        self.assertEqual(turn["requests"], 2)
        self.assertEqual(turn["ttftMs"], 3000)
        self.assertEqual(turn["genMs"], 13000)
        self.assertEqual(turn["totalOutput"], 2000)
        self.assertEqual(turn["totalReasoning"], 500)
        self.assertEqual(turn["tokPerSec"], 153.8)
        self.assertEqual(turn["peak"], 160)
        self.assertEqual(data["session"]["totalOutput"], 3500)
        self.assertEqual(data["session"]["totalReasoning"], 600)

    def test_explicit_session_flag_overrides_global_last_active_pointer(self):
        # 回归（2026-10-15 真机事故）：模型通过 Bash 工具执行统计指令时没有会话环境变量，
        # 旧实现回退到状态文件顶层 sessionId（"用户最后所处的会话"）；若执行时刻晚于钩子
        # 触发（常见——中间还要写完整回复），并行会话这期间提问会把该字段改写成它自己的
        # 会话，导致本会话的 ⚡ 行显示了别的会话的首字延迟/输出量。--session 必须优先于
        # 状态文件与环境变量，且在完全没有会话环境变量时也能拿到正确会话的数据。
        other_turn = row("p1", "sess_parallel", "turn_p", "main_turn",
                         self.t0 + 30000, self.t0 + 31000, 1000, self.t0 + 33000, 10, 999, 0)
        self.insert_rows([other_turn])
        # 状态文件顶层指向并行会话（它在本会话写完回复前抢先提问，真机场景的时间顺序）；
        # prompts 映射里两个会话各自的提问时刻仍然都对。
        self.write_state({"sessionId": "sess_parallel", "ts": self.t0 + 30000,
                          "promptTs": self.t0 + 30000,
                          "prompts": {SID: self.t0, "sess_parallel": self.t0 + 30000}})
        env = dict(os.environ, ZCODE_USAGE_DB=self.db, ZUSAGE_RATE_STATE_FILE=self.state)
        env.pop("ZCODE_SESSION_ID", None)
        env.pop("CLAUDE_SESSION_ID", None)   # 模拟 Bash 工具调用：无任何会话环境变量
        r = subprocess.run([sys.executable, str(RATE), "--turn", "--current", "--json",
                            "--session", SID], capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["sessionId"], SID)
        self.assertEqual(data["turn"]["totalOutput"], 2000)   # turn_b，不是并行会话的 999


class TestLatestLine(RateTestBase):
    def test_default_output_is_prev_round(self):
        r = self.run_rate(state=self.state)
        lines = r.stdout.strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("160 token/s(上轮)", lines[0])  # 最近完成的 b2（含思考段窗口 5.0s）
        self.assertIn("首字 2.0s", lines[0])
        self.assertIn("输出 800(含 200 思考) token / 生成 5.0s", lines[0])
        self.assertIn("近4次均 148.3 / 峰 200 token/s", lines[0])
        self.assertIn("累计 3.5k token", lines[0])
        self.assertIn("请求 4 次", lines[1])  # 只数 main_turn

    def test_empty_db_reports_none(self):
        db2 = str(Path(self.tmp.name) / "empty.sqlite")
        make_db(db2, [])
        env = dict(os.environ, ZCODE_USAGE_DB=db2,
                   ZUSAGE_RATE_STATE_FILE=str(Path(self.tmp.name) / "absent.json"))
        r = subprocess.run([sys.executable, str(RATE)], capture_output=True, text=True,
                           env=env, timeout=30)
        self.assertIn("暂无已完成的模型请求", r.stdout)

    def test_missing_db_is_graceful(self):
        env = dict(os.environ, ZCODE_USAGE_DB=str(Path(self.tmp.name) / "no.sqlite"),
                   ZUSAGE_RATE_STATE_FILE=str(Path(self.tmp.name) / "absent.json"),
                   ZCODE_SESSION_ID="sess_none")
        r = subprocess.run([sys.executable, str(RATE)], capture_output=True, text=True,
                           env=env, timeout=30)
        self.assertEqual(r.returncode, 0)
        self.assertIn("暂无已完成的模型请求", r.stdout)


class TestPromptSubmitHook(RateTestBase):
    def run_hook(self, sid=SID):
        # ZUSAGE_PLUGIN_RUNTIME 指向空 fixture 运行时目录：config 缺失 → 开关缺省=开启（密闭）
        env = dict(os.environ, ZCODE_USAGE_DB=self.db, ZCODE_SESSION_ID=sid,
                   ZUSAGE_RATE_STATE_FILE=self.state,
                   ZUSAGE_PLUGIN_RUNTIME=str(self.runtime))
        return subprocess.run([sys.executable, str(PROMPT_HOOK)], input="",
                              capture_output=True, text=True, env=env, timeout=30)

    def test_strict_json_state_written_and_no_model_instruction(self):
        before = int(time.time() * 1000)
        r = self.run_hook()
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(set(out), {"hookSpecificOutput"})
        inner = out["hookSpecificOutput"]
        self.assertEqual(set(inner), {"hookEventName", "additionalContext"})
        self.assertEqual(inner["hookEventName"], "UserPromptSubmit")
        ctx = inner["additionalContext"]
        self.assertIn("【内部背景·勿展示】上一条回复:", ctx)
        self.assertIn("160 token/s(上轮)", ctx)
        # 统计行已确定性渲染（overlay.js 桥接）：不再向模型下达任何统计指令
        for banned in ("本轮统计指令", "运行一次:", "Markdown 引用块",
                       "token_rate.py", "--turn", "--current", "--session"):
            self.assertNotIn(banned, ctx, banned)
        # 状态文件：记录了会话与提问时刻（--current 守卫依据）
        st = json.loads(Path(self.state).read_text())
        self.assertEqual(st["sessionId"], SID)
        self.assertEqual(st["source"], "prompt-submit")
        self.assertGreaterEqual(st["promptTs"], before)

    def test_hook_state_then_guard_blocks_stale_turn(self):
        # 端到端：hook 刚记录完提问（此刻本问必然无入库数据）→ --current 必须无输出
        self.run_hook()
        r = self.run_rate("--turn", "--current", state=self.state)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")

    def test_hook_without_session_env_still_valid_json(self):
        env = dict(os.environ, ZCODE_USAGE_DB=self.db, ZUSAGE_RATE_STATE_FILE=self.state,
                   ZUSAGE_PLUGIN_RUNTIME=str(self.runtime))
        env.pop("ZCODE_SESSION_ID", None)
        env.pop("CLAUDE_SESSION_ID", None)
        r = subprocess.run([sys.executable, str(PROMPT_HOOK)], input="",
                           capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertFalse(Path(self.state).exists())  # 无会话不写状态
        context = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn("【内部背景·勿展示】", context)   # 背景行通道保留
        self.assertNotIn("本轮统计指令", context)       # 统计指令已删除

    def test_toggle_off_injects_no_instruction(self):
        # ⚙ 面板关闭（config.json answer_rate_line=false）：不下达统计指令、不注入背景行，
        # 仍严格 JSON；状态文件照写（--current 守卫数据保持新鲜，CLI 手动排查不受开关影响）
        (self.runtime / "config.json").write_text(
            '{"answer_rate_line": false, "lang": "zh"}', encoding="utf-8")
        r = self.run_hook()
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(set(out), {"hookSpecificOutput"})
        inner = out["hookSpecificOutput"]
        self.assertEqual(set(inner), {"hookEventName", "additionalContext"})
        self.assertEqual(inner["hookEventName"], "UserPromptSubmit")
        self.assertEqual(inner["additionalContext"], "")   # fixture 无重启提醒：关闭即空上下文
        st = json.loads(Path(self.state).read_text())
        self.assertEqual(st["sessionId"], SID)

    def test_toggle_corrupt_config_defaults_on(self):
        # config 损坏 → 视为开启（开关失效不吞功能）：背景行仍在
        (self.runtime / "config.json").write_text("{broken", encoding="utf-8")
        r = self.run_hook()
        out = json.loads(r.stdout)
        ctx = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn("【内部背景·勿展示】", ctx)
        self.assertNotIn("本轮统计指令", ctx)

    def test_toggle_explicit_true(self):
        # 显式 true 与缺省同义：开启
        (self.runtime / "config.json").write_text('{"answer_rate_line": true}', encoding="utf-8")
        r = self.run_hook()
        out = json.loads(r.stdout)
        ctx = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn("【内部背景·勿展示】", ctx)
        self.assertNotIn("本轮统计指令", ctx)

    def test_concurrent_real_hooks_share_state_lock_and_preserve_all_prompts(self):
        # Parent holds the real OS lock; children execute the real hook and record
        # state reads. A read before lock release is a deterministic lost-update bug.
        import importlib.util
        spec = importlib.util.spec_from_file_location("rate_test_lock", REPO / "runtime_lock.py")
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        self.write_state({"sessionId": "seed", "ts": self.t0, "promptTs": self.t0,
                          "prompts": {"seed": self.t0}})
        script = r'''
import os, runpy, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import token_rate
ready, observed = Path(sys.argv[3]), Path(sys.argv[4])
original_write = token_rate.write_session_state
original_read = Path.read_text

def write(*args):
    ready.write_text("ready")
    return original_write(*args)

def read(path, *args, **kwargs):
    if path == Path(token_rate.STATE_FILE): observed.write_text("read")
    return original_read(path, *args, **kwargs)

token_rate.write_session_state = write
Path.read_text = read
runpy.run_path(sys.argv[2], run_name="__main__")
'''
        processes, markers = [], []
        try:
            with helper.file_lock(self.state + ".lock"):
                for index in range(8):
                    ready = Path(self.tmp.name) / f"ready-{index}"
                    observed = Path(self.tmp.name) / f"read-{index}"
                    markers.append((ready, observed))
                    env = dict(os.environ, ZCODE_USAGE_DB=self.db,
                               ZCODE_SESSION_ID=f"sess_parallel_{index}",
                               ZUSAGE_RATE_STATE_FILE=self.state,
                               ZUSAGE_PLUGIN_RUNTIME=str(self.runtime),
                               PYTHONDONTWRITEBYTECODE="1")
                    processes.append(subprocess.Popen(
                        [sys.executable, "-c", script, str(PLUGIN), str(PROMPT_HOOK),
                         str(ready), str(observed)], stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env))
                deadline = time.monotonic() + 10
                while not all(ready.exists() for ready, _ in markers) and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(all(ready.exists() for ready, _ in markers))
                time.sleep(.15)
                self.assertFalse(any(observed.exists() for _, observed in markers),
                                 "real hooks read state before acquiring the shared lock")
            previous_keys = {"seed"}
            deadline = time.monotonic() + 15
            while any(process.poll() is None for process in processes) and time.monotonic() < deadline:
                try:
                    snapshot = json.loads(Path(self.state).read_text())
                except (OSError, ValueError):
                    time.sleep(.01)  # Windows：写者 os.replace / 杀软瞬时占用，读快照可暂时被拒
                    continue
                keys = set(snapshot["prompts"])
                self.assertTrue(previous_keys <= keys, "atomic snapshots lost a session")
                previous_keys = keys
                time.sleep(.001)
            for process in processes:
                out, err = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 0, err)
                self.assertEqual(json.loads(out)["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
            state = json.loads(Path(self.state).read_text())
            self.assertEqual(set(state["prompts"]), {"seed"} | {f"sess_parallel_{i}" for i in range(8)})
            self.assertTrue(Path(self.state + ".lock").exists())
            self.assertEqual(list(Path(self.tmp.name).glob("state.json.*.tmp")), [])
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)

    def test_session_start_preserves_prompt_instead_of_fabricating_one(self):
        self.run_hook()
        before = json.loads(Path(self.state).read_text())
        script = "import sys; sys.path.insert(0, sys.argv[1]); import token_rate; token_rate.write_session_state(sys.argv[2], 'session-start')"
        env = dict(os.environ, ZUSAGE_RATE_STATE_FILE=self.state, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, "-c", script, str(PLUGIN), SID],
                                capture_output=True, text=True, env=env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = json.loads(Path(self.state).read_text())
        self.assertEqual(after["prompts"][SID], before["prompts"][SID])
        self.assertEqual(after["promptTs"], before["promptTs"])
        result = subprocess.run([sys.executable, "-c", script, str(PLUGIN), "sess_new"],
                                capture_output=True, text=True, env=env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(Path(self.state).read_text())
        self.assertNotIn("sess_new", state["prompts"])
        self.assertNotIn("promptTs", state)

    def test_state_written_has_per_session_map(self):
        # hook 写状态带 prompts 每会话映射（守卫按会话取提问时刻的依据）
        self.run_hook()
        st = json.loads(Path(self.state).read_text())
        self.assertEqual(st["prompts"][SID], st["promptTs"])
        # 再来一个会话提问：全局字段跟随新会话，映射里两个会话各自保留
        self.run_hook(sid="sess_second")
        st2 = json.loads(Path(self.state).read_text())
        self.assertEqual(st2["sessionId"], "sess_second")
        self.assertIn(SID, st2["prompts"])
        self.assertIn("sess_second", st2["prompts"])
        self.assertGreater(st2["prompts"]["sess_second"], st2["prompts"][SID])


class TestCnUnitsFormat(unittest.TestCase):
    """fmt_cn / format_turn_line(cn=True)：与 overlay.js fmt()、turn-stats.js formatTokens 同规则
    （≥1 亿用亿、≥1 万用万、至多两位小数去尾零、不足 1 万千分位）。"""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(PLUGIN))
        import token_rate
        cls.tr = token_rate

    def test_fmt_cn_matrix(self):
        self.assertEqual([self.tr.fmt_cn(n) for n in (0, 950, 9500, 582500, 1420000, 10**8, 123456789, 10**9)],
                         ["0", "950", "9,500", "58.25万", "142万", "1亿", "1.23亿", "10亿"])

    def test_format_turn_line_cn_switches_every_token_count(self):
        r = {"turn": {"tokPerSec": 82.6, "ttftMs": 1400, "totalOutput": 58260, "totalReasoning": 21000,
                      "genMs": 100500, "requests": 7, "peak": 112, "lastAt": 0},
             "session": {"totalOutput": 1640000}}
        plain = self.tr.format_turn_line(r, cn=False)
        self.assertIn("⚡ 82.6 token/s(本轮)", plain)
        self.assertIn("输出 58,260(含 21,000 思考) token / 生成 100.5s", plain)
        self.assertIn("累计 1.6M token", plain)
        cn = self.tr.format_turn_line(r)   # 缺省即万/亿，与渲染端开关默认开启一致
        self.assertIn("⚡ 82.6 token/s(本轮)", cn)
        self.assertIn("输出 5.83万(含 2.1万 思考) token / 生成 100.5s", cn)
        self.assertIn("7 段 / 峰 112 token/s", cn)
        self.assertIn("累计 164万 token", cn)
        self.assertNotIn(" tok ", cn)
        self.assertNotIn(" tok/", cn)

    def test_format_turn_line_sample_time_is_full_cn_datetime(self):
        # ⏱ 采样时刻 = 完整中文日期时间（2026 年 10 月 23 日 11 点 20 分 28 秒），数字不补零；
        # 上轮行（format_line）仍为 HH:MM:SS，两行格式不互相牵动。
        last_at = int(time.mktime((2026, 10, 23, 11, 20, 28, 0, 0, -1))) * 1000
        r = {"turn": {"tokPerSec": 82.6, "ttftMs": 1400, "totalOutput": 58260, "totalReasoning": 0,
                      "genMs": 100500, "requests": 1, "peak": 112, "lastAt": last_at},
             "session": None}
        line = self.tr.format_turn_line(r)
        self.assertTrue(line.endswith("⏱ 2026 年 10 月 23 日 11 点 20 分 28 秒"), line)
        self.assertNotRegex(line, r"⏱ \d{2}:\d{2}:\d{2}")

    def test_format_line_keeps_hhmmss_sample_time(self):
        # 刻意保留的边界：上轮行（CLI 默认输出/hook 背景）采样时刻仍为补零 HH:MM:SS，
        # 不随本问统计行的中文日期时间改版联动。
        completed_at = int(time.mktime((2026, 10, 23, 11, 20, 28, 0, 0, -1))) * 1000
        r = {"latest": {"tokPerSec": 36.6, "ttftMs": 5100, "outputTokens": 759, "reasoningTokens": 0,
                        "genMs": 20700, "completedAt": completed_at},
             "session": None}
        line = self.tr.format_line(r)
        self.assertTrue(line.endswith("⏱ 11:20:28"), line)


if __name__ == "__main__":
    unittest.main(verbosity=2)
