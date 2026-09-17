# T1 implementer report — Workspace root and `packages/kernel`

Task: docs/plans/2026-09-17-monorepo-skeleton.md § T1  
Branch: `feat/2026-09-17-monorepo-skeleton`

## RED

Prior untrusted `health.ts` / `index.ts` were deleted. Test written first.

**Command:**

```bash
cd packages/kernel && pnpm install && pnpm test
```

(Standalone `packages/kernel/package.json` with only `vitest` + `typescript` before the root workspace existed.)

**Exit code:** 1

**Output (abridged):**

```
 FAIL  src/health.test.ts [ src/health.test.ts ]
Error: Cannot find module './health' imported from '.../packages/kernel/src/health.test.ts'
 ❯ src/health.test.ts:3:1
      3| import { healthPayload } from "./health";

 Test Files  1 failed (1)
      Tests  no tests
```

## GREEN

**Implementation:** minimal `health.ts` + `index.ts`, then full workspace tooling.

**Command:**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

**Exit code:** 0

**Output (abridged):**

```
@community-hub/kernel:test:  ✓ src/health.test.ts (1 test) 2ms
@community-hub/kernel:test:  Test Files  1 passed (1)
@community-hub/kernel:test:       Tests  1 passed (1)
 Tasks:    1 successful, 1 total  (test)
```

## Files changed / added

| Path                                    | Role                                             |
| --------------------------------------- | ------------------------------------------------ |
| `package.json`                          | Root workspace, turbo scripts, Node 24 + pnpm 10 |
| `pnpm-workspace.yaml`                   | `packages/*`, `apps/*`                           |
| `pnpm-lock.yaml`                        | Lockfile                                         |
| `turbo.json`                            | lint, typecheck, test, build                     |
| `tsconfig.base.json`, `tsconfig.json`   | Strict TS + project references                   |
| `.nvmrc`, `.editorconfig`, `.gitignore` | Environment / ignore                             |
| `eslint.config.js`, `.prettierrc`       | ESLint 9 flat + Prettier                         |
| `vitest.config.ts`                      | Shared Vitest include pattern                    |
| `packages/kernel/*`                     | `@community-hub/kernel`, `healthPayload` export  |

## Concerns

- **ESLint + test files:** `health.test.ts` is excluded from the kernel `tsc --build` graph; ESLint uses non-type-checked `recommended` rules for `*.test.ts` so lint does not require a separate spec tsconfig.
- **esbuild build scripts:** pnpm 10 reports ignored `esbuild` postinstall until `pnpm approve-builds` — Vitest still runs; watch if CI ever blocks on ignored scripts.
- **Turbo `test` → `^build`:** Kernel tests run after `tsc --build`; fine for one package, revisit if test-only packages appear later.
