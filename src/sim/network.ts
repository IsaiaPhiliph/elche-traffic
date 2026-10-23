// Red viaria en arrays tipados, lista para simular.
import { EDGE_FLAGS, NODE_TYPES, type NetworkJSON } from './types';

export class Network {
  readonly nEdges: number;
  readonly nNodes: number;
  readonly nMovs: number;
  // tramos
  readonly eFrom: Int32Array;
  readonly eTo: Int32Array;
  readonly eLanes: Uint8Array;
  readonly eLaneW: Float32Array;
  readonly eOff0: Float32Array;
  readonly eSpeed: Float32Array; // m/s
  readonly eLen: Float32Array;
  readonly eRank: Uint8Array;
  readonly eCls: Uint8Array;
  readonly ePt0: Int32Array;
  readonly ePtn: Int32Array;
  readonly eFlags: Uint16Array;
  readonly eYield: Uint8Array;
  readonly eName: Int32Array;
  readonly eProd: Float32Array;
  readonly eAttr: Float32Array;
  readonly eGwIn: Float32Array;
  readonly eGwOut: Float32Array;
  readonly eThr: Float32Array;
  readonly eSeg: Int32Array;
  readonly eDirEnd: Float32Array; // (dx, dz) al final del tramo
  readonly eDirStart: Float32Array;
  readonly laneBase: Int32Array;
  readonly nLanes: number;
  // geometría
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly pd: Float32Array; // distancia acumulada desde el inicio del tramo
  readonly pnx: Float32Array; // normal unitaria a la derecha (promediada en vértices)
  readonly pnz: Float32Array;
  // maniobras
  readonly mFrom: Int32Array;
  readonly mTo: Int32Array;
  readonly mNode: Int32Array;
  readonly mTurn: Uint8Array;
  readonly mConfStart: Int32Array;
  readonly mConfList: Int32Array;
  readonly mConnBase: Int32Array; // índice del primer "carril de conexión" de la maniobra
  readonly nConns: number;
  readonly outStart: Int32Array; // maniobras ordenadas por tramo de origen
  readonly outCount: Int32Array;
  readonly inMovStart: Int32Array;
  readonly inMovList: Int32Array;
  // nudos
  readonly nx: Float32Array;
  readonly nz: Float32Array;
  readonly ny: Float32Array;
  readonly nodeType: Uint8Array;
  readonly nodeInStart: Int32Array;
  readonly nodeIn: Int32Array;
  readonly names: string[];
  readonly json: NetworkJSON;
  maxSpeed = 0;

  constructor(j: NetworkJSON) {
    this.json = j;
    const E = j.edges;
    const n = (this.nEdges = E.from.length);
    this.eFrom = Int32Array.from(E.from);
    this.eTo = Int32Array.from(E.to);
    this.eLanes = Uint8Array.from(E.lanes);
    this.eLaneW = Float32Array.from(E.laneW);
    this.eOff0 = Float32Array.from(E.off0);
    this.eSpeed = Float32Array.from(E.speed, (v) => v / 3.6);
    this.eLen = Float32Array.from(E.len, (v) => Math.max(0.5, v));
    this.eRank = Uint8Array.from(E.rank);
    this.eCls = Uint8Array.from(E.cls);
    this.ePt0 = Int32Array.from(E.pt0);
    this.ePtn = Int32Array.from(E.ptn);
    this.eFlags = Uint16Array.from(E.flags);
    this.eYield = Uint8Array.from(E.yld);
    this.eName = Int32Array.from(E.name);
    this.eProd = Float32Array.from(E.prod);
    this.eAttr = Float32Array.from(E.attr);
    this.eGwIn = Float32Array.from(E.gwIn);
    this.eGwOut = Float32Array.from(E.gwOut);
    this.eThr = Float32Array.from(E.thr, (v) => v / 100);
    this.eSeg = Int32Array.from(E.seg);
    this.names = j.names;
    for (let e = 0; e < n; e++) this.maxSpeed = Math.max(this.maxSpeed, this.eSpeed[e]);

    this.px = Float32Array.from(j.pts.x);
    this.py = Float32Array.from(j.pts.y);
    this.pz = Float32Array.from(j.pts.z);
    const np = this.px.length;
    this.pd = new Float32Array(np);
    this.pnx = new Float32Array(np);
    this.pnz = new Float32Array(np);
    this.eDirEnd = new Float32Array(2 * n);
    this.eDirStart = new Float32Array(2 * n);
    for (let e = 0; e < n; e++) {
      const a = this.ePt0[e];
      const c = this.ePtn[e];
      let acc = 0;
      this.pd[a] = 0;
      for (let i = 1; i < c; i++) {
        acc += Math.hypot(this.px[a + i] - this.px[a + i - 1], this.pz[a + i] - this.pz[a + i - 1]);
        this.pd[a + i] = acc;
      }
      // Normaliza a la longitud declarada para que s∈[0, len].
      const L = this.eLen[e];
      if (acc > 0) for (let i = 1; i < c; i++) this.pd[a + i] *= L / acc;
      for (let i = 0; i < c; i++) {
        let dx = 0;
        let dz = 0;
        if (i > 0) {
          const lx = this.px[a + i] - this.px[a + i - 1];
          const lz = this.pz[a + i] - this.pz[a + i - 1];
          const l = Math.hypot(lx, lz) || 1;
          dx += lx / l;
          dz += lz / l;
        }
        if (i < c - 1) {
          const lx = this.px[a + i + 1] - this.px[a + i];
          const lz = this.pz[a + i + 1] - this.pz[a + i];
          const l = Math.hypot(lx, lz) || 1;
          dx += lx / l;
          dz += lz / l;
        }
        const l = Math.hypot(dx, dz) || 1;
        this.pnx[a + i] = -dz / l;
        this.pnz[a + i] = dx / l;
      }
      this.setDir(e, true);
      this.setDir(e, false);
    }

    // Carriles
    this.laneBase = new Int32Array(n + 1);
    for (let e = 0; e < n; e++) this.laneBase[e + 1] = this.laneBase[e] + this.eLanes[e];
    this.nLanes = this.laneBase[n];

    // Maniobras
    const M = j.movs;
    const nm = (this.nMovs = M.from.length);
    this.mFrom = Int32Array.from(M.from);
    this.mTo = Int32Array.from(M.to);
    this.mNode = Int32Array.from(M.node);
    this.mTurn = Uint8Array.from(M.turn);
    this.mConfStart = Int32Array.from(M.cs);
    this.mConfList = Int32Array.from(M.cl);
    this.mConnBase = new Int32Array(nm + 1);
    for (let m = 0; m < nm; m++) this.mConnBase[m + 1] = this.mConnBase[m] + this.eLanes[this.mFrom[m]];
    this.nConns = this.mConnBase[nm];
    this.outStart = new Int32Array(n).fill(-1);
    this.outCount = new Int32Array(n);
    for (let m = 0; m < nm; m++) {
      const f = this.mFrom[m];
      if (this.outStart[f] < 0) this.outStart[f] = m;
      this.outCount[f]++;
    }
    const inCount = new Int32Array(n + 1);
    for (let m = 0; m < nm; m++) inCount[this.mTo[m] + 1]++;
    for (let e = 0; e < n; e++) inCount[e + 1] += inCount[e];
    this.inMovStart = inCount;
    this.inMovList = new Int32Array(nm);
    const fill = inCount.slice();
    for (let m = 0; m < nm; m++) this.inMovList[fill[this.mTo[m]]++] = m;

    // Nudos
    this.nx = Float32Array.from(j.nodes.x);
    this.nz = Float32Array.from(j.nodes.z);
    this.ny = Float32Array.from(j.nodes.y);
    this.nodeType = Uint8Array.from(j.nodes.type);
    const nn = (this.nNodes = this.nx.length);
    const cnt = new Int32Array(nn + 1);
    for (let e = 0; e < n; e++) cnt[this.eTo[e] + 1]++;
    for (let i = 0; i < nn; i++) cnt[i + 1] += cnt[i];
    this.nodeInStart = cnt;
    this.nodeIn = new Int32Array(n);
    const f2 = cnt.slice();
    for (let e = 0; e < n; e++) this.nodeIn[f2[this.eTo[e]]++] = e;
  }

  private setDir(e: number, end: boolean) {
    const a = this.ePt0[e];
    const c = this.ePtn[e];
    const span = Math.min(6, this.eLen[e]);
    let i0: number;
    let i1: number;
    if (end) {
      i1 = a + c - 1;
      i0 = i1 - 1;
      while (i0 > a && this.pd[i1] - this.pd[i0] < span) i0--;
    } else {
      i0 = a;
      i1 = a + 1;
      while (i1 < a + c - 1 && this.pd[i1] - this.pd[i0] < span) i1++;
    }
    const dx = this.px[i1] - this.px[i0];
    const dz = this.pz[i1] - this.pz[i0];
    const l = Math.hypot(dx, dz) || 1;
    const arr = end ? this.eDirEnd : this.eDirStart;
    arr[2 * e] = dx / l;
    arr[2 * e + 1] = dz / l;
  }

  movement(from: number, to: number): number {
    const s = this.outStart[from];
    if (s < 0) return -1;
    for (let m = s, end = s + this.outCount[from]; m < end; m++) if (this.mTo[m] === to) return m;
    return -1;
  }

  conflicts(m1: number, m2: number): boolean {
    for (let i = this.mConfStart[m1], end = this.mConfStart[m1 + 1]; i < end; i++) if (this.mConfList[i] === m2) return true;
    return false;
  }

  laneOffset(e: number, lane: number): number {
    return this.eOff0[e] + lane * this.eLaneW[e];
  }

  // Índice del vértice inicial del subtramo que contiene la distancia s.
  findSeg(e: number, s: number, hint = -1): number {
    const a = this.ePt0[e];
    const last = a + this.ePtn[e] - 2;
    let i = hint >= a && hint <= last ? hint : a;
    while (i < last && this.pd[i + 1] < s) i++;
    while (i > a && this.pd[i] > s) i--;
    return i;
  }

  // Posición en el tramo e a distancia s con desplazamiento lateral lat (a la derecha).
  pointAt(e: number, s: number, lat: number, out: Float32Array, o: number, hint = -1): number {
    const i = this.findSeg(e, s, hint);
    const d0 = this.pd[i];
    const d1 = this.pd[i + 1];
    const t = d1 > d0 ? Math.min(1, Math.max(0, (s - d0) / (d1 - d0))) : 0;
    const nx = this.pnx[i] + (this.pnx[i + 1] - this.pnx[i]) * t;
    const nz = this.pnz[i] + (this.pnz[i + 1] - this.pnz[i]) * t;
    const nl = Math.hypot(nx, nz) || 1;
    out[o] = this.px[i] + (this.px[i + 1] - this.px[i]) * t + (nx / nl) * lat;
    out[o + 1] = this.py[i] + (this.py[i + 1] - this.py[i]) * t;
    out[o + 2] = this.pz[i] + (this.pz[i + 1] - this.pz[i]) * t + (nz / nl) * lat;
    // Rumbo a partir de la normal interpolada: giro suave en los vértices.
    out[o + 3] = Math.atan2(-nx / nl, nz / nl);
    return i;
  }

  isGatewayIn(e: number) {
    return (this.eFlags[e] & EDGE_FLAGS.GATEWAY_IN) !== 0;
  }
  isGatewayOut(e: number) {
    return (this.eFlags[e] & EDGE_FLAGS.GATEWAY_OUT) !== 0;
  }
  isCore(e: number) {
    return (this.eFlags[e] & EDGE_FLAGS.CORE) !== 0;
  }
  isRing(e: number) {
    return (this.eFlags[e] & EDGE_FLAGS.ROUNDABOUT) !== 0;
  }
  isPassThrough(node: number) {
    return this.nodeType[node] === NODE_TYPES.PRIORITY && this.nodeInStart[node + 1] - this.nodeInStart[node] <= 1;
  }
  edgeName(e: number): string {
    const i = this.eName[e];
    return i >= 0 ? this.names[i] : '';
  }
}
