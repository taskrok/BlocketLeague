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
import { GameSettings } from './GameSettings.js';
import { HUD } from './HUD.js';
import { ReplayBuffer } from './ReplayBuffer.js';
import { ReplayPlayer } from './ReplayPlayer.js';
import {
  PHYSICS, ARENA as ARENA_CONST, BALL as BALL_CONST,
  COLORS, SPAWNS, GAME, CAR as CAR_CONST, COLLISION_GROUPS,
  NETWORK, DEMOLITION,
} from '../../shared/constants.js';
import { computeBallHitImpulse } from '../../shared/BallHitImpulse.js';
import { PerformanceTracker } from '../../shared/PerformanceTracker.js';
import { TRAINING_PACKS } from './TrainingPacks.js';

// Reusable temp vectors
const _aiEuler = new CANNON.Vec3();
const _aimEuler = new CANNON.Vec3();
const _npVec = new THREE.Vector3(); // reusable vector for nameplate projection

// AI team definitions for 2v2 mode — each team has a name and two car model IDs
const AI_TEAMS = [
  { name: 'First Responders', cars: ['ambulance', 'firetruck'] },
  { name: 'Boys in Blue', cars: ['police', 'tractor-police'] },
  { name: 'Street Racers', cars: ['race', 'sedan-sports'] },
  { name: 'Future Shock', cars: ['race-future', 'hatchback-sports'] },
  { name: 'Heavy Haul', cars: ['truck', 'truck-flat'] },
  { name: 'Special Delivery', cars: ['delivery', 'delivery-flat'] },
  { name: 'Sunday Drivers', cars: ['sedan', 'suv'] },
  { name: 'Country Club', cars: ['suv-luxury', 'taxi'] },
  { name: 'Mud Dogs', cars: ['tractor', 'tractor-shovel'] },
  { name: 'City Workers', cars: ['garbage-truck', 'van'] },
];

function findPlayerTeam(playerModelId) {
  if (!playerModelId) return null;
  return AI_TEAMS.find(t => t.cars.includes(playerModelId)) || null;
}

function pickOpponentTeam(availableModelIds, excludeTeam) {
  const valid = AI_TEAMS.filter(t =>
    t !== excludeTeam && t.cars.every(c => availableModelIds.includes(c))
  );
  if (valid.length === 0) return null;
  return valid[Math.floor(Math.random() * valid.length)];
}

export class Game {
  constructor(canvas, mode = 'singleplayer', networkManager = null, playerVariant = null, joinedData = null, aiDifficulty = 'pro', aiMode = '1v1', trainingOpts = null, arenaTheme = null) {
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

    // Explosion VFX
    this._activeExplosions = [];

    this._initRenderer();
    this._initPhysics();

    this.input = new InputManager();
    this.hud = new HUD();
    this.replayBuffer = new ReplayBuffer();
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
        this.matchTime = Infinity;
        this.hud.updateTimer(0);
        this.hud.timerEl.textContent = 'FREE PLAY';
        this.hud.timerEl.style.color = '#00ff88';
        this.hud.timerEl.style.textShadow = '0 0 16px rgba(0, 255, 136, 0.6)';
      } else {
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

      this.opponentCar = new Car(
        this.scene, this.world,
        SPAWNS.PLAYER2, COLORS.ORANGE, -1,
        this.arena.trimeshBody, opponentVariant
      );
      this.opponentCar.body.material = this.carMaterial;

      this.allCars = [this.playerCar, this.opponentCar];
      this.aiCars = [this.opponentCar];
    }

    this._initBallCollisionHandler();
    this._initCarCollisionHandler();

    this.boostPads = new BoostPads(this.scene);
    this.maxPlayers = this.allCars.length;
    this.perfTracker = new PerformanceTracker(this.maxPlayers);

    // Assign names for scoreboard
    this._assignPlayerNames();
  }

  _assignPlayerNames() {
    const RANDOM_NAMES = [
      'Donut','Penguin','Stumpy','Whicker','Shadow','Howard','Wilshire','Darling',
      'Disco','Jack','The Bear','Sneak','The Big L','Whisp','Wheezy','Crazy',
      'Goat','Pirate','Saucy','Hambone','Butcher','Walla Walla','Snake','Caboose',
      'Sleepy','Killer','Stompy','Mopey','Dopey','Weasel','Ghost','Dasher',
      'Grumpy','Hollywood','Tooth','Noodle','King','Cupid','Prancer',
    ];

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
  }

  _initMultiplayer() {
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
      this._spawnExplosion(pos, color);
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
      this._lastScorerName = scorerName;

      // Reset correction offset on state transition
      this._correctionOffset.x = 0;
      this._correctionOffset.y = 0;
      this._correctionOffset.z = 0;
      this._deferredCountdown = null;

      // Spawn goal explosion at ball position
      const goalColor = data.team === 'orange' ? COLORS.GOAL_ORANGE : COLORS.GOAL_BLUE;
      if (data.ballPos) {
        this._spawnGoalExplosion(data.ballPos, goalColor);
        this.replayBuffer.addEvent({ type: 'goal', x: data.ballPos.x, y: data.ballPos.y, z: data.ballPos.z, color: goalColor });
      } else {
        // Fallback: use current ball position
        const bp = this.ball.body.position;
        this._spawnGoalExplosion({ x: bp.x, y: bp.y, z: bp.z }, goalColor);
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
      this.hud.showMatchEnd(data.blueScore, data.orangeScore, data.stats, data.mvpIdx, this.maxPlayers);
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
    this.allCars[mySlot] = this.playerCar;

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

    // Skip bloom on iOS — render targets exceed Safari's GPU memory limits
    if (!this._isIOS) {
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
    if (carA.demolished || carB.demolished) return;

    const speedA = carA.getSpeed();
    const speedB = carB.getSpeed();

    // Demolition at supersonic speed — but only if driving INTO the other car.
    // Dot product of attacker velocity direction vs direction toward victim must be > 0.5
    // (within ~60° cone). Side-by-side or same-direction travel won't demolish.
    if (speedA >= CAR_CONST.SUPERSONIC_THRESHOLD && speedA > speedB) {
      const va = carA.body.velocity;
      const dx = carB.body.position.x - carA.body.position.x;
      const dy = carB.body.position.y - carA.body.position.y;
      const dz = carB.body.position.z - carA.body.position.z;
      const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const dot = (va.x * dx + va.y * dy + va.z * dz) / (speedA * dLen);
      if (dot > 0.5) {
        if (this.perfTracker) {
          const idx = this.allCars.indexOf(carA);
          if (idx >= 0) this.perfTracker.recordDemolition(idx);
        }
        this._demolishCar(carB);
        return;
      }
    }
    if (speedB >= CAR_CONST.SUPERSONIC_THRESHOLD && speedB > speedA) {
      const vb = carB.body.velocity;
      const dx = carA.body.position.x - carB.body.position.x;
      const dy = carA.body.position.y - carB.body.position.y;
      const dz = carA.body.position.z - carB.body.position.z;
      const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const dot = (vb.x * dx + vb.y * dy + vb.z * dz) / (speedB * dLen);
      if (dot > 0.5) {
        if (this.perfTracker) {
          const idx = this.allCars.indexOf(carB);
          if (idx >= 0) this.perfTracker.recordDemolition(idx);
        }
        this._demolishCar(carA);
        return;
      }
    }

    // Sub-supersonic bump: faster car plows through, slower car gets launched
    if (speedA < 2 && speedB < 2) return; // both nearly stationary, let physics handle it

    const bumper = speedA >= speedB ? carA : carB;
    const bumped = bumper === carA ? carB : carA;

    // Direction from bumper to bumped
    const dx = bumped.body.position.x - bumper.body.position.x;
    const dz = bumped.body.position.z - bumper.body.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = dx / dist;
    const nz = dz / dist;

    const bumperSpeed = bumper.getSpeed();
    const bumpStrength = Math.min(bumperSpeed * 0.3, 8);

    // Nudge the bumped car in bump direction + slight upward
    bumped.body.velocity.x += nx * bumpStrength;
    bumped.body.velocity.z += nz * bumpStrength;
    bumped.body.velocity.y += bumpStrength * 0.15;

    // Bumper loses a little speed
    const bv = bumper.body.velocity;
    bv.x *= 0.9;
    bv.z *= 0.9;
  }

  _demolishCar(car) {
    const pos = { x: car.body.position.x, y: car.body.position.y, z: car.body.position.z };
    const half = Math.floor(this.allCars.length / 2);
    const idx = this.allCars.indexOf(car);
    const color = idx < half ? COLORS.CYAN : COLORS.ORANGE;
    car.demolish();
    this._spawnExplosion(pos, color);
    this.replayBuffer.addEvent({ type: 'demolish', x: pos.x, y: pos.y, z: pos.z, color });
    if (car === this.playerCar) this.hud.showDemolished();
  }

  _spawnExplosion(pos, color) {
    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, pos.z);

    // Flash sphere — reuse shared geometry
    if (!this._sharedFlashGeo) {
      this._sharedFlashGeo = new THREE.SphereGeometry(1, 12, 12);
    }
    const flashMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 1,
    });
    const flash = new THREE.Mesh(this._sharedFlashGeo, flashMat);
    group.add(flash);

    // Point light
    const light = new THREE.PointLight(color, 5, 30);
    group.add(light);

    // Debris particles — reuse shared geometry
    if (!this._sharedDebrisGeo) {
      this._sharedDebrisGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    }
    const particles = [];
    for (let i = 0; i < DEMOLITION.PARTICLE_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 1,
      });
      const p = new THREE.Mesh(this._sharedDebrisGeo, mat);
      p.position.set(0, 0, 0);
      const vx = (Math.random() - 0.5) * 2 * DEMOLITION.PARTICLE_SPEED;
      const vy = Math.random() * DEMOLITION.PARTICLE_SPEED;
      const vz = (Math.random() - 0.5) * 2 * DEMOLITION.PARTICLE_SPEED;
      group.add(p);
      particles.push({ mesh: p, vx, vy, vz });
    }

    this.scene.add(group);
    this._activeExplosions.push({
      group,
      flash,
      light,
      particles,
      elapsed: 0,
    });
  }

  _updateExplosions(dt) {
    for (let i = this._activeExplosions.length - 1; i >= 0; i--) {
      const ex = this._activeExplosions[i];
      ex.elapsed += dt;

      const duration = ex.isGoal ? 1.0 : DEMOLITION.EXPLOSION_DURATION;
      const lifetime = ex.isGoal ? 1.4 : DEMOLITION.PARTICLE_LIFETIME;

      // Flash: scale up and fade out
      const flashT = Math.min(ex.elapsed / duration, 1);
      const flashScale = ex.isGoal ? 2 + flashT * 18 : 1 + flashT * 8;
      ex.flash.scale.setScalar(flashScale);
      ex.flash.material.opacity = Math.max(0, 1 - flashT);
      ex.light.intensity = Math.max(0, (ex.isGoal ? 10 : 5) * (1 - flashT));

      // Goal: expanding shockwave rings
      if (ex.isGoal && ex.ring) {
        const ringScale = 2 + flashT * 40;
        ex.ring.scale.setScalar(ringScale);
        ex.ring.material.opacity = Math.max(0, 0.9 * (1 - flashT));
        ex.ring2.scale.setScalar(ringScale * 0.8);
        ex.ring2.material.opacity = Math.max(0, 0.7 * (1 - flashT * 1.2));
      }

      // Particles: move + gravity + fade
      const particleT = Math.min(ex.elapsed / lifetime, 1);
      for (const p of ex.particles) {
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        p.vy -= 30 * dt;

        // Sparks: drag slows them, fade faster
        if (p.isSpark) {
          p.vx *= 0.97;
          p.vy *= 0.97;
          p.vz *= 0.97;
          p.mesh.material.opacity = Math.max(0, 1 - particleT * 1.3);
        } else {
          // Debris: tumble
          if (p.spin) p.mesh.rotation.x += p.spin * dt;
          p.mesh.material.opacity = Math.max(0, 1 - particleT);
        }
      }

      // Cleanup when done (shared geometry is NOT disposed — reused across explosions)
      if (ex.elapsed >= lifetime) {
        this.scene.remove(ex.group);
        ex.flash.material.dispose();
        for (const p of ex.particles) {
          p.mesh.material.dispose();
        }
        if (ex.ring) {
          ex.ring.material.dispose();
          ex.ring2.material.dispose();
        }
        ex.light.dispose();
        this._activeExplosions.splice(i, 1);
      }
    }
  }

  _spawnGoalExplosion(pos, color) {
    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, pos.z);
    const c = new THREE.Color(color);

    // --- Core flash sphere ---
    if (!this._sharedFlashGeo) {
      this._sharedFlashGeo = new THREE.SphereGeometry(1, 12, 12);
    }
    const flashMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 1,
    });
    const flash = new THREE.Mesh(this._sharedFlashGeo, flashMat);
    group.add(flash);

    // --- Bright point light ---
    const light = new THREE.PointLight(color, 10, 80);
    group.add(light);

    // --- Expanding shockwave ring ---
    const ringGeo = new THREE.RingGeometry(0.5, 1.0, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    // --- Second ring (vertical) ---
    const ring2 = new THREE.Mesh(ringGeo, ringMat.clone());
    group.add(ring2);

    // --- Spark particles (small, bright, fast) ---
    if (!this._sharedSparkGeo) {
      this._sharedSparkGeo = new THREE.BoxGeometry(0.15, 0.15, 0.6);
    }
    if (!this._sharedDebrisGeo) {
      this._sharedDebrisGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    }

    const particles = [];

    // Outer sparks — fast, small, elongated
    for (let i = 0; i < 50; i++) {
      const bright = c.clone().lerp(new THREE.Color(0xffffff), 0.4 + Math.random() * 0.4);
      const mat = new THREE.MeshBasicMaterial({
        color: bright, transparent: true, opacity: 1,
      });
      const p = new THREE.Mesh(this._sharedSparkGeo, mat);
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI;
      const spd = 20 + Math.random() * 25;
      const vx = Math.cos(theta) * Math.cos(phi) * spd;
      const vy = Math.sin(phi) * spd * 0.6 + Math.random() * 8;
      const vz = Math.sin(theta) * Math.cos(phi) * spd;
      // Orient spark along velocity
      p.lookAt(vx, vy, vz);
      group.add(p);
      particles.push({ mesh: p, vx, vy, vz, isSpark: true });
    }

    // Chunky debris — slower, heavier
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 1,
      });
      const p = new THREE.Mesh(this._sharedDebrisGeo, mat);
      const scale = 0.5 + Math.random() * 1.5;
      p.scale.setScalar(scale);
      const vx = (Math.random() - 0.5) * 20;
      const vy = 5 + Math.random() * 15;
      const vz = (Math.random() - 0.5) * 20;
      group.add(p);
      particles.push({ mesh: p, vx, vy, vz, spin: (Math.random() - 0.5) * 10 });
    }

    this.scene.add(group);
    this._activeExplosions.push({
      group, flash, light, particles, elapsed: 0,
      isGoal: true, ring, ring2,
    });
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

    this._countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        this.hud.showCountdown(count);
      } else {
        this.hud.showCountdown(0);
        clearInterval(this._countdownInterval);
        this.state = 'playing';
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

    // Camera always updates (except during replay — replay player drives camera)
    if (this.cameraController && this.state !== 'replay') {
      this.cameraController.update(dt, inputState.ballCam, inputState.lookX);
    }

    // HUD updates
    if (this.playerCar) {
      this.hud.updateBoost(this.playerCar.boost);
      this.hud.updateSpeed(this.playerCar.getSpeed(), CAR_CONST.BOOST_MAX_SPEED);
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

    this.composer.render();
  }

  // ========== SINGLE-PLAYER LOOP ==========

  _loopSingleplayer(dt, inputState) {
    // During replay, drive meshes from recorded frames (physics paused)
    if (this.state === 'replay') {
      this._updateReplay(dt);
      this._updateExplosions(dt);
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
      this._updateExplosions(dt);
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
        this._updateAI(dt);
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

    this._updateExplosions(dt);
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
      this._updateExplosions(dt);
      if (this._checkReplaySkipInput()) this._skipReplay();
      return;
    }

    // Goal celebration: let explosion play, then start replay
    if (this.state === 'goal_celebration') {
      this._celebrationTimer -= dt;
      this._updateExplosions(dt);
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
      this._updateExplosions(dt);
      return;
    }

    if (this.state === 'playing' || this.state === 'overtime') {
      // Apply aim assist for touch users before sending/applying
      const assisted = this._applyAimAssist(inputState);

      // Send input to server
      const input = this.network.sendInput(assisted);
      this.network.addPendingInput(input);

      // Client-side prediction: apply input locally
      this.playerCar.update(assisted, dt);

      // Step local physics for player car prediction
      this.accumulator += dt;
      while (this.accumulator >= PHYSICS.TIMESTEP) {
        this.world.step(PHYSICS.TIMESTEP);
        this.accumulator -= PHYSICS.TIMESTEP;
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

    // Decay correction offset for smooth reconciliation (frame-rate independent)
    const decay = Math.exp(-10 * dt); // smooth exponential decay ~10 Hz half-life
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

    // Extrapolate remote cars forward using velocity for smooth motion between server updates
    for (const { car } of this.remoteCars) {
      if (!car.demolished) {
        car.body.position.x += car.body.velocity.x * dt;
        car.body.position.y += car.body.velocity.y * dt;
        car.body.position.z += car.body.velocity.z * dt;
      }
      car._syncMesh();
    }

    // Smooth ball visual: interpolate toward server target + extrapolate with velocity
    this._updateBallVisual(dt);

    // Animate boost pads (visual only)
    this.boostPads.update(dt, []);

    this._updateExplosions(dt);
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

    // Extrapolate target position forward using velocity (reduces perceived lag)
    const extrapS = dt; // one frame ahead
    const tx = target.px + target.vx * extrapS;
    const ty = target.py + target.vy * extrapS;
    const tz = target.pz + target.vz * extrapS;

    // Smoothly blend current position toward target (fast lerp for responsiveness)
    const lerp = 1 - Math.exp(-20 * dt); // ~20Hz blend rate — very responsive
    body.position.x += (tx - body.position.x) * lerp;
    body.position.y += (ty - body.position.y) * lerp;
    body.position.z += (tz - body.position.z) * lerp;

    // Also extrapolate between updates: drift toward target using velocity
    body.position.x += target.vx * dt * (1 - lerp);
    body.position.y += target.vy * dt * (1 - lerp);
    body.position.z += target.vz * dt * (1 - lerp);

    // Set velocity for visual spin calculation
    body.velocity.set(target.vx, target.vy, target.vz);

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
    this._spawnGoalExplosion(goalPos, goalColor);
    this.replayBuffer.addEvent({ type: 'goal', x: goalPos.x, y: goalPos.y, z: goalPos.z, color: goalColor });
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
    this._spawnGoalExplosion({ x: ballPos.x, y: ballPos.y, z: ballPos.z }, goalColor);

    if (goalSide === 1) {
      this.scores.orange++;
      this.hud.showGoalScored('orange');
    } else {
      this.scores.blue++;
      this.hud.showGoalScored('blue');
    }
    this.hud.updateScore(this.scores.blue, this.scores.orange);

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
            this._spawnGoalExplosion(e, e.color);
          } else if (e.type === 'demolish') {
            this._spawnExplosion(e, e.color);
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
    this._correctionOffset.x = 0;
    this._correctionOffset.y = 0;
    this._correctionOffset.z = 0;
    this.network.pendingInputs = [];
    this.replayBuffer.clear();
    this._ballTarget = null; // reset ball visual target so it picks up fresh server state

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

  // ========== AI (single-player only) ==========

  _getAIParams() {
    switch (this.aiDifficulty) {
      case 'rookie':
        return {
          approachOffset: 14,
          attackAngle: 0.6,       // wider cone → less precise shots
          defenseZ: 25,           // reacts later to defense
          clearDist: 18,
          steerDeadzone: 0.15,    // sloppier steering
          maxThrottle: 0.75,      // slower overall
          rotateSlowAngle: 0.8,
          rotateThrottle: 0.4,
          useBoost: false,        // never boosts
          handbrakeAngle: 1.5,    // rarely handbrakes
          handbrakeSpeed: 15,
          jumpBall: false,        // never jumps for aerials
          dodgeBall: false,       // never dodge-hits
          reactionDelay: 0.15,    // 150ms delayed reads
          aimJitter: 3.0,         // position error added to target
        };
      case 'allstar':
        return {
          approachOffset: 10,
          attackAngle: 0.3,       // tight cone → precise shots
          defenseZ: 35,           // reacts early
          clearDist: 12,
          steerDeadzone: 0.03,    // tight steering
          maxThrottle: 1,
          rotateSlowAngle: 1.2,
          rotateThrottle: 0.6,
          useBoost: true,
          handbrakeAngle: 1.0,
          handbrakeSpeed: 8,
          jumpBall: true,
          jumpHeight: 2.5,       // jumps for lower balls too
          jumpDist: 10,
          dodgeBall: true,        // dodge-hits the ball
          dodgeDist: 5,
          reactionDelay: 0,
          aimJitter: 0,
          leadBall: true,         // predicts ball position
          leadTime: 0.4,          // seconds of prediction
        };
      default: // pro
        return {
          approachOffset: 12,
          attackAngle: 0.4,
          defenseZ: 30,
          clearDist: 15,
          steerDeadzone: 0.05,
          maxThrottle: 1,
          rotateSlowAngle: 1.0,
          rotateThrottle: 0.5,
          useBoost: true,
          handbrakeAngle: 1.2,
          handbrakeSpeed: 10,
          jumpBall: true,
          jumpHeight: 3,
          jumpDist: 8,
          dodgeBall: false,
          reactionDelay: 0,
          aimJitter: 0,
          leadBall: false,
        };
    }
  }

  _updateAI(dt) {
    // In 2v2, assign roles: on each team, car closest to ball = attacker, farther = support
    let roles = null;
    if (this.aiMode === '2v2') {
      const rawBallPos = this.ball.getPosition();
      roles = new Map();
      // Blue team AI cars (indices >= 1 that are < half)
      // Orange team AI cars (indices >= half)
      const half = Math.floor(this.allCars.length / 2);
      // Group AI cars by team
      const blueAI = [];
      const orangeAI = [];
      for (const car of this.aiCars) {
        const idx = this.allCars.indexOf(car);
        if (idx < half) blueAI.push(car);
        else orangeAI.push(car);
      }
      // Assign roles per team
      for (const team of [blueAI, orangeAI]) {
        if (team.length <= 1) {
          for (const c of team) roles.set(c, 'attacker');
          continue;
        }
        // Sort by distance to ball
        const sorted = [...team].sort((a, b) => {
          const ap = a.getPosition();
          const bp = b.getPosition();
          const da = (ap.x - rawBallPos.x) ** 2 + (ap.z - rawBallPos.z) ** 2;
          const db = (bp.x - rawBallPos.x) ** 2 + (bp.z - rawBallPos.z) ** 2;
          return da - db;
        });
        roles.set(sorted[0], 'attacker');
        for (let i = 1; i < sorted.length; i++) roles.set(sorted[i], 'support');
      }
    }

    for (const car of this.aiCars) {
      if (car.demolished) continue;
      const idx = this.allCars.indexOf(car);
      const half = Math.floor(this.allCars.length / 2);
      const teamDir = idx < half ? 1 : -1;
      const role = roles ? roles.get(car) : 'attacker';
      this._updateAICar(car, teamDir, role, dt);
    }
  }

  _updateAICar(car, teamDir, role, dt) {
    const p = this._getAIParams();
    // teamDir: 1 = blue (attacks toward +Z), -1 = orange (attacks toward -Z)
    const ENEMY_GOAL_Z = teamDir === 1 ? ARENA_CONST.LENGTH / 2 : -ARENA_CONST.LENGTH / 2;
    const OWN_GOAL_Z = teamDir === 1 ? -ARENA_CONST.LENGTH / 2 : ARENA_CONST.LENGTH / 2;

    let ballPos = this.ball.getPosition();
    const ballVel = this.ball.body.velocity;
    const carPos = car.getPosition();

    // All-Star: lead the ball by predicting its future position
    if (p.leadBall) {
      const t = p.leadTime;
      ballPos = {
        x: ballPos.x + ballVel.x * t,
        y: ballPos.y + ballVel.y * t,
        z: ballPos.z + ballVel.z * t,
      };
    }

    // Rookie: add jitter to ball position (simulates imprecise reads)
    if (p.aimJitter > 0) {
      const jitterSeed = Math.floor(performance.now() / 200);
      const jx = (Math.sin(jitterSeed * 1.7) * p.aimJitter);
      const jz = (Math.cos(jitterSeed * 2.3) * p.aimJitter);
      ballPos = { x: ballPos.x + jx, y: ballPos.y, z: ballPos.z + jz };
    }

    // Rookie: reaction delay — use slightly stale ball position
    if (p.reactionDelay > 0) {
      const t = -p.reactionDelay;
      ballPos = {
        x: ballPos.x + ballVel.x * t,
        y: ballPos.y,
        z: ballPos.z + ballVel.z * t,
      };
    }

    const toBallX = ballPos.x - carPos.x;
    const toBallZ = ballPos.z - carPos.z;
    const distToBall = Math.sqrt(toBallX * toBallX + toBallZ * toBallZ);

    // Ideal hit direction: ball → enemy goal (flip for team direction)
    const goalDx = 0 - ballPos.x;
    const goalDz = ENEMY_GOAL_Z - ballPos.z;
    const goalDist = Math.sqrt(goalDx * goalDx + goalDz * goalDz) || 1;
    const idealDirX = goalDx / goalDist;
    const idealDirZ = goalDz / goalDist;

    // Car→ball direction (normalized)
    const toBallDist = distToBall || 1;
    const toBallNX = toBallX / toBallDist;
    const toBallNZ = toBallZ / toBallDist;

    const approachDot = toBallNX * idealDirX + toBallNZ * idealDirZ;

    // Support role: position between ball and own goal instead of chasing ball
    if (role === 'support') {
      const midX = ballPos.x * 0.3;
      const midZ = (ballPos.z + OWN_GOAL_Z) * 0.5;
      const sDx = midX - carPos.x;
      const sDz = midZ - carPos.z;
      const sAngle = Math.atan2(sDx, sDz);
      car.body.quaternion.toEuler(_aiEuler);
      let sAngleDiff = sAngle - _aiEuler.y;
      while (sAngleDiff > Math.PI) sAngleDiff -= 2 * Math.PI;
      while (sAngleDiff < -Math.PI) sAngleDiff += 2 * Math.PI;
      const sAbsAngle = Math.abs(sAngleDiff);
      const sDist = Math.sqrt(sDx * sDx + sDz * sDz);

      const sSteer = sAngleDiff > 0.05 ? 1 : sAngleDiff < -0.05 ? -1 : 0;
      const sThrottle = sDist > 5 ? p.maxThrottle : 0.3;
      const sBoost = p.useBoost && sDist > 30 && sAbsAngle < 0.3;
      const sHandbrake = sAbsAngle > p.handbrakeAngle && car.body.velocity.length() > p.handbrakeSpeed;

      car.update({
        throttle: sThrottle, steer: sSteer, jump: false, jumpPressed: false,
        boost: sBoost, ballCam: true, airRoll: 0, pitchUp: false, pitchDown: false,
        handbrake: sHandbrake, dodgeForward: 0, dodgeSteer: 0,
      }, dt);
      return;
    }

    // Decide mode — use teamDir to determine defense zone
    let mode;
    let targetX, targetZ;

    // Defense zone is on own-goal side
    const ballOnOwnSide = teamDir === 1
      ? ballPos.z < -p.defenseZ
      : ballPos.z > p.defenseZ;
    const ballMovingToOwnGoal = teamDir === 1
      ? ballVel.z < 5
      : ballVel.z > -5;

    if (ballOnOwnSide && ballMovingToOwnGoal) {
      mode = 'defend';
    } else if (approachDot > Math.cos(p.attackAngle)) {
      mode = 'attack';
    } else {
      mode = 'rotate';
    }

    // Compute target position per mode
    if (mode === 'attack') {
      targetX = ballPos.x;
      targetZ = ballPos.z;
    } else if (mode === 'defend') {
      const sideSign = ballPos.x > 0 ? 1 : -1;
      if (distToBall < p.clearDist) {
        targetX = ballPos.x + sideSign * 5;
        targetZ = ballPos.z + teamDir * 3;
      } else {
        targetX = ballPos.x;
        targetZ = (ballPos.z + OWN_GOAL_Z) / 2;
      }
    } else {
      const fromGoalX = ballPos.x;
      const fromGoalZ = ballPos.z - ENEMY_GOAL_Z;
      const fromGoalDist = Math.sqrt(fromGoalX * fromGoalX + fromGoalZ * fromGoalZ) || 1;
      targetX = ballPos.x + (fromGoalX / fromGoalDist) * p.approachOffset;
      targetZ = ballPos.z + (fromGoalZ / fromGoalDist) * p.approachOffset;
    }

    // Steering
    const steerDx = targetX - carPos.x;
    const steerDz = targetZ - carPos.z;
    const targetAngle = Math.atan2(steerDx, steerDz);
    car.body.quaternion.toEuler(_aiEuler);
    let angleDiff = targetAngle - _aiEuler.y;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    const absAngle = Math.abs(angleDiff);

    // Throttle
    let throttle = p.maxThrottle;
    if (mode === 'rotate' && absAngle > p.rotateSlowAngle) {
      throttle = p.rotateThrottle;
    }

    // Steer (deadzone)
    const dz = p.steerDeadzone;
    const steer = angleDiff > dz ? 1 : angleDiff < -dz ? -1 : 0;

    // Boost
    let boost = false;
    if (p.useBoost) {
      if (mode === 'attack' && absAngle < 0.3) {
        boost = true;
      } else if (mode === 'rotate' && distToBall > 30) {
        boost = true;
      } else if (mode === 'defend') {
        const distToOwnGoal = Math.abs(ballPos.z - OWN_GOAL_Z);
        if (distToOwnGoal < 25) boost = true;
      }
    }

    // Handbrake
    const speed = car.body.velocity.length();
    const handbrake = absAngle > p.handbrakeAngle && speed > p.handbrakeSpeed;

    // Jump for aerial balls
    let jumpPressed = false;
    const jumpHeight = p.jumpHeight || 3;
    const jumpDist = p.jumpDist || 8;
    if (p.jumpBall && mode === 'attack' && distToBall < jumpDist && ballPos.y > jumpHeight && car.isGrounded) {
      jumpPressed = true;
    }

    // All-Star: dodge into ball for powerful hits
    let dodgeForward = 0;
    let dodgeSteer = 0;
    if (p.dodgeBall && mode === 'attack' && distToBall < (p.dodgeDist || 5)
        && !car.isGrounded && car.canDoubleJump && !car.isDodging
        && ballPos.y < 5) {
      jumpPressed = true;
      dodgeForward = toBallNZ > 0 ? -1 : 1;
      dodgeSteer = toBallNX > 0.3 ? 1 : toBallNX < -0.3 ? -1 : 0;
    }

    const aiInput = {
      throttle,
      steer,
      jump: false,
      jumpPressed,
      boost,
      ballCam: true,
      airRoll: 0,
      pitchUp: false,
      pitchDown: false,
      handbrake,
      dodgeForward,
      dodgeSteer,
    };

    car.update(aiInput, dt);
  }

  // ========== TRAINING MODE ==========

  _initTraining() {
    const opts = this.trainingOpts;
    const pack = TRAINING_PACKS[opts.type]?.[opts.difficulty];
    if (!pack || pack.length === 0) {
      console.error('Invalid training pack:', opts);
      return;
    }

    this._trainingPack = pack;
    this._trainingShotIndex = 0;
    this._trainingScore = { hit: 0, total: pack.length };
    this._trainingShotTimer = 0;
    this._trainingShotActive = false;
    this._trainingShotResult = null; // 'success' | 'fail' | null
    this._trainingResultTimer = 0;
    this._trainingType = opts.type;
    this._trainingBallTouched = false;
    this._trainingBallFrozen = false; // aerial rookie: ball frozen until touched
    this._trainingResults = new Array(pack.length).fill(null);
    this._trainingComplete = false;

    // For goalie: track if ball entered blue goal
    this._trainingGoalieFailed = false;

    // Init scene like freeplay — single car, no opponents
    this._initScene();
    this.cameraController = new CameraController(this.camera);
    this.cameraController.setTarget(this.playerCar);
    this.cameraController.setBallTarget(this.ball);
    this._initPostProcessing();

    this.state = 'playing';
    this.matchTime = Infinity;

    // Build training HUD
    this._buildTrainingHUD();

    // Load first shot
    this._loadTrainingShot(0);
  }

  _buildTrainingHUD() {
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

    this._updateTrainingHUD();

    // Key listeners for training controls
    this._trainingKeyHandler = (e) => {
      if (e.code === 'KeyR') {
        this._resetTrainingShot();
      } else if (e.code === 'BracketRight') {
        this._nextTrainingShot();
      } else if (e.code === 'BracketLeft') {
        this._prevTrainingShot();
      }
    };
    window.addEventListener('keydown', this._trainingKeyHandler);
  }

  _updateTrainingHUD() {
    const idx = this._trainingShotIndex;
    const total = this._trainingPack.length;
    this._trainingShotLabel.textContent = `SHOT ${idx + 1} / ${total}`;
    this._trainingScoreLabel.textContent = `${this._trainingScore.hit} / ${this._trainingScore.total}`;

    const t = Math.ceil(this._trainingShotTimer);
    this._trainingTimerLabel.textContent = this._trainingShotActive ? `${t}s` : '';
  }

  _loadTrainingShot(index) {
    if (index < 0 || index >= this._trainingPack.length) return;

    this._trainingShotIndex = index;
    const shot = this._trainingPack[index];

    // Reset car
    this.playerCar.reset(shot.carPos, shot.carDir);
    this.playerCar.boost = 100; // full boost in training

    // Position ball — aerial allstar delays launch by 1s so player can orient
    this.ball.body.position.set(shot.ballPos.x, shot.ballPos.y, shot.ballPos.z);
    this.ball.body.angularVelocity.set(0, 0, 0);
    this.ball._spinQuat.identity();

    const useLaunchDelay = (this._trainingType === 'aerial' && this.trainingOpts.difficulty === 'allstar')
      || this._trainingType === 'goalie';
    if (useLaunchDelay) {
      // Hold ball still so player can orient, then launch
      this.ball.body.velocity.set(0, 0, 0);
      this._trainingLaunchDelay = this._trainingType === 'goalie' ? 1.5 : 1.0;
      this._trainingPendingVel = { x: shot.ballVel.x, y: shot.ballVel.y, z: shot.ballVel.z };
    } else {
      this.ball.body.velocity.set(shot.ballVel.x, shot.ballVel.y, shot.ballVel.z);
      this._trainingLaunchDelay = 0;
      this._trainingPendingVel = null;
    }

    // Reset shot state
    this._trainingShotTimer = 11; // 10s play + 1s delay for allstar
    this._trainingShotActive = true;
    this._trainingShotResult = null;
    this._trainingResultTimer = 0;
    this._trainingBallTouched = false;
    this._trainingGoalieFailed = false;

    // Aerial rookie/pro: freeze ball in air until player touches it
    this._trainingBallFrozen = (this._trainingType === 'aerial' && (this.trainingOpts.difficulty === 'rookie' || this.trainingOpts.difficulty === 'pro'));

    this._updateTrainingHUD();
  }

  _resetTrainingShot() {
    this._loadTrainingShot(this._trainingShotIndex);
  }

  _nextTrainingShot() {
    const next = (this._trainingShotIndex + 1) % this._trainingPack.length;
    this._loadTrainingShot(next);
  }

  _prevTrainingShot() {
    const prev = (this._trainingShotIndex - 1 + this._trainingPack.length) % this._trainingPack.length;
    this._loadTrainingShot(prev);
  }

  _showTrainingResult(result) {
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
    this._updateTrainingHUD();
  }

  _showTrainingComplete() {
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

  _loopTraining(dt, inputState) {
    // Physics
    this.accumulator += dt;
    while (this.accumulator >= PHYSICS.TIMESTEP) {
      this.world.step(PHYSICS.TIMESTEP);
      this.accumulator -= PHYSICS.TIMESTEP;
    }

    for (const car of this.allCars) car._syncMesh();
    this.ball.update(dt);

    // Update explosions
    this._updateExplosions(dt);

    // Player car input
    if (!this.playerCar.demolished) {
      const assisted = this._applyAimAssist(inputState);
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

      // Check if player touched the frozen ball
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
        // Check if all shots attempted
        if (this._trainingResults.every(r => r !== null)) {
          this._showTrainingComplete();
          return;
        }
        // Auto-advance to next shot
        this._nextTrainingShot();
      }
      return;
    }

    if (this._trainingComplete) return;

    if (!this._trainingShotActive) return;

    // Shot timer countdown
    this._trainingShotTimer -= dt;
    this._updateTrainingHUD();

    // Detect ball-car contact for goalie mode
    if (this._trainingType === 'goalie') {
      // Check if ball touched car (simple distance check)
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
      // Success: ball enters orange goal (goalSide === 2 means z > +HL → scored on orange side?
      // Actually looking at arena.isInGoal: goalSide 1 = z < -HL (blue goal back), 2 = z > +HL (orange goal back)
      // Wait — we need to check carefully. The orange goal is at z > LENGTH/2.
      const goalSide = this.arena.isInGoal(this.ball.body.position);
      if (goalSide === 2) {
        // Scored in orange goal
        const ballPos = this.ball.body.position;
        this._spawnGoalExplosion({ x: ballPos.x, y: ballPos.y, z: ballPos.z }, COLORS.GOAL_ORANGE);
        this._showTrainingResult('success');
        return;
      }
      // Fail: timer expired
      if (this._trainingShotTimer <= 0) {
        this._showTrainingResult('fail');
        return;
      }
    } else if (this._trainingType === 'goalie') {
      // Check if ball entered blue goal
      const goalSide = this.arena.isInGoal(this.ball.body.position);
      if (goalSide === 1) {
        // Ball entered blue goal — player failed to save
        const ballPos = this.ball.body.position;
        this._spawnGoalExplosion({ x: ballPos.x, y: ballPos.y, z: ballPos.z }, COLORS.GOAL_BLUE);
        this._showTrainingResult('fail');
        return;
      }

      // Success: ball touched and now heading away from goal (positive z velocity)
      if (this._trainingBallTouched) {
        const vz = this.ball.body.velocity.z;
        if (vz > 2) {
          // Ball deflected away from goal — save!
          this._showTrainingResult('success');
          return;
        }
      }

      // Timer expired without goal — saved
      if (this._trainingShotTimer <= 0) {
        this._showTrainingResult('success');
        return;
      }
    }

    // Ball out of bounds reset (fell through floor, etc)
    if (this.ball.body.position.y < -20) {
      this._resetTrainingShot();
    }
  }

  // ========== CLEANUP ==========

  destroy() {
    this._destroyed = true;

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

    // Clean up training HUD
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

    // Clear explosions
    this._activeExplosions = [];

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
