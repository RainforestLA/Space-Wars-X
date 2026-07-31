/**
 * Training-mode AI opponent for Space Wars X
 * Uses same ship controls as humans: rotate, thrust, photon/laser/shield/hyperspace.
 */

import { SHIP } from '../../shared/constants.js';
import { wrapDelta, distSq } from '../../shared/physics.js';

function angleDiff(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function leadAim(bot, target, projSpeed) {
  const { dx, dy } = wrapDelta(bot.x, bot.y, target.x, target.y);
  // Simple lead: assume constant target velocity
  const dist = Math.hypot(dx, dy) || 1;
  const t = dist / projSpeed;
  const lx = dx + target.vx * t * 0.85;
  const ly = dy + target.vy * t * 0.85;
  return Math.atan2(ly, lx);
}

export const TRAINING_GRACE_SEC = 30;

/**
 * @param {object} bot - player ship (isBot)
 * @param {object[]} humans - living human enemies
 * @param {object} map - room map (wells, asteroids, …)
 * @param {object[]} projectiles
 * @param {object} room - Room instance for handleAction
 * @param {number} dt
 * @param {number} matchTime - seconds since match start
 */
export function updateBot(bot, humans, map, projectiles, room, dt, matchTime = 0) {
  if (!bot.alive || bot.spectator) return;

  bot._ai = bot._ai || {
    think: 0,
    mode: 'engage', // engage | flee | orbit | wait
    strafe: 1,
    nextPhoton: 0,
  };
  const ai = bot._ai;
  ai.think -= dt;

  const wells = map.wells || [];
  const grace = matchTime < TRAINING_GRACE_SEC;
  const target = pickTarget(bot, humans, grace /* allow targeting dead? no */);
  const nearWell = nearestWellDanger(bot, wells);

  // Always escape gravity wells
  if (nearWell && nearWell.dist < nearWell.w.radius * 3.2) {
    const away = Math.atan2(-nearWell.dy, -nearWell.dx);
    turnToward(bot, away);
    bot.thrusting = true;
    if (!grace && nearWell.dist < nearWell.w.radius * 1.4 && bot.cooldowns.hyperspace <= 0) {
      room.handleAction(bot, 'hyperspace');
    }
    return;
  }

  // Avoid asteroids
  for (const a of map.asteroids || []) {
    const ad = wrapDelta(bot.x, bot.y, a.x, a.y);
    const adist = Math.hypot(ad.dx, ad.dy);
    if (adist < (a.radius || 30) + 70) {
      turnToward(bot, Math.atan2(-ad.dy, -ad.dx));
      bot.thrusting = true;
      return;
    }
  }

  // --- 30s grace: passive patrol, no weapons, keep distance ---
  if (grace) {
    if (!target) {
      bot.rotating = 0;
      bot.thrusting = Math.random() < 0.15;
      return;
    }
    const { dx, dy } = wrapDelta(bot.x, bot.y, target.x, target.y);
    const dist = Math.hypot(dx, dy) || 1;
    const toTarget = Math.atan2(dy, dx);
    // Hold medium range, slowly circle
    if (ai.think <= 0) {
      ai.think = 0.5 + Math.random() * 0.5;
      if (Math.random() < 0.4) ai.strafe *= -1;
    }
    let desired;
    if (dist < 350) {
      desired = toTarget + Math.PI + ai.strafe * 0.5;
      bot.thrusting = true;
    } else if (dist > 700) {
      desired = toTarget + ai.strafe * 0.3;
      bot.thrusting = Math.hypot(bot.vx, bot.vy) < 100;
    } else {
      desired = toTarget + ai.strafe * (Math.PI / 2) * 0.9;
      bot.thrusting = Math.random() < 0.35;
    }
    turnToward(bot, desired);
    // Shield only if player shoots during grace
    const threat = nearestHostileProjectile(bot, projectiles);
    if (threat && threat.dist < 160 && bot.cooldowns.shield <= 0 && !bot.shieldActive) {
      room.handleAction(bot, 'shield');
    }
    return;
  }

  if (!target) {
    bot.rotating = 0;
    bot.thrusting = false;
    return;
  }

  const { dx, dy } = wrapDelta(bot.x, bot.y, target.x, target.y);
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);

  const threat = nearestHostileProjectile(bot, projectiles);

  // --- Defensive: shield ---
  if (threat && threat.dist < 160 && bot.cooldowns.shield <= 0 && !bot.shieldActive) {
    room.handleAction(bot, 'shield');
  }

  // --- Combat range logic ---
  if (ai.think <= 0) {
    ai.think = 0.25 + Math.random() * 0.35;
    if (dist < 180) ai.mode = 'flee';
    else if (dist > 520) ai.mode = 'engage';
    else ai.mode = Math.random() < 0.55 ? 'orbit' : 'engage';
    if (Math.random() < 0.3) ai.strafe *= -1;
  }

  let desiredAngle = toTarget;

  if (ai.mode === 'flee') {
    desiredAngle = toTarget + Math.PI + ai.strafe * 0.4;
    bot.thrusting = true;
  } else if (ai.mode === 'orbit') {
    desiredAngle = toTarget + ai.strafe * (Math.PI / 2) * 0.85;
    bot.thrusting = dist > 220;
  } else {
    desiredAngle = leadAim(bot, target, 700);
    const closing = bot.vx * (dx / dist) + bot.vy * (dy / dist);
    bot.thrusting = dist > 280 || Math.hypot(bot.vx, bot.vy) < 90 || closing < -40;
  }

  turnToward(bot, desiredAngle);

  const aimLaser = leadAim(bot, target, 900);
  const aimPhoton = leadAim(bot, target, 520);
  const faceLaser = Math.abs(angleDiff(bot.angle, aimLaser));
  const facePhoton = Math.abs(angleDiff(bot.angle, aimPhoton));

  if (faceLaser < 0.28 && dist < 700 && dist > 60 && bot.cooldowns.laser <= 0) {
    if (Math.random() < 0.55) room.handleAction(bot, 'laser');
  }

  if (
    facePhoton < 0.2 &&
    dist < 550 &&
    dist > 100 &&
    bot.cooldowns.photon <= 0 &&
    (target.laserHits >= 1 || dist < 350 || Math.random() < 0.25)
  ) {
    room.handleAction(bot, 'photon');
  }

  if (
    bot.laserHits >= 2 &&
    threat &&
    threat.dist < 220 &&
    bot.cooldowns.hyperspace <= 0 &&
    Math.random() < 0.4
  ) {
    room.handleAction(bot, 'hyperspace');
  }
}

function turnToward(bot, desiredAngle) {
  const diff = angleDiff(bot.angle, desiredAngle);
  const dead = 0.08;
  if (diff > dead) bot.rotating = 1;
  else if (diff < -dead) bot.rotating = -1;
  else bot.rotating = 0;
}

function pickTarget(bot, humans) {
  let best = null;
  let bestD = Infinity;
  for (const h of humans) {
    if (!h.alive) continue;
    const d = distSq(bot.x, bot.y, h.x, h.y);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/** Prefer living humans; during epilogue none alive — return null */
export function livingHumans(players) {
  return [...players.values()].filter((p) => !p.isBot && p.alive);
}

function nearestHostileProjectile(bot, projectiles) {
  let best = null;
  for (const pr of projectiles) {
    if (pr.ownerId === bot.id) continue;
    const { dx, dy } = wrapDelta(bot.x, bot.y, pr.x, pr.y);
    const dist = Math.hypot(dx, dy);
    // Closing on us?
    const rel = pr.vx * (-dx) + pr.vy * (-dy); // rough
    if (dist < 280 && rel > -50) {
      if (!best || dist < best.dist) best = { dist, pr };
    }
  }
  return best;
}

function nearestWellDanger(bot, wells) {
  let best = null;
  for (const w of wells) {
    if ((w.strength ?? 1) <= 0) continue; // ignore repulsors for flee
    const { dx, dy } = wrapDelta(bot.x, bot.y, w.x, w.y);
    const dist = Math.hypot(dx, dy);
    if (!best || dist < best.dist) best = { dist, dx, dy, w };
  }
  return best;
}

export function createBotPlayer() {
  return {
    id: 'bot_' + Math.random().toString(36).slice(2, 9),
    name: 'Training Drone',
    socket: null,
    isBot: true,
    color: '#f97316',
    colorIndex: 13,
    team: -1,
    ready: true,
    alive: true,
    spectator: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    thrusting: false,
    rotating: 0,
    laserHits: 0,
    shieldActive: false,
    shieldTimer: 0,
    invuln: 0,
    cooldowns: { photon: 0, laser: 0, shield: 0, hyperspace: 0, nuke: 0 },
    wormholeCooldown: 0,
    inputSeq: 0,
    kills: 0,
    deaths: 0,
    _ai: null,
  };
}
