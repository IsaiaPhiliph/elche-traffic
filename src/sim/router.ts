// Cálculo de rutas A* sobre el grafo de tramos (estado = tramo dirigido, arcos = maniobras).
import type { Network } from './network';
import { EDGE_FLAGS } from './types';

const TURN_PENALTY = [0, 2, 4, 25]; // segundos: recto, derecha, izquierda, cambio de sentido

export class Router {
  private g: Float64Array;
  private came: Int32Array;
  private stamp: Int32Array;
  private closedStamp: Int32Array;
  private search = 0;
  private heapE: Int32Array;
  private heapF: Float64Array;
  private heapN = 0;
  /** Velocidad estimada actual (m/s) por tramo, alimentada por la simulación. */
  readonly speedEst: Float32Array;
  readonly closed: Uint8Array;
  /** Retardo medio esperado por semáforo al final del tramo (s). */
  readonly signalDelay: Float32Array;
  zbe = false;
  private hSpeed: number;

  constructor(private net: Network) {
    const n = net.nEdges;
    this.g = new Float64Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.closedStamp = new Int32Array(n);
    this.heapE = new Int32Array(net.nMovs + n + 16);
    this.heapF = new Float64Array(net.nMovs + n + 16);
    this.speedEst = Float32Array.from(net.eSpeed, (v) => v * 0.85);
    this.closed = new Uint8Array(n);
    this.signalDelay = new Float32Array(n);
    // Heurística ponderada (≈65 km/h): mucho menos exploración a cambio de rutas casi
    // óptimas; solo sobrestima el coste en autovías, donde casi no hay alternativas.
    this.hSpeed = 18;
  }

  edgeCost(e: number, throughZone: boolean): number {
    const net = this.net;
    let c = net.eLen[e] / Math.max(1.5, this.speedEst[e]) + this.signalDelay[e];
    if (net.eYield[e]) c += 3;
    if (this.zbe && throughZone && (net.eFlags[e] & EDGE_FLAGS.ZONE)) c = c * 25 + 120;
    return c;
  }

  /** Ruta de `orig` a `dest` (ambos tramos). Devuelve la secuencia de tramos o null. */
  route(orig: number, dest: number, throughZone = true): Int32Array | null {
    const net = this.net;
    if (this.closed[dest] && dest !== orig) return null;
    if (orig === dest) return Int32Array.of(orig);
    const id = ++this.search;
    const tx = net.px[net.ePt0[dest]];
    const tz = net.pz[net.ePt0[dest]];
    const h = (e: number) => {
      const p = net.ePt0[e] + net.ePtn[e] - 1;
      return Math.hypot(net.px[p] - tx, net.pz[p] - tz) / this.hSpeed;
    };
    this.heapN = 0;
    this.g[orig] = 0;
    this.came[orig] = -1;
    this.stamp[orig] = id;
    this.push(orig, h(orig));
    let found = false;
    let iter = 0;
    while (this.heapN > 0) {
      const e = this.pop();
      if (this.closedStamp[e] === id) continue;
      this.closedStamp[e] = id;
      if (e === dest) {
        found = true;
        break;
      }
      if (++iter > 60000) break;
      const s = net.outStart[e];
      if (s < 0) continue;
      const ge = this.g[e];
      for (let m = s, end = s + net.outCount[e]; m < end; m++) {
        const t = net.mTo[m];
        if (this.closed[t] || this.closedStamp[t] === id) continue;
        // No se atraviesan accesos de salida salvo que sean el destino.
        if (t !== dest && (net.eFlags[t] & EDGE_FLAGS.GATEWAY_OUT)) continue;
        const ng = ge + TURN_PENALTY[net.mTurn[m]] + this.edgeCost(t, throughZone);
        if (this.stamp[t] !== id || ng < this.g[t]) {
          this.stamp[t] = id;
          this.g[t] = ng;
          this.came[t] = e;
          this.push(t, ng + h(t));
        }
      }
    }
    if (!found) return null;
    let len = 0;
    for (let e = dest; e !== -1; e = this.came[e]) len++;
    const out = new Int32Array(len);
    for (let e = dest, i = len - 1; e !== -1; e = this.came[e], i--) out[i] = e;
    return out;
  }

  /** Coste total estimado (s) de una ruta en condiciones actuales. */
  routeTime(route: Int32Array, from = 0): number {
    let t = 0;
    for (let i = from; i < route.length; i++) t += this.edgeCost(route[i], false);
    return t;
  }

  private push(e: number, f: number) {
    let i = this.heapN++;
    if (i >= this.heapE.length) {
      const ne = new Int32Array(this.heapE.length * 2);
      ne.set(this.heapE);
      const nf = new Float64Array(this.heapF.length * 2);
      nf.set(this.heapF);
      this.heapE = ne;
      this.heapF = nf;
    }
    const E = this.heapE;
    const F = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      E[i] = E[p];
      F[i] = F[p];
      i = p;
    }
    E[i] = e;
    F[i] = f;
  }

  private pop(): number {
    const E = this.heapE;
    const F = this.heapF;
    const top = E[0];
    const n = --this.heapN;
    if (n > 0) {
      const e = E[n];
      const f = F[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && F[c + 1] < F[c]) c++;
        if (F[c] >= f) break;
        E[i] = E[c];
        F[i] = F[c];
        i = c;
      }
      E[i] = e;
      F[i] = f;
    }
    return top;
  }
}
