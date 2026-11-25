# -*- coding: utf-8 -*-
"""速度格实机量宽探针的判定函数回归（specs/speed-chip-stable-slot.md）。

tests/speed-slot-live-probe.py 是实机工具，这里不连调试口，只用构造的结果锁定：
- 默认模式 report()：全部状态面同宽且等于固定宽 6.6em × 格字号（极窄档 2.75em；v459）、无越界，任何界面字号都核对；
- 持续观察 summarize()：同一条状态条、同一布局（签名前 7 段，不分面类别）下宽度不唯一或越界才是异常；没有可量样本、格面从未变化
  都返回退出码 3（不算通过）；停留时长与档位来回只报告；不同条、不同签名互不混淆。
页面侧采样器由 tests/overlay-pill-theme.test.cjs 的 watch-mode sampler 用例在真实 Chromium 数据链上校验。

运行：python3 -B -m unittest discover -s tests -p 'test_speed_slot_live_probe.py'
"""
import contextlib
import io
import socket
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from tests.helpers.py_test_support import load_module  # noqa: E402

probe = load_module("speed_slot_live_probe", REPO / "tests" / "speed-slot-live-probe.py")

# 页面侧布局签名（tests/speed-slot-live-watch.js）：档位类 | 最窄标记 | 格字号 | 条父宽 | 窗口内宽 | 界面字号 | 像素比 | 面类别
WIDE = "||14px|640|1200|14px|2"
MID = "zu-tight||14px|640|1200|14px|2"
NARROWER_WINDOW = "||14px|640|900|14px|2"
NARROWER_PARENT = "||14px|600|1200|14px|2"

THINK_A, THINK_B = "think|思考 0.5s", "think|思考 1.5s"
ESTIMATE, TOOL, FINAL = "bolt|生成 128.6 t/s", "tool|读取 01s", "bolt|250.0 t/s"


def tier_row(width, turn=300.0, overflow=()):
    return {"fs": "14px", "speedW": [width], "turnL": [turn], "minSlack": 5.0, "minLead": 5.0, "overflow": list(overflow)}


def default_mode(tiers, ui="14px"):
    return {"meta": {"uiFont": ui, "dpr": 2, "platform": "Win32", "lang": "zh-CN", "hidden": False}, "tiers": tiers}


def run_report(out):
    with contextlib.redirect_stdout(io.StringIO()):
        return probe.report(out)


def sample(t, face, w=176.4, s=0, b=0, **extra):
    row = {"t": t, "b": b, "s": s, "w": w, "l": 100.0, "f": face, "ov": 0}
    row.update(extra)
    return row


def watch(samples, sigs, every=100, **meta_extra):
    return probe.summarize({"meta": dict({"seconds": 6, "every": every, "uiFont": "14px", "dpr": 2, "width": 1200}, **meta_extra), "sigs": sigs, "samples": samples})


def chain(t0=0, s=0, b=0, w=176.4):
    """思考（计时文字换一次）→ 生成（只停一拍）→ 读取 → 完成，每 100ms 一拍，共 9 拍。"""
    faces = [THINK_A, THINK_A, THINK_B, THINK_B, ESTIMATE, TOOL, TOOL, FINAL, FINAL]
    return [sample(t0 + 100 * i, face, w=w, s=s, b=b) for i, face in enumerate(faces)]


class ReportTest(unittest.TestCase):
    def row(self, widths, fs="14px", overflow=()):
        return {"fs": fs, "speedW": list(widths), "plainW": [], "turnL": [300.0], "plainTurnL": [],
                "minSlack": 5.0, "minLead": 0, "overflow": list(overflow)}

    def test_every_face_at_the_fixed_slot_width_passes(self):
        # 行里的 fs 是格字号（随档位缩放）：紧凑/紧张/极窄格字号 12px；v459 全部格面固定宽 6.6em——14px 格字号 92.4、12px 79.2，极窄 2.75em
        rows = {"14px 默认 宽裕": self.row([92.4, 92.4]), "14px 默认 中等": self.row([79.2], fs="12px"),
                "14px 默认 紧张": self.row([79.2], fs="12px"), "14px 默认 极窄": self.row([33.0], fs="12px"),
                "14px 药丸 宽裕": self.row([92.4]), "14px 药丸 中等": self.row([79.2], fs="12px"), "14px 药丸 紧张": self.row([79.2], fs="12px")}
        problems, base, checked = run_report(default_mode(rows))
        self.assertEqual((problems, base, checked), ([], "14px", 7))

    def test_any_face_off_the_fixed_width_and_overflow_are_problems(self):
        row = self.row([70.0, 180.0], overflow=["估算 9999.9"])
        problems, base, checked = run_report(default_mode({"16px 默认 宽裕": row}, ui="16px"))
        self.assertEqual((base, checked), ("16px", 1))   # 固定宽是纯 em：任何界面字号都核对
        self.assertEqual(problems, ["16px 默认 宽裕：数值越界 估算 9999.9",
                                    "16px 默认 宽裕：宽度 70.0、180.0 应恒为 92.4px（6.6em×14px）——全部状态面必须同宽"])
        # 都在 v455/v456 的区间里、只是不同宽（92.4 / 94.9 / 105.2）：v459 起同样算异常——这正是用户实报的抖动
        problems, _, checked = run_report(default_mode({"14px 默认 宽裕": self.row([92.4, 94.9, 105.2])}))
        self.assertEqual((problems, checked), (
            ["14px 默认 宽裕：宽度 94.9、105.2 应恒为 92.4px（6.6em×14px）——全部状态面必须同宽"], 1))

    def test_long_timer_tail_clip_is_known_only_within_the_bound(self):
        # >1h 长计时（已知名单）在固定宽里放不下时数值尾被裁：裁到 12px 以内只提示不算异常；超限、或名单外的面越界才算异常
        row = self.row([92.4], overflow=["思考 23:59:59", "en Think", "思考 1:05:00"])
        row["overflowPx"] = {"思考 23:59:59": -6.61, "en Think": -1.91, "思考 1:05:00": -13.0}
        problems, _, checked = run_report(default_mode({"11px 默认 宽裕": row}, ui="11px"))
        self.assertEqual((problems, checked), (["11px 默认 宽裕：数值越界 思考 1:05:00（-13.00px）"], 1))
        row["overflowPx"]["思考 1:05:00"] = -11.18
        self.assertEqual(run_report(default_mode({"11px 默认 宽裕": row}))[0], [])
        text = io.StringIO()
        with contextlib.redirect_stdout(text):
            probe.report(default_mode({"11px 默认 宽裕": row}))
        self.assertIn("思考 23:59:59（已知裁尾 -6.61px）", text.getvalue())   # 已知裁尾仍然如实列出
        # 旧版页面侧脚本不带 overflowPx：名单内的面无从判断裁了多少，按异常处理（宁可误报）
        row.pop("overflowPx")
        self.assertEqual(run_report(default_mode({"11px 默认 宽裕": row}))[0],
                         ["11px 默认 宽裕：数值越界 思考 23:59:59、en Think、思考 1:05:00"])

    def test_icon_only_tier_is_constant_2_75em(self):
        problems, _, _ = run_report(default_mode({"14px 默认 极窄": self.row([33.0, 40.0], fs="12px")}))
        self.assertEqual(len(problems), 1)
        self.assertIn("极窄档应恒为 33.0px（2.75em×12px）", problems[0])

    def test_compact_chip_rows_are_exempt_from_the_band(self):
        # 精简 chip 的三档只是上限（12.4/9.7/6.6em，v469 起按内容定宽），不参与条面固定宽核对，只查越界
        rows = {"14px 精简 宽裕": self.row([161.2], fs="13px"), "14px 精简 中等": self.row([126.1], fs="13px"),
                "14px 精简 紧张": self.row([85.8], fs="13px")}
        problems, _, checked = run_report(default_mode(rows))
        self.assertEqual((problems, checked), ([], 0))
        rows["14px 精简 中等"] = self.row([150.0], fs="13px")
        problems, _, _ = run_report(default_mode(rows))
        self.assertEqual(problems, [], "精简档上限不按条面区间核对")


class TierNameTest(unittest.TestCase):
    def test_tier_name_follows_the_css_tiers(self):
        tier = probe.tier_name
        self.assertEqual(tier([], ""), "默认 宽裕")
        self.assertEqual(tier(["zu-tight"], ""), "默认 中等")
        self.assertEqual(tier(["zu-tight", "zu-narrow"], ""), "默认 紧张")
        self.assertEqual(tier(["zu-tight", "zu-narrow"], "1"), "默认 极窄")
        self.assertEqual(tier(["zu-pill"], ""), "药丸 宽裕")
        self.assertEqual(tier(["zu-pill", "zu-speed-mid"], ""), "药丸 中等")
        self.assertEqual(tier(["zu-pill", "zu-speed-tight"], ""), "药丸 紧张")


class SummarizeTest(unittest.TestCase):
    def test_pass_needs_measurable_samples_and_a_face_change(self):
        lines, problems, code = watch(chain(), [WIDE])
        self.assertEqual((problems, code), ([], 0))
        self.assertTrue(any(line.startswith("汇总：通过") and "可量 9 拍" in line and "格面切换 4 次" in line for line in lines), lines)
        self.assertTrue(any("think|思考 0.5s（≥0.1s） → think|思考 1.5s（≥0.1s） → bolt|生成 128.6 t/s（一拍） → tool|读取 01s（≥0.1s） → bolt|250.0 t/s（≥0.1s）" in line
                            for line in lines), lines)

    def test_no_measurable_sample_is_not_a_pass(self):
        samples = [dict(t=1000 * i, b=0, none="invisible", hid=1) for i in range(9)]
        lines, problems, code = watch(samples, [WIDE])
        self.assertEqual((problems, code), ([], 3))
        self.assertIn("采样 9 拍，可量 0 拍，不可量 invisible 9，其中窗口隐藏时采得 9 拍（宿主节流页面定时器，样本变稀）", lines[0])
        self.assertIn("没有可量样本", lines[-1])
        self.assertEqual(watch([], [WIDE])[2], 3)

    def test_compact_theme_is_named_as_the_reason_when_no_bar_sample_exists(self):
        samples = [dict(t=1000 * i, b=0, none="invisible", hid=0) for i in range(9)]
        lines, problems, code = watch(samples, [WIDE], tsb=2)
        self.assertEqual((problems, code), ([], 3))
        self.assertTrue(any("精简样式的速率 chip" in line and "默认模式" in line for line in lines), lines)
        lines, _, code = watch(samples, [WIDE])
        self.assertFalse(any("精简样式" in line for line in lines), "默认/药丸样式下不加这句")   # 首行「不可量 invisible 9」不含这四个字

    def test_unchanged_face_is_not_a_pass(self):
        lines, problems, code = watch([sample(100 * i, FINAL) for i in range(10)], [WIDE])
        self.assertEqual((problems, code), ([], 3))
        self.assertIn("从未变化", lines[-1])

    def test_same_face_width_drift_inside_one_signature(self):
        samples = [sample(0, THINK_A, w=130.8), sample(100, THINK_B, w=130.8),
                   sample(200, THINK_A, w=134.0), sample(300, THINK_A, w=134.0)]
        lines, problems, code = watch(samples, [WIDE])
        self.assertEqual(code, 1)
        self.assertEqual(problems, ["条#0 默认 宽裕 下同一布局宽度不恒定：130.80、134.00"])
        self.assertTrue(lines[-1].startswith("汇总：有异常"))

    def test_overflow_is_a_problem(self):
        samples = chain()
        samples[3]["ov"] = 1
        lines, problems, code = watch(samples, [WIDE])
        self.assertEqual((problems, code), (["条#0 默认 宽裕 下数值越界 1 拍"], 1))
        self.assertTrue(any("越界 1 拍" in line and "格字号 14px｜条父宽 640｜窗口内宽 1200" in line for line in lines), lines)

    def test_bars_and_signatures_are_judged_apart(self):
        two_bars = chain() + chain(5000, s=1, b=1, w=130.8)
        self.assertEqual(watch(two_bars, [WIDE, MID])[1:], ([], 0))
        tier_change = chain()[:3] + chain(300, s=1, w=130.8)[3:]   # 同一条状态条换了档位：宽度随档位变是设计
        lines, problems, code = watch(tier_change, [WIDE, MID])
        self.assertEqual((problems, code), ([], 0))
        self.assertIn("  条#0 档位切换 1 次（可用宽度未变的 1 次）", lines)

    def test_rapid_tier_flips_are_reported_but_not_failed(self):
        flips = [sample(100 * i, THINK_A if i % 2 else THINK_B, s=i % 2, w=176.4 if i % 2 == 0 else 130.8) for i in range(12)]
        lines, problems, code = watch(flips, [WIDE, MID])
        self.assertEqual((problems, code), ([], 0))
        self.assertIn("  ⚠ 条#0 同一可用宽度下 5 秒内档位切换 11 次，疑似折叠振荡，需人工判断", lines)
        resized = [sample(0, THINK_A, s=0), sample(100, THINK_A, s=0)] + [sample(200 + 100 * i, THINK_B, s=1, w=130.8) for i in range(12)]
        lines, problems, code = watch(resized, [WIDE, NARROWER_WINDOW])
        self.assertEqual((problems, code), ([], 0))
        self.assertFalse(any("疑似折叠振荡" in line for line in lines), lines)
        self.assertIn("  条#0 档位切换 1 次（可用宽度未变的 0 次）", lines)
        # 可用宽度 = 条父元素宽度或窗口内宽，任一变化都不算「同宽来回」
        parent_only = [sample(100 * i, THINK_A if i % 2 else THINK_B, s=i % 2, w=176.4 if i % 2 == 0 else 130.8) for i in range(12)]
        lines, problems, code = watch(parent_only, [WIDE, NARROWER_PARENT])
        self.assertEqual((problems, code), ([], 0))
        self.assertFalse(any("疑似折叠振荡" in line for line in lines), lines)
        self.assertIn("  条#0 档位切换 11 次（可用宽度未变的 0 次）", lines)

    def test_single_tick_faces_are_counted_after_the_first_run(self):
        lines, _, _ = watch([sample(0, THINK_A), sample(100, ESTIMATE), sample(200, TOOL), sample(300, TOOL)], [WIDE])
        self.assertIn("  只采到一拍的格面 1 段（停留短于两拍间隔，长短无法判断；工具执行很快时属正常）：bolt|生成 128.6 t/s", lines)
        lines, _, _ = watch([sample(0, THINK_A), sample(100, TOOL), sample(200, TOOL)], [WIDE])
        self.assertFalse(any("只采到一拍" in line for line in lines), lines)   # 首段起点在观察之前，单独一段不算


class MainWiringTest(unittest.TestCase):
    def test_watch_mode_reports_a_closed_debug_port_as_not_run(self):
        with socket.socket() as sock:                  # 先占一个空闲端口再放开，得到一个确定没人监听的本地端口
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = probe.main(["--host", "127.0.0.1", "--port", str(port), "--watch", "1"])
        self.assertEqual(code, 2)
        self.assertIn("连不上或观察中断", out.getvalue())


class FaceClassTest(unittest.TestCase):
    """v459 全部格面固定宽：跨格面的宽度不同就是异常（抖动）。默认模式核对 6.6em×格字号，
    持续观察按布局（签名前 7 段，不分面类别）归组核对；面类别只是报告用的标签。"""

    ROW = {"fs": "14px", "minSlack": 5.0, "minLead": 0, "overflow": []}

    def row(self, **fields):
        return dict(self.ROW, **fields)

    def test_report_flags_content_hugging_widths(self):
        # v455/v456 的随内容伸缩（79.2 / 79.3 / 81.0）在 v459 是异常；0.5px 内视为同宽
        row = self.row(speedW=[79.3, 81.0], plainW=[79.2], turnL=[300.0, 268.0], plainTurnL=[224.4], fs="12px")
        out = default_mode({"14px 默认 宽裕": row})
        self.assertEqual(run_report(out)[0], ["14px 默认 宽裕：宽度 81.0 应恒为 79.2px（6.6em×12px）——全部状态面必须同宽"])
        text = io.StringIO()
        with contextlib.redirect_stdout(text):
            probe.report(out)
        self.assertIn("79.2~81.0", text.getvalue())
        self.assertIn("79.2", text.getvalue())   # 固定宽参考列（6.6em×12px）
        row = self.row(speedW=[79.2], plainW=[79.2], fs="12px")
        self.assertEqual(run_report(default_mode({"14px 默认 宽裕": row}))[0], [])

    def test_report_flags_overflow_only(self):
        row = self.row(speedW=[92.4], overflow=["估算 9999.9"])
        self.assertEqual(run_report(default_mode({"14px 默认 宽裕": row}))[0], ["14px 默认 宽裕：数值越界 估算 9999.9"])

    def test_narrow_tier_face_off_the_fixed_width_is_a_problem(self):
        row = self.row(speedW=[79.2], plainW=[150.0], turnL=[300.0], plainTurnL=[305.6], fs="12px")
        self.assertEqual(run_report(default_mode({"14px 默认 紧张": row}))[0],
                         ["14px 默认 紧张：宽度 150.0 应恒为 79.2px（6.6em×12px）——全部状态面必须同宽"])

    def test_class_only_change_is_not_a_tier_flip(self):
        tag, plain = WIDE + "|tag", WIDE + "|plain"
        samples = [sample(0, THINK_A, w=92.4), sample(100, THINK_B, w=92.4), sample(200, FINAL, w=92.4, s=1), sample(300, FINAL, w=92.4, s=1)]
        lines, problems, code = watch(samples, [tag, plain])
        self.assertEqual((problems, code), ([], 0))
        # 两个面类别并进同一布局行：同宽即无异常，面类别只留在「格面 N 种」里
        self.assertTrue(any("条#0 默认 宽裕｜格字号 14px" in line and "速度格宽 92.40" in line and "格面 3 种" in line for line in lines), lines)
        self.assertFalse(any("档位切换" in line for line in lines), lines)

    def test_roomy_toggle_is_a_tier_flip(self):
        narrow, roomy = "zu-tight zu-narrow||12px|640|1200|14px|2|tag", "zu-tight zu-narrow zu-sp-roomy||12px|640|1200|14px|2|tag"
        samples = [sample(0, THINK_A, w=86.4), sample(100, THINK_B, w=130.8, s=1)]
        lines, problems, code = watch(samples, [narrow, roomy])
        self.assertEqual((problems, code), ([], 0))
        self.assertTrue(any("条#0 档位切换 1 次（可用宽度未变的 1 次）" in line for line in lines), lines)

    def test_width_drift_inside_one_face_is_a_problem(self):
        samples = [sample(0, THINK_A, w=130.8), sample(100, FINAL, w=86.4, s=1), sample(200, FINAL, w=90.0, s=1)]
        lines, problems, code = watch(samples, [WIDE + "|tag", WIDE + "|plain"])
        self.assertEqual((problems, code), (["条#0 默认 宽裕 下同一布局宽度不恒定：86.40、90.00、130.80"], 1))

    def test_cross_face_width_change_is_a_problem(self):
        # v459：思考 176.4、其余面 180.0——跨格面的宽度不同就是抖动，必须报异常（v455 时这算合法）
        samples = chain()[:2] + chain(200, w=180.0)[2:]
        lines, problems, code = watch(samples, [WIDE])
        self.assertEqual((problems, code), (["条#0 默认 宽裕 下同一布局宽度不恒定：176.40、180.00"], 1))

    def test_tier_name_ignores_the_roomy_marker(self):
        self.assertEqual(probe.tier_name(["zu-tight", "zu-narrow", "zu-sp-roomy"], ""), "默认 紧张")


if __name__ == "__main__":
    unittest.main()
