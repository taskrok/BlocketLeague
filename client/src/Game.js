// ============================================
// Game - Main game loop and state management
// Supports both single-player (vs AI) and online multiplayer
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { Arena } from './Arena.js';
import { Car } from './Car.js';
import { generateCarVariant } from './CarVariants.js';
import { modelLoader } from './ModelLoader.js';
import { Ball } from './Ball.js';
import { BoostPads } from './BoostPads.js';
import { InputManager } from './InputManager.js';
import { CameraController } from './Camera.js';
import { GameSettings, getDisplaySettings } from './GameSettings.js';
import { HUD } from './HUD.js';
import { ReplayBuffer } from './ReplayBuffer.js';
import { ReplayPlayer } from './ReplayPlayer.js';
import {
  PHYSICS, ARENA as ARENA_CONST, BALL as BALL_CONST,
  COLORS, SPAWNS, GAME, CAR as CAR_CONST, COLLISION_GROUPS,
  NETWORK, DEMOLITION, RANDOM_NAMES,
} from '../../shared/constants.js';
import { computeBallHitImpulse } from '../../shared/BallHitImpulse.js';
import { PerformanceTracker } from '../../shared/PerformanceTracker.js';
import { checkDemolition, handleBump } from '../../shared/Demolition.js';
import { AIController, findPlayerTeam, pickOpponentTeam } from './AIController.js';
import { ExplosionManager } from './ExplosionManager.js';
import { TrainingMode } from './TrainingMode.js';
import { audioManager } from './AudioManager.js';
import { QuickChat } from './QuickChat.js';
import { BallIndicator } from './BallIndicator.js';
import { Tutorial, isTutorialComplete } from './Tutorial.js';
import { progression } from './Progression.js';

// Reusable temp vectors
const _aimEuler = new CANNON.Vec3();
const _npVec = new THREE.Vector3(); // reusable vector for nameplate projection


export class Game {
  constructor(canvas, options = {}) {
    const {
      mode = 'singleplayer',
      networkManager = null,
      playerVariant = null,
      joinedData = null,
      aiDifficulty = 'pro',
      aiMode = '1v1',
      trainingOpts = null,
      arenaTheme = null,
    } = options;

    this.canvas = canvas;
    this.mode = mode;
    this.network = networkManager;
    this.playerVariant = playerVariant;
    this._joinedData = joinedData;
    this.aiDifficulty = aiDifficulty;
    this.aiMode = aiMode;
    this.trainingOpts = trainingOpts; // { type, difficulty }
    this.arenaTheme = arenaTheme;
    this._destroyed = false;
    this._rafId = null;

    // Game state
    this.state = 'countdown';
    this.scores = { blue: 0, orange: 0 };
    this.matchTime = GAME.MATCH_DURATION;
    this.countdownTime = GAME.COUNTDOWN_DURATION;
    this.goalResetTime = 0;
    this.isOvertime = false;

    // Multiplayer state
    this.playerNumber = -1;
    this.playerCar = null;
    this.remoteCars = [];   // Array of { car, slot } for all non-local players
    this.allCars = [];      // Indexed by slot number
    this.maxPlayers = 2;
    this.myTeam = 'blue';

    // Legacy alias for singleplayer AI
    this.opponentCar = null;

    // Smooth reconciliation: visual correction offset decays over time
    this._correctionOffset = { x: 0, y: 0, z: 0 };

    // Server-authoritative ball target for smooth visual interpolation (multiplayer)
    this._ballTarget = null;

    // Deferred countdown events (buffered during replay/celebration)
    this._deferredCountdown = null;

    // Explosion and landing ring VFX (delegated to ExplosionManager, created after scene init)

    this._initRenderer();
    this._initPhysics();

    this.input = new InputManager();
    this.hud = new HUD();
    this.replayBuffer = new ReplayBuffer();

    // Add HUD level badge
    this._hudLevelBadge = progression.createHUDLevelBadge();
    const gameContainer = document.getElementById('game-container');
    if (gameContainer) gameContainer.appendChild(this._hudLevelBadge);
    this.replayPlayer = new ReplayPlayer();

    if (this.mode === 'training') {
      this._initTraining();
    } else if (this.mode === 'singleplayer' || this.mode === 'freeplay') {
      this._initScene();
      this.cameraController = new CameraController(this.camera);
      this.cameraController.setTarget(this.playerCar);
      this.cameraController.setBallTarget(this.ball);
      this._initPostProcessing();
      if (this.mode === 'freeplay') {
        this.state = 'playing';
        audioManager.startCrowdAmbiance();
        this.matchTime = Infinity;
        this.hud.updateTimer(0);
        this.hud.timerEl.textContent = 'FREE PLAY';
        this.hud.timerEl.style.color = '#00ff88';
        this.hud.timerEl.style.textShadow = '0 0 16px rgba(0, 255, 136, 0.6)';
        // Start tutorial if not yet completed
        if (!isTutorialComplete()) {
          this.tutorial = new Tutorial(this);
        }
      } else {
        // Start match timer for progression tracking
        progression.startMatch();
        this._startCountdown();
      }
    } else {
      // Multiplayer: init scene partially, wait for 'joined' to create cars
      this._initSceneMultiplayer();
      this.cameraController = new CameraController(this.camera);
      this.cameraController.setBallTarget(this.ball);
      this._initPostProcessing();
      this._initMultiplayer();
    }

    this.gameSettings = new GameSettings(this.cameraController, this.input);
    this.gameSettings.onReturnToLobby = () => {
      if (this.hud.onBackToLobby) this.hud.onBackToLobby();
    };

    // Quick-chat system
    this.quickChat = new QuickChat({
      container: document.getElementById('game-container'),
      camera: this.camera,
      canvas: this.canvas,
      input: this.input,
      network: this.network,
      mode: this.mode,
    });

    // Off-screen ball indicator
    this.ballIndicator = new BallIndicator(this.camera, this.ball, this.canvas);

    this.clock = new THREE.Clock();
    this.accumulator = 0;

    this._loop();
  }

  _initRenderer() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this._isIOS = isIOS;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !isIOS,
      powerPreference: isIOS ? 'default' : 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    // Handle WebGL context loss (common on iOS when backgrounding)
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.hud.showStatus('WebGL context lost — tap to reload');
      this._destroyed = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      window.location.reload();
    });
    this.canvas.addEventListener('click', () => {
      if (this._destroyed) window.location.reload();
    });

    this._onResize = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);
  }

  _initPhysics() {
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, PHYSICS.GRAVITY, 0),
    });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = 10;

    const carMaterial = this.carMaterial = new CANNON.Material('car');
    const ballMaterial = this.ballMaterial = new CANNON.Material('ball');
    const wallMaterial = this.wallMaterial = new CANNON.Material('wall');

    this.world.addContactMaterial(new CANNON.ContactMaterial(
      ballMaterial, wallMaterial, {
        restitution: BALL_CONST.RESTITUTION,
        friction: BALL_CONST.FRICTION,
      }
    ));

    this.world.addContactMaterial(new CANNON.ContactMaterial(
      carMaterial, ballMaterial, {
        restitution: 0.5,
        friction: 0.02,
      }
    ));

    this.world.addContactMaterial(new CANNON.ContactMaterial(
      carMaterial, wallMaterial, {
        restitution: 0.1,
        friction: 0.0,
      }
    ));

    this.world.addContactMaterial(new CANNON.ContactMaterial(
      carMaterial, carMaterial, {
        restitution: 0.05,
        friction: 0.0,
      }
    ));

    this.world.defaultContactMaterial.restitution = 0.3;
    this.world.defaultContactMaterial.friction = 0.0;
  }

  // ========== SINGLE-PLAYER SCENE INIT ==========

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.arenaTheme ? this.arenaTheme.bg : 0x050510);
    this.scene.fog = new THREE.Fog(0x050510, 140, 300);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 400
    );
    this.camera.position.set(0, 15, -30);

    this.arena = new Arena(this.scene, this.world, this.arenaTheme);

    this.world.bodies.forEach(b => {
      if (b.type === CANNON.Body.STATIC && !b.material) {
        b.material = this.wallMaterial;
      }
    });

    this.ball = new Ball(this.scene, this.world);
    this.ball.body.material = this.ballMaterial;

    const modelIds = modelLoader.getModelIds();
    const playerVariant = this.playerVariant || generateCarVariant(COLORS.CYAN, modelIds);
    playerVariant.bodyColor = COLORS.TEAM_BLUE_BODY;

    if (this.mode === 'freeplay' || this.mode === 'training') {
      // Freeplay/Training: only the player car, no opponents
      this.playerCar = new Car(
        this.scene, this.world,
        SPAWNS.PLAYER1, COLORS.CYAN, 1,
        this.arena.trimeshBody, playerVariant
      );
      this.playerCar.body.material = this.carMaterial;
      this.playerCar.isLocalPlayer = true;
      this.allCars = [this.playerCar];
      this.aiCars = [];
    } else if (this.aiMode === '2v2') {
      // 2v2: 4 cars — player + AI teammate (blue) vs 2 AI opponents (orange)
      // Find player's team based on their car, pick a different team for opponents
      const playerModelId = playerVariant ? playerVariant.modelId : null;
      const playerTeam = findPlayerTeam(playerModelId);
      const oppTeam = pickOpponentTeam(modelIds, playerTeam);

      this._playerTeamName = playerTeam ? playerTeam.name : 'Blue';
      this._aiTeamName = oppTeam ? oppTeam.name : 'Orange';

      // Assign teammate: the other car from the player's team
      const allyVariant = generateCarVariant(COLORS.CYAN, modelIds);
      allyVariant.bodyColor = COLORS.TEAM_BLUE_BODY;
      if (playerTeam) {
        const allyModelId = playerTeam.cars.find(c => c !== playerModelId) || playerTeam.cars[0];
        allyVariant.modelId = allyModelId;
      }

      const opp1Variant = generateCarVariant(COLORS.ORANGE, modelIds);
      opp1Variant.bodyColor = COLORS.TEAM_ORANGE_BODY;
      const opp2Variant = generateCarVariant(COLORS.ORANGE, modelIds);
      opp2Variant.bodyColor = COLORS.TEAM_ORANGE_BODY;
      if (oppTeam) {
        opp1Variant.modelId = oppTeam.cars[0];
        opp2Variant.modelId = oppTeam.cars[1];
      }

      this.playerCar = new Car(
        this.scene, this.world,
        SPAWNS.TEAM_BLUE[0], COLORS.CYAN, 1,
        this.arena.trimeshBody, playerVariant
      );
      this.playerCar.body.material = this.carMaterial;
      this.playerCar.isLocalPlayer = true;

      const allyCar = new Car(
        this.scene, this.world,
        SPAWNS.TEAM_BLUE[1], COLORS.CYAN, 1,
        this.arena.trimeshBody, allyVariant
      );
      allyCar.body.material = this.carMaterial;

      const opp1Car = new Car(
        this.scene, this.world,
        SPAWNS.TEAM_ORANGE[0], COLORS.ORANGE, -1,
        this.arena.trimeshBody, opp1Variant
      );
      opp1Car.body.material = this.carMaterial;

      const opp2Car = new Car(
        this.scene, this.world,
        SPAWNS.TEAM_ORANGE[1], COLORS.ORANGE, -1,
        this.arena.trimeshBody, opp2Variant
      );
      opp2Car.body.material = this.carMaterial;

      this.allCars = [this.playerCar, allyCar, opp1Car, opp2Car];
      this.aiCars = [allyCar, opp1Car, opp2Car];
      this.opponentCar = opp1Car; // legacy alias
    } else {
      // 1v1: 2 cars — player (blue) vs AI opponent (orange)
      const opponentVariant = generateCarVariant(COLORS.ORANGE, modelIds);
      opponentVariant.bodyColor = COLORS.TEAM_ORANGE_BODY;

      this.playerCar = new Car(
        this.scene, this.world,
        SPAWNS.PLAYER1, COLORS.CYAN, 1,
        this.arena.trimeshBody, playerVariant
      );
      this.playerCar.body.material = this.carMaterial;
      this.playerCar.isLocalPlayer = true;

      this.opponentCar = new Car(
        this.scene, this.world,
        SPAWNS.PLAYER2, COLORS.ORANGE, -1,
        this.arena.trimeshBody, opponentVariant
      );
      this.opponentCar.body.material = this.carMaterial;

      this.allCars = [this.playerCar, this.opponentCar];
      this.aiCars = [this.opponentCar];
    }

    // Set per-car audio profile based on the player's car model
    if (playerVariant && playerVariant.modelId) {
      audioManager.setCarModel(playerVariant.modelId);
    }

    this._initBallCollisionHandler();
    this._initCarCollisionHandler();

    this.boostPads = new BoostPads(this.scene);
    this.explosionManager = new ExplosionManager(this.scene);
    this.maxPlayers = this.allCars.length;
    this.perfTracker = new PerformanceTracker(this.maxPlayers);

    // Assign names for scoreboard
    this._assignPlayerNames();

    // AI controller (singleplayer modes only)
    if (this.aiCars && this.aiCars.length > 0) {
      this.aiController = new AIController({
        allCars: this.allCars,
        aiCars: this.aiCars,
        ball: this.ball,
        difficulty: this.aiDifficulty,
        aiMode: this.aiMode,
      });
    }
  }

  _assignPlayerNames() {
    // Shuffle and pick unique names for AI
    const shuffled = [...RANDOM_NAMES].sort(() => Math.random() - 0.5);

    // Get human player name from localStorage
    let humanName = '';
    try { humanName = localStorage.getItem('blocket-player-name') || ''; } catch {}
    if (!humanName) humanName = shuffled.pop() || 'Player';

    const names = [];
    for (let i = 0; i < this.allCars.length; i++) {
      if (i === 0) {
        // Player is always slot 0 in singleplayer/freeplay
        names.push(humanName);
      } else {
        names.push(shuffled.pop() || `Bot ${i}`);
      }
    }
    this._carNames = names;
    this.hud.setPlayerNames(names);

    // Set team names for 2v2
    if (this.aiMode === '2v2') {
      const blueName = (this._playerTeamName || 'BLUE').toUpperCase();
      const orangeName = (this._aiTeamName || 'ORANGE').toUpperCase();
      this.hud.setTeamNames(blueName, orangeName);
    }

    // Create nameplates for all cars except the player
    this._initNameplates();
  }

  _initNameplates() {
    this._nameplates = [];
    const container = document.getElementById('game-container');
    for (let i = 0; i < this.allCars.length; i++) {
      if (i === 0) { this._nameplates.push(null); continue; } // skip player car

      const el = document.createElement('div');
      el.className = 'car-nameplate';
      // Team color: in 2v2 blue is indices 0-1, orange is 2-3. In 1v1, 0 is blue, 1 is orange.
      const half = this.allCars.length / 2;
      const isBlue = i < half;
      const teamColor = isBlue ? '#4dc8ff' : '#ff8844';
      el.style.color = teamColor;
      // Boost indicator circle (SVG) + name
      const circ = 2 * Math.PI * 5; // r=5
      el.innerHTML = `<svg class="np-boost" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"/><circle class="np-boost-fill" cx="7" cy="7" r="5" fill="none" stroke="${teamColor}" stroke-width="2" stroke-dasharray="${circ}" stroke-dashoffset="0" transform="rotate(-90 7 7)"/></svg><span class="np-name">${this._carNames[i] || ''}</span>`;
      container.appendChild(el);
      this._nameplates.push(el);
    }
  }

  _updateNameplates() {
    if (!this._nameplates || !this.camera) return;
    const cam = this.camera;
    const halfW = this.canvas.clientWidth / 2;
    const halfH = this.canvas.clientHeight / 2;

    for (let i = 1; i < this.allCars.length; i++) {
      const el = this._nameplates[i];
      if (!el) continue;
      const car = this.allCars[i];
      if (!car || !car.mesh) { el.style.display = 'none'; continue; }

      // Project car position to screen (offset up above the car)
      _npVec.set(car.mesh.position.x, car.mesh.position.y + 3.5, car.mesh.position.z);
      _npVec.project(cam);

      // Behind camera check
      if (_npVec.z > 1) { el.style.display = 'none'; continue; }

      const sx = (_npVec.x * halfW) + halfW;
      const sy = -((_npVec.y * halfH) - halfH);

      // Distance-based scale and opacity
      const dist = cam.position.distanceTo(car.mesh.position);
      const scale = Math.max(0.5, Math.min(1, 20 / dist));
      const opacity = Math.max(0.3, Math.min(0.9, 25 / dist));

      el.style.display = '';
      el.style.left = `${sx}px`;
      el.style.top = `${sy}px`;
      el.style.transform = `translate(-50%, -100%) scale(${scale.toFixed(2)})`;
      el.style.opacity = opacity.toFixed(2);

      // Update boost circle
      const fill = el.querySelector('.np-boost-fill');
      if (fill) {
        const pct = (car.boost || 0) / 100;
        const circ = 2 * Math.PI * 5;
        fill.setAttribute('stroke-dashoffset', (circ * (1 - pct)).toFixed(1));
      }
    }
  }


  // ========== CONTROLS HINT (GAMEPAD AWARE) ==========

  _updateControlsHint() {
    const hint = this.hud.controlsHint;
    if (!hint || hint.classList.contains('hidden')) return;

    const hasGamepad = this.input._gamepadIndex !== null;
    if (hasGamepad && !this._controlsHintGamepad) {
      this._controlsHintGamepad = true;
      hint.innerHTML = '<p>A - Jump | B - Boost | LT - Air Roll | RB/LB - Roll | Y - Ball Cam</p>';
    } else if (!hasGamepad && this._controlsHintGamepad) {
      this._controlsHintGamepad = false;
      hint.innerHTML = '<p>WASD - Drive | SPACE - Jump | SHIFT - Boost | C - Ball Cam | J/L - Look</p>';
    }
  }
  // ========== MULTIPLAYER SCENE INIT ==========

  _initSceneMultiplayer() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.arenaTheme ? this.arenaTheme.bg : 0x050510);
    this.scene.fog = new THREE.Fog(0x050510, 140, 300);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 400
    );
    this.camera.position.set(0, 15, -30);

    this.arena = new Arena(this.scene, this.world, this.arenaTheme);

    this.world.bodies.forEach(b => {
      if (b.type === CANNON.Body.STATIC && !b.material) {
        b.material = this.wallMaterial;
      }
    });

    // Ball with isRemote — body not added to world (server drives it)
    this.ball = new Ball(this.scene, this.world, true);
    this.ball.body.material = this.ballMaterial;

    // Boost pads with isRemote — server handles pickup/respawn
    this.boostPads = new BoostPads(this.scene, true);
    this.explosionManager = new ExplosionManager(this.scene);
  }

  _initMultiplayer() {
    progression.startMatch();
    this._localVariant = this.playerVariant || generateCarVariant(COLORS.CYAN, modelLoader.getModelIds());

    // If joinedData was passed from the lobby flow, create cars immediately
    if (this._joinedData) {
      this.playerNumber = this._joinedData.playerNumber;
      this._createMultiplayerCars(this._joinedData);
    }

    this.network.on('joined', (data) => {
      if (this.playerCar) return; // already created
      this.hud.showStatus('');
      this.playerNumber = data.playerNumber;
      this._createMultiplayerCars(data);
    });

    this.network.on('countdown', (data) => {
      // Defer countdown events during replay/celebration — apply after replay finishes
      if (this.state === 'replay' || this.state === 'goal_celebration') {
        this._deferredCountdown = data;
        return;
      }
      this._applyCountdown(data);
    });

    this.network.on('gameState', (snapshot) => {
      if (this.state === 'playing' || this.state === 'overtime') {
        // Active gameplay: full reconciliation with prediction replay
        this._reconcile(snapshot);
      } else if (this.state === 'countdown') {
        // During countdown: snap player car to server position (no prediction needed)
        const myState = snapshot.players[this.playerNumber];
        if (myState && this.playerCar) {
          this.playerCar.body.position.set(myState.px, myState.py, myState.pz);
          this.playerCar.body.velocity.set(0, 0, 0);
          this.playerCar.body.quaternion.set(myState.qx, myState.qy, myState.qz, myState.qw);
          this.playerCar.body.angularVelocity.set(0, 0, 0);
          this.playerCar.boost = myState.boost;
          this._correctionOffset.x = 0;
          this._correctionOffset.y = 0;
          this._correctionOffset.z = 0;
          this.playerCar._syncMesh();
        }
      }
    });

    this.network.on('demolition', (data) => {
      if (!this.allCars || !this.allCars[data.victimIdx]) return;
      const victim = this.allCars[data.victimIdx];
      if (victim.demolished) return;
      const pos = data.position;
      const isBlueTeam = data.victimIdx < this.maxPlayers / 2;
      const color = isBlueTeam ? COLORS.CYAN : COLORS.ORANGE;
      victim.demolish();
      this.explosionManager.spawnExplosion(pos, color);
      audioManager.playDemolition();
      if (data.victimIdx === this.playerNumber) {
        this.hud.showDemolished();
      }
    });

    this.network.on('goalScored', (data) => {
      this.scores.blue = data.blueScore;
      this.scores.orange = data.orangeScore;
      this.hud.updateScore(data.blueScore, data.orangeScore);
      const scorerName = data.scorerIdx >= 0 ? this.hud._getPlayerLabel(data.scorerIdx, this.maxPlayers) : null;
      this.hud.showGoalScored(data.team, scorerName);
      audioManager.playGoalHorn();
      this._lastScorerName = scorerName;

      // Reset correction offset on state transition
      this._correctionOffset.x = 0;
      this._correctionOffset.y = 0;
      this._correctionOffset.z = 0;
      this._deferredCountdown = null;

      // Spawn goal explosion at ball position
      const goalColor = data.team === 'orange' ? COLORS.GOAL_ORANGE : COLORS.GOAL_BLUE;
      if (this.cameraController) this.cameraController.shakeGoal();
      if (data.ballPos) {
        this.explosionManager.spawnGoalExplosion(data.ballPos, goalColor);
        this.replayBuffer.addEvent({ type: 'goal', x: data.ballPos.x, y: data.ballPos.y, z: data.ballPos.z, color: goalColor });
      } else {
        // Fallback: use current ball position
        const bp = this.ball.body.position;
        this.explosionManager.spawnGoalExplosion({ x: bp.x, y: bp.y, z: bp.z }, goalColor);
        this.replayBuffer.addEvent({ type: 'goal', x: bp.x, y: bp.y, z: bp.z, color: goalColor });
      }

      // Flush the event into the replay buffer
      if (this.replayBuffer.frameCount > 0) {
        const interpState = this.network.getInterpolatedState();
        if (interpState) {
          const ballData = interpState.ball;
          const carsData = [];
          for (let i = 0; i < this.maxPlayers; i++) {
            carsData[i] = interpState.players[i] || null;
          }
          this.replayBuffer.recordFromSnapshot(ballData, carsData, this.boostPads);
        }
      }

      // Kill boost flames on all cars
      for (const car of this.allCars) {
        if (car && car.boostFlame) car.boostFlame.visible = false;
      }

      // Enter celebration state before replay
      this.state = 'goal_celebration';
      this._celebrationTimer = 1.5;
    });

    this.network.on('overtime', () => {
      this.isOvertime = true;
      this.state = 'overtime';
      this.hud.showOvertime();
    });

    this.network.on('gameOver', (data) => {
      this.state = 'ended';
      audioManager.stopAll();
      this.hud.showMatchEnd(data.blueScore, data.orangeScore, data.stats, data.mvpIdx, this.maxPlayers);

      // Record progression for multiplayer
      if (data.stats && this.playerNumber >= 0) {
        const playerStats = data.stats[this.playerNumber];
        const playerWon = (this.myTeam === 'blue' && data.blueScore > data.orangeScore) ||
                          (this.myTeam === 'orange' && data.orangeScore > data.blueScore);
        const xpResult = progression.endMatch(playerStats, playerWon, 0);
        if (xpResult) {
          progression.showXPScreen(xpResult);
        }
      }

      this._setupCelebration();
      if (this.onMatchEnd) this.onMatchEnd();
    });

    this.network.on('playerLeft', () => {
      this.hud.showStatus('A player disconnected');
      if (this.onMatchEnd) this.onMatchEnd();
    });

    this.network.on('disconnected', () => {
      this.hud.showStatus('Disconnected from server');
    });
  }

  _createMultiplayerCars(data) {
    this.maxPlayers = data.maxPlayers || 2;
    this.myTeam = data.team || (data.playerNumber < this.maxPlayers / 2 ? 'blue' : 'orange');
    const spawns = data.spawns || (this.maxPlayers === 2
      ? [SPAWNS.PLAYER1, SPAWNS.PLAYER2]
      : [...SPAWNS.TEAM_BLUE, ...SPAWNS.TEAM_ORANGE]);

    // Initialize allCars array
    this.allCars = new Array(this.maxPlayers).fill(null);

    // Create player's own car
    const mySlot = data.playerNumber;
    const myColor = this.myTeam === 'blue' ? COLORS.CYAN : COLORS.ORANGE;
    const myDir = this.myTeam === 'blue' ? 1 : -1;
    const myBodyColor = this.myTeam === 'blue' ? COLORS.TEAM_BLUE_BODY : COLORS.TEAM_ORANGE_BODY;

    const localVariant = { ...this._localVariant, bodyColor: myBodyColor };
    this.playerCar = new Car(
      this.scene, this.world,
      spawns[mySlot], myColor, myDir,
      this.arena.trimeshBody, localVariant
    );
    this.playerCar.body.material = this.carMaterial;
    this.playerCar.isLocalPlayer = true;
    this.allCars[mySlot] = this.playerCar;

    // Set per-car audio profile for multiplayer
    if (localVariant && localVariant.modelId) {
      audioManager.setCarModel(localVariant.modelId);
    }

    // Create remote cars for all other players
    this.remoteCars = [];
    const otherPlayers = data.otherPlayers || [];

    // Fallback for legacy 1v1 data (opponentVariant field)
    if (otherPlayers.length === 0 && data.opponentVariant) {
      const oppSlot = mySlot === 0 ? 1 : 0;
      otherPlayers.push({
        slot: oppSlot,
        team: oppSlot < this.maxPlayers / 2 ? 'blue' : 'orange',
        variantConfig: data.opponentVariant,
      });
    }

    for (const other of otherPlayers) {
      const otherColor = other.team === 'blue' ? COLORS.CYAN : COLORS.ORANGE;
      const otherDir = other.team === 'blue' ? 1 : -1;
      const otherBodyColor = other.team === 'blue' ? COLORS.TEAM_BLUE_BODY : COLORS.TEAM_ORANGE_BODY;

      const remoteVariant = { ...other.variantConfig, bodyColor: otherBodyColor };
      const remoteCar = new Car(
        this.scene, this.world,
        spawns[other.slot], otherColor, otherDir,
        this.arena.trimeshBody, remoteVariant
      );
      remoteCar.body.material = this.carMaterial;
      remoteCar.body.type = CANNON.Body.KINEMATIC;
      remoteCar.body.updateMassProperties();

      this.allCars[other.slot] = remoteCar;
      this.remoteCars.push({ car: remoteCar, slot: other.slot });
    }

    // Legacy alias for singleplayer AI references
    if (this.remoteCars.length === 1) {
      this.opponentCar = this.remoteCars[0].car;
    }

    this.cameraController.setTarget(this.playerCar);
  }

  _initPostProcessing() {
    this.composer = new EffectComposer(this.renderer);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    // Skip bloom on iOS or if disabled in display settings
    const displaySettings = getDisplaySettings();
    if (!this._isIOS && displaySettings.bloom) {
      // Use half-resolution for bloom to reduce GPU cost
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(
          Math.floor(window.innerWidth / 2),
          Math.floor(window.innerHeight / 2)
        ),
        0.8, 0.4, 0.85
      );
      this.composer.addPass(bloomPass);
    }
  }

  _initBallCollisionHandler() {
    this.ball.body.addEventListener('collide', (e) => {
      const other = e.body;
      // Check if the other body is a car (collision filter group)
      if (!(other.collisionFilterGroup & COLLISION_GROUPS.CAR)) return;

      const car = this.allCars
        ? this.allCars.find(c => c && c.body === other)
        : (this.playerCar && this.playerCar.body === other ? this.playerCar : this.opponentCar);

      const ballPos = this.ball.body.position;
      const ballVel = this.ball.body.velocity;
      const carPos = other.position;
      const carVel = other.velocity;
      const carForward = other.quaternion.vmult(new CANNON.Vec3(0, 0, 1));

      // Track touch BEFORE impulse (singleplayer only)
      let carIdx = -1;
      if (this.perfTracker) {
        carIdx = this.allCars ? this.allCars.findIndex(c => c && c.body === other) : -1;
        if (carIdx < 0) carIdx = other === this.playerCar.body ? 0 : 1;
        this.perfTracker.recordTouch(carIdx, ballPos, ballVel, carPos);
      }

      const impulse = computeBallHitImpulse(ballPos, ballVel, carPos, carVel, carForward, {
        carSpeed: car ? car.getSpeed() : 0,
        isDodging: car ? car.isDodging : false,
        dodgeDecaying: car ? car._dodgeDecaying : false,
      });

      this.ball.body.velocity.x = impulse.x;
      this.ball.body.velocity.y = impulse.y;
      this.ball.body.velocity.z = impulse.z;

      // Ball impact flash and camera shake
      const hitSpeed = Math.sqrt(impulse.x * impulse.x + impulse.y * impulse.y + impulse.z * impulse.z);
      this.ball.flash(hitSpeed);
      if (this.cameraController) this.cameraController.shakeHit(hitSpeed);
      audioManager.playBallHit(hitSpeed);

      // Finalize touch AFTER impulse (singleplayer only)
      if (this.perfTracker && carIdx >= 0) {
        this.perfTracker.finalizePendingTouch(this.ball.body.velocity);
      }
    });
  }

  // ========== DEMOLITION (singleplayer) ==========

  _initCarCollisionHandler() {
    const half = Math.floor(this.allCars.length / 2);
    for (let i = 0; i < this.allCars.length; i++) {
      const carA = this.allCars[i];
      carA.body.addEventListener('collide', (e) => {
        if (!(e.body.collisionFilterGroup & COLLISION_GROUPS.CAR)) return;
        // Find the other car
        const carB = this.allCars.find(c => c && c !== carA && c.body === e.body);
        if (!carB) return;
        const idxB = this.allCars.indexOf(carB);
        // Cross-team only: indices < half are blue, >= half are orange
        const sameTeam = (i < half) === (idxB < half);
        if (sameTeam) return;
        this._handleCarCollision(carA, carB);
      });
    }
  }

  _handleCarCollision(carA, carB) {
    const result = checkDemolition(carA, carB);
    if (result) {
      if (this.perfTracker) {
        const idx = this.allCars.indexOf(result.attacker);
        if (idx >= 0) this.perfTracker.recordDemolition(idx);
      }
      this._demolishCar(result.victim);
      return;
    }

    // Sub-supersonic bump
    handleBump(carA, carB);
  }

  _demolishCar(car) {
    const pos = { x: car.body.position.x, y: car.body.position.y, z: car.body.position.z };
    const half = Math.floor(this.allCars.length / 2);
    const idx = this.allCars.indexOf(car);
    const color = idx < half ? COLORS.CYAN : COLORS.ORANGE;
    car.demolish();
    this.explosionManager.spawnExplosion(pos, color);
    this.replayBuffer.addEvent({ type: 'demolish', x: pos.x, y: pos.y, z: pos.z, color });
    if (this.cameraController) this.cameraController.shakeDemolition();
    if (car === this.playerCar) this.hud.showDemolished();
    audioManager.playDemolition();
  }









  // ========== SINGLE-PLAYER COUNTDOWN ==========

  _startCountdown() {
    this.state = 'countdown';
    this.countdownTime = GAME.COUNTDOWN_DURATION;

    // Show "TEAM vs TEAM" banner for 2v2
    if (this.aiMode === '2v2') {
      this.hud.showVsBanner(this._playerTeamName || 'Blue', this._aiTeamName || 'Orange');
    }

    let count = GAME.COUNTDOWN_DURATION;
    this.hud.showCountdown(count);
    audioManager.playCountdownBeep(false);

    this._countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        this.hud.showCountdown(count);
        audioManager.playCountdownBeep(false);
      } else {
        this.hud.showCountdown(0);
        audioManager.playCountdownBeep(true);
        clearInterval(this._countdownInterval);
        this.state = 'playing';
        audioManager.startCrowdAmbiance();
      }
    }, 1000);
  }

  // ========== MAIN LOOP ==========

  _loop() {
    if (this._destroyed) return;
    this._rafId = requestAnimationFrame(() => this._loop());

    const dt = Math.min(this.clock.getDelta(), 0.05);

    this.input.update();
    const inputState = this.input.getState();

    if (this.mode === 'training') {
      this._loopTraining(dt, inputState);
    } else if (this.mode === 'singleplayer' || this.mode === 'freeplay') {
      this._loopSingleplayer(dt, inputState);
    } else {
      this._loopMultiplayer(dt, inputState);
    }

    // Update tutorial if active
    if (this.tutorial) {
      this.tutorial.update(dt);
      if (this.tutorial._dismissed) {
        this.tutorial = null;
      }
    }

    // Camera always updates (except during replay — replay player drives camera)
    if (this.cameraController && this.state !== 'replay') {
      this.cameraController.update(dt, inputState.ballCam, inputState.lookX);
    }

    // HUD updates
    if (this.playerCar) {
      this.hud.updateBoost(this.playerCar.boost);
      this.hud.updateSpeed(this.playerCar.getSpeed(), CAR_CONST.BOOST_MAX_SPEED);
      audioManager.setEngineSpeed(this.playerCar.getSpeed(), CAR_CONST.MAX_SPEED);
    }

    // Live scoreboard (hold Tab / LB) — skip in freeplay (no opponents to score against)
    if (inputState.scoreboard && this.mode !== 'freeplay' && this.state !== 'ended' && this.state !== 'countdown' && this.state !== 'replay') {
      const stats = this.perfTracker ? this.perfTracker.getStats() : null;
      const mp = this.perfTracker ? this.perfTracker.maxPlayers : this.maxPlayers;
      const pings = this.network ? this.network.playerPings : null;
      this.hud.showLiveScoreboard(this.scores.blue, this.scores.orange, stats, mp, pings);
    } else {
      this.hud.hideLiveScoreboard();
    }

    // Ping display (multiplayer only)
    if (this.network && this.network.rtt > 0) {
      this.hud.updatePing(this.network.rtt);
    }

    // Update car nameplates
    this._updateNameplates();

    // Quick-chat system update
    if (this.quickChat && this.allCars) {
      this.quickChat.update(dt, this.allCars);
    }

    // Off-screen ball indicator
    if (this.ballIndicator) {
      this.ballIndicator.update(inputState.ballCam);
    }

    // Gamepad-aware controls hint
    this._updateControlsHint();

    this.composer.render();
  }

  // ========== SINGLE-PLAYER LOOP ==========

  _loopSingleplayer(dt, inputState) {
    // During replay, drive meshes from recorded frames (physics paused)
    if (this.state === 'replay') {
      this._updateReplay(dt);
      this.explosionManager.updateExplosions(dt);
      if (this._checkReplaySkipInput()) this._skipReplay();
      return;
    }

    // Physics always runs
    this.accumulator += dt;
    while (this.accumulator >= PHYSICS.TIMESTEP) {
      this.world.step(PHYSICS.TIMESTEP);
      this.accumulator -= PHYSICS.TIMESTEP;
    }

    for (const car of this.allCars) car._syncMesh();
    this.ball.update(dt);

    // Post-game celebration: allow player to jump, flip, and boost
    if (this.state === 'ended') {
      this.playerCar.boost = CAR_CONST.MAX_BOOST;
      // Strip driving input — only allow jump, boost, air control
      const celebInput = {
        throttle: 0, steer: 0,
        jump: inputState.jump, jumpPressed: inputState.jumpPressed,
        boost: inputState.boost,
        airRoll: inputState.airRoll,
        pitchUp: inputState.pitchUp, pitchDown: inputState.pitchDown,
        dodgeForward: inputState.dodgeForward, dodgeSteer: inputState.dodgeSteer,
        handbrake: false,
      };
      this.playerCar.update(celebInput, dt);
      for (const car of this.allCars) car._syncMesh();
      this.explosionManager.updateExplosions(dt);
      return;
    }

    if (this.state === 'playing' || this.state === 'overtime') {
      if (!this.playerCar.demolished) {
        const assisted = this._applyAimAssist(inputState);
        this.playerCar.update(assisted, dt);
      }

      // Infinite boost in freeplay
      if (this.mode === 'freeplay') {
        this.playerCar.boost = CAR_CONST.MAX_BOOST;
      }

      if (this.mode !== 'freeplay') {
        if (this.aiController) this.aiController.update(dt);
      }

      // Update demolition respawns for all cars
      if (this.mode === 'freeplay') {
        this.playerCar.updateDemolition(dt, SPAWNS.PLAYER1, 1);
      } else if (this.aiMode === '2v2') {
        this.allCars[0].updateDemolition(dt, SPAWNS.TEAM_BLUE[0], 1);
        this.allCars[1].updateDemolition(dt, SPAWNS.TEAM_BLUE[1], 1);
        this.allCars[2].updateDemolition(dt, SPAWNS.TEAM_ORANGE[0], -1);
        this.allCars[3].updateDemolition(dt, SPAWNS.TEAM_ORANGE[1], -1);
      } else {
        this.playerCar.updateDemolition(dt, SPAWNS.PLAYER1, 1);
        this.opponentCar.updateDemolition(dt, SPAWNS.PLAYER2, -1);
      }

      this.boostPads.update(dt, this.allCars);
      if (this.perfTracker) {
        this.perfTracker.setMatchTime(GAME.MATCH_DURATION - this.matchTime);
      }

      if (this.mode !== 'freeplay') {
        this._updateTimer(dt);
      }

      // Record frame for replay
      this.replayBuffer.record(this.ball, this.allCars, this.boostPads);

      if (this.mode === 'freeplay') {
        this._checkGoalFreeplay();
      } else {
        this._checkGoal();
      }
    } else if (this.state === 'goal_celebration') {
      this._celebrationTimer -= dt;
      if (this._celebrationTimer <= 0) {
        if (this.replayBuffer.frameCount >= 30) {
          this._startReplay();
        } else {
          this._enterGoalState();
        }
      }
    } else if (this.state === 'goal') {
      this.goalResetTime -= dt;
      if (this.goalResetTime <= 0) {
        this._resetAfterGoal();
      }
    }

    this.explosionManager.updateExplosions(dt);
    this.explosionManager.checkLandingEffects(this.allCars);
    this.explosionManager.updateLandingRings(dt);
  }

  // ========== MULTIPLAYER LOOP ==========

  _loopMultiplayer(dt, inputState) {
    if (!this.playerCar) {
      // Cars not yet created (waiting for joined event)
      this.ball.update(dt);
      return;
    }

    // During replay, drive meshes from recorded frames (physics paused)
    if (this.state === 'replay') {
      this._updateReplay(dt);
      this.explosionManager.updateExplosions(dt);
      if (this._checkReplaySkipInput()) this._skipReplay();
      return;
    }

    // Goal celebration: let explosion play, then start replay
    if (this.state === 'goal_celebration') {
      this._celebrationTimer -= dt;
      this.explosionManager.updateExplosions(dt);
      // Allow skipping celebration + replay entirely
      if (this._checkReplaySkipInput()) {
        this._replaySkipped = true;
        this._onReplayFinished();
        return;
      }
      if (this._celebrationTimer <= 0) {
        if (this.replayBuffer.frameCount >= 30) {
          this._startReplay();
        } else {
          this._onReplayFinished();
        }
      }
      return;
    }

    // Post-game celebration: allow player to jump, flip, and boost
    if (this.state === 'ended') {
      this.playerCar.boost = CAR_CONST.MAX_BOOST;
      const celebInput = {
        throttle: 0, steer: 0,
        jump: inputState.jump, jumpPressed: inputState.jumpPressed,
        boost: inputState.boost,
        airRoll: inputState.airRoll,
        pitchUp: inputState.pitchUp, pitchDown: inputState.pitchDown,
        dodgeForward: inputState.dodgeForward, dodgeSteer: inputState.dodgeSteer,
        handbrake: false,
      };
      this.playerCar.update(celebInput, dt);

      this.accumulator += dt;
      while (this.accumulator >= PHYSICS.TIMESTEP) {
        this.world.step(PHYSICS.TIMESTEP);
        this.accumulator -= PHYSICS.TIMESTEP;
      }

      for (const car of this.allCars) {
        if (car) car._syncMesh();
      }
      this.explosionManager.updateExplosions(dt);
      return;
    }

    if (this.state === 'playing' || this.state === 'overtime') {
      // Apply aim assist for touch users before sending/applying
      const assisted = this._applyAimAssist(inputState);

      // Client-side prediction with fixed timestep matching server (60Hz).
      // Both car.update() and world.step() use PHYSICS.TIMESTEP to ensure
      // prediction matches server exactly. Variable frame time is handled
      // by the accumulator — we may run 0, 1, or 2 steps per render frame.
      this.accumulator += dt;
      let steppedThisFrame = false;
      while (this.accumulator >= PHYSICS.TIMESTEP) {
        // Send input to server once per fixed step (matches server processing rate).
        // Sending per-step instead of per-frame avoids flooding at high frame rates
        // and ensures each pending input corresponds to exactly one physics step.
        const input = this.network.sendInput(assisted);
        this.network.addPendingInput(input);

        this.playerCar.update(assisted, PHYSICS.TIMESTEP);
        this.world.step(PHYSICS.TIMESTEP);
        this.accumulator -= PHYSICS.TIMESTEP;
        steppedThisFrame = true;
      }

      // If no physics step this frame (high framerate), still send input
      // so the server stays responsive, but don't add to pending buffer
      // (no physics step = no prediction to reconcile)
      if (!steppedThisFrame) {
        this.network.sendInput(assisted);
      }
    }

    // Interpolate remote entities (adaptive delay, no fixed renderTime arg)
    const interpState = this.network.getInterpolatedState();

    if (interpState) {
      this._applyRemoteState(interpState);

      // Sync HUD from server state
      this.hud.updateTimer(interpState.timer);
      if (interpState.score) {
        this.scores = interpState.score;
        this.hud.updateScore(interpState.score.blue, interpState.score.orange);
      }

      // Sync boost pads
      this._syncBoostPads(interpState.boostPads);

      // Record frame for replay (from interpolated state the player sees)
      if (this.state === 'playing' || this.state === 'overtime') {
        const ballData = interpState.ball;
        const carsData = [];
        for (let i = 0; i < this.maxPlayers; i++) {
          const p = interpState.players[i];
          carsData[i] = p || null;
        }
        this.replayBuffer.recordFromSnapshot(ballData, carsData, this.boostPads);
      }
    }

    // Decay correction offset for smooth reconciliation (frame-rate independent).
    // The decay rate adapts to network conditions: higher RTT means corrections
    // are larger but should blend out faster to avoid persistent visual drift.
    // Base rate 12 produces ~58ms half-life. With RTT > 100ms, rate increases
    // to blend corrections out before the next server update arrives.
    const rtt = this.network ? this.network.getRTT() : 0;
    const decayRate = 12 + Math.max(0, rtt - 50) * 0.1; // scale up for high latency
    const decay = Math.exp(-decayRate * dt);
    this._correctionOffset.x *= decay;
    this._correctionOffset.y *= decay;
    this._correctionOffset.z *= decay;

    // Sync player car mesh with visual correction offset applied
    const body = this.playerCar.body;
    const ox = this._correctionOffset.x;
    const oy = this._correctionOffset.y;
    const oz = this._correctionOffset.z;
    body.position.x += ox;
    body.position.y += oy;
    body.position.z += oz;
    this.playerCar._syncMesh();
    body.position.x -= ox;
    body.position.y -= oy;
    body.position.z -= oz;

    // Sync remote car meshes to their interpolated positions.
    // Interpolation in NetworkManager already produces smooth positions between
    // server snapshots. No velocity extrapolation needed here - adding it would
    // double-count movement and cause overshoot/rubber-banding.
    for (const { car } of this.remoteCars) {
      car._syncMesh();
    }

    // Smooth ball visual: interpolate toward server target + extrapolate with velocity
    this._updateBallVisual(dt);

    // Animate boost pads (visual only)
    this.boostPads.update(dt, []);

    this.explosionManager.updateExplosions(dt);
    this.explosionManager.checkLandingEffects(this.allCars);
    this.explosionManager.updateLandingRings(dt);
  }

  // ========== RECONCILIATION ==========

  _reconcile(snapshot) {
    if (!this.playerCar || this.playerNumber < 0) return;

    const myState = snapshot.players[this.playerNumber];
    if (!myState) return;

    // Discard inputs already processed by server
    this.network.clearPendingInputsBefore(myState.lastProcessedInput);

    // Sync demolished state from server
    if (myState.demolished && !this.playerCar.demolished) {
      this.playerCar.demolished = true;
      this.playerCar.mesh.visible = false;
      this.playerCar.body.collisionFilterMask = 0;
    } else if (!myState.demolished && this.playerCar.demolished) {
      this.playerCar.demolished = false;
      this.playerCar.mesh.visible = true;
      this.playerCar.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
    }

    // Save current visual position (physics + correction offset)
    const body = this.playerCar.body;
    const oldVisualX = body.position.x + this._correctionOffset.x;
    const oldVisualY = body.position.y + this._correctionOffset.y;
    const oldVisualZ = body.position.z + this._correctionOffset.z;

    // Snap physics to server authoritative state
    body.position.set(myState.px, myState.py, myState.pz);
    body.velocity.set(myState.vx, myState.vy, myState.vz);
    body.quaternion.set(myState.qx, myState.qy, myState.qz, myState.qw);
    body.angularVelocity.set(myState.avx, myState.avy, myState.avz);
    this.playerCar.boost = myState.boost;

    // Replay pending inputs on top of server state (prediction)
    // Step physics world each iteration so gravity/collisions match server
    const pending = this.network.getPendingInputs();
    for (const input of pending) {
      this.playerCar.update(input, PHYSICS.TIMESTEP);
      this.world.step(PHYSICS.TIMESTEP);
    }

    // Compute new correction offset = old visual pos - new predicted physics pos
    const newOffX = oldVisualX - body.position.x;
    const newOffY = oldVisualY - body.position.y;
    const newOffZ = oldVisualZ - body.position.z;
    const offsetDist = Math.sqrt(newOffX * newOffX + newOffY * newOffY + newOffZ * newOffZ);

    if (offsetDist > NETWORK.SNAP_THRESHOLD) {
      // Large error: clamp offset to threshold distance and let it blend out
      const scale = NETWORK.SNAP_THRESHOLD / offsetDist;
      this._correctionOffset.x = newOffX * scale;
      this._correctionOffset.y = newOffY * scale;
      this._correctionOffset.z = newOffZ * scale;
    } else {
      // Small error: carry visual offset (it decays each frame in _loopMultiplayer)
      this._correctionOffset.x = newOffX;
      this._correctionOffset.y = newOffY;
      this._correctionOffset.z = newOffZ;
    }
  }

  // ========== REMOTE STATE APPLICATION ==========

  _applyRemoteState(interpState) {
    // Apply state to all remote cars
    for (const { car, slot } of this.remoteCars) {
      const carData = interpState.players[slot];
      if (!carData) continue;

      // Sync demolished state
      if (carData.demolished && !car.demolished) {
        car.demolished = true;
        car.mesh.visible = false;
        car.body.collisionFilterMask = 0;
      } else if (!carData.demolished && car.demolished) {
        car.demolished = false;
        car.mesh.visible = true;
        car.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
      }

      car.body.position.set(carData.px, carData.py, carData.pz);
      car.body.velocity.set(carData.vx, carData.vy, carData.vz);
      car.body.quaternion.set(carData.qx, carData.qy, carData.qz, carData.qw);
      car.body.angularVelocity.set(carData.avx, carData.avy, carData.avz);
      car.boost = carData.boost;
    }

    // Ball is 100% server-authoritative — no client physics, just smooth interpolation.
    // Store the interpolated target and let _updateBallVisual() smoothly track it.
    const ballData = interpState.ball;
    if (ballData) {
      this._ballTarget = ballData;
    }
  }

  _updateBallVisual(dt) {
    const target = this._ballTarget;
    if (!target) {
      this.ball.update(dt);
      return;
    }

    const body = this.ball.body;

    // Extrapolate target position forward using velocity to predict where the
    // ball will be by the time the next server update arrives. This compensates
    // for the interpolation delay and makes the ball feel more responsive.
    const extrapS = dt;
    const tx = target.px + target.vx * extrapS;
    const ty = target.py + target.vy * extrapS;
    const tz = target.pz + target.vz * extrapS;

    // Smoothly blend current position toward extrapolated target.
    // Single lerp step - no additional velocity drift to avoid double-counting.
    const lerp = 1 - Math.exp(-25 * dt); // ~25Hz blend rate for responsive tracking
    body.position.x += (tx - body.position.x) * lerp;
    body.position.y += (ty - body.position.y) * lerp;
    body.position.z += (tz - body.position.z) * lerp;

    // Set velocity for visual spin calculation
    body.velocity.set(target.vx, target.vy, target.vz);

    // Smooth quaternion toward target (avoids jarring ball spin jumps)
    const bq = body.quaternion;
    const tqx = target.qx, tqy = target.qy, tqz = target.qz, tqw = target.qw;
    let dot = bq.x * tqx + bq.y * tqy + bq.z * tqz + bq.w * tqw;
    const sign = dot < 0 ? -1 : 1;
    bq.x += (tqx * sign - bq.x) * lerp;
    bq.y += (tqy * sign - bq.y) * lerp;
    bq.z += (tqz * sign - bq.z) * lerp;
    bq.w += (tqw * sign - bq.w) * lerp;
    // Normalize
    const invLen = 1 / Math.sqrt(bq.x * bq.x + bq.y * bq.y + bq.z * bq.z + bq.w * bq.w);
    bq.x *= invLen; bq.y *= invLen; bq.z *= invLen; bq.w *= invLen;

    // Update visual (spin, glow, shadow)
    this.ball.update(dt);
  }

  _syncBoostPads(bitmask) {
    if (bitmask === undefined || bitmask === null) return;

    for (let i = 0; i < this.boostPads.pads.length; i++) {
      const pad = this.boostPads.pads[i];
      let shouldBeActive;

      if (bitmask instanceof Uint8Array) {
        // Binary protocol: byte array bitmask (supports >32 pads)
        shouldBeActive = !!((bitmask[i >> 3] || 0) & (1 << (i & 7)));
      } else {
        // Legacy: number bitmask (only works for pads 0-31)
        shouldBeActive = !!(bitmask & (1 << i));
      }

      if (pad.active !== shouldBeActive) {
        // Play pickup sound when pad just collected near the local player
        if (pad.active && !shouldBeActive && this.playerCar) {
          const cp = this.playerCar.body.position;
          const dx = cp.x - pad.position.x;
          const dz = cp.z - pad.position.z;
          if (Math.sqrt(dx * dx + dz * dz) < pad.radius * 2) {
            audioManager.playBoostPickup(pad.isLarge);
          }
        }
        pad.active = shouldBeActive;
        pad.mesh.visible = shouldBeActive;
      }
    }
  }

  // ========== SINGLE-PLAYER TIMER & GOALS ==========

  _updateTimer(dt) {
    if (this.isOvertime) return;

    this.matchTime -= dt;
    if (this.matchTime <= 0) {
      this.matchTime = 0;
      if (this.scores.blue === this.scores.orange) {
        this.isOvertime = true;
        this.state = 'overtime';
        this.hud.showOvertime();
      } else {
        this.state = 'ended';
        audioManager.stopAll();
        this._showEndStats();
      }
    }

    this.hud.updateTimer(this.matchTime);
  }

  _checkGoal() {
    const goalSide = this.arena.isInGoal(this.ball.body.position);
    if (goalSide === 0) return;

    let scorerIdx = -1;
    if (this.perfTracker) {
      const result = this.perfTracker.recordGoal(goalSide);
      scorerIdx = result.scorerIdx;
    }

    // Resolve scorer name
    const scorerName = scorerIdx >= 0 ? this.hud._getPlayerLabel(scorerIdx, this.allCars.length) : null;

    // Goal explosion at ball position
    const ballPos = this.ball.body.position;
    const goalColor = goalSide === 1 ? COLORS.GOAL_ORANGE : COLORS.GOAL_BLUE;
    const goalPos = { x: ballPos.x, y: ballPos.y, z: ballPos.z };
    this.explosionManager.spawnGoalExplosion(goalPos, goalColor);
    this.replayBuffer.addEvent({ type: 'goal', x: goalPos.x, y: goalPos.y, z: goalPos.z, color: goalColor });
    if (this.cameraController) this.cameraController.shakeGoal();
    // Flush the event into the buffer — no more frames are recorded after this
    this.replayBuffer.record(this.ball, this.allCars, this.boostPads);

    if (goalSide === 1) {
      this.scores.orange++;
      this.hud.showGoalScored('orange', scorerName);
    } else {
      this.scores.blue++;
      this.hud.showGoalScored('blue', scorerName);
    }

    this.hud.updateScore(this.scores.blue, this.scores.orange);
    audioManager.playGoalHorn();

    // Save scorer name for replay banner
    this._lastScorerName = scorerName;

    // Save overtime flag for after replay
    this._goalWasOvertime = this.isOvertime;

    // Kill boost flames on all cars
    for (const car of this.allCars) {
      if (car && car.boostFlame) car.boostFlame.visible = false;
    }

    // Let the goal explosion play out before starting replay
    this.state = 'goal_celebration';
    this._celebrationTimer = 1.5; // seconds to watch the explosion
  }

  _checkGoalFreeplay() {
    const goalSide = this.arena.isInGoal(this.ball.body.position);
    if (goalSide === 0) return;

    // Quick explosion
    const ballPos = this.ball.body.position;
    const goalColor = goalSide === 1 ? COLORS.GOAL_ORANGE : COLORS.GOAL_BLUE;
    this.explosionManager.spawnGoalExplosion({ x: ballPos.x, y: ballPos.y, z: ballPos.z }, goalColor);
    if (this.cameraController) this.cameraController.shakeGoal();

    if (goalSide === 1) {
      this.scores.orange++;
      this.hud.showGoalScored('orange');
    } else {
      this.scores.blue++;
      this.hud.showGoalScored('blue');
    }
    this.hud.updateScore(this.scores.blue, this.scores.orange);
    audioManager.playGoalHorn();

    // Quick reset — just reposition ball and car
    this.ball.reset();
    this.playerCar.reset(SPAWNS.PLAYER1, 1);
    this.replayBuffer.clear();
  }

  _enterGoalState() {
    this.state = 'goal';
    // If replay was skipped, skip the goal pause too
    this.goalResetTime = this._replaySkipped ? 0.3 : GAME.GOAL_RESET_TIME;
    this._replaySkipped = false;

    if (this._goalWasOvertime) {
      setTimeout(() => {
        this.state = 'ended';
        audioManager.stopAll();
        this._showEndStats();
      }, GAME.GOAL_RESET_TIME * 1000);
    }
  }

  // ========== REPLAY SYSTEM ==========

  _startReplay() {
    const frames = this.replayBuffer.getRecentFrames(this.replayBuffer.frameCount);
    this.replayPlayer.start(frames);
    this.state = 'replay';
    this._replaySkipped = false;
    this.hud.showReplayIndicator(true, this._lastScorerName || null);

    // Snapshot current keys so held keys don't instantly skip
    this._prevReplayKeys = { ...this.input.keys };
  }

  _updateReplay(dt) {
    const cars = this.allCars;

    const prevIdx = this.replayPlayer.prevFrameIndex;
    const stillPlaying = this.replayPlayer.update(
      dt, this.ball, cars, this.boostPads, this.camera
    );
    const curIdx = this.replayPlayer.lastFrameIndex;

    // Fire any events on frames we just crossed
    const frames = this.replayPlayer.frames;
    if (frames) {
      const start = Math.max(0, prevIdx + 1);
      const end = Math.min(curIdx, frames.length - 1);
      for (let f = start; f <= end; f++) {
        const evts = frames[f] && frames[f].events;
        if (!evts) continue;
        for (const e of evts) {
          if (e.type === 'goal') {
            this.explosionManager.spawnGoalExplosion(e, e.color);
          } else if (e.type === 'demolish') {
            this.explosionManager.spawnExplosion(e, e.color);
          }
        }
      }
    }

    if (!stillPlaying) {
      this._onReplayFinished();
    }
  }

  /** Detect jump input (Space / A button) for replay skip. */
  _checkReplaySkipInput() {
    // Keyboard: Space
    const keys = this.input.keys;
    const spaceDown = !!keys['Space'];
    const spacePressed = spaceDown && !this._prevReplaySpace;
    this._prevReplaySpace = spaceDown;

    if (spacePressed) return true;

    // Gamepad: A button (index 0)
    if (navigator.getGamepads) {
      const gamepads = navigator.getGamepads();
      for (const gp of gamepads) {
        if (!gp) continue;
        const aDown = gp.buttons[0] && gp.buttons[0].pressed;
        if (aDown && !this._prevReplayA) {
          this._prevReplayA = true;
          return true;
        }
        this._prevReplayA = !!(aDown);
      }
    }

    return false;
  }

  _skipReplay() {
    if (this.state !== 'replay') return;
    this._replaySkipped = true;
    this.replayPlayer.skip();
    this._onReplayFinished();
  }

  _onReplayFinished() {
    this.hud.showReplayIndicator(false);
    this._prevReplayKeys = null;

    // Reset camera smoothing so it doesn't lerp from the orbit position
    if (this.cameraController) {
      this.cameraController.resetSmoothing();
    }

    // Restore boost trail visibility
    const cars = this.allCars;
    for (const car of cars) {
      if (car && car.boostFlame) {
        car.boostFlame.visible = true;
      }
    }

    // Restore demolished car visibility to match actual state
    for (const car of cars) {
      if (car) {
        car.mesh.visible = !car.demolished;
      }
    }

    // In multiplayer, apply deferred countdown from server or wait for it
    if (this.mode !== 'singleplayer' && this.mode !== 'freeplay') {
      if (this._deferredCountdown) {
        const data = this._deferredCountdown;
        this._deferredCountdown = null;
        this._applyCountdown(data);
      } else {
        // Countdown hasn't arrived yet — enter a waiting state
        // so the game doesn't run singleplayer reset logic.
        // The countdown handler will pick it up when it arrives.
        this.state = 'waiting_for_countdown';
      }
    } else {
      this._enterGoalState();
    }
  }

  _applyCountdown(data) {
    this.state = 'countdown';
    this.hud.showCountdown(data.count);
    audioManager.playCountdownBeep(data.count === 0);
    this._correctionOffset.x = 0;
    this._correctionOffset.y = 0;
    this._correctionOffset.z = 0;
    this.network.pendingInputs = [];
    this.replayBuffer.clear();
    this._ballTarget = null; // reset ball visual target so it picks up fresh server state

    // Reset all cars and ball to spawn positions before countdown begins
    // (server has already reset; this ensures client visuals match immediately)
    this.ball.reset();
    if (this.maxPlayers === 4) {
      this.allCars[0].reset(SPAWNS.TEAM_BLUE[0], 1);
      this.allCars[1].reset(SPAWNS.TEAM_BLUE[1], 1);
      this.allCars[2].reset(SPAWNS.TEAM_ORANGE[0], -1);
      this.allCars[3].reset(SPAWNS.TEAM_ORANGE[1], -1);
    } else {
      const spawns = this.maxPlayers === 2
        ? [SPAWNS.PLAYER1, SPAWNS.PLAYER2]
        : [SPAWNS.PLAYER1];
      for (let i = 0; i < this.allCars.length; i++) {
        if (this.allCars[i] && spawns[i]) {
          this.allCars[i].reset(spawns[i], i === 0 ? 1 : -1);
        }
      }
    }

    // Reset demolished state on all cars so they're visible for countdown
    for (const car of this.allCars) {
      if (car && car.demolished) {
        car.demolished = false;
        car.respawnTimer = 0;
        car.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
        car.mesh.visible = true;
      }
    }

    if (data.count === 0) {
      this.state = 'playing';
      audioManager.startCrowdAmbiance();
    }
  }

  _resetAfterGoal() {
    this.replayBuffer.clear();
    if (this.perfTracker) this.perfTracker.resetTouchHistory();

    // Clear demolished state before reset
    for (const car of this.allCars) {
      if (car.demolished) {
        car.demolished = false;
        car.respawnTimer = 0;
        car.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
        car.mesh.visible = true;
      }
    }
    this.ball.reset();

    if (this.aiMode === '2v2') {
      this.allCars[0].reset(SPAWNS.TEAM_BLUE[0], 1);
      this.allCars[1].reset(SPAWNS.TEAM_BLUE[1], 1);
      this.allCars[2].reset(SPAWNS.TEAM_ORANGE[0], -1);
      this.allCars[3].reset(SPAWNS.TEAM_ORANGE[1], -1);
    } else {
      this.playerCar.reset(SPAWNS.PLAYER1, 1);
      this.opponentCar.reset(SPAWNS.PLAYER2, -1);
    }
    this._startCountdown();
  }

  _showEndStats() {
    if (this.perfTracker) {
      const winningTeam = this.scores.blue > this.scores.orange ? 'blue' : 'orange';
      const mvpIdx = this.perfTracker.computeMVP(winningTeam);
      this.hud.showMatchEnd(this.scores.blue, this.scores.orange, this.perfTracker.getStats(), mvpIdx, this.allCars.length);
    } else {
      this.hud.showMatchEnd(this.scores.blue, this.scores.orange);
    }

    // Record progression (player is always slot 0 in singleplayer)
    if (this.mode === 'singleplayer') {
      const stats = this.perfTracker.getStats();
      const playerStats = stats[0];
      const playerWon = (this.myTeam === 'blue' && this.scores.blue > this.scores.orange) ||
                        (this.myTeam === 'orange' && this.scores.orange > this.scores.blue);
      const xpResult = progression.endMatch(playerStats, playerWon, 0);
      if (xpResult) {
        progression.showXPScreen(xpResult);
      }
    }

    this._setupCelebration();
  }

  _setupCelebration() {
    // Hide the ball off-screen
    this.ball.body.position.set(0, -50, 0);
    this.ball.body.velocity.set(0, 0, 0);
    this.ball.mesh.visible = false;

    // Line up all cars at midfield facing the camera
    const carCount = this.allCars.filter(c => c).length;
    const spacing = 6;
    const startX = -((carCount - 1) * spacing) / 2;

    this.allCars.forEach((car, i) => {
      if (!car) return;
      // Restore demolished cars for celebration
      if (car.demolished) {
        car.demolished = false;
        car.respawnTimer = 0;
        car.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
        car.mesh.visible = true;
      }
      const x = startX + i * spacing;
      car.body.position.set(x, 2, 0);
      car.body.velocity.set(0, 0, 0);
      car.body.angularVelocity.set(0, 0, 0);
      // Face toward positive Z (toward camera default position)
      car.body.quaternion.setFromEuler(0, Math.PI, 0);
      car._syncMesh();
    });

    // Position camera for a nice view of the lineup
    if (this.cameraController) {
      this.cameraController.resetSmoothing();
    }
  }

  // ========== MOBILE AIM ASSIST ==========

  _applyAimAssist(inputState) {
    // Only active when touch controls are loaded
    if (!this.input._touch) return inputState;

    const car = this.playerCar;
    if (!car || car.demolished) return inputState;

    const ballPos = this.ball.getPosition();
    const carPos = car.getPosition();
    const toBallX = ballPos.x - carPos.x;
    const toBallZ = ballPos.z - carPos.z;
    const distToBall = Math.sqrt(toBallX * toBallX + toBallZ * toBallZ);

    // Car heading angle
    car.body.quaternion.toEuler(_aimEuler);
    const carYaw = _aimEuler.y;

    // Angle from car to ball
    const angleToBall = Math.atan2(toBallX, toBallZ);
    let angleDiff = angleToBall - carYaw;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    const absAngle = Math.abs(angleDiff);

    // --- 1. Steering auto-correct ---
    // When player steering is small and ball is in front, nudge toward it
    if (car.isGrounded && Math.abs(inputState.steer) < 0.3 && absAngle < Math.PI / 2) {
      // Strength scales with proximity (stronger when close, where precision matters most)
      const proxFactor = Math.min(1, 30 / (distToBall + 5));
      // Blend: 40% correction toward ball when stick is neutral, fading as stick input increases
      const stickFade = 1 - Math.abs(inputState.steer) / 0.3;
      const correction = Math.sign(angleDiff) * Math.min(absAngle * 0.4, 0.5) * proxFactor * stickFade;
      inputState = { ...inputState, steer: inputState.steer + correction };
      // Clamp
      inputState.steer = Math.max(-1, Math.min(1, inputState.steer));
    }

    // --- 2. Approach magnetism ---
    // When driving toward ball in a narrow cone, tighten aim to contact point
    if (car.isGrounded && absAngle < 0.4 && distToBall < 25 && Math.abs(inputState.throttle) > 0.3) {
      const magnetStrength = 0.25 * (1 - absAngle / 0.4) * Math.min(1, 15 / (distToBall + 2));
      const magnetSteer = Math.sign(angleDiff) * magnetStrength;
      inputState = { ...inputState, steer: inputState.steer + magnetSteer };
      inputState.steer = Math.max(-1, Math.min(1, inputState.steer));
    }

    // --- 3. Auto-align dodge toward ball ---
    // When double-jumping with no directional input, aim the dodge at the ball
    if (inputState.jumpPressed && !car.isGrounded && car.canDoubleJump) {
      const df = inputState.dodgeForward !== undefined ? inputState.dodgeForward : inputState.throttle;
      const ds = inputState.dodgeSteer !== undefined ? inputState.dodgeSteer : inputState.steer;
      if (df === 0 && ds === 0 && distToBall < 15) {
        // Convert ball direction to car-local dodge input
        const cosYaw = Math.cos(carYaw);
        const sinYaw = Math.sin(carYaw);
        // Rotate world-space toBall into car-local space
        const localZ = toBallX * sinYaw + toBallZ * cosYaw;   // forward component
        const localX = toBallX * cosYaw - toBallZ * sinYaw;   // right component
        const len = Math.sqrt(localZ * localZ + localX * localX) || 1;
        inputState = {
          ...inputState,
          dodgeForward: localZ / len,
          dodgeSteer: localX / len,
        };
      }
    }

    return inputState;
  }

  // ========== TRAINING MODE ==========

  _initTraining() {
    // Init scene like freeplay -- single car, no opponents
    this._initScene();
    this.cameraController = new CameraController(this.camera);
    this.cameraController.setTarget(this.playerCar);
    this.cameraController.setBallTarget(this.ball);
    this._initPostProcessing();

    this.state = 'playing';
    this.matchTime = Infinity;

    // Create TrainingMode controller
    this.trainingMode = new TrainingMode({
      trainingOpts: this.trainingOpts,
      hud: this.hud,
      arena: this.arena,
      ball: this.ball,
      playerCar: this.playerCar,
      allCars: this.allCars,
      boostPads: this.boostPads,
      explosionManager: this.explosionManager,
      applyAimAssist: (input) => this._applyAimAssist(input),
    });

    if (this.trainingMode.isValid) {
      this.trainingMode.init();
    }
  }

  _loopTraining(dt, inputState) {
    if (!this.trainingMode || !this.trainingMode.isValid) return;
    this.accumulator = this.trainingMode.update(dt, inputState, this.world, this.accumulator);
  }

  // ========== CLEANUP ==========

  destroy() {
    this._destroyed = true;

    // Clean up tutorial
    if (this.tutorial) {
      this.tutorial.destroy();
      this.tutorial = null;
    }

    // Clean up HUD level badge
    if (this._hudLevelBadge && this._hudLevelBadge.parentNode) {
      this._hudLevelBadge.remove();
    }

    // Stop RAF loop
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    // Clear countdown interval
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }

    // Clean up replay listeners
    if (this._replaySkipHandler) {
      window.removeEventListener('keydown', this._replaySkipHandler);
      window.removeEventListener('pointerdown', this._replaySkipHandler);
      this._replaySkipHandler = null;
    }

    // Remove resize listener
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
    }

    // Stop ALL continuous audio
    audioManager.stopAll();

    // Clean up training mode
    if (this.trainingMode) {
      this.trainingMode.destroy();
    }

    // Clean up nameplates
    if (this._nameplates) {
      for (const el of this._nameplates) {
        if (el) el.remove();
      }
      this._nameplates = null;
    }

    // Destroy subsystems
    if (this.gameSettings) {
      this.gameSettings.destroy();
    }
    if (this.input) {
      this.input.destroy();
    }
    if (this.hud) {
      this.hud.reset();
    }

    // Disconnect network
    if (this.network) {
      this.network.disconnect();
    }

    // Dispose Three.js scene objects
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
    }

    // Dispose renderer and composer
    if (this.composer) {
      this.composer.dispose();
    }
    if (this.renderer) {
      this.renderer.dispose();
    }

    // Clear physics world bodies
    if (this.world) {
      while (this.world.bodies.length > 0) {
        this.world.removeBody(this.world.bodies[0]);
      }
    }

    // Clear explosions and landing rings
    if (this.explosionManager) {
      this.explosionManager.clear();
    }

    // Null out references
    this.playerCar = null;
    this.opponentCar = null;
    this.remoteCars = [];
    this.allCars = [];
    this.ball = null;
    this.scene = null;
    this.world = null;
  }
}
