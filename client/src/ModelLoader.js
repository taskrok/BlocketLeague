// ============================================
// ModelLoader - Preloads GLB car models at startup
// Singleton cache for cloning into Car instances
// ============================================

import * as THREE from 'three';
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

class ModelLoader {
  constructor() {
    this._cache = new Map();       // id → gltf.scene
    this._nameMap = new Map();     // id → display name
    this._loadedIds = [];
    this._loader = new GLTFLoader();
  }

  async preloadAll(onProgress) {
    const total = CAR_MODELS.length;
    let loaded = 0;

    const results = await Promise.allSettled(
      CAR_MODELS.map((entry) =>
        this._loader.loadAsync(entry.path).then((gltf) => {
          this._cache.set(entry.id, gltf.scene);
          this._nameMap.set(entry.id, entry.name);
          loaded++;
          if (onProgress) onProgress(loaded, total);
        })
      )
    );

    // Collect successfully loaded IDs (preserve registry order)
    this._loadedIds = CAR_MODELS
      .filter((entry) => this._cache.has(entry.id))
      .map((entry) => entry.id);

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`ModelLoader: ${failed.length}/${total} models failed to load`);
    }
  }

  getModel(id) {
    const original = this._cache.get(id);
    if (!original) return null;

    const clone = original.clone(true);

    // Deep-clone materials AND geometry so per-instance coloring works
    // (clone(true) shares geometry by reference — vertex color edits
    // would corrupt the cached original without this)
    clone.traverse((child) => {
      if (child.isMesh) {
        if (child.geometry) {
          child.geometry = child.geometry.clone();
        }
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material = child.material.map((m) => m.clone());
          } else {
            child.material = child.material.clone();
          }
        }
      }
    });

    return clone;
  }

  getModelIds() {
    return this._loadedIds.slice();
  }

  getModelName(id) {
    return this._nameMap.get(id) || id;
  }
}

export const modelLoader = new ModelLoader();
