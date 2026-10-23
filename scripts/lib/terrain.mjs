// Modelo digital del terreno: lectura de las teselas ASCII Grid del MDT05 (IGN), suavizado y
// muestreo en coordenadas locales; y la rejilla de alturas que usa el render, ajustada a las calles.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function parseAsc(text) {
  const head = {};
  let pos = 0;
  // Cabecera: pares «clave valor» hasta el primer número.
  for (;;) {
    const m = /^\s*([A-Za-z_]+)\s+(\S+)/.exec(text.slice(pos, pos + 200));
    if (!m) break;
    head[m[1].toLowerCase()] = parseFloat(m[2]);
    pos += m[0].length;
  }
  const nx = head.ncols;
  const ny = head.nrows;
  const vals = new Float32Array(nx * ny);
  const body = text.slice(pos);
  let k = 0;
  let i = 0;
  const L = body.length;
  while (k < vals.length && i < L) {
    while (i < L && body.charCodeAt(i) <= 32) i++;
    let j = i;
    while (j < L && body.charCodeAt(j) > 32) j++;
    if (j > i) vals[k++] = +body.slice(i, j);
    i = j;
  }
  const cx = head.cellsize ?? head.dx;
  const cy = head.cellsize ?? head.dy;
  return { nx, ny, x0: head.xllcorner, y0: head.yllcorner, cx, cy, nodata: head.nodata_value ?? -9999, vals };
}

/** Desenfoque de caja separable (dos pasadas ≈ gaussiano): elimina el escalonado de 1 m del MDT. */
function blur(src, nx, ny, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const pass = (a, b, horiz) => {
    const n = horiz ? nx : ny;
    const m = horiz ? ny : nx;
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0;
        let c = 0;
        for (let d = -r; d <= r; d++) {
          const q = i + d;
          if (q < 0 || q >= n) continue;
          s += a[horiz ? j * nx + q : q * nx + j];
          c++;
        }
        b[horiz ? j * nx + i : i * nx + j] = s / c;
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  pass(out, tmp, true);
  pass(tmp, out, false);
  return out;
}

/**
 * Carga el MDT de `dir` y devuelve un muestreador de altura (m sobre el nivel del mar) en
 * coordenadas locales, o null si no hay teselas.
 */
export async function loadTerrain(dir, origin, project) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.asc'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const tiles = await Promise.all(files.map(async (f) => parseAsc(await readFile(join(dir, f), 'utf8'))));
  // Mosaico: todas las teselas comparten el paso de malla.
  const cx = tiles[0].cx;
  const cy = tiles[0].cy;
  const west = Math.min(...tiles.map((t) => t.x0));
  const south = Math.min(...tiles.map((t) => t.y0));
  const east = Math.max(...tiles.map((t) => t.x0 + t.nx * cx));
  const north = Math.max(...tiles.map((t) => t.y0 + t.ny * cy));
  const nx = Math.round((east - west) / cx);
  const ny = Math.round((north - south) / cy);
  const grid = new Float32Array(nx * ny).fill(NaN);
  for (const t of tiles) {
    const c0 = Math.round((t.x0 - west) / cx);
    const r0 = Math.round((north - (t.y0 + t.ny * cy)) / cy); // fila 0 = norte
    for (let r = 0; r < t.ny; r++) {
      for (let c = 0; c < t.nx; c++) {
        const v = t.vals[r * t.nx + c];
        if (v <= t.nodata + 1) continue;
        const R = r0 + r;
        const C = c0 + c;
        if (R >= 0 && R < ny && C >= 0 && C < nx) grid[R * nx + C] = v;
      }
    }
  }
  // Huecos sin dato: el valor válido más cercano en la fila.
  let last = 0;
  for (let k = 0; k < grid.length; k++) if (Number.isFinite(grid[k])) {
    last = grid[k];
    break;
  }
  for (let k = 0; k < grid.length; k++) {
    if (Number.isFinite(grid[k])) last = grid[k];
    else grid[k] = last;
  }
  const smooth = blur(grid, nx, ny, 3);
  // Proyección lineal: se invierte con dos puntos de referencia.
  const mLon = project(origin.lat, origin.lon + 1)[0];
  const mLat = -project(origin.lat + 1, origin.lon)[1];
  const raw = (lat, lon) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (lon - west) / cx - 0.5));
    const fy = Math.min(ny - 1.001, Math.max(0, (north - lat) / cy - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const a = smooth[j * nx + i];
    const b = smooth[j * nx + i + 1];
    const c = smooth[(j + 1) * nx + i];
    const d = smooth[(j + 1) * nx + i + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const at = (x, z) => raw(origin.lat - z / mLat, origin.lon + x / mLon);
  const sw = project(south, west);
  const ne = project(north, east);
  return {
    at,
    extent: { minX: sw[0], maxX: ne[0], minZ: ne[1], maxZ: sw[1] },
    cellX: cx * mLon,
    cellZ: cy * mLat,
  };
}

/**
 * Rejilla regular de alturas para el render (paso `step` m), relativa a `datum`. Bajo las calles
 * el terreno se iguala a la rasante para que la calzada no quede enterrada ni flotando; en los
 * pasos inferiores se mantiene la cota de la superficie (la trinchera se recorta en el render).
 */
export function buildHeightGrid(terrain, datum, segs, step) {
  const { minX, maxX, minZ, maxZ } = terrain.extent;
  const x0 = Math.ceil(minX / step) * step;
  const z0 = Math.ceil(minZ / step) * step;
  const nx = Math.floor((maxX - x0) / step) + 1;
  const nz = Math.floor((maxZ - z0) / step) + 1;
  const h = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = terrain.at(x0 + i * step, z0 + j * step) - datum;
  // Peso de cada calle en cada nudo de la rejilla (1 bajo la calzada y las aceras, 0 a BLEND m).
  const BLEND = 9;
  const wBest = new Float32Array(nx * nz);
  const target = new Float32Array(nx * nz);
  for (const s of segs) {
    // Ni los puentes ni los túneles tocan la superficie: bajo uno y sobre otro manda el terreno.
    if (s.bridge || s.tunnel) continue;
    const P = s.tpts;
    const core = s.width / 2 + 3.5;
    const R = core + BLEND;
    for (let k = 1; k < P.length; k++) {
      const [ax, az, ay, ar] = P[k - 1];
      const [bx, bz, by, br] = P[k];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - x0) / step));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + R - x0) / step));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R - z0) / step));
      const j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz) + R - z0) / step));
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = x0 + i * step;
          const pz = z0 + j * step;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
          const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
          if (d >= R) continue;
          const w = d <= core ? 1 : 1 - (d - core) / BLEND;
          const q = j * nx + i;
          if (w <= wBest[q]) continue;
          wBest[q] = w;
          // Rasante (o superficie sobre el paso inferior: la cota sin el desnivel).
          const y = ay + (by - ay) * t;
          const rel = ar + (br - ar) * t;
          target[q] = (rel < -0.4 ? y - rel : y) - 0.12;
        }
      }
    }
  }
  for (let q = 0; q < h.length; q++) {
    const w = wBest[q];
    if (w > 0) {
      const k = w * w * (3 - 2 * w);
      h[q] += (target[q] - h[q]) * k;
    }
  }
  return { x0, z0, step, nx, nz, h };
}
