import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createHashRouter, Navigate, Outlet, RouterProvider, useLocation } from "react-router";
import { Alert, Button } from "@community-hub/ui";

import { createApi } from "./api.js";
import {
  AuthProvider,
  useAuthState,
  type AuthContextValue,
  type AuthStatus,
} from "./auth-state.js";
import type { OpsDeps } from "./deps.js";
import { useFocusHeading } from "./focus.js";
import {
  CHECKING_SESSION_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  SESSION_ENDED_MESSAGE,
  SIGN_OUT_BUTTON_LABEL,
  SIGN_OUT_NETWORK_ERROR_MESSAGE,
  TRY_AGAIN_BUTTON_LABEL,
  UNSUPPORTED_BROWSER_MESSAGE,
} from "./messages.js";
import { createSessionClient } from "./session.js";
import { SignIn } from "./sign-in.js";
import { Enrol } from "./enrol.js";

function DirectoryRoute() {
  const { status } = useAuthState();
  useFocusHeading();

  if (status === "signed-out") {
    return <Navigate to="/sign-in" replace />;
  }

  return (
    <h1 tabIndex={-1} className="text-2xl font-bold tracking-tight text-foreground outline-none">
      Directory
    </h1>
  );
}

function SignInRoute({ deps }: { deps: OpsDeps }) {
  const { status } = useAuthState();

  if (status === "signed-in") {
    return <Navigate to="/" replace />;
  }

  return <SignIn deps={deps} />;
}

function EnrolRoute({ deps }: { deps: OpsDeps }) {
  return <Enrol deps={deps} />;
}

function ShellLayout({ deps }: { deps: OpsDeps }) {
  const [status, setStatus] = useState<AuthStatus>("unknown");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const location = useLocation();

  const sessionClient = useMemo(
    () => createSessionClient({ api: createApi(deps.fetch), locks: deps.locks! }),
    [deps],
  );

  const runProbe = useCallback(async () => {
    setStatus("checking");
    setMessage(undefined);
    const res = await sessionClient.authedGet("/v1/ops/me");
    if (res.kind === "response" && res.status === 200) {
      setStatus("signed-in");
    } else if (res.kind === "ended" || (res.kind === "response" && res.status === 401)) {
      setStatus("signed-out");
    } else {
      setStatus("failed");
    }
  }, [sessionClient]);

  useEffect(() => {
    if (status === "unknown" && location.pathname !== "/enrol") {
      void runProbe();
    }
  }, [status, location.pathname, runProbe]);

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
    void runProbe();
  }, [runProbe]);

  const handleSignOut = async () => {
    const res = await sessionClient.signOut();
    if (res.kind === "network") {
      signedOut(SIGN_OUT_NETWORK_ERROR_MESSAGE);
    } else {
      signedOut();
    }
  };

  const authValue = useMemo<AuthContextValue>(
    () => ({
      status,
      message,
      signedIn,
      signedOut,
      ended,
      retry,
    }),
    [status, message, signedIn, signedOut, ended, retry],
  );

  return (
    <AuthProvider value={authValue}>
      <div className="min-h-screen bg-background text-foreground">
        <header className="flex h-14 items-center justify-between border-b border-border px-4">
          <span className="font-semibold text-foreground">Community Hub operations</span>
          {status === "signed-in" && (
            <nav className="flex items-center gap-4">
              <a href="#/" className="text-sm font-medium text-foreground hover:underline">
                Directory
              </a>
              <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
                {SIGN_OUT_BUTTON_LABEL}
              </Button>
            </nav>
          )}
        </header>
        <main className="mx-auto max-w-lg p-6">
          {status === "checking" && (
            <p role="status" className="text-sm text-muted-foreground">
              {CHECKING_SESSION_MESSAGE}
            </p>
          )}
          {status === "failed" && (
            <div className="flex flex-col gap-4">
              <Alert role="alert" variant="destructive">
                {GENERIC_ERROR_MESSAGE}
              </Alert>
              <div>
                <Button type="button" onClick={retry}>
                  {TRY_AGAIN_BUTTON_LABEL}
                </Button>
              </div>
            </div>
          )}
          {status !== "failed" && <Outlet />}
        </main>
      </div>
    </AuthProvider>
  );
}

export function createOpsRouter(deps: OpsDeps) {
  return createHashRouter([
    {
      element: <ShellLayout deps={deps} />,
      children: [
        {
          path: "/",
          element: <DirectoryRoute />,
        },
        {
          path: "/sign-in",
          element: <SignInRoute deps={deps} />,
        },
        {
          path: "/enrol",
          element: <EnrolRoute deps={deps} />,
        },
      ],
    },
  ]);
}

function SupportedShell({ deps }: { deps: OpsDeps }): ReactNode {
  const router = useMemo(() => createOpsRouter(deps), [deps]);
  return <RouterProvider router={router} />;
}

export type ShellProps = {
  deps: OpsDeps;
};

export function Shell({ deps }: ShellProps): ReactNode {
  if (!deps.locks || !deps.credentials || !deps.publicKeyCredentialSupported) {
    return <h1>{UNSUPPORTED_BROWSER_MESSAGE}</h1>;
  }

  return <SupportedShell deps={deps} />;
}
