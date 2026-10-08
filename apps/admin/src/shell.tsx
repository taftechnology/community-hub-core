import { Button } from "@community-hub/ui";
import { createBrowserRouter, RouterProvider } from "react-router";

import { labels } from "./labels";

function DashboardPage() {
  const dashboard = labels[0];
  if (dashboard === undefined) {
    throw new Error("missing dashboard label");
  }
  return (
    <>
      <nav aria-label="Admin">
        <a href="/">{dashboard}</a>
      </nav>
      <h1>{dashboard}</h1>
      <Button
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        Refresh
      </Button>
    </>
  );
}

export const router = createBrowserRouter([{ path: "/", element: <DashboardPage /> }]);

export function Shell() {
  return <RouterProvider router={router} />;
}
