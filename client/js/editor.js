import { ARENA_W, ARENA_H } from '../../shared/constants.js';
import { net } from './net.js';

function uid() {
  return 'o' + Math.random().toString(36).slice(2, 9);
}

export function createEditor(canvas, getMap, setMap, isHost) {
  const ctx = canvas.getContext('2d');
  let tool = 'select';
  let selected = null; // { kind, index }
  let dragging = false;
  let dragOff = { x: 0, y: 0 };
  let dpr = 1;
  let view = { scale: 1, ox: 0, oy: 0 };
  let raf = 0;
  let active = false;

  const tools = document.querySelectorAll('.tool-btn');
  tools.forEach((btn) => {
    btn.addEventListener('click', () => {
      tools.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      tool = btn.dataset.tool;
      selected = null;
      updateProps();
    });
  });

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    fitView();
  }

  function fitView() {
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    const pad = 20;
    view.scale = Math.min((cw - pad * 2) / ARENA_W, (ch - pad * 2) / ARENA_H);
    view.ox = (cw - ARENA_W * view.scale) / 2;
    view.oy = (ch - ARENA_H * view.scale) / 2;
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - view.ox) / view.scale,
      y: (sy - view.oy) / view.scale,
    };
  }

  function worldToScreen(x, y) {
    return {
      x: view.ox + x * view.scale,
      y: view.oy + y * view.scale,
    };
  }

  function getEventPos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e.changedTouches ? e.changedTouches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function hitTest(wx, wy) {
    const map = getMap();
    const thr = 24 / view.scale;
    for (let i = map.wells.length - 1; i >= 0; i--) {
      const o = map.wells[i];
      if (Math.hypot(o.x - wx, o.y - wy) < Math.max(o.radius, thr)) return { kind: 'wells', index: i };
    }
    for (let i = (map.asteroids || []).length - 1; i >= 0; i--) {
      const o = map.asteroids[i];
      if (Math.hypot(o.x - wx, o.y - wy) < Math.max(o.radius, thr)) return { kind: 'asteroids', index: i };
    }
    for (let i = (map.movers || []).length - 1; i >= 0; i--) {
      const o = map.movers[i];
      if (Math.hypot(o.x - wx, o.y - wy) < (o.radius || 22) + thr) return { kind: 'movers', index: i };
    }
    for (let i = (map.wormholes || []).length - 1; i >= 0; i--) {
      const o = map.wormholes[i];
      if (Math.hypot(o.x - wx, o.y - wy) < 30 + thr) return { kind: 'wormholes', index: i };
    }
    return null;
  }

  function place(wx, wy) {
    if (!isHost()) return;
    const map = structuredClone(getMap());
    wx = Math.max(0, Math.min(ARENA_W, wx));
    wy = Math.max(0, Math.min(ARENA_H, wy));

    if (tool === 'well') {
      if ((map.wells || []).length >= 3) return;
      map.wells = map.wells || [];
      map.wells.push({
        id: uid(),
        x: wx,
        y: wy,
        radius: 80,
        strength: 1.5,
        style: 'sun',
        killRadius: 32,
      });
      selected = { kind: 'wells', index: map.wells.length - 1 };
    } else if (tool === 'asteroid') {
      map.asteroids = map.asteroids || [];
      map.asteroids.push({ id: uid(), x: wx, y: wy, radius: 35 + Math.random() * 20 });
      selected = { kind: 'asteroids', index: map.asteroids.length - 1 };
    } else if (tool === 'mover') {
      map.movers = map.movers || [];
      map.movers.push({
        id: uid(),
        x: wx,
        y: wy,
        radius: 28 + Math.random() * 12,
        amp: 100,
        speed: 0.8 + Math.random() * 0.6,
        pattern: 'circle',
      });
      selected = { kind: 'movers', index: map.movers.length - 1 };
    } else if (tool === 'wormhole') {
      map.wormholes = map.wormholes || [];
      map.wormholes.push({ id: uid(), x: wx, y: wy, radius: 28 });
      selected = { kind: 'wormholes', index: map.wormholes.length - 1 };
    }
    setMap(map);
    pushMap();
    updateProps();
  }

  function pushMap() {
    if (isHost()) net.setMap(getMap());
  }

  function updateProps() {
    const wellProps = document.getElementById('well-props');
    const genProps = document.getElementById('generic-props');
    const limit = document.getElementById('well-limit');
    const map = getMap();
    limit.textContent = `Wells: ${(map.wells || []).length} / 3`;

    if (selected?.kind === 'wells') {
      wellProps.hidden = false;
      genProps.hidden = true;
      const w = map.wells[selected.index];
      if (!w) {
        wellProps.hidden = true;
        return;
      }
      document.getElementById('well-radius').value = w.radius;
      document.getElementById('well-radius-val').textContent = Math.round(w.radius);
      document.getElementById('well-strength').value = w.strength;
      document.getElementById('well-str-val').textContent = Number(w.strength).toFixed(1);
      document.getElementById('well-style').value = w.style || 'sun';
    } else if (selected) {
      wellProps.hidden = true;
      genProps.hidden = false;
    } else {
      wellProps.hidden = true;
      genProps.hidden = true;
    }
  }

  function bindProps() {
    document.getElementById('well-radius').addEventListener('input', (e) => {
      if (selected?.kind !== 'wells') return;
      const map = structuredClone(getMap());
      const w = map.wells[selected.index];
      if (!w) return;
      w.radius = Number(e.target.value);
      w.killRadius = w.radius * (w.style === 'blackhole' ? 0.35 : 0.4);
      document.getElementById('well-radius-val').textContent = Math.round(w.radius);
      setMap(map);
      pushMap();
    });
    document.getElementById('well-strength').addEventListener('input', (e) => {
      if (selected?.kind !== 'wells') return;
      const map = structuredClone(getMap());
      const w = map.wells[selected.index];
      if (!w) return;
      w.strength = Number(e.target.value);
      document.getElementById('well-str-val').textContent = w.strength.toFixed(1);
      setMap(map);
      pushMap();
    });
    document.getElementById('well-style').addEventListener('change', (e) => {
      if (selected?.kind !== 'wells') return;
      const map = structuredClone(getMap());
      const w = map.wells[selected.index];
      if (!w) return;
      w.style = e.target.value;
      w.killRadius = w.radius * (w.style === 'blackhole' ? 0.35 : 0.4);
      setMap(map);
      pushMap();
    });
    const del = () => {
      if (!selected) return;
      const map = structuredClone(getMap());
      map[selected.kind].splice(selected.index, 1);
      selected = null;
      setMap(map);
      pushMap();
      updateProps();
    };
    document.getElementById('btn-delete-obj').addEventListener('click', del);
    document.getElementById('btn-delete-obj2').addEventListener('click', del);
  }
  bindProps();

  function onPointerDown(e) {
    if (!isHost()) return;
    e.preventDefault();
    const pos = getEventPos(e);
    const world = screenToWorld(pos.x, pos.y);
    if (tool === 'select') {
      selected = hitTest(world.x, world.y);
      if (selected) {
        const map = getMap();
        const o = map[selected.kind][selected.index];
        dragging = true;
        dragOff = { x: o.x - world.x, y: o.y - world.y };
      }
      updateProps();
    } else {
      place(world.x, world.y);
    }
  }

  function onPointerMove(e) {
    if (!dragging || !selected || !isHost()) return;
    e.preventDefault();
    const pos = getEventPos(e);
    const world = screenToWorld(pos.x, pos.y);
    const map = structuredClone(getMap());
    const o = map[selected.kind][selected.index];
    if (!o) return;
    o.x = Math.max(0, Math.min(ARENA_W, world.x + dragOff.x));
    o.y = Math.max(0, Math.min(ARENA_H, world.y + dragOff.y));
    setMap(map);
  }

  function onPointerUp() {
    if (dragging) {
      dragging = false;
      pushMap();
    }
  }

  function draw() {
    if (!active) return;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, cw, ch);

    // arena
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2 / view.scale;
    ctx.strokeRect(0, 0, ARENA_W, ARENA_H);
    ctx.fillStyle = '#0a0f18';
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);

    // grid subtle
    ctx.strokeStyle = 'rgba(30,41,59,0.5)';
    ctx.lineWidth = 1 / view.scale;
    for (let x = 0; x < ARENA_W; x += 200) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ARENA_H);
      ctx.stroke();
    }
    for (let y = 0; y < ARENA_H; y += 200) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(ARENA_W, y);
      ctx.stroke();
    }

    const map = getMap();
    for (let i = 0; i < (map.wells || []).length; i++) {
      const well = map.wells[i];
      const sel = selected?.kind === 'wells' && selected.index === i;
      if (well.style === 'blackhole') {
        const g = ctx.createRadialGradient(well.x, well.y, 0, well.x, well.y, well.radius);
        g.addColorStop(0, '#000');
        g.addColorStop(0.7, '#312e81');
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
      } else {
        const g = ctx.createRadialGradient(well.x, well.y, 0, well.x, well.y, well.radius);
        g.addColorStop(0, '#fef08a');
        g.addColorStop(0.5, '#f59e0b');
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
      }
      ctx.beginPath();
      ctx.arc(well.x, well.y, well.radius, 0, Math.PI * 2);
      ctx.fill();
      if (sel) {
        ctx.strokeStyle = '#5eead4';
        ctx.lineWidth = 3 / view.scale;
        ctx.stroke();
      }
    }

    for (let i = 0; i < (map.asteroids || []).length; i++) {
      const a = map.asteroids[i];
      ctx.strokeStyle = selected?.kind === 'asteroids' && selected.index === i ? '#5eead4' : '#94a3b8';
      ctx.lineWidth = 2 / view.scale;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (let i = 0; i < (map.movers || []).length; i++) {
      const m = map.movers[i];
      const sel = selected?.kind === 'movers' && selected.index === i;
      const r = m.radius || 30;
      // Orbit path
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.amp || 100, 0, Math.PI * 2);
      ctx.setLineDash([6 / view.scale, 6 / view.scale]);
      ctx.strokeStyle = 'rgba(196,181,160,0.35)';
      ctx.lineWidth = 1 / view.scale;
      ctx.stroke();
      ctx.setLineDash([]);
      // Asteroid body
      ctx.strokeStyle = sel ? '#5eead4' : '#c4b5a0';
      ctx.fillStyle = 'rgba(100, 90, 75, 0.4)';
      ctx.lineWidth = 2 / view.scale;
      ctx.beginPath();
      const n = 8;
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const rr = r * (0.78 + (k % 3) * 0.08);
        const x = m.x + Math.cos(ang) * rr;
        const y = m.y + Math.sin(ang) * rr;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    for (let i = 0; i < (map.wormholes || []).length; i++) {
      const wh = map.wormholes[i];
      ctx.strokeStyle = selected?.kind === 'wormholes' && selected.index === i ? '#5eead4' : '#22d3ee';
      ctx.lineWidth = 2 / view.scale;
      ctx.beginPath();
      ctx.arc(wh.x, wh.y, 28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(34,211,238,0.15)';
      ctx.fill();
    }

    // pair lines for wormholes
    const whs = map.wormholes || [];
    ctx.strokeStyle = 'rgba(34,211,238,0.3)';
    ctx.lineWidth = 1 / view.scale;
    for (let i = 0; i + 1 < whs.length; i += 2) {
      ctx.beginPath();
      ctx.moveTo(whs[i].x, whs[i].y);
      ctx.lineTo(whs[i + 1].x, whs[i + 1].y);
      ctx.stroke();
    }

    ctx.restore();
    raf = requestAnimationFrame(draw);
  }

  function start() {
    active = true;
    resize();
    window.addEventListener('resize', resize);
    canvas.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    canvas.addEventListener('touchmove', onPointerMove, { passive: false });
    canvas.addEventListener('touchend', onPointerUp);
    updateProps();
    cancelAnimationFrame(raf);
    draw();
  }

  function stop() {
    active = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    canvas.removeEventListener('mousedown', onPointerDown);
    window.removeEventListener('mousemove', onPointerMove);
    window.removeEventListener('mouseup', onPointerUp);
    canvas.removeEventListener('touchstart', onPointerDown);
    canvas.removeEventListener('touchmove', onPointerMove);
    canvas.removeEventListener('touchend', onPointerUp);
  }

  return { start, stop, resize, updateProps };
}
