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

export type LifeEventType =
  | "baptism"
  | "first_communion"
  | "marriage"
  | "funeral"
  | "birth"
  | "death"
  | "graduation"
  | "anniversary"
  | "other";

export type LifeEvent = {
  eventId: string;
  version: number;
  type: LifeEventType;
  date: string;
  place: string | null;
  notes: string | null;
};

export type ListLifeEventsResponse = {
  items: LifeEvent[];
};

export type CreateLifeEventResponse = {
  eventId: string;
  version: number;
};

export type UpdateLifeEventResponse = {
  version: number;
};

export async function listLifeEvents(
  communitySlug: string,
  personId: string,
): Promise<Response | "unavailable"> {
  return post("/v1/people/life-events/list", { communitySlug, personId });
}

export async function createLifeEvent(body: {
  communitySlug: string;
  personId: string;
  type: LifeEventType;
  date: string;
  place?: string | null;
  notes?: string | null;
}): Promise<Response | "unavailable"> {
  return post("/v1/people/life-events/create", body);
}

export async function updateLifeEvent(body: {
  communitySlug: string;
  eventId: string;
  version: number;
  type: LifeEventType;
  date: string;
  place?: string | null;
  notes?: string | null;
}): Promise<Response | "unavailable"> {
  return post("/v1/people/life-events/update", body);
}

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
