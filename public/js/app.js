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
  if (!url) return;
  el.art.onload = () => el.art.classList.add('loaded');
  el.art.src = url;
}

function applyPalette(p) {
  bg.setPalette(p.colors);
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

// ---------- search ----------

let searchSeq = 0;
let searchTimer;

function openSearch() {
  el.panel.classList.add('open');
  closeBeatMenu();
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
    const busy = el.panel.classList.contains('open') || !el.overlay.hidden || !el.beatMenu.hidden;
    if (S.track && S.playing && !busy) document.body.classList.add('idle');
  }, 3500);
}

function nudgeOffset(delta) {
  S.offsetMs = Math.max(-5000, Math.min(5000, S.offsetMs + delta));
  localStorage.setItem('lumen.offset', String(S.offsetMs));
  const s = (S.offsetMs / 1000).toFixed(2);
  toast(`Lyrics timing: ${S.offsetMs > 0 ? '+' : ''}${s}s ${S.offsetMs > 0 ? '(later)' : S.offsetMs < 0 ? '(earlier)' : ''}`.trim());
}

// ---------- wiring ----------

function bindUI() {
  el.btnPlay.addEventListener('click', togglePlay);
  el.btnPrev.addEventListener('click', () => skip(-1));
  el.btnNext.addEventListener('click', () => skip(1));
  el.btnSearch.addEventListener('click', openSearch);
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
      case 'Escape': closeSearch(); closeBeatMenu(); break;
      default:
    }
  });
}

// ---------- main loop ----------

let last = performance.now();
let lastVars = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  beat.update(dt);
  bg.frame(now / 1000, dt, beat);

  if (now - lastVars > 80) {
    lastVars = now;
    const st = document.body.style;
    bg.glow.forEach((c, i) => st.setProperty(`--c${i + 1}`, c.join(' ')));
  }

  lyricsFrame();
  updateProgress();

  const pv = Math.round(beat.pulse * 50) / 50;
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
