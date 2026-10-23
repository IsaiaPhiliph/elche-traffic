// Palmeras datileras (el Palmeral d'Elx), árboles de hoja ancha y pinos, instanciados por zonas
// con dos niveles de detalle: modelo completo de cerca y uno muy ligero a distancia.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TreesJSON } from './data';

const CHUNK = 600;
const LOD_FAR = 1200;

// Solo posición y color, sin índices: así todas las piezas se pueden fusionar.
function colorize(src: THREE.BufferGeometry, c: THREE.ColorRepresentation, jitter = 0) {
  const g = src.index ? src.toNonIndexed() : src;
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = 1 + (Math.random() - 0.5) * jitter;
    arr[3 * i] = col.r * k;
    arr[3 * i + 1] = col.g * k;
    arr[3 * i + 2] = col.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function finish(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts);
  merged.computeVertexNormals();
  return merged;
}

/** Corona aplanada (octaedro) para los modelos lejanos. */
function blob(r: number, ry: number, y: number, color: number) {
  const g = new THREE.OctahedronGeometry(r, 0);
  g.scale(1, ry / r, 1);
  g.translate(0, y, 0);
  return colorize(g, color, 0.1);
}

function stick(r: number, h: number, color: number, sides = 3) {
  const g = new THREE.CylinderGeometry(r * 0.75, r, h, sides, 1, true);
  g.translate(0, h / 2, 0);
  return colorize(g, color);
}

/** Palmera datilera de unos 12 m: tronco algo curvado y corona de hojas arqueadas (~80 triángulos). */
function palmHigh(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.23, 0.34, 11, 5, 2, true);
  trunk.translate(0, 5.5, 0);
  const p = trunk.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + Math.pow(p.getY(i) / 11, 2) * 0.6);
  parts.push(colorize(trunk, 0x8a6f4d, 0.15));
  const fronds = 9;
  for (let f = 0; f < fronds; f++) {
    const ang = (f / fronds) * Math.PI * 2 + (f % 2) * 0.25;
    const len = 4.6 + (f % 3) * 0.5;
    const segs = 3;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const r = t * len;
      const droop = Math.sin(t * Math.PI * 0.55) * 1.2 - t * t * 2.6 + (f % 2 ? 0.6 : 0);
      const w = 0.7 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
      const cx = Math.cos(ang) * r + 0.6;
      const cz = Math.sin(ang) * r;
      const cy = 11 + droop;
      const ox = -Math.sin(ang) * w;
      const oz = Math.cos(ang) * w;
      pos.push(cx + ox, cy - 0.15 * w, cz + oz, cx - ox, cy - 0.15 * w, cz - oz);
      if (s > 0) {
        const a = 2 * (s - 1);
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    parts.push(colorize(g, f % 3 === 0 ? 0x5f7a32 : 0x6f8a3a, 0.18));
  }
  const boss = new THREE.OctahedronGeometry(0.75, 0);
  boss.translate(0.6, 11.1, 0);
  parts.push(colorize(boss, 0x6b5a33));
  return finish(parts);
}

function palmLow() {
  return finish([stick(0.3, 11, 0x8a6f4d), blob(4.3, 1.5, 10.6, 0x66833a)]);
}

function treeHigh() {
  const crown = new THREE.IcosahedronGeometry(2.6, 0);
  crown.scale(1, 0.82, 1);
  crown.translate(0, 4.6, 0);
  return finish([stick(0.26, 3.4, 0x7a5f45, 5), colorize(crown, 0x5d8a3f, 0.25)]);
}

function treeLow() {
  return finish([stick(0.26, 3.4, 0x7a5f45), blob(2.6, 2.1, 4.6, 0x5d8a3f)]);
}

/** Pino carrasco / piñonero: copa aparasolada. */
function pineHigh() {
  const crown = new THREE.SphereGeometry(3.4, 7, 4);
  crown.scale(1, 0.42, 1);
  crown.translate(0, 7.6, 0);
  return finish([stick(0.3, 7, 0x6d543d, 5), colorize(crown, 0x4c6e36, 0.2)]);
}

function pineLow() {
  return finish([stick(0.3, 7, 0x6d543d), blob(3.4, 1.4, 7.6, 0x4c6e36)]);
}

export function buildVegetation(data: TreesJSON): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trees';
  const geos = [
    [palmHigh(), palmLow()],
    [treeHigh(), treeLow()],
    [pineHigh(), pineLow()],
  ];
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const chunks = new Map<string, number[][]>();
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const x = d[i] / 10;
    const z = d[i + 1] / 10;
    const key = `${Math.floor(x / CHUNK)}:${Math.floor(z / CHUNK)}:${d[i + 2]}`;
    let arr = chunks.get(key);
    if (!arr) chunks.set(key, (arr = []));
    arr.push([x, z, d[i + 3] / 100]);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const pos = new THREE.Vector3();
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [key, list] of chunks) {
    const [ci, cj, kindStr] = key.split(':').map(Number);
    const kind = kindStr;
    const cx = (ci + 0.5) * CHUNK;
    const cz = (cj + 0.5) * CHUNK;
    const lod = new THREE.LOD();
    lod.position.set(cx, 0, cz);
    const levels = geos[kind].map((geo) => {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.castShadow = true;
      return mesh;
    });
    list.forEach(([x, z, sc], i) => {
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      const tall = kind === 0 ? sc * (0.85 + rnd() * 0.4) : sc;
      s.set(sc, tall, sc);
      pos.set(x - cx, 0, z - cz);
      m.compose(pos, q, s);
      for (const mesh of levels) mesh.setMatrixAt(i, m);
    });
    levels.forEach((mesh) => mesh.computeBoundingSphere());
    lod.addLevel(levels[0], 0);
    lod.addLevel(levels[1], LOD_FAR);
    group.add(lod);
  }
  return group;
}
