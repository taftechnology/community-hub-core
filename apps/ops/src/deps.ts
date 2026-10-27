export type LockLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export type OpsDeps = {
  fetch: typeof fetch;
  credentials: Pick<CredentialsContainer, "get" | "create"> | undefined;
  locks: LockLike | undefined;
  publicKeyCredentialSupported: boolean;
};

export function browserDeps(): OpsDeps {
  const locks: LockLike | undefined =
    typeof navigator !== "undefined" && "locks" in navigator && navigator.locks
      ? {
          request: <T>(name: string, callback: () => Promise<T>): Promise<T> =>
            navigator.locks.request(name, callback) as Promise<T>,
        }
      : undefined;

  const credentials: Pick<CredentialsContainer, "get" | "create"> | undefined =
    typeof navigator !== "undefined" && "credentials" in navigator && navigator.credentials
      ? navigator.credentials
      : undefined;

  const publicKeyCredentialSupported =
    typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";

  const fetchFn = typeof window !== "undefined" ? window.fetch.bind(window) : fetch;

  return {
    fetch: fetchFn,
    credentials,
    locks,
    publicKeyCredentialSupported,
  };
}
