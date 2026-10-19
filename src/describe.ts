import { L } from './i18n'
import { MESO_CORE_ZETA, MESO_PERSISTENCE, UH_ROTATING, type ModelDiagnostics, type RotationState, type Sounding } from './core'

/**
 * The rain rate in words, mm/h, by the WMO's showers (slight below 2.5, moderate to 10, heavy to 50, violent from 50).
 * «Ливневый»: the character of precipitation from a cumulonimbus at any rate, not a step of it (the meteorologist's
 * review 16.10.2026: «ливень» stood between «сильный» and «очень сильный»). An instant rate in the core, not the
 * hazardous «сильный ливень» of Roshydromet (30 mm within an hour at one place).
 */
export function rainWord(rate: number) {
  if (rate < .1) return ''
  const k = rate < 2.5 ? 0 : rate < 10 ? 1 : rate < 50 ? 2 : 3
  return L(`${['слабый', 'умеренный', 'сильный', 'очень сильный'][k]} ливневый дождь`, `${['slight', 'moderate', 'heavy', 'violent'][k]} rain showers`)
}

/** The hail by its largest stones, mm (large from 20 mm: the hazardous phenomenon of Roshydromet). */
export function hailWord(size: number) {
  return size < 1 ? '' : size < 10 ? L('мелкий', 'small') : size < 20 ? L('средний', 'medium') : size < 50 ? L('крупный', 'large') : L('очень крупный', 'very large')
}

/**
 * The cloud by the international classification, from the tallest cloud's top (km), the condensation level (km), the
 * environment's temperature at the top (°C) and the equilibrium level (km): cumulus by depth, a cumulonimbus once the top
 * is colder than -20 °C (glaciated: the top loses its sharp cauliflower outline), with an anvil (capillatus) when the top
 * spreads at the equilibrium level. Empty without a cloud.
 */
export function cloudGenus(top: number, lcl: number | null, topTemp: number, el: number | null) {
  const depth = top - (lcl ?? 0)
  if (top < 1 || depth < .2) return ''
  if (topTemp > -20) return depth < 1 ? L('Cu hum — кучевое плоское', 'Cu hum — cumulus humilis') : depth < 2.5 ? L('Cu med — кучевое средней мощности', 'Cu med — cumulus mediocris') : L('Cu cong — мощное кучевое', 'Cu cong — cumulus congestus')
  return el !== null && top >= el - .6 ? L('Cb cap inc — кучево-дождевое волосатое с наковальней', 'Cb cap inc — cumulonimbus capillatus with an anvil') : L('Cb calv — кучево-дождевое лысое', 'Cb calv — cumulonimbus calvus')
}

/** Human-readable storm mode and a short explanation of what the model is doing right now. */
export function describeConvection(d: ModelDiagnostics, s: Sounding, r: RotationState, topTemp = 0) {
  const { cores, coldMax, updraft: up, cloudTop: top, shear06: shear } = d
  const cellType = coldMax > 7 && up < 2 ? L('Отток подавил ячейку', 'The outflow has choked the cell') : cores >= 3 ? L('Многоячейковая гроза', 'Multicell storm') : cores === 2 ? L('Две взаимодействующие ячейки', 'Two interacting cells') : cores === 1 && shear > 18 ? L('Наклонённая организованная ячейка', 'Tilted organized cell') : cores === 1 ? L('Одноячейковая гроза', 'Single-cell storm') : top > 1 ? L('Растущие кучевые облака', 'Growing cumulus') : L('Термики пограничного слоя', 'Boundary-layer thermals')
  const cellReason = cores ? L(`${cores} ${cores === 1 ? 'восходящее ядро' : cores < 5 ? 'восходящих ядра' : 'восходящих ядер'}`, `${cores} updraught core${cores === 1 ? '' : 's'}`) : L('глубокое ядро ещё не сформировано', 'no deep core yet')

  let logic = L('Трёхмерные термики перераспределяют тепло и влагу в пограничном слое.', 'Three-dimensional thermals redistribute heat and moisture in the boundary layer.')
  if (top >= (s.lcl ?? 99)) logic = L('На LCL объём воздуха насыщается; сухое вовлечение размывает края облака.', 'At the LCL the air saturates; dry entrainment frays the cloud’s edges.')
  if (top >= (s.lfc ?? 99)) logic = L('Выше LFC восходящий поток ускоряется и наклоняется сдвигом ветра.', 'Above the LFC the updraught accelerates and is tilted by the wind shear.')
  if (top >= (s.el ?? 99) - .6) logic = L('У EL плавучесть исчезает: поток расходится во всех горизонтальных направлениях, формируя наковальню.', 'At the EL the buoyancy vanishes: the updraught spreads out in every horizontal direction, forming the anvil.')
  // The cold pool undercuts the core only when the core is weakening too (the indicator alone ran past 7 K under a
  // supercell at its height: the meteorologist's review 16.10.2026).
  if (coldMax > 3) logic += coldMax > 7 && up < 10 ? L(' Холодный купол подтекает под приток тёплого воздуха и гасит исходное ядро.', ' The cold pool undercuts the warm inflow and chokes the original core.') : L(' Фронт порывов поднимает тёплый воздух по краю холодного купола.', ' The gust front lifts warm air along the edge of the cold pool.')
  if (d.gust > 20 && d.coldMax > 2) logic += L(` Холодный отток растекается у земли: порывы до ${d.gust.toFixed(0)} м/с.`, ` The cold outflow spreads along the ground: gusts up to ${d.gust.toFixed(0)} m/s.`)
  if (d.hail >= 5) logic += L(` Из ядра у земли выпадает град до ${(d.hail / 10).toFixed(1)} см.`, ` Hail up to ${(d.hail / 10).toFixed(1)} cm falls from the core to the ground.`)

  const meso = r.persisted >= MESO_PERSISTENCE, rotating = r.uh >= UH_ROTATING
  if (meso) logic += L(` Восходящий поток вращается циклонически уже ${Math.floor(r.persisted / 60)} мин: горизонтальные вихри от сдвига ветра наклонены потоком и растянуты в мезоциклон.`, ` The updraught has rotated cyclonically for ${Math.floor(r.persisted / 60)} min: the horizontal vortices of the wind shear were tilted by the updraught and stretched into a mesocyclone.`)
  else if (rotating) logic += L(' Восходящий поток наклоняет горизонтальную завихренность сдвига ветра: появляется вращение.', ' The updraught tilts the horizontal vorticity of the wind shear: rotation appears.')
  // By an anticyclonic core's own vorticity, not the UH anywhere: vortex pairs give UH 400-600 in weak shear (model.ts).
  if (r.coreAnti >= MESO_CORE_ZETA) logic += L(' Есть и антициклонически вращающийся поток — признак расщепления на правую и левую ячейки.', ' There is an anticyclonically rotating updraught too — a sign of a split into right and left movers.')

  return {
    cellType: meso ? L('Суперячейка с мезоциклоном', 'Supercell with a mesocyclone') : cellType,
    cellReason: meso ? L(`вращение держится ${Math.floor(r.persisted / 60)} мин, UH ${r.uh.toFixed(0)} м²/с²`, `rotation has held for ${Math.floor(r.persisted / 60)} min, UH ${r.uh.toFixed(0)} m²/s²`) : rotating ? `${cellReason}${L('; в потоке появилось вращение', '; rotation has appeared in the updraught')}` : cellReason,
    mesocyclone: meso, logic, cloud: cloudGenus(top, s.lcl, topTemp, s.el),
  }
}
