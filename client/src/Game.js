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
import { Ball } from './Ball.js';
import { BoostPads } from './BoostPads.js';
import { InputManager } from './InputManager.js';
import { CameraController } from './Camera.js';
import { HUD } from './HUD.js';
import {
  PHYSICS, ARENA as ARENA_CONST, BALL as BALL_CONST,
  COLORS, SPAWNS, GAME, CAR as CAR_CONST, COLLISION_GROUPS,
  NETWORK,
} from '../../shared/constants.js';

export class Game {
  constructor(canvas, mode = 'singleplayer', networkManager = null) {
    this.canvas = canvas;
    this.mode = mode;
    this.network = networkManager;

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
    this.opponentCar = null;

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

    this.clock = new THREE.Clock();
    this.accumulator = 0;

    this._loop();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
    });
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
        restitution: 0.8,
        friction: 0.3,
      }
    ));

    this.world.addContactMaterial(new CANNON.ContactMaterial(
      carMaterial, wallMaterial, {
        restitution: 0.1,
        friction: 0.8,
      }
    ));

    this.world.defaultContactMaterial.restitution = 0.3;
    this.world.defaultContactMaterial.friction = 0.0;
  }

  // ========== SINGLE-PLAYER SCENE INIT ==========

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050510);
    this.scene.fog = new THREE.Fog(0x050510, 100, 210);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 250
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

    const playerVariant = generateCarVariant(COLORS.CYAN);
    const opponentVariant = generateCarVariant(COLORS.ORANGE);

    this.playerCar = new Car(
      this.scene, this.world,
      SPAWNS.PLAYER1, COLORS.CYAN, 1,
      this.arena.trimeshBody, playerVariant
    );

    this.opponentCar = new Car(
      this.scene, this.world,
      SPAWNS.PLAYER2, COLORS.ORANGE, -1,
      this.arena.trimeshBody, opponentVariant
    );

    this.boostPads = new BoostPads(this.scene);
  }

  // ========== MULTIPLAYER SCENE INIT ==========

  _initSceneMultiplayer() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050510);
    this.scene.fog = new THREE.Fog(0x050510, 100, 210);

    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 250
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
    this.hud.showStatus('Connecting...');

    this.network.on('connected', () => {
      this.hud.showStatus('Searching for opponent...');
      const variant = generateCarVariant(COLORS.CYAN);
      this._localVariant = variant;
      this.network.joinGame(variant);
    });

    this.network.on('waiting', () => {
      this.hud.showStatus('Waiting for opponent...');
    });

    this.network.on('joined', (data) => {
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
    });

    this.network.on('opponentLeft', () => {
      this.hud.showStatus('Opponent disconnected');
    });

    this.network.on('disconnected', () => {
      this.hud.showStatus('Disconnected from server');
    });

    this.network.connect();
  }

  _createMultiplayerCars(data) {
    const isBlue = data.playerNumber === 0;
    const playerSpawn = isBlue ? SPAWNS.PLAYER1 : SPAWNS.PLAYER2;
    const opponentSpawn = isBlue ? SPAWNS.PLAYER2 : SPAWNS.PLAYER1;
    const playerColor = isBlue ? COLORS.CYAN : COLORS.ORANGE;
    const opponentColor = isBlue ? COLORS.ORANGE : COLORS.CYAN;
    const playerDir = isBlue ? 1 : -1;
    const opponentDir = isBlue ? -1 : 1;

    this.playerCar = new Car(
      this.scene, this.world,
      playerSpawn, playerColor, playerDir,
      this.arena.trimeshBody, this._localVariant
    );

    this.opponentCar = new Car(
      this.scene, this.world,
      opponentSpawn, opponentColor, opponentDir,
      this.arena.trimeshBody, data.opponentVariant
    );

    // Make opponent car kinematic — moved by server state, not local physics
    this.opponentCar.body.type = CANNON.Body.KINEMATIC;
    this.opponentCar.body.updateMassProperties();

    this.cameraController.setTarget(this.playerCar);
  }

  _initPostProcessing() {
    this.composer = new EffectComposer(this.renderer);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.8, 0.4, 0.85
    );
    this.composer.addPass(bloomPass);
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
    requestAnimationFrame(() => this._loop());

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
      this.cameraController.update(dt, inputState.ballCam);
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
      this.playerCar.update(inputState, dt);
      this._updateAI(dt);
      this.boostPads.update(dt, [this.playerCar, this.opponentCar]);
      this._updateTimer(dt);
      this._checkGoal();
    } else if (this.state === 'goal') {
      this.goalResetTime -= dt;
      if (this.goalResetTime <= 0) {
        this._resetAfterGoal();
      }
    }
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
    this.opponentCar._syncMesh();
    this.ball.update(dt);

    // Animate boost pads (visual only)
    this.boostPads.update(dt, []);
  }

  // ========== RECONCILIATION ==========

  _reconcile(snapshot) {
    if (!this.playerCar || this.playerNumber < 0) return;

    const myState = snapshot.players[this.playerNumber];
    if (!myState) return;

    // Discard inputs already processed by server
    this.network.clearPendingInputsBefore(myState.lastProcessedInput);

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
    if (!this.opponentCar) return;

    const opponentIdx = this.playerNumber === 0 ? 1 : 0;
    const opponentData = interpState.players[opponentIdx];

    if (opponentData) {
      // Set opponent car body position/quaternion/velocity
      this.opponentCar.body.position.set(opponentData.px, opponentData.py, opponentData.pz);
      this.opponentCar.body.velocity.set(opponentData.vx, opponentData.vy, opponentData.vz);
      this.opponentCar.body.quaternion.set(opponentData.qx, opponentData.qy, opponentData.qz, opponentData.qw);
      this.opponentCar.body.angularVelocity.set(opponentData.avx, opponentData.avy, opponentData.avz);
      this.opponentCar.boost = opponentData.boost;
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
    this.ball.reset();
    this.playerCar.reset(SPAWNS.PLAYER1, 1);
    this.opponentCar.reset(SPAWNS.PLAYER2, -1);
    this._startCountdown();
  }

  // ========== AI (single-player only) ==========

  _updateAI(dt) {
    const car = this.opponentCar;
    const ballPos = this.ball.getPosition();
    const carPos = car.getPosition();

    const dx = ballPos.x - carPos.x;
    const dz = ballPos.z - carPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const forward = new CANNON.Vec3(0, 0, 1);
    car.body.quaternion.vmult(forward, forward);

    const targetAngle = Math.atan2(dx, dz);
    const euler = new CANNON.Vec3();
    car.body.quaternion.toEuler(euler);
    let angleDiff = targetAngle - euler.y;

    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    const aiInput = {
      throttle: 1,
      steer: angleDiff > 0.1 ? 1 : angleDiff < -0.1 ? -1 : 0,
      jump: false,
      jumpPressed: false,
      boost: dist > 20,
      ballCam: true,
      airRoll: 0,
      pitchUp: false,
      pitchDown: false,
      handbrake: false,
    };

    if (dist < 8 && ballPos.y > 3 && car.isGrounded) {
      aiInput.jumpPressed = true;
    }

    car.update(aiInput, dt);
  }
}
