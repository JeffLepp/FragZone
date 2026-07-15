<div align="center">

![FragZone gameplay](FragzoneRepoShowcase.gif)

# FragZone — Browser FPS

**CS:Source-inspired online FPS. Free-for-all deathmatch, up to 8 players.**

Three.js · WebSockets · no install, no plugins — just a browser.

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

## Deploy

### Server → Oracle Cloud (Always Free ARM VM)

The server runs on an Ubuntu ARM64 VM behind Caddy (TLS/WSS reverse proxy),
managed by systemd. Point DNS at the VM, open 80/443 in the Oracle VCN security
list, then run:

```bash
# on the VM, as a sudo user
sudo DOMAIN=example.com \
  SITE_ORIGINS=https://example.com,https://www.example.com \
  bash deploy/setup.sh
```

`DOMAIN` creates `fragzone-server.example.com` by default; override the label
with `SUB`. `SITE_ORIGINS` must list the exact HTTPS origins allowed to open a
browser WebSocket. The script can run without `DOMAIN` before DNS is ready, but
browser origins remain locked down until it is rerun with the production site.

Point a **DNS-only (gray-cloud)** A record at the VM's public IP so players
connect straight to Oracle. Port 8080 stays bound to loopback and must not be
opened in the cloud firewall. Restrict SSH/22 in the Oracle VCN to trusted
administrator IPs and use key-based login.

### Client → Vercel
1. Import `client/` folder (or root) to Vercel
2. Set environment variable: `VITE_WS_URL=wss://<server-subdomain>.<your-domain>`
3. Deploy (Vite compiles the URL in at build time — redeploy after any change)

The Vercel and Caddy configs include restrictive browser security headers. Keep
production secrets in `/etc/fragzone.env`; never put them in this repository.

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
