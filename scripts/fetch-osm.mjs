// Descarga los datos de OpenStreetMap de Elche mediante la API Overpass.
// Uso: node scripts/fetch-osm.mjs <carpeta-destino>
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BBOX } from './config.mjs';

const outDir = process.argv[2] ?? 'data/raw';
const force = process.argv.includes('--force');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const bb = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;

// Cada capa se guarda en su propio fichero JSON.
const QUERIES = {
  roads: `[out:json][timeout:240];
    way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian)$"](${bb});
    (._;>;);
    out body;`,
  restrictions: `[out:json][timeout:120];
    relation["type"="restriction"](${bb});
    out body;`,
  // Los edificios (importación del Catastro) son muchos: se piden por teselas.
  buildings: {
    tiles: 4,
    build: (b) => `[out:json][timeout:180];
    (
      way["building"](${b});
      relation["building"]["type"="multipolygon"](${b});
      way["building:part"](${b});
      relation["building:part"]["type"="multipolygon"](${b});
    );
    out geom;`,
  },
  areas: `[out:json][timeout:300];
    (
      way["landuse"](${bb});
      relation["landuse"]["type"="multipolygon"](${bb});
      way["leisure"~"^(park|garden|pitch|stadium|playground|sports_centre|track)$"](${bb});
      relation["leisure"~"^(park|garden|stadium)$"](${bb});
      way["natural"~"^(water|wood|scrub|grassland|heath|sand|tree_row)$"](${bb});
      relation["natural"~"^(water|wood|scrub)$"](${bb});
      way["waterway"~"^(river|riverbank|canal|stream)$"](${bb});
      relation["waterway"="riverbank"](${bb});
      way["amenity"="parking"](${bb});
      way["place"="square"](${bb});
      way["area:highway"](${bb});
    );
    out geom;`,
  trees: `[out:json][timeout:120];
    node["natural"="tree"](${bb});
    out body;`,
  pois: `[out:json][timeout:180];
    (
      nwr["amenity"~"^(hospital|university|college|townhall|marketplace|bus_station|place_of_worship|theatre|library|school)$"]["name"](${bb});
      nwr["tourism"~"^(attraction|museum)$"]["name"](${bb});
      nwr["historic"]["name"](${bb});
      nwr["leisure"~"^(stadium|park|sports_centre)$"]["name"](${bb});
      nwr["shop"="mall"]["name"](${bb});
      nwr["railway"~"^(station|halt)$"]["name"](${bb});
    );
    out center tags;`,
  transit: `[out:json][timeout:240];
    relation["route"="bus"](${bb});
    out body;
    node["highway"="bus_stop"](${bb});
    out body;`,
  railways: `[out:json][timeout:120];
    way["railway"~"^(rail|light_rail)$"](${bb});
    out geom;`,
};

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runQuery(name, query) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const t0 = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'elche-traffic-sim/0.1 (simulador de trafico educativo)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
      const text = await res.text();
      const json = JSON.parse(text);
      if (json.remark && /error|runtime/i.test(json.remark)) throw new Error(json.remark);
      console.log(`  ${name}: ${json.elements.length} elementos, ${(text.length / 1e6).toFixed(1)} MB en ${((Date.now() - t0) / 1000).toFixed(1)} s (${url})`);
      return text;
    } catch (err) {
      lastErr = err;
      console.warn(`  ${name}: intento ${attempt + 1} fallido: ${err.message}`);
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Divide el bbox en n×n teselas, descarga cada una y elimina duplicados.
async function runTiled(name, { tiles, build }) {
  const seen = new Set();
  const elements = [];
  const dLat = (BBOX.north - BBOX.south) / tiles;
  const dLon = (BBOX.east - BBOX.west) / tiles;
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const s = BBOX.south + i * dLat;
      const w = BBOX.west + j * dLon;
      const b = `${s.toFixed(5)},${w.toFixed(5)},${(s + dLat).toFixed(5)},${(w + dLon).toFixed(5)}`;
      const json = JSON.parse(await runQuery(`${name}[${i},${j}]`, build(b)));
      for (const el of json.elements) {
        const key = el.type + el.id;
        if (seen.has(key)) continue;
        seen.add(key);
        elements.push(el);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return JSON.stringify({ elements });
}

await mkdir(outDir, { recursive: true });
console.log(`Descargando OSM para bbox ${bb} en ${outDir}`);
for (const [name, query] of Object.entries(QUERIES)) {
  const path = join(outDir, `${name}.json`);
  if (!force && (await exists(path))) {
    console.log(`  ${name}: ya existe, se omite (usa --force para repetir)`);
    continue;
  }
  const text = typeof query === 'string' ? await runQuery(name, query) : await runTiled(name, query);
  await writeFile(path, text);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('Descarga completada.');
