#!/usr/bin/env python3
"""Static block diagram of the AHC pipeline: Tier-1 scratchpad → Tier-2 reflection
→ Tier-3 offload + classifier. Drawn from matplotlib primitives (no NDJSON input).

Deterministic: same code → byte-identical output.
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.patches as patches
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "report" / "figures"


def box(ax, x, y, w, h, label, sub, facecolor):
    rect = patches.FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.02,rounding_size=0.08",
        linewidth=1.2, edgecolor="black", facecolor=facecolor, zorder=2,
    )
    ax.add_patch(rect)
    ax.text(x + w / 2, y + h / 2 + 0.08, label,
            ha="center", va="center", fontsize=10.5, fontweight="bold")
    ax.text(x + w / 2, y + h / 2 - 0.14, sub,
            ha="center", va="center", fontsize=8, style="italic", color="#444")


def arrow(ax, x1, y1, x2, y2):
    ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle="-|>", lw=1.4, color="black"))


def main() -> int:
    fig, ax = plt.subplots(figsize=(8.0, 3.2), constrained_layout=False)
    fig.subplots_adjust(left=0.02, right=0.98, top=0.95, bottom=0.05)

    box(ax, 0.05, 0.55, 0.20, 0.30, "Tier-1",   "scratchpad",            "#cfe8ff")
    box(ax, 0.40, 0.55, 0.20, 0.30, "Tier-2",   "reflection (observer)", "#ffe0b3")
    box(ax, 0.75, 0.55, 0.20, 0.30, "Tier-3",   "offload + recall ptr",  "#d6f0c8")

    box(ax, 0.40, 0.10, 0.20, 0.22, "Classifier", "per-turn class signal", "#eee0ff")

    arrow(ax, 0.25, 0.70, 0.40, 0.70)
    arrow(ax, 0.60, 0.70, 0.75, 0.70)
    arrow(ax, 0.50, 0.55, 0.50, 0.32)
    arrow(ax, 0.60, 0.21, 0.85, 0.55)

    ax.text(0.32, 0.74, "size > T", fontsize=8, ha="center", color="#666")
    ax.text(0.67, 0.74, "Tier-2 full", fontsize=8, ha="center", color="#666")
    ax.text(0.51, 0.42, "guides", fontsize=8, ha="left", color="#666")

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for ext in ("png", "pdf"):
        path = OUT_DIR / f"fig1_pipeline.{ext}"
        fig.savefig(path, dpi=200 if ext == "png" else None, bbox_inches=None)
        print(f"wrote {path}")
    plt.close(fig)
    return 0


if __name__ == "__main__":
    sys.exit(main())
