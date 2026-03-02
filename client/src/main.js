// ============================================
// Blocket League - Entry Point
// ============================================

import { Game } from './Game.js';

// Wait for DOM
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game-canvas');

  // Lock pointer on click for better control
  canvas.addEventListener('click', () => {
    // Don't lock pointer - it interferes with gameplay feel
    // Just focus the window
    canvas.focus();
  });

  // Initialize game
  const game = new Game(canvas);

  // Expose for debugging
  window.game = game;
});
