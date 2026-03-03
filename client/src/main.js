// ============================================
// Blocket League - Entry Point
// ============================================

import { Game } from './Game.js';
import { NetworkManager } from './NetworkManager.js';

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game-canvas');
  const lobby = document.getElementById('lobby');
  const btnSingle = document.getElementById('btn-singleplayer');
  const btnMulti = document.getElementById('btn-multiplayer');

  canvas.addEventListener('click', () => {
    canvas.focus();
  });

  btnSingle.addEventListener('click', () => {
    lobby.style.display = 'none';
    const game = new Game(canvas);
    window.game = game;
  });

  btnMulti.addEventListener('click', () => {
    lobby.style.display = 'none';
    const network = new NetworkManager();
    const game = new Game(canvas, 'multiplayer', network);
    window.game = game;
  });
});
