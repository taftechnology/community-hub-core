import {
  AppShell,
  AppSidebar,
  Drawer,
  ThemeToggle,
  TopBar,
  applyTheme,
  initialTheme,
  type Theme,
} from "@community-hub/ui";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";

import { BillingBanner } from "./billing-banner";
import { CommunityPicker } from "./community";
import { findActiveId, useSidebarItems } from "./nav";
import { ScreenTitleProvider, useScreenTitleContext } from "./screen-title";

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
      actions={<ThemeToggle theme={theme} onToggle={toggle} className="max-sm:hidden" />}
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
