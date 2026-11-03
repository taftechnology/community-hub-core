export const ACCESS_TOKEN_KEY = "community-hub.access-token";
export const SIGNOUT_HANDLE_KEY = "community-hub.signout-handle";

type Origins = {
  api: string;
  auth: string;
};

function origin(name: "VITE_API_ORIGIN" | "VITE_AUTH_ORIGIN"): string {
  const value = import.meta.env[name];
  return typeof value === "string" ? value : "";
}

export function directoryOrigins(): Origins | undefined {
  const api = origin("VITE_API_ORIGIN");
  const auth = origin("VITE_AUTH_ORIGIN");
  if (api === "" || auth === "") {
    return undefined;
  }
  return { api, auth };
}

export function readAccessToken(): string | null {
  return sessionStorage.getItem(ACCESS_TOKEN_KEY);
}

export function storeAccessToken(token: string): void {
  sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  sessionStorage.removeItem(ACCESS_TOKEN_KEY);
}

export function readSignOutHandle(): string | null {
  try {
    return sessionStorage.getItem(SIGNOUT_HANDLE_KEY);
  } catch {
    return null;
  }
}

export function storeSignOutHandle(token: string): void {
  try {
    sessionStorage.setItem(SIGNOUT_HANDLE_KEY, token);
  } catch {
    // ignore
  }
}

export function clearSignOutHandle(): void {
  try {
    sessionStorage.removeItem(SIGNOUT_HANDLE_KEY);
  } catch {
    // ignore
  }
}
