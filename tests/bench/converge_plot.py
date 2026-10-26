# Grid convergence figure and table (roadmap A2) from the JSON files of tests/bench/converge.ts:
#   py -3 -I tests/bench/converge_plot.py out.png res/c1.2.json res/c0.8.json … [-- res/w1.2.json …]
# Each group (separated by "--") is one scenario at several spacings: a column of panels per group, a row per quantity;
# the Markdown table (peaks, the 30-60 min means of the integral quantities, each against the finest grid) goes to stdout.
import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.stdout.reconfigure(encoding="utf-8")
out, args = sys.argv[1], sys.argv[2:]
groups, current = [], []
for a in args:
    if a == "--":
        groups.append(current)
        current = []
    else:
        current.append(a)
groups.append(current)
groups = [[json.load(open(p, encoding="utf-8")) for p in g] for g in groups if g]

QUANTITIES = [
    ("w", "max w, m/s", "peak"),
    ("uh", "max UH 2–5 km, m²/s²", "peak"),
    ("rainVolume", "rain on the ground, 10⁶ m³", "end"),
    ("echo40", "echo ≥ 40 dBZ, km²", "mean"),
    ("updraft10", "w ≥ 10 m/s at 5 km, km²", "mean"),
    ("pool2", "cold pool θ′ ≤ −2 K, km²", "mean"),
    ("coldPool", "cold pool deficit, K", "peak"),
    ("gust", "max gust, m/s", "peak"),
]


def value(run, key, kind):
    rows = run["rows"]
    if kind == "peak":
        return max(r[key] for r in rows)
    if kind == "end":
        return rows[-1][key]
    late = [r[key] for r in rows if r["t"] >= 30]
    return sum(late) / len(late)


fig, axes = plt.subplots(len(QUANTITIES), len(groups), figsize=(5.2 * len(groups), 2.1 * len(QUANTITIES)), sharex=True, squeeze=False)
for col, runs in enumerate(groups):
    runs.sort(key=lambda r: -r["spacing"])
    for row, (key, label, _) in enumerate(QUANTITIES):
        ax = axes[row][col]
        for k, run in enumerate(runs):
            shade = 0.15 + 0.85 * k / max(1, len(runs) - 1)
            ax.plot([r["t"] for r in run["rows"]], [r[key] for r in run["rows"]], color=plt.cm.Blues(shade), lw=1.6, label=f"{run['spacing']:.2f} km")
        ax.set_ylabel(label, fontsize=8)
        ax.tick_params(labelsize=7)
        ax.grid(alpha=0.3)
        if row == 0:
            ax.set_title(runs[0]["scenario"], fontsize=10)
            ax.legend(fontsize=7, frameon=False)
    axes[-1][col].set_xlabel("minutes", fontsize=8)
fig.tight_layout()
fig.savefig(out, dpi=130)

for runs in groups:
    finest = runs[-1]
    print(f"\n**{runs[0]['scenario']}** (single storm, 60 min; in brackets: against {finest['spacing']:.2f} km)\n")
    print("| | " + " | ".join(f"{r['spacing']:.2f} km" for r in runs) + " |")
    print("|---|" + "---|" * len(runs))
    for key, label, kind in QUANTITIES:
        ref = value(finest, key, kind)
        cells = []
        for r in runs:
            v = value(r, key, kind)
            cells.append(f"{v:.1f}" + ("" if r is finest or ref == 0 else f" ({100 * (v / ref - 1):+.0f} %)"))
        what = {"peak": "peak", "end": "at 60 min", "mean": "mean 30–60 min"}[kind]
        print(f"| {label}, {what} | " + " | ".join(cells) + " |")
    print("| compute, min | " + " | ".join(f"{r['seconds'] / 60:.0f}" for r in runs) + " |")
