#!/usr/bin/env python3
"""Pareto scatter of the AssistantTraj E1 cells (accuracy × cost-per-task).

Reads `benchmarks/runs/main_e1_text/assistant-traj/<config_hash>/<seed>/summary.json`
and `meta.json`, aggregates mean accuracy and mean cost-per-task across seeds per
configuration, and writes `report/figures/fig2_at_pareto.{png,pdf}`.

Deterministic: same inputs → byte-identical outputs (no time-based randomness,
fixed font, matplotlib's `figure.autolayout = False`).
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
RUN_DIR = REPO_ROOT / "benchmarks" / "runs" / "main_e1_text" / "assistant-traj"
OUT_DIR = REPO_ROOT / "report" / "figures"

COLORS = {
    "full_context": "#888888",
    "anthropic_compact": "#1f77b4",
    "mastra_om": "#2ca02c",
    "ahc_full": "#d62728",
}
MARKERS = {
    "full_context": "o",
    "anthropic_compact": "s",
    "mastra_om": "^",
    "ahc_full": "D",
}


def load_cell(cell_dir: Path) -> tuple[str, float, float] | None:
    summary = cell_dir / "summary.json"
    meta = cell_dir / "meta.json"
    if not summary.exists() or not meta.exists():
        return None
    s = json.loads(summary.read_text())
    m = json.loads(meta.read_text())
    config_id = m.get("config", {}).get("id", "?")
    accuracy = float(s["mean_primary_score"])
    n = int(s["n_total"])
    cost_per_task = float(s["total_cost_usd"]) / n if n else 0.0
    return config_id, accuracy, cost_per_task


def aggregate() -> dict[str, dict[str, float]]:
    by_config: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for cfg_hash_dir in sorted(RUN_DIR.iterdir()):
        if not cfg_hash_dir.is_dir():
            continue
        for seed_dir in sorted(cfg_hash_dir.iterdir()):
            if not seed_dir.is_dir():
                continue
            cell = load_cell(seed_dir)
            if cell is None:
                continue
            cfg_name, acc, cost = cell
            by_config[cfg_name].append((acc, cost))

    out: dict[str, dict[str, float]] = {}
    for cfg, rows in by_config.items():
        accs = [r[0] for r in rows]
        costs = [r[1] for r in rows]
        out[cfg] = {
            "mean_acc": sum(accs) / len(accs),
            "mean_cost": sum(costs) / len(costs),
            "n_seeds": len(rows),
        }
    return out


def main() -> int:
    data = aggregate()
    if not data:
        print("no cells found", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    fig, ax = plt.subplots(figsize=(6.0, 4.2), constrained_layout=False)
    fig.subplots_adjust(left=0.13, right=0.97, top=0.93, bottom=0.13)

    for cfg, agg in sorted(data.items()):
        color = COLORS.get(cfg, "#444444")
        marker = MARKERS.get(cfg, "x")
        ax.scatter(
            agg["mean_cost"],
            agg["mean_acc"],
            s=140,
            c=color,
            marker=marker,
            edgecolor="black",
            linewidth=0.8,
            label=cfg,
            zorder=3,
        )
        ax.annotate(
            cfg,
            (agg["mean_cost"], agg["mean_acc"]),
            xytext=(7, 6),
            textcoords="offset points",
            fontsize=9,
            color=color,
        )

    ax.set_xlabel("Cost per task (USD)")
    ax.set_ylabel("Mean accuracy (n = 30 × 2 seeds = 60)")
    ax.set_title("AssistantTraj — accuracy × cost (E1 main sweep)")
    ax.grid(True, alpha=0.3, linestyle="--", linewidth=0.5)
    ax.set_axisbelow(True)
    ax.set_xlim(left=0, right=max(d["mean_cost"] for d in data.values()) * 1.25)
    y_min = min(d["mean_acc"] for d in data.values())
    y_max = max(d["mean_acc"] for d in data.values())
    pad = max(0.02, (y_max - y_min) * 0.4)
    ax.set_ylim(y_min - pad, y_max + pad)

    for ext in ("png", "pdf"):
        path = OUT_DIR / f"fig2_at_pareto.{ext}"
        fig.savefig(path, dpi=200 if ext == "png" else None, bbox_inches=None)
        print(f"wrote {path}")
    plt.close(fig)
    return 0


if __name__ == "__main__":
    sys.exit(main())
