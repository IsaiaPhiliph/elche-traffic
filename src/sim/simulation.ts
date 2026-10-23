// Simulación microscópica de tráfico.
// - Seguimiento de vehículos: Intelligent Driver Model (IDM, Treiber et al. 2000).
// - Cambio de carril: MOBIL simplificado con carriles obligatorios antes de girar.
// - Intersecciones: maniobras con conflictos precalculados, reserva del cruce,
//   semáforos, prioridad en glorietas, STOP/ceda y prioridad a la derecha.
// - Rutas: A* con tiempos de viaje observados (reencaminamiento dinámico).
import { Network } from './network';
import { Router } from './router';
import { Signals, SIG, type SignalMode } from './signals';
import { Demand, type DemandEvent, type Trip } from './demand';
import { EDGE_FLAGS, NODE_TYPES, TURN, KIND, type NetworkJSON, type BusLineJSON } from './types';

export const MAXV = 24000;
export const FRAME_STRIDE = 8;

interface KindParams {
  len: number; amax: number; b: number; T: number; s0: number; vmax: number;
  mass: number; cda: number; idle: number;
}
const KP: KindParams[] = [
  { len: 4.4, amax: 1.7, b: 2.3, T: 1.2, s0: 2.0, vmax: 50, mass: 1300, cda: 0.7, idle: 0.35 },
  { len: 5.3, amax: 1.3, b: 2.0, T: 1.4, s0: 2.2, vmax: 36, mass: 2100, cda: 1.2, idle: 0.5 },
  { len: 9.5, amax: 0.8, b: 1.7, T: 1.7, s0: 2.5, vmax: 25, mass: 12000, cda: 5.0, idle: 1.5 },
  { len: 12.0, amax: 0.9, b: 1.6, T: 1.5, s0: 2.5, vmax: 15.5, mass: 13000, cda: 6.0, idle: 1.8 },
  { len: 2.1, amax: 2.5, b: 3.0, T: 0.9, s0: 1.5, vmax: 50, mass: 220, cda: 0.5, idle: 0.12 },
];

const WAIT = 0;
const GO = 1;
const COMMIT = 2;

export interface SimConfig {
  demand: number;
  maxVehicles: number;
  signalMode: SignalMode;
  cycle: number;
  buses: boolean;
  zbe: boolean;
  rerouting: boolean;
}

export interface SimStats {
  time: number;
  vehicles: number;
  byKind: number[];
  meanSpeed: number;
  stoppedShare: number;
  spawned: number;
  arrived: number;
  teleported: number;
  noRoute: number;
  avgTripMin: number;
  avgDelayMin: number;
  throughput: number;
  co2Total: number;
  co2Rate: number;
  demandRate: number;
  buses: number;
  closed: number;
}

export interface VehicleInfo {
  id: number;
  kind: number;
  speed: number;
  street: string;
  origin: string;
  dest: string;
  remainingKm: number;
  etaMin: number;
  tripMin: number;
  waiting: number;
  route: number[];
  line: string | null;
  through: boolean;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Punto de control de la Bézier cuadrática entre el final de un carril y el inicio de otro.
function controlPoint(p0x: number, p0z: number, d0x: number, d0z: number, p2x: number, p2z: number, d2x: number, d2z: number, out: Float32Array) {
  const chord = Math.hypot(p2x - p0x, p2z - p0z);
  const den = d0x * d2z - d0z * d2x;
  if (Math.abs(den) > 0.05) {
    const t = ((p2x - p0x) * d2z - (p2z - p0z) * d2x) / den;
    const u = ((p2x - p0x) * d0z - (p2z - p0z) * d0x) / den;
    if (t > 0 && u > 0 && t < chord * 1.5) {
      out[0] = p0x + d0x * t;
      out[1] = p0z + d0z * t;
      return;
    }
  }
  out[0] = (p0x + p2x) / 2 + (d0x - d2x) * chord * 0.15;
  out[1] = (p0z + p2z) / 2 + (d0z - d2z) * chord * 0.15;
}

function bezierLength(x0: number, z0: number, x1: number, z1: number, x2: number, z2: number) {
  let L = 0;
  let px = x0;
  let pz = z0;
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const u = 1 - t;
    const x = u * u * x0 + 2 * u * t * x1 + t * t * x2;
    const z = u * u * z0 + 2 * u * t * z1 + t * t * z2;
    L += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return Math.max(0.3, L);
}

export class Simulation {
  readonly net: Network;
  readonly router: Router;
  readonly signals: Signals;
  readonly demand: Demand;
  readonly busLines: BusLineJSON[];
  time = 8 * 3600;
  cfg: SimConfig = { demand: 1, maxVehicles: 9000, signalMode: 'fixed', cycle: 90, buses: true, zbe: false, rerouting: true };
  private rand: () => number;
  private stepId = 0;

  // --- estado de vehículos (estructura de arrays) ---
  readonly alive = new Uint8Array(MAXV);
  readonly kind = new Uint8Array(MAXV);
  readonly color = new Uint8Array(MAXV);
  readonly len = new Float32Array(MAXV);
  private amax = new Float32Array(MAXV);
  private bcomf = new Float32Array(MAXV);
  private T = new Float32Array(MAXV);
  private s0 = new Float32Array(MAXV);
  private vfac = new Float32Array(MAXV);
  private vmax = new Float32Array(MAXV);
  readonly edge = new Int32Array(MAXV);
  readonly lane = new Int8Array(MAXV);
  readonly s = new Float32Array(MAXV);
  readonly v = new Float32Array(MAXV);
  readonly a = new Float32Array(MAXV);
  private conn = new Int32Array(MAXV);
  private cmov = new Int32Array(MAXV);
  private ctl = new Int8Array(MAXV);
  private cgeo = new Float32Array(MAXV * 9); // x0 z0 x1 z1 x2 z2 y0 y2 len
  private seg = new Int32Array(MAXV);
  readonly route: (Int32Array | null)[] = new Array(MAXV).fill(null);
  readonly ri = new Int32Array(MAXV);
  private nextMov = new Int32Array(MAXV);
  private destS = new Float32Array(MAXV);
  private latOff = new Float32Array(MAXV);
  private admitted = new Uint8Array(MAXV);
  private admMov = new Int32Array(MAXV);
  private admWait = new Float32Array(MAXV);
  private waitT = new Float32Array(MAXV);
  private stuckT = new Float32Array(MAXV);
  private stopDone = new Uint8Array(MAXV);
  private lcCool = new Float32Array(MAXV);
  private tStart = new Float64Array(MAXV);
  private freeT = new Float32Array(MAXV);
  private through = new Uint8Array(MAXV);
  private inZone = new Uint8Array(MAXV);
  readonly bus = new Int16Array(MAXV).fill(-1);
  private busStop = new Int16Array(MAXV);
  private dwell = new Float32Array(MAXV);
  private origin = new Int32Array(MAXV);
  private freeSlots: number[] = [];
  count = 0;

  // --- ocupación ---
  private lanes: number[][];
  private conns: number[][];
  private nodeRes: number[][];
  private activeLanes: number[] = [];
  private laneActive: Uint8Array;
  private activeConns: number[] = [];
  private connActive: Uint8Array;
  private pending: number[] = [];
  private lcList: number[] = [];

  // --- maniobras precalculadas ---
  private mSpeed: Float32Array;
  private mLen: Float32Array;
  /** Distancia de la línea de detención al final del tramo (paso de peatones en semáforos). */
  readonly stopOff: Float32Array;

  // --- medidas ---
  readonly heat: Uint8Array;
  private edgeSum: Float32Array;
  private edgeCnt: Uint16Array;
  private measureT = 0;
  private heatT = 0;
  private rerouteT = 0;
  private acc = { internal: 0, inbound: 0, outbound: 0, through: 0 };
  private eventAcc = new Map<string, number>();
  private busNext: number[] = [];
  private tmp = new Float32Array(4);
  private cp = new Float32Array(2);
  stats: SimStats;
  private tripEMA = 0;
  private delayEMA = 0;
  private arrivalsWindow: number[] = [];
  private co2Window = 0;
  private co2RateEMA = 0;
  heatVersion = 0;

  constructor(json: NetworkJSON, seed = 2026) {
    this.net = new Network(json);
    const net = this.net;
    this.rand = mulberry32(seed);
    this.router = new Router(net);
    this.signals = new Signals(net);
    this.demand = new Demand(net, this.rand);
    this.busLines = json.bus ?? [];
    this.lanes = Array.from({ length: net.nLanes }, () => []);
    this.conns = Array.from({ length: net.nConns }, () => []);
    this.nodeRes = Array.from({ length: net.nNodes }, () => []);
    this.laneActive = new Uint8Array(net.nLanes);
    this.connActive = new Uint8Array(net.nConns);
    this.heat = new Uint8Array(net.nEdges).fill(255);
    this.edgeSum = new Float32Array(net.nEdges);
    this.edgeCnt = new Uint16Array(net.nEdges);
    for (let i = MAXV - 1; i >= 0; i--) this.freeSlots.push(i);
    this.mSpeed = new Float32Array(net.nMovs);
    this.mLen = new Float32Array(net.nMovs);
    this.stopOff = new Float32Array(net.nEdges);
    for (let e = 0; e < net.nEdges; e++) this.stopOff[e] = this.signals.edgeCtrl[e] >= 0 && net.eLen[e] > 15 ? 4.5 : 0.8;
    this.precomputeMovements();
    this.updateSignalDelays();
    this.stats = this.emptyStats();
    this.resetBusSchedule();
  }

  private emptyStats(): SimStats {
    return {
      time: this.time, vehicles: 0, byKind: [0, 0, 0, 0, 0], meanSpeed: 0, stoppedShare: 0, spawned: 0,
      arrived: 0, teleported: 0, noRoute: 0, avgTripMin: 0, avgDelayMin: 0, throughput: 0, co2Total: 0,
      co2Rate: 0, demandRate: 0, buses: 0, closed: 0,
    };
  }

  private precomputeMovements() {
    const net = this.net;
    const out = this.tmp;
    for (let m = 0; m < net.nMovs; m++) {
      const ei = net.mFrom[m];
      const eo = net.mTo[m];
      const li = (net.eLanes[ei] - 1) / 2;
      const lo = (net.eLanes[eo] - 1) / 2;
      net.pointAt(ei, net.eLen[ei], net.eOff0[ei] + li * net.eLaneW[ei], out, 0);
      const x0 = out[0];
      const z0 = out[2];
      net.pointAt(eo, 0, net.eOff0[eo] + lo * net.eLaneW[eo], out, 0);
      const x2 = out[0];
      const z2 = out[2];
      const d0x = net.eDirEnd[2 * ei];
      const d0z = net.eDirEnd[2 * ei + 1];
      const d2x = net.eDirStart[2 * eo];
      const d2z = net.eDirStart[2 * eo + 1];
      controlPoint(x0, z0, d0x, d0z, x2, z2, d2x, d2z, this.cp);
      const L = bezierLength(x0, z0, this.cp[0], this.cp[1], x2, z2);
      this.mLen[m] = L;
      const theta = Math.acos(Math.max(-1, Math.min(1, d0x * d2x + d0z * d2z)));
      const vLimit = Math.min(net.eSpeed[ei], net.eSpeed[eo]);
      if (net.mTurn[m] === TURN.U) this.mSpeed[m] = 3.5;
      else if (theta < 0.3) this.mSpeed[m] = vLimit;
      else {
        const R = L / theta;
        this.mSpeed[m] = Math.max(3.5, Math.min(vLimit, Math.sqrt(2.2 * R)));
      }
    }
  }

  updateSignalDelays() {
    const net = this.net;
    for (let e = 0; e < net.nEdges; e++) this.router.signalDelay[e] = this.signals.expectedDelay(e);
  }

  configure(c: Partial<SimConfig>) {
    const prev = this.cfg;
    this.cfg = { ...this.cfg, ...c };
    if (c.signalMode !== undefined || c.cycle !== undefined) {
      this.signals.setMode(this.cfg.signalMode, this.cfg.cycle);
      this.updateSignalDelays();
    }
    this.demand.multiplier = this.cfg.demand;
    this.router.zbe = this.cfg.zbe;
    if (c.zbe !== undefined && c.zbe !== prev.zbe) this.rerouteAll(() => true);
    if (c.buses === false) for (let v = 0; v < MAXV; v++) if (this.alive[v] && this.bus[v] >= 0) this.remove(v);
  }

  setTime(t: number) {
    const nt = ((t % 86400) + 86400) % 86400;
    // Los viajes en curso conservan su duración: se desplaza su hora de salida.
    const delta = nt - this.time;
    for (let v = 0; v < MAXV; v++) if (this.alive[v]) this.tStart[v] += delta;
    this.time = nt;
    this.tripEMA = 0;
    this.delayEMA = 0;
    this.arrivalsWindow.length = 0;
    this.resetBusSchedule();
  }

  setEvents(events: DemandEvent[]) {
    this.demand.events = events;
  }

  private resetBusSchedule() {
    this.busNext = this.busLines.map((l) => this.time + this.rand() * l.headway);
  }

  // ------------------------------------------------------------------ paso de simulación
  step(dt: number) {
    this.stepId++;
    this.signals.update(this.time, dt, this.probe);
    this.accelerations(dt);
    if ((this.stepId & 1) === 0) this.laneChanges();
    this.integrate(dt);
    this.spawnStep(dt);
    this.busStep();
    this.time += dt;
    if (this.time >= 86400) {
      this.time -= 86400;
      this.resetBusSchedule();
    }
    this.measure(dt);
  }

  // ¿Hay vehículos a menos de d metros del final del tramo e? (detectores semafóricos)
  private probe = (e: number, d: number): boolean => {
    const net = this.net;
    const base = net.laneBase[e];
    for (let l = 0; l < net.eLanes[e]; l++) {
      const list = this.lanes[base + l];
      if (list.length && net.eLen[e] - this.s[list[0]] < d) return true;
    }
    return false;
  };

  private v0(v: number, e: number) {
    return Math.min(this.vmax[v], this.net.eSpeed[e] * this.vfac[v]);
  }

  private idm(v: number, vel: number, v0: number, gap: number, dv: number): number {
    const a = this.amax[v];
    const b = this.bcomf[v];
    const sStar = this.s0[v] + Math.max(0, vel * this.T[v] + (vel * dv) / (2 * Math.sqrt(a * b)));
    const g = Math.max(gap, 0.05);
    const r = vel / Math.max(v0, 0.5);
    const r2 = r * r;
    const q = sStar / g;
    return a * (1 - r2 * r2 - q * q);
  }

  private freeAccel(v: number, vel: number, v0: number) {
    const r = vel / Math.max(v0, 0.5);
    const r2 = r * r;
    return this.amax[v] * (1 - r2 * r2);
  }

  private targetLane(m: number, k: number): number {
    const net = this.net;
    const nIn = net.eLanes[net.mFrom[m]];
    const nOut = net.eLanes[net.mTo[m]];
    const t = net.mTurn[m];
    if (t === TURN.R) return Math.max(0, Math.min(nOut - 1, nOut - nIn + k));
    return Math.min(k, nOut - 1);
  }

  private accelerations(dt: number) {
    for (let i = 0; i < this.activeLanes.length; i++) {
      const list = this.lanes[this.activeLanes[i]];
      for (let j = 0; j < list.length; j++) {
        const v = list[j];
        this.a[v] = this.accelOnLane(v, j > 0 ? list[j - 1] : -1, dt);
      }
    }
    for (let i = 0; i < this.activeConns.length; i++) {
      const list = this.conns[this.activeConns[i]];
      for (let j = 0; j < list.length; j++) {
        const v = list[j];
        this.a[v] = this.accelOnConn(v, j > 0 ? list[j - 1] : -1);
      }
    }
  }

  private accelOnLane(v: number, leader: number, dt: number): number {
    const net = this.net;
    const e = this.edge[v];
    const vel = this.v[v];
    const v0 = this.v0(v, e);
    let acc: number;
    if (leader >= 0) acc = this.idm(v, vel, v0, this.s[leader] - this.len[leader] - this.s[v], vel - this.v[leader]);
    else acc = this.frontAccel(v, e, vel, v0, dt);
    if (this.nextMov[v] < 0 && !(net.eFlags[e] & EDGE_FLAGS.GATEWAY_OUT)) {
      acc = Math.min(acc, this.idm(v, vel, v0, this.destS[v] + this.s0[v] + 0.5 - this.s[v], vel));
    }
    if (this.bus[v] >= 0) acc = Math.min(acc, this.busStopAccel(v, e, vel, v0));
    return acc < -9 ? -9 : acc;
  }

  private accelOnConn(v: number, leader: number): number {
    const net = this.net;
    const m = this.cmov[v];
    const vel = this.v[v];
    const to = net.mTo[m];
    const v0 = Math.min(this.mSpeed[m] * Math.min(1.15, this.vfac[v]), this.v0(v, to));
    let acc = this.freeAccel(v, vel, v0);
    if (leader >= 0) {
      acc = Math.min(acc, this.idm(v, vel, v0, this.s[leader] - this.len[leader] - this.s[v], vel - this.v[leader]));
      return acc < -9 ? -9 : acc;
    }
    const tl = this.ctl[v];
    const list = this.lanes[net.laneBase[to] + tl];
    const dist = this.cgeo[9 * v + 8] - this.s[v];
    if (list.length) {
      const w = list[list.length - 1];
      acc = Math.min(acc, this.idm(v, vel, v0, dist + this.s[w] - this.len[w], vel - this.v[w]));
      return acc < -9 ? -9 : acc;
    }
    acc = Math.min(acc, this.approach(vel, this.v0(v, to), dist));
    // Más allá del tramo de destino: siguiente cruce de la ruta.
    const route = this.route[v]!;
    const k = this.ri[v] + 1;
    if (k + 1 < route.length) {
      const m2 = net.movement(to, route[k + 1]);
      const d2 = dist + net.eLen[to];
      if (m2 >= 0) {
        const hs = this.signals.headState[to];
        if (hs === SIG.RED || (hs === SIG.AMBER && (vel * vel) / (2 * Math.max(d2 - 1, 0.1)) < 3.5)) {
          acc = Math.min(acc, this.idm(v, vel, v0, Math.max(0.05, d2 - this.stopOff[to]), vel));
        } else acc = this.scanAhead(v, vel, v0, acc, m2, tl, d2, k);
      }
    }
    return acc < -9 ? -9 : acc;
  }

  /** Deceleración necesaria para llegar a velocidad vt en d metros (Infinity si no hace falta). */
  private approach(vel: number, vt: number, d: number): number {
    if (vel <= vt) return Infinity;
    return Math.max(-5, (vt * vt - vel * vel) / (2 * Math.max(d, 1)));
  }

  /**
   * Recorre la ruta por delante (conexión → carril → conexión...) buscando el líder,
   * velocidades de giro, límites y semáforos en rojo. El vehículo está a `dist` m del
   * inicio de la conexión de la maniobra m (desde su carril `lane`); route[k] es su origen.
   * Imprescindible en nudos con tramos muy cortos (enlaces, cruces de doble calzada).
   */
  private scanAhead(v: number, vel: number, v0: number, acc: number, m: number, lane: number, dist: number, k: number): number {
    const net = this.net;
    const route = this.route[v]!;
    const look = Math.max(60, (vel * vel) / 2.5 + 25);
    const vf = Math.min(1.15, this.vfac[v]);
    for (let hop = 0; hop < 8; hop++) {
      acc = Math.min(acc, this.approach(vel, this.mSpeed[m] * vf, dist));
      const cl = this.conns[net.mConnBase[m] + lane];
      if (cl.length) {
        const w = cl[cl.length - 1];
        return Math.min(acc, this.idm(v, vel, v0, dist + this.s[w] - this.len[w], vel - this.v[w]));
      }
      const to = net.mTo[m];
      const tl = this.targetLane(m, lane);
      const list = this.lanes[net.laneBase[to] + tl];
      const clen = this.mLen[m];
      if (list.length) {
        const w = list[list.length - 1];
        return Math.min(acc, this.idm(v, vel, v0, dist + clen + this.s[w] - this.len[w], vel - this.v[w]));
      }
      acc = Math.min(acc, this.approach(vel, this.v0(v, to), dist + clen));
      dist += clen + net.eLen[to];
      if (dist > look || k + 2 >= route.length) return acc;
      const m2 = net.movement(to, route[k + 2]);
      if (m2 < 0) return acc;
      const hs = this.signals.headState[to];
      if (hs === SIG.RED || (hs === SIG.AMBER && (vel * vel) / (2 * Math.max(dist - 1, 0.1)) < 3.5)) {
        return Math.min(acc, this.idm(v, vel, v0, Math.max(0.05, dist - this.stopOff[to]), vel));
      }
      m = m2;
      lane = tl;
      k++;
    }
    return acc;
  }

  private frontAccel(v: number, e: number, vel: number, v0: number, dt: number): number {
    const net = this.net;
    const acc = this.freeAccel(v, vel, v0);
    const m = this.nextMov[v];
    if (m < 0) return acc;
    const dEnd = net.eLen[e] - this.s[v];
    if (this.admitted[v]) {
      // Reserva retenida sin poder avanzar: se libera para no bloquear el cruce.
      if (dEnd < 2 && vel < 0.1) {
        this.admWait[v] += dt;
        if (this.admWait[v] > 4) this.release(v);
      }
    }
    if (!this.admitted[v]) {
      const look = Math.max(30, (vel * vel) / 3 + 15);
      if (dEnd <= look) {
        const r = this.canEnter(v, e, m, dEnd, vel);
        const stop = this.stopOff[e];
        if (r === WAIT) {
          const need = (vel * vel) / (2 * Math.max(dEnd - stop, 0.05));
          // Demasiado cerca para frenar ante un conflicto de prioridad: se continúa.
          if (need > 7 && this.signals.headState[e] !== SIG.RED) this.admit(v, m);
          else return Math.min(acc, this.idm(v, vel, v0, Math.max(0.05, dEnd - stop), vel));
        } else if (r === COMMIT || dEnd < Math.max(4, vel * 2 + 2) + stop) {
          this.admit(v, m);
        }
      }
    }
    // Líder, velocidades de giro y semáforos más allá del cruce.
    return this.scanAhead(v, vel, v0, acc, m, this.lane[v], dEnd, this.ri[v]);
  }

  private effectiveType(node: number): number {
    const t = this.net.nodeType[node];
    if (t === NODE_TYPES.SIGNAL && this.signals.mode === 'off') return NODE_TYPES.PRIORITY;
    return t;
  }

  /** ¿Puede el vehículo v (en el tramo e) realizar la maniobra m? */
  private canEnter(v: number, e: number, m: number, dEnd: number, vel: number): number {
    const net = this.net;
    const node = net.mNode[m];
    const hs = this.signals.headState[e];
    if (hs === SIG.RED) return WAIT;
    if (hs === SIG.AMBER) {
      const need = (vel * vel) / (2 * Math.max(dEnd - this.stopOff[e], 0.1));
      if (need < 3.5) return WAIT;
      return COMMIT;
    }
    if (net.eYield[e] === 2 && !this.stopDone[v]) {
      if (dEnd < 3.5 && vel < 0.5) this.stopDone[v] = 1;
      else return WAIT;
    }
    // No bloquear el cruce: debe caber el vehículo entero a la salida. Solo importa si
    // hay maniobras en conflicto; dentro del anillo de una glorieta se sigue al de delante.
    const free = net.isPassThrough(node) || net.mConfStart[m + 1] === net.mConfStart[m];
    const ringFlow = net.isRing(e) && net.isRing(net.mTo[m]);
    if (!free && !ringFlow && !this.hasRoom(v, m)) return WAIT;
    if (free) return GO;
    // Conflictos con vehículos que ya ocupan o tienen reservado el cruce.
    const res = this.nodeRes[node];
    for (let i = 0; i < res.length; i++) {
      const o = res[i];
      if (o === v) continue;
      const mo = this.admMov[o];
      if (net.mFrom[mo] === e) continue;
      if (net.conflicts(m, mo)) return WAIT;
    }
    // Vehículos que se aproximan por otros accesos.
    const nt = this.effectiveType(node);
    const impatient = this.waitT[v];
    for (let k = net.nodeInStart[node], kend = net.nodeInStart[node + 1]; k < kend; k++) {
      const f = net.nodeIn[k];
      if (f === e) continue;
      if (this.signals.headState[f] === SIG.RED) continue;
      const base = net.laneBase[f];
      for (let l = 0; l < net.eLanes[f]; l++) {
        const list = this.lanes[base + l];
        if (!list.length) continue;
        const w = list[0];
        if (this.admitted[w]) continue;
        const mw = this.nextMov[w];
        if (mw < 0 || !net.conflicts(m, mw)) continue;
        const dW = net.eLen[f] - this.s[w];
        if (dW > 70) continue;
        const vw = this.v[w];
        // Un vehículo parado junto a su línea quiere salir ya (si tiene hueco a la salida);
        // si está bloqueado aguas abajo no cuenta como conflicto inminente.
        const etaW = vw < 1 && dW < 10 ? (this.hasRoom(w, mw) ? 0 : Infinity) : dW / Math.max(vw, 1);
        const pr = this.priority(nt, e, m, f, mw);
        if (pr > 0) {
          // En glorietas no se fuerza la entrada: el anillo siempre tiene preferencia.
          const ring = nt === NODE_TYPES.ROUNDABOUT && net.isRing(f) && !net.isRing(e);
          const need = (net.mTo[m] === net.mTo[mw] ? 3.0 : 3.8) * (ring ? 1 : Math.max(0.35, 1 - impatient / 45));
          if (etaW < need) {
            if (!ring && impatient > 6 && vw < 0.5 && this.waitT[w] > 2) continue;
            return WAIT;
          }
        } else if (pr === 0) {
          const vStopped = vel < 1 && dEnd < 10;
          if (etaW === 0 && vStopped) {
            // Ambos detenidos en su línea: pasa primero quien lleva más tiempo esperando.
            if (this.waitT[w] > this.waitT[v] + 0.5 || (Math.abs(this.waitT[w] - this.waitT[v]) <= 0.5 && w < v)) return WAIT;
            continue;
          }
          const etaV = vStopped ? 0 : dEnd / Math.max(vel, 1);
          if (etaW + 0.4 < etaV || (Math.abs(etaW - etaV) <= 0.4 && w < v)) {
            if (impatient > 5 && vw < 0.5 && this.waitT[w] > 2) continue;
            return WAIT;
          }
        }
      }
    }
    return GO;
  }

  /** Espacio libre (m) al inicio del carril L, descontando lo que ya circula hacia él por la conexión c. */
  private laneRoom(L: number, c: number, e: number): number {
    const list = this.lanes[L];
    let room = list.length ? this.s[list[list.length - 1]] - this.len[list[list.length - 1]] : this.net.eLen[e] + 30;
    if (c >= 0) for (const u of this.conns[c]) room -= this.len[u] + 2;
    return room;
  }

  /** ¿Cabe el vehículo v tras la maniobra m sin quedarse dentro del cruce? */
  hasRoom(v: number, m: number): boolean {
    const net = this.net;
    const to = net.mTo[m];
    const tl = this.targetLane(m, this.lane[v]);
    const L = net.laneBase[to] + tl;
    const list = this.lanes[L];
    const last = list.length ? list[list.length - 1] : -1;
    const need = this.len[v] + (net.isRing(to) ? 3 : 2);
    const room = this.laneRoom(L, net.mConnBase[m] + this.lane[v], to);
    // Incorporación en cremallera: tras esperar, basta con que la cola avance.
    const zipper = this.waitT[v] > 10 && room > 1 && last >= 0 && this.v[last] > 0.5;
    if (room >= need || zipper || (last >= 0 && this.v[last] > 4 && room > 0)) {
      // Tramo de destino muy corto (cruces con varios nudos): mira también el siguiente.
      if (net.eLen[to] >= need + 4) return true;
      const route = this.route[v]!;
      const k = this.ri[v] + 2;
      if (k >= route.length) return true;
      const m2 = net.movement(to, route[k]);
      if (m2 < 0) return true;
      const L2 = net.laneBase[route[k]] + this.targetLane(m2, tl);
      const list2 = this.lanes[L2];
      const last2 = list2.length ? list2[list2.length - 1] : -1;
      const room2 = this.laneRoom(L2, net.mConnBase[m2] + tl, route[k]) + Math.max(0, room - 1);
      return room2 >= need || (last2 >= 0 && this.v[last2] > 4);
    }
    return false;
  }

  /** +1 si el acceso f (maniobra mw) tiene prioridad sobre e (m), -1 al revés, 0 iguales. */
  private priority(nt: number, e: number, m: number, f: number, mw: number): number {
    const net = this.net;
    if (nt === NODE_TYPES.ROUNDABOUT) {
      const re = net.isRing(e);
      const rf = net.isRing(f);
      if (rf && !re) return 1;
      if (re && !rf) return -1;
    }
    if (nt !== NODE_TYPES.SIGNAL) {
      const ye = net.eYield[e] > 0;
      const yf = net.eYield[f] > 0;
      if (ye && !yf) return 1;
      if (yf && !ye) return -1;
      const dr = net.eRank[f] - net.eRank[e];
      if (dr >= 2) return 1;
      if (dr <= -2) return -1;
    }
    const dex = net.eDirEnd[2 * e];
    const dez = net.eDirEnd[2 * e + 1];
    const dfx = net.eDirEnd[2 * f];
    const dfz = net.eDirEnd[2 * f + 1];
    const dot = dex * dfx + dez * dfz;
    if (dot < -0.6 || nt === NODE_TYPES.SIGNAL) {
      const tm = net.mTurn[m];
      const tw = net.mTurn[mw];
      const le = tm === TURN.L || tm === TURN.U;
      const lf = tw === TURN.L || tw === TURN.U;
      if (le && !lf) return 1;
      if (lf && !le) return -1;
      return 0;
    }
    if (dot > 0.6) return 0;
    // Prioridad a la derecha (en x-este/z-sur, cruz < 0 indica que f viene por la derecha).
    return dex * dfz - dez * dfx < 0 ? 1 : -1;
  }

  private admit(v: number, m: number) {
    if (this.admitted[v]) return;
    this.admitted[v] = 1;
    this.admMov[v] = m;
    this.admWait[v] = 0;
    this.nodeRes[this.net.mNode[m]].push(v);
  }

  private release(v: number) {
    if (!this.admitted[v]) return;
    this.admitted[v] = 0;
    const res = this.nodeRes[this.net.mNode[this.admMov[v]]];
    const i = res.indexOf(v);
    if (i >= 0) res.splice(i, 1);
  }

  private busStopAccel(v: number, e: number, vel: number, v0: number): number {
    const line = this.busLines[this.bus[v]];
    const k = this.busStop[v];
    if (!line || k >= line.stops.length || this.dwell[v] > 0) return this.dwell[v] > 0 ? -9 : Infinity;
    const [ri, sStop] = line.stops[k];
    if (ri < this.ri[v]) {
      this.busStop[v]++;
      return Infinity;
    }
    if (ri !== this.ri[v]) return Infinity;
    const stopS = Math.min(sStop, this.net.eLen[e] - 1);
    const d = stopS - this.s[v];
    if (d < -3) {
      this.busStop[v]++;
      return Infinity;
    }
    if (d < 1.5 && vel < 0.4) {
      this.dwell[v] = 12 + this.rand() * 18;
      return -9;
    }
    return this.idm(v, vel, v0, d + this.s0[v] + 0.3, vel);
  }

  // ------------------------------------------------------------------ cambios de carril
  private neighbors(L: number, sv: number, exclude: number, out: Int32Array) {
    const list = this.lanes[L];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.s[list[mid]] > sv) lo = mid + 1;
      else hi = mid;
    }
    let ld = lo > 0 ? list[lo - 1] : -1;
    let fl = lo < list.length ? list[lo] : -1;
    if (fl === exclude) fl = lo + 1 < list.length ? list[lo + 1] : -1;
    if (ld === exclude) ld = lo - 2 >= 0 ? list[lo - 2] : -1;
    out[0] = ld;
    out[1] = fl;
  }

  private nb = new Int32Array(2);

  private laneChanges() {
    const net = this.net;
    const cand = this.lcList;
    cand.length = 0;
    for (let i = 0; i < this.activeLanes.length; i++) {
      const L = this.activeLanes[i];
      const list = this.lanes[L];
      if (!list.length) continue;
      const e = this.edge[list[0]];
      if (net.eLanes[e] < 2) continue;
      for (let j = 0; j < list.length; j++) {
        const v = list[j];
        if (this.lcCool[v] > 0 || this.admitted[v]) continue;
        cand.push(v);
      }
    }
    for (const v of cand) {
      if (!this.alive[v] || this.edge[v] < 0) continue;
      const t = this.chooseLane(v);
      if (t >= 0) this.changeLane(v, t);
      else this.lcCool[v] = 0.6 + this.rand() * 0.8;
    }
  }

  private chooseLane(v: number): number {
    const net = this.net;
    const e = this.edge[v];
    const n = net.eLanes[e];
    const cur = this.lane[v];
    const sv = this.s[v];
    const dEnd = net.eLen[e] - sv;
    if (dEnd < 5 || sv < 3) return -1;
    const m = this.nextMov[v];
    let lo = 0;
    let hi = n - 1;
    if (m >= 0 && dEnd < 220) {
      const t = net.mTurn[m];
      if (t === TURN.R) lo = n - 1;
      else if (t === TURN.L || t === TURN.U) hi = 0;
    }
    if (m < 0 && !(net.eFlags[e] & EDGE_FLAGS.GATEWAY_OUT) && this.destS[v] - sv < 150) lo = n - 1;
    if (this.bus[v] >= 0) {
      const line = this.busLines[this.bus[v]];
      const st = line?.stops[this.busStop[v]];
      if (st && st[0] === this.ri[v] && st[1] - sv < 160) lo = n - 1;
    }
    const mandatory = cur < lo || cur > hi;
    if (!mandatory && dEnd < 35) return -1;
    const L0 = net.laneBase[e];
    const vel = this.v[v];
    const v0 = this.v0(v, e);
    const aCur = this.a[v];
    let best = -1;
    let bestGain = 0.45;
    for (const t of mandatory ? [cur < lo ? cur + 1 : cur - 1] : [cur - 1, cur + 1]) {
      if (t < 0 || t >= n || (!mandatory && (t < lo || t > hi))) continue;
      this.neighbors(L0 + t, sv, v, this.nb);
      const ld = this.nb[0];
      const fl = this.nb[1];
      const minGap = mandatory ? 0.8 : 2.0;
      if (ld >= 0 && this.s[ld] - this.len[ld] - sv < minGap) continue;
      if (fl >= 0) {
        const gapB = sv - this.len[v] - this.s[fl];
        if (gapB < minGap) continue;
        const af = this.idm(fl, this.v[fl], this.v0(fl, e), gapB, this.v[fl] - vel);
        if (af < (mandatory ? -5 : -2.5)) continue;
      }
      if (mandatory) return t;
      let aNew: number;
      if (ld >= 0) aNew = this.idm(v, vel, v0, this.s[ld] - this.len[ld] - sv, vel - this.v[ld]);
      else aNew = dEnd < 90 ? aCur : this.freeAccel(v, vel, v0);
      const gain = aNew - aCur + (t > cur ? 0.12 : -0.12);
      if (gain > bestGain) {
        bestGain = gain;
        best = t;
      }
    }
    return best;
  }

  private changeLane(v: number, t: number) {
    const net = this.net;
    const e = this.edge[v];
    const cur = this.lane[v];
    this.removeFromLane(net.laneBase[e] + cur, v);
    this.lane[v] = t;
    this.insertLane(net.laneBase[e] + t, v);
    this.latOff[v] += (cur - t) * net.eLaneW[e];
    this.lcCool[v] = 3 + this.rand() * 3;
  }

  // ------------------------------------------------------------------ integración
  private move(v: number, dt: number) {
    if (this.dwell[v] > 0) {
      this.dwell[v] -= dt;
      this.v[v] = 0;
      if (this.dwell[v] <= 0) {
        this.dwell[v] = 0;
        this.busStop[v]++;
      }
      return;
    }
    const a = this.a[v];
    const vel = this.v[v];
    const vn = vel + a * dt;
    let ds: number;
    if (vn < 0) {
      ds = a < 0 ? (-0.5 * vel * vel) / a : 0;
      this.v[v] = 0;
    } else {
      ds = vel * dt + 0.5 * a * dt * dt;
      this.v[v] = vn;
    }
    this.s[v] += ds;
    if (this.v[v] < 0.3) {
      this.stuckT[v] += dt;
      this.waitT[v] += dt;
    } else {
      this.stuckT[v] = 0;
      if (this.v[v] > 3) this.waitT[v] = 0;
    }
    if (this.lcCool[v] > 0) this.lcCool[v] -= dt;
    const lo = this.latOff[v];
    if (lo !== 0) {
      const step = 1.3 * dt;
      this.latOff[v] = Math.abs(lo) <= step ? 0 : lo - Math.sign(lo) * step;
    }
    // CO₂ instantáneo: potencia en rueda (inercia + rodadura + aerodinámica).
    const k = KP[this.kind[v]];
    const sp = this.v[v];
    const P = k.mass * (Math.max(0, a) + 0.098) * sp + 0.6 * k.cda * sp * sp * sp;
    this.co2Window += (k.idle + 0.00028 * Math.max(0, P)) * dt;
  }

  private integrate(dt: number) {
    const net = this.net;
    const pending = this.pending;
    pending.length = 0;
    for (let i = 0; i < this.activeLanes.length; i++) {
      const list = this.lanes[this.activeLanes[i]];
      for (let j = 0; j < list.length; j++) {
        const v = list[j];
        const before = this.s[v];
        this.move(v, dt);
        if (j > 0) {
          const ld = list[j - 1];
          const maxS = this.s[ld] - this.len[ld] - 0.2;
          if (this.s[v] > maxS) {
            this.s[v] = Math.max(before, maxS);
            if (this.v[v] > this.v[ld]) this.v[v] = this.v[ld];
          }
        }
        const e = this.edge[v];
        if (this.nextMov[v] < 0) {
          if (net.eFlags[e] & EDGE_FLAGS.GATEWAY_OUT) {
            if (this.s[v] >= net.eLen[e]) pending.push(v);
          } else if (this.s[v] >= this.destS[v] - 0.5 || (this.v[v] < 0.3 && this.s[v] > this.destS[v] - 5)) pending.push(v);
          else if (this.s[v] > net.eLen[e] - 0.05) this.s[v] = net.eLen[e] - 0.05;
        } else if (this.s[v] >= net.eLen[e]) pending.push(v);
      }
    }
    for (let i = 0; i < this.activeConns.length; i++) {
      const list = this.conns[this.activeConns[i]];
      for (let j = 0; j < list.length; j++) {
        const v = list[j];
        const before = this.s[v];
        this.move(v, dt);
        if (j > 0) {
          const ld = list[j - 1];
          const maxS = this.s[ld] - this.len[ld] - 0.2;
          if (this.s[v] > maxS) {
            this.s[v] = Math.max(before, maxS);
            if (this.v[v] > this.v[ld]) this.v[v] = this.v[ld];
          }
        }
        if (this.s[v] >= this.cgeo[9 * v + 8]) pending.push(v);
      }
    }
    for (let i = 0; i < pending.length; i++) this.advance(pending[i]);
    this.pruneActive();
  }

  private advance(v: number) {
    const net = this.net;
    for (let guard = 0; guard < 4 && this.alive[v]; guard++) {
      const e = this.edge[v];
      if (e >= 0) {
        if (this.nextMov[v] < 0) {
          const out = (net.eFlags[e] & EDGE_FLAGS.GATEWAY_OUT) !== 0;
          if (out ? this.s[v] >= net.eLen[e] : this.s[v] >= this.destS[v] - 5) this.arrive(v);
          return;
        }
        if (this.s[v] < net.eLen[e]) return;
        // Nunca se solapa con el último vehículo de la conexión: espera en la línea.
        const cl = this.conns[net.mConnBase[this.nextMov[v]] + this.lane[v]];
        if (cl.length) {
          const w = cl[cl.length - 1];
          const tail = this.s[w] - this.len[w];
          if (tail < 0.2) {
            this.s[v] = net.eLen[e] - 0.01;
            if (this.v[v] > this.v[w]) this.v[v] = this.v[w];
            return;
          }
          if (this.s[v] - net.eLen[e] > tail - 0.2) this.s[v] = net.eLen[e] + tail - 0.2;
        }
        this.enterConnector(v);
      } else {
        const clen = this.cgeo[9 * v + 8];
        if (this.s[v] < clen) return;
        const list = this.lanes[net.laneBase[net.mTo[this.cmov[v]]] + this.ctl[v]];
        if (list.length) {
          const w = list[list.length - 1];
          const tail = this.s[w] - this.len[w];
          if (tail < 0.2) {
            this.s[v] = clen - 0.01;
            if (this.v[v] > this.v[w]) this.v[v] = this.v[w];
            return;
          }
          if (this.s[v] - clen > tail - 0.2) this.s[v] = clen + tail - 0.2;
        }
        this.exitConnector(v);
      }
    }
  }

  private enterConnector(v: number) {
    const net = this.net;
    const e = this.edge[v];
    const m = this.nextMov[v];
    const lane = this.lane[v];
    if (!this.admitted[v]) this.admit(v, m);
    this.removeFromLane(net.laneBase[e] + lane, v);
    const to = net.mTo[m];
    const tl = this.targetLane(m, lane);
    const out = this.tmp;
    net.pointAt(e, net.eLen[e], net.laneOffset(e, lane) + this.latOff[v], out, 0);
    const x0 = out[0];
    const y0 = out[1];
    const z0 = out[2];
    net.pointAt(to, 0, net.laneOffset(to, tl), out, 0);
    const x2 = out[0];
    const y2 = out[1];
    const z2 = out[2];
    controlPoint(x0, z0, net.eDirEnd[2 * e], net.eDirEnd[2 * e + 1], x2, z2, net.eDirStart[2 * to], net.eDirStart[2 * to + 1], this.cp);
    const g = 9 * v;
    const c = this.cgeo;
    c[g] = x0;
    c[g + 1] = z0;
    c[g + 2] = this.cp[0];
    c[g + 3] = this.cp[1];
    c[g + 4] = x2;
    c[g + 5] = z2;
    c[g + 6] = y0;
    c[g + 7] = y2;
    c[g + 8] = bezierLength(x0, z0, this.cp[0], this.cp[1], x2, z2);
    this.s[v] = Math.max(0, this.s[v] - net.eLen[e]);
    this.edge[v] = -1;
    this.cmov[v] = m;
    this.ctl[v] = tl;
    const cid = net.mConnBase[m] + lane;
    this.conn[v] = cid;
    this.conns[cid].push(v);
    if (!this.connActive[cid]) {
      this.connActive[cid] = 1;
      this.activeConns.push(cid);
    }
    this.latOff[v] = 0;
    this.stopDone[v] = 0;
  }

  private exitConnector(v: number) {
    const net = this.net;
    const m = this.cmov[v];
    const to = net.mTo[m];
    const list = this.conns[this.conn[v]];
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    this.release(v);
    this.s[v] = Math.max(0, this.s[v] - this.cgeo[9 * v + 8]);
    this.edge[v] = to;
    this.lane[v] = this.ctl[v];
    this.conn[v] = -1;
    this.ri[v]++;
    const route = this.route[v]!;
    this.nextMov[v] = this.ri[v] + 1 < route.length ? net.movement(to, route[this.ri[v] + 1]) : -1;
    this.seg[v] = -1;
    this.insertLane(net.laneBase[to] + this.lane[v], v);
  }

  private insertLane(L: number, v: number) {
    const list = this.lanes[L];
    const sv = this.s[v];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.s[list[mid]] >= sv) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, v);
    if (!this.laneActive[L]) {
      this.laneActive[L] = 1;
      this.activeLanes.push(L);
    }
  }

  private removeFromLane(L: number, v: number) {
    const list = this.lanes[L];
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
  }

  private pruneActive() {
    let w = 0;
    for (let i = 0; i < this.activeLanes.length; i++) {
      const L = this.activeLanes[i];
      if (this.lanes[L].length) this.activeLanes[w++] = L;
      else this.laneActive[L] = 0;
    }
    this.activeLanes.length = w;
    w = 0;
    for (let i = 0; i < this.activeConns.length; i++) {
      const C = this.activeConns[i];
      if (this.conns[C].length) this.activeConns[w++] = C;
      else this.connActive[C] = 0;
    }
    this.activeConns.length = w;
  }

  // ------------------------------------------------------------------ altas y bajas
  private spaceAt(L: number, s: number, len: number): boolean {
    this.neighbors(L, s, -1, this.nb);
    const ld = this.nb[0];
    const fl = this.nb[1];
    if (ld >= 0 && this.s[ld] - this.len[ld] - s < 3) return false;
    if (fl >= 0 && s - len - this.s[fl] < 5 + this.v[fl] * 1.2) return false;
    return true;
  }

  spawn(trip: Trip, kind = trip.kind, busLine = -1): number {
    if (!this.freeSlots.length) return -1;
    const net = this.net;
    const o = trip.o;
    if (this.router.closed[o]) return -1;
    let route: Int32Array | null;
    if (busLine >= 0) route = Int32Array.from(this.busLines[busLine].edges);
    else {
      const zoneTrip = this.cfg.zbe && ((net.eFlags[o] | net.eFlags[trip.d]) & EDGE_FLAGS.ZONE) !== 0;
      route = this.router.route(o, trip.d, !zoneTrip);
    }
    if (!route) {
      this.stats.noRoute++;
      return -1;
    }
    const p = KP[kind];
    const r = this.rand;
    const len = p.len * (0.92 + r() * 0.16);
    const fromGate = net.isGatewayIn(o) || busLine >= 0;
    const nl = net.eLanes[o];
    // Los vehículos que salen de un aparcamiento lo hacen lejos de los extremos del tramo
    // (no aparecen sobre la salida de un cruce).
    const Lo = net.eLen[o];
    let s = fromGate ? 0 : Lo < 50 ? Lo * 0.5 : 20 + r() * (Lo - 35);
    if (s < len) s = Math.min(Lo, len + 0.5);
    let lane = -1;
    const order = fromGate ? Array.from({ length: nl }, (_, i) => nl - 1 - i) : [nl - 1];
    for (const l of order) {
      if (this.spaceAt(net.laneBase[o] + l, s, len)) {
        lane = l;
        break;
      }
    }
    if (lane < 0) return -1;
    const v = this.freeSlots.pop()!;
    this.alive[v] = 1;
    this.count++;
    this.kind[v] = kind;
    this.len[v] = len;
    this.amax[v] = p.amax * (0.85 + r() * 0.3);
    this.bcomf[v] = p.b * (0.9 + r() * 0.2);
    this.T[v] = p.T * (0.85 + r() * 0.35);
    this.s0[v] = p.s0 * (0.9 + r() * 0.2);
    // Velocidad deseada respecto al límite (en la ciudad muchos conductores lo superan).
    this.vfac[v] = kind === KIND.BUS ? 0.95 : 0.93 + r() * 0.22 + (kind === KIND.MOTO ? 0.05 : 0);
    this.vmax[v] = p.vmax;
    this.edge[v] = o;
    this.lane[v] = lane;
    this.s[v] = s;
    this.conn[v] = -1;
    this.seg[v] = -1;
    this.route[v] = route;
    this.ri[v] = 0;
    this.nextMov[v] = route.length > 1 ? net.movement(route[0], route[1]) : -1;
    const d = route[route.length - 1];
    if (net.isGatewayOut(d) || busLine >= 0) this.destS[v] = net.eLen[d];
    else if (route.length === 1) this.destS[v] = Math.min(net.eLen[d], s + 30);
    else this.destS[v] = (0.25 + r() * 0.6) * net.eLen[d];
    this.latOff[v] = 0;
    this.admitted[v] = 0;
    this.waitT[v] = 0;
    this.stuckT[v] = 0;
    this.stopDone[v] = 0;
    this.lcCool[v] = r() * 2;
    this.tStart[v] = this.time;
    this.through[v] = trip.through ? 1 : 0;
    this.inZone[v] = ((net.eFlags[o] | net.eFlags[d]) & EDGE_FLAGS.ZONE) !== 0 ? 1 : 0;
    this.bus[v] = busLine;
    this.busStop[v] = 0;
    this.dwell[v] = 0;
    this.origin[v] = o;
    let ff = 0;
    for (let i = 0; i < route.length; i++) ff += net.eLen[route[i]] / net.eSpeed[route[i]];
    this.freeT[v] = ff;
    this.color[v] = this.pickColor(kind, busLine);
    if (fromGate) {
      this.neighbors(net.laneBase[o] + lane, s, -1, this.nb);
      const ld = this.nb[0];
      const vlim = this.v0(v, o) * 0.8;
      this.v[v] = ld >= 0 ? Math.min(vlim, this.v[ld]) : vlim;
    } else this.v[v] = 0;
    this.a[v] = 0;
    this.insertLane(net.laneBase[o] + lane, v);
    this.stats.spawned++;
    return v;
  }

  private pickColor(kind: number, busLine: number): number {
    if (busLine >= 0) return 32 + (busLine % 16);
    const r = this.rand();
    if (kind === KIND.VAN) return r < 0.7 ? 0 : r < 0.85 ? 1 : 6;
    if (kind === KIND.TRUCK) return r < 0.5 ? 0 : r < 0.7 ? 5 : r < 0.85 ? 4 : 9;
    // Distribución típica del parque: blanco, gris, negro, plata, azul, rojo...
    const cum = [0.25, 0.42, 0.56, 0.68, 0.78, 0.86, 0.9, 0.93, 0.96, 0.98, 1];
    for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i;
    return 0;
  }

  private remove(v: number) {
    if (!this.alive[v]) return;
    const net = this.net;
    this.release(v);
    if (this.edge[v] >= 0) this.removeFromLane(net.laneBase[this.edge[v]] + this.lane[v], v);
    else if (this.conn[v] >= 0) {
      const list = this.conns[this.conn[v]];
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
    }
    this.alive[v] = 0;
    this.route[v] = null;
    this.bus[v] = -1;
    this.count--;
    this.freeSlots.push(v);
  }

  private arrive(v: number) {
    const trip = (this.time - this.tStart[v]) / 60;
    if (this.bus[v] < 0 && trip > 0) {
      const a = 0.03;
      this.tripEMA = this.tripEMA ? this.tripEMA * (1 - a) + trip * a : trip;
      const delay = Math.max(0, trip - this.freeT[v] / 60);
      this.delayEMA = this.delayEMA ? this.delayEMA * (1 - a) + delay * a : delay;
    }
    this.arrivalsWindow.push(this.time);
    this.stats.arrived++;
    this.remove(v);
  }

  private spawnStep(dt: number) {
    if (this.count >= this.cfg.maxVehicles) return;
    const t = this.time;
    const r = this.demand.rates(t);
    const A = this.acc;
    A.internal = Math.min(40, A.internal + r.internal * dt);
    A.inbound = Math.min(40, A.inbound + r.inbound * dt);
    A.outbound = Math.min(40, A.outbound + r.outbound * dt);
    A.through = Math.min(40, A.through + r.through * dt);
    this.stats.demandRate = (r.internal + r.inbound + r.outbound + r.through) * 3600;
    let budget = 30;
    const tryTrip = (trip: Trip | null) => {
      if (!trip) return;
      // Con ZBE, parte de los viajes con origen o destino en el centro cambia de modo.
      if (this.cfg.zbe && ((this.net.eFlags[trip.o] | this.net.eFlags[trip.d]) & EDGE_FLAGS.ZONE) && this.rand() < 0.35) return;
      this.spawn(trip);
    };
    while (A.internal >= 1 && budget-- > 0) {
      A.internal--;
      tryTrip(this.demand.internalTrip(t));
    }
    while (A.inbound >= 1 && budget-- > 0) {
      A.inbound--;
      tryTrip(this.demand.inboundTrip());
    }
    while (A.outbound >= 1 && budget-- > 0) {
      A.outbound--;
      tryTrip(this.demand.outboundTrip());
    }
    while (A.through >= 1 && budget-- > 0) {
      A.through--;
      tryTrip(this.demand.throughTrip());
    }
    for (const ev of this.demand.events) {
      const k = (this.eventAcc.get(ev.id) ?? 0) + this.demand.eventRate(ev, t) * dt;
      let n = Math.floor(k);
      this.eventAcc.set(ev.id, k - n);
      while (n-- > 0 && budget-- > 0) tryTrip(this.demand.eventTrip(ev));
    }
  }

  private busStep() {
    if (!this.cfg.buses) return;
    const h = this.time / 3600;
    if (h < 6.5 || h > 23) return;
    for (let i = 0; i < this.busLines.length; i++) {
      if (this.time < this.busNext[i]) continue;
      const line = this.busLines[i];
      this.busNext[i] = this.time + line.headway * (0.9 + this.rand() * 0.2);
      this.spawn({ o: line.edges[0], d: line.edges[line.edges.length - 1], kind: KIND.BUS, through: false }, KIND.BUS, i);
    }
  }

  // ------------------------------------------------------------------ medidas y rutas
  private measure(dt: number) {
    const net = this.net;
    this.measureT += dt;
    this.heatT += dt;
    this.rerouteT += dt;
    if (this.heatT >= 2) {
      this.heatT = 0;
      this.edgeSum.fill(0);
      this.edgeCnt.fill(0);
      for (const L of this.activeLanes) {
        const list = this.lanes[L];
        if (!list.length) continue;
        const e = this.edge[list[0]];
        for (const v of list) {
          this.edgeSum[e] += this.v[v];
          this.edgeCnt[e]++;
        }
      }
      const est = this.router.speedEst;
      for (let e = 0; e < net.nEdges; e++) {
        const free = net.eSpeed[e];
        if (this.edgeCnt[e]) {
          const mean = this.edgeSum[e] / this.edgeCnt[e];
          est[e] = est[e] * 0.75 + Math.max(0.8, mean) * 0.25;
          this.heat[e] = Math.min(254, Math.round((mean / free) * 200));
        } else {
          est[e] += (free * 0.85 - est[e]) * 0.08;
          this.heat[e] = 255;
        }
      }
      this.heatVersion++;
    }
    if (this.measureT >= 1) {
      const st = this.stats;
      st.time = this.time;
      st.vehicles = this.count;
      st.byKind = [0, 0, 0, 0, 0];
      let sum = 0;
      let stopped = 0;
      for (let v = 0; v < MAXV; v++) {
        if (!this.alive[v]) continue;
        st.byKind[this.kind[v]]++;
        sum += this.v[v];
        if (this.v[v] < 0.5) stopped++;
        // Vehículos atascados demasiado tiempo se retiran (como el "teleport" de SUMO);
        // dentro de un cruce el margen es menor para deshacer bloqueos circulares.
        if (this.stuckT[v] > (this.edge[v] < 0 ? 90 : 300)) {
          this.remove(v);
          st.teleported++;
        }
      }
      st.meanSpeed = this.count ? (sum / this.count) * 3.6 : 0;
      st.stoppedShare = this.count ? stopped / this.count : 0;
      st.avgTripMin = this.tripEMA;
      st.avgDelayMin = this.delayEMA;
      while (this.arrivalsWindow.length && this.arrivalsWindow[0] < this.time - 600) this.arrivalsWindow.shift();
      if (this.arrivalsWindow.length && this.arrivalsWindow[0] > this.time) this.arrivalsWindow.length = 0;
      st.throughput = this.arrivalsWindow.length * 6;
      st.co2Total += this.co2Window;
      const rate = (this.co2Window / this.measureT) * 3.6; // kg/h
      this.co2RateEMA = this.co2RateEMA ? this.co2RateEMA * 0.9 + rate * 0.1 : rate;
      st.co2Rate = this.co2RateEMA;
      this.co2Window = 0;
      st.buses = st.byKind[KIND.BUS];
      this.measureT = 0;
    }
    if (this.cfg.rerouting && this.rerouteT >= 30) {
      this.rerouteT = 0;
      // Reencaminamiento dinámico: parte de los vehículos detenidos busca alternativa.
      this.rerouteAll((v) => this.waitT[v] > 40 && this.rand() < 0.35, 0.12, 80);
    }
  }

  private rerouteAll(filter: (v: number) => boolean, improvement = 0, limit = Infinity) {
    const net = this.net;
    let done = 0;
    for (let v = 0; v < MAXV && done < limit; v++) {
      if (!this.alive[v] || this.bus[v] >= 0 || !filter(v)) continue;
      done++;
      const route = this.route[v]!;
      const cur = this.edge[v] >= 0 ? this.edge[v] : net.mTo[this.cmov[v]];
      const curIdx = this.edge[v] >= 0 ? this.ri[v] : this.ri[v] + 1;
      const dest = route[route.length - 1];
      const zoneTrip = this.cfg.zbe && this.inZone[v] === 1;
      const nr = this.router.route(cur, dest, !zoneTrip);
      if (!nr) continue;
      if (improvement > 0) {
        const oldT = this.router.routeTime(route, curIdx);
        const newT = this.router.routeTime(nr, 0);
        if (newT > oldT * (1 - improvement)) continue;
      }
      const merged = new Int32Array(curIdx + nr.length);
      merged.set(route.subarray(0, curIdx), 0);
      merged.set(nr, curIdx);
      this.route[v] = merged;
      if (this.edge[v] >= 0) {
        this.nextMov[v] = this.ri[v] + 1 < merged.length ? net.movement(merged[this.ri[v]], merged[this.ri[v] + 1]) : -1;
        if (this.admitted[v] && this.admMov[v] !== this.nextMov[v]) this.release(v);
      }
    }
  }

  setClosed(edges: number[], closed: boolean) {
    for (const e of edges) this.router.closed[e] = closed ? 1 : 0;
    let n = 0;
    for (let e = 0; e < this.net.nEdges; e++) n += this.router.closed[e];
    this.stats.closed = n;
    const closedArr = this.router.closed;
    this.rerouteAll((v) => {
      const r = this.route[v]!;
      for (let i = this.ri[v] + 1; i < r.length; i++) if (closedArr[r[i]]) return true;
      return false;
    });
  }

  clearVehicles() {
    for (let v = 0; v < MAXV; v++) if (this.alive[v]) this.remove(v);
    for (const res of this.nodeRes) res.length = 0;
    this.stats = this.emptyStats();
    this.tripEMA = this.delayEMA = 0;
    this.arrivalsWindow.length = 0;
    this.acc = { internal: 0, inbound: 0, outbound: 0, through: 0 };
    this.resetBusSchedule();
  }

  /** Precarga la red con viajes en curso para no empezar vacía. */
  warmup(seconds: number, dt = 0.25) {
    for (let t = 0; t < seconds; t += dt) this.step(dt);
  }

  // ------------------------------------------------------------------ salida para el render
  /** Escribe [id, x, y, z, rumbo, tipo, color, banderas] por vehículo. Devuelve el número. */
  writeFrame(buf: Float32Array): number {
    const net = this.net;
    const out = this.tmp;
    let n = 0;
    for (let v = 0; v < MAXV; v++) {
      if (!this.alive[v]) continue;
      const o = n * FRAME_STRIDE;
      if (o + FRAME_STRIDE > buf.length) break;
      let flags = 0;
      const e = this.edge[v];
      if (e >= 0) {
        this.seg[v] = net.pointAt(e, Math.min(this.s[v], net.eLen[e]), net.laneOffset(e, this.lane[v]) + this.latOff[v], out, 0, this.seg[v]);
        if (net.eFlags[e] & EDGE_FLAGS.TUNNEL) flags |= 2;
        buf[o + 1] = out[0];
        buf[o + 2] = out[1];
        buf[o + 3] = out[2];
        buf[o + 4] = out[3];
      } else {
        const g = 9 * v;
        const c = this.cgeo;
        const t = Math.min(1, this.s[v] / c[g + 8]);
        const u = 1 - t;
        buf[o + 1] = u * u * c[g] + 2 * u * t * c[g + 2] + t * t * c[g + 4];
        buf[o + 2] = c[g + 6] + (c[g + 7] - c[g + 6]) * t;
        buf[o + 3] = u * u * c[g + 1] + 2 * u * t * c[g + 3] + t * t * c[g + 5];
        const dx = 2 * u * (c[g + 2] - c[g]) + 2 * t * (c[g + 4] - c[g + 2]);
        const dz = 2 * u * (c[g + 3] - c[g + 1]) + 2 * t * (c[g + 5] - c[g + 3]);
        buf[o + 4] = Math.atan2(dz, dx);
      }
      if (this.a[v] < -1.2 || this.v[v] < 0.2) flags |= 1;
      if (this.dwell[v] > 0) flags |= 4;
      buf[o] = v;
      buf[o + 5] = this.kind[v];
      buf[o + 6] = this.color[v];
      buf[o + 7] = flags;
      n++;
    }
    return n;
  }

  vehicleInfo(v: number): VehicleInfo | null {
    if (v < 0 || v >= MAXV || !this.alive[v]) return null;
    const net = this.net;
    const route = this.route[v]!;
    const cur = this.edge[v] >= 0 ? this.edge[v] : net.mTo[this.cmov[v]];
    let remaining = this.edge[v] >= 0 ? net.eLen[cur] - this.s[v] : net.eLen[cur];
    const start = this.edge[v] >= 0 ? this.ri[v] + 1 : this.ri[v] + 2;
    for (let i = start; i < route.length; i++) remaining += net.eLen[route[i]];
    const dest = route[route.length - 1];
    const eta = this.router.routeTime(route, Math.min(route.length - 1, this.ri[v] + 1));
    const nameOr = (e: number) => net.edgeName(e) || (net.isGatewayIn(e) || net.isGatewayOut(e) ? 'Acceso exterior' : 'Calle sin nombre');
    const line = this.bus[v] >= 0 ? this.busLines[this.bus[v]] : null;
    return {
      id: v,
      kind: this.kind[v],
      speed: this.v[v] * 3.6,
      street: nameOr(cur),
      origin: nameOr(this.origin[v]),
      dest: nameOr(dest),
      remainingKm: remaining / 1000,
      etaMin: eta / 60,
      tripMin: (this.time - this.tStart[v]) / 60,
      waiting: this.waitT[v],
      route: Array.from(route.subarray(Math.max(0, this.ri[v]), Math.min(route.length, this.ri[v] + 600))),
      line: line ? `${line.ref} · ${line.name}` : null,
      through: this.through[v] === 1,
    };
  }

  edgeVehicles(e: number): { count: number; mean: number } {
    const net = this.net;
    let count = 0;
    let sum = 0;
    for (let l = 0; l < net.eLanes[e]; l++) {
      for (const v of this.lanes[net.laneBase[e] + l]) {
        count++;
        sum += this.v[v];
      }
    }
    return { count, mean: count ? (sum / count) * 3.6 : 0 };
  }
}
