// Gráfica de evolución: vehículos en circulación y velocidad media (dos ejes).
export class Chart {
  private ctx: CanvasRenderingContext2D;
  private samples: { t: number; veh: number; speed: number }[] = [];
  private lastT = -1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  push(t: number, veh: number, speed: number) {
    // Una muestra por minuto simulado; reinicia si el reloj salta hacia atrás.
    if (this.lastT >= 0 && (t < this.lastT - 1 || t - this.lastT > 4 * 3600)) this.samples = [];
    if (this.lastT >= 0 && t - this.lastT < 60 && this.samples.length) return;
    this.lastT = t;
    this.samples.push({ t, veh, speed });
    if (this.samples.length > 240) this.samples.shift();
    this.draw();
  }

  reset() {
    this.samples = [];
    this.lastT = -1;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#47c27a';
    const warn = css.getPropertyValue('--warn').trim() || '#f2b33d';
    const pad = { l: 34, r: 30, t: 8, b: 18 };
    const S = this.samples;
    g.font = '10px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const y = pad.t + ((h - pad.t - pad.b) * k) / 3;
      g.beginPath();
      g.moveTo(pad.l, y);
      g.lineTo(w - pad.r, y);
      g.stroke();
    }
    if (S.length < 2) {
      g.fillText('Recogiendo datos…', pad.l + 6, h / 2);
      return;
    }
    const maxV = Math.max(500, ...S.map((s) => s.veh)) * 1.1;
    const maxS = 60;
    const t0 = S[0].t;
    const t1 = Math.max(t0 + 600, S[S.length - 1].t);
    const X = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
    const Yv = (v: number) => h - pad.b - (v / maxV) * (h - pad.t - pad.b);
    const Ys = (v: number) => h - pad.b - (v / maxS) * (h - pad.t - pad.b);
    const line = (col: string, Y: (s: { veh: number; speed: number }) => number, fill: boolean) => {
      g.beginPath();
      S.forEach((s, i) => (i ? g.lineTo(X(s.t), Y(s)) : g.moveTo(X(s.t), Y(s))));
      g.strokeStyle = col;
      g.lineWidth = 1.8;
      g.stroke();
      if (fill) {
        g.lineTo(X(S[S.length - 1].t), h - pad.b);
        g.lineTo(X(S[0].t), h - pad.b);
        g.closePath();
        g.globalAlpha = 0.14;
        g.fillStyle = col;
        g.fill();
        g.globalAlpha = 1;
      }
    };
    line(accent, (s) => Yv(s.veh), true);
    line(warn, (s) => Ys(s.speed), false);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.textAlign = 'right';
    g.fillText(String(Math.round(maxV)), pad.l - 4, pad.t + 8);
    g.fillText('0', pad.l - 4, h - pad.b);
    g.textAlign = 'left';
    g.fillText(`${maxS} km/h`, w - pad.r + 3, pad.t + 8);
    const fmt = (t: number) => {
      const m = Math.floor((((t % 86400) + 86400) % 86400) / 60);
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    g.textAlign = 'left';
    g.fillText(fmt(t0), pad.l, h - 4);
    g.textAlign = 'right';
    g.fillText(fmt(S[S.length - 1].t), w - pad.r, h - 4);
  }
}
