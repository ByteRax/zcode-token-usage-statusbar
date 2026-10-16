# -*- coding: utf-8 -*-
"""zusage db-bridge：新版 ZCode（3.15.3+）不再写 ~/.zcode/cli/db/db.sqlite，
模型 I/O 记录只落在 ~/.zcode/cli/rollout/model-io-sess_*.jsonl。
本守护进程把 jsonl 增量同步进 db.sqlite（zusage.py / 悬浮状态条期望的聚合库），
让 token-usage-statusbar 插件在新版客户端上恢复供数。

不修改插件与 ZCode 本体；db.sqlite 只增不删，写入幂等（request 维度唯一索引）。

数据映射：
  model_usage  <- 每行 model_io 记录（usage 字段，attempt-1=重试，toolCalls 数=工具调用数）
  turn_usage   <- 按 (session_id, turn_id) 从 model_usage 重算
  tool_usage   <- response.toolCalls 展开成行（无真实工具耗时，duration_ms=0）
  session      <- sessionId / 首条用户消息截断为标题 / 系统提示里的工作目录；
                  子代理会话用 agents/<父>/agent_x/metadata.json 补 parent/cwd/description
  part         <- 建空表，防止 zusage._sub_agent_tasks 查询报错（任务名回退子会话标题）
已知降级：model-io 无首字时间，time_to_first_token_ms 恒 0，速率分母退化为总耗时。
"""
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
ROLLOUT = HOME / ".zcode" / "cli" / "rollout"
AGENTS = HOME / ".zcode" / "cli" / "agents"
DB_PATH = HOME / ".zcode" / "cli" / "db" / "db.sqlite"
STATE_PATH = Path(__file__).with_name("state.json")
LOCK_PATH = Path(__file__).with_name("bridge.lock")
POLL_SEC = 2.0
TITLE_LIMIT = 57  # ZCode 会话标题规则：prompt 前 57 字符 + "..."
TAIL_CAP = 64 * 1024 * 1024  # 历史大文件首次导入只取尾部 64MB

DDL = """
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  directory TEXT DEFAULT '',
  parent_id TEXT,
  time_created INTEGER DEFAULT 0,
  time_updated INTEGER DEFAULT 0,
  summary_additions INTEGER,
  summary_deletions INTEGER,
  summary_files INTEGER
);
CREATE TABLE IF NOT EXISTS model_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  request_id TEXT DEFAULT '',
  attempt INTEGER DEFAULT 1,
  provider_id TEXT DEFAULT '',
  model_id TEXT DEFAULT '',
  agent TEXT DEFAULT '',
  query_source TEXT DEFAULT 'main_turn',
  status TEXT DEFAULT 'completed',
  started_at INTEGER,
  first_token_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER DEFAULT 0,
  time_to_first_token_ms INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cache_read_input_tokens INTEGER DEFAULT 0,
  cache_creation_input_tokens INTEGER DEFAULT 0,
  computed_total_tokens INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  context_exceeded INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mu_req ON model_usage(session_id, request_id, attempt);
CREATE INDEX IF NOT EXISTS ix_mu_sid ON model_usage(session_id, status, completed_at);
CREATE TABLE IF NOT EXISTS turn_usage (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT DEFAULT 'completed',
  model_request_count INTEGER DEFAULT 0,
  model_retry_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  tool_error_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cache_read_input_tokens INTEGER DEFAULT 0,
  cache_creation_input_tokens INTEGER DEFAULT 0,
  computed_total_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  time_to_first_token_ms INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, turn_id)
);
CREATE TABLE IF NOT EXISTS tool_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  tool_name TEXT DEFAULT '',
  status TEXT DEFAULT 'completed',
  duration_ms INTEGER DEFAULT 0,
  completed_at INTEGER DEFAULT 0,
  request_id TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_tu_req ON tool_usage(request_id, tool_name);
CREATE TABLE IF NOT EXISTS part (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT DEFAULT '',
  data TEXT DEFAULT '',
  time_created INTEGER DEFAULT 0,
  time_updated INTEGER DEFAULT 0
);
"""

WDIR_RE = re.compile(r"Primary working directory:\s*(.+)")


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def iso_ms(s):
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text") or "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def make_title(body):
    for m in (body or {}).get("messages") or []:
        if isinstance(m, dict) and m.get("role") == "user":
            t = " ".join(text_of(m.get("content")).split()).strip()
            if t and not t.startswith("<system-reminder>"):
                return t[:TITLE_LIMIT] + "..." if len(t) > TITLE_LIMIT + 3 else t
    return ""


def make_directory(body):
    for s in (body or {}).get("system") or []:
        t = s.get("text") if isinstance(s, dict) else s
        if isinstance(t, str):
            m = WDIR_RE.search(t)
            if m:
                return m.group(1).strip()
    return ""


def usage_of(resp):
    u = (resp or {}).get("usage") or {}
    alt = (((resp or {}).get("providerMetadata") or {}).get("anthropic") or {}).get("usage") or {}
    inp = u.get("inputTokens", alt.get("input_tokens")) or 0
    out = u.get("outputTokens", alt.get("output_tokens")) or 0
    crd = u.get("cacheReadTokens", alt.get("cache_read_input_tokens")) or 0
    cwr = u.get("cacheWriteTokens", alt.get("cache_creation_input_tokens")) or 0
    tot = u.get("totalTokens") or (inp + out)
    return int(inp), int(out), int(crd), int(cwr), int(tot)


def parse_record(o):
    """一行 model_io JSON → 可入库的各表数据；无 usage 视为失败请求，跳过。"""
    resp = o.get("response") or {}
    if not isinstance(resp.get("usage") or {}, dict) or not resp.get("usage"):
        return None
    body = (o.get("request") or {}).get("body") or {}
    sid = o.get("sessionId") or ""
    if not sid:
        return None
    inp, out, crd, cwr, tot = usage_of(resp)
    tools = resp.get("toolCalls") or []
    is_sub = sid.startswith("sess_subagent")
    started = iso_ms(o.get("startedAt"))
    completed = iso_ms(o.get("completedAt"))
    duration = int(o.get("durationMs") or 0)
    if started is None and completed is not None:
        started = completed - duration
    attempt = int(o.get("attempt") or 1)
    return {
        "sid": sid,
        "title": make_title(body),
        "directory": make_directory(body),
        "turn_id": o.get("turnId"),
        "request_id": o.get("requestId") or "",
        "attempt": attempt,
        "provider_id": (o.get("model") or {}).get("providerId") or "",
        "model_id": (o.get("model") or {}).get("modelId")
                    or (resp.get("modelId") if isinstance(resp.get("modelId"), str) else "") or "",
        "agent": ((resp.get("providerMetadata") or {}).get("anthropic") or {}).get("iterations") or "",
        "query_source": "subagent" if is_sub else "main_turn",
        "is_sub": is_sub,
        "started_at": started,
        "completed_at": completed,
        "duration_ms": duration,
        "inp": inp, "out": out, "crd": crd, "cwr": cwr, "tot": tot,
        "tool_calls": len(tools) if isinstance(tools, list) else 0,
        "retry_count": max(0, attempt - 1),
        "tool_names": [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")],
    }


def ensure_db(con):
    con.executescript(DDL)
    con.commit()


def open_db_fresh():
    """打开库；旧损坏库挪走（新版 ZCode 不再读写它，挪走无副作用）。
    被占用时返回 None，由主循环稍后重试（占用者多为悬浮条旧 watch 进程）。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        probe = None
        try:
            probe = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True, timeout=2)
            probe.execute("select 1 from model_usage limit 1").fetchone()
            probe.close()
            probe = None
            log("已有可用 db.sqlite，直接增量续写")
        except Exception:
            if probe is not None:
                try:
                    probe.close()
                except Exception:
                    pass
            bak = DB_PATH.with_name("db.sqlite.corrupt-bak")
            try:
                DB_PATH.rename(bak)
                for suffix in ("-wal", "-shm"):
                    p = DB_PATH.with_name(DB_PATH.name + suffix)
                    if p.exists():
                        p.unlink()
                log(f"旧库损坏，已挪为 {bak.name}，重建新库")
            except OSError as e:
                log(f"旧库暂时被占用（{e.__class__.__name__}），等下轮重试")
                return None
    con = sqlite3.connect(str(DB_PATH), timeout=5)
    con.execute("pragma journal_mode=wal")
    con.execute("pragma synchronous=normal")
    ensure_db(con)
    return con


def upsert_session(con, rec):
    con.execute(
        """insert into session (id, title, directory, time_created, time_updated)
           values (?,?,?,?,?)
           on conflict(id) do update set
             time_updated = max(coalesce(time_updated,0), excluded.time_updated),
             title = case when session.title='' or session.title like '<system-reminder>%'
                          then excluded.title else session.title end,
             directory = case when session.directory='' and excluded.directory!=''
                              then excluded.directory else session.directory end""",
        (rec["sid"], rec["title"], rec["directory"],
         rec["started_at"] or 0, rec["completed_at"] or 0))


def insert_model_usage(con, rec):
    cur = con.execute(
        """insert or ignore into model_usage
           (session_id, turn_id, request_id, attempt, provider_id, model_id, agent,
            query_source, status, started_at, first_token_at, completed_at, duration_ms,
            time_to_first_token_ms, input_tokens, output_tokens, reasoning_tokens,
            cache_read_input_tokens, cache_creation_input_tokens, computed_total_tokens,
            tool_call_count, retry_count, context_exceeded)
           values (?,?,?,?,?,?,?,?,'completed',?,NULL,?,?,0,?,?,0,?,?,?,?,?,0)""",
        (rec["sid"], rec["turn_id"], rec["request_id"], rec["attempt"],
         rec["provider_id"], rec["model_id"], rec["agent"], rec["query_source"],
         rec["started_at"], rec["completed_at"], rec["duration_ms"],
         rec["inp"], rec["out"], rec["crd"], rec["cwr"], rec["tot"],
         rec["tool_calls"], rec["retry_count"]))
    return cur.rowcount > 0


def insert_tool_usage(con, rec):
    for name in rec["tool_names"]:
        con.execute(
            """insert or ignore into tool_usage
               (session_id, turn_id, tool_name, status, duration_ms, completed_at, request_id)
               values (?,?,?,'completed',0,?,?)""",
            (rec["sid"], rec["turn_id"], name, rec["completed_at"] or 0, rec["request_id"]))


def refresh_turn_usage(con, sid, turn_id):
    if not turn_id:
        return
    con.execute(
        """insert or replace into turn_usage
           (session_id, turn_id, status, model_request_count, model_retry_count,
            tool_call_count, tool_error_count, input_tokens, output_tokens,
            reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens,
            computed_total_tokens, duration_ms, time_to_first_token_ms)
           select session_id, turn_id, 'completed', count(*), coalesce(sum(retry_count),0),
                  coalesce(sum(tool_call_count),0), 0,
                  coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                  coalesce(sum(reasoning_tokens),0),
                  coalesce(sum(cache_read_input_tokens),0),
                  coalesce(sum(cache_creation_input_tokens),0),
                  coalesce(sum(computed_total_tokens),0),
                  coalesce(sum(duration_ms),0), 0
           from model_usage
           where session_id=? and turn_id=? and status='completed'
           group by session_id, turn_id""", (sid, turn_id))


def scan_agent_meta():
    """agents/<父会话>/agent_x/metadata.json → childSessionId → 元数据。"""
    out = {}
    if not AGENTS.exists():
        return out
    for d in AGENTS.iterdir():
        if not d.is_dir() or not d.name.startswith("sess_"):
            continue
        for a in d.iterdir():
            mj = a / "metadata.json"
            if not mj.is_file():
                continue
            try:
                m = json.loads(mj.read_text(encoding="utf-8"))
            except Exception:
                continue
            cid = m.get("childSessionId")
            if cid:
                out[cid] = m
    return out


def enrich_from_agent_meta(con, metas):
    """用 metadata.json 补子会话的 parent/cwd/description（含新出现的会话）。"""
    n = 0
    for cid, m in metas.items():
        row = con.execute("select parent_id, directory, title from session where id=?",
                          (cid,)).fetchone()
        parent = m.get("parentSessionId") or None
        cwd = m.get("cwd") or ""
        desc = (m.get("description") or "").strip()
        if row is None:
            continue  # 还没从 model-io 见到该子会话，等有记录后再补
        if row[0] != parent or (not row[1] and cwd) or (desc and row[2] != desc):
            con.execute(
                """update session set parent_id=?, directory=case when directory='' then ? else directory end,
                   title=case when ?!='' then ? else title end where id=?""",
                (parent, cwd, desc, desc, cid))
            n += 1
        if parent:
            con.execute(
                """insert into session (id, title, directory, time_created, time_updated)
                   values (?,'','',?,?)
                   on conflict(id) do nothing""",
                (parent, int(((mj.get('createdAt') or '') and iso_ms(mj.get('createdAt'))) or 0), 0))
    return n


def load_state():
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_state(state):
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, STATE_PATH)


def process_file(con, path, offset, state_entry):
    """从 offset 起逐行流式读取（以 \n 结尾才算完整），返回新 offset 与新插入行数。
    首次遇到超过 TAIL_CAP 的历史大文件只从尾部 64MB 起导（rollout 总量 26GB，全导要数小时；
    行对齐后从该处续增量，旧会话丢失的只是窗口外的古老请求）。"""
    inserted = 0
    size = path.stat().st_size
    if size < offset:
        offset = 0  # 文件被重建
    if size == offset:
        return offset, 0
    start = offset
    if offset == 0 and size > TAIL_CAP:
        with open(path, "rb") as f:
            f.seek(size - TAIL_CAP)
            f.readline()          # 丢弃半行，对齐到下一行首
            start = f.tell()      # 二进制模式 tell 即绝对位置
    touched_turns = set()
    consumed = start
    with open(path, "rb") as f:
        f.seek(start)
        while True:
            line = f.readline()
            if not line:
                break
            if not line.endswith(b"\n"):
                break  # 半行：写完整前不动 offset
            consumed += len(line)
            s = line.decode("utf-8", "replace").strip()
            if not s:
                continue
            try:
                o = json.loads(s)
            except Exception:
                continue
            if o.get("type") != "model_io":
                continue
            rec = parse_record(o)
            if rec is None:
                continue
            upsert_session(con, rec)
            if insert_model_usage(con, rec):
                inserted += 1
                insert_tool_usage(con, rec)
                if rec["turn_id"]:
                    touched_turns.add((rec["sid"], rec["turn_id"]))
    for sid, turn in touched_turns:
        refresh_turn_usage(con, sid, turn)
    return consumed, inserted


def acquire_lock():
    if LOCK_PATH.exists():
        try:
            pid = int(LOCK_PATH.read_text().strip() or 0)
            os.kill(pid, 0)
            log(f"已有实例在跑 (pid {pid})，退出")
            sys.exit(0)
        except ValueError:
            pass  # 死锁文件，接管
        except OSError:
            pass  # Windows 下 pid 失效抛 WinError，视为无实例，接管
    LOCK_PATH.write_text(str(os.getpid()), encoding="utf-8")


def main():
    acquire_lock()
    con = None
    state = load_state()
    meta = {}
    total = 0
    cycle = 0
    log(f"桥接启动：rollout={ROLLOUT}  db={DB_PATH}")
    try:
        while True:
            if con is None:
                con = open_db_fresh()
                if con is None:
                    time.sleep(5)
                    continue
                meta = scan_agent_meta()
                if not state:
                    log("开始全量导入 rollout 历史…")
            if not ROLLOUT.exists():
                time.sleep(POLL_SEC)
                continue
            changed = 0
            live = set()
            for entry in ROLLOUT.iterdir():
                if not entry.name.startswith("model-io-") or not entry.name.endswith(".jsonl"):
                    continue
                if not entry.is_file():
                    continue
                live.add(entry.name)
                key = str(entry)
                ent = state.get(key) or {}
                try:
                    new_off, ins = process_file(con, entry, int(ent.get("offset", 0)), ent)
                except Exception as e:
                    import traceback
                    log(f"{entry.name} 处理失败: {e!r} {traceback.format_exc(limit=3)}")
                    continue
                if ent.get("offset") != new_off:
                    state[key] = {"offset": new_off, "mtime": entry.stat().st_mtime}
                    changed += 1
                    save_state(state)  # 每文件即存，中断后不重啃已导内容
                total += ins
            for key in [k for k in state if k not in live and "rollout" in k.lower().replace("\\", "/")]:
                del state[key]  # 源文件被清理
            cycle += 1
            if changed:
                con.commit()
            if cycle % 15 == 0:  # 约 30s 扫一次 agents 元数据，补父子关系
                meta = scan_agent_meta()
                if enrich_from_agent_meta(con, meta):
                    con.commit()
                save_state(state)
            time.sleep(POLL_SEC)
    except KeyboardInterrupt:
        pass
    finally:
        con.commit()
        save_state(state)
        con.close()
        try:
            LOCK_PATH.unlink()
        except OSError:
            pass
        log(f"退出，累计同步 {total} 条请求")


if __name__ == "__main__":
    main()
