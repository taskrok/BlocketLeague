// ============================================
// TrainingMode - Training mode logic and HUD
// Extracted from Game.js
// ============================================

import { PHYSICS, BALL as BALL_CONST, COLORS } from '../../shared/constants.js';
import { TRAINING_PACKS } from './TrainingPacks.js';

export class TrainingMode {
  /**
   * @param {object} opts
   * @param {object} opts.trainingOpts - { type, difficulty }
   * @param {object} opts.hud - HUD instance
   * @param {object} opts.arena - Arena instance
   * @param {object} opts.ball - Ball instance
   * @param {object} opts.playerCar - player Car instance
   * @param {Array}  opts.allCars - allCars array
   * @param {object} opts.boostPads - BoostPads instance
   * @param {object} opts.explosionManager - ExplosionManager instance
   * @param {Function} opts.applyAimAssist - aim assist function
   */
  constructor({ trainingOpts, hud, arena, ball, playerCar, allCars, boostPads, explosionManager, applyAimAssist }) {
    this.trainingOpts = trainingOpts;
    this.hud = hud;
    this.arena = arena;
    this.ball = ball;
    this.playerCar = playerCar;
    this.allCars = allCars;
    this.boostPads = boostPads;
    this.explosionManager = explosionManager;
    this.applyAimAssist = applyAimAssist;

    const opts = trainingOpts;
    const pack = TRAINING_PACKS[opts.type]?.[opts.difficulty];
    if (!pack || pack.length === 0) {
      console.error('Invalid training pack:', opts);
      this._valid = false;
      return;
    }
    this._valid = true;

    this._trainingPack = pack;
    this._trainingShotIndex = 0;
    this._trainingScore = { hit: 0, total: pack.length };
    this._trainingShotTimer = 0;
    this._trainingShotActive = false;
    this._trainingShotResult = null;
    this._trainingResultTimer = 0;
    this._trainingType = opts.type;
    this._trainingBallTouched = false;
    this._trainingBallFrozen = false;
    this._trainingResults = new Array(pack.length).fill(null);
    this._trainingComplete = false;
    this._trainingGoalieFailed = false;
    this._trainingLaunchDelay = 0;
    this._trainingPendingVel = null;

    // DOM elements (created in buildHUD)
    this._trainingOverlay = null;
    this._trainingShotLabel = null;
    this._trainingScoreLabel = null;
    this._trainingTimerLabel = null;
    this._trainingResultLabel = null;
    this._trainingHint = null;
    this._trainingCompleteOverlay = null;
    this._trainingKeyHandler = null;
    this._trainingCompleteKeyHandler = null;
  }

  get isValid() {
    return this._valid;
  }

  init() {
    this._buildHUD();
    this._loadShot(0);
  }

  _buildHUD() {
    const type = this._trainingType;
    const diff = this.trainingOpts.difficulty;
    const labels = { striker: 'STRIKER', goalie: 'GOALIE', aerial: 'AERIAL' };
    const diffLabels = { rookie: 'ROOKIE', pro: 'PRO', allstar: 'ALL-STAR' };

    // Title bar
    this.hud.timerEl.textContent = `${labels[type] || type} — ${diffLabels[diff] || diff}`;
    this.hud.timerEl.style.color = '#00ffff';
    this.hud.timerEl.style.textShadow = '0 0 16px rgba(0, 255, 255, 0.6)';

    // Shot counter (replaces scoreboard)
    this.hud.scoreBlueEl.parentElement.style.display = 'none';

    // Training overlay
    this._trainingOverlay = document.createElement('div');
    this._trainingOverlay.id = 'training-overlay';
    Object.assign(this._trainingOverlay.style, {
      position: 'absolute',
      top: '50px',
      left: '50%',
      transform: 'translateX(-50%)',
      textAlign: 'center',
      zIndex: '200',
      pointerEvents: 'none',
      fontFamily: "'Orbitron', sans-serif",
    });

    // Shot counter
    this._trainingShotLabel = document.createElement('div');
    Object.assign(this._trainingShotLabel.style, {
      fontSize: '16px',
      fontWeight: '700',
      color: 'rgba(255,255,255,0.6)',
      letterSpacing: '2px',
      marginBottom: '4px',
    });

    // Score display
    this._trainingScoreLabel = document.createElement('div');
    Object.assign(this._trainingScoreLabel.style, {
      fontSize: '14px',
      fontWeight: '600',
      color: '#00ffff',
      letterSpacing: '1px',
    });

    // Timer display
    this._trainingTimerLabel = document.createElement('div');
    Object.assign(this._trainingTimerLabel.style, {
      fontSize: '22px',
      fontWeight: '800',
      color: '#fff',
      letterSpacing: '2px',
      marginTop: '4px',
    });

    // Result flash
    this._trainingResultLabel = document.createElement('div');
    Object.assign(this._trainingResultLabel.style, {
      fontSize: '48px',
      fontWeight: '900',
      letterSpacing: '6px',
      opacity: '0',
      transition: 'opacity 0.3s',
      position: 'fixed',
      top: '40%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '210',
      pointerEvents: 'none',
      textShadow: '0 0 30px currentColor',
    });
    document.body.appendChild(this._trainingResultLabel);

    // Controls hint
    this._trainingHint = document.createElement('div');
    Object.assign(this._trainingHint.style, {
      fontSize: '11px',
      color: 'rgba(255,255,255,0.3)',
      letterSpacing: '1px',
      marginTop: '6px',
    });
    this._trainingHint.textContent = 'R — Reset Shot | [ ] — Prev/Next';

    this._trainingOverlay.appendChild(this._trainingShotLabel);
    this._trainingOverlay.appendChild(this._trainingScoreLabel);
    this._trainingOverlay.appendChild(this._trainingTimerLabel);
    this._trainingOverlay.appendChild(this._trainingHint);

    document.getElementById('game-container').appendChild(this._trainingOverlay);

    this._updateHUD();

    // Key listeners for training controls
    this._trainingKeyHandler = (e) => {
      if (e.code === 'KeyR') {
        this._resetShot();
      } else if (e.code === 'BracketRight') {
        this._nextShot();
      } else if (e.code === 'BracketLeft') {
        this._prevShot();
      }
    };
    window.addEventListener('keydown', this._trainingKeyHandler);
  }

  _updateHUD() {
    const idx = this._trainingShotIndex;
    const total = this._trainingPack.length;
    this._trainingShotLabel.textContent = `SHOT ${idx + 1} / ${total}`;
    this._trainingScoreLabel.textContent = `${this._trainingScore.hit} / ${this._trainingScore.total}`;

    const t = Math.ceil(this._trainingShotTimer);
    this._trainingTimerLabel.textContent = this._trainingShotActive ? `${t}s` : '';
  }

  _loadShot(index) {
    if (index < 0 || index >= this._trainingPack.length) return;

    this._trainingShotIndex = index;
    const shot = this._trainingPack[index];

    // Reset car
    this.playerCar.reset(shot.carPos, shot.carDir);
    this.playerCar.boost = 100;

    // Position ball
    this.ball.body.position.set(shot.ballPos.x, shot.ballPos.y, shot.ballPos.z);
    this.ball.body.angularVelocity.set(0, 0, 0);
    this.ball._spinQuat.identity();

    const useLaunchDelay = (this._trainingType === 'aerial' && this.trainingOpts.difficulty === 'allstar')
      || this._trainingType === 'goalie';
    if (useLaunchDelay) {
      this.ball.body.velocity.set(0, 0, 0);
      this._trainingLaunchDelay = this._trainingType === 'goalie' ? 1.5 : 1.0;
      this._trainingPendingVel = { x: shot.ballVel.x, y: shot.ballVel.y, z: shot.ballVel.z };
    } else {
      this.ball.body.velocity.set(shot.ballVel.x, shot.ballVel.y, shot.ballVel.z);
      this._trainingLaunchDelay = 0;
      this._trainingPendingVel = null;
    }

    // Reset shot state
    this._trainingShotTimer = 11;
    this._trainingShotActive = true;
    this._trainingShotResult = null;
    this._trainingResultTimer = 0;
    this._trainingBallTouched = false;
    this._trainingGoalieFailed = false;

    this._trainingBallFrozen = (this._trainingType === 'aerial' && (this.trainingOpts.difficulty === 'rookie' || this.trainingOpts.difficulty === 'pro'));

    this._updateHUD();
  }

  _resetShot() {
    this._loadShot(this._trainingShotIndex);
  }

  _nextShot() {
    const next = (this._trainingShotIndex + 1) % this._trainingPack.length;
    this._loadShot(next);
  }

  _prevShot() {
    const prev = (this._trainingShotIndex - 1 + this._trainingPack.length) % this._trainingPack.length;
    this._loadShot(prev);
  }

  _showResult(result) {
    this._trainingShotResult = result;
    this._trainingResultTimer = 1.5;
    this._trainingShotActive = false;
    this._trainingResults[this._trainingShotIndex] = result;

    if (result === 'success') {
      this._trainingScore.hit++;
      this._trainingResultLabel.textContent = this._trainingType === 'goalie' ? 'SAVE!' : 'NICE SHOT!';
      this._trainingResultLabel.style.color = '#00ff88';
    } else {
      this._trainingResultLabel.textContent = this._trainingType === 'goalie' ? 'GOAL' : 'MISS';
      this._trainingResultLabel.style.color = '#ff4444';
    }
    this._trainingResultLabel.style.opacity = '1';
    this._updateHUD();
  }

  _showComplete() {
    this._trainingComplete = true;
    this._trainingShotActive = false;

    const hits = this._trainingResults.filter(r => r === 'success').length;
    const total = this._trainingResults.length;
    const pct = Math.round((hits / total) * 100);

    const labels = { striker: 'STRIKER', goalie: 'GOALIE', aerial: 'AERIAL' };
    const diffLabels = { rookie: 'ROOKIE', pro: 'PRO', allstar: 'ALL-STAR' };
    const typeName = labels[this._trainingType] || this._trainingType;
    const diffName = diffLabels[this.trainingOpts.difficulty] || this.trainingOpts.difficulty;

    // Grade
    let grade, gradeColor;
    if (pct === 100) { grade = 'PERFECT!'; gradeColor = '#ffd700'; }
    else if (pct >= 80) { grade = 'GREAT!'; gradeColor = '#00ff88'; }
    else if (pct >= 50) { grade = 'GOOD'; gradeColor = '#00ccff'; }
    else { grade = 'KEEP PRACTICING'; gradeColor = '#ff8844'; }

    // Build completion overlay
    this._trainingCompleteOverlay = document.createElement('div');
    Object.assign(this._trainingCompleteOverlay.style, {
      position: 'absolute',
      top: '0', left: '0', width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.95) 100%)',
      zIndex: '500',
      fontFamily: "'Orbitron', sans-serif",
      animation: 'fadeIn 0.4s ease',
    });

    // Title
    const title = document.createElement('div');
    Object.assign(title.style, {
      fontSize: '20px', color: '#00ffff', letterSpacing: '3px', marginBottom: '8px',
      textShadow: '0 0 20px rgba(0,255,255,0.5)',
    });
    title.textContent = `${typeName} — ${diffName}`;

    // "TRAINING COMPLETE"
    const heading = document.createElement('div');
    Object.assign(heading.style, {
      fontSize: '36px', fontWeight: '800', color: '#fff', letterSpacing: '4px',
      marginBottom: '24px', textShadow: '0 0 30px rgba(255,255,255,0.3)',
    });
    heading.textContent = 'TRAINING COMPLETE';

    // Score
    const scoreEl = document.createElement('div');
    Object.assign(scoreEl.style, {
      fontSize: '48px', fontWeight: '800', color: gradeColor, marginBottom: '8px',
      textShadow: `0 0 30px ${gradeColor}80`,
    });
    scoreEl.textContent = `${hits} / ${total}`;

    // Grade label
    const gradeEl = document.createElement('div');
    Object.assign(gradeEl.style, {
      fontSize: '24px', fontWeight: '700', color: gradeColor, letterSpacing: '3px',
      marginBottom: '24px', textShadow: `0 0 20px ${gradeColor}60`,
    });
    gradeEl.textContent = grade;

    // Shot results grid
    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'flex', gap: '8px', marginBottom: '32px', flexWrap: 'wrap', justifyContent: 'center',
    });
    this._trainingResults.forEach((r, i) => {
      const dot = document.createElement('div');
      const isHit = r === 'success';
      Object.assign(dot.style, {
        width: '36px', height: '36px', borderRadius: '6px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '14px', fontWeight: '700', fontFamily: "'Orbitron', sans-serif",
        background: isHit ? 'rgba(0,255,136,0.2)' : 'rgba(255,68,68,0.2)',
        border: `2px solid ${isHit ? '#00ff88' : '#ff4444'}`,
        color: isHit ? '#00ff88' : '#ff4444',
      });
      dot.textContent = i + 1;
      grid.appendChild(dot);
    });

    // Continue button
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      padding: '12px 40px', fontSize: '16px', fontWeight: '700',
      fontFamily: "'Orbitron', sans-serif", letterSpacing: '2px',
      background: 'linear-gradient(135deg, #00ccff, #0088ff)',
      color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer',
      boxShadow: '0 0 20px rgba(0,136,255,0.4)',
      transition: 'transform 0.15s, box-shadow 0.15s',
    });
    btn.textContent = 'BACK TO MENU';
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.05)'; btn.style.boxShadow = '0 0 30px rgba(0,136,255,0.6)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; btn.style.boxShadow = '0 0 20px rgba(0,136,255,0.4)'; };
    btn.onclick = () => {
      if (this.hud.onBackToLobby) this.hud.onBackToLobby();
    };

    this._trainingCompleteOverlay.appendChild(title);
    this._trainingCompleteOverlay.appendChild(heading);
    this._trainingCompleteOverlay.appendChild(scoreEl);
    this._trainingCompleteOverlay.appendChild(gradeEl);
    this._trainingCompleteOverlay.appendChild(grid);
    this._trainingCompleteOverlay.appendChild(btn);

    document.getElementById('game-container').appendChild(this._trainingCompleteOverlay);

    // Also allow Escape to return
    this._trainingCompleteKeyHandler = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        if (this.hud.onBackToLobby) this.hud.onBackToLobby();
      }
    };
    window.addEventListener('keydown', this._trainingCompleteKeyHandler);
  }

  update(dt, inputState, world, accumulator) {
    // Physics
    let acc = accumulator;
    acc += dt;
    while (acc >= PHYSICS.TIMESTEP) {
      world.step(PHYSICS.TIMESTEP);
      acc -= PHYSICS.TIMESTEP;
    }

    for (const car of this.allCars) car._syncMesh();
    this.ball.update(dt);

    // Update explosions and landing effects
    this.explosionManager.updateExplosions(dt);
    this.explosionManager.checkLandingEffects(this.allCars);
    this.explosionManager.updateLandingRings(dt);

    // Player car input
    if (!this.playerCar.demolished) {
      const assisted = this.applyAimAssist(inputState);
      this.playerCar.update(assisted, dt);
    }

    // Boost pads
    this.boostPads.update(dt, this.allCars);

    // Aerial allstar: hold ball at spawn for 1s delay then launch
    if (this._trainingLaunchDelay > 0) {
      this._trainingLaunchDelay -= dt;
      const shot = this._trainingPack[this._trainingShotIndex];
      this.ball.body.position.set(shot.ballPos.x, shot.ballPos.y, shot.ballPos.z);
      this.ball.body.velocity.set(0, 0, 0);
      this.ball.body.angularVelocity.set(0, 0, 0);
      if (this._trainingLaunchDelay <= 0 && this._trainingPendingVel) {
        this.ball.body.velocity.set(this._trainingPendingVel.x, this._trainingPendingVel.y, this._trainingPendingVel.z);
        this._trainingPendingVel = null;
      }
    }

    // Aerial rookie/pro: hold ball in place until player touches it
    if (this._trainingBallFrozen) {
      const shot = this._trainingPack[this._trainingShotIndex];
      this.ball.body.position.set(shot.ballPos.x, shot.ballPos.y, shot.ballPos.z);
      this.ball.body.velocity.set(0, 0, 0);
      this.ball.body.angularVelocity.set(0, 0, 0);

      const cp = this.playerCar.body.position;
      const bp = this.ball.body.position;
      const ddx = bp.x - cp.x, ddy = bp.y - cp.y, ddz = bp.z - cp.z;
      if (Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) < BALL_CONST.RADIUS + 3.5) {
        this._trainingBallFrozen = false;
      }
    }

    // Result display timer
    if (this._trainingShotResult) {
      this._trainingResultTimer -= dt;
      if (this._trainingResultTimer <= 0) {
        this._trainingResultLabel.style.opacity = '0';
        this._trainingShotResult = null;
        if (this._trainingResults.every(r => r !== null)) {
          this._showComplete();
          return acc;
        }
        this._nextShot();
      }
      return acc;
    }

    if (this._trainingComplete) return acc;

    if (!this._trainingShotActive) return acc;

    // Shot timer countdown
    this._trainingShotTimer -= dt;
    this._updateHUD();

    // Detect ball-car contact for goalie mode
    if (this._trainingType === 'goalie') {
      const carPos = this.playerCar.body.position;
      const ballPos = this.ball.body.position;
      const dx = ballPos.x - carPos.x;
      const dy = ballPos.y - carPos.y;
      const dz = ballPos.z - carPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < BALL_CONST.RADIUS + 3.5) {
        this._trainingBallTouched = true;
      }
    }

    // Check success/failure based on training type
    if (this._trainingType === 'striker' || this._trainingType === 'aerial') {
      const goalSide = this.arena.isInGoal(this.ball.body.position);
      if (goalSide === 2) {
        const ballPos = this.ball.body.position;
        this.explosionManager.spawnGoalExplosion({ x: ballPos.x, y: ballPos.y, z: ballPos.z }, COLORS.GOAL_ORANGE);
        this._showResult('success');
        return acc;
      }
      if (this._trainingShotTimer <= 0) {
        this._showResult('fail');
        return acc;
      }
    } else if (this._trainingType === 'goalie') {
      const goalSide = this.arena.isInGoal(this.ball.body.position);
      if (goalSide === 1) {
        const ballPos = this.ball.body.position;
        this.explosionManager.spawnGoalExplosion({ x: ballPos.x, y: ballPos.y, z: ballPos.z }, COLORS.GOAL_BLUE);
        this._showResult('fail');
        return acc;
      }

      if (this._trainingBallTouched) {
        const vz = this.ball.body.velocity.z;
        if (vz > 2) {
          this._showResult('success');
          return acc;
        }
      }

      if (this._trainingShotTimer <= 0) {
        this._showResult('success');
        return acc;
      }
    }

    // Ball out of bounds reset
    if (this.ball.body.position.y < -20) {
      this._resetShot();
    }

    return acc;
  }

  destroy() {
    if (this._trainingOverlay) {
      this._trainingOverlay.remove();
    }
    if (this._trainingResultLabel) {
      this._trainingResultLabel.remove();
    }
    if (this._trainingKeyHandler) {
      window.removeEventListener('keydown', this._trainingKeyHandler);
    }
    if (this._trainingCompleteOverlay) {
      this._trainingCompleteOverlay.remove();
    }
    if (this._trainingCompleteKeyHandler) {
      window.removeEventListener('keydown', this._trainingCompleteKeyHandler);
    }
  }
}
