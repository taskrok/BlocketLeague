// ============================================
// AudioManager - Per-Car Audio System with Procedural Fallback
// Supports car-specific engine/boost sounds via Web Audio API
// Falls back to procedural synthesis if any file fails to load
// ============================================
//
// Integration points:
//
// Game.js:
//   import { audioManager } from './AudioManager.js';
//   - On car creation: audioManager.setCarModel(variantConfig.modelId);
//   - In _loop(): audioManager.setEngineSpeed(this.playerCar.getSpeed(), CAR.MAX_SPEED);
//   - In ball collision handler: audioManager.playBallHit(impulse.length());
//   - In goal scored handler: audioManager.playGoalHorn();
//   - In demolish handler: audioManager.playDemolition();
//   - In countdown: audioManager.playCountdownBeep(count === 0);
//   - In boost pad pickup: audioManager.playBoostPickup(pad.isLarge);
//   - On match start: audioManager.startCrowdAmbiance();
//   - On match end: audioManager.playMatchEnd(); audioManager.stopAll();
//   - Every frame: audioManager.updateListener(camera); audioManager.setCrowdExcitement(0..1);
//   - Ball vs arena: audioManager.playBallBounce(impactSpeed, 'floor'|'wall'|'ceiling', pos);
//   - Car vs car bump: audioManager.playCarBump(closingSpeed, pos);
//   - Save / demo: audioManager.playCrowdReaction('save' | 'demolition');
//
// main.js / settings:
//   - UI: audioManager.playUIClick(); audioManager.playUIHover();
//   - Mixer: setMasterVolume (SFX), setCrowdVolume, setMuted
//
// Mixer: masterGain -> { _sfxBus (ducked on goals), _crowdBus -> lowpass, _uiBus }
// World-space one-shots take an optional position and are 3D-panned relative to
// the camera listener; the local car's own sounds stay 2D.
//
// Car.js:
//   import { audioManager } from './AudioManager.js';
//   - When boost starts: audioManager.startBoost();
//   - When boost stops: audioManager.stopBoost();
//   - On jump: audioManager.playJump();
//   - On landing: audioManager.playLanding(impactSpeed);
//   - On dodge/flip: audioManager.playDodge();
//

const AUDIO_BASE = 'audio/';

// -------------------------------------------------------
// Car model -> audio profile mapping
// Each profile specifies a motor folder, a boost folder,
// and the number of RPM layers available in that motor set.
// -------------------------------------------------------

// Engine profiles: single best file + procedural character parameters
// Instead of crossfading N RPM layers (broken - RL motor files are mixed types),
// we loop ONE file and pitch-shift it, layered with a shaped procedural sub-bass.
const MOTOR_PROFILES = {
  octane: {
    file: 'motors/octane/rpm_08.ogg',      // largest octane file, most likely steady-state
    baseRate: 0.75,   // playback rate at idle
    maxRate: 1.4,     // playback rate at max speed
    volume: 0.07,
    // Procedural layer: balanced modern engine
    subFreq: 75,      // sub-bass fundamental at idle
    subMaxFreq: 280,  // sub-bass at max speed
    subWave: 'sawtooth',
    subVol: 0.025,
    filterFreq: 500,  // lowpass at idle
    filterMaxFreq: 1800, // lowpass at max speed
    filterQ: 1.5,
  },
  muscle: {
    file: 'motors/muscle/rpm_03.ogg',      // ~53KB, likely mid-rpm steady
    baseRate: 0.65,
    maxRate: 1.5,
    volume: 0.08,
    // Aggressive V8 rumble - lower, more distorted
    subFreq: 55,
    subMaxFreq: 220,
    subWave: 'sawtooth',
    subVol: 0.035,
    filterFreq: 350,
    filterMaxFreq: 1400,
    filterQ: 2.0,
  },
  heavy: {
    file: 'motors/heavy/rpm_06.ogg',       // 143KB, longest/most substantial
    baseRate: 0.6,
    maxRate: 1.2,
    volume: 0.08,
    // Deep diesel rumble - very low, chugging
    subFreq: 40,
    subMaxFreq: 160,
    subWave: 'square',
    subVol: 0.03,
    filterFreq: 300,
    filterMaxFreq: 900,
    filterQ: 1.8,
  },
  utility: {
    file: 'motors/utility/rpm_02.ogg',     // 98KB, most substantial utility file
    baseRate: 0.7,
    maxRate: 1.3,
    volume: 0.07,
    // Rugged utility - mid tone, some rattle
    subFreq: 50,
    subMaxFreq: 200,
    subWave: 'sawtooth',
    subVol: 0.028,
    filterFreq: 400,
    filterMaxFreq: 1200,
    filterQ: 1.6,
  },
  hotrod: {
    file: 'motors/hotrod/rpm_07.ogg',      // 125KB, good size for loop
    baseRate: 0.7,
    maxRate: 1.6,
    volume: 0.07,
    // Classic hot rod whine - higher pitched, screamy
    subFreq: 85,
    subMaxFreq: 350,
    subWave: 'sawtooth',
    subVol: 0.02,
    filterFreq: 600,
    filterMaxFreq: 2200,
    filterQ: 1.3,
  },
  standard: {
    file: 'motors/standard/rpm_04.ogg',    // consistent ~72KB, mid-range
    baseRate: 0.7,
    maxRate: 1.35,
    volume: 0.07,
    // Generic standard engine - neutral, pleasant
    subFreq: 65,
    subMaxFreq: 240,
    subWave: 'triangle',
    subVol: 0.025,
    filterFreq: 450,
    filterMaxFreq: 1600,
    filterQ: 1.4,
  },
};

const BOOST_PROFILES = {
  standard: { folder: 'boosts/standard', count: 3 },
  flame:    { folder: 'boosts/flame',    count: 3 },
  plasma:   { folder: 'boosts/plasma',   count: 3 },
  nitrous:  { folder: 'boosts/nitrous',  count: 4 },
};

// Map game car modelId -> { motor profile key, boost profile key }
const CAR_AUDIO_MAP = {
  // Street Racers / sports - aggressive muscle engine + flame boost
  'race':             { motor: 'muscle',   boost: 'flame' },
  'sedan-sports':     { motor: 'muscle',   boost: 'flame' },
  'race-future':      { motor: 'muscle',   boost: 'plasma' },
  'hatchback-sports': { motor: 'muscle',   boost: 'plasma' },

  // Heavy vehicles - deep marauder engine + nitrous boost
  'truck':            { motor: 'heavy',    boost: 'nitrous' },
  'truck-flat':       { motor: 'heavy',    boost: 'nitrous' },
  'garbage-truck':    { motor: 'heavy',    boost: 'nitrous' },
  'firetruck':        { motor: 'heavy',    boost: 'nitrous' },

  // Emergency/utility - dark rugged engine + standard boost
  'police':           { motor: 'utility',  boost: 'standard' },
  'tractor-police':   { motor: 'utility',  boost: 'standard' },
  'tractor':          { motor: 'utility',  boost: 'nitrous' },
  'tractor-shovel':   { motor: 'utility',  boost: 'nitrous' },

  // Service/delivery - hot rod engine + flame boost
  'ambulance':        { motor: 'hotrod',   boost: 'flame' },
  'delivery':         { motor: 'hotrod',   boost: 'standard' },
  'delivery-flat':    { motor: 'hotrod',   boost: 'standard' },

  // Civilian/standard - octane engine + standard boost
  'sedan':            { motor: 'octane',   boost: 'standard' },
  'suv':              { motor: 'octane',   boost: 'standard' },
  'suv-luxury':       { motor: 'octane',   boost: 'plasma' },
  'taxi':             { motor: 'standard', boost: 'standard' },
  'van':              { motor: 'standard', boost: 'standard' },
};

// Default profile for unknown car models
const DEFAULT_AUDIO = { motor: 'octane', boost: 'standard' };

// Universal SFX files (flat in audio/ directory, kept from existing setup)
const UNIVERSAL_FILES = {
  // Three intensity tiers (soft tap / medium / slam) — playBallHit indexes by tier
  ballHit:       ['ball_hit_1.ogg', 'ball_hit_2.ogg', 'ball_hit_3.ogg'],
  goalExplosion: ['goal_explosion.ogg'],
  goalStinger:   ['goal_stinger_1.ogg', 'goal_stinger_2.ogg', 'goal_stinger_3.ogg',
                  'goal_stinger_4.ogg', 'goal_stinger_5.ogg', 'goal_stinger_6.ogg'],
  carMove:       ['car_move_1.ogg', 'car_move_2.ogg', 'car_move_3.ogg',
                  'car_move_4.ogg', 'car_move_5.ogg'],
  demo:          ['demo_6.ogg'],
  impact:        ['impact_9.ogg'],
  crowd:         ['crowd_1.ogg', 'crowd_2.ogg', 'crowd_4.ogg'],
  goalEvent:     ['goal_event_1.ogg', 'goal_event_2.ogg', 'goal_event_3.ogg',
                  'goal_event_4.ogg', 'goal_event_5.ogg'],
  boostPickup:   ['boost_pickup/pickup_3.ogg', 'boost_pickup/pickup_6.ogg'],
};


class AudioManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.initialized = false;
    this._muted = false;
    this._masterVolume = 0.5;
    this._crowdVolume = 0.7;

    // Mixer buses (all children of masterGain):
    //   _sfxBus   — gameplay SFX (engine, boost, ball, bounces, demos). Ducked on goals.
    //   _crowdBus — crowd loops + reactions, user "Crowd Volume", lowpass opens with excitement
    //   _uiBus    — UI blips, countdown, whistles, goal stinger. Never ducked.
    this._sfxBus = null;
    this._crowdBus = null;
    this._crowdFilter = null;
    this._uiBus = null;

    // 3D listener (camera) throttling state
    this._listenerLastUpdateTime = -Infinity;
    this._listenerX = NaN; this._listenerY = NaN; this._listenerZ = NaN;
    this._listenerFX = 0; this._listenerFY = 0; this._listenerFZ = -1;

    // Decoded AudioBuffer storage
    this._buffers = {};          // universal: { category: [AudioBuffer, ...] }
    this._motorBuffers = {};     // per-profile: { profileKey: [AudioBuffer, ...] }
    this._boostBuffers = {};     // per-profile: { profileKey: [AudioBuffer, ...] }

    // Current car audio profile
    this._currentMotorProfile = null;  // key into MOTOR_PROFILES
    this._currentBoostProfile = null;  // key into BOOST_PROFILES
    this._currentModelId = null;

    // Engine state
    this._engineSampleSource = null;
    this._engineSampleGain = null;
    this._engineSpeed = 0;
    this._engineMode = null;     // 'hybrid' | 'procedural'
    // Engine automation throttling: last applied speed ratio + last apply time
    this._engineLastRatio = -1;
    this._engineLastUpdateTime = -Infinity;

    // Boost state
    this._boostSource = null;
    this._boostGain = null;
    this._boostActive = false;
    this._boostMode = null;

    // Wind / speed-rush layer (part of the engine graph)
    this._windSource = null;
    this._windFilter = null;
    this._windGain = null;

    // Crowd state
    this._crowdSource = null;      // base loop
    this._crowdGain = null;        // base fade in/out
    this._crowdLayerSource = null; // excitement stem (fades in near goals)
    this._crowdLayerGain = null;
    this._crowdDynGain = null;     // excitement-driven level
    this._crowdSwellGain = null;   // event swells (goals, match end)
    this._crowdActive = false;
    this._crowdLastExcitement = -1;
    this._crowdLastUpdateTime = -Infinity;

    // Noise buffer for procedural fallbacks
    this._noiseBuffer = null;

    // Throttle rapid-fire sounds (min seconds between triggers per category)
    this._lastPlayTime = {};
    this._minInterval = {
      ballHit: 0.05,
      bounce: 0.06,
      carBump: 0.12,
      jump: 0.1,
      landing: 0.08,
      dodge: 0.1,
      boostPickup: 0.05,
      demolition: 0.15,
      supersonic: 0.5,
      crowdReact: 0.8,
      ui: 0.03,
      uiHover: 0.06,
    };
    // Concurrent voice caps per category; a category at its cap drops the new trigger
    // (the newest sound is the least important thing in a pile-up of 4 identical hits).
    this._voices = {};
    this._maxVoices = {
      ballHit: 4,
      bounce: 4,
      carBump: 3,
      jump: 2,
      landing: 2,
      dodge: 2,
      boostPickup: 3,
      demolition: 2,
      supersonic: 1,
      crowdReact: 2,
      ui: 4,
      uiHover: 2,
    };
  }

  // ========== INITIALIZATION ==========

  async init() {
    if (this.initialized) return;

    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('AudioManager: Web Audio API not available', e);
      return;
    }

    // Master gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this._muted ? 0 : this._masterVolume;
    this.masterGain.connect(this.ctx.destination);

    // Mixer buses
    this._sfxBus = this.ctx.createGain();
    this._sfxBus.gain.value = 1;
    this._sfxBus.connect(this.masterGain);

    this._uiBus = this.ctx.createGain();
    this._uiBus.gain.value = 1;
    this._uiBus.connect(this.masterGain);

    // Crowd: user volume -> lowpass (closed = distant murmur, open = roaring stands) -> master
    this._crowdFilter = this.ctx.createBiquadFilter();
    this._crowdFilter.type = 'lowpass';
    this._crowdFilter.frequency.value = 1400;
    this._crowdFilter.Q.value = 0.5;
    this._crowdFilter.connect(this.masterGain);
    this._crowdBus = this.ctx.createGain();
    this._crowdBus.gain.value = this._crowdVolume;
    this._crowdBus.connect(this._crowdFilter);

    // Generate noise buffer for procedural fallbacks
    this._noiseBuffer = this._createNoiseBuffer(2);

    this.initialized = true;

    // Preload universal SFX (non-blocking)
    await this._preloadUniversal();

    // Preload the default motor + boost profile
    const profile = DEFAULT_AUDIO;
    await Promise.all([
      this._loadMotorProfile(profile.motor),
      this._loadBoostProfile(profile.boost),
    ]);
    this._currentMotorProfile = profile.motor;
    this._currentBoostProfile = profile.boost;

    // Engine starts on first setEngineSpeed() call, not here in the lobby
  }

  // ========== CAR MODEL SELECTION ==========

  /**
   * Set the active car model. Loads the appropriate engine and boost
   * sounds for this car type, crossfading the engine if already running.
   * @param {string} modelId - Car model identifier (e.g. 'race', 'police', 'sedan')
   */
  async setCarModel(modelId) {
    if (!this.initialized) {
      this._currentModelId = modelId;
      return;
    }
    if (modelId === this._currentModelId) return;
    this._currentModelId = modelId;

    const profile = CAR_AUDIO_MAP[modelId] || DEFAULT_AUDIO;
    const motorChanged = profile.motor !== this._currentMotorProfile;
    const boostChanged = profile.boost !== this._currentBoostProfile;

    // Load new profiles if needed
    const loads = [];
    if (motorChanged && !(profile.motor in this._motorBuffers)) {
      loads.push(this._loadMotorProfile(profile.motor));
    }
    if (boostChanged && !this._boostBuffers[profile.boost]) {
      loads.push(this._loadBoostProfile(profile.boost));
    }
    if (loads.length > 0) await Promise.all(loads);

    // Switch motor if changed
    if (motorChanged) {
      const wasRunning = this._engineMode !== null;
      this._stopEngine();
      this._currentMotorProfile = profile.motor;
      // Only restart if engine was already playing (avoid starting in lobby)
      if (wasRunning) this._startEngine();
    }

    // Switch boost profile (takes effect on next startBoost call)
    if (boostChanged) {
      this._currentBoostProfile = profile.boost;
    }
  }

  /**
   * Get the current audio profile info (for debugging).
   */
  getActiveProfile() {
    return {
      modelId: this._currentModelId,
      motor: this._currentMotorProfile,
      boost: this._currentBoostProfile,
    };
  }

  // ========== LOADING ==========

  async _preloadUniversal() {
    const loads = [];
    for (const [category, files] of Object.entries(UNIVERSAL_FILES)) {
      this._buffers[category] = [];
      for (const file of files) {
        const p = this._loadAudioFile(AUDIO_BASE + file)
          .then(buf => { if (buf) this._buffers[category].push(buf); })
          .catch(() => {});
        loads.push(p);
      }
    }
    await Promise.allSettled(loads);

    const loaded = Object.entries(this._buffers)
      .map(([k, v]) => `${k}:${v.length}`)
      .join(', ');
    console.log(`AudioManager: Universal buffers - ${loaded}`);
  }

  async _loadMotorProfile(profileKey) {
    if (this._motorBuffers[profileKey]) return; // already loaded

    const profile = MOTOR_PROFILES[profileKey];
    if (!profile) return;

    const url = `${AUDIO_BASE}${profile.file}`;
    const buffer = await this._loadAudioFile(url);
    this._motorBuffers[profileKey] = buffer; // single AudioBuffer or null

    console.log(`AudioManager: Motor profile '${profileKey}' loaded (${buffer ? 'ok' : 'failed, using procedural'})`);
  }

  async _loadBoostProfile(profileKey) {
    if (this._boostBuffers[profileKey]) return; // already loaded

    const profile = BOOST_PROFILES[profileKey];
    if (!profile) return;

    const buffers = [];
    const loads = [];

    for (let i = 1; i <= profile.count; i++) {
      const url = `${AUDIO_BASE}${profile.folder}/boost_${i}.ogg`;
      const p = this._loadAudioFile(url)
        .then(buf => { if (buf) buffers.push({ index: i, buffer: buf }); })
        .catch(() => {});
      loads.push(p);
    }

    await Promise.allSettled(loads);
    buffers.sort((a, b) => a.index - b.index);
    this._boostBuffers[profileKey] = buffers.map(b => b.buffer);

    console.log(`AudioManager: Boost profile '${profileKey}' loaded (${this._boostBuffers[profileKey].length} samples)`);
  }

  async _loadAudioFile(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      return await this.ctx.decodeAudioData(arrayBuffer);
    } catch (e) {
      // Silent - procedural fallback will handle it
      return null;
    }
  }

  // ========== VOLUME CONTROL ==========

  setMasterVolume(v) {
    this._masterVolume = Math.max(0, Math.min(1, v));
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(
        this._muted ? 0 : this._masterVolume,
        this.ctx.currentTime,
        0.05
      );
    }
  }

  setMuted(muted) {
    this._muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(
        muted ? 0 : this._masterVolume,
        this.ctx.currentTime,
        0.05
      );
    }
  }

  /** Crowd bus level (0-1). Multiplies the crowd loop, excitement stem and crowd reactions. */
  setCrowdVolume(v) {
    this._crowdVolume = Math.max(0, Math.min(1, v));
    if (this._crowdBus) {
      this._crowdBus.gain.setTargetAtTime(this._crowdVolume, this.ctx.currentTime, 0.05);
    }
  }

  // ========== UTILITY ==========

  /**
   * Rate-limit + voice-cap gate for one-shot categories. Returns true if the
   * sound may play. Categories without a voice cap only get the interval check.
   */
  _canPlay(type) {
    if (!this.initialized) return false;
    const now = this.ctx.currentTime;
    const minInterval = this._minInterval[type] || 0;
    if (now - (this._lastPlayTime[type] || 0) < minInterval) return false;
    const cap = this._maxVoices[type];
    if (cap !== undefined && (this._voices[type] || 0) >= cap) return false;
    this._lastPlayTime[type] = now;
    return true;
  }

  /**
   * Register a one-shot: counts a voice in `category` (if given) and, when the
   * source ends, releases the voice and disconnects the source plus every
   * node passed after it (gains, filters, panners). Null entries are skipped.
   */
  _oneShot(category, source, ...nodes) {
    if (category) this._voices[category] = (this._voices[category] || 0) + 1;
    source.onended = () => {
      source.onended = null;
      if (category) this._voices[category] = Math.max(0, (this._voices[category] || 1) - 1);
      try { source.disconnect(); } catch (_) {}
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n) { try { n.disconnect(); } catch (_) {} }
      }
    };
  }

  // ========== 3D SPATIALIZATION ==========
  // World-space one-shots (ball, bounces, demos, other cars) go through a
  // PannerNode positioned at the event; the listener follows the camera.
  // The local player's own car (engine, boost, jump) stays 2D by design.

  _makePanner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';   // cheap; HRTF costs ~10x DSP per voice
    p.distanceModel = 'inverse';
    p.refDistance = 20;              // full volume within ~camera distance
    p.maxDistance = 600;
    p.rolloffFactor = 0.45;          // far-side hits still ~30% — they're gameplay info
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    return p;
  }

  /**
   * Connect `node` to `bus`, through a panner at `position` when given.
   * Returns the panner (or null) so callers can hand it to _oneShot for cleanup.
   */
  _toBus(node, position, bus) {
    const dest = bus || this._sfxBus;
    if (position) {
      const p = this._makePanner(position);
      node.connect(p);
      p.connect(dest);
      return p;
    }
    node.connect(dest);
    return null;
  }

  /**
   * Move the audio listener to a THREE camera. Call once per frame; applies at
   * most 30 times/s and only when the camera actually moved. Allocation-free.
   */
  updateListener(camera) {
    if (!this.initialized || !camera) return;
    const t = this.ctx.currentTime;
    if (t - this._listenerLastUpdateTime < 1 / 30) return;

    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    // Camera looks down local -Z: forward = -(third basis column); up = second column
    let fx = -e[8], fy = -e[9], fz = -e[10];
    let ux = e[4], uy = e[5], uz = e[6];
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    ux /= ul; uy /= ul; uz /= ul;

    const dx = px - this._listenerX, dy = py - this._listenerY, dz = pz - this._listenerZ;
    const moved = dx * dx + dy * dy + dz * dz;
    const turned = Math.abs(fx - this._listenerFX) + Math.abs(fy - this._listenerFY) + Math.abs(fz - this._listenerFZ);
    if (moved < 0.01 && turned < 0.002) return; // NaN on first call -> false -> proceeds

    this._listenerLastUpdateTime = t;
    this._listenerX = px; this._listenerY = py; this._listenerZ = pz;
    this._listenerFX = fx; this._listenerFY = fy; this._listenerFZ = fz;

    const L = this.ctx.listener;
    if (L.positionX) {
      const tc = 0.03;
      L.positionX.setTargetAtTime(px, t, tc);
      L.positionY.setTargetAtTime(py, t, tc);
      L.positionZ.setTargetAtTime(pz, t, tc);
      L.forwardX.setTargetAtTime(fx, t, tc);
      L.forwardY.setTargetAtTime(fy, t, tc);
      L.forwardZ.setTargetAtTime(fz, t, tc);
      L.upX.setTargetAtTime(ux, t, tc);
      L.upY.setTargetAtTime(uy, t, tc);
      L.upZ.setTargetAtTime(uz, t, tc);
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  _hasBuffers(category) {
    return this._buffers[category] && this._buffers[category].length > 0;
  }

  _randomBuffer(category) {
    const buffers = this._buffers[category];
    if (!buffers || buffers.length === 0) return null;
    return buffers[Math.floor(Math.random() * buffers.length)];
  }

  _getMotorBuffer() {
    const key = this._currentMotorProfile;
    return key ? this._motorBuffers[key] || null : null;
  }

  _getMotorParams() {
    const key = this._currentMotorProfile;
    return key ? MOTOR_PROFILES[key] || MOTOR_PROFILES.standard : MOTOR_PROFILES.standard;
  }

  _getBoostBuffers() {
    const key = this._currentBoostProfile;
    return key && this._boostBuffers[key] ? this._boostBuffers[key] : [];
  }

  /**
   * Play a sample-based one-shot sound.
   */
  _playSample(buffer, opts = {}) {
    const {
      volume = 1.0,
      playbackRate = 1.0,
      loop = false,
      destination = this._sfxBus,
      fadeIn = 0.005,
      position = null,   // world position -> 3D panned; omitted -> 2D
      category = null,   // voice-count category (see _maxVoices)
    } = opts;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = playbackRate;

    const gain = this.ctx.createGain();
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + fadeIn);

    source.connect(gain);
    const panner = this._toBus(gain, position, destination);
    // One-shots tear down their own graph when they finish. Looping sources
    // never fire 'ended' until stopped, at which point the same cleanup runs.
    this._oneShot(category, source, gain, panner);
    source.start(t);

    return { source, gain };
  }

  /**
   * Disconnect a source and its gain node once the source has finished playing,
   * so finished one-shots do not linger in the audio graph.
   */
  _autoDisconnect(source, gain) {
    this._oneShot(null, source, gain);
  }

  // --- Procedural utility (fallback) ---

  _createNoiseBuffer(durationSec) {
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * durationSec;
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  _createNoiseSource() {
    const source = this.ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    source.loop = true;
    return source;
  }

  // ========== 1. ENGINE SOUND ==========
  // Single-loop sample + pitch shift, layered with shaped procedural sub-bass.
  // Each car profile defines: sample file, pitch range, sub-bass character.
  // Fallback: pure procedural if no sample loaded.

  _startEngine() {
    const buffer = this._getMotorBuffer();
    const params = this._getMotorParams();
    const t = this.ctx.currentTime;

    // --- Procedural sub-bass layer (always present, gives body) ---
    this._engineOsc = this.ctx.createOscillator();
    this._engineOsc.type = params.subWave;
    this._engineOsc.frequency.setValueAtTime(params.subFreq, t);

    // Second harmonic for richness
    this._engineSubOsc = this.ctx.createOscillator();
    this._engineSubOsc.type = 'triangle';
    this._engineSubOsc.frequency.setValueAtTime(params.subFreq * 2, t);

    this._engineFilter = this.ctx.createBiquadFilter();
    this._engineFilter.type = 'lowpass';
    this._engineFilter.frequency.setValueAtTime(params.filterFreq, t);
    this._engineFilter.Q.setValueAtTime(params.filterQ, t);

    this._engineSubGain = this.ctx.createGain();
    this._engineSubGain.gain.setValueAtTime(params.subVol, t);

    const harmGain = this.ctx.createGain();
    harmGain.gain.setValueAtTime(params.subVol * 0.4, t);
    this._engineHarmGain = harmGain;

    this._engineOsc.connect(this._engineFilter);
    this._engineSubOsc.connect(harmGain);
    harmGain.connect(this._engineFilter);
    this._engineFilter.connect(this._engineSubGain);
    this._engineSubGain.connect(this._sfxBus);

    // Tear the sub-bass graph down when _stopEngine() stops the oscillators
    this._oneShot(null, this._engineOsc, this._engineFilter, this._engineSubGain, harmGain);
    this._oneShot(null, this._engineSubOsc);

    this._engineOsc.start(t);
    this._engineSubOsc.start(t);

    // --- Wind / speed-rush layer: silent below ~55% speed, swells toward max ---
    this._windSource = this._createNoiseSource();
    this._windFilter = this.ctx.createBiquadFilter();
    this._windFilter.type = 'bandpass';
    this._windFilter.frequency.setValueAtTime(700, t);
    this._windFilter.Q.setValueAtTime(0.7, t);
    this._windGain = this.ctx.createGain();
    this._windGain.gain.setValueAtTime(0, t);
    this._windSource.connect(this._windFilter);
    this._windFilter.connect(this._windGain);
    this._windGain.connect(this._sfxBus);
    this._oneShot(null, this._windSource, this._windFilter, this._windGain);
    this._windSource.start(t);

    // --- Sample layer (if available) ---
    if (buffer) {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.playbackRate.setValueAtTime(params.baseRate, t);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(params.volume, t);

      source.connect(gain);
      gain.connect(this._sfxBus);
      this._oneShot(null, source, gain);
      source.start(t);

      this._engineSampleSource = source;
      this._engineSampleGain = gain;
      this._engineMode = 'hybrid';
    } else {
      this._engineSampleSource = null;
      this._engineSampleGain = null;
      this._engineMode = 'procedural';
    }
  }

  _stopEngine() {
    const t = this.ctx.currentTime;
    try { this._engineOsc?.stop(t + 0.05); } catch (_) {}
    try { this._engineSubOsc?.stop(t + 0.05); } catch (_) {}
    try { this._engineSampleSource?.stop(t + 0.05); } catch (_) {}
    try { this._windSource?.stop(t + 0.05); } catch (_) {}
    this._windSource = null;
    this._windFilter = null;
    this._windGain = null;
    this._engineOsc = null;
    this._engineSubOsc = null;
    this._engineSampleSource = null;
    this._engineSampleGain = null;
    this._engineSubGain = null;
    this._engineHarmGain = null;
    this._engineFilter = null;
    this._engineMode = null;
    this._engineLastRatio = -1;
    this._engineLastUpdateTime = -Infinity;
  }

  setEngineSpeed(speed, maxSpeed) {
    if (!this.initialized) return;

    // Lazy-start engine on first call
    if (!this._engineMode) {
      this._startEngine();
    }

    const ratio = Math.min(Math.abs(speed) / maxSpeed, 1);
    const t = this.ctx.currentTime;
    this._engineSpeed = speed;

    // Called every render frame: skip the ~6 automation events when the
    // ratio barely moved, and cap applies to ~30Hz. The 60ms setTargetAtTime
    // smoothing already hides the coarser update rate.
    if (Math.abs(ratio - this._engineLastRatio) < 0.005) return;
    if (t - this._engineLastUpdateTime < 1 / 30) return;
    this._engineLastRatio = ratio;
    this._engineLastUpdateTime = t;

    const params = this._getMotorParams();

    // Update procedural sub-bass pitch + filter
    if (this._engineOsc) {
      const subFreq = params.subFreq + ratio * (params.subMaxFreq - params.subFreq);
      this._engineOsc.frequency.setTargetAtTime(subFreq, t, 0.06);
      this._engineSubOsc.frequency.setTargetAtTime(subFreq * 2, t, 0.06);

      const filterFreq = params.filterFreq + ratio * (params.filterMaxFreq - params.filterFreq);
      this._engineFilter.frequency.setTargetAtTime(filterFreq, t, 0.06);

      // Sub volume increases slightly with speed
      const baseVol = this._engineMode === 'procedural' ? params.subVol * 2.5 : params.subVol;
      const vol = baseVol * (0.8 + ratio * 0.4);
      this._engineSubGain.gain.setTargetAtTime(vol, t, 0.06);
    }

    // Update sample pitch
    if (this._engineSampleSource) {
      const rate = params.baseRate + ratio * (params.maxRate - params.baseRate);
      this._engineSampleSource.playbackRate.setTargetAtTime(rate, t, 0.06);

      // Slightly increase sample volume at higher speeds
      const vol = params.volume * (0.85 + ratio * 0.3);
      this._engineSampleGain.gain.setTargetAtTime(vol, t, 0.06);
    }

    // Wind rush: quadratic fade-in above 55% speed, filter brightens with speed
    if (this._windGain) {
      const w = ratio > 0.55 ? (ratio - 0.55) / 0.45 : 0;
      this._windGain.gain.setTargetAtTime(w * w * 0.05, t, 0.08);
      this._windFilter.frequency.setTargetAtTime(700 + w * 1100, t, 0.1);
    }
  }

  // ========== 2. BOOST SOUND ==========
  // Uses 3-phase boost samples from active boost profile:
  //   File 1 = start burst, File 2 = loop sustain, File 3 = stop tail
  // If only 1 sample, loops it. Fallback: procedural noise + sine.

  startBoost() {
    if (!this.initialized || this._boostActive) return;
    this._boostActive = true;

    const boostBufs = this._getBoostBuffers();
    if (boostBufs.length >= 2) {
      this._startBoostSampled(boostBufs);
    } else {
      this._startBoostProcedural();
    }
  }

  _startBoostSampled(bufs) {
    const t = this.ctx.currentTime;

    // File 1 = start burst (one-shot on boost begin)
    // File 2 = supersonic hit (one-shot, triggered separately via playSupersonicBoost)
    // File 3 = ambient burning loop (continuous while boosting)

    // Play start burst
    if (bufs.length >= 1) {
      const startSource = this.ctx.createBufferSource();
      startSource.buffer = bufs[0];
      startSource.loop = false;

      const startGain = this.ctx.createGain();
      startGain.gain.setValueAtTime(0, t);
      startGain.gain.linearRampToValueAtTime(0.12, t + 0.03);

      startSource.connect(startGain);
      startGain.connect(this._sfxBus);
      this._autoDisconnect(startSource, startGain);
      startSource.start(t);
      this._boostStartSource = startSource;
    }

    // Start ambient burn loop (file 3), crossfade in after start burst
    if (bufs.length >= 3) {
      const loopDelay = Math.min(bufs[0].duration * 0.6, 0.12);
      const loopSource = this.ctx.createBufferSource();
      loopSource.buffer = bufs[2]; // file 3 = ambient burn
      loopSource.loop = true;

      const loopGain = this.ctx.createGain();
      loopGain.gain.setValueAtTime(0, t);
      loopGain.gain.linearRampToValueAtTime(0.07, t + loopDelay + 0.1);

      loopSource.connect(loopGain);
      loopGain.connect(this._sfxBus);
      this._autoDisconnect(loopSource, loopGain);
      loopSource.start(t + loopDelay * 0.5);

      this._boostSource = loopSource;
      this._boostGain = loopGain;
    } else if (bufs.length >= 1) {
      // Fallback: loop file 1 if no file 3
      const source = this.ctx.createBufferSource();
      source.buffer = bufs[0];
      source.loop = true;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.07, t + 0.08);

      source.connect(gain);
      gain.connect(this._sfxBus);
      this._autoDisconnect(source, gain);
      source.start(t);

      this._boostSource = source;
      this._boostGain = gain;
    }

    // Save file 2 for supersonic trigger
    this._boostSupersonicBuffer = bufs.length >= 2 ? bufs[1] : null;

    this._boostMode = 'sampled';
  }

  /**
   * Play the supersonic/warp speed boost hit sound (one-shot).
   * Called from Car.js when the car crosses the supersonic threshold while boosting.
   */
  playSupersonicBoost() {
    if (!this.initialized || !this._boostActive) return;
    if (!this._canPlay('supersonic')) return;

    if (this._boostMode === 'sampled' && this._boostSupersonicBuffer) {
      this._playSample(this._boostSupersonicBuffer, { volume: 0.3 });
    }

    // Sweetener (both modes): rising air-rip whoosh + sub "punch through" thump
    const t = this.ctx.currentTime;
    const noise = this._createNoiseSource();
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.setValueAtTime(1.2, t);
    filt.frequency.setValueAtTime(300, t);
    filt.frequency.exponentialRampToValueAtTime(2600, t + 0.3);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.12, t + 0.06);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    noise.connect(filt);
    filt.connect(ng);
    ng.connect(this._sfxBus);
    this._oneShot('supersonic', noise, filt, ng);
    noise.start(t);
    noise.stop(t + 0.45);

    const thump = this.ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(90, t + 0.05);
    thump.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const tg = this.ctx.createGain();
    tg.gain.setValueAtTime(0, t);
    tg.gain.linearRampToValueAtTime(0.14, t + 0.07);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    thump.connect(tg);
    tg.connect(this._sfxBus);
    this._oneShot(null, thump, tg);
    thump.start(t);
    thump.stop(t + 0.32);
  }

  _startBoostProcedural() {
    const t = this.ctx.currentTime;

    this._boostNoiseSource = this._createNoiseSource();
    this._boostFilter = this.ctx.createBiquadFilter();
    this._boostFilter.type = 'bandpass';
    this._boostFilter.frequency.setValueAtTime(800, t);
    this._boostFilter.Q.setValueAtTime(1.5, t);

    this._boostSineOsc = this.ctx.createOscillator();
    this._boostSineOsc.type = 'sine';
    this._boostSineOsc.frequency.setValueAtTime(55, t);

    this._boostGain = this.ctx.createGain();
    this._boostGain.gain.setValueAtTime(0, t);
    this._boostGain.gain.linearRampToValueAtTime(0.18, t + 0.08);

    const boostSineGain = this.ctx.createGain();
    boostSineGain.gain.setValueAtTime(0, t);
    boostSineGain.gain.linearRampToValueAtTime(0.10, t + 0.08);
    this._boostSineGain = boostSineGain;

    this._boostFilter.frequency.linearRampToValueAtTime(1200, t + 0.3);

    this._boostNoiseSource.connect(this._boostFilter);
    this._boostFilter.connect(this._boostGain);
    this._boostGain.connect(this._sfxBus);

    this._boostSineOsc.connect(boostSineGain);
    boostSineGain.connect(this._sfxBus);

    // Tear down the procedural chain once the sources are stopped
    const noiseSrc = this._boostNoiseSource;
    const noiseFilter = this._boostFilter;
    const noiseGain = this._boostGain;
    noiseSrc.onended = () => {
      noiseSrc.onended = null;
      try { noiseSrc.disconnect(); } catch (_) {}
      try { noiseFilter.disconnect(); } catch (_) {}
      try { noiseGain.disconnect(); } catch (_) {}
    };
    this._autoDisconnect(this._boostSineOsc, boostSineGain);

    this._boostNoiseSource.start(t);
    this._boostSineOsc.start(t);
    this._boostMode = 'procedural';
  }

  stopBoost() {
    if (!this.initialized) return;
    this._boostActive = false;

    const t = this.ctx.currentTime;
    const fadeOut = 0.08;

    // Stop ALL boost sources regardless of mode
    // Fade gain nodes
    if (this._boostGain) {
      this._boostGain.gain.cancelScheduledValues(t);
      this._boostGain.gain.setValueAtTime(this._boostGain.gain.value, t);
      this._boostGain.gain.linearRampToValueAtTime(0, t + fadeOut);
    }
    if (this._boostSineGain) {
      this._boostSineGain.gain.cancelScheduledValues(t);
      this._boostSineGain.gain.setValueAtTime(this._boostSineGain.gain.value, t);
      this._boostSineGain.gain.linearRampToValueAtTime(0, t + fadeOut);
    }

    // Hard stop all sources after the fade, scheduled on the audio clock.
    // Each source's onended handler disconnects its graph.
    const stopAt = t + fadeOut + 0.03;
    try { this._boostSource?.stop(stopAt); } catch (_) {}
    try { this._boostStartSource?.stop(stopAt); } catch (_) {}
    try { this._boostNoiseSource?.stop(stopAt); } catch (_) {}
    try { this._boostSineOsc?.stop(stopAt); } catch (_) {}

    this._boostSource = null;
    this._boostStartSource = null;
    this._boostSupersonicBuffer = null;
    this._boostNoiseSource = null;
    this._boostSineOsc = null;
    this._boostGain = null;
    this._boostSineGain = null;
    this._boostMode = null;
  }

  // ========== 3. BALL HIT ==========
  // Maps ball hit intensity to different samples:
  //   Low intensity: sample 1 (soft tap), lower pitch
  //   Mid intensity: sample 2 (medium hit)
  //   High intensity: sample 3 (hard smash), higher pitch

  /**
   * Car-on-ball hit. `position` (optional {x,y,z}) spatializes the hit at the ball.
   */
  playBallHit(impactSpeed, position = null) {
    if (!this._canPlay('ballHit')) return;

    const intensity = Math.min(impactSpeed / 60, 1);

    if (this._hasBuffers('ballHit')) {
      const bufs = this._buffers.ballHit;
      // Pick sample by intensity tier
      let bufIdx;
      if (intensity < 0.33) bufIdx = 0;          // soft
      else if (intensity < 0.66) bufIdx = 1;     // medium
      else bufIdx = bufs.length - 1;             // hard

      const buffer = bufs[Math.min(bufIdx, bufs.length - 1)];
      // +-6% pitch jitter so no two touches are identical
      const playbackRate = (0.7 + intensity * 0.7) * (0.94 + Math.random() * 0.12);
      const volume = 0.15 + intensity * 0.35;
      this._playSample(buffer, { volume, playbackRate, position, category: 'ballHit' });
    } else {
      this._playBallHitProcedural(intensity, position);
    }

    // Slam layer: hard hits get a chest-thump sub body under the sample
    if (intensity > 0.5) this._playSlamLayer(intensity, position);
  }

  _playSlamLayer(intensity, position) {
    const t = this.ctx.currentTime;
    const amt = (intensity - 0.5) * 2; // 0..1 across the top half

    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(75, t);
    sub.frequency.exponentialRampToValueAtTime(36, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12 + amt * 0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13 + amt * 0.08);
    sub.connect(g);
    const panner = this._toBus(g, position);
    this._oneShot(null, sub, g, panner);
    sub.start(t);
    sub.stop(t + 0.25);

    // Crack transient on the very hardest hits
    if (amt > 0.6) {
      const noise = this._createNoiseSource();
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(3000, t);
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.08 * amt, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      noise.connect(hp);
      hp.connect(ng);
      const p2 = this._toBus(ng, position);
      this._oneShot(null, noise, hp, ng, p2);
      noise.start(t);
      noise.stop(t + 0.04);
    }
  }

  _playBallHitProcedural(intensity, position = null) {
    const t = this.ctx.currentTime;

    const noise = this._createNoiseSource();
    const noiseGain = this.ctx.createGain();
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.setValueAtTime(600 + intensity * 2000, t);

    const noiseDuration = 0.05 + (1 - intensity) * 0.1;
    noiseGain.gain.setValueAtTime(0.15 + intensity * 0.25, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + noiseDuration);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    const p1 = this._toBus(noiseGain, position);
    this._oneShot('ballHit', noise, noiseFilter, noiseGain, p1);
    noise.start(t);
    noise.stop(t + noiseDuration + 0.01);

    const ping = this.ctx.createOscillator();
    ping.type = 'sine';
    ping.frequency.setValueAtTime(120 + intensity * 230, t);
    ping.frequency.exponentialRampToValueAtTime(60 + intensity * 40, t + 0.1);

    const pingGain = this.ctx.createGain();
    pingGain.gain.setValueAtTime(0.2 + intensity * 0.2, t);
    pingGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08 + intensity * 0.07);

    ping.connect(pingGain);
    const p2 = this._toBus(pingGain, position);
    this._oneShot(null, ping, pingGain, p2);
    ping.start(t);
    ping.stop(t + 0.15);
  }

  // ========== 3b. BALL BOUNCE (ball vs. arena) ==========
  // Always procedural: three distinct timbres so the player can hear *where*
  // the ball went without looking. `surface` is 'floor' | 'wall' | 'ceiling'.

  playBallBounce(impactSpeed, surface, position = null) {
    if (impactSpeed < 4) return;            // rolling contact / micro-bounces
    if (!this._canPlay('bounce')) return;

    const intensity = Math.min(impactSpeed / 50, 1);
    const t = this.ctx.currentTime;
    if (surface === 'floor') this._bounceFloor(intensity, position, t);
    else if (surface === 'ceiling') this._bounceCeiling(intensity, position, t);
    else this._bounceWall(intensity, position, t);
  }

  /** Dull turf thud: pitch-dropping sine + a little low-passed noise. */
  _bounceFloor(intensity, position, t) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.08);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.05 + intensity * 0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09 + intensity * 0.05);
    osc.connect(g);
    const p1 = this._toBus(g, position);
    this._oneShot('bounce', osc, g, p1);
    osc.start(t);
    osc.stop(t + 0.16);

    const noise = this._createNoiseSource();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.03 + intensity * 0.08, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    noise.connect(lp);
    lp.connect(ng);
    const p2 = this._toBus(ng, position);
    this._oneShot(null, noise, lp, ng, p2);
    noise.start(t);
    noise.stop(t + 0.06);
  }

  /** Big panel boom: deep body + a ringing partial + slap, plus the impact sample for weight. */
  _bounceWall(intensity, position, t) {
    const body = this.ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(150, t);
    body.frequency.exponentialRampToValueAtTime(65, t + 0.15);
    const bg = this.ctx.createGain();
    bg.gain.setValueAtTime(0.08 + intensity * 0.3, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.16 + intensity * 0.1);
    body.connect(bg);
    const p1 = this._toBus(bg, position);
    this._oneShot('bounce', body, bg, p1);
    body.start(t);
    body.stop(t + 0.3);

    const ring = this.ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.setValueAtTime(420 * (0.95 + Math.random() * 0.1), t);
    const rg = this.ctx.createGain();
    rg.gain.setValueAtTime(0.02 + intensity * 0.06, t);
    rg.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    ring.connect(rg);
    const p2 = this._toBus(rg, position);
    this._oneShot(null, ring, rg, p2);
    ring.start(t);
    ring.stop(t + 0.24);

    const noise = this._createNoiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(500, t);
    bp.Q.setValueAtTime(1.2, t);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.05 + intensity * 0.15, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    noise.connect(bp);
    bp.connect(ng);
    const p3 = this._toBus(ng, position);
    this._oneShot(null, noise, bp, ng, p3);
    noise.start(t);
    noise.stop(t + 0.08);

    if (intensity > 0.3 && this._hasBuffers('impact')) {
      this._playSample(this._randomBuffer('impact'), {
        volume: intensity * 0.35,
        playbackRate: 0.55 + intensity * 0.2,
        position,
      });
    }
  }

  /** Hollow metallic clang: two detuned partials, bright tick, small sub. */
  _bounceCeiling(intensity, position, t) {
    const decay = 0.18 + intensity * 0.1;
    const amp = 0.03 + intensity * 0.1;

    const o1 = this.ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.setValueAtTime(540, t);
    o1.frequency.exponentialRampToValueAtTime(500, t + 0.2);
    const g1 = this.ctx.createGain();
    g1.gain.setValueAtTime(amp, t);
    g1.gain.exponentialRampToValueAtTime(0.001, t + decay);
    o1.connect(g1);
    const p1 = this._toBus(g1, position);
    this._oneShot('bounce', o1, g1, p1);
    o1.start(t);
    o1.stop(t + decay + 0.02);

    const o2 = this.ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(810 * (0.97 + Math.random() * 0.06), t);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(amp * 0.6, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + decay * 0.8);
    o2.connect(g2);
    const p2 = this._toBus(g2, position);
    this._oneShot(null, o2, g2, p2);
    o2.start(t);
    o2.stop(t + decay);

    const noise = this._createNoiseSource();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(2500, t);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.04 + intensity * 0.1, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    noise.connect(hp);
    hp.connect(ng);
    const p3 = this._toBus(ng, position);
    this._oneShot(null, noise, hp, ng, p3);
    noise.start(t);
    noise.stop(t + 0.05);

    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, t);
    sub.frequency.exponentialRampToValueAtTime(60, t + 0.08);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.04 + intensity * 0.1, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    sub.connect(sg);
    const p4 = this._toBus(sg, position);
    this._oneShot(null, sub, sg, p4);
    sub.start(t);
    sub.stop(t + 0.12);
  }

  // ========== 3c. CAR BUMP (sub-supersonic car-vs-car) ==========

  playCarBump(relSpeed, position = null) {
    if (relSpeed < 8) return;
    if (!this._canPlay('carBump')) return;

    const intensity = Math.min((relSpeed - 8) / 40, 1);
    const t = this.ctx.currentTime;

    // Metallic clank
    const clank = this.ctx.createOscillator();
    clank.type = 'square';
    clank.frequency.setValueAtTime(240, t);
    clank.frequency.exponentialRampToValueAtTime(95, t + 0.07);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.05 + intensity * 0.14, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    clank.connect(lp);
    lp.connect(cg);
    const p1 = this._toBus(cg, position);
    this._oneShot('carBump', clank, lp, cg, p1);
    clank.start(t);
    clank.stop(t + 0.12);

    // Scrape
    const noise = this._createNoiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1600, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.1);
    bp.Q.setValueAtTime(2, t);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.04 + intensity * 0.1, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.08 + intensity * 0.06);
    noise.connect(bp);
    bp.connect(ng);
    const p2 = this._toBus(ng, position);
    this._oneShot(null, noise, bp, ng, p2);
    noise.start(t);
    noise.stop(t + 0.16);

    if (this._hasBuffers('impact')) {
      this._playSample(this._randomBuffer('impact'), {
        volume: 0.1 + intensity * 0.25,
        playbackRate: 1.1 + Math.random() * 0.2,
        position,
      });
    }
  }

  // ========== 4. GOAL HORN / EXPLOSION ==========

  playGoalHorn() {
    if (!this.initialized) return;

    // Sidechain-style duck: engine/boost/bounces drop under the stinger so the
    // goal reads as a single clean statement, then recover over ~1.2s.
    this._duckSfx(0.3, 1.6, 1.2);
    // Stands erupt: long swell on the crowd loop + filter wide open
    this._crowdSwell(1.0, 0.25, 2.5, 2.0);

    const hasExplosion = this._hasBuffers('goalExplosion');
    const hasStinger = this._hasBuffers('goalStinger');
    const hasGoalEvent = this._hasBuffers('goalEvent');

    if (hasExplosion || hasStinger || hasGoalEvent) {
      if (hasExplosion) {
        // Explosion is part of the goal statement: UI bus so the duck doesn't eat it
        this._playSample(this._buffers.goalExplosion[0], { volume: 0.5, destination: this._uiBus });
      }

      if (hasGoalEvent) {
        // Crowd cheer sample belongs on the crowd bus (respects Crowd Volume)
        const eventBuffer = this._randomBuffer('goalEvent');
        this._playSample(eventBuffer, { volume: 0.5, destination: this._crowdBus });
      }

      if (hasStinger) {
        const stingerBuffer = this._randomBuffer('goalStinger');
        const t = this.ctx.currentTime;
        const source = this.ctx.createBufferSource();
        source.buffer = stingerBuffer;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t + 0.3);
        gain.gain.linearRampToValueAtTime(0.4, t + 0.5);
        source.connect(gain);
        gain.connect(this._uiBus);
        this._autoDisconnect(source, gain);
        source.start(t + 0.3);
      }
    } else {
      this._playGoalHornProcedural();
    }
  }

  /**
   * Dip the SFX bus to `depth`, hold for `hold` seconds, release over `release`.
   * Re-triggering cancels and restarts the envelope from the current level.
   */
  _duckSfx(depth, hold, release) {
    if (!this._sfxBus) return;
    const g = this._sfxBus.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(depth, t + 0.06);
    g.setValueAtTime(depth, t + hold);
    g.linearRampToValueAtTime(1, t + hold + release);
  }

  _playGoalHornProcedural() {
    const t = this.ctx.currentTime;

    // Bass explosion
    const bass = this.ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.setValueAtTime(200, t);
    bass.frequency.exponentialRampToValueAtTime(40, t + 0.5);
    const bassGain = this.ctx.createGain();
    bassGain.gain.setValueAtTime(0.4, t);
    bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    bass.connect(bassGain);
    bassGain.connect(this._uiBus);
    this._oneShot(null, bass, bassGain);
    bass.start(t);
    bass.stop(t + 0.85);

    // Noise burst
    const noise = this._createNoiseSource();
    const noiseFilt = this.ctx.createBiquadFilter();
    noiseFilt.type = 'lowpass';
    noiseFilt.frequency.setValueAtTime(3000, t);
    noiseFilt.frequency.exponentialRampToValueAtTime(400, t + 0.4);
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.3, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    noise.connect(noiseFilt);
    noiseFilt.connect(noiseGain);
    noiseGain.connect(this._uiBus);
    this._oneShot(null, noise, noiseFilt, noiseGain);
    noise.start(t);
    noise.stop(t + 0.55);

    // Crowd noise swell
    const crowd = this._createNoiseSource();
    const crowdFilter = this.ctx.createBiquadFilter();
    crowdFilter.type = 'bandpass';
    crowdFilter.frequency.setValueAtTime(1200, t);
    crowdFilter.Q.setValueAtTime(0.8, t);
    const crowdGain = this.ctx.createGain();
    crowdGain.gain.setValueAtTime(0, t + 0.15);
    crowdGain.gain.linearRampToValueAtTime(0.20, t + 0.6);
    crowdGain.gain.setValueAtTime(0.20, t + 1.2);
    crowdGain.gain.linearRampToValueAtTime(0, t + 2.0);
    crowd.connect(crowdFilter);
    crowdFilter.connect(crowdGain);
    crowdGain.connect(this._crowdBus);
    this._oneShot(null, crowd, crowdFilter, crowdGain);
    crowd.start(t + 0.15);
    crowd.stop(t + 2.1);

    // Second formant
    const crowd2 = this._createNoiseSource();
    const crowdFilter2 = this.ctx.createBiquadFilter();
    crowdFilter2.type = 'bandpass';
    crowdFilter2.frequency.setValueAtTime(2500, t);
    crowdFilter2.Q.setValueAtTime(1.2, t);
    const crowdGain2 = this.ctx.createGain();
    crowdGain2.gain.setValueAtTime(0, t + 0.2);
    crowdGain2.gain.linearRampToValueAtTime(0.08, t + 0.7);
    crowdGain2.gain.setValueAtTime(0.08, t + 1.0);
    crowdGain2.gain.linearRampToValueAtTime(0, t + 1.8);
    crowd2.connect(crowdFilter2);
    crowdFilter2.connect(crowdGain2);
    crowdGain2.connect(this._crowdBus);
    this._oneShot(null, crowd2, crowdFilter2, crowdGain2);
    crowd2.start(t + 0.2);
    crowd2.stop(t + 1.9);

    // Horn tone
    const horn = this.ctx.createOscillator();
    horn.type = 'sawtooth';
    horn.frequency.setValueAtTime(220, t + 0.3);
    const hornFilter = this.ctx.createBiquadFilter();
    hornFilter.type = 'lowpass';
    hornFilter.frequency.setValueAtTime(600, t + 0.3);
    const hornGain = this.ctx.createGain();
    hornGain.gain.setValueAtTime(0, t + 0.3);
    hornGain.gain.linearRampToValueAtTime(0.12, t + 0.6);
    hornGain.gain.setValueAtTime(0.12, t + 1.4);
    hornGain.gain.linearRampToValueAtTime(0, t + 2.0);
    horn.connect(hornFilter);
    hornFilter.connect(hornGain);
    hornGain.connect(this._uiBus);
    this._oneShot(null, horn, hornFilter, hornGain);
    horn.start(t + 0.3);
    horn.stop(t + 2.1);
  }

  // ========== 5. JUMP ==========
  // Uses carMove sample 1 (a short pneumatic burst)

  playJump() {
    if (!this._canPlay('jump')) return;

    if (this._hasBuffers('carMove')) {
      const buffer = this._buffers.carMove[0];
      this._playSample(buffer, { volume: 0.25, playbackRate: 1.06 + Math.random() * 0.08, category: 'jump' });
    } else {
      this._playJumpProcedural();
    }
  }

  _playJumpProcedural() {
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(400, t + 0.1);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    const noise = this._createNoiseSource();
    const noiseGain = this.ctx.createGain();
    const noiseFilt = this.ctx.createBiquadFilter();
    noiseFilt.type = 'highpass';
    noiseFilt.frequency.setValueAtTime(2000, t);
    noiseGain.gain.setValueAtTime(0.06, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

    osc.connect(gain);
    gain.connect(this._sfxBus);
    noise.connect(noiseFilt);
    noiseFilt.connect(noiseGain);
    noiseGain.connect(this._sfxBus);
    this._oneShot('jump', osc, gain);
    this._oneShot(null, noise, noiseFilt, noiseGain);

    osc.start(t);
    osc.stop(t + 0.13);
    noise.start(t);
    noise.stop(t + 0.07);
  }

  // ========== 6. LANDING THUD ==========
  // Uses impact samples, scaled by landing velocity

  playLanding(impactSpeed = 5) {
    if (!this._canPlay('landing')) return;

    const intensity = Math.min(impactSpeed / 20, 1);

    if (this._hasBuffers('impact')) {
      const buffer = this._randomBuffer('impact');
      const playbackRate = 0.8 + intensity * 0.4;
      const volume = 0.1 + intensity * 0.25;
      this._playSample(buffer, { volume, playbackRate, category: 'landing' });
    } else {
      this._playLandingProcedural(intensity);
    }
  }

  _playLandingProcedural(intensity) {
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(50 + intensity * 20, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.06);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.1 + intensity * 0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05 + intensity * 0.03);

    osc.connect(gain);
    gain.connect(this._sfxBus);
    this._oneShot('landing', osc, gain);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  // ========== 7. BOOST PAD PICKUP ==========

  playBoostPickup(isLargePad) {
    if (!this._canPlay('boostPickup')) return;

    if (this._hasBuffers('boostPickup')) {
      const bufs = this._buffers.boostPickup;
      // pickup_3 (index 0) for small pads, pickup_6 (index 1) for large pads
      const buffer = isLargePad ? bufs[1] || bufs[0] : bufs[0];
      const volume = isLargePad ? 0.18 : 0.10;
      this._playSample(buffer, { volume, category: 'boostPickup' });
    } else {
      this._playBoostPickupProcedural(isLargePad);
    }
  }

  _playBoostPickupProcedural(isLargePad) {
    const t = this.ctx.currentTime;
    const baseFreqs = isLargePad ? [500, 750, 1000] : [400, 600, 800];
    const volume = isLargePad ? 0.14 : 0.09;
    const interval = 0.03;

    baseFreqs.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + i * interval);

      const gain = this.ctx.createGain();
      const noteStart = t + i * interval;
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(volume, noteStart + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, noteStart + 0.08);

      osc.connect(gain);
      gain.connect(this._sfxBus);
      this._oneShot(i === 0 ? 'boostPickup' : null, osc, gain);
      osc.start(noteStart);
      osc.stop(noteStart + 0.1);
    });
  }

  // ========== 8. DEMOLITION ==========

  /**
   * Car demolished. `position` (optional) spatializes the explosion; the crowd
   * reacts with a short "ohh" regardless of where it happened.
   */
  playDemolition(position = null) {
    if (!this._canPlay('demolition')) return;

    if (this._hasBuffers('demo')) {
      const buffer = this._randomBuffer('demo');
      this._playSample(buffer, {
        volume: 0.5,
        playbackRate: 0.95 + Math.random() * 0.1,
        position,
        category: 'demolition',
      });
    } else {
      this._playDemolitionProcedural(position);
    }

    this.playCrowdReaction('demolition');
  }

  _playDemolitionProcedural(position = null) {
    const t = this.ctx.currentTime;

    const noise = this._createNoiseSource();
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.setValueAtTime(4000, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(200, t + 0.4);

    const distortion = this.ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * 4);
    }
    distortion.curve = curve;
    distortion.oversample = '2x';

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.28, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

    noise.connect(noiseFilter);
    noiseFilter.connect(distortion);
    distortion.connect(noiseGain);
    const p1 = this._toBus(noiseGain, position);
    this._oneShot('demolition', noise, noiseFilter, distortion, noiseGain, p1);
    noise.start(t);
    noise.stop(t + 0.45);

    const bass = this.ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.setValueAtTime(100, t);
    bass.frequency.exponentialRampToValueAtTime(30, t + 0.3);
    const bassGain = this.ctx.createGain();
    bassGain.gain.setValueAtTime(0.35, t);
    bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    bass.connect(bassGain);
    const p2 = this._toBus(bassGain, position);
    this._oneShot(null, bass, bassGain, p2);
    bass.start(t);
    bass.stop(t + 0.4);

    const crunch = this.ctx.createOscillator();
    crunch.type = 'square';
    crunch.frequency.setValueAtTime(150, t);
    crunch.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const crunchGain = this.ctx.createGain();
    crunchGain.gain.setValueAtTime(0.12, t);
    crunchGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    crunch.connect(crunchGain);
    const p3 = this._toBus(crunchGain, position);
    this._oneShot(null, crunch, crunchGain, p3);
    crunch.start(t);
    crunch.stop(t + 0.3);
  }

  // ========== 9. COUNTDOWN BEEPS ==========
  // Always procedural

  playCountdownBeep(isGo) {
    if (!this.initialized) return;

    const t = this.ctx.currentTime;
    const freq = isGo ? 880 : 440;
    const duration = isGo ? 0.3 : 0.12;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);

    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, t);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.20, t + 0.01);
    gain.gain.setValueAtTime(0.20, t + duration - 0.03);
    gain.gain.linearRampToValueAtTime(0, t + duration);

    const gain2 = this.ctx.createGain();
    gain2.gain.setValueAtTime(0, t);
    gain2.gain.linearRampToValueAtTime(0.06, t + 0.01);
    gain2.gain.setValueAtTime(0.06, t + duration - 0.03);
    gain2.gain.linearRampToValueAtTime(0, t + duration);

    osc.connect(gain);
    gain.connect(this._uiBus);
    osc2.connect(gain2);
    gain2.connect(this._uiBus);
    this._oneShot(null, osc, gain);
    this._oneShot(null, osc2, gain2);

    osc.start(t);
    osc.stop(t + duration + 0.01);
    osc2.start(t);
    osc2.stop(t + duration + 0.01);

    // Kickoff: referee whistle rides on top of the GO tone
    if (isGo) this._playWhistle(t + 0.05, 0.45, 2150, 0.14);
  }

  /**
   * Procedural pea whistle: pure tone with a ~30Hz pitch warble (the pea) and a
   * narrow band of breath noise. Routed to the UI bus so it is never ducked.
   */
  _playWhistle(t, duration, freq, volume) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);

    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(28, t);
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.setValueAtTime(freq * 0.035, t);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + 0.025);
    g.gain.setValueAtTime(volume, t + duration - 0.08);
    g.gain.linearRampToValueAtTime(0, t + duration);
    osc.connect(g);
    g.connect(this._uiBus);

    const noise = this._createNoiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq, t);
    bp.Q.setValueAtTime(9, t);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(volume * 0.5, t + 0.03);
    ng.gain.setValueAtTime(volume * 0.5, t + duration - 0.08);
    ng.gain.linearRampToValueAtTime(0, t + duration);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(this._uiBus);

    this._oneShot('ui', osc, g, lfo, lfoGain);
    this._oneShot(null, noise, bp, ng);
    osc.start(t);
    lfo.start(t);
    noise.start(t);
    osc.stop(t + duration + 0.01);
    lfo.stop(t + duration + 0.01);
    noise.stop(t + duration + 0.01);
  }

  /**
   * Full-time: long whistle blast + the stands roar. Call before stopAll(); the
   * roar is a one-shot on the crowd bus so it survives the ambience fade.
   */
  playMatchEnd() {
    if (!this.initialized) return;
    const t = this.ctx.currentTime;
    this._playWhistle(t, 0.9, 2100, 0.16);
    this._crowdSwell(0.8, 0.3, 1.5, 2.0);
    if (this._hasBuffers('goalEvent')) {
      this._playSample(this._randomBuffer('goalEvent'), { volume: 0.4, destination: this._crowdBus });
    }
  }

  // ========== 9b. UI ==========
  // Short, quiet, non-tonal-fatiguing. UI bus: never ducked, never spatialized.

  playUIClick() {
    if (!this._canPlay('ui')) return;
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(1500, t + 0.04);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g);
    g.connect(this._uiBus);
    this._oneShot('ui', osc, g);
    osc.start(t);
    osc.stop(t + 0.07);

    const noise = this._createNoiseSource();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(4000, t);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.03, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    noise.connect(hp);
    hp.connect(ng);
    ng.connect(this._uiBus);
    this._oneShot(null, noise, hp, ng);
    noise.start(t);
    noise.stop(t + 0.025);
  }

  playUIHover() {
    if (!this._canPlay('uiHover')) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1300, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.025, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    osc.connect(g);
    g.connect(this._uiBus);
    this._oneShot('uiHover', osc, g);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  // ========== 10. DODGE / FLIP ==========

  playDodge() {
    if (!this._canPlay('dodge')) return;

    if (this._hasBuffers('carMove') && this._buffers.carMove.length >= 3) {
      const buffer = this._buffers.carMove[2];
      this._playSample(buffer, { volume: 0.25, playbackRate: 1.15 + Math.random() * 0.1, category: 'dodge' });
    } else {
      this._playDodgeProcedural();
    }
  }

  _playDodgeProcedural() {
    const t = this.ctx.currentTime;

    const noise = this._createNoiseSource();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2000, t);
    filter.frequency.exponentialRampToValueAtTime(500, t + 0.1);
    filter.Q.setValueAtTime(2, t);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this._sfxBus);
    this._oneShot('dodge', noise, filter, gain);

    noise.start(t);
    noise.stop(t + 0.14);
  }

  // ========== 11. CROWD AMBIANCE ==========

  // Graph:  base loop -> _crowdGain (fade) ----\
  //         stem loop -> _crowdLayerGain -------> _crowdDynGain -> _crowdSwellGain -> _crowdBus
  // Excitement (0-1, from ball proximity to a goal) raises _crowdDynGain, fades
  // the stem in and opens the bus lowpass. Goals/match end swell _crowdSwellGain.

  startCrowdAmbiance() {
    if (!this.initialized || this._crowdActive) return;
    if (!this._hasBuffers('crowd')) return;

    this._crowdActive = true;
    const bufs = this._buffers.crowd;
    const t = this.ctx.currentTime;

    const dyn = this.ctx.createGain();
    dyn.gain.setValueAtTime(0.035, t);
    const swell = this.ctx.createGain();
    swell.gain.setValueAtTime(1, t);
    dyn.connect(swell);
    swell.connect(this._crowdBus);
    this._crowdDynGain = dyn;
    this._crowdSwellGain = swell;

    // Base murmur
    const source = this.ctx.createBufferSource();
    source.buffer = bufs[0];
    source.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + 1.0);
    source.connect(gain);
    gain.connect(dyn);
    // The base source owns the shared dyn/swell stages for cleanup
    this._oneShot(null, source, gain, dyn, swell);
    source.start(t, Math.random() * Math.max(0, bufs[0].duration - 1));
    this._crowdSource = source;
    this._crowdGain = gain;

    // Excitement stem: silent until the ball threatens a goal
    if (bufs.length > 1) {
      const layer = this.ctx.createBufferSource();
      layer.buffer = bufs[1];
      layer.loop = true;
      const lg = this.ctx.createGain();
      lg.gain.setValueAtTime(0, t);
      layer.connect(lg);
      lg.connect(dyn);
      this._oneShot(null, layer, lg);
      layer.start(t, Math.random() * Math.max(0, bufs[1].duration - 1));
      this._crowdLayerSource = layer;
      this._crowdLayerGain = lg;
    }

    this._crowdLastExcitement = -1;
    this._crowdLastUpdateTime = -Infinity;
    this._crowdFilter.frequency.setTargetAtTime(1400, t, 0.3);
  }

  stopCrowdAmbiance() {
    if (!this.initialized || !this._crowdActive) return;
    this._crowdActive = false;

    const t = this.ctx.currentTime;
    const fadeOut = 1.0;

    if (this._crowdGain) {
      this._crowdGain.gain.cancelScheduledValues(t);
      this._crowdGain.gain.setValueAtTime(this._crowdGain.gain.value, t);
      this._crowdGain.gain.linearRampToValueAtTime(0, t + fadeOut);
    }
    if (this._crowdLayerGain) {
      this._crowdLayerGain.gain.cancelScheduledValues(t);
      this._crowdLayerGain.gain.setValueAtTime(this._crowdLayerGain.gain.value, t);
      this._crowdLayerGain.gain.linearRampToValueAtTime(0, t + fadeOut);
    }

    // Stop on the audio clock after the fade; onended disconnects the graph
    try { this._crowdLayerSource?.stop(t + fadeOut + 0.05); } catch (_) {}
    try { this._crowdSource?.stop(t + fadeOut + 0.05); } catch (_) {}

    this._crowdSource = null;
    this._crowdGain = null;
    this._crowdLayerSource = null;
    this._crowdLayerGain = null;
    this._crowdDynGain = null;
    this._crowdSwellGain = null;
    this._crowdLastExcitement = -1;
  }

  /**
   * Drive crowd tension from gameplay (0 = midfield lull, 1 = ball in the goal
   * mouth). Safe to call every frame: applies at most 10x/s and only on change.
   */
  setCrowdExcitement(x) {
    if (!this._crowdActive || !this._crowdDynGain) return;
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    if (Math.abs(x - this._crowdLastExcitement) < 0.02) return;
    const t = this.ctx.currentTime;
    if (t - this._crowdLastUpdateTime < 0.1) return;
    this._crowdLastExcitement = x;
    this._crowdLastUpdateTime = t;

    this._crowdDynGain.gain.setTargetAtTime(0.035 + 0.04 * x, t, 0.5);
    if (this._crowdLayerGain) this._crowdLayerGain.gain.setTargetAtTime(0.6 * x * x, t, 0.6);
    this._crowdFilter.frequency.setTargetAtTime(1400 + 4600 * x, t, 0.5);
  }

  /** Temporary crowd surge: +peak over attack, hold, then settle back to 1.0. */
  _crowdSwell(peak, attack, hold, release) {
    if (!this._crowdSwellGain) return;
    const g = this._crowdSwellGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(1 + peak, t + attack);
    g.setValueAtTime(1 + peak, t + attack + hold);
    g.linearRampToValueAtTime(1, t + attack + hold + release);
    this._crowdFilter.frequency.cancelScheduledValues(t);
    this._crowdFilter.frequency.setTargetAtTime(6000, t, 0.15);
    this._crowdFilter.frequency.setTargetAtTime(1400 + 4600 * Math.max(0, this._crowdLastExcitement), t + attack + hold, 1.0);
  }

  /**
   * One-shot crowd response. 'save' = big gasp-and-cheer, 'demolition' = short
   * "ohh". Plays a random windowed slice of a crowd buffer with its own envelope
   * so it never fights the loop automation.
   */
  playCrowdReaction(type) {
    if (!this._canPlay('crowdReact')) return;
    const bufs = this._buffers.crowd;
    const t = this.ctx.currentTime;

    let attack, hold, release, peak, rate;
    if (type === 'save') {
      attack = 0.12; hold = 0.5; release = 1.0; peak = 0.09; rate = 1.0;
    } else {
      attack = 0.05; hold = 0.3; release = 0.6; peak = 0.06; rate = 0.9;
    }
    const total = attack + hold + release;

    if (bufs && bufs.length > 0) {
      const buffer = bufs[bufs.length - 1];
      const maxOffset = Math.max(0, buffer.duration - total * rate - 0.2);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, t + attack + hold);
      g.gain.linearRampToValueAtTime(0, t + total);
      source.connect(g);
      g.connect(this._crowdBus);
      this._oneShot('crowdReact', source, g);
      source.start(t, Math.random() * maxOffset);
      source.stop(t + total + 0.02);
    } else {
      // Procedural fallback: shaped bandpass noise swell
      const noise = this._createNoiseSource();
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1100 * rate, t);
      bp.Q.setValueAtTime(0.8, t);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak * 1.5, t + attack);
      g.gain.setValueAtTime(peak * 1.5, t + attack + hold);
      g.gain.linearRampToValueAtTime(0, t + total);
      noise.connect(bp);
      bp.connect(g);
      g.connect(this._crowdBus);
      this._oneShot('crowdReact', noise, bp, g);
      noise.start(t);
      noise.stop(t + total + 0.02);
    }
  }

  // ========== CLEANUP ==========

  /**
   * Stop all continuous sounds (engine, boost, crowd) without destroying the context.
   * Called when returning to lobby or game ends.
   */
  stopAll() {
    if (!this.initialized) return;
    this.stopBoost();
    this.stopCrowdAmbiance();
    this._stopEngine();
    // Cancel any in-flight goal duck so the lobby/next match starts at unity
    if (this._sfxBus) {
      const t = this.ctx.currentTime;
      this._sfxBus.gain.cancelScheduledValues(t);
      this._sfxBus.gain.setTargetAtTime(1, t, 0.1);
    }
  }

  destroy() {
    if (!this.initialized) return;

    this.stopAll();

    this.ctx.close().catch(() => {});
    this.initialized = false;
    this.ctx = null;
    // Drop the bus references too: the volume setters guard on these, and a
    // stale masterGain would dereference the null context.
    this.masterGain = null;
    this._sfxBus = null;
    this._uiBus = null;
    this._crowdBus = null;
    this._crowdFilter = null;
    this._buffers = {};
    this._motorBuffers = {};
    this._boostBuffers = {};
  }
}

// Export singleton instance
export const audioManager = new AudioManager();
