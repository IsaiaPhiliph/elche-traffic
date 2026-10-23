// Vehículos: mallas instanciadas por tipo, interpoladas entre instantáneas del worker.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const STRIDE = 8;
const MAX_SLOTS = 24000;
// Semiancho, semilargo y altura de los faros por tipo (turismo, furgoneta, camión, bus, moto).
const HALF_W = [0.6, 0.72, 0.95, 1.0, 0];
const HALF_L = [2.25, 2.7, 4.8, 6.05, 0.9];
const LIGHT_Y = [0.68, 0.8, 1.0, 0.85, 0.85];
const CAPACITY = [16000, 5000, 3000, 400, 5000];

// Colores del parque (blanco, gris, negro, plata, azul, rojo, azul marino, verde, beige, naranja, amarillo).
const CAR_COLORS = ['#f2f2ef', '#8a8f96', '#1d1f22', '#c3c7cc', '#2f5d9a', '#b3241f', '#1f2b48', '#3d6b4a', '#c9b48f', '#d46a1f', '#e4c22b', '#6a2135'];
const BUS_FALLBACK = ['#d6232a', '#1b75bc', '#00a651', '#f7941d', '#662d91', '#00aeef', '#ec008c', '#8dc63f'];

interface Box {
  sx: number; sy: number; sz: number; x: number; y: number; z: number; color: string; part: number;
}

function buildModel(boxes: Box[]): THREE.BufferGeometry {
  const parts = boxes.map((b) => {
    const g = new THREE.BoxGeometry(b.sx, b.sy, b.sz).toNonIndexed();
    g.deleteAttribute('uv');
    g.translate(b.x, b.y, b.z);
    const n = g.attributes.position.count;
    const col = new THREE.Color(b.color);
    const c = new Float32Array(n * 3);
    const p = new Float32Array(n).fill(b.part);
    for (let i = 0; i < n; i++) c.set([col.r, col.g, col.b], 3 * i);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('aPart', new THREE.BufferAttribute(p, 1));
    return g;
  });
  return mergeGeometries(parts);
}

const GLASS = '#1f2a33';
const TYRE = '#151515';
const LIGHT = '#fff6dc';
const TAIL = '#7a0d0d';

function wheels(xs: number[], half: number, r: number): Box[] {
  return xs.flatMap((x) => [-1, 1].map((s) => ({ sx: 2 * r, sy: 2 * r, sz: 0.26, x, y: r, z: s * half, color: TYRE, part: 1 })));
}

function lights(front: number, back: number, yF: number, yB: number, half: number): Box[] {
  return [-1, 1].flatMap((s) => [
    { sx: 0.08, sy: 0.16, sz: 0.34, x: front, y: yF, z: s * half, color: LIGHT, part: 2 },
    { sx: 0.08, sy: 0.18, sz: 0.36, x: back, y: yB, z: s * half, color: TAIL, part: 3 },
  ]);
}

function models(): THREE.BufferGeometry[] {
  const car = buildModel([
    { sx: 4.4, sy: 0.62, sz: 1.78, x: 0, y: 0.53, z: 0, color: '#fff', part: 0 },
    { sx: 2.3, sy: 0.56, sz: 1.58, x: -0.25, y: 1.12, z: 0, color: GLASS, part: 1 },
    { sx: 1.9, sy: 0.07, sz: 1.5, x: -0.3, y: 1.43, z: 0, color: '#fff', part: 0 },
    ...wheels([1.35, -1.35], 0.8, 0.31),
    ...lights(2.21, -2.21, 0.68, 0.72, 0.6),
  ]);
  const van = buildModel([
    { sx: 5.3, sy: 1.55, sz: 1.98, x: 0, y: 1.08, z: 0, color: '#fff', part: 0 },
    { sx: 0.95, sy: 0.62, sz: 1.86, x: 2.2, y: 1.48, z: 0, color: GLASS, part: 1 },
    ...wheels([1.75, -1.75], 0.9, 0.34),
    ...lights(2.66, -2.66, 0.8, 0.9, 0.7),
  ]);
  const truck = buildModel([
    { sx: 2.2, sy: 2.3, sz: 2.45, x: 3.6, y: 1.65, z: 0, color: '#fff', part: 0 },
    { sx: 0.4, sy: 0.9, sz: 2.3, x: 4.55, y: 2.1, z: 0, color: GLASS, part: 1 },
    { sx: 7.0, sy: 2.7, sz: 2.5, x: -1.2, y: 1.95, z: 0, color: '#dcdcd6', part: 1 },
    ...wheels([3.4, -0.4, -3.3], 1.05, 0.5),
    ...lights(4.76, -4.71, 1.0, 0.95, 0.95),
  ]);
  const bus = buildModel([
    { sx: 12, sy: 2.2, sz: 2.55, x: 0, y: 1.45, z: 0, color: '#fff', part: 0 },
    { sx: 11.2, sy: 0.95, sz: 2.57, x: -0.2, y: 2.05, z: 0, color: GLASS, part: 1 },
    { sx: 0.1, sy: 1.5, sz: 2.3, x: 6.0, y: 1.75, z: 0, color: GLASS, part: 1 },
    { sx: 11.6, sy: 0.32, sz: 2.4, x: 0, y: 2.72, z: 0, color: '#f4f4f0', part: 1 },
    ...wheels([3.9, -3.2], 1.1, 0.5),
    ...lights(6.02, -6.02, 0.85, 0.95, 1.0),
  ]);
  const moto = buildModel([
    { sx: 1.7, sy: 0.4, sz: 0.5, x: 0, y: 0.6, z: 0, color: '#fff', part: 0 },
    { sx: 0.5, sy: 0.65, sz: 0.55, x: -0.15, y: 1.15, z: 0, color: '#2b2b2e', part: 1 },
    { sx: 0.34, sy: 0.34, sz: 0.34, x: -0.05, y: 1.62, z: 0, color: '#d9d9d9', part: 0 },
    { sx: 0.62, sy: 0.62, sz: 0.14, x: 0.7, y: 0.31, z: 0, color: TYRE, part: 1 },
    { sx: 0.62, sy: 0.62, sz: 0.14, x: -0.7, y: 0.31, z: 0, color: TYRE, part: 1 },
    { sx: 0.08, sy: 0.14, sz: 0.2, x: 0.86, y: 0.85, z: 0, color: LIGHT, part: 2 },
    { sx: 0.08, sy: 0.12, sz: 0.18, x: -0.86, y: 0.75, z: 0, color: TAIL, part: 3 },
  ]);
  return [car, van, truck, bus, moto];
}

export class Vehicles {
  readonly group = new THREE.Group();
  readonly meshes: THREE.InstancedMesh[] = [];
  private states: THREE.InstancedBufferAttribute[] = [];
  private prev = new Float32Array(0);
  private curr = new Float32Array(0);
  private prevN = 0;
  private currN = 0;
  private prevIdx = new Int32Array(MAX_SLOTS).fill(-1);
  private tPrev = 0;
  private tCurr = 0;
  private palette: THREE.Color[];
  /** Posiciones dibujadas en el último fotograma: [slot, x, y, z, rumbo, tipo]. */
  readonly drawn: Float32Array = new Float32Array(MAX_SLOTS * 6);
  drawnN = 0;
  selected = -1;
  private glow: THREE.Points;
  private glowPos: Float32Array;
  private glowCol: Float32Array;
  private uNight: { value: number };

  constructor(night: { value: number }, busColors: (string | null)[]) {
    this.uNight = night;
    this.palette = CAR_COLORS.map((c) => new THREE.Color(c));
    while (this.palette.length < 32) this.palette.push(new THREE.Color('#888'));
    for (let i = 0; i < 16; i++) this.palette.push(new THREE.Color(busColors[i] ?? BUS_FALLBACK[i % BUS_FALLBACK.length]));
    const geos = models();
    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 70, specular: 0x2a2a2a });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = night;
      sh.vertexShader =
        'attribute float aPart;\nattribute float aState;\nvarying float vPart;\nvarying float vState;\n' +
        sh.vertexShader.replace(
          '#include <color_vertex>',
          '#include <color_vertex>\nvPart = aPart; vState = aState;\n#ifdef USE_INSTANCING_COLOR\nvColor.xyz = aPart < 0.5 ? instanceColor.xyz : color.xyz;\n#endif',
        );
      sh.fragmentShader =
        'uniform float uNight;\nvarying float vPart;\nvarying float vState;\n' +
        sh.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float brake = mod(vState, 2.0);
          if (vPart > 1.5 && vPart < 2.5) totalEmissiveRadiance += vec3(1.0, 0.93, 0.78) * (0.2 + uNight * 3.0);
          if (vPart > 2.5) totalEmissiveRadiance += vec3(1.0, 0.06, 0.04) * (0.1 + uNight * 1.1 + brake * 2.2);
          if (vState > 1.5) totalEmissiveRadiance += vec3(0.1, 0.55, 1.0) * 0.55;`,
        );
    };
    geos.forEach((g, k) => {
      const st = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY[k]), 1);
      st.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aState', st);
      const mesh = new THREE.InstancedMesh(g, mat, CAPACITY[k]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color());
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.meshes.push(mesh);
      this.states.push(st);
      this.group.add(mesh);
    });
    // Destellos de faros y pilotos por la noche.
    const N = 4 * 12000;
    this.glowPos = new Float32Array(N * 3);
    this.glowCol = new Float32Array(N * 3);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(this.glowPos, 3).setUsage(THREE.DynamicDrawUsage));
    gg.setAttribute('color', new THREE.BufferAttribute(this.glowCol, 3).setUsage(THREE.DynamicDrawUsage));
    gg.setDrawRange(0, 0);
    this.glow = new THREE.Points(
      gg,
      new THREE.PointsMaterial({ size: 4.4, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }),
    );
    this.glow.frustumCulled = false;
    this.group.add(this.glow);
  }

  /** Nueva instantánea del worker (se copia para poder devolver el búfer). */
  pushFrame(buf: Float32Array, n: number, now: number) {
    const need = n * STRIDE;
    if (this.prev.length < need || this.curr.length < need) {
      const cap = Math.max(need, 8192 * STRIDE);
      const np = new Float32Array(cap);
      np.set(this.curr.subarray(0, this.currN * STRIDE));
      this.prev = np;
      this.curr = new Float32Array(cap);
    } else {
      const t = this.prev;
      this.prev = this.curr;
      this.curr = t;
    }
    this.prevN = this.currN;
    this.curr.set(buf.subarray(0, need));
    this.currN = n;
    this.prevIdx.fill(-1);
    for (let i = 0; i < this.prevN; i++) this.prevIdx[this.prev[i * STRIDE]] = i;
    this.tPrev = this.tCurr || now - 50;
    this.tCurr = now;
  }

  update(now: number, showTunnels = false) {
    const span = Math.max(16, this.tCurr - this.tPrev);
    const alpha = Math.min(1, Math.max(0, (now - this.tCurr) / span));
    const counts = [0, 0, 0, 0, 0];
    const night = this.uNight.value;
    let g = 0;
    let dn = 0;
    for (let i = 0; i < this.currN; i++) {
      const o = i * STRIDE;
      const slot = this.curr[o];
      let x = this.curr[o + 1];
      let y = this.curr[o + 2];
      let z = this.curr[o + 3];
      let h = this.curr[o + 4];
      const kind = this.curr[o + 5];
      const color = this.curr[o + 6];
      const flags = this.curr[o + 7];
      const pi = this.prevIdx[slot];
      if (pi >= 0) {
        const p = pi * STRIDE;
        const px = this.prev[p + 1];
        const pz = this.prev[p + 3];
        // Si dio un salto grande (cambio de plaza), no se interpola.
        if (Math.abs(px - x) + Math.abs(pz - z) < 60) {
          x = px + (x - px) * alpha;
          y = this.prev[p + 2] + (y - this.prev[p + 2]) * alpha;
          z = pz + (z - pz) * alpha;
          let dh = h - this.prev[p + 4];
          if (dh > Math.PI) dh -= 2 * Math.PI;
          if (dh < -Math.PI) dh += 2 * Math.PI;
          h = this.prev[p + 4] + dh * alpha;
        }
      }
      const d6 = dn * 6;
      this.drawn[d6] = slot;
      this.drawn[d6 + 1] = x;
      this.drawn[d6 + 2] = y;
      this.drawn[d6 + 3] = z;
      this.drawn[d6 + 4] = h;
      this.drawn[d6 + 5] = kind;
      dn++;
      if ((flags & 2) && !showTunnels) continue; // en un túnel
      const k = kind | 0;
      const idx = counts[k]++;
      if (idx >= CAPACITY[k]) continue;
      const c = Math.cos(h);
      const s = Math.sin(h);
      // Escritura directa en los búferes de instancias (sin objetos intermedios).
      const mesh = this.meshes[k];
      const M = mesh.instanceMatrix.array as Float32Array;
      const mo = idx * 16;
      M[mo] = c; M[mo + 1] = 0; M[mo + 2] = s; M[mo + 3] = 0;
      M[mo + 4] = 0; M[mo + 5] = 1; M[mo + 6] = 0; M[mo + 7] = 0;
      M[mo + 8] = -s; M[mo + 9] = 0; M[mo + 10] = c; M[mo + 11] = 0;
      M[mo + 12] = x; M[mo + 13] = y + 0.18; M[mo + 14] = z; M[mo + 15] = 1;
      const col = this.palette[color | 0] ?? this.palette[0];
      const C = mesh.instanceColor!.array as Float32Array;
      C[idx * 3] = col.r;
      C[idx * 3 + 1] = col.g;
      C[idx * 3 + 2] = col.b;
      this.states[k].array[idx] = (flags & 1) + (slot === this.selected ? 2 : 0);
      if (night > 0.05 && g < this.glowPos.length / 3 - 4) {
        const half = HALF_W[k];
        const fr = HALF_L[k];
        const hy = y + 0.18 + LIGHT_Y[k];
        const P = this.glowPos;
        const Q = this.glowCol;
        const rr = 0.75 * night + (flags & 1) * 0.7;
        for (let side = k === 4 ? 0 : -1; side <= (k === 4 ? 0 : 1); side += 2) {
          const ox = -s * side * half;
          const oz = c * side * half;
          let q = 3 * g++;
          P[q] = x + c * fr + ox; P[q + 1] = hy; P[q + 2] = z + s * fr + oz;
          Q[q] = 1.1 * night; Q[q + 1] = night; Q[q + 2] = 0.78 * night;
          q = 3 * g++;
          P[q] = x - c * fr + ox; P[q + 1] = hy + 0.04; P[q + 2] = z - s * fr + oz;
          Q[q] = rr; Q[q + 1] = 0.03 * rr; Q[q + 2] = 0.02 * rr;
          if (k === 4) break;
        }
      }
    }
    this.drawnN = dn;
    this.meshes.forEach((mesh, k) => {
      mesh.count = Math.min(counts[k], CAPACITY[k]);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.states[k].needsUpdate = true;
    });
    this.glow.geometry.setDrawRange(0, g);
    (this.glow.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.glow.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.glow.visible = night > 0.05;
  }

  /** Vehículo dibujado más cercano a (x, z) dentro de un radio. */
  nearest(x: number, z: number, radius: number): number {
    let best = -1;
    let bd = radius * radius;
    for (let i = 0; i < this.drawnN; i++) {
      const dx = this.drawn[i * 6 + 1] - x;
      const dz = this.drawn[i * 6 + 3] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = this.drawn[i * 6];
      }
    }
    return best;
  }

  pose(slot: number): { x: number; y: number; z: number; h: number; kind: number } | null {
    for (let i = 0; i < this.drawnN; i++) {
      if (this.drawn[i * 6] === slot) {
        const o = i * 6;
        return { x: this.drawn[o + 1], y: this.drawn[o + 2], z: this.drawn[o + 3], h: this.drawn[o + 4], kind: this.drawn[o + 5] };
      }
    }
    return null;
  }
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
