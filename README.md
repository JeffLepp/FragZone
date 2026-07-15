<div align="center">

![FragZone gameplay](FragzoneRepoShowcase.gif)

# FragZone — Browser FPS

## [Play FragZone](https://fragzone.jeffersonkline.com)

</div>

---

<table width="100%">
<tr>
<td width="28%" valign="top">

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

</td>
<td width="27%" valign="top">

## Security

[exploits.md](exploits.md) documents the client-abuse controls and their known
trust boundaries; [SECURITY.md](SECURITY.md) is for private vulnerability
reporting.

## Stack

**Client**: Vite + Three.js (vanilla JS, no framework) — Vercel

**Server**: Node.js + ws (WebSocket) — Oracle Cloud ARM VM, Cloudflare Tunnel + systemd

</td>
<td width="45%" valign="top">

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

</td>
</tr>
</table>

## Legal and project status

FragZone is an independent project and is not affiliated with, endorsed by, or
sponsored by Valve Corporation. Counter-Strike and Valve are trademarks or
registered trademarks of Valve Corporation.

The original FragZone code and assets are **source available, all rights
reserved**; public visibility does not grant permission to reuse or redistribute
them. See [LICENSE.md](LICENSE.md). Direct dependencies retain their own MIT
licenses; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

Players must be 13 or older and agree to the live service's
[Terms of Use](https://fragzone.jeffersonkline.com/terms.html) and
[Privacy Notice](https://fragzone.jeffersonkline.com/privacy.html).
