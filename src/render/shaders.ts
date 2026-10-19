import { HAZE_ALBEDO, HAZE_SCALE, RAYLEIGH, RAYLEIGH_SCALE, SKY_COLS, SKY_ROWS, SUN_LEVELS, SUN_RADIUS, SUN_TOP } from './sky'

const f = (x: number) => x.toFixed(6)

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
// The precipitation shafts' extinction at G = 1 of the volume texture, 1/km (view.ts): heavy rain, ~1 km visibility.
const float SHAFT_MAX = 6.0;

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
// All four: cloud, precipitation, the tower's updraught (0-1 of 20 m/s), ice share of the cloud.
vec4 fieldsAll(vec3 p){ return texture(uDensity, toTex(p)); }
`

// The light volume (light.ts): R encodes the optical depth to the sun (density units x km, before uExtinction), G the
// share of the sky seen. LIGHT_OD_SCALE keeps 8 bits enough from a thin edge to the depth of a whole storm.
const lightEncoding = /* glsl */`
const float LIGHT_OD_SCALE = 8.0;
`
const lightSampling = lightEncoding + /* glsl */`
uniform sampler3D uLight;
// Sunlight through a cloud of optical depth od, direct and diffuse (two-stream, non-absorbing, g = 0.85): the direct
// beam dies as exp(-od), but the cloud passes on much of it scattered, 1 / (1 + 0.75 (1 - g) tau) — the light under a
// thin anvil is still bright, under a storm's core dim. The drawn cloud's optical depth is ~15 times below the true one
// (a cumulonimbus has 50-100 per km; drawn so, its edges would be hard walls), so tau = 15 od.
float sunThrough(float od){ return max(exp(-od), 1.0 / (1.0 + 1.7 * od)); }
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
    for(int j = 0; j < 8; j++){ vec2 f = fields(p + d * ((float(j) + 0.5) / 8.0)); od += f.r * 1.1 + f.g * SHAFT_MAX / uExtinction; }
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
    od += f.r * 1.1 + f.g * SHAFT_MAX / uExtinction;
  }
  return od * ds;
}

// How far a ray from p goes before it leaves the domain sideways, km. The model is periodic, but the light is not: past
// the side the textures wrap round, and a low sun's ray would meet the same storm again, a shadow on its sunny side.
float toSide(vec3 p, vec3 dir){
  float tx = dir.x > 1e-4 ? (uBoxMax.x - p.x) / dir.x : dir.x < -1e-4 ? (uBoxMin.x - p.x) / dir.x : 1e4;
  float tz = dir.z > 1e-4 ? (uBoxMax.z - p.z) / dir.z : dir.z < -1e-4 ? (uBoxMin.z - p.z) / dir.z : 1e4;
  return max(min(tx, tz), 0.0);
}

void main(){
  vec3 s = uBoxMax - uBoxMin;
  vec3 p = vec3(uBoxMin.x + (gl_FragCoord.x - 0.5) / uGrid.x * s.x, uLayer / (uGrid.z - 1.0) * uHeight, uBoxMax.z - (gl_FragCoord.y - 0.5) / uGrid.y * s.z);
  float up = max(uHeight - p.y, 0.01);
  // The sun: to the top of the domain, at most 60 km of slant path (a low sun); a sun set for the ground still lights
  // what is high (sky.ts), its ray running down through the box to the ground.
  float sunOd = uSunDir.y > -0.1 ? depthAlong(p, uSunDir, min(min(uSunDir.y > 0.0 ? up / max(uSunDir.y, 0.01) : p.y / max(-uSunDir.y, 1e-3), 60.0), toSide(p, uSunDir)), 48) : 0.0;
  // The sky.
  float sky = 0.0, total = 0.0;
  vec3 dirs[5] = vec3[5](vec3(0.0, 1.0, 0.0), vec3(0.7071, 0.7071, 0.0), vec3(-0.7071, 0.7071, 0.0), vec3(0.0, 0.7071, 0.7071), vec3(0.0, 0.7071, -0.7071));
  for(int i = 0; i < 5; i++){
    float w = dirs[i].y;
    sky += w * exp(-depthAlong(p, dirs[i], min(up / dirs[i].y, toSide(p, dirs[i])), 12) * uExtinction * 0.5);
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

// The sky (sky.ts): its table of radiance over the elevation (square spacing) and the azimuth from the sun, drawn
// uSkyGain times brighter, with a night floor (the airglow, the stars' light) and a city's glow low over the horizon.
// The aerial perspective: the air's and the haze's optical depth along a ray in exponential layers (flat ground, as
// the ~100 km seen), with the sky's own light scattered into it.
const atmosphere = /* glsl */`
uniform sampler2D uSky;
uniform float uSkyGain;
uniform vec3 uSkyFloor;
uniform vec3 uCityGlow;
uniform float uHaze;
const float SKY_PI = 3.14159265;
const vec3 RAYLEIGH = vec3(${RAYLEIGH.map(f).join(', ')});
const float RAYLEIGH_SCALE = ${f(RAYLEIGH_SCALE)}, HAZE_SCALE = ${f(HAZE_SCALE)}, HAZE_ALBEDO = ${f(HAZE_ALBEDO)};

vec3 skyAt(vec3 d){
  float el = asin(clamp(d.y, 0.0, 1.0)), v = sqrt(el / (0.5 * SKY_PI));
  vec2 sh = uSunDir.xz, dh = d.xz;
  float az = length(sh) < 1e-4 || length(dh) < 1e-4 ? 0.0 : acos(clamp(dot(normalize(dh), normalize(sh)), -1.0, 1.0));
  vec2 uv = vec2((az / SKY_PI * ${f(SKY_COLS - 1)} + 0.5) / ${f(SKY_COLS)}, (v * ${f(SKY_ROWS - 1)} + 0.5) / ${f(SKY_ROWS)});
  return texture(uSky, uv).rgb * uSkyGain + uSkyFloor + uCityGlow * exp(-el * 10.0);
}

// The column of an exponential layer (scale H, km) between heights y0 and y1 along len km.
float layerColumn(float y0, float y1, float len, float H){
  y0 = max(y0, 0.0); y1 = max(y1, 0.0);
  float dy = y1 - y0;
  if(abs(dy) < 1e-3 * H) return len * exp(-y0 / H);
  return H * len / dy * (exp(-y0 / H) - exp(-y1 / H));
}
// The view from outside thins the air between the camera and what it sees by uAirScale (0.5): the camera stands far off
// to see the whole domain (40-60 km), and through the true air a storm that far fades out; the sky itself, and the view
// from the ground (uAirScale 1), keep the true air.
uniform float uAirScale;
#define AIR_SCALE uAirScale
vec3 airDepth(float y0, float y1, float len){
  return AIR_SCALE * (RAYLEIGH * layerColumn(y0, y1, len, RAYLEIGH_SCALE) + uHaze / HAZE_ALBEDO * layerColumn(y0, y1, len, HAZE_SCALE));
}
// The air between the camera (ro) and a point len km along rd: its transmittance T, and the light it scatters toward
// the camera — the sky's in that direction times the share of the whole path's (to the top of the air) that lies
// before the point.
vec3 aerial(vec3 ro, vec3 rd, float len, out vec3 T){
  T = exp(-airDepth(ro.y, ro.y + rd.y * len, len));
  float y0 = max(ro.y, 0.0);
  vec3 whole = rd.y > 0.01 ? AIR_SCALE * (RAYLEIGH * RAYLEIGH_SCALE * exp(-y0 / RAYLEIGH_SCALE) + uHaze / HAZE_ALBEDO * HAZE_SCALE * exp(-y0 / HAZE_SCALE)) / rd.y : vec3(1e4);
  return skyAt(vec3(rd.x, max(rd.y, 0.0), rd.z)) * (1.0 - T) / max(1.0 - exp(-whole), 1e-4);
}
`

// The share of the light the air scatters toward the camera between ro and p that it still gives where the cloud
// shades it from the sun (the dark air under a storm, which leaves its base dark seen from afar): the light volume
// sampled along the part of the path inside the domain, weighted by the air's density, its share of the path's air;
// AIR_SKY of the air's light is the sky's own (multiple scattering), which the storm hides less.
const airShade = /* glsl */`
const float AIR_SKY = 0.3;
#ifndef AIR_SAMPLES
#define AIR_SAMPLES 6
#endif
float airLit(vec3 ro, vec3 p){
  vec3 rd = p - ro;
  float len = length(rd);
  rd /= len;
  vec3 inv = 1.0 / rd, t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv, lo = min(t0, t1), hi = max(t0, t1);
  float a = max(max(max(lo.x, lo.y), lo.z), 0.0), b = min(min(min(hi.x, hi.y), hi.z), len);
  if(b <= a) return 1.0;
  float lit = 0.0, wsum = 0.0;
  for(int k = 0; k < AIR_SAMPLES; k++){
    vec3 q = ro + rd * mix(a, b, (float(k) + 0.5) / float(AIR_SAMPLES));
    float w = RAYLEIGH.g * exp(-max(q.y, 0.0) / RAYLEIGH_SCALE) + uHaze / HAZE_ALBEDO * exp(-max(q.y, 0.0) / HAZE_SCALE);
    lit += w * sunThrough(lightAt(q).x);
    wsum += w;
  }
  float inBox = airDepth(ro.y + rd.y * a, ro.y + rd.y * b, b - a).g / max(airDepth(ro.y, p.y, len).g, 1e-6);
  return mix(1.0, mix(AIR_SKY, 1.0, lit / wsum), clamp(inBox, 0.0, 1.0));
}
`

// The ground's surface (view.ts): its state per ground column (uGround, sliding with the ground by uGroundOffset: R the
// water on it, 0-1 of GROUND_WATER mm; G the hail lying on it, the share of the ground it covers), the wind over it
// (uWind, per column of the domain, 0-1 of WIND_SCALE m/s), the kind of surface, and a pattern fixed to the ground:
// fields, steppe, a city's blocks, water. The pattern keeps the mean albedo (the sky is computed for it).
export const groundSurfacePars = /* glsl */`
uniform sampler2D uGround;
uniform sampler2D uWind;
uniform vec2 uGroundOffset;
uniform vec2 uGroundSize;
uniform float uSurface;
uniform sampler3D uNoise;
const float GROUND_WATER = 16.0, WIND_SCALE = 40.0;
float gWater, gHail, gSpec;

float hash2(vec2 k){ return fract(sin(dot(k, vec2(127.1, 311.7))) * 43758.5453); }
// The ground's coordinates, km (fixed to the ground as the domain moves), and its state there.
vec2 groundAt(vec3 p){ vec3 s = uBoxMax - uBoxMin; return vec2((p.x - uBoxMin.x) / s.x, (uBoxMax.z - p.z) / s.z) + 0.5 / uGrid.xy + uGroundOffset; }

// Brightness of the land's pattern relative to its mean (1), at q km; blur is a pixel's footprint, km (the fine detail
// fades as it shrinks below a pixel).
vec3 landPattern(vec2 q, float blur){
  vec3 n = texture(uNoise, vec3(q * 0.09, 0.31)).rgb;
  float mottle = 0.85 + 0.3 * n.g + 0.1 * (n.b - 0.5);
  if(uSurface > 2.5){
    // A city: blocks ~0.12 km between streets, some of them parks.
    vec2 b = q / 0.12, cell = floor(b), f = fract(b);
    float street = 1.0 - smoothstep(0.0, 0.08 + blur / 0.12, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    float r = hash2(cell);
    vec3 block = r < 0.12 ? vec3(0.75, 1.15, 0.7) : vec3(0.8 + 0.45 * r);
    return mix(mix(block, vec3(0.75), street * clamp(0.02 / blur, 0.0, 1.0)), vec3(1.0), smoothstep(0.03, 0.2, blur)) * mottle;
  }
  // Fields: a grid turned by ~20°, fields 0.8 x 0.5 km, each sown with its own crop.
  vec2 g = mat2(0.94, 0.34, -0.34, 0.94) * q / vec2(0.8, 0.5), cell = floor(g), f = fract(g);
  float r = hash2(cell), dry = uSurface > 0.5 ? 1.0 : 0.0;
  vec3 crop = r < 0.3 ? vec3(0.8, 0.92, 0.75) : r < 0.55 ? vec3(1.05, 1.12, 0.9) : r < 0.72 ? vec3(1.4, 1.25, 0.75) : r < 0.86 ? vec3(1.12, 0.86, 0.78) : vec3(0.95, 1.0, 0.95);
  crop = mix(vec3(1.0), crop, 0.7);
  crop = mix(crop, vec3(0.9 + 0.25 * r), dry * 0.7);
  // The field's edges (hedges, tracks), ~15 m: only while a pixel is not much wider than them.
  float edge = 1.0 - smoothstep(0.0, 0.03, min(min(f.x, 1.0 - f.x) * 0.8, min(f.y, 1.0 - f.y) * 0.5));
  crop = mix(crop, vec3(0.7, 0.8, 0.65), edge * clamp(0.015 / blur, 0.0, 1.0));
  return mix(crop, vec3(1.0), smoothstep(0.2, 1.0, blur)) * mottle;
}
`

// The sky's dome: a unit sphere about the camera drawn behind everything. Above the horizon the sky's table, the sun's
// disc (limb-darkened) and the stars; below it the ground beyond the domain, seen through the air from the camera's
// height. uLab dims it toward the lab's dark blue while a field is shown (its colours read against a dark ground).
export const skyVertex = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}`

export const skyFragment = /* glsl */`
precision highp float;
${volumeCommon}
${atmosphere}
${groundSurfacePars}
uniform vec3 uSunDisc;
uniform vec3 uGroundLight;
uniform float uStars;
uniform float uLab;
uniform float uWater;
varying vec3 vDir;
const float SUN_RADIUS = ${f(SUN_RADIUS)};

float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
// Stars: one in a few hundred cells of a lattice over the directions, of random brightness, dimmed through the air.
vec3 stars(vec3 d){
  vec3 q = d * 300.0, cell = floor(q);
  float r = hash3(cell);
  if(r < 0.996) return vec3(0.0);
  vec3 at = cell + 0.5 + 0.3 * (vec3(hash3(cell + 1.7), hash3(cell + 3.1), hash3(cell + 5.3)) - 0.5);
  float b = pow(hash3(cell + 9.2), 6.0) * 2.5 + 0.08;
  vec3 tint = mix(vec3(1.0, 0.82, 0.65), vec3(0.75, 0.85, 1.0), hash3(cell + 7.7));
  return tint * b * (1.0 - smoothstep(0.08, 0.22, length(q - at)));
}

void main(){
  vec3 d = normalize(vDir), ro = vec3(0.0, cameraPosition.y, 0.0), c;
  if(d.y >= 0.0){
    c = skyAt(d);
    float a = acos(clamp(dot(d, uSunDir), -1.0, 1.0)) / SUN_RADIUS;
    if(a < 1.0) c += uSunDisc * (1.0 - 0.6 * (1.0 - sqrt(1.0 - a * a)));
    if(uStars > 0.0){
      vec3 up = (RAYLEIGH * RAYLEIGH_SCALE + uHaze / HAZE_ALBEDO * HAZE_SCALE) / max(d.y, 0.02);
      c += stars(d) * uStars * exp(-up);
    }
  } else {
    float len = max(ro.y, 0.01) / -d.y;
    vec3 T, inscatter = aerial(ro, d, len, T), surface = uGroundLight;
    // The land's pattern, as on the domain's ground (the same ground going on).
    if(uWater < 0.5){ vec3 P = vec3(cameraPosition.x, 0.0, cameraPosition.z) + d * len; vec2 q = groundAt(P) * uGroundSize; surface *= landPattern(q, min(length(dFdx(q)), length(dFdy(q)))); }
    // The sea beyond the domain reflects the sky (Fresnel, n = 1.33).
    if(uWater > 0.5){ float F = 0.02 + 0.98 * pow(max(1.0 + d.y, 0.0), 5.0); surface = surface * (1.0 - F) + skyAt(vec3(d.x, -d.y, d.z)) * F; }
    c = surface * T + inscatter;
  }
  c = mix(c, vec3(0.009, 0.026, 0.044), uLab);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

// Injected into the ground's MeshStandardMaterial: the light volume at the ground gives the cloud shadow for the direct
// sunlight (x) and, under a storm, the sky hidden by the cloud for the sky light (y).
export const groundShadowPars = volumeCommon + lightSampling + atmosphere + airShade + /* glsl */`
varying vec3 vCloudWorld;

// x: the direct sun, y: the sky light, z: the sunlight the cloud passes on scattered (from its base: as diffuse light).
vec3 cloudShade(vec3 p){
  vec2 l = lightAt(vec3(p.x, 0.0, p.z));
  float od = l.x * 0.8;
  vec3 s = vec3(exp(-od), mix(0.22, 1.0, l.y), sunThrough(od) - exp(-od));
  // Fading out over the last 3 km to the domain's sides: the ground beyond is drawn unshaded (no cloud there), and the
  // shadow of a storm near the side ended in a straight edge along it.
  vec2 side = min(p.xz - uBoxMin.xz, uBoxMax.xz - p.xz);
  return mix(vec3(1.0, 1.0, 0.0), s, smoothstep(0.0, 3.0, min(side.x, side.y)));
}
`

export const volumeFragment = /* glsl */`
precision highp float;
${raymarchCommon}
${cloudSampling}
// Sunlight at heights 0..SUN_TOP km (sky.ts): the air reddens it at sunset and the Earth's shadow rises through it after.
uniform vec3 uSunByHeight[${SUN_LEVELS}];
uniform vec3 uAmbientTop;
// The light from below: the ground's under the sky (and the night's floors), and under the sun — only where the
// ground is sunlit: the point's own sunlight stands in for the ground's under it (in a storm's shadow both are dark).
uniform vec3 uAmbientBottom;
uniform vec3 uBounceSun;
${atmosphere}
uniform float uTime;
uniform float uOpacity;
// The melting level, km (the rainbow only in the drops under it, not in the snow over it).
uniform float uFreezing;

${lightSampling}
${airShade}
${flashEncoding}
// Light of the flashes shown (FlashVolume): the volumes of slots 0-3 and 4-7 and each slot's brightness now.
uniform sampler3D uFlashA;
uniform sampler3D uFlashB;
uniform vec4 uFlashIA;
uniform vec4 uFlashIB;
uniform float uFlashOn;
const vec3 FLASH_COLOR = vec3(0.86, 0.86, 1.0);
const float FLASH_GAIN = 12.0;

// The march: coarse steps (STEPS over the ray through the box) through clear air; on reaching the cloud it steps back
// and goes on in steps of at most FINE_STEP km, back to coarse once out of it, at most MAX_STEPS in all. With the coarse
// steps alone (0.5-0.8 km) the sub-grid billows were smeared out.
// They and the shadow probes (SHADOW_PROBES 0-2) are set by the quality (view.ts QUALITY); these are the high level's.
#ifndef STEPS
#define STEPS 96
#define MAX_STEPS 224
#define FINE_STEP 0.18
#define SHADOW_PROBES 2
#endif
// Length of the first sub-grid shadow probe toward the sun, km (the second goes three times as far).
const float SHADOW_PROBE = 0.15;
const float PI = 3.14159265;

// Three octaves of tileable value noise (noise.ts): at x the octaves of lattice spacing 1, 1/2 and 1/4 in R, G, B, in
// one fetch (the lattice of R is 8 texels).
uniform sampler3D uNoise;
// The lookup turned off the axes (a rotation about a skew axis): the baked cube repeats every 8 units along its own
// axes, and seen from above a whole anvil showed the repeats as wallpaper; turned, a horizontal slice of it meets
// no short period. The stretch of the anisotropic noises (wisps, bands) is applied before, in the world's axes, so it
// keeps its direction.
const mat3 NOISE_TURN = mat3(0.5731, 0.7403, -0.3513, -0.6090, 0.6716, 0.4219, 0.5483, -0.0279, 0.8358);
vec3 octaves(vec3 x){ return texture(uNoise, NOISE_TURN * x * 0.125).rgb; }
float fbm(vec3 x){ return dot(octaves(x), vec3(0.55, 0.3, 0.15)); }

// Billow noise (|2n - 1| summed over octaves): rounded lobes meeting in creases, the cauliflower of a growing tower.
float billow(vec3 x){
  vec3 o = octaves(x);
  return abs(o.r * 2.0 - 1.0) * 0.6 + abs(o.g * 2.0 - 1.0) * 0.28 + o.b * 0.12;
}

// The billows rise with the updraught (w, km/s): the noise is carried up and two copies half a period apart cross-fade,
// so it never stretches (a flow map). The towers' tops in the model rise at about half the updraught.
const float BILLOW_PERIOD = 240.0;
float risingBillow(vec3 p, float w){
  float a = fract(uTime / BILLOW_PERIOD), b = fract(uTime / BILLOW_PERIOD + 0.5), rise = 0.5 * w * BILLOW_PERIOD;
  vec3 q = p * 0.9;
  return mix(billow(q - vec3(0.0, rise * a * 0.9, 0.0)), billow(q - vec3(0.0, rise * b * 0.9, 0.0) + vec3(5.2, 1.3, 7.9)), abs(2.0 * a - 1.0));
}

// The model grid is ~1 km, so sub-grid noise erodes the edges; its kind follows the cloud. f: fieldsAll. Over a strong
// updraught, rising cauliflower billows with a sharp edge (liquid cumulus towers); in the ice, fibrous wisps stretched
// along the horizontal with a soft edge (the anvil, cirrus); elsewhere the soft cumulus texture.
// The columns (view.ts): R the rotation, the strongest |vertical vorticity| at 1-6 km (0-1 of 0.02 1/s); G the base
// of an anvil over the column (0-1 of ANVIL_BASE_SCALE km) times B, the presence of that anvil (0-1); A the cloud base
// (0-1 of BASE_SCALE km).
uniform sampler2D uColumns;
const float ANVIL_BASE_SCALE = 20.0, BASE_SCALE = 10.0;

// Mammatus: rounded pouches hanging up to MAMMA_DEPTH km under the base of an anvil (higher than 5 km, of ice, away
// from a tower: view.ts finds it for each column). The pouches are lobes of the noise's large octave (~1.2 km across)
// that hang the deeper the stronger the lobe, so their bottoms are round.
const float MAMMA_DEPTH = 0.6, MAMMA_CELL = 1.6;
float mammaDensity(vec3 p){
  vec3 c = texture(uColumns, toTex(p).xy).rgb;
  if(c.b < 0.02) return 0.0;
  // The base, km: stored times its presence (B), so that the linear filter between columns with and without an anvil
  // averages the bases instead of pulling them to the ground.
  float h = c.g / c.b * ANVIL_BASE_SCALE - p.y;
  if(h < 0.0 || h > MAMMA_DEPTH) return 0.0;
  // Cellular noise: each cell of MAMMA_CELL km holds one pouch about a random point; the distance to the nearest point
  // makes round pouches with narrow gaps between them (value noise made a wavy sheet).
  // Where the anvil only partly qualifies (c.b < 1) a cell has its pouch or none, by a random number of the cell: shrunk
  // pouches came out as strings of beads along the anvil's edges.
  vec2 q = p.xz / MAMMA_CELL, cell = floor(q);
  float reach = 0.0;
  for(int j = -1; j <= 1; j++) for(int i = -1; i <= 1; i++){
    vec2 k = cell + vec2(float(i), float(j));
    vec3 r = fract(sin(vec3(dot(k, vec2(127.1, 311.7)), dot(k, vec2(269.5, 183.3)), dot(k, vec2(419.2, 371.9)))) * 43758.5);
    float here = smoothstep(r.z * 0.8 + 0.1, r.z * 0.8 + 0.2, c.b);
    reach = max(reach, (1.0 - smoothstep(0.1, 0.7, length(q - k - 0.5 - 0.35 * (r.xy - 0.5)))) * here);
  }
  reach *= MAMMA_DEPTH;
  // A soft edge wider than the march's fine step (a sharper one came out as a sawtooth), less dense than the anvil.
  return smoothstep(0.0, 0.4, reach - h + 0.15) * 0.6;
}

// The striations: on the rotating updraught's side from its base to the middle levels, fading out by ~7.5 km (the top
// of the tower and the overshooting dome billow).
float rotationAt(vec3 p){ return smoothstep(0.3, 0.65, texture(uColumns, toTex(p).xy).r) * (1.0 - smoothstep(6.0, 7.5, p.y)); }

float cloudDensity(vec3 p, vec4 f){
  float base = f.r;
  if(base < 0.004) return 0.0;
  // The base is flat, at the condensation level: no cloud under it, and the noise does not erode it (it erodes the sides
  // and the top), fading in over the 0.5 km above it.
  float above = p.y - texture(uColumns, toTex(p).xy).a * BASE_SCALE;
  if(above < -0.2) return 0.0;
  float rise = smoothstep(0.0, 0.5, above), under = smoothstep(-0.2, 0.15, above);
  float vigor = smoothstep(0.05, 0.4, f.b), ice = smoothstep(0.5, 0.95, f.a);
  ice *= 1.0 - vigor;
  float n = vigor + ice < 1.0 ? fbm(p * 1.15 + vec3(0.0, -uTime * 0.0015, 0.0)) : 0.0;
  if(vigor > 0.0){
    // A rotating updraught (a mesocyclone, 0.01 1/s and more) is smooth, its sides banded like a stack of plates
    // (the striations of a supercell), not billowing: the turbulent eddies are spun out into horizontal bands.
    float spin = rotationAt(p), tower = spin < 1.0 ? min(1.0, risingBillow(p, f.b * 0.02) * 1.5) : 0.0;
    if(spin > 0.0) tower = mix(tower, 0.35 + 0.65 * fbm(p * vec3(0.35, 3.2, 0.35)), spin);
    n = mix(n, tower, vigor);
  }
  if(ice > 0.0) n = mix(n, fbm(p * vec3(0.55, 2.8, 0.55) + vec3(uTime * 0.0004, 0.0, 0.0)), ice);
  float d = base * 1.35 - (1.0 - n) * mix(mix(0.42, 0.62, vigor), 0.3, ice) * (1.0 - base * 0.6) * mix(0.2, 1.0, rise);
  // Sharp-edged towers, translucent ice.
  return clamp(d * (1.0 + 4.0 * vigor) * mix(1.0, 0.75, ice), 0.0, 1.0) * under;
}

float hg(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

// Rain (relative to isotropic, per channel): drops of a millimetre or so send most light forward (diffraction and
// refraction, g ~ 0.85), little back — except into the rainbow, ~42° from the point opposite the sun (scattering angle
// ~138°: red outside at 42.3°, blue inside at 40.7°), and the fainter secondary bow at ~51° with its colours reversed;
// between the bows Alexander's dark band. Widths ~0.6° (the sun's disc and the spread of drop sizes).
const vec3 BOW1 = vec3(42.3, 41.5, 40.7), BOW2 = vec3(50.4, 51.6, 53.3);
vec3 rainPhase(float c){
  float a = degrees(acos(clamp(-c, -1.0, 1.0)));
  // Squares by multiplication: pow() of a negative base is undefined in GLSL (phone GPUs return NaN, per channel —
  // the coloured garbage over an anvil the testers saw 15.10.2026; desktop GPUs square it).
  vec3 d1 = (a - BOW1) / 0.6, d2 = (a - BOW2) / 0.8;
  vec3 bow = 0.9 * exp(-0.5 * d1 * d1) + 0.35 * exp(-0.5 * d2 * d2);
  float back = (hg(c, 0.85) * 0.85 + hg(c, -0.2) * 0.15) * 4.0 * PI;
  float dark = 1.0 - 0.5 * smoothstep(41.0, 43.0, a) * (1.0 - smoothstep(49.0, 51.0, a));
  return back * dark + bow;
}

// Two lobes, relative to isotropic (1): a strong forward one (the silver lining of an edge against the sun) and a weak
// backward one; k widens the lobes for the multiple-scattering octaves.
float phase(float c, float k){ return mix(hg(c, -0.15 * k), hg(c, 0.75 * k), 0.3) * 4.0 * PI; }

// Sunlight reaching a point at optical depth od from the sun, with multiple scattering approximated by octaves
// (Wrenninge 2013, Hillaire 2016): each octave weaker (0.5^i), less extinguished (0.5^i) and with a wider phase. The
// phases depend only on the ray's angle to the sun: phases holds them, weighted, for the three octaves.
float sunlight(float od, vec3 phases){ return phases.x * exp(-od) + phases.y * exp(-od * 0.5) + phases.z * exp(-od * 0.25); }

vec3 sunAt(float y){
  float l = clamp(y / ${f(SUN_TOP)}, 0.0, 1.0) * ${f(SUN_LEVELS - 1)};
  int i = int(min(floor(l), ${f(SUN_LEVELS - 2)}));
  return mix(uSunByHeight[i], uSunByHeight[i + 1], l - float(i));
}

void main(){
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec2 t = boxHit(ro, rd);
  t.x = max(t.x, 0.0);
  t.y = clipToSlices(ro, rd, t.x, t.y);
  if(t.y <= t.x) discard;

  float coarse = (t.y - t.x) / float(STEPS), fine = min(coarse, FINE_STEP);
  float dt = coarse;
  float tt = t.x + coarse * pixelJitter();
  bool inside = false;
  int clearRun = 0;

  float cosT = dot(rd, uSunDir);
  vec3 phases = vec3(phase(cosT, 1.0), 0.5 * phase(cosT, 0.5), 0.25 * phase(cosT, 0.25)), rainPh = rainPhase(cosT);

  float T = 1.0;
  vec3 col = vec3(0.0);
  float depthSum = 0.0, weightSum = 0.0;

  for(int i = 0; i < MAX_STEPS; i++){
    if(T < 0.02 || tt > t.y) break;
    vec3 p = ro + rd * tt;
    vec4 f = fieldsAll(p);
    float mamma = p.y > 5.0 && f.r < 0.004 ? mammaDensity(p) : 0.0;
    // Fine steps for the cloud's billows; the shafts' curtains (~0.7 km) need none.
    bool cloudy = f.r >= 0.004 || mamma > 0.0;
    if(!inside){
      if(cloudy && coarse > fine){ inside = true; clearRun = 0; tt = max(t.x, tt - coarse); dt = fine; tt += dt; continue; }
    } else if(!cloudy){
      if(float(++clearRun) * fine > coarse + fine){ inside = false; dt = coarse; }
    } else clearRun = 0;
    // The cloud fades out over the last ~1 km to the domain's sides: the outermost grid columns hold a thin sheet of
    // cloud along the side, and seen edge-on it stood out as a bright sliver.
    vec2 side = min(p.xz - uBoxMin.xz, uBoxMax.xz - p.xz);
    float toWall = min(side.x, side.y);
    float dc = max(cloudDensity(p, f), mamma) * smoothstep(0.25, 1.25, toWall);
    // The shafts: their extinction (1/km) in curtains — streaks stretched down the fall, ~0.4 km across, drifting down
    // with the rain, with gaps between them (smooth, the shafts came out as glowing puffs hanging under the cloud); the
    // curtains' edges ragged, where the precipitation thins out.
    float dr = 0.0;
    if(f.g > 0.0){
      vec3 n = octaves(vec3(p.x * 2.4, p.y * 0.08 + uTime * 0.0009, p.z * 2.4) + vec3(5.3, 0.0, 2.9));
      float streak = smoothstep(0.3, 0.75, n.g * 0.7 + n.b * 0.3);
      dr = f.g * SHAFT_MAX * mix(0.15, 2.0, streak) * smoothstep(0.0, 0.5, f.g * 12.0 + n.r - 0.5);
      // Fading out over the last 3 km to the domain's sides: the precipitation under an anvil that reaches the side
      // was cut there into a wall. Squared and none in the last 0.5 km: a ray along the side gathers the faint band over
      // the whole box, and a shaft cut by the side, seen edge-on, stayed a bright sliver.
      float edge = smoothstep(0.5, 4.0, toWall);
      dr *= edge * edge;
    }
    float sigma = dc * uExtinction + dr;
    if(sigma > 1e-4){
      vec2 L = lightAt(p);
      // The light volume is on the model grid (~1 km): the sub-grid billows would not shade one another. Two short
      // probes toward the sun through the detailed density add the optical depth of the lobes in the way, so the
      // sunlit side of a billow is bright and its creases dark.
      vec3 sunColor = sunAt(p.y);
#if SHADOW_PROBES == 2
      if(dc > 0.02 && uSunDir.y > -0.1){
        vec3 s1 = p + uSunDir * SHADOW_PROBE, s2 = p + uSunDir * (SHADOW_PROBE * 3.0);
        L.x += (cloudDensity(s1, fieldsAll(s1)) + cloudDensity(s2, fieldsAll(s2)) * 2.0) * SHADOW_PROBE * uExtinction;
      }
#elif SHADOW_PROBES == 1
      // One probe, as far as the two together reach.
      if(dc > 0.02 && uSunDir.y > -0.1){
        vec3 s1 = p + uSunDir * (SHADOW_PROBE * 2.0);
        L.x += cloudDensity(s1, fieldsAll(s1)) * 3.0 * SHADOW_PROBE * uExtinction;
      }
#endif
      float powder = 1.0 - exp(-dc * uExtinction * 1.5);
      float h = clamp(p.y / uHeight * 1.3, 0.0, 1.0);
      // Sky light where the sky is seen: dim deep inside and under the cloud, full at its edges.
      vec3 ambient = mix(uAmbientBottom + uBounceSun * sunThrough(L.x), uAmbientTop, h) * mix(0.18, 1.0, L.y);
      vec3 cloudCol = sunColor * sunlight(L.x, phases) * mix(0.6, 1.0, powder) * 0.55 + ambient * 0.9;
      // Water drops absorb nothing: the shafts take the sunlight that reaches them (bright against the sun, the rainbow
      // opposite it) and the sky's; a shaft under its storm is lit by little but the sky beside it.
      // The sky's light on rain greyer than on the cloud's edges: it comes from all round, the bright horizon too.
      // Under the melting level drops (forward, the rainbow); over it snow, matte (a phase like the cloud's, no bow).
      float liquid = 1.0 - smoothstep(uFreezing - 0.3, uFreezing + 0.3, p.y);
      vec3 precipPh = mix(vec3(phases.x), rainPh, liquid);
      vec3 rainCol = sunColor * (exp(-L.x) * precipPh + sunThrough(L.x) - exp(-L.x)) * 0.55 + mix(ambient, vec3(dot(ambient, vec3(0.3, 0.5, 0.2))), 0.5) * 0.8;
      if(uFlashOn > 0.5){
        vec3 tp = toTex(p);
        vec3 flash = FLASH_COLOR * FLASH_GAIN * (dot(flashDecode(texture(uFlashA, tp)), uFlashIA) + dot(flashDecode(texture(uFlashB, tp)), uFlashIB));
        cloudCol += flash; rainCol += flash * 0.4;
      }
      // Inside the cloud its droplets set the colour (they scatter far more per gram than the precipitation): the rain's
      // grey only where the cloud is thin or absent, as in the shafts under the base.
      vec3 S = mix(cloudCol, rainCol, dr / (dc * uExtinction + dr));
      float a = exp(-sigma * dt);
      float w = T * (1.0 - a);
      col += S * w;
      depthSum += tt * w;
      weightSum += w;
      T *= a;
    }
    tt += dt;
  }

  // The march stops at T < 0.02: what is left would let the sun's disc (SUN_DISC times the sky, view.ts) glow through a
  // dense cloud as a bright spot (the testers' 16.10.2026). The last few per cent go to nothing; thinner cloud still
  // shows the sun dimmed, as in nature.
  T *= smoothstep(0.02, 0.1, T);
  float alpha = (1.0 - T) * uOpacity;
  if(alpha < 0.003) discard;
  vec3 c = col / (1.0 - T);
  float dist = depthSum / max(weightSum, 1e-4);
  vec3 Ta, inscatter = aerial(ro, rd, dist, Ta);
  c = c * Ta + inscatter * airLit(ro, ro + rd * dist);
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
// The cloud's optical depth between a point and the camera (lightning and sprites seen through the cloud).
const cloudBetween = /* glsl */`
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
`

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

${cloudBetween}
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

/**
 * Sprites and halos above the storm (sprites.ts): a sprite's columns, each a camera-facing vertical ribbon from its
 * top down to its tendrils, red above (the N2 first positive band) and blue-violet in the tendrils below ~60 km (Pasko
 * 2010, colour photos of Stenbaek-Nielsen et al.); a halo a dim red disc of tens of km at the ionosphere's edge. Seen
 * through the cloud and the haze like the lightning.
 */
export const spriteVertex = /* glsl */`
${volumeCommon}
${cloudSampling}
${cloudBetween}
attribute vec3 aBase;
attribute vec4 aShape;
attribute vec2 aCorner;
attribute float aHead;
uniform float uSprite[8];
varying vec2 vUv;
varying float vH;
varying float vHead;
varying float vKind;
varying float vI;
varying float vSeen;
varying vec3 vTint;

void main(){
  // aShape: x the slot, y the half width, z the height of the top above aBase (km), w the kind (0 column, 1 halo).
  float I = uSprite[int(aShape.x + 0.5)];
  if(I < 0.002){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p;
  if(aShape.w < 0.5){
    vec3 look = aBase - cameraPosition;
    vec3 side = normalize(vec3(-look.z, 0.0, look.x) + vec3(1e-5, 0.0, 0.0));
    p = aBase + vec3(0.0, aCorner.y * aShape.z, 0.0) + side * aCorner.x * aShape.y;
  } else p = aBase + vec3(aCorner.x * aShape.y, 0.0, (aCorner.y * 2.0 - 1.0) * aShape.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vUv = aCorner; vH = p.y; vHead = aHead; vKind = aShape.w; vI = I;
  vSeen = exp(-cloudBetween(p));
  vTint = exp(-length(cameraPosition - p) * vec3(0.004, 0.007, 0.012));
}`

export const spriteFragment = /* glsl */`
precision highp float;
varying vec2 vUv;
varying float vH;
varying float vHead;
varying float vKind;
varying float vI;
varying float vSeen;
varying vec3 vTint;

void main(){
  vec3 c;
  if(vKind < 0.5){
    // A carrot: the bright head where the streamers start, the diffuse red body above it fading to the top, the
    // tendrils below it thin, branching to nothing and bluer (Stenbaek-Nielsen et al. 2000, Pasko 2010).
    float up = vH - vHead, x = abs(vUv.x);
    float body = exp(-max(up, 0.0) / 5.0) * exp(-x * x * 3.0) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
    float strands = 0.55 + 0.45 * sin(vUv.x * 9.0 + vH * 0.7);
    float tendril = exp(max(-up, 0.0) * -0.12) * exp(-x * x * 14.0) * strands;
    float head = exp(-up * up / 2.0) * exp(-x * x * 5.0);
    float a = up > 0.0 ? body : tendril;
    vec3 col = mix(vec3(0.42, 0.3, 1.0), vec3(1.0, 0.2, 0.16), smoothstep(-12.0, 2.0, up));
    c = col * (a * 0.8 + head * 0.6) * smoothstep(0.0, 0.08, vUv.y);
  } else {
    float r = length(vec2(vUv.x, vUv.y * 2.0 - 1.0));
    c = vec3(1.0, 0.3, 0.22) * 0.35 * exp(-r * r * 3.0) * (1.0 - smoothstep(0.85, 1.0, r));
  }
  gl_FragColor = vec4(c * vI * vSeen * vTint, 1.0);
}`
