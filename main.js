import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

/* ==========================================================================
   Aethelgard 3D - Koloni Simülasyonu: Toplu Seçim & Mimar/İnşaat Sistemi
   ========================================================================== */

// --- Temel Harita ve Ayarlar (Genişletilmiş 260x260 Devasa Harita) ---
const MAP_SIZE = 260;          // Devasa koloni haritası (260x260)
const SEGMENTS = 130;          // Yüksek detaylı ve akıcı koloni arazisi (17.000 vertex)
const HALF_MAP = MAP_SIZE / 2;
const WATER_LEVEL = 0.0;

const container = document.getElementById('game-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1120);
scene.fog = new THREE.FogExp2(0x0a1120, 0.0035); // Uzak dağları gösteren derin atmosferik sis

// --- RTS Kamerası ---
const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.5,
  1600
);
camera.position.set(36, 42, 36);

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // Stabil 60-144 FPS
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

// --- RTS Kontrolleri ---
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.minDistance = 6;
controls.maxDistance = 220;
controls.maxPolarAngle = Math.PI / 2.2;
controls.minPolarAngle = Math.PI / 9;

// Sol Tık: Sadece seçim ve inşaat içindir (kamerayı oynatmaz).
// Orta Tuş (Tekerlek Sürükleme): 3D Açıyı serbestçe döndürür (Rotate).
// Q ve E Tuşları: Kamerayı yumuşakça 360 derece döndürür.
// Sağ Tık: Birimlere emir verir (Opera sayfa geri gitme hareketini tetiklemez).
controls.mouseButtons = {
  LEFT: -1,
  MIDDLE: THREE.MOUSE.ROTATE,
  RIGHT: -1
};

// --- Aydınlatma ---
const ambientLight = new THREE.AmbientLight(0x8ba6ca, 1.25);
scene.add(ambientLight);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x223545, 0.7);
hemiLight.position.set(0, 80, 0);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfffaec, 2.4);
sunLight.position.set(70, 95, 60);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 300;
const d = 85;
sunLight.shadow.camera.left = -d;
sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d;
sunLight.shadow.camera.bottom = -d;
sunLight.shadow.bias = -0.0004;
scene.add(sunLight);

// ==========================================================================
// 1. DÜNYA, KAYNAK & DOĞAL MATERYAL YÖNETİMİ
// ==========================================================================
const resources = {
  food: 80,
  wood: 150,
  stone: 60,
  gold: 200,
  colonists: 3,
  maxPop: 10
};

// Doğal Kaynaklar (Ağaç, Kaya, Çalı) ve InstancedMesh Kayıtları
const harvestableEntities = new Map(); // entityId -> { id, name, resType, yieldAmount, maxRes, currentRes, isDepleted, pos, meshes }
const allHarvestMeshes = [];          // Raycastable InstancedMeshes
let selectedHarvestEntity = null;     // Seçili kaynak (Inspector için)
const particleEffects = [];           // Yüzen kaynak ve talaş/toz parçacıkları

function updateResourceUI() {
  const foodEl = document.getElementById('res-food');
  const woodEl = document.getElementById('res-wood');
  const stoneEl = document.getElementById('res-stone');
  const goldEl = document.getElementById('res-gold');
  const popEl = document.getElementById('res-pop');

  if (foodEl) foodEl.textContent = Math.floor(resources.food);
  if (woodEl) woodEl.textContent = Math.floor(resources.wood);
  if (stoneEl) stoneEl.textContent = Math.floor(resources.stone);
  if (goldEl) goldEl.textContent = Math.floor(resources.gold);
  if (popEl) popEl.textContent = `${resources.colonists} / ${resources.maxPop}`;
}

// ==========================================================================
// 2. SEEDED RANDOM & FAST NOISE (ONLINE DÜNYA SENKRONİZASYONU)
// ==========================================================================
// Tüm oyuncuların aynı tohumda (seed) 1-e-1 aynı ağaç, kaya ve nehirleri görmesini sağlar
class SeededRandom {
  constructor(seed = 123456) {
    this.s = Math.abs(Math.floor(seed)) % 2147483647;
    if (this.s <= 0) this.s += 2147483646;
  }
  next() {
    this.s = (this.s * 16807) % 2147483647;
    return (this.s - 1) / 2147483646;
  }
}

let currentSeed = 100000;

class FastNoise {
  constructor(seed = Math.random() * 10000) {
    this.seed = seed;
    this.p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;

    let s = Math.abs(Math.sin(this.seed)) * 10000;
    for (let i = 255; i > 0; i--) {
      s = Math.abs(Math.sin(s)) * 10000;
      const j = Math.floor((s - Math.floor(s)) * (i + 1));
      const temp = perm[i];
      perm[i] = perm[j];
      perm[j] = temp;
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(t, a, b) { return a + t * (b - a); }
  grad(hash, x, y) {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  noise2D(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = this.fade(xf);
    const v = this.fade(yf);

    const aa = this.p[this.p[X] + Y];
    const ab = this.p[this.p[X] + Y + 1];
    const ba = this.p[this.p[X + 1] + Y];
    const bb = this.p[this.p[X + 1] + Y + 1];

    return this.lerp(v,
      this.lerp(u, this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf)),
      this.lerp(u, this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1))
    );
  }

  fbm(x, y, octaves = 4, persistence = 0.5, lacunarity = 2.0) {
    let total = 0;
    let frequency = 1;
    let amplitude = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i++) {
      total += this.noise2D(x * frequency, y * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxValue;
  }
}

// ==========================================================================
// PROSEDÜREL DOĞAL DOKULAR (CANVAS TEXTURES - %100 LİSANSSIZ & YÜKSEK KALİTE)
// ==========================================================================
function createProceduralTerrainTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Derin zengin çimen ve orman tabanı
  ctx.fillStyle = '#3a6b38';
  ctx.fillRect(0, 0, 512, 512);

  // Doğal toprak, yosun ve taze yeşil lekeleri
  const shades = ['#447d42', '#325d30', '#2d532a', '#4a8547', '#576a3b', '#3b5430', '#63533b'];
  for (let i = 0; i < 3500; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = 1.2 + Math.random() * 4.2;
    ctx.fillStyle = shades[Math.floor(Math.random() * shades.length)];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // İnce çimen lifleri ve organik toprak tanecikleri
  ctx.strokeStyle = 'rgba(20, 40, 18, 0.22)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 4, y - (Math.random() * 5 + 2));
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(38, 38);
  return texture;
}

function createWaterNormalTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#8080ff';
  ctx.fillRect(0, 0, 256, 256);

  for (let y = 0; y < 256; y += 4) {
    for (let x = 0; x < 256; x += 4) {
      const nx = Math.sin(x * 0.09 + y * 0.06) * 22 + 128;
      const ny = Math.cos(x * 0.07 - y * 0.09) * 22 + 128;
      ctx.fillStyle = `rgb(${Math.floor(nx)}, ${Math.floor(ny)}, 255)`;
      ctx.fillRect(x, y, 4, 4);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(18, 18);
  return texture;
}

let cachedTerrainTexture = null;
let cachedWaterNormalTexture = null;

const COLOR_RIVERBED = new THREE.Color(0x223c4a);
const COLOR_SAND     = new THREE.Color(0xd9c28a);
const COLOR_GRASS    = new THREE.Color(0x448545);
const COLOR_FOREST   = new THREE.Color(0x28592d);
const COLOR_ROCK     = new THREE.Color(0x5f6775);
const COLOR_SNOW     = new THREE.Color(0xf1f5f9);

const worldGroup = new THREE.Group();
scene.add(worldGroup);

// ==========================================================================
// 2. DENGELİ COĞRAFİ ARKETİPLER (DENİZ, GÖL, NEHİR, KARASAL OVA)
// ==========================================================================
const ARCHETYPES = [
  { id: 'COASTAL', name: '🌊 Açık Deniz & Sahil Kıyısı', desc: 'Batısında masmavi okyanus ve geniş kumsallar, doğusunda uçsuz bucaksız anakara.' },
  { id: 'LAKES',   name: '🏞️ Yayla Dağ Gölleri',         desc: 'Yüksek dağ yamaçları arasında berrak 1-2 vadi gölü ve çam ormanları.' },
  { id: 'RIVER',   name: '🌿 Kıvrımlı Nehir Vadisi',       desc: 'Haritayı baştan başa geçen canlı ve kıvrımlı doğal bir nehir.' },
  { id: 'INLAND',  name: '🌾 Karasal Geniş Bozkır (Az Su)', desc: 'Neredeyse tamamen kuru, devasa tarım ve inşaat alanları sunan engin arazi.' }
];

let currentMapConfig = {
  type: 'RIVER',
  name: '🌿 Kıvrımlı Nehir Vadisi',
  coastSide: 'WEST',
  coastOffset: -45,
  coastCurvature: 0.02,
  coastPhase: 0,
  lakes: [],
  river: { axis: 'Z', startOffset: 0, freq1: 0.02, amp1: 22, freq2: 0.045, amp2: 7, phase1: 0, phase2: 0, width: 8.5 },
  creek: { startOffset: 0, freq1: 0.03, amp1: 14, freq2: 0.06, amp2: 4, phase1: 0, phase2: 0, width: 3.0 }
};

let terrainMesh = null;
let riverMesh = null;
let currentNoise = null;
let campPos = { x: 0, y: 1.0, z: 0 };
let campfireLight = null;

function getRiverOffset(coord, params) {
  if (!params) return 0;
  return (
    params.startOffset +
    Math.sin(coord * params.freq1 + params.phase1) * params.amp1 +
    Math.cos(coord * params.freq2 + params.phase2) * params.amp2
  );
}

function getTerrainHeight(x, z, noise, config) {
  if (!noise) return 0;
  const cfg = (config && config.type) ? config : currentMapConfig;

  // 1. Doğal Vadi, Tepeler ve Çayırlar (Zengin, dalgalı canlı topoğrafya)
  const valleyNoise = noise.fbm(x * 0.010, z * 0.010, 4, 0.52, 2.0); // -1.0 ile 1.0 arası
  const hillNoise = Math.max(0, noise.noise2D((x + 60) * 0.020, (z + 60) * 0.020));

  // Kuru arazi taban yüksekliği (Asla 0.95'in altına inmez; su sadece hedeflenen yerde oyulur)
  let h = 0.95 + (valleyNoise + 1.0) * 1.35 + hillNoise * 2.2;

  // 2. Dış Sınırlarda ve Ufukta Yükselen Heybetli Dağ Silsilesi & Keskin Alp Sırtları:
  const centerDist = Math.hypot(x, z) / HALF_MAP;
  let mountainAllowed = true;
  if (cfg.type === 'COASTAL') {
    const side = cfg.coastSide || 'WEST';
    if (side === 'WEST' && x < (cfg.coastOffset || -40) + 12) mountainAllowed = false;
    else if (side === 'EAST' && x > (cfg.coastOffset || 40) - 12) mountainAllowed = false;
    else if (side === 'SOUTH' && z > (cfg.coastOffset || 40) - 12) mountainAllowed = false;
  }

  if (mountainAllowed && centerDist > 0.34) {
    const mountainRaw = Math.max(0, noise.fbm((x + 160) * 0.0075, (z + 160) * 0.0075, 4, 0.56, 2.15));
    // Keskin kayalık alp sırtları (Ridged multifractal)
    const ridgeNoise = 1.0 - Math.abs(noise.noise2D((x + 90) * 0.015, (z + 90) * 0.015));
    const factor = Math.pow((centerDist - 0.34) / 0.66, 1.65);
    h += factor * (Math.pow(mountainRaw * 1.8, 2.2) * 18.0 + Math.pow(ridgeNoise, 3.0) * 11.0);
  }

  // 3. Seçilen Coğrafi Arketipe Göre Su Yatağını Oy (Tamamen İzole, Yüksek Çeşitlilikte ve Dengeli!):
  if (cfg.type === 'COASTAL') {
    const side = cfg.coastSide || 'WEST';
    let distIntoSea = 0;
    let isSea = false;
    let distFromShore = 0;

    if (side === 'WEST') {
      const curvature = Math.sin(z * (cfg.coastCurvature || 0.02) + (cfg.coastPhase || 0)) * 14;
      const actualCoast = (cfg.coastOffset || -42) + curvature;
      if (x < actualCoast + 6.0) {
        if (x < actualCoast) { isSea = true; distIntoSea = actualCoast - x; }
        else { distFromShore = x - actualCoast; }
      }
    } else if (side === 'EAST') {
      const curvature = Math.sin(z * (cfg.coastCurvature || 0.02) + (cfg.coastPhase || 0)) * 14;
      const actualCoast = (cfg.coastOffset || 42) + curvature;
      if (x > actualCoast - 6.0) {
        if (x > actualCoast) { isSea = true; distIntoSea = x - actualCoast; }
        else { distFromShore = actualCoast - x; }
      }
    } else { // SOUTH
      const curvature = Math.sin(x * (cfg.coastCurvature || 0.02) + (cfg.coastPhase || 0)) * 14;
      const actualCoast = (cfg.coastOffset || 42) + curvature;
      if (z > actualCoast - 6.0) {
        if (z > actualCoast) { isSea = true; distIntoSea = z - actualCoast; }
        else { distFromShore = actualCoast - z; }
      }
    }

    if (isSea) {
      const t = Math.min(1.0, distIntoSea / 32.0);
      h = THREE.MathUtils.lerp(-0.25, -3.8, t * t);
    } else if (distFromShore > 0) {
      const beachT = distFromShore / 6.0;
      h = THREE.MathUtils.lerp(-0.25, Math.max(h, 0.70), beachT);
    }
  } else if (cfg.type === 'LAKES') {
    // Organik eliptik göl havzaları (Daire değil, doğal kıvrımlı vadi gölleri)
    if (cfg.lakes && cfg.lakes.length > 0) {
      for (let lake of cfg.lakes) {
        const dx = x - lake.x;
        const dz = z - lake.z;
        const cosA = Math.cos(lake.angle || 0);
        const sinA = Math.sin(lake.angle || 0);
        const lx = dx * cosA - dz * sinA;
        const lz = (dx * sinA + dz * cosA) * (lake.aspect || 1.25);
        const organicWobble = (noise.noise2D((x + 70) * 0.04, (z + 70) * 0.04) + 1.0) * 0.12;
        const d = Math.hypot(lx, lz) * (1.0 - organicWobble);

        if (d < lake.radius) {
          const t = d / lake.radius;
          if (t < 0.80) {
            const depthT = t / 0.80;
            const smoothT = depthT * depthT * (3 - 2 * depthT);
            h = THREE.MathUtils.lerp(-2.4, -0.25, smoothT);
          } else {
            const beachT = (t - 0.80) / 0.20;
            h = THREE.MathUtils.lerp(-0.25, Math.max(h, 0.70), beachT);
          }
        }
      }
    }
  } else if (cfg.type === 'RIVER') {
    // Çok yönlü canlı nehir koridoru (Kuzey-Güney, Doğu-Batı veya Çapraz akabilir)
    if (cfg.river) {
      const axis = cfg.river.axis || 'Z';
      let dist = 0;
      if (axis === 'X') {
        const rz = getRiverOffset(x, cfg.river);
        dist = Math.abs(z - rz);
      } else if (axis === 'DIAG') {
        const u = (x + z) * 0.7071;
        const v = (x - z) * 0.7071;
        const targetV = getRiverOffset(u, cfg.river);
        dist = Math.abs(v - targetV);
      } else { // 'Z' (Kuzey-Güney)
        const rx = getRiverOffset(z, cfg.river);
        dist = Math.abs(x - rx);
      }

      const halfW = cfg.river.width * 0.5;
      const bankW = halfW + 4.5;
      if (dist < bankW) {
        if (dist < halfW) {
          const t = dist / halfW;
          const smoothT = t * t * (3 - 2 * t);
          h = THREE.MathUtils.lerp(-2.0, -0.25, smoothT);
        } else {
          const beachT = (dist - halfW) / 4.5;
          h = THREE.MathUtils.lerp(-0.25, Math.max(h, 0.70), beachT);
        }
      }
    }
  } else if (cfg.type === 'INLAND') {
    // Karasal Bozkır (Çok az su - Yalnızca daracık küçük bir vadi deresi)
    if (cfg.creek) {
      const rx = getRiverOffset(z, cfg.creek);
      const dist = Math.abs(x - rx);
      const halfW = cfg.creek.width * 0.5;
      const bankW = halfW + 2.2;
      if (dist < bankW) {
        if (dist < halfW) {
          const t = dist / halfW;
          h = THREE.MathUtils.lerp(-0.65, -0.15, t * t);
        } else {
          const beachT = (dist - halfW) / 2.2;
          h = THREE.MathUtils.lerp(-0.15, Math.max(h, 0.70), beachT);
        }
      }
    }
  }

  const edgeVariation = noise.noise2D(x * 0.035, z * 0.035) * 5;
  const distanceToEdge = Math.min(HALF_MAP - Math.abs(x), HALF_MAP - Math.abs(z)) + edgeVariation;
  const edgeFade = THREE.MathUtils.smoothstep(distanceToEdge, 0, 28);
  return THREE.MathUtils.lerp(-2, h, edgeFade);
}

// Su ve Biyom Algılama Yardımcısı
function getWaterInfoAt(x, z, h) {
  const cfg = currentMapConfig;
  const isWater = (h < -0.05);
  const isShore = (h >= -0.05 && h < 0.48);
  let label = '🌿 Bereketli Vadi & Çayır';

  if (cfg.type === 'COASTAL') {
    if (isWater) label = '🌊 Uçsuz Bucaksız Okyanus';
    else if (isShore) label = '🏖️ Kumsal & Deniz Sahili';
  } else if (cfg.type === 'LAKES') {
    if (isWater) label = '🏞️ Berrak Yayla Gölü';
    else if (isShore) label = '🏖️ Göl Kıyısı Kumsalı';
  } else if (cfg.type === 'RIVER') {
    if (isWater) label = '🌊 Nehir Yatağı';
    else if (isShore) label = '🏖️ Nehir Kenarı Kumsalı';
  } else if (cfg.type === 'INLAND') {
    if (isWater) label = '💧 Küçük Vadi Deresi';
    else if (isShore) label = '🌾 Dere Kenarı Otlak';
  }

  if (!isWater && !isShore) {
    if (h > 6.8) label = '🏔️ Karlı Dağ Zirvesi';
    else if (h > 3.2) label = '🪨 Dağ Yamacı & Kayalık';
    else label = '🌿 Bereketli Ova & İnşaat Alanı';
  }

  return { isWater, isShore, label };
}

// Yürünebilirlik & Kuru Zemin Kontrolü (Köylülerin suya girmesini engeller)
function isWalkableLand(x, z) {
  if (!currentNoise) return true;
  const h = getTerrainHeight(x, z, currentNoise, currentMapConfig);
  return h >= 0.40;
}

// Güvenli Yürüme Hedefi Hesaplayıcı (Hedef suyun içindeyse kıyıda durdurur)
function getSafeWalkTarget(fromX, fromZ, targetX, targetZ) {
  const targetH = getTerrainHeight(targetX, targetZ, currentNoise, currentMapConfig);
  if (targetH >= 0.42) {
    return { x: targetX, z: targetZ, isWaterBlocked: false };
  }

  const dx = targetX - fromX;
  const dz = targetZ - fromZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.2) return { x: fromX, z: fromZ, isWaterBlocked: true };

  // Hedef noktasından köylüye doğru geri adımlarla ilk kuru kıyı noktasını (h >= 0.48) bul
  for (let d = dist; d > 0.3; d -= 0.5) {
    const t = d / dist;
    const px = fromX + dx * t;
    const pz = fromZ + dz * t;
    const ph = getTerrainHeight(px, pz, currentNoise, currentMapConfig);
    if (ph >= 0.48) {
      return { x: px, z: pz, isWaterBlocked: true };
    }
  }

  return { x: fromX, z: fromZ, isWaterBlocked: true };
}

// Bildirim Mesajı Gösterici (Toast HUD)
let toastTimer = null;
function showNotification(text) {
  const toast = document.getElementById('game-toast');
  if (!toast) return;
  toast.textContent = text;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, 2600);
}


// ==========================================================================
// 3. YERLEŞİMCİLER (KOLONİSTLER & TOPLU SEÇİM)
// ==========================================================================
const colonists = [];
let selectedColonists = []; // Toplu seçim dizisi

class Colonist {
  constructor({ id, name, role, color, x, z }) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.color = color;
    this.speed = 3.6;
    this.health = 100;
    this.hunger = 85;
    this.energy = 90;
    this.task = 'Kampta Dinleniyor';
    this.assignedSite = null;
    this.assignedHarvest = null; // Aktif toplanan ağaç, kaya veya çalı
    this.harvestTimer = 0;

    this.targetPos = null;
    this.isMoving = false;
    this.idleTimer = Math.random() * 5 + 3;

    this.group = new THREE.Group();
    this.createModel(color);

    const h = getTerrainHeight(x, z, currentNoise, currentMapConfig);
    this.group.position.set(x, h, z);
    worldGroup.add(this.group);

    // Bireysel Seçim Halkası
    const ringGeo = new THREE.RingGeometry(0.42, 0.54, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.position.y = 0.03;
    this.selectionRing.visible = false;
    this.group.add(this.selectionRing);
  }

  createModel(tunicColorHex) {
    // Klasik Koloni Oyunları Tarzı: Yumuşak, yuvarlatılmış, organik ortaçağ köylüleri (Blok/Minecraft DEĞİL!)
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xf5cfb0, roughness: 0.65 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.2 });
    const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x452a16, roughness: 0.8 });
    const tunicMat = new THREE.MeshStandardMaterial({ color: tunicColorHex, roughness: 0.7 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 });
    const leatherMat = new THREE.MeshStandardMaterial({ color: 0x54361c, roughness: 0.7 });
    const apronMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.75 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x7c4f24, roughness: 0.85 });

    // 1. Ayaklar ve Kıvrımlı Deri Çizmeler (Yuvarlak, yumuşak form)
    const legGeo = new THREE.CylinderGeometry(0.075, 0.065, 0.36, 14);
    const bootCuffGeo = new THREE.CylinderGeometry(0.085, 0.095, 0.18, 14);
    const bootToeGeo = new THREE.SphereGeometry(0.075, 10, 8);

    // Sol Bacak (Tam zemin teması y=0.0)
    this.leftLeg = new THREE.Group();
    this.leftLeg.position.set(-0.11, 0.38, 0);
    const lp = new THREE.Mesh(legGeo, pantsMat);
    lp.position.y = -0.1;
    lp.castShadow = true;
    this.leftLeg.add(lp);

    const lb = new THREE.Mesh(bootCuffGeo, leatherMat);
    lb.position.set(0, -0.23, 0.01);
    lb.castShadow = true;
    this.leftLeg.add(lb);

    const lt = new THREE.Mesh(bootToeGeo, leatherMat);
    lt.scale.set(1.0, 0.75, 1.4);
    lt.position.set(0, -0.32, 0.07);
    lt.castShadow = true;
    this.leftLeg.add(lt);
    this.group.add(this.leftLeg);

    // Sağ Bacak (Tam zemin teması y=0.0)
    this.rightLeg = new THREE.Group();
    this.rightLeg.position.set(0.11, 0.38, 0);
    const rp = new THREE.Mesh(legGeo, pantsMat);
    rp.position.y = -0.1;
    rp.castShadow = true;
    this.rightLeg.add(rp);

    const rb = new THREE.Mesh(bootCuffGeo, leatherMat);
    rb.position.set(0, -0.23, 0.01);
    rb.castShadow = true;
    this.rightLeg.add(rb);

    const rt = new THREE.Mesh(bootToeGeo, leatherMat);
    rt.scale.set(1.0, 0.75, 1.4);
    rt.position.set(0, -0.32, 0.07);
    rt.castShadow = true;
    this.rightLeg.add(rt);
    this.group.add(this.rightLeg);

    // 2. Gövde (Yuvarlak omuzlu Ortaçağ Köylü Tuniği)
    this.torso = new THREE.Group();
    this.torso.position.set(0, 0.66, 0);

    const tunicGeo = new THREE.CylinderGeometry(0.20, 0.25, 0.50, 16);
    this.body = new THREE.Mesh(tunicGeo, tunicMat);
    this.body.castShadow = true;
    this.torso.add(this.body);

    // Omuz Yumuşatıcıları (Doğal omuz kavisi)
    [-0.20, 0.20].forEach(ox => {
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), tunicMat);
      shoulder.position.set(ox, 0.20, 0);
      shoulder.castShadow = true;
      this.torso.add(shoulder);
    });

    // Bel Kemeri ve Tokası
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.07, 16), leatherMat);
    belt.position.y = -0.07;
    this.torso.add(belt);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.03), new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.3, metalness: 0.8 }));
    buckle.position.set(0, -0.07, 0.23);
    this.torso.add(buckle);

    // Yan Deri Kese
    const pouch = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 10), leatherMat);
    pouch.scale.set(0.9, 1.1, 0.9);
    pouch.position.set(0.21, -0.09, 0.06);
    this.torso.add(pouch);

    // Demir: Marangoz Önlüğü
    if (this.id === 1) {
      const apron = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.40, 0.04), apronMat);
      apron.position.set(0, -0.04, 0.22);
      this.torso.add(apron);
    }

    // Kerem: Omuz Askısı ve Sırt Sadakı (Ok Çantası)
    if (this.id === 3) {
      const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 16), leatherMat);
      strap.rotation.z = Math.PI / 4;
      strap.position.set(0, 0.05, 0);
      this.torso.add(strap);

      const quiver = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.45, 12), leatherMat);
      quiver.rotation.z = -0.35;
      quiver.position.set(-0.14, 0.12, -0.22);
      this.torso.add(quiver);
    }

    // 3. Kollar & Eller (Eklem yerlerinden yumuşakça sallanan doğal kollar)
    const armGeo = new THREE.CylinderGeometry(0.06, 0.05, 0.32, 14);
    const handGeo = new THREE.SphereGeometry(0.055, 12, 12);

    this.leftArm = new THREE.Group();
    this.leftArm.position.set(-0.28, 0.18, 0);
    const ls = new THREE.Mesh(armGeo, tunicMat);
    ls.position.y = -0.15;
    ls.castShadow = true;
    this.leftArm.add(ls);
    const lh = new THREE.Mesh(handGeo, skinMat);
    lh.position.y = -0.31;
    this.leftArm.add(lh);
    this.torso.add(this.leftArm);

    this.rightArm = new THREE.Group();
    this.rightArm.position.set(0.28, 0.18, 0);
    const rs = new THREE.Mesh(armGeo, tunicMat);
    rs.position.y = -0.15;
    rs.castShadow = true;
    this.rightArm.add(rs);
    const rh = new THREE.Mesh(handGeo, skinMat);
    rh.position.y = -0.31;
    this.rightArm.add(rh);

    // Rol El Aletleri:
    if (this.id === 1) { // Demir: Marangoz Çekici & Balta
      const hHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.40, 8), woodMat);
      hHandle.rotation.x = Math.PI / 2;
      hHandle.position.set(0, -0.31, 0.12);
      this.rightArm.add(hHandle);
      const hHead = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.15), ironMat);
      hHead.rotation.x = Math.PI / 2;
      hHead.position.set(0, -0.31, 0.28);
      this.rightArm.add(hHead);
    } else if (this.id === 2) { // Aylin: Hasır Erzak Sepeti
      const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.10, 0.22, 12), new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.9 }));
      basket.position.set(0, -0.32, 0.12);
      this.rightArm.add(basket);
      const wheatT = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.8 }));
      wheatT.position.set(0, -0.24, 0.12);
      this.rightArm.add(wheatT);
    } else { // Kerem: Avcı Yayı
      const bow = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.02, 8, 16, Math.PI), woodMat);
      bow.rotation.y = Math.PI / 2;
      bow.position.set(0, -0.28, 0);
      this.rightArm.add(bow);
    }
    this.torso.add(this.rightArm);

    // 4. Boyun, Baş, Canlı Gözler ve Ortaçağ Şapkaları
    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 0.38, 0);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.12, 12), skinMat);
    neck.position.y = -0.06;
    this.headGroup.add(neck);

    // Pürüzsüz Yuvarlak Kafa
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), skinMat);
    this.head.scale.set(1.0, 1.10, 1.05);
    this.head.castShadow = true;
    this.headGroup.add(this.head);

    // Canlı Parlak Gözler (Siyah boncuk + beyaz ışıltı glinti)
    [-0.062, 0.062].forEach(ex => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 10), eyeMat);
      eye.position.set(ex, 0.03, 0.165);
      this.headGroup.add(eye);

      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.007, 6, 6), glintMat);
      glint.position.set(ex + 0.006, 0.04, 0.182);
      this.headGroup.add(glint);
    });

    // Sevimli Burun
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.034, 10, 10), skinMat);
    nose.position.set(0, 0.00, 0.185);
    this.headGroup.add(nose);

    // Saç (Kafanın arkasını ve yanlarını örter)
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.185, 14, 14), hairMat);
    hair.position.set(0, 0.04, -0.03);
    hair.scale.set(1.02, 1.06, 1.04);
    this.headGroup.add(hair);

    // Otantik Ortaçağ Başlıkları:
    if (this.id === 1) { // Demir: Marangoz Kasketi
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.09, 14), leatherMat);
      cap.position.set(0, 0.16, -0.02);
      cap.rotation.x = -0.15;
      this.headGroup.add(cap);
    } else if (this.id === 2) { // Aylin: Klasik Çiftçi Hasır Şapkası
      const strawMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, roughness: 0.85 });
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.025, 16), strawMat);
      brim.position.set(0, 0.14, 0);
      this.headGroup.add(brim);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), strawMat);
      crown.scale.set(1.1, 0.8, 1.1);
      crown.position.set(0, 0.19, 0);
      this.headGroup.add(crown);
    } else { // Kerem: Avcı Pelerin Kukuletası & Kırmızı Tüy
      const hoodMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.8 });
      const hood = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.24, 14), hoodMat);
      hood.position.set(0, 0.19, -0.04);
      hood.rotation.x = -0.22;
      this.headGroup.add(hood);
      const feather = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.20, 6), new THREE.MeshStandardMaterial({ color: 0xef4444 }));
      feather.position.set(0.15, 0.22, 0);
      feather.rotation.z = -0.4;
      this.headGroup.add(feather);
    }

    this.torso.add(this.headGroup);
    this.group.add(this.torso);

    // Tıklanma / Seçim Çarpışma Kutusu
    const hitBox = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 1.4, 8),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitBox.position.set(0, 0.7, 0);
    hitBox.userData = { colonist: this };
    this.group.add(hitBox);
  }

  setSelected(isSelected) {
    this.selectionRing.visible = isSelected;
  }

  setTarget(x, z, customTask = 'Hedefe İlerliyor') {
    const curX = this.group.position.x;
    const curZ = this.group.position.z;
    const safe = getSafeWalkTarget(curX, curZ, x, z);
    this.targetPos = new THREE.Vector2(safe.x, safe.z);
    this.isMoving = true;
    this.task = safe.isWaterBlocked ? 'Kıyıda Durdu (Su Geçilmez)' : customTask;
    updateSelectionUI();
  }

  assignToSite(site) {
    this.assignedSite = site;
    this.assignedHarvest = null;
    this.setTarget(site.pos.x, site.pos.z, `İnşa Ediyor: ${site.def.name}`);
  }

  assignHarvest(entity) {
    if (!entity || entity.isDepleted) return;
    this.assignedHarvest = entity;
    this.assignedSite = null;
    const curX = this.group.position.x;
    const curZ = this.group.position.z;
    const dx = entity.pos.x - curX;
    const dz = entity.pos.z - curZ;
    const dist = Math.hypot(dx, dz);
    // Kaynağın 1.3m yakınında duracak şekilde hedef al
    const standX = entity.pos.x - (dx / Math.max(0.1, dist)) * 1.3;
    const standZ = entity.pos.z - (dz / Math.max(0.1, dist)) * 1.3;
    this.setTarget(standX, standZ, `Topluyor: ${entity.name}`);
  }

  update(delta, time) {
    if (this.isMoving && this.targetPos) {
      const curX = this.group.position.x;
      const curZ = this.group.position.z;
      const dx = this.targetPos.x - curX;
      const dz = this.targetPos.y - curZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > 0.25) {
        const moveDist = Math.min(dist, this.speed * delta);
        const nx = curX + (dx / dist) * moveDist;
        const nz = curZ + (dz / dist) * moveDist;
        const ny = getTerrainHeight(nx, nz, currentNoise, currentMapConfig);

        // Bir sonraki adım su veya kumsal altı ise derhal dur!
        if (ny < 0.38) {
          this.isMoving = false;
          this.targetPos = null;
          this.leftLeg.rotation.x = 0;
          this.rightLeg.rotation.x = 0;
          if (this.leftArm) this.leftArm.rotation.x = 0;
          if (this.rightArm) this.rightArm.rotation.x = 0;
          this.task = 'Kıyıda Durdu (Su Geçilmez)';
          this.group.position.y = getTerrainHeight(curX, curZ, currentNoise, currentMapConfig);
          updateSelectionUI();
          return;
        }

        this.group.position.set(nx, ny, nz);
        this.group.rotation.y = Math.atan2(dx, dz);

        // Doğal Yürüme: Bacaklar ve Kollar zıt salınır
        const swing = Math.sin(time * 11) * 0.45;
        this.leftLeg.rotation.x = swing;
        this.rightLeg.rotation.x = -swing;
        if (this.leftArm) this.leftArm.rotation.x = -swing * 0.7;
        if (this.rightArm) this.rightArm.rotation.x = swing * 0.7;
        this.torso.position.y = 0.66 + Math.abs(Math.sin(time * 11)) * 0.03;
      } else {
        this.isMoving = false;
        this.targetPos = null;
        this.leftLeg.rotation.x = 0;
        this.rightLeg.rotation.x = 0;
        if (this.leftArm) this.leftArm.rotation.x = 0;
        if (this.rightArm) this.rightArm.rotation.x = 0;

        // Zemine tam oturt
        this.group.position.y = getTerrainHeight(this.group.position.x, this.group.position.z, currentNoise, currentMapConfig);

        if (this.assignedSite && !this.assignedSite.isComplete) {
          this.task = `İnşa Ediyor: ${this.assignedSite.def.name}`;
        } else if (this.assignedHarvest && !this.assignedHarvest.isDepleted) {
          this.task = `Topluyor: ${this.assignedHarvest.name}`;
        } else {
          this.task = 'Kampta Dinleniyor';
        }
        updateSelectionUI();
      }
    } else {
      // 1. İnşaat Çekiç Sallama Animasyonu
      if (this.assignedSite && !this.assignedSite.isComplete) {
        if (this.rightArm) {
          this.rightArm.rotation.x = -Math.PI / 4 + Math.sin(time * 14) * 0.6;
        }
        this.torso.rotation.x = Math.sin(time * 14) * 0.12;
        this.assignedSite.advanceBuild(delta * 25);
      }
      // 2. Doğal Kaynak Toplama (Odun Kesme / Taş Kırma / Meyve Toplama)
      else if (this.assignedHarvest) {
        if (this.assignedHarvest.isDepleted || this.assignedHarvest.currentRes <= 0) {
          // Bu kaynak tükendi, yakınlardaki aynı türden başka bir kaynak ara (Otomasyon)
          const nextEntity = findNearbyResource(this.group.position.x, this.group.position.z, this.assignedHarvest.resType, 22.0);
          if (nextEntity) {
            this.assignHarvest(nextEntity);
          } else {
            this.assignedHarvest = null;
            this.task = 'Kampta Dinleniyor';
            if (this.rightArm) this.rightArm.rotation.x = 0;
            this.torso.rotation.x = 0;
            updateSelectionUI();
          }
        } else {
          // Kaynağa yüzünü dön
          const fdx = this.assignedHarvest.pos.x - this.group.position.x;
          const fdz = this.assignedHarvest.pos.z - this.group.position.z;
          this.group.rotation.y = Math.atan2(fdx, fdz);

          // Kol Sallama ve Çalışma Hareketi (Balta / Kazma / Sepet)
          if (this.rightArm) {
            this.rightArm.rotation.x = -Math.PI / 3 + Math.sin(time * 12) * 0.7;
          }
          this.torso.rotation.x = Math.sin(time * 12) * 0.10;

          // Kaynak Toplama Periyodu (Her 1.4 saniyede bir kaynak ekle)
          this.harvestTimer += delta;
          if (this.harvestTimer >= 1.4) {
            this.harvestTimer = 0;
            this.assignedHarvest.currentRes = Math.max(0, this.assignedHarvest.currentRes - 2);
            const gathered = 2;
            resources[this.assignedHarvest.resType] = (resources[this.assignedHarvest.resType] || 0) + gathered;
            updateResourceUI();

            // Yüzen Kaynak Efekti (Tactile RTS Hissi)
            spawnFloatingHarvestFeedback(this.assignedHarvest.pos, this.assignedHarvest.resType, gathered);

            if (this.assignedHarvest.currentRes <= 0) {
              depleteHarvestEntity(this.assignedHarvest.id, true);
              const nextEntity = findNearbyResource(this.group.position.x, this.group.position.z, this.assignedHarvest.resType, 24.0);
              if (nextEntity) {
                this.assignHarvest(nextEntity);
              } else {
                this.assignedHarvest = null;
                this.task = 'Kampta Dinleniyor';
                if (this.rightArm) this.rightArm.rotation.x = 0;
                this.torso.rotation.x = 0;
                updateSelectionUI();
              }
            }
          }
        }
      }
      // 3. Boşta Kalma (Idle)
      else {
        this.torso.rotation.x = 0;
        if (this.rightArm) this.rightArm.rotation.x = 0;
        this.torso.position.y = 0.66 + Math.sin(time * 2 + this.id) * 0.015;

        // Her zaman arazi yüksekliğine tam kilitli kal (Asla havada kalmaz)
        this.group.position.y = getTerrainHeight(this.group.position.x, this.group.position.z, currentNoise, currentMapConfig);

        // Rastgele Kamp Etrafı Gezinme
        this.idleTimer -= delta;
        if (this.idleTimer <= 0) {
          this.idleTimer = Math.random() * 8 + 6;
          if (Math.random() < 0.45) {
            const wanderAngle = Math.random() * Math.PI * 2;
            const wanderDist = 1.2 + Math.random() * 3.8;
            const wanderX = campPos.x + Math.cos(wanderAngle) * wanderDist;
            const wanderZ = campPos.z + Math.sin(wanderAngle) * wanderDist;
            if (isWalkableLand(wanderX, wanderZ)) {
              this.setTarget(wanderX, wanderZ, 'Kamp Çevresinde Dolanıyor');
            }
          }
        }
      }
    }
  }
}

// ==========================================================================
// 3.1 DOĞAL KAYNAK TOPLAMA VE EFECT YARDIMCILARI (HARVESTING HELPERS)
// ==========================================================================
function findNearbyResource(x, z, resType, maxRadius = 25.0) {
  let closest = null;
  let minDist = maxRadius;
  harvestableEntities.forEach(entity => {
    if (!entity.isDepleted && entity.currentRes > 0 && entity.resType === resType) {
      const d = Math.hypot(entity.pos.x - x, entity.pos.z - z);
      if (d < minDist) {
        minDist = d;
        closest = entity;
      }
    }
  });
  return closest;
}

function depleteHarvestEntity(entityId, broadcastToServer = true) {
  const entity = harvestableEntities.get(entityId);
  if (!entity || entity.isDepleted) return;

  entity.isDepleted = true;
  entity.currentRes = 0;

  // Tüm bağlı InstancedMesh parçalarını sıfır boyutuna çekerek görünmez yap
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  if (entity.meshes && entity.meshes.length > 0) {
    entity.meshes.forEach(mInfo => {
      if (mInfo.mesh && mInfo.mesh.instanceMatrix) {
        mInfo.mesh.setMatrixAt(mInfo.index, zeroMatrix);
        mInfo.mesh.instanceMatrix.needsUpdate = true;
      }
    });
  }

  // Parçacık Patlaması Efekti (Odun talaşı veya taş kırığı)
  spawnDepletionParticles(entity.pos, entity.resType);

  // Eğer bu kaynak Inspector panelinde açıksa UI'ı güncelle
  if (selectedHarvestEntity && selectedHarvestEntity.id === entityId) {
    const statusVal = document.getElementById('res-status-val');
    if (statusVal) {
      statusVal.textContent = 'Tükendi (Yenisi Yetişiyor)';
      statusVal.className = 'value text-danger';
    }
    const harvestBtn = document.getElementById('btn-harvest-action');
    if (harvestBtn) harvestBtn.disabled = true;
  }

  // Çok Oyunculu Sunucuya Bildir (Tüm bağlı oyuncular için de bu ağaç devrilsin)
  if (broadcastToServer && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'HARVEST_COMPLETED',
      entityId: entity.id,
      resType: entity.resType,
      amount: entity.yieldAmount || 15
    }));
  }

  const resIcon = entity.resType === 'wood' ? '🪵' : (entity.resType === 'stone' ? '🪨' : '🍞');
  showNotification(`✨ ${entity.name} başarıyla toplandı! (${resIcon} +${entity.yieldAmount || 15})`);
}

function assignHarvestToSelectedColonists(entity) {
  if (!entity || entity.isDepleted) return;
  const workers = selectedColonists.length > 0 ? selectedColonists : [colonists[0]];

  workers.forEach(w => {
    w.assignHarvest(entity);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'HARVEST_RESOURCE',
        colonistId: w.id,
        entityId: entity.id,
        resType: entity.resType
      }));
    }
  });

  const names = workers.map(w => w.name).join(', ');
  showNotification(`🪓 ${names} -> ${entity.name} toplamaya gönderildi.`);
}

function spawnFloatingHarvestFeedback(pos, resType, amount) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const icon = resType === 'wood' ? '🪵' : (resType === 'stone' ? '🪨' : '🍞');
  const color = resType === 'wood' ? '#f59e0b' : (resType === 'stone' ? '#94a3b8' : '#22c55e');

  ctx.fillStyle = color;
  ctx.font = 'bold 30px Outfit, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${icon} +${amount}`, 64, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 1.0 });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y + 1.8, pos.z + (Math.random() - 0.5) * 0.4);
  sprite.scale.set(1.4, 0.7, 1);
  scene.add(sprite);

  particleEffects.push({
    mesh: sprite,
    lifetime: 0.9,
    maxLifetime: 0.9,
    update: (delta) => {
      sprite.position.y += delta * 1.4;
      sprite.material.opacity = Math.max(0, sprite.material.opacity - delta * 1.1);
    }
  });
}

function spawnDepletionParticles(pos, resType) {
  const color = resType === 'wood' ? 0x78350f : (resType === 'stone' ? 0x64748b : 0x15803d);
  const pMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.8 });
  const count = 7;

  for (let i = 0; i < count; i++) {
    const pMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), pMat);
    pMesh.position.set(pos.x, pos.y + 0.8, pos.z);
    scene.add(pMesh);

    const vx = (Math.random() - 0.5) * 2.8;
    const vy = 1.8 + Math.random() * 2.2;
    const vz = (Math.random() - 0.5) * 2.8;
    let age = 0;

    particleEffects.push({
      mesh: pMesh,
      lifetime: 1.1,
      maxLifetime: 1.1,
      update: (delta) => {
        age += delta;
        pMesh.position.x += vx * delta;
        pMesh.position.y += (vy - age * 5.5) * delta;
        pMesh.position.z += vz * delta;
        pMesh.rotation.x += delta * 4;
        pMesh.rotation.y += delta * 5;
        pMesh.scale.multiplyScalar(0.97);
      }
    });
  }
}

// ==========================================================================
// 4. MİMAR & İNŞAAT KATALOĞU (BUILD SYSTEM)
// ==========================================================================
const BUILDINGS = {
  hut: {
    id: 'hut',
    name: 'Ahşap Kulübe',
    desc: 'Yerleşimcilerin barınmasını sağlar (+3 Nüfus).',
    category: 'housing',
    cost: { wood: 40, stone: 0 },
    effect: () => { resources.maxPop += 3; updateResourceUI(); },
    createModel: () => {
      const g = new THREE.Group();
      // 1. Taş Temel
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.9, flatShading: true });
      const foundation = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.35, 2.3), stoneMat);
      foundation.position.y = 0.175;
      foundation.receiveShadow = true;
      foundation.castShadow = true;
      g.add(foundation);

      // 2. Kütük Duvarlar (Sıcak meşe ağacı kütükleri)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85, flatShading: true });
      const walls = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.4, 2.0), woodMat);
      walls.position.y = 1.05;
      walls.castShadow = true;
      g.add(walls);

      // 3. Çift Eğimli Çatı (Kiremit / Ahşap Shingle & Saçaklar)
      const roofMat = new THREE.MeshStandardMaterial({ color: 0xa16207, roughness: 0.8, flatShading: true });
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.1, 4), roofMat);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(1.15, 1.0, 0.95);
      roof.position.y = 2.3;
      roof.castShadow = true;
      g.add(roof);

      // Çatı Mahya Kütüğü
      const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 6), woodMat);
      ridge.rotation.z = Math.PI / 2;
      ridge.position.y = 2.85;
      g.add(ridge);

      // 4. Taş Baca
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, 0.35), stoneMat);
      chimney.position.set(0.7, 2.4, -0.4);
      chimney.castShadow = true;
      g.add(chimney);

      // 5. Ahşap Kapı & Demir Halka
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.95), new THREE.MeshStandardMaterial({ color: 0x3d2109 }));
      door.position.set(0, 0.85, 1.01);
      g.add(door);

      // 6. Sıcak Işıklı Pencere (Mum / Şömine Işığı Efekti)
      const winMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xf59e0b, emissiveIntensity: 0.7 });
      const window1 = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), winMat);
      window1.position.set(0.65, 1.15, 1.01);
      g.add(window1);

      // 7. Yan Tarafta Odun Yığını ve Su Fıçısı
      const barrelMat = new THREE.MeshStandardMaterial({ color: 0x54361c, roughness: 0.85 });
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.45, 8), barrelMat);
      barrel.position.set(-1.0, 0.4, 0.8);
      barrel.castShadow = true;
      g.add(barrel);

      const logMat = new THREE.MeshStandardMaterial({ color: 0x2e1808 });
      for (let i = 0; i < 3; i++) {
        const firewood = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 6), logMat);
        firewood.rotation.z = Math.PI / 2;
        firewood.position.set(1.0, 0.25 + i * 0.12, 0.7);
        g.add(firewood);
      }
      return g;
    }
  },
  tent: {
    id: 'tent',
    name: 'Basit Çadır',
    desc: 'Hızlı ve ucuz sığınak (+1 Nüfus).',
    category: 'housing',
    cost: { wood: 20, stone: 0 },
    effect: () => { resources.maxPop += 1; updateResourceUI(); },
    createModel: () => {
      const g = new THREE.Group();
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x54361c, roughness: 0.9 });
      // Çapraz A-Frame Direkleri
      for (let side of [-0.7, 0.7]) {
        const pole1 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.6, 6), woodMat);
        pole1.rotation.z = 0.4;
        pole1.position.set(-0.3, 0.75, side);
        pole1.castShadow = true;
        g.add(pole1);

        const pole2 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.6, 6), woodMat);
        pole2.rotation.z = -0.4;
        pole2.position.set(0.3, 0.75, side);
        pole2.castShadow = true;
        g.add(pole2);
      }

      // Üst Mahya Direği
      const ridgePole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.8, 6), woodMat);
      ridgePole.rotation.x = Math.PI / 2;
      ridgePole.position.set(0, 1.35, 0);
      g.add(ridgePole);

      // Kumaş / Çadır Tentesi
      const canvasMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.9, flatShading: true, side: THREE.DoubleSide });
      const tentGeo = new THREE.CylinderGeometry(0.7, 0.7, 1.4, 3, 1, false, 0, Math.PI);
      const tentMesh = new THREE.Mesh(tentGeo, canvasMat);
      tentMesh.rotation.z = Math.PI / 2;
      tentMesh.scale.set(1.0, 1.2, 1.2);
      tentMesh.position.set(0, 0.7, 0);
      tentMesh.castShadow = true;
      g.add(tentMesh);

      // İple Asılı Fener
      const lanternMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xf59e0b, emissiveIntensity: 1.2 });
      const lantern = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09, 0), lanternMat);
      lantern.position.set(0, 1.1, 0.75);
      g.add(lantern);

      // İçeride Hasır Yatak
      const bed = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 1.1), new THREE.MeshStandardMaterial({ color: 0x92400e }));
      bed.position.set(0, 0.05, 0);
      g.add(bed);
      return g;
    }
  },
  farm: {
    id: 'farm',
    name: 'Tahıl Tarlası',
    desc: 'Düzenli erzak üretir (+2 Erzak / 5sn).',
    category: 'food',
    cost: { wood: 25, stone: 0 },
    effect: () => {
      setInterval(() => { resources.food += 2; updateResourceUI(); }, 5000);
    },
    createModel: () => {
      const g = new THREE.Group();
      // Sürülmüş Verimli Toprak Yatağı
      const soilMat = new THREE.MeshStandardMaterial({ color: 0x54361c, roughness: 0.95 });
      const soil = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.18, 2.8), soilMat);
      soil.position.y = 0.09;
      soil.receiveShadow = true;
      g.add(soil);

      // Ahşap Çiftlik Çiti
      const fenceMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.9 });
      const postCoords = [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3], [0, -1.3], [-1.3, 0], [1.3, 0]];
      postCoords.forEach(([px, pz]) => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.55, 5), fenceMat);
        post.position.set(px, 0.35, pz);
        post.castShadow = true;
        g.add(post);
      });

      // Altın Sarısı Başaklar (Sıralı Ekinler)
      const wheatMat = new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.75, flatShading: true });
      const stemMat = new THREE.MeshStandardMaterial({ color: 0x65a30d, roughness: 0.8 });
      for (let z = -0.9; z <= 0.9; z += 0.45) {
        for (let x = -0.9; x <= 0.9; x += 0.35) {
          const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.35, 4), stemMat);
          stalk.position.set(x, 0.25, z);
          g.add(stalk);
          const head = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 5), wheatMat);
          head.position.set(x, 0.45, z);
          g.add(head);
        }
      }

      // Sevimli Korkuluk
      const scarecrow = new THREE.Group();
      scarecrow.position.set(0, 0, 0);
      const sPost = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5), fenceMat);
      sPost.position.y = 0.45;
      scarecrow.add(sPost);
      const sArms = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 5), fenceMat);
      sArms.rotation.z = Math.PI / 2;
      sArms.position.y = 0.65;
      scarecrow.add(sArms);
      const sHead = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), new THREE.MeshStandardMaterial({ color: 0xfef08a }));
      sHead.position.y = 0.85;
      scarecrow.add(sHead);
      const sHat = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.12, 6), new THREE.MeshStandardMaterial({ color: 0x92400e }));
      sHat.position.y = 0.96;
      scarecrow.add(sHat);
      g.add(scarecrow);
      return g;
    }
  },
  woodcutter: {
    id: 'woodcutter',
    name: 'Oduncu Kulübesi',
    desc: 'Kereste üretir (+3 Odun / 5sn).',
    category: 'industry',
    cost: { wood: 45, stone: 15 },
    effect: () => {
      setInterval(() => { resources.wood += 3; updateResourceUI(); }, 5000);
    },
    createModel: () => {
      const g = new THREE.Group();
      const timberMat = new THREE.MeshStandardMaterial({ color: 0x452b17, roughness: 0.85, flatShading: true });
      // 4 Destek Direği
      const p1 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 1.5, 6), timberMat);
      p1.position.set(-0.9, 0.75, -0.7); p1.castShadow = true; g.add(p1);
      const p2 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 1.5, 6), timberMat);
      p2.position.set(0.9, 0.75, -0.7); p2.castShadow = true; g.add(p2);
      const p3 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 1.2, 6), timberMat);
      p3.position.set(-0.9, 0.6, 0.7); p3.castShadow = true; g.add(p3);
      const p4 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 1.2, 6), timberMat);
      p4.position.set(0.9, 0.6, 0.7); p4.castShadow = true; g.add(p4);

      // Eğimli Sundurma Çatısı
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 0.1, 1.8),
        new THREE.MeshStandardMaterial({ color: 0x2e1808, roughness: 0.9 })
      );
      roof.rotation.x = 0.2;
      roof.position.set(0, 1.45, 0);
      roof.castShadow = true;
      g.add(roof);

      // Kütük Yarma Kütüğü ve Saplı Demir Balta
      const stump = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.35, 0.45, 8),
        new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.9 })
      );
      stump.position.set(0.2, 0.22, 0.2);
      stump.castShadow = true;
      g.add(stump);

      const axeHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.4, 5), timberMat);
      axeHandle.position.set(0.2, 0.55, 0.2);
      axeHandle.rotation.z = -0.3;
      g.add(axeHandle);
      const axeBlade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.03), new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8 }));
      axeBlade.position.set(0.22, 0.62, 0.2);
      g.add(axeBlade);

      // Yığılı Keresteler
      const logMat = new THREE.MeshStandardMaterial({ color: 0x54361c, roughness: 0.85 });
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3 - row; col++) {
          const woodLog = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 7), logMat);
          woodLog.rotation.z = Math.PI / 2;
          woodLog.position.set(-0.35 + col * 0.18 + row * 0.09, 0.1 + row * 0.16, -0.4);
          woodLog.castShadow = true;
          g.add(woodLog);
        }
      }
      return g;
    }
  },
  quarry: {
    id: 'quarry',
    name: 'Taş Ocağı',
    desc: 'Taş çıkarır (+2 Taş / 5sn).',
    category: 'industry',
    cost: { wood: 35, stone: 20 },
    effect: () => {
      setInterval(() => { resources.stone += 2; updateResourceUI(); }, 5000);
    },
    createModel: () => {
      const g = new THREE.Group();
      // Kazılmış Taş Zemin / Çukur
      const pitMat = new THREE.MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.9, flatShading: true });
      const pit = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.8, 0.35, 8), pitMat);
      pit.position.y = 0.17;
      pit.receiveShadow = true;
      g.add(pit);

      // Ham Granit Blokları
      const rockMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.85, flatShading: true });
      const b1 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.4, 0), rockMat);
      b1.position.set(0.6, 0.4, 0.5); b1.castShadow = true; g.add(b1);
      const b2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3, 0), rockMat);
      b2.position.set(-0.7, 0.35, 0.4); b2.castShadow = true; g.add(b2);

      // İşlenmiş Köşe Taşları
      const cutBlock = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.35), rockMat);
      cutBlock.position.set(0.7, 0.25, -0.5); cutBlock.castShadow = true; g.add(cutBlock);

      // Ahşap Vinç / Halatlı A-Frame Kaldıraç
      const craneMat = new THREE.MeshStandardMaterial({ color: 0x54361c, roughness: 0.85 });
      const legA = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.8, 6), craneMat);
      legA.rotation.z = 0.3; legA.position.set(-0.6, 0.85, -0.4); g.add(legA);
      const legB = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.8, 6), craneMat);
      legB.rotation.z = -0.3; legB.position.set(-0.1, 0.85, -0.4); g.add(legB);

      // Makaralı Halat ve Demir Taş Kovası
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.6, 4), new THREE.MeshStandardMaterial({ color: 0x94a3b8 }));
      rope.position.set(-0.35, 1.1, -0.4); g.add(rope);

      const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.14, 0.25, 7), new THREE.MeshStandardMaterial({ color: 0x18181b, metalness: 0.7 }));
      bucket.position.set(-0.35, 0.7, -0.4); bucket.castShadow = true; g.add(bucket);

      // Kazma & Balyoz
      const pickHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), craneMat);
      pickHandle.rotation.z = 0.6; pickHandle.position.set(0.2, 0.3, -0.7); g.add(pickHandle);
      const pickHead = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 4), new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8 }));
      pickHead.rotation.z = Math.PI / 2; pickHead.position.set(0.35, 0.45, -0.7); g.add(pickHead);
      return g;
    }
  }
};

// İnşaat Alanı (Construction Site)
class ConstructionSite {
  constructor(def, pos) {
    this.def = def;
    this.pos = pos;
    this.progress = 0;
    this.isComplete = false;

    this.group = new THREE.Group();
    this.group.position.set(pos.x, pos.y, pos.z);

    // İskele / Çit Çıtaları
    const woodMat = new THREE.MeshStandardMaterial({ color: 0xa16207, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 4; i++) {
      const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.8, 5), woodMat);
      const angle = (i * Math.PI) / 2;
      stake.position.set(Math.cos(angle) * 0.9, 0.4, Math.sin(angle) * 0.9);
      this.group.add(stake);
    }

    // Temel Zemin İşareti
    const basePlot = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.1, 2.0),
      new THREE.MeshStandardMaterial({ color: 0x713f12, roughness: 0.9 })
    );
    basePlot.position.y = 0.05;
    this.group.add(basePlot);

    worldGroup.add(this.group);
  }

  advanceBuild(amount) {
    if (this.isComplete) return;
    this.progress += amount;

    if (this.progress >= 100) {
      this.complete();
    }
  }

  complete() {
    this.isComplete = true;
    worldGroup.remove(this.group);

    // Gerçek Tamamlanmış Modeli Dik
    const finishedBuilding = this.def.createModel();
    finishedBuilding.position.set(this.pos.x, this.pos.y, this.pos.z);
    worldGroup.add(finishedBuilding);

    // Etkiyi Tetikle (+Nüfus, +Erzak vb.)
    this.def.effect();

    // Yakındaki inşa eden kolonistleri boşa çıkar
    colonists.forEach(c => {
      if (c.assignedSite === this) {
        c.assignedSite = null;
        c.task = 'Kampta Dinleniyor';
      }
    });
    updateSelectionUI();
  }
}

// Hayalet Önizleme (Ghost Preview Model)
let activeBuildingDef = null;
let ghostMesh = null;

function enterBuildMode(buildingId) {
  const def = BUILDINGS[buildingId];
  if (!def) return;

  // Kaynak Yeterli mi?
  if (resources.wood < def.cost.wood || resources.stone < (def.cost.stone || 0)) {
    alert(`Yetersiz Kaynak! Gereken: 🪵 ${def.cost.wood} Odun, 🪨 ${def.cost.stone || 0} Taş`);
    return;
  }

  activeBuildingDef = def;

  // Önceki hayaleti temizle
  if (ghostMesh) scene.remove(ghostMesh);

  ghostMesh = def.createModel();
  ghostMesh.traverse(child => {
    if (child.isMesh) {
      child.material = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.5,
        wireframe: false
      });
    }
  });
  ghostMesh.visible = false;
  scene.add(ghostMesh);

  // Çekmeceyi kapat
  const drawer = document.getElementById('build-drawer');
  if (drawer) drawer.style.display = 'none';
}

function cancelBuildMode() {
  activeBuildingDef = null;
  if (ghostMesh) {
    scene.remove(ghostMesh);
    ghostMesh = null;
  }
}

function tryPlaceBuilding(point) {
  if (!activeBuildingDef) return;

  // Su içine, kumsala veya dik dağ zirvesine bina yapımını engelle
  const waterInfo = getWaterInfoAt(point.x, point.z, point.y);
  if (waterInfo.isWater || waterInfo.isShore || point.y < 0.25 || point.y > 6.5) {
    showNotification('⚠️ Geçersiz konum: Su, kumsal veya dik yamaç üzerine inşa edilemez!');
    return;
  }

  const def = activeBuildingDef;

  // Kaynak Düşümü
  resources.wood -= def.cost.wood;
  resources.stone -= (def.cost.stone || 0);
  updateResourceUI();

  // İnşaat Alanını Başlat
  const site = new ConstructionSite(def, point);

  // En yakın uygun veya seçili kolonistleri inşaata yönlendir
  const workers = selectedColonists.length > 0 ? selectedColonists : [colonists[0]];
  workers.forEach(w => w.assignToSite(site));

  // Çok Oyunculu Sunucuya Bildir (Diğer oyuncuların dünyasında da aynı bina yükselsin!)
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'PLACE_BUILDING',
      defId: def.id,
      pos: { x: point.x, y: point.y, z: point.z },
      cost: def.cost
    }));
  }

  showNotification(`🔨 ${def.name} inşaatı başlatıldı!`);

  // İnşa modundan çık
  cancelBuildMode();
}

function spawnRemoteBuilding(buildingData) {
  const def = BUILDINGS[buildingData.defId];
  if (!def) return;
  const site = new ConstructionSite(def, buildingData.pos);
  const idleCol = colonists.find(c => !c.assignedSite && !c.assignedHarvest) || colonists[0];
  if (idleCol) idleCol.assignToSite(site);
  showNotification(`🔨 ${buildingData.builderName || 'Müttefik Oyuncu'} ${def.name} inşasına başladı!`);
}

// ==========================================================================
// 5. TOPLU SEÇİM (MARQUEE DRAG BOX) VE FARE ETKİLEŞİMİ
// ==========================================================================
const selectionBoxEl = document.getElementById('selection-box');
let isMouseDown = false;
let isDraggingBox = false;
let dragStart = { x: 0, y: 0 };

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2(-1000, -1000);
let mouseMoved = false;

window.addEventListener('pointermove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  mouseMoved = true;

  // Hayalet Önizlemeyi Fareyle Takip Ettir
  if (activeBuildingDef && ghostMesh && terrainMesh) {
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (hits.length > 0) {
      const p = hits[0].point;
      ghostMesh.visible = true;
      ghostMesh.position.set(Math.round(p.x), p.y + 0.05, Math.round(p.z));

      // Geçersiz konumda kırmızıya dön (Su, kumsal veya dik yamaç)
      const waterInfo = getWaterInfoAt(p.x, p.z, p.y);
      const isValid = (!waterInfo.isWater && !waterInfo.isShore && p.y >= 0.25 && p.y <= 6.5);

      ghostMesh.traverse(child => {
        if (child.isMesh && child.material) {
          child.material.color.setHex(isValid ? 0x38bdf8 : 0xef4444);
        }
      });
    } else {
      ghostMesh.visible = false;
    }
    return;
  }

  // Sürükleme Seçim Kutusu
  if (isMouseDown && !activeBuildingDef) {
    const dist = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
    if (dist > 8) {
      isDraggingBox = true;
      if (selectionBoxEl) {
        selectionBoxEl.style.display = 'block';
        const minX = Math.min(dragStart.x, e.clientX);
        const minY = Math.min(dragStart.y, e.clientY);
        const width = Math.abs(e.clientX - dragStart.x);
        const height = Math.abs(e.clientY - dragStart.y);

        selectionBoxEl.style.left = `${minX}px`;
        selectionBoxEl.style.top = `${minY}px`;
        selectionBoxEl.style.width = `${width}px`;
        selectionBoxEl.style.height = `${height}px`;
      }
    }
  }
});

let rightClickStart = { x: 0, y: 0 };

window.addEventListener('pointerdown', (e) => {
  if (e.target.tagName !== 'CANVAS') return;

  // İnşa Modundaysa Sol Tık ile Yerleştir
  if (e.button === 0 && activeBuildingDef) {
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (hits.length > 0) {
      tryPlaceBuilding(hits[0].point);
    }
    return;
  }

  // Sol Tık: Sürükleme / Seçim Başlangıcı (Kamera asla oynamaz)
  if (e.button === 0) {
    isMouseDown = true;
    dragStart = { x: e.clientX, y: e.clientY };
    isDraggingBox = false;
  }

  // Sağ Tık: Opera gesture engelleme ve tıklama konumu kaydetme
  if (e.button === 2) {
    e.preventDefault();
    rightClickStart = { x: e.clientX, y: e.clientY };
  }
});

window.addEventListener('pointerup', (e) => {
  // Sağ Tık Bırakıldığında: Sürükleme yapılmadıysa (dist < 8px) birimlere git veya kaynak topla emri ver!
  if (e.button === 2) {
    e.preventDefault();
    const dist = Math.hypot(e.clientX - rightClickStart.x, e.clientY - rightClickStart.y);
    if (dist < 8) {
      if (activeBuildingDef) {
        cancelBuildMode();
        return;
      }

      if (selectedColonists.length > 0) {
        raycaster.setFromCamera(mouse, camera);

        // 1. Önce Doğal Kaynaklara (Ağaç, Kaya, Çalı) Tıklanıp Tıklanmadığını Kontrol Et
        if (allHarvestMeshes.length > 0) {
          const harvestHits = raycaster.intersectObjects(allHarvestMeshes);
          if (harvestHits.length > 0) {
            const hit = harvestHits[0];
            const prefix = hit.object.userData.prefix;
            const entityId = prefix + hit.instanceId;
            const entity = harvestableEntities.get(entityId);

            if (entity && !entity.isDepleted) {
              selectedColonists.forEach(col => {
                col.assignHarvest(entity);
                if (socket && socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({
                    type: 'HARVEST_RESOURCE',
                    colonistId: col.id,
                    entityId: entity.id,
                    resType: entity.resType
                  }));
                }
              });

              const names = selectedColonists.map(c => c.name).join(', ');
              showNotification(`🪓 ${names} -> ${entity.name} toplamaya başladı!`);
              return; // Arazi hareketini engelle
            }
          }
        }

        // 2. Kaynak Değilse Normal Arazi Yürüme Emri Ver
        if (terrainMesh) {
          const hits = raycaster.intersectObject(terrainMesh);
          if (hits.length > 0) {
            const p = hits[0].point;
            let anyWaterBlocked = false;

            selectedColonists.forEach((col, idx) => {
              let ox = 0;
              let oz = 0;
              if (selectedColonists.length > 1) {
                const angle = (idx / selectedColonists.length) * Math.PI * 2;
                ox = Math.cos(angle) * 1.2;
                oz = Math.sin(angle) * 1.2;
              }
              const curX = col.group.position.x;
              const curZ = col.group.position.z;
              const safe = getSafeWalkTarget(curX, curZ, p.x + ox, p.z + oz);
              if (safe.isWaterBlocked) anyWaterBlocked = true;

              col.assignedHarvest = null; // Manuel hareket verildiğinde kaynak toplamayı bırak
              col.setTarget(safe.x, safe.z, safe.isWaterBlocked ? 'Kıyıda Durdu (Su Geçilmez)' : 'Hedefe İlerliyor');

              // Online Çok Oyunculu Senkronizasyon (Birim hareketini diğer oyunculara gönder)
              if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                  type: 'COMMAND_COLONIST',
                  colonistId: col.id,
                  targetX: safe.x,
                  targetZ: safe.z,
                  task: col.task
                }));
              }
            });

            if (anyWaterBlocked) {
              showNotification('💧 Su derin! Birimler güvenli kıyı şeridine yönlendirildi.');
            }
          }
        }
      }
    }
    return;
  }

  if (e.button !== 0) return;
  isMouseDown = false;

  if (isDraggingBox) {
    isDraggingBox = false;
    if (selectionBoxEl) selectionBoxEl.style.display = 'none';

    // Bounding Box İçindeki Tüm Kolonistleri Yakala
    const minX = Math.min(dragStart.x, e.clientX);
    const maxX = Math.max(dragStart.x, e.clientX);
    const minY = Math.min(dragStart.y, e.clientY);
    const maxY = Math.max(dragStart.y, e.clientY);

    const boxed = [];
    colonists.forEach(col => {
      const v = col.group.position.clone().project(camera);
      // Ekran koordinatlarına çevir
      const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-(v.y * 0.5) + 0.5) * window.innerHeight;

      if (v.z < 1.0 && sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        boxed.push(col);
      }
    });

    hideResourceCardUI();
    setGroupSelection(boxed);
  } else {
    // Normal Sol Tıklama (Tekli Seçim, Ağaç/Kaya İnceleme veya Arazi Seçimi)
    if (e.target.tagName === 'CANVAS') {
      raycaster.setFromCamera(mouse, camera);

      // 1. Koloniste Tıklandı mı?
      const hits = raycaster.intersectObjects(worldGroup.children, true);
      let clickedColonist = null;

      for (let hit of hits) {
        if (hit.object.userData && hit.object.userData.colonist) {
          clickedColonist = hit.object.userData.colonist;
          break;
        }
      }

      if (clickedColonist) {
        hideResourceCardUI();
        setGroupSelection([clickedColonist]);
        return;
      }

      // 2. Doğal Kaynağa (Ağaç, Kaya, Çalı) Tıklandı mı? (Inspector Kartı)
      if (allHarvestMeshes.length > 0) {
        const harvestHits = raycaster.intersectObjects(allHarvestMeshes);
        if (harvestHits.length > 0) {
          const hit = harvestHits[0];
          const prefix = hit.object.userData.prefix;
          const entityId = prefix + hit.instanceId;
          const entity = harvestableEntities.get(entityId);

          if (entity && !entity.isDepleted) {
            setGroupSelection([]);
            selectHarvestResourceUI(entity);
            return;
          }
        }
      }

      // 3. Boş Araziye Tıklandı mı?
      const terrainHits = raycaster.intersectObject(terrainMesh);
      if (terrainHits.length > 0) {
        setGroupSelection([]);
        hideResourceCardUI();
      }
    }
  }
});

function setGroupSelection(cols) {
  // Öncekilerin seçim halkalarını kapat
  colonists.forEach(c => c.setSelected(false));

  selectedColonists = cols;
  selectedColonists.forEach(c => c.setSelected(true));
  updateSelectionUI();
}

function selectHarvestResourceUI(entity) {
  selectedHarvestEntity = entity;
  const resCard = document.getElementById('resource-card');
  const groupCard = document.getElementById('group-card');
  const colonistCard = document.getElementById('colonist-card');
  const terrainInfo = document.getElementById('terrain-info');

  if (resCard) resCard.style.display = 'block';
  if (groupCard) groupCard.style.display = 'none';
  if (colonistCard) colonistCard.style.display = 'none';
  if (terrainInfo) terrainInfo.style.display = 'none';

  const nameEl = document.getElementById('res-name');
  const typeValEl = document.getElementById('res-type-val');
  const statusValEl = document.getElementById('res-status-val');
  const harvestBtn = document.getElementById('btn-harvest-action');

  const icon = entity.resType === 'wood' ? '🪵 Odun' : (entity.resType === 'stone' ? '🪨 Taş' : '🍞 Erzak');
  if (nameEl) nameEl.textContent = entity.name;
  if (typeValEl) typeValEl.textContent = `${icon} (Kalan: ${entity.currentRes}/${entity.maxRes})`;
  if (statusValEl) {
    statusValEl.textContent = entity.isDepleted ? 'Tükendi' : 'Toplanmaya Hazır';
    statusValEl.className = entity.isDepleted ? 'value text-danger' : 'value text-success';
  }
  if (harvestBtn) {
    harvestBtn.disabled = entity.isDepleted;
    harvestBtn.onclick = () => {
      assignHarvestToSelectedColonists(entity);
    };
  }
}

function hideResourceCardUI() {
  selectedHarvestEntity = null;
  const resCard = document.getElementById('resource-card');
  if (resCard) resCard.style.display = 'none';
}

function updateSelectionUI() {
  const resCard = document.getElementById('resource-card');
  const groupCard = document.getElementById('group-card');
  const colonistCard = document.getElementById('colonist-card');
  const terrainInfo = document.getElementById('terrain-info');

  if (selectedHarvestEntity && selectedColonists.length === 0) {
    if (resCard) resCard.style.display = 'block';
    if (groupCard) groupCard.style.display = 'none';
    if (colonistCard) colonistCard.style.display = 'none';
    if (terrainInfo) terrainInfo.style.display = 'none';
    return;
  }

  if (resCard) resCard.style.display = 'none';

  if (selectedColonists.length > 1) {
    // Çoklu Seçim Kartı
    if (groupCard) groupCard.style.display = 'block';
    if (colonistCard) colonistCard.style.display = 'none';
    if (terrainInfo) terrainInfo.style.display = 'none';

    const countBadge = document.getElementById('group-count-badge');
    const summaryText = document.getElementById('group-summary-text');
    if (countBadge) countBadge.textContent = `${selectedColonists.length} Kolonist`;
    if (summaryText) {
      const names = selectedColonists.map(c => c.name).join(', ');
      summaryText.textContent = `Seçilenler: ${names}`;
    }
  } else if (selectedColonists.length === 1) {
    // Tekli Seçim Kartı
    if (groupCard) groupCard.style.display = 'none';
    if (colonistCard) colonistCard.style.display = 'block';
    if (terrainInfo) terrainInfo.style.display = 'none';

    const col = selectedColonists[0];
    const nameEl = document.getElementById('colonist-name');
    const roleBadgeEl = document.getElementById('colonist-role-badge');
    const taskEl = document.getElementById('colonist-task');

    if (nameEl) nameEl.textContent = col.name;
    if (roleBadgeEl) roleBadgeEl.textContent = col.role;
    if (taskEl) taskEl.textContent = col.task;
  } else {
    // Hiçbiri Seçili Değil -> Arazi Bilgisi
    if (groupCard) groupCard.style.display = 'none';
    if (colonistCard) colonistCard.style.display = 'none';
    if (terrainInfo) terrainInfo.style.display = 'block';
  }
}

// Grup Aksiyon Butonları
document.getElementById('btn-group-gather')?.addEventListener('click', () => {
  selectedColonists.forEach((c, idx) => {
    const angle = (idx / Math.max(1, selectedColonists.length)) * Math.PI * 2;
    c.setTarget(campPos.x + Math.cos(angle) * 2, campPos.z + Math.sin(angle) * 2, 'Kampa Toplanıyor');
  });
});

// ==========================================================================
// 6. UI ETKİLEŞİMİ & İNŞAAT KATALOĞU BUTONLARI
// ==========================================================================
const buildDrawerEl = document.getElementById('build-drawer');
const btnToggleBuildEl = document.getElementById('btn-toggle-build');
const btnCloseBuildEl = document.getElementById('btn-close-build');

btnToggleBuildEl?.addEventListener('click', () => {
  if (buildDrawerEl) {
    const isHidden = buildDrawerEl.style.display === 'none';
    buildDrawerEl.style.display = isHidden ? 'block' : 'none';
  }
});

btnCloseBuildEl?.addEventListener('click', () => {
  if (buildDrawerEl) buildDrawerEl.style.display = 'none';
});

// Kategori Sekmeleri
document.querySelectorAll('.build-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.build-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    const cat = tab.dataset.cat;
    document.querySelectorAll('.build-card').forEach(card => {
      if (cat === 'all' || card.dataset.cat === cat) {
        card.style.display = 'flex';
      } else {
        card.style.display = 'none';
      }
    });
  });
});

// İnşa Butonları
document.querySelectorAll('.build-card').forEach(card => {
  const btn = card.querySelector('.btn-place-building');
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const bId = card.dataset.building;
    enterBuildMode(bId);
  });
});

// Klavye Kısayolları (B, ESC, R, WASD, Q, E)
const keys = {
  KeyW: false, KeyA: false, KeyS: false, KeyD: false,
  KeyQ: false, KeyE: false,
  ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false
};

window.addEventListener('keydown', (e) => {
  if (keys[e.code] !== undefined) keys[e.code] = true;

  if (e.code === 'KeyB') {
    if (buildDrawerEl) {
      buildDrawerEl.style.display = buildDrawerEl.style.display === 'none' ? 'block' : 'none';
    }
  }

  if (e.code === 'Escape') {
    if (activeBuildingDef) cancelBuildMode();
    if (buildDrawerEl) buildDrawerEl.style.display = 'none';
    setGroupSelection([]);
  }

  if (e.code === 'KeyR') focusCameraOnCamp();
});

window.addEventListener('keyup', (e) => {
  if (keys[e.code] !== undefined) keys[e.code] = false;
});

// Opera ve Tarayıcı Sağ Tık / Mouse Gesture Engelleme (Sayfa Değişimini Kesinlikle Engeller)
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  return false;
}, { capture: true, passive: false });

window.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    e.preventDefault();
  }
}, { capture: true, passive: false });

document.getElementById('btn-reset-cam')?.addEventListener('click', focusCameraOnCamp);

function focusCameraOnCamp() {
  controls.target.set(campPos.x, campPos.y, campPos.z);
  camera.position.set(campPos.x + 30, campPos.y + 36, campPos.z + 30);
  controls.update();
}

function updateCameraMovement(delta) {
  const moveSpeed = 44 * delta;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  const right = new THREE.Vector3();
  right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const moveDir = new THREE.Vector3();
  if (keys.KeyW || keys.ArrowUp) moveDir.add(forward);
  if (keys.KeyS || keys.ArrowDown) moveDir.sub(forward);
  if (keys.KeyD || keys.ArrowRight) moveDir.add(right);
  if (keys.KeyA || keys.ArrowLeft) moveDir.sub(right);

  if (moveDir.lengthSq() > 0) {
    moveDir.normalize().multiplyScalar(moveSpeed);
    camera.position.add(moveDir);
    controls.target.add(moveDir);
  }

  // Q ve E ile Kamerayı Koloni Çevresinde Yumuşakça 360 Derece Döndür (Klasik Koloni / RTS Kontrolü)
  const rotSpeed = 1.6 * delta;
  if (keys.KeyQ) {
    const offset = camera.position.clone().sub(controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotSpeed);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
  }
  if (keys.KeyE) {
    const offset = camera.position.clone().sub(controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), -rotSpeed);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
  }
}

// ==========================================================================
// 7. HARİTA & DÜNYA OLUŞTURMA
// ==========================================================================
// 7. HARİTA & DÜNYA OLUŞTURMA (ONLINE SENKRONİZE & SEEDED)
// ==========================================================================
function generateMap(seed = Math.floor(Math.random() * 1000000)) {
  currentSeed = seed;
  const rng = new SeededRandom(seed);
  currentNoise = new FastNoise(seed);

  while (worldGroup.children.length > 0) {
    const obj = worldGroup.children[0];
    if (obj.geometry) obj.geometry.dispose();
    worldGroup.remove(obj);
  }

  // 1. DENGELİ COĞRAFİ ARKETİP SEÇİMİ (Seeded - Tüm Oyuncular İçin Birebir Aynı)
  const archetypeIndex = Math.floor(rng.next() * ARCHETYPES.length);
  const selectedArchetype = ARCHETYPES[archetypeIndex];

  if (selectedArchetype.id === 'COASTAL') {
    const sideRoll = rng.next();
    const coastSide = sideRoll < 0.55 ? 'WEST' : (sideRoll < 0.80 ? 'EAST' : 'SOUTH');
    const offset = coastSide === 'WEST' ? (-HALF_MAP * 0.38 + (rng.next() - 0.5) * 16) :
                   coastSide === 'EAST' ? (HALF_MAP * 0.38 + (rng.next() - 0.5) * 16) :
                                          (HALF_MAP * 0.38 + (rng.next() - 0.5) * 16);
    currentMapConfig = {
      type: 'COASTAL',
      name: `${selectedArchetype.name} (${coastSide === 'WEST' ? 'Batı Koyu' : (coastSide === 'EAST' ? 'Doğu Denizi' : 'Güney Sahili')})`,
      desc: selectedArchetype.desc,
      coastSide: coastSide,
      coastOffset: offset,
      coastCurvature: 0.015 + rng.next() * 0.015,
      coastPhase: rng.next() * Math.PI * 2
    };
  } else if (selectedArchetype.id === 'LAKES') {
    const numLakes = rng.next() < 0.35 ? 1 : (rng.next() < 0.75 ? 2 : 3);
    const lakes = [];
    for (let i = 0; i < numLakes; i++) {
      const angle = (i / numLakes) * Math.PI * 2 + rng.next() * 0.8;
      const dist = 22 + rng.next() * 45;
      lakes.push({
        x: Math.max(-HALF_MAP + 35, Math.min(HALF_MAP - 35, Math.cos(angle) * dist)),
        z: Math.max(-HALF_MAP + 35, Math.min(HALF_MAP - 35, Math.sin(angle) * dist)),
        radius: 18 + rng.next() * 12,
        aspect: 1.1 + rng.next() * 0.5,
        angle: rng.next() * Math.PI
      });
    }
    currentMapConfig = {
      type: 'LAKES',
      name: `${selectedArchetype.name} (${numLakes === 1 ? 'Büyük Alp Gölü' : (numLakes === 2 ? 'İkiz Dağ Gölleri' : 'Üçlü Vadi Gölleri')})`,
      desc: selectedArchetype.desc,
      lakes: lakes
    };
  } else if (selectedArchetype.id === 'RIVER') {
    const axisRoll = rng.next();
    const axis = axisRoll < 0.5 ? 'Z' : (axisRoll < 0.8 ? 'X' : 'DIAG');
    currentMapConfig = {
      type: 'RIVER',
      name: `${selectedArchetype.name} (${axis === 'Z' ? 'Kuzey-Güney Akıntısı' : (axis === 'X' ? 'Doğu-Batı Akıntısı' : 'Çapraz Vadi Akıntısı')})`,
      desc: selectedArchetype.desc,
      river: {
        axis: axis,
        startOffset: (rng.next() - 0.5) * (HALF_MAP * 0.30),
        freq1: 0.018 + rng.next() * 0.014,
        amp1: 20 + rng.next() * 16,
        freq2: 0.040 + rng.next() * 0.022,
        amp2: 7 + rng.next() * 7,
        phase1: rng.next() * Math.PI * 2,
        phase2: rng.next() * Math.PI * 2,
        width: 8.0 + rng.next() * 3.0
      }
    };
  } else {
    // INLAND: Karasal Geniş Bozkır (Çok az su - Yalnızca daracık vadi deresi)
    currentMapConfig = {
      type: 'INLAND',
      name: selectedArchetype.name,
      desc: selectedArchetype.desc,
      creek: {
        startOffset: (rng.next() - 0.5) * (HALF_MAP * 0.45),
        freq1: 0.025 + rng.next() * 0.015,
        amp1: 15 + rng.next() * 10,
        freq2: 0.055 + rng.next() * 0.025,
        amp2: 5 + rng.next() * 4,
        phase1: rng.next() * Math.PI * 2,
        phase2: rng.next() * Math.PI * 2,
        width: 2.8 + rng.next() * 0.8
      }
    };
  }

  // 2. Yeryüzü Mesh Oluşturma (260x260, 130 Segments)
  const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);

  const posAttr = geo.attributes.position;
  const count = posAttr.count;

  // Yükseklikleri hesapla
  for (let i = 0; i < count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    const vy = getTerrainHeight(vx, vz, currentNoise, currentMapConfig);
    posAttr.setY(i, vy);
  }

  // Normalleri hesapla (Eğim ve dik yamaç algılaması için kritik)
  geo.computeVertexNormals();
  const normAttr = geo.attributes.normal;

  const colors = new Float32Array(count * 3);

  // Eğim ve Yüksekliğe Dayalı Doğal Renklendirme (Slope & Altitude Splatting)
  for (let i = 0; i < count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    const vy = posAttr.getY(i);
    const ny = normAttr.getY(i); // Eğim: 1.0 düz ova, 0.0 dik uçurum duvarı

    const vertexColor = new THREE.Color();
    const noiseVar = (currentNoise.noise2D(vx * 0.04, vz * 0.04) + 1.0) * 0.5;

    if (vy < -0.2) {
      vertexColor.copy(COLOR_RIVERBED);
    } else if (vy < 0.40) {
      vertexColor.copy(COLOR_SAND);
    } else if (ny < 0.70) {
      const rockT = Math.min(1.0, (0.70 - ny) / 0.32);
      const rockTone = COLOR_ROCK.clone().multiplyScalar(0.80 + noiseVar * 0.35);
      vertexColor.copy(COLOR_FOREST).lerp(rockTone, rockT * 1.4);
    } else if (vy < 3.8) {
      const grassTone = COLOR_GRASS.clone().lerp(COLOR_FOREST, noiseVar * 0.45);
      vertexColor.copy(grassTone);
    } else if (vy < 6.8) {
      const t = (vy - 3.8) / 3.0;
      vertexColor.copy(COLOR_FOREST).lerp(COLOR_ROCK, t);
    } else {
      const t = Math.min(1.0, (vy - 6.8) / 2.5);
      vertexColor.copy(COLOR_ROCK).lerp(COLOR_SNOW, t);
    }

    colors[i * 3]     = vertexColor.r;
    colors[i * 3 + 1] = vertexColor.g;
    colors[i * 3 + 2] = vertexColor.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  if (!cachedTerrainTexture) cachedTerrainTexture = createProceduralTerrainTexture();
  if (!cachedWaterNormalTexture) cachedWaterNormalTexture = createWaterNormalTexture();

  const terrainMat = new THREE.MeshStandardMaterial({
    map: cachedTerrainTexture,
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.04,
    flatShading: false
  });

  terrainMesh = new THREE.Mesh(geo, terrainMat);
  terrainMesh.receiveShadow = true;
  terrainMesh.castShadow = true;
  worldGroup.add(terrainMesh);

  // 3. Su Katmanı (Canlı su yansımaları ve derinlik yazım korumalı su yüzeyi)
  const waterGeo = new THREE.PlaneGeometry(MAP_SIZE * 5, MAP_SIZE * 5, 64, 64);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x186b99,
    normalMap: cachedWaterNormalTexture,
    roughness: 0.10,
    metalness: 0.85,
    transparent: true,
    opacity: 0.80,
    depthWrite: false
  });
  riverMesh = new THREE.Mesh(waterGeo, waterMat);
  riverMesh.position.y = -0.05;
  riverMesh.receiveShadow = true;
  worldGroup.add(riverMesh);

  // 4. Koloni Başlangıç Kampı Bul (Geniş, güvenli, kuru ve düzlük bir çayır)
  let bestX = 0, bestZ = 0, bestH = 1.0;
  let bestScore = -Infinity;

  for (let r = 6; r <= 70; r += 4) {
    const angleStep = Math.PI / Math.max(8, Math.floor(r * 0.4));
    for (let angle = 0; angle < Math.PI * 2; angle += angleStep) {
      const tx = Math.cos(angle) * r;
      const tz = Math.sin(angle) * r;
      const ch = getTerrainHeight(tx, tz, currentNoise, currentMapConfig);

      if (ch < 0.90 || ch > 3.0) continue;

      let isCandidateSafe = true;
      let heightVariance = 0;
      const testRadii = [3.5, 7.0, 11.0, 15.0];
      const testAngles = [0, Math.PI * 0.25, Math.PI * 0.5, Math.PI * 0.75, Math.PI, Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75];

      for (let tr of testRadii) {
        if (!isCandidateSafe) break;
        for (let ta of testAngles) {
          const sx = tx + Math.cos(ta) * tr;
          const sz = tz + Math.sin(ta) * tr;
          const sh = getTerrainHeight(sx, sz, currentNoise, currentMapConfig);

          if (sh < 0.75) {
            isCandidateSafe = false;
            break;
          }

          const diff = Math.abs(sh - ch);
          if (diff > 0.42) {
            isCandidateSafe = false;
            break;
          }
          heightVariance += diff;
        }
      }

      if (isCandidateSafe) {
        const score = 1000 - r * 3.5 - heightVariance * 12.0;
        if (score > bestScore) {
          bestScore = score;
          bestX = tx;
          bestZ = tz;
          bestH = ch;
        }
      }
    }
    if (bestScore > 750) break;
  }

  createColonyCamp(bestX, bestZ, bestH);
  scatterVegetation(bestX, bestZ, rng);
  focusCameraOnCamp();

  const timeBadge = document.getElementById('time-badge');
  if (timeBadge) timeBadge.textContent = `${currentMapConfig.name} (#${seed % 100000})`;
}

function createColonyCamp(cx, cz, ch) {
  campPos = { x: cx, y: ch, z: cz };
  const campGroup = new THREE.Group();
  campGroup.position.set(cx, ch, cz);

  // Kamp Ateşi (Taş Çemberi & Yanan Odunlar)
  const pebbleMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9, flatShading: true });
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const pebble = new THREE.Mesh(new THREE.DodecahedronGeometry(0.12, 0), pebbleMat);
    pebble.position.set(Math.cos(angle) * 0.48, 0.08, Math.sin(angle) * 0.48);
    pebble.castShadow = true;
    campGroup.add(pebble);
  }

  const fireWoodMat = new THREE.MeshStandardMaterial({ color: 0x3e2723, roughness: 0.9, flatShading: true });
  for (let i = 0; i < 5; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.7, 5), fireWoodMat);
    log.rotation.z = Math.PI / 4;
    log.rotation.y = (i * Math.PI) / 2.5;
    log.position.y = 0.08;
    log.castShadow = true;
    campGroup.add(log);
  }

  const emberMat = new THREE.MeshStandardMaterial({
    color: 0xf97316,
    emissive: 0xe11d48,
    emissiveIntensity: 2.2,
    roughness: 0.2
  });
  const embers = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18, 0), emberMat);
  embers.position.y = 0.15;
  campGroup.add(embers);

  campfireLight = new THREE.PointLight(0xf59e0b, 2.8, 12);
  campfireLight.position.set(0, 0.4, 0);
  campGroup.add(campfireLight);

  // Göçmen Arabası (Zemine tam oturtulmuş)
  const wagon = new THREE.Group();
  const wagonH = getTerrainHeight(cx + 2.8, cz + 1.2, currentNoise, currentMapConfig);
  wagon.position.set(2.8, wagonH - ch, 1.2);
  wagon.rotation.y = -0.3;

  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.85, flatShading: true });
  const cartBody = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.9), woodMat);
  cartBody.position.y = 0.45;
  cartBody.castShadow = true;
  wagon.add(cartBody);

  const canvasMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.9, flatShading: true });
  const tentCover = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 1.6, 8, 1, false, 0, Math.PI), canvasMat);
  tentCover.rotation.z = Math.PI / 2;
  tentCover.position.y = 0.75;
  tentCover.castShadow = true;
  wagon.add(tentCover);

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x27272a, roughness: 0.9 });
  const wheelGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.08, 10);
  [[-0.6, 0.24, 0.48], [0.6, 0.24, 0.48], [-0.6, 0.24, -0.48], [0.6, 0.24, -0.48]].forEach(([wx, wy, wz]) => {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(wx, wy, wz);
    wheel.castShadow = true;
    wagon.add(wheel);
  });
  campGroup.add(wagon);

  // Erzak Sandıkları ve Tahıl Çuvalları (Zemine tam oturtulmuş)
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.85, flatShading: true });
  const crateH = getTerrainHeight(cx - 1.8, cz + 1.0, currentNoise, currentMapConfig);
  const crate1 = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.45, 0.48), crateMat);
  crate1.position.set(-1.8, (crateH - ch) + 0.22, 1.0);
  campGroup.add(crate1);

  const sackH = getTerrainHeight(cx - 1.8, cz + 0.4, currentNoise, currentMapConfig);
  const sackMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.9 });
  const sack = new THREE.Mesh(new THREE.SphereGeometry(0.22, 7, 7), sackMat);
  sack.scale.set(1.0, 1.3, 0.85);
  sack.position.set(-1.8, (sackH - ch) + 0.2, 0.4);
  campGroup.add(sack);

  worldGroup.add(campGroup);

  // Kolonistleri Oluştur (Hepsi kuru ve düz çayırda zemine tam temas eder)
  colonists.length = 0;
  selectedColonists = [];

  const colonistData = [
    { id: 1, name: 'Demir', role: 'Usta Marangoz', color: 0x15803d, x: cx + 1.4, z: cz - 1.2 },
    { id: 2, name: 'Aylin', role: 'Toplayıcı & Çiftçi', color: 0xd97706, x: cx - 1.4, z: cz + 1.0 },
    { id: 3, name: 'Kerem', role: 'Avcı & Keşifçi', color: 0x2563eb, x: cx + 0.8, z: cz + 1.8 }
  ];

  colonistData.forEach(d => colonists.push(new Colonist(d)));
  setGroupSelection([colonists[0]]);
  updateResourceUI();
}

function scatterVegetation(campX, campZ, rng = new SeededRandom(123456)) {
  const propsGroup = new THREE.Group();
  worldGroup.add(propsGroup);

  // Kaynak listelerini sıfırla
  harvestableEntities.clear();
  allHarvestMeshes.length = 0;

  const pineTrunkMatrices = [];
  const pineCanopyMatrices = [];
  const oakTrunkMatrices = [];
  const oakCanopyMatrices = [];
  const bushMatrices = [];
  const rockMatrices = [];

  const dummy = new THREE.Object3D();
  const step = 4.2; // Sık, gür ve canlı orman örtüsü

  for (let x = -HALF_MAP + 8; x < HALF_MAP - 8; x += step) {
    for (let z = -HALF_MAP + 8; z < HALF_MAP - 8; z += step) {
      const rx = x + (rng.next() - 0.5) * 3.2;
      const rz = z + (rng.next() - 0.5) * 3.2;

      // Başlangıç kampı ve çevresini inşaat için ferah bırak (16m güvenlik yarıçapı)
      if (Math.hypot(rx - campX, rz - campZ) < 16.0) continue;

      const h = getTerrainHeight(rx, rz, currentNoise, currentMapConfig);
      const waterInfo = getWaterInfoAt(rx, rz, h);
      if (waterInfo.isWater || h < 0.45) continue; // Suda veya kumsalda bitki örtüsü olmaz

      const forestNoise = currentNoise.noise2D(rx * 0.038, rz * 0.038);

      // 1. ÇAM VE MEŞE ORMANLARI (Gür, doğal koruluklar)
      if (h >= 0.70 && h <= 5.8 && !waterInfo.isShore) {
        if (forestNoise > -0.10) {
          const treeType = rng.next();
          const s = 0.85 + rng.next() * 0.6;
          dummy.position.set(rx, h, rz);
          dummy.scale.set(s, s, s);
          dummy.rotation.set(0, rng.next() * Math.PI * 2, 0);
          dummy.updateMatrix();

          if (treeType > 0.40 && pineTrunkMatrices.length < 650) {
            // İğne Yapraklı Ulu Çam Ağacı (🪵 Odun Kaynağı)
            const idx = pineTrunkMatrices.length;
            const entityId = `pine_${idx}`;
            harvestableEntities.set(entityId, {
              id: entityId,
              name: 'Ulu Çam Ağacı',
              resType: 'wood',
              yieldAmount: 18,
              maxRes: 18,
              currentRes: 18,
              isDepleted: false,
              pos: { x: rx, y: h, z: rz },
              meshes: []
            });
            pineTrunkMatrices.push(dummy.matrix.clone());
            pineCanopyMatrices.push(dummy.matrix.clone());
          } else if (oakTrunkMatrices.length < 420) {
            // Geniş Yapraklı Meşe Ağacı (🪵 Odun Kaynağı)
            const idx = oakTrunkMatrices.length;
            const entityId = `oak_${idx}`;
            harvestableEntities.set(entityId, {
              id: entityId,
              name: 'Geniş Meşe Ağacı',
              resType: 'wood',
              yieldAmount: 16,
              maxRes: 16,
              currentRes: 16,
              isDepleted: false,
              pos: { x: rx, y: h, z: rz },
              meshes: []
            });
            oakTrunkMatrices.push(dummy.matrix.clone());
            oakCanopyMatrices.push(dummy.matrix.clone());
          }
        } else if (rng.next() < 0.28 && bushMatrices.length < 320) {
          // Çayır Arası Yabani Meyve Çalıları (🍞 Erzak Kaynağı)
          const bs = 0.65 + rng.next() * 0.5;
          dummy.position.set(rx, h + 0.1, rz);
          dummy.scale.set(bs, bs * 0.8, bs);
          dummy.rotation.set(0, rng.next() * Math.PI * 2, 0);
          dummy.updateMatrix();

          const idx = bushMatrices.length;
          const entityId = `bush_${idx}`;
          harvestableEntities.set(entityId, {
            id: entityId,
            name: 'Yabani Meyve Çalısı',
            resType: 'food',
            yieldAmount: 10,
            maxRes: 10,
            currentRes: 10,
            isDepleted: false,
            pos: { x: rx, y: h, z: rz },
            meshes: []
          });
          bushMatrices.push(dummy.matrix.clone());
        }
      }

      // 2. DOĞAL TAŞLAR VE DAĞ KAYALIKLARI (🪨 Taş Kaynağı)
      if ((h > 2.8 || waterInfo.isShore || rng.next() < 0.08) && rockMatrices.length < 180) {
        if (rng.next() < 0.40) {
          const rs = 0.7 + rng.next() * 0.85;
          dummy.position.set(rx, h + 0.08, rz);
          dummy.scale.set(rs, rs * (0.6 + rng.next() * 0.5), rs);
          dummy.rotation.set(rng.next() * Math.PI, rng.next() * Math.PI, rng.next() * Math.PI);
          dummy.updateMatrix();

          const idx = rockMatrices.length;
          const entityId = `rock_${idx}`;
          harvestableEntities.set(entityId, {
            id: entityId,
            name: 'Granit Kaya Kütlesi',
            resType: 'stone',
            yieldAmount: 15,
            maxRes: 15,
            currentRes: 15,
            isDepleted: false,
            pos: { x: rx, y: h, z: rz },
            meshes: []
          });
          rockMatrices.push(dummy.matrix.clone());
        }
      }
    }
  }

  // --- InstancedMesh: 1.500+ Ağaç ve Kayayı Sadece 6 GPU Çizim Çağrısında Bitirir (60-144 FPS) ---

  // 1. Çam Ağaçları
  if (pineTrunkMatrices.length > 0) {
    const pTrunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 0.75, 6);
    pTrunkGeo.translate(0, 0.375, 0);
    const pTrunkMat = new THREE.MeshStandardMaterial({ color: 0x422817, roughness: 0.9 });
    const pTrunkInst = new THREE.InstancedMesh(pTrunkGeo, pTrunkMat, pineTrunkMatrices.length);
    pTrunkInst.castShadow = true;
    pTrunkInst.userData = { isHarvestable: true, prefix: 'pine_' };

    const pCanopyGeo = new THREE.ConeGeometry(0.85, 1.85, 7);
    pCanopyGeo.translate(0, 1.45, 0);
    const pCanopyMat = new THREE.MeshStandardMaterial({ color: 0x1b4320, roughness: 0.75 });
    const pCanopyInst = new THREE.InstancedMesh(pCanopyGeo, pCanopyMat, pineCanopyMatrices.length);
    pCanopyInst.castShadow = true;
    pCanopyInst.userData = { isHarvestable: true, prefix: 'pine_' };

    for (let i = 0; i < pineTrunkMatrices.length; i++) {
      pTrunkInst.setMatrixAt(i, pineTrunkMatrices[i]);
      pCanopyInst.setMatrixAt(i, pineCanopyMatrices[i]);
      const ent = harvestableEntities.get(`pine_${i}`);
      if (ent) {
        ent.meshes = [
          { mesh: pTrunkInst, index: i },
          { mesh: pCanopyInst, index: i }
        ];
      }
    }
    pTrunkInst.instanceMatrix.needsUpdate = true;
    pCanopyInst.instanceMatrix.needsUpdate = true;
    propsGroup.add(pTrunkInst);
    propsGroup.add(pCanopyInst);
    allHarvestMeshes.push(pTrunkInst, pCanopyInst);
  }

  // 2. Meşe / Huş Ağaçları
  if (oakTrunkMatrices.length > 0) {
    const oTrunkGeo = new THREE.CylinderGeometry(0.14, 0.20, 0.9, 6);
    oTrunkGeo.translate(0, 0.45, 0);
    const oTrunkMat = new THREE.MeshStandardMaterial({ color: 0x4a321d, roughness: 0.9 });
    const oTrunkInst = new THREE.InstancedMesh(oTrunkGeo, oTrunkMat, oakTrunkMatrices.length);
    oTrunkInst.castShadow = true;
    oTrunkInst.userData = { isHarvestable: true, prefix: 'oak_' };

    const oCanopyGeo = new THREE.DodecahedronGeometry(0.95, 1);
    oCanopyGeo.translate(0, 1.5, 0);
    const oCanopyMat = new THREE.MeshStandardMaterial({ color: 0x3b7d34, roughness: 0.72 });
    const oCanopyInst = new THREE.InstancedMesh(oCanopyGeo, oCanopyMat, oakCanopyMatrices.length);
    oCanopyInst.castShadow = true;
    oCanopyInst.userData = { isHarvestable: true, prefix: 'oak_' };

    for (let i = 0; i < oakTrunkMatrices.length; i++) {
      oTrunkInst.setMatrixAt(i, oakTrunkMatrices[i]);
      oCanopyInst.setMatrixAt(i, oakCanopyMatrices[i]);
      const ent = harvestableEntities.get(`oak_${i}`);
      if (ent) {
        ent.meshes = [
          { mesh: oTrunkInst, index: i },
          { mesh: oCanopyInst, index: i }
        ];
      }
    }
    oTrunkInst.instanceMatrix.needsUpdate = true;
    oCanopyInst.instanceMatrix.needsUpdate = true;
    propsGroup.add(oTrunkInst);
    propsGroup.add(oCanopyInst);
    allHarvestMeshes.push(oTrunkInst, oCanopyInst);
  }

  // 3. Yabani Çalılar ve Çimen Öbekleri
  if (bushMatrices.length > 0) {
    const bushGeo = new THREE.DodecahedronGeometry(0.48, 1);
    bushGeo.translate(0, 0.25, 0);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x2e6328, roughness: 0.8 });
    const bushInst = new THREE.InstancedMesh(bushGeo, bushMat, bushMatrices.length);
    bushInst.userData = { isHarvestable: true, prefix: 'bush_' };

    for (let i = 0; i < bushMatrices.length; i++) {
      bushInst.setMatrixAt(i, bushMatrices[i]);
      const ent = harvestableEntities.get(`bush_${i}`);
      if (ent) {
        ent.meshes = [{ mesh: bushInst, index: i }];
      }
    }
    bushInst.instanceMatrix.needsUpdate = true;
    propsGroup.add(bushInst);
    allHarvestMeshes.push(bushInst);
  }

  // 4. Doğal Kayalıklar
  if (rockMatrices.length > 0) {
    const rockGeo = new THREE.DodecahedronGeometry(0.55, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x58606d, roughness: 0.85 });
    const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, rockMatrices.length);
    rockInst.castShadow = true;
    rockInst.userData = { isHarvestable: true, prefix: 'rock_' };

    for (let i = 0; i < rockMatrices.length; i++) {
      rockInst.setMatrixAt(i, rockMatrices[i]);
      const ent = harvestableEntities.get(`rock_${i}`);
      if (ent) {
        ent.meshes = [{ mesh: rockInst, index: i }];
      }
    }
    rockInst.instanceMatrix.needsUpdate = true;
    propsGroup.add(rockInst);
    allHarvestMeshes.push(rockInst);
  }
}

// FPS Sayacı
const fpsEl = document.getElementById('fps-counter');
let frameCount = 0;
let lastFpsTime = performance.now();

function updateFPS(now) {
  frameCount++;
  if (now - lastFpsTime >= 500) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    if (fpsEl) fpsEl.textContent = `${fps} FPS`;
    frameCount = 0;
    lastFpsTime = now;
  }
}

// ==========================================================================
// 8. ANA ANİMASYON & RENDER DÖNGÜSÜ
// ==========================================================================
const clock = new THREE.Clock();

// ==========================================================================
// 8. ONLINE MULTIPLAYER İSTEMCİSİ (AETHELGARD 3D REAL-TIME NETWORKING)
// ==========================================================================
let socket = null;
let myPlayerId = null;
let myPlayerInfo = null;
const remotePlayers = new Map(); // id -> { id, name, color, cursorGroup, gem, targetPos }
let lastCursorSendTime = 0;

function initMultiplayer() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:3000';
  const worldId = new URLSearchParams(window.location.search).get('world');
  const wsUrl = `${protocol}//${host}/?world=${encodeURIComponent(worldId || '')}`;

  try {
    socket = new WebSocket(wsUrl);
  } catch (err) {
    console.warn('Online sunucuya bağlanılamadı:', err);
    updateOnlineBadge(false, 'Çevrimdışı (Yerel Mod)', 1);
    return;
  }

  socket.onopen = () => {
    console.log('[Online] WebSocket bağlantısı kuruldu.');
    updateOnlineBadge(true, 'Çevrimiçi', 1);
  };

  socket.onclose = () => {
    console.log('[Online] WebSocket bağlantısı koptu.');
    updateOnlineBadge(false, 'Bağlantı Kesildi', 0);
    // 3.5 saniye sonra otomatik yeniden bağlan
    setTimeout(initMultiplayer, 3500);
  };

  socket.onerror = (err) => {
    console.warn('[Online] WebSocket hatası:', err);
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    } catch (e) {
      console.error('Sunucu mesajı işlenemedi:', e);
    }
  };
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'INIT_STATE':
      myPlayerId = data.playerId;
      myPlayerInfo = data.playerInfo;
      updateOnlineBadge(true, `Çevrimiçi · ${data.world ? data.world.name : data.playerInfo.name}`, data.players ? data.players.length : 1);

      // Harita Senkronizasyonu: Sunucudaki dünya tohumu (seed) ile aynı haritayı oluştur
      if (data.seed !== currentSeed) {
        generateMap(data.seed);
      }

      // Kaynakları Sunucuyla Eşitle
      if (data.resources) {
        Object.assign(resources, data.resources);
        updateResourceUI();
      }

      // Önceden toplanmış olan ağaç ve kayaları gizle
      if (data.harvestedEntities && data.harvestedEntities.length > 0) {
        data.harvestedEntities.forEach(entId => {
          depleteHarvestEntity(entId, false);
        });
      }

      // Önceden inşa edilmiş binaları dik
      if (data.buildings && data.buildings.length > 0) {
        data.buildings.forEach(bld => {
          spawnRemoteBuilding(bld);
        });
      }

      // Diğer oyuncuların imleçlerini oluştur
      if (data.players) {
        data.players.forEach(p => {
          if (p.id !== myPlayerId) {
            const cursorData = createRemotePlayerCursor(p);
            remotePlayers.set(p.id, { ...p, ...cursorData });
          }
        });
      }

      showNotification(`⚔️ ${data.playerInfo.name} olarak online krallığa bağlandınız!`);
      break;

    case 'PLAYER_JOINED':
      if (data.player && data.player.id !== myPlayerId) {
        const cursorData = createRemotePlayerCursor(data.player);
        remotePlayers.set(data.player.id, { ...data.player, ...cursorData });
        updateOnlineBadge(true, `Çevrimiçi (${myPlayerInfo ? myPlayerInfo.name : 'Lord'})`, data.playerCount);
        handleChatMessage({
          time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
          playerName: 'Sunucu',
          playerColor: '#38bdf8',
          text: `🎉 ${data.player.name} krallığa katıldı!`
        });
        showNotification(`👋 ${data.player.name} oyuna katıldı!`);
      }
      break;

    case 'PLAYER_LEFT':
      const leftPlayer = remotePlayers.get(data.playerId);
      if (leftPlayer) {
        if (leftPlayer.cursorGroup) scene.remove(leftPlayer.cursorGroup);
        remotePlayers.delete(data.playerId);
        updateOnlineBadge(true, `Çevrimiçi (${myPlayerInfo ? myPlayerInfo.name : 'Lord'})`, data.playerCount);
        handleChatMessage({
          time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
          playerName: 'Sunucu',
          playerColor: '#ef4444',
          text: `🚪 ${leftPlayer.name || 'Bir lord'} ayrıldı.`
        });
      }
      break;

    case 'PLAYER_CURSOR':
      const rp = remotePlayers.get(data.playerId);
      if (rp && rp.targetPos) {
        const py = getTerrainHeight(data.x, data.z, currentNoise, currentMapConfig);
        rp.targetPos.set(data.x, py, data.z);
      }
      break;

    case 'COLONIST_MOVED':
      if (data.playerId !== myPlayerId) {
        const col = colonists.find(c => c.id === data.colonistId);
        if (col) {
          col.assignedHarvest = null;
          col.setTarget(data.targetX, data.targetZ, data.task || 'Müttefik Emriyle İlerliyor');
        }
      }
      break;

    case 'HARVEST_STARTED':
      if (data.playerId !== myPlayerId) {
        const col = colonists.find(c => c.id === data.colonistId);
        const ent = harvestableEntities.get(data.entityId);
        if (col && ent) {
          col.assignHarvest(ent);
        }
      }
      break;

    case 'RESOURCE_DEPLETED':
      depleteHarvestEntity(data.entityId, false);
      if (data.resources) {
        Object.assign(resources, data.resources);
        updateResourceUI();
      }
      if (data.harvesterName && data.harvesterName !== (myPlayerInfo ? myPlayerInfo.name : '')) {
        const rIcon = data.resType === 'wood' ? '🪵' : (data.resType === 'stone' ? '🪨' : '🍞');
        showNotification(`🌾 ${data.harvesterName} bir kaynak topladı! (${rIcon} +${data.amount})`);
      }
      break;

    case 'BUILDING_PLACED':
      if (data.building) {
        spawnRemoteBuilding(data.building);
        if (data.resources) {
          Object.assign(resources, data.resources);
          updateResourceUI();
        }
      }
      break;

    case 'RELOAD_WORLD':
      generateMap(data.seed);
      if (data.resources) {
        Object.assign(resources, data.resources);
        updateResourceUI();
      }
      showNotification('🎲 Yeni ortak harita yüklendi!');
      break;

    case 'CHAT_MESSAGE':
      handleChatMessage(data);
      break;

    case 'CHAT_REJECTED':
      showNotification(data.reason || 'Sohbete yazmak için giriş yapmalısınız.');
      break;

    case 'ACTION_REJECTED':
    case 'AUTH_REQUIRED':
      showNotification(data.reason || 'Bu işlem için giriş yapmalısınız.');
      if (data.type === 'AUTH_REQUIRED') window.location.assign('/');
      break;
  }
}

function createRemotePlayerCursor(player) {
  const group = new THREE.Group();

  // Renkli Parlayan Kristal Gösterge
  const gemGeo = new THREE.OctahedronGeometry(0.32, 0);
  const gemMat = new THREE.MeshStandardMaterial({
    color: player.color || 0x38bdf8,
    emissive: player.color || 0x38bdf8,
    emissiveIntensity: 0.9,
    roughness: 0.2
  });
  const gem = new THREE.Mesh(gemGeo, gemMat);
  gem.position.y = 1.6;
  group.add(gem);

  // Zemin Halka İşareti
  const ringGeo = new THREE.RingGeometry(0.3, 0.45, 16);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: player.color || 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.75
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = 0.05;
  group.add(ring);

  // İsim Etiketi (Canvas Sprite)
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.beginPath();
  ctx.roundRect(10, 8, 236, 48, 12);
  ctx.fill();
  ctx.strokeStyle = player.color || '#38bdf8';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px Outfit, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(player.name || `Oyuncu_${player.id}`, 128, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.position.y = 2.4;
  sprite.scale.set(1.8, 0.45, 1);
  group.add(sprite);

  scene.add(group);
  return { cursorGroup: group, gem: gem, targetPos: new THREE.Vector3(0, 0, 0) };
}

function updateOnlineBadge(connected, text, count) {
  const badge = document.getElementById('online-status');
  const textEl = document.getElementById('online-text');
  const countEl = document.getElementById('player-count-badge');
  if (textEl) textEl.textContent = text;
  if (countEl) countEl.textContent = `${count}P`;
  if (badge) {
    if (connected) {
      badge.style.color = '#34d399';
      badge.style.borderColor = 'rgba(16, 185, 129, 0.35)';
      badge.style.background = 'rgba(16, 185, 129, 0.12)';
    } else {
      badge.style.color = '#f87171';
      badge.style.borderColor = 'rgba(239, 68, 68, 0.35)';
      badge.style.background = 'rgba(239, 68, 68, 0.12)';
    }
  }
}

function handleChatMessage(msg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = 'chat-msg';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'chat-time';
  timeSpan.style.opacity = '0.6';
  timeSpan.textContent = `[${msg.time || ''}] `;

  const senderSpan = document.createElement('span');
  senderSpan.className = 'chat-sender';
  senderSpan.style.color = msg.playerColor || '#38bdf8';
  senderSpan.style.fontWeight = 'bold';
  senderSpan.textContent = `${msg.playerName}: `;

  const textSpan = document.createElement('span');
  textSpan.className = 'chat-text';
  textSpan.textContent = msg.text;

  msgDiv.appendChild(timeSpan);
  msgDiv.appendChild(senderSpan);
  msgDiv.appendChild(textSpan);

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'CHAT_MESSAGE',
      text: text
    }));
  } else {
    // Çevrimdışıysa yerel mesaj olarak göster
    handleChatMessage({
      time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
      playerName: 'Siz (Yerel)',
      playerColor: '#38bdf8',
      text: text
    });
  }
  input.value = '';
}

document.getElementById('btn-send-chat')?.addEventListener('click', sendChatMessage);
document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    sendChatMessage();
  }
});
document.getElementById('chat-input')?.addEventListener('keyup', (e) => {
  e.stopPropagation();
});
document.getElementById('btn-toggle-chat')?.addEventListener('click', () => {
  const container = document.getElementById('multiplayer-chat-container');
  if (container) {
    const isCollapsed = container.classList.toggle('collapsed');
    const toggle = document.getElementById('btn-toggle-chat');
    toggle.textContent = isCollapsed ? '+' : '−';
    toggle.title = isCollapsed ? 'Sohbeti Aç' : 'Sohbeti Gizle';
  }
});
document.getElementById('btn-toggle-controls')?.addEventListener('click', () => {
  document.getElementById('controls-panel')?.classList.toggle('collapsed');
});

// ==========================================================================
// 9. ANA ANİMASYON & RENDER DÖNGÜSÜ
// ==========================================================================
function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsedTime = clock.getElapsedTime();

  updateCameraMovement(delta);
  controls.update();

  if (campfireLight) {
    campfireLight.intensity = 2.4 + Math.sin(elapsedTime * 15) * 0.4 + Math.cos(elapsedTime * 23) * 0.2;
  }

  if (riverMesh) {
    riverMesh.position.y = -0.05 + Math.sin(elapsedTime * 1.5) * 0.015;
  }

  colonists.forEach(col => col.update(delta, elapsedTime));

  // Parçacık Efektlerini Güncelle
  for (let i = particleEffects.length - 1; i >= 0; i--) {
    const p = particleEffects[i];
    p.update(delta);
    p.lifetime -= delta;
    if (p.lifetime <= 0) {
      if (p.mesh.geometry) p.mesh.geometry.dispose();
      scene.remove(p.mesh);
      particleEffects.splice(i, 1);
    }
  }

  // Diğer Online Oyuncuların 3D İmleçlerini Yumuşakça Takip Ettir (Lerp)
  remotePlayers.forEach(rp => {
    if (rp.cursorGroup && rp.targetPos) {
      rp.cursorGroup.position.lerp(rp.targetPos, 0.18);
      if (rp.gem) rp.gem.rotation.y += delta * 2.5;
    }
  });

  // Arazi Bilgisi Gösterme & Online İmleç Gönderme (Throttled)
  if (mouseMoved && terrainMesh) {
    mouseMoved = false;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (hits.length > 0) {
      const p = hits[0].point;

      // Online İmleç Konumu Gönder (Her 60ms'de bir)
      const now = performance.now();
      if (now - lastCursorSendTime >= 60 && socket && socket.readyState === WebSocket.OPEN) {
        lastCursorSendTime = now;
        socket.send(JSON.stringify({
          type: 'CURSOR_MOVE',
          x: Math.round(p.x * 10) / 10,
          z: Math.round(p.z * 10) / 10
        }));
      }

      // HUD Arazi Koordinatları
      if (selectedColonists.length === 0 && !activeBuildingDef && !selectedHarvestEntity) {
        const gx = Math.round(p.x);
        const gz = Math.round(p.z);
        const gridCoordEl = document.getElementById('grid-coord');
        const tileTypeEl = document.getElementById('tile-type');
        if (gridCoordEl) gridCoordEl.textContent = `X: ${gx}, Z: ${gz} (Y: ${p.y.toFixed(1)})`;
        if (tileTypeEl) {
          const info = getWaterInfoAt(gx, gz, p.y);
          tileTypeEl.textContent = info.label;
        }
      }
    }
  }

  renderer.render(scene, camera);
  updateFPS(performance.now());
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// Başlat
generateMap();
animate();
initMultiplayer();
console.log('Aethelgard 3D: Online Multiplayer ve Kaynak Toplama sistemi aktif.');
