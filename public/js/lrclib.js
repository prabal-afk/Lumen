// Talks to LRCLIB straight from the browser, so Lumen needs no server of its own.
// (The optional local server in ../server.js offers the same lookup at /api/lyrics as a fallback.)

const BASE = 'https://lrclib.net/api';

async function getJSON(url, ms = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`LRCLIB responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// "Song - Remastered 2011", "Song (feat. X)", "Song - Live at ..." -> "Song"
export function cleanTitle(s = '') {
  return s
    .replace(/\s*[(\[][^)\]]*(feat\.?|ft\.?|with|remaster|live|version|edit|mix|deluxe|bonus)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|live|version|edit|mix|mono|stereo|deluxe|bonus|from\b).*$/i, '')
    .trim();
}

const hasLyrics = (r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental);

export async function lookupLyrics(q) {
  const clean = cleanTitle(q.track);
  const get = (name, withAlbum) => {
    const p = new URLSearchParams({ track_name: name, artist_name: q.artist });
    if (withAlbum && q.album) p.set('album_name', q.album);
    if (q.duration) p.set('duration', String(q.duration));
    return getJSON(`${BASE}/get?${p}`);
  };

  let hit = await get(q.track, true);
  if (!hasLyrics(hit)) hit = await get(q.track, false);
  if (!hasLyrics(hit) && clean && clean !== q.track) hit = await get(clean, false);

  // No synced version yet? Look through search results for one with a matching length.
  if (!hit || !hit.syncedLyrics) {
    const p = new URLSearchParams({ track_name: clean || q.track, artist_name: q.artist });
    const found = await getJSON(`${BASE}/search?${p}`);
    const list = Array.isArray(found) ? found : [];
    const dur = q.duration || 0;
    const close = (r) => !dur || !r.duration || Math.abs(r.duration - dur) <= 6;
    const best = list
      .filter((r) => r.syncedLyrics && close(r))
      .sort((a, b) => Math.abs((a.duration || dur) - dur) - Math.abs((b.duration || dur) - dur))[0];
    if (best) hit = best;
    else if (!hasLyrics(hit)) {
      const plain = list.find((r) => (r.plainLyrics || r.instrumental) && close(r));
      if (plain) hit = plain;
    }
  }

  return {
    found: !!hasLyrics(hit),
    synced: hit?.syncedLyrics || null,
    plain: hit?.plainLyrics || null,
    instrumental: !!hit?.instrumental,
  };
}
