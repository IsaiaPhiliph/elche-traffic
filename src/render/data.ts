// Tipos y carga de los ficheros de public/data.

export interface RoadSegment {
  p: number[]; // x, y, z intercalados (eje recortado en los cruces)
  w: number;
  nF: number;
  nB: number;
  c: number;
  eF: number;
  eB: number;
  f: number; // 1 glorieta, 2 puente, 4 túnel, 8 aceras
  n: number;
  sl: number; // marcas de detención (ver build-data.mjs)
}

export interface RoadsJSON {
  segments: RoadSegment[];
  junctions: { p: number[]; y: number }[];
  islands: number[][];
  pedestrian: { p: number[]; w: number; a: number }[];
  rails: number[][];
  names: string[];
}

export interface BuildingsJSON {
  palette: string[];
  count: number;
  data: number[];
  source?: string;
}

export interface AreasJSON {
  types: string[];
  data: number[];
  rivers: { w: number; n: string; p: number[] }[];
}

export interface TreesJSON {
  count: number;
  data: number[];
}

export interface POI {
  name: string;
  kind: string;
  x: number;
  z: number;
  imp: number;
}

export interface CityData {
  roads: RoadsJSON;
  buildings: BuildingsJSON;
  areas: AreasJSON;
  trees: TreesJSON;
  pois: POI[];
}

export async function loadCity(base: string, onProgress: (f: number, label: string) => void): Promise<CityData> {
  const files: [keyof CityData, string, string][] = [
    ['roads', 'roads.json', 'Red viaria'],
    ['areas', 'areas.json', 'Usos del suelo'],
    ['buildings', 'buildings.json', 'Edificios del Catastro'],
    ['trees', 'trees.json', 'Palmeral y arbolado'],
    ['pois', 'pois.json', 'Lugares de interés'],
  ];
  const out: Partial<CityData> = {};
  let done = 0;
  await Promise.all(
    files.map(async ([key, file, label]) => {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`No se pudo cargar ${file} (${res.status})`);
      (out as Record<string, unknown>)[key] = await res.json();
      done++;
      onProgress(done / files.length, label);
    }),
  );
  return out as CityData;
}
