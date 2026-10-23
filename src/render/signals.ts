// Semáforos: báculo, cabeza y lámpara con el color del estado actual de cada acceso.
import * as THREE from 'three';
import type { Roads } from './roads';

const COLORS = [new THREE.Color(0x2bff6a), new THREE.Color(0xffb21e), new THREE.Color(0xff2a1a), new THREE.Color(0xffb21e)];

export class SignalViews {
  readonly group = new THREE.Group();
  private lamps: THREE.InstancedMesh;
  private glow: THREE.Points;
  private glowCol: Float32Array;
  readonly heads: Int32Array;
  readonly positions: Float32Array;
  private states: Uint8Array;
  private blink = 0;

  constructor(heads: Int32Array, roads: Roads) {
    this.heads = heads;
    const n = heads.length;
    this.positions = new Float32Array(n * 3);
    this.states = new Uint8Array(n).fill(2);
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 3.3, 6);
    poleGeo.translate(0, 1.65, 0);
    const headGeo = new THREE.BoxGeometry(0.34, 0.95, 0.3);
    const lampGeo = new THREE.SphereGeometry(0.2, 10, 8);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0x3c4046 }), n);
    const boxes = new THREE.InstancedMesh(headGeo, new THREE.MeshLambertMaterial({ color: 0x1c1e21 }), n);
    this.lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), n);
    const glowPos = new Float32Array(n * 3);
    this.glowCol = new Float32Array(n * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) {
      const end = roads.edgeEnd(heads[i]);
      if (!end) continue;
      // A la derecha del sentido de circulación, en la línea de detención.
      const back = 4.2;
      const x = end.x - end.dz * (end.hw + 0.9) - end.dx * back;
      const z = end.z + end.dx * (end.hw + 0.9) - end.dz * back;
      const y = end.y + 0.18;
      this.positions.set([x, y, z], 3 * i);
      q.setFromAxisAngle(up, -Math.atan2(end.dz, end.dx));
      m.compose(new THREE.Vector3(x, y, z), q, one);
      poles.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 3.0, z), q, one);
      boxes.setMatrixAt(i, m);
      // La lámpara mira al tráfico que llega.
      m.compose(new THREE.Vector3(x - end.dx * 0.16, y + 3.0, z - end.dz * 0.16), q, one);
      this.lamps.setMatrixAt(i, m);
      this.lamps.setColorAt(i, COLORS[2]);
      glowPos.set([x - end.dx * 0.3, y + 3.0, z - end.dz * 0.3], 3 * i);
    }
    poles.castShadow = true;
    boxes.castShadow = true;
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
    gg.setAttribute('color', new THREE.BufferAttribute(this.glowCol, 3));
    this.glow = new THREE.Points(gg, new THREE.PointsMaterial({ size: 5, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, map: dotTexture() }));
    this.group.add(poles, boxes, this.lamps, this.glow);
    this.apply();
  }

  setStates(st: Uint8Array) {
    this.states.set(st.subarray(0, this.states.length));
    this.apply();
  }

  /** Parpadeo del ámbar cuando los semáforos están apagados. */
  tick(dt: number) {
    this.blink += dt;
    if (this.states.length && this.states[0] === 3) this.apply();
  }

  private apply() {
    const on = Math.floor(this.blink * 1.6) % 2 === 0;
    for (let i = 0; i < this.states.length; i++) {
      const s = this.states[i];
      const c = s === 3 && !on ? new THREE.Color(0x2a2010) : COLORS[Math.min(3, s)] ?? COLORS[2];
      this.lamps.setColorAt(i, c);
      this.glowCol.set([c.r * 0.9, c.g * 0.9, c.b * 0.9], 3 * i);
    }
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
    (this.glow.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  nearest(x: number, z: number, radius: number): number {
    let best = -1;
    let bd = radius * radius;
    for (let i = 0; i < this.heads.length; i++) {
      const dx = this.positions[3 * i] - x;
      const dz = this.positions[3 * i + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) [bd, best] = [d, i];
    }
    return best;
  }

  stateOf(i: number) {
    return this.states[i];
  }
}

function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.4)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
