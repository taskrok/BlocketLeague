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
import {
  PHYSICS, ARENA as ARENA_CONST, BALL as BALL_CONST,
  COLORS, SPAWNS, GAME, CAR as CAR_CONST, COLLISION_GROUPS,
  NETWORK, DEMOLITION,
} from '../../shared/constants.js';
import { computeBallHitImpulse } from '../../shared/BallHitImpulse.js';

// Reusable temp vector for AI euler extraction
const _aiEuler = new CANNON.Vec3();

export class Game {
  constructor(canvas, mode = 'singleplayer', networkManager = null, playerVariant = null, joinedData = null) {
    this.canvas = canvas;
    this.mode = mode;
    this.network = networkManager;
    this.playerVariant = playerVariant;
    this._joinedData = joinedData;
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

    // Explosion VFX
    this._activeExplosions = [];

    this._initRenderer();
    this._initPhysics();

    this.input = new InputManager();
    this.hud = new HUD();

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
    const opponentVariant = generateCarVariant(COLORS.ORANGE, modelIds);

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

    this._initBallCollisionHandler();
    this._initCarCollisionHandler();

    this.boostPads = new BoostPads(this.scene);
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
      this.state = 'countdown';
      this.hud.showCountdown(data.count);
      if (data.count === 0) {
        this.state = 'playing';
      }
    });

    this.network.on('gameState', (snapshot) => {
      this._reconcile(snapshot);
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
      this.state = 'goal';
    });

    this.network.on('overtime', () => {
      this.isOvertime = true;
      this.state = 'overtime';
      this.hud.showOvertime();
    });

    this.network.on('gameOver', (data) => {
      this.state = 'ended';
      this.hud.showMatchEnd(data.blueScore, data.orangeScore);
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

    this.playerCar = new Car(
      this.scene, this.world,
      spawns[mySlot], myColor, myDir,
      this.arena.trimeshBody, this._localVariant
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

      const remoteCar = new Car(
        this.scene, this.world,
        spawns[other.slot], otherColor, otherDir,
        this.arena.trimeshBody, other.variantConfig
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

      const ballPos = this.ball.body.position;
      const ballVel = this.ball.body.velocity;
      const carPos = other.position;
      const carVel = other.velocity;
      const carForward = other.quaternion.vmult(new CANNON.Vec3(0, 0, 1));

      const impulse = computeBallHitImpulse(ballPos, ballVel, carPos, carVel, carForward);

      this.ball.body.velocity.x = impulse.x;
      this.ball.body.velocity.y = impulse.y;
      this.ball.body.velocity.z = impulse.z;
    });
  }

  // ========== DEMOLITION (singleplayer) ==========

  _initCarCollisionHandler() {
    this.playerCar.body.addEventListener('collide', (e) => {
      if (!(e.body.collisionFilterGroup & COLLISION_GROUPS.CAR)) return;
      this._handleCarDemolition(this.playerCar, this.opponentCar);
    });
  }

  _handleCarDemolition(carA, carB) {
    if (carA.demolished || carB.demolished) return;

    const speedA = carA.getSpeed();
    const speedB = carB.getSpeed();

    let victim = null;

    if (speedA >= CAR_CONST.SUPERSONIC_THRESHOLD && speedA > speedB) {
      victim = carB;
    } else if (speedB >= CAR_CONST.SUPERSONIC_THRESHOLD && speedB > speedA) {
      victim = carA;
    }

    if (!victim) return;
    this._demolishCar(victim);
  }

  _demolishCar(car) {
    const pos = { x: car.body.position.x, y: car.body.position.y, z: car.body.position.z };
    const color = car === this.playerCar ? COLORS.CYAN : COLORS.ORANGE;
    car.demolish();
    this._spawnExplosion(pos, color);
    this.hud.showDemolished();
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

      // Flash: scale up and fade out
      const flashT = Math.min(ex.elapsed / DEMOLITION.EXPLOSION_DURATION, 1);
      const flashScale = 1 + flashT * 8;
      ex.flash.scale.setScalar(flashScale);
      ex.flash.material.opacity = Math.max(0, 1 - flashT);
      ex.light.intensity = Math.max(0, 5 * (1 - flashT));

      // Particles: move + gravity + fade
      const particleT = Math.min(ex.elapsed / DEMOLITION.PARTICLE_LIFETIME, 1);
      for (const p of ex.particles) {
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        p.vy -= 30 * dt; // gravity
        p.mesh.material.opacity = Math.max(0, 1 - particleT);
      }

      // Cleanup when done (shared geometry is NOT disposed — reused across explosions)
      if (ex.elapsed >= DEMOLITION.PARTICLE_LIFETIME) {
        this.scene.remove(ex.group);
        ex.flash.material.dispose();
        for (const p of ex.particles) {
          p.mesh.material.dispose();
        }
        ex.light.dispose();
        this._activeExplosions.splice(i, 1);
      }
    }
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

    // Camera always updates
    if (this.cameraController) {
      this.cameraController.update(dt, inputState.ballCam, inputState.lookX);
    }

    // HUD updates
    if (this.playerCar) {
      this.hud.updateBoost(this.playerCar.boost);
      this.hud.updateSpeed(this.playerCar.getSpeed(), CAR_CONST.BOOST_MAX_SPEED);
    }

    this.composer.render();
  }

  // ========== SINGLE-PLAYER LOOP ==========

  _loopSingleplayer(dt, inputState) {
    // Physics always runs
    this.accumulator += dt;
    while (this.accumulator >= PHYSICS.TIMESTEP) {
      this.world.step(PHYSICS.TIMESTEP);
      this.accumulator -= PHYSICS.TIMESTEP;
    }

    this.playerCar._syncMesh();
    this.opponentCar._syncMesh();
    this.ball.update(dt);

    if (this.state === 'playing' || this.state === 'overtime') {
      if (!this.playerCar.demolished) {
        this.playerCar.update(inputState, dt);
      }
      this._updateAI(dt);
      this.playerCar.updateDemolition(dt, SPAWNS.PLAYER1, 1);
      this.opponentCar.updateDemolition(dt, SPAWNS.PLAYER2, -1);
      this.boostPads.update(dt, [this.playerCar, this.opponentCar]);
      this._updateTimer(dt);
      this._checkGoal();
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

    if (this.state === 'playing' || this.state === 'overtime') {
      // Send input to server
      const input = this.network.sendInput(inputState);
      this.network.addPendingInput(input);

      // Client-side prediction: apply input locally
      this.playerCar.update(inputState, dt);

      // Step local physics for player car prediction
      this.accumulator += dt;
      while (this.accumulator >= PHYSICS.TIMESTEP) {
        this.world.step(PHYSICS.TIMESTEP);
        this.accumulator -= PHYSICS.TIMESTEP;
      }
    }

    // Interpolate remote entities (opponent + ball)
    const renderTime = performance.now() - NETWORK.INTERPOLATION_DELAY;
    const interpState = this.network.getInterpolatedState(renderTime);

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
    }

    // Sync meshes
    this.playerCar._syncMesh();
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

    // Snap local car to server state
    const body = this.playerCar.body;
    body.position.set(myState.px, myState.py, myState.pz);
    body.velocity.set(myState.vx, myState.vy, myState.vz);
    body.quaternion.set(myState.qx, myState.qy, myState.qz, myState.qw);
    body.angularVelocity.set(myState.avx, myState.avy, myState.avz);
    this.playerCar.boost = myState.boost;

    // Replay pending inputs on top of server state
    const pending = this.network.getPendingInputs();
    for (const input of pending) {
      this.playerCar.update(input, PHYSICS.TIMESTEP);
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

    // Set ball position/quaternion from interpolated data
    const ballData = interpState.ball;
    if (ballData) {
      this.ball.body.position.set(ballData.px, ballData.py, ballData.pz);
      this.ball.body.velocity.set(ballData.vx, ballData.vy, ballData.vz);
      this.ball.body.quaternion.set(ballData.qx, ballData.qy, ballData.qz, ballData.qw);
    }
  }

  _syncBoostPads(bitmask) {
    if (bitmask === undefined) return;

    for (let i = 0; i < this.boostPads.pads.length; i++) {
      const pad = this.boostPads.pads[i];
      const shouldBeActive = !!(bitmask & (1 << i));

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
        this.hud.showMatchEnd(this.scores.blue, this.scores.orange);
      }
    }

    this.hud.updateTimer(this.matchTime);
  }

  _checkGoal() {
    const goalSide = this.arena.isInGoal(this.ball.body.position);
    if (goalSide === 0) return;

    if (goalSide === 1) {
      this.scores.orange++;
      this.hud.showGoalScored('orange');
    } else {
      this.scores.blue++;
      this.hud.showGoalScored('blue');
    }

    this.hud.updateScore(this.scores.blue, this.scores.orange);
    this.state = 'goal';
    this.goalResetTime = GAME.GOAL_RESET_TIME;

    if (this.isOvertime) {
      setTimeout(() => {
        this.state = 'ended';
        this.hud.showMatchEnd(this.scores.blue, this.scores.orange);
      }, GAME.GOAL_RESET_TIME * 1000);
    }
  }

  _resetAfterGoal() {
    // Clear demolished state before reset
    for (const car of [this.playerCar, this.opponentCar]) {
      if (car.demolished) {
        car.demolished = false;
        car.respawnTimer = 0;
        car.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
        car.mesh.visible = true;
      }
    }
    this.ball.reset();
    this.playerCar.reset(SPAWNS.PLAYER1, 1);
    this.opponentCar.reset(SPAWNS.PLAYER2, -1);
    this._startCountdown();
  }

  // ========== AI (single-player only) ==========

  _updateAI(dt) {
    if (this.opponentCar.demolished) return;
    const ENEMY_GOAL_Z = -ARENA_CONST.LENGTH / 2;
    const OWN_GOAL_Z = ARENA_CONST.LENGTH / 2;
    const APPROACH_OFFSET = 12;
    const ATTACK_ANGLE_THRESHOLD = 0.4;
    const DEFENSE_Z_THRESHOLD = 30;
    const CLEAR_DIST = 15;

    const car = this.opponentCar;
    const ballPos = this.ball.getPosition();
    const ballVel = this.ball.body.velocity;
    const carPos = car.getPosition();

    const toBallX = ballPos.x - carPos.x;
    const toBallZ = ballPos.z - carPos.z;
    const distToBall = Math.sqrt(toBallX * toBallX + toBallZ * toBallZ);

    // Ideal hit direction: ball → enemy goal
    const goalDx = 0 - ballPos.x; // enemy goal center is at x=0
    const goalDz = ENEMY_GOAL_Z - ballPos.z;
    const goalDist = Math.sqrt(goalDx * goalDx + goalDz * goalDz) || 1;
    const idealDirX = goalDx / goalDist;
    const idealDirZ = goalDz / goalDist;

    // Car→ball direction (normalized)
    const toBallDist = distToBall || 1;
    const toBallNX = toBallX / toBallDist;
    const toBallNZ = toBallZ / toBallDist;

    // Dot product: how well aligned is car→ball with the ideal hit direction
    const approachDot = toBallNX * idealDirX + toBallNZ * idealDirZ;

    // Decide mode
    let mode; // 'attack', 'defend', 'rotate'
    let targetX, targetZ;

    const inDefenseZone = ballPos.z > DEFENSE_Z_THRESHOLD;
    const ballMovingToOwnGoal = ballVel.z > -5;

    if (inDefenseZone && ballMovingToOwnGoal) {
      mode = 'defend';
    } else if (approachDot > Math.cos(ATTACK_ANGLE_THRESHOLD)) {
      mode = 'attack';
    } else {
      mode = 'rotate';
    }

    // Compute target position per mode
    if (mode === 'attack') {
      // Drive through ball toward enemy goal
      targetX = ballPos.x;
      targetZ = ballPos.z;
    } else if (mode === 'defend') {
      // Get between ball and own goal, offset to push ball toward nearest sideline
      const sideSign = ballPos.x > 0 ? 1 : -1;
      if (distToBall < CLEAR_DIST) {
        // Close enough: aim to push ball sideways toward nearest wall
        targetX = ballPos.x + sideSign * 5;
        targetZ = ballPos.z - 3; // slightly toward enemy side
      } else {
        // Position between ball and own goal
        targetX = ballPos.x;
        targetZ = (ballPos.z + OWN_GOAL_Z) / 2;
      }
    } else {
      // ROTATE: drive to approach point behind ball
      // Approach point = ball + normalized(ball - enemyGoal) * APPROACH_OFFSET
      const fromGoalX = ballPos.x - 0;
      const fromGoalZ = ballPos.z - ENEMY_GOAL_Z;
      const fromGoalDist = Math.sqrt(fromGoalX * fromGoalX + fromGoalZ * fromGoalZ) || 1;
      targetX = ballPos.x + (fromGoalX / fromGoalDist) * APPROACH_OFFSET;
      targetZ = ballPos.z + (fromGoalZ / fromGoalDist) * APPROACH_OFFSET;
    }

    // Steering: angle diff to target
    const steerDx = targetX - carPos.x;
    const steerDz = targetZ - carPos.z;
    const targetAngle = Math.atan2(steerDx, steerDz);
    car.body.quaternion.toEuler(_aiEuler);
    let angleDiff = targetAngle - _aiEuler.y;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    const absAngle = Math.abs(angleDiff);

    // Throttle
    let throttle = 1;
    if (mode === 'rotate' && absAngle > 1.0) {
      throttle = 0.5; // slow down for sharp turns while rotating
    }

    // Steer
    const steer = angleDiff > 0.05 ? 1 : angleDiff < -0.05 ? -1 : 0;

    // Boost logic
    let boost = false;
    if (mode === 'attack' && absAngle < 0.3) {
      boost = true;
    } else if (mode === 'rotate' && distToBall > 30) {
      boost = true;
    } else if (mode === 'defend' && ballPos.z > OWN_GOAL_Z - 25) {
      boost = true;
    }

    // Handbrake for sharp turns
    const speed = car.body.velocity.length();
    const handbrake = absAngle > 1.2 && speed > 10;

    // Jump: only in attack mode, ball close and aerial
    let jumpPressed = false;
    if (mode === 'attack' && distToBall < 8 && ballPos.y > 3 && car.isGrounded) {
      jumpPressed = true;
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
