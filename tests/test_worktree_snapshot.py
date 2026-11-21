# -*- coding: utf-8 -*-
"""受管 worktree 快照事实（specs/worktree-branch.md）：布局判定、起点记录、门控与降级。

纯隔离：临时目录 + 内存库，不触碰真实 HOME 或宿主数据库。
"""
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


zusage = load("worktree_zusage", ROOT / "zusage.py")

# snapshot() 的今日/费用/工具查询依赖真实表结构，沿用 test_statusbar_rate 的完整 SCHEMA
#（经 spec_from_file_location 加载，非裸同级导入），另补本特性读取的 part 表。
_spec = importlib.util.spec_from_file_location("worktree_rate_schema", ROOT / "tests/test_statusbar_rate.py")
_rate_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rate_mod)
SCHEMA = _rate_mod.SCHEMA + """
create table part (id text primary key, message_id text, session_id text,
  time_created integer, data text);
"""

# CLI 落库是紧凑分隔（真实库样本 `"timelineType":"worktree_creation"` 无空格），LIKE 预滤按此写
WT_PART = json.dumps({
    "timelineType": "worktree_creation",
    "display": "worklog",
    "worktreeCreation": {"path": "/x/wt", "sha": "0eb3d3133adc5c1905e042f73c4b06b139478791", "ref": None},
}, separators=(",", ":"))


class WorktreeFactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_root = Path(self.tmp.name)
        self.wt_root = self.data_root / ".zcode" / "worktrees" / "d0c5" / "repo"
        env = {"ZCODE_DATA_BASE_DIR": str(self.data_root)}
        patcher = mock.patch.dict(os.environ, env, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        zusage._WT_FACT_CACHE.clear()

    def fact(self, directory):
        return zusage._worktree_fact(directory)

    def test_managed_layout_monorepo_cwd(self):
        """cwd 在 worktree 内的 monorepo 子目录：root 截到 <bucket>/<name>，cwd 原样。"""
        cwd = self.wt_root / "packages" / "ui"
        got = self.fact(str(cwd))
        self.assertEqual(got["root"], os.path.realpath(str(self.wt_root)))
        self.assertEqual(got["cwd"], os.path.realpath(str(cwd)))
        self.assertEqual(got["bucket"], "d0c5")
        self.assertEqual(got["name"], "repo")

    def test_deleted_worktree_still_reported(self):
        """目录未建（已删除）：realpath 宽容，布局判定照常命中（宿主 §3.12 只读保留语义）。"""
        got = self.fact(str(self.wt_root / "gone"))
        self.assertIsNotNone(got)
        self.assertEqual(got["root"], os.path.realpath(str(self.wt_root)))

    def test_non_managed_paths_rejected(self):
        self.assertIsNone(self.fact(str(self.data_root / "elsewhere" / "repo")))
        self.assertIsNone(self.fact(str(self.data_root / ".zcode" / "worktrees")))          # 受管根本身
        self.assertIsNone(self.fact(str(self.data_root / ".zcode" / "worktrees" / "d0c5")))  # 只有一级
        self.assertIsNone(self.fact("")) 
        self.assertIsNone(self.fact(None))

    def test_bucket_shape_enforced(self):
        for bad in ("D0C5", "d0c", "d0c55", "bucket"):
            self.assertIsNone(self.fact(str(self.data_root / ".zcode" / "worktrees" / bad / "repo" / "x")),
                              bad)


class WorktreeOriginTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        self.addCleanup(self.con.close)

    def insert_part(self, data, sid="s_wt", ts=1000):
        self._n = getattr(self, "_n", 0) + 1
        self.con.execute("insert into part values (?,?,?,?,?)",
                         (f"p{self._n}", "m1", sid, ts, data))
        self.con.commit()

    def test_ref_extracted_from_creation_part(self):
        self.insert_part(WT_PART.replace('"ref":null', '"ref": "feature/branch"'))
        self.assertEqual(zusage._worktree_origin(self.con, "s_wt"),
                         ("feature/branch", "0eb3d3133adc5c1905e042f73c4b06b139478791", None))

    def test_detached_ref_is_none(self):
        self.insert_part(WT_PART)
        ref, sha, created = zusage._worktree_origin(self.con, "s_wt")
        self.assertIsNone(ref)
        self.assertEqual(sha, "0eb3d3133adc5c1905e042f73c4b06b139478791")
        self.assertIsNone(created)   # 无 time 字段不伪造

    def test_like_prefilter_no_false_positive(self):
        """推理正文里出现同字面量不误报：json 校验 timelineType 后丢弃。"""
        self.insert_part(json.dumps({"type": "reasoning",
                                     "text": 'the part key is "timelineType":"worktree_creation" ok'}))
        self.assertEqual(zusage._worktree_origin(self.con, "s_wt"), (None, None, None))

    def test_corrupt_json_part_skipped_not_fatal(self):
        """损坏 JSON 的 LIKE 命中行跳过继续，不炸帧也不遮蔽其后真实创建记录（审查 M2a）。"""
        self.insert_part('{"timelineType":"worktree_creation","broken', ts=500)   # 非法 JSON
        self.insert_part(WT_PART.replace('"ref":null', '"ref":"late/ref"'), ts=1000)
        self.assertEqual(zusage._worktree_origin(self.con, "s_wt"),
                         ("late/ref", "0eb3d3133adc5c1905e042f73c4b06b139478791", None))

    def test_earlier_plain_part_does_not_shadow_creation(self):
        """更早的普通 part（正文同字面量、合法 JSON、无 worktreeCreation）不遮蔽其后真实 part（M2b）。"""
        self.insert_part(json.dumps(
            {"type": "reasoning", "text": 'quote: "timelineType":"worktree_creation" in prose'},
            separators=(",", ":")), ts=500)
        self.insert_part(WT_PART.replace('"ref":null', '"ref":"feat/real"'), ts=1000)
        self.assertEqual(zusage._worktree_origin(self.con, "s_wt"),
                         ("feat/real", "0eb3d3133adc5c1905e042f73c4b06b139478791", None))

    def test_created_extracted_from_part_time(self):
        """创建时刻取 part 信封层 time.start（毫秒）；非数值/越界不伪造（v409）。"""
        part = json.dumps({
            "timelineType": "worktree_creation", "display": "worklog",
            "worktreeCreation": {"path": "/x/wt", "sha": "0eb3d3133adc5c1905e042f73c4b06b139478791", "ref": "feat/t"},
            "time": {"start": 1795056006731, "end": 1795056006732},
        }, separators=(",", ":"))
        self.insert_part(part)
        self.assertEqual(zusage._worktree_origin(self.con, "s_wt"),
                         ("feat/t", "0eb3d3133adc5c1905e042f73c4b06b139478791", 1795056006731))

    def test_created_rejects_bool_and_oversize(self):
        """布尔（int 子类）与超出 1970~2100 量级的时间不伪造（审查 MINOR-6）。"""
        for bad in (True, 10 ** 16, -5, "1.7e12"):
            part = json.dumps({
                "timelineType": "worktree_creation", "display": "worklog",
                "worktreeCreation": {"path": "/x/wt", "sha": "s", "ref": None},
                "time": {"start": bad},
            }, separators=(",", ":"))
            self.insert_part(part)
            self.assertEqual(zusage._worktree_origin(self.con, "s_wt")[2], None, repr(bad))

    def test_missing_part_and_missing_table(self):
        self.assertEqual(zusage._worktree_origin(self.con, "nope"), (None, None, None))
        bare = sqlite3.connect(":memory:")
        self.addCleanup(bare.close)
        self.assertEqual(zusage._worktree_origin(bare, "s_wt"), (None, None, None))   # 缺表静默降级


class WorktreeSourceRootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "wt"
        self.root.mkdir(parents=True)

    def test_source_root_from_git_link(self):
        """<root>/.git 链接文件上溯两级得源仓库（v409）。"""
        # 期望值经 Path 归一：实现返回 str(Path(...))，Windows 下分隔符为本机形状
        # （断言曾硬编码 POSIX 字面量，在 Windows 恒红——v416 修正）
        (self.root / ".git").write_text("gitdir: /src/repo/.git/worktrees/wtname6\n", encoding="utf-8")
        self.assertEqual(zusage._worktree_source_root(str(self.root)), str(Path("/src/repo")))

    def test_fail_soft_cases(self):
        self.assertIsNone(zusage._worktree_source_root(str(self.root)))   # 无 .git
        (self.root / ".git").write_text("gitdir: /src/repo/.git\n", encoding="utf-8")
        self.assertIsNone(zusage._worktree_source_root(str(self.root)))   # 非 worktrees 布局
        (self.root / ".git").write_text("gitdir: /x/.git/worktrees/w\n", encoding="utf-8")
        self.assertEqual(zusage._worktree_source_root(str(self.root)), str(Path("/x")))   # 最短合法形态
        (self.root / ".git").write_text("not gitdir line\n", encoding="utf-8")
        self.assertIsNone(zusage._worktree_source_root(str(self.root)))   # 格式不符


class WorktreeSnapshotGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_root = Path(self.tmp.name)
        self.wt_root = self.data_root / ".zcode" / "worktrees" / "402d" / "zcode-token-usage-statusbar"
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        self.addCleanup(self.con.close)
        self.con.execute("insert into session (id, title, directory) values (?,?,?)",
                         ("s_wt", "wt task", str(self.wt_root / "packages" / "ui")))
        self.con.execute("insert into session (id, title, directory) values (?,?,?)",
                         ("s_plain", "plain task", str(self.data_root / "plain")))
        self.con.execute("insert into part values (?,?,?,?,?)",
                         ("p1", "m1", "s_wt", 1000, WT_PART.replace('"ref":null', '"ref": "feat/x"')))
        self.con.commit()
        zusage._WT_FACT_CACHE.clear()

    def snap(self, sids, **kw):
        kw.setdefault("serve_con", self.con)   # 连接所有权归调用方：不传会被 snapshot 关掉 mock 连接
        with mock.patch.object(zusage, "connect", return_value=self.con), \
                mock.patch.object(zusage, "load_config", return_value={"context_window": 1}), \
                mock.patch.dict(os.environ, {"ZCODE_DATA_BASE_DIR": str(self.data_root)}, clear=False):
            return zusage.snapshot(",".join(sids), **kw)

    def test_desktop_chain_carries_worktrees(self):
        out = self.snap(["s_wt", "s_plain"], include_worktree=True)
        self.assertEqual(out["worktrees"]["s_wt"]["root"], os.path.realpath(str(self.wt_root)))
        self.assertEqual(out["worktrees"]["s_wt"]["bucket"], "402d")
        self.assertEqual(out["worktrees"]["s_wt"]["ref"], "feat/x")
        self.assertNotIn("s_plain", out["worktrees"])   # 非受管会话不出现

    def test_default_gate_omits_field(self):
        self.assertNotIn("worktrees", self.snap(["s_wt"]))

    def test_no_hits_omits_field_entirely(self):
        out = self.snap(["s_plain"], include_worktree=True)
        self.assertNotIn("worktrees", out)   # 无命中省略字段（不是空对象）

    def test_lean_like_caller_controls_inclusion(self):
        """桌面链开关点与 speed_history 一致：调用方传参决定，快照自身不看 env。"""
        with_hist = self.snap(["s_wt"], include_speed_history=True, include_worktree=True)
        self.assertIn("worktrees", with_hist)
        self.assertNotIn("worktrees", self.snap(["s_wt"], include_speed_history=True))

    def test_dual_managed_sids_get_own_facts(self):
        """同 worktree 两个会话（如 fork 子会话）各自命中，互不串号（WTB-08）。"""
        self.con.execute("insert into session (id, title, directory) values (?,?,?)",
                         ("s_wt2", "fork child", str(self.wt_root / "packages" / "ui")))
        self.con.execute("insert into part values (?,?,?,?,?)",
                         ("p9", "m9", "s_wt2", 1000, WT_PART.replace('"ref":null', '"ref":"feat/child"')))
        self.con.commit()
        zusage._WT_FACT_CACHE.clear()
        out = self.snap(["s_wt", "s_wt2"], include_worktree=True)
        self.assertEqual(out["worktrees"]["s_wt"]["ref"], "feat/x")
        self.assertEqual(out["worktrees"]["s_wt2"]["ref"], "feat/child")
        self.assertEqual(out["worktrees"]["s_wt2"]["root"], out["worktrees"]["s_wt"]["root"])

    def test_unrecorded_session_row_not_negative_cached(self):
        """session 行未落库/目录为空不写负缓存：落库后下一帧即命中（审查 M1）。"""
        self.snap(["s_late"], include_worktree=True)
        self.assertNotIn("s_late", zusage._WT_FACT_CACHE, "未落库 sid 不得进负缓存")
        self.con.execute("insert into session (id, title, directory) values (?,?,?)",
                         ("s_late", "late task", str(self.wt_root)))
        self.con.commit()
        out = self.snap(["s_late"], include_worktree=True)
        self.assertIn("s_late", out["worktrees"], "落库后下一帧即命中")

    def test_confirmed_non_managed_is_negative_cached(self):
        """已判定非受管的 sid 写负缓存（重复查询不再打库）。"""
        self.snap(["s_plain"], include_worktree=True)
        self.assertIn("s_plain", zusage._WT_FACT_CACHE)
        self.assertIsNone(zusage._WT_FACT_CACHE["s_plain"])

    def test_pending_origin_requeried_until_part_lands(self):
        """起点未决（part 晚于 session 行落库，实测 ~1.2s 窗）：缓存命中也重查，拿到即转已决（审查 M-1）。"""
        self.snap(["s_wt"], include_worktree=True)   # part 已在 → ref 直接拿到
        self.assertEqual(zusage._WT_FACT_CACHE["s_wt"]["ref"], "feat/x")
        # 新会话：session 行在、part 未写 → 首帧缓存空起点（未决）
        self.con.execute("insert into session (id, title, directory) values (?,?,?)",
                         ("s_pending", "pending task", str(self.wt_root)))
        self.con.commit()
        out = self.snap(["s_pending"], include_worktree=True)
        self.assertEqual(out["worktrees"]["s_pending"]["ref"], None)
        # part 落库 → 下一帧命中缓存也重查并转已决
        self.con.execute("insert into part values (?,?,?,?,?)",
                         ("p20", "m20", "s_pending", 2000, WT_PART.replace('"ref":null', '"ref":"late/branch"')))
        self.con.commit()
        out = self.snap(["s_pending"], include_worktree=True)
        self.assertEqual(out["worktrees"]["s_pending"]["ref"], "late/branch")
        self.assertEqual(zusage._WT_FACT_CACHE["s_pending"]["ref"], "late/branch")
        # sha-only（detached 默认形状 ref=null/sha=有值）落库同样转已决（审查 MINOR-2）
        self.con.execute("insert into session (id, title, directory) values (?,?,?)",
                         ("s_detached", "detached task", str(self.wt_root)))
        self.con.commit()
        self.snap(["s_detached"], include_worktree=True)
        self.con.execute("insert into part values (?,?,?,?,?)", ("p21", "m21", "s_detached", 2000, WT_PART))
        self.con.commit()
        out = self.snap(["s_detached"], include_worktree=True)
        self.assertIsNone(out["worktrees"]["s_detached"]["ref"])
        self.assertEqual(out["worktrees"]["s_detached"]["sha"], "0eb3d3133adc5c1905e042f73c4b06b139478791")


if __name__ == "__main__":
    unittest.main()
