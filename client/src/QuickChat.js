// ============================================
// QuickChat - Rocket League-style quick chat system
// ============================================

import * as THREE from 'three';

// Quick-chat message categories
const CATEGORIES = [
  { name: 'Info',        messages: ['I got it!', 'Need boost!', 'Take the shot!', 'Defending...'] },
  { name: 'Compliments', messages: ['Nice shot!', 'Great pass!', 'What a save!', 'Thanks!'] },
  { name: 'Reactions',   messages: ['Wow!', 'Close one!', 'My bad...', 'No problem.'] },
];

// Flatten for index lookup: categoryIdx * 4 + messageIdx
function getMessageByIndex(idx) {
  const catIdx = Math.floor(idx / 4);
  const msgIdx = idx % 4;
  if (catIdx < 0 || catIdx >= CATEGORIES.length) return null;
  if (msgIdx < 0 || msgIdx >= CATEGORIES[catIdx].messages.length) return null;
  return CATEGORIES[catIdx].messages[msgIdx];
}

// Temp vector for 3D-to-screen projection
const _projVec = new THREE.Vector3();

export class QuickChat {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container - game container element
   * @param {THREE.Camera} opts.camera
   * @param {HTMLCanvasElement} opts.canvas
   * @param {import('./InputManager.js').InputManager} opts.input
   * @param {import('./NetworkManager.js').NetworkManager|null} opts.network
   * @param {string} opts.mode - 'singleplayer' | 'multiplayer' | 'freeplay' | 'training'
   */
  constructor(opts) {
    this.camera = opts.camera;
    this.canvas = opts.canvas;
    this.input = opts.input;
    this.network = opts.network;
    this.mode = opts.mode;
    this.container = opts.container || document.getElementById('game-container');

    // Active floating messages: { carIndex, text, elapsed, duration, el }
    this._floatingMessages = [];

    // Category selection state
    this._categoryOpen = false;
    this._selectedCategory = -1;

    // Keyboard edge detection for number keys
    this._prevKeys = {};

    // Gamepad quick-chat state
    this._gpQuickChatOpen = false;
    this._gpCategorySelected = -1;
    this._gpPrevDpad = { up: false, down: false, left: false, right: false };

    // Cooldown to prevent spam
    this._cooldown = 0;

    // Build the prompt HUD element (bottom-left hint)
    this._buildPromptHUD();

    // Build the category overlay
    this._buildCategoryOverlay();

    // Listen for network quick-chat from other players
    if (this.network) {
      this.network.on('quickChat', (data) => {
        const msg = getMessageByIndex(data.msgIndex);
        if (msg && data.playerIdx !== undefined) {
          this.showMessage(data.playerIdx, msg);
        }
      });
    }
  }

  _buildPromptHUD() {
    this._promptEl = document.createElement('div');
    this._promptEl.className = 'quickchat-prompt';
    Object.assign(this._promptEl.style, {
      position: 'absolute',
      bottom: '60px',
      left: '16px',
      color: 'rgba(255,255,255,0.35)',
      fontFamily: "'Rajdhani', 'Segoe UI', sans-serif",
      fontSize: '12px',
      letterSpacing: '1px',
      pointerEvents: 'none',
      zIndex: '50',
      transition: 'opacity 0.3s',
    });
    this._promptEl.textContent = '1-Info  2-Compliments  3-Reactions';
    this.container.appendChild(this._promptEl);
  }

  _buildCategoryOverlay() {
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'quickchat-overlay';
    Object.assign(this._overlayEl.style, {
      position: 'absolute',
      bottom: '80px',
      left: '16px',
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(8px)',
      border: '1px solid rgba(255, 255, 255, 0.15)',
      borderRadius: '10px',
      padding: '10px 16px',
      fontFamily: "'Rajdhani', 'Segoe UI', sans-serif",
      fontSize: '14px',
      color: '#fff',
      pointerEvents: 'none',
      zIndex: '150',
      display: 'none',
      minWidth: '160px',
    });
    this.container.appendChild(this._overlayEl);
  }

  /**
   * Show a floating quick-chat message above a car.
   * @param {number} carIndex - index into allCars
   * @param {string} text - message text
   */
  showMessage(carIndex, text) {
    const el = document.createElement('div');
    el.className = 'quickchat-float';
    el.textContent = text;
    Object.assign(el.style, {
      position: 'absolute',
      color: '#ffe066',
      fontFamily: "'Rajdhani', 'Segoe UI', sans-serif",
      fontSize: '15px',
      fontWeight: '700',
      letterSpacing: '1px',
      textShadow: '0 0 8px rgba(255,224,102,0.6), 0 2px 4px rgba(0,0,0,0.8)',
      pointerEvents: 'none',
      zIndex: '160',
      whiteSpace: 'nowrap',
      transform: 'translate(-50%, -100%)',
      transition: 'opacity 0.3s',
    });
    this.container.appendChild(el);

    this._floatingMessages.push({
      carIndex,
      text,
      elapsed: 0,
      duration: 3.0,
      el,
    });
  }

  /**
   * Send a quick-chat from the local player.
   * @param {number} msgIndex - flat index (catIdx*4 + msgIdx)
   * @param {number} localPlayerIdx - the local player's car index
   */
  sendMessage(msgIndex, localPlayerIdx) {
    if (this._cooldown > 0) return;

    const msg = getMessageByIndex(msgIndex);
    if (!msg) return;

    // Show locally above own car
    this.showMessage(localPlayerIdx, msg);

    // Send to server in multiplayer
    if (this.network && this.network.socket) {
      this.network.socket.emit('quickChat', { msgIndex });
    }

    this._cooldown = 1.0; // 1 second cooldown
  }

  /**
   * Trigger an AI quick-chat (singleplayer flavor).
   * @param {number} carIndex - AI car index
   * @param {string} event - 'goal_scored' | 'save' | 'demo'
   */
  triggerAIChat(carIndex, event) {
    if (Math.random() > 0.10) return; // 10% chance

    let pool;
    switch (event) {
      case 'goal_scored':
        pool = ['Wow!', 'Nice shot!', 'What a save!', 'Close one!'];
        break;
      case 'save':
        pool = ['What a save!', 'Close one!', 'No problem.'];
        break;
      case 'demo':
        pool = ['Wow!', 'My bad...', 'No problem.'];
        break;
      default:
        pool = ['Wow!'];
    }
    const msg = pool[Math.floor(Math.random() * pool.length)];
    this.showMessage(carIndex, msg);
  }

  /**
   * Called every frame from the game loop.
   * @param {number} dt - delta time
   * @param {Array} allCars - array of car objects
   */
  update(dt, allCars) {
    // Update cooldown
    if (this._cooldown > 0) this._cooldown -= dt;

    // Process keyboard input for quick-chat selection
    this._processKeyboardInput(allCars);

    // Process gamepad input for quick-chat selection
    this._processGamepadInput(allCars);

    // Update overlay display
    this._updateOverlay();

    // Update floating messages
    this._updateFloatingMessages(dt, allCars);
  }

  _processKeyboardInput(allCars) {
    const keys = this.input.keys;

    // Check for number key presses (1-3 for categories, 1-4 for messages within category)
    const digit1 = this._keyPressed(keys, 'Digit1');
    const digit2 = this._keyPressed(keys, 'Digit2');
    const digit3 = this._keyPressed(keys, 'Digit3');
    const digit4 = this._keyPressed(keys, 'Digit4');

    if (this._categoryOpen) {
      // Second press: select message within category
      let msgIdx = -1;
      if (digit1) msgIdx = 0;
      else if (digit2) msgIdx = 1;
      else if (digit3) msgIdx = 2;
      else if (digit4) msgIdx = 3;

      if (msgIdx >= 0 && this._selectedCategory >= 0) {
        const flatIdx = this._selectedCategory * 4 + msgIdx;
        const localIdx = this._getLocalPlayerIndex(allCars);
        this.sendMessage(flatIdx, localIdx);
        this._categoryOpen = false;
        this._selectedCategory = -1;
      }

      // Escape or timeout closes the menu
      if (this._keyPressed(keys, 'Escape')) {
        this._categoryOpen = false;
        this._selectedCategory = -1;
      }
    } else {
      // First press: open category
      let catIdx = -1;
      if (digit1) catIdx = 0;
      else if (digit2) catIdx = 1;
      else if (digit3) catIdx = 2;

      if (catIdx >= 0) {
        this._categoryOpen = true;
        this._selectedCategory = catIdx;
      }
    }

    // Update prev keys
    this._prevKeys = { ...keys };
  }

  _processGamepadInput(allCars) {
    if (!navigator.getGamepads) return;
    const gamepads = navigator.getGamepads();
    let gp = null;
    for (const g of gamepads) {
      if (g) { gp = g; break; }
    }
    if (!gp) return;

    const dpadUp = gp.buttons[12] && gp.buttons[12].pressed;
    const dpadDown = gp.buttons[13] && gp.buttons[13].pressed;
    const dpadLeft = gp.buttons[14] && gp.buttons[14].pressed;
    const dpadRight = gp.buttons[15] && gp.buttons[15].pressed;

    const upPressed = dpadUp && !this._gpPrevDpad.up;
    const downPressed = dpadDown && !this._gpPrevDpad.down;
    const leftPressed = dpadLeft && !this._gpPrevDpad.left;
    const rightPressed = dpadRight && !this._gpPrevDpad.right;

    if (this._gpQuickChatOpen) {
      if (this._gpCategorySelected < 0) {
        // Select category: left=0 (Info), down=1 (Compliments), right=2 (Reactions)
        if (leftPressed) this._gpCategorySelected = 0;
        else if (downPressed) this._gpCategorySelected = 1;
        else if (rightPressed) this._gpCategorySelected = 2;
        else if (upPressed) {
          // Close menu
          this._gpQuickChatOpen = false;
        }
      } else {
        // Select message within category
        let msgIdx = -1;
        if (upPressed) msgIdx = 0;
        else if (rightPressed) msgIdx = 1;
        else if (downPressed) msgIdx = 2;
        else if (leftPressed) msgIdx = 3;

        if (msgIdx >= 0) {
          const flatIdx = this._gpCategorySelected * 4 + msgIdx;
          const localIdx = this._getLocalPlayerIndex(allCars);
          this.sendMessage(flatIdx, localIdx);
          this._gpQuickChatOpen = false;
          this._gpCategorySelected = -1;
        }
      }

      // Sync overlay state
      if (this._gpCategorySelected >= 0) {
        this._categoryOpen = true;
        this._selectedCategory = this._gpCategorySelected;
      } else if (this._gpQuickChatOpen) {
        // Show category selector
        this._categoryOpen = true;
        this._selectedCategory = -1; // show categories
      }
    } else {
      // D-pad up opens quick-chat
      if (upPressed) {
        this._gpQuickChatOpen = true;
        this._gpCategorySelected = -1;
        this._categoryOpen = true;
        this._selectedCategory = -1;
      }
    }

    this._gpPrevDpad = { up: dpadUp, down: dpadDown, left: dpadLeft, right: dpadRight };
  }

  _keyPressed(keys, code) {
    return !!keys[code] && !this._prevKeys[code];
  }

  _getLocalPlayerIndex(allCars) {
    // In singleplayer, player is always index 0
    // In multiplayer, check playerNumber from network or fall back to 0
    if (this.network && this.network.playerNumber >= 0) {
      return this.network.playerNumber;
    }
    return 0;
  }

  _updateOverlay() {
    if (!this._categoryOpen) {
      this._overlayEl.style.display = 'none';
      this._promptEl.style.opacity = '1';
      return;
    }

    this._overlayEl.style.display = '';
    this._promptEl.style.opacity = '0.15';

    if (this._selectedCategory < 0) {
      // Show category list (gamepad opened without choosing yet)
      let html = '<div style="font-size:12px;opacity:0.6;margin-bottom:6px;letter-spacing:1px">QUICK CHAT</div>';
      const labels = ['Info', 'Compliments', 'Reactions'];
      const gpHints = ['\u2190', '\u2193', '\u2192']; // left, down, right arrows
      for (let i = 0; i < labels.length; i++) {
        html += `<div style="padding:2px 0;opacity:0.85">${i + 1} / ${gpHints[i]}  ${labels[i]}</div>`;
      }
      this._overlayEl.innerHTML = html;
    } else {
      // Show messages in selected category
      const cat = CATEGORIES[this._selectedCategory];
      const gpHints = ['\u2191', '\u2192', '\u2193', '\u2190']; // up, right, down, left
      let html = `<div style="font-size:12px;opacity:0.6;margin-bottom:6px;letter-spacing:1px">${cat.name.toUpperCase()}</div>`;
      for (let i = 0; i < cat.messages.length; i++) {
        html += `<div style="padding:2px 0;opacity:0.85">${i + 1} / ${gpHints[i]}  ${cat.messages[i]}</div>`;
      }
      this._overlayEl.innerHTML = html;
    }
  }

  _updateFloatingMessages(dt, allCars) {
    const cam = this.camera;
    const halfW = this.canvas.clientWidth / 2;
    const halfH = this.canvas.clientHeight / 2;

    for (let i = this._floatingMessages.length - 1; i >= 0; i--) {
      const msg = this._floatingMessages[i];
      msg.elapsed += dt;

      // Remove expired messages
      if (msg.elapsed >= msg.duration) {
        msg.el.remove();
        this._floatingMessages.splice(i, 1);
        continue;
      }

      // Fade out over last second
      const fadeStart = msg.duration - 1.0;
      if (msg.elapsed > fadeStart) {
        const fadeT = (msg.elapsed - fadeStart) / 1.0;
        msg.el.style.opacity = (1 - fadeT).toFixed(2);
      }

      // Also float upward slightly
      const floatOffset = msg.elapsed * 8; // pixels per second upward

      // Project car position to screen
      const car = allCars[msg.carIndex];
      if (!car || !car.mesh) {
        msg.el.style.display = 'none';
        continue;
      }

      _projVec.set(car.mesh.position.x, car.mesh.position.y + 5, car.mesh.position.z);
      _projVec.project(cam);

      // Behind camera
      if (_projVec.z > 1) {
        msg.el.style.display = 'none';
        continue;
      }

      const sx = (_projVec.x * halfW) + halfW;
      const sy = -((_projVec.y * halfH) - halfH) - floatOffset;

      msg.el.style.display = '';
      msg.el.style.left = `${sx}px`;
      msg.el.style.top = `${sy}px`;
    }
  }

  /**
   * Close the quick-chat menu (e.g., when game state changes).
   */
  close() {
    this._categoryOpen = false;
    this._selectedCategory = -1;
    this._gpQuickChatOpen = false;
    this._gpCategorySelected = -1;
  }

  destroy() {
    // Remove all floating messages
    for (const msg of this._floatingMessages) {
      msg.el.remove();
    }
    this._floatingMessages = [];

    if (this._promptEl) this._promptEl.remove();
    if (this._overlayEl) this._overlayEl.remove();
  }
}

export { CATEGORIES, getMessageByIndex };
