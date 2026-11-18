// Spotify login (Authorization Code + PKCE, so no client secret) and the few Web API calls Lumen needs.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];
const K = { client: 'lumen.clientId', tokens: 'lumen.tokens', verifier: 'lumen.pkce', state: 'lumen.state' };

export class SpotifyError extends Error {
  constructor(status, reason, data) {
    super(reason || `Spotify ${status}`);
    this.status = status;
    this.reason = reason;
    this.data = data;
  }
}

// The Redirect URI is simply this page's own address (for example https://yoursite.netlify.app/ or http://127.0.0.1:8888/).
export const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '').replace(/([^/])$/, '$1/');
export const getClientId = () => localStorage.getItem(K.client) || '';
export const setClientId = (id) => localStorage.setItem(K.client, id.trim());

const readTokens = () => {
  try {
    return JSON.parse(localStorage.getItem(K.tokens));
  } catch {
    return null;
  }
};
export const hasScope = (s) => (readTokens()?.scope || '').split(' ').includes(s);
export const isSignedIn = () => !!readTokens()?.refresh_token;
export const signOut = () => localStorage.removeItem(K.tokens);

// ---------- PKCE helpers ----------

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const randomString = (n) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a).slice(0, n);
};

const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

// ---------- login flow ----------

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new SpotifyError(400, 'Add your Client ID first.');
  const verifier = randomString(96);
  const state = randomString(16);
  localStorage.setItem(K.verifier, verifier);
  localStorage.setItem(K.state, state);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: b64url(await sha256(verifier)),
    state,
  });
  location.href = `${AUTH_URL}?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SpotifyError(res.status, data.error_description || data.error || 'token_error', data);
  return data;
}

function saveTokens(d, prev) {
  const t = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || prev?.refresh_token,
    expires_at: Date.now() + (d.expires_in || 3600) * 1000,
    scope: d.scope || prev?.scope || '',
  };
  localStorage.setItem(K.tokens, JSON.stringify(t));
  return t;
}

// Call once on page load. Returns true if we just finished a login.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  const clean = () => history.replaceState({}, '', location.pathname);

  if (q.get('error')) {
    clean();
    throw new SpotifyError(400, q.get('error') === 'access_denied' ? 'Login was cancelled.' : q.get('error'));
  }
  const code = q.get('code');
  if (!code) {
    clean();
    return false;
  }
  const verifier = localStorage.getItem(K.verifier);
  const expected = localStorage.getItem(K.state);
  localStorage.removeItem(K.verifier);
  localStorage.removeItem(K.state);
  clean();
  if (!verifier || q.get('state') !== expected) throw new SpotifyError(400, 'Login check failed. Please try connecting again.');

  const data = await tokenRequest({
    client_id: getClientId(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  saveTokens(data, null);
  return true;
}

let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  const t = readTokens();
  if (!t?.refresh_token) return Promise.reject(new SpotifyError(401, 'NO_TOKEN'));
  refreshing = (async () => {
    try {
      const d = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: getClientId() });
      return saveTokens(d, t);
    } catch (e) {
      if (e instanceof SpotifyError && (e.status === 400 || e.status === 401)) {
        signOut();
        throw new SpotifyError(401, 'NO_TOKEN');
      }
      throw e; // network hiccup: keep the session
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function accessToken() {
  let t = readTokens();
  if (!t) return null;
  if (Date.now() > t.expires_at - 60_000) t = await refresh();
  return t.access_token;
}

// ---------- API ----------

async function api(method, path, { query, body } = {}) {
  const url = new URL(API + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken();
    if (!token) throw new SpotifyError(401, 'NO_TOKEN');
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      await refresh();
      continue;
    }
    if (res.status === 429) {
      throw new SpotifyError(429, 'RATE_LIMIT', { retryAfter: Number(res.headers.get('Retry-After')) || 3 });
    }
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
    }
    if (!res.ok) throw new SpotifyError(res.status, data?.error?.reason || data?.error?.message || 'ERROR', data);
    return data;
  }
  throw new SpotifyError(401, 'NO_TOKEN');
}

// Pick the album image closest to a wanted width.
function pickImage(images = [], want) {
  if (!images.length) return null;
  return [...images].sort((a, b) => Math.abs((a.width || 640) - want) - Math.abs((b.width || 640) - want))[0].url;
}

export async function getPlayback() {
  const d = await api('GET', '/me/player', { query: { additional_types: 'track,episode' } });
  if (!d || !d.item) return null;
  const it = d.item;
  const images = it.album?.images || it.images || [];
  return {
    id: it.id || it.uri,
    uri: it.uri,
    type: it.type, // 'track' | 'episode'
    isLocal: !!it.is_local,
    name: it.name,
    artists: (it.artists || []).map((a) => a.name).filter(Boolean),
    album: it.album?.name || '',
    art: pickImage(images, 640),
    artSmall: pickImage(images, 300),
    durationMs: it.duration_ms,
    progressMs: d.progress_ms || 0,
    playing: !!d.is_playing,
    device: d.device?.name || '',
    volume: d.device?.volume_percent ?? null,
    canVolume: d.device?.supports_volume !== false,
  };
}

export async function search(q) {
  const d = await api('GET', '/search', { query: { q, type: 'track', limit: 10 } });
  return (d?.tracks?.items || []).map((t) => ({
    uri: t.uri,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    art: pickImage(t.album?.images, 64),
  }));
}

async function startPlayback(body) {
  try {
    await api('PUT', '/me/player/play', { body });
  } catch (e) {
    if (e.status !== 404) throw e;
    // No active device: wake the first one Spotify knows about, then try again.
    const list = await api('GET', '/me/player/devices');
    const dev = list?.devices?.[0];
    if (!dev) throw e;
    await api('PUT', '/me/player', { body: { device_ids: [dev.id], play: false } });
    await new Promise((r) => setTimeout(r, 700));
    await api('PUT', '/me/player/play', { query: { device_id: dev.id }, body });
  }
}

export const play = (uri) => startPlayback({ uris: [uri] });
// Play inside a playlist (so it carries on with the next songs), or the whole playlist if no song is given.
export const playIn = (contextUri, uri) =>
  startPlayback(uri ? { context_uri: contextUri, offset: { uri } } : { context_uri: contextUri });

let meId = null;
async function getMeId() {
  if (!meId) meId = (await api('GET', '/me'))?.id || '';
  return meId;
}

export async function getPlaylists(offset = 0) {
  const [me, d] = await Promise.all([getMeId(), api('GET', '/me/playlists', { query: { limit: 50, offset } })]);
  const items = (d?.items || []).filter(Boolean).map((p) => ({
    id: p.id,
    uri: p.uri,
    name: p.name || 'Untitled playlist',
    art: pickImage(p.images, 160),
    count: p.items?.total ?? p.tracks?.total ?? null, // Spotify renamed "tracks" to "items" in 2026
    owner: p.owner?.display_name || p.owner?.id || '',
    // In development mode Spotify only lets an app open the songs of playlists you own or collaborate on.
    readable: p.owner?.id === me || !!p.collaborative,
  }));
  return { items, hasMore: !!d?.next };
}

export async function getPlaylistTracks(id, offset = 0) {
  const d = await api('GET', `/playlists/${id}/items`, { query: { limit: 50, offset, additional_types: 'track' } });
  const tracks = [];
  for (const e of d?.items || []) {
    const t = e?.item || e?.track; // "track" was renamed "item" in 2026; accept both
    if (!t || t.type !== 'track' || t.is_local || !t.uri) continue;
    tracks.push({
      uri: t.uri,
      name: t.name,
      artists: (t.artists || []).map((a) => a.name).join(', '),
      art: pickImage(t.album?.images, 64),
    });
  }
  return { tracks, hasMore: !!d?.next, total: d?.total ?? null };
}

export const setVolume = (pct) =>
  api('PUT', '/me/player/volume', { query: { volume_percent: Math.max(0, Math.min(100, Math.round(pct))) } });
export const resume = () => api('PUT', '/me/player/play');
export const pause = () => api('PUT', '/me/player/pause');
export const next = () => api('POST', '/me/player/next');
export const previous = () => api('POST', '/me/player/previous');
export const seek = (ms) => api('PUT', '/me/player/seek', { query: { position_ms: Math.max(0, Math.round(ms)) } });
