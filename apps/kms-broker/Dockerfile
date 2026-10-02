FROM node:24-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS build

WORKDIR /src

COPY . .

RUN corepack enable
RUN pnpm fetch
RUN pnpm install --offline --frozen-lockfile --filter @community-hub/kms-broker-app...
RUN pnpm --filter @community-hub/kms-broker-app... build
RUN pnpm --filter @community-hub/kms-broker-app deploy --legacy --prod /out

FROM node:24-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7

WORKDIR /app

COPY --from=build /out /app

USER node

CMD ["node", "dist/main.js"]
