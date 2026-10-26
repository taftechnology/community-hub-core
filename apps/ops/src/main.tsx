import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { browserDeps } from "./deps.js";
import { ErrorBoundary } from "./error-boundary.js";
import { rootOptions } from "./root-options.js";
import { Shell } from "./shell.js";
import "./index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing root");
}

createRoot(root, rootOptions).render(
  <StrictMode>
    <ErrorBoundary>
      <Shell deps={browserDeps()} />
    </ErrorBoundary>
  </StrictMode>,
);
