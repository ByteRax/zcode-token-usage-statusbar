# -*- coding: utf-8 -*-
"""速度格实机量宽探针的判定函数回归（specs/speed-chip-stable-slot.md）。

tests/speed-slot-live-probe.py 是实机工具，这里不连调试口，只用构造的结果锁定：
- 默认模式 report()：同档宽度唯一、邻格不动、无越界三项判据，以及界面字号 14px 时逐档核对目标区间；
- 持续观察 summarize()：同一条状态条、同一布局签名下宽度不唯一或越界才是异常；没有可量样本、格面从未变化
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

# 页面侧布局签名（tests/speed-slot-live-watch.js）：档位类 | 最窄标记 | 格字号 | 条父宽 | 窗口内宽 | 界面字号 | 像素比
WIDE = "||14px|640|1200|14px|2"
MID = "zu-tight||14px|640|1200|14px|2"
NARROWER_WINDOW = "||14px|640|900|14px|2"
NARROWER_PARENT = "||14px|600|1200|14px|2"

THINK_A, THINK_B = "think|思考 0.5s", "think|思考 1.5s"
ESTIMATE, TOOL, FINAL = "bolt|生成 ≈128.6 t/s", "tool|读取 01s", "bolt|250.0 t/s"


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
    def test_clean_run_checks_every_tier_against_the_target_ranges_at_14px(self):
        names = ["默认 宽裕", "默认 中等", "默认 紧张", "默认 极窄", "药丸 宽裕", "药丸 中等", "药丸 紧张"]
        widths = [176.4, 130.8, 86.4, 33, 176.4, 130.8, 86.4]
        out = default_mode({"14px " + name: tier_row(width) for name, width in zip(names, widths)})
        problems, base, checked = run_report(out)
        self.assertEqual(problems, [])
        self.assertEqual((base, checked), ("14px", 7))
        out["tiers"]["14px 默认 极窄"] = tier_row(28.0)
        problems, _, _ = run_report(out)
        self.assertEqual(problems, ["14px 默认 极窄：28.0px 不在目标区间 32–40"])

    def test_width_drift_neighbour_move_and_overflow_are_problems(self):
        row = {"fs": "14px", "speedW": [176.4, 180.0], "turnL": [300.0, 303.6], "minSlack": -1.5, "minLead": 0, "overflow": ["估算 9999.9"]}
        problems, base, checked = run_report(default_mode({"16px 默认 宽裕": row}, ui="16px"))
        self.assertEqual((base, checked), ("16px", 0))   # 基准字号不是 14px：不核对目标区间（宽度随字号等比缩放）
        self.assertEqual(problems, [
            "16px 默认 宽裕：宽度随状态变化 [176.4, 180.0]",
            "16px 默认 宽裕：邻格位置变化 [300.0, 303.6]",
            "16px 默认 宽裕：数值越界 估算 9999.9",
        ])

    def test_range_check_follows_the_interface_font_size(self):
        problems, base, checked = run_report(default_mode({"16px 默认 宽裕": tier_row(201.6)}, ui="16px"))
        self.assertEqual((problems, base, checked), ([], "16px", 0))
        out = default_mode({"16px 默认 宽裕": tier_row(201.6)}, ui="16px")
        out["tiers"]["14px 默认 宽裕"] = tier_row(176.4)   # 只有与基准字号相同的那一组参与核对
        problems, _, checked = run_report(out)
        self.assertEqual((problems, checked), ([], 0))

    def test_compact_chip_rows_are_checked_like_the_bar_tiers(self):
        rows = {"14px 精简 宽裕": tier_row(161.2), "14px 精简 中等": tier_row(126.1), "14px 精简 紧张": tier_row(85.8)}
        problems, _, checked = run_report(default_mode(rows))
        self.assertEqual((problems, checked), ([], 3))
        rows["14px 精简 中等"] = tier_row(136.5)
        problems, _, _ = run_report(default_mode(rows))
        self.assertEqual(problems, ["14px 精简 中等：136.5px 不在目标区间 112–132"])


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
        self.assertTrue(any("think|思考 0.5s（≥0.1s） → think|思考 1.5s（≥0.1s） → bolt|生成 ≈128.6 t/s（一拍） → tool|读取 01s（≥0.1s） → bolt|250.0 t/s（≥0.1s）" in line
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

    def test_width_must_be_unique_inside_one_signature(self):
        samples = chain()[:2] + chain(200, w=180.0)[2:]
        lines, problems, code = watch(samples, [WIDE])
        self.assertEqual(code, 1)
        self.assertEqual(problems, ["条#0 默认 宽裕 下速度格宽度随状态变化：176.40、180.00"])
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
        self.assertIn("  只采到一拍的格面 1 段（停留短于两拍间隔，长短无法判断；工具执行很快时属正常）：bolt|生成 ≈128.6 t/s", lines)
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


if __name__ == "__main__":
    unittest.main()
