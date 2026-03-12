// ============================================
// BallIndicator - Off-screen ball arrow indicator
// Shows a chevron at screen edge pointing toward the ball
// when ball cam is off and ball is not visible
// ============================================

import * as THREE from 'three';

const _projVec = new THREE.Vector3();

export class BallIndicator {
  /**
   * @param {THREE.Camera} camera
   * @param {object} ball - Ball object with body.position
   * @param {HTMLCanvasElement} canvas
   */
  constructor(camera, ball, canvas) {
    this.camera = camera;
    this.ball = ball;
    this.canvas = canvas;

    // Margin inside the viewport before we consider the ball "off-screen"
    this.margin = 60;

    // Create the arrow element
    this._arrowEl = document.createElement('div');
    this._arrowEl.className = 'ball-indicator';
    Object.assign(this._arrowEl.style, {
      position: 'absolute',
      pointerEvents: 'none',
      zIndex: '80',
      display: 'none',
      // Container holds both the arrow SVG and distance text
    });

    // SVG arrow (chevron pointing right, rotated to point toward ball)
    this._arrowEl.innerHTML = `
      <svg width="30" height="30" viewBox="0 0 30 30" style="display:block;">
        <path d="M8 4 L22 15 L8 26" fill="none" stroke="#ff8800" stroke-width="3.5"
              stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
      </svg>
      <div class="ball-indicator-dist" style="
        position:absolute;
        top:100%;
        left:50%;
        transform:translateX(-50%);
        color:rgba(255,136,0,0.6);
        font-family:'Rajdhani','Segoe UI',sans-serif;
        font-size:11px;
        font-weight:700;
        white-space:nowrap;
        letter-spacing:1px;
        text-shadow:0 0 4px rgba(0,0,0,0.8);
        margin-top:2px;
      "></div>
    `;

    this._distEl = this._arrowEl.querySelector('.ball-indicator-dist');

    const container = document.getElementById('game-container');
    (container || document.body).appendChild(this._arrowEl);
  }

  /**
   * Update indicator position each frame.
   * @param {boolean} ballCamOn - whether ball cam is active
   */
  update(ballCamOn) {
    // Only show when ball cam is OFF
    if (ballCamOn) {
      this._arrowEl.style.display = 'none';
      return;
    }

    if (!this.ball || !this.ball.body) {
      this._arrowEl.style.display = 'none';
      return;
    }

    const ballPos = this.ball.body.position;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const halfW = w / 2;
    const halfH = h / 2;

    // Project ball to screen
    _projVec.set(ballPos.x, ballPos.y, ballPos.z);
    _projVec.project(this.camera);

    // Screen coordinates (origin top-left)
    let sx = (_projVec.x * halfW) + halfW;
    let sy = -((_projVec.y * halfH) - halfH);

    // Check if behind camera
    const isBehind = _projVec.z > 1;

    // Check if within visible viewport (with margin)
    const isOnScreen = !isBehind &&
      sx >= this.margin && sx <= w - this.margin &&
      sy >= this.margin && sy <= h - this.margin;

    if (isOnScreen) {
      this._arrowEl.style.display = 'none';
      return;
    }

    // If behind camera, flip the projected position
    if (isBehind) {
      sx = w - sx;
      sy = h - sy;
    }

    // Center-relative coordinates
    const cx = sx - halfW;
    const cy = sy - halfH;

    // Clamp to screen edges with padding
    const pad = 40;
    const edgeL = pad;
    const edgeR = w - pad;
    const edgeT = pad;
    const edgeB = h - pad;

    // Find intersection of line from center to (sx,sy) with screen edges
    let clampedX = sx;
    let clampedY = sy;

    if (cx !== 0 || cy !== 0) {
      const angle = Math.atan2(cy, cx);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // Scale to hit the edge rectangle
      const maxX = (halfW - pad);
      const maxY = (halfH - pad);

      let scale = Infinity;
      if (cos !== 0) scale = Math.min(scale, Math.abs(maxX / cos));
      if (sin !== 0) scale = Math.min(scale, Math.abs(maxY / sin));

      clampedX = halfW + cos * scale;
      clampedY = halfH + sin * scale;
    }

    // Clamp to bounds
    clampedX = Math.max(edgeL, Math.min(edgeR, clampedX));
    clampedY = Math.max(edgeT, Math.min(edgeB, clampedY));

    // Rotation: arrow points from clamped position toward the ball's projected position
    const dx = sx - clampedX;
    const dy = sy - clampedY;
    const rotation = Math.atan2(dy, dx) * (180 / Math.PI);

    // Distance from camera to ball (in game units)
    const camPos = this.camera.position;
    const dist = Math.sqrt(
      (ballPos.x - camPos.x) ** 2 +
      (ballPos.y - camPos.y) ** 2 +
      (ballPos.z - camPos.z) ** 2
    );

    // Position and rotate the arrow
    this._arrowEl.style.display = '';
    this._arrowEl.style.left = `${clampedX - 15}px`;
    this._arrowEl.style.top = `${clampedY - 15}px`;
    this._arrowEl.style.transform = `rotate(${rotation}deg)`;

    // Update distance text
    this._distEl.textContent = `${Math.round(dist)}m`;
  }

  destroy() {
    if (this._arrowEl) {
      this._arrowEl.remove();
      this._arrowEl = null;
    }
  }
}
