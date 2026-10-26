import { useMemo, type ReactNode } from "react";
import { createHashRouter, RouterProvider } from "react-router";

import type { OpsDeps } from "./deps.js";

export function createOpsRouter(deps: OpsDeps) {
  void deps;
  return createHashRouter([
    {
      path: "/",
      element: <h1>Directory</h1>,
    },
    {
      path: "/sign-in",
      element: <h1>Sign in</h1>,
    },
    {
      path: "/enrol",
      element: <h1>Enrol</h1>,
    },
  ]);
}

export type ShellProps = {
  deps: OpsDeps;
};

export function Shell({ deps }: ShellProps): ReactNode {
  if (!deps.locks || !deps.credentials || !deps.publicKeyCredentialSupported) {
    return <h1>This browser is not supported.</h1>;
  }

  const router = useMemo(() => createOpsRouter(deps), [deps]);
  return <RouterProvider router={router} />;
}
