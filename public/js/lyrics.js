// Lyrics: fetch from the local /api/lyrics (which asks LRCLIB), parse LRC timestamps,
// and work out per-word timing so words can light up one at a time.

import { lookupLyrics } from './lrclib.js';

const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;
const cache = new Map();

export function parseLRC(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    STAMP.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = STAMP.exec(raw))) {
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
    }
    if (!stamps.length) continue; // metadata like [ar:...]
    const body = raw.replace(STAMP, '').replace(WORD_TAG, '').trim();
    for (const t of stamps) out.push({ t, text: body });
  }
  return out.sort((a, b) => a.t - b.t);
}

const isGapText = (s) => !s || /^[♪♫\s\-–—.…]*$/.test(s);

function makeLine(text, t, nextT) {
  const words = text.split(/\s+/).filter(Boolean);
  const gap = Math.max(0.5, nextT - t);
  // Short gap: sing until just before the next line. Long gap: assume the line ends early.
  const dur = gap <= 6 ? gap * 0.92 : Math.min(gap * 0.92, Math.max(2.5, text.length * 0.11));
  const weights = words.map((w) => w.length + 1.5);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const ws = weights.map((w) => {
    const start = (acc / total) * 0.95;
    acc += w;
    return start;
  });
  return { t, text, words, ws, dur, gap: false };
}

const makeGap = (t, dur) => ({ t, text: '', words: [], ws: [], dur, gap: true });

export function buildFromLRC(lrc, durationSec = 0) {
  const parsed = parseLRC(lrc);
  const lines = [];
  parsed.forEach((p, i) => {
    const nextT = parsed[i + 1] ? parsed[i + 1].t : durationSec || p.t + 8;
    if (isGapText(p.text)) {
      if (nextT - p.t >= 5) lines.push(makeGap(p.t, nextT - p.t));
      return;
    }
    lines.push(makeLine(p.text, p.t, nextT));
  });
  if (lines.length && lines[0].t > 6) lines.unshift(makeGap(0, lines[0].t));
  return { type: lines.length ? 'synced' : 'none', lines };
}

// Unsynced lyrics: spread the lines across the song so the view still scrolls along.
function buildFromPlain(text, durationSec) {
  const rows = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^\[.*\]$/.test(s));
  if (!rows.length) return { type: 'none', lines: [] };
  const start = durationSec * 0.06;
  const span = durationSec * 0.86;
  const lines = rows.map((r, i) => {
    const t = start + (i / rows.length) * span;
    return makeLine(r, t, start + ((i + 1) / rows.length) * span);
  });
  return { type: 'plain', lines };
}

export async function fetchLyrics(track) {
  if (cache.has(track.id)) return cache.get(track.id);
  const durationSec = Math.round(track.durationMs / 1000);
  const q = { track: track.name, artist: track.artists[0] || '', album: track.album || '', duration: durationSec };
  let d;
  try {
    d = await lookupLyrics(q); // straight from LRCLIB, works on any static host
  } catch (e) {
    // If the browser blocked the direct call, try the optional local server.
    const res = await fetch(`/api/lyrics?${new URLSearchParams(q)}`).catch(() => null);
    if (!res || !res.ok) throw e;
    d = await res.json();
  }

  let result;
  if (d.instrumental) result = { type: 'instrumental', lines: [] };
  else if (d.synced) result = buildFromLRC(d.synced, durationSec);
  else if (d.plain) result = buildFromPlain(d.plain, durationSec);
  else result = { type: 'none', lines: [] };

  if (result.type === 'none' && d.plain) result = buildFromPlain(d.plain, durationSec);
  cache.set(track.id, result);
  return result;
}

// Index of the last line whose start time is <= t (or -1 before the first line).
export function findLineIndex(lines, t) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
