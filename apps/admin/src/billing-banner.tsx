import { Alert, Button } from "@community-hub/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useBillingStatus } from "./billing-status";
import { useCommunity } from "./community";

function isTrialEndingSoon(trialEnd: string | null | undefined): boolean {
  if (!trialEnd) {
    return false;
  }
  const end = new Date(trialEnd);
  const now = new Date();
  const diff = end.getTime() - now.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return diff > 0 && diff <= sevenDaysMs;
}

export function BillingBanner() {
  const { slug } = useCommunity();
  const { status, returnMessage } = useBillingStatus();
  const prevReadOnlyRef = useRef(false);

  const isFirstReadOnly = status?.state === "read_only" && !prevReadOnlyRef.current;

  useEffect(() => {
    if (status?.state === "read_only") {
      prevReadOnlyRef.current = true;
    } else {
      prevReadOnlyRef.current = false;
    }
  }, [status?.state]);

  async function handlePortal(): Promise<void> {
    const response = await post("/v1/billing/portal", { communitySlug: slug });
    if (response === "unavailable" || response.status !== 200) {
      return;
    }
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "url" in body &&
        typeof (body as { url: unknown }).url === "string"
      ) {
        const portalUrl = (body as { url: string }).url;
        if (typeof window.location.assign === "function") {
          window.location.assign(portalUrl);
        } else {
          window.location.href = portalUrl;
        }
      }
    } catch {
      // Ignore
    }
  }

  let statusAlert: ReactNode = null;

  if (status && status.state !== "invoiced") {
    let text = "";
    let action: ReactNode = null;
    let variant: "default" | "warning" = "default";
    let live: "polite" | "assertive" = "polite";

    if (status.state === "none") {
      text = "Choose a plan to start using Community Hub";
      action = <Link to="/settings/general">Choose a plan</Link>;
      variant = "default";
      live = "polite";
    } else if (status.state === "ok") {
      if (isTrialEndingSoon(status.trial_end)) {
        text = `Your trial ends on ${new Date(status.trial_end!).toLocaleDateString()}`;
        action = (
          <Button type="button" onClick={() => void handlePortal()}>
            Manage billing
          </Button>
        );
        variant = "default";
        live = "polite";
      }
    } else if (status.state === "retrying") {
      text = "Payment failed, update your card";
      action = (
        <Button type="button" onClick={() => void handlePortal()}>
          Update card
        </Button>
      );
      variant = "warning";
      live = "polite";
    } else if (status.state === "grace") {
      text = `Read-only on ${new Date(status.grace_until!).toLocaleDateString()}, pay the open invoice`;
      action = (
        <Button type="button" onClick={() => void handlePortal()}>
          Pay invoice
        </Button>
      );
      variant = "warning";
      live = "polite";
    } else if (status.state === "read_only") {
      live = isFirstReadOnly ? "assertive" : "polite";
      variant = "default";
      if (status.grace_until) {
        text = "Read-only, pay the open invoice";
        action = (
          <Button type="button" onClick={() => void handlePortal()}>
            Pay invoice
          </Button>
        );
      } else {
        text = "Subscription ended";
        action = <Link to="/settings/general">Choose a plan</Link>;
      }
    }

    if (text) {
      const canManage = status.canManage;
      const message = canManage ? text : `${text}. Ask an organisation owner or billing contact`;

      statusAlert = (
        <Alert live={live} variant={variant}>
          <div className="flex items-center justify-between gap-4">
            <span>{message}</span>
            {canManage && action}
          </div>
        </Alert>
      );
    }
  }

  if (!returnMessage && !statusAlert) {
    return null;
  }

  return (
    <>
      {returnMessage && (
        <Alert live="polite" variant="default">
          {returnMessage}
        </Alert>
      )}
      {statusAlert}
    </>
  );
}
