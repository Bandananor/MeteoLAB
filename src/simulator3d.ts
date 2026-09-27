import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fieldVolumeFragment, groundShadowPars, precipFragment, precipVertex, sliceFragment, volumeFragment, volumeVertex } from './volumeShaders'

export type FieldMode='composite'|'updraft'|'theta'|'moisture'|'vorticity'|'coldpool'
export type ScalarField=Exclude<FieldMode,'composite'>
export interface FieldInfo{title:string;units:string;min:number;max:number;diverging:boolean;threshold:number;stops:string[]}
const DIVERGING=['#24476b','#4d86b3','#a9c9df','#f1efe9','#eab58f','#cf6d49','#8f2a1f']
export const FIELDS:Record<ScalarField,FieldInfo>={
  updraft:{title:'Вертикальная скорость',units:'м/с',min:-15,max:15,diverging:true,threshold:.25,stops:DIVERGING},
  theta:{title:'Отклонение температуры от окружения',units:'K',min:-4,max:4,diverging:true,threshold:.3,stops:DIVERGING},
  moisture:{title:'Относительная влажность',units:'%',min:0,max:100,diverging:false,threshold:.85,stops:['#7a5a33','#b89a63','#e3dcc0','#9ccbbd','#4b9aa3','#1f5d78']},
  vorticity:{title:'Вертикальная завихренность',units:'10⁻³ с⁻¹',min:-4,max:4,diverging:true,threshold:.3,stops:DIVERGING},
  coldpool:{title:'Охлаждение от испарения осадков',units:'K',min:0,max:8,diverging:false,threshold:.15,stops:['#f1efe9','#b9d7e6','#6ea6cc','#3769a0','#1d3565']},
}
export type SurfaceType='grass'|'dry'|'water'|'urban'
export interface SimConfig{
  surfaceTemp:number;lapseLow:number;lapseMid:number;lapseUpper:number;tropopause:number;stratoWarming:number
  rhSurface:number;rhLow:number;rhMid:number;rhUpper:number;entrainment:number
  wind0:number;wind3:number;wind6:number;wind10:number;windDir0:number;windDir3:number;windDir6:number;windDir10:number
  latitude:number;turbulence:number;hour:number;solarMax:number;soilMoisture:number;surfaceType:SurfaceType
  precipEfficiency:number;evaporation:number;coldPoolStrength:number;speed:number;seed:number
}
export interface ParcelPoint{z:number;env:number;dew:number;parcel:number;buoyancy:number}
export interface WindPoint{z:number;u:number;v:number}
export interface Sounding{profile:ParcelPoint[];wind:WindPoint[];cape:number;cin:number;lcl:number|null;lfc:number|null;el:number|null;freezing:number|null}

const NX=40,NY=32,NZ=24,N=NX*NY*NZ,W=48_000,D=36_000,H=15_000,DX=W/NX,DY=D/NY,DZ=H/(NZ-1)
const G=9.81,CP=1004,LV=2.5e6,KAPPA=.286,RD=287.05,EPS=.622,OMEGA=7.2921e-5,DT=1
const FLOW_PARTICLES=10_000,PRECIP_PARTICLES=8000,MELT_DEPTH=600,SNOW_FALL=2,RAIN_FALL=7
const clamp=(x:number,a=0,b=1)=>Math.max(a,Math.min(b,x)),lerp=(a:number,b:number,t:number)=>a+(b-a)*clamp(t)
const mod=(x:number,n:number)=>((x%n)+n)%n
const colormapTexture=(stops:string[])=>{const data=new Uint8Array(256*4),rgb=stops.map(s=>[1,3,5].map(k=>parseInt(s.slice(k,k+2),16)));for(let i=0;i<256;i++){const f=i/255*(rgb.length-1),k=Math.min(rgb.length-2,Math.floor(f)),t=f-k;for(let c=0;c<3;c++)data[i*4+c]=rgb[k][c]+(rgb[k+1][c]-rgb[k][c])*t;data[i*4+3]=255}const tex=new THREE.DataTexture(data,256,1);tex.colorSpace=THREE.SRGBColorSpace;tex.minFilter=tex.magFilter=THREE.LinearFilter;tex.needsUpdate=true;return tex}
const texture3D=(data:Uint8Array,format:THREE.PixelFormat)=>{const t=new THREE.Data3DTexture(data,NX,NY,NZ);t.format=format;t.type=THREE.UnsignedByteType;t.minFilter=t.magFilter=THREE.LinearFilter;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.wrapR=THREE.ClampToEdgeWrapping;t.unpackAlignment=1;t.needsUpdate=true;return t}
const softParticleTexture=()=>{const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d')!,g=x.createRadialGradient(32,32,2,32,32,31);g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(.42,'rgba(255,255,255,.78)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,64,64);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t}

export class Atmosphere{
  private canvas:HTMLCanvasElement;private config:SimConfig;private renderer:THREE.WebGLRenderer;private scene:THREE.Scene;private camera:THREE.PerspectiveCamera;private controls:OrbitControls
  private ground:THREE.Mesh;private raycaster=new THREE.Raycaster();private pointer=new THREE.Vector2()
  private sunLight:THREE.DirectionalLight;private hemiLight:THREE.HemisphereLight
  private shared={uBoxMin:{value:new THREE.Vector3(-W/2000,0,-D/2000)},uBoxMax:{value:new THREE.Vector3(W/2000,H/1000,D/2000)},uGrid:{value:new THREE.Vector3(NX,NY,NZ)},uSunDir:{value:new THREE.Vector3(0,1,0)},uHeight:{value:H/1000},uExtinction:{value:2.2},uSliceOn:{value:0},uSliceH:{value:2},uSliceZ:{value:0}}
  private volumeData=new Uint8Array(N*2);private volumeTexture:THREE.Data3DTexture;private volumeMaterial:THREE.ShaderMaterial;private volumeMesh:THREE.Mesh
  private fieldData=new Uint8Array(N);private fieldTexture:THREE.Data3DTexture;private colormap:THREE.DataTexture|null=null;private colormapField:ScalarField|null=null
  private fieldUniforms:{[k:string]:THREE.IUniform};private fieldMaterial:THREE.ShaderMaterial;private fieldMesh:THREE.Mesh;private sliceMaterial:THREE.ShaderMaterial;private sliceH:THREE.Mesh;private sliceV:THREE.Mesh
  private flowGeometry:THREE.BufferGeometry;private flowPoints:THREE.Points;private vectorGeometry:THREE.BufferGeometry;private vectorLines:THREE.LineSegments
  private levelHelpers:THREE.GridHelper[]=[];private freezingHelper:THREE.GridHelper
  private precipModel=new Float32Array(PRECIP_PARTICLES*3);private precipAge=new Float32Array(PRECIP_PARTICLES);private precipAlive=new Uint8Array(PRECIP_PARTICLES);private precipNext=0
  private precipGeometry:THREE.BufferGeometry;private precipMaterial:THREE.ShaderMaterial;private precipPoints:THREE.Points
  private u=new Float32Array(N);private v=new Float32Array(N);private w=new Float32Array(N);private theta=new Float32Array(N);private q=new Float32Array(N);private cloud=new Float32Array(N);private rain=new Float32Array(N);private cold=new Float32Array(N)
  private pressure=new Float32Array(N);private divergence=new Float32Array(N);private scratch=new Float32Array(N);private surfacePattern=new Float32Array(NX*NY)
  private particleModel=new Float32Array(FLOW_PARTICLES*3);private particleAge=new Float32Array(FLOW_PARTICLES);private rng:()=>number;private accumulator=0;private microburstOutflow=0;private frame=0
  private cachedParcel:Sounding
  field:FieldMode='composite';showVectors=false;showPrecip=false;time=0;showFieldVolume=true;sliceHeight=2;sliceNorth=0

  constructor(canvas:HTMLCanvasElement,config:SimConfig){
    this.canvas=canvas;this.config=config;this.rng=this.mulberry32(config.seed);this.cachedParcel={profile:[],wind:[],cape:0,cin:0,lcl:null,lfc:null,el:null,freezing:null}
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.05
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x172d3b);this.scene.fog=new THREE.FogExp2(0x172d3b,.012)
    this.camera=new THREE.PerspectiveCamera(42,1,.1,180);this.camera.position.set(38,24,39)
    this.controls=new OrbitControls(this.camera,canvas);this.controls.target.set(0,6,0);this.controls.enableDamping=true;this.controls.dampingFactor=.07;this.controls.maxPolarAngle=Math.PI*.495;this.controls.minDistance=15;this.controls.maxDistance=100
    this.hemiLight=new THREE.HemisphereLight(0xd9efff,0x4b4439,1.35);this.scene.add(this.hemiLight);this.sunLight=new THREE.DirectionalLight(0xfff0d2,2);this.scene.add(this.sunLight)
    const groundMat=new THREE.MeshStandardMaterial({color:this.surfaceColor(),roughness:.96,metalness:0});this.ground=new THREE.Mesh(new THREE.PlaneGeometry(W/1000,D/1000),groundMat);this.ground.rotation.x=-Math.PI/2;this.scene.add(this.ground)
    const grid=new THREE.GridHelper(W/1000,16,0x71838a,0x485d66);grid.material.transparent=true;grid.material.opacity=.32;this.scene.add(grid)
    const box=new THREE.BoxGeometry(W/1000,H/1000,D/1000);box.translate(0,H/2000,0);const edges=new THREE.LineSegments(new THREE.EdgesGeometry(box),new THREE.LineBasicMaterial({color:0x75909c,transparent:true,opacity:.4}));this.scene.add(edges)
    this.levelHelpers=[0xb6d4dd,0xe1bf7e,0xd88e74].map(color=>{const h=new THREE.GridHelper(W/1000,12,color,color);h.material.transparent=true;h.material.opacity=.18;this.scene.add(h);return h})
    this.volumeTexture=texture3D(this.volumeData,THREE.RGFormat)
    this.volumeMaterial=new THREE.ShaderMaterial({vertexShader:volumeVertex,fragmentShader:volumeFragment,side:THREE.BackSide,transparent:true,depthWrite:false,depthTest:false,premultipliedAlpha:true,uniforms:{...this.shared,
      uDensity:{value:this.volumeTexture},uSunColor:{value:new THREE.Color()},uAmbientTop:{value:new THREE.Color()},uAmbientBottom:{value:new THREE.Color()},
      uFogColor:{value:(this.scene.fog as THREE.FogExp2).color},uFogDensity:{value:(this.scene.fog as THREE.FogExp2).density},uTime:{value:0},uOpacity:{value:1}}})
    const volumeBox=new THREE.BoxGeometry(W/1000,H/1000,D/1000);volumeBox.translate(0,H/2000,0);this.volumeMesh=new THREE.Mesh(volumeBox,this.volumeMaterial);this.volumeMesh.renderOrder=1;this.scene.add(this.volumeMesh)
    this.fieldTexture=texture3D(this.fieldData,THREE.RedFormat)
    this.fieldUniforms={...this.shared,uField:{value:this.fieldTexture},uColormap:{value:null},uDiverging:{value:0},uThreshold:{value:.3}}
    this.fieldMaterial=new THREE.ShaderMaterial({vertexShader:volumeVertex,fragmentShader:fieldVolumeFragment,side:THREE.BackSide,transparent:true,depthWrite:false,depthTest:false,premultipliedAlpha:true,toneMapped:false,uniforms:this.fieldUniforms})
    this.fieldMesh=new THREE.Mesh(volumeBox,this.fieldMaterial);this.fieldMesh.renderOrder=1.5;this.scene.add(this.fieldMesh)
    this.sliceMaterial=new THREE.ShaderMaterial({vertexShader:volumeVertex,fragmentShader:sliceFragment,side:THREE.DoubleSide,toneMapped:false,uniforms:this.fieldUniforms})
    const horizontal=new THREE.PlaneGeometry(W/1000,D/1000);horizontal.rotateX(-Math.PI/2);this.sliceH=new THREE.Mesh(horizontal,this.sliceMaterial);this.scene.add(this.sliceH)
    const vertical=new THREE.PlaneGeometry(W/1000,H/1000);vertical.translate(0,H/2000,0);this.sliceV=new THREE.Mesh(vertical,this.sliceMaterial);this.scene.add(this.sliceV)
    groundMat.onBeforeCompile=shader=>{
      const u=this.volumeMaterial.uniforms
      Object.assign(shader.uniforms,{...this.shared,uDensity:u.uDensity})
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vCloudWorld;').replace('#include <project_vertex>','#include <project_vertex>\nvCloudWorld=(modelMatrix*vec4(transformed,1.0)).xyz;')
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>\n${groundShadowPars}`).replace('#include <lights_fragment_end>','#include <lights_fragment_end>\n{float s=cloudShadow(vCloudWorld);reflectedLight.directDiffuse*=s;reflectedLight.directSpecular*=s;}')
    }
    const soft=softParticleTexture()
    this.flowGeometry=new THREE.BufferGeometry();this.flowGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(FLOW_PARTICLES*3),3));this.flowGeometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(FLOW_PARTICLES*3),3));this.flowPoints=new THREE.Points(this.flowGeometry,new THREE.PointsMaterial({size:.12,map:soft,alphaTest:.03,vertexColors:true,transparent:true,opacity:.82,depthWrite:false}));this.flowPoints.renderOrder=2;this.scene.add(this.flowPoints)
    this.vectorGeometry=new THREE.BufferGeometry();this.vectorGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(1800*3),3));this.vectorGeometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(1800*3),3));this.vectorLines=new THREE.LineSegments(this.vectorGeometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.72}));this.scene.add(this.vectorLines)
    this.freezingHelper=new THREE.GridHelper(W/1000,24,0x9fd3f0,0x9fd3f0);this.freezingHelper.material.transparent=true;this.freezingHelper.material.opacity=.28;this.scene.add(this.freezingHelper)
    this.precipGeometry=new THREE.BufferGeometry();this.precipGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(PRECIP_PARTICLES*3),3));this.precipGeometry.setAttribute('aMelt',new THREE.BufferAttribute(new Float32Array(PRECIP_PARTICLES).fill(-1),1))
    this.precipMaterial=new THREE.ShaderMaterial({vertexShader:precipVertex,fragmentShader:precipFragment,transparent:true,depthWrite:false,toneMapped:false,uniforms:{uScale:{value:500}}})
    this.precipPoints=new THREE.Points(this.precipGeometry,this.precipMaterial);this.precipPoints.frustumCulled=false;this.precipPoints.renderOrder=2;this.scene.add(this.precipPoints)
    this.initialize();this.cachedParcel=this.computeParcel();this.updateLevels();for(let p=0;p<FLOW_PARTICLES;p++)this.respawnParticle(p,true)
  }

  dispose(){this.controls.dispose();[this.volumeTexture,this.fieldTexture,this.colormap,this.volumeMaterial,this.fieldMaterial,this.sliceMaterial,this.volumeMesh.geometry,this.sliceH.geometry,this.sliceV.geometry,this.precipGeometry,this.precipMaterial].forEach(r=>r?.dispose());this.renderer.dispose()}
  private surfaceColor(){return{grass:0x596d45,dry:0x776a51,water:0x315d70,urban:0x606469}[this.config.surfaceType]}
  private idx(x:number,y:number,z:number){return mod(x,NX)+NX*(mod(y,NY)+NY*clamp(z,0,NZ-1))}
  private mulberry32(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
  private pressureAt(z:number){return 101325*Math.exp(-z/8000)}
  private temperatureEnv(z:number){const tp=this.config.tropopause*1000,t3=this.config.surfaceTemp-this.config.lapseLow*3,t8=t3-this.config.lapseMid*5;if(z<=3000)return this.config.surfaceTemp-this.config.lapseLow*z/1000;if(z<=8000)return t3-this.config.lapseMid*(z-3000)/1000;const ttp=t8-this.config.lapseUpper*(tp-8000)/1000;if(z<=tp)return t8-this.config.lapseUpper*(z-8000)/1000;return ttp+this.config.stratoWarming*(z-tp)/1000}
  private thetaEnv(z:number){return(this.temperatureEnv(z)+273.15)*(100000/this.pressureAt(z))**KAPPA}
  private tempFromTheta(th:number,z:number){return th*(this.pressureAt(z)/100000)**KAPPA-273.15}
  private qsat(t:number,z:number){const es=611.2*Math.exp(17.67*t/(t+243.5));return clamp(.622*es/Math.max(1000,this.pressureAt(z)-es),0,.045)}
  private rhEnv(z:number){const tp=this.config.tropopause*1000;if(z<1500)return lerp(this.config.rhSurface,this.config.rhLow,z/1500)/100;if(z<5000)return lerp(this.config.rhLow,this.config.rhMid,(z-1500)/3500)/100;if(z<tp)return lerp(this.config.rhMid,this.config.rhUpper,(z-5000)/Math.max(1000,tp-5000))/100;return this.config.rhUpper/100*.7}
  private qEnv(z:number){return this.rhEnv(z)*this.qsat(this.temperatureEnv(z),z)}
  private windScalar(z:number){if(z<3000)return lerp(this.config.wind0,this.config.wind3,z/3000);if(z<6000)return lerp(this.config.wind3,this.config.wind6,(z-3000)/3000);if(z<10000)return lerp(this.config.wind6,this.config.wind10,(z-6000)/4000);return this.config.wind10}
  private windDirection(z:number){if(z<3000)return lerp(this.config.windDir0,this.config.windDir3,z/3000);if(z<6000)return lerp(this.config.windDir3,this.config.windDir6,(z-3000)/3000);if(z<10000)return lerp(this.config.windDir6,this.config.windDir10,(z-6000)/4000);return this.config.windDir10}
  private windUV(z:number){const s=this.windScalar(z),a=(270-this.windDirection(z))*Math.PI/180;return[s*Math.cos(a),s*Math.sin(a)] as const}
  private surface(){return{grass:{albedo:.2,sensible:.42,evap:.75,inertia:.65},dry:{albedo:.3,sensible:.72,evap:.15,inertia:.45},water:{albedo:.08,sensible:.18,evap:1.25,inertia:1.8},urban:{albedo:.16,sensible:.78,evap:.08,inertia:.8}}[this.config.surfaceType]}
  private insolation(){const hour=this.config.hour+this.time/3600;return this.config.solarMax*Math.max(0,Math.sin(Math.PI*(hour-6)/12))}
  // Equinox sun (declination 0): rises at 06:00 and sets at 18:00, matching insolation(). World axes: +X east, +Y up, -Z north.
  private sunDirection(){const hour=this.config.hour+this.time/3600,h=(hour-12)*Math.PI/12,phi=this.config.latitude*Math.PI/180;return new THREE.Vector3(-Math.sin(h),Math.cos(phi)*Math.cos(h),Math.sin(phi)*Math.cos(h))}
  private updateSun(){
    const dir=this.sunDirection(),day=THREE.MathUtils.smoothstep(dir.y,-.03,.12),warm=THREE.MathUtils.smoothstep(dir.y,0,.4),u=this.volumeMaterial.uniforms
    this.shared.uSunDir.value.copy(dir)
    ;(u.uSunColor.value as THREE.Color).setRGB(1,lerp(.55,.94,warm),lerp(.3,.84,warm)).multiplyScalar(2.6*day)
    ;(u.uAmbientTop.value as THREE.Color).setRGB(lerp(.08,.62,day),lerp(.1,.72,day),lerp(.16,.84,day))
    ;(u.uAmbientBottom.value as THREE.Color).setRGB(lerp(.05,.2,day),lerp(.06,.23,day),lerp(.08,.28,day))
    this.sunLight.position.copy(dir).multiplyScalar(50);this.sunLight.intensity=2*day;this.sunLight.color.setRGB(1,lerp(.62,.94,warm),lerp(.4,.82,warm))
    this.hemiLight.intensity=.45+.9*day
  }

  private initialize(){let walk=0;for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){walk=walk*.82+(this.rng()-.5)*.34;this.surfacePattern[x+NX*y]=walk}for(let z=0;z<NZ;z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){const i=this.idx(x,y,z),alt=z*DZ,[ue,ve]=this.windUV(alt);this.u[i]=ue;this.v[i]=ve;this.w[i]=0;this.theta[i]=this.thetaEnv(alt)+(this.rng()-.5)*.018;this.q[i]=this.qEnv(alt);this.cloud[i]=this.rain[i]=this.cold[i]=0}this.injectBubble(W*.38,D*.45,1);this.injectBubble(W*.61,D*.57,.72)}
  private injectBubble(cx:number,cy:number,strength:number){for(let z=0;z<Math.min(5,NZ);z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){let dx=x*DX-cx,dy=y*DY-cy;if(dx>W/2)dx-=W;if(dx<-W/2)dx+=W;if(dy>D/2)dy-=D;if(dy<-D/2)dy+=D;const d2=(dx/4200)**2+(dy/4200)**2+(z*DZ/1800)**2,a=Math.exp(-d2)*strength,i=this.idx(x,y,z);this.theta[i]+=3.2*a;this.q[i]+=.003*a;this.w[i]+=1.1*a}}
  perturb(nx:number,ny:number,strength=1){this.pointer.set(nx*2-1,-(ny*2-1));this.raycaster.setFromCamera(this.pointer,this.camera);const hit=this.raycaster.intersectObject(this.ground,false)[0];const cx=hit?clamp((hit.point.x+W/2000)*1000,0,W):W/2,cy=hit?clamp((D/2000-hit.point.z)*1000,0,D):D/2;this.injectBubble(cx,cy,strength)}

  private sample(a:Float32Array,x:number,y:number,z:number){x=mod(x,NX);y=mod(y,NY);z=clamp(z,0,NZ-1.001);const x0=Math.floor(x),y0=Math.floor(y),z0=Math.floor(z),x1=(x0+1)%NX,y1=(y0+1)%NY,z1=Math.min(NZ-1,z0+1),fx=x-x0,fy=y-y0,fz=z-z0;const c000=a[this.idx(x0,y0,z0)],c100=a[this.idx(x1,y0,z0)],c010=a[this.idx(x0,y1,z0)],c110=a[this.idx(x1,y1,z0)],c001=a[this.idx(x0,y0,z1)],c101=a[this.idx(x1,y0,z1)],c011=a[this.idx(x0,y1,z1)],c111=a[this.idx(x1,y1,z1)],c00=lerp(c000,c100,fx),c10=lerp(c010,c110,fx),c01=lerp(c001,c101,fx),c11=lerp(c011,c111,fx);return lerp(lerp(c00,c10,fy),lerp(c01,c11,fy),fz)}
  private advect(a:Float32Array,dt:number,decay=1,fall=0){for(let z=0;z<NZ;z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){const i=this.idx(x,y,z);this.scratch[i]=this.sample(a,x-this.u[i]*dt/DX,y-this.v[i]*dt/DY,z-(this.w[i]-fall)*dt/DZ)*decay}a.set(this.scratch)}
  advance(realDt:number){this.accumulator+=realDt*this.config.speed;let steps=0;while(this.accumulator>=DT&&steps<12){this.step(DT);this.accumulator-=DT;this.time+=DT;steps++}}
  private step(dt:number){
    this.microburstOutflow*=.993;this.advect(this.u,dt,.9999);this.advect(this.v,dt,.9999);this.advect(this.w,dt,.9995);this.advect(this.theta,dt);this.advect(this.q,dt,.999999);this.advect(this.cloud,dt,.99995);this.advect(this.rain,dt,.9995,7);this.advect(this.cold,dt,.9992)
    const surf=this.surface(),solar=this.insolation(),absorbed=solar*(1-surf.albedo),heatFlux=absorbed*surf.sensible/surf.inertia,moistFlux=absorbed*(1-surf.sensible)*surf.evap*this.config.soilMoisture/100,lfcZ=(this.cachedParcel.lfc??1.5)*1000,f=2*OMEGA*Math.sin(this.config.latitude*Math.PI/180)
    for(let z=0;z<NZ;z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){
      const i=this.idx(x,y,z),alt=z*DZ,p=this.pressureAt(alt),exner=(p/100000)**KAPPA,temp=this.tempFromTheta(this.theta[i],alt),sat=this.qsat(temp,alt),rh=this.q[i]/Math.max(.00001,sat)
      if(this.q[i]>sat){const cond=Math.min(this.q[i]-sat,(this.q[i]-sat)*.32*dt);this.q[i]-=cond;this.cloud[i]+=cond;this.theta[i]+=LV/CP/exner*cond}
      if(rh<1&&this.cloud[i]>0){const evap=Math.min(this.cloud[i],.00006*this.config.entrainment*(1-rh)*dt);this.cloud[i]-=evap;this.q[i]+=evap;const cool=LV/CP/exner*evap;this.theta[i]-=cool;this.cold[i]+=cool*.14}
      const auto=Math.max(0,this.cloud[i]-.0009)*.035*this.config.precipEfficiency*dt;this.cloud[i]-=auto;this.rain[i]+=auto
      if(this.q[i]<sat&&this.rain[i]>0){const evap=Math.min(this.rain[i],(sat-this.q[i])*.018*this.config.evaporation*dt);this.rain[i]-=evap;this.q[i]+=evap;const cool=LV/CP/exner*evap*this.config.coldPoolStrength;this.theta[i]-=cool;this.cold[i]+=cool}
      const buoy=(this.theta[i]-this.thetaEnv(alt))/Math.max(250,this.thetaEnv(alt))+.61*(this.q[i]-this.qEnv(alt))-1.8*this.cloud[i]-2.5*this.rain[i];this.w[i]+=G*buoy*dt
      const[ue,ve]=this.windUV(alt),du=this.u[i]-ue,dv=this.v[i]-ve;this.u[i]+=f*dv*dt;this.v[i]-=f*du*dt
      if(z<=1){const weight=Math.exp(-alt/300),pattern=1+this.surfacePattern[x+NX*y]*.32,rho=1.18*Math.exp(-alt/9000);this.theta[i]+=heatFlux*pattern/(rho*CP*300)*weight*dt;this.q[i]+=moistFlux*1.3e-10*weight*dt}
      if(alt<Math.min(3200,lfcZ)){const s=this.idx(x,y,0),gx=this.cold[this.idx(x+1,y,0)]-this.cold[this.idx(x-1,y,0)],gy=this.cold[this.idx(x,y+1,0)]-this.cold[this.idx(x,y-1,0)],edge=Math.hypot(gx,gy),core=this.cold[s];this.w[i]+=G*edge/300*.45*this.config.coldPoolStrength*Math.max(.12,1-alt/Math.max(300,lfcZ))*dt;if(alt<1300&&core>1)this.w[i]-=G*core/300*.52*Math.exp(-alt/520)*dt}
      if(z<=1&&this.w[i]<-5&&this.rain[i]>.0001){const impact=Math.min(38,-this.w[i]*Math.sqrt(this.rain[i]/.00055))*this.config.precipEfficiency,dpx=(-this.w[this.idx(x+1,y,z)]+this.w[this.idx(x-1,y,z)])*.5,dpy=(-this.w[this.idx(x,y+1,z)]+this.w[this.idx(x,y-1,z)])*.5;this.u[i]-=dpx*.12*dt;this.v[i]-=dpy*.12*dt;this.cold[i]+=impact*.0012*dt;this.microburstOutflow=Math.max(this.microburstOutflow,impact)}
      const mix=clamp(this.config.turbulence*.0015*dt,0,.01);const thAvg=(this.theta[this.idx(x+1,y,z)]+this.theta[this.idx(x-1,y,z)]+this.theta[this.idx(x,y+1,z)]+this.theta[this.idx(x,y-1,z)])/4;this.theta[i]=lerp(this.theta[i],thAvg,mix);const qAvg=(this.q[this.idx(x+1,y,z)]+this.q[this.idx(x-1,y,z)]+this.q[this.idx(x,y+1,z)]+this.q[this.idx(x,y-1,z)])/4;this.q[i]=lerp(this.q[i],qAvg,mix);this.cold[i]=clamp(this.cold[i],0,15)
      const spongeStart=Math.max(this.config.tropopause*1000+1600,13_000);if(alt>spongeStart){const s=clamp((alt-spongeStart)/(H-spongeStart))*.06*dt;this.w[i]*=1-s;this.u[i]=lerp(this.u[i],ue,s);this.v[i]=lerp(this.v[i],ve,s);this.theta[i]=lerp(this.theta[i],this.thetaEnv(alt),s)}
    }
    this.project(dt,16);for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){const b=this.idx(x,y,0),t=this.idx(x,y,NZ-1);this.w[b]=0;this.u[b]*=.94;this.v[b]*=.94;this.w[t]=0}
    this.updateParticles(dt);if(this.showPrecip)this.updatePrecip(dt)
  }
  private project(dt:number,iters:number){this.pressure.fill(0);const ix=1/(DX*DX),iy=1/(DY*DY),iz=1/(DZ*DZ),den=2*(ix+iy+iz);for(let z=1;z<NZ-1;z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){const i=this.idx(x,y,z);this.divergence[i]=(this.u[this.idx(x+1,y,z)]-this.u[this.idx(x-1,y,z)])/(2*DX)+(this.v[this.idx(x,y+1,z)]-this.v[this.idx(x,y-1,z)])/(2*DY)+(this.w[this.idx(x,y,z+1)]-this.w[this.idx(x,y,z-1)])/(2*DZ)}for(let k=0;k<iters;k++)for(let z=1;z<NZ-1;z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){const i=this.idx(x,y,z);this.pressure[i]=((this.pressure[this.idx(x+1,y,z)]+this.pressure[this.idx(x-1,y,z)])*ix+(this.pressure[this.idx(x,y+1,z)]+this.pressure[this.idx(x,y-1,z)])*iy+(this.pressure[this.idx(x,y,z+1)]+this.pressure[this.idx(x,y,z-1)])*iz-this.divergence[i]/dt)/den}for(let z=1;z<NZ-1;z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){const i=this.idx(x,y,z);this.u[i]-=dt*(this.pressure[this.idx(x+1,y,z)]-this.pressure[this.idx(x-1,y,z)])/(2*DX);this.v[i]-=dt*(this.pressure[this.idx(x,y+1,z)]-this.pressure[this.idx(x,y-1,z)])/(2*DY);this.w[i]-=dt*(this.pressure[this.idx(x,y,z+1)]-this.pressure[this.idx(x,y,z-1)])/(2*DZ);this.u[i]=clamp(this.u[i],-85,85);this.v[i]=clamp(this.v[i],-85,85);this.w[i]=clamp(this.w[i],-60,60)}}

  private respawnParticle(p:number,full=false){const j=p*3;this.particleModel[j]=this.rng()*W;this.particleModel[j+1]=this.rng()*D;this.particleModel[j+2]=full?this.rng()*H*.75:this.rng()*1800;this.particleAge[p]=this.rng()*500}
  private updateParticles(dt:number){const pos=this.flowGeometry.getAttribute('position') as THREE.BufferAttribute,col=this.flowGeometry.getAttribute('color') as THREE.BufferAttribute;for(let p=0;p<FLOW_PARTICLES;p++){const j=p*3;let x=this.particleModel[j],y=this.particleModel[j+1],z=this.particleModel[j+2],gx=x/DX,gy=y/DY,gz=z/DZ,uu=this.sample(this.u,gx,gy,gz),vv=this.sample(this.v,gx,gy,gz),ww=this.sample(this.w,gx,gy,gz);x=mod(x+uu*dt,W);y=mod(y+vv*dt,D);z+=ww*dt;this.particleAge[p]+=dt;if(z<0||z>H||this.particleAge[p]>900){this.respawnParticle(p);x=this.particleModel[j];y=this.particleModel[j+1];z=this.particleModel[j+2]}else{this.particleModel[j]=x;this.particleModel[j+1]=y;this.particleModel[j+2]=z}pos.setXYZ(p,x/1000-W/2000,z/1000,D/2000-y/1000);if(ww>1)col.setXYZ(p,1,.5,.18);else if(ww<-1)col.setXYZ(p,.25,.62,1);else col.setXYZ(p,.72,.82,.86)}pos.needsUpdate=true;col.needsUpdate=true}
  // Visual only: the model has no ice, so a particle's phase comes from its height relative to the environmental 0 °C level.
  private meltFraction(z:number){const f=this.cachedParcel.freezing;return f===null?1:clamp((f*1000-z)/MELT_DEPTH)}
  private updatePrecip(dt:number){
    for(let i=0;i<N;i++){const r=this.rain[i];if(r<3e-4||Math.random()>Math.min(1,r/.002)*.015*dt)continue
      const p=this.precipNext,j=p*3,x=i%NX,y=Math.floor(i/NX)%NY,z=Math.floor(i/(NX*NY));this.precipNext=(p+1)%PRECIP_PARTICLES
      this.precipModel[j]=mod((x+Math.random()-.5)*DX,W);this.precipModel[j+1]=mod((y+Math.random()-.5)*DY,D);this.precipModel[j+2]=clamp((z+Math.random()-.5)*DZ,0,H);this.precipAge[p]=0;this.precipAlive[p]=1}
    for(let p=0;p<PRECIP_PARTICLES;p++){if(!this.precipAlive[p])continue
      const j=p*3,x=this.precipModel[j],y=this.precipModel[j+1],z=this.precipModel[j+2],gx=x/DX,gy=y/DY,gz=z/DZ,fall=lerp(SNOW_FALL,RAIN_FALL,this.meltFraction(z))
      const nz=z+(this.sample(this.w,gx,gy,gz)-fall)*dt;this.precipAge[p]+=dt
      const evaporated=this.sample(this.rain,gx,gy,gz)<2e-5&&Math.random()<.02*dt
      if(nz<=0||nz>H||this.precipAge[p]>2400||evaporated){this.precipAlive[p]=0;continue}
      this.precipModel[j]=mod(x+this.sample(this.u,gx,gy,gz)*dt,W);this.precipModel[j+1]=mod(y+this.sample(this.v,gx,gy,gz)*dt,D);this.precipModel[j+2]=nz}
  }
  private syncPrecip(){const pos=this.precipGeometry.getAttribute('position') as THREE.BufferAttribute,melt=this.precipGeometry.getAttribute('aMelt') as THREE.BufferAttribute
    for(let p=0;p<PRECIP_PARTICLES;p++){const j=p*3;if(!this.precipAlive[p]){melt.setX(p,-1);continue}pos.setXYZ(p,this.precipModel[j]/1000-W/2000,this.precipModel[j+2]/1000,D/2000-this.precipModel[j+1]/1000);melt.setX(p,this.meltFraction(this.precipModel[j+2]))}
    pos.needsUpdate=true;melt.needsUpdate=true}
  private updateVolume(){const d=this.volumeData;for(let i=0;i<N;i++){d[i*2]=clamp((this.cloud[i]-.00003)/.0014)*255;d[i*2+1]=clamp(this.rain[i]/.0025)*255}this.volumeTexture.needsUpdate=true;this.volumeMaterial.uniforms.uTime.value=this.time}
  private fieldValue(field:ScalarField,i:number,x:number,y:number,z:number,alt:number,exner:number,thEnv:number){
    switch(field){
      case 'updraft':return this.w[i]
      case 'theta':return(this.theta[i]-thEnv)*exner
      case 'moisture':return 100*this.q[i]/Math.max(1e-5,this.qsat(this.theta[i]*exner-273.15,alt))
      case 'vorticity':return 1000*((this.v[this.idx(x+1,y,z)]-this.v[this.idx(x-1,y,z)])/(2*DX)-(this.u[this.idx(x,y+1,z)]-this.u[this.idx(x,y-1,z)])/(2*DY))
      case 'coldpool':return this.cold[i]
    }
  }
  private updateFieldTexture(field:ScalarField){
    const info=FIELDS[field]
    if(this.colormapField!==field){this.colormap?.dispose();this.colormap=colormapTexture(info.stops);this.colormapField=field;this.fieldUniforms.uColormap.value=this.colormap;this.fieldUniforms.uDiverging.value=info.diverging?1:0;this.fieldUniforms.uThreshold.value=info.threshold}
    const span=info.max-info.min
    for(let z=0;z<NZ;z++){const alt=z*DZ,exner=(this.pressureAt(alt)/100000)**KAPPA,thEnv=this.thetaEnv(alt);for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){const i=this.idx(x,y,z);this.fieldData[i]=clamp((this.fieldValue(field,i,x,y,z,alt,exner,thEnv)-info.min)/span)*255}}
    this.fieldTexture.needsUpdate=true
  }
  private updateVectors(){const p=this.vectorGeometry.getAttribute('position') as THREE.BufferAttribute,c=this.vectorGeometry.getAttribute('color') as THREE.BufferAttribute;let n=0;for(let z=2;z<NZ-2;z+=4)for(let y=2;y<NY;y+=5)for(let x=2;x<NX;x+=5){const i=this.idx(x,y,z),uu=this.u[i],vv=this.v[i],ww=this.w[i],mag=Math.hypot(uu,vv,ww);if(mag<1)continue;const scale=clamp(mag*.045,.18,1.3),sx=x*DX/1000-W/2000,sy=z*DZ/1000,sz=D/2000-y*DY/1000,ex=sx+uu/mag*scale,ey=sy+ww/mag*scale,ez=sz-vv/mag*scale;p.setXYZ(n,sx,sy,sz);p.setXYZ(n+1,ex,ey,ez);const color=ww>1?[1,.45,.12]:ww<-1?[.2,.6,1]:[.7,.82,.86];c.setXYZ(n,...color as [number,number,number]);c.setXYZ(n+1,...color as [number,number,number]);n+=2}this.vectorGeometry.setDrawRange(0,n);p.needsUpdate=true;c.needsUpdate=true}

  private computeParcel(){const profile:ParcelPoint[]=[],dz=100;let temp=this.config.surfaceTemp+.5,q=this.config.rhSurface/100*this.qsat(temp,0),saturated=false,lcl:number|null=null,lfc:number|null=null,el:number|null=null,cape=0,cin=0;for(let z=0;z<=H;z+=dz){const sat=this.qsat(temp,z);if(q>=sat){saturated=true;q=sat;if(lcl===null)lcl=z/1000}const tv=(temp+273.15)*(1+.61*q),envT=this.temperatureEnv(z),envTv=(envT+273.15)*(1+.61*this.qEnv(z)),b=G*(tv-envTv)/envTv;if(lcl!==null&&lfc===null&&b>0)lfc=z/1000;if(lfc!==null&&el===null&&b<=0&&z/1000>lfc+.2)el=z/1000;if(lfc===null&&b<0)cin+=-b*dz;if(lfc!==null&&el===null&&b>0)cape+=b*dz;profile.push({z:z/1000,env:envT,dew:this.dewpoint(this.qEnv(z),z),parcel:temp,buoyancy:b});if(saturated){const tk=temp+273.15,gamma=G*(1+LV*sat/(RD*tk))/(CP+LV*LV*sat*EPS/(RD*tk*tk));temp-=gamma*dz}else temp-=.0098*dz;const mix=clamp(this.config.entrainment*.006,0,.02);temp=lerp(temp,this.temperatureEnv(z+dz),mix);q=lerp(q,this.qEnv(z+dz),mix)}
    const wind:WindPoint[]=[];for(let z=0;z<=10_000;z+=250){const[u,v]=this.windUV(z);wind.push({z:z/1000,u,v})}
    let freezing:number|null=null;for(let z=0;z<=H;z+=25)if(this.temperatureEnv(z)<=0){freezing=z/1000;break}
    return{profile,wind,cape,cin,lcl,lfc,el,freezing}}
  private dewpoint(q:number,z:number){const e=Math.max(1,q*this.pressureAt(z)/(EPS+q)),l=Math.log(e/611.2);return 243.5*l/(17.67-l)}
  sounding(){return this.cachedParcel}
  private updateLevels(){const lv=[this.cachedParcel.lcl,this.cachedParcel.lfc,this.cachedParcel.el];this.levelHelpers.forEach((h,i)=>{h.visible=lv[i]!==null;if(lv[i]!==null)h.position.y=lv[i]!});this.freezingHelper.position.y=this.cachedParcel.freezing??0}
  private countCores(){const mask=new Uint8Array(NX*NY);for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){let active=false;for(let z=3;z<Math.min(NZ-2,11);z++){const i=this.idx(x,y,z);if(this.w[i]>2&&this.cloud[i]>.00007){active=true;break}}mask[x+NX*y]=active?1:0}let cores=0;const stack:number[]=[];for(let i=0;i<mask.length;i++){if(mask[i]!==1)continue;cores++;mask[i]=2;stack.push(i);while(stack.length){const a=stack.pop()!,x=a%NX,y=Math.floor(a/NX);for(const b of [mod(x+1,NX)+NX*y,mod(x-1,NX)+NX*y+x*0,x+NX*mod(y+1,NY),x+NX*mod(y-1,NY)])if(mask[b]===1){mask[b]=2;stack.push(b)}}}return cores}
  diagnostics(){let up=0,down=0,rainRate=0,top=0,coldMax=0,thermalTop=0,maxCloud=0;for(let z=0;z<NZ;z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){const i=this.idx(x,y,z),alt=z*DZ;up=Math.max(up,this.w[i]);down=Math.max(down,-this.w[i]);rainRate=Math.max(rainRate,this.rain[i]*12000);maxCloud=Math.max(maxCloud,this.cloud[i]);if(this.cloud[i]>.00007)top=Math.max(top,alt/1000);if(this.w[i]>.6)thermalTop=Math.max(thermalTop,alt/1000);if(alt<1500)coldMax=Math.max(coldMax,this.cold[i])}const cores=this.countCores(),shear=Math.hypot(...[this.windUV(6000)[0]-this.windUV(0)[0],this.windUV(6000)[1]-this.windUV(0)[1]] as [number,number]),cellType=coldMax>7&&up<2?'Outflow-dominant':cores>=3?'3D-мультиячейка':cores===2?'Две взаимодействующие ячейки':cores===1&&shear>18?'Наклонённая организованная ячейка':cores===1?'Одиночная 3D-ячейка':top>1?'Развивающийся 3D cumulus':'Термики пограничного слоя',cellReason=cores?`${cores} пространственно разделённых updraft-ядра`:'глубокое ядро ещё не сформировано';let logic='Трёхмерные термики перераспределяют тепло и влагу в пограничном слое.';if(top>=(this.cachedParcel.lcl??99))logic='На LCL объём воздуха насыщается; сухое вовлечение размывает края облака.';if(top>=(this.cachedParcel.lfc??99))logic='Выше LFC updraft ускоряется в объёме и наклоняется векторным сдвигом ветра.';if(top>=(this.cachedParcel.el??99)-.6)logic='У EL плавучесть исчезает: поток расходится во всех горизонтальных направлениях, формируя наковальню.';if(coldMax>3)logic+=coldMax>7?' Холодный купол подтекает под inflow и уничтожает исходное ядро.':' 3D gust front поднимает тёплый воздух на периферии cold pool.';if(this.microburstOutflow>8)logic+=' Нагруженный осадками downdraft создал радиально расходящийся микропорыв.';return{...this.cachedParcel,updraft:up,downdraft:down,rain:rainRate,cloudTop:top,thermalTop,cloudWater:maxCloud*1000,coldPool:coldMax,microburst:this.microburstOutflow,cellType,cellReason,logic,insolation:this.insolation(),sunElevation:Math.asin(clamp(this.sunDirection().y,-1,1))*180/Math.PI}}

  render(){const width=Math.max(2,this.canvas.clientWidth),height=Math.max(2,this.canvas.clientHeight);if(this.canvas.width!==Math.floor(width*Math.min(devicePixelRatio,1.5))||this.canvas.height!==Math.floor(height*Math.min(devicePixelRatio,1.5))){this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix()}
    const field=this.field==='composite'?null:this.field
    this.updateSun();this.updateVolume();if(field)this.updateFieldTexture(field)
    this.volumeMaterial.uniforms.uOpacity.value=field?.22:1
    this.fieldMesh.visible=!!field&&this.showFieldVolume;this.sliceH.visible=this.sliceV.visible=!!field
    this.shared.uSliceOn.value=field?1:0;this.shared.uSliceH.value=this.sliceH.position.y=this.sliceHeight;this.shared.uSliceZ.value=this.sliceV.position.z=-this.sliceNorth
    this.flowPoints.visible=this.showVectors;this.vectorLines.visible=this.showVectors;
    this.precipPoints.visible=this.showPrecip;this.freezingHelper.visible=this.showPrecip&&this.cachedParcel.freezing!==null
    if(this.showPrecip){this.syncPrecip();this.precipMaterial.uniforms.uScale.value=this.renderer.getDrawingBufferSize(new THREE.Vector2()).y*.5}if(this.showVectors&&this.frame%4===0)this.updateVectors();this.frame++;this.controls.update();this.renderer.render(this.scene,this.camera)}
}
