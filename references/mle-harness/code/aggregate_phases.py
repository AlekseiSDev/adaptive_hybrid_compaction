"""Aggregate Phase 1-4 results into pareto_data.json + all_phases_summary.md."""
from __future__ import annotations
import json, sys
from pathlib import Path
from collections import defaultdict, Counter
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from run_main import bootstrap_ci

WORKDIR = HERE.parent  # mle/
RESULTS = WORKDIR / 'results'


def aggregate_mem0():
    p = RESULTS / 'mem0_main.jsonl'
    if not p.exists() or p.stat().st_size == 0:
        return None
    rows = [json.loads(l) for l in open(p) if l.strip()]
    answers = [r for r in rows if r.get('phase') == 'answer' and 'judge_label' in r]
    if not answers:
        return None
    labels = [int(bool(r['judge_label'])) for r in answers]
    acc, lo, hi = bootstrap_ci(labels, n_resamples=2000, seed=0)

    # Mem0 cost: sum the proxy log + answer driver costs
    proxy_log = WORKDIR / 'cost_log_proxy.jsonl'
    proxy_total = 0.0
    if proxy_log.exists():
        for l in open(proxy_log):
            try:
                proxy_total += float(json.loads(l).get('usd', 0))
            except: pass

    answer_total = sum(r.get('driver_usd', 0) for r in answers)
    judge_total = 0.0
    cost_log = WORKDIR / 'cost_log.jsonl'
    if cost_log.exists():
        for l in open(cost_log):
            try:
                row = json.loads(l)
                if row.get('experiment') == 'mem0_answer' and row.get('call_kind') == 'judge':
                    judge_total += float(row.get('usd', 0))
            except: pass

    n_ingest = len([r for r in rows if r.get('phase') == 'ingest'])
    return {
        'n': len(answers),
        'n_ingest': n_ingest,
        'accuracy': round(acc, 4),
        'ci95_low': round(lo, 4), 'ci95_high': round(hi, 4),
        'mem0_ingest_proxy_usd_total': round(proxy_total, 4),
        'mem0_ingest_proxy_usd_per_item': round(proxy_total / max(1, n_ingest), 4),
        'mem0_answer_driver_usd_per_item': round(answer_total / max(1, len(answers)), 6),
        'mem0_answer_judge_usd_per_item': round(judge_total / max(1, len(answers)), 6),
        'total_usd_per_item': round(proxy_total / max(1, n_ingest) + answer_total / max(1, len(answers)) + judge_total / max(1, len(answers)), 4),
        'mean_n_memories_retrieved': sum(r.get('n_memories_used', 0) for r in answers) / max(1, len(answers)),
        'mean_retrieve_secs': sum(r.get('retrieve_secs', 0) for r in answers) / max(1, len(answers)),
    }


def aggregate_taubench():
    p = RESULTS / 'taubench_main.jsonl'
    if not p.exists() or p.stat().st_size == 0:
        return None
    rows = [json.loads(l) for l in open(p) if l.strip() and '"error"' not in l]
    if not rows:
        return None
    by_strat = defaultdict(list)
    for r in rows:
        if 'reward' in r:
            by_strat[r['strategy']].append(r)

    summary = {}
    for strat, rs in by_strat.items():
        rewards = [r['reward'] for r in rs]
        # Bootstrap CI on pass@1
        labels = [1 if r > 0 else 0 for r in rewards]
        acc, lo, hi = bootstrap_ci(labels, n_resamples=2000, seed=0)
        # also continuous reward mean
        m_reward = sum(rewards) / len(rewards)
        summary[strat] = {
            'n_episodes': len(rs),
            'pass_at_1': round(acc, 4),
            'pass_at_1_ci95_low': round(lo, 4),
            'pass_at_1_ci95_high': round(hi, 4),
            'mean_reward': round(m_reward, 4),
            'mean_n_steps': round(sum(r['n_steps'] for r in rs) / len(rs), 2),
            'mean_n_tool_calls': round(sum(r['n_tool_calls'] for r in rs) / len(rs), 2),
            'mean_litellm_usd': round(sum(r['total_cost_litellm_usd'] for r in rs) / len(rs), 4),
            'mean_max_orig_tokens': round(sum(r['compact_stats_summary']['max_original_tokens'] for r in rs) / len(rs), 0),
            'mean_compacted_tokens_per_step': round(sum(r['compact_stats_summary']['mean_compacted_tokens'] for r in rs) / len(rs), 0),
            'mean_wallclock_s': round(sum(r['wallclock_s'] for r in rs) / len(rs), 1),
        }
    return summary


def aggregate_cross_vendor():
    p = RESULTS / 'cross_vendor_summary.json'
    if p.exists():
        return json.load(open(p))
    return None


def aggregate_main():
    p = RESULTS / 'longmemeval_main_summary.json'
    if p.exists():
        s = json.load(open(p))
        return s
    return None


def head_to_head_mem0_vs_ours():
    """Compare Mem0 to each of our 5 strategies on the SAME items (intersect with subset_A_ids)."""
    mp = RESULTS / 'mem0_main.jsonl'
    main_p = RESULTS / 'longmemeval_main.jsonl'
    if not (mp.exists() and main_p.exists()):
        return None
    mem0_rows = [json.loads(l) for l in open(mp) if l.strip()]
    answers = {r['question_id']: r for r in mem0_rows if r.get('phase') == 'answer' and 'judge_label' in r}

    main_rows = [json.loads(l) for l in open(main_p) if l.strip()]
    # restrict main_rows to seed=42 and those item_ids
    common_ids = set(answers.keys())

    # Per-strategy table
    strategies = ['full_context', 'naive_truncation', 'rolling_summary', 'type_aware', 'task_aware']
    per = {}
    for strat in strategies:
        rs = [r for r in main_rows if r['strategy'] == strat and r['seed'] == 42 and r['question_id'] in common_ids]
        if not rs:
            continue
        labels = [int(bool(r['judge_label'])) for r in rs]
        acc, lo, hi = bootstrap_ci(labels, n_resamples=2000, seed=0)
        per[strat] = {
            'n': len(rs), 'accuracy': round(acc, 4),
            'ci95_low': round(lo, 4), 'ci95_high': round(hi, 4),
            'mean_input_tokens': int(sum(r['driver_input_tokens'] for r in rs) / len(rs)),
            'mean_driver_usd': round(sum(r['driver_usd'] for r in rs) / len(rs), 6),
        }
    # Mem0
    mem_labels = [int(bool(r['judge_label'])) for r in answers.values()]
    macc, mlo, mhi = bootstrap_ci(mem_labels, n_resamples=2000, seed=0)
    per_mem0 = {
        'n': len(mem_labels), 'accuracy': round(macc, 4),
        'ci95_low': round(mlo, 4), 'ci95_high': round(mhi, 4),
        'mean_input_tokens': int(sum(r.get('driver_input_tokens', 0) for r in answers.values()) / max(1, len(answers))),
        'mean_driver_usd': round(sum(r.get('driver_usd', 0) for r in answers.values()) / max(1, len(answers)), 6),
    }

    # Pairwise wins/losses/ties
    head_to_head = {}
    for strat in strategies:
        if strat not in per:
            continue
        # join on question_id
        ours_by_id = {r['question_id']: int(bool(r['judge_label'])) for r in main_rows if r['strategy'] == strat and r['seed'] == 42}
        wins = losses = ties = 0
        per_type = defaultdict(lambda: {'wins':0,'losses':0,'ties':0})
        for qid, m_row in answers.items():
            if qid not in ours_by_id:
                continue
            m_label = int(bool(m_row['judge_label']))
            o_label = ours_by_id[qid]
            qtype = m_row.get('question_type', '?')
            if m_label > o_label:
                wins += 1; per_type[qtype]['wins'] += 1
            elif m_label < o_label:
                losses += 1; per_type[qtype]['losses'] += 1
            else:
                ties += 1; per_type[qtype]['ties'] += 1
        head_to_head[f'mem0_vs_{strat}'] = {
            'wins': wins, 'losses': losses, 'ties': ties,
            'per_type': dict(per_type),
        }

    return {
        'mem0': per_mem0,
        'ours_on_same_items': per,
        'head_to_head': head_to_head,
        'common_items': len(common_ids),
    }


def build_pareto():
    main = aggregate_main()
    mem0 = aggregate_mem0()
    taubench = aggregate_taubench()
    cv = aggregate_cross_vendor()
    h2h = head_to_head_mem0_vs_ours()

    pareto = {
        'ours_longmemeval_main': [],
        'ours_taubench': [],
        'ours_cross_vendor_haiku': [],
        'ours_multimodal': [],
        'ours_locomo': [],
        'competitor_run_by_us_mem0': mem0,
        'mem0_vs_ours_same_items': h2h,
        'from_paper': [
            {"system": "Mem0 (paper claim, LongMemEval)", "longmemeval_overall": 0.934,
             "driver": "GPT-5-mini default in SDK", "usd_per_query": None,
             "source": "mem0.ai/research blog", "marker": "paper"},
            {"system": "Mastra OM (gpt-5-mini, LongMemEval)", "longmemeval_overall": 0.9487,
             "driver": "gpt-5-mini", "source": "mastra.ai blog", "marker": "paper"},
            {"system": "Emergence AI Internal", "longmemeval_overall": 0.86,
             "driver": "gpt-4o-2024-08-06", "source": "emergence.ai blog", "marker": "paper"},
            {"system": "Zep (Graphiti, LongMemEval)", "longmemeval_overall": 0.712,
             "driver": "gpt-4-turbo", "source": "arXiv 2501.13956", "marker": "paper"},
            {"system": "ChatGPT memory feature", "longmemeval_overall": 0.577,
             "driver": "gpt-4o", "source": "arXiv 2410.10813", "marker": "paper"},
            {"system": "LongMemEval RAG K=V+fact", "longmemeval_overall": 0.720,
             "driver": "gpt-4o", "source": "arXiv 2410.10813 Table 3", "marker": "paper"},
            {"system": "Oracle (full context, GPT-4o)", "longmemeval_overall": 0.918,
             "driver": "gpt-4o", "source": "arXiv 2410.10813 Fig 3a", "marker": "paper_oracle"},
        ],
    }

    if main and 'main_seed42_b8k' in main:
        for strat, st in main['main_seed42_b8k']['per_strategy'].items():
            pareto['ours_longmemeval_main'].append({
                'strategy': strat, 'n': st['n'], 'accuracy': st['accuracy'],
                'ci_low': st['ci95_low'], 'ci_high': st['ci95_high'],
                'input_tokens': st['mean_input_tokens'],
                'usd_per_query': st['mean_total_usd_per_query'],
                'marker': 'run', 'seed': 42, 'driver': 'google/gemini-3-flash-preview',
            })

    if taubench:
        for strat, st in taubench.items():
            pareto['ours_taubench'].append({
                'strategy': strat, 'n_episodes': st['n_episodes'],
                'pass_at_1': st['pass_at_1'],
                'ci_low': st['pass_at_1_ci95_low'], 'ci_high': st['pass_at_1_ci95_high'],
                'mean_reward': st['mean_reward'],
                'mean_n_steps': st['mean_n_steps'],
                'mean_n_tool_calls': st['mean_n_tool_calls'],
                'mean_litellm_usd': st['mean_litellm_usd'],
                'mean_compacted_tokens_per_step': st['mean_compacted_tokens_per_step'],
                'marker': 'run', 'seed': 42, 'driver': 'google/gemini-3-flash-preview',
                'domain': 'tau-bench retail',
            })

    if cv:
        for drv, per in cv.get('per_driver', {}).items():
            for strat, st in per.items():
                pareto['ours_cross_vendor_haiku'].append({
                    'driver': drv, 'strategy': strat, 'n': st['n'],
                    'accuracy': st['accuracy'], 'ci_low': st['ci95_low'], 'ci_high': st['ci95_high'],
                    'input_tokens': st['mean_input_tokens'],
                    'usd_per_query': st['mean_driver_usd'],
                    'marker': 'run', 'seed': 44,
                })
        pareto['cross_vendor_transfer'] = cv.get('transfer', {})

    return pareto


def write_summary_md(pareto):
    main = aggregate_main()
    mem0_h2h = pareto.get('mem0_vs_ours_same_items')
    cv = pareto.get('cross_vendor_transfer', {})
    tb = aggregate_taubench()

    lines = []
    lines.append("# Compaction policies — all phases summary")
    lines.append("")
    lines.append("## Phase B headline (LongMemEval, n=120, seed=42, gemini-3-flash-preview, gpt-4o judge)")
    lines.append("")
    lines.append("| strategy | n | accuracy | CI95 | mean input tokens | $/query | p_value vs full |")
    lines.append("|---|---|---|---|---|---|---|")
    if main and 'main_seed42_b8k' in main:
        for strat, st in main['main_seed42_b8k']['per_strategy'].items():
            pv = main['main_seed42_b8k']['paired_vs_full_context'].get(strat, {})
            pv_s = f"{pv.get('p_value','-')}" if pv else '—'
            lines.append(f"| {strat} | {st['n']} | {st['accuracy']:.2f} | [{st['ci95_low']:.2f},{st['ci95_high']:.2f}] | {st['mean_input_tokens']:,} | ${st['mean_total_usd_per_query']:.4f} | {pv_s} |")
    lines.append("")

    # Mem0 head-to-head
    if mem0_h2h and mem0_h2h.get('mem0'):
        lines.append("## Mem0 head-to-head (subset of subset_A — same items)")
        lines.append("")
        lines.append(f"Mem0 v{json.load(open(RESULTS / 'mem0_version.json')).get('mem0_version','?')}, "
                     f"qdrant in-process, embedder=BAAI/bge-small-en-v1.5, internal LLM=google/gemini-2.5-flash, "
                     f"driver=google/gemini-3-flash-preview, judge=gpt-4o-2024-08-06.  "
                     f"Common items={mem0_h2h.get('common_items')}.")
        lines.append("")
        lines.append("| system | n | accuracy | CI95 | input_tokens (driver) | $/query (driver only) |")
        lines.append("|---|---|---|---|---|---|")
        m = mem0_h2h['mem0']
        lines.append(f"| **Mem0** (ours run) | {m['n']} | {m['accuracy']:.2f} | [{m['ci95_low']:.2f},{m['ci95_high']:.2f}] | {m['mean_input_tokens']:,} | ${m['mean_driver_usd']:.4f} |")
        for strat, st in mem0_h2h['ours_on_same_items'].items():
            lines.append(f"| Ours/{strat} | {st['n']} | {st['accuracy']:.2f} | [{st['ci95_low']:.2f},{st['ci95_high']:.2f}] | {st['mean_input_tokens']:,} | ${st['mean_driver_usd']:.4f} |")
        lines.append("")
        lines.append("### Pairwise wins/losses/ties (Mem0 vs each ours strategy)")
        lines.append("")
        lines.append("| comparator | mem0 wins | mem0 loses | ties |")
        lines.append("|---|---|---|---|")
        for k, v in mem0_h2h['head_to_head'].items():
            lines.append(f"| {k} | {v['wins']} | {v['losses']} | {v['ties']} |")
        lines.append("")
        # Mem0 cost detail
        mem0_cost = pareto.get('competitor_run_by_us_mem0', {}) or {}
        if mem0_cost:
            lines.append(f"**Mem0 cost summary** (raw, our env): "
                         f"ingest=${mem0_cost.get('mem0_ingest_proxy_usd_per_item',0):.3f}/item × {mem0_cost.get('n_ingest',0)} ingests. "
                         f"answer driver+judge ≈ ${mem0_cost.get('mem0_answer_driver_usd_per_item',0)+mem0_cost.get('mem0_answer_judge_usd_per_item',0):.4f}/item. "
                         f"Total per-item if amortized over 1 query = "
                         f"${mem0_cost.get('total_usd_per_item',0):.3f}.")
            lines.append("")

    # τ-bench
    if tb:
        lines.append("## τ-bench (retail, sampled episodes, seed=42)")
        lines.append("")
        lines.append("| strategy | n | pass@1 | CI95 | mean steps | mean tool calls | mean $/episode | mean compacted_tokens/step |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for strat in ['rolling_summary','type_aware','task_aware']:
            if strat not in tb: continue
            st = tb[strat]
            lines.append(f"| {strat} | {st['n_episodes']} | {st['pass_at_1']:.2f} | [{st['pass_at_1_ci95_low']:.2f},{st['pass_at_1_ci95_high']:.2f}] | {st['mean_n_steps']:.1f} | {st['mean_n_tool_calls']:.1f} | ${st['mean_litellm_usd']:.4f} | {st['mean_compacted_tokens_per_step']:.0f} |")
        lines.append("")

    # Cross-vendor
    if cv:
        lines.append("## Cross-vendor (LongMemEval n=15 common items, seed=44)")
        lines.append("")
        lines.append(f"Pair sign-agreement: **{cv.get('pair_sign_agreement', 0):.2f}** ({cv.get('pair_matches',0)}/{cv.get('pair_total',0)})  ")
        lines.append(f"Spearman ρ: **{cv.get('spearman_rho', 0):.2f}**  ")
        lines.append("")
        lines.append("| driver | strategy | n | accuracy | CI95 | mean input | $/query |")
        lines.append("|---|---|---|---|---|---|---|")
        cv_full = json.load(open(RESULTS / 'cross_vendor_summary.json'))
        for drv, per in cv_full['per_driver'].items():
            for strat, st in per.items():
                lines.append(f"| {drv} | {strat} | {st['n']} | {st['accuracy']:.2f} | [{st['ci95_low']:.2f},{st['ci95_high']:.2f}] | {st['mean_input_tokens']:,} | ${st['mean_driver_usd']:.4f} |")
        lines.append("")

    return "\n".join(lines)


def main():
    pareto = build_pareto()
    out_p = RESULTS / 'pareto_data.json'
    json.dump(pareto, open(out_p, 'w'), indent=2)
    print(f'wrote {out_p}')

    md = write_summary_md(pareto)
    md_p = RESULTS / 'all_phases_summary.md'
    open(md_p, 'w').write(md)
    print(f'wrote {md_p}')
    print(md[:2000])


if __name__ == '__main__':
    main()
