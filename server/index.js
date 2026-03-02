// ============================================
// Blocket League - Game Server (placeholder for Stage 1)
// ============================================

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
});

// Socket.io connection handling (to be expanded for multiplayer)
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Blocket League server running on port ${PORT}`);
});
