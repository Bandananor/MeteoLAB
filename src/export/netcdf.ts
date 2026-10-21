/**
 * A NetCDF classic (CDF-1) writer, no dependencies (roadmap E2): dimensions, global and variable attributes, fixed-size
 * variables, big-endian as the format says. Read by xarray, netCDF4, MetPy, Panoply, ncdump. Classic is enough here:
 * the fields of a run are a few MB, far under its 2 GB offsets.
 */

/** NetCDF external types: char, int, float, double. */
const NC = { char: 2, int: 4, float: 5, double: 6 } as const
const SIZE = { char: 1, int: 4, float: 4, double: 8 } as const
const TAG = { dimension: 10, variable: 11, attribute: 12 } as const

export type NcType = keyof typeof NC
export type NcAttribute = string | number | readonly number[]
export interface NcVariable {
  name: string
  /** Its dimensions' names, slowest first (C order). */
  dims: readonly string[]
  type: 'float' | 'double' | 'int'
  data: ArrayLike<number>
  attrs?: Record<string, NcAttribute>
}
export interface NcFile { dims: Record<string, number>; attrs: Record<string, NcAttribute>; vars: readonly NcVariable[] }

const pad4 = (n: number) => (n + 3) & ~3
const utf8 = new TextEncoder()

/** The bytes of a NetCDF classic file. */
export function writeNetCDF(file: NcFile): Uint8Array<ArrayBuffer> {
  const dimNames = Object.keys(file.dims), dimIndex = new Map(dimNames.map((d, k) => [d, k]))
  for (const v of file.vars) {
    const length = v.dims.reduce((n, d) => { const size = file.dims[d]; if (size === undefined) throw new Error(`${v.name}: no dimension ${d}`); return n * size }, 1)
    if (v.data.length !== length) throw new Error(`${v.name}: ${v.data.length} values for ${length}`)
  }
  // The header first with every variable's offset 0, then once more with the offsets (the header's size does not change).
  const header = (begins: number[]) => {
    const out: number[] = [], int = (n: number) => out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
    const bytes = (b: Uint8Array) => { for (const x of b) out.push(x); while (out.length % 4) out.push(0) }
    const name = (s: string) => { const b = utf8.encode(s); int(b.length); bytes(b) }
    const attrs = (a: Record<string, NcAttribute> = {}) => {
      const keys = Object.keys(a)
      if (!keys.length) { int(0); int(0); return }
      int(TAG.attribute); int(keys.length)
      for (const k of keys) {
        name(k); const v = a[k]
        if (typeof v === 'string') { const b = utf8.encode(v); int(NC.char); int(b.length); bytes(b); continue }
        // Numbers: whole ones as int, others as double.
        const values = typeof v === 'number' ? [v] : v, whole = values.every(x => Number.isInteger(x) && Math.abs(x) < 2 ** 31)
        int(whole ? NC.int : NC.double); int(values.length)
        const view = new DataView(new ArrayBuffer(values.length * (whole ? 4 : 8)))
        values.forEach((x, i) => whole ? view.setInt32(i * 4, x) : view.setFloat64(i * 8, x))
        bytes(new Uint8Array(view.buffer))
      }
    }
    out.push(67, 68, 70, 1)
    int(0) // numrecs: no record dimension
    if (dimNames.length) { int(TAG.dimension); int(dimNames.length); for (const d of dimNames) { name(d); int(file.dims[d]) } } else { int(0); int(0) }
    attrs(file.attrs)
    if (file.vars.length) {
      int(TAG.variable); int(file.vars.length)
      file.vars.forEach((v, k) => {
        name(v.name); int(v.dims.length); for (const d of v.dims) int(dimIndex.get(d)!)
        attrs(v.attrs); int(NC[v.type]); int(Math.min(pad4(v.data.length * SIZE[v.type]), 2 ** 31 - 1)); int(begins[k])
      })
    } else { int(0); int(0) }
    return out
  }
  const size = header(file.vars.map(() => 0)).length, begins: number[] = []
  let offset = size
  for (const v of file.vars) { begins.push(offset); offset += pad4(v.data.length * SIZE[v.type]) }
  const head = header(begins), out = new Uint8Array(offset), view = new DataView(out.buffer)
  out.set(head)
  file.vars.forEach((v, k) => {
    let at = begins[k]
    for (let i = 0; i < v.data.length; i++) {
      const x = v.data[i]
      if (v.type === 'float') { view.setFloat32(at, x); at += 4 } else if (v.type === 'double') { view.setFloat64(at, x); at += 8 } else { view.setInt32(at, x); at += 4 }
    }
  })
  return out
}
