// Formato de public/data/network.json (generado por scripts/build-data.mjs).
export interface NetworkJSON {
  version: number;
  meta: { generated: string; source: string; origin: { lat: number; lon: number }; stats: Record<string, number> };
  nodes: { x: number[]; z: number[]; y: number[]; type: number[] };
  edges: {
    from: number[]; to: number[]; lanes: number[]; laneW: number[]; off0: number[]; speed: number[];
    rank: number[]; cls: number[]; len: number[]; pt0: number[]; ptn: number[]; flags: number[];
    yld: number[]; name: number[]; prod: number[]; attr: number[]; gwIn: number[]; gwOut: number[];
    thr: number[]; seg: number[];
  };
  pts: { x: number[]; y: number[]; z: number[] };
  movs: { from: number[]; to: number[]; node: number[]; turn: number[]; cs: number[]; cl: number[] };
  signals: { heads: number[]; groups: number[]; x: number; z: number }[];
  names: string[];
  zbe: [number, number][];
  bus: BusLineJSON[];
}

export interface BusLineJSON {
  ref: string;
  name: string;
  color: string | null;
  headway: number;
  edges: number[];
  stops: [number, number][];
  len: number;
}

export const EDGE_FLAGS = {
  ROUNDABOUT: 1, BRIDGE: 2, TUNNEL: 4, GATEWAY_IN: 8, GATEWAY_OUT: 16, CORE: 32, ZONE: 64, LINK: 128,
} as const;
export const NODE_TYPES = { PRIORITY: 0, SIGNAL: 1, ROUNDABOUT: 2, DEADEND: 3, BOUNDARY: 4 } as const;
export const TURN = { S: 0, R: 1, L: 2, U: 3 } as const;

export const VEHICLE_KINDS = ['Turismo', 'Furgoneta', 'Camión', 'Autobús', 'Moto'] as const;
export const KIND = { CAR: 0, VAN: 1, TRUCK: 2, BUS: 3, MOTO: 4 } as const;
