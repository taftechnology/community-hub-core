Spec: docs/specs/2026-10-10-service-image-runtime-base.md

# Service image runtime base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the service image's final stage off `node:24-slim` so the runtime has no package manager and the package set is the 14 names in the spec.

**Architecture:** Two commits. The first replaces the image test assertions and the Dockerfile. The second updates the catalogue. No apply. The publish job and the scan gate stay as they are.

**Tech Stack:** The existing Dockerfile, Node 24, Docker BuildKit, Vitest. No new package.

Status: approved (2026-10-10, Abdus)

**Branch:** `fix/2026-10-10-service-image-runtime-base` · one PR · 2 tasks, one commit each

## Global Constraints

- Do not start Task 1 until this plan's Status line is `approved`. Do not mark this plan approved yourself.
- Do not edit `.github/workflows/ci.yml`, `tooling/checks/image-publish/`, `infra/`, or `docs/runbooks/`. The scan gate is not changed.
- Do not apply. Do not set `service_image`. Do not change `enable_database` or `desired_count`. Staging stays parked.
- Do not edit `architecture.md`. No ADR.
- The second fresh-context review is not required. The owner decided that. Do not open that line.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Every task runs `pnpm gate` before its commit. Format the files in that commit first: `pnpm exec prettier --write` on those paths.
- Task 1 also runs the image test with `RUN_IMAGE_TESTS=1` and Docker up. If Docker is missing, stop and report. Do not skip the image test.
- The pull request opens only after Task 2, from this `fix/` branch. It merges with a merge commit. The agent does not merge and does not apply.

**Rollback:** Restore the final stage to `node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` and restore the `apt-get upgrade` line. No migration. If the publish scan on `main` is not `COMPLETE` with `CRITICAL` 0, revert this chunk by pull request. Do not change the gate.

**Cost:** No new hourly or monthly resource. Staging stays parked.

## File map

| File                         | Responsibility                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `apps/api/Dockerfile`        | Four stages. The build stage edits passwd and group. `withtmp` sets `/tmp`.      |
| `apps/api/src/image.test.ts` | Drops the perl and apt assertions. Pins the package set, entrypoint, and `/tmp`. |
| `docs/roadmap.md`            | Phase 0 row, counts, and the Fargate sentence in open items.                     |
| `AGENTS.md`                  | The repository-state sentence only. The Phase 0 counts.                          |

## Security pins

These are the settings named in the spec. During Task 1, after the image test is green, change the source once, see that test fail, restore the source, and report the failure. The report is session scratch. The weakened tree is never committed. Run the pins one at a time. Restore before the next pin.

| Setting                                   | Test                                           | Source change that must fail it                                                                      |
| ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Runtime user is `node`                    | `expect(config?.User).toBe("node")`            | Delete the final stage's `USER node` line                                                            |
| Entrypoint is empty                       | `expect(config?.Entrypoint ?? []).toEqual([])` | Delete the final stage's `ENTRYPOINT []` line, so the distroless entrypoint `/nodejs/bin/node` stays |
| `/tmp` is uid 1000, gid 1000, mode `1777` | The new `/tmp` stat assertion                  | Delete the `withtmp` `RUN` line                                                                      |
| `node` is on `PATH`                       | the image test                                 | Change `ENV PATH` so it does not start with `/nodejs/bin`                                            |
| Package set is the 14 names               | The package-directory assertion                | Remove `zlib1g` from the expected array in `apps/api/src/image.test.ts`                              |

## Dockerfile

Four stages, in this order. The digest check in Task 1 step 1 runs before this file is edited.

`os` is the pinned distroless image. It has no instructions. `build` is the only stage that edits `/etc/passwd` and `/etc/group`: it copies them from `os` and appends the `node` lines. `withtmp` is the only stage that sets `/tmp`: it starts from `os` and runs Node once. The final stage starts from `withtmp`, has no `RUN`, and copies the edited passwd and group from `build`.

```dockerfile
FROM gcr.io/distroless/nodejs24-debian13@sha256:26f548b31653cec660bc838cf126b3d5eb028030d479f05672e0550b93a56b75 AS os

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.26.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @community-hub/kernel --filter @community-hub/observability --filter @community-hub/crypto --filter @community-hub/db build
RUN pnpm --filter @community-hub/api exec tsc -p tsconfig.emit.json
RUN pnpm --filter @community-hub/api deploy --prod --legacy /out
RUN mkdir -p /runtime/certs \
 && cp /out/package.json /runtime/package.json \
 && cp -a /out/node_modules /runtime/node_modules \
 && cp -a apps/api/dist/. /runtime/ \
 && cp apps/api/certs/rds-ap-southeast-2-bundle.pem /runtime/certs/rds-ap-southeast-2-bundle.pem
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
ENTRYPOINT []
USER node
WORKDIR /app
VOLUME ["/tmp"]
CMD ["node", "/app/index.js"]
HEALTHCHECK CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

`SSL_CERT_FILE` is not set again. It stays the value from `os`. No contract variable and no secret is added.

---

### Task 1: Runtime image and image test

**Files:**

- Modify: `apps/api/src/image.test.ts`
- Modify: `apps/api/Dockerfile`

**Interfaces:**

- Consumes: the current image test and the current Dockerfile.
- Produces: a final image whose user is `node`, whose entrypoint is empty, whose `/tmp` is uid 1000 gid 1000 mode `1777`, and whose package names are the 14 below.

- [ ] **Step 1: Re-inspect the pinned digest**

Run:

```bash
docker buildx imagetools inspect gcr.io/distroless/nodejs24-debian13@sha256:26f548b31653cec660bc838cf126b3d5eb028030d479f05672e0550b93a56b75
```

Stop if that manifest's platform is not `linux/arm64`. Do not edit the Dockerfile with a different digest. This digest is a single-platform manifest, not the multi-arch index.

- [ ] **Step 2: Write the failing image test**

Edit `apps/api/src/image.test.ts` only. Do not edit the Dockerfile in this step.

Remove the test named `ships perl-base at least 5.36.0-7+deb12u4 and an empty apt list`. These assertions go with it:

- `docker run` of `sh -c` with `dpkg --compare-versions` for `perl-base` `ge 5.36.0-7+deb12u4` expects status 0.
- `readdirSync("/var/lib/apt/lists")` expects length 0.

In the test named `matches the ingress contract and drains an unfinished header on SIGTERM`, change one assertion and leave the rest:

- Remove `expect(config?.Entrypoint).toEqual(["docker-entrypoint.sh"])`.
- Add `expect(config?.Entrypoint ?? []).toEqual([])`.

Leave these assertions in that test as they are:

- `config.User` is `"node"`.
- `config.Cmd` is `["node", "/app/index.js"]`.
- `config.Volumes` has `/tmp`.
- Healthcheck `Test[0]` is `"CMD"`, `Test[1]` is `"node"`, and the joined test contains neither `sh` nor `bash`.
- `/app` has no `.ts` source, no `.turbo`, no `Dockerfile`, no tsconfig, no vitest config, and no `/dist` directory.
- The only `.pem` under `/app` is `/certs/rds-ap-southeast-2-bundle.pem`.
- Workspace packages have no `.ts` except `.d.ts`, no `.test.` files, no tsconfig, no vitest config, no `test` directories, and they do contain `sql/bootstrap.sql`.
- Image env names do not include `PGHOST`, `PGPASSWORD_APP`, `ENVELOPE_KEY_ARN`, `API_HOSTNAME`, `TURNSTILE_SECRET`, or `NODE_ENV`.
- The container from `startContainer` is still `--read-only`, `--tmpfs /tmp`, and `--user node`. It still becomes healthy, returns `200` and `{"ok":true}`, answers `TRACE` with an empty body, and stays healthy after that.
- `docker exec` of the health `node -e` still exits 0.
- `KEEP_ALIVE_TIMEOUT_MS` is 65000 and `HEADERS_TIMEOUT_MS` is 30000.
- An idle container exits 0 within 10 seconds of `SIGTERM`.
- A container with an unfinished request header exits 0 between 20 and 30 seconds after `SIGTERM`.
- `docker run` of `node /app/probe.js` still exits 1, with stdout `fail\n` and stderr `env\n`.
- `/app/db-bootstrap.js` and `/app/node_modules/@community-hub/db/sql/bootstrap.sql` still exist.

Add two tests. Neither uses `sh`.

Package set. `docker run` of `node` reads `/var/lib/dpkg/status.d`, drops every name that ends with `.md5sums`, sorts the rest, and expects exactly:

`base-files`, `ca-certificates`, `gcc-14-base`, `libc6`, `libgcc-s1`, `libgomp1`, `libssl3t64`, `libstdc++6`, `libzstd1`, `media-types`, `netbase`, `tzdata`, `tzdata-legacy`, `zlib1g`.

`/tmp` write and stat. `docker run --rm --user node` with no `--tmpfs` and no `--read-only` runs `node` to write a file under `/tmp` and exits 0. A second `docker run --rm --user node` runs `node` to stat `/tmp` and prints JSON. The test expects `uid` 1000, `gid` 1000, and `mode & 0o7777` equal to `0o1777`.

- [ ] **Step 3: Run the image test and see it fail**

```bash
docker image rm -f community-hub-api:local
RUN_IMAGE_TESTS=1 pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts
```

Expected: FAIL. The current image still has entrypoint `docker-entrypoint.sh` and a different package directory. Do not commit.

- [ ] **Step 4: Write the Dockerfile**

Replace `apps/api/Dockerfile` with the Dockerfile in this plan. No other file.

- [ ] **Step 5: Run the image test and see it pass**

```bash
docker image rm -f community-hub-api:local
RUN_IMAGE_TESTS=1 pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts
```

Expected: the image tests pass. Report the last lines.

- [ ] **Step 6: Run the five security pins**

For each row in the security-pins table, make that source change, run the image test from Step 5, see the named assertion fail, and restore the file with `git checkout --` on that path. Do not commit a weakened tree. After the fifth restore, run the image test once more and see it pass.

- [ ] **Step 7: One local scan**

This is evidence for the pull request body. It is not a CI step. Do not add a package, a workflow, or a file.

If `trivy` is on `PATH`, run `trivy --version` and `trivy image --scanners vuln community-hub-api:local`. Otherwise run `docker scout version` and `docker scout cves community-hub-api:local`. If neither exists, stop and report. Record the tool name, the version, the critical count, and the high count in the task report. Also record the 14 package names the image test printed.

- [ ] **Step 8: Gate, then commit**

```bash
pnpm exec prettier --write apps/api/src/image.test.ts
pnpm gate
```

Report the last lines of `pnpm gate`. Commit only `apps/api/src/image.test.ts` and `apps/api/Dockerfile`.

```bash
git add apps/api/src/image.test.ts apps/api/Dockerfile
git commit -m "$(cat <<'EOF'
fix(api): drop the package manager from the service image

The final stage is the pinned distroless Node 24 root. /tmp stays
uid 1000, gid 1000, mode 1777, and the package set is the 14 names.

Refs: docs/plans/2026-10-10-service-image-runtime-base.md task 1
EOF
)"
```

---

### Task 2: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: the approved spec's catalogue paragraph.
- Produces: Phase 0 counts `24 rows: 23 done, 1 superseded`, last shipped `service-image-runtime-base`, next chunk still `identity-otp`, and the Fargate sentence in open items.

- [ ] **Step 1: Update the roadmap**

In the snapshot table, change the Phase 0 cell from 23 rows and 22 done to 24 rows and 23 done. The superseded name stays `api-au-hostname`. The not-started count stays 0. Set `Last shipped` to `service-image-runtime-base`. Leave `Next chunk` as `identity-otp`.

After the `kms-mrk-replica` row, add a done row `service-image-runtime-base`. The what cell is: The service image final stage has no package manager. `gnutls28` is not in the runtime. Spec `docs/specs/2026-10-10-service-image-runtime-base.md`.

Leave the sentence under the Phase 0 table that says next is identity-otp.

At the end of `## Open items`, add this paragraph and do not edit the paragraphs above it:

This image has not run on Fargate. The next chunk that unparks staging re-runs the health check, the `/tmp` write one-off, and the ops task before the service is relied on.

- [ ] **Step 2: Update the repository-state sentence**

In `AGENTS.md`, in the repository-state cell only, change Phase 0 from 23 rows and 22 done to 24 rows and 23 done. The superseded name stays `api-au-hostname`. The not-started count stays 0. Leave the words that say next is identity-otp. Do not change any other sentence in that cell.

- [ ] **Step 3: Gate, then commit**

```bash
pnpm exec prettier --write docs/roadmap.md AGENTS.md
pnpm gate
```

Report the last lines of `pnpm gate`. Commit only those two files.

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark service-image-runtime-base done

Phase 0 counts include the runtime image. The next chunk stays
identity-otp. The Fargate re-check is an open item.

Refs: docs/plans/2026-10-10-service-image-runtime-base.md task 2
EOF
)"
```

---

## After the last task

Open the pull request from `fix/2026-10-10-service-image-runtime-base`. Do not open it before Task 2 is committed. The body uses `.github/PULL_REQUEST_TEMPLATE.md` and includes:

- `Spec: docs/specs/2026-10-10-service-image-runtime-base.md` and `Plan: docs/plans/2026-10-10-service-image-runtime-base.md`, both `approved`.
- The 14 package names from the built final stage.
- The tool name, the tool version, the critical count, and the high count from the Task 1 local scan.
- Second fresh-context review: not required. The owner decided that for this chunk.
- No apply. Staging stays parked.

The pull request merges with a merge commit. The agent does not merge.

After merge, the owner's assistant checks the publish job on `main`: scan status `COMPLETE`, `CRITICAL` 0, and the finding list. If that check fails, revert this chunk by pull request. Do not change the gate.
