// Lectura de los edificios INSPIRE de la Dirección General del Catastro (GML, EPSG:25830).
// Cada BuildingPart trae su huella y el número de plantas sobre rasante; el uso
// (residencial, industrial, oficinas, comercio, servicios públicos) viene del Building.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// UTM (huso 30, ETRS89/GRS80) → latitud/longitud (Snyder, 1987).
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const LON0 = (-3 * Math.PI) / 180;
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
const MU_DEN = A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256);

export function utmToLatLon(E, N) {
  const x = E - 500000;
  const mu = N / K0 / MU_DEN;
  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 * E1) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1);
  const c = Math.cos(phi1);
  const t = Math.tan(phi1);
  const C1 = EP2 * c * c;
  const T1 = t * t;
  const N1 = A / Math.sqrt(1 - E2 * s * s);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * s * s, 1.5);
  const D = x / (N1 * K0);
  const lat =
    phi1 -
    ((N1 * t) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon =
    LON0 +
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / c;
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

function lines(path) {
  return createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
}

/** Uso principal de cada edificio (por referencia catastral). */
export async function readBuildingUses(path) {
  const uses = new Map();
  let id = null;
  for await (const line of lines(path)) {
    const m = line.match(/<bu-ext2d:Building gml:id="ES\.SDGC\.BU\.([^"]+)"/);
    if (m) {
      id = m[1];
      continue;
    }
    if (id) {
      const u = line.match(/<bu-ext2d:currentUse>([^<]+)</);
      if (u) {
        uses.set(id, u[1]);
        id = null;
      }
    }
  }
  return uses;
}

/**
 * Partes de edificio dentro del área: [{ref, floors, polys: [{outer, holes}]}]
 * `toLocal(lat, lon)` proyecta a metros locales y `inside(p)` filtra por el área.
 */
export async function readBuildingParts(path, toLocal, inside) {
  const parts = [];
  let cur = null;
  let poly = null;
  let ringKind = null;
  for await (const line of lines(path)) {
    if (!cur) {
      const m = line.match(/<bu-ext2d:BuildingPart gml:id="ES\.SDGC\.BU\.([^"]+)"/);
      if (m) cur = { ref: m[1].replace(/_part\d+$/, ''), floors: 0, below: 0, polys: [], skip: false };
      continue;
    }
    if (line.includes('<gml:PolygonPatch')) {
      poly = { outer: null, holes: [] };
      cur.polys.push(poly);
    } else if (line.includes('<gml:exterior')) ringKind = 'outer';
    else if (line.includes('<gml:interior')) ringKind = 'hole';
    else if (line.includes('<gml:posList')) {
      if (cur.skip || !poly) continue;
      const body = line.slice(line.indexOf('>') + 1, line.lastIndexOf('</'));
      const nums = body.trim().split(/\s+/).map(Number);
      // Descarta pronto lo que cae fuera del área (primer vértice).
      if (ringKind === 'outer' && cur.polys.length === 1) {
        const [la, lo] = utmToLatLon(nums[0], nums[1]);
        if (!inside(toLocal(la, lo))) {
          cur.skip = true;
          continue;
        }
      }
      const ring = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const [la, lo] = utmToLatLon(nums[i], nums[i + 1]);
        ring.push(toLocal(la, lo));
      }
      if (ring.length > 1) ring.pop(); // el último repite el primero
      if (ringKind === 'outer') poly.outer = ring;
      else poly.holes.push(ring);
    } else {
      const f = line.match(/<bu-ext2d:numberOfFloorsAboveGround>(\d+)</);
      if (f) cur.floors = +f[1];
      const b = line.match(/<bu-ext2d:numberOfFloorsBelowGround>(\d+)</);
      if (b) cur.below = +b[1];
      if (line.includes('</bu-ext2d:BuildingPart>')) {
        if (!cur.skip && cur.floors > 0) {
          cur.polys = cur.polys.filter((p) => p.outer && p.outer.length >= 3);
          if (cur.polys.length) parts.push(cur);
        }
        cur = null;
        poly = null;
      }
    }
  }
  return parts;
}
