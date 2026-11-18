// Beat detection from live audio.
// Spotify no longer exposes beat/tempo data to new apps, so Lumen listens to the sound itself:
// either the system audio (screen-share with audio) or the microphone. The audio is analysed in
// the browser and is never recorded, stored or sent anywhere.

export class BeatListener {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.data = null;
    this.prev = null;
    this.mode = 'off'; // 'system' | 'mic' | 'off'
    this.active = false;
    this.demo = false; // simulated pulse for the preview mode
    this.level = 0; // overall loudness, 0..1
    this.bass = 0; // low-end energy, 0..1
    this.pulse = 0; // jumps to ~1 on a beat, then decays
    this.flux = [];
    this.lastBeat = 0;
    this.phase = 0;
    this.onend = null;
  }

  async start(mode) {
    await this.stop();
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream;
    if (mode === 'system') {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: raw,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: raw });
    }

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      const err = new Error('No audio was shared');
      err.name = 'NO_AUDIO';
      throw err;
    }
    // We only need the sound, not the picture.
    stream.getVideoTracks().forEach((t) => t.stop());

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(new MediaStream(audioTracks));
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -20;
    source.connect(this.analyser); // deliberately NOT connected to the speakers (no echo)
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
    this.prev = new Uint8Array(this.analyser.frequencyBinCount);
    this.stream = stream;
    this.mode = mode;
    this.flux = [];
    this.active = true;

    audioTracks[0].addEventListener('ended', () => {
      this.cleanup();
      this.onend?.();
    });
  }

  cleanup() {
    this.active = false;
    this.mode = 'off';
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }

  async stop() {
    if (this.active || this.stream) this.cleanup();
  }

  // Call once per frame.
  update(dt) {
    const decay = Math.exp(-dt * 5.5);
    this.pulse *= decay;

    if (this.demo) {
      this.phase += dt;
      const period = 60 / 116;
      if (this.phase >= period) {
        this.phase -= period;
        this.pulse = 1;
      }
      this.level += (0.28 + 0.3 * this.pulse - this.level) * Math.min(1, dt * 8);
      this.bass = this.pulse;
      return;
    }

    if (!this.active) {
      this.level += (0 - this.level) * Math.min(1, dt * 3);
      this.bass *= decay;
      return;
    }

    const d = this.data;
    this.analyser.getByteFrequencyData(d);

    let bass = 0;
    for (let i = 1; i <= 6; i++) bass += d[i];
    bass /= 6 * 255;
    let mid = 0;
    for (let i = 7; i <= 40; i++) mid += d[i];
    mid /= 34 * 255;
    let hi = 0;
    for (let i = 41; i <= 180; i++) hi += d[i];
    hi /= 140 * 255;

    // Spectral flux in the low end: how much the bass jumped since the last frame.
    let flux = 0;
    for (let i = 1; i <= 12; i++) {
      const diff = d[i] - this.prev[i];
      if (diff > 0) flux += diff;
      this.prev[i] = d[i];
    }
    this.flux.push(flux);
    if (this.flux.length > 50) this.flux.shift();
    const avg = this.flux.reduce((s, v) => s + v, 0) / this.flux.length;

    const now = performance.now();
    if (flux > avg * 1.55 + 18 && bass > 0.18 && now - this.lastBeat > 230) {
      this.lastBeat = now;
      this.pulse = Math.min(1, 0.65 + flux / 260);
    }

    const target = Math.min(1, bass * 0.55 + mid * 0.3 + hi * 0.15);
    this.level += (target - this.level) * Math.min(1, dt * 10);
    this.bass += (bass - this.bass) * Math.min(1, dt * 14);
  }
}
