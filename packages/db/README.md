# `@community-hub/db`

Privileged bootstrap, Drizzle Kit wrapped runner, and transaction-local tenant scope for organisation-scoped queries.

## Tests

Docker is required. From the repo root:

```bash
pnpm --filter @community-hub/db test
```

`test/global-setup.ts` starts Compose, bootstraps the four roles, writes PgBouncer `userlist.txt`, then starts PgBouncer. CI warms Postgres first with `docker compose -f packages/db/test/docker-compose.yml up -d postgres`; it does not start PgBouncer or run bootstrap.

| Port | Connection                  | Used for                                               |
| ---- | --------------------------- | ------------------------------------------------------ |
| 5432 | Direct Postgres             | Privileged bootstrap and the migrator. Never a pooler. |
| 6432 | PgBouncer, transaction mode | `app` / `identity` / `platform` logins.                |

`hub_bleed` and `hub_reuse` are test-only aliases (`pool_size=1`) on the same database.
