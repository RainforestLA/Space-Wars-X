/**
 * Modern cinematic SFX via Web Audio API — layered oscillators, noise, filters, delays.
 */

let ctx = null;
let master = null;
let compressor = null;
let muted = false;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();

  compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 18;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.18;

  master = ctx.createGain();
  master.gain.value = 0.45;
  master.connect(compressor);
  compressor.connect(ctx.destination);
  return ctx;
}

function now() {
  return ensure()?.currentTime ?? 0;
}

function envGain(vol, attack, hold, release, t0) {
  const c = ensure();
  const g = c.createGain();
  const t = t0 ?? c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t + attack);
  g.gain.setValueAtTime(Math.max(0.0001, vol), t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return g;
}

function osc(type, freq, t0) {
  const c = ensure();
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  return o;
}

function noiseBuf(dur, color = 'white') {
  const c = ensure();
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    if (color === 'brown') {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else if (color === 'pink') {
      last = 0.98 * last + 0.02 * white;
      data[i] = white * 0.3 + last * 0.7;
    } else {
      data[i] = white;
    }
  }
  return buf;
}

function playNoise(dur, vol, filterType, freq, q = 1, color = 'white', slide = 0) {
  if (muted) return;
  const c = ensure();
  if (!c) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuf(dur + 0.05, color);
  const filt = c.createBiquadFilter();
  filt.type = filterType;
  filt.frequency.setValueAtTime(freq, t);
  if (slide) filt.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
  filt.Q.value = q;
  const g = envGain(vol, 0.005, dur * 0.25, dur * 0.7, t);
  src.connect(filt);
  filt.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);
}

function playTone({ type = 'sine', freq, endFreq, dur, vol, attack = 0.01, release = 0.15, delay = 0, detune = 0 }) {
  if (muted) return;
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = osc(type, freq, t);
  if (detune) o.detune.setValueAtTime(detune, t);
  if (endFreq != null) {
    o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
  }
  const g = envGain(vol, attack, Math.max(0, dur - attack - release), release, t);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Short echo/delay tap bus for zings */
function withEcho(inputNode, time = 0.12, feedback = 0.35, mix = 0.4) {
  const c = ensure();
  const delay = c.createDelay(1);
  delay.delayTime.value = time;
  const fb = c.createGain();
  fb.gain.value = feedback;
  const wet = c.createGain();
  wet.gain.value = mix;
  inputNode.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  wet.connect(master);
}

export const audio = {
  unlock() {
    const c = ensure();
    if (c?.state === 'suspended') c.resume();
  },

  setMuted(m) {
    muted = m;
    if (master) master.gain.value = m ? 0 : 0.45;
  },

  /**
   * Photon torpedo — Star Trek–inspired: deep whoosh + power charge + heavy launch.
   */
  photon() {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t = c.currentTime;

    // Rising power charge
    playTone({ type: 'sawtooth', freq: 90, endFreq: 180, dur: 0.18, vol: 0.12, attack: 0.02, release: 0.12 });
    playTone({ type: 'sine', freq: 140, endFreq: 220, dur: 0.15, vol: 0.1, attack: 0.015, release: 0.1 });
    // Deep torpedo thump
    playTone({ type: 'sine', freq: 65, endFreq: 32, dur: 0.55, vol: 0.62, attack: 0.006, release: 0.42 });
    playTone({ type: 'triangle', freq: 95, endFreq: 40, dur: 0.45, vol: 0.32, attack: 0.01, release: 0.32 });
    // Hollow mid body (tube / warp)
    playTone({ type: 'square', freq: 120, endFreq: 55, dur: 0.35, vol: 0.08, attack: 0.01, release: 0.25 });
    // Launch whoosh
    playNoise(0.28, 0.28, 'bandpass', 500, 1.2, 'pink', 1800);
    playNoise(0.18, 0.18, 'lowpass', 220, 0.6, 'brown');
    // Trailing hum
    playTone({ type: 'sine', freq: 200, endFreq: 80, dur: 0.4, vol: 0.08, attack: 0.05, release: 0.3, delay: 0.05 });
  },

  /**
   * Laser blaster — Star Wars–inspired: sharp PEW with pitch drop + stereo-ish echo.
   */
  laser() {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t = c.currentTime;

    // Classic blaster: quick high → low zip
    const o = osc('square', 1400, t);
    o.frequency.setValueAtTime(1400, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.12);
    const g = envGain(0.16, 0.002, 0.03, 0.1, t);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2200, t);
    bp.frequency.exponentialRampToValueAtTime(400, t + 0.12);
    bp.Q.value = 3;
    o.connect(bp);
    bp.connect(g);
    g.connect(master);
    withEcho(g, 0.05, 0.25, 0.35);
    o.start(t);
    o.stop(t + 0.15);

    // Second harmonic zip
    playTone({ type: 'sawtooth', freq: 900, endFreq: 140, dur: 0.11, vol: 0.08, attack: 0.001, release: 0.08 });
    // Air crack
    playNoise(0.05, 0.12, 'highpass', 2500, 0.7, 'white', -1000);
    // Soft tail
    playTone({ type: 'sine', freq: 400, endFreq: 120, dur: 0.1, vol: 0.05, attack: 0.002, release: 0.08, delay: 0.02 });
  },

  /** Energy power-up shields — rising harmonics + shimmer */
  shield() {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t = c.currentTime;

    // Power swell bass
    playTone({ type: 'sine', freq: 80, endFreq: 160, dur: 0.5, vol: 0.22, attack: 0.05, release: 0.3 });
    // Chord rise
    const notes = [220, 277, 330, 440];
    notes.forEach((f, i) => {
      playTone({
        type: 'sine',
        freq: f * 0.7,
        endFreq: f * 1.4,
        dur: 0.55,
        vol: 0.09 - i * 0.012,
        attack: 0.04 + i * 0.02,
        release: 0.28,
        delay: i * 0.03,
      });
    });
    // Shimmer noise
    playNoise(0.45, 0.1, 'highpass', 2500, 0.8, 'pink', 800);
    // Crystal ping
    playTone({ type: 'triangle', freq: 880, endFreq: 1320, dur: 0.35, vol: 0.1, attack: 0.01, release: 0.25, delay: 0.05 });
    playTone({ type: 'sine', freq: 1760, dur: 0.25, vol: 0.05, attack: 0.01, release: 0.2, delay: 0.12 });
  },

  /** Slipstream zipper hyperspace */
  hyperspace() {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t = c.currentTime;

    // Zipper: rapid rising saw + noise sweep
    const o = osc('sawtooth', 80, t);
    o.frequency.setValueAtTime(80, t);
    o.frequency.exponentialRampToValueAtTime(2400, t + 0.28);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.55);
    const g = envGain(0.16, 0.02, 0.25, 0.25, t);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(8000, t + 0.25);
    lp.frequency.exponentialRampToValueAtTime(600, t + 0.55);
    o.connect(lp);
    lp.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.6);

    // Slipstream whoosh
    playNoise(0.5, 0.28, 'bandpass', 600, 2, 'pink', 4000);
    playNoise(0.35, 0.15, 'highpass', 2000, 0.5, 'white', 5000);
    // Dimensional thump in/out
    playTone({ type: 'sine', freq: 60, endFreq: 35, dur: 0.4, vol: 0.35, attack: 0.01, release: 0.3 });
    playTone({ type: 'triangle', freq: 400, endFreq: 80, dur: 0.3, vol: 0.1, attack: 0.02, release: 0.2, delay: 0.22 });
    // Zip stutter harmonics
    for (let i = 0; i < 6; i++) {
      playTone({
        type: 'square',
        freq: 200 + i * 180,
        endFreq: 800 + i * 300,
        dur: 0.08,
        vol: 0.03,
        attack: 0.002,
        release: 0.05,
        delay: 0.04 * i,
      });
    }
  },

  /** Major cinematic explosion */
  explode() {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t = c.currentTime;

    // Massive sub drop
    playTone({ type: 'sine', freq: 90, endFreq: 22, dur: 1.1, vol: 0.7, attack: 0.005, release: 0.9 });
    playTone({ type: 'triangle', freq: 140, endFreq: 30, dur: 0.8, vol: 0.35, attack: 0.008, release: 0.65 });
    // Shock crack
    playNoise(0.15, 0.55, 'highpass', 800, 0.5, 'white', -200);
    // Body boom brown
    playNoise(0.7, 0.45, 'lowpass', 500, 0.6, 'brown', -300);
    playNoise(0.5, 0.25, 'lowpass', 200, 0.4, 'brown');
    // Mid grit
    playTone({ type: 'sawtooth', freq: 180, endFreq: 40, dur: 0.45, vol: 0.12, attack: 0.005, release: 0.35 });
    playTone({ type: 'square', freq: 70, endFreq: 25, dur: 0.6, vol: 0.08, attack: 0.01, release: 0.45 });
    // Debris tail
    playNoise(0.9, 0.12, 'bandpass', 1200, 1.2, 'pink', -600);
    // Secondary boom
    playTone({ type: 'sine', freq: 55, endFreq: 28, dur: 0.5, vol: 0.3, attack: 0.02, release: 0.4, delay: 0.08 });
  },

  /** Hard impact / laser hit — compressed explosion bite */
  hit() {
    if (muted) return;
    const c = ensure();
    if (!c) return;

    playTone({ type: 'sine', freq: 160, endFreq: 45, dur: 0.28, vol: 0.4, attack: 0.003, release: 0.22 });
    playTone({ type: 'square', freq: 220, endFreq: 60, dur: 0.18, vol: 0.1, attack: 0.002, release: 0.12 });
    playNoise(0.18, 0.35, 'bandpass', 700, 1.5, 'white', -400);
    playNoise(0.25, 0.2, 'lowpass', 350, 0.8, 'brown');
  },

  ui() {
    playTone({ type: 'sine', freq: 720, dur: 0.06, vol: 0.08, attack: 0.005, release: 0.05 });
    playTone({ type: 'sine', freq: 980, dur: 0.07, vol: 0.05, attack: 0.005, release: 0.05, delay: 0.04 });
  },

  win() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => {
      playTone({
        type: 'triangle',
        freq: f,
        dur: 0.22,
        vol: 0.12,
        attack: 0.01,
        release: 0.15,
        delay: i * 0.1,
      });
      playTone({
        type: 'sine',
        freq: f * 2,
        dur: 0.18,
        vol: 0.04,
        attack: 0.01,
        release: 0.12,
        delay: i * 0.1,
      });
    });
  },

  /** Soft whoosh for defeat banner */
  defeatSting() {
    playTone({ type: 'sawtooth', freq: 200, endFreq: 80, dur: 0.8, vol: 0.1, attack: 0.05, release: 0.5 });
    playTone({ type: 'sine', freq: 150, endFreq: 60, dur: 1.0, vol: 0.2, attack: 0.08, release: 0.7 });
    playNoise(0.6, 0.08, 'lowpass', 400, 0.5, 'pink');
  },

  /** Hidden nuke pulsewave — deep expanding boom */
  nuke() {
    if (muted) return;
    playTone({ type: 'sine', freq: 55, endFreq: 28, dur: 0.9, vol: 0.55, attack: 0.01, release: 0.7 });
    playTone({ type: 'triangle', freq: 90, endFreq: 40, dur: 0.7, vol: 0.25, attack: 0.02, release: 0.5 });
    playNoise(0.55, 0.35, 'bandpass', 400, 0.8, 'pink', 1200);
    playNoise(0.4, 0.2, 'lowpass', 200, 0.5, 'brown');
    playTone({ type: 'sawtooth', freq: 180, endFreq: 60, dur: 0.35, vol: 0.08, attack: 0.005, release: 0.25 });
  },
};

// Thrust loop — modern rocket rumble
let thrustNodes = null;

export function setThrustSound(on) {
  if (muted && on) return;
  const c = ensure();
  if (!c) return;

  if (on && !thrustNodes) {
    const t = c.currentTime;
    const o1 = osc('sawtooth', 48, t);
    const o2 = osc('triangle', 52, t);
    o2.detune.value = 8;
    const noise = c.createBufferSource();
    noise.buffer = noiseBuf(2, 'brown');
    noise.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const g = c.createGain();
    g.gain.value = 0.055;
    o1.connect(lp);
    o2.connect(lp);
    noise.connect(lp);
    lp.connect(g);
    g.connect(master);
    o1.start();
    o2.start();
    noise.start();
    thrustNodes = { o1, o2, noise, g };
  } else if (!on && thrustNodes) {
    try {
      thrustNodes.o1.stop();
      thrustNodes.o2.stop();
      thrustNodes.noise.stop();
    } catch (_) {}
    thrustNodes = null;
  }
}
