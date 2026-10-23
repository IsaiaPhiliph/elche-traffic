// Terreno: usos del suelo, cauce del Vinalopó, plazas y vías del tren pintados en una
// textura (sin solapes ni z-fighting) sobre la malla del relieve, que recibe sombras.
import * as THREE from 'three';
import type { AreasJSON, RoadsJSON } from './data';
import type { Terrain } from './terrain';

export const AREA_COLORS: Record<string, string> = {
  residential: '#d8d0c2',
  commercial: '#d6cfc6',
  industrial: '#cbc6bd',
  farmland: '#c9c49a',
  construction: '#cdbfa6',
  railway: '#bdb5a6',
  cemetery: '#b9c2a0',
  grass: '#a8c27f',
  park: '#93b86c',
  palmeral: '#9aa868',
  forest: '#86a062',
  sand: '#ddd0aa',
  pitch: '#7fb365',
  parking: '#bdb8b0',
  square: '#d9cdb6',
  water: '#6fa3c2',
};
const BASE = '#cfc6af';
/** Campo de Elche alrededor del área de estudio; el borde de la textura se funde con él. */
const OUTSIDE = '#bfb796';
const EDGE_FADE = 450; // m

export interface GroundExtent {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function unpackPolys(data: number[], cb: (type: number, rings: number[][]) => void) {
  let i = 0;
  while (i < data.length) {
    const type = data[i++];
    const nr = data[i++];
    const lens = data.slice(i, i + nr);
    i += nr;
    const rings: number[][] = [];
    for (const l of lens) {
      rings.push(data.slice(i, i + 2 * l));
      i += 2 * l;
    }
    cb(type, rings);
  }
}

export function buildGround(areas: AreasJSON, roads: RoadsJSON, ext: GroundExtent, maxTex: number, terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  const W = ext.maxX - ext.minX;
  const H = ext.maxZ - ext.minZ;
  const size = Math.min(maxTex, 8192);
  const scale = size / Math.max(W, H);
  const cw = Math.ceil(W * scale);
  const ch = Math.ceil(H * scale);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const g = canvas.getContext('2d')!;
  const tx = (x: number) => (x - ext.minX) * scale;
  const tz = (z: number) => (z - ext.minZ) * scale;
  g.fillStyle = BASE;
  g.fillRect(0, 0, cw, ch);
  // Grano sutil para que el suelo no sea plano.
  const noise = g.createImageData(256, 256);
  for (let k = 0; k < noise.data.length; k += 4) {
    const n = 128 + (Math.random() - 0.5) * 34;
    noise.data[k] = noise.data[k + 1] = noise.data[k + 2] = n;
    noise.data[k + 3] = 18;
  }
  const nc = document.createElement('canvas');
  nc.width = nc.height = 256;
  nc.getContext('2d')!.putImageData(noise, 0, 0);

  const drawRings = (rings: number[][]) => {
    const p = new Path2D();
    for (const r of rings) {
      p.moveTo(tx(r[0] / 10), tz(r[1] / 10));
      for (let k = 2; k < r.length; k += 2) p.lineTo(tx(r[k] / 10), tz(r[k + 1] / 10));
      p.closePath();
    }
    g.fill(p, 'evenodd');
  };
  unpackPolys(areas.data, (type, rings) => {
    const name = areas.types[type];
    if (name === 'water') return;
    g.fillStyle = AREA_COLORS[name] ?? BASE;
    drawRings(rings);
    if (name === 'palmeral') {
      // Tierra de los huertos bajo las palmeras.
      g.save();
      g.globalAlpha = 0.25;
      g.fillStyle = '#a58d62';
      drawRings(rings);
      g.restore();
    }
  });
  // Cauce del Vinalopó y agua.
  for (const r of areas.rivers) {
    g.strokeStyle = r.w > 10 ? '#a9b48a' : '#7fa9c0';
    g.lineWidth = r.w * scale * (r.w > 10 ? 2.2 : 1);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(tx(r.p[0]), tz(r.p[1]));
    for (let k = 2; k < r.p.length; k += 2) g.lineTo(tx(r.p[k]), tz(r.p[k + 1]));
    g.stroke();
    if (r.w > 10) {
      g.strokeStyle = '#7ea7bd';
      g.lineWidth = Math.max(2, r.w * scale * 0.35);
      g.stroke();
    }
  }
  unpackPolys(areas.data, (type, rings) => {
    if (areas.types[type] !== 'water') return;
    g.fillStyle = AREA_COLORS.water;
    drawRings(rings);
  });
  // Zonas peatonales (plazas y calles del centro).
  g.fillStyle = '#e0d4bd';
  g.strokeStyle = '#e0d4bd';
  for (const p of roads.pedestrian) {
    if (p.a) {
      drawRings([p.p.map((v) => v * 10)]);
    } else {
      g.lineWidth = p.w * scale;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(tx(p.p[0]), tz(p.p[1]));
      for (let k = 2; k < p.p.length; k += 2) g.lineTo(tx(p.p[k]), tz(p.p[k + 1]));
      g.stroke();
    }
  }
  // Vías del tren en superficie.
  for (const r of roads.rails) {
    g.strokeStyle = '#9d968a';
    g.lineWidth = 4.5 * scale;
    g.beginPath();
    g.moveTo(tx(r[0]), tz(r[1]));
    for (let k = 2; k < r.length; k += 2) g.lineTo(tx(r[k]), tz(r[k + 1]));
    g.stroke();
    g.strokeStyle = '#5b554c';
    g.lineWidth = Math.max(1, 1.5 * scale);
    g.stroke();
  }
  g.globalCompositeOperation = 'overlay';
  g.fillStyle = g.createPattern(nc, 'repeat')!;
  g.fillRect(0, 0, cw, ch);
  g.globalCompositeOperation = 'source-over';
  // Borde difuminado hacia el color exterior: sin él se ve el rectángulo del mapa desde lejos.
  const fade = EDGE_FADE * scale;
  const edge = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, OUTSIDE);
    grad.addColorStop(1, OUTSIDE + '00');
    g.fillStyle = grad;
    g.fillRect(rx, ry, rw, rh);
  };
  edge(0, 0, fade, 0, 0, 0, fade, ch);
  edge(cw, 0, cw - fade, 0, cw - fade, 0, fade, ch);
  edge(0, 0, 0, fade, 0, 0, cw, fade);
  edge(0, ch, 0, ch - fade, 0, ch - fade, cw, fade);

  // Trincheras de los pasos inferiores: el suelo se recorta (alfa 0) donde la calzada va por
  // debajo de la superficie; en los túneles se mantiene, porque es su cubierta.
  g.globalCompositeOperation = 'destination-out';
  g.strokeStyle = '#000';
  g.lineCap = 'butt';
  g.lineJoin = 'round';
  for (const sg of roads.segments) {
    if (!(sg.f & 16) || sg.f & 4) continue;
    g.lineWidth = (sg.w + 1.2) * scale;
    const P = sg.p;
    let open = false;
    for (let k = 0; k < P.length; k += 3) {
      const deep = terrain.heightAt(P[k], P[k + 2]) - P[k + 1] > 0.25;
      if (deep && !open) {
        g.beginPath();
        const b = Math.max(0, k - 3);
        g.moveTo(tx(P[b]), tz(P[b + 2]));
        open = true;
      }
      if (open) g.lineTo(tx(P[k]), tz(P[k + 2]));
      if (open && (!deep || k + 3 >= P.length)) {
        g.stroke();
        open = false;
      }
    }
  }
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 });
  const outsideMat = new THREE.MeshLambertMaterial({ color: OUTSIDE, side: THREE.DoubleSide });
  if (terrain.flat) {
    const geo = new THREE.PlaneGeometry(W, H);
    geo.rotateX(-Math.PI / 2);
    geo.translate(ext.minX + W / 2, 0, ext.minZ + H / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    group.add(mesh);
    const under = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000), outsideMat);
    under.rotation.x = -Math.PI / 2;
    under.position.y = -0.6;
    group.add(under);
    return group;
  }
  buildRelief(group, terrain, ext, mat, outsideMat);
  return group;
}

const CHUNK = 64; // celdas por bloque de la malla fina (frustum culling)
const COARSE = 4; // la periferia se malla cada 4 celdas

/**
 * Malla del relieve: fina (paso de la rejilla) sobre el área con textura, gruesa en la periferia
 * y un faldón horizontal hasta el horizonte. Las normales salen de diferencias centradas, así no
 * hay costuras de sombreado entre bloques.
 */
function buildRelief(group: THREE.Group, t: Terrain, ext: GroundExtent, mat: THREE.Material, outsideMat: THREE.Material) {
  const { nx, nz, step, x0, z0, h } = t;
  const W = ext.maxX - ext.minX;
  const H = ext.maxZ - ext.minZ;
  const hAt = (i: number, j: number) => h[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const lastI = nx - 1;
  const lastJ = nz - 1;
  const coarseIdx = (n: number) => {
    const a: number[] = [];
    for (let k = 0; k < n - 1; k += COARSE) a.push(k);
    a.push(n - 1);
    return a;
  };
  const CI = coarseIdx(nx);
  const CJ = coarseIdx(nz);
  const snapDown = (v: number) => Math.max(0, Math.floor(v / COARSE) * COARSE);
  const snapUp = (v: number, last: number) => Math.min(last, Math.ceil(v / COARSE) * COARSE);
  const iA = snapDown((ext.minX - x0) / step);
  const iB = snapUp((ext.maxX - x0) / step, lastI);
  const jA = snapDown((ext.minZ - z0) / step);
  const jB = snapUp((ext.maxZ - z0) / step, lastJ);

  const pushVertex = (pos: number[], nrm: number[], uv: number[], i: number, j: number, d: number, y = hAt(i, j)) => {
    const x = x0 + i * step;
    const z = z0 + j * step;
    pos.push(x, y, z);
    const gx = (hAt(i + d, j) - hAt(i - d, j)) / (2 * d * step);
    const gz = (hAt(i, j + d) - hAt(i, j - d)) / (2 * d * step);
    const l = Math.hypot(gx, 1, gz);
    nrm.push(-gx / l, 1 / l, -gz / l);
    uv.push((x - ext.minX) / W, 1 - (z - ext.minZ) / H);
  };
  const finish = (pos: number[], nrm: number[], uv: number[], idx: number[], m: THREE.Material, name: string) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, m);
    mesh.receiveShadow = true;
    mesh.name = name;
    group.add(mesh);
  };

  // Zona fina, por bloques.
  for (let ci = iA; ci < iB; ci += CHUNK) {
    for (let cj = jA; cj < jB; cj += CHUNK) {
      const i1 = Math.min(iB, ci + CHUNK);
      const j1 = Math.min(jB, cj + CHUNK);
      const w = i1 - ci + 1;
      const pos: number[] = [];
      const nrm: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (let j = cj; j <= j1; j++) for (let i = ci; i <= i1; i++) pushVertex(pos, nrm, uv, i, j, 1);
      for (let j = 0; j < j1 - cj; j++) {
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i;
          idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
        }
      }
      // Faldón vertical en el contorno de la zona fina: tapa las rendijas con la malla gruesa.
      const edge = (pts: [number, number][]) => {
        for (let k = 1; k < pts.length; k++) {
          const b = pos.length / 3;
          for (const [i, j] of [pts[k - 1], pts[k]]) {
            pushVertex(pos, nrm, uv, i, j, 1);
            pushVertex(pos, nrm, uv, i, j, 1, hAt(i, j) - 3);
          }
          idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3, b, b + 2, b + 1, b + 2, b + 3, b + 1);
        }
      };
      const run = (fixed: number, from: number, to: number, horiz: boolean) => {
        const pts: [number, number][] = [];
        for (let k = from; k <= to; k++) pts.push(horiz ? [k, fixed] : [fixed, k]);
        edge(pts);
      };
      if (cj === jA) run(jA, ci, i1, true);
      if (j1 === jB) run(jB, ci, i1, true);
      if (ci === iA) run(iA, cj, j1, false);
      if (i1 === iB) run(iB, cj, j1, false);
      finish(pos, nrm, uv, idx, mat, 'ground');
    }
  }

  // Periferia gruesa (sin las celdas de la zona fina).
  {
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const w = CI.length;
    for (const j of CJ) for (const i of CI) pushVertex(pos, nrm, uv, i, j, COARSE);
    for (let b = 0; b < CJ.length - 1; b++) {
      for (let a = 0; a < w - 1; a++) {
        if (CI[a] >= iA && CI[a + 1] <= iB && CJ[b] >= jA && CJ[b + 1] <= jB) continue;
        const k = b * w + a;
        idx.push(k, k + w, k + 1, k + 1, k + w, k + w + 1);
      }
    }
    finish(pos, nrm, uv, idx, mat, 'ground-outer');
  }

  // Faldón hasta el horizonte: el contorno de la rejilla ampliado radialmente a su misma cota.
  {
    const ring: [number, number][] = [];
    for (const i of CI) ring.push([i, 0]);
    for (const j of CJ.slice(1)) ring.push([lastI, j]);
    for (const i of CI.slice(0, -1).reverse()) ring.push([i, lastJ]);
    for (const j of CJ.slice(1, -1).reverse()) ring.push([0, j]);
    const cx = x0 + (lastI * step) / 2;
    const cz = z0 + (lastJ * step) / 2;
    const pos: number[] = [];
    const idx: number[] = [];
    for (const [i, j] of ring) {
      const x = x0 + i * step;
      const z = z0 + j * step;
      const y = hAt(i, j);
      pos.push(x, y, z, cx + (x - cx) * 16, y, cz + (z - cz) * 16);
    }
    const n = ring.length;
    for (let k = 0; k < n; k++) {
      const a = 2 * k;
      const b = 2 * ((k + 1) % n);
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Normales hacia arriba: el faldón es horizontal salvo por el desnivel del contorno.
    const nr = geo.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < nr.count; k++) nr.setXYZ(k, 0, 1, 0);
    const mesh = new THREE.Mesh(geo, outsideMat);
    mesh.receiveShadow = true;
    mesh.name = 'outside';
    group.add(mesh);
  }
}
