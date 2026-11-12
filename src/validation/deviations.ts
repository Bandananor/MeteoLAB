/**
 * The catalogue of the model's known deviations from nature (roadmap A7): each one measured on a run, with the range
 * observed in nature and its source, the cause where it is known, and the roadmap item meant to fix it. The checks'
 * bounds are nature's range, so today they fail: the slow test (src/core/deviations.test.ts) marks each case it.fails —
 * it starts to pass, and vitest says so, when the fix works — and the validation report lists them apart from the cases
 * that must hold (tools/validate.ts). Deviations without a number to test (the supercell types, the tracker's splits,
 * the slow initiation by the sun) are listed in QUALITATIVE.
 */
import { AtmosphereModel, classifyEcho, DT, lowEcho, reflectivity, SCENARIOS, type SimConfig, type StratiformKind } from '../core'
import { ECHO_TOP_DBZ, VIL_MAX_DBZ } from '../core/ppi'
import { SUMMER_DAY } from '../core/fixtures'
import { environmentOf, withMoisture, withShear } from '../regime/grid'
import type { Check, ValidationCase } from './cases'
import { squallLine, type Threads } from './squall'

const INF = Infinity
const check = (quantity: string, unit: string, value: number, reference: string, bounds: readonly [number, number]): Check => ({ quantity, unit, value, reference, bounds })
const scenario = (name: string) => SCENARIOS.find(s => s.name === name)!.values

/** The radar view of a model state: per column the maximum reflectivity, VIL (Greene & Clark 1972) and MESH (Witt et al. 1998). */
export function radarColumns(m: AtmosphereModel) {
  const { nz, layer, zs, hz } = m.grid, e = m.env
  // The heights of 0 °C and -20 °C in the environment, for MESH's temperature weight.
  const tc = (z: number) => e.theta[z] * e.exner[z] - 273.15
  let h0 = 0, h20 = 0
  for (let z = 0; z < nz - 1; z++) {
    if (tc(z) >= 0 && tc(z + 1) < 0) h0 = zs[z] + (zs[z + 1] - zs[z]) * tc(z) / (tc(z) - tc(z + 1))
    if (tc(z) >= -20 && tc(z + 1) < -20) h20 = zs[z] + (zs[z + 1] - zs[z]) * (tc(z) + 20) / (tc(z) - tc(z + 1))
  }
  let maxDbz = 0, vil = 0, mesh = 0, top = 0
  for (let c = 0; c < layer; c++) {
    let colVil = 0, shi = 0
    for (let z = 0; z < nz; z++) {
      const i = c + z * layer
      if (m.rain[i] + m.snow[i] + m.graupel[i] + m.hail[i] < 1e-7) continue
      const d = reflectivity(e.rho[z], m.rain[i], m.snow[i], m.graupel[i], m.theta[i] * e.exner[z] - 273.15, m.hail[i])
      maxDbz = Math.max(maxDbz, d)
      if (d >= ECHO_TOP_DBZ) top = Math.max(top, zs[z])
      if (d > 0) colVil += 3.44e-6 * (10 ** (Math.min(d, VIL_MAX_DBZ) / 10)) ** (4 / 7) * hz[z]
      // SHI = 0.1 ∫ W_T(H) E dH above the melting level: E = 5e-6 10^(0.084 Z) W(Z), W from 0 at 40 dBZ to 1 at 50 dBZ.
      const wz = Math.min(1, Math.max(0, (d - 40) / 10)), wt = zs[z] <= h0 ? 0 : zs[z] >= h20 ? 1 : (zs[z] - h0) / (h20 - h0)
      shi += .1 * wt * 5e-6 * 10 ** (.084 * d) * wz * hz[z]
    }
    vil = Math.max(vil, colVil); mesh = Math.max(mesh, 2.54 * Math.sqrt(shi))
  }
  return { maxDbz, vil, mesh, top }
}

/** A run for `minutes` with the minute maxima the catalogue needs. */
export function deviationRun(config: SimConfig, minutes: number) {
  const m = new AtmosphereModel(config)
  let w = 0, dbz = 0, vil = 0, mesh = 0, hail = 0, outflowLow = 0, outflow = 0
  for (let t = DT; t <= minutes * 60 + 1e-6; t += DT) {
    m.step(DT); m.time += DT
    if (Math.round(m.time) % 60) continue
    const d = m.diagnostics(), r = radarColumns(m)
    w = Math.max(w, d.updraft); dbz = Math.max(dbz, r.maxDbz); vil = Math.max(vil, r.vil); mesh = Math.max(mesh, r.mesh); hail = Math.max(hail, d.hail)
    if (m.time >= 30 * 60) { outflowLow = Math.max(outflowLow, d.outflowLow); outflow = Math.max(outflow, d.outflow) }
  }
  const cg = m.flashes.filter(f => f.kind === 'CG'), positive = cg.filter(f => f.charge > 0).length
  return { w, dbz, vil, mesh, hail, outflowLow, outflow, cg: m.flashCount.cg, ic: m.flashCount.ic, positiveShare: cg.length ? positive / cg.length : NaN, model: m }
}

export const DEVIATIONS: (ValidationCase & { plan: string; cause: string })[] = [
  {
    id: 'supercell-microphysics', title: 'Classic supercell, 60 min: outflow, hail and lightning', minutes: 12, plan: 'B1, B2, B6',
    source: 'RFD θv′ at the ground: under ~2 K in strongly tornadic RFDs, ~4–7 K in nontornadic ones (Markowski, Straka & Rasmussen 2002, MWR 130, 1692, as quoted by later papers); SHIP > 1 — an environment favourable for hail ≥ 5 cm (SPC); +CG 8.7–10.6 % of ground flashes over the USA, regionally < 2 to > 25 % (Rudlosky & Fuelberg 2010, MWR 138, 3623; Orville et al. 2011, MWR 139, 1305)',
    cause: 'the outflow: rain evaporation with the fixed Marshall-Palmer N₀ gives 65–75 % of the cooling (D2; N₀ 1e6 would bring it to ~5 K); hail: single-moment, no size sorting or growth along trajectories; −CG: the graupel’s charging sign at −5…−15 °C (B6)',
    run() {
      const r = deviationRun({ ...SUMMER_DAY, ...scenario('Классическая суперячейка') }, 60)
      return { checks: [
        check('outflow θv deficit under the low-level rotation, max 30–60 min', 'K', r.outflowLow, '≲ 2 tornadic, 4–7 nontornadic RFDs', [0, 7]),
        check('largest hail at the ground', 'mm', r.hail, '≥ 50 favoured (SHIP > 1 here)', [50, INF]),
        check('share of positive ground flashes', '', r.positiveShare, '0.09–0.11 over the USA, regionally 0.02–0.25', [.02, .25]),
      ], note: `${r.cg} CG and ${r.ic} IC flashes; strongest updraught ${r.w.toFixed(1)} m/s; max reflectivity ${r.dbz.toFixed(0)} dBZ, VIL ${r.vil.toFixed(0)} kg/m², MESH ${r.mesh.toFixed(0)} mm; the largest outflow deficit anywhere ${r.outflow.toFixed(1)} K.` }
    },
  },
  {
    id: 'ordinary-graupel-core', title: 'Ordinary cell («Summer day»), 40 min: the graupel core', minutes: 6, plan: 'B1',
    source: 'ordinary (pulse) cells: core ~50–60 dBZ (a forecasters’ rule of thumb; no peer-reviewed typical maximum found yet)',
    cause: 'single-moment graupel with a fixed N₀ puts its mass in a few large particles (Z ∝ N₀^−¾); with it VIL and MESH run high',
    run() {
      const r = deviationRun({ ...SUMMER_DAY, ...scenario('Летний день') }, 40)
      return { checks: [
        check('max reflectivity of the cell', 'dBZ', r.dbz, '50–60', [50, 60]),
      ], note: `VIL ${r.vil.toFixed(0)} kg/m², MESH ${r.mesh.toFixed(0)} mm, strongest updraught ${r.w.toFixed(1)} m/s.` }
    },
  },
  {
    id: 'tropical-updraught', title: 'Tropical convection over the ocean, 40 min: the updraught', minutes: 8, plan: 'B3, B4',
    source: 'GATE oceanic cores: only 10 % have a mean w above 5 m/s (LeMone & Zipser 1980, JAS 37, 2444); TAMEX median under 3 m/s (Jorgensen & LeMone 1989, JAS 46, 621); peaks of 10–15 m/s rare (not verified)',
    cause: 'the sea’s heat flux is set by the sun as over land; the ~1 km grid; no boundary-layer scheme',
    run() {
      const r = deviationRun({ ...SUMMER_DAY, ...scenario('Тропическая конвекция') }, 40)
      return { checks: [check('strongest updraught', 'm/s', r.w, 'core means mostly < 5, peaks rarely 10–15', [0, 15])], note: `max reflectivity ${r.dbz.toFixed(0)} dBZ.` }
    },
  },
  {
    id: 'calm-high-cape', title: 'No shear, high CAPE (WK, moisture 1.1), 40 min: the updraught against parcel theory', minutes: 10, plan: 'A2, C1',
    source: 'about half of parcel theory’s √(2 CAPE) in ordinary convection (a textbook rule, e.g. Stull 2017, ch. 14; no measured ratio verified yet), more in supercells (Peters, Nowotarski & Morrison 2019, JAS 76, 3169)',
    cause: 'at 1.2 km entrainment is under-resolved (A2: the peak w still grows with resolution)',
    run() {
      const c = withShear(withMoisture({ ...SUMMER_DAY, ...scenario('Суперячейка WK') }, 1.1), 0), cape = environmentOf(c).cape
      const r = deviationRun(c, 40)
      return { checks: [check('strongest updraught / √(2 ML CAPE)', '', r.w / Math.sqrt(2 * cape), '0.5–0.6', [.5, .6])], note: `ML CAPE ${cape.toFixed(0)} J/kg, strongest updraught ${r.w.toFixed(1)} m/s.` }
    },
  },
]

/**
 * Long deviations (roadmap Э1 acceptance): like cases.ts LONG_CASES, hours on several threads, so they run only on request —
 * `npm run validate -- only=squall-line-coarse inner=6` or `long=1` — and not in the slow test.
 */
export const LONG_DEVIATIONS: (ValidationCase & { plan: string; cause: string })[] = [
  {
    id: 'squall-line-coarse', title: 'Squall line at 1.2 km, shear 20 m/s over 2.5 km (Weisman & Rotunno 2004 set-up), 4 h', minutes: 90, plan: 'Э1 (B1)',
    source: 'mature squall lines keep a cold pool with C 19–26 m/s for 6 h (Weisman & Rotunno 2004, Table 1b, at 1 km); linear MCSs have a stratiform region — trailing in 58 %, leading 19 %, parallel 23 % (Parker & Johnson 2000, MWR 128, 3413)',
    cause: 'single-moment graupel and snow fall out near the convective line instead of spreading rearward (12.11.2026: no stratiform at any sample of 2–4 h, while the line holds — C 22.6–28.1 m/s, mean 24.5; 108 min on 10 threads)',
    run(threads?: Threads) {
      const stratiform: StratiformKind[] = []
      const samples = squallLine({ us: 20, dx: 1.2, hours: 4 }, threads, (s, m) => {
        if (s.minutes < 120) return
        const g = m.grid, line = classifyEcho(lowEcho(m), g.nx, g.ny, g.dx / 1000, g.dy / 1000, [1, 0]).find(o => o.kind === 'line' || o.kind === 'bow')
        stratiform.push(line?.stratiform ?? 'none')
      })
      const late = samples.filter(s => s.minutes >= 120), fronts = late.flatMap(s => s.front ? [s.front] : [])
      const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN
      return { checks: [
        check('2–4 h: samples with a −1 K line-averaged cold pool', '', fronts.length / late.length, 'all (lines live 6 h)', [1, 1]),
        check('2–4 h: mean C (eq. 11, C² = −B min H)', 'm/s', mean(fronts.map(f => f.c)), '19–26', [19, 26]),
        check('2–4 h: share of samples whose line has a stratiform region', '', stratiform.filter(k => k !== 'none').length / Math.max(1, stratiform.length), 'most linear MCSs', [.5, 1]),
      ], note: `Every 30 min from 2 h: C ${fronts.map(f => f.c.toFixed(1)).join(', ')} m/s; stratiform ${stratiform.join(', ')}; rows with w ≥ 5 m/s at 3 km ${late.map(s => s.rows.toFixed(2)).join(', ')}; w max ${late.map(s => s.wMax.toFixed(0)).join(', ')} m/s.` }
    },
  },
]

/** Deviations with no number to test yet, each with what is known and the item meant to fix it. */
export const QUALITATIVE = [
  { title: 'LP / classic / HP supercells do not differ by environment', plan: 'B1', measured: 'tests/bench/sctype.ts: the same precipitation distribution in LP, classic and HP environments' },
  { title: 'The cell tracker’s splits are random', plan: 'A8', measured: '21.10.2026: none at 30 m/s straight shear, no pattern in other runs — the tracker against the vorticity fields' },
  { title: 'Initiation by the sun is slow at 1.2 km', plan: 'C1', measured: 'a 1.5 K cap with CIN ~10 J/kg holds because of the grid' },
  { title: 'A squall line at 1.2 km builds its cold pool late (first 2 h)', plan: 'Э1', measured: '10.11.2026, tests/bench/lines.ts us=20 dx=1.2: C 15 m/s at 60 min, 17 at 90, 24 at 120 (Weisman & Rotunno 2004: 19–26), the line filled over 30 → 68 % of its length; from 2 to 4 h it holds (LONG_DEVIATIONS squall-line-coarse, 12.11.2026)' },
  { title: 'Line-end vortices do not tell a bow from a plain line', plan: 'Э1', measured: '10.11.2026, tests/bench/organize.ts: the strongest node vorticity at 2.5 km near the ends is 4–11e-3 1/s on the cold front’s line (1.2 km) and 8–17e-3 on the bow echo (1 km), both signs at both ends; ORG.vortex 2e-3 passes every line — a circulation over an area is needed' },
  { title: 'A storm from a real sounding weakens 20–40 min after the nudging', plan: 'E10', measured: 'Omaha 68 → 8 m/s by 60 min; subsidence on the standard domain is only part of it' },
]
