// Usos del suelo, agua, parques y el Palmeral (huertos de palmeras).
import * as G from './geo.mjs';
import { elementPolygons, cleanRing, packPolygon } from './polygons.mjs';
import { BUILDING_CLASS } from './buildings.mjs';

export const AREA_TYPES = [
  'residential', 'commercial', 'industrial', 'farmland', 'construction', 'railway', 'cemetery',
  'grass', 'park', 'palmeral', 'forest', 'sand', 'pitch', 'parking', 'square', 'water',
];

function areaType(t) {
  const lu = t.landuse;
  const le = t.leisure;
  const na = t.natural;
  const name = t.name ?? '';
  if (na === 'water' || t.waterway === 'riverbank' || lu === 'reservoir' || lu === 'basin') return 'water';
  if (lu === 'orchard' || /\b(hort|huerto|palmer)/i.test(name) || /palm/i.test(t.trees ?? '') || t.produce === 'dates') return 'palmeral';
  if (le === 'park' || le === 'garden') return 'park';
  if (['pitch', 'stadium', 'track', 'sports_centre', 'playground'].includes(le)) return 'pitch';
  if (['grass', 'village_green', 'recreation_ground', 'meadow'].includes(lu) || na === 'grassland' || na === 'heath') return 'grass';
  if (lu === 'forest' || na === 'wood' || na === 'scrub') return 'forest';
  if (['farmland', 'farmyard', 'allotments', 'greenhouse_horticulture', 'plant_nursery', 'vineyard', 'greenfield', 'meadow'].includes(lu)) return 'farmland';
  if (lu === 'residential') return 'residential';
  if (lu === 'commercial' || lu === 'retail') return 'commercial';
  if (lu === 'industrial') return 'industrial';
  if (lu === 'railway') return 'railway';
  if (lu === 'construction' || lu === 'brownfield') return 'construction';
  if (lu === 'cemetery' || t.amenity === 'grave_yard') return 'cemetery';
  if (t.amenity === 'parking') return 'parking';
  if (t.place === 'square' || t['area:highway']) return 'square';
  if (na === 'sand') return 'sand';
  return null;
}

export function processAreas(json, project) {
  const polys = [];
  const rivers = [];
  for (const el of json.elements) {
    const t = el.tags ?? {};
    if (el.type === 'way' && ['river', 'canal', 'stream'].includes(t.waterway)) {
      const pts = (el.geometry ?? []).map((p) => project(p.lat, p.lon));
      if (pts.length >= 2) rivers.push({ pts, width: t.waterway === 'river' ? 22 : t.waterway === 'canal' ? 6 : 3, name: t.name ?? '' });
      continue;
    }
    const type = areaType(t);
    if (!type) continue;
    for (const p of elementPolygons(el, project)) {
      const outer = cleanRing(p.outer, 0.6, true);
      if (!outer) continue;
      const holes = p.holes.map((r) => cleanRing(r, 0.6, false)).filter(Boolean);
      polys.push({ type, outer, holes, area: Math.abs(G.signedArea(outer)), name: t.name ?? '', leisure: t.leisure });
    }
  }
  // Orden de dibujo: primero los usos genéricos y grandes, encima los de detalle.
  polys.sort((a, b) => AREA_TYPES.indexOf(a.type) - AREA_TYPES.indexOf(b.type) || b.area - a.area);
  const data = [];
  for (const p of polys) {
    data.push(AREA_TYPES.indexOf(p.type));
    packPolygon(p.outer, p.holes, data);
  }
  const riverData = rivers.map((r) => ({ w: r.width, n: r.name, p: r.pts.flatMap((q) => [G.round1(q[0]), G.round1(q[1])]) }));

  // Consulta de uso del suelo para clasificar edificios genéricos.
  const grid = new G.Grid(150);
  const landuse = polys.filter((p) => ['residential', 'commercial', 'industrial'].includes(p.type));
  landuse.forEach((p, i) => {
    const [a, b, c, d] = G.bboxOf(p.outer);
    grid.insert(i, a, b, c, d);
  });
  const lookup = (pt) => {
    for (const i of grid.query(pt[0], pt[1], pt[0], pt[1])) {
      const p = landuse[i];
      if (G.pointInRing(pt, p.outer)) {
        if (p.type === 'commercial') return BUILDING_CLASS.COMMERCIAL;
        if (p.type === 'industrial') return BUILDING_CLASS.INDUSTRIAL;
        return BUILDING_CLASS.RESIDENTIAL;
      }
    }
    return null;
  };
  return { json: { types: AREA_TYPES, data, rivers: riverData }, polys, lookup };
}

// Palmeras y árboles: los de OSM más los generados en huertos y parques.
export function generateTrees(treesJson, areaPolys, project, insideBuilding, onRoad) {
  const rand = G.rng(7);
  const out = [];
  const PALM_RE = /phoenix|washingtonia|palm|palmera|datilera|chamaerops|syagrus|trachycarpus/i;
  const PINE_RE = /pinus|pino|pi\b|cupressus|xiprer|ciprés/i;
  for (const el of treesJson.elements) {
    if (el.type !== 'node') continue;
    const t = el.tags ?? {};
    const sp = `${t.species ?? ''} ${t.genus ?? ''} ${t.taxon ?? ''} ${t['species:es'] ?? ''} ${t['name'] ?? ''}`;
    const kind = PALM_RE.test(sp) ? 0 : PINE_RE.test(sp) ? 2 : t.leaf_type === 'needleleaved' ? 2 : sp.trim() ? 1 : rand() < 0.4 ? 0 : 1;
    const [x, z] = project(el.lat, el.lon);
    out.push([x, z, kind, 0.8 + rand() * 0.5]);
  }
  for (const p of areaPolys) {
    let spacing;
    let palmShare;
    let keep;
    if (p.type === 'palmeral') [spacing, palmShare, keep] = [7.5, 0.97, 0.78];
    else if (p.type === 'park') [spacing, palmShare, keep] = [11, 0.55, 0.55];
    else if (p.type === 'forest') [spacing, palmShare, keep] = [9, 0.1, 0.6];
    else if (p.type === 'grass' && p.area < 40000) [spacing, palmShare, keep] = [14, 0.5, 0.35];
    else continue;
    const [minX, minZ, maxX, maxZ] = G.bboxOf(p.outer);
    for (let x = minX + spacing / 2; x < maxX; x += spacing) {
      for (let z = minZ + spacing / 2; z < maxZ; z += spacing) {
        if (rand() > keep) continue;
        const q = [x + (rand() - 0.5) * spacing * 0.7, z + (rand() - 0.5) * spacing * 0.7];
        if (!G.pointInRing(q, p.outer) || p.holes.some((h) => G.pointInRing(q, h))) continue;
        if (insideBuilding(q) || onRoad(q)) continue;
        const kind = rand() < palmShare ? 0 : p.type === 'forest' && rand() < 0.6 ? 2 : 1;
        out.push([q[0], q[1], kind, 0.75 + rand() * 0.55]);
      }
    }
  }
  const data = [];
  for (const [x, z, k, s] of out) data.push(Math.round(x * 10), Math.round(z * 10), k, Math.round(s * 100));
  return { count: out.length, data };
}
