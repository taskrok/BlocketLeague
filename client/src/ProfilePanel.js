// ============================================
// ProfilePanel - Lobby profile screen (dynamically imported)
// Tabs: Overview (stats + MMR chart + recent matches), Challenges,
// Achievements, Garage (boost trail + title loadout), Leaderboard (paged).
// Renders from metaClient.profile; all writes go through the server.
// ============================================

import {
  ACHIEVEMENTS, BOOST_COLORS, TITLES, getUnlockContext, isBoostUnlocked,
  isTitleUnlocked, describeUnlock, getAchievementById,
} from '../../shared/Meta.js';
import { getRankFromMMR } from '../../shared/Ranks.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'challenges', label: 'Challenges' },
  { id: 'achievements', label: 'Achievements' },
  { id: 'garage', label: 'Garage' },
  { id: 'leaderboard', label: 'Leaderboard' },
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
}

function hexCss(hex) {
  return typeof hex === 'number' ? '#' + hex.toString(16).padStart(6, '0') : '#ff8800';
}

function fmtDuration(sec) {
  if (sec <= 0) return 'now';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDate(sqlite) {
  if (!sqlite) return '';
  const t = Date.parse(String(sqlite).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function progressBar(progress, target, cls = '') {
  const pct = Math.round(Math.min(1, progress / Math.max(1, target)) * 100);
  return `<div class="pp-bar ${cls}"><div class="pp-bar-fill" style="width:${pct}%"></div></div>`;
}

function challengeRow(c) {
  const done = c.completed ? ' pp-done' : '';
  const tag = c.period === 'weekly' ? '<span class="pp-tag">WEEKLY</span>' : '';
  return `<div class="pp-ch${done}">
    <div class="pp-ch-head">
      <span class="pp-ch-name">${tag}${esc(c.name)}</span>
      <span class="pp-ch-xp">${c.completed ? '&#10003; ' : ''}+${esc(c.xp)} XP</span>
    </div>
    <div class="pp-ch-desc">${esc(c.desc)}</div>
    <div class="pp-ch-foot">${progressBar(c.progress, c.target)}<span class="pp-ch-count">${esc(c.progress)}/${esc(c.target)}</span></div>
  </div>`;
}

/**
 * Open the profile panel inside `container` (the #profile-panel element).
 * @returns {{ close: Function, setTab: Function }}
 */
export function openProfilePanel({ container, meta, initialTab = 'overview', onClose }) {
  let currentTab = TABS.some(t => t.id === initialTab) ? initialTab : 'overview';
  let renderedProfile = null;
  let renderedTab = null;
  let lbMode = '1v1';
  let lbPage = 0;
  let lbData = null;
  let lbLoading = false;
  let chartMode = '1v1';
  let closed = false;
  let busy = false;

  container.innerHTML = `
    <div class="pp-head">
      <h3 class="howtoplay-title">Profile</h3>
      <span class="pp-conn" id="pp-conn"></span>
    </div>
    <div class="pp-tabs" id="pp-tabs"></div>
    <div class="howtoplay-content pp-content" id="pp-body"></div>
    <button id="pp-close" class="lobby-btn lobby-btn-back">Back</button>
  `;
  const tabsEl = container.querySelector('#pp-tabs');
  const bodyEl = container.querySelector('#pp-body');
  const connEl = container.querySelector('#pp-conn');
  const closeBtn = container.querySelector('#pp-close');

  tabsEl.innerHTML = TABS.map(t => `<button class="pp-tab" data-tab="${t.id}">${t.label}</button>`).join('');

  function markTabs() {
    tabsEl.querySelectorAll('.pp-tab').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === currentTab);
    });
  }

  function setConn() {
    const txt = meta.connected ? '' : 'offline - showing cached data';
    if (connEl.textContent !== txt) connEl.textContent = txt;
  }

  // ---- Renderers ----

  function renderOverview(p) {
    const s = p.stats;
    const stars = s.prestige > 0 ? '★'.repeat(Math.min(s.prestige, 10)) + ' ' : '';
    const r1 = s.rank1v1 || getRankFromMMR(s.mmr_1v1 || 1000);
    const r2 = s.rank2v2 || getRankFromMMR(s.mmr_2v2 || 1000);
    const pos = p.positions || {};
    const title = p.loadout && p.loadout.title ? `<span class="pp-user-title">${esc(p.loadout.title)}</span>` : '';
    const rankCard = (label, r, mmr, position, mode) => `
      <div class="pp-rank-card" style="--rc:${r.color}">
        <div class="pp-rank-mode">${label}</div>
        <div class="pp-rank-name">${esc(r.fullName).toUpperCase()}</div>
        <div class="pp-rank-mmr">${esc(mmr)} MMR${position ? ` &middot; #${esc(position)}` : ''}</div>
        ${progressBar(Math.round((r.progress || 0) * 100), 100, 'pp-bar-rank')}
      </div>`;

    const stat = (label, v) => `<div class="pp-stat"><span class="pp-stat-v">${esc(v)}</span><span class="pp-stat-l">${label}</span></div>`;
    const hist = (p.mmrHistory && p.mmrHistory[chartMode]) || [];

    const matches = (p.recentMatches || []).map((m) => {
      const won = m.won === 1;
      const mine = m.team === 'blue' ? m.blue_score : m.orange_score;
      const theirs = m.team === 'blue' ? m.orange_score : m.blue_score;
      return `<div class="pp-match ${won ? 'pp-win' : 'pp-loss'}">
        <span class="pp-match-res">${won ? 'W' : 'L'}</span>
        <span class="pp-match-score">${esc(mine)} - ${esc(theirs)}</span>
        <span class="pp-match-mode">${esc(m.mode)}${m.mvp ? ' &middot; MVP' : ''}</span>
        <span class="pp-match-stats">${esc(m.goals)}G ${esc(m.assists)}A ${esc(m.saves)}S</span>
        <span class="pp-match-date">${fmtDate(m.date)}</span>
      </div>`;
    }).join('') || '<div class="pp-empty">No online matches yet. Play a Quick Match to start your record.</div>';

    bodyEl.innerHTML = `
      <div class="pp-user">
        <div class="pp-user-name">${esc(s.displayName || 'Player')}</div>
        <div class="pp-user-level">${stars}LVL ${esc(s.level)} &middot; ${esc(s.levelTitle)}</div>
        ${title}
      </div>
      <div class="pp-ranks">
        ${rankCard('1v1', r1, s.mmr_1v1, pos['1v1'], '1v1')}
        ${rankCard('2v2', r2, s.mmr_2v2, pos['2v2'], '2v2')}
      </div>
      <div class="pp-stats">
        ${stat('Record', `${s.total_wins}-${s.total_losses}`)}
        ${stat('Win rate', `${s.win_rate}%`)}
        ${stat('Matches', s.total_matches)}
        ${stat('MVPs', s.total_mvps)}
        ${stat('Goals', s.total_goals)}
        ${stat('Assists', s.total_assists)}
        ${stat('Saves', s.total_saves)}
        ${stat('Shots', s.total_shots)}
        ${stat('Demos', s.total_demos)}
        ${stat('Hat tricks', s.total_hat_tricks)}
        ${stat('Shutouts', s.total_shutouts)}
        ${stat('Best streak', `${s.best_win_streak}W`)}
        ${stat('Play time', fmtDuration((s.play_time_minutes || 0) * 60))}
        ${stat('Day streak', s.play_streak)}
      </div>
      <div class="pp-section-head">
        <span>MMR HISTORY</span>
        <span class="pp-seg"><button class="pp-seg-btn ${chartMode === '1v1' ? 'active' : ''}" data-chart="1v1">1v1</button><button class="pp-seg-btn ${chartMode === '2v2' ? 'active' : ''}" data-chart="2v2">2v2</button></span>
      </div>
      <canvas id="pp-chart" class="pp-chart" width="600" height="160"></canvas>
      <div class="pp-section-head"><span>RECENT MATCHES</span></div>
      <div class="pp-matches">${matches}</div>
    `;
    drawChart(bodyEl.querySelector('#pp-chart'), hist, chartMode === '2v2' ? r2.color : r1.color);
  }

  function drawChart(canvas, values, color) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.font = '600 12px Orbitron, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    if (!values || values.length < 2) {
      ctx.textAlign = 'center';
      ctx.fillText(values && values.length === 1 ? 'Play one more match to see your trend' : 'No ranked history yet', W / 2, H / 2);
      return;
    }
    const padL = 48, padR = 12, padT = 14, padB = 20;
    const cw = W - padL - padR, ch = H - padT - padB;
    let min = Math.min(...values), max = Math.max(...values);
    if (max - min < 40) { const mid = (max + min) / 2; min = mid - 20; max = mid + 20; }
    const x = (i) => padL + (i / (values.length - 1)) * cw;
    const y = (v) => padT + (1 - (v - min) / (max - min)) * ch;

    // Gridlines + labels (min / mid / max)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [min, (min + max) / 2, max]) {
      ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W - padR, y(v)); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(String(Math.round(v)), padL - 8, y(v));
    }
    // Area fill
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    grad.addColorStop(0, color + '55');
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(x(0), y(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
    ctx.lineTo(x(values.length - 1), H - padB);
    ctx.lineTo(x(0), H - padB);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // Line
    ctx.beginPath();
    ctx.moveTo(x(0), y(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // Last point + label
    const lx = x(values.length - 1), ly = y(values[values.length - 1]);
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(`last ${values.length} matches`, padL, H - 4);
  }

  function renderChallenges(p) {
    const c = p.challenges || { daily: [], weekly: null, streak: 0 };
    const streak = c.streak || 0;
    const streakMsg = c.playedToday
      ? `Day ${streak} streak &middot; bonus claimed today`
      : (streak > 0
        ? `Day ${streak} streak &middot; play online today to keep it (+${Math.min(streak + 1, 7) * 25} XP)`
        : 'Play an online match today to start a streak (+25 XP/day, up to +175)');
    bodyEl.innerHTML = `
      <div class="pp-streak ${c.playedToday ? 'pp-streak-done' : ''}"><span class="pp-flame">&#128293;</span>${streakMsg}</div>
      <div class="pp-section-head"><span>DAILY</span><span class="pp-reset">resets in ${fmtDuration(c.dayResetsIn || 0)}</span></div>
      <div class="pp-ch-list">${(c.daily || []).map(challengeRow).join('')}</div>
      <div class="pp-section-head"><span>WEEKLY</span><span class="pp-reset">resets in ${fmtDuration(c.weekResetsIn || 0)}</span></div>
      <div class="pp-ch-list">${c.weekly ? challengeRow(c.weekly) : ''}</div>
      <div class="pp-note">Challenges and streaks count online matches (Quick Match or rooms). Rewards are granted at the end of the match.</div>
    `;
  }

  function renderAchievements(p) {
    const have = new Map((p.achievements || []).map(a => [a.id, a.unlockedAt]));
    const cards = ACHIEVEMENTS.map((a) => {
      const when = have.get(a.id);
      return `<div class="pp-ach ${when ? 'pp-ach-on' : ''}">
        <div class="pp-ach-name">${esc(a.name)}</div>
        <div class="pp-ach-desc">${esc(a.desc)}</div>
        <div class="pp-ach-foot"><span>Title: ${esc(a.title)}</span><span>${when ? esc(fmtDate(when)) : `+${esc(a.xp)} XP`}</span></div>
      </div>`;
    }).join('');
    bodyEl.innerHTML = `
      <div class="pp-section-head"><span>ACHIEVEMENTS</span><span class="pp-reset">${have.size}/${ACHIEVEMENTS.length} unlocked</span></div>
      ${progressBar(have.size, ACHIEVEMENTS.length, 'pp-bar-wide')}
      <div class="pp-ach-grid">${cards}</div>
    `;
  }

  function renderGarage(p) {
    const ctx = getUnlockContext(p.stats, (p.achievements || []).map(a => a.id));
    const lo = p.loadout || { boost: null, title: null };
    const equippedBoost = lo.boost || 'default';
    const swatches = BOOST_COLORS.map((b) => {
      const unlocked = isBoostUnlocked(b, ctx);
      const active = equippedBoost === b.id;
      const color = b.hex === null ? '#ff8800' : hexCss(b.hex);
      return `<button class="pp-swatch ${unlocked ? '' : 'pp-locked'} ${active ? 'active' : ''}" data-boost="${b.id}" ${unlocked ? '' : 'disabled'} title="${esc(unlocked ? b.name : describeUnlock(b))}">
        <span class="pp-swatch-dot" style="background:${color};box-shadow:0 0 14px ${color}"></span>
        <span class="pp-swatch-name">${esc(b.name)}</span>
        <span class="pp-swatch-req">${unlocked ? (active ? 'Equipped' : 'Unlocked') : esc(describeUnlock(b))}</span>
      </button>`;
    }).join('');
    const titleBtns = ['', ...TITLES].map((t) => {
      const unlocked = isTitleUnlocked(t, ctx);
      const active = (lo.title || '') === t;
      const ach = t ? ACHIEVEMENTS.find(a => a.title === t) : null;
      return `<button class="pp-title-btn ${unlocked ? '' : 'pp-locked'} ${active ? 'active' : ''}" data-title="${esc(t)}" ${unlocked ? '' : 'disabled'} title="${esc(unlocked || !ach ? '' : ach.desc)}">${t ? esc(t) : 'No title'}</button>`;
    }).join('');
    bodyEl.innerHTML = `
      <div class="pp-section-head"><span>BOOST TRAIL</span><span class="pp-reset">visible to everyone in online matches</span></div>
      <div class="pp-swatches">${swatches}</div>
      <div class="pp-section-head"><span>TITLE</span><span class="pp-reset">shown on your nameplate and the leaderboard</span></div>
      <div class="pp-titles">${titleBtns}</div>
      ${meta.connected ? '' : '<div class="pp-note">Connect to the server (online) to change your loadout.</div>'}
    `;
  }

  function renderLeaderboard() {
    const d = lbData;
    const rows = d && d.rows ? d.rows : [];
    const rowsHtml = rows.map((r) => {
      const isMe = d.myPosition !== null && d.myPosition === r.position;
      return `<div class="pp-lb-row ${isMe ? 'pp-me' : ''}">
        <span class="pp-lb-pos">#${esc(r.position)}</span>
        <span class="pp-lb-name">${esc(r.displayName || 'Player')}${r.title ? `<span class="pp-lb-title">${esc(r.title)}</span>` : ''}</span>
        <span class="pp-lb-rank" style="color:${r.rank.color}">${esc(r.rank.fullName).toUpperCase()}</span>
        <span class="pp-lb-mmr">${esc(r.mmr)}</span>
        <span class="pp-lb-rec">${esc(r.wins)}-${esc(r.losses)}</span>
        <span class="pp-lb-lvl">L${esc(r.level)}</span>
      </div>`;
    }).join('');
    const total = d ? d.total : 0;
    const pageSize = d ? d.pageSize : 20;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    bodyEl.innerHTML = `
      <div class="pp-section-head">
        <span class="pp-seg"><button class="pp-seg-btn ${lbMode === '1v1' ? 'active' : ''}" data-lb-mode="1v1">1v1</button><button class="pp-seg-btn ${lbMode === '2v2' ? 'active' : ''}" data-lb-mode="2v2">2v2</button></span>
        <span class="pp-reset">${d && d.myPosition ? `you: #${esc(d.myPosition)} of ${esc(total)}` : `${esc(total)} ranked players`}</span>
      </div>
      <div class="pp-lb-head"><span>#</span><span>Player</span><span>Rank</span><span>MMR</span><span>W-L</span><span>Lvl</span></div>
      <div class="pp-lb">${lbLoading ? '<div class="pp-empty">Loading...</div>' : (rowsHtml || `<div class="pp-empty">${meta.connected ? 'No players on this page.' : 'Connect to the server to view the leaderboard.'}</div>`)}</div>
      <div class="pp-pager">
        <button class="lobby-btn lobby-btn-nav" data-lb-page="-1" ${lbPage <= 0 ? 'disabled' : ''}>&lt;</button>
        <span>Page ${lbPage + 1} / ${pages}</span>
        <button class="lobby-btn lobby-btn-nav" data-lb-page="1" ${lbPage + 1 >= pages ? 'disabled' : ''}>&gt;</button>
      </div>
    `;
  }

  function loadLeaderboard() {
    lbLoading = true;
    renderLeaderboard();
    meta.getLeaderboardPage(lbMode, lbPage).then((d) => {
      if (closed) return;
      lbData = d || null;
    }).catch(() => {
      lbData = null;
    }).then(() => {
      if (closed) return;
      lbLoading = false;
      if (currentTab === 'leaderboard') renderLeaderboard();
    });
  }

  function render(force = false) {
    if (closed) return;
    setConn();
    markTabs();
    const p = meta.profile;
    if (!force && p === renderedProfile && currentTab === renderedTab) return;
    renderedProfile = p;
    renderedTab = currentTab;
    bodyEl.scrollTop = 0;
    if (currentTab === 'leaderboard') {
      if (!lbData || force) loadLeaderboard(); else renderLeaderboard();
      return;
    }
    if (!p) {
      bodyEl.innerHTML = `<div class="pp-empty">${meta.connected ? 'Loading profile...' : 'Could not reach the server. Your profile appears here after your first online match.'}</div>`;
      return;
    }
    if (currentTab === 'overview') renderOverview(p);
    else if (currentTab === 'challenges') renderChallenges(p);
    else if (currentTab === 'achievements') renderAchievements(p);
    else if (currentTab === 'garage') renderGarage(p);
  }

  // ---- Events (one delegated listener per region) ----

  function onTabsClick(e) {
    const b = e.target.closest('.pp-tab');
    if (!b) return;
    currentTab = b.getAttribute('data-tab');
    render();
  }

  function onBodyClick(e) {
    const chart = e.target.closest('[data-chart]');
    if (chart) {
      chartMode = chart.getAttribute('data-chart');
      render(true);
      return;
    }
    const lbm = e.target.closest('[data-lb-mode]');
    if (lbm) {
      lbMode = lbm.getAttribute('data-lb-mode');
      lbPage = 0;
      lbData = null;
      loadLeaderboard();
      return;
    }
    const pager = e.target.closest('[data-lb-page]');
    if (pager && !pager.disabled) {
      lbPage = Math.max(0, lbPage + parseInt(pager.getAttribute('data-lb-page'), 10));
      loadLeaderboard();
      return;
    }
    const sw = e.target.closest('[data-boost]');
    if (sw && !sw.disabled && !busy) {
      const lo = (meta.profile && meta.profile.loadout) || {};
      const id = sw.getAttribute('data-boost');
      equip({ boost: id === 'default' ? null : id, title: lo.title || null });
      return;
    }
    const tb = e.target.closest('[data-title]');
    if (tb && !tb.disabled && !busy) {
      const lo = (meta.profile && meta.profile.loadout) || {};
      equip({ boost: lo.boost || null, title: tb.getAttribute('data-title') || null });
    }
  }

  function equip(loadout) {
    busy = true;
    meta.setLoadout(loadout).catch(() => {
      // offline/timeout: leave the current loadout as-is
    }).then(() => {
      busy = false;
      render(true);
    });
  }

  function handleClose() {
    close();
    if (onClose) onClose();
  }

  const unsubscribe = meta.onProfile(() => render());
  tabsEl.addEventListener('click', onTabsClick);
  bodyEl.addEventListener('click', onBodyClick);
  closeBtn.addEventListener('click', handleClose);
  const connTimer = setInterval(setConn, 1000);

  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(connTimer);
    tabsEl.removeEventListener('click', onTabsClick);
    bodyEl.removeEventListener('click', onBodyClick);
    closeBtn.removeEventListener('click', handleClose);
    container.innerHTML = '';
  }

  // Fresh data whenever the panel opens
  if (meta.connected) meta.refreshProfile();
  render(true);

  return {
    close,
    setTab(id) { currentTab = id; render(); },
  };
}
