// Lumen: ties Spotify, lyrics, the gradient and the UI together.

import * as sp from './spotify.js';
import { fetchLyrics, buildFromLRC, findLineIndex } from './lyrics.js';
import { extractPalette, DEFAULT_PALETTE } from './palette.js';
import { Background } from './background.js';
import { BeatListener } from './audio.js';
import { DEMO_TRACK, DEMO_LRC, makeDemoArt } from './demo.js';

const $ = (s) => document.querySelector(s);
const el = {
  stage: $('#stage'), art: $('#art'), artGlow: $('#artGlow'), title: $('#title'), artist: $('#artist'),
  lyrics: $('#lyrics'), inner: $('#lyricsInner'), note: $('#note'),
  seek: $('#seek'), tCur: $('#tCur'), tDur: $('#tDur'),
  btnPlay: $('#btnPlay'), btnPrev: $('#btnPrev'), btnNext: $('#btnNext'),
  btnSearch: $('#btnSearch'), btnBeat: $('#btnBeat'), btnLayout: $('#btnLayout'), btnFs: $('#btnFs'), btnSettings: $('#btnSettings'),
  btnVol: $('#btnVol'), volume: $('#volume'),
  btnLists: $('#btnLists'), listPanel: $('#listPanel'), listBody: $('#listBody'), listTitle: $('#listTitle'), listBack: $('#listBack'), closeList: $('#closeList'),
  btnStyle: $('#btnStyle'), stylePanel: $('#stylePanel'), styleBody: $('#styleBody'), closeStyle: $('#closeStyle'),
  panel: $('#searchPanel'), searchInput: $('#searchInput'), results: $('#results'), closeSearch: $('#closeSearch'),
  beatMenu: $('#beatMenu'),
  overlay: $('#overlay'), ovSetup: $('#ovSetup'), ovConnect: $('#ovConnect'),
  clientId: $('#clientId'), redirect: $('#redirect'), copyRedirect: $('#copyRedirect'),
  saveClient: $('#saveClient'), cancelOv: $('#cancelOv'), signOut: $('#signOut'),
  connect: $('#connect'), changeClient: $('#changeClient'),
  toast: $('#toast'),
};

const S = {
  demo: false,
  volume: 70,
  prevVol: 50,
  volTouched: -1e9,
  albumColors: DEFAULT_PALETTE.colors,
  track: null,
  lyrics: null,
  lines: [],
  nodes: [],
  idx: -2,
  wIdx: -1,
  anchorMs: 0, // playback position at anchorAt
  anchorAt: 0,
  playing: false,
  offsetMs: Number(localStorage.getItem('lumen.offset') || 0), // nudge lyrics earlier/later
  layout: localStorage.getItem('lumen.layout') || 'split',
  seeking: false,
  pollTimer: null,
  lastSeekV: -1,
  lastSec: -1,
  lastPulse: -1,
};

const bg = new Background($('#bg'));
const beat = new BeatListener();

// ---------- small helpers ----------

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

let toastTimer;
function toast(msg, ms = 3600) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function currentPos() {
  const tr = S.track;
  let p = S.anchorMs + (S.playing ? performance.now() - S.anchorAt : 0);
  if (tr) {
    if (S.demo && p >= tr.durationMs) {
      S.anchorMs = 0;
      S.anchorAt = performance.now();
      p = 0;
    }
    p = Math.min(p, tr.durationMs);
  }
  return Math.max(0, p);
}

function syncPlayIcon() {
  el.btnPlay.classList.toggle('playing', S.playing);
}

function handleErr(e) {
  if (e?.status === 403 && /PREMIUM/i.test(e.reason || '')) return toast('Playback controls need Spotify Premium.');
  if (e?.status === 404 || /NO_ACTIVE_DEVICE/i.test(e?.reason || '')) {
    return toast('No active Spotify device. Open Spotify on this PC and press play once.');
  }
  if (e?.status === 429) return toast('Spotify is busy. Try again in a moment.');
  if (e?.status === 401 || e?.reason === 'NO_TOKEN') return showOverlay('connect');
  console.warn(e);
  toast(`Spotify said: ${e?.reason || e?.message || 'something went wrong'}`);
}

// ---------- lyrics view ----------

function note(msg, hint = false) {
  el.note.textContent = msg || '';
  el.note.classList.toggle('show', !!msg);
  el.note.classList.toggle('hint', !!msg && hint);
}

function clearLyrics(msg) {
  S.lyrics = null;
  S.lines = [];
  S.nodes = [];
  S.idx = -2;
  S.wIdx = -1;
  el.inner.innerHTML = '';
  el.inner.style.transform = '';
  note(msg);
}

function renderLyrics(ly) {
  clearLyrics('');
  S.lyrics = ly;
  S.lines = ly.lines || [];
  if (ly.type === 'instrumental') return note('Instrumental');
  if (!S.lines.length) return note('No lyrics found for this song');
  if (ly.type === 'plain') note("These lyrics aren't timed, so the scroll is an estimate.", true);

  const seekable = ly.type === 'synced';
  const frag = document.createDocumentFragment();
  S.lines.forEach((ln, i) => {
    const d = document.createElement('div');
    d.className = 'line' + (ln.gap ? ' gap' : '') + (seekable && !ln.gap ? ' seekable' : '');
    if (ln.gap) {
      d.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    } else {
      ln.words.forEach((w) => {
        const s = document.createElement('span');
        s.className = 'w';
        s.textContent = w;
        d.appendChild(s);
        d.appendChild(document.createTextNode(' '));
      });
      if (seekable) d.addEventListener('click', () => seekTo(ln.t * 1000 - S.offsetMs));
    }
    frag.appendChild(d);
  });
  el.inner.appendChild(frag);
  S.nodes = [...el.inner.children];
  S.idx = -2;
  S.wIdx = -1;
  applyLineClasses();
  layoutScroll(true);
}

function applyLineClasses() {
  const ref = S.idx;
  S.nodes.forEach((n, j) => {
    const d = Math.abs(j - Math.max(ref, 0));
    n.style.setProperty('--d', String(Math.min(d, 8)));
    n.classList.toggle('active', j === ref);
    n.classList.toggle('past', j < ref);
    n.classList.toggle('future', j > ref);
    n.classList.toggle('far', d > 6);
  });
}

function applyWordClasses() {
  const n = S.nodes[S.idx];
  if (!n) return;
  n.querySelectorAll('.w').forEach((w, k) => {
    w.classList.toggle('lit', k <= S.wIdx);
    w.classList.toggle('cur', k === S.wIdx);
  });
}

function layoutScroll(instant = false) {
  const n = S.nodes[Math.max(S.idx, 0)];
  if (!n) return;
  const H = el.lyrics.clientHeight;
  const y = n.offsetTop + n.offsetHeight / 2;
  const ty = H * 0.44 - y;
  if (instant) el.inner.style.transition = 'none';
  el.inner.style.transform = `translateY(${ty}px)`;
  if (instant) {
    void el.inner.offsetHeight;
    el.inner.style.transition = '';
  }
}

function lyricsFrame() {
  if (!S.lines.length) return;
  const t = (currentPos() + S.offsetMs) / 1000;
  const i = findLineIndex(S.lines, t);
  if (i !== S.idx) {
    S.idx = i;
    S.wIdx = -1;
    applyLineClasses();
    applyWordClasses();
    layoutScroll();
  }
  if (i >= 0 && !S.lines[i].gap) {
    const ln = S.lines[i];
    const p = (t - ln.t) / ln.dur;
    let wi = -1;
    for (let k = 0; k < ln.ws.length; k++) {
      if (p >= ln.ws[k]) wi = k;
      else break;
    }
    if (wi !== S.wIdx) {
      S.wIdx = wi;
      applyWordClasses();
    }
  }
}

// ---------- now playing ----------

function setArt(url) {
  el.art.classList.remove('loaded');
  bg.setArt(url || null);
  if (!url) return;
  el.art.onload = () => el.art.classList.add('loaded');
  el.art.src = url;
}

function applyPalette(p) {
  S.albumColors = p.colors;
  bg.setPalette(effectivePalette());
}

function setIdle() {
  el.title.textContent = 'Nothing playing';
  el.artist.textContent = '';
  el.art.classList.remove('loaded');
  clearLyrics('Start a song in Spotify, or search for one.');
  document.title = 'Lumen';
}

async function setTrack(st) {
  S.track = st;
  S.lastSeekV = -1;
  S.lastSec = -1;
  el.title.textContent = st.name;
  el.artist.textContent = st.artists.join(', ');
  el.tDur.textContent = fmt(st.durationMs / 1000);
  document.title = `${st.name} · ${st.artists[0] || ''} · Lumen`;
  setArt(st.art);
  clearLyrics('Finding lyrics…');
  const id = st.id;
  extractPalette(st.artSmall || st.art).then((p) => {
    if (S.track?.id === id) applyPalette(p);
  });
  if (st.type !== 'track' || st.isLocal) return note('No lyrics for this one.');
  try {
    const ly = await fetchLyrics(st);
    if (S.track?.id === id) renderLyrics(ly);
  } catch (e) {
    console.warn(e);
    if (S.track?.id === id) note("Couldn't reach the lyrics service. Check your connection.");
  }
}

function applyPlayback(st, rtt) {
  if (!st) {
    if (!S.track) setIdle();
    if (S.playing) {
      S.anchorMs = currentPos();
      S.anchorAt = performance.now();
      S.playing = false;
      syncPlayIcon();
    }
    return;
  }
  const now = performance.now();
  const pos = st.progressMs + (st.playing ? rtt / 2 : 0);
  if (!S.track || S.track.id !== st.id) {
    S.anchorMs = pos;
    S.anchorAt = now;
    S.playing = st.playing;
    setTrack(st);
  } else {
    const pred = currentPos();
    const diff = pos - pred;
    if (S.playing !== st.playing || Math.abs(diff) > 1500) {
      S.anchorMs = pos; // jumped or changed state: snap
    } else {
      S.anchorMs = pred + diff * 0.35; // small drift: ease toward Spotify's number
    }
    S.anchorAt = now;
    S.playing = st.playing;
    S.track.durationMs = st.durationMs;
  }
  if (st.volume != null && performance.now() - S.volTouched > 3500) {
    S.volume = st.volume;
    el.volume.value = st.volume;
    volIcon();
  }
  el.volume.disabled = st.canVolume === false;
  el.volume.title = st.canVolume === false ? "This device doesn't allow volume control from Lumen" : '';
  syncPlayIcon();
}

async function poll() {
  clearTimeout(S.pollTimer);
  let wait = S.playing ? 2000 : 3500;
  try {
    const t0 = performance.now();
    const st = await sp.getPlayback();
    applyPlayback(st, performance.now() - t0);
  } catch (e) {
    if (e.status === 429) wait = (e.data?.retryAfter || 5) * 1000 + 500;
    else if (e.status === 401 || e.reason === 'NO_TOKEN') return showOverlay('connect');
    else console.warn(e);
  }
  S.pollTimer = setTimeout(poll, wait);
}

// ---------- controls ----------

function seekTo(ms) {
  S.anchorMs = Math.max(0, ms);
  S.anchorAt = performance.now();
  if (S.demo) return;
  sp.seek(ms).then(() => setTimeout(poll, 600)).catch(handleErr);
}

async function togglePlay() {
  if (!S.track) return;
  const want = !S.playing;
  S.anchorMs = currentPos();
  S.anchorAt = performance.now();
  S.playing = want;
  syncPlayIcon();
  if (S.demo) return;
  try {
    await (want ? sp.resume() : sp.pause());
    setTimeout(poll, 700);
  } catch (e) {
    S.playing = !want;
    syncPlayIcon();
    handleErr(e);
  }
}

async function skip(dir) {
  if (S.demo) {
    S.anchorMs = 0;
    S.anchorAt = performance.now();
    return;
  }
  try {
    await (dir > 0 ? sp.next() : sp.previous());
    setTimeout(poll, 500);
  } catch (e) {
    handleErr(e);
  }
}

function updateProgress() {
  if (!S.track || S.seeking) return;
  const pos = currentPos();
  const v = Math.round((pos / S.track.durationMs) * 1000);
  if (v !== S.lastSeekV) {
    el.seek.value = v;
    el.seek.style.setProperty('--p', `${v / 10}%`);
    S.lastSeekV = v;
  }
  const s = Math.floor(pos / 1000);
  if (s !== S.lastSec) {
    el.tCur.textContent = fmt(s);
    S.lastSec = s;
  }
}

// ---------- volume ----------

let volTimer;
function volIcon() {
  el.btnVol.dataset.level = S.volume === 0 ? 'mute' : S.volume < 40 ? 'low' : 'high';
}
function volErr(e) {
  if (e?.status === 403) return toast("This device doesn't allow volume control from Lumen. Use Spotify's own volume.", 5200);
  handleErr(e);
}
function setVolume(v) {
  S.volume = Math.max(0, Math.min(100, Math.round(v)));
  S.volTouched = performance.now();
  el.volume.value = S.volume;
  volIcon();
  if (S.demo) return;
  clearTimeout(volTimer);
  volTimer = setTimeout(() => sp.setVolume(S.volume).catch(volErr), 150);
}
function toggleMute() {
  if (S.volume > 0) {
    S.prevVol = S.volume;
    setVolume(0);
  } else setVolume(S.prevVol || 50);
}

// ---------- search ----------

let searchSeq = 0;
let searchTimer;

function openSearch() {
  el.panel.classList.add('open');
  closeBeatMenu();
  closeStyle();
  closeLists();
  setTimeout(() => el.searchInput.focus(), 200);
}
function closeSearch() {
  el.panel.classList.remove('open');
  el.searchInput.blur();
}

function showResultsMessage(msg) {
  el.results.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = msg;
  el.results.appendChild(p);
}

async function runSearch() {
  const q = el.searchInput.value.trim();
  if (!q) return showResultsMessage('Type a song or artist. Press Enter to pick the first match.');
  if (S.demo) return showResultsMessage('Search works once you connect Spotify.');
  const seq = ++searchSeq;
  try {
    const items = await sp.search(q);
    if (seq !== searchSeq) return;
    if (!items.length) return showResultsMessage(`No songs found for "${q}".`);
    el.results.innerHTML = '';
    items.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'result';
      const img = document.createElement('img');
      img.alt = '';
      if (t.art) img.src = t.art;
      const box = document.createElement('span');
      const name = document.createElement('span');
      name.className = 't';
      name.textContent = t.name;
      const sub = document.createElement('span');
      sub.className = 's';
      sub.textContent = `${t.artists} · ${t.album}`;
      box.append(name, sub);
      b.append(img, box);
      b.addEventListener('click', () => playUri(t.uri));
      el.results.appendChild(b);
    });
  } catch (e) {
    if (seq === searchSeq) handleErr(e);
  }
}

async function playUri(uri) {
  try {
    await sp.play(uri);
    toast('Playing');
    closeSearch();
    setTimeout(poll, 800);
  } catch (e) {
    handleErr(e);
  }
}

// ---------- beat reaction ----------

function closeBeatMenu() {
  el.beatMenu.hidden = true;
}

function beatError(e) {
  if (e?.name === 'NO_AUDIO') return 'No sound was shared. Choose "Entire screen" and tick "Also share system audio".';
  if (e?.name === 'NotAllowedError') return 'Permission was declined, so the beat reaction stays off.';
  if (e?.name === 'NotFoundError') return 'No microphone found.';
  return "Couldn't start audio capture. Use Chrome or Edge on Windows.";
}

async function setBeat(mode) {
  closeBeatMenu();
  try {
    if (mode === 'off') await beat.stop();
    else {
      await beat.start(mode);
      toast('Listening. The background will now move with the music.');
    }
  } catch (e) {
    toast(beatError(e), 5200);
  }
  el.btnBeat.classList.toggle('on', beat.active || beat.demo);
}
beat.onend = () => {
  el.btnBeat.classList.toggle('on', false);
  toast('Audio capture stopped.');
};

// ---------- setup overlay ----------

function showOverlay(mode, { cancelable = false } = {}) {
  el.overlay.hidden = false;
  el.ovSetup.hidden = mode !== 'setup';
  el.ovConnect.hidden = mode !== 'connect';
  el.redirect.textContent = sp.redirectUri();
  el.clientId.value = sp.getClientId();
  el.cancelOv.hidden = !cancelable;
  el.signOut.hidden = !(cancelable && sp.isSignedIn());
  if (mode === 'setup') setTimeout(() => el.clientId.focus(), 60);
}
const hideOverlay = () => (el.overlay.hidden = true);

function saveClient() {
  const id = el.clientId.value.trim();
  if (!/^[a-f0-9]{32}$/i.test(id)) return toast("That doesn't look like a Client ID. It's 32 letters and numbers.");
  if (id !== sp.getClientId()) {
    sp.setClientId(id);
    sp.signOut();
  }
  if (sp.isSignedIn()) {
    hideOverlay();
    poll();
  } else showOverlay('connect');
}

// ---------- layout, fullscreen, idle ----------

function applyLayout() {
  el.stage.dataset.layout = S.layout;
  localStorage.setItem('lumen.layout', S.layout);
  layoutScroll(true);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast("Your browser wouldn't enter full screen."));
}

let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const busy = el.panel.classList.contains('open') || el.stylePanel.classList.contains('open') || el.listPanel.classList.contains('open') || !el.overlay.hidden || !el.beatMenu.hidden;
    if (S.track && S.playing && !busy) document.body.classList.add('idle');
  }, 3500);
}

function nudgeOffset(delta) {
  S.offsetMs = Math.max(-5000, Math.min(5000, S.offsetMs + delta));
  localStorage.setItem('lumen.offset', String(S.offsetMs));
  const s = (S.offsetMs / 1000).toFixed(2);
  toast(`Lyrics timing: ${S.offsetMs > 0 ? '+' : ''}${s}s ${S.offsetMs > 0 ? '(later)' : S.offsetMs < 0 ? '(earlier)' : ''}`.trim());
}

// ---------- customise ----------

const DEFAULTS = {
  bg: 'flow',
  colorMode: 'album',
  custom: ['#ff5e78', '#7850ff', '#3cc8ff', '#ffb05c'],
  beat: 1,
  speed: 1,
  glow: 1,
  size: 1,
  font: 'bricolage',
  align: 'auto',
};

const BACKGROUNDS = [['flow', 'Flowing'], ['aurora', 'Aurora'], ['spotlight', 'Spotlight'], ['art', 'Album blur'], ['solid', 'Solid']];
const FONTS = {
  bricolage: { label: 'Bricolage', css: "'Bricolage Grotesque'", w: 800, track: '-0.025em', s: 1 },
  dm: { label: 'DM Sans', css: "'DM Sans'", w: 700, track: '-0.03em', s: 1 },
  fraunces: { label: 'Fraunces', css: "'Fraunces'", w: 800, track: '-0.02em', s: 1 },
  space: { label: 'Space Grotesk', css: "'Space Grotesk'", w: 700, track: '-0.03em', s: 0.96 },
  caveat: { label: 'Handwritten', css: "'Caveat'", w: 700, track: '0', s: 1.3 },
  poppins: { label: 'Poppins', css: "'Poppins'", w: 700, track: '-0.02em', s: 0.96 },
  montserrat: { label: 'Montserrat', css: "'Montserrat'", w: 800, track: '-0.03em', s: 0.94 },
  outfit: { label: 'Outfit', css: "'Outfit'", w: 700, track: '-0.02em', s: 1.02 },
  syne: { label: 'Syne', css: "'Syne'", w: 800, track: '-0.03em', s: 0.95 },
  archivo: { label: 'Archivo Black', css: "'Archivo Black'", w: 400, track: '-0.02em', s: 0.92 },
  bebas: { label: 'Bebas Neue', css: "'Bebas Neue'", w: 400, track: '0.01em', s: 1.3 },
  playfair: { label: 'Playfair', css: "'Playfair Display'", w: 800, track: '-0.02em', s: 0.98 },
  pacifico: { label: 'Pacifico', css: "'Pacifico'", w: 400, track: '0', s: 0.82 },
  righteous: { label: 'Righteous', css: "'Righteous'", w: 400, track: '0', s: 0.95 },
  mono: { label: 'Space Mono', css: "'Space Mono'", w: 700, track: '-0.04em', s: 0.78 },
};
const PRESETS = [
  ['Sunset', ['#ff5e78', '#ff9a3c', '#ffd166', '#c04cfd']],
  ['Ocean', ['#3cc8ff', '#4f7cff', '#2ee6c5', '#7a5cff']],
  ['Neon', ['#ff2d95', '#00e5ff', '#b6ff3c', '#8a2be2']],
  ['Ember', ['#ff4d4d', '#ff8a3c', '#ffc14d', '#b3122e']],
  ['Mono', ['#e6e9ff', '#9aa4e8', '#6f7fd0', '#cdbfff']],
];

function loadCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem('lumen.settings') || '{}');
    const c = { ...DEFAULTS, ...raw };
    if (!Array.isArray(c.custom) || c.custom.length !== 4) c.custom = DEFAULTS.custom.slice();
    return c;
  } catch {
    return { ...DEFAULTS, custom: DEFAULTS.custom.slice() };
  }
}
const cfg = loadCfg();
function saveCfg() {
  try {
    localStorage.setItem('lumen.settings', JSON.stringify(cfg));
  } catch {
    /* storage unavailable: settings last for this visit only */
  }
}

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const effectivePalette = () => (cfg.colorMode === 'custom' ? cfg.custom.map(hexToRgb) : S.albumColors);

const ui = { chips: {}, sliders: {}, swatches: [], customBox: null };

function applyCfg() {
  bg.setStyle(cfg.bg);
  bg.speed = cfg.speed;
  bg.wobble = cfg.colorMode === 'custom' ? 4 : 16;
  bg.setPalette(effectivePalette());
  const f = FONTS[cfg.font] || FONTS.bricolage;
  const r = document.documentElement.style;
  r.setProperty('--glow', String(cfg.glow));
  r.setProperty('--ls', String(cfg.size * f.s));
  r.setProperty('--lyric-font', `${f.css}, 'Segoe UI', system-ui, sans-serif`);
  r.setProperty('--lyric-weight', String(f.w));
  r.setProperty('--lyric-track', f.track);
  el.stage.dataset.align = cfg.align;
  layoutScroll(true);
  refreshStyleUI();
}

function refreshStyleUI() {
  for (const [key, buttons] of Object.entries(ui.chips)) {
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.val === String(cfg[key]))));
  }
  for (const [key, s] of Object.entries(ui.sliders)) {
    s.input.value = cfg[key];
    s.out.textContent = s.fmt(cfg[key]);
  }
  ui.swatches.forEach((inp, i) => (inp.value = cfg.custom[i]));
  ui.customBox?.classList.toggle('hide', cfg.colorMode !== 'custom');
}

function buildStylePanel() {
  const body = el.styleBody;
  body.innerHTML = '';
  const group = (title) => {
    const g = document.createElement('section');
    g.className = 'grp';
    const h = document.createElement('h3');
    h.textContent = title;
    g.append(h);
    body.append(g);
    return g;
  };
  const chipRow = (parent, key, options) => {
    const row = document.createElement('div');
    row.className = 'chips';
    ui.chips[key] = options.map(([val, label]) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = label;
      b.dataset.val = val;
      if (key === 'font') b.style.fontFamily = `${FONTS[val].css}, sans-serif`;
      b.addEventListener('click', () => {
        cfg[key] = val;
        saveCfg();
        applyCfg();
      });
      row.append(b);
      return b;
    });
    parent.append(row);
    return row;
  };
  const slider = (parent, key, label, min, max, step, fmt) => {
    const wrap = document.createElement('label');
    wrap.className = 'sl';
    const top = document.createElement('span');
    const name = document.createElement('i');
    name.style.fontStyle = 'normal';
    name.textContent = label;
    const out = document.createElement('b');
    top.append(name, out);
    const input = document.createElement('input');
    input.type = 'range';
    Object.assign(input, { min, max, step });
    input.addEventListener('input', () => {
      cfg[key] = Number(input.value);
      out.textContent = fmt(cfg[key]);
      saveCfg();
      applyCfg();
    });
    wrap.append(top, input);
    parent.append(wrap);
    ui.sliders[key] = { input, out, fmt };
  };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const spacer = (px) => {
    const d = document.createElement('div');
    d.style.height = `${px}px`;
    return d;
  };

  const g1 = group('Background');
  chipRow(g1, 'bg', BACKGROUNDS);

  const g2 = group('Colours');
  chipRow(g2, 'colorMode', [['album', 'From the album'], ['custom', 'My colours']]);
  const box = document.createElement('div');
  ui.customBox = box;
  const presets = document.createElement('div');
  presets.className = 'chips presets';
  PRESETS.forEach(([label, cols]) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.addEventListener('click', () => {
      cfg.custom = cols.slice();
      saveCfg();
      applyCfg();
    });
    presets.append(b);
  });
  const sw = document.createElement('div');
  sw.className = 'swatches';
  ui.swatches = [0, 1, 2, 3].map((i) => {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.setAttribute('aria-label', `Colour ${i + 1}`);
    inp.addEventListener('input', () => {
      cfg.custom[i] = inp.value;
      saveCfg();
      applyCfg();
    });
    sw.append(inp);
    return inp;
  });
  box.append(presets, sw);
  g2.append(box);

  const g3 = group('Motion');
  slider(g3, 'beat', 'Beat strength', 0, 2, 0.05, pct);
  g3.append(spacer(12));
  slider(g3, 'speed', 'Motion speed', 0.3, 2, 0.05, pct);
  g3.append(spacer(12));
  slider(g3, 'glow', 'Glow', 0, 2, 0.05, pct);

  const g4 = group('Lyrics text');
  slider(g4, 'size', 'Size', 0.7, 1.5, 0.05, pct);
  const sp1 = document.createElement('div');
  sp1.style.height = '14px';
  g4.append(sp1);
  chipRow(g4, 'font', Object.entries(FONTS).map(([id, f]) => [id, f.label]));
  const sp2 = document.createElement('div');
  sp2.style.height = '12px';
  g4.append(sp2);
  chipRow(g4, 'align', [['auto', 'Auto'], ['left', 'Left'], ['center', 'Centre']]);

  const reset = document.createElement('button');
  reset.className = 'ghost reset';
  reset.textContent = 'Reset to defaults';
  reset.addEventListener('click', () => {
    Object.assign(cfg, DEFAULTS, { custom: DEFAULTS.custom.slice() });
    saveCfg();
    applyCfg();
    toast('Customise settings reset.');
  });
  body.append(reset);
}

function openStyle() {
  el.stylePanel.classList.add('open');
  closeSearch();
  closeLists();
  closeBeatMenu();
}
function closeStyle() {
  el.stylePanel.classList.remove('open');
}
function toggleStyle() {
  if (el.stylePanel.classList.contains('open')) closeStyle();
  else openStyle();
}

// ---------- playlists ----------

const PL = { items: [], hasMore: false, loaded: false, cur: null, tracks: [], tHasMore: false };

function plMessage(msg, actionLabel, action) {
  el.listBody.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = msg;
  el.listBody.append(p);
  if (actionLabel) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = actionLabel;
    b.addEventListener('click', action);
    el.listBody.append(b);
  }
}

function plRow(img, title, sub, onClick) {
  const b = document.createElement('button');
  b.className = 'result';
  const im = document.createElement('img');
  im.alt = '';
  if (img) im.src = img;
  const box = document.createElement('span');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = title;
  const s = document.createElement('span');
  s.className = 's';
  s.textContent = sub;
  box.append(t, s);
  b.append(im, box);
  b.addEventListener('click', onClick);
  return b;
}

function plError(e, retry) {
  if (e?.status === 429) return plMessage('Spotify is busy. Try again in a moment.', 'Try again', retry);
  if (e?.status === 401 || e?.reason === 'NO_TOKEN') return showOverlay('connect');
  if (e?.status === 403) {
    return plMessage('Lumen needs your permission to read your playlists.', 'Reconnect Spotify', () => sp.login().catch((er) => toast(er.message)));
  }
  console.warn(e);
  plMessage("Couldn't load playlists. Check your connection.", 'Try again', retry);
}

function renderPlaylists() {
  PL.cur = null;
  el.listTitle.textContent = 'Playlists';
  el.listBack.classList.add('hide');
  if (!PL.items.length) return plMessage('No playlists found in your Spotify library.');
  el.listBody.innerHTML = '';
  const rows = document.createElement('div');
  rows.className = 'rows';
  PL.items.forEach((p) => {
    const n = p.count != null ? `${p.count} songs · ` : '';
    const sub = p.readable ? `${n}${p.owner}` : `${p.owner} · tap to play`;
    rows.append(plRow(p.art, p.name, sub, () => (p.readable ? openPlaylist(p) : playPlaylist(p))));
  });
  el.listBody.append(rows);
  if (PL.hasMore) {
    const more = document.createElement('button');
    more.className = 'ghost more';
    more.textContent = 'Show more';
    more.addEventListener('click', () => loadPlaylists(false));
    el.listBody.append(more);
  }
}

async function loadPlaylists(reset) {
  if (reset) {
    PL.items = [];
    PL.hasMore = false;
    plMessage('Loading playlists…');
  }
  try {
    const d = await sp.getPlaylists(PL.items.length);
    PL.items.push(...d.items);
    PL.hasMore = d.hasMore;
    PL.loaded = true;
    renderPlaylists();
  } catch (e) {
    plError(e, () => loadPlaylists(reset));
  }
}

async function playPlaylist(p, uri) {
  try {
    await sp.playIn(p.uri, uri);
    toast(uri ? 'Playing' : `Playing ${p.name}`);
    closeLists();
    setTimeout(poll, 800);
  } catch (e) {
    handleErr(e);
  }
}

function renderTracks() {
  const p = PL.cur;
  el.listBody.innerHTML = '';
  const actions = document.createElement('div');
  actions.className = 'pl-actions';
  const play = document.createElement('button');
  play.className = 'primary';
  play.textContent = 'Play playlist';
  play.addEventListener('click', () => playPlaylist(p));
  actions.append(play);
  el.listBody.append(actions);
  if (!PL.tracks.length) {
    const m = document.createElement('p');
    m.className = 'empty';
    m.textContent = 'No songs to show. You can still play the playlist.';
    el.listBody.append(m);
    return;
  }
  const rows = document.createElement('div');
  rows.className = 'rows';
  PL.tracks.forEach((t) => rows.append(plRow(t.art, t.name, t.artists, () => playPlaylist(p, t.uri))));
  el.listBody.append(rows);
  if (PL.tHasMore) {
    const more = document.createElement('button');
    more.className = 'ghost more';
    more.textContent = 'Show more';
    more.addEventListener('click', () => loadTracks(false));
    el.listBody.append(more);
  }
}

async function loadTracks(reset) {
  const p = PL.cur;
  if (reset) {
    PL.tracks = [];
    PL.tHasMore = false;
    plMessage('Loading songs…');
  }
  try {
    const d = await sp.getPlaylistTracks(p.id, PL.tracks.length);
    if (PL.cur !== p) return;
    PL.tracks.push(...d.tracks);
    PL.tHasMore = d.hasMore;
    renderTracks();
  } catch (e) {
    if (PL.cur !== p) return;
    if (e?.status === 403 || e?.status === 404) {
      PL.tracks = [];
      PL.tHasMore = false;
      renderTracks();
      return toast("Spotify doesn't let apps in development mode list this playlist's songs.", 5200);
    }
    plError(e, () => loadTracks(reset));
  }
}

function openPlaylist(p) {
  PL.cur = p;
  el.listTitle.textContent = p.name;
  el.listBack.classList.remove('hide');
  loadTracks(true);
}

function openLists() {
  el.listPanel.classList.add('open');
  closeSearch();
  closeStyle();
  closeBeatMenu();
  if (S.demo) return plMessage('Playlists work once you connect Spotify.');
  if (!sp.hasScope('playlist-read-private')) {
    return plMessage('Lumen needs your permission to read your playlists. You only do this once.', 'Reconnect Spotify', () =>
      sp.login().catch((e) => toast(e.message))
    );
  }
  if (PL.loaded) renderPlaylists();
  else loadPlaylists(true);
}
function closeLists() {
  el.listPanel.classList.remove('open');
}
function toggleLists() {
  if (el.listPanel.classList.contains('open')) closeLists();
  else openLists();
}

// ---------- wiring ----------

function bindUI() {
  el.btnPlay.addEventListener('click', togglePlay);
  el.btnPrev.addEventListener('click', () => skip(-1));
  el.btnNext.addEventListener('click', () => skip(1));
  el.btnSearch.addEventListener('click', openSearch);
  el.btnStyle.addEventListener('click', toggleStyle);
  el.btnLists.addEventListener('click', toggleLists);
  el.volume.addEventListener('input', () => setVolume(Number(el.volume.value)));
  el.btnVol.addEventListener('click', toggleMute);
  el.closeList.addEventListener('click', closeLists);
  el.listBack.addEventListener('click', renderPlaylists);
  el.closeStyle.addEventListener('click', closeStyle);
  el.closeSearch.addEventListener('click', closeSearch);
  el.btnFs.addEventListener('click', toggleFullscreen);
  el.btnLayout.addEventListener('click', () => {
    S.layout = S.layout === 'split' ? 'center' : 'split';
    applyLayout();
  });
  el.btnBeat.addEventListener('click', (e) => {
    e.stopPropagation();
    el.beatMenu.hidden = !el.beatMenu.hidden;
  });
  el.beatMenu.querySelectorAll('[data-beat]').forEach((b) => b.addEventListener('click', () => setBeat(b.dataset.beat)));
  document.addEventListener('click', (e) => {
    if (!el.beatMenu.hidden && !el.beatMenu.contains(e.target) && e.target !== el.btnBeat) closeBeatMenu();
  });

  el.btnSettings.addEventListener('click', () => (S.demo ? showOverlay('setup') : showOverlay('setup', { cancelable: true })));
  el.cancelOv.addEventListener('click', hideOverlay);
  el.saveClient.addEventListener('click', saveClient);
  el.clientId.addEventListener('keydown', (e) => e.key === 'Enter' && saveClient());
  el.copyRedirect.addEventListener('click', () => {
    navigator.clipboard?.writeText(sp.redirectUri()).then(() => toast('Redirect URI copied.'));
  });
  el.connect.addEventListener('click', () => sp.login().catch((e) => toast(e.message)));
  el.changeClient.addEventListener('click', () => showOverlay('setup', { cancelable: false }));
  el.signOut.addEventListener('click', () => {
    sp.signOut();
    clearTimeout(S.pollTimer);
    S.track = null;
    S.playing = false;
    syncPlayIcon();
    setIdle();
    showOverlay('connect');
  });

  el.seek.addEventListener('input', () => {
    if (!S.track) return;
    S.seeking = true;
    el.tCur.textContent = fmt(((el.seek.value / 1000) * S.track.durationMs) / 1000);
    el.seek.style.setProperty('--p', `${el.seek.value / 10}%`);
  });
  el.seek.addEventListener('change', () => {
    if (!S.track) return;
    S.seeking = false;
    seekTo((el.seek.value / 1000) * S.track.durationMs);
  });

  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 350);
  });
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.results.querySelector('.result')?.click();
  });

  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    el.btnFs.classList.toggle('on', on);
    setTimeout(() => layoutScroll(true), 100);
  });
  addEventListener('resize', () => layoutScroll(true));
  ['mousemove', 'keydown', 'pointerdown', 'touchstart'].forEach((ev) => addEventListener(ev, wake, { passive: true }));

  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches('input, textarea')) {
      if (e.key === 'Escape') {
        closeSearch();
        closeStyle();
        e.target.blur();
      }
      return;
    }
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 's': case 'S': case '/': e.preventDefault(); openSearch(); break;
      case 'b': case 'B': el.beatMenu.hidden = !el.beatMenu.hidden; break;
      case 'l': case 'L': el.btnLayout.click(); break;
      case '[': nudgeOffset(-250); break;
      case ']': nudgeOffset(250); break;
      case 'ArrowRight': skip(1); break;
      case 'ArrowLeft': skip(-1); break;
      case 'c': case 'C': toggleStyle(); break;
      case 'p': case 'P': toggleLists(); break;
      case 'm': case 'M': toggleMute(); break;
      case 'ArrowUp': e.preventDefault(); setVolume(S.volume + 5); break;
      case 'ArrowDown': e.preventDefault(); setVolume(S.volume - 5); break;
      case 'Escape': closeSearch(); closeBeatMenu(); closeStyle(); closeLists(); break;
      default:
    }
  });
}

// ---------- main loop ----------

const eff = { level: 0, bass: 0, pulse: 0 }; // the beat after the strength setting is applied
let last = performance.now();
let lastVars = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  beat.update(dt);
  const k = cfg.beat;
  eff.level = Math.min(1, beat.level * k);
  eff.bass = Math.min(1, beat.bass * k);
  eff.pulse = Math.min(1.6, beat.pulse * k);
  bg.frame(now / 1000, dt, eff);

  if (now - lastVars > 80) {
    lastVars = now;
    const st = document.body.style;
    bg.glow.forEach((c, i) => st.setProperty(`--c${i + 1}`, c.join(' ')));
  }

  lyricsFrame();
  updateProgress();

  const pv = Math.round(eff.pulse * 50) / 50;
  if (pv !== S.lastPulse) {
    S.lastPulse = pv;
    S.nodes[S.idx]?.style.setProperty('--pulse', String(pv));
    el.artGlow.style.setProperty('--pulse', String(pv));
  }
  requestAnimationFrame(frame);
}

// ---------- start ----------

function startDemo() {
  S.demo = true;
  beat.demo = true;
  el.btnBeat.classList.add('on');
  const art = makeDemoArt();
  S.track = { ...DEMO_TRACK, art, artSmall: art };
  S.anchorMs = 0;
  S.anchorAt = performance.now();
  S.playing = true;
  syncPlayIcon();
  el.title.textContent = DEMO_TRACK.name;
  el.artist.textContent = DEMO_TRACK.artists.join(', ');
  el.tDur.textContent = fmt(DEMO_TRACK.durationMs / 1000);
  setArt(art);
  extractPalette(art).then(applyPalette);
  renderLyrics(buildFromLRC(DEMO_LRC, DEMO_TRACK.durationMs / 1000));
  toast('Preview mode. Open Spotify settings (top right) to connect real songs.', 6000);
}

async function boot() {
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }
  applyPalette(DEFAULT_PALETTE);
  bindUI();
  applyLayout();
  buildStylePanel();
  applyCfg();
  volIcon();
  syncPlayIcon();
  requestAnimationFrame(frame);
  wake();

  if (new URLSearchParams(location.search).has('demo')) return startDemo();

  if (!sp.getClientId()) return showOverlay('setup');
  try {
    await sp.handleRedirect();
  } catch (e) {
    toast(e.message || 'Login failed.', 6000);
  }
  if (!sp.isSignedIn()) return showOverlay('connect');
  hideOverlay();
  setIdle();
  poll();
}

boot();
