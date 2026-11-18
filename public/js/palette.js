// Pulls a small, vivid palette out of the album art. The glow and gradient are built from it.

export const DEFAULT_PALETTE = {
  colors: [
    [255, 94, 120],
    [120, 80, 255],
    [60, 200, 255],
    [255, 176, 92],
  ],
};

// For black, white or grey covers where there's no real colour to pull.
const MONO_PALETTE = {
  colors: [
    [220, 225, 255],
    [150, 160, 235],
    [100, 120, 210],
    [210, 190, 255],
  ],
};

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (!s) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed'));
    img.src = src;
  });
}

// Try the CDN directly; if it won't allow canvas reads, go through our local proxy.
async function loadForCanvas(url) {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(location.origin)) return loadImage(url);
  try {
    return await loadImage(url);
  } catch {
    return loadImage(`/api/img?u=${encodeURIComponent(url)}`);
  }
}

export async function extractPalette(url) {
  if (!url) return DEFAULT_PALETTE;
  try {
    const img = await loadForCanvas(url);
    const N = 48;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;

    const bins = new Map();
    let total = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 200) continue;
      total++;
      const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
      if (l < 0.1 || l > 0.94 || s < 0.14) continue;
      const key = Math.floor(h / 15) * 4 + Math.min(3, Math.floor(l * 4));
      const b = bins.get(key) || { n: 0, s: 0, l: 0, sin: 0, cos: 0 };
      const rad = (h * Math.PI) / 180;
      b.n++;
      b.s += s;
      b.l += l;
      b.sin += Math.sin(rad);
      b.cos += Math.cos(rad);
      bins.set(key, b);
    }

    const candidates = [...bins.values()]
      .map((b) => {
        const s = b.s / b.n;
        const l = b.l / b.n;
        let h = (Math.atan2(b.sin, b.cos) * 180) / Math.PI;
        if (h < 0) h += 360;
        return { h, s, l, n: b.n, score: b.n * (0.35 + s) * (1.2 - Math.abs(l - 0.55)) };
      })
      .sort((a, b) => b.score - a.score);

    const picked = [];
    for (const c of candidates) {
      if (picked.every((p) => hueDist(p.h, c.h) >= 28)) picked.push(c);
      if (picked.length === 4) break;
    }
    if (!picked.length || picked[0].n < total * 0.03) return MONO_PALETTE;

    const colors = picked.map((p) => hslToRgb(p.h, clamp(p.s * 1.1, 0.58, 0.95), clamp(p.l, 0.5, 0.64)));
    const offsets = [38, -38, 90, -90];
    let k = 0;
    while (colors.length < 4) colors.push(hslToRgb(picked[0].h + offsets[k++ % 4], 0.75, 0.58));
    return { colors };
  } catch {
    return DEFAULT_PALETTE;
  }
}
