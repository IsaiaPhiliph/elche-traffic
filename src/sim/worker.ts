/// <reference lib="webworker" />
// Worker que ejecuta la simulación y envía instantáneas al hilo principal.
import { Simulation, FRAME_STRIDE } from './simulation';
import { SIG } from './signals';
import type { FromWorker, ToWorker } from './protocol';
import type { NetworkJSON } from './types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const DT = 0.2;
let sim: Simulation | null = null;
let running = true;
let speed = 1;
let budget = 0;
let lastWall = 0;
let lastStats = 0;
let lastHeat = -1;
let effSpeed = 0;
let simAdvanced = 0;
let effWindowStart = 0;
const pool: Float32Array[] = [];
let headEdges = new Int32Array(0);

function post(msg: FromWorker, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function getBuffer(n: number) {
  const need = Math.max(4096, n) * FRAME_STRIDE;
  while (pool.length) {
    const b = pool.pop()!;
    if (b.length >= need) return b;
  }
  return new Float32Array(Math.ceil(need * 1.25));
}

function loop() {
  if (!sim) return;
  const now = performance.now();
  let dtWall = (now - lastWall) / 1000;
  lastWall = now;
  if (dtWall > 0.25) dtWall = 0.25;
  if (running) budget += dtWall * speed;
  const t0 = performance.now();
  let steps = 0;
  while (budget >= DT && performance.now() - t0 < 28) {
    sim.step(DT);
    budget -= DT;
    steps++;
  }
  if (budget > 1.5) budget = 1.5;
  simAdvanced += steps * DT;
  if (now - effWindowStart > 1000) {
    effSpeed = simAdvanced / ((now - effWindowStart) / 1000);
    simAdvanced = 0;
    effWindowStart = now;
  }
  if (steps > 0 || now - lastStats > 400) sendFrame(now);
  setTimeout(loop, Math.max(1, 15 - (performance.now() - now)));
}

function sendFrame(now: number) {
  if (!sim) return;
  const buf = getBuffer(sim.count);
  const n = sim.writeFrame(buf);
  const msg: FromWorker & { type: 'frame' } = { type: 'frame', t: sim.time, n, buf, eff: effSpeed };
  const transfer: Transferable[] = [buf.buffer];
  if (sim.signals.consumeChanged()) {
    const st = new Uint8Array(headEdges.length);
    for (let i = 0; i < headEdges.length; i++) st[i] = sim.signals.headState[headEdges[i]];
    msg.heads = st;
    transfer.push(st.buffer);
  }
  if (sim.heatVersion !== lastHeat) {
    lastHeat = sim.heatVersion;
    const h = sim.heat.slice();
    msg.heat = h;
    transfer.push(h.buffer);
  }
  if (now - lastStats > 400) {
    lastStats = now;
    msg.stats = { ...sim.stats, byKind: sim.stats.byKind.slice() };
  }
  post(msg, transfer);
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        const json = (await (await fetch(msg.url)).json()) as NetworkJSON;
        sim = new Simulation(json);
        headEdges = Int32Array.from(sim.signals.ctrls.flatMap((c) => Array.from(c.heads)));
        const headCtrl = Int32Array.from(sim.signals.ctrls.flatMap((c, i) => Array.from(c.heads, () => i)));
        // Arranca con tráfico ya circulando (8:00) para no ver la red vacía.
        sim.setTime(7.75 * 3600);
        sim.warmup(15 * 60, 0.5);
        const d = sim.demand;
        post({
          type: 'ready',
          info: {
            nEdges: sim.net.nEdges,
            heads: headEdges,
            headCtrl,
            bus: sim.busLines.map((b) => ({ ref: b.ref, name: b.name, color: b.color })),
            demand: { internal: d.internalDaily, inbound: d.inboundDaily, outbound: d.outboundDaily, through: d.throughDaily },
            zbe: json.zbe,
          },
        });
        sim.signals.consumeChanged();
        const st = new Uint8Array(headEdges.length);
        for (let i = 0; i < headEdges.length; i++) st[i] = sim.signals.headState[headEdges[i]];
        lastWall = performance.now();
        effWindowStart = lastWall;
        post({ type: 'frame', t: sim.time, n: 0, buf: new Float32Array(0), heads: st, eff: 0 });
        loop();
        break;
      }
      case 'control':
        if (msg.running !== undefined) running = msg.running;
        if (msg.speed !== undefined) speed = msg.speed;
        break;
      case 'config':
        sim?.configure(msg.cfg);
        break;
      case 'time':
        sim?.setTime(msg.t);
        break;
      case 'lockHour':
        if (sim) sim.demand.lockHour = msg.hour;
        break;
      case 'close':
        sim?.setClosed(msg.edges, msg.closed);
        break;
      case 'events':
        sim?.setEvents(msg.events);
        break;
      case 'queryVehicle':
        post({ type: 'vehicleInfo', info: sim?.vehicleInfo(msg.id) ?? null });
        break;
      case 'queryEdge': {
        if (!sim || msg.id < 0 || msg.id >= sim.net.nEdges) {
          post({ type: 'edgeInfo', info: null });
          break;
        }
        const net = sim.net;
        const e = msg.id;
        const occ = sim.edgeVehicles(e);
        const ci = sim.signals.edgeCtrl[e];
        post({
          type: 'edgeInfo',
          info: {
            id: e,
            name: net.edgeName(e) || 'Calle sin nombre',
            lanes: net.eLanes[e],
            speedLimit: Math.round(net.eSpeed[e] * 3.6),
            length: net.eLen[e],
            vehicles: occ.count,
            meanSpeed: occ.mean,
            closed: sim.router.closed[e] === 1,
            signal: ci >= 0 ? { mode: sim.signals.mode, cycle: sim.signals.cycle, state: sim.signals.headState[e] ?? SIG.NONE } : null,
          },
        });
        break;
      }
      case 'reset':
        sim?.clearVehicles();
        break;
      case 'buffer':
        if (pool.length < 4) pool.push(msg.buf);
        break;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  }
};
