# The cold pool's budget figure (roadmap D2) from the JSON files of tests/bench/coldbudget.ts:
#   py -3 -I tests/bench/coldbudget_plot.py out.png label=run.json …
# One bar per run and region (under the rotation, the whole pool): the 30-60 min mean of each part of the ground air's
# θv deficit, cooling to the right, warming to the left; the dot is the deficit itself (the parts' sum).
import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.stdout.reconfigure(encoding="utf-8")
out, runs = sys.argv[1], [a.split("=", 1) for a in sys.argv[2:]]
PARTS = [
    ("origin", "air from aloft (dry descent)", "#9aa5b1"),
    ("evaporation", "rain evaporating", "#2f6db5"),
    ("graupel", "graupel (melting − riming)", "#7fb3e6"),
    ("hail", "hail (melting − riming)", "#b9d6f2"),
    ("snow", "snow", "#d8e8f7"),
    ("condensation", "cloud condensing / evaporating", "#e3a33b"),
    ("surface", "less heat from the ground", "#c96f3b"),
    ("vapour", "drier than the inflow (θv)", "#6aa57a"),
    ("other", "other", "#cccccc"),
]
bars = []
for label, path in runs:
    rows = [r for r in json.load(open(path, encoding="utf-8"))["rows"] if r["t"] >= 30]
    for region, name in (("rotation", "under the rotation"), ("pool", "whole pool")):
        have = [r[region] for r in rows if r[region]]
        bars.append((f"{label}\n{name}", {k: sum(h[k] for h in have) / len(have) for k in have[0]}))

fig, ax = plt.subplots(figsize=(9, 0.62 * len(bars) + 2.4))
for y, (_, v) in enumerate(bars):
    right = left = 0.0
    for key, name, colour in PARTS:
        x = v[key]
        if x >= 0:
            ax.barh(y, x, left=right, color=colour, label=name if y == 0 else None, height=0.62)
            right += x
        else:
            ax.barh(y, x, left=left, color=colour, label=name if y == 0 else None, height=0.62)
            left += x
    ax.plot(v["deficit"], y, "ko", ms=5)
    ax.text(right + 0.2, y, f"{v['deficit']:.1f} K", va="center", fontsize=8)
ax.set_yticks(range(len(bars)), [b[0] for b in bars], fontsize=8)
ax.invert_yaxis()
ax.axvline(0, color="k", lw=0.8)
ax.set_xlabel("θv deficit at the ground, K (30–60 min mean): cooling →, ← warming", fontsize=9)
ax.grid(axis="x", alpha=0.3)
ax.legend(fontsize=7, frameon=False, loc="upper center", bbox_to_anchor=(0.45, -0.1), ncol=3)
fig.tight_layout()
fig.savefig(out, dpi=130)
