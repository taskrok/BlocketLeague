// ============================================
// Input Manager - Keyboard + Gamepad input
// Touch controls loaded lazily on mobile only
// ============================================

// Gamepad constants
const DEADZONE = 0.15;
const TRIGGER_THRESHOLD = 0.1;

// Xbox button indices
const GP_A = 0;
const GP_B = 1;
const GP_X = 2;
const GP_Y = 3;
const GP_LB = 4;
const GP_RB = 5;
const GP_LT = 6;
const GP_RT = 7;

// Xbox axis indices
const GP_AXIS_LEFT_X = 0;
const GP_AXIS_LEFT_Y = 1;
const GP_AXIS_RIGHT_X = 2;

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
    };

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

    this._onKeydown = (e) => {
      if (e.key === 'F12') return; // allow dev tools
      this.keys[e.code] = true;
      // Track most recently pressed direction for dodge resolution
      if (e.code === 'KeyW' || e.code === 'ArrowUp') this._lastThrottleDir = 1;
      if (e.code === 'KeyS' || e.code === 'ArrowDown') this._lastThrottleDir = -1;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') this._lastSteerDir = 1;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') this._lastSteerDir = -1;
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

  _applyDeadzone(value) {
    if (Math.abs(value) < DEADZONE) return 0;
    const sign = value > 0 ? 1 : -1;
    return sign * (Math.abs(value) - DEADZONE) / (1 - DEADZONE);
  }

  _pollGamepad() {
    if (this._gamepadIndex === null || !navigator.getGamepads) return null;

    const gp = navigator.getGamepads()[this._gamepadIndex];
    if (!gp) return null;

    // Triggers (analog 0-1)
    const rt = gp.buttons[GP_RT] ? gp.buttons[GP_RT].value : 0;
    const lt = gp.buttons[GP_LT] ? gp.buttons[GP_LT].value : 0;
    const throttlePos = rt > TRIGGER_THRESHOLD ? rt : 0;
    const throttleNeg = lt > TRIGGER_THRESHOLD ? lt : 0;
    const throttle = throttlePos - throttleNeg;

    // Left stick X — negate: stick-right (positive) → steer negative (code convention: positive = left)
    const steer = -this._applyDeadzone(gp.axes[GP_AXIS_LEFT_X]);

    // Left stick Y — pitch
    const stickY = this._applyDeadzone(gp.axes[GP_AXIS_LEFT_Y]);
    const pitchDown = stickY < -DEADZONE; // stick forward = nose down
    const pitchUp = stickY > DEADZONE;    // stick back = nose up

    // Buttons
    const jumpDown = gp.buttons[GP_A] ? gp.buttons[GP_A].pressed : false;
    const jumpPressed = jumpDown && !this._gpJumpWasDown;
    this._gpJumpWasDown = jumpDown;

    const boost = gp.buttons[GP_B] ? gp.buttons[GP_B].pressed : false;

    const ballCamDown = gp.buttons[GP_Y] ? gp.buttons[GP_Y].pressed : false;
    const ballCamToggled = ballCamDown && !this._gpBallCamToggle;
    this._gpBallCamToggle = ballCamDown;

    const airRollLeft = gp.buttons[GP_LB] ? gp.buttons[GP_LB].pressed : false;
    const airRollRight = gp.buttons[GP_RB] ? gp.buttons[GP_RB].pressed : false;

    const handbrake = gp.buttons[GP_X] ? gp.buttons[GP_X].pressed : false;

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
      pitchUp,
      pitchDown,
      handbrake,
      lookX,
      dodgeForward,
      dodgeSteer,
    };
  }

  update() {
    const k = this.keys;

    // --- Keyboard values ---
    const kbForward = k['KeyW'] || k['ArrowUp'] ? 1 : 0;
    const kbBackward = k['KeyS'] || k['ArrowDown'] ? 1 : 0;
    const kbThrottle = kbForward - kbBackward;

    const kbLeft = k['KeyA'] || k['ArrowLeft'] ? 1 : 0;
    const kbRight = k['KeyD'] || k['ArrowRight'] ? 1 : 0;
    const kbSteer = kbLeft - kbRight; // positive = left turn

    const kbJumpDown = !!k['Space'];
    const kbJumpPressed = kbJumpDown && !this._jumpWasDown;
    this._jumpWasDown = kbJumpDown;

    const kbBoost = !!(k['ShiftLeft'] || k['ShiftRight']);

    const kbBallCamDown = !!k['KeyC'];
    const kbBallCamToggled = kbBallCamDown && !this._ballCamToggle;
    this._ballCamToggle = kbBallCamDown;

    const kbRollLeft = k['KeyQ'] ? -1 : 0;
    const kbRollRight = k['KeyE'] ? 1 : 0;
    const kbAirRoll = kbRollLeft + kbRollRight;

    const kbPitchUp = !!(k['KeyW'] || k['ArrowUp']);
    const kbPitchDown = !!(k['KeyS'] || k['ArrowDown']);

    const kbHandbrake = !!(k['ControlLeft'] || k['ControlRight']);

    // Camera swivel: J = look left (-1), L = look right (+1)
    const kbLookLeft = k['KeyJ'] ? -1 : 0;
    const kbLookRight = k['KeyL'] ? 1 : 0;
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

    // Jump: OR (!! coerce — tc guard can return null instead of false)
    this.state.jump = !!(kbJumpDown || (gp && gp.jump) || (tc && tc.jump));
    this.state.jumpPressed = !!(kbJumpPressed || (gp && gp.jumpPressed) || (tc && tc.jumpPressed));

    // Boost: OR (!! ensures boolean — null from tc guard would bypass Three.js visible===false check)
    this.state.boost = !!(kbBoost || (gp && gp.boost) || (tc && tc.boost));

    // Ball cam: either source can toggle
    if (kbBallCamToggled || (gp && gp.ballCamToggled) || (tc && tc.ballCamToggled)) {
      this.state.ballCam = !this.state.ballCam;
    }

    // Air roll: gamepad/keyboard only (no touch air roll)
    const gpAirRoll = gp ? (gp.airRollLeft ? -1 : 0) + (gp.airRollRight ? 1 : 0) : 0;
    this.state.airRoll = gpAirRoll !== 0 ? gpAirRoll : kbAirRoll;

    // Pitch: OR (!! coerce — tc guard can return null instead of false)
    this.state.pitchUp = !!(kbPitchUp || (gp && gp.pitchUp) || (tc && tc.pitchUp));
    this.state.pitchDown = !!(kbPitchDown || (gp && gp.pitchDown) || (tc && tc.pitchDown));

    // Handbrake: OR (!! coerce — tc guard can return null instead of false)
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
