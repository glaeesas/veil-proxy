FROM node:20-alpine

WORKDIR /app

# The image only runs the Wisp server and serves the static build; the site
# itself is plain files that GitHub Pages can host without this container.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY scripts ./scripts
COPY server.js ./
COPY public ./public
RUN npm run build

ENV NODE_ENV=production
# Render sets PORT itself (10000 by default); server.js honours it.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null || exit 1

CMD ["node", "server.js"]
