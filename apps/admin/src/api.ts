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

// The Community Admin's View of one field of one child (ADR 0017). Each View is a POST with the ids
// in the body, never in the address, and is asked for as it is needed: it is not a query, and the
// answer is not kept anywhere but in the component that shows it.
export type PersonViewField = "name" | "dateOfBirth" | "email" | "phone";
export type LifeEventViewField = "type" | "date" | "place" | "notes";

export type ChildViewTarget =
  | { personId: string; field: PersonViewField }
  | { personId: string; lifeEventId: string; field: LifeEventViewField };

export async function viewChildField(
  communitySlug: string,
  target: ChildViewTarget,
): Promise<Response | "unavailable"> {
  const path =
    "lifeEventId" in target ? "/v1/people/minors/life-events/view" : "/v1/people/minors/view";
  return postNoStore(path, { communitySlug, ...target });
}

// A call to the auth service with the signed-in token, for Settings → Security. Unlike `post`, a 401
// leaves the token where it is: there it can mean "confirm it's you first" and not "signed out", and
// the page tells the two apart by asking the factor list.
export async function authCall(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response | "unavailable"> {
  const origins = directoryOrigins();
  const token = readAccessToken();
  if (origins === undefined || token === null) {
    return "unavailable";
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers, cache: "no-store" };
  if (method === "POST") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  try {
    return await fetch(`${origins.auth}${path}`, init);
  } catch {
    return "unavailable";
  }
}

async function send(
  path: string,
  body: unknown,
  extra: RequestInit,
): Promise<Response | "unavailable"> {
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
      ...extra,
    });
    if (response.status === 401) {
      clearAccessToken();
    }
    return response;
  } catch {
    return "unavailable";
  }
}

export async function post(path: string, body: unknown): Promise<Response | "unavailable"> {
  return send(path, body, {});
}

// The same call, told not to use or fill any cache.
export async function postNoStore(path: string, body: unknown): Promise<Response | "unavailable"> {
  return send(path, body, { cache: "no-store" });
}
