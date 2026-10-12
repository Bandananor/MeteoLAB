"""Surface-based CAPE and CIN of the real soundings in tests/fixtures/soundings with MetPy, straight from the files'
own levels (the reference for soundingfile.test.ts): the station level up, levels with pressure, temperature and dew
point; MetPy >= 1.4 applies the virtual-temperature correction itself."""
import json, sys
import numpy as np
import metpy.calc as mpcalc
from metpy.units import units


def wyoming(path):
    rows = []
    lines = open(path).read().splitlines()
    head = next(i for i, l in enumerate(lines) if l.strip().startswith('PRES'))
    for line in lines[head + 1:]:
        if not line.strip() or line.strip().startswith('-') or 'hPa' in line:
            continue
        f = [line[7 * k:7 * k + 7].strip() for k in range(4)]
        if all(f):
            rows.append([float(x) for x in f])
    return rows


def sharppy(path):
    rows, raw = [], False
    for line in open(path).read().splitlines():
        if '%RAW%' in line: raw = True; continue
        if '%END%' in line: break
        if raw:
            n = [float(x) for x in line.split(',')]
            if all(x > -9998 for x in n[:4]): rows.append(n[:4])
    return rows


out = {}
for name, reader in [('oun-2011-05-22-12z.txt', wyoming), ('oax-2014-06-16-19z.sharppy', sharppy)]:
    r = np.array(reader('tests/fixtures/soundings/' + name))
    p, t, td = r[:, 0] * units.hPa, r[:, 2] * units.degC, r[:, 3] * units.degC
    prof = mpcalc.parcel_profile(p, t[0], td[0])
    cape, cin = mpcalc.cape_cin(p, t, td, prof)
    out[name] = {'sbcape': round(float(cape.m), 1), 'sbcin': round(float(cin.m), 1), 'levels': len(r)}
json.dump(out, sys.stdout, indent=1)
