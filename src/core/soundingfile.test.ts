import { describe, expect, it } from 'vitest'
import { AtmosphereModel, CP, createGrid, DT, domainGrid, Environment, environmentProfile, G, KAPPA, parcelIndices, parseSounding, SoundingError, soundingProfile, stormIndices } from '.'
import { SUMMER_DAY } from './fixtures'
import oax2014 from '../../tests/fixtures/soundings/oax-2014-06-16-19z.sharppy?raw'
import oun1999 from '../../tests/fixtures/soundings/oun-1999-05-04-00z.txt?raw'
import oun2011 from '../../tests/fixtures/soundings/oun-2011-05-22-12z.txt?raw'
import smolensk from '../../tests/fixtures/soundings/smolensk-2024-07-04-12z.html?raw'
import wk82 from '../../tests/fixtures/soundings/weisman-klemp.input_sounding?raw'

// Real soundings (tests/fixtures/soundings/README.md: sources) and small hand-made files of the other formats.
const FILES: Record<string, string> = { 'oun-1999-05-04-00z.txt': oun1999, 'oun-2011-05-22-12z.txt': oun2011, 'oax-2014-06-16-19z.sharppy': oax2014 }
const fixture = (name: string) => FILES[name]
const KT = .514444

describe('sounding files (2.2): reading the formats', () => {
  it('University of Wyoming TEXT:LIST: the 4 May 1999 Norman sounding, from the station up', () => {
    const s = parseSounding(fixture('oun-1999-05-04-00z.txt'))
    expect(s.format).toBe('wyoming')
    // 1000 hPa at -7 m is below the ground (no temperature): the station is the 959 hPa level at 345 m.
    expect(s.elevation).toBe(345)
    const ground = s.levels[0]
    expect(ground).toMatchObject({ p: 95900, z: 0, t: 22.2, td: 19 })
    // 160° at 18 kt: wind from the south-south-east, blowing north-north-west.
    expect(ground.u).toBeCloseTo(-18 * KT * Math.sin(160 * Math.PI / 180), 6); expect(ground.v).toBeCloseTo(-18 * KT * Math.cos(160 * Math.PI / 180), 6)
    expect(ground.v!).toBeGreaterThan(0)
    // 500 hPa at 5670 m; the file ends at 10058 m.
    expect(s.levels.find(l => l.p === 50000)).toMatchObject({ z: 5670 - 345, t: -14.9, td: -18.9 })
    expect(s.levels[s.levels.length - 1].z).toBe(10058 - 345)
    for (let k = 1; k < s.levels.length; k++) { expect(s.levels[k].z).toBeGreaterThan(s.levels[k - 1].z); expect(s.levels[k].p).toBeLessThan(s.levels[k - 1].p) }
  })

  it('reads the title of a full Wyoming page, also inside its HTML', () => {
    const text = fixture('oun-2011-05-22-12z.txt'), s = parseSounding(text)
    expect(s.station).toBe('72357 OUN Norman'); expect(s.time).toBe('12Z 22 May 2011')
    expect(s.levels[s.levels.length - 1]).toMatchObject({ p: 10000, t: -64.3 })
    const html = parseSounding(`<HTML><TITLE>University of Wyoming</TITLE><BODY><H2>${text.split('\n')[0]}</H2>\n<PRE>${text.split('\n').slice(1).join('\n')}</PRE><H3>Station information</H3><PRE>\n Station latitude: 35.18\n Station elevation: 357.0\n</PRE></BODY></HTML>`)
    expect(html.levels).toEqual(s.levels); expect(html.latitude).toBe(35.18); expect(html.elevation).toBe(357)
  })

  it('the newer Wyoming page (2025): wind speed SPED in m/s, not SKNT in knots; title and elevation in the new places', () => {
    // A user's report 12.10.2026: this page gave zero wind (the speed column was not found) and a false «knots» note.
    const s = parseSounding(smolensk)
    expect(s.format).toBe('wyoming'); expect(s.station).toBe('26781 SMOLENSK'); expect(s.time).toBe('12 UTC 04 Jul 2024')
    expect(s.latitude).toBe(54.75); expect(s.elevation).toBe(239)
    // 980 hPa at 239 m: 110° at 3.0 m/s (from the east-south-east).
    expect(s.levels[0]).toMatchObject({ p: 98000, z: 0, t: 29.4, td: 21.4 })
    expect(Math.hypot(s.levels[0].u!, s.levels[0].v!)).toBeCloseTo(3, 6); expect(s.levels[0].u!).toBeCloseTo(-3 * Math.sin(110 * Math.PI / 180), 6)
    // 500 hPa: 180° at 18 m/s; only the top level (24.8 hPa) has no wind in the data.
    const l500 = s.levels.find(l => l.p === 50000)!
    expect(l500.v!).toBeCloseTo(18, 6); expect(s.levels.filter(l => l.u === null)).toHaveLength(1)
    expect(s.notes.some(n => n.includes('узлов'))).toBe(false)
    // Shear 0-6 km is no longer zero.
    const sp = soundingProfile(s, 20_000), env = new Environment(SUMMER_DAY, createGrid(domainGrid(undefined)), sp.profile), [u0, v0] = env.windUV(0), [u6, v6] = env.windUV(6000)
    expect(Math.hypot(u6 - u0, v6 - v0)).toBeGreaterThan(10)
  })

  it('SHARPpy %RAW%: -9999 is missing, wind in knots, heights above the station', () => {
    const s = parseSounding(fixture('oax-2014-06-16-19z.sharppy'))
    expect(s.format).toBe('sharppy'); expect(s.station).toBe('OAX'); expect(s.time).toBe('140616/1900')
    // 1000 hPa (34 m) has no temperature: the station is 965 hPa at 350 m.
    expect(s.elevation).toBe(350)
    expect(s.levels[0]).toMatchObject({ p: 96500, z: 0, t: 27.8, td: 23.8 })
    expect(Math.hypot(s.levels[0].u!, s.levels[0].v!)).toBeCloseTo(23 * KT, 6)
    // 962 hPa has no wind: kept, with the wind missing (interpolated later), and said so.
    expect(s.levels[1]).toMatchObject({ p: 96200, u: null, v: null })
    expect(s.notes.some(n => n.includes('без ветра'))).toBe(true)
    expect(s.levels[s.levels.length - 1].z).toBeGreaterThan(32_000)
  })

  it('CM1 / WRF input_sounding: pressure from the hydrostatic equation, temperature and dew point from theta and vapour', () => {
    // A dry neutral layer (theta 300 K, no vapour): pi(z) = pi0 - g z / (cp theta) exactly.
    const text = ['1000.0 300.0 0.0', ...[0, 1000, 2000, 5000, 10000, 15000].map(z => `${z} 300.0 0.0 5.0 -2.0`)].join('\n')
    const s = parseSounding(text)
    expect(s.format).toBe('input_sounding')
    for (const l of s.levels) {
      const pi = 1 - G * l.z / (CP * 300)
      expect(l.p / 1e5).toBeCloseTo(pi ** (1 / KAPPA), 6); expect(l.t + 273.15).toBeCloseTo(300 * pi, 6)
    }
    expect(s.levels[1]).toMatchObject({ u: 5, v: -2, qv: 0 })
    // With vapour: the dew point is the one at which that vapour saturates.
    const moist = parseSounding('950.0 300.0 14.0\n0 300.0 14.0 0 0\n500 300.5 13.0 1 0\n1000 301.0 12.0 2 0\n2000 303.0 9.0 3 0\n5000 312.0 3.0 4 0')
    expect(moist.levels[0].qv).toBeCloseTo(.014, 9); expect(moist.levels[0].td!).toBeGreaterThan(18); expect(moist.levels[0].td!).toBeLessThan(19.5)
  })

  it('CSV with a header: any column order, knots or m/s, kelvin, humidity instead of dew point, only pressure or only height', () => {
    const wy = 'pres,hght,temp,dwpt,drct,sknt\n1000,100,25,20,180,10\n925,780,20,16,200,20\n850,1500,15,10,220,30\n700,3100,5,-2,240,35\n500,5700,-12,-25,250,45\n300,9300,-40,-50,260,60'
    const a = parseSounding(wy)
    expect(a.format).toBe('csv'); expect(a.levels[0]).toMatchObject({ p: 100000, z: 0, t: 25, td: 20 }); expect(a.levels[0].v!).toBeCloseTo(10 * KT, 6)
    // Semicolons, u and v in m/s, kelvin, relative humidity, no heights (from the hydrostatic equation).
    const b = parseSounding('pressure;temperature;rh;u;v\n1000;298,15;70;3;4\n900;292;60;5;5\n800;286;50;8;6\n700;279;40;10;6\n500;262;30;15;5\n300;233;20;20;5')
    expect(b.levels[0]).toMatchObject({ u: 3, v: 4 }); expect(b.levels[0].t).toBeCloseTo(25, 9); expect(b.levels[0].td!).toBeCloseTo(19.1, 0)
    // ~1 km from 1000 to 900 hPa in this air.
    expect(b.levels[1].z).toBeGreaterThan(850); expect(b.levels[1].z).toBeLessThan(1000)
    expect(b.notes.some(n => n.includes('гидростатике'))).toBe(true)
    // Only heights: pressure from 1013.25 hPa at the ground.
    const c = parseSounding('height,temp,dwpt\n0,20,15\n1000,14,10\n3000,2,-5\n6000,-18,-30\n10000,-45,-60')
    expect(c.levels[0].p).toBeCloseTo(101325, 6); expect(c.levels[4].p).toBeGreaterThan(24000); expect(c.levels[4].p).toBeLessThan(29000)
  })

  it('refuses what it cannot read, with a message for the user', () => {
    expect(() => parseSounding('просто текст\nбез таблицы')).toThrow(SoundingError)
    expect(() => parseSounding('pres,temp\n1000,20\n900,14')).toThrow(/мало/)
    expect(() => parseSounding('a;b;c\n1;2;3\n4;5;6')).toThrow(/температура/)
  })
})

describe('sounding files (2.2): the model environment from a sounding', () => {
  const grid = createGrid(domainGrid(undefined))
  const envOf = (text: string) => { const sp = soundingProfile(parseSounding(text), grid.height + 2000); return { sp, env: new Environment(SUMMER_DAY, grid, sp.profile) } }
  /** Dew point of the environment at height z, °C (inverse of qsatP). */
  const dew = (env: Environment, z: number) => { const q = env.qEnv(z), e = q * env.pressureAt(z) / (.622 + q), l = Math.log(e / 611.2); return 243.5 * l / (17.67 - l) }

  it('keeps the station pressure, temperature, dew point and wind of the file at its levels', () => {
    const { env } = envOf(fixture('oun-2011-05-22-12z.txt'))
    // 966 hPa at the ground; the model integrates its own hydrostatic pressure from there.
    expect(env.pressureAt(0)).toBeCloseTo(96600, 6)
    expect(env.temperatureEnv(0)).toBeCloseTo(22.2, 1); expect(dew(env, 0)).toBeCloseTo(21, 1)
    // 500 hPa: 5800 m in the file (above 345 m), -12.5 °C; the model's own pressure there within ~1 hPa.
    const file = parseSounding(fixture('oun-2011-05-22-12z.txt')), l500 = file.levels.find(l => l.p === 50000)!
    expect(Math.abs(env.pressureAt(l500.z) - 50000)).toBeLessThan(150)
    expect(env.temperatureEnv(l500.z)).toBeCloseTo(l500.t, 0); expect(dew(env, l500.z)).toBeCloseTo(l500.td!, 0)
    const [u, v] = env.windUV(l500.z)
    expect(u).toBeCloseTo(l500.u!, 6); expect(v).toBeCloseTo(l500.v!, 6)
  })

  it('surface-based CAPE and CIN close to MetPy on the same files (tests/reference/metpy_soundings.py)', () => {
    // MetPy 1.7.1 from the files' own levels: Norman 22 May 2011 12Z SB CAPE 3297, CIN -128; Omaha 16 June 2014 19Z 5682, 0.
    for (const [name, cape, cin] of [['oun-2011-05-22-12z.txt', 3297, -128], ['oax-2014-06-16-19z.sharppy', 5682, 0]] as const) {
      const { env } = envOf(fixture(name)), i = parcelIndices(env, grid.height)
      console.log(`${name}: SB CAPE ${i.sb.cape.toFixed(0)} (MetPy ${cape}), CIN ${i.sb.cin.toFixed(0)} (MetPy ${-cin})`)
      expect(Math.abs(i.sb.cape - cape) / cape).toBeLessThan(.05)
      expect(Math.abs(i.sb.cin - -cin)).toBeLessThan(Math.max(15, .15 * -cin))
    }
    // The 2011 morning: strong low-level shear and helicity for the Joplin afternoon.
    const { env } = envOf(fixture('oun-2011-05-22-12z.txt')), k = stormIndices(env, parcelIndices(env, grid.height))
    expect(k.shear06).toBeGreaterThan(15)
  })

  it('goes on above the top of the data, and refuses a sounding that ends below 10 km', () => {
    const { sp, env } = envOf(fixture('oun-2011-05-22-12z.txt'))
    expect(sp.top).toBeLessThan(grid.height); expect(sp.notes.some(n => n.includes('Выше'))).toBe(true)
    expect(env.temperatureEnv(grid.height)).toBeGreaterThan(-81); expect(env.temperatureEnv(grid.height)).toBeLessThan(-40)
    // The 4 May 1999 file stops at 9.7 km above the station.
    expect(() => soundingProfile(parseSounding(fixture('oun-1999-05-04-00z.txt')), grid.height)).toThrow(/10 км/)
  })

  it('warms a layer that would overturn by itself to neutral, and says where', () => {
    // A superadiabatic 500 m at 3-3.5 km (the air colder by 3 K than a neutral layer would be).
    const levels = [0, 1000, 2000, 3000, 3500, 4000, 6000, 9000, 12000, 15000].map(z => {
      const t = 25 - 6.5 * z / 1000 - (z === 3500 ? 3 : 0), p = 100000 * Math.exp(-z / 8000)
      return { p, z, t, td: t - 10, u: 5, v: 0 }
    })
    const sp = soundingProfile({ levels }, 16_000), env = new Environment(SUMMER_DAY, grid, sp.profile)
    expect(sp.notes.some(n => /Неустойчивых уровней .*: 1, .* на 3,5 км/.test(n))).toBe(true)
    let level = 0
    for (let z = 0; z <= 15_000; z += 100) { const thv = env.thetaEnv(z) * (1 + .61 * env.qEnv(z)); expect(thv).toBeGreaterThan(level - 1e-3); level = Math.max(level, thv) }
  })

  it('runs the model in a loaded sounding (config.sounding), the environment built from it in every thread alike', () => {
    const file = parseSounding(fixture('oax-2014-06-16-19z.sharppy')), model = new AtmosphereModel({ ...SUMMER_DAY, sounding: { name: 'OAX', levels: file.levels } })
    expect(model.env.pressureAt(0)).toBeCloseTo(96500, 6); expect(model.env.temperatureEnv(0)).toBeCloseTo(27.8, 1)
    for (let k = 0; k < 20; k++) { model.step(DT); model.time += DT }
    expect(model.clipped).toBe(0); expect(model.theta.every(Number.isFinite)).toBe(true)
    // The thermal has started to rise (one model minute: ~1 m/s).
    expect(model.diagnostics().updraft).toBeGreaterThan(.3)
  })

  it('WK from a file: the Weisman-Klemp case written as a CM1 input_sounding gives the environment and the storm of the formulas', () => {
    // tests/fixtures/soundings/weisman-klemp.input_sounding: the model's own WK environment every 250 m to 22 km.
    const wk = { ...SUMMER_DAY, profile: 'weisman-klemp' as const, solarMax: 0, bubble: 1.5 }
    const formulas = new Environment(wk, grid, environmentProfile(wk, grid.height)), file = parseSounding(wk82)
    expect(file.format).toBe('input_sounding')
    const sp = soundingProfile(file, grid.height + 2000), loaded = new Environment(wk, grid, sp.profile)
    // Nothing to extend and nothing to neutralise: the environment is used as written.
    expect(sp.notes.some(n => n.includes('Выше') || n.includes('Неустойчивых'))).toBe(false)
    for (let z = 0; z <= grid.height; z += 37) {
      expect(Math.abs(loaded.thetaEnv(z) - formulas.thetaEnv(z))).toBeLessThan(.05)
      expect(Math.abs(loaded.qEnv(z) - formulas.qEnv(z))).toBeLessThan(2e-4)
      expect(Math.abs(loaded.pressureAt(z) - formulas.pressureAt(z))).toBeLessThan(1)
      const [u, v] = loaded.windUV(z), [uf, vf] = formulas.windUV(z)
      expect(Math.hypot(u - uf, v - vf)).toBeLessThan(.06)
    }
    const i = parcelIndices(formulas, grid.height), j = parcelIndices(loaded, grid.height), k = stormIndices(formulas, i), l = stormIndices(loaded, j)
    expect(Math.abs(j.sb.cape - i.sb.cape) / i.sb.cape).toBeLessThan(.005); expect(Math.abs(j.ml.cape - i.ml.cape) / i.ml.cape).toBeLessThan(.005)
    expect(Math.abs(l.srh03 - k.srh03) / k.srh03).toBeLessThan(.01); expect(l.shear06).toBeCloseTo(k.shear06, 2)
    // The same thermal in both (one, as in the WK case): six model minutes of its rise agree to 1 %.
    const a = new AtmosphereModel(wk), b = new AtmosphereModel({ ...wk, sounding: { name: 'WK', levels: file.levels } })
    for (let t = 0; t < 360; t += DT) { a.step(DT); a.time += DT; b.step(DT); b.time += DT }
    const da = a.diagnostics(), db = b.diagnostics()
    expect(da.updraft).toBeGreaterThan(6)
    expect(Math.abs(db.updraft - da.updraft) / da.updraft).toBeLessThan(.01); expect(db.cloudTop).toBeCloseTo(da.cloudTop, 1)
  })
})
