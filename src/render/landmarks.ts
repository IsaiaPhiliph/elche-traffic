// Detalles de los monumentos más reconocibles que la huella del edificio no recoge.
import * as THREE from 'three';
import type { POI } from './data';

const STONE = 0xcdb084;

/** Basílica de Santa María: cúpula de teja vidriada azul y campanario. */
function basilica(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const stone = new THREE.MeshLambertMaterial({ color: STONE });
  const tiles = new THREE.MeshPhongMaterial({ color: 0x2c6cb3, shininess: 90, specular: 0x557799 });
  // Cúpula sobre el crucero (hacia la cabecera, al este).
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 6, 16), stone);
  drum.position.set(x + 17, 25, z);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(8.8, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), tiles);
  dome.position.set(x + 17, 28, z);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.6, 4, 8), stone);
  lantern.position.set(x + 17, 38.5, z);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(1.8, 2.6, 8), tiles);
  cap.position.set(x + 17, 41.8, z);
  // Campanario a los pies del templo.
  const tower = new THREE.Mesh(new THREE.BoxGeometry(7.5, 36, 7.5), stone);
  tower.position.set(x - 30, 18, z - 14);
  const belfry = new THREE.Mesh(new THREE.BoxGeometry(8.1, 5, 8.1), new THREE.MeshLambertMaterial({ color: 0xb79c70 }));
  belfry.position.set(x - 30, 33.5, z - 14);
  const top = new THREE.Mesh(new THREE.ConeGeometry(4.6, 5, 4), tiles);
  top.rotation.y = Math.PI / 4;
  top.position.set(x - 30, 38.5, z - 14);
  for (const m of [drum, dome, lantern, cap, tower, belfry, top]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

export function buildLandmarks(pois: POI[]): THREE.Group {
  const g = new THREE.Group();
  const b = pois.find((p) => /Basílica de Santa María/.test(p.name));
  if (b) g.add(basilica(b.x, b.z));
  return g;
}
