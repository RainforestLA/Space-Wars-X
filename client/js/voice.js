/**
 * High-responsiveness voice commands for Space Wars X.
 * Tuned for desktop + mobile: dual recognition where useful,
 * aggressive interim matching, quick restarts, per-command cooldowns.
 */

const COMMANDS = {
  photon: [
    'photon',
    'photons',
    'foe ton',
    'foeton',
    'foton',
    'torpedo',
    'torpedos',
    'torpedoes',
    'missile',
    'missiles',
  ],
  laser: ['laser', 'lasers', 'lazer', 'lazers', 'blaster', 'blasters', 'beam', 'beams', 'phaser', 'phasers'],
  shield: ['shield', 'shields', 'sheild', 'sheilds', 'defend', 'deflector', 'deflectors'],
  hyperspace: [
    'hyperspace',
    'hyper space',
    'hyper-space',
    'hyper',
    'warp',
    'jump',
    'hyperspeed',
    'hyper speed',
  ],
  // Hidden special
  nuke: ['nuke', 'nuclear', 'pulsewave', 'pulse wave', 'pulse', 'nukes'],
};

/** Min gap between the SAME command (allows laser spam vs photon spam differently) */
const CMD_COOLDOWN_MS = {
  photon: 350,
  laser: 280,
  shield: 400,
  hyperspace: 500,
  nuke: 600,
};

/** Global floor so two different commands can fire nearly back-to-back */
const GLOBAL_MIN_GAP_MS = 120;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchCommand(transcript) {
  const t = normalize(transcript);
  if (!t) return null;

  // Prefer longer phrases first (hyperspace before hyper)
  const ranked = [];
  for (const [cmd, words] of Object.entries(COMMANDS)) {
    for (const w of words) {
      ranked.push({ cmd, w, len: w.length });
    }
  }
  ranked.sort((a, b) => b.len - a.len);

  for (const { cmd, w } of ranked) {
    if (t === w) return cmd;
    // Word-boundary style match so "blast" alone doesn't steal "blaster" wrongly
    if (t.includes(w)) {
      // Avoid matching "hyper" inside unrelated longer junk poorly
      const re = new RegExp(`(?:^|\\s)${w.replace(/\s+/g, '\\s+')}(?:$|\\s)`, 'i');
      if (re.test(t) || t.endsWith(w) || t.startsWith(w)) return cmd;
    }
  }

  // Mobile often returns partials: "lase", "phot", "shiel", "warp"
  const partials = [
    [/^lase?r?s?$/, 'laser'],
    [/^phot(on)?s?$/, 'photon'],
    [/^foe?t(on)?s?$/, 'photon'],
    [/^shie?l?d?s?$/, 'shield'],
    [/^warp$/, 'hyperspace'],
    [/^jump$/, 'hyperspace'],
    [/^hyper/, 'hyperspace'],
    [/^nuke/, 'nuke'],
    [/^nuk/, 'nuke'],
  ];
  const tokens = t.split(' ');
  for (const tok of tokens) {
    for (const [re, cmd] of partials) {
      if (re.test(tok)) return cmd;
    }
  }
  return null;
}

export function createVoice(onCommand) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let primary = null;
  let secondary = null; // optional second engine for mobile coverage gaps
  let active = false;
  let wanted = false;
  let lastFireGlobal = 0;
  const lastFireCmd = Object.create(null);
  let restartTimer = null;
  let watchdogTimer = null;
  let lastResultAt = 0;

  function onStatus() {}

  function canFire(cmd) {
    const now = Date.now();
    if (now - lastFireGlobal < GLOBAL_MIN_GAP_MS) return false;
    const cd = CMD_COOLDOWN_MS[cmd] ?? 400;
    if (now - (lastFireCmd[cmd] || 0) < cd) return false;
    return true;
  }

  function fire(cmd) {
    if (!canFire(cmd)) return false;
    const now = Date.now();
    lastFireGlobal = now;
    lastFireCmd[cmd] = now;
    try {
      onCommand(cmd);
    } catch (e) {
      console.error(e);
    }
    return true;
  }

  function handleResult(event) {
    lastResultAt = Date.now();
    // Scan newest first for snappier interim hits
    for (let i = event.results.length - 1; i >= event.resultIndex; i--) {
      const result = event.results[i];
      // Use ALL alternatives on interim + final — mobile needs this
      for (let a = 0; a < result.length; a++) {
        const transcript = result[a].transcript || '';
        const conf = result[a].confidence;
        // Accept interim aggressively (mobile often never finalizes quickly)
        const ok =
          result.isFinal ||
          conf === undefined ||
          conf === 0 || // Chrome often reports 0 on interim
          conf > 0.15 ||
          transcript.trim().length >= 3;
        if (!ok) continue;
        const cmd = matchCommand(transcript);
        if (cmd && fire(cmd)) return;
      }
    }
  }

  function wire(rec, label) {
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.maxAlternatives = 5;

    rec.onstart = () => {
      active = true;
      lastResultAt = Date.now();
      onStatus('listening');
    };

    rec.onresult = handleResult;

    rec.onerror = (e) => {
      const err = e.error || '';
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        wanted = false;
        onStatus('denied');
        return;
      }
      // no-speech / aborted / network → restart quickly
      if (wanted && err !== 'aborted') {
        scheduleRestart(label === 'primary' ? 80 : 120);
      }
    };

    rec.onend = () => {
      active = false;
      if (wanted) {
        // Mobile Safari/Chrome drop continuous mode often — restart ASAP
        scheduleRestart(60);
      } else {
        onStatus('off');
      }
    };
  }

  function scheduleRestart(delayMs) {
    if (!wanted) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!wanted) return;
      tryStart(primary);
      // Secondary staggered so they don't fight as hard
      if (secondary) {
        setTimeout(() => tryStart(secondary), 180);
      }
    }, delayMs);
  }

  function tryStart(rec) {
    if (!rec || !wanted) return;
    try {
      rec.start();
    } catch (_) {
      // InvalidStateError if already started — ignore
    }
  }

  function startWatchdog() {
    clearInterval(watchdogTimer);
    // If no results for a while on mobile, force-cycle recognition
    watchdogTimer = setInterval(() => {
      if (!wanted) return;
      const idle = Date.now() - lastResultAt;
      // After 4s silence, bounce the engines (helps stuck mobile sessions)
      if (idle > 4000) {
        lastResultAt = Date.now();
        try {
          primary?.stop();
        } catch (_) {}
        try {
          secondary?.stop();
        } catch (_) {}
        scheduleRestart(50);
      }
    }, 1500);
  }

  function start() {
    if (!SpeechRecognition) {
      onStatus('unsupported');
      return false;
    }
    wanted = true;
    lastResultAt = Date.now();

    if (!primary) {
      primary = new SpeechRecognition();
      wire(primary, 'primary');

      // Second recognizer: some mobile browsers deliver better interim on a second instance
      // after the first ends; keep both continuous for redundancy when supported
      try {
        secondary = new SpeechRecognition();
        wire(secondary, 'secondary');
      } catch (_) {
        secondary = null;
      }
    }

    tryStart(primary);
    if (secondary) {
      setTimeout(() => tryStart(secondary), 300);
    }
    startWatchdog();
    return true;
  }

  function stop() {
    wanted = false;
    clearTimeout(restartTimer);
    clearInterval(watchdogTimer);
    try {
      primary?.stop();
    } catch (_) {}
    try {
      secondary?.abort?.();
      secondary?.stop?.();
    } catch (_) {}
    active = false;
    onStatus('off');
  }

  return {
    start,
    stop,
    isSupported: !!SpeechRecognition,
    setStatusHandler(fn) {
      onStatus = fn;
    },
    get active() {
      return active;
    },
  };
}
