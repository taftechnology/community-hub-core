import { render } from "@testing-library/react";
import axe from "axe-core";

import { NoNameButton } from "./a11y-fixtures/no-name";
import { Button } from "./button";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

it("names the Button and skips color-contrast (opaque tokens checked in JSON)", async () => {
  const { container } = render(<Button>Save</Button>);
  const results = await axe.run(container, {
    rules: {
      // Opaque token pairs are validated by @community-hub/check-tokens contrast rules.
      "color-contrast": { enabled: false },
    },
  });

  for (const bucket of ["passes", "violations", "incomplete", "inapplicable"] as const) {
    expect(resultIds(results, bucket)).not.toContain("color-contrast");
  }

  expect(resultIds(results, "passes")).toContain("button-name");

  const ariaRelated = [...resultIds(results, "passes"), ...resultIds(results, "inapplicable")];
  expect(ariaRelated.some((id) => /^aria-/.test(id))).toBe(true);
});

it("flags a control with no accessible name", async () => {
  const { container } = render(<NoNameButton />);
  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
    },
  });

  expect(resultIds(results, "violations")).toContain("button-name");
});
