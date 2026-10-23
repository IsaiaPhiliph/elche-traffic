// Mensajes entre el hilo principal y el worker de simulación.
import type { SimConfig, SimStats, VehicleInfo } from './simulation';
import type { DemandEvent } from './demand';

export type ToWorker =
  | { type: 'init'; url: string }
  | { type: 'control'; running?: boolean; speed?: number }
  | { type: 'config'; cfg: Partial<SimConfig> }
  | { type: 'time'; t: number }
  | { type: 'lockHour'; hour: number | null }
  | { type: 'close'; edges: number[]; closed: boolean }
  | { type: 'events'; events: DemandEvent[] }
  | { type: 'queryVehicle'; id: number }
  | { type: 'queryEdge'; id: number }
  | { type: 'reset' }
  | { type: 'buffer'; buf: Float32Array };

export interface ReadyInfo {
  nEdges: number;
  heads: Int32Array;
  headCtrl: Int32Array;
  bus: { ref: string; name: string; color: string | null }[];
  demand: { internal: number; inbound: number; outbound: number; through: number };
  zbe: [number, number][];
}

export interface EdgeInfo {
  id: number;
  name: string;
  lanes: number;
  speedLimit: number;
  length: number;
  vehicles: number;
  meanSpeed: number;
  closed: boolean;
  signal: { mode: string; cycle: number; state: number } | null;
}

export type FromWorker =
  | { type: 'ready'; info: ReadyInfo }
  | {
      type: 'frame';
      t: number;
      n: number;
      buf: Float32Array;
      heads?: Uint8Array;
      heat?: Uint8Array;
      stats?: SimStats;
      eff: number;
    }
  | { type: 'vehicleInfo'; info: VehicleInfo | null }
  | { type: 'edgeInfo'; info: EdgeInfo | null }
  | { type: 'error'; message: string };
