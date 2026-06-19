/* ============================================================================
   RING RIVALS — authoritative multiplayer server
   - Node + ws. Serves index.html (same-origin play) AND a WebSocket game server.
   - The SERVER runs the whole simulation; clients only send inputs & render state.
   - Rooms: a host creates a room (4-letter code), friends join with the code.
     The host can toggle "fill empty slots with AI bots" and start the match.
   ============================================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const INDEX = path.join(__dirname, "index.html");

/* ---- HTTP: serve the client so the Railway URL works as the full game too ---- */
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (req.url === "/three.min.js") {
    fs.readFile(path.join(__dirname, "three.min.js"), (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=86400" });
      res.end(data);
    });
    return;
  }
  // everything else serves the game client
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

/* ===========================================================================
   GAME CONSTANTS  (kept in sync with the client's feel)
   World is centered at (0,0); arena radius ARENA_R. Clients re-center on canvas.
   =========================================================================== */
const ARENA_R = 440, TICK = 1 / 30;
const MATCH_TIME = 120, SCORE_TO_WIN = 150, ZONE_PER_SEC = 8, PROJ_DMG = 12;
const TOTAL_SLOTS = 6;            // humans + bots fill up to this many
const LIVES = 3;                  // lives per entity per match
const BOT_DIFF = 1.1;
const BOT_NAMES = ["Bolt", "Hex", "Nova", "Tank", "Viper"];
const BOT_COLORS = ["#ff5252", "#27e08a", "#ffa726", "#b388ff", "#26c6da"];
const BOT_HATS = ["cap", "band", "horns", "beanie", "none"];   // bots get varied headgear
const BOT_BACKS = ["cape", "pack", "none", "wings", "none"];
const ZONE_MODE_KEYS = ["classic", "koth", "shrink"];
const POWERUP_TYPES = ["health", "speed", "rapid"];

/* ===========================================================================
   SKILL COMBAT — weapon balance table.
   *** KEEP THIS TABLE IDENTICAL TO THE COPY IN index.html ***  (client mirrors
   the sim for single-player; both must agree or multiplayer desyncs.)
   Tuning lives here: damage, magazine, reload, fire cadence, bloom, knockback.
   mode: semi | burst | shotgun | charge | disc
   =========================================================================== */
const WEAPONS = {
  blaster: { name: "Blaster",   mode: "semi",    mag: 6, reload: 1.1, fireCd: 0.20, projSpeed: 10, dmg: 14, projR: 7, life: 1.1, knock: 1.0, bloomAdd: 0.05, bloomMax: 0.20, bloomDecay: 0.6, color: "#ffffff", ability: "power" },
  burst:   { name: "Burst Rifle", mode: "burst", mag: 4, reload: 1.3, fireCd: 0.46, projSpeed: 13, dmg: 8,  projR: 5, life: 1.0, knock: 0.6, bloomAdd: 0.04, bloomMax: 0.16, bloomDecay: 0.5, color: "#9fe8ff", ability: "focus", burst: 3, burstGap: 0.05 },
  shotgun: { name: "Shotgun",   mode: "shotgun", mag: 2, reload: 1.5, fireCd: 0.55, projSpeed: 11, dmg: 5,  projR: 5, life: 0.40, knock: 2.4, bloomAdd: 0, bloomMax: 0, bloomDecay: 1, color: "#ffd33d", ability: "grapple", pellets: 7, spread: 0.5 },
  rail:    { name: "Railshot",  mode: "charge",  mag: 2, reload: 1.4, fireCd: 0.25, projSpeed: 24, dmg: 32, projR: 6, life: 0.8, knock: 1.6, bloomAdd: 0, bloomMax: 0, bloomDecay: 1, color: "#ff3d81", ability: "blink", chargeTime: 0.85, slowMul: 0.45, pierce: true },
  disc:    { name: "Boomerang", mode: "disc",    mag: 1, reload: 0,   fireCd: 0.22, projSpeed: 9,  dmg: 13, projR: 11, life: 2.2, knock: 1.0, bloomAdd: 0, bloomMax: 0, bloomDecay: 1, color: "#27e08a", ability: "recall", returnT: 0.6 },
};
const WEAPON_KEYS = Object.keys(WEAPONS);
const BOT_WEAPONS = ["shotgun", "rail", "blaster", "burst", "disc"];
function curWeapon(e) { return WEAPONS[e.weapon] || WEAPONS.blaster; }

// Dash rework: brief i-frames + end lag so dashes are a timing skill.
const DASH_ACTIVE = 0.18, DASH_IFRAME = 0.15, DASH_ENDLAG = 0.12, DASH_SPEED = 15, DASH_REFUND = 0.6;

/* ===========================================================================
   ROOMS
   =========================================================================== */
const rooms = new Map();   // code -> room
let idCounter = 1;

function makeCode() {
  let c;
  do { c = ""; for (let i = 0; i < 4; i++) c += String.fromCharCode(65 + Math.floor(Math.random() * 26)); }
  while (rooms.has(c));
  return c;
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { for (const p of room.players.values()) send(p.ws, obj); }

function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, weapon: p.weapon || "blaster", host: p.id === room.hostId }));
}
function sendLobby(room) {
  broadcast(room, { t: "lobby", code: room.code, players: playerList(room), fillBots: room.fillBots });
}
// Summaries for the "browse open games" list (find a game by host name).
function roomSummaries() {
  return [...rooms.values()].map(r => {
    const host = r.players.get(r.hostId);
    return { code: r.code, title: (host ? host.name : "Game") + "'s Game", count: r.players.size, max: TOTAL_SLOTS, inGame: !!r.game };
  });
}

/* ===========================================================================
   SIMULATION
   =========================================================================== */
function makeEntity(opts) {
  return {
    id: opts.id, name: opts.name, color: opts.color, isBot: !!opts.isBot,
    stats: opts.stats || null,
    hat: opts.hat || "none", back: opts.back || "none",
    x: opts.x, y: opts.y, vx: 0, vy: 0, r: 18, angle: 0,
    maxHp: opts.maxHp || 100, hp: opts.maxHp || 100,
    score: 0, kos: 0, dead: false, respawn: 0, lives: LIVES, eliminated: false,
    dashTimer: 0, dashV: 0, dashDx: 0, dashDy: 0, dashCd: opts.dashCd || 2.5,
    dashActive: 0, dashIFrame: 0, dashEndLag: 0,           // dash rework
    weapon: opts.weapon || "blaster",
    ammo: 0, reloadT: 0, fireCd: 0, bloom: 0,              // ammo / reload / spread
    burstLeft: 0, burstT: 0,                               // burst sequencing
    charging: false, chargeT: 0,                           // railshot charge
    discOut: false, prevShoot: false,
    buffs: { speed: 0, rapid: 0 }, holdStreak: 0,
    aiState: { dashCd: Math.random() * 2, fireBias: Math.random() },
    input: { mvx: 0, mvy: 0, angle: 0, shoot: false, dash: false, reload: false },
  };
}
// (re)initialise a fighter's weapon state — called on spawn and respawn.
function resetWeapon(e) {
  const w = curWeapon(e);
  e.ammo = w.mag; e.reloadT = 0; e.fireCd = 0; e.bloom = 0;
  e.burstLeft = 0; e.burstT = 0; e.charging = false; e.chargeT = 0; e.discOut = false; e.prevShoot = false;
}
function entSpeed(e) { const base = e.isBot ? 2.6 * BOT_DIFF : (e.stats ? e.stats.speed : 3); return base * (e.buffs.speed > 0 ? 1.6 : 1); }
function entKnock(e) { return e.isBot ? 1.0 : (e.stats ? e.stats.knock : 1.0); }
function entShootInt(e) { let b = e.isBot ? 0.72 / BOT_DIFF : 0.28; if (e.buffs.rapid > 0) b *= 0.45; return b; }
function entZoneMult(e) { return e.isBot ? 1 : (e.stats ? e.stats.zoneMult : 1); }

function genObstacles() {
  const obs = [], count = 4 + Math.floor(Math.random() * 2), ring = ARENA_R * 0.52, off = Math.random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const a = off + (i / count) * Math.PI * 2, d = ring + (Math.random() * 0.24 - 0.12) * ARENA_R;
    obs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: 30 + Math.random() * 20 });
  }
  if (Math.random() < 0.55) obs.push({ x: 0, y: 0, r: 38 });
  return obs;
}
function segDist(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function losClear(g, ax, ay, bx, by) { for (const o of g.obstacles) if (segDist(ax, ay, bx, by, o.x, o.y) < o.r) return false; return true; }
function pointBlocked(g, x, y, pad) { for (const o of g.obstacles) if (Math.hypot(x - o.x, y - o.y) < o.r + pad) return true; return false; }

function startGame(room) {
  const mode = ZONE_MODE_KEYS[Math.floor(Math.random() * ZONE_MODE_KEYS.length)];
  const g = {
    mode, obstacles: genObstacles(), entities: [], projectiles: [], powerups: [],
    zone: { x: 0, y: 0, r: 90, baseR: 90, timer: 12, maxTimer: 12 },
    time: MATCH_TIME, puTimer: 6, over: false, countdown: 3,   // 3s pre-game: positions shown, sim frozen
    projId: 1, events: [],
  };
  // humans
  let i = 0;
  for (const p of room.players.values()) {
    const a = (i / TOTAL_SLOTS) * Math.PI * 2;
    g.entities.push(makeEntity({
      id: p.id, name: p.name, color: p.color, stats: p.stats, hat: p.hat, back: p.back,
      weapon: WEAPON_KEYS.includes(p.weapon) ? p.weapon : "blaster",
      maxHp: p.stats ? p.stats.maxHp : 100, dashCd: p.stats ? p.stats.dashCd : 2.5,
      x: Math.cos(a) * 200, y: Math.sin(a) * 200,
    }));
    p.ent = g.entities[g.entities.length - 1];
    i++;
  }
  // bots fill remaining slots if enabled
  if (room.fillBots) {
    for (let b = 0; i < TOTAL_SLOTS; i++, b++) {
      const a = (i / TOTAL_SLOTS) * Math.PI * 2;
      g.entities.push(makeEntity({
        id: "bot" + b, name: BOT_NAMES[b % 5], color: BOT_COLORS[b % 5], isBot: true,
        hat: BOT_HATS[b % BOT_HATS.length], back: BOT_BACKS[b % BOT_BACKS.length],
        weapon: BOT_WEAPONS[b % BOT_WEAPONS.length],
        x: Math.cos(a) * 200, y: Math.sin(a) * 200,
      }));
    }
  }
  g.entities.forEach(resetWeapon);
  g.startCount = g.entities.length;
  room.game = g;
  moveZone(g);
  broadcast(room, { t: "start", mode, obstacles: g.obstacles });
  if (room.loop) clearInterval(room.loop);
  room.loop = setInterval(() => tick(room), 1000 * TICK);
}

function moveZone(g) {
  for (let tries = 0; tries < 12; tries++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * (ARENA_R - 150);
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
    g.zone.x = x; g.zone.y = y;
    if (!pointBlocked(g, x, y, 40)) break;
  }
  g.zone.timer = 10 + Math.random() * 5; g.zone.maxTimer = g.zone.timer; g.zone.baseR = 90; g.zone.r = 90;
}
// ---- weapon firing ----------------------------------------------------------
function spawnProj(g, e, a, opt) {
  const w = curWeapon(e);
  g.projectiles.push(Object.assign({
    id: g.projId++, x: e.x + Math.cos(a) * e.r, y: e.y + Math.sin(a) * e.r,
    dx: Math.cos(a) * w.projSpeed, dy: Math.sin(a) * w.projSpeed,
    r: w.projR, life: w.life, ownerId: e.id, weapon: e.weapon, color: w.color,
    dmg: w.dmg, knock: w.knock * entKnock(e), pierce: !!w.pierce, disc: false,
    hitSet: [], dead: false,
  }, opt || {}));
}
function fireOnce(g, e, angle) {           // a single shot honoring current bloom
  const bl = Math.min(e.bloom, curWeapon(e).bloomMax);
  spawnProj(g, e, angle + (Math.random() - 0.5) * bl);
  e.bloom = Math.min(curWeapon(e).bloomMax, e.bloom + curWeapon(e).bloomAdd);
  e.vx -= Math.cos(angle) * 0.4 * entKnock(e); e.vy -= Math.sin(angle) * 0.4 * entKnock(e);
}
function doFire(g, e, angle) {              // edge-triggered fire for non-charge weapons
  const w = curWeapon(e);
  if (w.mode === "shotgun") {
    for (let i = 0; i < w.pellets; i++) spawnProj(g, e, angle + (Math.random() - 0.5) * w.spread);
    e.ammo--; e.fireCd = w.fireCd;
    e.vx -= Math.cos(angle) * 1.6 * entKnock(e); e.vy -= Math.sin(angle) * 1.6 * entKnock(e);
  } else if (w.mode === "disc") {
    spawnProj(g, e, angle, { disc: true, age: 0, returning: false });
    e.discOut = true; e.fireCd = w.fireCd;
  } else if (w.mode === "burst") {
    e.burstLeft = w.burst; e.burstT = 0; e.ammo--; e.fireCd = w.fireCd;
  } else { // semi
    fireOnce(g, e, angle); e.ammo--; e.fireCd = w.fireCd;
  }
  pushEvent(g, "shot", e.x, e.y, e.weapon);
}
function fireRail(g, e, angle, ratio) {     // charged piercing shot, damage scales with charge
  const w = curWeapon(e);
  spawnProj(g, e, angle, { dmg: Math.round(w.dmg * (0.5 + 0.5 * ratio)), knock: w.knock * entKnock(e) * (0.6 + 0.6 * ratio) });
  e.vx -= Math.cos(angle) * 1.0 * entKnock(e); e.vy -= Math.sin(angle) * 1.0 * entKnock(e);
  pushEvent(g, "rail", e.x, e.y);
}
function canFire(e) {
  const w = curWeapon(e);
  if (e.fireCd > 0 || e.reloadT > 0 || e.dashEndLag > 0 || e.burstLeft > 0) return false;
  return w.mode === "disc" ? !e.discOut : e.ammo > 0;
}
function tryReload(e) {
  const w = curWeapon(e);
  if (w.mode === "disc" || e.reloadT > 0 || e.charging || e.burstLeft > 0 || e.ammo >= w.mag) return;
  e.reloadT = w.reload;
}
// ---- dash rework: i-frames + end lag ----
function dash(e, dx, dy) {
  if (e.dashTimer > 0 || e.dashActive > 0 || e.dashEndLag > 0 || e.charging) return;
  const len = Math.hypot(dx, dy) || 1;
  e.dashTimer = e.dashCd; e.dashActive = DASH_ACTIVE; e.dashIFrame = DASH_IFRAME;
  e.dashV = DASH_SPEED; e.dashDx = dx / len; e.dashDy = dy / len;
}
function pushEvent(g, type, x, y, extra) { if (g.events.length < 60) g.events.push({ type, x, y, extra }); }

// per-entity cooldown / reload / burst / dash timers (runs every tick for living fighters)
function stepTimers(g, e, dt) {
  e.dashTimer = Math.max(0, e.dashTimer - dt);
  e.dashIFrame = Math.max(0, e.dashIFrame - dt);
  e.dashEndLag = Math.max(0, e.dashEndLag - dt);
  if (e.dashActive > 0) { e.dashActive -= dt; if (e.dashActive <= 0) e.dashEndLag = DASH_ENDLAG; }
  e.fireCd = Math.max(0, e.fireCd - dt);
  e.buffs.speed = Math.max(0, e.buffs.speed - dt);
  e.buffs.rapid = Math.max(0, e.buffs.rapid - dt);
  if (e.bloom > 0) e.bloom = Math.max(0, e.bloom - curWeapon(e).bloomDecay * dt);
  if (e.reloadT > 0) { e.reloadT -= dt; if (e.reloadT <= 0) { e.reloadT = 0; e.ammo = curWeapon(e).mag; pushEvent(g, "reloaddone", e.x, e.y, e.id); } }
  if (e.burstLeft > 0) {
    e.burstT -= dt;
    if (e.burstT <= 0) { fireOnce(g, e, e.angle); e.burstLeft--; e.burstT = curWeapon(e).burstGap; if (e.burstLeft <= 0 && e.ammo <= 0) tryReload(e); }
  }
}
// a human player's per-tick movement + firing, driven by their input
function playerStep(g, e, dt) {
  const inp = e.input, w = curWeapon(e);
  e.angle = inp.angle;
  if (e.dashEndLag <= 0) {                          // end lag locks movement briefly after a dash
    const sp = entSpeed(e) * (e.charging ? (w.slowMul || 0.5) : 1);
    e.vx += inp.mvx * sp * 0.25; e.vy += inp.mvy * sp * 0.25;
    const cur = Math.hypot(e.vx, e.vy); if (cur > sp) { e.vx = e.vx / cur * sp; e.vy = e.vy / cur * sp; }
  }
  if (inp.dash) { dash(e, inp.mvx || Math.cos(inp.angle), inp.mvy || Math.sin(inp.angle)); inp.dash = false; }
  if (inp.reload) { tryReload(e); inp.reload = false; }
  if (w.mode === "charge") {                        // hold to charge, release to fire
    if (inp.shoot && e.ammo > 0 && e.reloadT <= 0 && e.dashEndLag <= 0) { e.charging = true; e.chargeT = Math.min(w.chargeTime, e.chargeT + dt); }
    else if (e.charging) {
      if (e.chargeT >= w.chargeTime * 0.4) { fireRail(g, e, inp.angle, Math.min(1, e.chargeT / w.chargeTime)); e.ammo--; e.fireCd = w.fireCd; if (e.ammo <= 0) tryReload(e); }
      e.charging = false; e.chargeT = 0;
    }
  } else {                                          // edge-triggered: holding fire does NOT auto-spam
    const rising = inp.shoot && !e.prevShoot;
    if (rising && canFire(e)) { doFire(g, e, inp.angle); if (e.ammo <= 0 && w.mode !== "disc" && e.burstLeft <= 0) tryReload(e); }
  }
  e.prevShoot = inp.shoot;
}
function damage(g, target, amount, srcId) {
  if (target.dead) return;
  target.hp -= amount;
  if (target.hp <= 0) {
    target.dead = true; target.lives--;
    if (target.lives <= 0) { target.eliminated = true; target.respawn = Infinity; }
    else target.respawn = 1.5;
    const src = g.entities.find(e => e.id === srcId && e !== target);
    if (src) src.kos++;
  }
}
function runAI(g, e, dt) {
  const w = curWeapon(e);
  let nearest = null, nd = 1e9;
  for (const o of g.entities) { if (o === e || o.dead) continue; const d = Math.hypot(o.x - e.x, o.y - e.y); if (d < nd) { nd = d; nearest = o; } }
  // objective target: power-up if close, else the zone
  let gx = g.zone.x, gy = g.zone.y, bestPU = null, pd = 200;
  for (const p of g.powerups) { const d = Math.hypot(p.x - e.x, p.y - e.y); if (d < pd) { pd = d; bestPU = p; } }
  if (bestPU) { gx = bestPU.x; gy = bestPU.y; }
  else { const zd = Math.hypot(e.x - g.zone.x, e.y - g.zone.y); if (zd < g.zone.r - 20) { gx = g.zone.x + Math.sin(g.time * 2 + e.x) * 30; gy = g.zone.y + Math.cos(g.time * 2 + e.y) * 30; } }
  // preferred range per weapon (shotgun closes, rail keeps distance)
  const wantRange = w.mode === "shotgun" ? 150 : (w.mode === "rail" ? 330 : 270);
  const ga = Math.atan2(gy - e.y, gx - e.x); let ax = Math.cos(ga), ay = Math.sin(ga);
  if (nearest && nd < wantRange * 0.6) { ax -= (nearest.x - e.x) / nd; ay -= (nearest.y - e.y) / nd; }   // back off if too close
  if (e.hp < 30 && nearest) { ax -= (nearest.x - e.x) / nd * 1.5; ay -= (nearest.y - e.y) / nd * 1.5; }   // flee when low
  for (const o of g.obstacles) { const dx = e.x - o.x, dy = e.y - o.y, d = Math.hypot(dx, dy), reach = o.r + 72; if (d < reach && d > 0) { const f = (reach - d) / reach * 1.6; ax += dx / d * f; ay += dy / d * f; } }
  const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
  if (e.dashEndLag <= 0) {
    const sp = entSpeed(e) * (e.charging ? (w.slowMul || 0.5) : 1);
    e.vx += ax * sp * 0.18; e.vy += ay * sp * 0.18;
    const cur = Math.hypot(e.vx, e.vy); if (cur > sp) { e.vx = e.vx / cur * sp; e.vy = e.vy / cur * sp; }
  }
  if (w.mode !== "disc" && e.ammo <= 0 && e.burstLeft <= 0) tryReload(e);   // reload when empty
  const inRange = nearest && nd < wantRange + 90 && losClear(g, e.x, e.y, nearest.x, nearest.y) && e.reloadT <= 0;
  if (inRange) {
    e.angle = Math.atan2(nearest.y - e.y, nearest.x - e.x);
    if (w.mode === "charge") {
      if (e.ammo > 0) { e.charging = true; e.chargeT += dt;
        if (e.chargeT >= w.chargeTime) { fireRail(g, e, e.angle, 1); e.ammo--; e.fireCd = w.fireCd; e.charging = false; e.chargeT = 0; if (e.ammo <= 0) tryReload(e); } }
    } else if (w.mode === "disc") {
      if (!e.discOut && e.fireCd <= 0) doFire(g, e, e.angle);
    } else if (canFire(e) && Math.random() < dt * (w.mode === "shotgun" ? 2.2 : 3.2) * BOT_DIFF) {
      doFire(g, e, e.angle); if (e.ammo <= 0 && e.burstLeft <= 0) tryReload(e);
    }
  } else { e.angle = Math.atan2(ay, ax); if (e.charging) { e.charging = false; e.chargeT = 0; } }
  // dash (dodge/reposition); bots inherit the same i-frame dodge as players
  e.aiState.dashCd -= dt;
  if (e.aiState.dashCd <= 0 && e.dashTimer <= 0 && e.dashActive <= 0 && !e.charging) {
    e.aiState.dashCd = (2 + Math.random() * 3) / BOT_DIFF;
    if (e.hp < 35 && nearest) dash(e, e.x - nearest.x, e.y - nearest.y); else dash(e, gx - e.x, gy - e.y);
  }
}
function spawnPowerUp(g) {
  for (let tries = 0; tries < 20; tries++) {
    const a = Math.random() * Math.PI * 2, d = 80 + Math.random() * (ARENA_R - 140);
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
    if (!pointBlocked(g, x, y, 30)) { g.powerups.push({ x, y, r: 16, life: 11, type: POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)], dead: false }); return; }
  }
}

function tick(room) {
  // never let a sim exception crash the whole server (would freeze every client)
  try { tickInner(room); } catch (e) { console.error("tick error:", e); }
}
function tickInner(room) {
  const g = room.game; if (!g || g.over) return;
  const dt = TICK;
  // pre-game countdown: hold the sim, keep broadcasting positions so players see the map
  if (g.countdown > 0) { g.countdown -= dt; broadcastState(room, g.countdown); return; }
  g.events = [];   // per-tick feedback (dodge/reload/etc), sent to clients for floats/sound
  g.time -= dt;
  if (g.time <= 0) { g.time = 0; return endGame(room); }

  // zone timer + mode
  g.zone.timer -= dt;
  if (g.mode === "shrink") g.zone.r = g.zone.baseR * (0.45 + 0.55 * (g.zone.timer / g.zone.maxTimer));
  if (g.zone.timer <= 0) moveZone(g);

  // power-ups
  g.puTimer -= dt;
  if (g.puTimer <= 0 && g.powerups.length < 3) { spawnPowerUp(g); g.puTimer = 7 + Math.random() * 5; }
  for (const p of g.powerups) { p.life -= dt; if (p.life <= 0) p.dead = true; }

  for (const e of g.entities) {
    if (e.dead) {
      if (e.eliminated) continue;                 // out of lives — no respawn
      e.respawn -= dt;
      if (e.respawn <= 0) { e.dead = false; e.hp = e.maxHp; const a = Math.random() * Math.PI * 2; e.x = Math.cos(a) * 120; e.y = Math.sin(a) * 120; e.vx = e.vy = 0; e.buffs.speed = e.buffs.rapid = 0; e.holdStreak = 0; resetWeapon(e); }
      continue;
    }
    stepTimers(g, e, dt);
    if (e.isBot) runAI(g, e, dt); else playerStep(g, e, dt);

    if (e.dashV > 0) { e.x += e.dashDx * e.dashV; e.y += e.dashDy * e.dashV; e.dashV *= 0.82; if (e.dashV < 1) e.dashV = 0; }
    e.x += e.vx; e.y += e.vy; e.vx *= 0.86; e.vy *= 0.86;

    // obstacle collision
    for (const o of g.obstacles) { const dx = e.x - o.x, dy = e.y - o.y, d = Math.hypot(dx, dy), min = o.r + e.r; if (d < min && d > 0) { const nx = dx / d, ny = dy / d; e.x = o.x + nx * min; e.y = o.y + ny * min; e.vx *= 0.5; e.vy *= 0.5; e.dashV *= 0.4; } }

    // arena bounds (ring-out)
    const dist = Math.hypot(e.x, e.y);
    if (dist > ARENA_R - e.r) { const nx = e.x / dist, ny = e.y / dist; if (dist > ARENA_R + 10) damage(g, e, 30 * dt, e._lastHitBy); e.x = nx * (ARENA_R - e.r); e.y = ny * (ARENA_R - e.r); e.vx *= -0.4; e.vy *= -0.4; }

    // power-up pickup
    for (const p of g.powerups) { if (!p.dead && Math.hypot(e.x - p.x, e.y - p.y) < e.r + p.r) { p.dead = true; if (p.type === "health") e.hp = Math.min(e.maxHp, e.hp + 40); else if (p.type === "speed") e.buffs.speed = 6; else if (p.type === "rapid") e.buffs.rapid = 6; } }

    // zone scoring
    const zd = Math.hypot(e.x - g.zone.x, e.y - g.zone.y);
    if (zd < g.zone.r) {
      let modeMult = 1;
      if (g.mode === "koth") { e.holdStreak += dt; modeMult = 1 + Math.min(e.holdStreak / 12, 1.0); }
      e.score += ZONE_PER_SEC * entZoneMult(e) * modeMult * dt;
      if (e.score >= SCORE_TO_WIN) { g.powerups = g.powerups.filter(p => !p.dead); return endGame(room); }
    } else e.holdStreak = 0;
  }
  g.powerups = g.powerups.filter(p => !p.dead);

  // projectiles (weapon damage, piercing rail, returning disc, i-frame dodge)
  for (const p of g.projectiles) {
    if (p.disc) {
      p.age += dt;
      const owner = g.entities.find(en => en.id === p.ownerId);
      if (!p.returning && p.age >= WEAPONS.disc.returnT) { p.returning = true; p.hitSet = []; }  // re-hit allowed on return
      if (p.returning && owner && !owner.dead) {
        const a = Math.atan2(owner.y - p.y, owner.x - p.x), spd = WEAPONS.disc.projSpeed * 1.15;
        p.dx = Math.cos(a) * spd; p.dy = Math.sin(a) * spd;
        if (Math.hypot(owner.x - p.x, owner.y - p.y) < owner.r + p.r) { p.dead = true; owner.discOut = false; }
      }
    }
    p.x += p.dx; p.y += p.dy; p.life -= dt;
    if (p.life <= 0) p.dead = true;
    if (!p.dead && pointBlocked(g, p.x, p.y, p.r)) p.dead = true;
    if (p.dead) { if (p.disc) { const o = g.entities.find(en => en.id === p.ownerId); if (o) o.discOut = false; } continue; }
    for (const e of g.entities) {
      if (e.id === p.ownerId || e.dead || p.hitSet.includes(e.id)) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) < e.r + p.r) {
        if (e.dashIFrame > 0) {                         // perfect dash dodge: no damage, refund a little cooldown
          p.hitSet.push(e.id); pushEvent(g, "dodge", e.x, e.y, e.id);
          e.dashTimer = Math.max(0, e.dashTimer - DASH_REFUND); continue;
        }
        const a = Math.atan2(p.dy, p.dx), force = 6 * p.knock;
        e.vx += Math.cos(a) * force; e.vy += Math.sin(a) * force; e._lastHitBy = p.ownerId;
        damage(g, e, p.dmg, p.ownerId);
        if (p.pierce || p.disc) p.hitSet.push(e.id);   // rail pierces; disc hits each target once per leg
        else { p.dead = true; break; }
      }
    }
    if (p.dead && p.disc) { const o = g.entities.find(en => en.id === p.ownerId); if (o) o.discOut = false; }
  }
  g.projectiles = g.projectiles.filter(p => !p.dead);

  // soft body collision
  for (let i = 0; i < g.entities.length; i++) for (let j = i + 1; j < g.entities.length; j++) {
    const a = g.entities[i], b = g.entities[j]; if (a.dead || b.dead) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r;
    if (d < min && d > 0) { const ov = (min - d) / 2, nx = dx / d, ny = dy / d; a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov; }
  }

  // last player standing wins (only when the match started with 2+ entities)
  if (g.startCount >= 2 && g.entities.filter(e => !e.eliminated).length <= 1) return endGame(room);

  broadcastState(room, 0);
}
function broadcastState(room, countdown) {
  const g = room.game; if (!g) return;
  broadcast(room, {
    t: "state", time: g.time, mode: g.mode, over: false, countdown: Math.ceil(countdown || 0),
    zone: { x: g.zone.x, y: g.zone.y, r: g.zone.r },
    entities: g.entities.map(e => { const w = curWeapon(e); return {
      id: e.id, name: e.name, color: e.color, hat: e.hat, back: e.back, x: e.x, y: e.y, r: e.r, angle: e.angle,
      hp: e.hp, maxHp: e.maxHp, dead: e.dead, score: e.score, kos: e.kos, isBot: e.isBot, lives: e.lives, eliminated: e.eliminated,
      buffs: { speed: e.buffs.speed, rapid: e.buffs.rapid }, dashTimer: e.dashTimer, dashCd: e.dashCd, iframe: e.dashIFrame > 0,
      weapon: e.weapon, ammo: e.ammo, mag: w.mag, reloadF: e.reloadT > 0 ? e.reloadT / w.reload : 0, discOut: e.discOut,
      charging: e.charging, chargeF: e.charging ? Math.min(1, e.chargeT / (w.chargeTime || 1)) : 0,
    }; }),
    projectiles: g.projectiles.map(p => ({ x: p.x, y: p.y, r: p.r, ownerId: p.ownerId, color: p.color, weapon: p.weapon, disc: !!p.disc })),
    powerups: g.powerups.map(p => ({ x: p.x, y: p.y, r: p.r, type: p.type, life: p.life })),
    events: g.events,
  });
  g.events = [];
}

function endGame(room) {
  const g = room.game; if (!g) return;
  g.over = true;
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  const ranked = [...g.entities].sort((a, b) => (a.eliminated - b.eliminated) || (b.score - a.score));
  const results = ranked.map((e, idx) => ({ id: e.id, name: e.name, color: e.color, score: Math.round(e.score), kos: e.kos, place: idx + 1, isBot: e.isBot, eliminated: e.eliminated }));
  broadcast(room, { t: "end", results });
  room.game = null;
  // detach entity refs and return everyone to the lobby
  for (const p of room.players.values()) p.ent = null;
  sendLobby(room);
}

/* ===========================================================================
   WEBSOCKET HANDLERS
   =========================================================================== */
process.on("uncaughtException", e => console.error("uncaughtException:", e));
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.data = { id: null, room: null };

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const d = ws.data;

    if (m.t === "list") { send(ws, { t: "rooms", rooms: roomSummaries() }); return; }

    if (m.t === "create") {
      const code = makeCode();
      const id = "p" + (idCounter++);
      const room = { code, hostId: id, fillBots: true, players: new Map(), game: null, loop: null };
      room.players.set(id, { id, name: (m.name || "Host").slice(0, 14), color: m.color || "#00e5ff", hat: m.hat || "none", back: m.back || "none", weapon: WEAPON_KEYS.includes(m.weapon) ? m.weapon : "blaster", stats: m.stats || null, ws });
      rooms.set(code, room);
      d.id = id; d.room = room;
      send(ws, { t: "created", code, youId: id, players: playerList(room), fillBots: room.fillBots });
      return;
    }

    if (m.t === "join") {
      const room = rooms.get((m.code || "").toUpperCase());
      if (!room) { send(ws, { t: "error", msg: "Room not found" }); return; }
      if (room.game) { send(ws, { t: "error", msg: "Match already in progress" }); return; }
      if (room.players.size >= TOTAL_SLOTS) { send(ws, { t: "error", msg: "Room is full" }); return; }
      const id = "p" + (idCounter++);
      room.players.set(id, { id, name: (m.name || "Player").slice(0, 14), color: m.color || "#27e08a", hat: m.hat || "none", back: m.back || "none", weapon: WEAPON_KEYS.includes(m.weapon) ? m.weapon : "blaster", stats: m.stats || null, ws });
      d.id = id; d.room = room;
      send(ws, { t: "joined", code: room.code, youId: id, players: playerList(room), fillBots: room.fillBots });
      sendLobby(room);
      return;
    }

    const room = d.room;
    if (!room) return;

    if (m.t === "setbots" && d.id === room.hostId) { room.fillBots = !!m.fill; sendLobby(room); }
    else if (m.t === "setcolor" && !room.game) { const p = room.players.get(d.id); if (p && typeof m.color === "string") { p.color = m.color.slice(0, 9); sendLobby(room); } }
    else if (m.t === "setweapon" && !room.game) { const p = room.players.get(d.id); if (p && WEAPON_KEYS.includes(m.weapon)) { p.weapon = m.weapon; sendLobby(room); } }
    else if ((m.t === "start" || m.t === "rematch") && d.id === room.hostId && !room.game) { startGame(room); }
    else if (m.t === "input" && room.game) {
      const p = room.players.get(d.id);
      if (p && p.ent) { const e = p.ent;
        e.input.mvx = clamp(m.mvx); e.input.mvy = clamp(m.mvy);
        e.input.angle = +m.angle || 0; e.input.shoot = !!m.shoot;
        if (m.dash) e.input.dash = true;
        if (m.reload) e.input.reload = true;
      }
    }
    else if (m.t === "leave") { leave(ws); }
  });

  ws.on("close", () => leave(ws));
});
function clamp(v) { v = +v || 0; return Math.max(-1, Math.min(1, v)); }

function leave(ws) {
  const d = ws.data; const room = d.room; if (!room) return;
  const p = room.players.get(d.id);
  if (p && p.ent) { p.ent.dead = true; p.ent.removed = true; room.game && (room.game.entities = room.game.entities.filter(e => e !== p.ent)); }
  room.players.delete(d.id);
  d.room = null;
  if (room.players.size === 0) {
    if (room.loop) clearInterval(room.loop);
    rooms.delete(room.code);
    return;
  }
  if (d.id === room.hostId) room.hostId = room.players.keys().next().value;  // promote a new host
  sendLobby(room);
}

server.listen(PORT, () => console.log("Ring Rivals server listening on " + PORT));
