// ============================================
// MetaClient - Lightweight lobby socket for profile / challenges / loadout
// Lives only while the lobby is visible (disconnected before a match starts,
// reconnected on return). Caches the last profile in localStorage so the
// lobby renders instantly (and offline) before the server answers.
// ============================================

import { io } from 'socket.io-client';
import { getBoostColorById } from '../../shared/Meta.js';

const CACHE_KEY = 'blocket-meta-cache';
const SAVE_DEBOUNCE_MS = 500;
const REQUEST_TIMEOUT_MS = 6000;

export class MetaClient {
  constructor() {
    this.socket = null;
    this.profile = this._loadCache();
    this._listeners = new Set();
    this._saveTimer = null;
    this._onPlayerId = null;
  }

  get connected() {
    return !!(this.socket && this.socket.connected);
  }

  /**
   * Open the lobby socket. `onPlayerId(data)` receives the server's identity
   * payload (persistent id + progression snapshot) exactly like NetworkManager.
   */
  connect(playerId, playerName, onPlayerId) {
    if (this.socket) return;
    this._onPlayerId = onPlayerId || null;
    const query = {};
    if (playerId) query.playerId = playerId;
    if (playerName) query.playerName = playerName;
    const socket = io({ transports: ['websocket'], query, reconnection: true, reconnectionAttempts: 3 });
    this.socket = socket;

    socket.on('playerId', (data) => {
      if (this._onPlayerId) this._onPlayerId(data);
    });
    socket.on('connect', () => {
      this.refreshProfile();
    });
  }

  disconnect() {
    if (!this.socket) return;
    const s = this.socket;
    this.socket = null;
    s.removeAllListeners();
    s.disconnect();
  }

  /** Emit `event` with an ack callback; resolves the ack or rejects on timeout/offline. */
  request(event, data = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('offline'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('timeout'));
      }, timeoutMs);
      this.socket.emit(event, data, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** Fetch the full profile; updates cache and notifies listeners. */
  refreshProfile() {
    return this.request('getProfile').then((p) => {
      if (p && typeof p === 'object') this._setProfile(p);
      return this.profile;
    }).catch(() => this.profile);
  }

  /** Equip cosmetics. The server validates unlocks; the result is authoritative. */
  setLoadout(loadout) {
    return this.request('setLoadout', loadout).then((clean) => {
      if (clean && this.profile) {
        this._setProfile({ ...this.profile, loadout: { boost: clean.boost || null, title: clean.title || null } });
      }
      return clean;
    });
  }

  getLeaderboardPage(mode, page) {
    return this.request('getLeaderboardPage', { mode, page });
  }

  /** Subscribe to profile updates. Returns an unsubscribe function. */
  onProfile(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Equipped cosmetics as variantConfig fields ({ boostColor, title }) for the local car. */
  getLoadoutVariantFields() {
    const lo = this.profile && this.profile.loadout;
    const def = lo && lo.boost ? getBoostColorById(lo.boost) : null;
    return {
      boostColor: def && def.hex !== null ? def.hex : null,
      title: lo && lo.title ? lo.title : null,
    };
  }

  _setProfile(p) {
    this.profile = p;
    this._scheduleSave();
    for (const fn of this._listeners) {
      try { fn(p); } catch (err) { console.warn('MetaClient listener error', err); }
    }
  }

  _loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.stats) return parsed;
      }
    } catch {}
    return null;
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(this.profile));
      } catch {}
    }, SAVE_DEBOUNCE_MS);
  }
}

export const metaClient = new MetaClient();
