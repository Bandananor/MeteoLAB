"""Reference surface-based parcel diagnostics from MetPy for StormLab environment profiles.

The environment is built exactly as src/core/environment.ts defines it (piecewise-linear T(z) and RH(z)),
but pressure comes from hydrostatic integration with virtual temperature. The parcel is the "clean"
surface parcel: no +0.5 K excess, no entrainment, virtual-temperature correction on (SHARPpy convention).
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
    e = rh * mpcalc.saturation_vapor_pressure(t * units.degC).to('Pa').magnitude
    p = np.empty_like(z)
    p[0] = 101325.0
    for k in range(len(z) - 1):
        tv = [(t[j] + 273.15) * (1 + 0.61 * 0.622 * e[j] / (p[k] - e[j])) for j in (k, k + 1)]
        p[k + 1] = p[k] * np.exp(-9.80665 * dz / (287.05 * 0.5 * (tv[0] + tv[1])))
    P = p * units.Pa
    T = t * units.degC
    Td = mpcalc.dewpoint(e * units.Pa)
    r_env = mpcalc.mixing_ratio(e * units.Pa, P)
    parcel_t = mpcalc.parcel_profile(P, T[0], Td[0])
    lcl_p, _ = mpcalc.lcl(P[0], T[0], Td[0])
    r_surface = r_env[0]
    r_parcel = np.where(P > lcl_p, r_surface.magnitude, mpcalc.saturation_mixing_ratio(P, parcel_t).magnitude) * units('kg/kg')
    env_tv = mpcalc.virtual_temperature(T, r_env)
    parcel_tv = mpcalc.virtual_temperature(parcel_t, r_parcel)
    cape, cin = mpcalc.cape_cin(P, env_tv, Td, parcel_tv)
    lfc_p, _ = mpcalc.lfc(P, env_tv, Td, parcel_tv)
    el_p, _ = mpcalc.el(P, env_tv, Td, parcel_tv)
    to_km = lambda pp: None if np.isnan(pp.magnitude) else float(np.interp(-pp.to('Pa').magnitude, -p, z) / 1000)
    cape_dry, _ = mpcalc.cape_cin(P, T, Td, parcel_t)
    return dict(cape=round(float(cape.magnitude), 1), cin=round(float(cin.magnitude), 1),
                lcl=round(to_km(lcl_p), 3), lfc=None if to_km(lfc_p) is None else round(to_km(lfc_p), 3),
                el=None if to_km(el_p) is None else round(to_km(el_p), 3),
                capeWithoutVirtual=round(float(cape_dry.magnitude), 1),
                surfacePressureHydrostatic=101325.0, pressureAt10km=round(float(np.interp(10000, z, p)), 1))


out = {name: reference({**BASE, **over}) for name, over in PROFILES.items()}
print(json.dumps(out, indent=2, ensure_ascii=False))
