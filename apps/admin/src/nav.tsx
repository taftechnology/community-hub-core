import { Link } from "react-router";

import { labels } from "./labels";
import { usePeopleAccess } from "./people-access";
import { visibleLabels } from "./visible-labels";

const entitlementMap: Readonly<Record<string, string>> = {
  "Contacts & Members": "people.directory",
  "Family Records": "people.households",
};

export function AdminNav() {
  const { access } = usePeopleAccess();
  const entitledKeys: string[] = [];
  if (access.entitlements["people.directory"] && access.permissions["people.view"]) {
    entitledKeys.push("people.directory");
  }
  if (access.entitlements["people.households"] && access.permissions["people.view"]) {
    entitledKeys.push("people.households");
  }

  const shown = visibleLabels(labels, entitledKeys, entitlementMap);
  const dashboard = shown.find((label) => label === "Dashboard");
  const settings = shown.find((label) => label === "Settings");
  if (dashboard === undefined || settings === undefined) {
    throw new Error("missing nav label");
  }
  const contacts = shown.find((label) => label === "Contacts & Members");
  const familyRecords = shown.find((label) => label === "Family Records");
  const mapped = shown.filter(
    (label) =>
      label !== "Dashboard" &&
      label !== "Settings" &&
      label !== "Contacts & Members" &&
      label !== "Family Records",
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
      {familyRecords !== undefined ? <Link to="/family-records">{familyRecords}</Link> : null}
      {mapped.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </nav>
  );
}
