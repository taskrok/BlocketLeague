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
import { CameraSettings } from './CameraSettings.js';
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

// Reusable temp vectors
const _aiEuler = new CANNON.Vec3();
const _aimEuler = new CANNON.Vec3();

export class Game {
  constructor(canvas, mode = 'singleplayer', networkManager = null, playerVariant = null, joinedData = null, aiDifficulty = 'pro', aiMode = '1v1') {
    this.canvas = canvas;
    this.mode = mode;
    this.network = networkManager;
    this.playerVariant = playerVariant;
    this._joinedData = joinedData;
    this.aiDifficulty = aiDifficulty;
    this.aiMode = aiMode;
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

    if (this.mode === 'singleplayer') {
      this._initScene();
      this.cameraController = new CameraController(this.camera);
      this.cameraController.setTarget(this.playerCar);
      this.cameraController.setBallTarget(this.ball);
      this._initPostProcessing();
      this._startCountdown();
    } else {
      // Multiplayer: init scene partially, wait for 'joined' to create cars
      this._initSceneMultiplayer();
      this.cameraController = new CameraController(this.camera);
      this.cameraController.setBallTarget(this.ball);
      this._initPostProcessing();
      this._initMultiplayer();
    }

    this.cameraSettings = new CameraSettings(this.cameraController);

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

    this.world.defaultContactMaterial.restitution = 0.3;
    this.world.defaultContactMaterial.friction = 0.0;
  }

  // ========== SINGLE-PLAYER SCENE INIT ==========

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050510);
    this.scene.fog = new THREE.Fog(0x050510, 140, 300);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 400
    );
    this.camera.position.set(0, 15, -30);

    this.arena = new Arena(this.scene, this.world);

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

    if (this.aiMode === '2v2') {
      // 2v2: 4 cars — player + AI teammate (blue) vs 2 AI opponents (orange)
      const allyVariant = generateCarVariant(COLORS.CYAN, modelIds);
      allyVariant.bodyColor = COLORS.TEAM_BLUE_BODY;
      const opp1Variant = generateCarVariant(COLORS.ORANGE, modelIds);
      opp1Variant.bodyColor = COLORS.TEAM_ORANGE_BODY;
      const opp2Variant = generateCarVariant(COLORS.ORANGE, modelIds);
      opp2Variant.bodyColor = COLORS.TEAM_ORANGE_BODY;

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
    this.perfTracker = new PerformanceTracker(this.allCars.length);
  }

  // ========== MULTIPLAYER SCENE INIT ==========

  _initSceneMultiplayer() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050510);
    this.scene.fog = new THREE.Fog(0x050510, 140, 300);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 400
    );
    this.camera.position.set(0, 15, -30);

    this.arena = new Arena(this.scene, this.world);

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
      // Only reconcile player car during active gameplay
      if (this.state === 'playing' || this.state === 'overtime') {
        this._reconcile(snapshot);
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
      this.hud.showGoalScored(data.team);

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
        this._handleCarDemolition(carA, carB);
      });
    }
  }

  _handleCarDemolition(carA, carB) {
    if (carA.demolished || carB.demolished) return;

    const speedA = carA.getSpeed();
    const speedB = carB.getSpeed();

    let attacker = null;
    let victim = null;

    if (speedA >= CAR_CONST.SUPERSONIC_THRESHOLD && speedA > speedB) {
      attacker = carA;
      victim = carB;
    } else if (speedB >= CAR_CONST.SUPERSONIC_THRESHOLD && speedB > speedA) {
      attacker = carB;
      victim = carA;
    }

    if (!victim) return;

    if (this.perfTracker && attacker) {
      const attackerIdx = this.allCars ? this.allCars.indexOf(attacker) : (attacker === this.playerCar ? 0 : 1);
      if (attackerIdx >= 0) this.perfTracker.recordDemolition(attackerIdx);
    }

    this._demolishCar(victim);
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

    if (this.mode === 'singleplayer') {
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

    // Live scoreboard (hold Tab / LB)
    if (inputState.scoreboard && this.state !== 'ended' && this.state !== 'countdown' && this.state !== 'replay') {
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

    if (this.state === 'playing' || this.state === 'overtime') {
      if (!this.playerCar.demolished) {
        const assisted = this._applyAimAssist(inputState);
        this.playerCar.update(assisted, dt);
      }
      this._updateAI(dt);

      // Update demolition respawns for all cars
      if (this.aiMode === '2v2') {
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
      this._updateTimer(dt);

      // Record frame for replay
      this.replayBuffer.record(this.ball, this.allCars, this.boostPads);

      this._checkGoal();
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
      if (this._celebrationTimer <= 0) {
        if (this.replayBuffer.frameCount >= 30) {
          this._startReplay();
        } else {
          this._onReplayFinished();
        }
      }
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

    // Decay correction offset for smooth reconciliation
    const decay = 1 - NETWORK.BLEND_RATE;
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

    for (const { car } of this.remoteCars) {
      car._syncMesh();
    }
    this.ball.update(dt);

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
      // Large error: snap (zero offset, no smoothing)
      this._correctionOffset.x = 0;
      this._correctionOffset.y = 0;
      this._correctionOffset.z = 0;
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

    // Set ball position from interpolated data + forward extrapolation
    // The ball is interpolated ~adaptiveDelay ms behind the server, so
    // extrapolate forward using velocity to reduce visual latency
    const ballData = interpState.ball;
    if (ballData) {
      const extrapMs = this.network._adaptiveDelay * 0.5; // compensate half the delay
      const extrapS = extrapMs / 1000;
      this.ball.body.position.set(
        ballData.px + ballData.vx * extrapS,
        ballData.py + ballData.vy * extrapS,
        ballData.pz + ballData.vz * extrapS
      );
      this.ball.body.velocity.set(ballData.vx, ballData.vy, ballData.vz);
      this.ball.body.quaternion.set(ballData.qx, ballData.qy, ballData.qz, ballData.qw);
    }
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

    if (this.perfTracker) {
      this.perfTracker.recordGoal(goalSide);
    }

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
      this.hud.showGoalScored('orange');
    } else {
      this.scores.blue++;
      this.hud.showGoalScored('blue');
    }

    this.hud.updateScore(this.scores.blue, this.scores.orange);

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

  _enterGoalState() {
    this.state = 'goal';
    this.goalResetTime = GAME.GOAL_RESET_TIME;

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
    this.hud.showReplayIndicator(true);

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

    // In multiplayer, apply deferred countdown from server
    if (this.mode !== 'singleplayer' && this._deferredCountdown) {
      const data = this._deferredCountdown;
      this._deferredCountdown = null;
      this._applyCountdown(data);
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

    // Destroy subsystems
    if (this.cameraSettings) {
      this.cameraSettings.destroy();
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
