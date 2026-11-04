import {
  AppShell,
  AppSidebar,
  Drawer,
  ThemeToggle,
  TopBar,
  UserMenu,
  UserMenuCheckboxItem,
  applyTheme,
  initialTheme,
  type Theme,
} from "@community-hub/ui";
import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";

import { BillingBanner } from "./billing-banner";
import { CommunityPicker } from "./community";
import { readSignOutHandle } from "./directory";
import { findActiveId, useSidebarItems } from "./nav";
import { ScreenTitleProvider, useScreenTitleContext } from "./screen-title";
import { signOut } from "./sign-out";
import { useNarrowViewport } from "./use-narrow-viewport";

function ShellLayoutInner() {
  const context = useScreenTitleContext();
  if (!context) {
    throw new Error("missing ScreenTitleContext");
  }
  const { title, titleRef } = context;
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const { items, footer } = useSidebarItems();
  const activeId = findActiveId(items, footer, location.pathname);
  const signedIn = readSignOutHandle() !== null;
  const isNarrow = useNarrowViewport();
  const signingOutRef = useRef(false);

  useEffect(() => {
    if (title) {
      document.title = `${title} · Community Hub`;
    }
  }, [title]);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }

  async function handleSignOut() {
    if (signingOutRef.current) {
      return;
    }
    signingOutRef.current = true;
    try {
      await signOut();
    } finally {
      signingOutRef.current = false;
    }
  }

  const sidebar = (
    <AppSidebar
      items={items}
      footer={footer}
      {...(activeId !== undefined ? { activeId } : {})}
      siteTitle="Community Hub"
      switcher={<CommunityPicker />}
      renderLink={(item, props) => (
        <Link to={item.href!} {...props}>
          {item.label}
        </Link>
      )}
    />
  );

  const topBar = (
    <TopBar
      title={title}
      titleRef={titleRef}
      onMenu={() => setDrawerOpen(true)}
      menuOpen={drawerOpen}
      actions={
        <>
          <ThemeToggle theme={theme} onToggle={toggle} className="max-sm:hidden" />
          <UserMenu
            signedIn={signedIn}
            signInHref="/sign-in"
            onSignOut={handleSignOut}
            renderLink={(item, props) => (
              <Link to={item.href} {...props} aria-label="Sign in to your account">
                {item.label}
              </Link>
            )}
            extraItems={
              isNarrow ? (
                <UserMenuCheckboxItem checked={theme === "dark"} onCheckedChange={toggle}>
                  Dark mode
                </UserMenuCheckboxItem>
              ) : undefined
            }
          />
        </>
      }
    />
  );

  const drawer = (
    <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} label="Menu" finalFocus={titleRef}>
      <AppSidebar
        items={items}
        footer={footer}
        {...(activeId !== undefined ? { activeId } : {})}
        siteTitle="Community Hub"
        switcher={<CommunityPicker />}
        renderLink={(item, props) => (
          <Link
            to={item.href!}
            {...props}
            onClick={() => {
              setDrawerOpen(false);
            }}
          >
            {item.label}
          </Link>
        )}
      />
    </Drawer>
  );

  return (
    <AppShell sidebar={sidebar} topBar={topBar} drawer={drawer}>
      <BillingBanner />
      <Outlet />
    </AppShell>
  );
}

export function ShellLayout() {
  return (
    <ScreenTitleProvider>
      <ShellLayoutInner />
    </ScreenTitleProvider>
  );
}
