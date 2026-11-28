// Replay one autoconversion step on rain-only 2M snapshots saved by lines.ts warmState=<prefix>.
// npx vite build --ssr tests/bench/rain-autoconversion.ts --outDir .bench/rain-autoconversion
// node .bench/rain-autoconversion/rain-autoconversion.js <snapshot> [snapshot ...]
import { readFileSync } from 'node:fs'
import { deserialize } from 'node:v8'
import { DT } from '../../src/core'
import { boundedNumber, CLOUD_DROPLETS, NUMBER_MIN, RAIN_MIN, rain2mProcesses, RHO_00, RHO_W } from '../../src/core/rain2m'
import { cloudDropVolume, collectionThreshold, volumeRadius } from './rain-radius'

type Snapshot = {
  minutes: number
  moments: [number, number]
  grid: { nx: number; ny: number; nz: number; dx: number; dy: number; hz: Float64Array }
  env: { exner: Float64Array; p: Float64Array; rho: Float64Array }
  theta: Float32Array; q: Float32Array; cloud: Float32Array; rain: Float32Array; number: Float32Array
}

const paths = process.argv.slice(2)
if (!paths.length) throw new Error('Expected at least one rain-only 2M snapshot')

const q = new Float32Array(1), cloud = new Float32Array(1), rain = new Float32Array(1), number = new Float32Array(1)
const dropMass = (radius: number) => RHO_W * (4 * Math.PI / 3) * radius ** 3
const birthRadiiUm = [0, 50, 60, 75, 100, 150]
const kernel = 9.44e15

function cloudLoss(qv: number, qc: number, qr: number, nr: number, tk: number, p: number, rho: number) {
  q[0] = qv; cloud[0] = qc; rain[0] = qr; number[0] = nr
  rain2mProcesses(q, cloud, rain, number, 0, tk, p, rho, DT, 'none', false)
  return qc - cloud[0]
}

for (const path of paths) {
  const state = deserialize(readFileSync(path)) as Snapshot
  if (state.moments.join() !== '2,1') throw new Error(`Expected rain-only 2M at ${path}`)
  const { nx, ny, nz, dx, dy, hz } = state.grid
  const { rho: densities, exner, p } = state.env
  const layer = nx * ny
  const cases = birthRadiiUm.map(birthRadiusUm => ({
    birthRadiusUm, eligibleRainKg: 0, eligibleNewRainKg: 0, coldBirthDrops: 0,
    eligibleColdSourceKg: 0, accretionKgPerS: 0,
  }))
  let autoKgPerS = 0, coldAutoKgPerS = 0, priorRainInColdSourceKg = 0, mixedRainKg = 0
  let autoErrorKgPerS = 0, roundoffKgPerS = 0
  let initialAccretionKgPerS = 0, coldNumberError = 0
  for (let z = 0; z < nz; z++) {
    const rho = densities[z], airMass = dx * dy * hz[z] * rho, nc = CLOUD_DROPLETS * rho / RHO_00
    for (let i = z * layer; i < (z + 1) * layer; i++) {
      const qc = state.cloud[i]
      if (!(qc > 1e-9)) continue
      const qr = state.rain[i], nr = boundedNumber(qr, state.number[i], rho)
      const tk = state.theta[i] * exner[z], qv = state.q[i]
      const volume = cloudDropVolume(qc), rb = volumeRadius(volume), dc = 2 * rb
      const xl2p = Math.max(0, .027 * rho * qc * (.5e20 * rb ** 3 * dc - .4))
      const active = tk > 237.15 && rb > 7.51e-6 && xl2p > 0
      const massRate = active ? xl2p / (3.72 / (1e6 * (rb - 7.5e-6) * rho * qc)) : 0
      const rawAuto = massRate * DT / rho
      const auto = Math.min(qc, rawAuto)
      const existing = rho * qr > 1.2 * xl2p && nr * rho > NUMBER_MIN
      const coldNumber = Math.min(3.5e9 * massRate, .5 * Math.min(.1 * nc / DT, 2 * kernel * nc * nc * volume * volume))
      const coldAdded = auto > 0 ? coldNumber * DT / rho * (auto / rawAuto) : 0
      const newNumber = existing ? nr * auto / qr : coldAdded

      const nativeAuto = cloudLoss(qv, qc, 0, 0, tk, p[z], rho)
      const expectedNumber = boundedNumber(auto, coldAdded, rho)
      coldNumberError = Math.max(coldNumberError, Math.abs(number[0] - expectedNumber) / Math.max(1, expectedNumber))
      autoErrorKgPerS += Math.abs(nativeAuto - auto) * airMass / DT
      roundoffKgPerS += 2 ** -23 * qc * airMass / DT
      if (qr > RAIN_MIN) initialAccretionKgPerS += (cloudLoss(qv, qc, qr, state.number[i], tk, p[z], rho) - nativeAuto) * airMass / DT
      autoKgPerS += auto * airMass / DT
      if (!existing && auto > 0) {
        coldAutoKgPerS += auto * airMass / DT
        priorRainInColdSourceKg += qr * airMass
      }

      // Mix just the two autoconversion sources, then probe collection on the resulting state.
      // Keep the stock number bounds and the stock threshold. The number cap applies only to the cold branch.
      const mixedQr = Math.fround(qr + auto), remainingCloud = Math.fround(qc - auto)
      if (!(mixedQr > RAIN_MIN && remainingCloud > 1e-9)) continue
      mixedRainKg += mixedQr * airMass
      const threshold = collectionThreshold(volumeRadius(cloudDropVolume(remainingCloud)))
      const nextAuto = cloudLoss(qv, remainingCloud, 0, 0, tk, p[z], rho)
      for (const result of cases) {
        const cap = result.birthRadiusUm ? auto / dropMass(result.birthRadiusUm * 1e-6) : Infinity
        const added = existing ? newNumber : Math.min(newNumber, cap)
        const inputNumber = Math.fround(nr + added)
        const modelNumber = boundedNumber(mixedQr, inputNumber, rho)
        if (!existing && auto > 0) {
          result.coldBirthDrops += added * airMass
          if (volumeRadius(auto / (RHO_W * added)) > threshold) result.eligibleColdSourceKg += auto * airMass
        }
        if (volumeRadius(mixedQr / (RHO_W * modelNumber)) > threshold) {
          result.eligibleRainKg += mixedQr * airMass
          result.eligibleNewRainKg += auto * airMass
        }
        result.accretionKgPerS += (cloudLoss(qv, remainingCloud, mixedQr, inputNumber, tk, p[z], rho) - nextAuto) * airMass / DT
      }
    }
  }

  if (autoErrorKgPerS > roundoffKgPerS) throw new Error(`Autoconversion mass does not match the native operator at T+${state.minutes}`)
  if (coldNumberError > 2e-7) throw new Error(`Cold-start drop number does not match the native operator at T+${state.minutes}`)
  console.log(JSON.stringify({ minutes: state.minutes, autoKgPerS, coldAutoKgPerS, priorRainInColdSourceKg, mixedRainKg,
    initialAccretionKgPerS, autoErrorKgPerS, roundoffKgPerS, coldNumberError, cases }))
}
