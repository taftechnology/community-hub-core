Spec: docs/specs/2026-10-26-ops-console-ui.md

# Ops console UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A granted operator opens the ops hostname, enrols with their email code and enrolment code, registers two passkeys on different authenticators, signs in with a passkey, reads the directory and signs out. The console is a static bundle in `apps/ops`, built into the service image and served by the existing static routes. The register-options route gains `rp.name`, fixed user labels and `excludeCredentials`. There is no Terraform change, no migration, no identity change and no live run.

**Architecture:** `apps/ops` copies `apps/admin`'s Vite, React, React Router and Tailwind set-up at the same pinned versions, with hash routes. Small pure modules (`base64url`, `webauthn`, `api`, `session`) take their browser dependencies (`fetch`, `navigator.credentials`, `navigator.locks`) as arguments so jsdom tests can stub them. `main.tsx` passes the real globals. Screens compose `packages/ui`'s `Button` and `Alert` and native inputs. `apps/api/Dockerfile` builds the bundle into `/app/ops` and sets `OPS_STATIC_DIR`.

**Tech stack:** React 19.3, React Router 7.18 (`createHashRouter`), Vite 8.3, Tailwind 4.3, Vitest 4 (jsdom), axe-core 4.13, Zod in `packages/contracts` (types only in `apps/ops`).

Slug: ops-console-ui
Status: approved (2026-10-26, Abdus Salam)

## Who does what

| Actor                     | Writes repo commits                             | Runs `terraform apply` | Puts secret values, runs AWS one-offs   | Applies or merges |
| ------------------------- | ----------------------------------------------- | ---------------------- | --------------------------------------- | ----------------- |
| Implementer (Antigravity) | Yes — Tasks 1–9, only the files each task names | Never                  | Never                                   | Never             |
| Reviewer (fresh Claude)   | Never                                           | Never                  | Never                                   | Never             |
| Human owner (Abdus)       | Never during the run                            | Not needed             | Not in this chunk (`ops-console-proof`) | Merges the PR     |
| Developer (Adnan)         | Never during the run                            | Never                  | Never                                   | Never             |

The owner approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved and no task edits it. Refinements are listed in **Deviations from the spec** and repeated in the PR body.
- Work only in the worktree `C:\Recovered\Taftech\wt-ops-console-ui` on branch `feat/2026-10-26-ops-console-ui`. Commit locally; never push.
- No agent runs `terraform`, `aws`, `docker push`, or anything against a deployed environment. Runs start with no AWS credentials and with pushes blocked.
- Staging stays parked. No task touches `infra/`, a workflow, `turbo.json`, `eslint.config.js`, a checker under `tooling/`, a migration, `modules/`, `apps/admin/`, `packages/ui/` or `packages/tokens/`. The `package.json` and `tsconfig*.json` files allowed are the new ones under `apps/ops/` (Task 3). `pnpm-lock.yaml` changes only in Task 3, and only by gaining the `apps/ops` importer.
- **No new third-party package.** `apps/ops/package.json` uses exactly the versions in `apps/admin/package.json` (dependencies and devDependencies), plus `@community-hub/contracts: "workspace:*"` (types only) and `@community-hub/kernel: "workspace:*"` as a devDependency (Task 3, for pin 2's type chain). If `pnpm install` would add or change any other lockfile entry, stop.
- **Rules 5, 6 and 8.** No account id, ARN, real hostname, email address, code, token or IP address in any commit. Tests use `ops.example.test`, `operator@example.test`, eight-digit codes such as `12345678`, and base32 enrolment codes made of `A`s, as the existing ops tests do. `apps/ops/src` has no `console.` call, analytics, error reporting, `localStorage`, `sessionStorage`, IndexedDB or `document.cookie` use. No `VITE_` variable.
- **Existing tests:** no existing assertion is changed or removed. The reviewer checks that `git diff origin/main -- '*.test.ts' '*.test.tsx'` shows only added lines outside new files.
- **Fixtures vs secret scanners:** no fixture string may look like a real AWS key, Stripe key or webhook secret.
- Only one run at a time uses the Docker test database (Task 2). `apps/api` tests run against the built `@community-hub/contracts` dist. Run `pnpm --filter @community-hub/contracts build` after Task 1 and before Task 2's tests.
- **Known Windows exceptions:** `packages/db/src/generate.test.ts` (ENOENT spawning `drizzle-kit`) and occasional Windows-only timeouts in `migrate.integration`, `plaintext-dist` and identity's "forty parallel wrong guesses". They pass on Linux CI. `image.test.ts` image cases run only with `RUN_IMAGE_TESTS=1` (CI Stage 3); locally they are skipped, which is expected.
- **Gates.** Per task: `pnpm gate`, with only the exceptions above. Before the PR: `pnpm turbo run test --force --continue`, then `pnpm gate`. LF line endings.
- **Implementer runs have a hard time limit.** Append each weakening result to the task report as soon as you see it, and commit as soon as the gate passes.
- A second fresh-context review is required (authentication). The owner's assistant starts it when the PR opens.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed. Reports go to `.superpowers/sdd/task-N-report.md`.

## Deviations from the spec (repeated in the PR body)

1. **Pin 10 has two halves.** 10a, an always-on test of the Dockerfile text, runs locally and is weakened locally. 10b, the running image serving the console, runs only with `RUN_IMAGE_TESTS=1` (CI Stage 3). The reviewer confirms 10b in the CI log.
2. **Browser globals are injected.** `api.ts`, `session.ts` and `webauthn.ts` take `fetch`, `credentials` and `locks` as parameters rather than reading globals. Only `main.tsx` reads `window.fetch`, `navigator.credentials` and `navigator.locks`. This is so jsdom, which has none of the WebAuthn or Web Locks APIs, can test them. Behaviour is unchanged.

## Security pins

The implementer weakens the source once as described, sees the named test fail, restores the source, and reports the failure output in the task report. A weakened tree is never committed. Spec pin numbers are in brackets.

| #   | Setting (spec pin)                                                                     | Test that pins it (Task)                                                                                                                                                                                               | Weakening that must make it fail                                                                          |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Bundle shape and markup (1)                                                            | `apps/ops/src/build.test.ts` "builds exactly index.html, one hashed JS and one hashed CSS with no inline code" (T3)                                                                                                    | Add `style="margin:0"` to `<body>` in `apps/ops/index.html`                                               |
| 2   | Every built file is served (2)                                                         | `build.test.ts` "loadOpsStatic registers every built file" (T3)                                                                                                                                                        | Set `build.sourcemap: true` in `apps/ops/vite.config.ts` (the `.map` files are skipped by the allow-list) |
| 3   | No injected styles at runtime (3)                                                      | `apps/ops/src/no-injected-style.test.tsx` "no screen state injects a style element, rule or attribute" (T7)                                                                                                            | In `shell.tsx`, a `useEffect` that appends `document.createElement("style")` to `document.head`           |
| 4   | Requests are relative, JSON, no `Authorization`; forms prevent default (4)             | `api.test.ts` "every POST is relative JSON with no Authorization" (T4); `enrol.test.tsx` "every submit is defaultPrevented" (T6)                                                                                       | Drop the `content-type` header in `api.ts` `post`                                                         |
| 5   | Nothing stored, nothing personal in the URL, enrolment code not autofilled (5)         | `watchStorage()` assertions in `enrol.test.tsx` (T6, also `location.href` after each step and `autocomplete`), `sign-in.test.tsx` and `shell.test.tsx` (T5, sign-in, the U7 path, sign-out) and `session.test.ts` (T4) | In step 1, `sessionStorage.setItem("ops-email", email)`                                                   |
| 6a  | Refreshes are serialised (6)                                                           | `session.test.ts` "two 401s in one tab and in two tabs refresh one at a time" (T4), with a fake lock manager shared by two controllers                                                                                 | Call `refresh` outside `locks.request`                                                                    |
| 6b  | A 401 that clears on repeat sends no refresh; at most two repeats; no POST retried (6) | `session.test.ts` "repeats once before refreshing" (T4)                                                                                                                                                                | Remove the repeat before the refresh                                                                      |
| 6c  | `#/enrol` never probes the session (6)                                                 | `shell.test.tsx` "opening #/enrol calls neither me nor refresh" (T5)                                                                                                                                                   | Run the load-time probe on every route                                                                    |
| 7a  | Register options carry `rp.name`, fixed labels and `excludeCredentials` (7)            | `ops-flow.integration.test.ts` "pin U12: register options carry rp.name, fixed labels and excludeCredentials" (T2)                                                                                                     | Remove `excludeCredentials` from the route's response                                                     |
| 7b  | The console passes them to `create` (7)                                                | `enrol.test.tsx` "passes rp, user and excludeCredentials to create" (T6)                                                                                                                                               | Omit `excludeCredentials` in `webauthn.ts` `toCreationOptions`                                            |
| 8   | Fixed error text; ceremony button disabled while pending (8)                           | `webauthn.test.ts` "maps each error class to fixed text" (T4); `sign-in.test.tsx` "never shows browser error text" and "disables the button while pending" (T5)                                                        | Return `error.message` from the default branch of `ceremonyMessage`                                       |
| 9   | No `console.` and no React default logging (9)                                         | `apps/ops/src/no-console.test.ts` "src has no console call", "main passes rootOptions to createRoot" and "createRoot gets no-op error handlers" (T3)                                                                   | Add `console.error(error)` in the error boundary's `componentDidCatch`                                    |
| 10a | The Dockerfile builds, copies and points at the bundle (10)                            | `image.test.ts` "builds and serves the ops bundle" (T8), always on                                                                                                                                                     | Delete `ENV OPS_STATIC_DIR=/app/ops`                                                                      |
| 10b | The image serves the console on the ops host only (10)                                 | `image.test.ts` "serves the ops console on the ops host" (T8), CI only (deviation 1)                                                                                                                                   | Reasoned only: as 10a; the reviewer checks the CI log                                                     |

Regression (not a weakening): every existing `ops-flow.integration.test.ts`, `ops-static.test.ts` and `contracts` assertion passes unchanged.

## Rollback

| Point        | Rollback                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before merge | Revert with new commits.                                                                                                                                                                                                                                             |
| After merge  | Revert the merge. There is no migration, infrastructure or secret change. Without the bundle the image sets no `OPS_STATIC_DIR` and the ops host serves only the API, as it does today. The register-options change is additive, and the console is its only caller. |

## Stop and ask (AGENTS.md §12)

Implementer, stop and report if:

- the plan or spec is wrong or ambiguous, or a test cannot be written as described;
- a change is needed in a forbidden file (Global constraints), or `pnpm install` would change the lockfile beyond the `apps/ops` importer;
- the relative import of `../../api/src/ops-static.ts` from `apps/ops/src/build.test.ts` cannot typecheck or run (Task 3);
- the Vite build emits anything other than `index.html`, one JS and one CSS file;
- an existing test assertion needs changing;
- the same step fails twice, or a command fails to start (process creation error). Report which steps remain, and retry at most once.

---

### Task 1: Response schemas for the passkey options

**Files:** Modify `packages/contracts/src/ops.ts`, `packages/contracts/src/ops.test.ts` (new `it` blocks only).

**Shape (spec Contracts, U12):** add, beside the existing response schemas:

- `passkeyRegisterOptionsResponse` (alias `opsPasskeyRegisterOptionsResponse`), a `z.strictObject` at every level:
  - `challenge`: base64url string, `min(1)`
  - `rp`: `{ id: string, name: string }`
  - `user`: `{ id: base64url string, name: string, displayName: string }`
  - `pubKeyCredParams`: array of `{ type: literal "public-key", alg: number int }`
  - `attestation`: literal `"none"`
  - `authenticatorSelection`: `{ userVerification: enum "preferred" | "required", residentKey: literal "required" }`
  - `excludeCredentials`: array (required, may be empty) of `{ type: literal "public-key", id: base64url string min(1) }`
- `passkeyAuthenticateOptionsResponse` (alias `opsPasskeyAuthenticateOptionsResponse`):
  - `challenge`: base64url string
  - `rpId`: string
  - `userVerification`: literal `"required"`, optional

Export the inferred types: `PasskeyRegisterOptionsResponse` and `PasskeyAuthenticateOptionsResponse`. `rolesResponse` and `meResponse` stay untouched.

**Test first (RED):** `ops.test.ts`:

- **Register options.** A full valid body passes, and the same body with `excludeCredentials: []` passes. Each of these is rejected:
  - missing `rp.name`
  - missing `excludeCredentials`
  - an extra top-level key
  - an extra key inside `rp`
  - `attestation: "direct"`
  - `residentKey: "preferred"`
- **Authenticate options.** Passes with and without `userVerification`. Rejected with `userVerification: "preferred"` or an extra key.

**Rule this must not break:** every existing `ops.test.ts` assertion.

**Commit subject:** `feat(contracts): describe the ops passkey options responses`

- [ ] RED, GREEN.
- [ ] `pnpm --filter @community-hub/contracts test`, `pnpm --filter @community-hub/contracts build`, `pnpm gate`.

### Task 2: Register options carry `rp.name`, fixed labels and `excludeCredentials`

**Files:** Modify `apps/api/src/ops-routes.ts` (the `/v1/ops/passkey/register/options` handler only), `apps/api/src/ops-flow.integration.test.ts` (new `it` blocks only).

**Shape (spec U12):** add module constants in `ops-routes.ts`: `OPS_RP_NAME = "Community Hub operations"` and `OPS_USER_LABEL = "Community Hub operator"`. The handler's response becomes:

- `rp: { id: options.rp.id, name: OPS_RP_NAME }`
- `user: { id: base64url(options.user.id), name: OPS_USER_LABEL, displayName: OPS_USER_LABEL }`
- `excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ type: "public-key", id: base64url(c.id) }))`
- every other field as today.

The authenticate-options handler is unchanged. Identity is not touched.

**Test first (RED):** `pnpm --filter @community-hub/contracts build` first. Add these to `ops-flow.integration.test.ts`, reusing the file's existing grant, enrolment and software-authenticator helpers (as in "enrolment and passkey registration flow"):

- **Pin 7a, "pin U12: register options carry rp.name, fixed labels and excludeCredentials":**
  - (a) An enrolment session before any passkey gets `rp.name === "Community Hub operations"`, `user.name` and `user.displayName === "Community Hub operator"`, and `excludeCredentials` deep-equal to `[]`.
  - (b) After the first passkey is registered, the next options for the same enrolment session list exactly that credential id, base64url.
  - (c) An operator session (signed in after two passkeys, as in "operator session registers an additional passkey…") lists both credential ids.
  - (d) No response body contains the test address or the user id.
- **"register and authenticate options match the contract schemas":** both 200 bodies pass `passkeyRegisterOptionsResponse.parse` and `passkeyAuthenticateOptionsResponse.parse` from `@community-hub/contracts/ops` (the export path the routes already import from).

**Rule this must not break:** every existing `ops-flow` assertion. The enrolment, registration and full-flow tests pass unchanged.

**Commit subject:** `fix(api): complete the ops passkey registration options`

- [ ] RED, GREEN. Pin 7a.
- [ ] Docker test database up. `pnpm --filter @community-hub/api test`, `pnpm gate`.

### Task 3: `apps/ops` scaffold, build shape and logging guards

**Files:**

- **Create, configuration:** `apps/ops/package.json`, `apps/ops/index.html`, `apps/ops/vite.config.ts`, `apps/ops/vitest.config.ts`, `apps/ops/tsconfig.json`, `apps/ops/tsconfig.test.json`.
- **Create, source:** `apps/ops/src/index.css`, `apps/ops/src/deps.ts`, `apps/ops/src/main.tsx`, `apps/ops/src/root-options.ts`, `apps/ops/src/error-boundary.tsx`, `apps/ops/src/shell.tsx`. No `vite-env.d.ts`, because the app has no `VITE_` variable.
- **Create, tests:** `apps/ops/src/build.test.ts`, `apps/ops/src/no-console.test.ts`, `apps/ops/src/error-boundary.test.tsx`, `apps/ops/src/shell.test.tsx`, `apps/ops/src/test-support.ts` (shared stubs, the fake lock manager and the storage spies: Tasks 4–7 import it).
- **Modify:** `pnpm-lock.yaml` (via `pnpm install`).

**Shape (spec U1, U2, U5, U8, U15):**

- **`package.json`.** `@community-hub/ops`, private, `type: module`. Copy `apps/admin/package.json`'s `scripts`, `dependencies` and `devDependencies`, plus `"@community-hub/contracts": "workspace:*"` under `dependencies` and `"@community-hub/kernel": "workspace:*"` under `devDependencies`. Kernel is needed because pin 2's test imports `apps/api/src/ops-static.ts`, whose `gate.ts` type chain reaches kernel's `dist` types; the dependency makes turbo typecheck kernel first. Both are workspace packages, not third-party ones. Do not change any version.
- **`tsconfig.json` and `tsconfig.test.json`.** Copies of admin's. The test config's `include` also lists `vite.config.ts` and `vitest.config.ts`.
- **`vitest.config.ts`.** As admin's, with jsdom and `globals: true`, with no `env` block.
- **`index.html`.** `lang="en"`, charset, viewport, `<title>Community Hub operations</title>`, `<div id="root"></div>`, and one `<script type="module" src="/src/main.tsx">`. Nothing else: no icon link, no inline script or style.
- **`vite.config.ts`.** `plugins: [react(), tailwindcss()]`, `publicDir: false`, and `build: { assetsInlineLimit: 0, modulePreload: { polyfill: false }, manifest: false, sourcemap: false, cssCodeSplit: false }`.
- **`index.css`.** The same three imports as admin's.
- **`root-options.ts`.** Exports `rootOptions`, whose `onUncaughtError`, `onCaughtError` and `onRecoverableError` do nothing.
- **`deps.ts`.** The one `OpsDeps` type: `{ fetch: typeof fetch; credentials: Pick<CredentialsContainer, "get" | "create"> | undefined; locks: LockLike | undefined; publicKeyCredentialSupported: boolean }`, where `LockLike` is `{ request<T>(name: string, callback: () => Promise<T>): Promise<T> }`. It also exports `browserDeps()`, the only code that reads `window.fetch.bind(window)`, `navigator.credentials`, `navigator.locks` and `typeof window.PublicKeyCredential === "function"`.
- **`main.tsx`.** Exactly `createRoot(root, rootOptions).render(<StrictMode><ErrorBoundary><Shell deps={browserDeps()} /></ErrorBoundary></StrictMode>)`.
- **`error-boundary.tsx`.** A class component. It renders `<h1>Something went wrong. Reload the page.</h1>` after an error, and its `componentDidCatch` is empty.
- **`shell.tsx`.**
  - If `deps.locks` or `deps.credentials` is missing, or `deps.publicKeyCredentialSupported` is false, it renders only `<h1>This browser is not supported.</h1>`.
  - Otherwise it renders `RouterProvider` with a `createHashRouter` (both from `"react-router"`, as admin imports them) with routes `/`, `/sign-in` and `/enrol`. Each route renders a heading only ("Directory", "Sign in", "Enrol"). Tasks 5–7 replace these.
  - It exports `Shell` and a `createOpsRouter(deps)` helper for tests.
- **Hash-router tests.** Every UI test sets the starting route with `history.replaceState(null, "", "#/…")` **before** rendering, and resets it to `#/` in `afterEach`, because `createHashRouter` reads the hash when it is created.

**Test first (RED):**

- **`build.test.ts`.** The first line is `// @vitest-environment node`. In a `beforeAll`, it runs `pnpm exec vite build` in `apps/ops` with `CI=1`, passing `120000` as the timeout argument, as admin's `build-html.test.ts` does. Let `files` be the recursive list of every file under `dist/`, relative and with `/` separators, taken directly from the file system and independent of any regex. Then:
  - **Pin 1.** `files` is exactly `index.html` plus two entries matching `^assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(js|css)$`, one `.js` and one `.css`. The total size is under 1 MiB.
  - **Pin 1 markup.** Every `<script>` in `index.html` has a `src` with no `://`. There is no `<style`, no ` style="`, and no `data:`. The CSS contains neither `url(` nor `data:`.
  - **Pin 2.** `import { loadOpsStatic } from "../../api/src/ops-static.js"`. Use the `.js` suffix, as the repo's other cross-file test imports do; Bundler resolution maps it to the `.ts` file. The sorted patterns from `loadOpsStatic(dist)` deep-equal the sorted `["/", ...files.filter((f) => f !== "index.html").map((f) => "/" + f)]`. Because `files` comes from the file system, a skipped `.map` breaks this equality. Each route's `handle()` response has the content type the allow-list gives that extension.
- **`no-console.test.ts`.** The first line is `// @vitest-environment node`.
  - **Pin 9.** Every non-test file under `apps/ops/src` has no match for `/\bconsole\s*\./`.
  - **Pin 9.** The source of `main.tsx` contains `createRoot(root, rootOptions)`.
  - **Pin 9.** `rootOptions` has all three handlers. Calling each with `new Error("x")` while `console.error` is spied leaves the spy uncalled.
- **`error-boundary.test.tsx`** (spec Behaviour 8, U15). A child that throws renders the heading "Something went wrong. Reload the page.". `console.error` and `console.warn` spies record nothing that the boundary logs; React's own development warnings are filtered out by rendering through `createRoot(container, rootOptions)`. axe passes on that state.
- **`shell.test.tsx`** (created here, extended in Task 5). Each of the following renders only "This browser is not supported.": `locks` missing, `credentials` missing, and `publicKeyCredentialSupported: false`. axe passes on that state, with `color-contrast` disabled as in admin.
- **`test-support.ts`** provides:
  - `stubDeps(routes)`, a `fetch` routed by method and path that records each call;
  - a `credentials` stub;
  - `fakeLocks()`, which runs callbacks one at a time in arrival order;
  - `watchStorage()`, which spies on `Storage.prototype.setItem` and the `document.cookie` setter, and returns the recorded calls;
  - `renderAt(hash, deps)`.

**Rule this must not break:** nothing outside `apps/ops` and the lockfile changes.

**Lockfile check.** After `pnpm install`, run `git diff --stat pnpm-lock.yaml`, then read the diff. It may only add the `apps/ops` importer block and the workspace links. If any package version or `packages:` entry changes, stop and report.

**Extra stop condition.** If `tsc --noEmit -p tsconfig.test.json` in `apps/ops` cannot typecheck the `ops-static.js` import even with the kernel devDependency (for example a `lib` mismatch with `apps/api`), stop and report. Do not loosen a compiler option and do not copy the allow-list.

**Commit subject:** `feat(ops): scaffold the ops console bundle`

- [ ] `pnpm install` and the lockfile check. RED, GREEN. Pins 1, 2, 9.
- [ ] `pnpm --filter @community-hub/ops lint typecheck test build`, `pnpm gate`.

### Task 4: Byte, WebAuthn, API and session helpers

**Files:** Create `apps/ops/src/base64url.ts`, `apps/ops/src/webauthn.ts`, `apps/ops/src/api.ts`, `apps/ops/src/session.ts`, `apps/ops/src/messages.ts`, and a test file for each of the first four.

**Shape (spec U3, U6, U7, U9, U12):**

- **`messages.ts`.** Every fixed string the console shows, as named constants with the exact spec wording (U6, U9–U14). Screens import from here, and tests compare against it.
- **`base64url.ts`.**
  - `encode(bytes: ArrayBuffer | Uint8Array): string` produces unpadded base64url.
  - `decode(text: string): Uint8Array` accepts input with or without `=` padding, and throws on any character outside the alphabet.
- **`webauthn.ts`.** Uses `import type` from `@community-hub/contracts/ops` only.
  - `isRegisterOptions(value: unknown)` and `isAuthenticateOptions(value: unknown)` are hand-written guards. They check the fields the console uses: string `challenge`, `rp.id`, `rp.name`, `user.*`, `excludeCredentials` array, and `rpId`.
  - `toCreationOptions(json)` decodes `challenge`, `user.id` and each `excludeCredentials[].id`, and passes `rp`, `user` labels, `pubKeyCredParams`, `attestation`, `authenticatorSelection` and `excludeCredentials` through.
  - `toRequestOptions(json)` gives `{challenge, rpId, userVerification}` with no `allowCredentials`.
  - `registrationBody(credential)` gives `{clientDataJSON, attestationObject}`.
  - `assertionBody(credential)` gives `{credentialId: encode(rawId), clientDataJSON, authenticatorData, signature}`. It never includes `userHandle`.
  - `ceremonyMessage(error: unknown, ceremony: "register" | "authenticate")` maps errors by name, using duck typing rather than `instanceof DOMException` (jsdom and Node have different `DOMException` classes). The name is read when `error` is a non-null object with a string `name`. A plain object `{ name: "NotAllowedError" }` therefore maps like the real error. The rules are:
    - `NotAllowedError` and `AbortError` give the cancelled text.
    - `InvalidStateError` on register gives the same-device text.
    - Everything else gives the default text.
- **`api.ts`.**
  - `createApi(fetchFn)` returns `{ get(path), post(path, body = {}, options?: { keepalive?: boolean }) }`.
  - Each throws synchronously unless `path` starts with `/v1/ops/`.
  - `post` sends `method: "POST"`, `headers: { "content-type": "application/json" }`, `body: JSON.stringify(body)`, and `keepalive` when asked. Neither method sends `Authorization`, `mode` or `credentials`, so the defaults apply.
  - Both resolve to `{ kind: "response", status, body: unknown }`. `body` is the parsed JSON, or `undefined` when there is none or it is not JSON. A rejected fetch resolves to `{ kind: "network" }`. Neither method retries.
  - `isGenericFailure(result)` is true for `network`, 403, 429 and any 5xx.
- **`session.ts`.** `createSessionClient({ api, locks })` gives:
  - `authedGet(path)`. It does `get`. On a 401 it runs `locks.request("ops-session-refresh", async () => …)`:
    1. Repeat the `get`. If it is not a 401, return it.
    2. Otherwise `post("/v1/ops/session/refresh", {}, { keepalive: true })`.
    3. On 200, repeat the `get` once more and return it.
    4. On 401, return `{ kind: "ended" }`.
    5. Any other refresh outcome is returned as is.

    `authedGet` is used only for `/v1/ops/me` and `/v1/ops/directory`.

  - `signOut()` runs `post("/v1/ops/session/end")` inside the same lock.
  - The `locks` parameter is `LockLike` from `deps.ts`.
  - A 401 from the final repeat after a successful refresh is returned as `{ kind: "ended" }` too, so screens handle one ending case.

**Test first (RED):**

- **`base64url.test.ts`.** Round trips for lengths 0–5 and 32. Decoding accepts padded and unpadded input. A `+` or `/` throws. No output contains `=`.
- **`webauthn.test.ts`.**
  - **Conversions.** `toCreationOptions` turns a sample response into byte arrays that equal the decoded inputs, and keeps `rp.name` and the labels. `excludeCredentials: []` stays `[]`. `toRequestOptions` has no `allowCredentials`. `assertionBody` never has `userHandle`, even when the credential has one.
  - **Guards.** They reject a body missing `rp.name` or `excludeCredentials`.
  - **Pin 8.** Each error name (as a `DOMException` and as a plain `{ name }` object), plus `TypeError`, `{}` and `undefined`, maps to the right constant. A `DOMException` whose message is `"secret detail"` never yields text containing it.
- **`api.test.ts`.**
  - **Pin 4.** Every `post` call has a relative `/v1/ops/` URL, `content-type: application/json`, a JSON string body (`"{}"` by default), and no `authorization` header.
  - **Paths.** An absolute or non-ops path throws.
  - **Outcomes.** A rejected fetch gives `network`. A 204 gives `body: undefined`. `isGenericFailure` is true for 403, 429, 500 and network, and false for 200 and 401.
- **`session.test.ts`.** It uses `fakeLocks()` from `test-support.ts`. A fake fetch models one cookie jar: each successful refresh rotates a counter, and `get` answers 200 only with the current counter. The refresh response resolves only after a deferred promise is released, so two refreshes **can** overlap when the lock is bypassed. The fake records the highest number of refreshes in flight at once.
  - **Pin 6a.** Two `authedGet` calls in one client, and one call in each of two clients sharing one `fakeLocks()`, all start with a stale counter. The highest number of refreshes in flight is 1, and every call ends 200.
  - **Pin 6b.** Repeat before refreshing: when the first repeat answers 200, no refresh is sent. At most three `get`s are made per `authedGet`.
  - **U7.** The refresh request carries `keepalive: true`.
  - **Ending.** A refresh 401 gives `ended`. A 401 on the final repeat gives `ended`.
  - **Pin 6, no POST retried.** `signOut` answering 401 makes exactly one `post` and no refresh, and runs inside the lock.
  - **Pin 5.** `watchStorage()` records nothing across these flows.

**Rule this must not break:** none of these modules reads a browser global. Deviation 2.

**Commit subject:** `feat(ops): add the passkey, API and session helpers`

- [ ] RED, GREEN. Pins 4 (client), 6a, 6b, 8 (mapping).
- [ ] `pnpm --filter @community-hub/ops lint typecheck test`, `pnpm gate`.

### Task 5: Shell, session probe, sign-in and sign-out

**Files:**

- **Modify:** `apps/ops/src/shell.tsx`, `apps/ops/src/shell.test.tsx`.
- **Create:** `apps/ops/src/auth-state.tsx`, `apps/ops/src/sign-in.tsx`, `apps/ops/src/sign-in.test.tsx`, `apps/ops/src/focus.ts`.

**Shape (spec U6, U9, U10, U14, Behaviour 1–3, 6):**

- **`auth-state.tsx`.** A context holding:
  - `status`: `"checking" | "signed-in" | "signed-out" | "failed"`;
  - an optional carried `message` (a `messages.ts` constant);
  - `signedIn()`, `signedOut(message?)`, `ended()` (signed out with the session-ended message);
  - `retry()`.
- **Load probe.** The status starts as `unknown`, which is not shown as a state of its own. Whenever the route is not `/enrol` and the status is `unknown`, the shell sets `checking` and calls `authedGet("/v1/ops/me")`. A page opened on `#/enrol` therefore makes no probe. If the operator later moves to `#/` or `#/sign-in` by hand, the probe runs once then. Enrolment's own exits set `signed-out` with their message, so no probe follows them.
  - 200 gives `signed-in`.
  - `ended` or 401 gives `signed-out` with **no** message.
  - A generic failure gives `failed`, which shows the generic text and a "Try again" button that repeats the probe.
  - While `checking`, the page shows "Checking your session…" in `role="status"`.
- **Routing.**
  - `/` while `signed-out` redirects to `/sign-in`.
  - `/sign-in` while `signed-in` redirects to `/`.
  - `/enrol` renders regardless and never triggers the probe.
- **Chrome.** A `<header>` holds the product name "Community Hub operations". When signed in it adds a "Directory" link to `#/` and a "Sign out" `Button`.
- **Sign-out.** `signOut()` (Task 4), then `signedOut()`. On a `network` result, `signedOut` carries the sign-out network message.
- **`focus.ts`.** `useFocusHeading()` focuses the page's `h1` (`tabIndex={-1}`) after each route change and after each step change. Task 6 passes a step key.
- **`sign-in.tsx`.**
  - `h1` "Sign in". The carried message is shown in `role="alert"`.
  - One `Button` `type="button"`, "Sign in with a passkey", disabled while pending.
  - The link "First time? Enrol with your codes" points to `#/enrol`.
  - On click: post `authenticate/options`, check it with `isAuthenticateOptions`, call `credentials.get({ publicKey: toRequestOptions(json) })`, then post `authenticate/verify` with `assertionBody`.
  - Verify 200 gives `signedIn()` and navigates to `/`.
  - Verify 400 or 401 gives "That passkey was not accepted."
  - A ceremony throw gives `ceremonyMessage(error, "authenticate")`.
  - A generic failure, or options that fail the guard, give the generic text.

**Test first (RED):** jsdom, with `stubDeps`, `fakeLocks()` and `renderAt` from `test-support.ts`.

- **`shell.test.tsx`:**
  - **Pin 6c.** Opening `#/enrol` makes no request to `/v1/ops/me` or `/v1/ops/session/refresh`. Moving by hand from `#/enrol` to `#/sign-in` then makes exactly one `me` request and ends on "Sign in", never stuck on "Checking your session…".
  - **Probe outcomes.**
    - A `me` 200 shows the Directory heading, the header link and "Sign out".
    - A `me` 401 then refresh 401 shows "Sign in" with no alert.
    - A `me` 500 shows the generic text and "Try again". Clicking it repeats the probe.
  - **Sign-out.** It calls `/v1/ops/session/end` once, then shows "Sign in". A sign-out network failure shows the close-the-browser text.
  - **Focus.** It is on the `h1` after each navigation.
  - **Pin 5.** `watchStorage()` records nothing across the probe, the U7 refresh path and sign-out.
  - **Keyboard.** Sign-out works by tabbing to "Sign out" and pressing Enter.
  - **axe.** On checking, failed, signed-in and signed-out.
- **`sign-in.test.tsx`:**
  - **Success.** `credentials.get` receives a `Uint8Array` challenge equal to the decoded option, the `rpId`, and no `allowCredentials`. Verify receives exactly `assertionBody`'s four keys. The page ends on the Directory heading.
  - **Failures.** 401 gives "That passkey was not accepted.", and `NotAllowedError` gives the cancelled text.
  - **Generic failures.** 503 on options, 429 on verify, and options missing `rpId` each give the generic text.
  - **Pin 8.** A `DOMException("secret detail", "UnknownError")` gives the default text, and `secret detail` is nowhere in `document.body.textContent`.
  - **Pin 8.** The button is disabled while `credentials.get` is pending, and a second click makes no second options request.
  - **Pin 8.** A network failure on options or verify gives the generic text, and the operator is not treated as signed out.
  - **Pin 5.** `watchStorage()` records nothing, and `location.href` holds no credential id.
  - **Keyboard and alerts.** The button is reachable by Tab and starts sign-in with Enter. Each message is inside `role="alert"`.
  - **axe.** On the idle state and on each message state.

**Rule this must not break:** Tasks 3–4 tests pass unchanged.

**Commit subject:** `feat(ops): add passkey sign-in, the session probe and sign-out`

- [ ] RED, GREEN. Pins 6c, 8 (screen).
- [ ] `pnpm --filter @community-hub/ops lint typecheck test`, `pnpm gate`.

### Task 6: Enrolment

**Files:** Create `apps/ops/src/enrol.tsx` and `apps/ops/src/enrol.test.tsx`. Modify `apps/ops/src/shell.tsx` so the `/enrol` route renders `Enrol`.

**Shape (spec U9, U11, U12, Behaviour 4).** One component holds `step: 1 | 2 | 3 | 4`, the address and the codes in `useState` only. Each step has its own `h1`, and `useFocusHeading(step)` runs. Every `<form onSubmit>` calls `event.preventDefault()` first.

1. **Step 1, "Enrol".**
   - The keep-this-tab-open text sits above the form.
   - The form has a labelled `type="email"` input (`autocomplete="email"`) and a "Send code" submit.
   - It posts `enrolment/start`. A 204 moves to step 2. A generic failure shows the generic text and stays.
2. **Step 2, "Enter your codes".**
   - The possibly-sent text sits above the form.
   - The email code field: labelled, `inputmode="numeric"`, `autocomplete="one-time-code"`. All whitespace is removed before sending.
   - The enrolment code field: labelled, `autocomplete="off"`, `spellcheck={false}`, `autoCapitalize="characters"`. Its value is sent as typed.
   - A "Use a different address" button returns to step 1 and clears both codes.
   - The form posts `enrolment/verify` with `{email, emailCode, enrolmentCode}`:
     - `{status: "enrolment"}` moves to step 3.
     - `{status: "activated"}` calls `signedOut(already-have-two message)` and navigates to `/sign-in`.
     - 401 shows the codes-not-accepted text.
     - A generic failure shows the generic text.
3. **Steps 3 and 4, "Register your first passkey" and "Add a second passkey".** Step 4's lead text is the different-device sentence. Each step has one `Button` `type="button"` "Create passkey", disabled while pending. On click:
   - Post `passkey/register/options` and check the body with `isRegisterOptions`.
   - Call `credentials.create({ publicKey: toCreationOptions(json) })`.
   - Post `passkey/register/verify` with `registrationBody`.
     - `{activated: false}` moves from step 3 to step 4.
     - `{activated: true}` calls `signedOut(enrolment-complete message)` and navigates to `/sign-in`.
     - A 400 shows the not-saved text. The next click fetches fresh options.
     - A 401 on options or verify returns to step 1 with the enrolment-ended text and clears the codes.
   - A ceremony throw shows `ceremonyMessage(error, "register")`.

The component never calls `me` or refresh.

**Test first (RED):** stub `deps` as in Task 5.

- **Happy path.** Start answers 204. Verify answers `enrolment`. Options are called twice: first with `excludeCredentials: []`, then with one id. Register verify answers `activated: false`, then `activated: true`. The page ends on "Sign in" with the enrolment-complete alert.
- **Pin 7b.** `credentials.create` receives `rp.name`, the `user` labels, and `excludeCredentials` whose decoded id equals the option's id.
- **Pin 5.**
  - `watchStorage()` records nothing.
  - After each step, `location.href` contains neither `operator@example.test` nor the codes.
  - The enrolment-code input has `autocomplete="off"`.
- **Pin 4.** Every submit is `defaultPrevented`: dispatch a `submit` event and check `defaultPrevented`.
- **Field handling.** The email code `"1234 5678\n"` is sent as `"12345678"`. The enrolment code is sent exactly as typed.
- **Branches.**
  - Verify `activated` goes to sign-in with the already-have-two text.
  - Verify 401 shows the codes text and stays on step 2.
  - "Use a different address" returns to step 1.
  - Register verify 400 shows the not-saved text, and the next click requests options again.
  - A 401 on options in step 3 returns to step 1 with the ended text.
  - A 401 on register verify in step 4 returns to step 1 with the ended text, with both codes cleared.
  - `InvalidStateError` from `create` shows the same-device text.
  - `NotAllowedError` shows the cancelled text.
- **Pin 8, every call.** Each of `enrolment/start`, `enrolment/verify`, `register/options` and `register/verify`, answering 503, 429 or failing on the network, shows the generic text and keeps the current step. `register/options` failing the `isRegisterOptions` guard does the same.
- **Pin 8, button.** "Create passkey" is disabled while `credentials.create` is pending, and a second click makes no second options request.
- **No probe.** No request to `me` or `session/refresh` at any point.
- **Accessibility, explicit.**
  - Focus is on each step's `h1` after each step change.
  - Every input is found by `getByLabelText`.
  - Every message is inside `role="alert"`.
  - The whole happy path completes with keyboard events only, typing into fields and pressing Enter on buttons.
- **axe.** On each step and each message state.

**Rule this must not break:** earlier tests pass unchanged.

**Commit subject:** `feat(ops): add operator enrolment with two passkeys`

- [ ] RED, GREEN. Pins 4 (forms), 5, 7b.
- [ ] `pnpm --filter @community-hub/ops lint typecheck test`, `pnpm gate`.

### Task 7: Directory, and no injected styles across every screen

**Files:**

- **Create:** `apps/ops/src/directory.tsx`, `apps/ops/src/directory.test.tsx`, `apps/ops/src/no-injected-style.test.tsx`.
- **Modify:** `apps/ops/src/shell.tsx`, so `/` renders `Directory`.

**Shape (spec U13, U6 cap, Behaviour 5–6):**

- On mount, `authedGet("/v1/ops/directory")`. While loading, show "Loading organisations…" in `role="status"`.
- **200 with a valid body** (a hand-written guard over the `organisations` array and `truncated`):
  - A `<table>` with a caption "Organisations" and column headers: Organisation, Kind, Region, Communities.
  - One row per organisation in the server's order, keyed by `slug`. The Communities cell is a `<ul>` of community slugs, or empty.
  - The truncated notice appears above the table when `truncated` is true.
  - An empty list shows the empty text instead of the table.
- **`ended`:** `ended()`, then navigate to `/sign-in`, where the session-ended text appears.
- **403:** the role text.
- **Any other result,** or an invalid body: the could-not-load text and a "Try again" button that repeats the request.
- No id is rendered.

**Test first (RED):**

- **`directory.test.tsx`:**
  - Two organisations, one with two communities: the rows appear in server order, and each community is a list item.
  - No id string appears in the DOM.
  - `truncated: true` shows the notice.
  - An empty list shows the empty text.
  - A 403 shows the role text.
  - A 500 shows the failure text, and "Try again" refetches.
  - **Session ended:** `me` 200, then directory 401, repeat 401, refresh 401 ends on "Sign in" with the session-ended alert.
  - **One rotation:** directory 401, repeat 401, refresh 200, repeat 200 shows the table after exactly one refresh.
  - **axe:** on loading, list, empty, truncated, 403 and failed.
- **`no-injected-style.test.tsx`, pin 3.**
  - **Spies:** `document.createElement` (record any `"style"` argument), `CSSStyleSheet.prototype.insertRule`, writes to `document.adoptedStyleSheets`, and `Element.prototype.setAttribute` (record any `"style"` name).
  - **States rendered:**
    - unsupported;
    - the probe in its checking, failed and signed-out states;
    - sign-in idle and pending;
    - enrolment steps 1–4;
    - directory loading, list, empty and failed;
    - the error boundary after a child throws.
  - **Expected:** no style element, rule, adopted sheet or style attribute is recorded.

**Rule this must not break:** earlier tests pass unchanged.

**Commit subject:** `feat(ops): add the read-only directory`

- [ ] RED, GREEN. Pin 3.
- [ ] `pnpm --filter @community-hub/ops lint typecheck test build`, `pnpm gate`.

### Task 8: Ship the console in the image

**Files:** Modify `apps/api/Dockerfile`, `apps/api/src/image.test.ts` (one new `it` block, inside the `RUN_IMAGE_TESTS` `describe`), and `architecture.md` (§8.5 Ops console row only).

**Shape (spec U4):**

- **`Dockerfile`, build stage.** Add a new line `RUN pnpm --filter @community-hub/ops build` **after** the existing library-build `RUN` line and before `tsc -p tsconfig.emit.json`. Do not merge it into the existing line.
- **`Dockerfile`, `/runtime` assembly `RUN`.** Add `&& cp -a apps/ops/dist /runtime/ops`.
- **`Dockerfile`, final stage.** Add `ENV OPS_STATIC_DIR=/app/ops` immediately after `ENV PATH=...`.
- **`architecture.md:484` (Ops console row).** The last cell (Appearance) becomes "`packages/ui`; ops chrome. The `apps/ops` bundle is built into the service image and served on the ops hostname. Tenant data stays hidden until support access is granted". Nothing else in the file changes.

**Test first (RED), always on (pin 10a).** Add `image.test.ts` "builds and serves the ops bundle" to the non-skipped `service image build` describe, beside "builds policy, tenancy, people, and access before the service". It reads the Dockerfile text and asserts:

- a line `RUN pnpm --filter @community-hub/ops build` appears after the first `pnpm --filter … build` line, and that first line does not mention `@community-hub/ops`;
- the `/runtime` assembly contains `cp -a apps/ops/dist /runtime/ops`;
- the final stage, after the last `FROM`, contains `ENV OPS_STATIC_DIR=/app/ops`.

This case runs locally, so its weakening is seen to fail.

**Test first (RED), CI only (pin 10b):** `image.test.ts` "serves the ops console on the ops host". Use `startContainer()` and `waitForHealth`, then make in-container `docker exec … node --input-type=module -e` fetches to `http://127.0.0.1:8080`, following the existing `loopbackBody` pattern.

- **`GET /` with `x-community-hub-hostname: ops.au.example.test`:**
  - status 200;
  - `content-type` starts with `text/html`;
  - `content-security-policy` contains `script-src 'self'`;
  - `cache-control` is `no-cache`;
  - `x-content-type-options` is `nosniff`.
- **Assets.** Every `/assets/…` path in the returned HTML answers 200 with that header, with `cache-control` `public, max-age=31536000, immutable`.
- **API host.** `GET /` with `x-community-hub-hostname: au.api.example.test` answers 404.
- **Cleanup.** Remove the container in `finally`, as the other cases do.

This runs only in CI (deviation 1). Locally, the implementer runs `docker build --platform linux/arm64 -f apps/api/Dockerfile -t community-hub-api:local .` only if Docker has the ARM emulation and enough memory. Otherwise report "image build not run locally".

**Rule this must not break:**

- "builds policy, tenancy, people, and access before the service" still finds the library line first.
- The forbidden-environment list is unchanged.
- The `/app/node_modules/@community-hub` checks pass, because `/app/ops` is outside that tree.

**Commit subject:** `build(api): serve the ops console from the image`

- [ ] `architecture.md` is a prettier-padded table. Run `pnpm exec prettier --write architecture.md` after the edit. A realigned Surfaces table is expected; no other text may change.
- [ ] RED, GREEN. Pin 10a (local), 10b (CI only).
- [ ] `pnpm --filter @community-hub/api test`, `pnpm gate`.

### Task 9: Catalogue (last task on this branch)

**Files:** Modify `docs/roadmap.md` and `AGENTS.md` (Repository state row only).

**Shape:**

- **`docs/roadmap.md`, snapshot.** Last shipped is `ops-console-ui`, and Next chunk is `ops-console-proof`.
- **`docs/roadmap.md`, "Next is `ops-console-ui`."** Change it to "Next is `ops-console-proof`."
- **`docs/roadmap.md`, the `ops-console-ui` row.** Set it to `done` and append " Spec `docs/specs/2026-10-26-ops-console-ui.md`."
- **`docs/roadmap.md`, "The next chunk is **ops-console-ui**."** Change it to **ops-console-proof**, keeping the rest of the sentence.
- **Phase-0 counts.** Update them if the row is counted there, and quote the before and after in the report.
- **`AGENTS.md`.** Add `ops-console-ui` to the done list, and change "Next is" to `ops-console-proof`.
- **Formatting and scratch.** Run `pnpm exec prettier --write docs/roadmap.md AGENTS.md`, then `rm -f docs/plans/*-report.md`. `git status --short` must show only these two files.

**Commit subject:** `docs: mark ops-console-ui done`

- [ ] Edits, `pnpm gate`, commit.

## Definition of done (AGENTS.md §8)

- [ ] Tasks 1–9 committed, one commit each, each reviewed.
- [ ] Every pin weakened once, with the failure recorded (pin 10b by CI).
- [ ] `pnpm turbo run test --force --continue` and `pnpm gate` clean apart from the known Windows exceptions.
- [ ] CI green, including the `build-preview` image case for pin 10.
- [ ] No `docs/plans/*-report.md` on disk, and nothing under `.superpowers/` staged.
- [ ] The PR body records the deviations, the review configuration, the second-review line, and that the staging check belongs to `ops-console-proof`.

## Probe record

This plan has no Terraform asserts, so there is no scratch probe (AGENTS.md §4). The facts it relies on were read on `origin/main` at e1cf9bb:

- The `register/options` handler drops `excludeCredentials` and `rp.name`.
- `refreshSession` revokes the session family when a refresh token is replayed.
- The gate reads the host from `x-community-hub-hostname`.
- The `contracts` export `./ops` resolves to `dist`.
- The lockfile already carries the `linux-arm64-gnu` bindings.
- `image.test.ts` takes the first `pnpm --filter … build` line, and its forbidden-environment list does not include `OPS_STATIC_DIR`.
