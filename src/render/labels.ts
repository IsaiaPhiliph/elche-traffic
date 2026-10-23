// Etiquetas HTML de los lugares emblemáticos sobre la escena.
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { POI } from './data';

export class Labels {
  readonly renderer = new CSS2DRenderer();
  readonly group = new THREE.Group();
  private items: { obj: CSS2DObject; el: HTMLElement; imp: number }[] = [];

  constructor(container: HTMLElement, pois: POI[]) {
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    Object.assign(this.renderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', () => this.renderer.setSize(container.clientWidth, container.clientHeight));
    for (const p of pois.filter((p) => p.imp >= 5)) {
      const el = document.createElement('div');
      el.className = 'poi-label' + (p.imp < 7 ? ' minor' : '');
      el.innerHTML = `<i></i>${p.name}`;
      const obj = new CSS2DObject(el);
      obj.position.set(p.x, 24, p.z);
      this.group.add(obj);
      this.items.push({ obj, el, imp: p.imp });
    }
  }

  render(scene: THREE.Scene, camera: THREE.Camera, hidden = false) {
    if (!this.group.visible) return;
    const camPos = camera.position;
    // A ras de suelo las etiquetas lejanas atravesarían los edificios: solo las cercanas.
    const low = camPos.y < 140;
    for (const it of this.items) {
      const d = it.obj.position.distanceTo(camPos);
      // Los secundarios solo se muestran al acercarse.
      let maxD = it.imp >= 8 ? 9000 : it.imp >= 7 ? 4500 : 2500;
      if (low) maxD = Math.min(maxD, 450);
      if (hidden) maxD = 0;
      const o = d > maxD ? 0 : d > maxD * 0.7 ? (maxD - d) / (maxD * 0.3) : 1;
      it.el.style.opacity = o.toFixed(2);
      it.obj.visible = o > 0.02;
    }
    this.renderer.render(scene, camera);
  }

  setVisible(v: boolean) {
    this.group.visible = v;
    this.renderer.domElement.style.display = v ? '' : 'none';
  }
}
