import {
  TICK_RATE,
  SNAPSHOT_RATE,
  MAX_PLAYERS,
  ARENA_W,
  ARENA_H,
  SHIP,
  PROJECTILE,
  COLORS,
  TEAM_COLORS,
  TEAM_NAMES,
} from '../../shared/constants.js';
import {
  wrapPos,
  wrapDelta,
  distSq,
  applyGravity,
  clampSpeed,
  integrate,
  circleHit,
  randomSpawn,
  resolveWallCollision,
  pointInWall,
  rayHitCircle,
} from '../../shared/physics.js';
import { createBotPlayer, updateBot, TRAINING_GRACE_SEC } from './bot.js';

let nextId = 1;
function uid() {
  return String(nextId++);
}

export class Room {
  constructor(code, hostId, hostName, isPublic = false) {
    this.code = code;
    this.hostId = hostId;
    this.isPublic = isPublic;
    this.phase = 'lobby'; // lobby | editor | playing | results
    this.mode = 'ffa'; // ffa | teams | training
    this.teamCount = 2;
    /** Classic Asteroids-style breakup when rocks are hit */
    this.fragmentingAsteroids = false;
    this.players = new Map(); // id -> player
    this.map = defaultMap();
    this.projectiles = [];
    this.particles = []; // server-side event queue for FX
    this.events = [];
    this.tick = 0;
    this.simAccum = 0;
    this.snapAccum = 0;
    this.lastTime = Date.now();
    this.winner = null;
    this.winnerTeam = null;
    this.matchTime = 0;
    this.movingObjects = [];
    /** Dynamic breakable rocks (fragmenting mode) */
    this.rocks = [];
    this._interval = null;
    this.trainingEpilogue = null; // { t, winnerId, kind }
    this.matchEpilogue = null; // { t, winnerId, winnerTeam } — 5s continue-then-results
    this.nukes = []; // expanding pulse waves
    this.delayedShots = []; // { t, type, playerId }
  }

  setFragmentingAsteroids(on) {
    this.fragmentingAsteroids = !!on;
  }

  makeRock(x, y, radius, vx = 0, vy = 0, gen = 0) {
    return {
      id: uid(),
      x,
      y,
      vx,
      vy,
      radius: Math.max(8, radius),
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 3.5,
      gen, // 0 large, 1 medium, 2 small
      seed: Math.floor(Math.random() * 1000),
    };
  }

  /** Split a rock into smaller drifting pieces (classic Asteroids). */
  fragmentRock(rock, impactVx = 0, impactVy = 0) {
    if (!rock) return;
    const idx = this.rocks.indexOf(rock);
    if (idx >= 0) this.rocks.splice(idx, 1);
    else {
      // may already be removed by id
      const j = this.rocks.findIndex((r) => r.id === rock.id);
      if (j >= 0) this.rocks.splice(j, 1);
    }

    this.pushEvent({
      type: 'rock_break',
      x: rock.x,
      y: rock.y,
      radius: rock.radius,
      color: '#c4b5a0',
    });

    // Smallest generation: just vaporize
    if (rock.gen >= 2 || rock.radius < 14) return;
    if (this.rocks.length > 90) return; // safety cap

    const n = rock.gen === 0 ? (Math.random() < 0.4 ? 3 : 2) : 2;
    const newR = rock.radius * (rock.gen === 0 ? 0.52 : 0.55);
    const newGen = rock.gen + 1;
    for (let i = 0; i < n; i++) {
      if (this.rocks.length > 90) break;
      const ang = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const sp = 55 + Math.random() * 110;
      const child = this.makeRock(
        rock.x + Math.cos(ang) * (rock.radius * 0.3),
        rock.y + Math.sin(ang) * (rock.radius * 0.3),
        newR,
        Math.cos(ang) * sp + rock.vx * 0.35 + impactVx * 0.25,
        Math.sin(ang) * sp + rock.vy * 0.35 + impactVy * 0.25,
        newGen
      );
      const wp = wrapPos(child.x, child.y);
      child.x = wp.x;
      child.y = wp.y;
      this.rocks.push(child);
    }
  }

  /** Hit rock by projectile / nuke / ship — returns true if a rock was hit */
  hitRockAt(x, y, hitR, impactVx = 0, impactVy = 0) {
    if (!this.fragmentingAsteroids) return false;
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const rock = this.rocks[i];
      if (circleHit(x, y, hitR, rock.x, rock.y, rock.radius)) {
        this.fragmentRock(rock, impactVx, impactVy);
        return true;
      }
    }
    return false;
  }

  simulateRocks(dt, wells) {
    if (!this.fragmentingAsteroids) return;
    const ROCK_MAX_SPEED = 380;
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const rock = this.rocks[i];
      applyGravity(rock, wells, dt, true);
      clampSpeed(rock, ROCK_MAX_SPEED);
      // Slight vacuum drag like ships for feel
      integrate(rock, dt, 0.02);
      rock.angle += rock.spin * dt;

      // Consumed by gravity well cores
      let eaten = false;
      for (const w of wells) {
        const killR = w.killRadius || w.radius * 0.4;
        if (circleHit(rock.x, rock.y, rock.radius * 0.5, w.x, w.y, killR)) {
          eaten = true;
          break;
        }
      }
      if (eaten) {
        this.pushEvent({
          type: 'rock_break',
          x: rock.x,
          y: rock.y,
          radius: rock.radius * 0.6,
          color: '#f59e0b',
        });
        this.rocks.splice(i, 1);
      }
    }
  }

  addPlayer(id, name, socket) {
    if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'Room full' };
    if (this.phase === 'playing') return { ok: false, error: 'Match in progress' };
    const colorIndex = this.players.size % COLORS.length;
    const team = this.mode === 'teams' ? this.players.size % this.teamCount : -1;
    const player = {
      id,
      name: (name || 'Pilot').slice(0, 16),
      socket,
      color: COLORS[colorIndex],
      colorIndex,
      team,
      ready: false,
      alive: true,
      spectator: false,
      // ship state
      x: ARENA_W / 2,
      y: ARENA_H / 2,
      vx: 0,
      vy: 0,
      angle: 0,
      thrusting: false,
      rotating: 0, // -1 left, 1 right
      laserHits: 0,
      shieldActive: false,
      shieldTimer: 0,
      invuln: 0,
      cooldowns: {
        photon: 0,
        laser: 0,
        shield: 0,
        hyperspace: 0,
        nuke: 0,
      },
      wormholeCooldown: 0,
      inputSeq: 0,
      kills: 0,
      deaths: 0,
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    return { ok: true, player: publicPlayer(player) };
  }

  removePlayer(id) {
    const wasHost = this.hostId === id;
    this.players.delete(id);
    // Drop bots if no humans remain
    const humans = [...this.players.values()].filter((p) => !p.isBot);
    if (humans.length === 0) {
      this.stopLoop();
      this.players.clear();
      return { empty: true };
    }
    if (wasHost) {
      const next = humans[0];
      this.hostId = next.id;
      this.emitAll('host_changed', { hostId: this.hostId });
    }
    if (this.phase === 'playing') {
      this.checkWin();
    }
    return { empty: false, hostId: this.hostId };
  }

  setMode(mode, teamCount = 2) {
    if (mode === 'teams') this.mode = 'teams';
    else if (mode === 'training') this.mode = 'training';
    else this.mode = 'ffa';
    this.teamCount = Math.min(4, Math.max(2, teamCount | 0));
    // Strip leftover bots when leaving training
    if (this.mode !== 'training') {
      for (const [id, p] of this.players) {
        if (p.isBot) this.players.delete(id);
      }
    }
    if (this.mode === 'teams') {
      let i = 0;
      for (const p of this.players.values()) {
        if (p.isBot) continue;
        p.team = i % this.teamCount;
        i++;
      }
    } else {
      for (const p of this.players.values()) p.team = -1;
    }
  }

  setTeam(playerId, team) {
    const p = this.players.get(playerId);
    if (!p || this.mode !== 'teams') return;
    if (team < 0 || team >= this.teamCount) return;
    p.team = team;
  }

  setMap(mapData) {
    if (this.phase === 'playing') return;
    this.map = normalizeMap(mapData);
  }

  startMatch() {
    const humans = [...this.players.values()].filter((p) => !p.isBot);
    if (humans.length < 1) return false;

    // Training: ensure one AI opponent
    if (this.mode === 'training') {
      for (const [id, p] of this.players) {
        if (p.isBot) this.players.delete(id);
      }
      const bot = createBotPlayer();
      this.players.set(bot.id, bot);
    } else {
      for (const [id, p] of this.players) {
        if (p.isBot) this.players.delete(id);
      }
    }

    this.phase = 'playing';
    this.projectiles = [];
    this.events = [];
    this.winner = null;
    this.winnerTeam = null;
    this.matchTime = 0;
    this.tick = 0;
    this.trainingEpilogue = null;
    this.matchEpilogue = null;

    this.rocks = [];
    if (this.fragmentingAsteroids) {
      // All map asteroids + movers become free-floating breakable rocks
      for (const a of this.map.asteroids || []) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 15 + Math.random() * 35; // slight drift
        this.rocks.push(
          this.makeRock(a.x, a.y, a.radius || 40, Math.cos(ang) * sp, Math.sin(ang) * sp, 0)
        );
      }
      for (const m of this.map.movers || []) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 50 + Math.random() * 70;
        this.rocks.push(
          this.makeRock(m.x, m.y, m.radius || 30, Math.cos(ang) * sp, Math.sin(ang) * sp, 0)
        );
      }
      this.movingObjects = [];
    } else {
      // Classic path-following movers; static map asteroids
      this.movingObjects = (this.map.movers || []).map((m) => ({
        ...m,
        id: m.id || uid(),
        baseX: m.x,
        baseY: m.y,
        t: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 2.5,
        angle: Math.random() * Math.PI * 2,
        seed: Math.floor(Math.random() * 1000),
      }));
    }

    for (const p of this.players.values()) {
      const spawn = randomSpawn(this.map.wells, this.map.walls, this.map.asteroids);
      p.x = spawn.x;
      p.y = spawn.y;
      p.vx = 0;
      p.vy = 0;
      p.angle = spawn.angle;
      p.alive = true;
      p.spectator = false;
      p.laserHits = 0;
      p.shieldActive = false;
      p.shieldTimer = 0;
      p.invuln = SHIP.invulnSpawn;
      p.thrusting = false;
      p.rotating = 0;
      p.cooldowns = { photon: 0, laser: 0, shield: 0, hyperspace: 0, nuke: 0 };
      p.wormholeCooldown = 0;
      p.kills = 0;
      p.deaths = 0;
      if (p.isBot) p._ai = null;
    }
    this.nukes = [];
    this.delayedShots = [];

    // Spawn bot away from human in training
    if (this.mode === 'training') {
      const bot = [...this.players.values()].find((p) => p.isBot);
      const human = humans[0];
      if (bot && human) {
        const ang = Math.random() * Math.PI * 2;
        bot.x = human.x + Math.cos(ang) * 500;
        bot.y = human.y + Math.sin(ang) * 500;
        const wp = wrapPos(bot.x, bot.y);
        bot.x = wp.x;
        bot.y = wp.y;
        bot.angle = ang + Math.PI;
      }
    }

    this.startLoop();
    this.emitAll('match_start', this.publicState());
    return true;
  }

  returnToLobby() {
    this.stopLoop();
    this.phase = 'lobby';
    this.projectiles = [];
    this.events = [];
    this.winner = null;
    // Remove bots outside of active match
    for (const [id, p] of this.players) {
      if (p.isBot) this.players.delete(id);
    }
    for (const p of this.players.values()) {
      p.alive = true;
      p.spectator = false;
      p.ready = false;
    }
    this.emitAll('phase', { phase: 'lobby', state: this.publicState() });
  }

  enterEditor() {
    if (this.phase === 'playing') return;
    this.phase = 'editor';
    this.emitAll('phase', { phase: 'editor', state: this.publicState() });
  }

  setInput(playerId, input) {
    const p = this.players.get(playerId);
    if (!p || !p.alive || p.spectator || this.phase !== 'playing') return;
    if (typeof input.rotating === 'number') p.rotating = Math.max(-1, Math.min(1, input.rotating));
    if (typeof input.thrusting === 'boolean') p.thrusting = input.thrusting;
    if (input.action) this.handleAction(p, input.action);
    if (input.seq != null) p.inputSeq = input.seq;
  }

  handleAction(p, action) {
    if (!p.alive) return;
    const a = String(action).toLowerCase();
    if (a === 'photon' && p.cooldowns.photon <= 0) {
      this.firePhoton(p);
      p.cooldowns.photon = SHIP.photonCooldown;
    } else if (a === 'laser' && p.cooldowns.laser <= 0) {
      this.fireLaser(p);
      p.cooldowns.laser = SHIP.laserCooldown;
    } else if (a === 'shield' || a === 'shields') {
      if (p.cooldowns.shield <= 0 && !p.shieldActive) {
        p.shieldActive = true;
        p.shieldTimer = SHIP.shieldDuration;
        p.cooldowns.shield = SHIP.shieldCooldown;
        this.pushEvent({ type: 'shield', x: p.x, y: p.y, id: p.id });
      }
    } else if (a === 'hyperspace') {
      if (p.cooldowns.hyperspace <= 0) {
        this.doHyperspace(p);
        p.cooldowns.hyperspace = SHIP.hyperspaceCooldown;
      }
    } else if (a === 'nuke') {
      // Hidden voice command — expanding pulse wave
      if (p.cooldowns.nuke <= 0) {
        this.fireNuke(p);
        p.cooldowns.nuke = SHIP.nukeCooldown;
      }
    }
  }

  fireNuke(p) {
    this.nukes.push({
      id: uid(),
      ownerId: p.id,
      team: p.team,
      x: p.x,
      y: p.y,
      radius: 0,
      prevRadius: 0,
      maxRadius: SHIP.nukeMaxRadius,
      speed: SHIP.nukeExpandSpeed,
      color: p.color,
      hit: new Set(),
    });
    this.pushEvent({
      type: 'nuke_fire',
      id: p.id,
      x: p.x,
      y: p.y,
      maxRadius: SHIP.nukeMaxRadius,
      color: p.color,
    });
  }

  /**
   * True if line of sight from (ox,oy) to (tx,ty) is blocked by a solid map object
   * closer than the target (sun/well core, asteroid, mover).
   */
  isNukeBlocked(ox, oy, tx, ty, excludeRockId = null) {
    const { dx, dy } = wrapDelta(ox, oy, tx, ty);
    const targetDist = Math.hypot(dx, dy) || 1;
    const solids = [];
    for (const w of this.map.wells || []) {
      solids.push({ x: w.x, y: w.y, r: (w.killRadius || w.radius * 0.45) + 8 });
    }
    if (this.fragmentingAsteroids) {
      for (const r of this.rocks) {
        if (excludeRockId && r.id === excludeRockId) continue;
        solids.push({ x: r.x, y: r.y, r: r.radius });
      }
    } else {
      for (const a of this.map.asteroids || []) {
        solids.push({ x: a.x, y: a.y, r: a.radius });
      }
      for (const m of this.movingObjects || []) {
        solids.push({ x: m.x, y: m.y, r: m.radius || 22 });
      }
    }
    for (const s of solids) {
      const hit = rayHitCircle(ox, oy, tx, ty, s.x, s.y, s.r);
      if (hit != null && hit < targetDist - 4) return true;
    }
    return false;
  }

  simulateNukes(dt) {
    for (let i = this.nukes.length - 1; i >= 0; i--) {
      const n = this.nukes[i];
      n.prevRadius = n.radius;
      n.radius += n.speed * dt;
      if (n.radius >= n.maxRadius) {
        this.nukes.splice(i, 1);
        continue;
      }
      const band = SHIP.nukeRingWidth;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (p.id === n.ownerId) continue;
        if (this.mode === 'teams' && n.team === p.team && n.team >= 0) continue;
        if (n.hit.has(p.id)) continue;

        const { dx, dy } = wrapDelta(n.x, n.y, p.x, p.y);
        const dist = Math.hypot(dx, dy);
        // Wave front just reached this ship
        const reached =
          (n.prevRadius - band * 0.5 < dist && n.radius + band * 0.5 >= dist) ||
          Math.abs(dist - n.radius) <= band * 0.5;
        if (!reached) continue;

        // Hyperspace / invuln avoids the wave
        if (p.invuln > 0) {
          n.hit.add(p.id);
          continue;
        }
        // Occlusion by sun / asteroids / movers
        if (this.isNukeBlocked(n.x, n.y, p.x, p.y)) {
          n.hit.add(p.id);
          continue;
        }
        // Shields block the pulse
        if (p.shieldActive) {
          n.hit.add(p.id);
          this.pushEvent({ type: 'shield_hit', x: p.x, y: p.y, id: p.id });
          continue;
        }

        n.hit.add(p.id);
        p.laserHits++;
        this.pushEvent({
          type: 'laser_hit',
          x: p.x,
          y: p.y,
          id: p.id,
          hits: p.laserHits,
          fromNuke: true,
        });
        if (p.laserHits >= SHIP.laserHitsToKill) {
          this.killShip(p, n.ownerId);
        }
      }

      // Nuke pulse breaks fragmenting rocks
      if (this.fragmentingAsteroids) {
        for (let ri = this.rocks.length - 1; ri >= 0; ri--) {
          const rock = this.rocks[ri];
          if (n.hit.has('rock_' + rock.id)) continue;
          const { dx, dy } = wrapDelta(n.x, n.y, rock.x, rock.y);
          const dist = Math.hypot(dx, dy);
          const band = SHIP.nukeRingWidth;
          const reached =
            (n.prevRadius - band * 0.5 < dist && n.radius + band * 0.5 >= dist) ||
            Math.abs(dist - n.radius) <= band * 0.5;
          if (!reached) continue;
          // Blocked if something else is between nuke origin and rock
          if (this.isNukeBlocked(n.x, n.y, rock.x, rock.y, rock.id)) {
            n.hit.add('rock_' + rock.id);
            continue;
          }
          n.hit.add('rock_' + rock.id);
          // Direction away from blast for fragment kick
          const kick = 80;
          const kx = dist > 1 ? (dx / dist) * kick : 0;
          const ky = dist > 1 ? (dy / dist) * kick : 0;
          this.fragmentRock(rock, kx, ky);
        }
      }
    }
  }

  firePhoton(p) {
    const cos = Math.cos(p.angle);
    const sin = Math.sin(p.angle);
    this.projectiles.push({
      id: uid(),
      type: 'photon',
      ownerId: p.id,
      team: p.team,
      x: p.x + cos * (SHIP.radius + 10),
      y: p.y + sin * (SHIP.radius + 10),
      vx: p.vx + cos * PROJECTILE.photonSpeed,
      vy: p.vy + sin * PROJECTILE.photonSpeed,
      life: PROJECTILE.photonLife,
      r: PROJECTILE.photonRadius,
      color: PROJECTILE.photonColor,
    });
    this.pushEvent({ type: 'photon_fire', x: p.x, y: p.y, id: p.id });
  }

  spawnLaserBolt(p) {
    if (!p?.alive) return;
    const cos = Math.cos(p.angle);
    const sin = Math.sin(p.angle);
    this.projectiles.push({
      id: uid(),
      type: 'laser',
      ownerId: p.id,
      team: p.team,
      x: p.x + cos * (SHIP.radius + 8),
      y: p.y + sin * (SHIP.radius + 8),
      vx: p.vx + cos * PROJECTILE.laserSpeed,
      vy: p.vy + sin * PROJECTILE.laserSpeed,
      life: PROJECTILE.laserLife,
      r: PROJECTILE.laserRadius,
      color: PROJECTILE.laserColor,
    });
    this.pushEvent({ type: 'laser_fire', x: p.x, y: p.y, id: p.id });
  }

  fireLaser(p) {
    // Twin blast: first bolt now, second a fraction of a second later
    this.spawnLaserBolt(p);
    this.delayedShots.push({
      t: PROJECTILE.laserPairDelay ?? 0.1,
      type: 'laser',
      playerId: p.id,
    });
  }

  processDelayedShots(dt) {
    for (let i = this.delayedShots.length - 1; i >= 0; i--) {
      const d = this.delayedShots[i];
      d.t -= dt;
      if (d.t > 0) continue;
      this.delayedShots.splice(i, 1);
      const p = this.players.get(d.playerId);
      if (!p || !p.alive) continue;
      if (d.type === 'laser') this.spawnLaserBolt(p);
    }
  }

  /** Random hyperspace exit that avoids wells, rocks, asteroids, and other ships */
  safeHyperspaceSpawn(selfId) {
    const wells = this.map.wells || [];
    const asteroids = this.map.asteroids || [];
    const rocks = this.fragmentingAsteroids ? this.rocks : [];
    const others = [...this.players.values()].filter((o) => o.alive && o.id !== selfId);
    const margin = 100;

    for (let attempt = 0; attempt < 50; attempt++) {
      const x = margin + Math.random() * (ARENA_W - margin * 2);
      const y = margin + Math.random() * (ARENA_H - margin * 2);
      let ok = true;

      for (const w of wells) {
        const clear = (w.radius || 60) + 160;
        if (distSq(x, y, w.x, w.y) < clear * clear) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      for (const a of asteroids) {
        if (distSq(x, y, a.x, a.y) < (a.radius + 70) ** 2) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      for (const r of rocks) {
        if (distSq(x, y, r.x, r.y) < (r.radius + 70) ** 2) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      for (const m of this.movingObjects || []) {
        if (distSq(x, y, m.x, m.y) < ((m.radius || 22) + 70) ** 2) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      for (const o of others) {
        if (distSq(x, y, o.x, o.y) < 160 * 160) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      return { x, y, angle: Math.random() * Math.PI * 2 };
    }

    // Fallback: map randomSpawn (already avoids wells/asteroids roughly)
    return randomSpawn(wells, this.map.walls, asteroids);
  }

  /**
   * Teleport through paired wormholes. Exit is placed outside the destination
   * radius so the ship never immediately re-triggers the exit hole.
   */
  tryWormholeTeleport(p, wormholes) {
    if (!wormholes || wormholes.length < 2) return;
    for (let i = 0; i + 1 < wormholes.length; i += 2) {
      const a = wormholes[i];
      const b = wormholes[i + 1];
      if (!a || !b) continue;
      const ra = a.radius || 28;
      const rb = b.radius || 28;
      let from = null;
      let to = null;
      let toR = 0;
      if (circleHit(p.x, p.y, SHIP.radius * 0.6, a.x, a.y, ra)) {
        from = a;
        to = b;
        toR = rb;
      } else if (circleHit(p.x, p.y, SHIP.radius * 0.6, b.x, b.y, rb)) {
        from = b;
        to = a;
        toR = ra;
      }
      if (!from || !to) continue;

      const fromX = p.x;
      const fromY = p.y;
      // Exit well clear of the portal (plus ship radius) along velocity or random
      let dirX = p.vx;
      let dirY = p.vy;
      let spd = Math.hypot(dirX, dirY);
      if (spd < 20) {
        const ang = Math.random() * Math.PI * 2;
        dirX = Math.cos(ang);
        dirY = Math.sin(ang);
        spd = 1;
      } else {
        dirX /= spd;
        dirY /= spd;
      }
      const exitDist = toR + SHIP.radius + 48;
      let nx = to.x + dirX * exitDist;
      let ny = to.y + dirY * exitDist;
      const wp = wrapPos(nx, ny);
      p.x = wp.x;
      p.y = wp.y;
      // Keep some momentum along exit direction
      const boost = Math.max(180, Math.hypot(p.vx, p.vy) * 0.8);
      p.vx = dirX * boost;
      p.vy = dirY * boost;
      p.wormholeCooldown = 1.25; // prevent instant re-entry
      p.invuln = Math.max(p.invuln, 0.35);

      this.pushEvent({
        type: 'wormhole_jump',
        id: p.id,
        fromX,
        fromY,
        toX: p.x,
        toY: p.y,
        color: p.color,
        angle: p.angle,
      });
      // Also keep short alias for FX listeners
      this.pushEvent({ type: 'wormhole', x: p.x, y: p.y, id: p.id });
      return;
    }
  }

  doHyperspace(p) {
    this.pushEvent({ type: 'hyperspace_out', x: p.x, y: p.y, id: p.id });
    // Random but relatively safe location (clear of wells, rocks, ships)
    const spawn = this.safeHyperspaceSpawn(p.id);
    p.x = spawn.x;
    p.y = spawn.y;
    p.angle = spawn.angle ?? p.angle;
    p.vx *= 0.25;
    p.vy *= 0.25;
    p.invuln = 0.75;
    this.pushEvent({ type: 'hyperspace_in', x: p.x, y: p.y, id: p.id });
  }

  killShip(p, killerId = null) {
    if (!p.alive) return;
    p.alive = false;
    p.spectator = true;
    p.deaths++;
    p.thrusting = false;
    p.rotating = 0;
    if (killerId && killerId !== p.id) {
      const k = this.players.get(killerId);
      if (k) k.kills++;
    }
    // Asteroids-style ship breakup + explosion
    this.pushEvent({
      type: 'explode',
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      angle: p.angle,
      id: p.id,
      color: p.color,
      breakup: true,
    });
    this.checkWin();
  }

  checkWin() {
    if (this.phase !== 'playing') return;
    if (this.trainingEpilogue || this.matchEpilogue) return;

    const alive = [...this.players.values()].filter((p) => p.alive);
    if (alive.length === 0) {
      this.queueEndMatch(null, null);
      return;
    }

    if (this.mode === 'training') {
      const humansAlive = alive.filter((p) => !p.isBot);
      const botsAlive = alive.filter((p) => p.isBot);
      // Player died → 5s defeat banner, then results
      if (humansAlive.length === 0) {
        const winnerId = botsAlive[0]?.id ?? null;
        this.trainingEpilogue = { t: 5, winnerId, kind: 'defeat' };
        this.pushEvent({
          type: 'training_defeat',
          message: 'Better Luck Next Time, Starfighter!',
          duration: 5,
        });
        return;
      }
      // Bot destroyed → 5s continue then victory results
      if (botsAlive.length === 0 && humansAlive.length >= 1) {
        this.queueEndMatch(humansAlive[0].id, null);
      }
      return;
    }

    if (this.mode === 'ffa') {
      if (alive.length === 1 && this.players.size > 1) {
        this.queueEndMatch(alive[0].id, null);
      }
    } else {
      const teams = new Set(alive.map((p) => p.team));
      if (teams.size <= 1) {
        this.queueEndMatch(null, [...teams][0] ?? null);
      }
    }
  }

  /** Keep playing 5s, then open results / play-again */
  queueEndMatch(winnerId, winnerTeam) {
    if (this.matchEpilogue || this.trainingEpilogue) return;
    const isDraw = winnerId == null && (winnerTeam == null || winnerTeam < 0);
    this.matchEpilogue = {
      t: 5,
      winnerId,
      winnerTeam,
      kind: isDraw ? 'draw' : 'victory',
    };
    this.pushEvent({
      type: 'match_ending',
      remaining: 5,
      winnerId,
      winnerTeam,
      kind: isDraw ? 'draw' : 'victory',
    });
  }

  endMatch(winnerId, winnerTeam) {
    this.phase = 'results';
    this.winner = winnerId;
    this.winnerTeam = winnerTeam;
    this.trainingEpilogue = null;
    this.matchEpilogue = null;
    this.stopLoop();
    this.emitAll('match_end', {
      winnerId,
      winnerTeam,
      players: this.playerList(),
      state: this.publicState(),
    });
  }

  pushEvent(ev) {
    this.events.push(ev);
  }

  startLoop() {
    this.stopLoop();
    this.lastTime = Date.now();
    this.simAccum = 0;
    this.snapAccum = 0;
    const dtTick = 1 / TICK_RATE;
    this._interval = setInterval(() => {
      const now = Date.now();
      let frameDt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (frameDt > 0.1) frameDt = 0.1;
      this.simAccum += frameDt;
      this.snapAccum += frameDt;
      while (this.simAccum >= dtTick) {
        this.simulate(dtTick);
        this.simAccum -= dtTick;
      }
      if (this.snapAccum >= 1 / SNAPSHOT_RATE) {
        this.broadcastSnapshot();
        this.snapAccum = 0;
      }
    }, 1000 / 60);
  }

  stopLoop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  simulate(dt) {
    if (this.phase !== 'playing') return;
    this.tick++;
    this.matchTime += dt;

    // Epilogue countdowns (keep sim running so action continues)
    if (this.trainingEpilogue) {
      this.trainingEpilogue.t -= dt;
      if (this.trainingEpilogue.t <= 0) {
        const w = this.trainingEpilogue.winnerId;
        this.trainingEpilogue = null;
        this.endMatch(w, null);
        return;
      }
    }
    if (this.matchEpilogue) {
      this.matchEpilogue.t -= dt;
      if (this.matchEpilogue.t <= 0) {
        const { winnerId, winnerTeam } = this.matchEpilogue;
        this.matchEpilogue = null;
        this.endMatch(winnerId, winnerTeam);
        return;
      }
    }

    const wells = this.map.wells;
    const walls = this.map.walls || [];
    const asteroids = this.map.asteroids || [];
    const wormholes = this.map.wormholes || [];

    // Path-following movers (non-fragmenting maps only)
    if (!this.fragmentingAsteroids) {
      for (const m of this.movingObjects) {
        m.t += dt;
        m.angle = (m.angle || 0) + (m.spin || 1) * dt;
        const amp = m.amp || 80;
        const spd = m.speed || 1;
        if (m.pattern === 'circle') {
          m.x = m.baseX + Math.cos(m.t * spd) * amp;
          m.y = m.baseY + Math.sin(m.t * spd) * amp;
        } else {
          m.x = m.baseX + Math.sin(m.t * spd) * amp;
          m.y = m.baseY + Math.cos(m.t * spd * 0.5) * (amp * 0.35);
        }
        const wp = wrapPos(m.x, m.y);
        m.x = wp.x;
        m.y = wp.y;
      }
    }

    // Free-floating breakable rocks (fragmenting mode) — gravity + well consumption
    this.simulateRocks(dt, wells);

    // Twin laser second bolts, etc.
    this.processDelayedShots(dt);

    // AI brains (before physics so inputs apply this tick)
    if (this.mode === 'training' && !this.trainingEpilogue) {
      const humans = [...this.players.values()].filter((p) => !p.isBot && p.alive);
      for (const p of this.players.values()) {
        if (p.isBot && p.alive) {
          updateBot(p, humans, this.map, this.projectiles, this, dt, this.matchTime);
        }
      }
    } else if (this.mode === 'training' && this.trainingEpilogue) {
      // During epilogue: bot idles / drifts
      for (const p of this.players.values()) {
        if (p.isBot && p.alive) {
          p.rotating = 0;
          p.thrusting = false;
        }
      }
    }

    // Ships
    for (const p of this.players.values()) {
      if (!p.alive) continue;

      // cooldowns
      for (const k of Object.keys(p.cooldowns)) {
        if (p.cooldowns[k] > 0) p.cooldowns[k] = Math.max(0, p.cooldowns[k] - dt);
      }
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (p.shieldActive) {
        p.shieldTimer -= dt;
        if (p.shieldTimer <= 0) {
          p.shieldActive = false;
          p.shieldTimer = 0;
        }
      }

      p.angle += p.rotating * SHIP.rotateSpeed * dt;
      if (p.thrusting) {
        p.vx += Math.cos(p.angle) * SHIP.thrust * dt;
        p.vy += Math.sin(p.angle) * SHIP.thrust * dt;
      }
      applyGravity(p, wells, dt, true);
      clampSpeed(p, SHIP.maxSpeed);
      integrate(p, dt, SHIP.drag);

      for (const wall of walls) {
        resolveWallCollision(p, wall, SHIP.radius);
      }
      // Asteroids / rocks / movers always destroy ships
      if (this.fragmentingAsteroids) {
        for (let ri = this.rocks.length - 1; ri >= 0; ri--) {
          const rock = this.rocks[ri];
          if (circleHit(p.x, p.y, SHIP.radius * 0.9, rock.x, rock.y, rock.radius)) {
            // Ship dies; rock fragments from the impact
            const ivx = p.vx;
            const ivy = p.vy;
            this.killShip(p, null);
            this.fragmentRock(rock, ivx * 0.4, ivy * 0.4);
            break;
          }
        }
      } else {
        for (const a of asteroids) {
          if (circleHit(p.x, p.y, SHIP.radius * 0.9, a.x, a.y, a.radius)) {
            this.killShip(p, null);
            break;
          }
        }
        if (p.alive) {
          for (const m of this.movingObjects) {
            const r = m.radius || 20;
            if (circleHit(p.x, p.y, SHIP.radius * 0.9, m.x, m.y, r)) {
              this.killShip(p, null);
              break;
            }
          }
        }
      }
      if (!p.alive) continue;

      // Gravity well kill zone (center of strong wells)
      for (const w of wells) {
        if (w.killRadius && circleHit(p.x, p.y, SHIP.radius * 0.5, w.x, w.y, w.killRadius)) {
          if (!p.shieldActive && p.invuln <= 0) {
            this.killShip(p, null);
          }
        }
      }
      if (!p.alive) continue;

      // Wormholes — paired teleport with exit offset + cooldown (no re-entry stuck loop)
      if (p.wormholeCooldown > 0) {
        p.wormholeCooldown = Math.max(0, p.wormholeCooldown - dt);
      } else {
        this.tryWormholeTeleport(p, wormholes);
      }
    }

    // Nuke pulse waves
    this.simulateNukes(dt);

    // Ship-ship collisions
    const alive = [...this.players.values()].filter((p) => p.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (this.mode === 'teams' && a.team === b.team) continue;
        if (circleHit(a.x, a.y, SHIP.radius * 0.85, b.x, b.y, SHIP.radius * 0.85)) {
          const aSafe = a.shieldActive || a.invuln > 0;
          const bSafe = b.shieldActive || b.invuln > 0;
          if (!aSafe && !bSafe) {
            this.killShip(a, b.id);
            this.killShip(b, a.id);
          } else if (!aSafe && bSafe) {
            this.killShip(a, b.id);
          } else if (aSafe && !bSafe) {
            this.killShip(b, a.id);
          }
        }
      }
    }

    // Projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      if (pr.life <= 0) {
        this.projectiles.splice(i, 1);
        continue;
      }
      if (pr.type === 'photon') {
        applyGravity(pr, wells, dt, true);
      }
      integrate(pr, dt, 0);

      // Wall / asteroid / rocks
      let dead = false;
      for (const wall of walls) {
        if (pointInWall(pr.x, pr.y, wall, pr.r)) {
          dead = true;
          break;
        }
      }
      if (!dead && this.fragmentingAsteroids) {
        for (let ri = this.rocks.length - 1; ri >= 0; ri--) {
          const rock = this.rocks[ri];
          if (circleHit(pr.x, pr.y, pr.r, rock.x, rock.y, rock.radius)) {
            this.fragmentRock(rock, pr.vx * 0.15, pr.vy * 0.15);
            dead = true;
            break;
          }
        }
      } else if (!dead) {
        for (const a of asteroids) {
          if (circleHit(pr.x, pr.y, pr.r, a.x, a.y, a.radius)) {
            dead = true;
            break;
          }
        }
        // Path movers stop projectiles too
        if (!dead) {
          for (const m of this.movingObjects) {
            if (circleHit(pr.x, pr.y, pr.r, m.x, m.y, m.radius || 22)) {
              dead = true;
              break;
            }
          }
        }
      }
      if (dead) {
        this.projectiles.splice(i, 1);
        continue;
      }

      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (p.id === pr.ownerId) continue;
        if (this.mode === 'teams' && pr.team === p.team && pr.team >= 0) continue;
        if (!circleHit(pr.x, pr.y, pr.r, p.x, p.y, SHIP.radius)) continue;
        if (p.shieldActive || p.invuln > 0) {
          this.projectiles.splice(i, 1);
          this.pushEvent({ type: 'shield_hit', x: p.x, y: p.y, id: p.id });
          dead = true;
          break;
        }
        if (pr.type === 'photon') {
          this.killShip(p, pr.ownerId);
          this.projectiles.splice(i, 1);
          dead = true;
          break;
        } else {
          p.laserHits++;
          this.pushEvent({ type: 'laser_hit', x: p.x, y: p.y, id: p.id, hits: p.laserHits });
          if (p.laserHits >= SHIP.laserHitsToKill) {
            this.killShip(p, pr.ownerId);
          }
          this.projectiles.splice(i, 1);
          dead = true;
          break;
        }
      }
    }
  }

  broadcastSnapshot() {
    if (this.phase !== 'playing') return;
    const events = this.events;
    this.events = [];
    const snap = {
      t: this.tick,
      matchTime: this.matchTime,
      ships: [],
      projectiles: this.projectiles.map((pr) => ({
        id: pr.id,
        type: pr.type,
        x: pr.x,
        y: pr.y,
        vx: pr.vx,
        vy: pr.vy,
        color: pr.color,
      })),
      movers: this.movingObjects.map((m) => ({
        id: m.id,
        x: m.x,
        y: m.y,
        radius: m.radius || 28,
        angle: m.angle || 0,
        seed: m.seed || 0,
      })),
      rocks: this.rocks.map((r) => ({
        id: r.id,
        x: r.x,
        y: r.y,
        radius: r.radius,
        angle: r.angle,
        seed: r.seed,
        gen: r.gen,
      })),
      fragmentingAsteroids: this.fragmentingAsteroids,
      events,
      aliveCount: [...this.players.values()].filter((p) => p.alive).length,
      trainingGrace:
        this.mode === 'training' ? Math.max(0, TRAINING_GRACE_SEC - this.matchTime) : 0,
      nukes: this.nukes.map((n) => ({
        id: n.id,
        x: n.x,
        y: n.y,
        radius: n.radius,
        maxRadius: n.maxRadius,
        color: n.color,
      })),
      epilogue: this.trainingEpilogue
        ? {
            remaining: this.trainingEpilogue.t,
            kind: 'defeat',
            message: 'Better Luck Next Time, Starfighter!',
            lines: ['BETTER LUCK NEXT TIME,', 'STARFIGHTER!'],
          }
        : this.matchEpilogue
          ? {
              remaining: this.matchEpilogue.t,
              kind: this.matchEpilogue.kind,
              winnerId: this.matchEpilogue.winnerId,
              winnerTeam: this.matchEpilogue.winnerTeam,
              lines:
                this.matchEpilogue.kind === 'draw'
                  ? ['DRAW']
                  : ['VICTORY IS YOURS!'],
            }
          : null,
    };
    for (const p of this.players.values()) {
      snap.ships.push({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        angle: p.angle,
        color: p.color,
        team: p.team,
        alive: p.alive,
        thrusting: p.thrusting,
        shieldActive: p.shieldActive,
        laserHits: p.laserHits,
        invuln: p.invuln > 0,
        cooldowns: { ...p.cooldowns },
        kills: p.kills,
      });
    }
    this.emitAll('snapshot', snap);
  }

  emitAll(event, data) {
    for (const p of this.players.values()) {
      if (p.socket && !p.isBot) p.socket.emit(event, data);
    }
  }

  playerList() {
    return [...this.players.values()].map(publicPlayer);
  }

  publicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      mode: this.mode,
      teamCount: this.teamCount,
      isPublic: this.isPublic,
      fragmentingAsteroids: this.fragmentingAsteroids,
      players: this.playerList(),
      map: this.map,
      winner: this.winner,
      winnerTeam: this.winnerTeam,
      maxPlayers: MAX_PLAYERS,
      teamNames: TEAM_NAMES,
      teamColors: TEAM_COLORS,
    };
  }
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    team: p.team,
    ready: p.ready,
    alive: p.alive,
    spectator: p.spectator,
    kills: p.kills,
    deaths: p.deaths,
    isBot: !!p.isBot,
  };
}

function defaultMap() {
  return {
    wells: [
      {
        id: 'sun1',
        x: ARENA_W / 2,
        y: ARENA_H / 2,
        radius: 80,
        strength: 1.5,
        style: 'sun',
        killRadius: 32,
      },
    ],
    asteroids: [
      { id: 'a1', x: 800, y: 600, radius: 40 },
      { id: 'a2', x: 2400, y: 1800, radius: 55 },
      { id: 'a3', x: 2000, y: 700, radius: 30 },
    ],
    walls: [],
    movers: [
      {
        id: 'ma1',
        x: 1100,
        y: 1400,
        radius: 32,
        amp: 140,
        speed: 0.9,
        pattern: 'circle',
      },
    ],
    wormholes: [],
  };
}

function normalizeMap(map) {
  if (!map || typeof map !== 'object') return defaultMap();
  const wells = Array.isArray(map.wells) ? map.wells.slice(0, 3) : [];
  return {
    wells: wells.map((w, i) => ({
      id: w.id || `w${i}`,
      x: clamp(w.x, 0, ARENA_W),
      y: clamp(w.y, 0, ARENA_H),
      radius: clamp(w.radius ?? 60, 20, 150),
      strength: clamp(w.strength ?? 1.5, -4, 4),
      style: w.style === 'blackhole' ? 'blackhole' : 'sun',
      killRadius: w.style === 'blackhole' ? clamp(w.radius ?? 60, 20, 150) * 0.35 : (w.radius ?? 60) * 0.4,
    })),
    asteroids: (map.asteroids || []).slice(0, 30).map((a, i) => ({
      id: a.id || `ast${i}`,
      x: clamp(a.x, 0, ARENA_W),
      y: clamp(a.y, 0, ARENA_H),
      radius: clamp(a.radius ?? 35, 15, 80),
    })),
    // Walls removed from map builder — ignore any legacy wall data
    walls: [],
    movers: (map.movers || []).slice(0, 10).map((m, i) => ({
      id: m.id || `mov${i}`,
      x: clamp(m.x, 0, ARENA_W),
      y: clamp(m.y, 0, ARENA_H),
      radius: clamp(m.radius ?? 30, 16, 55),
      amp: clamp(m.amp ?? 100, 40, 250),
      speed: clamp(m.speed ?? 1, 0.3, 3),
      pattern: m.pattern === 'circle' ? 'circle' : 'line',
    })),
    wormholes: (map.wormholes || []).slice(0, 6).map((w, i) => ({
      id: w.id || `wh${i}`,
      x: clamp(w.x, 0, ARENA_W),
      y: clamp(w.y, 0, ARENA_H),
      radius: 28,
    })),
  };
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, Number(v) || 0));
}
