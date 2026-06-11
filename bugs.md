# Bugs & Code Review Findings

From a full code review on 2026-06-11. Ordered by severity within each section.

## Minor bugs

### 1. Server anti-cheat gaps
**Where:** `server/index.js:351-364` (move), `:366-380` (shoot)

- The anti-teleport check is horizontal-only and `Math.max(0, y)` is the only
  Y validation — a modified client can fly.
- A rejected move doesn't update `lastUpdate`, so `dt` keeps growing and a
  cheater can teleport anywhere by pausing ~2 s between hops.
- `shoot` checks range but not line-of-sight — `losBlocked()` already exists
  and could be reused there.

### 2. Pistol clicks during fire cooldown are eaten
**Where:** `client/src/player.js:285-286, 712-713`

`_semi_prev` is updated even when `_tryShoot` early-returns for cooldown, so a
click landing ~50 ms early fires nothing. Buffer the click, or only update
`_semi_prev` when a shot was actually evaluated.

### 3. Client bots clip through the spiral ramp (cosmetic)
**Where:** `client/src/bot.js:18-25` + `client/src/map.js`

Client `COLLISION_BOXES` doesn't include the ramp (it's handled analytically
via `RAMPS`), and `botBlockedAt` only checks the boxes, so bots chasing the
player into the tower clip through the low ramp segments visually.

## Simplifications

### 4. Stop hand-syncing game data between client and server (biggest win)
Duplicated with "keep in sync" comments today:
- Wall/crate/tower/ramp geometry: `client/src/map.js:92-135` vs
  `server/index.js:77-98`
- Spawn points: `map.js:147-156` vs `server/index.js:7-12`
- Explosion constants: `main.js:229-230` vs `server/index.js:111-112`
- Weapon damage/RPM: `player.js:39,46` vs `server/index.js:103-106`

A single `shared/` module (plain data, no Three.js imports — `.json` or a
dual-loadable `.js`) eliminates the most likely future desync bug.

### 5. Smaller cleanups
- Grenade bounce logic written out twice in the server tick
  (`server/index.js:474-485` and `:490-498`) — extract a helper.
- `Bot._blocked` (`bot.js:164-166`) is a one-line wrapper around
  `botBlockedAt` — call it directly from `_slide`.
- Dead code: the `weaponName === 'grenade'` branch in `hud.updateAmmo`
  (`hud.js:417-420`) is never reached; `hud.setInfo` (`hud.js:531`) has no
  callers.
- `RemotePlayer.rayIntersect` and `Bot.rayIntersect` are near-duplicates —
  could share one AABB-ray helper.

## Optimizations

(None urgent — the frame loop is lean. In order of payoff.)

- **Tower window panes are ~120 individual meshes** (`map.js:225-241`), i.e.
  ~120 draw calls of pure decoration. Two `InstancedMesh`es (or merged
  geometry per material) collapses that to 2–4 calls.
- **`hud.updateHealth` runs every frame** (`main.js:400`) writing
  `textContent` + computed `style.color` even when nothing changed. Health
  already updates through `takeDamage`/`setHealth`/`respawn`, so the per-frame
  call can go — or guard with a last-value check.
- **Server `COLLISION_BOXES` is ~200 boxes, ~174 of which are tiny ramp
  slabs** (`server/index.js:60-68`); `grenadeBlocked`/`losBlocked` scan all of
  them linearly. A tower bounding-box early-out cuts those loops ~8× in the
  common case.
- **Per-frame/per-event allocations:** `_updateVM` creates two `Vector3`s per
  frame (`player.js:658,674`); each shot/explosion news up a `Raycaster` and
  vectors. Module-level scratch objects would quiet GC pressure during big bot
  waves.
- **Each bot builds its own HP-bar geometries/materials** (`bot.js:62-67`) —
  share them like `IMPACT_GEO`/`IMPACT_MAT` already do.
- **`wsOfId` is a linear scan** (`server/index.js:215-218`) called per hit and
  per explosion — keep an `id → ws` Map if player counts grow.
