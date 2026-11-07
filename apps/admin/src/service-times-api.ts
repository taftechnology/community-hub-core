import { post } from "./api";

export const SERVICE_TIMES_HTML_MAX = 20_000;

export interface ServiceTimesRecord {
  readonly html: string;
  readonly version: number;
}

export function isServiceTimesRecord(data: unknown): data is ServiceTimesRecord {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate.html === "string" &&
    typeof candidate.version === "number" &&
    Number.isInteger(candidate.version) &&
    candidate.version >= 0
  );
}

export type ServiceTimesGetOutcome =
  | { readonly kind: "ok"; readonly data: ServiceTimesRecord }
  | { readonly kind: "forbidden" }
  | { readonly kind: "error" };

export type ServiceTimesSaveOutcome =
  | { readonly kind: "ok"; readonly data: ServiceTimesRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "payment_required" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "over_cap" }
  | { readonly kind: "error" };

export async function getServiceTimes(communitySlug: string): Promise<ServiceTimesGetOutcome> {
  const response = await post("/v1/engagement/service-times/get", { communitySlug });
  if (response === "unavailable") {
    return { kind: "error" };
  }
  if (response.status === 403) {
    return { kind: "forbidden" };
  }
  if (response.status !== 200) {
    return { kind: "error" };
  }
  try {
    const body: unknown = await response.json();
    if (!isServiceTimesRecord(body)) {
      return { kind: "error" };
    }
    return { kind: "ok", data: body };
  } catch {
    return { kind: "error" };
  }
}

export async function saveServiceTimes({
  communitySlug,
  html,
  version,
}: {
  communitySlug: string;
  html: string;
  version: number;
}): Promise<ServiceTimesSaveOutcome> {
  const response = await post("/v1/engagement/service-times/save", {
    communitySlug,
    html,
    version,
  });
  if (response === "unavailable") {
    return { kind: "error" };
  }
  if (response.status === 409) {
    return { kind: "conflict" };
  }
  if (response.status === 402) {
    return { kind: "payment_required" };
  }
  if (response.status === 403) {
    return { kind: "forbidden" };
  }
  if (response.status === 400) {
    return { kind: "over_cap" };
  }
  if (response.status !== 200) {
    return { kind: "error" };
  }
  try {
    const body: unknown = await response.json();
    if (!isServiceTimesRecord(body)) {
      return { kind: "error" };
    }
    return { kind: "ok", data: body };
  } catch {
    return { kind: "error" };
  }
}
