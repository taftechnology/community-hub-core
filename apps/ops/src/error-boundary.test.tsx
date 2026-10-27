import { act } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ErrorBoundary } from "./error-boundary.js";
import { rootOptions } from "./root-options.js";

function Bomb(): never {
  throw new Error("test crash");
}

describe("ErrorBoundary", () => {
  it("renders heading when child throws and logs nothing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, rootOptions);

    try {
      await act(async () => {
        root.render(
          <ErrorBoundary>
            <Bomb />
          </ErrorBoundary>,
        );
      });

      const heading = container.querySelector("h1");
      expect(heading).not.toBeNull();
      expect(heading?.textContent).toBe("Something went wrong. Reload the page.");

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results.violations).toEqual([]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("renders children when no error occurs", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, rootOptions);

    try {
      await act(async () => {
        root.render(
          <ErrorBoundary>
            <div>safe child</div>
          </ErrorBoundary>,
        );
      });
      expect(container.textContent).toBe("safe child");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
