// ============================================
// Tutorial - Interactive first-time tutorial in freeplay mode
// Guides the player through core mechanics step-by-step
// ============================================

import * as THREE from 'three';
import { ARENA, BOOST_PAD_LAYOUT } from '../../shared/constants.js';

const STORAGE_KEY = 'blocket-tutorial-complete';

export function isTutorialComplete() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTutorialComplete() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {}
}

export class Tutorial {
  /**
   * @param {object} game - Game instance (has .playerCar, .ball, .boostPads, .scene, .state, .input, .camera, .scores)
   */
  constructor(game) {
    this.game = game;
    this.currentStep = 0;
    this.finished = false;
    this._dismissed = false;
    this._finishTimer = 0;

    // Track previous state for edge detection
    this._prevBallCam = true;
    this._prevScores = { blue: 0, orange: 0 };
    this._boostPickedUp = false;

    // Listen for boost pickup by watching car boost value
    this._prevBoost = game.playerCar ? game.playerCar.boost : 100;

    // 3D marker meshes
    this._markers = [];

    // Build overlay UI
    this._createOverlay();

    // Define tutorial steps
    this.steps = [
      {
        instruction: 'Drive to a boost pad!',
        subtext: 'Orange pads on the ground refill your boost meter',
        setup: () => this._setupBoostStep(),
        check: () => this._checkBoostPickup(),
        cleanup: () => this._cleanupMarkers(),
      },
      {
        instruction: 'Score a goal!',
        subtext: 'Hit the ball into the orange goal',
        setup: () => this._setupGoalStep(),
        check: () => this._checkGoalScored(),
        cleanup: () => this._cleanupMarkers(),
      },
      {
        instruction: 'Fly! Hold JUMP then BOOST',
        subtext: 'Hold SPACE to jump, then hold SHIFT to boost upward',
        setup: () => {},
        check: () => this._checkAerial(),
        cleanup: () => {},
      },
      {
        instruction: 'Flip! Tap JUMP twice quickly',
        subtext: 'Press SPACE, then tap it again to perform a dodge flip',
        setup: () => {},
        check: () => this._checkDodge(),
        cleanup: () => {},
      },
      {
        instruction: 'Toggle Ball Cam with C',
        subtext: 'Press C to switch camera modes',
        setup: () => { this._prevBallCam = this.game.input.state.ballCam; },
        check: () => this._checkBallCamToggle(),
        cleanup: () => {},
      },
    ];

    // Start first step
    this._activateStep(0);
  }

  _createOverlay() {
    const container = document.getElementById('game-container');

    // Main overlay container
    this._overlay = document.createElement('div');
    this._overlay.id = 'tutorial-overlay';
    Object.assign(this._overlay.style, {
      position: 'fixed',
      top: '0', left: '0', width: '100%', height: '100%',
      pointerEvents: 'none',
      zIndex: '300',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    });

    // Instruction box (top center)
    this._instructionBox = document.createElement('div');
    Object.assign(this._instructionBox.style, {
      marginTop: '15%',
      background: 'rgba(0, 0, 0, 0.75)',
      border: '2px solid rgba(0, 255, 255, 0.5)',
      borderRadius: '12px',
      padding: '20px 40px',
      textAlign: 'center',
      backdropFilter: 'blur(8px)',
      transition: 'opacity 0.4s, transform 0.4s',
      maxWidth: '500px',
    });

    this._instructionText = document.createElement('div');
    Object.assign(this._instructionText.style, {
      fontFamily: "'Orbitron', sans-serif",
      fontSize: '22px',
      fontWeight: '700',
      color: '#00ffff',
      letterSpacing: '2px',
      textShadow: '0 0 20px rgba(0, 255, 255, 0.6)',
      marginBottom: '8px',
    });

    this._subtextEl = document.createElement('div');
    Object.assign(this._subtextEl.style, {
      fontFamily: "'Rajdhani', 'Segoe UI', Arial, sans-serif",
      fontSize: '14px',
      color: 'rgba(255, 255, 255, 0.7)',
      letterSpacing: '1px',
    });

    // Step indicator (e.g., "1 / 5")
    this._stepIndicator = document.createElement('div');
    Object.assign(this._stepIndicator.style, {
      fontFamily: "'Orbitron', sans-serif",
      fontSize: '11px',
      color: 'rgba(0, 255, 255, 0.5)',
      marginTop: '12px',
      letterSpacing: '3px',
    });

    this._instructionBox.appendChild(this._instructionText);
    this._instructionBox.appendChild(this._subtextEl);
    this._instructionBox.appendChild(this._stepIndicator);
    this._overlay.appendChild(this._instructionBox);

    // Skip button (bottom right)
    this._skipBtn = document.createElement('button');
    this._skipBtn.textContent = 'Skip Tutorial';
    Object.assign(this._skipBtn.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      pointerEvents: 'auto',
      fontFamily: "'Orbitron', sans-serif",
      fontSize: '12px',
      color: 'rgba(255, 255, 255, 0.6)',
      background: 'rgba(0, 0, 0, 0.5)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '6px',
      padding: '8px 16px',
      cursor: 'pointer',
      letterSpacing: '1px',
      transition: 'color 0.2s, border-color 0.2s',
      zIndex: '301',
    });
    this._skipBtn.addEventListener('mouseenter', () => {
      this._skipBtn.style.color = '#fff';
      this._skipBtn.style.borderColor = 'rgba(0, 255, 255, 0.5)';
    });
    this._skipBtn.addEventListener('mouseleave', () => {
      this._skipBtn.style.color = 'rgba(255, 255, 255, 0.6)';
      this._skipBtn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    });
    this._skipBtn.addEventListener('click', () => {
      this._completeTutorial();
    });
    this._overlay.appendChild(this._skipBtn);

    container.appendChild(this._overlay);
  }

  _activateStep(index) {
    if (index >= this.steps.length) {
      this._showCompletion();
      return;
    }
    this.currentStep = index;
    const step = this.steps[index];

    // Animate instruction transition
    this._instructionBox.style.opacity = '0';
    this._instructionBox.style.transform = 'translateY(-10px)';

    setTimeout(() => {
      this._instructionText.textContent = step.instruction;
      this._subtextEl.textContent = step.subtext || '';
      this._stepIndicator.textContent = `${index + 1} / ${this.steps.length}`;
      this._instructionBox.style.opacity = '1';
      this._instructionBox.style.transform = 'translateY(0)';
      step.setup();
    }, 200);
  }

  _showCompletion() {
    this.finished = true;
    this._finishTimer = 3;
    this._cleanupMarkers();

    this._instructionBox.style.opacity = '0';
    this._instructionBox.style.transform = 'translateY(-10px)';

    setTimeout(() => {
      this._instructionText.textContent = "You're ready! Have fun!";
      this._instructionText.style.color = '#00ff88';
      this._instructionText.style.textShadow = '0 0 20px rgba(0, 255, 136, 0.6)';
      this._subtextEl.textContent = '';
      this._stepIndicator.textContent = '';
      this._instructionBox.style.opacity = '1';
      this._instructionBox.style.transform = 'translateY(0)';
      this._skipBtn.style.display = 'none';
    }, 200);
  }

  _completeTutorial() {
    markTutorialComplete();
    this._dismissed = true;
    this._cleanupMarkers();
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.remove();
    }
  }

  // --- Step setup helpers ---

  _setupBoostStep() {
    // Find the nearest large boost pad to the player
    const car = this.game.playerCar;
    if (!car) return;
    const carPos = car.getPosition();

    let nearestPad = null;
    let nearestDist = Infinity;

    for (const pad of this.game.boostPads.pads) {
      if (!pad.isLarge || !pad.active) continue;
      const dx = pad.position.x - carPos.x;
      const dz = pad.position.z - carPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestPad = pad;
      }
    }

    if (nearestPad) {
      this._createArrowMarker(nearestPad.position.x, 8, nearestPad.position.z);
    }

    // Snapshot boost to detect pickup
    this._boostPickedUp = false;
    this._prevBoost = car.boost;
  }

  _setupGoalStep() {
    // Arrow pointing at the ball
    const ball = this.game.ball;
    if (ball) {
      this._ballMarker = this._createArrowMarker(
        ball.body.position.x, ball.body.position.y + 6, ball.body.position.z,
        0x00ffff
      );
      this._ballMarker._followBall = true;
    }

    // Marker on the orange goal (positive Z end)
    const goalZ = ARENA.LENGTH / 2;
    this._createArrowMarker(0, 10, goalZ, 0xff8800);

    // Snapshot scores
    this._prevScores = { ...this.game.scores };
  }

  // --- Step completion checks ---

  _checkBoostPickup() {
    const car = this.game.playerCar;
    if (!car) return false;
    // Detect if any boost pad was picked up (boost increased or pad became inactive)
    // In freeplay, boost is always 100, so check pad activity instead
    for (const pad of this.game.boostPads.pads) {
      if (!pad.active && pad.respawnTimer > (pad.respawnTime - 0.5)) {
        return true; // A pad was just consumed
      }
    }
    return false;
  }

  _checkGoalScored() {
    const totalNow = this.game.scores.blue + this.game.scores.orange;
    const totalPrev = this._prevScores.blue + this._prevScores.orange;
    return totalNow > totalPrev;
  }

  _checkAerial() {
    const car = this.game.playerCar;
    if (!car) return false;
    const pos = car.getPosition();
    return pos.y > 5;
  }

  _checkDodge() {
    const car = this.game.playerCar;
    if (!car) return false;
    return car.isDodging;
  }

  _checkBallCamToggle() {
    const currentBallCam = this.game.input.state.ballCam;
    if (currentBallCam !== this._prevBallCam) {
      return true;
    }
    return false;
  }

  // --- 3D Marker helpers ---

  _createArrowMarker(x, y, z, color = 0x00ffff) {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // Arrow body (cone pointing down)
    const coneGeo = new THREE.ConeGeometry(0.8, 2.5, 8);
    const coneMat = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 2,
      transparent: true,
      opacity: 0.85,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.rotation.x = Math.PI; // Point downward
    group.add(cone);

    // Glow ring at base
    const ringGeo = new THREE.RingGeometry(1.0, 1.4, 16);
    const ringMat = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 1.5,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -1.5;
    group.add(ring);

    this.game.scene.add(group);
    this._markers.push(group);
    return group;
  }

  _cleanupMarkers() {
    for (const marker of this._markers) {
      this.game.scene.remove(marker);
      marker.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }
    this._markers = [];
    this._ballMarker = null;
  }

  // --- Update (called each frame from Game) ---

  update(dt) {
    if (this._dismissed) return;

    // Animate markers (bob up and down)
    const time = performance.now() * 0.001;
    for (const marker of this._markers) {
      if (marker._followBall && this.game.ball) {
        const bp = this.game.ball.body.position;
        marker.position.set(bp.x, bp.y + 6 + Math.sin(time * 3) * 0.5, bp.z);
      } else {
        const baseY = marker.position.y;
        marker.children[0].position.y = Math.sin(time * 3) * 0.5;
      }
    }

    if (this.finished) {
      this._finishTimer -= dt;
      if (this._finishTimer <= 0) {
        this._completeTutorial();
      }
      return;
    }

    // Check current step completion
    const step = this.steps[this.currentStep];
    if (step && step.check()) {
      step.cleanup();
      this._activateStep(this.currentStep + 1);
    }
  }

  destroy() {
    this._cleanupMarkers();
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.remove();
    }
    this._dismissed = true;
  }
}
