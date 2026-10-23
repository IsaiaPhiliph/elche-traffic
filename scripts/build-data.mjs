// Procesa los datos OSM descargados y genera los ficheros que usa el simulador.
// Uso: node scripts/build-data.mjs <carpeta-raw> <carpeta-salida>
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BBOX, ORIGIN, ZBE_POLYGON, GATEWAY_IMD, GATEWAY_DEFAULT_BY_CLASS, BUS_HEADWAY_MIN } from './config.mjs';
import * as G from './lib/geo.mjs';
import { buildNetwork, CLASSES, EDGE_FLAGS } from './lib/network.mjs';
import { processBuildings, processCatastroBuildings, BUILDING_CLASS } from './lib/buildings.mjs';
import { readBuildingParts, readBuildingUses } from './lib/catastro.mjs';
import { processAreas, generateTrees } from './lib/areas.mjs';

const [rawDir = 'data/raw', outDir = 'public/data'] = process.argv.slice(2);
const load = async (n) => JSON.parse(await readFile(join(rawDir, `${n}.json`), 'utf8'));
const has = async (n) => stat(join(rawDir, `${n}.json`)).then(() => true, () => false);
const project = G.makeProjector(ORIGIN);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------------------------------------------------------------- red viaria
const roadsRaw = await load('roads');
const net = buildNetwork(roadsRaw, await load('restrictions'), project);
log('red', net.stats);
const E = net.edges;
const edgeIndex = new Map(E.map((e, i) => [e, i]));

// ---------------------------------------------------------------- usos del suelo y edificios
const areas = processAreas(await load('areas'), project);
log('áreas', areas.polys.length);
// Preferimos el Catastro (cobertura completa y nº de plantas); si no está, OSM.
const catDir = join(rawDir, 'catastro');
const catParts = join(catDir, 'A.ES.SDGC.BU.03065.buildingpart.gml');
const catBuild = join(catDir, 'A.ES.SDGC.BU.03065.building.gml');
let buildings;
if (await stat(catParts).then(() => true, () => false)) {
  const a = project(BBOX.south, BBOX.west);
  const b = project(BBOX.north, BBOX.east);
  const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const inside = (p) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];
  const uses = await readBuildingUses(catBuild);
  log('catastro: usos', uses.size);
  const parts = await readBuildingParts(catParts, project, inside);
  log('catastro: partes en el área', parts.length);
  buildings = processCatastroBuildings(parts, uses, (await has('buildings')) ? await load('buildings') : null, project);
} else if (await has('buildings')) {
  buildings = processBuildings(await load('buildings'), project, areas.lookup);
} else {
  buildings = { json: { palette: [], count: 0, data: [] }, records: [] };
}
log('edificios', buildings.json.count);

// ---------------------------------------------------------------- generación y atracción de viajes
const segGrid = new G.Grid(60);
const accessible = (s) => {
  const c = CLASSES.indexOf(s.cls);
  if ([0, 1, 3, 5, 7, 9].includes(c) || s.roundabout || s.bridge || s.tunnel) return false;
  const ok = (id) => id >= 0 && E[id].core;
  return ok(s.eF) || ok(s.eB);
};
net.segs.forEach((s, i) => {
  if (!accessible(s)) return;
  const [a, b, c, d] = G.bboxOf(s.pts);
  segGrid.insert(i, a, b, c, d);
});
function nearestSeg(p) {
  for (const r of [60, 160]) {
    let best = -1;
    let bd = r;
    for (const i of segGrid.query(p[0] - r, p[1] - r, p[0] + r, p[1] + r)) {
      const s = net.segs[i];
      for (let k = 1; k < s.pts.length; k++) {
        const d = G.pointSegDist(p, s.pts[k - 1], s.pts[k]);
        if (d < bd) [bd, best] = [d, i];
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}
const prod = new Float64Array(E.length);
const attr = new Float64Array(E.length);
const addWeight = (segIdx, p, a) => {
  const s = net.segs[segIdx];
  const ids = [s.eF, s.eB].filter((id) => id >= 0 && E[id].core);
  for (const id of ids) {
    prod[id] += p / ids.length;
    attr[id] += a / ids.length;
  }
};
const W = {
  [BUILDING_CLASS.RESIDENTIAL]: [1.0, 0.25],
  [BUILDING_CLASS.COMMERCIAL]: [0.2, 1.6],
  [BUILDING_CLASS.INDUSTRIAL]: [0.1, 0.9],
  [BUILDING_CLASS.PUBLIC]: [0.1, 1.4],
  [BUILDING_CLASS.HISTORIC]: [0.05, 0.6],
  [BUILDING_CLASS.OTHER]: [0.6, 0.4],
};
for (const b of buildings.records) {
  const si = nearestSeg(b.c);
  if (si < 0) continue;
  const [wp, wa] = W[b.cls];
  addWeight(si, b.floorArea * wp, b.floorArea * wa);
}

// Puntos de interés (etiquetas, presets de cámara y polos de atracción).
const poisRaw = (await has('pois')) ? await load('pois') : { elements: [] };
const LANDMARKS = [
  [/Bas[ií]lica.*Santa Mar[ií]a/i, 'Basílica de Santa María', 10],
  [/Palau d'Altamira|Palacio de Altamira/i, "Palau d'Altamira", 9],
  [/Calaho/i, 'Torre de la Calahorra', 7],
  [/^Ajuntament|^Ayuntamiento/i, "Ajuntament d'Elx", 8],
  [/Hort del Cura|Huerto del Cura/i, 'Hort del Cura', 9],
  [/Parc Municipal|Parque Municipal/i, 'Parc Municipal', 8],
  [/Mart[ií]nez Valero/i, 'Estadi Martínez Valero', 9],
  [/Miguel Hern[aá]ndez/i, 'Universitat Miguel Hernández', 8],
  [/Hospital General/i, 'Hospital General Universitari', 8],
  [/Hospital.*Vinalop/i, 'Hospital del Vinalopó', 7],
  [/Elx.?Parc|Elche.?Parque/i, 'Estació Elx-Parc', 7],
  [/Carr[uú]s/i, 'Estació Elx-Carrús', 5],
  [/Mercat Central|Mercado Central/i, 'Mercat Central', 6],
  [/Aljub/i, "Centre Comercial L'Aljub", 8],
  [/MAHE|Museu Arqueol|Museo Arqueol/i, "MAHE · Museu Arqueològic", 6],
  [/Estaci[oó] d'Autobusos|Estaci[oó]n de Autobuses/i, "Estació d'Autobusos", 6],
  [/Gran Teatre|Gran Teatro/i, 'Gran Teatre', 5],
  [/Parc de Projectes/i, 'Parc de Projectes', 5],
];
const pois = [];
const seenLandmark = new Set();
for (const el of poisRaw.elements) {
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || !t.name) continue;
  const [x, z] = project(lat, lon);
  if (lat < BBOX.south || lat > BBOX.north || lon < BBOX.west || lon > BBOX.east) continue;
  const kind = t.amenity ?? t.tourism ?? t.leisure ?? t.shop ?? t.railway ?? (t.historic ? 'historic' : 'poi');
  let label = null;
  let importance = 1;
  for (const [re, nice, imp] of LANDMARKS) {
    if (re.test(t.name) && !seenLandmark.has(nice)) {
      label = nice;
      importance = imp;
      break;
    }
  }
  if (label) seenLandmark.add(label);
  pois.push({ name: label ?? t.name, kind, x: G.round1(x), z: G.round1(z), imp: importance });
  const boost = { hospital: 60000, university: 80000, college: 15000, mall: 80000, station: 12000, marketplace: 15000, townhall: 10000, school: 6000, bus_station: 8000 }[kind];
  if (boost) {
    const si = nearestSeg([x, z]);
    if (si >= 0) addWeight(si, boost * 0.1, boost);
  }
}
// Hitos que en OSM son polígonos (huertos del Palmeral, jardines): su centroide.
for (const p of areas.polys) {
  if (!p.name) continue;
  const lm = LANDMARKS.find(([re, nice]) => re.test(p.name) && !seenLandmark.has(nice));
  if (!lm) continue;
  seenLandmark.add(lm[1]);
  const c = G.centroid(p.outer);
  pois.push({ name: lm[1], kind: p.type, x: G.round1(c[0]), z: G.round1(c[1]), imp: lm[2] });
}
pois.sort((a, b) => b.imp - a.imp);
log('pois', pois.length, 'hitos', seenLandmark.size, [...seenLandmark].join(', '));

// ---------------------------------------------------------------- accesos (gateways)
const gwIn = new Float64Array(E.length);
const gwOut = new Float64Array(E.length);
const through = new Float64Array(E.length);
E.forEach((e, i) => {
  if (!e.gwIn && !e.gwOut) return;
  const label = `${e.ref} ${e.name}`;
  // Las reglas por carretera solo se aplican a la red principal (no a caminos homónimos).
  const major = e.cls <= 6 || /^(Carretera|Autov|Via Parc)/i.test(e.name) || /^(A|N|CV|EL)-\d/.test(e.ref);
  const rule = major ? GATEWAY_IMD.find((r) => r.match.test(label)) : null;
  const perDir = (rule ? rule.perDir : GATEWAY_DEFAULT_BY_CLASS[e.cls]) * Math.min(1, 0.6 + 0.4 * e.lanes);
  if (e.gwIn) gwIn[i] = perDir;
  if (e.gwOut) gwOut[i] = perDir;
  through[i] = e.cls === 0 ? 0.75 : e.cls === 2 ? 0.3 : 0.1;
});
// Un mismo acceso puede tener varios carriles/calzadas: reparte el IMD entre ellos.
const sumIn = gwIn.reduce((a, b) => a + b, 0);
const sumOut = gwOut.reduce((a, b) => a + b, 0);
log('accesos IMD entrada', Math.round(sumIn), 'salida', Math.round(sumOut));

// ---------------------------------------------------------------- ZBE y banderas
const zoneFlag = E.map((e) => {
  const m = G.pointAt(e.pts, e.len / 2);
  return G.pointInRing([m[0], m[1]], ZBE_POLYGON);
});

// ---------------------------------------------------------------- autobuses urbanos
const busLines = [];
if (await has('transit')) {
  const transit = await load('transit');
  const rawWays = new Map(roadsRaw.elements.filter((e) => e.type === 'way').map((w) => [w.id, w.nodes]));
  const stopNodes = new Map(transit.elements.filter((e) => e.type === 'node').map((n) => [n.id, n]));
  for (const el of roadsRaw.elements) if (el.type === 'node' && !stopNodes.has(el.id)) stopNodes.set(el.id, el);
  const pairEdge = new Map();
  for (const s of net.segs) {
    for (let k = 1; k < s.nodes.length; k++) {
      if (s.eF >= 0) pairEdge.set(`${s.nodes[k - 1]}>${s.nodes[k]}`, s.eF);
      if (s.eB >= 0) pairEdge.set(`${s.nodes[k]}>${s.nodes[k - 1]}`, s.eB);
    }
  }
  const movSet = new Set(net.movs.map((m) => `${m.from}>${m.to}`));
  for (const rel of transit.elements) {
    if (rel.type !== 'relation') continue;
    const t = rel.tags ?? {};
    const wayMembers = rel.members.filter((m) => m.type === 'way' && !/platform/.test(m.role));
    const seq = [];
    for (let i = 0; i < wayMembers.length; i++) {
      let nodes = rawWays.get(wayMembers[i].ref);
      if (!nodes) {
        seq.push(null);
        continue;
      }
      nodes = nodes.slice();
      const prev = seq.length ? seq[seq.length - 1] : null;
      if (prev != null) {
        if (nodes[nodes.length - 1] === prev) nodes.reverse();
        if (nodes[0] !== prev) seq.push(null);
      } else {
        const next = rawWays.get(wayMembers[i + 1]?.ref);
        if (next && (nodes[0] === next[0] || nodes[0] === next[next.length - 1])) nodes.reverse();
      }
      for (const n of nodes) if (seq[seq.length - 1] !== n) seq.push(n);
    }
    // Secuencia de tramos dirigidos; se corta donde no hay continuidad.
    const pieces = [[]];
    for (let k = 1; k < seq.length; k++) {
      const a = seq[k - 1];
      const b = seq[k];
      const e = a != null && b != null ? pairEdge.get(`${a}>${b}`) : undefined;
      const cur = pieces[pieces.length - 1];
      if (e === undefined) {
        if (cur.length) pieces.push([]);
        continue;
      }
      if (cur[cur.length - 1] === e) continue;
      if (cur.length && !movSet.has(`${cur[cur.length - 1]}>${e}`)) pieces.push([e]);
      else cur.push(e);
    }
    const best = pieces.reduce((a, b) => (b.reduce((s, e) => s + E[e].len, 0) > a.reduce((s, e) => s + E[e].len, 0) ? b : a), []);
    const len = best.reduce((s, e) => s + E[e].len, 0);
    if (len < 1500) continue;
    // Paradas proyectadas sobre el recorrido.
    const stops = [];
    let from = 0;
    for (const m of rel.members) {
      if (m.type !== 'node' || !/stop|platform/.test(m.role)) continue;
      const n = stopNodes.get(m.ref);
      if (!n) continue;
      const p = project(n.lat, n.lon);
      let bestD = 30;
      let hit = null;
      for (let k = from; k < Math.min(best.length, from + 60); k++) {
        const pts = E[best[k]].pts;
        let acc = 0;
        for (let q = 1; q < pts.length; q++) {
          const a = [pts[q - 1][0], pts[q - 1][1]];
          const b = [pts[q][0], pts[q][1]];
          const d = G.pointSegDist(p, a, b);
          const l = G.dist(a, b);
          if (d < bestD) {
            bestD = d;
            const tt = l > 0 ? ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (l * l) : 0;
            hit = [k, G.round1(acc + Math.max(0, Math.min(1, tt)) * l)];
          }
          acc += l;
        }
      }
      if (hit && (!stops.length || hit[0] > stops[stops.length - 1][0] || hit[1] > stops[stops.length - 1][1] + 20)) {
        stops.push(hit);
        from = hit[0];
      }
    }
    const ref = (t.ref ?? '').trim();
    // Solo líneas urbanas (A, B, K1, R2, NT...) con paradas reconocidas en el recorrido.
    if (!/^[A-Z]{1,2}\d?$/.test(ref) || stops.length < 5) continue;
    busLines.push({
      ref,
      name: t.name ?? `Línea ${ref}`,
      color: t.colour ?? null,
      headway: (BUS_HEADWAY_MIN[ref] ?? BUS_HEADWAY_MIN.default) * 60,
      edges: best,
      stops,
      len: Math.round(len),
    });
  }
  log('líneas de bus', busLines.length, busLines.map((b) => `${b.ref}(${(b.len / 1000).toFixed(1)}km,${b.stops.length}p)`).join(' '));
}

// ---------------------------------------------------------------- salida: red para la simulación
const names = [];
const nameIdx = new Map();
const nameOf = (n) => {
  if (!n) return -1;
  if (!nameIdx.has(n)) {
    nameIdx.set(n, names.length);
    names.push(n);
  }
  return nameIdx.get(n);
};
const ptsX = [];
const ptsY = [];
const ptsZ = [];
const edgesOut = {
  from: [], to: [], lanes: [], laneW: [], off0: [], speed: [], rank: [], cls: [], len: [],
  pt0: [], ptn: [], flags: [], yld: [], name: [], prod: [], attr: [], gwIn: [], gwOut: [], thr: [], seg: [],
};
E.forEach((e, i) => {
  edgesOut.from.push(e.from);
  edgesOut.to.push(e.to);
  edgesOut.lanes.push(e.lanes);
  edgesOut.laneW.push(G.round2(e.laneW));
  edgesOut.off0.push(G.round2(e.off0));
  edgesOut.speed.push(e.speed);
  edgesOut.rank.push(e.rank);
  edgesOut.cls.push(e.cls);
  edgesOut.len.push(G.round2(e.len));
  edgesOut.pt0.push(ptsX.length);
  edgesOut.ptn.push(e.pts.length);
  for (const p of e.pts) {
    ptsX.push(G.round2(p[0]));
    ptsZ.push(G.round2(p[1]));
    ptsY.push(G.round2(p[2]));
  }
  let f = 0;
  if (e.roundabout) f |= EDGE_FLAGS.ROUNDABOUT;
  if (e.bridge) f |= EDGE_FLAGS.BRIDGE;
  if (e.tunnel) f |= EDGE_FLAGS.TUNNEL;
  if (e.gwIn) f |= EDGE_FLAGS.GATEWAY_IN;
  if (e.gwOut) f |= EDGE_FLAGS.GATEWAY_OUT;
  if (e.core) f |= EDGE_FLAGS.CORE;
  if (zoneFlag[i]) f |= EDGE_FLAGS.ZONE;
  if ([1, 3, 5, 7, 9].includes(e.cls)) f |= EDGE_FLAGS.LINK;
  edgesOut.flags.push(f);
  edgesOut.yld.push(e.yieldType);
  edgesOut.name.push(nameOf(e.name));
  edgesOut.prod.push(Math.round(prod[i]));
  edgesOut.attr.push(Math.round(attr[i]));
  edgesOut.gwIn.push(Math.round(gwIn[i]));
  edgesOut.gwOut.push(Math.round(gwOut[i]));
  edgesOut.thr.push(Math.round(through[i] * 100));
  edgesOut.seg.push(e.seg);
});
const movsOut = { from: [], to: [], node: [], turn: [], cs: [], cl: [] };
net.movs.forEach((m, i) => {
  movsOut.from.push(m.from);
  movsOut.to.push(m.to);
  movsOut.node.push(m.node);
  movsOut.turn.push(m.turn);
  movsOut.cs.push(movsOut.cl.length);
  movsOut.cl.push(...net.conflicts[i]);
});
movsOut.cs.push(movsOut.cl.length);
const signals = net.controllers.map((c) => ({ heads: c.heads, groups: c.groups, x: G.round1(c.x), z: G.round1(c.z) }));

const network = {
  version: 1,
  meta: {
    generated: new Date().toISOString(),
    source: '© OpenStreetMap contributors (ODbL)',
    origin: ORIGIN,
    bbox: BBOX,
    stats: net.stats,
  },
  nodes: {
    x: net.nodes.map((g) => G.round2(g.p[0])),
    z: net.nodes.map((g) => G.round2(g.p[1])),
    y: net.nodes.map((g) => G.round2(g.y)),
    type: net.nodeType,
  },
  edges: edgesOut,
  pts: { x: ptsX, y: ptsY, z: ptsZ },
  movs: movsOut,
  signals,
  names,
  zbe: ZBE_POLYGON,
  bus: busLines,
};

// ---------------------------------------------------------------- salida: geometría para el render
const SIDEWALK_RE = /^(Avinguda|Avenida|Carrer|Calle|Pont|Passeig|Plaça|Plaza|Paseo)/i;
const headSet = new Set(net.controllers.flatMap((c) => c.heads));
const roadSegs = net.segs.map((s) => {
  const c = CLASSES.indexOf(s.cls);
  let f = 0;
  if (s.roundabout) f |= 1;
  if (s.bridge) f |= 2;
  if (s.tunnel) f |= 4;
  const urban = (c >= 4 && ![5, 7, 9].includes(c)) || (c === 2 && SIDEWALK_RE.test(s.name));
  if (urban && !s.bridge && !s.tunnel && !s.roundabout) f |= 8;
  // Marcas de detención: bit0/1 semáforo (fin/inicio), bit2/3 ceda el paso, bit4/5 STOP.
  let sl = 0;
  if (s.eF >= 0 && headSet.has(s.eF)) sl |= 1;
  if (s.eB >= 0 && headSet.has(s.eB)) sl |= 2;
  if (s.eF >= 0 && E[s.eF].yieldType === 1) sl |= 4;
  if (s.eB >= 0 && E[s.eB].yieldType === 1) sl |= 8;
  if (s.eF >= 0 && E[s.eF].yieldType === 2) sl |= 16;
  if (s.eB >= 0 && E[s.eB].yieldType === 2) sl |= 32;
  return {
    p: s.tpts.flatMap((q) => [G.round2(q[0]), G.round2(q[2]), G.round2(q[1])]),
    w: G.round2(s.width),
    nF: s.nF,
    nB: s.nB,
    c,
    eF: s.eF,
    eB: s.eB,
    f,
    n: nameOf(s.name),
    sl,
  };
});
const railsRaw = (await has('railways')) ? await load('railways') : { elements: [] };
const rails = railsRaw.elements
  .filter((w) => w.type === 'way' && w.geometry && !(w.tags?.tunnel && w.tags.tunnel !== 'no'))
  .map((w) => w.geometry.map((p) => project(p.lat, p.lon)).flatMap((q) => [G.round1(q[0]), G.round1(q[1])]));
const roadsOut = {
  segments: roadSegs,
  junctions: net.junctionPolys.map((j) => ({ p: j.hull.flatMap((q) => [G.round2(q[0]), G.round2(q[1])]), y: G.round2(j.y) })),
  islands: net.roundaboutRings.map((r) => r.flatMap((q) => [G.round1(q[0]), G.round1(q[1])])),
  pedestrian: net.pedestrian.map((p) => ({ p: p.pts.flatMap((q) => [G.round1(q[0]), G.round1(q[1])]), w: p.width, a: p.area ? 1 : 0 })),
  rails,
  names,
};

// ---------------------------------------------------------------- vegetación
const bGrid = new G.Grid(40);
const bPolys = [];
{
  const d = buildings.json.data;
  let i = 0;
  while (i < d.length) {
    i += 4;
    const nr = d[i++];
    const lens = d.slice(i, i + nr);
    i += nr;
    const outer = [];
    for (let k = 0; k < lens[0]; k++) outer.push([d[i + 2 * k] / 10, d[i + 2 * k + 1] / 10]);
    for (const l of lens) i += 2 * l;
    const bb = G.bboxOf(outer);
    bGrid.insert(bPolys.length, ...bb);
    bPolys.push(outer);
  }
}
const insideBuilding = (q) => {
  for (const k of bGrid.query(q[0], q[1], q[0], q[1])) if (G.pointInRing(q, bPolys[k])) return true;
  return false;
};
const roadGrid = new G.Grid(30);
net.segs.forEach((s, i) => roadGrid.insert(i, ...G.bboxOf(s.pts)));
const onRoad = (q) => {
  for (const k of roadGrid.query(q[0] - 8, q[1] - 8, q[0] + 8, q[1] + 8)) {
    const s = net.segs[k];
    for (let j = 1; j < s.pts.length; j++) if (G.pointSegDist(q, s.pts[j - 1], s.pts[j]) < s.width / 2 + 1.5) return true;
  }
  return false;
};
const trees = generateTrees((await has('trees')) ? await load('trees') : { elements: [] }, areas.polys, project, insideBuilding, onRoad);
log('árboles y palmeras', trees.count);

await mkdir(outDir, { recursive: true });
const write = async (name, obj) => {
  const text = JSON.stringify(obj);
  await writeFile(join(outDir, name), text);
  log(`→ ${name} ${(text.length / 1e6).toFixed(2)} MB`);
};
await write('network.json', network);
await write('roads.json', roadsOut);
await write('buildings.json', buildings.json);
await write('areas.json', areas.json);
await write('trees.json', trees);
await write('pois.json', pois);
log('Listo.');
