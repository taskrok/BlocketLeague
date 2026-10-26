// ============================================
// ModelLoader - Loads GLB car models on demand
// Singleton cache for cloning into Car instances.
// Models load lazily via ensureLoaded(); preloadAll() streams the rest in
// the background. Cached scenes are the shared master copies: getModel()
// clones the object tree and materials but shares geometry (nothing writes
// to geometry attributes after cloning; body recoloring swaps the texture
// on the cloned material in CarMeshBuilder._recolorBodyTexture).
// ============================================

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const CAR_MODELS = [
  // Kenney cars
  { id: 'sedan', name: 'Sedan', path: 'models/sedan.glb' },
  { id: 'sedan-sports', name: 'Sports Sedan', path: 'models/sedan-sports.glb' },
  { id: 'hatchback-sports', name: 'Sports Hatch', path: 'models/hatchback-sports.glb' },
  { id: 'race', name: 'Racer', path: 'models/race.glb' },
  { id: 'race-future', name: 'Future Racer', path: 'models/race-future.glb' },
  { id: 'suv', name: 'SUV', path: 'models/suv.glb' },
  { id: 'suv-luxury', name: 'Luxury SUV', path: 'models/suv-luxury.glb' },
  { id: 'taxi', name: 'Taxi', path: 'models/taxi.glb' },
  { id: 'police', name: 'Police', path: 'models/police.glb' },
  { id: 'van', name: 'Van', path: 'models/van.glb' },
  { id: 'truck', name: 'Truck', path: 'models/truck.glb' },
  { id: 'ambulance', name: 'Ambulance', path: 'models/ambulance.glb' },
  { id: 'firetruck', name: 'Firetruck', path: 'models/firetruck.glb' },
  { id: 'garbage-truck', name: 'Garbage Truck', path: 'models/garbage-truck.glb' },
  { id: 'delivery', name: 'Delivery', path: 'models/delivery.glb' },
  { id: 'delivery-flat', name: 'Flatbed', path: 'models/delivery-flat.glb' },
  { id: 'truck-flat', name: 'Flat Truck', path: 'models/truck-flat.glb' },
  { id: 'tractor', name: 'Tractor', path: 'models/tractor.glb' },
  { id: 'tractor-police', name: 'Police Tractor', path: 'models/tractor-police.glb' },
  { id: 'tractor-shovel', name: 'Shovel Tractor', path: 'models/tractor-shovel.glb' },
];

const MODEL_BY_ID = new Map(CAR_MODELS.map((entry) => [entry.id, entry]));

class ModelLoader {
  constructor() {
    this._cache = new Map();       // id → gltf.scene (shared master copy)
    this._nameMap = new Map(CAR_MODELS.map((entry) => [entry.id, entry.name]));
    this._promises = new Map();    // id → Promise<boolean> (cached; resolves false on failure)
    this._preloadAllPromise = null;
    this._loader = new GLTFLoader();
  }

  /**
   * Every model id in the registry, in display order, whether loaded or not.
   * Use for the lobby car list; use getModelIds() where a loaded model is required.
   */
  getAllModelIds() {
    return CAR_MODELS.map((entry) => entry.id);
  }

  /**
   * Ids of models that are loaded right now, in registry order.
   * Callers that build meshes synchronously (Game.js random AI variants) use
   * this so they never pick a model that would fall back to procedural.
   */
  getModelIds() {
    return CAR_MODELS.filter((entry) => this._cache.has(entry.id)).map((entry) => entry.id);
  }

  isLoaded(id) {
    return this._cache.has(id);
  }

  /**
   * Load one model if needed. Returns a cached promise per id that resolves
   * to true when the model is available and false if it failed or is unknown.
   * Never rejects.
   */
  ensureLoaded(id) {
    if (!id) return Promise.resolve(false);
    if (this._cache.has(id)) return Promise.resolve(true);

    const existing = this._promises.get(id);
    if (existing) return existing;

    const entry = MODEL_BY_ID.get(id);
    if (!entry) return Promise.resolve(false);

    const promise = this._loader.loadAsync(entry.path).then(
      (gltf) => {
        this._markSharedGeometry(gltf.scene);
        this._cache.set(id, gltf.scene);
        return true;
      },
      (err) => {
        console.warn(`ModelLoader: failed to load model "${id}" (${entry.path})`, err);
        return false;
      }
    );
    this._promises.set(id, promise);
    return promise;
  }

  /**
   * Load several models; resolves true only if all of them loaded. Never rejects.
   */
  ensureLoadedAll(ids) {
    const unique = Array.from(new Set((ids || []).filter(Boolean)));
    return Promise.all(unique.map((id) => this.ensureLoaded(id)))
      .then((results) => results.every(Boolean));
  }

  /**
   * Load every registered model. Safe to call repeatedly: the first call's
   * promise is cached and returned (later onProgress callbacks are ignored).
   * onProgress(loadedOrFailed, total) counts settled models.
   */
  preloadAll(onProgress) {
    if (this._preloadAllPromise) return this._preloadAllPromise;

    const total = CAR_MODELS.length;
    let settled = 0;

    this._preloadAllPromise = Promise.all(
      CAR_MODELS.map((entry) =>
        this.ensureLoaded(entry.id).then((ok) => {
          settled++;
          if (onProgress) onProgress(settled, total);
          return ok;
        })
      )
    ).then((results) => {
      const failed = results.filter((ok) => !ok).length;
      if (failed > 0) {
        console.warn(`ModelLoader: ${failed}/${total} models failed to load`);
      }
    });

    return this._preloadAllPromise;
  }

  /**
   * Clone a loaded model for one car instance, or null if not loaded.
   * Geometry is shared with the cached master (flagged via
   * geometry.userData.isSharedGeometry so disposers can skip it); materials
   * are cloned so per-instance texture swaps don't touch the master.
   */
  getModel(id) {
    const original = this._cache.get(id);
    if (!original) return null;

    const clone = original.clone(true);

    clone.traverse((child) => {
      if (child.isMesh && child.material) {
        if (Array.isArray(child.material)) {
          child.material = child.material.map((m) => m.clone());
        } else {
          child.material = child.material.clone();
        }
      }
    });

    return clone;
  }

  getModelName(id) {
    return this._nameMap.get(id) || id;
  }

  _markSharedGeometry(scene) {
    scene.traverse((child) => {
      if (child.isMesh && child.geometry) {
        child.geometry.userData.isSharedGeometry = true;
      }
    });
  }
}

export const modelLoader = new ModelLoader();
