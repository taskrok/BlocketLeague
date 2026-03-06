// ============================================
// Blocket League - Entry Point
// ============================================

import * as THREE from 'three';
import { Game } from './Game.js';
import { NetworkManager } from './NetworkManager.js';
import { generateCarVariant } from './CarVariants.js';
import { buildCarMesh } from './CarMeshBuilder.js';
import { modelLoader } from './ModelLoader.js';
import { COLORS } from '../../shared/constants.js';
import { getGeneralSettings } from './GameSettings.js';
import { ARENA_THEMES } from './ArenaThemes.js';

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

  // Random name pool
  const RANDOM_NAMES = [
    'Donut','Penguin','Stumpy','Whicker','Shadow','Howard','Wilshire','Darling',
    'Disco','Jack','The Bear','Sneak','The Big L','Whisp','Wheezy','Crazy',
    'Goat','Pirate','Saucy','Hambone','Butcher','Walla Walla','Snake','Caboose',
    'Sleepy','Killer','Stompy','Mopey','Dopey','Weasel','Ghost','Dasher',
    'Grumpy','Hollywood','Tooth','Noodle','King','Cupid','Prancer',
  ];

  function pickRandomName() {
    return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
  }

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
  const settingAutoFullscreen = document.getElementById('setting-auto-fullscreen');

  // Init lobby settings from stored values
  const initGeneralSettings = getGeneralSettings();
  settingAutoFullscreen.checked = initGeneralSettings.autoFullscreen;

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

  // Lobby music controls
  lobbySkipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!musicStarted) startMusic();
    skipTrack();
  });

  lobbyVolumeSlider.addEventListener('input', () => {
    const v = parseFloat(lobbyVolumeSlider.value);
    titleMusic.volume = v;
    try {
      localStorage.setItem('blocket-audio-settings', JSON.stringify({ musicVolume: v }));
    } catch {}
  });

  // Room lobby state
  let selectedRoomMode = null; // '1v1' | '2v2'
  let roomCode = null;
  let isRoomCreator = false;
  let networkManager = null;

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

  // --- Preload models ---
  // Hide lobby content while loading
  lobbyButtons.style.display = 'none';
  lobbyTitle.style.display = 'none';

  await modelLoader.preloadAll((loaded, total) => {
    const pct = Math.round((loaded / total) * 100);
    loadingFill.style.width = pct + '%';
  });

  availableModelIds = modelLoader.getModelIds();
  // Clamp saved model index
  if (currentModelIndex >= availableModelIds.length) currentModelIndex = 0;

  // Hide loading, show lobby
  loadingScreen.classList.add('hidden');
  lobbyButtons.style.display = '';
  lobbyTitle.style.display = '';

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

  function setPreviewCar(variant) {
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
      carModelName.textContent = modelLoader.getModelName(chosenVariant.modelId);
    } else {
      carModelName.textContent = 'Procedural';
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
      if (child.geometry) child.geometry.dispose();
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
  }

  function destroyActiveGame() {
    if (activeGame) {
      activeGame.destroy();
      activeGame = null;
      window.game = null;
    }
  }

  function returnToLobby() {
    destroyActiveGame();
    if (networkManager) {
      networkManager.disconnect();
      networkManager = null;
    }
    lobby.style.display = '';
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
    roomCode = null;
    selectedRoomMode = null;
    isRoomCreator = false;

    // Restart particle animation if stopped
    if (!particleRafId) animateParticles();
    resizeParticleCanvas();
  }

  function requestFullscreen() {
    const settings = getGeneralSettings();
    if (!settings.autoFullscreen) return;
    try {
      const el = document.documentElement;
      const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
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

    if (selectedMode === 'singleplayer') {
      lobby.style.display = 'none';
      requestFullscreen();
      const game = new Game(canvas, 'singleplayer', null, chosenVariant, null, selectedDifficulty, selectedAIMode, null, selectedArena);
      game.hud.onBackToLobby = () => returnToLobby();
      activeGame = game;
      window.game = game;
      return;
    }

    if (selectedMode === 'freeplay') {
      lobby.style.display = 'none';
      requestFullscreen();
      const game = new Game(canvas, 'freeplay', null, chosenVariant, null, 'pro', '1v1', null, selectedArena);
      game.hud.onBackToLobby = () => returnToLobby();
      activeGame = game;
      window.game = game;
      return;
    }

    if (selectedMode === 'training') {
      lobby.style.display = 'none';
      requestFullscreen();
      const game = new Game(canvas, 'training', null, chosenVariant, null, 'pro', '1v1', {
        type: selectedTrainingType,
        difficulty: selectedTrainingDifficulty,
      }, selectedArena);
      game.hud.onBackToLobby = () => returnToLobby();
      activeGame = game;
      window.game = game;
      return;
    }

    // Multiplayer: show connecting state immediately, then connect
    const isQuickMatch = roomCode === '__quickmatch__';
    showWaitingRoom(isQuickMatch ? 'Searching...' : (isRoomCreator ? '...' : roomCode), isQuickMatch);
    roomStatus.textContent = isQuickMatch ? 'Finding a match...' : 'Connecting...';

    const network = new NetworkManager();
    networkManager = network;

    network.on('connected', () => {
      const variant = chosenVariant || generateCarVariant(COLORS.CYAN, availableModelIds);
      const name = getPlayerName();

      if (roomCode === '__quickmatch__') {
        network.quickMatch(variant, name);
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

    network.on('lobbyUpdate', (data) => {
      roomStatus.textContent = `Waiting for players... (${data.playerCount}/${data.maxPlayers})`;
      if (data.mode) {
        roomModeLabel.textContent = data.mode;
      }
      if (data.slots) {
        renderTeamSlots(data.slots, network);
      }
    });

    network.on('joinError', (data) => {
      alert(data.message);
      returnToLobby();
    });

    network.on('roomExpired', () => {
      alert('Room expired');
      returnToLobby();
    });

    network.on('joined', (data) => {
      // All players are in — launch the game
      lobby.style.display = 'none';
      requestFullscreen();
      const game = new Game(canvas, 'multiplayer', network, chosenVariant, data, 'pro', '1v1', null, selectedArena);
      game.hud.onBackToLobby = () => returnToLobby();
      game.onMatchEnd = () => {
        setTimeout(() => returnToLobby(), 4000);
      };
      activeGame = game;
      window.game = game;
      networkManager = null; // Game owns the network now
    });

    network.on('disconnected', () => {
      if (!activeGame) {
        returnToLobby();
      }
    });

    network.connect();
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

  // "Quick Match" → connect and auto-find a room
  btnQuickMatch.addEventListener('click', () => {
    isRoomCreator = false;
    selectedRoomMode = '1v1';
    showCarSelector('multiplayer');
    // Will emit quickMatch on connect instead of joinRoom
    roomCode = '__quickmatch__';
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

  // Room lobby back button
  btnRoomBack.addEventListener('click', () => {
    if (networkManager) {
      networkManager.disconnect();
      networkManager = null;
    }
    roomLobby.style.display = 'none';
    showScreen(lobbyButtons);
    roomCode = null;
    selectedRoomMode = null;
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

  settingAutoFullscreen.addEventListener('change', () => {
    const settings = getGeneralSettings();
    settings.autoFullscreen = settingAutoFullscreen.checked;
    localStorage.setItem('blocket-general-settings', JSON.stringify(settings));
  });

  // Prev/Next model buttons
  btnPrevModel.addEventListener('click', () => {
    if (availableModelIds.length === 0) return;
    currentModelIndex = (currentModelIndex - 1 + availableModelIds.length) % availableModelIds.length;
    chosenVariant.modelId = availableModelIds[currentModelIndex];
    setPreviewCar(chosenVariant);
    updateModelLabel();
  });

  btnNextModel.addEventListener('click', () => {
    if (availableModelIds.length === 0) return;
    currentModelIndex = (currentModelIndex + 1) % availableModelIds.length;
    chosenVariant.modelId = availableModelIds[currentModelIndex];
    setPreviewCar(chosenVariant);
    updateModelLabel();
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
    startGame();
  });

  btnBack.addEventListener('click', () => {
    hideCarSelector();
  });

  // ========== GAMEPAD LOBBY NAVIGATION ==========
  {
    let gpFocusIdx = 0;
    let gpPrevUp = false, gpPrevDown = false, gpPrevLeft = false, gpPrevRight = false;
    let gpPrevA = false, gpPrevB = false;
    const STICK_THRESHOLD = 0.5;

    // Get all visible, clickable buttons on the current lobby screen
    function getVisibleButtons() {
      const btns = [];
      lobby.querySelectorAll('.lobby-btn, .lobby-btn-nav, .lobby-link-btn').forEach(el => {
        if (el.offsetParent !== null && !el.disabled && el.style.display !== 'none') {
          btns.push(el);
        }
      });
      return btns;
    }

    function setGpFocus(btns, idx) {
      // Remove previous focus
      lobby.querySelectorAll('.gp-focus').forEach(el => el.classList.remove('gp-focus'));
      if (btns.length === 0) return;
      gpFocusIdx = ((idx % btns.length) + btns.length) % btns.length;
      btns[gpFocusIdx].classList.add('gp-focus');
      btns[gpFocusIdx].scrollIntoView({ block: 'nearest' });
    }

    function pollLobbyGamepad() {
      // Only poll when lobby is visible
      if (lobby.style.display === 'none') {
        requestAnimationFrame(pollLobbyGamepad);
        return;
      }

      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp = null;
      for (const g of gamepads) {
        if (g) { gp = g; break; }
      }

      if (!gp) {
        requestAnimationFrame(pollLobbyGamepad);
        return;
      }

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
      // Left/right for nav buttons (car/arena selectors)
      if (left && !gpPrevLeft && btns.length > 0) {
        const cur = btns[gpFocusIdx];
        if (cur && cur.classList.contains('lobby-btn-nav')) {
          cur.click();
        } else {
          // Find prev nav button or just navigate up
          setGpFocus(btns, gpFocusIdx - 1);
        }
      }
      if (right && !gpPrevRight && btns.length > 0) {
        const cur = btns[gpFocusIdx];
        if (cur && cur.classList.contains('lobby-btn-nav')) {
          cur.click();
        } else {
          setGpFocus(btns, gpFocusIdx + 1);
        }
      }

      // A = select
      if (aBtn && !gpPrevA && btns.length > 0) {
        if (gpFocusIdx < btns.length) {
          btns[gpFocusIdx].click();
          // Reset focus for new screen
          gpFocusIdx = 0;
          setTimeout(() => {
            const newBtns = getVisibleButtons();
            if (newBtns.length > 0) setGpFocus(newBtns, 0);
          }, 100);
        }
      }

      // B = back (find visible back button and click it)
      if (bBtn && !gpPrevB) {
        const backBtn = lobby.querySelector('.lobby-btn-back:not([style*="display: none"])');
        if (backBtn && backBtn.offsetParent !== null) {
          backBtn.click();
          gpFocusIdx = 0;
          setTimeout(() => {
            const newBtns = getVisibleButtons();
            if (newBtns.length > 0) setGpFocus(newBtns, 0);
          }, 100);
        }
      }

      // Show focus if not already visible
      if (btns.length > 0 && !lobby.querySelector('.gp-focus')) {
        setGpFocus(btns, gpFocusIdx);
      }

      gpPrevUp = up;
      gpPrevDown = down;
      gpPrevLeft = left;
      gpPrevRight = right;
      gpPrevA = aBtn;
      gpPrevB = bBtn;

      requestAnimationFrame(pollLobbyGamepad);
    }

    requestAnimationFrame(pollLobbyGamepad);
  }
});
