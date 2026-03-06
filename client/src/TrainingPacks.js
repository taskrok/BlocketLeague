// ============================================
// Training Packs — Shot definitions for training modes
// Each shot: { carPos, carDir, ballPos, ballVel }
//   carPos: { x, y, z } spawn position
//   carDir: 1 (face orange goal) or -1 (face blue goal)
//   ballPos: { x, y, z } ball start position
//   ballVel: { x, y, z } ball initial velocity (0,0,0 = stationary)
// ============================================

// Arena reference:
//   Orange goal mouth at z ≈ +118.5, Blue goal at z ≈ -118.5
//   Goal width ±17, goal height 0-18
//   Field: x ±82, z ±118.5

// ===== STRIKER PACKS =====

export const STRIKER_ROOKIE = [
  // 1. Ball stationary in front of orange goal
  { carPos: { x: 0, y: 2, z: 60 }, carDir: 1, ballPos: { x: 0, y: 3, z: 100 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 2. Ball slightly left of center
  { carPos: { x: -15, y: 2, z: 50 }, carDir: 1, ballPos: { x: -8, y: 3, z: 95 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 3. Ball slightly right
  { carPos: { x: 15, y: 2, z: 50 }, carDir: 1, ballPos: { x: 8, y: 3, z: 95 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 4. Ball rolling slowly toward goal
  { carPos: { x: 0, y: 2, z: 40 }, carDir: 1, ballPos: { x: 0, y: 3, z: 70 }, ballVel: { x: 0, y: 0, z: 8 } },
  // 5. Angled approach from left
  { carPos: { x: -30, y: 2, z: 60 }, carDir: 1, ballPos: { x: -10, y: 3, z: 90 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 6. Angled approach from right
  { carPos: { x: 30, y: 2, z: 60 }, carDir: 1, ballPos: { x: 10, y: 3, z: 90 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 7. Ball near post left
  { carPos: { x: -20, y: 2, z: 80 }, carDir: 1, ballPos: { x: -12, y: 3, z: 105 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 8. Ball near post right
  { carPos: { x: 20, y: 2, z: 80 }, carDir: 1, ballPos: { x: 12, y: 3, z: 105 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 9. Ball rolling across from left
  { carPos: { x: 0, y: 2, z: 70 }, carDir: 1, ballPos: { x: -25, y: 3, z: 95 }, ballVel: { x: 10, y: 0, z: 3 } },
  // 10. Centered, close range
  { carPos: { x: 0, y: 2, z: 90 }, carDir: 1, ballPos: { x: 0, y: 3, z: 108 }, ballVel: { x: 0, y: 0, z: 0 } },
];

export const STRIKER_PRO = [
  // 1. Rolling ball from midfield
  { carPos: { x: 0, y: 2, z: 20 }, carDir: 1, ballPos: { x: 0, y: 3, z: 50 }, ballVel: { x: 0, y: 0, z: 15 } },
  // 2. Cross from left wall
  { carPos: { x: 0, y: 2, z: 80 }, carDir: 1, ballPos: { x: -50, y: 3, z: 85 }, ballVel: { x: 20, y: 5, z: 5 } },
  // 3. Cross from right wall
  { carPos: { x: 0, y: 2, z: 80 }, carDir: 1, ballPos: { x: 50, y: 3, z: 85 }, ballVel: { x: -20, y: 5, z: 5 } },
  // 4. Bouncing ball
  { carPos: { x: 10, y: 2, z: 60 }, carDir: 1, ballPos: { x: 5, y: 8, z: 80 }, ballVel: { x: 0, y: 5, z: 8 } },
  // 5. Fast rolling from angle
  { carPos: { x: -30, y: 2, z: 40 }, carDir: 1, ballPos: { x: -20, y: 3, z: 65 }, ballVel: { x: 8, y: 0, z: 18 } },
  // 6. Ball popping up near goal
  { carPos: { x: 15, y: 2, z: 75 }, carDir: 1, ballPos: { x: 0, y: 3, z: 95 }, ballVel: { x: 0, y: 12, z: 3 } },
  // 7. Redirect from corner
  { carPos: { x: 0, y: 2, z: 90 }, carDir: 1, ballPos: { x: -40, y: 3, z: 100 }, ballVel: { x: 18, y: 3, z: -2 } },
  // 8. Rolling backward toward you
  { carPos: { x: 0, y: 2, z: 100 }, carDir: 1, ballPos: { x: 0, y: 3, z: 80 }, ballVel: { x: 0, y: 0, z: 12 } },
  // 9. High bounce center
  { carPos: { x: 0, y: 2, z: 50 }, carDir: 1, ballPos: { x: 0, y: 15, z: 90 }, ballVel: { x: 0, y: -5, z: 5 } },
  // 10. Tight angle from far
  { carPos: { x: -50, y: 2, z: 50 }, carDir: 1, ballPos: { x: -30, y: 3, z: 90 }, ballVel: { x: 5, y: 0, z: 8 } },
];

export const STRIKER_ALLSTAR = [
  // 1. Fast cross — redirect into goal
  { carPos: { x: 5, y: 2, z: 95 }, carDir: 1, ballPos: { x: -60, y: 5, z: 90 }, ballVel: { x: 30, y: 3, z: 5 } },
  // 2. High aerial — ball floating above goal
  { carPos: { x: 0, y: 2, z: 60 }, carDir: 1, ballPos: { x: 0, y: 20, z: 100 }, ballVel: { x: 0, y: 0, z: 3 } },
  // 3. Fast rolling from distance
  { carPos: { x: 0, y: 2, z: -20 }, carDir: 1, ballPos: { x: 0, y: 3, z: 30 }, ballVel: { x: 0, y: 0, z: 25 } },
  // 4. Wall pass — ball off right wall
  { carPos: { x: 20, y: 2, z: 75 }, carDir: 1, ballPos: { x: 60, y: 8, z: 85 }, ballVel: { x: -15, y: 8, z: 10 } },
  // 5. Double touch setup — ball going up
  { carPos: { x: 0, y: 2, z: 80 }, carDir: 1, ballPos: { x: 5, y: 3, z: 95 }, ballVel: { x: -3, y: 18, z: 2 } },
  // 6. Powershot from distance
  { carPos: { x: 0, y: 2, z: 0 }, carDir: 1, ballPos: { x: 0, y: 3, z: 40 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 7. Aerial redirect
  { carPos: { x: -20, y: 2, z: 70 }, carDir: 1, ballPos: { x: 30, y: 12, z: 95 }, ballVel: { x: -18, y: 2, z: 3 } },
  // 8. Backboard read
  { carPos: { x: 0, y: 2, z: 85 }, carDir: 1, ballPos: { x: -10, y: 10, z: 110 }, ballVel: { x: 5, y: 8, z: 8 } },
  // 9. Fast cross from right
  { carPos: { x: -10, y: 2, z: 90 }, carDir: 1, ballPos: { x: 55, y: 6, z: 95 }, ballVel: { x: -28, y: 5, z: 4 } },
  // 10. Pop fly center — aerial finish
  { carPos: { x: 0, y: 2, z: 50 }, carDir: 1, ballPos: { x: 0, y: 3, z: 75 }, ballVel: { x: 0, y: 22, z: 8 } },
];

// ===== GOALIE PACKS =====
// Player defends the BLUE goal (at z = -118.5). Shots come toward blue goal.

export const GOALIE_ROOKIE = [
  // Balls spawn close, airborne, with 1.5s delay. No shots directly at the player (x=0).
  // Player must move left or right to make the save.
  // 1. Low shot to left post
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: 15, y: 5, z: -70 }, ballVel: { x: -8, y: 5, z: -38 } },
  // 2. Low shot to right post
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: -15, y: 5, z: -70 }, ballVel: { x: 8, y: 5, z: -38 } },
  // 3. Bouncer angling left
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: 10, y: 5, z: -65 }, ballVel: { x: -10, y: 10, z: -38 } },
  // 4. Bouncer angling right
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: -10, y: 5, z: -65 }, ballVel: { x: 10, y: 10, z: -38 } },
  // 5. Wide left — near post
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: -20, y: 5, z: -68 }, ballVel: { x: 4, y: 6, z: -40 } },
  // 6. Wide right — near post
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: 20, y: 5, z: -68 }, ballVel: { x: -4, y: 6, z: -40 } },
  // 7. Arcing to left post from right side
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: -18, y: 5, z: -62 }, ballVel: { x: 6, y: 12, z: -38 } },
  // 8. Arcing to right post from left side
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: 18, y: 5, z: -62 }, ballVel: { x: -6, y: 12, z: -38 } },
  // 9. Mid-height left
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: 12, y: 6, z: -65 }, ballVel: { x: -6, y: 14, z: -36 } },
  // 10. Mid-height right
  { carPos: { x: 0, y: 2, z: -105 }, carDir: 1, ballPos: { x: -12, y: 6, z: -65 }, ballVel: { x: 6, y: 14, z: -36 } },
];

export const GOALIE_PRO = [
  // All airborne, faster, higher. No shots at x=0 — always offset to posts.
  // 1. Rocket to left post
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: 20, y: 5, z: -60 }, ballVel: { x: -10, y: 8, z: -42 } },
  // 2. Rocket to right post
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: -20, y: 5, z: -60 }, ballVel: { x: 10, y: 8, z: -42 } },
  // 3. High arcing left
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: 15, y: 5, z: -55 }, ballVel: { x: -8, y: 18, z: -38 } },
  // 4. High arcing right
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: -15, y: 5, z: -55 }, ballVel: { x: 8, y: 18, z: -38 } },
  // 5. Cross from left wall into right post
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: -40, y: 5, z: -55 }, ballVel: { x: 22, y: 10, z: -32 } },
  // 6. Cross from right wall into left post
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: 40, y: 5, z: -55 }, ballVel: { x: -22, y: 10, z: -32 } },
  // 7. Low screamer far left
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: 25, y: 5, z: -58 }, ballVel: { x: -12, y: 6, z: -44 } },
  // 8. High bomb dropping to right side
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: -12, y: 5, z: -50 }, ballVel: { x: 6, y: 22, z: -36 } },
  // 9. Diagonal cannon from left
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: -30, y: 5, z: -50 }, ballVel: { x: 14, y: 14, z: -40 } },
  // 10. Dipping shot to right corner
  { carPos: { x: 0, y: 2, z: -108 }, carDir: 1, ballPos: { x: 8, y: 14, z: -55 }, ballVel: { x: -6, y: 4, z: -42 } },
];

export const GOALIE_ALLSTAR = [
  // All shots arrive at y≈14-16 (upper goal) and x≈±8-14 (inside ±17 posts, away from player at x=0).
  // Goal line z=-118.5, goal posts x=±17, goal height=18. Player at x=0 z=-110.
  // t=(118.5-|z0|)/|vz|, vy=(y_target - y0 + 6.5t²)/t, vx=(x_target - x0)/t.

  // 1. Upper left snipe — t=1.38s, arrives x≈-12 y≈15
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: 10, y: 5, z: -55 }, ballVel: { x: -16, y: 16, z: -46 } },
  // 2. Upper right snipe — t=1.38s, arrives x≈12 y≈15
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: -10, y: 5, z: -55 }, ballVel: { x: 16, y: 16, z: -46 } },
  // 3. Upper left off-center — t=1.56s, arrives x≈-10 y≈16
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: 12, y: 5, z: -50 }, ballVel: { x: -14, y: 17, z: -44 } },
  // 4. Upper right off-center — t=1.56s, arrives x≈10 y≈16
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: -12, y: 5, z: -50 }, ballVel: { x: 14, y: 17, z: -44 } },
  // 5. Cross from left wall to upper right — t=1.9s, arrives x≈12 y≈15
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: -35, y: 5, z: -50 }, ballVel: { x: 25, y: 18, z: -36 } },
  // 6. Cross from right wall to upper left — t=1.9s, arrives x≈-12 y≈15
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: 35, y: 5, z: -50 }, ballVel: { x: -25, y: 18, z: -36 } },
  // 7. Knuckleball dipping upper left — t=1.56s, starts y=14, arrives x≈-10 y≈14
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: 6, y: 14, z: -50 }, ballVel: { x: -10, y: 6, z: -44 } },
  // 8. Knuckleball dipping upper right — t=1.56s, starts y=14, arrives x≈10 y≈14
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: -6, y: 14, z: -50 }, ballVel: { x: 10, y: 6, z: -44 } },
  // 9. Far-range arc upper left — t=2.07s, arrives x≈-10 y≈15
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: 12, y: 5, z: -40 }, ballVel: { x: -11, y: 18, z: -38 } },
  // 10. Cannon upper right — fastest, t=1.43s, arrives x≈10 y≈15
  { carPos: { x: 0, y: 2, z: -110 }, carDir: 1, ballPos: { x: -8, y: 5, z: -50 }, ballVel: { x: 13, y: 17, z: -48 } },
];

// ===== AERIAL PACKS =====
// Player must aerial and score on the orange goal (z = +118.5)

export const AERIAL_ROOKIE = [
  // Ball is frozen in the air until the player touches it, then it's in play.
  // 1. Low floater — barely off ground, centered
  { carPos: { x: 0, y: 2, z: 70 }, carDir: 1, ballPos: { x: 0, y: 6, z: 100 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 2. Slightly higher, centered
  { carPos: { x: 0, y: 2, z: 60 }, carDir: 1, ballPos: { x: 0, y: 8, z: 95 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 3. Low left of goal
  { carPos: { x: -10, y: 2, z: 65 }, carDir: 1, ballPos: { x: -5, y: 6, z: 98 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 4. Low right of goal
  { carPos: { x: 10, y: 2, z: 65 }, carDir: 1, ballPos: { x: 5, y: 6, z: 98 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 5. Medium height, dead center
  { carPos: { x: 0, y: 2, z: 70 }, carDir: 1, ballPos: { x: 0, y: 10, z: 100 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 6. Higher up, centered
  { carPos: { x: 0, y: 2, z: 55 }, carDir: 1, ballPos: { x: 0, y: 12, z: 95 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 7. Mid-height, slightly left
  { carPos: { x: -10, y: 2, z: 60 }, carDir: 1, ballPos: { x: -6, y: 9, z: 100 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 8. Off-center left, low
  { carPos: { x: -15, y: 2, z: 70 }, carDir: 1, ballPos: { x: -8, y: 7, z: 102 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 9. Off-center right, low
  { carPos: { x: 15, y: 2, z: 70 }, carDir: 1, ballPos: { x: 8, y: 7, z: 102 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 10. Higher ball, near top of goal
  { carPos: { x: 0, y: 2, z: 50 }, carDir: 1, ballPos: { x: 0, y: 14, z: 98 }, ballVel: { x: 0, y: 0, z: 0 } },
];

export const AERIAL_PRO = [
  // Ball is frozen in the air until the player touches it, then it's in play.
  // Higher and further from goal than rookie — requires longer aerials.
  // 1. High ball, straight on, midfield
  { carPos: { x: 0, y: 2, z: 20 }, carDir: 1, ballPos: { x: 0, y: 16, z: 70 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 2. High ball, offset left
  { carPos: { x: -20, y: 2, z: 15 }, carDir: 1, ballPos: { x: -8, y: 15, z: 65 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 3. Very high, dead center
  { carPos: { x: 0, y: 2, z: 10 }, carDir: 1, ballPos: { x: 0, y: 22, z: 75 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 4. High right, wide approach
  { carPos: { x: 25, y: 2, z: 20 }, carDir: 1, ballPos: { x: 10, y: 16, z: 70 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 5. Far out, high center
  { carPos: { x: 0, y: 2, z: 0 }, carDir: 1, ballPos: { x: 0, y: 18, z: 60 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 6. Very high, slightly left
  { carPos: { x: -15, y: 2, z: 10 }, carDir: 1, ballPos: { x: -5, y: 24, z: 72 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 7. High, offset right
  { carPos: { x: 20, y: 2, z: 15 }, carDir: 1, ballPos: { x: 12, y: 17, z: 68 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 8. Near ceiling, far from goal
  { carPos: { x: 0, y: 2, z: -5 }, carDir: 1, ballPos: { x: 0, y: 26, z: 65 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 9. High left post angle
  { carPos: { x: -20, y: 2, z: 5 }, carDir: 1, ballPos: { x: -10, y: 20, z: 72 }, ballVel: { x: 0, y: 0, z: 0 } },
  // 10. Very high, longest aerial
  { carPos: { x: 0, y: 2, z: -10 }, carDir: 1, ballPos: { x: 0, y: 28, z: 60 }, ballVel: { x: 0, y: 0, z: 0 } },
];

export const AERIAL_ALLSTAR = [
  // Ball launches from near orange goal in huge lofty arcs TOWARD the player.
  // Player positioned ~15 units behind where the ball peaks so they drive forward into the aerial.
  // Peak z = ballPos.z + vz * (vy / 13). Player placed slightly behind that.
  // Gravity = -13 m/s². Ceiling at 51m.

  // 1. Towering center lob — peaks z≈18, player at z≈5
  { carPos: { x: 0, y: 2, z: 5 }, carDir: 1, ballPos: { x: 0, y: 3, z: 100 }, ballVel: { x: 0, y: 38, z: -28 } },
  // 2. Lob from left post drifting center — peaks z≈33, player at z≈18
  { carPos: { x: 10, y: 2, z: 18 }, carDir: 1, ballPos: { x: -15, y: 3, z: 105 }, ballVel: { x: 8, y: 36, z: -26 } },
  // 3. Lob from right post drifting center — peaks z≈33, player at z≈18
  { carPos: { x: -10, y: 2, z: 18 }, carDir: 1, ballPos: { x: 15, y: 3, z: 105 }, ballVel: { x: -8, y: 36, z: -26 } },
  // 4. Near-ceiling moonshot — peaks z≈-2, player at z≈-15
  { carPos: { x: 0, y: 2, z: -15 }, carDir: 1, ballPos: { x: 0, y: 3, z: 95 }, ballVel: { x: 0, y: 42, z: -30 } },
  // 5. Left corner cannon sweeping right — peaks z≈18, player at z≈5
  { carPos: { x: 15, y: 2, z: 5 }, carDir: 1, ballPos: { x: -30, y: 3, z: 100 }, ballVel: { x: 14, y: 38, z: -28 } },
  // 6. Right corner cannon sweeping left — peaks z≈18, player at z≈5
  { carPos: { x: -15, y: 2, z: 5 }, carDir: 1, ballPos: { x: 30, y: 3, z: 100 }, ballVel: { x: -14, y: 38, z: -28 } },
  // 7. Deep goal lob — peaks z≈14, player at z≈0
  { carPos: { x: 0, y: 2, z: 0 }, carDir: 1, ballPos: { x: 0, y: 3, z: 112 }, ballVel: { x: 0, y: 40, z: -32 } },
  // 8. Wide diagonal from left — peaks z≈28, player at z≈13
  { carPos: { x: -20, y: 2, z: 13 }, carDir: 1, ballPos: { x: -25, y: 3, z: 105 }, ballVel: { x: 16, y: 36, z: -28 } },
  // 9. Wide diagonal from right — peaks z≈28, player at z≈13
  { carPos: { x: 20, y: 2, z: 13 }, carDir: 1, ballPos: { x: 25, y: 3, z: 105 }, ballVel: { x: -16, y: 36, z: -28 } },
  // 10. Ultimate moonshot — peaks z≈0, player at z≈-15
  { carPos: { x: 0, y: 2, z: -15 }, carDir: 1, ballPos: { x: -5, y: 3, z: 115 }, ballVel: { x: 3, y: 44, z: -34 } },
];

// Pack index for easy lookup
export const TRAINING_PACKS = {
  striker: { rookie: STRIKER_ROOKIE, pro: STRIKER_PRO, allstar: STRIKER_ALLSTAR },
  goalie: { rookie: GOALIE_ROOKIE, pro: GOALIE_PRO, allstar: GOALIE_ALLSTAR },
  aerial: { rookie: AERIAL_ROOKIE, pro: AERIAL_PRO, allstar: AERIAL_ALLSTAR },
};
