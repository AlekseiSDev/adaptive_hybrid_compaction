"""Pooled paired permutation test: task_aware vs full_context across seed 42 (n=120) + seed 43 (n=50)."""
import json
import random
from pathlib import Path

random.seed(20260508)

ROWS = [json.loads(l) for l in open("mle/results/longmemeval_main.jsonl")]


def build_paired(seed: int, budget: int = 8000):
    fc = {r["question_id"]: int(bool(r["judge_label"]))
          for r in ROWS
          if r["strategy"] == "full_context" and r["seed"] == seed}
    ta = {r["question_id"]: int(bool(r["judge_label"]))
          for r in ROWS
          if r["strategy"] == "task_aware"
          and r["seed"] == seed
          and r.get("budget") == budget}
    common = sorted(fc.keys() & ta.keys())
    return [(qid, fc[qid], ta[qid]) for qid in common]


pairs_42 = build_paired(42, 8000)
pairs_43 = build_paired(43, 8000)
all_pairs = pairs_42 + pairs_43

n42 = len(pairs_42)
n43 = len(pairs_43)
n_pool = len(all_pairs)


def acc_delta(pairs):
    if not pairs:
        return 0.0
    fc_acc = sum(p[1] for p in pairs) / len(pairs)
    ta_acc = sum(p[2] for p in pairs) / len(pairs)
    return ta_acc - fc_acc


obs_delta_42 = acc_delta(pairs_42)
obs_delta_43 = acc_delta(pairs_43)
obs_delta_pool = acc_delta(all_pairs)

# Paired permutation test (sign-flip per pair) on pooled sample.
N_PERM = 10000


def perm_pvalue(pairs, n_perm=N_PERM):
    """Two-sided paired permutation: randomly swap each pair's labels, recompute delta."""
    if not pairs:
        return float("nan")
    obs = acc_delta(pairs)
    # diffs per pair: ta - fc in {-1, 0, +1}
    diffs = [p[2] - p[1] for p in pairs]
    # under H0 sign of each diff is exchangeable
    n = len(diffs)
    count_ge = 0
    for _ in range(n_perm):
        s = 0
        for d in diffs:
            if d == 0:
                continue
            s += d if random.random() < 0.5 else -d
        perm_delta = s / n
        if abs(perm_delta) >= abs(obs) - 1e-12:
            count_ge += 1
    return (count_ge + 1) / (n_perm + 1)


def bootstrap_ci(pairs, n_boot=10000, alpha=0.05):
    if not pairs:
        return (float("nan"), float("nan"))
    n = len(pairs)
    diffs = [p[2] - p[1] for p in pairs]
    deltas = []
    for _ in range(n_boot):
        idx = [random.randrange(n) for _ in range(n)]
        deltas.append(sum(diffs[i] for i in idx) / n)
    deltas.sort()
    lo = deltas[int(alpha / 2 * n_boot)]
    hi = deltas[int((1 - alpha / 2) * n_boot)]
    return (lo, hi)


p_42 = perm_pvalue(pairs_42)
p_43 = perm_pvalue(pairs_43)
p_pool = perm_pvalue(all_pairs)
ci_pool = bootstrap_ci(all_pairs)
ci_42 = bootstrap_ci(pairs_42)
ci_43 = bootstrap_ci(pairs_43)

# Also count effect sizes
def acc(pairs, idx):
    return sum(p[idx] for p in pairs) / len(pairs)


result = {
    "method": "paired permutation test (sign-flip), 10000 permutations; bootstrap 95% CI 10000 resamples",
    "comparison": "task_aware vs full_context (B=8000)",
    "seed_42": {
        "n": n42,
        "fc_accuracy": acc(pairs_42, 1) if pairs_42 else None,
        "ta_accuracy": acc(pairs_42, 2) if pairs_42 else None,
        "delta": obs_delta_42,
        "p_value": p_42,
        "bootstrap_ci_delta": list(ci_42),
    },
    "seed_43": {
        "n": n43,
        "fc_accuracy": acc(pairs_43, 1) if pairs_43 else None,
        "ta_accuracy": acc(pairs_43, 2) if pairs_43 else None,
        "delta": obs_delta_43,
        "p_value": p_43,
        "bootstrap_ci_delta": list(ci_43),
    },
    "pooled": {
        "n": n_pool,
        "fc_accuracy": acc(all_pairs, 1),
        "ta_accuracy": acc(all_pairs, 2),
        "delta": obs_delta_pool,
        "p_value": p_pool,
        "bootstrap_ci_delta": list(ci_pool),
    },
}

out = Path("mle/results/pooled_permutation_test.json")
out.write_text(json.dumps(result, indent=2))

print(json.dumps(result, indent=2))
