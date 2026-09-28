# Build the server (tsc -> dist) and the dashboard (vite -> dist/web).
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build

# Production dependencies, resolved separately so the runtime image carries no
# toolchain. better-sqlite3 falls back to a source build when no prebuilt binary
# matches, hence the compilers here and not in the final stage.
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Same base image as `deps`, so the compiled better-sqlite3 binding matches this
# glibc and copying node_modules wholesale is safe.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8787
CMD ["node", "dist/cli.js", "serve"]
