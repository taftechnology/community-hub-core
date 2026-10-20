import { clearAccessToken, directoryOrigins, readAccessToken } from "./directory";

export type BillingState = "invoiced" | "none" | "ok" | "retrying" | "grace" | "read_only";

export type BillingStatus = {
  state: BillingState;
  planKey?: string | null;
  quantity?: number | null;
  current_period_end?: string | null;
  trial_end: string | null;
  grace_until: string | null;
  canView: boolean;
  canManage: boolean;
};

export type BillingPlan = {
  key: string;
  trialAvailable: boolean;
};

export type BillingPlansResponse = {
  plans: BillingPlan[];
};

export type BillingUrlResponse = {
  url: string;
};

export async function post(path: string, body: unknown): Promise<Response | "unavailable"> {
  const origins = directoryOrigins();
  const token = readAccessToken();
  if (origins === undefined || token === null) {
    return "unavailable";
  }
  try {
    const response = await fetch(`${origins.api}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      clearAccessToken();
    }
    return response;
  } catch {
    return "unavailable";
  }
}
