import { io } from 'socket.io-client';

const handlers = new Map();

export const net = {
  socket: null,
  id: null,
  connected: false,

  connect() {
    if (this.socket) return this.socket;
    const url = window.location.origin;
    this.socket = io(url, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 12,
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this.id = this.socket.id;
      emitLocal('connect', { id: this.id });
    });

    this.socket.on('disconnect', () => {
      this.connected = false;
      emitLocal('disconnect');
    });

    const events = [
      'connected',
      'room_joined',
      'room_update',
      'phase',
      'map_update',
      'match_start',
      'snapshot',
      'match_end',
      'host_changed',
      'lobbies',
      'error_msg',
      'left_room',
    ];
    for (const ev of events) {
      this.socket.on(ev, (data) => emitLocal(ev, data));
    }

    return this.socket;
  },

  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => handlers.get(event)?.delete(fn);
  },

  emit(event, data) {
    this.socket?.emit(event, data);
  },

  createRoom(name, isPublic = false) {
    this.emit('create_room', { name, isPublic });
  },

  joinRoom(code, name) {
    this.emit('join_room', { code, name });
  },

  leaveRoom() {
    this.emit('leave_room');
  },

  listLobbies() {
    this.emit('list_lobbies');
  },

  setMode(mode, teamCount) {
    this.emit('set_mode', { mode, teamCount });
  },

  setTeam(team) {
    this.emit('set_team', { team });
  },

  setPublic(isPublic) {
    this.emit('set_public', { isPublic });
  },

  setFragmenting(fragmentingAsteroids) {
    this.emit('set_fragmenting', { fragmentingAsteroids });
  },

  setName(name) {
    this.emit('set_name', { name });
  },

  enterEditor() {
    this.emit('enter_editor');
  },

  setMap(map) {
    this.emit('set_map', { map });
  },

  startMatch() {
    this.emit('start_match');
  },

  sendInput(input) {
    this.emit('input', input);
  },

  playAgain() {
    this.emit('play_again');
  },

  returnLobby() {
    this.emit('return_lobby');
  },
};

function emitLocal(event, data) {
  const set = handlers.get(event);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(data);
    } catch (e) {
      console.error(e);
    }
  }
}
