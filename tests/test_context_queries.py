import json
import os
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

import zusage


def _hours_ago_ms(n=1):
    return int(time.time() * 1000) - n * 3600 * 1000


class ContextQueriesTests(unittest.TestCase):
    """最小夹具（model_usage / turn_usage 只有早期列）：锁定既有口径，并覆盖缺列时的降级路径。"""

    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript("""
            CREATE TABLE session (
                id TEXT PRIMARY KEY, title TEXT, directory TEXT,
                time_created INTEGER, time_updated INTEGER,
                summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER
            );
            CREATE TABLE model_usage (
                id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, query_source TEXT,
                provider_id TEXT, model_id TEXT, status TEXT,
                started_at INTEGER, first_token_at INTEGER, completed_at INTEGER,
                duration_ms INTEGER, time_to_first_token_ms INTEGER, tool_call_count INTEGER,
                input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
                cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER
            );
            CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT);
            CREATE TABLE tool_usage (
                id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT,
                status TEXT, exit_code INTEGER, duration_ms INTEGER,
                started_at INTEGER, completed_at INTEGER
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER
            );
        """)
        now_ms = int(time.time() * 1000)
        self.con.execute(
            "INSERT INTO session VALUES ('sess_a','Test Session','/tmp/proj',?,?,10,2,1)",
            (now_ms - 5000, now_ms),
        )
        self.con.execute(
            "INSERT INTO model_usage VALUES ('r1','sess_a','t1','main_turn','deepseek','deepseek-chat','completed',?,?,?,?,?,1,1000,200,50,100,600)",
            (now_ms - 4000, now_ms - 3500, now_ms - 2000, 2000, 500),
        )
        self.con.execute("INSERT INTO turn_usage VALUES ('sess_a','t1')")
        self.con.execute(
            "INSERT INTO tool_usage VALUES ('tu1','sess_a','Read','completed',0,120,?,?)",
            (now_ms - 3000, now_ms - 2880),
        )
        self.con.execute(
            "INSERT INTO message VALUES ('m1','sess_a',?, ?, 1)",
            (now_ms - 4000, json.dumps({"role": "user"})),
        )
        self.con.execute(
            "INSERT INTO part VALUES ('p1','m1','sess_a',?, ?, 0)",
            (now_ms - 4000, json.dumps({"type": "text", "text": "hello world"})),
        )
        self.con.execute(
            "INSERT INTO message VALUES ('m2','sess_a',?, ?, 2)",
            (now_ms - 2000, json.dumps({"role": "assistant", "modelId": "deepseek-chat"})),
        )
        self.con.execute(
            "INSERT INTO part VALUES ('p2','m2','sess_a',?, ?, 0)",
            (now_ms - 2000, json.dumps({"type": "tool", "tool": "Read", "callID": "c1", "state": {"status": "completed", "input": {"file_path": "/tmp/a.py"}, "output": "x"}})),
        )
        self.con.commit()

    def tearDown(self):
        self.con.close()

    def test_session_stats_json(self):
        res = zusage.session_stats_json(self.con, "sess_a")
        self.assertTrue(res["ok"])
        self.assertEqual(res["kpi"]["turns"], 1)
        self.assertEqual(res["kpi"]["steps"], 1)
        self.assertEqual(res["kpi"]["toolCalls"], 1)
        self.assertEqual(res["kpi"]["bareInputTokens"], 300)
        self.assertEqual(res["kpi"]["cacheHitRate"], 60.0)
        self.assertEqual(res["timing"]["avgTtftMs"], 500)
        self.assertEqual(res["tools"][0]["name"], "Read")

    def test_session_browser_json(self):
        res = zusage.session_browser_json(self.con, "sess_a", limit=20, offset=0)
        self.assertTrue(res["ok"])
        self.assertEqual(res["totalMessages"], 2)
        self.assertEqual(len(res["messages"]), 2)
        self.assertEqual(res["fileActivity"][0]["path"], "/tmp/a.py")
        self.assertEqual(res["fileActivity"][0]["read"], 1)

    def test_insights_json(self):
        res = zusage.insights_json(self.con, days=7)
        self.assertTrue(res["ok"])
        self.assertEqual(res["kpi"]["sessions"], 1)
        self.assertEqual(res["kpi"]["billedTokens"], 1200)
        self.assertEqual(len(res["daily"]), 7)
        self.assertEqual(len(res["heatmap"]), 56)
        self.assertEqual(res["topTools"][0]["name"], "Read")
        self.assertEqual(res["sessions"][0]["id"], "sess_a")

    def test_model_detail_lists(self):
        # 会话级：models[] 按 tokens 降序，含 provider/requests/avgTps/costUsd
        res = zusage.session_stats_json(self.con, "sess_a")
        models = res["models"]
        self.assertEqual(len(models), 1)
        m = models[0]
        self.assertEqual(m["model"], "deepseek-chat")
        self.assertEqual(m["provider"], "deepseek")
        self.assertEqual(m["tokens"], 1200)
        self.assertEqual(m["requests"], 1)
        # dur=2000, ttft=500 → gen_ms=1500；out=200 → 200/1.5=133.3
        self.assertEqual(m["avgTps"], 133.3)
        self.assertIn("costUsd", m)
        # kpi.perModelCost 保留原形状（mid → cost 浮点）
        self.assertIn("deepseek-chat", res["kpi"]["perModelCost"])

        # 洞察级：topModels[] 补 avgTps
        ins = zusage.insights_json(self.con, days=7)
        tm = ins["topModels"]
        self.assertEqual(len(tm), 1)
        self.assertEqual(tm[0]["modelId"], "deepseek-chat")
        self.assertEqual(tm[0]["tokens"], 1200)
        self.assertEqual(tm[0]["requests"], 1)
        self.assertEqual(tm[0]["avgTps"], 133.3)

        # 热力图 56 格都带 avgTps 键；唯一有样本的一天均速 133.3（与日期边界无关）
        self.assertEqual([h["avgTps"] for h in ins["heatmap"] if h["avgTps"]], [133.3])
        # 会话卡起止时间：透传 session.time_created / time_updated
        self.assertGreater(ins["sessions"][0]["createdAt"], 0)
        self.assertGreater(ins["sessions"][0]["endTime"], 0)

    def test_degraded_columns_still_shape_new_fields(self):
        """夹具没有 error_type / retry_count / read_only / turn_usage 明细列：新字段按 0 降级，不抛。"""
        res = zusage.session_stats_json(self.con, "sess_a")
        self.assertEqual(res["errors"]["byType"], {})
        self.assertEqual(res["errors"]["requests"], 1)
        self.assertEqual(res["toolQuality"]["total"], 1)
        self.assertEqual(res["toolQuality"]["p50Ms"], 120)
        self.assertEqual(res["turns"], [{"n": 1, "turnId": "t1", "status": "", "startedAt": 0, "completedAt": 0, "durationMs": 0,
                                         "requests": 0, "retries": 0, "toolCalls": 0, "toolErrors": 0, "inputTokens": 0, "outputTokens": 0,
                                         "reasoningTokens": 0, "cacheReadTokens": 0, "cancelled": False, "contextExceeded": False,
                                         "errorType": ""}])
        self.assertEqual(res["tokenBreakdownBasis"], "ratio")
        self.assertIsNone(res["capture"])
        # 实测五分之和 = 总用量；耗时三段之和 = 模型总时长
        self.assertEqual(sum(x["tokens"] for x in res["tokenSplit"]), res["kpi"]["billedTokens"])
        self.assertEqual(res["timing"]["ttftMs"] + res["timing"]["genMs"], res["timing"]["modelDurationMs"])
        ins = zusage.insights_json(self.con, days=7)
        self.assertEqual(ins["errors"]["byType"], {})
        self.assertEqual(sum(x["tokens"] for x in ins["tokenSplit"]), ins["kpi"]["billedTokens"])
        self.assertEqual(ins["timingBreakdown"]["ttftMs"] + ins["timingBreakdown"]["genMs"], ins["timingBreakdown"]["modelMs"])


class ContextQueriesRichTests(unittest.TestCase):
    """富夹具：多来源（主/子/辅助）、失败与重试、取消、真实压缩 part、逐轮明细、工具质量列。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.now = now = _hours_ago_ms(2)   # 夹具请求都在两小时前；日桶按这个时刻的本地日期取，不假设它是「今天」
        ms = lambda ago: now - ago * 1000   # noqa: E731  「ago 秒前」的毫秒时间戳
        self.con.executescript("""
            CREATE TABLE session (
                id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
                time_created INTEGER, time_updated INTEGER,
                summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER
            );
            CREATE TABLE model_usage (
                id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, trace_id TEXT, query_source TEXT,
                provider_id TEXT, model_id TEXT, status TEXT,
                started_at INTEGER, first_token_at INTEGER, completed_at INTEGER,
                duration_ms INTEGER, time_to_first_token_ms INTEGER, tool_call_count INTEGER,
                input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
                cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
                error_type TEXT, retry_count INTEGER, cancelled_by_user INTEGER, assistant_message_id TEXT
            );
            CREATE TABLE turn_usage (
                session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
                model_request_count INTEGER, model_retry_count INTEGER, tool_call_count INTEGER, tool_error_count INTEGER,
                input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER,
                cancelled_by_user INTEGER, context_exceeded INTEGER, error_type TEXT, user_message_id TEXT
            );
            CREATE TABLE tool_usage (
                id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT, status TEXT, exit_code INTEGER, duration_ms INTEGER,
                started_at INTEGER, completed_at INTEGER, read_only INTEGER, destructive INTEGER, truncated INTEGER
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER
            );
        """)
        rows = [
            # id      turn   query_source    status      started   first     completed  dur    ttft  tools  in    out   reas  cw    cr    error         retry  cancel  amid
            ("r1", "t1", "main_turn", "completed", ms(40), ms(35), ms(20), 2000, 500, 1, 1000, 200, 50, 100, 600, None, 0, 0, "m2"),
            ("r2", "t1", "main_turn", "error", ms(19), ms(19), ms(16), 300, 0, 0, 0, 0, 0, 0, 0, "rate_limited", 0, 0, None),
            ("r3", "t2", "main_turn", "completed", ms(15), ms(12), ms(5), 1000, 300, 0, 500, 100, 0, 0, 400, None, 1, 0, "m4"),
            ("r5", None, "session_title", "completed", ms(9), ms(8), ms(7), 200, 100, 0, 50, 10, 0, 0, 0, None, 0, 0, None),
            ("r6", "t2", "main_turn", "cancelled", ms(4), ms(3), ms(3), 100, 50, 0, 20, 0, 0, 0, 0, "cancelled", 0, 1, None),
        ]
        for r in rows:
            self.con.execute(
                "INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (r[0], "sess_a", r[1], "trace-A", r[2], "deepseek", "deepseek-chat", r[3],
                 r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17], r[18]),
            )
        self.con.execute(
            "INSERT INTO model_usage (id, session_id, turn_id, trace_id, query_source, provider_id, model_id, status, "
            "started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, tool_call_count, "
            "input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens) "
            "VALUES ('s1','sess_sub','st1','trace-A','subagent','zhipu','glm-flash','completed',?,?,?,2000,100,2,2000,400,100,0,1500)",
            (ms(30), ms(29), ms(10)),
        )
        self.con.execute("INSERT INTO session VALUES ('sess_a',NULL,'Main','/tmp/proj',?,?,3,1,2)", (ms(60), ms(1)))
        self.con.execute("INSERT INTO session VALUES ('sess_sub','sess_a','Sub','/tmp/proj',?,?,0,0,0)", (ms(31), ms(9)))
        # ms(x) = x 秒前（x 越大越早）。started_at 故意比用户消息晚 1 秒（数值小 1）：
        # 逐轮窗口必须按 user_message_id 定位消息，按 started_at 会漏掉该轮的首条消息
        for tid, status, st, done, reqs, retries in (("t1", "completed", ms(40), ms(16), 2, 0), ("t2", "completed", ms(15), ms(4), 2, 1)):
            self.con.execute(
                "INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("sess_a", tid, status, st, done, done - st, reqs, retries, 1, 0, 1500, 300, 50, 1000, 0, 0, "", "m1" if tid == "t1" else "m3"),
            )
        tools = [
            ("tu1", "Read", "completed", 0, 120, 1, 0, 0),
            ("tu2", "Bash", "error", None, 50, 0, 0, 0),
            ("tu3", "Bash", "completed", 1, 3000, 0, 0, 1),
        ]
        for t in tools:
            self.con.execute(
                "INSERT INTO tool_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (t[0], "sess_a", t[1], t[2], t[3], t[4], ms(30), ms(30), t[5], t[6], t[7]),
            )
        # 消息 m1..m5：序列与时间同向递增；m2/m4 是带用量行的 assistant 消息
        msgs = [
            ("m1", 1, ms(41), {"role": "user"}, [{"type": "text", "text": "first question"}]),
            ("m2", 2, ms(20), {"role": "assistant", "modelId": "deepseek-chat"},
             [{"type": "tool", "tool": "Bash", "callID": "c9", "state": {"status": "completed", "input": {"command": "ls -la"}, "output": "ok"}},
              {"type": "step-finish", "reason": "stop", "tokens": {"input": 1000, "output": 200}}]),
            ("m3", 3, ms(16), {"role": "user"}, [{"type": "text", "text": "second question"}]),
            ("m4", 4, ms(5), {"role": "assistant", "modelId": "deepseek-chat"}, [{"type": "reasoning", "text": "thinking"}]),
            ("m5", 5, ms(1), {"role": "user"}, [{"type": "compaction", "auto": True, "trigger": "auto",
                                                  "compactBoundary": {"preCompactTokenCount": 900000, "truePostCompactTokenCount": 50000,
                                                                      "postCompactTokenCount": 880000, "summarizedMessageCount": 40,
                                                                      "keptMessageCount": 1, "willRetriggerNextTurn": True,
                                                                      "compactReason": "context_limit"}}]),
        ]
        for mid, seq, ts, data, parts in msgs:
            self.con.execute("INSERT INTO message VALUES (?,?,?,?,?)", (mid, "sess_a", ts, json.dumps(data), seq))
            for i, pd in enumerate(parts):
                self.con.execute("INSERT INTO part VALUES (?,?,?,?,?,?)", ("p_%s_%d" % (mid, i), mid, "sess_a", ts, json.dumps(pd), i))
        self.con.commit()

    def tearDown(self):
        self.con.close()
        self.tmp.cleanup()

    def test_split_buckets_and_measured_splits(self):
        res = zusage.session_stats_json(self.con, "sess_a")
        sp = res["split"]
        self.assertEqual(sorted(sp), ["all", "aux", "main"], "子代理请求在子会话里，主会话自身只有 main/aux")
        self.assertEqual((sp["main"]["requests"], sp["aux"]["requests"], sp["all"]["requests"]), (4, 1, 5))
        # main：out=200+0+100+0=300；窗口=1500+300+700+50=2550ms → 117.6 t/s
        self.assertEqual(sp["main"]["tps"], 117.6)
        self.assertEqual(sp["main"]["toolCalls"], 1)
        self.assertEqual(sp["main"]["cacheHitRate"], 65.79)   # cr 600+400 / inp 1000+500+20（取消行也有输入）
        self.assertEqual(sum(x["tokens"] for x in res["tokenSplit"]), res["kpi"]["billedTokens"])
        self.assertEqual(res["tokenSplit"], [   # 1570 输入 = 缓存读 1000 + 缓存写 100 + 未命中 470；输出 310 = 思考 50 + 回复 260
            {"id": "cacheRead", "tokens": 1000}, {"id": "cacheWrite", "tokens": 100}, {"id": "bareInput", "tokens": 470},
            {"id": "reasoning", "tokens": 50}, {"id": "answers", "tokens": 260}])
        tm = res["timing"]
        self.assertEqual((tm["ttftMs"] + tm["genMs"]), tm["modelDurationMs"], "耗时三段是实测且恰好配平")
        self.assertEqual(tm["toolRunsMs"], 3170)
        self.assertNotIn("breakdown", tm, "按比例推算的 思考/回复 毫秒已移除")

        ins = zusage.insights_json(self.con, days=7)
        isp = ins["split"]
        self.assertEqual((isp["main"]["requests"], isp["sub"]["requests"], isp["aux"]["requests"], isp["all"]["requests"]), (4, 1, 1, 6))
        self.assertEqual((isp["main"]["sessions"], isp["sub"]["sessions"]), (1, 1))
        self.assertEqual(isp["sub"]["tokens"], 2400)
        self.assertEqual(isp["main"]["tokens"] + isp["sub"]["tokens"] + isp["aux"]["tokens"], isp["all"]["tokens"])
        self.assertEqual(sum(x["tokens"] for x in ins["tokenSplit"]), ins["kpi"]["billedTokens"])
        # 日桶按夹具时刻的本地日期取：00:00–02:00 之间跑时「两小时前」属于昨天，daily[-1]（今天）恒为空
        day_date = datetime.fromtimestamp(self.now / 1000.0).strftime("%Y-%m-%d")
        day = next(x for x in ins["daily"] if x["date"] == day_date)
        self.assertEqual((day["mainTokens"], day["subTokens"], day["tokens"]), (1820, 2400, 4280), "主=1200+600+20，子=2400，合计含辅助 60")
        self.assertLessEqual(day["mainCostUsd"] + day["subCostUsd"], day["costUsd"] + 1e-12, "主+子的费用不超过当日合计（差额是辅助请求）")
        self.assertAlmostEqual(isp["main"]["costUsd"] + isp["sub"]["costUsd"] + isp["aux"]["costUsd"], isp["all"]["costUsd"], places=9)
        self.assertEqual((isp["main"]["tokens"], isp["aux"]["tokens"]), (1820, 60))
        self.assertEqual(day["errors"], 2)
        self.assertEqual(day["rateLimited"], 1)
        glm = next(m for m in ins["topModels"] if m["modelId"] == "glm-flash")
        self.assertEqual((glm["requests"], glm["bySource"]["sub"]["requests"]), (1, 1))
        self.assertNotIn("main", glm["bySource"])

    def test_errors_retries_and_tool_quality(self):
        res = zusage.session_stats_json(self.con, "sess_a")
        e = res["errors"]
        self.assertEqual((e["requests"], e["failedAttempts"], e["failed"], e["cancelled"], e["retries"]), (5, 2, 1, 1, 1))
        self.assertEqual(e["byType"], {"cancelled": 1, "rate_limited": 1})
        q = res["toolQuality"]
        self.assertEqual((q["total"], q["errorStatus"], q["nonZeroExit"], q["truncated"]), (3, 1, 1, 1))
        self.assertEqual((q["readOnly"], q["destructive"]), (1, 0))
        self.assertEqual((q["p50Ms"], q["p95Ms"], q["avgMs"]), (120, 3000, 1057))
        ins = zusage.insights_json(self.con, days=7)
        self.assertEqual(ins["errors"]["byType"], {"cancelled": 1, "rate_limited": 1})
        self.assertEqual(ins["toolQuality"]["total"], 3)

    def test_real_compaction_part(self):
        res = zusage.session_stats_json(self.con, "sess_a")
        c = res["compactions"][0]
        self.assertEqual((c["preTokens"], c["postTokens"], c["summarized"], c["kept"], c["willRetrigger"], c["auto"]), (900000, 50000, 40, 1, True, True))
        self.assertEqual((c["trigger"], c["reason"]), ("auto", "context_limit"))
        self.assertEqual(res["kpi"]["contextEvents"]["compact"], 1, "压缩次数来自真实 compaction part")
        ins = zusage.insights_json(self.con, days=7)
        h = ins["compactionHealth"]
        self.assertEqual((h["count"], h["willRetrigger"], h["latest"]["postTokens"]), (1, 1, 50000))
        self.assertEqual(h["avgReductionPct"], 94.4)

    def test_turn_rows_and_turn_scoped_browser(self):
        turns = zusage.session_stats_json(self.con, "sess_a")["turns"]
        self.assertEqual([(t["n"], t["turnId"], t["requests"], t["retries"], t["toolCalls"]) for t in turns],
                         [(1, "t1", 2, 0, 1), (2, "t2", 2, 1, 1)])
        # 逐轮窗口：该轮用户消息（按 user_message_id 定位）到下一轮用户消息之前，时间正序
        tb = zusage.session_browser_json(self.con, "sess_a", 50, 0, turn_id="t1")
        self.assertTrue(tb["ok"])
        self.assertEqual((tb["order"], tb["turnId"], tb["totalMessages"]), ("asc", "t1", 2))
        self.assertEqual([m["id"] for m in tb["messages"]], ["m1", "m2"])
        last = zusage.session_browser_json(self.con, "sess_a", 50, 0, turn_id="t2")
        self.assertEqual([m["id"] for m in last["messages"]], ["m3", "m4", "m5"], "最后一轮无上界")
        self.assertEqual(zusage.session_browser_json(self.con, "sess_a", 50, 0, turn_id="nope"), {"ok": False, "error": "turn_not_found"})

    def test_browser_cursor_paging_and_part_tags(self):
        first = zusage.session_browser_json(self.con, "sess_a", 2, 0)
        self.assertEqual((first["order"], first["totalMessages"], first["hasMore"]), ("desc", 5, True))
        self.assertEqual([m["sequence"] for m in first["messages"]], [5, 4], "最新在前")
        self.assertEqual(first["cursor"], {"s": 4, "t": first["messages"][1]["time"], "id": "m4"})
        second = zusage.session_browser_json(self.con, "sess_a", 2, 0, before=first["cursor"])
        self.assertEqual([m["id"] for m in second["messages"]], ["m3", "m2"])
        self.assertEqual((second["totalMessages"], second["hasMore"]), (3, True))
        third = zusage.session_browser_json(self.con, "sess_a", 2, 0, before=second["cursor"])
        self.assertEqual(([m["id"] for m in third["messages"]], third["hasMore"]), (["m1"], False))
        self.assertEqual(zusage.session_browser_json(self.con, "sess_a", 2, 0, before={"s": "x"}), {"ok": False, "error": "invalid_before"})
        # 分区各行互不重叠、并集=全部
        seen = [m["id"] for p in (first, second, third) for m in p["messages"]]
        self.assertEqual(sorted(seen), ["m1", "m2", "m3", "m4", "m5"])
        # 消息级真实 token + part 分类标记 + 压缩事件
        self.assertEqual((first["messages"][1]["inputTokens"], first["messages"][1]["cacheReadTokens"], first["messages"][1]["outputTokens"]), (500, 400, 100))
        self.assertEqual(first["messages"][0]["inputTokens"], 0, "用户消息没有用量行")
        m2 = second["messages"][1]
        self.assertEqual(m2["inputTokens"], 1000)
        self.assertEqual([p["type"] for p in m2["parts"]], ["tool", "step-finish"])
        self.assertEqual((m2["parts"][0]["cat"], m2["parts"][1]["tokens"]["input"]), ("command", 1000))
        self.assertEqual([ev["kind"] for ev in zusage.session_browser_json(self.con, "sess_a", 5, 0)["events"]], ["context_compaction"])

    def test_capture_join_by_trace(self):
        cap = Path(self.tmp.name) / "cap"
        (cap / "blobs").mkdir(parents=True)
        orig = zusage._capture_dir
        zusage._capture_dir = lambda: cap
        try:
            rec = {"ts": 1, "trace": "trace-A", "querySource": "main_turn", "sessionType": "main", "model": "deepseek-chat",
                   "systemHash": "a" * 64, "toolsHash": "", "systemChars": 400, "toolsChars": 800, "messages": 3, "messageChars": 90}
            lines = [dict(rec, sessionType="main"), dict(rec, sessionType="subagent"), dict(rec, trace="trace-B", systemChars=8000)]
            (cap / "requests.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
            (cap / "blobs" / ("a" * 64 + ".json")).write_text(json.dumps("SYSTEM PROMPT"), encoding="utf-8")

            main = zusage.session_stats_json(self.con, "sess_a")
            self.assertEqual((main["capture"]["requests"], main["capture"]["systemTokens"], main["capture"]["toolsTokens"], main["capture"]["traced"]), (1, 100, 200, True))
            self.assertEqual(main["tokenBreakdownBasis"], "capture")
            self.assertEqual((main["tokenBreakdown"][0]["tokens"], main["tokenBreakdown"][1]["tokens"]), (100, 200))
            sub = zusage.session_stats_json(self.con, "sess_sub")
            self.assertEqual(sub["capture"]["requests"], 1, "子会话只认 session-type=subagent 的记录")
            resolved = zusage._read_req_capture("sess_a", self.con)
            self.assertEqual(resolved[0]["system"], "SYSTEM PROMPT", "blob 按哈希解析成原文")
            # 按 trace 归并读不到时（无库连接）不抛、只读会话专属文件
            self.assertEqual(zusage._read_req_capture("sess_a", None), [])
            (cap / "sess_a.jsonl").write_text(json.dumps(dict(rec, sessionType="")) + "\n", encoding="utf-8")
            self.assertEqual(len(zusage._read_req_capture("sess_a", None)), 1)
            base = zusage._capture_baseline()
            self.assertEqual((base["requests"], base["systemTokens"], base["toolsTokens"]), (3, 733, 200), "全部记录的字符数均值 ÷4")
            ins = zusage.insights_json(self.con, days=7)
            self.assertEqual(ins["tokenBreakdownBasis"], "capture")
            self.assertEqual((ins["tokenBreakdown"][0]["tokens"], ins["tokenBreakdown"][1]["tokens"]), (733 * 6, 200 * 6), "均摊到每次请求")
            # 只有主会话记录的子会话：trace 归并不到 → 无抓包，回到比例估算
            (cap / "requests.jsonl").unlink()
            (cap / "requests.jsonl").write_text(json.dumps(dict(rec, sessionType="main")) + "\n", encoding="utf-8")
            self.assertEqual(zusage.session_stats_json(self.con, "sess_sub")["tokenBreakdownBasis"], "ratio")
            (cap / "requests.jsonl").unlink()
            self.assertIsNone(zusage._capture_baseline(), "没有抓包文件 → None")
            self.assertEqual(zusage.session_stats_json(self.con, "sess_a")["capture"]["requests"], 1, "会话专属文件仍在：只读它")
        finally:
            zusage._capture_dir = orig

    def test_user_text_counts_toward_user_messages(self):
        """审查第 1 轮 MAJOR：用户消息正文此前从未计入 user 桶（「用户消息」恒 0，且被算进「模型回复」）。"""
        br = zusage.session_browser_json(self.con, "sess_a", 50, 0)
        user_chars = sum(len(pt["text"]) for m in br["messages"] if m["role"] == "user" for pt in m["parts"] if pt["type"] == "text")
        self.assertEqual(user_chars, len("first question") + len("second question"))
        st = zusage.session_stats_json(self.con, "sess_a")
        cats = {x["id"]: x["tokens"] for x in st["tokenBreakdown"]}
        self.assertEqual(cats["userMessages"], round(user_chars / 4))
        self.assertEqual(cats["answers"], st["kpi"]["outputTokens"] - st["kpi"]["reasoningTokens"], "回复仍是实测值")

    def test_steps_output_is_capped_but_numbering_and_total_are_kept(self):
        """审查第 1 轮 MINOR：steps 无上限会撑破扩展侧 16MB maxBuffer。"""
        now = int(time.time() * 1000)
        self.con.execute("INSERT INTO session VALUES ('sess_long',NULL,'Long','/tmp/proj',?,?,0,0,0)", (now - 5000, now))
        for i in range(1005):   # 倒序插入，证明输出按时间升序截「最后 1000 条」
            self.con.execute(
                "INSERT INTO model_usage (id, session_id, turn_id, query_source, provider_id, model_id, status, started_at, completed_at, "
                "duration_ms, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                ("l%d" % i, "sess_long", "t%d" % (i % 3), "main_turn", "p", "m", "completed", now - 100000 + i, now - 100000 + i, 100, 10, 1),
            )
        self.con.commit()
        st = zusage.session_stats_json(self.con, "sess_long")
        self.assertEqual(st["kpi"]["steps"], 1005, "总数不变")
        self.assertEqual(len(st["steps"]), 1000)
        self.assertEqual((st["steps"][0]["step"], st["steps"][-1]["step"]), (6, 1005), "保留最后 1000 条，序号不重编")
        self.assertEqual(zusage.session_stats_json(self.con, "sess_a")["kpi"]["steps"], len(zusage.session_stats_json(self.con, "sess_a")["steps"]), "短会话不截")

    def test_empty_exit_code_is_not_an_error_and_split_all_counts_sessions(self):
        """审查第 1 轮 MINOR：exit_code=''（TEXT）与 0 比较恒真被误计错误；split.all.sessions 恒 0。"""
        now = int(time.time() * 1000)
        self.con.execute("INSERT INTO session VALUES ('sess_x',NULL,'X','/tmp/proj',?,?,0,0,0)", (now - 5000, now))
        self.con.execute("INSERT INTO tool_usage VALUES ('tx1','sess_x','Grep','completed','',300,?,?,1,0,0)", (now - 4000, now - 3700))
        self.con.commit()
        tools = zusage.session_stats_json(self.con, "sess_x")["tools"]
        self.assertEqual([(t["name"], t["count"], t["errors"]) for t in tools], [("Grep", 1, 0)])
        grep = next(t for t in zusage.insights_json(self.con, days=7)["topTools"] if t["name"] == "Grep")
        self.assertEqual(grep["errors"], 0)
        sp = zusage.insights_json(self.con, days=7)["split"]   # 会话数按有模型请求的会话算（sess_x 只有工具行，不计）
        self.assertEqual({k: sp[k]["sessions"] for k in sp}, {"main": 1, "sub": 1, "aux": 1, "all": 2}, "all 桶也记会话数（aux=发过 session_title 请求的 sess_a）")
        # _tool_quality 自己那条 nullif：exit_code='' 不能被算作非零退出
        self.con.execute("INSERT INTO session VALUES ('sess_q',NULL,'Q','/tmp/proj',?,?,0,0,0)", (now - 5000, now))
        self.con.execute("INSERT INTO tool_usage VALUES ('tq1','sess_q','Bash','completed','',400,?,?,1,0,0)", (now - 4000, now - 3600))
        self.con.commit()
        self.assertEqual(zusage.session_stats_json(self.con, "sess_q")["toolQuality"],
                         {"total": 1, "errorStatus": 0, "nonZeroExit": 0, "truncated": 0, "readOnly": 1, "destructive": 0,
                          "p50Ms": 400, "p95Ms": 400, "avgMs": 400})
        iq = zusage.insights_json(self.con, days=7)["toolQuality"]   # sess_a 3 条 + 本用例的 Grep、Bash 各 1 条
        self.assertEqual((iq["total"], iq["nonZeroExit"]), (5, 1), "两条 exit_code='' 的行都不算非零退出；只有 sess_a 的 tu3 算")
        self.assertEqual(zusage._opt_int(float("inf"), 80, 1, 300), 80)
        self.assertEqual(zusage._opt_int(float("nan"), 80, 1, 300), 80)

    def test_turn_rows_keep_last_200_with_absolute_numbering(self):
        """审查第 1 轮 R3：200 条上限与截断后的序号都没有测试。"""
        now = int(time.time() * 1000)
        self.con.execute("INSERT INTO session VALUES ('sess_turns',NULL,'T','/tmp/proj',?,?,0,0,0)", (now - 5000, now))
        for i in range(1, 206):
            self.con.execute("INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at, model_request_count) VALUES (?,?,?,?,?,?)",
                             ("sess_turns", "tt%d" % i, "completed", now - 300000 + i * 100, now - 300000 + i * 100 + 50, 1))
        self.con.commit()
        turns = zusage.session_stats_json(self.con, "sess_turns")["turns"]
        self.assertEqual((len(turns), turns[0]["n"], turns[0]["turnId"], turns[-1]["n"], turns[-1]["turnId"]), (200, 6, "tt6", 205, "tt205"))
        self.assertEqual([t["n"] for t in turns], list(range(6, 206)), "序号是会话里的绝对轮序，不重编")

    def test_browser_limit_is_clamped_in_the_query_function_itself(self):
        """审查第 1 轮 R3：函数级钳值此前被 CLI 与扩展侧的外层钳值遮蔽。"""
        res = zusage.session_browser_json(self.con, "sess_a", 5000, 0)
        self.assertEqual((res["limit"], len(res["messages"])), (300, 5))
        one = zusage.session_browser_json(self.con, "sess_a", 1, 0)
        self.assertEqual((one["limit"], len(one["messages"])), (1, 1))

    def test_compaction_post_tokens_fallback(self):
        """审查第 1 轮 R3：truePostCompactTokenCount 缺席时回退 postCompactTokenCount，再缺席为 0。"""
        now = int(time.time() * 1000)
        self.con.execute("INSERT INTO session VALUES ('sess_c',NULL,'C','/tmp/proj',?,?,0,0,0)", (now - 5000, now))
        for i, boundary in enumerate(({"postCompactTokenCount": 77000}, {}, None)):
            data = {"type": "compaction", "auto": True}
            if boundary is not None:
                data["compactBoundary"] = boundary
            self.con.execute("INSERT INTO message VALUES (?,?,?,?,?)", ("cm%d" % i, "sess_c", now - 4000 + i, json.dumps({"role": "user"}), i + 1))
            self.con.execute("INSERT INTO part VALUES (?,?,?,?,?,?)", ("cp%d" % i, "cm%d" % i, "sess_c", now - 4000 + i, json.dumps(data), 0))
        self.con.commit()
        cps = zusage.session_stats_json(self.con, "sess_c")["compactions"]
        self.assertEqual([c["postTokens"] for c in cps], [77000, 0, 0])

    def test_command_program_first_word_forms(self):
        cp = zusage._command_program
        cases = [
            ('"C:\\Program Files\\Git\\cmd\\git.exe" status --short', "git.exe"),   # 引号包裹的 Windows 绝对路径
            ("C:\\Windows\\System32\\cmd.exe /c dir", "cmd.exe"),
            ("/usr/bin/git log", "git"), ("git  status", "git"), ("  'git' log", "git"),     # 单引号、前导空白
            ('& "C:\\Tools\\x y\\a.exe" -Flag', "a.exe"),                              # PowerShell 调用符
            ("", ""), ("   ", ""), ('"', ""), ("''", ""), ("&", ""),                       # 没有首词
            ("C:\\x\\", ""),                                                            # 尾分隔符之后是空串：调用方按空跳过
        ]
        for cmd, want in cases:
            with self.subTest(cmd=cmd):
                self.assertEqual(cp(cmd), want)
        # 引号没闭合：退化成引号后第一个空白前的词（不抛异常）
        self.assertIsInstance(cp('"C:\\Program Files\\Git status'), str)

    def test_command_program_name_survives_windows_paths_and_quotes(self):
        # 审查 R3：程序名只按 / 切时，Windows 的绝对路径命令得到整条反斜杠路径，带引号带空格的被截成
        # "C:\Program——同一个程序按调用写法被拆成多项
        def programs():
            return {p["name"]: p["count"] for p in zusage.insights_json(self.con, days=7)["topPrograms"]}
        before = programs()
        commands = ['"C:\\Program Files\\Git\\cmd\\git.exe" status --short', "C:\\Windows\\System32\\cmd.exe /c dir",
                    "/usr/bin/git log", "git push"]
        for i, command in enumerate(commands):
            data = json.dumps({"type": "tool", "tool": "Bash", "callID": "cc%d" % i,
                               "state": {"status": "completed", "input": {"command": command}, "output": ""}})
            self.con.execute("INSERT INTO message VALUES (?,?,?,?,?)",
                             ("m_cmd_%d" % i, "sess_cmd", self.now - 1000 + i, json.dumps({"role": "assistant"}), i + 1))
            self.con.execute("INSERT INTO part VALUES (?,?,?,?,?,?)",
                             ("p_cmd_%d" % i, "m_cmd_%d" % i, "sess_cmd", self.now - 1000 + i, data, 0))
        self.con.commit()
        after = programs()
        delta = {name: after.get(name, 0) - before.get(name, 0) for name in set(before) | set(after)}
        self.assertEqual({name: count for name, count in delta.items() if count}, {"git.exe": 1, "cmd.exe": 1, "git": 2})
        self.assertFalse(any(name.startswith('"C:') for name in after), "带引号的 Windows 路径不能被截成半截")

    def test_cli_session_browser_json_options(self):
        """扩展进程 ↔ zusage.py 的胶水：选项以单个 JSON 位置参数走真实 CLI（临时库，不碰个人数据）。"""
        import shutil
        import subprocess
        import sys
        fd, dbpath = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        fake_home = tempfile.mkdtemp(prefix="zusage-cli-home-")
        try:
            # 非 ASCII 文本经真 CLI 走一遭：宿主只给工具 shell 与 hooks 注入 PYTHONUTF8，扩展进程拉起的
            # Python 拿不到——子进程环境里也不带它，输出按 UTF-8 严格解码，钉子被改坏时才看得见
            stamp = self.now - 900
            self.con.execute("INSERT INTO session VALUES ('sess_utf8',NULL,'会话😀','/tmp/proj',?,?,0,0,0)", (stamp, stamp + 100))
            self.con.execute("INSERT INTO message VALUES (?,?,?,?,?)", ("m_utf8", "sess_utf8", stamp, json.dumps({"role": "user"}), 1))
            self.con.execute("INSERT INTO part VALUES (?,?,?,?,?,?)",
                             ("p_utf8", "m_utf8", "sess_utf8", stamp, json.dumps({"type": "text", "text": "中文输出😀 无乱码"}), 0))
            self.con.commit()
            dst = sqlite3.connect(dbpath)
            self.con.backup(dst)
            dst.close()
            env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP") if key in os.environ}
            env.update(ZCODE_SESSION_DB_PATH=dbpath, HOME=fake_home, USERPROFILE=fake_home)

            def run(session, *args):
                out = subprocess.run([sys.executable, "-B", str(Path(zusage.__file__).resolve()), "session-browser", session, *args],
                                     capture_output=True, encoding="utf-8", env=env, stdin=subprocess.DEVNULL, timeout=60)
                self.assertEqual(out.returncode, 0, out.stderr or out.stdout)
                return json.loads(out.stdout)

            page = run("sess_a", json.dumps({"limit": 2, "offset": 0}))
            self.assertEqual(([m["id"] for m in page["messages"]], page["hasMore"], page["cursor"]["id"]), (["m5", "m4"], True, "m4"))
            older = run("sess_a", json.dumps({"limit": 9999, "before": page["cursor"]}))
            self.assertEqual(([m["id"] for m in older["messages"]], older["hasMore"], older["limit"]), (["m3", "m2", "m1"], False, 300), "limit 钳到 300")
            turn = run("sess_a", json.dumps({"turnId": "t1"}))
            self.assertEqual((turn["order"], [m["id"] for m in turn["messages"]]), ("asc", ["m1", "m2"]))
            self.assertEqual([m["id"] for m in run("sess_a", "3", "0")["messages"]], ["m5", "m4", "m3"], "旧的位置参数形态仍可用")
            self.assertEqual(len(run("sess_a", "{bad json")["messages"]), 5, "坏 JSON 当默认选项")
            self.assertEqual(len(run("sess_a", json.dumps({"limit": "abc"}))["messages"]), 5, "非数字 limit 当默认值")
            self.assertEqual(len(run("sess_a", '{"limit": 1e999}')["messages"]), 5, "limit=1e999（解析成 inf）当默认值，不带栈崩溃")
            self.assertIn("中文输出😀 无乱码", json.dumps(run("sess_utf8"), ensure_ascii=False), "中文与 emoji 经管道往返不走样")
        finally:
            os.unlink(dbpath)
            shutil.rmtree(fake_home, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
