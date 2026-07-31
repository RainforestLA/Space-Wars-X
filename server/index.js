import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { generateRoomCode, MAX_PLAYERS } from '../shared/constants.js';
import { Room } from './game/room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 20000,
});

const rooms = new Map(); // code -> Room
const socketRoom = new Map(); // socketId -> code

// Static files
const distPath = path.join(root, 'dist');
const clientPath = path.join(root, 'client');
if (isProd && fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.use(express.static(clientPath));
  // Serve shared modules
  app.use('/shared', express.static(path.join(root, 'shared')));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(clientPath, 'index.html'));
  });
}

function uniqueCode() {
  for (let i = 0; i < 50; i++) {
    const c = generateRoomCode();
    if (!rooms.has(c)) return c;
  }
  return generateRoomCode() + generateRoomCode().slice(0, 2);
}

function getPublicLobbies() {
  const list = [];
  for (const room of rooms.values()) {
    if (!room.isPublic) continue;
    if (room.phase === 'playing' || room.phase === 'results') continue;
    if (room.players.size >= MAX_PLAYERS) continue;
    list.push({
      code: room.code,
      players: room.players.size,
      maxPlayers: MAX_PLAYERS,
      mode: room.mode,
      phase: room.phase,
    });
  }
  return list.slice(0, 20);
}

io.on('connection', (socket) => {
  socket.emit('connected', { id: socket.id });

  socket.on('list_lobbies', () => {
    socket.emit('lobbies', getPublicLobbies());
  });

  socket.on('create_room', ({ name, isPublic }) => {
    leaveCurrent(socket);
    const code = uniqueCode();
    const room = new Room(code, socket.id, name, !!isPublic);
    const result = room.addPlayer(socket.id, name, socket);
    if (!result.ok) {
      socket.emit('error_msg', { error: result.error });
      return;
    }
    rooms.set(code, room);
    socketRoom.set(socket.id, code);
    socket.join(code);
    socket.emit('room_joined', {
      you: socket.id,
      state: room.publicState(),
    });
    broadcastLobbies();
  });

  socket.on('join_room', ({ code, name }) => {
    const c = String(code || '')
      .toUpperCase()
      .trim();
    const room = rooms.get(c);
    if (!room) {
      socket.emit('error_msg', { error: 'Room not found' });
      return;
    }
    leaveCurrent(socket);
    const result = room.addPlayer(socket.id, name, socket);
    if (!result.ok) {
      socket.emit('error_msg', { error: result.error });
      return;
    }
    socketRoom.set(socket.id, c);
    socket.join(c);
    socket.emit('room_joined', {
      you: socket.id,
      state: room.publicState(),
    });
    room.emitAll('room_update', room.publicState());
    broadcastLobbies();
  });

  socket.on('set_mode', ({ mode, teamCount }) => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase === 'playing') return;
    room.setMode(mode, teamCount);
    room.emitAll('room_update', room.publicState());
    broadcastLobbies();
  });

  socket.on('set_team', ({ team }) => {
    const room = roomOf(socket);
    if (!room) return;
    if (room.phase === 'playing') return;
    room.setTeam(socket.id, team);
    room.emitAll('room_update', room.publicState());
  });

  socket.on('set_name', ({ name }) => {
    const room = roomOf(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) {
      p.name = String(name || 'Pilot').slice(0, 16);
      room.emitAll('room_update', room.publicState());
    }
  });

  socket.on('set_public', ({ isPublic }) => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    room.isPublic = !!isPublic;
    room.emitAll('room_update', room.publicState());
    broadcastLobbies();
  });

  socket.on('set_fragmenting', ({ fragmentingAsteroids }) => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase === 'playing') return;
    room.setFragmentingAsteroids(!!fragmentingAsteroids);
    room.emitAll('room_update', room.publicState());
  });

  socket.on('enter_editor', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    room.enterEditor();
  });

  socket.on('set_map', ({ map }) => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    room.setMap(map);
    room.emitAll('map_update', { map: room.map });
  });

  socket.on('start_match', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 1) {
      socket.emit('error_msg', { error: 'Need at least 1 player' });
      return;
    }
    room.startMatch();
    broadcastLobbies();
  });

  socket.on('input', (input) => {
    const room = roomOf(socket);
    if (!room) return;
    room.setInput(socket.id, input || {});
  });

  socket.on('play_again', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    room.returnToLobby();
    broadcastLobbies();
  });

  socket.on('return_lobby', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    room.returnToLobby();
    broadcastLobbies();
  });

  socket.on('leave_room', () => {
    leaveCurrent(socket);
    socket.emit('left_room');
    broadcastLobbies();
  });

  socket.on('disconnect', () => {
    leaveCurrent(socket);
    broadcastLobbies();
  });
});

function roomOf(socket) {
  const code = socketRoom.get(socket.id);
  return code ? rooms.get(code) : null;
}

function leaveCurrent(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRoom.delete(socket.id);
  socket.leave(code);
  if (!room) return;
  const result = room.removePlayer(socket.id);
  if (result.empty) {
    room.stopLoop();
    rooms.delete(code);
  } else {
    room.emitAll('room_update', room.publicState());
  }
}

function broadcastLobbies() {
  io.emit('lobbies', getPublicLobbies());
}

httpServer.listen(PORT, () => {
  console.log(`Space Wars X server running on http://localhost:${PORT}`);
});
