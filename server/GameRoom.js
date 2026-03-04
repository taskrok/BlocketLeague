// ============================================
// GameRoom — Server-side room orchestration for 1v1 match
// Authoritative physics, state machine, broadcast
// ============================================

import * as CANNON from 'cannon-es';
import {
  PHYSICS, BALL as BALL_CONST, SPAWNS, GAME,
  NETWORK, COLLISION_GROUPS, CAR as CAR_CONST, DEMOLITION,
} from '../shared/constants.js';
import { computeBallHitImpulse } from '../shared/BallHitImpulse.js';
import { ServerArena } from './ServerArena.js';
import { ServerBall } from './ServerBall.js';
import { ServerCar } from './ServerCar.js';
import { ServerBoostPads } from './ServerBoostPads.js';

export class GameRoom {
  constructor(io, roomId) {
    this.io = io;
    this.roomId = roomId;
    this.players = [null, null]; // [slot 0 = blue, slot 1 = orange]
    this.state = 'waiting'; // waiting, countdown, playing, goal, overtime, ended
    this.scores = { blue: 0, orange: 0 };
    this.matchTime = GAME.MATCH_DURATION;
    this.isOvertime = false;
    this.goalResetTime = 0;
    this.tick = 0;

    this._physicsInterval = null;
    this._broadcastInterval = null;
    this._countdownInterval = null;
  }

  addPlayer(socket, variantConfig) {
    const slot = this.players[0] === null ? 0 : 1;
    this.players[slot] = {
      socket,
      socketId: socket.id,
      variantConfig: variantConfig || {},
      latestInput: this._emptyInput(),
      lastProcessedInput: 0,
    };
    socket.join(this.roomId);

    if (this.players[0] && this.players[1]) {
      // Both players joined — start match
      this._initPhysics();
      this._notifyJoined();
      this._startCountdown();
    } else {
      socket.emit('waiting', {});
    }

    return slot;
  }

  removePlayer(socketId) {
    this._stopLoops();

    const idx = this.players.findIndex(p => p && p.socketId === socketId);
    if (idx !== -1) {
      this.players[idx].socket.leave(this.roomId);
      this.players[idx] = null;
    }

    // Notify remaining player
    const remaining = this.players.find(p => p !== null);
    if (remaining) {
      remaining.socket.emit('opponentLeft', {});
    }
  }

  receiveInput(socketId, input) {
    const player = this.players.find(p => p && p.socketId === socketId);
    if (!player) return;
    if (input.seq <= player.lastProcessedInput) return;
    player.latestInput = input;
  }

  isFull() {
    return this.players[0] !== null && this.players[1] !== null;
  }

  isEmpty() {
    return this.players[0] === null && this.players[1] === null;
  }

  // ========== INITIALIZATION ==========

  _initPhysics() {
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, PHYSICS.GRAVITY, 0),
    });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = 10;

    // Contact materials (same as client Game._initPhysics)
    const carMaterial = this.carMaterial = new CANNON.Material('car');
    const ballMaterial = new CANNON.Material('ball');
    const wallMaterial = new CANNON.Material('wall');

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

    // Create arena, ball, cars, boost pads
    this.arena = new ServerArena(this.world);
    this.ball = new ServerBall(this.world);

    this.cars = [
      new ServerCar(this.world, SPAWNS.PLAYER1, 1),   // blue
      new ServerCar(this.world, SPAWNS.PLAYER2, -1),   // orange
    ];
    this.cars.forEach(car => { car.body.material = this.carMaterial; });

    // Psyonix-style ball hit impulse on car-ball collision
    this.ball.body.addEventListener('collide', (e) => {
      const other = e.body;
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

    // Car-car collision: demolition check
    this.cars[0].body.addEventListener('collide', (e) => {
      if (!(e.body.collisionFilterGroup & COLLISION_GROUPS.CAR)) return;
      this._handleCarDemolition(this.cars[0], this.cars[1]);
    });

    this.boostPads = new ServerBoostPads();
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

    const pos = { x: victim.body.position.x, y: victim.body.position.y, z: victim.body.position.z };
    const victimIdx = this.cars.indexOf(victim);
    victim.demolish();

    this.io.to(this.roomId).emit('demolition', {
      victimIdx,
      position: pos,
    });
  }

  _notifyJoined() {
    this.players.forEach((player, idx) => {
      const opponentIdx = idx === 0 ? 1 : 0;
      player.socket.emit('joined', {
        playerId: player.socketId,
        playerNumber: idx,
        roomId: this.roomId,
        opponentVariant: this.players[opponentIdx].variantConfig,
      });
    });
  }

  // ========== STATE MACHINE ==========

  _startCountdown() {
    this.state = 'countdown';
    let count = GAME.COUNTDOWN_DURATION;

    this.io.to(this.roomId).emit('countdown', { count });

    this._countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        this.io.to(this.roomId).emit('countdown', { count });
      } else {
        this.io.to(this.roomId).emit('countdown', { count: 0 });
        clearInterval(this._countdownInterval);
        this._countdownInterval = null;
        this.state = 'playing';
        this._startLoops();
      }
    }, 1000);
  }

  _startLoops() {
    // Clear any existing loops to prevent stacking after goal resets
    this._stopLoops();

    const physicsMs = 1000 / NETWORK.TICK_RATE;
    const broadcastMs = 1000 / NETWORK.SEND_RATE;

    this._physicsInterval = setInterval(() => this._physicsTick(), physicsMs);
    this._broadcastInterval = setInterval(() => this._broadcast(), broadcastMs);
  }

  _stopLoops() {
    if (this._physicsInterval) {
      clearInterval(this._physicsInterval);
      this._physicsInterval = null;
    }
    if (this._broadcastInterval) {
      clearInterval(this._broadcastInterval);
      this._broadcastInterval = null;
    }
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
  }

  // ========== PHYSICS TICK (60Hz) ==========

  _physicsTick() {
    if (this.state !== 'playing' && this.state !== 'overtime' && this.state !== 'goal') return;

    const dt = PHYSICS.TIMESTEP;

    // Apply inputs to cars
    this.players.forEach((player, idx) => {
      if (!player) return;
      const input = player.latestInput;

      if (this.state === 'playing' || this.state === 'overtime') {
        this.cars[idx].update(input, dt);
      }

      // Track processed input seq
      player.lastProcessedInput = input.seq || 0;

      // Clear jumpPressed after processing (edge-triggered)
      player.latestInput = { ...player.latestInput, jumpPressed: false };
    });

    // Step physics
    this.world.step(dt);

    // Clamp ball velocity/angular velocity
    this.ball.update(dt);

    // Update boost pads + demolition timers
    if (this.state === 'playing' || this.state === 'overtime') {
      this.boostPads.update(dt, this.cars);
      this.cars[0].updateDemolition(dt, SPAWNS.PLAYER1, 1);
      this.cars[1].updateDemolition(dt, SPAWNS.PLAYER2, -1);
      this._checkGoal();
      this._updateTimer(dt);
    }

    // Goal reset countdown
    if (this.state === 'goal') {
      this.goalResetTime -= dt;
      if (this.goalResetTime <= 0) {
        this._resetAfterGoal();
      }
    }

    this.tick++;
  }

  _checkGoal() {
    const goalSide = this.arena.isInGoal(this.ball.body.position);
    if (goalSide === 0) return;

    if (goalSide === 1) {
      this.scores.orange++;
    } else {
      this.scores.blue++;
    }

    const team = goalSide === 1 ? 'orange' : 'blue';
    this.io.to(this.roomId).emit('goalScored', {
      team,
      blueScore: this.scores.blue,
      orangeScore: this.scores.orange,
    });

    this.state = 'goal';
    this.goalResetTime = GAME.GOAL_RESET_TIME;

    if (this.isOvertime) {
      setTimeout(() => {
        this.state = 'ended';
        this.io.to(this.roomId).emit('gameOver', {
          blueScore: this.scores.blue,
          orangeScore: this.scores.orange,
        });
        this._stopLoops();
      }, GAME.GOAL_RESET_TIME * 1000);
    }
  }

  _updateTimer(dt) {
    if (this.isOvertime) return;

    this.matchTime -= dt;
    if (this.matchTime <= 0) {
      this.matchTime = 0;
      if (this.scores.blue === this.scores.orange) {
        this.isOvertime = true;
        this.state = 'overtime';
        this.io.to(this.roomId).emit('overtime', {});
      } else {
        this.state = 'ended';
        this.io.to(this.roomId).emit('gameOver', {
          blueScore: this.scores.blue,
          orangeScore: this.scores.orange,
        });
        this._stopLoops();
      }
    }
  }

  _resetAfterGoal() {
    // Clear demolished state + restore collision masks before reset
    for (const car of this.cars) {
      if (car.demolished) {
        car.demolished = false;
        car.respawnTimer = 0;
        car.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
      }
    }
    this.ball.reset();
    this.cars[0].reset(SPAWNS.PLAYER1, 1);
    this.cars[1].reset(SPAWNS.PLAYER2, -1);
    this.boostPads.resetAll();
    this._startCountdown();
  }

  // ========== BROADCAST (60Hz) ==========

  _broadcast() {
    const bp = this.ball.body.position;
    const bv = this.ball.body.velocity;
    const bq = this.ball.body.quaternion;

    const playersData = this.cars.map((car, idx) => {
      const p = car.body.position;
      const v = car.body.velocity;
      const q = car.body.quaternion;
      const av = car.body.angularVelocity;
      return {
        px: p.x, py: p.y, pz: p.z,
        vx: v.x, vy: v.y, vz: v.z,
        qx: q.x, qy: q.y, qz: q.z, qw: q.w,
        avx: av.x, avy: av.y, avz: av.z,
        boost: car.boost,
        demolished: car.demolished,
        lastProcessedInput: this.players[idx] ? this.players[idx].lastProcessedInput : 0,
      };
    });

    const gameState = {
      tick: this.tick,
      ball: {
        px: bp.x, py: bp.y, pz: bp.z,
        vx: bv.x, vy: bv.y, vz: bv.z,
        qx: bq.x, qy: bq.y, qz: bq.z, qw: bq.w,
      },
      players: playersData,
      boostPads: this.boostPads.getActiveBitmask(),
      score: { blue: this.scores.blue, orange: this.scores.orange },
      timer: this.matchTime,
      state: this.state,
    };

    this.io.to(this.roomId).emit('gameState', gameState);
  }

  // ========== HELPERS ==========

  _emptyInput() {
    return {
      seq: 0,
      throttle: 0,
      steer: 0,
      jump: false,
      jumpPressed: false,
      boost: false,
      airRoll: 0,
      pitchUp: false,
      pitchDown: false,
      handbrake: false,
      dodgeForward: 0,
      dodgeSteer: 0,
    };
  }
}
