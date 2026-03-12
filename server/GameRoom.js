// ============================================
// GameRoom — Server-side room orchestration
// Supports 1v1 (2 players) and 2v2 (4 players)
// Authoritative physics, state machine, broadcast
// ============================================

import * as CANNON from 'cannon-es';
import { performance } from 'perf_hooks';
import {
  PHYSICS, BALL as BALL_CONST, SPAWNS, GAME,
  NETWORK, COLLISION_GROUPS, CAR as CAR_CONST, DEMOLITION,
} from '../shared/constants.js';
import { computeBallHitImpulse } from '../shared/BallHitImpulse.js';
import { encodeGameState } from '../shared/BinaryProtocol.js';
import { checkDemolition } from '../shared/Demolition.js';
import { ServerArena } from './ServerArena.js';
import { ServerBall } from './ServerBall.js';
import { ServerCar } from './ServerCar.js';
import { ServerBoostPads } from './ServerBoostPads.js';
import { PerformanceTracker } from '../shared/PerformanceTracker.js';
import { computeAIInput } from './ServerAI.js';

export class GameRoom {
  constructor(io, roomId, maxPlayers = 2, onCleanup = null) {
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
    this._physicsTimer = null;
    this._broadcastInterval = null;
    this._countdownInterval = null;
    this._forceCleanupTimeout = null;
    this._onCleanup = onCleanup;
    this.playerPings = new Array(maxPlayers).fill(0);

    // Cache spawn arrays to avoid re-creating every call
    this._cachedSpawns = null;

    // Body-to-car-index Map for O(1) collision lookups
    this.bodyToCarIndex = new Map();

    // Slots controlled by server-side AI bots (Set of slot indices)
    this.botSlots = new Set();
  }

  // ========== TEAM HELPERS ==========

  _getTeam(slot) {
    return slot < this.maxPlayers / 2 ? 'blue' : 'orange';
  }

  _getDirection(slot) {
    return slot < this.maxPlayers / 2 ? 1 : -1;
  }

  _getSpawns() {
    if (this._cachedSpawns) return this._cachedSpawns;
    if (this.maxPlayers === 2) {
      this._cachedSpawns = [SPAWNS.PLAYER1, SPAWNS.PLAYER2];
    } else {
      this._cachedSpawns = [...SPAWNS.TEAM_BLUE, ...SPAWNS.TEAM_ORANGE];
    }
    return this._cachedSpawns;
  }

  /**
   * Determine AI role for a bot slot: attacker (closest to ball) or support.
   * In 1v1 bots always attack. In 2v2, the bot closest to ball attacks.
   */
  _getAIRole(idx) {
    if (this.maxPlayers <= 2) return 'attacker';
    if (!this.ball) return 'attacker';

    const half = this.maxPlayers / 2;
    const isBlue = idx < half;
    const teamStart = isBlue ? 0 : half;
    const teamEnd = isBlue ? half : this.maxPlayers;

    // Find all bot slots on same team
    const teamBots = [];
    for (let i = teamStart; i < teamEnd; i++) {
      if (this.botSlots.has(i) && this.cars[i]) {
        teamBots.push(i);
      }
    }

    if (teamBots.length <= 1) return 'attacker';

    // Closest bot to ball is attacker
    const bp = this.ball.body.position;
    let closestIdx = teamBots[0];
    let closestDist = Infinity;
    for (const i of teamBots) {
      const cp = this.cars[i].body.position;
      const dx = cp.x - bp.x;
      const dz = cp.z - bp.z;
      const dist = dx * dx + dz * dz;
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }

    return idx === closestIdx ? 'attacker' : 'support';
  }

  // ========== PLAYER MANAGEMENT ==========

  addPlayer(socket, variantConfig, playerName) {
    // Find first available slot
    const slot = this.players.findIndex(p => p === null);
    if (slot === -1) return -1;

    this.players[slot] = {
      socket,
      socketId: socket.id,
      variantConfig: variantConfig || {},
      playerName: playerName || '',
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
    const idx = this.players.findIndex(p => p && p.socketId === socketId);
    if (idx === -1) return;

    const playerName = this.players[idx].playerName || `Player ${idx + 1}`;
    this.players[idx].socket.leave(this.roomId);

    // If game is in progress, replace with AI bot instead of removing
    if (this.state !== 'waiting') {
      // Mark slot as bot-controlled, keep the player entry for name/variant display
      this.players[idx].socketId = null;
      this.players[idx].socket = null;
      this.players[idx].isBot = true;
      this.players[idx].playerName = playerName + ' (Bot)';
      this.botSlots.add(idx);

      // Notify remaining human players
      const remaining = this.players.filter(p => p && p.socket);
      remaining.forEach(p => {
        p.socket.emit('playerDisconnected', {
          slot: idx,
          name: playerName,
          message: `${playerName} disconnected - replaced by bot`,
        });
      });

      // If no human players remain, stop the game loops
      if (remaining.length === 0) {
        this._stopLoops();
      }
      return;
    }

    // In waiting state, just remove the player
    this._stopLoops();
    this.players[idx] = null;
    this._broadcastLobbyState();
  }

  receiveInput(socketId, input) {
    const player = this.players.find(p => p && p.socketId === socketId);
    if (!player) return;

    // Validate seq is a reasonable number
    if (typeof input.seq !== 'number' || !isFinite(input.seq) || input.seq < 0 || input.seq > 1e9) return;
    if (input.seq <= player.lastProcessedInput) return;

    // Sanitize analog values: clamp to [-1, 1]
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, typeof v === 'number' && isFinite(v) ? v : 0));
    input.throttle = clamp(input.throttle, -1, 1);
    input.steer = clamp(input.steer, -1, 1);
    input.airRoll = clamp(input.airRoll, -1, 1);
    input.dodgeForward = clamp(input.dodgeForward, -1, 1);
    input.dodgeSteer = clamp(input.dodgeSteer, -1, 1);

    // Coerce booleans
    input.jump = !!input.jump;
    input.jumpPressed = !!input.jumpPressed;
    input.boost = !!input.boost;
    input.handbrake = !!input.handbrake;
    input.pitchUp = !!input.pitchUp;
    input.pitchDown = !!input.pitchDown;

    player.latestInput = input;
  }

  isFull() {
    return this.players.every(p => p !== null);
  }

  isEmpty() {
    // Room is empty only if no human players remain (bots don't count)
    return this.players.every(p => p === null || p.isBot);
  }

  /**
   * Fill remaining empty slots with AI bots and start the game.
   * Called by matchmaking when timeout fires with fewer players than needed.
   */
  fillWithBots(filledSlots) {
    for (let i = 0; i < this.maxPlayers; i++) {
      if (this.players[i] === null) {
        this.players[i] = {
          socket: null,
          socketId: null,
          variantConfig: {},
          playerName: `Bot ${i + 1}`,
          latestInput: this._emptyInput(),
          lastProcessedInput: 0,
          isBot: true,
        };
        this.botSlots.add(i);
      }
    }

    // Now all slots are filled, init physics and start
    if (this.players.every(p => p !== null)) {
      this._initPhysics();
      this._notifyJoined();
      this._startCountdown();
    }
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
      name: p ? p.playerName : '',
      isBot: p ? !!p.isBot : false,
    }));

    for (const p of this.players) {
      if (!p || !p.socket) continue;
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

    // Create cars for all players and build body-to-index lookup map
    const spawns = this._getSpawns();
    this.cars = [];
    this.bodyToCarIndex.clear();
    for (let i = 0; i < this.maxPlayers; i++) {
      const car = new ServerCar(this.world, spawns[i], this._getDirection(i));
      car.body.material = this.carMaterial;
      this.cars.push(car);
      this.bodyToCarIndex.set(car.body, i);
    }

    // Psyonix-style ball hit impulse on car-ball collision
    this.ball.body.addEventListener('collide', (e) => {
      const other = e.body;
      if (!(other.collisionFilterGroup & COLLISION_GROUPS.CAR)) return;

      const carIdx = this.bodyToCarIndex.has(other) ? this.bodyToCarIndex.get(other) : -1;
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
        const otherIdx = this.bodyToCarIndex.has(e.body) ? this.bodyToCarIndex.get(e.body) : -1;
        if (otherIdx < 0) return;
        // Only demolish across teams
        if (this._getTeam(i) !== this._getTeam(otherIdx)) {
          this._handleCarDemolition(this.cars[i], this.cars[otherIdx]);
        }
      });
    }

    this.boostPads = new ServerBoostPads();
    this.perfTracker = new PerformanceTracker(this.maxPlayers);
  }

  _handleCarDemolition(carA, carB) {
    const result = checkDemolition(carA, carB);
    if (!result) return;

    const { attacker, victim } = result;
    const pos = { x: victim.body.position.x, y: victim.body.position.y, z: victim.body.position.z };
    const victimIdx = this.bodyToCarIndex.get(victim.body);
    const attackerIdx = this.bodyToCarIndex.get(attacker.body);
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
      // Skip bot players (they have no socket)
      if (!player || !player.socket) return;

      const otherPlayers = this.players
        .map((p, i) => ({
          slot: i,
          variantConfig: p.variantConfig,
          team: this._getTeam(i),
          isBot: !!p.isBot,
          playerName: p.playerName || '',
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
    // Broadcast every N physics ticks instead of independent setInterval
    // This eliminates timing drift between physics and broadcast
    this._broadcastTickCounter = 0;
    this._broadcastEveryNTicks = Math.round(NETWORK.TICK_RATE / NETWORK.SEND_RATE); // 60/30 = 2

    // High-resolution timer loop using setImmediate + time accumulation
    // This prevents drift that setInterval suffers from under load
    this._physicsRunning = true;
    this._physicsLastTime = performance.now();
    this._physicsAccumulator = 0;

    const physicsLoop = () => {
      if (!this._physicsRunning) return;

      const now = performance.now();
      const elapsed = (now - this._physicsLastTime) / 1000; // seconds
      this._physicsLastTime = now;

      // Cap accumulated time to prevent spiral of death (max 5 frames of catch-up)
      this._physicsAccumulator += Math.min(elapsed, physicsMs * 5 / 1000);

      const dt = PHYSICS.TIMESTEP;
      while (this._physicsAccumulator >= dt) {
        this._physicsTick();
        this._physicsAccumulator -= dt;
      }

      this._physicsTimer = setImmediate(physicsLoop);
    };

    this._physicsTimer = setImmediate(physicsLoop);
  }

  _stopLoops() {
    this._physicsRunning = false;
    if (this._physicsTimer) {
      clearImmediate(this._physicsTimer);
      this._physicsTimer = null;
    }
    if (this._physicsInterval) {
      clearInterval(this._physicsInterval);
      this._physicsInterval = null;
    }
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
  }

  // ========== ROOM CLEANUP ==========

  /**
   * Force cleanup of this room: stops all loops, clears timeouts, and
   * invokes the cleanup callback to remove from the rooms Map.
   */
  forceCleanup() {
    this._stopLoops();
    if (this._forceCleanupTimeout) {
      clearTimeout(this._forceCleanupTimeout);
      this._forceCleanupTimeout = null;
    }
    // Notify and disconnect remaining players (skip bots with no socket)
    for (const p of this.players) {
      if (p && p.socket) {
        p.socket.emit('roomExpired', {});
        p.socket.leave(this.roomId);
      }
    }
    this.players.fill(null);
    this.botSlots.clear();
    this.bodyToCarIndex.clear();
    if (this._onCleanup) {
      this._onCleanup(this.roomId);
    }
  }

  // ========== PHYSICS TICK (60Hz) ==========

  _physicsTick() {
    if (this.state !== 'playing' && this.state !== 'overtime' && this.state !== 'goal') return;

    const dt = PHYSICS.TIMESTEP;

    // Apply inputs to cars (human players + AI bots)
    this.players.forEach((player, idx) => {
      if (!player) return;

      // Compute AI input for bot-controlled slots
      if (this.botSlots.has(idx) && (this.state === 'playing' || this.state === 'overtime')) {
        const teamDir = this._getDirection(idx);
        const role = this._getAIRole(idx);
        player.latestInput = computeAIInput(this.cars[idx], this.ball, teamDir, role);
      }

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

    // Broadcast on every Nth physics tick (synchronized, no drift)
    this._broadcastTickCounter++;
    if (this._broadcastTickCounter >= this._broadcastEveryNTicks) {
      this._broadcastTickCounter = 0;
      this._broadcast();
    }
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
        this._scheduleForceCleanup();
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
        this._scheduleForceCleanup();
      }
    }
  }

  /**
   * After a game ends, schedule a 30-second timeout to forcibly clean up
   * the room if players haven't already disconnected.
   */
  _scheduleForceCleanup() {
    if (this._forceCleanupTimeout) return;
    this._forceCleanupTimeout = setTimeout(() => {
      console.log(`Force cleaning up room ${this.roomId} (30s post-game timeout)`);
      this.forceCleanup();
    }, 30 * 1000);
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
    // Only emit if there are human players to receive it
    const hasHumans = this.players.some(p => p && p.socket);
    if (!hasHumans) return;

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
