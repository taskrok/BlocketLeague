// ============================================
// Mutators — rule/physics presets for offline modes
//
// A mutator config bends a small, fixed set of knobs that the game already
// routes through single call sites: world gravity, ball shape/mass/bounce/
// speed cap, hit power, boost refill, and demolition rules. Everything not
// listed here (car handling, arena, boost pads) is deliberately untouched so
// the car still feels like the car.
//
// Only offline modes (singleplayer vs AI, free play) honour mutators today.
// Multiplayer always runs MUTATOR_DEFAULTS; GameRoom never reads this file.
// The shape lives in shared/ so a future online variant can send a preset
// id over the wire and resolve it identically on both ends.
//
// All numbers are [PLACEHOLDER] balance hypotheses — tune after playtest.
// ============================================

import { BALL, DEMOLITION } from './constants.js';

export const MUTATOR_DEFAULTS = Object.freeze({
  id: 'standard',
  name: 'Standard',
  desc: 'Regulation rules.',
  gravityScale: 1,                       // world gravity multiplier (cars + ball)
  ballRadiusScale: 1,                    // ball radius multiplier (physics + mesh)
  ballMassScale: 1,                      // ball mass multiplier
  ballRestitution: BALL.RESTITUTION,     // ball-vs-arena bounciness (0..1)
  ballMaxSpeedScale: 1,                  // ball speed cap multiplier
  hitPower: 1,                           // car->ball impulse multiplier
  unlimitedBoost: false,                 // every car pinned at MAX_BOOST
  demoOnContact: false,                  // any cross-team contact demolishes the slower car
  demoRespawnTime: DEMOLITION.RESPAWN_TIME, // seconds a demolished car waits
});

export const MUTATOR_PRESETS = [
  MUTATOR_DEFAULTS,
  Object.freeze({
    ...MUTATOR_DEFAULTS,
    id: 'moonball',
    name: 'Moon Ball',
    desc: 'Low gravity. Every jump is an aerial.',
    // 0.45: RL's Moonball is ~0.5x. Slightly lower so the float is unmistakable
    // on the very first jump, while a full-boost aerial still reaches the ceiling
    // instead of pinning cars to it.
    gravityScale: 0.45,
  }),
  Object.freeze({
    ...MUTATOR_DEFAULTS,
    id: 'beachball',
    name: 'Beach Ball',
    desc: 'Giant, light, floaty ball. Impossible to miss.',
    ballRadiusScale: 1.8,     // ~4.1u radius: taller than a car, still fits the goal mouth (GOAL_HEIGHT 18)
    ballMassScale: 0.5,       // light so it does not shove cars around on contact
    ballRestitution: 0.8,     // bouncier than regulation so it hangs in the air
    ballMaxSpeedScale: 0.75,  // big ball at full speed is unreadable; slow it down
    hitPower: 0.9,
  }),
  Object.freeze({
    ...MUTATOR_DEFAULTS,
    id: 'pinball',
    name: 'Pinball',
    desc: 'Super-bouncy, super-fast ball. Walls are bumpers.',
    ballRadiusScale: 0.85,
    ballRestitution: 1.0,     // perfectly elastic off the arena; speed cap bounds it
    ballMaxSpeedScale: 1.3,
    hitPower: 1.35,
  }),
  Object.freeze({
    ...MUTATOR_DEFAULTS,
    id: 'rocketfuel',
    name: 'Rocket Fuel',
    desc: 'Unlimited boost for everyone.',
    unlimitedBoost: true,
  }),
  Object.freeze({
    ...MUTATOR_DEFAULTS,
    id: 'demoderby',
    name: 'Demo Derby',
    desc: 'Any contact demolishes the slower car. Unlimited boost.',
    unlimitedBoost: true,
    demoOnContact: true,
    demoRespawnTime: 1.5,     // short so a demo is a setback, not a timeout
  }),
  Object.freeze({
    ...MUTATOR_DEFAULTS,
    id: 'chaos',
    name: 'Total Chaos',
    desc: 'Low gravity, big bouncy ball, unlimited boost, contact demos.',
    gravityScale: 0.55,
    ballRadiusScale: 1.4,
    ballRestitution: 0.95,
    ballMaxSpeedScale: 1.1,
    hitPower: 1.2,
    unlimitedBoost: true,
    demoOnContact: true,
    demoRespawnTime: 1.5,
  }),
];

// Minimum attacker speed for a contact demolition. Stops two idling cars at
// kickoff (or a car resting against another) from trading demos for free.
export const DEMO_CONTACT_MIN_SPEED = 8; // [PLACEHOLDER]

/** Preset by id, or null when unknown. */
export function getMutatorPreset(id) {
  for (let i = 0; i < MUTATOR_PRESETS.length; i++) {
    if (MUTATOR_PRESETS[i].id === id) return MUTATOR_PRESETS[i];
  }
  return null;
}

/**
 * Resolve a preset id or partial config into a complete, frozen config.
 * Anything falsy or unknown resolves to MUTATOR_DEFAULTS, so callers can pass
 * `options.mutators` straight through without guarding.
 */
export function resolveMutators(idOrConfig) {
  if (!idOrConfig) return MUTATOR_DEFAULTS;
  if (typeof idOrConfig === 'string') return getMutatorPreset(idOrConfig) || MUTATOR_DEFAULTS;
  if (typeof idOrConfig === 'object') {
    const merged = { ...MUTATOR_DEFAULTS };
    for (const k of Object.keys(MUTATOR_DEFAULTS)) {
      if (k === 'id' || k === 'name' || k === 'desc') {
        if (typeof idOrConfig[k] === 'string') merged[k] = idOrConfig[k];
      } else if (typeof idOrConfig[k] === typeof MUTATOR_DEFAULTS[k] && idOrConfig[k] === idOrConfig[k]) {
        merged[k] = idOrConfig[k];
      }
    }
    if (merged.id === MUTATOR_DEFAULTS.id && !isStandardMutators(merged)) merged.id = 'custom';
    return Object.freeze(merged);
  }
  return MUTATOR_DEFAULTS;
}

/** True when every physics/rule knob is at its regulation value. */
export function isStandardMutators(m) {
  if (!m) return true;
  return m.gravityScale === 1
    && m.ballRadiusScale === 1
    && m.ballMassScale === 1
    && m.ballRestitution === BALL.RESTITUTION
    && m.ballMaxSpeedScale === 1
    && m.hitPower === 1
    && !m.unlimitedBoost
    && !m.demoOnContact
    && m.demoRespawnTime === DEMOLITION.RESPAWN_TIME;
}
