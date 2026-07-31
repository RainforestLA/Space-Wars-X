/**
 * 1980s-style opening: robotic voice, 16-bit BGM, live example-play backdrop.
 * Each voice segment fully completes before the next begins.
 * Requires a user gesture to start (browser autoplay policy).
 */

import { audio } from './audio.js';

/** Absolute failsafe only (not a pacing budget) */
const INTRO_FAILSAFE_MS = 120000;
const INTRO_KEY = 'swx_intro_played';
const GAP_AFTER_LINE_MS = 400;

/** Full briefing — duration is driven by speech completion, not fixed holds */
const LINES = [
  { text: 'Greetings Starfighter!' },
  { text: 'Welcome to Space Wars X.' },
  { text: 'A multiplayer dogfight in deep space.' },
  { text: 'Rotate left and right. Hold thrust to fly. Ships keep drifting with inertia.' },
  { text: 'Gravity wells pull hard. Use full thrusters to escape the sun.' },
  { text: 'Speak clearly for weapons. Say Photon for a gravity bomb. One hit kill.' },
  { text: 'Say Laser for rapid fire. Two hits destroy a ship.' },
  { text: 'Say Shields for one second of invulnerability. Say Hyperspace to jump.' },
  { text: 'Collisions destroy both ships. Avoid asteroids. Last ship standing wins.' },
  { text: 'Good luck, Starfighter!' },
];

let active = false;
let musicNodes = null;
let endTimer = null;
let demoRaf = 0;

let introCtx = null;
let introMaster = null;

function getOrCreateIntroCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!introCtx) {
    introCtx = new AC();
    introMaster = introCtx.createGain();
    introMaster.gain.value = 0.7;
    introMaster.connect(introCtx.destination);
  }
  if (introCtx.state === 'suspended') introCtx.resume();
  return introCtx;
}

/** Louder square/pulse 16-bit sci-fi BGM (covers full briefing length) */
function startBgm() {
  const c = getOrCreateIntroCtx();
  if (!c || musicNodes) return;
  const t0 = c.currentTime;
  const bus = c.createGain();
  // Louder under VO so 16-bit score reads clearly
  bus.gain.value = 0.52;
  bus.connect(introMaster);

  const bassNotes = [55, 55, 73, 82, 55, 98, 73, 55];
  const leadNotes = [220, 277, 330, 392, 330, 277, 247, 220];
  const beat = 0.2;
  const oscs = [];
  // Enough loops for ~90s of full spoken briefing
  const loopLen = 48;
  const numLoops = 10;

  function scheduleLoop(start) {
    for (let i = 0; i < loopLen; i++) {
      const t = start + i * beat;
      {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'square';
        o.frequency.value = bassNotes[i % bassNotes.length];
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.52, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.85);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 700;
        o.connect(f);
        f.connect(g);
        g.connect(bus);
        o.start(t);
        o.stop(t + beat);
        oscs.push(o);
      }
      if (i % 2 === 0) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'square';
        o.frequency.value = leadNotes[(i / 2) % leadNotes.length];
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.26, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 1.5);
        const f = c.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1400;
        f.Q.value = 2;
        o.connect(f);
        f.connect(g);
        g.connect(bus);
        o.start(t);
        o.stop(t + beat * 1.6);
        oscs.push(o);
      }
      if (i % 2 === 1) {
        const len = Math.floor(c.sampleRate * 0.04);
        const buf = c.createBuffer(1, len, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let j = 0; j < len; j++) d[j] = Math.random() * 2 - 1;
        const src = c.createBufferSource();
        src.buffer = buf;
        const g = c.createGain();
        g.gain.setValueAtTime(0.11, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
        const hp = c.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 4000;
        src.connect(hp);
        hp.connect(g);
        g.connect(bus);
        src.start(t);
        oscs.push(src);
      }
    }
  }

  for (let L = 0; L < numLoops; L++) {
    scheduleLoop(t0 + L * loopLen * beat);
  }

  const pad = c.createOscillator();
  const pad2 = c.createOscillator();
  const pg = c.createGain();
  pad.type = 'sawtooth';
  pad2.type = 'sawtooth';
  pad.frequency.value = 110;
  pad2.frequency.value = 165;
  pad2.detune.value = 7;
  pg.gain.value = 0.14;
  const plp = c.createBiquadFilter();
  plp.type = 'lowpass';
  plp.frequency.value = 450;
  pad.connect(plp);
  pad2.connect(plp);
  plp.connect(pg);
  pg.connect(bus);
  const padDur = loopLen * beat * numLoops + 2;
  pad.start(t0);
  pad2.start(t0);
  pad.stop(t0 + padDur);
  pad2.stop(t0 + padDur);
  oscs.push(pad, pad2);

  bus.gain.setValueAtTime(0.52, t0);
  bus.gain.setValueAtTime(0.52, t0 + padDur - 3);
  bus.gain.linearRampToValueAtTime(0.0001, t0 + padDur);

  musicNodes = { bus, oscs };
}

function stopBgm() {
  if (!musicNodes) return;
  try {
    for (const o of musicNodes.oscs || []) {
      try {
        o.stop?.();
      } catch (_) {}
    }
  } catch (_) {}
  musicNodes = null;
}

function pickRobotVoice() {
  const voices = speechSynthesis.getVoices?.() || [];
  const prefer = [
    (v) => /microsoft|david|mark|george|daniel/i.test(v.name) && /en/i.test(v.lang),
    (v) => /en-US|en-GB/i.test(v.lang) && /male|fred|alex/i.test(v.name),
    (v) => /en/i.test(v.lang),
  ];
  for (const test of prefer) {
    const v = voices.find(test);
    if (v) return v;
  }
  return voices[0] || null;
}

/**
 * Speak one line and resolve only when that utterance fully ends.
 * Safety timeout is generous (based on word count) so we never cut natural speech short.
 */
function speakLine(text) {
  return new Promise((resolve) => {
    const words = String(text).split(/\s+/).filter(Boolean).length;
    // ~0.55s/word + padding; min 2.5s, max 25s per segment
    const safetyMs = Math.min(25000, Math.max(2500, words * 550 + 2000));

    if (!window.speechSynthesis) {
      setTimeout(resolve, safetyMs * 0.6);
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      clearTimeout(safety);
      resolve();
    };

    // Reset engine, then speak after a brief settle so cancel doesn't kill the next line
    try {
      speechSynthesis.cancel();
    } catch (_) {}

    const safety = setTimeout(done, safetyMs);
    // Chrome can pause speech synthesis mid-utterance when the tab is busy
    const keepAlive = setInterval(() => {
      try {
        if (speechSynthesis.speaking && speechSynthesis.paused) {
          speechSynthesis.resume();
        }
      } catch (_) {}
    }, 200);

    setTimeout(() => {
      if (settled || !active) {
        done();
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickRobotVoice();
      if (voice) u.voice = voice;
      // Slightly slower for clarity; still robotic pitch
      u.rate = 0.9;
      u.pitch = 0.55;
      u.volume = 1;
      u.onend = () => done();
      u.onerror = () => done();
      try {
        speechSynthesis.speak(u);
      } catch (_) {
        done();
      }
    }, 100);
  });
}

function setCaption(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('intro-caption-flash');
  void el.offsetWidth;
  el.classList.add('intro-caption-flash');
}

/**
 * Classic 16-bit Star Wars hyperspace POV:
 * stars streak from vanishing point toward the camera as bright pixel lines.
 */
function startDemoPlay(canvas) {
  if (!canvas) return () => {};
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let running = true;
  let last = performance.now();

  function resize() {
    // Integer scale for chunky 16-bit look (render low-res, upscale with nearest)
    const cssW = canvas.clientWidth || window.innerWidth;
    const cssH = canvas.clientHeight || window.innerHeight;
    // Internal buffer ~1/2–1/3 res for pixelated streaks
    const scale = Math.max(2, Math.floor(Math.min(cssW, cssH) / 220));
    w = Math.max(160, Math.floor(cssW / scale));
    h = Math.max(100, Math.floor(cssH / scale));
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.imageSmoothingEnabled = false;
  }
  resize();

  function spawnStar() {
    // Random direction from center; z from near-vanishing to mid
    const ang = Math.random() * Math.PI * 2;
    return {
      ang,
      z: 0.08 + Math.random() * 0.9, // 0 = far, 1 = near camera
      speed: 0.55 + Math.random() * 1.1,
      bright: 0.45 + Math.random() * 0.55,
      // 16-bit palette variation
      tint: Math.random() < 0.15 ? 1 : Math.random() < 0.1 ? 2 : 0, // 0 white, 1 cyan, 2 warm
    };
  }

  const STAR_COUNT = 140;
  const stars = Array.from({ length: STAR_COUNT }, () => spawnStar());

  function project(star) {
    // Perspective: z→0 is center point; z→1 flies past edges
    const fov = Math.min(w, h) * 0.48;
    const depth = Math.max(0.02, 1.05 - star.z);
    const r = (fov * star.z) / depth;
    const cx = w / 2;
    const cy = h / 2;
    return {
      x: cx + Math.cos(star.ang) * r,
      y: cy + Math.sin(star.ang) * r,
      // previous position for streak (slightly farther back in tunnel)
      px: cx + Math.cos(star.ang) * r * 0.72,
      py: cy + Math.sin(star.ang) * r * 0.72,
      len: 1 + star.z * 14,
    };
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Motion blur trail — darken rather than clear for hyperspace glow
    ctx.fillStyle = 'rgba(2, 4, 12, 0.35)';
    ctx.fillRect(0, 0, w, h);

    // Deep space base tint
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, 'rgba(20, 30, 70, 0.15)');
    bg.addColorStop(0.5, 'rgba(8, 12, 28, 0.08)');
    bg.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Vanishing-point glow (warp core)
    const core = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) * 0.12);
    core.addColorStop(0, 'rgba(180, 220, 255, 0.35)');
    core.addColorStop(0.4, 'rgba(80, 140, 255, 0.12)');
    core.addColorStop(1, 'transparent');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.12, 0, Math.PI * 2);
    ctx.fill();

    for (const st of stars) {
      st.z += st.speed * dt * 1.35;
      if (st.z >= 1.05) {
        Object.assign(st, spawnStar());
        st.z = 0.05 + Math.random() * 0.12;
      }

      const p = project(st);
      // Chunk length grows as star approaches
      const dx = p.x - p.px;
      const dy = p.y - p.py;
      const stretch = 0.35 + st.z * 1.8;
      const x0 = p.x - dx * stretch;
      const y0 = p.y - dy * stretch;
      const x1 = p.x + dx * 0.15;
      const y1 = p.y + dy * 0.15;

      // 16-bit palette
      let col = '#e8f0ff';
      if (st.tint === 1) col = '#7dd3fc';
      if (st.tint === 2) col = '#fde68a';
      const alpha = Math.min(1, 0.25 + st.z * 0.9) * st.bright;

      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth = st.z > 0.7 ? 2 : 1;
      ctx.lineCap = 'square'; // chunky, not rounded
      ctx.beginPath();
      ctx.moveTo(Math.floor(x0), Math.floor(y0));
      ctx.lineTo(Math.floor(x1), Math.floor(y1));
      ctx.stroke();

      // Bright head pixel
      if (st.z > 0.35) {
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = alpha;
        const hs = st.z > 0.75 ? 2 : 1;
        ctx.fillRect(Math.floor(x1), Math.floor(y1), hs, hs);
      }
    }
    ctx.globalAlpha = 1;

    // Subtle scanline / CRT for 16-bit flavor
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    for (let y = 0; y < h; y += 2) {
      ctx.fillRect(0, y, w, 1);
    }

    // Title watermark
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#7dd3fc';
    ctx.font = `bold ${Math.max(10, Math.floor(w / 18))}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('HYPERSPACE', w / 2, Math.floor(h * 0.08));
    ctx.globalAlpha = 0.14;
    ctx.fillText('SPACE WARS X', w / 2, Math.floor(h * 0.08) + 14);
    ctx.globalAlpha = 1;

    demoRaf = requestAnimationFrame(frame);
  }

  demoRaf = requestAnimationFrame(frame);
  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  return () => {
    running = false;
    cancelAnimationFrame(demoRaf);
    window.removeEventListener('resize', onResize);
  };
}

let stopDemo = null;

function finish(overlay, onDone) {
  if (!active && !overlay) {
    onDone?.();
    return;
  }
  active = false;
  clearTimeout(endTimer);
  try {
    speechSynthesis?.cancel();
  } catch (_) {}
  stopBgm();
  if (stopDemo) {
    stopDemo();
    stopDemo = null;
  }
  overlay?.classList.add('intro-fade-out');
  setTimeout(() => {
    overlay?.remove();
    onDone?.();
  }, 400);
}

/**
 * Show intro overlay; starts on tap/click (required for audio).
 */
export function playOpeningIntro(onDone) {
  if (sessionStorage.getItem(INTRO_KEY) === '1') {
    onDone?.();
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'intro-overlay';
  overlay.className = 'intro-overlay';
  overlay.innerHTML = `
    <canvas class="intro-demo-canvas" id="intro-demo" aria-hidden="true"></canvas>
    <div class="intro-panel">
      <div class="intro-scanlines" aria-hidden="true"></div>
      <p class="intro-label">SPACE WARS X · INCOMING TRANSMISSION</p>
      <p class="intro-caption" id="intro-caption">Example combat loading…</p>
      <button type="button" class="btn btn-primary intro-start-btn" id="intro-start">
        TAP TO RECEIVE
      </button>
      <button type="button" class="btn btn-ghost intro-skip-btn" id="intro-skip" hidden>
        SKIP
      </button>
      <p class="intro-hint muted sm">1980s computer voice · full briefing (skip anytime)</p>
    </div>
  `;
  document.getElementById('app')?.appendChild(overlay);

  const canvas = overlay.querySelector('#intro-demo');
  // Start silent demo backdrop immediately (no audio until tap)
  stopDemo = startDemoPlay(canvas);

  const caption = overlay.querySelector('#intro-caption');
  const startBtn = overlay.querySelector('#intro-start');
  const skipBtn = overlay.querySelector('#intro-skip');

  const skip = () => {
    sessionStorage.setItem(INTRO_KEY, '1');
    active = true; // allow finish
    finish(overlay, onDone);
  };

  skipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    skip();
  });

  startBtn.addEventListener('click', async () => {
    if (active) return;
    active = true;
    sessionStorage.setItem(INTRO_KEY, '1');
    startBtn.hidden = true;
    skipBtn.hidden = false;
    audio.unlock();
    getOrCreateIntroCtx();

    if (speechSynthesis.getVoices().length === 0) {
      await new Promise((r) => {
        speechSynthesis.onvoiceschanged = () => r();
        setTimeout(r, 400);
      });
    }

    startBgm();
    setCaption(caption, 'Greetings Starfighter!');

    // Failsafe only — pacing is speech-driven
    endTimer = setTimeout(() => {
      if (active) finish(overlay, onDone);
    }, INTRO_FAILSAFE_MS);

    // Wait for each line to fully finish speaking before the next
    for (const line of LINES) {
      if (!active) break;
      setCaption(caption, line.text);
      await speakLine(line.text);
      if (!active) break;
      // Short pause between segments so lines don't run together
      await new Promise((r) => setTimeout(r, GAP_AFTER_LINE_MS));
    }

    if (active) {
      setCaption(caption, 'TRANSMISSION COMPLETE · SPACE WARS X');
      setTimeout(() => finish(overlay, onDone), 800);
    }
  });
}
