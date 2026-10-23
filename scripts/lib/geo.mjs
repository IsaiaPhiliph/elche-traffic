// Utilidades geométricas para el preprocesado (coordenadas locales en metros).
// Convenio: x = este, z = sur (el norte queda hacia -z, como en Three.js visto desde arriba).

export function makeProjector(origin) {
  const phi = (origin.lat * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
  return (lat, lon) => [(lon - origin.lon) * mLon, -(lat - origin.lat) * mLat];
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

// Punto a distancia d desde el inicio de la polilínea.
export function pointAt(pts, d) {
  if (d <= 0) return pts[0].slice();
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (acc + l >= d) {
      const t = l > 0 ? (d - acc) / l : 0;
      return pts[i - 1].map((v, k) => v + (pts[i][k] - v) * t);
    }
    acc += l;
  }
  return pts[pts.length - 1].slice();
}

// Recorta la polilínea entre las distancias d0 y d1 (desde el inicio).
export function slicePolyline(pts, d0, d1) {
  const out = [pointAt(pts, d0)];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (acc > d0 + 1e-6 && acc < d1 - 1e-6) out.push(pts[i].slice());
  }
  out.push(pointAt(pts, d1));
  return out;
}

// Dirección unitaria media en los primeros `span` metros de la polilínea.
export function startDirection(pts, span = 6) {
  const p = pointAt(pts, Math.min(span, polylineLength(pts)));
  const dx = p[0] - pts[0][0];
  const dz = p[1] - pts[0][1];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

export function reversed(pts) {
  return pts.slice().reverse();
}

// Douglas-Peucker sobre un anillo o polilínea 2D.
export function simplify(pts, tol) {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegDist(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function pointSegDist(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

export function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function centroid(ring) {
  let cx = 0;
  let cz = 0;
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cz += (p[1] + q[1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    const m = ring.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
    return [m[0] / ring.length, m[1] / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// Intersección propia entre los segmentos ab y cd.
export function segmentsIntersect(a, b, c, d) {
  const d1 = cross3(c, d, a);
  const d2 = cross3(c, d, b);
  const d3 = cross3(a, b, c);
  const d4 = cross3(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

const cross3 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export function polylinesIntersect(p, q) {
  for (let i = 1; i < p.length; i++) {
    for (let j = 1; j < q.length; j++) {
      if (segmentsIntersect(p[i - 1], p[i], q[j - 1], q[j])) return true;
    }
  }
  return false;
}

export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross3(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross3(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// Índice espacial de rejilla sencillo para elementos con caja envolvente.
export class Grid {
  constructor(cell = 50) {
    this.cell = cell;
    this.map = new Map();
  }
  key(i, j) {
    return i * 100003 + j;
  }
  insert(item, minX, minZ, maxX, maxZ) {
    const c = this.cell;
    for (let i = Math.floor(minX / c); i <= Math.floor(maxX / c); i++) {
      for (let j = Math.floor(minZ / c); j <= Math.floor(maxZ / c); j++) {
        const k = this.key(i, j);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(item);
      }
    }
  }
  query(minX, minZ, maxX, maxZ) {
    const c = this.cell;
    const out = new Set();
    for (let i = Math.floor(minX / c); i <= Math.floor(maxX / c); i++) {
      for (let j = Math.floor(minZ / c); j <= Math.floor(maxZ / c); j++) {
        const arr = this.map.get(this.key(i, j));
        if (arr) for (const it of arr) out.add(it);
      }
    }
    return out;
  }
}

export function bboxOf(pts) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return [minX, minZ, maxX, maxZ];
}

// Generador pseudoaleatorio determinista (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round2 = (v) => Math.round(v * 100) / 100;
export const round1 = (v) => Math.round(v * 10) / 10;
