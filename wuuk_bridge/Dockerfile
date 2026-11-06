FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm test && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime
ARG BUILD_VERSION=dev
LABEL io.hass.type="app" io.hass.version="${BUILD_VERSION}"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["node", "dist/addon.js"]

FROM runtime AS runtime-amd64
LABEL io.hass.arch="amd64"

FROM runtime AS runtime-arm64
LABEL io.hass.arch="aarch64"

FROM runtime-${TARGETARCH}
