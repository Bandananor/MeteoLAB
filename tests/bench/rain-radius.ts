import type { AtmosphereModel } from '../../src/core'
import { boundedNumber, CLOUD_DROPLETS, G1, rain2mProcesses, RAIN_MIN, RHO_00, RHO_W, XV_MIN } from '../../src/core/rain2m'

export function cloudDropVolume(qc: number) {
  return Math.min(Math.PI / 6 * 120e-6 ** 3, Math.max(Math.PI / 6 * 4e-6 ** 3, qc / (RHO_W * CLOUD_DROPLETS / RHO_00)))
}

export const volumeRadius = (volume: number) => .5 * Math.cbrt(6 * volume / Math.PI)
export const collectionThreshold = (radius: number) => radius > 3.5e-6 ? Math.max(41e-6, 6.3e-4 / (1e6 * (radius - 3.5e-6))) : 41e-6

const minimumRadius = volumeRadius(XV_MIN)
const freshBirth = () => ({ rainKg: 0, rawRadiusSum: 0, boundedRadiusSum: 0, belowLimitKg: 0, kernelErrorKg: 0 })

function trackSelfCollection(model: AtmosphereModel, weight: Float64Array) {
  if (model.rainBreakup !== 'none') throw new Error('rainSelfCollection=1 measures the default self-collection law without breakup')
  const { layer, nz } = model.grid, { rho, exner, p } = model.env
  const q = new Float32Array(1), cloud = new Float32Array(1), rain = new Float32Array(1), number = new Float32Array(1)
  const empty = () => ({ numberSeconds: 0, removed: 0, rainKgSeconds: 0, radiusGainSum: 0,
    passedKgSeconds: 0, maxGainUm: 0, kernelError: 0, nativeNumber: 0 })
  let sample = empty()

  function observe(dt: number) {
    for (let z = 0; z < nz; z++) for (let i = z * layer; i < (z + 1) * layer; i++) {
      const qr = model.rain[i], qc = model.cloud[i]
      if (qr <= RAIN_MIN || qc <= 1e-9) continue
      const nr = boundedNumber(qr, model.rainNumber[i], rho[z]), perM3 = nr * rho[z]
      const volume = qr / (RHO_W * nr), radius = volumeRadius(volume), diameter = 2 * radius
      const efficiency = diameter - 1e-4 > 1.9e-3 ? 0 : diameter < 6.1e-4 ? 1 : Math.exp(-2500 * (diameter - 6e-4))
      const rate = efficiency * (radius >= 50e-6 ? 5.78e3 * perM3 ** 2 * volume : 9.44e15 * (perM3 * volume) ** 2 * G1)
      const after = boundedNumber(qr, Math.max(0, nr - rate * dt / rho[z]), rho[z])
      const afterRadius = volumeRadius(qr / (RHO_W * after)), gainUm = 1e6 * (afterRadius - radius)
      const rainKgSeconds = qr * weight[z] * dt, threshold = collectionThreshold(volumeRadius(cloudDropVolume(qc)))
      sample.numberSeconds += nr * weight[z] * dt
      sample.removed += (nr - after) * weight[z]
      sample.rainKgSeconds += rainKgSeconds
      sample.radiusGainSum += rainKgSeconds * gainUm
      if (radius <= threshold && afterRadius > threshold) sample.passedKgSeconds += rainKgSeconds
      sample.maxGainUm = Math.max(sample.maxGainUm, gainUm)

      // Zero cloud and evaporation off isolate collection of rain by rain in the native operator.
      q[0] = model.q[i]; rain[0] = qr; number[0] = model.rainNumber[i]
      rain2mProcesses(q, cloud, rain, number, 0, model.theta[i] * exner[z], p[z], rho[z], dt, 'none', false)
      sample.kernelError += Math.abs(after - number[0]) * weight[z]
      sample.nativeNumber += number[0] * weight[z]
    }
  }

  function read() {
    const { numberSeconds, removed, rainKgSeconds, radiusGainSum, passedKgSeconds, maxGainUm, kernelError, nativeNumber } = sample
    sample = empty()
    return { removedNumberFractionPerMin: numberSeconds ? 60 * removed / numberSeconds : null,
      meanGainUmPerStep: rainKgSeconds ? radiusGainSum / rainKgSeconds : null, maxGainUmPerStep: maxGainUm,
      newlyEligibleMassFraction: rainKgSeconds ? passedKgSeconds / rainKgSeconds : null,
      relativeNumberError: nativeNumber ? kernelError / nativeNumber : null }
  }
  return { observe, read }
}

export function trackRainRadius(model: AtmosphereModel, selfCollection = false) {
  if (!model.rain2m()) throw new Error('rainRadius=1 requires two-moment rain')
  const { layer, nz, dx, dy, hz, zs } = model.grid, { rho, exner, p } = model.env
  const weight = Float64Array.from(hz, (height, z) => dx * dy * height * rho[z])
  const self = selfCollection ? trackSelfCollection(model, weight) : null
  const q = new Float32Array(1), cloud = new Float32Array(1), rain = new Float32Array(1), number = new Float32Array(1)
  let birth = freshBirth()
  type Phase = 'sedimentation' | 'transport' | 'microphysics' | 'mixing'
  type Passage = { seconds: number; phase: Phase; heightM: number; radiusUm: number; thresholdUm: number; openKg: number }
  let firstPassage: Passage | null = null, firstTonne: Passage | null = null
  const phases: Partial<Record<Phase, { cloudRainKg: number; meanRadiusUm: number | null; atLowerBoundFraction: number | null; openFraction: number | null }>> = {}

  function inspect(phase: Phase, dt: number) {
    let cloudRainKg = 0, radiusSum = 0, lowerBoundKg = 0, openKg = 0
    let strongest = { kg: 0, heightM: 0, radiusUm: 0, thresholdUm: 0 }
    for (let z = 0; z < nz; z++) for (let i = z * layer; i < (z + 1) * layer; i++) {
      const qr = model.rain[i], qc = model.cloud[i]
      if (qr <= RAIN_MIN || qc <= 1e-9) continue
      const kg = qr * weight[z], nr = boundedNumber(qr, model.rainNumber[i], rho[z])
      const radius = volumeRadius(qr / (RHO_W * nr)), threshold = collectionThreshold(volumeRadius(cloudDropVolume(qc)))
      cloudRainKg += kg
      radiusSum += kg * radius
      if (radius <= minimumRadius * (1 + 1e-6)) lowerBoundKg += kg
      if (radius <= threshold) continue
      openKg += kg
      if (kg > strongest.kg) strongest = { kg, heightM: zs[z], radiusUm: 1e6 * radius, thresholdUm: 1e6 * threshold }
    }
    phases[phase] = { cloudRainKg, meanRadiusUm: cloudRainKg ? 1e6 * radiusSum / cloudRainKg : null,
      atLowerBoundFraction: cloudRainKg ? lowerBoundKg / cloudRainKg : null, openFraction: cloudRainKg ? openKg / cloudRainKg : null }
    if (openKg > 0 && (!firstPassage || (openKg >= 1000 && !firstTonne))) {
      const { heightM, radiusUm, thresholdUm } = strongest
      const passage = { seconds: model.time + dt, phase, heightM, radiusUm, thresholdUm, openKg }
      firstPassage ??= passage
      if (openKg >= 1000) firstTonne ??= passage
    }
  }

  function collectBirth(dt: number) {
    for (let z = 0; z < nz; z++) for (let i = z * layer; i < (z + 1) * layer; i++) {
      const qc = model.cloud[i]
      if (model.rain[i] > RAIN_MIN || qc <= 1e-9) continue
      const tk = model.theta[i] * exner[z]
      if (tk <= 237.15) continue
      const xv = cloudDropVolume(qc), radius = volumeRadius(xv), c = Math.max(0, .027 * rho[z] * qc * (1e20 * radius ** 4 - .4))
      if (radius <= 7.51e-6 || c <= 0) continue
      const time = 3.72 / (1e6 * (radius - 7.5e-6) * rho[z] * qc), nc = CLOUD_DROPLETS * rho[z] / RHO_00
      // With no existing rain, the two autoconversion sources give the newborn drops' volume before limiting.
      const source = c / time / rho[z], sourceNumber = Math.min(3.5e9 * c / time, .5 * Math.min(.1 * nc / dt, 2 * 9.44e15 * nc ** 2 * xv ** 2)) / rho[z]
      const rawRadius = volumeRadius(source / (RHO_W * sourceNumber))
      q[0] = model.q[i]; cloud[0] = qc; rain[0] = 0; number[0] = 0
      rain2mProcesses(q, cloud, rain, number, 0, tk, p[z], rho[z], dt, model.rainBreakup, false)
      if (rain[0] <= RAIN_MIN) continue
      const kg = rain[0] * weight[z], boundedRadius = volumeRadius(rain[0] / (RHO_W * number[0]))
      birth.rainKg += kg
      birth.rawRadiusSum += kg * rawRadius
      birth.boundedRadiusSum += kg * boundedRadius
      if (rawRadius < minimumRadius) birth.belowLimitKg += kg
      birth.kernelErrorKg += Math.abs(rain[0] - Math.min(qc, source * dt)) * weight[z]
    }
  }

  const begin = model.beginStep.bind(model), finish = model.finishStep.bind(model), run = model.runner.run.bind(model.runner)
  model.beginStep = (dt, sediment) => { begin(dt, sediment); inspect('sedimentation', dt) }
  model.runner.run = (phase, tasks, dt) => {
    if (phase !== 'physics') { run(phase, tasks, dt); return }
    inspect('transport', dt)
    if (model.rainFormation) { collectBirth(dt); self?.observe(dt) }
    run(phase, tasks, dt)
    inspect('microphysics', dt)
  }
  model.finishStep = dt => { finish(dt); inspect('mixing', dt) }

  return () => {
    const { rainKg, rawRadiusSum, boundedRadiusSum, belowLimitKg, kernelErrorKg } = birth
    birth = freshBirth()
    return { phases, firstPassage, firstTonne, ...(self ? { selfCollection: self.read() } : {}), birth: { rainKg, kernelErrorKg,
      rawRadiusUm: rainKg ? 1e6 * rawRadiusSum / rainKg : null, boundedRadiusUm: rainKg ? 1e6 * boundedRadiusSum / rainKg : null,
      belowLimitFraction: rainKg ? belowLimitKg / rainKg : null } }
  }
}
