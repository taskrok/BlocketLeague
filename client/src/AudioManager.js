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
//   - On match end: audioManager.stopCrowdAmbiance();
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
  ballHit:       ['ball_hit_1.ogg'],
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

    // Boost state
    this._boostSource = null;
    this._boostGain = null;
    this._boostActive = false;
    this._boostMode = null;

    // Crowd state
    this._crowdSource = null;
    this._crowdGain = null;
    this._crowdActive = false;

    // Noise buffer for procedural fallbacks
    this._noiseBuffer = null;

    // Throttle rapid-fire sounds
    this._lastPlayTime = {};
    this._minInterval = {
      ballHit: 0.05,
      jump: 0.1,
      landing: 0.08,
      dodge: 0.1,
      boostPickup: 0.05,
      demolition: 0.15,
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

  // ========== UTILITY ==========

  _canPlay(type) {
    if (!this.initialized) return false;
    const now = this.ctx.currentTime;
    const minInterval = this._minInterval[type] || 0;
    if (now - (this._lastPlayTime[type] || 0) < minInterval) return false;
    this._lastPlayTime[type] = now;
    return true;
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
      destination = this.masterGain,
      fadeIn = 0.005,
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
    gain.connect(destination);
    source.start(t);

    return { source, gain };
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
    this._engineSubGain.connect(this.masterGain);

    this._engineOsc.start(t);
    this._engineSubOsc.start(t);

    // --- Sample layer (if available) ---
    if (buffer) {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.playbackRate.setValueAtTime(params.baseRate, t);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(params.volume, t);

      source.connect(gain);
      gain.connect(this.masterGain);
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
    this._engineOsc = null;
    this._engineSubOsc = null;
    this._engineSampleSource = null;
    this._engineSampleGain = null;
    this._engineSubGain = null;
    this._engineHarmGain = null;
    this._engineFilter = null;
    this._engineMode = null;
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
      startGain.connect(this.masterGain);
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
      loopGain.connect(this.masterGain);
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
      gain.connect(this.masterGain);
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

    if (this._boostMode === 'sampled' && this._boostSupersonicBuffer) {
      this._playSample(this._boostSupersonicBuffer, { volume: 0.3 });
    }
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
    this._boostGain.connect(this.masterGain);

    this._boostSineOsc.connect(boostSineGain);
    boostSineGain.connect(this.masterGain);

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

    // Hard stop all sources after short fade
    const refs = [this._boostSource, this._boostStartSource, this._boostNoiseSource, this._boostSineOsc];
    setTimeout(() => {
      for (const ref of refs) {
        try { ref?.stop(); } catch (_) {}
      }
    }, fadeOut * 1000 + 30);

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

  playBallHit(impactSpeed) {
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
      const playbackRate = 0.7 + intensity * 0.7;
      const volume = 0.15 + intensity * 0.35;
      this._playSample(buffer, { volume, playbackRate });
    } else {
      this._playBallHitProcedural(intensity);
    }
  }

  _playBallHitProcedural(intensity) {
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
    noiseGain.connect(this.masterGain);
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
    pingGain.connect(this.masterGain);
    ping.start(t);
    ping.stop(t + 0.15);
  }

  // ========== 4. GOAL HORN / EXPLOSION ==========

  playGoalHorn() {
    if (!this.initialized) return;

    const hasExplosion = this._hasBuffers('goalExplosion');
    const hasStinger = this._hasBuffers('goalStinger');
    const hasGoalEvent = this._hasBuffers('goalEvent');

    if (hasExplosion || hasStinger || hasGoalEvent) {
      if (hasExplosion) {
        this._playSample(this._buffers.goalExplosion[0], { volume: 0.5 });
      }

      if (hasGoalEvent) {
        const eventBuffer = this._randomBuffer('goalEvent');
        this._playSample(eventBuffer, { volume: 0.35 });
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
        gain.connect(this.masterGain);
        source.start(t + 0.3);
      }
    } else {
      this._playGoalHornProcedural();
    }
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
    bassGain.connect(this.masterGain);
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
    noiseGain.connect(this.masterGain);
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
    crowdGain.connect(this.masterGain);
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
    crowdGain2.connect(this.masterGain);
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
    hornGain.connect(this.masterGain);
    horn.start(t + 0.3);
    horn.stop(t + 2.1);
  }

  // ========== 5. JUMP ==========
  // Uses carMove sample 1 (a short pneumatic burst)

  playJump() {
    if (!this._canPlay('jump')) return;

    if (this._hasBuffers('carMove')) {
      const buffer = this._buffers.carMove[0];
      this._playSample(buffer, { volume: 0.25, playbackRate: 1.1 });
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
    gain.connect(this.masterGain);
    noise.connect(noiseFilt);
    noiseFilt.connect(noiseGain);
    noiseGain.connect(this.masterGain);

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
      this._playSample(buffer, { volume, playbackRate });
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
    gain.connect(this.masterGain);
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
      this._playSample(buffer, { volume });
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
      gain.connect(this.masterGain);
      osc.start(noteStart);
      osc.stop(noteStart + 0.1);
    });
  }

  // ========== 8. DEMOLITION ==========

  playDemolition() {
    if (!this._canPlay('demolition')) return;

    if (this._hasBuffers('demo')) {
      const buffer = this._randomBuffer('demo');
      this._playSample(buffer, { volume: 0.5 });
    } else {
      this._playDemolitionProcedural();
    }
  }

  _playDemolitionProcedural() {
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
    noiseGain.connect(this.masterGain);
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
    bassGain.connect(this.masterGain);
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
    crunchGain.connect(this.masterGain);
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
    gain.connect(this.masterGain);
    osc2.connect(gain2);
    gain2.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + duration + 0.01);
    osc2.start(t);
    osc2.stop(t + duration + 0.01);
  }

  // ========== 10. DODGE / FLIP ==========

  playDodge() {
    if (!this._canPlay('dodge')) return;

    if (this._hasBuffers('carMove') && this._buffers.carMove.length >= 3) {
      const buffer = this._buffers.carMove[2];
      this._playSample(buffer, { volume: 0.25, playbackRate: 1.2 });
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
    gain.connect(this.masterGain);

    noise.start(t);
    noise.stop(t + 0.14);
  }

  // ========== 11. CROWD AMBIANCE ==========

  startCrowdAmbiance() {
    if (!this.initialized || this._crowdActive) return;

    if (this._hasBuffers('crowd')) {
      this._crowdActive = true;
      const buffer = this._buffers.crowd[0];
      const t = this.ctx.currentTime;

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.03, t + 1.0);

      source.connect(gain);
      gain.connect(this.masterGain);
      source.start(t);

      this._crowdSource = source;
      this._crowdGain = gain;
    }
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

    const srcRef = this._crowdSource;
    setTimeout(() => {
      try { srcRef?.stop(); } catch (_) {}
    }, fadeOut * 1000 + 50);

    this._crowdSource = null;
    this._crowdGain = null;
  }

  // ========== CLEANUP ==========

  /**
   * Stop all continuous sounds (engine, boost, crowd) without destroying the context.
   * Called when returning to lobby or game ends.
   */
  stopAll() {
    this.stopBoost();
    this.stopCrowdAmbiance();
    this._stopEngine();
  }

  destroy() {
    if (!this.initialized) return;

    this.stopAll();

    this.ctx.close().catch(() => {});
    this.initialized = false;
    this.ctx = null;
    this._buffers = {};
    this._motorBuffers = {};
    this._boostBuffers = {};
  }
}

// Export singleton instance
export const audioManager = new AudioManager();
