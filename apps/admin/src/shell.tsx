import { Button } from "@community-hub/ui";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router";

import { labels } from "./labels";
import { AdminNav } from "./nav";
import { SignInPage } from "./sign-in";
import { UsersRolesPage } from "./users-roles";

function DashboardPage() {
  const dashboard = labels[0];
  if (dashboard === undefined) {
    throw new Error("missing dashboard label");
  }
  return (
    <>
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

function AdminLayout() {
  return (
    <>
      <AdminNav />
      <main>
        <Outlet />
      </main>
    </>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AdminLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "sign-in", element: <SignInPage /> },
      { path: "settings/users", element: <UsersRolesPage /> },
    ],
  },
]);

export function Shell() {
  return <RouterProvider router={router} />;
}
