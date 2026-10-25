export const OPS_ACCESS_COOKIE = "__Host-ops_at";
export const OPS_REFRESH_COOKIE = "__Host-ops_rt";

export type SessionTokensInput = {
  access: string;
  refresh?: string | undefined;
};

export function setSessionCookies(headers: Headers, tokens: SessionTokensInput): void {
  headers.append(
    "set-cookie",
    `${OPS_ACCESS_COOKIE}=${tokens.access}; Secure; HttpOnly; SameSite=Strict; Path=/`,
  );
  if (tokens.refresh !== undefined) {
    headers.append(
      "set-cookie",
      `${OPS_REFRESH_COOKIE}=${tokens.refresh}; Secure; HttpOnly; SameSite=Strict; Path=/`,
    );
  }
}

export function clearCookie(headers: Headers, name: string): void {
  headers.append("set-cookie", `${name}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export function clearSessionCookies(headers: Headers): void {
  clearCookie(headers, OPS_ACCESS_COOKIE);
  clearCookie(headers, OPS_REFRESH_COOKIE);
}

export function readOpsCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null || header === "") {
    return undefined;
  }
  const parts = header.split("; ");
  const counts = new Map<string, number>();
  const values = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      return undefined;
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "") {
      return undefined;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    values.set(key, value);
  }
  if ((counts.get(name) ?? 0) !== 1) {
    return undefined;
  }
  const value = values.get(name)!;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  return value;
}

export function originAllowed(request: Request, opsHostname: string): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "null") {
    return false;
  }
  const expected = `https://${opsHostname.toLowerCase()}`;
  return origin.toLowerCase() === expected;
}

function jsonMediaType(request: Request): boolean {
  const raw = request.headers.get("content-type");
  if (raw === null) {
    return false;
  }
  return raw.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export async function readJson<T>(
  request: Request,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
): Promise<T | undefined> {
  if (!jsonMediaType(request)) {
    return undefined;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
