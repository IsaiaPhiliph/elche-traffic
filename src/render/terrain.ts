// Relieve del terreno (MDT05 del IGN, rejilla de 10 m ajustada a las calles): consulta de alturas
// e intersección de rayos para la selección con el ratón.
import * as THREE from 'three';

export interface TerrainJSON {
  source: string;
  datum: number;
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  min: number;
  max: number;
}

export class Terrain {
  readonly h: Float32Array;
  readonly x0: number;
  readonly z0: number;
  readonly step: number;
  readonly nx: number;
  readonly nz: number;
  readonly min: number;
  readonly max: number;
  readonly datum: number;

  constructor(meta: TerrainJSON | null, bin: ArrayBuffer | null) {
    if (!meta || !bin) {
      // Sin MDT: terreno plano a cota 0.
      this.x0 = -1;
      this.z0 = -1;
      this.step = 1;
      this.nx = this.nz = 2;
      this.h = new Float32Array(4);
      this.min = this.max = this.datum = 0;
      return;
    }
    this.x0 = meta.x0;
    this.z0 = meta.z0;
    this.step = meta.step;
    this.nx = meta.nx;
    this.nz = meta.nz;
    this.min = meta.min;
    this.max = meta.max;
    this.datum = meta.datum;
    const raw = new Int16Array(bin);
    this.h = Float32Array.from(raw, (v) => v / 100);
  }

  get flat() {
    return this.nx <= 2;
  }

  /** Extensión cubierta por la rejilla. */
  get extent() {
    return { minX: this.x0, minZ: this.z0, maxX: this.x0 + (this.nx - 1) * this.step, maxZ: this.z0 + (this.nz - 1) * this.step };
  }

  heightAt(x: number, z: number): number {
    if (this.flat) return 0;
    const fx = Math.min(this.nx - 1.0001, Math.max(0, (x - this.x0) / this.step));
    const fz = Math.min(this.nz - 1.0001, Math.max(0, (z - this.z0) / this.step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const k = j * this.nx + i;
    const a = this.h[k];
    const b = this.h[k + 1];
    const c = this.h[k + this.nx];
    const d = this.h[k + this.nx + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** Primer punto del rayo que toca el terreno (marcha a pasos y bisección final). */
  raycast(ray: THREE.Ray, out: THREE.Vector3, maxDist = 60000): boolean {
    const o = ray.origin;
    const d = ray.direction;
    let t = 0;
    // Empieza donde el rayo baja de la cota máxima.
    if (o.y > this.max + 1) {
      if (d.y >= 0) return false;
      t = (o.y - this.max - 1) / -d.y;
    }
    const horiz = Math.hypot(d.x, d.z);
    const dt = Math.min(3 / Math.max(horiz, 1e-3), 1.5 / Math.max(Math.abs(d.y), 1e-3));
    let prev = t;
    for (; t < maxDist; t += dt) {
      const y = o.y + d.y * t;
      if (y <= this.heightAt(o.x + d.x * t, o.z + d.z * t)) {
        let lo = prev;
        let hi = t;
        for (let k = 0; k < 20; k++) {
          const m = (lo + hi) / 2;
          if (o.y + d.y * m <= this.heightAt(o.x + d.x * m, o.z + d.z * m)) hi = m;
          else lo = m;
        }
        ray.at(hi, out);
        return true;
      }
      if (y < this.min - 1) break;
      prev = t;
    }
    return false;
  }
}
