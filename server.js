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
const ZONE_MODE_KEYS = ["classic", "koth", "shrink"];
const POWERUP_TYPES = ["health", "speed", "rapid"];

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
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, host: p.id === room.hostId }));
}
function sendLobby(room) {
  broadcast(room, { t: "lobby", code: room.code, players: playerList(room), fillBots: room.fillBots });
}

/* ===========================================================================
   SIMULATION
   =========================================================================== */
function makeEntity(opts) {
  return {
    id: opts.id, name: opts.name, color: opts.color, isBot: !!opts.isBot,
    stats: opts.stats || null,
    x: opts.x, y: opts.y, vx: 0, vy: 0, r: 18, angle: 0,
    maxHp: opts.maxHp || 100, hp: opts.maxHp || 100,
    score: 0, kos: 0, dead: false, respawn: 0, lives: LIVES, eliminated: false,
    dashTimer: 0, shootTimer: 0, dashV: 0, dashDx: 0, dashDy: 0, dashCd: opts.dashCd || 2.5,
    buffs: { speed: 0, rapid: 0 }, holdStreak: 0,
    aiState: { dashCd: Math.random() * 2 },
    input: { mvx: 0, mvy: 0, angle: 0, shoot: false, dash: false },
  };
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
    time: MATCH_TIME, puTimer: 6, over: false,
  };
  // humans
  let i = 0;
  for (const p of room.players.values()) {
    const a = (i / TOTAL_SLOTS) * Math.PI * 2;
    g.entities.push(makeEntity({
      id: p.id, name: p.name, color: p.color, stats: p.stats,
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
        x: Math.cos(a) * 200, y: Math.sin(a) * 200,
      }));
    }
  }
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
function shoot(g, e, tx, ty, spread) {
  if (e.shootTimer > 0) return;
  e.shootTimer = entShootInt(e);
  let a = Math.atan2(ty - e.y, tx - e.x); if (spread) a += (Math.random() - 0.5) * spread;
  const spd = 9;
  g.projectiles.push({ x: e.x + Math.cos(a) * e.r, y: e.y + Math.sin(a) * e.r, dx: Math.cos(a) * spd, dy: Math.sin(a) * spd, r: 7, life: 1.2, ownerId: e.id, knock: entKnock(e), color: e.isBot ? "#ff8080" : "#ffffff", dead: false });
  e.vx -= Math.cos(a) * 0.4 * entKnock(e); e.vy -= Math.sin(a) * 0.4 * entKnock(e);
}
function dash(e, dx, dy) {
  if (e.dashTimer > 0) return;
  const len = Math.hypot(dx, dy) || 1;
  e.dashTimer = e.dashCd; e.dashV = 14; e.dashDx = dx / len; e.dashDy = dy / len;
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
  let nearest = null, nd = 1e9;
  for (const o of g.entities) { if (o === e || o.dead) continue; const d = Math.hypot(o.x - e.x, o.y - e.y); if (d < nd) { nd = d; nearest = o; } }
  let gx = g.zone.x, gy = g.zone.y, bestPU = null, pd = 200;
  for (const p of g.powerups) { const d = Math.hypot(p.x - e.x, p.y - e.y); if (d < pd) { pd = d; bestPU = p; } }
  if (bestPU) { gx = bestPU.x; gy = bestPU.y; }
  else { const zd = Math.hypot(e.x - g.zone.x, e.y - g.zone.y); if (zd < g.zone.r - 20) { gx = g.zone.x + Math.sin(g.time * 2 + e.x) * 30; gy = g.zone.y + Math.cos(g.time * 2 + e.y) * 30; } }
  const ga = Math.atan2(gy - e.y, gx - e.x); let ax = Math.cos(ga), ay = Math.sin(ga);
  for (const o of g.obstacles) { const dx = e.x - o.x, dy = e.y - o.y, d = Math.hypot(dx, dy), reach = o.r + 72; if (d < reach && d > 0) { const f = (reach - d) / reach * 1.6; ax += dx / d * f; ay += dy / d * f; } }
  const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
  const sp = entSpeed(e);
  e.vx += ax * sp * 0.18; e.vy += ay * sp * 0.18;
  const cur = Math.hypot(e.vx, e.vy); if (cur > sp) { e.vx = e.vx / cur * sp; e.vy = e.vy / cur * sp; }
  if (nearest && nd < 360 && losClear(g, e.x, e.y, nearest.x, nearest.y)) {
    e.angle = Math.atan2(nearest.y - e.y, nearest.x - e.x);
    if (Math.random() < dt * 1.4 * BOT_DIFF) shoot(g, e, nearest.x, nearest.y, 0.35 / BOT_DIFF);
  } else e.angle = Math.atan2(ay, ax);
  e.aiState.dashCd -= dt;
  if (e.aiState.dashCd <= 0 && e.dashTimer <= 0) {
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
      if (e.respawn <= 0) { e.dead = false; e.hp = e.maxHp; const a = Math.random() * Math.PI * 2; e.x = Math.cos(a) * 120; e.y = Math.sin(a) * 120; e.vx = e.vy = 0; e.buffs.speed = e.buffs.rapid = 0; e.holdStreak = 0; }
      continue;
    }
    e.shootTimer = Math.max(0, e.shootTimer - dt);
    e.dashTimer = Math.max(0, e.dashTimer - dt);
    e.buffs.speed = Math.max(0, e.buffs.speed - dt);
    e.buffs.rapid = Math.max(0, e.buffs.rapid - dt);

    if (e.isBot) runAI(g, e, dt);
    else {
      const inp = e.input, sp = entSpeed(e);
      e.vx += inp.mvx * sp * 0.25; e.vy += inp.mvy * sp * 0.25;
      const cur = Math.hypot(e.vx, e.vy); if (cur > sp) { e.vx = e.vx / cur * sp; e.vy = e.vy / cur * sp; }
      e.angle = inp.angle;
      if (inp.shoot) shoot(g, e, e.x + Math.cos(inp.angle) * 100, e.y + Math.sin(inp.angle) * 100);
      if (inp.dash) { dash(e, inp.mvx || Math.cos(inp.angle), inp.mvy || Math.sin(inp.angle)); inp.dash = false; }
    }

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

  // projectiles
  for (const p of g.projectiles) {
    p.x += p.dx; p.y += p.dy; p.life -= dt;
    if (p.life <= 0) { p.dead = true; continue; }
    if (pointBlocked(g, p.x, p.y, p.r)) { p.dead = true; continue; }
    for (const e of g.entities) {
      if (e.id === p.ownerId || e.dead) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) < e.r + p.r) {
        const a = Math.atan2(p.dy, p.dx), force = 6 * p.knock;
        e.vx += Math.cos(a) * force; e.vy += Math.sin(a) * force; e._lastHitBy = p.ownerId;
        damage(g, e, PROJ_DMG, p.ownerId); p.dead = true; break;
      }
    }
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

  // broadcast state
  broadcast(room, {
    t: "state", time: g.time, mode: g.mode, over: false,
    zone: { x: g.zone.x, y: g.zone.y, r: g.zone.r },
    entities: g.entities.map(e => ({ id: e.id, name: e.name, color: e.color, x: e.x, y: e.y, r: e.r, angle: e.angle, hp: e.hp, maxHp: e.maxHp, dead: e.dead, score: e.score, kos: e.kos, isBot: e.isBot, lives: e.lives, eliminated: e.eliminated, buffs: { speed: e.buffs.speed, rapid: e.buffs.rapid }, dashTimer: e.dashTimer, dashCd: e.dashCd })),
    projectiles: g.projectiles.map(p => ({ x: p.x, y: p.y, r: p.r, ownerId: p.ownerId, color: p.color })),
    powerups: g.powerups.map(p => ({ x: p.x, y: p.y, r: p.r, type: p.type, life: p.life })),
  });
}

function endGame(room) {
  const g = room.game; if (!g) return;
  g.over = true;
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  const ranked = [...g.entities].sort((a, b) => (a.eliminated - b.eliminated) || (b.score - a.score));
  const results = ranked.map((e, idx) => ({ id: e.id, name: e.name, score: Math.round(e.score), kos: e.kos, place: idx + 1, isBot: e.isBot, eliminated: e.eliminated }));
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

    if (m.t === "create") {
      const code = makeCode();
      const id = "p" + (idCounter++);
      const room = { code, hostId: id, fillBots: true, players: new Map(), game: null, loop: null };
      room.players.set(id, { id, name: (m.name || "Host").slice(0, 14), color: m.color || "#00e5ff", stats: m.stats || null, ws });
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
      room.players.set(id, { id, name: (m.name || "Player").slice(0, 14), color: m.color || "#27e08a", stats: m.stats || null, ws });
      d.id = id; d.room = room;
      send(ws, { t: "joined", code: room.code, youId: id, players: playerList(room), fillBots: room.fillBots });
      sendLobby(room);
      return;
    }

    const room = d.room;
    if (!room) return;

    if (m.t === "setbots" && d.id === room.hostId) { room.fillBots = !!m.fill; sendLobby(room); }
    else if ((m.t === "start" || m.t === "rematch") && d.id === room.hostId && !room.game) { startGame(room); }
    else if (m.t === "input" && room.game) {
      const p = room.players.get(d.id);
      if (p && p.ent) { const e = p.ent;
        e.input.mvx = clamp(m.mvx); e.input.mvy = clamp(m.mvy);
        e.input.angle = +m.angle || 0; e.input.shoot = !!m.shoot;
        if (m.dash) e.input.dash = true;
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
