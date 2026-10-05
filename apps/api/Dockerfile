FROM node:24-slim@sha256:24b8bc17702002d2ed0c1da9ad66c3ee507cc279d0856726662ff2b6fc35c149 AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.26.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @community-hub/kernel --filter @community-hub/observability --filter @community-hub/crypto --filter @community-hub/db build
RUN pnpm --filter @community-hub/api exec tsc -p tsconfig.emit.json
RUN pnpm --filter @community-hub/api deploy --prod --legacy /out
RUN cp -a apps/api/dist/. /out/ && cp -a apps/api/certs /out/certs

FROM node:24-slim@sha256:24b8bc17702002d2ed0c1da9ad66c3ee507cc279d0856726662ff2b6fc35c149
COPY --from=build --chown=node:node /out /app
RUN mkdir -p /tmp && chown node:node /tmp
VOLUME ["/tmp"]
USER node
WORKDIR /app
ENTRYPOINT ["node", "/app/index.js"]
HEALTHCHECK CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
