import { Link } from "react-router";

import { labels } from "./labels";
import { usePeopleAccess } from "./people-access";
import { visibleLabels } from "./visible-labels";

const entitlementMap: Readonly<Record<string, string>> = {
  "Contacts & Members": "people.directory",
};

export function AdminNav() {
  const { access } = usePeopleAccess();
  const entitledKeys: string[] = [];
  if (access.directoryEnabled && (access.canView || access.canManage)) {
    entitledKeys.push("people.directory");
  }

  const shown = visibleLabels(labels, entitledKeys, entitlementMap);
  const dashboard = shown.find((label) => label === "Dashboard");
  const settings = shown.find((label) => label === "Settings");
  if (dashboard === undefined || settings === undefined) {
    throw new Error("missing nav label");
  }
  const contacts = shown.find((label) => label === "Contacts & Members");
  const mapped = shown.filter(
    (label) => label !== "Dashboard" && label !== "Settings" && label !== "Contacts & Members",
  );
  return (
    <nav aria-label="Admin">
      <Link to="/">{dashboard}</Link>
      <div>
        <span>{settings}</span>
        <Link to="/settings/general">General Settings</Link>
        <Link to="/settings/users">Users & Roles</Link>
        <Link to="/settings/modules">Module Toggles</Link>
      </div>
      {contacts !== undefined ? (
        <div>
          <span>{contacts}</span>
          <Link to="/contacts">All Contacts</Link>
        </div>
      ) : null}
      {mapped.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </nav>
  );
}
