"""Main LongMemEval headline sweep.

Runs (item × strategy × seed × budget) configurations:
- Phase B headline: 5 strategies × 120 items @ seed=42, budget=8k.
- Phase B seed=43 50-item subset for CI on same 5 strategies.
- Budget sweep: task_aware @ 4k and 16k on the 50-item subset.

Writes:
  mle/results/longmemeval_main.jsonl   (per-row: item, strategy, seed, budget, response, judge, etc.)
  mle/results/longmemeval_main_summary.json
  mle/results/main_sweep_verification.json
  mle/results/per_type_table.md
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from segments import Segment, flatten_longmemeval_history, total_tokens, count_tokens  # noqa
from llm_client import LLMClient, load_prices  # noqa
from compactors import STRATEGIES, CompactedHistory  # noqa
from judge import judge_one  # noqa


DEFAULT_DRIVER = "google/gemini-3-flash-preview"
DEFAULT_COMPACTOR = "google/gemini-3-flash-preview"
DEFAULT_JUDGE = "openai/gpt-4o-2024-08-06"
DEFAULT_BUDGET = 8000

DRIVER_SYSTEM = (
    "You are a helpful assistant. Use the conversation history below to answer "
    "the user's question. Be concise: respond with the direct answer in <=2 "
    "sentences. If the answer is not in the history, say so."
)


# ----------------------------------------------------------------------------- 
# Sampling
def stratified_sample(items, n, seed=42):
    rng = random.Random(seed)
    by_type = defaultdict(list)
    for it in items:
        by_type[it["question_type"]].append(it)
    total = len(items)
    raw = {qt: n * len(lst) / total for qt, lst in by_type.items()}
    base = {qt: int(math.floor(v)) for qt, v in raw.items()}
    rems = sorted(raw.items(), key=lambda kv: kv[1] - math.floor(kv[1]), reverse=True)
    deficit = n - sum(base.values())
    for i in range(deficit):
        base[rems[i][0]] += 1
    sampled = []
    for qt, q in base.items():
        pool = list(by_type[qt])
        rng.shuffle(pool)
        sampled.extend(pool[:q])
    rng.shuffle(sampled)
    return sampled


# -----------------------------------------------------------------------------
# Driver
async def driver_answer(llm, *, history_segments, question, driver_model,
                         experiment, item_id, strategy):
    msgs = [{"role": "system", "content": DRIVER_SYSTEM}]
    for s in history_segments:
        if s.role == "system":
            msgs.append({"role": "user", "content": f"[earlier system note] {s.content}"})
        else:
            msgs.append(s.to_chat())
    msgs.append({"role": "user", "content": question})
    res = await llm.complete(
        model=driver_model, messages=msgs,
        temperature=0.0, max_tokens=256,
        experiment=experiment, item_id=item_id,
        strategy=strategy, call_kind="driver",
    )
    return res.text.strip(), {
        "prompt_tokens": res.prompt_tokens,
        "completion_tokens": res.completion_tokens,
        "latency_s": res.latency_s,
        "cache_hit": res.cache_hit,
        "usd": res.usd,
    }


async def run_one(item, *, strategy, seed, budget, llm, experiment,
                   driver_model, compactor_model, judge_model):
    qid = item["question_id"]
    qtype = item["question_type"]
    history = flatten_longmemeval_history(
        item["haystack_sessions"],
        item.get("haystack_session_ids"),
        item.get("haystack_dates"),
    )
    orig_tokens = total_tokens(history)
    fn = STRATEGIES[strategy]
    t0 = time.time()
    compacted = await fn(
        history, item["question"], budget, llm,
        experiment=experiment, item_id=qid,
        compactor_model=compactor_model,
    )
    t_compact = time.time() - t0
    response, dstat = await driver_answer(
        llm, history_segments=compacted.segments,
        question=item["question"], driver_model=driver_model,
        experiment=experiment, item_id=qid, strategy=strategy,
    )
    abstention = "_abs" in qid
    label, judge_text = await judge_one(
        llm, task=qtype, question=item["question"], answer=item["answer"],
        response=response, question_id=qid, abstention=abstention,
        judge_model=judge_model, experiment=experiment, strategy=strategy,
    )
    return {
        "question_id": qid,
        "question_type": qtype,
        "strategy": strategy,
        "seed": seed,
        "budget": budget,
        "experiment": experiment,
        "original_tokens": orig_tokens,
        "compacted_tokens": compacted.compacted_tokens,
        "compact_time_s": t_compact,
        "driver_input_tokens": dstat["prompt_tokens"],
        "driver_output_tokens": dstat["completion_tokens"],
        "driver_latency_s": dstat["latency_s"],
        "driver_cache_hit": dstat["cache_hit"],
        "driver_usd": dstat["usd"],
        "response": response,
        "judge_label": bool(label),
        "judge_raw": judge_text,
        "abstention": abstention,
        "audit_summary": {
            "strategy": compacted.strategy,
            "audit_keys": list(compacted.audit.keys()) if compacted.audit else [],
            "fallbacks": compacted.audit.get("fallbacks", []) if isinstance(compacted.audit, dict) else [],
            "allocation": compacted.audit.get("allocation", {}) if isinstance(compacted.audit, dict) else {},
            "n_segments_kept": len(compacted.segments),
        },
    }


# -----------------------------------------------------------------------------
# Bootstrap CI + paired permutation
def bootstrap_ci(labels, n_resamples=10000, seed=0, alpha=0.05):
    if not labels:
        return (0.0, 0.0, 0.0)
    rng = random.Random(seed)
    n = len(labels)
    accs = []
    for _ in range(n_resamples):
        boot = [labels[rng.randint(0, n - 1)] for _ in range(n)]
        accs.append(sum(boot) / n)
    accs.sort()
    lo = accs[int(alpha / 2 * n_resamples)]
    hi = accs[int((1 - alpha / 2) * n_resamples)]
    return (sum(labels) / n, lo, hi)


def paired_perm_test(a_labels, b_labels, n_perms=10000, seed=0):
    """Two-sided paired permutation test on accuracy difference (a - b) across paired items.
       Each pair (a_i, b_i) is for the same item. Under null we may swap labels per pair.
    """
    if len(a_labels) != len(b_labels) or not a_labels:
        return None
    rng = random.Random(seed)
    n = len(a_labels)
    obs = sum(a_labels) / n - sum(b_labels) / n
    cnt = 0
    for _ in range(n_perms):
        s_a = 0
        s_b = 0
        for ai, bi in zip(a_labels, b_labels):
            if rng.random() < 0.5:
                s_a += bi
                s_b += ai
            else:
                s_a += ai
                s_b += bi
        d = s_a / n - s_b / n
        if abs(d) >= abs(obs) - 1e-12:
            cnt += 1
    return {"obs_delta": obs, "p_value": cnt / n_perms}


def percentile(xs, p):
    if not xs:
        return 0.0
    s = sorted(xs)
    k = max(0, int(round(p * (len(s) - 1))))
    return s[k]


# -----------------------------------------------------------------------------
# Main pipeline
async def amain(args):
    workdir = Path(args.workdir)
    data_path = workdir / "data" / "longmemeval" / "longmemeval_s.json"
    cache_dir = workdir / "cache"
    cost_log_path = workdir / "cost_log.jsonl"
    results_dir = workdir / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    load_prices(workdir / "openrouter_prices_snapshot.json")

    with open(data_path) as f:
        all_items = json.load(f)
    print(f"[main] loaded {len(all_items)} items")

    # Build samples
    sample_main = stratified_sample(all_items, args.n_main, seed=42)
    sample_subset = stratified_sample(all_items, args.n_subset, seed=43)
    print(f"[main] sample_main n={len(sample_main)} types={Counter(it['question_type'] for it in sample_main)}")
    print(f"[main] sample_subset(seed=43) n={len(sample_subset)} types={Counter(it['question_type'] for it in sample_subset)}")

    # Subset_A (the 50-item seed=42 sample) for Mem0
    subset_A = stratified_sample(all_items, args.n_mem0_subset, seed=42)
    print(f"[main] subset_A(seed=42, n={args.n_mem0_subset}) saved separately")
    with open(results_dir / "subset_A_ids.json", "w") as f:
        json.dump([it["question_id"] for it in subset_A], f)

    # Build work list
    strategies = ["full_context", "naive_truncation", "rolling_summary",
                  "type_aware", "task_aware"]

    work = []
    # 1) Phase B headline: 5 strategies × n_main @ seed=42, budget=8k
    for it in sample_main:
        for strat in strategies:
            work.append({
                "item": it, "strategy": strat, "seed": 42,
                "budget": DEFAULT_BUDGET, "experiment": "main_seed42_b8k",
            })
    # 2) Seed=43 50-item subset, all 5 strategies, budget 8k
    for it in sample_subset:
        for strat in strategies:
            work.append({
                "item": it, "strategy": strat, "seed": 43,
                "budget": DEFAULT_BUDGET, "experiment": "main_seed43_b8k",
            })
    # 3) Budget sweep for task_aware on seed=43 subset (saves cost)
    if args.run_budget_sweep:
        for it in sample_subset:
            for b in (4000, 16000):
                work.append({
                    "item": it, "strategy": "task_aware", "seed": 43,
                    "budget": b, "experiment": f"main_seed43_b{b}",
                })
    print(f"[main] total work units: {len(work)}")

    # ------- LLMClient
    llm = LLMClient(
        cache_dir=cache_dir, cost_log_path=cost_log_path,
        max_concurrency=args.concurrency,
    )

    # ------- per-row file
    out_path = results_dir / "longmemeval_main.jsonl"
    if not args.append:
        out_path.unlink(missing_ok=True)
    out_f = open(out_path, "a")

    sem = asyncio.Semaphore(args.concurrency)

    async def _runner(w):
        async with sem:
            try:
                r = await run_one(
                    w["item"], strategy=w["strategy"], seed=w["seed"],
                    budget=w["budget"], llm=llm,
                    experiment=w["experiment"],
                    driver_model=args.driver, compactor_model=args.compactor,
                    judge_model=args.judge,
                )
                return r
            except Exception as e:
                return {
                    "question_id": w["item"]["question_id"],
                    "strategy": w["strategy"], "seed": w["seed"], "budget": w["budget"],
                    "experiment": w["experiment"], "error": repr(e),
                }

    t0 = time.time()
    n_done = 0
    n_total = len(work)
    tasks = [asyncio.create_task(_runner(w)) for w in work]
    for fut in asyncio.as_completed(tasks):
        r = await fut
        n_done += 1
        out_f.write(json.dumps(r, default=str) + "\n")
        out_f.flush()

        # Budget check every 25 items
        if n_done % 25 == 0 or n_done == n_total:
            spend = sum_spend(cost_log_path, args.experiment_filter or [
                "main_seed42_b8k", "main_seed43_b8k", "main_seed43_b4000", "main_seed43_b16000"
            ])
            with open(workdir / "results" / "budget_check.jsonl", "a") as bf:
                bf.write(json.dumps({
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "n_done": n_done, "n_total": n_total,
                    "spend_main_only_usd": round(spend, 4),
                }) + "\n")
            print(f"[main] {n_done}/{n_total} done, main-only spend=${spend:.4f}")
            if spend > args.spend_halt_usd:
                print(f"[main] HALT: spend {spend:.4f} exceeds halt threshold {args.spend_halt_usd}")
                # Cancel remaining tasks
                for t in tasks:
                    if not t.done():
                        t.cancel()
                break

    out_f.close()
    print(f"[main] pipeline complete in {time.time()-t0:.1f}s")
    return 0


def sum_spend(cost_log_path: Path, experiments: list[str]) -> float:
    s = 0.0
    if not cost_log_path.exists():
        return 0.0
    exps = set(experiments)
    with open(cost_log_path) as f:
        for line in f:
            try:
                row = json.loads(line)
                if row.get("experiment") in exps:
                    s += float(row.get("usd", 0))
            except:
                pass
    return s


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--workdir", default="/workdir/compaction_policies__20260508_0231/mle")
    p.add_argument("--n-main", type=int, default=120)
    p.add_argument("--n-subset", type=int, default=50)
    p.add_argument("--n-mem0-subset", type=int, default=50)
    p.add_argument("--run-budget-sweep", action="store_true")
    p.add_argument("--driver", default=DEFAULT_DRIVER)
    p.add_argument("--compactor", default=DEFAULT_COMPACTOR)
    p.add_argument("--judge", default=DEFAULT_JUDGE)
    p.add_argument("--concurrency", type=int, default=8)
    p.add_argument("--spend-halt-usd", type=float, default=42.0,
                   help="halt main pipeline if main-only spend exceeds this")
    p.add_argument("--append", action="store_true")
    p.add_argument("--experiment-filter", nargs="*", default=None)
    args = p.parse_args()
    sys.exit(asyncio.run(amain(args)))


if __name__ == "__main__":
    main()
