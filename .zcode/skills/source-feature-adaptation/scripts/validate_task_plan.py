#!/usr/bin/env python3
"""Validate dependency and exclusive write ownership of a proposed agent task plan.

Usage: python scripts/validate_task_plan.py path/to/task-plan.json
Does not spawn agents, mutate a repository, or execute task commands.
"""
import json
import posixpath
import sys
from pathlib import Path


def fail(msg):
    raise ValueError(msg)


def normalized_path(raw):
    if not isinstance(raw, str) or not raw.strip():
        fail("write scope must be a non-empty relative path")
    p = raw.strip().replace('\\', '/')
    if p.startswith('/') or p.startswith('~') or (len(p) >= 2 and p[1] == ':'):
        fail(f"write scope is not relative: {raw!r}")
    is_dir = p.endswith('/')
    parts = p.split('/')
    if any(v in ('..', '') for v in parts[:-1]) or any(v == '..' for v in parts):
        fail(f"unsafe write scope: {raw!r}")
    norm = posixpath.normpath(p)
    if norm in ('.', '..') or norm.startswith('../'):
        fail(f"unsafe write scope: {raw!r}")
    return norm, is_dir


def scopes_overlap(a, b):
    pa, da = a
    pb, db = b
    return pa == pb or (da and pb.startswith(pa + '/')) or (db and pa.startswith(pb + '/'))


def validate(plan):
    if not isinstance(plan, dict) or not isinstance(plan.get('tasks'), list) or not plan['tasks']:
        fail("plan must contain a non-empty tasks array")
    tasks = {}
    for task in plan['tasks']:
        if not isinstance(task, dict):
            fail("every task must be an object")
        task_id = task.get('id')
        if not isinstance(task_id, str) or not task_id.strip() or task_id in tasks:
            fail(f"missing/duplicate task id: {task_id!r}")
        mode = task.get('mode')
        if mode not in ('read', 'write'):
            fail(f"{task_id}: mode must be read or write")
        deps = task.get('depends_on', [])
        scopes = task.get('writes', [])
        if not isinstance(deps, list) or not all(isinstance(x, str) for x in deps):
            fail(f"{task_id}: depends_on must be string array")
        if not isinstance(scopes, list):
            fail(f"{task_id}: writes must be string array")
        if mode == 'read' and scopes:
            fail(f"{task_id}: read-only tasks cannot own write scopes")
        if mode == 'write' and not scopes:
            fail(f"{task_id}: write tasks must declare write scope")
        clean = [normalized_path(s) for s in scopes]
        for i, lhs in enumerate(clean):
            for rhs in clean[i + 1:]:
                if scopes_overlap(lhs, rhs):
                    fail(f"{task_id}: redundant or overlapping write scopes")
        tasks[task_id] = (deps, clean)

    ancestors = {}
    visiting = set()

    def get_ancestors(task_id):
        if task_id in ancestors:
            return ancestors[task_id]
        if task_id in visiting:
            fail(f"dependency cycle through {task_id}")
        visiting.add(task_id)
        result = set()
        for dep in tasks[task_id][0]:
            if dep not in tasks:
                fail(f"{task_id}: unknown dependency {dep}")
            result.add(dep)
            result.update(get_ancestors(dep))
        visiting.remove(task_id)
        ancestors[task_id] = result
        return result

    for tid in tasks:
        get_ancestors(tid)

    ids = list(tasks)
    for idx, a in enumerate(ids):
        for b in ids[idx + 1:]:
            if a in ancestors[b] or b in ancestors[a]:
                continue  # Tasks are ordered and cannot write concurrently.
            for pa in tasks[a][1]:
                for pb in tasks[b][1]:
                    if scopes_overlap(pa, pb):
                        fail(f"concurrent write conflict: {a} ({pa[0]}) vs {b} ({pb[0]})")
    return len(tasks), sum(bool(v[1]) for v in tasks.values())


def main():
    if len(sys.argv) != 2:
        print("Usage: python validate_task_plan.py TASK_PLAN.json", file=sys.stderr)
        return 2
    try:
        obj = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        count, writers = validate(obj)
    except (ValueError, OSError, json.JSONDecodeError) as e:
        print(f"INVALID: {e}", file=sys.stderr)
        return 1
    print(f"VALID: {count} tasks, {writers} writing tasks; dependencies and write scopes checked")
    return 0


if __name__ == '__main__':
    sys.exit(main())
