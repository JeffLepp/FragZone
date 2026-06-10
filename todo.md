# FragZone — Code Review TODO

From codebase review on 2026-06-10. Ordered by impact.

## Real bugs

- [x] **Reconnecting mid-game never re-joins — game silently dies.**
  `network.js:30-38` auto-reconnects, but `main.js:121-127` only re-sends `join` if `!network.id`. After a mid-game drop, `network.id` is set, so no `join` is sent and the server ignores every message from the un-joined connection. Fix: on reconnect, re-send `join` and reset/rebuild remote-player state (server assigns a new id).

- [x] **Shooting fires when the pointer isn't locked.**
  `player.js:130-131` sets `_lmbDown` on any left click. The click that re-acquires pointer lock (and the "ENTER FRAG" button click) fires a shot and burns ammo. Gate `_lmbDown` on `document.pointerLockElement` like the mousemove handler.

- [x] **Stuck movement keys on alt-tab / pointer-lock loss.**
  `_keys` (`player.js:104`) is never cleared on window blur or pointer-lock drop, so missed `keyup`s leave the player running. Clear the set on `blur` and `pointerlockchange`.

- [x] **Suicide grenades award the killer a kill.**
  `server/index.js:104-141`: when a grenade owner kills themselves, `attacker === victim`, so they get `kills++` and an "X killed X" feed entry. Subtract a kill (or don't add one) on self-kill.

- [x] **`Math.max(1, …)` damage floor makes 0-damage weapons deal damage.**
  `grenade` is in `WEAPON_DATA` with `damage: 0` (`server/index.js:17`); a client can send `{type:'shoot', weapon:'grenade'}` and the floor at `server/index.js:120` turns 0 into 1 damage, spammable at unlimited rate. Remove `grenade` from the shootable set or reject `damage <= 0` before the floor.

- [x] **Client-side bot deaths desync you from the server.**
  Bot kills (`main.js:288-305`) cause purely local death/respawn: server still thinks you're alive at the old position with full health. Other players see you standing there; your respawn teleport gets rejected by the anti-teleport check (`server/index.js:212`) causing position desync; the health-pack `health >= 100` check uses server health. Tell the server about local respawns or exempt them.

- [x] **Reconnect floods the server with stale queued messages.**
  `Network.send` queues unboundedly while disconnected (`network.js:57-64`) — a 30 s outage queues ~600 stale `move` messages that blast out on reconnect. Drop `move` messages when disconnected, or cap/clear the queue.

- [x] **Stale muzzle flash on weapon switch.**
  `player.js:563-572`: switching weapons during the 45 ms flash window hides the *new* weapon's flash, leaving the old weapon's flash visible until it's fired again. Hide both flashes on switch, or store the flash that was triggered.

## Cheating surface (server trusts the client too much)

- [x] **`shoot` has no rate limit, range, or LOS check** (`server/index.js:222-226`). A modified client can spam `shoot` at any `targetId` anywhere for instant cross-map kills. Minimum fix: per-player cooldown derived from weapon RPM + max-distance check using server positions.
- [x] **`throwGrenade` has no inventory or rate limit** (`server/index.js:227-235`); grenade count only lives on the client. Also `msg.pos`/`msg.vel` aren't validated for finiteness — NaN velocities propagate into physics and get broadcast. Track grenade count server-side and validate arrays like `move` does.
- [ ] **Ammo/reload is fully client-side** — server can't validate fire rate without tracking ammo. Acceptable for prototype; revisit before public play.

## Resource leaks

- [x] **Bullet impact effects leak GPU memory**: `player.js:324-333` creates a new `SphereGeometry` + material per wall hit and never disposes. Share one geometry/material at module level.
- [x] **Remote player name tags leak**: `RemotePlayer.dispose()` (`remote.js:112-115`) doesn't dispose canvas texture, sprite material, or body geometry/material. Same for `Bot._die()` (`bot.js:87-91`).
- [ ] **Delete the 21 MB `.client-git-backup/` directory** (gitignored but still on disk) if no longer needed.

## Cleanups / simplifications

- [x] **Duplicate join message**: `hud.onPlay` sends `join` (`main.js:251`) which gets queued, then the `'open'` status handler sends it again (`main.js:122-124`). Keep only the status-handler path (it also covers reconnects once the rejoin bug is fixed).
- [x] **Redundant semi-auto check**: fresh-click logic exists in both `update()` (`player.js:604-610`) and `_tryShoot` (`player.js:236-237`). Keep it in one place.
- [x] **Damage constants disagree**: server ak 27 / pistol 35 (`server/index.js:14-18`) vs client ak 26 / pistol 34 (`player.js:26,33`). Client values only hit bots, but align them.
- [ ] **`SPAWN_POINTS` duplicated** in `server/index.js:7-12` and `map.js:77-86` — kept in sync by hand. Same for map geometry: server has no walls, so grenades fly through walls and explosion damage ignores cover (possible gameplay bug too).
- [x] **Dead code**: `player.vel` stored server-side but never read (`server/index.js:214`); `AudioSystem._connect` (`audio.js:31-37`) never called; `playGrenadeBounce` never called; `hud._bloomSize` written but never read. (Also stopped the client sending `vel` in `move` messages.)
- [x] **`let` → `const`** for `players`, `grenades`, `pickups` in `server/index.js:43-47`.
- [x] **Scoreboard goes stale while held open**: `updateScoreboard` (`hud.js:474-476`) only stores data; rows render once on Tab-down. Re-render when an update arrives while visible.
- [x] **Tab is hijacked while typing your name**: keydown handler (`player.js:111-119`) is bound before the game starts, so Tab in the menu opens an empty scoreboard and blocks focus navigation. Gated on `this.id` (set once `init` arrives).
- [x] **innerHTML with player names** in kill feed and scoreboard (`hud.js:463`, `hud.js:483-492`): server strips `<>&"` so not exploitable today, but it's a fragile two-file invariant — build rows with `textContent`.

## Suggested priority

1. Reconnect rejoin (top bug — real players hit this constantly)
2. Input gating (pointer-lock shooting + stuck keys)
3. `shoot` message validation (public server cheating surface)
