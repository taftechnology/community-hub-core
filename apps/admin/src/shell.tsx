import { Button } from "@community-hub/ui";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router";

import { BillingBanner } from "./billing-banner";
import { BillingStatusProvider } from "./billing-status";
import { CommunityPicker, CommunityProvider } from "./community";
import { labels } from "./labels";
import { AdminNav } from "./nav";
import { SignInPage } from "./sign-in";
import { ModuleTogglesPage } from "./module-toggles";
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
      <CommunityPicker />
      <BillingBanner />
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
      { path: "settings/modules", element: <ModuleTogglesPage /> },
    ],
  },
]);

export function Shell() {
  return (
    <CommunityProvider>
      <BillingStatusProvider>
        <RouterProvider router={router} />
      </BillingStatusProvider>
    </CommunityProvider>
  );
}
