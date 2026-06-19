# Ring Rivals — Project Overview

**Prepared for project handoff.** This document describes the complete current state of the
game: what it is, how it's built, every feature implemented, the in-game economy, how it's
deployed, and known limitations / suggested next steps.

---

## 1. Executive summary

**Ring Rivals** is a browser-based, top-down competitive arena game. Players control a
character in a circular arena, fight AI bots and/or other people in real time, and compete
to control a glowing "capture zone" for points while knocking out rivals. It ships with a
full progression system (coins, XP, levels, ranks, achievements), a cosmetics shop, and
**real-time online multiplayer** with a lobby system.

- **Genre:** arcade / .io-style top-down shooter with light MOBA-style progression.
- **Platform:** any modern web browser (desktop-first, works on mobile with touch controls).
- **Status:** playable end-to-end and deployed live. Single-player and online multiplayer
  both functional.
- **Live (single-player + client):** https://lp-creative.github.io/ring-rivals/
- **Live multiplayer server:** wss://web-production-15767.up.railway.app
- **Source repo:** https://github.com/LP-CREATIVE/ring-rivals (owner: LP-CREATIVE)

---

## 2. Technology & architecture

| Layer | Technology | Notes |
|---|---|---|
| Client | Plain HTML / CSS / JavaScript, HTML5 **Canvas 2D** | **Zero external libraries.** Entire client is one file: `index.html`. |
| Rendering | Canvas 2D with a "2.5D" tilted-camera projection | Fake-3D look (see §5) — no WebGL, no 3D engine. |
| Local storage | Browser `localStorage` | All player progression saved per device under key `ringRivalsSave_v1`. |
| Multiplayer server | **Node.js** + the `ws` WebSocket library | One file: `server.js`. The only third-party dependency in the project. |
| Hosting (client) | **GitHub Pages** (static) | Auto-deploys on push to `main`. |
| Hosting (server) | **Railway** (always-on Node service) | Auto-deploys on push; also serves the client at its own URL. |

**Networking model: authoritative server.** The server runs the entire game simulation
(movement, physics, AI, scoring) at **30 ticks/second**. Clients only send their inputs
(move vector, aim angle, shoot, dash) and render the state the server broadcasts back. This
makes matches fair (no host advantage), resilient (the match survives any player leaving),
and resistant to simple cheating. The single-player mode runs the same simulation locally
in the browser.

**File structure:**
```
ring-rivals/
├── index.html          # entire game client (HTML + CSS + JS, no libraries)
├── server.js           # authoritative multiplayer server (Node + ws)
├── package.json        # declares the `ws` dependency + start script
├── Procfile            # tells Railway to run `node server.js`
├── README.md           # run / deploy instructions
└── PROJECT_OVERVIEW.md # this document
```

---

## 3. Controls

| Action | Desktop | Mobile / touch |
|---|---|---|
| Move | `W A S D` | Left-side drag = virtual joystick |
| Aim | Mouse | Right-side drag |
| Shoot (knockback projectile) | Left click (hold to auto-fire) | Right-side drag auto-fires |
| Dash | `Spacebar` | On-screen **DASH** button |

---

## 4. Core gameplay

- **Objective:** earn points by standing inside the glowing **capture zone**. First to the
  score target wins; if time runs out, the highest score wins; if everyone else is
  eliminated, the last fighter standing wins.
- **Capture zone** relocates every **10–15 seconds** to a clear spot in the arena.
- **Combat:** projectiles deal damage **and** knockback. Reducing an enemy to 0 HP, or
  shoving them off the arena edge ("ring-out"), is a **knockout (KO)**.
- **Lives:** each fighter has **3 lives** per match. On death they respawn after ~1.5s.
  When out of lives they are **eliminated** and enter **spectator mode** (they keep watching
  the live match and can leave to the menu at any time; the match continues for everyone else).
- **Pre-game countdown:** when a match starts, all players see the arena and their starting
  positions, then a **3 → 2 → 1 → GO!** countdown (simulation frozen) before play begins.

### Zone modes (randomly chosen each match)
| Mode | Behavior |
|---|---|
| **Classic Zone** | Standard — stand in the zone to score at the base rate. |
| **King of the Hill** | The longer you hold the zone continuously, the higher your score multiplier (up to ~2×). Leaving resets your streak. |
| **Shrinking Zone** | The zone shrinks over its lifetime before relocating, making it harder to hold. |

### Arena & hazards
- Circular arena with a glowing neon edge.
- **Cover pillars** (4–6 per match, randomized) block player movement, **block projectiles**,
  and **block line-of-sight** so bots can't shoot through them. This rewards positioning and
  use of cover.
- **Ring-out:** being knocked past the arena edge deals heavy damage.

### Power-ups (spawn periodically, up to 3 on the map, blink before expiring)
| Power-up | Effect |
|---|---|
| ❤ Health | Restores 40 HP |
| » Speed | +60% move speed for 6 seconds |
| ⚡ Rapid Fire | Roughly doubles fire rate for 6 seconds |

### AI bots
Bots (`Bolt, Hex, Nova, Tank, Viper`) navigate to the zone, chase power-ups, shoot the
nearest enemy **only with clear line of sight**, dash periodically, flee when low on health,
and steer around obstacles. **Difficulty scales** with the player's level and rank in
single-player (faster, more accurate, more aggressive as you climb); in multiplayer bots use
a fixed moderate difficulty for fairness.

### Default balance values
| Parameter | Value |
|---|---|
| Match length | 120 seconds |
| Score to win | 150 |
| Zone score rate | 8 points/second (before multipliers) |
| Player base health | 100 |
| Projectile damage | 12 |
| Dash cooldown (base) | 2.5 seconds |
| Lives per match | 3 |
| Max fighters per match | 6 (humans + bots combined) |

---

## 5. Visual presentation ("2.5D")

The game is rendered on a 2D canvas but uses a **tilted-camera projection** (vertical axis
foreshortened) plus height, drop-shadows, and back-to-front depth-sorting to read as 3D —
without any 3D engine or libraries.

- **Characters** are little figures with: two **legs** (with a walk-step animation), a
  shaded **body/torso** in the player's color, a **head with a face** (eyes that look toward
  the aim direction), and an **arm holding a gun** that rotates to point exactly where the
  player aims (and tucks behind the body when aiming away from the camera).
- **Cover pillars** render as 3D cylinders with lit tops and shaded sides.
- **Polish:** screen shake on hits, particle effects (hits, dashes, KOs, zone scoring),
  floating combat text (damage, KO, coin rewards), a large animated **"+N" score popup**
  above your character while you accumulate zone points, a directional arrow pointing to the
  zone, and a live **minimap**.
- **Audio:** lightweight WebAudio sound effects (shoot, dash, hit, KO, pickup, zone move,
  countdown, win/lose) generated in-code — no audio files. Toggleable in Settings.

---

## 6. Progression & economy (saved per device in localStorage)

### Currencies & leveling
- **Coins** — spent in the shop on upgrades and cosmetics.
- **XP / Level** — XP requirement rises each level (`100 + 60 × (level−1)`). Leveling up
  grants bonus coins (`25 + 5 × level`).

### Match rewards
| Reward | Amount |
|---|---|
| Win | 75 coins (× coin multiplier) |
| Loss | 25 coins (× coin multiplier) |
| Per KO | 15 coins (× coin multiplier) |
| XP | 50 base + 10 per KO + 50 for a win |

### Permanent stat upgrades (deliberately modest so the game stays balanced)
| Upgrade | Effect | Max level |
|---|---|---|
| Speed | Movement speed | 6 |
| Max Health | Hit points | 6 |
| Dash Cooldown | Lower dash cooldown | 6 |
| Knockback | Projectile shove force | 6 |
| Coin Multiplier | More coins earned | 5 |
| Zone Multiplier | Faster zone scoring | 5 |

Each level costs more than the last (rising price curve). In multiplayer, a player's
purchased stats are sent to the server so their character reflects their progression.

### Rank system (driven by "rank points" earned each match)
**Bronze → Silver → Gold → Platinum → Diamond.** Wins and higher scores earn more rank
points; the current rank is shown on the main menu and the results screen.

### Achievements (auto-awarded, one-time coin rewards)
| Achievement | Reward |
|---|---|
| First Win | 50 coins |
| 10 KOs | 75 coins |
| 1,000 Coins Earned (lifetime) | 100 coins |
| Reach Level 5 | 120 coins |

### Other progression features
- **Daily reward** — claimable once per calendar day (`50 + 5 × level` coins).
- **Match history** — last 10 matches shown on the menu (result, mode, score, KOs, coins).
- **Best score** tracked and displayed.

---

## 7. Cosmetics (purely visual, no gameplay effect)

Players buy cosmetics with coins, then equip them. Owned/equipped state is saved.
**Character color, hats, and back items are synced in multiplayer** so everyone sees each
other's appearance. Trails and projectile skins are rendered client-side.

| Category | Options (price in coins) |
|---|---|
| **Character color** | Default (0), Neon Blue (150), Crimson (300), Gold (400), Void Purple (500) |
| **Hats** | None (0), Headband (160), Ball Cap (120), Beanie (180), Horns (280), Top Hat (420), Halo (550), Crown (700) |
| **Back** | Nothing (0), Cape (220), Backpack (240), Jetpack (480, animated flames), Bat Wings (520), Angel Wings (650) |
| **Trails** | No Trail (0), Cyber (200), Fire (350), Ice (350) — long motion trail behind you |
| **Projectile skins** | Default (0), Ice Shot (250), Lightning Shot (450) |
| **Arena themes** | Neon (0), Dark (300), Retro Grid (300) |

Players can combine slots freely (e.g., Crown + Cape + Fire trail). There is also a quick
**color picker in the multiplayer lobby** for changing your color before a match.

---

## 8. Screens / UI

- **Main Menu** — title, tagline, rank badge, Play, Play Online, Shop, Upgrades, Cosmetics,
  Achievements, Settings, Daily Reward button, stat summary (coins/level/wins/losses/KOs),
  XP bar, and match-history panel.
- **Play Online** — set your name, see a live **list of open games by host name** ("Luke's
  Game (2/6)"), tap to join, or create your own.
- **Lobby / Room** — game title, player list (host crowned), **color picker**, **host AI-bot
  toggle** (fill empty slots with bots: on/off), Start button, your coin balance, and
  Upgrades/Cosmetics buttons to spend between rounds.
- **Shop / Upgrades / Cosmetics / Achievements / Settings** — full management screens.
  Settings includes sound, screen-shake, particles, bot count (single-player), and reset
  progress.
- **In-game HUD** — match timer, objective text, score leaderboard with **lives shown as
  hearts** (and "OUT" when eliminated), health bar, dash-cooldown bar, coins earned this
  match, minimap, countdown overlay, spectator banner, and a Leave button.
- **Post-match results** — **winner announcement**, **full standings** (every player & bot
  with medals, color, score, KOs, OUT tags, your row highlighted), your coins/XP earned,
  level-up notice, rank, and Rematch / Lobby / Main Menu buttons.

---

## 9. Multiplayer details

- **Lobby flow:** a host creates a game (named automatically after them, e.g., "Luke's
  Game"); others see it in a browsable list and join — **no room codes to type or share.**
- **Host controls:** toggle whether empty slots are filled with AI bots, then start.
  Removing bots gives a pure player-vs-player match.
- **Capacity:** up to 6 fighters total (humans + bots).
- **Resilience:** if the host or any player leaves, the match continues and a new host is
  promoted automatically. The server is wrapped in error handling so a single bad frame can
  never crash the match for everyone.
- **Pre-game countdown, lives, spectator mode, and the post-match results screen all work in
  multiplayer**, identically to single-player.

---

## 10. Known limitations & honest caveats

These are intentional scope boundaries for the current prototype, not bugs:

1. **Progress is per-device.** Coins/levels/cosmetics are stored in each player's browser
   `localStorage`. There is **no account system**, so a player on a different device/browser
   starts fresh. A cross-device account would require server-side player profiles + auth.
2. **Public lobby list.** The browse list shows *all* open games on the server. There is no
   private/friends-only filter or invite system yet.
3. **Server timing.** The simulation uses a fixed time-step; under heavy server load the
   whole match could slow slightly. Fine at the current (small-group) scale on Railway.
4. **Hosting cost/uptime.** The multiplayer server runs 24/7 on Railway and consumes that
   plan's usage. It can be paused in the Railway dashboard when not in use.
5. **No gun-skin cosmetic yet** (the gun is fixed dark metal); no face-accessory slot yet.
6. **No anti-cheat beyond the authoritative server**, no matchmaking/ranking ladder
   persistence beyond the local rank, and no server-side leaderboards.

---

## 11. Suggested roadmap (not yet built)

- **Accounts & cloud save** — server-side profiles so progression follows the player across
  devices; foundation for global leaderboards.
- **Private rooms / invites** — friends-only games, optional join codes.
- **More cosmetics** — gun skins, face accessories (sunglasses/visor/mask), emotes.
- **Game modes** — teams (2v2/3v3), elimination-only mode, capture variants.
- **Matchmaking & ranked ladder** with persistent seasons.
- **Mobile UX polish** and a possible installable PWA.
- **Spectator/replay** improvements and a post-match MVP highlight.

---

## 12. How to run / deploy (quick reference)

- **Play single-player:** open `index.html` (or the GitHub Pages URL) — no server needed.
- **Run the server locally:** `npm install` then `npm start` (serves the game + multiplayer
  on `http://localhost:8080`).
- **Deploy:** push to the `main` branch — GitHub Pages (client) and Railway (server)
  both auto-redeploy within ~1–2 minutes.

*Full setup details are in `README.md`.*
