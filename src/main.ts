import './ui/styles.css';
import * as THREE from 'three';
import { SceneManager, shared } from './render/scene';
import { loadCity, type CityData } from './render/data';
import { buildGround } from './render/ground';
import { Roads } from './render/roads';
import { buildBuildings } from './render/buildings';
import { buildVegetation } from './render/vegetation';
import { Vehicles } from './render/vehicles';
import { SignalViews } from './render/signals';
import { Labels } from './render/labels';
import { buildLandmarks } from './render/landmarks';
import { Chart } from './ui/chart';
import type { EdgeInfo, FromWorker, ReadyInfo, ToWorker } from './sim/protocol';
import type { SimStats, VehicleInfo } from './sim/simulation';
import type { DemandEvent } from './sim/demand';
import { VEHICLE_KINDS } from './sim/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DATA = import.meta.env.BASE_URL + 'data/';
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MIX_COLORS = ['#47c27a', '#3aa3d8', '#f2b33d', '#e5533d', '#b07cf0'];

const fmtTime = (t: number) => {
  const m = Math.floor((((t % 86400) + 86400) % 86400) / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const fmtInt = (v: number) => Math.round(v).toLocaleString('es-ES');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function progress(f: number, label: string) {
  $('loading-bar').style.width = `${Math.round(f * 100)}%`;
  $('loading-step').textContent = label;
}

// ------------------------------------------------------------------ estado de la aplicación
const state = {
  running: true,
  speed: 10,
  simTime: 8 * 3600,
  tool: 'inspect' as 'inspect' | 'close',
  selected: null as null | { type: 'vehicle'; id: number } | { type: 'edge'; id: number; seg: number } | { type: 'signal'; i: number },
  follow: false,
  driver: false,
  closed: new Set<number>(),
  events: [] as DemandEvent[],
  zbe: false,
  draggingHour: false,
};

let worker: Worker;
const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);

async function main() {
  progress(0.02, 'Descargando datos de Elche…');
  const city = await loadCity(DATA, (f, label) => progress(0.05 + f * 0.33, `${label} cargado`));
  const viewport = $('viewport');
  const sm = new SceneManager(viewport);

  // El worker arranca en paralelo con la generación de geometría.
  worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
  let ready: ReadyInfo | null = null;
  const readyPromise = new Promise<ReadyInfo>((resolve, reject) => {
    worker.addEventListener('message', function onMsg(ev: MessageEvent<FromWorker>) {
      if (ev.data.type === 'ready') {
        worker.removeEventListener('message', onMsg);
        resolve(ev.data.info);
      } else if (ev.data.type === 'error') reject(new Error(ev.data.message));
    });
  });
  send({ type: 'init', url: new URL(DATA + 'network.json', location.href).href });

  const ext = extentOf(city);
  progress(0.42, 'Pintando el terreno y el Palmeral…');
  await nextFrame();
  sm.scene.add(buildGround(city.areas, city.roads, ext, sm.renderer.capabilities.maxTextureSize));
  progress(0.52, 'Trazando 490 km de calles…');
  await nextFrame();
  const nEdges = city.roads.segments.reduce((m, s) => Math.max(m, s.eF, s.eB), 0) + 1;
  const roads = new Roads(city.roads, nEdges, shared.uNight);
  sm.scene.add(roads.group);
  progress(0.62, `Levantando ${fmtInt(city.buildings.count)} edificios del Catastro…`);
  await nextFrame();
  const buildings = buildBuildings(city.buildings, shared.uNight);
  buildings.add(buildLandmarks(city.pois));
  sm.scene.add(buildings);
  progress(0.74, `Plantando ${fmtInt(city.trees.count)} palmeras y árboles…`);
  await nextFrame();
  const trees = buildVegetation(city.trees);
  sm.scene.add(trees);
  const labels = new Labels(viewport, city.pois);
  sm.scene.add(labels.group);
  progress(0.86, 'Calentando la simulación (15 min de tráfico)…');
  ready = await readyPromise;
  const vehicles = new Vehicles(shared.uNight, ready.bus.map((b) => b.color));
  sm.scene.add(vehicles.group);
  const signals = new SignalViews(ready.heads, roads);
  sm.scene.add(signals.group);
  const zbeMesh = buildZbe(ready.zbe);
  zbeMesh.visible = false;
  sm.scene.add(zbeMesh);
  progress(1, 'Listo');
  setTimeout(() => $('loading').classList.add('done'), 250);

  // Acceso de depuración desde la consola en desarrollo.
  if (import.meta.env.DEV) Object.assign(window, { __elx: { sm, roads, vehicles, signals, city, state, send } });
  const chart = new Chart($<HTMLCanvasElement>('chart'));
  let frameT = 0;

  // ---------------------------------------------------------------- mensajes del worker
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'frame': {
        const now = performance.now();
        if (msg.n > 0 || msg.buf.length) vehicles.pushFrame(msg.buf, msg.n, now);
        if (msg.buf.byteLength) send({ type: 'buffer', buf: msg.buf }, [msg.buf.buffer]);
        if (msg.heads) signals.setStates(msg.heads);
        if (msg.heat) roads.setHeat(msg.heat);
        if (msg.stats) {
          updateStats(msg.stats);
          chart.push(msg.stats.time, msg.stats.vehicles, msg.stats.meanSpeed);
        }
        state.simTime = msg.t;
        frameT = msg.t;
        $('eff-speed').textContent = state.running ? `×${msg.eff < 10 ? msg.eff.toFixed(1) : Math.round(msg.eff)}` : '—';
        break;
      }
      case 'vehicleInfo':
        if (state.selected?.type === 'vehicle') {
          if (!msg.info) deselect();
          else {
            showVehicle(msg.info);
            roads.setRoute(msg.info.route);
          }
        }
        break;
      case 'edgeInfo':
        if (msg.info && state.selected?.type === 'edge') showEdge(msg.info);
        break;
      case 'error':
        console.error(msg.message);
        break;
    }
  };

  // ---------------------------------------------------------------- indicadores
  function updateStats(s: SimStats) {
    $('st-veh').textContent = fmtInt(s.vehicles);
    $('st-speed').textContent = s.meanSpeed.toFixed(1);
    $('st-thr').textContent = fmtInt(s.throughput);
    $('st-trip').textContent = s.avgTripMin.toFixed(1);
    $('st-delay').textContent = s.avgDelayMin.toFixed(1);
    $('st-stop').textContent = Math.round(s.stoppedShare * 100).toString();
    $('st-co2').textContent = (s.co2Rate / 1000).toFixed(1);
    $('st-dem').textContent = fmtInt(s.demandRate);
    const total = s.byKind.reduce((a, b) => a + b, 0) || 1;
    $('mix').innerHTML = s.byKind.map((n, k) => `<div style="width:${(100 * n) / total}%;background:${MIX_COLORS[k]}"></div>`).join('');
    $('mix-legend').innerHTML = s.byKind
      .map((n, k) => `<span><i style="background:${MIX_COLORS[k]}"></i>${VEHICLE_KINDS[k]} ${fmtInt(n)}</span>`)
      .join('');
  }

  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const season = $('in-season') as HTMLSelectElement;
  season.onchange = () => (sm.dayOfYear = +season.value);
  function updateClock() {
    $('clock-time').textContent = fmtTime(state.simTime);
    const d = new Date(2026, 0, sm.dayOfYear);
    const h = state.simTime / 3600;
    const period = h < 6 ? 'madrugada' : h < 12 ? 'mañana' : h < 15 ? 'mediodía' : h < 21 ? 'tarde' : 'noche';
    $('clock-sub').textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${period}${state.zbe ? ' · ZBE' : ''}`;
    if (!state.draggingHour) {
      ($('in-hour') as HTMLInputElement).value = String(h);
      $('out-hour').textContent = fmtTime(state.simTime);
    }
  }

  // ---------------------------------------------------------------- selección y ficha
  const info = $('infocard');
  const infoBody = $('info-body');
  function deselect() {
    state.selected = null;
    state.follow = false;
    state.driver = false;
    vehicles.selected = -1;
    roads.setRoute(null);
    info.hidden = true;
    sm.controls.enabled = true;
  }
  $('info-close').onclick = deselect;

  function showVehicle(v: VehicleInfo) {
    info.hidden = false;
    const waiting = v.waiting > 3 ? `<span class="pill amber">detenido ${Math.round(v.waiting)} s</span>` : `<span class="pill green">en marcha</span>`;
    infoBody.innerHTML = `
      <h4>${v.line ? `Autobús línea ${v.line}` : VEHICLE_KINDS[v.kind]} <span class="muted">#${v.id}</span></h4>
      <div class="sub">${v.street} ${waiting}</div>
      <dl>
        <dt>Velocidad</dt><dd>${v.speed.toFixed(0)} km/h</dd>
        <dt>Origen</dt><dd>${v.origin}</dd>
        <dt>Destino</dt><dd>${v.dest}</dd>
        <dt>Por recorrer</dt><dd>${v.remainingKm.toFixed(2)} km</dd>
        <dt>Llegada estimada</dt><dd>${v.etaMin < 1 ? '<1' : v.etaMin.toFixed(0)} min</dd>
        <dt>En ruta</dt><dd>${v.tripMin.toFixed(1)} min</dd>
        ${v.through ? '<dt>Tipo</dt><dd>tráfico de paso</dd>' : ''}
      </dl>
      <div class="actions">
        <button id="act-follow" class="${state.follow && !state.driver ? 'primary' : ''}">${state.follow && !state.driver ? 'Siguiendo' : 'Seguir'}</button>
        <button id="act-driver" class="${state.driver ? 'primary' : ''}">Vista conductor</button>
      </div>`;
    $('act-follow').onclick = () => {
      state.follow = !(state.follow && !state.driver);
      state.driver = false;
      sm.controls.enabled = true;
      showVehicle(v);
    };
    $('act-driver').onclick = () => {
      state.driver = !state.driver;
      state.follow = state.driver;
      sm.controls.enabled = !state.driver;
      showVehicle(v);
    };
  }

  function showEdge(e: EdgeInfo) {
    info.hidden = false;
    const seg = state.selected?.type === 'edge' ? state.selected.seg : -1;
    const closed = seg >= 0 && segmentEdges(seg).some((x) => state.closed.has(x));
    const sig = e.signal ? `<dt>Semáforo</dt><dd>${['verde', 'ámbar', 'rojo', 'apagado'][e.signal.state] ?? '—'} · ciclo ${e.signal.cycle} s</dd>` : '';
    infoBody.innerHTML = `
      <h4>${e.name}</h4>
      <div class="sub">${closed ? '<span class="pill red">cortada al tráfico</span>' : '<span class="pill">abierta</span>'}</div>
      <dl>
        <dt>Carriles en este sentido</dt><dd>${e.lanes}</dd>
        <dt>Límite</dt><dd>${e.speedLimit} km/h</dd>
        <dt>Longitud del tramo</dt><dd>${e.length.toFixed(0)} m</dd>
        <dt>Vehículos ahora</dt><dd>${e.vehicles}</dd>
        <dt>Velocidad media</dt><dd>${e.vehicles ? e.meanSpeed.toFixed(0) + ' km/h' : '—'}</dd>
        ${sig}
      </dl>
      <div class="actions"><button id="act-close" class="${closed ? 'primary' : 'danger'}">${closed ? 'Abrir al tráfico' : 'Cortar la calle'}</button></div>`;
    $('act-close').onclick = () => {
      toggleSegment(seg);
      send({ type: 'queryEdge', id: e.id });
    };
  }

  function showSignal(i: number) {
    const e = signals.heads[i];
    const st = signals.stateOf(i);
    info.hidden = false;
    const si = roads.segmentOf(e);
    const name = si >= 0 ? roads.segmentName(si, city.roads.names) : '';
    const label = ['Verde', 'Ámbar', 'Rojo', 'Apagado (ámbar intermitente)'][st] ?? '—';
    const cls = ['green', 'amber', 'red', 'amber'][st] ?? '';
    const mode = ($('in-sigmode') as HTMLSelectElement).selectedOptions[0].textContent;
    infoBody.innerHTML = `
      <h4>Semáforo · ${name || 'cruce'}</h4>
      <div class="sub"><span class="pill ${cls}">${label}</span></div>
      <dl>
        <dt>Regulador</dt><dd>#${ready!.headCtrl[i]}</dd>
        <dt>Modo</dt><dd>${mode}</dd>
        <dt>Ciclo</dt><dd>${($('in-cycle') as HTMLInputElement).value} s</dd>
      </dl>
      <p class="hint">Cambia el modo o el ciclo en el panel «Semáforos» para ver su efecto en las colas.</p>`;
  }

  function segmentEdges(seg: number) {
    const s = city.roads.segments[seg];
    return [s.eF, s.eB].filter((e) => e >= 0);
  }

  function toggleSegment(seg: number) {
    if (seg < 0) return;
    const edges = segmentEdges(seg);
    const closed = !edges.some((e) => state.closed.has(e));
    setClosed(edges, closed);
  }

  function setClosed(edges: number[], closed: boolean) {
    for (const e of edges) closed ? state.closed.add(e) : state.closed.delete(e);
    roads.setClosed(edges, closed);
    send({ type: 'close', edges, closed });
  }

  // ---------------------------------------------------------------- selección con el ratón
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.2);
  let downAt: [number, number] | null = null;
  viewport.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY]));
  viewport.addEventListener('pointerup', (ev) => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
    const r = viewport.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), sm.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return;
    const dist = sm.camera.position.distanceTo(hit);
    const tol = Math.max(3, dist * 0.012);
    if (state.tool === 'close') {
      const p = roads.pick(hit.x, hit.z);
      if (p) toggleSegment(p.seg);
      return;
    }
    const v = vehicles.nearest(hit.x, hit.z, tol);
    if (v >= 0) {
      state.selected = { type: 'vehicle', id: v };
      vehicles.selected = v;
      state.follow = false;
      state.driver = false;
      sm.controls.enabled = true;
      send({ type: 'queryVehicle', id: v });
      return;
    }
    const s = signals.group.visible ? signals.nearest(hit.x, hit.z, Math.max(6, tol)) : -1;
    if (s >= 0) {
      deselect();
      state.selected = { type: 'signal', i: s };
      showSignal(s);
      return;
    }
    const p = roads.pick(hit.x, hit.z);
    if (p && p.edge >= 0) {
      deselect();
      state.selected = { type: 'edge', id: p.edge, seg: p.seg };
      send({ type: 'queryEdge', id: p.edge });
      return;
    }
    deselect();
  });

  // ---------------------------------------------------------------- cámara: vuelos y presets
  let flight: null | { t0: number; dur: number; fromPos: THREE.Vector3; fromTgt: THREE.Vector3; toPos: THREE.Vector3; toTgt: THREE.Vector3 } = null;
  function flyTo(target: THREE.Vector3, distance: number, polarDeg = 50, azimuthDeg = 30) {
    const pol = (polarDeg * Math.PI) / 180;
    const az = (azimuthDeg * Math.PI) / 180;
    const offset = new THREE.Vector3(Math.sin(pol) * Math.sin(az), Math.cos(pol), Math.sin(pol) * Math.cos(az)).multiplyScalar(distance);
    flight = {
      t0: performance.now(),
      dur: 1600,
      fromPos: sm.camera.position.clone(),
      fromTgt: sm.controls.target.clone(),
      toPos: target.clone().add(offset),
      toTgt: target.clone(),
    };
    state.follow = false;
    state.driver = false;
    sm.controls.enabled = true;
  }
  const poi = (re: RegExp) => city.pois.find((p) => re.test(p.name));
  const center = new THREE.Vector3((ext.minX + ext.maxX) / 2, 0, (ext.minZ + ext.maxZ) / 2);
  const presets: [string, () => void][] = [
    ['Vista general', () => flyTo(center, 6200, 42, 20)],
    ['Centro histórico', () => at(/Basílica/, 650, 55, 35)],
    ['Palmeral · Hort del Cura', () => at(/Hort del Cura/, 520, 58, -40)],
    ['Estació Elx-Parc', () => at(/Elx-Parc/, 600, 55, 60)],
    ['Universitat (UMH)', () => at(/Miguel Hern/, 800, 52, 20)],
    ['Estadi Martínez Valero', () => at(/Martínez Valero/, 700, 55, -20)],
    ["L'Aljub", () => at(/Aljub/, 700, 55, 140)],
    ['Hospital General', () => at(/Hospital General/, 650, 55, 10)],
    ['Ronda Sud', () => byStreet(/Ronda Sud/, 1100)],
    ['Pont de Canalejas', () => byStreet(/Pont de Canalejas/, 350)],
  ];
  function at(re: RegExp, d: number, pol: number, az: number) {
    const p = poi(re);
    if (p) flyTo(new THREE.Vector3(p.x, 0, p.z), d, pol, az);
  }
  function edgesByName(re: RegExp) {
    const out: number[] = [];
    city.roads.segments.forEach((s, i) => {
      if (s.n >= 0 && re.test(city.roads.names[s.n])) out.push(i);
    });
    return out;
  }
  function byStreet(re: RegExp, d: number) {
    const segs = edgesByName(re);
    if (!segs.length) return;
    const s = city.roads.segments[segs[Math.floor(segs.length / 2)]];
    const k = Math.floor(s.p.length / 6) * 3;
    flyTo(new THREE.Vector3(s.p[k], 0, s.p[k + 2]), d, 55, 30);
  }
  const presetBox = $('presets');
  for (const [label, fn] of presets) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    presetBox.appendChild(b);
  }

  // ---------------------------------------------------------------- controles
  const playIcons = () => {
    $('ico-pause').toggleAttribute('hidden', !state.running);
    $('ico-play').toggleAttribute('hidden', state.running);
  };
  const setRunning = (r: boolean) => {
    state.running = r;
    send({ type: 'control', running: r });
    playIcons();
  };
  $('btn-play').onclick = () => setRunning(!state.running);
  const speedButtons = [...document.querySelectorAll<HTMLButtonElement>('#speed-seg button')];
  const setSpeed = (s: number) => {
    state.speed = s;
    speedButtons.forEach((b) => b.classList.toggle('on', +b.dataset.speed! === s));
    send({ type: 'control', speed: s });
  };
  speedButtons.forEach((b) => (b.onclick = () => setSpeed(+b.dataset.speed!)));
  setSpeed(state.speed);

  const hour = $('in-hour') as HTMLInputElement;
  hour.addEventListener('input', () => {
    state.draggingHour = true;
    $('out-hour').textContent = fmtTime(+hour.value * 3600);
  });
  hour.addEventListener('change', () => {
    state.draggingHour = false;
    setTime(+hour.value * 3600);
  });
  function setTime(t: number) {
    state.simTime = t;
    send({ type: 'time', t });
    if (($('in-lock') as HTMLInputElement).checked) send({ type: 'lockHour', hour: t / 3600 });
    chart.reset();
  }
  $('in-lock').addEventListener('change', (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    send({ type: 'lockHour', hour: on ? state.simTime / 3600 : null });
  });
  const bindRange = (id: string, out: string, fmt: (v: number) => string, apply: (v: number) => void) => {
    const el = $(id) as HTMLInputElement;
    const upd = () => {
      $(out).textContent = fmt(+el.value);
      apply(+el.value);
    };
    el.addEventListener('input', upd);
    return el;
  };
  const demandEl = bindRange('in-demand', 'out-demand', (v) => `${Math.round(v * 100)} %`, (v) => send({ type: 'config', cfg: { demand: v } }));
  bindRange('in-maxveh', 'out-maxveh', (v) => fmtInt(v), (v) => send({ type: 'config', cfg: { maxVehicles: v } }));
  const cycleEl = bindRange('in-cycle', 'out-cycle', (v) => `${v} s`, (v) => send({ type: 'config', cfg: { cycle: v } }));
  const sigMode = $('in-sigmode') as HTMLSelectElement;
  sigMode.onchange = () => send({ type: 'config', cfg: { signalMode: sigMode.value as 'fixed' } });
  $('in-buses').addEventListener('change', (ev) => send({ type: 'config', cfg: { buses: (ev.target as HTMLInputElement).checked } }));
  $('in-reroute').addEventListener('change', (ev) => send({ type: 'config', cfg: { rerouting: (ev.target as HTMLInputElement).checked } }));
  $('btn-reset').onclick = () => {
    send({ type: 'reset' });
    chart.reset();
    deselect();
  };

  document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((el) => {
    el.addEventListener('change', () => setLayer(el.dataset.layer!, el.checked));
    // El navegador puede restaurar el estado de los controles al recargar: se aplica tal cual.
    setLayer(el.dataset.layer!, el.checked);
  });
  function setLayer(layer: string, on: boolean) {
    if (layer === 'buildings') buildings.visible = on;
    if (layer === 'trees') trees.visible = on;
    if (layer === 'signals') signals.group.visible = on;
    if (layer === 'labels') labels.setVisible(on);
    if (layer === 'shadows') sm.shadows = on;
    if (layer === 'heat') {
      roads.setHeatVisible(on);
      $('heat-legend').hidden = !on;
    }
  }
  const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('#tool-seg button')];
  toolButtons.forEach(
    (b) =>
      (b.onclick = () => {
        state.tool = b.dataset.tool as 'inspect' | 'close';
        toolButtons.forEach((x) => x.classList.toggle('on', x === b));
        $('tool-hint').textContent =
          state.tool === 'close'
            ? 'Pulsa una calle para cortarla (o reabrirla). Los vehículos recalculan su ruta.'
            : 'Pulsa un vehículo, un semáforo o una calle para ver sus datos.';
        viewport.style.cursor = state.tool === 'close' ? 'crosshair' : '';
      }),
  );
  document.querySelectorAll<HTMLButtonElement>('.panel-toggle').forEach((b) => {
    b.onclick = () => $(b.dataset.target!).classList.toggle('collapsed');
  });
  if (window.innerWidth < 720) $('leftpanel').classList.add('collapsed');
  // Sincroniza la simulación con los valores que muestre la interfaz al arrancar.
  for (const id of ['in-demand', 'in-maxveh', 'in-cycle']) $(id).dispatchEvent(new Event('input'));
  send({
    type: 'config',
    cfg: {
      signalMode: sigMode.value as 'fixed',
      buses: ($('in-buses') as HTMLInputElement).checked,
      rerouting: ($('in-reroute') as HTMLInputElement).checked,
    },
  });
  sm.dayOfYear = +season.value;
  ($('in-lock') as HTMLInputElement).checked = false;

  // ---------------------------------------------------------------- escenarios
  const scButtons = [...document.querySelectorAll<HTMLButtonElement>('#scenarios button')];
  const stadium = poi(/Martínez Valero/);
  function setEvents(evs: DemandEvent[]) {
    state.events = evs;
    send({ type: 'events', events: evs });
  }
  function setZbe(on: boolean) {
    state.zbe = on;
    zbeMesh.visible = on;
    send({ type: 'config', cfg: { zbe: on } });
  }
  function reopenAll() {
    if (state.closed.size) setClosed([...state.closed], false);
  }
  const scenarios: Record<string, () => void> = {
    morning: () => setTime(8 * 3600),
    noon: () => setTime(13.75 * 3600),
    evening: () => setTime(19 * 3600),
    night: () => setTime(23.5 * 3600),
    match: () => {
      if (!stadium) return;
      // Partido a las 21:00: llegadas desde las 19:00 y salida a partir de las 22:50.
      setEvents([
        { id: 'match-in', label: 'Llegada al estadio', x: stadium.x, z: stadium.z, radius: 750, start: 19 * 3600, end: 21 * 3600, tripsPerHour: 3200, toward: true },
        { id: 'match-out', label: 'Salida del estadio', x: stadium.x, z: stadium.z, radius: 750, start: 22.83 * 3600, end: 23.75 * 3600, tripsPerHour: 5200, toward: false },
      ]);
      setTime(19.5 * 3600);
      flyTo(new THREE.Vector3(stadium.x, 0, stadium.z), 1300, 50, -25);
      setLayer('heat', true);
      document.querySelector<HTMLInputElement>('[data-layer="heat"]')!.checked = true;
    },
    zbe: () => {
      setZbe(!state.zbe);
      at(/Basílica/, 1100, 50, 20);
    },
    canalejas: () => {
      const segs = edgesByName(/Pont de Canalejas/);
      setClosed(segs.flatMap(segmentEdges), true);
      byStreet(/Pont de Canalejas/, 650);
    },
    altamira: () => {
      const segs = edgesByName(/Pont d'Altamira/);
      setClosed(segs.flatMap(segmentEdges), true);
      byStreet(/Pont d'Altamira/, 650);
    },
    clear: () => {
      reopenAll();
      setEvents([]);
      setZbe(false);
      demandEl.value = '1';
      $('out-demand').textContent = '100 %';
      send({ type: 'config', cfg: { demand: 1, signalMode: 'fixed', cycle: 90 } });
      sigMode.value = 'fixed';
      cycleEl.value = '90';
      $('out-cycle').textContent = '90 s';
    },
  };
  scButtons.forEach((b) => {
    b.onclick = () => {
      scenarios[b.dataset.sc!]?.();
      scButtons.forEach((x) => {
        const sc = x.dataset.sc!;
        const on =
          (sc === 'zbe' && state.zbe) ||
          (sc === 'match' && state.events.length > 0) ||
          (sc === 'canalejas' && edgesByName(/Pont de Canalejas/).some((s) => segmentEdges(s).some((e) => state.closed.has(e)))) ||
          (sc === 'altamira' && edgesByName(/Pont d'Altamira/).some((s) => segmentEdges(s).some((e) => state.closed.has(e))));
        x.classList.toggle('on', on);
      });
    };
  });

  // ---------------------------------------------------------------- teclado
  window.addEventListener('keydown', (ev) => {
    if ((ev.target as HTMLElement).tagName === 'INPUT' && (ev.target as HTMLInputElement).type !== 'range') return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      setRunning(!state.running);
    } else if (ev.key >= '1' && ev.key <= '6') setSpeed([1, 2, 5, 10, 30, 60][+ev.key - 1]);
    else if (ev.key === 'h' || ev.key === 'H') {
      const el = document.querySelector<HTMLInputElement>('[data-layer="heat"]')!;
      el.checked = !el.checked;
      setLayer('heat', el.checked);
    } else if (ev.key === 'Escape') deselect();
    else if ((ev.key === 'f' || ev.key === 'F') && state.selected?.type === 'vehicle') {
      state.follow = !state.follow;
      state.driver = false;
      sm.controls.enabled = true;
    }
  });

  // ---------------------------------------------------------------- bucle de render
  let last = performance.now();
  let lastQuery = 0;
  const followOffset = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  flyTo(center.clone().add(new THREE.Vector3(-250, 0, 250)), 3200, 48, 25);
  function loop(now: number) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    vehicles.update(now);
    signals.tick(dt);
    if (flight) {
      const u = Math.min(1, (now - flight.t0) / flight.dur);
      const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      sm.camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
      sm.controls.target.lerpVectors(flight.fromTgt, flight.toTgt, k);
      if (u >= 1) flight = null;
    }
    if (state.selected?.type === 'vehicle') {
      const pose = vehicles.pose(state.selected.id);
      if (pose && state.follow) {
        if (state.driver) {
          const dx = Math.cos(pose.h);
          const dz = Math.sin(pose.h);
          const back = pose.kind === 3 ? 16 : pose.kind === 2 ? 14 : 9;
          tmpV.set(pose.x - dx * back, pose.y + (pose.kind >= 2 && pose.kind <= 3 ? 6 : 3.6), pose.z - dz * back);
          sm.camera.position.lerp(tmpV, 1 - Math.exp(-dt * 6));
          sm.controls.target.lerp(tmpV.set(pose.x + dx * 14, pose.y + 1.2, pose.z + dz * 14), 1 - Math.exp(-dt * 6));
          sm.camera.lookAt(sm.controls.target);
        } else {
          followOffset.copy(sm.camera.position).sub(sm.controls.target);
          sm.controls.target.lerp(tmpV.set(pose.x, pose.y, pose.z), 1 - Math.exp(-dt * 5));
          sm.camera.position.copy(sm.controls.target).add(followOffset);
        }
      }
      if (now - lastQuery > 700) {
        lastQuery = now;
        send({ type: 'queryVehicle', id: state.selected.id });
      }
    } else if (state.selected?.type === 'edge' && now - lastQuery > 1500) {
      lastQuery = now;
      send({ type: 'queryEdge', id: state.selected.id });
    } else if (state.selected?.type === 'signal' && now - lastQuery > 500) {
      lastQuery = now;
      showSignal(state.selected.i);
    }
    if (!state.driver) sm.controls.update();
    roads.updateHeatLines(sm.camera.position.distanceTo(sm.controls.target), viewport.clientWidth, viewport.clientHeight);
    sm.setTime(frameT || state.simTime);
    updateClock();
    sm.render();
    labels.render(sm.scene, sm.camera, state.driver);
  }
  requestAnimationFrame(loop);
}

function extentOf(city: CityData) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const s of city.roads.segments) {
    for (let k = 0; k < s.p.length; k += 3) {
      minX = Math.min(minX, s.p[k]);
      maxX = Math.max(maxX, s.p[k]);
      minZ = Math.min(minZ, s.p[k + 2]);
      maxZ = Math.max(maxZ, s.p[k + 2]);
    }
  }
  return { minX: minX - 200, minZ: minZ - 200, maxX: maxX + 200, maxZ: maxZ + 200 };
}

function buildZbe(poly: [number, number][]): THREE.Group {
  const g = new THREE.Group();
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  const fill = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: 0x47c27a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 0.6;
  // Cortina luminosa a lo largo del perímetro, visible por encima de los tejados.
  const pos: number[] = [];
  const col: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    pos.push(ax, 0, az, bx, 0, bz, bx, 34, bz, ax, 0, az, bx, 34, bz, ax, 34, az);
    col.push(1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0);
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  wg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const wall = new THREE.Mesh(
    wg,
    new THREE.MeshBasicMaterial({ color: 0x47c27a, vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  const pts = poly.map(([x, z]) => new THREE.Vector3(x, 34, z));
  pts.push(pts[0].clone());
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9bf0bd, transparent: true, opacity: 0.6 }));
  g.add(fill, wall, line);
  return g;
}

main().catch((err) => {
  console.error(err);
  progress(1, `Error: ${err instanceof Error ? err.message : String(err)}`);
});
