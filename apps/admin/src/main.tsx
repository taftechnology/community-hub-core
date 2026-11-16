import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { setInviteToken } from "./invite-token";
import "./index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing root");
}

// The emailed link carries the token in the fragment. Take it into memory and remove it from the
// address bar before the shell is loaded: createBrowserRouter captures the location when
// shell.tsx is evaluated, so the router must never see the token.
const INVITE_PREFIX = "#invite=";
if (window.location.hash.startsWith(INVITE_PREFIX)) {
  const token = window.location.hash.slice(INVITE_PREFIX.length);
  if (token !== "") {
    setInviteToken(token);
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

void import("./shell").then(({ Shell }) => {
  createRoot(root).render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
});
