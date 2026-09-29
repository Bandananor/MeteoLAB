import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { type AtmosphereModel, computeScalarField, MESO_PERSISTENCE, sunDirection, UH_ROTATING } from '../core'
import { clamp, lerp, mod, mulberry32 } from '../core/math'
import { colormapTexture, FIELDS, type FieldMode } from './fields'
import { fieldVolumeFragment, groundShadowPars, precipFragment, precipVertex, sliceFragment, volumeFragment, volumeVertex } from './shaders'

/** How a field layer is drawn: opaque slices with a volume of strong deviations, slices only, or the whole field as a volume. */
export type LayerMode = 'both' | 'slices' | 'volume'

export interface ViewSettings {
  field: FieldMode; showVectors: boolean; showPrecip: boolean; layerMode: LayerMode
  /** 'volume' mode: fraction of the colour range below which the field is transparent (0 shows everything). */ volumeThreshold: number
  /** 'volume' mode: opacity multiplier of the field volume. */ volumeDensity: number
  /** Horizontal slice height, km. */ sliceHeight: number
  /** Vertical north-south slice position, km north of the domain centre. */ sliceNorth: number
}

const FLOW_PARTICLES = 10_000, PRECIP_PARTICLES = 8000, MELT_DEPTH = 600, SNOW_FALL = 2

const texture3D = (data: Uint8Array, format: THREE.PixelFormat, nx: number, ny: number, nz: number) => {
  const t = new THREE.Data3DTexture(data, nx, ny, nz)
  t.format = format; t.type = THREE.UnsignedByteType; t.minFilter = t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.wrapR = THREE.ClampToEdgeWrapping; t.unpackAlignment = 1; t.needsUpdate = true
  return t
}

const softParticleTexture = () => {
  const c = document.createElement('canvas'); c.width = c.height = 64
  const x = c.getContext('2d')!, g = x.createRadialGradient(32, 32, 2, 32, 32, 31)
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.42, 'rgba(255,255,255,.78)'); g.addColorStop(1, 'rgba(255,255,255,0)')
  x.fillStyle = g; x.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * Three.js scene for an AtmosphereModel. World units are km: +X east, +Y up, -Z north;
 * model grid y (north) maps to world -Z so the right-handed scene is not mirrored.
 */
export class StormView {
  private readonly model: AtmosphereModel; private readonly settings: ViewSettings
  private readonly canvas: HTMLCanvasElement; private readonly renderer: THREE.WebGLRenderer; private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera; private readonly controls: OrbitControls
  private readonly ground: THREE.Mesh; private readonly raycaster = new THREE.Raycaster(); private readonly pointer = new THREE.Vector2()
  private readonly sunLight: THREE.DirectionalLight; private readonly hemiLight: THREE.HemisphereLight
  private readonly shared: Record<string, THREE.IUniform>
  private readonly volumeData: Uint8Array; private readonly volumeTexture: THREE.Data3DTexture; private readonly volumeMaterial: THREE.ShaderMaterial; private readonly volumeMesh: THREE.Mesh
  private readonly fieldValues: Float32Array; private readonly fieldData: Uint8Array; private readonly fieldTexture: THREE.Data3DTexture
  private colormap: THREE.DataTexture | null = null; private colormapField: FieldMode | null = null
  private readonly fieldUniforms: Record<string, THREE.IUniform>; private readonly fieldMaterial: THREE.ShaderMaterial; private readonly fieldMesh: THREE.Mesh
  private readonly sliceMaterial: THREE.ShaderMaterial; private readonly sliceH: THREE.Mesh; private readonly sliceV: THREE.Mesh
  private readonly flowGeometry: THREE.BufferGeometry; private readonly flowPoints: THREE.Points; private readonly vectorGeometry: THREE.BufferGeometry; private readonly vectorLines: THREE.LineSegments
  private readonly levelHelpers: THREE.GridHelper[]; private readonly freezingHelper: THREE.GridHelper
  private readonly particleModel = new Float32Array(FLOW_PARTICLES * 3); private readonly particleAge = new Float32Array(FLOW_PARTICLES); private readonly rng: () => number
  private readonly precipModel = new Float32Array(PRECIP_PARTICLES * 3); private readonly precipAge = new Float32Array(PRECIP_PARTICLES); private readonly precipAlive = new Uint8Array(PRECIP_PARTICLES); private precipNext = 0
  private readonly precipGeometry: THREE.BufferGeometry; private readonly precipMaterial: THREE.ShaderMaterial; private readonly precipPoints: THREE.Points
  private readonly mesoMarker: THREE.Mesh
  private frame = 0

  constructor(canvas: HTMLCanvasElement, model: AtmosphereModel, settings: ViewSettings) {
    this.canvas = canvas; this.model = model; this.settings = settings; this.rng = mulberry32(model.config.seed)
    const { nx, ny, nz, n, width, depth, height } = model.grid, W = width / 1000, D = depth / 1000, H = height / 1000
    this.volumeData = new Uint8Array(n * 2); this.fieldValues = new Float32Array(n); this.fieldData = new Uint8Array(n)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x172d3b); this.scene.fog = new THREE.FogExp2(0x172d3b, .012)
    this.camera = new THREE.PerspectiveCamera(42, 1, .1, 180); this.camera.position.set(38, 24, 39)
    this.controls = new OrbitControls(this.camera, canvas); this.controls.target.set(0, 6, 0); this.controls.enableDamping = true; this.controls.dampingFactor = .07; this.controls.maxPolarAngle = Math.PI * .495; this.controls.minDistance = 15; this.controls.maxDistance = 100
    this.hemiLight = new THREE.HemisphereLight(0xd9efff, 0x4b4439, 1.35); this.scene.add(this.hemiLight)
    this.sunLight = new THREE.DirectionalLight(0xfff0d2, 2); this.scene.add(this.sunLight)

    const groundMat = new THREE.MeshStandardMaterial({ color: ({ grass: 0x596d45, dry: 0x776a51, water: 0x315d70, urban: 0x606469 })[model.config.surfaceType], roughness: .96, metalness: 0 })
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(W, D), groundMat); this.ground.rotation.x = -Math.PI / 2; this.scene.add(this.ground)
    const grid = new THREE.GridHelper(W, 16, 0x71838a, 0x485d66); grid.material.transparent = true; grid.material.opacity = .32; this.scene.add(grid)
    const box = new THREE.BoxGeometry(W, H, D); box.translate(0, H / 2, 0)
    this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x75909c, transparent: true, opacity: .4 })))
    this.levelHelpers = [0xb6d4dd, 0xe1bf7e, 0xd88e74].map(color => { const h = new THREE.GridHelper(W, 12, color, color); h.material.transparent = true; h.material.opacity = .18; this.scene.add(h); return h })

    this.shared = {
      uBoxMin: { value: new THREE.Vector3(-W / 2, 0, -D / 2) }, uBoxMax: { value: new THREE.Vector3(W / 2, H, D / 2) }, uGrid: { value: new THREE.Vector3(nx, ny, nz) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uHeight: { value: H }, uExtinction: { value: 2.2 }, uSliceOn: { value: 0 }, uSliceH: { value: 2 }, uSliceZ: { value: 0 },
    }
    this.volumeTexture = texture3D(this.volumeData, THREE.RGFormat, nx, ny, nz)
    this.volumeMaterial = new THREE.ShaderMaterial({
      vertexShader: volumeVertex, fragmentShader: volumeFragment, side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false, premultipliedAlpha: true,
      uniforms: {
        ...this.shared, uDensity: { value: this.volumeTexture }, uSunColor: { value: new THREE.Color() }, uAmbientTop: { value: new THREE.Color() }, uAmbientBottom: { value: new THREE.Color() },
        uFogColor: { value: (this.scene.fog as THREE.FogExp2).color }, uFogDensity: { value: (this.scene.fog as THREE.FogExp2).density }, uTime: { value: 0 }, uOpacity: { value: 1 },
      },
    })
    const volumeBox = new THREE.BoxGeometry(W, H, D); volumeBox.translate(0, H / 2, 0)
    this.volumeMesh = new THREE.Mesh(volumeBox, this.volumeMaterial); this.volumeMesh.renderOrder = 1; this.scene.add(this.volumeMesh)

    this.fieldTexture = texture3D(this.fieldData, THREE.RedFormat, nx, ny, nz)
    this.fieldUniforms = { ...this.shared, uField: { value: this.fieldTexture }, uColormap: { value: null }, uDiverging: { value: 0 }, uThreshold: { value: .3 }, uDensity: { value: 1 } }
    this.fieldMaterial = new THREE.ShaderMaterial({ vertexShader: volumeVertex, fragmentShader: fieldVolumeFragment, side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false, premultipliedAlpha: true, toneMapped: false, uniforms: this.fieldUniforms })
    this.fieldMesh = new THREE.Mesh(volumeBox, this.fieldMaterial); this.fieldMesh.renderOrder = 1.5; this.scene.add(this.fieldMesh)
    this.sliceMaterial = new THREE.ShaderMaterial({ vertexShader: volumeVertex, fragmentShader: sliceFragment, side: THREE.DoubleSide, toneMapped: false, uniforms: this.fieldUniforms })
    const horizontal = new THREE.PlaneGeometry(W, D); horizontal.rotateX(-Math.PI / 2); this.sliceH = new THREE.Mesh(horizontal, this.sliceMaterial); this.scene.add(this.sliceH)
    const vertical = new THREE.PlaneGeometry(W, H); vertical.translate(0, H / 2, 0); this.sliceV = new THREE.Mesh(vertical, this.sliceMaterial); this.scene.add(this.sliceV)

    groundMat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, { ...this.shared, uDensity: this.volumeMaterial.uniforms.uDensity })
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;').replace('#include <project_vertex>', '#include <project_vertex>\nvCloudWorld=(modelMatrix*vec4(transformed,1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${groundShadowPars}`).replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n{float s=cloudShadow(vCloudWorld);reflectedLight.directDiffuse*=s;reflectedLight.directSpecular*=s;}')
    }

    const soft = softParticleTexture()
    this.flowGeometry = new THREE.BufferGeometry(); this.flowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLOW_PARTICLES * 3), 3)); this.flowGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(FLOW_PARTICLES * 3), 3))
    this.flowPoints = new THREE.Points(this.flowGeometry, new THREE.PointsMaterial({ size: .12, map: soft, alphaTest: .03, vertexColors: true, transparent: true, opacity: .82, depthWrite: false })); this.flowPoints.renderOrder = 2; this.scene.add(this.flowPoints)
    this.vectorGeometry = new THREE.BufferGeometry(); this.vectorGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(1800 * 3), 3)); this.vectorGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(1800 * 3), 3))
    this.vectorLines = new THREE.LineSegments(this.vectorGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .72 })); this.scene.add(this.vectorLines)
    this.freezingHelper = new THREE.GridHelper(W, 24, 0x9fd3f0, 0x9fd3f0); this.freezingHelper.material.transparent = true; this.freezingHelper.material.opacity = .28; this.scene.add(this.freezingHelper)
    this.precipGeometry = new THREE.BufferGeometry(); this.precipGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PRECIP_PARTICLES * 3), 3)); this.precipGeometry.setAttribute('aMelt', new THREE.BufferAttribute(new Float32Array(PRECIP_PARTICLES).fill(-1), 1))
    this.precipMaterial = new THREE.ShaderMaterial({ vertexShader: precipVertex, fragmentShader: precipFragment, transparent: true, depthWrite: false, toneMapped: false, uniforms: { uScale: { value: 500 } } })
    this.precipPoints = new THREE.Points(this.precipGeometry, this.precipMaterial); this.precipPoints.frustumCulled = false; this.precipPoints.renderOrder = 2; this.scene.add(this.precipPoints)
    this.mesoMarker = new THREE.Mesh(new THREE.TorusGeometry(2.6, .07, 8, 64), new THREE.MeshBasicMaterial({ color: 0xf0b44c, transparent: true, opacity: .9, depthWrite: false }))
    this.mesoMarker.rotation.x = Math.PI / 2; this.mesoMarker.position.y = 3.5; this.mesoMarker.renderOrder = 3; this.mesoMarker.visible = false; this.scene.add(this.mesoMarker)

    this.updateLevels()
    for (let p = 0; p < FLOW_PARTICLES; p++) this.respawnParticle(p, true)
  }

  dispose() {
    this.controls.dispose()
    ;[this.volumeTexture, this.fieldTexture, this.colormap, this.volumeMaterial, this.fieldMaterial, this.sliceMaterial, this.volumeMesh.geometry, this.sliceH.geometry, this.sliceV.geometry, this.precipGeometry, this.precipMaterial, this.mesoMarker.geometry, this.mesoMarker.material as THREE.Material].forEach(r => r?.dispose())
    this.renderer.dispose()
  }

  /** Model-space position (m from the domain corner) of the ground point under normalised screen coordinates. */
  groundPoint(nx: number, ny: number) {
    const { width, depth } = this.model.grid
    this.pointer.set(nx * 2 - 1, -(ny * 2 - 1)); this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.ground, false)[0]
    return { x: hit ? clamp((hit.point.x + width / 2000) * 1000, 0, width) : width / 2, y: hit ? clamp((depth / 2000 - hit.point.z) * 1000, 0, depth) : depth / 2 }
  }

  /** Moves tracer and precipitation particles by the model time that just elapsed. */
  afterAdvance(seconds: number) {
    if (seconds <= 0) return
    if (this.settings.showVectors) this.updateParticles(seconds)
    if (this.settings.showPrecip) this.updatePrecip(seconds)
  }

  private toWorld(x: number, y: number, z: number) {
    const { width, depth } = this.model.grid
    return [x / 1000 - width / 2000, z / 1000, depth / 2000 - y / 1000] as const
  }

  private updateSun() {
    const s = sunDirection(this.model.config, this.model.time), dir = new THREE.Vector3(s.x, s.y, s.z)
    const day = THREE.MathUtils.smoothstep(dir.y, -.03, .12), warm = THREE.MathUtils.smoothstep(dir.y, 0, .4), u = this.volumeMaterial.uniforms
    ;(this.shared.uSunDir.value as THREE.Vector3).copy(dir)
    ;(u.uSunColor.value as THREE.Color).setRGB(1, lerp(.55, .94, warm), lerp(.3, .84, warm)).multiplyScalar(2.6 * day)
    ;(u.uAmbientTop.value as THREE.Color).setRGB(lerp(.08, .62, day), lerp(.1, .72, day), lerp(.16, .84, day))
    ;(u.uAmbientBottom.value as THREE.Color).setRGB(lerp(.05, .2, day), lerp(.06, .23, day), lerp(.08, .28, day))
    this.sunLight.position.copy(dir).multiplyScalar(50); this.sunLight.intensity = 2 * day; this.sunLight.color.setRGB(1, lerp(.62, .94, warm), lerp(.4, .82, warm))
    this.hemiLight.intensity = .45 + .9 * day
  }

  private updateLevels() {
    const s = this.model.sounding, lv = [s.lcl, s.lfc, s.el]
    this.levelHelpers.forEach((h, i) => { h.visible = lv[i] !== null; if (lv[i] !== null) h.position.y = lv[i]! })
    this.freezingHelper.position.y = s.freezing ?? 0
  }

  private respawnParticle(p: number, full = false) {
    const { width, depth, height } = this.model.grid, j = p * 3
    this.particleModel[j] = this.rng() * width; this.particleModel[j + 1] = this.rng() * depth; this.particleModel[j + 2] = full ? this.rng() * height * .75 : this.rng() * 1800; this.particleAge[p] = this.rng() * 500
  }

  private updateParticles(dt: number) {
    const m = this.model, { dx, dy, dz, width, depth, height } = m.grid
    const pos = this.flowGeometry.getAttribute('position') as THREE.BufferAttribute, col = this.flowGeometry.getAttribute('color') as THREE.BufferAttribute
    for (let p = 0; p < FLOW_PARTICLES; p++) {
      const j = p * 3
      let x = this.particleModel[j], y = this.particleModel[j + 1], z = this.particleModel[j + 2]
      const gx = x / dx, gy = y / dy, gz = z / dz, uu = m.sample(m.u, gx, gy, gz), vv = m.sample(m.v, gx, gy, gz), ww = m.sample(m.w, gx, gy, gz)
      x = mod(x + uu * dt, width); y = mod(y + vv * dt, depth); z += ww * dt; this.particleAge[p] += dt
      if (z < 0 || z > height || this.particleAge[p] > 900) { this.respawnParticle(p); x = this.particleModel[j]; y = this.particleModel[j + 1]; z = this.particleModel[j + 2] }
      else { this.particleModel[j] = x; this.particleModel[j + 1] = y; this.particleModel[j + 2] = z }
      pos.setXYZ(p, ...this.toWorld(x, y, z))
      if (ww > 1) col.setXYZ(p, 1, .5, .18); else if (ww < -1) col.setXYZ(p, .25, .62, 1); else col.setXYZ(p, .72, .82, .86)
    }
    pos.needsUpdate = true; col.needsUpdate = true
  }

  // Visual only: the model has no ice, so a particle's phase comes from its height relative to the environmental 0 °C level.
  private meltFraction(z: number) { const f = this.model.sounding.freezing; return f === null ? 1 : clamp((f * 1000 - z) / MELT_DEPTH) }

  private updatePrecip(dt: number) {
    const m = this.model, { nx, ny, n, dx, dy, dz, width, depth, height } = m.grid
    for (let i = 0; i < n; i++) {
      const r = m.rain[i]
      if (r < 3e-4 || Math.random() > Math.min(1, r / .002) * .015 * dt) continue
      const p = this.precipNext, j = p * 3, x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny)); this.precipNext = (p + 1) % PRECIP_PARTICLES
      this.precipModel[j] = mod((x + Math.random() - .5) * dx, width); this.precipModel[j + 1] = mod((y + Math.random() - .5) * dy, depth); this.precipModel[j + 2] = clamp((z + Math.random() - .5) * dz, 0, height); this.precipAge[p] = 0; this.precipAlive[p] = 1
    }
    for (let p = 0; p < PRECIP_PARTICLES; p++) {
      if (!this.precipAlive[p]) continue
      const j = p * 3, x = this.precipModel[j], y = this.precipModel[j + 1], z = this.precipModel[j + 2], gx = x / dx, gy = y / dy, gz = z / dz, fall = lerp(SNOW_FALL, Math.max(2, m.sample(m.fallSpeed, gx, gy, gz)), this.meltFraction(z))
      const nz = z + (m.sample(m.w, gx, gy, gz) - fall) * dt; this.precipAge[p] += dt
      const evaporated = m.sample(m.rain, gx, gy, gz) < 2e-5 && Math.random() < .02 * dt
      if (nz <= 0 || nz > height || this.precipAge[p] > 2400 || evaporated) { this.precipAlive[p] = 0; continue }
      this.precipModel[j] = mod(x + m.sample(m.u, gx, gy, gz) * dt, width); this.precipModel[j + 1] = mod(y + m.sample(m.v, gx, gy, gz) * dt, depth); this.precipModel[j + 2] = nz
    }
  }

  private syncPrecip() {
    const pos = this.precipGeometry.getAttribute('position') as THREE.BufferAttribute, melt = this.precipGeometry.getAttribute('aMelt') as THREE.BufferAttribute
    for (let p = 0; p < PRECIP_PARTICLES; p++) {
      const j = p * 3
      if (!this.precipAlive[p]) { melt.setX(p, -1); continue }
      pos.setXYZ(p, ...this.toWorld(this.precipModel[j], this.precipModel[j + 1], this.precipModel[j + 2])); melt.setX(p, this.meltFraction(this.precipModel[j + 2]))
    }
    pos.needsUpdate = true; melt.needsUpdate = true
  }

  private updateVolume() {
    const m = this.model, d = this.volumeData
    for (let i = 0; i < m.grid.n; i++) { d[i * 2] = clamp((m.cloud[i] - .00003) / .0014) * 255; d[i * 2 + 1] = clamp(m.rain[i] / .0025) * 255 }
    this.volumeTexture.needsUpdate = true; this.volumeMaterial.uniforms.uTime.value = m.time
  }

  private updateFieldTexture(field: Exclude<FieldMode, 'composite'>) {
    const info = FIELDS[field]
    if (this.colormapField !== field) {
      this.colormap?.dispose(); this.colormap = colormapTexture(info.stops); this.colormapField = field
      this.fieldUniforms.uColormap.value = this.colormap; this.fieldUniforms.uDiverging.value = info.diverging ? 1 : 0
    }
    computeScalarField(this.model, field, this.fieldValues)
    const span = info.max - info.min
    for (let i = 0; i < this.fieldValues.length; i++) this.fieldData[i] = clamp((this.fieldValues[i] - info.min) / span) * 255
    this.fieldTexture.needsUpdate = true
  }

  private updateVectors() {
    const m = this.model, { nx, ny, nz, dx, dy, dz } = m.grid
    const p = this.vectorGeometry.getAttribute('position') as THREE.BufferAttribute, c = this.vectorGeometry.getAttribute('color') as THREE.BufferAttribute
    let n = 0
    for (let z = 2; z < nz - 2; z += 4) for (let y = 2; y < ny; y += 5) for (let x = 2; x < nx; x += 5) {
      const i = x + nx * (y + ny * z), uu = m.u[i], vv = m.v[i], ww = m.w[i], mag = Math.hypot(uu, vv, ww)
      if (mag < 1) continue
      const scale = clamp(mag * .045, .18, 1.3), [sx, sy, sz] = this.toWorld(x * dx, y * dy, z * dz), ex = sx + uu / mag * scale, ey = sy + ww / mag * scale, ez = sz - vv / mag * scale
      p.setXYZ(n, sx, sy, sz); p.setXYZ(n + 1, ex, ey, ez)
      const color = ww > 1 ? [1, .45, .12] : ww < -1 ? [.2, .6, 1] : [.7, .82, .86]
      c.setXYZ(n, color[0], color[1], color[2]); c.setXYZ(n + 1, color[0], color[1], color[2]); n += 2
    }
    this.vectorGeometry.setDrawRange(0, n); p.needsUpdate = true; c.needsUpdate = true
  }

  render() {
    const s = this.settings, m = this.model, { dx, dy } = m.grid
    const width = Math.max(2, this.canvas.clientWidth), height = Math.max(2, this.canvas.clientHeight)
    if (this.canvas.width !== Math.floor(width * Math.min(devicePixelRatio, 1.5)) || this.canvas.height !== Math.floor(height * Math.min(devicePixelRatio, 1.5))) {
      this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix()
    }
    const field = s.field === 'composite' ? null : s.field
    this.updateSun(); this.updateVolume(); if (field) this.updateFieldTexture(field)
    this.volumeMaterial.uniforms.uOpacity.value = field ? .22 : 1
    const slices = !!field && s.layerMode !== 'volume', wholeVolume = s.layerMode === 'volume'
    this.fieldMesh.visible = !!field && s.layerMode !== 'slices'; this.sliceH.visible = this.sliceV.visible = slices
    // With slices the volume shows only strong deviations (the field's own threshold); alone it can show weak structure too.
    this.fieldUniforms.uThreshold.value = field ? wholeVolume ? s.volumeThreshold : FIELDS[field].threshold : 1
    this.fieldUniforms.uDensity.value = wholeVolume ? s.volumeDensity : 1
    this.shared.uSliceOn.value = slices ? 1 : 0; this.shared.uSliceH.value = this.sliceH.position.y = s.sliceHeight; this.shared.uSliceZ.value = this.sliceV.position.z = -s.sliceNorth
    this.flowPoints.visible = s.showVectors; this.vectorLines.visible = s.showVectors
    const r = m.rotation
    this.mesoMarker.visible = r.uh >= UH_ROTATING
    if (this.mesoMarker.visible) {
      const [wx, , wz] = this.toWorld(r.x * dx, r.y * dy, 0)
      this.mesoMarker.position.x = wx; this.mesoMarker.position.z = wz
      ;(this.mesoMarker.material as THREE.MeshBasicMaterial).color.set(r.persisted >= MESO_PERSISTENCE ? 0xf0b44c : 0xc9d6dc)
    }
    this.precipPoints.visible = s.showPrecip; this.freezingHelper.visible = s.showPrecip && m.sounding.freezing !== null
    if (s.showPrecip) { this.syncPrecip(); this.precipMaterial.uniforms.uScale.value = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y * .5 }
    if (s.showVectors && this.frame % 4 === 0) this.updateVectors()
    this.frame++; this.controls.update(); this.renderer.render(this.scene, this.camera)
  }
}
