// Edificios: alturas a partir de building:levels / height (Catastro) y clase de uso.
import { BBOX } from '../config.mjs';
import * as G from './geo.mjs';
import { elementPolygons, cleanRing, packPolygon } from './polygons.mjs';

export const BUILDING_CLASS = { RESIDENTIAL: 0, COMMERCIAL: 1, INDUSTRIAL: 2, PUBLIC: 3, HISTORIC: 4, OTHER: 5 };

// Paletas cálidas propias del casco urbano ilicitano (blancos, cremas, ocres).
export const PALETTE = [
  // residencial 0-9
  '#efe7da', '#e8dcc6', '#e2d2b6', '#f2ece2', '#d9c6a5', '#e6d5bb', '#ddd0bd', '#ece0cc', '#d4bf9c', '#e9e2d6',
  // comercial / oficinas 10-13
  '#d8d8d2', '#cfd5d8', '#e0dbd0', '#c9cfd2',
  // industrial 14-17
  '#c8c4bb', '#bfc2c3', '#d2cdc1', '#b9b7af',
  // público 18-20
  '#e3d0ae', '#d9c7a4', '#eadcc4',
  // histórico (piedra arenisca) 21-22
  '#cdb084', '#c4a476',
];
const RANGES = [[0, 10], [10, 14], [14, 18], [18, 21], [21, 23], [0, 10]];

const RES = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'apartments', 'bungalow', 'dormitory']);
const COM = new Set(['commercial', 'retail', 'office', 'supermarket', 'hotel', 'kiosk']);
const IND = new Set(['industrial', 'warehouse', 'manufacture', 'factory', 'storage_tank', 'service', 'hangar']);
const PUB = new Set(['school', 'university', 'college', 'hospital', 'public', 'civic', 'government', 'sports_hall', 'stadium', 'train_station', 'transportation', 'kindergarten', 'fire_station']);
const HIS = new Set(['church', 'cathedral', 'chapel', 'basilica', 'castle', 'tower', 'monastery', 'mosque']);

function classify(t) {
  const b = t.building ?? t['building:part'] ?? 'yes';
  if (t.historic || HIS.has(b) || t.amenity === 'place_of_worship') return BUILDING_CLASS.HISTORIC;
  if (RES.has(b)) return BUILDING_CLASS.RESIDENTIAL;
  if (COM.has(b) || t.shop) return BUILDING_CLASS.COMMERCIAL;
  if (IND.has(b)) return BUILDING_CLASS.INDUSTRIAL;
  if (PUB.has(b) || t.amenity) return BUILDING_CLASS.PUBLIC;
  return BUILDING_CLASS.OTHER;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

function heights(t) {
  const b = t.building ?? t['building:part'] ?? 'yes';
  let h = num(t.height);
  let minH = num(t.min_height);
  const lv = num(t['building:levels']);
  const minLv = num(t['building:min_level']);
  if (!Number.isFinite(h) && Number.isFinite(lv)) h = lv * 3.1 + 0.7;
  if (!Number.isFinite(minH)) minH = Number.isFinite(minLv) ? minLv * 3.1 : 0;
  if (!Number.isFinite(h)) {
    if (['house', 'detached', 'semidetached_house', 'terrace', 'bungalow'].includes(b)) h = 7;
    else if (['residential', 'apartments'].includes(b)) h = 13;
    else if (['garage', 'garages', 'shed', 'carport', 'hut', 'kiosk'].includes(b)) h = 3;
    else if (['industrial', 'warehouse', 'manufacture', 'factory'].includes(b)) h = 8;
    else if (HIS.has(b)) h = 16;
    else if (b === 'roof') {
      h = 4;
      minH = 3.2;
    } else h = 9.5;
  }
  return [Math.min(h, 120), Math.min(minH, h - 0.5)];
}

export function processBuildings(json, project, landuseLookup) {
  const outlines = [];
  const parts = [];
  for (const el of json.elements) {
    const t = el.tags ?? {};
    if (t.building === 'no' || t['building:part'] === 'no') continue;
    const isPart = !!t['building:part'] && !t.building;
    const polys = elementPolygons(el, project);
    for (const p of polys) {
      const c = G.centroid(p.outer);
      if (!inLocalBox(c, project)) continue;
      const item = { el, t, poly: p, c, area: Math.abs(G.signedArea(p.outer)) };
      (isPart ? parts : outlines).push(item);
    }
  }
  // Un contorno con partes dentro se sustituye por sus partes (volúmenes del Catastro).
  const grid = new G.Grid(40);
  parts.forEach((p, i) => grid.insert(i, p.c[0], p.c[1], p.c[0], p.c[1]));
  const partParent = new Map();
  const final = [];
  for (const o of outlines) {
    const [a, b, c, d] = G.bboxOf(o.poly.outer);
    let hasParts = false;
    for (const i of grid.query(a, b, c, d)) {
      if (G.pointInRing(parts[i].c, o.poly.outer)) {
        hasParts = true;
        partParent.set(i, o);
      }
    }
    if (!hasParts) final.push(o);
  }
  parts.forEach((p, i) => {
    const parent = partParent.get(i);
    if (parent) p.parentTags = parent.t;
    final.push(p);
  });

  const data = [];
  const records = [];
  const rand = G.rng(20260);
  let count = 0;
  for (const b of final) {
    const tags = b.parentTags ? { ...b.parentTags, ...b.t, building: b.parentTags.building } : b.t;
    const [h, minH] = heights(b.t['building:levels'] || b.t.height ? b.t : tags);
    if (h < 1.5 || b.area < 4) continue;
    let cls = classify(tags);
    if (cls === BUILDING_CLASS.OTHER && landuseLookup) cls = landuseLookup(b.c) ?? BUILDING_CLASS.RESIDENTIAL;
    if (cls === BUILDING_CLASS.OTHER) cls = BUILDING_CLASS.RESIDENTIAL;
    const outer = cleanRing(b.poly.outer, 0.3, true);
    if (!outer) continue;
    const holes = b.poly.holes.map((r) => cleanRing(r, 0.3, false)).filter(Boolean);
    const [lo, hi] = RANGES[cls];
    const color = lo + Math.floor(rand() * (hi - lo));
    data.push(Math.round(h * 10), Math.round(minH * 10), color, cls);
    packPolygon(outer, holes, data);
    count++;
    const floors = Math.max(1, Math.round((h - minH) / 3.1));
    records.push({ c: b.c, floorArea: b.area * floors, cls, h, name: tags.name });
  }
  return { json: { palette: PALETTE, count, data }, records };
}

const USE_CLASS = {
  '1_residential': BUILDING_CLASS.RESIDENTIAL,
  '2_agriculture': BUILDING_CLASS.INDUSTRIAL,
  '3_industrial': BUILDING_CLASS.INDUSTRIAL,
  '4_1_office': BUILDING_CLASS.COMMERCIAL,
  '4_2_retail': BUILDING_CLASS.COMMERCIAL,
  '4_3_publicServices': BUILDING_CLASS.PUBLIC,
};

/**
 * Edificios del Catastro (partes con nº de plantas). Los monumentos cartografiados en OSM
 * (iglesias, edificios históricos) sustituyen a las partes catastrales que contienen.
 */
export function processCatastroBuildings(parts, uses, osmJson, project) {
  const landmarks = [];
  for (const el of osmJson?.elements ?? []) {
    const t = el.tags ?? {};
    if (!(t.historic || HIS.has(t.building) || t.amenity === 'place_of_worship' || t.tourism === 'attraction')) continue;
    for (const p of elementPolygons(el, project)) {
      const area = Math.abs(G.signedArea(p.outer));
      if (area < 40) continue;
      landmarks.push({ t, poly: p, bbox: G.bboxOf(p.outer), area });
    }
  }
  const lmGrid = new G.Grid(60);
  landmarks.forEach((l, i) => lmGrid.insert(i, ...l.bbox));
  const findLandmark = (c) => {
    for (const i of lmGrid.query(c[0], c[1], c[0], c[1])) if (G.pointInRing(c, landmarks[i].poly.outer)) return i;
    return -1;
  };

  const data = [];
  const records = [];
  const rand = G.rng(4242);
  let count = 0;
  const lmMaxH = new Map();
  const emit = (outerRaw, holesRaw, h, cls, name) => {
    const outer = cleanRing(outerRaw, 0.25, true);
    if (!outer) return;
    const area = Math.abs(G.signedArea(outer));
    if (area < 3) return;
    const holes = holesRaw.map((r) => cleanRing(r, 0.25, false)).filter(Boolean);
    const [lo, hi] = RANGES[cls];
    data.push(Math.round(h * 10), 0, lo + Math.floor(rand() * (hi - lo)), cls);
    packPolygon(outer, holes, data);
    count++;
    records.push({ c: G.centroid(outer), floorArea: area * Math.max(1, Math.round(h / 3.1)), cls, h, name });
  };
  for (const part of parts) {
    const use = uses.get(part.ref);
    const cls = USE_CLASS[use] ?? BUILDING_CLASS.RESIDENTIAL;
    // Planta baja más alta (locales) y 3,05 m por planta; antepecho de cubierta.
    const h = 3.4 + (part.floors - 1) * 3.05 + 0.5;
    for (const p of part.polys) {
      const c = G.centroid(p.outer);
      const lm = findLandmark(c);
      if (lm >= 0) {
        lmMaxH.set(lm, Math.max(lmMaxH.get(lm) ?? 0, h));
        continue;
      }
      emit(p.outer, p.holes, h, cls);
    }
  }
  landmarks.forEach((l, i) => {
    if (!lmMaxH.has(i)) return;
    const t = l.t;
    let h = parseFloat(t.height);
    if (!Number.isFinite(h)) h = Number.isFinite(parseFloat(t['building:levels'])) ? parseFloat(t['building:levels']) * 3.3 + 1 : NaN;
    const worship = HIS.has(t.building) || t.amenity === 'place_of_worship';
    if (!Number.isFinite(h)) h = Math.max(lmMaxH.get(i), /Bas[ií]lica/i.test(t.name ?? '') ? 22 : worship ? 17 : 10);
    emit(l.poly.outer, l.poly.holes, h, BUILDING_CLASS.HISTORIC, t.name);
  });
  return { json: { palette: PALETTE, count, data, source: '© Dirección General del Catastro (INSPIRE)' }, records };
}

let cachedBox = null;
function inLocalBox(c, project) {
  if (!cachedBox) {
    const a = project(BBOX.south, BBOX.west);
    const b = project(BBOX.north, BBOX.east);
    cachedBox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }
  return c[0] >= cachedBox[0] && c[0] <= cachedBox[2] && c[1] >= cachedBox[1] && c[1] <= cachedBox[3];
}
