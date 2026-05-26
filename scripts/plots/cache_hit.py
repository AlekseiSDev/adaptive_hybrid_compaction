#!/usr/bin/env python3
"""Cache-hit rate by (provider × bench × config). Aggregates cache_read /
total_input from records.ndjson across cells in P1 / P3 / P4 sweeps.

Reads:
- main_e1_text/longmemeval-med  (Phase D single-turn LME, ahc_full + others)
- main_e1_text_lme_mt/lme-multiturn  (P1 multi-turn LME on gpt-mini)
- cache_hit_e3/longmemeval-med  (P3 Anthropic-direct/Sonnet)
- main_e1_text_gemini/lme-multiturn  (P4 Gemini-direct)

Deterministic.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "report" / "figures"

# (label, run_dir, bench, config_id_filter)
SLOTS = [
    ("LME 1-t / gpt-mini / AHC",
     REPO_ROOT / "benchmarks/runs/main_e1_text/longmemeval-med",
     "ahc_full"),
    ("LME mult / gpt-mini / AHC",
     REPO_ROOT / "benchmarks/runs/main_e1_text_lme_mt/lme-multiturn",
     "ahc_full"),
    ("LME 1-t / Sonnet (LITELLM) / AHC",
     REPO_ROOT / "benchmarks/runs/cache_hit_e3/longmemeval-med",
     "ahc_full_anthropic"),
    ("LME mult / Gemini direct / AHC",
     REPO_ROOT / "benchmarks/runs/main_e1_text_gemini/lme-multiturn",
     "ahc_full_gemini"),
]


def find_cell(run_dir: Path, config_id: str) -> Path | None:
    if not run_dir.exists():
        return None
    for cfg_hash_dir in sorted(run_dir.iterdir()):
        if not cfg_hash_dir.is_dir():
            continue
        for seed_dir in sorted(cfg_hash_dir.iterdir()):
            meta = seed_dir / "meta.json"
            if not meta.exists():
                continue
            m = json.loads(meta.read_text())
            if m.get("config", {}).get("id") == config_id:
                return seed_dir
    return None


def cache_rate(cell_dir: Path) -> tuple[float, int, int] | None:
    ndjson = cell_dir / "records.ndjson"
    if not ndjson.exists():
        return None
    tot_in = 0
    tot_cache = 0
    n = 0
    for line in ndjson.read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        totals = rec.get("totals", {})
        tot_in += int(totals.get("input", 0))
        tot_cache += int(totals.get("cache_read", 0))
        n += 1
    if tot_in == 0:
        return None
    return tot_cache / tot_in, tot_in, n


def main() -> int:
    labels = []
    rates = []
    for label, run_dir, cfg in SLOTS:
        cell = find_cell(run_dir, cfg)
        if cell is None:
            print(f"skipping {label}: no cell", file=sys.stderr)
            continue
        result = cache_rate(cell)
        if result is None:
            print(f"skipping {label}: no data", file=sys.stderr)
            continue
        rate, tot, n = result
        labels.append(label)
        rates.append(rate)

    fig, ax = plt.subplots(figsize=(8.0, 3.8), constrained_layout=False)
    fig.subplots_adjust(left=0.32, right=0.97, top=0.92, bottom=0.12)

    ys = list(range(len(labels)))
    bars = ax.barh(ys, rates, color="#1f77b4", edgecolor="black", linewidth=0.6, zorder=3)
    for y, r in zip(ys, rates):
        ax.text(min(r + 0.015, 0.97), y, f"{r:.1%}", va="center", fontsize=9, color="#222")

    ax.axvline(0.60, linestyle="--", color="#d62728", linewidth=1.0, zorder=2)
    ax.text(0.602, len(labels) - 0.4, "target ≥ 60%", color="#d62728", fontsize=8.5)

    ax.set_yticks(ys)
    ax.set_yticklabels(labels, fontsize=9)
    ax.invert_yaxis()
    ax.set_xlim(0, 1.0)
    ax.set_xlabel("Cache hit rate (cache_read / total_input)")
    ax.set_title("Cache-hit rate by provider × bench (AHC configurations)")
    ax.grid(True, axis="x", alpha=0.3, linestyle="--", linewidth=0.5)
    ax.set_axisbelow(True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for ext in ("png", "pdf"):
        path = OUT_DIR / f"fig5_cache_hit.{ext}"
        fig.savefig(path, dpi=200 if ext == "png" else None, bbox_inches=None)
        print(f"wrote {path}")
    plt.close(fig)
    return 0


if __name__ == "__main__":
    sys.exit(main())
