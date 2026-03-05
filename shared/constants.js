// ============================================
// BLOCKET LEAGUE - Shared Game Constants
// ============================================

// Arena dimensions (in game units)
export const ARENA = {
  LENGTH: 237,      // Z-axis (goal to goal) — ×1.4 from 169
  WIDTH: 164,       // X-axis — ×1.4 from 117
  HEIGHT: 35,       // Y-axis — ×1.4 from 25
  WALL_THICKNESS: 2,
  GOAL_WIDTH: 34,   // ×1.4 from 24
  GOAL_HEIGHT: 18,  // ×1.4 from 13
  GOAL_DEPTH: 18,   // ×1.4 from 13
  CURVE_RADIUS: 11,      // floor/wall/ceiling transition fillet radius (×1.4)
  CORNER_RADIUS: 50,     // XZ plane vertical corner radius (×1.4)
  GOAL_EDGE_RADIUS: 4,   // fillet radius on goal opening frame (×1.4)
  GOAL_FILLET_RADIUS: 7, // interior goal fillets (must be < GH/2)
  CURVE_SEGMENTS: 16,    // segments per quarter-circle arc
  GRID_CELL_SIZE: 7,     // grid spacing in world units (scaled up)
};

// Car properties
export const CAR = {
  WIDTH: 2.58,
  HEIGHT: 1.11,
  LENGTH: 3.61,
  HITBOX_ANGLE: -0.55,          // degrees, nose tilted slightly down
  MASS: 32,
  MAX_SPEED: 44,
  BOOST_MAX_SPEED: 46,
  REVERSE_MAX_SPEED: 34,
  ACCELERATION: 36,
  BRAKE_FORCE: 70,
  TURN_SPEED: 2.8,
  JUMP_FORCE: 12,
  DOUBLE_JUMP_FORCE: 12,
  DODGE_FORCE: 20,
  DODGE_VERTICAL: 3,
  BOOST_ACCELERATION: 34,
  MAX_BOOST: 100,
  BOOST_USAGE_RATE: 33.3,     // per second
  AIR_ROLL_SPEED: 9.5,
  AIR_PITCH_SPEED: 7.5,
  AIR_YAW_SPEED: 4.0,
  GROUND_OFFSET: 0.55,        // half height - how high car sits
  JUMP_COOLDOWN: 1250,        // ms for double jump window
  SIDEWAYS_GRIP: 0.05,        // 0 = full grip, 1 = ice
  HANDBRAKE_TURN_MULTIPLIER: 1.8,  // steering multiplier while powersliding
  HANDBRAKE_GRIP: 0.06,            // sideways grip during handbrake (lower = more slide)
  LINEAR_DAMPING: 0.3,
  ANGULAR_DAMPING: 0.95,
  GROUND_RAY_LENGTH: 1.2,     // raycast distance for ground check
  WALL_STICK_FORCE: 30,       // force keeping car on walls
  MAX_ANGULAR_VELOCITY: 5.5,  // rad/s cap matching RL
  COAST_DECEL: 4,             // linear coasting deceleration (u/s²) — slow decay preserves supersonic
  AIR_THROTTLE_ACCEL: 4.0,    // forward thrust in air for aerial control
  DODGE_DURATION: 400,        // ms, snappy flip window
  DODGE_SPIN_SPEED: 15.7,     // rad/s for one rotation in 400ms (2π/0.4)
  SUPERSONIC_THRESHOLD: 44,   // matches throttle-only max — speed needed to demolish
};

// Ball properties (RL-accurate, scaled to our arena)
// RL: radius 91.25uu, mass 30kg, max 6000uu/s, gravity -650uu/s², CR 0.6, μ 0.285
export const BALL = {
  RADIUS: 1.83,                // 91.25uu scaled to arena (was 2.8)
  MASS: 5.3,                   // RL ratio: ball/car ≈ 1/6 (30kg/180kg)
  RESTITUTION: 0.6,            // RL coefficient of restitution
  FRICTION: 0.285,             // RL Coulomb friction (tangential)
  LINEAR_DAMPING: 0,           // RL: zero air drag, ball coasts indefinitely
  ANGULAR_DAMPING: 0.01,       // spin decays via surface friction, not air
  MAX_SPEED: 115,              // 6000uu/s scaled to our speed ratio
  MAX_ANGULAR_VELOCITY: 6,     // RL: 6 rad/s
};

// Boost pads (RL-accurate values, scaled to our arena)
export const BOOST_PAD = {
  SMALL_AMOUNT: 12,
  LARGE_AMOUNT: 100,
  SMALL_RESPAWN_TIME: 4,      // seconds (RL: ~4s)
  LARGE_RESPAWN_TIME: 10,     // seconds (RL: ~10s)
  SMALL_RADIUS: 2.9,          // pickup hitbox (RL: 144uu scaled)
  LARGE_RADIUS: 4.2,          // pickup hitbox (RL: 208uu scaled)
  SMALL_HEIGHT: 0.8,
  LARGE_HEIGHT: 1.5,
};

// Game rules
export const GAME = {
  MATCH_DURATION: 300,         // 5 minutes
  COUNTDOWN_DURATION: 3,
  GOAL_RESET_TIME: 3,
  OVERTIME_TEXT: 'OVERTIME',
};

// Physics
export const PHYSICS = {
  TIMESTEP: 1 / 60,
  GRAVITY: -30,
  MAX_SUBSTEPS: 3,
};

// Collision filter groups (bitmasks)
export const COLLISION_GROUPS = {
  ARENA_TRIMESH: 1,   // curved arena for ball collisions
  ARENA_BOXES: 2,     // simplified boxes for car collisions
  BALL: 4,
  CAR: 8,
};

// Network
export const NETWORK = {
  TICK_RATE: 60,               // server physics ticks per second
  SEND_RATE: 30,               // network updates per second
  INTERPOLATION_DELAY: 100,    // ms (initial, adjusted adaptively)
  MIN_INTERPOLATION_DELAY: 66, // ms (~2 send intervals, safe minimum)
  MAX_INTERPOLATION_DELAY: 200,// ms maximum adaptive delay
  SNAP_THRESHOLD: 3.0,         // position error above this = hard snap (units)
  BLEND_RATE: 0.08,            // correction offset decay per frame (gentler)
  PING_INTERVAL: 2000,         // ms between RTT measurements
};

// Boost pad positions (normalized -1 to 1 range, mapped to arena)
// RL arena: half-width=4096uu, half-length=5120uu → normalized = rl_coord / half_dim
// 6 large + 28 small = 34 pads total (matches Rocket League DFH Stadium)
export const BOOST_PAD_LAYOUT = {
  large: [
    // Back-left & back-right (RL: ±3072, ±4096)
    { x: -0.75, z: -0.80 },
    { x:  0.75, z: -0.80 },
    // Mid-left & mid-right (RL: ±3584, 0)
    { x: -0.875, z: 0 },
    { x:  0.875, z: 0 },
    // Front-left & front-right (RL: ±3072, ±4096)
    { x: -0.75, z:  0.80 },
    { x:  0.75, z:  0.80 },
  ],
  small: [
    // Center boost (RL: 0, 0)
    { x: 0, z: 0 },
    // Near-center pair (RL: ±1024, 0) — "wing" pads on midfield
    { x: -0.25, z: 0 },
    { x:  0.25, z: 0 },
    // Wide midfield (RL: ±1792, 0) — between center and large side pads
    { x: -0.4375, z: 0 },
    { x:  0.4375, z: 0 },

    // Quarter-field rows (RL y≈±1536 → z≈±0.30)
    { x: 0,     z: -0.30 },
    { x: -0.25, z: -0.30 },
    { x:  0.25, z: -0.30 },
    { x: 0,     z:  0.30 },
    { x: -0.25, z:  0.30 },
    { x:  0.25, z:  0.30 },

    // Wide quarter-field (RL: ±1792, ±1536 → ±0.4375, ±0.30)
    { x: -0.4375, z: -0.30 },
    { x:  0.4375, z: -0.30 },
    { x: -0.4375, z:  0.30 },
    { x:  0.4375, z:  0.30 },

    // Diagonal / three-quarter rows (RL y≈±3072 → z≈±0.60)
    { x: -0.25, z: -0.60 },
    { x:  0.25, z: -0.60 },
    { x: -0.25, z:  0.60 },
    { x:  0.25, z:  0.60 },

    // Near-goal center (RL: 0, ±3584 → 0, ±0.70)
    { x: 0, z: -0.70 },
    { x: 0, z:  0.70 },

    // Goal-box corners (RL: ±1024, ±4096 → ±0.25, ±0.80)
    { x: -0.25, z: -0.80 },
    { x:  0.25, z: -0.80 },
    { x: -0.25, z:  0.80 },
    { x:  0.25, z:  0.80 },
  ],
};

// Colors (neon theme)
export const COLORS = {
  CYAN: 0x00ffff,
  MAGENTA: 0xff00ff,
  ORANGE: 0xff8800,
  BLUE: 0x0088ff,
  GREEN: 0x00ff88,
  YELLOW: 0xffff00,
  WHITE: 0xffffff,
  BALL: 0xffaa00,
  FLOOR: 0x0a0a1a,
  WALL: 0x0d0d24,
  GOAL_BLUE: 0x0044ff,
  GOAL_ORANGE: 0xff4400,
  GRID: 0x00ffff,
  AMBIENT: 0x111133,
  TEAM_BLUE_BODY: 0x1144cc,
  TEAM_ORANGE_BODY: 0xcc5500,
};

// Demolition
export const DEMOLITION = {
  RESPAWN_TIME: 3,
  EXPLOSION_DURATION: 0.6,
  PARTICLE_COUNT: 20,
  PARTICLE_SPEED: 15,
  PARTICLE_LIFETIME: 0.8,
};

// Player spawn positions
export const SPAWNS = {
  // 1v1 (centered)
  PLAYER1: { x: 0, y: 2, z: -73 },
  PLAYER2: { x: 0, y: 2, z: 73 },
  // 2v2 (offset on X axis)
  TEAM_BLUE: [
    { x: -15, y: 2, z: -73 },
    { x: 15, y: 2, z: -73 },
  ],
  TEAM_ORANGE: [
    { x: -15, y: 2, z: 73 },
    { x: 15, y: 2, z: 73 },
  ],
};
