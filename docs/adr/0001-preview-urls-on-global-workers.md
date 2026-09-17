# ADR 0001: Preview URLs only on global no-PII Workers

- Status: accepted
- Date: 2026-09-17
- Spec: `docs/specs/2026-09-17-monorepo-skeleton.md`

## Context

Cloudflare Preview URLs are hosted only on `*.workers.dev`. Regional Services does not regionalise `workers.dev`, Queue consumers, Cron Triggers or outbound subrequests (architecture §7.3 rule 1, §28).

Every Worker sets `workers_dev = false`. Wrangler's default is `preview_urls = workers_dev`, so previews are off unless a Worker opts in. AGENTS.md §10 Stage 3 previously promised a per-PR preview for every PR. Those two rules collide for any Worker that may process personal data.

## Decision

- Every Worker sets `workers_dev = false` and sets `preview_urls` explicitly (no implicit default).
- `preview_urls = true` only on Workers whose class is `global-no-pii` (gateway now; control-plane and ops-console later). Per-PR preview is a `workers.dev` URL. That is safe only because those Workers must not receive personal data.
- `preview_urls = false` on every `regional` Worker (`api`, `exec`, `jobs`, `webhooks`, …). They are verified on `staging-au` with synthetic data, or on a preview **custom hostname** registered with Regional Services — never on `workers.dev`.
- Class is declared next to the app (`worker.meta.json`), not inferred from the folder name. CI fails a missing class, an unknown class, `preview_urls = true` on `regional`, or an omitted `preview_urls` field.

## Consequences

- Stage 3 previews are not universal. A PR that only touches a regional Worker has no `workers.dev` preview.
- `apps/api` cannot copy gateway's Wrangler flags. The first regional Worker spec must include a Regional Services hostname (or `staging-au`) as its verification path.
- A Worker that later starts handling personal data must change class to `regional` and turn `preview_urls` off in the same PR.

## Alternatives rejected

- **No previews at all.** Stage 3 would have no deployable artefact until `staging-au` exists. The first real deploy would share a chunk with personal-data wiring.
- **Previews for every Worker.** Personal data would be reachable on `workers.dev`, which Regional Services does not cover. That is a residency breach, not a convenience.
