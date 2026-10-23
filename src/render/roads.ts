// Calzadas con marcas viales dibujadas en el sombreador (líneas, pasos de peatones,
// líneas de detención) y una textura por tramo para congestión, cortes y rutas.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { RoadsJSON } from './data';
import type { Terrain } from './terrain';

const RAMP: [number, THREE.Color][] = [
  [0, new THREE.Color(0.43, 0.06, 0.12)],
  [0.15, new THREE.Color(0.84, 0.15, 0.24)],
  [0.35, new THREE.Color(0.94, 0.49, 0.2)],
  [0.55, new THREE.Color(0.95, 0.77, 0.24)],
  [0.75, new THREE.Color(0.66, 0.84, 0.29)],
  [1, new THREE.Color(0.18, 0.75, 0.44)],
];
function rampColor(r: number, out: THREE.Color) {
  for (let i = 1; i < RAMP.length; i++) {
    if (r <= RAMP[i][0] || i === RAMP.length - 1) {
      const t = Math.min(1, Math.max(0, (r - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0])));
      return out.copy(RAMP[i - 1][1]).lerp(RAMP[i][1], t);
    }
  }
  return out;
}

const TEX_W = 1024;
const ROAD_Y = 0.18;
const TUNNEL_H = 5; // gálibo hasta el techo del túnel
const PARAPET = 0.9; // pretil sobre el borde de la trinchera

function polyNormals(p: number[]) {
  const n = p.length / 3;
  const nx = new Float32Array(n);
  const nz = new Float32Array(n);
  const sc = new Float32Array(n);
  const along = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let ax = 0;
    let az = 0;
    let cnt = 0;
    let dotMin = 1;
    const segN: [number, number][] = [];
    for (const [a, b] of [[i - 1, i], [i, i + 1]]) {
      if (a < 0 || b >= n) continue;
      const dx = p[3 * b] - p[3 * a];
      const dz = p[3 * b + 2] - p[3 * a + 2];
      const l = Math.hypot(dx, dz) || 1;
      segN.push([-dz / l, dx / l]);
      ax += -dz / l;
      az += dx / l;
      cnt++;
    }
    const l = Math.hypot(ax, az) || 1;
    nx[i] = ax / l;
    nz[i] = az / l;
    for (const s of segN) dotMin = Math.min(dotMin, s[0] * nx[i] + s[1] * nz[i]);
    sc[i] = cnt > 1 ? 1 / Math.max(0.45, dotMin) : 1;
    if (i > 0) along[i] = along[i - 1] + Math.hypot(p[3 * i] - p[3 * i - 3], p[3 * i + 2] - p[3 * i - 1]);
  }
  return { nx, nz, sc, along, n };
}

const ROAD_VERT_HEAD = /* glsl */ `
attribute vec4 aRoad;
attribute vec4 aLanes;
attribute float aFlags;
varying vec4 vRoad;
varying vec4 vLanes;
varying float vFlags;
`;

const ROAD_FRAG_HEAD = /* glsl */ `
uniform sampler2D uHeat;
uniform float uHeatOn;
uniform float uNight;
varying vec4 vRoad;
varying vec4 vLanes;
varying float vFlags;
float lineMask(float d, float w) {
  float aa = fwidth(d) * 0.8 + 0.002;
  return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(d));
}
float band(float x, float a, float b) {
  float aa = fwidth(x) * 0.8 + 0.002;
  return smoothstep(a - aa, a + aa, x) * (1.0 - smoothstep(b - aa, b + aa, x));
}
vec3 heatRamp(float r) {
  vec3 c0 = vec3(0.43, 0.06, 0.12);
  vec3 c1 = vec3(0.84, 0.15, 0.24);
  vec3 c2 = vec3(0.94, 0.49, 0.2);
  vec3 c3 = vec3(0.95, 0.77, 0.24);
  vec3 c4 = vec3(0.66, 0.84, 0.29);
  vec3 c5 = vec3(0.18, 0.75, 0.44);
  if (r < 0.15) return mix(c0, c1, r / 0.15);
  if (r < 0.35) return mix(c1, c2, (r - 0.15) / 0.2);
  if (r < 0.55) return mix(c2, c3, (r - 0.35) / 0.2);
  if (r < 0.75) return mix(c3, c4, (r - 0.55) / 0.2);
  return mix(c4, c5, clamp((r - 0.75) / 0.25, 0.0, 1.0));
}
`;

const ROAD_FRAG_BODY = /* glsl */ `
{
  float lat = vRoad.x;
  float along = vRoad.y;
  float W = vRoad.z;
  float L = vRoad.w;
  float nF = vLanes.x;
  float nB = vLanes.y;
  int fl = int(vFlags + 0.5);
  vec3 col = diffuseColor.rgb;
  if (nF + nB > 0.5) {
    float hw = (nF + nB) * W * 0.5;
    float dv = (nB - nF) * 0.5 * W;
    float m = 0.0;
    float dash = step(fract(along / 9.0), 0.45);
    if ((fl & 64) != 0) m = max(m, lineMask(abs(lat) - (hw - 0.32), 0.15));
    if (nF > 0.5 && nB > 0.5) {
      if (nF + nB >= 4.0) m = max(m, max(lineMask(lat - dv - 0.13, 0.12), lineMask(lat - dv + 0.13, 0.12)));
      else m = max(m, lineMask(lat - dv, 0.13) * dash);
    }
    for (int k = 1; k < 5; k++) {
      float fk = float(k);
      if (fk < nF) m = max(m, lineMask(lat - (dv + fk * W), 0.12) * dash);
      if (fk < nB) m = max(m, lineMask(lat - (dv - fk * W), 0.12) * dash);
    }
    bool fwd = lat > dv;
    float stripes = step(0.5, fract(lat / 1.0 + 0.25));
    // Final del tramo (sentido directo).
    if ((fl & 1) != 0 && L > 15.0) {
      m = max(m, band(along, L - 4.0, L - 0.6) * stripes);
      if (fwd) m = max(m, band(along, L - 4.75, L - 4.35));
    } else if (fwd && (fl & (1 | 16)) != 0) {
      m = max(m, band(along, L - 0.75, L - 0.3));
    } else if (fwd && (fl & 4) != 0) {
      m = max(m, band(along, L - 0.75, L - 0.35) * step(0.45, fract(lat / 0.9)));
    }
    // Inicio del tramo (sentido contrario).
    if ((fl & 2) != 0 && L > 15.0) {
      m = max(m, band(along, 0.6, 4.0) * stripes);
      if (!fwd) m = max(m, band(along, 4.35, 4.75));
    } else if (!fwd && (fl & (2 | 32)) != 0) {
      m = max(m, band(along, 0.3, 0.75));
    } else if (!fwd && (fl & 8) != 0) {
      m = max(m, band(along, 0.35, 0.75) * step(0.45, fract(lat / 0.9)));
    }
    col = mix(col, vec3(0.86, 0.86, 0.83) * (1.0 - 0.55 * uNight), m * 0.92);
    float e = fwd ? vLanes.z : vLanes.w;
    if (e >= 0.0) {
      vec4 h = texelFetch(uHeat, ivec2(int(mod(e, ${TEX_W}.0)), int(e / ${TEX_W}.0)), 0);
      if (uHeatOn > 0.5 && h.r < 0.999) col = mix(col, heatRamp(h.r * 255.0 / 200.0), 0.8);
      if (h.g > 0.5) {
        float st = step(0.5, fract((along + lat) / 2.5));
        col = mix(col, mix(vec3(0.8, 0.1, 0.08), vec3(0.92), st), 0.85);
      }
      if (h.b > 0.5) col = mix(col, vec3(0.15, 0.72, 1.0), 0.65);
    }
    // Alumbrado público: charcos de luz cálida cada ~30 m junto a los bordillos.
    if (uNight > 0.02) {
      float ph = fract(along / 30.0 + (lat > 0.0 ? 0.5 : 0.0));
      float pool = exp(-pow((ph - 0.5) * 30.0, 2.0) / 60.0) * smoothstep(hw * 0.2, hw, abs(lat) + 1.5);
      roadGlow = vec3(1.0, 0.68, 0.36) * uNight * (0.035 + 0.16 * pool);
    }
  } else {
    // Los cruces suelen estar bien iluminados.
    roadGlow = vec3(1.0, 0.68, 0.36) * uNight * 0.1;
  }
  diffuseColor.rgb = col;
}
`;

export interface EdgeEnd {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  hw: number;
}

export class Roads {
  readonly group = new THREE.Group();
  private heatData: Uint8Array;
  private heatTex: THREE.DataTexture;
  readonly uniforms = { uHeatOn: { value: 0 } };
  private edgeSeg: Int32Array;
  private edgeFwd: Uint8Array;
  private grid = new Map<number, number[]>();
  private routeEdges: number[] = [];
  readonly segs: RoadsJSON['segments'];
  private material: THREE.MeshLambertMaterial;
  /** Líneas de congestión con grosor en píxeles para la vista lejana. */
  readonly heatLines: LineSegments2;
  private heatLineEdge: Int32Array;
  private heatLineMat: LineMaterial;

  constructor(roads: RoadsJSON, nEdges: number, night: { value: number }, private terrain: Terrain) {
    this.segs = roads.segments;
    const rows = Math.ceil(Math.max(1, nEdges) / TEX_W);
    this.heatData = new Uint8Array(TEX_W * rows * 4);
    for (let i = 0; i < TEX_W * rows; i++) this.heatData[4 * i] = 255;
    this.heatTex = new THREE.DataTexture(this.heatData, TEX_W, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.heatTex.minFilter = THREE.NearestFilter;
    this.heatTex.magFilter = THREE.NearestFilter;
    this.heatTex.needsUpdate = true;
    this.edgeSeg = new Int32Array(nEdges).fill(-1);
    this.edgeFwd = new Uint8Array(nEdges);
    roads.segments.forEach((s, i) => {
      if (s.eF >= 0) {
        this.edgeSeg[s.eF] = i;
        this.edgeFwd[s.eF] = 1;
      }
      if (s.eB >= 0) this.edgeSeg[s.eB] = i;
      this.indexSegment(i, s.p);
    });

    this.material = new THREE.MeshLambertMaterial({ color: 0x4a4d52, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
    this.material.onBeforeCompile = (sh) => {
      sh.uniforms.uHeat = { value: this.heatTex };
      sh.uniforms.uHeatOn = this.uniforms.uHeatOn;
      sh.uniforms.uNight = night;
      sh.vertexShader = ROAD_VERT_HEAD + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad; vLanes = aLanes; vFlags = aFlags;');
      sh.fragmentShader = ROAD_FRAG_HEAD + sh.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\nvec3 roadGlow = vec3(0.0);\n' + ROAD_FRAG_BODY)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += roadGlow;');
    };
    this.build(roads);

    // Un trazo por sentido, desplazado hacia su lado de la calzada.
    const lp: number[] = [];
    const le: number[] = [];
    for (const s of roads.segments) {
      const n = s.p.length / 3;
      for (const [e, side] of [[s.eF, 1], [s.eB, -1]] as const) {
        if (e < 0) continue;
        const off = s.nF > 0 && s.nB > 0 ? side * s.w * 0.25 : 0;
        for (let k = 1; k < n; k++) {
          const ax = s.p[3 * k - 3];
          const az = s.p[3 * k - 1];
          const bx = s.p[3 * k];
          const bz = s.p[3 * k + 2];
          const l = Math.hypot(bx - ax, bz - az) || 1;
          const nx = (-(bz - az) / l) * off;
          const nz = ((bx - ax) / l) * off;
          lp.push(ax + nx, s.p[3 * k - 2] + 1.2, az + nz, bx + nx, s.p[3 * k + 1] + 1.2, bz + nz);
          le.push(e);
        }
      }
    }
    const lg = new LineSegmentsGeometry();
    lg.setPositions(lp);
    lg.setColors(new Float32Array(lp.length).fill(0.4));
    this.heatLineEdge = Int32Array.from(le);
    this.heatLineMat = new LineMaterial({ linewidth: 2.4, vertexColors: true, worldUnits: false, depthWrite: false });
    this.heatLineMat.toneMapped = false;
    this.heatLineMat.fog = false;
    this.heatLines = new LineSegments2(lg, this.heatLineMat);
    this.heatLines.visible = false;
    this.heatLines.renderOrder = 2;
    this.heatLines.frustumCulled = false;
    this.group.add(this.heatLines);
  }

  /** Ajusta la capa de líneas según la distancia de la cámara (en m) y el tamaño de la vista. */
  updateHeatLines(camDist: number, width: number, height: number) {
    const on = this.uniforms.uHeatOn.value > 0.5 && camDist > 650;
    this.heatLines.visible = on;
    if (!on) return;
    this.heatLineMat.resolution.set(width, height);
    this.heatLineMat.linewidth = THREE.MathUtils.clamp(5200 / camDist, 1.6, 4.5);
  }

  private indexSegment(i: number, p: number[]) {
    const seen = new Set<number>();
    for (let k = 0; k < p.length; k += 3) {
      const key = Math.floor(p[k] / 60) * 100003 + Math.floor(p[k + 2] / 60);
      if (seen.has(key)) continue;
      seen.add(key);
      let arr = this.grid.get(key);
      if (!arr) this.grid.set(key, (arr = []));
      arr.push(i);
    }
    // Tramos largos sin vértices intermedios: rellena las celdas recorridas.
    for (let k = 3; k < p.length; k += 3) {
      const L = Math.hypot(p[k] - p[k - 3], p[k + 2] - p[k - 1]);
      for (let t = 30; t < L; t += 30) {
        const x = p[k - 3] + ((p[k] - p[k - 3]) * t) / L;
        const z = p[k - 1] + ((p[k + 2] - p[k - 1]) * t) / L;
        const key = Math.floor(x / 60) * 100003 + Math.floor(z / 60);
        if (seen.has(key)) continue;
        seen.add(key);
        let arr = this.grid.get(key);
        if (!arr) this.grid.set(key, (arr = []));
        arr.push(i);
      }
    }
  }

  private build(roads: RoadsJSON) {
    const pos: number[] = [];
    const aRoad: number[] = [];
    const aLanes: number[] = [];
    const aFlags: number[] = [];
    const idx: number[] = [];
    const walkPos: number[] = [];
    const walkCol: number[] = [];
    const walkIdx: number[] = [];
    const skirtPos: number[] = [];
    const skirtIdx: number[] = [];
    const pillars: THREE.Matrix4[] = [];
    const wallPos: number[] = [];
    const wallIdx: number[] = [];
    const ground = (x: number, z: number) => this.terrain.heightAt(x, z);
    // Cuadrilátero vertical o inclinado con las dos caras (muros, techos y pretiles).
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      const o = wallPos.length / 3;
      wallPos.push(...a, ...b, ...c, ...d);
      wallIdx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    const walkColor = new THREE.Color(0xd3cdc2);
    const curbColor = new THREE.Color(0x9c978e);

    const strip = (
      P: number[], norm: ReturnType<typeof polyNormals>, lat0: number, lat1: number, yOff: number,
      outPos: number[], outIdx: number[], extra?: (i: number, lat: number) => void,
    ) => {
      const base = outPos.length / 3;
      for (let i = 0; i < norm.n; i++) {
        for (const lat of [lat0, lat1]) {
          const s = lat * norm.sc[i];
          outPos.push(P[3 * i] + norm.nx[i] * s, P[3 * i + 1] + yOff, P[3 * i + 2] + norm.nz[i] * s);
          extra?.(i, lat);
        }
        if (i > 0) {
          const a = base + 2 * (i - 1);
          outIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    };

    for (const s of roads.segments) {
      const norm = polyNormals(s.p);
      if (norm.n < 2) continue;
      const hw = s.w / 2;
      const laneW = s.w / Math.max(1, s.nF + s.nB);
      const L = norm.along[norm.n - 1];
      const edgeLines = s.c <= 7 ? 64 : 0;
      strip(s.p, norm, -hw, hw, ROAD_Y, pos, idx, (i, lat) => {
        aRoad.push(lat, norm.along[i], laneW, L);
        aLanes.push(s.nF, s.nB, s.eF, s.eB);
        aFlags.push(s.sl | edgeLines);
      });
      if (s.f & 16) this.underpass(s.p, norm, hw, (s.f & 4) !== 0, ground, quad);
      if (s.f & 8 && !(s.f & 16)) {
        const sw = s.c <= 7 ? 3.2 : 2.4;
        for (const side of [-1, 1]) {
          const a = side * hw;
          const b = side * (hw + 0.28);
          const c = side * (hw + sw);
          const push = (col: THREE.Color) => () => walkCol.push(col.r, col.g, col.b);
          strip(s.p, norm, Math.min(a, b), Math.max(a, b), 0.1, walkPos, walkIdx, push(curbColor));
          strip(s.p, norm, Math.min(b, c), Math.max(b, c), 0.08, walkPos, walkIdx, push(walkColor));
        }
      }
      // Puentes: cantos del tablero y pilas (sobre el terreno, que en el Vinalopó queda muy abajo).
      let maxY = 0;
      for (let i = 0; i < norm.n; i++) maxY = Math.max(maxY, s.p[3 * i + 1] - ground(s.p[3 * i], s.p[3 * i + 2]));
      if (maxY > 0.8 && !(s.f & 16)) {
        for (const side of [-1, 1]) {
          const base = skirtPos.length / 3;
          for (let i = 0; i < norm.n; i++) {
            const sx = norm.nx[i] * side * hw * norm.sc[i];
            const sz = norm.nz[i] * side * hw * norm.sc[i];
            const y = s.p[3 * i + 1] + ROAD_Y;
            const gy = ground(s.p[3 * i] + sx, s.p[3 * i + 2] + sz);
            skirtPos.push(s.p[3 * i] + sx, y, s.p[3 * i + 2] + sz, s.p[3 * i] + sx, Math.max(gy, y - 1.3), s.p[3 * i + 2] + sz);
            if (i > 0) {
              const a = base + 2 * (i - 1);
              if (side > 0) skirtIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
              else skirtIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
          }
        }
        for (let d = 15; d < L; d += 32) {
          let k = 1;
          while (k < norm.n - 1 && norm.along[k] < d) k++;
          const t = (d - norm.along[k - 1]) / Math.max(0.01, norm.along[k] - norm.along[k - 1]);
          const x = s.p[3 * k - 3] + (s.p[3 * k] - s.p[3 * k - 3]) * t;
          const y = s.p[3 * k - 2] + (s.p[3 * k + 1] - s.p[3 * k - 2]) * t;
          const z = s.p[3 * k - 1] + (s.p[3 * k + 2] - s.p[3 * k - 1]) * t;
          const gy = ground(x, z) - 0.5;
          if (y - gy < 3) continue;
          // Pila transversal al tablero, desde el terreno.
          const ang = Math.atan2(s.p[3 * k + 2] - s.p[3 * k - 1], s.p[3 * k] - s.p[3 * k - 3]);
          pillars.push(
            new THREE.Matrix4()
              .makeTranslation(x, (y - 1.2 + gy) / 2, z)
              .multiply(new THREE.Matrix4().makeRotationY(-ang + Math.PI / 2))
              .multiply(new THREE.Matrix4().makeScale(Math.min(s.w * 0.6, 6), y - 1.2 - gy, 1.4)),
          );
        }
      }
    }
    // Intersecciones: polígonos de asfalto sin marcas.
    for (const j of roads.junctions) {
      const n = j.p.length / 2;
      if (n < 3) continue;
      const base = pos.length / 3;
      for (let k = 0; k < n; k++) {
        pos.push(j.p[2 * k], j.y + ROAD_Y - 0.01, j.p[2 * k + 1]);
        aRoad.push(0, 0, 3, 0);
        aLanes.push(0, 0, -1, -1);
        aFlags.push(0);
      }
      for (let k = 1; k < n - 1; k++) idx.push(base, base + k + 1, base + k);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(aRoad, 4));
    geo.setAttribute('aLanes', new THREE.Float32BufferAttribute(aLanes, 4));
    geo.setAttribute('aFlags', new THREE.Float32BufferAttribute(aFlags, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.name = 'roads';
    this.group.add(mesh);

    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.Float32BufferAttribute(walkPos, 3));
    wgeo.setAttribute('color', new THREE.Float32BufferAttribute(walkCol, 3));
    wgeo.setIndex(walkIdx);
    wgeo.computeVertexNormals();
    const walk = new THREE.Mesh(wgeo, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    walk.receiveShadow = true;
    walk.name = 'sidewalks';
    this.group.add(walk);

    if (skirtPos.length) {
      const sgeo = new THREE.BufferGeometry();
      sgeo.setAttribute('position', new THREE.Float32BufferAttribute(skirtPos, 3));
      sgeo.setIndex(skirtIdx);
      sgeo.computeVertexNormals();
      const sk = new THREE.Mesh(sgeo, new THREE.MeshLambertMaterial({ color: 0xb9b3a8, side: THREE.DoubleSide }));
      sk.castShadow = true;
      sk.receiveShadow = true;
      this.group.add(sk);
    }
    if (wallPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
      g.setIndex(wallIdx);
      g.computeVertexNormals();
      const walls = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xaaa499, side: THREE.DoubleSide }));
      walls.castShadow = true;
      walls.receiveShadow = true;
      walls.name = 'underpasses';
      this.group.add(walls);
    }
    if (pillars.length) {
      const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xbdb7ab }), pillars.length);
      pillars.forEach((m, i) => pm.setMatrixAt(i, m));
      pm.castShadow = true;
      pm.receiveShadow = true;
      this.group.add(pm);
    }
    // Isletas de las glorietas.
    const iPos: number[] = [];
    const iIdx: number[] = [];
    for (const r of roads.islands) {
      const n = r.length / 2;
      if (n < 3) continue;
      const base = iPos.length / 3;
      for (let k = 0; k < n; k++) iPos.push(r[2 * k], ground(r[2 * k], r[2 * k + 1]) + 0.24, r[2 * k + 1]);
      for (let k = 1; k < n - 1; k++) iIdx.push(base, base + k + 1, base + k);
    }
    const igeo = new THREE.BufferGeometry();
    igeo.setAttribute('position', new THREE.Float32BufferAttribute(iPos, 3));
    igeo.setIndex(iIdx);
    igeo.computeVertexNormals();
    const isl = new THREE.Mesh(igeo, new THREE.MeshLambertMaterial({ color: 0x86ad62, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    isl.receiveShadow = true;
    this.group.add(isl);
  }

  /**
   * Paso inferior: muros de contención hasta la superficie (con pretil) donde la calzada va en
   * trinchera; en el tramo cubierto, muros hasta el techo, el techo y las bocas del túnel.
   */
  private underpass(
    P: number[], norm: ReturnType<typeof polyNormals>, hw: number, covered: boolean,
    ground: (x: number, z: number) => number, quad: (a: number[], b: number[], c: number[], d: number[]) => void,
  ) {
    const off = hw + 0.6;
    const n = norm.n;
    const side = (i: number, sgn: number) => {
      const s = sgn * off * norm.sc[i];
      return [P[3 * i] + norm.nx[i] * s, P[3 * i + 2] + norm.nz[i] * s];
    };
    const surf = (i: number) => ground(P[3 * i], P[3 * i + 2]);
    const roof = (i: number) => Math.min(surf(i) - 0.35, P[3 * i + 1] + TUNNEL_H);
    for (let i = 1; i < n; i++) {
      const dA = surf(i - 1) - P[3 * i - 2];
      const dB = surf(i) - P[3 * i + 1];
      if (Math.max(dA, dB) < 0.05) continue;
      const yA = P[3 * i - 2] - 0.3;
      const yB = P[3 * i + 1] - 0.3;
      for (const sgn of [-1, 1]) {
        const [ax, az] = side(i - 1, sgn);
        const [bx, bz] = side(i, sgn);
        const tA = covered ? roof(i - 1) : ground(ax, az) + PARAPET;
        const tB = covered ? roof(i) : ground(bx, bz) + PARAPET;
        quad([ax, yA, az], [bx, yB, bz], [bx, tB, bz], [ax, tA, az]);
        if (!covered) {
          // Albardilla: tapa la junta entre el muro y el borde recortado del suelo.
          const w = 0.3 * sgn;
          const ax2 = ax + norm.nx[i - 1] * w;
          const az2 = az + norm.nz[i - 1] * w;
          const bx2 = bx + norm.nx[i] * w;
          const bz2 = bz + norm.nz[i] * w;
          const ax1 = ax - norm.nx[i - 1] * w;
          const az1 = az - norm.nz[i - 1] * w;
          const bx1 = bx - norm.nx[i] * w;
          const bz1 = bz - norm.nz[i] * w;
          quad([ax1, tA, az1], [bx1, tB, bz1], [bx2, tB, bz2], [ax2, tA, az2]);
        }
      }
      if (covered) {
        const [lx0, lz0] = side(i - 1, -1);
        const [rx0, rz0] = side(i - 1, 1);
        const [lx1, lz1] = side(i, -1);
        const [rx1, rz1] = side(i, 1);
        quad([lx0, roof(i - 1), lz0], [lx1, roof(i), lz1], [rx1, roof(i), rz1], [rx0, roof(i - 1), rz0]);
      }
    }
    if (!covered) return;
    // Bocas: frente entre el techo y la superficie (más el pretil) en cada extremo.
    for (const i of [0, n - 1]) {
      if (surf(i) - P[3 * i + 1] < 2) continue;
      const [lx, lz] = side(i, -1);
      const [rx, rz] = side(i, 1);
      const y0 = roof(i) - 0.4;
      const y1 = surf(i) + PARAPET;
      quad([lx, y0, lz], [rx, y0, rz], [rx, y1, rz], [lx, y1, lz]);
    }
  }

  setHeat(heat: Uint8Array) {
    const d = this.heatData;
    for (let e = 0; e < heat.length; e++) d[4 * e] = heat[e];
    this.heatTex.needsUpdate = true;
    // Colores de la capa de líneas (inicio y fin de cada trazo).
    const geo = this.heatLines.geometry as LineSegmentsGeometry;
    const attr = geo.attributes.instanceColorStart as THREE.InterleavedBufferAttribute;
    const arr = attr.data.array as Float32Array;
    const c = new THREE.Color();
    const idle = new THREE.Color(0.22, 0.23, 0.25);
    for (let i = 0; i < this.heatLineEdge.length; i++) {
      const e = this.heatLineEdge[i];
      const h = heat[e];
      if (this.heatData[4 * e + 1]) c.setRGB(0.85, 0.1, 0.08);
      else if (h === 255) c.copy(idle);
      else rampColor(h / 200, c);
      const o = 6 * i;
      arr[o] = arr[o + 3] = c.r;
      arr[o + 1] = arr[o + 4] = c.g;
      arr[o + 2] = arr[o + 5] = c.b;
    }
    attr.data.needsUpdate = true;
  }

  setHeatVisible(on: boolean) {
    this.uniforms.uHeatOn.value = on ? 1 : 0;
  }

  setClosed(edges: number[], closed: boolean) {
    for (const e of edges) this.heatData[4 * e + 1] = closed ? 255 : 0;
    this.heatTex.needsUpdate = true;
  }

  isClosed(e: number) {
    return this.heatData[4 * e + 1] > 0;
  }

  setRoute(edges: number[] | null) {
    for (const e of this.routeEdges) this.heatData[4 * e + 2] = 0;
    this.routeEdges = edges ?? [];
    for (const e of this.routeEdges) if (e >= 0) this.heatData[4 * e + 2] = 255;
    this.heatTex.needsUpdate = true;
  }

  /** Tramo más cercano al punto (x, z): segmento y tramo dirigido por el lado pulsado. */
  pick(x: number, z: number): { seg: number; edge: number; dist: number } | null {
    let best: { seg: number; edge: number; dist: number } | null = null;
    const cx = Math.floor(x / 60);
    const cz = Math.floor(z / 60);
    const seen = new Set<number>();
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cz - 1; j <= cz + 1; j++) {
        for (const si of this.grid.get(i * 100003 + j) ?? []) {
          if (seen.has(si)) continue;
          seen.add(si);
          const s = this.segs[si];
          const p = s.p;
          for (let k = 3; k < p.length; k += 3) {
            const ax = p[k - 3];
            const az = p[k - 1];
            const bx = p[k];
            const bz = p[k + 2];
            const dx = bx - ax;
            const dz = bz - az;
            const l2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
            const px = ax + dx * t;
            const pz = az + dz * t;
            const d = Math.hypot(x - px, z - pz);
            if (d < s.w / 2 + 3 && (!best || d < best.dist)) {
              // Lado derecho del sentido directo → tramo directo.
              const side = (x - px) * -dz + (z - pz) * dx;
              const edge = side >= 0 ? (s.eF >= 0 ? s.eF : s.eB) : s.eB >= 0 ? s.eB : s.eF;
              best = { seg: si, edge, dist: d };
            }
          }
        }
      }
    }
    return best;
  }

  segmentOf(e: number) {
    return this.edgeSeg[e];
  }

  /** Punto final de un tramo dirigido (línea de detención) y su dirección. */
  edgeEnd(e: number): EdgeEnd | null {
    const si = this.edgeSeg[e];
    if (si < 0) return null;
    const s = this.segs[si];
    const p = s.p;
    const n = p.length / 3;
    const fwd = this.edgeFwd[e] === 1;
    const i1 = fwd ? n - 1 : 0;
    const i0 = fwd ? n - 2 : 1;
    const dx = p[3 * i1] - p[3 * i0];
    const dz = p[3 * i1 + 2] - p[3 * i0 + 2];
    const l = Math.hypot(dx, dz) || 1;
    return { x: p[3 * i1], y: p[3 * i1 + 1], z: p[3 * i1 + 2], dx: dx / l, dz: dz / l, hw: s.w / 2 };
  }

  /** Centro aproximado de un tramo (para encuadrar la cámara). */
  edgeMid(e: number): THREE.Vector3 | null {
    const si = this.edgeSeg[e];
    if (si < 0) return null;
    const p = this.segs[si].p;
    const k = Math.floor(p.length / 6) * 3;
    return new THREE.Vector3(p[k], p[k + 1], p[k + 2]);
  }

  segmentName(si: number, names: string[]) {
    const n = this.segs[si].n;
    return n >= 0 ? names[n] : '';
  }
}
