# Production deployment

FragZone uses separate delivery paths for the browser client and the realtime
game server:

- The Vite client is deployed to Vercel behind the public custom domain.
- The Node.js server runs as an unprivileged systemd service on an Oracle Cloud
  ARM64 VM.
- Cloudflare Tunnel provides outbound-only WebSocket ingress and TLS. The game
  and metrics listeners remain bound to loopback.

## Server bootstrap

Run the idempotent bootstrap script on an Ubuntu ARM64 host:

```bash
sudo DOMAIN=example.com \
  SITE_ORIGINS=https://example.com,https://www.example.com \
  bash deploy/setup.sh
```

The script installs Node.js, creates the `fragzone` service account, deploys to
`/opt/fragzone`, configures systemd, and keeps inbound web ports closed. Runtime
configuration is written to root-owned files under `/etc`.

## Tunnel ingress

Create a remotely managed Cloudflare Tunnel and install the connector issued by
the Cloudflare dashboard:

```bash
sudo env TUNNEL_TOKEN='<connector-token>' bash deploy/tunnel-setup.sh install
```

In Cloudflare, map the public server hostname to `http://localhost:8080`. After
the public `/health` endpoint succeeds through the tunnel, close any retired
direct-origin path:

```bash
sudo bash deploy/tunnel-setup.sh finalize
```

Keep SSH restricted to trusted administrator addresses. Ports 8080 and 8081
must never be exposed by the host firewall or cloud security rules.

## Verification

```bash
systemctl is-active fragzone cloudflared
curl --fail http://127.0.0.1:8080/health
curl --fail http://127.0.0.1:8081/metrics
curl --fail https://<public-server-host>/health
```

The public server host should expose `/health` but not `/metrics`.

## Direct-origin rollback

Cloudflare Tunnel is the supported ingress. If an emergency requires the
retired Caddy path, rerun `deploy/setup.sh` with `DIRECT_CADDY=1`, point the
server hostname to the current origin address, and explicitly open ports 80 and
443 in both the host firewall and cloud security rules. Disable this path and
close those ports again after tunnel ingress is restored.
