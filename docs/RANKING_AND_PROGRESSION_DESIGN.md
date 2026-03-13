# Blocket League -- Ranking and Progression System Design

Version 1.0 | 2026-03-12

---

## Table of Contents

1. [Design Pillars](#1-design-pillars)
2. [Competitive Rank System](#2-competitive-rank-system)
3. [Improved Level System](#3-improved-level-system)
4. [Database Schema Changes](#4-database-schema-changes)
5. [Integration Points](#5-integration-points)
6. [Tuning Spreadsheets](#6-tuning-spreadsheets)

---

## 1. Design Pillars

These are the non-negotiable player experiences this system must deliver:

1. **Matches feel consequential.** Every game should visibly move the player's rank or XP bar. No "nothing happened" matches.
2. **Rank reflects skill, not grind.** MMR must separate a player who wins 70% of games from one who wins 50%, regardless of volume.
3. **Progression never stalls.** Even a losing player earns XP and levels. Rank can go down; level never does.
4. **Ranks are readable at a glance.** A player in the lobby should instantly know "this opponent is better/worse/equal" from a rank icon and color.
5. **Small-scale viable.** The system must work with a small player base (dozens, not thousands). No rank should require 10,000+ players to be reachable.

---

## 2. Competitive Rank System

### 2.1 Rank Tiers

Eight named ranks, each with three divisions (I, II, III), for 24 total divisions. Division III is the lowest within a rank, Division I is the highest (matching Rocket League convention).

| Rank        | Division III | Division II  | Division I   | UI Color         | Icon Style                        |
|-------------|-------------|-------------|-------------|------------------|-----------------------------------|
| **Scrap**   | 0-79        | 80-119      | 120-159     | `#8B7355` Brown  | Rusty gear/bolt                   |
| **Iron**    | 160-219     | 220-279     | 280-339     | `#A0A0A0` Gray   | Iron plate                        |
| **Bronze**  | 340-419     | 420-499     | 500-579     | `#CD7F32` Bronze | Bronze shield                     |
| **Silver**  | 580-679     | 680-779     | 780-879     | `#C0C0C0` Silver | Silver shield with chevron        |
| **Gold**    | 880-999     | 1000-1119   | 1120-1239   | `#FFD700` Gold   | Gold shield with star             |
| **Platinum**| 1240-1379   | 1380-1519   | 1520-1659   | `#00CED1` Teal   | Platinum diamond                  |
| **Diamond** | 1660-1819   | 1820-1979   | 1980-2139   | `#9B59FF` Purple | Faceted diamond                   |
| **Champion**| 2140+       | --          | --          | `#FF4444` Red    | Flaming crown (single tier)       |

**Design rationale:**

- Starting MMR is 1000 (Gold II). This means a brand new player starts in the middle, which feels better than starting at the bottom. After placement matches they settle to their true rank.
- The lowest ranks (Scrap, Iron) have narrow MMR bands (160 points total each) so bad players rank up quickly and feel progress.
- Mid ranks (Bronze through Gold) have wider bands (240-360 points) because this is where most players will cluster. Wider bands reduce frustrating rank oscillation.
- High ranks (Platinum, Diamond) are 420 points wide -- harder to climb, which feels earned.
- Champion has no divisions. It is a single open-ended tier. Anyone at 2140+ is Champion. This avoids fragmenting a small player base at the top.

### 2.2 MMR Algorithm

The current flat +/-25 system has two critical problems: it never stabilizes (a player at their true skill oscillates forever), and it ignores the skill gap between opponents. The replacement uses a simplified Glicko-inspired model with three components.

#### 2.2.1 Core Formula

```
K = base_K * uncertainty_multiplier * streak_modifier
mmr_change = K * (outcome - expected)

Where:
  outcome = 1.0 (win) or 0.0 (loss)
  expected = 1 / (1 + 10^((opponent_mmr - player_mmr) / 400))
  base_K = 40
```

**Expected outcome** uses the standard logistic curve. If both players are 1000 MMR, expected = 0.5. If you are 200 MMR below your opponent, expected = 0.24 (you are expected to lose).

**Example MMR changes** (with K=40, no modifiers):

| Your MMR | Opponent MMR | You Win    | You Lose   |
|----------|-------------|-----------|-----------|
| 1000     | 1000        | +20       | -20       |
| 1000     | 1200        | +30       | -10       |
| 1200     | 1000        | +10       | -30       |
| 800      | 1200        | +36       | -4        |

This naturally means: beat someone better, gain a lot. Lose to someone worse, lose a lot. The system self-corrects.

#### 2.2.2 Uncertainty Multiplier (Placement Matches)

New players should move fast. Established players should move slowly.

```
uncertainty_multiplier = max(1.0, 2.5 - (matches_played * 0.15))

Effective values:
  Match 1-3:   2.5x  (placement phase, ~50 MMR swings)
  Match 5:     1.75x
  Match 10:    1.0x  (settled, normal K factor)
  Match 17+:   1.0x  (clamped at 1.0)
```

The first 10 matches are effectively "placement matches" but the player is never told that. They simply see bigger rank changes early on, which feels exciting and quickly sorts them to the right bracket. No separate "unranked" state is needed, which keeps the UI simple.

After a player has not played for 30+ days, their uncertainty resets to 1.5 (not full 2.5). This handles skill decay from inactivity without a separate decay system.

#### 2.2.3 Streak Modifier

Win and loss streaks amplify MMR changes to accelerate convergence when a player is clearly misranked.

```
streak_modifier:
  streak 0-2:  1.0x  (no effect)
  streak 3:    1.15x
  streak 4:    1.3x
  streak 5+:   1.5x (capped)
```

A streak resets when the outcome changes. Winning 5 in a row then losing resets the streak to 0 (for wins) and starts counting losses.

**Combined example:** A new player (match 3, uncertainty 2.5x) on a 4-game win streak (1.3x) beats an equal-MMR opponent:

```
K = 40 * 2.5 * 1.3 = 130
change = 130 * (1.0 - 0.5) = +65 MMR
```

This is intentional. A new player stomping their bracket should rocket upward. After 10 matches this stabilizes to normal ~20 MMR swings.

#### 2.2.4 Team Modes (2v2)

In 2v2, use the average MMR of each team as the "opponent MMR" for the expected outcome calculation. All players on the winning team get the same MMR gain; all on the losing team get the same MMR loss. Individual performance does not affect MMR -- only wins and losses. This prevents players from playing selfishly to pad stats.

#### 2.2.5 MMR Floor

MMR is clamped at 0 minimum (unchanged). There is no ceiling.

### 2.3 Rank Display Specification

Each rank has:
- **Name**: e.g., "Gold II"
- **Color**: hex color for text, borders, glows (see table above)
- **Icon**: a small SVG or canvas-drawn emblem (described in table above)
- **Background glow**: the rank color at 20% opacity, used behind the icon

The rank badge is a rectangular element, approximately 120x32 pixels, containing:
```
[ Icon 24x24 ] [ GOLD II ] in rank color, Orbitron font, 13px weight 700
```

For Champion rank, add a subtle CSS animation: a slow pulsing glow (2s cycle) on the crown icon using the red color. This is the only animated rank badge.

---

## 3. Improved Level System

### 3.1 Analysis of Current System

Current formula: `level = floor(sqrt(totalXP / 100))`

This produces:

| Level | Total XP Required | XP for This Level | Approx Matches to Level Up |
|-------|-------------------|-------------------|-----------------------------|
| 1     | 100               | 100               | <1                          |
| 2     | 400               | 300               | 1                           |
| 5     | 2,500             | 900               | 3                           |
| 10    | 10,000            | 1,900             | 6                           |
| 20    | 40,000            | 3,900             | 13                          |
| 50    | 250,000           | 9,900             | 33                          |
| 100   | 1,000,000         | 19,900            | 66                          |

**Problems identified:**

1. Levels 1-3 take less than a single match to earn. This devalues the level-up moment.
2. The sqrt curve means each level costs more XP than the last, which is correct, but the per-level cost grows linearly (level N costs `(2N-1)*100` XP). This is actually a reasonable curve. The early levels are just too cheap.
3. Average XP per match is roughly 300 XP (a loss with 1 goal, 2 shots, 1 save) to 600 XP (a win with 3 goals, some assists). With ~450 XP average, level 10 takes about 22 matches, which is reasonable.

### 3.2 Recommended Formula Change

Shift the curve so early levels require meaningful play while keeping the long tail manageable.

**New formula:**

```
level = floor(sqrt(totalXP / 200))
xpForLevel(L) = L * L * 200
```

This doubles the XP cost per level. The impact:

| Level | Total XP Required | XP for This Level | Matches (at 450 avg) |
|-------|-------------------|-------------------|-----------------------|
| 1     | 200               | 200               | <1                    |
| 2     | 800               | 600               | 1-2                   |
| 3     | 1,800             | 1,000             | 2-3                   |
| 5     | 5,000             | 1,800             | 4                     |
| 10    | 20,000            | 3,800             | 8                     |
| 20    | 80,000            | 7,800             | 17                    |
| 50    | 500,000           | 19,800            | 44                    |
| 100   | 2,000,000         | 39,800            | 88                    |

Level 1 now takes at least a partial match. Level 10 takes about 44 matches total (roughly 7-8 hours of play). Level 50 takes about 1,100 matches (roughly 180 hours). This is a healthy curve for a browser game where sessions are short.

**Migration:** For existing players, their XP stays the same. Their level simply recalculates to the new formula. A player at 10,000 XP was level 10, and will now be level 7. This is a one-time adjustment and is acceptable because the level system is cosmetic, not competitive. Include a note in patch notes.

### 3.3 XP Rewards -- Rebalanced

Current values are mostly reasonable but have two issues: aerial goals give 150 XP (more than a regular goal, which is correct) but demos at 50 XP each can be farmed by a player who demolishes instead of playing the ball. Shots at 20 XP are negligible.

**Revised XP values:**

| Action         | Current | Proposed | Rationale                                              |
|----------------|---------|----------|-------------------------------------------------------|
| Goal           | 100     | 100      | No change. Core action, well-valued.                  |
| Assist         | 75      | 75       | No change. Rewards teamwork.                          |
| Save           | 60      | 80       | Increase. Saves are harder than goals and undervalued. |
| Shot on Goal   | 20      | 30       | Increase. Encourages offensive play even without scoring. |
| Demo           | 50      | 30       | Decrease. Reduce farming incentive. Demos are opportunistic, not a primary objective. |
| Aerial Goal    | 150     | 150      | No change. Rewards skill.                             |
| Win Bonus      | 200     | 200      | No change. Winning matters.                           |
| Match Complete | 50      | 75       | Increase. Reward showing up and finishing. Reduces ragequit incentive. |
| **[NEW] Hat Trick** | -- | 100  | Bonus for 3+ goals in a single match.                 |
| **[NEW] Playmaker**  | -- | 75  | Bonus for 3+ assists in a single match.               |
| **[NEW] Savior**     | -- | 75  | Bonus for 3+ saves in a single match.                 |
| **[NEW] MVP Bonus**  | -- | 50  | Awarded to the match MVP.                             |
| **[NEW] Overtime Win** | -- | 50 | Additional bonus for winning in overtime.              |

Average XP per match shifts from ~450 to ~500 with the increased base values and bonuses.

### 3.4 Level Titles

Every 10 levels, the player earns a title displayed alongside their level. Titles are purely cosmetic.

| Level Range | Title         |
|-------------|---------------|
| 0-9         | Rookie        |
| 10-19       | Semi-Pro      |
| 20-29       | Pro           |
| 30-39       | Veteran       |
| 40-49       | Expert        |
| 50-59       | Master        |
| 60-69       | Legend         |
| 70-79       | Rocketeer     |
| 80-89       | Transcendent  |
| 90-99       | Ultimate      |
| 100+        | Blocket Lord  |

These titles match Rocket League's convention (which players will recognize) with custom names for the upper tiers.

### 3.5 Prestige System

At level 100 (2,000,000 XP with the new formula, roughly 4,400 matches or ~730 hours), the player can prestige. This is far enough away that only dedicated players reach it, but achievable within a year of regular play.

**Prestige mechanics:**
- Level resets to 0
- Prestige counter increments (Prestige 1, Prestige 2, etc.)
- A prestige star icon appears next to the level badge (one star per prestige)
- All car unlocks are retained
- XP requirement does NOT increase per prestige (same curve each time)
- Maximum prestige: 10 (after which level simply keeps climbing past 100)

**Display format:** `[Star] LVL 45 - Expert` or `[Star][Star][Star] LVL 12 - Semi-Pro`

### 3.6 Practical Level Cap and Progression Timeline

| Milestone  | Total XP    | Total Matches (~500 avg) | Play Time (~5 min/match) |
|------------|-------------|--------------------------|--------------------------|
| Level 10   | 20,000      | 40                       | ~3.3 hours               |
| Level 25   | 125,000     | 250                      | ~21 hours                |
| Level 50   | 500,000     | 1,000                    | ~83 hours                |
| Level 75   | 1,125,000   | 2,250                    | ~188 hours               |
| Level 100  | 2,000,000   | 4,000                    | ~333 hours               |
| Prestige 1, Lv 50 | 2,500,000 | 5,000              | ~417 hours               |

---

## 4. Database Schema Changes

### 4.1 Modified `player_stats` Table

Add these columns to the existing `player_stats` table:

```sql
-- New columns for ranking system
mmr_1v1 INTEGER NOT NULL DEFAULT 1000,        -- separate MMR per mode
mmr_2v2 INTEGER NOT NULL DEFAULT 1000,        -- separate MMR per mode
win_streak INTEGER NOT NULL DEFAULT 0,         -- current consecutive wins (resets on loss)
loss_streak INTEGER NOT NULL DEFAULT 0,        -- current consecutive losses (resets on win)
matches_played_ranked INTEGER NOT NULL DEFAULT 0,  -- total ranked matches (for uncertainty calc)
prestige INTEGER NOT NULL DEFAULT 0,           -- prestige level (0 = none)
last_match_date TEXT DEFAULT NULL              -- for inactivity uncertainty reset
```

The existing `mmr` column is kept for backward compatibility but deprecated. New code reads `mmr_1v1` or `mmr_2v2` depending on mode.

**Migration strategy:** On first run after update, copy `mmr` value to both `mmr_1v1` and `mmr_2v2`. Set `matches_played_ranked = total_matches`. Recalculate `level` using the new formula from existing `xp`.

### 4.2 New `rank_history` Table

Track MMR changes over time for rank-change animations and historical graphs.

```sql
CREATE TABLE IF NOT EXISTS rank_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '1v1',
  mmr_before INTEGER NOT NULL,
  mmr_after INTEGER NOT NULL,
  mmr_delta INTEGER NOT NULL,
  rank_name TEXT NOT NULL,           -- e.g., "Gold II"
  date TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (match_id) REFERENCES match_history(match_id)
);

CREATE INDEX IF NOT EXISTS idx_rank_history_player ON rank_history(player_id, date DESC);
```

### 4.3 New `seasons` Table (Future-Proofing)

Not implemented yet, but the schema is ready for when seasons are added.

```sql
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS season_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  mmr_1v1 INTEGER NOT NULL DEFAULT 1000,
  mmr_2v2 INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  peak_mmr INTEGER NOT NULL DEFAULT 1000,
  matches_played INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (season_id) REFERENCES seasons(id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  UNIQUE(season_id, player_id)
);
```

### 4.4 Updated `match_players` Table

Add MMR tracking per match participation:

```sql
-- New columns on match_players
mmr_before INTEGER DEFAULT NULL,
mmr_after INTEGER DEFAULT NULL
```

### 4.5 Migration Function

Add to `_migrateSchema()` in `database.js`:

```javascript
// Ranking system migration
const statsCols = db.prepare("PRAGMA table_info('player_stats')").all().map(c => c.name);
const rankMigrations = [
  ['mmr_1v1', 'INTEGER NOT NULL DEFAULT 1000'],
  ['mmr_2v2', 'INTEGER NOT NULL DEFAULT 1000'],
  ['win_streak', 'INTEGER NOT NULL DEFAULT 0'],
  ['loss_streak', 'INTEGER NOT NULL DEFAULT 0'],
  ['matches_played_ranked', 'INTEGER NOT NULL DEFAULT 0'],
  ['prestige', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_match_date', 'TEXT DEFAULT NULL'],
];
for (const [col, type] of rankMigrations) {
  if (!statsCols.includes(col)) {
    db.exec(`ALTER TABLE player_stats ADD COLUMN ${col} ${type}`);
  }
}

// Copy existing MMR to new per-mode columns if they were just created
if (!statsCols.includes('mmr_1v1')) {
  db.exec('UPDATE player_stats SET mmr_1v1 = mmr, mmr_2v2 = mmr');
  db.exec('UPDATE player_stats SET matches_played_ranked = total_matches');
}

// Recalculate levels with new formula (level = floor(sqrt(xp / 200)))
db.exec(`
  UPDATE player_stats
  SET level = CAST(SQRT(CAST(xp AS REAL) / 200.0) AS INTEGER)
`);

// match_players MMR columns
const mpCols = db.prepare("PRAGMA table_info('match_players')").all().map(c => c.name);
if (!mpCols.includes('mmr_before')) {
  db.exec('ALTER TABLE match_players ADD COLUMN mmr_before INTEGER DEFAULT NULL');
  db.exec('ALTER TABLE match_players ADD COLUMN mmr_after INTEGER DEFAULT NULL');
}
```

---

## 5. Integration Points

### 5.1 Where Ranks Are Displayed

| Location              | What is shown                                  | Format                         |
|-----------------------|------------------------------------------------|--------------------------------|
| Main lobby            | Own rank badge + level + title                 | `[RankIcon] GOLD II` + `LVL 23 - Pro` |
| Matchmaking queue     | Own rank badge (small)                         | Rank icon + color border       |
| Pre-match lobby       | All players: name, rank badge, level           | Player card with rank color accent |
| In-game nameplate     | Rank icon (tiny, 16px) next to player name     | Icon only, no text             |
| Post-match scoreboard | Rank badge + MMR change (+22 / -18)            | Rank icon + green/red delta    |
| Post-match XP screen  | Level progress bar + rank change animation     | Full breakdown (see 5.3)       |
| Leaderboard           | Rank badge + MMR number + W/L record           | Sorted by MMR                  |
| Player profile card   | Rank, level, title, prestige stars, career stats | Full card                     |

### 5.2 Post-Match Rank Change Communication

After the XP screen (which already exists), show a rank change panel. This is a separate screen that appears for 3 seconds after the XP screen dismisses.

**Rank Change Screen Layout:**

```
+----------------------------------------------+
|                                              |
|          [Current Rank Icon, 64px]           |
|            GOLD II                           |
|                                              |
|    MMR: 1045  -->  1067                      |
|         [ =======>-------- ]                 |
|         1000      1067    1120               |
|                                              |
|         +22 MMR    (arrow up, green)         |
|                                              |
+----------------------------------------------+
```

The progress bar shows position within the current division. The left edge is the division floor, the right edge is the division ceiling.

**On rank up:** Flash the screen with the new rank's color. Show "RANK UP" text with the new rank name and icon scaling up from 0 to full size. Hold for 2 seconds.

**On rank down:** No special animation. Just show the new rank quietly. Rubbing it in feels bad.

### 5.3 Updated XP Screen Flow

The existing `showXPScreen` in `Progression.js` runs for 3 seconds. After it dismisses, insert the rank change screen (also 3 seconds). Total post-match display: 6 seconds, same as current replay duration. Both screens are skippable by clicking.

Sequence:
1. Goal replay (existing, ~6.7 seconds, skippable)
2. XP breakdown screen (3 seconds, skippable)
3. Rank change screen (3 seconds, skippable)
4. Return to lobby

### 5.4 Leaderboard Changes

The existing `getLeaderboard` query sorts by `mmr DESC`. Update to:

```sql
SELECT p.id, p.display_name, ps.mmr_1v1, ps.mmr_2v2,
       ps.total_wins, ps.total_losses, ps.total_goals, ps.level, ps.prestige
FROM player_stats ps
JOIN players p ON p.id = ps.player_id
WHERE ps.total_matches >= 5  -- hide players with too few games
ORDER BY ps.mmr_1v1 DESC
LIMIT ?
```

Add a mode toggle (1v1 / 2v2) that switches the ORDER BY column.

### 5.5 Server-Side MMR Calculation

In `database.js`, the `saveMatch` function currently does `mmrDelta = p.won ? 25 : -25`. Replace with:

```javascript
function calculateMMRDelta(playerMMR, opponentMMR, won, matchesPlayed, winStreak, lossStreak) {
  const BASE_K = 40;

  // Expected outcome (logistic curve)
  const expected = 1 / (1 + Math.pow(10, (opponentMMR - playerMMR) / 400));

  // Uncertainty multiplier (high early, settles at 1.0)
  const uncertainty = Math.max(1.0, 2.5 - (matchesPlayed * 0.15));

  // Streak modifier
  const streak = won ? winStreak : lossStreak;
  let streakMod = 1.0;
  if (streak >= 5) streakMod = 1.5;
  else if (streak >= 4) streakMod = 1.3;
  else if (streak >= 3) streakMod = 1.15;

  const K = BASE_K * uncertainty * streakMod;
  const outcome = won ? 1.0 : 0.0;
  const delta = Math.round(K * (outcome - expected));

  return delta;
}
```

The `saveMatch` function must also:
1. Read current `win_streak`, `loss_streak`, `matches_played_ranked`, and the mode-specific MMR before updating.
2. Calculate opponent MMR (for 1v1, just the other player's MMR; for 2v2, average of opposing team).
3. Write the delta to `rank_history`.
4. Update `win_streak` / `loss_streak` (increment the relevant one, reset the other to 0).
5. Update `last_match_date` to `datetime('now')`.
6. Increment `matches_played_ranked`.

### 5.6 Rank Name Lookup Function

```javascript
const RANKS = [
  { name: 'Scrap',    divisions: [{ div: 'III', min: 0 }, { div: 'II', min: 80 }, { div: 'I', min: 120 }] },
  { name: 'Iron',     divisions: [{ div: 'III', min: 160 }, { div: 'II', min: 220 }, { div: 'I', min: 280 }] },
  { name: 'Bronze',   divisions: [{ div: 'III', min: 340 }, { div: 'II', min: 420 }, { div: 'I', min: 500 }] },
  { name: 'Silver',   divisions: [{ div: 'III', min: 580 }, { div: 'II', min: 680 }, { div: 'I', min: 780 }] },
  { name: 'Gold',     divisions: [{ div: 'III', min: 880 }, { div: 'II', min: 1000 }, { div: 'I', min: 1120 }] },
  { name: 'Platinum', divisions: [{ div: 'III', min: 1240 }, { div: 'II', min: 1380 }, { div: 'I', min: 1520 }] },
  { name: 'Diamond',  divisions: [{ div: 'III', min: 1660 }, { div: 'II', min: 1820 }, { div: 'I', min: 1980 }] },
  { name: 'Champion', divisions: [{ div: '', min: 2140 }] },
];

const RANK_COLORS = {
  'Scrap': '#8B7355',
  'Iron': '#A0A0A0',
  'Bronze': '#CD7F32',
  'Silver': '#C0C0C0',
  'Gold': '#FFD700',
  'Platinum': '#00CED1',
  'Diamond': '#9B59FF',
  'Champion': '#FF4444',
};

function getRankFromMMR(mmr) {
  let result = { name: 'Scrap', division: 'III', color: '#8B7355', fullName: 'Scrap III' };
  for (const rank of RANKS) {
    for (const div of rank.divisions) {
      if (mmr >= div.min) {
        const divText = div.div ? ` ${div.div}` : '';
        result = {
          name: rank.name,
          division: div.div,
          color: RANK_COLORS[rank.name],
          fullName: `${rank.name}${divText}`,
          min: div.min,
        };
      }
    }
  }
  // Find the ceiling (next division's min, or Infinity for Champion)
  const allDivs = RANKS.flatMap(r => r.divisions.map(d => d.min)).sort((a, b) => a - b);
  const currentIdx = allDivs.indexOf(result.min);
  result.max = currentIdx < allDivs.length - 1 ? allDivs[currentIdx + 1] - 1 : Infinity;
  result.progress = result.max === Infinity ? 1.0 :
    (mmr - result.min) / (result.max - result.min + 1);
  return result;
}
```

### 5.7 Client-Side Data Flow

1. On socket connect, server sends `progression` event with `{ xp, level, mmr_1v1, mmr_2v2, rank }`.
2. Client `Progression.syncFromServer()` stores rank data alongside XP/level.
3. On match end, server emits `matchResult` with `{ mmrBefore, mmrAfter, mmrDelta, rankBefore, rankAfter, xpEarned, xpBreakdown }`.
4. Client `Progression.endMatch()` receives this and queues the rank change screen after the XP screen.
5. The lobby level display updates to show rank badge alongside level.

### 5.8 Rank-Based Matchmaking (Future)

When the player base grows, matchmaking should prefer opponents within +/-200 MMR. Expand the search range by 100 MMR every 15 seconds of queue time. After 60 seconds, match with anyone. This is not implemented now but the MMR infrastructure supports it.

---

## 6. Tuning Spreadsheets

### 6.1 MMR Tuning Variables

| Variable              | Value     | Min  | Max  | Notes                                             |
|-----------------------|-----------|------|------|---------------------------------------------------|
| BASE_K                | 40        | 20   | 60   | [PLACEHOLDER] -- test: do ranks stabilize within 15 matches? |
| Logistic denominator  | 400       | 200  | 600  | Standard Elo uses 400. Lower = more sensitive to MMR gap |
| Uncertainty start     | 2.5       | 1.5  | 3.0  | Higher = faster placement, more volatile early    |
| Uncertainty decay     | 0.15/game | 0.1  | 0.25 | How fast uncertainty settles                      |
| Uncertainty min       | 1.0       | 0.8  | 1.2  | Floor for settled players                         |
| Inactivity threshold  | 30 days   | 14   | 60   | Days before uncertainty partially resets           |
| Inactivity reset to   | 1.5       | 1.2  | 2.0  | Uncertainty after inactivity                      |
| Streak threshold      | 3 wins    | 2    | 4    | When streak bonus kicks in                        |
| Streak cap            | 1.5x at 5 | 1.3  | 2.0  | Maximum streak multiplier                         |
| Starting MMR          | 1000      | 800  | 1200 | Where new players begin                           |
| MMR floor             | 0         | 0    | 0    | Cannot go negative                                |

### 6.2 XP Tuning Variables

| Variable              | Value | Min | Max | Notes                                             |
|-----------------------|-------|-----|-----|---------------------------------------------------|
| XP per goal           | 100   | 50  | 150 | Core reward                                       |
| XP per assist         | 75    | 50  | 100 | Should be less than goal                          |
| XP per save           | 80    | 50  | 100 | [PLACEHOLDER] -- test: does 80 make saves feel rewarding? |
| XP per shot           | 30    | 10  | 50  | Low to prevent shot-spam farming                  |
| XP per demo           | 30    | 10  | 50  | Reduced from 50 to prevent demo farming           |
| XP per aerial goal    | 150   | 100 | 200 | Premium for skill                                 |
| XP for win            | 200   | 150 | 300 | Must be significant but not dominant              |
| XP for match complete | 75    | 25  | 100 | Anti-ragequit incentive                           |
| XP hat trick bonus    | 100   | 50  | 150 | 3+ goals threshold                               |
| XP playmaker bonus    | 75    | 50  | 100 | 3+ assists threshold                              |
| XP savior bonus       | 75    | 50  | 100 | 3+ saves threshold                                |
| XP MVP bonus          | 50    | 25  | 75  | One per match                                     |
| XP overtime win bonus | 50    | 25  | 75  | Clutch reward                                     |
| Level formula divisor | 200   | 100 | 300 | Controls overall curve steepness                  |

### 6.3 Rank Distribution Target

With a healthy system and enough players, the expected distribution:

| Rank      | Target %  | Notes                                    |
|-----------|-----------|------------------------------------------|
| Scrap     | 5%        | Only the newest or weakest players       |
| Iron      | 10%       | Early climbers                           |
| Bronze    | 20%       | Below average                            |
| Silver    | 25%       | Average players cluster here             |
| Gold      | 20%       | Above average                            |
| Platinum  | 12%       | Good players                             |
| Diamond   | 6%        | Top tier                                 |
| Champion  | 2%        | Elite                                    |

Since new players start at 1000 (Gold II), the initial distribution will be top-heavy. It will naturally spread as players with lower skill lose MMR and settle into Bronze/Silver. This is fine -- it is better to let players feel good early and settle naturally than to start them at the bottom and make them grind.

---

## Implementation Checklist

### Server (`database.js`)
- [ ] Add new columns via migration
- [ ] Implement `calculateMMRDelta()` function
- [ ] Implement `getRankFromMMR()` function (shared with client)
- [ ] Update `saveMatch()` to use new MMR algorithm
- [ ] Update `saveMatch()` to track streaks, write rank_history
- [ ] Update `getPlayerStats()` to return rank info
- [ ] Update `getLeaderboard()` query for new columns
- [ ] Update level calculation to use new formula (divisor 200)

### Server (`GameRoom.js`)
- [ ] Pass opponent MMR data to `saveMatch()`
- [ ] Emit `matchResult` with MMR delta and rank info after match
- [ ] Include rank data in initial `progression` event

### Client (`Progression.js`)
- [ ] Update `calculateLevel()` to use `sqrt(xp / 200)`
- [ ] Update `xpForLevel()` to use `level * level * 200`
- [ ] Add bonus XP calculations (hat trick, playmaker, savior, MVP, OT win)
- [ ] Update XP values (save: 80, shot: 30, demo: 30, matchComplete: 75)
- [ ] Add rank display to `syncFromServer()`
- [ ] Build rank change screen UI
- [ ] Add rank badge element for lobby, nameplates, scoreboard
- [ ] Add level title lookup
- [ ] Add prestige display

### Shared
- [ ] Create `shared/Ranks.js` with rank definitions, colors, and `getRankFromMMR()`
- [ ] Move XP values to shared constants (currently duplicated in client and server)

---

## Edge Cases and Failure States

| Scenario                          | Handling                                                        |
|-----------------------------------|-----------------------------------------------------------------|
| Player disconnects mid-match      | Bot replaces them. If they had a playerId, they get a loss and MMR penalty. |
| Both players disconnect           | Match is voided. No MMR change for either player.               |
| Player vs only bots (training)    | No MMR change. XP is still earned at 50% rate.                  |
| MMR desync (client shows wrong)   | Server is source of truth. Client re-syncs on next `progression` event. |
| Database write fails              | MMR change is lost for that match. Log error. Player sees no change. |
| Player creates new account        | Starts at 1000 MMR with high uncertainty. Placements sort them within 10 games. |
| Extreme MMR outlier (3000+)       | No cap. Champion rank absorbs all high MMR. Leaderboard shows actual number. |
| Player at 0 MMR loses again       | MMR stays at 0. They are in Scrap III.                          |
| 2v2 with mixed-rank team          | Uses team average MMR. Both teammates get same delta.           |
| Season reset (future)             | Soft reset: `new_mmr = 0.6 * old_mmr + 0.4 * 1000`. Pulls everyone toward center. |
