import { L } from '../i18n'
import * as THREE from 'three'

/**
 * ?view-report: a plain-text report on how the 3D view renders on this device, for a phone with no console (a tester's
 * Samsung Xclipse 940 shows the sky but black ground and clouds, 25.10.2026). It gives the GPU and its limits, how the
 * driver treats undefined GLSL (x / 0, log 0, pow of a negative), whether the light volume's layers were written, and
 * each part of the view drawn alone into a float target, where NaN stays NaN (an 8-bit screen shows it as black).
 */

/** The parts of the view drawn alone, and the shader switches tried on them (VIEW_SAFE_*, as ?view-safe sets them). */
export interface ReportParts {
  sky: THREE.Object3D; ground: THREE.Object3D; clouds: THREE.Object3D
  /** The cloud's and the ground's materials: a switch goes into their defines (each change recompiles them). */
  materials: THREE.Material[]
  light: THREE.WebGL3DRenderTarget; safe: string[]
  /** The numbers the shaders get (the haze, the fog, the lights...) and the model's fields' NaN, as text lines. */
  values: () => string[]
  /** More tries: a part drawn with one thing changed (set returns the undo). */
  extra: { label: string; part: THREE.Object3D; set: () => () => void }[]
}

const fmt = (v: number) => Number.isNaN(v) ? 'NaN' : !Number.isFinite(v) ? (v > 0 ? '+Inf' : '-Inf') : Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(2) : v.toFixed(3)

/** The GPU, the browser and the limits that matter for the view. */
function deviceLines(gl: WebGL2RenderingContext) {
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const hi = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
  const ext = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear', 'EXT_float_blend']
  return [
    `GPU: ${info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) + ' / ' + gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`,
    `GL: ${gl.getParameter(gl.VERSION)}; ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${innerWidth}x${innerHeight} css, dpr ${devicePixelRatio}, buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
    `highp float: precision ${hi?.precision}, range 2^${hi?.rangeMax}; max 3D texture ${gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)}, 2D ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`,
    `Extensions: ${ext.map(e => `${e} ${gl.getSupportedExtensions()?.includes(e) ? 'yes' : 'no'}`).join(', ')}`,
  ]
}

/** What the driver returns for GLSL the standard leaves undefined, one value per pixel of a float target. */
const PROBES: [string, string][] = [['1/0', '1.0 / uZero'], ['-1/0', '-1.0 / uZero'], ['0/0', 'uZero / uZero'], ['log(0)', 'log(uZero)'], ['pow(-1,2)', 'pow(-uOne, 2.0)'], ['sqrt(-1)', 'sqrt(-uOne)'], ['normalize(0)', 'normalize(vec3(uZero)).x'], ['clamp(1/0)', 'clamp(1.0 / uZero, 0.0, 1.0)'], ['max(NaN,1)', 'max(uZero / uZero, 1.0)']]

function probeLines(renderer: THREE.WebGLRenderer, float: boolean) {
  if (!float) return ['Undefined GLSL: no float render target (EXT_color_buffer_float), not measured']
  const target = new THREE.WebGLRenderTarget(PROBES.length, 1, { type: THREE.FloatType, depthBuffer: false })
  const material = new THREE.ShaderMaterial({
    uniforms: { uZero: { value: 0 }, uOne: { value: 1 } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;\nuniform float uZero;\nuniform float uOne;\nvoid main(){\n  int i = int(gl_FragCoord.x);\n  float v = 0.0;\n${PROBES.map(([, e], k) => `  if(i == ${k}) v = ${e};`).join('\n')}\n  gl_FragColor = vec4(v, 0.0, 0.0, 1.0);\n}`,
  })
  const scene = new THREE.Scene(), quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material); quad.frustumCulled = false; scene.add(quad)
  const out = new Float32Array(PROBES.length * 4)
  renderer.setRenderTarget(target); renderer.render(scene, new THREE.Camera()); renderer.readRenderTargetPixels(target, 0, 0, PROBES.length, 1, out); renderer.setRenderTarget(null)
  target.dispose(); material.dispose(); quad.geometry.dispose()
  return [`Undefined GLSL: ${PROBES.map(([name], k) => `${name} = ${fmt(out[k * 4])}`).join(', ')}`]
}

/** The light volume at its top and bottom layer: in clear air at the top the sky is seen whole (G near 1). */
function lightLines(renderer: THREE.WebGLRenderer, gl: WebGL2RenderingContext, light: THREE.WebGL3DRenderTarget) {
  const { width: nx, height: ny, depth: nz } = light, buf = new Uint8Array(nx * ny * 4), lines: string[] = []
  for (const [name, layer] of [['top', nz - 1], ['middle', nz >> 1], ['bottom', 0]] as const) {
    renderer.setRenderTarget(light, layer)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.readPixels(0, 0, nx, ny, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let r = 0, g = 0, gMin = 255, gMax = 0
    for (let k = 0; k < nx * ny; k++) { r += buf[k * 4]; g += buf[k * 4 + 1]; gMin = Math.min(gMin, buf[k * 4 + 1]); gMax = Math.max(gMax, buf[k * 4 + 1]) }
    const n = nx * ny * 255
    lines.push(`Light ${name} layer ${layer}: framebuffer ${status === gl.FRAMEBUFFER_COMPLETE ? 'complete' : '0x' + status.toString(16)}, sun depth R ${fmt(r / n)}, sky G ${fmt(g / n)} (${fmt(gMin / 255)}-${fmt(gMax / 255)})`)
  }
  renderer.setRenderTarget(null)
  return lines
}

/** One part of the view drawn alone into a float target: how many of its pixels are NaN, infinite, black or fine. */
function partLine(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, part: THREE.Object3D, name: string, float: boolean) {
  const w = 96, h = 64, target = new THREE.WebGLRenderTarget(w, h, { type: float ? THREE.FloatType : THREE.UnsignedByteType })
  // The lights stay: the part is drawn as on the screen.
  const shown = scene.children.map(c => c.visible)
  scene.children.forEach(c => { c.visible = c === part || ((c as THREE.Light).isLight === true && c.visible) })
  const color = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha()
  renderer.setClearColor(0, 0); renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, camera)
  const out = float ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4)
  renderer.readRenderTargetPixels(target, 0, 0, w, h, out)
  renderer.setRenderTarget(null); renderer.setClearColor(color, alpha); target.dispose()
  scene.children.forEach((c, k) => { c.visible = shown[k] })
  const scale = float ? 1 : 255
  let drawn = 0, nan = 0, inf = 0, black = 0, sum = 0
  for (let k = 0; k < w * h; k++) {
    const r = out[k * 4] / scale, g = out[k * 4 + 1] / scale, b = out[k * 4 + 2] / scale, a = out[k * 4 + 3] / scale
    if ([r, g, b, a].some(Number.isNaN)) { nan++; continue }
    if ([r, g, b, a].some(v => !Number.isFinite(v))) { inf++; continue }
    if (a <= 0 && r + g + b <= 0) continue
    drawn++
    if (r + g + b < 1e-4) black++; else sum += (r + g + b) / 3
  }
  return `${name}: ${drawn + nan + inf} of ${w * h} px drawn; NaN ${nan}, Inf ${inf}, black ${black}, mean of the rest ${fmt(sum / Math.max(drawn - black, 1))}`
}

/** The whole report; leaves the renderer and the view as they were (the switches tried are put back). */
export function viewReport(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, parts: ReportParts): string {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const float = !!gl.getExtension('EXT_color_buffer_float')
  const lines = [`MeteoLab view report, ${new Date().toISOString()}, ${location.pathname}`, ...deviceLines(gl)]
  if (parts.safe.length) lines.push(`?view-safe: ${parts.safe.join(',')}`)
  lines.push(...parts.values())
  // A switch ?view-safe already set is in the shaders (a second #define of it would not compile): not tried again.
  const tries: [string, string | null][] = [['as drawn', null], ['no air shading (VIEW_SAFE_AIR)', 'VIEW_SAFE_AIR'], ['constant sun (VIEW_SAFE_LIGHT)', 'VIEW_SAFE_LIGHT']]
  const set = { VIEW_SAFE_AIR: 'air', VIEW_SAFE_LIGHT: 'light' } as const
  const before = parts.materials.map(m => m.defines)
  const restore = () => parts.materials.forEach((m, k) => { m.defines = before[k]; m.needsUpdate = true })
  try {
    const off = (part: string) => parts.safe.includes(part) || parts.safe.includes('all')
    lines.push(...probeLines(renderer, float), ...(off('light') ? ['Light volume: not computed (?view-safe light)'] : lightLines(renderer, gl, parts.light)))
    lines.push(`Parts drawn alone into a ${float ? 'float' : '8-bit (NaN shows as black)'} target:`)
    lines.push('  ' + partLine(renderer, scene, camera, parts.sky, 'sky', float))
    for (const [label, key] of tries) {
      if (key && (parts.safe.includes(set[key as keyof typeof set]) || parts.safe.includes('all'))) continue
      restore()
      if (key) parts.materials.forEach(m => { m.defines = { ...m.defines, [key]: '' } })
      lines.push(`  [${label}] ` + partLine(renderer, scene, camera, parts.ground, 'ground', float))
      lines.push(`  [${label}] ` + (off('clouds') ? 'clouds: off (?view-safe clouds)' : partLine(renderer, scene, camera, parts.clouds, 'clouds', float)))
    }
    for (const t of parts.extra) {
      const undo = t.set()
      try { lines.push(`  [${t.label}] ` + partLine(renderer, scene, camera, t.part, t.part === parts.sky ? 'sky' : t.part === parts.ground ? 'ground' : 'clouds', float)) } finally { undo() }
    }
  } catch (e) {
    lines.push(`Report failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    restore(); renderer.setRenderTarget(null)
  }
  return lines.join('\n')
}

/** The panel, one per page: a restarted run makes a new view, which takes the panel over. */
let current: { take: () => void; show: (report: string) => void; taken: boolean } | undefined

/**
 * The report's panel over the page: the text, a button to take it (with a storm on screen), copy and close. Returns the
 * setter of its text, and whether no report was taken yet (then the view takes one by itself).
 */
export function reportPanel(take: () => void): [(report: string) => void, boolean] {
  if (current) { current.take = take; return [current.show, !current.taken] }
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;max-height:45vh;z-index:9999;display:flex;flex-direction:column;gap:6px;padding:8px;background:rgba(10,16,22,.94);color:#dfe8ee;border:1px solid #3a4a56;border-radius:6px;font:11px/1.35 ui-monospace,Consolas,monospace'
  const text = document.createElement('pre'); text.style.cssText = 'margin:0;overflow:auto;white-space:pre-wrap;word-break:break-word;flex:1'
  text.textContent = L('Отчёт о 3D-виде: нажмите «Снять», когда на экране облако (и чёрное, если оно чёрное).', '3D view report: press "Take" with a cloud on screen (a black one, if it is black).')
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap'
  const button = (label: string, act: () => void) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'font:inherit;padding:4px 10px;background:#22313c;color:inherit;border:1px solid #4a5d6b;border-radius:4px'; b.onclick = act; row.append(b); return b }
  button(L('Снять', 'Take'), () => current?.take())
  const copy = button(L('Копировать', 'Copy'), () => {
    const done = () => { copy.textContent = L('Скопировано', 'Copied') }
    navigator.clipboard?.writeText(text.textContent ?? '').then(done, () => { getSelection()?.selectAllChildren(text) })
  })
  button(L('Закрыть', 'Close'), () => panel.remove())
  panel.append(row, text); document.body.append(panel)
  current = { take, taken: false, show: report => { current!.taken = true; text.textContent = report; copy.textContent = L('Копировать', 'Copy') } }
  return [current.show, true]
}
