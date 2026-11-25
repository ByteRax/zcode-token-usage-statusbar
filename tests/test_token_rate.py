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
from unittest import mock
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
  cache_read_input_tokens integer not null default 0,
  provider_id text
);
"""

SID = "sess_fixture"


def make_db(path, rows):
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    con.executemany(
        "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    con.close()


def row(rid, sid, turn, source, started, ft, ttft, completed, inp, out, rea, provider="account:fixture"):
    # 列序对应 SCHEMA：(id, session_id, turn_id, query_source, model_id, status,
    #   started_at, first_token_at, completed_at, time_to_first_token_ms, 输入/输出/思考/缓存读, provider_id)
    return (rid, sid, turn, source, "test-model", "completed",
            started, ft, completed, ttft, inp, out, rea, 0, provider)


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
        # 子进程的 stdout 被产品代码钉成 UTF-8（含 ⚡·⏱ 与中文），父进程必须按 UTF-8 解码：
        # text=True 走区域代码页，默认中文 Windows（GBK）下读者线程抛 UnicodeDecodeError、
        # stdout 收成 None，输出含非 ASCII 的 CLI 用例都会红（宿主注入的 PYTHONUTF8=1 会掩盖）。
        # 用严格解码：产品侧的 UTF-8 钉子被改坏时这些用例要能发现。
        return subprocess.run([sys.executable, str(RATE), *args],
                              capture_output=True, encoding="utf-8", env=env, timeout=30)


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

    def test_turn_current_force_kmb_overrides_both_unit_modes(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        for flags in (("--force-kmb",), ("--no-cn-units", "--force-kmb")):
            r = self.run_rate("--turn", "--current", *flags, state=self.state)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("输出 2.0K(含 500 思考)", r.stdout)
            self.assertIn("累计 3.5K token", r.stdout)

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
            con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)

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
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
                           capture_output=True, encoding="utf-8", env=env, timeout=30)
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
                                   capture_output=True, encoding="utf-8", env=env, timeout=30)
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
                            "--session", SID], capture_output=True, encoding="utf-8", env=env, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["sessionId"], SID)
        self.assertEqual(data["turn"]["totalOutput"], 2000)   # turn_b，不是并行会话的 999


class TestSessionAverage(RateTestBase):
    """v181（PR #157）：会话均 = 全会话加权平均（Σ可评分输出 ÷ Σ生成窗口），
    与「近N次均」的算术平均互补；无可评分段时为 None，两处展示自动隐藏。"""

    def test_session_avg_is_whole_session_weighted_mean(self):
        # a1 1000/5s + a2 500/6s(含思考窗) + b1 1200/8s(含思考窗) + b2 800/5s(含思考窗)
        # = 3500 tok / 24 s = 145.8；算术平均 148.3 是另一口径，两者并存不互替
        data = json.loads(self.run_rate("--json").stdout)
        self.assertEqual(data["session"]["sessionAvg"], 145.8)
        self.assertEqual(data["session"]["avg"], 148.3)

    def test_session_avg_hidden_when_no_rated_rows(self):
        # 无思考段窗口依赖首字；思考段再掐 started_at——两处都掐才全部不可评
        con = sqlite3.connect(self.db)
        con.execute("update model_usage set first_token_at = null, reasoning_tokens = 0")
        con.commit()
        con.close()
        data = json.loads(self.run_rate("--json").stdout)
        self.assertIsNone(data["session"]["sessionAvg"])
        cli = self.run_rate().stdout
        self.assertNotIn("会话均", cli)
        self.assertNotIn("平均", cli)
        # --turn 富文本行同样不出现「会话均 None」（v181 补修锁定 format_turn_line 守卫）
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        r = self.run_rate("--turn", "--current", state=self.state)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("会话均", r.stdout)

    def test_turn_line_puts_session_avg_before_cumulative(self):
        self.write_state({"sessionId": SID, "ts": self.t0, "promptTs": self.t0})
        r = self.run_rate("--turn", "--current", state=self.state)
        self.assertEqual(r.returncode, 0, r.stderr)
        line = r.stdout.strip()
        self.assertIn("会话均 145.8 token/s · 累计 3,500 token", line)

    def test_cli_cumulative_line_appends_weighted_average(self):
        out = self.run_rate().stdout
        self.assertIn("会话均 145.8 token/s · 累计 3.5k token", out)   # 上轮行（format_line）
        self.assertIn("· 平均 145.8 token/s", out)                     # 会话累计行（CLI）

    def test_aux_and_subagent_rows_never_enter_session_avg(self):
        con = sqlite3.connect(self.db)
        con.executemany(
            "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [  # 同会话的辅助/子代理源行：scope 过滤，不进分母
                ("x1", SID, "turn_x", "session_title", "test-model", "completed",
                 self.t0, self.t0 + 1000, self.t0 + 11000, 1000, 10, 99999, 0, 0, "account:fixture"),
                ("x2", "sess_sub_y", "turn_y", "subagent", "test-model", "completed",
                 self.t0, self.t0 + 1000, self.t0 + 11000, 1000, 10, 99999, 0, 0, "account:fixture"),
            ])
        con.commit()
        con.close()
        data = json.loads(self.run_rate("--json").stdout)
        self.assertEqual(data["session"]["sessionAvg"], 145.8)
        self.assertEqual(data["session"]["requests"], 4)

    def test_session_avg_follows_cover_set_window(self):
        # 落章 provider（ttft 不随推理量增长，斜率 0）含思考段按首字窗口计入会话均：
        # 每行 500 tok / 5s 窗口 → 100.0；covers 丢失时窗口前移 started_at（8s）→ 62.5
        con = sqlite3.connect(self.db)
        con.execute("delete from model_usage")
        con.executemany(
            "insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(f"c{i}", SID, "turn_c", "main_turn", "test-model", "completed",
              self.t0 + 1000 * i, self.t0 + 1000 * i + 3000, self.t0 + 1000 * i + 8000,
              2500, 10, 500, 100 + 50 * i, 0, "account:cov")
             for i in range(6)])
        con.commit()
        con.close()
        data = json.loads(self.run_rate("--json").stdout)
        self.assertEqual(data["session"]["sessionAvg"], 100.0)


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
        r = subprocess.run([sys.executable, str(RATE)], capture_output=True, encoding="utf-8",
                           env=env, timeout=30)
        self.assertIn("暂无已完成的模型请求", r.stdout)

    def test_missing_db_is_graceful(self):
        env = dict(os.environ, ZCODE_USAGE_DB=str(Path(self.tmp.name) / "no.sqlite"),
                   ZUSAGE_RATE_STATE_FILE=str(Path(self.tmp.name) / "absent.json"),
                   ZCODE_SESSION_ID="sess_none")
        r = subprocess.run([sys.executable, str(RATE)], capture_output=True, encoding="utf-8",
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
                              capture_output=True, encoding="utf-8", env=env, timeout=30)

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
                           capture_output=True, encoding="utf-8", env=env, timeout=30)
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
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        encoding="utf-8", env=env))
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
                                capture_output=True, encoding="utf-8", env=env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = json.loads(Path(self.state).read_text())
        self.assertEqual(after["prompts"][SID], before["prompts"][SID])
        self.assertEqual(after["promptTs"], before["promptTs"])
        result = subprocess.run([sys.executable, "-c", script, str(PLUGIN), "sess_new"],
                                capture_output=True, encoding="utf-8", env=env, timeout=10)
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
        self.assertIn("输出 58,260(含 21,000 思考) token / 生成 1分40.5秒", plain)   # v376 分级中文
        self.assertIn("累计 1.6M token", plain)
        cn = self.tr.format_turn_line(r)   # 缺省即万/亿，与渲染端开关默认开启一致
        self.assertIn("⚡ 82.6 token/s(本轮)", cn)
        self.assertIn("输出 5.83万(含 2.1万 思考) token / 生成 1分40.5秒", cn)
        self.assertIn("7 段 / 峰 112 token/s", cn)
        self.assertIn("累计 164万 token", cn)
        self.assertNotIn(" tok ", cn)
        self.assertNotIn(" tok/", cn)

    def test_force_kmb_formats_all_token_fields_without_changing_counts(self):
        self.assertEqual([self.tr.fmt_kmb(n) for n in (999, 1000, 9500, 1000000, 123456789, 10**9)],
                         ["999", "1.0K", "9.5K", "1.00M", "123.46M", "1.00B"])
        r = {"turn": {"tokPerSec": 82.6, "ttftMs": 1400, "totalOutput": 58260, "totalReasoning": 21000,
                      "genMs": 100500, "requests": 7, "peak": 112, "lastAt": 0},
             "session": {"totalOutput": 1000000000}}
        for cn in (True, False):
            line = self.tr.format_turn_line(r, cn=cn, force_kmb=True)
            self.assertIn("输出 58.3K(含 21.0K 思考)", line)
            self.assertIn("累计 1.00B token", line)
            self.assertIn("7 段 / 峰 112 token/s", line)

    def test_root_force_kmb_half_boundaries(self):
        # 同步前直接验证根源码；插件副本由集成步骤统一同步。
        import importlib.util
        spec = importlib.util.spec_from_file_location("root_token_rate", REPO / "token_rate.py")
        root_rate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(root_rate)
        values = (1249, 1250, 1251, 1124999, 1125000, 1125001,
                  1124999999, 1125000000, 1125000001)
        expected = ["1.2K", "1.3K", "1.3K", "1.12M", "1.13M", "1.13M",
                    "1.12B", "1.13B", "1.13B"]
        self.assertEqual([root_rate.fmt_kmb(n) for n in values], expected)
        self.assertEqual(root_rate.fmt_num(1250), "1,250")

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


class FirstTokenCoversTests(unittest.TestCase):
    """首块落章 provider 判定（fork z1908144712 判据收编）：ttft 不随推理量增长
    （最小二乘斜率 <2.0 ms/token）的 provider，含思考段用首字窗口（思考在首字后随
    输出流出，首字窗口已含思考）；推理前置（斜率 ≥2）与样本不足（<5 条/推理量无变化）
    走 started_at 默认。fixture 中 test-model 全库仅 3 条思考行，永远不满足判定。"""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(PLUGIN))
        import token_rate
        cls.tr = token_rate
        sys.path.insert(0, str(REPO))
        import usage_stats
        cls.us = usage_stats

    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.addCleanup(self.con.close)
        self.con.executescript("""
create table model_usage (id text primary key, session_id text, turn_id text, query_source text,
  model_id text, status text, started_at integer, first_token_at integer, completed_at integer,
  time_to_first_token_ms integer, input_tokens integer, output_tokens integer,
  reasoning_tokens integer, cache_read_input_tokens integer, provider_id text)""")

    def add(self, rid, provider, reasoning, ttft):
        self.con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (rid, "s", "t", "main_turn", "m", "completed", 1000, 4000, 9000,
                          ttft, 100, 500, reasoning, 0, provider))

    def test_slope_detection_partitions_providers(self):
        for i in range(6):
            self.add(f"pa{i}", "prov-covers", 100 + 50 * i, 2500)      # 斜率 0：首块落章
            self.add(f"pb{i}", "prov-before", 100 + 50 * i, 5 * (100 + 50 * i))   # 斜率 5：推理前置
        for i in range(3):
            self.add(f"pc{i}", "prov-few", 100 + 50 * i, 2500)         # 样本不足：不判
        self.add("pd1", "prov-flat", 100, 2500)                         # 推理量无变化：不判
        self.add("pd2", "prov-flat", 100, 2500)
        self.add("pd3", "prov-flat", 100, 2500)
        self.add("pd4", "prov-flat", 100, 2500)
        self.add("pd5", "prov-flat", 100, 2500)
        self.assertEqual(self.tr.first_token_covers(self.con), frozenset({"prov-covers"}))

    def test_request_stats_window_follows_cover_set(self):
        base = {"output_tokens": 500, "reasoning_tokens": 300, "completed_at": 9000,
                "started_at": 1000, "first_token_at": 4000, "model_id": "glm-x",
                "time_to_first_token_ms": 3000, "provider_id": "prov-covers"}
        default = self.us.request_stats(base)                       # 不在集合：st 窗口 8.0s
        self.assertEqual(default["genMs"], 8000)
        self.assertEqual(default["tokPerSec"], 62.5)
        covered = self.us.request_stats(base, covers=frozenset({"prov-covers"}))   # ft 窗口 5.0s
        self.assertEqual(covered["genMs"], 5000)
        self.assertEqual(covered["tokPerSec"], 100.0)
        # 缺 provider_id 的行（旧调用方/手写行）：判不了归属，走默认 st 窗口
        no_pid = dict(base)
        del no_pid["provider_id"]
        self.assertEqual(self.us.request_stats(no_pid, covers=frozenset({"prov-covers"}))["genMs"], 8000)

    def test_to_item_passes_covers_through_to_sqlite_rows(self):
        self.con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         ("x", "s", "t", "main_turn", "m", "completed", 1000, 4000, 9000,
                          3000, 100, 500, 300, 0, "prov-covers"))
        r = self.con.execute("select * from model_usage where id='x'").fetchone()
        self.assertEqual(self.tr.to_item(r, frozenset({"prov-covers"}))["genMs"], 5000)
        self.assertEqual(self.tr.to_item(r)["genMs"], 8000)

    def _file_db(self, rows, with_provider=True):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = str(Path(tmp.name) / "db.sqlite")
        con = sqlite3.connect(db_path)
        tail = ", provider_id text)" if with_provider else ")"
        con.executescript(
            "create table model_usage (id text primary key, session_id text, turn_id text,"
            " query_source text, model_id text, status text, started_at integer,"
            " first_token_at integer, completed_at integer, time_to_first_token_ms integer,"
            " input_tokens integer, output_tokens integer, reasoning_tokens integer,"
            " cache_read_input_tokens integer" + tail)
        marks = "(" + ",".join("?" * (15 if with_provider else 14)) + ")"
        con.executemany(f"insert into model_usage values {marks}", rows)
        con.commit()
        con.close()
        return db_path

    def _with_db(self, db_path, sid):
        old = self.tr.DB_PATH
        self.tr.DB_PATH = db_path
        try:
            return self.tr.query_latest(session_id=sid)
        finally:
            self.tr.DB_PATH = old

    def test_old_schema_without_provider_column_still_queries(self):
        # 旧库缺 provider_id 列（评审第一轮 MAJOR 回归）：不崩、main_turn 过滤不被
        # 误删（非 main_turn 行再晚也不能当 latest）、含思考行按默认 st 窗口降级。
        rows = [
            ("title", "s", "t0", "session_title", "m", "completed", 21000, 24000, 29000, 3000, 50, 999, 0, 0),
            ("main", "s", "t1", "main_turn", "m", "completed", 11000, 14000, 19000, 3000, 100, 500, 300, 0),
        ]
        out = self._with_db(self._file_db(rows, with_provider=False), "s")
        self.assertEqual(out["latest"]["outputTokens"], 500)   # main_turn 过滤仍在
        self.assertEqual(out["latest"]["genMs"], 8000)          # 缺列 → 默认 started_at 窗口

    def test_query_latest_end_to_end_applies_cover_set(self):
        # 端到端接线（接线变异 covers=frozenset() 的击杀用例）：落章 provider 的
        # latest 行用首字窗口；同形状数据换成推理前置 provider 用 started_at 窗口。
        def bulk(provider):
            return [(f"r{i}", "s", f"t{i}", "main_turn", "m", "completed",
                     1000 + i * 100000, 4000 + i * 100000, 8000 + i * 100000,
                     2500 if provider == "prov-covers" else 5 * (100 + 50 * i),
                     100, 500, 100 + 50 * i, 0, provider) for i in range(6)]
        covered = self._with_db(self._file_db(bulk("prov-covers")), "s")
        self.assertEqual(covered["latest"]["genMs"], 4000)   # ct−ft（首字窗口）
        before = self._with_db(self._file_db(bulk("prov-before")), "s")
        self.assertEqual(before["latest"]["genMs"], 7000)    # ct−st（默认窗口）


class TestTurnLineV376(unittest.TestCase):
    """v376 回答末尾统计行：生成耗时分级中文 / 模型 id 去重前置 / 本轮预估费用与开关。"""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(PLUGIN))
        import token_rate
        cls.tr = token_rate

    def base_turn(self, **over):
        t = {"tokPerSec": 256.9, "ttftMs": 3900, "totalOutput": 129200, "totalReasoning": 0,
             "genMs": 464800, "requests": 2, "peak": 300, "lastAt": 0,
             "models": ["GLM-5.3-FlashX"]}
        t.update(over)
        return {"turn": t, "session": {"totalOutput": 129200}}

    def test_gen_duration_tiers(self):
        f = self.tr._gen_duration
        self.assertEqual(f(3200), "3.2s")
        self.assertEqual(f(59940), "59.9s")       # 未达 59.95 仍在秒档
        self.assertEqual(f(59950), "1分0.0秒")    # 59.95 四舍五入到 60.0s 后走分档
        self.assertEqual(f(464800), "7分44.8秒")
        self.assertEqual(f(119950), "2分0.0秒")   # 分→时进位边界（119.95→120.0）
        self.assertEqual(f(3724800), "1时2分4.8秒")
        self.assertEqual(f(59995000), "16时39分55.0秒")
        self.assertEqual(f(0), "0.0s")
        self.assertEqual(f(None), "-")

    def test_gen_duration_in_turn_line(self):
        line = self.tr.format_turn_line(self.base_turn())
        self.assertIn("输出 12.92万 token / 生成 7分44.8秒", line)
        self.assertIn("⚡ GLM-5.3-FlashX 256.9 token/s(本轮)", line)

    def test_model_ids_dedup_in_first_seen_order(self):
        r = self.base_turn(models=["GLM-5.3-FlashX", "claude-sonnet-5-5", "GLM-5.3-FlashX", "", None])
        self.assertIn("⚡ GLM-5.3-FlashX/claude-sonnet-5-5 256.9 token/s(本轮)",
                      self.tr.format_turn_line(r))
        # 无模型 id（旧快照/空）时不拼前置段，退回原形态
        self.assertIn("⚡ 256.9 token/s(本轮)", self.tr.format_turn_line(self.base_turn(models=[])))

    def test_cost_segment_and_no_cost_switch(self):
        r = self.base_turn(cost_usd=12.34)
        # 价表模块可能缺失；用 mock 固定 fx 与金额格式化路径
        with mock.patch.object(self.tr, "_money", side_effect=lambda usd: "¥87.61"):
            on = self.tr.format_turn_line(r)
            off = self.tr.format_turn_line(r, cost=False)
        self.assertIn("累计 12.92万 token · 预估费用 ¥87.61", on)
        self.assertIn("累计 12.92万 token · ⏱", off)
        self.assertNotIn("预估费用", off)

    def test_cost_segment_omitted_when_unavailable(self):
        # cost_usd 缺失/None → 不拼费用段，不显假 0
        self.assertNotIn("预估费用", self.tr.format_turn_line(self.base_turn()))

    def test_cli_no_cost_flag_flips_cost_segment(self):
        """main() 的 argv→cost 映射（回归：变异把 `not in` 反转成本测试仍绿）。
        用真实子进程跑 --turn --current，同一库/状态下只有 --no-cost 有无之别；
        费用金额由内置价表算出，故带费用态必含『预估费用』，关费用态必不含。"""
        import tempfile, os
        from pathlib import Path
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = str(Path(tmp.name) / "db.sqlite")
        state = str(Path(tmp.name) / "state.json")
        con = sqlite3.connect(db)
        con.executescript(SCHEMA)
        now = int(time.time() * 1000)
        con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            ("r1", SID, "turn_x", "main_turn", "test-model", "completed",
             now - 10000, now - 9000, now - 1000, 1000, 2000, 4000, 0, 0, "account:fixture"),
        ])
        con.commit(); con.close()
        Path(state).write_text(json.dumps({"sessionId": SID, "ts": now, "promptTs": now - 20000}),
                               encoding="utf-8")
        env = dict(os.environ, ZCODE_USAGE_DB=db, ZUSAGE_RATE_STATE_FILE=state,
                   PYTHONDONTWRITEBYTECODE="1")
        base = [sys.executable, "-B", str(RATE), "--turn", "--current", "--session", SID]
        on = subprocess.run(base, capture_output=True, encoding="utf-8", env=env, timeout=30).stdout
        off = subprocess.run(base + ["--no-cost"], capture_output=True, encoding="utf-8", env=env, timeout=30).stdout
        self.assertIn("预估费用", on, on)
        self.assertNotIn("预估费用", off, off)

    def test_query_turn_populates_models_and_cost_from_db(self):
        """query_turn 必须把本轮模型 id（去重、首次出现序）与本轮费用真值带进 turn；
        回归：_turn_cost 曾误经 scope_for 子查询取列（SELECT 无 turn_id/缓存写列）
        导致费用恒 None。用自建临时库直调 query_turn（_pricing 内置价表恒可用）。"""
        import sqlite3, tempfile, os
        fd, path = tempfile.mkstemp(suffix='.db')
        os.close(fd)
        try:
            con = sqlite3.connect(path)
            con.row_factory = sqlite3.Row
            con.executescript(SCHEMA)
            con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
                ("r1", SID, "turn_x", "main_turn", "GPT-A", "completed", 1000, 1200, 8000, 200,
                 1000, 2000, 0, 0, "account:fixture"),
                ("r2", SID, "turn_x", "main_turn", "GPT-B", "completed", 9000, 9200, 16000, 200,
                 1000, 2000, 0, 0, "account:fixture"),
                ("r3", SID, "turn_x", "main_turn", "GPT-A", "completed", 17000, 17200, 24000, 200,
                 1000, 2000, 0, 0, "account:fixture"),
            ])
            con.commit(); con.close()
            def _open():
                c = sqlite3.connect(path)
                c.row_factory = sqlite3.Row
                return c
            with mock.patch.object(self.tr, 'open_db', side_effect=_open):
                with mock.patch.object(self.tr, 'DB_PATH', path):
                    r = self.tr.query_turn(SID, current=False)
            t = r["turn"]
            self.assertIsNotNone(t, "turn should be found")
            self.assertEqual(t["models"], ["GPT-A", "GPT-B"])   # 去重、首次出现序
            self.assertIsInstance(t["cost_usd"], float)
            self.assertGreater(t["cost_usd"], 0)
        finally:
            try: os.unlink(path)
            except OSError: pass


class _RateCliMixin:
    """按子会话跑插件副本 token_rate.py（ZCODE_USAGE_DB 隔离库、独立状态文件）。"""

    def run_rate(self, *args, sid="sess_subagent_x"):
        env = dict(os.environ, ZCODE_USAGE_DB=self.db, ZCODE_SESSION_ID=sid,
                   ZUSAGE_RATE_STATE_FILE=str(Path(self.tmp.name) / "state.json"))
        return subprocess.run([sys.executable, str(RATE), *args],
                              capture_output=True, encoding="utf-8", env=env, timeout=30)

    def write_prompt_state(self, sid, ts):
        """给会话记一个提问时刻（prompt-submit hook 写的同款状态形状）：让 --current 越过
        missingPromptState 门，后续的身份门才轮得到被测。"""
        Path(self.tmp.name, "state.json").write_text(json.dumps(
            {"sessionId": sid, "ts": int(time.time() * 1000), "source": "prompt-submit", "prompts": {sid: ts}}),
            encoding="utf-8")

    def _cleanup(self):
        for attempt in range(5):
            try:
                self.tmp.cleanup()
                break
            except OSError:
                time.sleep(0.2 * (attempt + 1))


class SubagentLatestTurnTests(_RateCliMixin, unittest.TestCase):
    """v458（specs/subagent-turn-stats-line.md）：子代理会话不带 --current 的查询形状（命令行直接
    查子会话时可用）。latestTurn = started_at 最新的那一轮——它不判轮是否结束，是否可信由调用方
    保证；渲染端的子代理窗格统计行因此不走这条路径，走 --turn-ref（见 SubagentTurnRefTests）。
    scope_for 对无 main_turn 的会话回退全量行：会话均/累计来自 subagent 行本身，非 0。

    口径（窗口=completed−first_token）：s1 窗口 8.0s 输出 1000 → 125.0；s2 窗口 3.0s 输出
    500 → 166.7（latestTurn = started_at 最新的 s2）；会话均 = 1500 / 11.0s = 136.4。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "db.sqlite")
        now = int(time.time() * 1000)
        t0 = now - 60_000
        self.t0 = t0
        self.rows = [
            row("s1", "sess_subagent_x", "turn_s1", "subagent", t0 - 10000, t0 - 8000, 2000, t0, 100, 1000, 0),
            row("s2", "sess_subagent_x", "turn_s2", "subagent", t0 + 1000, t0 + 2000, 1000, t0 + 5000, 200, 500, 0),
        ]
        make_db(self.db, self.rows)

    def tearDown(self):
        self._cleanup()

    def _add_rows(self, rows):
        con = sqlite3.connect(self.db)
        con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        con.commit()
        con.close()

    def test_latest_turn_line_for_subagent_session(self):
        r = self.run_rate("--turn", "--session", "sess_subagent_x")
        self.assertEqual(r.returncode, 0, r.stderr)
        line = r.stdout.strip()
        self.assertIn("166.7 token/s(本轮)", line)          # latestTurn = started_at 最新的 s2
        self.assertNotIn("125 token/s(本轮)", line)         # 不是更早的 s1（整数速率不带小数）
        self.assertIn("会话均 136.4 token/s", line)          # scope_for 全量回退：subagent 行进会话均
        self.assertIn("累计 1,500 token", line)
        self.assertIn("token/s(本轮)", line)

    def test_current_guard_still_fails_closed_for_subagent_session(self):
        # --current 对子会话：无提问时刻记录 → 空输出（没有 turnRef 的子代理请求走这条，fail-closed）
        r = self.run_rate("--turn", "--current", "--session", "sess_subagent_x", sid="sess_subagent_x")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")

    def test_json_session_aggregate_for_subagent_session(self):
        r = self.run_rate("--turn", "--session", "sess_subagent_x", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertIsNotNone(data["turn"])
        self.assertIsNotNone(data.get("session"))
        self.assertAlmostEqual(data["session"]["sessionAvg"], 136.4, places=1)
        self.assertEqual(data["session"]["totalOutput"], 1500)

    def test_latest_turn_fallback_skips_compact_rows(self):
        # 子会话的回退只排除压缩请求：更晚的 compact 行（宿主可能给它独立的 turn_id）不被选成「最新一轮」
        self._add_rows([row("c1", "sess_subagent_x", "turn_compact", "compact", self.t0 + 20000, self.t0 + 20001,
                            1000, self.t0 + 21000, 300, 3000, 0)])
        r = self.run_rate("--turn", "--session", "sess_subagent_x")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("166.7 token/s(本轮)", r.stdout)
        self.assertNotIn("3,000", r.stdout.split("会话均")[0])

    def test_latest_turn_keeps_main_turn_rows_for_main_session(self):
        # 有 main_turn 行的会话不触发回退：更晚的非 main_turn 行（辅助请求带独立 turn_id）不被选成最新一轮
        t0 = self.t0
        db = str(Path(self.tmp.name) / "main.sqlite")
        make_db(db, [
            row("m1", "sess_main", "turn_m1", "main_turn", t0 - 10000, t0 - 8000, 2000, t0, 100, 1000, 0),
            row("m2", "sess_main", "turn_m2", "session_title", t0 + 1000, t0 + 2000, 1000, t0 + 3000, 200, 500, 0),
        ])
        self.db = db
        r = self.run_rate("--turn", "--session", "sess_main", "--json", sid="sess_main")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["turnId"], "turn_m1")   # 非 main_turn 行没被选成最新一轮

    def test_current_path_keeps_main_turn_filter_for_sessions_without_main_rows(self):
        # 回退只在「不带提问时刻」的查询上生效：--current（prompt_ts 非空）的选轮与改动前一致，
        # 没有 main_turn 行的会话即使带着提问状态记录也是空输出（真实子会话不会有提问状态，这里人为构造）
        self.write_prompt_state("sess_subagent_x", self.t0 - 1000)   # 两轮都在提问时刻之后
        r = self.run_rate("--turn", "--current", "--session", "sess_subagent_x")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")
        data = json.loads(self.run_rate("--turn", "--current", "--session", "sess_subagent_x", "--json").stdout)
        self.assertIsNone(data["turn"])
        self.assertTrue(data["noCurrentTurnData"])
        self.assertEqual(data["currentTurnUnavailableReason"], "missingTurnIdentity")   # 原因分类同样只认 main_turn，与改动前一致
        # 对照：同一提问状态下不带 --current，回退照常生效
        self.assertIn("166.7 token/s(本轮)", self.run_rate("--turn", "--session", "sess_subagent_x").stdout)

    def test_latest_turn_fallback_treats_null_query_source_as_non_compact(self):
        # 回退只排除压缩请求：query_source 为空的行照常参与（SQL 的 != 对 NULL 求值为假，必须显式放行）
        db = str(Path(self.tmp.name) / "nullable.sqlite")
        con = sqlite3.connect(db)
        con.executescript(SCHEMA.replace("query_source text not null", "query_source text"))
        con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            row("s2", "sess_subagent_x", "turn_s2", "subagent", self.t0 + 1000, self.t0 + 2000, 1000, self.t0 + 5000, 200, 500, 0),
            row("n1", "sess_subagent_x", "turn_null", None, self.t0 + 20000, self.t0 + 21000, 1000, self.t0 + 24000, 100, 600, 0),
        ])
        con.commit()
        con.close()
        self.db = db
        r = self.run_rate("--turn", "--session", "sess_subagent_x", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["turnId"], "turn_null")   # 最新一轮就是 query_source 为空的那一轮
        self.assertAlmostEqual(data["turn"]["tokPerSec"], 200.0, places=1)   # 600 / 3.0s

    def test_probe_is_scoped_to_the_queried_session(self):
        # 「有没有 main_turn 行」只看被查询的会话：库里另有带 main_turn 行的主会话时，子会话照样回退
        self._add_rows([row("m1", "sess_main", "turn_m1", "main_turn", self.t0 - 10000, self.t0 - 8000, 2000,
                            self.t0, 100, 1000, 0)])
        r = self.run_rate("--turn", "--session", "sess_subagent_x")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("166.7 token/s(本轮)", r.stdout)

    def test_probe_failure_keeps_main_turn_filter(self):
        # 「有没有 main_turn 行」的探测抛错时保持 main_turn 过滤：宁可查不到也不放宽（fail-closed）
        sys.path.insert(0, str(PLUGIN))
        import token_rate
        t0 = self.t0
        db = str(Path(self.tmp.name) / "main.sqlite")
        make_db(db, [
            row("m1", "sess_main", "turn_m1", "main_turn", t0 - 10000, t0 - 8000, 2000, t0, 100, 1000, 0),
            row("m2", "sess_main", "turn_m2", "session_title", t0 + 1000, t0 + 2000, 1000, t0 + 3000, 200, 500, 0),
        ])

        class ProbeFails:
            def __init__(self, inner):
                self._inner = inner

            def execute(self, sql, args=()):
                if "query_source='main_turn' limit 1" in sql:
                    raise sqlite3.OperationalError("probe failed")
                return self._inner.execute(sql, args)

        con = sqlite3.connect(db)
        try:
            self.assertEqual(token_rate.latest_turn_id(ProbeFails(con), "sess_main"), "turn_m1")
        finally:
            con.close()

    def test_probe_runs_only_when_the_fallback_can_apply(self):
        # 用不上回退的查询（带提问时刻，或调用方关掉回退）不做「有没有 main_turn 行」的探测：
        # --current 路径的查询次数与改动前一致
        sys.path.insert(0, str(PLUGIN))
        import token_rate
        seen = []

        class Recorder:
            def __init__(self, inner):
                self._inner = inner

            def execute(self, sql, args=()):
                seen.append(" ".join(sql.split()))
                return self._inner.execute(sql, args)

        probes = lambda: [s for s in seen if s.startswith("select 1 from model_usage where")]   # 探测语句的特征
        con = sqlite3.connect(self.db)
        try:
            rec = Recorder(con)
            self.assertIsNone(token_rate.latest_turn_id(rec, "sess_subagent_x", self.t0 - 1000))   # 带提问时刻：只认 main_turn，不探测
            self.assertEqual(probes(), [])
            seen.clear()
            self.assertIsNone(token_rate.latest_turn_id(rec, "sess_subagent_x", None, allow_fallback=False))
            self.assertEqual(probes(), [])
            seen.clear()
            self.assertEqual(token_rate.latest_turn_id(rec, "sess_subagent_x"), "turn_s2")        # 不带提问时刻：探测后回退
            self.assertEqual(len(probes()), 1)
        finally:
            con.close()


def ref_row(rid, sid, turn, source, started, ft, ttft, completed, inp, out, rea, ref):
    """基础 row() 再带一列 parent_user_message_id（真库每条用量行都有；基础 SCHEMA 没有这一列）。"""
    return row(rid, sid, turn, source, started, ft, ttft, completed, inp, out, rea) + (ref,)


class SubagentTurnRefTests(_RateCliMixin, unittest.TestCase):
    """v458 子代理窗格统计行：--turn-ref <页面轮号>。页面 data-turn-id 就是宿主写在用量行上的
    parent_user_message_id（与 model_usage.turn_id 不是同一套 id）；只认该会话内该轮号对应的唯一
    一轮，且 turn_usage 已有该轮行（轮结束时才写）才出数——别的轮、进行中的轮、库还没追上的轮
    一律空输出，绝不回退到「最新一轮」。"""

    SUB = "sess_subagent_x"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "db.sqlite")
        now = int(time.time() * 1000)
        t0 = now - 60_000
        self.t0 = t0
        self.rows = [
            ref_row("s1", self.SUB, "turn_s1", "subagent", t0 - 10000, t0 - 8000, 2000, t0, 100, 1000, 0, "msg_a"),
            ref_row("s2", self.SUB, "turn_s2", "subagent", t0 + 1000, t0 + 2000, 1000, t0 + 5000, 200, 500, 0, "msg_b"),
        ]
        # turn_s1 已结束（有 turn_usage 行）；turn_s2 还没有行 = 进行中
        self.make(self.rows, [("turn_s1", "completed", t0)])

    def tearDown(self):
        self._cleanup()

    def make(self, rows, turn_rows=(), with_column=True, with_turn_usage=True):
        if os.path.exists(self.db):
            os.unlink(self.db)   # 同一用例里换一种库形状重建
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        if with_column:
            con.execute("alter table model_usage add column parent_user_message_id text")
        if with_turn_usage:
            con.execute("create table turn_usage (session_id text, turn_id text, status text, completed_at integer)")
            con.executemany("insert into turn_usage values (?,?,?,?)",
                            [(self.SUB, t, st, ca) for t, st, ca in turn_rows])
        if with_column:
            con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        else:
            con.executemany("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            [r[:-1] for r in rows])
        con.commit()
        con.close()

    def test_ref_resolves_exactly_that_turn(self):
        r = self.run_rate("--turn", "--turn-ref", "msg_a", "--session", self.SUB)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("125 token/s(本轮)", r.stdout)          # 就是 msg_a 这一轮……
        self.assertNotIn("166.7", r.stdout.split("会话均")[0])  # ……不是更新的 turn_s2
        self.assertIn("会话均 136.4 token/s", r.stdout)        # 会话均/累计仍走 scope_for 全量回退
        r2 = self.run_rate("--turn", "--turn-ref", "msg_b=older", "--session", self.SUB)
        self.assertEqual(r2.stdout, "")                       # 轮号是前缀也不行：整串精确匹配

    def test_ref_resolves_latest_turn_too(self):
        self.end_turn("turn_s2")
        r = self.run_rate("--turn", "--turn-ref", "msg_b", "--session", self.SUB, "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertEqual(data["turnId"], "turn_s2")
        self.assertEqual(data["turnIdentitySource"], "parentTurnRef")
        self.assertTrue(data["currentTurnIdentityVerified"])
        self.assertAlmostEqual(data["turn"]["tokPerSec"], 166.7, places=1)

    def test_turn_not_ended_yields_nothing(self):
        # turn_s2 有已入库的请求但 turn_usage 还没有行（轮在进行中）：不出半截统计
        r = self.run_rate("--turn", "--turn-ref", "msg_b", "--session", self.SUB)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")
        j = self.run_rate("--turn", "--turn-ref", "msg_b", "--session", self.SUB, "--json")
        data = json.loads(j.stdout)
        self.assertIsNone(data["turn"])
        self.assertTrue(data.get("turnPending"))

    def end_turn(self, turn_id, status="completed"):
        con = sqlite3.connect(self.db)
        con.execute("insert into turn_usage values (?,?,?,?)", (self.SUB, turn_id, status, self.t0 + 9000))
        con.commit()
        con.close()

    def test_turn_ended_by_cancellation_or_error_still_outputs(self):
        # 「轮已结束」= turn_usage 有终态行：取消、出错的轮同样照常出数（不是只有 completed 才算）
        for status in ("cancelled", "error"):
            self.end_turn("turn_s2", status)
            r = self.run_rate("--turn", "--turn-ref", "msg_b", "--session", self.SUB)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("166.7 token/s(本轮)", r.stdout, status)

    def test_turn_usage_row_with_non_terminal_status_is_not_ended(self):
        # 宿主若改成轮开始就写行：status 不是终态的行同样判「未结束」，不出半截统计
        self.end_turn("turn_s2", "running")
        r = self.run_rate("--turn", "--turn-ref", "msg_b", "--session", self.SUB, "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertIsNone(data["turn"])
        self.assertTrue(data.get("turnPending"))

    def test_unknown_ref_never_falls_back_to_latest_turn(self):
        r = self.run_rate("--turn", "--turn-ref", "msg_zzz", "--session", self.SUB, "--json")
        data = json.loads(r.stdout)
        self.assertIsNone(data["turn"])
        self.assertFalse(data.get("turnPending"))

    def test_ref_helpers_are_scoped_to_the_queried_session(self):
        # 两个 helper 都按（会话, 轮号）/（会话, turn_id）限定——直接调函数断言，不靠「输出为空」归因
        sys.path.insert(0, str(PLUGIN))
        import token_rate
        con = sqlite3.connect(self.db)
        try:
            self.assertEqual(token_rate.turn_id_for_ref(con, self.SUB, "msg_a"), "turn_s1")
            self.assertIsNone(token_rate.turn_id_for_ref(con, "sess_subagent_other", "msg_a"))
            self.assertTrue(token_rate.turn_ended(con, self.SUB, "turn_s1"))
            self.assertFalse(token_rate.turn_ended(con, "sess_subagent_other", "turn_s1"))
        finally:
            con.close()

    def test_ref_on_other_session_is_not_found(self):
        # 同一个页面轮号出现在别的会话里：只按（会话, 轮号）定位，不跨会话借用
        r = self.run_rate("--turn", "--turn-ref", "msg_a", "--session", "sess_subagent_other")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")

    def test_ref_over_upper_bound_is_rejected_before_the_lookup(self):
        # 库里真有一行轮号长 81 且已结束：长度上限仍要在查库之前拒绝（「格式放行后查不到」也是空输出，分不出来）
        long_ref = "a" * 81
        con = sqlite3.connect(self.db)
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ref_row("s10", self.SUB, "turn_s10", "subagent", self.t0 + 50000, self.t0 + 51000, 1000,
                            self.t0 + 52000, 100, 700, 0, long_ref))
        con.execute("insert into turn_usage values (?,?,?,?)", (self.SUB, "turn_s10", "completed", self.t0 + 52000))
        con.commit()
        con.close()
        r = self.run_rate("--turn", "--turn-ref", long_ref, "--session", self.SUB)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")

    def test_ambiguous_ref_fails_closed(self):
        con = sqlite3.connect(self.db)
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ref_row("s9", self.SUB, "turn_s9", "subagent", self.t0 + 30000, self.t0 + 31000, 1000,
                            self.t0 + 32000, 100, 900, 0, "msg_a"))
        con.execute("insert into turn_usage values (?,?,?,?)", (self.SUB, "turn_s9", "completed", self.t0 + 32000))
        con.commit()
        con.close()
        r = self.run_rate("--turn", "--turn-ref", "msg_a", "--session", self.SUB)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")                       # 一个轮号对上两轮：不猜

    def test_ref_conflicting_with_other_identity_fails_closed(self):
        # --current 这一支要真的被走到：先给子会话记上提问时刻，否则它更早被 missingPromptState 门拦下
        self.write_prompt_state(self.SUB, self.t0 - 1000)
        for extra in (["--current"], ["--turn-id", "turn_s1"]):
            r = self.run_rate("--turn", "--turn-ref", "msg_a", *extra, "--session", self.SUB)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout, "", " ".join(extra))
        # 对照：同一提问状态下去掉冲突项，--turn-ref 照常出数（证明确实是冲突门拦的）
        self.assertIn("125 token/s(本轮)",
                      self.run_rate("--turn", "--turn-ref", "msg_a", "--session", self.SUB).stdout)

    def test_invalid_ref_format_fails_closed(self):
        # 库里故意放一行轮号带空白的用量（并通过已结束门）：格式校验必须在查库之前拒绝它
        con = sqlite3.connect(self.db)
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ref_row("s8", self.SUB, "turn_s8", "subagent", self.t0 + 40000, self.t0 + 41000, 1000,
                            self.t0 + 42000, 100, 800, 0, "bad ref"))
        con.execute("insert into turn_usage values (?,?,?,?)", (self.SUB, "turn_s8", "completed", self.t0 + 42000))
        con.commit()
        con.close()
        for bad in ("bad ref", "a" * 81, "", "-x"):
            r = self.run_rate("--turn", "--turn-ref", bad, "--session", self.SUB)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout, "", repr(bad))

    def test_ref_with_trailing_newline_is_rejected_even_if_seeded(self):
        # 结尾换行：re 的 $ 会放过它，JS 侧不会；两端要一致，所以 Python 用 fullmatch。
        # 库里真有一行轮号以换行结尾且已结束，格式校验仍要在查库之前拒绝它
        con = sqlite3.connect(self.db)
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ref_row("s12", self.SUB, "turn_s12", "subagent", self.t0 + 70000, self.t0 + 71000, 1000,
                            self.t0 + 72000, 100, 800, 0, "msg_x\n"))
        con.execute("insert into turn_usage values (?,?,?,?)", (self.SUB, "turn_s12", "completed", self.t0 + 72000))
        con.commit()
        con.close()
        for bad in ("msg_x\n", "msg_x\r", "msg_x\r\n"):
            r = self.run_rate("--turn", "--turn-ref", bad, "--session", self.SUB)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout, "", repr(bad))

    def test_ref_starting_with_dash_is_rejected_even_if_seeded(self):
        # 轮号以 - 开头像命令行开关：库里真有这样一个已结束的轮也不出数。--json 这种值还会同时被
        # 当成输出开关——输出只能是空结果的 JSON，不能带出任何一轮
        con = sqlite3.connect(self.db)
        con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ref_row("s11", self.SUB, "turn_s11", "subagent", self.t0 + 60000, self.t0 + 61000, 1000,
                            self.t0 + 62000, 100, 800, 0, "--json"))
        con.execute("insert into turn_usage values (?,?,?,?)", (self.SUB, "turn_s11", "completed", self.t0 + 62000))
        con.commit()
        con.close()
        for bad in ("--json", "-x", "--current"):
            r = self.run_rate("--turn", "--turn-ref", bad, "--session", self.SUB)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stderr, "", bad)
            if bad == "--json":                    # 它同时被当成输出开关
                data = json.loads(r.stdout)
                self.assertIsNone(data["turn"], bad)
                self.assertIsNone(data["turnId"], bad)
                self.assertNotIn("tokPerSec", r.stdout, bad)
            else:
                self.assertEqual(r.stdout, "", bad)

    def test_missing_parent_column_or_turn_usage_table_fails_closed(self):
        rows = self.rows

        def stdout_of(query):
            r = self.run_rate("--turn", "--turn-ref", "msg_a", "--session", self.SUB)
            self.assertEqual(r.returncode, 0, query + ": " + r.stderr)   # 缺列/缺表由 helper 兜住，不抛 traceback
            self.assertEqual(r.stderr, "", query)                       # 主桥据此记成 empty 而不是 pyerr
            return r.stdout

        # 库没有 parent_user_message_id 列：定位不到轮
        self.make(rows, [("turn_s1", "completed", self.t0)], with_column=False)
        self.assertEqual(stdout_of("缺列"), "")
        # 库没有 turn_usage 表：无法证明轮已结束
        self.make(rows, [], with_turn_usage=False)
        self.assertEqual(stdout_of("缺表"), "")
        # 两个都齐备才出行
        self.make(rows, [("turn_s1", "completed", self.t0)])
        self.assertIn("125 token/s(本轮)", stdout_of("齐备"))

    def test_missing_database_fails_closed(self):
        # 库文件不存在（open_db 返回 None）：--turn-ref 不抛异常、空输出
        self.db = str(Path(self.tmp.name) / "absent.sqlite")
        r = self.run_rate("--turn", "--turn-ref", "msg_a", "--session", self.SUB)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")

    def test_ref_flag_without_value_fails_closed(self):
        # --turn-ref 是最后一个参数（后面没有值）：按非法轮号处理，不落到「最新一轮」
        args = ("--turn", "--session", self.SUB, "--turn-ref")
        r = self.run_rate(*args)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")
        data = json.loads(self.run_rate(*args, "--json").stdout)
        self.assertIsNone(data["turnId"])
        self.assertIsNone(data["turn"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
