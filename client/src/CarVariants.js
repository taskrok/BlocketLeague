// ============================================
// CarVariants - Random variant config generator
// Produces randomized body/feature configs per car
// ============================================

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randHex(minR, maxR, minG, maxG, minB, maxB) {
  const r = randInt(minR, maxR);
  const g = randInt(minG, maxG);
  const b = randInt(minB, maxB);
  return (r << 16) | (g << 8) | b;
}

function randBool() {
  return Math.random() > 0.5;
}

function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a random car variant configuration.
 * @param {number} teamColor - Hex color for team identity (used as neon base)
 * @returns {object} variant config
 */
export function generateCarVariant(teamColor) {
  return {
    bodyColor: randHex(0, 200, 0, 200, 0, 200),
    neonColor: teamColor || randHex(50, 255, 50, 255, 50, 255),
    wheelAccentColor: randHex(30, 180, 30, 180, 30, 180),
    lightColor: randHex(155, 255, 155, 255, 155, 255),
    hasAero: randBool(),
    isLowered: randBool(),
    roofStyle: randChoice(['coupe', 'convertible']),
    doorStyle: randChoice(['normal', 'scissor']),
    hasPopupHeadlights: randBool(),
  };
}
