// ============================================
// AmmoLoader — Initializes ammo.js for both client (browser) and server (Node.js)
// ============================================

let _Ammo = null;

export async function initAmmo() {
  if (_Ammo) return _Ammo;

  let AmmoInit;
  if (typeof window !== 'undefined') {
    // Browser: loaded via script tag in index.html
    AmmoInit = window.Ammo;
  } else {
    // Node.js: require the CJS build
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    AmmoInit = require('@enable3d/ammo-on-nodejs/ammo/ammo.cjs');
  }

  // The Ammo factory returns an object that IS Ammo but also has a .then method,
  // which makes `await` loop forever (thenable trap). Use Promise wrapper + delete .then.
  _Ammo = await new Promise((resolve) => {
    AmmoInit().then(ammo => {
      delete ammo.then;
      resolve(ammo);
    });
  });
  return _Ammo;
}

export function getAmmo() {
  if (!_Ammo) throw new Error('Ammo not initialized. Call initAmmo() first.');
  return _Ammo;
}
