// Lumen's tiny local server. Zero dependencies, needs Node 18+.
//  - serves the site from ./public
//  - /api/lyrics : looks up synced lyrics on LRCLIB (free, no key)
//  - /api/img    : same-origin proxy for Spotify album art (only used if the CDN blocks CORS)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8888;
const HOST = '127.0.0.1'; // Spotify requires the loopback IP, not "localhost"
const LRCLIB = 'https://lrclib.net/api';
const UA = 'Lumen/1.0 (personal lyrics viewer)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

// ---------- lyrics ----------

async function fetchJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`LRCLIB responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// "Song - Remastered 2011", "Song (feat. X)", "Song - Live at ..." -> "Song"
function cleanTitle(s = '') {
  return s
    .replace(/\s*[(\[][^)\]]*(feat\.?|ft\.?|with|remaster|live|version|edit|mix|deluxe|bonus)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|live|version|edit|mix|mono|stereo|deluxe|bonus|from\b).*$/i, '')
    .trim();
}

const hasLyrics = (r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental);

async function resolveLyrics(q) {
  const clean = cleanTitle(q.track);
  const get = (name, withAlbum) => {
    const p = new URLSearchParams({ track_name: name, artist_name: q.artist });
    if (withAlbum && q.album) p.set('album_name', q.album);
    if (q.duration) p.set('duration', String(q.duration));
    return fetchJSON(`${LRCLIB}/get?${p}`);
  };

  let hit = await get(q.track, true);
  if (!hasLyrics(hit)) hit = await get(q.track, false);
  if (!hasLyrics(hit) && clean && clean !== q.track) hit = await get(clean, false);

  // No synced version yet? Look through search results for one with matching length.
  if (!hit || !hit.syncedLyrics) {
    const p = new URLSearchParams({ track_name: clean || q.track, artist_name: q.artist });
    const list = (await fetchJSON(`${LRCLIB}/search?${p}`)) || [];
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
    found: hasLyrics(hit) ? true : false,
    synced: hit?.syncedLyrics || null,
    plain: hit?.plainLyrics || null,
    instrumental: !!hit?.instrumental,
  };
}

const lyricsCache = new Map();

async function handleLyrics(url, res) {
  const track = (url.searchParams.get('track') || '').trim();
  const artist = (url.searchParams.get('artist') || '').trim();
  if (!track || !artist) return json(res, 400, { error: 'track and artist are required' });
  const q = {
    track,
    artist,
    album: (url.searchParams.get('album') || '').trim(),
    duration: Math.round(Number(url.searchParams.get('duration')) || 0),
  };
  const key = `${q.track}|${q.artist}|${q.duration}`;
  if (lyricsCache.has(key)) return json(res, 200, lyricsCache.get(key));
  try {
    const out = await resolveLyrics(q);
    if (lyricsCache.size > 300) lyricsCache.delete(lyricsCache.keys().next().value);
    lyricsCache.set(key, out);
    json(res, 200, out);
  } catch (e) {
    json(res, 502, { error: 'Lyrics service unavailable', detail: String(e.message || e) });
  }
}

// ---------- album art proxy ----------

async function handleImg(url, res) {
  let target;
  try {
    target = new URL(url.searchParams.get('u') || '');
  } catch {
    return json(res, 400, { error: 'bad url' });
  }
  const h = target.hostname;
  const allowed = target.protocol === 'https:' && (h === 'scdn.co' || h.endsWith('.scdn.co') || h.endsWith('.spotifycdn.com'));
  if (!allowed) return json(res, 400, { error: 'host not allowed' });
  const r = await fetch(target, { headers: { 'User-Agent': UA }, redirect: 'error' });
  if (!r.ok) return json(res, 502, { error: `upstream ${r.status}` });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 6_000_000) return json(res, 413, { error: 'image too large' });
  res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  res.end(buf);
}

// ---------- static files ----------

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------- boot ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === '/api/lyrics') return await handleLyrics(url, res);
    if (url.pathname === '/api/img') return await handleImg(url, res);
    return serveStatic(url.pathname, res);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use. Close the other Lumen window, or start with a different PORT\n` +
        `  (and update the Redirect URI in your Spotify app to match).\n`
    );
  } else {
    console.error(e);
  }
  process.exit(1);
});

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed below anyway */
  }
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Lumen is running at ${url}\n  Redirect URI for Spotify: ${url}/\n  Press Ctrl+C to stop.\n`);
  if (process.argv.includes('--open')) openBrowser(url);
});
