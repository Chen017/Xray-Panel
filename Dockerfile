FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production PANEL_HOST=0.0.0.0 PANEL_DB=/app/data/panel.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node docs ./docs
COPY --chown=node:node README.md package.json ./
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3000 3001 3002
CMD ["node", "server/index.mjs"]
