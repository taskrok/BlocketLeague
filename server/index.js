// ============================================
// Blocket League - Game Server
// ============================================

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GameRoom } from './GameRoom.js';
import { decodeInput } from '../shared/BinaryProtocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3001;

// Serve static files from dist (production build)
// Check both possible build output locations
import { existsSync } from 'fs';
const distPath = existsSync(join(__dirname, '..', 'dist', 'index.html'))
  ? join(__dirname, '..', 'dist')
  : join(__dirname, '..', 'client', 'dist');

app.use(express.static(distPath));

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(join(distPath, 'index.html'), (err) => {
    if (err) {
      res.status(404).send('Not found');
    }
  });
});

// ========== ROOM MANAGEMENT ==========

const rooms = new Map();     // code → GameRoom
const playerRooms = new Map(); // socketId → GameRoom

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // exclude I, O
const ROOM_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

// ========== SOCKET HANDLERS ==========

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('createRoom', (data) => {
    const mode = data && data.mode === '2v2' ? '2v2' : '1v1';
    const maxPlayers = mode === '2v2' ? 4 : 2;
    const variantConfig = data && data.variantConfig ? data.variantConfig : {};

    const code = generateRoomCode();
    const room = new GameRoom(io, code, maxPlayers);
    rooms.set(code, room);

    room.addPlayer(socket, variantConfig);
    playerRooms.set(socket.id, room);

    socket.emit('roomCreated', { code, mode });
    console.log(`Room ${code} created (${mode}) by ${socket.id}`);

    // Expire unfilled rooms after 5 minutes
    setTimeout(() => {
      if (rooms.has(code) && !rooms.get(code).isFull()) {
        const r = rooms.get(code);
        r.players.filter(p => p).forEach(p => {
          p.socket.emit('roomExpired', {});
        });
        r._stopLoops();
        rooms.delete(code);
        console.log(`Room ${code} expired`);
      }
    }, ROOM_EXPIRY_MS);
  });

  socket.on('joinRoom', (data) => {
    const code = (data && data.code || '').toUpperCase().trim();
    const variantConfig = data && data.variantConfig ? data.variantConfig : {};

    const room = rooms.get(code);
    if (!room) {
      socket.emit('joinError', { message: 'Room not found' });
      return;
    }
    if (room.isFull()) {
      socket.emit('joinError', { message: 'Room is full' });
      return;
    }

    room.addPlayer(socket, variantConfig);
    playerRooms.set(socket.id, room);
    console.log(`Player ${socket.id} joined room ${code}`);
  });

  socket.on('switchTeam', () => {
    const room = playerRooms.get(socket.id);
    if (room) {
      room.switchTeam(socket.id);
    }
  });

  socket.on('input', (data) => {
    const room = playerRooms.get(socket.id);
    if (room) {
      // Support both binary (ArrayBuffer/Buffer) and legacy JSON input
      const input = (Buffer.isBuffer(data) || data instanceof ArrayBuffer)
        ? decodeInput(data)
        : data;
      room.receiveInput(socket.id, input);
    }
  });

  // RTT measurement
  socket.on('ping_measure', () => {
    socket.volatile.emit('pong_measure');
  });

  socket.on('report_rtt', (rtt) => {
    const room = playerRooms.get(socket.id);
    if (room && typeof rtt === 'number') {
      room.setPlayerPing(socket.id, Math.min(Math.round(rtt), 999));
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    const room = playerRooms.get(socket.id);
    if (room) {
      room.removePlayer(socket.id);
      playerRooms.delete(socket.id);

      // Clean up empty rooms
      if (room.isEmpty()) {
        rooms.delete(room.roomId);
        console.log(`Removed empty room: ${room.roomId}`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Blocket League server running on port ${PORT}`);
});
