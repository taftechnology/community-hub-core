import { render, screen } from "@testing-library/react";
import axe from "axe-core";

import { Alert, AlertDescription, AlertTitle } from "./alert";

describe("Alert", () => {
  it("passes axe on default variant", async () => {
    const { container } = render(
      <Alert>
        <AlertTitle>Default Alert</AlertTitle>
        <AlertDescription>This is a default alert message.</AlertDescription>
      </Alert>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("passes axe on destructive variant", async () => {
    const { container } = render(
      <Alert variant="destructive">
        <AlertTitle>Error Alert</AlertTitle>
        <AlertDescription>This is a destructive alert message.</AlertDescription>
      </Alert>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("passes axe on warning variant", async () => {
    const { container } = render(
      <Alert variant="warning">
        <AlertTitle>Warning Alert</AlertTitle>
        <AlertDescription>This is a warning alert message.</AlertDescription>
      </Alert>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });

  it("sets role according to the live prop", () => {
    const { container: politeContainer } = render(
      <Alert live="polite">
        <AlertDescription>Polite update</AlertDescription>
      </Alert>,
    );
    const politeAlert = politeContainer.querySelector("[data-slot='alert']");
    expect(politeAlert?.getAttribute("role")).toBe("status");

    const { container: assertiveContainer } = render(
      <Alert live="assertive">
        <AlertDescription>Assertive update</AlertDescription>
      </Alert>,
    );
    const assertiveAlert = assertiveContainer.querySelector("[data-slot='alert']");
    expect(assertiveAlert?.getAttribute("role")).toBe("alert");
  });

  it("shows visible Warning: label on the warning variant", () => {
    render(
      <Alert variant="warning">
        <AlertDescription>Warning content</AlertDescription>
      </Alert>,
    );
    expect(screen.getByText(/^Warning:/)).toBeDefined();
  });
});
