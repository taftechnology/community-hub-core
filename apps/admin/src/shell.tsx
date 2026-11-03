import { Button, Logo } from "@community-hub/ui";
import { useEffect } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";

import { BillingStatusProvider } from "./billing-status";
import { CommunityProvider } from "./community";
import { labels } from "./labels";
import { PeopleAccessProvider } from "./people-access";
import { ScreenTitle } from "./screen-title";
import { ShellLayout } from "./shell-layout";
import { AllContactsPage } from "./all-contacts";
import { FamilyRecordsPage } from "./family-records";
import { SignInPage } from "./sign-in";
import { GeneralSettingsPage } from "./general-settings";
import { ModuleTogglesPage } from "./module-toggles";
import { UsersRolesPage } from "./users-roles";

function DashboardPage() {
  const dashboard = labels[0];
  if (dashboard === undefined) {
    throw new Error("missing dashboard label");
  }
  return (
    <>
      <ScreenTitle>{dashboard}</ScreenTitle>
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

export function SignInLayout() {
  useEffect(() => {
    document.title = "Sign in · Community Hub";
  }, []);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-lg p-6 flex flex-col gap-4 shadow-sm">
        <div className="flex justify-center">
          <Logo variant="outline-teal" />
        </div>
        <h1 className="text-[22px] leading-[28px] font-bold text-foreground text-center">
          Sign in
        </h1>
        <SignInPage />
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/sign-in",
    element: <SignInLayout />,
  },
  {
    path: "/",
    element: <ShellLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "settings/general", element: <GeneralSettingsPage /> },
      { path: "settings/users", element: <UsersRolesPage /> },
      { path: "settings/modules", element: <ModuleTogglesPage /> },
      { path: "contacts", element: <AllContactsPage /> },
      { path: "family-records", element: <FamilyRecordsPage /> },
    ],
  },
]);

export function Shell() {
  return (
    <CommunityProvider>
      <BillingStatusProvider>
        <PeopleAccessProvider>
          <RouterProvider router={router} />
        </PeopleAccessProvider>
      </BillingStatusProvider>
    </CommunityProvider>
  );
}
