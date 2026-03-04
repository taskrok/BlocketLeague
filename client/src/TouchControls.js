// ============================================
// Touch Controls - Virtual joystick + buttons for mobile
// ============================================

const DEADZONE = 0.15;

export class TouchControls {
  constructor() {
    this.active = false;

    this.state = {
      throttle: 0,
      steer: 0,
      jump: false,
      jumpPressed: false,
      boost: false,
      ballCamToggled: false,
      handbrake: false,
      pitchUp: false,
      pitchDown: false,
    };

    // Edge detection
    this._jumpWasDown = false;
    this._camWasDown = false;

    // Joystick tracking
    this._stickTouchId = null;
    this._stickOriginX = 0;
    this._stickOriginY = 0;
    this._stickX = 0;
    this._stickY = 0;
    this._stickMaxDist = 50;

    if (this._isTouchDevice()) {
      this._createUI();
      this.active = true;
    }
  }

  _isTouchDevice() {
    // Detect actual mobile/tablet: media query preferred, but also check
    // ontouchstart as fallback since some phones don't match (hover: none)
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches
      || ('ontouchstart' in window && navigator.maxTouchPoints > 0
          && window.matchMedia('(max-width: 1024px)').matches);
  }

  // ===== UI CREATION =====

  _createUI() {
    this.container = document.createElement('div');
    this.container.id = 'touch-controls';

    const gameContainer = document.getElementById('game-container');
    if (!gameContainer) return;
    gameContainer.appendChild(this.container);

    this._createJoystick();
    this._createButtons();

    // Hide keyboard controls hint on touch devices
    const hint = document.getElementById('controls-hint');
    if (hint) hint.style.display = 'none';

    // Prevent page scroll/zoom when touching the game area
    document.addEventListener('touchmove', (e) => {
      if (e.target.closest('#game-container')) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  // ===== JOYSTICK =====

  _createJoystick() {
    const zone = document.createElement('div');
    zone.className = 'touch-joy-zone';
    this.container.appendChild(zone);

    const base = document.createElement('div');
    base.className = 'touch-joy-base';
    zone.appendChild(base);

    const stick = document.createElement('div');
    stick.className = 'touch-joy-stick';
    base.appendChild(stick);

    this._joyZone = zone;
    this._joyBase = base;
    this._joyStick = stick;

    zone.addEventListener('touchstart', (e) => this._onStickStart(e), { passive: false });
    zone.addEventListener('touchmove', (e) => this._onStickMove(e), { passive: false });
    zone.addEventListener('touchend', (e) => this._onStickEnd(e), { passive: false });
    zone.addEventListener('touchcancel', (e) => this._onStickEnd(e), { passive: false });
  }

  _onStickStart(e) {
    e.preventDefault();
    if (this._stickTouchId !== null) return;

    const touch = e.changedTouches[0];
    this._stickTouchId = touch.identifier;

    const rect = this._joyBase.getBoundingClientRect();
    this._stickOriginX = rect.left + rect.width / 2;
    this._stickOriginY = rect.top + rect.height / 2;
    this._stickMaxDist = rect.width / 2;

    this._moveStick(touch);
    this._joyBase.classList.add('active');
  }

  _onStickMove(e) {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === this._stickTouchId) {
        this._moveStick(e.changedTouches[i]);
        return;
      }
    }
  }

  _onStickEnd(e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === this._stickTouchId) {
        this._stickTouchId = null;
        this._stickX = 0;
        this._stickY = 0;
        this._joyStick.style.transform = 'translate(-50%, -50%)';
        this._joyBase.classList.remove('active');
        return;
      }
    }
  }

  _moveStick(touch) {
    const dx = touch.clientX - this._stickOriginX;
    const dy = touch.clientY - this._stickOriginY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const max = this._stickMaxDist;

    let nx, ny;
    if (dist > max) {
      nx = dx / dist;
      ny = dy / dist;
    } else {
      nx = dx / max;
      ny = dy / max;
    }

    this._stickX = Math.max(-1, Math.min(1, nx));
    this._stickY = Math.max(-1, Math.min(1, ny));

    const vx = this._stickX * max;
    const vy = this._stickY * max;
    this._joyStick.style.transform = `translate(calc(-50% + ${vx}px), calc(-50% + ${vy}px))`;
  }

  // ===== BUTTONS =====

  _createButtons() {
    const zone = document.createElement('div');
    zone.className = 'touch-btn-zone';
    this.container.appendChild(zone);

    // Diamond layout: Boost(bottom), Jump(right), Drift(left), Cam(top)
    this._boostBtn = this._makeButton(zone, 'touch-btn touch-btn-boost', 'BOOST');
    this._jumpBtn = this._makeButton(zone, 'touch-btn touch-btn-jump', 'JUMP');
    this._driftBtn = this._makeButton(zone, 'touch-btn touch-btn-drift', 'DRIFT');
    this._camBtn = this._makeButton(zone, 'touch-btn touch-btn-cam', 'CAM');
  }

  _makeButton(parent, className, label) {
    const btn = document.createElement('div');
    btn.className = className;
    btn.textContent = label;
    btn._touchIds = new Set();
    parent.appendChild(btn);

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        btn._touchIds.add(t.identifier);
      }
      btn.classList.add('pressed');
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        btn._touchIds.delete(t.identifier);
      }
      if (btn._touchIds.size === 0) btn.classList.remove('pressed');
    }, { passive: false });

    btn.addEventListener('touchcancel', (e) => {
      for (const t of e.changedTouches) {
        btn._touchIds.delete(t.identifier);
      }
      if (btn._touchIds.size === 0) btn.classList.remove('pressed');
    }, { passive: false });

    return btn;
  }

  _isPressed(btn) {
    return btn._touchIds.size > 0;
  }

  // ===== UPDATE (called each frame) =====

  update() {
    if (!this.active) return;

    // Joystick → throttle and steer
    // Screen-up (negative Y) = forward (positive throttle)
    // Screen-left (negative X) = left turn (positive steer)
    let throttle = -this._stickY;
    let steer = -this._stickX;

    if (Math.abs(throttle) < DEADZONE) throttle = 0;
    if (Math.abs(steer) < DEADZONE) steer = 0;

    this.state.throttle = throttle;
    this.state.steer = steer;

    // Pitch mirrors throttle (W/S map to both throttle and pitch in keyboard mode)
    this.state.pitchUp = throttle > 0;
    this.state.pitchDown = throttle < 0;

    // Jump with edge detection
    const jumpDown = this._isPressed(this._jumpBtn);
    this.state.jumpPressed = jumpDown && !this._jumpWasDown;
    this.state.jump = jumpDown;
    this._jumpWasDown = jumpDown;

    // Boost (hold)
    this.state.boost = this._isPressed(this._boostBtn);

    // Handbrake (hold)
    this.state.handbrake = this._isPressed(this._driftBtn);

    // Ball cam toggle with edge detection
    const camDown = this._isPressed(this._camBtn);
    this.state.ballCamToggled = camDown && !this._camWasDown;
    this._camWasDown = camDown;
  }

  show() {
    if (this.container) this.container.style.display = '';
  }

  hide() {
    if (this.container) this.container.style.display = 'none';
  }
}
