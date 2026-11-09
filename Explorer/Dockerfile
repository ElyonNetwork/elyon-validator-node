FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Install Caddy (admin-set custom domain + free Let's Encrypt SSL).
# Same install method the chain dashboard uses.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl gnupg ca-certificates debian-keyring debian-archive-keyring apt-transport-https libcap2-bin \
 && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends caddy \
 && setcap cap_net_bind_service=+ep /usr/bin/caddy 2>/dev/null || true \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080

# Persistent volume for Caddy ACME state.
VOLUME ["/data"]
# 8080 = Node listener; 80/443 = Caddy (when a domain is set).
EXPOSE 8080 80 443

CMD ["node", "src/server.js"]
