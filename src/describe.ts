import { MESO_PERSISTENCE, UH_MESOCYCLONE, UH_ROTATING, type ModelDiagnostics, type RotationState, type Sounding } from './core'

/** The rain rate in words, mm/h (the WMO's showers: slight below 2.5, heavy from 10; violent from 50). */
export function rainWord(rate: number) {
  return rate < .1 ? '' : rate < 2.5 ? 'слабый' : rate < 10 ? 'умеренный' : rate < 30 ? 'сильный' : rate < 50 ? 'ливень' : 'очень сильный ливень'
}

/** The hail by its largest stones, mm (large from 20 mm: the hazardous phenomenon of Roshydromet). */
export function hailWord(size: number) {
  return size < 1 ? '' : size < 10 ? 'мелкий' : size < 20 ? 'средний' : size < 50 ? 'крупный' : 'очень крупный'
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
  if (topTemp > -20) return depth < 1 ? 'Cu hum — кучевое плоское' : depth < 2.5 ? 'Cu med — кучевое средней мощности' : 'Cu cong — мощное кучевое'
  return el !== null && top >= el - .6 ? 'Cb cap — кучево-дождевое волосатое, с наковальней' : 'Cb calv — кучево-дождевое лысое'
}

/** Human-readable storm mode and a short explanation of what the model is doing right now. */
export function describeConvection(d: ModelDiagnostics, s: Sounding, r: RotationState, topTemp = 0) {
  const { cores, coldMax, updraft: up, cloudTop: top, shear06: shear } = d
  const cellType = coldMax > 7 && up < 2 ? 'Отток подавил ячейку' : cores >= 3 ? '3D-мультиячейка' : cores === 2 ? 'Две взаимодействующие ячейки' : cores === 1 && shear > 18 ? 'Наклонённая организованная ячейка' : cores === 1 ? 'Одиночная 3D-ячейка' : top > 1 ? 'Растущие кучевые облака' : 'Термики пограничного слоя'
  const cellReason = cores ? `${cores} ${cores === 1 ? 'восходящее ядро' : cores < 5 ? 'восходящих ядра' : 'восходящих ядер'}` : 'глубокое ядро ещё не сформировано'

  let logic = 'Трёхмерные термики перераспределяют тепло и влагу в пограничном слое.'
  if (top >= (s.lcl ?? 99)) logic = 'На LCL объём воздуха насыщается; сухое вовлечение размывает края облака.'
  if (top >= (s.lfc ?? 99)) logic = 'Выше LFC восходящий поток ускоряется и наклоняется сдвигом ветра.'
  if (top >= (s.el ?? 99) - .6) logic = 'У EL плавучесть исчезает: поток расходится во всех горизонтальных направлениях, формируя наковальню.'
  if (coldMax > 3) logic += coldMax > 7 ? ' Холодный купол подтекает под приток тёплого воздуха и гасит исходное ядро.' : ' Фронт порывов поднимает тёплый воздух по краю холодного купола.'
  if (d.gust > 20 && d.coldMax > 2) logic += ` Холодный отток растекается у земли: порывы до ${d.gust.toFixed(0)} м/с.`
  if (d.hail >= 5) logic += ` Из ядра у земли выпадает град до ${(d.hail / 10).toFixed(1)} см.`

  const meso = r.persisted >= MESO_PERSISTENCE, rotating = r.uh >= UH_ROTATING
  if (meso) logic += ` Восходящий поток вращается циклонически уже ${Math.floor(r.persisted / 60)} мин: горизонтальные вихри от сдвига ветра наклонены потоком и растянуты в мезоциклон.`
  else if (rotating) logic += ' Восходящий поток наклоняет горизонтальную завихренность сдвига ветра: появляется вращение.'
  if (r.anticyclonic >= UH_MESOCYCLONE) logic += ' Есть и антициклонически вращающийся поток — признак расщепления на правую и левую ячейки.'

  return {
    cellType: meso ? 'Суперячейка с мезоциклоном' : cellType,
    cellReason: meso ? `вращение держится ${Math.floor(r.persisted / 60)} мин, UH ${r.uh.toFixed(0)} м²/с²` : rotating ? `${cellReason}; в потоке появилось вращение` : cellReason,
    mesocyclone: meso, logic, cloud: cloudGenus(top, s.lcl, topTemp, s.el),
  }
}
