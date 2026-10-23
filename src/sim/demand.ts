// Modelo de demanda: viajes origen-destino según la hora del día.
import type { Network } from './network';
import { EDGE_FLAGS, KIND } from './types';

/**
 * Reparto horario de los viajes diarios (%), día laborable en una ciudad media española:
 * punta de mañana (8 h), punta de mediodía por el horario partido (13-14 h) y punta de tarde (19 h).
 */
export const HOURLY = [
  0.9, 0.5, 0.35, 0.3, 0.35, 0.8, 2.1, 5.0, 6.9, 6.3, 5.5, 5.5,
  5.9, 6.7, 6.8, 5.5, 5.3, 5.9, 6.7, 6.9, 6.0, 3.9, 2.4, 1.6,
];
const HOURLY_SUM = HOURLY.reduce((a, b) => a + b, 0);

/** Proporción de viajes que salen de casa (generación) frente a los que vuelven (atracción). */
const HOME_SHARE = [
  0.4, 0.4, 0.4, 0.5, 0.6, 0.75, 0.8, 0.82, 0.8, 0.65, 0.55, 0.5,
  0.45, 0.32, 0.4, 0.62, 0.55, 0.42, 0.35, 0.33, 0.4, 0.35, 0.3, 0.35,
];

/** Fracción horaria (0..1 del total diario por hora) interpolada de forma continua. */
export function hourlyFraction(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const x = h - 0.5;
  const i0 = Math.floor(x);
  const t = x - i0;
  const a = HOURLY[(i0 + 24) % 24];
  const b = HOURLY[(i0 + 25) % 24];
  return (a + (b - a) * t) / HOURLY_SUM;
}

export class Sampler {
  private cum: Float64Array;
  private ids: Int32Array;
  readonly total: number;
  constructor(weights: ArrayLike<number>, filter?: (i: number) => boolean) {
    const ids: number[] = [];
    const cum: number[] = [];
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (w > 0 && (!filter || filter(i))) {
        acc += w;
        ids.push(i);
        cum.push(acc);
      }
    }
    this.cum = Float64Array.from(cum);
    this.ids = Int32Array.from(ids);
    this.total = acc;
  }
  sample(r: number): number {
    if (!this.ids.length) return -1;
    const x = r * this.total;
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] < x) lo = m + 1;
      else hi = m;
    }
    return this.ids[lo];
  }
}

export interface DemandEvent {
  id: string;
  label: string;
  x: number;
  z: number;
  radius: number;
  start: number; // s desde medianoche
  end: number;
  tripsPerHour: number;
  toward: boolean; // true: llegan al punto, false: salen de él
}

export interface Trip {
  o: number;
  d: number;
  kind: number;
  through: boolean;
}

export class Demand {
  /** Viajes diarios en vehículo privado con origen y destino dentro del casco urbano. */
  internalDaily = 88000;
  multiplier = 1;
  /** Si no es null, la demanda usa siempre esta hora (el reloj sigue avanzando). */
  lockHour: number | null = null;
  events: DemandEvent[] = [];
  private P: Sampler;
  private A: Sampler;
  private gIn: Sampler;
  private gOut: Sampler;
  private tIn: Sampler;
  private tOut: Sampler;
  private eventSamplers = new Map<string, Sampler>();
  readonly inboundDaily: number;
  readonly outboundDaily: number;
  readonly throughDaily: number;

  constructor(private net: Network, private rand: () => number) {
    const n = net.nEdges;
    const core = (e: number) => net.isCore(e) && !(net.eFlags[e] & (EDGE_FLAGS.LINK | EDGE_FLAGS.ROUNDABOUT));
    this.P = new Sampler(net.eProd, core);
    this.A = new Sampler(net.eAttr, core);
    const inLocal = new Float32Array(n);
    const outLocal = new Float32Array(n);
    const inThr = new Float32Array(n);
    const outThr = new Float32Array(n);
    for (let e = 0; e < n; e++) {
      inLocal[e] = net.eGwIn[e] * (1 - net.eThr[e]);
      outLocal[e] = net.eGwOut[e] * (1 - net.eThr[e]);
      inThr[e] = net.eGwIn[e] * net.eThr[e];
      outThr[e] = net.eGwOut[e] * net.eThr[e];
    }
    this.gIn = new Sampler(inLocal);
    this.gOut = new Sampler(outLocal);
    this.tIn = new Sampler(inThr);
    this.tOut = new Sampler(outThr);
    this.inboundDaily = this.gIn.total;
    this.outboundDaily = this.gOut.total;
    this.throughDaily = this.tIn.total;
  }

  /** Viajes por segundo de cada flujo a la hora dada (s desde medianoche). */
  rates(t: number) {
    const hour = this.lockHour ?? t / 3600;
    const f = (hourlyFraction(hour) / 3600) * this.multiplier;
    return {
      internal: this.internalDaily * f,
      inbound: this.inboundDaily * f,
      outbound: this.outboundDaily * f,
      through: this.throughDaily * f,
    };
  }

  eventRate(ev: DemandEvent, t: number): number {
    if (t < ev.start || t > ev.end) return 0;
    // Perfil triangular: máximo a 2/3 del periodo en llegadas, al principio en salidas.
    const u = (t - ev.start) / (ev.end - ev.start);
    const shape = ev.toward ? (u < 0.67 ? u / 0.67 : (1 - u) / 0.33) : u < 0.15 ? u / 0.15 : (1 - u) / 0.85;
    return ((ev.tripsPerHour * 2) / 3600) * Math.max(0, shape) * Math.min(this.multiplier, 1.5);
  }

  private home(t: number) {
    const h = this.lockHour ?? t / 3600;
    return HOME_SHARE[Math.floor(h) % 24];
  }

  private farEnough(o: number, d: number, min: number) {
    const net = this.net;
    const a = net.ePt0[o];
    const b = net.ePt0[d];
    return Math.hypot(net.px[a] - net.px[b], net.pz[a] - net.pz[b]) >= min;
  }

  private kind(external: boolean): number {
    const r = this.rand();
    if (r < (external ? 0.07 : 0.02)) return KIND.TRUCK;
    if (r < (external ? 0.19 : 0.12)) return KIND.VAN;
    if (r < (external ? 0.25 : 0.225)) return KIND.MOTO;
    return KIND.CAR;
  }

  internalTrip(t: number): Trip | null {
    const fromHome = this.rand() < this.home(t);
    for (let k = 0; k < 6; k++) {
      const o = (fromHome ? this.P : this.A).sample(this.rand());
      const d = (fromHome ? this.A : this.P).sample(this.rand());
      if (o >= 0 && d >= 0 && o !== d && this.farEnough(o, d, 600)) return { o, d, kind: this.kind(false), through: false };
    }
    return null;
  }

  inboundTrip(): Trip | null {
    const o = this.gIn.sample(this.rand());
    const d = (this.rand() < 0.7 ? this.A : this.P).sample(this.rand());
    return o >= 0 && d >= 0 ? { o, d, kind: this.kind(true), through: false } : null;
  }

  outboundTrip(): Trip | null {
    const o = (this.rand() < 0.7 ? this.P : this.A).sample(this.rand());
    const d = this.gOut.sample(this.rand());
    return o >= 0 && d >= 0 ? { o, d, kind: this.kind(true), through: false } : null;
  }

  throughTrip(): Trip | null {
    for (let k = 0; k < 6; k++) {
      const o = this.tIn.sample(this.rand());
      const d = this.tOut.sample(this.rand());
      if (o >= 0 && d >= 0 && this.farEnough(o, d, 2000)) return { o, d, kind: this.kind(true), through: true };
    }
    return null;
  }

  eventTrip(ev: DemandEvent): Trip | null {
    let s = this.eventSamplers.get(ev.id);
    if (!s) {
      const net = this.net;
      const w = new Float32Array(net.nEdges);
      for (let e = 0; e < net.nEdges; e++) {
        if (!net.isCore(e) || net.eFlags[e] & (EDGE_FLAGS.LINK | EDGE_FLAGS.ROUNDABOUT) || net.eCls[e] <= 2) continue;
        const p = net.ePt0[e];
        const d = Math.hypot(net.px[p] - ev.x, net.pz[p] - ev.z);
        if (d < ev.radius) w[e] = net.eLen[e] * (1 - d / ev.radius);
      }
      s = new Sampler(w);
      this.eventSamplers.set(ev.id, s);
    }
    const near = s.sample(this.rand());
    const far = this.rand() < 0.72 ? this.P.sample(this.rand()) : this.gIn.sample(this.rand());
    const farOut = this.rand() < 0.72 ? this.P.sample(this.rand()) : this.gOut.sample(this.rand());
    if (near < 0) return null;
    return ev.toward
      ? far >= 0 ? { o: far, d: near, kind: KIND.CAR, through: false } : null
      : farOut >= 0 ? { o: near, d: farOut, kind: KIND.CAR, through: false } : null;
  }
}
