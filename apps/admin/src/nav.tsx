import { AppSidebar, type SidebarItem } from "@community-hub/ui";
import { Link, useLocation } from "react-router";

import { CommunityPicker } from "./community";
import { labels } from "./labels";
import { usePeopleAccess } from "./people-access";
import { visibleLabels } from "./visible-labels";

const entitlementMap: Readonly<Record<string, string>> = {
  "Contacts & Members": "people.directory",
  "Family Records": "people.households",
};

export function findActiveId(
  items: readonly SidebarItem[],
  footer: readonly SidebarItem[],
  pathname: string,
): string | undefined {
  let matchedId: string | undefined;
  let matchedLength = -1;

  function traverse(list: readonly SidebarItem[]) {
    for (const item of list) {
      if (item.children) {
        traverse(item.children);
      }
      if (item.href) {
        const isMatch =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        if (isMatch && item.href.length > matchedLength) {
          matchedLength = item.href.length;
          matchedId = item.id;
        }
      }
    }
  }

  traverse(items);
  traverse(footer);
  return matchedId;
}

export function useSidebarItems(): {
  items: SidebarItem[];
  footer: SidebarItem[];
} {
  const { access } = usePeopleAccess();
  const entitledKeys: string[] = [];
  if (access.entitlements["people.directory"] && access.permissions["people.view"]) {
    entitledKeys.push("people.directory");
  }
  if (access.entitlements["people.households"] && access.permissions["people.view"]) {
    entitledKeys.push("people.households");
  }

  const shown = visibleLabels(labels, entitledKeys, entitlementMap);

  const items: SidebarItem[] = [];

  for (const label of labels) {
    if (!shown.includes(label)) {
      continue;
    }
    if (label === "Dashboard") {
      items.push({
        id: "dashboard",
        label: "Dashboard",
        href: "/",
      });
    } else if (label === "Contacts & Members") {
      items.push({
        id: "contacts-members",
        label: "Contacts & Members",
        heading: "People",
        children: [
          {
            id: "contacts",
            label: "All Contacts",
            href: "/contacts",
          },
        ],
      });
    } else if (label === "Family Records") {
      items.push({
        id: "family-records",
        label: "Family Records",
        heading: "People",
        href: "/family-records",
      });
    }
  }

  const footer: SidebarItem[] = [
    {
      id: "settings",
      label: "Settings",
      children: [
        {
          id: "general-settings",
          label: "General Settings",
          href: "/settings/general",
        },
        {
          id: "users-roles",
          label: "Users & Roles",
          href: "/settings/users",
        },
        {
          id: "module-toggles",
          label: "Module Toggles",
          href: "/settings/modules",
        },
      ],
    },
  ];

  return { items, footer };
}

export function AdminNav({
  className,
  onNavigate,
}: {
  className?: string;
  onNavigate?: () => void;
} = {}) {
  const { items, footer } = useSidebarItems();
  const location = useLocation();
  const activeId = findActiveId(items, footer, location.pathname);

  return (
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
            onNavigate?.();
          }}
        >
          {item.label}
        </Link>
      )}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
