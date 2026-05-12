"""Phase B: seed=43 50-item subset for confidence intervals + task_aware @ 4k budget sweep.
Reuses cache aggressively. Writes to longmemeval_main.jsonl (append).
"""
import asyncio, json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import argparse
import random, time
from datetime import datetime, timezone
from collections import Counter
from llm_client import LLMClient, load_prices
from run_main import stratified_sample, run_one, sum_spend


async def amain(args):
    workdir = Path(args.workdir)
    load_prices(workdir / "openrouter_prices_snapshot.json")
    with open(workdir / "data" / "longmemeval" / "longmemeval_s.json") as f:
        items = json.load(f)
    
    sample_subset = stratified_sample(items, 50, seed=43)
    print(f'sample(seed=43,n=50): types={Counter(it["question_type"] for it in sample_subset)}')
    strategies = ["full_context", "naive_truncation", "rolling_summary", "type_aware", "task_aware"]
    work = []
    for it in sample_subset:
        for st in strategies:
            work.append({"item": it, "strategy": st, "seed": 43, "budget": 8000, "experiment": "main_seed43_b8k"})
    # 4k budget sweep on task_aware (50 items)
    for it in sample_subset:
        work.append({"item": it, "strategy": "task_aware", "seed": 43, "budget": 4000, "experiment": "main_seed43_b4000"})
    # 16k budget sweep on task_aware — *with budget sweep optional*, only run if --do-16k
    if args.do_16k:
        for it in sample_subset:
            work.append({"item": it, "strategy": "task_aware", "seed": 43, "budget": 16000, "experiment": "main_seed43_b16000"})
    print(f'work units: {len(work)} (5*50 + 50 + {"50" if args.do_16k else "0"})')
    
    llm = LLMClient(cache_dir=workdir/"cache", cost_log_path=workdir/"cost_log.jsonl",
                    max_concurrency=args.concurrency)
    out_path = workdir / "results" / "longmemeval_main.jsonl"
    out_f = open(out_path, "a")
    sem = asyncio.Semaphore(args.concurrency)
    
    async def _runner(w):
        async with sem:
            try:
                return await run_one(
                    w["item"], strategy=w["strategy"], seed=w["seed"],
                    budget=w["budget"], llm=llm,
                    experiment=w["experiment"],
                    driver_model=args.driver, compactor_model=args.compactor,
                    judge_model=args.judge,
                )
            except Exception as e:
                return {"question_id": w["item"]["question_id"],
                        "strategy": w["strategy"], "seed": w["seed"], "budget": w["budget"],
                        "experiment": w["experiment"], "error": repr(e)}
    
    t0 = time.time()
    n_done = 0
    n_total = len(work)
    tasks = [asyncio.create_task(_runner(w)) for w in work]
    exps = ["main_seed43_b8k", "main_seed43_b4000", "main_seed43_b16000"]
    for fut in asyncio.as_completed(tasks):
        r = await fut
        n_done += 1
        out_f.write(json.dumps(r, default=str) + "\n"); out_f.flush()
        if n_done % 25 == 0 or n_done == n_total:
            spend = sum_spend(workdir/"cost_log.jsonl", exps)
            with open(workdir/"results"/"budget_check.jsonl", "a") as bf:
                bf.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(),
                                     "phase": "seed43+budgets",
                                     "n_done": n_done, "n_total": n_total,
                                     "spend_seed43_only_usd": round(spend,4)}) + "\n")
            print(f'  {n_done}/{n_total} done, seed43 spend=${spend:.4f}')
            if spend > args.spend_halt_usd:
                print(f'HALT: seed43 spend ${spend:.4f} > ${args.spend_halt_usd}')
                for t in tasks:
                    if not t.done(): t.cancel()
                break
    out_f.close()
    print(f'done in {time.time()-t0:.1f}s')


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--workdir", default="/workdir/compaction_policies__20260508_0231/mle")
    p.add_argument("--driver", default="google/gemini-3-flash-preview")
    p.add_argument("--compactor", default="google/gemini-3-flash-preview")
    p.add_argument("--judge", default="openai/gpt-4o-2024-08-06")
    p.add_argument("--concurrency", type=int, default=8)
    p.add_argument("--spend-halt-usd", type=float, default=14.0)
    p.add_argument("--do-16k", action="store_true")
    args = p.parse_args()
    asyncio.run(amain(args))


if __name__ == "__main__":
    main()
