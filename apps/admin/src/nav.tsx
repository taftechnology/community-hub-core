import { Link } from "react-router";

import { labels } from "./labels";

export function AdminNav() {
  const dashboard = labels[0];
  const settings = labels.find((label) => label === "Settings");
  if (dashboard === undefined || settings === undefined) {
    throw new Error("missing nav label");
  }
  return (
    <nav aria-label="Admin">
      <Link to="/">{dashboard}</Link>
      <div>
        <span>{settings}</span>
        <Link to="/settings/users">Users & Roles</Link>
      </div>
    </nav>
  );
}
