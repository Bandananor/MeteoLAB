import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { FlashVolume, LightVolume } from './light'
import { noiseTexture } from './noise'
import { LightningView } from './lightning'
import { type GroundPoint, Observer } from './observer'
import { type CameraGrade, gradeFilter, NEUTRAL_GRADE } from '../camera'
import { type AtmosphereModel, computeScalarField, groundRepeats, headingVector, heightAt, levelAt, MESO_PERSISTENCE, sunDirection, UH_ROTATING, type UhLayer } from '../core'
import { clamp, lerp, mod, mulberry32 } from '../core/math'
import { qsatP } from '../core/microphysics'
import { N0G, N0R, RHO_G, RHO_W } from '../core/graupel'
import { N0H, RHO_H } from '../core/hail'
import { N0S, RHO_S } from '../core/ice'
import { isPhone } from '../hud'
import { colormapTexture, type FieldMode, fieldInfo } from './fields'
import { fieldVolumeFragment, groundShadowPars, groundSurfacePars, precipFragment, precipVertex, skyFragment, skyVertex, sliceFragment, volumeFragment, volumeVertex } from './shaders'
import { adaptation, ADAPT_MAX, computeSky, HAZE_ALBEDO, HAZE_SCALE, hazeExtinction, luminance, RAYLEIGH, RAYLEIGH_SCALE, SKY_COLS, SKY_ROWS, type SkyState, SUN_LEVELS } from './sky'

// The fog of three's own materials (the lines): the aerial perspective of the clouds' (shaders.ts aerial, with its AIR_SCALE) —
// exponential layers of air and haze over flat ground, per channel — toward the horizon's colour (fogColor, set every
// frame for the direction looked in); fogDensity is the haze's extinction at the ground, 1/km.
THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\nvarying float vFogDepth;\nvarying vec3 vFogWorld;\n#endif'
THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\nvFogDepth = -mvPosition.z;\nvFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;\n#endif'
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
uniform vec3 fogColor;
uniform float fogDensity;
varying float vFogDepth;
varying vec3 vFogWorld;
float fogColumn(float y0, float y1, float len, float H){
  y0 = max(y0, 0.0); y1 = max(y1, 0.0);
  float dy = y1 - y0;
  return abs(dy) < 1e-3 * H ? len * exp(-y0 / H) : H * len / dy * (exp(-y0 / H) - exp(-y1 / H));
}
#endif`
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
{
  float len = length(vFogWorld - cameraPosition);
  vec3 od = vec3(${RAYLEIGH.join(', ')}) * fogColumn(cameraPosition.y, vFogWorld.y, len, ${RAYLEIGH_SCALE.toFixed(1)}) + fogDensity / ${HAZE_ALBEDO} * fogColumn(cameraPosition.y, vFogWorld.y, len, ${HAZE_SCALE});
  vec3 T = exp(-0.5 * od);
  gl_FragColor.rgb = gl_FragColor.rgb * T + fogColor * (1.0 - T);
}
#endif`

/**
 * The light of the day in the view's units (sky.ts gives it relative to the sun above the air): the clouds' sunlight
 * (SUN_GAIN; with the step-2 calibration, ~2.6 at noon), the sky's radiance and the light it gives, and the ground's lights
 * (SKY_GAIN: the ground and the sky in the same units, so the ground is as bright against the sky as it is), the sun's disc (SUN_DISC: far below its true radiance, which no
 * screen shows, but bright enough to burn white at noon and keep its colour at sunset). All of them times the eye's
 * adaptation (sky.ts).
 */
const SUN_GAIN = 3, SKY_GAIN = 14, SUN_DISC = 40
/**
 * The night (the eye adapted to the dark: the airglow and the stars' light, which no table of the sun's scattering
 * holds): floors for the sky, the clouds' ambient light from above and below and the ground's sky light, and a city's
 * glow (its lights on the haze, and from under the cloud base). Constant light, so on screen they grow with the
 * adaptation (its square: they matter only in the deep twilight and the night).
 */
const NIGHT_SKY = [.008, .012, .026], NIGHT_TOP = [.1, .12, .2], NIGHT_BOTTOM = [.06, .07, .1], NIGHT_GROUND = [.1, .12, .18]
const CITY_SKY = [.06, .036, .016], CITY_BOTTOM = [.09, .055, .025]
/**
 * The picture's quality (the clouds' march cost most): the pixels drawn per CSS pixel (from 1 up, at most the
 * screen's own; below 1, of the screen's CSS pixel, a coarser picture scaled up), the march's coarse steps through the box, its most steps, its fine step in the cloud (km), the shadow
 * probes toward the sun (shaders.ts), and the samples of the shaded air along a ray.
 */
export type Quality = 'low' | 'medium' | 'high'
export const QUALITIES: Quality[] = ['low', 'medium', 'high']
const QUALITY: Record<Quality, { pixels: number; budget: number; steps: number; maxSteps: number; fine: number; probes: number; air: number }> = {
  low: { pixels: .6, budget: .3e6, steps: 48, maxSteps: 112, fine: .32, probes: 0, air: 2 },
  medium: { pixels: .8, budget: .6e6, steps: 72, maxSteps: 160, fine: .24, probes: 1, air: 3 },
  high: { pixels: 1.5, budget: 1.9e6, steps: 96, maxSteps: 224, fine: .18, probes: 2, air: 6 },
}
/**
 * The pixels drawn per CSS pixel for a level and a view of w x h CSS pixels: the level's own, but at most its pixel
 * budget in all (the march costs per pixel: the full screen has 2.5 times the pixels of the view between the panels,
 * and at the high level it dragged — the user's 15.10.2026); a bigger view is drawn coarser and scaled up, at the
 * cost of the panels' view. In steps of 0.05, so a resize does not reallocate the buffer on every frame.
 */
function pixelRatioFor(level: Quality, w: number, h: number, moving: boolean) {
  const q = QUALITY[level], own = q.pixels >= 1 ? Math.min(devicePixelRatio, q.pixels) : q.pixels * Math.min(devicePixelRatio, 1)
  return Math.max(.25, Math.floor(Math.min(own, Math.sqrt(q.budget / (w * h))) * (moving ? MOVING_PIXELS : 1) * 20) / 20)
}
/** The share of the pixels' side drawn while the camera is being turned (a smooth turn, the detail back on release). */
const MOVING_PIXELS = .6
/**
 * The automatic quality: over each AUTO_WINDOW ms of frames, a mean frame longer than AUTO_SLOW ms steps down a level
 * (under ~22 frames per second the view drags); shorter than AUTO_FAST ms for AUTO_RISE windows in a row steps up, but
 * never back up to a level it has left for being slow (so it does not swing).
 */
const AUTO_WINDOW = 2000, AUTO_SLOW = 45, AUTO_FAST = 20, AUTO_RISE = 5
/**
 * The observer on the ground (observer.ts): how far from the storm they stand by default, km; the field of
 * view and the look's pitch they start with (a lens of ~35 mm, the storm's tower in view); the radius the camera
 * turns round its eyes on, km (the controls orbit a point this close in front).
 */
/** The air between the camera and what it sees, from outside (shaders.ts uAirScale): half the true. */
const AIR_OUTSIDE = .5
/** The ways round a storm the observer may stand, looked at for clear sky. */
const OBSERVER_DIRECTIONS = 16
export const OBSERVER_BACK = 25, OBSERVER_NEAR = 12
const OBSERVER_FOV = 60, OBSERVER_PITCH = .2, LOOK_RADIUS = .001
/** The kinds of surface in the ground shader's order (shaders.ts groundSurfacePars uSurface). */
const SURFACES = ['grass', 'dry', 'water', 'urban'] as const
/** The ground's state: water, mm, at the top of its texture channel; the wind, m/s (shaders.ts GROUND_WATER, WIND_SCALE). */
const GROUND_WATER = 16, WIND_SCALE = 40
/** How fast the ground dries (soaking in, evaporating) and hail on it melts, s (e-folding). */
const DRY_TIME = 2400, MELT_TIME = 1800
/**
 * Extinction, 1/km, per (g/m3)^0.75 of an exponential spectrum N0 e^(-lambda D) of particles of density rho: twice the
 * cross section (diffraction), pi N0 / lambda^3 = (pi N0)^(1/4) rho^(-3/4) M^(3/4), M in kg/m3, per m.
 */
const extinction = (n0: number, density: number) => (Math.PI * n0) ** .25 * density ** -.75 * 1e-3 ** .75 * 1000
/** The share of the snow's extinction drawn outside the cloud above the melting level (updateVolume). */
const SNOW_VEIL = .2
/** The fall under the cloud, m, over which the snow outside it thins from whole to SNOW_VEIL (updateVolume). */
const VEIL_FALL = 2000
const SHAFT_RAIN = extinction(N0R, RHO_W), SHAFT_SNOW = extinction(N0S, RHO_S), SHAFT_GRAUPEL = extinction(N0G, RHO_G), SHAFT_HAIL = extinction(N0H, RHO_H)
/** The precipitation shafts' extinction at the top of the volume texture's channel, 1/km (shaders.ts SHAFT_MAX). */
const SHAFT_MAX = 6
/** The lab's background (as the sky dims to with a field shown; shaders.ts skyFragment). */
const LAB_SKY = new THREE.Color(.009, .026, .044)
/** The sky's tables are recomputed when the sun's elevation moves by this much, rad (0.1°). */
const SKY_STEP = .1 * Math.PI / 180

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
/** The tone mapping's exposure with the camera's settings neutral. */
const EXPOSURE = 1.05
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
  private readonly groundGrid: THREE.GridHelper; private readonly boxEdges: THREE.LineSegments
  /**
   * The observer on the ground (setObserver): where they stand, m from the ground origin (fixed to the ground, so a storm
   * passes over them as the domain follows it), and the orbit view to go back to.
   */
  private observer: Observer | null = null; private readonly orbitMax: number
  private orbitView: { position: THREE.Vector3; target: THREE.Vector3; fov: number } | null = null
  private readonly ground: THREE.Mesh; private readonly raycaster = new THREE.Raycaster(); private readonly pointer = new THREE.Vector2()
  private readonly sunLight: THREE.DirectionalLight; private readonly hemiLight: THREE.HemisphereLight
  /** The sky (sky.ts): its table, the uniforms it shares, the dome; the state it was computed for (the sun's step and the haze). */
  private readonly skyTexture: THREE.DataTexture; private readonly air: Record<string, THREE.IUniform>; private readonly skyMaterial: THREE.ShaderMaterial; private readonly skyDome: THREE.Mesh
  private sky?: SkyState; private skyKey = ''; private skyGain = 1; private night = 0; private haze = .1
  private readonly groundColor: THREE.Color; private readonly albedo: number
  /**
   * The ground's surface: its state texture (water, hail per ground column), the wind over it, their uniforms; the water
   * lying on each ground column (mm) and the share of it hail covers, from the model's totals since lastTime.
   */
  private readonly groundState: THREE.DataTexture; private readonly windTexture: THREE.DataTexture; private readonly groundUniforms: Record<string, THREE.IUniform>
  private readonly water: Float32Array; private readonly hailCover: Float32Array; private readonly lastPrecip: Float32Array; private readonly lastHail: Float32Array; private groundTime = NaN
  private readonly shared: Record<string, THREE.IUniform>
  private readonly light: LightVolume; private readonly flashLight: FlashVolume; private readonly strikeLight: THREE.PointLight
  /** The strongest updraught of each column, and of each column with those beside it (the tower's), m/s. */
  /** Scratch of the volume's update, per node: the cloud's extinction-weighted mass, the shafts' mass, the ice share, the tower's updraught. */
  private cloudMass?: Float32Array; private shaftMass?: Float32Array; private iceShare?: Float32Array; private towerScratch?: Float32Array; private towerField?: Float32Array; private fallenField?: Float32Array
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
  /** The camera's settings (setGrade). */
  private grade: CameraGrade = NEUTRAL_GRADE
  private frame = 0; private readonly lookScratch = new THREE.Vector3()
  /** The camera is being turned (OrbitControls between start and end, and the damping's tail after release: turnedAt). */
  private turning = false; private turnedAt = 0
  /** The quality chosen ('auto' or a level), the level drawn, and the automatic choice's state (setQuality). */
  private qualityChoice: Quality | 'auto' = 'auto'; level: Quality = 'high'
  private autoFrames = 0; private autoStart = 0; private autoLast = 0; private autoFast = 0; private autoCeiling = 2
  /** Called when the automatic choice changes the level (for the badge). */
  onLevel: ((level: Quality) => void) | null = null
  /**
   * Called when the GPU's driver cannot build a shader (a phone's stricter compiler), with its log and the GPU's name:
   * the view would stay black without a word. The level is lowered once first (fewer loops, smaller shaders).
   */
  onShaderError: ((log: string, gpu: string) => void) | null = null
  private shaderRetry: 'none' | 'pending' | 'done' = 'none'
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
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getShaderInfoLog(fs), gl.getShaderInfoLog(vs), gl.getProgramInfoLog(program)].filter(Boolean).join(' | ').trim() || 'без текста ошибки'
      console.error('MeteoLab shader error:', log)
      const info = gl.getExtension('WEBGL_debug_renderer_info'), gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      if (this.shaderRetry === 'pending') return
      if (this.shaderRetry === 'none' && this.level !== 'low') { this.shaderRetry = 'pending'; setTimeout(() => { this.shaderRetry = 'done'; this.autoCeiling = 0; this.applyLevel('low') }); return }
      this.onShaderError?.(log, gpu)
    }
    // A phone renders at 1 pixel per CSS pixel: its screen is small and its GPU weak (the clouds are ray-marched).
 this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = EXPOSURE
    this.scene = new THREE.Scene(); this.scene.fog = new THREE.FogExp2(0x9fb4c4, .1)
    this.camera = new THREE.PerspectiveCamera(42, 1, .1, 180 * scale); this.camera.position.set(38 * scale, 24 * scale, 39 * scale)
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('view-debug')) { (globalThis as { __stormView?: StormView }).__stormView = this; Object.assign(this, { debugQuality: true }) }
    this.controls = new OrbitControls(this.camera, canvas); this.controls.target.set(0, 6, 0); this.controls.enableDamping = true; this.controls.dampingFactor = .07; this.controls.maxPolarAngle = Math.PI * .495; this.controls.minDistance = 15; this.controls.maxDistance = this.orbitMax = 100 * scale
    // While the camera turns the view is drawn coarser (MOVING_PIXELS); full detail 0.4 s after release (the damping's
    // tail). Not by the controls' change event: from the ground the camera moves with the domain every frame.
    this.controls.addEventListener('start', () => { this.turning = true })
    this.controls.addEventListener('end', () => { this.turnedAt = performance.now() })
    this.hemiLight = new THREE.HemisphereLight(0xd9efff, 0x4b4439, 1); this.scene.add(this.hemiLight)
    this.sunLight = new THREE.DirectionalLight(0xfff0d2, 1); this.scene.add(this.sunLight)

    const ground = ({ grass: 0x596d45, dry: 0x776a51, water: 0x16364a, urban: 0x606469 } as const)[model.config.surfaceType]
    const groundMat = new THREE.MeshStandardMaterial({ color: ground, roughness: .96, metalness: 0 })
    this.groundColor = new THREE.Color(ground); this.albedo = luminance([this.groundColor.r, this.groundColor.g, this.groundColor.b])
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(W, D), groundMat); this.ground.rotation.x = -Math.PI / 2; this.scene.add(this.ground)
    // A city (SimConfig.city): the ground colour blends to the urban grey under it, one texel per ground column like the
    // swath, sliding with the ground in updateGround; repeated only along the axes where the ground repeats (groundRepeats).
    if ((model.config.city ?? 0) > 0) {
      const data = new Uint8Array(nx * ny * 4), a = new THREE.Color(ground), b = new THREE.Color(0x6e7175), mix = new THREE.Color(), rgb = { r: 0, g: 0, b: 0 }
      model.cityGround.forEach((share, i) => { mix.lerpColors(a, b, share).getRGB(rgb, THREE.SRGBColorSpace); data.set([rgb.r * 255, rgb.g * 255, rgb.b * 255, 255], i * 4) })
      this.cityTexture = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat); this.cityTexture.colorSpace = THREE.SRGBColorSpace
      this.cityTexture.magFilter = this.cityTexture.minFilter = THREE.LinearFilter; const [rx, ry] = groundRepeats(model)
      this.cityTexture.wrapS = rx ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; this.cityTexture.wrapT = ry ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; this.cityTexture.needsUpdate = true
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
    this.boxEdges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x75909c, transparent: true, opacity: .4 })); this.scene.add(this.boxEdges)
    this.levelHelpers = [0xb6d4dd, 0xe1bf7e, 0xd88e74].map(color => { const h = new THREE.GridHelper(W, 12, color, color); h.material.transparent = true; h.material.opacity = .18; this.scene.add(h); return h })

    this.shared = {
      uBoxMin: { value: new THREE.Vector3(-W / 2, 0, -D / 2) }, uBoxMax: { value: new THREE.Vector3(W / 2, H, D / 2) }, uGrid: { value: new THREE.Vector3(nx, ny, nz) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uHeight: { value: H }, uExtinction: { value: 2.2 }, uSliceOn: { value: 0 }, uSliceH: { value: 2 }, uSliceZ: { value: 0 },
    }
    // The sky (sky.ts): its table and how bright it is drawn, shared by the dome and the clouds' aerial perspective.
    this.skyTexture = new THREE.DataTexture(new Uint16Array(SKY_COLS * SKY_ROWS * 4), SKY_COLS, SKY_ROWS, THREE.RGBAFormat, THREE.HalfFloatType)
    this.skyTexture.minFilter = this.skyTexture.magFilter = THREE.LinearFilter
    this.air = { uSky: { value: this.skyTexture }, uSkyGain: { value: 1 }, uSkyFloor: { value: new THREE.Color() }, uCityGlow: { value: new THREE.Color() }, uHaze: { value: .1 }, uAirScale: { value: AIR_OUTSIDE } }
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: skyVertex, fragmentShader: skyFragment, side: THREE.BackSide, depthWrite: false, depthTest: false,
      uniforms: { uSunDir: this.shared.uSunDir, ...this.air, uSunDisc: { value: new THREE.Color() }, uGroundLight: { value: new THREE.Color() }, uStars: { value: 0 }, uLab: { value: 0 }, uWater: { value: model.config.surfaceType === 'water' ? 1 : 0 } },
    })
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.skyMaterial); this.skyDome.frustumCulled = false; this.skyDome.renderOrder = -1; this.scene.add(this.skyDome)
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
        ...this.shared, uDensity: { value: this.volumeTexture }, uNoise: { value: this.noise }, uColumns: { value: this.columnTexture }, uLight: { value: this.light.texture }, uFlashA: { value: this.flashLight.targets[0].texture }, uFlashB: { value: this.flashLight.targets[1].texture }, uFlashIA: { value: new THREE.Vector4() }, uFlashIB: { value: new THREE.Vector4() }, uFlashOn: { value: 0 }, uSunByHeight: { value: Array.from({ length: SUN_LEVELS }, () => new THREE.Vector3()) }, uAmbientTop: { value: new THREE.Color() }, uAmbientBottom: { value: new THREE.Color() }, uBounceSun: { value: new THREE.Color() },
        ...this.air, uTime: { value: 0 }, uOpacity: { value: 1 }, uFreezing: { value: 4 },
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

    // The ground's surface: its state (water, hail) per ground column, the wind over it per domain column.
    this.groundState = new THREE.DataTexture(new Uint8Array(nx * ny * 4), nx, ny, THREE.RGBAFormat)
    this.groundState.magFilter = this.groundState.minFilter = THREE.LinearFilter; this.groundState.wrapS = this.groundState.wrapT = THREE.RepeatWrapping; this.groundState.needsUpdate = true
    this.windTexture = new THREE.DataTexture(new Uint8Array(nx * ny), nx, ny, THREE.RedFormat)
    this.windTexture.magFilter = this.windTexture.minFilter = THREE.LinearFilter; this.windTexture.wrapS = this.windTexture.wrapT = THREE.RepeatWrapping; this.windTexture.needsUpdate = true
    this.water = new Float32Array(nx * ny); this.hailCover = new Float32Array(nx * ny); this.lastPrecip = new Float32Array(nx * ny); this.lastHail = new Float32Array(nx * ny)
    const surface = SURFACES.indexOf(model.config.surfaceType)
    this.groundUniforms = { uGround: { value: this.groundState }, uWind: { value: this.windTexture }, uGroundOffset: { value: new THREE.Vector2() }, uGroundSize: { value: new THREE.Vector2(W, D) }, uSurface: { value: surface } }
    Object.assign(this.skyMaterial.uniforms, this.shared, this.groundUniforms, { uNoise: { value: this.noise } })
    groundMat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, { ...this.shared, ...this.air, ...this.groundUniforms, uNoise: { value: this.noise }, uLight: this.volumeMaterial.uniforms.uLight })
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;').replace('#include <project_vertex>', '#include <project_vertex>\nvCloudWorld=(modelMatrix*vec4(transformed,1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${groundShadowPars}\n${groundSurfacePars}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec2 g = groundAt(vCloudWorld), q = g * uGroundSize;
  vec4 st = texture(uGround, g);
  gWater = st.r * GROUND_WATER; gHail = st.g;
  float blur = min(length(dFdx(q)), length(dFdy(q)));
  if(abs(uSurface - 2.0) < 0.5){
    // Water: foam from the breaking waves, 3.84e-6 U^3.41 of the surface (Monahan & O'Muircheartaigh 1980: ~1% at
    // 10 m/s, ~10% at 20), for the wind at 10 m (the model's lowest level is ~50 m: U10 ~ U50 / 1.15).
    float U = texture(uWind, toTex(vCloudWorld).xy).r * WIND_SCALE / 1.15;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6), clamp(3.84e-6 * pow(U, 3.41), 0.0, 0.3));
    gSpec = 1.0;
  } else {
    diffuseColor.rgb *= landPattern(q, blur);
    // Wet: bare soil and asphalt about half as bright (Lekner & Dorf 1988), crops and grass hardly darker; water stands
    // on asphalt after a millimetre or two, on soil (soaking it up) after ~5 mm, in fields after ~10.
    float urban = step(2.5, uSurface), steppe = step(0.5, uSurface) * (1.0 - urban);
    float wet = mix(mix(0.88, 0.7, steppe), 0.55, urban), pond = mix(mix(10.0, 5.0, steppe), 1.5, urban);
    diffuseColor.rgb *= mix(1.0, wet, smoothstep(0.0, 0.3, gWater));
    gSpec = smoothstep(pond, pond * 2.0, gWater);
  }
  // Hail lying white over the ground.
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.75, 0.78), gHail);
}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
if(abs(uSurface - 2.0) < 0.5){
  // The sea's roughness from the wind over it (Cox & Munk 1954: the slopes' variance 0.003 + 0.00512 U10, both axes;
  // three's GGX alpha is roughness squared, ~ the slopes' rms): calm water a sharp glitter of the sun, a gale a broad one.
  float U = texture(uWind, toTex(vCloudWorld).xy).r * WIND_SCALE / 1.15;
  roughnessFactor = sqrt(sqrt(0.003 + 0.00512 * U));
} else roughnessFactor = mix(roughnessFactor, 0.15, gSpec);`).replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n{vec3 s=cloudShade(vCloudWorld);reflectedLight.indirectDiffuse=reflectedLight.indirectDiffuse*s.y+reflectedLight.directDiffuse*s.z;reflectedLight.directDiffuse*=s.x;reflectedLight.directSpecular*=s.x;' +
        // Water reflects the sky (Fresnel, n = 1.33), where the sky is seen from it.
        'vec3 V=normalize(cameraPosition-vCloudWorld);float F=0.02+0.98*pow(1.0-max(V.y,0.0),5.0);reflectedLight.indirectSpecular+=skyAt(vec3(-V.x,V.y,-V.z))*F*gSpec*s.y*(1.0-gHail);}')
        // The air between the camera and the ground, before the tone mapping as for the clouds and the sky (three's fog
        // comes after it); the air in the storm's shadow scatters less light (shaders.ts airLit).
        .replace('#include <fog_fragment>', '')
        .replace('#include <tonemapping_fragment>', '{vec3 T;vec3 ins=aerial(cameraPosition,normalize(vCloudWorld-cameraPosition),length(vCloudWorld-cameraPosition),T);gl_FragColor.rgb=gl_FragColor.rgb*T+ins*airLit(cameraPosition,vCloudWorld);}\n#include <tonemapping_fragment>')
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
    // A phone starts low, a computer high; the automatic choice moves from there.
    this.applyLevel(isPhone() ? 'low' : 'high')
  }

  dispose() {
    this.controls.dispose()
    ;[this.groundState, this.windTexture, this.skyTexture, this.skyMaterial, this.skyDome.geometry, this.volumeTexture, this.noise, this.columnTexture, this.fieldTexture, this.colormap, this.volumeMaterial, this.fieldMaterial, this.sliceMaterial, this.volumeMesh.geometry, this.sliceH.geometry, this.sliceV.geometry, this.precipGeometry, this.precipMaterial, this.swathTexture, this.cityTexture, this.zoneTexture, this.frontLine?.geometry, this.frontLine?.material as THREE.Material | undefined, this.swath.geometry, this.swath.material as THREE.Material, this.mesoMarker.geometry, this.mesoMarker.material as THREE.Material, this.selectionMarker.geometry, this.selectionMarker.material as THREE.Material, this.stationMarker.geometry, this.stationMarker.material as THREE.Material, this.lightning, this.light, this.flashLight].forEach(r => r?.dispose())
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
    ;(this.groundUniforms.uGroundOffset.value as THREE.Vector2).set(ox / width, oy / depth)
    this.updateSurface()
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

  /** The ground point under normalised screen coordinates, m from the domain corner, or null off the domain's ground. */
  groundHit(nx: number, ny: number) {
    const { width, depth } = this.model.grid
    this.pointer.set(nx * 2 - 1, -(ny * 2 - 1)); this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.ground, false)[0]
    return hit ? { x: clamp((hit.point.x + width / 2000) * 1000, 0, width), y: clamp((depth / 2000 - hit.point.z) * 1000, 0, depth) } : null
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
    // The observer moves with the model's time (standing still until sent somewhere: the storm chaser to come).
    this.observer?.step(seconds)
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
    const m = this.model, s = this.debugSunHour === null ? sunDirection(m.config, m.time) : sunDirection({ ...m.config, hour: this.debugSunHour }, 0)
    // Seen through the air the sun stands higher by the refraction (Sæmundsson 1986: ~0.57° at the horizon), fading out
    // a few degrees below it (where the sun's own light no longer matters).
    const geometric = Math.asin(clamp(s.y, -1, 1)) * 180 / Math.PI, e = Math.max(geometric, -1.9)
    const el = (geometric + 1.02 / Math.tan((e + 10.3 / (e + 5.11)) * Math.PI / 180) / 60 * clamp((geometric + 4) / 2.1)) * Math.PI / 180
    const flat = Math.hypot(s.x, s.z) || 1, dir = new THREE.Vector3(s.x / flat * Math.cos(el), Math.sin(el), s.z / flat * Math.cos(el))
    ;(this.shared.uSunDir.value as THREE.Vector3).copy(dir)
    this.sunLight.position.copy(dir).multiplyScalar(50)
    if (this.frame % 120 === 0) this.haze = this.hazeNow()
    const key = `${Math.round(el / SKY_STEP)} ${this.haze}`
    if (key !== this.skyKey) { this.skyKey = key; this.updateSky(el) }
    this.updateFog()
  }

  /**
   * The aerosol's extinction at the ground, 1/km (sky.ts hazeExtinction), from the relative humidity of the model's
   * lowest level over the ground: its median over the columns, the air of the place rather than of a storm's cold pool
   * (a humid day is hazy). Rounded to 0.005/km so the sky's tables are not recomputed for noise.
   */
  private hazeNow() {
    const m = this.model, { layer } = m.grid, z = 1, exner = m.env.exner[z], p = m.env.p[z], rh = new Float32Array(layer)
    for (let c = 0; c < layer; c++) { const i = c + z * layer; rh[c] = Math.min(1, m.q[i] / qsatP(m.theta[i] * exner - 273.15, p)) }
    return Math.round(hazeExtinction(rh.sort()[layer >> 1]) * 200) / 200
  }

  /** The sky's tables for the sun at elevation el, rad, and the light of the day from them. */
  private updateSky(el: number) {
    const st = this.sky = computeSky(el, this.haze, this.albedo), half = this.skyTexture.image.data as Uint16Array, toHalf = THREE.DataUtils.toHalfFloat
    for (let i = 0; i < SKY_ROWS * SKY_COLS; i++) { for (let c = 0; c < 3; c++) half[i * 4 + c] = toHalf(st.sky[i * 3 + c]); half[i * 4 + 3] = toHalf(1) }
    this.skyTexture.needsUpdate = true
    const S = st.sunIrradiance, E = st.skyIrradiance, adapt = adaptation(luminance(S) + luminance(E)), u = this.volumeMaterial.uniforms, g = this.groundColor
    const night = this.night = (adapt / ADAPT_MAX) ** 2, city = clamp((this.model.config.city ?? 0) / 8) * night, sky = this.skyGain = SKY_GAIN * adapt
    this.air.uSkyGain.value = sky; this.air.uHaze.value = this.haze
    ;(this.air.uSkyFloor.value as THREE.Color).fromArray(NIGHT_SKY.map(v => v * night)); (this.air.uCityGlow.value as THREE.Color).fromArray(CITY_SKY.map(v => v * city))
    ;(u.uSunByHeight.value as THREE.Vector3[]).forEach((v, i) => v.fromArray(st.sunByHeight, i * 3).multiplyScalar(SUN_GAIN * adapt))
    ;(u.uAmbientTop.value as THREE.Color).setRGB(...[0, 1, 2].map(c => E[c] / Math.PI * sky + NIGHT_TOP[c] * night) as [number, number, number])
    ;(u.uAmbientBottom.value as THREE.Color).setRGB(...[0, 1, 2].map(c => this.albedo * E[c] / Math.PI * sky + NIGHT_BOTTOM[c] * night + CITY_BOTTOM[c] * city) as [number, number, number])
    ;(u.uBounceSun.value as THREE.Color).setRGB(...[0, 1, 2].map(c => this.albedo * S[c] / Math.PI * sky) as [number, number, number])
    const ground = SKY_GAIN * adapt
    this.sunLight.color.setRGB(st.sunByHeight[0] * ground, st.sunByHeight[1] * ground, st.sunByHeight[2] * ground)
    this.hemiLight.color.setRGB(...[0, 1, 2].map(c => E[c] * ground + NIGHT_GROUND[c] * night) as [number, number, number])
    this.hemiLight.groundColor.setRGB(...[0, 1, 2].map(c => this.albedo * (S[c] + E[c]) * ground) as [number, number, number])
    const su = this.skyMaterial.uniforms
    ;(su.uSunDisc.value as THREE.Color).setRGB(st.sunByHeight[0] * SUN_DISC * adapt, st.sunByHeight[1] * SUN_DISC * adapt, st.sunByHeight[2] * SUN_DISC * adapt)
    // The ground beyond the domain, as the domain's ground is lit (three's Lambertian: albedo / pi times the irradiance).
    ;(su.uGroundLight.value as THREE.Color).setRGB(...[0, 1, 2].map(c => [g.r, g.g, g.b][c] / Math.PI * ((S[c] + E[c]) * ground + NIGHT_GROUND[c] * night)) as [number, number, number])
    // The stars come out as the eye adapts to the dark.
    su.uStars.value = night * night
  }

  /**
   * The view as a PNG: drawn again at its full detail (not the coarser turning one) and read back in the same task —
   * the drawing buffer is not preserved between frames.
   */
  snapshot() {
    this.turning = false; this.render()
    // The camera's grade is a filter on the canvas (setGrade): the picture is drawn through the same filter.
    const filter = gradeFilter(this.grade), out = filter === 'none' ? this.canvas : document.createElement('canvas')
    if (out !== this.canvas) { out.width = this.canvas.width; out.height = this.canvas.height; const ctx = out.getContext('2d')!; ctx.filter = filter; ctx.drawImage(this.canvas, 0, 0) }
    return new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  }

  /** The camera's settings (src/camera.ts): the exposure into the tone mapping, the rest as a filter over the frame. */
  setGrade(g: CameraGrade) {
    this.grade = { ...g }; this.renderer.toneMappingExposure = EXPOSURE * 2 ** g.exposure
    const filter = gradeFilter(g); this.canvas.style.filter = filter === 'none' ? '' : filter
  }

  /** Whether a pointer is held on the view (the controls' own state, not in three's types). */
  private dragging() { return (this.controls as unknown as { state: number }).state !== -1 }

  /**
   * The quality: a level, or 'auto' (by the frame time, from `start` — the level the last view settled on — or the
   * phone's or computer's start).
   */
  setQuality(q: Quality | 'auto', start?: Quality) {
    this.qualityChoice = q; this.autoFrames = 0; this.autoFast = 0; this.autoCeiling = 2
    this.applyLevel(q === 'auto' ? start ?? (isPhone() ? 'low' : 'high') : q)
  }
  get quality() { return this.qualityChoice }

  private applyLevel(level: Quality) {
    const q = QUALITY[level], defines = { STEPS: q.steps, MAX_STEPS: q.maxSteps, FINE_STEP: q.fine.toFixed(2), SHADOW_PROBES: q.probes, AIR_SAMPLES: q.air }
    this.level = level
    this.renderer.setPixelRatio(pixelRatioFor(level, Math.max(2, this.canvas.clientWidth), Math.max(2, this.canvas.clientHeight), this.turning))
    for (const mat of [this.volumeMaterial, this.ground.material as THREE.Material]) { mat.defines = { ...mat.defines, ...defines }; mat.needsUpdate = true }
    this.onLevel?.(level)
  }

  /** The automatic quality (AUTO_*): called every frame with its time. */
  private autoQuality(now: number) {
    // The checks of the picture (?view-debug) run on a software renderer: there the automatic choice would always fall
    // to low, so it keeps the level it starts from.
    if (this.qualityChoice !== 'auto' || 'debugQuality' in this) return
    if (this.autoFrames === 0) { this.autoStart = now; this.autoLast = now; this.autoFrames = 1; return }
    // A pause in the frames (a hidden tab, an instrument's screen over the view) is not a slow frame.
    if (now - this.autoLast > 1000) { this.autoFrames = 0; return }
    this.autoLast = now; this.autoFrames++
    if (now - this.autoStart < AUTO_WINDOW) return
    const mean = (now - this.autoStart) / (this.autoFrames - 1), i = QUALITIES.indexOf(this.level)
    this.autoFrames = 0
    if (mean > AUTO_SLOW && i > 0) { this.autoCeiling = i - 1; this.autoFast = 0; this.applyLevel(QUALITIES[i - 1]) }
    else if (mean < AUTO_FAST && i < this.autoCeiling) { if (++this.autoFast >= AUTO_RISE) { this.autoFast = 0; this.applyLevel(QUALITIES[i + 1]) } }
    else this.autoFast = 0
  }

  /**
   * The water and hail on the ground, as the model time runs: rain (the model's totals per ground column) wets it, and it
   * dries in DRY_TIME with the sun high (soaking in and evaporating: ~an hour to look dry again), four times slower at
   * night (soaking in alone; the clouds' shade is not counted); hail covers it by the stones' cross
   * section (1.5 M / (rho D) of the ground per kg/m2 of stones of diameter D, half the largest) and melts in MELT_TIME.
   * After a jump in time (a loaded state, a rewind) the totals are taken as fresh.
   */
  private updateSurface() {
    const m = this.model, dt = m.time - this.groundTime, { layer } = m.grid, st = this.groundState.image.data as Uint8Array, fresh = !(dt >= 0 && dt < 900)
    if (dt === 0) return
    const sun = clamp((this.shared.uSunDir.value as THREE.Vector3).y / .5), dry = fresh ? 1 : Math.exp(-dt * (.25 + .75 * sun) / DRY_TIME), melt = fresh ? 1 : Math.exp(-dt / MELT_TIME)
    for (let i = 0; i < layer; i++) {
      const rain = m.precipitation[i] - (fresh ? 0 : this.lastPrecip[i]), hail = m.hailGround[i] - (fresh ? 0 : this.lastHail[i])
      this.water[i] = fresh ? Math.min(m.precipitation[i], GROUND_WATER) * .5 : Math.min(this.water[i] * dry + Math.max(rain, 0), GROUND_WATER * 2)
      const d = Math.max(m.hailSize[i] / 2, 5) / 1000
      this.hailCover[i] = this.hailCover[i] * melt + Math.max(hail, 0) * 1.5 / (900 * d)
      this.lastPrecip[i] = m.precipitation[i]; this.lastHail[i] = m.hailGround[i]
      st[i * 4] = clamp(this.water[i] / GROUND_WATER) * 255; st[i * 4 + 1] = (1 - Math.exp(-this.hailCover[i])) * 255
    }
    this.groundTime = m.time; this.groundState.needsUpdate = true
    // The wind over the ground (the model's in the moving frame plus the frame's motion), at the lowest level.
    const wd = this.windTexture.image.data as Uint8Array, [fx, fy] = m.frame
    for (let c = 0; c < layer; c++) wd[c] = clamp(Math.hypot(m.u[c] + fx, m.v[c] + fy) / WIND_SCALE) * 255
    this.windTexture.needsUpdate = true
  }

  /** The fog's colour: the sky's at the horizon in the direction looked in (and the haze's extinction). */
  private updateFog() {
    const st = this.sky, fog = this.scene.fog as THREE.FogExp2
    if (!st) return
    const look = this.camera.getWorldDirection(this.lookScratch), sun = this.shared.uSunDir.value as THREE.Vector3
    const az = Math.abs(Math.atan2(look.x * sun.z - look.z * sun.x, look.x * sun.x + look.z * sun.z)), col = Math.round(az / Math.PI * (SKY_COLS - 1)), city = clamp((this.model.config.city ?? 0) / 8) * this.night
    fog.color.setRGB(...[0, 1, 2].map(c => st.sky[col * 3 + c] * this.skyGain + NIGHT_SKY[c] * this.night + CITY_SKY[c] * city) as [number, number, number])
    if (this.skyMaterial.uniforms.uLab.value > 0) fog.color.lerp(LAB_SKY, this.skyMaterial.uniforms.uLab.value)
    fog.density = this.haze
  }

  private updateLevels() {
    const s = this.model.sounding, lv = [s.lcl, s.lfc, s.el], lab = !this.observer
    this.levelHelpers.forEach((h, i) => { h.visible = lab && lv[i] !== null; if (lv[i] !== null) h.position.y = lv[i]! })
    this.freezingHelper.position.y = s.freezing ?? 0
    this.boxEdges.visible = this.groundGrid.visible = lab
  }

  /** Whether the view is from the ground (stand), and the observer there (for the storm chaser to come). */
  get fromGround() { return !!this.observer }
  get groundObserver() { return this.observer }

  /**
   * A suggested place to stand (m from the ground origin): `distance` km from the strongest updraught at 5 km (or, with
   * no storm, from the ground under the middle of the view), where the storm is seen whole — of OBSERVER_DIRECTIONS
   * ways round it, one with clear sky over the observer and a third of the way back (not under the anvil, its rain or
   * its neighbours), preferring the storm's inflow side, right of its motion (the domain follows the storm: its motion
   * is the frame's; there the updraught's base is seen and the rain core is not in the way), then the sun behind the
   * observer, then the camera's side. Maybe outside the domain (the ground goes on there).
   */
  suggestPlace(distance: number): GroundPoint {
    const m = this.model, look = this.stormCentre() ?? this.groundPoint(.5, .5), [lx, , lz] = this.toWorld(look.x, look.y, 0), [fu, fv] = m.frame
    const sun = this.shared.uSunDir.value as THREE.Vector3, cam = new THREE.Vector2(this.camera.position.x - lx, this.camera.position.z - lz).normalize()
    // Right of the motion (u, v) is (v, -u) on the ground, (v, u) in the world (its z runs south).
    const right = new THREE.Vector2(fv, fu).divideScalar(Math.max(Math.hypot(fu, fv), 2)), sunFlat = new THREE.Vector2(sun.x, sun.z)
    let dx = cam.x, dz = cam.y, best = -Infinity
    for (let j = 0; j < OBSERVER_DIRECTIONS; j++) {
      const angle = j / OBSERVER_DIRECTIONS * 2 * Math.PI, ux = Math.cos(angle), uz = Math.sin(angle)
      const over = this.cloudOver(lx + ux * distance, lz + uz * distance) + this.cloudOver(lx + ux * distance * 2 / 3, lz + uz * distance * 2 / 3)
      const score = -10 * over + (ux * right.x + uz * right.y) + .5 * (ux * sunFlat.x + uz * sunFlat.y) + .2 * (ux * cam.x + uz * cam.y)
      if (score > best) { best = score; dx = ux; dz = uz }
    }
    return this.worldToGround(lx + dx * distance, lz + dz * distance)
  }

  /** The ground point (m from the ground origin) under normalised screen coordinates, or null off the domain's ground. */
  groundUnder(nx: number, ny: number): GroundPoint | null {
    const p = this.groundHit(nx, ny), m = this.model
    return p && { x: p.x + m.frame[0] * m.time, y: p.y + m.frame[1] * m.time }
  }

  /** World x, z (km) to the ground point under it now (not wrapped into the domain). */
  private worldToGround(wx: number, wz: number): GroundPoint {
    const m = this.model, { width, depth } = m.grid
    return { x: (wx + width / 2000) * 1000 + m.frame[0] * m.time, y: (depth / 2000 - wz) * 1000 + m.frame[1] * m.time }
  }

  /**
   * The view from the ground: the camera at an observer's eyes at a ground point (m from the ground origin), turning
   * round where they stand (drag), the wheel narrowing or widening the field of view; the lab's helpers hidden. Looking
   * at the storm (the strongest updraught; with none, ahead as before), or with `keepLook` (going a little way from
   * the ground) as they looked.
   */
  stand(at: GroundPoint, keepLook = false) {
    const c = this.controls, first = !this.observer
    if (first) this.orbitView = { position: this.camera.position.clone(), target: c.target.clone(), fov: this.camera.fov }
    if (this.observer) this.observer.standAt(at)
    else this.observer = new Observer(at)
    this.air.uAirScale.value = 1
    this.camera.near = .005; if (first) this.camera.fov = OBSERVER_FOV; this.camera.updateProjectionMatrix()
    Object.assign(c, { minPolarAngle: .02 * Math.PI, maxPolarAngle: .98 * Math.PI, enablePan: false, enableZoom: false, rotateSpeed: -.35 })
    c.minDistance = c.maxDistance = LOOK_RADIUS
    const eye = this.observerEye(), storm = this.stormCentre()
    if (!keepLook || first) {
      let dir: THREE.Vector3
      if (storm) { const [lx, , lz] = this.toWorld(storm.x, storm.y, 0); dir = new THREE.Vector3(lx - eye.x, 0, lz - eye.z) }
      else dir = first ? new THREE.Vector3(-this.camera.position.x + this.orbitView!.target.x, 0, -this.camera.position.z + this.orbitView!.target.z) : c.target.clone().sub(this.camera.position).setY(0)
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1)
      dir.normalize(); dir.y = Math.tan(OBSERVER_PITCH); dir.normalize()
      this.camera.position.copy(eye); c.target.copy(eye).addScaledVector(dir, LOOK_RADIUS)
    }
    this.updateLevels()
  }

  /** Back to the view from outside as it was before standing on the ground. */
  leaveGround() {
    if (!this.observer) return
    const c = this.controls, o = this.orbitView!
    this.observer = null
    this.camera.position.copy(o.position); c.target.copy(o.target); this.camera.fov = o.fov; this.camera.near = .1; this.camera.updateProjectionMatrix()
    Object.assign(c, { minPolarAngle: 0, maxPolarAngle: Math.PI * .495, enablePan: true, enableZoom: true, rotateSpeed: 1 })
    c.minDistance = 15; c.maxDistance = this.orbitMax; c.update(); this.updateLevels(); this.air.uAirScale.value = AIR_OUTSIDE
  }

  /**
   * The observer's eyes in the world now (the domain moves under the ground point; not wrapped: one outside the domain
   * stays there, and the storm moves off as the domain follows it).
   */
  private observerEye() {
    const m = this.model, o = this.observer!, [x, y, z] = this.toWorld(o.x - m.frame[0] * m.time, o.y - m.frame[1] * m.time, o.eyeHeight)
    return new THREE.Vector3(x, y, z)
  }

  /**
   * How much cloud is over a world point (km; outside the domain none: nothing is drawn there): the drawn cloud's
   * opacity summed up its column (0 clear, ~1 and more overcast).
   */
  private cloudOver(wx: number, wz: number) {
    const m = this.model, { nx, ny, nz, layer, dx, dy, width, depth } = m.grid, x = (wx + width / 2000) * 1000, y = (depth / 2000 - wz) * 1000
    if (x < 0 || y < 0 || x >= width || y >= depth) return 0
    const c = Math.min(nx - 1, Math.round(x / dx)) + Math.min(ny - 1, Math.round(y / dy)) * nx
    let sum = 0
    for (let z = 0; z < nz; z++) sum += cloudOpacity((this.cloudMass?.[c + z * layer] ?? 0))
    return sum / 4
  }

  /** The column of the strongest updraught at 5 km (m from the domain corner), or null under 5 m/s. */
  private stormCentre() {
    const m = this.model, { layer, nx, dx, dy } = m.grid, k = Math.round(levelAt(m.grid, 5000))
    let best = 5, at = -1
    for (let c = 0; c < layer; c++) if (m.w[c + k * layer] > best) { best = m.w[c + k * layer]; at = c }
    return at < 0 ? null : { x: (at % nx) * dx, y: Math.floor(at / nx) * dy }
  }

  /** The observer's place every frame: the eyes at the ground point, the look kept. */
  private followObserver() {
    if (!this.observer) return
    const c = this.controls, eye = this.observerEye(), dir = c.target.clone().sub(this.camera.position).normalize()
    this.camera.position.copy(eye); c.target.copy(eye).addScaledVector(dir, LOOK_RADIUS)
  }

  /** The wheel from the ground: the field of view, 10-80°. */
  zoomFromGround(deltaY: number) {
    if (!this.observer) return false
    this.camera.fov = clamp(this.camera.fov * Math.exp(deltaY * .001), 10, 80); this.camera.updateProjectionMatrix()
    return true
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

  // Visual only: a particle's phase comes from its height relative to the environmental 0 °C level, not from the model's own
  // snow, graupel and rain (the shafts in the cloud volume are those).
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
    // How far each point lies under the cloud over it, m (VEIL_FALL; far: none above).
    const fallen = this.fallenField ??= new Float32Array(n)
    for (let c = 0; c < layer; c++) {
      let base = Infinity
      for (let z = nz - 1; z >= 0; z--) {
        const i = c + z * layer
        if (cloudOpacity(m.cloud[i] + ICE_EXTINCTION * m.ice[i]) > .5) base = zs[z]
        fallen[i] = base - zs[z]
      }
    }
    for (let z = 0, i = 0; z < nz; z++) for (let c = 0; c < layer; c++, i++) {
      const frozen = m.theta[i] * exner[z] < 273.15, rimers = m.graupel[i] + m.hail[i], icy = m.ice[i] + m.snow[i]
      // The shafts' extinction, 1/km, each kind from its own size distribution (extinction(): rain 2.2 M^0.75, M in g/m3,
      // ~1 km visibility in 3 g/m3 of a cloudburst; snow ~10 M^0.75, graupel, hail). Snow, graupel and hail above the
      // melting level are cloud inside the cloud (its ice and droplets: there they would only grey it) and shafts
      // outside it, by the cloud's opacity: so the precipitation falling out of an anvil is a curtain from the anvil's
      // base down, not one that starts at the melting level (a flat sheet there, 100 times denser than the cloud's
      // share of the snow over it — the testers' 15.10.2026).
      const rho = m.env.rho[z] * 1000, frozenShaft = SHAFT_SNOW * Math.pow(m.snow[i] * rho, .75) + SHAFT_GRAUPEL * Math.pow(m.graupel[i] * rho, .75) + SHAFT_HAIL * Math.pow(m.hail[i] * rho, .75)
      // Above the melting level, outside the cloud, at SNOW_VEIL of its extinction: the model keeps the snow falling out of
      // an anvil longer than nature, where most of it sublimates — drawn whole, it hung under the anvil as dense striped
      // walls (the testers' 15.10.2026). Whole just under the cloud, thinning to the veil over VEIL_FALL of the fall (as
      // virga: the snow sublimates as it falls), and whole again over the last 8 K to 0 °C (~1.2 km): with a sharper
      // change the rain under it began at the melting level as a flat-topped box apart from the cloud's base (the
      // testers' 15.10.2026). A visual choice, not the model's.
      const cloudy = frozen ? cloudOpacity(m.cloud[i] + ICE_EXTINCTION * m.ice[i]) : 0
      const veil = lerp(SNOW_VEIL, 1, Math.max(clamp((m.theta[i] * exner[z] - 265.15) / 8), 1 - clamp((fallen[i] - 300) / VEIL_FALL)))
      mass[i] = m.cloud[i] + ICE_EXTINCTION * m.ice[i] + (SNOW_EXTINCTION * m.snow[i] + RIMER_EXTINCTION * rimers) * cloudy
      shafts[i] = SHAFT_RAIN * Math.pow(m.rain[i] * rho, .75) + frozenShaft * (1 - cloudy) * veil
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
      d[o * 4] = cloudOpacity(lerp(mass[i], mass[j], f)) * 255; d[o * 4 + 1] = clamp(lerp(shafts[i], shafts[j], f) / SHAFT_MAX) * 255
      d[o * 4 + 2] = clamp(lerp(tower[i], tower[j], f) / UPDRAUGHT_SCALE) * 255; d[o * 4 + 3] = lerp(share[i], share[j], f) * 255
    }
    if (!tl) for (let i = 0; i < n; i++) put(i, i, i, 0)
    else for (let t = 0, o = 0; t < tl.nz; t++) {
      const base = tl.k0[t] * layer, f = tl.f[t]
      for (let c = 0; c < layer; c++, o++) put(o, base + c, Math.min(base + c + layer, n - 1), f)
    }
    this.volumeTexture.needsUpdate = true; this.volumeMaterial.uniforms.uTime.value = m.time; this.volumeMaterial.uniforms.uFreezing.value = m.sounding.freezing ?? 0
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
    const width = Math.max(2, this.canvas.clientWidth), height = Math.max(2, this.canvas.clientHeight), fit = pixelRatioFor(this.level, width, height, this.turning)
    if (fit !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(fit)
    const ratio = this.renderer.getPixelRatio()
    // Against the renderer's own pixel ratio (1 on a phone): compared with 1.5 there, the canvas was resized, and its
    // drawing buffer reallocated, on every frame — on a weak phone GPU until the WebGL context was lost (a black view).
    if (this.canvas.width !== Math.floor(width * ratio) || this.canvas.height !== Math.floor(height * ratio)) {
      this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix()
    }
    this.autoQuality(performance.now())
    if (this.turning && !this.dragging() && performance.now() - this.turnedAt > 400) this.turning = false
    const field = s.field === 'composite' ? null : s.field
    // With a field shown the sky dims toward the lab's dark blue (the field's colours read against it).
    this.skyMaterial.uniforms.uLab.value = field ? .8 : 0
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
    this.mesoMarker.visible = s.showMesocyclone && r.uh >= UH_ROTATING && !this.observer
    if (this.mesoMarker.visible) {
      const [wx, , wz] = this.toWorld(r.x * dx, r.y * dy, 0)
      this.mesoMarker.position.x = wx; this.mesoMarker.position.z = wz
      ;(this.mesoMarker.material as THREE.MeshBasicMaterial).color.set(r.persisted >= MESO_PERSISTENCE ? 0xf0b44c : 0xc9d6dc)
    }
    this.selectionMarker.visible = !!this.selection
    if (this.selection) { const [wx, , wz] = this.toWorld(this.selection.x, this.selection.y, 0); this.selectionMarker.position.x = wx; this.selectionMarker.position.z = wz }
    this.stationMarker.visible = !!this.station && !this.observer
    if (this.station) { const [wx, , wz] = this.toWorld(this.station.x, this.station.y, 0); this.stationMarker.position.x = wx; this.stationMarker.position.z = wz }
    this.precipPoints.visible = s.showPrecip; this.freezingHelper.visible = s.showPrecip && m.sounding.freezing !== null
    if (s.showPrecip) { this.syncPrecip(); this.precipMaterial.uniforms.uScale.value = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y * .5 }
    if (s.showVectors && this.frame % 4 === 0) this.updateVectors()
    this.followObserver()
    this.frame++; this.controls.update(); this.renderer.render(this.scene, this.camera)
  }
}
