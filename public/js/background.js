// The animated background. Five styles, all driven by the same palette and the beat:
//   flow      soft colour blobs that drift and swell (default)
//   aurora    tall curtains of light sweeping sideways
//   spotlight a dark stage with a slow roaming light
//   art       the album cover, blurred and breathing
//   solid     one calm colour that pulses gently
// It also owns the "glow" colours (slowly hue-shifting versions of the palette)
// that the lyrics and interface read from.

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
    this.style = 'flow';
    this.speed = 1; // user's motion-speed setting
    this.wobble = 16; // degrees the glow hue wanders; kept small for custom colours
    this.art = null;
    this._artUrl = null;
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

  setStyle(s) {
    this.style = s;
  }

  setPalette(colors) {
    const c = colors.slice(0, 4).map((x) => x.slice());
    while (c.length < 4) c.push(c[c.length % colors.length].slice());
    this.target = c;
  }

  // Album art for the "art" style. Drawing a cross-origin image is fine; we never read its pixels here.
  setArt(url) {
    this.art = null;
    this._artUrl = url;
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      if (this._artUrl === url) this.art = img;
    };
    img.src = url;
  }

  frame(t, dt, beat) {
    // ease toward the new palette over ~1.5s
    const f = 1 - Math.exp(-dt * 1.8);
    for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) this.cur[i][k] += (this.target[i][k] - this.cur[i][k]) * f;

    // the shifting glow: each colour wanders a few degrees around its hue
    for (let i = 0; i < 4; i++) {
      const [h, s, l] = rgbToHsl(this.cur[i][0], this.cur[i][1], this.cur[i][2]);
      this.glow[i] = hslToRgb(h + Math.sin(t * 0.12 + i * 1.7) * this.wobble, s, l);
    }

    const lvl = Math.max(beat.level, 0.12 + 0.06 * Math.sin(t * 0.4));
    const speed = (this.reduced ? 0.25 : 1) * this.speed * (0.55 + lvl * 1.4 + beat.pulse * 0.9);
    this.tm += dt * speed;

    const { ctx } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#04050a';
    ctx.fillRect(0, 0, this.w, this.h);

    const alpha = Math.min(0.7, 0.19 + lvl * 0.22 + beat.pulse * 0.2);
    switch (this.style) {
      case 'aurora': return this.aurora(this.tm, alpha, beat);
      case 'spotlight': return this.spotlight(this.tm, alpha, beat);
      case 'art': return this.artBlur(this.tm, alpha, beat);
      case 'solid': return this.solid(alpha, beat);
      default: return this.flow(this.tm, alpha, beat);
    }
  }

  light(x, y, r, c, a) {
    const { ctx } = this;
    const rgb = `${c[0]},${c[1]},${c[2]}`;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(0.45, `rgba(${rgb},${a * 0.38})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  flow(T, alpha, beat) {
    const { ctx, w, h } = this;
    ctx.globalCompositeOperation = 'lighter';
    const m = Math.max(w, h);
    for (const b of this.blobs) {
      const x = (0.5 + Math.sin(T * b.sx + b.p) * b.rx + Math.sin(T * b.sx * 0.43 + b.p * 1.7) * 0.08) * w;
      const y = (0.5 + Math.cos(T * b.sy + b.p * 1.3) * b.ry + Math.cos(T * b.sy * 0.51 + b.p) * 0.08) * h;
      const r = (b.r + beat.pulse * 0.1 + beat.bass * 0.06) * m;
      this.light(x, y, r, this.glow[b.ci], alpha);
    }
  }

  aurora(T, alpha, beat) {
    const { ctx, w, h } = this;
    ctx.globalCompositeOperation = 'lighter';
    const m = Math.max(w, h);
    for (let i = 0; i < 6; i++) {
      const cx = (0.5 + Math.sin(T * 0.11 + i * 1.9) * 0.46) * w;
      const cy = (0.42 + Math.sin(T * 0.07 + i) * 0.1) * h;
      const tilt = Math.sin(T * 0.2 + i * 2.3) * 0.22;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.scale(0.26 + beat.bass * 0.1, 1.7 + beat.pulse * 0.3);
      this.light(0, 0, 0.5 * m, this.glow[i % 4], alpha * 1.1);
      ctx.restore();
    }
  }

  spotlight(T, alpha, beat) {
    const { ctx, w, h } = this;
    ctx.fillStyle = '#020207';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    const m = Math.max(w, h);
    const r = (0.4 + beat.pulse * 0.12 + beat.bass * 0.06) * m;
    const x = (0.5 + Math.sin(T * 0.13) * 0.3) * w;
    const y = (0.4 + Math.cos(T * 0.1) * 0.14) * h;
    this.light(x, y, r * 1.5, this.glow[1], alpha * 0.55);
    this.light(x, y, r * 0.8, this.glow[0], alpha * 1.15);
    this.light(w - x, h * 0.95 - y * 0.5, r * 0.55, this.glow[2], alpha * 0.55);
  }

  artBlur(T, alpha, beat) {
    const art = this.art;
    if (!art) return this.flow(T, alpha, beat); // until the cover loads (or if there is none)
    const { ctx, w, h } = this;
    const iw = art.naturalWidth || 640;
    const ih = art.naturalHeight || 640;
    const sc = ((Math.max(w, h) * 1.45) / Math.min(iw, ih)) * (1 + beat.pulse * 0.05 + beat.bass * 0.02);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(Math.sin(T * 0.05) * 0.14);
    ctx.scale(sc, sc);
    ctx.filter = 'blur(12px) saturate(1.6) brightness(0.85)';
    ctx.drawImage(art, -iw / 2, -ih / 2);
    ctx.restore();
    ctx.filter = 'none';
    // a dark veil keeps the lyrics readable; it lifts a little on the beat
    ctx.fillStyle = `rgba(4,5,10,${Math.max(0.25, 0.5 - beat.pulse * 0.14)})`;
    ctx.fillRect(0, 0, w, h);
  }

  solid(alpha, beat) {
    const { ctx, w, h } = this;
    const c = this.glow[0];
    ctx.fillStyle = `rgb(${Math.round(c[0] * 0.2)},${Math.round(c[1] * 0.2)},${Math.round(c[2] * 0.2)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.05 + beat.pulse * 0.16 + beat.level * 0.05})`;
    ctx.fillRect(0, 0, w, h);
  }
}
