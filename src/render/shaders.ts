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

// Injected into the ground's MeshStandardMaterial; attenuates only direct sunlight so shaded ground keeps sky light.
export const groundShadowPars = volumeCommon + cloudSampling + /* glsl */`
varying vec3 vCloudWorld;

float cloudShadow(vec3 p){
  const int N = 24;
  float ds = (uHeight - p.y) / max(uSunDir.y, 0.1) / float(N);
  float od = 0.0;
  for(int i = 0; i < N; i++){
    vec2 f = fields(p + uSunDir * (ds * (float(i) + 0.5)));
    od += f.r + f.g * 0.3;
  }
  return exp(-od * ds * uExtinction * 0.8);
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

const int STEPS = 96;
const int LIGHT_STEPS = 5;
const float LIGHT_STEP = 0.6;
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
  float phase = mix(hg(cosT, 0.55), hg(cosT, -0.2), 0.35) * 2.0 * PI + 0.5;

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
      float od = 0.0;
      for(int j = 1; j <= LIGHT_STEPS; j++){
        vec2 lf = fields(p + uSunDir * (float(j) * LIGHT_STEP));
        od += lf.r * 1.1 + lf.g * 0.3;
      }
      float lightT = exp(-od * LIGHT_STEP * uExtinction);
      float powder = 1.0 - exp(-dc * uExtinction * 1.5);
      float h = clamp(p.y / uHeight * 1.3, 0.0, 1.0);
      vec3 ambient = mix(uAmbientBottom, uAmbientTop, h);
      vec3 cloudCol = uSunColor * lightT * phase * mix(0.6, 1.0, powder) + ambient * 0.9;
      vec3 rainCol = vec3(0.36, 0.42, 0.50) * (0.35 + 0.65 * length(ambient));
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
