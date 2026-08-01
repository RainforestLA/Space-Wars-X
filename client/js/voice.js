/** Voice commands via Web Speech API */

const COMMANDS = {
  photon: ['photon', 'photons', 'torpedo', 'missile'],
  laser: ['laser', 'lasers', 'beam'],
  shield: ['shield', 'shields', 'defend'],
  hyperspace: ['hyperspace', 'hyper space', 'hyper', 'warp', 'jump'],
  // Hidden special — not shown in HUD
  nuke: ['nuke', 'nuclear', 'pulsewave', 'pulse wave'],
};

export function createVoice(onCommand) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let active = false;
  let wanted = true;
  let lastFire = 0;
  const COOLDOWN_MS = 400;

  function matchCommand(transcript) {
    const t = transcript.toLowerCase().trim();
    for (const [cmd, words] of Object.entries(COMMANDS)) {
      for (const w of words) {
        if (t === w || t.includes(w)) return cmd;
      }
    }
    return null;
  }

  function start() {
    if (!SpeechRecognition) {
      onStatus('unsupported');
      return false;
    }
    wanted = true;
    if (recognition) {
      try {
        recognition.start();
      } catch (_) {}
      return true;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 3;

    recognition.onstart = () => {
      active = true;
      onStatus('listening');
    };

    recognition.onend = () => {
      active = false;
      onStatus('restarting');
      if (wanted) {
        setTimeout(() => {
          try {
            recognition.start();
          } catch (_) {}
        }, 250);
      } else {
        onStatus('off');
      }
    };

    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wanted = false;
        onStatus('denied');
      } else if (e.error === 'no-speech') {
        // ignore, will restart
      } else {
        onStatus('error');
      }
    };

    recognition.onresult = (event) => {
      const now = Date.now();
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        // Prefer final; also check strong interim for snappiness
        const use = result.isFinal || result[0].confidence > 0.5 || result[0].transcript.length > 2;
        if (!use) continue;
        for (let a = 0; a < result.length; a++) {
          const cmd = matchCommand(result[a].transcript);
          if (cmd && now - lastFire > COOLDOWN_MS) {
            lastFire = now;
            onCommand(cmd);
            return;
          }
        }
      }
    };

    try {
      recognition.start();
      return true;
    } catch (e) {
      onStatus('error');
      return false;
    }
  }

  function stop() {
    wanted = false;
    if (recognition) {
      try {
        recognition.stop();
      } catch (_) {}
    }
    onStatus('off');
  }

  function onStatus() {}

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
