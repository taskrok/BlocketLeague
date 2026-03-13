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
import {
  initDatabase, generatePlayerId, ensurePlayer,
  getPlayerStats, getLeaderboard, getMatchHistory,
} from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Disable per-message compression: adds CPU overhead and latency for
  // small binary packets (~100-200 bytes). Net negative for real-time games.
  perMessageDeflate: false,
  // Allow binary data up to 1KB (our largest packet is ~200 bytes for 4 players)
  maxHttpBufferSize: 1024,
  // Prefer websocket transport, skip polling upgrade dance
  transports: ['websocket'],
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

const rooms = new Map();     // code -> GameRoom
const playerRooms = new Map(); // socketId -> GameRoom

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

// ========== MATCHMAKING QUEUE ==========

// Map keyed by mode ('1v1', '2v2'), value is array of queue entries
const matchmakingQueue = new Map([
  ['1v1', []],
  ['2v2', []],
]);

// Map socketId -> mode (to remove on disconnect/cancel)
const playerQueues = new Map();

// Queue timeout timers: Map socketId -> timeoutId
const queueTimeouts = new Map();

const QUEUE_TIMEOUT_MS = 30 * 1000; // 30 seconds before filling with bots

function addToQueue(socket, mode, variantConfig, playerName) {
  const queue = matchmakingQueue.get(mode);
  if (!queue) return;

  // Don't double-queue
  if (playerQueues.has(socket.id)) return;

  const entry = {
    socketId: socket.id,
    socket,
    playerId: playerIds.get(socket.id) || null,
    variantConfig: variantConfig || {},
    playerName: playerName || '',
    timestamp: Date.now(),
  };

  queue.push(entry);
  playerQueues.set(socket.id, mode);

  const requiredPlayers = mode === '2v2' ? 4 : 2;

  // Broadcast queue update to all waiting players in this mode
  broadcastQueueUpdate(mode);

  // Check if we have enough players to start
  if (queue.length >= requiredPlayers) {
    const matched = queue.splice(0, requiredPlayers);
    startMatchedGame(matched, mode);
  } else {
    // Set timeout: after 30s, fill with bots and start
    const timeoutId = setTimeout(() => {
      // Player might have left queue already
      if (!playerQueues.has(socket.id)) return;
      // Start with however many players are queued (fill rest with bots)
      const currentQueue = matchmakingQueue.get(mode);
      // Find entries that include this socket (could have been matched already)
      const stillQueued = currentQueue.filter(e => playerQueues.has(e.socketId));
      if (stillQueued.length > 0) {
        // Remove all these entries from queue
        const toStart = stillQueued.splice(0, stillQueued.length);
        // Clear from matchmaking queue
        const remaining = currentQueue.filter(e => !toStart.find(t => t.socketId === e.socketId));
        matchmakingQueue.set(mode, remaining);
        startMatchedGame(toStart, mode);
      }
    }, QUEUE_TIMEOUT_MS);

    queueTimeouts.set(socket.id, timeoutId);
  }
}

function removeFromQueue(socketId) {
  const mode = playerQueues.get(socketId);
  if (!mode) return;

  playerQueues.delete(socketId);

  const queue = matchmakingQueue.get(mode);
  if (queue) {
    const idx = queue.findIndex(e => e.socketId === socketId);
    if (idx !== -1) queue.splice(idx, 1);
    broadcastQueueUpdate(mode);
  }

  // Clear timeout
  const timeoutId = queueTimeouts.get(socketId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    queueTimeouts.delete(socketId);
  }
}

function broadcastQueueUpdate(mode) {
  const queue = matchmakingQueue.get(mode);
  if (!queue) return;

  const requiredPlayers = mode === '2v2' ? 4 : 2;
  queue.forEach((entry, index) => {
    entry.socket.emit('queueUpdate', {
      position: index + 1,
      playersInQueue: queue.length,
      playersNeeded: requiredPlayers,
      mode,
    });
  });
}

function startMatchedGame(players, mode) {
  const maxPlayers = mode === '2v2' ? 4 : 2;
  const code = generateRoomCode();
  const room = new GameRoom(io, code, maxPlayers);
  rooms.set(code, room);

  // Add real players
  for (const entry of players) {
    // Clear their queue state
    playerQueues.delete(entry.socketId);
    const timeoutId = queueTimeouts.get(entry.socketId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      queueTimeouts.delete(entry.socketId);
    }

    room.addPlayer(entry.socket, entry.variantConfig, entry.playerName, entry.playerId);
    playerRooms.set(entry.socketId, room);
  }

  // Notify matched players
  for (const entry of players) {
    entry.socket.emit('matchFound', { code, mode });
  }

  // Fill remaining slots with bots
  const filledSlots = players.length;
  if (filledSlots < maxPlayers) {
    room.fillWithBots(filledSlots);
  }

  console.log(`Quick match started: room ${code} (${mode}) with ${filledSlots} players + ${maxPlayers - filledSlots} bots`);
}

// ========== PLAYER ID TRACKING ==========

// Map socketId -> playerId (persistent UUID)
const playerIds = new Map();

// ========== SOCKET HANDLERS ==========

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Resolve persistent player ID from handshake query
  let playerId = socket.handshake.query.playerId;
  if (!playerId || typeof playerId !== 'string' || playerId.length < 10) {
    playerId = generatePlayerId();
  }
  playerIds.set(socket.id, playerId);

  // Ensure player exists in database and send back ID
  const playerName = socket.handshake.query.playerName || '';
  ensurePlayer(playerId, playerName);
  socket.emit('playerId', { playerId });

  socket.on('createRoom', (data) => {
    const mode = data && data.mode === '2v2' ? '2v2' : '1v1';
    const maxPlayers = mode === '2v2' ? 4 : 2;
    const variantConfig = data && data.variantConfig ? data.variantConfig : {};
    const playerName = (data && data.playerName) || '';

    const code = generateRoomCode();
    const room = new GameRoom(io, code, maxPlayers);
    rooms.set(code, room);

    room.addPlayer(socket, variantConfig, playerName, playerIds.get(socket.id));
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
    const playerName = (data && data.playerName) || '';

    const room = rooms.get(code);
    if (!room) {
      socket.emit('joinError', { message: 'Room not found' });
      return;
    }
    if (room.isFull()) {
      socket.emit('joinError', { message: 'Room is full' });
      return;
    }

    room.addPlayer(socket, variantConfig, playerName, playerIds.get(socket.id));
    playerRooms.set(socket.id, room);
    console.log(`Player ${socket.id} joined room ${code}`);
  });

  socket.on('quickMatch', (data) => {
    const variantConfig = data && data.variantConfig ? data.variantConfig : {};
    const playerName = (data && data.playerName) || '';
    const mode = (data && data.mode === '2v2') ? '2v2' : '1v1';

    addToQueue(socket, mode, variantConfig, playerName);
    console.log(`Player ${socket.id} queued for ${mode} quick match`);
  });

  socket.on('cancelQueue', () => {
    removeFromQueue(socket.id);
    console.log(`Player ${socket.id} cancelled queue`);
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

  // Quick-chat relay: broadcast to all players in the room
  socket.on('replaySkip', () => {
    const room = playerRooms.get(socket.id);
    if (room) room.replaySkip(socket.id);
  });

  socket.on('quickChat', (data) => {
    const room = playerRooms.get(socket.id);
    if (!room) return;
    // Find the player's slot index
    const playerIdx = room.players.findIndex(p => p && p.socket && p.socket.id === socket.id);
    if (playerIdx < 0) return;
    const msgIndex = typeof data === 'object' ? data.msgIndex : data;
    if (typeof msgIndex !== 'number' || msgIndex < 0 || msgIndex > 11) return;
    // Broadcast to all players in the room (including sender for consistency)
    room.players.forEach(p => {
      if (p && p.socket) {
        p.socket.emit('quickChat', { msgIndex, playerIdx });
      }
    });
  });

  // --- Stats API ---

  socket.on('getStats', (_, callback) => {
    const pid = playerIds.get(socket.id);
    if (!pid) return;
    const stats = getPlayerStats(pid);
    if (typeof callback === 'function') {
      callback(stats);
    } else {
      socket.emit('playerStats', stats);
    }
  });

  socket.on('getLeaderboard', (data, callback) => {
    const limit = (data && typeof data.limit === 'number') ? data.limit : 20;
    const board = getLeaderboard(limit);
    if (typeof callback === 'function') {
      callback(board);
    } else {
      socket.emit('leaderboard', board);
    }
  });

  socket.on('getMatchHistory', (data, callback) => {
    const pid = playerIds.get(socket.id);
    if (!pid) return;
    const limit = (data && typeof data.limit === 'number') ? data.limit : 10;
    const history = getMatchHistory(pid, limit);
    if (typeof callback === 'function') {
      callback(history);
    } else {
      socket.emit('matchHistory', history);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);

    // Remove from matchmaking queue if queued
    removeFromQueue(socket.id);

    const room = playerRooms.get(socket.id);
    if (room) {
      room.removePlayer(socket.id);
      playerRooms.delete(socket.id);

      // Clean up empty rooms (check all players including bots)
      if (room.isEmpty()) {
        rooms.delete(room.roomId);
        console.log(`Removed empty room: ${room.roomId}`);
      }
    }

    playerIds.delete(socket.id);
  });
});

// Initialize database (lazy — server still starts if DB fails)
initDatabase();

server.listen(PORT, () => {
  console.log(`Blocket League server running on port ${PORT}`);
});
