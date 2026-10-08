# syntax=docker/dockerfile:1
# Aero Search — API image (also serves the built frontend when present).
#
# build  : npm ci (dev deps for tsc) -> tsc + vite build
# runtime: prod deps only + dist/ + web/dist + data (indexes, corpora, eval)
#          + runs/ and benchmarks/ so /api/benchmarks serves the committed
#          experiment artifacts. data/pg (embedded dev PostgreSQL) is NOT
#          shipped; the container uses the compose postgres via DATABASE_URL.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci
COPY tsconfig.json ./
COPY src src
COPY scripts scripts
COPY benchmarks benchmarks
COPY web web
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY data/index ./data/index
COPY data/corpora ./data/corpora
COPY data/eval ./data/eval
COPY runs ./runs
COPY benchmarks ./benchmarks
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/api/server.js"]
