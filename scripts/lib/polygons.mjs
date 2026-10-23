// Ensamblado de anillos de polígonos OSM (vías cerradas y multipolígonos).
import * as G from './geo.mjs';

const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;

// Une tramos abiertos en anillos cerrados. Devuelve anillos sin el punto repetido.
export function assembleRings(lines) {
  const rings = [];
  const pool = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  while (pool.length) {
    let ring = pool.pop();
    let guard = 0;
    while (!same(ring[0], ring[ring.length - 1]) && guard++ < 2000) {
      const end = ring[ring.length - 1];
      const k = pool.findIndex((w) => same(w[0], end) || same(w[w.length - 1], end));
      if (k < 0) break;
      let w = pool.splice(k, 1)[0];
      if (!same(w[0], end)) w = w.reverse();
      ring = ring.concat(w.slice(1));
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring.slice(0, -1));
  }
  return rings;
}

// Convierte un elemento OSM con geometría (out geom) en polígonos [{outer, holes}].
export function elementPolygons(el, project) {
  const proj = (g) => g.map((p) => project(p.lat, p.lon));
  if (el.type === 'way') {
    if (!el.geometry || el.geometry.length < 4) return [];
    const pts = proj(el.geometry);
    if (!same(pts[0], pts[pts.length - 1])) return [];
    return [{ outer: pts.slice(0, -1), holes: [] }];
  }
  if (el.type === 'relation') {
    const outerLines = [];
    const innerLines = [];
    for (const m of el.members ?? []) {
      if (m.type !== 'way' || !m.geometry) continue;
      const pts = proj(m.geometry.filter(Boolean));
      if (m.role === 'inner') innerLines.push(pts);
      else outerLines.push(pts);
    }
    const outers = assembleRings(outerLines);
    const inners = assembleRings(innerLines);
    const polys = outers.map((outer) => ({ outer, holes: [] }));
    for (const h of inners) {
      const host = polys.find((p) => G.pointInRing(h[0], p.outer));
      if (host) host.holes.push(h);
    }
    return polys;
  }
  return [];
}

// Simplifica un anillo y lo orienta: exterior antihorario (en x-z), huecos horarios.
export function cleanRing(ring, tol, outer) {
  if (ring.length < 3) return null;
  const closed = ring.concat([ring[0]]);
  let s = G.simplify(closed, tol);
  s = s.slice(0, -1);
  if (s.length < 3) return null;
  const a = G.signedArea(s);
  if (Math.abs(a) < 0.5) return null;
  if ((a > 0) !== outer) s.reverse();
  return s;
}

// Empaqueta un polígono en un array plano de enteros (decímetros).
export function packPolygon(outer, holes, out) {
  const rings = [outer, ...holes];
  out.push(rings.length);
  for (const r of rings) out.push(r.length);
  for (const r of rings) for (const p of r) out.push(Math.round(p[0] * 10), Math.round(p[1] * 10));
}
