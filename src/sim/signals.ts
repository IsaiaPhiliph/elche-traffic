// Reguladores semafóricos: planes de tiempo fijo, onda verde o accionados por demanda.
import type { Network } from './network';

export type SignalMode = 'fixed' | 'wave' | 'actuated' | 'off';
export const SIG = { GREEN: 0, AMBER: 1, RED: 2, OFF: 3, NONE: 255 } as const;

const AMBER = 3;
const ALL_RED = 2;

interface Controller {
  heads: Int32Array;
  groups: Uint8Array;
  nGroups: number;
  x: number;
  z: number;
  weight: [number, number];
  offset: number;
  g0: number;
  g1: number;
  // estado del modo accionado
  cur: number;
  stage: number; // 0 verde, 1 ámbar, 2 todo rojo
  timer: number;
  ewGroup: number;
}

export class Signals {
  readonly ctrls: Controller[];
  /** Estado del semáforo al final de cada tramo (SIG.NONE si no tiene). */
  readonly headState: Uint8Array;
  readonly edgeCtrl: Int32Array;
  readonly edgeGroup: Uint8Array;
  mode: SignalMode = 'fixed';
  cycle = 90;
  private changed = true;

  constructor(net: Network) {
    const n = net.nEdges;
    this.headState = new Uint8Array(n).fill(SIG.NONE);
    this.edgeCtrl = new Int32Array(n).fill(-1);
    this.edgeGroup = new Uint8Array(n);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    this.ctrls = net.json.signals.map((s, i) => {
      const heads = Int32Array.from(s.heads);
      const groups = Uint8Array.from(s.groups);
      const weight: [number, number] = [0, 0];
      let ew = [0, 0];
      heads.forEach((e, k) => {
        this.edgeCtrl[e] = i;
        this.edgeGroup[e] = groups[k];
        weight[groups[k]] += net.eLanes[e] * (2 + net.eRank[e]);
        ew[groups[k]] += Math.abs(net.eDirEnd[2 * e]);
      });
      const nGroups = new Set(groups).size;
      return {
        heads, groups, nGroups, x: s.x, z: s.z, weight, offset: rnd() * 600,
        g0: 30, g1: 30, cur: 0, stage: 0, timer: rnd() * 20, ewGroup: ew[0] >= ew[1] ? 0 : 1,
      };
    });
    this.retime();
  }

  setMode(mode: SignalMode, cycle: number) {
    this.mode = mode;
    this.cycle = Math.max(40, Math.min(160, cycle));
    this.retime();
    this.changed = true;
  }

  /** Reparto de verdes proporcional a la demanda de cada fase (carriles × jerarquía). */
  private retime() {
    const C = this.cycle;
    for (const c of this.ctrls) {
      if (c.nGroups === 1) {
        c.g0 = Math.max(18, C - 22);
        c.g1 = 0;
      } else {
        const avail = C - 2 * (AMBER + ALL_RED);
        const w = c.weight[0] / (c.weight[0] + c.weight[1] || 1);
        c.g0 = Math.max(12, Math.min(avail - 12, avail * w));
        c.g1 = avail - c.g0;
      }
    }
  }

  /** Retardo medio esperado (s) para la ruta: (rojo)² / (2·ciclo). */
  expectedDelay(e: number): number {
    const ci = this.edgeCtrl[e];
    if (ci < 0 || this.mode === 'off') return 0;
    const c = this.ctrls[ci];
    const C = this.cycle;
    const g = c.nGroups === 1 ? c.g0 : this.edgeGroup[e] === 0 ? c.g0 : c.g1;
    const red = C - g;
    return (red * red) / (2 * C);
  }

  /**
   * Actualiza estados. `demand(e, d)` devuelve si hay vehículos a menos de d metros
   * de la línea de detención del tramo e (detectores del modo accionado).
   */
  update(t: number, dt: number, demand: (e: number, d: number) => boolean) {
    const C = this.cycle;
    for (const c of this.ctrls) {
      let s0: number = SIG.RED;
      let s1: number = SIG.RED;
      if (this.mode === 'off') {
        s0 = s1 = SIG.OFF;
      } else if (this.mode === 'actuated' && c.nGroups === 2) {
        c.timer += dt;
        if (c.stage === 0) {
          const other = 1 - c.cur;
          const anyGreen = c.heads.some((e, k) => c.groups[k] === c.cur && demand(e, 30));
          const anyRed = c.heads.some((e, k) => c.groups[k] === other && demand(e, 70));
          const maxG = c.cur === 0 ? Math.max(25, c.g0 * 1.5) : Math.max(25, c.g1 * 1.5);
          if (c.timer > 8 && anyRed && (!anyGreen || c.timer > maxG)) {
            c.stage = 1;
            c.timer = 0;
          }
        } else if (c.stage === 1 && c.timer >= AMBER) {
          c.stage = 2;
          c.timer = 0;
        } else if (c.stage === 2 && c.timer >= ALL_RED) {
          c.stage = 0;
          c.timer = 0;
          c.cur = 1 - c.cur;
        }
        const st = c.stage === 0 ? SIG.GREEN : c.stage === 1 ? SIG.AMBER : SIG.RED;
        if (c.stage === 2) s0 = s1 = SIG.RED;
        else if (c.cur === 0) [s0, s1] = [st, SIG.RED];
        else [s0, s1] = [SIG.RED, st];
      } else {
        let off = c.offset;
        if (this.mode === 'wave') {
          // Onda verde de oeste a este a 45 km/h: el verde del eje E-O se desplaza con x.
          const shift = ((c.x + 4000) / 12.5) % C;
          off = c.ewGroup === 0 ? -shift : c.g0 + AMBER + ALL_RED - shift;
        }
        let tau = (t + off) % C;
        if (tau < 0) tau += C;
        if (c.nGroups === 1) {
          s0 = tau < c.g0 ? SIG.GREEN : tau < c.g0 + AMBER ? SIG.AMBER : SIG.RED;
        } else {
          const a = c.g0;
          const b = a + AMBER;
          const d = b + ALL_RED;
          const e = d + c.g1;
          const f = e + AMBER;
          if (tau < a) s0 = SIG.GREEN;
          else if (tau < b) s0 = SIG.AMBER;
          else if (tau >= d && tau < e) s1 = SIG.GREEN;
          else if (tau >= e && tau < f) s1 = SIG.AMBER;
        }
      }
      for (let k = 0; k < c.heads.length; k++) {
        const e = c.heads[k];
        const st = c.groups[k] === 0 ? s0 : s1;
        if (this.headState[e] !== st) {
          this.headState[e] = st;
          this.changed = true;
        }
      }
    }
  }

  consumeChanged(): boolean {
    const c = this.changed;
    this.changed = false;
    return c;
  }

  /** Resumen del plan semafórico de un regulador, para la interfaz. */
  describe(ci: number): { mode: string; cycle: number; groups: number; g0: number; g1: number } {
    const c = this.ctrls[ci];
    return { mode: this.mode, cycle: this.cycle, groups: c.nGroups, g0: Math.round(c.g0), g1: Math.round(c.g1) };
  }
}
