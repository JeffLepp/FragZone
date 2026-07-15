<div align="center">

![FragZone gameplay](FragzoneRepoShowcase.gif)

# FragZone — Browser FPS

## [Play FragZone](https://fragzone.jeffersonkline.com)

</div>

---

## Controls

| Key | Action |
|-----|--------|
| WASD | Move |
| Mouse | Aim |
| LMB | Shoot |
| Shift | Walk (quiet) |
| Space | Jump |
| Ctrl | Crouch |
| G | Throw grenade |
| R | Reload |
| 1 / 2 | Switch weapon |
| Tab | Scoreboard |
| B | Toggle bots |

## Local Dev

**Terminal 1 — game server:**
```bash
cd server
npm install
npm run dev
```

**Terminal 2 — client:**
```bash
cd client
npm install
npm run dev
# open http://localhost:3000
```

## Verification

```bash
cd server && npm test
cd ../client && npm run build
```

The server test covers origin rejection, player capacity, invalid JSON shapes,
oversized frames, message-rate limiting, and private metrics.
[exploits.md](exploits.md) documents the client-abuse controls and their known
trust boundaries; [SECURITY.md](SECURITY.md) is for private vulnerability
reporting.

## Stack

- **Client**: Vite + Three.js (vanilla JS, no framework) — Vercel
- **Server**: Node.js + ws (WebSocket) — Oracle Cloud ARM VM, Caddy + systemd
