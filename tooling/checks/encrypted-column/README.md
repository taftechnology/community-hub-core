# encrypted-column checker

Type-aware ESLint fixture self-test for the `@community-hub/no-encrypted-column-query` allow-list (and companion rules). It replaces the old SQL-file `encrypted-query` scanner.

Root ESLint ignores `**/fixtures/**`, so this package constructs ESLint **programmatically** with `fixtures/tsconfig.json`. `pnpm test` here is the must-fail / must-pass matrix. This checker is **not** wired into `tooling/checks/run.ts`.

## Live lint coverage

The plugin is enabled on the typed (`projectService: true`) block in the repo `eslint.config.js`. Today `pnpm lint` only runs workspace packages, so coverage is `packages/*/src` and `apps/*/src`. `modules/**` is in the ESLint glob but is **not** scanned in CI until a module package exists as a workspace. Fixture trees still use a fake `modules/` path so the rule is proven.

## Rules

| Id                                          | Flags                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@community-hub/no-encrypted-column-query`  | `Ciphertext` / `BlindIndex` value types in disallowed query positions; branded casts; `sql.raw`; string `db.execute` |
| `@community-hub/no-kms-port-outside-crypto` | `KmsPort.generateDataKey` / `.decrypt` outside `packages/crypto/src`                                                 |
| `@community-hub/no-restricted-disable`      | `eslint-disable` of these rule ids                                                                                   |
| `@community-hub/no-ts-ignore`               | `@ts-ignore` / `@ts-expect-error` in non-test source                                                                 |
| `@community-hub/no-crypto-testing-import`   | `@community-hub/crypto/testing` imported from non-test source                                                        |
