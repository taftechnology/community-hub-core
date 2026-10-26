import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { SESSION_ENDED_MESSAGE } from "./messages.js";

export type AuthStatus = "unknown" | "checking" | "signed-in" | "signed-out" | "failed";

export type AuthContextValue = {
  status: AuthStatus;
  message?: string | undefined;
  signedIn: () => void;
  signedOut: (message?: string) => void;
  ended: () => void;
  retry: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuthState(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuthState must be used within an AuthProvider");
  }
  return context;
}

export type AuthProviderProps = {
  children: ReactNode;
  value?: AuthContextValue;
  onRetry?: () => void;
  initialStatus?: AuthStatus;
  initialMessage?: string;
};

export function AuthProvider({
  children,
  value,
  onRetry,
  initialStatus = "unknown",
  initialMessage,
}: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>(initialStatus);
  const [message, setMessage] = useState<string | undefined>(initialMessage);

  const signedIn = useCallback(() => {
    setStatus("signed-in");
    setMessage(undefined);
  }, []);

  const signedOut = useCallback((msg?: string) => {
    setStatus("signed-out");
    setMessage(msg);
  }, []);

  const ended = useCallback(() => {
    signedOut(SESSION_ENDED_MESSAGE);
  }, [signedOut]);

  const retry = useCallback(() => {
    if (onRetry) {
      onRetry();
    }
  }, [onRetry]);

  const contextValue = useMemo<AuthContextValue>(() => {
    if (value) {
      return value;
    }
    return {
      status,
      message,
      signedIn,
      signedOut,
      ended,
      retry,
    };
  }, [value, status, message, signedIn, signedOut, ended, retry]);

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
