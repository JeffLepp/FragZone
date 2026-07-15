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
managed by systemd. Provision the box, then:

```bash
# on the VM, as a sudo user
sudo DOMAIN=<your-domain> SUB=<subdomain> bash deploy/setup.sh
```

`deploy/setup.sh` installs Node LTS + Caddy, deploys `server/` to
`/opt/fragzone`, runs `npm ci --omit=dev`, wires up the `fragzone` systemd
service, opens 80/443, and has Caddy obtain the TLS cert. Run it without
`DOMAIN` to stand up the server before DNS exists, then re-run with `DOMAIN`
set to add TLS. See `deploy/` for the systemd unit and Caddyfile.

Point a **DNS-only (gray-cloud)** A record at the VM's public IP so players
connect straight to Oracle.

### Client → Vercel
1. Import `client/` folder (or root) to Vercel
2. Set environment variable: `VITE_WS_URL=wss://<server-subdomain>.<your-domain>`
3. Deploy (Vite compiles the URL in at build time — redeploy after any change)

## Stack

- **Client**: Vite + Three.js (vanilla JS, no framework) — Vercel
- **Server**: Node.js + ws (WebSocket) — Oracle Cloud ARM VM, Caddy + systemd
