import { net } from './net.js';
import { audio } from './audio.js';
import {
  showScreen,
  toast,
  initLanding,
  updateLobbyUI,
  bindLobbyControls,
  showResults,
  getPlayerName,
} from './screens.js';
import { createEditor } from './editor.js';
import { createGameController } from './game.js';
import { playOpeningIntro } from './intro.js';

const state = {
  youId: null,
  room: null,
};

// Fix shared imports for static server (relative from client/js)
// constants are loaded via /shared path — ensure import paths work.
// Vite-less: browser resolves ../../shared from /js/main.js -> /shared — good when served from root.

const game = createGameController(state, showScreen, toast);

let editor = null;
function getMap() {
  return state.room?.map || { wells: [], asteroids: [], walls: [], movers: [], wormholes: [] };
}
function setMap(map) {
  if (state.room) state.room.map = map;
}

function isHost() {
  return state.room && state.room.hostId === state.youId;
}

function ensureEditor() {
  if (editor) return editor;
  editor = createEditor(
    document.getElementById('editor-canvas'),
    getMap,
    setMap,
    isHost
  );
  return editor;
}

// Boot
net.connect();
initLanding(state);
bindLobbyControls(state);

// 1980s voice + 16-bit intro (≤20s; once per browser session)
playOpeningIntro();

// Deep link ?room=CODE
const params = new URLSearchParams(location.search);
const deepRoom = params.get('room');
if (deepRoom) {
  document.getElementById('code-input').value = deepRoom.toUpperCase();
}

net.on('connect', ({ id }) => {
  state.youId = id || net.id;
});

net.on('connected', ({ id }) => {
  state.youId = id;
});

net.on('error_msg', ({ error }) => {
  toast(error || 'Something went wrong');
});

net.on('room_joined', ({ you, state: roomState }) => {
  state.youId = you || net.id;
  state.room = roomState;
  game.stop();
  ensureEditor().stop();
  if (roomState.phase === 'editor') {
    if (roomState.hostId === state.youId) {
      showScreen('editor');
      ensureEditor().start();
    } else {
      showScreen('lobby');
      updateLobbyUI(state);
      toast('Host is editing the map…', true);
    }
  } else if (roomState.phase === 'playing') {
    // shouldn't join mid-game usually
    game.start();
  } else {
    showScreen('lobby');
    updateLobbyUI(state);
  }
  audio.ui();
  // clean URL
  if (roomState.code) {
    history.replaceState(null, '', `?room=${roomState.code}`);
  }
});

net.on('room_update', (roomState) => {
  state.room = roomState;
  if (roomState.phase === 'lobby') {
    if (!document.getElementById('screen-lobby').classList.contains('active') &&
        !document.getElementById('screen-editor').classList.contains('active')) {
      showScreen('lobby');
    }
    updateLobbyUI(state);
  } else if (roomState.phase === 'editor') {
    updateLobbyUI(state);
  }
});

net.on('host_changed', ({ hostId }) => {
  if (state.room) state.room.hostId = hostId;
  updateLobbyUI(state);
  toast(hostId === state.youId ? 'You are now the host' : 'Host transferred', true);
});

net.on('phase', ({ phase, state: roomState }) => {
  if (roomState) state.room = roomState;
  if (phase === 'lobby') {
    game.stop();
    ensureEditor().stop();
    showScreen('lobby');
    updateLobbyUI(state);
  } else if (phase === 'editor') {
    game.stop();
    if (isHost()) {
      showScreen('editor');
      ensureEditor().start();
    } else {
      ensureEditor().stop();
      showScreen('lobby');
      updateLobbyUI(state);
      toast('Host is editing the map…', true);
    }
  }
});

net.on('map_update', ({ map }) => {
  if (state.room) state.room.map = map;
});

net.on('match_start', (roomState) => {
  if (roomState?.players) {
    // match_start sends publicState
    state.room = { ...state.room, ...roomState, phase: 'playing' };
  } else if (roomState) {
    state.room = { ...state.room, ...roomState, phase: 'playing' };
  }
  ensureEditor().stop();
  game.start();
});

net.on('match_end', (data) => {
  game.stop();
  if (data.state) state.room = data.state;
  showResults(state, data);
});

net.on('left_room', () => {
  game.stop();
  ensureEditor().stop();
  state.room = null;
  showScreen('landing');
  history.replaceState(null, '', '/');
  net.listLobbies();
});

// Editor buttons
document.getElementById('btn-editor-back').addEventListener('click', () => {
  if (isHost()) {
    net.returnLobby();
  }
  ensureEditor().stop();
  showScreen('lobby');
  updateLobbyUI(state);
});

document.getElementById('btn-editor-start').addEventListener('click', () => {
  if (isHost()) {
    net.setMap(getMap());
    net.startMatch();
  }
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  if (isHost()) net.playAgain();
});

document.getElementById('btn-results-leave').addEventListener('click', () => {
  net.leaveRoom();
});

// Auto-join deep link once connected
let deepTried = false;
net.on('connect', () => {
  if (deepRoom && !deepTried && !state.room) {
    deepTried = true;
    // small delay for name
    setTimeout(() => {
      if (!state.room) net.joinRoom(deepRoom, getPlayerName());
    }, 300);
  }
});

// Unlock audio on first gesture
window.addEventListener(
  'pointerdown',
  () => {
    audio.unlock();
  },
  { once: true }
);

console.log('Space Wars X ready');
