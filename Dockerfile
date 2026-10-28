# syntax=docker/dockerfile:1.7
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

# Runtime: minimal, non-root, read-only-fs friendly, no shell tooling beyond busybox.
FROM node:26-alpine AS runtime
ENV NODE_ENV=production NODE_OPTIONS="--enable-source-maps --max-old-space-size=384"
WORKDIR /app
RUN apk add --no-cache tini && addgroup -S app -g 10001 && adduser -S app -u 10001 -G app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app package.json ./
USER 10001:10001
EXPOSE 3000 9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/main.js"]
