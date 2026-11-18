# Lumen

Glowing, word-by-word synced lyrics for whatever you're playing on Spotify. Built for Windows (Chrome or Edge).

- Live now-playing from Spotify, with album art
- Synced lyrics from [LRCLIB](https://lrclib.net) (free, no key). Words light up as they're sung
- Glow and gradient colours come from the album cover and drift slowly
- Animated gradient that swells on the beat
- Full screen, song search, playlists, volume, play/pause/skip/seek

## Deploy with GitHub and Vercel (free, no installs)

1. Create a new repository on GitHub. On its page choose **Add file > Upload files**, drag in everything from this folder (the contents, not the zip itself) and click **Commit changes**.
2. Go to https://vercel.com, sign in with GitHub, click **Add New > Project**, import the repository and click **Deploy**. Leave every setting as it is; `vercel.json` already points Vercel at the `public` folder.
3. When it finishes you get an address like `https://lumen-yourname.vercel.app`. Use it, **with a slash at the end**, as the Redirect URI in your Spotify app (below).
4. Open your site, paste the Client ID, click **Connect Spotify**, and play something in Spotify.

If you later add your own domain, add that address (also ending in `/`) as a second Redirect URI in Spotify.

Any other static host works too (Netlify, GitHub Pages, Cloudflare Pages): publish the `public` folder.

## Run it locally instead (optional)

Needs Node.js 18+. Double-click `start.bat` or run `node server.js`, then open `http://127.0.0.1:8888/`. Your Redirect URI is `http://127.0.0.1:8888/`. If Smart App Control blocks `start.bat`, run `node server.js` from a terminal, or use the hosted way above.

Preview the look without Spotify: add `?demo` to the address.

## Spotify setup (once)

1. Go to https://developer.spotify.com/dashboard and create an app
2. Add your site's address as the **Redirect URI** (see above), ending in `/`
3. Tick **Web API**, save, copy the **Client ID**, paste it into Lumen
4. Click **Connect Spotify** and approve

Notes:
- Spotify requires the account that owns a developer app to have **Premium**. Playback controls (play, skip, seek, search-and-play) also need Premium.
- New apps allow up to 5 users.
- Open Spotify on the same device and press play once so it counts as an active device.
- For local use, write `127.0.0.1`, not `localhost`. Spotify rejects `localhost` redirect URIs.

## Playlists and volume

- **Playlists (P):** your Spotify playlists. Open one to see its songs and click a song to play it inside that playlist, or press Play playlist. The first time, Lumen asks you to reconnect Spotify so it can read your playlists. In Spotify's development mode, an app can only list the songs of playlists you own or collaborate on. Other playlists (like Daily Mix) show "tap to play" and play directly.
- **Volume:** the slider at the bottom right, or the Up and Down arrow keys. M mutes. Some devices (like phones) don't allow volume control from other apps.

## Customise

Click the palette icon (or press C) to open the Customise panel. Everything is saved in your browser.

- **Background:** Flowing, Aurora, Spotlight, Album blur or Solid
- **Colours:** take them from the album, or pick your own four colours or a preset
- **Motion:** beat strength, motion speed and glow
- **Lyrics text:** size, five fonts, and left, centre or automatic alignment

## Beat reaction

Spotify no longer gives new apps beat or tempo data, so Lumen listens to the audio itself. Click the equaliser icon (or press B):

- **System audio**: choose "Entire screen" and tick "Also share system audio". Best accuracy.
- **Microphone**: picks up speakers in the room.

Audio is analysed live in the browser. It is never recorded, stored or sent anywhere.

## Keys

| Key | Action |
| --- | --- |
| Space | Play / pause |
| F | Full screen |
| S or / | Search |
| P | Playlists |
| C | Customise panel |
| M | Mute / unmute |
| Up / Down | Volume |
| B | Beat reaction menu |
| L | Switch layout (split or centred) |
| [ and ] | Nudge lyric timing 0.25s earlier / later |
| Left / Right | Previous / next song |

## Structure

```
vercel.json          tells Vercel to publish ./public
server.js            optional local server (not needed when hosted online)
start.bat            Windows launcher
public/
  index.html
  css/style.css
  js/app.js          wires everything together
  js/spotify.js      PKCE login + Web API calls
  js/lyrics.js       LRC parsing, per-word timing
  js/lrclib.js       lyrics lookup straight from LRCLIB
  js/palette.js      colour extraction from album art
  js/background.js   animated gradient + glow colours
  js/audio.js        beat detection
  js/demo.js         preview mode
```

To use another port: `set PORT=9000 && npm start`, and change the Redirect URI in your Spotify app to match.
