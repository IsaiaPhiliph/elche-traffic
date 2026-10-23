// Etiquetas HTML de los lugares emblemáticos sobre la escena.
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { POI } from './data';
import type { Terrain } from './terrain';

export class Labels {
  readonly renderer = new CSS2DRenderer();
  readonly group = new THREE.Group();
  private items: { obj: CSS2DObject; el: HTMLElement; imp: number; w: number; h: number }[] = [];
  private placed: number[] = [];
  private v = new THREE.Vector3();

  constructor(private container: HTMLElement, pois: POI[], private terrain: Terrain) {
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    Object.assign(this.renderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', () => this.renderer.setSize(container.clientWidth, container.clientHeight));
    for (const p of pois.filter((p) => p.imp >= 5)) {
      const el = document.createElement('div');
      el.className = 'poi-label' + (p.imp < 7 ? ' minor' : '');
      el.innerHTML = `<i></i>${p.name}`;
      const obj = new CSS2DObject(el);
      obj.position.set(p.x, terrain.heightAt(p.x, p.z) + 24, p.z);
      this.group.add(obj);
      this.items.push({ obj, el, imp: p.imp, w: 0, h: 0 });
    }
    // Los más importantes primero: ganan cuando dos etiquetas se pisan.
    this.items.sort((a, b) => b.imp - a.imp);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, hidden = false) {
    if (!this.group.visible) return;
    const camPos = camera.position;
    // A ras de suelo las etiquetas lejanas atravesarían los edificios: solo las cercanas.
    const low = camPos.y - this.terrain.heightAt(camPos.x, camPos.z) < 140;
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    const placed = this.placed;
    placed.length = 0;
    for (const it of this.items) {
      const d = it.obj.position.distanceTo(camPos);
      // Los secundarios solo se muestran al acercarse.
      let maxD = it.imp >= 8 ? 16000 : it.imp >= 7 ? 4500 : 2500;
      if (low) maxD = Math.min(maxD, 450);
      if (hidden) maxD = 0;
      const o = d > maxD ? 0 : d > maxD * 0.7 ? (maxD - d) / (maxD * 0.3) : 1;
      let show = o > 0.02;
      if (show) {
        // Desde lejos el centro histórico amontona etiquetas: se ocultan las que pisan a otra.
        const p = this.v.copy(it.obj.position).project(camera);
        const x = (p.x * 0.5 + 0.5) * W;
        const y = (0.5 - p.y * 0.5) * H;
        if (!it.w) {
          it.w = it.el.offsetWidth;
          it.h = it.el.offsetHeight;
        }
        const hw = it.w / 2 + 3;
        const hh = it.h / 2 + 2;
        for (let k = 0; k < placed.length && show; k += 4) {
          if (Math.abs(x - placed[k]) < hw + placed[k + 2] && Math.abs(y - placed[k + 1]) < hh + placed[k + 3]) show = false;
        }
        if (show && p.z < 1) placed.push(x, y, hw, hh);
      }
      it.el.style.opacity = o.toFixed(2);
      it.obj.visible = show;
    }
    this.renderer.render(scene, camera);
  }

  setVisible(v: boolean) {
    this.group.visible = v;
    this.renderer.domElement.style.display = v ? '' : 'none';
  }
}
