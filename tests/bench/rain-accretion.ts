// Compare warm-rain operators on the same cloud, sampled with lines.ts warmState=<prefix>.
// npx vite build --ssr tests/bench/rain-accretion.ts --outDir .bench/accretion-replay
// node .bench/accretion-replay/rain-accretion.js <2M snapshot> <1M rain donor snapshot>
import { readFileSync } from 'node:fs'
import { deserialize } from 'node:v8'
import { DT } from '../../src/core'
import { N0_MP, rainProcesses } from '../../src/core/microphysics'
import { boundedNumber, CLOUD_DROPLETS, exponentialMeanMass, G1, rain2mProcesses, RHO_00, RHO_W } from '../../src/core/rain2m'
import { cloudDropVolume, collectionThreshold, volumeRadius } from './rain-radius'

type Snapshot = {
  minutes: number
  options: { hours: number; every: number; [name: string]: number | number[] }
  moments: [number, number]
  grid: { nx: number; ny: number; nz: number; dx: number; dy: number; hz: Float64Array }
  env: { exner: Float64Array; p: Float64Array; rho: Float64Array }
  theta: Float32Array; q: Float32Array; cloud: Float32Array; rain: Float32Array; number: Float32Array
}

const [cloudFile, donorFile] = process.argv.slice(2)
if (!cloudFile || !donorFile) throw new Error('Usage: rain-accretion.js <2M snapshot> <1M rain donor snapshot>')
const read = (file: string): Snapshot => deserialize(readFileSync(file)) as Snapshot
const state = read(cloudFile), donor = read(donorFile), { nx, ny, nz, dx, dy, hz } = state.grid
const layer = nx * ny
const forcing = ({ hours, every, ...options }: Snapshot['options']) => JSON.stringify(options)
if (forcing(state.options) !== forcing(donor.options) || state.minutes !== donor.minutes ||
    state.moments.join() !== '2,1' || donor.moments.join() !== '1,1' || JSON.stringify(state.grid) !== JSON.stringify(donor.grid)) {
  throw new Error('Expected paired rain-only 2M and 1M snapshots with matching settings, grid and time')
}

const q = new Float32Array(1), cloud = new Float32Array(1), rain = new Float32Array(1), number = new Float32Array(1)
const { rho, exner, p } = state.env
function production(i: number, z: number, twoMoments: boolean, qr: number, nr = 0) {
  q[0] = state.q[i]; cloud[0] = state.cloud[i]; rain[0] = qr; number[0] = nr
  const tk = state.theta[i] * exner[z]
  if (twoMoments) rain2mProcesses(q, cloud, rain, number, 0, tk, p[z], rho[z], DT, 'none', false)
  else rainProcesses(q, cloud, rain, 0, tk, p[z], rho[z], DT, 'fixed', false)
  return state.cloud[i] - cloud[0]
}

const fixedDropMass = RHO_W * Math.PI / 6 * (2 * 100e-6) ** 3
const newCase = () => ({ rainKg: 0, blockedRainKg: 0, rainRadiusSum: 0, accretionKgPerS: 0,
  accretionWithoutGateKgPerS: 0, kernelErrorKgPerS: 0 })
const native = newCase(), nativeMP = newCase(), donorMP = newCase(), nativeFixedRadius = newCase(), donorFixedRadius = newCase()
let auto1M = 0, auto2M = 0, accretion1MWithDonor = 0, kernelRoundoff = 0
const mpNumber = (qr: number, density: number) => qr > 0 ? qr / exponentialMeanMass(qr, N0_MP, RHO_W, density) : 0

function evaluate(result: ReturnType<typeof newCase>, i: number, z: number, qr: number, nr: number, auto: number, weight: number) {
  const qc = state.cloud[i], density = rho[z], perM3 = density * boundedNumber(qr, Math.fround(nr), density)
  if (!(perM3 > 0)) return
  const nc = CLOUD_DROPLETS * density / RHO_00
  const cloudVolume = cloudDropVolume(qc)
  const rainVolume = density * qr / (RHO_W * perM3), rainRadius = volumeRadius(rainVolume)
  const threshold = collectionThreshold(volumeRadius(cloudVolume))
  const open = rainRadius > threshold
  const nativeAccretion = production(i, z, true, qr, nr) - auto

  // Repeat the native collection kernel and caps with only the radius gate lifted.
  // Check the same expression with the gate enforced against the native operator below.
  const rate = rainRadius > 50e-6
    ? 5.78e3 * perM3 * nc * RHO_W * cloudVolume * (2 * cloudVolume + rainVolume) / density
    : 9.44e15 * perM3 * qc * (6 * cloudVolume ** 2 + G1 * rainVolume ** 2)
  const potential = Math.min(.1 * qc, rate * DT, Math.max(0, qc - auto))
  result.rainKg += qr * weight * DT
  result.rainRadiusSum += qr * weight * DT * rainRadius
  if (!open) result.blockedRainKg += qr * weight * DT
  result.accretionKgPerS += nativeAccretion * weight
  result.accretionWithoutGateKgPerS += (open ? nativeAccretion : potential) * weight
  result.kernelErrorKgPerS += Math.abs((open ? potential : 0) - nativeAccretion) * weight
  kernelRoundoff += 2 ** -22 * qc * weight
}

for (let z = 0; z < nz; z++) {
  const weight = dx * dy * hz[z] * rho[z] / DT
  for (let i = z * layer; i < (z + 1) * layer; i++) {
    if (state.cloud[i] <= 1e-9) continue
    const qr = state.rain[i], donorRain = donor.rain[i]
    const a1 = production(i, z, false, 0), a2 = production(i, z, true, 0)
    auto1M += a1 * weight
    auto2M += a2 * weight
    accretion1MWithDonor += (production(i, z, false, donorRain) - a1) * weight
    evaluate(native, i, z, qr, state.number[i], a2, weight)
    evaluate(nativeMP, i, z, qr, mpNumber(qr, rho[z]), a2, weight)
    evaluate(donorMP, i, z, donorRain, mpNumber(donorRain, rho[z]), a2, weight)
    evaluate(nativeFixedRadius, i, z, qr, qr / fixedDropMass, a2, weight)
    evaluate(donorFixedRadius, i, z, donorRain, donorRain / fixedDropMass, a2, weight)
  }
}

const cases = { native, nativeMP, donorMP, nativeFixedRadius, donorFixedRadius }
const kernelError = Object.values(cases).reduce((sum, row) => sum + row.kernelErrorKgPerS, 0)
if (kernelError > kernelRoundoff) throw new Error(`The diagnostic kernel differs from native accretion: ${kernelError} kg/s (roundoff bound ${kernelRoundoff})`)
const summarize = ({ rainKg, blockedRainKg, rainRadiusSum, ...rates }: ReturnType<typeof newCase>) => ({
  rainKg, blockedMassFraction: rainKg ? blockedRainKg / rainKg : null,
  massWeightedRadiusUm: rainKg ? 1e6 * rainRadiusSum / rainKg : null, ...rates,
})
console.log(JSON.stringify({ minutes: state.minutes, auto1M, auto2M, accretion1MWithDonor,
  kernelError, kernelRoundoff, cases: Object.fromEntries(Object.entries(cases).map(([key, value]) => [key, summarize(value)])) }, null, 2))
