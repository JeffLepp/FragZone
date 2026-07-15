#!/usr/bin/env bash
# FragZone — Oracle Cloud (Ubuntu ARM64) VM bootstrap. Idempotent; safe to re-run.
#
#   sudo DOMAIN=example.com SITE_ORIGINS=https://example.com,https://www.example.com bash setup.sh
#
# Installs Node LTS + Caddy, creates the `fragzone` service account, deploys the
# server to /opt/fragzone, wires up systemd, and opens 80/443. Everything below
# is free-tier only: no load balancer, no managed anything, just this VM.
set -euo pipefail

REPO="${REPO:-https://github.com/JeffLepp/FragZone.git}"
BRANCH="${BRANCH:-master}"
APP_DIR=/opt/fragzone
# DOMAIN is optional: without it, everything but Caddy runs (server + systemd),
# so the box can be stood up before DNS exists. Re-run with DOMAIN set to add
# the TLS reverse proxy. Idempotent either way.
DOMAIN="${DOMAIN:-}"   # normalize to empty so `set -u` is happy when it's unset
SUB="${SUB:-fragzone-server}"                       # subdomain label (override per deployment)
HOSTNAME_FQDN="${DOMAIN:+${SUB}.${DOMAIN}}"
SITE_ORIGINS="${SITE_ORIGINS:-${DOMAIN:+https://${DOMAIN},https://www.${DOMAIN}}}"

[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  echo "invalid DOMAIN: $DOMAIN" >&2
  exit 1
fi
if [[ ! "$SUB" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; then
  echo "invalid SUB: $SUB" >&2
  exit 1
fi
if [[ "$SITE_ORIGINS" == *$'\n'* || "$SITE_ORIGINS" == *$'\r'* ]]; then
  echo "SITE_ORIGINS must be a comma-separated, single-line value" >&2
  exit 1
fi
if [[ -n "$SITE_ORIGINS" ]]; then
  IFS=',' read -r -a ORIGINS <<< "$SITE_ORIGINS"
  for origin in "${ORIGINS[@]}"; do
    if [[ ! "$origin" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]; then
      echo "invalid SITE_ORIGINS entry: $origin" >&2
      exit 1
    fi
  done
fi

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

NODE_MAJOR=0
command -v node >/dev/null && NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "==> Node.js LTS"
  ARCH="$(dpkg --print-architecture)"
  [[ "$ARCH" == "arm64" || "$ARCH" == "amd64" ]] || { echo "unsupported architecture: $ARCH" >&2; exit 1; }
  install -d -m 755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  chmod 644 /usr/share/keyrings/nodesource.gpg
  cat > /etc/apt/sources.list.d/nodesource.sources <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Architectures: $ARCH
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
  apt-get update -qq
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
chown -R root:root "$APP_DIR"

# Three sources, in priority order:
#   1. Code already copied in (rsync/scp) — used as-is. Lets a private repo be
#      deployed without giving the VM any git credentials.
#   2. Existing clone — fast-forward it.
#   3. Fresh clone (public repo only).
if [[ -f "$APP_DIR/server/package.json" && ! -d "$APP_DIR/.git" ]]; then
  echo "    using pre-copied code at $APP_DIR"
elif [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
  echo "    deployed $(git -C "$APP_DIR" log --oneline -1)"
else
  rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
  echo "    deployed $(git -C "$APP_DIR" log --oneline -1)"
fi
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

echo "==> Production dependencies (no build step: the server is plain CommonJS)"
npm ci --omit=dev --ignore-scripts --no-audit --prefix "$APP_DIR/server"

echo "==> Environment file"
# The generated runtime file is safe to replace on every deploy. Browser
# origins are explicit in production so another site cannot open game sockets.
printf 'ALLOWED_ORIGINS=%s\n' "$SITE_ORIGINS" > /etc/fragzone.runtime.env
chown root:root /etc/fragzone.runtime.env
chmod 600 /etc/fragzone.runtime.env

# The optional override file is preserved across deploys and is the only place
# future secrets should live.
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
  sed "s|{\$FQDN}|${HOSTNAME_FQDN}|" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
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
# Also restrict Oracle's VCN rule for port 22 to trusted administrator IPs; ufw
# keeps SSH open here so rerunning this script cannot lock out the operator.
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
