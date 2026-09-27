export const volumeVertex = /* glsl */`
varying vec3 vWorld;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

export const volumeFragment = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler3D uDensity;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uGrid;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uHeight;
uniform float uTime;
uniform float uExtinction;
varying vec3 vWorld;

const int STEPS = 96;
const int LIGHT_STEPS = 5;
const float LIGHT_STEP = 0.6;
const float PI = 3.14159265;

vec2 boxHit(vec3 ro, vec3 rd){
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// Grid node k sits at the box edge, texel centre is at (k+0.5)/N; vertical nodes span 0..H with NZ-1 intervals.
vec3 toTex(vec3 p){
  vec3 s = uBoxMax - uBoxMin;
  return vec3(
    (p.x - uBoxMin.x) / s.x + 0.5 / uGrid.x,
    (p.z - uBoxMin.z) / s.z + 0.5 / uGrid.y,
    (p.y / uHeight * (uGrid.z - 1.0) + 0.5) / uGrid.z);
}

vec2 fields(vec3 p){ return texture(uDensity, toTex(p)).rg; }

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
  if(t.y <= t.x) discard;

  float dt = (t.y - t.x) / float(STEPS);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float tt = t.x + dt * jitter;

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
      vec3 ambient = mix(vec3(0.20, 0.23, 0.28), vec3(0.62, 0.72, 0.84), h);
      vec3 cloudCol = uSunColor * lightT * phase * mix(0.6, 1.0, powder) + ambient * 0.9;
      vec3 rainCol = vec3(0.36, 0.42, 0.50) * (0.5 + 0.5 * lightT);
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

  float alpha = 1.0 - T;
  if(alpha < 0.003) discard;
  vec3 c = col / alpha;
  float dist = depthSum / max(weightSum, 1e-4);
  float fd = uFogDensity * dist;
  c = mix(c, uFogColor, 1.0 - exp(-fd * fd));
  gl_FragColor = vec4(c, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`
