import { Alert, Button } from "@community-hub/ui";
import { useEffect, useRef, useState } from "react";

import {
  type BillingPlan,
  type BillingPlansResponse,
  type BillingState,
  type BillingUrlResponse,
  post,
} from "./api";
import { useBillingStatus } from "./billing-status";
import { useCommunity } from "./community";
import { planLabels } from "./labels";

const STATE_WORDS: Record<BillingState, string> = {
  invoiced: "Invoiced",
  none: "No active subscription",
  ok: "Active",
  retrying: "Payment retrying",
  grace: "In grace period",
  read_only: "Read-only",
};

export function GeneralSettingsPage() {
  const { slug, version } = useCommunity();
  const { status, refresh } = useBillingStatus();
  const generation = useRef(0);

  const [plans, setPlans] = useState<BillingPlan[] | undefined>(undefined);
  const [contactSupport, setContactSupport] = useState(false);
  const [offerPortal, setOfferPortal] = useState(false);
  const [hidePortal, setHidePortal] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    generation.current++;
    setPlans(undefined);
    setContactSupport(false);
    setOfferPortal(false);
    setHidePortal(false);
    setNotice(null);
  }, [slug, version]);

  useEffect(() => {
    if (!slug || !status || !status.canManage) {
      return;
    }
    const shouldLoadPlans =
      status.state === "none" ||
      (status.state === "read_only" && !status.grace_until);
    if (!shouldLoadPlans) {
      return;
    }

    const mine = generation.current;
    async function fetchPlans() {
      const response = await post("/v1/billing/plans", { communitySlug: slug });
      if (generation.current !== mine) {
        return;
      }
      if (response === "unavailable") {
        setNotice("Billing is unavailable, try again shortly");
        return;
      }
      if (response.status === 422) {
        setNotice("This plan is not available yet");
        return;
      }
      if (response.status === 503) {
        setNotice("Billing is unavailable, try again shortly");
        return;
      }
      if (response.status !== 200) {
        setNotice("Billing is unavailable, try again shortly");
        return;
      }
      try {
        const body: unknown = await response.json();
        if (generation.current !== mine) {
          return;
        }
        if (
          typeof body === "object" &&
          body !== null &&
          "plans" in body &&
          Array.isArray((body as BillingPlansResponse).plans)
        ) {
          setPlans((body as BillingPlansResponse).plans);
        } else {
          setNotice("Billing is unavailable, try again shortly");
        }
      } catch {
        if (generation.current === mine) {
          setNotice("Billing is unavailable, try again shortly");
        }
      }
    }

    void fetchPlans();
  }, [slug, version, status?.state, status?.canManage, status?.grace_until]);

  async function handleCheckout(planKey: string) {
    if (!slug) {
      return;
    }
    const mine = generation.current;
    const response = await post("/v1/billing/checkout", {
      communitySlug: slug,
      planKey,
    });
    if (generation.current !== mine) {
      return;
    }
    if (response === "unavailable") {
      setNotice("Billing is unavailable, try again shortly");
      return;
    }
    if (response.status === 409) {
      if (status?.state === "none") {
        setOfferPortal(true);
        return;
      }
      if (status?.state === "read_only" && !status?.grace_until) {
        setContactSupport(true);
        return;
      }
      await refresh();
      return;
    }
    if (response.status === 422) {
      setNotice("This plan is not available yet");
      return;
    }
    if (response.status === 503) {
      setNotice("Billing is unavailable, try again shortly");
      return;
    }
    if (response.status !== 200) {
      setNotice("Billing is unavailable, try again shortly");
      return;
    }
    try {
      const body: unknown = await response.json();
      if (generation.current !== mine) {
        return;
      }
      if (
        typeof body === "object" &&
        body !== null &&
        "url" in body &&
        typeof (body as BillingUrlResponse).url === "string"
      ) {
        const url = (body as BillingUrlResponse).url;
        if (typeof window.location.assign === "function") {
          window.location.assign(url);
        } else {
          window.location.href = url;
        }
      } else {
        setNotice("Billing is unavailable, try again shortly");
      }
    } catch {
      if (generation.current === mine) {
        setNotice("Billing is unavailable, try again shortly");
      }
    }
  }

  async function handlePortal() {
    if (!slug) {
      return;
    }
    const mine = generation.current;
    const response = await post("/v1/billing/portal", {
      communitySlug: slug,
    });
    if (generation.current !== mine) {
      return;
    }
    if (response === "unavailable") {
      setNotice("Billing is unavailable, try again shortly");
      return;
    }
    if (response.status === 409) {
      setHidePortal(true);
      await refresh();
      return;
    }
    if (response.status === 422) {
      setNotice("This plan is not available yet");
      return;
    }
    if (response.status === 503) {
      setNotice("Billing is unavailable, try again shortly");
      return;
    }
    if (response.status !== 200) {
      setNotice("Billing is unavailable, try again shortly");
      return;
    }
    try {
      const body: unknown = await response.json();
      if (generation.current !== mine) {
        return;
      }
      if (
        typeof body === "object" &&
        body !== null &&
        "url" in body &&
        typeof (body as BillingUrlResponse).url === "string"
      ) {
        const url = (body as BillingUrlResponse).url;
        if (typeof window.location.assign === "function") {
          window.location.assign(url);
        } else {
          window.location.href = url;
        }
      } else {
        setNotice("Billing is unavailable, try again shortly");
      }
    } catch {
      if (generation.current === mine) {
        setNotice("Billing is unavailable, try again shortly");
      }
    }
  }

  const showPortalButton =
    status?.canManage &&
    (status.state === "ok" ||
      status.state === "retrying" ||
      status.state === "grace" ||
      status.state === "read_only") &&
    !hidePortal;

  const showPlanList =
    status?.canManage &&
    (status.state === "none" ||
      (status.state === "read_only" && !status.grace_until));

  return (
    <>
      <h1>General Settings</h1>
      <h2>Billing</h2>

      {notice && (
        <Alert live="polite" variant="default">
          {notice}
        </Alert>
      )}

      {slug && status === null && <p>Billing status unavailable</p>}

      {status && !status.canView && !status.canManage && (
        <p>You do not have access to billing for this organisation.</p>
      )}

      {status && (status.canView || status.canManage) && status.state === "invoiced" && (
        <p>Billing is handled by invoice.</p>
      )}

      {status && (status.canView || status.canManage) && status.state !== "invoiced" && (
        <>
          {status.canView && (
            <dl>
              <div>
                <dt>State</dt>
                <dd>{STATE_WORDS[status.state] ?? status.state}</dd>
              </div>
              {status.planKey && (
                <div>
                  <dt>Plan</dt>
                  <dd>{planLabels[status.planKey] ?? status.planKey}</dd>
                </div>
              )}
              {status.quantity != null && (
                <div>
                  <dt>Quantity</dt>
                  <dd>{status.quantity}</dd>
                </div>
              )}
              {status.current_period_end && (
                <div>
                  <dt>Current period end</dt>
                  <dd>
                    {new Date(status.current_period_end).toLocaleDateString()}
                  </dd>
                </div>
              )}
              {status.trial_end && (
                <div>
                  <dt>Trial end</dt>
                  <dd>{new Date(status.trial_end).toLocaleDateString()}</dd>
                </div>
              )}
              {status.grace_until && (
                <div>
                  <dt>Grace until</dt>
                  <dd>{new Date(status.grace_until).toLocaleDateString()}</dd>
                </div>
              )}
            </dl>
          )}

          {status.canManage && (
            <div>
              {showPortalButton && (
                <Button type="button" onClick={() => void handlePortal()}>
                  Manage billing
                </Button>
              )}

              {offerPortal && (
                <Button type="button" onClick={() => void handlePortal()}>
                  Finish payment
                </Button>
              )}

              {showPlanList && (
                <>
                  {contactSupport ? (
                    <p>Contact support</p>
                  ) : (
                    plans && (
                      <ul>
                        {plans.map((plan) => (
                          <li key={plan.key}>
                            <div>
                              <span>{planLabels[plan.key] ?? plan.key}</span>
                              {plan.trialAvailable && (
                                <span>Includes a free trial</span>
                              )}
                            </div>
                            <Button
                              type="button"
                              onClick={() => void handleCheckout(plan.key)}
                            >
                              Start subscription
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
