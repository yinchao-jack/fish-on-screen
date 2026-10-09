import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ============================================================
// 配置：76 节骨骼，前躯干稀疏（14 节、近刚性），尾部加密（62 节）
// 依据：斗鱼巡航靠前半身保持稳定，推进主要靠尾柄与尾鳍摆动
// ============================================================
const HEAD_Z = 0.86;
const MID_Z  = 0.05;
const TAIL_Z = -0.90;
const N_HEAD = 14;
const N_TAIL = 62;
const BONE_COUNT = N_HEAD + N_TAIL;   // 76 条主脊柱骨骼
const APPENDAGE_COUNT = 8;             // 左右胸鳍 + 背/腹鳍三段支链
const TOTAL_BONE_COUNT = BONE_COUNT + APPENDAGE_COUNT; // 84 条蒙皮骨骼

const spineZ = new Float32Array(BONE_COUNT);
for (let i = 0; i < N_HEAD; i++) spineZ[i] = HEAD_Z - (HEAD_Z - MID_Z) * (i / N_HEAD);
for (let j = 1; j <= N_TAIL; j++) spineZ[N_HEAD + j - 1] = MID_Z - (MID_Z - TAIL_Z) * (j / N_TAIL);

const segLen = new Float32Array(BONE_COUNT - 1);
const cumLen = new Float32Array(BONE_COUNT);
for (let i = 0; i < BONE_COUNT - 1; i++) {
  segLen[i] = spineZ[i] - spineZ[i + 1];
  cumLen[i + 1] = cumLen[i] + segLen[i];
}
const TOTAL_LEN = cumLen[BONE_COUNT - 1];

const SUBSTEPS = 24;
const FISH_SCALE = 0.5;    // 鱼体积缩小
// Camera-aware safety bounds in simulation coordinates; destinations use the full viewport.
const TANK_CENTER = new THREE.Vector3(0, -0.1, 0);
const TANK_RADII  = new THREE.Vector3(2.6, 1.5, 1.8);

const params = { tailFlex: 1.0, swim: 0.85, drag: 1.0 };

window.__errors = [];
addEventListener('error', (e) => window.__errors.push(String(e.message)));

// ============================================================
// 渲染器 / 场景 / 相机
// ============================================================
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x071e32, 0.025);
const windowScene = new THREE.Group();
const plantScene = new THREE.Group();
scene.add(windowScene, plantScene);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0.2, 0.1, 3.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, -0.05, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.8;
controls.maxDistance = 7;
controls.enablePan = false;
controls.enableRotate = false;   // 视角固定：左键按下不旋转
controls.maxPolarAngle = 1.65;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new THREE.HemisphereLight(0x25304d, 0x100c14, 0.75));
// 正面补光压暗（整体背光）
const keyLight = new THREE.DirectionalLight(0xe0eaf5, 0.45);
keyLight.position.set(-4, 3.5, 1.5);
scene.add(keyLight);
// 粉色轮廓光（右后）
const rimLight = new THREE.DirectionalLight(0xf0e6ea, 0.9);
rimLight.position.set(3, 1.5, -3.5);
scene.add(rimLight);
// 蓝色轮廓光（左后）
const rimLight2 = new THREE.DirectionalLight(0xe0ecf2, 0.8);
rimLight2.position.set(-3, 2, -3);
scene.add(rimLight2);
// 顶部射灯（展厅吊灯感，压暗）
const pendant = new THREE.SpotLight(0xfff2dd, 0.6, 14, 0.55, 0.9, 1.2);
pendant.position.set(0.5, 5, 0.5);
pendant.target.position.set(0, -0.2, 0);
scene.add(pendant, pendant.target);
const fillLight = new THREE.DirectionalLight(0xa8b8bc, 0.24);
fillLight.position.set(3, 1, 2.5);
scene.add(fillLight);

// ============================================================
// 焦散函数（经典迭代，输入需大偏移避免发散）
// ============================================================
const CAUSTIC_GLSL = /* glsl */`
  float caustic(vec2 uv, float t) {
    vec2 p = mod(uv, 6.2831853) - 250.0;
    vec2 i = p;
    float c = 1.0;
    float inten = 0.005;
    for (int n = 0; n < 4; n++) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
    }
    c /= 4.0;
    c = 1.17 - pow(c, 1.4);
    return clamp(pow(abs(c), 7.0), 0.0, 1.5);
  }
`;

// ============================================================
// 背景：深青黑渐变穹顶
// ============================================================
{
  const bgMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 top = vec3(0.025, 0.13, 0.22);
        vec3 mid = vec3(0.009, 0.055, 0.12);
        vec3 bot = vec3(0.005, 0.018, 0.05);
        vec3 col = h > 0.0 ? mix(mid, top, pow(h, 0.8))
                           : mix(mid, bot, pow(-h, 0.6));
        vec3 winDir = normalize(vec3(-0.55, 0.3, -0.75));
        float glow = pow(max(dot(d, winDir), 0.0), 5.0);
        col += vec3(0.5, 0.55, 0.8) * glow * 0.06;
        float n = fract(sin(dot(d.xy * 411.0, vec2(12.9898, 78.233))) * 43758.5453);
        col += (n - 0.5) * 0.008;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(35, 32, 24), bgMat));
}

// ============================================================
// 第一层：路人视频背景（高斯模糊/颗粒/色散预处理过）
// ============================================================
{
  const vid = document.getElementById('bgvid');
  vid.preload = 'auto';

  const vidTex = new THREE.VideoTexture(vid);
  vidTex.colorSpace = THREE.SRGBColorSpace;
  vidTex.repeat.set(0.8, 0.78);
  vidTex.offset.set(0.1, 0.22);
  const vidMat = new THREE.MeshBasicMaterial({ fog: false });

  // 海报帧兜底（视频未加载前显示；后台标签页媒体延迟加载时也能出画面）
  new THREE.TextureLoader().load('./bg_poster.jpg', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.repeat.set(0.8, 0.78);
    t.offset.set(0.1, 0.22);
    if (!vidMat.map) { vidMat.map = t; vidMat.needsUpdate = true; }
  });
  const useVideo = () => { vidMat.map = vidTex; vidMat.needsUpdate = true; };
  vid.addEventListener('playing', useVideo);
  if (!vid.paused && vid.readyState >= 2) useVideo();
  const tryPlay = () => vid.play().catch(() => {});
  tryPlay();
  addEventListener('pointermove', tryPlay);

  const vidPlane = new THREE.Mesh(new THREE.PlaneGeometry(18, 9), vidMat);
  vidPlane.position.set(0, 0.4, -9);
  windowScene.add(vidPlane);
}

// ============================================================
// 第二层：现代铝框窗墙（Sketchfab 模型，纯黑背光）
// ============================================================
const windowWall = new THREE.Group();
windowScene.add(windowWall);
windowScene.visible = false;
{
  const frameBlack = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
  const glassDark = new THREE.MeshBasicMaterial({
    color: 0x0a1018, transparent: true, opacity: 0.06, depthWrite: false, fog: false,
  });
  new GLTFLoader().load('./alu_window.glb', (gltf) => {
    const proto = gltf.scene;
    proto.traverse((o) => {
      if (!o.isMesh) return;
      const matName = (o.material && o.material.name || '').toLowerCase();
      o.material = matName.includes('glass') ? glassDark : frameBlack;
    });
    // 模型 2 高 × 1.29 宽（Z 朝前）：横排 4 扇组成窗墙
    const S = 2.9;
    for (let i = 0; i < 4; i++) {
      const w = proto.clone();
      w.scale.setScalar(S);
      w.rotation.y = Math.PI / 2 + (i % 2) * Math.PI;   // 面向相机 + 交替镜像
      w.position.set((i - 1.5) * 1.29 * S, -0.3, -4.5 - (i % 2) * 0.02);
      windowWall.add(w);
    }
  });
}

// ============================================================
// 角落水草装饰（Sketchfab Pond Weed，保留原贴图）
// ============================================================
{
  new GLTFLoader().load('./pond_weed.glb', (gltf) => {
    const proto = gltf.scene;
    proto.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material.roughness = 0.9;
        o.material.envMapIntensity = 0.25;
        if ('emissive' in o.material) { o.material.emissive = new THREE.Color(0x16301c); o.material.emissiveIntensity = 0.35; }
      }
    });
    const spots = [
      { x: -2.55, y: -2.5, z: -1.3, s: 1.6, ry: 0.4 },
      { x: 2.65, y: -2.5, z: -1.2, s: 1.4, ry: -2.2 },
      { x: 1.9, y: -2.55, z: -2.3, s: 1.1, ry: 1.1 },
    ];
    for (const p of spots) {
      const w = proto.clone();
      w.scale.setScalar(p.s);
      w.position.set(p.x, p.y, p.z);
      w.rotation.x = -Math.PI / 2;   // Z-up 模型立起
      w.rotation.z = p.ry;
      plantScene.add(w);
    }
  });
}

// 顶部水面（飘动、带反射光）
let topWaterMat;
let waterSurface;
{
  topWaterMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec2 vXZ;
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vXZ = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec2 vXZ;
      varying vec3 vWorld;
      ${CAUSTIC_GLSL}
      void main() {
        float c = caustic(vXZ * 0.8, uTime * 0.6) + caustic(vXZ * 0.45 + 7.3, uTime * 0.4);
        // 远处（-z）更亮，近处渐隐 → 水面纵深反射感
        float depthGlow = smoothstep(3.0, -4.0, vWorld.z);
        // 横向亮带（水线反光）
        float band = smoothstep(0.55, 1.0, 1.0 - abs(vWorld.z + 0.5) * 0.28);
        vec3 col = vec3(1.0, 0.85, 0.6) * c * 1.3
                 + vec3(0.9, 0.95, 1.0) * band * 0.28;
        float a = clamp(c * 1.1 + band * 0.3, 0.0, 1.0) * depthGlow;
        gl_FragColor = vec4(col * depthGlow * 0.35, a * 0.35);
      }`,
  });
  const surf = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), topWaterMat);
  waterSurface = surf;
  surf.rotation.x = Math.PI / 2;
  surf.position.set(0, 1.25, -1.0);
  scene.add(surf);
}

// 水体光柱（微弱）
const rayPlanes = [];
{
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 256;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(64, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 64; x++) {
      const t01 = y / 255;
      const a = Math.pow(Math.max(0, Math.sin(Math.min(t01 * 1.15, 1) * Math.PI)), 1.2)
              * (1 - t01) * 1.6
              * Math.pow(Math.sin((x / 63) * Math.PI), 1.5);
      const i = (y * 64 + x) * 4;
      img.data[i] = 235; img.data[i + 1] = 230; img.data[i + 2] = 250;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  for (let i = 0; i < 3; i++) {
    const m = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.06,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.9 + Math.random() * 0.8, 6.5), m);
    p.position.set(-2.5 + i * 2.0, 1.0, -2.2 - Math.random() * 2);
    p.rotation.z = 0.3;
    p.rotation.y = -0.4 + i * 0.35;
    p.userData.phase = Math.random() * 6;
    p.userData.baseX = p.position.x;
    rayPlanes.push(p);
    scene.add(p);
  }
}

// Soft circular particles avoid square point sprites and harsh edge pixels.
function makeParticleMap(bubble=false) {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
  const ctx=canvas.getContext('2d');
  const gradient=ctx.createRadialGradient(32,32,0,32,32,30);
  gradient.addColorStop(0,bubble?'rgba(255,255,255,0.03)':'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.48,bubble?'rgba(255,255,255,0.08)':'rgba(255,255,255,0.4)');
  gradient.addColorStop(0.68,bubble?'rgba(255,255,255,0.5)':'rgba(255,255,255,0.12)');
  gradient.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,64,64);
  return new THREE.CanvasTexture(canvas);
}
// 浮游微粒（开阔水体）
let plankton, planktonBase;
{
  const N = 380;
  planktonBase = new Float32Array(N * 3);
  const posArr = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    planktonBase[i * 3]     = (Math.random() - 0.5) * 7;
    planktonBase[i * 3 + 1] = -1.8 + Math.random() * 3.6;
    planktonBase[i * 3 + 2] = (Math.random() - 0.5) * 5;
  }
  posArr.set(planktonBase);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  plankton = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0xc9e4ee, size: 0.018, map:makeParticleMap(), alphaTest:0.005, transparent: true, opacity: 0.32,
    depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(plankton);
}

// 气泡
let bubbles, bubbleData;
{
  const N = 26;
  bubbleData = [];
  const posArr = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    bubbleData.push({
      x: (Math.random() - 0.5) * 3,
      y: -1.8 + Math.random() * 3.2,
      z: (Math.random() - 0.5) * 3,
      v: 0.2 + Math.random() * 0.3,
      ph: Math.random() * 7,
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  bubbles = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0xd8eff7, size: 0.038, map:makeParticleMap(true), alphaTest:0.005, transparent: true, opacity: 0.25,
    depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(bubbles);
}

// ============================================================
// 后期：辉光 + 全屏"鱼缸透镜"折射 + 复古调色
// ============================================================
const gradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
    uExposure: { value: 1.0 },
    uShoulder: { value: 1.0 },
    uLightStyle: { value: 0 },
    uRipples: { value: Array.from({length:6},()=>new THREE.Vector4(-10,-10,-10,0)) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform vec2 uTexel;
    uniform float uExposure;
    uniform float uShoulder;
    uniform float uLightStyle;
    uniform vec4 uRipples[6];
    varying vec2 vUv;

    // 球形水面折射（桶形放大）：f(r) 随半径增长
    vec2 barrel(vec2 uv, float amt) {
      vec2 cc = uv - 0.5;
      cc.x *= uAspect;
      float r2 = dot(cc, cc) / max(1.0, uAspect * uAspect);
      float f = 1.0 + r2 * amt + r2 * r2 * amt * 1.8;
      cc *= f;
      cc.x /= uAspect;
      return cc + 0.5;
    }

    vec4 sampleScene(vec2 uv) {
      vec2 inset = uTexel * 0.5;
      return texture2D(tDiffuse, clamp(uv, inset, vec2(1.0)-inset));
    }
    void main() {
      vec2 cc = vUv - 0.5;
      cc.x *= uAspect;
      float r = length(cc);
      float edge = smoothstep(0.12, 0.9, r);

      // Thin transparent water rings refract the scene beneath them. The
      // centre stays clear; highlights and darker troughs sit on the wave rim.
      vec2 waterUV=vUv;
      float rippleLight=0.0,rippleShade=0.0;
      for(int i=0;i<6;i++) {
        float age=uTime-uRipples[i].z;
        if(uRipples[i].w>0.0 && age>=0.0 && age<2.3) {
          vec2 delta=(vUv-uRipples[i].xy)*vec2(uAspect,1.0);
          float distance=length(delta);
          vec2 direction=delta/max(distance,0.0001);
          for(int j=0;j<3;j++) {
            float phase=age-float(j)*0.20;
            if(phase>0.0) {
              float radius=0.012+phase*0.12;
              float d=distance-radius;
              float width=0.0035+phase*0.0018;
              float envelope=smoothstep(0.0,0.12,phase)*(1.0-smoothstep(0.60,2.1,phase))/(1.0+float(j)*0.35);
              float ridge=exp(-d*d/(width*width));
              waterUV+=direction/vec2(uAspect,1.0)*ridge*sign(d)*0.0018*envelope;
              float sun=0.60+0.40*dot(direction,normalize(vec2(-0.45,0.8)));
              rippleLight+=ridge*envelope*sun;
              float trough=exp(-pow((d+width*1.6)/width,2.0));
              rippleShade+=trough*envelope;
            }
          }
        }
      }

      // Inward lens distortion stays inside the rendered image. The original
      // outward distortion crossed the border; CLAMP_TO_EDGE stretched bright
      // boundary particles into flickering horizontal/vertical lines.
      float amt = -0.025;
      vec2 uvC = barrel(waterUV, amt);
      // 色差：边缘色散
      vec2 caDir = normalize(cc + 1e-6);
      float borderDistance = min(min(vUv.x,1.0-vUv.x),min(vUv.y,1.0-vUv.y));
      vec2 ca = caDir * (0.00025 + 0.0010 * edge * edge) * smoothstep(0.0,0.06,borderDistance);
      vec3 col;
      col.r = sampleScene(barrel(waterUV + ca, amt)).r;
      col.g = sampleScene(uvC).g;
      col.b = sampleScene(barrel(waterUV - ca, amt)).b;

      col*=1.0-min(rippleShade,1.2)*0.075;
      col+=vec3(0.024,0.052,0.055)*min(rippleLight,1.3);

      // Shared spectral shafts illuminate every scene, including the window.
      // Each beam sweeps a different area and splits gently at its edges.
      vec3 spectral=vec3(0.0);
      float lighting=0.0;
      for(int i=0;i<4;i++) {
        float fi=float(i);
        float center=0.06+fi*0.29+sin(uTime*0.19+fi*1.8)*0.14;
        float slope=0.20*sin(uTime*0.12+fi*1.6);
        float dx=vUv.x-center-(1.0-vUv.y)*slope;
        float width=0.017+(1.0-vUv.y)*0.055;
        float spread=0.004+(1.0-vUv.y)*0.012;
        float pulse=0.50+0.35*sin(uTime*0.37+fi*2.1);
        spectral+=vec3(exp(-pow((dx-spread)/width,2.0)),exp(-pow(dx/width,2.0)),exp(-pow((dx+spread)/width,2.0)))*pulse;
        lighting+=exp(-pow(dx/(width*2.0),2.0))*pulse;
      }
      float topLight=pow(vUv.y,2.4);
      vec3 lightTint=uLightStyle==1.0?vec3(0.64,1.0,0.86):uLightStyle==2.0?vec3(0.84,0.77,1.0):uLightStyle==4.0?vec3(1.0,0.92,0.79):vec3(0.67,0.91,1.0);
      col*=1.0+min(lighting,2.0)*topLight*0.10;
      col+=spectral*lightTint*topLight*0.027;

      // 曝光 + 高对比 S 曲线 + 饱和度
      col *= 1.02;
      // 对比 S 曲线已关闭（保护贴图）
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      // 饱和度提升已关闭（保护贴图本色）

      // 分离色调：阴影偏蓝、高光偏粉橙（涩谷港风）
      col += (0.5 - lum) * vec3(0.002, 0.001, 0.012);
      col += smoothstep(0.5, 1.0, lum) * vec3(0.030, 0.010, 0.020);

      // 胶片躁点（暗部更明显）
      float gr = fract(sin(dot(vUv * 913.7 + mod(uTime * 7.0, 100.0), vec2(12.9898, 78.233))) * 43758.5453);
      col += (gr - 0.5) * 0.007;

      // 边缘水色渐变 + 暗角
      col = mix(col, vec3(0.24, 0.10, 0.30), edge * edge * 0.05);
      col *= 1.0 - edge * edge * 0.34;

      // 曝光 + 高光软肩（ACES 近似）：>1 的线性值平滑收肩，不再硬裁成纯白
      col *= uExposure;
      if (uShoulder > 0.001) {
        vec3 aces = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
        col = mix(col, aces, uShoulder);
      }

      // 线性 → sRGB
      col = pow(max(col, 0.0), vec3(1.0 / 2.2));
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// 后期链：场景 → 辉光 → 调色
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.3,    // 强度：只留水面微光
  0.55,   // 半径
  0.95    // 阈值：只让水面焦散发光，鱼的高光不进 bloom
);
// bloomPass 关闭：保持贴图本色
// composer.addPass(bloomPass);
const gradePass = new ShaderPass(gradeShader);
composer.addPass(gradePass);

function updateRTSize() {
  const pr = renderer.getPixelRatio();
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  gradePass.uniforms.uAspect.value = innerWidth / innerHeight;
  gradePass.uniforms.uTexel.value.set(1 / (innerWidth * pr), 1 / (innerHeight * pr));
}
updateRTSize();

function createFishRig(sourceGeometry, baseMaterial, palette) {
const bones = [];
let skinnedMesh = null;
let skeletonHelper = null;

const finBones = [];

function buildSkeleton() {
  const root = new THREE.Bone();
  root.name = 'Spine_00_Head';
  root.position.set(0, 0, spineZ[0]);
  bones.push(root);
  let prev = root;
  for (let i = 1; i < BONE_COUNT; i++) {
    const b = new THREE.Bone();
    b.name = `Spine_${String(i).padStart(2, '0')}`;
    b.position.set(0, 0, -segLen[i - 1]);
    prev.add(b);
    bones.push(b);
    prev = b;
  }

  // 独立鳍部支链：胸鳍左右分开；背/腹鳍仿尾扇——Root/Tip 同点共挂同一脊柱节，
  // 仅旋转相位不同，膜片在两根骨间渐变蒙皮时不会产生跨脊柱塌陷（杜绝黑破面）
  const addFin = (name, parentIndex, position) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.copy(position);
    bones[parentIndex].add(b);
    bones.push(b);
    finBones.push(b);
    return b;
  };
  addFin('Pectoral_L', 4, new THREE.Vector3(-0.28, 0.02, 0));
  addFin('Pectoral_R', 4, new THREE.Vector3(0.28, 0.02, 0));
  addFin('Dorsal_Root', 7, new THREE.Vector3(0, 0.34, 0));
  addFin('Dorsal_Tip', 7, new THREE.Vector3(0, 0.34, 0));
  addFin('Ventral_Root', 7, new THREE.Vector3(0, -0.34, 0));
  addFin('Ventral_Tip', 7, new THREE.Vector3(0, -0.34, 0));
  addFin('Caudal_Upper', 48, new THREE.Vector3(0, 0.12, 0));
  addFin('Caudal_Lower', 48, new THREE.Vector3(0, -0.12, 0));
  return root;
}

function spineParam(z) {
  if (z >= spineZ[0]) return 0;
  if (z <= spineZ[BONE_COUNT - 1]) return BONE_COUNT - 1;
  let lo = 0, hi = BONE_COUNT - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spineZ[mid] >= z && z >= spineZ[mid + 1]) { lo = mid; break; }
    if (z > spineZ[mid]) hi = mid - 1; else lo = mid + 1;
  }
  const f = (spineZ[lo] - z) / (spineZ[lo] - spineZ[lo + 1]);
  return lo + THREE.MathUtils.clamp(f, 0, 1);
}

// 结构化刷权重：体块分区 + 全边界渐变（smoothstep 交叉淡化）
// body = 躯干核心；caudal = 尾柄/尾扇；dorsal/ventral = 背腹鳍；pectoral = 左右胸鳍
// 原则：任何体块交界处（鳍-躯干、鳍根-鳍尖、尾扇上下、胸鳍左右）相邻顶点必须共享
// 骨骼影响，权重随空间位置连续变化，旋转/摆动时才不会拉丝。
function paintWeights(geometry) {
  const count = geometry.attributes.position.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const posAttr = geometry.attributes.position;
  const add = (items, bone, weight) => {
    if (weight > 1e-5) items.push([bone, weight]);
  };
  // 脊柱余量按 u 线性拆给相邻两节，避免 round(u) 硬切
  const addSpine = (items, u, w) => {
    if (w <= 1e-5) return;
    const base = Math.min(Math.floor(u), BONE_COUNT - 1);
    const f = THREE.MathUtils.clamp(u - base, 0, 1);
    add(items, base, w * (1 - f));
    if (base + 1 <= BONE_COUNT - 1) add(items, base + 1, w * f);
  };
  const write = (v, items) => {
    const merged = new Map();
    for (const [bone, weight] of items) merged.set(bone, (merged.get(bone) || 0) + weight);
    const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = sorted.reduce((a, x) => a + x[1], 0);
    if (sum < 1e-8) { sorted.push([0, 1]); sum = 1; }
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = sorted[k]?.[0] || 0;
      skinWeight[v * 4 + k] = (sorted[k]?.[1] || 0) / sum;
    }
  };

  for (let v = 0; v < count; v++) {
    const x = posAttr.getX(v), y = posAttr.getY(v), z = posAttr.getZ(v);
    const u = spineParam(z);
    const tailness = THREE.MathUtils.clamp((0.45 - z) / (0.45 - TAIL_Z), 0, 1);
    const radial = Math.hypot(x / 0.34, y / 0.38);
    // 外层叶片与躯干的缝合带：缝合区躯干影响连续淡出、鳍部影响连续淡入
    const outer = THREE.MathUtils.smoothstep(radial, 0.72, 1.16);
    const core = 1 - outer;
    const items = [];

    // 躯干：高斯核（本身渐变），σ 随尾部加长让尾柄更柔
    const bodySigma = 0.34 + tailness * 0.5;
    const bodyBase = Math.floor(u);
    for (let k = 0; k < 4; k++) {
      const bi = THREE.MathUtils.clamp(bodyBase - 1 + k, 0, BONE_COUNT - 1);
      add(items, bi, core * Math.exp(-Math.pow((u - bi) / bodySigma, 2) * 0.5));
    }

    // 尾扇：上下支链按 y 渐变分面（中线附近两根尾扇骨共享权重）
    const caudalMask = outer * THREE.MathUtils.smoothstep(tailness, 0.28, 0.62);
    if (caudalMask > 0.02) {
      const upW = THREE.MathUtils.smoothstep(y, -0.06, 0.06);
      const local = THREE.MathUtils.clamp((u - N_HEAD) / Math.max(1, N_TAIL - 1), 0, 1);
      const finW = caudalMask * (0.72 + 0.20 * local);
      add(items, BONE_COUNT + 6, finW * upW);        // Caudal_Upper
      add(items, BONE_COUNT + 7, finW * (1 - upW));  // Caudal_Lower
      addSpine(items, u, caudalMask * 0.28);
    }

    // 背/腹鳍：仿尾扇——Root/Tip 同点共挂，按 y（基部→末端）渐变分面，
    // 两根骨仅旋转相位不同，膜片混合永不跨脊柱塌陷
    const dorsalMask = outer * THREE.MathUtils.smoothstep(y, 0.18, 0.52) * (1 - caudalMask * 0.5);
    const ventralMask = outer * THREE.MathUtils.smoothstep(-y, 0.18, 0.52) * (1 - caudalMask * 0.5);
    if (dorsalMask > 0.02) {
      const tipW = THREE.MathUtils.smoothstep(y, 0.30, 0.50);
      add(items, BONE_COUNT + 2, dorsalMask * 0.82 * (1 - tipW)); // Dorsal_Root（基部）
      add(items, BONE_COUNT + 3, dorsalMask * 0.82 * tipW);       // Dorsal_Tip（末端）
      addSpine(items, u, dorsalMask * 0.18);
    }
    if (ventralMask > 0.02) {
      const tipW = THREE.MathUtils.smoothstep(-y, 0.30, 0.50);
      add(items, BONE_COUNT + 4, ventralMask * 0.82 * (1 - tipW)); // Ventral_Root（基部）
      add(items, BONE_COUNT + 5, ventralMask * 0.82 * tipW);       // Ventral_Tip（末端）
      addSpine(items, u, ventralMask * 0.18);
    }

    // 胸鳍：左右按 x 渐变（近身体中线处两骨共享），z 向根部缝合
    const pectoralMask = THREE.MathUtils.smoothstep(Math.abs(x), 0.20, 0.42)
      * THREE.MathUtils.smoothstep(z, -0.05, 0.52) * (1 - Math.min(1, Math.abs(y) / 0.5));
    if (pectoralMask > 0.02) {
      const rightW = THREE.MathUtils.smoothstep(x, -0.04, 0.04);
      add(items, BONE_COUNT + 0, pectoralMask * 0.86 * (1 - rightW)); // Pectoral_L
      add(items, BONE_COUNT + 1, pectoralMask * 0.86 * rightW);       // Pectoral_R
      addSpine(items, u, pectoralMask * 0.14);
    }
    write(v, items);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
}

// ============================================================
// XPBD 粒子链
// ============================================================
const pos = [];
const prev = [];
const accel = [];
const ups = [];
const bendAlpha = new Float32Array(BONE_COUNT - 2);
const bendLambda = new Float32Array(BONE_COUNT - 2);
const angleLimitDmin = new Float32Array(BONE_COUNT - 2);

function initParticles() {
  pos.length = prev.length = accel.length = ups.length = 0;
  for (let i = 0; i < BONE_COUNT; i++) {
    pos.push(new THREE.Vector3(0, 0, spineZ[i]));
    prev.push(new THREE.Vector3(0, 0, spineZ[i]));
    accel.push(new THREE.Vector3());
    ups.push(new THREE.Vector3(0, 1, 0));
  }
}
initParticles();

for (let i = 0; i < BONE_COUNT - 2; i++) {
  bendAlpha[i] = i < N_HEAD
    ? 1.5e-6
    : THREE.MathUtils.lerp(1e-5, 7e-4, Math.pow((i - N_HEAD) / (BONE_COUNT - 3 - N_HEAD), 1.2));
}
for (let i = 0; i < BONE_COUNT - 2; i++) {
  const t = i / (BONE_COUNT - 3);
  const maxAng = THREE.MathUtils.lerp(0.05, 0.20, Math.pow(t, 1.6));
  const L1 = segLen[i], L2 = segLen[i + 1];
  angleLimitDmin[i] = Math.sqrt(L1 * L1 + L2 * L2 + 2 * L1 * L2 * Math.cos(maxAng));
}

function solveDistance(i, j, restLen, alpha, h, lambdaArr, lambdaSlot) {
  const p1 = pos[i], p2 = pos[j];
  const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-9) return;
  const C = d - restLen;
  const alphaTilde = alpha / (h * h);
  let dl = (-C - alphaTilde * (lambdaArr ? lambdaArr[lambdaSlot] : 0)) / (2 + alphaTilde);
  const nx = dx / d, ny = dy / d, nz = dz / d;
  p1.x -= dl * nx; p1.y -= dl * ny; p1.z -= dl * nz;
  p2.x += dl * nx; p2.y += dl * ny; p2.z += dl * nz;
  if (lambdaArr) lambdaArr[lambdaSlot] += dl;
}

// 非相邻粒子球排斥：身体不会穿过自己（掉头防破模）
function solveSelfCollision() {
  for (let i = 0; i < BONE_COUNT; i++) {
    for (let j = i + 8; j < BONE_COUNT; j++) {
      const arc = cumLen[j] - cumLen[i];
      const minD = Math.min(0.11, arc * 0.62);
      const p1 = pos[i], p2 = pos[j];
      const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minD * minD && d2 > 1e-12) {
        const d = Math.sqrt(d2);
        const corr = (minD - d) / (2 * d);
        p1.x -= dx * corr; p1.y -= dy * corr; p1.z -= dz * corr;
        p2.x += dx * corr; p2.y += dy * corr; p2.z += dz * corr;
      }
    }
  }
}

function solveAngleLimit(i) {
  const p1 = pos[i], p2 = pos[i + 2];
  const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const dmin = angleLimitDmin[i];
  if (d >= dmin || d < 1e-9) return;
  const corr = (dmin - d) / (2 * d);
  p1.x -= dx * corr; p1.y -= dy * corr; p1.z -= dz * corr;
  p2.x += dx * corr; p2.y += dy * corr; p2.z += dz * corr;
}

const headTarget = new THREE.Vector3(0, 0, HEAD_Z);
const headTargetSmooth = new THREE.Vector3(0, 0, HEAD_Z);
let dragging = false;
let commanded = false;
let commandTTL = 0;
let dashActive = false;
const dashTarget = new THREE.Vector3();
let simTime = Math.random() * 20;
let headSpeedSmooth = 0;

// 真实巡游：随机选点 → 冲刺 → 悬停停留（斗鱼典型行为）
const swimState = {
  point: new THREE.Vector3(0.4, -0.1, 0),
  timer: 3,
};
const _wander = new THREE.Vector3();
const cruiseShift = new THREE.Vector3();
let cruiseLeg = Math.random() * 6;
function chooseCruisePoint() {
  const current = pos[0].clone().multiplyScalar(FISH_SCALE).project(camera);
  // Cross the aquarium in broad, alternating arcs instead of hovering at one point.
  cruiseLeg += 2.05 + Math.random() * 0.75;
  let x = Math.cos(cruiseLeg) * (0.55 + Math.random() * 0.22);
  let y = Math.sin(cruiseLeg * 0.83) * (0.42 + Math.random() * 0.26);
  if (Math.hypot(x-current.x,y-current.y) < 0.65) x = current.x > 0 ? -0.72 : 0.72;
  screenToSwimPoint(x,y,-0.25+Math.random()*0.45,swimState.point).divideScalar(FISH_SCALE);
  swimState.timer = Math.max(9,pos[0].distanceTo(swimState.point)/0.80+3);
}

function updateWander(dt) {
  swimState.timer -= dt;
  if (pos[0].distanceTo(swimState.point) < 0.30 || swimState.timer <= 0) chooseCruisePoint();
  clampToTank(swimState.point,0.80);
  _wander.subVectors(swimState.point,headTarget);
  const distance=_wander.length();
  if(distance>0.001) headTarget.addScaledVector(_wander.normalize(),Math.min(distance,1.05*dt));
}

const _lat = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _revHead = new THREE.Vector3();
const _revTgt = new THREE.Vector3();

function physicsStep(dt) {
  simTime += dt;
  const h = dt / SUBSTEPS;

  commandTTL -= dt;
  if (commanded && (pos[0].distanceTo(dashTarget) < 0.09 || commandTTL <= 0)) {
    commanded = false;
    chooseCruisePoint();
  }
  dragging = commanded;
  dashActive = false;
  if (commanded) headTarget.copy(dashTarget);
  else updateWander(dt);

  {
    _dir.subVectors(headTarget, headTargetSmooth);
    const dist = _dir.length();
    const maxSpeed = dragging ? 3.2 : 1.45;
    if (dist > 1e-6) {
      const step = Math.min(dist, maxSpeed * dt, dist * (1 - Math.exp(-(dashActive ? 22 : dragging ? 11 : 5) * dt)) + maxSpeed * dt);
      headTargetSmooth.addScaledVector(_dir.normalize(), Math.min(step, dist));
    }
  }

  // Transport the whole chain with the current. Moving both positions and
  // Verlet history preserves velocity and every XPBD rest length. The head
  // spring still supplies the turning lead, while fins retain their own motion.
  cruiseShift.subVectors(headTargetSmooth,pos[0]);
  const cruiseDistance=cruiseShift.length();
  if(cruiseDistance>0.16 && Math.hypot(cruiseShift.x,cruiseShift.z)>0.04) {
    const facing=Math.atan2(pos[0].x-pos[7].x,pos[0].z-pos[7].z);
    const desired=Math.atan2(cruiseShift.x,cruiseShift.z);
    const turn=Math.atan2(Math.sin(desired-facing),Math.cos(desired-facing));
    const yaw=THREE.MathUtils.clamp(turn*(1-Math.exp(-2.4*dt)),-1.2*dt,1.2*dt);
    const c=Math.cos(yaw),s=Math.sin(yaw),hx=pos[0].x,hz=pos[0].z;
    // Steer in yaw as a rigid transport, then let XPBD flex the individual fins.
    // Rotating Verlet history too avoids artificial acceleration on each turn.
    for(let i=0;i<BONE_COUNT;i++) {
      for(const p of [pos[i],prev[i]]) {
        const x=p.x-hx,z=p.z-hz;p.x=hx+x*c+z*s;p.z=hz-x*s+z*c;
      }
    }
  }
  if(cruiseDistance>0.16) {
    cruiseShift.multiplyScalar(Math.min(cruiseDistance-0.16,(commanded?1.8:0.86)*dt)/cruiseDistance);
    for(let i=0;i<BONE_COUNT;i++) {pos[i].add(cruiseShift);prev[i].add(cruiseShift);}
  }

  // 掉头检测：目标在正后方 → 头部弹簧变软，避免拖着链条穿自己
  _revHead.subVectors(pos[0], pos[3]).normalize();
  _revTgt.subVectors(headTargetSmooth, pos[0]).normalize();
  const revDot = _revHead.dot(_revTgt);
  const revK = revDot < -0.35 ? 0.35 : 1.0;
  // 反向程度 0→1：>120° 视为掉头
  const revAmount = THREE.MathUtils.smoothstep(-revDot, 0.35, 0.85);
  // 掉头时把目标压到头部水平面：只允许绕竖直轴 yaw 转身（禁止头朝上/朝下翻）
  if (revAmount > 0) {
    headTarget.y = THREE.MathUtils.lerp(headTarget.y, pos[0].y, revAmount);
  }

  const headV = pos[0].distanceTo(prev[0]) / Math.max(h, 1e-5);
  headSpeedSmooth += (Math.min(headV, 3) - headSpeedSmooth) * (1 - Math.exp(-4 * dt));
  const activity = THREE.MathUtils.clamp(headSpeedSmooth * 0.9, 0, 1.6);
  const swimAmp = params.swim * (0.28 + 0.72 * Math.min(activity, 1.3));
  const swimFreq = 4.2 + activity * 2.2;

  for (let s = 0; s < SUBSTEPS; s++) {
    for (let i = 0; i < BONE_COUNT; i++) {
      const a = accel[i].set(0, 0, 0);
      a.y += 0.03;
      const p = pos[i];
      a.x += 0.02 * Math.sin(0.7 * simTime + p.y * 2.0);
      a.z += 0.018 * Math.sin(0.5 * simTime + p.x * 1.5);
      // 怠速时躯干缓慢侧摆（悬停不死板）
      if (cumLen[i] > TOTAL_LEN * 0.2 && cumLen[i] < TOTAL_LEN * 0.6) {
        a.x += 0.05 * Math.sin(simTime * 0.55 + cumLen[i] * 3.0);
      }
      if (i < 3) {
        const w = i === 0 ? 1 : i === 1 ? 0.32 : 0.1;
        const k = (dashActive ? 200 : dragging ? 96 : 26) * w * revK;
        a.x += (headTargetSmooth.x - p.x) * k;
        a.y += (headTargetSmooth.y - p.y) * k;
        a.z += (headTargetSmooth.z - p.z) * k;
      }
      if (cumLen[i] > TOTAL_LEN * 0.42) {
        const tBody = (cumLen[i] - TOTAL_LEN * 0.42) / (TOTAL_LEN * 0.58);
        const amp = swimAmp * Math.pow(tBody, 1.7) * 2.2;
        _dir.subVectors(pos[Math.min(i + 1, BONE_COUNT - 1)], pos[i]).normalize();
        _lat.set(1, 0, 0).addScaledVector(_dir, -_dir.x);
        if (_lat.lengthSq() > 1e-6) {
          _lat.normalize();
          a.addScaledVector(_lat, amp * Math.sin(cumLen[i] * 1.8 - simTime * swimFreq));
        }
      }
    }

    const damp = Math.exp(-3.2 * params.drag * h);
    for (let i = 0; i < BONE_COUNT; i++) {
      const p = pos[i], pr = prev[i], a = accel[i];
      const vx = (p.x - pr.x) * damp;
      const vy = (p.y - pr.y) * damp;
      const vz = (p.z - pr.z) * damp;
      pr.copy(p);
      p.x += vx + a.x * h * h;
      p.y += vy + a.y * h * h;
      p.z += vz + a.z * h * h;
    }

    bendLambda.fill(0);
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < BONE_COUNT - 1; i++) {
        solveDistance(i, i + 1, segLen[i], 0, h);
      }
    }
    for (let i = 0; i < BONE_COUNT - 2; i++) {
      solveDistance(i, i + 2, segLen[i] + segLen[i + 1], bendAlpha[i], h, bendLambda, i);
    }
    for (let i = 4; i < BONE_COUNT; i += 4) {
      solveDistance(0, i, cumLen[i], 2e-3, h);
    }
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < BONE_COUNT - 1; i++) solveDistance(i, i + 1, segLen[i], 0, h);
      if (iter % 2 === 0) { for (let i = 0; i < BONE_COUNT - 2; i++) solveAngleLimit(i); }
      else { for (let i = BONE_COUNT - 3; i >= 0; i--) solveAngleLimit(i); }
    }
    // 掉头期间：前 8 节俯仰角硬限制（dy/节长 ≤ sin25°），身体保持水平转身
    if (revAmount > 0.01) {
      const maxDy = 0.4226;   // sin25°
      for (let i = 0; i < 8; i++) {
        const p1 = pos[i], p2 = pos[i + 1];
        const dy = p2.y - p1.y;
        const lim = segLen[i] * maxDy;
        if (Math.abs(dy) > lim) {
          const excess = (Math.abs(dy) - lim) * 0.5 * Math.sign(dy) * revAmount;
          p1.y += excess; p2.y -= excess;
        }
      }
    }
    solveSelfCollision();

    for (let i = 0; i < BONE_COUNT; i++) {
      const p = pos[i];
      // Rectangular safety volume includes a tail-length buffer. An ellipsoid
      // would cut off all four screen corners and squeeze fins near the border.
      const x=THREE.MathUtils.clamp(p.x,TANK_CENTER.x-TANK_RADII.x,TANK_CENTER.x+TANK_RADII.x);
      const y=THREE.MathUtils.clamp(p.y,TANK_CENTER.y-TANK_RADII.y,TANK_CENTER.y+TANK_RADII.y);
      const z=THREE.MathUtils.clamp(p.z,-2.7,2.0);
      if(x!==p.x||y!==p.y||z!==p.z) {p.set(x,y,z);prev[i].copy(p);}
    }
  }
  // Resize and zoom can put a previously valid swimming position outside the
  // viewport. Correct the whole chain together instead of squashing the head.
  const screenCorrection=clampToTank(pos[0].clone(),0.985).sub(pos[0]);
  if(screenCorrection.lengthSq()>1e-10) {
    for(let i=0;i<BONE_COUNT;i++) {pos[i].add(screenCorrection);prev[i].add(screenCorrection);}
  }
}

// ============================================================
// 粒子 → 骨骼姿态（头部低通滤波 + 转弯侧倾 banking）
// ============================================================
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();
const _parentInv = new THREE.Quaternion();
const _eye = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _heading = new THREE.Vector3();
const worldQ = [];
const smDir = [];          // 低通后的链方向（不产生扭转相位差）
const _qPT = new THREE.Quaternion();
const _upR = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();
let prevYaw = 0;
let yawRateSmooth = 0;
for (let i = 0; i < BONE_COUNT; i++) {
  worldQ.push(new THREE.Quaternion());
  smDir.push(new THREE.Vector3(0, 0, -1));
}

function updateBones(dt) {
  // 头部航向 → 转弯侧倾角
  _heading.subVectors(pos[3], pos[0]);
  const yaw = Math.atan2(_heading.x, _heading.z);
  let dYaw = yaw - prevYaw;
  if (dYaw > Math.PI) dYaw -= Math.PI * 2;
  if (dYaw < -Math.PI) dYaw += Math.PI * 2;
  prevYaw = yaw;
  const yawRate = _heading.lengthSq() > 1e-6 ? dYaw / Math.max(dt, 1e-4) : 0;
  yawRateSmooth += (yawRate - yawRateSmooth) * (1 - Math.exp(-3 * dt));
  const roll = THREE.MathUtils.clamp(-yawRateSmooth * 0.22, -0.45, 0.45);

  // 1) 每节方向低通（掉头时平滑扫过，不滤波四元数 → 无相位扭转）
  for (let i = 0; i < BONE_COUNT; i++) {
    if (i < BONE_COUNT - 1) _dir.subVectors(pos[i + 1], pos[i]);
    else _dir.subVectors(pos[i], pos[i - 1]);
    if (_dir.lengthSq() < 1e-10) _dir.set(0, 0, -1);
    _dir.normalize();
    const rate = i < N_HEAD ? 9 : 18;
    smDir[i].lerp(_dir, 1 - Math.exp(-rate * dt));
    if (smDir[i].lengthSq() < 1e-8) smDir[i].copy(_dir);
    smDir[i].normalize();
  }

  // 2) 根骨骼 up：帧间平行迁移 + 缓慢回正世界 Y（防 180° 翻转跳变）
  const d0 = smDir[0];
  const up0 = ups[0];
  up0.addScaledVector(d0, -up0.dot(d0));
  if (up0.lengthSq() < 1e-6) up0.set(1, 0, 0).addScaledVector(d0, -d0.x);
  up0.normalize();
  if (Math.abs(d0.y) < 0.9) {
    _tmpUp.set(0, 1, 0).addScaledVector(d0, -d0.y).normalize();
    up0.lerp(_tmpUp, 1 - Math.exp(-1.5 * dt)).normalize();
  }

  // 3) 沿链平行迁移 up：相邻骨骼扭转严格连续（根治掉头拉丝）
  for (let i = 1; i < BONE_COUNT; i++) {
    _qPT.setFromUnitVectors(smDir[i - 1], smDir[i]);
    ups[i].copy(ups[i - 1]).applyQuaternion(_qPT);
    ups[i].addScaledVector(smDir[i], -ups[i].dot(smDir[i])).normalize();
  }

  // 4) 姿态：lookAt（含侧倾）→ 局部四元数
  for (let i = 0; i < BONE_COUNT; i++) {
    const rollW = i < N_HEAD ? 0.9 : 0.45;
    _upR.copy(ups[i]).applyAxisAngle(smDir[i], roll * rollW);

    _eye.copy(pos[i]);
    _tgt.copy(pos[i]).add(smDir[i]);
    _m4.lookAt(_eye, _tgt, _upR);
    worldQ[i].setFromRotationMatrix(_m4);
  }
  bones[0].position.copy(pos[0]);
  bones[0].quaternion.copy(worldQ[0]);
  for (let i = 1; i < BONE_COUNT; i++) {
    _parentInv.copy(worldQ[i - 1]).invert();
    _q.copy(_parentInv).multiply(worldQ[i]);
    bones[i].quaternion.copy(_q);
  }

  // 鳍部支链独立微动：胸鳍反相扑动；背/腹鳍 Root/Tip 同点共挂、相位错开，
  // 基部→末端形成行波；叠加小幅前后摆动（rotation.x）增加维度
  if (finBones.length === APPENDAGE_COUNT) {
    const idle = 0.55 + 0.45 * (1 - Math.min(headSpeedSmooth, 1));
    finBones[0].rotation.z =  0.12 * idle * Math.sin(simTime * 5.8);
    finBones[1].rotation.z = -0.12 * idle * Math.sin(simTime * 5.8);
    finBones[2].rotation.z =  0.09 * idle * Math.sin(simTime * 2.8 + 0.4);
    finBones[2].rotation.x =  0.06 * idle * Math.sin(simTime * 2.2 + 0.9);
    finBones[3].rotation.z =  0.13 * idle * Math.sin(simTime * 2.8 + 1.1);
    finBones[3].rotation.x = -0.07 * idle * Math.sin(simTime * 2.2 + 0.2);
    finBones[4].rotation.z = -0.09 * idle * Math.sin(simTime * 2.8 + 0.4);
    finBones[4].rotation.x =  0.06 * idle * Math.sin(simTime * 2.2 + 0.9);
    finBones[5].rotation.z = -0.13 * idle * Math.sin(simTime * 2.8 + 1.1);
    finBones[5].rotation.x = -0.07 * idle * Math.sin(simTime * 2.2 + 0.2);
    finBones[6].rotation.z =  0.13 * idle * Math.sin(simTime * 3.6 + 0.5);
    finBones[7].rotation.z = -0.13 * idle * Math.sin(simTime * 3.6 + 0.5);
  }
}


  const fishGroup = new THREE.Group();
  fishGroup.scale.setScalar(FISH_SCALE);
  scene.add(fishGroup);
  const geometry = sourceGeometry.clone();
  paintWeights(geometry);
  const originalPositions = new Float32Array(geometry.attributes.position.count * 3);
  for (let i=0; i<geometry.attributes.position.count; i++) { const a=geometry.attributes.position; originalPositions.set([a.getX(i), a.getY(i), a.getZ(i)], i*3); }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(originalPositions.slice(), 3));
  const sourceNormal = geometry.attributes.normal;
  const normals = new Float32Array(sourceNormal.count * 3);
  for(let i=0;i<sourceNormal.count;i++) normals.set([sourceNormal.getX(i),sourceNormal.getY(i),sourceNormal.getZ(i)], i*3);
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      const std = baseMaterial;
      const material = new THREE.MeshPhysicalMaterial({
        map: std.map || null,
        color: std.color ? std.color.clone() : undefined,
        side: std.side,
        metalness: 0.05,
        roughness: 0.55,
        envMapIntensity: 0.12,
        emissive: std.emissive ? std.emissive.clone() : undefined,
        emissiveIntensity: 0,              // 白色自发光清零（模型自带 emissive 会让深色泛白）
        iridescence: 0.30,                 // 物理薄膜干涉：鱼的油光/珠光（降档防白洗）
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [140, 460],
        sheen: 0.12,                       // 黏液层软反射（降档防白洗）
        sheenRoughness: 0.55,
        sheenColor: 0xfff2f6,
      });
      if (material.map) {
        material.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      }
      material.onBeforeCompile = (shader) => {
        // A/B 实验参数（runtime 可热切换，bench 用）
        Object.assign(shader.uniforms, {
          uSatBoost:   { value: 1.08 },   // 保亮度饱和提升强度
          uRoughDark:  { value: 0.95 },   // 深色区粗糙度上限
          uRoughLight: { value: 0.45 },   // 浅色区粗糙度下限（↓=更亮更反光）
          uScaleGlint: { value: 0.5 },    // 鳞缘减糙系数
          uBumpScale:  { value: 1.0 },    // 鱼鳞 bump 强度
          uWhiteCompress: { value: 0 },   // 近白区高光压缩（0=关）
          uTint:       { value: 1.0 },    // 整体亮度乘子
          uDarkHazeK:  { value: 1 },      // 虹彩/黏膜按贴图亮度缩放（深色不吃泛白叠加层）
          uTime:       { value: 0 },      // 焦散动画时间
          uPaletteLight: { value: new THREE.Color(palette.light) },
          uPaletteAccent: { value: new THREE.Color(palette.accent) },
          uPaletteDark: { value: new THREE.Color(palette.dark) },
          uOriginal: { value: palette.original ? 1 : 0 },
          uPaletteEdge: { value: new THREE.Color(palette.edge || palette.dark) },
          uPaletteDetail: { value: new THREE.Color(palette.detail || palette.light) },
          uPatternSeed: { value: palette.seed ?? Math.random()*20 },
          uCaustic:    { value: 0.035 },      // 鱼身焦散强度（0=关）
        });
        material.userData.shader = shader;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vModelPos;\nvarying vec3 vWorldPos;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvModelPos = position;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', /* glsl */`
            #include <common>
            varying vec3 vModelPos;
            varying vec3 vWorldPos;
            uniform vec3 uPaletteLight, uPaletteAccent, uPaletteDark, uPaletteEdge, uPaletteDetail;
            uniform float uPatternSeed;
            uniform float uOriginal;
            uniform float uSatBoost, uRoughDark, uRoughLight, uScaleGlint, uBumpScale, uTime, uCaustic, uWhiteCompress, uTint, uDarkHazeK;
            ${CAUSTIC_GLSL}
            // 身体区域（内层躯干）遮罩：外层鳍膜不吃鱼鳞/虹彩
            float fishBodyMask(vec3 mp) {
              float radial = length(vec2(mp.x / 0.34, mp.y / 0.38));
              return 1.0 - smoothstep(0.72, 1.12, radial);
            }
            // 程序鱼鳞：错位排布圆盘 + 盘心隆起 + 尾缘新月棱（棱线更亮）
            float fishScaleHeight(vec3 mp) {
              vec2 suv = vec2(mp.z * 0.85 + mp.y * 0.30, mp.y + mp.x * 0.45) * 22.0;
              suv.x += mod(floor(suv.y), 2.0) * 0.5;
              vec2 g = fract(suv) - vec2(0.5, 0.5);
              float r = length(g * vec2(1.0, 1.2));
              float disc = 1.0 - smoothstep(0.30, 0.48, r);
              float lip  = 1.0 - smoothstep(0.00, 0.22, r);
              float edge = smoothstep(0.46, 0.40, r) * (1.0 - smoothstep(0.36, 0.26, r));
              return disc * 0.5 + lip * 0.2 + edge * 0.5;
            }
          `)
          .replace('#include <map_fragment>', /* glsl */`
            #include <map_fragment>
            // 保持亮度的饱和度提升：纯白不溢出、纯黑不发灰，粉色/品红更鲜艳
            float sourceLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            float chroma = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)) - min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
            float bodyMask=fishBodyMask(vModelPos);
            float radial=length(vec2(vModelPos.x/0.34,vModelPos.y/0.38));
            float finEdge=max(smoothstep(0.96,1.95,radial),1.0-smoothstep(-0.83,-0.28,vModelPos.z));
            float marble=0.5+0.5*sin(vModelPos.z*10.0+sin(vModelPos.y*14.0+uPatternSeed)*1.6+vModelPos.x*9.0+uPatternSeed);
            vec3 bodyColor=mix(uPaletteLight,uPaletteDetail,smoothstep(0.48,0.90,marble)*0.40);
            vec3 finColor=mix(uPaletteAccent,uPaletteDetail,smoothstep(0.35,0.86,marble)*0.65);
            finColor=mix(finColor,uPaletteEdge,finEdge*0.88);
            vec3 pearly=mix(finColor,bodyColor,bodyMask);
            // Original black marbling remains visible across every colourway.
            pearly=mix(uPaletteDark,pearly,smoothstep(0.012,0.38,sourceLum));
            pearly*=0.70+0.30*smoothstep(0.03,0.90,sourceLum);
            // Keep the eyes and head markings dark, rather than tinting them white.
            float eyeMask = smoothstep(0.65, 0.82, vModelPos.z) * (1.0 - smoothstep(0.025, 0.10, sourceLum));
            pearly = mix(pearly, diffuseColor.rgb, eyeMask);
            diffuseColor.rgb = mix(pearly, diffuseColor.rgb, uOriginal);
            float satLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = clamp(mix(vec3(satLum), diffuseColor.rgb, uSatBoost), 0.0, 1.0);
            // 高光压缩：只收近白区亮度，中调/粉色不动（治“鱼白点高于场景白点”）
            if (uWhiteCompress > 0.001) {
              diffuseColor.rgb *= 1.0 - uWhiteCompress * smoothstep(0.70, 0.95, satLum);
            }
            diffuseColor.rgb *= uTint;
          `)
          .replace('#include <roughnessmap_fragment>', /* glsl */`
            #include <roughnessmap_fragment>
            float texLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            roughnessFactor = mix(uRoughDark, uRoughLight, smoothstep(0.04, 0.55, texLum));
            // 鳞缘棱线更低糙 → 鳞片边缘有锐利闪光（黑鳞区也有棱光）
            float scM = fishBodyMask(vModelPos);
            float scH = fishScaleHeight(vModelPos);
            roughnessFactor *= 1.0 - scM * smoothstep(0.55, 0.95, scH) * uScaleGlint;
          `)
          .replace('#include <normal_fragment_maps>', /* glsl */`
            // 程序鱼鳞 bump（屏幕空间高度差分，免切线/UV）
            float sM = fishBodyMask(vModelPos);
            float sH = fishScaleHeight(vModelPos);
            vec2 dHdxy = vec2(dFdx(sH), dFdy(sH)) * (uBumpScale * sM);
            {
              vec3 vSigmaX = normalize(dFdx(-vViewPosition.xyz));
              vec3 vSigmaY = normalize(dFdy(-vViewPosition.xyz));
              vec3 R1 = cross(vSigmaY, normal);
              vec3 R2 = cross(normal, vSigmaX);
              float fDet = dot(vSigmaX, R1) * faceDirection;
              vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
              normal = normalize(abs(fDet) * normal - vGrad);
            }
          `);
        // 虹彩仅身体区生效；厚度随鳞片起伏微变 → 每片鳞反一丝不同色光
        shader.fragmentShader = shader.fragmentShader
          .replace('material.iridescence = iridescence;',
                   'material.iridescence = iridescence * fishBodyMask(vModelPos) * mix(1.0, smoothstep(0.05, 0.35, satLum), uDarkHazeK);')
          .replace('material.iridescenceThickness = iridescenceThicknessMaximum;',
                   'material.iridescenceThickness = iridescenceThicknessMaximum * mix(0.85, 1.15, smoothstep(0.3, 0.9, fishScaleHeight(vModelPos)));')
          // 黏膜柔光同样限身体区：鳍膜不发白
          .replace('material.sheenColor = sheenColor;',
                   'material.sheenColor = sheenColor * fishBodyMask(vModelPos) * mix(1.0, smoothstep(0.05, 0.35, satLum), uDarkHazeK);')
          // 水面焦散投射到鱼身（真实水下融合感；uCaustic=0 时关闭）
          .replace('#include <opaque_fragment>', /* glsl */`
            if (uCaustic > 0.001) {
              float ca = caustic(vWorldPos.xz * 1.1 + vec2(uTime * 0.03, uTime * 0.017), uTime * 0.6);
              float topFacing = clamp(vNormal.y * 0.5 + 0.5, 0.0, 1.0);
              outgoingLight += outgoingLight * ca * uCaustic * (0.25 + 0.75 * topFacing)
                             + vec3(0.85, 0.95, 1.0) * ca * uCaustic * 0.08 * topFacing;
            }
            #include <opaque_fragment>
          `);
      };
      material.transparent = false;
      material.depthWrite = true;
      material.needsUpdate = true;


  skinnedMesh = new THREE.SkinnedMesh(geometry, material);
  skinnedMesh.frustumCulled = false;
  skinnedMesh.add(buildSkeleton());
  fishGroup.add(skinnedMesh);
  fishGroup.updateMatrixWorld(true);
  skinnedMesh.bind(new THREE.Skeleton(bones));
  const offset = new THREE.Vector3((Math.random() - 0.5) * 1.8, (Math.random() - 0.5) * 0.9, -0.1 + Math.random() * 0.3);
  pos.forEach((p,i) => { p.add(offset); prev[i].copy(p); });
  headTarget.copy(pos[0]); headTargetSmooth.copy(pos[0]);
  chooseCruisePoint();
  let paletteId = palette.id;
  let shapeId = 'halfmoon';
  return {
    group: fishGroup, mesh: skinnedMesh,
    get paletteId() { return paletteId; },
    get shapeId() { return shapeId; },
    headWorld: () => pos[0].clone().multiplyScalar(FISH_SCALE),
    get movingToClick() { return commanded; },
    target: () => dashTarget.clone().multiplyScalar(FISH_SCALE),
    guide(point) { dashTarget.copy(point).divideScalar(FISH_SCALE); clampToTank(dashTarget, 0.985); commanded = true; commandTTL = 15; },
    setPalette(p) {
      paletteId = p.id;
      const u = material.userData.shader?.uniforms;
      palette = p;
      if (u) { u.uPaletteLight.value.set(p.light); u.uPaletteAccent.value.set(p.accent); u.uPaletteDark.value.set(p.dark); u.uOriginal.value = p.original ? 1 : 0; u.uPaletteEdge.value.set(p.edge||p.dark); u.uPaletteDetail.value.set(p.detail||p.light); u.uPatternSeed.value=p.seed??Math.random()*20; }
    },
    setShape(id) {
      shapeId = id;
      const a = geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const x = originalPositions[i*3], y = originalPositions[i*3+1], z = originalPositions[i*3+2];
        const outer = THREE.MathUtils.smoothstep(Math.hypot(x/0.34,y/0.38), 0.82, 1.8);
        let yFactor = 1, xFactor = 1;
        if (id === 'veil') { yFactor += outer * (y < 0 ? 0.43 : 0.16); xFactor -= outer * 0.12; }
        if (id === 'rosetail') { yFactor += outer * 0.26; xFactor += outer * 0.13; }
        a.setXYZ(i, x*xFactor, y*yFactor, z);
      }
      a.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    },
    update(dt) { physicsStep(dt); updateBones(dt); if (material.userData.shader) material.userData.shader.uniforms.uTime.value = simTime; },
    dispose() { scene.remove(fishGroup); geometry.dispose(); material.dispose(); skinnedMesh.skeleton.dispose(); }
  };
}
const AudioSys = {
  ctx: null,
  init() {
    try {
      this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (_) {}
  },
  knock() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    [740, 1240, 2190].forEach((f, i) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.035 / (i + 1), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t); o.stop(t + 0.18);
    });
  }
};

function animateEnvironment(t, dt) {
  if (topWaterMat) topWaterMat.uniforms.uTime.value = t;
  // A/B 实验：window.__lightOverride = {keyLight, pendant, rimLight, rimLight2}
  const LO = window.__lightOverride || {};
  keyLight.intensity = LO.keyLight ?? (0.42 + 0.06 * Math.sin(t * 0.5));
  pendant.intensity = LO.pendant ?? (0.55 + 0.1 * Math.sin(t * 0.8 + 2.0));
  rimLight.intensity = LO.rimLight ?? (0.64 + 0.11 * Math.sin(t * 0.35 + 1.0));
  rimLight2.intensity = LO.rimLight2 ?? (0.56 + 0.11 * Math.sin(t * 0.42 + 3.5));

  for (const p of rayPlanes) {
    p.material.opacity = 0.045 + 0.025 * Math.sin(t * 0.4 + p.userData.phase);
    p.rotation.z = 0.3+0.12*Math.sin(t*0.19+p.userData.phase);
    p.position.x=p.userData.baseX+0.45*Math.sin(t*0.17+p.userData.phase);
  }

  const pp = plankton.geometry.attributes.position;
  for (let i = 0; i < pp.count; i++) {
    pp.array[i * 3]     = planktonBase[i * 3]     + Math.sin(t * 0.18 + i * 1.7) * 0.15;
    pp.array[i * 3 + 1] = planktonBase[i * 3 + 1] + Math.sin(t * 0.12 + i * 2.3) * 0.12;
    pp.array[i * 3 + 2] = planktonBase[i * 3 + 2] + Math.cos(t * 0.15 + i * 0.9) * 0.15;
  }
  pp.needsUpdate = true;

  const bp = bubbles.geometry.attributes.position;
  for (let i = 0; i < bubbleData.length; i++) {
    const b = bubbleData[i];
    b.y += b.v * dt;
    if (b.y > 1.6) { b.y = -1.8; b.x = (Math.random() - 0.5) * 3; b.z = (Math.random() - 0.5) * 3; }
    bp.array[i * 3]     = b.x + Math.sin(t * 2 + b.ph) * 0.03;
    bp.array[i * 3 + 1] = b.y;
    bp.array[i * 3 + 2] = b.z;
  }
  bp.needsUpdate = true;



}

const PALETTES = [
  {id:'ice',name:'杏蓝墨尾',light:'#ffe4dc',accent:'#a8e6ed',detail:'#ee9ebd',dark:'#18283c',edge:'#18233f'},
  {id:'rose',name:'粉墨青翎',light:'#ffe1ed',accent:'#a9e4d4',detail:'#d887b6',dark:'#24222b',edge:'#282338'},
  {id:'lilac',name:'紫雾橘光',light:'#eadfff',accent:'#ffc69e',detail:'#b3c9f4',dark:'#29233c',edge:'#33233d'},
  {id:'mint',name:'碧玉胭脂',light:'#dff4dc',accent:'#eda2b1',detail:'#86d2ce',dark:'#243832',edge:'#214451'},
  {id:'pearl',name:'月白酒红',light:'#fff0d9',accent:'#bfcfe9',detail:'#e0a2ac',dark:'#35282f',edge:'#632941'},
  {id:'original',name:'原色粉黑',light:'#fff0f5',accent:'#ef86c2',detail:'#ffd7e5',dark:'#222222',edge:'#191822',original:true},
];
function randomPalette() {
  const h=Math.random(), h2=(h+0.30+Math.random()*0.25)%1;
  const hex=(h,s,l)=>'#'+new THREE.Color().setHSL(h,s,l).getHexString();
  return {id:'random',name:'随机花色',light:hex(h,0.60,0.88),accent:hex(h2,0.55,0.72),detail:hex((h+0.12)%1,0.64,0.65),dark:hex(h2,0.22,0.10),edge:hex((h2+0.13)%1,0.35,0.16),seed:Math.random()*50};
}
const SHAPES = [{id:'halfmoon',name:'半月'}, {id:'veil',name:'柔纱'}, {id:'rosetail',name:'花瓣'}];
const BACKGROUNDS = [
  {id:'abyss',name:'幽蓝深海',image:'./backgrounds/abyss.png',exposure:0.62},
  {id:'zen',name:'水石之间',image:'./backgrounds/zen.png',exposure:0.62},
  {id:'moon',name:'月光海庭',image:'./backgrounds/moon.png',exposure:0.66},
  {id:'classic',name:'静谧海洋',image:'./ocean-background.png',exposure:0.50},
  {id:'window',name:'原版窗景',image:'./bg_poster.jpg'},
];
const fish = [];
let selected = 0, nextFishId = 1;
let modelSource = null;
let backgroundId = 'abyss';
let backgroundRequest=0;
let simTime = 0;
let rippleSlot = 0;
const cursorPoint = new THREE.Vector3();
const oceanUniforms = {uMap:{value:null},uTint:{value:new THREE.Color('#ffffff')},uExposure:{value:0.62},uTime:{value:0},uAspect:{value:innerWidth/innerHeight},uStyle:{value:0}};
const oceanMat = new THREE.ShaderMaterial({
  depthWrite:false, fog:false,
  uniforms:oceanUniforms,
  vertexShader:`varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader:`
    uniform sampler2D uMap; uniform vec3 uTint; uniform float uTime, uAspect, uExposure, uStyle;
    varying vec2 vUv;
    ${CAUSTIC_GLSL}
    void main(){
      float t=uTime;
      vec2 uv=(vUv-0.5)*0.96+0.5;
      // Slow camera drift plus depth-weighted refraction: nearby water moves
      // more than the distant scenery, giving the photo a quiet layered depth.
      uv+=vec2(sin(t*0.13),cos(t*0.10))*0.010;
      float nearWater=pow(1.0-vUv.y,1.5);
      uv+=vec2(sin(uv.y*13.0+t*0.40)+sin(uv.x*8.0-t*0.28),cos(uv.x*11.0+t*0.33))*vec2(0.0035,0.002)*(0.4+nearWater);
      vec3 col=texture2D(uMap,uv).rgb*0.36;
      col+=texture2D(uMap,uv+vec2(0.005,0.0)).rgb*0.16;
      col+=texture2D(uMap,uv-vec2(0.005,0.0)).rgb*0.16;
      col+=texture2D(uMap,uv+vec2(0.0,0.005)).rgb*0.16;
      col+=texture2D(uMap,uv-vec2(0.0,0.005)).rgb*0.16;
      vec2 water=vec2(vUv.x*uAspect,vUv.y);
      float ca=min(caustic(water*2.5+vec2(t*0.03,-t*0.019),t*0.42),0.65);
      float shafts=0.0;
      for(int i=0;i<4;i++) {
        float fi=float(i);
        float center=0.12+fi*0.27+sin(t*0.14+fi*1.8)*0.06;
        float d=vUv.x-center+(1.0-vUv.y)*(0.13+0.05*sin(t*0.11+fi));
        shafts+=exp(-d*d/(0.0025+0.002*(1.0-vUv.y)))*(0.5+0.5*sin(t*0.23+fi));
      }
      vec3 lightColor=uStyle==1.0?vec3(0.53,0.73,0.61):uStyle==2.0?vec3(0.51,0.57,0.90):vec3(0.35,0.69,0.85);
      float mist=0.5+0.5*sin(water.x*5.0+water.y*3.0-t*0.21+sin(water.y*6.0+t*0.16));
      col*=0.94+0.06*sin(t*0.24+uv.x*3.0)+ca*0.18*nearWater;
      col+=lightColor*(shafts*0.035*(0.25+0.75*vUv.y)+ca*0.032*nearWater+mist*0.018);
      gl_FragColor=vec4(col*uTint*uExposure,1.0);
    }`

});
const backgroundDirection = new THREE.Vector3();
const oceanPlane = new THREE.Mesh(new THREE.PlaneGeometry(16,9),oceanMat);
oceanPlane.position.set(0,0,-8);
scene.add(oceanPlane);
plantScene.visible=false;
const backgroundCache=new Map();
function loadBackground(path) {
  if(!backgroundCache.has(path)) backgroundCache.set(path,new Promise((resolve,reject)=>{
    new THREE.TextureLoader().load(path,t=>{t.colorSpace=THREE.SRGBColorSpace;resolve(t);},undefined,reject);
  }).catch(error=>{backgroundCache.delete(path);throw error;}));
  return backgroundCache.get(path);
}
async function setBackground(id) {
  const bg=BACKGROUNDS.find(b=>b.id===id);
  if(!bg)throw new Error('Unknown background');
  const request=++backgroundRequest;
  const status=document.getElementById('background-status');
  status.textContent=id==='window'?'':'正在切换场景…';
  try {
    const texture=id==='window'?null:await loadBackground(bg.image);
    if(request!==backgroundRequest)return;
    if(texture){oceanUniforms.uMap.value=texture;oceanUniforms.uExposure.value=bg.exposure;oceanUniforms.uStyle.value=BACKGROUNDS.indexOf(bg);}
    backgroundId=id;
    gradePass.uniforms.uLightStyle.value=BACKGROUNDS.indexOf(bg);
    waterSurface.visible=id==='window';
    windowScene.visible=id==='window';plantScene.visible=id==='window';oceanPlane.visible=id!=='window';
    scene.fog.color.set(id==='window'?'#35383a':'#071e32');
    document.querySelectorAll('[data-bg]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.bg===id));
    status.textContent='';
  } catch(error) { if(request===backgroundRequest)status.textContent='场景加载失败，请重试。';console.error('Background load failed',error); }
}
// Convert screen destinations at a stable swimming depth, including corners.
const swimRay = new THREE.Raycaster();
const swimPlane = new THREE.Plane();
const swimNormal = new THREE.Vector3();
const swimNDC = new THREE.Vector2();
function screenToSwimPoint(x,y,z,out=new THREE.Vector3()) {
  camera.getWorldDirection(swimNormal);
  swimPlane.setFromNormalAndCoplanarPoint(swimNormal,new THREE.Vector3(0,0,z));
  swimRay.setFromCamera(swimNDC.set(x,y),camera);
  return swimRay.ray.intersectPlane(swimPlane,out);
}
function clampToTank(v,scale=0.985) {
  const world=v.clone().multiplyScalar(FISH_SCALE);
  const projected=world.clone().project(camera);
  if(Math.abs(projected.x)>scale||Math.abs(projected.y)>scale) {
    screenToSwimPoint(THREE.MathUtils.clamp(projected.x,-scale,scale),THREE.MathUtils.clamp(projected.y,-scale,scale),world.z,world);
    v.copy(world).divideScalar(FISH_SCALE);
  }
  return v;
}
function updateSwimBounds() {
  const low=screenToSwimPoint(-1,-1,0), high=screenToSwimPoint(1,1,0);
  TANK_CENTER.copy(low).add(high).multiplyScalar(0.5/FISH_SCALE);
  TANK_RADII.set(Math.abs(high.x-low.x)*0.5/FISH_SCALE+1.8,Math.abs(high.y-low.y)*0.5/FISH_SCALE+1.4,2.7);
}
controls.update();updateSwimBounds();
function addFish(paletteId,shapeId='halfmoon') {
  if(!modelSource) return;
  if(fish.length>=5) return;
  const p=PALETTES.find(p=>p.id===paletteId)||PALETTES[fish.length%5];
  const f=createFishRig(modelSource.geometry,modelSource.material,p);
  f.id=nextFishId++; f.setShape(shapeId); fish.push(f); selected=fish.length-1;
  refreshUI();
}
function refreshUI() {
  const list=document.getElementById('fish-list');
  list.replaceChildren(...fish.map((f,i)=>{
    const b=document.createElement('button'); b.type='button'; b.className='fish-chip';
    b.textContent=`斗鱼 ${f.id}`; b.setAttribute('aria-pressed',i===selected);
    b.addEventListener('click',()=>{selected=i;refreshUI();}); return b;
  }));
  const f=fish[selected];
  document.querySelectorAll('[data-palette]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.palette===f?.paletteId));
  document.getElementById('random-palette').setAttribute('aria-pressed',f?.paletteId==='random');
  document.querySelectorAll('[data-shape]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.shape===f?.shapeId));
  document.getElementById('fish-count').textContent=`${fish.length} / 5`;
  document.getElementById('add-fish').disabled=!modelSource||fish.length>=5;
  document.getElementById('remove-fish').disabled=fish.length<=1;
}
function removeFish() {
  if(fish.length<=1)return;
  fish.splice(selected,1)[0].dispose(); selected=Math.min(selected,fish.length-1);refreshUI();
}
function togglePanel(open) {
  const panel=document.getElementById('settings-panel'), toggle=document.getElementById('settings-toggle');
  panel.hidden=!open; toggle.setAttribute('aria-expanded',open);
  if(open) document.getElementById('close-panel').focus();
  else toggle.focus();
}
document.getElementById('settings-toggle').addEventListener('click',()=>togglePanel(document.getElementById('settings-panel').hidden));
document.getElementById('close-panel').addEventListener('click',()=>togglePanel(false));
addEventListener('keydown',e=>{if(e.key==='Escape')togglePanel(false);});
for(const b of BACKGROUNDS){const el=document.createElement('button');el.type='button';el.dataset.bg=b.id;el.innerHTML=`<img src="${b.image}" alt="" loading="lazy"><span>${b.name}</span>`;el.setAttribute('aria-pressed','false');el.addEventListener('click',()=>setBackground(b.id));document.getElementById('background-options').appendChild(el);}
for(const p of PALETTES){const el=document.createElement('button');el.type='button';el.className='palette-option';el.dataset.palette=p.id;el.innerHTML=`<span class="swatch" style="--light:${p.light};--accent:${p.accent};--dark:${p.dark}"></span><span>${p.name}</span>`;el.addEventListener('click',()=>{fish[selected]?.setPalette(p);refreshUI();});document.getElementById('palette-options').appendChild(el);}
for(const s of SHAPES){const el=document.createElement('button');el.type='button';el.dataset.shape=s.id;el.textContent=s.name;el.addEventListener('click',()=>{fish[selected]?.setShape(s.id);refreshUI();});document.getElementById('shape-options').appendChild(el);}
document.getElementById('add-fish').addEventListener('click',()=>addFish(PALETTES[fish.length%5].id,SHAPES[fish.length%3].id));
document.getElementById('remove-fish').addEventListener('click',removeFish);
document.getElementById('random-palette').addEventListener('click',()=>{fish[selected]?.setPalette(randomPalette());refreshUI();});
const initialBackground=setBackground('abyss');refreshUI();

const loading=document.getElementById('loading');
const loadBar=document.getElementById('loadBar');
const loadingProgress=document.getElementById('loading-progress');
const loadingPercent=document.getElementById('loading-percent');
const loadingStatus=document.getElementById('loading-status');
let progressValue=0;
function setLoadingProgress(value,message) {
  progressValue=Math.max(progressValue,Math.min(100,Math.round(value)));
  loadBar.style.strokeDashoffset=339.292*(1-progressValue/100);
  loadingProgress.setAttribute('aria-valuenow',progressValue);
  loadingPercent.textContent=progressValue+'%';
  if(message)loadingStatus.textContent=message;
}
setLoadingProgress(8,'正在准备你的水下世界…');
const dracoLoader=new DRACOLoader();dracoLoader.setDecoderPath('./vendor/draco/');
const fishLoader=new GLTFLoader();fishLoader.setDRACOLoader(dracoLoader);fishLoader.setMeshoptDecoder(MeshoptDecoder);
fishLoader.load('./model_opt.glb',async gltf=>{
  gltf.scene.traverse(o=>{if(o.isMesh&&!modelSource)modelSource=o;});
  if(!modelSource) {loadingStatus.textContent='小斗鱼暂时迷路了，请刷新重试。';return;}
  setLoadingProgress(92,'正在舒展小斗鱼的鱼鳍…');
  await initialBackground;
  // Paint the decoding status before the heavier mesh/skin setup. CSS transform
  // animations remain composited while the rig is prepared on the main thread.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  addFish('ice');setLoadingProgress(100,'小斗鱼准备好啦');
  loading.classList.add('is-ready');
  setTimeout(()=>{loading.style.opacity='0';loading.style.pointerEvents='none';setTimeout(()=>loading.remove(),650);},260);
},ev=>{if(ev.total)setLoadingProgress(8+ev.loaded/ev.total*78,'正在迎接小斗鱼…');},err=>{
  console.error(err);loading.classList.add('has-error');loadingStatus.textContent='小斗鱼暂时迷路了，再试一次吧。';
  const b=document.createElement('button');b.textContent='重新加载';b.className='retry';b.onclick=()=>location.reload();loading.appendChild(b);
});

// A click sets a destination for the selected fish. Pointer movement has no effect.
const raycaster=new THREE.Raycaster();
const pointerNDC=new THREE.Vector2();
const followPlane=new THREE.Plane();
const camDirection=new THREE.Vector3();
renderer.domElement.style.touchAction='none';
let press=null;
renderer.domElement.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;press={x:e.clientX,y:e.clientY,id:e.pointerId};
});
renderer.domElement.addEventListener('pointercancel',()=>{press=null;});
renderer.domElement.addEventListener('pointerup',e=>{
  if(!press||press.id!==e.pointerId)return;
  const distance=Math.hypot(e.clientX-press.x,e.clientY-press.y);press=null;
  if(distance>14||!fish[selected])return;
  const f=fish[selected];
  const rect=renderer.domElement.getBoundingClientRect();
  pointerNDC.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);
  camera.getWorldDirection(camDirection);followPlane.setFromNormalAndCoplanarPoint(camDirection,f.headWorld());
  raycaster.setFromCamera(pointerNDC,camera);
  if(raycaster.ray.intersectPlane(followPlane,cursorPoint)) {
    f.guide(cursorPoint);
    gradePass.uniforms.uRipples.value[rippleSlot].set((pointerNDC.x+1)/2,(pointerNDC.y+1)/2,simTime,1);
    rippleSlot=(rippleSlot+1)%6;
    AudioSys.init();AudioSys.knock();
    document.getElementById('gesture-hint').classList.add('dismissed');
  }
});
// Pause expensive animation when this tab is not visible, without jumping the simulation.
const clock=new THREE.Clock();
function tick(){
  requestAnimationFrame(tick);
  const dt=Math.min(clock.getDelta(),0.10);
  if(document.hidden||dt<=0)return;
  simTime+=dt;
  controls.update();updateSwimBounds();
  const steps=Math.ceil(dt/(1/30));
  for(let i=0;i<steps;i++) fish.forEach(f=>f.update(dt/steps));
  animateEnvironment(simTime,dt);
  const oceanHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.abs(camera.position.z + 8);
  camera.getWorldDirection(backgroundDirection);
  const backgroundDepth = (-8-camera.position.z)/backgroundDirection.z;
  oceanPlane.position.set(camera.position.x+backgroundDirection.x*backgroundDepth, camera.position.y+backgroundDirection.y*backgroundDepth, -8);
  oceanPlane.scale.setScalar(Math.max(oceanHeight / 9, oceanHeight * camera.aspect / 16) * 1.12);
  oceanUniforms.uTime.value=simTime; oceanUniforms.uAspect.value=camera.aspect;
  gradePass.uniforms.uTime.value=simTime;
  composer.render();
}
tick();
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);updateRTSize();});
