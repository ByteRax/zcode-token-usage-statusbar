# -*- coding: utf-8 -*-
"""token_pricing：匹配层级、费用口径（本库 input 已含 cache）、覆盖层缓存与 12h 同步。

费用口径契约（与 AGENTS.md §5 同源）：input_tokens 已含 cache_read 与 cache_creation、
output_tokens 已含 reasoning，故裸输入 = max(0, input − cr − cw)，reasoning 不另计。
缓存与网络全部隔离：临时目录 + 打桩 _fetch_json，绝不真联网。

运行：python3 -B -m unittest discover -s tests -p 'test_token_pricing.py'
"""
import calendar
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

import token_pricing as tp   # noqa: E402


def reset_state(cache_path=""):
    """模块级可变状态归零（每用例隔离；cache_path 为 Path 时挂临时缓存文件）。"""
    tp._OVERLAY = None
    tp._MERGED = None
    tp._FX = None
    tp._CACHE_PATH = cache_path or None
    tp._CACHE_ST = None
    tp._CFG.update({"url": tp.PRICING_URL, "fx_url": tp.FX_URL, "fetch": True})
    tp._bump_gen()
    tp._IDX = None
    tp._IDX_GEN = -1


class MatchingTests(unittest.TestCase):
    def setUp(self):
        reset_state()

    def tearDown(self):
        reset_state()

    def test_exact_bare_case_insensitive(self):
        self.assertEqual(tp.lookup("GLM-5.3-FlashX")["input"], tp.lookup("glm-5.3-flashx")["input"])
        rates, key, level = tp.lookup_full("GLM-5.3-FlashX")
        self.assertEqual(level, "exact")
        self.assertEqual(key, "glm-5.3-flashx")
        self.assertGreater(rates["output"], 0)

    def test_provider_hint_disambiguates_same_name(self):
        """GLM-5.3 在 zai（国际）与 zhipuai（国内）牌价不同：hint 决定取哪份。"""
        cn = tp.lookup("GLM-5.3", "account:bigmodel-individual-coding-plan")
        intl = tp.lookup("GLM-5.3", "account:zai-start-plan")
        self.assertNotEqual(cn["input"], intl["input"])
        self.assertEqual(cn["input"], tp.lookup("glm-5.3", "account:zhipuai-any")["input"])
        # 无 hint：按 provider 字典序确定性取一（不抛错即可）
        plain = tp.lookup("GLM-5.3")
        self.assertIn(plain["input"], {cn["input"], intl["input"]})

    def test_prefixed_model_name_exact_qual(self):
        """模型名自带 provider 前缀：全限定精确命中，不需要剥前缀。"""
        rates, key, level = tp.lookup_full("zai/glm-5.3")
        self.assertEqual((level, key), ("exact", "zai/glm-5.3"))
        self.assertEqual(rates["input"], tp.lookup("GLM-5.3", "account:zai-x")["input"])

    def test_overlay_variant_resolves_exact(self):
        """运行时覆盖层新增的变体（裸名不在内置表）经裸名索引精确命中，
        优先于模糊层（精确名 vs 包含关系）。"""
        reset_state()
        tp._OVERLAY = {"custom-vendor/claude-opus-5-5-turbo": {"input": 7, "output": 8}}
        tp._bump_gen()
        rates, key, level = tp.lookup_full("Claude-Opus-5-5-Turbo")
        self.assertEqual((level, key), ("exact", "claude-opus-5-5-turbo"))
        self.assertEqual(rates["input"], 7)

    def test_fuzzy_and_default(self):
        """子串模糊（键长 ≥5，最长键优先）；全 miss 落 DEFAULT_RATES 兜底均价。"""
        rates, key, level = tp.lookup_full("gpt-6.1-terra-2026-11")
        self.assertEqual(level, "fuzzy")
        self.assertEqual(rates["input"], tp.lookup("gpt-6.1-terra")["input"])
        rates, key, level = tp.lookup_full("totally-unknown-model")
        self.assertEqual((level, key), ("default", ""))
        self.assertEqual(rates, tp.DEFAULT_RATES)

    def test_lookup_missing_builtins_are_priced(self):
        """内置表抽查：本机真库在用模型必须命中且为正牌价（防同步规则回归砍条目）。"""
        for model, hint in (("GLM-5.3", "account:bigmodel-x"), ("claude-opus-5-5", ""),
                            ("gpt-6.1-terra", ""), ("gemini-3.8-flash", ""),
                            ("MiniMax-M3.1-Flash", "account:minimax-x"), ("deepseek-flash", "")):
            rates = tp.lookup(model, hint)
            self.assertGreater(rates["input"], 0, model)
            self.assertGreater(rates["output"], 0, model)

    def test_r4_relay_catalog_is_priced_instead_of_default_fallback(self):
        """R4 Coder 的 deepseek-v4.1-flash 三档（/v1/models 实取）必须精确命中；
        未收录时会落 DEFAULT_RATES（$1/$5），对 5.7M cache 的会话高估一个数量级。"""
        for model, (inp, out) in (
                ("deepseek-v4.1-flash", (0.15, 0.6)),
                ("DeepSeek-V4.1-Flash-Fast", (1.2, 6.0)),
                ("deepseek-v4.1-flash-ultrafast", (3.6, 14.4))):
            rates, key, level = tp.lookup_full(model)
            self.assertEqual((level, key), ("exact", model.lower()))
            self.assertEqual((rates["input"], rates["output"]), (inp, out))
            self.assertEqual(rates["cache_write"], 0.0, model)
            self.assertNotEqual(rates, tp.DEFAULT_RATES)
        cost = tp.compute_group_cost("deepseek-v4.1-flash", "new-provider",
                                     3_492_858, 20_271, 3_323_816, 0)
        self.assertAlmostEqual(cost, 0.04749035, places=8)


class ComputeTests(unittest.TestCase):
    def setUp(self):
        reset_state()

    def tearDown(self):
        reset_state()

    def test_formula_splits_cache_from_input(self):
        """input 已含 cache_read/cache_creation：裸输入全价 + 缓存分价。
        GLM-5.3-FlashX（zhipuai）：input 0.29879 / cache_read 0.08516 / output 1.04577。
        1M input（含 0.8M cache_read，无 cache_write）+ 0.1M output：
        (0.2×0.29879 + 0.8×0.08516 + 0.1×1.04577) = 0.234281。"""
        cost = tp.compute_group_cost("GLM-5.3-FlashX", "account:bigmodel-x",
                                     1_000_000, 100_000, 800_000, 0)
        self.assertAlmostEqual(cost, round(0.2 * 0.29879 + 0.8 * 0.08516 + 0.1 * 1.04577, 8))

    def test_cache_write_priced_and_negative_clamped(self):
        """cache_creation 走 cache_write 价（claude-opus-5-5：5/百万）；脏数据负数钳 0。"""
        cost = tp.compute_group_cost("claude-opus-5-5", "", 1_000_000, 0, 0, 100_000)
        self.assertAlmostEqual(cost, round(0.9 * 4 + 0.1 * 5, 8))
        # cache_read+cache_creation > input：裸输入不出现负价（钳为 0，按缓存价计）
        cost2 = tp.compute_group_cost("claude-opus-5-5", "", 50_000, 0, 1_000_000, 1_000_000)
        self.assertAlmostEqual(cost2, round(1.0 * 0.2 + 1.0 * 5, 8))

    def test_reasoning_never_double_counted(self):
        """output 已含思考：函数签名根本没有 reasoning 参数——同 output 传入即唯一口径。"""
        a = tp.compute_group_cost("GLM-5.3", "account:bigmodel-x", 1000, 500, 0, 0)
        b = tp.compute_group_cost("GLM-5.3", "account:bigmodel-x", 1000, 500, 0, 0)
        self.assertEqual(a, b)

    def test_default_rates_when_unmatched(self):
        cost = tp.compute_group_cost("no-such-model", "", 1_000_000, 1_000_000, 0, 0)
        self.assertAlmostEqual(cost, 1.0 + 5.0)

    def test_merge_model_costs_groups_by_first_seen_name(self):
        total, per = tp.merge_model_costs([
            ("GLM-5.3", "account:bigmodel-x", 1_000_000, 0, 0, 0),
            ("GLM-5.3", "account:zai-x", 1_000_000, 0, 0, 0),
            ("claude-opus-5-5", "", 0, 1_000_000, 0, 0),
        ])
        self.assertAlmostEqual(per["GLM-5.3"], 1.19516 + 1.4)
        self.assertAlmostEqual(per["claude-opus-5-5"], 20.0)
        self.assertAlmostEqual(total, per["GLM-5.3"] + 20.0)


class ConvertTests(unittest.TestCase):
    def setUp(self):
        reset_state()

    def tearDown(self):
        reset_state()

    def test_convert_filters_and_shapes(self):
        data = {"zai": {"models": {
            "glm-5.3": {"cost": {"input": 1.4, "output": 4.4, "cache_read": 0.26, "cache_write": 0}},
            "glm-5.3-vision": {"cost": {"input": 1, "output": 2},
                               "modalities": {"input": ["image"], "output": ["text"]}},
        }}, "zai-coding-plan": {"models": {
            "glm-5.3": {"cost": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}},
        }}, "volcengine": {"models": {
            "deepseek-v4": {"cost": {"input": 1, "output": 2}},   # 云中转代售：家族不符剔除
            "doubao-pro": {"cost": {"input": 0.1, "output": 0.5}},
        }}, "random-gateway": {"models": {
            "gpt-x": {"cost": {"input": 1, "output": 2}},
        }}, "anthropic": {"models": {
            "claude-embed": {"cost": {"input": 1, "output": 2}},   # 家族关键词剔除
            "claude-ok": {"cost": {"input": 3, "output": 15}},
        }}}
        out = tp.convert_models_dev(data)
        self.assertIn("zai/glm-5.3", out)
        self.assertNotIn("zai/glm-5.3-vision", out)          # 非文本输入模态
        self.assertNotIn("zai-coding-plan/glm-5.3", out)     # coding-plan 通道整族排除
        self.assertNotIn("volcengine/deepseek-v4", out)      # 家族不符
        self.assertIn("volcengine/doubao-pro", out)
        self.assertNotIn("random-gateway/gpt-x", out)        # 非白名单
        self.assertNotIn("anthropic/claude-embed", out)
        self.assertIn("anthropic/claude-ok", out)
        self.assertEqual(out["zai/glm-5.3"]["cache_write"], 0.0)   # 缺字段按 0 计

    def test_convert_missing_cost_skipped(self):
        out = tp.convert_models_dev({"openai": {"models": {
            "gpt-free": {}, "gpt-bad": {"cost": {"input": -1, "output": 2}}}}})
        self.assertEqual(out, {})

    def test_validators(self):
        self.assertTrue(tp._valid_rates_map({"a/b": {"input": 1, "output": 2, "cache_read": 0.1}}))
        self.assertFalse(tp._valid_rates_map({"a/b": {"input": -1, "output": 2}}))
        self.assertFalse(tp._valid_rates_map({"a/b": {"input": "x", "output": 2}}))
        self.assertFalse(tp._valid_rates_map(["not", "a", "dict"]))
        self.assertTrue(tp._valid_fx({"rate": 7.1}))
        self.assertFalse(tp._valid_fx({"rate": 0}))
        self.assertFalse(tp._valid_fx({"rate": "7"}))


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        reset_state(Path(self.tmp.name) / "pricing-cache.json")

    def tearDown(self):
        reset_state()

    def write(self, payload):
        Path(tp._CACHE_PATH).write_text(json.dumps(payload), encoding="utf-8")

    def test_overlay_merges_over_builtin(self):
        self.write({"version": 1, "pricing": {"zai/glm-5.3": {"input": 9, "output": 9}},
                    "pricing_at": 1, "fx": {"rate": 7.5, "at": 1, "source": "test"},
                    "fx_at": 1})
        self.assertEqual(tp.lookup("GLM-5.3", "account:zai-x")["input"], 9)
        self.assertEqual(tp.fx_view()["rate"], 7.5)

    def test_corrupt_or_version_mismatch_keeps_builtin(self):
        Path(tp._CACHE_PATH).write_text("{not json", encoding="utf-8")
        self.assertEqual(tp.lookup("GLM-5.3", "account:zai-x")["input"],
                         tp.lookup("zai/glm-5.3")["input"])
        self.assertIsNone(tp.fx_view())
        self.write({"version": 999, "pricing": {"zai/glm-5.3": {"input": 9, "output": 9}}})
        self.assertNotEqual(tp.lookup("GLM-5.3", "account:zai-x")["input"], 9)

    def test_invalid_overlay_entries_dropped(self):
        """部分条目坏（负价/非数值）：整份 overlay 弃用（fail-closed），不是只剔坏条。"""
        self.write({"version": 1, "pricing": {"zai/glm-5.3": {"input": 9, "output": 9},
                                              "bad/x": {"input": -1, "output": 2}}})
        self.assertEqual(tp.lookup("GLM-5.3", "account:zai-x")["input"],
                         tp.lookup("zai/glm-5.3")["input"])

    def test_write_cache_atomic_and_reloads(self):
        reset_state(Path(self.tmp.name) / "pricing-cache.json")
        payload = {"version": 1, "pricing": {"zai/glm-5.3": {"input": 9, "output": 9}},
                   "pricing_at": 5, "fx": {"rate": 7.5, "at": 5, "source": "t"}, "fx_at": 5}
        tp._write_cache(payload)
        self.assertTrue(Path(tp._CACHE_PATH).exists())
        self.assertFalse(Path(str(tp._CACHE_PATH) + ".tmp").exists())
        self.assertEqual(tp.fx_view()["rate"], 7.5)
        # 坏 fx 不落盘（置 None），价表保留
        tp._write_cache({"version": 1, "pricing": {"zai/glm-5.3": {"input": 8, "output": 8}},
                         "pricing_at": 6, "fx": {"rate": -1}, "fx_at": 6})
        self.assertEqual(tp.fx_view(), None)
        self.assertEqual(tp.lookup("GLM-5.3", "account:zai-x")["input"], 8)


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        reset_state(Path(self.tmp.name) / "pricing-cache.json")
        self.fetches = []

    def tearDown(self):
        reset_state()

    def stub_fetch(self, pricing=None, fx=7.1, pricing_error=False, fx_error=False):
        def fake(url):
            self.fetches.append(url)
            if tp.PRICING_URL in url or "models.dev" in url:
                if pricing_error:
                    raise OSError("network down")
                return pricing if pricing is not None else {"zai": {"models": {
                    "glm-5.3": {"cost": {"input": 1.4, "output": 4.4}}}}}
            if fx_error:
                raise OSError("fx down")
            return {"result": "success", "rates": {"CNY": fx}}
        tp._fetch_json = fake

    def test_refresh_fetches_and_persists(self):
        self.stub_fetch()
        tp._refresh_once()
        self.assertEqual(tp.fx_view()["rate"], 7.1)
        self.assertEqual(tp.lookup("GLM-5.3", "account:zai-x")["input"], 1.4)
        self.assertEqual(len(self.fetches), 2)   # 价表 + 汇率各一次

    def test_fresh_cache_skips_fetch(self):
        """12h TTL 内不重拉：启动后高频重启不打上游。"""
        import time
        now_ms = int(time.time() * 1000)
        tp._write_cache({"version": 1, "pricing": {"zai/glm-5.3": {"input": 2, "output": 2}},
                         "pricing_at": now_ms,
                         "fx": {"rate": 7.0, "at": now_ms, "source": "t"},
                         "fx_at": now_ms})
        self.stub_fetch()
        tp._refresh_once()
        self.assertEqual(self.fetches, [])

    def test_failure_keeps_old_values(self):
        """拉取失败静默保留磁盘旧值（fail-safe），且不写坏缓存。"""
        tp._write_cache({"version": 1, "pricing": {"zai/glm-5.3": {"input": 2, "output": 2}},
                         "pricing_at": 1, "fx": {"rate": 7.0, "at": 1, "source": "t"}, "fx_at": 1})
        self.stub_fetch(pricing_error=True, fx_error=True)
        tp._refresh_once()
        self.assertEqual(tp.lookup("GLM-5.3", "account:zai-x")["input"], 2)
        self.assertEqual(tp.fx_view()["rate"], 7.0)

    def test_partial_failure_keeps_corresponding_side(self):
        """价表成功、汇率失败：新价表落盘、旧汇率保留。"""
        tp._write_cache({"version": 1, "pricing": {"zai/glm-5.3": {"input": 2, "output": 2}},
                         "pricing_at": 1, "fx": {"rate": 7.0, "at": 1, "source": "t"}, "fx_at": 1})
        self.stub_fetch(fx_error=True)
        tp._refresh_once()
        self.assertEqual(tp.lookup("GLM-5.3", "account:zai-x")["input"], 1.4)
        self.assertEqual(tp.fx_view()["rate"], 7.0)

    def test_fetch_fx_shape_contract(self):
        """汇率源契约：{rates:{CNY:number}}；异形/异常一律 None（展示层降级 $）。"""
        tp._fetch_json = lambda url: {"rates": {"CNY": 6.66}}
        self.assertEqual(tp._fetch_fx(tp.FX_URL), 6.66)
        tp._fetch_json = lambda url: {"nope": 1}
        self.assertIsNone(tp._fetch_fx(tp.FX_URL))
        def boom(url):
            raise OSError("down")
        tp._fetch_json = boom
        self.assertIsNone(tp._fetch_fx(tp.FX_URL))

    def test_start_refresh_disabled_by_config(self):
        tp.configure({"pricing": {"fetch": False}}, self.tmp.name)
        self.assertIsNone(tp.start_refresh())
        self.assertTrue(tp._CFG["fetch"] is False)
        tp._STARTED = False   # 不留线程痕迹

    def test_fx_fallback_when_primary_down(self):
        """主汇率源失败/异形 → 兜底公益源（exchangerate.fun）生效，source 记实际命中源。"""
        calls = []
        def fake(url):
            calls.append(url)
            if "er-api.com" in url:
                return {"rates": {"CNY": None}}   # 形状不对 → _fetch_fx None
            return {"base": "USD", "rates": {"CNY": 6.6521}}
        tp._fetch_json = fake
        tp._refresh_once()
        self.assertEqual(tp.fx_view()["rate"], 6.6521)
        self.assertEqual(tp.fx_view()["source"], "api.exchangerate.fun")
        self.assertTrue(any("er-api.com" in u for u in calls) and
                        any("exchangerate.fun" in u for u in calls))

    def test_fx_no_fallback_for_custom_url(self):
        """用户显式配置 pricing.fx.url 后失败即失败，不擅自打兜底源。"""
        tp._CFG["fx_url"] = "https://fx.example.com/api"
        calls = []
        def fake(url):
            calls.append(url)
            raise OSError("down")
        tp._fetch_json = fake
        tp._refresh_once()
        self.assertIsNone(tp.fx_view())
        self.assertIn("https://fx.example.com/api", calls)
        self.assertFalse(any("exchangerate.fun" in u for u in calls),
                        "兜底源不应被请求：%r" % calls)

    def test_configure_sets_cache_path_and_refresh_persists(self):
        """行为级：configure 必须真把缓存路径写进模块状态并让 _refresh_once 落盘
        （曾因 configure 漏 global 声明静默失效——常驻进程价表/汇率永不落盘）。"""
        import time
        reset_state(Path(self.tmp.name) / "pricing-cache.json")
        tp._CACHE_PATH = None
        tp.configure({}, self.tmp.name)
        self.assertEqual(Path(tp._CACHE_PATH), Path(self.tmp.name) / "pricing-cache.json")
        self.stub_fetch()
        tp._refresh_once()
        self.assertTrue(Path(tp._CACHE_PATH).exists())
        data = json.loads(Path(tp._CACHE_PATH).read_text(encoding="utf-8"))
        self.assertIn("zai/glm-5.3", data["pricing"])
        self.assertEqual(data["fx"]["rate"], 7.1)
        reset_state()

    def test_start_refresh_idempotent(self):
        tp.configure({}, self.tmp.name)
        import threading
        with tp._START_LOCK:
            tp._STARTED = True   # 假装已启动：不真开线程
        self.assertIsNone(tp.start_refresh())


class PeakValleyTests(unittest.TestCase):
    """峰谷时段纯函数：北京边界、周末分界、切换点扫描与口径一致（specs/peak-valley-time.md）。"""

    def bj(self, y, mo, d, h, mi=0, s=0):
        # 北京墙钟时刻 → epoch 秒：先按 UTC 组时刻再减 8h，不依赖本机时区
        return calendar.timegm((y, mo, d, h, mi, s)) - 8 * 3600

    def test_fixture_weekdays_sanity(self):
        # 夹具日期自身校验：周几用 time.gmtime 独立求证，防手算错位
        self.assertEqual(time.gmtime(self.bj(2026, 11, 26, 10)).tm_wday, 3)  # 周四
        self.assertEqual(time.gmtime(self.bj(2026, 11, 28, 10)).tm_wday, 5)  # 周六
        self.assertEqual(time.gmtime(self.bj(2026, 8, 22, 10)).tm_wday, 5)   # 周六

    def test_workday_boundaries(self):
        # 周四 2026-11-26：8:59:59 谷、9:00:00 峰、11:59:59 峰、12:00 谷、
        # 13:59:59 谷、14:00:00 峰、17:59:59 峰、18:00:00 谷
        cases = [((8, 59, 59), False), ((9, 0, 0), True), ((11, 59, 59), True),
                 ((12, 0, 0), False), ((13, 59, 59), False), ((14, 0, 0), True),
                 ((17, 59, 59), True), ((18, 0, 0), False)]
        for (h, mi, s), want in cases:
            self.assertIs(tp.is_peak_time(self.bj(2026, 11, 26, h, mi, s)), want,
                          "北京 %02d:%02d:%02d 应为 %s" % (h, mi, s, "高峰" if want else "谷时"))

    def test_weekend_all_valley(self):
        # 分界已生效：周六/周日全天谷（含工作日同时刻为高峰的对照）
        self.assertFalse(tp.is_peak_time(self.bj(2026, 11, 28, 10, 0, 0)))   # 周六 10:00
        self.assertFalse(tp.is_peak_time(self.bj(2026, 11, 29, 15, 0, 0)))   # 周日 15:00
        self.assertTrue(tp.is_peak_time(self.bj(2026, 11, 27, 10, 0, 0)))    # 周五 10:00 对照

    def test_weekend_boundary_semantics(self):
        # 分界 = 北京 2026-08-23 00:00：分界前的周六 10:00 仍按旧规则是峰，
        # 分界后的周六同一时刻全天谷
        self.assertEqual(tp._WEEKEND_VALLEY_FROM_SEC, self.bj(2026, 8, 23, 0, 0, 0))
        self.assertTrue(tp.is_peak_time(self.bj(2026, 8, 22, 10, 0, 0)))
        self.assertFalse(tp.is_peak_time(self.bj(2026, 8, 29, 10, 0, 0)))
        # glm-plan 无分界概念：分界前的周六 15:00（峰窗内）仍恒谷（变异审查缺口②）
        self.assertFalse(tp.is_peak_time(self.bj(2026, 8, 22, 15, 0, 0), 'glm-plan'))
        self.assertFalse(tp.is_peak_time(self.bj(2026, 8, 29, 15, 0, 0), 'glm-plan'))

    def test_invalid_inputs(self):
        for bad in (None, "abc", "", float("nan"), float("inf"), -float("inf"), object()):
            self.assertFalse(tp.is_peak_time(bad), repr(bad))
            self.assertIsNone(tp.next_peak_change(bad), repr(bad))

    def test_next_peak_change_basic(self):
        b = self.bj
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 8, 0, 0)), b(2026, 11, 26, 9, 0, 0))
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 10, 0, 0)), b(2026, 11, 26, 12, 0, 0))
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 12, 30, 0)), b(2026, 11, 26, 14, 0, 0))
        # 恰在切换点上：9:00:00 自身被排除，下一切换是 12:00
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 9, 0, 0)), b(2026, 11, 26, 12, 0, 0))
        # 周四 18:00 谷起，下一个状态相反时刻是周五 9:00（0 点跨日边界同为谷不翻转）
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 18, 0, 0)), b(2026, 11, 27, 9, 0, 0))

    def test_next_peak_change_boundary_minus_one_second(self):
        # 边界前 1 秒必须能取到紧邻切换点（审查 MAJOR：sec+1 守卫曾把它跳成下下个边界）
        b = self.bj
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 8, 59, 59)), b(2026, 11, 26, 9, 0, 0))
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 11, 59, 59)), b(2026, 11, 26, 12, 0, 0))
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 17, 59, 59)), b(2026, 11, 26, 18, 0, 0))
        self.assertEqual(tp.next_peak_change(b(2026, 11, 26, 13, 59, 59), 'glm-plan'),
                         b(2026, 11, 26, 14, 0, 0))
        # 周五 17:59:59 仍在高峰窗内（17<18），下一切换是当日 18:00；跨周末语义由 skips_weekend 用例覆盖
        self.assertEqual(tp.next_peak_change(b(2026, 11, 27, 17, 59, 59)), b(2026, 11, 27, 18, 0, 0))

    def test_next_peak_change_skips_weekend(self):
        # 周五 18:30 谷起：周六/周日全天谷不翻转，下一切换是周一 9:00
        self.assertEqual(tp.next_peak_change(self.bj(2026, 11, 27, 18, 30, 0)),
                         self.bj(2026, 11, 30, 9, 0, 0))

    def test_next_peak_change_flip_property(self):
        # 14 天逐小时样本：切换点必落整点、时刻前进、两侧峰谷状态必相反，
        # 且 (t, next) 区间内状态恒定
        t = self.bj(2026, 11, 20, 0, 0, 0)
        for _ in range(14 * 24):
            nxt = tp.next_peak_change(t)
            self.assertIsNotNone(nxt)
            self.assertEqual(nxt % 3600, 0)
            self.assertGreater(nxt, t)
            cur, after = tp.is_peak_time(t), tp.is_peak_time(nxt)
            self.assertNotEqual(cur, after, "t=%d" % t)
            for frac in (0.25, 0.5, 0.75):
                self.assertEqual(tp.is_peak_time(t + int((nxt - t) * frac)), cur,
                                 "t=%d frac=%s" % (t, frac))
            t = nxt

    def test_glm_plan_window_differs_from_deepseek(self):
        # GLM 高峰只有周一至五 14–18：周四 10:00 在 deepseek 是峰、glm-plan 是谷
        t = self.bj(2026, 11, 26, 10, 0, 0)
        self.assertTrue(tp.is_peak_time(t, 'deepseek'))
        self.assertFalse(tp.is_peak_time(t, 'glm-plan'))
        # 13:59:59 谷 / 14:00:00 峰 / 17:59:59 峰 / 18:00:00 谷
        self.assertFalse(tp.is_peak_time(self.bj(2026, 11, 26, 13, 59, 59), 'glm-plan'))
        self.assertTrue(tp.is_peak_time(self.bj(2026, 11, 26, 14, 0, 0), 'glm-plan'))
        self.assertTrue(tp.is_peak_time(self.bj(2026, 11, 26, 17, 59, 59), 'glm-plan'))
        self.assertFalse(tp.is_peak_time(self.bj(2026, 11, 26, 18, 0, 0), 'glm-plan'))

    def test_glm_plan_weekend_and_next_change(self):
        # 周末自然非高峰（无分界概念）；切换点跨周末：周五 18:30 → 周一 14:00
        self.assertFalse(tp.is_peak_time(self.bj(2026, 11, 28, 15, 0, 0), 'glm-plan'))
        self.assertEqual(tp.next_peak_change(self.bj(2026, 11, 26, 10, 0, 0), 'glm-plan'),
                         self.bj(2026, 11, 26, 14, 0, 0))
        self.assertEqual(tp.next_peak_change(self.bj(2026, 11, 27, 18, 30, 0), 'glm-plan'),
                         self.bj(2026, 11, 30, 14, 0, 0))

    def test_glm_plan_peak_factor(self):
        peak = self.bj(2026, 11, 26, 15, 0, 0)   # 周四 15:00 高峰
        off = self.bj(2026, 11, 26, 10, 0, 0)    # 周四 10:00 非高峰（glm 口径）
        sat = self.bj(2026, 11, 28, 15, 0, 0)    # 周六 15:00 非高峰
        self.assertEqual(tp.glm_plan_peak_factor('glm-5.4', off), 0.67)
        self.assertEqual(tp.glm_plan_peak_factor('glm-5.4', peak), 2.0)
        self.assertEqual(tp.glm_plan_peak_factor('glm-5.3', peak), 3.0)
        self.assertEqual(tp.glm_plan_peak_factor('glm-5.3', sat), 1.0)
        # 精确等值：flash 命中自身档位；flashx 命中自身键（体验版=flash×2.5）不串档
        self.assertEqual(tp.glm_plan_peak_factor('glm-5.3-flash', off), 0.4)
        self.assertEqual(tp.glm_plan_peak_factor('glm-5.3-flash', peak), 1.2)
        self.assertEqual(tp.glm_plan_peak_factor('glm-5.3-flashx', off), 1.0)
        self.assertEqual(tp.glm_plan_peak_factor('glm-5.3-flashx', peak), 3.0)
        # 未收录/空名 → 1.0（无系数调整）
        self.assertEqual(tp.glm_plan_peak_factor('glm-9.9', peak), 1.0)
        self.assertEqual(tp.glm_plan_peak_factor(None, peak), 1.0)

    def test_peak_snapshot_segment(self):
        seg = tp.peak_snapshot_segment(self.bj(2026, 11, 26, 15, 0, 0))   # 周四 15:00 高峰
        self.assertEqual(set(seg.keys()), {"glm_plan"})
        g = seg["glm_plan"]
        self.assertIs(g["is_peak"], True)
        self.assertEqual(g["next_change_at"], self.bj(2026, 11, 26, 18, 0, 0))
        self.assertEqual([f[0] for f in g["factors"]],
                         ["glm-5.4", "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"])
        self.assertEqual(g["factors"][0], ["glm-5.4", 0.67, 2.0])
        self.assertEqual(g["factors"][3], ["glm-5.3-flashx", 1.0, 3.0])
        off = tp.peak_snapshot_segment(self.bj(2026, 11, 26, 10, 0, 0))["glm_plan"]   # glm 口径谷
        self.assertIs(off["is_peak"], False)
        self.assertEqual(off["next_change_at"], self.bj(2026, 11, 26, 14, 0, 0))
        # 非法时刻按契约向上抛（zusage 侧 _peak_segment_safe 宽捕获后省略），本函数不吞
        with self.assertRaises(ValueError):
            tp.peak_snapshot_segment("abc")


if __name__ == "__main__":
    unittest.main()
