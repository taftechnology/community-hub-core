import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import type { OpsDeps } from "./deps.js";
import { Shell } from "./shell.js";
import { fakeLocks } from "./test-support.js";

const validDeps: OpsDeps = {
  fetch: globalThis.fetch,
  credentials: {
    get: async () => null,
    create: async () => null,
  },
  locks: fakeLocks(),
  publicKeyCredentialSupported: true,
};

describe("Shell unsupported browser", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("renders unsupported message when locks is missing", async () => {
    const { container } = render(<Shell deps={{ ...validDeps, locks: undefined }} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This browser is not supported.",
    );
    expect(container.textContent).toBe("This browser is not supported.");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders unsupported message when credentials is missing", async () => {
    const { container } = render(<Shell deps={{ ...validDeps, credentials: undefined }} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This browser is not supported.",
    );
    expect(container.textContent).toBe("This browser is not supported.");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders unsupported message when publicKeyCredentialSupported is false", async () => {
    const { container } = render(
      <Shell deps={{ ...validDeps, publicKeyCredentialSupported: false }} />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This browser is not supported.",
    );
    expect(container.textContent).toBe("This browser is not supported.");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders route headings when browser is supported", async () => {
    history.replaceState(null, "", "#/");
    const { unmount } = render(<Shell deps={validDeps} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Directory");
    unmount();

    history.replaceState(null, "", "#/sign-in");
    const { unmount: unmountSignIn } = render(<Shell deps={validDeps} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
    unmountSignIn();

    history.replaceState(null, "", "#/enrol");
    const { unmount: unmountEnrol } = render(<Shell deps={validDeps} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Enrol");
    unmountEnrol();
  });
});
