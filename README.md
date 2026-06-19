# Ring Rivals

A browser arena game — control the glowing zone, knock out rivals, climb the ladder.
Plain HTML/CSS/JS on the client (no libraries). Single-player works by just opening
`index.html`. Online multiplayer uses a small Node + `ws` authoritative server.

- **Play (single-player):** https://lp-creative.github.io/ring-rivals/
- **Controls:** WASD move · mouse aim · left-click shoot · Space dash. (Mobile: left
  half = move joystick, right half = aim + auto-fire, bottom DASH button.)

## Online multiplayer

The server runs the whole simulation; clients send inputs and render the result, so
matches are fair and survive any player leaving. The host creates a room, friends join
with a 4-letter code, and the host can toggle **"Fill empty slots with AI bots"** on/off
(turn it OFF for a players-only match), then Start.

### Deploy the server to Railway

You'll run the login/deploy steps yourself (I can't authenticate as you).

```bash
cd C:\Users\lucas\Desktop\RingRivals

# one-time: install the Railway CLI if you don't have it
npm i -g @railway/cli

railway login                 # opens a browser to authenticate
railway init                  # create a new project (pick a name)
railway up                    # deploy this folder
railway domain                # generate a public URL, e.g. ring-rivals-production.up.railway.app
```

Railway auto-detects Node, runs `npm install`, then `npm start` (`node server.js`).
The server listens on `process.env.PORT` and serves both the WebSocket game **and**
`index.html`, so the Railway URL works as the full game on its own too.

### Point the client at your server

After `railway domain` gives you a hostname, the WebSocket URL is:

```
wss://<your-domain>.up.railway.app
```

Two ways to use it:

1. **Quick / per-device:** open the game → **Play Online** → paste that `wss://…` URL
   into the Server field (it's saved in your browser). Share the URL with friends so
   they paste the same one.
2. **Zero-setup for friends (recommended):** set `DEFAULT_SERVER` near the top of the
   `12. MULTIPLAYER CLIENT` section in `index.html` to your `wss://…` URL, commit, and
   push. GitHub Pages rebuilds and everyone who opens the Pages link is auto-connected —
   no field to fill in.

   ```js
   const DEFAULT_SERVER = "wss://your-domain.up.railway.app";
   ```

### Run the server locally (optional)

```bash
npm install
npm start          # http://localhost:8080  (open it, Play Online, Server field auto-fills)
```

## Where things live (all in `index.html`)

- **Game state / entities** — sections 6–7
- **Player progression / save** — sections 1–2 (localStorage, key `ringRivalsSave_v1`)
- **Shop / upgrades / cosmetics** — sections 2–3
- **AI** — section 8 (single-player). Server AI is in `server.js` (`runAI`).
- **Rendering (2.5D fake-3D)** — section 10
- **Multiplayer client (lobby + netcode)** — section 12

`server.js` mirrors the single-player simulation headlessly and is the authority for
online matches.
