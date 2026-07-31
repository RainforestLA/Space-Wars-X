/** Canvas renderer — vector ships, glow, starfield */

import { ARENA_W, ARENA_H, SHIP } from '../../shared/constants.js';
import { wrapDelta } from '../../shared/physics.js';

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let w = 0;
  let h = 0;
  let dpr = 1;
  const stars = [];
  for (let i = 0; i < 180; i++) {
    stars.push({
      x: Math.random() * ARENA_W,
      y: Math.random() * ARENA_H,
      r: Math.random() * 1.4 + 0.3,
      a: Math.random() * 0.5 + 0.25,
    });
  }

  const particles = [];
  /** Classic Asteroids-style line debris from destroyed ships */
  const debris = [];
  /** Wormhole jump ghost trails */
  const jumpTrails = [];
  let cam = { x: ARENA_W / 2, y: ARENA_H / 2 };
  let camTarget = { x: cam.x, y: cam.y };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Prefer layout size; fall back when parent was display:none (0×0) on first paint
    const parent = canvas.parentElement;
    let cw = canvas.clientWidth || parent?.clientWidth || 0;
    let ch = canvas.clientHeight || parent?.clientHeight || 0;
    if (cw < 2 || ch < 2) {
      cw = window.innerWidth || document.documentElement.clientWidth || 800;
      ch = window.innerHeight || document.documentElement.clientHeight || 600;
    }
    w = cw;
    h = ch;
    // CSS size so the bitmap maps 1:1 to the viewport
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const bw = Math.max(1, Math.floor(w * dpr));
    const bh = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** True when canvas has a usable draw size */
  function isReady() {
    return w >= 2 && h >= 2;
  }

  function setCamera(x, y, instant = false) {
    camTarget.x = x;
    camTarget.y = y;
    if (instant) {
      cam.x = x;
      cam.y = y;
    }
  }

  function updateCam(dt) {
    // Smooth cam with toroidal-aware lerp is hard — simple lerp for local play
    const k = 1 - Math.pow(0.001, dt);
    let dx = camTarget.x - cam.x;
    let dy = camTarget.y - cam.y;
    if (dx > ARENA_W / 2) dx -= ARENA_W;
    if (dx < -ARENA_W / 2) dx += ARENA_W;
    if (dy > ARENA_H / 2) dy -= ARENA_H;
    if (dy < -ARENA_H / 2) dy += ARENA_H;
    cam.x += dx * Math.min(1, k * 8);
    cam.y += dy * Math.min(1, k * 8);
    if (cam.x < 0) cam.x += ARENA_W;
    if (cam.x >= ARENA_W) cam.x -= ARENA_W;
    if (cam.y < 0) cam.y += ARENA_H;
    if (cam.y >= ARENA_H) cam.y -= ARENA_H;
  }

  function worldToScreen(x, y) {
    let dx = x - cam.x;
    let dy = y - cam.y;
    if (dx > ARENA_W / 2) dx -= ARENA_W;
    if (dx < -ARENA_W / 2) dx += ARENA_W;
    if (dy > ARENA_H / 2) dy -= ARENA_H;
    if (dy < -ARENA_H / 2) dy += ARENA_H;
    return { x: w / 2 + dx, y: h / 2 + dy };
  }

  function addParticles(x, y, color, n = 12, speed = 120) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = Math.random() * speed;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.4 + Math.random() * 0.5,
        max: 0.9,
        color,
        r: 1.5 + Math.random() * 2,
      });
    }
  }

  function addThrust(x, y, angle, color) {
    const back = angle + Math.PI;
    for (let i = 0; i < 2; i++) {
      const spread = (Math.random() - 0.5) * 0.6;
      const a = back + spread;
      const sp = 80 + Math.random() * 60;
      particles.push({
        x: x + Math.cos(back) * 12,
        y: y + Math.sin(back) * 12,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.15 + Math.random() * 0.1,
        max: 0.25,
        color: color || '#fbbf24',
        r: 1.5,
      });
    }
  }

  function handleEvents(events) {
    if (!events) return;
    for (const e of events) {
      if (e.type === 'explode') {
        addParticles(e.x, e.y, e.color || '#fff', 22, 200);
        if (e.breakup !== false) spawnShipBreakup(e);
      }
      if (e.type === 'laser_hit') addParticles(e.x, e.y, '#f472b6', 6, 80);
      if (e.type === 'shield_hit') addParticles(e.x, e.y, '#60a5fa', 8, 60);
      if (e.type === 'hyperspace_out' || e.type === 'hyperspace_in')
        addParticles(e.x, e.y, '#a78bfa', 16, 150);
      if (e.type === 'wormhole') addParticles(e.x, e.y, '#22d3ee', 10, 90);
      if (e.type === 'wormhole_jump') spawnWormholeTrail(e);
      if (e.type === 'rock_break') {
        addParticles(e.x, e.y, e.color || '#c4b5a0', 10 + Math.min(12, (e.radius || 20) / 4), 100);
      }
    }
  }

  /** Classic Asteroids: ship outline splits into tumbling line segments */
  function spawnShipBreakup(e) {
    const ang = e.angle || 0;
    const col = e.color || '#fff';
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    // Local ship wedge points (same as drawShip)
    const pts = [
      [16, 0],
      [-12, 10],
      [-6, 0],
      [-12, -10],
    ];
    const world = pts.map(([lx, ly]) => ({
      x: e.x + lx * cos - ly * sin,
      y: e.y + lx * sin + ly * cos,
    }));
    // Edges of the wedge
    const edges = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [0, 2], // extra crack through center
    ];
    for (const [i, j] of edges) {
      const ax = world[i].x;
      const ay = world[i].y;
      const bx = world[j].x;
      const by = world[j].y;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const { dx, dy } = wrapDelta(e.x, e.y, mx, my);
      const d = Math.hypot(dx, dy) || 1;
      const push = 40 + Math.random() * 90;
      debris.push({
        x1: ax - e.x,
        y1: ay - e.y,
        x2: bx - e.x,
        y2: by - e.y,
        x: e.x,
        y: e.y,
        vx: (e.vx || 0) * 0.4 + (dx / d) * push + (Math.random() - 0.5) * 40,
        vy: (e.vy || 0) * 0.4 + (dy / d) * push + (Math.random() - 0.5) * 40,
        spin: (Math.random() - 0.5) * 8,
        rot: 0,
        life: 1.4 + Math.random() * 0.8,
        max: 2.2,
        color: col,
      });
    }
    // Extra floating fragments
    for (let k = 0; k < 4; k++) {
      const a = Math.random() * Math.PI * 2;
      const len = 4 + Math.random() * 8;
      debris.push({
        x1: -len / 2,
        y1: 0,
        x2: len / 2,
        y2: 0,
        x: e.x,
        y: e.y,
        vx: (e.vx || 0) * 0.3 + Math.cos(a) * (50 + Math.random() * 100),
        vy: (e.vy || 0) * 0.3 + Math.sin(a) * (50 + Math.random() * 100),
        spin: (Math.random() - 0.5) * 10,
        rot: a,
        life: 1.0 + Math.random() * 0.6,
        max: 1.8,
        color: col,
      });
    }
  }

  /**
   * Super-fast trailing path connecting entrance → exit wormhole
   * (actual toroidal shortest path of travel).
   * Returns path info so the game can follow the camera along it.
   */
  function spawnWormholeTrail(e) {
    const { dx, dy } = wrapDelta(e.fromX, e.fromY, e.toX, e.toY);
    const dist = Math.hypot(dx, dy) || 1;
    const steps = Math.min(48, Math.max(18, Math.floor(dist / 28)));
    const duration = Math.min(0.55, Math.max(0.28, dist / 2800));
    const trail = {
      fromX: e.fromX,
      fromY: e.fromY,
      toX: e.toX,
      toY: e.toY,
      dx,
      dy,
      dist,
      angle: Math.atan2(dy, dx),
      color: e.color || '#22d3ee',
      life: duration + 0.2,
      max: duration + 0.2,
      duration,
      age: 0,
      steps,
      id: e.id,
    };
    jumpTrails.push(trail);
    addParticles(e.fromX, e.fromY, e.color || '#22d3ee', 14, 180);
    addParticles(e.toX, e.toY, e.color || '#22d3ee', 18, 200);
    return trail;
  }

  /** World position along a jump trail at normalized u in [0,1] */
  function trailWorldAt(trail, u) {
    u = Math.max(0, Math.min(1, u));
    let x = trail.fromX + trail.dx * u;
    let y = trail.fromY + trail.dy * u;
    if (x < 0) x += ARENA_W;
    if (x >= ARENA_W) x -= ARENA_W;
    if (y < 0) y += ARENA_H;
    if (y >= ARENA_H) y -= ARENA_H;
    return { x, y };
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        debris.splice(i, 1);
        continue;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += d.spin * dt;
      d.vx *= 1 - 0.15 * dt;
      d.vy *= 1 - 0.15 * dt;
    }
    for (let i = jumpTrails.length - 1; i >= 0; i--) {
      jumpTrails[i].life -= dt;
      jumpTrails[i].age = (jumpTrails[i].age || 0) + dt;
      if (jumpTrails[i].life <= 0) jumpTrails.splice(i, 1);
    }
  }

  function drawDebris() {
    for (const d of debris) {
      const s = worldToScreen(d.x, d.y);
      if (s.x < -100 || s.x > w + 100 || s.y < -100 || s.y > h + 100) continue;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(d.rot);
      ctx.globalAlpha = Math.max(0, d.life / d.max);
      ctx.strokeStyle = d.color;
      ctx.shadowColor = d.color;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(d.x1, d.y1);
      ctx.lineTo(d.x2, d.y2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawJumpTrails() {
    for (const t of jumpTrails) {
      const travelU = Math.min(1, (t.age || 0) / (t.duration || 0.35));
      // Solid path of travel (entrance → exit) glowing under ghosts
      const a = worldToScreen(t.fromX, t.fromY);
      const b = worldToScreen(t.fromX + t.dx, t.fromY + t.dy);
      ctx.save();
      ctx.globalAlpha = 0.55 * (t.life / t.max);
      ctx.strokeStyle = t.color;
      ctx.shadowColor = t.color;
      ctx.shadowBlur = 28;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // Outer glow path
      ctx.globalAlpha = 0.2 * (t.life / t.max);
      ctx.lineWidth = 14;
      ctx.stroke();
      ctx.restore();

      // Super-fast trailing ghost ships racing along the path
      for (let i = 0; i < t.steps; i++) {
        const u = i / (t.steps - 1);
        if (u > travelU + 0.02) continue;
        const lag = travelU - u;
        const fade = Math.max(0, 1 - lag * 3.2) * (t.life / t.max);
        if (fade < 0.05) continue;
        const wp = trailWorldAt(t, u);
        const s = worldToScreen(wp.x, wp.y);
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(t.angle);
        ctx.globalAlpha = fade * 0.9;
        ctx.strokeStyle = t.color;
        ctx.shadowColor = t.color;
        ctx.shadowBlur = 16;
        ctx.lineWidth = 1.6 + fade;
        ctx.beginPath();
        ctx.moveTo(14, 0);
        ctx.lineTo(-10, 8);
        ctx.lineTo(-5, 0);
        ctx.lineTo(-10, -8);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
      // Bright tip of the jump
      const tip = trailWorldAt(t, travelU);
      const ts = worldToScreen(tip.x, tip.y);
      ctx.save();
      ctx.globalAlpha = 0.95 * (t.life / t.max);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = t.color;
      ctx.shadowBlur = 24;
      ctx.beginPath();
      ctx.arc(ts.x, ts.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawNukes(nukes) {
    if (!nukes?.length) return;
    for (const n of nukes) {
      const s = worldToScreen(n.x, n.y);
      const r = n.radius || 0;
      if (r < 2) continue;
      // Cull if ring entirely off-screen (rough)
      if (s.x + r < -20 || s.x - r > w + 20 || s.y + r < -20 || s.y - r > h + 20) {
        // still may wrap; draw anyway if center near
      }
      const fade = 1 - r / (n.maxRadius || 600);
      ctx.save();
      ctx.strokeStyle = n.color || '#fbbf24';
      ctx.shadowColor = n.color || '#fbbf24';
      ctx.shadowBlur = 18;
      ctx.globalAlpha = 0.75 * Math.max(0.15, fade);
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      // Inner echo ring
      ctx.globalAlpha = 0.35 * Math.max(0.1, fade);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0, r - 14), 0, Math.PI * 2);
      ctx.stroke();
      // Soft fill band
      ctx.globalAlpha = 0.08 * fade;
      ctx.fillStyle = n.color || '#fbbf24';
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.arc(s.x, s.y, Math.max(0, r - 22), 0, Math.PI * 2, true);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawShip(ship, isYou) {
    const s = worldToScreen(ship.x, ship.y);
    // cull rough
    if (s.x < -80 || s.x > w + 80 || s.y < -80 || s.y > h + 80) return;

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(ship.angle);

    const alpha = 1 - (ship.laserHits || 0) * 0.28;
    const col = ship.color || '#5eead4';
    ctx.globalAlpha = Math.max(0.25, alpha);
    if (ship.invuln) ctx.globalAlpha *= 0.5 + 0.5 * Math.sin(performance.now() / 80);

    // glow
    ctx.shadowColor = col;
    ctx.shadowBlur = isYou ? 16 : 10;

    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    // classic wedge ship
    ctx.moveTo(16, 0);
    ctx.lineTo(-12, 10);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-12, -10);
    ctx.closePath();
    ctx.stroke();

    if (ship.thrusting) {
      ctx.strokeStyle = '#fbbf24';
      ctx.shadowColor = '#fbbf24';
      const flicker = 8 + Math.random() * 6;
      ctx.beginPath();
      ctx.moveTo(-6, 0);
      ctx.lineTo(-6 - flicker, 4);
      ctx.lineTo(-8, 0);
      ctx.lineTo(-6 - flicker, -4);
      ctx.closePath();
      ctx.stroke();
    }

    // shield bubble
    if (ship.shieldActive) {
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = '#60a5fa';
      ctx.shadowColor = '#3b82f6';
      ctx.shadowBlur = 20;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, SHIP.radius + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = '#3b82f6';
      ctx.fill();
    }

    ctx.restore();

    // name
    if (!ship.alive) return;
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = col;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ship.name || '', s.x, s.y + 28);
    ctx.restore();
  }

  function drawProjectile(pr) {
    const s = worldToScreen(pr.x, pr.y);
    if (s.x < -40 || s.x > w + 40 || s.y < -40 || s.y > h + 40) return;
    ctx.save();
    ctx.translate(s.x, s.y);
    if (pr.type === 'photon') {
      // Double-size blue photon + lens flare (Star Trek energy torpedo look)
      const r = 9;
      const pulse = 0.85 + 0.15 * Math.sin(performance.now() / 40 + (pr.id?.length || 0));
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.2);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.15, '#b8e0ff');
      g.addColorStop(0.4, pr.color || '#3b9eff');
      g.addColorStop(0.75, 'rgba(30, 100, 255, 0.45)');
      g.addColorStop(1, 'transparent');
      ctx.shadowColor = '#3b9eff';
      ctx.shadowBlur = 28 * pulse;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
      // Hot core
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#e0f2ff';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
      // Lens flare spikes
      ctx.globalAlpha = 0.55 * pulse;
      ctx.strokeStyle = '#9fd4ff';
      ctx.lineWidth = 1.5;
      const flare = r * 3.5;
      ctx.beginPath();
      ctx.moveTo(-flare, 0);
      ctx.lineTo(flare, 0);
      ctx.moveTo(0, -flare * 0.65);
      ctx.lineTo(0, flare * 0.65);
      ctx.moveTo(-flare * 0.55, -flare * 0.45);
      ctx.lineTo(flare * 0.55, flare * 0.45);
      ctx.moveTo(-flare * 0.55, flare * 0.45);
      ctx.lineTo(flare * 0.55, -flare * 0.45);
      ctx.stroke();
      // Soft flare discs
      ctx.globalAlpha = 0.2 * pulse;
      ctx.fillStyle = '#60a5fa';
      ctx.beginPath();
      ctx.arc(flare * 0.55, 0, r * 0.45, 0, Math.PI * 2);
      ctx.arc(-flare * 0.4, 0, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      // Red laser bolts with dynamic shading
      const ang = Math.atan2(pr.vy, pr.vx);
      ctx.rotate(ang);
      const flicker = 0.75 + 0.25 * Math.sin(performance.now() / 25 + (pr.x || 0));
      const grad = ctx.createLinearGradient(-12, 0, 14, 0);
      grad.addColorStop(0, 'rgba(80, 0, 0, 0)');
      grad.addColorStop(0.2, `rgba(255, 40, 40, ${0.35 * flicker})`);
      grad.addColorStop(0.5, `rgba(255, 220, 220, ${0.95 * flicker})`);
      grad.addColorStop(0.75, `rgba(255, 30, 30, ${0.9 * flicker})`);
      grad.addColorStop(1, 'rgba(120, 0, 0, 0)');
      ctx.shadowColor = '#ff2020';
      ctx.shadowBlur = 16 * flicker;
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-11, 0);
      ctx.lineTo(13, 0);
      ctx.stroke();
      // Bright core line
      ctx.strokeStyle = `rgba(255, 245, 245, ${0.85 * flicker})`;
      ctx.lineWidth = 1.2;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(-6, 0);
      ctx.lineTo(10, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawWell(well) {
    const s = worldToScreen(well.x, well.y);
    if (s.x < -200 || s.x > w + 200 || s.y < -200 || s.y > h + 200) return;
    const r = well.radius;
    ctx.save();
    ctx.translate(s.x, s.y);
    if (well.style === 'blackhole') {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, '#000');
      g.addColorStop(0.5, '#1e1b4b');
      g.addColorStop(0.85, 'rgba(99, 102, 241, 0.4)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(129, 140, 248, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, '#fef08a');
      g.addColorStop(0.35, '#fbbf24');
      g.addColorStop(0.7, 'rgba(249, 115, 22, 0.5)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = 30;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // strength hint rings
    if (well.strength < 0) {
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.3)';
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(0, 0, r + 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawAsteroid(a) {
    const s = worldToScreen(a.x, a.y);
    if (s.x < -80 || s.x > w + 80 || s.y < -80 || s.y > h + 80) return;
    const seed = a.seed || 0;
    ctx.save();
    ctx.translate(s.x, s.y);
    if (a.angle) ctx.rotate(a.angle);
    ctx.strokeStyle = '#c4b5a0';
    ctx.fillStyle = 'rgba(100, 90, 75, 0.25)';
    ctx.shadowColor = '#a8a29e';
    ctx.shadowBlur = 6;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const n = 8;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const jitter = 0.72 + (((seed * 17 + i * 31) % 10) / 10) * 0.32;
      const rr = a.radius * jitter;
      const x = Math.cos(ang) * rr;
      const y = Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawWall(wall) {
    const s = worldToScreen(wall.x, wall.y);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(wall.angle || 0);
    ctx.strokeStyle = '#64748b';
    ctx.fillStyle = 'rgba(51, 65, 85, 0.6)';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#475569';
    ctx.shadowBlur = 8;
    ctx.fillRect(-wall.w / 2, -wall.h / 2, wall.w, wall.h);
    ctx.strokeRect(-wall.w / 2, -wall.h / 2, wall.w, wall.h);
    ctx.restore();
  }

  function drawWormhole(wh) {
    const s = worldToScreen(wh.x, wh.y);
    const t = performance.now() / 1000;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.strokeStyle = '#22d3ee';
    ctx.shadowColor = '#06b6d4';
    ctx.shadowBlur = 16;
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, 12 + i * 6, t + i, t + i + Math.PI * 1.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMover(m) {
    // Moving asteroid appearance
    const s = worldToScreen(m.x, m.y);
    if (s.x < -80 || s.x > w + 80 || s.y < -80 || s.y > h + 80) return;
    const r = m.radius || 28;
    const seed = m.seed || 0;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(m.angle || 0);
    ctx.strokeStyle = '#c4b5a0';
    ctx.fillStyle = 'rgba(100, 90, 75, 0.35)';
    ctx.shadowColor = '#a8a29e';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    const n = 9;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const jitter = 0.72 + (((seed * 17 + i * 31) % 10) / 10) * 0.35;
      const rr = r * jitter;
      const x = Math.cos(ang) * rr;
      const y = Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // crater dots
    ctx.fillStyle = 'rgba(60, 55, 48, 0.5)';
    ctx.beginPath();
    ctx.arc(r * 0.2, -r * 0.15, r * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-r * 0.25, r * 0.2, r * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      const s = worldToScreen(p.x, p.y);
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawMinimap(ships, map, youId) {
    const mw = 120;
    const mh = 90;
    const ox = w - mw - 12;
    const oy = 48;
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = 'rgba(10,14,23,0.8)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundRect(ctx, ox, oy, mw, mh, 8);
    ctx.fill();
    ctx.stroke();

    const sx = mw / ARENA_W;
    const sy = mh / ARENA_H;
    for (const well of map?.wells || []) {
      ctx.fillStyle = well.style === 'blackhole' ? '#6366f1' : '#f59e0b';
      ctx.beginPath();
      ctx.arc(ox + well.x * sx, oy + well.y * sy, Math.max(2, well.radius * sx * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const ship of ships || []) {
      if (!ship.alive) continue;
      ctx.fillStyle = ship.id === youId ? '#fff' : ship.color;
      ctx.beginPath();
      ctx.arc(ox + ship.x * sx, oy + ship.y * sy, ship.id === youId ? 2.5 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * 1980-style stroke vector letterforms (uppercase + punctuation).
   * Each glyph: array of polylines in unit box 0..1 x 0..1
   */
  const VECTOR_FONT = {
    A: [[[0, 1], [0.5, 0], [1, 1]], [[0.2, 0.55], [0.8, 0.55]]],
    B: [
      [[0, 0], [0, 1], [0.7, 1], [0.9, 0.85], [0.9, 0.6], [0.7, 0.5], [0.9, 0.4], [0.9, 0.15], [0.7, 0], [0, 0]],
      [[0, 0.5], [0.7, 0.5]],
    ],
    C: [[[0.95, 0.15], [0.7, 0], [0.2, 0], [0, 0.2], [0, 0.8], [0.2, 1], [0.7, 1], [0.95, 0.85]]],
    D: [[[0, 0], [0, 1], [0.65, 1], [0.95, 0.75], [0.95, 0.25], [0.65, 0], [0, 0]]],
    E: [[[1, 0], [0, 0], [0, 1], [1, 1]], [[0, 0.5], [0.75, 0.5]]],
    F: [[[1, 0], [0, 0], [0, 1]], [[0, 0.5], [0.7, 0.5]]],
    G: [[[0.95, 0.2], [0.7, 0], [0.25, 0], [0, 0.25], [0, 0.75], [0.25, 1], [0.75, 1], [1, 0.75], [1, 0.5], [0.55, 0.5]]],
    H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
    I: [[[0.2, 0], [0.8, 0]], [[0.5, 0], [0.5, 1]], [[0.2, 1], [0.8, 1]]],
    K: [[[0, 0], [0, 1]], [[1, 0], [0, 0.5], [1, 1]]],
    L: [[[0, 0], [0, 1], [1, 1]]],
    M: [[[0, 1], [0, 0], [0.5, 0.45], [1, 0], [1, 1]]],
    N: [[[0, 1], [0, 0], [1, 1], [1, 0]]],
    O: [[[0.25, 0], [0.75, 0], [1, 0.25], [1, 0.75], [0.75, 1], [0.25, 1], [0, 0.75], [0, 0.25], [0.25, 0]]],
    P: [[[0, 1], [0, 0], [0.75, 0], [1, 0.15], [1, 0.4], [0.75, 0.55], [0, 0.55]]],
    R: [[[0, 1], [0, 0], [0.75, 0], [1, 0.15], [1, 0.4], [0.75, 0.55], [0, 0.55]], [[0.45, 0.55], [1, 1]]],
    S: [[[0.95, 0.15], [0.7, 0], [0.25, 0], [0, 0.2], [0, 0.35], [0.2, 0.5], [0.8, 0.5], [1, 0.65], [1, 0.8], [0.75, 1], [0.25, 1], [0.05, 0.85]]],
    T: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]],
    U: [[[0, 0], [0, 0.75], [0.25, 1], [0.75, 1], [1, 0.75], [1, 0]]],
    V: [[[0, 0], [0.5, 1], [1, 0]]],
    W: [[[0, 0], [0.2, 1], [0.5, 0.4], [0.8, 1], [1, 0]]],
    X: [[[0, 0], [1, 1]], [[1, 0], [0, 1]]],
    Y: [[[0, 0], [0.5, 0.45], [1, 0]], [[0.5, 0.45], [0.5, 1]]],
    ' ': [],
    ',': [[[0.4, 0.85], [0.35, 1.05]]],
    '!': [[[0.5, 0], [0.5, 0.65]], [[0.5, 0.85], [0.5, 1]]],
    "'": [[[0.5, 0], [0.4, 0.25]]],
  };

  function drawVectorText(lines, opts = {}) {
    const color = opts.color || '#5eead4';
    const glow = opts.glow || '#2dd4bf';
    const maxW = opts.maxWidth || w * 0.92;
    const lineH = opts.lineHeight || Math.min(72, h * 0.12);
    const cx = opts.x ?? w / 2;
    const startY = opts.y ?? h * 0.38;
    const flicker = 0.85 + Math.sin(performance.now() / 90) * 0.08 + Math.random() * 0.04;

    ctx.save();
    // Dark vignette behind text
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, startY - lineH * 0.8, w, lines.length * lineH * 1.35 + lineH);

    lines.forEach((text, li) => {
      const chars = String(text).toUpperCase().split('');
      const gap = 0.18;
      const units = chars.reduce((acc, ch) => acc + (ch === ' ' ? 0.45 : 1 + gap), 0);
      let scale = lineH * 0.85;
      const totalW = units * scale;
      if (totalW > maxW) scale *= maxW / totalW;
      let x = cx - (units * scale) / 2;
      const y = startY + li * lineH * 1.15;

      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, scale * 0.06);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = glow;
      ctx.shadowBlur = 12 * flicker;
      ctx.globalAlpha = Math.min(1, flicker);

      for (const ch of chars) {
        if (ch === ' ') {
          x += scale * 0.45;
          continue;
        }
        const glyph = VECTOR_FONT[ch];
        if (!glyph) {
          x += scale * (1 + gap);
          continue;
        }
        for (const poly of glyph) {
          if (!poly.length) continue;
          ctx.beginPath();
          for (let i = 0; i < poly.length; i++) {
            const px = x + poly[i][0] * scale * 0.85;
            const py = y + poly[i][1] * scale;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        x += scale * (1 + gap);
      }
    });
    ctx.restore();
  }

  function render(frame) {
    const {
      map,
      ships = [],
      projectiles = [],
      movers = [],
      youId,
      dt = 1 / 60,
      epilogue = null,
      trainingGrace = 0,
    } = frame;

    // Recover if we started while the screen was hidden (0×0 canvas)
    if (!isReady() || canvas.width < 2 || canvas.height < 2) {
      resize();
    }

    updateCam(dt);
    updateParticles(dt);

    // background
    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, w, h);

    // stars
    for (const st of stars) {
      const s = worldToScreen(st.x, st.y);
      let sx = s.x;
      let sy = s.y;
      if (sx < -2 || sx > w + 2 || sy < -2 || sy > h + 2) continue;
      ctx.globalAlpha = st.a;
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(sx, sy, st.r, st.r);
    }
    ctx.globalAlpha = 1;

    if (map) {
      for (const well of map.wells || []) drawWell(well);
      // Static map asteroids only when not using dynamic fragmenting rocks
      if (!(frame.rocks && frame.rocks.length) && !frame.fragmentingAsteroids) {
        for (const a of map.asteroids || []) drawAsteroid(a);
      }
      for (const wall of map.walls || []) drawWall(wall);
      for (const wh of map.wormholes || []) drawWormhole(wh);
    }
    // Dynamic fragmenting rocks (Asteroids-style free floaters)
    for (const r of frame.rocks || []) {
      drawAsteroid({
        x: r.x,
        y: r.y,
        radius: r.radius,
        angle: r.angle,
        seed: r.seed,
      });
    }
    for (const m of movers) drawMover(m);

    for (const pr of projectiles) drawProjectile(pr);

    drawNukes(frame.nukes || []);

    for (const ship of ships) {
      if (ship.alive && ship.thrusting) addThrust(ship.x, ship.y, ship.angle, ship.color);
    }

    drawJumpTrails();
    drawParticles();
    drawDebris();

    for (const ship of ships) {
      if (!ship.alive) continue;
      drawShip(ship, ship.id === youId);
    }

    drawMinimap(ships, map, youId);

    // Training grace countdown (screen-space)
    if (trainingGrace > 0.05 && !epilogue) {
      const sec = Math.ceil(trainingGrace);
      ctx.save();
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
      ctx.shadowColor = '#fbbf24';
      ctx.shadowBlur = 8;
      ctx.fillText(`DRONE HOLDS FIRE · ${sec}s`, w / 2, 36 + 8);
      ctx.restore();
    }

    // 1980 vector end-of-match banners (same style for all)
    if (epilogue) {
      let lines = epilogue.lines;
      let color = '#5eead4';
      let glow = '#22d3ee';
      if (!lines || !lines.length) {
        if (epilogue.kind === 'defeat') {
          lines = ['BETTER LUCK NEXT TIME,', 'STARFIGHTER!'];
        } else if (epilogue.kind === 'draw') {
          lines = ['DRAW'];
          color = '#94a3b8';
          glow = '#64748b';
        } else if (epilogue.kind === 'victory' || epilogue.kind === 'ending') {
          lines = ['VICTORY IS YOURS!'];
          color = '#fbbf24';
          glow = '#f59e0b';
        }
      } else if (epilogue.kind === 'victory') {
        color = '#fbbf24';
        glow = '#f59e0b';
      } else if (epilogue.kind === 'draw') {
        color = '#94a3b8';
        glow = '#64748b';
      }
      if (lines?.length) {
        drawVectorText(lines, {
          color,
          glow,
          lineHeight: Math.min(64, Math.max(36, w * 0.055)),
          y: h * 0.36,
        });
        ctx.save();
        ctx.globalAlpha = 0.06;
        for (let y = 0; y < h; y += 3) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, y, w, 1);
        }
        ctx.restore();
      }
    }
  }

  return {
    resize,
    isReady,
    setCamera,
    render,
    handleEvents,
    addParticles,
    spawnWormholeTrail,
    trailWorldAt,
    get cam() {
      return cam;
    },
    get size() {
      return { w, h };
    },
  };
}
