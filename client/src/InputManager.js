// ============================================
// Input Manager - Keyboard + Gamepad input
// Touch controls loaded lazily on mobile only
// ============================================

// Default gamepad settings
const DEFAULT_GP_SETTINGS = {
  deadzone: 0.15,
  triggerThreshold: 0.1,
};

// Default key bindings
const DEFAULT_KEY_BINDINGS = {
  throttleForward: 'KeyW',
  throttleReverse: 'KeyS',
  steerLeft: 'KeyA',
  steerRight: 'KeyD',
  jump: 'Space',
  boost: 'ShiftLeft',
  ballCam: 'KeyC',
  airRollLeft: 'KeyQ',
  airRollRight: 'KeyE',
  handbrake: 'ControlLeft',
  lookLeft: 'KeyJ',
  lookRight: 'KeyL',
  scoreboard: 'Tab',
};

// Default gamepad button bindings
const DEFAULT_GP_BINDINGS = {
  jump: 0,       // A
  boost: 1,      // B
  handbrake: 2,  // X
  ballCam: 3,    // Y
  airRollLeft: 4, // LB
  airRollRight: 5, // RB
  throttlePos: 7, // RT
  throttleNeg: 6, // LT
};

// Xbox axis indices (not rebindable)
const GP_AXIS_LEFT_X = 0;
const GP_AXIS_LEFT_Y = 1;
const GP_AXIS_RIGHT_X = 2;

// Gamepad button display names
const GP_BUTTON_NAMES = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y',
  4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'Back', 9: 'Start', 10: 'LS', 11: 'RS',
  12: 'Up', 13: 'Down', 14: 'Left', 15: 'Right',
};

export class InputManager {
  constructor() {
    this.keys = {};
    this.state = {
      throttle: 0,    // -1 to 1
      steer: 0,       // -1 to 1
      jump: false,
      jumpPressed: false,  // true only on the frame jump is first pressed
      boost: false,
      ballCam: true,
      airRoll: 0,     // -1 (left), 0, 1 (right)
      pitchUp: false,
      pitchDown: false,
      handbrake: false,
      lookX: 0,         // -1 (look left) to 1 (look right) — right stick / J,L keys
      dodgeForward: 0,  // -1 to 1, dodge direction (separate from throttle)
      dodgeSteer: 0,    // -1 to 1, dodge direction (separate from steer)
      scoreboard: false, // hold to show scoreboard
    };

    // Load bindings from localStorage
    this._keyBindings = { ...DEFAULT_KEY_BINDINGS };
    this._gpBindings = { ...DEFAULT_GP_BINDINGS };
    this._gpSettings = { ...DEFAULT_GP_SETTINGS };
    this._loadBindings();

    // Keyboard edge detection
    this._jumpWasDown = false;
    this._ballCamToggle = false;

    // Track most recently pressed direction key (for dodge direction when both held)
    this._lastThrottleDir = 0;
    this._lastSteerDir = 0;

    // Gamepad edge detection (separate from keyboard)
    this._gpJumpWasDown = false;
    this._gpBallCamToggle = false;

    // Gamepad tracking
    this._gamepadIndex = null;

    // Rebind capture
    this._rebindCallback = null;

    this._onKeydown = (e) => {
      if (e.key === 'F12') return; // allow dev tools

      // Rebind mode: capture the key
      if (this._rebindCallback) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          const cb = this._rebindCallback;
          this._rebindCallback = null;
          cb(null); // cancelled
        } else {
          const cb = this._rebindCallback;
          this._rebindCallback = null;
          cb(e.code);
        }
        return;
      }

      this.keys[e.code] = true;
      // Track most recently pressed direction for dodge resolution
      const kb = this._keyBindings;
      if (e.code === kb.throttleForward || e.code === 'ArrowUp') this._lastThrottleDir = 1;
      if (e.code === kb.throttleReverse || e.code === 'ArrowDown') this._lastThrottleDir = -1;
      if (e.code === kb.steerLeft || e.code === 'ArrowLeft') this._lastSteerDir = 1;
      if (e.code === kb.steerRight || e.code === 'ArrowRight') this._lastSteerDir = -1;
      e.preventDefault();
    };
    window.addEventListener('keydown', this._onKeydown);

    this._onKeyup = (e) => {
      if (e.key === 'F12') return;
      this.keys[e.code] = false;
      e.preventDefault();
    };
    window.addEventListener('keyup', this._onKeyup);

    // Prevent context menu on right click
    this._onContextmenu = (e) => e.preventDefault();
    window.addEventListener('contextmenu', this._onContextmenu);

    // Gamepad connect/disconnect
    this._onGamepadConnected = (e) => {
      this._gamepadIndex = e.gamepad.index;
      this._showGamepadNotification('Controller connected: ' + e.gamepad.id.split('(')[0].trim());
    };
    window.addEventListener('gamepadconnected', this._onGamepadConnected);

    // Check for already-connected gamepads (event may have fired before this constructor)
    const existingGamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of existingGamepads) {
      if (g) { this._gamepadIndex = g.index; break; }
    }

    this._onGamepadDisconnected = (e) => {
      if (this._gamepadIndex === e.gamepad.index) {
        this._gamepadIndex = null;
        this._gpJumpWasDown = false;
        this._gpBallCamToggle = false;
        this._showGamepadNotification('Controller disconnected');
      }
    };
    window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);

    // Lazy-load touch controls only on actual touch devices
    this._touchState = null;
    const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches
      || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
    if (isTouchDevice) {
      import('./TouchControls.js').then(({ TouchControls }) => {
        try {
          this._touch = new TouchControls();
          this._touchState = this._touch.state;
          console.log('Touch controls loaded');
        } catch (e) {
          console.warn('Touch controls failed to init:', e);
        }
      }).catch((e) => {
        console.warn('Touch controls import failed:', e);
      });
    }
  }

  // --- Binding getters ---
  get keyBindings() { return { ...this._keyBindings }; }
  get gpBindings() { return { ...this._gpBindings }; }
  get gpSettings() { return { ...this._gpSettings }; }

  static getDefaultKeyBindings() { return { ...DEFAULT_KEY_BINDINGS }; }
  static getDefaultGpBindings() { return { ...DEFAULT_GP_BINDINGS }; }
  static getDefaultGpSettings() { return { ...DEFAULT_GP_SETTINGS }; }
  static getGpButtonName(index) { return GP_BUTTON_NAMES[index] || `B${index}`; }

  // --- Binding setters (with localStorage persist) ---
  setKeyBindings(bindings) {
    Object.assign(this._keyBindings, bindings);
    try { localStorage.setItem('blocket-key-bindings', JSON.stringify(this._keyBindings)); } catch {}
  }

  setGpBindings(bindings) {
    Object.assign(this._gpBindings, bindings);
    try { localStorage.setItem('blocket-gamepad-bindings', JSON.stringify(this._gpBindings)); } catch {}
  }

  setGpSettings(settings) {
    Object.assign(this._gpSettings, settings);
    try { localStorage.setItem('blocket-gamepad-settings', JSON.stringify(this._gpSettings)); } catch {}
  }

  _loadBindings() {
    try {
      const kb = localStorage.getItem('blocket-key-bindings');
      if (kb) {
        const parsed = JSON.parse(kb);
        for (const key of Object.keys(DEFAULT_KEY_BINDINGS)) {
          if (typeof parsed[key] === 'string') this._keyBindings[key] = parsed[key];
        }
      }
    } catch {}
    try {
      const gp = localStorage.getItem('blocket-gamepad-bindings');
      if (gp) {
        const parsed = JSON.parse(gp);
        for (const key of Object.keys(DEFAULT_GP_BINDINGS)) {
          if (typeof parsed[key] === 'number') this._gpBindings[key] = parsed[key];
        }
      }
    } catch {}
    try {
      const gs = localStorage.getItem('blocket-gamepad-settings');
      if (gs) {
        const parsed = JSON.parse(gs);
        if (typeof parsed.deadzone === 'number') this._gpSettings.deadzone = parsed.deadzone;
        if (typeof parsed.triggerThreshold === 'number') this._gpSettings.triggerThreshold = parsed.triggerThreshold;
      }
    } catch {}
  }

  // --- Rebind API ---
  waitForKey(callback) {
    this._rebindCallback = callback;
  }

  cancelWaitForKey() {
    this._rebindCallback = null;
  }

  get isWaitingForKey() {
    return this._rebindCallback !== null;
  }

  _applyDeadzone(value) {
    const dz = this._gpSettings.deadzone;
    if (Math.abs(value) < dz) return 0;
    const sign = value > 0 ? 1 : -1;
    return sign * (Math.abs(value) - dz) / (1 - dz);
  }

  _pollGamepad() {
    if (this._gamepadIndex === null || !navigator.getGamepads) return null;

    const gp = navigator.getGamepads()[this._gamepadIndex];
    if (!gp) return null;

    const gpb = this._gpBindings;
    const tt = this._gpSettings.triggerThreshold;

    // Triggers (analog 0-1)
    const rt = gp.buttons[gpb.throttlePos] ? gp.buttons[gpb.throttlePos].value : 0;
    const lt = gp.buttons[gpb.throttleNeg] ? gp.buttons[gpb.throttleNeg].value : 0;
    const throttlePos = rt > tt ? rt : 0;
    const throttleNeg = lt > tt ? lt : 0;
    const throttle = throttlePos - throttleNeg;

    // Left stick X — negate: stick-right (positive) → steer negative (code convention: positive = left)
    const steer = -this._applyDeadzone(gp.axes[GP_AXIS_LEFT_X]);

    // Left stick Y — pitch
    const stickY = this._applyDeadzone(gp.axes[GP_AXIS_LEFT_Y]);
    const pitchDown = stickY < -this._gpSettings.deadzone; // stick forward = nose down
    const pitchUp = stickY > this._gpSettings.deadzone;    // stick back = nose up

    // Buttons
    const jumpDown = gp.buttons[gpb.jump] ? gp.buttons[gpb.jump].pressed : false;
    const jumpPressed = jumpDown && !this._gpJumpWasDown;
    this._gpJumpWasDown = jumpDown;

    const boost = gp.buttons[gpb.boost] ? gp.buttons[gpb.boost].pressed : false;

    const ballCamDown = gp.buttons[gpb.ballCam] ? gp.buttons[gpb.ballCam].pressed : false;
    const ballCamToggled = ballCamDown && !this._gpBallCamToggle;
    this._gpBallCamToggle = ballCamDown;

    const airRollLeft = gp.buttons[gpb.airRollLeft] ? gp.buttons[gpb.airRollLeft].pressed : false;
    const airRollRight = gp.buttons[gpb.airRollRight] ? gp.buttons[gpb.airRollRight].pressed : false;
    const scoreboard = airRollLeft; // LB doubles as scoreboard hold

    // LT also acts as air roll modifier — left stick X controls roll direction
    const ltAirRoll = (lt > tt) ? -steer : 0; // steer is already negated, so -steer = stick direction

    const handbrake = gp.buttons[gpb.handbrake] ? gp.buttons[gpb.handbrake].pressed : false;

    // Right stick X — camera swivel
    const lookX = this._applyDeadzone(gp.axes[GP_AXIS_RIGHT_X] || 0);

    // Dodge direction from left stick (separate from triggers for throttle)
    const dodgeForward = -stickY; // stick-forward (negative Y) = positive dodge
    const dodgeSteer = steer;     // same as steering direction

    return {
      throttle,
      steer,
      jump: jumpDown,
      jumpPressed,
      boost,
      ballCamToggled,
      airRollLeft,
      airRollRight,
      ltAirRoll,
      pitchUp,
      pitchDown,
      handbrake,
      lookX,
      dodgeForward,
      dodgeSteer,
      scoreboard,
    };
  }

  update() {
    const k = this.keys;
    const kb = this._keyBindings;

    // --- Keyboard values ---
    const kbForward = k[kb.throttleForward] || k['ArrowUp'] ? 1 : 0;
    const kbBackward = k[kb.throttleReverse] || k['ArrowDown'] ? 1 : 0;
    const kbThrottle = kbForward - kbBackward;

    const kbLeft = k[kb.steerLeft] || k['ArrowLeft'] ? 1 : 0;
    const kbRight = k[kb.steerRight] || k['ArrowRight'] ? 1 : 0;
    const kbSteer = kbLeft - kbRight; // positive = left turn

    const kbJumpDown = !!k[kb.jump];
    const kbJumpPressed = kbJumpDown && !this._jumpWasDown;
    this._jumpWasDown = kbJumpDown;

    const kbBoost = !!(k[kb.boost] || k['ShiftRight']);

    const kbBallCamDown = !!k[kb.ballCam];
    const kbBallCamToggled = kbBallCamDown && !this._ballCamToggle;
    this._ballCamToggle = kbBallCamDown;

    const kbRollLeft = k[kb.airRollLeft] ? -1 : 0;
    const kbRollRight = k[kb.airRollRight] ? 1 : 0;
    const kbAirRoll = kbRollLeft + kbRollRight;

    const kbPitchUp = !!(k[kb.throttleForward] || k['ArrowUp']);
    const kbPitchDown = !!(k[kb.throttleReverse] || k['ArrowDown']);

    const kbHandbrake = !!(k[kb.handbrake] || k['ControlRight']);

    const kbScoreboard = !!k[kb.scoreboard];

    // Camera swivel
    const kbLookLeft = k[kb.lookLeft] ? -1 : 0;
    const kbLookRight = k[kb.lookRight] ? 1 : 0;
    const kbLookX = kbLookLeft + kbLookRight;

    // Dodge direction: "most recently pressed key wins" when both opposites held
    const kbBothThrottle = kbForward && kbBackward;
    const kbDodgeForward = kbBothThrottle ? this._lastThrottleDir : kbThrottle;
    const kbBothSteer = kbLeft && kbRight;
    const kbDodgeSteer = kbBothSteer ? this._lastSteerDir : kbSteer;

    // --- Touch (mobile only, lazy-loaded) ---
    if (this._touch) this._touch.update();
    const tc = this._touchState;

    // --- Gamepad ---
    const gp = this._pollGamepad();

    if (!gp && !tc) {
      // No gamepad or touch — use keyboard only
      this.state.throttle = kbThrottle;
      this.state.steer = kbSteer;
      this.state.jump = kbJumpDown;
      this.state.jumpPressed = kbJumpPressed;
      this.state.boost = kbBoost;
      if (kbBallCamToggled) this.state.ballCam = !this.state.ballCam;
      this.state.airRoll = kbAirRoll;
      this.state.pitchUp = kbPitchUp;
      this.state.pitchDown = kbPitchDown;
      this.state.handbrake = kbHandbrake;
      this.state.lookX = kbLookX;
      this.state.dodgeForward = kbDodgeForward;
      this.state.dodgeSteer = kbDodgeSteer;
      this.state.scoreboard = kbScoreboard;
      return;
    }

    // --- Merge: max-magnitude for analog, OR for digital ---

    // Throttle: max-magnitude
    let throttle = kbThrottle;
    if (gp && Math.abs(gp.throttle) > Math.abs(throttle)) throttle = gp.throttle;
    if (tc && Math.abs(tc.throttle) > Math.abs(throttle)) throttle = tc.throttle;
    this.state.throttle = throttle;

    // Steer: max-magnitude
    let steer = kbSteer;
    if (gp && Math.abs(gp.steer) > Math.abs(steer)) steer = gp.steer;
    if (tc && Math.abs(tc.steer) > Math.abs(steer)) steer = tc.steer;
    this.state.steer = steer;

    // Jump: OR
    this.state.jump = !!(kbJumpDown || (gp && gp.jump) || (tc && tc.jump));
    this.state.jumpPressed = !!(kbJumpPressed || (gp && gp.jumpPressed) || (tc && tc.jumpPressed));

    // Boost: OR
    this.state.boost = !!(kbBoost || (gp && gp.boost) || (tc && tc.boost));

    // Ball cam: either source can toggle
    if (kbBallCamToggled || (gp && gp.ballCamToggled) || (tc && tc.ballCamToggled)) {
      this.state.ballCam = !this.state.ballCam;
    }

    // Air roll: gamepad/keyboard only (no touch air roll)
    // LB/RB buttons give discrete -1/+1; LT + left stick gives analog roll
    const gpButtonRoll = gp ? (gp.airRollLeft ? -1 : 0) + (gp.airRollRight ? 1 : 0) : 0;
    const gpAirRoll = gpButtonRoll !== 0 ? gpButtonRoll : (gp ? gp.ltAirRoll : 0);
    this.state.airRoll = gpAirRoll !== 0 ? gpAirRoll : kbAirRoll;

    // Pitch: OR
    this.state.pitchUp = !!(kbPitchUp || (gp && gp.pitchUp) || (tc && tc.pitchUp));
    this.state.pitchDown = !!(kbPitchDown || (gp && gp.pitchDown) || (tc && tc.pitchDown));

    // Handbrake: OR
    this.state.handbrake = !!(kbHandbrake || (gp && gp.handbrake) || (tc && tc.handbrake));

    // Camera swivel: max-magnitude (gamepad analog, keyboard digital)
    let lookX = kbLookX;
    if (gp && Math.abs(gp.lookX) > Math.abs(lookX)) lookX = gp.lookX;
    this.state.lookX = lookX;

    // Dodge direction: max-magnitude merge
    let dodgeForward = kbDodgeForward;
    if (gp && Math.abs(gp.dodgeForward) > Math.abs(dodgeForward)) dodgeForward = gp.dodgeForward;
    if (tc && Math.abs(tc.dodgeForward || 0) > Math.abs(dodgeForward)) dodgeForward = tc.dodgeForward;
    this.state.dodgeForward = dodgeForward;

    let dodgeSteer = kbDodgeSteer;
    if (gp && Math.abs(gp.dodgeSteer) > Math.abs(dodgeSteer)) dodgeSteer = gp.dodgeSteer;
    if (tc && Math.abs(tc.dodgeSteer || 0) > Math.abs(dodgeSteer)) dodgeSteer = tc.dodgeSteer;
    this.state.dodgeSteer = dodgeSteer;

    // Scoreboard: OR
    this.state.scoreboard = !!(kbScoreboard || (gp && gp.scoreboard));
  }

  _showGamepadNotification(message) {
    const el = document.createElement('div');
    el.textContent = message;
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0, 0, 0, 0.8)',
      color: '#0ff',
      padding: '12px 24px',
      borderRadius: '8px',
      border: '1px solid #0ff',
      fontFamily: 'monospace',
      fontSize: '14px',
      zIndex: '10000',
      transition: 'opacity 1s',
      opacity: '1',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2000);
    setTimeout(() => { el.remove(); }, 3000);
  }

  // Get the input state (for sending to server)
  getState() {
    return { ...this.state };
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeydown);
    window.removeEventListener('keyup', this._onKeyup);
    window.removeEventListener('contextmenu', this._onContextmenu);
    window.removeEventListener('gamepadconnected', this._onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
    if (this._touch && this._touch.destroy) {
      this._touch.destroy();
    }
  }
}
