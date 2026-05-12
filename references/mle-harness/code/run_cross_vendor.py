"""Cross-vendor Phase 4: 20-item LongMemEval subset with claude-haiku-4.5.

Sample seed=44 (different from subset_A) stratified across 6 question types.
Run 3 strategies (rolling_summary, type_aware, task_aware) with claude-haiku-4.5
as both driver and compactor. Judge stays gpt-4o-2024-08-06.

Then compute ranking transfer (Spearman + sign agreement) vs the
gemini-3-flash-preview ranking on the *same items*.

Output:
  mle/results/cross_vendor_main.jsonl   per (item, strategy, model)
  mle/results/cross_vendor_summary.json
"""
from __future__ import annotations
import asyncio, json, sys, os, time, math
from pathlib import Path
from collections import Counter, defaultdict
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from segments import flatten_longmemeval_history, total_tokens
from llm_client import LLMClient, load_prices
from compactors import STRATEGIES
from judge import judge_one
from run_main import stratified_sample, driver_answer, run_one, bootstrap_ci

WORKDIR = Path(__file__).resolve().parents[1]


async def amain(args):
    load_prices(WORKDIR / 'openrouter_prices_snapshot.json')
    with open(WORKDIR / 'data/longmemeval/longmemeval_s.json') as f:
        all_items = json.load(f)
    sub = stratified_sample(all_items, args.n, seed=44)
    print(f'cross_vendor sample seed=44 n={args.n} types={Counter(it["question_type"] for it in sub)}')
    ids = [it['question_id'] for it in sub]
    with open(WORKDIR / 'results/cross_vendor_subset_ids.json', 'w') as f:
        json.dump(ids, f)

    strategies = ['rolling_summary', 'type_aware', 'task_aware']
    drivers = ['anthropic/claude-haiku-4.5', 'google/gemini-3-flash-preview']

    out_path = WORKDIR / 'results/cross_vendor_main.jsonl'
    if not args.append:
        out_path.unlink(missing_ok=True)
    out_f = open(out_path, 'a')

    llm = LLMClient(cache_dir=WORKDIR/'cache', cost_log_path=WORKDIR/'cost_log.jsonl',
                    max_concurrency=args.concurrency)

    sem = asyncio.Semaphore(args.concurrency)
    work = []
    for it in sub:
        for strat in strategies:
            for drv in drivers:
                work.append((it, strat, drv))
    print(f'work units: {len(work)} = {len(sub)} items × {len(strategies)} strats × {len(drivers)} drivers')

    async def _runner(it, strat, drv):
        async with sem:
            try:
                r = await run_one(
                    it, strategy=strat, seed=44, budget=8000, llm=llm,
                    experiment=f'cross_vendor_{drv.split("/")[-1]}',
                    driver_model=drv, compactor_model=drv,
                    judge_model='openai/gpt-4o-2024-08-06',
                )
                r['driver_model'] = drv
                out_f.write(json.dumps(r, default=str) + '\n')
                out_f.flush()
                return r
            except Exception as e:
                print(f'  fail {it["question_id"]} {strat} {drv}: {e}')
                return None

    tasks = [_runner(it, strat, drv) for (it, strat, drv) in work]
    n_done = 0
    for fut in asyncio.as_completed(tasks):
        r = await fut
        n_done += 1
        if n_done % 10 == 0:
            print(f'  done {n_done}/{len(tasks)}')
    out_f.close()
    print(f'\nFinished {n_done}/{len(tasks)} runs')

    # Summarize
    rows = [json.loads(l) for l in open(out_path)]
    by_drv_strat = defaultdict(list)
    for r in rows:
        by_drv_strat[(r['driver_model'], r['strategy'])].append(r)

    summary = {}
    rankings = {}
    for drv in drivers:
        per = {}
        for strat in strategies:
            rs = by_drv_strat.get((drv, strat), [])
            if not rs:
                continue
            labels = [int(bool(r['judge_label'])) for r in rs]
            acc, lo, hi = bootstrap_ci(labels, n_resamples=2000, seed=0)
            per[strat] = {
                'n': len(rs), 'accuracy': round(acc, 4),
                'ci95_low': round(lo, 4), 'ci95_high': round(hi, 4),
                'mean_input_tokens': int(sum(r['driver_input_tokens'] for r in rs) / len(rs)),
                'mean_compacted_tokens': int(sum(r['compacted_tokens'] for r in rs) / len(rs)),
                'mean_driver_usd': sum(r['driver_usd'] for r in rs) / len(rs),
            }
        summary[drv] = per
        # Ranking by accuracy
        ranked = sorted(strategies, key=lambda s: -per.get(s, {}).get('accuracy', -1))
        rankings[drv] = ranked

    # Per-item paired sign-agreement: for each pair of strategies (s1, s2),
    # is the winner the same across drivers?
    pair_matches = 0
    pair_total = 0
    pairs = [(strategies[i], strategies[j]) for i in range(len(strategies)) for j in range(i+1, len(strategies))]
    for s1, s2 in pairs:
        a1 = summary[drivers[0]].get(s1, {}).get('accuracy', None)
        a2 = summary[drivers[0]].get(s2, {}).get('accuracy', None)
        b1 = summary[drivers[1]].get(s1, {}).get('accuracy', None)
        b2 = summary[drivers[1]].get(s2, {}).get('accuracy', None)
        if None in (a1, a2, b1, b2):
            continue
        sgn_a = 1 if a1 > a2 else (-1 if a1 < a2 else 0)
        sgn_b = 1 if b1 > b2 else (-1 if b1 < b2 else 0)
        if sgn_a == sgn_b:
            pair_matches += 1
        pair_total += 1

    # Spearman over the 3 strategies
    def spearman(rank_a, rank_b):
        # rank_a: ordered list of strategies, rank_b same
        idx_a = {s: i for i, s in enumerate(rank_a)}
        idx_b = {s: i for i, s in enumerate(rank_b)}
        n = len(rank_a)
        d2 = sum((idx_a[s] - idx_b[s]) ** 2 for s in rank_a)
        return 1 - (6 * d2) / (n * (n*n - 1))

    rho = spearman(rankings[drivers[0]], rankings[drivers[1]])

    transfer = {
        'rankings': {drv: rankings[drv] for drv in drivers},
        'pair_sign_agreement': pair_matches / pair_total if pair_total else None,
        'pair_total': pair_total,
        'pair_matches': pair_matches,
        'spearman_rho': rho,
    }

    with open(WORKDIR / 'results/cross_vendor_summary.json', 'w') as f:
        json.dump({'per_driver': summary, 'transfer': transfer}, f, indent=2)
    print('saved cross_vendor_summary.json')
    print(json.dumps({'per_driver': summary, 'transfer': transfer}, indent=2))


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--n', type=int, default=20)
    p.add_argument('--concurrency', type=int, default=4)
    p.add_argument('--append', action='store_true')
    args = p.parse_args()
    asyncio.run(amain(args))


if __name__ == '__main__':
    main()
