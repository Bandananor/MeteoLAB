"""Reference surface-based parcel diagnostics from MetPy for StormLab environment profiles.

The environment is built exactly as src/core/environment.ts defines it (piecewise-linear T(z) and RH(z)),
with pressure from hydrostatic integration with virtual temperature. The parcel is the "clean" surface
parcel: no +0.5 K excess, no entrainment, virtual-temperature correction on (SHARPpy convention).

Note: MetPy >= 1.4 applies the virtual-temperature correction inside cape_cin, so it must be given plain
temperatures. (The first version of this script passed virtual temperatures and got the correction twice:
CIN of the capped profile came out as 59 instead of 124 J/kg.) LFC and EL are found on virtual temperatures,
as cape_cin does internally.
"""
import json
import numpy as np
import metpy.calc as mpcalc
from metpy.units import units

BASE = dict(surfaceTemp=30, lapseLow=8.4, lapseMid=7.2, lapseUpper=6.5, tropopause=11, stratoWarming=1.2,
            rhSurface=72, rhLow=60, rhMid=42, rhUpper=28)
PROFILES = {
    'summer': {},
    'supercell': dict(surfaceTemp=29, rhSurface=72, rhLow=60, rhMid=38, rhUpper=30, lapseLow=7.2, lapseMid=6.8, lapseUpper=6.5),
    'capped': dict(surfaceTemp=28, rhSurface=62, rhLow=50, rhMid=40, rhUpper=30, lapseLow=6.0, lapseMid=7.5, lapseUpper=6.5),
}


def lerp(a, b, t):
    return a + (b - a) * min(1.0, max(0.0, t))


def temperature(z, c):
    tp = c['tropopause'] * 1000
    t3 = c['surfaceTemp'] - c['lapseLow'] * 3
    t8 = t3 - c['lapseMid'] * 5
    if z <= 3000: return c['surfaceTemp'] - c['lapseLow'] * z / 1000
    if z <= 8000: return t3 - c['lapseMid'] * (z - 3000) / 1000
    ttp = t8 - c['lapseUpper'] * (tp - 8000) / 1000
    if z <= tp: return t8 - c['lapseUpper'] * (z - 8000) / 1000
    return ttp + c['stratoWarming'] * (z - tp) / 1000


def rel_humidity(z, c):
    tp = c['tropopause'] * 1000
    if z < 1500: return lerp(c['rhSurface'], c['rhLow'], z / 1500) / 100
    if z < 5000: return lerp(c['rhLow'], c['rhMid'], (z - 1500) / 3500) / 100
    if z < tp: return lerp(c['rhMid'], c['rhUpper'], (z - 5000) / max(1000, tp - 5000)) / 100
    return c['rhUpper'] / 100 * .7


def reference(c):
    dz = 25.0
    z = np.arange(0, 15000 + dz, dz)
    t = np.array([temperature(h, c) for h in z])
    rh = np.array([rel_humidity(h, c) for h in z])
    es = mpcalc.saturation_vapor_pressure(t * units.degC).to('Pa').magnitude
    # StormLab defines relative humidity as a ratio of mixing ratios (WMO): r = RH * r_s(T, p).
    p = np.empty_like(z)
    p[0] = 101325.0
    r = np.empty_like(z)
    for k in range(len(z)):
        r[k] = rh[k] * 0.622 * es[k] / (p[k] - es[k])
        if k + 1 < len(z):
            r_next = rh[k + 1] * 0.622 * es[k + 1] / (p[k] - es[k + 1])
            tv = [(t[k] + 273.15) * (1 + 0.61 * r[k]), (t[k + 1] + 273.15) * (1 + 0.61 * r_next)]
            p[k + 1] = p[k] * np.exp(-9.80665 * dz / (287.05 * 0.5 * (tv[0] + tv[1])))
    P = p * units.Pa
    T = t * units.degC
    r_env = r * units('kg/kg')
    Td = mpcalc.dewpoint(mpcalc.vapor_pressure(P, r_env))
    parcel_t = mpcalc.parcel_profile(P, T[0], Td[0])
    lcl_p, _ = mpcalc.lcl(P[0], T[0], Td[0])
    r_surface = r_env[0]
    r_parcel = np.where(P > lcl_p, r_surface.magnitude, mpcalc.saturation_mixing_ratio(P, parcel_t).magnitude) * units('kg/kg')
    env_tv = mpcalc.virtual_temperature(T, r_env)
    parcel_tv = mpcalc.virtual_temperature(parcel_t, r_parcel)
    cape, cin = mpcalc.cape_cin(P, T, Td, parcel_t)
    lfc_p, _ = mpcalc.lfc(P, env_tv, Td, parcel_tv)
    el_p, _ = mpcalc.el(P, env_tv, Td, parcel_tv)
    to_km = lambda pp: None if np.isnan(pp.magnitude) else float(np.interp(-pp.to('Pa').magnitude, -p, z) / 1000)
    ml_cape, ml_cin = mpcalc.mixed_layer_cape_cin(P, T, Td, depth=100 * units.hPa)
    mu_cape, mu_cin = mpcalc.most_unstable_cape_cin(P, T, Td, depth=300 * units.hPa)
    # downdraft_cape selects its 700-500 hPa layer correctly only with pressure in hPa (NaN with Pa in MetPy 1.7.1).
    dcape, _, _ = mpcalc.downdraft_cape(P.to('hPa'), T, Td)
    r1 = lambda q: round(float(np.ravel(q.magnitude)[0]), 1)
    return dict(cape=round(float(cape.magnitude), 1), cin=round(float(cin.magnitude), 1),
                lcl=round(to_km(lcl_p), 3), lfc=None if to_km(lfc_p) is None else round(to_km(lfc_p), 3),
                el=None if to_km(el_p) is None else round(to_km(el_p), 3),
                pressureAt10km=round(float(np.interp(10000, z, p)), 1),
                mlcape=r1(ml_cape), mlcin=r1(ml_cin), mucape=r1(mu_cape), mucin=r1(mu_cin), dcape=r1(dcape))


out = {name: reference({**BASE, **over}) for name, over in PROFILES.items()}
print(json.dumps(out, indent=2, ensure_ascii=False))
