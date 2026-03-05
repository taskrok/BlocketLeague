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
  WIDTH: 2.2,
  HEIGHT: 1.3,
  LENGTH: 3.6,
  MASS: 32,
  MAX_SPEED: 28,
  BOOST_MAX_SPEED: 46,
  ACCELERATION: 28,
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
  HANDBRAKE_TURN_MULTIPLIER: 2.5,  // steering multiplier while powersliding
  HANDBRAKE_GRIP: 0.12,            // sideways grip during handbrake (lower = more slide)
  LINEAR_DAMPING: 0.3,
  ANGULAR_DAMPING: 0.95,
  GROUND_RAY_LENGTH: 1.2,     // raycast distance for ground check
  WALL_STICK_FORCE: 30,       // force keeping car on walls
  MAX_ANGULAR_VELOCITY: 5.5,  // rad/s cap matching RL
  COAST_DECEL: 10,            // linear coasting deceleration (u/s²)
  AIR_THROTTLE_ACCEL: 4.0,    // forward thrust in air for aerial control
  DODGE_DURATION: 400,        // ms, snappy flip window
  DODGE_SPIN_SPEED: 15.7,     // rad/s for one rotation in 400ms (2π/0.4)
  SUPERSONIC_THRESHOLD: 39,   // ~85% of BOOST_MAX_SPEED — speed needed to demolish
};

// Ball properties
export const BALL = {
  RADIUS: 2.8,
  MASS: 2,
  RESTITUTION: 0.6,
  FRICTION: 0.3,
  LINEAR_DAMPING: 0.1,
  ANGULAR_DAMPING: 0.1,
  MAX_SPEED: 100,
  MAX_ANGULAR_VELOCITY: 6,
};

// Boost pads
export const BOOST_PAD = {
  SMALL_AMOUNT: 12,
  LARGE_AMOUNT: 100,
  SMALL_RESPAWN_TIME: 4,      // seconds
  LARGE_RESPAWN_TIME: 10,
  SMALL_RADIUS: 1.2,
  LARGE_RADIUS: 2.0,
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
  INTERPOLATION_DELAY: 100,    // ms (base, adjusted adaptively)
  MIN_INTERPOLATION_DELAY: 32, // ms minimum adaptive delay
  MAX_INTERPOLATION_DELAY: 200,// ms maximum adaptive delay
  SNAP_THRESHOLD: 4.0,         // position error above this = hard snap (units)
  BLEND_RATE: 0.15,            // correction offset decay per frame
  PING_INTERVAL: 2000,         // ms between RTT measurements
  INPUT_RESEND_INTERVAL: 3,    // resend unchanged input every N frames
};

// Boost pad positions (normalized -1 to 1 range, mapped to arena)
export const BOOST_PAD_LAYOUT = {
  large: [
    { x: -0.45, z: 0 },       // mid-left
    { x: 0.45, z: 0 },        // mid-right
    { x: -0.45, z: -0.7 },    // back-left
    { x: 0.45, z: -0.7 },     // back-right
    { x: -0.45, z: 0.7 },     // front-left
    { x: 0.45, z: 0.7 },      // front-right
    { x: 0, z: -0.85 },       // deep back center
    { x: 0, z: 0.85 },        // deep front center
  ],
  small: [
    // Center line
    { x: 0, z: 0 },
    { x: -0.2, z: 0 },
    { x: 0.2, z: 0 },
    { x: -0.35, z: 0 },       // wider midfield
    { x: 0.35, z: 0 },        // wider midfield
    // Quarter lines
    { x: 0, z: -0.35 },
    { x: -0.25, z: -0.35 },
    { x: 0.25, z: -0.35 },
    { x: 0, z: 0.35 },
    { x: -0.25, z: 0.35 },
    { x: 0.25, z: 0.35 },
    // Near goals
    { x: -0.15, z: -0.6 },
    { x: 0.15, z: -0.6 },
    { x: -0.15, z: 0.6 },
    { x: 0.15, z: 0.6 },
    { x: 0, z: -0.6 },        // goal center
    { x: 0, z: 0.6 },         // goal center
    // Wide positions
    { x: -0.4, z: -0.35 },
    { x: 0.4, z: -0.35 },
    { x: -0.4, z: 0.35 },
    { x: 0.4, z: 0.35 },
    // Diagonal fill
    { x: -0.3, z: -0.5 },
    { x: 0.3, z: -0.5 },
    { x: -0.3, z: 0.5 },
    { x: 0.3, z: 0.5 },
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
