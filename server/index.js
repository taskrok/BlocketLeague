// ============================================
// Blocket League - Game Server
// ============================================

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GameRoom } from './GameRoom.js';

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
app.use(express.static(join(__dirname, '..', 'dist')));

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  const indexPath = join(__dirname, '..', 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).send('Not found');
    }
  });
});

// ========== ROOM MANAGEMENT ==========

const rooms = new Map();
let roomCounter = 0;

function getOrCreateRoom() {
  // Find a room that isn't full
  for (const [id, room] of rooms) {
    if (!room.isFull()) {
      return room;
    }
  }
  // Create new room
  const roomId = `room_${++roomCounter}`;
  const room = new GameRoom(io, roomId);
  rooms.set(roomId, room);
  console.log(`Created room: ${roomId}`);
  return room;
}

// Map socketId → room for quick lookup
const playerRooms = new Map();

// ========== SOCKET HANDLERS ==========

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('joinGame', (data) => {
    const variantConfig = data && data.variantConfig ? data.variantConfig : {};
    const room = getOrCreateRoom();
    room.addPlayer(socket, variantConfig);
    playerRooms.set(socket.id, room);
    console.log(`Player ${socket.id} joined ${room.roomId}`);
  });

  socket.on('input', (input) => {
    const room = playerRooms.get(socket.id);
    if (room) {
      room.receiveInput(socket.id, input);
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
