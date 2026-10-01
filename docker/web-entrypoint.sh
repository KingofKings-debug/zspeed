#!/bin/sh
set -eu
export SIMULATOR_PASSWORD_HASH="$(caddy hash-password --plaintext "$SIMULATOR_PASSWORD")"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
