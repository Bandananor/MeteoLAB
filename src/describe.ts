import { MESO_PERSISTENCE, UH_MESOCYCLONE, UH_ROTATING, type ModelDiagnostics, type RotationState, type Sounding } from './core'

/** Human-readable storm mode and a short explanation of what the model is doing right now. */
export function describeConvection(d: ModelDiagnostics, s: Sounding, r: RotationState) {
  const { cores, coldMax, updraft: up, cloudTop: top, shear06: shear } = d
  const cellType = coldMax > 7 && up < 2 ? 'Outflow-dominant' : cores >= 3 ? '3D-мультиячейка' : cores === 2 ? 'Две взаимодействующие ячейки' : cores === 1 && shear > 18 ? 'Наклонённая организованная ячейка' : cores === 1 ? 'Одиночная 3D-ячейка' : top > 1 ? 'Развивающийся 3D cumulus' : 'Термики пограничного слоя'
  const cellReason = cores ? `${cores} пространственно разделённых updraft-ядра` : 'глубокое ядро ещё не сформировано'

  let logic = 'Трёхмерные термики перераспределяют тепло и влагу в пограничном слое.'
  if (top >= (s.lcl ?? 99)) logic = 'На LCL объём воздуха насыщается; сухое вовлечение размывает края облака.'
  if (top >= (s.lfc ?? 99)) logic = 'Выше LFC updraft ускоряется в объёме и наклоняется векторным сдвигом ветра.'
  if (top >= (s.el ?? 99) - .6) logic = 'У EL плавучесть исчезает: поток расходится во всех горизонтальных направлениях, формируя наковальню.'
  if (coldMax > 3) logic += coldMax > 7 ? ' Холодный купол подтекает под inflow и уничтожает исходное ядро.' : ' 3D gust front поднимает тёплый воздух на периферии cold pool.'
  if (d.gust > 20 && d.coldMax > 2) logic += ` Холодный отток растекается у земли: порывы до ${d.gust.toFixed(0)} м/с.`
  if (d.hail >= 5) logic += ` Из ядра у земли выпадает град до ${(d.hail / 10).toFixed(1)} см.`

  const meso = r.persisted >= MESO_PERSISTENCE, rotating = r.uh >= UH_ROTATING
  if (meso) logic += ` Восходящий поток вращается циклонически уже ${Math.floor(r.persisted / 60)} мин: горизонтальные вихри от сдвига ветра наклонены потоком и растянуты в мезоциклон.`
  else if (rotating) logic += ' Восходящий поток наклоняет горизонтальную завихренность сдвига ветра: появляется вращение.'
  if (r.anticyclonic >= UH_MESOCYCLONE) logic += ' Есть и антициклонически вращающийся поток — признак расщепления на правую и левую ячейки.'

  return {
    cellType: meso ? 'Суперячейка с мезоциклоном' : cellType,
    cellReason: meso ? `вращение держится ${Math.floor(r.persisted / 60)} мин, UH ${r.uh.toFixed(0)} м²/с²` : rotating ? `${cellReason}; в потоке появилось вращение` : cellReason,
    mesocyclone: meso, logic,
  }
}
