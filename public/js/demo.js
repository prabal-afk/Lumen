// Preview mode (open /?demo): lets you see the look without Spotify.
// The lyrics below are original, written for this demo.

export const DEMO_TRACK = {
  id: 'demo',
  type: 'track',
  name: 'Neon Hours',
  artists: ['Lumen Demo'],
  album: 'Preview',
  durationMs: 62000,
  art: null,
  artSmall: null,
};

export const DEMO_LRC = `
[00:04.00] City lights are melting into rain
[00:08.20] Every window hums a different name
[00:12.40] I carry all the echoes in my coat
[00:16.60] Walking slow where the neon floats
[00:20.80] Hold the night a little longer
[00:25.00] Let the colors get a little stronger
[00:29.20] We are small and bright and burning
[00:33.40] Every heartbeat keeps on turning
[00:37.60] Turn it up, let the glow rise higher
[00:41.80] We were made out of light and wire
[00:46.00] Say it soft or say it loud
[00:50.20] We are fireflies in a crowd
[00:54.40]
`;

// A little gradient "album cover", drawn on the fly.
export function makeDemoArt() {
  const c = document.createElement('canvas');
  c.width = c.height = 640;
  const x = c.getContext('2d');
  const base = x.createLinearGradient(0, 0, 640, 640);
  base.addColorStop(0, '#1b1040');
  base.addColorStop(1, '#0b0f2e');
  x.fillStyle = base;
  x.fillRect(0, 0, 640, 640);
  const blob = (cx, cy, r, col) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 640, 640);
  };
  blob(200, 430, 360, 'rgba(255,72,140,.95)');
  blob(480, 200, 320, 'rgba(70,120,255,.95)');
  blob(360, 540, 240, 'rgba(255,170,60,.85)');
  return c.toDataURL('image/jpeg', 0.9);
}
