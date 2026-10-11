# Spec: Service image runtime base

Slug: service-image-runtime-base
Status: draft
Architecture refs: §7.3, §23.2, ADR 0009. The final stage named in `docs/specs/2026-10-05-regional-service.md` changes. That spec stays. Depends on `image-publish`, which is on `main`. Staging stays parked.

## Problem

The publish job on `main` fails its scan gate. Run [38098338863](https://github.com/taftechnology/community-hub-core/actions/runs/38098338863) reported `CRITICAL` 2. The gate fails when `CRITICAL` is greater than 0. The owner identified two critical findings and three high findings in `gnutls28`, in the Debian base of the service image. Debian lists that library as unfixed in every release, so a rebuild or a newer Debian base does not clear them.

The final stage is `node:24-slim`, which has a package manager. `apt-get upgrade` cannot remove a library the base still installs.

## Scope

**In**

- The OS files in the final image come from `gcr.io/distroless/nodejs24-debian13` pinned by the `linux/arm64` manifest digest `sha256:26f548b31653cec660bc838cf126b3d5eb028030d479f05672e0550b93a56b75`. A tag-only `FROM` fails review. The `:debug` and `:debug-nonroot` tags are not used. `gcr.io/distroless/nodejs24-debian12` still resolves. This chunk does not use it.
- The build stage stays `node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`. Corepack and pnpm run there. That stage is not the pushed image.
- `apps/api/src/image.test.ts` drops the `perl-base` and apt-list assertion, which runs `sh` and `dpkg`. It asserts an empty entrypoint, user `node`, the exact package set below, and the `/tmp` owner, mode, and write.
- The pull request body reports the package list of the built final stage, and the critical and high counts from one local scan.

**Out**

- Any change to `.github/workflows/ci.yml`, the publish job, or `tooling/checks/image-publish`. The scan gate is not changed.
- Any apply. `service_image` stays unset. Staging stays parked.
- A new registry account, a new billed resource, a NAT gateway, a load balancer, or an interface endpoint.
- An email vendor, an identity library, or a change to `identity-otp`.
- Editing `architecture.md` or an ADR. The runtime base is not an architecture decision.

Why this image: it is Node 24, the same major the service already runs. It has no package manager and no shell, so `apt` cannot pull `libgnutls28` back in. Its `linux/arm64` package directory, read on 2026-10-10, is the 14 names under Behaviour. The binary is `/nodejs/bin/node`, version v24.21.0. `SSL_CERT_FILE` points at the CA bundle the base already ships.

## Behaviour

An intermediate stage starts `FROM` the pinned digest, as user `0`. It has one exec-form `RUN` of `/nodejs/bin/node`. That process sets `/tmp` to uid 1000, gid 1000, and mode `1777`. It does not invoke a shell. The final stage starts `FROM` that intermediate stage and has no `RUN`. It does not run `apt-get`.

The final stage copies `/etc/passwd` and `/etc/group` from the distroless base into the build stage, appends one user and one group, and copies those files back:

```
node:x:1000:1000::/app:/sbin/nologin
node:x:1000:
```

The existing `root`, `nobody`, and `nonroot` lines stay. `USER node` is set after that copy. `COPY --chown=node:node` still places `/app` as that user. Uid 1000 is `node`.

`/tmp` in the final image is owner uid 1000, group gid 1000, mode `1777`. That is the same owner and mode the current image gets from `mkdir -p /tmp && chown node:node /tmp` on `node:24-slim`, where `/tmp` is already mode `1777`. `docs/specs/2026-10-05-regional-service.md` requires `/tmp` owned by `node` and `VOLUME ["/tmp"]`. On Fargate the mounted volume takes its owner and mode from that directory. `VOLUME ["/tmp"]` stays. The service task and the ops task keep their existing `/tmp` mounts.

`ENV PATH` starts with `/nodejs/bin` and keeps the base path. `SSL_CERT_FILE` stays the base value. No contract variable and no secret is baked in.

`ENTRYPOINT` is empty. `CMD` stays `["node", "/app/index.js"]`. `HEALTHCHECK` stays exec form and starts with `node`. It does not call a shell.

The package names in `/var/lib/dpkg/status.d`, ignoring `*.md5sums`, are exactly these 14:

`base-files`, `ca-certificates`, `gcc-14-base`, `libc6`, `libgcc-s1`, `libgomp1`, `libssl3t64`, `libstdc++6`, `libzstd1`, `media-types`, `netbase`, `tzdata`, `tzdata-legacy`, `zlib1g`.

A different set fails the image test. That includes a base digest bump that adds or drops a name.

### What the running task uses

| Need       | Today                                                                                                                                                                                                       | After this chunk                                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell      | The base entrypoint is `docker-entrypoint.sh`. The image test also runs `sh` for `dpkg`. ECS Exec is off. The task command is not a shell.                                                                  | No shell in the final stage. `docker-entrypoint.sh` is gone. The `sh` assertion is gone. ECS Exec stays off.                                                                                                                                     |
| Binaries   | `node` on `PATH`, from the slim image. The test also requires `perl-base` and `dpkg`.                                                                                                                       | `node` on `PATH`, from `/nodejs/bin/node`. `perl-base`, `dpkg`, and `apt` are absent.                                                                                                                                                            |
| User       | Image user `node`. The service container and the ops container set `user = "node"`.                                                                                                                         | Image user `node`, uid 1000. Both task definitions stay `user = "node"`.                                                                                                                                                                         |
| Entrypoint | Inherited `["docker-entrypoint.sh"]`, then `CMD ["node", "/app/index.js"]`. An ECS command override replaces `CMD` only. The script execs that command, so `["node", "/app/db-bootstrap.js"]` reaches Node. | Empty entrypoint. `CMD` stays `["node", "/app/index.js"]`. The same override is the process. The ops command stays `["node", "/app/db-bootstrap.js"]`. The runbook sentence does not change. No `entryPoint` is added to either task definition. |
| `/tmp`     | The image creates `/tmp` owned by `node`, mode `1777`, and declares the volume.                                                                                                                             | Same owner, same mode, same volume. The final stage does not `RUN`. The intermediate stage sets them, as above.                                                                                                                                  |

`docker run` of `node /app/probe.js` still returns exit 1, stdout `fail`, and stderr `env`. `docker exec` of `node` still runs the health check inside the container. SIGTERM still reaches Node as process 1.

The image test keeps the container that is started `--read-only` with `--tmpfs /tmp`. It adds a container started as user `node`, with no `--tmpfs` and no `--read-only`. That container writes a file under `/tmp` and exits 0. The test also reads the owner and mode of `/tmp` and expects uid 1000, gid 1000, and mode `1777`.

## Data

No table and no column. No personal data is added to the image. The RDS CA file stays `/app/certs/rds-ap-southeast-2-bundle.pem`.

## Rules touched

Residency: this is the image that runs the personal-data service in `ap-southeast-2`. The image still bakes no personal data, no connection string, and no secret. The scan gate is unchanged: `COMPLETE` and `CRITICAL` absent or 0. High findings do not fail that gate. Removing `gnutls28` is what removes the two critical findings.

## Contracts

No route, event, permission, or website key. The service still listens on 8080. The ops task command stays `["node", "/app/db-bootstrap.js"]`.

## Proof

A pull request builds the image and does not push it. The image test reads `/var/lib/dpkg/status.d` with `node` and expects exactly the 14 package names above. The pull request body lists those names for the built final stage.

The pull request body also includes the critical count and the high count from one local scan of that built image. It names the tool and the tool version. That scan is evidence. It is not a CI step, and it is not a change to the publish job.

The registry scan result exists only after merge, on the publish job on `main`. The owner's assistant checks that run: scan status `COMPLETE`, `CRITICAL` 0, and the finding list. If that check fails, the chunk is reverted by pull request. The gate is not changed to make the run pass.

## Risks

| Risk                                                                            | Mitigation                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The task starts as root                                                         | `USER node` is set. The image test expects user `node`.                                                                                                                      |
| The ops command looks up `node` and does not find it                            | `PATH` includes `/nodejs/bin`. The image test runs `node /app/probe.js` and `node /app/db-bootstrap.js` exists.                                                              |
| A command override is swallowed by the distroless entrypoint `/nodejs/bin/node` | The entrypoint is cleared. The image test expects an empty entrypoint.                                                                                                       |
| `/tmp` is not writable by `node`                                                | The image test writes a file under `/tmp` as user `node` with no `--tmpfs` and no `--read-only`, and it checks uid 1000, gid 1000, and mode `1777`.                          |
| This image has not run on Fargate                                               | The next chunk that unparks staging re-runs the health check, the `/tmp` write one-off, and the ops task before the service is relied on.                                    |
| The pinned digest is not the arm64 manifest                                     | The digest above is the `linux/arm64` manifest inspected on 2026-10-10. The plan re-inspects it before the Dockerfile change and stops if the platform is not `linux/arm64`. |
| A later base digest changes the package set                                     | The image test fails unless `/var/lib/dpkg/status.d` is exactly the 14 names.                                                                                                |

## Cost

No new resource billed by the hour or the month. No NAT gateway, load balancer, or interface endpoint. Staging stays parked.

## Out-of-band

- Legal: none. New subprocessor: none. No ADR. `architecture.md` is not edited.
- The owner has decided the second fresh-context review is not required for this chunk.
- The human does not apply. The agent does not apply.

## Rollback

Restore the final stage to `node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` and restore the `apt-get upgrade` line. No migration. A running task keeps its already-pulled digest until a person publishes and applies a different one. This chunk does not apply.

If the publish scan on `main` is not `COMPLETE` with `CRITICAL` 0, revert this chunk by pull request. Do not change the gate.

## Catalogue

The last commit on the branch adds a Phase 0 row `service-image-runtime-base`, marked done, with a link to this spec. Phase 0 becomes 24 rows: 23 done, 1 superseded (`api-au-hostname`), 0 not started. The snapshot's next chunk stays `identity-otp`. `AGENTS.md` repository state gets the same counts and the same next chunk.

That commit adds this sentence to the open items in `docs/roadmap.md`: this image has not run on Fargate. The next chunk that unparks staging re-runs the health check, the `/tmp` write one-off, and the ops task before the service is relied on.
