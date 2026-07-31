/** Desktop + mobile input */

export function createInput({ onAction, isMobile }) {
  const state = {
    rotating: 0,
    thrusting: false,
    keys: new Set(),
  };

  let seq = 0;
  let actionQueue = [];

  function recompute() {
    let rot = 0;
    if (state.keys.has('ArrowLeft') || state.keys.has('a') || state.keys.has('A')) rot -= 1;
    if (state.keys.has('ArrowRight') || state.keys.has('d') || state.keys.has('D')) rot += 1;
    // mobile stick overrides when set
    if (state._stickRot != null) rot = state._stickRot;
    state.rotating = Math.max(-1, Math.min(1, rot));
    const thrustKey = state.keys.has(' ') || state.keys.has('ArrowUp') || state.keys.has('w') || state.keys.has('W');
    state.thrusting = thrustKey || !!state._thrustTouch;
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', ' ', 'a', 'A', 'd', 'D', 'w', 'W'].includes(e.key)) {
      e.preventDefault();
    }
    state.keys.add(e.key);
    recompute();
  }

  function onKeyUp(e) {
    state.keys.delete(e.key);
    recompute();
  }

  function queueAction(action) {
    actionQueue.push(action);
  }

  // Mobile dual-stick-ish: left stick = rotate only
  function bindMobile() {
    const zone = document.getElementById('stick-rotate');
    const knob = zone?.querySelector('.stick-knob');
    const thrustBtn = document.getElementById('btn-thrust');
    if (!zone || !thrustBtn) return;

    const maxR = 36;
    let activeId = null;

    function setKnob(dx, dy) {
      if (knob) knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }

    function handleStick(clientX, clientY) {
      const rect = zone.querySelector('.stick-base').getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = clientX - cx;
      let dy = clientY - cy;
      const len = Math.hypot(dx, dy) || 1;
      if (len > maxR) {
        dx = (dx / len) * maxR;
        dy = (dy / len) * maxR;
      }
      setKnob(dx, dy);
      // Horizontal = rotate; deadzone
      const nx = dx / maxR;
      if (Math.abs(nx) < 0.15) state._stickRot = 0;
      else state._stickRot = Math.max(-1, Math.min(1, nx));
      recompute();
    }

    function endStick() {
      activeId = null;
      state._stickRot = 0;
      setKnob(0, 0);
      recompute();
    }

    zone.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        const t = e.changedTouches[0];
        activeId = t.identifier;
        handleStick(t.clientX, t.clientY);
      },
      { passive: false }
    );
    zone.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier === activeId) handleStick(t.clientX, t.clientY);
        }
      },
      { passive: false }
    );
    zone.addEventListener(
      'touchend',
      (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === activeId) endStick();
        }
      },
      { passive: false }
    );
    zone.addEventListener('touchcancel', endStick, { passive: false });

    const thrustOn = (e) => {
      e.preventDefault();
      state._thrustTouch = true;
      thrustBtn.classList.add('active');
      recompute();
    };
    const thrustOff = (e) => {
      e.preventDefault();
      state._thrustTouch = false;
      thrustBtn.classList.remove('active');
      recompute();
    };
    thrustBtn.addEventListener('touchstart', thrustOn, { passive: false });
    thrustBtn.addEventListener('touchend', thrustOff, { passive: false });
    thrustBtn.addEventListener('touchcancel', thrustOff, { passive: false });
    thrustBtn.addEventListener('mousedown', thrustOn);
    window.addEventListener('mouseup', thrustOff);
  }

  function enable() {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    if (isMobile()) {
      document.getElementById('mobile-controls')?.classList.add('show');
      bindMobile();
    }
  }

  function disable() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    state.keys.clear();
    state.rotating = 0;
    state.thrusting = false;
    state._stickRot = null;
    state._thrustTouch = false;
    document.getElementById('mobile-controls')?.classList.remove('show');
  }

  function poll() {
    const actions = actionQueue.splice(0);
    seq++;
    return {
      rotating: state.rotating,
      thrusting: state.thrusting,
      action: actions[0] || null,
      actions, // if multiple voice in one frame
      seq,
    };
  }

  function flushActions() {
    return actionQueue.splice(0);
  }

  return {
    enable,
    disable,
    poll,
    queueAction,
    flushActions,
    get state() {
      return state;
    },
  };
}

export function detectMobile() {
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  );
}
