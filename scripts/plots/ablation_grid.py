#!/usr/bin/env python3
"""Ablation grid: 3 AHC configs (ahc_full, ahc_no_observer, ahc_no_offloader)
on 2 benches (assistant-traj, longmemeval-med), seed-pooled over 2 seeds.

Reads from benchmarks/runs/ablation_e2/. Deterministic output.
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
RUN_DIR = REPO_ROOT / "benchmarks" / "runs" / "ablation_e2"
OUT_DIR = REPO_ROOT / "report" / "figures"

CONFIG_ORDER = ["ahc_full", "ahc_no_observer", "ahc_no_offloader"]
BENCH_ORDER = ["assistant-traj", "longmemeval-med"]
LABELS = {
    "ahc_full": "ahc_full",
    "ahc_no_observer": "no_observer",
    "ahc_no_offloader": "no_offloader",
}
BENCH_LABELS = {"assistant-traj": "AT", "longmemeval-med": "LME (1-turn)"}
COLORS = {
    "ahc_full":         "#d62728",
    "ahc_no_observer":  "#ff9896",
    "ahc_no_offloader": "#fab27b",
}


def aggregate() -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for bench in BENCH_ORDER:
        bench_dir = RUN_DIR / bench
        if not bench_dir.exists():
            continue
        for cfg_hash_dir in sorted(bench_dir.iterdir()):
            if not cfg_hash_dir.is_dir():
                continue
            for seed_dir in sorted(cfg_hash_dir.iterdir()):
                if not seed_dir.is_dir():
                    continue
                summary = seed_dir / "summary.json"
                meta = seed_dir / "meta.json"
                if not (summary.exists() and meta.exists()):
                    continue
                m = json.loads(meta.read_text())
                s = json.loads(summary.read_text())
                cfg = m.get("config", {}).get("id", "?")
                out[bench][cfg].append(float(s["mean_primary_score"]))
    return {b: {c: sum(v) / len(v) for c, v in d.items() if v} for b, d in out.items()}


def main() -> int:
    data = aggregate()

    fig, ax = plt.subplots(figsize=(6.5, 4.0), constrained_layout=False)
    fig.subplots_adjust(left=0.12, right=0.98, top=0.90, bottom=0.18)

    n_b = len(BENCH_ORDER)
    n_c = len(CONFIG_ORDER)
    bar_w = 0.78 / n_c
    xs = list(range(n_b))

    for i, cfg in enumerate(CONFIG_ORDER):
        ys = [data.get(b, {}).get(cfg, 0.0) for b in BENCH_ORDER]
        positions = [x - 0.39 + (i + 0.5) * bar_w for x in xs]
        ax.bar(positions, ys, bar_w, label=LABELS[cfg], color=COLORS[cfg],
               edgecolor="black", linewidth=0.6, zorder=3)
        for px, py in zip(positions, ys):
            ax.text(px, py + 0.012, f"{py:.2f}", ha="center", va="bottom",
                    fontsize=8.5, color="#222")

    ax.set_xticks(xs)
    ax.set_xticklabels([BENCH_LABELS[b] for b in BENCH_ORDER])
    ax.set_ylabel("Mean accuracy (seed-pooled, n = 20)")
    ax.set_ylim(0, 0.75)
    ax.set_title("Ablation grid — observer / offloader removed from ahc_full")
    ax.grid(True, axis="y", alpha=0.3, linestyle="--", linewidth=0.5)
    ax.set_axisbelow(True)
    ax.legend(loc="upper left", fontsize=8.5, framealpha=0.95)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for ext in ("png", "pdf"):
        path = OUT_DIR / f"fig4_ablation_grid.{ext}"
        fig.savefig(path, dpi=200 if ext == "png" else None, bbox_inches=None)
        print(f"wrote {path}")
    plt.close(fig)
    return 0


if __name__ == "__main__":
    sys.exit(main())
