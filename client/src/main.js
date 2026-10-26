// ============================================
// Blocket League - Entry Point
// ============================================

import * as THREE from 'three';
import { Game } from './Game.js';
import { NetworkManager } from './NetworkManager.js';
import { generateCarVariant } from './CarVariants.js';
import { buildCarMesh } from './CarMeshBuilder.js';
import { modelLoader } from './ModelLoader.js';
import { COLORS, RANDOM_NAMES } from '../../shared/constants.js';
import { getGeneralSettings } from './GameSettings.js';
import { buildLobbySettings } from './LobbySettings.js';
import { ARENA_THEMES } from './ArenaThemes.js';
import { audioManager } from './AudioManager.js';
import { progression } from './Progression.js';

window.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('game-canvas');
  const lobby = document.getElementById('lobby');
  const lobbyButtons = lobby.querySelector('.lobby-buttons');
  const lobbyTitle = lobby.querySelector('.lobby-title-wrap');
  const carSelector = document.getElementById('car-selector');
  const previewCanvas = document.getElementById('car-preview');
  const btnSingle = document.getElementById('btn-singleplayer');
  const btnFreeplay = document.getElementById('btn-freeplay');
  const btnTraining = document.getElementById('btn-training');
  const btnMulti = document.getElementById('btn-multiplayer');
  const btnLetsGo = document.getElementById('btn-letsgo');
  const btnBack = document.getElementById('btn-back');
  const btnPrevModel = document.getElementById('btn-prev-model');
  const btnNextModel = document.getElementById('btn-next-model');
  const carModelName = document.getElementById('car-model-name');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingFill = document.getElementById('loading-fill');

  // Arena selector
  const btnPrevArena = document.getElementById('btn-prev-arena');
  const btnNextArena = document.getElementById('btn-next-arena');
  const arenaNameEl = document.getElementById('arena-name');
  let currentArenaIndex = 0;
  arenaNameEl.textContent = ARENA_THEMES[0].name;

  function pickRandomName() {
    return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
  }

  // Persistent player ID for server stats
  const PLAYER_ID_KEY = 'blocket-player-id';
  let localPlayerId = localStorage.getItem(PLAYER_ID_KEY) || '';

  // Player name
  const playerNameInput = document.getElementById('player-name-input');
  const PLAYER_NAME_KEY = 'blocket-player-name';
  let savedName = localStorage.getItem(PLAYER_NAME_KEY) || '';
  if (!savedName) {
    savedName = pickRandomName();
    localStorage.setItem(PLAYER_NAME_KEY, savedName);
  }
  playerNameInput.value = savedName;
  playerNameInput.addEventListener('input', () => {
    localStorage.setItem(PLAYER_NAME_KEY, playerNameInput.value.trim());
  });

  // How to Play
  const btnHowToPlay = document.getElementById('btn-howtoplay');
  const howtoplayPanel = document.getElementById('howtoplay-panel');
  const btnHowToPlayClose = document.getElementById('btn-howtoplay-close');

  // Lobby Settings
  const btnLobbySettings = document.getElementById('btn-lobby-settings');
  const lobbySettingsPanel = document.getElementById('lobby-settings-panel');
  const btnLobbySettingsClose = document.getElementById('btn-lobby-settings-close');

  // Changelog
  const btnChangelog = document.getElementById('btn-changelog');
  const changelogPanel = document.getElementById('changelog-panel');
  const btnChangelogClose = document.getElementById('btn-changelog-close');

  // Full tabbed settings (camera / keys / pad / audio / display) in the lobby.
  // Same storage keys as the in-match panel, so changes carry into the game.
  const lobbySettings = buildLobbySettings(document.getElementById('lobby-settings-root'));

  // Room lobby elements
  const roomLobby = document.getElementById('room-lobby');
  const roomLobbyOptions = roomLobby.querySelector('.room-lobby-options');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const btnQuickMatch = document.getElementById('btn-quick-match');
  const roomCodeInput = document.getElementById('room-code-input');
  const modeSelector = document.getElementById('mode-selector');
  const btnMode1v1 = document.getElementById('btn-mode-1v1');
  const btnMode2v2 = document.getElementById('btn-mode-2v2');
  const waitingRoom = document.getElementById('waiting-room');
  const roomCodeDisplay = document.getElementById('room-code-display');
  const roomModeLabel = document.getElementById('room-mode-label');
  const roomStatus = document.getElementById('room-status');
  const blueSlots = document.getElementById('blue-slots');
  const orangeSlots = document.getElementById('orange-slots');
  const btnRoomBack = document.getElementById('btn-room-back');
  const btnCopyCode = document.getElementById('btn-copy-code');

  // Quick match mode selector elements
  const quickmatchModeSelector = document.getElementById('quickmatch-mode-selector');
  const btnQM1v1 = document.getElementById('btn-qm-1v1');
  const btnQM2v2 = document.getElementById('btn-qm-2v2');
  const btnQMModeBack = document.getElementById('btn-qm-mode-back');

  // Queue searching elements
  const queueSearching = document.getElementById('queue-searching');
  const queueTimerEl = document.getElementById('queue-timer');
  const queueInfoEl = document.getElementById('queue-info');
  const btnCancelQueue = document.getElementById('btn-cancel-queue');

  // Training selector elements
  const trainingTypeSelector = document.getElementById('training-type-selector');
  const btnTrainStriker = document.getElementById('btn-train-striker');
  const btnTrainGoalie = document.getElementById('btn-train-goalie');
  const btnTrainAerial = document.getElementById('btn-train-aerial');
  const btnTrainTypeBack = document.getElementById('btn-train-type-back');
  const trainingDiffSelector = document.getElementById('training-diff-selector');
  const btnTrainDiffRookie = document.getElementById('btn-train-diff-rookie');
  const btnTrainDiffPro = document.getElementById('btn-train-diff-pro');
  const btnTrainDiffAllstar = document.getElementById('btn-train-diff-allstar');
  const btnTrainDiffBack = document.getElementById('btn-train-diff-back');

  // AI mode selector elements
  const aiModeSelector = document.getElementById('ai-mode-selector');
  const btnAI1v1 = document.getElementById('btn-ai-1v1');
  const btnAI2v2 = document.getElementById('btn-ai-2v2');
  const btnAIModeBack = document.getElementById('btn-ai-mode-back');

  // Difficulty selector elements
  const difficultySelector = document.getElementById('difficulty-selector');
  const btnDiffRookie = document.getElementById('btn-diff-rookie');
  const btnDiffPro = document.getElementById('btn-diff-pro');
  const btnDiffAllstar = document.getElementById('btn-diff-allstar');
  const btnDiffBack = document.getElementById('btn-diff-back');

  // Lobby music controls
  const lobbySkipBtn = document.getElementById('lobby-skip-btn');
  const lobbyVolumeSlider = document.getElementById('lobby-volume-slider');
  const lobbyTrackName = document.getElementById('lobby-track-name');

  let selectedMode = null;
  let selectedDifficulty = 'pro';
  let selectedAIMode = '1v1';
  let selectedTrainingType = 'striker';
  let selectedTrainingDifficulty = 'pro';
  let chosenVariant = null;
  let currentModelIndex = 0;
  let availableModelIds = [];
  let activeGame = null;

  // Lobby gamepad navigation poller controls; assigned in the
  // GAMEPAD LOBBY NAVIGATION section below, called whenever the lobby is shown/hidden.
  let startLobbyGamepadPoll = () => {};
  let stopLobbyGamepadPoll = () => {};

  // Persist car selection
  const CAR_MODEL_KEY = 'blocket-car-model';
  try {
    const savedIdx = localStorage.getItem(CAR_MODEL_KEY);
    if (savedIdx !== null) currentModelIndex = parseInt(savedIdx, 10) || 0;
  } catch {}

  // --- Title music (shuffle playlist) ---
  const musicTracks = [
    { src: '/Blocket%20League!.mp3', name: 'Blocket League!' },
    { src: '/Jackson%20is%20good%20at%20Rocket%20League.mp3', name: 'Jackson is good at Rocket League' },
    { src: '/On%20the%20back%20of%20my%20car.mp3', name: 'On the back of my car' },
    { src: '/That%20was%20such%20a%20lucky%20hit.mp3', name: 'That was such a lucky hit' },
  ];
  // Shuffle using Fisher-Yates
  for (let i = musicTracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [musicTracks[i], musicTracks[j]] = [musicTracks[j], musicTracks[i]];
  }
  let musicIndex = 0;
  const titleMusic = new Audio(musicTracks[0].src);
  window.__blocketTitleMusic = titleMusic;
  // Load stored volume
  let storedVolume = 0.5;
  try {
    const audioSettings = localStorage.getItem('blocket-audio-settings');
    if (audioSettings) {
      const parsed = JSON.parse(audioSettings);
      if (typeof parsed.musicVolume === 'number') storedVolume = parsed.musicVolume;
    }
  } catch {}
  titleMusic.volume = storedVolume;
  lobbyVolumeSlider.value = storedVolume;

  // --- Now Playing toast (bottom right) ---
  const toast = document.createElement('div');
  Object.assign(toast.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: '500',
    background: 'rgba(10,10,30,0.85)', border: '1px solid rgba(0,255,255,0.3)',
    borderRadius: '8px', padding: '10px 14px', display: 'flex', alignItems: 'center',
    gap: '10px', fontFamily: "'Orbitron', sans-serif", fontSize: '12px', color: '#ccc',
    opacity: '0', transition: 'opacity 0.4s', pointerEvents: 'none',
    backdropFilter: 'blur(6px)', maxWidth: '320px',
  });
  const toastText = document.createElement('span');
  toastText.style.flex = '1';
  toast.appendChild(toastText);
  const skipBtn = document.createElement('button');
  skipBtn.textContent = '\u23ED'; // next track symbol
  Object.assign(skipBtn.style, {
    background: 'none', border: '1px solid rgba(0,255,255,0.4)', borderRadius: '4px',
    color: '#0ff', cursor: 'pointer', fontSize: '14px', padding: '2px 8px',
    pointerEvents: 'auto',
  });
  toast.appendChild(skipBtn);
  document.body.appendChild(toast);

  let toastTimer = null;
  function showNowPlaying() {
    const name = musicTracks[musicIndex].name;
    toastText.textContent = '\u266A ' + name;
    lobbyTrackName.textContent = '\u266A ' + name;
    toast.style.opacity = '1';
    toast.style.pointerEvents = 'auto';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.pointerEvents = 'none';
    }, 4000);
  }

  function skipTrack() {
    musicIndex = (musicIndex + 1) % musicTracks.length;
    titleMusic.src = musicTracks[musicIndex].src;
    titleMusic.play().catch(() => {});
    showNowPlaying();
  }

  skipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    skipTrack();
  });

  titleMusic.addEventListener('ended', () => {
    skipTrack();
  });

  titleMusic.addEventListener('play', () => {
    showNowPlaying();
  });

  let musicStarted = false;
  const startMusic = () => {
    if (!musicStarted) {
      titleMusic.play().catch(() => {});
      musicStarted = true;
      document.removeEventListener('click', startMusic);
    }
  };
  document.addEventListener('click', startMusic);

  // Init audio manager on first user interaction (browser autoplay policy)
  let audioInited = false;
  const initAudio = () => {
    if (!audioInited) {
      audioManager.init();
      // Restore mute preference from localStorage
      try {
        const audioSettings = JSON.parse(localStorage.getItem('blocket-audio-settings') || '{}');
        if (audioSettings.sfxMuted) {
          audioManager.setMuted(true);
        }
        if (typeof audioSettings.sfxVolume === 'number') {
          audioManager.setMasterVolume(audioSettings.sfxVolume);
        }
      } catch {}
      audioInited = true;
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
    }
  };
  document.addEventListener('click', initAudio);
  document.addEventListener('keydown', initAudio);

  // Lobby music controls
  lobbySkipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!musicStarted) startMusic();
    skipTrack();
  });

  // Persist on a trailing debounce (input fires at pointer-move rate) and
  // merge into the existing object so the SFX keys survive.
  let lobbyVolumeSaveTimer = null;
  lobbyVolumeSlider.addEventListener('input', () => {
    const v = parseFloat(lobbyVolumeSlider.value);
    titleMusic.volume = v;
    clearTimeout(lobbyVolumeSaveTimer);
    lobbyVolumeSaveTimer = setTimeout(() => {
      try {
        const audioSettings = JSON.parse(localStorage.getItem('blocket-audio-settings') || '{}');
        audioSettings.musicVolume = v;
        localStorage.setItem('blocket-audio-settings', JSON.stringify(audioSettings));
      } catch {}
    }, 250);
  });

  // Room lobby state
  let selectedRoomMode = null; // '1v1' | '2v2'
  let selectedQMMode = null; // quick match mode: '1v1' | '2v2'
  let roomCode = null;
  let isRoomCreator = false;
  let networkManager = null;
  let queueTimerInterval = null;
  let queueStartTime = null;

  // --- 3D Preview state ---
  let previewRenderer = null;
  let previewScene = null;
  let previewCamera = null;
  let previewCarMesh = null;
  let previewAnimId = null;

  canvas.addEventListener('click', () => {
    canvas.focus();
  });

  // --- Particle Background ---
  const particleCanvas = document.getElementById('lobby-particles');
  const pCtx = particleCanvas.getContext('2d');
  const particles = [];
  const PARTICLE_COUNT = 60;

  function resizeParticleCanvas() {
    particleCanvas.width = lobby.clientWidth;
    particleCanvas.height = lobby.clientHeight;
  }
  resizeParticleCanvas();
  window.addEventListener('resize', resizeParticleCanvas);

  function initParticles() {
    particles.length = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * particleCanvas.width,
        y: Math.random() * particleCanvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -Math.random() * 0.4 - 0.1,
        r: Math.random() * 2 + 0.5,
        alpha: Math.random() * 0.4 + 0.1,
        color: Math.random() > 0.5 ? '0,255,255' : '255,136,0',
      });
    }
  }
  initParticles();

  let particleRafId = null;
  function animateParticles() {
    particleRafId = requestAnimationFrame(animateParticles);
    pCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -10) { p.y = particleCanvas.height + 10; p.x = Math.random() * particleCanvas.width; }
      if (p.x < -10) p.x = particleCanvas.width + 10;
      if (p.x > particleCanvas.width + 10) p.x = -10;
      pCtx.beginPath();
      pCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      pCtx.fillStyle = `rgba(${p.color},${p.alpha})`;
      pCtx.fill();
    }
  }
  animateParticles();

  // --- Load the selected car model, then show the lobby ---
  // Only the saved/selected model gates the lobby; the remaining models
  // stream in the background. Anything that needs another model awaits it
  // via modelLoader.ensureLoaded() (preview switch, match start).
  lobbyButtons.style.display = 'none';
  lobbyTitle.style.display = 'none';

  availableModelIds = modelLoader.getAllModelIds();
  // Clamp saved model index
  if (currentModelIndex < 0 || currentModelIndex >= availableModelIds.length) currentModelIndex = 0;

  loadingFill.style.width = '15%';
  await modelLoader.ensureLoaded(availableModelIds[currentModelIndex]);
  loadingFill.style.width = '100%';

  // Kick off the rest without awaiting (never rejects)
  modelLoader.preloadAll();

  // Hide loading, show lobby
  loadingScreen.classList.add('hidden');
  lobbyButtons.style.display = '';
  lobbyTitle.style.display = '';

  // --- Progression: lobby XP display ---
  const lobbyXPDisplay = progression.createLobbyXPDisplay();
  const nameInput = document.getElementById('player-name-input');
  if (nameInput && nameInput.parentNode) {
    nameInput.parentNode.insertBefore(lobbyXPDisplay, nameInput);
  }

  // --- Screen transition helper ---
  function showScreen(el, displayType = 'flex') {
    el.style.display = displayType;
    el.classList.remove('lobby-enter');
    // Force reflow to restart animation
    void el.offsetWidth;
    el.classList.add('lobby-enter');
  }

  // --- Preview setup / teardown ---

  function initPreview() {
    previewRenderer = new THREE.WebGLRenderer({
      canvas: previewCanvas,
      antialias: true,
    });
    const w = previewCanvas.clientWidth;
    const h = previewCanvas.clientHeight;
    previewRenderer.setSize(w, h, false);
    previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    previewRenderer.setClearColor(0x0a0a2e);
    previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    previewRenderer.toneMappingExposure = 1.4;

    previewScene = new THREE.Scene();

    previewCamera = new THREE.PerspectiveCamera(40, w / h, 0.1, 50);
    previewCamera.position.set(5, 3.5, 5);
    previewCamera.lookAt(0, 0.3, 0);

    // Lighting
    const ambient = new THREE.AmbientLight(0x222244, 0.8);
    previewScene.add(ambient);

    const cyanLight = new THREE.PointLight(0x00ffff, 2, 20);
    cyanLight.position.set(4, 4, 3);
    previewScene.add(cyanLight);

    const warmLight = new THREE.PointLight(0xff8844, 1.5, 20);
    warmLight.position.set(-4, 3, -3);
    previewScene.add(warmLight);
  }

  // Monotonic token so a slow model load can't replace a newer selection
  let previewLoadToken = 0;

  function setPreviewCar(variant) {
    const token = ++previewLoadToken;
    const modelId = variant && variant.modelId;

    if (modelId && !modelLoader.isLoaded(modelId)) {
      // Keep showing the current car until the requested model is ready
      modelLoader.ensureLoaded(modelId).then(() => {
        if (token !== previewLoadToken || !previewScene) return;
        applyPreviewCar(variant);
      });
      return;
    }
    applyPreviewCar(variant);
  }

  function applyPreviewCar(variant) {
    // Remove old car mesh
    if (previewCarMesh) {
      previewScene.remove(previewCarMesh);
      disposeObject(previewCarMesh);
      previewCarMesh = null;
    }

    const result = buildCarMesh(variant);
    previewCarMesh = result.mesh;
    previewScene.add(previewCarMesh);
  }

  function updateModelLabel() {
    if (availableModelIds.length > 0 && chosenVariant && chosenVariant.modelId) {
      const name = modelLoader.getModelName(chosenVariant.modelId);
      const isLocked = !progression.isCarUnlocked(currentModelIndex, availableModelIds.length);
      if (isLocked) {
        const unlockLevel = progression.getUnlockLevel(currentModelIndex);
        carModelName.textContent = name + ' (Lvl ' + unlockLevel + ')';
        carModelName.style.color = '#888';
      } else {
        carModelName.textContent = name;
        carModelName.style.color = '';
      }
    } else {
      carModelName.textContent = 'Procedural';
      carModelName.style.color = '';
    }
  }

  function startPreviewLoop() {
    function animate() {
      previewAnimId = requestAnimationFrame(animate);
      if (previewCarMesh) {
        previewCarMesh.rotation.y += 0.01;
      }
      previewRenderer.render(previewScene, previewCamera);
    }
    animate();
  }

  function stopPreview() {
    if (previewAnimId !== null) {
      cancelAnimationFrame(previewAnimId);
      previewAnimId = null;
    }
  }

  function disposePreview() {
    stopPreview();
    if (previewCarMesh) {
      previewScene.remove(previewCarMesh);
      disposeObject(previewCarMesh);
      previewCarMesh = null;
    }
    if (previewRenderer) {
      previewRenderer.dispose();
      previewRenderer = null;
    }
    previewScene = null;
    previewCamera = null;
  }

  function disposeObject(obj) {
    obj.traverse((child) => {
      // GLB geometry is shared with the ModelLoader cache; only dispose per-instance geometry
      if (child.geometry && !(child.geometry.userData && child.geometry.userData.isSharedGeometry)) {
        child.geometry.dispose();
      }
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }

  // --- UI transitions ---

  function getPlayerName() {
    return playerNameInput.value.trim() || '';
  }

  function showCarSelector(mode) {
    selectedMode = mode;
    lobbyButtons.style.display = 'none';
    roomLobby.style.display = 'none';
    showScreen(carSelector);

    initPreview();

    // Use saved model index
    if (availableModelIds.length > 0 && currentModelIndex >= availableModelIds.length) {
      currentModelIndex = 0;
    }
    chosenVariant = generateCarVariant(COLORS.CYAN, availableModelIds);
    if (availableModelIds.length > 0) {
      chosenVariant.modelId = availableModelIds[currentModelIndex];
    }
    setPreviewCar(chosenVariant);
    updateModelLabel();
    startPreviewLoop();
  }

  function hideCarSelector() {
    stopPreview();
    disposePreview();
    carSelector.style.display = 'none';
    showScreen(lobbyButtons);
    selectedMode = null;
    chosenVariant = null;
    // Clear quick match state if backing out
    if (roomCode === '__quickmatch__') {
      roomCode = null;
      selectedQMMode = null;
    }
  }

  function destroyActiveGame() {
    if (activeGame) {
      activeGame.destroy();
      activeGame = null;
      window.game = null;
    }
  }

  function stopQueueTimer() {
    if (queueTimerInterval) {
      clearInterval(queueTimerInterval);
      queueTimerInterval = null;
    }
    queueStartTime = null;
  }

  function returnToLobby() {
    stopQueueTimer();
    destroyActiveGame();
    if (networkManager) {
      networkManager.disconnect();
      networkManager = null;
    }
    lobby.style.display = '';
    startLobbyGamepadPoll();
    if (musicStarted) titleMusic.play().catch(() => {});
    showScreen(lobbyButtons);
    roomLobby.style.display = 'none';
    carSelector.style.display = 'none';
    aiModeSelector.style.display = 'none';
    difficultySelector.style.display = 'none';
    trainingTypeSelector.style.display = 'none';
    trainingDiffSelector.style.display = 'none';
    howtoplayPanel.style.display = 'none';
    lobbySettingsPanel.style.display = 'none';
    changelogPanel.style.display = 'none';
    quickmatchModeSelector.style.display = 'none';
    queueSearching.style.display = 'none';
    roomCode = null;
    selectedRoomMode = null;
    selectedQMMode = null;
    isRoomCreator = false;

    // Update lobby progression display
    progression.updateLobbyDisplay();

    // Restart particle animation if stopped
    if (!particleRafId) animateParticles();
    resizeParticleCanvas();
  }

  function requestFullscreen() {
    const settings = getGeneralSettings();
    if (!settings.autoFullscreen) return;
    try {
      // Already fullscreen (standard or webkit)
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      const el = document.documentElement;
      const rfs = el.requestFullscreen || el.webkitRequestFullscreen;
      if (rfs) {
        const result = rfs.call(el);
        if (result && result.catch) result.catch(() => {});
      }
    } catch (e) {
      // Fullscreen not supported (e.g. iPhone Safari)
    }
  }

  function showWaitingRoom(code, hideCode = false) {
    lobbyButtons.style.display = 'none';
    showScreen(roomLobby);
    roomLobbyOptions.style.display = 'none';
    modeSelector.style.display = 'none';
    quickmatchModeSelector.style.display = 'none';
    queueSearching.style.display = 'none';
    showScreen(waitingRoom);
    roomCodeDisplay.textContent = code;
    btnCopyCode.style.display = hideCode ? 'none' : '';
    roomModeLabel.textContent = selectedRoomMode || '';
    roomStatus.textContent = 'Waiting for players...';
    blueSlots.innerHTML = '';
    orangeSlots.innerHTML = '';
  }

  // --- Render team lobby slots ---

  function renderTeamSlots(slots, network) {
    const myTeam = slots.find(s => s.isYou)?.team;

    blueSlots.innerHTML = '';
    orangeSlots.innerHTML = '';

    for (const s of slots) {
      const div = document.createElement('div');
      div.className = 'team-slot';

      if (s.filled) {
        if (s.isYou) {
          div.classList.add('filled', 'you');
          div.textContent = getPlayerName() || 'You';
        } else {
          div.classList.add('filled');
          div.textContent = s.name || 'Player';
        }
      } else {
        div.classList.add('open');
        if (s.team !== myTeam) {
          div.classList.add('joinable');
          div.textContent = 'Join';
          div.addEventListener('click', () => {
            network.switchTeam();
          });
        } else {
          div.textContent = 'Open';
        }
      }

      if (s.team === 'blue') {
        blueSlots.appendChild(div);
      } else {
        orangeSlots.appendChild(div);
      }
    }
  }

  // --- Copy room code ---
  btnCopyCode.addEventListener('click', () => {
    const code = roomCodeDisplay.textContent;
    if (!code || code === '----') return;
    navigator.clipboard.writeText(code).then(() => {
      btnCopyCode.classList.add('copied');
      btnCopyCode.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => {
        btnCopyCode.classList.remove('copied');
        btnCopyCode.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 2000);
    }).catch(() => {});
  });

  // --- Model readiness gating ---
  // Game.js / CarMeshBuilder fetch models synchronously (modelLoader.getModel),
  // so every variant a match will render must be loaded before `new Game(...)`.
  // Runs fn synchronously when everything is already cached (the common case,
  // since the background preload starts at page load).
  function whenModelsReady(modelIds, fn) {
    const ids = (modelIds || []).filter(Boolean);
    if (ids.every((id) => modelLoader.isLoaded(id))) {
      fn();
      return;
    }
    // A failed load still proceeds: buildCarMesh falls back to the procedural car
    modelLoader.ensureLoadedAll(ids).then(fn, fn);
  }

  function hideLobbyForMatch() {
    lobby.style.display = 'none';
    stopLobbyGamepadPoll();
  }

  // Model ids of every player in a multiplayer 'joined' payload
  function collectJoinedModelIds(data) {
    const ids = [chosenVariant && chosenVariant.modelId];
    const others = (data && data.otherPlayers) || [];
    for (const other of others) {
      if (other && other.variantConfig) ids.push(other.variantConfig.modelId);
    }
    // Legacy 1v1 payload
    if (data && data.opponentVariant) ids.push(data.opponentVariant.modelId);
    return ids;
  }

  // --- Start game (singleplayer, freeplay, or multiplayer after room is ready) ---

  function startGame() {
    destroyActiveGame();
    stopPreview();
    disposePreview();
    carSelector.style.display = 'none';
    titleMusic.pause();
    toast.style.opacity = '0';
    toast.style.pointerEvents = 'none';
    clearTimeout(toastTimer);

    // Stop particle animation during game
    if (particleRafId) {
      cancelAnimationFrame(particleRafId);
      particleRafId = null;
    }

    // Save car selection
    if (availableModelIds.length > 0) {
      localStorage.setItem(CAR_MODEL_KEY, String(currentModelIndex));
    }

    const selectedArena = ARENA_THEMES[currentArenaIndex];
    const localModelId = chosenVariant && chosenVariant.modelId;

    // Offline modes: AI cars pick from modelLoader.getModelIds() (loaded models
    // only), so the player's own model is the only one that must be awaited.
    if (selectedMode === 'singleplayer') {
      hideLobbyForMatch();
      requestFullscreen();
      whenModelsReady([localModelId], () => {
        const game = new Game(canvas, { mode: 'singleplayer', playerVariant: chosenVariant, aiDifficulty: selectedDifficulty, aiMode: selectedAIMode, arenaTheme: selectedArena });
        game.hud.onBackToLobby = () => returnToLobby();
        // Rematch with the same mode / difficulty / car / arena
        game.hud.onPlayAgain = () => startGame();
        game.hud.playAgainLabel = 'Rematch';
        activeGame = game;
        window.game = game;
      });
      return;
    }

    if (selectedMode === 'freeplay') {
      hideLobbyForMatch();
      requestFullscreen();
      whenModelsReady([localModelId], () => {
        const game = new Game(canvas, { mode: 'freeplay', playerVariant: chosenVariant, arenaTheme: selectedArena });
        game.hud.onBackToLobby = () => returnToLobby();
        activeGame = game;
        window.game = game;
      });
      return;
    }

    if (selectedMode === 'training') {
      hideLobbyForMatch();
      requestFullscreen();
      whenModelsReady([localModelId], () => {
        const game = new Game(canvas, { mode: 'training', playerVariant: chosenVariant, trainingOpts: { type: selectedTrainingType, difficulty: selectedTrainingDifficulty }, arenaTheme: selectedArena });
        game.hud.onBackToLobby = () => returnToLobby();
        activeGame = game;
        window.game = game;
      });
      return;
    }

    // Multiplayer: show connecting state immediately, then connect
    const isQuickMatch = roomCode === '__quickmatch__';

    if (isQuickMatch) {
      // Show queue searching UI
      lobbyButtons.style.display = 'none';
      showScreen(roomLobby);
      roomLobbyOptions.style.display = 'none';
      modeSelector.style.display = 'none';
      waitingRoom.style.display = 'none';
      quickmatchModeSelector.style.display = 'none';
      showScreen(queueSearching);
      queueTimerEl.textContent = '0:00';
      queueInfoEl.textContent = '';
      queueStartTime = Date.now();
      queueTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - queueStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        queueTimerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      }, 1000);
    } else {
      showWaitingRoom(isRoomCreator ? '...' : roomCode, false);
      roomStatus.textContent = 'Connecting...';
    }

    const network = new NetworkManager();
    networkManager = network;

    network.on('connected', () => {
      const variant = chosenVariant || generateCarVariant(COLORS.CYAN, availableModelIds);
      const name = getPlayerName();

      if (isQuickMatch) {
        network.quickMatch(variant, name, selectedQMMode || '1v1');
      } else if (isRoomCreator) {
        network.createRoom(selectedRoomMode, variant, name);
      } else {
        network.joinRoom(roomCode, variant, name);
      }
    });

    network.on('roomCreated', (data) => {
      roomCode = data.code;
      roomCodeDisplay.textContent = data.code;
      roomStatus.textContent = 'Waiting for players...';
    });

    network.on('queueUpdate', (data) => {
      queueInfoEl.textContent = `${data.playersInQueue}/${data.playersNeeded} players found`;
    });

    network.on('matchFound', () => {
      // Match found! The server will follow up with a 'joined' event.
      // Stop the timer, update the status text.
      stopQueueTimer();
      queueSearching.querySelector('.queue-status-text').textContent = 'Match found!';
      queueInfoEl.textContent = 'Starting game...';
    });

    network.on('lobbyUpdate', (data) => {
      // If we were in queue searching, switch to waiting room view
      if (queueSearching.style.display !== 'none') {
        stopQueueTimer();
        queueSearching.style.display = 'none';
      }
      if (waitingRoom.style.display === 'none' && !isQuickMatch) {
        showScreen(waitingRoom);
      }
      roomStatus.textContent = `Waiting for players... (${data.playerCount}/${data.maxPlayers})`;
      if (data.mode) {
        roomModeLabel.textContent = data.mode;
      }
      if (data.slots) {
        renderTeamSlots(data.slots, network);
      }
    });

    network.on('joinError', (data) => {
      stopQueueTimer();
      alert(data.message);
      returnToLobby();
    });

    network.on('roomExpired', () => {
      stopQueueTimer();
      alert('Room expired');
      returnToLobby();
    });

    network.on('joined', (data) => {
      // All players are in - launch the game
      stopQueueTimer();
      hideLobbyForMatch();
      requestFullscreen();
      // Every player's car model must be cached before Game builds the cars
      whenModelsReady(collectJoinedModelIds(data), () => {
        // Bail if the connection was torn down while a model was still loading
        if (networkManager !== network) return;
        const game = new Game(canvas, { mode: 'multiplayer', networkManager: network, playerVariant: chosenVariant, joinedData: data, arenaTheme: selectedArena });
        game.hud.onBackToLobby = () => returnToLobby();
        if (isQuickMatch) {
          // Re-queue for the same mode straight from the results screen
          const qmMode = selectedQMMode || '1v1';
          game.hud.onPlayAgain = () => {
            returnToLobby();
            selectedMode = 'multiplayer';
            selectedQMMode = qmMode;
            selectedRoomMode = qmMode;
            roomCode = '__quickmatch__';
            isRoomCreator = false;
            startGame();
          };
          game.hud.playAgainLabel = 'Find New Match';
        }
        // The server tears the room down 30s after the whistle: give players
        // time to read the results, less if someone already left.
        game.onMatchEnd = (reason) => {
          game.hud.startAutoReturn(reason === 'gameOver' ? 15 : 4);
        };
        activeGame = game;
        window.game = game;
        networkManager = null; // Game owns the network now
      });
    });

    network.on('playerDisconnected', (data) => {
      // Show a toast notification that a player was replaced by a bot
      const toast = document.createElement('div');
      toast.className = 'disconnect-toast';
      toast.textContent = data.message || 'A player disconnected';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4500);
    });

    network.on('playerId', (data) => {
      if (data && data.playerId) {
        localPlayerId = data.playerId;
        localStorage.setItem(PLAYER_ID_KEY, data.playerId);
        // Sync progression from server (source of truth)
        progression.syncFromServer(data);
      }
    });

    network.on('progression', (data) => {
      progression.syncFromServer(data);
    });

    network.on('disconnected', () => {
      stopQueueTimer();
      if (!activeGame) {
        returnToLobby();
      }
    });

    network.connect(localPlayerId, playerNameInput.value.trim());
  }

  // --- Button handlers ---

  // "Play vs AI" → show AI mode selector (1v1 / 2v2)
  btnSingle.addEventListener('click', () => {
    lobbyButtons.style.display = 'none';
    showScreen(aiModeSelector);
  });

  // "Free Play" → car selector → freeplay
  btnFreeplay.addEventListener('click', () => {
    showCarSelector('freeplay');
  });

  // "Training" → show training type selector
  btnTraining.addEventListener('click', () => {
    lobbyButtons.style.display = 'none';
    showScreen(trainingTypeSelector);
  });

  if (btnTrainStriker) {
    btnTrainStriker.addEventListener('click', () => {
      selectedTrainingType = 'striker';
      trainingTypeSelector.style.display = 'none';
      showScreen(trainingDiffSelector);
    });
  }

  btnTrainGoalie.addEventListener('click', () => {
    selectedTrainingType = 'goalie';
    trainingTypeSelector.style.display = 'none';
    showScreen(trainingDiffSelector);
  });

  btnTrainAerial.addEventListener('click', () => {
    selectedTrainingType = 'aerial';
    trainingTypeSelector.style.display = 'none';
    showScreen(trainingDiffSelector);
  });

  btnTrainTypeBack.addEventListener('click', () => {
    trainingTypeSelector.style.display = 'none';
    showScreen(lobbyButtons);
  });

  btnTrainDiffRookie.addEventListener('click', () => {
    selectedTrainingDifficulty = 'rookie';
    trainingDiffSelector.style.display = 'none';
    showCarSelector('training');
  });

  btnTrainDiffPro.addEventListener('click', () => {
    selectedTrainingDifficulty = 'pro';
    trainingDiffSelector.style.display = 'none';
    showCarSelector('training');
  });

  btnTrainDiffAllstar.addEventListener('click', () => {
    selectedTrainingDifficulty = 'allstar';
    trainingDiffSelector.style.display = 'none';
    showCarSelector('training');
  });

  btnTrainDiffBack.addEventListener('click', () => {
    trainingDiffSelector.style.display = 'none';
    showScreen(trainingTypeSelector);
  });

  btnAI1v1.addEventListener('click', () => {
    selectedAIMode = '1v1';
    aiModeSelector.style.display = 'none';
    showScreen(difficultySelector);
  });

  btnAI2v2.addEventListener('click', () => {
    selectedAIMode = '2v2';
    aiModeSelector.style.display = 'none';
    showScreen(difficultySelector);
  });

  btnAIModeBack.addEventListener('click', () => {
    aiModeSelector.style.display = 'none';
    showScreen(lobbyButtons);
  });

  btnDiffRookie.addEventListener('click', () => {
    selectedDifficulty = 'rookie';
    difficultySelector.style.display = 'none';
    showCarSelector('singleplayer');
  });

  btnDiffPro.addEventListener('click', () => {
    selectedDifficulty = 'pro';
    difficultySelector.style.display = 'none';
    showCarSelector('singleplayer');
  });

  btnDiffAllstar.addEventListener('click', () => {
    selectedDifficulty = 'allstar';
    difficultySelector.style.display = 'none';
    showCarSelector('singleplayer');
  });

  btnDiffBack.addEventListener('click', () => {
    difficultySelector.style.display = 'none';
    showScreen(aiModeSelector);
  });

  // "Play Online" → show room lobby
  btnMulti.addEventListener('click', () => {
    lobbyButtons.style.display = 'none';
    showScreen(roomLobby);
    roomLobbyOptions.style.display = 'flex';
    modeSelector.style.display = 'none';
    waitingRoom.style.display = 'none';
    roomCodeInput.value = '';
  });

  // "Quick Match" -> show mode selector for quick match
  btnQuickMatch.addEventListener('click', () => {
    roomLobbyOptions.style.display = 'none';
    showScreen(quickmatchModeSelector);
  });

  // Quick match mode selection
  btnQM1v1.addEventListener('click', () => {
    selectedQMMode = '1v1';
    quickmatchModeSelector.style.display = 'none';
    isRoomCreator = false;
    selectedRoomMode = '1v1';
    roomCode = '__quickmatch__';
    showCarSelector('multiplayer');
  });

  btnQM2v2.addEventListener('click', () => {
    selectedQMMode = '2v2';
    quickmatchModeSelector.style.display = 'none';
    isRoomCreator = false;
    selectedRoomMode = '2v2';
    roomCode = '__quickmatch__';
    showCarSelector('multiplayer');
  });

  btnQMModeBack.addEventListener('click', () => {
    quickmatchModeSelector.style.display = 'none';
    roomLobbyOptions.style.display = 'flex';
  });

  // "Create Room" → show mode selector
  btnCreateRoom.addEventListener('click', () => {
    isRoomCreator = true;
    roomLobbyOptions.style.display = 'none';
    showScreen(modeSelector);
  });

  // Mode selection → car selector
  btnMode1v1.addEventListener('click', () => {
    selectedRoomMode = '1v1';
    showCarSelector('multiplayer');
  });

  btnMode2v2.addEventListener('click', () => {
    selectedRoomMode = '2v2';
    showCarSelector('multiplayer');
  });

  // "Join Room" → validate code → car selector
  btnJoinRoom.addEventListener('click', () => {
    const code = roomCodeInput.value.toUpperCase().trim();
    if (code.length !== 4) return;
    isRoomCreator = false;
    roomCode = code;
    showCarSelector('multiplayer');
  });

  // Auto-uppercase room code input
  roomCodeInput.addEventListener('input', () => {
    roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  // Cancel queue button
  btnCancelQueue.addEventListener('click', () => {
    stopQueueTimer();
    if (networkManager) {
      networkManager.cancelQueue();
      networkManager.disconnect();
      networkManager = null;
    }
    returnToLobby();
  });

  // Room lobby back button
  btnRoomBack.addEventListener('click', () => {
    stopQueueTimer();
    if (networkManager) {
      networkManager.disconnect();
      networkManager = null;
    }
    roomLobby.style.display = 'none';
    showScreen(lobbyButtons);
    roomCode = null;
    selectedRoomMode = null;
    selectedQMMode = null;
  });

  // How to Play
  const lobbyMusicControls = document.getElementById('lobby-music-controls');

  btnHowToPlay.addEventListener('click', () => {
    lobbyButtons.style.display = 'none';
    lobbyMusicControls.classList.add('hidden');
    showScreen(howtoplayPanel);
  });

  btnHowToPlayClose.addEventListener('click', () => {
    howtoplayPanel.style.display = 'none';
    lobbyMusicControls.classList.remove('hidden');
    showScreen(lobbyButtons);
  });

  // Lobby Settings
  btnLobbySettings.addEventListener('click', () => {
    lobbyButtons.style.display = 'none';
    lobbyMusicControls.classList.add('hidden');
    showScreen(lobbySettingsPanel);
  });

  btnLobbySettingsClose.addEventListener('click', () => {
    lobbySettings.cancelAnyRebind();
    lobbySettings.flushSaves();
    lobbySettingsPanel.style.display = 'none';
    lobbyMusicControls.classList.remove('hidden');
    showScreen(lobbyButtons);
  });

  // Changelog
  btnChangelog.addEventListener('click', () => {
    lobbyButtons.style.display = 'none';
    lobbyMusicControls.classList.add('hidden');
    showScreen(changelogPanel);
  });

  btnChangelogClose.addEventListener('click', () => {
    changelogPanel.style.display = 'none';
    lobbyMusicControls.classList.remove('hidden');
    showScreen(lobbyButtons);
  });

  // Prev/Next model buttons
  // Engine rev preview state
  let _enginePreviewTimeout = null;
  let _enginePreviewActive = false;

  function previewCarEngine(modelId) {
    // Switch engine profile and do a brief rev: idle → mid RPM → back to idle
    audioManager.setCarModel(modelId);

    // Clear any pending rev-down
    if (_enginePreviewTimeout) clearTimeout(_enginePreviewTimeout);

    // Rev up to ~60% immediately
    audioManager.setEngineSpeed(28, 46);
    _enginePreviewActive = true;

    // After 400ms, ramp back down to idle
    _enginePreviewTimeout = setTimeout(() => {
      audioManager.setEngineSpeed(5, 46);
      // Settle to idle after another 600ms
      _enginePreviewTimeout = setTimeout(() => {
        audioManager.setEngineSpeed(0, 46);
        _enginePreviewActive = false;
      }, 600);
    }, 400);
  }

  btnPrevModel.addEventListener('click', () => {
    if (availableModelIds.length === 0) return;
    currentModelIndex = (currentModelIndex - 1 + availableModelIds.length) % availableModelIds.length;
    chosenVariant.modelId = availableModelIds[currentModelIndex];
    setPreviewCar(chosenVariant);
    updateModelLabel();
    previewCarEngine(chosenVariant.modelId);
  });

  btnNextModel.addEventListener('click', () => {
    if (availableModelIds.length === 0) return;
    currentModelIndex = (currentModelIndex + 1) % availableModelIds.length;
    chosenVariant.modelId = availableModelIds[currentModelIndex];
    setPreviewCar(chosenVariant);
    updateModelLabel();
    previewCarEngine(chosenVariant.modelId);
  });

  btnPrevArena.addEventListener('click', () => {
    currentArenaIndex = (currentArenaIndex - 1 + ARENA_THEMES.length) % ARENA_THEMES.length;
    arenaNameEl.textContent = ARENA_THEMES[currentArenaIndex].name;
  });

  btnNextArena.addEventListener('click', () => {
    currentArenaIndex = (currentArenaIndex + 1) % ARENA_THEMES.length;
    arenaNameEl.textContent = ARENA_THEMES[currentArenaIndex].name;
  });

  btnLetsGo.addEventListener('click', () => {
    // Prevent starting with a locked car
    if (availableModelIds.length > 0 && !progression.isCarUnlocked(currentModelIndex, availableModelIds.length)) {
      const unlockLevel = progression.getUnlockLevel(currentModelIndex);
      carModelName.textContent = 'Unlocks at Level ' + unlockLevel + '!';
      carModelName.style.color = '#ff4444';
      setTimeout(() => updateModelLabel(), 1500);
      return;
    }
    startGame();
  });

  btnBack.addEventListener('click', () => {
    hideCarSelector();
  });

  // ========== GAMEPAD LOBBY NAVIGATION ==========
  // Polls at 20Hz only while the lobby is visible (start/stop are wired to
  // lobby show/hide). The focusable-button list is cached and only rebuilt
  // after the lobby DOM changes (screen switch, slot re-render, focus move).
  {
    const GP_POLL_MS = 50; // 20Hz: fast enough for edge-detected button taps
    let gpFocusIdx = 0;
    let gpFocusEl = null;
    let gpPrevUp = false, gpPrevDown = false, gpPrevLeft = false, gpPrevRight = false;
    let gpPrevA = false, gpPrevB = false;
    const STICK_THRESHOLD = 0.5;

    let gpPollTimer = null;
    let gpRefocusTimer = null;
    let gpButtons = [];
    let gpButtonsDirty = true;

    // Any style/class/child change in the lobby may change which buttons are
    // visible; just flag the cache and let the next poll tick rebuild it.
    const gpDomObserver = new MutationObserver(() => { gpButtonsDirty = true; });
    gpDomObserver.observe(lobby, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'disabled'],
    });

    // Focusable controls, in DOM order. Besides the lobby buttons this covers
    // the settings panel: tabs, key/pad bind buttons, reset buttons, sliders
    // and checkboxes, so the whole panel is reachable from a controller.
    const GP_FOCUSABLE = '.lobby-btn, .lobby-btn-nav, .lobby-link-btn, .gs-tab, .gs-bind-key, .cs-reset, .cs-slider, .cs-row input[type="checkbox"]';
    // Controls that act in place (no screen change) when pressed with A
    const GP_IN_PLACE = '.gs-tab, .gs-bind-key, .cs-reset, .cs-slider, input';

    // Get all visible, clickable buttons on the current lobby screen (cached)
    function getVisibleButtons() {
      if (!gpButtonsDirty) return gpButtons;
      const btns = [];
      lobby.querySelectorAll(GP_FOCUSABLE).forEach(el => {
        if (el.offsetParent !== null && !el.disabled && el.style.display !== 'none') {
          btns.push(el);
        }
      });
      gpButtons = btns;
      gpButtonsDirty = false;
      return btns;
    }

    // Left/right on the focused control. Returns true when the input was
    // consumed (so the caller doesn't also move focus).
    function gpAdjustFocused(el, dir) {
      if (!el) return false;
      if (el.classList.contains('lobby-btn-nav')) {
        el.click();
        return true;
      }
      if (el.tagName === 'INPUT' && el.type === 'range') {
        if (dir < 0) el.stepDown(); else el.stepUp();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (el.classList.contains('gs-tab')) {
        const sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
        if (sib && sib.classList.contains('gs-tab')) {
          sib.click();
          gpButtonsDirty = true;
          const list = getVisibleButtons();
          setGpFocus(list, Math.max(0, list.indexOf(sib)));
        }
        return true;
      }
      return false;
    }

    function setGpFocus(btns, idx) {
      // Remove previous focus (this code is the only writer of .gp-focus)
      if (gpFocusEl) {
        gpFocusEl.classList.remove('gp-focus');
        gpFocusEl = null;
      }
      if (btns.length === 0) return;
      gpFocusIdx = ((idx % btns.length) + btns.length) % btns.length;
      gpFocusEl = btns[gpFocusIdx];
      gpFocusEl.classList.add('gp-focus');
      gpFocusEl.scrollIntoView({ block: 'nearest' });
    }

    // After a click changes screens, refocus the first button of the new screen
    function scheduleRefocus() {
      gpFocusIdx = 0;
      if (gpRefocusTimer) clearTimeout(gpRefocusTimer);
      gpRefocusTimer = setTimeout(() => {
        gpRefocusTimer = null;
        gpButtonsDirty = true;
        const newBtns = getVisibleButtons();
        if (newBtns.length > 0) setGpFocus(newBtns, 0);
      }, 100);
    }

    function pollLobbyGamepad() {
      if (document.hidden || lobby.style.display === 'none') return;

      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp = null;
      for (const g of gamepads) {
        if (g) { gp = g; break; }
      }

      if (!gp) return;

      // Read inputs
      const stickY = gp.axes[1] || 0;
      const stickX = gp.axes[0] || 0;
      const dpadUp = gp.buttons[12] ? gp.buttons[12].pressed : false;
      const dpadDown = gp.buttons[13] ? gp.buttons[13].pressed : false;
      const dpadLeft = gp.buttons[14] ? gp.buttons[14].pressed : false;
      const dpadRight = gp.buttons[15] ? gp.buttons[15].pressed : false;
      const aBtn = gp.buttons[0] ? gp.buttons[0].pressed : false;
      const bBtn = gp.buttons[1] ? gp.buttons[1].pressed : false;

      const up = dpadUp || stickY < -STICK_THRESHOLD;
      const down = dpadDown || stickY > STICK_THRESHOLD;
      const left = dpadLeft || stickX < -STICK_THRESHOLD;
      const right = dpadRight || stickX > STICK_THRESHOLD;

      const btns = getVisibleButtons();

      // Navigate
      if (up && !gpPrevUp && btns.length > 0) {
        setGpFocus(btns, gpFocusIdx - 1);
      }
      if (down && !gpPrevDown && btns.length > 0) {
        setGpFocus(btns, gpFocusIdx + 1);
      }
      // Left/right: nav buttons (car/arena), sliders and tabs act in place;
      // anything else just moves focus.
      if (left && !gpPrevLeft && btns.length > 0) {
        if (!gpAdjustFocused(btns[gpFocusIdx], -1)) setGpFocus(btns, gpFocusIdx - 1);
      }
      if (right && !gpPrevRight && btns.length > 0) {
        if (!gpAdjustFocused(btns[gpFocusIdx], 1)) setGpFocus(btns, gpFocusIdx + 1);
      }

      // A = select
      if (aBtn && !gpPrevA && btns.length > 0) {
        const cur = btns[gpFocusIdx];
        if (cur) {
          if (cur.matches(GP_IN_PLACE)) {
            // Toggle / activate without losing our place in the panel
            if (!(cur.tagName === 'INPUT' && cur.type === 'range')) cur.click();
            gpButtonsDirty = true;
            const list = getVisibleButtons();
            const idx = list.indexOf(cur);
            if (idx >= 0) setGpFocus(list, idx);
          } else {
            cur.click();
            // Reset focus for new screen
            scheduleRefocus();
          }
        }
      }

      // B = back (click the visible back button, if any)
      if (bBtn && !gpPrevB) {
        const backBtn = btns.find(el => el.classList.contains('lobby-btn-back'));
        if (backBtn) {
          backBtn.click();
          scheduleRefocus();
        }
      }

      // Show focus if nothing is focused yet
      if (btns.length > 0 && (!gpFocusEl || !gpFocusEl.isConnected)) {
        setGpFocus(btns, gpFocusIdx);
      }

      gpPrevUp = up;
      gpPrevDown = down;
      gpPrevLeft = left;
      gpPrevRight = right;
      gpPrevA = aBtn;
      gpPrevB = bBtn;
    }

    startLobbyGamepadPoll = () => {
      if (gpPollTimer !== null) return;
      gpButtonsDirty = true;
      gpPollTimer = setInterval(pollLobbyGamepad, GP_POLL_MS);
    };

    stopLobbyGamepadPoll = () => {
      if (gpPollTimer !== null) {
        clearInterval(gpPollTimer);
        gpPollTimer = null;
      }
      if (gpRefocusTimer) {
        clearTimeout(gpRefocusTimer);
        gpRefocusTimer = null;
      }
    };

    // Lobby is visible at this point (loading finished above)
    startLobbyGamepadPoll();
  }
});
