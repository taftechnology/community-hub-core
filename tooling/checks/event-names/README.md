# event-names checker

Stage 1 check: event names must be unique across the repo. Turbo ESLint lints one package at a time, so a Set of seen names never sees two modules.

## Input contract

Relative to the scan root:

- TypeScript: `packages/*/src/**/*.ts`, `apps/*/src/**/*.ts`, `modules/**/*.ts`
- Not scanned: `**/*.test.ts`, and directories named `node_modules`, `dist`, `coverage`, `test`, `tests`, `.turbo`, `fixtures`

Self-tests use mini-trees (for example `fixtures/duplicate-publishes/packages/alpha/src/module.ts`) so they exercise the same `check(root)` entry point as CI.

Parsing is regex/text on `.ts` files (not a TypeScript compiler). Day-one shapes:

- `defineEvent({ name: "..." })` / `name: '...'`
- `publishes: [ ... string literals ... ]` inside `defineModule({ ... })`

A name listed in both `defineEvent` and the same file's `defineModule` `publishes` is one claim. Two files claiming the same name is a violation. A name that is not a visible string literal is a fail-closed violation, not a skip.

## Rules

| Finding                                                               | Result                                         |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| Two modules / files claim the same event name                         | fail                                           |
| The same name once (including defineEvent + publishes in one file)    | pass                                           |
| Zero `defineModule` / `defineEvent` object-literal calls in the globs | notice **and** `ok: false` (not a silent pass) |
| Live health module with `publishes: []`                               | pass (a real declaration, zero duplicates)     |

## API

`check(root?: string)` — defaults to `process.cwd()`. Returns `{ ok, violations, declarationCount, notice? }`.
