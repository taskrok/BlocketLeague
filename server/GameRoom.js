// ============================================
// GameRoom — Server-side room orchestration
// Supports 1v1 (2 players) and 2v2 (4 players)
// Authoritative physics, state machine, broadcast
// ============================================

import * as CANNON from 'cannon-es';
import {
  PHYSICS, BALL as BALL_CONST, SPAWNS, GAME,
  NETWORK, COLLISION_GROUPS, CAR as CAR_CONST, DEMOLITION,
} from '../shared/constants.js';
import { computeBallHitImpulse } from '../shared/BallHitImpulse.js';
import { encodeGameState } from '../shared/BinaryProtocol.js';
import { ServerArena } from './ServerArena.js';
import { ServerBall } from './ServerBall.js';
import { ServerCar } from './ServerCar.js';
import { ServerBoostPads } from './ServerBoostPads.js';
import { PerformanceTracker } from '../shared/PerformanceTracker.js';

export class GameRoom {
  constructor(io, roomId, maxPlayers = 2) {
    this.io = io;
    this.roomId = roomId;
    this.maxPlayers = maxPlayers;
    this.players = new Array(maxPlayers).fill(null);
    this.state = 'waiting'; // waiting, countdown, playing, goal, overtime, ended
    this.scores = { blue: 0, orange: 0 };
    this.matchTime = GAME.MATCH_DURATION;
    this.isOvertime = false;
    this.goalResetTime = 0;
    this.tick = 0;

    this._physicsInterval = null;
    this._broadcastInterval = null;
    this._countdownInterval = null;
    this.playerPings = new Array(maxPlayers).fill(0);
  }

  // ========== TEAM HELPERS ==========

  _getTeam(slot) {
    return slot < this.maxPlayers / 2 ? 'blue' : 'orange';
  }

  _getDirection(slot) {
    return slot < this.maxPlayers / 2 ? 1 : -1;
  }

  _getSpawns() {
    if (this.maxPlayers === 2) {
      return [SPAWNS.PLAYER1, SPAWNS.PLAYER2];
    }
    return [...SPAWNS.TEAM_BLUE, ...SPAWNS.TEAM_ORANGE];
  }

  // ========== PLAYER MANAGEMENT ==========

  addPlayer(socket, variantConfig, preferredTeam) {
    let slot = -1;

    // If preferredTeam specified, try that team first
    if (preferredTeam) {
      const half = this.maxPlayers / 2;
      const start = preferredTeam === 'blue' ? 0 : half;
      const end = preferredTeam === 'blue' ? half : this.maxPlayers;
      for (let i = start; i < end; i++) {
        if (this.players[i] === null) { slot = i; break; }
      }
    }

    // Fallback to first available slot
    if (slot === -1) {
      slot = this.players.findIndex(p => p === null);
    }
    if (slot === -1) return -1;

    this.players[slot] = {
      socket,
      socketId: socket.id,
      variantConfig: variantConfig || {},
      latestInput: this._emptyInput(),
      lastProcessedInput: 0,
    };
    socket.join(this.roomId);

    // Broadcast lobby state to all players in the room
    this._broadcastLobbyState();

    if (this.players.every(p => p !== null)) {
      this._initPhysics();
      this._notifyJoined();
      this._startCountdown();
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

    // Notify remaining players
    const remaining = this.players.filter(p => p !== null);
    if (this.state === 'waiting') {
      this._broadcastLobbyState();
    } else {
      remaining.forEach(p => {
        p.socket.emit('playerLeft', { slot: idx });
      });
    }
  }

  receiveInput(socketId, input) {
    const player = this.players.find(p => p && p.socketId === socketId);
    if (!player) return;
    if (input.seq <= player.lastProcessedInput) return;
    player.latestInput = input;
  }

  isFull() {
    return this.players.every(p => p !== null);
  }

  isEmpty() {
    return this.players.every(p => p === null);
  }

  switchTeam(socketId) {
    const idx = this.players.findIndex(p => p && p.socketId === socketId);
    if (idx === -1) return;
    if (this.state !== 'waiting') return;

    const currentTeam = this._getTeam(idx);
    const half = this.maxPlayers / 2;
    const targetStart = currentTeam === 'blue' ? half : 0;
    const targetEnd = currentTeam === 'blue' ? this.maxPlayers : half;

    for (let i = targetStart; i < targetEnd; i++) {
      if (this.players[i] === null) {
        this.players[i] = this.players[idx];
        this.players[idx] = null;
        this._broadcastLobbyState();
        return;
      }
    }
    // No empty slot on other team — ignore
  }

  _broadcastLobbyState() {
    const playerCount = this.players.filter(p => p !== null).length;
    const mode = this.maxPlayers === 4 ? '2v2' : '1v1';
    const slots = this.players.map((p, i) => ({
      slot: i,
      team: this._getTeam(i),
      filled: p !== null,
    }));

    for (const p of this.players) {
      if (!p) continue;
      const mySlot = this.players.indexOf(p);
      const personalSlots = slots.map(s => ({
        ...s,
        isYou: s.slot === mySlot,
      }));
      p.socket.emit('lobbyUpdate', {
        playerCount,
        maxPlayers: this.maxPlayers,
        mode,
        slots: personalSlots,
      });
    }
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

    // Create arena, ball
    this.arena = new ServerArena(this.world);

    // Assign wall material to all static arena bodies so ball-wall
    // contact material (restitution 0.6, friction 0.14) is used
    this.world.bodies.forEach(b => {
      if (b.type === CANNON.Body.STATIC && !b.material) {
        b.material = wallMaterial;
      }
    });

    this.ball = new ServerBall(this.world);
    this.ball.body.material = ballMaterial; // Must use same instance as contact materials

    // Create cars for all players
    const spawns = this._getSpawns();
    this.cars = [];
    for (let i = 0; i < this.maxPlayers; i++) {
      const car = new ServerCar(this.world, spawns[i], this._getDirection(i));
      car.body.material = this.carMaterial;
      this.cars.push(car);
    }

    // Psyonix-style ball hit impulse on car-ball collision
    this.ball.body.addEventListener('collide', (e) => {
      const other = e.body;
      if (!(other.collisionFilterGroup & COLLISION_GROUPS.CAR)) return;

      const carIdx = this.cars.findIndex(c => c.body === other);
      const car = carIdx >= 0 ? this.cars[carIdx] : null;
      const ballPos = this.ball.body.position;
      const ballVel = this.ball.body.velocity;
      const carPos = other.position;
      const carVel = other.velocity;
      const carForward = other.quaternion.vmult(new CANNON.Vec3(0, 0, 1));

      // Record touch BEFORE impulse
      if (carIdx >= 0) {
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

      // Finalize touch AFTER impulse
      if (carIdx >= 0) {
        this.perfTracker.finalizePendingTouch(this.ball.body.velocity);
      }
    });

    // Car-car collision: demolition check (all pairs, cross-team only)
    for (let i = 0; i < this.cars.length; i++) {
      this.cars[i].body.addEventListener('collide', (e) => {
        if (!(e.body.collisionFilterGroup & COLLISION_GROUPS.CAR)) return;
        const otherCar = this.cars.find(c => c.body === e.body);
        if (!otherCar) return;
        const otherIdx = this.cars.indexOf(otherCar);
        // Only demolish across teams
        if (this._getTeam(i) !== this._getTeam(otherIdx)) {
          this._handleCarDemolition(this.cars[i], otherCar);
        }
      });
    }

    this.boostPads = new ServerBoostPads();
    this.perfTracker = new PerformanceTracker(this.maxPlayers);
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
    const attackerIdx = this.cars.indexOf(attacker);
    victim.demolish();

    this.perfTracker.recordDemolition(attackerIdx);

    this.io.to(this.roomId).emit('demolition', {
      victimIdx,
      attackerIdx,
      position: pos,
    });
  }

  _notifyJoined() {
    const spawns = this._getSpawns();
    this.players.forEach((player, idx) => {
      const otherPlayers = this.players
        .map((p, i) => ({
          slot: i,
          variantConfig: p.variantConfig,
          team: this._getTeam(i),
        }))
        .filter((_, i) => i !== idx);

      player.socket.emit('joined', {
        playerId: player.socketId,
        playerNumber: idx,
        roomId: this.roomId,
        maxPlayers: this.maxPlayers,
        team: this._getTeam(idx),
        otherPlayers,
        spawns,
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

    // Update perf tracker time, boost pads + demolition timers
    if (this.state === 'playing' || this.state === 'overtime') {
      this.perfTracker.setMatchTime(GAME.MATCH_DURATION - this.matchTime);
      this.boostPads.update(dt, this.cars);
      const spawns = this._getSpawns();
      for (let i = 0; i < this.cars.length; i++) {
        this.cars[i].updateDemolition(dt, spawns[i], this._getDirection(i));
      }
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
    const { scorerIdx, assistIdx } = this.perfTracker.recordGoal(goalSide);
    const bp = this.ball.body.position;
    this.io.to(this.roomId).emit('goalScored', {
      team,
      blueScore: this.scores.blue,
      orangeScore: this.scores.orange,
      scorerIdx,
      assistIdx,
      ballPos: { x: bp.x, y: bp.y, z: bp.z },
    });

    this.state = 'goal';
    // Allow time for client-side celebration (1.5s) + replay (~6.7s) + buffer
    this.goalResetTime = 9;

    if (this.isOvertime) {
      setTimeout(() => {
        this.state = 'ended';
        const winningTeam = this.scores.blue > this.scores.orange ? 'blue' : 'orange';
        const mvpIdx = this.perfTracker.computeMVP(winningTeam);
        this.io.to(this.roomId).emit('gameOver', {
          blueScore: this.scores.blue,
          orangeScore: this.scores.orange,
          stats: this.perfTracker.getStats(),
          mvpIdx,
        });
        this._stopLoops();
      }, 9 * 1000); // match goal reset time for replay
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
        const winningTeam = this.scores.blue > this.scores.orange ? 'blue' : 'orange';
        const mvpIdx = this.perfTracker.computeMVP(winningTeam);
        this.io.to(this.roomId).emit('gameOver', {
          blueScore: this.scores.blue,
          orangeScore: this.scores.orange,
          stats: this.perfTracker.getStats(),
          mvpIdx,
        });
        this._stopLoops();
      }
    }
  }

  _resetAfterGoal() {
    // Clear demolished state + restore collision masks
    for (const car of this.cars) {
      if (car.demolished) {
        car.demolished = false;
        car.respawnTimer = 0;
        car.body.collisionFilterMask = COLLISION_GROUPS.ARENA_BOXES | COLLISION_GROUPS.BALL | COLLISION_GROUPS.CAR;
      }
    }
    this.ball.reset();
    const spawns = this._getSpawns();
    for (let i = 0; i < this.cars.length; i++) {
      this.cars[i].reset(spawns[i], this._getDirection(i));
    }
    this.boostPads.resetAll();
    this.perfTracker.resetTouchHistory();
    this._startCountdown();
  }

  // ========== BROADCAST (30Hz, binary protocol) ==========

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
      boostPads: this.boostPads.getActiveBitmaskBytes(),
      score: { blue: this.scores.blue, orange: this.scores.orange },
      timer: this.matchTime,
      state: this.state,
    };

    // Binary encode + volatile emit (drops packets under pressure instead of queuing)
    const buffer = encodeGameState(gameState, this.maxPlayers);
    this.io.to(this.roomId).volatile.emit('gameState', buffer);

    // Broadcast pings ~1Hz (every 30th broadcast at 30Hz)
    if (this.tick % 60 === 0) {
      this.io.to(this.roomId).volatile.emit('playerPings', this.playerPings);
    }
  }

  // ========== HELPERS ==========

  setPlayerPing(socketId, rtt) {
    const idx = this.players.findIndex(p => p && p.socketId === socketId);
    if (idx >= 0) {
      this.playerPings[idx] = rtt;
    }
  }

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
