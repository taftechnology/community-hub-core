# Spec: Database ops task

Slug: db-ops-task
Status: approved (2026-10-06, Abdus)
Architecture refs: §7.3, ADR 0009. Sits before `first-running-task`. That spec is revised to call this task. It is not edited here.

## Problem

`apps/api/Dockerfile` sets `ENTRYPOINT ["node", "/app/index.js"]`. An ECS `RunTask` can override `command` and cannot override `entryPoint`, so `command ["node", "/app/probe.js"]` becomes `node /app/index.js node /app/probe.js`. The server starts and does not exit. `docker run --entrypoint` hides this. ECS has no equivalent.

The database accepts TCP 5432 only from the task security group. It is not publicly accessible. There is no NAT gateway, no bastion, and ECS Exec is off. A person cannot run `packages/db/sql/bootstrap.sql` or `ALTER ROLE` as the master. The runbook does not name a path that works.

## Scope

**In**

- Replace the image `ENTRYPOINT` with `CMD ["node", "/app/index.js"]`. The default container command is still the server.
- An image test runs `docker run <image> node /app/probe.js` with no `--entrypoint`. The probe gets the expected environment failure. That proves a command override reaches the probe.
- `node /app/db-bootstrap.js` in the same image. It runs `packages/db/sql/bootstrap.sql`, then `ALTER ROLE` for `app`, `identity`, and `platform`. Each statement carries a SCRAM-SHA-256 verifier computed in the program, not the cleartext password. It then prints `SHOW max_connections` as the only stdout line.
- A separate ops task definition. It exists only when `service_image` is set and the database is on. Its execution role is the only new principal that may read the RDS-managed master secret and the three role secrets. The service task definition gains nothing.
- `docs/runbooks/apply-staging-au.md`, section "Change a database role", names this ops task as the way to run bootstrap and `ALTER ROLE`.

**Out**

- Any apply. This chunk does not run the task and does not change a live secret.
- `first-running-task`. It runs the task after this chunk is on `main`.
- A path from a laptop to port 5432. No bastion, no public database, no NAT, no ECS Exec.
- New permissions on the service execution role, the service task role, or the service task definition.
- The envelope key, the storage key, or KMS data-key calls.
- A product journal or a tenant query.
- `image-publish`, `kms-mrk-replica`, and production.

## Behaviour

### Image command

The runtime stage has `CMD ["node", "/app/index.js"]` and no `ENTRYPOINT`. `HEALTHCHECK` stays the loopback health command.

`docker run <image>` with no command still starts the server. `docker run <image> node /app/probe.js` does not pass `--entrypoint`. With no contract environment the probe exits 1, stdout is `fail\n`, and stderr is `env\n`. The same invocation with `--entrypoint` is not this proof.

### Bootstrap program

`/app/db-bootstrap.js` is the compiled program. The image contains `packages/db/sql/bootstrap.sql`.

It reads four passwords from the environment. ECS injects them. The program does not take them as arguments. The master value is the `password` field of the RDS-managed master secret. The other three are the raw role-secret strings. The program does not read a secret ARN and does not call Secrets Manager.

It connects as the master through `createDirectSql` from `@community-hub/db`, with the image's RDS CA bundle, the same way the probe connects. That factory is verify-full. `rds.force_ssl` is 1.

On success it runs the bootstrap script. For each of `app`, `identity`, and `platform` it computes a SCRAM-SHA-256 verifier client-side and runs `ALTER ROLE <role> PASSWORD '<verifier>'`. The verifier is a properly quoted literal. No statement contains a cleartext password. It then runs `SHOW max_connections` and exits 0. Stdout is that integer and one newline. Stderr is empty. A second run does the same. The roles are not created twice, and the stored verifiers match the current secrets.

On failure stdout is empty, stderr is one of `env`, `bootstrap`, `alter_role`, or `max_connections`, plus one newline, and the exit code is 1. A driver error, a stack, a connection string, a secret ARN, and a password are not written. Passwords are not retained, logged, or passed to anything but the verifier computation. The master password is the exception: it is passed only to `createDirectSql`.

### Ops task definition

One task definition, family distinct from the service. It is planned only when `service_image` is set and `enable_database` is true. Image null plans none. Database off plans none.

The container command is `["node", "/app/db-bootstrap.js"]`. The image is `service_image`. CPU 256, memory 512, `linux/arm64`, user `node`, read-only root, writable `/tmp`, no port, no Cloud Map registry, ECS Exec off.

Environment is the host, port, database name, and master user. Those are not secrets. The four passwords are `secrets` entries, not environment values. No secret ARN is placed in the environment.

The task role has no policies. The program makes no AWS call.

The execution role may `GetSecretValue` on the master secret and the three role secrets, `kms:Decrypt` on the role-secrets key only, pull the service image, and write to the service log group under stream prefix `db-ops`. The RDS-managed master secret uses the AWS-managed `aws/secretsmanager` key. No `master_user_secret_kms_key_id` is set, so that secret needs no IAM `kms:Decrypt`. The decrypt list is exactly the role-secrets key. It cannot decrypt the storage key or the envelope key. It cannot read any other secret.

Image pull matches the service execution role (`infra/modules/aws-ingress/main.tf`). `ecr:GetAuthorizationToken` is on `*`. `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, and `ecr:BatchGetImage` are on the one service repository only.

The service task definition, its execution role, and its task role are unchanged. The service execution role does not gain the master secret. The RDS module gains an output for the master secret ARN so the ops role can name it. That output is not a task environment variable.

Network, when a later chunk runs the task: the task security group, a public subnet, and a public address. That is the only existing path to port 5432 and to pull the image. This chunk does not run it.

### Runbook

"Change a database role" says an operator runs this ops task. A person does not open a master session. The database must be on and `service_image` set, because otherwise the task definition does not exist. The task uses the task security group, the staging public subnet, and a public address. Stdout is only the integer from `SHOW max_connections`. The procedure records neither that integer's surrounding text nor a password, a connection string, or a secret ARN. There is no rotation function. The same task is how a later password change is applied.

## Data

No new table and no new column. Bootstrap creates the four roles and the empty schemas if they are missing. `ALTER ROLE` stores a SCRAM-SHA-256 verifier. `SHOW max_connections` reads a server setting. None of these is personal data.

## Rules touched

Residency. The task definition is for `ap-southeast-2`. The secrets and the database stay there. This chunk does not start the task.

Children. No new public path.

Tenancy. No query of an `app` row.

Encryption. The three role secrets stay on their existing key. The master secret stays on the AWS-managed `aws/secretsmanager` key. The ops role's `kms:Decrypt` list is exactly the role-secrets key.

Secrets. Passwords are not retained, logged, or written. A role password is passed only to the verifier computation. The master password is passed only to `createDirectSql`. They are not in the image, the repo, stdout, stderr, the SQL text, or the runbook. The service task does not receive the master password.

Rule 5. The log stream receives the program's stdout and stderr, which are the integer or one failure word.

## Contracts

| Contract            | Value                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image command       | `CMD ["node", "/app/index.js"]`. No `ENTRYPOINT`.                                                                                                                                      |
| Probe override      | `docker run <image> node /app/probe.js` with no `--entrypoint` reaches the probe.                                                                                                      |
| `db-bootstrap.js`   | Bootstrap, then three `ALTER ROLE`s with a client-side SCRAM-SHA-256 verifier, then `SHOW max_connections` as the only stdout line.                                                    |
| Ops task definition | Present only when `service_image` is set and the database is on.                                                                                                                       |
| Ops execution role  | Master secret plus the three role secrets. `kms:Decrypt` is exactly the role-secrets key. Image pull matches the service role, on the one repository. No storage key. No envelope key. |
| Ops task role       | No policies.                                                                                                                                                                           |
| Service task        | Unchanged, including its secrets and its roles.                                                                                                                                        |
| Runbook             | "Change a database role" runs this task. A person does not connect as master.                                                                                                          |

## Cost

This chunk is not applied, so it adds no monthly charge. A task definition and an IAM role are not billed by the hour. The one-off run is a later chunk and is billed per second. No NAT gateway, no load balancer, and no interface endpoint.

## Risks

A command override that still hits the server would leave proofs hanging. The image test with no `--entrypoint` is the check.

A policy copied from the service task role would let the ops task read the envelope key. The ops task role has no policies, and the execution role's `kms:Decrypt` list is exactly the role-secrets key.

The master password on the service task would widen the service. The service task definition does not gain it.

A cleartext password in `ALTER ROLE` would be logged by the default `log_min_error_statement` on a failed statement, and `pg_stat_statements` can keep that text. The statement carries the verifier. The must-fail test checks the SQL text of every statement.

Running the task definition before the database exists is refused by the count. The runbook says the database is on first.

Stdout that includes the password fails the must-fail test. A driver message is not attached to stderr.

## Out-of-band

- The second fresh-context review. This chunk injects the master password and adds an IAM role that can read it. The review that writes this spec does not count.
- No apply in this chunk.
- No password, alarm email, real account id, hosted zone id, key ARN, or secret ARN in this spec, the plan, the tests, or the runbook.

## Tests

No test uses a real account id or a real password from a secret. Fixtures use a planted marker.

- `docker run <image> node /app/probe.js` with no `--entrypoint` exits 1, stdout `fail\n`, stderr `env\n`.
- `docker run <image>` with no command still starts the server.
- Bootstrap success: stdout matches one integer and a newline, stderr is empty, exit 0. A second run does the same.
- Failure at each step: stdout empty, stderr the step word, exit 1.
- Must-fail: a planted password appears in neither stdout nor stderr, including when the driver throws that password.
- Must-fail: the SQL text handed to the driver for every statement never contains the planted password.
- `service_image` null: no ops task definition.
- Database off: no ops task definition.
- Both set: the ops task definition exists, its execution role names the master secret and the three role secrets, `kms:Decrypt` is exactly the role-secrets key, image pull is `ecr:GetAuthorizationToken` plus `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, and `ecr:BatchGetImage` on the service repository only, its task role has no policy, and the service task definition's secret list is unchanged.

## Catalogue

The last commit on this branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. The new row is `db-ops-task`, placed before `first-running-task`, and it is **done**. Phase 0 becomes 23 rows: 19 done, 1 superseded (`api-au-hostname`), 3 not started. The snapshot's next chunk is `first-running-task`. `kms-mrk-replica` stays last.
