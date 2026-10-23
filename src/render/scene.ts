// Escena, cámara, controles, cielo e iluminación según la hora (sol real de Elche).
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import type { Terrain } from './terrain';

const DEG = Math.PI / 180;
const LAT = 38.27 * DEG;

/** Uniformes compartidos por los materiales con sombreadores propios. */
export const shared = {
  uNight: { value: 0 },
  uTime: { value: 0 },
};

export interface SunState {
  elevation: number;
  dir: THREE.Vector3;
  night: number;
}

/** Posición del sol para la hora local (h) y el día del año (horario de verano incluido). */
export function sunAt(hours: number, dayOfYear: number): SunState {
  const decl = -23.44 * DEG * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));
  // Mediodía solar en Elche (lon −0,70°): ~12:00 UTC ± ecuación del tiempo.
  const B = ((2 * Math.PI) / 365) * (dayOfYear - 81);
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutos
  const dst = dayOfYear >= 88 && dayOfYear < 298 ? 2 : 1; // CEST / CET
  const solarNoon = 12 + dst + (0.7 * 4) / 60 - eot / 60;
  const H = (hours - solarNoon) * 15 * DEG;
  const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(sinEl);
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT));
  // Azimut desde el sur hacia el oeste. Coordenadas: x este, z sur.
  const dir = new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  const night = THREE.MathUtils.smoothstep(-el / DEG, -4, 7);
  return { elevation: el, dir, night };
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w;
}`;
const SKY_FRAG = /* glsl */ `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uNight;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 600.0) * 6.0 + pow(s, 12.0) * 0.35) * (1.0 - uNight * 0.85);
  // Estrellas tenues por la noche.
  if (uNight > 0.3 && h > 0.05) {
    vec3 q = floor(d * 380.0);
    float st = step(0.9965, hash(q)) * uNight * smoothstep(0.05, 0.4, h);
    col += vec3(st * 0.9);
  }
  // La niebla de three.js se aplica después del tone mapping: junto al horizonte el cielo va sin
  // él para que su color coincida con el del suelo difuminado y no aparezca una franja.
  #ifdef TONE_MAPPING
  col = mix(col, toneMapping(col), smoothstep(0.01, 0.2, abs(h)));
  #endif
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xcfe5ff, 0x8a7a62, 1.2);
  private skyMat: THREE.ShaderMaterial;
  readonly fog: THREE.Fog;
  shadows = true;
  sunState: SunState = sunAt(12, 135);
  dayOfYear = 135;

  constructor(container: HTMLElement, readonly terrain: Terrain) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 2, 90000);
    this.camera.position.set(900, 1300, 1700);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = 84 * DEG;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 11000;
    this.controls.zoomToCursor = true;
    this.controls.target.set(-300, 0, 300);
    this.controls.update();

    this.fog = new THREE.Fog(0xcfdde6, 3000, 16000);
    this.scene.fog = this.fog;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.5;
    this.sun.shadow.camera.near = 50;
    this.sun.shadow.camera.far = 7000;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color(0x6b6152) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
        uNight: shared.uNight,
      },
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 32, 16), this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    sky.onBeforeRender = (_r, _s, cam) => sky.position.copy(cam.position);
    this.scene.add(sky);

    window.addEventListener('resize', () => this.resize(container));
  }

  resize(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** Ajusta sol, cielo, niebla y luces a la hora simulada (segundos desde medianoche). */
  setTime(t: number) {
    const hours = t / 3600;
    const s = (this.sunState = sunAt(hours, this.dayOfYear));
    const el = s.elevation / DEG;
    shared.uNight.value = s.night;
    shared.uTime.value = t;
    const day = 1 - s.night;
    // Color del sol: cálido cerca del horizonte.
    const warm = THREE.MathUtils.smoothstep(el, -2, 18);
    const sunColor = new THREE.Color().setRGB(1, 0.62 + 0.33 * warm, 0.38 + 0.55 * warm);
    const top = new THREE.Color(0x0b1626).lerp(new THREE.Color(0x3d7fc4), day);
    const horizon = new THREE.Color(0x1a2433).lerp(new THREE.Color(0xc9dbe6), day);
    if (el > -6 && el < 12) {
      const k = 1 - Math.abs(el - 2) / 10;
      horizon.lerp(new THREE.Color(0xf0a35e), Math.max(0, k) * 0.65);
    }
    const u = this.skyMat.uniforms;
    (u.uTop.value as THREE.Color).copy(top);
    (u.uHorizon.value as THREE.Color).copy(horizon);
    (u.uSunDir.value as THREE.Vector3).copy(s.dir);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    this.fog.color.copy(horizon);

    if (el > -1) {
      this.sun.color.copy(sunColor);
      this.sun.intensity = 3.2 * THREE.MathUtils.smoothstep(el, -1, 10);
    } else {
      // Luz de luna, fría y suave.
      this.sun.color.setRGB(0.55, 0.65, 0.95);
      this.sun.intensity = 0.25;
    }
    this.hemi.intensity = 0.55 + 0.85 * day;
    this.hemi.color.set(0x34466a).lerp(new THREE.Color(0xd4e6ff), day);
    this.hemi.groundColor.set(0x2a2622).lerp(new THREE.Color(0x8f806a), day);
    this.renderer.toneMappingExposure = 0.95 + 0.25 * s.night;
  }

  /** Coloca la luz y el área de sombra alrededor de lo que se está mirando. */
  updateShadowFrustum() {
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target);
    const half = THREE.MathUtils.clamp(dist * 0.9, 120, 2200);
    const dir = this.sunState.elevation > -0.02 ? this.sunState.dir : new THREE.Vector3(-0.3, 0.8, 0.4).normalize();
    this.sun.position.copy(target).addScaledVector(dir, 3500);
    this.sun.target.position.copy(target);
    const cam = this.sun.shadow.camera;
    if (cam.right !== half) {
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
    }
    this.sun.castShadow = this.shadows && this.sunState.elevation > 0.02;
  }

  render() {
    this.updateShadowFrustum();
    // Niebla proporcional a la distancia de observación: nítida desde arriba, profunda a ras de suelo.
    // Siempre se cierra antes del plano lejano, para que el suelo se funda con el horizonte.
    const cam = this.camera;
    const dist = cam.position.distanceTo(this.controls.target);
    this.fog.near = Math.max(1200, dist * 1.1);
    this.fog.far = Math.min(cam.far * 0.85, this.fog.near + Math.max(7000, dist * 3.5));
    // Plano cercano según la altura: con near fijo de 2 m, desde lejos el búfer de profundidad
    // no distingue capas separadas por centímetros (suelo, calzadas, aceras) y parpadean.
    const clearance = cam.position.y - this.terrain.heightAt(cam.position.x, cam.position.z);
    const near = THREE.MathUtils.clamp((clearance - 100) * 0.4, 1.5, 4000);
    if (Math.abs(near - cam.near) > cam.near * 0.05) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  }
}
