// The animated gradient: soft colour blobs that drift, and swell on every beat.
// It also owns the "glow" colours (slowly hue-shifting versions of the album palette)
// that the lyrics and UI read from.

import { DEFAULT_PALETTE, rgbToHsl, hslToRgb } from './palette.js';

export class Background {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scale = 0.5; // render at half size, the browser stretches it: free softness, cheaper frames
    this.cur = DEFAULT_PALETTE.colors.map((c) => c.slice());
    this.target = DEFAULT_PALETTE.colors.map((c) => c.slice());
    this.glow = DEFAULT_PALETTE.colors.map((c) => c.slice());
    this.tm = 0;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.blobs = Array.from({ length: 7 }, (_, i) => ({
      p: Math.random() * Math.PI * 2,
      sx: 0.1 + Math.random() * 0.14,
      sy: 0.09 + Math.random() * 0.14,
      rx: 0.2 + Math.random() * 0.22,
      ry: 0.16 + Math.random() * 0.22,
      r: 0.26 + Math.random() * 0.2,
      ci: i % 4,
    }));
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.w = Math.max(2, Math.round(innerWidth * this.scale));
    this.h = Math.max(2, Math.round(innerHeight * this.scale));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
  }

  setPalette(colors) {
    const c = colors.slice(0, 4).map((x) => x.slice());
    while (c.length < 4) c.push(c[c.length % colors.length].slice());
    this.target = c;
  }

  frame(t, dt, beat) {
    // ease toward the new palette over ~1.5s
    const f = 1 - Math.exp(-dt * 1.8);
    for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) this.cur[i][k] += (this.target[i][k] - this.cur[i][k]) * f;

    // the shifting glow: each colour wanders a few degrees around its hue
    for (let i = 0; i < 4; i++) {
      const [h, s, l] = rgbToHsl(this.cur[i][0], this.cur[i][1], this.cur[i][2]);
      this.glow[i] = hslToRgb(h + Math.sin(t * 0.12 + i * 1.7) * 16, s, l);
    }

    const lvl = Math.max(beat.level, 0.12 + 0.06 * Math.sin(t * 0.4));
    const speed = (this.reduced ? 0.25 : 1) * (0.55 + lvl * 1.4 + beat.pulse * 0.9);
    this.tm += dt * speed;
    const T = this.tm;

    const { ctx, w, h } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#04050a';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    const m = Math.max(w, h);
    const alpha = Math.min(0.7, 0.19 + lvl * 0.22 + beat.pulse * 0.2);
    for (const b of this.blobs) {
      const x = (0.5 + Math.sin(T * b.sx + b.p) * b.rx + Math.sin(T * b.sx * 0.43 + b.p * 1.7) * 0.08) * w;
      const y = (0.5 + Math.cos(T * b.sy + b.p * 1.3) * b.ry + Math.cos(T * b.sy * 0.51 + b.p) * 0.08) * h;
      const r = (b.r + beat.pulse * 0.1 + beat.bass * 0.06) * m;
      const c = this.glow[b.ci];
      const rgb = `${c[0]},${c[1]},${c[2]}`;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},${alpha})`);
      g.addColorStop(0.45, `rgba(${rgb},${alpha * 0.38})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
}
