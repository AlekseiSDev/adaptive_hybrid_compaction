#!/usr/bin/env python3
"""Patch baked tau-bench retail tasks with `expected_end_state` field.

Phase D / S22 — fix for src/eval/adapters/tau-bench-retail/env.ts
`calculateReward()` returning 1.0 always because baked tasks lack
`expected_end_state` (upstream tau-bench tasks emit `actions` only;
our TS calculateReward needs the post-replay env state to compare).

For each `benchmarks/tau-bench/tasks/tau_retail_*.json`:
  1. Look up `task_idx` in the baked JSON.
  2. Spin up MockRetailDomainEnv(task_split='test', task_index=<idx>)
     — env.data is the initial state for this task.
  3. Replay `env.task.actions` against the env via tools_map (skipping
     terminate tools).
  4. Diff env.data["orders"] / env.data["users"] vs initial.
  5. Write the diff as `expected_end_state: {orders: {...}, users: {...}}`
     back into the baked JSON.

Run:
  source .venv-taubench/bin/activate
  python scripts/bake_tau_expected_states.py
"""

import copy
import glob
import json
import sys
from pathlib import Path

from tau_bench.envs.retail.env import MockRetailDomainEnv
from tau_bench.envs.user import UserStrategy

REPO = Path(__file__).resolve().parent.parent
TASKS_DIR = REPO / "benchmarks" / "tau-bench" / "tasks"


def _order_signature(o):
    """Subset matching what TS calculateReward inspects."""
    return {
        "status": o.get("status"),
        "items": [
            {"item_id": it.get("item_id")} for it in o.get("items", [])
        ],
    }


def _user_address_signature(u):
    a = u.get("address", {})
    return {
        "address": {
            "address1": a.get("address1"),
            "city": a.get("city"),
            "zip": a.get("zip"),
        }
    }


def replay_expected_state(task_idx: int):
    # HUMAN strategy doesn't require a model provider — we don't run the
    # user-sim here, just need the env state and task.actions.
    env = MockRetailDomainEnv(
        task_split="test",
        task_index=task_idx,
        user_strategy=UserStrategy.HUMAN,
    )
    initial_data = copy.deepcopy(env.data)

    # Replay expected actions. Use env.tools_map directly so we bypass user-
    # sim and just mutate env.data.
    for action in env.task.actions:
        if action.name in env.terminate_tools:
            continue
        if action.name not in env.tools_map:
            print(f"  WARN: unknown action {action.name}", file=sys.stderr)
            continue
        try:
            env.tools_map[action.name].invoke(data=env.data, **action.kwargs)
        except Exception as e:
            print(f"  WARN: action {action.name} raised {e}", file=sys.stderr)

    # Diff orders.
    orders_diff = {}
    for oid, order in env.data["orders"].items():
        if initial_data["orders"].get(oid) != order:
            orders_diff[oid] = _order_signature(order)

    # Diff users (address only — that's what our checker validates).
    users_diff = {}
    for uid, user in env.data["users"].items():
        if initial_data["users"].get(uid) != user:
            users_diff[uid] = _user_address_signature(user)

    return {"orders": orders_diff, "users": users_diff}


def main():
    files = sorted(glob.glob(str(TASKS_DIR / "tau_retail_*.json")))
    if not files:
        print(f"no tau_retail_*.json under {TASKS_DIR}", file=sys.stderr)
        sys.exit(1)
    print(f"[bake-tau-expected] processing {len(files)} tasks")
    for fpath in files:
        with open(fpath) as f:
            baked = json.load(f)
        task_idx = baked.get("task_idx")
        if task_idx is None:
            print(f"  SKIP (no task_idx): {fpath}", file=sys.stderr)
            continue
        expected = replay_expected_state(task_idx)
        baked["expected_end_state"] = expected
        with open(fpath, "w") as f:
            json.dump(baked, f, indent=2)
        n_orders = len(expected["orders"])
        n_users = len(expected["users"])
        print(f"  task_idx={task_idx}: expected_end_state = {n_orders} orders, {n_users} users")
    print("[bake-tau-expected] done")


if __name__ == "__main__":
    main()
