// ============================================
// Game - Main game loop and state management
// ============================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { Arena } from './Arena.js';
import { Car } from './Car.js';
import { Ball } from './Ball.js';
import { BoostPads } from './BoostPads.js';
import { InputManager } from './InputManager.js';
import { CameraController } from './Camera.js';
import { HUD } from './HUD.js';
import {
  PHYSICS, ARENA as ARENA_CONST, BALL as BALL_CONST,
  COLORS, SPAWNS, GAME, CAR as CAR_CONST, COLLISION_GROUPS,
} from '../../shared/constants.js';

export class Game {
  constructor(canvas) {
    this.canvas = canvas;

    // Game state
    this.state = 'countdown'; // countdown, playing, goal, overtime, ended
    this.scores = { blue: 0, orange: 0 };
    this.matchTime = GAME.MATCH_DURATION;
    this.countdownTime = GAME.COUNTDOWN_DURATION;
    this.goalResetTime = 0;
    this.isOvertime = false;

    this._initRenderer();
    this._initPhysics();
    this._initScene();

    this.input = new InputManager();
    this.hud = new HUD();
    this.cameraController = new CameraController(this.camera);
    this.cameraController.setTarget(this.playerCar);
    this.cameraController.setBallTarget(this.ball);

    this._initPostProcessing();
    this._startCountdown();

    // Clock for delta time
    this.clock = new THREE.Clock();
    this.accumulator = 0;

    // Start game loop
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

    // Contact materials
    const carMaterial = new CANNON.Material('car');
    const ballMaterial = new CANNON.Material('ball');
    const wallMaterial = new CANNON.Material('wall');

    // Ball bounces off walls
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      ballMaterial, wallMaterial, {
        restitution: BALL_CONST.RESTITUTION,
        friction: BALL_CONST.FRICTION,
      }
    ));

    // Car hitting ball
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      carMaterial, ballMaterial, {
        restitution: 0.8,
        friction: 0.3,
      }
    ));

    // Car on ground
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      carMaterial, wallMaterial, {
        restitution: 0.1,
        friction: 0.8,
      }
    ));

    this.world.defaultContactMaterial.restitution = 0.3;
    this.world.defaultContactMaterial.friction = 0.0;  // Zero friction — we handle car deceleration in code
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050510);
    this.scene.fog = new THREE.Fog(0x050510, 80, 160);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 200
    );
    this.camera.position.set(0, 15, -30);

    // Arena
    this.arena = new Arena(this.scene, this.world);

    // Ball
    this.ball = new Ball(this.scene, this.world);

    // Player car (blue team, spawns at negative Z, faces +Z)
    this.playerCar = new Car(
      this.scene, this.world,
      SPAWNS.PLAYER1,
      COLORS.CYAN,
      1,
      this.arena.trimeshBody
    );

    // AI / opponent car placeholder (orange, other end)
    this.opponentCar = new Car(
      this.scene, this.world,
      SPAWNS.PLAYER2,
      COLORS.ORANGE,
      -1,
      this.arena.trimeshBody
    );

    // Boost pads
    this.boostPads = new BoostPads(this.scene);

  }

  _initPostProcessing() {
    this.composer = new EffectComposer(this.renderer);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.8,    // strength
      0.4,    // radius
      0.85    // threshold
    );
    this.composer.addPass(bloomPass);
  }

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
        this.hud.showCountdown(0); // "GO!"
        clearInterval(this._countdownInterval);
        this.state = 'playing';
      }
    }, 1000);
  }

  _loop() {
    requestAnimationFrame(() => this._loop());

    const dt = Math.min(this.clock.getDelta(), 0.05); // cap at 50ms

    // Update input
    this.input.update();
    const inputState = this.input.getState();

    // Physics always runs (so cars settle on ground during countdown)
    this.accumulator += dt;
    while (this.accumulator >= PHYSICS.TIMESTEP) {
      this.world.step(PHYSICS.TIMESTEP);
      this.accumulator -= PHYSICS.TIMESTEP;
    }

    // Always sync meshes to physics
    this.playerCar._syncMesh();
    this.opponentCar._syncMesh();
    this.ball.update(dt);

    if (this.state === 'playing' || this.state === 'overtime') {
      // Update game objects with input
      this.playerCar.update(inputState, dt);
      this._updateAI(dt);
      this.boostPads.update(dt, [this.playerCar, this.opponentCar]);

      // Match timer
      this._updateTimer(dt);

      // Goal detection
      this._checkGoal();
    } else if (this.state === 'goal') {
      this.goalResetTime -= dt;
      if (this.goalResetTime <= 0) {
        this._resetAfterGoal();
      }
    }

    // Camera always updates
    this.cameraController.update(dt, inputState.ballCam);

    // HUD updates
    this.hud.updateBoost(this.playerCar.boost);
    this.hud.updateSpeed(this.playerCar.getSpeed(), CAR_CONST.BOOST_MAX_SPEED);

    // Render
    this.composer.render();
  }

  _updateTimer(dt) {
    if (this.isOvertime) return;

    this.matchTime -= dt;
    if (this.matchTime <= 0) {
      this.matchTime = 0;
      if (this.scores.blue === this.scores.orange) {
        // Overtime
        this.isOvertime = true;
        this.state = 'overtime';
        this.hud.showOvertime();
      } else {
        // Game over
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
      // Scored in blue's goal → orange scores
      this.scores.orange++;
      this.hud.showGoalScored('orange');
    } else {
      // Scored in orange's goal → blue scores
      this.scores.blue++;
      this.hud.showGoalScored('blue');
    }

    this.hud.updateScore(this.scores.blue, this.scores.orange);
    this.state = 'goal';
    this.goalResetTime = GAME.GOAL_RESET_TIME;

    // Check overtime win
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

  _updateAI(dt) {
    // Simple AI: drive towards ball
    const car = this.opponentCar;
    const ballPos = this.ball.getPosition();
    const carPos = car.getPosition();

    const dx = ballPos.x - carPos.x;
    const dz = ballPos.z - carPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Get car's forward direction
    const forward = new CANNON.Vec3(0, 0, 1);
    car.body.quaternion.vmult(forward, forward);

    // Angle to ball
    const targetAngle = Math.atan2(dx, dz);
    const euler = new CANNON.Vec3();
    car.body.quaternion.toEuler(euler);
    let angleDiff = targetAngle - euler.y;

    // Normalize angle
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    // Create AI input
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
    };

    // Jump when close to ball and ball is higher
    if (dist < 8 && ballPos.y > 3 && car.isGrounded) {
      aiInput.jumpPressed = true;
    }

    car.update(aiInput, dt);
  }
}
