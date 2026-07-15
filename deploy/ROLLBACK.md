# FragZone — Railway → Oracle migration / rollback record

Date: 2026-07-14

## Hostnames
| Role | Old (Railway) | New (Oracle) |
|------|---------------|--------------|
| Game client | `frag-zone-chi.vercel.app` | `https://fragzone.jeffersonkline.com` (Vercel) |
| Game server (WSS) | `wss://fragzone-server.railway.app` | `wss://fragzone-server.jeffersonkline.com` (Oracle) |

`wss://fragzone-server.railway.app` is the old value documented in this repo's
README; the live Vercel var was type "sensitive" and could not be read back.
Confirm against Railway before deleting that project.

## Oracle VM
- Region: `us-phoenix-1` (account home region; San Jose was unavailable)
- Shape: `VM.Standard.A1.Flex`, 1 OCPU / 6 GB RAM — Always-Free-eligible
- OS: Ubuntu 24.04 LTS (aarch64)
- Public IP: `137.131.31.32` (ephemeral, attached to the instance)
- SSH: `ubuntu@137.131.31.32`, key `~/.ssh/fragzone_oracle`, port 22 restricted
  to the admin IP at the OCI security list
- Instance OCID: kept out of the repo — read it from the OCI console / `oci compute instance list`

## Server layout on the VM
- App: `/opt/fragzone/server` (owned by `fragzone`), started via `npm start`
- Binds `127.0.0.1:8080` only (never public)
- systemd unit: `/etc/systemd/system/fragzone.service`
- Env file: `/etc/fragzone.env` (root:root 0600; empty — app needs no secrets)
- Reverse proxy: Caddy, config `/etc/caddy/Caddyfile`, TLS via Let's Encrypt
- Firewall: ufw (OpenSSH/80/443) + OCI security list

## Cloudflare DNS (zone jeffersonkline.com, all gray-cloud / DNS-only)
- `fragzone`         CNAME → `cname.vercel-dns.com`  (client, Vercel)
- `fragzone-server`  A     → `137.131.31.32`         (server, Oracle)
- No other records were touched.

## Vercel
- Project `frag-zone` (`prj_MVec3vNx2FMCsfzsjYIk26UduBG2`)
- `VITE_WS_URL=wss://fragzone-server.jeffersonkline.com` (production + preview)
- Custom domain `fragzone.jeffersonkline.com` added
- Redeployed: `dpl_HCEvanMVhdqhUjM9sBPg5PB4scFK`

## Files changed (branch `oracle-migration`)
- `server/index.js` — HOST bind, /health + /metrics, graceful shutdown, tick
  instrumentation, perMessageDeflate:false
- `server/loadtest.js` — 8-client protocol load test (new)
- `deploy/setup.sh`, `deploy/fragzone.service`, `deploy/Caddyfile` (new)
- `.gitattributes` — LF for VM-executed files
- `README.md` — deploy docs

## Rollback (revert to Railway)
1. Vercel: set `VITE_WS_URL=wss://fragzone-server.railway.app`, redeploy.
2. Cloudflare: repoint `fragzone` to the Vercel app if needed (already there),
   or restore the client's original URL.
3. Re-enable the Railway service.
Client and server state are entirely in-memory; nothing to migrate back.
