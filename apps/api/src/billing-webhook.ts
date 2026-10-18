import {
  applySubscription,
  isReplayOutcome,
  linkSubscription,
  markOutcome,
  recordReceived,
  BillingUnavailable,
  type ApplySubscriptionResult,
  type BillingErrorCode,
  type BillingEventOutcome,
  type StripeBilling,
  type StripeWebhookEvent,
} from "@community-hub/billing";
import type { LogFields } from "@community-hub/observability";

import type { Checkout } from "./checkout.js";
import { presentedHostname, type GateRoute } from "./gate.js";

type BillingSql = Parameters<typeof recordReceived>[0];

type WebhookErrorCode = BillingErrorCode | "BILLING_ORGANISATION_MISMATCH";

function outcomeFromApplyResult(applyResult: ApplySubscriptionResult): {
  outcome: "processed" | "ignored";
  errorCode?: BillingErrorCode;
} {
  if (applyResult === "applied") {
    return { outcome: "processed" };
  }
  if (applyResult === "unknown_price") {
    return { outcome: "processed", errorCode: "BILLING_UNKNOWN_PRICE" };
  }
  return { outcome: "ignored" };
}

export type BillingLogFields = Pick<
  LogFields,
  | "operation"
  | "outcome"
  | "organisationId"
  | "stripeEventId"
  | "stripeEventType"
  | "errorCode"
  | "errorClass"
  | "status"
  | "duration"
  | "requestId"
  | "gatewayRequestId"
  | "hostname"
  | "reason"
>;

export type BillingWebhookDeps = {
  readonly checkout: Checkout<unknown>;
  readonly port: StripeBilling;
  readonly now: () => Date;
  readonly webhooksHostname: string;
  readonly log: (message: string, fields?: BillingLogFields) => void;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function billingWebhookRoutes(deps: BillingWebhookDeps): GateRoute[] {
  return [
    {
      method: "POST",
      pattern: "/v1/stripe/webhook",
      surface: "tenant",
      largeBody: "webhooks",
      handle: async (request: Request): Promise<Response> => {
        // 1. Answer 404 unless the presented hostname is the webhooks hostname.
        const presented = presentedHostname(request);
        if (presented !== deps.webhooksHostname.toLowerCase()) {
          return new Response(null, { status: 404 });
        }

        // 2. Read the bytes with request.arrayBuffer().
        const buffer = await request.arrayBuffer();
        const rawBody = new Uint8Array(buffer);
        const header = request.headers.get("stripe-signature") ?? "";

        // 3. port.verifyEvent. Failure answers 400, and nothing is recorded; BillingUnavailable answers 503.
        let event: StripeWebhookEvent;
        try {
          event = await deps.port.verifyEvent(rawBody, header);
        } catch (error) {
          if (error instanceof BillingUnavailable) {
            return new Response(null, { status: 503 });
          }
          return new Response(null, { status: 400 });
        }

        // 4. recordReceived. For processed or ignored, answer 200.
        let initialOutcome: BillingEventOutcome;
        try {
          initialOutcome = await deps.checkout("platform", (sql) =>
            recordReceived(sql as BillingSql, event.id, event.type),
          );
        } catch {
          deps.log("webhook", {
            operation: "stripe_webhook",
            stripeEventId: event.id,
            stripeEventType: event.type,
            outcome: "failed",
          });
          return new Response(null, { status: 500 });
        }

        if (isReplayOutcome(initialOutcome)) {
          const replayOutcome = initialOutcome as "processed" | "ignored";
          deps.log("webhook", {
            operation: "stripe_webhook",
            stripeEventId: event.id,
            stripeEventType: event.type,
            outcome: replayOutcome,
          });
          return new Response(null, { status: 200 });
        }

        // 5. Dispatch
        let orgId: string | undefined;
        try {
          let outcome: "processed" | "ignored" = "ignored";
          let errorCode: WebhookErrorCode | undefined;

          if (event.type === "checkout.session.completed") {
            const obj = event.data.object;
            const clientRefId = obj.client_reference_id;
            if (typeof clientRefId === "string" && UUID_RE.test(clientRefId)) {
              orgId = clientRefId;
              const customerId = typeof obj.customer === "string" ? obj.customer : undefined;
              const subscriptionId =
                typeof obj.subscription === "string" ? obj.subscription : undefined;

              if (customerId !== undefined && subscriptionId !== undefined) {
                // Re-read subscription from port to obtain current status
                const sub = await deps.port.retrieveSubscription(subscriptionId);
                if (sub.organisationIdMetadata !== clientRefId) {
                  outcome = "ignored";
                  errorCode = "BILLING_ORGANISATION_MISMATCH";
                } else {
                  const linkResult = await deps.checkout("platform", (sql) =>
                    linkSubscription(
                      sql as BillingSql,
                      orgId!,
                      customerId,
                      subscriptionId,
                      sub.status,
                    ),
                  );

                  if (linkResult === "duplicate") {
                    outcome = "ignored";
                    errorCode = "BILLING_DUPLICATE_SUBSCRIPTION";
                  } else if (linkResult === "invoiced" || linkResult === "missing") {
                    outcome = "ignored";
                  } else if (linkResult === "linked") {
                    const applyResult = await deps.checkout("platform", (sql) =>
                      applySubscription(sql as BillingSql, deps.port, subscriptionId, deps.now()),
                    );
                    const mapped = outcomeFromApplyResult(applyResult);
                    outcome = mapped.outcome;
                    errorCode = mapped.errorCode;
                  }
                }
              } else {
                outcome = "ignored";
              }
            } else {
              outcome = "ignored";
            }
          } else if (
            event.type === "customer.subscription.created" ||
            event.type === "customer.subscription.updated" ||
            event.type === "customer.subscription.deleted"
          ) {
            const subscriptionId = event.data.object.id;
            const applyResult = await deps.checkout("platform", (sql) =>
              applySubscription(sql as BillingSql, deps.port, subscriptionId, deps.now()),
            );
            const mapped = outcomeFromApplyResult(applyResult);
            outcome = mapped.outcome;
            errorCode = mapped.errorCode;
          } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
            const invoiceId = event.data.object.id;
            const subscriptionId = await deps.port.subscriptionForInvoice(invoiceId);
            if (subscriptionId !== null && subscriptionId !== undefined && subscriptionId !== "") {
              const applyResult = await deps.checkout("platform", (sql) =>
                applySubscription(sql as BillingSql, deps.port, subscriptionId, deps.now()),
              );
              const mapped = outcomeFromApplyResult(applyResult);
              outcome = mapped.outcome;
              errorCode = mapped.errorCode;
            } else {
              outcome = "ignored";
            }
          } else {
            outcome = "ignored";
          }

          // 6. markOutcome, then answer 200.
          await deps.checkout("platform", (sql) =>
            markOutcome(sql as BillingSql, event.id, outcome),
          );

          const logFields: BillingLogFields = {
            operation: "stripe_webhook",
            stripeEventId: event.id,
            stripeEventType: event.type,
            outcome,
          };
          if (orgId !== undefined && UUID_RE.test(orgId)) {
            logFields.organisationId = orgId;
          }
          if (errorCode !== undefined) {
            logFields.errorCode = errorCode;
          }
          deps.log("webhook", logFields);

          return new Response(null, { status: 200 });
        } catch {
          // A thrown error answers 500 with an empty body and leaves the row received.
          const logFields: BillingLogFields = {
            operation: "stripe_webhook",
            stripeEventId: event.id,
            stripeEventType: event.type,
            outcome: "failed",
          };
          if (orgId !== undefined && UUID_RE.test(orgId)) {
            logFields.organisationId = orgId;
          }
          deps.log("webhook", logFields);
          return new Response(null, { status: 500 });
        }
      },
    },
  ];
}
