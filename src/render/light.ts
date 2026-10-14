import * as THREE from 'three'
import { lightVolumeFragment, lightVolumeVertex } from './shaders'

/**
 * The light of the cloud volume, computed on the GPU into a 3D texture of the cloud texture's size: in each texel R the
 * optical depth towards the sun through the whole column (encoded 1 - exp(-od / LIGHT_OD_SCALE)), G the share of the sky
 * seen from there. The clouds and the ground read it instead of marching to the sun themselves: a tall tower shades its
 * own lower part and the anvil the ground under it, and the inside of a cloud sees less sky than its edge.
 */
export class LightVolume {
  readonly target: THREE.WebGL3DRenderTarget
  private readonly scene = new THREE.Scene(); private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: THREE.ShaderMaterial; private readonly quad: THREE.Mesh
  private readonly layers: number
  /** What the last pass was computed for: the model time and the sun direction. */
  private time = NaN; private readonly sun = new THREE.Vector3()

  constructor(nx: number, ny: number, nz: number, shared: Record<string, THREE.IUniform>, density: THREE.Texture) {
    this.layers = nz
    // 8 bits per channel: every WebGL2 device can render to it (half floats need an extension on some phones).
    this.target = new THREE.WebGL3DRenderTarget(nx, ny, nz, { depthBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat })
    const t = this.target.texture
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.wrapR = THREE.ClampToEdgeWrapping; t.generateMipmaps = false
    this.material = new THREE.ShaderMaterial({ vertexShader: lightVolumeVertex, fragmentShader: lightVolumeFragment, depthTest: false, depthWrite: false, uniforms: { ...shared, uDensity: { value: density }, uLayer: { value: 0 } } })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material); this.quad.frustumCulled = false; this.scene.add(this.quad)
  }

  get texture() { return this.target.texture }

  /** Recomputes the light when the clouds (new model time) or the sun changed. */
  update(renderer: THREE.WebGLRenderer, time: number, sun: THREE.Vector3) {
    if (time === this.time && sun.distanceToSquared(this.sun) < 1e-5) return
    this.time = time; this.sun.copy(sun)
    const before = renderer.getRenderTarget()
    for (let k = 0; k < this.layers; k++) { this.material.uniforms.uLayer.value = k; renderer.setRenderTarget(this.target, k); renderer.render(this.scene, this.camera) }
    renderer.setRenderTarget(before)
  }

  dispose() { this.target.dispose(); this.material.dispose(); this.quad.geometry.dispose() }
}
