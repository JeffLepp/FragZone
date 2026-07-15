#!/usr/bin/env bash
# FragZone - put the game server behind Cloudflare Tunnel (free, no compute).
#
# Adds an outbound-only cloudflared connector: no inbound web port is exposed,
# no origin certificate is needed, and the real client IP arrives in
# CF-Connecting-IP (server/index.js trusts it only from the loopback proxy).
#
# Two phases, run in order so there is no downtime:
#
#   1) install - bring cloudflared up before creating or moving DNS:
#        sudo env TUNNEL_TOKEN='<connector-token>' bash tunnel-setup.sh install
#      Then, in the Cloudflare dashboard, add the Public Hostname
#      (fragzone-server.<domain> -> HTTP localhost:8080). Traffic cuts over to
#      the already-healthy tunnel. Verify: curl https://<host>/health
#
#   2) finalize - only AFTER the public hostname verifies through the tunnel;
#      this also retires an old Caddy origin if one exists:
#        sudo bash tunnel-setup.sh finalize
set -euo pipefail

PHASE="${1:-install}"
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

case "$PHASE" in
install)
  : "${TUNNEL_TOKEN:?set TUNNEL_TOKEN=<connector token from the CF dashboard>}"

  if ! command -v cloudflared >/dev/null; then
    echo "==> cloudflared repo + package"
    install -d -m 755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
      | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
      > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq
    apt-get install -y -qq cloudflared
  fi

  echo "==> Install connector as a service (remote-managed config)"
  # Reinstall cleanly so re-running with a new token can't leave a stale unit.
  cloudflared service uninstall 2>/dev/null || true
  cloudflared service install "$TUNNEL_TOKEN"

  echo "==> Verify"
  sleep 3
  systemctl is-active cloudflared >/dev/null \
    && echo "    cloudflared: active" \
    || { journalctl -u cloudflared -n 30 --no-pager; exit 1; }
  echo -n "    local /health: "; curl -fsS --max-time 5 http://127.0.0.1:8080/health && echo
  echo
  echo "Next: in the Cloudflare dashboard (Zero Trust > Networks > Tunnels),"
  echo "add Public Hostname  fragzone-server.<domain>  ->  HTTP  localhost:8080"
  echo "(delete the old fragzone-server A record first; the tunnel makes its own"
  echo "proxied CNAME). Then verify the public host and run: $0 finalize"
  ;;

finalize)
  echo "==> Retire the direct-origin path"
  systemctl disable --now caddy 2>/dev/null || true   # no more :80/:443 or ACME

  # Close inbound web ports. ufw's own rules AND the raw iptables ACCEPTs that
  # setup.sh inserted above Oracle's REJECT must both go, or the port stays open.
  ufw delete allow 80/tcp  >/dev/null 2>&1 || true
  ufw delete allow 443/tcp >/dev/null 2>&1 || true
  for p in 80 443; do
    while iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null; do
      iptables -D INPUT -p tcp --dport "$p" -j ACCEPT
    done
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true

  echo "    inbound 80/443 closed; SSH (22) left as-is."
  echo "    Optional: remove the 80/443 ingress rules from the OCI security list too."
  echo "==> Done. Origin is now reachable only through the Cloudflare Tunnel."
  ;;

*)
  echo "usage: $0 [install|finalize]" >&2
  exit 1
  ;;
esac
