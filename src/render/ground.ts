// Terreno: usos del suelo, cauce del Vinalopó, plazas y vías del tren pintados en una
// textura (sin solapes ni z-fighting) sobre un plano que recibe sombras.
import * as THREE from 'three';
import type { AreasJSON, RoadsJSON } from './data';

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

export function buildGround(areas: AreasJSON, roads: RoadsJSON, ext: GroundExtent, maxTex: number): THREE.Group {
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

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;

  const geo = new THREE.PlaneGeometry(W, H);
  geo.rotateX(-Math.PI / 2);
  geo.translate(ext.minX + W / 2, 0, ext.minZ + H / 2);
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  group.add(mesh);

  // Entorno más allá del área de estudio (camp d'Elx), con un hueco donde va el mapa para que
  // ambos planos no se solapen (desde lejos se pelearían en el búfer de profundidad).
  const R = 100000;
  const inset = 2;
  const outer = new THREE.Shape([
    new THREE.Vector2(-R, -R),
    new THREE.Vector2(R, -R),
    new THREE.Vector2(R, R),
    new THREE.Vector2(-R, R),
  ]);
  // La forma se dibuja en XY y se gira: y de la forma = −z del mundo.
  outer.holes.push(
    new THREE.Path([
      new THREE.Vector2(ext.minX + inset, -(ext.maxZ - inset)),
      new THREE.Vector2(ext.minX + inset, -(ext.minZ + inset)),
      new THREE.Vector2(ext.maxX - inset, -(ext.minZ + inset)),
      new THREE.Vector2(ext.maxX - inset, -(ext.maxZ - inset)),
    ]),
  );
  const underGeo = new THREE.ShapeGeometry(outer);
  underGeo.rotateX(-Math.PI / 2);
  const under = new THREE.Mesh(underGeo, new THREE.MeshLambertMaterial({ color: OUTSIDE }));
  under.position.y = -0.05;
  under.receiveShadow = true;
  under.name = 'outside';
  group.add(under);
  return group;
}
