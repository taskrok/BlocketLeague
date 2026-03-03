// ============================================
// Camera Settings - In-game settings panel for camera tuning
// Desktop: Escape to toggle | Mobile: gear icon
// ============================================

const STORAGE_KEY = 'blocket-camera-settings';

const DEFAULTS = {
  fov: 70,
  distance: 10,
  height: 4,
  smoothness: 5,
};

const SLIDER_CONFIG = [
  { key: 'fov',        label: 'FOV',        min: 50,  max: 110, step: 1   },
  { key: 'distance',   label: 'Distance',   min: 5,   max: 25,  step: 0.5 },
  { key: 'height',     label: 'Height',     min: 1,   max: 12,  step: 0.5 },
  { key: 'smoothness', label: 'Smoothness', min: 1,   max: 15,  step: 0.5 },
];

export class CameraSettings {
  constructor(cameraController) {
    this.controller = cameraController;
    this.open = false;
    this.values = { ...DEFAULTS };
    this.sliders = {};

    this._loadFromStorage();
    this._buildDOM();
    this._bindEvents();

    // Apply loaded settings immediately
    this.controller.setSettings(this.values);
  }

  _loadFromStorage() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        for (const key of Object.keys(DEFAULTS)) {
          if (typeof parsed[key] === 'number') {
            this.values[key] = parsed[key];
          }
        }
      }
    } catch { /* ignore corrupt data */ }
  }

  _save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
  }

  _buildDOM() {
    // Gear icon (mobile)
    this.gearBtn = document.createElement('button');
    this.gearBtn.id = 'camera-settings-gear';
    this.gearBtn.setAttribute('aria-label', 'Camera settings');
    this.gearBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
    document.getElementById('game-container').appendChild(this.gearBtn);

    // Panel
    this.panel = document.createElement('div');
    this.panel.id = 'camera-settings-panel';
    this.panel.innerHTML = `<h3 class="cs-title">Camera Settings</h3>`;

    const slidersWrap = document.createElement('div');
    slidersWrap.className = 'cs-sliders';

    for (const cfg of SLIDER_CONFIG) {
      const row = document.createElement('div');
      row.className = 'cs-row';

      const label = document.createElement('label');
      label.className = 'cs-label';
      label.textContent = cfg.label;

      const valSpan = document.createElement('span');
      valSpan.className = 'cs-value';
      valSpan.textContent = this.values[cfg.key];

      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'cs-slider';
      input.min = cfg.min;
      input.max = cfg.max;
      input.step = cfg.step;
      input.value = this.values[cfg.key];

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this.values[cfg.key] = v;
        valSpan.textContent = v % 1 === 0 ? v : v.toFixed(1);
        this.controller.setSettings({ [cfg.key]: v });
        this._save();
      });

      this.sliders[cfg.key] = { input, valSpan };

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      slidersWrap.appendChild(row);
    }

    this.panel.appendChild(slidersWrap);

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'cs-reset';
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => this._resetDefaults());
    this.panel.appendChild(resetBtn);

    // Hint
    const hint = document.createElement('div');
    hint.className = 'cs-hint';
    hint.textContent = 'Press Esc to close';
    this.panel.appendChild(hint);

    document.getElementById('game-container').appendChild(this.panel);
  }

  _bindEvents() {
    // Desktop: Escape toggles
    this._onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.toggle();
      }
    };
    document.addEventListener('keydown', this._onKeydown);

    // Mobile: gear icon
    this.gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // Close when clicking outside the panel (on the game area)
    this._onPointerdown = (e) => {
      if (this.open && !this.panel.contains(e.target) && e.target !== this.gearBtn) {
        this.close();
      }
    };
    document.addEventListener('pointerdown', this._onPointerdown);
  }

  toggle() {
    this.open ? this.close() : this.openPanel();
  }

  openPanel() {
    this.open = true;
    this.panel.classList.add('open');
    this.gearBtn.classList.add('active');
  }

  close() {
    this.open = false;
    this.panel.classList.remove('open');
    this.gearBtn.classList.remove('active');
  }

  _resetDefaults() {
    this.values = { ...DEFAULTS };
    this.controller.setSettings(this.values);
    this._save();

    for (const cfg of SLIDER_CONFIG) {
      const { input, valSpan } = this.sliders[cfg.key];
      input.value = DEFAULTS[cfg.key];
      const v = DEFAULTS[cfg.key];
      valSpan.textContent = v % 1 === 0 ? v : v.toFixed(1);
    }
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeydown);
    document.removeEventListener('pointerdown', this._onPointerdown);
    if (this.panel && this.panel.parentNode) {
      this.panel.parentNode.removeChild(this.panel);
    }
    if (this.gearBtn && this.gearBtn.parentNode) {
      this.gearBtn.parentNode.removeChild(this.gearBtn);
    }
  }
}
