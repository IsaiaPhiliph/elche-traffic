// Construcción de la red viaria simulable a partir de OSM.
// Produce un grafo dirigido de tramos (edges) con carriles, maniobras (movements)
// entre tramos en cada nudo, conflictos entre maniobras, semáforos y prioridades.
import { BBOX } from '../config.mjs';
import * as G from './geo.mjs';

export const CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'pedestrian',
];
const DRIVABLE = new Set(CLASSES.slice(0, 13));
const RANK = {
  motorway: 10, motorway_link: 8, trunk: 9, trunk_link: 7, primary: 8, primary_link: 6,
  secondary: 7, secondary_link: 5, tertiary: 6, tertiary_link: 4, unclassified: 4,
  residential: 3, living_street: 2,
};
const LANE_W = {
  motorway: 3.6, motorway_link: 3.6, trunk: 3.5, trunk_link: 3.5, primary: 3.3, primary_link: 3.3,
  secondary: 3.2, secondary_link: 3.2, tertiary: 3.1, tertiary_link: 3.1, unclassified: 3.0,
  residential: 3.0, living_street: 2.8,
};

export const EDGE_FLAGS = {
  ROUNDABOUT: 1, BRIDGE: 2, TUNNEL: 4, GATEWAY_IN: 8, GATEWAY_OUT: 16, CORE: 32, ZONE: 64, LINK: 128,
};
export const NODE_TYPES = { PRIORITY: 0, SIGNAL: 1, ROUNDABOUT: 2, DEADEND: 3, BOUNDARY: 4 };
export const TURN = { S: 0, R: 1, L: 2, U: 3 };

const yes = (v) => v === 'yes' || v === 'true' || v === '1';
const posInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function parseOneway(t) {
  const o = t.oneway;
  if (yes(o)) return 1;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'no' || o === 'false' || o === '0') return 0;
  if (t.junction === 'roundabout' || t.junction === 'circular') return 1;
  if (t.highway === 'motorway' || t.highway === 'motorway_link') return 1;
  return 0;
}

function parseSpeed(v) {
  if (!v) return null;
  const m = /^(\d+)/.exec(v);
  if (m) return +m[1];
  const map = {
    'ES:urban': 50, 'ES:zone30': 30, 'ES:zone20': 20, 'ES:living_street': 20,
    'ES:rural': 90, 'ES:trunk': 100, 'ES:motorway': 120, walk: 10, none: 120,
  };
  return map[v] ?? null;
}

// Límites por defecto según el Reglamento General de Circulación (RD 970/2020):
// 50 km/h con dos o más carriles por sentido, 30 km/h con uno, 20 km/h plataforma única.
function defaultSpeed(cls, lanesDir) {
  switch (cls) {
    case 'motorway': return 100;
    case 'motorway_link': return 60;
    case 'trunk': return lanesDir >= 2 ? 80 : 60;
    case 'trunk_link': return 50;
    case 'primary': return 50;
    case 'secondary': return lanesDir >= 2 ? 50 : 40;
    case 'tertiary': return lanesDir >= 2 ? 50 : 30;
    case 'primary_link': case 'secondary_link': case 'tertiary_link': return 40;
    case 'living_street': return 20;
    default: return 30;
  }
}

function lanesFor(t, oneway, cls) {
  const total = posInt(t.lanes);
  const fw = posInt(t['lanes:forward']);
  const bw = posInt(t['lanes:backward']);
  const defOne = { motorway: 2, trunk: 2, primary: 2, secondary: 2 }[cls] ?? 1;
  const defTwo = { motorway: 2, trunk: 2 }[cls] ?? 1;
  if (oneway !== 0) return [Math.min(total ?? defOne, 5), 0];
  let nF = fw ?? (total ? Math.max(1, Math.round(total / 2)) : defTwo);
  let nB = bw ?? (total ? Math.max(1, total - nF) : defTwo);
  if (total && fw && !bw) nB = Math.max(1, total - fw);
  if (total && bw && !fw) nF = Math.max(1, total - bw);
  return [Math.min(nF, 5), Math.min(nB, 5)];
}

function wayAttributes(w) {
  const t = w.tags;
  const cls = t.highway;
  const oneway = parseOneway(t);
  const [nF, nB] = lanesFor(t, oneway, cls);
  const lanesDir = Math.max(nF, nB);
  const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
  let speed = parseSpeed(t.maxspeed) ?? defaultSpeed(cls, lanesDir);
  if (roundabout && !t.maxspeed) speed = Math.min(speed, 40);
  const totalLanes = nF + nB;
  let width = parseFloat(t.width);
  if (!(width >= 2.5 && width <= 30)) width = NaN;
  let laneW = LANE_W[cls] ?? 3.0;
  if (Number.isFinite(width)) laneW = Math.min(4.0, Math.max(2.6, width / totalLanes));
  // Calles de doble sentido con un solo carril físico: más estrechas.
  if (oneway === 0 && posInt(t.lanes) === 1) laneW = Math.min(laneW, 2.7);
  const layer = parseInt(t.layer ?? '0', 10) || 0;
  return {
    cls,
    oneway: oneway === 0 ? 0 : 1,
    reverse: oneway === -1,
    nF,
    nB,
    speed,
    laneW,
    roundabout,
    bridge: !!t.bridge && t.bridge !== 'no',
    tunnel: !!t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage',
    layer,
    name: t.name ?? t.ref ?? '',
    ref: t.ref ?? '',
  };
}

const SAME_ATTRS = ['cls', 'oneway', 'nF', 'nB', 'speed', 'laneW', 'roundabout', 'bridge', 'tunnel', 'layer', 'name', 'ref'];

function reverseSeg(s) {
  s.nodes.reverse();
  [s.nF, s.nB] = [s.nB, s.nF];
  [s.wayAtStart, s.wayAtEnd] = [s.wayAtEnd, s.wayAtStart];
  const a = s.sameOrderStart;
  s.sameOrderStart = !s.sameOrderEnd;
  s.sameOrderEnd = !a;
}

export function buildNetwork(roadsJson, restrictionsJson, project) {
  const nodeById = new Map();
  for (const el of roadsJson.elements) {
    if (el.type === 'node') nodeById.set(el.id, el);
  }
  const inBox = (n) => n.lat >= BBOX.south && n.lat <= BBOX.north && n.lon >= BBOX.west && n.lon <= BBOX.east;
  const xzOf = new Map();
  const xz = (id) => {
    let p = xzOf.get(id);
    if (!p) {
      const n = nodeById.get(id);
      p = project(n.lat, n.lon);
      xzOf.set(id, p);
    }
    return p;
  };

  // --- Nodos especiales ---
  const signalNodes = new Map(); // id -> {dir, crossing}
  const yieldNodes = new Map(); // id -> 1 ceda / 2 stop
  for (const n of nodeById.values()) {
    const t = n.tags;
    if (!t) continue;
    const hw = t.highway ?? '';
    if (hw.includes('traffic_signals') || t.crossing === 'traffic_signals') {
      signalNodes.set(n.id, {
        dir: t['traffic_signals:direction'] ?? t.direction ?? null,
        crossing: hw === 'crossing' || !!t.crossing,
      });
    } else if (hw === 'stop') yieldNodes.set(n.id, 2);
    else if (hw === 'give_way') yieldNodes.set(n.id, 1);
  }
  const viaNodes = new Set();
  for (const r of restrictionsJson.elements) {
    for (const m of r.members) if (m.role === 'via' && m.type === 'node') viaNodes.add(m.ref);
  }

  // --- Vías: filtrado, recorte al bbox y atributos ---
  const pieces = [];
  const boundaryCand = new Set();
  const pedestrian = [];
  const roundaboutRings = [];
  for (const el of roadsJson.elements) {
    if (el.type !== 'way') continue;
    const t = el.tags ?? {};
    const cls = t.highway;
    if (cls === 'pedestrian') {
      const pts = el.nodes.filter((id) => nodeById.has(id) && inBox(nodeById.get(id))).map(xz);
      if (pts.length >= 2) {
        const closed = el.nodes[0] === el.nodes[el.nodes.length - 1];
        pedestrian.push({ pts, area: closed && yes(t.area), width: parseFloat(t.width) || 6 });
      }
      continue;
    }
    if (!DRIVABLE.has(cls)) continue;
    if (t.area === 'yes') continue;
    if ((t.access === 'no' || t.access === 'private') && !['yes', 'destination', 'permissive'].includes(t.motor_vehicle ?? t.motorcar)) continue;
    if (t.motor_vehicle === 'no' || t.motorcar === 'no') continue;
    const attrs = wayAttributes(el);
    if ((t.junction === 'roundabout' || t.junction === 'circular') && el.nodes[0] === el.nodes[el.nodes.length - 1]) {
      roundaboutRings.push(el.nodes.filter((id) => nodeById.has(id)).map(xz));
    }
    let cur = [];
    let cutStart = false;
    const flush = (cutEnd) => {
      if (cur.length >= 2) {
        if (cutStart) boundaryCand.add(cur[0]);
        if (cutEnd) boundaryCand.add(cur[cur.length - 1]);
        pieces.push({ nodes: cur, way: el.id, ...attrs });
      }
      cur = [];
    };
    for (let i = 0; i < el.nodes.length; i++) {
      const n = nodeById.get(el.nodes[i]);
      if (n && inBox(n)) {
        if (cur.length === 0) cutStart = i > 0;
        cur.push(n.id);
      } else if (cur.length) {
        flush(true);
      }
    }
    flush(false);
  }

  // Normaliza sentido único inverso (oneway=-1) y prepara metadatos por extremo.
  for (const p of pieces) {
    p.sameOrderStart = true;
    p.sameOrderEnd = true;
    p.wayAtStart = p.way;
    p.wayAtEnd = p.way;
    if (p.reverse) {
      p.nodes.reverse();
      p.sameOrderStart = p.sameOrderEnd = false;
    }
  }

  // --- División en tramos en los cruces ---
  const use = new Map();
  const isEnd = new Set();
  for (const p of pieces) {
    p.nodes.forEach((id, i) => {
      use.set(id, (use.get(id) ?? 0) + 1);
      if (i === 0 || i === p.nodes.length - 1) isEnd.add(id);
    });
  }
  const isSplit = (id) => (use.get(id) ?? 0) >= 2 || isEnd.has(id) || signalNodes.has(id) || viaNodes.has(id);
  let segs = [];
  for (const p of pieces) {
    let start = 0;
    for (let i = 1; i < p.nodes.length; i++) {
      if (isSplit(p.nodes[i]) || i === p.nodes.length - 1) {
        const s = { ...p, nodes: p.nodes.slice(start, i + 1) };
        segs.push(s);
        start = i;
      }
    }
  }

  // --- Fusión de tramos consecutivos idénticos (nudos de grado 2) ---
  const incid = new Map();
  const addInc = (n, si) => {
    let a = incid.get(n);
    if (!a) incid.set(n, (a = []));
    a.push(si);
  };
  segs.forEach((s, i) => {
    addInc(s.nodes[0], i);
    addInc(s.nodes[s.nodes.length - 1], i);
  });
  const protectedNode = (n) => signalNodes.has(n) || viaNodes.has(n) || boundaryCand.has(n);
  for (const [n, list] of incid) {
    if (list.length !== 2 || protectedNode(n)) continue;
    const [i, j] = list;
    if (i === j) continue;
    let A = segs[i];
    let B = segs[j];
    if (!A || !B) continue;
    const endA = A.nodes[A.nodes.length - 1] === n;
    const startB = B.nodes[0] === n;
    let first = i;
    let second = j;
    if (endA && startB) {
      // A -> B
    } else if (!endA && !startB) {
      // A empieza y B termina en n: B -> A
      [A, B] = [B, A];
      [first, second] = [second, first];
    } else if (endA && !startB) {
      if (B.oneway) continue;
      reverseSeg(B);
    } else {
      if (A.oneway) continue;
      reverseSeg(A);
    }
    if (A.nodes[A.nodes.length - 1] !== n || B.nodes[0] !== n) continue;
    if (SAME_ATTRS.some((k) => A[k] !== B[k])) continue;
    // Evita crear un anillo cerrado sin cruces.
    if (A.nodes[0] === B.nodes[B.nodes.length - 1]) continue;
    A.nodes = A.nodes.concat(B.nodes.slice(1));
    A.wayAtEnd = B.wayAtEnd;
    A.sameOrderEnd = B.sameOrderEnd;
    segs[second] = null;
    const other = incid.get(B.nodes[B.nodes.length - 1]);
    for (let k = 0; k < other.length; k++) if (other[k] === second) other[k] = first;
    incid.set(n, []);
  }
  segs = segs.filter(Boolean);

  // --- Nudos del grafo ---
  const gIndex = new Map();
  const gNodes = [];
  const gnode = (id) => {
    let k = gIndex.get(id);
    if (k === undefined) {
      k = gNodes.length;
      gIndex.set(id, k);
      gNodes.push({ id, p: xz(id), ends: [], y: 0 });
    }
    return k;
  };
  for (const s of segs) {
    s.a = gnode(s.nodes[0]);
    s.b = gnode(s.nodes[s.nodes.length - 1]);
    s.pts = s.nodes.map(xz);
    s.len = G.polylineLength(s.pts);
    s.width = s.laneW * (s.nF + s.nB);
  }
  segs.forEach((s, i) => {
    gNodes[s.a].ends.push({ seg: i, atStart: true });
    gNodes[s.b].ends.push({ seg: i, atStart: false });
  });
  for (const g of gNodes) {
    g.degree = g.ends.length;
    g.boundary = g.degree === 1 && boundaryCand.has(g.id);
    g.roundabout = g.ends.some((e) => segs[e.seg].roundabout);
  }

  // --- Elevación: puentes que cruzan sobre otras vías y rampas de acceso ---
  const elevation = computeElevation(segs, xz);
  for (const s of segs) {
    s.pts3 = s.nodes.map((id, i) => [s.pts[i][0], s.pts[i][1], elevation.get(id) ?? 0]);
  }
  for (const g of gNodes) g.y = elevation.get(g.id) ?? 0;

  // --- Recorte de tramos en los cruces (espacio de la intersección) ---
  for (const g of gNodes) {
    const ends = g.ends.map((e) => {
      const s = segs[e.seg];
      const pts = e.atStart ? s.pts : G.reversed(s.pts);
      return { ...e, dir: G.startDirection(pts), hw: s.width / 2 };
    });
    for (const e of ends) {
      let r = 0;
      for (const o of ends) {
        if (o === e) continue;
        const c = e.dir[0] * o.dir[0] + e.dir[1] * o.dir[1];
        const theta = Math.acos(Math.max(-1, Math.min(1, c)));
        if (theta > (150 * Math.PI) / 180) continue;
        const sn = Math.max(0.15, Math.sin(theta));
        const d = (o.hw + e.hw * c) / sn;
        r = Math.max(r, Math.min(20, d));
      }
      const trim = r > 0.2 ? r + 1.2 : 0;
      const s = segs[e.seg];
      if (e.atStart) s.trimA = trim;
      else s.trimB = trim;
    }
  }
  for (const s of segs) {
    let a = s.trimA ?? 0;
    let b = s.trimB ?? 0;
    const maxTrim = Math.max(0, s.len - 1.0);
    if (a + b > maxTrim) {
      const f = maxTrim / (a + b || 1);
      a *= f;
      b *= f;
    }
    s.trimA = a;
    s.trimB = b;
    s.tpts = G.slicePolyline(s.pts3, a, s.len - b); // [x, z, y]
    s.tlen = Math.max(0.5, G.polylineLength(s.tpts.map((p) => [p[0], p[1]])));
  }

  // Polígonos de las intersecciones.
  const junctionPolys = [];
  for (const g of gNodes) {
    if (g.degree < 2) continue;
    const corners = [];
    let any = false;
    let ySum = 0;
    for (const e of g.ends) {
      const s = segs[e.seg];
      const pts = e.atStart ? s.tpts : G.reversed(s.tpts);
      const p = pts[0];
      const d = G.startDirection(pts.map((q) => [q[0], q[1]]), 3);
      const hw = s.width / 2;
      corners.push([p[0] - d[1] * hw, p[1] + d[0] * hw], [p[0] + d[1] * hw, p[1] - d[0] * hw]);
      if ((e.atStart ? s.trimA : s.trimB) > 0.3) any = true;
      ySum += p[2];
    }
    if (!any && g.degree === 2) continue;
    corners.push(g.p);
    const hull = G.convexHull(corners);
    if (hull.length >= 3) junctionPolys.push({ hull, y: ySum / g.ends.length, node: g });
  }

  // --- Tramos dirigidos ---
  const edges = [];
  segs.forEach((s, si) => {
    const total = s.nF + s.nB;
    const mk = (forward) => {
      const lanes = forward ? s.nF : s.nB;
      const opp = forward ? s.nB : s.nF;
      const pts = forward ? s.tpts : G.reversed(s.tpts);
      const e = {
        id: edges.length,
        seg: si,
        forward,
        from: forward ? s.a : s.b,
        to: forward ? s.b : s.a,
        lanes,
        laneW: s.laneW,
        off0: ((opp - lanes) / 2 + 0.5) * s.laneW,
        speed: s.speed,
        rank: RANK[s.cls] ?? 3,
        cls: CLASSES.indexOf(s.cls),
        pts,
        len: s.tlen,
        roundabout: s.roundabout,
        bridge: s.bridge,
        tunnel: s.tunnel,
        name: s.name,
        ref: s.ref,
        wayStart: forward ? s.wayAtStart : s.wayAtEnd,
        wayEnd: forward ? s.wayAtEnd : s.wayAtStart,
        // Sentido de circulación respecto al orden de nodos de la vía OSM en cada extremo.
        wayFwdEnd: forward ? s.sameOrderEnd : !s.sameOrderStart,
        yieldType: 0,
        total,
      };
      e.dirEnd = endDirection(pts);
      e.dirStart = G.startDirection(pts.map((q) => [q[0], q[1]]));
      edges.push(e);
      return e.id;
    };
    s.eF = s.nF > 0 ? mk(true) : -1;
    s.eB = s.nB > 0 ? mk(false) : -1;
  });
  for (const g of gNodes) {
    g.inE = [];
    g.outE = [];
  }
  for (const e of edges) {
    gNodes[e.to].inE.push(e.id);
    gNodes[e.from].outE.push(e.id);
  }

  // --- Prohibiciones de giro ---
  const banned = new Set();
  const onlyFrom = new Map(); // edgeIn -> set of allowed edgeOut
  for (const r of restrictionsJson.elements) {
    const t = r.tags ?? {};
    const kind = t.restriction ?? t['restriction:motorcar'] ?? t['restriction:motor_vehicle'];
    if (!kind) continue;
    const from = r.members.find((m) => m.role === 'from' && m.type === 'way');
    const to = r.members.find((m) => m.role === 'to' && m.type === 'way');
    const via = r.members.find((m) => m.role === 'via' && m.type === 'node');
    if (!from || !to || !via) continue;
    const gi = gIndex.get(via.ref);
    if (gi === undefined) continue;
    const g = gNodes[gi];
    const ins = g.inE.filter((e) => edges[e].wayEnd === from.ref);
    const outs = g.outE.filter((e) => edges[e].wayStart === to.ref);
    for (const ei of ins) {
      if (kind.startsWith('no_')) for (const eo of outs) banned.add(ei + ':' + eo);
      else if (kind.startsWith('only_')) {
        let s = onlyFrom.get(ei);
        if (!s) onlyFrom.set(ei, (s = new Set()));
        for (const eo of outs) s.add(eo);
      }
    }
  }

  // --- Maniobras en cada nudo ---
  const movs = [];
  for (const g of gNodes) {
    if (g.boundary) continue;
    for (const ei of g.inE) {
      const ein = edges[ei];
      for (const eo of g.outE) {
        const eout = edges[eo];
        const uTurnSame = eout.seg === ein.seg && eout.forward !== ein.forward;
        if (uTurnSame && g.degree > 1) continue;
        if (banned.has(ei + ':' + eo)) continue;
        const only = onlyFrom.get(ei);
        if (only && only.size && !only.has(eo)) continue;
        const d1 = ein.dirEnd;
        const d2 = eout.dirStart;
        const cr = d1[0] * d2[1] - d1[1] * d2[0];
        const dt = d1[0] * d2[0] + d1[1] * d2[1];
        const ang = (Math.atan2(cr, dt) * 180) / Math.PI; // >0 derecha (z hacia el sur)
        let turn = TURN.S;
        if (uTurnSame || Math.abs(ang) >= 150) turn = TURN.U;
        else if (ang >= 35) turn = TURN.R;
        else if (ang <= -35) turn = TURN.L;
        if (ein.roundabout && eout.roundabout) turn = TURN.S;
        movs.push({ from: ei, to: eo, node: edges[ei].to, turn, ang });
      }
    }
  }

  // --- Componente fuertemente conexa principal ---
  const outMov = edges.map(() => []);
  const inMov = edges.map(() => []);
  movs.forEach((m, i) => {
    outMov[m.from].push(i);
    inMov[m.to].push(i);
  });
  const comp = tarjan(edges.length, (v) => outMov[v].map((m) => movs[m].to));
  const sizes = new Map();
  for (const c of comp) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  let coreComp = -1;
  let best = 0;
  for (const [c, n] of sizes) if (n > best) [best, coreComp] = [n, c];
  const inCore = comp.map((c) => c === coreComp);
  const reach = bfs(edges.length, inCore, (v) => outMov[v].map((m) => movs[m].to));
  const coreach = bfs(edges.length, inCore, (v) => inMov[v].map((m) => movs[m].from));
  const keep = edges.map((_, i) => reach[i] || coreach[i]);

  // --- Semáforos: cabezas (tramo que llega a la línea de detención) ---
  const heads = new Map(); // edgeId -> {x, z}
  for (const [osmId, info] of signalNodes) {
    const gi = gIndex.get(osmId);
    if (gi === undefined) continue;
    const g = gNodes[gi];
    if (g.degree === 0) continue;
    let ins = g.inE.slice();
    if (g.degree === 2 && ins.length > 1) {
      if (info.dir === 'forward' || info.dir === 'backward') {
        ins = ins.filter((e) => edges[e].wayFwdEnd === (info.dir === 'forward'));
      } else {
        // El semáforo regula el sentido que se acerca al cruce más próximo.
        const distToJunction = (ei) => {
          const outs = g.outE.filter((eo) => edges[eo].seg !== edges[ei].seg);
          if (!outs.length) return Infinity;
          const eo = edges[outs[0]];
          return gNodes[eo.to].degree >= 3 ? eo.len : Infinity;
        };
        const d = ins.map(distToJunction);
        const near = d.map((v) => v <= 45);
        if (near[0] && near[1]) {
          if (Math.abs(d[0] - d[1]) > 15) ins = [d[0] < d[1] ? ins[0] : ins[1]];
        } else if (near[0] || near[1]) {
          ins = ins.filter((_, k) => near[k]);
        }
      }
    }
    if (g.degree === 1) continue;
    for (const ei of ins) {
      const e = edges[ei];
      const p = e.pts[e.pts.length - 1];
      heads.set(ei, { x: p[0], z: p[1] });
    }
  }

  // Ceda el paso / STOP: aplican al tramo cuyo final está a menos de 30 m.
  for (const s of segs) {
    for (let i = 1; i < s.nodes.length - 1; i++) {
      const y = yieldNodes.get(s.nodes[i]);
      if (!y) continue;
      const d = G.polylineLength(s.pts.slice(0, i + 1));
      const toEnd = s.len - d;
      if (toEnd < 30 && (toEnd <= d || d >= 30)) {
        if (s.eF >= 0) edges[s.eF].yieldType = Math.max(edges[s.eF].yieldType, y);
      } else if (d < 30 && s.eB >= 0) {
        edges[s.eB].yieldType = Math.max(edges[s.eB].yieldType, y);
      }
    }
  }

  // Agrupa cabezas en reguladores (enlace simple a 45 m) y separa dos fases por eje.
  const headIds = [...heads.keys()].filter((e) => keep[e]);
  const parent = headIds.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const grid = new G.Grid(50);
  headIds.forEach((e, i) => {
    const h = heads.get(e);
    grid.insert(i, h.x, h.z, h.x, h.z);
  });
  headIds.forEach((e, i) => {
    const h = heads.get(e);
    for (const j of grid.query(h.x - 45, h.z - 45, h.x + 45, h.z + 45)) {
      const o = heads.get(headIds[j]);
      if (j !== i && Math.hypot(o.x - h.x, o.z - h.z) < 45) parent[find(i)] = find(j);
    }
  });
  const clusters = new Map();
  headIds.forEach((e, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(e);
  });
  const controllers = [];
  for (const list of clusters.values()) {
    const ang = list.map((ei) => Math.atan2(edges[ei].dirEnd[1], edges[ei].dirEnd[0]));
    const groups = splitAxes(ang);
    const cx = list.reduce((s, ei) => s + heads.get(ei).x, 0) / list.length;
    const cz = list.reduce((s, ei) => s + heads.get(ei).z, 0) / list.length;
    controllers.push({ heads: list, groups, x: cx, z: cz });
  }

  // Nudos dentro del área de un semáforo: prioridad por tipo de giro.
  const signalArea = new Set();
  const nodeGrid = new G.Grid(50);
  gNodes.forEach((g, i) => nodeGrid.insert(i, g.p[0], g.p[1], g.p[0], g.p[1]));
  for (const c of controllers) {
    for (const ei of c.heads) {
      const h = heads.get(ei);
      signalArea.add(edges[ei].to);
      for (const gi of nodeGrid.query(h.x - 35, h.z - 35, h.x + 35, h.z + 35)) {
        const g = gNodes[gi];
        if (g.degree >= 3 && Math.hypot(g.p[0] - h.x, g.p[1] - h.z) < 35) signalArea.add(gi);
      }
    }
  }

  // --- Reindexado con los tramos conservados ---
  const newId = new Int32Array(edges.length).fill(-1);
  const kept = [];
  edges.forEach((e, i) => {
    if (keep[i]) {
      newId[i] = kept.length;
      kept.push(e);
    }
  });
  for (const e of kept) {
    e.core = inCore[e.id];
    e.gwIn = gNodes[e.from].boundary;
    e.gwOut = gNodes[e.to].boundary;
  }
  const keptMovs = movs
    .filter((m) => keep[m.from] && keep[m.to])
    .map((m) => ({ ...m, from: newId[m.from], to: newId[m.to] }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (const s of segs) {
    s.eF = s.eF >= 0 ? newId[s.eF] : -1;
    s.eB = s.eB >= 0 ? newId[s.eB] : -1;
  }
  for (const c of controllers) c.heads = c.heads.map((e) => newId[e]);

  // Conflictos entre maniobras del mismo nudo (trayectorias que se cortan o confluyen).
  const byNode = new Map();
  keptMovs.forEach((m, i) => {
    if (!byNode.has(m.node)) byNode.set(m.node, []);
    byNode.get(m.node).push(i);
  });
  const curves = keptMovs.map((m) => movementCurve(kept[m.from], kept[m.to]));
  const conflicts = keptMovs.map(() => []);
  for (const list of byNode.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const ma = keptMovs[list[a]];
        const mb = keptMovs[list[b]];
        if (ma.from === mb.from) continue;
        if (ma.to === mb.to || G.polylinesIntersect(curves[list[a]], curves[list[b]])) {
          conflicts[list[a]].push(list[b]);
          conflicts[list[b]].push(list[a]);
        }
      }
    }
  }

  // Tipo de nudo para las reglas de prioridad.
  const nodeType = gNodes.map((g, i) => {
    if (g.boundary) return NODE_TYPES.BOUNDARY;
    if (g.degree === 1) return NODE_TYPES.DEADEND;
    if (signalArea.has(i)) return NODE_TYPES.SIGNAL;
    if (g.roundabout) return NODE_TYPES.ROUNDABOUT;
    return NODE_TYPES.PRIORITY;
  });

  return {
    nodes: gNodes,
    gIndex,
    newId,
    nodeType,
    segs,
    edges: kept,
    movs: keptMovs,
    conflicts,
    controllers,
    heads,
    junctionPolys,
    pedestrian,
    roundaboutRings,
    stats: {
      pieces: pieces.length,
      segments: segs.length,
      graphNodes: gNodes.length,
      edgesAll: edges.length,
      edgesKept: kept.length,
      core: kept.filter((e) => e.core).length,
      movements: keptMovs.length,
      controllers: controllers.length,
      heads: headIds.length,
      restrictionsBanned: banned.size,
      yieldEdges: kept.filter((e) => e.yieldType).length,
    },
  };
}

function endDirection(pts) {
  const rev = G.reversed(pts).map((q) => [q[0], q[1]]);
  const d = G.startDirection(rev);
  return [-d[0], -d[1]];
}

// Curva representativa de una maniobra (Bézier cuadrática entre carriles centrales).
export function movementCurve(ein, eout) {
  const pa = ein.pts[ein.pts.length - 1];
  const pb = eout.pts[0];
  const da = ein.dirEnd;
  const db = eout.dirStart;
  const offA = ein.off0 + ((ein.lanes - 1) / 2) * ein.laneW;
  const offB = eout.off0 + ((eout.lanes - 1) / 2) * eout.laneW;
  // Normal a la derecha del sentido de marcha (x este, z sur): (-dz, dx).
  const p0 = [pa[0] - da[1] * offA, pa[1] + da[0] * offA];
  const p2 = [pb[0] - db[1] * offB, pb[1] + db[0] * offB];
  const p1 = controlPoint(p0, da, p2, db);
  const out = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}

export function controlPoint(p0, d0, p2, d2) {
  const chord = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
  const den = d0[0] * d2[1] - d0[1] * d2[0];
  if (Math.abs(den) > 0.05) {
    const t = ((p2[0] - p0[0]) * d2[1] - (p2[1] - p0[1]) * d2[0]) / den;
    const u = ((p2[0] - p0[0]) * d0[1] - (p2[1] - p0[1]) * d0[0]) / den;
    if (t > 0 && u > 0 && t < chord * 1.5) return [p0[0] + d0[0] * t, p0[1] + d0[1] * t];
  }
  return [(p0[0] + p2[0]) / 2 + (d0[0] - d2[0]) * chord * 0.15, (p0[1] + p2[1]) / 2 + (d0[1] - d2[1]) * chord * 0.15];
}

// Divide los accesos de un regulador en dos fases según su eje (k-medias sobre ángulo doble).
function splitAxes(angles) {
  if (angles.length < 2) return angles.map(() => 0);
  const v = angles.map((a) => [Math.cos(2 * a), Math.sin(2 * a)]);
  // Semillas: el par más separado.
  let bi = 0;
  let bj = 1;
  let worst = Infinity;
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length; j++) {
      const d = v[i][0] * v[j][0] + v[i][1] * v[j][1];
      if (d < worst) [worst, bi, bj] = [d, i, j];
    }
  // cos(2Δ) > 0.5 equivale a ejes separados menos de 30°: una sola fase.
  if (worst > 0.5) return angles.map(() => 0);
  let c0 = v[bi];
  let c1 = v[bj];
  let g = [];
  for (let it = 0; it < 8; it++) {
    g = v.map((p) => (p[0] * c0[0] + p[1] * c0[1] >= p[0] * c1[0] + p[1] * c1[1] ? 0 : 1));
    const mean = (k) => {
      const s = [0, 0];
      let n = 0;
      v.forEach((p, i) => {
        if (g[i] === k) {
          s[0] += p[0];
          s[1] += p[1];
          n++;
        }
      });
      const l = Math.hypot(s[0], s[1]) || 1;
      return n ? [s[0] / l, s[1] / l] : k === 0 ? c0 : c1;
    };
    c0 = mean(0);
    c1 = mean(1);
  }
  return g;
}

function computeElevation(segs, xz) {
  const LAYER_H = 5.5;
  const GRADE = 0.06;
  const grid = new G.Grid(80);
  segs.forEach((s, i) => {
    const [a, b, c, d] = G.bboxOf(s.pts);
    grid.insert(i, a, b, c, d);
  });
  const target = new Map();
  segs.forEach((s, i) => {
    if (!s.bridge || s.layer < 1) return;
    const [a, b, c, d] = G.bboxOf(s.pts);
    let over = false;
    for (const j of grid.query(a, b, c, d)) {
      const o = segs[j];
      if (j === i || (o.bridge && o.layer >= s.layer)) continue;
      if (o.nodes.some((n) => s.nodes.includes(n))) continue;
      if (G.polylinesIntersect(s.pts, o.pts)) {
        over = true;
        break;
      }
    }
    if (!over) return;
    for (const n of s.nodes) target.set(n, Math.max(target.get(n) ?? 0, LAYER_H * s.layer));
  });
  // Propagación con pendiente máxima para generar rampas suaves.
  const adj = new Map();
  for (const s of segs) {
    for (let i = 1; i < s.nodes.length; i++) {
      const a = s.nodes[i - 1];
      const b = s.nodes[i];
      const d = G.dist(xz(a), xz(b));
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push([b, d]);
      adj.get(b).push([a, d]);
    }
  }
  const elev = new Map(target);
  const queue = [...target.keys()];
  while (queue.length) {
    const n = queue.pop();
    const h = elev.get(n);
    for (const [m, d] of adj.get(n) ?? []) {
      const c = h - GRADE * d;
      if (c > 0.05 && c > (elev.get(m) ?? 0)) {
        elev.set(m, c);
        queue.push(m);
      }
    }
  }
  return elev;
}

// Tarjan iterativo: devuelve el identificador de componente de cada vértice.
function tarjan(n, succ) {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack = [];
  let idx = 0;
  let c = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0, succ(s)]];
    index[s] = low[s] = idx++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i, nb] = top;
      if (i < nb.length) {
        top[1]++;
        const w = nb[i];
        if (index[w] === -1) {
          index[w] = low[w] = idx++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0, succ(w)]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) {
          const u = work[work.length - 1][0];
          low[u] = Math.min(low[u], low[v]);
        }
        if (low[v] === index[v]) {
          let w;
          do {
            w = stack.pop();
            onStack[w] = 0;
            comp[w] = c;
          } while (w !== v);
          c++;
        }
      }
    }
  }
  return comp;
}

function bfs(n, seed, next) {
  const seen = new Uint8Array(n);
  const q = [];
  for (let i = 0; i < n; i++) if (seed[i]) {
    seen[i] = 1;
    q.push(i);
  }
  while (q.length) {
    const v = q.pop();
    for (const w of next(v)) if (!seen[w]) {
      seen[w] = 1;
      q.push(w);
    }
  }
  return seen;
}
