export const volumeVertex = /* glsl */`
varying vec3 vWorld;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const volumeCommon = /* glsl */`
precision highp sampler3D;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uGrid;
uniform vec3 uSunDir;
uniform float uHeight;
uniform float uExtinction;

// Grid node k sits at the box edge, texel centre is at (k+0.5)/N; vertical nodes span 0..H with NZ-1 intervals.
// Grid y (north) runs toward world -Z so that the right-handed scene is not mirrored.
vec3 toTex(vec3 p){
  vec3 s = uBoxMax - uBoxMin;
  return vec3(
    (p.x - uBoxMin.x) / s.x + 0.5 / uGrid.x,
    (uBoxMax.z - p.z) / s.z + 0.5 / uGrid.y,
    (p.y / uHeight * (uGrid.z - 1.0) + 0.5) / uGrid.z);
}
`

const cloudSampling = /* glsl */`
uniform sampler3D uDensity;
vec2 fields(vec3 p){ return texture(uDensity, toTex(p)).rg; }
`

// The light volume (light.ts): R encodes the optical depth to the sun (density units x km, before uExtinction), G the
// share of the sky seen. LIGHT_OD_SCALE keeps 8 bits enough from a thin edge to the depth of a whole storm.
const lightEncoding = /* glsl */`
const float LIGHT_OD_SCALE = 8.0;
`
const lightSampling = lightEncoding + /* glsl */`
uniform sampler3D uLight;
// x: optical depth to the sun (times uExtinction), y: sky visibility (0-1).
vec2 lightAt(vec3 p){
  vec2 l = texture(uLight, toTex(p)).rg;
  return vec2(-LIGHT_OD_SCALE * log(max(1.0 - l.x, 1e-4)) * uExtinction, l.y);
}
`

// The flash light volumes (light.ts FlashVolume): per flash slot (RGBA = 4 slots) the light a flash of brightness 1
// sends to a point, encoded 1 - exp(-E * FLASH_ENCODE).
const flashEncoding = /* glsl */`
const float FLASH_ENCODE = 4.0;
vec4 flashDecode(vec4 v){ return -log(max(1.0 - v, vec4(1e-4))) / FLASH_ENCODE; }
`

/**
 * One layer of a flash light volume: from up to 64 points of the channels of four flashes (uPts: x, y, z in km and the
 * slot 0-3 of the four; uW: each point's share of its flash), the light at the texel's node. Each point is a source
 * whose light falls off with distance (softened within ~0.5 km of the channel) as 1/r^2 through clear air, but in a
 * cloud that scatters without absorbing the light diffuses and lingers: for a point source the fluence is ~(1 + 3 (1 -
 * g) tau)/r^2 (diffusion; g = 0.85, so 0.45 tau; tau along the way, 8 steps), ~1/r inside the cloud. The gain is capped
 * at 3, a choice by eye that stands for the light escaping through the cloud's surfaces (which the infinite-medium
 * formula ignores): without it a flash would light a whole storm evenly, while photos show the glow strongest near the
 * channel.
 */
export const flashVolumeFragment = /* glsl */`
precision highp float;
${volumeCommon}
${cloudSampling}
${flashEncoding}
uniform float uLayer;
uniform vec4 uPts[64];
uniform float uW[64];
uniform int uCount;

void main(){
  vec3 s = uBoxMax - uBoxMin;
  vec3 p = vec3(uBoxMin.x + (gl_FragCoord.x - 0.5) / uGrid.x * s.x, uLayer / (uGrid.z - 1.0) * uHeight, uBoxMax.z - (gl_FragCoord.y - 0.5) / uGrid.y * s.z);
  vec4 E = vec4(0.0);
  for(int i = 0; i < 64; i++){
    if(i >= uCount) break;
    vec3 d = uPts[i].xyz - p;
    float r = length(d), od = 0.0;
    for(int j = 0; j < 8; j++){ vec2 f = fields(p + d * ((float(j) + 0.5) / 8.0)); od += f.r * 1.1 + f.g * 0.3; }
    E[int(uPts[i].w + 0.5)] += uW[i] * min(1.0 + 0.45 * od * r / 8.0 * uExtinction, 3.0) / (r * r + 0.25);
  }
  gl_FragColor = 1.0 - exp(-E * FLASH_ENCODE);
}`

export const lightVolumeVertex = /* glsl */`
void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`

/**
 * One layer of the light volume per pass: at the texel's node, the optical depth to the sun through the whole column
 * (to the top of the domain; the domain is periodic sideways, as the model) and the sky visibility, averaged over the
 * zenith and four directions 45 degrees up (cosine weighted).
 */
export const lightVolumeFragment = /* glsl */`
precision highp float;
${volumeCommon}
${cloudSampling}
${lightEncoding}
uniform float uLayer;

float depthAlong(vec3 p, vec3 dir, float far, int n){
  float ds = far / float(n), od = 0.0;
  for(int i = 0; i < 48; i++){
    if(i >= n) break;
    vec2 f = fields(p + dir * (ds * (float(i) + 0.5)));
    od += f.r * 1.1 + f.g * 0.3;
  }
  return od * ds;
}

void main(){
  vec3 s = uBoxMax - uBoxMin;
  vec3 p = vec3(uBoxMin.x + (gl_FragCoord.x - 0.5) / uGrid.x * s.x, uLayer / (uGrid.z - 1.0) * uHeight, uBoxMax.z - (gl_FragCoord.y - 0.5) / uGrid.y * s.z);
  float up = max(uHeight - p.y, 0.01);
  // The sun: to the top of the domain, at most 60 km of slant path (a low sun).
  float sunOd = uSunDir.y > 0.0 ? depthAlong(p, uSunDir, min(up / max(uSunDir.y, 0.01), 60.0), 48) : 0.0;
  // The sky.
  float sky = 0.0, total = 0.0;
  vec3 dirs[5] = vec3[5](vec3(0.0, 1.0, 0.0), vec3(0.7071, 0.7071, 0.0), vec3(-0.7071, 0.7071, 0.0), vec3(0.0, 0.7071, 0.7071), vec3(0.0, 0.7071, -0.7071));
  for(int i = 0; i < 5; i++){
    float w = dirs[i].y;
    sky += w * exp(-depthAlong(p, dirs[i], up / dirs[i].y, 12) * uExtinction * 0.5);
    total += w;
  }
  gl_FragColor = vec4(1.0 - exp(-sunOd / LIGHT_OD_SCALE), sky / total, 0.0, 1.0);
}`

const raymarchCommon = volumeCommon + /* glsl */`
uniform float uSliceOn;
uniform float uSliceH;
uniform float uSliceZ;
varying vec3 vWorld;

vec2 boxHit(vec3 ro, vec3 rd){
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// Slices are opaque and the volumes skip the depth test, so rays stop at the first slice they hit.
float clipToSlices(vec3 ro, vec3 rd, float t0, float t1){
  if(uSliceOn < 0.5) return t1;
  float th = (uSliceH - ro.y) / rd.y;
  if(th > t0 && th < t1) t1 = th;
  float tz = (uSliceZ - ro.z) / rd.z;
  if(tz > t0 && tz < t1) t1 = tz;
  return t1;
}

float pixelJitter(){
  return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}
`

// Injected into the ground's MeshStandardMaterial: the light volume at the ground gives the cloud shadow for the direct
// sunlight (x) and, under a storm, the sky hidden by the cloud for the sky light (y).
export const groundShadowPars = volumeCommon + lightSampling + /* glsl */`
varying vec3 vCloudWorld;

vec2 cloudShade(vec3 p){
  vec2 l = lightAt(vec3(p.x, 0.0, p.z));
  return vec2(exp(-l.x * 0.8), mix(0.22, 1.0, l.y));
}
`

export const volumeFragment = /* glsl */`
precision highp float;
${raymarchCommon}
${cloudSampling}
uniform vec3 uSunColor;
uniform vec3 uAmbientTop;
uniform vec3 uAmbientBottom;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uOpacity;

${lightSampling}
${flashEncoding}
// Light of the flashes shown (FlashVolume): the volumes of slots 0-3 and 4-7 and each slot's brightness now.
uniform sampler3D uFlashA;
uniform sampler3D uFlashB;
uniform vec4 uFlashIA;
uniform vec4 uFlashIB;
uniform float uFlashOn;
const vec3 FLASH_COLOR = vec3(0.86, 0.86, 1.0);
const float FLASH_GAIN = 12.0;

const int STEPS = 96;
const float PI = 3.14159265;

float hash(vec3 p){
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p){ return vnoise(p) * 0.55 + vnoise(p * 2.03) * 0.3 + vnoise(p * 4.11) * 0.15; }

// The model grid is ~1 km, so sub-grid noise erodes the edges to give cumuliform texture.
float cloudDensity(vec3 p, float base){
  if(base < 0.004) return 0.0;
  float n = fbm(p * 1.15 + vec3(0.0, -uTime * 0.0015, 0.0));
  return clamp(base * 1.35 - (1.0 - n) * 0.42 * (1.0 - base * 0.6), 0.0, 1.0);
}

float hg(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

// Two lobes, relative to isotropic (1): a strong forward one (the silver lining of an edge against the sun) and a weak
// backward one; k widens the lobes for the multiple-scattering octaves.
float phase(float c, float k){ return mix(hg(c, -0.15 * k), hg(c, 0.75 * k), 0.3) * 4.0 * PI; }

// Sunlight reaching a point at optical depth od from the sun, with multiple scattering approximated by octaves
// (Wrenninge 2013, Hillaire 2016): each octave weaker (0.5^i), less extinguished (0.5^i) and with a wider phase. The
// phases depend only on the ray's angle to the sun: phases holds them, weighted, for the three octaves.
float sunlight(float od, vec3 phases){ return phases.x * exp(-od) + phases.y * exp(-od * 0.5) + phases.z * exp(-od * 0.25); }

void main(){
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec2 t = boxHit(ro, rd);
  t.x = max(t.x, 0.0);
  t.y = clipToSlices(ro, rd, t.x, t.y);
  if(t.y <= t.x) discard;

  float dt = (t.y - t.x) / float(STEPS);
  float tt = t.x + dt * pixelJitter();

  float cosT = dot(rd, uSunDir);
  vec3 phases = vec3(phase(cosT, 1.0), 0.5 * phase(cosT, 0.5), 0.25 * phase(cosT, 0.25));

  float T = 1.0;
  vec3 col = vec3(0.0);
  float depthSum = 0.0, weightSum = 0.0;

  for(int i = 0; i < STEPS; i++){
    if(T < 0.02) break;
    vec3 p = ro + rd * tt;
    vec2 f = fields(p);
    float dc = cloudDensity(p, f.r);
    float dr = f.g * 0.35;
    float sigma = (dc + dr) * uExtinction;
    if(sigma > 1e-4){
      vec2 L = lightAt(p);
      float powder = 1.0 - exp(-dc * uExtinction * 1.5);
      float h = clamp(p.y / uHeight * 1.3, 0.0, 1.0);
      // Sky light where the sky is seen: dim deep inside and under the cloud, full at its edges.
      vec3 ambient = mix(uAmbientBottom, uAmbientTop, h) * mix(0.18, 1.0, L.y);
      vec3 cloudCol = uSunColor * sunlight(L.x, phases) * mix(0.6, 1.0, powder) * 0.55 + ambient * 0.9;
      vec3 rainCol = vec3(0.40, 0.44, 0.50) * (uSunColor * exp(-L.x) * 0.25 + ambient * 1.1);
      if(uFlashOn > 0.5){
        vec3 tp = toTex(p);
        vec3 flash = FLASH_COLOR * FLASH_GAIN * (dot(flashDecode(texture(uFlashA, tp)), uFlashIA) + dot(flashDecode(texture(uFlashB, tp)), uFlashIB));
        cloudCol += flash; rainCol += flash * 0.4;
      }
      vec3 S = mix(cloudCol, rainCol, dr / (dc + dr));
      float a = exp(-sigma * dt);
      float w = T * (1.0 - a);
      col += S * w;
      depthSum += tt * w;
      weightSum += w;
      T *= a;
    }
    tt += dt;
  }

  float alpha = (1.0 - T) * uOpacity;
  if(alpha < 0.003) discard;
  vec3 c = col / (1.0 - T);
  float dist = depthSum / max(weightSum, 1e-4);
  float fd = uFogDensity * dist;
  c = mix(c, uFogColor, 1.0 - exp(-fd * fd));
  gl_FragColor = vec4(c, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`

// aMelt: 0 = snowflake, 1 = raindrop, negative = inactive particle.
export const precipVertex = /* glsl */`
attribute float aMelt;
uniform float uScale;
varying float vMelt;
void main(){
  vMelt = aMelt;
  if(aMelt < 0.0){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(mix(0.7, 0.5, aMelt) * uScale / -mv.z, 3.0, 26.0);
}`

export const precipFragment = /* glsl */`
varying float vMelt;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  float arms = pow(abs(cos(3.0 * atan(c.y, c.x))), 8.0);
  float snow = clamp(smoothstep(1.0, 0.3, r) * arms + smoothstep(0.4, 0.1, r), 0.0, 1.0);
  float rain = smoothstep(1.0, 0.5, length(vec2(c.x * 3.5, c.y)));
  float alpha = mix(snow, rain, vMelt);
  if(alpha < 0.05) discard;
  gl_FragColor = vec4(mix(vec3(0.97, 0.98, 1.0), vec3(0.45, 0.64, 0.92), vMelt), alpha * 0.9);
  #include <colorspace_fragment>
}`

const fieldSampling = /* glsl */`
uniform sampler3D uField;
uniform sampler2D uColormap;
float fieldValue(vec3 p){ return texture(uField, toTex(p)).r; }
vec3 fieldColor(float s){ return texture(uColormap, vec2(s, 0.5)).rgb; }
`

// Emission-absorption volume of the selected field: only values far from neutral are opaque.
export const fieldVolumeFragment = /* glsl */`
precision highp float;
${raymarchCommon}
${fieldSampling}
uniform float uDiverging;
uniform float uThreshold;
uniform float uDensity;

const int STEPS = 72;

void main(){
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec2 t = boxHit(ro, rd);
  t.x = max(t.x, 0.0);
  t.y = clipToSlices(ro, rd, t.x, t.y);
  if(t.y <= t.x) discard;

  float dt = (t.y - t.x) / float(STEPS);
  float tt = t.x + dt * pixelJitter();
  float T = 1.0;
  vec3 col = vec3(0.0);

  for(int i = 0; i < STEPS; i++){
    if(T < 0.03) break;
    float s = fieldValue(ro + rd * tt);
    float strength = uDiverging > 0.5 ? abs(s * 2.0 - 1.0) : s;
    float sigma = smoothstep(uThreshold, 1.0, strength) * 0.9 * uDensity;
    if(sigma > 1e-4){
      float a = exp(-sigma * dt);
      col += T * (1.0 - a) * fieldColor(s);
      T *= a;
    }
    tt += dt;
  }

  float alpha = 1.0 - T;
  if(alpha < 0.003) discard;
  gl_FragColor = vec4(col / alpha, alpha);
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`

export const sliceFragment = /* glsl */`
precision highp float;
${volumeCommon}
${fieldSampling}
uniform float uDiverging;
varying vec3 vWorld;

void main(){
  float s = fieldValue(vWorld);
  vec3 col = fieldColor(s);
  float c = s * 10.0;
  float line = 1.0 - min(abs(fract(c - 0.5) - 0.5) / fwidth(c), 1.0);
  float zero = uDiverging > 0.5 ? 1.0 - min(abs(s - 0.5) * 10.0 / fwidth(c), 1.0) : 0.0;
  col = mix(col, col * 0.55, line * 0.55);
  col = mix(col, vec3(0.1, 0.12, 0.14), zero * 0.8);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`

/**
 * Lightning ribbons (lightning.ts): each piece of channel a quad between its ends aA and aB, widened sideways on the
 * screen (aSide) so its width is in pixels at any distance. aInfo: the flash's slot, the kind of piece (0 a branch, 1 the
 * main channel, 2 a new ground contact's path, 3 the old path below where that leaves), the growth order of the piece
 * (0-1, shown once the leader has grown that far), the width factor. uFlash per slot: brightness of the main channel and
 * of the branches, how far the leader has grown, CG (1) or IC (0); uPaths: brightness of the old and the new path, how
 * much the fading channel breaks into beads. aArc: the distance along the channel at the piece's ends, km. Each end of a
 * piece is dimmed by the cloud between it and the eye (16 steps through the cloud texture, the density as the clouds
 * draw it): deep inside a cloud the channel is not seen, only the cloud's glow; what comes out of it is sharp.
 */
export const lightningVertex = /* glsl */`
${volumeCommon}
${cloudSampling}
attribute vec3 aA;
attribute vec3 aB;
attribute float aSide;
attribute float aEnd;
attribute vec4 aInfo;
attribute vec2 aArc;
uniform vec4 uFlash[8];
uniform vec4 uPaths[8];
uniform vec2 uRes;
uniform float uPx;
varying float vAcross;
varying float vCore;
varying float vHalo;
varying float vI;
varying float vCg;
varying float vSeen;
varying float vArc;
varying float vBeads;
varying vec3 vTint;

// Optical depth of the cloud and precipitation between a point and the camera.
float cloudBetween(vec3 p){
  vec3 rd = cameraPosition - p;
  float far = length(rd);
  rd /= far;
  vec3 inv = 1.0 / rd, t0 = (uBoxMin - p) * inv, t1 = (uBoxMax - p) * inv, lo = min(t0, t1), hi = max(t0, t1);
  float a = max(max(max(lo.x, lo.y), lo.z), 0.0), b = min(min(min(hi.x, hi.y), hi.z), far);
  if(b <= a) return 0.0;
  float ds = (b - a) / 16.0, od = 0.0;
  for(int i = 0; i < 16; i++){
    vec2 c = fields(p + rd * (a + ds * (float(i) + 0.5)));
    od += clamp(c.r * 1.35 - 0.1, 0.0, 1.0) + c.g * 0.35;
  }
  return od * ds * uExtinction;
}

void main(){
  vec4 f = uFlash[int(aInfo.x + 0.5)];
  // By kind: a branch, the main channel, a new ground contact's path, the old path below where that leaves.
  vec4 g = uPaths[int(aInfo.x + 0.5)];
  float k = aInfo.y, I = aInfo.z <= f.z ? (k < 0.5 ? f.y : k < 1.5 ? f.x : k < 2.5 ? g.y : g.x) : 0.0;
  vec4 ca = projectionMatrix * viewMatrix * vec4(aA, 1.0), cb = projectionMatrix * viewMatrix * vec4(aB, 1.0);
  if(I < 0.002 || ca.w <= 0.0 || cb.w <= 0.0){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 hr = uRes * 0.5, sa = ca.xy / ca.w * hr, sb = cb.xy / cb.w * hr, d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0), nrm = vec2(-dir.y, dir.x);
  float b = min(I, 1.0);
  vCore = uPx * (0.5 + 0.9 * b) * aInfo.w;
  vHalo = uPx * (8.0 + 22.0 * b) * aInfo.w;
  vec4 c = aEnd < 0.5 ? ca : cb;
  // Past the ends by the core's width, so the pieces join without gaps.
  vec2 s = (aEnd < 0.5 ? sa - dir * vCore : sb + dir * vCore) + nrm * aSide * vHalo;
  gl_Position = vec4(s / hr * c.w, c.z, c.w);
  vAcross = aSide * vHalo;
  vI = I;
  vCg = f.w;
  vec3 at = aEnd < 0.5 ? aA : aB;
  vSeen = exp(-cloudBetween(at));
  vArc = aEnd < 0.5 ? aArc.x : aArc.y;
  vBeads = g.z;
  // The haze between: it takes blue more than red, so a far flash looks warmer and dimmer (~orange at 40-50 km).
  vTint = exp(-length(cameraPosition - at) * vec3(0.010, 0.017, 0.028));
}`

/**
 * A white core (HDR: it saturates to white) and a softer glow around it, added to what is behind: a CG's blue-white
 * (the N II and H-alpha lines together look white with blue, as on photos), an IC's neutral white (seen through cloud,
 * whose Mie scattering is grey).
 */
export const lightningFragment = /* glsl */`
precision highp float;
varying float vAcross;
varying float vCore;
varying float vHalo;
varying float vI;
varying float vCg;
varying float vSeen;
varying float vArc;
varying float vBeads;
varying vec3 vTint;

void main(){
  float d = abs(vAcross), k = d / vCore;
  // Beads of ~30 m: some pieces fade slower than the rest of the channel, so on the dimming channel they stand out (up
  // to 3 times brighter than it), the gaps between them go dark.
  float h = fract(sin(floor(vArc / 0.03) * 12.9898) * 43758.5453), bead = mix(1.0, h > 0.45 ? (0.6 + 0.6 * h) * (1.0 + 1.5 * vBeads) : 0.06, vBeads);
  float core = exp(-k * k);
  float glow = exp(-4.0 * d / vHalo) * (1.0 - smoothstep(0.7 * vHalo, vHalo, d));
  vec3 halo = mix(vec3(0.86, 0.86, 0.9), vec3(0.72, 0.78, 1.0), vCg);
  // Through a thin veil of cloud the core is dimmed more than the glow, which the veil itself scatters.
  float I = vI * bead;
  gl_FragColor = vec4((vec3(1.0) * core * I * 1.4 * vSeen + halo * glow * I * 0.38 * pow(vSeen, 0.6)) * vTint, 1.0);
}`
