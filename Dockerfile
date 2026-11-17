FROM node:20-alpine

WORKDIR /app

# The image only runs the Wisp server and serves the static build; the site
# itself is plain files that GitHub Pages can host without this container.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY scripts ./scripts
COPY server.js ./
COPY public ./public
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null || exit 1

CMD ["node", "server.js"]
