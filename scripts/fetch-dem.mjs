// Descarga el Modelo Digital del Terreno MDT05 (paso de malla 5 m, LiDAR PNOA) del IGN
// mediante su servicio WCS INSPIRE, en teselas ASCII Grid que cubren el área y un margen.
// Uso: node scripts/fetch-dem.mjs <carpeta-destino>
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEM_BBOX } from './config.mjs';

const outDir = process.argv[2] ?? 'data/raw/dem';
const WCS = 'https://servicios.idee.es/wcs-inspire/mdt';
const COVERAGE = 'Elevacion4258_5';
const NX = 4;
const NY = 3;

await mkdir(outDir, { recursive: true });
const dLat = (DEM_BBOX.north - DEM_BBOX.south) / NY;
const dLon = (DEM_BBOX.east - DEM_BBOX.west) / NX;
for (let j = 0; j < NY; j++) {
  for (let i = 0; i < NX; i++) {
    const file = join(outDir, `mdt05_${j}_${i}.asc`);
    if (await stat(file).then(() => true, () => false)) continue;
    const s = DEM_BBOX.south + j * dLat;
    const w = DEM_BBOX.west + i * dLon;
    const url =
      `${WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=${COVERAGE}` +
      `&SUBSET=Lat(${s.toFixed(6)},${(s + dLat).toFixed(6)})&SUBSET=Long(${w.toFixed(6)},${(w + dLon).toFixed(6)})&FORMAT=ArcGrid`;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'elche-traffic-sim/0.1' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        // La respuesta es multiparte: la rejilla empieza en «ncols».
        const k = body.indexOf('ncols');
        if (k < 0) throw new Error('respuesta sin rejilla: ' + body.slice(0, 200));
        const end = body.indexOf('\n--wcs', k);
        await writeFile(file, body.slice(k, end > 0 ? end : undefined));
        console.log(`tesela ${j},${i}: ${(body.length / 1e6).toFixed(1)} MB`);
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        console.warn(`tesela ${j},${i}: ${e.message}; reintentando`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
  }
}
console.log('MDT05 en', outDir);
