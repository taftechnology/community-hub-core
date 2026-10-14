# ADR 0013: Sign-in mail on Amazon SES

- Status: accepted
- Date: 2026-10-14
- Spec: `docs/specs/2026-10-14-email-provider.md`

## Context

Transactional email (D13, Q9) requires regional processing in Australia to comply with data residency (architecture §7.3, AGENTS.md §1 rule 1, ADR 0009). The first owner on staging could not receive eight-digit sign-in codes because the mail port wired in the service was `rejectingOtpMail`, rejecting every start challenge with an empty 503.

## Decision

1. **Vendor (O1):** Amazon SES in Sydney (`ap-southeast-2`) is chosen for transactional email. According to AWS documentation ([Amazon Simple Email Service Endpoints and Quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)), SES provides a regional endpoint in `ap-southeast-2` (`email.ap-southeast-2.amazonaws.com`), ensuring that mail data is processed within Australia. Q9 is closed.
2. **Port and adapter location (O7):** `OtpMail` remains the port for sign-in codes; the SES v2 adapter is implemented in `apps/api/src/mail/ses-otp-mail.ts` beside the KMS adapter. D13 is amended so that sign-in codes use `OtpMail` until the general `EmailProvider` port lands with Broadcast Messages in Phase 2.
3. **AWS accounts (O8):** Staging and production are separate AWS accounts (`docs/specs/2026-10-06-image-publish.md:28` superseding `docs/specs/2026-10-03-foundations.md:126`), with separate state backends (`infra/regions/au/backend/staging.hcl`, `prod.hcl`). SES resources and sandbox verification in this chunk apply to the staging account only; production plans no SES resources.
4. **Production access (O5):** Production access to move out of the SES sandbox is out of scope for this chunk. The recommended precondition for requesting production access is a per-source rate limit on code requests and an alarm on bounce and complaint metrics.

## Consequences

- An SES v2 client adapter is wired in `bindServices` when `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET` are configured; without them, the service continues to wire `rejectingOtpMail`.
- Staging AU root plans SES domain identity, Easy DKIM CNAMEs, custom MAIL FROM records (`bounces.mail.<zone>`), DMARC TXT record, a configuration set with `tls_policy = REQUIRE` and suppression reasons (`BOUNCE`, `COMPLAINT`), and a least-privilege task-role policy allowing only `ses:SendEmail`.
- No personal data or sign-in code is written to service logs, traces, or URLs (AGENTS.md §1 rule 5).

## Alternatives rejected

- **Cloudflare Email Service.** No confirmed Australian regional processing guarantee for transactional sending (different product from Cloudflare Email Security's AU region).
- **Third-party SaaS email vendors (Postmark, SendGrid, Resend).** Introduce extra subprocessors and offshore processing risks contrary to APP 8 and AGENTS.md §1 rule 1.
- **Wiring a generic EmailProvider immediately.** The broader notification system (broadcasts, receipts, templates) belongs to Phase 2; sign-in OTP needs only `OtpMail`.
