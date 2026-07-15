#!/usr/bin/env bash
# FragZone — Oracle Cloud (Ubuntu ARM64) VM bootstrap. Idempotent; safe to re-run.
#
#   sudo DOMAIN=example.com bash setup.sh
#
# Installs Node LTS + Caddy, creates the `fragzone` service account, deploys the
# server to /opt/fragzone, wires up systemd, and opens 80/443. Everything below
# is free-tier only: no load balancer, no managed anything, just this VM.
set -euo pipefail

REPO="${REPO:-https://github.com/JeffLepp/FragZone.git}"
BRANCH="${BRANCH:-oracle-migration}"
APP_DIR=/opt/fragzone
# DOMAIN is optional: without it, everything but Caddy runs (server + systemd),
# so the box can be stood up before DNS exists. Re-run with DOMAIN set to add
# the TLS reverse proxy. Idempotent either way.
HOSTNAME_FQDN="${DOMAIN:+fragzone-server.${DOMAIN}}"

[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  echo "==> Node.js LTS (arm64)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v) / npm $(npm -v) on $(dpkg --print-architecture)"

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "==> Service account + app directory"
id -u fragzone &>/dev/null || useradd --system --create-home --home-dir /home/fragzone --shell /usr/sbin/nologin fragzone
mkdir -p "$APP_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
echo "    deployed $(git -C "$APP_DIR" log --oneline -1)"
chown -R fragzone:fragzone "$APP_DIR"

echo "==> Production dependencies (no build step: the server is plain CommonJS)"
sudo -u fragzone npm ci --omit=dev --prefix "$APP_DIR/server"

echo "==> Environment file"
# The app requires no secrets today; HOST/PORT are pinned in the unit. The file
# exists so systemd's EnvironmentFile= resolves and secrets have a home later.
[[ -f /etc/fragzone.env ]] || printf '# FragZone production env. Secrets go here — never in git or the unit file.\n' > /etc/fragzone.env
chown root:root /etc/fragzone.env
chmod 600 /etc/fragzone.env

echo "==> systemd"
install -m 644 "$APP_DIR/deploy/fragzone.service" /etc/systemd/system/fragzone.service
systemctl daemon-reload
systemctl enable --now fragzone
systemctl restart fragzone

if [[ -n "$DOMAIN" ]]; then
  echo "==> Caddy (DOMAIN=$DOMAIN)"
  install -d -m 755 /etc/caddy
  sed "s/{\$DOMAIN}/${DOMAIN}/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl enable caddy
  systemctl reload caddy || systemctl restart caddy
else
  echo "==> Caddy: skipped (no DOMAIN yet — re-run with DOMAIN=... to enable TLS)"
  systemctl stop caddy 2>/dev/null || true   # don't let default Caddy squat on :80/:443
  systemctl disable caddy 2>/dev/null || true
fi

echo "==> Firewall"
# ufw: only SSH + HTTP(S). 8080 is never opened — the app binds 127.0.0.1 anyway.
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# Oracle's Ubuntu image ships an iptables INPUT chain that REJECTs everything
# except 22 — it sits *below* ufw's chain and silently drops 80/443 even after
# the VCN security list is opened. This is the single most common reason a
# fresh Oracle VM looks dead on port 443. Insert ACCEPTs above the REJECT.
if iptables -C INPUT -j REJECT --reject-with icmp-host-prohibited 2>/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

echo
echo "==> Verify"
sleep 2
systemctl is-active fragzone >/dev/null && echo "    fragzone: active" || { journalctl -u fragzone -n 30 --no-pager; exit 1; }
[[ -n "$DOMAIN" ]] && { systemctl is-active caddy >/dev/null && echo "    caddy:    active"; }
echo -n "    local /health: "; curl -fsS --max-time 5 http://127.0.0.1:8080/health && echo

if [[ -n "$HOSTNAME_FQDN" ]]; then
  echo
  echo "Done. Public check (after DNS resolves to this box):"
  echo "  curl https://${HOSTNAME_FQDN}/health"
else
  echo
  echo "Server up. Re-run with DOMAIN=<your-domain> to add Caddy + TLS."
fi
