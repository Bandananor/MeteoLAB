"""Plan views of a bow-echo run (tests/bench/bow.ts out=DIR): for each dump, the column's strongest reflectivity with the
gust front, the ground theta', and the system-relative wind at 2.5 km with w; and a table of the front's speed, the bow
and the rear inflow at 2.5 km. The front is found here again as bow.ts finds it (ground theta' <= -2 K followed east
from the row's coldest node across gaps of <= 2 nodes, a 5-row running median), its speed from the dumps 30 min apart,
so runs made before the bench's tracker was fixed read the same. Usage: py -3 -I maps.py DIR [OUT.png] [frame=22.5]"""
import glob, json, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.stdout.reconfigure(encoding="utf-8")
args = [a for a in sys.argv[1:] if "=" not in a]
frame = float(next((a[6:] for a in sys.argv[1:] if a.startswith("frame=")), 22.5))
folder = args[0]
target = args[1] if len(args) > 1 else f"{folder}/maps.png"
COLD, GAP, SMOOTH = 2, 2, 5


def gust_front(th):
    """x (nodes, unwrapped about the row's coldest node) of the gust front in each row, NaN without a cold pool."""
    ny, nx = th.shape
    raw = np.full(ny, np.nan)
    for y in range(ny):
        xs = np.where(th[y] <= -COLD)[0]
        if not len(xs):
            continue
        start = xs[np.argmin(th[y, xs])]
        rel = np.sort((xs - start + nx // 2) % nx - nx // 2)
        k = int(np.where(rel == 0)[0][0])
        while k + 1 < len(rel) and rel[k + 1] - rel[k] <= GAP + 1:
            k += 1
        raw[y] = start + rel[k]
    out = np.full(ny, np.nan)
    for y in range(ny):
        if not np.isnan(raw[y]):
            near = raw[max(0, y - SMOOTH // 2):y + SMOOTH // 2 + 1]
            out[y] = np.nanmedian(near)
    return out


dumps = []
for path in sorted(glob.glob(f"{folder}/bow-*.bin")):
    raw = open(path, "rb").read()
    cut = raw.index(b"\n")
    head = json.loads(raw[:cut])
    dbz, th, su, v, w = np.frombuffer(raw[cut + 1:], dtype=np.float32).reshape(5, head["ny"], head["nx"])
    # Ground-relative u back from the bench's system-relative one (it subtracted its own front speed, or nothing).
    fs = head["frontSpeed"]
    ground_u = su + (fs if fs is not None else frame)
    dumps.append(dict(head=head, dbz=dbz, th=th, u=ground_u, v=v, w=w, front=gust_front(th)))
if not dumps:
    sys.exit(f"no dumps in {folder}")

print("min  front km  speed m/s  bow km  rear inflow 2.5 km (5-40 km behind, middle third)  at the front (0-5 km)")
for k, d in enumerate(dumps):
    h, f = d["head"], d["front"]
    nx, ny, dx = h["nx"], h["ny"], h["dx"] / 1000
    rows = np.where(~np.isnan(f))[0]
    d["speed"] = np.nan
    if k and len(rows) > 4:
        p = dumps[k - 1]
        span = (h["t"] - p["head"]["t"]) * 60
        shift = (f - p["front"]) * dx * 1000 + frame * span
        width = nx * dx * 1000
        shift = shift - width * np.round((shift - frame * span) / width)
        lo, hi = rows[0] + len(rows) // 3, rows[0] + 2 * len(rows) // 3
        d["speed"] = float(np.nanmedian(shift[lo:hi + 1] / span))
    if len(rows) <= 4:
        continue
    lo, hi = rows[0] + len(rows) // 3, rows[0] + 2 * len(rows) // 3
    ends = np.r_[f[rows[0]:rows[0] + max(1, len(rows) * 15 // 100) + 1], f[rows[-1] - max(1, len(rows) * 15 // 100):rows[-1] + 1]]
    bow = (np.nanmean(f[lo:hi + 1]) - np.nanmean(ends)) * dx
    sys_u = d["u"] - (d["speed"] if not np.isnan(d["speed"]) else frame)
    best, lead = -np.inf, -np.inf
    for y in range(lo, hi + 1):
        if np.isnan(f[y]):
            continue
        for b in range(0, int(40 / dx) + 1):
            val = sys_u[y, int(f[y] - b) % nx]
            if b * dx >= 5:
                best = max(best, val)
            else:
                lead = max(lead, val)
    d["sys_u"] = sys_u
    print(f"{h['t']:3.0f}  {len(rows) * h['dy'] / 1000:8.0f}  {d['speed']:9.1f}  {bow:6.1f}  {best:46.1f}  {lead:20.1f}")

fig, axes = plt.subplots(len(dumps), 3, figsize=(13, 4.1 * len(dumps)), squeeze=False)
for row, d in zip(axes, dumps):
    head, dbz, th, v, w, front = d["head"], d["dbz"], d["th"], d["v"], d["w"], d["front"]
    nx, ny, dx, dy = head["nx"], head["ny"], head["dx"] / 1000, head["dy"] / 1000
    u = d.get("sys_u", d["u"] - frame)
    # Centre the plots on the front: roll x so the front's mean sits at 2/3 of the width.
    shift = 0 if np.all(np.isnan(front)) else int(round(2 * nx / 3 - np.nanmedian(front)))
    roll = lambda a: np.roll(a, shift, axis=1)
    x, y = np.arange(nx) * dx, np.arange(ny) * dy
    fx = (front + shift) % nx * dx
    ext = [0, nx * dx, 0, ny * dy]
    title = f"{head['t']:.0f} min, Us {head['us']} m/s / {head['depth'] / 1000:g} km, front {d['speed']:.1f} m/s"
    a = row[0].imshow(roll(dbz), origin="lower", extent=ext, cmap="turbo", vmin=0, vmax=70)
    row[0].plot(fx, y, "w-", lw=.8)
    row[0].set_title(f"{title}\ncolumn max dBZ", fontsize=9)
    fig.colorbar(a, ax=row[0], shrink=.8)
    b = row[1].imshow(roll(th), origin="lower", extent=ext, cmap="RdBu_r", vmin=-10, vmax=10)
    row[1].contour(x, y, roll(dbz), [40], colors="k", linewidths=.5)
    row[1].set_title("ground θ′, K (40 dBZ contour)", fontsize=9)
    fig.colorbar(b, ax=row[1], shrink=.8)
    c = row[2].imshow(roll(u), origin="lower", extent=ext, cmap="PuOr_r", vmin=-25, vmax=25)
    row[2].contour(x, y, roll(w), [5], colors="r", linewidths=.6)
    s = 4
    row[2].quiver(x[::s], y[::s], roll(u)[::s, ::s], roll(v)[::s, ::s], scale=600, width=.002)
    row[2].plot(fx, y, "k-", lw=.6)
    row[2].set_title("system-relative u at 2.5 km, m/s (w 5 m/s red)", fontsize=9)
    fig.colorbar(c, ax=row[2], shrink=.8)
    for ax in row:
        ax.set_xlabel("x, km")
        ax.set_aspect("equal")
fig.tight_layout()
fig.savefig(target, dpi=80)
print(target)
