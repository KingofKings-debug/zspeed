#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker info >/dev/null
docker run --rm -e "SITE_ADDRESS=${SITE_ADDRESS:-}" -v "$PWD/docker:/setup" node:22-bookworm-slim node /setup/setup.mjs
docker compose --env-file docker/.env up -d --build --wait --wait-timeout 300
cat docker/credentials.txt
echo "Fleet: ${SITE_ADDRESS:-server IP}; simulator console: /simulator/"
