// Descarga los edificios INSPIRE del Catastro para Elche (municipio 03065) y los descomprime.
// Uso: node scripts/fetch-catastro.mjs <carpeta-destino>
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const outDir = process.argv[2] ?? 'data/raw/catastro';
const URL = 'https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/03/03065-ELCHE%20ELX/A.ES.SDGC.BU.03065.zip';
const zipPath = join(outDir, 'A.ES.SDGC.BU.03065.zip');
const gml = join(outDir, 'A.ES.SDGC.BU.03065.buildingpart.gml');

if (await stat(gml).then(() => true, () => false)) {
  console.log('El Catastro ya está descargado:', gml);
  process.exit(0);
}
await mkdir(outDir, { recursive: true });
console.log('Descargando', URL);
const res = await fetch(URL, { headers: { 'User-Agent': 'elche-traffic-sim/0.1' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(zipPath, buf);
console.log(`  ${(buf.length / 1e6).toFixed(1)} MB → ${zipPath}`);
try {
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', outDir], { stdio: 'inherit' });
  console.log('Descomprimido en', outDir);
} catch {
  console.error('No se pudo ejecutar «unzip». Descomprime a mano el fichero en', outDir);
  process.exit(1);
}
