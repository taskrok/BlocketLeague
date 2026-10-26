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
import { saveMatch, getPlayerStats } from './database.js';
import { getRankFromMMR, getLevelTitle } from '../shared/Ranks.js';

// Debug mode: set DEBUG=1 environment variable to enable server-side perf logging
const DEBUG_MODE = process.env.DEBUG === '1';
const DEBUG_LOG_INTERVAL = 5000; // log every 5 seconds

// How often (in physics ticks) cached bot roles are recomputed (~0.5s at 60Hz)
const AI_ROLE_REFRESH_TICKS = 30;

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
    // Set when an overtime goal is scored: the goal countdown ends the match
    // (via _endGame) instead of resetting for another kickoff.
    this._pendingGameOver = false;
    this._onCleanup = onCleanup;
    this.playerPings = new Array(maxPlayers).fill(0);

    // Cached AI roles per slot ('attacker' | 'support'), refreshed every
    // AI_ROLE_REFRESH_TICKS ticks or when the bot/player list changes.
    this._aiRoles = new Array(maxPlayers).fill('attacker');
    this._aiRolesDirty = true;
    // Scratch arrays for role computation (one per team, reused)
    this._aiTeamBotsBlue = [];
    this._aiTeamBotsOrange = [];

    // Debug perf tracking
    if (DEBUG_MODE) {
      this._debugStats = {
        tickCount: 0,
        tickTimeSum: 0,
        tickTimeMax: 0,
        broadcastCount: 0,
        broadcastBytes: 0,
        lastLogTime: performance.now(),
        loopJitterSum: 0,
        loopJitterMax: 0,
        loopJitterCount: 0,
      };
    }

    // Cache spawn arrays to avoid re-creating every call
    this._cachedSpawns = null;

    // Body-to-car-index Map for O(1) collision lookups
    this.bodyToCarIndex = new Map();

    // Socket ID to slot index Map for O(1) input routing
    this.socketIdToSlot = new Map();

    // Slots controlled by server-side AI bots (Set of slot indices)
    this.botSlots = new Set();

    // Track which human players have skipped the replay
    this._replaySkips = new Set();
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
   * Roles are cached in this._aiRoles and recomputed by _refreshAIRoles().
   */
  _getAIRole(idx) {
    return this._aiRoles[idx];
  }

  /**
   * Recompute cached AI roles for every bot slot. Allocation-free: reuses
   * per-team scratch arrays. Called every AI_ROLE_REFRESH_TICKS ticks and
   * whenever the bot/player list changes (_aiRolesDirty).
   */
  _refreshAIRoles() {
    this._aiRolesDirty = false;
    const roles = this._aiRoles;
    if (this.maxPlayers <= 2 || !this.ball || !this.cars) {
      for (let i = 0; i < this.maxPlayers; i++) roles[i] = 'attacker';
      return;
    }

    const half = this.maxPlayers / 2;
    const bp = this.ball.body.position;

    for (let team = 0; team < 2; team++) {
      const teamStart = team === 0 ? 0 : half;
      const teamEnd = team === 0 ? half : this.maxPlayers;
      const teamBots = team === 0 ? this._aiTeamBotsBlue : this._aiTeamBotsOrange;
      teamBots.length = 0;

      for (let i = teamStart; i < teamEnd; i++) {
        roles[i] = 'attacker';
        if (this.botSlots.has(i) && this.cars[i]) teamBots.push(i);
      }
      if (teamBots.length <= 1) continue;

      // Closest bot to ball is attacker, the rest support
      let closestIdx = teamBots[0];
      let closestDist = Infinity;
      for (let k = 0; k < teamBots.length; k++) {
        const i = teamBots[k];
        const cp = this.cars[i].body.position;
        const dx = cp.x - bp.x;
        const dz = cp.z - bp.z;
        const dist = dx * dx + dz * dz;
        if (dist < closestDist) {
          closestDist = dist;
          closestIdx = i;
        }
      }
      for (let k = 0; k < teamBots.length; k++) {
        const i = teamBots[k];
        roles[i] = i === closestIdx ? 'attacker' : 'support';
      }
    }
  }

  // ========== PLAYER MANAGEMENT ==========

  addPlayer(socket, variantConfig, playerName, playerId) {
    // Find first available slot
    const slot = this.players.findIndex(p => p === null);
    if (slot === -1) return -1;

    this.players[slot] = {
      socket,
      socketId: socket.id,
      playerId: playerId || null,
      variantConfig: variantConfig || {},
      playerName: playerName || '',
      latestInput: this._emptyInput(),
      lastProcessedInput: 0,
    };
    this.socketIdToSlot.set(socket.id, slot);
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
    const idx = this.socketIdToSlot.get(socketId);
    if (idx === undefined) {
      // Fallback linear scan (shouldn't happen, but defensive)
      const fallbackIdx = this.players.findIndex(p => p && p.socketId === socketId);
      if (fallbackIdx === -1) return;
      return this._removePlayerByIndex(fallbackIdx, socketId);
    }
    this._removePlayerByIndex(idx, socketId);
  }

  _removePlayerByIndex(idx, socketId) {
    const playerName = this.players[idx].playerName || `Player ${idx + 1}`;
    this.players[idx].socket.leave(this.roomId);
    this.socketIdToSlot.delete(socketId);

    // If game is in progress, replace with AI bot instead of removing
    if (this.state !== 'waiting') {
      // Mark slot as bot-controlled, keep the player entry for name/variant display
      this.players[idx].socketId = null;
      this.players[idx].socket = null;
      this.players[idx].isBot = true;
      this.players[idx].playerName = playerName + ' (Bot)';
      this.botSlots.add(idx);
      this._aiRolesDirty = true;

      // Notify remaining human players (for-loop avoids .filter allocation)
      let hasHumans = false;
      for (let i = 0; i < this.maxPlayers; i++) {
        const p = this.players[i];
        if (p && p.socket) {
          hasHumans = true;
          p.socket.emit('playerDisconnected', {
            slot: idx,
            name: playerName,
            message: `${playerName} disconnected - replaced by bot`,
          });
        }
      }

      // If no human players remain, stop the game loops
      if (!hasHumans) {
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
    const slot = this.socketIdToSlot.get(socketId);
    if (slot === undefined) return;
    const player = this.players[slot];
    if (!player) return;

    // Validate seq is a reasonable number
    if (typeof input.seq !== 'number' || !isFinite(input.seq) || input.seq < 0 || input.seq > 1e9) return;
    if (input.seq <= player.lastProcessedInput) return;

    // Copy fields into the player's existing latestInput object (zero allocation).
    // This is required because decodeInput() returns a pooled/reused object.
    const li = player.latestInput;
    li.seq = input.seq;
    // Inline clamp for analog values [-1, 1] (avoids closure allocation per call)
    let v = input.throttle; li.throttle = v !== v || typeof v !== 'number' ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
    v = input.steer; li.steer = v !== v || typeof v !== 'number' ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
    v = input.airRoll; li.airRoll = v !== v || typeof v !== 'number' ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
    v = input.dodgeForward; li.dodgeForward = v !== v || typeof v !== 'number' ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
    v = input.dodgeSteer; li.dodgeSteer = v !== v || typeof v !== 'number' ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
    // Coerce booleans
    li.jump = !!input.jump;
    li.jumpPressed = !!input.jumpPressed;
    li.boost = !!input.boost;
    li.handbrake = !!input.handbrake;
    li.pitchUp = !!input.pitchUp;
    li.pitchDown = !!input.pitchDown;
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
    this._aiRolesDirty = true;

    // Now all slots are filled, init physics and start
    if (this.players.every(p => p !== null)) {
      this._initPhysics();
      this._notifyJoined();
      this._startCountdown();
    }
  }

  switchTeam(socketId) {
    const idx = this.socketIdToSlot.get(socketId);
    if (idx === undefined) return;
    if (this.state !== 'waiting') return;

    const currentTeam = this._getTeam(idx);
    const half = this.maxPlayers / 2;
    const targetStart = currentTeam === 'blue' ? half : 0;
    const targetEnd = currentTeam === 'blue' ? this.maxPlayers : half;

    for (let i = targetStart; i < targetEnd; i++) {
      if (this.players[i] === null) {
        this.players[i] = this.players[idx];
        this.players[idx] = null;
        // Update socketIdToSlot to point to the new slot
        this.socketIdToSlot.set(socketId, i);
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

    // Pre-allocated vectors for collision handler (avoids allocation per collision)
    const _collisionForward = new CANNON.Vec3();
    const _collisionZAxis = new CANNON.Vec3(0, 0, 1);

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
      other.quaternion.vmult(_collisionZAxis, _collisionForward);
      const carForward = _collisionForward;

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

    // Pre-allocate broadcast state objects (avoids allocation every 30Hz tick)
    this._initBroadcastState();
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

    // Track server time for inclusion in state broadcasts (monotonic ms).
    // Only set once on first start — preserve across goal resets so client
    // clock sync is not disrupted by server time jumping back to 0.
    if (!this._serverStartTime) {
      this._serverStartTime = performance.now();
    }

    // High-resolution timer loop using setTimeout with drift compensation
    // Unlike setImmediate (which spins the CPU at 100%), this sleeps between
    // ticks and compensates for setTimeout's ~1-4ms jitter via accumulator.
    this._physicsRunning = true;
    this._physicsLastTime = performance.now();
    this._physicsAccumulator = 0;
    this._physicsTargetTime = this._physicsLastTime + physicsMs;

    const physicsLoop = () => {
      if (!this._physicsRunning) return;

      const now = performance.now();
      const elapsed = (now - this._physicsLastTime) / 1000; // seconds
      this._physicsLastTime = now;

      // Track loop jitter (deviation from expected interval)
      if (DEBUG_MODE && this._debugStats) {
        const jitterMs = Math.abs(elapsed * 1000 - physicsMs);
        this._debugStats.loopJitterSum += jitterMs;
        this._debugStats.loopJitterCount++;
        if (jitterMs > this._debugStats.loopJitterMax) this._debugStats.loopJitterMax = jitterMs;
      }

      // Cap accumulated time to prevent spiral of death (max 5 frames of catch-up)
      this._physicsAccumulator += Math.min(elapsed, physicsMs * 5 / 1000);

      const dt = PHYSICS.TIMESTEP;
      while (this._physicsAccumulator >= dt) {
        this._physicsTick();
        this._physicsAccumulator -= dt;
      }

      // A tick may have ended the game (or otherwise stopped the loops);
      // don't reschedule a timer that _stopLoops() can no longer clear.
      if (!this._physicsRunning) return;

      // Schedule next tick with drift compensation: calculate how long until
      // the next target time, clamping to at least 1ms to avoid busy-waiting.
      // After an event-loop stall the target time can lag far behind `now`,
      // which would make every subsequent setTimeout fire at the 1ms floor
      // until it caught up (while the accumulator cap above already discarded
      // the lost time). Re-anchor the target to `now` when more than 5 ticks
      // behind so the loop returns to its nominal cadence immediately.
      this._physicsTargetTime += physicsMs;
      if (now - this._physicsTargetTime > physicsMs * 5) {
        this._physicsTargetTime = now;
      }
      const delay = Math.max(1, this._physicsTargetTime - performance.now());
      this._physicsTimer = setTimeout(physicsLoop, delay);
    };

    this._physicsTimer = setTimeout(physicsLoop, physicsMs);
  }

  _stopLoops() {
    this._physicsRunning = false;
    if (this._physicsTimer) {
      clearTimeout(this._physicsTimer);
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

    // Destroy physics world: remove all bodies and null references
    // to prevent leaking an entire CANNON.World per completed game
    if (this.world) {
      // Remove car bodies
      if (this.cars) {
        for (const car of this.cars) {
          if (car && car.body) {
            this.world.removeBody(car.body);
          }
        }
      }
      // Remove ball body
      if (this.ball && this.ball.body) {
        this.world.removeBody(this.ball.body);
      }
      // Remove all remaining bodies (arena colliders, etc.)
      // Iterate backwards since removeBody mutates the array
      const bodies = this.world.bodies;
      for (let i = bodies.length - 1; i >= 0; i--) {
        this.world.removeBody(bodies[i]);
      }
      this.world = null;
    }
    this.ball = null;
    this.cars = null;
    this.arena = null;

    this.players.fill(null);
    this.botSlots.clear();
    this.bodyToCarIndex.clear();
    this.socketIdToSlot.clear();
    if (this._onCleanup) {
      this._onCleanup(this.roomId);
    }
  }

  // ========== PHYSICS TICK (60Hz) ==========

  _physicsTick() {
    if (this.state !== 'playing' && this.state !== 'overtime' && this.state !== 'goal') return;

    const tickStart = DEBUG_MODE ? performance.now() : 0;
    const dt = PHYSICS.TIMESTEP;

    // Apply inputs to cars (human players + AI bots)
    // Uses for-loop instead of .forEach to avoid closure allocation per tick
    const isActive = this.state === 'playing' || this.state === 'overtime';

    // Refresh cached bot roles periodically or when the roster changed
    if (isActive && this.botSlots.size > 0 &&
        (this._aiRolesDirty || this.tick % AI_ROLE_REFRESH_TICKS === 0)) {
      this._refreshAIRoles();
    }

    for (let idx = 0; idx < this.maxPlayers; idx++) {
      const player = this.players[idx];
      if (!player) continue;

      // Compute AI input for bot-controlled slots, writing into the slot's
      // existing latestInput object (no per-tick allocation)
      if (this.botSlots.has(idx) && isActive) {
        const teamDir = this._getDirection(idx);
        const role = this._getAIRole(idx);
        computeAIInput(this.cars[idx], this.ball, teamDir, role, player.latestInput);
      }

      const input = player.latestInput;

      if (isActive) {
        this.cars[idx].update(input, dt);
      }

      // Track processed input seq
      player.lastProcessedInput = input.seq || 0;

      // Clear jumpPressed after processing (edge-triggered)
      // Mutate in-place instead of spread operator (avoids object allocation every tick)
      input.jumpPressed = false;
    }

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

    // Goal reset countdown. After an overtime goal the countdown ends the
    // match instead of resetting; replaySkip() shortening goalResetTime just
    // ends it sooner.
    if (this.state === 'goal') {
      this.goalResetTime -= dt;
      if (this.goalResetTime <= 0) {
        if (this._pendingGameOver) {
          this._endGame();
        } else {
          this._resetAfterGoal();
        }
      }
    }

    this.tick++;

    // Broadcast on every Nth physics tick (synchronized, no drift)
    this._broadcastTickCounter++;
    if (this._broadcastTickCounter >= this._broadcastEveryNTicks) {
      this._broadcastTickCounter = 0;
      this._broadcast();
    }

    // Debug: track tick performance
    if (DEBUG_MODE) {
      const tickMs = performance.now() - tickStart;
      const ds = this._debugStats;
      ds.tickCount++;
      ds.tickTimeSum += tickMs;
      if (tickMs > ds.tickTimeMax) ds.tickTimeMax = tickMs;

      const now = performance.now();
      if (now - ds.lastLogTime >= DEBUG_LOG_INTERVAL) {
        const avgTick = ds.tickCount > 0 ? (ds.tickTimeSum / ds.tickCount).toFixed(2) : '0';
        const avgJitter = ds.loopJitterCount > 0 ? (ds.loopJitterSum / ds.loopJitterCount).toFixed(2) : '0';
        const humans = this.players.filter(p => p && p.socket).length;
        const bots = this.botSlots.size;
        const pings = this.playerPings.filter((_, i) => this.players[i] && !this.botSlots.has(i));
        console.log(
          `[DEBUG ${this.roomId}] tick: avg=${avgTick}ms max=${ds.tickTimeMax.toFixed(2)}ms | ` +
          `broadcasts: ${ds.broadcastCount} (${ds.broadcastBytes}B) | ` +
          `loop jitter: avg=${avgJitter}ms max=${ds.loopJitterMax.toFixed(2)}ms | ` +
          `players: ${humans}h+${bots}b | pings: [${pings.map(p => p + 'ms').join(', ')}] | ` +
          `state: ${this.state} tick#${this.tick}`
        );
        ds.tickCount = 0;
        ds.tickTimeSum = 0;
        ds.tickTimeMax = 0;
        ds.broadcastCount = 0;
        ds.broadcastBytes = 0;
        ds.loopJitterSum = 0;
        ds.loopJitterMax = 0;
        ds.loopJitterCount = 0;
        ds.lastLogTime = now;
      }
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
    this._replaySkips.clear();
    // Allow time for client-side celebration (1.5s) + replay (~6.7s) + buffer
    this.goalResetTime = 9;

    // Golden goal: once the goal countdown elapses (or every human skips the
    // replay), _physicsTick ends the match rather than resetting for kickoff.
    // This is driven by the tick instead of a wall-clock timeout so that a
    // replay skip -> _resetAfterGoal -> _startLoops -> _stopLoops sequence can
    // never clear the thing that ends the game.
    if (this.isOvertime) {
      this._pendingGameOver = true;
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
        this._endGame();
      }
    }
  }

  /**
   * End the match: compute winner/MVP, emit gameOver, persist, stop loops,
   * and schedule forced cleanup. Idempotent (no-op once state is 'ended').
   */
  _endGame() {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this._pendingGameOver = false;
    const winningTeam = this.scores.blue > this.scores.orange ? 'blue' : 'orange';
    const mvpIdx = this.perfTracker.computeMVP(winningTeam);
    const stats = this.perfTracker.getStats();
    this.io.to(this.roomId).emit('gameOver', {
      blueScore: this.scores.blue,
      orangeScore: this.scores.orange,
      stats,
      mvpIdx,
    });
    this._stopLoops();
    this._scheduleForceCleanup();
    // Defer the synchronous SQLite work until after the current tick/loop
    // iteration returns. `stats` is a fresh copy from getStats() and the
    // room is ending, so nothing mutates the inputs in the meantime.
    setImmediate(() => this._saveMatchToDatabase(stats, mvpIdx));
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

  _initBroadcastState() {
    // Pre-allocate broadcast state objects to avoid GC pressure at 30Hz
    this._broadcastBall = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    this._broadcastPlayers = [];
    for (let i = 0; i < this.maxPlayers; i++) {
      this._broadcastPlayers.push({
        px: 0, py: 0, pz: 0,
        vx: 0, vy: 0, vz: 0,
        qx: 0, qy: 0, qz: 0, qw: 1,
        avx: 0, avy: 0, avz: 0,
        boost: 0, demolished: false, lastProcessedInput: 0,
      });
    }
    this._broadcastGameState = {
      tick: 0,
      ball: this._broadcastBall,
      players: this._broadcastPlayers,
      boostPads: null,
      score: { blue: 0, orange: 0 },
      timer: 0,
      state: 'playing',
      serverTime: 0,
    };
  }

  _broadcast() {
    // Check for human players first (avoid work if no one is listening)
    let hasHumans = false;
    for (let i = 0; i < this.maxPlayers; i++) {
      const p = this.players[i];
      if (p && p.socket) { hasHumans = true; break; }
    }
    if (!hasHumans) return;

    // Write ball data into pre-allocated object
    const bp = this.ball.body.position;
    const bv = this.ball.body.velocity;
    const bq = this.ball.body.quaternion;
    const bb = this._broadcastBall;
    bb.px = bp.x; bb.py = bp.y; bb.pz = bp.z;
    bb.vx = bv.x; bb.vy = bv.y; bb.vz = bv.z;
    bb.qx = bq.x; bb.qy = bq.y; bb.qz = bq.z; bb.qw = bq.w;

    // Write player data into pre-allocated objects (no .map(), no new objects)
    const playersData = this._broadcastPlayers;
    for (let idx = 0; idx < this.maxPlayers; idx++) {
      const car = this.cars[idx];
      const pd = playersData[idx];
      const cp = car.body.position;
      const cv = car.body.velocity;
      const cq = car.body.quaternion;
      const cav = car.body.angularVelocity;
      pd.px = cp.x; pd.py = cp.y; pd.pz = cp.z;
      pd.vx = cv.x; pd.vy = cv.y; pd.vz = cv.z;
      pd.qx = cq.x; pd.qy = cq.y; pd.qz = cq.z; pd.qw = cq.w;
      pd.avx = cav.x; pd.avy = cav.y; pd.avz = cav.z;
      pd.boost = car.boost;
      pd.demolished = car.demolished;
      pd.lastProcessedInput = this.players[idx] ? this.players[idx].lastProcessedInput : 0;
    }

    // Update pre-allocated game state object
    const gs = this._broadcastGameState;
    gs.tick = this.tick;
    gs.boostPads = this.boostPads.getActiveBitmaskBytes();
    gs.score.blue = this.scores.blue;
    gs.score.orange = this.scores.orange;
    gs.timer = this.matchTime;
    gs.state = this.state;
    gs.serverTime = this._serverStartTime ? (performance.now() - this._serverStartTime) / 1000 : 0;

    // Binary encode + volatile emit (drops packets under pressure instead of queuing)
    const buffer = encodeGameState(gs, this.maxPlayers);
    this.io.to(this.roomId).volatile.emit('gameState', buffer);

    if (DEBUG_MODE) {
      this._debugStats.broadcastCount++;
      this._debugStats.broadcastBytes += buffer.byteLength;
    }

    // Broadcast pings ~1Hz (every 30th broadcast at 30Hz)
    if (this.tick % 60 === 0) {
      this.io.to(this.roomId).volatile.emit('playerPings', this.playerPings);
    }
  }

  // ========== DATABASE ==========

  _saveMatchToDatabase(stats, mvpIdx) {
    try {
      const mode = this.maxPlayers === 4 ? '2v2' : '1v1';
      const mmrColumn = mode === '2v2' ? 'mmr_2v2' : 'mmr_1v1';
      const durationSeconds = Math.round(GAME.MATCH_DURATION - this.matchTime);
      const blueWon = this.scores.blue > this.scores.orange;
      const playTimeMinutes = durationSeconds / 60;

      // Read each human player's stats ONCE: used for opponent MMR now and
      // reused below to build the post-match progression payload.
      const playerMMRs = {};
      const preStats = new Array(this.maxPlayers).fill(null);
      for (let i = 0; i < this.maxPlayers; i++) {
        const p = this.players[i];
        if (!p || !p.playerId) continue;
        const pStats = getPlayerStats(p.playerId);
        preStats[i] = pStats;
        playerMMRs[i] = pStats ? (pStats[mmrColumn] || 1000) : 1000;
      }

      // Compute opponent MMR for each player
      const half = this.maxPlayers / 2;
      function getOpponentMMR(slotIdx) {
        const isBlue = slotIdx < half;
        const opponentSlots = [];
        for (let i = 0; i < half * 2; i++) {
          const slotIsBlue = i < half;
          if (slotIsBlue !== isBlue && playerMMRs[i] !== undefined) {
            opponentSlots.push(playerMMRs[i]);
          }
        }
        // If no human opponents (all bots), use the player's own MMR as baseline
        if (opponentSlots.length === 0) return playerMMRs[slotIdx] || 1000;
        // For 2v2: average opponent team MMR; for 1v1: opponent's MMR
        return Math.round(opponentSlots.reduce((a, b) => a + b, 0) / opponentSlots.length);
      }

      const players = [];
      for (let i = 0; i < this.maxPlayers; i++) {
        const p = this.players[i];
        if (!p || !p.playerId) continue; // skip bots

        const team = this._getTeam(i);
        const won = (team === 'blue' && blueWon) || (team === 'orange' && !blueWon);
        const s = stats[i] || {};

        players.push({
          playerId: p.playerId,
          team,
          goals: s.goals || 0,
          assists: s.assists || 0,
          saves: s.saves || 0,
          shots: s.shots || 0,
          demos: s.demos || 0,
          mvp: i === mvpIdx,
          won,
          aerialGoals: 0,
          playTimeMinutes,
          opponentMMR: getOpponentMMR(i),
          overtimeWin: won && this.isOvertime,
        });
      }

      if (players.length > 0) {
        const result = saveMatch({
          mode,
          durationSeconds,
          blueScore: this.scores.blue,
          orangeScore: this.scores.orange,
          isOvertime: this.isOvertime,
          players,
        });

        // Send updated progression + rank data to each human player.
        // Derived from the pre-match stats row + saveMatch's per-player
        // result (which carries the new XP/level/MMR) instead of re-reading
        // the database. Only the played mode's MMR/rank changes in a match.
        for (let i = 0; i < this.maxPlayers; i++) {
          const p = this.players[i];
          if (!p || !p.playerId || !p.socket) continue;
          const rankResult = result && result.playerResults
            ? result.playerResults[p.playerId]
            : null;
          let before = preStats[i];
          if (!before && rankResult) {
            // No stats row existed pre-match (saveMatch just created one):
            // fall back to fresh-account defaults for the unchanged fields.
            before = {
              xp: 0, level: 0, levelTitle: getLevelTitle(0),
              mmr_1v1: 1000, mmr_2v2: 1000,
              rank1v1: getRankFromMMR(1000), rank2v2: getRankFromMMR(1000),
              displayName: p.playerName || '', prestige: 0,
            };
          }
          if (before) {

            let xp = before.xp, level = before.level, levelTitle = before.levelTitle;
            let mmr1 = before.mmr_1v1, mmr2 = before.mmr_2v2;
            let rank1 = before.rank1v1, rank2 = before.rank2v2;
            if (rankResult) {
              xp = rankResult.newTotalXP;
              level = rankResult.newLevel;
              levelTitle = getLevelTitle(level || 0);
              if (mode === '2v2') {
                mmr2 = rankResult.mmrAfter;
                rank2 = getRankFromMMR(mmr2 || 1000);
              } else {
                mmr1 = rankResult.mmrAfter;
                rank1 = getRankFromMMR(mmr1 || 1000);
              }
            }

            p.socket.emit('progression', {
              xp,
              level,
              displayName: before.displayName,
              mmr_1v1: mmr1,
              mmr_2v2: mmr2,
              rank1v1: rank1,
              rank2v2: rank2,
              levelTitle,
              prestige: before.prestige || 0,
              // Match-specific rank change info
              mmrDelta: rankResult ? rankResult.mmrDelta : null,
              mmrBefore: rankResult ? rankResult.mmrBefore : null,
              mmrAfter: rankResult ? rankResult.mmrAfter : null,
              rankBefore: rankResult ? rankResult.rankBefore : null,
              rankAfter: rankResult ? rankResult.rankAfter : null,
              rankColor: rankResult ? rankResult.rankColor : null,
              xpEarned: rankResult ? rankResult.xpEarned : null,
              matchMode: mode,
            });
          }
        }
      }
    } catch (err) {
      console.error('Failed to save match to database:', err.message);
    }
  }

  // ========== HELPERS ==========

  setPlayerPing(socketId, rtt) {
    const idx = this.socketIdToSlot.get(socketId);
    if (idx !== undefined) {
      this.playerPings[idx] = rtt;
    }
  }

  replaySkip(socketId) {
    if (this.state !== 'goal') return;
    this._replaySkips.add(socketId);
    // Check if all human players have skipped
    const humanPlayers = this.players.filter((p, i) => p && !this.botSlots.has(i));
    const allSkipped = humanPlayers.every(p => this._replaySkips.has(p.socketId));
    if (allSkipped) {
      this.goalResetTime = 0; // trigger immediate reset on next tick
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
