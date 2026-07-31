/** Shared physics helpers */

import { ARENA_W, ARENA_H, SHIP, GRAVITY_CONSTANT } from './constants.js';

export function wrapPos(x, y) {
  let nx = x;
  let ny = y;
  if (nx < 0) nx += ARENA_W;
  else if (nx >= ARENA_W) nx -= ARENA_W;
  if (ny < 0) ny += ARENA_H;
  else if (ny >= ARENA_H) ny -= ARENA_H;
  return { x: nx, y: ny };
}

/** Toroidal shortest delta */
export function wrapDelta(ax, ay, bx, by) {
  let dx = bx - ax;
  let dy = by - ay;
  if (dx > ARENA_W / 2) dx -= ARENA_W;
  if (dx < -ARENA_W / 2) dx += ARENA_W;
  if (dy > ARENA_H / 2) dy -= ARENA_H;
  if (dy < -ARENA_H / 2) dy += ARENA_H;
  return { dx, dy };
}

export function distSq(ax, ay, bx, by) {
  const { dx, dy } = wrapDelta(ax, ay, bx, by);
  return dx * dx + dy * dy;
}

export function applyGravity(entity, wells, dt, affect = true) {
  if (!affect) return;
  for (const w of wells) {
    // Vector from entity toward well center
    const { dx, dy } = wrapDelta(entity.x, entity.y, w.x, w.y);
    const d2 = dx * dx + dy * dy;
    // Soft floor so force doesn't explode at the core (kill zone still handles death)
    const minD = Math.max(w.radius * 0.55, 48);
    const d = Math.sqrt(d2);
    if (d < 1e-3) continue;
    // strength > 0 attracts, < 0 repels — strong pull: full thrusters needed to escape
    const pull = w.strength ?? 1;
    const f = (Math.abs(pull) * GRAVITY_CONSTANT) / Math.max(d2, minD * minD);
    const dir = pull >= 0 ? 1 : -1;
    entity.vx += (dx / d) * f * dir * dt;
    entity.vy += (dy / d) * f * dir * dt;
  }
}

export function clampSpeed(entity, maxSpeed) {
  const sp = Math.hypot(entity.vx, entity.vy);
  if (sp > maxSpeed) {
    entity.vx = (entity.vx / sp) * maxSpeed;
    entity.vy = (entity.vy / sp) * maxSpeed;
  }
}

export function integrate(entity, dt, drag = 0) {
  if (drag > 0) {
    const f = Math.max(0, 1 - drag * dt);
    entity.vx *= f;
    entity.vy *= f;
  }
  entity.x += entity.vx * dt;
  entity.y += entity.vy * dt;
  const p = wrapPos(entity.x, entity.y);
  entity.x = p.x;
  entity.y = p.y;
}

export function circleHit(ax, ay, ar, bx, by, br) {
  return distSq(ax, ay, bx, by) <= (ar + br) * (ar + br);
}

/**
 * Distance along segment A→B where it first hits circle (cx,cy,r), or null if none.
 * Uses toroidal-unwrapped B relative to A via wrapDelta from A to B and A to C.
 */
export function rayHitCircle(ax, ay, bx, by, cx, cy, r) {
  const { dx: ex, dy: ey } = wrapDelta(ax, ay, bx, by);
  const { dx: fx, dy: fy } = wrapDelta(ax, ay, cx, cy);
  const elen2 = ex * ex + ey * ey;
  if (elen2 < 1e-8) return Math.hypot(fx, fy) <= r ? 0 : null;
  let t = (fx * ex + fy * ey) / elen2;
  t = Math.max(0, Math.min(1, t));
  const px = t * ex;
  const py = t * ey;
  const dist = Math.hypot(fx - px, fy - py);
  if (dist > r) return null;
  // Approximate entry distance along ray
  const along = Math.hypot(px, py);
  return along;
}

export function randomSpawn(wells, walls, asteroids, margin = 80) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = margin + Math.random() * (ARENA_W - margin * 2);
    const y = margin + Math.random() * (ARENA_H - margin * 2);
    let ok = true;
    for (const w of wells || []) {
      if (distSq(x, y, w.x, w.y) < (w.radius + 100) ** 2) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const a of asteroids || []) {
      if (distSq(x, y, a.x, a.y) < (a.radius + 40) ** 2) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const wall of walls || []) {
      if (pointInWall(x, y, wall, 40)) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, y, angle: Math.random() * Math.PI * 2 };
  }
  return {
    x: ARENA_W / 2 + (Math.random() - 0.5) * 400,
    y: ARENA_H / 2 + (Math.random() - 0.5) * 400,
    angle: Math.random() * Math.PI * 2,
  };
}

export function pointInWall(x, y, wall, pad = 0) {
  // wall: { x, y, w, h, angle }
  const { dx, dy } = wrapDelta(wall.x, wall.y, x, y);
  const c = Math.cos(-wall.angle || 0);
  const s = Math.sin(-wall.angle || 0);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  const hw = wall.w / 2 + pad;
  const hh = wall.h / 2 + pad;
  return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}

export function resolveWallCollision(entity, wall, radius) {
  const { dx, dy } = wrapDelta(wall.x, wall.y, entity.x, entity.y);
  const c = Math.cos(-wall.angle || 0);
  const s = Math.sin(-wall.angle || 0);
  let lx = dx * c - dy * s;
  let ly = dx * s + dy * c;
  const hw = wall.w / 2 + radius;
  const hh = wall.h / 2 + radius;
  if (Math.abs(lx) > hw || Math.abs(ly) > hh) return false;

  // Push out along smallest penetration
  const penX = hw - Math.abs(lx);
  const penY = hh - Math.abs(ly);
  if (penX < penY) {
    lx = Math.sign(lx || 1) * hw;
    // reflect velocity in local space
    const lvx = entity.vx * c - entity.vy * s;
    const lvy = entity.vx * s + entity.vy * c;
    const nlx = -lvx * 0.6;
    const nly = lvy * 0.6;
    entity.vx = nlx * c + nly * s;
    entity.vy = -nlx * s + nly * c;
  } else {
    ly = Math.sign(ly || 1) * hh;
    const lvx = entity.vx * c - entity.vy * s;
    const lvy = entity.vx * s + entity.vy * c;
    const nlx = lvx * 0.6;
    const nly = -lvy * 0.6;
    entity.vx = nlx * c + nly * s;
    entity.vy = -nlx * s + nly * c;
  }
  // world position
  const wx = lx * c + ly * s;
  const wy = -lx * s + ly * c;
  entity.x = wall.x + wx;
  entity.y = wall.y + wy;
  const p = wrapPos(entity.x, entity.y);
  entity.x = p.x;
  entity.y = p.y;
  return true;
}

export { SHIP };
