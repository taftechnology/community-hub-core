FROM gcr.io/distroless/nodejs24-debian13@sha256:26f548b31653cec660bc838cf126b3d5eb028030d479f05672e0550b93a56b75 AS os

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.26.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @community-hub/kernel --filter @community-hub/observability --filter @community-hub/crypto --filter @community-hub/db --filter @community-hub/contracts --filter @community-hub/identity --filter @community-hub/policy --filter @community-hub/tenancy --filter @community-hub/usage --filter @community-hub/people --filter @community-hub/access --filter @community-hub/entitlements-eval --filter @community-hub/entitlements --filter @community-hub/billing build
RUN pnpm --filter @community-hub/ops build
RUN pnpm --filter @community-hub/api exec tsc -p tsconfig.emit.json
RUN pnpm --filter @community-hub/api deploy --prod --legacy /out
RUN mkdir -p /runtime/certs \
 && cp /out/package.json /runtime/package.json \
 && cp -a /out/node_modules /runtime/node_modules \
 && cp -a apps/api/dist/. /runtime/ \
 && cp apps/api/certs/rds-ap-southeast-2-bundle.pem /runtime/certs/rds-ap-southeast-2-bundle.pem \
 && cp -a apps/ops/dist /runtime/ops
COPY --from=os /etc/passwd /passwd
COPY --from=os /etc/group /group
RUN printf '%s\n' 'node:x:1000:1000::/app:/sbin/nologin' >> /passwd \
 && printf '%s\n' 'node:x:1000:' >> /group

FROM os AS withtmp
USER 0
RUN ["/nodejs/bin/node", "-e", "const fs=require('node:fs'); fs.chownSync('/tmp', 1000, 1000); fs.chmodSync('/tmp', 0o1777);"]

FROM withtmp
COPY --from=build /passwd /etc/passwd
COPY --from=build /group /etc/group
COPY --from=build --chown=node:node /runtime /app
ENV PATH="/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV OPS_STATIC_DIR=/app/ops
ENTRYPOINT []
USER node
WORKDIR /app
VOLUME ["/tmp"]
CMD ["node", "/app/index.js"]
HEALTHCHECK CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
