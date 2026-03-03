// ============================================
// Input Manager - Keyboard + Gamepad input
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
    };

    // Keyboard edge detection
    this._jumpWasDown = false;
    this._ballCamToggle = false;

    // Gamepad edge detection (separate from keyboard)
    this._gpJumpWasDown = false;
    this._gpBallCamToggle = false;

    // Gamepad tracking
    this._gamepadIndex = null;

    window.addEventListener('keydown', (e) => {
      if (e.key === 'F12') return; // allow dev tools
      this.keys[e.code] = true;
      e.preventDefault();
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'F12') return;
      this.keys[e.code] = false;
      e.preventDefault();
    });

    // Prevent context menu on right click
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // Gamepad connect/disconnect
    window.addEventListener('gamepadconnected', (e) => {
      this._gamepadIndex = e.gamepad.index;
      this._showGamepadNotification('Controller connected: ' + e.gamepad.id.split('(')[0].trim());
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      if (this._gamepadIndex === e.gamepad.index) {
        this._gamepadIndex = null;
        this._gpJumpWasDown = false;
        this._gpBallCamToggle = false;
        this._showGamepadNotification('Controller disconnected');
      }
    });
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

    // --- Gamepad ---
    const gp = this._pollGamepad();

    if (!gp) {
      // No gamepad — use keyboard only (original behavior)
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
      return;
    }

    // --- Merge: max-magnitude for analog, OR for digital ---

    // Throttle: max-magnitude
    this.state.throttle = Math.abs(gp.throttle) > Math.abs(kbThrottle) ? gp.throttle : kbThrottle;

    // Steer: max-magnitude
    this.state.steer = Math.abs(gp.steer) > Math.abs(kbSteer) ? gp.steer : kbSteer;

    // Jump: OR
    this.state.jump = kbJumpDown || gp.jump;
    this.state.jumpPressed = kbJumpPressed || gp.jumpPressed;

    // Boost: OR
    this.state.boost = kbBoost || gp.boost;

    // Ball cam: either source can toggle
    if (kbBallCamToggled || gp.ballCamToggled) {
      this.state.ballCam = !this.state.ballCam;
    }

    // Air roll: OR (gamepad LB/RB as -1/+1, merge with keyboard)
    const gpAirRoll = (gp.airRollLeft ? -1 : 0) + (gp.airRollRight ? 1 : 0);
    this.state.airRoll = gpAirRoll !== 0 ? gpAirRoll : kbAirRoll;

    // Pitch: OR
    this.state.pitchUp = kbPitchUp || gp.pitchUp;
    this.state.pitchDown = kbPitchDown || gp.pitchDown;

    // Handbrake: OR
    this.state.handbrake = kbHandbrake || gp.handbrake;
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
}
