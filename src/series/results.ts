/**
 * A series' results (roadmap E3) as files: the table (one row per finished run: the version, seed and link, the
 * knobs' values, the environment, the regime and the highlights) and one NetCDF file with every finished run's course
 * (the domain's strongest values each minute) and swaths on the ground, the series file in its attributes.
 */
import type { MemberResult } from '../ensemble/member'
import { memberPeaks } from '../ensemble/combine'
import { regimeOf, type Regime } from '../regime/grid'
import { stampColumns } from '../export/stamp'
import { writeNetCDF, type NcVariable } from '../export/netcdf'
import { toCsv } from '../share'
import type { SeriesRun } from './series'

/** The regimes as numbers in the NetCDF (CF flag_values). */
const REGIMES: Regime[] = ['none', 'ordinary', 'multicell', 'supercell']

/** The finished runs with their results, in the series' order. */
const finished = (runs: readonly SeriesRun[], results: readonly (MemberResult | null)[]) => runs.flatMap(run => { const r = results[run.index]; return r ? [{ run, r, p: memberPeaks(r) }] : [] })

export function seriesCsv(knobs: readonly string[], runs: readonly SeriesRun[], results: readonly (MemberResult | null)[]) {
  const rows = finished(runs, results)
  return toCsv(rows, [
    ...stampColumns<(typeof rows)[number]>(x => x.run.seed, x => x.run.config), ['run', x => x.run.index],
    ...knobs.map(k => [k, (x: (typeof rows)[number]) => x.run.params[k]] as [string, (x: (typeof rows)[number]) => number]),
    ['env_ml_cape_jkg', x => x.run.cape], ['env_shear_0_6km_ms', x => x.run.shear], ['env_srh_0_3km_m2s2', x => x.run.srh], ['regime', x => regimeOf(x.r, x.p)],
    ['max_updraft_ms', x => x.p.updraft], ['max_uh_2_5km_m2s2', x => x.p.uh], ['max_rain_rate_mmh', x => x.p.rain], ['max_rain_total_mm', x => x.p.rainTotal],
    ['max_surface_wind_ms', x => x.p.gust], ['max_hail_mm', x => x.p.hail], ['max_flashes_per_min', x => x.p.flashes], ['mesocyclone_from_s', x => x.p.mesocyclone ?? ''],
    ['max_outflow_K', x => x.p.outflow], ['max_outflow_rotation_K', x => x.p.outflowLow],
  ])
}

export interface SeriesMeta { name: string; version: string; text: string }

/** The NetCDF of the finished runs (dimensions run, time, y, x); null when none has finished. */
export function seriesNetCDF(knobs: readonly string[], runs: readonly SeriesRun[], results: readonly (MemberResult | null)[], meta: SeriesMeta) {
  const rows = finished(runs, results)
  if (!rows.length) return null
  const first = rows[0].r, { nx, ny } = first, n = rows.length, nt = Math.max(...rows.map(x => x.r.samples.length))
  const times = (rows.find(x => x.r.samples.length === nt) ?? rows[0]).r.samples.map(s => s.t)
  const perRun = (name: string, f: (x: (typeof rows)[number]) => number, attrs: Record<string, string | number | number[]>, type: 'double' | 'int' = 'double'): NcVariable => ({ name, dims: ['run'], type, data: rows.map(f), attrs })
  // The runs' seed, knobs and environment as auxiliary coordinates (CF): xarray keeps them with every field (plot against a knob, select by it).
  const coordinates = ['seed', ...knobs, 'env_ml_cape', 'env_shear_0_6km', 'env_srh_0_3km', 'regime'].join(' ')
  const course = (name: string, key: 'updraft' | 'uh' | 'rain' | 'gust' | 'hail' | 'flashes', attrs: Record<string, string>): NcVariable => {
    // A shorter course ends in NaN.
    const data = new Float32Array(n * nt).fill(NaN)
    rows.forEach((x, k) => x.r.samples.forEach((s, t) => { data[k * nt + t] = s[key] }))
    return { name, dims: ['run', 'time'], type: 'float', data, attrs: { ...attrs, coordinates } }
  }
  const swath = (name: string, key: 'rainTotal' | 'hailSize' | 'gustMax' | 'uhMax', attrs: Record<string, string>): NcVariable => {
    const data = new Float32Array(n * ny * nx)
    // A run on another ground grid (the domain varied) would not fit: its swath stays empty.
    rows.forEach((x, k) => { if (x.r.nx === nx && x.r.ny === ny) data.set(x.r[key], k * nx * ny) })
    return { name, dims: ['run', 'y', 'x'], type: 'float', data, attrs: { ...attrs, coordinates } }
  }
  return writeNetCDF({
    dims: { run: n, time: nt, y: ny, x: nx },
    attrs: {
      Conventions: 'CF-1.8',
      title: `MeteoLab StormLab series: ${meta.name}`,
      institution: 'MeteoLab (https://bandananor.github.io/MeteoLAB/)',
      source: `MeteoLab StormLab ${meta.version}: anelastic non-hydrostatic cloud model`,
      comment: 'Every run of the series that finished. The course is the domain’s strongest value at each time; the swaths are per ground column (the ground under the domain, which follows the storm). The series file is in series_json; each run’s settings follow from it (the knobs’ values and the seed).',
      series_json: meta.text,
    },
    vars: [
      { name: 'time', dims: ['time'], type: 'double', data: times, attrs: { units: 's', long_name: 'model time since the start of the run', axis: 'T' } },
      { name: 'y', dims: ['y'], type: 'float', data: Float32Array.from({ length: ny }, (_, j) => j * first.depth / ny), attrs: { units: 'm', long_name: 'south-north distance on the ground', axis: 'Y' } },
      { name: 'x', dims: ['x'], type: 'float', data: Float32Array.from({ length: nx }, (_, i) => i * first.width / nx), attrs: { units: 'm', long_name: 'west-east distance on the ground', axis: 'X' } },
      perRun('run', x => x.run.index, { long_name: 'the run’s number in the series (combinations in order, the first knob slowest, the seeds fastest)' }, 'int'),
      perRun('seed', x => x.run.seed, { long_name: 'random seed' }, 'double'),
      ...knobs.map(k => perRun(k, x => x.run.params[k], { long_name: `the series knob ${k}` })),
      perRun('env_ml_cape', x => x.run.cape, { units: 'J kg-1', long_name: 'mixed-layer CAPE of the starting environment' }),
      perRun('env_shear_0_6km', x => x.run.shear, { units: 'm s-1', long_name: '0-6 km bulk wind difference of the starting environment' }),
      perRun('env_srh_0_3km', x => x.run.srh, { units: 'm2 s-2', long_name: '0-3 km storm-relative helicity of the starting environment' }),
      perRun('regime', x => REGIMES.indexOf(regimeOf(x.r, x.p)), { long_name: 'storm regime over the run', flag_values: [0, 1, 2, 3], flag_meanings: REGIMES.join(' ') }, 'int'),
      perRun('mesocyclone_from', x => x.p.mesocyclone ?? NaN, { units: 's', long_name: 'time the mesocyclone began (NaN: none)' }),
      course('max_updraft', 'updraft', { units: 'm s-1', long_name: 'strongest updraught in the domain' }),
      course('max_uh', 'uh', { units: 'm2 s-2', long_name: 'strongest updraught helicity 2-5 km' }),
      course('max_rain_rate', 'rain', { units: 'mm h-1', long_name: 'strongest surface rain rate' }),
      course('max_surface_wind', 'gust', { units: 'm s-1', long_name: 'strongest surface wind' }),
      course('max_hail', 'hail', { units: 'mm', long_name: 'largest hail at the ground' }),
      course('flash_rate', 'flashes', { units: 'min-1', long_name: 'lightning flashes per minute' }),
      swath('rain_total', 'rainTotal', { units: 'mm', long_name: 'rain total over the run', standard_name: 'precipitation_amount' }),
      swath('hail_max', 'hailSize', { units: 'mm', long_name: 'largest hail over the run' }),
      swath('surface_wind_max', 'gustMax', { units: 'm s-1', long_name: 'strongest surface wind over the run' }),
      swath('uh_max', 'uhMax', { units: 'm2 s-2', long_name: 'strongest updraught helicity 2-5 km over the run' }),
    ],
  })
}
