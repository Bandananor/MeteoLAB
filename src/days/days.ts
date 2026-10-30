/**
 * «Гроза дня» (roadmap M2): real days ready to run — a proximity sounding (or a reanalysis profile where no station
 * was near), what was observed that day and where it is from, and how to read the model against it. The model repeats
 * a storm in the day's environment (one profile, no terrain, no fronts or outflow boundaries), not a forecast of the
 * place and time; the comparison (roadmap A5) is of the storm's type, its motion, its echo and its life. The newest day
 * comes first: it is the one «Опыт → Гроза дня» opens.
 */
import { L } from '../i18n'
import kushva2026 from './soundings/kushva-2026-06-22-12z.csv?raw'
import moore2013 from './soundings/oun-2013-05-20-18z.html?raw'
import pilger2014 from './soundings/oax-2014-06-16-19z.sharppy?raw'

export interface StormDay {
  id: string
  /** The place and the date, as the list shows them. */
  title: () => string
  /** Where the profile comes from: a radiosonde (station, time) or a reanalysis. */
  profile: () => string
  /** What was observed, in a few sentences. */
  observed: () => string
  /** What to compare in the model, and what it cannot give. */
  compare: () => string
  /** Where the observations are from. */
  sources: () => string
  /** The sounding's text, in any format soundingfile.ts reads. */
  text: string
  /** The station's latitude, ° (for the Coriolis parameter and the sun), when the profile does not carry it. */
  latitude?: number
}

export const STORM_DAYS: StormDay[] = [
  {
    id: 'kushva-2026-06-22', text: kushva2026, latitude: 58,
    title: () => L('Кушва, Свердловская обл., 22.06.2026', 'Kushva, Sverdlovsk oblast, 22 June 2026'),
    profile: () => L('Профиль ERA5 в точке на 12 UTC (аэрологической станции рядом нет)', 'An ERA5 point profile at 12 UTC (no radiosonde station nearby)'),
    observed: () => L(
      'Вспышка торнадо на Среднем Урале, в том числе самый сильный торнадо в России почти за 10 лет. Кушвинская суперячейка развилась взрывообразно: торнадо через 20–30 мин после её зарождения, около 40 мин на земле; шла на север с лёгким уклоном к западу, зародилась перед городом и после него прошла ещё 5–10 км по лесу; после распада вихря, вероятно, окклюдировалась. Разрез ДМРЛ-С в 14:50 UTC: 45 dBZ до 11–12 км, ядро больше 60 dBZ на ~4 км, эхо до 14–15 км; на карте явлений — сильный град и гроза со шквалом. Сообщений о граде нет.',
      'A tornado outbreak in the Middle Urals, among them the strongest tornado in Russia in almost 10 years. The Kushva supercell grew explosively: a tornado 20–30 min after it formed, ~40 min on the ground; it moved north with a slight westward drift, formed before the town and went on 5–10 km over the forest after it; after the vortex died it probably occluded. A DMRL-C section at 14:50 UTC: 45 dBZ to 11–12 km, a core above 60 dBZ at ~4 km, echo to 14–15 km; the phenomena map: heavy hail and a thunderstorm with a squall. No hail reports.'),
    compare: () => L(
      'Среда торнадная, не градовая: CAPE смешанного слоя ~1650 Дж/кг при SRH 0–1 км ~190 м²/с² (SCP ~12, STP ~1,7). Сравнивайте, как быстро вырастает мезоциклон, направление движения (Bunkers даёт правой ячейке ~172°, на север), высоту 45 dBZ и ядро на 4 км, окклюзию. Сам торнадо на сетке 1,2 км не разрешается — только его признаки (определитель).',
      'A tornadic, not a hail environment: mixed-layer CAPE ~1650 J/kg with 0–1 km SRH ~190 m²/s² (SCP ~12, STP ~1.7). Compare how fast the mesocyclone grows, the motion (Bunkers gives the right mover ~172°, northward), the height of 45 dBZ and the core at 4 km, the occlusion. The tornado itself is not resolved on the 1.2 km grid — only its signs (the detector).'),
    sources: () => L('рассказ автора; разрез ДМРЛ-С (ЦАО), 14:50 UTC', 'the author’s account; a DMRL-C (TsAO) section, 14:50 UTC'),
  },
  {
    id: 'moore-2013-05-20', text: moore2013, latitude: 35.2,
    title: () => L('Мур, Оклахома, 20.05.2013', 'Moore, Oklahoma, 20 May 2013'),
    profile: () => L('Радиозонд OUN (Норман), специальный выпуск 18 UTC — в ~20 км от трека и за ~1,5 ч до торнадо', 'Radiosonde OUN (Norman), the special 18 UTC release — ~20 km from the track and ~1.5 h before the tornado'),
    observed: () => L(
      'Дискретная правая суперячейка, по прогнозу SPC — HP; зародилась на восточном выступе линии сухости к западу-юго-западу от Ньюкасла около 19 UTC. До сильного нижнего вращения ~70 мин; торнадо EF5 с 19:56 до 20:35 UTC, 23 км, ширина до 1,7 км. Шла с ~245° со скоростью 10–12 м/с; жила 3 ч и больше. Град до 2,5″ (6,4 см).',
      'A discrete right-moving supercell, HP by the SPC outlook; it formed on the eastern bulge of the dryline west-southwest of Newcastle around 19 UTC. ~70 min to strong low-level rotation; an EF5 tornado 19:56–20:35 UTC, 23 km, up to 1.7 km wide. It moved from ~245° at 10–12 m/s and lived 3 h or more. Hail up to 2.5″ (6.4 cm).'),
    compare: () => L(
      'Сравнивайте тип грозы, движение (Bunkers на ~5 м/с быстрее наблюдённого), время до мезоциклона и жизнь грозы. Град — нет: одномоментная схема не растит его крупнее ~1 см у земли (известное отклонение, B1/B2).',
      'Compare the storm’s type, its motion (Bunkers is ~5 m/s faster than observed), the time to the mesocyclone and the storm’s life. Not the hail: the single-moment scheme grows none larger than ~1 cm at the ground (a known deviation, B1/B2).'),
    sources: () => L('NWS Норман (weather.gov/oun/events-20130520); Burgess et al. 2014, WAF 29, 1229; сводки и WW 191 SPC', 'NWS Norman (weather.gov/oun/events-20130520); Burgess et al. 2014, WAF 29, 1229; SPC reports and WW 191'),
  },
  {
    id: 'pilger-2014-06-16', text: pilger2014, latitude: 41.3,
    title: () => L('Пилгер, Небраска, 16.06.2014', 'Pilger, Nebraska, 16 June 2014'),
    profile: () => L('Радиозонд OAX (Омаха), специальный выпуск 19 UTC', 'Radiosonde OAX (Omaha), the special 19 UTC release'),
    observed: () => L(
      'Циклическая суперячейка зародилась около 19 UTC на границе оттока и шла на северо-восток со скоростью ~13 м/с. Торнадная фаза 1,5 ч (20:42–22:08 UTC): четыре торнадо EF4, два из них одновременно в 2 км друг от друга. Крупного града почти не отмечено (до 1″), сильных порывов в отчётах нет.',
      'A cyclic supercell formed around 19 UTC on an outflow boundary and moved northeast at ~13 m/s. A tornadic phase of 1.5 h (20:42–22:08 UTC): four EF4 tornadoes, two at once 2 km apart. Hardly any large hail (up to 1″), no severe gusts reported.'),
    compare: () => L(
      'Очень сильная среда: CAPE смешанного слоя ~4000 Дж/кг, SRH 0–3 км ~560 м²/с². Крышка (CIN смешанного слоя ~70 Дж/кг) — в природе её пробила граница оттока, в модели — подталкивание. Сравнивайте тип, движение, цикличность мезоциклона и время жизни.',
      'A very strong environment: mixed-layer CAPE ~4000 J/kg, 0–3 km SRH ~560 m²/s². A cap (mixed-layer CIN ~70 J/kg) — in nature an outflow boundary broke it, in the model the nudging does. Compare the type, the motion, the mesocyclone’s cycling and the storm’s life.'),
    sources: () => L('NWS Омаха (weather.gov/oax/event_archive_20140616); WW 303 и сводки SPC', 'NWS Omaha (weather.gov/oax/event_archive_20140616); SPC WW 303 and reports'),
  },
]
