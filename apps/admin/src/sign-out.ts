import {
  clearAccessToken,
  clearSignOutHandle,
  directoryOrigins,
  readSignOutHandle,
} from "./directory";

export type SignOutDeps = {
  fetch: typeof globalThis.fetch;
  origins: ReturnType<typeof directoryOrigins>;
  readHandle: () => string | null;
  clear: () => void;
  navigate: (url: string) => void;
};

export function defaultClear(): void {
  try {
    clearAccessToken();
  } catch {
    // ignore
  }
  try {
    clearSignOutHandle();
  } catch {
    // ignore
  }
  try {
    sessionStorage.removeItem("community-hub.community");
  } catch {
    // ignore
  }
}

export const defaultDeps: SignOutDeps = {
  fetch: (...args) => Reflect.apply(globalThis.fetch, globalThis, args),
  get origins() {
    return directoryOrigins();
  },
  readHandle: readSignOutHandle,
  clear: defaultClear,
  navigate: (url) => window.location.assign(url),
};

export async function signOut(deps: Partial<SignOutDeps> = defaultDeps): Promise<void> {
  const resolved = { ...defaultDeps, ...deps };
  const handle = resolved.readHandle();
  let confirmed = false;

  if (handle === null) {
    confirmed = true;
  } else if (resolved.origins === undefined) {
    confirmed = false;
  } else {
    try {
      const performFetch = resolved.fetch;
      const response = await performFetch(`${resolved.origins.auth}/v1/auth/session/end`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${handle}`,
        },
        body: "{}",
        cache: "no-store",
      });
      confirmed = response.status === 204 || response.status === 401;
    } catch {
      confirmed = false;
    }
  }

  try {
    resolved.clear();
  } catch {
    // ignore
  }

  resolved.navigate(confirmed ? "/sign-in" : "/sign-in?signout=unconfirmed");
}
