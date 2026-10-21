/**
 * The model's fields at one moment as a CF-1.8 NetCDF file (roadmap E2): the 3D state (ground-relative wind, potential
 * temperature, vapour and the hydrometeors, reflectivity), the swaths on the ground, the base state, and what makes the
 * file reproducible — the model's version, the settings, the seed, the model time.
 */
import { type AtmosphereModel, reflectivity, type SimConfig } from '../core'
import { type NcAttribute, type NcFile, type NcVariable, writeNetCDF } from './netcdf'

export interface FieldsMeta { version: string; seed: number; scenario: string; config: SimConfig }

type Model = Pick<AtmosphereModel, 'grid' | 'env' | 'frame' | 'time' | 'u' | 'v' | 'w' | 'theta' | 'q' | 'cloud' | 'rain' | 'ice' | 'snow' | 'graupel' | 'hail' | 'precipitation' | 'hailSize' | 'uhColumn'>

/** The CF file of the model `m` now. */
export function modelNetCDF(m: Model, meta: FieldsMeta): Uint8Array<ArrayBuffer> { return writeNetCDF(modelFields(m, meta)) }

export function modelFields(m: Model, meta: FieldsMeta): NcFile {
  const { nx, ny, nz, dx, dy, zs, layer } = m.grid, e = m.env, [fu, fv] = m.frame
  const D3 = ['time', 'z', 'y', 'x'] as const, D2 = ['time', 'y', 'x'] as const
  const field = (name: string, data: ArrayLike<number>, attrs: Record<string, NcAttribute>, dims: readonly string[] = D3): NcVariable => ({ name, dims, type: 'float', data, attrs })
  const plus = (a: Float32Array, k: number) => { const out = new Float32Array(a.length); for (let i = 0; i < a.length; i++) out[i] = a[i] + k; return out }
  // Reflectivity at every node, as the radar computes it (radar.ts), from the hydrometeors and the temperature.
  const dbz = new Float32Array(m.theta.length)
  for (let z = 0, i = 0; z < nz; z++) for (let end = i + layer; i < end; i++) dbz[i] = reflectivity(e.rho[z], m.rain[i], m.snow[i], m.graupel[i], m.theta[i] * e.exner[z] - 273.15, m.hail[i])
  const mix = (long: string) => ({ units: 'kg kg-1', long_name: long })
  const offset = [fu * m.time, fv * m.time]
  return {
    dims: { time: 1, z: nz, y: ny, x: nx },
    attrs: {
      Conventions: 'CF-1.8',
      title: `MeteoLab StormLab run: ${meta.scenario}`,
      institution: 'MeteoLab (https://bandananor.github.io/MeteoLAB/)',
      source: `MeteoLab StormLab ${meta.version}: anelastic non-hydrostatic cloud model`,
      history: `${new Date().toISOString()} written by the MeteoLab simulator`,
      references: 'https://github.com/Bandananor/MeteoLAB',
      comment: 'x and y are in the frame of the model domain, which moves over the ground with the storm (domain_velocity); '
        + 'the ground point under domain point (x, y) is (x + domain_offset[0], y + domain_offset[1]). Variables on the ground '
        + '(precipitation_amount, hail_max_diameter) are on ground columns: their (x, y) is the ground point itself. Lateral '
        + 'boundaries are periodic unless the settings say otherwise.',
      model_time_s: m.time, seed: meta.seed, start_local_solar_time_h: meta.config.hour, day_of_year: meta.config.dayOfYear ?? 80, latitude_deg: meta.config.latitude,
      domain_velocity: [fu, fv], domain_offset: offset,
      settings_json: JSON.stringify(meta.config),
    },
    vars: [
      { name: 'time', dims: ['time'], type: 'double', data: [m.time], attrs: { units: 's', long_name: 'model time since the start of the run (an idealised run has no calendar date; see start_local_solar_time_h)', axis: 'T' } },
      { name: 'z', dims: ['z'], type: 'float', data: zs, attrs: { units: 'm', long_name: 'height above ground', positive: 'up', axis: 'Z', standard_name: 'height' } },
      { name: 'y', dims: ['y'], type: 'float', data: Float32Array.from({ length: ny }, (_, j) => j * dy), attrs: { units: 'm', long_name: 'south-north distance in the domain frame', axis: 'Y', standard_name: 'projection_y_coordinate' } },
      { name: 'x', dims: ['x'], type: 'float', data: Float32Array.from({ length: nx }, (_, i) => i * dx), attrs: { units: 'm', long_name: 'west-east distance in the domain frame', axis: 'X', standard_name: 'projection_x_coordinate' } },
      field('u', plus(m.u, fu), { units: 'm s-1', long_name: 'eastward wind relative to the ground', standard_name: 'eastward_wind' }),
      field('v', plus(m.v, fv), { units: 'm s-1', long_name: 'northward wind relative to the ground', standard_name: 'northward_wind' }),
      field('w', m.w, { units: 'm s-1', long_name: 'vertical velocity', standard_name: 'upward_air_velocity' }),
      field('theta', m.theta, { units: 'K', long_name: 'potential temperature', standard_name: 'air_potential_temperature' }),
      field('qv', m.q, { ...mix('water vapour mixing ratio'), standard_name: 'humidity_mixing_ratio' }),
      field('qc', m.cloud, mix('cloud water mixing ratio')),
      field('qr', m.rain, mix('rain mixing ratio')),
      field('qi', m.ice, mix('cloud ice mixing ratio')),
      field('qs', m.snow, mix('snow mixing ratio')),
      field('qg', m.graupel, mix('graupel mixing ratio')),
      field('qh', m.hail, mix('hail mixing ratio')),
      field('dbz', dbz, { units: 'dBZ', long_name: 'radar reflectivity (Rayleigh, from the model hydrometeors)', standard_name: 'equivalent_reflectivity_factor' }),
      field('precipitation_amount', m.precipitation, { units: 'mm', long_name: 'rain and hail on the ground since the start (ground columns)' }, D2),
      field('hail_max_diameter', m.hailSize, { units: 'mm', long_name: 'largest hail reaching the ground since the start (ground columns)' }, D2),
      field('uh25', m.uhColumn, { units: 'm2 s-2', long_name: 'updraught helicity 2-5 km (domain columns)' }, D2),
      { name: 'rho0', dims: ['z'], type: 'float', data: Float32Array.from(e.rho), attrs: { units: 'kg m-3', long_name: 'base-state air density' } },
      { name: 'p0', dims: ['z'], type: 'float', data: Float32Array.from(e.p), attrs: { units: 'Pa', long_name: 'base-state pressure', standard_name: 'air_pressure' } },
      { name: 'theta0', dims: ['z'], type: 'float', data: Float32Array.from(e.theta), attrs: { units: 'K', long_name: 'base-state potential temperature' } },
      { name: 'qv0', dims: ['z'], type: 'float', data: Float32Array.from(e.q), attrs: { units: 'kg kg-1', long_name: 'base-state water vapour mixing ratio' } },
    ],
  }
}
