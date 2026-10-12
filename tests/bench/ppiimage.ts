// @ts-nocheck
// The radar's PPI of a modelled storm as PNG files (no browser): reflectivity at 0.5° in the NWS palette, smooth pixels
// and radial bins, and the dual-polarisation products, for a look at what the radar screen draws.
//   npx vite build --ssr tests/bench/ppiimage.ts --outDir .bench/ppiimage && node .bench/ppiimage/ppiimage.js <scenario> [minutes=30] [outDir=.]
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { AtmosphereModel, DBZ_FLOOR, DT, PPI, SCENARIOS } from '../../src/core'
import { SUMMER_DAY } from '../../src/core/fixtures'
import { BUILTIN, lookup, lutIndex } from '../../src/radar/palettes'

const [name = 'Классическая суперячейка', minutes = '30', out = '.'] = process.argv.slice(2)
const model = new AtmosphereModel({ ...SUMMER_DAY, ...SCENARIOS.find(s => s.name === name).values })
for (let t = DT; t <= Number(minutes) * 60; t += DT) { model.step(DT); model.time += DT }

const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1 } return ~c >>> 0 }
const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
function png(file: string, w: number, h: number, rgba: Uint8Array, scale: number) {
  const W = w * scale, H = h * scale, raw = Buffer.alloc((W * 4 + 1) * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (Math.floor(y / scale) * w + Math.floor(x / scale)) * 4, d = y * (W * 4 + 1) + 1 + x * 4; raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2]; raw[d + 3] = 255 }
  const head = Buffer.alloc(13); head.writeUInt32BE(W); head.writeUInt32BE(H, 4); head[8] = 8; head[9] = 6
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
const { width, depth } = model.grid, ppi = new PPI(model, Math.round(width / 125), Math.round(depth / 125))
// The radar 15 km south-west of the strongest echo, so the storm is seen at range.
ppi.dual = true; ppi.sample()
let best = 0; for (let i = 1; i < ppi.dbz.length; i++) if (ppi.dbz[i] > ppi.dbz[best]) best = i
const core = ppi.ground(best % ppi.w, Math.floor(best / ppi.w))
ppi.site = { x: core.x - 15000, y: core.y - 15000 }
const paint = (kind, palette, values) => {
  const lut = lookup(BUILTIN.find(p => p.id === palette)), rgba = new Uint8Array(values.length * 4)
  for (let i = 0; i < values.length; i++) { const v = values[i], k = kind === 'Z' && v <= DBZ_FLOOR + 1 ? -1 : lutIndex(kind, v); const o = i * 4; if (k < 0) { rgba[o] = 17; rgba[o + 1] = 21; rgba[o + 2] = 26 } else rgba.set(lut.subarray(k * 4, k * 4 + 3), o) }
  return rgba
}
for (const [tag, bins] of [['smooth', null], ['beam05', { gate: 250, beam: .5 }], ['beam1', { gate: 250, beam: 1 }]]) {
  ppi.bins = bins; ppi.layout(); ppi.sample()
  png(`${out}/ppi-z-${tag}.png`, ppi.w, ppi.h, paint('Z', 'z-nws', ppi.dbz), 3)
  if (tag === 'beam05') { png(`${out}/ppi-zdr.png`, ppi.w, ppi.h, paint('ZDR', 'zdr-classic', ppi.zdr), 3); png(`${out}/ppi-rho.png`, ppi.w, ppi.h, paint('RHO', 'rho-classic', ppi.rho), 3) }
}
console.log(`${name} at ${minutes} min: max ${ppi.dbz[best].toFixed(0)} dBZ; images in ${out}`)
