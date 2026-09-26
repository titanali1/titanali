FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    VEXON_DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node server.js index.html styles.css exchange.css extra.css backend-ui.css app.js manifest.webmanifest icon.svg sw.js vexon-logo.svg ./
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node
EXPOSE 8787
CMD ["node", "server.js"]
