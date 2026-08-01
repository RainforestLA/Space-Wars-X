import { SHIP } from '../../shared/constants.js';
import { net } from './net.js';
import { createRenderer } from './render.js';
import { createInput, detectMobile } from './input.js';
import { createVoice } from './voice.js';
import { audio, setThrustSound } from './audio.js';

export function createGameController(state, showScreen, toast) {
  const canvas = document.getElementById('game-canvas');
  const renderer = createRenderer(canvas);
  const input = createInput({
    isMobile: detectMobile,
  });

  let running = false;
  let raf = 0;
  let lastT = 0;
  let snapshot = null;
  let prevSnap = null;
  let snapTime = 0;
  let voice = null;
  let lastThrust = false;
  let spectateIndex = 0;
  let unsubSnap = null;
  let inputAccum = 0;
  let lastSent = { rotating: 0, thrusting: false };
  let defeatBanner = null; // { until }
  let heardDefeat = false;
  let heardEnding = false;
  /** Camera rides wormhole path of travel */
  let camRide = null; // { fromX, fromY, dx, dy, duration, age }

  const COOLDOWN_MAX = {
    photon: SHIP.photonCooldown,
    laser: SHIP.laserCooldown,
    shield: SHIP.shieldCooldown,
    hyperspace: SHIP.hyperspaceCooldown,
  };

  function onSnapshot(snap) {
    if (!running) return;
    prevSnap = snapshot;
    snapshot = snap;
    snapTime = performance.now();
    renderer.handleEvents(snap.events);
    if (snap.events) {
      for (const e of snap.events) {
        if (e.type === 'explode') {
          audio.explode();
          const victim = snap.ships.find((s) => s.id === e.id);
          if (victim) pushKillFeed(`${victim.name} destroyed`);
        } else if (e.type === 'wormhole_jump') {
          if (e.id === state.youId || nearEvent({ x: e.fromX, y: e.fromY }, snap) || nearEvent({ x: e.toX, y: e.toY }, snap)) {
            audio.hyperspace();
          }
          // Local pilot: camera follows the hyperjump path of travel
          if (e.id === state.youId) {
            const { dx, dy } = (() => {
              let dx = e.toX - e.fromX;
              let dy = e.toY - e.fromY;
              const AW = 3200;
              const AH = 2400;
              if (dx > AW / 2) dx -= AW;
              if (dx < -AW / 2) dx += AW;
              if (dy > AH / 2) dy -= AH;
              if (dy < -AH / 2) dy += AH;
              return { dx, dy };
            })();
            const dist = Math.hypot(dx, dy) || 1;
            camRide = {
              fromX: e.fromX,
              fromY: e.fromY,
              dx,
              dy,
              duration: Math.min(0.55, Math.max(0.28, dist / 2800)),
              age: 0,
            };
          }
        } else if (e.type === 'nuke_fire') {
          if (e.id === state.youId || nearEvent(e, snap)) audio.nuke();
        } else if (e.type === 'photon_fire') {
          // Hear own always; nearby enemies slightly quieter via same call (spatial later)
          if (e.id === state.youId || nearEvent(e, snap)) audio.photon();
        } else if (e.type === 'laser_fire') {
          if (e.id === state.youId || nearEvent(e, snap)) audio.laser();
        } else if (e.type === 'shield') {
          if (e.id === state.youId || nearEvent(e, snap)) audio.shield();
        } else if (e.type === 'hyperspace_out' || e.type === 'hyperspace_in') {
          if (e.id === state.youId || nearEvent(e, snap)) audio.hyperspace();
        } else if (e.type === 'laser_hit') {
          audio.hit();
        } else if (e.type === 'training_defeat') {
          if (!heardDefeat) {
            heardDefeat = true;
            audio.defeatSting();
            defeatBanner = {
              until: performance.now() + (e.duration || 5) * 1000,
              kind: 'defeat',
              lines: ['BETTER LUCK NEXT TIME,', 'STARFIGHTER!'],
            };
          }
        } else if (e.type === 'match_ending') {
          if (!heardEnding) {
            heardEnding = true;
            if (e.kind === 'draw') audio.defeatSting();
            else audio.win();
          }
        }
      }
    }
    if (snap.epilogue?.kind === 'defeat' && !heardDefeat) {
      heardDefeat = true;
      audio.defeatSting();
      defeatBanner = {
        until: performance.now() + (snap.epilogue.remaining || 5) * 1000,
        kind: 'defeat',
        lines: snap.epilogue.lines || ['BETTER LUCK NEXT TIME,', 'STARFIGHTER!'],
      };
    }
    if (
      snap.epilogue &&
      (snap.epilogue.kind === 'victory' || snap.epilogue.kind === 'draw') &&
      !heardEnding
    ) {
      heardEnding = true;
      if (snap.epilogue.kind === 'draw') audio.defeatSting();
      else audio.win();
    }
    updateHud(snap);
  }

  function nearEvent(e, snap) {
    const me = snap.ships?.find((s) => s.id === state.youId);
    if (!me || e.x == null) return false;
    const dx = e.x - me.x;
    const dy = e.y - me.y;
    return dx * dx + dy * dy < 900 * 900;
  }

  function pushKillFeed(text) {
    const feed = document.getElementById('kill-feed');
    const el = document.createElement('div');
    el.className = 'item';
    el.textContent = text;
    feed.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function updateHud(snap) {
    const me = snap.ships.find((s) => s.id === state.youId);
    const alive = snap.aliveCount ?? snap.ships.filter((s) => s.alive).length;
    document.getElementById('hud-alive').textContent = `${alive} alive`;
    const mode = state.room?.mode;
    let modeLabel =
      mode === 'teams'
        ? `Teams ×${state.room.teamCount}`
        : mode === 'training'
          ? 'Training'
          : 'FFA';
    if (mode === 'training' && snap.trainingGrace > 0.05) {
      modeLabel = `Grace ${Math.ceil(snap.trainingGrace)}s`;
    }
    document.getElementById('hud-mode').textContent = modeLabel;

    const spec = document.getElementById('hud-spectate');
    const isSpec = (!me || !me.alive) && !snap.epilogue;
    spec.classList.toggle('hidden', !isSpec);

    const cds = me?.cooldowns || { photon: 0, laser: 0, shield: 0, hyperspace: 0 };
    for (const key of ['photon', 'laser', 'shield', 'hyperspace']) {
      const fill = document.getElementById(`cd-${key}`);
      const wrap = fill?.closest('.cd');
      const max = COOLDOWN_MAX[key];
      const left = cds[key] || 0;
      const ready = left <= 0.05;
      const pct = ready ? 100 : Math.max(0, ((max - left) / max) * 100);
      if (fill) fill.style.width = pct + '%';
      wrap?.classList.toggle('ready', ready);
    }

    const pips = document.getElementById('damage-pips');
    pips.innerHTML = '';
    if (me && me.alive) {
      for (let i = 0; i < SHIP.laserHitsToKill; i++) {
        const d = document.createElement('div');
        d.className = 'pip' + (i < (me.laserHits || 0) ? ' hit' : '');
        pips.appendChild(d);
      }
    }
  }

  function lerpShips() {
    if (!snapshot) return [];
    if (!prevSnap) return snapshot.ships;
    const alpha = Math.min(1, (performance.now() - snapTime) / (1000 / 20));
    return snapshot.ships.map((s) => {
      const p = prevSnap.ships.find((x) => x.id === s.id);
      if (!p || !s.alive) return s;
      // toroidal-aware lerp
      let dx = s.x - p.x;
      let dy = s.y - p.y;
      const AW = 3200;
      const AH = 2400;
      if (dx > AW / 2) dx -= AW;
      if (dx < -AW / 2) dx += AW;
      if (dy > AH / 2) dy -= AH;
      if (dy < -AH / 2) dy += AH;
      let x = p.x + dx * alpha;
      let y = p.y + dy * alpha;
      if (x < 0) x += AW;
      if (x >= AW) x -= AW;
      if (y < 0) y += AH;
      if (y >= AH) y -= AH;
      return {
        ...s,
        x,
        y,
        angle: lerpAngle(p.angle, s.angle, alpha),
      };
    });
  }

  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  function sendInputs(dt) {
    const polled = input.poll();
    // Actions immediately (voice)
    const actions = [];
    if (polled.action) actions.push(polled.action);
    for (const a of polled.actions || []) {
      if (!actions.includes(a)) actions.push(a);
    }
    for (const a of actions) {
      net.sendInput({ action: a });
    }

    // Movement at ~30 Hz, or immediately on change
    inputAccum += dt;
    const changed =
      polled.rotating !== lastSent.rotating || polled.thrusting !== lastSent.thrusting;
    if (changed || inputAccum >= 1 / 30) {
      inputAccum = 0;
      lastSent = { rotating: polled.rotating, thrusting: polled.thrusting };
      net.sendInput({
        rotating: polled.rotating,
        thrusting: polled.thrusting,
        seq: polled.seq,
      });
    }

    if (polled.thrusting !== lastThrust) {
      lastThrust = polled.thrusting;
      setThrustSound(polled.thrusting);
    }
  }

  function loop(t) {
    if (!running) return;
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 1 / 60;
    lastT = t;

    sendInputs(dt);

    const ships = lerpShips();
    const me = ships.find((s) => s.id === state.youId);

    // Camera: ride wormhole path of travel, else follow ship / spectator
    if (camRide) {
      camRide.age += dt;
      const u = Math.min(1, camRide.age / camRide.duration);
      // Ease-in-out for a zippy but readable path follow
      const ease = u * u * (3 - 2 * u);
      let cx = camRide.fromX + camRide.dx * ease;
      let cy = camRide.fromY + camRide.dy * ease;
      const AW = 3200;
      const AH = 2400;
      if (cx < 0) cx += AW;
      if (cx >= AW) cx -= AW;
      if (cy < 0) cy += AH;
      if (cy >= AH) cy -= AH;
      renderer.setCamera(cx, cy, true);
      if (u >= 1) camRide = null;
    } else {
      let focus = me;
      if (!me || !me.alive) {
        const alive = ships.filter((s) => s.alive);
        if (alive.length) {
          spectateIndex = ((spectateIndex % alive.length) + alive.length) % alive.length;
          focus = alive[spectateIndex];
        }
      }
      if (focus) renderer.setCamera(focus.x, focus.y);
    }

    const epilogue =
      snapshot?.epilogue ||
      (defeatBanner && performance.now() < defeatBanner.until
        ? {
            kind: defeatBanner.kind || 'defeat',
            lines: defeatBanner.lines,
            remaining: (defeatBanner.until - performance.now()) / 1000,
          }
        : null);

    renderer.render({
      map: state.room?.map,
      ships,
      projectiles: snapshot?.projectiles || [],
      movers: snapshot?.movers || [],
      nukes: snapshot?.nukes || [],
      rocks: snapshot?.rocks || [],
      fragmentingAsteroids: !!snapshot?.fragmentingAsteroids,
      youId: state.youId,
      dt,
      epilogue,
      trainingGrace: snapshot?.trainingGrace || 0,
    });

    raf = requestAnimationFrame(loop);
  }

  function startVoice() {
    const statusEl = document.getElementById('voice-status');
    voice = createVoice((cmd) => {
      const action = cmd === 'shield' ? 'shield' : cmd;
      // Fire immediately — don't wait for the 30 Hz input poll
      net.sendInput({ action });
      input.queueAction(action); // backup if packet order races
      statusEl.textContent = `🎤 ${cmd}`;
      statusEl.className = 'hud-pill voice-pill on';
      setTimeout(() => {
        if (voice?.active) statusEl.textContent = '🎤 ON';
      }, 500);
    });
    voice.setStatusHandler((s) => {
      if (s === 'listening') {
        statusEl.textContent = '🎤 ON';
        statusEl.className = 'hud-pill voice-pill on';
      } else if (s === 'denied' || s === 'unsupported') {
        statusEl.textContent = '🎤 OFF';
        statusEl.className = 'hud-pill voice-pill off';
        if (s === 'denied') toast('Microphone blocked — enable for voice weapons', true);
        if (s === 'unsupported') toast('Voice not supported in this browser', true);
      } else if (s === 'off') {
        statusEl.textContent = '🎤 …';
        statusEl.className = 'hud-pill voice-pill';
      }
    });
    voice.start();
  }

  function onCanvasTap() {
    if (!snapshot) return;
    const me = snapshot.ships.find((s) => s.id === state.youId);
    if (me && me.alive) return;
    spectateIndex++;
  }

  function onResize() {
    renderer.resize();
  }

  function ensureCanvasSize() {
    // Screen must be visible first so layout has real width/height
    renderer.resize();
    // Double-rAF: wait for browser to apply display:flex and reflow
    requestAnimationFrame(() => {
      renderer.resize();
      requestAnimationFrame(() => renderer.resize());
    });
    // Fallback if first frames still reported 0 (slow mobile layout)
    setTimeout(() => renderer.resize(), 50);
    setTimeout(() => renderer.resize(), 200);
  }

  return {
    start() {
      running = true;
      lastT = 0;
      snapshot = null;
      prevSnap = null;
      spectateIndex = 0;
      lastThrust = false;
      defeatBanner = null;
      heardDefeat = false;
      heardEnding = false;
      camRide = null;
      document.getElementById('kill-feed').innerHTML = '';
      // Show game screen BEFORE measuring canvas (hidden screens are 0×0)
      showScreen('game');
      ensureCanvasSize();
      window.addEventListener('resize', onResize);
      // orientation / visual viewport changes (mobile)
      window.addEventListener('orientationchange', onResize);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize);
      }
      canvas.addEventListener('click', onCanvasTap);
      input.enable();
      audio.unlock();
      startVoice();
      if (unsubSnap) unsubSnap();
      unsubSnap = net.on('snapshot', onSnapshot);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', onResize);
      }
      canvas.removeEventListener('click', onCanvasTap);
      input.disable();
      setThrustSound(false);
      voice?.stop();
      if (unsubSnap) {
        unsubSnap();
        unsubSnap = null;
      }
    },
  };
}
