import { Link } from "react-router";

import { labels } from "./labels";
import { visibleLabels } from "./visible-labels";

const entitlementMap: Readonly<Record<string, string>> = {};

export function AdminNav() {
  const shown = visibleLabels(labels, Object.values(entitlementMap), entitlementMap);
  const dashboard = shown.find((label) => label === "Dashboard");
  const settings = shown.find((label) => label === "Settings");
  if (dashboard === undefined || settings === undefined) {
    throw new Error("missing nav label");
  }
  const mapped = shown.filter((label) => label !== "Dashboard" && label !== "Settings");
  return (
    <nav aria-label="Admin">
      <Link to="/">{dashboard}</Link>
      <div>
        <span>{settings}</span>
        <Link to="/settings/users">Users & Roles</Link>
        <Link to="/settings/modules">Module Toggles</Link>
      </div>
      {mapped.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </nav>
  );
}
