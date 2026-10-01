FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS simulator-ui
WORKDIR /build
COPY simulator-ui/package*.json ./
RUN npm ci
COPY simulator-ui/ ./
RUN npm run build -- --base=/simulator/

FROM caddy:2-alpine
COPY --from=frontend /build/dist /srv/fleet
COPY --from=simulator-ui /build/dist /srv/simulator
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
ENTRYPOINT ["sh", "/usr/local/bin/web-entrypoint.sh"]
