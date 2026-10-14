import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { FlashVolume, LightVolume } from './light'
import { noiseTexture } from './noise'
import { LightningView } from './lightning'
import { type AtmosphereModel, computeScalarField, headingVector, heightAt, levelAt, MESO_PERSISTENCE, sunDirection, UH_ROTATING, type UhLayer } from '../core'
import { clamp, lerp, mod, mulberry32 } from '../core/math'
import { qsatP } from '../core/microphysics'
import { isPhone } from '../hud'
import { colormapTexture, type FieldMode, fieldInfo } from './fields'
import { fieldVolumeFragment, groundShadowPars, precipFragment, precipVertex, sliceFragment, volumeFragment, volumeVertex } from './shaders'

/** How a field layer is drawn: opaque slices with a volume of strong deviations, slices only, or the whole field as a volume. */
export type LayerMode = 'both' | 'slices' | 'volume'

export interface ViewSettings {
  field: FieldMode; showVectors: boolean; showPrecip: boolean; layerMode: LayerMode
  /** Rain total on the ground since the start (swath), drawn over the ground. */ showRainTotal: boolean
  /** Mark the rotating updraft (UH above the rotation threshold). */ showMesocyclone: boolean
  /** Draw the lightning channels as they flash. */ showLightning: boolean
  /** 'volume' mode: fraction of the colour range below which the field is transparent (0 shows everything). */ volumeThreshold: number
  /** 'volume' mode: opacity multiplier of the field volume. */ volumeDensity: number
  /** Horizontal slice height, km. */ sliceHeight: number
  /** Vertical north-south slice position, km north of the domain centre. */ sliceNorth: number
  /** Layer of the updraft helicity map. */ uhLayer: UhLayer
}

/** Rain-total colour steps: [upper limit mm, rgb]. */
const SWATH_COLORS: [number, [number, number, number]][] = [[1, [150, 200, 240]], [5, [60, 150, 225]], [10, [60, 185, 90]], [25, [240, 215, 60]], [50, [240, 130, 40]], [Infinity, [210, 45, 45]]]

/**
 * The cloud's density in the volume texture from its extinction-weighted mass, kg/kg: saturating, as a cloud of a few tenths of a
 * gram per kilogram is already opaque over a kilometre (extinction ~3 LWC / (2 ρw r) ≈ 50-100 per km for droplets of
 * ~10 µm); a linear scale to 1.4 g/kg drew the updraught core (depleted to 0.2-0.6 g/kg by the graupel) as smoke.
 */
/**
 * Extinction of the cloud ice per gram, relative to the droplets': crystals of 30-100 µm against droplets of ~10 µm
 * (extinction ∝ mass / size). The anvil is then translucent at its edges instead of a white slab.
 */
const ICE_EXTINCTION = .25
/**
 * The same for snow and for graupel-hail above the melting level: aggregates and rimers of millimetres scatter ~0.05-0.1
 * and ~0.03 of the droplets' light per gram. Snow is most of the anvil's mass and much of the storm's middle: counted as
 * precipitation it left the anvil in shreds with gaps to the ground (the meteorologist's review 14.10.2026).
 */
const SNOW_EXTINCTION = .08, RIMER_EXTINCTION = .03
/** The tower: the updraught within this many model levels above and below a node. */
const TOWER_LEVELS = 2
/** Rotation for the striations: in an updraught over this, m/s, once the rotation has held this long, s. */
const SPIN_UPDRAUGHT = 5, MESO_HELD = 600
/** Mammatus only over air drier than this relative humidity under the anvil's base. */
const MAMMA_RH = .9
const cloudOpacity = (c: number) => c > .00003 ? 1 - Math.exp(-(c - .00003) / .0004) : 0
/** The cloud base in the columns' map: its scale, m, and how high it is looked for, m (a microburst's base is ~4 km). */
const BASE_SCALE = 10_000, BASE_SEARCH = 6000
/** The anvil's base in the columns' map: its scale, m, and where the cloud begins (the shader's cloud threshold). */
const ANVIL_BASE_SCALE = 20_000, ANVIL_OPACITY = .05
/** Vertical vorticity at the top of the rotation map, 1/s: a mesocyclone (0.01 and more) is at its middle. */
const ROTATION_SCALE = .02
/** Updraught that gives the cloud its full billows, m/s (the volume texture's B). */
const UPDRAUGHT_SCALE = 20
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
  /** The ground colours with the city blended in (null without a city). */
  private readonly cityTexture: THREE.DataTexture | null = null
  private readonly swathData: Uint8Array; private readonly swathTexture: THREE.DataTexture; private readonly swath: THREE.Mesh
  /** The zones of the environment (SimConfig.zones) tinted on the ground — warm reddish, cool bluish, only the moisture greenish (null without zones). */
  private readonly zoneTexture: THREE.DataTexture | null = null
  /** The moving front's line on the ground (SimConfig.frontLine): blue for a cold front, red for a warm one; null without. */
  private readonly frontLine: LineSegments2 | null = null
  /** Lines on the ground every 3 km; they move with the ground when the domain follows the storm. */
  private readonly groundGrid: THREE.GridHelper
  private readonly ground: THREE.Mesh; private readonly raycaster = new THREE.Raycaster(); private readonly pointer = new THREE.Vector2()
  private readonly sunLight: THREE.DirectionalLight; private readonly hemiLight: THREE.HemisphereLight
  private readonly shared: Record<string, THREE.IUniform>
  private readonly light: LightVolume; private readonly flashLight: FlashVolume; private readonly strikeLight: THREE.PointLight
  /** The strongest updraught of each column, and of each column with those beside it (the tower's), m/s. */
  /** Scratch of the volume's update, per node: the cloud's extinction-weighted mass, the shafts' mass, the ice share, the tower's updraught. */
  private cloudMass?: Float32Array; private shaftMass?: Float32Array; private iceShare?: Float32Array; private towerScratch?: Float32Array; private towerField?: Float32Array
  /**
   * The columns for the cloud's shape (RGBA per column): the rotation, the strongest |vertical vorticity| at 1-6 km of
   * the column and those beside it (0-255 of ROTATION_SCALE); the base of an anvil over it (of ANVIL_BASE_SCALE m) times
   * that anvil's presence, and the presence (0-255); the cloud base (of BASE_SCALE m).
   */
  private cloudBase?: Float32Array
  private readonly columnData: Uint8Array; private readonly columnTexture: THREE.DataTexture; private spinColumn?: Float32Array
  /** Baked noise of the cloud's sub-grid detail (noise.ts). */
  private readonly noise: THREE.Data3DTexture
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
  /** Ring around the selected cell (see setSelection). */
  private readonly selectionMarker: THREE.Mesh; private selection: { x: number; y: number } | null = null
  private readonly stationMarker: THREE.Mesh; private station: { x: number; y: number } | null = null
  private frame = 0
  /** The lightning channels (lightning.ts). */
  private readonly lightning: LightningView; private readonly drawingBuffer = new THREE.Vector2()
  /**
   * The volume textures are uniform in height (the shaders map height linearly onto them). On a stretched grid every
   * texture level t is interpolated between model levels k0[t] and k0[t] + 1 with weight f[t]; on a uniform grid the
   * texture levels are the model levels (null).
   */
  private readonly texLevels: { nz: number; k0: Int32Array; f: Float32Array } | null

  constructor(canvas: HTMLCanvasElement, model: AtmosphereModel, settings: ViewSettings) {
    this.canvas = canvas; this.model = model; this.settings = settings; this.rng = mulberry32(model.config.seed)
    const { nx, ny, n, width, depth, height } = model.grid, W = width / 1000, D = depth / 1000, H = height / 1000
    // Camera distance and fog grow with the domain (1 for the standard 48 km).
    const scale = Math.max(1, W / 48)
    if (model.grid.uniform) this.texLevels = null
    else {
      // 300 m texture levels: finer than the model aloft, coarser than it next to the ground.
      const tz = Math.max(model.grid.nz, Math.round(height / 300) + 1), k0 = new Int32Array(tz), f = new Float32Array(tz)
      for (let t = 0; t < tz; t++) { const l = Math.min(levelAt(model.grid, t * height / (tz - 1)), model.grid.nz - 1.000001); k0[t] = Math.floor(l); f[t] = l - k0[t] }
      this.texLevels = { nz: tz, k0, f }
    }
    const nz = this.texLevels?.nz ?? model.grid.nz, texels = nx * ny * nz
    this.volumeData = new Uint8Array(texels * 4); this.fieldValues = new Float32Array(n); this.fieldData = new Uint8Array(texels)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    // A phone renders at 1 pixel per CSS pixel: its screen is small and its GPU weak (the clouds are ray-marched).
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, isPhone() ? 1 : 1.5)); this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x172d3b); this.scene.fog = new THREE.FogExp2(0x172d3b, .012 / scale)
    this.camera = new THREE.PerspectiveCamera(42, 1, .1, 180 * scale); this.camera.position.set(38 * scale, 24 * scale, 39 * scale)
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('view-debug')) (globalThis as { __stormView?: StormView }).__stormView = this
    this.controls = new OrbitControls(this.camera, canvas); this.controls.target.set(0, 6, 0); this.controls.enableDamping = true; this.controls.dampingFactor = .07; this.controls.maxPolarAngle = Math.PI * .495; this.controls.minDistance = 15; this.controls.maxDistance = 100 * scale
    this.hemiLight = new THREE.HemisphereLight(0xd9efff, 0x4b4439, 1.35); this.scene.add(this.hemiLight)
    this.sunLight = new THREE.DirectionalLight(0xfff0d2, 2); this.scene.add(this.sunLight)

    const ground = ({ grass: 0x596d45, dry: 0x776a51, water: 0x315d70, urban: 0x606469 } as const)[model.config.surfaceType]
    const groundMat = new THREE.MeshStandardMaterial({ color: ground, roughness: .96, metalness: 0 })
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(W, D), groundMat); this.ground.rotation.x = -Math.PI / 2; this.scene.add(this.ground)
    // A city (SimConfig.city): the ground colour blends to the urban grey under it, one texel per ground column like the
    // swath, sliding with the ground in updateGround.
    if ((model.config.city ?? 0) > 0) {
      const data = new Uint8Array(nx * ny * 4), a = new THREE.Color(ground), b = new THREE.Color(0x6e7175), mix = new THREE.Color(), rgb = { r: 0, g: 0, b: 0 }
      model.cityGround.forEach((share, i) => { mix.lerpColors(a, b, share).getRGB(rgb, THREE.SRGBColorSpace); data.set([rgb.r * 255, rgb.g * 255, rgb.b * 255, 255], i * 4) })
      this.cityTexture = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat); this.cityTexture.colorSpace = THREE.SRGBColorSpace
      this.cityTexture.magFilter = this.cityTexture.minFilter = THREE.LinearFilter; this.cityTexture.wrapS = this.cityTexture.wrapT = THREE.RepeatWrapping; this.cityTexture.needsUpdate = true
      groundMat.map = this.cityTexture; groundMat.color.set(0xffffff)
    }
    // Rain swath: one texel per ground column (row 0 is the southern edge, as the plane's v runs north).
    this.swathData = new Uint8Array(nx * ny * 4); this.swathTexture = new THREE.DataTexture(this.swathData, nx, ny, THREE.RGBAFormat)
    this.swathTexture.magFilter = this.swathTexture.minFilter = THREE.LinearFilter; this.swathTexture.wrapS = this.swathTexture.wrapT = THREE.RepeatWrapping; this.swathTexture.needsUpdate = true
    this.swath = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: this.swathTexture, transparent: true, depthWrite: false, toneMapped: false }))
    this.swath.rotation.x = -Math.PI / 2; this.swath.position.y = .02; this.swath.visible = false; this.scene.add(this.swath)
    if (model.zoneGround) {
      const { share, theta, vapour } = model.zoneGround, data = new Uint8Array(nx * ny * 4)
      for (let i = 0; i < nx * ny; i++) {
        const t = theta[i], q = vapour[i] * 1000, rgb = t > .2 ? [235, 95, 60] : t < -.2 ? [80, 140, 235] : q >= 0 ? [80, 200, 110] : [200, 160, 90]
        data.set([...rgb, share[i] * 90], i * 4)
      }
      this.zoneTexture = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat)
      this.zoneTexture.magFilter = this.zoneTexture.minFilter = THREE.LinearFilter; this.zoneTexture.wrapS = this.zoneTexture.wrapT = THREE.RepeatWrapping; this.zoneTexture.needsUpdate = true
      const zones = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: this.zoneTexture, transparent: true, depthWrite: false, toneMapped: false }))
      zones.rotation.x = -Math.PI / 2; zones.position.y = .015; this.scene.add(zones)
    }
    if (model.config.frontLine) {
      const material = new LineMaterial({ color: model.config.frontLine.kind === 'cold' ? 0x4f8fe0 : 0xe0574f, linewidth: 4, transparent: true, opacity: .9, depthWrite: false })
      this.frontLine = new LineSegments2(new LineSegmentsGeometry(), material); this.frontLine.renderOrder = 3; this.scene.add(this.frontLine)
    }
    const grid = new THREE.GridHelper(W, Math.round(W / 3), 0x71838a, 0x485d66); grid.material.transparent = true; grid.material.opacity = .32; this.scene.add(grid); this.groundGrid = grid
    const box = new THREE.BoxGeometry(W, H, D); box.translate(0, H / 2, 0)
    this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x75909c, transparent: true, opacity: .4 })))
    this.levelHelpers = [0xb6d4dd, 0xe1bf7e, 0xd88e74].map(color => { const h = new THREE.GridHelper(W, 12, color, color); h.material.transparent = true; h.material.opacity = .18; this.scene.add(h); return h })

    this.shared = {
      uBoxMin: { value: new THREE.Vector3(-W / 2, 0, -D / 2) }, uBoxMax: { value: new THREE.Vector3(W / 2, H, D / 2) }, uGrid: { value: new THREE.Vector3(nx, ny, nz) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uHeight: { value: H }, uExtinction: { value: 2.2 }, uSliceOn: { value: 0 }, uSliceH: { value: 2 }, uSliceZ: { value: 0 },
    }
    this.volumeTexture = texture3D(this.volumeData, THREE.RGBAFormat, nx, ny, nz)
    this.noise = noiseTexture()
    this.columnData = new Uint8Array(nx * ny * 4)
    this.columnTexture = new THREE.DataTexture(this.columnData, nx, ny, THREE.RGBAFormat)
    this.columnTexture.minFilter = this.columnTexture.magFilter = THREE.LinearFilter; this.columnTexture.wrapS = this.columnTexture.wrapT = THREE.RepeatWrapping; this.columnTexture.needsUpdate = true
    this.light = new LightVolume(nx, ny, nz, this.shared, this.volumeTexture)
    this.flashLight = new FlashVolume(nx, ny, nz, this.shared, this.volumeTexture)
    this.volumeMaterial = new THREE.ShaderMaterial({
      vertexShader: volumeVertex, fragmentShader: volumeFragment, side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false, premultipliedAlpha: true,
      uniforms: {
        ...this.shared, uDensity: { value: this.volumeTexture }, uNoise: { value: this.noise }, uColumns: { value: this.columnTexture }, uLight: { value: this.light.texture }, uFlashA: { value: this.flashLight.targets[0].texture }, uFlashB: { value: this.flashLight.targets[1].texture }, uFlashIA: { value: new THREE.Vector4() }, uFlashIB: { value: new THREE.Vector4() }, uFlashOn: { value: 0 }, uSunColor: { value: new THREE.Color() }, uAmbientTop: { value: new THREE.Color() }, uAmbientBottom: { value: new THREE.Color() },
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
      Object.assign(shader.uniforms, { ...this.shared, uLight: this.volumeMaterial.uniforms.uLight })
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;').replace('#include <project_vertex>', '#include <project_vertex>\nvCloudWorld=(modelMatrix*vec4(transformed,1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${groundShadowPars}`).replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n{vec2 s=cloudShade(vCloudWorld);reflectedLight.directDiffuse*=s.x;reflectedLight.directSpecular*=s.x;reflectedLight.indirectDiffuse*=s.y;}')
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
    this.selectionMarker = new THREE.Mesh(new THREE.TorusGeometry(4, .09, 8, 72), new THREE.MeshBasicMaterial({ color: 0x5fd4e8, transparent: true, opacity: .85, depthWrite: false }))
    this.selectionMarker.rotation.x = Math.PI / 2; this.selectionMarker.position.y = .15; this.selectionMarker.renderOrder = 3; this.selectionMarker.visible = false; this.scene.add(this.selectionMarker)
    // The weather station: a small mast standing on the ground.
    this.stationMarker = new THREE.Mesh(new THREE.ConeGeometry(.45, 1.6, 4), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: .95, depthWrite: false }))
    this.stationMarker.rotation.x = Math.PI; this.stationMarker.position.y = .8; this.stationMarker.renderOrder = 3; this.stationMarker.visible = false; this.scene.add(this.stationMarker)

    // Lines a few pixels wide, drawn over the cloud: inside a sunlit cloud a thin white channel would not be seen.
    this.lightning = new LightningView(model, (x, y, z) => this.toWorld(x, y, z), this.shared, this.volumeTexture); this.scene.add(this.lightning.mesh)
    // A CG lights the ground and the rain around where it strikes.
    this.strikeLight = new THREE.PointLight(0xdfe2ff, 0, 30, 2); this.strikeLight.visible = false; this.scene.add(this.strikeLight)

    this.updateLevels()
    for (let p = 0; p < FLOW_PARTICLES; p++) this.respawnParticle(p, true)
  }

  dispose() {
    this.controls.dispose()
    ;[this.volumeTexture, this.noise, this.columnTexture, this.fieldTexture, this.colormap, this.volumeMaterial, this.fieldMaterial, this.sliceMaterial, this.volumeMesh.geometry, this.sliceH.geometry, this.sliceV.geometry, this.precipGeometry, this.precipMaterial, this.swathTexture, this.cityTexture, this.zoneTexture, this.frontLine?.geometry, this.frontLine?.material as THREE.Material | undefined, this.swath.geometry, this.swath.material as THREE.Material, this.mesoMarker.geometry, this.mesoMarker.material as THREE.Material, this.selectionMarker.geometry, this.selectionMarker.material as THREE.Material, this.stationMarker.geometry, this.stationMarker.material as THREE.Material, this.lightning, this.light, this.flashLight].forEach(r => r?.dispose())
    this.renderer.dispose()
  }

  // Rain totals, mm: transparent below 0.5 mm, then the usual radar-like ramp 1 / 5 / 10 / 25 / 50+ mm.
  private updateSwath() {
    const total = this.model.precipitation, d = this.swathData
    for (let i = 0; i < total.length; i++) {
      const mm = total[i], [r, g, b] = SWATH_COLORS.find(([limit]) => mm < limit)?.[1] ?? SWATH_COLORS[SWATH_COLORS.length - 1][1]
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = mm < .5 ? 0 : Math.min(230, 120 + mm * 10)
    }
    this.swathTexture.needsUpdate = true
  }

  /**
   * The ground under a domain that follows the storm: the swath (rain totals are fixed to the ground) and the ground lines
   * slide by the distance travelled, so the storm is seen moving over the land.
   */
  private updateGround() {
    const { width, depth } = this.model.grid, [ox, oy] = this.model.frameOffset(), step = width / 1000 / Math.round(width / 3000)
    this.swathTexture.offset.set(ox / width, oy / depth); this.cityTexture?.offset.set(ox / width, oy / depth); this.zoneTexture?.offset.set(ox / width, oy / depth)
    this.groundGrid.position.x = -((ox / 1000) % step); this.groundGrid.position.z = (oy / 1000) % step
  }

  /**
   * The front's line on the ground now: the points of the domain where frontDistance is 0 — a straight line across the
   * domain, perpendicular to the heading, clipped to the domain's box.
   */
  private updateFront() {
    const f = this.model.config.frontLine, line = this.frontLine
    if (!f || !line) return
    const m = this.model, { width: W, depth: D } = m.grid, [nx, ny] = headingVector(f.heading), [fx, fy] = m.frame
    // A point of the line in domain coordinates (m): the ground point moved back by the domain's own motion.
    const d = (f.start + f.speed * m.time / 1000) * 1000, px = W / 2 + nx * d - fx * m.time, py = D / 2 + ny * d - fy * m.time
    // Clip the line p + t (ny, -nx) to the box [0, W] x [0, D].
    let lo = -Infinity, hi = Infinity
    for (const [p, dir, size] of [[px, ny, W], [py, -nx, D]] as const) {
      if (Math.abs(dir) < 1e-9) { if (p < 0 || p > size) { line.visible = false; return } continue }
      const a = (0 - p) / dir, b = (size - p) / dir
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b))
    }
    line.visible = hi > lo
    if (!line.visible) return
    const [ax, ay, az] = this.toWorld(px + lo * ny, py - lo * nx, 30), [bx, by, bz] = this.toWorld(px + hi * ny, py - hi * nx, 30)
    ;(line.geometry as LineSegmentsGeometry).setPositions([ax, ay, az, bx, by, bz])
    ;(line.material as LineMaterial).resolution.set(this.canvas.width, this.canvas.height)
  }

  /** Model-space position (m from the domain corner) of the ground point under normalised screen coordinates. */
  groundPoint(nx: number, ny: number) {
    const { width, depth } = this.model.grid
    this.pointer.set(nx * 2 - 1, -(ny * 2 - 1)); this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.ground, false)[0]
    return { x: hit ? clamp((hit.point.x + width / 2000) * 1000, 0, width) : width / 2, y: hit ? clamp((depth / 2000 - hit.point.z) * 1000, 0, depth) : depth / 2 }
  }

  /** Rings the selected cell (ground position in m from the domain corner), or removes the ring. */
  setSelection(p: { x: number; y: number } | null) { this.selection = p }
  /** Marks the weather station (its position in the domain now, m), or removes the mark. */
  setStation(p: { x: number; y: number } | null) { this.station = p }

  /** Canvas position (CSS px) of a model point (m; z above the ground), or null behind the camera. */
  screenPoint(x: number, y: number, z: number) {
    const [wx, wy, wz] = this.toWorld(x, y, z), v = new THREE.Vector3(wx, wy, wz).project(this.camera)
    if (v.z > 1 || v.z < -1) return null
    return { x: (v.x + 1) / 2 * this.canvas.clientWidth, y: (1 - v.y) / 2 * this.canvas.clientHeight }
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

  /**
   * For checks of the picture (the page opened with ?view-debug): the view as globalThis.__stormView, a local hour for
   * the sun instead of the model's, and the camera placed by hand (km, world axes).
   */
  debugSunHour: number | null = null
  get debugLightning() { return this.lightning }
  /** Shows the last flash again (a CG if there was one lately), `rate` times as fast as real time; false without one. */
  replayLightning(rate: number) { return this.lightning.replay(rate) }
  debugCamera(position: [number, number, number], target: [number, number, number]) { this.camera.position.set(...position); this.controls.target.set(...target); this.controls.update() }

  private updateSun() {
    const s = this.debugSunHour === null ? sunDirection(this.model.config, this.model.time) : sunDirection({ ...this.model.config, hour: this.debugSunHour }, 0), dir = new THREE.Vector3(s.x, s.y, s.z)
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
    const m = this.model, { dx, dy, width, depth, height } = m.grid
    const pos = this.flowGeometry.getAttribute('position') as THREE.BufferAttribute, col = this.flowGeometry.getAttribute('color') as THREE.BufferAttribute
    for (let p = 0; p < FLOW_PARTICLES; p++) {
      const j = p * 3
      let x = this.particleModel[j], y = this.particleModel[j + 1], z = this.particleModel[j + 2]
      const gx = x / dx, gy = y / dy, gz = levelAt(m.grid, z), uu = m.sample(m.u, gx, gy, gz), vv = m.sample(m.v, gx, gy, gz), ww = m.sample(m.w, gx, gy, gz)
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
    const m = this.model, { nx, ny, n, dx, dy, width, depth, height } = m.grid
    for (let i = 0; i < n; i++) {
      const r = m.rain[i]
      if (r < 3e-4 || Math.random() > Math.min(1, r / .002) * .015 * dt) continue
      const p = this.precipNext, j = p * 3, x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny)); this.precipNext = (p + 1) % PRECIP_PARTICLES
      this.precipModel[j] = mod((x + Math.random() - .5) * dx, width); this.precipModel[j + 1] = mod((y + Math.random() - .5) * dy, depth); this.precipModel[j + 2] = heightAt(m.grid, z + Math.random() - .5); this.precipAge[p] = 0; this.precipAlive[p] = 1
    }
    for (let p = 0; p < PRECIP_PARTICLES; p++) {
      if (!this.precipAlive[p]) continue
      const j = p * 3, x = this.precipModel[j], y = this.precipModel[j + 1], z = this.precipModel[j + 2], gx = x / dx, gy = y / dy, gz = levelAt(m.grid, z), fall = lerp(SNOW_FALL, Math.max(2, m.sample(m.fallSpeed, gx, gy, gz)), this.meltFraction(z))
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

  /**
   * The cloud volume, per texel: the cloud's density (R: cloud water, ice, snow and the graupel-hail above the melting
   * level, each with its extinction per gram, saturating), the precipitation below the melting level (G: rain, and the
   * snow, graupel and hail still falling there: the grey shafts), the tower's updraught (B, 0-UPDRAUGHT_SCALE m/s) and
   * the ice share of the cloud (A): the shader shapes the cloud's sub-grid detail from them — rising cauliflower billows
   * on a tower, soft fibrous ice in the anvil away from it. The tower's updraught at a node is the strongest within two
   * levels and one column of it: the updraught is strong only inside the tower, while its surface, which is what is
   * seen, billows all the same; but the anvil over it and the low cloud beside it do not (the column's strongest
   * updraught made them billow too: the meteorologist's review 14.10.2026).
   * The columns' map: the rotation, the anvil's base for the mammatus, the cloud base for a flat base.
   */
  private updateVolume() {
    const m = this.model, d = this.volumeData, tl = this.texLevels, { nx, ny, nz, layer, n, zs } = m.grid, exner = m.env.exner, pressure = m.env.p
    const mass = this.cloudMass ??= new Float32Array(n), shafts = this.shaftMass ??= new Float32Array(n), share = this.iceShare ??= new Float32Array(n)
    const vertical = this.towerScratch ??= new Float32Array(n), tower = this.towerField ??= new Float32Array(n)
    for (let z = 0, i = 0; z < nz; z++) for (let c = 0; c < layer; c++, i++) {
      const frozen = m.theta[i] * exner[z] < 273.15, rimers = m.graupel[i] + m.hail[i], icy = m.ice[i] + m.snow[i]
      mass[i] = m.cloud[i] + ICE_EXTINCTION * m.ice[i] + (frozen ? SNOW_EXTINCTION * m.snow[i] + RIMER_EXTINCTION * rimers : 0)
      shafts[i] = m.rain[i] + (frozen ? 0 : m.snow[i] + rimers)
      share[i] = m.cloud[i] + icy > 0 ? icy / (m.cloud[i] + icy) : 1
    }
    // The tower: the strongest updraught within TOWER_LEVELS levels, then within one column.
    for (let z = 0; z < nz; z++) for (let c = 0; c < layer; c++) {
      let w = 0
      for (let k = Math.max(0, z - TOWER_LEVELS); k <= Math.min(nz - 1, z + TOWER_LEVELS); k++) w = Math.max(w, m.w[c + k * layer])
      vertical[c + z * layer] = w
    }
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let w = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) w = Math.max(w, vertical[(x + dx + nx) % nx + ((y + dy + ny) % ny) * nx + z * layer])
      tower[x + y * nx + z * layer] = w
    }
    // The rotation: the strongest cyclonic ζ of each column at 1-6 km within the updraught (w > SPIN_UPDRAUGHT), of it and
    // the columns beside it, once the storm's rotation has held for MESO_HELD (the mesocyclone): |ζ| over the whole
    // column made a microburst's gust front and any storm's flanking vortex pair striated.
    const spin = this.spinColumn ??= new Float32Array(layer), z1 = Math.max(1, levelAt(m.grid, 1000) | 0), z6 = Math.min(nz - 2, Math.ceil(levelAt(m.grid, 6000)))
    const held = clamp(m.rotation.persisted / MESO_HELD)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let sp = 0
      if (held > 0) for (let z = z1; z <= z6; z++) if (m.w[x + y * nx + z * layer] > SPIN_UPDRAUGHT) sp = Math.max(sp, m.zeta(x, y, z))
      spin[x + y * nx] = sp
    }
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let sp = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sp = Math.max(sp, spin[(x + dx + nx) % nx + ((y + dy + ny) % ny) * nx])
      this.columnData[(x + y * nx) * 4] = clamp(sp / ROTATION_SCALE) * held * 255
    }
    // The anvil over each column, for the mammatus: the lowest level above 5 km where the cloud (as drawn) begins, if it
    // is ice and snow with no tower under it and the air under it is dry (the pouches sink as the snow sublimates into
    // it, Schultz et al. 2006); its base between that level and the one below.
    const opacity = (i: number) => cloudOpacity(mass[i]), z5 = Math.ceil(levelAt(m.grid, 5000))
    const crossing = (c: number, z: number) => { const i = c + z * layer, o = opacity(i), below = opacity(i - layer); return zs[z - 1] + (zs[z] - zs[z - 1]) * (ANVIL_OPACITY - below) / Math.max(o - below, 1e-6) }
    for (let c = 0; c < layer; c++) {
      let base = 0, presence = 0
      for (let z = z5 + 1; z < nz; z++) {
        const i = c + z * layer
        if (opacity(i) < ANVIL_OPACITY) continue
        const j = i - layer, rh = m.q[j] / qsatP(m.theta[j] * exner[z - 1] - 273.15, pressure[z - 1])
        base = crossing(c, z)
        // ... and only under the anvil's thick part (opaque a kilometre over its base), not its thin edges.
        const thick = opacity(c + Math.min(nz - 1, z + Math.max(1, Math.round(levelAt(m.grid, zs[z] + 1000) - z))) * layer)
        presence = clamp((share[i] - .6) / .2) * (1 - clamp((tower[i] - 1.6) / 2)) * clamp((MAMMA_RH - rh) / .15) * clamp((thick - .15) / .2)
        break
      }
      this.columnData[c * 4 + 1] = clamp(base / ANVIL_BASE_SCALE) * presence * 255; this.columnData[c * 4 + 2] = presence * 255
    }
    // The cloud base of each column, for a flat base: the lowest level under BASE_SEARCH where the cloud (as drawn)
    // begins, between it and the level below; columns without one take the median of the others (so the filter between
    // columns keeps the base level).
    const bases: number[] = [], zTop = Math.ceil(levelAt(m.grid, BASE_SEARCH)), baseOf = this.cloudBase ??= new Float32Array(layer)
    for (let c = 0; c < layer; c++) {
      baseOf[c] = -1
      for (let z = 1; z <= zTop; z++) if (opacity(c + z * layer) >= ANVIL_OPACITY) { baseOf[c] = crossing(c, z); bases.push(baseOf[c]); break }
    }
    bases.sort((x, y) => x - y)
    const median = bases.length ? bases[bases.length >> 1] : 0
    for (let c = 0; c < layer; c++) this.columnData[c * 4 + 3] = clamp((baseOf[c] < 0 ? median : baseOf[c]) / BASE_SCALE) * 255
    this.columnTexture.needsUpdate = true
    const put = (o: number, i: number, j: number, f: number) => {
      d[o * 4] = cloudOpacity(lerp(mass[i], mass[j], f)) * 255; d[o * 4 + 1] = clamp(lerp(shafts[i], shafts[j], f) / .0025) * 255
      d[o * 4 + 2] = clamp(lerp(tower[i], tower[j], f) / UPDRAUGHT_SCALE) * 255; d[o * 4 + 3] = lerp(share[i], share[j], f) * 255
    }
    if (!tl) for (let i = 0; i < n; i++) put(i, i, i, 0)
    else for (let t = 0, o = 0; t < tl.nz; t++) {
      const base = tl.k0[t] * layer, f = tl.f[t]
      for (let c = 0; c < layer; c++, o++) put(o, base + c, Math.min(base + c + layer, n - 1), f)
    }
    this.volumeTexture.needsUpdate = true; this.volumeMaterial.uniforms.uTime.value = m.time
  }

  private updateFieldTexture(field: Exclude<FieldMode, 'composite'>) {
    const info = fieldInfo(field, this.settings.uhLayer)
    if (this.colormapField !== field) {
      this.colormap?.dispose(); this.colormap = colormapTexture(info.stops); this.colormapField = field
      this.fieldUniforms.uColormap.value = this.colormap; this.fieldUniforms.uDiverging.value = info.diverging ? 1 : 0
    }
    computeScalarField(this.model, field, this.fieldValues, this.settings.uhLayer)
    const span = info.max - info.min
    const tl = this.texLevels, v = this.fieldValues
    if (!tl) for (let i = 0; i < v.length; i++) this.fieldData[i] = clamp((v[i] - info.min) / span) * 255
    else {
      const { layer } = this.model.grid
      for (let t = 0, o = 0; t < tl.nz; t++) {
        const base = tl.k0[t] * layer, f = tl.f[t]
        for (let c = 0; c < layer; c++, o++) this.fieldData[o] = clamp((lerp(v[base + c], v[base + c + layer], f) - info.min) / span) * 255
      }
    }
    this.fieldTexture.needsUpdate = true
  }

  private updateVectors() {
    const m = this.model, { nx, ny, nz, dx, dy, zs } = m.grid
    const p = this.vectorGeometry.getAttribute('position') as THREE.BufferAttribute, c = this.vectorGeometry.getAttribute('color') as THREE.BufferAttribute
    let n = 0
    for (let z = 2; z < nz - 2; z += 4) for (let y = 2; y < ny; y += 5) for (let x = 2; x < nx; x += 5) {
      const i = x + nx * (y + ny * z), uu = m.u[i], vv = m.v[i], ww = m.w[i], mag = Math.hypot(uu, vv, ww)
      if (mag < 1) continue
      const scale = clamp(mag * .045, .18, 1.3), [sx, sy, sz] = this.toWorld(x * dx, y * dy, zs[z]), ex = sx + uu / mag * scale, ey = sy + ww / mag * scale, ez = sz - vv / mag * scale
      p.setXYZ(n, sx, sy, sz); p.setXYZ(n + 1, ex, ey, ez)
      const color = ww > 1 ? [1, .45, .12] : ww < -1 ? [.2, .6, 1] : [.7, .82, .86]
      c.setXYZ(n, color[0], color[1], color[2]); c.setXYZ(n + 1, color[0], color[1], color[2]); n += 2
    }
    this.vectorGeometry.setDrawRange(0, n); p.needsUpdate = true; c.needsUpdate = true
  }

  render() {
    const s = this.settings, m = this.model, { dx, dy } = m.grid
    const width = Math.max(2, this.canvas.clientWidth), height = Math.max(2, this.canvas.clientHeight), ratio = this.renderer.getPixelRatio()
    // Against the renderer's own pixel ratio (1 on a phone): compared with 1.5 there, the canvas was resized, and its
    // drawing buffer reallocated, on every frame — on a weak phone GPU until the WebGL context was lost (a black view).
    if (this.canvas.width !== Math.floor(width * ratio) || this.canvas.height !== Math.floor(height * ratio)) {
      this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix()
    }
    const field = s.field === 'composite' ? null : s.field
    this.updateSun()
    // A flash lights the cloud from inside.
    const glow = this.lightning.update(performance.now(), s.showLightning, this.renderer.getDrawingBufferSize(this.drawingBuffer), ratio)
    const lit = this.lightning, vu = this.volumeMaterial.uniforms
    if (glow > 0 && lit.changed.some(c => c)) { this.flashLight.update(this.renderer, lit.points, lit.changed); lit.taken() }
    vu.uFlashOn.value = glow > 0 && this.flashLight.ready ? 1 : 0
    ;(vu.uFlashIA.value as THREE.Vector4).fromArray(lit.bright, 0); (vu.uFlashIB.value as THREE.Vector4).fromArray(lit.bright, 4)
    this.strikeLight.visible = !!lit.strike
    if (lit.strike) { this.strikeLight.position.set(lit.strike.x, Math.max(.3, lit.strike.y), lit.strike.z); this.strikeLight.intensity = 400 * lit.strike.bright }
    this.updateVolume(); if (field) this.updateFieldTexture(field)
    this.light.update(this.renderer, m.time, this.shared.uSunDir.value as THREE.Vector3)
    this.volumeMaterial.uniforms.uOpacity.value = field ? .22 : 1
    const slices = !!field && s.layerMode !== 'volume', wholeVolume = s.layerMode === 'volume'
    this.fieldMesh.visible = !!field && s.layerMode !== 'slices'; this.sliceH.visible = this.sliceV.visible = slices
    // With slices the volume shows only strong deviations (the field's own threshold); alone it can show weak structure too.
    this.fieldUniforms.uThreshold.value = field ? wholeVolume ? s.volumeThreshold : fieldInfo(field, s.uhLayer).threshold : 1
    this.fieldUniforms.uDensity.value = wholeVolume ? s.volumeDensity : 1
    this.shared.uSliceOn.value = slices ? 1 : 0; this.shared.uSliceH.value = this.sliceH.position.y = s.sliceHeight; this.shared.uSliceZ.value = this.sliceV.position.z = -s.sliceNorth
    this.flowPoints.visible = s.showVectors; this.vectorLines.visible = s.showVectors
    this.swath.visible = s.showRainTotal; if (s.showRainTotal) this.updateSwath()
    this.updateGround(); this.updateFront()
    const r = m.rotation
    this.mesoMarker.visible = s.showMesocyclone && r.uh >= UH_ROTATING
    if (this.mesoMarker.visible) {
      const [wx, , wz] = this.toWorld(r.x * dx, r.y * dy, 0)
      this.mesoMarker.position.x = wx; this.mesoMarker.position.z = wz
      ;(this.mesoMarker.material as THREE.MeshBasicMaterial).color.set(r.persisted >= MESO_PERSISTENCE ? 0xf0b44c : 0xc9d6dc)
    }
    this.selectionMarker.visible = !!this.selection
    if (this.selection) { const [wx, , wz] = this.toWorld(this.selection.x, this.selection.y, 0); this.selectionMarker.position.x = wx; this.selectionMarker.position.z = wz }
    this.stationMarker.visible = !!this.station
    if (this.station) { const [wx, , wz] = this.toWorld(this.station.x, this.station.y, 0); this.stationMarker.position.x = wx; this.stationMarker.position.z = wz }
    this.precipPoints.visible = s.showPrecip; this.freezingHelper.visible = s.showPrecip && m.sounding.freezing !== null
    if (s.showPrecip) { this.syncPrecip(); this.precipMaterial.uniforms.uScale.value = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y * .5 }
    if (s.showVectors && this.frame % 4 === 0) this.updateVectors()
    this.frame++; this.controls.update(); this.renderer.render(this.scene, this.camera)
  }
}
