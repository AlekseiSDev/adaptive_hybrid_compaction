#!/usr/bin/env python3
"""Cross-bench accuracy comparison: ahc_full vs full_context vs mastra_om vs
anthropic_compact across AT (single-turn), LoCoMo, LME single-turn, LME multi-turn.

Reads from benchmarks/runs/main_e1_text/ (Phase D single-turn) and
benchmarks/runs/main_e1_text_lme_mt/ (Phase H P1 multi-turn).

Deterministic: same inputs → byte-identical outputs.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "report" / "figures"

PHASE_D = REPO_ROOT / "benchmarks" / "runs" / "main_e1_text"
P1_LME_MT = REPO_ROOT / "benchmarks" / "runs" / "main_e1_text_lme_mt"

# Display order, column-major.
BENCHES = [
    ("AT",         PHASE_D / "assistant-traj"),
    ("LoCoMo",     PHASE_D / "locomo-med"),
    ("LME (1-t)",  PHASE_D / "longmemeval-med"),
    ("LME (mult)", P1_LME_MT / "lme-multiturn"),
]
CONFIGS = ["ahc_full", "full_context", "mastra_om", "anthropic_compact"]
COLORS = {
    "ahc_full":          "#d62728",
    "full_context":      "#888888",
    "mastra_om":         "#2ca02c",
    "anthropic_compact": "#1f77b4",
}


def load_cell(seed_dir: Path) -> tuple[str, float] | None:
    summary = seed_dir / "summary.json"
    meta = seed_dir / "meta.json"
    if not summary.exists() or not meta.exists():
        return None
    s = json.loads(summary.read_text())
    m = json.loads(meta.read_text())
    config_id = m.get("config", {}).get("id", "?")
    return config_id, float(s["mean_primary_score"])


def aggregate_bench(bench_dir: Path) -> dict[str, float]:
    by_cfg: dict[str, list[float]] = defaultdict(list)
    if not bench_dir.exists():
        return {}
    for cfg_hash_dir in sorted(bench_dir.iterdir()):
        if not cfg_hash_dir.is_dir():
            continue
        for seed_dir in sorted(cfg_hash_dir.iterdir()):
            if not seed_dir.is_dir():
                continue
            cell = load_cell(seed_dir)
            if cell is None:
                continue
            cfg, acc = cell
            by_cfg[cfg].append(acc)
    return {cfg: sum(v) / len(v) for cfg, v in by_cfg.items() if v}


def main() -> int:
    bench_data = [(label, aggregate_bench(bdir)) for label, bdir in BENCHES]

    fig, ax = plt.subplots(figsize=(7.5, 4.0), constrained_layout=False)
    fig.subplots_adjust(left=0.10, right=0.98, top=0.92, bottom=0.18)

    n_benches = len(BENCHES)
    n_cfg = len(CONFIGS)
    group_w = 0.78
    bar_w = group_w / n_cfg

    xs = list(range(n_benches))
    for i, cfg in enumerate(CONFIGS):
        ys = [bench_data[j][1].get(cfg, 0.0) for j in range(n_benches)]
        positions = [x - group_w / 2 + (i + 0.5) * bar_w for x in xs]
        ax.bar(positions, ys, bar_w, label=cfg, color=COLORS[cfg],
               edgecolor="black", linewidth=0.6, zorder=3)

    ax.set_xticks(xs)
    ax.set_xticklabels([b[0] for b in BENCHES])
    ax.set_ylabel("Mean accuracy")
    ax.set_ylim(0, 0.75)
    ax.set_title("Accuracy across benches — AHC vs baselines")
    ax.grid(True, axis="y", alpha=0.3, linestyle="--", linewidth=0.5)
    ax.set_axisbelow(True)
    ax.legend(loc="upper right", fontsize=8, framealpha=0.95)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for ext in ("png", "pdf"):
        path = OUT_DIR / f"fig3_cross_bench_acc.{ext}"
        fig.savefig(path, dpi=200 if ext == "png" else None, bbox_inches=None)
        print(f"wrote {path}")
    plt.close(fig)
    return 0


if __name__ == "__main__":
    sys.exit(main())
