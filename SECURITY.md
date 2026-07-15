# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Choose **Advisories** then **Report a vulnerability**.

Please do not disclose a suspected vulnerability in a public issue. Include the
affected endpoint or file, reproduction steps, impact, and any suggested fix.

## Supported version

Security fixes are applied to the latest revision of the active deployment
branch. Older revisions are not maintained.

## Deployment boundary

The game server is designed to run as the unprivileged `fragzone` user, bound
to loopback behind Caddy. Do not expose port 8080 publicly, commit environment
files, or disable the configured WebSocket origin and resource limits.
