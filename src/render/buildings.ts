// Edificios extruidos por teselas (para descartar lo que queda fuera de cámara).
// Las ventanas se generan en el sombreador a partir de la posición en la fachada.
import * as THREE from 'three';
import earcut from 'earcut';
import type { BuildingsJSON } from './data';

const TILE = 450;

const VERT_HEAD = /* glsl */ `
attribute float aSeed;
varying vec3 vWPos;
varying vec3 vWN;
varying float vSeed;
`;
const FRAG_HEAD = /* glsl */ `
uniform float uNight;
varying vec3 vWPos;
varying vec3 vWN;
varying float vSeed;
// Hash entero: estable aunque las coordenadas sean grandes (sin ruido por píxel).
float h21(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 65536);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h *= 0x9E3779B9u;
  h ^= h >> 16;
  return float(h) / 4294967295.0;
}
`;
const FRAG_BODY = /* glsl */ `
{
  vec3 wn = normalize(vWN);
  float sd = floor(vSeed * 255.0 + 0.5);
  if (abs(wn.y) < 0.5) {
    vec2 t = normalize(vec2(-wn.z, wn.x));
    float u = dot(vWPos.xz, t);
    float y = vWPos.y;
    float floorH = 3.05;
    float ground = 3.4;
    float lit = 0.0;
    float win = 0.0;
    if (y > ground) {
      float fy = (y - ground) / floorH;
      float fi = floor(fy);
      float ly = fract(fy);
      float cu = u / 3.3;
      float cell = floor(cu);
      float lu = fract(cu);
      win = step(0.32, ly) * step(ly, 0.86) * step(0.22, lu) * step(lu, 0.78);
      float r = h21(vec2(cell + sd * 7.0, fi + sd * 13.0));
      lit = win * step(0.58, r);
      // Persianas: parte de las ventanas cerradas de día.
      win *= mix(1.0, 0.55, step(0.75, r));
    } else if (y > 0.4) {
      // Planta baja: escaparates y portales.
      float cu = u / 5.5;
      float lu = fract(cu);
      win = step(0.08, lu) * step(lu, 0.82) * step(y, 2.9);
      lit = win * step(0.45, h21(vec2(floor(cu) + sd * 5.0, 7.0)));
    }
    // A distancia, el patrón de ventanas se sustituye por su valor medio (sin parpadeo).
    float fw = fwidth(u) / 3.3 + fwidth(y) / floorH;
    float detail = 1.0 - smoothstep(0.35, 0.9, fw);
    win = mix(0.22, win, detail);
    lit = mix(0.1, lit, detail);
    vec3 glass = vec3(0.16, 0.2, 0.25);
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * mix(0.72, 0.9, uNight));
    vec3 warm = mix(vec3(1.0, 0.66, 0.34), vec3(0.98, 0.86, 0.62), step(0.55, h21(vec2(sd, floor(y)))));
    nightGlow = lit * uNight * warm * (y < ground ? 1.25 : 0.85);
  }
}
`;

export function buildBuildings(data: BuildingsJSON, night: { value: number }): THREE.Group {
  const group = new THREE.Group();
  group.name = 'buildings';
  const palette = data.palette.map((c) => new THREE.Color(c));
  const roofTint = new THREE.Color(0xb7b0a4);
  const tiles = new Map<string, { pos: number[]; col: number[]; nrm: number[]; seed: number[]; idx: number[] }>();
  const d = data.data;
  let i = 0;
  let bid = 0;
  const tmp = new THREE.Color();
  while (i < d.length) {
    const h = d[i] / 10;
    const minH = d[i + 1] / 10;
    const color = palette[d[i + 2]] ?? palette[0];
    i += 4;
    const nr = d[i++];
    const lens = d.slice(i, i + nr);
    i += nr;
    const rings: number[][] = [];
    for (const l of lens) {
      const r: number[] = [];
      for (let k = 0; k < l; k++) r.push(d[i + 2 * k] / 10, d[i + 2 * k + 1] / 10);
      rings.push(r);
      i += 2 * l;
    }
    const outer = rings[0];
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < outer.length; k += 2) {
      cx += outer[k];
      cz += outer[k + 1];
    }
    cx /= outer.length / 2;
    cz /= outer.length / 2;
    const key = `${Math.floor(cx / TILE)}:${Math.floor(cz / TILE)}`;
    let T = tiles.get(key);
    if (!T) tiles.set(key, (T = { pos: [], col: [], nrm: [], seed: [], idx: [] }));
    const seed = (bid++ * 0.618034) % 1;
    // Fachadas
    for (const r of rings) {
      const n = r.length / 2;
      for (let k = 0; k < n; k++) {
        const ax = r[2 * k];
        const az = r[2 * k + 1];
        const bx = r[(2 * k + 2) % r.length];
        const bz = r[(2 * k + 3) % r.length];
        const base = T.pos.length / 3;
        T.pos.push(ax, minH, az, bx, minH, bz, bx, h, bz, ax, h, az);
        // Oscurece un poco la base (suciedad) frente a la parte alta.
        tmp.copy(color).multiplyScalar(0.86);
        T.col.push(tmp.r, tmp.g, tmp.b, tmp.r, tmp.g, tmp.b, color.r, color.g, color.b, color.r, color.g, color.b);
        // Normal exterior (anillos exteriores antihorarios en x-z): (dz, -dx).
        const ex = bx - ax;
        const ez = bz - az;
        const el = Math.hypot(ex, ez) || 1;
        const nx = Math.round((ez / el) * 127);
        const nz = Math.round((-ex / el) * 127);
        T.nrm.push(nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz);
        T.seed.push(seed, seed, seed, seed);
        T.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
    // Cubierta plana (azoteas)
    const flat: number[] = [];
    const holes: number[] = [];
    for (let k = 0; k < rings.length; k++) {
      if (k > 0) holes.push(flat.length / 2);
      flat.push(...rings[k]);
    }
    const tris = earcut(flat, holes, 2);
    const base = T.pos.length / 3;
    tmp.copy(color).lerp(roofTint, 0.55).multiplyScalar(0.92);
    for (let k = 0; k < flat.length; k += 2) {
      T.pos.push(flat[k], h, flat[k + 1]);
      T.col.push(tmp.r, tmp.g, tmp.b);
      T.nrm.push(0, 127, 0);
      T.seed.push(seed);
    }
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k];
      const b = tris[k + 1];
      const c = tris[k + 2];
      const cr = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * b + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
      if (cr < 0) T.idx.push(base + a, base + b, base + c);
      else T.idx.push(base + a, base + c, base + b);
    }
  }

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = night;
    sh.vertexShader = VERT_HEAD + sh.vertexShader.replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normal; vSeed = aSeed;',
    );
    sh.fragmentShader = FRAG_HEAD + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\nvec3 nightGlow = vec3(0.0);\n' + FRAG_BODY)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += nightGlow + diffuseColor.rgb * uNight * 0.05;');
  };
  for (const T of tiles.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(T.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(Uint8Array.from(T.col, (v) => Math.round(v * 255)), 3, true));
    geo.setAttribute('normal', new THREE.BufferAttribute(Int8Array.from(T.nrm), 3, true));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(Uint8Array.from(T.seed, (v) => Math.round(v * 255)), 1, true));
    geo.setIndex(T.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(T.idx, 1) : new THREE.Uint16BufferAttribute(T.idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
